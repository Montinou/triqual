import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, copyFileSync, symlinkSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePlan, createLedger, renderSection, upsertStatusSection } from '../lib/ledger.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gate.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const HINT = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const NAME = '2026-09-28-example';
const PLAN_REL = `docs/plans/${NAME}.md`;
const LEDGER_REL = `docs/plans/${NAME}.tasks.json`;
const STALE = 'status.md Active plan section is stale — run triqual tasks render';
const INIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init.mjs');
// The hook lines progress-tracking's init chains in local mode, verbatim (tests below cross-check init's own).
const LOCAL_GATE_REF = '"$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs"';
const HOOK_LINES = { 'pre-commit': `node ${LOCAL_GATE_REF} || exit 1`, 'post-commit': `node ${LOCAL_GATE_REF} --post-commit` };
// The two facts `paths --json` prints in every case.
const FACTS = { notOptedInMessage: HINT, localHookLines: HOOK_LINES };

const PLAN = `# Example plan

### Task 1: Alpha

### Task 2: Beta

### Task 3: Gamma
**Depends on:** T1
`;

// A clean environment: no inherited GIT_* repo selection (tests may run from a hook) and a temp HOME.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return { ...env, ...extra };
};

// A temp dir holding a repo at <dir>/repo with one initial commit; `home` is <dir>/home.
function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-cli-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = cleanEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const run = (args, { cwd = repo, extraEnv = {} } = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, env: cleanEnv(home, extraEnv), encoding: 'utf8',
  });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git(...ID, 'commit', '-qm', 'initial');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn({ dir, repo, home, git, run });
  } catch (err) {
    cleanup();
    throw err;
  }
  if (typeof result?.then === 'function') return result.finally(cleanup); // an async test body
  cleanup();
  return result;
}

// Committed mode: progress.md and status.md at the root, the example plan under docs/plans/.
function committed(repo, planText = PLAN, name = NAME) {
  writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  writeFileSync(join(repo, 'status.md'), '# Status\n\n**Last updated:** today\n');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'plans', `${name}.md`), planText);
}

const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
// The status.md text the CLI must produce: the original text with the section rendered over these ledgers.
const expectedStatus = (original, ledgers) => upsertStatusSection(original, renderSection(ledgers));

test('init creates the ledger next to the plan and renders status.md', () => withRepo(({ repo, git, run }) => {
  committed(repo);
  const statusBefore = read(join(repo, 'status.md'));
  const r = ok(run(['init', PLAN_REL, '--spec', 'docs/specs/x-design.md']));
  const ledgerPath = join(repo, LEDGER_REL);
  assert.equal(r.stdout, `created ${ledgerPath}\n`);
  const ledger = readJson(ledgerPath);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.plan, PLAN_REL);
  assert.equal(ledger.spec, 'docs/specs/x-design.md');
  assert.equal(ledger.branch, git('branch', '--show-current'));
  assert.equal(ledger.state, 'active');
  assert.deepEqual(ledger.tasks.map((t) => [t.id, t.title, t.status, t.deps]),
    [['T1', 'Alpha', 'pending', []], ['T2', 'Beta', 'pending', []], ['T3', 'Gamma', 'pending', ['T1']]]);
  assert.equal(read(join(repo, 'status.md')), expectedStatus(statusBefore, [{ name: NAME, ledger }]));
  assert.match(read(join(repo, 'status.md')), /<!-- tasks:start -->\n## Active plan\n\n### 2026-09-28-example — 0\/3 done/);
}));

test('init stores --branch and a null spec when none is given', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL, '--branch', 'feat/x']));
  const ledger = readJson(join(repo, LEDGER_REL));
  assert.equal(ledger.branch, 'feat/x');
  assert.equal(ledger.spec, null);
}));

test('init refuses a plan outside plansDir, a missing plan and a non-.md path', () => withRepo(({ repo, run }) => {
  committed(repo);
  writeFileSync(join(repo, 'elsewhere.md'), PLAN);
  const outside = run(['init', 'elsewhere.md']);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /plan must be in .*docs\/plans/);
  assert.equal(existsSync(join(repo, 'elsewhere.tasks.json')), false);
  const missing = run(['init', 'docs/plans/nope.md']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /plan .*nope\.md not found/);
  const notMd = run(['init', 'docs/plans/x.txt']);
  assert.equal(notMd.status, 2);
}));

test('init reconciles and reports added/missing/retitled', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const ledgerPath = join(repo, LEDGER_REL);
  ok(run(['start', 'T1']));
  writeFileSync(join(repo, PLAN_REL), `# Example plan

### Task 1: Alpha

### Task 3: Gamma renamed
**Depends on:** T1

### Task 4: Delta
`);
  const r = ok(run(['init', PLAN_REL]));
  assert.equal(r.stdout, `reconciled ${ledgerPath}: added T4; missing T2; retitled T3\n`);
  const ledger = readJson(ledgerPath);
  assert.deepEqual(ledger.tasks.map((t) => [t.id, t.title, t.status]),
    [['T1', 'Alpha', 'in_progress'], ['T2', 'Beta', 'pending'], ['T3', 'Gamma', 'pending'], ['T4', 'Delta', 'pending']]);
  const again = ok(run(['init', PLAN_REL]));
  assert.equal(again.stdout, `reconciled ${ledgerPath}: added none; missing T2; retitled T3\n`);
}));

test('start → review → done --commit HEAD updates ledger + status.md', () => withRepo(({ repo, git, run }) => {
  committed(repo);
  const statusBefore = read(join(repo, 'status.md'));
  ok(run(['init', PLAN_REL]));
  assert.equal(ok(run(['start', 'T1'])).stdout, 'T1: pending -> in_progress\n');
  assert.match(read(join(repo, 'status.md')), /- In progress: T1 Alpha/);
  assert.equal(ok(run(['review', 'T1'])).stdout, 'T1: in_progress -> in_review\n');
  assert.match(read(join(repo, 'status.md')), /- In review: T1 Alpha/);
  assert.equal(ok(run(['done', 'T1', '--commit', 'HEAD'])).stdout, 'T1: in_review -> done\n');
  const ledger = readJson(join(repo, LEDGER_REL));
  const head = git('rev-parse', 'HEAD');
  assert.equal(head.length, 40);
  assert.deepEqual(ledger.tasks[0].commits, [head]);
  assert.deepEqual(ledger.tasks[0].history.map((h) => h.to), ['pending', 'in_progress', 'in_review', 'done']);
  assert.equal(read(join(repo, 'status.md')), expectedStatus(statusBefore, [{ name: NAME, ledger }]));
  assert.match(read(join(repo, 'status.md')), /1\/3 done/);
}));

test('done with an unresolvable sha exits 2', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  ok(run(['start', 'T1']));
  const before = readFileSync(join(repo, LEDGER_REL));
  for (const sha of ['deadbeef', '--all']) {
    const r = run(['done', 'T1', `--commit=${sha}`]); // `=` so a dash-leading value reaches the sha check
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`commit ${sha} does not resolve`));
  }
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), before);
}));

test('a repeat transition prints already and exits 0 with an unchanged file', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  ok(run(['start', 'T1']));
  const ledgerBefore = readFileSync(join(repo, LEDGER_REL));
  const statusBefore = readFileSync(join(repo, 'status.md'));
  assert.equal(ok(run(['start', 'T1'])).stdout, 'T1: already in_progress\n');
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), ledgerBefore);
  assert.deepEqual(readFileSync(join(repo, 'status.md')), statusBefore);
}));

