// `triqual eval replay harvest --role <R> [--since <ISO>] [--json]`: harvests past dispatches of a role into replay cases
// (cli/lib/eval-replay-harvest.mjs) under <evals dir>/replay/cases/<id>/.
// `triqual eval replay run --experiment <id> [--sample <n>] [--runs <k>] [--seed <s>] [--concurrency <c>] [--auth <arm>=<file>]... [--paid] [--dry-run]`:
// plans or runs a role experiment's replay per arm (cli/lib/eval-replay-run.mjs), appending one line per finished unit to
// <evals dir>/replay/results.jsonl. Both actions print counts only: never case content, prompt text or a credential.
// Exit codes: 0 done (or --help); 1 harvest/replay failed, auth/plugin refusal or usage limits exhausted; 2 usage (no or an
// unknown action, bad flags, unknown arm/experiment, non-replayable experiment, no triqual checkout, invalid replay-repos file).
// node: built-ins and the eval libraries only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChainExhausted, LIMIT_NOTE } from './lib/eval-auth.mjs';
import { loadExperiments } from './lib/eval-experiments.mjs';
import { evalsDir, experimentsPath, transcriptsRoot } from './lib/eval-paths.mjs';
import { methodologyPluginDir } from './lib/eval-replay-agent.mjs';
import { REASONS, harvest, resolveCheckout, roleVersion } from './lib/eval-replay-harvest.mjs';
import { loadReplayRepos, replayReposPath } from './lib/eval-replay-repos.mjs';
import { RESULTS_FILE, armChains, planReplay, runReplay } from './lib/eval-replay-run.mjs';
import { loadRoleRecords } from './lib/eval-tasks.mjs';
import { storePath } from './lib/role-eval.mjs';

export const SUMMARY = 'harvest past role dispatches into replay cases and run them per arm (replay)';

const ROLES = ['tdd-implementer', 'review-fixer'];
const DEFAULTS = { sample: 40, runs: 1, seed: 1, concurrency: 3 };

