import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-report.mjs';
import { planUnits } from '../cli/lib/eval-plans.mjs';
import { buildRows, verdict } from '../cli/lib/eval-report.mjs';
import { snapshot } from '../cli/lib/eval-snapshot.mjs';

const plannerExperiment = (over = {}) => ({
  id: 'e-plan',
  kind: 'role',
  status: 'active',
  start: '2026-11-01',
  control: 'off',
  arms: {
    off: { role: 'planner', model: 'sonnet', effort: 'high' },
    on: { role: 'planner', model: 'opus', effort: 'high' },
  },
  margin: 0.1,
  objective: 'parallelism',
  evaluators: 'plan-review',
  ...over,
});

const costExperiment = (over = {}) => ({
  id: 'e1',
  kind: 'session',
  status: 'active',
  start: '2026-11-01',
  control: 'off',
  arms: { off: { model: 'm1' }, on: { model: 'm2' } },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'h',
  ...over,
});

// Builds `total` synthetic `plan-review` records for `<expId>/<arm>`; the first `clean` have critical + important = 0,
// the rest have critical or important > 0.
const planRecords = (arm, clean, total, {
  expId = 'e-plan',
  at = '2026-11-05T10:00:00.000Z',
  parallelismOf = () => 1.5,
  usdOf = () => 2,
  minorOf = () => 0,
} = {}) => Array.from({ length: total }, (_, i) => {
  const isClean = i < clean;
  return {
    v: 2,
    at,
    kind: 'plan-review',
    plan: `2026-11-05-plan-${arm}-${i}.md`,
    arm: arm === null ? null : `${expId}/${arm}`,
    tasks: 6,
    phases: 2,
    parallelism: parallelismOf(i),
    runnerOnly: 0,
    auditFindings: {
      critical: isClean ? 0 : (i % 2 === 0 ? 1 : 0),
      important: isClean ? 0 : (i % 2 === 0 ? 0 : 1),
      minor: minorOf(i),
    },
    plannerUsd: usdOf(i),
  };
});

// Synthetic session units matching T20's fixtures.
const sessionUnitsFixture = (arm, healthy, total, costOf = () => 1, extra = {}) => Array.from({ length: total }, (_, i) => ({
  arm,
  contaminated: false,
  verdict: i < healthy ? 'healthy' : 'unhealthy',
  cost: costOf(i),
  project: '/home/x/Client',
  models: ['m1'],
  ...extra,
}));

const armRow = (rows) => rows.find((r) => !r.control);
const controlRow = (rows) => rows.find((r) => r.control);

