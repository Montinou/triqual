// Repository and branch resolver for the normalizer ("Paths and repositories" in the spec).
//
//   repoOf(cwd, {gitDir?, workTree?, fs?}) -> {root, gitDir, branch} | null | UNKNOWN
//   hasLocalBranch(repo, name, fs?)        -> boolean
//
// Everything is read in-process from the files git itself reads; no process is ever spawned (the
// only git spawn in fence is the bounded tree check of T18).
//
// Discovery (no gitDir): walk up from the realpath of cwd (git walks the physical directory) for
// `.git`, either a directory or a file `gitdir: <path>` naming a linked worktree's gitdir (a
// relative path is relative to the directory holding the file). Like git, a `.git` directory is
// accepted only when it looks like a repository (a HEAD file, `objects/` and `refs/` in its common
// dir); one that does not is skipped and the walk goes on, so a stray `.git/HEAD` cannot shadow the
// real repository above it. A `.git` file that does not name a repository is UNKNOWN (git stops
// there with an error). GIT_CEILING_DIRECTORIES and the file-system boundary stop are not modelled:
// the walk can only go further up than git, never stop earlier.
//
// gitDir (from `--git-dir` or GIT_DIR, relative to cwd) replaces discovery; the work tree is then
// `workTree`, else UNKNOWN when core.worktree is set (the gitdir's config or config.worktree, or the
// common dir's config), else cwd (git's rule). workTree alone keeps the discovered gitdir; a
// discovered repository whose config sets core.worktree also has an UNKNOWN root. Both values come already expanded by the caller.
//
// branch: HEAD as a symbolic ref `refs/heads/<b>` (a file, or an old-style symlink) gives <b>; a
// detached HEAD (a 40 or 64 hex object id) gives null (detached HEAD is not protected); anything
// else (another ref namespace, the reftable placeholder `.invalid`, garbage) is UNKNOWN.
//
// Results: null when there is no repository; UNKNOWN when the answer cannot be determined (bad
// input, an UNKNOWN option, a read error other than "does not exist", a gitdir that is not a
// repository). root/gitDir are realpaths; root may itself be UNKNOWN (core.worktree). Nothing here
// throws.

import nodeFs from 'node:fs';

import { UNKNOWN, isUnknown } from '../norm/unknown.mjs';
import { resolvePath } from './paths.mjs';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const HEX_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_FILE = 64 * 1024;

const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');
const parentOf = (dir) => {
  const i = dir.lastIndexOf('/');
  return i <= 0 ? '/' : dir.slice(0, i);
};
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

// fs.statSync that answers null for "does not exist" and throws for anything else.
function statOrNull(fsImpl, p) {
  try {
    return fsImpl.statSync(p);
  } catch (err) {
    if (MISSING.has(err?.code)) return null;
    throw err;
  }
}

function readSmall(fsImpl, p) {
  const text = fsImpl.readFileSync(p, 'utf8');
  if (typeof text !== 'string' || text.length > MAX_FILE) throw new Error('unreadable');
  return text;
}

function readOrNull(fsImpl, p) {
  try {
    return readSmall(fsImpl, p);
  } catch (err) {
    if (MISSING.has(err?.code)) return null;
    throw err;
  }
}

function realOf(p, base, fsImpl) {
  const r = resolvePath(p, base, undefined, fsImpl);
  return isAbs(r) ? r : UNKNOWN;
}

// The common dir of a gitdir (a linked worktree's gitdir names it in `commondir`).
function commonDirOf(gitDir, fsImpl) {
  const text = readOrNull(fsImpl, join(gitDir, 'commondir'));
  if (text === null) return gitDir;
  const rel = text.trim();
  if (rel === '') return UNKNOWN;
  return realOf(rel, gitDir, fsImpl);
}

// Does the directory look like a repository to git? true / false; throws on read errors.
function isGitDir(dir, fsImpl) {
  const head = statOrNull(fsImpl, join(dir, 'HEAD'));
  if (!head || !head.isFile()) return false;
  const common = commonDirOf(dir, fsImpl);
  if (isUnknown(common)) return false;
  const objects = statOrNull(fsImpl, join(common, 'objects'));
  const refs = statOrNull(fsImpl, join(common, 'refs'));
  return !!objects && objects.isDirectory() && !!refs && refs.isDirectory();
}

// A `.git` file: the gitdir it names, or UNKNOWN.
function gitFileTarget(file, dir, fsImpl) {
  const text = readSmall(fsImpl, file);
  const m = /^gitdir: (.+)$/m.exec(text);
  if (!m) return UNKNOWN;
  const target = realOf(m[1].trim(), dir, fsImpl);
  if (isUnknown(target) || !isGitDir(target, fsImpl)) return UNKNOWN;
  return target;
}

// The branch HEAD names: a string, null (detached) or UNKNOWN.
function branchOf(gitDir, fsImpl) {
  try {
    const head = join(gitDir, 'HEAD');
    const st = fsImpl.lstatSync(head);
    let ref;
    if (st.isSymbolicLink()) {
      ref = String(fsImpl.readlinkSync(head));
    } else {
      const text = readSmall(fsImpl, head).trim();
      if (HEX_ID.test(text)) return null;
      if (!text.startsWith('ref: ')) return UNKNOWN;
      ref = text.slice(5).trim();
    }
    if (!ref.startsWith('refs/heads/')) return UNKNOWN;
    const name = ref.slice('refs/heads/'.length);
    if (!validBranchName(name) || name === '.invalid') return UNKNOWN;
    return name;
  } catch {
    return UNKNOWN;
  }
}

