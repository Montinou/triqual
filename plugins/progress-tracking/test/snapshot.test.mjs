import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProgressEntries, buildSnapshot, planView } from '../lib/snapshot.mjs';
import { BRAND } from '../lib/brand.mjs';
import { registerRepo } from '../lib/registry.mjs';
import { resolveTracking } from '../lib/tracking.mjs';
import { createLedger } from '../lib/ledger.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const HINT = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const PROGRESS = `# Progress

Append-only log: one entry per task, newest on top.

## 2026-09-27 — Second task
- **Stage/task:** Plan sp2-tracking · T2
- **Done:** the second thing

## 2026-09-26 — First task
- **Stage/task:** Plan sp2-tracking · T1
- **Done:** the first thing
`;
const STATUS = '# Status\n\n**Last updated:** 2026-09-27\n';

// Every child runs with a temp HOME, no XDG_CONFIG_HOME and no inherited repo-selecting variables.
const cleanEnv = (home) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return env;
};

// A temp dir with `home/` and a helper that makes git repos (one commit on `main`) under it; removed afterwards.
function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-snap-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = cleanEnv(home);
  const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, env, encoding: 'utf8' }).trim();
  const makeRepo = (name) => {
    const repo = join(dir, name);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-qm', 'initial');
    return repo;
  };
  const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  try {
    fn({ dir, home, git, makeRepo, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };

// Tracking files in `root` (the repo root in committed mode, <git-common-dir>/methodology in local mode).
function track(root, plansDir) {
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(root, 'progress.md'), PROGRESS);
  writeFileSync(join(root, 'status.md'), STATUS);
}

const TASKS = [
  { id: 'T1', title: 'Alpha', deps: [], skills: ['a'] },
  { id: 'T2', title: 'Beta', deps: ['T1'], skills: [] },
  { id: 'T3', title: 'Gamma', deps: [], skills: [] },
  { id: 'T4', title: 'Delta', deps: [], skills: [] },
];

// An active ledger (T1 done, T2 in progress, T3 dropped, T4 blocked) and a done one (T1 done).
function writeLedgers(plansDir) {
  const active = createLedger({ plan: 'docs/plans/2026-09-27-new.md', spec: null, branch: 'main', tasks: TASKS, now: 'x' });
  Object.assign(active.tasks[0], { status: 'done', commits: ['abc1234'] });
  Object.assign(active.tasks[1], { status: 'in_progress' });
  Object.assign(active.tasks[2], { status: 'dropped', reason: 'not needed' });
  Object.assign(active.tasks[3], { status: 'blocked', reason: 'waiting on T9' });
  const done = createLedger({ plan: 'docs/plans/2026-09-01-old.md', spec: null, branch: 'main', tasks: TASKS.slice(0, 1), now: 'x' });
  Object.assign(done.tasks[0], { status: 'done', commits: ['def5678'] });
  done.state = 'done';
  writeFileSync(join(plansDir, '2026-09-01-old.tasks.json'), JSON.stringify(done));
  writeFileSync(join(plansDir, '2026-09-27-new.tasks.json'), JSON.stringify(active));
}

const EXPECTED_PLANS = [
  {
    name: '2026-09-27-new',
    state: 'active',
    done: 1,
    total: 3,
    tasks: [
      { id: 'T1', title: 'Alpha', status: 'done', reason: null, tier: null, effectiveTier: null, commits: ['abc1234'], skills: ['a'] },
      { id: 'T2', title: 'Beta', status: 'in_progress', reason: null, tier: null, effectiveTier: null, commits: [], skills: [] },
      { id: 'T3', title: 'Gamma', status: 'dropped', reason: 'not needed', tier: null, effectiveTier: null, commits: [], skills: [] },
      { id: 'T4', title: 'Delta', status: 'blocked', reason: 'waiting on T9', tier: null, effectiveTier: null, commits: [], skills: [] },
    ],
  },
  {
    name: '2026-09-01-old',
    state: 'done',
    done: 1,
    total: 1,
    tasks: [{ id: 'T1', title: 'Alpha', status: 'done', reason: null, tier: null, effectiveTier: null, commits: ['def5678'], skills: ['a'] }],
  },
];

const EXPECTED_ENTRIES = [
  {
    date: '2026-09-27',
    title: 'Second task',
    stageTask: 'Plan sp2-tracking · T2',
    body: '- **Stage/task:** Plan sp2-tracking · T2\n- **Done:** the second thing',
  },
  {
    date: '2026-09-26',
    title: 'First task',
    stageTask: 'Plan sp2-tracking · T1',
    body: '- **Stage/task:** Plan sp2-tracking · T1\n- **Done:** the first thing',
  },
];

function committedRepo(repo) {
  track(repo, join(repo, 'docs', 'plans'));
  writeLedgers(join(repo, 'docs', 'plans'));
  return resolveTracking(repo);
}

function localRepo(repo) {
  const root = join(repo, '.git', 'methodology');
  mkdirSync(root, { recursive: true });
  track(root, join(root, 'plans'));
  writeLedgers(join(root, 'plans'));
  return resolveTracking(repo);
}

test('parseProgressEntries reads date, title, stageTask, body and caps at max', () => {
  assert.deepEqual(parseProgressEntries(PROGRESS), EXPECTED_ENTRIES);
  assert.deepEqual(parseProgressEntries(PROGRESS, 1), EXPECTED_ENTRIES.slice(0, 1));
  assert.deepEqual(parseProgressEntries('# Progress\n\nnothing yet\n'), []);
  // Spanish-format entries (committed entries are never edited) carry the stage in **Etapa/tarea:**.
  const mixed = parseProgressEntries('# Progreso\n\n## 2026-09-27 — Tarea nueva\n- **Etapa/tarea:** Etapa 2 · Task 3\n'
    + '- **Hecho:** algo\n\n## 2026-09-26 — English task\n- **Stage/task:** fuera de plan\n');
  assert.deepEqual(mixed.map((e) => e.stageTask), ['Etapa 2 · Task 3', 'fuera de plan']);
  const undated = parseProgressEntries('# P\n\n## Kickoff notes\nfree text\n\n### sub\nmore\n');
  assert.deepEqual(undated, [{ date: null, title: 'Kickoff notes', stageTask: null, body: 'free text\n\n### sub\nmore' }]);
  const many = Array.from({ length: 25 }, (_, i) => `## 2026-09-${String(i + 1).padStart(2, '0')} — E${i}\nbody ${i}\n`).join('\n');
  const parsed = parseProgressEntries(many);
  assert.equal(parsed.length, 20);
  assert.deepEqual(parsed[19], { date: '2026-09-20', title: 'E19', stageTask: null, body: 'body 19' });
});

