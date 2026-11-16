// `triqual eval rates`: for each category of the taxonomy, the share of the random-stratum review sample sessions with
// a `fail` verdict (under the category's current evaluator version), by month of the session's start and by the
// methodology version it ran under (lib/eval-rates.mjs). A bucket under 5 sessions prints `fail/n` and no share. It
// prints counts and rates, never transcript text. Exit codes: 0 done; 1 the taxonomy, a judge prompt or the sample is
// unusable; 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkVersion } from './lib/eval-checks.mjs';
import { JudgePromptError, spawnCapture } from './lib/eval-judge.mjs';
import { evalsDir } from './lib/eval-paths.mjs';
import { ratesTables } from './lib/eval-rates.mjs';
import { currentVersion } from './lib/eval-score.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';

export const SUMMARY = "show each failure's rate by month and by methodology version (rates)";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');

const USAGE = [
  'usage:',
  '  triqual eval rates',
  '      For each category of <evals>/taxonomy.json with an evaluator, prints two tables over the random-stratum',
  '      sessions of the review sample with a pass or fail verdict under the category\'s current version: by month of',
  '      the session start (YYYY-MM) and by methodology version ("unknown" when the session has none). Each row is',
  '      category, bucket, n, fail/n and, from 5 sessions, the failure share with its 90% Wilson interval; a bucket',
  '      under 5 sessions shows fail/n and no share. Exit 0 when done.',
  '  triqual eval rates --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// sessionId -> result of the last line of `version` for `category`.
function verdictsOf(judgments, category, version) {
  const out = new Map();
  for (const j of judgments) {
    if (j?.promptHash === version && (j.category === undefined || j.category === category) && typeof j.sessionId === 'string') out.set(j.sessionId, j.result);
  }
  return out;
}

function table(title, label, rows) {
  const out = [title, `${'category'.padEnd(28)} ${label.padEnd(10)} ${'n'.padStart(4)} ${'fail/n'.padStart(7)} ${'share'.padStart(7)}  90% interval`];
  for (const r of rows) {
    out.push(`${r.category.padEnd(28)} ${r.bucket.padEnd(10)} ${String(r.n).padStart(4)} ${`${r.fail}/${r.n}`.padStart(7)} ${(r.share === null ? '' : pct(r.share)).padStart(7)}  ${r.ci === null ? '' : `${pct(r.ci[0])} to ${pct(r.ci[1])}`}`.trimEnd());
  }
  return out;
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
  judgesDir = DEFAULT_JUDGES, version,
} = {}) {
  void now; void spawn; // no model runs and nothing is stamped; the dependencies are accepted so every eval command takes the same deps
  const usage = (m) => { stderr.write(`triqual eval rates: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval rates: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  if (argv.length > 0) return usage(`unknown argument ${clip(argv[0])}`);

  const evals = evalsDir(env, env.HOME || homedir());
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
  } catch (err) {
    if (err instanceof TaxonomyError) return fail(err.message);
    throw err;
  }
  const sample = readJsonl(join(evals, 'review', 'sample.jsonl')).rows.filter((r) => typeof r.sessionId === 'string');
  if (sample.length === 0) return fail('no review sample; run "triqual eval review sample" first');
  const sessions = new Map(readJsonl(join(evals, 'sessions.jsonl')).rows.filter((r) => typeof r.sessionId === 'string').map((r) => [r.sessionId, r]));

  // A judge category without a prompt has no evaluator, so no verdicts: left out.
  const categories = [];
  const verdicts = new Map();
  for (const c of taxonomy.categories) {
    let current;
    try { current = currentVersion(c, { judgesDir, version: version ?? checkVersion() }); } catch (err) {
      if (err instanceof JudgePromptError) continue;
      throw err;
    }
    categories.push(c);
    verdicts.set(c.id, verdictsOf(readJsonl(join(evals, 'judgments', `${c.id}.jsonl`)).rows, c.id, current));
  }

  const { month, version: byVersion } = ratesTables({ sample, sessions, categories, verdicts });
  const out = [...table('failure rate by month', 'month', month), '', ...table('failure rate by methodology version', 'version', byVersion)];
  stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
