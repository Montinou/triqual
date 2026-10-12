// A cross-process write lock (spec Addendum E.8): an exclusively created lock file, held while `fn` runs. Used for
// the tracking root (every mutating `triqual tasks` subcommand, from its first read through the status.md render) and for
// the repo registry. Self-contained; node: built-ins only.
import {
  closeSync, fstatSync, linkSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readEnv } from './brand.mjs';
import { localRoot } from './tracking.mjs';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const code = (err) => err?.code;

// A positive integer from TRIQUAL_<suffix> (else the legacy CM_<suffix>), else `fallback`: LOCK_TIMEOUT_MS and
// LOCK_STALE_MS override the defaults (tests use small values).
function envMs(suffix, fallback) {
  const raw = readEnv(process.env, suffix);
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : fallback;
}

// Age in ms of the file at `path`, or null when it is gone.
function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (err) {
    if (code(err) === 'ENOENT') return null;
    throw err;
  }
}

// Takes over a lock older than `staleMs`: renames it to a unique name, then re-checks the renamed file's age. Only a
// still-stale file is deleted; a fresh one (its holder re-took the lock between the first check and the rename) is put
// back unless someone else created the lock meanwhile. Exported for tests (the race is not reproducible on demand).
export function takeOverStale(lockPath, staleMs) {
  const aside = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if (code(err) === 'ENOENT') return; // released or taken over by someone else: just retry
    throw err;
  }
  const age = ageOf(aside);
  if (age === null) return;
  if (age > staleMs) {
    try { unlinkSync(aside); } catch (err) { if (code(err) !== 'ENOENT') throw err; }
    return;
  }
  try {
    linkSync(aside, lockPath);
  } catch (err) {
    if (code(err) !== 'EEXIST') throw err;
  } finally {
    try { unlinkSync(aside); } catch { /* already gone */ }
  }
}

// Runs `fn` while holding the lock file at `lockPath` and returns its value; the lock is released in `finally`. The
// file is created with openSync(lockPath, 'wx'). Only EEXIST is retried (every `retryMs`, until `timeoutMs`); any
// other error is rethrown at once. A lock older than `staleMs` is taken over. On timeout it throws
// Error('lock timeout: <lockPath>'). The timeoutMs and staleMs defaults (5000, 30000) come from TRIQUAL_LOCK_TIMEOUT_MS
// and TRIQUAL_LOCK_STALE_MS (else their CM_ names) when set; an explicit option wins.
export function withLock(lockPath, fn, {
  timeoutMs = envMs('LOCK_TIMEOUT_MS', 5000), staleMs = envMs('LOCK_STALE_MS', 30000), retryMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err;
    }
    const age = ageOf(lockPath);
    if (age === null) continue; // released between our open and stat
    if (age > staleMs) {
      takeOverStale(lockPath, staleMs);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
    sleep(retryMs);
  }
  try {
    try { writeSync(fd, `${process.pid} ${hostname()}\n`); } catch { /* the holder note is informational */ }
    return fn();
  } finally {
    // Removed only while it is still our file: after a takeover (we outlived staleMs) the path is someone else's.
    try {
      if (statSync(lockPath).ino === fstatSync(fd).ino) unlinkSync(lockPath);
    } catch { /* already gone */ }
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

// The tracking root's lock: <git-common-dir>/methodology/tasks.lock in committed and local mode, outside every working
// tree (the Stop hook never sees it) and outside the OS temp dir (sandboxed sessions get their own TMPDIR). In store mode
// it is <documents dir>/tasks.lock under the data directory (`t` is the storeTracking result): never in the working tree
// and never under the git dir, which store mode does not write. Creates the directory.
export function tasksLockPath(t) {
  if (t.mode === 'store') {
    if (typeof t.docsDir !== 'string') throw new Error(`no documents directory for ${t.repoRoot}: open it with storeTracking`);
    mkdirSync(t.docsDir, { recursive: true, mode: 0o700 });
    return join(t.docsDir, 'tasks.lock');
  }
  const dir = t.mode === 'local' ? t.root : localRoot(t.repoRoot);
  if (dir === null) throw new Error(`no git common dir for ${t.repoRoot}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'tasks.lock');
}
