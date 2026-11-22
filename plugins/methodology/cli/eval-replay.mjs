// `triqual eval replay harvest --role <R> [--since <ISO>] [--json]`: harvests past dispatches of a role into replay cases
// (cli/lib/eval-replay-harvest.mjs) and prints counts only: never a prompt, a transcript line or a case text. The cases are
// written under <evals dir>/replay/cases/<id>/. Exit codes: 0 done (or --help); 1 the harvest itself failed; 2 usage (no or an
// unknown action, an unknown role, a bad flag or --since, no role version and no --since, an invalid replay-repos file).
// node: built-ins and the eval libraries only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { REASONS, harvest, resolveCheckout, roleVersion } from './lib/eval-replay-harvest.mjs';
import { loadReplayRepos, replayReposPath } from './lib/eval-replay-repos.mjs';
import { loadRoleRecords } from './lib/eval-tasks.mjs';
import { storePath } from './lib/role-eval.mjs';

export const SUMMARY = 'harvest past role dispatches into replay cases and run them per arm (replay)';

const ROLES = ['tdd-implementer', 'review-fixer'];

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
  '  triqual eval replay --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
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

function textLine(role, { found, kept, excluded }) {
  const reasons = REASONS.filter((r) => excluded[r] > 0).map((r) => `${r} ${excluded[r]}`);
  return `${role}: dispatches ${found}, cases kept ${kept}${reasons.length > 0 ? `; excluded ${reasons.join(', ')}` : ''}\n`;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const usage = (m) => { stderr.write(`triqual eval replay: ${m}\n${USAGE}`); return 2; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const [action, ...rest] = argv;
  if (action === undefined) return usage('an action is needed');
  if (action !== 'harvest') return usage(`unknown action ${clip(action)}`);
  const { opts, error } = parseArgs(rest);
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
