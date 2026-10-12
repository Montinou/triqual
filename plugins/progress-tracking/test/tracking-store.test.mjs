import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSqlite, openStore, repoKey, StoreError } from '../lib/store.mjs';
import { resolveTracking, storeContext, storeFingerprint } from '../lib/tracking.mjs';
import { registerRepo } from '../lib/registry.mjs';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NOW = new Date('2026-10-11T12:00:00.000Z');
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The in-process registry tests of this file use the default registry location under a temp home.
delete process.env.TRIQUAL_REGISTRY_DIR;
delete process.env.CM_REGISTRY_DIR; // (legacy override name, cleared so a developer's shell cannot redirect the test)

await loadSqlite();

// A temp dir with a home, a TRIQUAL_TRACKING_DB env pointing at a not-yet-created file, and a repo factory.
function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-trkstore-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const dataDir = join(dir, 'data');
  const env = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db') };
  const makeRepo = (name, { marker = null, progress = null } = {}) => {
    const repo = join(dir, name);
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-qm', 'initial');
    if (marker) git(repo, 'config', '--local', 'triqual.tracking', marker);
    if (progress) {
      mkdirSync(join(repo, progress.dir), { recursive: true });
      writeFileSync(join(repo, progress.dir, 'progress.md'), '# Progress\n');
    }
    return repo;
  };
  const opened = [];
  const open = (opts) => { const s = openStore({ home, env, ...opts }); opened.push(s); return s; };
  try {
    return fn({ dir, home, env, dataDir, makeRepo, open });
  } finally {
    for (const s of opened) try { s.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a marked repository resolves to store mode, with its git facts, and creates no DB file', () => withDir(({ dir, dataDir, env, makeRepo }) => {
  const repo = makeRepo('repo', { marker: 'store' });
  const t = resolveTracking(repo);
  assert.deepEqual(t, {
    mode: 'store',
    root: repo,
    repoRoot: repo,
    gitCommonDir: join(repo, '.git'),
    gitDir: join(repo, '.git'),
    branch: git(repo, 'symbolic-ref', '--short', 'HEAD'),
    progress: null,
    status: null,
  });
  assert.equal(existsSync(env.TRIQUAL_TRACKING_DB), false);
  assert.equal(existsSync(dataDir), false);
  assert.deepEqual(readdirSync(dir).sort(), ['home', 'repo']);
}));

test('a detached HEAD resolves with branch null; a subdirectory resolves to the same repo', () => withDir(({ makeRepo }) => {
  const repo = makeRepo('repo', { marker: 'store' });
  mkdirSync(join(repo, 'sub'));
  assert.equal(resolveTracking(join(repo, 'sub')).repoRoot, repo);
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(resolveTracking(repo).branch, null);
}));

test('the marker wins over a progress.md and only the exact value store counts', () => withDir(({ makeRepo }) => {
  const both = makeRepo('both', { marker: 'store', progress: { dir: '.' } });
  assert.equal(resolveTracking(both).mode, 'store');
  const other = makeRepo('other', { marker: 'committed' });
  assert.equal(resolveTracking(other), null);
  const unmarked = makeRepo('unmarked');
  assert.equal(resolveTracking(unmarked), null);
}));

test('committed and local repositories resolve as before', () => withDir(({ makeRepo }) => {
  const committed = makeRepo('committed', { progress: { dir: '.' } });
  const t = resolveTracking(committed);
  assert.equal(t.mode, 'committed');
  assert.equal(t.progress, join(committed, 'progress.md'));
  const local = makeRepo('local', { progress: { dir: '.git/methodology' } });
  assert.equal(resolveTracking(local).mode, 'local');
}));

test('storeContext without write throws missing for an unregistered repository and creates no row', () => withDir(({ home, env, makeRepo, open }) => {
  const repo = makeRepo('repo', { marker: 'store' });
  open({ create: true }); // the DB exists, the repository has no row
  const t = resolveTracking(repo);
  assert.throws(
    () => storeContext(t, { home, env }),
    (e) => e instanceof StoreError && e.code === 'missing',
  );
  assert.equal(open({ create: false }).db.prepare('SELECT COUNT(*) AS n FROM repos').get().n, 0);
}));

test('storeContext without write and without a DB file throws missing and creates nothing', () => withDir(({ home, env, dataDir, makeRepo }) => {
  const t = resolveTracking(makeRepo('repo', { marker: 'store' }));
  assert.throws(() => storeContext(t, { home, env }), (e) => e instanceof StoreError && e.code === 'missing');
  assert.equal(existsSync(dataDir), false);
}));

