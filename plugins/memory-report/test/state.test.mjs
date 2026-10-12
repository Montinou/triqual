// State files, run lock and due rule (spec 5 and 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTempHome } from './helpers.mjs';
import {
  acquireLock, isDue, isLockStale, readLock, readNotice, readSeen, readState, releaseLock, writeNotice, writeSeen,
  writeState,
} from '../lib/state.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const stateUrl = new URL('../lib/state.mjs', import.meta.url).href;

const prepare = (paths) => mkdirSync(paths.stateDir, { recursive: true });
const putLock = (paths, lock) => { prepare(paths); writeFileSync(paths.lockFile, JSON.stringify(lock)); };
const setAge = (path, nowMs, ageMs) => { const t = (nowMs - ageMs) / 1000; utimesSync(path, t, t); };
const readLockFile = (paths) => JSON.parse(readFileSync(paths.lockFile, 'utf8'));
const alive = () => true;

// Runs fn with named fs functions replaced, restoring them (and the ESM bindings) afterwards.
async function withFsPatch(patch, fn) {
  const originals = {};
  for (const [name, make] of Object.entries(patch)) {
    originals[name] = fs[name];
    fs[name] = make(originals[name]);
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    for (const [name, original] of Object.entries(originals)) fs[name] = original;
    syncBuiltinESMExports();
  }
}

// ---- state, notice and seen files ------------------------------------------------------------------------------

test('missing state files read as empty objects', () => withTempHome(({ paths }) => {
  assert.deepEqual(readState(paths), {});
  assert.deepEqual(readNotice(paths), {});
  assert.deepEqual(readSeen(paths), {});
}));

test('corrupt or truncated state.json, notice.json and seen.json read as {}', () => withTempHome(({ paths }) => {
  prepare(paths);
  for (const text of ['{"lastSuccessAt": "2026-10-0', '', 'not json', '[1,2]', 'null', '"text"']) {
    writeFileSync(paths.stateFile, text);
    writeFileSync(paths.noticeFile, text);
    writeFileSync(paths.seenFile, text);
    assert.deepEqual(readState(paths), {}, `state: ${text}`);
    assert.deepEqual(readNotice(paths), {}, `notice: ${text}`);
    assert.deepEqual(readSeen(paths), {}, `seen: ${text}`);
  }
}));

test('writeState creates the state dir, merges into what is on disk and keeps unrelated keys', () => withTempHome(({ paths }) => {
  writeState(paths, { lastAttemptAt: '2026-10-01T00:00:00.000Z' });
  // Another writer lands a value between our two writes; the second write re-reads the file instead of overwriting it.
  const onDisk = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  writeFileSync(paths.stateFile, JSON.stringify({ ...onDisk, lastSuccessAt: '2026-09-30T00:00:00.000Z' }));
  writeState(paths, { lastError: 'boom' });
  assert.deepEqual(readState(paths), {
    lastAttemptAt: '2026-10-01T00:00:00.000Z',
    lastSuccessAt: '2026-09-30T00:00:00.000Z',
    lastError: 'boom',
  });
}));

test('writeState: a patch value of undefined clears the key, and a corrupt file is replaced', () => withTempHome(({ paths }) => {
  writeState(paths, { lastError: 'boom', lastAttemptAt: 'a' });
  writeState(paths, { lastError: undefined });
  assert.deepEqual(readState(paths), { lastAttemptAt: 'a' });
  writeFileSync(paths.stateFile, '{"trunc');
  writeState(paths, { lastSuccessAt: 's' });
  assert.deepEqual(readState(paths), { lastSuccessAt: 's' });
}));

