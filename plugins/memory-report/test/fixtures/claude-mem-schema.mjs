// Fixture helpers: a claude-mem database with the tables and real column names the collectors read (spec 2, 6), and an
// in-memory `fs` for the collector context. node:sqlite is loaded inside the function so importing this file works on
// Node 20; tests that need a database skip themselves when canImportSqlite() is false.
import { createRequire } from 'node:module';

const TABLES = {
  observations: `CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, type TEXT, title TEXT, subtitle TEXT,
    narrative TEXT, facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, created_at TEXT,
    created_at_epoch INTEGER, agent_id TEXT, merged_into_project TEXT)`,
  tool_uses: `CREATE TABLE tool_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, tool_name TEXT, tool_input TEXT, tool_response TEXT,
    created_at_epoch INTEGER, observation_id INTEGER)`,
  user_prompts: `CREATE TABLE user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER, content_session_id TEXT, prompt_number INTEGER,
    prompt_text TEXT, created_at TEXT, created_at_epoch INTEGER)`,
  session_summaries: `CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT, request TEXT, investigated TEXT,
    learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at TEXT, created_at_epoch INTEGER,
    merged_into_project TEXT)`,
  observation_dedup_candidates: `CREATE TABLE observation_dedup_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER, duplicate_of_id INTEGER, project TEXT, method TEXT,
    score REAL, status TEXT, created_at TEXT, created_at_epoch INTEGER)`,
  sdk_sessions: `CREATE TABLE sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, memory_session_id TEXT UNIQUE, project TEXT, cwd TEXT,
    started_at_epoch INTEGER)`,
};

function insertAll(db, table, rows) {
  const known = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const row of rows) {
    const cols = Object.keys(row);
    const unknown = cols.filter((c) => !known.has(c));
    if (unknown.length > 0) throw new Error(`fixture: ${table} has no column ${unknown.join(', ')}`);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    db.prepare(sql).run(...cols.map((c) => row[c] ?? null));
  }
}

// Creates `path` with the claude-mem tables. Each argument is an array of row objects keyed by the real column names.
// `dedup: null` leaves observation_dedup_candidates out, which is how a claude-mem without that table looks.
export function createClaudeMemDb(path, {
  observations = [], toolUses = [], prompts = [], summaries = [], dedup = null, sessions = [],
} = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    for (const [name, ddl] of Object.entries(TABLES)) {
      if (name === 'observation_dedup_candidates' && dedup === null) continue;
      db.exec(ddl);
    }
    insertAll(db, 'observations', observations);
    insertAll(db, 'tool_uses', toolUses);
    insertAll(db, 'user_prompts', prompts);
    insertAll(db, 'session_summaries', summaries);
    if (dedup !== null) insertAll(db, 'observation_dedup_candidates', dedup);
    insertAll(db, 'sdk_sessions', sessions);
  } finally {
    db.close();
  }
}

// In-memory `fs` for the collector context. Values: a string (file text), { dir: true } (a directory), or
// { text, mtimeMs }. A path that is a parent of another entry is a directory without being listed. Every lookup
// answers null for an absent path, like the real fs wrapper.
export function memFs(files = {}) {
  const norm = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const entries = new Map(Object.entries(files).map(([p, v]) => [norm(p), v]));
  const isDir = (p) => {
    const v = entries.get(p);
    if (v !== undefined) return typeof v === 'object' && v.dir === true;
    const prefix = `${p}/`;
    return [...entries.keys()].some((k) => k.startsWith(prefix));
  };
  const textOf = (v) => (typeof v === 'string' ? v : v.text);
  return {
    readText(path) {
      const v = entries.get(norm(path));
      return v === undefined || (typeof v === 'object' && v.dir === true) ? null : textOf(v);
    },
    listDir(path) {
      const p = norm(path);
      if (!isDir(p)) return null;
      const prefix = `${p}/`;
      const names = new Set();
      for (const k of entries.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      return [...names].sort();
    },
    stat(path) {
      const p = norm(path);
      const v = entries.get(p);
      if (v === undefined) return isDir(p) ? { size: 0, mtimeMs: 0, isDirectory: true } : null;
      if (typeof v === 'object' && v.dir === true) return { size: 0, mtimeMs: 0, isDirectory: true };
      return { size: Buffer.byteLength(textOf(v)), mtimeMs: typeof v === 'object' ? (v.mtimeMs ?? 0) : 0, isDirectory: false };
    },
  };
}
