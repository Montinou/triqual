// scripts/phase-resume: the orchestrator brief of a phase rebuilt from the workspace ledger (spec 7.6). Every test runs the real script in a
// temp git repo against a hand-written ledger (and, where a test needs one, a hand-written stack state); nothing is stubbed. The script reads
// only: the ledger, the stack state and the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans', 'scripts');
const RESUME = join(SCRIPTS, 'phase-resume');
const WORKSPACE = join(SCRIPTS, 'sdd-workspace');
const PLAN_REL = 'docs/plans/resume-plan.md';

const task = (n, title) => `### Task ${n}: ${title}\n\n**Role:** roles:tdd-implementer\n\n- [ ] **Step 1:** do ${n}.\n\n`;
const PLAN = [
  '# Resume Plan\n\n**Branch prefix:** demo\n\n',
  '## Phase 1: Core\n\n**Slice:** S1\n**Branch:** demo/01-core\n**PR title:** feat: core\n**Validate:** ci.yml\n**Stands alone because:** core only\n**Phase check:** `true` → exit 0\n\n',
  ...[1, 2, 3, 4, 5, 6].map((n) => task(n, `Task number ${n}`)),
  '## Phase 2: Edge\n\n**Slice:** S2\n**Branch:** demo/02-edge\n**PR title:** feat: edge\n**Stands alone because:** edge only\n**Phase check:** `true` → exit 0\n\n',
  task(7, 'Task number 7'),
].join('');

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

// A repo with the plan committed; `ledger` (an array of lines) is written to the plan's workspace, `stackPhases` (state per phase) to its stack state.
function rig({ ledger = null, stackPhases = null, mode = 'github', single = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phase-resume-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(dir);
  const env = gitEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), single ? PLAN.slice(0, PLAN.indexOf('## Phase 2')) : PLAN);
  git('add', '.');
  git('commit', '-q', '-m', 'plan');
  const workspace = execFileSync(process.execPath, [WORKSPACE, PLAN_REL], { cwd: dir, env, encoding: 'utf8' }).trim();
  const ledgerFile = join(workspace, 'sdd-ledger.md');
  if (ledger !== null) writeFileSync(ledgerFile, `${ledger.join('\n')}\n`);
  if (stackPhases !== null) {
    mkdirSync(join(dir, '.methodology', 'stack'), { recursive: true });
    const phases = [['demo/01-core', 'feat: core'], ['demo/02-edge', 'feat: edge']].slice(0, single ? 1 : 2).map(([branch, title], i) => ({
      n: i + 1, branch, title, pr: null, state: stackPhases[i] ?? 'pending',
    }));
    writeFileSync(
      join(dir, '.methodology', 'stack', 'resume-plan.json'),
      `${JSON.stringify({ v: 1, plan: 'resume-plan.md', mode, trunk: 'main', remote: 'origin', phases })}\n`,
    );
  }
  const run = (...args) => spawnSync(process.execPath, [RESUME, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { dir, run, ledgerFile, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const withRig = (options, fn) => {
  const r = rig(options);
  try {
    return fn(r);
  } finally {
    r.cleanup();
  }
};

const HEADER = '# SDD ledger — plan: docs/plans/resume-plan.md';
// Every state at once, a Validation: line and a Validation fix: line among them.
const EVERY_STATE = [
  HEADER,
  'BASE: T1 1111111aaaaaaaa',
  'Task 1: complete (commits 1111111..2222222, review clean)',
  'BASE: T2 3333333bbbbbbbb',
  'Prep: T2 r1 4444444cccccccc',
  'Task 2: fix round 1/5 (2 addressed, 1 open — a finding; commits 3333333..4444444)',
  'BASE: T3 5555555dddddddd',
  'Task 3: awaiting landing',
  'BASE: T4 6666666eeeeeeee',
  'Landed: T4 7777777ffffffff',
  'Tested: T4 7777777ffffffff',
  'BASE: T5 8888888aaaaaaaa',
  'BASE: T5 9999999bbbbbbbb',
  'Task 5: landing conflict — re-run sequential',
  'Validation: P1 run 4242 verdict failed — https://github.com/acme/demo/actions/runs/4242',
  'Validation fix: P1 abcdef0 — the lint step fails on the new script',
];

test('every state: the heading, the exact rows, the Validations and the Next line', () => {
  withRig({ ledger: EVERY_STATE, stackPhases: ['active'] }, ({ run }) => {
    const res = run(PLAN_REL, '1');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      [
        '# Resume P1 demo/01-core (active)',
        '',
        '| Task | State | Evidence |',
        '| --- | --- | --- |',
        '| T1 | complete | commits 1111111..2222222, review clean |',
        '| T2 | running (BASE 3333333) | Prep r1 4444444, fix round 1/5 |',
        '| T3 | awaiting landing | — |',
        '| T4 | landed, not closed | Landed 7777777, tested |',
        '| T5 | undone — re-run sequential | landing conflict |',
        '| T6 | not started | — |',
        '',
        '## Validations',
        '',
        'Validation: P1 run 4242 verdict failed — https://github.com/acme/demo/actions/runs/4242',
        'Validation fix: P1 abcdef0 — the lint step fails on the new script',
        '',
        '## Next',
        '',
        'Continue T2 (BASE 3333333): finish its build and review, then node scripts/task-close docs/plans/resume-plan.md 2.',
        '',
      ].join('\n'),
    );
  });
});

test('another phase gets only its own tasks and its own Validation lines; no Validation lines say none', () => {
  withRig({ ledger: EVERY_STATE, stackPhases: ['submitted', 'pending'] }, ({ run }) => {
    const res = run(PLAN_REL, '2');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      [
        '# Resume P2 demo/02-edge (pending)',
        '',
        '| Task | State | Evidence |',
        '| --- | --- | --- |',
        '| T7 | not started | — |',
        '',
        '## Validations',
        '',
        '(none)',
        '',
        '## Next',
        '',
        'Open T7: node scripts/task-open docs/plans/resume-plan.md 7.',
        '',
      ].join('\n'),
    );
  });
});

test('the heading names a phase with no stack state', () => {
  withRig({ ledger: [HEADER] }, ({ run }) => {
    const res = run(PLAN_REL, '1');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.startsWith('# Resume P1 demo/01-core (no stack state)\n'), res.stdout);
    assert.ok(res.stdout.includes('| T1 | not started | — |'));
  });
});

