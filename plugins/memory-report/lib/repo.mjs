// Repository identity (repo-identity spec 2): normalizes git remotes and resolves a folder's repository status through
// async `stat`, `git` and `ssh -G` children, and keeps the folder-keyed repo-map.json (spec 3). Folder and repository
// paths stay local: nothing here logs or prints them.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalRepo } from './entries.mjs';
import { appendLog, ensureDir, readJson, writeAtomic } from './files.mjs';

export const CHILD_TIMEOUT_MS = 3000;

// The child environment: the base env minus every GIT_* variable (so no GIT_DIR, GIT_CONFIG_* or similar can redirect
// git), plus LC_ALL=C so the messages matched below are the untranslated ones.
export function childEnv(envBase = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(envBase)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.LC_ALL = 'C';
  return env;
}

// The real child runner: run(cmd, args, { timeoutMs }) → Promise<{ code, stdout, stderr, timedOut }>. Never rejects.
// stdin is closed; a child still running at `timeoutMs` gets SIGKILL, its stdio is destroyed and the promise resolves
// without waiting for `close`; the child is unref()ed so a stuck one cannot keep the process alive. A child that cannot
// start resolves with a null code.
export function defaultRun({ envBase = process.env } = {}) {
  const env = childEnv(envBase);
  return (cmd, args, { timeoutMs = CHILD_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let child = null;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null, false);
      return;
    }
    child.on('error', () => finish(null, false));
    child.on('close', (code) => finish(code, false));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      for (const stream of [child.stdout, child.stderr]) {
        try { stream.destroy(); } catch { /* already closed */ }
      }
      finish(null, true);
    }, timeoutMs);
    child.unref();
  });
}

// The hosts handed to `ssh -G`: a plain host name (letters, digits, `.`, `_`, `-`) or a bracketed IPv6 address.
const SSH_HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/;

// The real sshHost: the `hostname` line of `ssh -G <host>` (local config only, no network), or null on any failure.
// A host starting with `-` (ssh would read it as an option) or outside SSH_HOST is refused without running anything.
export function defaultSshHost({ run = defaultRun() } = {}) {
  return async (host) => {
    if (typeof host !== 'string' || host.startsWith('-') || !SSH_HOST.test(host)) return null;
    const r = await run('ssh', ['-G', host], { timeoutMs: CHILD_TIMEOUT_MS });
    if (r.timedOut || r.code !== 0) return null;
    const m = /^hostname[ \t]+(\S+)[ \t]*$/m.exec(r.stdout);
    return m ? m[1] : null;
  };
}

const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
// git's scp-like syntax: an optional `user@`, a host without `/` or `:`, then `:` and the path. Local paths have a `/`
// before any `:` and never match.
const SCP_FORM = /^(?:[^@/:\s]+@)?([^@/:\s]+):(.*)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// `?`, `#` and `\` never belong in a usable remote, and git or curl may split the URL differently from this parser
// around them (`https://evil.example#@github.com/acme/app` is host `evil.example` to curl): such a URL is null.
const AMBIGUOUS = /[?#\\]/;

// Normalizes a git remote URL to `host/path`, lower-cased (spec 2). { repo, sshFailed }: `repo` is null when the URL
// is not a usable remote; `sshFailed` is true when the URL uses SSH transport and its host could not be resolved
// through sshHost (a rejection, a null answer, or a host starting with `-`), which makes the folder `unknown`.
// `cache` (a Map) keeps one sshHost answer per host; callers share one per run of related URLs.
export async function normalizeRemote(url, { sshHost, cache = new Map() } = {}) {
  const none = { repo: null, sshFailed: false };
  if (typeof url !== 'string') return none;
  const u = url.trim();
  if (u === '' || CONTROL.test(u) || AMBIGUOUS.test(u)) return none;
  let host;
  let path;
  let ssh;
  const m = URL_FORM.exec(u);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (!['https', 'http', 'git', 'ssh'].includes(scheme)) return none;
    const slash = m[2].indexOf('/');
    if (slash < 0) return none;
    const authority = m[2].slice(0, slash);
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
    path = m[2].slice(slash + 1);
    ssh = scheme === 'ssh';
  } else {
    const s = SCP_FORM.exec(u);
    if (!s) return none;
    [, host, path] = s;
    ssh = true;
  }
  if (host === '') return none;
  if (ssh) {
    if (host.startsWith('-')) return { repo: null, sshFailed: true };
    if (!cache.has(host)) cache.set(host, Promise.resolve().then(() => sshHost(host)).catch(() => null));
    const resolved = await cache.get(host);
    if (typeof resolved !== 'string' || resolved === '') return { repo: null, sshFailed: true };
    host = resolved;
  }
  const segs = path.replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\/+$/, '').toLowerCase().split('/');
  return { repo: canonicalRepo(host.toLowerCase(), segs[0] === '' ? [] : segs), sshFailed: false };
}

