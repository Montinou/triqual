// Human-only commands (spec, "CLI"): the command table, the speed-bump check every one of them runs
// first, and the sudo gate the weakening ones run next.
//
// Built-in self-protection denies these commands to the agent; that is the boundary. `requireHuman`
// (an interactive terminal on stdin, no CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID in the environment)
// is a speed bump on top of it. Weakening commands also require fresh sudo authentication
// (`sudoGate`, src/cli/sudo.mjs): `hatch`, `allow-once`, `uninstall`, `rollback` always; `apply`
// when its diff weakens the policy or cannot be proven to tighten it; `repair` after an integrity
// mismatch (and when that is unknown: both fail closed). Exactly one gate run per call: `rollback`
// and `uninstall` are gated by the wrapper below, the others by their own code (`gate` in SPEC).
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

// The implementations (src/cli/commands.mjs registers the real ones once, when the CLI wiring is
// loaded). An implementation may carry `validate(ctx)`, returning an error text for arguments it will
// not accept (or undefined): the wrapper runs it after requireHuman and BEFORE the table's sudo gate,
// so a usage error never costs a password prompt. A command with no implementation still runs its
// guard first, then refuses. `OVERRIDE` is the test-only seam: overrideImplsForTest swaps the whole
// map for the duration of a test. Nothing reads either from an argument or the environment.
const IMPLS = {};
let OVERRIDE = null;

// Registers the implementations of the commands in the table, each once.
export function registerImpls(map) {
  for (const [command, impl] of Object.entries(map)) {
    if (!BY_NAME.has(command)) throw new Error(`registerImpls: ${JSON.stringify(command)} is not a human-only command`);
    if (typeof impl !== 'function') throw new Error(`registerImpls: the implementation of ${command} is not a function`);
    if (Object.hasOwn(IMPLS, command) && IMPLS[command] !== impl) throw new Error(`registerImpls: ${command} already has an implementation`);
    IMPLS[command] = impl;
  }
}

// Test-only: replaces the implementation map (command -> function) until the returned function is
// called. A command missing from `map` has no implementation while the override is in place.
export function overrideImplsForTest(map) {
  const previous = OVERRIDE;
  OVERRIDE = Object.freeze({ ...map });
  return () => {
    OVERRIDE = previous;
  };
}

// `weakening`: true, false, or a function of the command context deciding it per call.
// `gate`: where a weakening call runs the sudo gate.
//   'table'  this wrapper, before the implementation (rollback, uninstall);
//   'impl'   the command's own code, at the point it must (hatch and allow-once after their arguments
//            are checked and the target is shown, apply after the confirmation, repair after the
//            confirmation of what it clears). The wrapper then does not gate: one prompt, not two;
//   'none'   the command never gates (install gates only --from-tarball, inside install()).
const SPEC = [
  { command: 'install', weakening: false, gate: 'none' },
  { command: 'upgrade', weakening: false, gate: 'none' },
  { command: 'rollback', weakening: true, gate: 'table' },
  { command: 'edit', weakening: false, gate: 'none' },
  // apply: weakening unless the caller has proven the diff only tightens the policy
  { command: 'apply', weakening: (ctx) => ctx?.provenTightening !== true, gate: 'impl' },
  // repair: weakening after an integrity mismatch, or when it is not known that there is none
  { command: 'repair', weakening: (ctx) => ctx?.integrityMismatch !== false, gate: 'impl' },
  { command: 'hatch', weakening: true, gate: 'impl' },
  { command: 'allow-once', weakening: true, gate: 'impl' },
  { command: 'uninstall', weakening: true, gate: 'table' },
  { command: 'lock', weakening: false, gate: 'none' },
];

export function weakens(entry, ctx = {}) {
  return typeof entry.weakening === 'function' ? entry.weakening(ctx) === true : entry.weakening === true;
}

// The handler wrapper: requireHuman before anything else, then the sudo gate when the call weakens
// and the table is the gate (entry.gate === 'table'), then the implementation.
// ctx = { stdin, env, run, impl?, ...command-specific facts }; `run` (required) is the process runner
// handed to the gate (spawnSync shape; the CLI wiring passes the host's runner). The gate is always
// called without a sudo path, so it uses SUDO. `ctx.impl` is for unit tests that call the handler
// directly; the CLI wiring never sets it.
function guarded(entry) {
  return function handler(ctx = {}) {
    requireHuman({ stdin: ctx.stdin, env: ctx.env });
    if (typeof ctx.run !== 'function') throw new Error(`"${entry.command}": no process runner was given`);
    const impl = ctx.impl ?? (OVERRIDE === null ? IMPLS[entry.command] : OVERRIDE[entry.command]);
    // arguments are checked before the table's sudo gate: a usage error never prompts for a password
    if (typeof impl === 'function' && typeof impl.validate === 'function') {
      const problem = impl.validate(ctx);
      if (typeof problem === 'string') throw new Error(problem);
    }
    if (entry.gate === 'table' && weakens(entry, ctx)) {
      const gate = sudoGate({ run: ctx.run });
      if (!gate.ok) throw new Error(`"${entry.command}" needs fresh sudo authentication: ${gate.reason}`);
    }
    if (typeof impl !== 'function') throw new Error(`"${entry.command}" is not yet implemented`);
    return impl(ctx);
  };
}

export const HUMAN_ONLY = Object.freeze(SPEC.map((s) => Object.freeze({ ...s, handler: guarded(s) })));

const BY_NAME = new Map(HUMAN_ONLY.map((e) => [e.command, e]));
// (registerImpls above reads BY_NAME when it is called, long after this line ran)

export function humanOnly(command) {
  return BY_NAME.get(command);
}

// Whether `command` runs the sudo gate for this context, wherever it runs it (this table's wrapper
// or the command's own code, see `gate` above). Read-only commands are not in the table and never do.
export function requiresGate(command, ctx = {}) {
  const entry = BY_NAME.get(command);
  return entry ? weakens(entry, ctx) : false;
}
