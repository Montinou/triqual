import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeArm, recordSessionArm } from '../cli/lib/eval-arms.mjs';

// Invented ids and arm names only.
const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evarms-'));
const rec = (sessionId, arm, source = 'startup') => ({ sessionId, source, arm, launchId: null, at: '2026-11-17T10:00:00.000Z' });
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('no records: no arm, not contaminated', () => {
  assert.deepEqual(attributeArm('s1', []), { arm: null, contaminated: false });
  assert.deepEqual(attributeArm('s1', [rec('other', 'a')]), { arm: null, contaminated: false }, 'another session\'s record does not count');
});

test('records that all name the same arm give that arm', () => {
  assert.deepEqual(attributeArm('s1', [rec('s1', 'a'), rec('s1', 'a', 'resume')]), { arm: 'a', contaminated: false });
});

test('mixed SessionStart arm records are contaminated', () => {
  assert.deepEqual(attributeArm('s1', [rec('s1', 'a'), rec('s1', 'b')]), { arm: null, contaminated: true });
  assert.deepEqual(attributeArm('s1', [rec('s1', 'a'), rec('s1', null)]), { arm: null, contaminated: true }, 'an arm and null disagree');
  assert.deepEqual(attributeArm('s1', [rec('s1', null), rec('s1', 'a')]), { arm: null, contaminated: true });
  assert.deepEqual(attributeArm('s1', [rec('s1', null), rec('s1', null)]), { arm: null, contaminated: false }, 'all null agree');
});

test('a /clear inside an assigned process counts for its arm', () => {
  // The process keeps its environment, so startup and the later clear carry the same arm; clear gives a new session id.
  const records = [rec('s1', 'a', 'startup'), rec('s2', 'a', 'clear')];
  assert.deepEqual(attributeArm('s1', records), { arm: 'a', contaminated: false });
  assert.deepEqual(attributeArm('s2', records), { arm: 'a', contaminated: false });
});

test('recordSessionArm appends one line with the arm and launch from the environment', () => {
  const evals = join(tmp(), 'evals');
  const env = { TRIQUAL_EVALS_DIR: evals, TRIQUAL_EVAL_ARM: 'arm-a', TRIQUAL_EVAL_LAUNCH: 'launch-1' };
  recordSessionArm({ input: { sessionId: 's1', source: 'startup' }, env, home: '/nonexistent-home' });
  recordSessionArm({ input: { sessionId: 's1', source: 'clear' }, env, home: '/nonexistent-home' });
  const file = join(evals, 'session-arms.jsonl');
  const rows = lines(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ['sessionId', 'source', 'arm', 'launchId', 'at']);
  assert.deepEqual({ ...rows[0], at: null }, { sessionId: 's1', source: 'startup', arm: 'arm-a', launchId: 'launch-1', at: null });
  assert.equal(rows[1].source, 'clear');
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)) && rows[0].at.endsWith('Z'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(evals).mode & 0o777, 0o700);
});

test('no env var: the record has arm null and launchId null', () => {
  const evals = join(tmp(), 'evals');
  recordSessionArm({ input: { sessionId: 's1', source: 'startup' }, env: { TRIQUAL_EVALS_DIR: evals }, home: '/nonexistent-home' });
  const [row] = lines(join(evals, 'session-arms.jsonl'));
  assert.equal(row.arm, null);
  assert.equal(row.launchId, null);
});

test('an empty TRIQUAL_EVAL_ARM or TRIQUAL_EVAL_LAUNCH is not an arm or a launch: the record says null', () => {
  const evals = join(tmp(), 'evals');
  const env = { TRIQUAL_EVALS_DIR: evals, TRIQUAL_EVAL_ARM: '', TRIQUAL_EVAL_LAUNCH: '' };
  recordSessionArm({ input: { sessionId: 's1', source: 'startup' }, env, home: '/nonexistent-home' });
  const [row] = lines(join(evals, 'session-arms.jsonl'));
  assert.equal(row.arm, null);
  assert.equal(row.launchId, null);
});

test('an empty session id writes nothing', () => {
  const evals = join(tmp(), 'evals');
  for (const input of [{ sessionId: '', source: 'startup' }, { session_id: '' }]) {
    recordSessionArm({ input, env: { TRIQUAL_EVALS_DIR: evals, TRIQUAL_EVAL_ARM: 'arm-a' }, home: '/nonexistent-home' });
  }
  assert.equal(existsSync(join(evals, 'session-arms.jsonl')), false);
});

test('the evals directory defaults under home when TRIQUAL_EVALS_DIR is unset', () => {
  const home = tmp();
  recordSessionArm({ input: { sessionId: 's1', source: 'startup' }, env: { XDG_DATA_HOME: join(home, 'xdg') }, home });
  assert.equal(lines(join(home, 'xdg', 'triqual', 'evals', 'session-arms.jsonl')).length, 1);
});

test('recordSessionArm never throws and reports to onError; no session id writes nothing', () => {
  const base = tmp();
  const blocker = join(base, 'file');
  writeFileSync(blocker, 'x');
  const seen = [];
  assert.doesNotThrow(() => recordSessionArm({
    input: { sessionId: 's1', source: 'startup' }, env: { TRIQUAL_EVALS_DIR: join(blocker, 'evals') }, home: base, onError: (e) => seen.push(e),
  }));
  assert.equal(seen.length, 1);
  assert.doesNotThrow(() => recordSessionArm({ input: { sessionId: 's1' }, env: { TRIQUAL_EVALS_DIR: join(blocker, 'evals') }, home: base }));
  const evals = join(base, 'evals');
  for (const input of [{}, null, undefined, { sessionId: 7 }]) recordSessionArm({ input, env: { TRIQUAL_EVALS_DIR: evals }, home: base });
  assert.equal(existsSync(join(evals, 'session-arms.jsonl')), false);
});
