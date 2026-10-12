// Candidate projects for the allowlist (local-setup spec 2.6, repo-identity spec 5.1): read-only over claude-mem.db, from
// observations grouped by base project and counted per note. Only counts, names, folders, repositories and owners leave
// this module: never a title, narrative or fact.
import { basename, join } from 'node:path';
import { classifyEntry, normalizeEntrySync } from './entries.mjs';
import { foldersByBase, mergeGroups, mergeSuggestions } from './merges.mjs';
import { allowRepoOf, allowingOrigins, folderStatus, isBlocked, isCovered, requireRepos } from './policy.mjs';

const DAY_MS = 86400000;
const CANDIDATE_LIMIT = 40;

const isText = (v) => typeof v === 'string' && v !== '';

// The text before the first "/" of a project key (a worktree key `a/b` belongs to `a`).
const baseOf = (key) => key.split('/')[0];

const trimSlash = (path) => (path.length > 1 ? path.replace(/\/+$/, '') || '/' : path);

const expandHome = (root, home) => (root === '~' ? home : root.startsWith('~/') ? join(home, root.slice(2)) : root);

const under = (cwd, root) => {
  const dir = trimSlash(cwd);
  const base = trimSlash(root);
  return dir === base || dir.startsWith(base.endsWith('/') ? base : `${base}/`);
};

const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

// Most recent non-empty cwd per base project (sdk_sessions.project reduced to its base).
function latestCwds(db) {
  if (!columnsOf(db, 'sdk_sessions').has('cwd')) return new Map();
  const rows = db.prepare(
    `SELECT project, cwd FROM sdk_sessions
     WHERE project IS NOT NULL AND project <> '' AND cwd IS NOT NULL AND cwd <> ''
     ORDER BY started_at_epoch DESC, id DESC`,
  ).all();
  const byBase = new Map();
  for (const r of rows) {
    const base = baseOf(r.project);
    if (base === '') continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r.cwd);
  }
  return byBase; // each list is newest first
}

// The window's notes, subagent rows excluded, each with the folder of its own session (null when it has none, or when
// the database cannot link notes to sessions): [{ project, merged_into_project, cwd }].
function windowNotes(db, startMs, endMs) {
  const sessions = columnsOf(db, 'sdk_sessions');
  const joined = sessions.has('cwd') && sessions.has('memory_session_id') && columnsOf(db, 'observations').has('memory_session_id');
  const from = joined
    ? "NULLIF(s.cwd, '') AS cwd FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"
    : 'NULL AS cwd FROM observations o';
  return db.prepare(
    `SELECT o.project AS project, NULLIF(o.merged_into_project, '') AS merged_into_project, ${from}
     WHERE o.created_at_epoch >= ? AND o.created_at_epoch < ? AND o.agent_id IS NULL`,
  ).all(startMs, endMs);
}

// The owner entry of a repository: its host and first path segment, `host/owner/*` (Ruling 1: it covers subgroups).
const ownerOf = (repo) => {
  const [host, owner] = repo.split('/');
  return `${host}/${owner}/*`;
};

// Owners on either list (stored owner entries, normalized and lower-cased).
function listedOwners(config) {
  const out = new Set();
  for (const list of [config.allowlist, config.neverSend]) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (classifyEntry(entry) === 'owner') out.add(normalizeEntrySync(entry));
    }
  }
  return out;
}