const lastLine = (text) => text.trim().split('\n').pop() ?? '';
const firstFatal = (text) => text.split('\n').find((line) => line.startsWith('fatal:')) ?? '';

// Parses `git remote -v`: [{ name, url }], or null when a non-empty line does not have the expected shape (the folder
// is then `unknown`).
function parseRemotes(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // A partial clone's promisor remote carries its filter after the fetch line: `(fetch) [blob:none]`.
    const m = /^([^\t]+)\t(.*) \((?:fetch|push)\)(?: \[[^\]]*\])?$/.exec(line);
    if (!m) return null;
    out.push({ name: m[1], url: m[2] });
  }
  return out;
}

// Resolves one folder (spec 2 `resolveFolder`): { status, origin, remotes, unresolvedRemote }.
// - status is `missing` only on stat's "No such file or directory"; any other stat error, a timeout or a relative
//   path is `unknown`.
// - `git rev-parse --show-toplevel`: "not a git repository" is `nogit`; any other failure or a timeout is `unknown`;
//   a top level equal to realpath(cwd) is `root`, else `nested`.
// - For `root` and `nested`: `origin` is the normalized `remote get-url origin` (null when there is none or it
//   normalizes to null), `remotes` the sorted set of normalized URLs of every remote (origin included), and
//   `unresolvedRemote` is true when a non-origin remote URL normalizes to null.
// - An SSH host that ssh -G cannot resolve, for any remote, makes the folder `unknown`. An `unknown` folder carries no
//   origin or remotes, so a partial set never reaches the map as if it were complete.
// `cache` is normalizeRemote's per-host sshHost cache; resolveRepos passes one per run so `ssh -G` runs once per host.
export async function resolveFolder(cwd, { run = defaultRun(), sshHost, cache = new Map() } = {}) {
  const ssh = sshHost ?? defaultSshHost({ run });
  const base = { origin: null, remotes: [], unresolvedRemote: false };
  const unknown = { status: 'unknown', ...base };
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return unknown;
  const opts = { timeoutMs: CHILD_TIMEOUT_MS };

  const st = await run('stat', [cwd], opts);
  if (st.timedOut) return unknown;
  if (st.code !== 0) return lastLine(st.stderr).endsWith('No such file or directory') ? { status: 'missing', ...base } : unknown;

  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], opts);
  if (top.timedOut) return unknown;
  if (top.code !== 0) return firstFatal(top.stderr).startsWith('fatal: not a git repository') ? { status: 'nogit', ...base } : unknown;
  let real;
  try {
    real = await realpath(cwd);
  } catch {
    return unknown;
  }
  const status = top.stdout.replace(/\r?\n$/, '') === real ? 'root' : 'nested';

  const og = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], opts);
  if (og.timedOut) return unknown;
  let originUrl = null;
  if (og.code === 0) originUrl = og.stdout.trim();
  else if (!/No such remote/.test(og.stderr)) return unknown;

  const rv = await run('git', ['-C', cwd, 'remote', '-v'], opts);
  if (rv.timedOut || rv.code !== 0) return unknown;
  const listed = parseRemotes(rv.stdout);
  if (listed === null) return unknown;

  const norm = (url) => normalizeRemote(url, { sshHost: ssh, cache });
  let origin = null;
  if (originUrl !== null) {
    const r = await norm(originUrl);
    if (r.sshFailed) return unknown;
    origin = r.repo;
  }
  const remotes = new Set(origin ? [origin] : []);
  let unresolvedRemote = false;
  for (const { name, url } of listed) {
    const r = await norm(url);
    if (r.sshFailed) return unknown;
    if (r.repo !== null) remotes.add(r.repo);
    else if (!(name === 'origin' && url === originUrl)) unresolvedRemote = true;
  }
  return { status, origin, remotes: [...remotes].sort(), unresolvedRemote };
}