test('buildSnapshot matches the D.1 shape exactly', () => withDir(({ makeRepo }) => {
  const repo = makeRepo('skillvault');
  const t = committedRepo(repo);
  assert.deepEqual(buildSnapshot(t, { now: NOW, shareable: true }), {
    schema: `${BRAND.legacy.marketplace}/tracking-snapshot@1`,
    generatedAt: '2026-09-27T12:00:00.000Z',
    repo: { name: 'skillvault', root: repo, mode: 'committed', branch: 'main', shareable: true },
    plans: EXPECTED_PLANS,
    status: { text: STATUS },
    progress: { entries: EXPECTED_ENTRIES },
  });
  assert.equal(buildSnapshot(t, { now: NOW, shareable: false }).repo.shareable, false);
}));

test('local mode forces shareable false', () => withDir(({ makeRepo }) => {
  const repo = makeRepo('client');
  const t = localRepo(repo);
  assert.equal(t.mode, 'local');
  const snap = buildSnapshot(t, { now: NOW, shareable: true });
  assert.deepEqual(snap.repo, { name: 'client', root: repo, mode: 'local', branch: 'main', shareable: false });
  assert.deepEqual(snap.plans, EXPECTED_PLANS);
  assert.deepEqual(snap.status, { text: STATUS });
  assert.deepEqual(snap.progress, { entries: EXPECTED_ENTRIES });
}));

test('a detached HEAD gives branch null', () => withDir(({ git, makeRepo }) => {
  const repo = makeRepo('repo');
  const t = committedRepo(repo);
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(buildSnapshot(t, { now: NOW, shareable: false }).repo.branch, null);
}));

test('a corrupt ledger is skipped', () => withDir(({ makeRepo }) => {
  const repo = makeRepo('repo');
  const t = committedRepo(repo);
  const plans = join(repo, 'docs', 'plans');
  writeFileSync(join(plans, '2026-09-28-broken.tasks.json'), '{ not json');
  writeFileSync(join(plans, '2026-09-29-array.tasks.json'), '[]');
  writeFileSync(join(plans, '2026-09-30-done-no-tasks.tasks.json'), JSON.stringify({ version: 1, state: 'done', tasks: 3 }));
  mkdirSync(join(plans, '2026-10-01-dir.tasks.json'));
  assert.deepEqual(buildSnapshot(t, { now: NOW, shareable: false }).plans, EXPECTED_PLANS);
}));