test('an invalid transition exits 2 with the current state', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const r = run(['review', 'T1']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'T1 is pending; cannot review\n');
  const dep = run(['start', 'T3']);
  assert.equal(dep.status, 2);
  assert.match(dep.stderr, /T3 depends on T1 \(pending\)/);
}));

test('block, drop, restore, reopen, retitle and close', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  assert.equal(run(['block', 'T2']).status, 2, 'block needs a reason');
  assert.equal(ok(run(['block', 'T2', 'waiting on infra'])).stdout, 'T2: pending -> blocked\n');
  assert.match(read(join(repo, 'status.md')), /- Blocked: T2 Beta — waiting on infra/);
  assert.equal(ok(run(['drop', 'T2', 'not needed'])).stdout, 'T2: blocked -> dropped\n');
  assert.equal(ok(run(['restore', 'T2'])).stdout, 'T2: dropped -> pending\n');
  assert.equal(ok(run(['drop', 'T2', 'not needed'])).stdout, 'T2: pending -> dropped\n');
  assert.equal(ok(run(['retitle', 'T3', 'Gamma prime'])).stdout, 'T3: "Gamma" -> "Gamma prime"\n');
  assert.equal(ok(run(['retitle', 'T3', 'Gamma prime'])).stdout, 'T3: already "Gamma prime"\n');
  const unfinished = run(['close']);
  assert.equal(unfinished.status, 2);
  assert.match(unfinished.stderr, /plan has unfinished tasks: T1, T3/);
  for (const id of ['T1', 'T3']) {
    ok(run(['start', id]));
    ok(run(['done', id, '--commit', 'HEAD']));
  }
  assert.equal(ok(run(['close'])).stdout, 'plan: active -> done\n');
  assert.match(read(join(repo, 'status.md')), /<!-- tasks:start -->\n## Active plan\n\nNo active plan\.\n<!-- tasks:end -->/);
  // A closed plan is no longer active: the default selection finds nothing, --plan still reaches it.
  assert.equal(ok(run(['close'])).stdout, 'plan: already done\n', 'an idempotent repeat without --plan');
  assert.equal(ok(run(['close', '--plan', PLAN_REL])).stdout, 'plan: already done\n');
  assert.equal(ok(run(['reopen', 'T1', 'regression', '--plan', PLAN_REL])).stdout, 'T1: done -> in_progress\n');
  assert.equal(readJson(join(repo, LEDGER_REL)).state, 'active');
}));

test('ambiguous ledger exits 2 and --plan selects', () => withRepo(({ repo, run }) => {
  committed(repo);
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-29-other.md'), PLAN);
  ok(run(['init', PLAN_REL]));
  ok(run(['init', 'docs/plans/2026-09-29-other.md']));
  const otherLedger = join(repo, 'docs', 'plans', '2026-09-29-other.tasks.json');
  for (const args of [['start', 'T1'], ['next']]) {
    const r = run(args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /2 active ledgers/);
    assert.ok(r.stderr.includes(join(repo, LEDGER_REL)), r.stderr);
    assert.ok(r.stderr.includes(otherLedger), r.stderr);
  }
  assert.equal(ok(run(['start', 'T1', '--plan', PLAN_REL])).stdout, 'T1: pending -> in_progress\n');
  assert.equal(ok(run(['start', 'T2', '--plan', otherLedger])).stdout, 'T2: pending -> in_progress\n');
  assert.equal(readJson(join(repo, LEDGER_REL)).tasks[0].status, 'in_progress');
  assert.equal(readJson(otherLedger).tasks[1].status, 'in_progress');
  // Both plans render, newest first.
  const status = read(join(repo, 'status.md'));
  assert.ok(status.indexOf('### 2026-09-29-other') < status.indexOf(`### ${NAME}`), status);
  const missing = run(['next', '--plan', 'docs/plans/none.md']);
  assert.equal(missing.status, 2);
}));

test('next prints the next task or none', () => withRepo(({ repo, run }) => {
  committed(repo, '# p\n\n### Task 1: Alpha\n');
  ok(run(['init', PLAN_REL]));
  assert.equal(ok(run(['next'])).stdout, 'T1 Alpha [roles:tdd-implementer]\n');
  ok(run(['start', 'T1']));
  assert.equal(ok(run(['next'])).stdout, 'none\n');
}));

test('status prints one line per active ledger and --json the summary', () => withRepo(({ repo, run }) => {
  committed(repo);
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-20-old.md'), '# p\n\n### Task 1: Only\n');
  ok(run(['init', PLAN_REL]));
  ok(run(['init', 'docs/plans/2026-09-20-old.md']));
  ok(run(['start', 'T1', '--plan', 'docs/plans/2026-09-20-old.md']));
  ok(run(['done', 'T1', '--commit', 'HEAD', '--plan', 'docs/plans/2026-09-20-old.md']));
  ok(run(['close', '--plan', 'docs/plans/2026-09-20-old.md']));
  ok(run(['start', 'T1']));
  ok(run(['drop', 'T2', 'later']));
  assert.equal(ok(run(['status'])).stdout, `${NAME}: 0/2 done · in progress: T1 · next: none\n`);
  assert.deepEqual(JSON.parse(ok(run(['status', '--json'])).stdout), [
    {
      name: NAME, ledgerPath: join(repo, LEDGER_REL), done: 0, total: 2, inProgress: ['T1'], next: null,
      tiers: { T1: { tier: null, effectiveTier: null } },
    },
  ]);
}));

test('status prints nothing and --json [] with no ledger', () => withRepo(({ repo, run }) => {
  committed(repo);
  assert.equal(ok(run(['status'])).stdout, '');
  assert.deepEqual(JSON.parse(ok(run(['status', '--json'])).stdout), []);
}));

test('check exits 1 on a stale status section and 0 after render', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  assert.equal(ok(run(['check'])).stdout, '');
  const status = read(join(repo, 'status.md'));
  writeFileSync(join(repo, 'status.md'), status.replace('0/3 done', '2/3 done'));
  const stale = run(['check']);
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, `${STALE}\n`);
  ok(run(['render']));
  assert.equal(read(join(repo, 'status.md')), status);
  assert.equal(ok(run(['check'])).stdout, '');
}));

test('check reports plan drift and an unresolved commit', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const ledgerPath = join(repo, LEDGER_REL);
  const ledger = readJson(ledgerPath);
  ledger.tasks[0].commits = ['0123456789abcdef0123456789abcdef01234567'];
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  writeFileSync(join(repo, PLAN_REL), `${PLAN}\n### Task 4: Delta\n`);
  const r = run(['check']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    'T4 is in the plan but not in the ledger — run triqual tasks init',
    'T1 commit 0123456 does not resolve',
    '',
  ].join('\n'));
}));

