// `triqual tracking write plan --all <dir> [--replace]` (initiative chain B, T21): every plan of a directory is checked
// first and registered only when all are good. Every test runs in a temp repo marked for store mode, with a temp HOME
// and TRIQUAL_TRACKING_DB pointing into the temp dir; no test touches the real tracking store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../lib/store.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'cli', 'tracking.mjs');
const PLAN_CLI = join(PLUGIN, 'cli', 'plan.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

await loadSqlite();

const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR']) delete env[k];
  return { ...env, ...extra };
};

const GOOD = (name) => `# ${name}\n\n### Task 1: A\n\n### Task 2: B\n**Depends on:** T1\n`;
const BAD = '# bad\n\n### Task 1: A\n\n### Task 2: B\n**Depends on:** T9\n';

function withRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-write-all-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const plans = join(dir, 'plans');
  const dataDir = join(dir, 'data');
  for (const d of [repo, home, plans]) mkdirSync(d);
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db') };
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git('commit', '-qm', 'initial');
  git('config', '--local', 'triqual.tracking', 'store');
  openStore({ home, env: dbEnv, create: true }).close();
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env: cleanEnv(home, dbEnv), encoding: 'utf8' });
  const put = (name, text) => writeFileSync(join(plans, name), text);
  // The plan files registered in the store, by file name.
  const registered = () => {
    const store = openStore({ home, env: dbEnv });
    try { return store.all('SELECT path FROM plans ORDER BY path').map((r) => r.path.replace(/^plans\//, '')); } finally { store.close(); }
  };
  const docsPlans = () => {
    const store = openStore({ home, env: dbEnv });
    try {
      const { repo_key: key } = store.get('SELECT repo_key FROM repos') ?? {};
      return key ? readdirSync(join(dataDir, 'repos', key, 'plans')).filter((f) => f.endsWith('.md')).sort() : [];
    } catch { return []; } finally { store.close(); }
  };
  const docsPlansDir = () => {
    const store = openStore({ home, env: dbEnv });
    try { return join(dataDir, 'repos', store.get('SELECT repo_key FROM repos').repo_key, 'plans'); } finally { store.close(); }
  };
  return { dir, repo, plans, run, put, registered, docsPlans, docsPlansDir };
}

test('two good plans register', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-a.md', GOOD('a'));
  s.put('2026-11-03-b.md', GOOD('b'));
  const r = s.run(['write', 'plan', '--all', s.plans]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.registered(), ['2026-11-03-a.md', '2026-11-03-b.md']);
  const paths = r.stdout.split('\n').filter((l) => l.startsWith('/'));
  assert.equal(paths.length, 2);
  assert.match(paths[0], /2026-11-03-a\.md$/);
  assert.match(paths[1], /2026-11-03-b\.md$/);
});

test('one bad plan blocks all: nothing is registered, ERR names the file, exit 1', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-a.md', GOOD('a'));
  s.put('2026-11-03-b.md', BAD);
  s.put('2026-11-03-c.md', GOOD('c'));
  const r = s.run(['write', 'plan', '--all', s.plans]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, 'ERR 2026-11-03-b.md: T2 depends on T9, which is not a task of the plan\n');
  assert.deepEqual(s.registered(), []);
  assert.deepEqual(s.docsPlans(), []);
});

test('--replace re-registers; without it an adopted plan is refused', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-a.md', GOOD('a'));
  assert.equal(s.run(['write', 'plan', '--all', s.plans]).status, 0);
  s.put('2026-11-03-a.md', `${GOOD('a')}\n### Task 3: C\n`);
  const again = s.run(['write', 'plan', '--all', s.plans]);
  assert.notEqual(again.status, 0);
  const replaced = s.run(['write', 'plan', '--all', s.plans, '--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, /reconciled .*added T3/);
});

test('--all with a file is a usage error (exit 2), and so is --all on another kind or an empty directory', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-a.md', GOOD('a'));
  const file = s.run(['write', 'plan', '--all', join(s.plans, '2026-11-03-a.md')]);
  assert.equal(file.status, 2);
  assert.match(file.stderr, /--all takes a directory/);
  assert.equal(s.run(['write', 'spec', '--all', s.plans]).status, 2);
  assert.equal(s.run(['add', '--all', s.plans]).status, 2);
  const empty = join(s.dir, 'empty');
  mkdirSync(empty);
  assert.equal(s.run(['write', 'plan', '--all', empty]).status, 2);
  assert.deepEqual(s.registered(), []);
});

