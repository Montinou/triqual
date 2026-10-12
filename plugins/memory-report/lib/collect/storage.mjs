// Storage collector (spec 6.3): database file sizes, the largest objects, and what the window added.
const TOP_OBJECTS = 8;
const PROJECTION_DAYS = 91;

// Text columns whose bytes count as content, per table (spec 6.3).
const CONTENT_COLUMNS = [
  ['tool_uses', ['tool_input', 'tool_response']],
  ['user_prompts', ['prompt_text']],
  ['observations', ['title', 'subtitle', 'narrative', 'facts']],
  ['session_summaries', ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes']],
];

const sizeOf = (ctx, path) => ctx.fs.stat(path)?.size ?? 0;

function collectTable(ctx, name, columns) {
  const { startMs, endMs } = ctx.window;
  // CAST(NULL AS BLOB) has no length, so each column counts as 0 when absent instead of nulling the whole sum.
  const bytes = columns.map((c) => `COALESCE(length(CAST(${c} AS BLOB)), 0)`).join(' + ');
  const row = ctx.db.prepare(
    `SELECT count(*) AS rows, COALESCE(sum(${bytes}), 0) AS bytes FROM ${name}
     WHERE created_at_epoch >= ? AND created_at_epoch < ?`,
  ).get(startMs, endMs);
  return { name, rowsAdded: row.rows, bytesAdded: row.bytes };
}

export function collectStorage(ctx) {
  const topObjects = ctx.db.prepare(
    `SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name NOT IN ('sqlite_schema', 'sqlite_master')
     GROUP BY name ORDER BY bytes DESC, name LIMIT ?`,
  ).all(TOP_OBJECTS).map((r) => ({ name: r.name, bytes: r.bytes }));
  const tables = CONTENT_COLUMNS.map(([name, columns]) => collectTable(ctx, name, columns));
  const added = tables.reduce((sum, t) => sum + t.bytesAdded, 0);
  return {
    dbBytes: sizeOf(ctx, ctx.paths.dbFile),
    walBytes: sizeOf(ctx, ctx.paths.walFile),
    topObjects,
    tables,
    projection3mBytes: Math.round((added * PROJECTION_DAYS) / ctx.config.intervalDays),
  };
}
