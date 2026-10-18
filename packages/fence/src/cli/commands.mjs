// The CLI wiring of the commands that touch the installed state: doctor (read-only) and the
// human-only commands install, upgrade, rollback, uninstall, edit, apply, repair, hatch, allow-once
// (`lock` and `replay` are not implemented yet). index.mjs loads this module on demand.
//
// Each implementation is registered with the human-only table (humanonly.mjs registerImpls) and runs
// AFTER the table's wrapper: requireHuman({stdin, env}) first, then the table's sudo gate for the
// commands it gates (rollback, uninstall). The others gate inside their own code, once, where the
// command must: hatch and allow-once after their arguments are checked, apply after the confirmation
// (and only when the change weakens the policy), repair after the confirmation of what it clears,
// install --from-tarball inside install(). The wiring passes them the real gate (sudoGate over the
// host's runner) and never gates a second time.
//
// An implementation takes ctx = {command, args, io, host, stdin, env, run} and returns the exit code.
// `host` is everything the production CLI reads from the real machine, built by realHost() and
// replaceable only by the code that calls main() (tests); no argument and no environment variable can
// set a host field, an implementation, a smoke test or a deadline. Fields:
//   stdin, stdout, env, home (os.userInfo().homedir, never $HOME), platform, cwd, uid,
//   run (wiringRun: sudo on the terminal, everything else captured), nodePath, npmPath,
//   adminDir (adminDir(platform)), sudoers (the real, read-only reader), spawn (the editor),
//   and, absent in production: probes, smoke, deadlineMs, claudeManaged, codexManaged, draftDir.

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline';

import { repoOf } from '../resolve/repo.mjs';
import { isUnknown } from '../norm/unknown.mjs';
import { adminDir as platformAdminDir } from './admin.mjs';
import { allowOnce } from './allowonce.mjs';
import { apply, edit } from './apply.mjs';
import { doctor } from './doctor.mjs';
import { hatch } from './hatch.mjs';
import { registerImpls } from './humanonly.mjs';
import { install } from './install.mjs';
import { createProbes } from './probes.mjs';
import { defaultNpmPath } from './provenance.mjs';
import { repair } from './repair.mjs';
import { wiringRun } from './run.mjs';
import { realSudoersReader, sudoGate } from './sudo.mjs';
import { rollback, upgrade } from './upgrade.mjs';
import { uninstall } from './uninstall.mjs';

export function realHost() {
  const platform = process.platform;
  let admin;
  try {
    admin = platformAdminDir(platform);
  } catch {
    admin = undefined; // a platform with no admin directory: the commands that need it say so
  }
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    home: os.userInfo().homedir,
    platform,
    cwd: process.cwd(),
    uid: process.getuid?.(),
    run: wiringRun,
    nodePath: process.execPath,
    npmPath: defaultNpmPath(process.execPath),
    adminDir: admin,
    sudoers: realSudoersReader,
    spawn: (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }),
  };
}

// ---- arguments ------------------------------------------------------------------------------------

// Parses `args` against { values: [flags taking a value], bools: [flags], positionals: n }. Accepts
// `--flag value` and `--flag=value`; anything else is an error. -> {values, bools, positional} | {error}
export function parseArgs(args, { values = [], bools = [], positionals = 0 } = {}) {
  const out = { values: {}, bools: new Set(), positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return { error: 'an argument is not text' };
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    if (values.includes(name)) {
      let value;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (i + 1 < args.length) value = args[++i];
      else return { error: `${name} needs a value` };
      if (Object.hasOwn(out.values, name)) return { error: `${name} was given twice` };
      out.values[name] = value;
    } else if (bools.includes(name) && eq === -1) {
      out.bools.add(name);
    } else if (a.startsWith('-')) {
      return { error: `unknown argument ${JSON.stringify(a)}` };
    } else {
      out.positional.push(a);
    }
  }
  if (out.positional.length > positionals) return { error: `unexpected argument ${JSON.stringify(out.positional[positionals])}` };
  return out;
}

const USAGE = Object.freeze({
  install: 'usage: fence install --version <exact> [--from-tarball <file>] [--policy example|strict]',
  upgrade: 'usage: fence upgrade --version <exact>',
  rollback: 'usage: fence rollback',
  uninstall: 'usage: fence uninstall [--purge]',
  edit: 'usage: fence edit',
  apply: 'usage: fence apply <draft>',
  repair: 'usage: fence repair',
  doctor: 'usage: fence doctor [--json]',
});

