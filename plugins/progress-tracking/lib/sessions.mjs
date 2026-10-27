// Agent activity is deliberately separate from the tracking store. Only safe labels reach this database.
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadSqlite } from './store.mjs';
await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL_LIMIT = 120;

export function openSessions(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'sessions.db');
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT, agent_id TEXT NOT NULL DEFAULT '', parent_agent_id TEXT, agent_type TEXT,
      repo_root TEXT, task TEXT, model TEXT, started_at INTEGER, last_at INTEGER, ended_at INTEGER,
      PRIMARY KEY (session_id, agent_id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT,
      agent_id TEXT NOT NULL DEFAULT '', at INTEGER, kind TEXT, label TEXT);
      CREATE INDEX IF NOT EXISTS events_by_agent ON events(session_id, agent_id, at)`);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function labelOf(payload) {
  const name = payload.tool_name || '';
  const input = payload.tool_input || {};
  let label = name;
  if (name === 'Bash') label += input.description ? `: ${input.description}` : '';
  else if (['Read', 'Edit', 'Write'].includes(name)) label += input.file_path ? `: ${basename(input.file_path)}` : '';
  else if (name === 'Agent') label = [input.subagent_type || input.agent_type || 'Agent', input.description].filter(Boolean).join(': ');
  return label.slice(0, LABEL_LIMIT);
}

export function taskOf(input = {}) {
  for (const text of [input.description, input.prompt]) {
    if (typeof text !== 'string') continue;
    const brief = text.match(/task-(\d+)-brief/);
    if (brief) return `T${brief[1]}`;
    const task = text.match(/\bT\d+\b/);
    if (task) return task[0];
  }
  return null;
}

export function record(db, payload, now, repoRoot) {
  const sid = payload.session_id;
  if (typeof sid !== 'string' || !sid) return;
  const hook = payload.hook_event_name;
  const aid = ['SessionStart', 'SessionEnd'].includes(hook) ? '' : (payload.agent_id || '');
  const upsert = (id, parent = null, type = null, task = null, model = null, ended = null) => {
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET
      parent_agent_id = COALESCE(excluded.parent_agent_id, sessions.parent_agent_id),
      agent_type = COALESCE(excluded.agent_type, sessions.agent_type),
      repo_root = COALESCE(excluded.repo_root, sessions.repo_root),
      task = COALESCE(excluded.task, sessions.task), model = COALESCE(excluded.model, sessions.model),
      started_at = MIN(sessions.started_at, excluded.started_at),
      last_at = MAX(sessions.last_at, excluded.last_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at)`)
      .run(sid, id, parent, type, repoRoot, task, model, now, now, ended);
  };
  const event = (kind, label) => db.prepare('INSERT INTO events(session_id, agent_id, at, kind, label) VALUES (?, ?, ?, ?, ?)').run(sid, aid, now, kind, label);
  db.exec('BEGIN IMMEDIATE');
  try {
    upsert(aid, null, payload.agent_type || null, null, null, ['SubagentStop', 'SessionEnd'].includes(hook) ? now : null);
    if (hook === 'SessionStart') {
      db.prepare('DELETE FROM sessions WHERE last_at < ?').run(now - RETENTION_MS);
      db.prepare('DELETE FROM events WHERE at < ?').run(now - RETENTION_MS);
    } else if (hook === 'SubagentStart') event('start', (payload.agent_type || 'Agent').slice(0, LABEL_LIMIT));
    else if (hook === 'SubagentStop') event('stop', (payload.agent_type || 'Agent').slice(0, LABEL_LIMIT));
    else if (hook === 'PostToolUseFailure') event('error', labelOf(payload));
    else if (hook === 'PostToolUse') {
      event('tool', labelOf(payload));
      const child = payload.tool_name === 'Agent' && payload.tool_response?.agentId;
      if (typeof child === 'string' && child) {
        const input = payload.tool_input || {};
        upsert(child, aid, input.subagent_type || input.agent_type || null, taskOf(input), input.model || payload.tool_response.resolvedModel || null);
        event('spawn', labelOf(payload));
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function readSessions(db, { since, now }) {
  return db.prepare(`SELECT session_id sessionId, agent_id agentId, parent_agent_id parentAgentId,
    agent_type agentType, repo_root repoRoot, task, model, started_at startedAt, last_at lastAt,
    ended_at endedAt FROM sessions WHERE last_at >= ? ORDER BY started_at, agent_id`).all(since).map(row => ({
      ...row,
      events: db.prepare(`SELECT at, kind, label FROM events WHERE session_id = ? AND agent_id = ?
        ORDER BY at DESC, id DESC LIMIT 30`).all(row.sessionId, row.agentId).map(event => ({ ...event })),
    }));
}