test('check over several ledgers prints a stale section once', () => withRepo(({ repo, run }) => {
  committed(repo);
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-29-other.md'), PLAN);
  ok(run(['init', PLAN_REL]));
  ok(run(['init', 'docs/plans/2026-09-29-other.md']));
  assert.equal(ok(run(['check'])).stdout, '');
  const status = read(join(repo, 'status.md'));
  writeFileSync(join(repo, 'status.md'), status.replace('### 2026-09-29-other', '### stale'));
  const r = run(['check']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${STALE}\n`);
}));

test('check over several ledgers prefixes per-ledger messages with the plan name', () => withRepo(({ repo, run }) => {
  committed(repo);
  const otherPlan = join(repo, 'docs', 'plans', '2026-09-29-other.md');
  writeFileSync(otherPlan, PLAN);
  ok(run(['init', PLAN_REL]));
  ok(run(['init', 'docs/plans/2026-09-29-other.md']));
  const ledgerPath = join(repo, LEDGER_REL);
  const ledger = readJson(ledgerPath);
  ledger.tasks[0].commits = ['0123456789abcdef0123456789abcdef01234567'];
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  writeFileSync(otherPlan, `${PLAN}\n### Task 4: Delta\n`);
  const status = read(join(repo, 'status.md'));
  writeFileSync(join(repo, 'status.md'), status.replace('### 2026-09-29-other', '### stale'));
  const r = run(['check']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    STALE,
    `${NAME}: T1 commit 0123456 does not resolve`,
    '2026-09-29-other: T4 is in the plan but not in the ledger — run triqual tasks init',
    '',
  ].join('\n'));
  // Markers stay shared and unprefixed too.
  writeFileSync(join(repo, 'status.md'), '# Status\n<!-- tasks:start -->\n');
  assert.match(run(['check']).stdout, /^status\.md tasks section is unterminated — fix/);
  // An unparsable ledger among several is prefixed like any per-ledger message.
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-29-other.tasks.json'), '{ not json');
  assert.match(run(['check']).stdout, /^2026-09-29-other: .*2026-09-29-other\.tasks\.json is not valid JSON$/m);
}));

test('check hints at hand-fixing misordered or unterminated markers',() => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const fix = ' — fix the <!-- tasks:start/end --> markers in status.md by hand';
  writeFileSync(join(repo, 'status.md'), '# Status\n<!-- tasks:end -->\n<!-- tasks:start -->\n');
  const misordered = run(['check']);
  assert.equal(misordered.status, 1);
  assert.equal(misordered.stdout, `status.md tasks section is misordered${fix}\n`);
  writeFileSync(join(repo, 'status.md'), '# Status\n<!-- tasks:start -->\n');
  const unterminated = run(['check']);
  assert.equal(unterminated.status, 1);
  assert.equal(unterminated.stdout, `status.md tasks section is unterminated${fix}\n`);
  // A transition refuses such a status.md before writing anything.
  const ledgerBefore = readFileSync(join(repo, LEDGER_REL));
  const start = run(['start', 'T1']);
  assert.equal(start.status, 2);
  assert.equal(start.stderr, `status.md tasks section is unterminated${fix}\n`);
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), ledgerBefore);
}));

