// Pre-commit hook: runs the content gate on what is about to be committed, so a deny term, home path, email, secret or
// private-only path never reaches a commit that could be published. Installed as .git/hooks/pre-commit (by the setup, not here).
//
// It reads the index, not the working tree: the paths come from `git diff --cached --name-only --diff-filter=ACMRT -z` (a
// deletion has nothing to read; a rename is its new name) and each file's bytes from `git show :<path>`. git runs the hook with
// its own environment, and `git commit -a` / `git commit <path>` point GIT_INDEX_FILE at a temporary index: every git call here
// inherits process.env unchanged so it sees that index. (The git helpers in lib/export.mjs strip GIT_*, so they are not used.)
//
// Exit 0 clean; 1 on hits (one `path:line · category` line each on stderr, never the matched text) or when no local terms are
// configured, unless TRIQUAL_GATE_NO_LOCAL_TERMS=1; 1 also on a failure, since a hook that cannot check must not let a commit by.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ExportError, loadLocalTerms } from '../lib/export.mjs';
import { formatHit, gateFiles, loadAllowSecrets } from '../lib/content-gate.mjs';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(args, env) {
  try {
    return execFileSync('git', args, { env, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0];
    throw new ExportError(`git ${args[0]} failed${reason ? `: ${reason}` : ''}`, 1);
  }
}

export function main({ env = process.env, err = console.error } = {}) {
  try {
    const paths = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'], env).toString('utf8').split('\0').filter((entry) => entry !== '');
    const noTerms = env.TRIQUAL_GATE_NO_LOCAL_TERMS === '1';
    const home = env.HOME || homedir();
    const terms = noTerms ? [] : loadLocalTerms({ env, home }).terms;
    if (!noTerms && terms.length === 0) {
      throw new ExportError('no local terms are configured, so the content gate cannot check for them: add terms to the public export deny file, or set TRIQUAL_GATE_NO_LOCAL_TERMS=1 to run the other checks only', 1);
    }
    const { hits } = gateFiles(paths, { readFile: (path) => git(['show', `:${path}`], env), terms, home, allowSecrets: loadAllowSecrets() });
    for (const hit of hits) err(formatHit(hit));
    return hits.length > 0 ? 1 : 0;
  } catch (error) {
    err(`content gate: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
