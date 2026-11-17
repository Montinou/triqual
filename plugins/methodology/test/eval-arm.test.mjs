import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-arm.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { armFor } from '../cli/lib/eval-experiments.mjs';

const NOW = new Date('2026-11-17T12:00:00.000Z');

const roleExperiment = (id, role, over = {}) => ({
  id,
  kind: 'role',
  status: 'active',
  start: '2026-11-17',
  control: 'a',
  arms: {
    a: { role, model: 'claude-opus-4-6', effort: 'high' },
    b: { role, model: 'claude-sonnet-4-6', effort: 'medium' },
  },
  margin: 0.1,
  objective: role === 'planner' ? 'parallelism' : 'cost',
  evaluators: 'objective',
  ...over,
});

function fixture({ experiments = null, cwd = '/home/x/proj' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cm-evarm-'));
  const evals = join(base, 'evals');
  const experimentsFile = join(base, 'config', 'experiments.json');
  if (experiments !== null) {
    mkdirSync(join(base, 'config'), { recursive: true });
    writeFileSync(experimentsFile, `${JSON.stringify({ experiments }, null, 2)}\n`);
  }
  const env = {
    HOME: join(base, 'home'),
    TRIQUAL_EVALS_DIR: evals,
    TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
  };
  return {
    base,
    evals,
    experimentsFile,
    assignmentsFile: join(evals, 'role-assignments.jsonl'),
    cwd,
    env,
  };
}

async function run(f, argv, deps = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: f.env,
    cwd: f.cwd,
    now: () => NOW,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ...deps,
  });
  return { code, out, err };
}

const rowsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });

test('no experiment prints none and writes nothing', async () => {
  const missing = fixture({ experiments: null });
  try {
    const r1 = await run(missing, ['--kind', 'role', '--role', 'planner', '--key', 'plan-alpha']);
    assert.equal(r1.code, 0, r1.err);
    assert.equal(r1.out, 'none\n');
    assert.equal(r1.err, '');
    assert.equal(existsSync(missing.assignmentsFile), false);
  } finally { cleanup(missing); }

  const inactive = fixture({
    experiments: [roleExperiment('exp-paused', 'planner', { status: 'paused', evaluators: undefined })],
  });
  try {
    const r2 = await run(inactive, ['--kind', 'role', '--role', 'planner', '--plan', 'docs/plans/2026-11-17-sample.md', '--task', 'T1']);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(r2.out, 'none\n');
    assert.equal(r2.err, '');
    assert.equal(existsSync(inactive.assignmentsFile), false);
  } finally { cleanup(inactive); }
});

