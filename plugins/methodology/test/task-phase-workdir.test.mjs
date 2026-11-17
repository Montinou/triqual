// task-open, task-prep and task-close in a plan whose phases run side by side (plan C, phase 2): each script reads HEAD, the index
// and the tree, resets and runs the landing's Test files in the checkout of the phase that holds its task (the phase worktree the
// state records as `workdir`), and a worktree task lands only on its own phase's branch. Every test runs the real scripts in a temp git
// repo that is not opted in to tracking, with a temp HOME, as the rig of task-scripts.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitOf, isAncestor } from '../skills/executing-plans/scripts/lib/task-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = 'demo-plan.md';
const P1_BRANCH = 'demo/01-one';
const P2_BRANCH = 'demo/02-two';

// P1 holds T1; P2 starts at the trunk (a forest, so the state is a `prs` one) and holds T2 and T3.
const task = (n, file, test) => `### Task ${n}: Task number ${n}

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`${file}\`
- Test: \`${test}\`

- [ ] **Step 1:** do ${n}.

`;
const PLAN = `# Demo plan

**Branch prefix:** demo

## Phase 1: One

**Slice:** S1
**Branch:** ${P1_BRANCH}
**PR title:** feat: one
**Parent:** trunk
**Stands alone because:** one only
**Phase check:** \`true\` → exit 0

${task(1, 'src/a.js', 'test/a.test.mjs')}## Phase 2: Two

**Slice:** S2
**Branch:** ${P2_BRANCH}
**PR title:** feat: two
**Parent:** trunk
**Stands alone because:** two only
**Phase check:** \`true\` → exit 0

${task(2, 'src/b.js', 'test/b.test.mjs')}${task(3, 'src/c.js', 'test/c.test.mjs')}`;
const TEST_FILE = { 1: 'test/a.test.mjs', 2: 'test/b.test.mjs', 3: 'test/c.test.mjs' };
const SOURCE_FILE = { 1: 'src/a.js', 2: 'src/b.js', 3: 'src/c.js' };

const cleanEnv = (home, extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT', 'TRIQUAL_NOW']) delete env[k];
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
};