// The Next line is the first applicable action: the first task of the phase that is not complete decides, in plan order.
const nextOf = (ledger, n = '1', stackPhases = ['active'], mode = 'github', single = false) =>
  withRig({ ledger, stackPhases, mode, single }, ({ run }) => {
    const res = run(PLAN_REL, n);
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.split('\n## Next\n\n')[1].trimEnd();
  });

const COMPLETE_ALL = [
  HEADER,
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`BASE: T${n} 000000${n}aaaaaaa`, `Task ${n}: complete (commits 000000${n}..111111${n}, review clean)`]),
];

test('Next by the first task that is not complete', () => {
  const plan = 'docs/plans/resume-plan.md';
  const upTo = (k) => COMPLETE_ALL.slice(0, 1 + 2 * k);
  assert.equal(nextOf([HEADER]), `Open T1: node scripts/task-open ${plan} 1.`);
  assert.equal(nextOf([...upTo(1), 'BASE: T2 abcdef0123']), `Continue T2 (BASE abcdef0): finish its build and review, then node scripts/task-close ${plan} 2.`);
  assert.equal(
    nextOf([...upTo(1), 'BASE: T2 abcdef0123', 'Task 2: awaiting landing']),
    `Land T2: once every earlier task has landed, node scripts/task-close ${plan} 2.`,
  );
  assert.equal(
    nextOf([...upTo(1), 'BASE: T2 abcdef0123', 'Task 2: awaiting landing', 'Landed: T2 1234567890']),
    `Close T2: node scripts/task-close ${plan} 2.`,
  );
  assert.equal(
    nextOf([...upTo(1), 'BASE: T2 abcdef0123', 'BASE: T2 0123456abc', 'Task 2: landing conflict — re-run sequential']),
    `Re-run T2 sequentially: node scripts/task-open ${plan} 2.`,
  );
});

test('an undone task that was opened again is running, and a reopened complete task is running', () => {
  const undone = ['BASE: T1 abcdef0123', 'BASE: T1 0123456abc', 'Task 1: landing conflict — re-run sequential'];
  const reopened = nextOf([HEADER, ...undone, 'BASE: T1 7654321fed']);
  assert.match(reopened, /^Continue T1 \(BASE 7654321\)/);
  const again = nextOf([...COMPLETE_ALL.slice(0, 3), 'Task 1: reopened — Phase check failed — node --test x']);
  assert.match(again, /^Continue T1 \(BASE 0000001\)/);
});