test('--key form prints the arm line for the planner', async () => {
  const exp = roleExperiment('exp-planner', 'planner');
  const f = fixture({ experiments: [exp] });
  try {
    const key = '2026-11-17-feature.md';
    const hit = armFor('role', key, { experiments: [exp], target: 'planner' });
    const r = await run(f, ['--kind', 'role', '--role', 'planner', '--key', key]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `exp-planner/${hit.arm} ${hit.payload.model} ${hit.payload.effort}\n`);
    assert.equal(r.err, '');

    assert.equal(statSync(f.evals).mode & 0o777, 0o700);
    assert.equal(statSync(f.assignmentsFile).mode & 0o777, 0o600);
    const rows = rowsOf(f.assignmentsFile);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(Object.keys(row).sort(), ['arm', 'at', 'cwd', 'effort', 'experiment', 'key', 'model', 'plan', 'role', 'task']);
    assert.equal(row.key, key);
    assert.equal(row.plan, null);
    assert.equal(row.task, null);
    assert.equal(row.role, 'planner');
    assert.equal(row.experiment, 'exp-planner');
    assert.equal(row.arm, hit.arm);
    assert.equal(row.model, hit.payload.model);
    assert.equal(row.effort, hit.payload.effort);
    assert.equal(row.cwd, '/home/x/proj');
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    // Dispatched through `triqual eval arm`
    let dispOut = '';
    const dispCode = await evalMain(['arm', '--kind', 'role', '--role', 'planner', '--key', key], {
      env: f.env,
      cwd: f.cwd,
      stdout: { write: (s) => { dispOut += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(dispCode, 0);
    assert.equal(dispOut, r.out);
  } finally { cleanup(f); }
});

test('--plan/--task form uses key <plan>/T<N>', async () => {
  const exp = roleExperiment('exp-impl', 'roles:tdd-implementer');
  const f = fixture({ experiments: [exp], cwd: '/home/x/worktree' });
  try {
    const planArg = '/home/x/worktree/docs/plans/2026-11-17-sample.md';
    const expectedKey = '2026-11-17-sample.md/T23';
    const hit = armFor('role', expectedKey, { experiments: [exp], target: 'roles:tdd-implementer' });

    const r = await run(f, ['--kind', 'role', '--role', 'roles:tdd-implementer', '--plan', planArg, '--task', 'T23']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `exp-impl/${hit.arm} ${hit.payload.model} ${hit.payload.effort}\n`);

    const rows = rowsOf(f.assignmentsFile);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.key, expectedKey);
    assert.equal(row.plan, '2026-11-17-sample.md');
    assert.equal(row.task, 'T23');
    assert.equal(row.role, 'roles:tdd-implementer');
    assert.equal(row.experiment, 'exp-impl');
    assert.equal(row.arm, hit.arm);
    assert.equal(row.model, hit.payload.model);
    assert.equal(row.effort, hit.payload.effort);
    assert.equal(row.cwd, '/home/x/worktree');
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  } finally { cleanup(f); }
});

test('same key twice: same arm, one assignment line', async () => {
  const implExp = roleExperiment('exp-impl', 'roles:tdd-implementer');
  const revExp = roleExperiment('exp-rev', 'roles:spec-reviewer');
  const f = fixture({ experiments: [implExp, revExp] });
  try {
    const first = await run(f, ['--kind', 'role', '--role', 'roles:tdd-implementer', '--plan', 'docs/plans/2026-11-17-sample.md', '--task', 'T4']);
    const second = await run(f, ['--kind', 'role', '--role', 'roles:tdd-implementer', '--plan', '/other/dir/2026-11-17-sample.md', '--task', 'T4']);
    assert.equal(first.code, 0, first.err);
    assert.equal(second.code, 0, second.err);
    assert.equal(second.out, first.out);
    assert.equal(rowsOf(f.assignmentsFile).length, 1, 'a repeated (key, role) does not append a second line');

    // Another role on the same key gets its own single assignment line.
    const otherRole = await run(f, ['--kind', 'role', '--role', 'roles:spec-reviewer', '--plan', 'docs/plans/2026-11-17-sample.md', '--task', 'T4']);
    const otherRoleAgain = await run(f, ['--kind', 'role', '--role', 'roles:spec-reviewer', '--plan', 'docs/plans/2026-11-17-sample.md', '--task', 'T4']);
    assert.equal(otherRole.code, 0, otherRole.err);
    assert.equal(otherRoleAgain.code, 0, otherRoleAgain.err);
    assert.equal(otherRoleAgain.out, otherRole.out);
    const rows = rowsOf(f.assignmentsFile);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.key, r.role]), [
      ['2026-11-17-sample.md/T4', 'roles:tdd-implementer'],
      ['2026-11-17-sample.md/T4', 'roles:spec-reviewer'],
    ]);
  } finally { cleanup(f); }
});

