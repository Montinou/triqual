// `triqual eval check [--category <id>]`: for each `code` category of the taxonomy (or the one named) and each session
// of the review sample, runs the category's code check (lib/eval-checks.mjs) unless a line for the current check
// version is in <evals>/judgments/<id>.jsonl already, and appends { sessionId, category, result, promptHash: <version>,
// model: null, auth: 'code', at }. `result` is pass, fail or undecided (the transcript is gone). The version is
// checkVersion(): it changes when the checks change, and then every session is checked again; earlier lines stay.
// It prints counts, never transcript text. The last stdout line is `checked <n>; undecided <u>`. Exit codes: 0 done;
// 1 the taxonomy or the sample is unusable; 2 usage (a judge category included).
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECKS, checkVersion, runCheck } from './lib/eval-checks.mjs';
import { appendPrivate, sampleSessions } from './lib/eval-ask.mjs';
import { spawnCapture } from './lib/eval-judge.mjs';
import { ensureDir, evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'run the code checks over the sample, recording a verdict per session and check version (check)';

const CATEGORY = /^[a-z][a-z0-9-]{1,39}$/;

const USAGE = [
  'usage:',
  '  triqual eval check [--category <id>]',
  '      For each code category of <evals>/taxonomy.json (or the one named) and each session of the review sample',
  '      without a line for the current check version, runs the category check and appends { sessionId, category,',
  '      result, promptHash, model, auth, at } to <evals>/judgments/<id>.jsonl (result: pass, fail or undecided when the',
  '      transcript is gone; promptHash: the check version; model: null; auth: "code"). A change to the checks changes',
  '      the version, so every session is checked again; earlier lines stay.',
  '      Last line: checked <n>; undecided <u>. Exit 0 when done.',
  '  triqual eval check --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(category)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
  version = checkVersion(), platform = process.platform,
} = {}) {
  void spawn; // a code check runs no model; the dependency is accepted so every eval command takes the same deps
  const usage = (m) => { stderr.write(`triqual eval check: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval check: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (opts.category !== undefined && !CATEGORY.test(opts.category)) return usage('--category is not a category id');

  const home = env.HOME || homedir();
  const evals = evalsDir(env, home);
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
  } catch (err) {
    if (err instanceof TaxonomyError) return fail(err.message);
    throw err;
  }
  let chosen = taxonomy.categories.filter((c) => c.check === 'code');
  if (opts.category !== undefined) {
    const one = taxonomy.categories.find((c) => c.id === opts.category);
    if (!one) return usage('unknown category');
    if (one.check !== 'code') return usage('this category is checked by a judge, not by code');
    chosen = [one];
  }

  const sessions = sampleSessions({ evals, root: transcriptsRoot(env, home), taxonomy, home, platform });
  if (sessions.length === 0) return fail(`no sample at ${join(evals, 'review', 'sample.jsonl')}; run "triqual eval review sample" first`);
  const dir = join(evals, 'judgments');
  ensureDir(dir);
  let checked = 0;
  let undecided = 0;
  for (const c of chosen) {
    if (!Object.hasOwn(CHECKS, c.id)) return fail(`${c.id}: no code check is defined for this category`);
    const file = join(dir, `${c.id}.jsonl`);
    for (const s of sessions) {
      // Re-read under the lock: two runs never duplicate a line.
      withStoreLock(`${file}.lock`, () => {
        if (readJsonl(file).rows.some((r) => r.sessionId === s.sessionId && r.promptHash === version)) return;
        // A session that is not stored has no transcript file: the check reports it undecided.
        const result = runCheck(c.id, {}, s.file ?? '', CHECKS);
        appendPrivate(file, { sessionId: s.sessionId, category: c.id, result, promptHash: version, model: null, auth: 'code', at: new Date(now()).toISOString() });
        checked += 1;
        if (result === 'undecided') undecided += 1;
      });
    }
  }
  stdout.write(`checked ${checked}; undecided ${undecided}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