test('parallelism objective: propose only when the parallelism interval excludes zero and the arm is non-inferior on audit-clean', () => {
  const exp = plannerExperiment();

  // Fixture 1: higher parallelism (pL > 0) and non-inferior on audit-clean (L >= -m) -> propose, even when cost is higher.
  const proposeRecords = [
    ...planRecords('off', 180, 200, {
      parallelismOf: (i) => 1.5 + (i % 3) * 0.25,
      usdOf: (i) => 2 + (i % 3),
      minorOf: (i) => i % 2,
    }),
    ...planRecords('on', 180, 200, {
      parallelismOf: (i) => 2.5 + (i % 3) * 0.25,
      usdOf: (i) => 5 + (i % 3),
    }),
  ];
  const proposeRows = buildRows(planUnits(proposeRecords, exp), exp);
  const proposeControl = controlRow(proposeRows);
  const proposeArm = armRow(proposeRows);
  assert.equal(proposeControl.n, 200);
  assert.equal(proposeControl.rate, 0.9);
  assert.equal(proposeControl.parallelismMedian, 1.75);
  assert.equal(proposeControl.parallelismCI.length, 2);
  assert.equal(proposeControl.p, null);
  assert.equal(proposeControl.pCI, null);
  assert.equal(proposeArm.n, 200);
  assert.equal(proposeArm.rate, 0.9);
  assert.equal(proposeArm.parallelismMedian, 2.75);
  assert.equal(proposeArm.parallelismCI.length, 2);
  assert.equal(proposeArm.p, 1);
  assert.equal(proposeArm.pCI.length, 2);
  assert.ok(proposeArm.dCI[0] >= -0.1);
  assert.ok(proposeArm.pCI[0] > 0);
  assert.ok(proposeArm.cCI[1] > 0);
  assert.equal(proposeArm.verdict, 'propose');

  // Fixture 2: parallelism interval crossing zero (pL <= 0) and non-inferior on audit-clean -> non-inferior, not more parallel,
  // even when cost is lower (cU < 0).
  const flatRecords = [
    ...planRecords('off', 180, 200, {
      parallelismOf: (i) => 1.5 + (i % 5) * 0.5,
      usdOf: (i) => 10 + (i % 5),
    }),
    ...planRecords('on', 180, 200, {
      parallelismOf: (i) => 1.5 + (i % 5) * 0.5,
      usdOf: (i) => 5 + (i % 5),
    }),
  ];
  const flatRows = buildRows(planUnits(flatRecords, exp), exp);
  const flatArm = armRow(flatRows);
  assert.ok(flatArm.dCI[0] >= -0.1);
  assert.equal(flatArm.p, 0);
  assert.ok(flatArm.pCI[0] <= 0 && flatArm.pCI[1] >= 0);
  assert.ok(flatArm.cCI[1] < 0);
  assert.equal(flatArm.verdict, 'non-inferior, not more parallel');

  // Fixture 3: higher parallelism (pL > 0) but guardrail interval wholly below zero (U < 0) -> worse.
  const worseRecords = [
    ...planRecords('off', 180, 200, { parallelismOf: (i) => 1.5 + (i % 3) * 0.25 }),
    ...planRecords('on', 120, 200, { parallelismOf: (i) => 3.0 + (i % 3) * 0.25 }),
  ];
  const worseRows = buildRows(planUnits(worseRecords, exp), exp);
  const worseArm = armRow(worseRows);
  assert.ok(worseArm.pCI[0] > 0);
  assert.ok(worseArm.dCI[1] < 0);
  assert.equal(worseArm.verdict, 'worse');

  // Direct verdict() checks for the parallelism objective.
  const base = { nArm: 200, nControl: 200, required: 112, margin: 0.1, objective: 'parallelism' };
  assert.equal(verdict({ ...base, lower: -0.05, upper: 0.05, cUpper: 2, pLower: 0.25 }), 'propose');
  assert.equal(verdict({ ...base, lower: -0.05, upper: 0.05, cUpper: -2, pLower: 0 }), 'non-inferior, not more parallel');
  assert.equal(verdict({ ...base, lower: -0.05, upper: 0.05, cUpper: -2, pLower: -0.1 }), 'non-inferior, not more parallel');
  assert.equal(verdict({ ...base, lower: -0.25, upper: -0.05, cUpper: -2, pLower: 0.5 }), 'worse');
  assert.equal(verdict({ ...base, lower: -0.15, upper: 0.02, cUpper: -2, pLower: 0.5 }), 'inconclusive');
});

test('cost objective is unchanged', () => {
  const rowsOf = (all) => buildRows(all, costExperiment());

  // The five T20 fixtures produce the exact same verdicts under the cost objective, and parallelism fields are null.
  const insufficient = rowsOf([...sessionUnitsFixture('off', 27, 30), ...sessionUnitsFixture('on', 27, 29)]);
  assert.equal(armRow(insufficient).n, 29);
  assert.equal(armRow(insufficient).verdict, 'insufficient data');

  const worse = rowsOf([
    ...sessionUnitsFixture('off', 180, 200, (i) => 10 + (i % 5)),
    ...sessionUnitsFixture('on', 120, 200, (i) => 10 + (i % 5)),
  ]);
  assert.ok(armRow(worse).dCI[1] < 0);
  assert.equal(armRow(worse).verdict, 'worse');

  const propose = rowsOf([
    ...sessionUnitsFixture('off', 180, 200, (i) => 10 + (i % 5)),
    ...sessionUnitsFixture('on', 180, 200, (i) => 5 + (i % 5)),
  ]);
  const [control, arm] = propose;
  assert.ok(arm.dCI[0] >= -0.1);
  assert.ok(arm.cCI[1] < 0);
  assert.equal(arm.required, 112);
  assert.equal(arm.verdict, 'propose');
  for (const row of [control, arm]) {
    assert.equal(row.parallelismMedian, null);
    assert.equal(row.parallelismCI, null);
    assert.equal(row.p, null);
    assert.equal(row.pCI, null);
  }

  const notCheaper = rowsOf([
    ...sessionUnitsFixture('off', 180, 200, (i) => 10 + (i % 5)),
    ...sessionUnitsFixture('on', 180, 200, (i) => 11 + (i % 5)),
  ]);
  assert.ok(armRow(notCheaper).dCI[0] >= -0.1);
  assert.ok(armRow(notCheaper).cCI[1] >= 0);
  assert.equal(armRow(notCheaper).verdict, 'non-inferior, not cheaper');

  const inconclusive = rowsOf([...sessionUnitsFixture('off', 180, 200), ...sessionUnitsFixture('on', 170, 200)]);
  assert.ok(armRow(inconclusive).dCI[0] < -0.1 && armRow(inconclusive).dCI[1] >= 0);
  assert.equal(armRow(inconclusive).verdict, 'inconclusive');
});

