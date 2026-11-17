// `triqual eval plan-review --plan <plan.md> --audit <critical>,<important>,<minor> [--arm <experiment>/<arm>]`: records
// one plan-review in the role-eval store: the plan's task, phase, parallelism and runner-only figures from
// `triqual plan lanes <plan> --json` (read on exit 0, a clean layout, and on exit 1, a layout with violations), the
// plan review's finding counts, and the USD the planner subagent cost (from the transcripts; null when none matches).
// A plan has one record: a second run prints `already recorded`. Prints `recorded` or `already recorded`, never
// transcript text. Exit codes: 0 recorded or already recorded (also --help); 2 usage, a lanes failure (exit 2 or no
// usable report) or a record that fails validation; 1 a store failure. node: built-ins only. main() is exported for
// tests and runs only when this file is the entry point.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transcriptsRoot } from './lib/eval-paths.mjs';
import { plannerUsd } from './lib/eval-plans.mjs';
import { appendRecord, recordKey, storePath, validateRecord } from './lib/role-eval.mjs';

const LANES_TIMEOUT_MS = 30000;
const GIT_TIMEOUT_MS = 10000;
const LANES_BUFFER = 16 * 1024 * 1024;
const COUNT = /^[0-9]{1,9}$/;

// The line `triqual eval` lists this subcommand under.
export const SUMMARY = 'record a plan-review (lanes figures, audit counts, planner cost) in the role-eval store';

const USAGE = [
  'usage:',
  '  triqual eval plan-review --plan <plan.md> --audit <critical>,<important>,<minor> [--arm <experiment>/<arm>]',
  '      Records one plan-review once per plan: tasks, phases, parallelism and runner-only tasks from',
  '      `triqual plan lanes <plan> --json` (a layout with violations is recorded from its report), the audit finding',
  '      counts, and the planner\'s USD from the subagent transcripts whose description is `planner <plan file name>`',
  '      (null when there is none). Prints recorded or already recorded. Exit 0 recorded or already recorded, 2 usage,',
  '      a lanes failure or an invalid record, 1 a store failure.',
  '  triqual eval plan-review --help',
  '',
].join('\n');

// { flags } or { error }; `--flag=value` works too.
function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(args[i]);
    const name = eq ? eq[1] : args[i];
    if (['--plan', '--audit', '--arm'].includes(name)) {
      const value = eq ? eq[2] : args[++i];
      if (value === undefined) return { error: `${name} needs a value` };
      flags[name] = value;
    } else {
      return { error: `unknown argument ${args[i].length > 40 ? `${args[i].slice(0, 40)}...` : args[i]}` };
    }
  }
  return { flags };
}

// `triqual plan lanes <plan> --json`: { status, stdout }; status is not a number when the command cannot run.
function spawnLanes(plan, { cwd, env }) {
  const res = spawnSync('triqual', ['plan', 'lanes', plan, '--json'], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: LANES_TIMEOUT_MS, maxBuffer: LANES_BUFFER,
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

// The realpath of the git common dir of `cwd`, or null outside a repository.
function gitCommonDir(cwd, env) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS,
    }).trim();
    return out === '' ? null : realpathSync(out);
  } catch {
    return null;
  }
}

const errorCode = (err) => (typeof err?.code === 'string' ? err.code : 'error');

// Runs the command and returns its exit code; every dependency is injected so a test never touches the real home, the
// real transcripts or a real `triqual`. `lanes(plan, { cwd, env })` returns { status, stdout } as spawnLanes does.
export function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), now = new Date(), lanes = spawnLanes,
} = {}) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    stdout.write(USAGE);
    return 0;
  }
  const usage = (message) => { stderr.write(`triqual eval plan-review: ${message}\n${USAGE}`); return 2; };
  const parsed = parseArgs(argv);
  if (parsed.error) return usage(parsed.error);
  const { '--plan': plan, '--audit': audit, '--arm': arm } = parsed.flags;
  if (plan === undefined || plan === '') return usage('needs --plan <plan.md>');
  if (audit === undefined) return usage('needs --audit <critical>,<important>,<minor>');
  const counts = audit.split(',');
  if (counts.length !== 3 || !counts.every((c) => COUNT.test(c))) return usage('--audit needs three counts: <critical>,<important>,<minor>');

  let report = null;
  try {
    const res = lanes(plan, { cwd, env });
    if (res?.status === 0 || res?.status === 1) report = JSON.parse(res.stdout);
  } catch { /* an unreadable report is handled below */ }
  if (report === null || typeof report !== 'object') {
    stderr.write('triqual eval plan-review: cannot read the lanes report (triqual plan lanes --json did not give one)\n');
    return 2;
  }

  const home = env.HOME || homedir();
  const planFile = basename(plan);
  const record = {
    v: 2,
    at: now.toISOString(),
    kind: 'plan-review',
    plan: planFile.replace(/\.md$/, ''),
    arm: arm ?? null,
    tasks: report.tasks,
    phases: report.phases,
    parallelism: report.parallelism,
    runnerOnly: report.runnerOnly,
    auditFindings: { critical: Number(counts[0]), important: Number(counts[1]), minor: Number(counts[2]) },
    plannerUsd: plannerUsd(transcriptsRoot(env, home), planFile),
  };
  const verdict = validateRecord(record);
  if (!verdict.ok) {
    stderr.write(`triqual eval plan-review: invalid record: field ${verdict.field}\n`);
    return 2;
  }
  const commonDir = gitCommonDir(cwd, env);
  if (commonDir === null) {
    stderr.write('triqual eval plan-review: must run inside a git repository\n');
    return 2;
  }

  const store = storePath(env, home);
  // The key of `triqual role-eval record --plan <plan file>` for this plan, so one plan has one record by either command.
  const key = recordKey({ commonDir, plan, kind: 'plan-review' });
  try {
    const made = mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    const result = appendRecord(store.file, record, { key, isDefault: store.isDefault, created: made !== undefined });
    stdout.write(result === 'written' ? 'recorded\n' : 'already recorded\n');
    return 0;
  } catch (err) {
    stderr.write(`triqual eval plan-review: cannot write the store (${errorCode(err)})\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