// `triqual <command> ...` straight into this repo's progress-tracking and role-eval CLIs, on a private PATH.
const WRAPPER = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const [command, ...rest] = process.argv.slice(2);
const cli = { tasks: ${JSON.stringify(PT_CLI)} + '/tasks.mjs', tracking: ${JSON.stringify(PT_CLI)} + '/tracking.mjs', 'role-eval': ${JSON.stringify(ROLE_EVAL_CLI)} }[command];
if (!cli) { process.stderr.write('triqual: unknown command ' + command + '\\n'); process.exit(1); }
const res = spawnSync(process.execPath, [cli, ...rest], { stdio: 'inherit' });
process.exit(res.status ?? 1);
`;

// A repo with one commit holding the plan under docs/plans (not opted in to tracking). `r.plan` is the PLAN_FILE argument.
function rig({ planText = PLAN } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-phase-workdir-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  const evalFile = join(root, 'role-eval.jsonl');
  for (const d of [home, dir, bin]) mkdirSync(d);
  // The roles plugin as Claude Code records its install: task-close reads the hunter's model from its agent file.
  const rolesDir = join(home, '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9');
  mkdirSync(join(rolesDir, 'agents'), { recursive: true });
  writeFileSync(join(rolesDir, 'agents', 'hunter.md'), '---\nname: hunter\ndescription: "Hunts."\nmodel: claude-haiku-4-9\neffort: medium\n---\n\nBody.\n');
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'roles@triqual': [{ scope: 'user', installPath: rolesDir, version: '9.9.9', lastUpdated: '2026-10-19T15:07:03.965Z' }] } }));
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  const env = cleanEnv(home, { ROLE_EVAL_FILE: evalFile, PATH: `${bin}${delimiter}${process.env.PATH}` });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  const plan = join('docs', 'plans', PLAN_NAME);
  writeFileSync(join(dir, plan), planText);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const statePath = join(dir, '.methodology', 'stack', 'demo-plan.json');
  const runIn = (cwd, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, env, encoding: 'utf8' });
  return {
    root, dir, git, env, plan, workspace, statePath, runIn,
    run: (script, ...args) => runIn(dir, script, ...args),
    head: () => git('rev-parse', 'HEAD').trim(),
    commit(file, text, message = `edit ${file}`) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
      git('add', '-A', '--', '.', ':(exclude).methodology');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    appendLedger: (...lines) => appendFileSync(ledgerPath, lines.map((l) => `${l}\n`).join('')),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setPhase(n, fields) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      Object.assign(state.phases.find((p) => p.n === n), fields);
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const withRig = (fn, opts = {}) => {
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
const refused = (res, pattern) => {
  assert.equal(res.status, 3, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, pattern);
};
const out = (res) => Object.fromEntries(res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  assert.ok(at > 0, `not a key: value line: ${line}`);
  return [line.slice(0, at), line.slice(at + 2)];
}));
const keys = (res) => Object.keys(out(res));
const open = (r, n) => out(ok(r.run('task-open', r.plan, String(n))));
const wtOpen = (r, n) => out(ok(r.run('task-open', r.plan, String(n), '--worktree')));
const closeOf = (r, n, ...extra) => r.run('task-close', r.plan, String(n), ...extra);
const sha7 = (sha) => sha.slice(0, 7);

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role) => ['The review, in prose.', '', FOOTER_MARKER, `role: ${role}`, 'findings: critical=0 important=0 minor=0'].join('\n') + '\n';
const save = (r, n, role, round, text) => writeFileSync(join(r.workspace, `task-${n}-${role}-r${round}.md`), text);
const savedOutputs = (r, n) => {
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, n, 'spec-reviewer', 1, footerText('spec-reviewer'));
};
const PASSING_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => { assert.equal(1, 2); });\n";

const p2Dir = (r) => join(r.dir, '.claude', 'worktrees', 'demo-plan-p2');
const p2Git = (r, ...args) => execFileSync('git', args, { cwd: p2Dir(r), env: r.env, encoding: 'utf8' });
const p2Commit = (r, file, text, message) => {
  mkdirSync(dirname(join(p2Dir(r), file)), { recursive: true });
  writeFileSync(join(p2Dir(r), file), text);
  p2Git(r, 'add', '-A');
  p2Git(r, 'commit', '-q', '-m', message);
  return p2Git(r, 'rev-parse', 'HEAD').trim();
};
const wtPath = (r, n) => join(r.dir, '.claude', 'worktrees', `demo-plan-t${n}`);
const wtGit = (r, n, ...args) => execFileSync('git', args, { cwd: wtPath(r, n), env: r.env, encoding: 'utf8' });
// A commit made inside the task's worktree, by its implementer (a different author than the repo's committer).
const wtCommit = (r, n, file, text, message) => {
  mkdirSync(dirname(join(wtPath(r, n), file)), { recursive: true });
  writeFileSync(join(wtPath(r, n), file), text);
  wtGit(r, n, 'add', '-A');
  wtGit(r, n, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-q', '--author', 'Alice <alice@example.invalid>', '-m', message);
  return wtGit(r, n, 'rev-parse', 'HEAD').trim();
};
// A worktree task built and reviewed in its worktree: a source commit and a Test-file commit, task-prep at that head, the outputs saved.
const wtReview = (r, n, { test = PASSING_TEST } = {}) => {
  wtCommit(r, n, SOURCE_FILE[n], `export const t${n} = ${n};\n`, `feat: t${n}`);
  const head = wtCommit(r, n, TEST_FILE[n], test, `test: t${n}`);
  ok(r.run('task-prep', r.plan, String(n), '--head', head));
  savedOutputs(r, n);
  return head;
};
// Both phases active: P1 in the main checkout, P2 in its own worktree on its own branch, both from the trunk's tip.
const twoActive = (r) => {
  ok(r.run('stack.mjs', 'init', r.plan, '--mode', 'local'));
  ok(r.run('stack.mjs', 'phase', r.plan, '1'));
  mkdirSync(join(r.dir, '.git', 'info'), { recursive: true });
  appendFileSync(join(r.dir, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
  const tip = r.git('rev-parse', 'main').trim();
  r.git('worktree', 'add', '-q', '-b', P2_BRANCH, p2Dir(r), tip);
  r.setPhase(2, { state: 'active', workdir: p2Dir(r), base: tip });
  return tip;
};
// What the main checkout shows: its HEAD, its branch and its tracked changes.
const mainView = (r) => ({
  head: r.head(),
  branch: r.git('symbolic-ref', '--short', 'HEAD').trim(),
  status: r.git('status', '--porcelain', '--untracked-files=no'),
});
const noError = (r) => assert.deepEqual(r.ledger().filter((l) => l.startsWith('Error:')), []);

test('a task built in place in a phase worktree takes its BASE there and closes there', () => withRig((r) => {
  const tip = twoActive(r);
  const first = r.run('task-open', r.plan, '1');
  assert.deepEqual(keys(ok(first)), ['brief', 'report', 'base'], 'a phase built in the main checkout prints no workdir');
  const unreviewed = r.commit('src/a.js', 'a\n', 'feat: a');
  const mainBefore = mainView(r);

  const second = ok(r.run('task-open', r.plan, '2'));
  assert.deepEqual(keys(second), ['brief', 'report', 'base', 'workdir']);
  assert.equal(out(second).base, tip, "BASE is the phase worktree's HEAD, not the main checkout's unreviewed commit");
  assert.notEqual(out(second).base, unreviewed);
  assert.equal(out(second).workdir, p2Dir(r));
  assert.ok(r.ledger().includes(`BASE: T2 ${tip}`), r.ledger().join('\n'));

  p2Commit(r, 'src/b.js', 'export const b = 2;\n', 'feat: b');
  const head = p2Commit(r, 'test/b.test.mjs', PASSING_TEST, 'fixup! feat: b');
  const prep = out(ok(r.run('task-prep', r.plan, '2')));
  assert.notEqual(prep.package, 'none');
  assert.match(readFileSync(prep.package, 'utf8'), /src\/b\.js/, 'the review package is the phase worktree\'s BASE..HEAD');
  assert.ok(r.ledger().includes(`Prep: T2 r1 ${head}`), `the Prep line is at the worktree's HEAD\n${r.ledger().join('\n')}`);
  savedOutputs(r, 2);

  const closed = out(ok(closeOf(r, 2)));
  assert.equal(closed.sha, p2Git(r, 'rev-parse', 'HEAD').trim(), "the squash is the phase worktree's HEAD");
  assert.equal(p2Git(r, 'rev-parse', `${closed.sha}^`).trim(), tip, 'one commit on top of BASE');
  assert.equal(p2Git(r, 'rev-list', '--count', `${tip}..HEAD`).trim(), '1');
  assert.equal(r.ledger().at(-1), `Task 2: complete (commits ${sha7(tip)}..${sha7(closed.sha)}, review clean)`);
  assert.deepEqual(mainView(r), mainBefore, "the main checkout's HEAD, branch and tree are unchanged");
  noError(r);
}));