// ---- the folder-keyed map and resolveRepos (spec 2 `resolveRepos`, spec 3) -------------------------------------------

export const REPO_BUDGET_MS = 10000;
export const REPO_CONCURRENCY = 4;
const MAP_VERSION = 2;
const FLAGS = ['everNested', 'everUnresolvedRemote', 'everNoOrigin'];

const repoMapFile = (paths) => join(paths.stateDir, 'repo-map.json');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const newMap = (rebuiltAt = null) => ({ v: MAP_VERSION, rebuiltAt, folders: {} });
const newFolder = () => ({ repos: [], everNested: false, everUnresolvedRemote: false, everNoOrigin: false });
const laterIso = (a, b) => (a === null ? b : b === null ? a : Date.parse(b) > Date.parse(a) ? b : a);

// The resolution with nothing resolved: no folders, no keys, complete, not rebuilt. A factory, so callers never share a
// mutable value.
export function emptyRepos() {
  return { folders: new Map(), keys: new Map(), complete: true, rebuilt: false, error: null };
}

// The map exactly as saveRepoMap writes it, or null. Anything else (another version, a missing flag, a relative folder
// key, a malformed repo entry) is not a map: a lenient read could turn a missing flag into `false` and widen an allow.
function parseMap(value) {
  if (!isPlainObject(value) || value.v !== MAP_VERSION || !isPlainObject(value.folders)) return null;
  if (!(value.rebuiltAt === null || isIso(value.rebuiltAt))) return null;
  const map = newMap(value.rebuiltAt);
  for (const [cwd, f] of Object.entries(value.folders)) {
    if (!isAbsolute(cwd) || !isPlainObject(f) || !Array.isArray(f.repos)) return null;
    if (!FLAGS.every((flag) => typeof f[flag] === 'boolean')) return null;
    if (!f.repos.every((r) => isPlainObject(r) && typeof r.repo === 'string' && r.repo !== '' && isIso(r.seenAt))) return null;
    const entry = newFolder();
    for (const flag of FLAGS) entry[flag] = f[flag];
    for (const r of f.repos) addRepo(entry, r.repo, r.seenAt);
    map.folders[cwd] = entry;
  }
  return map;
}

// { status: 'ok', map } | { status: 'absent' } | { status: 'bad' } (unreadable, unparsable or not a map).
function readMapFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { status: 'absent' } : { status: 'bad' };
  }
  let map = null;
  try {
    map = parseMap(JSON.parse(text));
  } catch { /* unparsable */ }
  return map === null ? { status: 'bad' } : { status: 'ok', map };
}

// The map on disk as saveRepoMap wrote it, or null when it is absent, unreadable or not a map. Read-only: nothing is set
// aside or logged (`triqual memory repos` reads the seenAt dates after resolveRepos saved the map).
export function readRepoMap(paths) {
  const read = readMapFile(repoMapFile(paths));
  return read.status === 'ok' ? read.map : null;
}

// A repository seen again keeps the later seenAt.
function addRepo(entry, repo, seenAt) {
  const known = entry.repos.find((r) => r.repo === repo);
  if (known === undefined) entry.repos.push({ repo, seenAt });
  else known.seenAt = laterIso(known.seenAt, seenAt);
}

// The union of two maps: every folder and every repository of both, the later seenAt per repository, the flags ORed,
// the later rebuiltAt. Never removes anything.
function unionMaps(a, b) {
  const out = newMap(laterIso(a.rebuiltAt ?? null, b.rebuiltAt ?? null));
  for (const src of [a, b]) {
    for (const [cwd, f] of Object.entries(src.folders)) {
      if (!Object.hasOwn(out.folders, cwd)) out.folders[cwd] = newFolder();
      const entry = out.folders[cwd];
      for (const r of f.repos) addRepo(entry, r.repo, r.seenAt);
      for (const flag of FLAGS) entry[flag] = entry[flag] || f[flag] === true;
    }
  }
  const folders = {};
  for (const cwd of Object.keys(out.folders).sort()) {
    const entry = out.folders[cwd];
    entry.repos.sort((x, y) => (x.repo < y.repo ? -1 : x.repo > y.repo ? 1 : 0));
    folders[cwd] = entry;
  }
  out.folders = folders;
  return out;
}