// A conservative subset of git's refname rules: enough to never read outside refs/heads.
function validBranchName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 1024) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || '~^:?*[\\'.includes(name[i])) return false;
  }
  return !name.split('/').some((seg) => seg.startsWith('.'));
}

// core.worktree set for this gitdir: in its config, its config.worktree, or (for a linked
// worktree) the common dir's config. A coarse scan: any `worktree =` line counts.
function configSetsWorktree(gitDir, fsImpl) {
  const common = commonDirOf(gitDir, fsImpl);
  const files = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
  if (isUnknown(common)) return true;
  if (common !== gitDir) files.push(join(common, 'config'));
  return files.some((f) => {
    const text = readOrNull(fsImpl, f);
    return text !== null && /^\s*worktree\s*=/im.test(text);
  });
}

function discover(start, fsImpl) {
  for (let dir = start; ; dir = parentOf(dir)) {
    const dotGit = join(dir, '.git');
    const st = statOrNull(fsImpl, dotGit);
    if (st && st.isDirectory()) {
      const gitDir = realOf(dotGit, '/', fsImpl);
      if (isUnknown(gitDir)) return UNKNOWN;
      if (isGitDir(gitDir, fsImpl)) return { root: dir, gitDir };
    } else if (st && st.isFile()) {
      const gitDir = gitFileTarget(dotGit, dir, fsImpl);
      if (isUnknown(gitDir)) return UNKNOWN;
      return { root: dir, gitDir };
    }
    if (dir === '/') return null;
  }
}

/**
 * The repository a git command run from cwd works on.
 * @param {string} cwd absolute directory
 * @param {{gitDir?:string|typeof UNKNOWN, workTree?:string|typeof UNKNOWN, fs?:object}} [opts]
 * @returns {{root:string|typeof UNKNOWN, gitDir:string, branch:string|null|typeof UNKNOWN}|null|typeof UNKNOWN}
 */
export function repoOf(cwd, opts = {}) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const fsImpl = o.fs || nodeFs;
    if (!isAbs(cwd)) return UNKNOWN;
    if (isUnknown(o.gitDir) || isUnknown(o.workTree)) return UNKNOWN;
    const start = realOf(cwd, '/', fsImpl);
    if (isUnknown(start)) return UNKNOWN;
    let workTree = null;
    if (o.workTree !== undefined && o.workTree !== null) {
      if (typeof o.workTree !== 'string' || o.workTree === '') return UNKNOWN;
      workTree = realOf(o.workTree, start, fsImpl);
      if (isUnknown(workTree)) return UNKNOWN;
    }
    let found;
    if (o.gitDir !== undefined && o.gitDir !== null) {
      if (typeof o.gitDir !== 'string' || o.gitDir === '') return UNKNOWN;
      const named = realOf(o.gitDir, start, fsImpl);
      if (isUnknown(named)) return UNKNOWN;
      const st = statOrNull(fsImpl, named);
      let gitDir = UNKNOWN;
      if (st && st.isDirectory() && isGitDir(named, fsImpl)) gitDir = named;
      else if (st && st.isFile()) gitDir = gitFileTarget(named, parentOf(named), fsImpl);
      if (isUnknown(gitDir)) return UNKNOWN;
      const root = workTree ?? (configSetsWorktree(gitDir, fsImpl) ? UNKNOWN : start);
      found = { root, gitDir };
    } else {
      found = discover(start, fsImpl);
      if (found === null || isUnknown(found)) return found;
      if (workTree) found = { root: workTree, gitDir: found.gitDir };
      else if (configSetsWorktree(found.gitDir, fsImpl)) found = { root: UNKNOWN, gitDir: found.gitDir };
    }
    return { root: found.root, gitDir: found.gitDir, branch: branchOf(found.gitDir, fsImpl) };
  } catch {
    return UNKNOWN;
  }
}

/**
 * Whether `name` is a local branch of the repository (a loose ref under the common dir's
 * refs/heads, or a packed ref). False for anything that cannot be confirmed.
 * @param {{gitDir:string}|null|typeof UNKNOWN} repo a repoOf result
 * @param {string} name
 * @param {object} [fsImpl]
 */
export function hasLocalBranch(repo, name, fsImpl = nodeFs) {
  try {
    if (!repo || typeof repo !== 'object' || isUnknown(repo) || !isAbs(repo.gitDir)) return false;
    if (!validBranchName(name)) return false;
    const common = commonDirOf(repo.gitDir, fsImpl);
    if (isUnknown(common)) return false;
    const loose = statOrNull(fsImpl, join(common, `refs/heads/${name}`));
    if (loose && loose.isFile()) return true;
    const packed = readOrNull(fsImpl, join(common, 'packed-refs'));
    if (packed === null) return false;
    const want = ` refs/heads/${name}`;
    return packed.split('\n').some((line) => !line.startsWith('#') && !line.startsWith('^') && line.endsWith(want));
  } catch {
    return false;
  }
}