test('fewer than max(required, 30) plans gives insufficient data with parallelism figures still shown', () => {
  const exp = plannerExperiment();
  const records = [
    ...planRecords('off', 12, 12, { parallelismOf: (i) => 1.5 + (i % 3) * 0.5, usdOf: () => 2 }),
    ...planRecords('on', 12, 12, { parallelismOf: (i) => 2.5 + (i % 3) * 0.5, usdOf: () => 2 }),
  ];
  const rows = buildRows(planUnits(records, exp), exp);
  const control = controlRow(rows);
  const arm = armRow(rows);

  assert.equal(control.n, 12);
  assert.equal(arm.n, 12);
  assert.equal(arm.required, 0);
  assert.equal(arm.verdict, 'insufficient data');

  // Parallelism medians, intervals and difference are still computed and populated when n < max(required, 30).
  assert.equal(control.parallelismMedian, 2);
  assert.ok(Array.isArray(control.parallelismCI) && control.parallelismCI.length === 2);
  assert.ok(control.parallelismCI[0] >= 1.5 && control.parallelismCI[1] <= 2.5);
  assert.equal(control.p, null);
  assert.equal(control.pCI, null);

  assert.equal(arm.parallelismMedian, 3);
  assert.ok(Array.isArray(arm.parallelismCI) && arm.parallelismCI.length === 2);
  assert.ok(arm.parallelismCI[0] >= 2.5 && arm.parallelismCI[1] <= 3.5);
  assert.equal(arm.p, 1);
  assert.ok(Array.isArray(arm.pCI) && arm.pCI.length === 2);
  assert.ok(arm.pCI[0] > 0);
});

test('planUnits filters plan-review records of the planner experiment from start and excludes null plannerUsd from cost only', () => {
  const exp = plannerExperiment({ start: '2026-11-01' });
  const records = [
    ...planRecords('off', 30, 30, {
      parallelismOf: () => 1.5,
      usdOf: (i) => (i < 20 ? 4 : null),
      minorOf: () => 3,
    }),
    ...planRecords('on', 30, 30, {
      parallelismOf: () => 2.5,
      usdOf: (i) => (i < 20 ? 2 : null),
    }),
    // Before experiment start: excluded.
    ...planRecords('on', 0, 5, { at: '2026-10-31T23:59:59.000Z', parallelismOf: () => 1 }),
    // Another experiment or null arm: excluded.
    ...planRecords('on', 0, 3, { expId: 'other-exp', parallelismOf: () => 1 }),
    ...planRecords(null, 0, 2, { parallelismOf: () => 1 }),
    // Non-plan-review record in the role-eval store: excluded.
    { v: 2, at: '2026-11-05T10:00:00.000Z', kind: 'escape', plan: '2026-11-05-plan.md', source: 'red-ci', ref: 'abc1234' },
  ];

  const units = planUnits(records, exp);
  assert.equal(units.length, 60);
  const rows = buildRows(units, exp);
  const [control, arm] = rows;

  // All 30 plans per arm count toward n, audit-clean rate, and parallelism; only the 20 priced plans enter cost.
  assert.equal(control.n, 30);
  assert.equal(arm.n, 30);
  assert.equal(control.rate, 1);
  assert.equal(arm.rate, 1);
  assert.equal(control.costMedian, 4);
  assert.equal(arm.costMedian, 2);
  assert.equal(arm.c, -2);
  assert.equal(control.parallelismMedian, 1.5);
  assert.equal(arm.parallelismMedian, 2.5);
  assert.equal(arm.p, 1);
  assert.equal(arm.verdict, 'propose');

  // A role experiment for another role has no planner planUnits.
  const hunterExp = plannerExperiment({
    arms: {
      off: { role: 'correctness-hunter', model: 'sonnet', effort: 'medium' },
      on: { role: 'correctness-hunter', model: 'haiku', effort: 'medium' },
    },
  });
  assert.deepEqual(planUnits(records, hunterExp), []);
});