// The previous success as the map rule sees it: { recorded, ms }. A state.json that exists but cannot be parsed, or a
// lastSuccessAt that is not a date, counts as a success at an unknown time (ms NaN): it can only make the map rebuilt.
function previousSuccess(paths) {
  if (!existsSync(paths.stateFile)) return { recorded: false, ms: NaN };
  const state = readJson(paths.stateFile);
  if (!isPlainObject(state)) return { recorded: true, ms: NaN };
  if (state.lastSuccessAt === undefined || state.lastSuccessAt === null) return { recorded: false, ms: NaN };
  return { recorded: true, ms: typeof state.lastSuccessAt === 'string' ? Date.parse(state.lastSuccessAt) : NaN };
}

// Spec 3 and the Global Constraints: the map counts as rebuilt while `rebuiltAt` is set and the last success is absent
// (or unreadable) or earlier, so a setup or `triqual memory repos` run cannot use up the signal before a report sees it.
function isRebuilt(rebuiltAt, success) {
  if (rebuiltAt === null) return false;
  return !success.recorded || Number.isNaN(success.ms) || success.ms < Date.parse(rebuiltAt);
}

// The rebuiltAt a rebuild stamps: now, or 1 ms after the last success when that is not earlier (the clock moved back),
// so the rule above reads the map as rebuilt. After a backward clock jump that lasts until the wall clock passes the
// old stamp, not just until the next success: a success stamped before rebuiltAt does not end it. It fails closed.
function rebuildStamp(now, success) {
  const ms = Number.isFinite(success.ms) ? Math.max(now(), success.ms + 1) : now();
  return new Date(ms).toISOString();
}

// Sets a bad map file aside as `repo-map.json.bad-<timestamp>`, with one fixed run.log line.
function setAside(paths, file, stamp) {
  try {
    renameSync(file, `${file}.bad-${stamp.replace(/[:.]/g, '-')}`);
  } catch { /* another run set it aside first; the save replaces whatever is left */ }
  appendLog(paths, 'repo-map-rebuilt', 'corrupt');
}

// Loads <stateDir>/repo-map.json: { map, rebuilt }. A corrupt, unreadable or wrong-version file is set aside and the
// map starts again with `rebuiltAt` stamped; so does an absent file while state.json records a previous success. Both
// are `rebuilt: true`. A first run (absent, no success) is an empty map that is not rebuilt. The run.log line carries a
// fixed reason only.
export function loadRepoMap(paths, { now = Date.now } = {}) {
  const file = repoMapFile(paths);
  const read = readMapFile(file);
  const success = previousSuccess(paths);
  if (read.status === 'ok') return { map: read.map, rebuilt: isRebuilt(read.map.rebuiltAt, success) };
  if (read.status === 'bad') {
    const stamp = rebuildStamp(now, success);
    setAside(paths, file, stamp);
    return { map: newMap(stamp), rebuilt: true };
  }
  if (success.recorded) {
    appendLog(paths, 'repo-map-rebuilt', 'absent');
    return { map: newMap(rebuildStamp(now, success)), rebuilt: true };
  }
  return { map: newMap(), rebuilt: false };
}

