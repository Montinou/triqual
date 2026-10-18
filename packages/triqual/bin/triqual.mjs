#!/usr/bin/env node
// The `triqual` npm package: `npx triqual setup` sets up a machine, `--version` prints this package's version, and
// every other command runs in the triqual shim that setup installs in ~/.local/bin.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forward, shimPath } from '../lib/forward.mjs';

const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const HELP = new Set(['help', '--help', '-h']);

export const USAGE = `usage: triqual <command> [args]

  setup [--yes] [--keep-language] [--no-harness]   set up triqual on this machine (needs claude, git and Node 22.13+)
  --version, -v                                      print this package's version

Every other command runs in the triqual that setup installs (~/.local/bin/triqual).
`;

// Runs one invocation. Resolves to the exit code, or to the signal that killed the forwarded command.
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [first] = argv;
  if (first === '--version' || first === '-v') {
    stdout.write(`${VERSION}\n`);
    return { code: 0, signal: null };
  }
  const home = env.HOME;
  const isHelp = argv.length === 0 || (argv.length === 1 && HELP.has(first));
  if (!existsSync(shimPath(home))) {
    if (isHelp) {
      stdout.write(USAGE);
      return { code: 0, signal: null };
    }
    stderr.write('triqual is not set up on this machine: run npx triqual setup\n');
    return { code: 3, signal: null };
  }
  const r = forward(argv, { home, env });
  if (r.signal) return { code: 1, signal: r.signal };
  if (isHelp) stdout.write('npx triqual setup reruns the setup\n');
  return { code: r.status ?? 1, signal: null };
}

// realpath: through npm's .bin symlink, argv[1] is the link, not this file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, signal } = await main(process.argv.slice(2));
  if (signal) process.kill(process.pid, signal);
  process.exit(code);
}