test('a new experiment for the same (key, role) gets its own line and the printed arm matches it', async () => {
  const f = fixture({ experiments: [roleExperiment('exp-old', 'roles:tdd-implementer')] });
  try {
    const argv = ['--kind', 'role', '--role', 'roles:tdd-implementer', '--key', 'plan-beta/T2'];
    const first = await run(f, argv);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^exp-old\//);

    // The old experiment ends and a new one starts for the same role while the plan is running.
    writeFileSync(f.experimentsFile, `${JSON.stringify({
      experiments: [
        roleExperiment('exp-old', 'roles:tdd-implementer', { status: 'ended' }),
        roleExperiment('exp-new', 'roles:tdd-implementer'),
      ],
    }, null, 2)}\n`);
    const second = await run(f, argv);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^exp-new\//);

    const rows = rowsOf(f.assignmentsFile);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.experiment), ['exp-old', 'exp-new']);
    const last = rows[rows.length - 1];
    assert.equal(second.out, `${last.experiment}/${last.arm} ${last.model} ${last.effort}\n`);

    // Same experiment again: still no new line.
    const third = await run(f, argv);
    assert.equal(third.out, second.out);
    assert.equal(rowsOf(f.assignmentsFile).length, 2);
  } finally { cleanup(f); }
});

test("another role's experiment does not apply", async () => {
  const f = fixture({
    experiments: [
      roleExperiment('exp-planner', 'planner'),
      {
        id: 'exp-session',
        kind: 'session',
        status: 'active',
        start: '2026-11-17',
        control: 'a',
        arms: { a: { model: 'claude-opus-4-6' }, b: { model: 'claude-sonnet-4-6' } },
        margin: 0.1,
        objective: 'cost',
        evaluators: 'a'.repeat(64),
      },
    ],
  });
  try {
    const r = await run(f, ['--kind', 'role', '--role', 'roles:tdd-implementer', '--plan', 'docs/plans/2026-11-17-sample.md', '--task', 'T2']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'none\n');
    assert.equal(existsSync(f.assignmentsFile), false);
  } finally { cleanup(f); }
});

test('both key forms at once exit 2', async () => {
  const f = fixture({ experiments: [roleExperiment('exp-planner', 'planner')] });
  try {
    const bad = [
      // both key forms at once
      ['--kind', 'role', '--role', 'planner', '--key', 'k1', '--plan', 'p.md', '--task', 'T1'],
      ['--kind', 'role', '--role', 'planner', '--key', 'k1', '--plan', 'p.md'],
      ['--kind', 'role', '--role', 'planner', '--key', 'k1', '--task', 'T1'],
      // neither key form, or incomplete --plan/--task
      ['--kind', 'role', '--role', 'planner'],
      ['--kind', 'role', '--role', 'planner', '--plan', 'p.md'],
      ['--kind', 'role', '--role', 'planner', '--task', 'T1'],
      ['--kind', 'role', '--role', 'planner', '--plan', 'p.md', '--task', '3'],
      // missing or invalid --kind / --role / unknown flag
      ['--role', 'planner', '--key', 'k1'],
      ['--kind', 'session', '--role', 'planner', '--key', 'k1'],
      ['--kind', 'role', '--key', 'k1'],
      ['--kind', 'role', '--role', 'planner', '--key', 'k1', '--bogus'],
    ];
    for (const argv of bad) {
      const r = await run(f, argv);
      assert.equal(r.code, 2, `expected exit 2 for: ${argv.join(' ')}`);
      assert.equal(r.out, '', `expected empty stdout for: ${argv.join(' ')}`);
      assert.ok(r.err.length > 0, `expected stderr message for: ${argv.join(' ')}`);
    }
    assert.equal(existsSync(f.assignmentsFile), false);
  } finally { cleanup(f); }
});

test('an unreadable experiments file exits 1 and writes nothing', async () => {
  const f = fixture({ experiments: [] });
  try {
    writeFileSync(f.experimentsFile, '{ not json');
    const r = await run(f, ['--kind', 'role', '--role', 'planner', '--key', 'k1']);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.ok(r.err.length > 0);
    assert.equal(existsSync(f.assignmentsFile), false);
  } finally { cleanup(f); }
});

test('the lock file is released after a write', async () => {
  const f = fixture({ experiments: [roleExperiment('exp-planner', 'planner')] });
  try {
    const r = await run(f, ['--kind', 'role', '--role', 'planner', '--key', 'k1']);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(`${f.assignmentsFile}.lock`), false);
  } finally { cleanup(f); }
});
