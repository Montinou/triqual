// The tracking store: a local SQLite database (node:sqlite) holding progress entries, status sections, plans and task
// ledgers for repositories in store mode (spec §2). The API is synchronous once `loadSqlite()` has run, which the
// async CLI and hook entries do once. Committed and local repositories never import this module's sqlite.
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BRAND, brandDir } from './brand.mjs';
import { migrate, SCHEMA_VERSION, SchemaTooNew } from './store-schema.mjs';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// The code of the StoreError for a database written by a newer triqual than this one: the Stop gate fails open on it
// (an older plugin still loaded by a long session must not block it) and the recovery advice is to update, never restore.
export const SCHEMA_TOO_NEW = 'schema-too-new';

const openFailure = (file, e) => new StoreError(e instanceof SchemaTooNew ? SCHEMA_TOO_NEW : 'open',
  `cannot open the tracking database ${file}: ${e.message}`);

// relocateRepo's refusal: `reason` says why nothing was changed.
export class RelocateRefused extends Error {
  constructor(reason) {
    super(`cannot relocate the repository: ${reason}`);
    this.name = 'RelocateRefused';
    this.reason = reason;
  }
}

const NODE_FLOOR = [22, 13];
const NODE_MESSAGE = 'triqual store mode needs Node 22.13 or newer';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BACKUPS = 'backups';
const BACKUP_FILE = /^tracking-(\d{4}-\d{2}-\d{2})\.db$/;
const BACKUPS_KEPT = 7;
const OVERRIDE_KEY = `${BRAND.envPrefix}TRACKING_DB`;
const SQLITE_WARNING = /sqlite/i;
const EXPERIMENTAL = 'ExperimentalWarning';

let DatabaseSync = null;

// Loads node:sqlite once. The ExperimentalWarning it prints on Node 22 is dropped by a filter on process.emitWarning
// that is installed before the import and stays (a 'warning' listener does not stop the print); it drops only an
// ExperimentalWarning whose message mentions SQLite, so every other warning still reaches the user.
export async function loadSqlite() {
  if (DatabaseSync) return;
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) throw new StoreError('node', NODE_MESSAGE);
  const original = process.emitWarning;
  if (!original.sqliteFiltered) {
    const filtered = function emitWarning(warning, ...rest) {
      const message = typeof warning === 'string' ? warning : warning?.message;
      // The type is the second argument (a string, or { type }), else the Error's own name; the default is 'Warning'.
      const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) : warning?.name;
      if (type === EXPERIMENTAL && typeof message === 'string' && SQLITE_WARNING.test(message)) return undefined;
      return Reflect.apply(original, process, [warning, ...rest]);
    };
    filtered.sqliteFiltered = true;
    process.emitWarning = filtered;
  }
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    throw new StoreError('node', `${NODE_MESSAGE} (${e.message})`);
  }
}

// True when a directory mode gives its group or others any access: the data dir then needs a chmod to 0700. A dir that
// is already private is left alone, so it opens on a read-only filesystem.
export const needsTighten = (mode) => (mode & 0o077) !== 0;

