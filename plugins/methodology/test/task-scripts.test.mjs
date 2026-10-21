// task-open, task-prep and task-close (thin controller, T1 and T2): the scripts that fold a task's start, its review
// preparation and its close into one call each. Every test runs the real scripts in a temp git repo with a temp HOME.
// The tracking CLI is the real `triqual tasks` code of the progress-tracking plugin, reached through a `triqual` wrapper on a private PATH that logs
// every call (the installed shim would pick the plugin out of the machine's Claude install); the opted-in repos are in
// store mode, with TRIQUAL_TRACKING_DB pointing into the temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../../progress-tracking/lib/store.mjs';
import { codexRoleModel } from '../cli/lib/agents.mjs';
import { validateRecord } from '../cli/lib/role-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = 'demo-plan.md';
const PLAN = `# Demo plan

## Global Constraints

- Nothing.

### Task 1: Standard task

**Tier:** standard
**Role:** roles:tdd-implementer

- [ ] **Step 1:** one.

### Task 2: Security task

**Tier:** heavy
Security-relevant code: a permission check.
**Role:** roles:tdd-implementer

- [ ] **Step 1:** two.

### Task 3: State task

**Tier:** heavy
Live state: a store migration.
**Role:** roles:tdd-implementer

- [ ] **Step 1:** three.

### Task 4: Contract task

**Tier:** heavy
Contract: machine-read CLI output.
**Role:** roles:tdd-implementer

- [ ] **Step 1:** four.

### Task 5: Heavy task without a reason line

**Tier:** heavy
**Role:** roles:tdd-implementer

- [ ] **Step 1:** five.

### Task 6: No code

**Tier:** standard
**Role:** roles:tdd-implementer

- [ ] **Step 1:** six.

### Task 7: Light task

**Tier:** light
**Role:** roles:tdd-implementer

- [ ] **Step 1:** seven.
`;

await loadSqlite();

// A clean environment: no GIT_* from a calling hook, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB']) delete env[k];
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
};

// `triqual <command> ...` as the installed shim runs it, but straight into this repo's progress-tracking CLI, with the call
// logged to $TRIQUAL_CALL_LOG so a test can say which moves a script made.
const WRAPPER = `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [command, ...rest] = process.argv.slice(2);
const cli = { tasks: ${JSON.stringify(PT_CLI)} + '/tasks.mjs', tracking: ${JSON.stringify(PT_CLI)} + '/tracking.mjs', 'role-eval': ${JSON.stringify(ROLE_EVAL_CLI)} }[command];
if (!cli) { process.stderr.write('triqual: unknown command ' + command + '\\n'); process.exit(1); }
appendFileSync(process.env.TRIQUAL_CALL_LOG, [command, ...rest].join(' ') + '\\n');
// A test makes a move fail by creating "<log>.fail-<subcommand>".
if (existsSync(process.env.TRIQUAL_CALL_LOG + '.fail-' + rest[0])) { process.stderr.write('triqual: forced failure of ' + rest[0] + '\\n'); process.exit(1); }
const res = spawnSync(process.execPath, [cli, ...rest], { stdio: 'inherit' });
process.exit(res.status ?? 1);
`;

