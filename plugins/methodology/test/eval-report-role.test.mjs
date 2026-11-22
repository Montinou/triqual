// Task 32: the rows of a role experiment in `triqual eval report` (task rows from clean tasks and task cost, planner rows
// with cleanTaskRate and wallClockHours), through the real command with injected env and the helpers of lib/eval-tasks.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-report.mjs';
import { recordKey } from '../cli/lib/role-eval.mjs';
import { cleanTask, subagentTaskCosts, taskCost } from '../cli/lib/eval-tasks.mjs';

const COMMON_DIR = '/home/x/Client/.git';
const PROJECT_CWD = '/home/x/Client';
const PROJECT_DIR = '-home-x-Client';
const OTHER_DIR = '-home-x-Other';
// A plan file name as `role-eval record --plan` and `eval arm --plan` carry it, and the plan name `plan-review` and
// `triqual tasks export` carry (no `.md`).
const PLAN_A = '2026-11-17-alpha.md';
const PLAN_A_BASE = '2026-11-17-alpha';
const PLAN_B = '2026-11-17-beta.md';
const PLAN_B_BASE = '2026-11-17-beta';

const roleExperiment = (over = {}) => ({
  id: 'r1',
  kind: 'role',
  status: 'active',
  start: '2026-11-01',
  control: 'off',
  arms: {
    off: { role: 'tdd-implementer', model: 'claude-opus-5-5', effort: 'medium' },
    on: { role: 'tdd-implementer', model: 'claude-sonnet-5-5', effort: 'medium' },
  },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'objective',
  ...over,
});

const plannerExperiment = (over = {}) => ({
  id: 'exp-plan',
  kind: 'role',
  status: 'active',
  start: '2026-11-01',
  control: 'off',
  arms: {
    off: { role: 'planner', model: 'claude-opus-5-5', effort: 'medium' },
    on: { role: 'planner', model: 'claude-sonnet-5-5', effort: 'high' },
  },
  margin: 0.1,
  objective: 'parallelism',
  evaluators: 'plan-review',
  ...over,
});

function withKey(record) {
  const key = recordKey({
    commonDir: COMMON_DIR,
    plan: record.plan ?? PLAN_A,
    task: record.task,
    kind: record.kind,
    attempt: record.attempt,
    ref: record.ref,
  });
  return { ...record, key };
}

const taskReview = (over = {}) => withKey({
  v: 2,
  at: '2026-11-17T10:20:00Z',
  provider: 'claude',
  plan: PLAN_A,
  task: 'T1',
  kind: 'task-review',
  attempt: 1,
  tier: 'standard',
  declaredTier: 'standard',
  raised: false,
  hunters: [],
  gate: { findings: 0 },
  spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0 } },
  fixRounds: 0,
  blocked: false,
  coordinator: false,
  ...over,
});

const finalEscapes = (escapes, over = {}) => withKey({
  v: 2,
  at: '2026-11-17T11:50:00Z',
  provider: 'claude',
  plan: PLAN_A,
  task: 'final',
  kind: 'final-escapes',
  escapes,
  ...over,
});

const postMergeEscape = (over = {}) => withKey({
  v: 2,
  at: '2026-11-17T12:30:00Z',
  kind: 'escape',
  plan: PLAN_A,
  source: 'post-merge-fix',
  ref: '#42',
  task: 'T1',
  tier: 'standard',
  ...over,
});

const planReview = (over = {}) => withKey({
  v: 2,
  at: '2026-11-17T09:50:00Z',
  kind: 'plan-review',
  plan: PLAN_A_BASE,
  arm: 'exp-plan/off',
  tasks: 2,
  phases: 1,
  parallelism: 1.5,
  runnerOnly: 0,
  auditFindings: { critical: 0, important: 0, minor: 0 },
  plannerUsd: 0.4,
  ...over,
});

// A line of <evals>/role-assignments.jsonl as `triqual eval arm` writes it.
const assignmentRow = (over = {}) => {
  const row = {
    key: `${PLAN_A}/T1`,
    plan: PLAN_A,
    task: 'T1',
    role: 'tdd-implementer',
    experiment: 'r1',
    arm: 'off',
    model: 'claude-opus-5-5',
    effort: 'medium',
    cwd: PROJECT_CWD,
    at: '2026-11-17T10:00:00.000Z',
    ...over,
  };
  return row;
};

