// The process runner of the production CLI wiring (spawnSync shape: run(cmd, args, {cwd, env, input,
// encoding, timeout}) -> {status, signal, stdout, stderr, error}).
//
// Two kinds of program run through it:
//   sudo   (the absolute path from the command table, humanonly.mjs SUDO): realRun (sudo.mjs), which
//          inherits the terminal so sudo can prompt there, and discards stdout when it is given
//          `input` (the data adminWrite pipes to `sudo tee`);
//   others (npm, node, git, claude, codex, the installed launcher): captureRun, which captures
//          stdout and stderr as text. realRun does not return stdout, and npm audit's output, the
//          node and git version probes and the host CLIs' answers all have to be read.
//
// Nothing in this module looks a program up on PATH: `run` executes the absolute path it is given.
// The doctor probes (probes.mjs) resolve `claude` and `codex` themselves, on env.PATH (absolute
// entries only, symlinks resolved), and hand the resulting absolute path to this runner; every other
// caller names an absolute path of its own (the command table, the pinned node, npm).

import { spawnSync } from 'node:child_process';

import { SUDO } from './humanonly.mjs';
import { realRun } from './sudo.mjs';

export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function captureRun(cmd, args, { cwd, env, input, timeout } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    env,
    input,
    timeout,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// `sudoPath`, `sudoRun` and `capture` exist for the unit test of the routing; the CLI wiring uses
// the defaults.
export function makeWiringRun({ sudoPath = SUDO, sudoRun = realRun, capture = captureRun } = {}) {
  return function run(cmd, args, opts = {}) {
    if (cmd === sudoPath) return sudoRun(cmd, args, opts);
    return capture(cmd, args, opts);
  };
}

export const wiringRun = makeWiringRun();