// A repo with one commit holding the plan (store: the plan lives in the store's plans directory and is registered, the repo
// is opted in; otherwise it is committed under docs/plans and the repo is not opted in). `r.plan` is the PLAN_FILE argument.
function rig({ store = true, local = false, planText = PLAN } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-scripts-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  const log = join(root, 'triqual.log');
  const dbEnv = { TRIQUAL_TRACKING_DB: join(root, 'data', 'tracking.db') };
  const evalFile = join(root, 'role-eval.jsonl');
  for (const d of [home, dir, bin]) mkdirSync(d);
  // The roles plugin as Claude Code records its install: task-close reads the hunter's model from its agent file.
  const rolesDir = join(home, '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9');
  mkdirSync(join(rolesDir, 'agents'), { recursive: true });
  writeFileSync(join(rolesDir, 'agents', 'hunter.md'), '---\nname: hunter\ndescription: "Hunts."\nmodel: claude-haiku-4-9\neffort: medium\n---\n\nBody.\n');
  const installed = join(home, '.claude', 'plugins', 'installed_plugins.json');
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'roles@triqual': [{ scope: 'user', installPath: rolesDir, version: '9.9.9', lastUpdated: '2026-10-19T15:07:03.965Z' }] } }));
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  writeFileSync(log, '');
  const env = cleanEnv(home, { ...dbEnv, ROLE_EVAL_FILE: evalFile, PATH: `${bin}${delimiter}${process.env.PATH}`, TRIQUAL_CALL_LOG: log });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const triqual = (...args) => spawnSync(join(bin, 'triqual'), args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  let plan;
  if (local) {
    // Local mode: the progress file lives in <git dir>/methodology, and so does the plan.
    const methodology = join(dir, '.git', 'methodology');
    mkdirSync(join(methodology, 'plans'), { recursive: true });
    writeFileSync(join(methodology, 'progress.md'), '# Progress\n');
    writeFileSync(join(methodology, 'status.md'), '# Status\n');
    plan = join(methodology, 'plans', PLAN_NAME);
    writeFileSync(plan, planText);
    const init = triqual('tasks', 'init', plan);
    assert.equal(init.status, 0, init.stderr);
  } else if (store) {
    git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
    const plansDir = JSON.parse(triqual('tasks', 'paths', '--json').stdout).plansDir;
    mkdirSync(plansDir, { recursive: true });
    plan = join(plansDir, PLAN_NAME);
    writeFileSync(plan, planText);
    const init = triqual('tasks', 'init', plan);
    assert.equal(init.status, 0, init.stderr);
  } else {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    plan = join('docs', 'plans', PLAN_NAME);
    writeFileSync(join(dir, plan), planText);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  writeFileSync(log, '');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const runIn = (cwd, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, env, encoding: 'utf8' });
  return {
    root, dir, git, env, plan, workspace, triqual, installed, evalFile,
    run: (script, ...args) => runIn(dir, script, ...args),
    runIn,
    head: () => git('rev-parse', 'HEAD').trim(),
    commit(file, text, message = `edit ${file}`) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
      git('add', '-A', '--', '.', ':(exclude).methodology');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    appendLedger: (...lines) => appendFileSync(ledgerPath, lines.map((l) => `${l}\n`).join('')),
    seedLedger: (...lines) => {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(ledgerPath, `# SDD ledger — plan: ${plan}\n${lines.map((l) => `${l}\n`).join('')}`);
    },
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    clearCalls: () => writeFileSync(log, ''),
    failMove: (name) => writeFileSync(`${log}.fail-${name}`, ''),
    allowMove: (name) => rmSync(`${log}.fail-${name}`, { force: true }),
    taskState: (n) => {
      const snapshot = JSON.parse(triqual('tasks', 'export', '--json').stdout);
      return snapshot.plans.find((p) => p.name === 'demo-plan').tasks.find((t) => t.id === `T${n}`);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const withRig = (opts, fn) => {
  const r = rig(opts);
  try {
    return fn(r);
  } finally {
    r.cleanup();
  }
};

const ok = (res) => {
  assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
};
// `key: value` stdout -> the lines split at the first ": ", in order.
const pairs = (res) => res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  assert.ok(at > 0, `not a key: value line: ${line}`);
  return [line.slice(0, at), line.slice(at + 2)];
});
const keys = (res) => pairs(res).map(([k]) => k);
const out = (res) => Object.fromEntries(pairs(res));
const open = (r, n) => out(ok(r.run('task-open', r.plan, String(n))));

// ---- task-open ----

test('task-open: starts the task, writes the brief, records BASE once', () => withRig({}, (r) => {
  const base = r.head();
  const first = ok(r.run('task-open', r.plan, '1'));
  assert.deepEqual(keys(first), ['brief', 'report', 'base']);
  const o = out(first);
  assert.equal(o.brief, join(r.workspace, 'task-1-brief.md'));
  assert.equal(o.report, join(r.workspace, 'task-1-report.md'));
  assert.equal(o.base, base);
  assert.match(readFileSync(o.brief, 'utf8'), /^### Task 1: Standard task/);
  assert.equal(r.taskState(1).status, 'in_progress');
  assert.deepEqual(r.ledger(), [`BASE: T1 ${base}`]);

  r.commit('src/a.js', 'a\n');
  const second = ok(r.run('task-open', r.plan, '1'));
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(r.ledger(), [`BASE: T1 ${base}`], 'a second BASE line was added');
}));

test('task-open: without tracking no triqual tasks move is made, and the output is the same', () => withRig({ store: false }, (r) => {
  const base = r.head();
  const res = ok(r.run('task-open', r.plan, '1'));
  assert.deepEqual(keys(res), ['brief', 'report', 'base']);
  assert.equal(out(res).base, base);
  assert.ok(existsSync(out(res).brief));
  assert.deepEqual(r.ledger(), [`BASE: T1 ${base}`]);
  const moves = r.calls().filter((c) => !c.startsWith('tasks paths'));
  assert.deepEqual(moves, [], 'a triqual call other than the opt-in probe');
}));

test('task-open: a task already in_review or done is not moved again', () => withRig({}, (r) => {
  open(r, 1);
  ok(r.triqual('tasks', 'review', 'T1', '--plan', PLAN_NAME));
  open(r, 2);
  ok(r.triqual('tasks', 'review', 'T2', '--plan', PLAN_NAME));
  ok(r.triqual('tasks', 'done', 'T2', '--commit', 'HEAD', '--plan', PLAN_NAME));
  const before = r.ledger();
  r.clearCalls();

  const reviewed = ok(r.run('task-open', r.plan, '1'));
  const done = ok(r.run('task-open', r.plan, '2'));
  assert.deepEqual(keys(reviewed), ['brief', 'report', 'base']);
  assert.deepEqual(keys(done), ['brief', 'report', 'base']);
  assert.equal(r.taskState(1).status, 'in_review');
  assert.equal(r.taskState(2).status, 'done');
  assert.deepEqual(r.ledger(), before);
  assert.deepEqual(r.calls().filter((c) => /^tasks (start|review|rework|done|retier) /.test(c)), [], 'a move was made');
}));

test('task-open reads the last BASE line', () => withRig({}, (r) => {
  const first = r.head();
  const second = r.commit('src/a.js', 'a\n');
  r.seedLedger(`BASE: T1 ${first}`, `BASE: T2 ${first}`, `BASE: T1 ${second}`);
  assert.equal(open(r, 1).base, second);
  assert.equal(open(r, 2).base, first);
  assert.equal(r.ledger().filter((l) => l.startsWith('BASE:')).length, 3, 'a BASE line was added');
}));

// ---- task-prep ----

// A task's whole first round: open, commit one small file, prep.
const firstRound = (r, n, extra = []) => {
  const o = open(r, n);
  const head = r.commit(`src/t${n}.js`, `export const t${n} = ${n};\n`);
  const res = ok(r.run('task-prep', r.plan, String(n), ...extra));
  return { o, head, res, out: out(res) };
};

test('task-prep: first round runs review move, tier-check and the package', () => withRig({}, (r) => {
  const picks = { 1: 'none', 2: 'correctness,security', 3: 'correctness,state', 4: 'correctness,state', 5: 'correctness,security' };
  for (const [n, hunters] of Object.entries(picks)) {
    const { o, head, res, out: o2 } = firstRound(r, n);
    assert.deepEqual(keys(res), ['tier', 'hunters', 'package', 'round', 'full-review'], `T${n}`);
    assert.equal(o2.tier, n === '1' ? 'standard' : 'heavy', `T${n} tier`);
    assert.equal(o2.hunters, hunters, `T${n} hunters`);
    assert.equal(o2.round, '1', `T${n} round`);
    assert.equal(o2['full-review'], 'no', `T${n} full-review`);
    assert.equal(o2.package, join(r.workspace, `review-${o.base.slice(0, 7)}..${head.slice(0, 7)}.diff`), `T${n} package`);
    assert.match(readFileSync(o2.package, 'utf8'), new RegExp(`^# Review package: ${o.base}\\.\\.${head}`), `T${n} package header`);
    assert.equal(r.taskState(Number(n)).status, 'in_review', `T${n} state`);
    assert.ok(r.ledger().includes(`Prep: T${n} r1 ${head}`), `T${n} Prep line`);
  }
  assert.equal(r.ledger().filter((l) => l.startsWith('Tier raised:')).length, 0);
}));

test('task-prep: a raise retiers and writes the Tier raised line', () => withRig({}, (r) => {
  const o = open(r, 1);
  const big = r.commit('src/big.js', Array.from({ length: 301 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  const res = ok(r.run('task-prep', r.plan, '1'));
  const got = out(res);
  assert.equal(got.tier, 'heavy');
  assert.equal(got.hunters, 'correctness,security', 'a task raised to heavy has no reason line: security by default');
  assert.equal(got.round, '1');
  assert.ok(existsSync(got.package));
  assert.equal(r.taskState(1).effectiveTier, 'heavy');
  const raised = r.ledger().filter((l) => l.startsWith('Tier raised:'));
  assert.deepEqual(raised, ['Tier raised: T1 standard → heavy — 301 changed lines (over 300): src/big.js']);
  assert.ok(r.calls().includes(`tasks retier T1 heavy --reason 301 changed lines (over 300): src/big.js --plan ${r.plan}`));
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Prep:')), [`Prep: T1 r1 ${big}`]);
  assert.equal(o.base, r.git('rev-parse', `${big}~1`).trim());

  // A second run reads the raised tier as its floor and raises nothing again; it adds no second Prep line.
  const again = out(ok(r.run('task-prep', r.plan, '1')));
  assert.deepEqual(again, got);
  assert.equal(r.ledger().filter((l) => l.startsWith('Tier raised:')).length, 1);
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Prep:')), [`Prep: T1 r1 ${big}`]);
}));

test('task-prep: without tracking the floor is the last Tier or Tier raised line of the ledger, and a raise is only ledgered', () => withRig({ store: false }, (r) => {
  const base = r.head();
  r.seedLedger(`BASE: T1 ${base}`, 'Tier: T1 light', 'Tier: T1 heavy', 'Tier raised: T2 standard → heavy — other task', 'Tier: T1 standard');
  r.commit('src/a.js', 'a\n');
  assert.equal(out(ok(r.run('task-prep', r.plan, '1'))).tier, 'standard');

  r.seedLedger(`BASE: T1 ${base}`, 'Tier: T1 standard', 'Tier raised: T1 standard → heavy — earlier raise');
  assert.equal(out(ok(r.run('task-prep', r.plan, '1'))).tier, 'heavy', 'the Tier raised line is the floor');
  assert.deepEqual(r.calls().filter((c) => !c.startsWith('tasks paths')), []);

  r.seedLedger(`BASE: T1 ${base}`);
  r.commit('src/big.js', Array.from({ length: 301 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  assert.equal(out(ok(r.run('task-prep', r.plan, '1'))).tier, 'heavy');
  assert.ok(r.ledger().includes('Tier raised: T1 standard → heavy — 302 changed lines (over 300): src/a.js, src/big.js'));
  assert.deepEqual(r.calls().filter((c) => !c.startsWith('tasks paths')), [], 'a retier without tracking');
}));

test('task-prep --fix-round: rework then review, package from the last Prep head', () => withRig({}, (r) => {
  const { head: first, out: one } = firstRound(r, 1);
  const fix = r.commit('src/t1.js', 'export const t1 = 11;\n', 'fixup! edit');
  r.clearCalls();
  const res = ok(r.run('task-prep', r.plan, '1', '--fix-round'));
  assert.deepEqual(keys(res), ['tier', 'hunters', 'package', 'round', 'full-review']);
  const o = out(res);
  assert.equal(o.round, '2');
  assert.equal(o['full-review'], 'no');
  assert.equal(o.hunters, 'none');
  assert.equal(o.package, join(r.workspace, `review-${first.slice(0, 7)}..${fix.slice(0, 7)}.diff`));
  assert.match(readFileSync(o.package, 'utf8'), new RegExp(`^# Review package: ${first}\\.\\.${fix}`));
  assert.notEqual(o.package, one.package);
  assert.deepEqual(r.calls().filter((c) => /^tasks (rework|review) /.test(c)), [`tasks rework T1 --plan ${r.plan}`, `tasks review T1 --plan ${r.plan}`]);
  assert.equal(r.taskState(1).status, 'in_review');
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Prep:')), [`Prep: T1 r1 ${first}`, `Prep: T1 r2 ${fix}`]);
}));

// ---- task-prep: fix rounds ----

const lines = (count, tag) => Array.from({ length: count }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
const raisedLines = (r) => r.ledger().filter((l) => l.startsWith('Tier raised:'));
const prepLines = (r) => r.ledger().filter((l) => l.startsWith('Prep:'));

test('task-prep --fix-round: a fix that pushes the task past 300 lines raises it and calls for the full review of BASE..head', () => withRig({}, (r) => {
  const { o, head: first } = firstRound(r, 1); // T1 is standard; firstRound commits 1 line
  const mid = r.commit('src/mid.js', lines(290, 'm'));
  ok(r.run('task-prep', r.plan, '1', '--fix-round')); // round 2: 290 lines, still standard
  assert.equal(r.taskState(1).effectiveTier ?? 'standard', 'standard');
  const fix = r.commit('src/more.js', lines(20, 'x'), 'fixup! edit');
  r.clearCalls();
  const res = ok(r.run('task-prep', r.plan, '1', '--fix-round'));
  assert.deepEqual(keys(res), ['tier', 'hunters', 'package', 'round', 'full-review']);
  const got = out(res);
  assert.equal(got.tier, 'heavy');
  assert.equal(got.round, '3');
  assert.equal(got['full-review'], 'yes');
  assert.equal(got.hunters, 'correctness,security');
  assert.equal(got.package, join(r.workspace, `review-${o.base.slice(0, 7)}..${fix.slice(0, 7)}.diff`), 'the cumulative package');
  assert.match(readFileSync(got.package, 'utf8'), new RegExp(`^# Review package: ${o.base}\\.\\.${fix}`));
  assert.equal(r.taskState(1).effectiveTier, 'heavy');
  assert.equal(raisedLines(r).length, 1);
  assert.match(raisedLines(r)[0], /^Tier raised: T1 standard → heavy — 311 changed lines \(over 300\)/);
  assert.ok(r.calls().some((c) => c.startsWith('tasks retier T1 heavy --reason 311 changed lines')));
  assert.deepEqual(prepLines(r), [`Prep: T1 r1 ${first}`, `Prep: T1 r2 ${mid}`, `Prep: T1 r3 ${fix}`]);

  // A rerun at the same head prints the same and adds no second Prep or Tier raised line.
  const again = ok(r.run('task-prep', r.plan, '1', '--fix-round'));
  assert.deepEqual(out(again), got);
  assert.equal(again.stdout, res.stdout);
  assert.equal(raisedLines(r).length, 1);
  assert.equal(prepLines(r).length, 3);
  // So does a plain call at that head.
  assert.equal(ok(r.run('task-prep', r.plan, '1')).stdout, res.stdout);
  assert.equal(prepLines(r).length, 3);
}));

test('task-prep --fix-round: a fix of over 300 lines raises the task and calls for the full review', () => withRig({}, (r) => {
  firstRound(r, 6);
  // 301 changed lines in one fix commit: the round check alone raises it, and so does the cumulative one.
  const fix = r.commit('src/big.js', lines(301, 'b'), 'fixup! edit');
  const got = out(ok(r.run('task-prep', r.plan, '6', '--fix-round')));
  assert.equal(got.tier, 'heavy');
  assert.equal(got['full-review'], 'yes');
  assert.equal(got.hunters, 'correctness,security');
  assert.match(got.package, new RegExp(`\\.\\.${fix.slice(0, 7)}\\.diff$`));
}));

test('task-prep --fix-round: with no commit since the last Prep head it is refused', () => withRig({}, (r) => {
  const { head } = firstRound(r, 1);
  const res = r.run('task-prep', r.plan, '1', '--fix-round');
  assert.equal(res.status, 3);
  assert.match(res.stderr, /fix round 2 of T1 has no commit since/);
  assert.match(r.ledger().at(-1), /^Error: task-prep T1 — exit 3 — fix round 2 of T1 has no commit since/);
  assert.deepEqual(prepLines(r), [`Prep: T1 r1 ${head}`]);
}));

test('task-prep: a plain call after a fix round reuses the round at the same head and says use --fix-round at another', () => withRig({}, (r) => {
  const { head: first } = firstRound(r, 1);
  const fix = r.commit('src/t1.js', 'export const t1 = 11;\n', 'fixup! edit');
  const second = ok(r.run('task-prep', r.plan, '1', '--fix-round'));
  const plain = ok(r.run('task-prep', r.plan, '1'));
  assert.equal(plain.stdout, second.stdout, 'the round goes on, not back to 1');
  assert.equal(out(plain).round, '2');
  assert.deepEqual(prepLines(r), [`Prep: T1 r1 ${first}`, `Prep: T1 r2 ${fix}`]);

  r.commit('src/t1.js', 'export const t1 = 12;\n', 'fixup! edit');
  const other = r.run('task-prep', r.plan, '1');
  assert.equal(other.status, 3);
  assert.match(other.stderr, /use --fix-round/);
  assert.match(r.ledger().at(-1), /^Error: task-prep T1 — exit 3 — .*use --fix-round/);
  assert.equal(prepLines(r).length, 2);
}));

test('task-prep: the Tier raised line is written before the retier, and a rerun does not write it twice', () => withRig({}, (r) => {
  open(r, 1);
  r.commit('src/big.js', lines(301, 'b'));
  r.failMove('retier');
  const failed = r.run('task-prep', r.plan, '1');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /forced failure of retier/);
  assert.equal(raisedLines(r).length, 1, 'the line was written before the retier ran');
  assert.equal(r.taskState(1).effectiveTier, 'standard', 'the retier did not happen');

  r.allowMove('retier');
  const got = out(ok(r.run('task-prep', r.plan, '1')));
  assert.equal(got.tier, 'heavy');
  assert.equal(raisedLines(r).length, 1, 'a rerun wrote the line twice');
  assert.equal(r.taskState(1).effectiveTier, 'heavy');
  assert.equal(prepLines(r).length, 1);
}));


test('task-prep --head <sha>: reviews that sha, not HEAD', () => withRig({}, (r) => {
  const o = open(r, 1);
  const first = r.commit('src/a.js', 'a\n');
  r.commit('src/b.js', 'b\n');
  const res = ok(r.run('task-prep', r.plan, '1', '--head', first));
  const got = out(res);
  assert.equal(got.package, join(r.workspace, `review-${o.base.slice(0, 7)}..${first.slice(0, 7)}.diff`));
  const text = readFileSync(got.package, 'utf8');
  assert.match(text, new RegExp(`^# Review package: ${o.base}\\.\\.${first}`));
  assert.doesNotMatch(text, /src\/b\.js/);
  assert.ok(r.ledger().includes(`Prep: T1 r1 ${first}`));
}));

test('task-prep: an empty range prints package: none and says so in the ledger', () => withRig({}, (r) => {
  const o = open(r, 6);
  const res = ok(r.run('task-prep', r.plan, '6'));
  assert.deepEqual(keys(res), ['tier', 'hunters', 'package', 'round', 'full-review']);
  const got = out(res);
  assert.equal(got.package, 'none');
  assert.equal(got.hunters, 'none');
  assert.equal(got.round, '1');
  assert.equal(r.taskState(6).status, 'in_review');
  assert.ok(r.ledger().includes('Review: T6 — no commits, nothing to review'));
  assert.ok(r.ledger().includes(`Prep: T6 r1 ${o.base}`));
}));

// ---- failures ----

test('failures exit non-zero: a missing plan is exit 2 with no ledger line, an unknown task is exit 3 with an Error line', () => withRig({}, (r) => {
  const missing = r.run('task-prep', join(r.root, 'nope.md'), '1');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such plan file/);
  assert.equal(existsSync(join(r.dir, '.methodology')), false, 'a workspace was made for a plan that does not exist');

  const usage = r.run('task-prep', r.plan);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: task-prep PLAN_FILE N/);
  assert.equal(r.run('task-prep', r.plan, '1', '--bogus').status, 2);
  assert.equal(r.run('task-open', r.plan).status, 2);

  r.seedLedger();
  const unknown = r.run('task-prep', r.plan, '9');
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /task 9 not found/);
  assert.equal(r.ledger().length, 1 + 1);
  assert.match(r.ledger()[1], /^Error: task-prep T9 — exit 3 — task 9 not found/);

  const openUnknown = r.run('task-open', r.plan, '9');
  assert.equal(openUnknown.status, 3);
  assert.match(r.ledger()[2], /^Error: task-open T9 — exit 3 — task 9 not found/);
}));

test('failures exit non-zero: preconditions of task-prep and a refused move are exit 3 with an Error line', () => withRig({}, (r) => {
  r.seedLedger();
  const noBase = r.run('task-prep', r.plan, '1');
  assert.equal(noBase.status, 3);
  assert.match(noBase.stderr, /no BASE recorded for T1/);

  open(r, 1);
  const noPrep = r.run('task-prep', r.plan, '1', '--fix-round');
  assert.equal(noPrep.status, 3);
  assert.match(noPrep.stderr, /no Prep line for T1/);

  const badHead = r.run('task-prep', r.plan, '1', '--head', 'deadbeef');
  assert.equal(badHead.status, 2);
  assert.match(badHead.stderr, /bad --head/);

  // T2 is done: the review move is refused by the ledger.
  open(r, 2);
  ok(r.triqual('tasks', 'review', 'T2', '--plan', PLAN_NAME));
  ok(r.triqual('tasks', 'done', 'T2', '--commit', 'HEAD', '--plan', PLAN_NAME));
  const moved = r.run('task-prep', r.plan, '2');
  assert.equal(moved.status, 3);
  assert.match(moved.stderr, /T2 is done; cannot review/);
  assert.equal(r.ledger().filter((l) => l.startsWith('Error:')).length, 4);
  assert.match(r.ledger().at(-1), /^Error: task-prep T2 — exit 3 — .*T2 is done; cannot review/);
  assert.equal(r.taskState(2).status, 'done');
}));

test('scripts refuse to run from a linked worktree', () => withRig({}, (r) => {
  const wt = join(r.root, 'wt');
  r.git('worktree', 'add', '-q', wt, '-b', 'wt/demo-t1');
  for (const [script, args] of [['task-open', [r.plan, '1']], ['task-prep', [r.plan, '1']]]) {
    const res = r.runIn(wt, script, ...args);
    assert.equal(res.status, 3, script);
    assert.match(res.stderr, /run from the main checkout/, script);
    assert.equal(res.stdout, '', script);
  }
  assert.equal(existsSync(join(wt, '.methodology')), false, 'a workspace was made in the worktree');
  assert.deepEqual(r.calls().filter((c) => !c.startsWith('tasks paths')), [], 'a move was made');
}));

// ---- footers ----

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role, [c, i, m] = [0, 0, 0], candidates = []) => [
  'The review, in prose.', '', FOOTER_MARKER, `role: ${role}`, `findings: critical=${c} important=${i} minor=${m}`,
  ...candidates.map(([id, verdict]) => `candidate: ${id} ${verdict}`),
].join('\n') + '\n';

test('parseFooter reads the v1 footer', async () => {
  const { parseFooter, FooterError } = await import(join(SCRIPTS, 'lib', 'footer.mjs'));
  assert.equal(typeof FooterError, 'function');
  const text = footerText('spec-reviewer', [0, 2, 1], [
    ['correctness-1', 'confirmed critical'], ['correctness-2', 'confirmed important'], ['security-1', 'confirmed minor'],
    ['security-2', 'refuted'], ['state-1', 'duplicate-candidate'], ['state-2', 'duplicate-review'],
  ]);
  assert.deepEqual(parseFooter(`Prose with a <!-- triqual-review v0 --> look-alike.\n${text}\n\n`), {
    role: 'spec-reviewer',
    findings: { critical: 0, important: 2, minor: 1 },
    candidates: [
      { id: 'correctness-1', verdict: 'confirmed', severity: 'critical' },
      { id: 'correctness-2', verdict: 'confirmed', severity: 'important' },
      { id: 'security-1', verdict: 'confirmed', severity: 'minor' },
      { id: 'security-2', verdict: 'refuted', severity: null },
      { id: 'state-1', verdict: 'duplicate-candidate', severity: null },
      { id: 'state-2', verdict: 'duplicate-review', severity: null },
    ],
  });
  // A gate and a re-reviewer carry no candidates; CRLF line ends are fine.
  assert.deepEqual(parseFooter(footerText('safety-reviewer', [1, 0, 0]).replace(/\n/g, '\r\n')), {
    role: 'safety-reviewer', findings: { critical: 1, important: 0, minor: 0 }, candidates: [],
  });
  assert.equal(parseFooter(footerText('re-reviewer')).role, 're-reviewer');
});

test('parseFooter rejects a missing marker, a bad findings line and an unknown verdict', async () => {
  const { parseFooter, FooterError } = await import(join(SCRIPTS, 'lib', 'footer.mjs'));
  const good = footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted']]);
  const bad = {
    'no marker': good.replace(FOOTER_MARKER, ''),
    'an old marker': good.replace('v1', 'v2'),
    'text after the footer': `${good}Thanks.\n`,
    'no role line': good.replace(/role: .*\n/, ''),
    'an unknown role': good.replace('spec-reviewer', 'hunter'),
    'no findings line': good.replace(/findings: .*\n/, ''),
    'a findings line with a missing count': good.replace('minor=0', ''),
    'a findings line out of order': good.replace('critical=0 important=0 minor=0', 'important=0 critical=0 minor=0'),
    'a negative count': good.replace('critical=0', 'critical=-1'),
    'a non-numeric count': good.replace('critical=0', 'critical=x'),
    'an unknown verdict': good.replace('refuted', 'dismissed'),
    'a confirmed verdict without a severity': good.replace('refuted', 'confirmed'),
    'a severity on a refuted verdict': good.replace('refuted', 'refuted minor'),
    'an unknown severity': good.replace('refuted', 'confirmed blocker'),
    'a candidate id without a category': good.replace('correctness-1', 'one'),
    'the same candidate twice': `${good}candidate: correctness-1 refuted\n`,
    'a line that is no footer line': good.replace('candidate:', 'candidates:'),
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.throws(() => parseFooter(text), (e) => e instanceof FooterError && e.message !== '', what);
  }
  assert.throws(() => parseFooter(''), FooterError);
});

test('countCandidates counts the distinct ids of one category', async () => {
  const { countCandidates } = await import(join(SCRIPTS, 'lib', 'footer.mjs'));
  const file = [
    '# Candidates', '### correctness-1', 'src/a.js:3 — claim; see also correctness-2.', '### correctness-2', 'src/b.js:9 — claim.',
    '### correctness-1 again', '### security-1', 'ok', '### spec-drift-1', '',
  ].join('\n');
  assert.equal(countCandidates(file, 'correctness'), 2);
  assert.equal(countCandidates(file, 'security'), 1);
  assert.equal(countCandidates(file, 'spec-drift'), 1);
  assert.equal(countCandidates(file, 'state'), 0);
  assert.equal(countCandidates('No candidates: the diff is clean.\n', 'correctness'), 0);
});

test('codexRoleModel names the Codex routing model of a role, else null', () => {
  assert.equal(codexRoleModel('hunter'), 'gpt-6-luna');
  assert.equal(codexRoleModel('spec-reviewer'), 'gpt-6.1-sol');
  assert.equal(codexRoleModel('nobody'), null);
  assert.equal(codexRoleModel('constructor'), null);
});

// ---- task-close ----

const startStack = (r) => {
  ok(r.run('stack.mjs', 'init', r.plan, '--mode', 'local'));
  ok(r.run('stack.mjs', 'phase', r.plan, '1'));
};
const save = (r, n, role, round, text) => writeFileSync(join(r.workspace, `task-${n}-${role}-r${round}.md`), text);
const candidatesPath = (r, n, category) => join(r.workspace, `task-${n}-candidates-${category}.md`);
const candidatesFile = (r, n, category, ids) => writeFileSync(
  candidatesPath(r, n, category),
  ids.length ? ids.map((id) => `### ${id}\nsrc/x.js:1 — claim.\n`).join('\n') : 'No candidates: the diff is clean.\n',
);
// Open, commit `commits` times and prep a task on the stack's phase branch; the ledger then holds BASE and Prep.
const prepared = (r, n, { commits = 2 } = {}) => {
  startStack(r);
  const o = open(r, n);
  for (let i = 0; i < commits; i++) r.commit(`src/t${n}-${i}.js`, `export const t${n}x${i} = ${i};\n`, i === 0 ? `feat: t${n}` : 'fixup! feat');
  const prep = out(ok(r.run('task-prep', r.plan, String(n))));
  return { base: o.base, prep };
};
const closeOf = (r, n, ...extra) => r.run('task-close', r.plan, String(n), ...extra);
const recordOf = (r, n) => JSON.parse(readFileSync(join(r.workspace, `task-${n}-record.json`), 'utf8'));
const storedRecords = (r) => (existsSync(r.evalFile) ? readFileSync(r.evalFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha7 = (sha) => sha.slice(0, 7);
const HEAVY_OUTPUTS = (r, n = 2) => {
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer', [0, 1, 1]));
  save(r, n, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 1, 2], [
    ['correctness-1', 'confirmed important'], ['correctness-2', 'refuted'],
    ['security-1', 'duplicate-candidate'], ['security-2', 'duplicate-review'], ['security-3', 'confirmed minor'],
  ]));
  candidatesFile(r, n, 'correctness', ['correctness-1', 'correctness-2']);
  candidatesFile(r, n, 'security', ['security-1', 'security-2', 'security-3']);
};
// Move a workspace file's mtime to `secondsAgo` seconds before now. A reopened task's outputs are told apart by mtime: the
// ones saved before the previous attempt's close marker belong to that attempt.
const ageFile = (file, secondsAgo) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, at, at);
};
const markerPath = (r, n, attempt) => join(r.workspace, `task-${n}-closed-${attempt}`);
const markClosed = (r, n, attempt, secondsAgo) => {
  writeFileSync(markerPath(r, n, attempt), 'seeded\n');
  ageFile(markerPath(r, n, attempt), secondsAgo);
};
const ageOutputs = (r, n, secondsAgo) => {
  for (const f of ['safety-reviewer-r1.md', 'spec-reviewer-r1.md', 'candidates-correctness.md', 'candidates-security.md']) {
    if (existsSync(join(r.workspace, `task-${n}-${f}`))) ageFile(join(r.workspace, `task-${n}-${f}`), secondsAgo);
  }
};
const noError = (r) => assert.deepEqual(r.ledger().filter((l) => l.startsWith('Error:')), []);

test('task-close: builds the record, squashes, marks done, writes the complete line and the entry', () => withRig({}, (r) => {
  startStack(r);
  // An earlier attempt of T2 (a fix round and its complete line) and a fix round of another task.
  r.seedLedger('Task 2: fix round 1/5 (1 addressed, 0 open — earlier; commits aaaaaaa..bbbbbbb)', 'Task 2: complete (commits aaaaaaa..bbbbbbb, review clean)');
  markClosed(r, 2, 1, 7200);
  const { base } = prepared(r, 2);
  r.appendLedger('Task 2: fix round 1/5 (1 addressed, 0 open — one; commits a..b)', 'Task 3: fix round 1/5 (other task)', 'Task 2: fix round 2/5 (1 addressed, 0 open — two; commits b..c)', 'Task 2: minor (deferred): a nit');
  HEAVY_OUTPUTS(r);
  r.clearCalls();

  const res = ok(r.run('task-close', r.plan, '2'));
  assert.deepEqual(keys(res), ['sha', 'record']);
  const got = out(res);
  assert.equal(got.sha, r.head(), 'the printed sha is the squashed commit');
  assert.equal(got.record, 'recorded');
  assert.equal(r.git('rev-parse', `${got.sha}^`).trim(), base, 'one commit on top of BASE');
  assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '1');
  assert.equal(r.taskState(2).status, 'done');
  assert.ok(r.calls().includes(`tasks done T2 --commit ${got.sha} --plan ${r.plan}`), r.calls().join('\n'));
  assert.equal(r.ledger().at(-1), `Task 2: complete (commits ${sha7(base)}..${sha7(got.sha)}, review clean)`);
  noError(r);

  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const zero = { critical: 0, important: 0, minor: 0 };
  assert.deepEqual({ ...record, at: undefined }, {
    v: 2, at: undefined, provider: 'claude', task: 'T2', kind: 'task-review', attempt: 2,
    tier: 'heavy', declaredTier: 'heavy', raised: false,
    hunters: [
      { category: 'correctness', model: 'claude-haiku-4-9', failed: false, candidates: 2, confirmed: { ...zero, important: 1 }, refuted: 1, duplicateCandidate: 0, duplicateReview: 0 },
      { category: 'security', model: 'claude-haiku-4-9', failed: false, candidates: 3, confirmed: { ...zero, minor: 1 }, refuted: 0, duplicateCandidate: 1, duplicateReview: 1 },
    ],
    gate: { findings: 2 },
    spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 2 } },
    fixRounds: 2, blocked: false, coordinator: false,
  });
  const stored = storedRecords(r);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].task, 'T2');
  assert.match(stored[0].key, /^[0-9a-f]{64}$/);

  // The review entry is added to the store and names the squashed sha.
  const add = r.calls().find((c) => c.startsWith('tracking add '));
  assert.match(add, new RegExp(` --commit ${got.sha}$`));
  const entries = JSON.parse(r.triqual('tracking', 'log', '--json').stdout);
  const entry = entries.find((e) => JSON.stringify(e).includes('Plan demo-plan · T2'));
  assert.ok(entry, 'no entry for T2');
  assert.ok(JSON.stringify(entry).includes(sha7(got.sha)), 'the entry does not name the sha');
}));

