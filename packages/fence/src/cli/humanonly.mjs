// Human-only commands (spec, "CLI"): the command table, the speed-bump check every one of them runs
// first, and the sudo gate the weakening ones run next.
//
// Built-in self-protection denies these commands to the agent; that is the boundary. `requireHuman`
// (an interactive terminal on stdin, no CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID in the environment)
// is a speed bump on top of it. Weakening commands also require fresh sudo authentication
// (`sudoGate`, src/cli/sudo.mjs): `hatch`, `allow-once`, `uninstall`, `rollback` always; `apply`
// when its diff weakens the policy or cannot be proven to tighten it; `repair` after an integrity
// mismatch (and when that is unknown: both fail closed).
//
// COMMANDS is the table of external programs the production CLI runs, every one an absolute path
// (nothing is looked up on PATH). It is the only place the sudo path is written; the gate and the
// admin writer read it from here (SUDO). A different sudo path can be passed only through the module
// API, by unit tests; never by a flag or the environment. `chown` lives in /usr/sbin on macOS.

import { sudoGate } from './sudo.mjs';

export function commandsFor(platform) {
  return Object.freeze({
    sudo: '/usr/bin/sudo',
    install: '/usr/bin/install',
    tee: '/usr/bin/tee',
    chmod: '/bin/chmod',
    chown: platform === 'darwin' ? '/usr/sbin/chown' : '/bin/chown',
    mv: '/bin/mv',
    rm: '/bin/rm',
  });
}

export const COMMANDS = commandsFor(process.platform);
export const SUDO = COMMANDS.sudo;

const AGENT_ENV = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];

// Throws unless stdin is an interactive terminal, `env` is an environment object (the CLI wiring
// passes process.env; an omitted one never passes) and no agent session variable is set in it (any
// value, the empty string included, counts as set).
export function requireHuman({ stdin, env } = {}) {
  if (!stdin || stdin.isTTY !== true) {
    throw new Error('this command requires an interactive terminal on stdin; run it yourself, not through an agent');
  }
  if (env === null || typeof env !== 'object') {
    throw new Error('this command needs the process environment to check for an agent session; none was given');
  }
  for (const name of AGENT_ENV) {
    if (env[name] !== undefined) throw new Error(`this command refuses to run while ${name} is set (an agent session)`);
  }
}

// Implementations are registered here by the tasks that build each command. A command with none
// still runs its guard first, then refuses.
const IMPLS = Object.freeze({});

// `weakening`: true, false, or a function of the command context deciding it per call.
const SPEC = [
  { command: 'install', weakening: false },
  { command: 'upgrade', weakening: false },
  { command: 'rollback', weakening: true },
  { command: 'edit', weakening: false },
  // apply: weakening unless the caller has proven the diff only tightens the policy
  { command: 'apply', weakening: (ctx) => ctx?.provenTightening !== true },
  // repair: weakening after an integrity mismatch, or when it is not known that there is none
  { command: 'repair', weakening: (ctx) => ctx?.integrityMismatch !== false },
  { command: 'hatch', weakening: true },
  { command: 'allow-once', weakening: true },
  { command: 'uninstall', weakening: true },
  { command: 'lock', weakening: false },
];

export function weakens(entry, ctx = {}) {
  return typeof entry.weakening === 'function' ? entry.weakening(ctx) === true : entry.weakening === true;
}

// The handler wrapper: requireHuman before anything else, then the sudo gate when the call weakens,
// then the implementation. ctx = { stdin, env, run, impl?, ...command-specific facts }; `run`
// (required) is the process runner handed to the gate (spawnSync shape; the CLI wiring passes
// realRun from sudo.mjs). The gate is always called without a sudo path, so it uses SUDO.
function guarded(entry) {
  return function handler(ctx = {}) {
    requireHuman({ stdin: ctx.stdin, env: ctx.env });
    if (typeof ctx.run !== 'function') throw new Error(`"${entry.command}": no process runner was given`);
    if (weakens(entry, ctx)) {
      const gate = sudoGate({ run: ctx.run });
      if (!gate.ok) throw new Error(`"${entry.command}" needs fresh sudo authentication: ${gate.reason}`);
    }
    const impl = ctx.impl ?? IMPLS[entry.command];
    if (typeof impl !== 'function') throw new Error(`"${entry.command}" is not yet implemented`);
    return impl(ctx);
  };
}

export const HUMAN_ONLY = Object.freeze(SPEC.map((s) => Object.freeze({ ...s, handler: guarded(s) })));

const BY_NAME = new Map(HUMAN_ONLY.map((e) => [e.command, e]));

export function humanOnly(command) {
  return BY_NAME.get(command);
}

// Whether `command` runs the sudo gate for this context. Read-only commands are not in the table and
// never do.
export function requiresGate(command, ctx = {}) {
  const entry = BY_NAME.get(command);
  return entry ? weakens(entry, ctx) : false;
}
