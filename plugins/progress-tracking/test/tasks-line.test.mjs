import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan, createLedger, transition } from '../lib/ledger.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NAME = '2026-09-28-example';
const AT = '2026-09-28T00:00:00Z';
// Spec D.3 asks for a segment fast enough to run on every status-line refresh (the plan's target is 300 ms). The
// assertion bound is generous so a loaded CI machine or a parallel `npm test` never flakes it; the real time is logged.
// TRIQUAL_TEST_LINE_BUDGET_MS (a positive integer) overrides it on a machine under extreme load.
const DEFAULT_LINE_BUDGET_MS = 1000;
const budgetEnv = process.env.TRIQUAL_TEST_LINE_BUDGET_MS;
const LINE_BUDGET_MS = /^[1-9]\d*$/.test(budgetEnv ?? '') ? Number(budgetEnv) : DEFAULT_LINE_BUDGET_MS;

const PLAN = `# Example plan

### Task 1: Alpha

### Task 2: Beta

### Task 3: Gamma
**Depends on:** T1

### Task 4: Delta
`;

// A clean environment: no inherited GIT_* repo selection (tests may run from a hook), a temp HOME, no XDG config.
const cleanEnv = (home) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME']) delete env[k];
  return env;
};

// A temp dir holding a repo at <dir>/repo with one initial commit; `home` is <dir>/home.
function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-line-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = cleanEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const line = ({ cwd = repo } = {}) => spawnSync(process.execPath, [BIN, 'line'], { cwd, env, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git(...ID, 'commit', '-qm', 'initial');
  try {
    fn({ dir, repo, home, git, line });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Opts the repo in (committed mode by default, local mode under <git-dir>/methodology) and returns its plans dir.
function optIn(repo, { local = false } = {}) {
  const root = local ? join(repo, '.git', 'methodology') : repo;
  const plansDir = local ? join(root, 'plans') : join(root, 'docs', 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(root, 'progress.md'), '# Progress\n');
  writeFileSync(join(root, 'status.md'), '# Status\n');
  return plansDir;
}

// Writes a ledger for `plan` (PLAN by default) named `name`, after applying `moves` ([cmd, id, arg]) in order, then
// `state` and `edit`.
function writeLedger(plansDir, name, moves = [], { state, edit, plan = PLAN } = {}) {
  let ledger = createLedger({ plan: `docs/plans/${name}.md`, spec: null, branch: 'main', tasks: parsePlan(plan), now: AT });
  for (const [cmd, id, arg] of moves) ledger = transition(ledger, cmd, id, arg, AT).ledger;
  if (state) ledger.state = state;
  if (edit) edit(ledger);
  writeFileSync(join(plansDir, `${name}.tasks.json`), `${JSON.stringify(ledger, null, 2)}\n`);
}

// Asserts a silent success: exit 0, nothing on stderr, and exactly `stdout`.
function segment(r, stdout) {
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, stdout);
}

const SHA = 'a'.repeat(40);

test('prints the segment for one active plan', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [['start', 'T1'], ['drop', 'T4', 'not needed']]);
  segment(line(), `▸ ${NAME} 0/3 · T1 (tdd-implementer)\n`); // the dropped T4 is left out of the total
}));

test('prints the segment in local mode', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo, { local: true });
  writeLedger(plansDir, NAME, [['start', 'T2']]);
  segment(line(), `▸ ${NAME} 0/4 · T2 (tdd-implementer)\n`);
}));

test('falls back to next, then done', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [['start', 'T1'], ['done', 'T1', SHA], ['drop', 'T4', 'not needed']]);
  segment(line(), `▸ ${NAME} 1/3 · T2 (tdd-implementer)\n`);
  writeLedger(plansDir, NAME, [
    ['start', 'T1'], ['done', 'T1', SHA], ['start', 'T2'], ['done', 'T2', SHA],
    ['start', 'T3'], ['review', 'T3'], ['done', 'T3', SHA], ['drop', 'T4', 'not needed'],
  ]);
  segment(line(), `▸ ${NAME} 3/3 · done\n`);
}));

