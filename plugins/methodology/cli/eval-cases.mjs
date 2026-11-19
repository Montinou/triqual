// `triqual eval cases <pluginDir> [--case <name>]... [--runs <n>]`: runs named replay cases of a plugin once. Each case is
// its own `claude plugin eval` spawn with a single --case (the command keeps only the last of a repeated --case), one after
// another, through the credential chain as `triqual eval skills` does (lib/eval-auth.mjs): a case that hit a usage limit is
// thrown away (its output directory is removed, no verdict) and runs again, whole, on the next entry. Prints
// `<case> pass|fail <passed>/<runs> <usd>` per case and `<k> of <n> cases passed, <usd> USD` last. Never publishes, never
// trusts a plugin it did not stage, never writes under <pluginDir>: each attempt has its own temp output directory, removed
// afterwards. Own code (a plugin tracked in the git repository of the current directory; every other directory,
// an `eval variant` output included, is never trusted) is copied to a temp directory first, its plugin.json
// `dependencies` removed (the eval sandbox provides none, so a plugin with them has unknown skills), and run from the copy
// with --trust-plugin (an untrusted directory is refused when there is no terminal to ask); the copy is removed afterwards.
// A case whose directory holds a case.yaml with an indented `scaffold_script:` is spawned with --scaffold and the Bash,
// Write and Edit tools; no other case gets them. A run that ended on an API error is no verdict: only the entry name and the
// count are printed (the error text may carry account detail), never case text or a secret.
// Exit codes: 0 every case passes; 1 a case fails, a credential or suite problem, no aggregate left; 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  '      Own code is a plugin tracked in this repository. It runs from a staged copy with `dependencies` removed and',
  '      --trust-plugin; every other directory, an `eval variant` output included, is never trusted and runs as it is (evaluate',
  '      a variant from a terminal: the first `claude plugin eval` run asks to trust it).',
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

// True when `pluginDir` is own code: a plugin tracked in the git repository of `cwd`. Its realpath is under the repository's
// top level (no repository: no) and its .claude-plugin/plugin.json is tracked (`git ls-files --error-unmatch`, from the top).
// Nothing a directory holds can say otherwise.
function isOwnCode(pluginDir, cwd) {
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (top.status !== 0 || top.stdout.trim() === '') return false;
    const root = realpathSync(top.stdout.trim());
    const real = realpathSync(pluginDir);
    const inside = relative(root, real);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
    const manifest = relative(root, join(real, '.claude-plugin', 'plugin.json'));
    const tracked = spawnSync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', manifest], { cwd: root, stdio: 'ignore' });
    return tracked.status === 0;
  } catch { return false; }
}

// The text of a plugin.json without its top-level `dependencies` members, every other byte as it was: each member and one
// comma beside it are cut. Text that is not a JSON object, or has no such member, comes back as it is.
export function withoutDependencies(text) {
  // A key repeated in the object leaves the last one for JSON.parse, so cut members until none is left.
  for (;;) {
    const next = withoutFirstDependencies(text);
    if (next === text) return text;
    text = next;
  }
}

function withoutFirstDependencies(text) {
  try { if (JSON.parse(text)?.dependencies === undefined) return text; } catch { return text; }
  // Walk the top-level members: `start` is where one begins (its key), `last` the last non-blank character seen.
  const members = [];
  let depth = 0;
  let start = -1;
  let last = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && start < 0) start = i;
      last = j;
      i = j;
    } else if (depth === 1 && (c === ',' || c === '}')) {
      if (start >= 0) members.push({ start, end: last + 1 });
      start = -1;
    } else if (!/\s/.test(c)) {
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') depth -= 1;
      else if (depth === 1 && start < 0) start = i;
      last = i;
    }
  }
  const at = members.findIndex((m) => /^"dependencies"\s*:/.test(text.slice(m.start, m.end)));
  if (at < 0) return text;
  const m = members[at];
  if (at + 1 < members.length) return text.slice(0, m.start) + text.slice(members[at + 1].start);
  if (at > 0) return text.slice(0, members[at - 1].end) + text.slice(m.end);
  return text.slice(0, m.start) + text.slice(m.end);
}

// A copy of `pluginDir` in a fresh temp directory (under the same base name) without the `dependencies` of its plugin.json.
// Returns { root, dir }: remove `root` afterwards.
function stage(pluginDir) {
  const root = mkdtempSync(join(tmpdir(), 'triqual-eval-stage-'));
  try {
    const dir = join(root, basename(resolve(pluginDir)));
    cpSync(pluginDir, dir, { recursive: true });
    const manifest = join(dir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifest)) {
      const text = readFileSync(manifest, 'utf8');
      const next = withoutDependencies(text);
      if (next !== text) writeFileSync(manifest, next);
    }
    return { root, dir };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, spawn = spawnCapture, cwd = process.cwd(),
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

  // Own code runs from a staged copy (no `dependencies`) with --trust-plugin; anything else runs as it is. The case names
  // and scaffold lines are read from <pluginDir> itself, which the copy equals.
  let staged = null;
  if (isOwnCode(pluginDir, cwd)) {
    try { staged = stage(pluginDir); } catch (err) { return fail(`could not stage ${clip(pluginDir)}: ${err?.code ?? 'error'}`); }
    stderr.write(`triqual eval cases: staged ${pluginDir} (own code: dependencies removed, --trust-plugin)\n`);
  }
  const target = staged === null ? pluginDir : staged.dir;
  try {
    // One case attempt on one entry: a limited run's output directory is removed and the case moves to the next entry.
    const chainRun = withChain(usable, async ({ name, scaffold }, entry) => {
      const outDir = mkdtempSync(join(tmpdir(), 'triqual-eval-cases-'));
      try {
        const aggregate = await runSuite({
          pluginDir: target, outDir, spawn, env: childEnv(entry, env, { home }), caseName: name, runs, scaffold, trust: staged !== null,
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
  } finally {
    if (staged !== null) rmSync(staged.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
