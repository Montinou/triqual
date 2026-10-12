// Merge suggestions (repo-identity spec 5.4, Ruling A): names of one repository, the claude-mem command that would merge
// them, and the backup to take first. Printed only: nothing here runs bun, claude-mem or sqlite. Local only: the
// report prints a count, never a name, repository or path from here.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { allowRepoOf, requireRepos } from './policy.mjs';

const PLUGIN_ID = 'claude-mem@thedotmack';

export const NOTE_NO_INSTALL = 'The claude-mem merge command was not found (no claude-mem install in installed_plugins.json): names only.';
export const NOTE_NO_BUN = 'bun was not found: names only.';
export const NOTE_UNSAFE = 'No command for a name with leading or trailing whitespace, a leading "-" or a control or invisible character: claude-mem would change or drop it, or the terminal would not show it as written.';
export const NOTE_UNSAFE_PATH = 'No command: the bun path, the claude-mem install path, the database file or the state directory holds a control or invisible character.';
export const NOTE_STRANDED = "Stranded rows already point at another name of this repository: claude-mem's merge moves only exact-name unmerged rows, and its context lookup follows one merge level.";

const isText = (v) => typeof v === 'string' && v !== '';
const baseOf = (key) => key.split('/')[0];
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// POSIX single quoting: the whole argument in '…', every ' written as '\''.
export const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
// sqlite's double-quoted dot-command argument resolves backslash escapes; it has no '\'' form.
const sqliteDq = (value) => value.replace(/[\\"]/g, (c) => `\\${c}`);

// C0 and C1 control characters and DEL: a line break or an escape sequence would split or fake a printed line, and NUL
// cannot pass through an argument at all. Also (Ruling 15) the line and paragraph separators U+2028 and U+2029, and the
// bidi and invisible format characters U+061C, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069 and U+FEFF, which reorder or
// hide what the terminal shows. memory.mjs's `visible` escapes the same set.
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

// A name that cannot be printed into a command as written: leading or trailing whitespace or a leading `-` (claude-mem
// would change it or read it as an option), or a control or invisible character (CONTROL).
const unsafeName = (name) => name !== name.trim() || name.startsWith('-') || CONTROL.test(name);

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Every base name (the text before the first `/`) with the folders its keys used, worktree keys included.
export function foldersByBase(repos) {
  requireRepos(repos);
  const out = new Map();
  for (const [key, entry] of repos.keys) {
    if (!isText(key) || baseOf(key) === '') continue;
    const base = baseOf(key);
    if (!out.has(base)) out.set(base, new Set());
    for (const cwd of entry?.folders ?? []) out.get(base).add(cwd);
  }
  return out;
}

// Spec 5.4 groups: a repository that two or more base names resolve to, every folder of each name having that one
// repository and able to allow by repository. Per group: `into` (the member most rows already point at, else the one
// with the newest observation), `from` (other members with unmerged rows of exactly that name), `worktrees` (worktree
// keys of any member with unmerged rows) and `stranded` (rows pointing at a member other than `into`, or at one of their
// worktree keys: merges move only exact-name unmerged rows, so no printed command brings them in). A group with nothing
// to merge and nothing stranded is left out. Sorted by repository.
export function mergeGroups(ctx, repos) {
  return groupsOf(ctx, repos).groups;
}

// mergeGroups plus `cut`: the names as read whose stored value holds a NUL. Node 22's node:sqlite reads such a value
// cut at the NUL (`nul\0z` reads as `nul`), so a command naming it would merge a different project; they get none.
function groupsOf(ctx, repos) {
  const byRepo = new Map();
  for (const [base, cwds] of foldersByBase(repos)) {
    if (cwds.size === 0) continue;
    const repo = allowRepoOf(repos, [...cwds]);
    if (repo === null) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(base);
  }
  const candidates = [...byRepo].filter(([, members]) => members.length >= 2);
  if (candidates.length === 0) return { groups: [], cut: new Set() };
  const counts = ctx.db.prepare(
    `SELECT project, merged_into_project AS merged, count(*) AS n, max(created_at_epoch) AS newest,
       instr(project, char(0)) > 0 AS cutProject, instr(merged_into_project, char(0)) > 0 AS cutMerged
     FROM observations GROUP BY project, merged_into_project`,
  ).all();
  const cut = new Set();
  for (const r of counts) {
    if (r.cutProject === 1 && isText(r.project)) cut.add(r.project);
    if (r.cutMerged === 1 && isText(r.merged)) cut.add(r.merged);
  }

  const groups = [];
  for (const [repo, list] of candidates.sort((a, b) => byName(a[0], b[0]))) {
    const members = list.sort(byName);
    const isMember = (name) => isText(name) && members.includes(name);
    const targets = new Map();
    const newest = new Map();
    for (const r of counts) {
      if (isMember(r.merged)) targets.set(r.merged, (targets.get(r.merged) ?? 0) + r.n);
      if (isText(r.project) && isMember(baseOf(r.project)) && typeof r.newest === 'number') {
        const base = baseOf(r.project);
        newest.set(base, Math.max(newest.get(base) ?? -Infinity, r.newest));
      }
    }
    const age = (m) => newest.get(m) ?? -Infinity;
    const rank = (a, b) => (targets.get(b) ?? 0) - (targets.get(a) ?? 0) || age(b) - age(a) || byName(a, b);
    const into = [...members].sort(rank)[0];
    const unmerged = (name) => counts.some((r) => r.project === name && r.merged === null && r.n > 0);
    const from = members.filter((m) => m !== into && unmerged(m));
    const worktrees = [...new Set(counts
      .filter((r) => isText(r.project) && r.project.includes('/') && isMember(baseOf(r.project)) && r.merged === null && r.n > 0)
      .map((r) => r.project))].sort(byName);
    const stranded = counts
      .filter((r) => isText(r.merged) && r.merged !== into && isMember(baseOf(r.merged)))
      .reduce((sum, r) => sum + r.n, 0);
    if (from.length === 0 && worktrees.length === 0 && stranded === 0) continue;
    groups.push({ repo, into, from, worktrees, stranded });
  }
  return { groups, cut };
}

// bun, in bun-runner's order (Ruling A; fix 1 M5): each absolute PATH entry, then BUN, BUN_PATH, BUN_INSTALL/bin/bun,
// BUN_INSTALL/bun (the three variables trimmed), ~/.bun/bin/bun, /usr/local/bin/bun and Homebrew. `exists` is the test
// seam. Null when none exists.
export function findBun({ env = {}, home, exists = isFile } = {}) {
  const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
  const paths = [];
  for (const dir of String(env.PATH ?? '').split(':')) if (dir !== '' && isAbsolute(dir)) paths.push(join(dir, 'bun'));
  for (const value of [trimmed(env.BUN), trimmed(env.BUN_PATH)]) if (isText(value) && isAbsolute(value)) paths.push(value);
  const install = trimmed(env.BUN_INSTALL);
  if (isText(install) && isAbsolute(install)) paths.push(join(install, 'bin', 'bun'), join(install, 'bun'));
  if (isText(home)) paths.push(join(home, '.bun', 'bin', 'bun'));
  paths.push('/usr/local/bin/bun', '/opt/homebrew/bin/bun', '/home/linuxbrew/.linuxbrew/bin/bun');
  return paths.find((p) => exists(p)) ?? null;
}

// The claude-mem worker script: `<installPath>/scripts/worker-service.cjs` of the `user`-scope entry of
// claude-mem@thedotmack in installed_plugins.json, or of its first entry when there is no user entry. Null when the
// file, the entry or the script is missing.
function findWorker(pluginsFile, exists) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pluginsFile, 'utf8'));
  } catch {
    return null;
  }
  let entries = parsed?.plugins?.[PLUGIN_ID];
  if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) entries = [entries];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const entry = entries.find((e) => e?.scope === 'user') ?? entries[0];
  const installPath = entry?.installPath;
  if (!isText(installPath) || !isAbsolute(installPath)) return null;
  const worker = join(installPath, 'scripts', 'worker-service.cjs');
  return exists(worker) ? worker : null;
}

