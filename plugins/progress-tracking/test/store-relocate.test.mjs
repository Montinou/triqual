import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync, symlinkSync, writeFileSync, readFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSqlite, repoKey, docsDirs, openStore, RelocateRefused,
} from '../lib/store.mjs';
import { createLedger } from '../lib/ledger.mjs';
import { moveRepo, registerRepo, readRegistry } from '../lib/registry.mjs';

await loadSqlite();

const NOW = '2026-10-15T12:00:00.000Z';
const FIELDS = { title: 'A title', stage_task: 'off-plan', done: 'did it', files: 'a.mjs', verification: 'ok', next: 'more' };

// A temp dir with a fresh store (TRIQUAL_TRACKING_DB under it) and two checkouts A and B, each with a .git dir.
function withStore(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-relocate-')));
  const dataDir = join(dir, 'data');
  const env = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db') };
  const store = openStore({ home: dir, env, create: true });
  const A = join(dir, 'A');
  const B = join(dir, 'B');
  for (const r of [A, B]) mkdirSync(join(r, '.git'), { recursive: true });
  try {
    return fn({ dir, dataDir, store, A, B });
  } finally {
    try { chmodSync(join(dataDir, 'repos'), 0o700); } catch { /* not created */ }
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// A's row with 2 committed entries, a status section and a done plan with 2 tasks; its plan file in <oldKey>/plans.
function seed({ store, dataDir, A }) {
  const { id: repoId, repo_key: oldKey } = store.ensureRepo({ gitCommonDir: join(A, '.git'), root: A, origin: null, shareable: 1 });
  const ctx = { repoId, gitDir: join(A, '.git'), branch: 'main' };
  const entryIds = [store.addEntry(ctx, FIELDS, { state: 'committed', commit: 'aaa' }),
    store.addEntry(ctx, { ...FIELDS, title: 'B' }, { state: 'committed', commit: 'bbb' })];
  store.setStatus(repoId, [{ heading: 'preamble', body: 'x' }], NOW);
  const planId = store.upsertPlan(repoId, { path: 'p.md', spec: null, branch: null, state: 'done' });
  const ledger = createLedger({
    plan: 'p.md', spec: null, branch: null, now: NOW,
    tasks: [{ id: 'T1', title: 'one', deps: [], skills: [], role: null }, { id: 'T2', title: 'two', deps: [], skills: [], role: null }],
  });
  store.saveLedger(planId, { ...ledger, state: 'done' });
  const { plansDir } = docsDirs(dataDir, oldKey);
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, 'p.md'), '# plan\n');
  return { repoId, oldKey, entryIds, planId, ctx };
}

const rowOf = (store, id) => store.get('SELECT id, repo_key, git_common_dir, root FROM repos WHERE id = ?', id);
const taskCount = (store, planId) => store.get('SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ?', planId).n;

test('relocateRepo moves the row and keeps every id', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const { repoId, oldKey, entryIds, planId } = seed(env);
    const newKey = repoKey(join(B, '.git'));
    const out = store.relocateRepo({ oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir });
    assert.deepEqual(out, { repoId, oldKey, newKey });
    const row = rowOf(store, repoId);
    assert.equal(row.repo_key, repoKey(join(B, '.git')));
    assert.equal(row.git_common_dir, join(B, '.git'));
    assert.equal(row.root, B);
    assert.deepEqual(store.entries(repoId, {}).map((e) => e.id).sort(), [...entryIds].sort());
    assert.deepEqual(store.plans(repoId).map((p) => p.id), [planId]);
    assert.equal(taskCount(store, planId), 2);
    assert.equal(store.status(repoId).length, 1);
    assert.equal(existsSync(docsDirs(dataDir, oldKey).docsDir), false);
    assert.equal(readFileSync(join(docsDirs(dataDir, newKey).plansDir, 'p.md'), 'utf8'), '# plan\n');
    assert.equal(store.findRepo(join(B, '.git')).id, repoId);
    assert.equal(store.findRepo(join(A, '.git')), null);
  });
});

test('relocateRepo finds the old root through a symlink and a trailing slash', () => {
  withStore((env) => {
    const { store, dataDir, dir, A, B } = env;
    const { repoId } = seed(env);
    const link = join(dir, 'link-to-A');
    symlinkSync(A, link);
    const out = store.relocateRepo({ oldRoot: `${link}/`, gitCommonDir: join(B, '.git'), root: B, dataDir });
    assert.equal(out.repoId, repoId);
    assert.equal(rowOf(store, repoId).root, B);
  });
});

test('relocateRepo finds the old root by its stored string once the old checkout is gone', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const { repoId } = seed(env);
    rmSync(A, { recursive: true, force: true });
    assert.equal(store.relocateRepo({ oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }).repoId, repoId);
  });
});

test('relocateRepo with no old docs dir moves the row only', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const { repoId, oldKey } = seed(env);
    rmSync(docsDirs(dataDir, oldKey).docsDir, { recursive: true, force: true });
    const { newKey } = store.relocateRepo({ oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir });
    assert.equal(rowOf(store, repoId).repo_key, newKey);
    assert.equal(existsSync(docsDirs(dataDir, newKey).docsDir), false);
  });
});

