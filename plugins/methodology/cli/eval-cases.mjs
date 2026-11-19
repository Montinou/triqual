// `triqual eval cases <pluginDir> [--case <name>]... [--runs <n>]`: runs named replay cases of a plugin once. Each case is
// its own `claude plugin eval` spawn with a single --case (the command keeps only the last of a repeated --case), one after
// another, through the credential chain as `triqual eval skills` does (lib/eval-auth.mjs): a case that hit a usage limit is
// thrown away (its output directory is removed, no verdict) and runs again, whole, on the next entry. Prints
// `<case> pass|fail <passed>/<runs> <usd>` per case and `<k> of <n> cases passed, <usd> USD` last. Never publishes, never
// trusts the plugin, never writes under <pluginDir>: each attempt has its own temp output directory, removed afterwards.
// A case whose directory holds a case.yaml with an indented `scaffold_script:` is spawned with --scaffold and the Bash,
// Write and Edit tools; no other case gets them. A run that ended on an API error is no verdict: only the entry name and the
// count are printed (the error text may carry account detail), never case text or a secret.
// Exit codes: 0 every case passes; 1 a case fails, a credential or suite problem, no aggregate left; 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthError, ChainExhausted, LIMIT_NOTE, PAID_NOTE, authPath, childEnv, loadChain, usableChain, withChain } from './lib/eval-auth.mjs';
import { SuiteError, runSuite, suiteErrors, suiteLimited, toUnits } from './lib/eval-skills.mjs';
import { spawnCapture } from './lib/eval-judge.mjs';

export const SUMMARY = 'run named replay cases of a plugin once (cases)';

const DEFAULT_RUNS = 3;
const CASE_NAME = /^[a-z0-9-]+$/;
// The key sits under `context:` in a case.yaml: an indented line with a value (a comment or a bare key does not count).
const SCAFFOLD_LINE = /^[ \t]+scaffold_script:[ \t]*\S/m;

