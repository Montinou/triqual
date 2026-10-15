// A small cross-process lock for a read-modify-write of one file (spec Addendum F.3; the Grok hook state, and T8's
// harnesses.json): the directory `<target>.lock`, taken with mkdir, which fails when it exists. node: built-ins only.
import { mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRY_MS = 20;
// The default age past which a lock dir is taken over as left by a dead process. harness-sync bounds the one CLI call
// it makes under the manifest lock below it.
export const LOCK_STALE_MS = 10000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Age in ms of the path, or null when it is gone.
function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Moves a lock dir older than staleMs aside and removes it. The age is checked again on the moved dir: one that turns
// out fresh (its holder re-took the lock between the first check and the move) goes back, unless the lock was taken
// again meanwhile.
function takeOverStale(lockDir, staleMs) {
  const aside = `${lockDir}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockDir, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return; // released, or taken over by someone else: retry
    throw err;
  }
  const age = ageOf(aside);
  if (age !== null && age <= staleMs && ageOf(lockDir) === null) {
    try {
      renameSync(aside, lockDir);
      return;
    } catch { /* fall through: remove it */ }
  }
  try { rmdirSync(aside); } catch { /* already gone */ }
}

// Runs `fn` while holding `<target>.lock` and resolves to { locked: true, value } (value: what fn returned or resolved
// to). The parent dir is created when missing. A lock dir older than staleMs is taken over; past waitMs the call gives
// up with { locked: false, value: undefined }, and fn never runs. The lock dir is removed when fn returns or throws
// (fn's error is re-thrown), but only while it is still the one this call made.
export async function withLock(target, fn, { staleMs = LOCK_STALE_MS, waitMs = 2000 } = {}) {
  const lockDir = `${target}.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  const giveUpAt = Date.now() + waitMs;
  let ino;
  for (;;) {
    try {
      mkdirSync(lockDir);
      ino = statSync(lockDir).ino;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const age = ageOf(lockDir);
    if (age !== null && age > staleMs) {
      takeOverStale(lockDir, staleMs);
      continue;
    }
    if (Date.now() >= giveUpAt) return { locked: false, value: undefined };
    await delay(Math.min(RETRY_MS, Math.max(1, giveUpAt - Date.now())));
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    try {
      if (statSync(lockDir).ino === ino) rmdirSync(lockDir);
    } catch { /* gone already: taken over as stale */ }
  }
}
