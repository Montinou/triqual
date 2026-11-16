// `triqual eval score [--category <id> [--against <version>]]`: for each category of the taxonomy (or the one named)
// measures its evaluator (the judge prompt, or the code check) against the labels on the train, dev and test splits,
// and compares the dev split with the version it replaced, or with the one `--against` names (lib/eval-score.mjs).
// The dev line says whether the current version is better; test is reported, never used to decide. Each result is
// appended, with `at` and `pluginVersion`, to <evals>/scores.jsonl (0600). It prints counts, ids and rates, never
// transcript text. Exit codes: 0 done; 1 the taxonomy, a judge prompt or the sample is unusable; 2 usage (an
// `--against` without `--category`, or equal to the current version, included).
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkVersion } from './lib/eval-checks.mjs';
import { appendPrivate } from './lib/eval-ask.mjs';
import { JudgePromptError, spawnCapture } from './lib/eval-judge.mjs';
import { evalsDir } from './lib/eval-paths.mjs';
import { currentVersion, scoreCategory } from './lib/eval-score.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'measure each evaluator and compare it with the version it replaced (score)';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');
const PLUGIN_JSON = join(HERE, '..', '.claude-plugin', 'plugin.json');
const CATEGORY = /^[a-z][a-z0-9-]{1,39}$/;

const USAGE = [
  'usage:',
  '  triqual eval score [--category <id>] [--against <version>]',
  '      For each category of <evals>/taxonomy.json (or the one named) with an evaluator (plugins/methodology/evals/',
  '      judges/<id>.md for a judge category, the code check for a code one), prints the confusion counts of its current',
  '      version on the train, dev and test splits, then',
  '        dev: previous <balanced> (<correct>/<n>), current <balanced> (<correct>/<n>): <verdict>',
  '      over the dev sessions with a pass or fail verdict under both the previous and the current version (verdict:',
  '      better when the current balanced rate (TPR + TNR) / 2 is strictly higher, or, when either is undefined, when',
  '      more verdicts are correct; else not-better; "dev: first version" when there is no previous version). Appends',
  '      each result with at and pluginVersion to <evals>/scores.jsonl. The test split is reported only.',
  '      With --against <version> (needs --category) the comparison is with exactly that version, in place of the most',
  '      recent other version; when it shares no labeled dev session decided under both, or the version is unknown, the',
  '      result is "dev: first version". --against equal to the current version is an error (the prompt did not change).',
  '      Exit 0 when done; 2 on a usage error, including an --against that needs --category or names the current version.',
  '  triqual eval score --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(category|against)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

const fmt = (x) => (x === null ? 'n/a' : x.toFixed(3));
const side = (c) => `${fmt(c.balanced)} (${c.tp + c.tn}/${c.tp + c.fn + c.tn + c.fp})`;

function pluginVersionOf() {
  try { return JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version ?? null; } catch { return null; }
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
  judgesDir = DEFAULT_JUDGES, version, pluginVersion = pluginVersionOf(),
} = {}) {
  void spawn; // scoring runs no model; the dependency is accepted so every eval command takes the same deps
  const usage = (m) => { stderr.write(`triqual eval score: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval score: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (opts.category !== undefined && !CATEGORY.test(opts.category)) return usage('--category is not a category id');
  if (opts.against !== undefined && opts.category === undefined) return usage('--against needs --category');

  const evals = evalsDir(env, env.HOME || homedir());
  const labelCategories = loadLabelCategories(join(evals, 'label-categories.jsonl'));
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: labelCategories });
  } catch (err) {
    if (err instanceof TaxonomyError) return fail(err.message);
    throw err;
  }
  let chosen = taxonomy.categories;
  if (opts.category !== undefined) {
    const one = taxonomy.categories.find((c) => c.id === opts.category);
    if (!one) return usage('unknown category');
    chosen = [one];
  }

  const sample = readJsonl(join(evals, 'review', 'sample.jsonl')).rows.filter((r) => typeof r.sessionId === 'string');
  if (sample.length === 0) return fail('no review sample; run "triqual eval review sample" and label it first');
  const labels = readJsonl(join(evals, 'review', 'labels.jsonl')).rows;

  // A judge category without a prompt has no evaluator to score: skipped (a named one is an error).
  const scored = [];
  for (const c of chosen) {
    let current;
    try { current = currentVersion(c, { judgesDir, version: version ?? checkVersion() }); } catch (err) {
      if (err instanceof JudgePromptError) {
        if (opts.category !== undefined) return fail(`${c.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (opts.against !== undefined && opts.against === current) return usage(`--against is the current version of ${c.id}: the prompt did not change`);
    const judgments = readJsonl(join(evals, 'judgments', `${c.id}.jsonl`)).rows;
    scored.push(scoreCategory({ category: c, sample, labels, labelCategories, judgments, version: current, against: opts.against }));
  }

  const out = [];
  const at = new Date(now()).toISOString();
  const file = join(evals, 'scores.jsonl');
  for (const r of scored) {
    out.push(`${r.category.padEnd(28)} ${'split'.padEnd(5)} ${'tp'.padStart(3)} ${'fn'.padStart(3)} ${'tn'.padStart(3)} ${'fp'.padStart(3)} ${'undec'.padStart(5)} ${'TPR'.padStart(6)} ${'TNR'.padStart(6)}`);
    for (const s of ['train', 'dev', 'test']) {
      const x = r[s];
      out.push(`${r.category.padEnd(28)} ${s.padEnd(5)} ${String(x.tp).padStart(3)} ${String(x.fn).padStart(3)} ${String(x.tn).padStart(3)} ${String(x.fp).padStart(3)} ${String(x.undecided).padStart(5)} ${fmt(x.tpr).padStart(6)} ${fmt(x.tnr).padStart(6)}${s === 'test' ? (x.usable ? '  usable' : '  not usable') : ''}`);
    }
    out.push(r.previous === null ? 'dev: first version' : `dev: previous ${side(r.previous.previous)}, current ${side(r.previous.current)}: ${r.verdict}`);
    withStoreLock(`${file}.lock`, () => appendPrivate(file, { ...r, at, pluginVersion }), { waitMs: 30000 });
  }
  if (out.length > 0) stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
