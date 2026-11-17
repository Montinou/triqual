import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { main } from '../cli/eval-plan-review.mjs';
import { plannerUsd } from '../cli/lib/eval-plans.mjs';
import { recordKey, validateRecord } from '../cli/lib/role-eval.mjs';

const SENTINEL = 'zz-planner-transcript-sentinel';

// One assistant turn line with token usage, as Claude Code writes it.
const turn = ({ id, req = `r-${id}`, at = '2026-11-10T10:00:00Z', model = 'claude-opus-5-5', input = 0, output = 0, read = 0, write = 0, write1h = 0 }) => JSON.stringify({
  type: 'assistant',
  requestId: req,
  timestamp: at,
  cwd: '/home/x/proj',
  message: {
    id,
    model,
    role: 'assistant',
    content: [{ type: 'text', text: SENTINEL }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h },
    },
  },
});

const defaultLanesReport = (over = {}) => ({
  plan: '2026-01-01-x',
  tasks: 8,
  phases: 2,
  parallelism: 2,
  criticalPath: 4,
  runnerOnly: 1,
  landingTest: false,
  violations: [],
  phaseRows: [],
  ...over,
});

function fixture({ lanesExit = 0, lanesReport = defaultLanesReport() } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-evplanrev-')));
  const home = join(base, 'home');
  const root = join(base, 'projects');
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  const storeFile = join(base, 'store', 'comparisons.jsonl');
  for (const d of [home, root, repo, bin]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });

  const stdoutText = lanesReport === null ? '' : `${JSON.stringify(lanesReport)}\n`;
  const stderrText = lanesExit === 2 ? 'not a plan\n' : '';
  const stateFile = join(base, 'lanes-state.json');
  writeFileSync(stateFile, JSON.stringify({ status: lanesExit, stdout: stdoutText, stderr: stderrText }));

  // A fake `triqual` on PATH in case the implementation spawns `triqual plan lanes <plan> --json` directly.
  const wrapper = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const s = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (s.stdout) process.stdout.write(s.stdout);