test('a reopened worktree task (BASE, Landed, Tested, complete, reopened, no new BASE) is running, not landed', () => {
  const plan = 'docs/plans/resume-plan.md';
  const worktree = [
    HEADER,
    'BASE: T1 1111111aaaaaaaa',
    'Task 1: awaiting landing',
    'Landed: T1 2222222bbbbbbbb',
    'Tested: T1 2222222bbbbbbbb',
    'Task 1: complete (commits 1111111..2222222, review clean)',
    'Task 1: reopened — Phase check failed — node --test x',
  ];
  withRig({ ledger: worktree, stackPhases: ['active'] }, ({ run }) => {
    const res = run(PLAN_REL, '1');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('| T1 | running (BASE 1111111) | — |'), res.stdout);
    assert.ok(res.stdout.trimEnd().endsWith(`Continue T1 (BASE 1111111): finish its build and review, then node scripts/task-close ${plan} 1.`), res.stdout);
  });
  // A landing written after the reopen counts again.
  const relanded = [...worktree, 'Landed: T1 3333333cccccccc'];
  assert.equal(nextOf(relanded), `Close T1: node scripts/task-close ${plan} 1.`);
});

test('a done phase in local mode, or with its Phase complete line ledgered, resumes past Submit', () => {
  const plan = 'docs/plans/resume-plan.md';
  const reviewed = [...COMPLETE_ALL, 'Phase review: P1 clean'];
  const moveOn = `P1 is submitted: start the next phase with node scripts/stack.mjs phase ${plan} 2.`;
  assert.equal(nextOf(reviewed, '1', ['done'], 'local'), moveOn);
  assert.equal(nextOf([...reviewed, 'Phase 1: complete (demo/01-core, local)'], '1', ['done']), moveOn);
  // A github-mode phase that is done and not ledgered complete still needs its submit.
  assert.equal(nextOf(reviewed, '1', ['done']), `Submit P1: node scripts/stack.mjs submit ${plan} 1.`);
});

test('Next once every task is complete follows the phase review, the stack state and the validations', () => {
  const plan = 'docs/plans/resume-plan.md';
  const failed = 'Validation: P1 run 7 verdict failed — https://example.invalid/7';
  const clean = 'Validation: P1 run 8 verdict clean — https://example.invalid/8';
  const fix = 'Validation fix: P1 abcdef0 — a finding';
  assert.equal(nextOf(COMPLETE_ALL), 'Run the Phase check and the phase review of P1 (SKILL.md, step 8).');
  assert.equal(nextOf([...COMPLETE_ALL, 'Phase review: P1 blocked']), 'Phase review P1 is blocked: ask your human partner for the decision.');
  assert.equal(
    nextOf([...COMPLETE_ALL, 'Phase review: P1 clean']),
    `Mark P1 done and submit it: node scripts/stack.mjs done ${plan} 1, then node scripts/stack.mjs submit ${plan} 1.`,
  );
  assert.equal(
    nextOf([...COMPLETE_ALL, 'Phase review: P1 fixed'], '1', ['done']),
    `Submit P1: node scripts/stack.mjs submit ${plan} 1.`,
  );
  const submitted = [...COMPLETE_ALL, 'Phase review: P1 clean'];
  assert.equal(nextOf(submitted, '1', ['submitted']), `Validate P1 against CI: node scripts/validate ${plan} 1.`);
  assert.equal(
    nextOf([...submitted, failed], '1', ['submitted']),
    `Fix the failure in <workspace>/phase-1-report.md on demo/01-core with a plain commit, node scripts/stack.mjs push ${plan} 1, then ledger "Validation fix: P1 <sha> — <finding>".`,
  );
  assert.equal(
    nextOf([...submitted, failed, fix], '1', ['submitted']),
    `Wait for the new CI run of P1, then node scripts/validate ${plan} 1.`,
  );
  assert.equal(
    nextOf([...submitted, failed, fix, clean], '1', ['ready']),
    `P1 is validated: start the next phase with node scripts/stack.mjs phase ${plan} 2.`,
  );
  assert.equal(
    nextOf(['x', 'BASE: T7 0000007aaaaaaa', 'Task 7: complete (commits 0000007..1111117, review clean)', 'Phase review: P2 clean'], '2', ['submitted', 'submitted']),
    `P2 is the last phase and is submitted: run the seams review of the plan, then node scripts/stack.mjs submit ${plan} 2 --open.`,
  );
  assert.equal(nextOf([...submitted], '1', ['merged']), 'P1 is merged: nothing to resume.');
});