test('task-close: a missing hunter file is recorded failed with zero counts', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  // Only correctness answered: the security hunter wrote nothing, so the spec reviewer had no security candidates.
  rmSync(candidatesPath(r, 2, 'security'));
  save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 1, 2], [['correctness-1', 'confirmed important'], ['correctness-2', 'refuted']]));
  ok(r.run('task-close', r.plan, '2'));
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.hunters.map((h) => [h.category, h.failed, h.candidates]), [['correctness', false, 2], ['security', true, 0]]);
  assert.deepEqual(record.hunters[1].confirmed, { critical: 0, important: 0, minor: 0 });
  assert.equal(record.hunters[1].refuted + record.hunters[1].duplicateCandidate + record.hunters[1].duplicateReview, 0);
  assert.equal(record.hunters[1].model, 'claude-haiku-4-9');
}));

test('task-close: a hunter file with no usable content is recorded failed', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  writeFileSync(candidatesPath(r, 2, 'security'), '  \n');
  save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted'], ['correctness-2', 'refuted']]));
  ok(r.run('task-close', r.plan, '2'));
  assert.deepEqual(recordOf(r, 2).hunters.map((h) => [h.category, h.failed]), [['correctness', false], ['security', true]]);
}));

test('task-close: a valid empty hunter file counts as done with zero candidates', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  candidatesFile(r, 2, 'security', []);
  save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted'], ['correctness-2', 'refuted']]));
  ok(r.run('task-close', r.plan, '2'));
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.hunters.map((h) => [h.category, h.failed, h.candidates]), [['correctness', false, 2], ['security', false, 0]]);
}));

test('task-close: the second hunter category follows the task (state for a Live state reason)', () => withRig({}, (r) => {
  prepared(r, 3);
  save(r, 3, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 3, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 0], [['state-1', 'refuted']]));
  candidatesFile(r, 3, 'correctness', []);
  candidatesFile(r, 3, 'state', ['state-1']);
  ok(r.run('task-close', r.plan, '3'));
  assert.deepEqual(recordOf(r, 3).hunters.map((h) => h.category), ['correctness', 'state']);
}));

