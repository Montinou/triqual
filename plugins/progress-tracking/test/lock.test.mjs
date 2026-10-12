import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync, utimesSync, readdirSync,
  unlinkSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withLock, takeOverStale } from '../lib/lock.mjs';

const LOCK_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'lock.mjs')).href;
// The machine running the suite may be heavily loaded: every wait a test depends on is generous.
const PATIENT = { timeoutMs: 120000 };

function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-lock-')));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Runs an ES module script in a child node process; resolves with { code, stdout, stderr }.
function runChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Waits (polling) until `path` exists: a start barrier so both children race from the same moment.
const barrier = (go) => `
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  while (!existsSync(${JSON.stringify(go)})) sleep(5);`;

test('two processes each doing N read-increment-write cycles under withLock end at 2N', () => withDir(async (dir) => {
  const N = 50;
  const counter = join(dir, 'counter');
  const lock = join(dir, 'counter.lock');
  const go = join(dir, 'go');
  writeFileSync(counter, '0');
  // The 2 ms pause between the read and the write widens the lost-update window: without the lock, the count comes
  // up short.
  const script = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { withLock } from ${JSON.stringify(LOCK_URL)};
    ${barrier(go)}
    for (let i = 0; i < ${N}; i++) {
      withLock(${JSON.stringify(lock)}, () => {
        const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
        sleep(2);
        writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      }, ${JSON.stringify(PATIENT)});
    }`;
  const children = [runChild(script), runChild(script)];
  await delay(50);
  writeFileSync(go, '');
  const results = await Promise.all(children);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(counter, 'utf8'), String(2 * N));
  assert.equal(existsSync(lock), false, 'the lock is released');
}));

test('withLock returns fn\'s value and releases the lock when fn returns or throws', () => withDir((dir) => {
  const lock = join(dir, 'a.lock');
  assert.equal(withLock(lock, () => {
    assert.equal(existsSync(lock), true, 'held while fn runs');
    return 42;
  }), 42);
  assert.equal(existsSync(lock), false);
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), { message: 'boom' });
  assert.equal(existsSync(lock), false);
}));

test('withLock rethrows a non-EEXIST error at once', { skip: process.getuid?.() === 0 && 'root writes read-only dirs' }, () => withDir((dir) => {
  const ro = join(dir, 'ro');
  mkdirSync(ro);
  chmodSync(ro, 0o555);
  const timeoutMs = 60000;
  try {
    let called = false;
    const started = Date.now();
    assert.throws(() => withLock(join(ro, 'x.lock'), () => { called = true; }, { timeoutMs }), { code: 'EACCES' });
    assert.ok(Date.now() - started < timeoutMs, 'failed before timeoutMs');
    assert.equal(called, false);
    // A missing directory is not retried either.
    assert.throws(() => withLock(join(dir, 'missing', 'x.lock'), () => {}, { timeoutMs }), { code: 'ENOENT' });
    assert.ok(Date.now() - started < timeoutMs, 'failed before timeoutMs');
  } finally {
    chmodSync(ro, 0o755);
  }
}));

test('a lock older than staleMs is taken over; a fresh one is waited for', () => withDir(async (dir) => {
  // Stale: taken over at once, and neither the old lock nor its renamed copy is left behind.
  const stale = join(dir, 'stale.lock');
  writeFileSync(stale, 'dead holder\n');
  const past = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(stale, past, past);
  assert.equal(withLock(stale, () => readFileSync(stale, 'utf8') === 'dead holder\n', { staleMs: 30000, timeoutMs: 60000 }), false);
  assert.deepEqual(readdirSync(dir), []);

  // Fresh: the child waits until the holder releases it, and only then runs fn.
  const fresh = join(dir, 'fresh.lock');
  const acquiredAt = join(dir, 'acquired-at');
  writeFileSync(fresh, 'live holder\n');
  const child = runChild(`
    import { writeFileSync } from 'node:fs';
    import { withLock } from ${JSON.stringify(LOCK_URL)};
    withLock(${JSON.stringify(fresh)}, () => writeFileSync(${JSON.stringify(acquiredAt)}, String(Date.now())),
      { staleMs: 600000, timeoutMs: 120000 });`);
  await delay(500);
  assert.equal(existsSync(acquiredAt), false, 'a fresh lock is not taken over');
  assert.equal(readFileSync(fresh, 'utf8'), 'live holder\n');
  const releasedAt = Date.now();
  unlinkSync(fresh);
  const r = await child;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Number(readFileSync(acquiredAt, 'utf8')) >= releasedAt, 'fn ran only after the holder released the lock');
  assert.equal(existsSync(fresh), false);
}));

test('a lock held past timeoutMs throws lock timeout', () => withDir((dir) => {
  const lock = join(dir, 'held.lock');
  writeFileSync(lock, 'holder\n');
  let called = false;
  const started = Date.now();
  assert.throws(() => withLock(lock, () => { called = true; }, { timeoutMs: 300, staleMs: 600000, retryMs: 25 }),
    (err) => err instanceof Error && err.message === `lock timeout: ${lock}`);
  assert.ok(Date.now() - started >= 300, 'waited timeoutMs before giving up');
  assert.equal(called, false);
  assert.equal(readFileSync(lock, 'utf8'), 'holder\n', 'the holder\'s lock is left in place');
}));

// Sets env vars for the duration of fn (withLock reads them at call time).
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('CM_LOCK_TIMEOUT_MS and CM_LOCK_STALE_MS override the defaults; explicit options still win', () => withDir((dir) => {
  const lock = join(dir, 'env.lock');
  writeFileSync(lock, 'holder\n');
  // A fresh lock and CM_LOCK_TIMEOUT_MS=200: gives up after about 200 ms, far below the 5000 ms default.
  let started = Date.now();
  assert.throws(() => withEnv({ CM_LOCK_TIMEOUT_MS: '200' }, () => withLock(lock, () => {})), { message: `lock timeout: ${lock}` });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 5000, `gave up after ${elapsed} ms`);
  // An invalid value falls back to the default, and an explicit timeoutMs wins over the variable.
  started = Date.now();
  assert.throws(() => withEnv({ CM_LOCK_TIMEOUT_MS: '600000' }, () => withLock(lock, () => {}, { timeoutMs: 100 })), /lock timeout/);
  assert.ok(Date.now() - started < 5000);
  // A 2 s old lock: stale under CM_LOCK_STALE_MS=1000 (taken over), fresh under the 30000 ms default (timeout).
  const past = new Date(Date.now() - 2000);
  utimesSync(lock, past, past);
  assert.throws(() => withEnv({ CM_LOCK_TIMEOUT_MS: '100', CM_LOCK_STALE_MS: 'soon' }, () => withLock(lock, () => {})), /lock timeout/);
  assert.equal(withEnv({ CM_LOCK_TIMEOUT_MS: '100', CM_LOCK_STALE_MS: '1000' }, () => withLock(lock, () => 'taken over')), 'taken over');
  assert.deepEqual(readdirSync(dir), []);
}));

test('a stale takeover that finds the renamed lock fresh puts it back', () => withDir((dir) => {
  // The race it covers: the holder re-took the lock between the age check and the rename. takeOverStale is called
  // straight on a fresh lock to reach that branch.
  const lock = join(dir, 'race.lock');
  writeFileSync(lock, 'live holder\n');
  const ino = statSync(lock).ino;
  takeOverStale(lock, 30000);
  assert.equal(readFileSync(lock, 'utf8'), 'live holder\n');
  assert.equal(statSync(lock).ino, ino, 'the same file is back, not a copy');
  assert.deepEqual(readdirSync(dir), ['race.lock'], 'no renamed copy left behind');
  // The same call on a lock that is still stale after the rename deletes it.
  const past = new Date(Date.now() - 60000);
  utimesSync(lock, past, past);
  takeOverStale(lock, 30000);
  assert.deepEqual(readdirSync(dir), [], 'a still-stale renamed lock is deleted');
}));