test("a worktree task of P2 is based on P2's tip, never on P1's unreviewed commits, and lands without touching main", () => withRig((r) => {
  const tip = twoActive(r);
  open(r, 1);
  const unreviewed = r.commit('src/a.js', 'a\n', 'feat: a');
  writeFileSync(join(r.dir, 'README.md'), '# repo, edited in main\n');
  const mainBefore = mainView(r);
  assert.notEqual(mainBefore.status, '', 'the main checkout is dirty');

  const o = wtOpen(r, 3);
  assert.equal(o.base, tip, "BASE is P2's branch tip");
  assert.notEqual(o.base, unreviewed);
  assert.equal(o.workdir, wtPath(r, 3));
  assert.equal(wtGit(r, 3, 'rev-parse', 'HEAD').trim(), tip, "the task's worktree starts at P2's tip");

  wtReview(r, 3);
  const closed = out(ok(closeOf(r, 3)));
  assert.equal(p2Git(r, 'rev-parse', 'HEAD').trim(), closed.sha, "the landed commit is P2's worktree HEAD");
  assert.equal(p2Git(r, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), P2_BRANCH);
  assert.equal(p2Git(r, 'rev-parse', `${closed.sha}^`).trim(), tip, 'one commit on top of the P2 tip');
  assert.equal(r.git('rev-parse', `refs/heads/${P1_BRANCH}`).trim(), unreviewed, "P1's branch did not move");
  assert.deepEqual(mainView(r), mainBefore, "the main checkout's HEAD, branch and dirty file are unchanged");
  assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), '# repo, edited in main\n');
  assert.equal(existsSync(wtPath(r, 3)), false, "the task's worktree is gone");
  noError(r);
}));

test("a landing's Test files run in the phase worktree", () => withRig((r) => {
  twoActive(r);
  const log = join(r.root, 'cwd.log');
  wtOpen(r, 3);
  const where = `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('where', () => { appendFileSync(${JSON.stringify(log)}, \`\${process.cwd()}\\n\`); });\n`;
  wtReview(r, 3, { test: where });
  ok(closeOf(r, 3));
  assert.ok(existsSync(log), 'the Test file did not run');
  const cwds = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((p) => realpathSync(p));
  assert.deepEqual(cwds, [realpathSync(p2Dir(r))], "the Test file ran in P2's worktree");
}));

