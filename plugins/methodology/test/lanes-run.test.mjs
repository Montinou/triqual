// Two light tasks in two lanes: both open in their own worktree at once, close in the order they finish (each landing on the
// tip the other left, with no wait), and the timeline reads the run as two tasks at once. Every step runs the real scripts of
// this checkout in a temp git repo (not opted in to tracking) with a temp HOME and a `triqual` wrapper on a private PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = 'demo-plan.md';

const task = (n, lane) => `### Task ${n}: Task ${n}

**Tier:** light
**Lane:** ${lane}
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/${lane.toLowerCase()}.js\`
- Test: \`test/${lane.toLowerCase()}.test.mjs\`

- [ ] **Step 1:** do it.
`;
const planText = () => `# Lanes plan

## Global Constraints

- Nothing.

${task(1, 'A')}
${task(2, 'B')}`;

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role) => `The review, in prose.\n\n${FOOTER_MARKER}\nrole: ${role}\nfindings: critical=0 important=0 minor=0\n`;

// The throwaway `triqual` the scripts call. It answers `plan` itself (two lanes), so the test does not depend on `triqual plan lanes`.
const WRAPPER = `#!/bin/sh
cmd=$1; shift
case "$cmd" in
  plan) echo '{"parallelism": 2}'; exit 0 ;;
  role-eval) exec node ${JSON.stringify(ROLE_EVAL_CLI)} "$@" ;;
  *) exec node ${JSON.stringify(PT_CLI)}/"$cmd".mjs "$@" ;;
esac
`;

function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lanes-run-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  for (const d of [home, dir, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT', 'TRIQUAL_LANDING_TEST_TIMEOUT_MS', 'TRIQUAL_NOW']) delete base[k];
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
  writeFileSync(join(dir, plan), planText());
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const run = (script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: 'utf8' });
  const runWith = (extraEnv, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return {
    root, dir, git, env, plan, workspace, run, runWith,
    head: () => git('rev-parse', 'HEAD').trim(),
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const withRig = (fn) => {
  const r = rig();
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
// A script run with the clock fixed at `time`.
const at = (r, time, script, ...args) => r.runWith({ TRIQUAL_NOW: time }, script, ...args);

const LANE = { 1: 'a', 2: 'b' };
const wtPath = (r, n) => join(r.dir, '.claude', 'worktrees', `demo-plan-t${n}`);
const wtGit = (r, n, ...args) => execFileSync('git', args, { cwd: wtPath(r, n), env: r.env, encoding: 'utf8' });
const wtCommit = (r, n, file, text, message) => {
  mkdirSync(dirname(join(wtPath(r, n), file)), { recursive: true });
  writeFileSync(join(wtPath(r, n), file), text);
  wtGit(r, n, 'add', '-A');
  wtGit(r, n, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-q', '--author', 'Alice <alice@example.invalid>', '-m', message);
  return wtGit(r, n, 'rev-parse', 'HEAD').trim();
};
// The task's round in its worktree: a source commit and a passing Test-file commit, task-prep, the safety reviewer's output.
const build = (r, n) => {
  const lane = LANE[n];
  wtCommit(r, n, `src/${lane}.js`, `export const ${lane} = ${n};\n`, `feat: t${n}`);
  const head = wtCommit(r, n, `test/${lane}.test.mjs`, "import { test } from 'node:test';\ntest('passes', () => {});\n", `test: t${n}`);
  ok(r.run('task-prep', r.plan, String(n), '--head', head));
  writeFileSync(join(r.workspace, `task-${n}-safety-reviewer-r1.md`), footerText('safety-reviewer'));
  return head;
};

test('two light tasks in two lanes open in two worktrees, land in the order they finish, and the timeline shows them at once', () => withRig((r) => {
  startStack(r); const tip = r.head();
  ok(at(r, '2026-11-16T10:00:00Z', 'task-open', r.plan, '1', '--worktree'));
  ok(at(r, '2026-11-16T10:00:00Z', 'task-open', r.plan, '2', '--worktree'));
  build(r, 2); build(r, 1);
  const c2 = out(ok(at(r, '2026-11-16T10:05:00Z', 'task-close', r.plan, '2')));
  const c1 = out(ok(at(r, '2026-11-16T10:10:00Z', 'task-close', r.plan, '1')));
  assert.equal(r.git('rev-parse', `${c2.sha}^`).trim(), tip);
  assert.equal(r.git('rev-parse', `${c1.sha}^`).trim(), c2.sha);
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Error:')), []);
  // T1 10:00–10:10 and T2 10:00–10:05: no open window, no Serial line, so the plan line is the whole output.
  assert.deepEqual(ok(r.run('timeline.mjs', r.plan)).stdout.split('\n'), ['plan demo-plan: wall-clock 10.0 min, task time 15.0 min, achieved 1.50, 2 at once, planned: 2.00', '']);
}));