test('export --json and --all via the CLI', () => withDir(({ home, makeRepo, run }) => {
  const a = makeRepo('alpha');
  committedRepo(a);
  const b = makeRepo('beta');
  localRepo(b);
  const c = makeRepo('gamma'); // status.md is a directory: its snapshot throws and is skipped
  mkdirSync(join(c, 'status.md'));
  writeFileSync(join(c, 'progress.md'), PROGRESS);
  const gone = makeRepo('gone');
  writeFileSync(join(gone, 'progress.md'), PROGRESS);
  for (const [root, mode] of [[a, 'committed'], [c, 'committed'], [gone, 'committed'], [b, 'local']]) {
    registerRepo(home, { root, mode, now: NOW });
  }
  rmSync(gone, { recursive: true, force: true });
  const registry = join(home, '.config', 'triqual', 'repos.json');
  const reg = JSON.parse(readFileSync(registry, 'utf8'));
  for (const r of reg.repos) r.shareable = true;
  writeFileSync(registry, JSON.stringify(reg));

  // One repo: shareable from its registry entry.
  const one = JSON.parse(ok(run(['export', '--json'], a)).stdout);
  assert.equal(one.schema, `${BRAND.legacy.marketplace}/tracking-snapshot@1`);
  assert.deepEqual(one.repo, { name: 'alpha', root: a, mode: 'committed', branch: 'main', shareable: true });
  assert.deepEqual(one.plans, EXPECTED_PLANS);
  assert.deepEqual(one.progress.entries, EXPECTED_ENTRIES);
  assert.ok(!Number.isNaN(Date.parse(one.generatedAt)));

  // A repo missing from the registry exports shareable false.
  const d = makeRepo('delta');
  committedRepo(d);
  assert.equal(JSON.parse(ok(run(['export', '--json'], d)).stdout).repo.shareable, false);

  // --all, from outside any repo: every resolvable registered repo, a failing one skipped with a warning.
  const all = ok(run(['export', '--json', '--all'], home));
  const snaps = JSON.parse(all.stdout);
  assert.deepEqual(snaps.map((s) => [basename(s.repo.root), s.repo.mode, s.repo.shareable]),
    [['alpha', 'committed', true], ['beta', 'local', false]]);
  assert.match(all.stderr, new RegExp(`warning: skipping ${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));

  // Not opted in, without --all: exit 2 with the usual hint.
  const plain = makeRepo('plain');
  const r = run(['export', '--json'], plain);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `${HINT}\n`);
  assert.equal(r.stdout, '');
  // --json is required.
  assert.equal(run(['export'], a).status, 2);
}));

test('export --all with no registry prints an empty array', () => withDir(({ home, run }) => {
  assert.equal(ok(run(['export', '--json', '--all'], home)).stdout, '[]\n');
}));

test('export --all resolves each registered repo once', () => withDir(({ dir, home, makeRepo, run }) => {
  const a = makeRepo('alpha');
  committedRepo(a);
  registerRepo(home, { root: a, mode: 'committed', now: NOW });
  const bin = join(dir, 'fake-git');
  mkdirSync(bin);
  const log = join(dir, 'git.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const env = { ...cleanEnv(home), PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [BIN, 'export', '--json', '--all'], { cwd: home, env, encoding: 'utf8' });
  ok(r);
  assert.equal(JSON.parse(r.stdout).length, 1);
  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith(`${a}|`) && l.includes('--show-toplevel'));
  assert.equal(calls.length, 1, calls.join('\n'));
}));

test('planView gives each task its skills array, [] when the ledger task has none', () => {
  const ledger = createLedger({ plan: 'docs/plans/x.md', spec: null, branch: 'main', tasks: TASKS.slice(0, 2), now: 'x' });
  delete ledger.tasks[1].skills;
  const view = planView('x', ledger);
  assert.deepEqual(view.tasks.map((t) => t.skills), [['a'], []]);
  view.tasks[0].skills.push('mutated');
  assert.deepEqual(ledger.tasks[0].skills, ['a'], 'planView shares the ledger task\'s skills array');
});