const USAGE = [
  'usage:',
  '  triqual eval cases <pluginDir> [--case <name>]... [--runs <n>]',
  '      Runs `claude plugin eval <pluginDir> --eval-dir evals/cases --ablation none --no-publish --judge-model sonnet --runs <n> --case <name>`',
  '      once for each named case, one after another, and prints `<case> pass|fail <passed>/<runs> <usd>` per case, then',
  '      `<k> of <n> cases passed, <usd> USD`. A case name is a directory of <pluginDir>/evals/cases/ ([a-z0-9-] only, never a glob);',
  '      with no --case every directory there is run. --runs defaults to 3; a case passes on a majority of its runs.',
  '      The model credentials come from the chain in TRIQUAL_EVAL_AUTH_FILE, else ~/.config/triqual/eval-auth.json (no file:',
  '      the ambient login). A case that hit a usage limit is discarded and run again, whole, on the next entry.',
  '      A case whose case.yaml names a scaffold_script is run with --scaffold and the Bash, Write and Edit tools:',
  '      --scaffold runs the case author\'s bash as you, so use it only for plugin directories you wrote.',
  '      Exit 0 when every case passes, 1 when a case fails or the suite or the credentials failed, 2 on a usage error.',
  '  triqual eval cases --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = { cases: [], positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts.positional.push(arg); continue; }
    const m = /^--(case|runs)(?:=(.*))?$/s.exec(arg);
    if (!m) return { error: `unknown argument ${clip(arg)}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    if (m[1] === 'case') opts.cases.push(value); else opts.runs = value;
  }
  return { opts };
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function isScaffolded(caseDir) {
  try { return SCAFFOLD_LINE.test(readFileSync(join(caseDir, 'case.yaml'), 'utf8')); } catch { return false; }
}

const usd = (n) => n.toFixed(2);

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, spawn = spawnCapture,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval cases: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval cases: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (opts.positional.length === 0) return usage('<pluginDir> is needed');
  if (opts.positional.length > 1) return usage('only one <pluginDir> is taken');
  const pluginDir = opts.positional[0];
  let runs = DEFAULT_RUNS;
  if (opts.runs !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(opts.runs)) return usage('--runs must be a whole number of at least 1');
    runs = Number(opts.runs);
  }

  // Every name is checked before any spawn: names are literal directory names, never globs or paths.
  const casesDir = join(pluginDir, 'evals', 'cases');
  let names = [...new Set(opts.cases)];
  for (const name of names) {
    if (!CASE_NAME.test(name)) return usage(`case name ${clip(name)} must match ${CASE_NAME}`);
    if (!isDir(join(casesDir, name))) return usage(`no case directory ${name} under evals/cases`);
  }
  if (opts.cases.length === 0) {
    try {
      names = readdirSync(casesDir).filter((n) => CASE_NAME.test(n) && isDir(join(casesDir, n))).sort();
    } catch { names = []; }
    if (names.length === 0) return usage('no case directories under evals/cases');
  }

  const home = env.HOME || homedir();
  let chain;
  try { chain = loadChain(authPath(env, home)); } catch (err) {
    if (err instanceof AuthError) return fail(err.message);
    throw err;
  }
  const usable = usableChain(chain, { paid: false });
  const paidOnly = chain.length > 0 && usable.length === 0;

  // One case attempt on one entry: a limited run's output directory is removed and the case moves to the next entry.
  const chainRun = withChain(usable, async ({ name, scaffold }, entry) => {
    const outDir = mkdtempSync(join(tmpdir(), 'triqual-eval-cases-'));
    try {
      const aggregate = await runSuite({
        pluginDir, outDir, spawn, env: childEnv(entry, env, { home }), caseName: name, runs, scaffold,
      });
      return suiteLimited(aggregate) ? { limit: true } : { aggregate };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  let code = 0;
  let passed = 0;
  let total = 0;
  let spent = 0;
  let ranAll = true;
  for (const name of names) {
    let ran;
    try {
      ran = await chainRun.run({ name, scaffold: isScaffolded(join(casesDir, name)) });
    } catch (err) {
      if (err instanceof ChainExhausted) {
        stderr.write(paidOnly ? `triqual eval cases: ${PAID_NOTE}\n` : `triqual eval cases: ${LIMIT_NOTE} (tried: ${err.tried.join(', ')})\n`);
      } else if (err instanceof AuthError || err instanceof SuiteError) {
        stderr.write(`triqual eval cases: case ${name}: ${err.message}\n`);
      } else {
        throw err;
      }
      code = 1;
      ranAll = false;
      break;
    }
    const { aggregate } = ran.result;
    const errored = suiteErrors(aggregate);
    if (errored > 0) {
      stderr.write(`triqual eval cases: case ${name}: auth ${ran.entry.name}: ${errored} ${errored === 1 ? 'run' : 'runs'} ended on an API error; the case has no verdict\n`);
      code = 1;
      ranAll = false;
      break;
    }
    // The aggregate holds the one case of this spawn; its name is the directory's, or the `name` of its case.yaml.
    const index = aggregate.cases.length === 1 ? 0 : aggregate.cases.findIndex((c) => c?.name === name);
    if (index < 0) {
      stderr.write(`triqual eval cases: case ${name}: the aggregate result has no such case\n`);
      code = 1;
      ranAll = false;
      break;
    }
    const withRuns = Array.isArray(aggregate.cases[index]?.arms?.with) ? aggregate.cases[index].arms.with : [];
    const unit = toUnits(aggregate)[index];
    stdout.write(`${name} ${unit.pass ? 'pass' : 'fail'} ${withRuns.filter((r) => r?.passed === true).length}/${withRuns.length} ${usd(unit.usd)}\n`);
    total += 1;
    spent += unit.usd;
    if (unit.pass) passed += 1; else code = 1;
  }
  if (ranAll) stdout.write(`${passed} of ${total} cases passed, ${usd(spent)} USD\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