test('a plan-review record without readable audit findings is undecided, not clean', () => {
  const exp = plannerExperiment();
  const records = [
    ...planRecords('off', 3, 3),
    { ...planRecords('off', 1, 1)[0], auditFindings: null },
    { ...planRecords('on', 1, 1)[0], auditFindings: { critical: 'x', important: 0, minor: 0 } },
  ];
  const units = planUnits(records, exp);
  assert.equal(units.length, 5);
  assert.deepEqual(units.filter((u) => u.verdict === 'undecided').map((u) => u.arm).sort(), ['off', 'on']);
  const [control] = buildRows(units, exp);
  assert.equal(control.n, 3);
  assert.deepEqual(control.excluded, { contaminated: 0, undecided: 1 });
});

test('a record whose parallelism is not a finite number leaves the parallelism figures only', () => {
  const exp = plannerExperiment();
  const records = [
    ...planRecords('off', 5, 5, { parallelismOf: () => 2 }),
    ...planRecords('on', 5, 5, { parallelismOf: (i) => (i === 0 ? null : 3) }),
  ];
  const [control, arm] = buildRows(planUnits(records, exp), exp);
  assert.equal(arm.n, 5);
  assert.equal(arm.parallelismMedian, 3);
  assert.equal(arm.p, 1);
  assert.equal(control.parallelismMedian, 2);
});

// ---- the forward item: the report stores the code verdict it computes -----------------------------------------

const CHECKS_SRC = `// invented frozen checks
import { readFileSync } from 'node:fs';
export const CHECKS = { 'chased-progress': (signals, file) => (readFileSync(file, 'utf8').includes('CHASED') ? 'fail' : 'pass') };
export function runCheck(id, signals, file, checks = CHECKS) {
  try { return checks[id](signals, file); } catch (err) { if (err?.code === 'ENOENT') return 'undecided'; throw err; }
}
export const checkVersion = () => 'v-snapshot';
`;