if (s.stderr) process.stderr.write(s.stderr);
process.exit(s.status);
`;
  writeFileSync(join(bin, 'triqual'), wrapper, { mode: 0o755 });

  const lanesCalls = [];
  const lanes = (plan) => {
    lanesCalls.push(plan);
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    return { status: s.status, code: s.status, stdout: s.stdout, stderr: s.stderr, ...(lanesReport ?? {}) };
  };

  const env = {
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    TRIQUAL_TRANSCRIPTS_DIR: root,
    TRIQUAL_EVALS_DIR: join(base, 'evals'),
    ROLE_EVAL_FILE: storeFile,
  };
  return {
    base,
    home,
    root,
    repo,
    storeFile,
    env,
    lanes,
    lanesCalls,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function run(f, argv, extraDeps = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: f.env,
    cwd: f.repo,
    lanes: f.lanes,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ...extraDeps,
  });
  return { code, out, err };
}

const readStore = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function writeSubagent(root, name, meta, lines) {
  const dir = join(root, '-home-x-proj', 'sess-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), `${lines.join('\n')}\n`);
  if (meta !== null) writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta));
}

test('records a plan-review from lanes and audit counts', async () => {
  const f = fixture({
    lanesExit: 0,
    lanesReport: defaultLanesReport({ plan: '2026-01-01-x', tasks: 8, phases: 2, parallelism: 2, runnerOnly: 1 }),
  });
  try {
    // claude-opus-5-5: input $4/M, output $20/M -> 100k * 4 + 10k * 20 = $0.60
    writeSubagent(
      f.root,
      'agent-planner',
      { agentType: 'roles:planner', description: 'planner 2026-01-01-x.md' },
      [turn({ id: 'm1', input: 100_000, output: 10_000 })],
    );
    const r = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,2,1', '--arm', 'planner-exp/arm-a']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'recorded');
    assert.equal(statSync(f.storeFile).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(f.storeFile)).mode & 0o777, 0o700);

    const rows = readStore(f.storeFile);
    assert.equal(rows.length, 1);
    const [stored] = rows;
    const { key, ...record } = stored;
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.equal(stored.v, 2);
    assert.equal(stored.kind, 'plan-review');
    assert.equal(stored.plan, '2026-01-01-x');
    assert.equal(stored.arm, 'planner-exp/arm-a');
    assert.equal(stored.tasks, 8);
    assert.equal(stored.phases, 2);
    assert.equal(stored.parallelism, 2);
    assert.equal(stored.runnerOnly, 1);
    assert.deepEqual(stored.auditFindings, { critical: 0, important: 2, minor: 1 });
    assert.ok(typeof stored.plannerUsd === 'number' && Math.abs(stored.plannerUsd - 0.6) < 1e-9, `plannerUsd=${stored.plannerUsd}`);
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.match(key, /^[0-9a-f]{64}$/);
    const commonDir = realpathSync(join(f.repo, '.git'));
    const validKeys = [
      recordKey({ commonDir, plan: '2026-01-01-x.md', kind: 'plan-review' }),
      recordKey({ commonDir, plan: '2026-01-01-x', kind: 'plan-review' }),
    ];
    assert.ok(validKeys.includes(key), `unexpected key ${key}`);
    assert.ok(!(r.out + r.err).includes(SENTINEL));
  } finally {
    f.cleanup();
  }
});

test('a layout with violations (lanes exit 1) is still recorded from its report', async () => {
  const f = fixture({
    lanesExit: 1,
    lanesReport: defaultLanesReport({
      plan: '2026-01-01-viol',
      tasks: 6,
      phases: 2,
      parallelism: 1.5,
      criticalPath: 4,
      runnerOnly: 2,
      violations: [{ code: 'no-lanes', phase: 1, task: null, message: 'P1 has 3 tasks without a **Lane:** line' }],
    }),
  });
  try {
    const r = await run(f, ['--plan', 'docs/plans/2026-01-01-viol.md', '--audit', '1,0,3']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'recorded');
    const [stored] = readStore(f.storeFile);
    const { key, ...record } = stored;
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.equal(stored.plan, '2026-01-01-viol');
    assert.equal(stored.arm, null);
    assert.equal(stored.tasks, 6);
    assert.equal(stored.phases, 2);
    assert.equal(stored.parallelism, 1.5);
    assert.equal(stored.runnerOnly, 2);
    assert.deepEqual(stored.auditFindings, { critical: 1, important: 0, minor: 3 });
    assert.equal(stored.plannerUsd, null);
    assert.match(key, /^[0-9a-f]{64}$/);
  } finally {
    f.cleanup();
  }
});

test('a lanes exit 2 exits 2 and records nothing', async () => {
  const f = fixture({ lanesExit: 2, lanesReport: null });
  try {
    const r = await run(f, ['--plan', 'docs/plans/not-a-plan.md', '--audit', '0,0,0']);
    assert.equal(r.code, 2);
    assert.equal(existsSync(f.storeFile), false);
  } finally {
    f.cleanup();
  }
});

test('a second run prints already recorded', async () => {
  const f = fixture({
    lanesExit: 0,
    lanesReport: defaultLanesReport({ plan: '2026-01-01-x', tasks: 4, phases: 1, parallelism: 2, runnerOnly: 0 }),
  });
  try {
    const first = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,1,0']);
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out.trim(), 'recorded');

    const second = await run(f, ['--plan', 'elsewhere/2026-01-01-x.md', '--audit', '3,3,3']);
    assert.equal(second.code, 0, second.err);
    assert.equal(second.out.trim(), 'already recorded');

    const rows = readStore(f.storeFile);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].auditFindings, { critical: 0, important: 1, minor: 0 });
  } finally {
    f.cleanup();
  }
});

test('plannerUsd sums the planner subagent\'s transcript', () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-planusd-'));
  try {
    // claude-opus-5-5 prices: input 4, output 20, cacheRead 0.2, cacheWrite5m 5, cacheWrite1h 8 (per 1M tokens)
    // m1: (100_000 * 4 + 10_000 * 20 + 500_000 * 0.2 + 20_000 * 5) / 1e6 = 0.80
    // m2: (50_000 * 4 + 5_000 * 20) / 1e6 = 0.30
    // total for planner 2026-01-01-x.md = 1.10
    writeSubagent(
      base,
      'agent-p1',
      { agentType: 'roles:planner', description: 'planner 2026-01-01-x.md' },
      [
        turn({ id: 'm1', req: 'r1', input: 100_000, output: 10_000, read: 500_000, write: 20_000 }),
        turn({ id: 'm1', req: 'r1', input: 100_000, output: 10_000, read: 500_000, write: 20_000 }), // duplicate content block
        turn({ id: 'm2', req: 'r2', input: 50_000, output: 5_000 }),
      ],
    );
    // Decoys that must not be summed into 2026-01-01-x.md:
    writeSubagent(
      base,
      'agent-other-plan',
      { agentType: 'roles:planner', description: 'planner 2026-01-01-other.md' },
      [turn({ id: 'm3', input: 1_000_000, output: 100_000 })],
    );
    writeSubagent(
      base,
      'agent-hunter',
      { agentType: 'roles:hunter', description: 'hunter T1' },
      [turn({ id: 'm4', input: 1_000_000, output: 100_000 })],
    );
    writeFileSync(join(base, '-home-x-proj', 'sess-1.jsonl'), `${turn({ id: 'm5', input: 1_000_000, output: 100_000 })}\n`);

    const usd = plannerUsd(base, '2026-01-01-x.md');
    assert.equal(typeof usd, 'number');
    assert.ok(Math.abs(usd - 1.1) < 1e-9, `expected 1.1, got ${usd}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('no planner transcript gives plannerUsd null', () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-planusd-null-'));
  try {
    assert.equal(plannerUsd(join(base, 'nonexistent'), '2026-01-01-x.md'), null);
    writeSubagent(
      base,
      'agent-other',
      { agentType: 'roles:planner', description: 'planner 2026-01-01-other.md' },
      [turn({ id: 'm1', input: 100_000, output: 10_000 })],
    );
    writeSubagent(base, 'agent-nometa', null, [turn({ id: 'm2', input: 100_000, output: 10_000 })]);
    assert.equal(plannerUsd(base, '2026-01-01-x.md'), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--audit 1,2 exits 2', async () => {
  const f = fixture();
  try {
    for (const argv of [
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '1,2'],
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '1,2,3,4'],
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '1,2,x'],
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '-1,0,0'],
      ['--plan', 'docs/plans/2026-01-01-x.md'],
      ['--audit', '0,0,0'],
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0', '--arm', 'BadArm'],
      ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0', '--bogus'],
    ]) {
      const r = await run(f, argv);
      assert.equal(r.code, 2, `${argv.join(' ')}: code=${r.code} err=${r.err}`);
    }
    assert.equal(existsSync(f.storeFile), false);
    const help = await run(f, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /plan-review/);
  } finally {
    f.cleanup();
  }
});

