// Run state, hook notice, "seen" marker, the run lock and the due rule (spec 5 and 8).
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { ensureDir, readJson, writeAtomic } from './files.mjs';

const FILE_MODE = 0o600;
const HOUR_MS = 3600 * 1000;
const LOCK_MAX_AGE_MS = 2 * HOUR_MS; // a lock older than this is stale even when its pid is alive
const CORRUPT_LOCK_MAX_AGE_MS = 60 * 1000; // an unreadable lock file is stale once it has not changed for this long
const TAKEOVER_MAX_AGE_MS = 60 * 1000; // a takeover file older than this is itself stale
const ATTEMPT_RETRY_MS = 24 * HOUR_MS; // no new run until this long after the last attempt
const DAY_MS = 24 * HOUR_MS;
const MAX_ACQUIRE_ATTEMPTS = 3; // the lock vanishing between two looks is retried a few times, never forever

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readObject = (path) => {
  const parsed = readJson(path);
  return isPlainObject(parsed) ? parsed : {};
};
const writeJson = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

// ---- state.json (generator), notice.json (hook), seen.json (triqual memory report) ---------------------------------------

// { lastSuccessAt?, lastAttemptAt?, lastReportPath?, lastSummary?, lastError? }; {} when missing or corrupt.
export function readState(paths) {
  return readObject(paths.stateFile);
}

// Re-reads the file, merges `patch` over it and writes it atomically. A patch value of undefined removes that key.
export function writeState(paths, patch) {
  ensureDir(paths.stateDir);
  writeJson(paths.stateFile, { ...readState(paths), ...patch });
}

const pickStrings = (obj, keys) => {
  const out = {};
  for (const key of keys) if (typeof obj[key] === 'string') out[key] = obj[key];
  return out;
};

const NOTICE_KEYS = ['lastNoticeDate'];
const SEEN_KEYS = ['seenReport', 'seenSuccessAt'];

export function readNotice(paths) {
  return pickStrings(readObject(paths.noticeFile), NOTICE_KEYS);
}

export function writeNotice(paths, { lastNoticeDate }) {
  ensureDir(paths.stateDir);
  writeJson(paths.noticeFile, pickStrings({ lastNoticeDate }, NOTICE_KEYS));
}

export function readSeen(paths) {
  return pickStrings(readObject(paths.seenFile), SEEN_KEYS);
}

export function writeSeen(paths, { seenReport, seenSuccessAt }) {
  ensureDir(paths.stateDir);
  writeJson(paths.seenFile, pickStrings({ seenReport, seenSuccessAt }, SEEN_KEYS));
}

// ---- run.lock --------------------------------------------------------------------------------------------------------

const isLockShape = (v) => isPlainObject(v) && Number.isInteger(v.pid) && typeof v.startedAt === 'string';

