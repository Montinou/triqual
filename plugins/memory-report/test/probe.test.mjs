import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canImportSqlite } from './helpers.mjs';

const hasSqlite = await canImportSqlite();

test('capturedSessions matches sdk_sessions by cwd or project from sinceMs on', { skip: !hasSqlite && 'node:sqlite unavailable' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { capturedSessions } = await import('../lib/probe.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, cwd TEXT, project TEXT, started_at_epoch INTEGER NOT NULL)');
  const ins = db.prepare('INSERT INTO sdk_sessions (id, cwd, project, started_at_epoch) VALUES (?, ?, ?, ?)');
  ins.run(1, '/work', 'other', 1000);
  ins.run(2, '/elsewhere', 'memory-report-work', 1000);
  ins.run(3, '/work', 'memory-report-work', 1000);
  ins.run(4, '/elsewhere', 'other', 1000);
  ins.run(5, '/work', 'other', 500);
  ins.run(6, null, 'memory-report-work', 2000);
  const ids = (rows) => rows.map((r) => r.id).sort((a, b) => a - b);

  assert.deepEqual(ids(capturedSessions(db, { cwd: '/work', project: 'nope', sinceMs: 1000 })), [1, 3]);
  assert.deepEqual(ids(capturedSessions(db, { cwd: '/nope', project: 'memory-report-work', sinceMs: 1000 })), [2, 3, 6]);
  assert.deepEqual(ids(capturedSessions(db, { cwd: '/work', project: 'memory-report-work', sinceMs: 1000 })), [1, 2, 3, 6]);
  assert.deepEqual(ids(capturedSessions(db, { cwd: '/work', project: 'memory-report-work', sinceMs: 1001 })), [6]);
  assert.deepEqual(ids(capturedSessions(db, { cwd: '/work', project: 'memory-report-work', sinceMs: 0 })), [1, 2, 3, 5, 6]);
  assert.deepEqual(Object.keys(capturedSessions(db, { cwd: '/work', project: 'x', sinceMs: 1000 })[0]).sort(), ['cwd', 'id', 'project', 'started_at_epoch']);
  db.close();
});