const USAGE = [
  'usage:',
  '  triqual eval replay harvest --role <R> [--since <ISO>] [--json]',
  `      Reads the past dispatches of role <R> (${ROLES.join(' or ')}) from the Claude Code transcripts and keeps one replay case`,
  '      per dispatch whose hidden tests fail at the base commit and pass at the original one, each in a fresh clone (no model',
  '      call). Cases are written under <evals dir>/replay/cases/<id>/ (case.json and the recovered briefs); a validated case is',
  '      never rewritten, and a dispatch that fails validation is only counted (validation-failed), so a later harvest retries it.',
  '      Prints counts only: `<role>: dispatches <found>, cases kept <kept>; excluded <reason> <n>, ...`, or',
  '      `{ role, found, kept, excluded }` with --json.',
  '      --since is an ISO date or date-time; it defaults to the date of the last commit of the role file in the triqual checkout.',
  '      A repository is validated only when ~/.config/triqual/replay-repos.json (or $XDG_CONFIG_HOME/triqual/) has an entry for it:',
  '      { "<repo name>": { "setup": "<shell command>", "timeoutSeconds": 600 } }.',
  `      Exclusion reasons: ${REASONS.join(', ')}.`,
  '  triqual eval replay run --experiment <id> [--sample <n>] [--runs <k>] [--seed <s>] [--concurrency <c>] [--auth <arm>=<file>]... [--paid] [--dry-run]',
  '      Replays harvested cases of an active or paused role experiment in isolated clones per arm and appends one JSONL line per',
  `      finished unit to <evals dir>/${RESULTS_FILE} (already-recorded units are skipped on rerun). Prints counts only, never`,
  '      case content, prompt text or credentials.',
  `      Defaults: --sample ${DEFAULTS.sample}, --runs ${DEFAULTS.runs}, --seed ${DEFAULTS.seed}, --concurrency ${DEFAULTS.concurrency}.`,
  '      --auth <arm>=<file> (repeatable; a leading ~/ is expanded with HOME) sets one arm\'s credential chain file (otherwise',
  '      TRIQUAL_EVAL_AUTH_FILE or ~/.config/triqual/eval-auth.json); an arm not in the experiment exits 2.',
  '      --paid opts in to chain entries marked "paid": true (excluded by default).',
  '      --dry-run prints the sampled cases per repo, the run count and the USD estimate per arm, spawning nothing.',
  '      Refusal rules (exit 1 before any spawn): the ambient login is never used (every arm needs a credential chain file);',
  '      a paid-only chain without --paid is refused; no user-scope methodology plugin installed is refused. Exhausting every',
  '      credential entry on usage limits or failing to start the claude binary (TRIQUAL_CLAUDE_BIN, default claude) exits 1.',
  '      Exit 2 on usage errors, an unknown or non-replayable experiment, no triqual checkout, or an invalid replay-repos file.',
  '  triqual eval replay --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);
const fmtUsd = (n) => (n === null ? '-' : n.toFixed(2));

function parseHarvestArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    const m = /^--(role|since)(?:=(.*))?$/s.exec(arg);
    if (!m) return { error: `unknown argument ${clip(arg)}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

function parseRunArgs(argv) {
  const opts = { ...DEFAULTS, auth: [], paid: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--paid') { opts.paid = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    const m = /^--(experiment|sample|runs|seed|concurrency|auth)(?:=(.*))?$/s.exec(arg);
    if (!m) return { error: `unknown argument ${clip(arg)}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    if (m[1] === 'auth') {
      const eq = value.indexOf('=');
      if (eq <= 0 || eq === value.length - 1) return { error: '--auth needs <arm>=<file>' };
      opts.auth.push([value.slice(0, eq), value.slice(eq + 1)]);
    } else if (m[1] === 'experiment') {
      opts.experiment = value;
    } else {
      const n = Number(value);
      const min = m[1] === 'seed' ? 0 : 1;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) {
        return { error: `--${m[1]} needs ${min === 0 ? 'a non-negative' : 'a positive'} integer` };
      }
      opts[m[1]] = n;
    }
  }
  return { opts };
}

function textLine(role, { found, kept, excluded }) {
  const reasons = REASONS.filter((r) => excluded[r] > 0).map((r) => `${r} ${excluded[r]}`);
  return `${role}: dispatches ${found}, cases kept ${kept}${reasons.length > 0 ? `; excluded ${reasons.join(', ')}` : ''}\n`;
}

