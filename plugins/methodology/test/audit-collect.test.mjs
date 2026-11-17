import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'skills', 'auditing-performance', 'scripts', 'collect.mjs');
const line = ({ id, model, output }) => JSON.stringify({
  timestamp: new Date().toISOString(), requestId: `r-${id}`,
  message: { id, model, usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

test('cost_by_role keeps every dollar: rows under $0.50 fold into one other row per period', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const session = join(home, 'transcripts', '-x-triqual', 's1');
  mkdirSync(join(session, 'subagents'), { recursive: true });
  // controller: 100k Opus 5.5 output tokens = $2.00; hunter: 1k Haiku 5.5 output tokens = $0.0005
  writeFileSync(`${session}.jsonl`, `${line({ id: 'c1', model: 'claude-opus-5-5', output: 100_000 })}\n`);
  writeFileSync(join(session, 'subagents', 'agent-h.jsonl'), `${line({ id: 'h1', model: 'claude-haiku-5-5', output: 1000 })}\n`);
  writeFileSync(join(session, 'subagents', 'agent-h.meta.json'), JSON.stringify({ agentType: 'roles:hunter' }));
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], { env: { ...process.env, HOME: home, TRIQUAL_TRANSCRIPTS_DIR: join(home, 'transcripts') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(readFileSync(join(out, 'cost_by_role.json'), 'utf8'));
  const other = rows.find((x) => x.role === 'other (<$0.50)');
  assert.ok(other, 'the sub-$0.50 hunter row is kept as other');
  assert.equal(other.runs, 1);
  assert.equal(rows.find((x) => x.role === 'controller').usd, 2);
  assert.ok(rows.every((x) => x.period === 'late'));
});

test('escapes: final-review escapes per window and tier, over the tasks reviewed at that tier', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const store = join(home, 'comparisons.jsonl');
  const review = (tier) => JSON.stringify({ v: 2, at: now, kind: 'task-review', tier, declaredTier: tier, fixRounds: 0 });
  writeFileSync(store, [
    review('light'), review('light'), review('heavy'),
    JSON.stringify({ v: 2, at: now, kind: 'final-escapes', escapes: [{ tier: 'light', severity: 'important' }, { tier: 'light', severity: 'minor' }, { tier: 'light', severity: 'critical' }] }),
  ].join('\n'));
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], { env: { ...process.env, HOME: home, ROLE_EVAL_FILE: store, TRIQUAL_TRANSCRIPTS_DIR: join(home, 'none') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(readFileSync(join(out, 'escapes.json'), 'utf8'));
  const light = rows.find((x) => x.period === 'late' && x.tier === 'light');
  assert.deepEqual(light, { period: 'late', tier: 'light', tasks: 2, escapes: 3, important: 2, escapes_per_task: 1.5, important_per_task: 1 });
  assert.deepEqual(rows.find((x) => x.period === 'late' && x.tier === 'heavy'), { period: 'late', tier: 'heavy', tasks: 1, escapes: 0, important: 0, escapes_per_task: 0, important_per_task: 0 });
});

// Two sessions of experiment e1, one per arm, in invented transcripts; `preStore` also writes them into sessions.jsonl.
const evalFixture = ({ preStore }) => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const today = now.slice(0, 10);
  const transcripts = join(home, 'transcripts');
  const projDir = join(transcripts, '-x-triqual');
  mkdirSync(projDir, { recursive: true });

  const turn = (id, at) => [
    JSON.stringify({ type: 'user', cwd: '/home/x/Client', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: 'invented prompt' } }),
    JSON.stringify({
      type: 'assistant', timestamp: at, requestId: `r-${id}`,
      message: {
        id, model: 'claude-opus-5-5', role: 'assistant',
        usage: { input_tokens: 25_000, output_tokens: 95_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  ].join('\n') + '\n';

  writeFileSync(join(projDir, 's1.jsonl'), turn('m1', now));
  writeFileSync(join(projDir, 's2.jsonl'), turn('m2', now));
  writeFileSync(join(projDir, 's-old.jsonl'), turn('m0', '2020-01-01T00:00:00Z'));

  const evals = join(home, 'evals');
  const snapDir = join(evals, 'snapshots', 'snap-1');
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, 'taxonomy.json'), JSON.stringify({
    categories: [{ id: 'owner-chased-progress', check: 'code' }],
    judgeExclude: [],
  }));
  writeFileSync(
    join(snapDir, 'eval-checks.mjs'),
    "export const CHECKS = { 'owner-chased-progress': () => 'pass' }; export const runCheck = (id, s, f, c = CHECKS) => c[id](s, f);\n",
  );
  writeFileSync(join(evals, 'session-arms.jsonl'), [
    JSON.stringify({ sessionId: 's1', source: 'startup', arm: 'e1/off', launchId: null, at: now }),
    JSON.stringify({ sessionId: 's2', source: 'startup', arm: 'e1/on', launchId: null, at: now }),
  ].join('\n') + '\n');
  const storedSession = (sessionId, arm) => JSON.stringify({
    sessionId, project: '/home/x/Client', projectDir: '-x-triqual', entrypoint: 'cli', start: now, end: now,
    models: { 'claude-opus-5-5': { messages: 1, usd: 2 } },
    days: { [today]: { 'claude-opus-5-5': { messages: 1, usd: 2 } } },
    usd: 2, turns: 1, ctxPeak: 25_000, ctxAvg: 25_000, compactions: 0, idleRewrites: 0, rewriteUsd: 0,
    stopHookBlocks: 0, toolErrors: 0, userMessages: 1, unpriced: [], arm, contaminated: false, methodologyVersion: null,
  });
  if (preStore) writeFileSync(join(evals, 'sessions.jsonl'), `${storedSession('s1', 'e1/off')}\n${storedSession('s2', 'e1/on')}\n`);

  const experiments = join(home, 'experiments.json');
  writeFileSync(experiments, JSON.stringify({
    experiments: [{
      id: 'e1', kind: 'session', status: 'active', start: today, control: 'off',
      arms: { off: { model: 'claude-opus-5-5' }, on: { model: 'claude-opus-5-5' } },
      margin: 0.1, objective: 'cost', evaluators: 'snap-1',
    }],
  }));

  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], {
    env: {
      ...process.env,
      HOME: home,
      TRIQUAL_TRANSCRIPTS_DIR: transcripts,
      TRIQUAL_EVALS_DIR: evals,
      TRIQUAL_EXPERIMENTS_FILE: experiments,
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return { out, now };
};

test('collector writes eval_report and eval_sessions', () => {
  const { out, now } = evalFixture({ preStore: true });

  const reportRows = JSON.parse(readFileSync(join(out, 'eval_report.json'), 'utf8'));
  assert.equal(reportRows.length, 2);
  assert.deepEqual(reportRows.map((x) => x.arm), ['off', 'on']);
  for (const row of reportRows) {
    assert.equal(row.experiment, 'e1');
    for (const k of ['experiment', 'arm', 'control', 'n', 'excluded', 'rate', 'rateCI', 'costMedian', 'costCI', 'perProject', 'models', 'd', 'dCI', 'c', 'cCI', 'required', 'verdict']) {
      assert.ok(Object.hasOwn(row, k), `missing key ${k} on eval_report row`);
    }
  }
  assert.equal(reportRows[0].control, true);
  assert.equal(reportRows[0].n, 1);
  assert.equal(reportRows[0].rate, 1);
  assert.equal(reportRows[0].costMedian, 2);
  assert.equal(reportRows[0].verdict, null);
  assert.equal(reportRows[1].control, false);
  assert.equal(reportRows[1].n, 1);
  assert.equal(reportRows[1].rate, 1);
  assert.equal(reportRows[1].costMedian, 2);
  assert.equal(reportRows[1].verdict, 'insufficient data');

  const sessionRows = JSON.parse(readFileSync(join(out, 'eval_sessions.json'), 'utf8'));
  assert.equal(sessionRows.length, 2);
  const expectedKeys = ['arm', 'compactions', 'contaminated', 'ctxPeak', 'idleRewrites', 'project', 'sessionId', 'start', 'stopHookBlocks', 'turns', 'usd'];
  for (const row of sessionRows) {
    assert.deepEqual(Object.keys(row).sort(), expectedKeys);
  }
  assert.deepEqual(sessionRows, [
    {
      sessionId: 's1', project: '/home/x/Client', start: now, usd: 2, turns: 1,
      ctxPeak: 25_000, compactions: 0, idleRewrites: 0, stopHookBlocks: 0, arm: 'e1/off', contaminated: false,
    },
    {
      sessionId: 's2', project: '/home/x/Client', start: now, usd: 2, turns: 1,
      ctxPeak: 25_000, compactions: 0, idleRewrites: 0, stopHookBlocks: 0, arm: 'e1/on', contaminated: false,
    },
  ]);
});

test('eval_report counts the sessions of a store that was empty: the collector refreshes the store before it scores', () => {
  const { out } = evalFixture({ preStore: false });
  const reportRows = JSON.parse(readFileSync(join(out, 'eval_report.json'), 'utf8'));
  assert.deepEqual(reportRows.map((x) => [x.arm, x.n]), [['off', 1], ['on', 1]]);
  const sessionRows = JSON.parse(readFileSync(join(out, 'eval_sessions.json'), 'utf8'));
  assert.deepEqual(sessionRows.map((x) => x.sessionId), ['s1', 's2']);
});

test('skill text names the eval step', () => {
  const skillPath = join(import.meta.dirname, '..', 'skills', 'auditing-performance', 'SKILL.md');
  const flat = readFileSync(skillPath, 'utf8').replace(/\s*\n\s*/g, ' ');
  assert.ok(flat.includes('triqual eval report --json'), 'SKILL.md must name triqual eval report --json');
  assert.ok(flat.includes('triqual eval sessions --json'), 'SKILL.md must name triqual eval sessions --json');
  assert.ok(flat.includes('a section per active experiment'), 'SKILL.md must require a section per active experiment');
});

test('an experiments file the report refuses leaves empty eval datasets and a warning, and the collector still finishes', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const experiments = join(home, 'experiments.json');
  writeFileSync(experiments, '{ not json');
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], {
    env: {
      ...process.env,
      HOME: home,
      TRIQUAL_TRANSCRIPTS_DIR: join(home, 'none'),
      TRIQUAL_EVALS_DIR: join(home, 'evals'),
      TRIQUAL_EXPERIMENTS_FILE: experiments,
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /eval_report: .*exited 2/);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'eval_report.json'), 'utf8')), []);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'eval_sessions.json'), 'utf8')), []);
});