test('two writes in the same millisecond use different temp names', () => withTempHome(async ({ paths }) => {
  const renamed = [];
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    await withFsPatch({
      renameSync: (orig) => (from, to) => { renamed.push(from); return orig(from, to); },
    }, () => {
      writeState(paths, { lastAttemptAt: 'a' });
      writeState(paths, { lastAttemptAt: 'b' });
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(renamed.length, 2);
  assert.notEqual(renamed[0], renamed[1]);
  for (const tmp of renamed) assert.match(tmp, /state\.json\.\d+\.[0-9a-f]+\.tmp$/);
}));

test('notice and seen round-trip only their own keys', () => withTempHome(({ paths }) => {
  writeNotice(paths, { lastNoticeDate: '2026-10-07' });
  assert.deepEqual(readNotice(paths), { lastNoticeDate: '2026-10-07' });
  writeSeen(paths, { seenReport: '/r/2026-W41.md', seenSuccessAt: '2026-10-07T01:00:00.000Z' });
  assert.deepEqual(readSeen(paths), { seenReport: '/r/2026-W41.md', seenSuccessAt: '2026-10-07T01:00:00.000Z' });
  writeFileSync(paths.noticeFile, JSON.stringify({ lastNoticeDate: 5, extra: 'x' }));
  assert.deepEqual(readNotice(paths), {});
  writeFileSync(paths.seenFile, JSON.stringify({ seenReport: 'r', seenSuccessAt: 3, extra: 'x' }));
  assert.deepEqual(readSeen(paths), { seenReport: 'r' });
}));

// ---- readLock and isLockStale ----------------------------------------------------------------------------------

test('readLock: absent is null, valid gives {pid, startedAt}, garbage and wrong shapes are corrupt', () => withTempHome(({ paths }) => {
  assert.equal(readLock(paths), null);
  putLock(paths, { pid: 42, startedAt: '2026-10-07T00:00:00.000Z' });
  assert.deepEqual(readLock(paths), { pid: 42, startedAt: '2026-10-07T00:00:00.000Z' });
  for (const text of ['\u0000\u0001garbage', '', '{"pid": 4', '[]', '{"pid":"7","startedAt":"x"}', '{"pid":7}']) {
    writeFileSync(paths.lockFile, text);
    assert.equal(readLock(paths), 'corrupt', JSON.stringify(text));
  }
}));

test('isLockStale: dead pid, age over 2 h, live and fresh', () => {
  const nowMs = Date.parse('2026-10-07T12:00:00.000Z');
  const at = (ms) => new Date(ms).toISOString();
  const fresh = { pid: 1, startedAt: at(nowMs - 10 * 60 * 1000) };
  assert.equal(isLockStale(fresh, { nowMs, isAlive: alive }), false);
  assert.equal(isLockStale(fresh, { nowMs, isAlive: () => false }), true);
  assert.equal(isLockStale({ pid: 1, startedAt: at(nowMs - 2 * HOUR) }, { nowMs, isAlive: alive }), false);
  assert.equal(isLockStale({ pid: 1, startedAt: at(nowMs - 2 * HOUR - 1000) }, { nowMs, isAlive: alive }), true);
  assert.equal(isLockStale({ pid: 1, startedAt: 'not a date' }, { nowMs, isAlive: alive }), true);
});

test('isLockStale: a corrupt lock is stale only once its mtime is more than 60 s old', () => {
  const nowMs = 1_800_000_000_000;
  const opts = (age) => ({ nowMs, isAlive: alive, mtimeMs: nowMs - age });
  assert.equal(isLockStale('corrupt', opts(10_000)), false);
  assert.equal(isLockStale('corrupt', opts(60_000)), false);
  assert.equal(isLockStale('corrupt', opts(61_000)), true);
  assert.equal(isLockStale('corrupt', { nowMs, isAlive: alive }), false);
});

// ---- acquireLock -----------------------------------------------------------------------------------------------

test('no lock: acquired, holder is this process and the file is private', () => withTempHome(({ paths }) => {
  const nowMs = Date.parse('2026-10-07T12:00:00.000Z');
  const result = acquireLock(paths, { nowMs, isAlive: alive, pid: 4001 });
  assert.deepEqual(result, { acquired: true, holder: { pid: 4001, startedAt: '2026-10-07T12:00:00.000Z' } });
  assert.deepEqual(readLockFile(paths), { pid: 4001, startedAt: '2026-10-07T12:00:00.000Z' });
  assert.equal(fs.statSync(paths.lockFile).mode & 0o777, 0o600);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

test('acquireLock defaults the pid to process.pid', () => withTempHome(({ paths }) => {
  const result = acquireLock(paths, { nowMs: Date.now(), isAlive: alive });
  assert.equal(result.acquired, true);
  assert.equal(result.holder.pid, process.pid);
}));

test('a live fresh lock is not acquired and its holder is returned', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  const held = { pid: 5001, startedAt: new Date(nowMs - 5 * 60 * 1000).toISOString() };
  putLock(paths, held);
  const result = acquireLock(paths, { nowMs, isAlive: alive, pid: 5002 });
  assert.deepEqual(result, { acquired: false, holder: held });
  assert.deepEqual(readLockFile(paths), held);
}));

test('a lock whose pid is dead is taken over and the takeover file is gone', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 5001, startedAt: new Date(nowMs - 60_000).toISOString() });
  const result = acquireLock(paths, { nowMs, isAlive: (pid) => pid !== 5001, pid: 5002 });
  assert.equal(result.acquired, true);
  assert.equal(readLockFile(paths).pid, 5002);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

test('a lock older than 2 h is taken over even when its pid is alive', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 5001, startedAt: new Date(nowMs - 2 * HOUR - 5000).toISOString() });
  const result = acquireLock(paths, { nowMs, isAlive: alive, pid: 5002 });
  assert.equal(result.acquired, true);
  assert.equal(readLockFile(paths).pid, 5002);
}));