test('a store failure exits 1', async () => {
  const f = fixture();
  try {
    // Make the parent of ROLE_EVAL_FILE a regular file so creating the store directory fails.
    writeFileSync(dirname(f.storeFile), 'not a directory');
    const r = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0']);
    assert.equal(r.code, 1);
  } finally {
    f.cleanup();
  }
});

test('a lanes report that is not JSON exits 2 and records nothing', async () => {
  const f = fixture();
  try {
    const bad = (plan) => ({ status: 0, code: 0, stdout: 'not json at all\n', stderr: '', plan });
    const r = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0'], { lanes: bad });
    assert.equal(r.code, 2);
    assert.equal(existsSync(f.storeFile), false);
    const noSpawn = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0'], { lanes: () => ({ status: null, stdout: '', stderr: '' }) });
    assert.equal(noSpawn.code, 2);
    assert.equal(existsSync(f.storeFile), false);
  } finally {
    f.cleanup();
  }
});

test('a report the record rejects exits 2 and records nothing', async () => {
  const f = fixture({ lanesReport: defaultLanesReport({ tasks: -1 }) });
  try {
    const r = await run(f, ['--plan', 'docs/plans/2026-01-01-x.md', '--audit', '0,0,0']);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid record: field tasks/);
    assert.equal(existsSync(f.storeFile), false);
  } finally {
    f.cleanup();
  }
});