test('storeContext with write registers the repository; two worktrees share repoId and repo_key but not gitDir', () => withDir(({ dir, home, env, dataDir, makeRepo }) => {
  const repo = makeRepo('repo', { marker: 'store' });
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const a = resolveTracking(repo);
  const b = resolveTracking(wt);
  assert.equal(b.mode, 'store', 'a linked worktree sees the clone-wide marker');
  assert.equal(b.branch, 'feature');
  assert.equal(b.gitCommonDir, a.gitCommonDir);
  assert.notEqual(b.gitDir, a.gitDir);
  const x = storeContext(a, { home, env, write: true, create: true });
  const y = storeContext(b, { home, env, write: true });
  try {
    assert.equal(y.ctx.repoId, x.ctx.repoId);
    assert.equal(y.ctx.repoKey, x.ctx.repoKey);
    assert.equal(x.ctx.repoKey, repoKey(a.gitCommonDir));
    assert.equal(x.ctx.gitDir, a.gitDir);
    assert.equal(y.ctx.gitDir, b.gitDir);
    assert.equal(y.ctx.branch, 'feature');
    assert.equal(x.dataDir, dataDir);
    assert.equal(x.docsDir, join(dataDir, 'repos', repoKey(a.gitCommonDir)));
    assert.equal(y.docsDir, x.docsDir);
    assert.equal(x.store.db.prepare('SELECT COUNT(*) AS n FROM repos').get().n, 1);
    // Reading now finds the row without writing.
    const z = storeContext(a, { home, env });
    assert.equal(z.ctx.repoId, x.ctx.repoId);
    z.store.close();
  } finally {
    x.store.close();
    y.store.close();
  }
}));

test('storeContext works on a committed repository (import runs before the switch) and a local one', () => withDir(({ home, env, makeRepo }) => {
  const committed = makeRepo('committed', { progress: { dir: '.' } });
  const local = makeRepo('local', { progress: { dir: '.git/methodology' } });
  for (const repo of [committed, local]) {
    const t = resolveTracking(repo);
    assert.notEqual(t.mode, 'store');
    const { store, ctx } = storeContext(t, { home, env, write: true, create: true });
    try {
      assert.equal(ctx.gitDir, join(repo, '.git'));
      assert.equal(ctx.branch, git(repo, 'symbolic-ref', '--short', 'HEAD'));
      assert.equal(store.findRepo(join(repo, '.git')).id, ctx.repoId);
    } finally {
      store.close();
    }
  }
}));

test('shareable comes from the registry entry, and is 0 for a local-mode repository even when the registry says true', () => withDir(({ home, env, makeRepo }) => {
  const committed = makeRepo('committed', { progress: { dir: '.' } });
  const local = makeRepo('local', { progress: { dir: '.git/methodology' } });
  const unlisted = makeRepo('unlisted', { marker: 'store' });
  const registryFile = join(home, '.config', 'triqual', 'repos.json');
  mkdirSync(join(home, '.config', 'triqual'), { recursive: true });
  writeFileSync(registryFile, JSON.stringify({
    version: 1,
    repos: [
      { root: committed, mode: 'committed', lastSeen: NOW.toISOString(), shareable: true },
      { root: local, mode: 'local', lastSeen: NOW.toISOString(), shareable: true },
    ],
  }));
  registerRepo(home, { root: unlisted, mode: 'store', now: NOW }); // shareable stays false
  const shareableOf = (repo) => {
    const { store, ctx } = storeContext(resolveTracking(repo), { home, env, write: true, create: true });
    try {
      return store.db.prepare('SELECT shareable FROM repos WHERE id = ?').get(ctx.repoId).shareable;
    } finally {
      store.close();
    }
  };
  assert.equal(shareableOf(committed), 1);
  assert.equal(shareableOf(local), 0);
  assert.equal(shareableOf(unlisted), 0);
}));

test('storeFingerprint: stable for one change set, new when the dirty set or the pending ids change, never reads a null path', () => withDir(({ makeRepo }) => {
  const repo = makeRepo('repo', { marker: 'store' });
  const t = resolveTracking(repo);
  const clean = storeFingerprint(t, []);
  assert.match(clean, /^[0-9a-f]{64}$/);
  assert.equal(storeFingerprint(t, []), clean);
  writeFileSync(join(repo, 'a.txt'), 'one');
  const dirty = storeFingerprint(t, []);
  assert.notEqual(dirty, clean);
  assert.equal(storeFingerprint(t, []), dirty);
  writeFileSync(join(repo, 'a.txt'), 'two, longer');
  assert.notEqual(storeFingerprint(t, []), dirty, 'a content change shows in the size');
  const withPending = storeFingerprint(t, [{ id: 3 }, { id: 1 }]);
  assert.notEqual(withPending, storeFingerprint(t, []));
  assert.equal(withPending, storeFingerprint(t, [1, 3]), 'ids in any order and either shape');
  assert.notEqual(withPending, storeFingerprint(t, [1, 4]));
  assert.equal(storeFingerprint(t, [], ['a.txt']), storeFingerprint(t, [], ['a.txt']), 'an explicit dirty list is honoured');
}));

test('resolving tracking, store-marked or not, never loads node:sqlite', () => withDir(({ makeRepo }) => {
  const url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'tracking.mjs')).href;
  const probe = `import { resolveTracking } from ${JSON.stringify(url)};
    const modes = process.argv.slice(1).map((d) => resolveTracking(d)?.mode ?? null);
    console.log(JSON.stringify({ modes, sqlite: process.moduleLoadList.some((m) => /sqlite/i.test(m)) }));`;
  const repos = [makeRepo('a', { marker: 'store' }), makeRepo('b', { progress: { dir: '.' } }), makeRepo('c', { progress: { dir: '.git/methodology' } })];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe, ...repos], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { modes: ['store', 'committed', 'local'], sqlite: false });
}));
