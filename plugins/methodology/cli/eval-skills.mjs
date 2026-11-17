// `triqual eval skills --experiment <id> [--paid]`: the skill replay of an active skill experiment. Each arm (`{ pluginDir }`)
// runs once as one `claude plugin eval` suite (lib/eval-skills.mjs) and the run is written to
// <evals>/skill-runs/<id>/<arm>.json as { experiment, arm, at, auth, units: [{ caseId, pass, usd }] }, which the experiments
// report reads. The suites run through the credential chain (lib/eval-auth.mjs): a suite that hit a usage limit is thrown
// away (its output directory is removed, no verdict is recorded) and runs again, whole, on the next entry, which stays
// current for the later arms; after the last entry the command exits 1 with no file for that arm. A chain entry marked paid
// is used only with --paid. A suite with a run that ended on a non-limit API error (an authentication error) is not scored:
// no file for that arm, exit 1, only the entry name and the count of errored runs are printed. Nothing is published: `claude plugin eval` always runs with --no-publish.
// Prints arm names, counts and entry names, never case text or a secret. Exit codes: 0 every arm written; 1 a credential or
// suite problem, every entry limited or paid; 2 usage, an invalid or inactive or non-skill experiment.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthError, ChainExhausted, LIMIT_NOTE, PAID_NOTE, authPath, childEnv, loadChain, usableChain, withChain } from './lib/eval-auth.mjs';
import { loadExperiments, validateExperiments } from './lib/eval-experiments.mjs';
import { ensureDir, evalsDir, experimentsPath } from './lib/eval-paths.mjs';
import { SuiteError, runSuite, suiteErrors, suiteLimited, toUnits } from './lib/eval-skills.mjs';
import { spawnCapture } from './lib/eval-judge.mjs';

export const SUMMARY = 'replay the skill suite of each arm of a skill experiment (skills)';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const USAGE = [
  'usage:',
  '  triqual eval skills --experiment <id> [--paid]',
  '      Runs `claude plugin eval <pluginDir> --eval-dir evals/cases --ablation none --no-publish` once for each arm of the',
  '      active skill experiment <id> and writes <evals>/skill-runs/<id>/<arm>.json',
  '      { experiment, arm, at, auth, units: [{ caseId, pass, usd }] }. The model credentials come from the chain in',
  '      TRIQUAL_EVAL_AUTH_FILE, else ~/.config/triqual/eval-auth.json (no file: the ambient login). A suite that hit a',
  '      usage limit is discarded and run again, whole, on the next entry; with every entry limited, or a run that ended on an API error, the arm gets no file.',
  '      A chain entry marked "paid": true in that file is used only with --paid; without it, those entries are left out.',
  '      Exit 0 when every arm was written, 1 when a suite or the credentials failed, 2 on a usage error or an experiment',
  '      that is not an active skill experiment.',
  '  triqual eval skills --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--paid') { opts.paid = true; continue; }
    const m = /^--(experiment)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

// Replaces `file` through a temp file and a rename, 0600.
function writeJson(file, doc) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, 0o600);
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval skills: ${m}\n${USAGE}`); return 2; };
  const refuse = (m) => { stderr.write(`triqual eval skills: ${m}\n`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval skills: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (!opts.experiment) return usage('--experiment is needed');
  if (!ID.test(opts.experiment)) return usage('--experiment is not an experiment id');

  const home = env.HOME || homedir();
  let list;
  try { list = loadExperiments(experimentsPath(env, home)); } catch { return refuse('experiments file: unreadable or not JSON'); }
  const checked = validateExperiments(list);
  if (!checked.ok) return refuse(`invalid experiments file: ${checked.field}`);
  const experiment = list.find((e) => e.id === opts.experiment);
  if (!experiment) return refuse('unknown experiment');
  if (experiment.kind !== 'skill') return refuse('this experiment is not a skill experiment');
  if (experiment.status !== 'active') return refuse('this experiment is not active');
  const arms = Object.entries(experiment.arms);
  for (const [arm, payload] of arms) {
    if (typeof payload?.pluginDir !== 'string' || payload.pluginDir === '') return refuse(`invalid experiments file: arm ${clip(arm)} has no pluginDir`);
  }

  let chain;
  try { chain = loadChain(authPath(env, home)); } catch (err) {
    if (err instanceof AuthError) return fail(err.message);
    throw err;
  }
  const usable = usableChain(chain, { paid: opts.paid === true });
  const paidOnly = chain.length > 0 && usable.length === 0;

  const evals = evalsDir(env, home);
  const dir = join(evals, 'skill-runs', experiment.id);
  const work = join(dir, '.work');
  ensureDir(work);
  // One suite attempt on one entry: a limited run's output directory is removed and the unit moves to the next entry.
  const chainRun = withChain(usable, async ({ pluginDir }, entry) => {
    const outDir = mkdtempSync(join(work, 'run-'));
    try {
      const aggregate = await runSuite({ pluginDir, outDir, spawn, env: childEnv(entry, env, { home }) });
      return suiteLimited(aggregate) ? { limit: true } : { aggregate };
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  let code = 0;
  try {
    for (const [arm, payload] of arms) {
      let ran;
      try {
        ran = await chainRun.run({ pluginDir: payload.pluginDir });
      } catch (err) {
        if (err instanceof ChainExhausted) {
          stderr.write(paidOnly ? `triqual eval skills: ${PAID_NOTE}\n` : `triqual eval skills: ${LIMIT_NOTE} (tried: ${err.tried.join(', ')})\n`);
        } else if (err instanceof AuthError || err instanceof SuiteError) {
          stderr.write(`triqual eval skills: arm ${arm}: ${err.message}\n`);
        } else {
          throw err;
        }
        code = 1;
        break;
      }
      // Limits were handled above (the run moved to the next entry). An API error is no verdict: the arm is not scored,
      // and only the entry name and the count are printed (the error text may carry account detail).
      const errored = suiteErrors(ran.result.aggregate);
      if (errored > 0) {
        stderr.write(`triqual eval skills: arm ${arm}: auth ${ran.entry.name}: ${errored} ${errored === 1 ? 'run' : 'runs'} ended on an API error; the arm is not scored\n`);
        code = 1;
        break;
      }
      const units = toUnits(ran.result.aggregate);
      writeJson(join(dir, `${arm}.json`), {
        experiment: experiment.id, arm, at: new Date(now()).toISOString(), auth: ran.entry.name, units,
      });
      stdout.write(`arm ${arm}: ${units.length} cases, ${units.filter((u) => u.pass).length} passed; auth ${ran.entry.name}\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
