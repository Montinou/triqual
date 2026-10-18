// Forwarding to the triqual shim that `setup` installs: every command but `setup` and `--version` runs there.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Where the installer puts the shim the `triqual` link points at.
export function shimPath(home) {
  return join(home, '.local', 'bin', 'triqual.mjs');
}

// Runs the shim with `args`, stdio inherited. Returns the child's exit status and the signal that killed it, if any.
export function forward(args, { home, env }) {
  const r = spawnSync(process.execPath, [shimPath(home), ...args], { stdio: 'inherit', env });
  if (r.error) throw r.error;
  return { status: r.status, signal: r.signal };
}
