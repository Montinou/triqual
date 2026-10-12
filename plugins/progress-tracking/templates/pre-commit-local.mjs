// progress-tracking, local mode: a commit with staged changes needs progress.md to have changed since the last commit
// that passed this gate. Installed by `triqual progress-init --local`, which copies this file ALONE to
// <git-common-dir>/methodology/pre-commit.mjs, so it imports only node: built-ins and finds its tracking root from its
// own location. state.json there records
//   { "version": 1, "lastProgressSha256": <hex|null>, "pendingProgressSha256": <hex|null>, "pendingTree": <hex|null> }
// (a missing pendingTree, from an older gate, reads as null).
//   node pre-commit.mjs                 pre-commit: compares with lastProgressSha256; a pass records the hash pending,
//                                       with the tree being committed (`git write-tree`)
//   node pre-commit.mjs --post-commit   post-commit: git runs it only once a commit landed; promotes pending to last
//                                       when HEAD^{tree} is the recorded tree or the reflog says `git commit` made
//                                       HEAD, and otherwise just clears it
// So an aborted commit (failing commit-msg hook, empty message) never consumes an entry, and neither does a commit
// that ran post-commit without this pre-commit (a cherry-pick replaying other work after an aborted commit).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const STATE_VERSION = 1;
const NEW_FILE_MODE = 0o644;
const EXEMPT = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

const root = dirname(fileURLToPath(import.meta.url));
const progressPath = join(root, 'progress.md');
const statePath = join(root, 'state.json');
// Agents cannot edit files under the git dir, so the message names `triqual tracking write`, like the Stop hook's.
const blocked = 'pre-commit (progress-tracking, local mode): progress.md has no new entry since the last commit. ' +
  "Write this task's entry to a draft file outside the repo and run `triqual tracking write entry <draft>` " +
  `(it lands at the top of ${progressPath}; agents cannot edit files under the git dir).`;

// The environment is inherited as is: commit -a / commit <paths> point GIT_INDEX_FILE at a temporary index, and that
// index is the one being committed.
const git = (args) => execFileSync('git', args, {
  encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER,
  stdio: ['ignore', 'pipe', 'inherit'],
});

// Merges, cherry-picks, reverts and rebases replay work that was already logged.
const exempt = () => EXEMPT.some((name) => existsSync(git(['rev-parse', '--git-path', name]).trim()));

// The recorded state; a missing or malformed state.json reads as nothing recorded, a field that is not a string as
// null, unknown fields are ignored. Other read errors throw.
function readState() {
  const none = { last: null, pending: null, pendingTree: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return none;
    throw err;
  }
  if (!parsed || typeof parsed !== 'object') return none;
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    last: str(parsed.lastProgressSha256), pending: str(parsed.pendingProgressSha256), pendingTree: str(parsed.pendingTree),
  };
}

// Temp file in the same directory plus rename, through symlinks; keeps an existing file's mode.
function writeAtomic(path, content) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : NEW_FILE_MODE;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created or already gone */ }
    throw err;
  }
}

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  return 1;
};

const writeState = (last, pending, pendingTree) => writeAtomic(statePath, `${JSON.stringify({
  version: STATE_VERSION, lastProgressSha256: last, pendingProgressSha256: pending, pendingTree,
}, null, 2)}\n`);

// A commit let through without recording must not leave a stale pending hash (from an aborted commit) for its
// post-commit to promote. Best effort: these commits pass regardless.
function clearPending() {
  try {
    const { last, pending } = readState();
    if (pending !== null) writeState(last, null, null);
  } catch { /* the next gated pre-commit fails closed on an unreadable state.json */ }
  return 0;
}

function preCommit() {
  if (exempt()) return clearPending();
  if (git(['diff', '--cached', '--name-only']).trim() === '') return clearPending();
  let text;
  let last;
  try {
    text = readFileSync(progressPath);
  } catch (err) {
    return fail(`${blocked} (could not read ${progressPath}: ${err.message})`);
  }
  try {
    ({ last } = readState());
  } catch (err) {
    return fail(`${blocked} (could not read ${statePath}: ${err.message})`);
  }
  const hash = createHash('sha256').update(text).digest('hex');
  // With no hash recorded yet, only a progress.md holding at least one entry counts as changed.
  const changed = last === null ? /^## /m.test(text.toString('utf8')) : hash !== last;
  if (!changed) return fail(blocked);
  // The tree this commit will have (the index being committed): post-commit promotes only a commit with this tree.
  const tree = git(['write-tree']).trim();
  try {
    writeState(last, hash, tree);
  } catch (err) {
    // Passing without recording would let the next commit through without a new entry.
    return fail(`pre-commit (progress-tracking, local mode): could not record the progress.md hash in ${statePath}: ${err.message}`);
  }
  return 0;
}

// True when `git commit` made HEAD: its reflog subject is `commit:`, `commit (amend):`, `commit (initial):` (or
// `commit (merge):`). Replays log `cherry-pick:`, `revert:`, `rebase (pick):`. False when the reflog cannot be read.
function madeByCommit() {
  try {
    return git(['reflog', '-1', '--format=%gs', 'HEAD']).startsWith('commit');
  } catch {
    return false;
  }
}

// A commit exists: when it is the one its pre-commit saw, the pending hash becomes the last gated one. That is when
// HEAD^{tree} equals the recorded tree, or, on a mismatch, when `git commit` made HEAD (a hook line after ours that
// re-stages files changes the tree on every commit). Otherwise (a replayed commit after an aborted one, or no tree
// recorded) the pending hash is cleared, never promoted. Never blocks (the commit is done).
function postCommit() {
  try {
    const { last, pending, pendingTree } = readState();
    if (pending === null) return 0;
    const promote = pendingTree !== null
      && (git(['rev-parse', 'HEAD^{tree}']).trim() === pendingTree || madeByCommit());
    if (promote) writeState(pending, null, null);
    else writeState(last, null, null);
  } catch (err) {
    process.stderr.write('post-commit (progress-tracking, local mode): could not promote the progress.md hash in ' +
      `${statePath}: ${err.message}\n`);
  }
  return 0;
}

if (process.argv.includes('--post-commit')) {
  process.exitCode = postCommit();
} else {
  // Anything unexpected (git failing, say) blocks the commit: the gate never fails open.
  try {
    process.exitCode = preCommit();
  } catch (err) {
    process.exitCode = fail(`pre-commit (progress-tracking, local mode): ${err.message}`);
  }
}
