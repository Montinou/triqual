// fence CLI entry. bin/fence.mjs calls main(args) with the arguments after the script path
// (args[0] is the subcommand) and uses the returned number as the exit code. main returns the number
// itself for the commands that run synchronously (help, version, check, test, log) and a Promise of
// it for doctor and the human-only commands; bin/fence.mjs and the installed shim await either.
//
//   main(args, io?, host?)
//     io    {out, err}: the output lines (default stdout / stderr)
//     host  the machine the wired commands act on (stdin, env, home, runner, ...), see commands.mjs;
//           production passes none, so realHost() is used. Only the code that calls main() can set it:
//           no argument and no environment variable reaches a host field or an implementation.
//
// Every human-only command goes through its row of the table in humanonly.mjs: requireHuman first
// (an interactive terminal on stdin, no agent session variable), then the table's sudo gate for the
// commands it gates, then the implementation. doctor is read-only and open to the agent.

import { runCheck, runTest } from './check.mjs';
import { humanOnly } from './humanonly.mjs';
import { runLog } from './log.mjs';
import { packageVersion } from './version.mjs';

const NOT_YET = new Set(['replay']);

export function helpText() {
  return [
    `fence ${packageVersion()}: a fail-closed policy harness for Claude Code and Codex`,
    '',
    'Usage: fence <command> [options]',
    '',
    'Read-only commands:',
    '  check [--policy f]   validate the policy; warn on allow rules matching runs-repo-code',
    '  test [--policy f]    run the policy examples',
    '  log [--session id] [--denies | --undecided | --unknown-tools | --agent id --reads | --latency] [--state-dir d]',
    '                       decision log views (plain text)',
    '  doctor [--json]      report on the install, the hosts, the policy, the hatch and sudo (exit 1 on a failure)',
    '  version              print the version',
    '  help                 print this help',
    '',
    'Human-only commands (an interactive terminal; refused inside an agent session):',
    '  install --version <exact> [--from-tarball <file>] [--policy example|strict]',
    '  upgrade --version <exact>',
    '  rollback             go back to the previous version (sudo)',
    '  edit                 open a copy of the policy in $EDITOR',
    '  apply <draft>        validate, diff, test and apply a policy draft (sudo when it weakens the policy)',
    '  repair               reinstall from the newest passing version; clear an integrity denial (sudo)',
    '  hatch [--for <duration>] | hatch --close   open or close the escape hatch (sudo)',
    '  allow-once <path>    one single-use write grant (sudo)',
    '  uninstall [--purge]  remove fence (sudo)',
    '',
    'Not yet implemented: replay, lock',
    '',
    'The default policy is ~/.config/fence/policy.json.',
  ].join('\n');
}

const defaultIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

// doctor and the human-only commands: the wiring module (and everything it pulls in) loads only now.
async function runWired(command, rest, io, hostOverride) {
  try {
    const commands = await import('./commands.mjs'); // registers the implementations
    const host = { ...commands.realHost(), ...hostOverride };
    if (command === 'doctor') return await commands.runDoctor(rest, io, host);
    const code = await humanOnly(command).handler({
      command,
      args: rest,
      io,
      host,
      stdin: host.stdin,
      env: host.env,
      run: host.run,
    });
    // an implementation answers its exit code; anything else is a failure, never a silent success
    return Number.isInteger(code) ? code : 1;
  } catch (err) {
    io.err(`fence: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function main(args = [], io = defaultIo, host = undefined) {
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
      case 'log':
        return runLog(rest, io);
      default:
        if (command === 'doctor' || humanOnly(command) !== undefined) return runWired(command, rest, io, host);
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
