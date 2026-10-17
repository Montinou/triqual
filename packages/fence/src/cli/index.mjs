// fence CLI entry. bin/fence.mjs calls main(args) with the arguments after the script path
// (args[0] is the subcommand) and uses the returned number as the exit code.

import { runCheck, runTest } from './check.mjs';
import { packageVersion } from './version.mjs';

const NOT_YET = new Set([
  'log',
  'doctor',
  'replay',
  'install',
  'upgrade',
  'rollback',
  'edit',
  'apply',
  'repair',
  'hatch',
  'allow-once',
  'uninstall',
  'lock',
]);

export function helpText() {
  return [
    `fence ${packageVersion()}: a fail-closed policy harness for Claude Code and Codex`,
    '',
    'Usage: fence <command> [options]',
    '',
    'Read-only commands:',
    '  check [--policy f]   validate the policy; warn on allow rules matching runs-repo-code',
    '  test [--policy f]    run the policy examples',
    '  log                  (not yet implemented)',
    '  doctor               (not yet implemented)',
    '  replay               (not yet implemented)',
    '  version              print the version',
    '  help                 print this help',
    '',
    'Human-only commands (not yet implemented):',
    '  install, upgrade, rollback, edit, apply, repair, hatch, allow-once, uninstall, lock',
    '',
    'The default policy is ~/.config/fence/policy.json.',
  ].join('\n');
}

const defaultIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

export function main(args = [], io = defaultIo) {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(helpText());
        return 0;
      case 'version':
      case '--version':
      case '-V':
        io.out(`fence ${packageVersion()}`);
        return 0;
      case 'check':
        return runCheck(rest, io);
      case 'test':
        return runTest(rest, io);
      default:
        if (NOT_YET.has(command)) {
          io.err(`fence: "${command}" is not yet implemented`);
          return 1;
        }
        io.err(`fence: unknown command ${JSON.stringify(command)}; run "fence help"`);
        return 1;
    }
  } catch (err) {
    io.err(`fence: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