// { pid, startedAt }, 'corrupt' (the file exists but is not a lock: a crash left it empty or truncated), or null.
export function readLock(paths) {
  let text;
  try {
    text = readFileSync(paths.lockFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (isLockShape(parsed)) return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch { /* falls through */ }
  return 'corrupt';
}

// Stale: the pid is not alive, or startedAt is more than 2 h old. A 'corrupt' lock has neither, so it is stale once
// its file (`mtimeMs`, supplied by the caller) has not changed for more than 60 s; without an mtime it is never stale.
export function isLockStale(lock, { nowMs, isAlive, mtimeMs }) {
  if (lock === 'corrupt') return typeof mtimeMs === 'number' && nowMs - mtimeMs > CORRUPT_LOCK_MAX_AGE_MS;
  if (!isAlive(lock.pid)) return true;
  // An unparsable startedAt gives NaN: no usable age, so the lock does not hold the slot forever.
  return !(nowMs - Date.parse(lock.startedAt) <= LOCK_MAX_AGE_MS);
}

const unlinkQuiet = (path) => {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

// Exclusive create (`wx`) of `path` holding `content`. False when it already exists.
function createExclusive(path, content) {
  let fd;
  try {
    fd = openSync(path, 'wx', FILE_MODE);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeFileSync(fd, content);
  } catch (err) {
    try { closeSync(fd); } catch { /* already failing */ }
    unlinkQuiet(path);
    throw err;
  }
  closeSync(fd);
  return true;
}

const holderOf = (lock) => (lock !== null && lock !== 'corrupt' ? { pid: lock.pid, startedAt: lock.startedAt } : null);

// The lock's content plus, for a corrupt one, its mtime; null when it is gone.
function observeLock(paths) {
  const lock = readLock(paths);
  if (lock === null) return null;
  if (lock !== 'corrupt') return { lock, mtimeMs: undefined };
  try {
    return { lock, mtimeMs: statSync(paths.lockFile).mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sameObservation(a, b) {
  if (a === null || b === null) return false;
  if (a.lock === 'corrupt' || b.lock === 'corrupt') return a.lock === b.lock && a.mtimeMs === b.mtimeMs;
  return a.lock.pid === b.lock.pid && a.lock.startedAt === b.lock.startedAt;
}

// Step 1 of the takeover: `wx` on run.lock.takeover. An existing file blocks the takeover unless it is older than a
// minute, in which case it is removed once and the create is tried again.
function claimTakeover(paths, nowMs) {
  const content = String(process.pid);
  if (createExclusive(paths.takeoverFile, content)) return true;
  let mtimeMs;
  try {
    mtimeMs = statSync(paths.takeoverFile).mtimeMs;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return createExclusive(paths.takeoverFile, content);
  }
  if (nowMs - mtimeMs <= TAKEOVER_MAX_AGE_MS) return false;
  unlinkQuiet(paths.takeoverFile);
  return createExclusive(paths.takeoverFile, content);
}

// Spec 8 takeover. `observed` is the stale lock as it was seen before the takeover started.
function takeOver(paths, observed, { nowMs, pid, startedAt, content }) {
  if (!claimTakeover(paths, nowMs)) return { acquired: false, holder: holderOf(observed.lock) };
  try {
    const current = observeLock(paths);
    if (!sameObservation(observed, current)) {
      return { acquired: false, holder: current === null ? null : holderOf(current.lock) };
    }
    unlinkQuiet(paths.lockFile);
    if (createExclusive(paths.lockFile, content)) return { acquired: true, holder: { pid, startedAt } };
    return { acquired: false, holder: holderOf(readLock(paths)) };
  } finally {
    unlinkQuiet(paths.takeoverFile);
  }
}

// Takes the run lock: { acquired: true, holder: this process } or { acquired: false, holder } where holder is whoever
// has it (null when unknown, e.g. a corrupt file that is not yet stale).
export function acquireLock(paths, { nowMs, isAlive, pid = process.pid }) {
  ensureDir(paths.stateDir);
  const startedAt = new Date(nowMs).toISOString();
  const content = JSON.stringify({ pid, startedAt });
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (createExclusive(paths.lockFile, content)) return { acquired: true, holder: { pid, startedAt } };
    const observed = observeLock(paths);
    if (observed === null) continue; // released between the create and the look: try the create again
    if (!isLockStale(observed.lock, { nowMs, isAlive, mtimeMs: observed.mtimeMs })) {
      return { acquired: false, holder: holderOf(observed.lock) };
    }
    return takeOver(paths, observed, { nowMs, pid, startedAt, content });
  }
  return { acquired: false, holder: null };
}

// Removes run.lock, but only when it still holds `pid`.
export function releaseLock(paths, pid = process.pid) {
  const lock = readLock(paths);
  if (lock !== null && lock !== 'corrupt' && lock.pid === pid) unlinkQuiet(paths.lockFile);
}

// ---- the due rule ----------------------------------------------------------------------------------------------------

// A missing or unparsable timestamp counts as "never".
const olderThan = (iso, nowMs, ageMs) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) || nowMs - t > ageMs;
};

// Spec 5, step 3: the database exists, the last success is missing or older than intervalDays, the last attempt is
// missing or older than 24 h, and the lock is free (absent or stale: the caller computes `lockFree`).
export function isDue(state, config, { nowMs, dbExists, lockFree }) {
  if (!dbExists || !lockFree) return false;
  return olderThan(state.lastSuccessAt, nowMs, config.intervalDays * DAY_MS)
    && olderThan(state.lastAttemptAt, nowMs, ATTEMPT_RETRY_MS);
}
