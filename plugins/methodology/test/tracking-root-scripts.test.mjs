// The task scripts in a clone that is not opted in, with TRIQUAL_TRACKING_ROOT naming a store-mode root that holds the plan,
// its ledger and the entries. The real stack.mjs, task-open, task-prep and task-close run in the clone; `triqual` is a
// wrapper on a private PATH that dispatches to this checkout's CLI files (the installed shim would pick the plugin out of the
// machine's Claude install). Every path is a temp dir with a temp HOME and TRIQUAL_TRACKING_DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../../progress-tracking/lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = '2026-11-03-chain-demo.md';
const PLAN = `# Chain demo

## Global Constraints

- Nothing.

### Task 1: Standard task

**Tier:** standard
**Role:** roles:tdd-implementer

- [ ] **Step 1:** one.
`;
const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role) => `The review, in prose.\n\n${FOOTER_MARKER}\nrole: ${role}\nfindings: critical=0 important=0 minor=0\n`;

await loadSqlite();

const cleanEnv = (home, extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT']) delete env[k];
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
};

// The throwaway `triqual` the scripts call: the first argument names the CLI file of this checkout.
const wrapper = () => `#!/bin/sh
cmd=$1; shift
case "$cmd" in
  role-eval) exec node ${JSON.stringify(ROLE_EVAL_CLI)} "$@" ;;
  *) exec node ${JSON.stringify(PT_CLI)}/"$cmd".mjs "$@" ;;
esac
`;

function withRootAndClone(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracking-root-scripts-')));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const rootDir = join(dir, 'root');
  const cloneDir = join(dir, 'clone');
  for (const d of [home, bin, rootDir, cloneDir]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), wrapper(), { mode: 0o755 });
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') };
  const base = cleanEnv(home, { ...dbEnv, ROLE_EVAL_FILE: join(dir, 'role-eval.jsonl'), PATH: `${bin}${delimiter}${process.env.PATH}` });
  const gitIn = (cwd) => (...args) => execFileSync('git', args, { cwd, env: base, encoding: 'utf8' }).trim();
  const rootGit = gitIn(rootDir);
  const git = gitIn(cloneDir);
  for (const g of [rootGit, git]) {
    g('init', '-q', '-b', 'main');
    g('config', '--local', 'user.name', 'Test');
    g('config', '--local', 'user.email', 'test@example.invalid');
    g('config', '--local', 'commit.gpgsign', 'false');
  }
  writeFileSync(join(rootDir, 'README.md'), '# root\n');
  rootGit('add', '-A');
  rootGit('commit', '-q', '-m', 'initial');
  writeFileSync(join(cloneDir, 'README.md'), '# clone\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  // The root: store mode, the plan registered with the checkout's `tracking.mjs write plan`.
  rootGit('config', '--local', 'triqual.tracking', 'store');
  openStore({ home, env: dbEnv, create: true }).close();
  const rootRun = (cli, ...args) => spawnSync(process.execPath, [join(PT_CLI, cli), ...args], { cwd: rootDir, env: base, encoding: 'utf8' });
  const draft = join(dir, PLAN_NAME);
  writeFileSync(draft, PLAN);
  const written = rootRun('tracking.mjs', 'write', 'plan', draft);
  assert.equal(written.status, 0, written.stderr);
  const plansDir = JSON.parse(rootRun('tasks.mjs', 'paths', '--json').stdout).plansDir;
  const plan = join(plansDir, PLAN_NAME);
  assert.ok(existsSync(plan), `the plan is not at ${plan}`);

  const env = { ...base, TRIQUAL_TRACKING_ROOT: rootDir };
  const run = (script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: cloneDir, env, encoding: 'utf8' });
  const workspace = join(cloneDir, '.methodology', 'sdd', PLAN_NAME.replace(/\.md$/, ''));
  try {
    return fn({ dir, rootDir, cloneDir, home, dbEnv, git, rootGit, plan, run, workspace, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (res) => {
  assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
};
const out = (res) => Object.fromEntries(res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  return [line.slice(0, at), line.slice(at + 2)];
}));

test('a plan stored at the root drives a clone that is not opted in', () => withRootAndClone(({ dir, home, dbEnv, git, plan, run, workspace, cloneDir, env }) => {
  // Without the variable the clone is not opted in: that is what the variable replaces.
  const probe = spawnSync(join(dir, 'bin', 'triqual'), ['tasks', 'paths', '--json'], { cwd: cloneDir, env: { ...process.env, HOME: home, ...dbEnv, TRIQUAL_TRACKING_ROOT: '' }, encoding: 'utf8' });
  assert.equal(JSON.parse(probe.stdout).optedIn, false);

  ok(run('stack.mjs', 'init', plan, '--mode', 'local'));
  ok(run('stack.mjs', 'phase', plan, '1'));
  const opened = out(ok(run('task-open', plan, '1')));
  writeFileSync(join(cloneDir, 'a.js'), 'export const a = 1;\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'feat: a');
  writeFileSync(join(cloneDir, 'b.js'), 'export const b = 2;\n');
  git('add', 'b.js');
  git('commit', '-q', '-m', 'fixup! feat: a');
  const prepped = out(ok(run('task-prep', plan, '1')));
  assert.equal(prepped.tier, 'standard');
  writeFileSync(join(workspace, `task-${1}-safety-reviewer-r1.md`), footerText('safety-reviewer'));
  writeFileSync(join(workspace, 'task-1-spec-reviewer-r1.md'), footerText('spec-reviewer'));
  const closed = out(ok(run('task-close', plan, '1')));
  assert.equal(closed.sha, git('rev-parse', 'HEAD'));
  assert.equal(git('rev-parse', `${closed.sha}^`), opened.base, 'one commit on top of BASE');

  // The root's ledger: T1 done, its commit recorded as the clone's.
  const store = openStore({ home, env: dbEnv });
  try {
    const repo = store.get('SELECT id FROM repos');
    const stored = store.plans(repo.id)[0];
    const task = store.ledgerOf(stored.id).tasks.find((t) => t.id === 'T1');
    assert.equal(task.status, 'done');
    assert.deepEqual(task.commits, [`ext:../clone@${closed.sha}`]);
    // The store holds the review entry, with the same commit.
    const entries = store.all('SELECT state, commit_sha, title FROM entries ORDER BY id');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, 'committed');
    assert.equal(entries[0].commit_sha, `ext:../clone@${closed.sha}`);
    assert.match(entries[0].title, /^T1 review closed at /);
  } finally {
    store.close();
  }

  // The clone: no tracking files, no hooks, no store marker, nothing to commit.
  for (const f of ['progress.md', 'status.md']) assert.equal(existsSync(join(cloneDir, f)), false, f);
  assert.deepEqual(readdirSync(join(cloneDir, '.git', 'hooks')).filter((f) => !f.endsWith('.sample')), []);
  assert.equal(spawnSync('git', ['config', '--local', '--get', 'triqual.tracking'], { cwd: cloneDir, env, encoding: 'utf8' }).status, 1);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(readFileSync(join(workspace, 'sdd-ledger.md'), 'utf8').split('\n').filter((l) => l.startsWith('Error:')), []);
}));
