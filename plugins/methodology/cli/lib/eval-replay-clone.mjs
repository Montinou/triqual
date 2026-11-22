// A throwaway clone of a repo at one sha, for replaying a session with bypassPermissions.
// The clone is the boundary: it holds the one commit `base` (a depth-1 fetch into a fresh repository) and nothing else: no
// refs, no remote, no alternates, no later history, so a replayed agent cannot read the original change or the hidden tests
// from git. It has no hooks either, so a replay cannot reach the real checkout's refs, remotes or hooks.
// Hooks are never copied in (no core.hooksPath is set; git's templates ship only *.sample files). node: built-ins only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_TIMEOUT_MS = 60_000;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// Runs git with an args array (no shell); true when it exited 0 within the timeout.
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return r.status === 0 && !r.error;
}

// A new temp dir (prefix triqual-replay-) holding only the given commits of `repo` (a depth-1 fetch of each into a fresh
// repository), the first checked out detached. Throws Error('clone failed') with no git output when a sha is not a full
// object name or the fetch or checkout fails; the partial dir is removed first.
function cloneCommits(repo, shas) {
  const dir = mkdtempSync(join(tmpdir(), 'triqual-replay-'));
  const ok = shas.every((sha) => FULL_SHA.test(sha))
    && git(['init', '-q', '--', dir])
    && git(['-C', dir, 'fetch', '-q', '--depth', '1', '--no-tags', '--', pathToFileURL(resolve(repo)).href, ...shas])
    && git(['-C', dir, 'checkout', '-q', '--detach', shas[0]]);
  if (!ok) {
    removeClone(dir);
    throw new Error('clone failed');
  }
  return dir;
}

// The runner's clone: only the commit `sha`, so a replayed agent cannot read anything later from git.
export function cloneAt(repo, sha) {
  return cloneCommits(repo, [sha]);
}

// The harvest's clone: `base` checked out, and `original` fetched too (never given to an agent), so validation can move the
// clone to original. Same boundary otherwise: no refs, remote, alternates or other history.
export function cloneForValidation(repo, base, original) {
  return cloneCommits(repo, [base, original]);
}

// Deletes a clone; a missing dir is fine.
export function removeClone(dir) {
  rmSync(dir, { recursive: true, force: true });
}