test('task-close: required outputs follow the tier and the ledger', () => {
  // Standard needs the gate and the spec outputs; heavy the same (the first test above); no hunters for either.
  withRig({}, (r) => {
    prepared(r, 1);
    save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer', [0, 0, 1]));
    save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 2]));
    ok(r.run('task-close', r.plan, '1'));
    const record = recordOf(r, 1);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.deepEqual([record.tier, record.hunters, record.gate, record.spec], ['standard', [], { findings: 1 }, { ran: true, confirmed: { critical: 0, important: 0, minor: 2 } }]);
    assert.equal(record.attempt, 1);
    assert.equal(record.fixRounds, 0);
  });

  // Light needs the gate; the spec output only when the ledger says Round 2 had light items.
  withRig({}, (r) => {
    startStack(r);
    open(r, 7);
    r.commit('docs/t7.md', '# seven\n');
    assert.equal(out(ok(r.run('task-prep', r.plan, '7'))).tier, 'light');
    const bare = r.run('task-close', r.plan, '7');
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /safety-reviewer/);
    save(r, 7, 'safety-reviewer', 1, footerText('safety-reviewer'));
    ok(r.run('task-close', r.plan, '7'));
    const record = recordOf(r, 7);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.deepEqual([record.tier, record.hunters, record.gate, record.spec], ['light', [], { findings: 0 }, { ran: false, confirmed: { critical: 0, important: 0, minor: 0 } }]);
  });
  withRig({}, (r) => {
    startStack(r);
    open(r, 7);
    r.commit('docs/t7.md', '# seven\n');
    ok(r.run('task-prep', r.plan, '7'));
    r.appendLedger('Round 2: T7 — light items 0');
    save(r, 7, 'safety-reviewer', 1, footerText('safety-reviewer'));
    ok(r.run('task-close', r.plan, '7'));
    assert.equal(recordOf(r, 7).spec.ran, false, 'light items 0 needs no spec output');
  });
  withRig({}, (r) => {
    startStack(r);
    open(r, 7);
    r.commit('docs/t7.md', '# seven\n');
    ok(r.run('task-prep', r.plan, '7'));
    r.appendLedger('Round 2: T7 — light items 2');
    save(r, 7, 'safety-reviewer', 1, footerText('safety-reviewer', [0, 1, 0]));
    const missing = r.run('task-close', r.plan, '7');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /spec-reviewer/);
    save(r, 7, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 1, 0]));
    ok(r.run('task-close', r.plan, '7'));
    const record = recordOf(r, 7);
    assert.deepEqual([record.gate, record.spec], [{ findings: 1 }, { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } }]);
  });

  // A task with no commits needs no output at all.
  withRig({}, (r) => {
    startStack(r);
    open(r, 6);
    ok(r.run('task-prep', r.plan, '6'));
    assert.ok(r.ledger().includes('Review: T6 — no commits, nothing to review'));
    const head = r.head();
    const res = ok(r.run('task-close', r.plan, '6'));
    assert.equal(out(res).sha, head, 'no commits: the sha is HEAD');
    const record = recordOf(r, 6);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.deepEqual([record.hunters, record.gate, record.spec.ran], [[], { findings: 0 }, false]);
    assert.equal(r.taskState(6).status, 'done');
    assert.match(r.ledger().at(-1), new RegExp(`^Task 6: complete \\(commits ${sha7(head)}..${sha7(head)}, review clean\\)$`));
  });

  // After "Skipped: hunters and safety gate" the safety checklist sits in the spec output: no gate file, no hunters.
  withRig({}, (r) => {
    prepared(r, 2);
    r.appendLedger('Skipped: hunters and safety gate — roles plugin too old; safety checklist runs in the spec review');
    save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 1, 0]));
    ok(r.run('task-close', r.plan, '2'));
    const record = recordOf(r, 2);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.deepEqual([record.tier, record.hunters, record.gate, record.spec.ran], ['heavy', [], { findings: 0 }, true]);
  });
  // After "Skipped: hunters" alone the gate is still required and no hunter is sent.
  withRig({}, (r) => {
    prepared(r, 2);
    r.appendLedger('Skipped: hunters — no Haiku quota');
    save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer'));
    const bare = r.run('task-close', r.plan, '2');
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /safety-reviewer/);
    save(r, 2, 'safety-reviewer', 1, footerText('safety-reviewer'));
    ok(r.run('task-close', r.plan, '2'));
    assert.deepEqual(recordOf(r, 2).hunters, []);
  });
});

test('task-close: a missing required output is an Error and nothing is written', () => withRig({}, (r) => {
  prepared(r, 1);
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  const head = r.head();
  r.clearCalls();
  const res = r.run('task-close', r.plan, '1');
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /task-1-spec-reviewer-r\d+\.md|spec-reviewer/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 1 — .*spec-reviewer/);
  assert.equal(r.head(), head, 'nothing was squashed');
  assert.equal(r.taskState(1).status, 'in_review');
  assert.equal(existsSync(join(r.workspace, 'task-1-record.json')), false);
  assert.deepEqual(storedRecords(r), []);
  assert.deepEqual(r.calls().filter((c) => /^(tasks (done|start|review)|tracking add|role-eval)/.test(c)), []);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 0);
}));

test('task-close: a footer that is missing, malformed or names an unknown candidate is an Error and writes nothing', () => {
  const cases = {
    'no footer': (r) => save(r, 2, 'spec-reviewer', 1, 'A review without a footer.\n'),
    'a bad findings line': (r) => save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer').replace('critical=0', 'critical=zero')),
    'the wrong role': (r) => save(r, 2, 'spec-reviewer', 1, footerText('safety-reviewer')),
    'a candidate no hunter file has': (r) => save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 0], [
      ['correctness-1', 'refuted'], ['correctness-2', 'refuted'], ['security-9', 'refuted'],
    ])),
    'a candidate without a verdict': (r) => save(r, 2, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted']])),
    'a gate footer that is bad': (r) => save(r, 2, 'safety-reviewer', 1, `${footerText('safety-reviewer')}trailing\n`),
  };
  for (const [what, spoil] of Object.entries(cases)) {
    withRig({}, (r) => {
      prepared(r, 2);
      HEAVY_OUTPUTS(r);
      spoil(r);
      const head = r.head();
      r.clearCalls();
      const res = r.run('task-close', r.plan, '2');
      assert.equal(res.status, 1, `${what}: exit ${res.status}\n${res.stderr}`);
      assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 1 — \S/, what);
      assert.equal(r.head(), head, `${what}: squashed`);
      assert.equal(r.taskState(2).status, 'in_review', what);
      assert.equal(existsSync(join(r.workspace, 'task-2-record.json')), false, what);
      assert.deepEqual(storedRecords(r), [], what);
      assert.deepEqual(r.calls().filter((c) => /^(tasks done|tracking add|role-eval)/.test(c)), [], what);
    });
  }
});

test('task-close: a second run after success changes nothing', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  const first = ok(r.run('task-close', r.plan, '2'));
  const ledger = r.ledger();
  const head = r.head();
  r.clearCalls();
  const again = ok(r.run('task-close', r.plan, '2'));
  assert.deepEqual(keys(again), ['sha', 'record']);
  assert.equal(out(again).sha, out(first).sha);
  assert.equal(out(again).record, 'already recorded');
  assert.deepEqual(r.ledger(), ledger);
  assert.equal(r.head(), head);
  assert.equal(recordOf(r, 2).attempt, 1, 'the attempt of the complete line is reused');
  assert.equal(storedRecords(r).length, 1);
  assert.deepEqual(r.calls().filter((c) => /^(tasks (done|start|review|rework)|tracking add)/.test(c)), []);
  const entries = JSON.parse(r.triqual('tracking', 'log', '--json').stdout).filter((e) => JSON.stringify(e).includes('Plan demo-plan · T2'));
  assert.equal(entries.length, 1, 'a second entry was added');
}));

test('task-close: a failed record is an Error after the moves, and the rerun finishes it without repeating them', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  r.failMove('record');
  const failed = r.run('task-close', r.plan, '2');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /forced failure of record/);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 1 — .*forced failure of record/);
  assert.equal(r.taskState(2).status, 'done');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1);
  assert.deepEqual(storedRecords(r), []);

  r.allowMove('record');
  r.clearCalls();
  const again = ok(r.run('task-close', r.plan, '2'));
  assert.equal(out(again).record, 'recorded');
  assert.equal(out(again).sha, r.head());
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1, 'a second complete line');
  assert.equal(recordOf(r, 2).attempt, 1);
  assert.equal(storedRecords(r).length, 1);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), [], 'done moved again');
  const entries = JSON.parse(r.triqual('tracking', 'log', '--json').stdout).filter((e) => JSON.stringify(e).includes('Plan demo-plan · T2'));
  assert.equal(entries.length, 1, 'the rerun adds the entry the first run did not reach, once');
}));

const nothingWritten = (r, what) => {
  assert.deepEqual(r.calls().filter((c) => /^(tasks done|tracking add|tracking write|role-eval)/.test(c)), [], what);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1, `${what}: only the seeded complete line`);
};

test('task-close: a task with no tier anywhere is an Error, never a guessed standard', () => withRig({ store: false }, (r) => {
  // A tierless plan task, no `Tier:` ledger line and no tracking state: there is no tier to record.
  writeFileSync(join(r.dir, r.plan), readFileSync(join(r.dir, r.plan), 'utf8').replace('### Task 1: Standard task\n\n**Tier:** standard\n', '### Task 1: Standard task\n'));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'plan without a tier');
  startStack(r);
  open(r, 1);
  r.commit('src/a.js', 'export const a = 1;\n', 'feat: a');
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const res = r.run('task-close', r.plan, '1');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /no tier for T1/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 1 — no tier for T1/);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 0);
  assert.equal(storedRecords(r).length, 0);
  assert.equal(existsSync(join(r.workspace, 'task-1-record.json')), false);
}));

test('task-close: a failed entry lookup on the rerun is an Error, not "no entry yet"', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  r.failMove('record');
  assert.equal(r.run('task-close', r.plan, '2').status, 1);
  r.allowMove('record');
  r.failMove('log');
  const res = r.run('task-close', r.plan, '2');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /triqual tracking log: .*forced failure of log/);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 1 — triqual tracking log: .*forced failure of log/);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tracking add')), [], 'an entry was added after a failed lookup');
  r.allowMove('log');
  ok(r.run('task-close', r.plan, '2'));
  const entries = JSON.parse(r.triqual('tracking', 'log', '--json').stdout).filter((e) => JSON.stringify(e).includes('Plan demo-plan · T2'));
  assert.equal(entries.length, 1);
}));

test('task-close: a reopened task needs outputs saved after the previous attempt closed', () => withRig({}, (r) => {
  startStack(r);
  r.seedLedger('Task 2: complete (commits aaaaaaa..bbbbbbb, review clean)');
  markClosed(r, 2, 1, 600);
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  ageOutputs(r, 2, 3600); // attempt 1's gate, spec and hunter outputs
  const stale = r.run('task-close', r.plan, '2');
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /attempt 2/);
  assert.match(stale.stderr, /safety-reviewer/);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 1 — .*attempt 2/);
  nothingWritten(r, 'a stale gate output');
  assert.equal(storedRecords(r).length, 0);

  // Fresh gate and spec outputs but the hunters' files are still attempt 1's.
  for (const role of ['safety-reviewer', 'spec-reviewer']) ageFile(join(r.workspace, `task-2-${role}-r1.md`), 0);
  const hunters = r.run('task-close', r.plan, '2');
  assert.equal(hunters.status, 1, hunters.stderr);
  assert.ok(hunters.stderr.includes(basename(candidatesPath(r, 2, 'correctness'))), hunters.stderr);
  assert.match(hunters.stderr, /attempt 2/);
  nothingWritten(r, 'a stale hunter file');

  ageOutputs(r, 2, 0);
  const done = ok(r.run('task-close', r.plan, '2'));
  assert.equal(out(done).record, 'recorded');
  assert.equal(recordOf(r, 2).attempt, 2);
  assert.equal(recordOf(r, 2).gate.findings, 2);
  assert.equal(existsSync(markerPath(r, 2, 2)), true, 'the close marker of attempt 2');
}));

test('task-close: a reopened task whose previous close left no marker is an Error naming it', () => withRig({}, (r) => {
  startStack(r);
  r.seedLedger('Task 2: complete (commits aaaaaaa..bbbbbbb, review clean)');
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  const res = r.run('task-close', r.plan, '2');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /task-2-closed-1/);
  nothingWritten(r, 'no marker');
}));

test('task-close: a reopen with no ledger line since the complete line is not a resume', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  const first = out(ok(r.run('task-close', r.plan, '2')));
  ok(r.triqual('tasks', 'reopen', 'T2', 'phase check failed', '--plan', PLAN_NAME));
  const fix = r.commit('src/t2-fix.js', 'export const fix = 1;\n', 'fix: t2');
  const res = r.run('task-close', r.plan, '2');
  // Not a resume: the first attempt's sha is not reused, so the reopened task needs its own outputs (and has none).
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /attempt 2/);
  assert.equal(r.head(), fix, 'the stack was not rewritten');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1);
  assert.notEqual(first.sha, fix);
}));

test('task-close: lines the controller writes after a failed close do not turn the rerun into a reopen', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  r.failMove('record');
  assert.equal(r.run('task-close', r.plan, '2').status, 1);
  const completeSha = r.head();
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1);

  // What an On BLOCKED round trip leaves between the complete line and the rerun (SKILL.md, The Thin Controller and
  // Ledger vocabulary), plus other tasks' own lines: none of them is new work on T2.
  r.allowMove('record');
  r.appendLedger(
    'Task 2: awaiting landing',
    'Orchestrator: P1 — Phase: P1 blocked',
    'Denied by policy: triqual role-eval record — /somewhere',
    'Task 2: Ruling: record failed — rerun task-close — the store was locked — none',
    'Ruling: human granted 2 rounds for T3 — the breaker — none',
    'Task 2: minor (deferred): a nit',
    'Error: orchestrator P1 — exit 1 — nested dispatch unavailable',
    'RateLimit: roles:hunter 10:00',
    'Task 3: minor (deferred): a nit of another task',
    'BASE: T3 ' + completeSha,
  );
  r.clearCalls();
  const again = ok(r.run('task-close', r.plan, '2'));
  assert.equal(out(again).record, 'recorded');
  assert.equal(out(again).sha, completeSha, 'no second squash');
  assert.equal(r.head(), completeSha);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1, 'a second complete line');
  assert.equal(recordOf(r, 2).attempt, 1);
  assert.equal(storedRecords(r).length, 1);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), [], 'done moved again');
}));

