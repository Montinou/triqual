import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExperiments, validateExperiments, pickArm, armFor } from '../cli/lib/eval-experiments.mjs';

const exp = (over = {}) => ({
  id: 'e1', kind: 'session', status: 'active', start: '2026-11-17T00:00:00Z', control: 'a',
  arms: { a: { model: 'x' }, b: { model: 'y' } }, margin: 0.1, objective: 'cost', evaluators: 'h1', ...over,
});
const roleExp = (id, role, over = {}) => exp({
  id, kind: 'role',
  arms: { a: { role, model: 'm1', effort: 'low' }, b: { role, model: 'm2', effort: 'high' } }, ...over,
});

test('a valid experiment passes', () => {
  assert.deepEqual(validateExperiments([exp()]), { ok: true });
});

test('rejects unknown kind', () => {
  assert.deepEqual(validateExperiments([exp({ kind: 'nope' })]), { ok: false, field: 'experiments.0.kind' });
});

test('rejects an unknown status', () => {
  assert.deepEqual(validateExperiments([exp({ status: 'running' })]), { ok: false, field: 'experiments.0.status' });
});

test('rejects an unknown objective', () => {
  assert.deepEqual(validateExperiments([exp({ objective: 'speed' })]), { ok: false, field: 'experiments.0.objective' });
});

test('objective defaults to cost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-'));
  const file = join(dir, 'experiments.json');
  const { objective, ...rest } = exp();
  writeFileSync(file, JSON.stringify({ experiments: [rest] }));
  const [loaded] = loadExperiments(file);
  assert.equal(loaded.objective, 'cost');
  assert.deepEqual(validateExperiments(loadExperiments(file)), { ok: true });
});

test('a missing file loads as an empty list', () => {
  assert.deepEqual(loadExperiments(join(mkdtempSync(join(tmpdir(), 'exp-')), 'none.json')), []);
});

test('rejects a missing control', () => {
  assert.deepEqual(validateExperiments([exp({ control: 'zzz' })]), { ok: false, field: 'experiments.0.control' });
});

test('rejects an arm count other than two', () => {
  assert.deepEqual(validateExperiments([exp({ arms: { a: {} } })]), { ok: false, field: 'experiments.0.arms' });
  assert.deepEqual(validateExperiments([exp({ arms: { a: {}, b: {}, c: {} } })]), { ok: false, field: 'experiments.0.arms' });
});

test('rejects a margin outside (0, 1)', () => {
  for (const margin of [0, 1, -0.1, 1.5, '0.1']) {
    assert.deepEqual(validateExperiments([exp({ margin })]), { ok: false, field: 'experiments.0.margin' });
  }
});

test('rejects two active session experiments', () => {
  assert.deepEqual(validateExperiments([exp(), exp({ id: 'e2' })]), { ok: false, field: 'experiments.1.status' });
});

test('a paused session experiment beside an active one is fine', () => {
  assert.deepEqual(validateExperiments([exp(), exp({ id: 'e2', status: 'paused' })]), { ok: true });
});

test('rejects an active experiment without evaluators', () => {
  assert.deepEqual(validateExperiments([exp({ evaluators: undefined })]), { ok: false, field: 'experiments.0.evaluators' });
  assert.deepEqual(validateExperiments([exp({ status: 'paused', evaluators: undefined })]), { ok: true });
});

test('role experiments: one active per role, arms must share a role', () => {
  assert.deepEqual(validateExperiments([roleExp('r1', 'planner'), roleExp('r2', 'reviewer')]), { ok: true });
  assert.deepEqual(validateExperiments([roleExp('r1', 'planner'), roleExp('r2', 'planner')]), { ok: false, field: 'experiments.1.status' });
  const mixed = roleExp('r3', 'planner');
  mixed.arms.b.role = 'reviewer';
  assert.deepEqual(validateExperiments([mixed]), { ok: false, field: 'experiments.0.arms' });
});

test('skill and session experiments do not clash with each other', () => {
  const skill = exp({ id: 's1', kind: 'skill', arms: { a: { pluginDir: '/x' }, b: { pluginDir: '/y' } } });
  assert.deepEqual(validateExperiments([exp(), skill]), { ok: true });
  assert.deepEqual(validateExperiments([skill, { ...skill, id: 's2' }]), { ok: false, field: 'experiments.1.status' });
});

test('pickArm is a pure function of experiment id and key, whatever the arm order', () => {
  assert.equal(pickArm('e1', ['a', 'b'], 'k'), pickArm('e1', ['b', 'a'], 'k'));
  assert.ok(['a', 'b'].includes(pickArm('e1', ['a', 'b'], 'k')));
});

test('armFor is stable across runs', async () => {
  const keys = Array.from({ length: 50 }, (_, i) => `key-${i}`);
  const url = new URL('../cli/lib/eval-experiments.mjs', import.meta.url);
  const m1 = await import(`${url.href}?run=1`);
  const m2 = await import(`${url.href}?run=2`);
  const experiments = [exp()];
  const first = keys.map((k) => m1.armFor('session', k, { experiments })?.arm);
  const second = keys.map((k) => m2.armFor('session', k, { experiments })?.arm);
  assert.deepEqual(first, second);
  assert.ok(new Set(first).size === 2);
});

test('10,000 keys split within 2% of even', () => {
  const experiments = [exp()];
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 10000; i += 1) counts[armFor('session', `session-${i}`, { experiments }).arm] += 1;
  for (const n of Object.values(counts)) assert.ok(n >= 4900 && n <= 5100, `arm count ${n}`);
});

test('armFor returns the experiment, arm and payload', () => {
  const experiments = [exp()];
  const r = armFor('session', 'k', { experiments });
  assert.equal(r.experiment.id, 'e1');
  assert.deepEqual(r.payload, experiments[0].arms[r.arm]);
});

test('no active experiment gives null', () => {
  assert.equal(armFor('session', 'k', { experiments: [] }), null);
  assert.equal(armFor('session', 'k', { experiments: [exp({ status: 'paused' })] }), null);
  assert.equal(armFor('skill', 'k', { experiments: [exp()] }), null);
});

test('armFor for a role picks the experiment of that role only', () => {
  const experiments = [roleExp('r1', 'planner'), roleExp('r2', 'reviewer')];
  assert.equal(armFor('role', 'k', { experiments, target: 'reviewer' }).experiment.id, 'r2');
  assert.equal(armFor('role', 'k', { experiments, target: 'planner' }).experiment.id, 'r1');
  assert.equal(armFor('role', 'k', { experiments, target: 'other' }), null);
});

test('margin defaults to 0.10 when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-'));
  const file = join(dir, 'experiments.json');
  const { margin, ...rest } = exp();
  writeFileSync(file, JSON.stringify({ experiments: [rest] }));
  assert.equal(loadExperiments(file)[0].margin, 0.1);
});