// Subagent transcripts under a temp transcripts dir; each spec is { project, name, at, description, model, input, output }.
const subagentFixture = (specs, { days = 1, extraEnv = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  for (const s of specs) {
    const dir = join(home, 'transcripts', s.project, 's1', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${s.name}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: s.at, requestId: `r-${s.name}`,
      message: { id: `m-${s.name}`, role: 'assistant', model: s.model, usage: { input_tokens: s.input ?? 0, output_tokens: s.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    })}\n`);
    writeFileSync(join(dir, `agent-${s.name}.meta.json`), JSON.stringify({ agentType: s.agentType, description: s.description }));
  }
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', String(days)], {
    env: { ...process.env, HOME: home, ROLE_EVAL_FILE: join(home, 'none.jsonl'), TRIQUAL_TRANSCRIPTS_DIR: join(home, 'transcripts'), ...extraEnv },
    encoding: 'utf8',
  });
  return { home, out, r, rows: () => JSON.parse(readFileSync(join(out, 'cost_per_task.json'), 'utf8')) };
};

test('collector writes cost_per_task joined by description', () => {
  const now = new Date().toISOString();
  // Opus 5.5 lists at $4/M input and $20/M output. T3 tdd-implementer: 50k in + 75k out = $0.20 + $1.50 = $1.70;
  // T3 spec-reviewer: 25k out = $0.50; the unrelated subagent has no task in its description.
  const { r, rows } = subagentFixture([
    { project: '-x-triqual', name: 'impl', at: now, model: 'claude-opus-5-5', input: 50_000, output: 75_000, agentType: 'roles:tdd-implementer', description: 'T3 tdd-implementer' },
    { project: '-x-triqual', name: 'spec', at: now, model: 'claude-opus-5-5', output: 25_000, agentType: 'roles:spec-reviewer', description: 'T3 spec-reviewer' },
    { project: '-x-triqual', name: 'other', at: now, model: 'claude-haiku-5-5', output: 10_000, agentType: 'roles:hunter', description: 'unrelated search' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(), [
    { window: 'late', project: '-x-triqual', task: 'T3', role: 'spec-reviewer', runs: 1, usd: 0.5 },
    { window: 'late', project: '-x-triqual', task: 'T3', role: 'tdd-implementer', runs: 1, usd: 1.7 },
  ]);
});

test('cost_per_task sums the runs of a task and role per window, in the projects the collector reads only', () => {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 864e5).toISOString();
  const old = '2020-01-01T00:00:00.000Z';
  const base = { model: 'claude-opus-5-5', agentType: 'roles:tdd-implementer', description: 'T7 tdd-implementer' };
  const { r, rows } = subagentFixture([
    { ...base, project: '-x-triqual', name: 'a', at: now, output: 10_000 },
    { ...base, project: '-x-triqual', name: 'b', at: now, output: 15_000 },
    { ...base, project: '-x-triqual', name: 'c', at: yesterday, output: 5_000 },
    { ...base, project: '-x-triqual', name: 'd', at: old, output: 99_000 },
    { ...base, project: '-x-elsewhere', name: 'e', at: now, output: 99_000 },
  ]);
  assert.equal(r.status, 0, r.stderr);
  // late: 25k out = $0.50 over 2 runs; early: 5k out = $0.10; the 2020 run and the other project are left out
  assert.deepEqual(rows(), [
    { window: 'early', project: '-x-triqual', task: 'T7', role: 'tdd-implementer', runs: 1, usd: 0.1 },
    { window: 'late', project: '-x-triqual', task: 'T7', role: 'tdd-implementer', runs: 2, usd: 0.5 },
  ]);
});

test('cost_per_task is an empty dataset, and nothing on stderr, when there are no transcripts', () => {
  const { r, rows } = subagentFixture([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(), []);
  assert.equal(r.stderr, '');
});
