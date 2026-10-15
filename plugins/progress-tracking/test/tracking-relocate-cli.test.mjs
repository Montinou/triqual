// `triqual tracking relocate <old-root>` (plan public-repo-move T2): moves a store row from a checkout that is going away
// to the checkout the command runs in. Every test runs two temp git repos A (opted in to store mode, with one committed
// entry and a status) and B (a fresh clone, no marker) under a temp HOME, TRIQUAL_TRACKING_DB and TRIQUAL_REGISTRY_DIR;
// no test touches a real data directory or registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { readRegistry, registerRepo } from '../lib/registry.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'cli', 'tracking.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

await loadSqlite();

const ENTRY = `## 2026-10-14 — Seed entry
- **Stage/task:** off-plan
- **Done:** seeded
- **Files:** a.mjs
- **Verification:** none
- **Next:** relocate
`;
const STATUS = '## Goal\n\nmove the checkout\n';

const cleanEnv = (home, extra) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR']) delete env[k];
  return { ...env, ...extra };
};

function initRepo(dir, name) {
  const repo = join(dir, name);
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git('add', 'README.md');
  git('commit', '-qm', 'initial');
  return { repo, git };
}

// A (store mode, one committed entry, a status, registered) and B (unmarked), with a runner for each.
function withRepos(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-relocate-cli-')));
  const home = join(dir, 'home');
  const drafts = join(dir, 'drafts');
  const dataDir = join(dir, 'data');
  const registryDir = join(dir, 'registry');
  for (const d of [home, drafts, registryDir]) mkdirSync(d);
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db'), TRIQUAL_REGISTRY_DIR: registryDir };
  const A = initRepo(dir, 'A');
  const B = initRepo(dir, 'B');
  const runIn = (repo) => (args, cwd = repo) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, env: cleanEnv(home, dbEnv), encoding: 'utf8',
  });
  const runA = runIn(A.repo);
  const runB = runIn(B.repo);
  const draft = (name, text) => {
    const path = join(drafts, name);
    writeFileSync(path, text);
    return path;
  };
  const inStore = (f) => {
    const store = openStore({ home, env: dbEnv });
    try { return f(store); } finally { store.close(); }
  };
  const registry = () => {
    const saved = process.env.TRIQUAL_REGISTRY_DIR;
    process.env.TRIQUAL_REGISTRY_DIR = registryDir;
    try { return readRegistry(home); } finally {
      if (saved === undefined) delete process.env.TRIQUAL_REGISTRY_DIR; else process.env.TRIQUAL_REGISTRY_DIR = saved;
    }
  };
  try {
    A.git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
    ok(runA(['add', '--commit', 'HEAD', draft('seed.md', ENTRY)]));
    ok(runA(['status', 'set', draft('status.md', STATUS)]));
    const saved = process.env.TRIQUAL_REGISTRY_DIR;
    process.env.TRIQUAL_REGISTRY_DIR = registryDir;
    try { registerRepo(home, { root: A.repo, mode: 'store', now: new Date() }); } finally {
      if (saved === undefined) delete process.env.TRIQUAL_REGISTRY_DIR; else process.env.TRIQUAL_REGISTRY_DIR = saved;
    }
    return fn({ dir, home, dataDir, A, B, runA, runB, draft, inStore, registry });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ok(r) {
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

test('relocate runs in an unmarked checkout and B then shows A\'s status', () => {
  withRepos(({ A, B, runB }) => {
    const r = ok(runB(['relocate', A.repo]));
    assert.match(r.stdout, new RegExp(`relocated ${A.repo} -> ${B.repo}\\n`));
    B.git('config', '--local', 'triqual.tracking', 'store');
    const status = ok(runB(['status']));
    assert.match(status.stdout, /move the checkout/);
    const log = ok(runB(['log', '--json']));
    assert.equal(JSON.parse(log.stdout).filter((e) => e.title === 'Seed entry').length, 1);
  });
});

test('relocate unsets the old checkout\'s marker and says so', () => {
  withRepos(({ A, runB }) => {
    const r = ok(runB(['relocate', A.repo]));
    assert.match(r.stdout, new RegExp(`unset the store marker in ${A.repo}\\n`));
    const get = spawnSync('git', ['-C', A.repo, 'config', '--local', '--get', 'triqual.tracking'], { encoding: 'utf8' });
    assert.equal(get.stdout.trim(), '');
  });
});

test('relocate of a checkout that is gone moves the row and prints no marker line', () => {
  withRepos(({ dir, A, runB, inStore }) => {
    const gone = join(dir, 'A-gone');
    execFileSync('mv', [A.repo, gone]);
    const r = ok(runB(['relocate', A.repo]));
    assert.match(r.stdout, /^relocated /);
    assert.doesNotMatch(r.stdout, /unset the store marker/);
    assert.equal(inStore((s) => s.all('SELECT root FROM repos')).length, 1);
  });
});

test('relocate writes one off-plan entry naming both roots, already recorded (not pending)', () => {
  withRepos(({ A, B, runB, inStore }) => {
    ok(runB(['relocate', A.repo]));
    const rows = inStore((s) => s.all("SELECT * FROM entries WHERE title <> 'Seed entry' ORDER BY id"));
    assert.equal(rows.length, 1);
    const [e] = rows;
    assert.equal(e.stage_task, 'off-plan');
    assert.equal(e.state, 'no_commit');
    assert.equal(e.commit_sha, null);
    assert.ok(e.done.includes(A.repo) && e.done.includes(B.repo), e.done);
    assert.equal(inStore((s) => s.all("SELECT id FROM entries WHERE state = 'pending'")).length, 0);
    assert.equal(inStore((s) => s.all('SELECT id FROM repos')).length, 1);
    assert.equal(e.git_dir, realpathSync(join(B.repo, '.git')));
  });
});

test('relocate writes a fresh snapshot named tracking-relocate-<timestamp>.db, taken after the move', () => {
  withRepos(({ A, B, dataDir, runB, inStore }) => {
    ok(runB(['relocate', A.repo]));
    const files = readdirSync(join(dataDir, 'backups')).filter((n) => /^tracking-relocate-.+\.db$/.test(n));
    assert.equal(files.length, 1, files.join(','));
    const snapPath = join(dataDir, 'backups', files[0]);
    const snap = openStore({ home: '/nonexistent', env: { TRIQUAL_TRACKING_DB: snapPath }, readOnly: true });
    try {
      assert.deepEqual(snap.all('SELECT root FROM repos').map((r) => r.root), [B.repo]);
      const entries = snap.all('SELECT title, state FROM entries ORDER BY id');
      assert.ok(entries.some((e) => e.title === 'Seed entry'), JSON.stringify(entries));
      assert.ok(entries.some((e) => e.title === 'Relocate the tracking store row' && e.state === 'no_commit'), JSON.stringify(entries));
    } finally { snap.close(); }
    // A restore of it keeps the history under the new root: no row comes back under the old path.
    ok(runB(['restore', snapPath, '--yes']));
    assert.deepEqual(inStore((s) => s.all('SELECT root FROM repos')).map((r) => r.root), [B.repo]);
    assert.equal(inStore((s) => s.all("SELECT id FROM entries WHERE title = 'Seed entry'")).length, 1);
  });
});

test('relocate updates the registry: B listed, A gone', () => {
  withRepos(({ A, B, runB, registry }) => {
    assert.deepEqual(registry().map((r) => r.root), [A.repo]);
    ok(runB(['relocate', A.repo]));
    const repos = registry();
    assert.deepEqual(repos.map((r) => r.root), [B.repo]);
    assert.equal(repos[0].mode, 'store');
  });
});

test('relocate refused exits 3 with the reason and changes nothing', () => {
  withRepos(({ A, dir, runA, runB, draft, inStore }) => {
    const pending = draft('pending.md', ENTRY.replace('Seed entry', 'Pending one'));
    ok(runA(['add', pending]));
    const r = runB(['relocate', A.repo]);
    assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /1 pending entry/);
    assert.equal(inStore((s) => s.get('SELECT root FROM repos').root), A.repo);
    const none = runB(['relocate', join(dir, 'nowhere')]);
    assert.equal(none.status, 3);
    assert.match(`${none.stdout}${none.stderr}`, /no repository row has the root/);
  });
});

test('relocate with no argument exits 2', () => {
  withRepos(({ runB }) => {
    const r = runB(['relocate']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /relocate: the old checkout root is missing/);
  });
});

test('relocate outside a git checkout exits 2', () => {
  withRepos(({ dir, A, runB }) => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const r = runB(['relocate', A.repo], plain);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not inside a git checkout/);
  });
});