test('task-close: new work on the task after its complete line is a reopen, not a resume', () => {
  const lines = [
    ['a Phase check reopen line', (r) => `Task 2: reopened — Phase check failed — npm test`],
    ['a fix round line', (r) => 'Task 2: fix round 1/5 (1 addressed, 0 open — a; commits aaaaaaa..bbbbbbb)'],
    ['a new Prep line', (r) => `Prep: T2 r2 ${r.head()}`],
    ['a new BASE line', (r) => `BASE: T2 ${r.git('rev-parse', 'HEAD~1').trim()}`],
  ];
  for (const [what, line] of lines) {
    withRig({ store: false }, (r) => {
      prepared(r, 2);
      HEAVY_OUTPUTS(r);
      const first = out(ok(r.run('task-close', r.plan, '2')));
      r.appendLedger('Orchestrator: P1 — Phase: P1 done', line(r));
      const res = r.run('task-close', r.plan, '2');
      assert.equal(res.status, 1, `${what}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /attempt 2/, what);
      assert.equal(r.head(), first.sha, `${what}: the stack was rewritten`);
      assert.equal(storedRecords(r).length, 1, `${what}: a second record`);
    });
  }
});

test('task-close: local mode writes the entry on the rerun of a first run that failed at the record step', () => withRig({ local: true }, (r) => {
  const progress = () => {
    const file = JSON.parse(r.triqual('tasks', 'paths', '--json').stdout).progress;
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const entriesOf = () => progress().split('\n').filter((l) => /^## \d{4}-\d{2}-\d{2} — T2 review closed at /.test(l));
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  r.failMove('record');
  assert.equal(r.run('task-close', r.plan, '2').status, 1);
  assert.deepEqual(entriesOf(), []);

  r.allowMove('record');
  const again = ok(r.run('task-close', r.plan, '2'));
  assert.equal(out(again).record, 'recorded');
  assert.equal(entriesOf().length, 1, 'the rerun writes the entry the first run did not reach');
  assert.ok(entriesOf()[0].endsWith(sha7(out(again).sha)));
  assert.ok(r.calls().some((c) => c.startsWith('tracking write entry')));

  r.clearCalls();
  assert.equal(out(ok(r.run('task-close', r.plan, '2'))).record, 'already recorded');
  assert.equal(entriesOf().length, 1, 'a third run adds no second entry');
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tracking write')), []);
}));

test('task-close: parked findings and a tripped breaker show in the line and the record', () => withRig({}, (r) => {
  prepared(r, 1);
  r.appendLedger(
    'Task 1: blocked at fix round 5/5 — one finding',
    'Task 1: parked — the finding — Ruling: the code stands',
    'Task 1: parked — another — Ruling: also stands',
  );
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const got = out(ok(r.run('task-close', r.plan, '1')));
  assert.match(r.ledger().at(-1), new RegExp(`^Task 1: complete \\(commits [0-9a-f]{7}\\.\\.${sha7(got.sha)}, 2 parked\\)$`));
  assert.equal(recordOf(r, 1).blocked, true);
}));

test('task-close --provider codex sets provider and the Codex hunter model', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  rmSync(r.installed); // the Codex model comes from the routing table, not from a Claude install
  ok(r.run('task-close', r.plan, '2', '--provider', 'codex'));
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.equal(record.provider, 'codex');
  assert.deepEqual(record.hunters.map((h) => h.model), [codexRoleModel('hunter'), codexRoleModel('hunter')]);
}));

test('task-close: the default provider reads the hunter model from the roles install; a missing file is an Error', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  rmSync(r.installed);
  const head = r.head();
  const res = r.run('task-close', r.plan, '2');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /installed_plugins\.json/);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 1 — .*installed_plugins\.json/);
  assert.equal(r.head(), head, 'nothing was squashed');
  assert.equal(r.taskState(2).status, 'in_review');
  assert.deepEqual(storedRecords(r), []);
}));

test('task-close: a roles install without the hunter agent file or its model is an Error', () => withRig({}, (r) => {
  prepared(r, 2);
  HEAVY_OUTPUTS(r);
  const hunter = join(r.root, 'home', '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9', 'agents', 'hunter.md');
  writeFileSync(hunter, '---\nname: hunter\ndescription: "Hunts."\n---\n');
  const res = r.run('task-close', r.plan, '2');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hunter\.md.*model|model.*hunter\.md/);
  rmSync(hunter);
  const res2 = r.run('task-close', r.plan, '2');
  assert.equal(res2.status, 1);
  assert.match(res2.stderr, /hunter\.md/);
  assert.equal(r.taskState(2).status, 'in_review');
}));

test('task-close: usage and refusals exit 2 and 3', () => withRig({}, (r) => {
  assert.equal(r.run('task-close').status, 2);
  assert.equal(r.run('task-close', r.plan).status, 2);
  const badProvider = r.run('task-close', r.plan, '1', '--provider', 'gemini');
  assert.equal(badProvider.status, 2);
  assert.match(badProvider.stderr, /provider/);
  const missing = r.run('task-close', join(r.root, 'nope.md'), '1');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such plan file/);

  const unknown = r.run('task-close', r.plan, '9');
  assert.equal(unknown.status, 3);
  assert.match(r.ledger().at(-1), /^Error: task-close T9 — exit 3 — /);

  // No BASE: the task was never opened.
  const noBase = r.run('task-close', r.plan, '1');
  assert.equal(noBase.status, 3);
  assert.match(noBase.stderr, /no BASE recorded for T1/);

  const wt = join(r.root, 'wt');
  r.git('worktree', 'add', '-q', wt, '-b', 'wt/demo-t1');
  const linked = r.runIn(wt, 'task-close', r.plan, '1');
  assert.equal(linked.status, 3);
  assert.match(linked.stderr, /run from the main checkout/);
}));

test('task-close: a repo that is not opted in makes no tracking call', () => withRig({ store: false }, (r) => {
  startStack(r);
  const o = open(r, 1);
  r.commit('src/a.js', 'export const a = 1;\n', 'feat: a');
  r.commit('src/b.js', 'export const b = 1;\n', 'fixup! feat');
  ok(r.run('task-prep', r.plan, '1'));
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  r.clearCalls();
  const got = out(ok(r.run('task-close', r.plan, '1')));
  assert.equal(r.git('rev-parse', `${got.sha}^`).trim(), o.base);
  assert.deepEqual(r.calls().filter((c) => /^tasks (done|start|review)|^tracking/.test(c)), []);
  const record = recordOf(r, 1);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.equal(record.tier, 'standard');
  assert.equal(storedRecords(r).length, 1);
}));

// ---- phase 1 fix round 1 ----

test('opted-in moves work in local tracking mode: the scripts pass the plan path, never a bare file name', () => withRig({ local: true }, (r) => {
  startStack(r);
  open(r, 1);
  assert.equal(r.taskState(1).status, 'in_progress');
  r.commit('src/t1-local.js', 'export const local = 1;\n', 'feat: t1');
  ok(r.run('task-prep', r.plan, '1'));
  assert.equal(r.taskState(1).status, 'in_review');
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  ok(r.run('task-close', r.plan, '1'));
  assert.equal(r.taskState(1).status, 'done');
  const moves = r.calls().filter((c) => /^tasks (start|review|rework|done|retier) /.test(c));
  assert.equal(moves.length, 3, moves.join('\n'));
  for (const move of moves) assert.ok(move.endsWith(` --plan ${r.plan}`), `a move without the plan path: ${move}`);
  noError(r);
}));

test('task-close: commits made after a no-commit prep are never closed unreviewed', () => {
  for (const n of [1, 2]) { // 1 is standard, 2 heavy
    withRig({}, (r) => {
      startStack(r);
      const base = open(r, n).base;
      assert.equal(out(ok(r.run('task-prep', r.plan, String(n)))).package, 'none');
      const late = r.commit(`src/late-${n}.js`, 'export const late = 1;\n', `feat: t${n}`);
      const res = closeOf(r, n);
      assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /commits after the last review.*task-prep --fix-round/);
      assert.match(r.ledger().at(-1), new RegExp(`^Error: task-close T${n} — exit 3 — .*commits after the last review`));
      assert.equal(r.head(), late, 'the stack was rewritten');
      assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '1');
      assert.equal(r.taskState(n).status, 'in_review');
      assert.equal(r.ledger().filter((l) => l.startsWith(`Task ${n}: complete`)).length, 0);
      assert.equal(existsSync(join(r.workspace, `task-${n}-record.json`)), false);

      // The path the error names: the fix-round prep prints a real package, and the close then needs the reviewers' outputs.
      assert.notEqual(out(ok(r.run('task-prep', r.plan, String(n), '--fix-round'))).package, 'none');
      const bare = closeOf(r, n);
      assert.equal(bare.status, 1);
      assert.match(bare.stderr, /no saved safety-reviewer output/);
    });
  }
});

test('task-close: a commit made after the last Prep head is refused, not squashed in', () => withRig({}, (r) => {
  const { base } = prepared(r, 1);
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const late = r.commit('src/late.js', 'export const late = 1;\n', 'fixup! feat');
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /commits after the last review/);
  assert.equal(r.head(), late);
  assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '3', 'the commits were squashed');
  assert.equal(r.taskState(1).status, 'in_review');

  // Reviewed through a fix round, the same commit closes.
  ok(r.run('task-prep', r.plan, '1', '--fix-round'));
  save(r, 1, 'safety-reviewer', 2, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 2, footerText('spec-reviewer'));
  ok(r.run('task-close', r.plan, '1'));
  assert.equal(r.taskState(1).status, 'done');
}));

test('task-close: a rerun of a closed task with no commits still resumes after later commits landed', () => withRig({}, (r) => {
  startStack(r);
  open(r, 6);
  ok(r.run('task-prep', r.plan, '6'));
  const first = out(ok(closeOf(r, 6)));
  r.commit('src/next.js', 'export const next = 1;\n', 'feat: next task');
  const again = out(ok(closeOf(r, 6)));
  assert.equal(again.sha, first.sha);
  assert.equal(again.record, 'already recorded');
}));

test('task-close: no commits is decided from git, not from a Review line of the ledger', () => withRig({}, (r) => {
  startStack(r);
  open(r, 1);
  r.appendLedger('Review: T1 — no commits, nothing to review');
  r.commit('src/real.js', 'export const real = 1;\n', 'feat: t1');
  ok(r.run('task-prep', r.plan, '1', '--head', r.head()));
  const bare = closeOf(r, 1);
  assert.equal(bare.status, 1, 'a stale Review line waved a real commit through');
  assert.match(bare.stderr, /no saved safety-reviewer output/);
}));

test('task-open: a started task with no BASE line is refused, never given HEAD as BASE', () => {
  for (const status of ['in_progress', 'in_review', 'done']) {
    withRig({}, (r) => {
      r.seedLedger('Tier: T1 standard'); // a 1.1.0 ledger: BASE was free text there
      ok(r.triqual('tasks', 'start', 'T1', '--plan', PLAN_NAME));
      r.commit('src/old.js', 'export const old = 1;\n', 'feat: t1 under 1.1.0');
      if (status !== 'in_progress') ok(r.triqual('tasks', 'review', 'T1', '--plan', PLAN_NAME));
      if (status === 'done') ok(r.triqual('tasks', 'done', 'T1', '--commit', 'HEAD', '--plan', PLAN_NAME));
      const res = r.run('task-open', r.plan, '1');
      assert.equal(res.status, 3, `${status}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, /no BASE recorded for a started task.*BASE: T1 <sha>/);
      assert.match(r.ledger().at(-1), /^Error: task-open T1 — exit 3 — no BASE recorded for a started task/);
      assert.equal(r.ledger().filter((l) => l.startsWith('BASE:')).length, 0, `${status}: a BASE line was invented`);
      assert.equal(r.taskState(1).status, status);

      // With the line the human appends, the resume goes on.
      const base = r.git('rev-parse', 'HEAD~1').trim();
      r.appendLedger(`BASE: T1 ${base}`);
      assert.equal(out(ok(r.run('task-open', r.plan, '1'))).base, base);
    });
  }
});

test('task-open: a failed brief leaves the BASE in the ledger, and the rerun reuses it', () => withRig({}, (r) => {
  const base = r.head();
  mkdirSync(join(r.workspace, 'task-1-brief.md'), { recursive: true }); // the brief cannot be written over a directory
  const failed = r.run('task-open', r.plan, '1');
  assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stderr, /^task-brief: cannot write /);
  assert.match(r.ledger().at(-1), /^Error: task-open T1 — exit 1 — task-brief: cannot write /);
  assert.equal(r.taskState(1).status, 'in_progress');

  rmSync(join(r.workspace, 'task-1-brief.md'), { recursive: true });
  r.commit('src/after.js', 'export const after = 1;\n'); // HEAD moved: the rerun must not take it as BASE
  assert.equal(out(ok(r.run('task-open', r.plan, '1'))).base, base);
  assert.equal(r.ledger().filter((l) => l.startsWith('BASE:')).length, 1);
}));

test('task-prep: a tier-check failure is exit 2 with the cause and an Error line', () => withRig({}, (r) => {
  const { head } = firstRound(r, 1);
  r.git('reset', '-q', '--hard', 'HEAD~1'); // history rewritten: the last Prep head is no ancestor of the new head
  r.commit('src/other.js', 'export const other = 1;\n', 'feat: other');
  const res = r.run('task-prep', r.plan, '1', '--fix-round');
  assert.equal(res.status, 2, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /^tier-check: .*HEAD is not a descendant of BASE/);
  assert.match(r.ledger().at(-1), /^Error: task-prep T1 — exit 2 — tier-check: .*HEAD is not a descendant of BASE/);
  assert.deepEqual(prepLines(r), [`Prep: T1 r1 ${head}`], 'a Prep line was written for the failed round');
}));

test('task-prep: a review-package failure is exit 1 with the cause and an Error line, and the rerun finishes', () => withRig({}, (r) => {
  const o = open(r, 1);
  const head = r.commit('src/t1.js', 'export const t1 = 1;\n');
  const pkg = join(r.workspace, `review-${o.base.slice(0, 7)}..${head.slice(0, 7)}.diff`);
  mkdirSync(pkg, { recursive: true }); // the package cannot be written over a directory
  const res = r.run('task-prep', r.plan, '1');
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /^review-package: cannot write /);
  assert.match(r.ledger().at(-1), /^Error: task-prep T1 — exit 1 — review-package: cannot write /);
  assert.deepEqual(prepLines(r), [], 'a Prep line was written for the failed round');

  rmSync(pkg, { recursive: true });
  assert.equal(out(ok(r.run('task-prep', r.plan, '1'))).package, pkg);
  assert.deepEqual(prepLines(r), [`Prep: T1 r1 ${head}`]);
}));

