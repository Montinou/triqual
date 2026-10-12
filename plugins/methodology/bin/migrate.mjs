// `triqual migrate [--help]`: moves this machine from the legacy marketplace to the triqual one (spec 4), one line per
// step as it runs (lib/migrate-steps.mjs). Idempotent: a second run changes nothing. Bootstrap runs it as its migrate
// step with the CLI installer; run alone, the CLI step is skipped (run node bin/bootstrap.mjs from the clone).
// Exit codes: 0 done (and for --help/-h, which writes nothing), 1 a step failed, 2 an unknown argument (nothing run).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { BRAND } from './lib/brand.mjs';
import { migrate } from './lib/migrate-steps.mjs';
import { realRun } from './lib/run.mjs';

const USAGE = `usage: ${BRAND.cli} migrate
  Moves this machine from the ${BRAND.legacy.marketplace} marketplace to ${BRAND.marketplace}: backup, CLI, marketplace
  and plugins, settings and managed-section references, config/state/data dirs, Codex and Grok, the registered repos
  still on the ${BRAND.legacy.cli} gate, then the legacy scan. A second run changes nothing.
  -h, --help  print this help`;

// The CLI with its dependencies injected: resolves { code, stdout, stderr }; the step lines go to `log`. `isTTY` and
// `confirm` let Codex's one-time AGENTS.md split be accepted on a terminal.
export async function migrateCli(argv, { home, run, now = new Date(), log = () => {}, installCli, isTTY = false, confirm }) {
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (argv.length > 0) {
    return { code: 2, stdout: '', stderr: `${BRAND.cli} migrate: unknown argument ${argv[0]}\n${USAGE}\n` };
  }
  const { code } = await migrate({ home, run, now, log, installCli, isTTY, confirm });
  return { code, stdout: '', stderr: '' };
}

// A y/N question on the terminal; only yes or y (any case) is yes.
async function ttyConfirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  migrateCli(process.argv.slice(2), {
    home: homedir(), run: realRun, log: (line) => process.stdout.write(`${line}\n`),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), confirm: ttyConfirm,
  }).then(({ code, stdout, stderr }) => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${BRAND.cli} migrate: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
