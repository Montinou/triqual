// Store-mode gates (spec §3, §4; plan ruling S2). A commit with staged changes needs a `pending` entry of its own
// worktree (`git_dir`), and entries are stamped with the commit only through a handshake: the pre-commit records the
// tree being committed and the pending ids in <git-dir>/triqual/commit-handshake.json, and the post-commit stamps
// those ids with HEAD only when HEAD has that tree and `git commit` made it. Replays (rebase, cherry-pick, revert) and
// merges therefore never stamp an entry. The Stop hook blocks a dirty worktree with no pending entry. Every store
// failure fails closed, naming the database, the error code and `triqual tracking restore`.
// node:sqlite is loaded (loadSqlite) only once a store-mode path needs the database.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.mjs';
import { writeAtomic } from './fsx.mjs';
import { loadSqlite, SCHEMA_TOO_NEW, storePaths } from './store.mjs';
import { storeContext, storeTracking } from './tracking.mjs';

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const OVERRIDE_KEY = `${BRAND.envPrefix}TRACKING_DB`;
const HANDSHAKE = 'commit-handshake.json';
const PRE = 'pre-commit (progress-tracking, store mode)';
const POST = 'post-commit (progress-tracking, store mode)';
const STOP = 'Stop (progress-tracking, store mode)';

