// The bounded git tree check (spec, "Built-in self-protection", git tree updates). This is the only
// process fence ever spawns, and the normalizer never calls it directly: it reaches it through the
// injected ctx.gitTreeDiff capability.
//
//   gitTreeDiff(repo, target, subpaths, {gitPath, gitVersion, deadlineMs, spawn, env})
//     -> string[] (paths relative to the repository root) | UNKNOWN
//
// argv (exactly; a snapshot test pins it):
//   gitPath -c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.allow=never
//           -c protocol.<p>.allow=never  (p = file ssh git http https ext)
//           -C <repo.root> diff --name-only --no-renames --no-ext-diff --no-textconv HEAD <target> -- <subpaths…>
// For a stash entry (target = {stash: 'stash@{N}'}) the separate documented form is
//   gitPath <same -c options> -C <repo.root> stash show --name-only --no-renames --no-ext-diff
//           --no-textconv --include-untracked <stash@{N}>
// whose output is filtered here to the protected repo subpaths (`stash show` takes no pathspec).
// env (exactly): {PATH, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
// GIT_NO_LAZY_FETCH: '1'}; PATH and HOME from opts.env, else process.env at the call.
//
// NOT_A_REVISION when git ran to completion and exited non-zero with its unknown-revision,
// bad-revision or ambiguous-argument message (the default spawn pipes stderr for this only).
// UNKNOWN for: a gitPath that is not absolute (no PATH lookup of git), a git older than
// GIT_MIN_VERSION or no version given (older git ignores GIT_NO_LAZY_FETCH), a target that is not a
// plain revision word (option-shaped, empty, a NUL or newline in it), a spawn error, a timeout, a
// signal, a non-zero exit, output over MAX_OUTPUT. The default spawn is spawnSync of the absolute
// gitPath with no shell, stdin and stderr ignored, `timeout: deadlineMs` and `maxBuffer: MAX_OUTPUT`.
// A C-quoted output line (core.quotePath) is reported as UNKNOWN in the list. Never throws.

import { spawnSync } from 'node:child_process';

import { UNKNOWN } from '../norm/unknown.mjs';
import { PROJECT_SUBGLOBS } from '../eval/builtin.mjs';
import { compileGlob } from '../match/glob.mjs';

export const GIT_MIN_VERSION = '2.45.1';
export const DEFAULT_DEADLINE_MS = 2000;
export const MAX_OUTPUT = 1024 * 1024;
// git ran to completion and said the target is not a revision (unknown revision, bad revision,
// ambiguous argument): distinct from UNKNOWN, which is every other failure.
export const NOT_A_REVISION = Object.freeze({ notARevision: true });

const NO_PROTOCOLS = ['file', 'ssh', 'git', 'http', 'https', 'ext'];
const HARDENING = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.allow=never',
  ...NO_PROTOCOLS.flatMap((p) => ['-c', `protocol.${p}.allow=never`]),
];
const DIFF_FLAGS = ['--name-only', '--no-renames', '--no-ext-diff', '--no-textconv'];
const STASH_REF = /^stash@\{[0-9]{1,6}\}$/;
// git's messages for a word that does not name a revision (diff exits 128 with one of them)
const NOT_REVISION_MSG = /unknown revision|bad revision|ambiguous argument/;
const SUBPATH_RES = PROJECT_SUBGLOBS.map((g) => compileGlob(g.toLowerCase(), {}));

const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');