const assistantLine = ({ id, at, model = 'claude-sonnet-5-5', input = 0, output = 0 }) => JSON.stringify({
  type: 'assistant',
  requestId: `r-${id}`,
  timestamp: at,
  cwd: PROJECT_CWD,
  message: {
    id,
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'invented subagent output' }],
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

// A subagent transcript with its sibling .meta.json (description and agentType), as Claude Code writes them.
function writeSubagent(transcriptsRoot, {
  projectDir = PROJECT_DIR, sessionId = 'sess-1', agentId, description, agentType = 'roles:tdd-implementer', lines,
}) {
  const dir = join(transcriptsRoot, projectDir, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), `${lines.join('\n')}\n`);
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ description, agentType }));
}

// A `triqual` on PATH that answers `tasks export --json --all` with `snapshots` and nothing else.
function fakeTriqualBin(base, snapshots) {
  const bin = join(base, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] === "tasks" && args[1] === "export" && args.includes("--all")) {',
    `  process.stdout.write(${JSON.stringify(JSON.stringify(snapshots))});`,
    '  process.exit(0);',
    '}',
    'process.exit(1);',
  ].join('\n');
  const file = join(bin, 'triqual');
  writeFileSync(file, `${script}\n`);
  chmodSync(file, 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

function world({
  experiments = [roleExperiment()], assignments = [], records = [], subagents = [], snapshots = [],
} = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cm-t32-'));
  const home = join(base, 'home');
  const evals = join(base, 'evals');
  const transcripts = join(base, 'transcripts');
  const roleEvalFile = join(base, 'role-eval', 'comparisons.jsonl');
  const experimentsFile = join(base, 'experiments.json');
  for (const dir of [home, evals, transcripts, join(base, 'role-eval')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(evals, 'role-assignments.jsonl'), assignments.map((a) => `${JSON.stringify(a)}\n`).join(''));
  writeFileSync(roleEvalFile, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(experimentsFile, JSON.stringify({ experiments }, null, 2));
  for (const sub of subagents) writeSubagent(transcripts, sub);
  const env = {
    HOME: home,
    PATH: fakeTriqualBin(base, snapshots),
    TRIQUAL_EVALS_DIR: evals,
    TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
    TRIQUAL_TRANSCRIPTS_DIR: transcripts,
    ROLE_EVAL_FILE: roleEvalFile,
  };
  return { base, env, transcripts };
}

async function runReport(argv, env) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    platform: 'linux',
  });
  return { code, out, err };
}

async function rowsOf(w, id) {
  const { code, out, err } = await runReport(['--json'], w.env);
  assert.equal(code, 0, err);
  return JSON.parse(out).experiments.find((e) => e.id === id).rows;
}

const implementer = (agentId, at, output, model, over = {}) => ({
  agentId,
  description: `${over.task ?? 'T1'} tdd-implementer`,
  lines: [assistantLine({ id: agentId, at, model, output })],
  ...over,
});

// ---- cleanTask ----------------------------------------------------------------------------------------------------

test('a reopened task is not clean', () => {
  const records = [
    taskReview({ task: 'T1', attempt: 1, at: '2026-11-17T10:20:00Z' }),
    taskReview({ task: 'T1', attempt: 2, at: '2026-11-17T10:40:00Z' }),
    taskReview({ task: 'T2', attempt: 1, at: '2026-11-17T10:50:00Z' }),
  ];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, records), false);
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T2' }, records), true);
});

