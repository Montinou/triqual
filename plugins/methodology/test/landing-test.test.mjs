// A plan's `**Landing test:**` command in task-open and task-close: with it a worktree task may have any Test path (a .ts file, say)
// and the landing runs `sh -c <command>` with {files} replaced by the Test paths, each single-quoted; without it today's
// `node --test` landing and its refusals stand. Every test runs the real scripts in a temp git repo (not opted in to tracking)
// with a temp HOME and a `triqual` wrapper on a private PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = 'demo-plan.md';

const planText = ({ landing, testPath }) => `# Landing plan

${landing === null ? '' : `**Landing test:** \`${landing}\`\n`}
## Global Constraints

- Nothing.

### Task 1: First

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/t1.js\`
- Test: \`${testPath}\`

- [ ] **Step 1:** one.
`;

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role) => `The review, in prose.\n\n${FOOTER_MARKER}\nrole: ${role}\nfindings: critical=0 important=0 minor=0\n`;

// The throwaway `triqual` the scripts call: the first argument names the CLI file of this checkout.
const WRAPPER = `#!/bin/sh
cmd=$1; shift
case "$cmd" in
  role-eval) exec node ${JSON.stringify(ROLE_EVAL_CLI)} "$@" ;;
  *) exec node ${JSON.stringify(PT_CLI)}/"$cmd".mjs "$@" ;;
esac
`;

function rig({ landing = 'grep -q ok {files}', testPath = 'test/one.test.ts' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'landing-test-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  for (const d of [home, dir, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT', 'TRIQUAL_LANDING_TEST_TIMEOUT_MS']) delete base[k];
  const env = {
    ...base, HOME: home, GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}${delimiter}${process.env.PATH}`,
    TRIQUAL_TRACKING_DB: join(root, 'data', 'tracking.db'), ROLE_EVAL_FILE: join(root, 'role-eval.jsonl'),
  };
  // task-close reads the hunter's model from the roles plugin as Claude Code records its install.
  const rolesDir = join(home, '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9');
  mkdirSync(join(rolesDir, 'agents'), { recursive: true });
  writeFileSync(join(rolesDir, 'agents', 'hunter.md'), '---\nname: hunter\ndescription: "Hunts."\nmodel: claude-haiku-4-9\neffort: medium\n---\n\nBody.\n');
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'roles@triqual': [{ scope: 'user', installPath: rolesDir, version: '9.9.9', lastUpdated: '2026-10-19T15:07:03.965Z' }] } }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  const plan = join('docs', 'plans', PLAN_NAME);
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, plan), planText({ landing, testPath }));
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const run = (script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: 'utf8' });
  const runWith = (extraEnv, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const r = {
    root, dir, git, env, plan, workspace, run, runWith, testPath,
    head: () => git('rev-parse', 'HEAD').trim(),
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    appendLedger: (...lines) => appendFileSync(ledgerPath, lines.map((l) => `${l}\n`).join('')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return r;
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
const out = (res) => Object.fromEntries(res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  return [line.slice(0, at), line.slice(at + 2)];
}));

const startStack = (r) => {
  ok(r.run('stack.mjs', 'init', r.plan, '--mode', 'local'));
  ok(r.run('stack.mjs', 'phase', r.plan, '1'));
};
const wtPath = (r) => join(r.dir, '.claude', 'worktrees', 'demo-plan-t1');
const wtGit = (r, ...args) => execFileSync('git', args, { cwd: wtPath(r), env: r.env, encoding: 'utf8' });
const wtCommit = (r, file, text, message) => {
  mkdirSync(dirname(join(wtPath(r), file)), { recursive: true });
  writeFileSync(join(wtPath(r), file), text);
  wtGit(r, 'add', '-A');
  wtGit(r, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-q', '--author', 'Alice <alice@example.invalid>', '-m', message);
  return wtGit(r, 'rev-parse', 'HEAD').trim();
};
const save = (r, role, text) => writeFileSync(join(r.workspace, `task-1-${role}-r1.md`), text);
// The task's whole worktree round: open, a source commit and a Test-file commit in the worktree, task-prep, the reviewers' outputs.
const built = (r, testText) => {
  ok(r.run('task-open', r.plan, '1', '--worktree'));
  wtCommit(r, 'src/t1.js', 'export const t1 = 1;\n', 'feat: t1');
  const head = wtCommit(r, r.testPath, testText, 'test: t1');
  ok(r.run('task-prep', r.plan, '1', '--head', head));
  save(r, 'safety-reviewer', footerText('safety-reviewer'));
  save(r, 'spec-reviewer', footerText('spec-reviewer'));
  return head;
};
const close = (r, extraEnv = {}) => r.runWith(extraEnv, 'task-close', r.plan, '1');

test('a .ts Test path opens a worktree under a Landing test', () => withRig({}, (r) => {
  const opened = out(ok(r.run('task-open', r.plan, '1', '--worktree')));
  assert.equal(opened.workdir, wtPath(r));
  assert.ok(existsSync(wtPath(r)), 'the worktree is not there');
}));

test("a .ts Test path is refused without one (today's message)", () => withRig({ landing: null }, (r) => {
  const res = r.run('task-open', r.plan, '1', '--worktree');
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /T1: the Test: path test\/one\.test\.ts is not a \.mjs, \.js or \.cjs file, which node --test runs at landing/);
  assert.equal(existsSync(wtPath(r)), false, 'a worktree was made');
  assert.match(r.ledger().at(-1), /^Error: task-open T1 — exit 3 — /);
}));

test('a Landing test still refuses a glob and a path outside the repository', () => {
  for (const [testPath, why] of [['test/*.test.ts', /is a glob/], ['../escape.test.ts', /is outside the repository/]]) {
    withRig({ testPath }, (r) => {
      const res = r.run('task-open', r.plan, '1', '--worktree');
      assert.equal(res.status, 3, `${testPath}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr, why);
      assert.equal(existsSync(wtPath(r)), false, 'a worktree was made');
    });
  }
});