// Spec 5.4 with Ruling A: every group with its commands — one sqlite backup line, then the `--dry-run` commands, then
// the merges — or `commands: null` when bun or the install is not found or no name can be passed safely; `note` holds
// the fixed notes that apply, or null. `pluginsFile` defaults to <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/
// installed_plugins.json, `env` (for CLAUDE_CONFIG_DIR and the bun lookup) to {}, `nowIso` (the backup's timestamp)
// to ctx.now(); `exists` is the test seam for both lookups.
export function mergeSuggestions(ctx, repos, { pluginsFile, env = {}, nowIso, exists = isFile } = {}) {
  const { groups, cut } = groupsOf(ctx, repos);
  if (groups.length === 0) return [];
  const refused = (name) => unsafeName(name) || cut.has(name);
  const home = ctx.paths.home;
  const configDir = isText(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  const worker = findWorker(pluginsFile ?? join(configDir, 'plugins', 'installed_plugins.json'), exists);
  const bun = findBun({ env, home, exists });
  const stamp = (nowIso ?? new Date(ctx.now()).toISOString()).replace(/[:.]/g, '-');
  const backupPath = join(ctx.paths.stateDir, `claude-mem-backup-${stamp}.db`);
  const backup = `sqlite3 ${shellQuote(ctx.paths.dbFile)} ${shellQuote(`.backup "${sqliteDq(backupPath)}"`)}`;
  // fix 1 I1: a control character in any path of the command lines withholds every command.
  const unsafePath = [bun, worker, ctx.paths.dbFile, backupPath].some((p) => typeof p === 'string' && CONTROL.test(p));

  return groups.map((group) => {
    const names = [...group.from, ...group.worktrees];
    const unsafe = [group.into, ...names].some(refused);
    const notes = [];
    if (worker === null) notes.push(NOTE_NO_INSTALL);
    if (bun === null) notes.push(NOTE_NO_BUN);
    if (unsafePath) notes.push(NOTE_UNSAFE_PATH);
    if (unsafe) notes.push(NOTE_UNSAFE);
    if (group.stranded > 0) notes.push(NOTE_STRANDED);
    let commands = null;
    const safe = refused(group.into) ? [] : names.filter((n) => !refused(n));
    if (worker !== null && bun !== null && !unsafePath && safe.length > 0) {
      const merge = (from) => `${shellQuote(bun)} ${shellQuote(worker)} project merge ${shellQuote(from)} ${shellQuote(group.into)}`;
      commands = { backup, dryRun: safe.map((n) => `${merge(n)} --dry-run`), run: safe.map(merge) };
    }
    return { ...group, commands, note: notes.length > 0 ? notes.join(' ') : null };
  });
}