function usageError(io, command, error) {
  io.err(`fence: ${error}; ${USAGE[command]}`);
  return 1;
}

function failure(io, reason) {
  io.err(`fence: ${reason}`);
  return 1;
}

// ---- prompts --------------------------------------------------------------------------------------

// Asks `question` on the host's terminal; true only for y or yes. Closed input is a no.
export async function askYesNo(question, host) {
  const rl = createInterface({ input: host.stdin, output: host.stdout });
  try {
    const answer = await new Promise((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question(question, (a) => resolve(a));
    });
    return /^(?:y|yes)$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

const gateFor = (host) => () => sudoGate({ run: host.run });

// ---- doctor (read-only) -----------------------------------------------------------------------------

export async function runDoctor(args, io, host) {
  const a = parseArgs(args, { bools: ['--json'] });
  if (a.error) return usageError(io, 'doctor', a.error);
  const r = await doctor({
    home: host.home,
    env: host.env,
    cwd: host.cwd,
    probes: host.probes ?? createProbes({ run: host.run, env: host.env, home: host.home }),
    sudoers: host.sudoers,
    adminDir: host.adminDir,
    uid: host.uid,
    json: a.bools.has('--json'),
    io,
  });
  return r.exitCode;
}

// ---- the human-only commands --------------------------------------------------------------------------

async function installCommand({ args, io, host }) {
  const a = parseArgs(args, { values: ['--version', '--from-tarball', '--policy'] });
  if (a.error) return usageError(io, 'install', a.error);
  if (a.values['--version'] === undefined) return usageError(io, 'install', '--version is required');
  const r = await install({
    version: a.values['--version'],
    fromTarball: a.values['--from-tarball'],
    ...(a.values['--policy'] === undefined ? {} : { policyChoice: a.values['--policy'] }),
    home: host.home,
    run: host.run,
    env: host.env,
    stdin: host.stdin,
    nodePath: host.nodePath,
    npmPath: host.npmPath,
    smoke: host.smoke,
    deadlineMs: host.deadlineMs,
    io,
  });
  if (!r.ok) return failure(io, r.reason);
  io.out(`fence ${r.version} is installed and active.`);
  if (r.repairNeeded) io.out(r.repairNeeded);
  return 0;
}

async function upgradeCommand({ args, io, host }) {
  const a = parseArgs(args, { values: ['--version'] });
  if (a.error) return usageError(io, 'upgrade', a.error);
  if (a.values['--version'] === undefined) return usageError(io, 'upgrade', '--version is required');
  const r = await upgrade({
    version: a.values['--version'],
    home: host.home,
    run: host.run,
    env: host.env,
    nodePath: host.nodePath,
    npmPath: host.npmPath,
    smoke: host.smoke,
    deadlineMs: host.deadlineMs,
    io,
  });
  if (!r.ok) return failure(io, r.reason);
  if (r.repairNeeded) io.out(r.repairNeeded);
  return 0;
}

async function rollbackCommand({ args, io, host }) {
  const a = parseArgs(args);
  if (a.error) return usageError(io, 'rollback', a.error);
  const r = await rollback({
    home: host.home,
    run: host.run,
    env: host.env,
    nodePath: host.nodePath,
    smoke: host.smoke,
    deadlineMs: host.deadlineMs,
    io,
  });
  if (!r.ok) return failure(io, r.reason);
  if (r.repairNeeded) io.out(r.repairNeeded);
  return 0;
}

async function uninstallCommand({ args, io, host }) {
  const a = parseArgs(args, { bools: ['--purge'] });
  if (a.error) return usageError(io, 'uninstall', a.error);
  const r = await uninstall({
    home: host.home,
    run: host.run,
    env: host.env,
    purge: a.bools.has('--purge'),
    io,
    adminDir: host.adminDir,
  });
  if (!r.ok) return failure(io, r.reason ?? `uninstall finished with problems: ${(r.warnings ?? []).join('; ')}`);
  return 0;
}

async function editCommand({ args, io, host }) {
  const a = parseArgs(args);
  if (a.error) return usageError(io, 'edit', a.error);
  const r = edit({ home: host.home, env: host.env, spawn: host.spawn, draftDir: host.draftDir, io });
  return r.ok ? 0 : failure(io, r.reason);
}

async function applyCommand({ args, io, host }) {
  const a = parseArgs(args, { positionals: 1 });
  if (a.error) return usageError(io, 'apply', a.error);
  if (a.positional.length !== 1) return usageError(io, 'apply', 'a draft file is required');
  // The only sudo gate of apply: apply() runs it after the confirmation, and only when the change
  // weakens the policy (the command table does not gate apply).
  const r = await apply({
    draftPath: a.positional[0],
    home: host.home,
    confirm: () => askYesNo('Apply this change? [y/N] ', host),
    gate: gateFor(host),
    io,
  });
  return r.ok ? 0 : failure(io, r.reason);
}

async function repairCommand({ args, io, host }) {
  const a = parseArgs(args);
  if (a.error) return usageError(io, 'repair', a.error);
  const r = await repair({
    home: host.home,
    run: host.run,
    env: host.env,
    nodePath: host.nodePath,
    smoke: host.smoke,
    deadlineMs: host.deadlineMs,
    confirm: (summary) =>
      askYesNo(
        summary.fallback
          ? `The current version ${summary.fallback.from ?? '(none)'} is not usable (${summary.fallback.reason}). Switch to version ${summary.fallback.version} and reinstall from it? ` +
            `That version was not covered by the integrity check and none of its code has run; it is built and smoke-tested only after you confirm and sudo passes. [y/N] `
          : summary.currentUsable === false
            ? 'Clear the integrity denial? There is no usable current version, so you will be asked next which version to switch to. [y/N] '
            : 'Reinstall from the current version and clear the integrity denial? [y/N] ',
        host,
      ),
    gate: gateFor(host),
    io,
    adminDir: host.adminDir,
    probes: host.probes ?? createProbes({ run: host.run, env: host.env, home: host.home }),
    sudoers: host.sudoers,
    cwd: host.cwd,
    uid: host.uid,
  });
  return r.ok ? 0 : failure(io, r.reason);
}

// The repository root of the working directory, as a hatch's project-settings scan root.
function repoRootsOf(cwd) {
  try {
    const repo = repoOf(cwd);
    if (repo === null || isUnknown(repo) || typeof repo.root !== 'string' || isUnknown(repo.root)) return [];
    return [repo.root];
  } catch {
    return [];
  }
}

async function hatchCommand({ args, io, host }) {
  const r = await hatch({
    argv: args,
    home: host.home,
    platform: host.platform,
    gate: gateFor(host),
    run: host.run,
    adminDir: host.adminDir,
    repoRoots: repoRootsOf(host.cwd),
    claudeManaged: host.claudeManaged,
    codexManaged: host.codexManaged,
    io,
  });
  return r.ok ? 0 : failure(io, r.reason);
}

async function allowOnceCommand({ args, io, host }) {
  const r = await allowOnce({
    argv: args,
    home: host.home,
    cwd: host.cwd,
    platform: host.platform,
    gate: gateFor(host),
    run: host.run,
    adminDir: host.adminDir,
    io,
  });
  return r.ok ? 0 : failure(io, r.reason);
}

// The table gates rollback and uninstall before their implementation runs, so their arguments are
// checked first (humanonly.mjs: `validate`): a usage error never prompts for sudo.
rollbackCommand.validate = ({ args }) => {
  const a = parseArgs(args);
  return a.error ? `${a.error}; ${USAGE.rollback}` : undefined;
};
uninstallCommand.validate = ({ args }) => {
  const a = parseArgs(args, { bools: ['--purge'] });
  return a.error ? `${a.error}; ${USAGE.uninstall}` : undefined;
};

export const IMPLEMENTATIONS = Object.freeze({
  install: installCommand,
  upgrade: upgradeCommand,
  rollback: rollbackCommand,
  uninstall: uninstallCommand,
  edit: editCommand,
  apply: applyCommand,
  repair: repairCommand,
  hatch: hatchCommand,
  'allow-once': allowOnceCommand,
});

registerImpls(IMPLEMENTATIONS);
