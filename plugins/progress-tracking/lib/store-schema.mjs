// The tracking store's schema: DDL, append-only triggers and the migration list (spec §2). No I/O of its own: `migrate`
// works on an open node:sqlite handle. `PRAGMA user_version` holds the number of applied migrations.

// Every entries column except the two a stamp may move; the update trigger demands they are all unchanged.
const FROZEN = [
  'id', 'repo_id', 'git_dir', 'branch', 'created_at', 'entry_date', 'title', 'stage_task', 'done', 'files', 'verification', 'next',
  'corrects', 'plan', 'task_key', 'original', 'parse_ok', 'import_hash',
];
const UNCHANGED = FROZEN.map((c) => `NEW.${c} IS OLD.${c}`).join(' AND ');

const V1 = `
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  repo_key TEXT UNIQUE NOT NULL,
  git_common_dir TEXT UNIQUE NOT NULL,
  root TEXT NOT NULL,
  origin TEXT,
  shareable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  git_dir TEXT NOT NULL,
  branch TEXT,
  created_at TEXT NOT NULL,
  entry_date TEXT,
  title TEXT NOT NULL,
  stage_task TEXT NOT NULL,
  done TEXT NOT NULL,
  files TEXT NOT NULL,
  verification TEXT NOT NULL,
  next TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'no_commit', 'unresolved')),
  commit_sha TEXT,
  corrects INTEGER REFERENCES entries(id),
  plan TEXT,
  task_key TEXT,
  original TEXT,
  parse_ok INTEGER NOT NULL DEFAULT 1,
  import_hash TEXT,
  UNIQUE (repo_id, import_hash)
);
CREATE INDEX entries_repo_git_dir_state ON entries (repo_id, git_dir, state);

CREATE TABLE status (
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  position INTEGER NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, heading)
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  spec TEXT,
  branch TEXT,
  state TEXT NOT NULL,
  UNIQUE (repo_id, path)
);

CREATE TABLE tasks (
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  key TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  deps TEXT NOT NULL,
  role TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  commits TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (plan_id, key)
);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT
);
CREATE INDEX task_events_plan_task ON task_events (plan_id, task_key);

-- A real table, not a temp one: a trigger in the main schema cannot reference a temp table. A row in it, inserted
-- and deleted inside one transaction by the maintenance code (replaceRows), is what allows a delete from entries.
CREATE TABLE import_guard (active INTEGER);

CREATE TRIGGER entries_append_only BEFORE UPDATE ON entries
WHEN NOT (
  OLD.state = 'pending' AND NEW.state = 'committed'
  AND OLD.commit_sha IS NULL AND NEW.commit_sha IS NOT NULL
  AND ${UNCHANGED}
)
BEGIN
  SELECT RAISE(ABORT, 'entries are append-only: only pending -> committed with a commit sha is allowed');
END;

CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
WHEN NOT EXISTS (SELECT 1 FROM import_guard)
BEGIN
  SELECT RAISE(ABORT, 'entries are append-only: deleting needs the import guard');
END;

CREATE TRIGGER repos_never_deleted BEFORE DELETE ON repos
BEGIN
  SELECT RAISE(ABORT, 'a repos row is never deleted');
END;
`;

// Migration n (1-based) takes user_version n-1 to n. Append only; never edit an applied one.
export const MIGRATIONS = [V1];
export const SCHEMA_VERSION = MIGRATIONS.length;

export class SchemaTooNew extends Error {
  constructor(found) {
    super(`the tracking database has schema version ${found}, newer than the ${SCHEMA_VERSION} this triqual knows`);
    this.name = 'SchemaTooNew';
  }
}

// Applies every migration the database has not seen, each in its own transaction. Throws SchemaTooNew for a database
// written by a newer triqual.
export function migrate(db) {
  const found = db.prepare('PRAGMA user_version').get().user_version;
  if (found > SCHEMA_VERSION) throw new SchemaTooNew(found);
  for (let v = found; v < SCHEMA_VERSION; v += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the lock: a concurrent opener may have applied it while this one waited.
      if (db.prepare('PRAGMA user_version').get().user_version === v) {
        db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
