#!/usr/bin/env node
// The cm alias of triqual.
// Bootstrap copies this file, alone and verbatim, to ~/.local/bin/cm.mjs (with ~/.local/bin/cm a relative symlink to
// it) for one release, so callers of the old name (the statusline, registered repos' progress-gate.sh) keep working.
// It imports only node: built-ins. It prints one deprecation line on stderr, then runs triqual.mjs from its own dir
// with the same args and inherited stdio, and exits with its code. Without triqual.mjs beside it: one more stderr
// line, exit 3.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.stderr.write('cm is deprecated: use triqual (cm will be removed in a later release)\n');
// Node resolves the cm symlink for the main module, so this is the dir of cm.mjs.
const target = join(dirname(fileURLToPath(import.meta.url)), 'triqual.mjs');
if (!existsSync(target)) {
  process.stderr.write(`cm: ${target} is missing: run /methodology:setup (or node bin/bootstrap.mjs from a clone)\n`);
  process.exit(3);
}
const child = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
if (child.error) {
  process.stderr.write(`cm: ${child.error.message}\n`);
  process.exit(1);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