test('an undone landing resets the phase worktree to its tip from before the landing', () => withRig((r) => {
  twoActive(r);
  const tip = p2Commit(r, 'src/earlier.js', 'export const earlier = 1;\n', 'feat: earlier');
  open(r, 1);
  r.commit('src/a.js', 'a\n', 'feat: a');
  const mainBefore = mainView(r);
  assert.equal(wtOpen(r, 3).base, tip);
  wtReview(r, 3, { test: FAILING_TEST });

  refused(closeOf(r, 3), /landing failed: node --test exited \d+ at the landed tip/);
  assert.equal(p2Git(r, 'rev-parse', 'HEAD').trim(), tip, "P2's worktree is back at its tip from before the landing");
  assert.equal(p2Git(r, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.deepEqual(mainView(r), mainBefore, 'main is untouched');
  assert.ok(r.ledger().includes(`BASE: T3 ${tip}`), r.ledger().join('\n'));
  assert.ok(r.ledger().includes('Task 3: landing conflict — re-run sequential'), r.ledger().join('\n'));
  assert.equal(existsSync(wtPath(r, 3)), false, "the task's worktree is removed");
}));

test('a worktree task with no commit closes at its own phase tip', () => withRig((r) => {
  twoActive(r);
  const p2tip = p2Commit(r, 'src/earlier.js', 'export const earlier = 1;\n', 'feat: earlier');
  const p1tip = r.commit('src/a.js', 'a\n', 'feat: a');
  assert.notEqual(p1tip, p2tip);
  const o = wtOpen(r, 3);
  assert.equal(o.base, p2tip);

  const closed = out(ok(closeOf(r, 3)));
  assert.equal(closed.sha, p2tip, "the task closes at P2's tip, not P1's");
  assert.equal(r.ledger().at(-1), `Task 3: complete (commits ${sha7(p2tip)}..${sha7(p2tip)}, review clean)`);
  assert.equal(p2Git(r, 'rev-parse', 'HEAD').trim(), p2tip);
  assert.equal(r.head(), p1tip);
  noError(r);
}));

test("a task whose phase is not active is refused naming its phase", () => withRig((r) => {
  twoActive(r);
  wtOpen(r, 3);
  wtReview(r, 3);
  r.setPhase(2, { state: 'done' });
  refused(closeOf(r, 3), /T3's phase P2 is done: a worktree task lands only on its own active phase's branch/);
  assert.ok(r.ledger().some((l) => /^Error: task-close T3 — exit 3 — T3's phase P2 is done/.test(l)), r.ledger().join('\n'));

  r.setPhase(1, { state: 'done' });
  refused(closeOf(r, 3), /no phase is active: a worktree task lands on the active phase's branch/);
}));

test('a dirty main checkout does not block a close in a clean phase worktree; a dirty phase worktree is refused', () => withRig((r) => {
  const tip = twoActive(r);
  wtOpen(r, 3);
  wtReview(r, 3);
  writeFileSync(join(r.dir, 'README.md'), '# repo, edited in main\n');
  writeFileSync(join(p2Dir(r), 'README.md'), '# repo, edited in P2\n');

  refused(closeOf(r, 3), /not clean/);
  assert.equal(p2Git(r, 'rev-parse', 'HEAD').trim(), tip, 'nothing landed');

  p2Git(r, 'checkout', '--', 'README.md');
  const closed = out(ok(closeOf(r, 3)));
  assert.equal(p2Git(r, 'rev-parse', 'HEAD').trim(), closed.sha);
  assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), '# repo, edited in main\n', 'the main checkout kept its change');
}));

test('with no stack state the scripts act on the main checkout as before', () => withRig((r) => {
  const base = r.head();
  const opened = ok(r.run('task-open', r.plan, '1'));
  assert.deepEqual(keys(opened), ['brief', 'report', 'base']);
  assert.equal(out(opened).base, base);
  const head = r.commit('src/a.js', 'a\n', 'feat: a');
  const prep = out(ok(r.run('task-prep', r.plan, '1')));
  assert.match(prep.package, new RegExp(`review-${sha7(base)}\\.\\.${sha7(head)}\\.diff$`));
  assert.ok(r.ledger().includes(`Prep: T1 r1 ${head}`));
  savedOutputs(r, 1);
  refused(closeOf(r, 1), /no stack state at .*demo-plan\.json: run stack init first/);
  assert.equal(r.head(), head, 'nothing was squashed');
}));

test('commitOf and isAncestor read in the cwd they are given', () => withRig((r) => {
  const tip = twoActive(r);
  const p1tip = r.commit('src/a.js', 'a\n', 'feat: a');
  const p2tip = p2Commit(r, 'src/b.js', 'b\n', 'feat: b');
  assert.equal(commitOf('HEAD', { cwd: p2Dir(r) }), p2tip);
  assert.equal(commitOf('HEAD', { cwd: r.dir }), p1tip);
  assert.equal(commitOf('refs/heads/nope', { cwd: p2Dir(r) }), null);
  assert.equal(isAncestor(tip, 'HEAD', { cwd: p2Dir(r) }), true);
  assert.equal(isAncestor(p1tip, 'HEAD', { cwd: p2Dir(r) }), false);
  assert.equal(isAncestor(p1tip, 'HEAD', { cwd: r.dir }), true);
}));
