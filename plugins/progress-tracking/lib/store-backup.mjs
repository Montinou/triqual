// `triqual tracking export` and `restore` (spec §8). Export writes one repository's rows as JSONL, one `{table, row}`
// object per line (what `tracking import --replace --from` reads back). Restore replaces every row of the database with
// a snapshot's (a `backups/tracking-<day>.db` file or any `VACUUM INTO` copy): it ATTACHes the snapshot and, in one
// transaction with the import guard set, deletes the current rows and copies the snapshot's in, ids kept. The repos
// rows are never deleted (a trigger forbids it): a snapshot's repository missing from the database is added, one
// present is matched by its git common dir. Before it replaces anything it saves the current database as
// backups/pre-restore-<stamp>.db (a name the daily pruning never matches). With the database file absent the snapshot
// is copied into its place, after any WAL and SHM file left beside the missing database is moved aside.
import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPrivate, openStore, storePaths, StoreError } from './store.mjs';
import { migrate, SCHEMA_VERSION } from './store-schema.mjs';
import { EXPORT_TABLES } from './store-import.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SNAP = 'snapshot';
const BACKUPS = 'backups';

// A refusal of the restore (no such snapshot, not a tracking database, the live file itself): the CLI exits 2.
export class RestoreError extends Error {}

// The repository's rows as JSONL text, one `{"table", "row"}` object per line, the repos row first.
export function exportJsonl(store, repoId) {
  return store.rows(repoId).map((r) => `${JSON.stringify({ table: r.table, row: r.row })}\n`).join('');
}

// Every column of each table, in schema order, for the copy from the snapshot (a test pins them to the schema).
export const COLUMNS = {
  entries: ['id', 'repo_id', 'git_dir', 'branch', 'created_at', 'entry_date', 'title', 'stage_task', 'done', 'files', 'verification',
    'next', 'state', 'commit_sha', 'corrects', 'plan', 'task_key', 'original', 'parse_ok', 'import_hash'],
  status: ['repo_id', 'position', 'heading', 'body', 'updated_at'],
  plans: ['id', 'repo_id', 'path', 'spec', 'branch', 'state'],
  tasks: ['plan_id', 'key', 'position', 'title', 'deps', 'role', 'skills', 'status', 'commits', 'reason', 'tier', 'effective_tier'],
  task_events: ['id', 'plan_id', 'task_key', 'at', 'from_status', 'to_status', 'note'],
};
export const REPO_COLUMNS = ['id', 'repo_key', 'git_common_dir', 'root', 'origin', 'shareable', 'created_at'];

// The snapshot path, which must exist (ATTACH would otherwise create an empty file) and must not be the live database.
function snapshotPath(file, dbFile) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new RestoreError(`no snapshot at ${abs}`);
  if (existsSync(dbFile) && realpathSync(abs) === realpathSync(dbFile)) {
    throw new RestoreError(`${abs} is the live tracking database, not a snapshot of it`);
  }
  return abs;
}

// Attaches `file` as `snapshot` on `db` and checks it is a sound tracking database of schema version 1 up to this one;
// returns its version. Detaches again and throws RestoreError when it is not (version 0, a foreign or empty database,
// and a version newer than this triqual's are both refused).
function attachChecked(db, file) {
  try {
    db.prepare(`ATTACH DATABASE ? AS ${SNAP}`).run(file);
  } catch (err) {
    throw new RestoreError(`${file} cannot be opened as a database: ${err.message}`);
  }
  try {
    const version = db.prepare(`PRAGMA ${SNAP}.user_version`).get().user_version;
    if (version < 1 || version > SCHEMA_VERSION) {
      throw new RestoreError(`${file} is not a tracking snapshot of schema version ${SCHEMA_VERSION} or older (it has ${version})`);
    }
    const check = db.prepare(`PRAGMA ${SNAP}.quick_check`).all().map((r) => Object.values(r)[0]);
    if (check.length !== 1 || check[0] !== 'ok') throw new RestoreError(`${file} fails the integrity check: ${check.slice(0, 3).join('; ')}`);
    return version;
  } catch (err) {
    try { db.exec(`DETACH DATABASE ${SNAP}`); } catch { /* the check's error is the one to report */ }
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`${file} is not a tracking snapshot: ${err.message}`);
  }
}