// Creates `file` empty, readable by its owner only, failing with EEXIST when it exists. VACUUM INTO writes over an
// existing empty file and keeps its mode, so a copy written there is never wider than 0600, not even for a moment.
export function createPrivate(file) {
  const fd = openSync(file, 'wx', FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

// { db, dataDir } for the store, or null when the store is disabled: TRIQUAL_TRACKING_DB set to anything but an
// absolute path (the empty string included). An absolute override names the file and its folder is the data dir.
export function storePaths({ home, env }) {
  const override = env[OVERRIDE_KEY];
  if (override !== undefined) {
    return isAbsolute(override) ? { db: override, dataDir: dirname(override) } : null;
  }
  const dataDir = brandDir(env.XDG_DATA_HOME || join(home, '.local', 'share'));
  return { db: join(dataDir, 'tracking.db'), dataDir };
}

// The path as the filesystem names it (symlinks resolved) when it exists, else made absolute.
const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// First 16 hex chars of the sha256 of the realpath of the git common dir: the stable key of a clone's documents dir.
export function repoKey(gitCommonDir) {
  return createHash('sha256').update(canonical(gitCommonDir)).digest('hex').slice(0, 16);
}

// A repository's documents directories under the data directory: <dataDir>/repos/<repo_key>/{plans,specs}.
export function docsDirs(dataDir, key) {
  const docsDir = join(dataDir, 'repos', key);
  return { docsDir, plansDir: join(docsDir, 'plans'), specsDir: join(docsDir, 'specs') };
}

const nowIso = () => new Date().toISOString();
const json = (v) => JSON.stringify(v ?? []);
const plain = (row) => (row === undefined ? undefined : { ...row });
const plainAll = (rows) => rows.map((r) => ({ ...r }));
// `Plan <topic> · T<N>` in a stage/task text names the plan and the task the entry belongs to.
const PLAN_TASK = /^Plan (.+?) · (T\d+)/;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
// Two task history events are the same event when their time, both statuses and note agree.
export const sameEvent = (a, b) => a.at === b.at && (a.from ?? null) === (b.from ?? null) && a.to === b.to
  && (a.note ?? null) === (b.note ?? null);

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

// The main file's header without a connection: `{ empty: true }` for a 0-byte file (an interrupted create),
// `{ version }` (PRAGMA user_version, the big-endian integer at offset 60) for an SQLite file, `{ notDb: true }` for
// anything else, a file shorter than the 64 header bytes included.
function readHeader(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    if (n === 0) return { empty: true };
    if (n < 64 || !buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return { notDb: true };
    return { version: buf.readUInt32BE(60) };
  } finally {
    closeSync(fd);
  }
}

// True when a -wal with content sits beside the file: page 1 (user_version) may live there, so the main file's header
// can be older than the live database (a writer holds it open, or its creator was killed after migrating).
const walHasContent = (file) => {
  try {
    return statSync(`${file}-wal`).size > 0;
  } catch {
    return false;
  }
};

// `upgradeByWrite` tells the hooks that a write is the fix, so they never suggest a restore.
const tooOld = (file, found) => Object.assign(new StoreError('open', `the tracking database ${file} has schema ${found}, older than this triqual's ${SCHEMA_VERSION}: run a command that writes (for example \`triqual tracking add\`) to upgrade it`), { upgradeByWrite: true });

const MISSING = (db) => `no tracking database at ${db}: create one with \`triqual progress-init --store\` or \`triqual tracking import\`, or restore a snapshot with \`triqual tracking restore <snapshot>\``;

// Opens the store. Only `create: true` (progress-init --store, tracking import) may create the file: any other open
// of an absent file throws `missing` and creates nothing. Throws StoreError with code disabled, missing, node or open.
// `readOnly: true` (the read-only commands, `tasks line` among them) opens the file read-only: no pragma that writes, no
// migration and no permission change. A database older than this triqual's schema is refused (`open`, naming the
// upgrade): only a writing command migrates.
export function openStore({ home, env, create = false, readOnly = false }) {
  const paths = storePaths({ home, env });
  if (!paths) throw new StoreError('disabled', `the tracking store is disabled: ${OVERRIDE_KEY} is not an absolute path`);
  if (!DatabaseSync) throw new StoreError('open', 'node:sqlite is not loaded: await loadSqlite() first');
  const { db: file, dataDir } = paths;
  if (!existsSync(file)) {
    if (!create) throw new StoreError('missing', MISSING(file));
    // Only a directory this call creates gets the private mode: an override may sit inside a shared folder.
    const made = mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
    if (made) chmodSync(made, DIR_MODE);
    closeSync(openSync(file, 'a', FILE_MODE));
    chmodSync(file, FILE_MODE);
  }
  // The default data dir is ours: tighten one that pre-exists with a looser mode. An override's folder is not. A dir
  // that is already private is not chmodded, so it opens on a read-only filesystem.
  if (!readOnly && env[OVERRIDE_KEY] === undefined) {
    try {
      if (needsTighten(statSync(dataDir).mode)) chmodSync(dataDir, DIR_MODE);
    } catch (e) {
      throw new StoreError('open', `cannot restrict the data directory ${dataDir} to its owner: ${e.message}`);
    }
  }
  let db;
  if (readOnly) {
    // The header is trusted before any connection only when no WAL has content, because then it is the live version.
    // SQLite creates the -wal and -shm files of a WAL database as soon as a reader opens it, and a refused open must
    // leave the directory as it found it. With a WAL that has content the sidecars exist already: SQLite decides.
    // The WAL is looked at both before and after the header, and the header is trusted only when neither look saw
    // content. Before: a writer that checkpoints and closes between the reads leaves a fresh header behind an empty
    // WAL, never a stale header with the WAL already gone. After: a writer that commits to an empty WAL between the
    // reads leaves a stale header beside a WAL with content. Either way no false "older schema".
    const walBefore = walHasContent(file);
    let header;
    try {
      header = readHeader(file);
    } catch (e) {
      throw new StoreError('open', `cannot open the tracking database ${file}: ${e.message}`);
    }
    const wal = walBefore || walHasContent(file);
    if (header.notDb) throw new StoreError('open', `${file} is not a tracking database (not an SQLite file); move it away or restore a snapshot with \`triqual tracking restore <snapshot>\``);
    if (!wal && (header.empty || header.version < SCHEMA_VERSION)) throw tooOld(file, header.empty ? 0 : header.version);
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      const found = db.prepare('PRAGMA user_version').get().user_version;
      if (found > SCHEMA_VERSION) throw new SchemaTooNew(found);
      if (found < SCHEMA_VERSION) throw tooOld(file, found);
      return new Store(db, file);
    } catch (e) {
      try { db?.close(); } catch { /* never opened */ }
      if (e instanceof StoreError) throw e;
      throw openFailure(file, e);
    }
  }
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (e) {
    try { db?.close(); } catch { /* never opened */ }
    throw openFailure(file, e);
  }
  return new Store(db, file);
}

class Store {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.depth = 0;
  }

  // Runs fn in one transaction; nested calls join the outer one.
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      // A failed rollback must not hide the error that caused it.
      try { this.db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw e;
    } finally {
      this.depth -= 1;
    }
  }

  // Runs fn inside one read transaction: every read in it sees the same snapshot, whatever another connection commits
  // meanwhile. For the views, which read several tables (a read-only connection can open one); nested calls join it.
  readTx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth += 1;
    let out;
    try {
      out = fn();
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw e;
    } finally {
      this.depth -= 1;
    }
    this.db.exec('COMMIT');
    return out;
  }

  get(sql, ...params) {
    return plain(this.db.prepare(sql).get(...params));
  }

  all(sql, ...params) {
    return plainAll(this.db.prepare(sql).all(...params));
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  // ---- Repositories ----

  // The repository row for a git common dir, or null. Never writes.
  findRepo(gitCommonDir) {
    return this.get('SELECT id, repo_key, shareable FROM repos WHERE git_common_dir = ?', canonical(gitCommonDir)) ?? null;
  }

  // Inserts the repository when absent and returns its id and key; an existing row (shareable included) is untouched.
  ensureRepo({ gitCommonDir, root, origin, shareable }) {
    const dir = canonical(gitCommonDir);
    return this.tx(() => {
      this.run(
        'INSERT OR IGNORE INTO repos (repo_key, git_common_dir, root, origin, shareable, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        repoKey(dir), dir, root, origin ?? null, shareable ? 1 : 0, nowIso(),
      );
      return this.get('SELECT id, repo_key FROM repos WHERE git_common_dir = ?', dir);
    });
  }

  // Re-points the row whose root is `oldRoot` (its canonical path, else the string as given) at a new checkout: its
  // repo_key, git_common_dir and root become the new checkout's canonical values, and the old documents dir
  // <dataDir>/repos/<oldKey> is renamed to <newKey>. Every id (row, entries, plans, tasks) is kept; nothing is deleted
  // and no entry is touched. Throws RelocateRefused, changing nothing, when no single row has the old root, the new
  // checkout already has a row, an entry is pending, a plan is not done, or <newKey>/ already exists. A failed rename
  // rolls the row back; a failed COMMIT after the rename renames the dir back before rethrowing.
  relocateRepo({ oldRoot, gitCommonDir, root, dataDir }) {
    const dir = canonical(gitCommonDir);
    const newRoot = canonical(root);
    const newKey = repoKey(dir);
    let renamed = null;
    try {
      return this.tx(() => {
        let rows = this.all('SELECT id, repo_key FROM repos WHERE root = ?', canonical(oldRoot));
        if (rows.length === 0) rows = this.all('SELECT id, repo_key FROM repos WHERE root = ?', oldRoot);
        if (rows.length === 0) throw new RelocateRefused(`no repository row has the root ${oldRoot}`);
        if (rows.length > 1) throw new RelocateRefused(`${rows.length} repository rows have the root ${oldRoot}`);
        const [{ id: repoId, repo_key: oldKey }] = rows;
        if (this.get('SELECT id FROM repos WHERE git_common_dir = ? OR repo_key = ?', dir, newKey)) {
          throw new RelocateRefused(`the new checkout ${dir} already has a row`);
        }
        const pending = this.get("SELECT COUNT(*) AS n FROM entries WHERE repo_id = ? AND state = 'pending'", repoId).n;
        if (pending > 0) throw new RelocateRefused(`${pending} pending entr${pending === 1 ? 'y' : 'ies'}: commit or resolve them first`);
        const active = this.all("SELECT path FROM plans WHERE repo_id = ? AND state <> 'done' ORDER BY id", repoId);
        if (active.length > 0) throw new RelocateRefused(`active plan(s) not done: ${active.map((p) => p.path).join(', ')}`);
        const from = docsDirs(dataDir, oldKey).docsDir;
        const to = docsDirs(dataDir, newKey).docsDir;
        if (existsSync(to)) throw new RelocateRefused(`the documents dir ${to} already exists`);
        this.run('UPDATE repos SET repo_key = ?, git_common_dir = ?, root = ? WHERE id = ?', newKey, dir, newRoot, repoId);
        if (existsSync(from)) {
          renameSync(from, to);
          renamed = { from, to };
        }
        return { repoId, oldKey, newKey };
      });
    } catch (e) {
      // Only the COMMIT can throw after the rename: the row is back to the old values, so the dir goes back too.
      if (renamed) renameSync(renamed.to, renamed.from);
      throw e;
    }
  }

  // ---- Entries ----

  // `id` is null (a new id) except for the import, which re-inserts a replaced draft's row under its own id.
  // `createdAt` (a UTC timestamp) is what orders entries: the write time of an `add`, the heading commit's author date
  // of an import. `entryDate` (YYYY-MM-DD, or null) is the date the entry's heading shows.
  addEntry(ctx, fields, opts = {}) {
    const {
      state = 'pending', commit = null, corrects = null, original = null, parseOk = true, importHash = null,
      createdAt = nowIso(), entryDate = null, id = null,
    } = opts;
    const planTask = PLAN_TASK.exec(fields.stage_task);
    const { lastInsertRowid } = this.run(
      `INSERT INTO entries (id, repo_id, git_dir, branch, created_at, entry_date, title, stage_task, done, files,
         verification, next, state, commit_sha, corrects, plan, task_key, original, parse_ok, import_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ctx.repoId, ctx.gitDir, ctx.branch ?? null, createdAt, entryDate, fields.title, fields.stage_task, fields.done, fields.files,
      fields.verification, fields.next, state, commit, corrects, planTask?.[1] ?? null, planTask?.[2] ?? null,
      original, parseOk ? 1 : 0, importHash,
    );
    return Number(lastInsertRowid);
  }

  pendingEntries(ctx) {
    return this.all(
      "SELECT id FROM entries WHERE repo_id = ? AND git_dir = ? AND state = 'pending' ORDER BY id",
      ctx.repoId, ctx.gitDir,
    );
  }

  // Marks the still-pending ones of `ids` committed at `sha`; returns how many it stamped (an entry already stamped
  // is skipped: the trigger would refuse a second stamp).
  stampEntries(ids, sha) {
    return this.tx(() => {
      let n = 0;
      for (const id of ids) {
        n += Number(this.run(
          "UPDATE entries SET state = 'committed', commit_sha = ? WHERE id = ? AND state = 'pending' AND commit_sha IS NULL",
          sha, id,
        ).changes);
      }
      return n;
    });
  }

  // The repository's entries, newest first: by created_at (a timestamp: the write time of an add, the heading commit's
  // author date of an imported entry), then by id. `since` (YYYY-MM-DD) compares with the date the entry shows, its
  // heading date (the date of created_at when it has none). `worktree` (a git dir) leaves out the other worktrees'
  // pending drafts.
  entries(repoId, { last, since, plan, grep, worktree } = {}) {
    const where = ['repo_id = ?'];
    const params = [repoId];
    if (worktree) { where.push("(state <> 'pending' OR git_dir = ?)"); params.push(worktree); }
    if (since) { where.push('COALESCE(entry_date, substr(created_at, 1, 10)) >= ?'); params.push(since); }
    if (plan) { where.push('plan = ?'); params.push(plan); }
    if (grep) {
      const pattern = `%${likeEscape(grep)}%`;
      const columns = ['title', 'stage_task', 'done', 'files', 'verification', 'next', 'original'];
      where.push(`(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...columns.map(() => pattern));
    }
    let sql = `SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`;
    if (last) { sql += ' LIMIT ?'; params.push(last); }
    return this.all(sql, ...params);
  }

  // ---- Status ----

  // Replaces the repository's sections ([{ heading, body, updated_at? }], the preamble first). A section stamped
  // `updated_at` keeps that stamp; the others get `now`.
  setStatus(repoId, sections, now) {
    this.tx(() => {
      this.run('DELETE FROM status WHERE repo_id = ?', repoId);
      sections.forEach((s, position) => {
        this.run(
          'INSERT INTO status (repo_id, position, heading, body, updated_at) VALUES (?, ?, ?, ?, ?)',
          repoId, position, s.heading, s.body, s.updated_at ?? now,
        );
      });
    });
  }

  status(repoId) {
    return this.all('SELECT heading, body FROM status WHERE repo_id = ? ORDER BY position', repoId);
  }

  // ---- Plans and tasks ----

  upsertPlan(repoId, { path, spec, branch, state }) {
    return Number(this.get(
      `INSERT INTO plans (repo_id, path, spec, branch, state) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, path) DO UPDATE SET spec = excluded.spec, branch = excluded.branch, state = excluded.state
       RETURNING id`,
      repoId, path, spec ?? null, branch ?? null, state,
    ).id);
  }

  plans(repoId) {
    return this.all('SELECT id, path, spec, branch, state FROM plans WHERE repo_id = ? ORDER BY id', repoId);
  }

  // The plan as the ledger object lib/ledger.mjs works on.
  ledgerOf(planId) {
    const plan = this.get('SELECT path, spec, branch, state FROM plans WHERE id = ?', planId);
    if (!plan) return null;
    const events = new Map();
    for (const e of this.all('SELECT task_key, at, from_status, to_status, note FROM task_events WHERE plan_id = ? ORDER BY id', planId)) {
      if (!events.has(e.task_key)) events.set(e.task_key, []);
      events.get(e.task_key).push({ at: e.at, from: e.from_status, to: e.to_status, note: e.note });
    }
    const tasks = this.all('SELECT * FROM tasks WHERE plan_id = ? ORDER BY position', planId).map((t) => ({
      id: t.key,
      title: t.title,
      status: t.status,
      deps: JSON.parse(t.deps),
      skills: JSON.parse(t.skills),
      role: t.role,
      tier: t.tier,
      effectiveTier: t.effective_tier,
      commits: JSON.parse(t.commits),
      reason: t.reason,
      history: events.get(t.key) ?? [],
    }));
    return { version: 1, plan: plan.path, spec: plan.spec, branch: plan.branch, state: plan.state, tasks };
  }

  // Persists the ledger: the plan's spec, branch and state, every task with its position, and the history items the
  // store has not seen yet as task_events. An item is new when no stored event of that task is the same event (each
  // stored event matches one item), so a ledger whose history is not the stored one plus newer items never skips or
  // repeats one.
  saveLedger(planId, ledger) {
    this.tx(() => {
      this.run('UPDATE plans SET spec = ?, branch = ?, state = ? WHERE id = ?', ledger.spec ?? null, ledger.branch ?? null, ledger.state, planId);
      ledger.tasks.forEach((t, position) => {
        this.run(
          `INSERT INTO tasks (plan_id, key, position, title, deps, role, skills, status, commits, reason, tier, effective_tier)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (plan_id, key) DO UPDATE SET position = excluded.position, title = excluded.title,
             deps = excluded.deps, role = excluded.role, skills = excluded.skills, status = excluded.status,
             commits = excluded.commits, reason = excluded.reason, tier = excluded.tier, effective_tier = excluded.effective_tier`,
          planId, t.id, position, t.title, json(t.deps), t.role ?? null, json(t.skills), t.status, json(t.commits), t.reason ?? null,
          t.tier ?? null, t.effectiveTier ?? null,
        );
        const known = this.all(
          'SELECT at, from_status AS "from", to_status AS "to", note FROM task_events WHERE plan_id = ? AND task_key = ? ORDER BY id',
          planId, t.id,
        );
        for (const h of t.history ?? []) {
          const seen = known.findIndex((k) => k !== null && sameEvent(k, h));
          if (seen !== -1) {
            known[seen] = null;
            continue;
          }
          this.run(
            'INSERT INTO task_events (plan_id, task_key, at, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)',
            planId, t.id, h.at, h.from ?? null, h.to, h.note ?? null,
          );
        }
      });
    });
  }

  // ---- Maintenance ----

  // Every row of the repository, tagged by table, the repos row first: [{ table, row }].
  rows(repoId) {
    const out = [];
    const take = (table, rows) => rows.forEach((row) => out.push({ table, row }));
    take('repos', this.all('SELECT * FROM repos WHERE id = ?', repoId));
    take('entries', this.all('SELECT * FROM entries WHERE repo_id = ? ORDER BY id', repoId));
    take('status', this.all('SELECT * FROM status WHERE repo_id = ? ORDER BY position', repoId));
    take('plans', this.all('SELECT * FROM plans WHERE repo_id = ? ORDER BY id', repoId));
    take('tasks', this.all('SELECT t.* FROM tasks t JOIN plans p ON p.id = t.plan_id WHERE p.repo_id = ? ORDER BY t.plan_id, t.position', repoId));
    take('task_events', this.all('SELECT e.* FROM task_events e JOIN plans p ON p.id = e.plan_id WHERE p.repo_id = ? ORDER BY e.id', repoId));
    return out;
  }

  // Replaces the repository's rows: in one transaction, with import_guard holding a row, it deletes the repository's
  // entries, status sections, plans, tasks and events (never the repos row), then runs fn(store) to insert the new
  // ones. Anything thrown rolls the whole replacement back, the guard row included.
  replaceRows(repoId, fn) {
    return this.tx(() => {
      this.run('INSERT INTO import_guard (active) VALUES (1)');
      this.run('DELETE FROM task_events WHERE plan_id IN (SELECT id FROM plans WHERE repo_id = ?)', repoId);
      this.run('DELETE FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE repo_id = ?)', repoId);
      this.run('DELETE FROM plans WHERE repo_id = ?', repoId);
      this.run('DELETE FROM status WHERE repo_id = ?', repoId);
      this.run('DELETE FROM entries WHERE repo_id = ?', repoId);
      const out = fn(this);
      this.run('DELETE FROM import_guard');
      return out;
    });
  }

  // A consistent copy of the database at `file`, readable by its owner only from its first byte: `file` is created
  // empty and 0600 first (createPrivate, EEXIST when it exists), then VACUUM INTO writes over it. The empty file is
  // removed when the copy fails.
  snapshotTo(file) {
    createPrivate(file);
    try {
      this.run('VACUUM INTO ?', file);
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

// Writes backups/tracking-YYYY-MM-DD.db in dataDir when today's file is missing and keeps the 7 newest. `now` is a
// Date or an ISO string (the day is its UTC date). Returns the new file's path, or null when today's already exists.
export function maybeDailySnapshot(store, dataDir, now) {
  const day = (typeof now === 'string' ? now : now.toISOString()).slice(0, 10);
  const dir = join(dataDir, BACKUPS);
  const target = join(dir, `tracking-${day}.db`);
  if (existsSync(target)) return null;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE); // a backups dir that pre-exists with a looser mode is tightened
  // Written aside (snapshotTo creates it 0600) and renamed, so a crash never leaves a partial file under today's name
  // and today's name is never wider than 0600.
  // The temp name is this call's own (pid and random), so a stale or concurrent process's partial file is never
  // clobbered; it is removed here only when this call fails.
  const partial = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    store.snapshotTo(partial);
    renameSync(partial, target);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  const kept = readdirSync(dir).filter((n) => BACKUP_FILE.test(n)).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
  return target;
}