function versionParts(v) {
  const m = typeof v === 'string' ? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** True when the version string is GIT_MIN_VERSION or newer (compared numerically). */
export function gitVersionOk(v) {
  const have = versionParts(v);
  const want = versionParts(GIT_MIN_VERSION);
  if (have === null) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

// A revision word git diff cannot read as an option or as several words.
function plainRevision(t) {
  return typeof t === 'string' && t !== '' && t.length <= 1024 && !t.startsWith('-') && !/[\0\n\r]/.test(t);
}

/** Whether a repo-relative path lies under the protected repo subpaths (case-folded). */
export function inProtectedSubpath(rel) {
  if (typeof rel !== 'string') return false;
  const p = rel.toLowerCase();
  return SUBPATH_RES.some((re) => re.test(p));
}

function defaultSpawn(file, args, options) {
  const r = spawnSync(file, args, { ...options, shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

/**
 * The files under `subpaths` that differ between HEAD and `target`.
 * @param {{root: string}} repo
 * @param {string|{stash: string}} target
 * @param {string[]} subpaths
 * @param {{gitPath?: string, gitVersion?: string, deadlineMs?: number, spawn?: Function, env?: {PATH?: string, HOME?: string}}} [opts]
 * @returns {string[]|typeof UNKNOWN}
 */
export function gitTreeDiff(repo, target, subpaths, opts = {}) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!repo || typeof repo !== 'object' || !isAbs(repo.root)) return UNKNOWN;
    if (!isAbs(o.gitPath)) return UNKNOWN;
    if (!gitVersionOk(o.gitVersion)) return UNKNOWN;
    if (!Array.isArray(subpaths) || subpaths.length === 0 || !subpaths.every((s) => typeof s === 'string' && s !== '' && !s.includes('\0'))) return UNKNOWN;
    let tail;
    const stash = target !== null && typeof target === 'object' ? target.stash : undefined;
    if (stash !== undefined) {
      if (typeof stash !== 'string' || !STASH_REF.test(stash)) return UNKNOWN;
      tail = ['stash', 'show', ...DIFF_FLAGS, '--include-untracked', stash];
    } else {
      if (!plainRevision(target)) return UNKNOWN;
      tail = ['diff', ...DIFF_FLAGS, 'HEAD', target, '--', ...subpaths];
    }
    const args = [...HARDENING, '-C', repo.root, ...tail];
    const from = o.env && typeof o.env === 'object' ? o.env : process.env;
    const env = {
      PATH: typeof from.PATH === 'string' ? from.PATH : '',
      HOME: typeof from.HOME === 'string' ? from.HOME : '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_LAZY_FETCH: '1',
    };
    const deadline = Number.isFinite(o.deadlineMs) && o.deadlineMs > 0 ? o.deadlineMs : DEFAULT_DEADLINE_MS;
    const spawn = typeof o.spawn === 'function' ? o.spawn : defaultSpawn;
    const r = spawn(o.gitPath, args, { env, timeout: deadline, maxBuffer: MAX_OUTPUT });
    if (!r || r.error || r.signal || typeof r.status !== 'number') return UNKNOWN;
    // git ran to completion and refused the target as a revision (diff only; stash refs stay UNKNOWN)
    if (r.status !== 0 && stash === undefined && typeof r.stderr === 'string' && r.stderr.length <= MAX_OUTPUT && NOT_REVISION_MSG.test(r.stderr)) return NOT_A_REVISION;
    if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.length > MAX_OUTPUT) return UNKNOWN;
    const out = [];
    for (const line of r.stdout.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('"')) out.push(UNKNOWN);
      else if (stash === undefined || inProtectedSubpath(line)) out.push(line);
    }
    return out;
  } catch {
    return UNKNOWN;
  }
}

// ---------------------------------------------------------------------------------------------
// The repository's config files, for the "written .git/config" rule: a git tree update whose repo
// config (or any file it includes) the agent wrote is opaque before anything is spawned.

export const MAX_CONFIG_FILES = 64;
export const MAX_INCLUDE_DEPTH = 10;
export const MAX_CONFIG_BYTES = 1024 * 1024;

const INCLUDE_PATH = /^\s*path\s*=\s*(.*?)\s*$/i;

const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
const joinTo = (dir, rel) => (dir === '/' ? `/${rel}` : `${dir}/${rel}`);