// Writes the map atomically with mode 0600, always (an empty map too). The file on disk is read again and unioned
// with `map` right before the write; with no lock this narrows, but does not close, the window in which a concurrent
// writer's folders, repositories, flags or rebuiltAt could be lost. A file that went bad or cannot be read at this
// point is set aside and the written map gets a fresh rebuiltAt, so the next load reads it as rebuilt.
// Returns the map as written.
export function saveRepoMap(paths, map, { now = Date.now } = {}) {
  ensureDir(paths.stateDir);
  const file = repoMapFile(paths);
  const disk = readMapFile(file);
  let base = disk.status === 'ok' ? disk.map : newMap();
  if (disk.status === 'bad') {
    const stamp = rebuildStamp(now, previousSuccess(paths));
    setAside(paths, file, stamp);
    base = newMap(stamp);
  }
  const merged = unionMaps(base, map);
  writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

const unknownFolder = () => ({ status: 'unknown', origin: null, remotes: [], unresolvedRemote: false });
const EXPIRED = Symbol('expired');

const TIMED_OUT = () => ({ code: null, stdout: '', stderr: '', timedOut: true });

// Resolves every folder, at most REPO_CONCURRENCY at once, within one total budget: a folder still running when the
// budget ends, or not started by then, is `unknown`. A resolver that throws gives `unknown` too. `clock.expired` turns
// true when the budget ends (and when this returns), so the caller's gated run stops spawning. Returns Map<cwd, result>.
async function resolveAll(cwds, resolveOne, budgetMs, clock) {
  const results = new Map();
  clock.expired = !(budgetMs > 0);
  let timer = null;
  const deadline = new Promise((resolve) => {
    if (clock.expired) return;
    timer = setTimeout(() => {
      clock.expired = true;
      resolve(EXPIRED);
    }, budgetMs);
  });
  const queue = [...cwds];
  const worker = async () => {
    while (queue.length > 0) {
      const cwd = queue.shift();
      if (clock.expired) {
        results.set(cwd, unknownFolder());
        continue;
      }
      const r = await Promise.race([Promise.resolve().then(() => resolveOne(cwd)).catch(() => unknownFolder()), deadline]);
      results.set(cwd, r === EXPIRED ? unknownFolder() : r);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, queue.length) }, worker));
  } finally {
    clock.expired = true;
    clearTimeout(timer);
  }
  return results;
}

// A memory_session_id held by sessions with more than one distinct folder (an empty or null one counts as one). claude-mem
// keeps the id UNIQUE; should a database not, such a note's folder is unknown (final fix insurance).
const AMBIGUOUS_SESSION = `SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id IS NOT NULL
  GROUP BY memory_session_id HAVING MIN(COALESCE(cwd, '')) <> MAX(COALESCE(cwd, ''))`;

// Every distinct non-empty sdk_sessions.cwd with the keys that used it: the session's project plus the project and
// merged_into_project of every note in a session with that folder. { cwds: sorted [cwd], pairs: [{ cwd, key }],
// ambiguous: Set<key> }: `ambiguous` holds the project and merge target of every note whose session id has more than
// one folder (AMBIGUOUS_SESSION); resolveRepos marks those keys unknown.
function readFolderKeys(db) {
  const rows = db.prepare(
    `SELECT cwd, project AS key FROM sdk_sessions WHERE cwd IS NOT NULL AND cwd <> ''
     UNION
     SELECT s.cwd, o.project FROM observations o JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
     WHERE s.cwd IS NOT NULL AND s.cwd <> ''
     UNION
     SELECT s.cwd, o.merged_into_project FROM observations o JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
     WHERE s.cwd IS NOT NULL AND s.cwd <> ''`,
  ).all();
  const cwds = new Set();
  const pairs = [];
  for (const { cwd, key } of rows) {
    if (typeof cwd !== 'string' || cwd === '') continue;
    cwds.add(cwd);
    if (typeof key === 'string' && key !== '') pairs.push({ cwd, key });
  }
  const ambiguous = new Set();
  const notes = db.prepare(`SELECT project, merged_into_project AS merged FROM observations WHERE memory_session_id IN (${AMBIGUOUS_SESSION})`).all();
  for (const { project, merged } of notes) {
    for (const key of [project, merged]) if (typeof key === 'string' && key !== '') ambiguous.add(key);
  }
  return { cwds: [...cwds].sort(), pairs, ambiguous };
}

