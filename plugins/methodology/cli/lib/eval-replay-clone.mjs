// A throwaway clone of a repo at one sha, for replaying a session with bypassPermissions.
// The clone is the boundary: it has no remote and no hooks, so a replay cannot reach the real checkout's refs, remotes or hooks.
// Hooks are never copied in (no core.hooksPath is set; git's templates ship only *.sample files). node: built-ins only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_TIMEOUT_MS = 60_000;

// Runs git with an args array (no shell); true when it exited 0 within the timeout.
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return r.status === 0 && !r.error;
}

// Clones `repo` into a new temp dir (prefix triqual-replay-) and detaches it at `sha`.
// Throws Error('clone failed') with no git output when the clone or checkout fails; the partial dir is removed first.
export function cloneAt(repo, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'triqual-replay-'));
  const ok = git(['clone', '--shared', '-q', '--no-checkout', '--', repo, dir])
    && git(['-C', dir, 'checkout', '-q', '--detach', sha])
    && git(['-C', dir, 'remote', 'remove', 'origin']);
  if (!ok) {
    removeClone(dir);
    throw new Error('clone failed');
  }
  return dir;
}

// Deletes a clone; a missing dir is fine.
export function removeClone(dir) {
  rmSync(dir, { recursive: true, force: true });
}