test('shows the first in_review task with review', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [
    ['start', 'T1'], ['done', 'T1', SHA], ['start', 'T2'], ['review', 'T2'], ['start', 'T4'], ['review', 'T4'],
    ['start', 'T3'], ['block', 'T3', 'waiting'],
  ]);
  segment(line(), `▸ ${NAME} 1/4 · T2 (tdd-implementer) review\n`); // in review wins over blocked
}));

test('shows the first blocked task with blocked', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [
    ['start', 'T1'], ['done', 'T1', SHA], ['block', 'T2', 'waiting'], ['start', 'T3'], ['done', 'T3', SHA],
    ['block', 'T4', 'also waiting'],
  ]);
  segment(line(), `▸ ${NAME} 2/4 · T2 (tdd-implementer) blocked\n`);
}));

test('shows stalled when no task can move and the plan is unfinished', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [
    ['start', 'T1'], ['done', 'T1', SHA], ['start', 'T2'], ['done', 'T2', SHA], ['start', 'T3'], ['done', 'T3', SHA],
  ], { edit: (ledger) => { ledger.tasks.find((x) => x.id === 'T4').deps = ['T9']; } }); // T4 waits on an unknown task
  segment(line(), `▸ ${NAME} 3/4 · stalled\n`);
}));

test('shows done only when every non-dropped task is done', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [
    ['start', 'T1'], ['done', 'T1', SHA], ['drop', 'T2', 'not needed'], ['start', 'T3'], ['done', 'T3', SHA],
    ['start', 'T4'], ['done', 'T4', SHA],
  ]);
  segment(line(), `▸ ${NAME} 3/3 · done\n`);
}));

test('shows (+1) with two active plans', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, '2026-09-28-alpha', [['start', 'T1']]);
  writeLedger(plansDir, '2026-09-29-beta', [['start', 'T1'], ['done', 'T1', SHA]]);
  // A closed plan is not active: it is neither printed nor counted.
  writeLedger(plansDir, '2026-09-30-closed', [], { state: 'done' });
  segment(line(), '▸ 2026-09-29-beta 1/4 · T2 (tdd-implementer) (+1)\n');
}));

test('prints nothing and exits 0 outside git, when not opted in, and with no active plan', () => withRepo(({ dir, repo, line }) => {
  segment(line({ cwd: dir }), ''); // outside git
  segment(line(), ''); // a repo that is not opted in
  const plansDir = optIn(repo);
  segment(line(), ''); // opted in, no plans directory content
  writeLedger(plansDir, NAME, [], { state: 'done' });
  segment(line(), ''); // only a closed plan
}));

test('prints nothing and exits 0 with only a corrupt ledger, and skips it next to a valid one', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  writeFileSync(join(plansDir, `${NAME}.tasks.json`), '{ not json');
  segment(line(), '');
  // An unusable ledger is skipped, silently, like `status` skips it: the valid one prints and `(+n)` leaves it out.
  writeLedger(plansDir, '2026-09-27-valid', [['start', 'T1']]);
  segment(line(), '▸ 2026-09-27-valid 0/4 · T1 (tdd-implementer)\n');
}));

test('prints nothing and exits 0 with unexpected arguments', () => withRepo(({ repo, home }) => {
  writeLedger(optIn(repo), NAME, [['start', 'T1']]);
  const r = spawnSync(process.execPath, [BIN, 'line', '--bogus'], { cwd: repo, env: cleanEnv(home), encoding: 'utf8' });
  segment(r, '');
}));

test('writes nothing and registers nothing', () => withRepo(({ repo, home, git, line }) => {
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [['start', 'T1']]);
  git('add', '-A');
  git(...ID, 'commit', '-qm', 'opt in');
  segment(line(), `▸ ${NAME} 0/4 · T1 (tdd-implementer)\n`);
  assert.equal(git('status', '--porcelain', '--ignored'), '');
  assert.equal(existsSync(join(home, '.config')), false);
}));