test('a corrupt lock: not acquired at 10 s, acquired over at 61 s (Review Focus 5)', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  prepare(paths);
  writeFileSync(paths.lockFile, '\u0000{"pid": garbage');
  setAge(paths.lockFile, nowMs, 10_000);
  const young = acquireLock(paths, { nowMs, isAlive: alive, pid: 6001 });
  assert.deepEqual(young, { acquired: false, holder: null });
  assert.equal(readFileSync(paths.lockFile, 'utf8'), '\u0000{"pid": garbage');
  setAge(paths.lockFile, nowMs, 61_000);
  const old = acquireLock(paths, { nowMs, isAlive: alive, pid: 6001 });
  assert.equal(old.acquired, true);
  assert.equal(readLockFile(paths).pid, 6001);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

test('two contenders on one stale lock: exactly one acquires', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 7000, startedAt: new Date(nowMs - 30_000).toISOString() });
  const isAlive = (pid) => pid !== 7000;
  const first = acquireLock(paths, { nowMs, isAlive, pid: 7001 });
  const second = acquireLock(paths, { nowMs, isAlive, pid: 7002 });
  assert.equal(first.acquired, true);
  assert.deepEqual(second.acquired, false);
  assert.equal(second.holder.pid, 7001);
  assert.equal(readLockFile(paths).pid, 7001);
}));

test('two processes racing on one stale lock: exactly one acquires, every round', () => withTempHome(async ({ paths }) => {
  const script = `
    import(${JSON.stringify(stateUrl)}).then(({ acquireLock }) => {
      const paths = JSON.parse(process.argv[1]);
      const pid = Number(process.argv[2]);
      const result = acquireLock(paths, { nowMs: Date.now(), isAlive: (p) => p !== 7000, pid });
      console.log(JSON.stringify(result.acquired));
    });`;
  const run = (pid) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(paths), String(pid)]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  });
  for (let round = 0; round < 5; round += 1) {
    putLock(paths, { pid: 7000, startedAt: new Date(Date.now() - 30_000).toISOString() });
    const results = await Promise.all([run(7101), run(7102)]);
    assert.equal(results.filter(Boolean).length, 1, `round ${round}: ${results}`);
    assert.equal(existsSync(paths.takeoverFile), false);
  }
}));

test('a lock replaced between observation and takeover is left alone', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 8000, startedAt: new Date(nowMs - 30_000).toISOString() });
  const replacement = { pid: 8888, startedAt: new Date(nowMs - 1000).toISOString() };
  const isAlive = (pid) => {
    // Called once the stale lock has been observed: another process takes the lock over right now.
    if (pid === 8000) writeFileSync(paths.lockFile, JSON.stringify(replacement));
    return pid !== 8000;
  };
  const result = acquireLock(paths, { nowMs, isAlive, pid: 8001 });
  assert.deepEqual(result, { acquired: false, holder: replacement });
  assert.deepEqual(readLockFile(paths), replacement);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

test('a takeover file younger than 60 s blocks the takeover and is left in place', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 9000, startedAt: new Date(nowMs - 30_000).toISOString() });
  writeFileSync(paths.takeoverFile, '9999');
  setAge(paths.takeoverFile, nowMs, 59_000);
  const result = acquireLock(paths, { nowMs, isAlive: (pid) => pid !== 9000, pid: 9001 });
  assert.equal(result.acquired, false);
  assert.equal(readLockFile(paths).pid, 9000);
  assert.equal(existsSync(paths.takeoverFile), true);
}));

