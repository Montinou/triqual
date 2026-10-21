// task-open and task-prep (thin controller, T1): the two scripts that fold a task's start and its review preparation into
// one call each. Every test runs the real scripts in a temp git repo with a temp HOME. The tracking CLI is the real
// `triqual tasks` code of the progress-tracking plugin, reached through a `triqual` wrapper on a private PATH that logs
// every call (the installed shim would pick the plugin out of the machine's Claude install); the opted-in repos are in
// store mode, with TRIQUAL_TRACKING_DB pointing into the temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../../progress-tracking/lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
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
const cli = { tasks: 'tasks.mjs', tracking: 'tracking.mjs' }[command];
if (!cli) { process.stderr.write('triqual: unknown command ' + command + '\\n'); process.exit(1); }
appendFileSync(process.env.TRIQUAL_CALL_LOG, [command, ...rest].join(' ') + '\\n');
// A test makes a move fail by creating "<log>.fail-<subcommand>".
if (existsSync(process.env.TRIQUAL_CALL_LOG + '.fail-' + rest[0])) { process.stderr.write('triqual: forced failure of ' + rest[0] + '\\n'); process.exit(1); }
const res = spawnSync(process.execPath, [${JSON.stringify(PT_CLI)} + '/' + cli, ...rest], { stdio: 'inherit' });
process.exit(res.status ?? 1);
`;

// A repo with one commit holding the plan (store: the plan lives in the store's plans directory and is registered, the repo
// is opted in; otherwise it is committed under docs/plans and the repo is not opted in). `r.plan` is the PLAN_FILE argument.
function rig({ store = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-scripts-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  const log = join(root, 'triqual.log');
  const dbEnv = { TRIQUAL_TRACKING_DB: join(root, 'data', 'tracking.db') };
  for (const d of [home, dir, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  writeFileSync(log, '');
  const env = cleanEnv(home, { ...dbEnv, PATH: `${bin}${delimiter}${process.env.PATH}`, TRIQUAL_CALL_LOG: log });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const triqual = (...args) => spawnSync(join(bin, 'triqual'), args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  let plan;
  if (store) {
    git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
    const plansDir = JSON.parse(triqual('tasks', 'paths', '--json').stdout).plansDir;
    mkdirSync(plansDir, { recursive: true });
    plan = join(plansDir, PLAN_NAME);
    writeFileSync(plan, PLAN);
    const init = triqual('tasks', 'init', plan);
    assert.equal(init.status, 0, init.stderr);
  } else {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    plan = join('docs', 'plans', PLAN_NAME);
    writeFileSync(join(dir, plan), PLAN);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  writeFileSync(log, '');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const runIn = (cwd, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, env, encoding: 'utf8' });
  return {
    root, dir, git, plan, workspace, triqual,
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
  assert.ok(r.calls().includes('tasks retier T1 heavy --reason 301 changed lines (over 300): src/big.js --plan demo-plan.md'));
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
  assert.deepEqual(r.calls().filter((c) => /^tasks (rework|review) /.test(c)), ['tasks rework T1 --plan demo-plan.md', 'tasks review T1 --plan demo-plan.md']);
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