test(`runs in under ${LINE_BUDGET_MS} ms (target 300 ms)`, (t) => withRepo(({ repo, line }) => {
  writeLedger(optIn(repo), NAME, [['start', 'T1']]);
  segment(line(), `▸ ${NAME} 0/4 · T1 (tdd-implementer)\n`); // warm-up: file-system and git caches
  // The best of three runs: one slow run under machine load is noise, a slow command is slow on every run.
  let elapsedMs = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const started = process.hrtime.bigint();
    const r = line();
    elapsedMs = Math.min(elapsedMs, Number(process.hrtime.bigint() - started) / 1e6);
    segment(r, `▸ ${NAME} 0/4 · T1 (tdd-implementer)\n`);
  }
  t.diagnostic(`triqual tasks line: ${elapsedMs.toFixed(1)} ms`);
  assert.ok(elapsedMs < LINE_BUDGET_MS, `took ${elapsedMs.toFixed(1)} ms`);
}));

test('line shows the current task\'s role', () => withRepo(({ repo, line }) => {
  const plan = `${PLAN.replace('### Task 1: Alpha\n', '### Task 1: Alpha\n**Role:** coordinator\n')
    .replace('### Task 2: Beta\n', '### Task 2: Beta\n**Role:** roles:review-fixer\n')}`;
  const plansDir = optIn(repo);
  writeLedger(plansDir, NAME, [['start', 'T1']], { plan });
  segment(line(), `▸ ${NAME} 0/4 · T1 (coordinator)\n`);
  writeLedger(plansDir, NAME, [['start', 'T1'], ['done', 'T1', SHA]], { plan });
  segment(line(), `▸ ${NAME} 1/4 · T2 (review-fixer)\n`); // the next task
  writeLedger(plansDir, NAME, [['start', 'T1'], ['review', 'T1']], { plan });
  segment(line(), `▸ ${NAME} 0/4 · T1 (coordinator) review\n`);
  // A ledger written before roles reads as the default role.
  writeLedger(plansDir, NAME, [['start', 'T2']], { plan, edit: (ledger) => { for (const x of ledger.tasks) delete x.role; } });
  segment(line(), `▸ ${NAME} 0/4 · T2 (tdd-implementer)\n`);
}));

test('line shows the current task\'s effective tier after its id, and nothing when it has none', () => withRepo(({ repo, line }) => {
  const plansDir = optIn(repo);
  const tier = (id, effectiveTier) => (ledger) => { ledger.tasks.find((x) => x.id === id).effectiveTier = effectiveTier; };
  writeLedger(plansDir, NAME, [['start', 'T1']], { edit: tier('T1', 'heavy') });
  segment(line(), `▸ ${NAME} 0/4 · T1 [heavy] (tdd-implementer)\n`);
  writeLedger(plansDir, NAME, [['start', 'T1'], ['review', 'T1']], { edit: tier('T1', 'light') });
  segment(line(), `▸ ${NAME} 0/4 · T1 [light] (tdd-implementer) review\n`);
  writeLedger(plansDir, NAME, [['start', 'T1'], ['done', 'T1', SHA]], { edit: tier('T2', 'standard') });
  segment(line(), `▸ ${NAME} 1/4 · T2 [standard] (tdd-implementer)\n`); // the next task
  // A ledger written before tiers, and an undeclared tier, show no tag.
  writeLedger(plansDir, NAME, [['start', 'T1']], { edit: (ledger) => { for (const x of ledger.tasks) delete x.effectiveTier; } });
  segment(line(), `▸ ${NAME} 0/4 · T1 (tdd-implementer)\n`);
  writeLedger(plansDir, NAME, [['start', 'T1']], { edit: tier('T1', null) });
  segment(line(), `▸ ${NAME} 0/4 · T1 (tdd-implementer)\n`);
}));