test('an important final escape traced to the task is not clean', () => {
  const reviews = [taskReview({ task: 'T1' }), taskReview({ task: 'T2' })];
  const important = [...reviews, finalEscapes([{ tier: 'standard', severity: 'important', task: 'T1', category: 'state', summary: 'x' }])];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, important), false);
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T2' }, important), true);

  const critical = [...reviews, finalEscapes([{ tier: 'standard', severity: 'critical', task: 'T1' }])];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, critical), false);

  // A post-merge escape that names the plan and the task counts as important.
  const postMerge = [...reviews, postMergeEscape({ task: 'T1' })];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, postMerge), false);
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T2' }, postMerge), true);

  // Another plan's escapes, and an escape with no task, trace to nothing here.
  const elsewhere = [
    ...reviews,
    finalEscapes([{ tier: 'standard', severity: 'critical', task: 'T1' }], { plan: PLAN_B }),
    finalEscapes([{ tier: 'standard', severity: 'critical' }], { plan: PLAN_A, task: 'P1' }),
    postMergeEscape({ plan: PLAN_B, task: 'T1', ref: '#43' }),
  ];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, elsewhere), true);
});

test('a minor one is clean', () => {
  const records = [
    taskReview({ task: 'T1' }),
    finalEscapes([{ tier: 'standard', severity: 'minor', task: 'T1', category: 'spec-drift', summary: 'naming' }]),
  ];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, records), true);
});

test('a task with no review yet is undecided', () => {
  const records = [taskReview({ task: 'T1' })];
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T2' }, records), null);
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, []), null);
  // An escape alone does not make a review.
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T2' }, [postMergeEscape({ task: 'T2' })]), null);
});

test('the plan joins with or without .md on either side', () => {
  const records = [
    taskReview({ plan: PLAN_A, task: 'T1' }),
    finalEscapes([{ tier: 'standard', severity: 'important', task: 'T1' }], { plan: PLAN_A_BASE }),
  ];
  assert.equal(cleanTask({ plan: PLAN_A_BASE, task: 'T1' }, records), false);
  assert.equal(cleanTask({ plan: PLAN_A, task: 'T1' }, records), false);
  assert.equal(cleanTask({ plan: PLAN_A_BASE, task: 'T1' }, [taskReview({ plan: PLAN_A_BASE, task: 'T1' })]), true);
});

// ---- subagentTaskCosts and taskCost ----------------------------------------------------------------------------------