test('a passing command lands the task', () => withRig({}, (r) => {
  startStack(r);
  const tip = r.head();
  const head = built(r, 'ok\n');
  assert.equal(r.head(), tip, 'the phase branch moved before the close');
  const res = ok(close(r));
  const sha = out(res).sha;
  assert.equal(sha, r.head(), 'the closed commit is the landed one');
  assert.equal(r.git('rev-parse', `${sha}^`).trim(), tip, 'one commit on top of the phase tip');
  assert.ok(r.git('ls-tree', '-r', '--name-only', sha).split('\n').includes('src/t1.js'));
  const lines = r.ledger();
  assert.ok(lines.includes(`Landed: T1 ${sha}`));
  assert.ok(lines.includes(`Tested: T1 ${sha}`), 'the green run is ledgered');
  assert.ok(existsSync(join(r.workspace, 'task-1-landing-test.log')), 'the log is not there');
  assert.notEqual(head, sha);
  assert.equal(existsSync(wtPath(r)), false, 'the worktree is still there');
}));

test('a failing command undoes the landing', () => withRig({}, (r) => {
  startStack(r);
  const tip = r.head();
  built(r, 'bad\n');
  const res = close(r);
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /landing failed: the Landing test exited 1 at the landed tip \(output in .*task-1-landing-test\.log\)/);
  assert.equal(r.head(), tip, 'the phase branch is not back at the previous tip');
  assert.equal(r.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes('src/t1.js'), false, 'the landed files are still in the tree');
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
  assert.equal(r.ledger().filter((l) => l.startsWith('Tested: ')).length, 0, 'a failed run is no Tested line');
  assert.equal(r.ledger().filter((l) => l.startsWith('Task 1: complete')).length, 0);
  assert.ok(existsSync(join(r.workspace, 'task-1-landing-test.log')), 'the log is not there');
  assert.ok(existsSync(join(r.workspace, 'task-1-undone')), 'the marker is not there');
  assert.equal(existsSync(wtPath(r)), false, 'the worktree is still there');
}));

test('a path with a space and a quote is one argument', () => {
  const testPath = "test/it's a file.test.ts";
  // The command records its arguments and its directory; it needs no other effect to pass.
  const landing = `node -e "require('node:fs').writeFileSync('landing-args.json', JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))" {files}`;
  withRig({ landing, testPath }, (r) => {
    startStack(r);
    built(r, 'ok\n');
    ok(close(r));
    const seen = JSON.parse(readFileSync(join(r.dir, 'landing-args.json'), 'utf8'));
    assert.deepEqual(seen.args, [testPath], 'the path was split or altered');
    assert.equal(realpathSync(seen.cwd), r.dir, 'the command did not run at the repository root');
  });
});

test('the timeout applies', () => withRig({ landing: 'exec sleep 30 # {files}' }, (r) => {
  startStack(r);
  const tip = r.head();
  built(r, 'ok\n');
  const started = Date.now();
  const res = close(r, { TRIQUAL_LANDING_TEST_TIMEOUT_MS: '1500' });
  assert.equal(res.status, 3, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stderr, /the Landing test did not finish in 1500 ms/);
  assert.ok(Date.now() - started < 20000, 'the run was not cut off');
  assert.equal(r.head(), tip);
  assert.deepEqual(r.ledger().slice(-3, -1), [`BASE: T1 ${tip}`, 'Task 1: landing conflict — re-run sequential']);
}));
