// Read optional claude-mem notes only when building the viewer's pushed data.
import { join } from 'node:path';
import { loadSqlite } from './store.mjs';
await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

export function readNotes(sessionIds, { home, limit = 10 }) {
  const notes = new Map();
  if (!sessionIds.length) return notes;
  let db;
  try {
    db = new DatabaseSync(join(home, '.claude-mem', 'claude-mem.db'), { readOnly: true });
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT s.content_session_id sessionId, COALESCE(o.agent_id, '') agentId,
      o.created_at_epoch at, o.type, o.title FROM observations o
      JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      WHERE s.content_session_id IN (${placeholders}) ORDER BY o.created_at_epoch DESC`).all(...sessionIds);
    for (const { sessionId, agentId, at, type, title } of rows) {
      const key = `${sessionId}\u0000${agentId}`;
      const card = notes.get(key) || [];
      if (card.length < limit) { card.push({ at, type, title }); notes.set(key, card); }
    }
    return notes;
  } catch { return new Map(); }
  finally { db?.close(); }
}
