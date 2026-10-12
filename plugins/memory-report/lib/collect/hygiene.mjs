// Hygiene collector (spec 6.2): empty observations, duplicate groups and the dedup setting, over all projects.
import { identityUnavailable, isCoveredKey } from '../policy.mjs';
import { readClaudeMemSetting } from '../sources.mjs';

const TOP = 5;
const TITLE_MAX = 80;
// SQLite trim() strips spaces only by default; blank here also means tabs and line breaks.
const WS = "' ' || char(9, 10, 13)";
const blank = (col) => `(${col} IS NULL OR trim(${col}, ${WS}) = '')`;
const EMPTY_WHERE = `${blank('narrative')} AND (${blank('facts')} OR trim(facts, ${WS}) = '[]')`;

const byCountThenName = (a, b) => b.count - a.count || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
const truncate = (text, max) => [...text].slice(0, max).join('');

function collectEmpty(ctx) {
  const { startMs, endMs } = ctx.window;
  const total = ctx.db.prepare(`SELECT count(*) AS n FROM observations WHERE ${EMPTY_WHERE}`).get().n;
  const rows = ctx.db.prepare(
    `SELECT COALESCE(project, '') AS project, count(*) AS count FROM observations
     WHERE ${EMPTY_WHERE} AND created_at_epoch >= ? AND created_at_epoch < ?
     GROUP BY COALESCE(project, '')`,
  ).all(startMs, endMs);
  const inWindow = rows.reduce((sum, r) => sum + r.count, 0);
  const topProjects = rows.map((r) => ({ project: r.project, count: r.count })).sort(byCountThenName).slice(0, TOP);
  return { total, inWindow, topProjects };
}

function collectDuplicates(ctx) {
  const { startMs, endMs } = ctx.window;
  // The bare `title` column takes its value from the row holding max(created_at_epoch): the newest title of the group.
  const groups = ctx.db.prepare(
    `SELECT COALESCE(project, '') AS project, count(*) AS rows, max(created_at_epoch) AS newest, trim(title, ${WS}) AS title
     FROM observations WHERE NOT ${blank('title')}
     GROUP BY COALESCE(project, ''), lower(trim(title, ${WS})) HAVING count(*) > 1`,
  ).all();
  const isNew = (g) => g.newest >= startMs && g.newest < endMs;
  // A title shows only for a key covered as a whole (repo-identity spec 4.2): a key with no folders needs a name rule.
  // With the repository identity unavailable and repository or owner never-send entries, no title shows (Ruling 12).
  // The resolution is required: a missing one throws.
  const repos = ctx.repos;
  const hideTitles = identityUnavailable(ctx.config, repos);
  const perProject = new Map();
  for (const g of groups) if (isNew(g)) perProject.set(g.project, (perProject.get(g.project) ?? 0) + 1);
  const topProjects = [...perProject].map(([project, count]) => ({ project, count })).sort(byCountThenName).slice(0, TOP);
  const largest = groups
    .sort((a, b) => b.rows - a.rows || b.newest - a.newest || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0))
    .slice(0, TOP)
    .map((g) => ({
      project: g.project,
      rows: g.rows,
      title: !hideTitles && isCoveredKey(g.project, null, ctx.config, repos) ? truncate(g.title, TITLE_MAX) : null,
    }));
  return { totalGroups: groups.length, newGroups: groups.filter(isNew).length, topProjects, largest };
}

function collectDedup(ctx) {
  const enabled = String(readClaudeMemSetting(ctx, 'CLAUDE_MEM_DEDUP_ENABLED') ?? '').trim().toLowerCase() === 'true';
  const hasTable = ctx.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('observation_dedup_candidates') !== undefined;
  if (!hasTable) return { enabled, byStatus: null };
  const byStatus = {};
  for (const r of ctx.db.prepare('SELECT status, count(*) AS n FROM observation_dedup_candidates GROUP BY status').all()) {
    byStatus[r.status ?? 'unknown'] = r.n;
  }
  return { enabled, byStatus };
}

export function collectHygiene(ctx) {
  return { empty: collectEmpty(ctx), duplicates: collectDuplicates(ctx), dedup: collectDedup(ctx) };
}