// Attaches the snapshot as `snapshot` at this schema version and returns the temp file to remove after the DETACH, or
// null. A snapshot of an older schema is never read or changed as it is: VACUUM INTO writes a private copy of it
// (0600, beside the database), migrate() brings that copy to this schema, and the copy is attached in its place, so
// every column the copy reads exists and the migrations' defaults apply.
async function attachCurrent(db, snapshot, dir) {
  if (attachChecked(db, snapshot) === SCHEMA_VERSION) return null;
  const tmp = join(dir, `.restore-migrate.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    createPrivate(tmp);
    try {
      db.prepare(`VACUUM ${SNAP} INTO ?`).run(tmp);
    } finally {
      db.exec(`DETACH DATABASE ${SNAP}`);
    }
    const { DatabaseSync } = await import('node:sqlite'); // already loaded, behind its warning filter, by loadSqlite
    const copy = new DatabaseSync(tmp);
    try { migrate(copy); } finally { copy.close(); }
    attachChecked(db, tmp);
    return tmp;
  } catch (err) {
    removeTemp(tmp);
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`${snapshot} could not be brought to schema version ${SCHEMA_VERSION}: ${err.message}`);
  }
}

const removeTemp = (tmp) => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
};

// Replaces every row of the open store with the attached snapshot's, in one transaction under the import guard.
// Returns the copied row counts per table.
function copyFromSnapshot(store) {
  return store.tx(() => {
    store.run('INSERT INTO import_guard (active) VALUES (1)');
    for (const table of ['task_events', 'tasks', 'plans', 'status', 'entries']) store.run(`DELETE FROM main.${table}`);
    // The snapshot's repository ids mapped onto this database's rows (same git common dir), added when absent.
    const repoIds = new Map();
    for (const r of store.all(`SELECT ${REPO_COLUMNS.join(', ')} FROM ${SNAP}.repos ORDER BY id`)) {
      const mine = store.get('SELECT id FROM main.repos WHERE git_common_dir = ?', r.git_common_dir);
      if (mine) { repoIds.set(r.id, mine.id); continue; }
      const free = !store.get('SELECT 1 AS x FROM main.repos WHERE id = ? OR repo_key = ?', r.id, r.repo_key);
      const cols = free ? REPO_COLUMNS : REPO_COLUMNS.slice(1);
      const { lastInsertRowid } = store.run(
        `INSERT INTO main.repos (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => r[c]),
      );
      repoIds.set(r.id, Number(lastInsertRowid));
    }
    const counts = {};
    for (const table of ['entries', 'status', 'plans', 'tasks', 'task_events']) {
      const cols = COLUMNS[table];
      const order = cols.includes('id') ? ' ORDER BY id' : '';
      const insert = store.db.prepare(`INSERT INTO main.${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      const rows = store.all(`SELECT ${cols.join(', ')} FROM ${SNAP}.${table}${order}`);
      for (const row of rows) {
        if ('repo_id' in row) row.repo_id = repoIds.get(row.repo_id) ?? row.repo_id;
        insert.run(...cols.map((c) => row[c]));
      }
      counts[table] = rows.length;
    }
    store.run('DELETE FROM import_guard');
    return counts;
  });
}

// Saves the open store as <dataDir>/backups/pre-restore-<UTC stamp>.db (0600, in a 0700 dir); returns its path.
function safetySnapshot(store, dataDir) {
  const dir = join(dataDir, BACKUPS);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const file = join(dir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  store.snapshotTo(file); // creates it 0600 (EEXIST when it exists) and removes it when the copy fails
  return file;
}

// Restores the database named by the environment from `file`. Returns { db, copied, counts, safety, orphans } (safety:
// the pre-restore copy of the replaced database, null when there was none; orphans: where a leftover WAL and SHM were
// moved, only when the database was absent). Throws RestoreError for a snapshot it
// refuses, StoreError when the store is disabled or cannot be opened. Needs `await loadSqlite()` first.
export async function restoreSnapshot({ home, env }, file) {
  const paths = storePaths({ home, env });
  if (!paths) throw new StoreError('disabled', 'the tracking store is disabled: nothing to restore into');
  const snapshot = snapshotPath(file, paths.db);
  if (!existsSync(paths.db)) return restoreByCopy({ home, env }, paths, snapshot);
  let store;
  try {
    store = openStore({ home, env });
  } catch (err) {
    if (!(err instanceof StoreError) || err.code !== 'open') throw err;
    // The database exists but does not open (not SQLite, unreadable): check the snapshot first, then move the file and
    // its sidecars aside and restore as if it were missing.
    await probeSnapshot(snapshot);
    const broken = moveBrokenAside(paths);
    return { ...await restoreByCopy({ home, env }, paths, snapshot), broken };
  }
  try {
    const tmp = await attachCurrent(store.db, snapshot, dirname(paths.db));
    try {
      const safety = safetySnapshot(store, paths.dataDir);
      return { db: paths.db, copied: false, counts: copyFromSnapshot(store), safety };
    } finally {
      store.db.exec(`DETACH DATABASE ${SNAP}`);
      if (tmp) removeTemp(tmp);
    }
  } finally {
    store.close();
  }
}

// Puts the complete temp file `tmp` at `dest` only when `dest` does not exist: a hard link, which fails with EEXIST
// instead of replacing a database created meanwhile, then the temp name is removed either way.
export function placeExclusive(tmp, dest) {
  try {
    linkSync(tmp, dest);
  } catch (err) {
    if (err.code === 'EEXIST') throw new RestoreError(`${dest} appeared during the restore: run it again`);
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

// A WAL or SHM file left beside a database that is gone belongs to that database: SQLite would replay the WAL over the
// snapshot that is put in its place. Moves each into backups/ as orphan-wal-<UTC stamp>.db-wal / .db-shm (0600, in a
// 0700 dir, a name the daily pruning never matches) and returns the new paths.
function moveOrphanSidecars(paths) {
  const found = ['-wal', '-shm'].filter((suffix) => existsSync(`${paths.db}${suffix}`));
  if (!found.length) return [];
  const dir = join(paths.dataDir, BACKUPS);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return found.map((suffix) => {
    const dest = join(dir, `orphan-wal-${stamp}.db${suffix}`);
    renameSync(`${paths.db}${suffix}`, dest);
    chmodSync(dest, FILE_MODE);
    return dest;
  });
}

// Checks the snapshot on an in-memory handle; throws RestoreError when it is not a tracking snapshot.
async function probeSnapshot(snapshot) {
  const { DatabaseSync } = await import('node:sqlite'); // already loaded, behind its warning filter, by loadSqlite
  const probe = new DatabaseSync(':memory:');
  try {
    attachChecked(probe, snapshot);
    probe.exec(`DETACH DATABASE ${SNAP}`);
  } finally {
    probe.close();
  }
}

// Moves a database that does not open, and its -wal / -shm, into backups/ as broken-<UTC stamp>.db* (0600, in a 0700
// dir, a name the daily pruning never matches); returns the database's new path.
function moveBrokenAside(paths) {
  const dir = join(paths.dataDir, BACKUPS);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const dest = join(dir, `broken-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(`${paths.db}${suffix}`)) continue;
    renameSync(`${paths.db}${suffix}`, `${dest}${suffix}`);
    try { chmodSync(`${dest}${suffix}`, FILE_MODE); } catch { /* kept even when its mode cannot be changed */ }
  }
  return dest;
}

// No database file: the snapshot is checked on an in-memory handle (opening it as the store would migrate a foreign
// database into an empty tracking one), then written to a 0600 temp file beside the target and linked into place,
// so the database is never readable by others, whatever the snapshot's own mode, and a file created meanwhile is never
// replaced.
async function restoreByCopy({ home, env }, paths, snapshot) {
  await probeSnapshot(snapshot);
  const made = mkdirSync(paths.dataDir, { recursive: true, mode: DIR_MODE });
  if (made) chmodSync(made, DIR_MODE);
  const tmp = join(dirname(paths.db), `.restore.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  createPrivate(tmp);
  let orphans;
  try {
    writeFileSync(tmp, readFileSync(snapshot));
    if (existsSync(paths.db)) throw new RestoreError(`${paths.db} appeared during the restore: run it again`);
    orphans = moveOrphanSidecars(paths);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  placeExclusive(tmp, paths.db);
  const store = openStore({ home, env });
  try {
    const counts = Object.fromEntries(EXPORT_TABLES.slice(1).map((t) => [t, store.get(`SELECT COUNT(*) AS n FROM ${t}`).n]));
    return { db: paths.db, copied: true, counts, safety: null, orphans };
  } finally {
    store.close();
  }
}
