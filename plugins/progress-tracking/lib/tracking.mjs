// Where a repo's tracking files live. Committed mode keeps them in the working tree (progress.md at the repo root,
// plans and specs under docs/); local mode keeps them under <git-common-dir>/methodology/, shared by every worktree
// and never committed. A repo is opted in when progress.md (that exact name) exists in either root; when both have it,
// committed wins. Store mode keeps everything in the local tracking database and is marked by
// `git config --local triqual.tracking store`, which wins over both and is read without opening the database.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeAtomic, sha256 } from './fsx.mjs';
import { BRAND } from './brand.mjs';
import { docsDirs, openStore, repoKey, storePaths, StoreError } from './store.mjs';
import { readRegistry } from './registry.mjs';

const GIT_TIMEOUT_MS = 10000;
const STATE_VERSION = 1;
const STORE_MARKER_KEY = 'triqual.tracking';
const STORE_MARKER = 'store';

// Repo-selecting variables a git hook exports to its children. Dropped so git discovers the repo from `cwd` alone.
const INHERITED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

function gitRaw(cwd, args) {
  const env = { ...process.env };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  return execFileSync('git', args, {
    cwd, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
  });
}

const git = (cwd, args) => gitRaw(cwd, args).trim();

// The trimmed output of a git command run in `cwd`, realpath-normalized, or null when git fails (not a repo, no
// such directory, git missing, timeout).
function gitPath(cwd, args) {
  try {
    return realpathSync(git(cwd, args));
  } catch {
    return null;
  }
}