// Spec 2 `resolveRepos`: resolves every recorded folder, merges this run into the map and persists it (always), and
// returns { folders, keys, complete, rebuilt, error: null }.
// - folders: Map<cwd, { status, origin, remotes, unresolvedRemote, stored: Set<repo>, everNested, everUnresolvedRemote,
//   everNoOrigin }>: this run's resolution plus everything the map ever recorded for the folder, flags included.
// - keys: Map<key, { repos: Set<repo>, unknown, folders: Set<cwd> }>: every repository ever recorded for any folder the
//   key used; `unknown` when any of those folders is `unknown` this run, or when a note of the key has a session id
//   with more than one folder (readFolderKeys). Worktree bases are joined by keyEvidence.
// - complete is false when any folder is `unknown`; rebuilt follows the map rule (loadRepoMap).
// One sshHost cache serves the whole run. A database or map failure throws: the caller fails closed.
export async function resolveRepos(ctx, { budgetMs = REPO_BUDGET_MS, run = defaultRun(), sshHost } = {}) {
  // Once the budget ends, a folder still resolving gets a timed-out answer for every further command, without a spawn.
  const clock = { expired: false };
  const gated = (cmd, args, opts) => (clock.expired ? Promise.resolve(TIMED_OUT()) : run(cmd, args, opts));
  const ssh = sshHost ?? defaultSshHost({ run: gated });
  const now = ctx.now ?? Date.now;
  const { cwds, pairs, ambiguous } = readFolderKeys(ctx.db);
  const loaded = loadRepoMap(ctx.paths, { now });
  const cache = new Map();
  const results = await resolveAll(cwds, (cwd) => resolveFolder(cwd, { run: gated, sshHost: ssh, cache }), budgetMs, clock);

  const seenAt = new Date(now()).toISOString();
  const update = newMap(loaded.map.rebuiltAt);
  for (const [cwd, r] of results) {
    if (r.status !== 'root' && r.status !== 'nested') continue;
    const entry = newFolder();
    for (const repo of new Set([...(r.origin ? [r.origin] : []), ...r.remotes])) addRepo(entry, repo, seenAt);
    entry.everNested = r.status === 'nested';
    entry.everUnresolvedRemote = r.unresolvedRemote === true;
    entry.everNoOrigin = r.origin === null;
    update.folders[cwd] = entry;
  }
  const map = saveRepoMap(ctx.paths, unionMaps(loaded.map, update), { now });

  const folders = new Map();
  for (const cwd of cwds) {
    const r = results.get(cwd);
    const known = Object.hasOwn(map.folders, cwd) ? map.folders[cwd] : newFolder();
    folders.set(cwd, {
      status: r.status,
      origin: r.origin,
      remotes: r.remotes,
      unresolvedRemote: r.unresolvedRemote,
      stored: new Set(known.repos.map((x) => x.repo)),
      everNested: known.everNested,
      everUnresolvedRemote: known.everUnresolvedRemote,
      everNoOrigin: known.everNoOrigin,
    });
  }
  const keys = new Map();
  for (const { cwd, key } of pairs) {
    if (!keys.has(key)) keys.set(key, { repos: new Set(), unknown: false, folders: new Set() });
    const entry = keys.get(key);
    const f = folders.get(cwd);
    entry.folders.add(cwd);
    for (const repo of [...f.stored, ...f.remotes, ...(f.origin ? [f.origin] : [])]) entry.repos.add(repo);
    if (f.status === 'unknown') entry.unknown = true;
  }
  for (const key of ambiguous) {
    if (!keys.has(key)) keys.set(key, { repos: new Set(), unknown: false, folders: new Set() });
    keys.get(key).unknown = true;
  }
  return {
    folders,
    keys,
    complete: [...folders.values()].every((f) => f.status !== 'unknown'),
    rebuilt: loaded.rebuilt || isRebuilt(map.rebuiltAt, previousSuccess(ctx.paths)),
    error: null,
  };
}

// The blocking evidence of `key`: the union of its own entry and its worktree base's (`base/…` → `base`), as fresh
// sets; an empty entry when neither exists.
export function keyEvidence(repos, key) {
  const out = { repos: new Set(), unknown: false, folders: new Set() };
  if (typeof key !== 'string' || key === '') return out;
  const names = [key];
  const slash = key.indexOf('/');
  if (slash > 0) names.push(key.slice(0, slash));
  for (const name of names) {
    const entry = repos?.keys?.get(name);
    if (entry === undefined) continue;
    for (const repo of entry.repos) out.repos.add(repo);
    for (const cwd of entry.folders) out.folders.add(cwd);
    if (entry.unknown === true) out.unknown = true;
  }
  return out;
}