test('a task the breaker blocked is blocked until a Ruling follows; a done phase with no phase review points to the review', () => {
  const blocked = 'Task 2: blocked at fix round 5/5 — an open Important finding';
  const upTo1 = COMPLETE_ALL.slice(0, 3);
  const open = [...upTo1, 'BASE: T2 abcdef0123', 'Prep: T2 r1 4444444cccccccc', 'Task 2: fix round 5/5 (0 addressed, 1 open — a finding; commits a..b)', blocked];
  withRig({ ledger: open, stackPhases: ['active'] }, ({ run }) => {
    const res = run(PLAN_REL, '1');
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('| T2 | blocked | blocked at fix round 5/5 |'), res.stdout);
    assert.ok(res.stdout.trimEnd().endsWith('T2 is blocked: ask your human partner for the decision.'), res.stdout);
  });
  // The human's decision unblocks it: a Ruling line (or a granted-rounds Ruling) after the blocked line, and the task runs again.
  const ruled = [...open, 'Task 2: Ruling: a finding — more rounds — contestable — costs a round'];
  assert.match(nextOf(ruled), /^Continue T2 \(BASE abcdef0\)/);
  assert.match(nextOf([...open, 'Ruling: human granted 2 rounds for T2 — why — cost']), /^Continue T2 \(BASE abcdef0\)/);
  // A Ruling before the blocked line, or on another task, does not unblock it; a new BASE does.
  assert.match(nextOf([...upTo1, 'BASE: T2 abcdef0123', 'Task 2: Ruling: x — y — z — w', blocked]), /^T2 is blocked: /);
  assert.match(nextOf([...open, 'Task 3: Ruling: x — y — z — w']), /^T2 is blocked: /);
  assert.match(nextOf([...open, 'BASE: T2 fedcba9876']), /^Continue T2 \(BASE fedcba9\)/);
  // A phase marked done in the stack state without a Phase review line still needs the phase review, not a submit.
  assert.equal(nextOf(COMPLETE_ALL, '1', ['done']), 'Run the Phase check and the phase review of P1 (SKILL.md, step 8).');
  assert.equal(nextOf(COMPLETE_ALL, '1', ['done'], 'local'), 'Run the Phase check and the phase review of P1 (SKILL.md, step 8).');
  // A phase begun before the phase review (its Phase complete line is ledgered) is final without one.
  assert.equal(
    nextOf([...COMPLETE_ALL, 'Phase 1: complete (demo/01-core, local)'], '1', ['done']),
    'P1 is submitted: start the next phase with node scripts/stack.mjs phase docs/plans/resume-plan.md 2.',
  );
});

test('the last phase names the seams review only in a plan with several phases', () => {
  const plan = 'docs/plans/resume-plan.md';
  const done = [...COMPLETE_ALL, 'Phase review: P1 clean', 'Validation: P1 run 8 verdict clean — https://example.invalid/8'];
  assert.equal(nextOf(done, '1', ['ready'], 'github', true), `P1 is the last phase and is submitted: node scripts/stack.mjs submit ${plan} 1 --open.`);
});

test('a phase with no declared validation skips the validate step', () => {
  const plan = 'docs/plans/resume-plan.md';
  const done = ['x', 'BASE: T7 0000007aaaaaaa', 'Task 7: complete (commits 0000007..1111117, review clean)', 'Phase review: P2 fixed'];
  assert.equal(nextOf(done, '2', ['submitted', 'ready']), `P2 is the last phase and is submitted: run the seams review of the plan, then node scripts/stack.mjs submit ${plan} 2 --open.`);
});

test('exit 3 with no ledger; exit 2 for a bad call; the script writes nothing', () => {
  withRig({}, ({ run, ledgerFile }) => {
    const none = run(PLAN_REL, '1');
    assert.equal(none.status, 3);
    assert.match(none.stderr, /no ledger/);
    assert.equal(none.stdout, '');
    assert.throws(() => readFileSync(ledgerFile), 'a refusal must not create the ledger');
  });
  withRig({ ledger: EVERY_STATE, stackPhases: ['active'] }, ({ run, ledgerFile }) => {
    assert.equal(run().status, 2);
    assert.equal(run(PLAN_REL).status, 2);
    assert.equal(run(PLAN_REL, 'x').status, 2);
    assert.equal(run(PLAN_REL, '1', 'extra').status, 2);
    assert.equal(run('docs/plans/missing.md', '1').status, 2);
    const nine = run(PLAN_REL, '9');
    assert.equal(nine.status, 2);
    assert.match(nine.stderr, /no phase 9/);
    const before = readFileSync(ledgerFile, 'utf8');
    assert.equal(run(PLAN_REL, '1').status, 0);
    assert.equal(readFileSync(ledgerFile, 'utf8'), before, 'phase-resume wrote to the ledger');
  });
});