// Spec 5.1 `owners`: one per owner of the origin of a folder that could allow by repository (`root` now with an origin,
// or `missing` with stored repositories), with the number of base projects that used its folders and the window's notes
// written in them; owners already on either list are left out; most notes first, then by owner.
function ownerGroups(repos, config, notes, bases) {
  const folders = new Map();
  for (const cwd of repos.folders.keys()) {
    for (const repo of allowingOrigins(repos, cwd)) {
      const owner = ownerOf(repo);
      if (!folders.has(owner)) folders.set(owner, new Set());
      folders.get(owner).add(cwd);
    }
  }
  const listed = listedOwners(config);
  const out = [];
  for (const [owner, cwds] of folders) {
    if (listed.has(owner)) continue;
    const projects = [...bases].filter(([, used]) => [...used].some((cwd) => cwds.has(cwd))).length;
    const count = notes.filter((n) => n.cwd !== null && cwds.has(n.cwd)).length;
    out.push({ owner, projects, notes: count });
  }
  return out.sort((a, b) => b.notes - a.notes || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
}

// Spec 5.1 `repos`: over the base projects with a recorded folder, how many have every folder resolved (none
// `unknown`); how many of the listed candidates have a repository (`candidates[].repo` not null, fix 1 M1); and whether
// the resolution was complete.
function repoCounts(repos, bases, candidates) {
  let withCwd = 0;
  let resolved = 0;
  for (const cwds of bases.values()) {
    if (cwds.size === 0) continue;
    withCwd += 1;
    if ([...cwds].every((cwd) => folderStatus(repos, cwd) !== 'unknown')) resolved += 1;
  }
  const unambiguous = candidates.filter((c) => c.repo !== null).length;
  return { resolved, withCwd, unambiguous, complete: repos.complete === true };
}

// Observations of the last `days` days (half-open [now - days, now)), subagent rows excluded, each counted once under the
// base of COALESCE(merged_into_project, project), and per note: `isCovered` (spec 4.2) splits a base's notes into those
// that would not be sent (`notes`) and those already sent (`coveredNotes`). A candidate is a base that is not blocked and
// has a note that would not be sent; `repo` is the single repository all of its folders would allow by and `owner` that
// repository's owner entry, else null. `commands` are mergeSuggestions' options; null gives the merge groups without
// commands. Returns { candidates, homeProject, owners, merges, repos } (spec 5.1). The resolution `ctx.repos` is required.
export function suggestCandidates(ctx, { days, commands = {} }) {
  const { config } = ctx;
  const repos = ctx.repos;
  requireRepos(repos);
  const endMs = ctx.now();
  const startMs = endMs - days * DAY_MS;
  const notes = windowNotes(ctx.db, startMs, endMs);

  const counts = new Map();
  for (const note of notes) {
    const key = isText(note.merged_into_project) ? note.merged_into_project : note.project;
    if (!isText(key)) continue;
    const base = baseOf(key);
    if (base === '') continue;
    const c = counts.get(base) ?? { notes: 0, coveredNotes: 0 };
    if (isCovered(note, config, repos)) c.coveredNotes += 1;
    else c.notes += 1;
    counts.set(base, c);
  }

  const homeName = basename(ctx.paths.home);
  const homeProject = counts.has(homeName) ? homeName : null;

  const roots = (config.suggestRoots ?? []).filter(isText).map((r) => expandHome(r, ctx.paths.home));
  const cwds = latestCwds(ctx.db);
  const bases = foldersByBase(repos);

  const candidates = [];
  for (const [project, c] of counts) {
    if (c.notes === 0 || isBlocked(project, null, config, repos)) continue;
    const dirs = cwds.get(project) ?? [];
    if (roots.length > 0 && !dirs.some((cwd) => roots.some((root) => under(cwd, root)))) continue;
    const repo = allowRepoOf(repos, [...(bases.get(project) ?? [])]);
    candidates.push({ project, notes: c.notes, coveredNotes: c.coveredNotes, cwd: dirs[0] ?? null, repo, owner: repo === null ? null : ownerOf(repo) });
  }
  candidates.sort((a, b) => b.notes - a.notes || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  const listed = candidates.slice(0, CANDIDATE_LIMIT);
  return {
    candidates: listed,
    homeProject,
    owners: ownerGroups(repos, config, notes, bases),
    merges: commands === null ? mergeGroups(ctx, repos) : mergeSuggestions(ctx, repos, commands),
    repos: repoCounts(repos, bases, listed),
  };
}