test('subagentTaskCosts reads only subagents described "T<N> <role>", grouped by project, task and role', () => {
  const w = world({
    subagents: [
      implementer('a', '2026-11-17T10:05:00Z', 100_000, 'claude-opus-5-5'),
      implementer('b', '2026-11-17T10:30:00Z', 25_000, 'claude-opus-5-5'),
      implementer('c', '2026-11-17T10:35:00Z', 50_000, 'claude-sonnet-5-5', { task: 'T2' }),
      implementer('d', '2026-11-17T10:36:00Z', 10_000, 'claude-sonnet-5-5', { task: 'T2', description: 'T2 spec-reviewer' }),
      { agentId: 'e', description: 'Run phase P1', agentType: 'roles:phase-orchestrator', lines: [assistantLine({ id: 'e', at: '2026-11-17T10:10:00Z', output: 999_999 })] },
      { agentId: 'f', description: 'planner 2026-11-17-alpha.md', lines: [assistantLine({ id: 'f', at: '2026-11-17T10:11:00Z', output: 999_999 })] },
      { agentId: 'g', description: 'T3 two words', lines: [assistantLine({ id: 'g', at: '2026-11-17T10:12:00Z', output: 999_999 })] },
      implementer('h', '2026-11-17T10:06:00Z', 100_000, 'claude-opus-5-5', { projectDir: OTHER_DIR }),
    ],
  });
  try {
    const costs = subagentTaskCosts(w.transcripts, {});
    const key = (c) => `${c.project} ${c.task} ${c.role}`;
    assert.deepEqual(costs.map(key).sort(), [
      `${PROJECT_DIR} T1 tdd-implementer`,
      `${PROJECT_DIR} T2 spec-reviewer`,
      `${PROJECT_DIR} T2 tdd-implementer`,
      `${OTHER_DIR} T1 tdd-implementer`,
    ]);
    const t1 = costs.find((c) => c.project === PROJECT_DIR && c.task === 'T1');
    assert.deepEqual(t1, { project: PROJECT_DIR, task: 'T1', role: 'tdd-implementer', runs: 2, usd: 2.5, firstAt: '2026-11-17T10:05:00Z' });
    assert.equal(costs.find((c) => c.task === 'T2' && c.role === 'tdd-implementer').usd, 0.5);

    // The window cuts by the run's first timestamp, both ends included; `project` is the project directory name.
    assert.deepEqual(subagentTaskCosts(w.transcripts, { since: '2026-11-17T10:30:00Z', until: '2026-11-17T10:35:00Z' }).map(key).sort(),
      [`${PROJECT_DIR} T1 tdd-implementer`, `${PROJECT_DIR} T2 tdd-implementer`]);
    assert.equal(subagentTaskCosts(w.transcripts, { project: OTHER_DIR }).length, 1);
    assert.deepEqual(subagentTaskCosts(join(w.transcripts, 'missing'), {}), []);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('taskCost takes the rows of the assignment project and task from its time to the review', () => {
  const costs = [
    { project: PROJECT_DIR, task: 'T1', role: 'tdd-implementer', runs: 1, usd: 2, firstAt: '2026-11-17T10:05:00Z' },
    { project: PROJECT_DIR, task: 'T1', role: 'spec-reviewer', runs: 1, usd: 0.25, firstAt: '2026-11-17T10:10:00Z' },
    { project: PROJECT_DIR, task: 'T1', role: 'tdd-implementer', runs: 1, usd: 9, firstAt: '2026-11-17T09:00:00Z' },
    { project: PROJECT_DIR, task: 'T1', role: 'tdd-implementer', runs: 1, usd: 7, firstAt: '2026-11-17T11:00:00Z' },
    { project: OTHER_DIR, task: 'T1', role: 'tdd-implementer', runs: 1, usd: 5, firstAt: '2026-11-17T10:05:00Z' },
    { project: PROJECT_DIR, task: 'T2', role: 'tdd-implementer', runs: 1, usd: 3, firstAt: '2026-11-17T10:05:00Z' },
  ];
  const a = assignmentRow({ cwd: '/home/x/Client' });
  // The project directory is the cwd with every non-alphanumeric character replaced by "-".
  assert.equal(taskCost(a, costs, '2026-11-17T10:20:00.000Z'), 2.25);
  assert.equal(taskCost(a, costs), 9.25, 'with no review yet the window is open at the end');
  assert.equal(taskCost(assignmentRow({ cwd: '/home/x/Client.v2' }), costs, '2026-11-17T10:20:00.000Z'), null);
});

test('a task run from a worktree takes the cost of the subagents whose dispatch names its plan, in any project directory', async () => {
  // The controller's session (and so its subagent transcripts) lives under the main checkout's project directory, while
  // `eval arm` ran from the plan's worktree: the assignment cwd names another directory, in another letter case too.
  const userLine = (text) => JSON.stringify({ type: 'user', timestamp: '2026-11-17T10:04:00Z', message: { role: 'user', content: text } });
  const w = world({
    assignments: [assignmentRow({ task: 'T1', cwd: '/home/x/client-plan-e1', at: '2026-11-17T10:00:00.000Z' })],
    records: [taskReview({ task: 'T1', at: '2026-11-17T10:20:00Z' })],
    subagents: [
      implementer('named', '2026-11-17T10:05:00Z', 100_000, 'claude-opus-5-5', {
        lines: [userLine(`Brief: /home/x/client-plan-e1/.methodology/sdd/${PLAN_A_BASE}/task-1-brief.md`), assistantLine({ id: 'named', at: '2026-11-17T10:05:00Z', model: 'claude-opus-5-5', output: 100_000 })],
      }),
      // Same task id and window, another plan's dispatch: not this task's cost.
      implementer('other-plan', '2026-11-17T10:06:00Z', 450_000, 'claude-opus-5-5', {
        lines: [userLine(`Brief: /home/x/other/.methodology/sdd/${PLAN_B_BASE}/task-1-brief.md`), assistantLine({ id: 'other-plan', at: '2026-11-17T10:06:00Z', model: 'claude-opus-5-5', output: 450_000 })],
      }),
    ],
  });
  try {
    const rows = await rowsOf(w, 'r1');
    assert.deepEqual(rows.map((r) => [r.arm, r.n, r.costMedian]), [['off', 1, 2], ['on', 0, null]]);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

// ---- the command ----------------------------------------------------------------------------------------------------

test('fixture plan with an active experiment yields one task row per arm with cost per task', async () => {
  const w = world({
    assignments: [
      assignmentRow({ task: 'T1', key: `${PLAN_A}/T1`, arm: 'off', at: '2026-11-17T10:00:00.000Z' }),
      assignmentRow({ task: 'T2', key: `${PLAN_A}/T2`, arm: 'on', model: 'claude-sonnet-5-5', at: '2026-11-17T10:30:00.000Z' }),
      // Not units of this experiment: another experiment, a key-only assignment, one before the start, another role.
      assignmentRow({ task: 'T3', key: `${PLAN_A}/T3`, experiment: 'r2', arm: 'on' }),
      assignmentRow({ task: null, plan: null, key: 'free-key', arm: 'on' }),
      assignmentRow({ task: 'T4', key: `${PLAN_A}/T4`, arm: 'on', at: '2026-10-31T10:00:00.000Z' }),
      assignmentRow({ task: 'T5', key: `${PLAN_A}/T5`, arm: 'on', role: 'spec-reviewer' }),
    ],
    records: [
      taskReview({ task: 'T1', at: '2026-11-17T10:20:00Z' }),
      taskReview({ task: 'T2', at: '2026-11-17T10:50:00Z' }),
      taskReview({ task: 'T3', at: '2026-11-17T10:50:00Z' }),
      // The same task id in another plan, reviewed later: it does not move the end of this task's cost window.
      taskReview({ plan: PLAN_B, task: 'T1', at: '2026-11-17T12:00:00Z' }),
    ],
    subagents: [
      implementer('t1-early', '2026-11-17T09:00:00Z', 450_000, 'claude-opus-5-5'),
      implementer('t1-run', '2026-11-17T10:05:00Z', 100_000, 'claude-opus-5-5'),
      implementer('t1-late', '2026-11-17T11:00:00Z', 450_000, 'claude-opus-5-5'),
      implementer('t1-other', '2026-11-17T10:06:00Z', 450_000, 'claude-opus-5-5', { projectDir: OTHER_DIR }),
      implementer('t2-run', '2026-11-17T10:35:00Z', 50_000, 'claude-sonnet-5-5', { task: 'T2' }),
      { agentId: 'orch', description: 'Run phase P1 of the plan', lines: [assistantLine({ id: 'orch', at: '2026-11-17T10:10:00Z', output: 200_000 })] },
    ],
  });
  try {
    const rows = await rowsOf(w, 'r1');
    assert.deepEqual(rows.map((r) => [r.arm, r.control, r.n, r.rate, r.costMedian]), [
      ['off', true, 1, 1, 2],
      ['on', false, 1, 1, 0.5],
    ]);
    assert.deepEqual(rows.map((r) => r.excluded), [{ contaminated: 0, undecided: 0 }, { contaminated: 0, undecided: 0 }]);
    assert.deepEqual(rows.map((r) => r.models), [['claude-opus-5-5'], ['claude-sonnet-5-5']]);
    assert.equal(rows[1].c, -1.5);
    assert.equal(rows[1].verdict, 'insufficient data');
    assert.equal(rows[0].kind, 'role');
    assert.equal(rows[0].parallelismMedian, null);

    const { out } = await runReport([], w.env);
    assert.match(out, /off \(control\) {2}n 1/);
    assert.match(out, /on {2}n 1/);
    assert.doesNotMatch(out, /no rows/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a reopened task and an important escape count as unhealthy; a task still unreviewed is excluded as undecided', async () => {
  const w = world({
    assignments: [
      assignmentRow({ task: 'T1', key: `${PLAN_A}/T1`, arm: 'on', model: 'claude-sonnet-5-5', at: '2026-11-17T10:00:00.000Z' }),
      assignmentRow({ task: 'T2', key: `${PLAN_A}/T2`, arm: 'on', model: 'claude-sonnet-5-5', at: '2026-11-17T10:30:00.000Z' }),
      assignmentRow({ task: 'T3', key: `${PLAN_A}/T3`, arm: 'on', model: 'claude-sonnet-5-5', at: '2026-11-17T10:40:00.000Z' }),
      assignmentRow({ task: 'T4', key: `${PLAN_A}/T4`, arm: 'on', model: 'claude-sonnet-5-5', at: '2026-11-17T10:50:00.000Z' }),
    ],
    records: [
      taskReview({ task: 'T1', attempt: 1, at: '2026-11-17T10:20:00Z' }),
      taskReview({ task: 'T1', attempt: 2, at: '2026-11-17T10:28:00Z' }),
      taskReview({ task: 'T2', at: '2026-11-17T10:35:00Z' }),
      taskReview({ task: 'T3', at: '2026-11-17T10:45:00Z' }),
      finalEscapes([{ tier: 'standard', severity: 'important', task: 'T2' }, { tier: 'standard', severity: 'minor', task: 'T3' }]),
    ],
    subagents: [
      implementer('t1-a', '2026-11-17T10:05:00Z', 100_000, 'claude-sonnet-5-5'),
      implementer('t1-b', '2026-11-17T10:25:00Z', 20_000, 'claude-sonnet-5-5'),
    ],
  });
  try {
    const [off, on] = await rowsOf(w, 'r1');
    assert.equal(off.n, 0);
    assert.equal(off.rate, null);
    assert.equal(on.n, 3);
    assert.equal(on.rate, 1 / 3);
    assert.deepEqual(on.excluded, { contaminated: 0, undecided: 1 });
    // T1 cost 1.00 + 0.20 (both runs, up to its last review), T2 and T3 no subagent rows (no cost).
    assert.equal(on.costMedian, 1.2);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('an assignment is read by (key, role, experiment): the last line of a key wins, another experiment is ignored', async () => {
  const w = world({
    assignments: [
      assignmentRow({ task: 'T1', key: `${PLAN_A}/T1`, arm: 'on', model: 'claude-sonnet-5-5', experiment: 'r2' }),
      assignmentRow({ task: 'T1', key: `${PLAN_A}/T1`, arm: 'off', at: '2026-11-17T10:00:00.000Z' }),
      assignmentRow({ task: 'T1', key: `${PLAN_A}/T1`, arm: 'off', at: '2026-11-17T10:01:00.000Z' }),
    ],
    records: [taskReview({ task: 'T1' })],
  });
  try {
    const [off, on] = await rowsOf(w, 'r1');
    assert.equal(off.n, 1);
    assert.equal(on.n, 0);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('the rows of a role experiment follow whether it was started: none before, rows once started (paused or done); skill experiments stay without rows', async () => {
  const fixture = {
    assignments: [assignmentRow({ task: 'T1', key: `${PLAN_A}/T1` })],
    records: [taskReview({ task: 'T1' })],
  };
  let w = world({ ...fixture, experiments: [roleExperiment({ status: 'paused', evaluators: undefined })] });
  try { assert.deepEqual(await rowsOf(w, 'r1'), []); } finally { rmSync(w.base, { recursive: true, force: true }); }

  w = world({ ...fixture, experiments: [roleExperiment({ status: 'done' })] });
  try { assert.equal((await rowsOf(w, 'r1'))[0].n, 1); } finally { rmSync(w.base, { recursive: true, force: true }); }

  // A role experiment that was started and then paused (it has evaluators) still reports, as a session experiment does.
  w = world({ ...fixture, experiments: [roleExperiment({ status: 'paused' })] });
  try { assert.equal((await rowsOf(w, 'r1'))[0].n, 1); } finally { rmSync(w.base, { recursive: true, force: true }); }

  w = world({
    ...fixture,
    experiments: [roleExperiment({ id: 's1', kind: 'skill', arms: { off: { skill: 'x' }, on: { skill: 'x' } } })],
  });
  try { assert.deepEqual(await rowsOf(w, 's1'), []); } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('with no assignments file, no role-eval store and no transcripts the role rows are empty groups, not an error', async () => {
  const w = world({});
  try {
    rmSync(w.env.ROLE_EVAL_FILE);
    rmSync(join(w.env.TRIQUAL_EVALS_DIR, 'role-assignments.jsonl'));
    const rows = await rowsOf(w, 'r1');
    assert.deepEqual(rows.map((r) => [r.arm, r.n, r.rate]), [['off', 0, null], ['on', 0, null]]);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('plan rows show cleanTaskRate and wallClockHours', async () => {
  // alpha (control): T1 clean, T2 reopened -> 0.5; T1 closed 10:00Z, T2 closed 12:00Z -> 2 hours.
  // beta (arm): both clean -> 1; closed 13:00Z and 16:00Z -> 3 hours.
  const records = [
    planReview({ plan: PLAN_A_BASE, arm: 'exp-plan/off', parallelism: 1.5, plannerUsd: 0.4 }),
    taskReview({ plan: PLAN_A, task: 'T1', attempt: 1, at: '2026-11-17T11:00:00Z' }),
    taskReview({ plan: PLAN_A, task: 'T2', attempt: 1, at: '2026-11-17T11:30:00Z' }),
    taskReview({ plan: PLAN_A, task: 'T2', attempt: 2, at: '2026-11-17T12:00:00Z' }),
    planReview({ plan: PLAN_B_BASE, arm: 'exp-plan/on', parallelism: 2, plannerUsd: 0.2, at: '2026-11-17T12:50:00Z' }),
    taskReview({ plan: PLAN_B, task: 'T1', attempt: 1, at: '2026-11-17T14:00:00Z' }),
    taskReview({ plan: PLAN_B, task: 'T2', attempt: 1, at: '2026-11-17T16:00:00Z' }),
  ];
  const task = (id, at, status = 'done') => ({ id, title: 't', status, since: Date.parse(at), tier: 'standard', effectiveTier: 'standard', commits: [] });
  const snapshots = [{
    schema: 'claude-methodology/tracking-snapshot@1',
    repo: { name: 'Client', root: PROJECT_CWD, mode: 'store', branch: 'main' },
    plans: [
      { name: PLAN_A_BASE, state: 'done', done: 2, total: 2, tasks: [task('T1', '2026-11-17T10:00:00Z'), task('T2', '2026-11-17T12:00:00Z')] },
      { name: PLAN_B_BASE, state: 'done', done: 2, total: 2, tasks: [task('T1', '2026-11-17T13:00:00Z'), task('T2', '2026-11-17T16:00:00Z')] },
    ],
  }];
  const w = world({ experiments: [plannerExperiment()], records, snapshots });
  try {
    const [off, on] = await rowsOf(w, 'exp-plan');
    assert.deepEqual([off.arm, off.n, off.rate, off.costMedian], ['off', 1, 1, 0.4]);
    assert.deepEqual([on.arm, on.n, on.rate, on.costMedian], ['on', 1, 1, 0.2]);
    assert.deepEqual([off.cleanTaskRate, off.wallClockHours], [0.5, 2]);
    assert.deepEqual([on.cleanTaskRate, on.wallClockHours], [1, 3]);
    // The planner rows of T26 are wired in with their parallelism figures.
    assert.deepEqual([off.parallelismMedian, on.parallelismMedian, on.p], [1.5, 2, 0.5]);
    assert.equal(on.pCI.length, 2);
    assert.equal(on.verdict, 'insufficient data');

    const { out } = await runReport([], w.env);
    assert.match(out, /parallelism median 1\.5/);
    assert.match(out, /clean-task rate 50\.0% {2}wall-clock hours 2/);
    assert.match(out, /clean-task rate 100\.0% {2}wall-clock hours 3/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('plan rows without task reviews or a readable ledger keep null cleanTaskRate and wallClockHours', async () => {
  // The fake triqual fails (no snapshots exported is `[]`, so make the plan unknown to it), and no task was reviewed.
  const w = world({
    experiments: [plannerExperiment()],
    records: [planReview({ plan: PLAN_A_BASE, arm: 'exp-plan/off' })],
    snapshots: [],
  });
  try {
    const [off] = await rowsOf(w, 'exp-plan');
    assert.equal(off.n, 1);
    assert.equal(off.cleanTaskRate, null);
    assert.equal(off.wallClockHours, null);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