test('task-close: a refused squash (dirty tree) is exit 3 with an Error line, and nothing is moved or recorded', () => withRig({}, (r) => {
  const { base } = prepared(r, 2);
  HEAVY_OUTPUTS(r);
  const head = r.head();
  writeFileSync(join(r.dir, 'README.md'), '# repo, edited and not committed\n');
  r.clearCalls();
  const res = closeOf(r, 2);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /^stack\.mjs squash: /);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 3 — stack\.mjs squash: /);
  assert.equal(r.head(), head);
  assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '2');
  assert.equal(r.taskState(2).status, 'in_review');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 0);
  assert.equal(existsSync(join(r.workspace, 'task-2-record.json')), false);
  assert.deepEqual(r.calls().filter((c) => /^(tasks done|role-eval|tracking add)/.test(c)), []);

  r.git('checkout', '--', 'README.md');
  ok(closeOf(r, 2));
  assert.equal(r.taskState(2).status, 'done');
}));

test('task-prep: after a Skipped: hunters line no hunter is picked', () => withRig({}, (r) => {
  open(r, 2);
  r.appendLedger('Skipped: hunters — no Haiku quota');
  r.commit('src/t2.js', 'export const t2 = 2;\n');
  const got = out(ok(r.run('task-prep', r.plan, '2')));
  assert.equal(got.tier, 'heavy');
  assert.equal(got.hunters, 'none');
}));

// A hunter budget outside the tier's count: `Budget: hunters <tier count> → <used> for T<N> — <reason>`.
const budgetClose = (r, n, budget, footer, files) => {
  r.appendLedger(budget);
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, n, 'spec-reviewer', 1, footer);
  for (const [category, ids] of files) candidatesFile(r, n, category, ids);
  return closeOf(r, n);
};

test('task-close: a Budget line with more hunters than the tier count takes the categories from the hunter files', () => withRig({}, (r) => {
  prepared(r, 1); // standard: no hunter by default
  const res = budgetClose(r, 1, 'Budget: hunters 0 → 1 for T1 — risky diff', footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted']]), [['correctness', ['correctness-1']]]);
  ok(res);
  const record = recordOf(r, 1);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.hunters.map((h) => [h.category, h.failed, h.candidates, h.refuted]), [['correctness', false, 1, 1]]);
  noError(r);
}));

test('task-close: a Budget line that names more hunters than there are files is an Error and writes nothing', () => withRig({}, (r) => {
  prepared(r, 1);
  const res = budgetClose(r, 1, 'Budget: hunters 0 → 1 for T1 — risky diff', footerText('spec-reviewer'), []);
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /Budget: hunters 0 → 1 for T1.*1 hunter.*0 candidates files/);
  assert.equal(r.taskState(1).status, 'in_review');
  assert.equal(existsSync(join(r.workspace, 'task-1-record.json')), false);
}));

test('task-close: a heavy task with a Budget above the tier count records the extra hunter', () => withRig({}, (r) => {
  prepared(r, 2);
  const res = budgetClose(r, 2, 'Budget: hunters 2 → 3 for T2 — wide diff', footerText('spec-reviewer', [0, 0, 0], [
    ['correctness-1', 'refuted'], ['security-1', 'refuted'], ['state-1', 'confirmed minor'],
  ]), [['correctness', ['correctness-1']], ['security', ['security-1']], ['state', ['state-1']]]);
  ok(res);
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.hunters.map((h) => h.category), ['correctness', 'security', 'state']);
  assert.deepEqual(record.hunters.map((h) => h.failed), [false, false, false]);
}));

test('task-close: a Budget line below the tier count records only the hunters that were sent, none failed', () => withRig({}, (r) => {
  prepared(r, 2);
  const res = budgetClose(r, 2, 'Budget: hunters 2 → 1 for T2 — owner request, review cost', footerText('spec-reviewer', [0, 0, 0], [['correctness-1', 'refuted']]), [['correctness', ['correctness-1']]]);
  ok(res);
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.hunters.map((h) => [h.category, h.failed]), [['correctness', false]]);
}));

test('task-close: a Budget line below the tier count keeps the hunter that has a file, whichever category it is', () => withRig({}, (r) => {
  prepared(r, 2);
  const res = budgetClose(r, 2, 'Budget: hunters 2 → 1 for T2 — owner request', footerText('spec-reviewer', [0, 0, 0], [['security-1', 'refuted']]), [['security', ['security-1']]]);
  ok(res);
  assert.deepEqual(recordOf(r, 2).hunters.map((h) => [h.category, h.failed]), [['security', false]]);
}));

// ---- worktree tasks: task-open --worktree and the land-first task-close (thin controller, T8) ----

const WT_PLAN = `# Worktree plan

## Global Constraints

- Nothing.

### Task 1: First

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/t1.js\`
- Test: \`test/one.test.mjs\`

- [ ] **Step 1:** one.

### Task 2: Second

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/t2.js\`
- Test: \`test/two.test.mjs\`

- [ ] **Step 1:** two.

### Task 3: No Test path

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/t3.js\`

- [ ] **Step 1:** three.

### Task 4: A Test path that node does not run

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Test: \`test/four.test.ts\`

- [ ] **Step 1:** four.

### Task 5: A Test path outside the repository

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Test: \`../escape.test.mjs\`

- [ ] **Step 1:** five.

### Task 6: A glob Test path

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Test: \`test/*.test.mjs\`

- [ ] **Step 1:** six.
`;
const TEST_FILE = { 1: 'test/one.test.mjs', 2: 'test/two.test.mjs' };
const PASSING_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => { assert.equal(1, 2); });\n";

const wtPath = (r, n) => join(r.dir, '.claude', 'worktrees', `demo-plan-t${n}`);
const wtBranch = (n) => `wt/demo-plan-t${n}`;
const wtGit = (r, n, ...args) => execFileSync('git', args, { cwd: wtPath(r, n), env: r.env, encoding: 'utf8' });
// A commit made inside the task's worktree, by its implementer (a different author than the repo's committer).
const wtCommit = (r, n, file, text, message = `feat: t${n}`) => {
  mkdirSync(dirname(join(wtPath(r, n), file)), { recursive: true });
  writeFileSync(join(wtPath(r, n), file), text);
  wtGit(r, n, 'add', '-A');
  wtGit(r, n, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-q', '--author', 'Alice <alice@example.invalid>', '-m', message);
  return wtGit(r, n, 'rev-parse', 'HEAD').trim();
};
const wtOpen = (r, n) => out(ok(r.run('task-open', r.plan, String(n), '--worktree')));
// A worktree task built and reviewed: a source commit and a Test-file commit in its worktree, task-prep at that head, the
// reviewers' outputs saved. Returns the reviewed head.
const wtReview = (r, n, { source = [`src/t${n}.js`, `export const t${n} = ${n};\n`], test = PASSING_TEST } = {}) => {
  wtCommit(r, n, source[0], source[1], `feat: t${n}`);
  const head = wtCommit(r, n, TEST_FILE[n], test, `test: t${n}`);
  ok(r.run('task-prep', r.plan, String(n), '--head', head));
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, n, 'spec-reviewer', 1, footerText('spec-reviewer'));
  return head;
};
const worktrees = (r) => r.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
const wtBranches = (r) => r.git('branch', '--list', 'wt/*').trim();
const landedOf = (r, n) => r.ledger().filter((l) => l.startsWith(`Landed: T${n} `)).map((l) => l.split(' ')[2]);
const tracked = (r, rev) => r.git('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
// Stand-ins for the package managers, on the private PATH: each call is logged with its directory, and a test makes them fail
// by creating "<log>.fail-install".
const fakeInstallers = (r) => {
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
appendFileSync(process.env.TRIQUAL_CALL_LOG + '.install', basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ') + ' @ ' + process.cwd() + '\\n');
if (existsSync(process.env.TRIQUAL_CALL_LOG + '.fail-install')) { process.stderr.write('ERR! boom\\n'); process.exit(1); }
`;
  for (const name of ['npm', 'pnpm', 'yarn']) writeFileSync(join(r.root, 'bin', name), script, { mode: 0o755 });
  const log = join(r.root, 'triqual.log.install');
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    fail: () => writeFileSync(join(r.root, 'triqual.log.fail-install'), ''),
    heal: () => rmSync(join(r.root, 'triqual.log.fail-install'), { force: true }),
  };
};

test('two worktree tasks land in plan order and leave no worktree or temp branch', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  const o1 = wtOpen(r, 1);
  const o2 = wtOpen(r, 2);
  assert.deepEqual(Object.keys(o1), ['brief', 'report', 'base', 'workdir']);
  assert.equal(o1.workdir, wtPath(r, 1));
  assert.equal(o2.workdir, wtPath(r, 2));
  assert.equal(o1.base, tip);
  assert.equal(wtGit(r, 1, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), wtBranch(1));
  assert.equal(wtGit(r, 1, 'rev-parse', 'HEAD').trim(), tip, 'the worktree starts at the phase tip');
  // Built in reverse order of landing: the later task is reviewed first.
  const h2 = wtReview(r, 2);
  const h1 = wtReview(r, 1);
  assert.match(readFileSync(join(r.workspace, `review-${tip.slice(0, 7)}..${h1.slice(0, 7)}.diff`), 'utf8'), /src\/t1\.js/, 'the review package is BASE..<worktree head>');
  assert.equal(r.head(), tip, 'the phase branch moved before any close');

  const first = ok(closeOf(r, 1));
  assert.deepEqual(keys(first), ['sha', 'record']);
  const c1 = out(first);
  assert.equal(c1.sha, r.head(), 'the closed commit is the landed one');
  assert.ok(r.git('cat-file', 'commit', c1.sha).endsWith('\n\nfeat: t1\n'), 'the landed message is the first commit message, ending in exactly one newline');
  assert.equal(r.git('rev-parse', `${c1.sha}^`).trim(), tip, 'one commit on top of the phase tip');
  assert.equal(r.git('log', '-1', '--format=%s', c1.sha).trim(), 'feat: t1', "the task's first commit message");
  assert.equal(r.git('log', '-1', '--format=%an', c1.sha).trim(), 'Alice', "the task's first commit author");
  assert.deepEqual(landedOf(r, 1), [c1.sha]);
  const at = r.ledger().indexOf(`Landed: T1 ${c1.sha}`);
  assert.equal(r.ledger()[at + 1], `Prep: T1 r1 ${c1.sha}`, 'the landing re-states the Prep head, so the close check passes at the landed tip');
  assert.equal(r.ledger().at(-1), `Task 1: complete (commits ${sha7(tip)}..${sha7(c1.sha)}, review clean)`);
  assert.equal(r.taskState(1).status, 'done');
  assert.ok(r.calls().includes(`tasks done T1 --commit ${c1.sha} --plan ${r.plan}`), r.calls().join('\n'));
  assert.deepEqual(worktrees(r), [r.dir, wtPath(r, 2)], 'the first task still has a worktree');

  const c2 = out(ok(closeOf(r, 2)));
  assert.equal(c2.sha, r.head());
  assert.equal(r.git('rev-parse', `${c2.sha}^`).trim(), c1.sha, 'the second task lands on the first');
  assert.equal(r.git('rev-list', '--count', `${tip}..HEAD`).trim(), '2');
  assert.ok(['src/t1.js', 'src/t2.js', TEST_FILE[1], TEST_FILE[2]].every((f) => tracked(r, 'HEAD').includes(f)), tracked(r, 'HEAD').join('\n'));
  assert.equal(r.taskState(2).status, 'done');
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
  assert.equal(existsSync(wtPath(r, 2)), false);
  assert.notEqual(c2.sha, h2, 'the landed commit is a new commit');
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', h2, 'HEAD'], { cwd: r.dir, env: r.env }).status, 1, "the task's own commits are not in the phase history, only the landed one");
  noError(r);
}));

test('a task that finished first waits: task-close refuses with exit 3 while an earlier task has not landed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtOpen(r, 2);
  wtReview(r, 2);
  const before = r.ledger();
  const res = closeOf(r, 2);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /T1/);
  assert.deepEqual(r.ledger(), before, 'a wait writes no ledger line, no Error: line either');
  assert.equal(res.stdout, '');
  assert.equal(r.taskState(2).status, 'in_review');
  assert.equal(worktrees(r).length, 3, 'a worktree was removed');

  wtReview(r, 1);
  ok(closeOf(r, 1));
  ok(closeOf(r, 2));
  assert.equal(r.taskState(2).status, 'done');
  assert.deepEqual(landedOf(r, 2).length, 1);
}));

test('a dropped earlier task does not block landing', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 2);
  ok(r.triqual('tasks', 'drop', 'T1', 'not needed', '--plan', PLAN_NAME));
  wtReview(r, 2);
  const c2 = out(ok(closeOf(r, 2)));
  assert.equal(r.git('rev-parse', `${c2.sha}^`).trim(), tip);
  assert.equal(r.taskState(2).status, 'done');
}));

test('without tracking an earlier task is done when its complete line is in the ledger', () => withRig({ store: false, planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtOpen(r, 2);
  wtReview(r, 2);
  assert.equal(closeOf(r, 2).status, 3);
  wtReview(r, 1);
  ok(closeOf(r, 1));
  ok(closeOf(r, 2));
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 2: complete')).length, 1);
}));

test('a rerun after the landing skips it (Landed line) and finishes', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1);
  r.failMove('done');
  const first = closeOf(r, 1);
  assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
  const [landed] = landedOf(r, 1);
  assert.ok(landed, 'no Landed line');
  assert.equal(r.head(), landed, 'the phase branch is at the landed commit');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 0);
  assert.equal(worktrees(r).length, 2, 'the worktree is removed only after the close');

  r.allowMove('done');
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, landed, 'a second landing made a second commit');
  assert.deepEqual(landedOf(r, 1), [landed]);
  assert.equal(r.git('rev-list', '--count', `${tip}..HEAD`).trim(), '1');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 1);
  assert.equal(r.ledger().filter((l) => l.startsWith('Prep: T1 ')).length, 2, 'the landing Prep line is written once');
  assert.equal(r.taskState(1).status, 'done');
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
}));

test('a rerun after the close finishes the clean-up of the worktree and its branch', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  const first = out(ok(closeOf(r, 1)));
  // The clean-up of a first run that died after the complete line: the worktree and its branch are back.
  r.git('branch', wtBranch(1), first.sha);
  r.git('worktree', 'add', '-q', wtPath(r, 1), wtBranch(1));
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, first.sha);
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
}));

test('--head defaults to the wt branch tip', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  const reviewed = wtReview(r, 1);
  const later = wtCommit(r, 1, 'src/later.js', 'export const later = 1;\n', 'fix: later');
  // No --head: the wt branch tip is the head, and it is a commit no reviewer saw.
  const bare = closeOf(r, 1);
  assert.equal(bare.status, 3, `${bare.stdout}\n${bare.stderr}`);
  assert.match(bare.stderr, new RegExp(`commits after the last review.*HEAD ${later.slice(0, 7)}`));
  assert.equal(r.head(), tip, 'the phase branch moved');
  assert.deepEqual(landedOf(r, 1), []);

  const res = out(ok(closeOf(r, 1, '--head', reviewed)));
  assert.equal(r.git('rev-parse', `${res.sha}^`).trim(), tip);
  assert.equal(tracked(r, 'HEAD').includes('src/later.js'), false, 'the commit past --head was landed');
  assert.ok(tracked(r, 'HEAD').includes('src/t1.js'));
}));

test('an overlapping change is undone, moved back and logged', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  r.commit('src/shared.js', 'a\nb\nc\n', 'chore: shared');
  wtOpen(r, 1);
  wtOpen(r, 2);
  wtReview(r, 1, { source: ['src/shared.js', 'A\nb\nc\n'] });
  wtReview(r, 2, { source: ['src/shared.js', 'X\nb\nc\n'] });
  const c1 = out(ok(closeOf(r, 1)));
  r.clearCalls();

  const res = closeOf(r, 2);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /landing conflict.*src\/shared\.js/);
  assert.equal(r.head(), c1.sha, 'the phase branch is not at the previous tip');
  assert.equal(r.git('status', '--porcelain', '--untracked-files=no').trim(), '');
  assert.equal(r.git('show', 'HEAD:src/shared.js'), 'A\nb\nc\n');
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T2 ${c1.sha}`, 'Task 2: landing conflict — re-run sequential']);
  assert.match(r.ledger().at(-1), /^Error: task-close T2 — exit 3 — .*landing conflict/);
  assert.deepEqual(landedOf(r, 2), [], 'a conflict is no landing');
  assert.equal(r.taskState(2).status, 'in_progress', 'rework');
  assert.ok(r.calls().some((c) => c.startsWith('tasks rework T2 ')), r.calls().join('\n'));
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
  assert.equal(existsSync(wtPath(r, 2)), false);
}));

