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
  arms: { a: { role, model: 'sonnet', effort: 'low' }, b: { role, model: 'opus', effort: 'high' } }, ...over,
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

test('rejects an experiment id outside the role-eval rule', () => {
  for (const id of ['planner-Opus', 'a_b', '', 'a/b', 5]) {
    assert.deepEqual(validateExperiments([exp({ id })]), { ok: false, field: 'experiments.0.id' }, String(id));
  }
});

test('rejects an arm name outside the role-eval rule', () => {
  assert.deepEqual(validateExperiments([exp({ control: 'a', arms: { a: {}, opus_5: {} } })]), { ok: false, field: 'experiments.0.arms' });
  assert.deepEqual(validateExperiments([exp({ control: 'a', arms: { a: {}, 'Opus': {} } })]), { ok: false, field: 'experiments.0.arms' });
});

test('a role arm needs a bare role, a model and an effort the role-eval records accept', () => {
  const withArm = (patch) => {
    const e = roleExp('r1', 'planner');
    e.arms.b = { ...e.arms.b, ...patch };
    return [e];
  };
  const bad = { ok: false, field: 'experiments.0.arms' };
  const both = (patch) => { const e = roleExp('r1', 'planner'); e.arms.a = { ...e.arms.a, ...patch }; e.arms.b = { ...e.arms.b, ...patch }; return [e]; };
  assert.deepEqual(validateExperiments(both({ role: 'roles:planner' })), bad);
  assert.deepEqual(validateExperiments(both({ role: 'Planner' })), bad);
  assert.deepEqual(validateExperiments(withArm({ model: undefined })), bad);
  assert.deepEqual(validateExperiments(withArm({ model: 'Opus 5' })), bad);
  assert.deepEqual(validateExperiments(withArm({ effort: undefined })), bad);
  assert.deepEqual(validateExperiments(withArm({ effort: 'extreme' })), bad);
  assert.deepEqual(validateExperiments([roleExp('r1', 'tdd-implementer')]), { ok: true });
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(validateExperiments(withArm({ effort })), { ok: true }, effort);
  }
  for (const model of ['opus', 'sonnet', 'haiku', 'claude-opus-5', 'gpt-5-codex']) {
    assert.deepEqual(validateExperiments(withArm({ model })), { ok: true }, model);
  }
});

test('the experiment rules are the role-eval record rules', async () => {
  const { ARM_PART, ROLE_NAME, MODEL, EFFORTS } = await import('../cli/lib/role-eval.mjs');
  const m = await import('../cli/lib/eval-experiments.mjs');
  assert.equal(m.ARM_PART, ARM_PART);
  assert.equal(m.ROLE_NAME, ROLE_NAME);
  assert.equal(m.MODEL, MODEL);
  assert.equal(m.EFFORTS, EFFORTS);
});

test('a file whose experiments is not a list is flagged, not loaded as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-'));
  const file = join(dir, 'experiments.json');
  for (const doc of [{ experiments: 'nope' }, { experiments: {} }, { experiments: null }, {}, [], null]) {
    writeFileSync(file, JSON.stringify(doc));
    assert.throws(() => loadExperiments(file), /experiments/, JSON.stringify(doc));
  }
  writeFileSync(file, JSON.stringify({ experiments: [] }));
  assert.deepEqual(loadExperiments(file), [], 'an empty list is still empty');
});

test('armFor gives no arm for an experiment without an arms object, without throwing', () => {
  for (const arms of [undefined, null, 'x', []]) {
    const label = JSON.stringify(arms) ?? 'undefined';
    assert.equal(armFor('role', 'k', { experiments: [exp({ id: 'r1', kind: 'role', arms })], target: 'planner' }), null, `role, arms ${label}`);
    assert.equal(armFor('session', 'k', { experiments: [exp({ arms })] }), null, `session, arms ${label}`);
  }
  assert.equal(armFor('role', 'k', { experiments: [null, 5, 'x'], target: 'planner' }), null);
});