// The value of a `path = …` line: a quoted string, or the text before a comment.
function includeValue(raw) {
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"') return out;
      if (c === '\\') {
        const n = raw[++i];
        if (n === '\\' || n === '"') out += n;
        else return null;
      } else out += c;
    }
    return null;
  }
  const cut = raw.search(/[#;]/);
  return (cut < 0 ? raw : raw.slice(0, cut)).trim();
}

/**
 * Every config file a repository reads: the common dir's config and config.worktree, the gitdir's
 * own (a linked worktree), and each `path =` they include, transitively (every `[include]` and
 * `[includeIf]` counts, whatever its condition). UNKNOWN when any of them cannot be read (other than
 * "does not exist"), an include cannot be resolved (`%(prefix)`, `~user`, no home), or a cap is hit.
 * @param {string} gitDir absolute
 * @param {{read: (path: string) => string|null, home?: string}} io read throws on errors, null when missing
 * @returns {string[]|typeof UNKNOWN}
 */
export function gitConfigFiles(gitDir, io) {
  try {
    if (!isAbs(gitDir) || !io || typeof io.read !== 'function') return UNKNOWN;
    const readCapped = (p) => {
      const t = io.read(p);
      if (t === null || t === undefined) return null;
      if (typeof t !== 'string' || t.length > MAX_CONFIG_BYTES) throw new Error('unreadable');
      return t;
    };
    let common = gitDir;
    const cd = readCapped(joinTo(gitDir, 'commondir'));
    if (cd !== null) {
      const rel = cd.trim();
      if (rel === '') return UNKNOWN;
      common = rel.startsWith('/') ? rel : joinTo(gitDir, rel);
    }
    const queue = [...new Set([joinTo(common, 'config'), joinTo(gitDir, 'config'), joinTo(gitDir, 'config.worktree'), joinTo(common, 'config.worktree')])].map((f) => ({ f, depth: 0 }));
    const out = [];
    const seen = new Set();
    while (queue.length > 0) {
      const { f, depth } = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(f);
      if (out.length > MAX_CONFIG_FILES) return UNKNOWN;
      const text = readCapped(f);
      if (text === null) continue;
      for (const line of text.split('\n')) {
        const m = INCLUDE_PATH.exec(line);
        if (!m) continue;
        const v = includeValue(m[1]);
        if (v === null || v === '' || v.includes('%(') || v.includes('\0')) return UNKNOWN;
        let p;
        if (v.startsWith('~/')) {
          if (!isAbs(io.home)) return UNKNOWN;
          p = joinTo(io.home.replace(/\/+$/, '') || '/', v.slice(2));
        } else if (v.startsWith('~')) return UNKNOWN;
        else p = v.startsWith('/') ? v : joinTo(dirOf(f), v);
        if (depth + 1 > MAX_INCLUDE_DEPTH) return UNKNOWN;
        queue.push({ f: p, depth: depth + 1 });
      }
    }
    return out;
  } catch {
    return UNKNOWN;
  }
}

// ---------------------------------------------------------------------------------------------
// Does the repository track anything under its protected subpaths? Directory presence is the
// caller's half; this is the other: a bounded text scan of the index for `.claude/` or `.codex/`
// (case-folded). A missing index tracks nothing; an index over the cap or a read error counts as
// tracking (fail closed).

export const MAX_INDEX_SCAN_BYTES = 8 * 1024 * 1024;
const INDEX_NEEDLES = ['.claude/', '.codex/'];

/**
 * @param {string} indexPath absolute path of the index file
 * @param {{statSync: Function, readFileSync: Function}} fsImpl
 * @returns {boolean}
 */
export function indexMentionsProtected(indexPath, fsImpl) {
  try {
    if (!isAbs(indexPath)) return true;
    let st;
    try {
      st = fsImpl.statSync(indexPath);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
      return true;
    }
    if (!st.isFile() || st.size > MAX_INDEX_SCAN_BYTES) return true;
    const buf = fsImpl.readFileSync(indexPath);
    const text = (Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)).toLowerCase();
    return INDEX_NEEDLES.some((n) => text.includes(n));
  } catch {
    return true;
  }
}

/**
 * The engine's binding of the check to its pinned git: a three-argument gitTreeDiff for
 * ctx.gitTreeDiff that carries `gitPath`.
 */
export function bindGitTreeDiff(opts) {
  const o = opts && typeof opts === 'object' ? { ...opts } : {};
  const fn = (repo, target, subpaths) => gitTreeDiff(repo, target, subpaths, o);
  fn.gitPath = o.gitPath;
  return fn;
}
