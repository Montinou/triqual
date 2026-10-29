// Replay package builder: for one finished task commit, writes the commit message and `git diff sha^ sha` into a scratch
// directory the caller owns. Merge commits and root commits are refused (no single parent to diff against). A diff over
// `maxBytes` is still written but flagged `tooLarge`, so the caller can skip it instead of feeding a reviewer a huge input.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_MAX_BYTES = 204800;
const GIT_BUFFER = 512 * 1024 * 1024;

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: GIT_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });

export function buildPackage({ root, sha, out, maxBytes = DEFAULT_MAX_BYTES }) {
  if (typeof root !== 'string' || root === '' || typeof out !== 'string' || out === '') throw new Error('buildPackage needs root and out');
  // A sha that starts with "-" would be read as a git option; a name that is not a commit id never reaches git.
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error('sha is not a commit id');

  let parents;
  try {
    parents = git(root, ['rev-list', '--parents', '-n', '1', `${sha}^{commit}`]).toString('utf8').trim().split(/\s+/).slice(1);
  } catch {
    throw new Error('commit does not resolve in the repository');
  }
  if (parents.length > 1) throw new Error('refusing a merge commit');
  if (parents.length === 0) throw new Error('refusing a root commit: it has no parent to diff against');

  const diff = git(root, ['diff', `${sha}^`, sha]);
  const message = git(root, ['log', '-1', '--format=%B', sha]);

  mkdirSync(out, { recursive: true });
  const diffPath = join(out, 'diff.patch');
  writeFileSync(diffPath, diff);
  writeFileSync(join(out, 'message.txt'), message);
  return { diffPath, bytes: diff.length, tooLarge: diff.length > maxBytes };
}