// The markers of a merge or a replay in progress: the same five names as templates/pre-commit-local.mjs and
// templates/progress-gate.sh (a test pins all three equal).
export const EXEMPT = Object.freeze(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']);

// The pre-commit refusal; the Stop block uses the same text.
export const NO_PENDING = 'the commit has changes but this worktree has no pending progress entry: add one with '
  + `\`${BRAND.cli} tracking add <draft>\``;

// The shell lines `progress-init --store` installs, by hook name. They do nothing in a checkout whose marker is unset
// (a clone of a public repository), refuse the commit (pre-commit) or skip quietly (post-commit) when `triqual` is not
// on PATH, and otherwise hand over to `triqual tracking hook <name>`. They end in `exec` and exit early, so they form
// a hook script of their own: chain a call to that script, never these lines inline into another hook.
const MARKER_LINE = `[ "$(git config --local --get ${BRAND.cli}.tracking)" = store ] || exit 0`;
const missingCli = (prefix, consequence, code) => `command -v ${BRAND.cli} >/dev/null 2>&1 || { echo "${prefix}: `
  + `${BRAND.cli} is not on PATH, ${consequence}" >&2; exit ${code}; }`;
export const STORE_HOOK_LINES = Object.freeze({
  'pre-commit': Object.freeze([
    MARKER_LINE,
    missingCli(PRE, `so this commit cannot be checked for a pending progress entry: install ${BRAND.cli} or fix PATH`, 1),
    `exec ${BRAND.cli} tracking hook pre-commit`,
  ]),
  'post-commit': Object.freeze([
    MARKER_LINE,
    missingCli(POST, "so this commit's progress entries stay pending", 0),
    `exec ${BRAND.cli} tracking hook post-commit`,
  ]),
});

// <git-dir>/triqual/commit-handshake.json of the worktree whose git dir is `gitDir`.
export const handshakePath = (gitDir) => join(gitDir, BRAND.dir, HANDSHAKE);

// Where the store lives for a failure message: the database path, or the override that disables it.
export function storeWhere({ home, env }) {
  const paths = storePaths({ home, env });
  return paths ? paths.db : `${OVERRIDE_KEY}=${JSON.stringify(env[OVERRIDE_KEY])} (not an absolute path)`;
}

const RESTORE = `${BRAND.cli} tracking restore`;
const UPDATE_ADVICE = '; this plugin is older than the database: update progress-tracking and run /reload-plugins '
  + `(or restart the session); do not run \`${RESTORE}\`, it would discard newer entries`;

// One line on a store failure: where the store is (when known), the error's code and the recovery command (added
// unless the error's own message already names it, or names a write as the fix for an older schema). `err` is a StoreError or anything a query threw after the open
// (SQLITE_BUSY, corruption).
function failureText(err, where) {
  const code = typeof err?.code === 'string' && err.code ? err.code : 'error';
  const message = err?.message ?? String(err);
  const recover = code === SCHEMA_TOO_NEW ? UPDATE_ADVICE : err?.upgradeByWrite || message.includes(RESTORE) ? ''
    : `; recover with \`${RESTORE} <snapshot>\` (snapshots are kept in backups/ beside the database)`;
  return `the tracking store${where ? ` at ${where}` : ''} failed (${code}): ${message}${recover}`;
}

export const storeFailure = (err, { home, env }) => failureText(err, storeWhere({ home, env }));

// This worktree's pending entry ids, read without writing: a read-only connection and a repository looked up, never
// created (a repository the store has never seen has none). Throws the store's errors.
export async function pendingIds(t, { home, env }) {
  await loadSqlite();
  const st = storeTracking(t, { home, env, access: 'read' });
  try {
    if (st.repoId === null) return [];
    return st.store.pendingEntries({ repoId: st.repoId, gitDir: t.gitDir }).map((r) => r.id);
  } finally {
    st.store.close();
  }
}

const block = (reason) => ({ decision: 'block', reason });

// The Stop verdict in store mode. null when the stop continues a block or nothing is dirty. A block with NO_PENDING
// when this worktree has no pending entry, and with the failure (where, code, recovery; as the pre-commit words it)
// when the store could not be read (`storeError`: the error, with the store's path as `where` when the caller knows
// it): pending entries were never read then, and `tracking add` would fail on the same store. Both block once per
// change set: a `fingerprint` equal to the session's `lastFingerprint` (the change set already blocked) lets the turn
// end. A store newer than this triqual (`storeError.code` SCHEMA_TOO_NEW) does not block: it returns a systemMessage
// warning, once per change set the same way, since no write by this triqual could succeed and the user cannot clear it
// from inside the session.
export function stopVerdictStore({ dirty, input, pending, storeError, fingerprint, lastFingerprint }) {
  if (input?.stop_hook_active || !dirty.length) return null;
  if (!storeError && pending.length) return null;
  if (fingerprint !== null && fingerprint !== undefined && fingerprint === lastFingerprint) return null;
  if (storeError?.code === SCHEMA_TOO_NEW) return { systemMessage: `${STOP}: ${failureText(storeError, storeError.where)}` };
  return block(storeError ? `${STOP}: ${failureText(storeError, storeError.where)}` : NO_PENDING);
}

// git as a hook runs it: the inherited environment is kept, since `commit -a` / `commit <paths>` point
// GIT_INDEX_FILE at the temporary index that is being committed.
const git = (cwd, args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const exempt = (cwd) => EXEMPT.some((name) => existsSync(git(cwd, ['rev-parse', '--git-path', name])));

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  return 1;
};

// `triqual tracking hook pre-commit` for the store-mode tracking `t`: the exit code. Merges, replays and commits with
// nothing staged pass and clear the handshake (a stale one must not be stamped by their post-commit); a commit with
// staged changes passes only with a pending entry of this worktree, recording the handshake. Anything that fails,
// the store first, refuses the commit.
export async function preCommit(t, { cwd, home, env }) {
  const file = handshakePath(t.gitDir);
  try {
    if (exempt(cwd) || git(cwd, ['diff', '--cached', '--name-only']) === '') {
      try { rmSync(file, { force: true }); } catch { /* best effort: this commit passes regardless */ }
      return 0;
    }
  } catch (err) {
    return fail(`${PRE}: ${err.message}`);
  }
  let ids;
  try {
    ids = await pendingIds(t, { home, env });
  } catch (err) {
    return fail(`${PRE}: ${storeFailure(err, { home, env })}`);
  }
  if (!ids.length) return fail(NO_PENDING);
  try {
    // The tree this commit will have: post-commit stamps only a HEAD with this tree.
    const tree = git(cwd, ['write-tree']);
    mkdirSync(join(t.gitDir, BRAND.dir), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ tree, ids })}\n`);
  } catch (err) {
    // Passing without the handshake would leave the entries pending for the next commit to reuse.
    return fail(`${PRE}: could not record the commit handshake in ${file}: ${err.message}`);
  }
  return 0;
}

// True when `git commit` made HEAD (with or without --amend, or as a repository's first commit), from the subject of
// HEAD's newest reflog entry. Replays log `cherry-pick:`, `revert:` or `rebase (pick):`, merges `commit (merge):` and a
// finished cherry-pick `commit (cherry-pick):`.
const COMMIT_SUBJECTS = ['commit:', 'commit (amend):', 'commit (initial):'];
const madeByCommit = (subject) => COMMIT_SUBJECTS.some((prefix) => subject.startsWith(prefix));

// `triqual tracking hook post-commit`: always 0, problems go to stderr. Reads the handshake, stamps its ids with HEAD
// when HEAD has the recorded tree and `git commit` made it, then removes the handshake. A HEAD that `git commit` made
// with another tree (the index changed after the pre-commit) stamps nothing, and one stderr line names the skipped ids
// so the entries' later attribution is visible.
export async function postCommit(t, { cwd, home, env }) {
  const file = handshakePath(t.gitDir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') process.stderr.write(`${POST}: could not read ${file}: ${err.message}\n`);
    return 0;
  }
  try {
    const hs = JSON.parse(text);
    if (!hs || typeof hs.tree !== 'string' || !Array.isArray(hs.ids) || !hs.ids.every(Number.isSafeInteger)) {
      throw new Error('not a commit handshake');
    }
    const byCommit = madeByCommit(git(cwd, ['reflog', '-1', '--format=%gs', 'HEAD']));
    const sameTree = git(cwd, ['rev-parse', 'HEAD^{tree}']) === hs.tree;
    if (byCommit && !sameTree) {
      process.stderr.write(`${POST}: entries ${hs.ids.join(', ')} were not stamped: HEAD's tree is not the one the `
        + 'pre-commit checked, so they stay pending for the next commit\n');
    }
    if (byCommit && sameTree) {
      const sha = git(cwd, ['rev-parse', 'HEAD']);
      await loadSqlite();
      const sc = storeContext(t, { home, env });
      let stamped;
      try {
        stamped = sc.store.stampEntries(hs.ids, sha);
      } finally {
        sc.store.close();
      }
      if (stamped !== hs.ids.length) {
        process.stderr.write(`${POST}: stamped ${stamped} of ${hs.ids.length} entries (ids ${hs.ids.join(', ')}) with `
          + `${sha}: the others were no longer pending\n`);
      }
    }
  } catch (err) {
    const why = err?.name === 'StoreError' || typeof err?.errcode === 'number' ? storeFailure(err, { home, env }) : err.message;
    process.stderr.write(`${POST}: the entries of ${file} were not stamped: ${why}\n`);
  } finally {
    try {
      rmSync(file, { force: true });
    } catch (err) {
      process.stderr.write(`${POST}: could not remove ${file}: ${err.message}\n`);
    }
  }
  return 0;
}