// Asserts a RelocateRefused matching `reason`, and that A's row and both docs dirs are as they were.
function assertRefused({ store, dataDir, B }, { repoId, oldKey }, args, reason) {
  const before = repoId === undefined ? null : rowOf(store, repoId);
  const newKey = repoKey(join(B, '.git'));
  const newExisted = existsSync(docsDirs(dataDir, newKey).docsDir);
  const oldExisted = oldKey !== undefined && existsSync(docsDirs(dataDir, oldKey).docsDir);
  assert.throws(() => store.relocateRepo(args), (e) => {
    assert.ok(e instanceof RelocateRefused, `RelocateRefused, got ${e?.name}: ${e?.message}`);
    assert.match(e.reason, reason);
    return true;
  });
  if (repoId !== undefined) assert.deepEqual(rowOf(store, repoId), before);
  assert.equal(existsSync(docsDirs(dataDir, newKey).docsDir), newExisted);
  if (oldKey !== undefined) assert.equal(existsSync(docsDirs(dataDir, oldKey).docsDir), oldExisted);
}

test('relocateRepo refuses when no row has the old root', () => {
  withStore((env) => {
    const { dataDir, dir, B } = env;
    const other = join(dir, 'nowhere');
    assertRefused(env, {}, { oldRoot: other, gitCommonDir: join(B, '.git'), root: B, dataDir }, /no repository row/);
  });
});

test('relocateRepo refuses when the new checkout already has a row', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const seeded = seed(env);
    store.ensureRepo({ gitCommonDir: join(B, '.git'), root: B, origin: null, shareable: 0 });
    assertRefused(env, seeded, { oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }, /already has a row/);
  });
});

test('relocateRepo refuses while an entry is pending', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const seeded = seed(env);
    store.addEntry(seeded.ctx, FIELDS);
    assertRefused(env, seeded, { oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }, /pending entr/);
  });
});

test('relocateRepo refuses while a plan is not done', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const seeded = seed(env);
    store.upsertPlan(seeded.repoId, { path: 'q.md', spec: null, branch: null, state: 'active' });
    assertRefused(env, seeded, { oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }, /active plan/);
  });
});

test('relocateRepo refuses when the new docs dir already exists', () => {
  withStore((env) => {
    const { dataDir, A, B } = env;
    const seeded = seed(env);
    mkdirSync(docsDirs(dataDir, repoKey(join(B, '.git'))).docsDir, { recursive: true });
    assertRefused(env, seeded, { oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }, /already exists/);
  });
});

test('relocateRepo rolls back when the rename fails', () => {
  withStore((env) => {
    const { store, dataDir, A, B } = env;
    const { repoId, oldKey } = seed(env);
    const before = rowOf(store, repoId);
    chmodSync(join(dataDir, 'repos'), 0o555);
    try {
      assert.throws(() => store.relocateRepo({ oldRoot: A, gitCommonDir: join(B, '.git'), root: B, dataDir }), /EACCES|EPERM/);
    } finally {
      chmodSync(join(dataDir, 'repos'), 0o700);
    }
    assert.deepEqual(rowOf(store, repoId), before);
    assert.equal(rowOf(store, repoId).root, A);
    assert.ok(existsSync(docsDirs(dataDir, oldKey).docsDir));
  });
});

test('moveRepo drops the old root and keeps shareable', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-moverepo-')));
  const saved = { t: process.env.TRIQUAL_REGISTRY_DIR, c: process.env.CM_REGISTRY_DIR };
  process.env.TRIQUAL_REGISTRY_DIR = join(dir, 'registry');
  delete process.env.CM_REGISTRY_DIR;
  try {
    const A = join(dir, 'A');
    const B = join(dir, 'B');
    const other = join(dir, 'other');
    for (const r of [A, B, other]) mkdirSync(r);
    registerRepo(dir, { root: A, mode: 'store', now: new Date(NOW) });
    registerRepo(dir, { root: other, mode: 'committed', now: new Date(NOW) });
    const file = join(dir, 'registry', 'repos.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.repos[0].shareable = true;
    writeFileSync(file, JSON.stringify(raw));
    rmSync(A, { recursive: true }); // the old checkout is gone: `from` is matched as given
    const later = new Date('2026-10-16T00:00:00.000Z');
    moveRepo(dir, { from: A, to: B, mode: 'store', now: later });
    const entries = readRegistry(dir);
    assert.deepEqual(entries.map((e) => e.root).sort(), [B, other].sort());
    assert.deepEqual(entries.find((e) => e.root === B), { root: B, mode: 'store', lastSeen: later.toISOString(), shareable: true });
    assert.doesNotThrow(() => moveRepo(dir, { from: A, to: join(dir, 'missing'), mode: 'store', now: later }));
  } finally {
    if (saved.t === undefined) delete process.env.TRIQUAL_REGISTRY_DIR; else process.env.TRIQUAL_REGISTRY_DIR = saved.t;
    if (saved.c !== undefined) process.env.CM_REGISTRY_DIR = saved.c;
    rmSync(dir, { recursive: true, force: true });
  }
});