// A temp world with one code category, the sessions store and the transcripts. `plan` is [{ id, arm, code }]; `code` is
// 'pass', 'fail' or null (no transcript file). `stored` is an optional recorded verdict line for that session.
function world(plan) {
  const base = mkdtempSync(join(tmpdir(), 'cm-t26-'));
  const evals = join(base, 'evals');
  const dirName = '-home-x-Client';
  const transcripts = join(base, 'transcripts');
  mkdirSync(join(evals, 'judgments'), { recursive: true });
  mkdirSync(join(transcripts, dirName), { recursive: true });
  mkdirSync(join(base, 'judges'));
  writeFileSync(join(base, 'eval-checks.mjs'), CHECKS_SRC);
  const categories = [{ id: 'chased-progress', name: 'chased', definition: 'invented definition', examples: ['x1', 'x2', 'x3'], check: 'code' }];
  const hash = snapshot({ categories, judgeExclude: [], excluded: [] }, { evalsDir: evals, checksFile: join(base, 'eval-checks.mjs'), judgesDir: join(base, 'judges') });
  const stored = [];
  writeFileSync(join(evals, 'sessions.jsonl'), plan.map((p) => {
    if (p.stored) stored.push({ sessionId: p.id, category: 'chased-progress', result: p.stored, promptHash: 'v-snapshot', model: null, auth: 'code', at: '2026-11-06T00:00:00Z' });
    if (p.code !== null) writeFileSync(join(transcripts, dirName, `${p.id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: p.code === 'fail' ? 'CHASED invented' : 'fine invented' } })}\n`);
    return `${JSON.stringify({
      sessionId: p.id, project: '/home/x/Client', projectDir: dirName, start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z',
      models: { m1: { messages: 3, usd: 2 } }, usd: 2, arm: p.arm ?? null, contaminated: false,
    })}\n`;
  }).join(''));
  writeFileSync(join(evals, 'judgments', 'chased-progress.jsonl'), stored.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const experiments = join(base, 'experiments.json');
  writeFileSync(experiments, JSON.stringify({ experiments: [{
    id: 'e1', kind: 'session', status: 'active', start: '2026-11-01', control: 'off', arms: { off: { model: 'm1' }, on: { model: 'm2' } },
    margin: 0.1, objective: 'cost', evaluators: hash,
  }] }));
  const env = { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals, TRIQUAL_EXPERIMENTS_FILE: experiments, TRIQUAL_TRANSCRIPTS_DIR: transcripts };
  return { base, evals, env, transcript: (id) => join(transcripts, dirName, `${id}.jsonl`), file: join(evals, 'judgments', 'chased-progress.jsonl') };
}

async function report(w) {
  let out = '';
  let err = '';
  const code = await main(['--json'], { env: w.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, platform: 'linux' });
  assert.equal(code, 0, err);
  return JSON.parse(out).experiments[0].rows;
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

test('a computed code verdict is stored once and a second report run adds no line', async () => {
  const w = world([
    { id: 'off-0', arm: 'e1/off', code: 'pass' }, { id: 'off-1', arm: 'e1/off', code: 'fail' },
    { id: 'on-0', arm: 'e1/on', code: 'pass' },
    // a session with a stored line of this check version gets no second one, whatever its transcript says
    { id: 'on-1', arm: 'e1/on', code: 'pass', stored: 'fail' },
    // a session with no arm is no assigned session: nothing is stored for it
    { id: 'free-0', arm: null, code: 'pass' },
  ]);
  try {
    await report(w);
    const after = lines(w.file);
    assert.deepEqual(after.map((l) => l.sessionId).sort(), ['off-0', 'off-1', 'on-0', 'on-1']);
    const off1 = after.find((l) => l.sessionId === 'off-1');
    assert.deepEqual(Object.keys(off1).sort(), ['at', 'auth', 'category', 'model', 'promptHash', 'result', 'sessionId']);
    assert.equal(off1.category, 'chased-progress');
    assert.equal(off1.result, 'fail');
    assert.equal(off1.promptHash, 'v-snapshot');
    assert.equal(off1.model, null);
    assert.equal(off1.auth, 'code');
    assert.ok(Number.isFinite(Date.parse(off1.at)));
    assert.equal(after.find((l) => l.sessionId === 'off-0').result, 'pass');
    assert.equal(after.find((l) => l.sessionId === 'on-1').result, 'fail');
    assert.equal(statSync(w.file).mode & 0o777, 0o600);
    const text = readFileSync(w.file, 'utf8');
    await report(w);
    assert.equal(readFileSync(w.file, 'utf8'), text);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('after the transcript is deleted the report gives the same n', async () => {
  const ids = ['off-0', 'off-1', 'on-0', 'on-1', 'on-2'];
  const w = world(ids.map((id) => ({ id, arm: `e1/${id.split('-')[0]}`, code: id === 'on-2' ? 'fail' : 'pass' })));
  try {
    const before = await report(w);
    assert.equal(before[0].n, 2);
    assert.equal(before[1].n, 3);
    for (const id of ids) unlinkSync(w.transcript(id));
    const gone = await report(w);
    for (let i = 0; i < 2; i += 1) {
      assert.equal(gone[i].n, before[i].n);
      assert.equal(gone[i].rate, before[i].rate);
      assert.deepEqual(gone[i].excluded, before[i].excluded);
    }
    assert.deepEqual(gone[1].excluded, { contaminated: 0, undecided: 0 });
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('an undecided result stores nothing', async () => {
  const w = world([
    { id: 'off-0', arm: 'e1/off', code: null }, { id: 'on-0', arm: 'e1/on', code: null },
  ]);
  try {
    const rows = await report(w);
    assert.equal(rows[0].n, 0);
    assert.deepEqual(rows[0].excluded, { contaminated: 0, undecided: 1 });
    assert.equal(readFileSync(w.file, 'utf8'), '');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