// <git-common-dir>/methodology for the repo containing `cwd` (the main repo's, from a linked worktree), or null
// outside git.
export function localRoot(cwd) {
  const common = gitPath(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common === null ? null : join(common, 'methodology');
}

// True when `dir` holds an entry named exactly progress.md. existsSync would also find PROGRESS.md on a case-insensitive
// file system, a name git and the gates never match.
function hasProgress(dir) {
  try {
    return readdirSync(dir).includes('progress.md');
  } catch {
    return false;
  }
}

// True when the clone carries the store marker (`git config --local`, shared by every worktree of the clone). An unset
// key, an unreadable config and a git failure all read as not marked.
function isStoreMarked(cwd) {
  try {
    return git(cwd, ['config', '--local', '--get', STORE_MARKER_KEY]) === STORE_MARKER;
  } catch {
    return false;
  }
}

// The git facts a store row and its entries are keyed by: the clone's common dir, this worktree's own git dir and the
// checked-out branch (null on a detached HEAD). The paths are realpath-normalized; null outside git.
export function gitFacts(cwd) {
  const gitCommonDir = gitPath(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = gitPath(cwd, ['rev-parse', '--absolute-git-dir']);
  if (gitCommonDir === null || gitDir === null) return null;
  let branch = null;
  try {
    branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) || null;
  } catch { /* detached HEAD */ }
  return { gitCommonDir, gitDir, branch };
}

export function resolveTracking(cwd) {
  const repoRoot = gitPath(cwd, ['rev-parse', '--show-toplevel']);
  if (repoRoot === null) return null;
  if (isStoreMarked(repoRoot)) {
    const facts = gitFacts(repoRoot);
    if (facts !== null) return { mode: 'store', root: repoRoot, repoRoot, ...facts, progress: null, status: null };
  }
  const local = localRoot(cwd);
  const committed = hasProgress(repoRoot);
  const hasLocal = local !== null && hasProgress(local);
  if (committed) {
    return {
      mode: 'committed',
      repoRoot,
      root: repoRoot,
      progress: join(repoRoot, 'progress.md'),
      status: join(repoRoot, 'status.md'),
      plansDir: join(repoRoot, 'docs', 'plans'),
      specsDir: join(repoRoot, 'docs', 'specs'),
      statePath: null,
      duplicate: hasLocal,
    };
  }
  if (!hasLocal) return null;
  return {
    mode: 'local',
    repoRoot,
    root: local,
    progress: join(local, 'progress.md'),
    status: join(local, 'status.md'),
    plansDir: join(local, 'plans'),
    specsDir: join(local, 'specs'),
    statePath: join(local, 'state.json'),
    duplicate: false,
  };
}

// The local-mode gate state: the hash of the last commit that passed the gate, and the hash the local pre-commit let
// through for a commit not yet landed (its post-commit promotes it). A missing or malformed state.json (or a tracking
// without one) reads as nothing recorded, a field that is not a string as null, and unknown fields are ignored; any
// other read error (EACCES, EISDIR, EIO) is rethrown so the gates never fail open on it.
export function readState(t) {
  const none = { version: STATE_VERSION, lastProgressSha256: null, pendingProgressSha256: null };
  if (t.statePath === null) return none;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(t.statePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return none;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object') return none;
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    version: STATE_VERSION,
    lastProgressSha256: str(parsed.lastProgressSha256),
    pendingProgressSha256: str(parsed.pendingProgressSha256),
  };
}

// Records `hash` as the last gated hash, with nothing pending.
export function writeState(t, hash) {
  const state = { version: STATE_VERSION, lastProgressSha256: hash, pendingProgressSha256: null };
  writeAtomic(t.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// sha256 of the progress.md bytes, or null when the file is missing.
export function progressHash(t) {
  let bytes;
  try {
    bytes = readFileSync(t.progress);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return sha256(bytes);
}

// The root a clone's store row and registry entry name: its main worktree (the first `git worktree list --porcelain`
// entry, realpath-normalized), else the parent of a common dir named `.git` when git cannot list the worktrees; null
// for a bare clone, which has no main worktree (the caller falls back to the current worktree's root).
export function mainWorktreeRoot(cwd, gitCommonDir) {
  try {
    const [first] = gitRaw(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
    const fields = first.split('\0');
    if (fields.includes('bare')) return null;
    const line = fields.find((f) => f.startsWith('worktree '));
    if (line) return realpathSync(line.slice('worktree '.length));
  } catch { /* fall back on the common dir's name */ }
  return basename(gitCommonDir) === '.git' ? dirname(gitCommonDir) : null;
}

// The open store and this worktree's context for any tracking shape (store, committed or local: import and export run
// before a repository is switched). With `write` the repository row is created when absent, naming the clone's main
// worktree root (mainWorktreeRoot; the current worktree's for a bare clone), so every first writer (import, add,
// progress-init --store) from any worktree pins the same root, and its `shareable` taken from that root's registry
// entry (always 0 for a local-mode repository, whose files live in the git dir and are never shared);
// without it the row is only looked up and a repository the store has never seen throws StoreError `missing`. `create`
// lets the open create the database file (progress-init --store, tracking import). Throws the open's StoreError
// (disabled, missing, node, open); the store is closed again when the context cannot be built.
export function storeContext(t, { home, env, write = false, create = false }) {
  const store = openStore({ home, env, create });
  try {
    const facts = t.mode === 'store' ? t : gitFacts(t.repoRoot);
    if (facts === null) throw new StoreError('open', `not a git repository: ${t.repoRoot}`);
    const { gitCommonDir, gitDir, branch } = facts;
    let repo;
    if (write) {
      // The main worktree's root is resolved (a `git worktree list`) only for a row that does not exist yet.
      repo = store.findRepo(gitCommonDir);
      if (repo === null) {
        const root = mainWorktreeRoot(t.repoRoot, gitCommonDir) ?? t.repoRoot;
        const shareable = t.mode !== 'local' && readRegistry(home).some((r) => r.root === root && r.shareable);
        repo = store.ensureRepo({ gitCommonDir, root, origin: null, shareable });
      }
    } else {
      repo = store.findRepo(gitCommonDir);
      if (repo === null) {
        throw new StoreError('missing', `this repository has no tracking data in the store: run \`${BRAND.cli} progress-init --store\` or \`${BRAND.cli} tracking import\``);
      }
    }
    const { dataDir } = storePaths({ home, env });
    return {
      store,
      ctx: { repoId: repo.id, repoKey: repo.repo_key, gitDir, branch },
      dataDir,
      docsDir: docsDirs(dataDir, repo.repo_key).docsDir,
    };
  } catch (err) {
    try { store.close(); } catch { /* the original error is the one to report */ }
    throw err;
  }
}

// The paths `git status` reports as changed (untracked files included), relative to the repo root.
function dirtyPaths(repoRoot) {
  const out = gitRaw(repoRoot, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
  return out.split('\0').filter((rec) => rec.length >= 4).map((rec) => rec.slice(3));
}

// [mtimeMs, size] of a dirty path; [-1, -1] when it is gone.
function statOf(path) {
  try {
    const s = lstatSync(path);
    return [s.mtimeMs, s.size];
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [-1, -1];
    throw err;
  }
}

// The once-per-change-set fingerprint for store mode, the counterpart of the gate's file-based one: sha256 of the repo
// root, the sorted dirty paths with their mtimeMs and size, and the pending entry ids. `pending` is the ids (numbers
// or the { id } rows `pendingEntries` returns); `dirty` defaults to what git reports and is only passed by a caller that
// already has it. Nothing is read from tracking files: a store repository has none, so progressHash is never reached.
export function storeFingerprint(t, pending, dirty = dirtyPaths(t.repoRoot)) {
  const paths = [...dirty].sort().map((p) => [p, ...statOf(join(t.repoRoot, p))]);
  const ids = pending.map((p) => (typeof p === 'object' ? p.id : p)).sort((a, b) => a - b);
  return sha256(JSON.stringify({ repoRoot: t.repoRoot, paths, pending: ids }));
}

// The store of a store-mode repository for the task ledger and the snapshot: `t` plus { store, repoId, dataDir,
// docsDir, plansDir, specsDir }, the documents directories being the repository's own under the data directory. The
// caller closes `store`. `access`:
//   'read'    a read-only connection; the repository is only looked up (repoId is null when the store has no row for it);
//   'write'   a read-write connection; the repository is only looked up;
//   'create'  a read-write connection; the repository row is created when absent.
export function storeTracking(t, { home, env, access = 'read' }) {
  let store;
  let repoId;
  if (access === 'create') {
    const sc = storeContext(t, { home, env, write: true });
    ({ store } = sc);
    repoId = sc.ctx.repoId;
  } else {
    store = openStore({ home, env, readOnly: access === 'read' });
    try {
      repoId = store.findRepo(t.gitCommonDir)?.id ?? null;
    } catch (err) {
      try { store.close(); } catch { /* the original error is the one to report */ }
      throw err;
    }
  }
  const { dataDir } = storePaths({ home, env });
  return { ...t, store, repoId, dataDir, ...docsDirs(dataDir, repoKey(t.gitCommonDir)) };
}