test('check with status.md missing reports a stale section; render creates it', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  rmSync(join(repo, 'status.md'));
  const r = run(['check']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${STALE}\n`);
  ok(run(['render']));
  assert.ok(existsSync(join(repo, 'status.md')));
  ok(run(['check']));
}));

test('check reports an unparsable ledger as drift', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  writeFileSync(join(repo, LEDGER_REL), '{ not json');
  const r = run(['check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2026-09-28-example\.tasks\.json is not valid JSON/);
}));

test('check --staged reads the index', () => withRepo(({ repo, git, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const status = read(join(repo, 'status.md'));
  // Stage a stale status.md, then fix the working tree only.
  writeFileSync(join(repo, 'status.md'), status.replace('0/3 done', '2/3 done'));
  git('add', '-A');
  writeFileSync(join(repo, 'status.md'), status);
  ok(run(['check']));
  const staged = run(['check', '--staged']);
  assert.equal(staged.status, 1);
  assert.equal(staged.stdout, `${STALE}\n`);
  // From a subdirectory too.
  mkdirSync(join(repo, 'src'));
  assert.equal(run(['check', '--staged'], { cwd: join(repo, 'src') }).status, 1);
  // A ledger that is not staged is not checked: restage a matching status.md, stage a ledger with drift (exit 1),
  // then remove the ledger from the index (exit 0) while the working-tree copy stays.
  git('add', 'status.md');
  const ledger = readJson(join(repo, LEDGER_REL));
  writeFileSync(join(repo, LEDGER_REL), JSON.stringify({ ...ledger, version: 2 }, null, 2));
  git('add', LEDGER_REL);
  writeFileSync(join(repo, LEDGER_REL), JSON.stringify(ledger, null, 2));
  const drift = run(['check', '--staged']);
  assert.equal(drift.status, 1);
  assert.equal(drift.stdout, 'unsupported ledger version 2 (expected 1)\n');
  git('rm', '-qf', '--cached', LEDGER_REL);
  ok(run(['check', '--staged']));
}));

test('check verifies the section and done-ledger schema when no plan is active', () => withRepo(({ repo, git, run }) => {
  committed(repo, '# p\n\n### Task 1: Alpha\n');
  ok(run(['init', PLAN_REL]));
  ok(run(['start', 'T1']));
  ok(run(['done', 'T1', '--commit', 'HEAD']));
  const beforeClose = read(join(repo, 'status.md'));
  ok(run(['close']));
  const closed = read(join(repo, 'status.md'));
  assert.equal(ok(run(['check'])).stdout, '');
  // An interrupted close: the ledger is done but status.md still shows the plan.
  writeFileSync(join(repo, 'status.md'), beforeClose);
  const stale = run(['check']);
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, `${STALE}\n`);
  git('add', '-A');
  writeFileSync(join(repo, 'status.md'), closed);
  ok(run(['check']));
  const staged = run(['check', '--staged']);
  assert.equal(staged.status, 1);
  assert.equal(staged.stdout, `${STALE}\n`);
  // Junk between the markers with only done ledgers.
  writeFileSync(join(repo, 'status.md'), closed.replace('No active plan.', 'whatever'));
  assert.equal(run(['check']).status, 1);
  // Marker errors keep their hand-fix hint.
  writeFileSync(join(repo, 'status.md'), '# Status\n<!-- tasks:start -->\n');
  assert.match(run(['check']).stdout, /^status\.md tasks section is unterminated — fix the <!-- tasks:start\/end -->/);
  writeFileSync(join(repo, 'status.md'), closed);
  // A done ledger's schema is validated.
  const ledger = readJson(join(repo, LEDGER_REL));
  writeFileSync(join(repo, LEDGER_REL), JSON.stringify({ ...ledger, version: 2 }, null, 2));
  const schema = run(['check']);
  assert.equal(schema.status, 1);
  assert.equal(schema.stdout, 'unsupported ledger version 2 (expected 1)\n');
}));

test('a repeat transition re-renders a stale status.md (crash after the ledger save)', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const beforeStart = read(join(repo, 'status.md'));
  ok(run(['start', 'T1']));
  const afterStart = read(join(repo, 'status.md'));
  writeFileSync(join(repo, 'status.md'), beforeStart);
  assert.equal(ok(run(['start', 'T1'])).stdout, 'T1: already in_progress\n');
  assert.equal(read(join(repo, 'status.md')), afterStart);
}));

test('status and next skip an unreadable ledger with a warning; writes name its path', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const broken = join(repo, 'docs', 'plans', '2026-09-29-broken.tasks.json');
  const junk = join(repo, 'docs', 'plans', '2026-09-30-junk.tasks.json');
  writeFileSync(broken, '{}');
  writeFileSync(junk, '{ not json');
  const status = ok(run(['status']));
  assert.equal(status.stdout, `${NAME}: 0/3 done · in progress: none · next: T1\n`);
  assert.match(status.stderr, new RegExp(`^warning: skipping ${broken}: cannot be rendered: .+$`, 'm'));
  assert.match(status.stderr, new RegExp(`^warning: skipping ${junk}: not valid JSON$`, 'm'));
  assert.equal(JSON.parse(ok(run(['status', '--json'])).stdout).length, 1);
  const next = ok(run(['next']));
  assert.equal(next.stdout, 'T1 Alpha [roles:tdd-implementer]\n');
  assert.match(next.stderr, /warning: skipping .*2026-09-29-broken\.tasks\.json/);
  // Writes stay fail-closed, naming the file.
  writeFileSync(junk, '{"version":1,"state":"done","tasks":[]}');
  const ledgerBefore = readFileSync(join(repo, LEDGER_REL));
  for (const args of [['start', 'T1'], ['render'], ['start', 'T1', '--plan', broken]]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.ok(r.stderr.startsWith(`${broken} cannot be rendered: `), r.stderr);
  }
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), ledgerBefore);
  // A ledger that renders but has a malformed task: the transition error names the file too.
  rmSync(broken);
  const ledger = readJson(join(repo, LEDGER_REL));
  delete ledger.tasks[0].history;
  writeFileSync(join(repo, LEDGER_REL), JSON.stringify(ledger, null, 2));
  const noHistory = run(['start', 'T1']);
  assert.equal(noHistory.status, 2);
  assert.ok(noHistory.stderr.startsWith(`${join(repo, LEDGER_REL)} cannot be updated: `), noHistory.stderr);
}));

test('a ledger whose state is neither active nor done is not active and check reports it', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const ledger = readJson(join(repo, LEDGER_REL));
  writeFileSync(join(repo, LEDGER_REL), JSON.stringify({ ...ledger, state: 'paused' }, null, 2));
  assert.equal(ok(run(['status'])).stdout, '');
  const start = run(['start', 'T1']);
  assert.equal(start.status, 2);
  assert.match(start.stderr, /no active ledger/);
  const check = run(['check']);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^unknown plan state "paused"$/m);
  // Next to an active plan, the non-active ledger's message names its plan.
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-29-other.md'), PLAN);
  ok(run(['init', 'docs/plans/2026-09-29-other.md']));
  assert.equal(ok(run(['status'])).stdout, '2026-09-29-other: 0/3 done · in progress: none · next: T1\n');
  assert.equal(run(['check']).stdout, `${NAME}: unknown plan state "paused"\n`);
}));

test('init and --plan accept a plansDir that is a symlink', () => withRepo(({ repo, run }) => {
  committed(repo);
  const real = join(repo, 'plans-real');
  mkdirSync(real);
  copyFileSync(join(repo, PLAN_REL), join(real, `${NAME}.md`));
  rmSync(join(repo, 'docs', 'plans'), { recursive: true });
  symlinkSync(real, join(repo, 'docs', 'plans'));
  assert.equal(ok(run(['init', PLAN_REL])).stdout, `created ${join(repo, LEDGER_REL)}\n`);
  assert.equal(readJson(join(real, `${NAME}.tasks.json`)).plan, PLAN_REL);
  assert.equal(ok(run(['start', 'T1', '--plan', `plans-real/${NAME}.md`])).stdout, 'T1: pending -> in_progress\n');
  ok(run(['check']));
}));

test('check --staged honors GIT_INDEX_FILE (a temporary index during commit -a)', () => withRepo(({ repo, git, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  const status = read(join(repo, 'status.md'));
  writeFileSync(join(repo, 'status.md'), status.replace('0/3 done', '2/3 done'));
  git('add', '-A');
  const alt = join(repo, '.git', 'alt-index');
  copyFileSync(join(repo, '.git', 'index'), alt); // the alternate index keeps the stale status.md
  writeFileSync(join(repo, 'status.md'), status);
  git('add', 'status.md'); // the default index is now clean
  ok(run(['check', '--staged']));
  const viaAlt = run(['check', '--staged'], { extraEnv: { GIT_INDEX_FILE: alt } });
  assert.equal(viaAlt.status, 1);
  assert.equal(viaAlt.stdout, `${STALE}\n`);
}));

test('local mode: init/start/status/paths work with files under .git/methodology and nothing in the working tree', () => withRepo(({ repo, git, run }) => {
  const root = join(repo, '.git', 'methodology');
  mkdirSync(join(root, 'plans'), { recursive: true });
  writeFileSync(join(root, 'progress.md'), '# Progress\n');
  writeFileSync(join(root, 'plans', `${NAME}.md`), PLAN);
  const ledgerPath = join(root, 'plans', `${NAME}.tasks.json`);
  assert.equal(ok(run(['init', `.git/methodology/plans/${NAME}.md`, '--spec', join(root, 'specs', 's.md')])).stdout,
    `created ${ledgerPath}\n`);
  const ledger = readJson(ledgerPath);
  assert.equal(ledger.plan, `plans/${NAME}.md`);
  assert.equal(ledger.spec, 'specs/s.md');
  assert.equal(ok(run(['start', 'T1'])).stdout, 'T1: pending -> in_progress\n');
  assert.equal(ok(run(['status'])).stdout, `${NAME}: 0/3 done · in progress: T1 · next: T2\n`);
  assert.match(read(join(root, 'status.md')), /- In progress: T1 Alpha/);
  ok(run(['check']));
  ok(run(['check', '--staged']));
  assert.deepEqual(JSON.parse(ok(run(['paths', '--json'])).stdout), {
    optedIn: true,
    mode: 'local',
    root,
    progress: join(root, 'progress.md'),
    status: join(root, 'status.md'),
    plansDir: join(root, 'plans'),
    specsDir: join(root, 'specs'),
    duplicate: false,
    ...FACTS,
  });
  assert.equal(git('status', '--porcelain'), '');
}));

test('paths --json reports duplicate: true when both roots exist', () => withRepo(({ repo, run }) => {
  committed(repo);
  mkdirSync(join(repo, '.git', 'methodology'));
  writeFileSync(join(repo, '.git', 'methodology', 'progress.md'), '# Progress\n');
  const out = JSON.parse(ok(run(['paths', '--json'])).stdout);
  assert.deepEqual(out, {
    optedIn: true,
    mode: 'committed',
    root: repo,
    progress: join(repo, 'progress.md'),
    status: join(repo, 'status.md'),
    plansDir: join(repo, 'docs', 'plans'),
    specsDir: join(repo, 'docs', 'specs'),
    duplicate: true,
    ...FACTS,
  });
}));

test('not opted in exits 2 with the hint', () => withRepo(({ dir, run }) => {
  for (const args of [['status'], ['check'], ['start', 'T1'], ['next'], ['init', PLAN_REL]]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stderr, `${HINT}\n`);
  }
  const outside = run(['status'], { cwd: dir });
  assert.equal(outside.status, 2);
  assert.equal(outside.stderr, `${HINT}\n`);
}));

test('unknown subcommands and bad arguments print usage and exit 2', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  for (const args of [[], ['frobnicate'], ['start'], ['start', 'T1', 'extra'], ['start', 'T1', '--bogus'],
    ['paths'], ['init']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: triqual tasks/, args.join(' '));
  }
  const unknownTask = run(['start', 'T9']);
  assert.equal(unknownTask.status, 2);
  assert.equal(unknownTask.stderr, 'unknown task T9\n');
}));

test('the ledger createLedger builds matches what init writes', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL, '--branch', 'b', '--spec', 'docs/specs/s.md']));
  const written = readJson(join(repo, LEDGER_REL));
  const now = written.tasks[0].history[0].at;
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(written, createLedger({
    plan: PLAN_REL, spec: 'docs/specs/s.md', branch: 'b', tasks: parsePlan(PLAN), now,
  }));
}));

// ---- final fix wave ----

test('close without --plan and no ledger at all still exits 2', () => withRepo(({ repo, run }) => {
  committed(repo);
  const r = run(['close']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no active ledger/);
}));

test('a sha lost to rewritten history is recovered with reopen then done --commit, no hand edits', () => withRepo(({ repo, git, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  ok(run(['render']));
  ok(run(['start', 'T1']));
  ok(run(['done', 'T1', '--commit', 'HEAD']));
  // A fresh clone of a rewritten history: the recorded sha is not in this repo.
  const ledgerPath = join(repo, LEDGER_REL);
  const ledger = readJson(ledgerPath);
  ledger.tasks[0].commits = ['0123456789abcdef0123456789abcdef01234567'];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const drift = run(['check']);
  assert.equal(drift.status, 1);
  assert.equal(drift.stdout, 'T1 commit 0123456 does not resolve\n');
  ok(run(['reopen', 'T1', 'history rewritten']));
  ok(run(['done', 'T1', '--commit', 'HEAD']));
  assert.deepEqual(readJson(ledgerPath).tasks[0].commits, [git('rev-parse', 'HEAD')]);
  ok(run(['check']));
}));

test('--help and -h print the usage to stdout and exit 0, before any tracking resolution or write', () => withRepo(({ repo, home, git, run }) => {
  // Not opted in: a subcommand that resolved tracking would exit 2 with the opt-in hint instead.
  const usage = ok(run(['--help'])).stdout;
  assert.match(usage, /^usage: triqual tasks <subcommand> \[args\]\n/);
  for (const args of [['-h'], ['status', '--help'], ['done', 'T1', '-h'], ['init', 'docs/plans/x.md', '--help'], ['line', '--help']]) {
    const r = ok(run(args));
    assert.equal(r.stdout, usage, args.join(' '));
    assert.equal(r.stderr, '', args.join(' '));
  }
  assert.equal(git('status', '--porcelain', '--ignored'), '');
  assert.deepEqual(readdirSync(home), []);
}));

// ---- the tracking-root write lock (spec Addendum E.8) ----

// A short lock timeout, so a test of a held lock does not wait out the 5000 ms default.
const FAST_TIMEOUT = { CM_LOCK_TIMEOUT_MS: '300' };

// The Stop hook's stdout for `cwd` (empty: it does not block).
const stopHook = (cwd, home) => {
  const r = spawnSync(process.execPath, [GATE, 'stop'], {
    cwd, input: JSON.stringify({ cwd }), encoding: 'utf8', env: cleanEnv(home),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

// `triqual tasks <args>` without waiting: resolves with { status, stdout, stderr }.
const runAsync = (repo, home, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env: cleanEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', reject);
  child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
});

test('the tasks lock lives under the git common dir and never shows in git status or blocks the Stop hook', () => {
  // Committed mode: the tracking files are committed, so an untracked lock file in the working tree would be dirty.
  withRepo(({ repo, home, git, run }) => {
    committed(repo);
    const ledgerPath = join(repo, LEDGER_REL);
    const lockPath = join(repo, '.git', 'methodology', 'tasks.lock');
    ok(run(['init', PLAN_REL]));
    assert.equal(existsSync(dirname(lockPath)), true, 'the lock directory is created in committed mode too');
    assert.equal(existsSync(lockPath), false, 'released once the command ends');
    git('add', '-A');
    git(...ID, 'commit', '-qm', 'tracking');
    writeFileSync(lockPath, 'another session\n'); // held by another session
    assert.equal(git('status', '--porcelain', '--ignored', '--untracked-files=all'), '');
    assert.equal(stopHook(repo, home), '');
    const blocked = run(['start', 'T1'], { extraEnv: FAST_TIMEOUT });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stderr, `lock timeout: ${lockPath}\n`);
    assert.equal(readJson(ledgerPath).tasks[0].status, 'pending', 'nothing written without the lock');
    rmSync(lockPath);
    assert.equal(ok(run(['start', 'T1'])).stdout, 'T1: pending -> in_progress\n');
    assert.equal(existsSync(lockPath), false);
  });
  // Local mode: the lock sits in the tracking root itself, which is under the git common dir.
  withRepo(({ repo, home, git, run }) => {
    const root = join(repo, '.git', 'methodology');
    mkdirSync(join(root, 'plans'), { recursive: true });
    writeFileSync(join(root, 'progress.md'), '# Progress\n');
    writeFileSync(join(root, 'plans', `${NAME}.md`), PLAN);
    // No new entry since the last gated commit: any dirty file outside the tracking root would block the stop.
    writeFileSync(join(root, 'state.json'), JSON.stringify({
      version: 1, lastProgressSha256: createHash('sha256').update(read(join(root, 'progress.md'))).digest('hex'),
      pendingProgressSha256: null,
    }));
    const lockPath = join(root, 'tasks.lock');
    ok(run(['init', `.git/methodology/plans/${NAME}.md`]));
    assert.equal(existsSync(lockPath), false);
    writeFileSync(lockPath, 'another session\n');
    assert.equal(git('status', '--porcelain', '--ignored', '--untracked-files=all'), '');
    assert.equal(stopHook(repo, home), '');
    const blocked = run(['start', 'T1'], { extraEnv: FAST_TIMEOUT });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stderr, `lock timeout: ${lockPath}\n`);
    rmSync(lockPath);
    ok(run(['start', 'T1']));
    assert.equal(readJson(join(root, 'plans', `${NAME}.tasks.json`)).tasks[0].status, 'in_progress');
  });
});

test('two concurrent triqual tasks moves on different tasks both land in the ledger and status.md', () => withRepo(async ({ repo, home, run }) => {
  // Several rounds of two concurrent moves: each round is one chance for a lost update.
  const ROUNDS = 8;
  const ids = Array.from({ length: 2 * ROUNDS }, (_, i) => `T${i + 1}`);
  committed(repo, `# Example plan\n\n${ids.map((id) => `### Task ${id.slice(1)}: Task ${id}\n`).join('\n')}`);
  ok(run(['init', PLAN_REL]));
  const statusBefore = read(join(repo, 'status.md'));
  for (let r = 0; r < ROUNDS; r++) {
    const pair = ids.slice(2 * r, 2 * r + 2);
    const results = await Promise.all(pair.map((id) => runAsync(repo, home, ['start', id])));
    results.forEach((res, i) => assert.equal(res.status, 0, `${pair[i]}: ${res.stderr}`));
  }
  const ledger = readJson(join(repo, LEDGER_REL));
  assert.deepEqual(ledger.tasks.filter((x) => x.status !== 'in_progress').map((x) => x.id), [], 'every move landed');
  const unchanged = upsertStatusSection(statusBefore, renderSection([{ name: NAME, ledger }]));
  assert.equal(read(join(repo, 'status.md')), unchanged, 'status.md renders every move');
}));

