// `triqual tracking export` and `restore`, and `import --replace --from <jsonl>` (plan tracking-store-1 T4). Every
// store lives in a temp dir named by TRIQUAL_TRACKING_DB; HOME is a temp one. Restore runs only against temp DBs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { BRAND } from '../lib/brand.mjs';
import { buildHistory } from './fixtures/progress-history.mjs';
import { restoreCommand } from '../cli/tracking.mjs';
import { COLUMNS, placeExclusive, REPO_COLUMNS, RestoreError } from '../lib/store-backup.mjs';
import { SCHEMA_VERSION } from '../lib/store-schema.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tracking.mjs');

await loadSqlite();
// Loaded after loadSqlite, which drops node:sqlite's experimental warning.
const { DatabaseSync } = await import('node:sqlite');

const cleanEnv = (home, extra) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    `${BRAND.envPrefix}REGISTRY_DIR`, `${BRAND.legacy.envPrefix}REGISTRY_DIR`]) delete env[k];
  return { ...env, ...extra };
};

function withTemp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-backup-')));
  const home = join(dir, 'home');
  const envFor = (name) => ({ TRIQUAL_TRACKING_DB: join(dir, name, 'tracking.db') });
  const run = (cwd, args, env) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, env: cleanEnv(home, env), encoding: 'utf8',
  });
  const inStore = (env, fn2) => {
    const store = openStore({ home, env });
    try { return fn2(store); } finally { store.close(); }
  };
  try {
    return fn({ dir, home, envFor, run, inStore });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exit = (r, code) => assert.equal(r.status, code, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
const FIELDS = { title: 'A correction', stage_task: 'off-plan', done: 'fixed a typo', files: 'x', verification: 'v', next: 'n' };

// The repository's rows with every id replaced by the position of the row it names, so two stores holding the same
// data under different ids compare equal: entries by insertion order, plans likewise, corrects and plan_id through them.
function normalized(store, repoId) {
  const rows = store.rows(repoId);
  const ids = (table) => new Map(rows.filter((r) => r.table === table).map((r, i) => [r.row.id, i]));
  const entryIds = ids('entries');
  const planIds = ids('plans');
  return rows.filter((r) => r.table !== 'repos').map(({ table, row }) => {
    const out = { ...row };
    delete out.id;
    if ('repo_id' in out) out.repo_id = 'R';
    if (table === 'entries' && out.corrects !== null) out.corrects = `E${entryIds.get(out.corrects)}`;
    if ('plan_id' in out) out.plan_id = `P${planIds.get(out.plan_id)}`;
    return { table, row: out };
  });
}

test('export writes one {table, row} line per row; --replace --from rebuilds them in a fresh store with ids remapped', () => withTemp(({ dir, home, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  // A correction pointing at an earlier entry, so `corrects` has to be remapped too.
  inStore(a, (s) => {
    const repoId = s.get('SELECT id FROM repos').id;
    const target = s.get("SELECT id FROM entries WHERE title = 'Bravo'").id;
    s.addEntry({ repoId, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit', corrects: target });
  });

  const stdout = run(repo, ['export'], a);
  exit(stdout, 0);
  const lines = stdout.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => Object.keys(l).sort().join() === 'row,table'));
  assert.deepEqual([...new Set(lines.map((l) => l.table))], ['repos', 'entries', 'status', 'plans', 'tasks', 'task_events']);

  const file = join(dir, 'export.jsonl');
  const written = run(repo, ['export', '--out', file], a);
  exit(written, 0);
  assert.equal(readFileSync(file, 'utf8'), stdout.stdout);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the export is private');

  // The fresh store already holds another repository's rows, so every id of ours lands on a different number.
  const b = envFor('b');
  const seeded = openStore({ home, env: b, create: true });
  try {
    const other = seeded.ensureRepo({ gitCommonDir: join(dir, 'elsewhere', '.git'), root: join(dir, 'elsewhere'), shareable: false });
    for (let i = 0; i < 3; i += 1) seeded.addEntry({ repoId: other.id, gitDir: '/y/.git', branch: null }, FIELDS, { state: 'no_commit' });
    const p = seeded.upsertPlan(other.id, { path: 'other.md', state: 'active' });
    seeded.saveLedger(p, { spec: null, branch: null, state: 'active', tasks: [{ id: 'T1', title: 't', status: 'pending', deps: [], skills: [], commits: [], history: [{ at: 'x', from: null, to: 'pending' }] }] });
  } finally {
    seeded.close();
  }
  const r = run(repo, ['import', '--replace', '--from', file], b);
  exit(r, 0);
  assert.match(r.stdout, /7 entries/);

  const before = inStore(a, (s) => normalized(s, s.get('SELECT id FROM repos').id));
  inStore(b, (s) => {
    const mine = s.get('SELECT id FROM repos WHERE git_common_dir = ?', realpathSync(join(repo, '.git'))).id;
    assert.deepEqual(normalized(s, mine), before);
    const ids = s.all('SELECT id FROM entries WHERE repo_id = ? ORDER BY id', mine).map((e) => e.id);
    assert.ok(ids[0] > 3, 'ids were remapped past the other repository\'s');
    const fix = s.get("SELECT corrects FROM entries WHERE title = 'A correction' AND repo_id = ?", mine);
    assert.equal(s.get('SELECT title FROM entries WHERE id = ?', fix.corrects).title, 'Bravo');
    assert.equal(s.get('SELECT COUNT(*) AS n FROM entries WHERE repo_id <> ?', mine).n, 3, 'the other repository is untouched');
  });
}));

test('import --from refuses a malformed line, naming it, and changes nothing', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const file = join(dir, 'bad.jsonl');
  writeFileSync(file, '{"table":"entries","row":{}}\nnot json\n');
  const r = run(repo, ['import', '--replace', '--from', file], a);
  exit(r, 2);
  assert.match(r.stderr, /line 2/);
  assert.equal(inStore(a, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
}));

test('restore replaces every row with the snapshot\'s, rows still in the WAL included', () => withTemp(({ dir, home, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const before = inStore(a, (s) => s.all('SELECT * FROM entries ORDER BY id'));

  // A connection held open keeps what it writes after the snapshot in the WAL (no checkpoint on close).
  const holder = openStore({ home, env: a });
  try {
    const repoId = holder.get('SELECT id FROM repos').id;
    holder.addEntry({ repoId, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit' });
    holder.run("UPDATE status SET body = 'changed after the snapshot' WHERE heading = 'Now'");
    const wal = `${a.TRIQUAL_TRACKING_DB}-wal`;
    assert.ok(existsSync(wal) && statSync(wal).size > 0, 'the later rows sit in the WAL');

    const refused = run(dir, ['restore', snapshot], a);
    exit(refused, 2);
    assert.match(refused.stderr, /--yes/);
    assert.equal(holder.get('SELECT COUNT(*) AS n FROM entries').n, before.length + 1, 'nothing restored without --yes');

    const r = run(dir, ['restore', snapshot, '--yes'], a);
    exit(r, 0);
    assert.match(r.stdout, /restored/);
  } finally {
    holder.close();
  }
  inStore(a, (s) => {
    assert.deepEqual(s.all('SELECT * FROM entries ORDER BY id'), before, 'the entry written after the snapshot is gone');
    assert.equal(s.get("SELECT body FROM status WHERE heading = 'Now'").body, 'Working on the sample plan.');
    assert.equal(s.get('SELECT COUNT(*) AS n FROM import_guard').n, 0, 'the guard row is gone again');
  });
}));

test('restore refuses a file that is not a tracking snapshot and keeps the database', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'not a database at all, just some text that is long enough to not be empty\n'.repeat(20));
  exit(run(dir, ['restore', junk, '--yes'], a), 2);
  exit(run(dir, ['restore', join(dir, 'absent.db'), '--yes'], a), 2);
  assert.equal(existsSync(join(dir, 'absent.db')), false, 'an absent snapshot is not created');
  assert.equal(inStore(a, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
}));

test('restore with the database absent puts the snapshot in its place', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const b = envFor('b');
  exit(run(dir, ['restore', snapshot, '--yes'], b), 0);
  assert.equal(statSync(b.TRIQUAL_TRACKING_DB).mode & 0o777, 0o600);
  assert.equal(inStore(b, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
}));

// ---- Fix round 1 ----

test('a flag on a verb named like an Object.prototype key is refused as a usage error, not a crash', () => withTemp(({ dir, envFor, run }) => {
  const r = run(dir, ['constructor', '--yes'], envFor('a'));
  exit(r, 2);
  assert.match(r.stderr, /--yes applies to restore only/);
  assert.doesNotMatch(r.stderr, /not a function/);
}));

test('restore with the database absent writes it 0600 from the start, whatever the snapshot\'s mode, no temp file left', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  chmodSync(snapshot, 0o644);
  const b = envFor('b');
  exit(run(dir, ['restore', snapshot, '--yes'], b), 0);
  assert.equal(statSync(b.TRIQUAL_TRACKING_DB).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(b.TRIQUAL_TRACKING_DB)).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(inStore(b, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
}));

test('restore over a database first saves it as a private pre-restore snapshot in backups/ and prints its path', () => withTemp(({ dir, home, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  inStore(a, (s) => s.addEntry({ repoId: s.get('SELECT id FROM repos').id, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit' }));
  const r = run(dir, ['restore', snapshot, '--yes'], a);
  exit(r, 0);
  const backups = join(dirname(a.TRIQUAL_TRACKING_DB), 'backups');
  const saved = readdirSync(backups).filter((n) => n.startsWith('pre-restore-'));
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^pre-restore-[0-9TZ-]+\.db$/);
  assert.doesNotMatch(saved[0], /^tracking-\d{4}-\d{2}-\d{2}\.db$/, 'the daily pruning never removes it');
  const file = join(backups, saved[0]);
  assert.ok(r.stdout.includes(file), 'the path is printed');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The safety copy holds the rows the restore replaced, the entry written after the snapshot included.
  const copy = openStore({ home, env: { TRIQUAL_TRACKING_DB: file } });
  try {
    assert.equal(copy.get("SELECT COUNT(*) AS n FROM entries WHERE title = 'A correction'").n, 1);
  } finally {
    copy.close();
  }
  assert.equal(inStore(a, (s) => s.get("SELECT COUNT(*) AS n FROM entries WHERE title = 'A correction'").n), 0);
}));

test('restore over a database that does not open moves it into backups/, leaves no sidecar beside the new one, and restores the snapshot', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const b = envFor('b');
  mkdirSync(dirname(b.TRIQUAL_TRACKING_DB), { recursive: true });
  const junk = 'not a database at all, just some text that is long enough to not be empty\n'.repeat(20);
  writeFileSync(b.TRIQUAL_TRACKING_DB, junk);
  writeFileSync(`${b.TRIQUAL_TRACKING_DB}-wal`, 'stale wal');
  const r = run(dir, ['restore', snapshot, '--yes'], b);
  exit(r, 0);
  const backups = join(dirname(b.TRIQUAL_TRACKING_DB), 'backups');
  // SQLite drops a WAL that does not belong to a database when the store tries to open it; any sidecar still there is
  // moved beside the broken file.
  const moved = readdirSync(backups).filter((n) => n.startsWith('broken-'));
  assert.equal(moved.filter((n) => /^broken-[0-9TZ-]+\.db$/.test(n)).length, 1);
  const file = join(backups, moved.find((n) => n.endsWith('.db')));
  assert.equal(readFileSync(file, 'utf8'), junk, 'the broken file is kept as it was');
  assert.ok(r.stdout.includes(file), 'the path is printed');
  assert.equal(existsSync(`${b.TRIQUAL_TRACKING_DB}-wal`), false);
  assert.equal(statSync(b.TRIQUAL_TRACKING_DB).mode & 0o777, 0o600);
  assert.equal(inStore(b, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
}));

test('restore over a database that does not open, from a bad snapshot, refuses and leaves the file in place', () => withTemp(({ dir, envFor, run }) => {
  const b = envFor('b');
  mkdirSync(dirname(b.TRIQUAL_TRACKING_DB), { recursive: true });
  writeFileSync(b.TRIQUAL_TRACKING_DB, 'broken');
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'not a snapshot either\n'.repeat(20));
  exit(run(dir, ['restore', junk, '--yes'], b), 2);
  assert.equal(readFileSync(b.TRIQUAL_TRACKING_DB, 'utf8'), 'broken');
  assert.equal(existsSync(join(dirname(b.TRIQUAL_TRACKING_DB), 'backups')), false);
}));

test('restore on a terminal: a "no" leaves the database untouched, a "yes" restores', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-backup-tty-')));
  try {
    const home = join(dir, 'home');
    const env = { TRIQUAL_TRACKING_DB: join(dir, 'a', 'tracking.db') };
    const { repo } = buildHistory(dir);
    exit(spawnSync(process.execPath, [BIN, 'import'], { cwd: repo, env: cleanEnv(home, env), encoding: 'utf8' }), 0);
    const snapshot = join(dir, 'snap.db');
    const withStore = (fn) => { const s = openStore({ home, env }); try { return fn(s); } finally { s.close(); } };
    withStore((s) => s.snapshotTo(snapshot));
    withStore((s) => s.addEntry({ repoId: s.get('SELECT id FROM repos').id, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit' }));
    const before = withStore((s) => s.all('SELECT * FROM entries ORDER BY id'));
    const asked = [];
    const io = (answer) => ({
      env, home, isTTY: true, out: () => {}, err: () => {},
      confirm: async (question) => { asked.push(question); return answer; },
    });

    assert.equal(await restoreCommand({ snapshot, yes: false }, io(false)), 1);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /yes/);
    assert.deepEqual(withStore((s) => s.all('SELECT * FROM entries ORDER BY id')), before, 'a "no" changes nothing');
    assert.deepEqual(readdirSync(join(dir, 'a', 'backups')).filter((n) => n.startsWith('pre-restore-')), [], 'and saves nothing');

    assert.equal(await restoreCommand({ snapshot, yes: false }, io(true)), 0);
    assert.equal(withStore((s) => s.get('SELECT COUNT(*) AS n FROM entries').n), before.length - 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Final fix: a leftover WAL beside a missing database, and the atomic placement ----

// A real stale WAL: a store whose last writes are still in its WAL (a connection held open), copied away before the
// connection closes (the close would checkpoint it). Returns the WAL's bytes.
function staleWal(home, env, dir) {
  const store = openStore({ home, env, create: true });
  try {
    store.run('PRAGMA wal_autocheckpoint = 0');
    store.run("INSERT INTO repos (repo_key, git_common_dir, root, created_at) VALUES ('stale', '/x/.git', '/x', '2026-01-01')");
    store.addEntry({ repoId: store.get('SELECT id FROM repos').id, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit' });
    const copy = join(dir, 'stale.wal');
    copyFileSync(`${env.TRIQUAL_TRACKING_DB}-wal`, copy);
    return readFileSync(copy);
  } finally {
    store.close();
  }
}

test('restore into a missing database moves a leftover WAL and SHM into backups/ as orphan-wal files, and the snapshot is not changed by them', () => withTemp(({ dir, home, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const before = inStore(a, (s) => s.rows(s.get('SELECT id FROM repos').id).length);

  // The target: a store with a row only in its WAL, whose database file is then lost; the WAL and SHM stay.
  const b = envFor('b');
  const stale = staleWal(home, { ...b }, dir);
  assert.ok(stale.length > 0, 'the WAL holds content');
  const db = b.TRIQUAL_TRACKING_DB;
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(`${db}-wal`, stale, { mode: 0o600 });
  writeFileSync(`${db}-shm`, 'shm');
  rmSync(db, { force: true });

  const r = run(dir, ['restore', snapshot, '--yes'], b);
  exit(r, 0);
  const backups = join(dirname(db), 'backups');
  const orphans = readdirSync(backups).filter((n) => n.startsWith('orphan-wal-')).sort();
  assert.equal(orphans.length, 2, orphans.join(', '));
  assert.ok(orphans.some((n) => n.endsWith('-wal')) && orphans.some((n) => n.endsWith('-shm')), orphans.join(', '));
  assert.deepEqual(readFileSync(join(backups, orphans.find((n) => n.endsWith('-wal')))), stale, 'the WAL is kept intact');
  for (const n of orphans) {
    assert.doesNotMatch(n, /^tracking-\d{4}-\d{2}-\d{2}\.db$/, 'the daily pruning never removes it');
    assert.equal(statSync(join(backups, n)).mode & 0o777, 0o600);
    assert.ok(r.stdout.includes(join(backups, n)), `the path of ${n} is printed`);
  }
  assert.match(r.stdout, /leftover/);
  // The restored database is the snapshot, not the snapshot with the stale WAL replayed over it.
  assert.equal(inStore(b, (s) => s.rows(s.get('SELECT id FROM repos').id).length), before);
  assert.equal(inStore(b, (s) => s.get("SELECT COUNT(*) AS n FROM entries WHERE title = 'A correction'").n), 0);
  assert.equal(inStore(b, (s) => s.get('PRAGMA integrity_check').integrity_check), 'ok');
  assert.deepEqual(readdirSync(dirname(db)).filter((n) => n.startsWith('tracking.db-') && !n.endsWith('-wal') && !n.endsWith('-shm')), []);
}));

test('restore with the database absent and no leftover sidecars writes no orphan file and says nothing of one', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const b = envFor('b');
  const r = run(dir, ['restore', snapshot, '--yes'], b);
  exit(r, 0);
  assert.doesNotMatch(r.stdout, /orphan|leftover/);
  const backups = join(dirname(b.TRIQUAL_TRACKING_DB), 'backups');
  assert.deepEqual(existsSync(backups) ? readdirSync(backups).filter((n) => n.startsWith('orphan-')) : [], []);
}));

test('placeExclusive links the file into place and refuses, leaving the file there, when one exists already', () => withTemp(({ dir }) => {
  const tmp = join(dir, 'new.tmp');
  const dest = join(dir, 'tracking.db');
  writeFileSync(tmp, 'restored');
  placeExclusive(tmp, dest);
  assert.equal(readFileSync(dest, 'utf8'), 'restored');
  assert.equal(existsSync(tmp), false, 'the temp name is gone');

  // A database created meanwhile is never replaced.
  const other = join(dir, 'other.tmp');
  writeFileSync(other, 'second');
  assert.throws(() => placeExclusive(other, dest), (err) => err instanceof RestoreError && /appeared during the restore/.test(err.message));
  assert.equal(readFileSync(dest, 'utf8'), 'restored', 'the file that was there is untouched');
  assert.equal(existsSync(other), false, 'no temp file left');
}));

// ---- Plan methodology-1.0 · T2 fix round 1: restore across schema V2 (tiers) ----

// A copy of the snapshot `src` at `dest` as a V1 triqual wrote it: no tier columns, user_version 1.
function asV1(src, dest) {
  copyFileSync(src, dest);
  const d = new DatabaseSync(dest);
  try {
    d.exec('ALTER TABLE tasks DROP COLUMN tier; ALTER TABLE tasks DROP COLUMN effective_tier; PRAGMA user_version = 1;');
  } finally {
    d.close();
  }
}
const withVersion = (src, dest, version) => {
  copyFileSync(src, dest);
  const d = new DatabaseSync(dest);
  try { d.exec(`PRAGMA user_version = ${version}`); } finally { d.close(); }
};
const tierRows = (s) => s.all('SELECT key, tier, effective_tier FROM tasks ORDER BY plan_id, position').map((r) => ({ ...r }));
// The data dir holds nothing but the database, its sidecars and backups/: no temp copy is left behind.
const leftovers = (env) => readdirSync(dirname(env.TRIQUAL_TRACKING_DB))
  .filter((f) => !/^tracking\.db(-wal|-shm)?$/.test(f) && f !== 'backups');

test('restore of a V2 snapshot keeps the declared and the effective tier', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  inStore(a, (s) => s.run("UPDATE tasks SET tier = 'light', effective_tier = 'heavy' WHERE key = 'T1'"));
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  inStore(a, (s) => s.run('UPDATE tasks SET tier = NULL, effective_tier = NULL'));
  exit(run(dir, ['restore', snapshot, '--yes'], a), 0);
  assert.deepEqual(inStore(a, tierRows), [
    { key: 'T1', tier: 'light', effective_tier: 'heavy' }, { key: 'T2', tier: null, effective_tier: null },
  ]);
}));

test('restore of a V1 snapshot: tiers read null and every other row is intact, over a database and into an absent one', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  inStore(a, (s) => s.run("UPDATE tasks SET tier = 'heavy', effective_tier = 'heavy'"));
  const v2 = join(dir, 'snap-v2.db');
  inStore(a, (s) => s.snapshotTo(v2));
  const v1 = join(dir, 'snap-v1.db');
  asV1(v2, v1);
  const v1Bytes = readFileSync(v1);
  const expected = inStore(a, (s) => normalized(s, s.get('SELECT id FROM repos').id)).map(({ table, row }) => (
    table === 'tasks' ? { table, row: { ...row, tier: null, effective_tier: null } } : { table, row }));
  // Something written after the snapshot, which the restore must remove.
  inStore(a, (s) => s.addEntry({ repoId: s.get('SELECT id FROM repos').id, gitDir: '/x/.git', branch: 'main' }, FIELDS, { state: 'no_commit' }));

  for (const env of [a, envFor('b')]) {
    const r = run(dir, ['restore', v1, '--yes'], env);
    exit(r, 0);
    inStore(env, (s) => {
      assert.equal(s.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
      assert.deepEqual(normalized(s, s.get('SELECT id FROM repos').id), expected);
    });
    assert.deepEqual(leftovers(env), [], 'no temp copy left in the data dir');
  }
  assert.deepEqual(readFileSync(v1), v1Bytes, 'the snapshot itself is never migrated');
}));

test('restore still refuses a snapshot newer than this schema, over a database and into an absent one', () => withTemp(({ dir, envFor, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const a = envFor('a');
  exit(run(repo, ['import'], a), 0);
  const snapshot = join(dir, 'snap.db');
  inStore(a, (s) => s.snapshotTo(snapshot));
  const newer = join(dir, 'snap-newer.db');
  withVersion(snapshot, newer, SCHEMA_VERSION + 1);
  const b = envFor('b');
  for (const env of [a, b]) {
    const r = run(dir, ['restore', newer, '--yes'], env);
    exit(r, 2);
    assert.match(r.stderr, new RegExp(`schema version ${SCHEMA_VERSION}.*it has ${SCHEMA_VERSION + 1}`));
  }
  assert.equal(inStore(a, (s) => s.get('SELECT COUNT(*) AS n FROM entries').n), 6);
  assert.equal(existsSync(b.TRIQUAL_TRACKING_DB), false, 'nothing is created for a refused snapshot');
  // A version-0 file (an empty or foreign SQLite database) is no tracking snapshot either.
  const zero = join(dir, 'snap-zero.db');
  withVersion(snapshot, zero, 0);
  exit(run(dir, ['restore', zero, '--yes'], a), 2);
}));

test('the restore column lists match every column of a freshly migrated store', () => withTemp(({ dir, envFor }) => {
  const store = openStore({ home: join(dir, 'home'), env: envFor('fresh'), create: true });
  try {
    const columns = (table) => store.all(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const table of Object.keys(COLUMNS)) assert.deepEqual(COLUMNS[table], columns(table), table);
    assert.deepEqual(Object.keys(COLUMNS).sort(), ['entries', 'plans', 'status', 'task_events', 'tasks']);
    assert.deepEqual(REPO_COLUMNS, columns('repos'));
  } finally {
    store.close();
  }
}));