test('a failing Test file after landing is undone, moved back and logged', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: FAILING_TEST });
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /node --test/);
  assert.equal(r.head(), tip, 'the phase branch is not back at the previous tip');
  assert.equal(r.git('status', '--porcelain', '--untracked-files=no').trim(), '');
  assert.equal(tracked(r, 'HEAD').includes('src/t1.js'), false, 'the landed files are still in the tree');
  assert.equal(landedOf(r, 1).length, 1, 'the landing was ledgered before the tests ran');
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 3 — /);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 0);
  assert.equal(r.taskState(1).status, 'in_progress');
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
}));

test('a Test file that does not exist at the landed tip is a failure, never a pass', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  const head = wtCommit(r, 1, 'src/t1.js', 'export const t1 = 1;\n'); // the Test file was never committed
  ok(r.run('task-prep', r.plan, '1', '--head', head));
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /test\/one\.test\.mjs/);
  assert.equal(r.head(), tip);
  assert.equal(r.taskState(1).status, 'in_progress');
}));

test('the undo appends a fresh BASE line, and the sequential re-run closes from it', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: FAILING_TEST });
  assert.equal(closeOf(r, 1).status, 3);
  assert.equal(r.ledger().filter((l) => l === `BASE: T1 ${tip}`).length, 2, 'no fresh BASE line');

  // The stale Landed line and the Prep lines of the worktree attempt belong to the attempt the BASE line ended.
  const o = open(r, 1);
  assert.equal(o.base, tip);
  assert.equal(Object.hasOwn(o, 'workdir'), false);
  r.commit('src/t1.js', 'export const t1 = 1;\n', 'feat: t1 again');
  const prep = out(ok(r.run('task-prep', r.plan, '1')));
  assert.equal(prep.round, '1', 'the new BASE starts the review rounds again');
  assert.notEqual(prep.package, 'none');
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const closed = out(ok(closeOf(r, 1)));
  assert.equal(closed.sha, r.head());
  assert.equal(r.git('rev-parse', `${closed.sha}^`).trim(), tip);
  assert.equal(r.git('log', '-1', '--format=%s').trim(), 'feat: t1 again');
  assert.equal(r.ledger().at(-1), `Task 1: complete (commits ${sha7(tip)}..${sha7(closed.sha)}, review clean)`);
  assert.equal(recordOf(r, 1).attempt, 1);
}));

test('task-close: Landed and the landing Prep line after the complete line are the same attempt, not a reopen', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  const first = out(ok(closeOf(r, 1)));
  r.appendLedger(`Landed: T1 ${first.sha}`, `Prep: T1 r1 ${first.sha}`, 'Task 1: awaiting landing');
  r.clearCalls();
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, first.sha, 'a second landing or squash');
  assert.equal(again.record, 'already recorded');
  assert.equal(r.head(), first.sha);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 1);
  assert.equal(recordOf(r, 1).attempt, 1);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), []);
  // A Prep line at any other head is still new work on the task: not a resume, so the head check runs again and refuses.
  r.appendLedger(`Prep: T1 r2 ${r.git('rev-parse', 'HEAD~1').trim()}`);
  const reopened = closeOf(r, 1);
  assert.equal(reopened.status, 3, `${reopened.stdout}\n${reopened.stderr}`);
  assert.match(reopened.stderr, /commits after the last review/);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 1);
}));

test('task-close: a dirty phase branch is refused before anything lands', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  writeFileSync(join(r.dir, 'README.md'), '# repo, edited\n');
  const before = r.head();
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /not clean/);
  assert.equal(r.head(), before);
  assert.deepEqual(landedOf(r, 1), []);
  assert.equal(worktrees(r).length, 2);
}));

test('a task with no Test path is refused for a worktree', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  for (const [n, why] of [[3, /Test/], [4, /test\/four\.test\.ts.*\.mjs/]]) {
    const res = r.run('task-open', r.plan, String(n), '--worktree');
    assert.equal(res.status, 3, `T${n}: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, why, `T${n}`);
    assert.equal(res.stdout, '', `T${n}`);
    assert.match(r.ledger().at(-1), new RegExp(`^Error: task-open T${n} — exit 3 — `), `T${n}`);
    assert.equal(existsSync(wtPath(r, n)), false, `T${n}: a worktree was made`);
    assert.equal(r.taskState(n).status, 'pending', `T${n}: the task was started`);
    assert.equal(r.ledger().some((l) => l.startsWith(`BASE: T${n} `)), false, `T${n}: BASE was recorded`);
  }
  // The same tasks run in place as usual.
  assert.deepEqual(keys(ok(r.run('task-open', r.plan, '3'))), ['brief', 'report', 'base']);
}));

test('task-open --worktree adds the exclude entry once and reuses the worktree on a second run', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const exclude = join(r.dir, '.git', 'info', 'exclude');
  const entries = () => readFileSync(exclude, 'utf8').split('\n').filter((l) => l === '.claude/worktrees/');
  assert.deepEqual(entries(), []);
  const first = wtOpen(r, 1);
  assert.deepEqual(entries(), ['.claude/worktrees/']);
  assert.equal(existsSync(join(first.workdir, '.git')), true);
  assert.equal(r.git('status', '--porcelain').includes('.claude'), false, 'the worktrees are not excluded from git status');

  const mine = wtCommit(r, 1, 'src/t1.js', 'export const t1 = 1;\n');
  const second = wtOpen(r, 1);
  assert.deepEqual(second, first, 'a second run prints something else');
  assert.equal(wtGit(r, 1, 'rev-parse', 'HEAD').trim(), mine, 'the worktree was made again');
  assert.deepEqual(worktrees(r), [r.dir, wtPath(r, 1)]);
  assert.equal(r.ledger().filter((l) => l.startsWith('BASE: T1 ')).length, 1);

  wtOpen(r, 2);
  assert.deepEqual(entries(), ['.claude/worktrees/'], 'a second entry');
  assert.deepEqual(worktrees(r), [r.dir, wtPath(r, 1), wtPath(r, 2)]);
}));

test('an install failure is an Error line and exit 1', () => withRig({ planText: WT_PLAN }, (r) => {
  const installer = fakeInstallers(r);
  r.commit('package-lock.json', '{}\n', 'chore: lockfile');
  startStack(r);
  installer.fail();
  const res = r.run('task-open', r.plan, '1', '--worktree');
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /npm ci.*boom/);
  assert.equal(res.stdout, '');
  assert.match(r.ledger().at(-1), /^Error: task-open T1 — exit 1 — .*boom/);

  // The rerun reuses the worktree and installs again: a failed install is never taken for a done one.
  installer.heal();
  const again = wtOpen(r, 1);
  assert.equal(again.workdir, wtPath(r, 1));
  assert.deepEqual(installer.calls(), [`npm ci @ ${wtPath(r, 1)}`, `npm ci @ ${wtPath(r, 1)}`]);
  wtOpen(r, 1);
  assert.equal(installer.calls().length, 2, 'a worktree that installed was installed again');
}));

test('the install command follows the lockfile', () => {
  const cases = [
    [['package-lock.json'], 'npm ci'],
    [['pnpm-lock.yaml'], 'pnpm install --frozen-lockfile'],
    [['yarn.lock'], 'yarn install --frozen-lockfile'],
    [[], null],
  ];
  for (const [lockfiles, command] of cases) {
    withRig({ planText: WT_PLAN }, (r) => {
      const installer = fakeInstallers(r);
      for (const f of lockfiles) r.commit(f, '\n', `chore: ${f}`);
      startStack(r);
      const o = wtOpen(r, 1);
      assert.deepEqual(installer.calls(), command ? [`${command} @ ${o.workdir}`] : [], lockfiles.join());
    });
  }
});

// ---- worktree tasks: fix round 1 (the crash windows of the landing, the phase-branch guard, paths, timeout, stale outputs) ----

// A Test file that counts its runs in <root>/ran.log, and fails while <root>/fail.flag exists.
const countingTest = (r) => `import { test } from 'node:test';
import { appendFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
appendFileSync(${JSON.stringify(join(r.root, 'ran.log'))}, 'x\\n');
test('counted', () => { assert.equal(existsSync(${JSON.stringify(join(r.root, 'fail.flag'))}), false); });
`;
const testRuns = (r) => (existsSync(join(r.root, 'ran.log')) ? readFileSync(join(r.root, 'ran.log'), 'utf8').split('\n').filter(Boolean).length : 0);
const ledgerPath = (r) => join(r.workspace, 'sdd-ledger.md');
const editLedger = (r, keep) => writeFileSync(ledgerPath(r), `${readFileSync(ledgerPath(r), 'utf8').split('\n').filter((l) => l !== '' && keep(l)).join('\n')}\n`);
const testedOf = (r, n) => r.ledger().filter((l) => l.startsWith(`Tested: T${n} `)).map((l) => l.split(' ')[2]);
// A first close that dies right after the landing (`triqual tasks done` fails): the landing is ledgered and tested, nothing is closed.
const crashedAfterLanding = (r, n = 1) => {
  r.failMove('done');
  const first = closeOf(r, n);
  assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
  r.allowMove('done');
  const [landed] = landedOf(r, n);
  assert.ok(landed, 'no Landed line');
  return landed;
};
const noComplete = (r, n = 1) => assert.equal(r.ledger().filter((l) => l.startsWith(`Task ${n}: complete`)).length, 0, 'the task was closed');
const closeWithEnv = (r, n, extraEnv) => spawnSync(process.execPath, [join(SCRIPTS, 'task-close'), r.plan, String(n)], { cwd: r.dir, env: { ...r.env, ...extraEnv }, encoding: 'utf8' });

test('a green landing is ledgered as Tested, and a rerun with no Tested line runs the Test files again before it closes', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: countingTest(r) });
  const landed = crashedAfterLanding(r);
  assert.equal(testRuns(r), 1);
  const at = r.ledger().indexOf(`Landed: T1 ${landed}`);
  assert.deepEqual(r.ledger().slice(at, at + 3), [`Landed: T1 ${landed}`, `Prep: T1 r1 ${landed}`, `Tested: T1 ${landed}`]);

  // The crash window after the Landed line and before the tests ended: no Tested line.
  editLedger(r, (l) => !l.startsWith('Tested: T1 '));
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, landed);
  assert.equal(testRuns(r), 2, 'the Test files did not run again');
  assert.deepEqual(testedOf(r, 1), [landed]);
  assert.equal(r.git('rev-list', '--count', `${tip}..HEAD`).trim(), '1');
  assert.equal(r.taskState(1).status, 'done');
  assert.deepEqual(worktrees(r), [r.dir]);
}));

test('a landing that has a Tested line is not tested again on the rerun', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1, { test: countingTest(r) });
  const landed = crashedAfterLanding(r);
  ok(closeOf(r, 1));
  assert.equal(testRuns(r), 1, 'a tested landing was tested again');
  assert.deepEqual(landedOf(r, 1), [landed]);
}));

test('an untested landing whose Test files now fail is undone, never closed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: countingTest(r) });
  crashedAfterLanding(r);
  editLedger(r, (l) => !l.startsWith('Tested: T1 '));
  writeFileSync(join(r.root, 'fail.flag'), '');
  r.clearCalls();
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /node --test/);
  assert.equal(r.head(), tip, 'the failing landing is still on the phase branch');
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
  noComplete(r);
  assert.equal(r.taskState(1).status, 'in_progress');
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), []);
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
}));

test('an untested landing that is no longer the phase tip is refused, never closed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  const landed = crashedAfterLanding(r);
  editLedger(r, (l) => !l.startsWith('Tested: T1 '));
  const later = r.commit('src/later.js', 'export const later = 1;\n', 'feat: later');
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /no Tested: line/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 3 — /);
  assert.equal(r.head(), later);
  assert.equal(r.git('rev-parse', 'HEAD~1').trim(), landed);
  noComplete(r);
  assert.equal(r.taskState(1).status, 'in_review');
}));

test('a landing that is not on the phase branch (the undo died after the reset) is an Error, never closed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1);
  crashedAfterLanding(r);
  r.git('reset', '--keep', tip); // the undo got this far, then died before its BASE line
  r.clearCalls();
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /not on the phase branch/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 3 — .*not on the phase branch/);
  noComplete(r);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), []);
  assert.equal(r.taskState(1).status, 'in_review');
  assert.equal(r.head(), tip);
}));

test('an undo that died before its clean-up is finished by the rerun, and the task is not closed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: FAILING_TEST });
  r.failMove('rework');
  const first = closeOf(r, 1);
  assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
  assert.equal(r.head(), tip, 'the phase branch is back at the previous tip');
  assert.equal(worktrees(r).length, 2, 'the clean-up did not run yet');
  r.allowMove('rework');
  r.clearCalls();

  const again = closeOf(r, 1);
  assert.equal(again.status, 3, `${again.stdout}\n${again.stderr}`);
  assert.match(again.stderr, /undone earlier/);
  assert.equal(r.taskState(1).status, 'in_progress', 'the task was not moved back');
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
  assert.equal(r.head(), tip);
  assert.equal(r.ledger().filter((l) => l === 'Task 1: landing conflict — re-run sequential').length, 1);
  assert.equal(landedOf(r, 1).length, 1, 'a second landing');
  noComplete(r);
  assert.deepEqual(r.calls().filter((c) => c.startsWith('tasks done')), []);
}));

test('a crash between the landing and its Prep line does not strand the rerun', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  const landed = crashedAfterLanding(r);
  editLedger(r, (l) => l !== `Prep: T1 r1 ${landed}`);
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, landed);
  assert.equal(r.taskState(1).status, 'done');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 1);
}));

test('a crash between the reset and the Landed line records the landing that stands, not a second one', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: countingTest(r) });
  const landed = crashedAfterLanding(r);
  editLedger(r, (l) => !l.includes(landed)); // the phase branch moved; no Landed, Prep or Tested line was written
  const again = out(ok(closeOf(r, 1)));
  assert.equal(again.sha, landed, 'a second landing commit was made');
  assert.equal(r.head(), landed);
  assert.equal(r.git('rev-list', '--count', `${tip}..HEAD`).trim(), '1');
  assert.deepEqual(landedOf(r, 1), [landed]);
  assert.deepEqual(testedOf(r, 1), [landed]);
  assert.equal(testRuns(r), 2, 'the landing was closed untested');
  assert.equal(r.taskState(1).status, 'done');
}));

test('a crash between the reset and the Landed line, with Test files that now fail, goes back to the commit before the landing', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: countingTest(r) });
  const landed = crashedAfterLanding(r);
  editLedger(r, (l) => !l.includes(landed));
  writeFileSync(join(r.root, 'fail.flag'), '');
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.equal(r.head(), tip, 'the undo went back to the landing commit, not to the commit before it');
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
}));

test('a worktree task lands only on the active phase branch: another branch, the trunk and a detached HEAD are refused', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const phase = r.git('branch', '--show-current').trim();
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1);
  const trunkTip = r.git('rev-parse', 'main').trim();
  for (const [label, go, want] of [
    ['another branch', () => r.git('switch', '-q', '-c', 'other'), /HEAD is on other, not the active phase's branch/],
    ['the trunk', () => r.git('switch', '-q', 'main'), /HEAD is on main, not the active phase's branch/],
    ['a detached HEAD', () => r.git('switch', '-q', '--detach', phase), /HEAD is detached/],
  ]) {
    go();
    const here = r.head();
    const res = closeOf(r, 1);
    assert.equal(res.status, 3, `${label}: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, want, label);
    assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 3 — /, label);
    assert.equal(r.head(), here, `${label}: HEAD moved`);
    assert.equal(r.git('rev-parse', phase).trim(), tip, `${label}: the phase branch moved`);
    assert.equal(r.git('rev-parse', 'main').trim(), trunkTip, `${label}: the trunk moved`);
    assert.deepEqual(landedOf(r, 1), [], label);
    r.git('switch', '-q', phase);
  }
  ok(closeOf(r, 1));
}));