test('two plans moved at once keep the status.md section right', () => withRepo(async ({ repo, home, run }) => {
  // status.md is rendered from every ledger, so a per-ledger lock could not protect it: each round moves one task in
  // each plan at the same moment, and the section must match both ledgers after every round (a later round's render
  // would hide an earlier stale one).
  const ROUNDS = 6;
  const OTHER = '2026-09-28-other';
  const planOf = (title) => `# ${title}\n\n${Array.from({ length: ROUNDS }, (_, i) => `### Task ${i + 1}: ${title} ${i + 1}\n`).join('\n')}`;
  committed(repo, planOf('Example'));
  writeFileSync(join(repo, 'docs', 'plans', `${OTHER}.md`), planOf('Other'));
  ok(run(['init', PLAN_REL]));
  ok(run(['init', `docs/plans/${OTHER}.md`]));
  const statusBefore = read(join(repo, 'status.md'));
  const plans = [[NAME, PLAN_REL], [OTHER, `docs/plans/${OTHER}.md`]];
  for (let r = 1; r <= ROUNDS; r++) {
    const results = await Promise.all(plans.map(([, rel]) => runAsync(repo, home, ['start', `T${r}`, '--plan', rel])));
    results.forEach((res, i) => assert.equal(res.status, 0, `${plans[i][0]}: ${res.stderr}`));
    const ledgers = plans.map(([name]) => ({ name, ledger: readJson(join(repo, 'docs', 'plans', `${name}.tasks.json`)) }));
    for (const { name, ledger } of ledgers) assert.equal(ledger.tasks[r - 1].status, 'in_progress', `${name} T${r}`);
    assert.equal(read(join(repo, 'status.md')), upsertStatusSection(statusBefore, renderSection(ledgers)), `round ${r}`);
  }
  ok(run(['check']));
}));

