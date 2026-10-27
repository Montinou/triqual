import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlite } from '../lib/store.mjs';
import { readNotes } from '../lib/claude-mem-notes.mjs';
await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

function fixture(fn, { missingColumn = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pt-notes-'));
  mkdirSync(join(home, '.claude-mem'));
  const db = new DatabaseSync(join(home, '.claude-mem', 'claude-mem.db'));
  db.exec(`CREATE TABLE sdk_sessions(memory_session_id TEXT, content_session_id TEXT);
    CREATE TABLE observations(memory_session_id TEXT, agent_id TEXT, created_at_epoch INTEGER, type TEXT${missingColumn ? '' : ', title TEXT'});
    INSERT INTO sdk_sessions VALUES ('memory-a', 'session-a'), ('memory-b', 'session-b');`);
  try { return fn({ home, db }); }
  finally { db.close(); rmSync(home, { recursive: true, force: true }); }
}

test('readNotes joins observations to sdk_sessions on memory_session_id and groups by agent_id', () => fixture(({ home, db }) => {
  db.exec(`INSERT INTO observations VALUES ('memory-a', NULL, 1000, 'decision', 'controller'),
    ('memory-a', 'worker', 2000, 'finding', 'worker note'), ('memory-b', NULL, 3000, 'finding', 'other session');`);
  const notes = readNotes(['session-a'], { home });
  assert.deepEqual([...notes], [
    ['session-a\u0000worker', [{ at: 2000, type: 'finding', title: 'worker note' }]],
    ['session-a\u0000', [{ at: 1000, type: 'decision', title: 'controller' }]],
  ]);
}));

test('readNotes limits per card', () => fixture(({ home, db }) => {
  const insert = db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?)');
  for (const agent of [null, 'worker']) for (let at = 0; at < 12; at++) insert.run('memory-a', agent, at, 'finding', `note ${at}`);
  const notes = readNotes(['session-a'], { home, limit: 2 });
  assert.equal(notes.size, 2);
  for (const card of notes.values()) assert.deepEqual(card.map(n => n.at), [11, 10]);
}));

test('readNotes returns an empty map without claude-mem', () => {
  const home = mkdtempSync(join(tmpdir(), 'pt-no-notes-'));
  try { assert.deepEqual(readNotes(['session-a'], { home }), new Map()); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('readNotes tolerates a missing column', () => fixture(({ home }) => {
  assert.deepEqual(readNotes(['session-a'], { home }), new Map());
}, { missingColumn: true }));
