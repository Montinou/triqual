// The isolation probe's database query (spec 10, live check 1): sessions claude-mem recorded for a work directory or
// project since a given time. `db` is an open node:sqlite handle; nothing here writes.

// sdk_sessions rows with started_at_epoch >= sinceMs whose cwd or project matches, oldest first.
export function capturedSessions(db, { cwd, project, sinceMs }) {
  return db
    .prepare(
      'SELECT id, cwd, project, started_at_epoch FROM sdk_sessions '
      + 'WHERE started_at_epoch >= ? AND (cwd = ? OR project = ?) ORDER BY started_at_epoch, id',
    )
    .all(sinceMs, cwd, project)
    .map((row) => ({ id: row.id, cwd: row.cwd, project: row.project, started_at_epoch: row.started_at_epoch }));
}
