// `triqual eval validate --category <id> [--split dev|test]`: measures a category judge against the owner's labels. The
// sessions are the labeled rows of the review sample's random stratum that fall in the split (lib/eval-validate.mjs);
// the judgments are <evals>/judgments/<id>.jsonl, those of the current judge prompt only. `test` (the default) writes
// { tp, fn, tn, fp, positives, negatives, undecided, tpr, tnr, tprCI, tnrCI, usable, reason, promptHash, model, at } to
// <evals>/validation.json under the category (the other categories are kept; the file is 0600); `dev` only prints. A
// prompt that names a dev or test session id is refused (exit 1) and nothing is written. When the judge is unusable for
// lack of positives or negatives it prints `sample <k> more: triqual eval review sample --more <k>`. It prints counts,
// ids and the verdict, never transcript text. Exit codes: 0 done; 1 the prompt is unreadable or leaks a session, no
// sample, or the file could not be written; 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, evalsDir } from './lib/eval-paths.mjs';
import { JudgePromptError, loadJudgePrompt } from './lib/eval-judge.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { loadLabelCategories } from './lib/eval-taxonomy.mjs';
import { FewShotLeak, moreNeeded, validateCategory } from './lib/eval-validate.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'measure a category judge against the labels, test split (validate)';

const DEFAULT_JUDGES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'judges');
const CATEGORY = /^[a-z][a-z0-9-]{1,39}$/;
const SPLITS = new Set(['dev', 'test']);

const USAGE = [
  'usage:',
  '  triqual eval validate --category <id> [--split dev|test]',
  '      Compares the judgments of the category judge (current prompt hash only) with the owner\'s labels over the',
  '      labeled sessions of the review sample\'s random stratum that fall in the split, and prints the confusion counts,',
  '      TPR and TNR with their Wilson 90% intervals, and whether the judge is usable (>= 15 positives and >= 15',
  '      negatives, both lower bounds >= 0.7). The default split is test: the result is written to <evals>/validation.json',
  '      (the evals directory is TRIQUAL_EVALS_DIR, else ~/.local/share/triqual/evals). dev only prints. A judge prompt',
  '      that names a dev or test session id is refused. When there are too few positives or negatives it prints',
  '      "sample <k> more: triqual eval review sample --more <k>".',
  '  triqual eval validate --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(category|split)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

// Merges `entry` under `category` into the JSON object file, atomically (a temp file and a rename), 0600.
function writeValidation(file, category, entry) {
  ensureDir(dirname(file));
  withStoreLock(`${file}.lock`, () => {
    let doc = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
    } catch { /* no file yet, or one that is not JSON: start again */ }
    doc[category] = entry;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    chmodSync(file, 0o600);
  }, { waitMs: 30000 });
}

const fmt = (x) => (x === null ? 'n/a' : x.toFixed(3));
const ci = ([lo, hi]) => `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`;

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), judgesDir = DEFAULT_JUDGES,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval validate: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval validate: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (!opts.category) return usage('--category is needed');
  if (!CATEGORY.test(opts.category)) return usage('--category is not a category id');
  const split = opts.split ?? 'test';
  if (!SPLITS.has(split)) return usage('--split must be dev or test');

  const evals = evalsDir(env, env.HOME || homedir());
  let prompt;
  try { prompt = loadJudgePrompt(join(judgesDir, `${opts.category}.md`)); } catch (err) {
    if (err instanceof JudgePromptError) return fail(err.message);
    throw err;
  }
  const sample = readJsonl(join(evals, 'review', 'sample.jsonl')).rows.filter((r) => typeof r.sessionId === 'string');
  if (sample.length === 0) return fail('no review sample; run "triqual eval review sample" and label it first');

  let result;
  try {
    result = validateCategory({
      category: opts.category, split, sample, promptHash: prompt.hash, promptBody: prompt.body,
      labels: readJsonl(join(evals, 'review', 'labels.jsonl')).rows,
      labelCategories: loadLabelCategories(join(evals, 'label-categories.jsonl')),
      judgments: readJsonl(join(evals, 'judgments', `${opts.category}.jsonl`)).rows,
    });
  } catch (err) {
    if (err instanceof FewShotLeak) return fail(`${err.message}; take the examples from sessions outside the dev and test splits`);
    throw err;
  }

  stdout.write([
    `${opts.category} (${split}): tp ${result.tp} fn ${result.fn} tn ${result.tn} fp ${result.fp}; undecided ${result.undecided}`,
    `TPR ${fmt(result.tpr)} ${ci(result.tprCI)}  TNR ${fmt(result.tnr)} ${ci(result.tnrCI)}  (Wilson 90%)`,
    result.usable ? 'usable: yes' : `usable: no (${result.reason})`,
    '',
  ].join('\n'));
  const k = result.usable ? 0 : moreNeeded(result);
  if (k > 0) stdout.write(`sample ${k} more: triqual eval review sample --more ${k}\n`);

  if (split === 'test') {
    try {
      writeValidation(join(evals, 'validation.json'), opts.category, { ...result, promptHash: prompt.hash, model: prompt.model, at: new Date(now()).toISOString() });
    } catch (err) {
      return fail(`validation.json could not be written: ${err?.code ?? err?.message ?? 'error'}`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