// ---- Plan 2026-09-28-sp3-orchestration · T11 (spec Addendum E.5, E.8) ----

test('paths --json outside an opted-in repo prints optedIn false with the message and the hook lines, exit 0', () => withRepo(({ dir, repo, run }) => {
  for (const cwd of [repo, dir]) { // a repo that is not opted in, and outside git
    const r = ok(run(['paths', '--json'], { cwd }));
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), { optedIn: false, ...FACTS });
  }
  assert.equal(run(['paths'], { cwd: dir }).status, 2, 'paths still requires --json');
}));

test('paths --json in an opted-in repo carries optedIn true and hook lines byte-equal to init\'s', () => withRepo(({ repo, home, run }) => {
  // What init --local really chains into the hooks.
  const init = spawnSync(process.execPath, [INIT, '--local'], { cwd: repo, env: cleanEnv(home), encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const out = JSON.parse(ok(run(['paths', '--json'])).stdout);
  assert.equal(out.optedIn, true);
  assert.equal(out.mode, 'local');
  assert.equal(out.notOptedInMessage, HINT);
  assert.deepEqual(Object.keys(out.localHookLines), ['pre-commit', 'post-commit']);
  for (const [hook, line] of Object.entries(out.localHookLines)) {
    const lines = read(join(repo, '.git', 'hooks', hook)).split('\n');
    assert.ok(lines.includes(line), `${hook} does not hold ${line}`);
  }
  assert.deepEqual(out.localHookLines, HOOK_LINES);
}));

test('LOCAL_HOOK_LINES and NOT_OPTED_IN are exported by scripts/init.mjs and bin/tasks.mjs, with no side effect', () => withRepo(({ dir, home }) => {
  const url = (p) => JSON.stringify(pathToFileURL(p).href);
  const code = `const i = await import(${url(INIT)}); const t = await import(${url(BIN)});
process.stdout.write(JSON.stringify([i.LOCAL_HOOK_LINES, i.NOT_OPTED_IN, t.LOCAL_HOOK_LINES, t.NOT_OPTED_IN]));`;
  // Run outside git with a temp HOME: importing must neither run init nor a triqual tasks subcommand.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: cleanEnv(home), encoding: 'utf8' });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), [HOOK_LINES, HINT, HOOK_LINES, HINT]);
  assert.deepEqual(readdirSync(home), [], 'nothing registered');
}));

test('triqual tasks init rejects a dependency on an unknown task id', () => withRepo(({ repo, run }) => {
  committed(repo, '# p\n\n### Task 1: A\n\n### Task 2: B\n**Depends on:** T1, T9\n');
  const statusBefore = read(join(repo, 'status.md'));
  const r = run(['init', PLAN_REL]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'T2 depends on T9 (unknown task)\n');
  assert.equal(existsSync(join(repo, LEDGER_REL)), false);
  assert.equal(read(join(repo, 'status.md')), statusBefore);
  // Reconciling an existing ledger checks the plan the same way.
  writeFileSync(join(repo, PLAN_REL), PLAN);
  ok(run(['init', PLAN_REL]));
  const ledgerBefore = read(join(repo, LEDGER_REL));
  writeFileSync(join(repo, PLAN_REL), `${PLAN}\n### Task 4: Delta\n**Depends on:** T3, T7\n`);
  const again = run(['init', PLAN_REL]);
  assert.equal(again.status, 2);
  assert.equal(again.stderr, 'T4 depends on T7 (unknown task)\n');
  assert.equal(read(join(repo, LEDGER_REL)), ledgerBefore);
}));

// A local-mode repo as progress-init --local leaves it: the tracking root under the git dir, plans/ and specs/ in it.
function localMode(repo) {
  const root = join(repo, '.git', 'methodology');
  mkdirSync(join(root, 'plans'), { recursive: true });
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'progress.md'), '# Progress\n');
  writeFileSync(join(root, 'status.md'), '# Status\n');
  return root;
}