test('a takeover file older than 60 s is stale: removed, and the takeover goes ahead', () => withTempHome(({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 9000, startedAt: new Date(nowMs - 30_000).toISOString() });
  writeFileSync(paths.takeoverFile, '9999');
  setAge(paths.takeoverFile, nowMs, 61_000);
  const result = acquireLock(paths, { nowMs, isAlive: (pid) => pid !== 9000, pid: 9001 });
  assert.equal(result.acquired, true);
  assert.equal(readLockFile(paths).pid, 9001);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

test('takeover step 3: the create hitting EEXIST means not acquired, and the takeover file is removed', () => withTempHome(async ({ paths }) => {
  const nowMs = Date.now();
  putLock(paths, { pid: 9500, startedAt: new Date(nowMs - 30_000).toISOString() });
  const intruder = { pid: 9777, startedAt: new Date(nowMs).toISOString() };
  let planted = false;
  const result = await withFsPatch({
    unlinkSync: (orig) => (path) => {
      orig(path);
      // Right after the stale lock is removed, a third process creates its own lock.
      if (path === paths.lockFile && !planted) {
        planted = true;
        writeFileSync(paths.lockFile, JSON.stringify(intruder), { flag: 'wx' });
      }
    },
  }, () => acquireLock(paths, { nowMs, isAlive: (pid) => pid !== 9500, pid: 9501 }));
  assert.equal(planted, true);
  assert.equal(result.acquired, false);
  assert.deepEqual(result.holder, intruder);
  assert.deepEqual(readLockFile(paths), intruder);
  assert.equal(existsSync(paths.takeoverFile), false);
}));

// ---- releaseLock -----------------------------------------------------------------------------------------------

test('releaseLock removes only a lock that holds its own pid', () => withTempHome(({ paths }) => {
  const held = { pid: 100, startedAt: '2026-10-07T00:00:00.000Z' };
  putLock(paths, held);
  releaseLock(paths, 200);
  assert.deepEqual(readLockFile(paths), held);
  releaseLock(paths, 100);
  assert.equal(existsSync(paths.lockFile), false);
  releaseLock(paths, 100);
  assert.equal(existsSync(paths.lockFile), false);
  writeFileSync(paths.lockFile, 'garbage');
  releaseLock(paths, 100);
  assert.equal(readFileSync(paths.lockFile, 'utf8'), 'garbage');
}));

test('releaseLock defaults to process.pid', () => withTempHome(({ paths }) => {
  assert.equal(acquireLock(paths, { nowMs: Date.now(), isAlive: alive }).acquired, true);
  releaseLock(paths);
  assert.equal(existsSync(paths.lockFile), false);
}));

test('the state dir of the lock is created when missing', () => withTempHome(({ paths }) => {
  assert.equal(existsSync(dirname(paths.lockFile)), false);
  assert.equal(acquireLock(paths, { nowMs: Date.now(), isAlive: alive, pid: 1 }).acquired, true);
  assert.equal(existsSync(join(paths.stateDir, 'run.lock')), true);
}));

// ---- isDue -----------------------------------------------------------------------------------------------------

test('isDue table', () => {
  const nowMs = Date.parse('2026-10-07T12:00:00.000Z');
  const ago = (ms) => new Date(nowMs - ms).toISOString();
  const config = { intervalDays: 7 };
  const ok = { nowMs, dbExists: true, lockFree: true };
  assert.equal(isDue({}, config, ok), true, 'no lastSuccessAt');
  assert.equal(isDue({ lastSuccessAt: ago(6 * DAY) }, config, ok), false, 'success 6 days ago');
  assert.equal(isDue({ lastSuccessAt: ago(8 * DAY), lastAttemptAt: ago(23 * HOUR) }, config, ok), false, 'attempt 23 h ago');
  assert.equal(isDue({ lastSuccessAt: ago(8 * DAY), lastAttemptAt: ago(25 * HOUR) }, config, ok), true, 'attempt 25 h ago');
  assert.equal(isDue({ lastSuccessAt: ago(8 * DAY) }, config, ok), true, 'no attempt');
  assert.equal(isDue({}, config, { ...ok, dbExists: false }), false, 'no database');
  assert.equal(isDue({}, config, { ...ok, lockFree: false }), false, 'lock held');
});

test('isDue reads config.intervalDays and treats unparsable dates as missing', () => {
  const nowMs = Date.parse('2026-10-07T12:00:00.000Z');
  const ago = (ms) => new Date(nowMs - ms).toISOString();
  const ok = { nowMs, dbExists: true, lockFree: true };
  assert.equal(isDue({ lastSuccessAt: ago(2 * DAY) }, { intervalDays: 1 }, ok), true);
  assert.equal(isDue({ lastSuccessAt: ago(2 * DAY) }, { intervalDays: 3 }, ok), false);
  assert.equal(isDue({ lastSuccessAt: 'not a date' }, { intervalDays: 7 }, ok), true);
  assert.equal(isDue({ lastSuccessAt: ago(30 * DAY), lastAttemptAt: 'nope' }, { intervalDays: 7 }, ok), true);
});