test('generated lane plans register after the bad one is fixed', (t) => {
  const s = withRepo(t);
  const template = join(s.dir, 'template.md');
  const data = join(s.dir, 'data.json');
  const out = join(s.dir, 'generated');
  writeFileSync(template, `# {{name}} Implementation Plan

**Branch prefix:** initiative-{{name}}

## Phase 1: Only
**Branch:** initiative-{{name}}/01-only
**Parent:** {{parent}}
**PR title:** feat: {{name}}

{{#each tasks}}
### Task {{@n}}: {{title}}

**Tier:** standard
**Depends on:** {{dep}}

{{/each}}
`);
  const lane = (name, dep) => ({ file: `2026-11-03-${name}.md`, name, tasks: [{ title: 'one' }, { title: 'two', dep }] });
  const generate = (plans) => {
    writeFileSync(data, JSON.stringify({ defaults: { dep: 'none', parent: 'initiative-b/00-base' }, plans }));
    return spawnSync(process.execPath, [PLAN_CLI, 'generate', '--template', template, '--data', data, '--out', out, '--replace'], { encoding: 'utf8' });
  };
  assert.equal(generate([lane('x', 'none'), lane('y', 'T9'), lane('z', 'T1')]).status, 1);
  const blocked = s.run(['write', 'plan', '--all', out]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /^ERR 2026-11-03-y\.md: T2 depends on T9/);
  assert.deepEqual(s.registered(), []);
  assert.equal(generate([lane('x', 'none'), lane('y', 'T1'), lane('z', 'T1')]).status, 0);
  const r = s.run(['write', 'plan', '--all', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.registered(), ['2026-11-03-x.md', '2026-11-03-y.md', '2026-11-03-z.md']);
});

test('an already registered plan refuses the whole run before anything is written', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-b.md', GOOD('b'));
  assert.equal(s.run(['write', 'plan', join(s.plans, '2026-11-03-b.md')]).status, 0);
  s.put('2026-11-03-a.md', GOOD('a'));
  const r = s.run(['write', 'plan', '--all', s.plans]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, 'ERR 2026-11-03-b.md: plan 2026-11-03-b.md already exists\n');
  assert.deepEqual(s.registered(), ['2026-11-03-b.md']);
  assert.deepEqual(s.docsPlans(), ['2026-11-03-b.md']);
  const replaced = s.run(['write', 'plan', '--all', s.plans, '--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.deepEqual(s.registered(), ['2026-11-03-a.md', '2026-11-03-b.md']);
});

test('a failure midway names the plans already registered and keeps the exit code', (t) => {
  const s = withRepo(t);
  s.put('2026-11-03-z.md', GOOD('z'));
  assert.equal(s.run(['write', 'plan', join(s.plans, '2026-11-03-z.md')]).status, 0);
  rmSync(join(s.plans, '2026-11-03-z.md'));
  s.put('2026-11-03-a.md', GOOD('a'));
  s.put('2026-11-03-b.md', GOOD('b'));
  // A dangling link takes the name of b in the documents directory: it passes the checks and fails when b is copied.
  symlinkSync(join(s.dir, 'nowhere'), join(s.docsPlansDir(), '2026-11-03-b.md'));
  const r = s.run(['write', 'plan', '--all', s.plans]);
  assert.equal(r.status, 2, r.stdout);
  const lines = r.stderr.split('\n');
  assert.equal(lines[0], 'registered before the failure:');
  assert.match(lines[1], /2026-11-03-a\.md$/);
  assert.equal(lines[2], 'plan 2026-11-03-b.md already exists');
  assert.deepEqual(s.registered(), ['2026-11-03-a.md', '2026-11-03-z.md']);
});