test('triqual tasks init --adopt copies a plan from outside the repo into plansDir and creates its ledger', () => withRepo(({ dir, repo, git, run }) => {
  const root = localMode(repo);
  const draft = join(dir, 'drafts', `${NAME}.md`);
  mkdirSync(dirname(draft));
  writeFileSync(draft, PLAN);
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const planPath = join(commonDir, 'methodology', 'plans', `${NAME}.md`);
  const ledgerPath = join(root, 'plans', `${NAME}.tasks.json`);
  const r = ok(run(['init', '--adopt', draft]));
  assert.equal(r.stdout, `created ${ledgerPath}\n`);
  assert.equal(read(planPath), PLAN, 'the copy is under the git common dir');
  assert.equal(read(draft), PLAN, 'the draft is left in place');
  const ledger = readJson(ledgerPath);
  assert.equal(ledger.plan, `plans/${NAME}.md`);
  assert.deepEqual(ledger.tasks.map((t) => t.id), ['T1', 'T2', 'T3']);
  assert.match(read(join(root, 'status.md')), /### 2026-09-28-example — 0\/3 done/);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(readdirSync(join(root, 'plans')).sort(), [`${NAME}.md`, `${NAME}.tasks.json`], 'no temp file left');
  // Committed mode: the copy lands in docs/plans.
  const other = join(dir, 'drafts', '2026-09-29-other.md');
  writeFileSync(other, '# p\n\n### Task 1: Only\n');
  rmSync(root, { recursive: true });
  committed(repo);
  assert.equal(ok(run(['init', other, '--adopt'])).stdout,
    `created ${join(repo, 'docs', 'plans', '2026-09-29-other.tasks.json')}\n`);
  assert.equal(read(join(repo, 'docs', 'plans', '2026-09-29-other.md')), '# p\n\n### Task 1: Only\n');
}));

test('--adopt refuses an existing plan name', () => withRepo(({ dir, repo, run }) => {
  const root = localMode(repo);
  const existing = join(root, 'plans', `${NAME}.md`);
  writeFileSync(existing, '# kept\n\n### Task 1: Kept\n');
  const draft = join(dir, `${NAME}.md`);
  writeFileSync(draft, PLAN);
  const r = run(['init', '--adopt', draft]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `plan ${NAME}.md already exists\n`);
  assert.equal(read(existing), '# kept\n\n### Task 1: Kept\n');
  assert.equal(existsSync(join(root, 'plans', `${NAME}.tasks.json`)), false);
  // The same file named again (already in plansDir) is refused too: plain init handles it.
  const again = run(['init', '--adopt', existing]);
  assert.equal(again.status, 2);
  assert.equal(again.stderr, `plan ${NAME}.md already exists\n`);
}));

test('--adopt copies nothing when the draft is not a usable plan', () => withRepo(({ dir, repo, run }) => {
  const root = localMode(repo);
  const cases = [
    ['unclosed.md', '### Task 1: A\n```\ncode\n', 'unclosed code fence opened at line 2'],
    ['baddep.md', '### Task 1: A\n**Depends on:** T5\n', 'T1 depends on T5 (unknown task)'],
  ];
  for (const [name, text, message] of cases) {
    writeFileSync(join(dir, name), text);
    const r = run(['init', '--adopt', join(dir, name)]);
    assert.equal(r.status, 2, name);
    assert.equal(r.stderr, `${message}\n`, name);
  }
  const missing = run(['init', '--adopt', join(dir, 'nope.md')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /plan .*nope\.md not found/);
  writeFileSync(join(dir, 'notes.txt'), PLAN);
  assert.equal(run(['init', '--adopt', join(dir, 'notes.txt')]).status, 2);
  assert.deepEqual(readdirSync(join(root, 'plans')), []);
}));

test('next shows the role', () => withRepo(({ repo, run }) => {
  committed(repo, '# p\n\n### Task 1: Alpha\n\n### Task 2: Title\n**Depends on:** T1\n**Role:** coordinator\n'
    + '\n### Task 3: Gamma\n**Depends on:** T2\n**Role:** roles:complex-implementer\n');
  ok(run(['init', PLAN_REL]));
  assert.equal(ok(run(['next'])).stdout, 'T1 Alpha [roles:tdd-implementer]\n');
  ok(run(['start', 'T1']));
  ok(run(['done', 'T1', '--commit', 'HEAD']));
  assert.equal(ok(run(['next'])).stdout, 'T2 Title [coordinator]\n');
  ok(run(['start', 'T2']));
  ok(run(['done', 'T2', '--commit', 'HEAD']));
  assert.equal(ok(run(['next'])).stdout, 'T3 Gamma [roles:complex-implementer]\n');
  assert.equal(ok(run(['check'])).stdout, '');
}));

test('check flags a task role outside coordinator, roles:tdd-implementer, roles:complex-implementer and roles:review-fixer', () => withRepo(({ repo, run }) => {
  committed(repo, [
    '# p', '', '### Task 1: A', '**Role:** roles:tdd-implemnter', '', '### Task 2: B', '**Role:** roles:spec-reviewer',
    '', '### Task 3: C', '**Role:** roles:review-fixer', '', '### Task 4: D', '**Role:** coordinator', '',
    '### Task 5: E', '**Role:** roles:complex-implementer', '',
  ].join('\n'));
  ok(run(['init', PLAN_REL])); // init stores the roles as parsed; check reports them
  const r = run(['check']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, '');
  const tail = 'not a task role (coordinator, roles:tdd-implementer, roles:complex-implementer, roles:review-fixer)';
  assert.equal(r.stdout, `T1 has role "roles:tdd-implemnter", ${tail}\nT2 has role "roles:spec-reviewer", ${tail}\n`);
}));

// ---- Plan sp3-orchestration · T11 · fix 1 ----

test('--adopt removes its copy when a later init step fails, so the name stays free', () => withRepo(({ dir, repo, run }) => {
  const root = localMode(repo);
  const draft = join(dir, `${NAME}.md`);
  writeFileSync(draft, PLAN);
  const copy = join(root, 'plans', `${NAME}.md`);
  // status.md with misordered markers: init refuses at the render, after the copy.
  const status = join(root, 'status.md');
  writeFileSync(status, '# Status\n<!-- tasks:end -->\n<!-- tasks:start -->\n');
  const marker = run(['init', '--adopt', draft]);
  assert.equal(marker.status, 2);
  assert.match(marker.stderr, /^status\.md tasks section is misordered/);
  assert.equal(existsSync(copy), false, 'no orphan copy');
  // An unreadable ledger already under the plan's name: init refuses at its read, after the copy.
  writeFileSync(status, '# Status\n');
  const ledgerPath = join(root, 'plans', `${NAME}.tasks.json`);
  writeFileSync(ledgerPath, '{ not json');
  const junk = run(['init', '--adopt', draft]);
  assert.equal(junk.status, 2);
  assert.equal(junk.stderr, `${ledgerPath} is not valid JSON\n`);
  assert.equal(existsSync(copy), false, 'no orphan copy');
  assert.equal(read(ledgerPath), '{ not json', 'a ledger the run did not create is left alone');
  // Fixed, the same draft adopts.
  rmSync(ledgerPath);
  assert.equal(ok(run(['init', '--adopt', draft])).stdout, `created ${ledgerPath}\n`);
  assert.equal(read(copy), PLAN);
}));

test('importing scripts/init.mjs or bin/tasks.mjs never throws on an argv[1] that does not resolve', () => withRepo(({ dir, home }) => {
  for (const file of [INIT, BIN]) {
    const code = `await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write('imported');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, join(dir, 'no-such-entry.mjs')],
      { cwd: dir, env: cleanEnv(home), encoding: 'utf8' });
    assert.equal(r.stderr, '', file);
    assert.equal(r.status, 0, file);
    assert.equal(r.stdout, 'imported', file);
  }
}));

test('init treats the existing ledger\'s ids as known dependencies', () => withRepo(({ repo, run }) => {
  committed(repo, '# p\n\n### Task 1: Alpha\n\n### Task 2: Beta\n');
  ok(run(['init', PLAN_REL]));
  ok(run(['drop', 'T2', 'folded into T3']));
  // T2's heading leaves the plan (its drop records the removal); T3 still names it.
  writeFileSync(join(repo, PLAN_REL), '# p\n\n### Task 1: Alpha\n\n### Task 3: Gamma\n**Depends on:** T1, T2\n');
  const r = ok(run(['init', PLAN_REL]));
  assert.match(r.stdout, /added T3; missing T2;/);
  assert.deepEqual(readJson(join(repo, LEDGER_REL)).tasks.find((t) => t.id === 'T3').deps, ['T1', 'T2']);
  // An id in neither the plan nor the ledger is still refused.
  writeFileSync(join(repo, PLAN_REL), '# p\n\n### Task 1: Alpha\n\n### Task 3: Gamma\n**Depends on:** T1, T2, T8\n');
  const bad = run(['init', PLAN_REL]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, 'T3 depends on T8 (unknown task)\n');
}));

// ---- tiers: registration rule, retier, views (plan methodology-1.0 T3) ----

const tiered = (...tiers) => `# Tiered plan\n\n${tiers.map((tier, i) => `### Task ${i + 1}: Task ${i + 1}\n${tier ? `**Tier:** ${tier}\n` : ''}`).join('\n')}`;
const PARTLY = tiered('heavy', null, 'light');
const FULL = tiered('heavy', 'standard', 'light');

test('init rejects a partly tiered plan, names the tasks without a tier and creates no ledger', () => withRepo(({ repo, run }) => {
  committed(repo, PARTLY);
  const statusBefore = read(join(repo, 'status.md'));
  const r = run(['init', PLAN_REL]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /the plan declares tiers but T2 has none/);
  assert.equal(existsSync(join(repo, LEDGER_REL)), false, 'no ledger');
  assert.equal(read(join(repo, 'status.md')), statusBefore, 'status.md untouched');
}));

test('init rejects a coordinator that is not light in a tiered plan', () => withRepo(({ repo, run }) => {
  committed(repo, '# p\n\n### Task 1: A\n**Role:** coordinator\n**Tier:** heavy\n');
  const r = run(['init', PLAN_REL]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /T1: role coordinator requires tier light, not heavy/);
  assert.equal(existsSync(join(repo, LEDGER_REL)), false);
}));

test('init accepts a tierless plan and a fully tiered plan', () => withRepo(({ repo, run }) => {
  committed(repo);
  ok(run(['init', PLAN_REL]));
  assert.deepEqual(readJson(join(repo, LEDGER_REL)).tasks.map((t) => [t.tier, t.effectiveTier]), [[null, null], [null, null], [null, null]]);
  rmSync(join(repo, LEDGER_REL));
  writeFileSync(join(repo, PLAN_REL), FULL);
  ok(run(['init', PLAN_REL]));
  assert.deepEqual(readJson(join(repo, LEDGER_REL)).tasks.map((t) => [t.tier, t.effectiveTier]),
    [['heavy', 'heavy'], ['standard', 'standard'], ['light', 'light']]);
}));

test('init on an existing ledger does not validate: a partly tiered plan reconciles', () => withRepo(({ repo, run }) => {
  committed(repo, tiered(null, null, null));
  ok(run(['init', PLAN_REL]));
  writeFileSync(join(repo, PLAN_REL), PARTLY);
  const r = ok(run(['init', PLAN_REL]));
  assert.match(r.stdout, /^reconciled /);
  assert.deepEqual(readJson(join(repo, LEDGER_REL)).tasks.map((t) => t.tier), ['heavy', null, 'light']);
}));

test('init --adopt rejects a partly tiered draft and leaves no copy and no ledger', () => withRepo(({ dir, repo, run }) => {
  const root = localMode(repo);
  const draft = join(dir, `${NAME}.md`);
  writeFileSync(draft, PARTLY);
  const r = run(['init', '--adopt', draft]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the plan declares tiers but T2 has none/);
  assert.deepEqual(readdirSync(join(root, 'plans')), []);
}));

const retierRun = (run, ...args) => run(['retier', ...args]);

test('retier raises the effective tier, keeps the declared one and records the reason in the history', () => withRepo(({ repo, run }) => {
  committed(repo, FULL);
  ok(run(['init', PLAN_REL]));
  const r = ok(retierRun(run, 'T3', 'heavy', '--reason', 'touches the gate'));
  assert.equal(r.stdout, 'T3: light -> heavy\n');
  const t = readJson(join(repo, LEDGER_REL)).tasks.find((x) => x.id === 'T3');
  assert.equal(t.tier, 'light', 'declared tier is kept');
  assert.equal(t.effectiveTier, 'heavy');
  assert.equal(t.history.at(-1).note, 'touches the gate');
  assert.equal(t.history.at(-1).from, 'pending');
  assert.equal(t.history.at(-1).to, 'pending');
  assert.equal(t.reason, null, 'the task reason is not a retier reason');
  assert.equal(ok(run(['status'])).stdout, `${NAME}: 0/3 done · in progress: none · next: T1 [heavy]\n`);
  // A task with no tier counts as standard, so standard is a no-op and heavy raises it.
  committed(repo, '# p\n\n### Task 1: A\n');
  rmSync(join(repo, LEDGER_REL));
  ok(run(['init', PLAN_REL]));
  assert.equal(ok(retierRun(run, 'T1', 'standard', '--reason', 'x')).stdout, 'T1: already standard\n');
  assert.equal(ok(retierRun(run, 'T1', 'heavy', '--reason', 'x')).stdout, 'T1: standard -> heavy\n');
}));

test('retier to the same tier is a no-op that leaves the ledger byte-identical', () => withRepo(({ repo, run }) => {
  committed(repo, FULL);
  ok(run(['init', PLAN_REL]));
  const before = readFileSync(join(repo, LEDGER_REL));
  const status = readFileSync(join(repo, 'status.md'));
  const r = ok(retierRun(run, 'T1', 'heavy', '--reason', 'again'));
  assert.equal(r.stdout, 'T1: already heavy\n');
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), before);
  assert.deepEqual(readFileSync(join(repo, 'status.md')), status);
}));

test('retier refuses a lower tier, an unknown tier or task and a missing reason, and changes nothing', () => withRepo(({ repo, run }) => {
  committed(repo, FULL);
  ok(run(['init', PLAN_REL]));
  const before = readFileSync(join(repo, LEDGER_REL));
  const lower = retierRun(run, 'T1', 'light', '--reason', 'cheaper');
  assert.equal(lower.status, 2);
  assert.match(lower.stderr, /T1: cannot lower the tier from heavy to light/);
  const unknownTier = retierRun(run, 'T1', 'huge', '--reason', 'x');
  assert.equal(unknownTier.status, 2);
  assert.match(unknownTier.stderr, /unknown tier "huge" \(expected heavy, standard, light\)/);
  const unknownTask = retierRun(run, 'T9', 'heavy', '--reason', 'x');
  assert.equal(unknownTask.status, 2);
  assert.match(unknownTask.stderr, /unknown task T9/);
  for (const args of [['T3', 'heavy'], ['T3', 'heavy', '--reason', '  ']]) {
    const r = retierRun(run, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /T3: retier requires a reason/);
  }
  assert.deepEqual(readFileSync(join(repo, LEDGER_REL)), before);
}));

test('status --json and next --json carry tier and effectiveTier', () => withRepo(({ repo, run }) => {
  committed(repo, FULL);
  ok(run(['init', PLAN_REL]));
  ok(run(['start', 'T1']));
  ok(retierRun(run, 'T2', 'heavy', '--reason', 'risky'));
  const [s] = JSON.parse(ok(run(['status', '--json'])).stdout);
  assert.deepEqual(s.inProgress, ['T1']);
  assert.equal(s.next, 'T2');
  assert.deepEqual(s.tiers, { T1: { tier: 'heavy', effectiveTier: 'heavy' }, T2: { tier: 'standard', effectiveTier: 'heavy' } });
  assert.deepEqual(JSON.parse(ok(run(['next', '--json'])).stdout), {
    id: 'T2', title: 'Task 2', role: 'roles:tdd-implementer', tier: 'standard', effectiveTier: 'heavy',
  });
  ok(run(['start', 'T2']));
  ok(run(['start', 'T3']));
  assert.equal(ok(run(['next', '--json'])).stdout, 'null\n');
}));

test('export --json includes tier and effectiveTier per task', () => withRepo(({ repo, run }) => {
  committed(repo, FULL);
  ok(run(['init', PLAN_REL]));
  ok(retierRun(run, 'T3', 'heavy', '--reason', 'risky'));
  const snap = JSON.parse(ok(run(['export', '--json'])).stdout);
  assert.deepEqual(snap.plans[0].tasks.map((t) => [t.id, t.tier, t.effectiveTier]),
    [['T1', 'heavy', 'heavy'], ['T2', 'standard', 'standard'], ['T3', 'light', 'heavy']]);
}));

test('retier and next --json are listed in the usage', () => withRepo(({ repo, run }) => {
  committed(repo);
  const r = ok(run(['--help']));
  assert.match(r.stdout, /retier T<N> <tier> --reason "<text>" \[--plan <plan\.md\|ledger>\]/);
  assert.match(r.stdout, /next \[--plan <plan\.md\|ledger>\] \[--json\]/);
}));
