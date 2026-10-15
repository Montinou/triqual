import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../cli/lib/lock.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-lock-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('withLock serializes', () => withDir(async (dir) => {
  const target = join(dir, 'state.json');
  let active = 0;
  let maxActive = 0;
  const order = [];
  const body = (name) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:in`);
    await delay(40);
    order.push(`${name}:out`);
    active -= 1;
    return name;
  };
  const [a, b] = await Promise.all([withLock(target, body('a')), withLock(target, body('b'))]);
  assert.deepEqual(a, { locked: true, value: 'a' });
  assert.deepEqual(b, { locked: true, value: 'b' });
  assert.equal(maxActive, 1, order.join(' '));
  assert.equal(existsSync(`${target}.lock`), false);
}));

test('a lock older than staleMs is taken over', () => withDir(async (dir) => {
  const target = join(dir, 'state.json');
  mkdirSync(`${target}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${target}.lock`, old, old);
  const r = await withLock(target, () => 'ran', { staleMs: 10_000, waitMs: 200 });
  assert.deepEqual(r, { locked: true, value: 'ran' });
  assert.equal(existsSync(`${target}.lock`), false);
}));

test('a held lock times out', () => withDir(async (dir) => {
  const target = join(dir, 'state.json');
  mkdirSync(`${target}.lock`);
  let ran = false;
  const started = Date.now();
  const r = await withLock(target, () => { ran = true; }, { staleMs: 10_000, waitMs: 150 });
  assert.equal(r.locked, false);
  assert.equal(ran, false);
  assert.ok(Date.now() - started >= 150, 'it waited waitMs before giving up');
  assert.equal(existsSync(`${target}.lock`), true, 'the holder keeps its lock');
}));

test('the lock dir is removed after fn throws', () => withDir(async (dir) => {
  const target = join(dir, 'state.json');
  await assert.rejects(withLock(target, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(`${target}.lock`), false);
  await assert.rejects(withLock(target, async () => { await delay(5); throw new Error('later'); }), /later/);
  assert.equal(existsSync(`${target}.lock`), false);
  assert.deepEqual(await withLock(target, () => 1), { locked: true, value: 1 });
}));
