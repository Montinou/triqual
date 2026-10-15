// Installs the public-repository hooks into the clone it runs in, after the store gate that `triqual progress-init --store`
// wrote: the content gate (bin/hooks/content-gate-pre-commit.mjs) goes into <git-common-dir>/hooks/pre-commit on the line right
// after the one that calls the store gate, and the identity hook (bin/hooks/identity-pre-push.mjs) is appended to
// <git-common-dir>/hooks/pre-push, each once. progress-init puts the store line right after the shebang, above whatever the
// hook already had, so the lines the user kept sit after it: appending at the end of file would land the content gate after a
// trailing `exec` or `exit` where it never runs. The store gate still runs first. The common dir is the clone's, so one install
// serves every linked worktree; each hook line finds its script through the worktree it runs in.
//
//   node bin/install-hooks.mjs
//
// Exit 0 installed (or already there); 3 when core.hooksPath is set (the hooks live elsewhere) or the store gate is missing from
// pre-commit (run `triqual progress-init --store` first); 1 on a failure.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOOK_MODE = 0o755;
const STORE_SCRIPT = 'progress-store-pre-commit.sh';
const LINES = Object.freeze({
  'pre-commit': 'node "$(git rev-parse --show-toplevel)/bin/hooks/content-gate-pre-commit.mjs" || exit 1',
  'pre-push': 'node "$(git rev-parse --show-toplevel)/bin/hooks/identity-pre-push.mjs" "$@" || exit 1',
});

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A shell hook: an `sh`, `bash`, `dash` or `zsh` shebang (through env or not), or none.
const isShellHook = (first) => !first.startsWith('#!') || /^#!\s*(?:\S*\/)?(?:env\s+)?(?:sh|bash|dash|zsh)\b/.test(first);

// Adds `line` to the hook `file` unless a line equal to it is there: right after the first line that contains `after` when given
// (appended when none does), else at the end. Creates the file with a `#!/bin/sh` shebang when missing.
// Returns 'created', 'added', 'present' or 'not-shell'.
function chain(file, line, after = null) {
  if (!existsSync(file)) {
    writeFileSync(file, `#!/bin/sh\n${line}\n`);
    chmodSync(file, HOOK_MODE);
    return 'created';
  }
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.includes(line)) return 'present';
  if (!isShellHook(lines[0])) return 'not-shell';
  const at = after === null ? -1 : lines.findIndex((l) => l.includes(after));
  if (at !== -1) {
    lines.splice(at + 1, 0, line);
    writeFileSync(file, lines.join('\n'));
    chmodSync(file, HOOK_MODE);
    return 'added';
  }
  writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
  chmodSync(file, HOOK_MODE);
  return 'added';
}

export function main({ out = console.log, err = console.error } = {}) {
  try {
    let hooksPath = '';
    try {
      hooksPath = git(['config', 'core.hooksPath']);
    } catch {
      hooksPath = ''; // git config exits 1 when the key is unset
    }
    if (hooksPath !== '') {
      err(`install-hooks: core.hooksPath is set (${hooksPath}), so the hooks live outside this clone's hooks dir: add the two lines from ${LINES['pre-commit']} and ${LINES['pre-push']} to the hooks there by hand`);
      return 3;
    }
    const hooks = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'hooks');
    const preCommit = join(hooks, 'pre-commit');
    if (!existsSync(preCommit) || !readFileSync(preCommit, 'utf8').includes(STORE_SCRIPT)) {
      err(`install-hooks: the store gate (${STORE_SCRIPT}) is not chained in ${preCommit}: run \`triqual progress-init --store\` first`);
      return 3;
    }
    mkdirSync(hooks, { recursive: true });
    for (const name of ['pre-commit', 'pre-push']) {
      const result = chain(join(hooks, name), LINES[name], name === 'pre-commit' ? STORE_SCRIPT : null);
      if (result === 'not-shell') {
        err(`install-hooks: ${join(hooks, name)} is not a shell script, so it was left untouched: add this line to it by hand: ${LINES[name]}`);
        return 3;
      }
      out(`${name}: ${result}`);
    }
    return 0;
  } catch (error) {
    err(`install-hooks: ${String(error.stderr ?? '').trim().split('\n')[0] || error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
