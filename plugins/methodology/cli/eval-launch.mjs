// `triqual eval launch ...argv`: starts `claude` with ...argv unchanged, and (with an active session experiment) assigns a
// new interactive session its arm; see lib/eval-launch.mjs. `triqual eval launch --install` adds the shell alias
// `claude` -> `triqual eval launch` to ${ZDOTDIR:-$HOME}/.zshrc (once), `--uninstall` removes it; both only as the sole
// argument, any other argument list goes to claude. Exit codes: claude's; for the alias commands 0, or 1 when the file
// cannot be written.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install, launch, uninstall } from './lib/eval-launch.mjs';

export const SUMMARY = 'start claude, assigning a session experiment arm (launch)';

export async function main(argv, deps = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr } = deps;
  const only = argv.length === 1 ? argv[0] : null;
  if (only !== '--install' && only !== '--uninstall') return launch(argv, { ...deps, env, stderr });
  const rcFile = join(env.ZDOTDIR || env.HOME || homedir(), '.zshrc');
  try {
    const { changed } = only === '--install' ? install({ rcFile }) : uninstall({ rcFile });
    const verb = only === '--install' ? 'added to' : 'removed from';
    stdout.write(changed ? `alias claude ${verb} ${rcFile}\n` : `alias claude: nothing to change in ${rcFile}\n`);
    return 0;
  } catch (err) {
    stderr.write(`triqual eval launch: ${rcFile} could not be written: ${err?.code ?? 'error'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
