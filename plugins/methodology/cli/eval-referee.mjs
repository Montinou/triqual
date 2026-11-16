// `triqual eval referee [--category <id>] [--paid]`: for each judge category (or the one named) and each sample session
// where the category judge's verdict (current judge prompt) and the session's category label disagree, one model call
// (evals/referee.md, the rendered and redacted transcript, never the raw one) rules whether the failure is present. The
// ruling is appended to <evals>/rulings.jsonl, once per (session, category); then <evals>/label-categories.jsonl follows
// every ruling (the owner's included). A session under a judgeExclude pattern of the taxonomy is never sent. A usage
// limit or an unusable answer writes no ruling. A chain entry marked paid is used only with --paid. It prints counts,
// ids and entry names, never transcript text or a secret. The last stdout line is
// `refereed <n>: <entry> <k>[, ...]; errors <e>; left <m>`. Exit codes: 0 no disagreement is left without a ruling;
// 1 some are left (an error, a credential problem, every entry limited, no sample); 2 usage (a code category included).
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthError, LIMIT_NOTE, PAID_NOTE, authPath, loadChain, usableChain } from './lib/eval-auth.mjs';
import { sampleSessions } from './lib/eval-ask.mjs';
import { JudgePromptError, loadJudgePrompt, spawnCapture } from './lib/eval-judge.mjs';
import { ensureDir, evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { runReferee } from './lib/eval-referee.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';

export const SUMMARY = 'a model rules on each judge-versus-label disagreement and the rulings become the labels (referee)';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');
const DEFAULT_REFEREE = join(HERE, '..', 'evals', 'referee.md');
const CATEGORY = /^[a-z][a-z0-9-]{1,39}$/;

const USAGE = [
  'usage:',
  '  triqual eval referee [--category <id>] [--paid]',
  '      For each judge category of <evals>/taxonomy.json (or the one named) and each session of the review sample that',
  '      is not under a judgeExclude pattern, has a category label and a pass or fail verdict of the current judge prompt',
  '      (plugins/methodology/evals/judges/<id>.md) that contradicts the label, and has no ruling yet: one model call',
  '      (plugins/methodology/evals/referee.md) over the redacted rendering of the session. The ruling { sessionId,',
  '      category, present, source, judge, quote, why, misleading, promptHash, model, auth, at } is appended to',
  '      <evals>/rulings.jsonl; then <evals>/label-categories.jsonl is rewritten so each ruled category is present exactly',
  '      when the ruling says so (an owner ruling in the file is applied too). A ruling is never changed. The credentials',
  '      come from the chain in TRIQUAL_EVAL_AUTH_FILE, else ~/.config/triqual/eval-auth.json; an entry marked "paid":',
  '      true is used only with --paid. A usage limit or an unusable answer writes no ruling.',
  '      Last line: refereed <n>: <entry> <k>[, ...]; errors <e>; left <m>. Exit 0 when left is 0, else 1.',
  '  triqual eval referee --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--paid') { opts.paid = true; continue; }
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
  judgesDir = DEFAULT_JUDGES, refereePrompt = DEFAULT_REFEREE, platform = process.platform,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval referee: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval referee: ${m}\n`); return 1; };
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
  let chosen = taxonomy.categories.filter((c) => c.check === 'judge');
  if (opts.category !== undefined) {
    const one = taxonomy.categories.find((c) => c.id === opts.category);
    if (!one) return usage('unknown category');
    if (one.check !== 'judge') return usage('this category is checked by code, not by a judge');
    chosen = [one];
  }

  let prompt;
  let chain;
  let paidOnly = false;
  try {
    prompt = loadJudgePrompt(refereePrompt);
    const loaded = loadChain(authPath(env, home));
    chain = usableChain(loaded, { paid: opts.paid === true });
    paidOnly = loaded.length > 0 && chain.length === 0;
  } catch (err) {
    if (err instanceof JudgePromptError || err instanceof AuthError) return fail(err.message);
    throw err;
  }
  // A category without a judge prompt has no judgments to compare with: it is skipped (a named one is an error).
  const categories = [];
  for (const c of chosen) {
    let judge;
    try { judge = loadJudgePrompt(join(judgesDir, `${c.id}.md`)); } catch (err) {
      if (err instanceof JudgePromptError) {
        if (opts.category !== undefined) return fail(`${c.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    categories.push({ ...c, version: judge.hash, judgments: readJsonl(join(evals, 'judgments', `${c.id}.jsonl`)).rows });
  }

  const sessions = sampleSessions({ evals, root: transcriptsRoot(env, home), taxonomy, home, platform });
  if (sessions.length === 0) return fail(`no sample at ${join(evals, 'review', 'sample.jsonl')}; run "triqual eval review sample" first`);
  const cwd = join(evals, 'judge-cwd');
  ensureDir(cwd);
  const result = await runReferee({
    evals, sessions, categories, prompt, chain, spawn, env, home, cwd, bin: env.TRIQUAL_CLAUDE_BIN || 'claude', now,
  });
  if (result.stop === 'limit') stderr.write(`triqual eval referee: ${paidOnly ? PAID_NOTE : LIMIT_NOTE}\n`);
  if (result.stop === 'auth') stderr.write('triqual eval referee: a credential source could not be read\n');
  if (result.applied > 0) stdout.write(`labels changed ${result.applied}\n`);
  const pairs = Object.entries(result.byEntry).map(([name, k]) => `${name} ${k}`).join(', ');
  stdout.write(`refereed ${result.refereed}: ${pairs === '' ? 'none' : pairs}; errors ${result.errors}; left ${result.left}\n`);
  return result.left > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