test('a Test path that is a glob or leaves the repository is refused when the worktree is opened', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  for (const [n, why] of [[5, /outside the repository/], [6, /glob/]]) {
    const res = r.run('task-open', r.plan, String(n), '--worktree');
    assert.equal(res.status, 3, `T${n}: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, why, `T${n}`);
    assert.match(r.ledger().at(-1), new RegExp(`^Error: task-open T${n} — exit 3 — `), `T${n}`);
    assert.equal(existsSync(wtPath(r, n)), false, `T${n}: a worktree was made`);
    assert.equal(r.taskState(n).status, 'pending', `T${n}: the task was started`);
  }
}));

test('a Test path the plan changed to leave the repository after the open is refused before anything lands', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1);
  writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace('`test/one.test.mjs`', '`../one.test.mjs`'));
  const res = closeOf(r, 1);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /outside the repository/);
  assert.equal(r.head(), tip);
  assert.deepEqual(landedOf(r, 1), []);
}));

test('a landing whose Test files outlive the timeout is a failure and is undone', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: "import { test } from 'node:test';\ntest('slow', async () => { await new Promise((done) => setTimeout(done, 6000)); });\n" });
  const bad = closeWithEnv(r, 1, { TRIQUAL_LANDING_TEST_TIMEOUT_MS: 'soon' });
  assert.equal(bad.status, 2, `${bad.stdout}\n${bad.stderr}`);
  assert.match(bad.stderr, /TRIQUAL_LANDING_TEST_TIMEOUT_MS/);
  assert.deepEqual(landedOf(r, 1), [], 'a bad timeout setting must be refused before the landing');
  assert.equal(r.head(), tip);

  const res = closeWithEnv(r, 1, { TRIQUAL_LANDING_TEST_TIMEOUT_MS: '1500' });
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /did not finish in 1500 ms/);
  assert.equal(r.head(), tip);
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
  assert.equal(r.taskState(1).status, 'in_progress');
  noComplete(r);
}));

test('the reviewer outputs of an undone worktree attempt are not counted for the sequential re-run', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  wtOpen(r, 1);
  wtReview(r, 1, { test: FAILING_TEST });
  // The undone attempt's second review round and its fix round.
  save(r, 1, 'spec-reviewer', 2, footerText('spec-reviewer'));
  r.appendLedger('Task 1: fix round 1');
  assert.equal(closeOf(r, 1).status, 3);
  ageOutputs(r, 1, 60);
  ageFile(join(r.workspace, 'task-1-spec-reviewer-r2.md'), 60);

  open(r, 1);
  r.commit('src/t1.js', 'export const t1 = 1;\n', 'feat: t1 again');
  const prep = out(ok(r.run('task-prep', r.plan, '1')));
  assert.equal(prep.round, '1');
  const stale = closeOf(r, 1);
  assert.equal(stale.status, 1, `${stale.stdout}\n${stale.stderr}`);
  assert.match(stale.stderr, /no saved safety-reviewer output for T1 after the undone landing/);
  noComplete(r);

  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const closed = out(ok(closeOf(r, 1)));
  assert.equal(r.git('rev-parse', `${closed.sha}^`).trim(), tip);
  assert.equal(recordOf(r, 1).fixRounds, 0, 'a fix round of the undone attempt was counted');
}));

test('a value that starts with a dash never reaches git as an option', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  const head = wtReview(r, 1);
  const bare = closeOf(r, 1, '--head=--output=pwned');
  assert.equal(bare.status, 2, `${bare.stdout}\n${bare.stderr}`);
  assert.match(bare.stderr, /bad --head/);
  r.appendLedger('BASE: T1 --output=pwned');
  const res = closeOf(r, 1, '--head', head);
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /BASE of T1 \(--output=pwned\) is not a commit/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 1 — /);
  assert.equal(existsSync(join(r.dir, 'pwned')), false);
  assert.deepEqual(landedOf(r, 1), []);
}));

test('the worktree of a landed task is removed with its untracked files, and a tracked change is an Error after everything is recorded', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  wtOpen(r, 1);
  wtReview(r, 1);
  mkdirSync(join(wtPath(r, 1), 'vendor'), { recursive: true });
  writeFileSync(join(wtPath(r, 1), 'vendor', 'installed.js'), 'x\n');
  writeFileSync(join(wtPath(r, 1), 'src', 't1.js'), 'export const t1 = 99;\n'); // an uncommitted change to a tracked file
  const first = closeOf(r, 1);
  assert.equal(first.status, 1, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stderr, /uncommitted changes to tracked files/);
  assert.match(first.stderr, /task-close again/);
  assert.match(r.ledger().at(-1), /^Error: task-close T1 — exit 1 — /);
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 1, 'the close is recorded');
  assert.equal(r.taskState(1).status, 'done');
  assert.equal(storedRecords(r).length, 1, 'the record is stored');
  assert.equal(existsSync(wtPath(r, 1)), true, 'the work in the worktree was thrown away');

  wtGit(r, 1, 'checkout', '--', 'src/t1.js');
  const again = closeOf(r, 1);
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.match(again.stderr, /removed the worktree .* with 1 untracked file: vendor\/installed\.js/);
  assert.deepEqual(worktrees(r), [r.dir]);
  assert.equal(wtBranches(r), '');
  assert.equal(storedRecords(r).length, 1, 'the record was made twice');
}));

// ---- worktree tasks: fix round 2 (the BASE of a worktree task is a closed commit of the phase branch) ----

// A task built in the main checkout: open, one commit, task-prep at it, the reviewers' outputs saved (not yet closed).
const mainReviewed = (r, n) => {
  open(r, n);
  const head = r.commit(`src/t${n}.js`, `export const t${n} = ${n};\n`, `feat: t${n}`);
  ok(r.run('task-prep', r.plan, String(n)));
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, n, 'spec-reviewer', 1, footerText('spec-reviewer'));
  return head;
};

test('a worktree task opened while a main-checkout task has an unreviewed commit is based at the last closed commit, not at that commit', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  const o1 = open(r, 1);
  assert.equal(o1.base, tip);
  const unreviewed = r.commit('src/t1.js', 'export const t1 = 1;\n', 'feat: t1');
  assert.notEqual(unreviewed, tip);

  const o2 = wtOpen(r, 2);
  assert.equal(o2.base, tip, 'BASE is the closed commit, not the main-checkout task commit');
  assert.equal(wtGit(r, 2, 'rev-parse', 'HEAD').trim(), tip, 'the worktree starts at the closed commit');
  assert.equal(existsSync(join(wtPath(r, 2), 'src', 't1.js')), false);
  assert.ok(r.ledger().includes(`BASE: T2 ${tip}`));
  assert.equal(r.ledger().includes(`BASE: T2 ${unreviewed}`), false);
  assert.equal(out(ok(r.run('task-open', r.plan, '2', '--worktree'))).base, tip, 'a rerun reads the recorded BASE');

  // The worktree task is reviewed on its own commits only.
  const h2 = wtReview(r, 2);
  const pkg = readFileSync(join(r.workspace, `review-${sha7(tip)}..${sha7(h2)}.diff`), 'utf8');
  assert.match(pkg, /src\/t2\.js/);
  assert.doesNotMatch(pkg, /src\/t1\.js/, "the other task's commit is in the review package");

  // T1 is closed (squashed on the phase branch), then T2 lands on it: BASE is an ancestor of both and the merge base is BASE.
  ok(r.run('task-prep', r.plan, '1'));
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  const c1 = out(ok(closeOf(r, 1)));
  const c2 = out(ok(closeOf(r, 2)));
  assert.equal(r.git('rev-parse', `${c2.sha}^`).trim(), c1.sha);
  assert.ok(['src/t1.js', 'src/t2.js'].every((f) => tracked(r, 'HEAD').includes(f)), tracked(r, 'HEAD').join('\n'));
  assert.equal(r.taskState(2).status, 'done');
  noError(r);
}));

test('a worktree task is based at the phase tip when the main-checkout task has no commit yet', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  const tip = r.head();
  open(r, 1);
  assert.equal(wtOpen(r, 2).base, tip);
  assert.equal(wtGit(r, 2, 'rev-parse', 'HEAD').trim(), tip);
}));

test('a worktree task is based at the phase tip once the main-checkout task is closed', () => withRig({ planText: WT_PLAN }, (r) => {
  startStack(r);
  mainReviewed(r, 1);
  const c1 = out(ok(closeOf(r, 1)));
  assert.equal(wtOpen(r, 2).base, c1.sha, 'a closed task: the tip is the closed commit');
  assert.equal(wtGit(r, 2, 'rev-parse', 'HEAD').trim(), c1.sha);
}));

test('a worktree task does not count as an unreviewed main-checkout task, and an earlier worktree task BASE is not reused', () => withRig({ planText: WT_PLAN.replace('- Create: `src/t3.js`\n', '- Create: `src/t3.js`\n- Test: `test/three.test.mjs`\n') }, (r) => {
  startStack(r);
  const tip = r.head();
  assert.equal(wtOpen(r, 2).base, tip);
  wtCommit(r, 2, 'src/t2.js', 'export const t2 = 2;\n');
  mainReviewed(r, 1);
  const c1 = out(ok(closeOf(r, 1)));
  // T2's worktree (BASE = tip) is open with commits not on the branch, and its BASE is older than the closed T1: T3 starts at c1.
  assert.equal(wtOpen(r, 3).base, c1.sha, "an open worktree task's BASE is not a closed commit of the tip");
  assert.equal(wtGit(r, 3, 'rev-parse', 'HEAD').trim(), c1.sha);
}));