async function runAction(rest, { env, stdout, stderr, cwd, spawn, usage }) {
  const { opts, error } = parseRunArgs(rest);
  if (error) return usage(error);
  if (opts.experiment === undefined) return usage('--experiment is needed');

  const home = env.HOME || homedir();
  const evals = evalsDir(env, home);
  let list;
  try { list = loadExperiments(experimentsPath(env, home)); } catch { return usage('experiments file: unreadable or not JSON'); }
  const experiment = list.find((e) => e && typeof e === 'object' && e.id === opts.experiment);
  if (!experiment) return usage(`no experiment ${clip(opts.experiment)}`);

  const armNames = experiment.arms && typeof experiment.arms === 'object' ? Object.keys(experiment.arms) : [];
  const authFiles = {};
  for (const [arm, rawFile] of opts.auth) {
    if (!armNames.includes(arm)) return usage(`unknown arm ${clip(arm)} for experiment ${experiment.id}`);
    authFiles[arm] = expandHome(rawFile, home);
  }

  const checkout = resolveCheckout({ cwd });
  if (checkout === null) return usage('no triqual checkout found (needed for the role file and version)');

  let plan;
  try {
    plan = planReplay({ experiment, evals, checkout, n: opts.sample, seed: opts.seed, runs: opts.runs });
  } catch (err) {
    return usage(err?.message ?? 'invalid experiment');
  }

  if (opts.dryRun) {
    const byRepo = Object.keys(plan.perRepo).sort().map((r) => `${r} ${plan.perRepo[r]}`).join(', ') || 'none';
    stdout.write(`sample ${plan.cases.length} cases: ${byRepo}\n`);
    stdout.write(`runs ${plan.runCount}\n`);
    for (const [arm, usd] of Object.entries(plan.estimate)) {
      stdout.write(`estimate ${arm} ${fmtUsd(usd)} USD\n`);
    }
    return 0;
  }

  let repos;
  try { repos = loadReplayRepos(replayReposPath(env, home)); } catch (err) { return usage(err.message); }

  const chains = armChains({ experiment, authFiles, env, home, paid: opts.paid });
  if (!chains.ok) {
    stderr.write(`triqual eval replay: ${chains.reason}\n`);
    return 1;
  }

  const pluginDir = methodologyPluginDir(home);
  if (pluginDir === null) {
    stderr.write('triqual eval replay: methodology plugin is not installed at user scope\n');
    return 1;
  }

  const bin = env.TRIQUAL_CLAUDE_BIN || 'claude';
  let summary;
  try {
    summary = await runReplay({
      experiment, plan, chains: chains.chains, runs: opts.runs, concurrency: opts.concurrency,
      evals, checkout, pluginDir, repos, bin, env, home, ...(spawn ? { spawn } : {}),
    });
  } catch (err) {
    if (err instanceof ChainExhausted) {
      stderr.write(`triqual eval replay: ${LIMIT_NOTE} (tried: ${err.tried.join(', ')})\n`);
      return 1;
    }
    stderr.write(`triqual eval replay: ${err?.message ?? 'replay failed'}\n`);
    return 1;
  }

  for (const arm of Object.keys(experiment.arms)) {
    const s = summary[arm];
    const accounts = Object.entries(s.accounts).map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
    const u = s.literals.unnamed;
    const n = s.literals.named;
    stdout.write(`${arm}  counted ${s.counted}  passes ${s.passes}  usd ${fmtUsd(s.usd)}  accounts ${accounts}  unnamed-literals ${u.passes}/${u.counted}  rest ${n.passes}/${n.counted}\n`);
  }
  return 0;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), spawn } = {}) {
  const usage = (m) => { stderr.write(`triqual eval replay: ${m}\n${USAGE}`); return 2; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const [action, ...rest] = argv;
  if (action === undefined) return usage('an action is needed');
  if (action === 'run') return runAction(rest, { env, stdout, stderr, cwd, spawn, usage });
  if (action !== 'harvest') return usage(`unknown action ${clip(action)}`);
  const { opts, error } = parseHarvestArgs(rest);
  if (error) return usage(error);
  if (opts.role === undefined) return usage('--role is needed');
  if (!ROLES.includes(opts.role)) return usage(`role ${clip(opts.role)} is not one of ${ROLES.join(', ')}`);
  if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since))) return usage('--since must be an ISO date or date-time');

  const home = env.HOME || homedir();
  let repos;
  try { repos = loadReplayRepos(replayReposPath(env, home)); } catch (err) { return usage(err.message); }
  const version = roleVersion(opts.role, resolveCheckout({ cwd }));
  const since = opts.since ?? version?.at;
  if (since === undefined) return usage('no role version (no triqual checkout holds the role file): pass --since');

  let result;
  try {
    result = harvest({
      role: opts.role, since, root: transcriptsRoot(env, home), evals: evalsDir(env, home), version,
      records: loadRoleRecords(storePath(env, home).file), repos, env,
    });
  } catch (err) {
    stderr.write(`triqual eval replay: harvest failed: ${err?.code ?? 'error'}\n`);
    return 1;
  }
  const { found, kept, excluded } = result;
  stdout.write(opts.json ? `${JSON.stringify({ role: opts.role, found, kept, excluded })}\n` : textLine(opts.role, result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
