// `triqual eval improve [--more <k>] [--paid]`: one unattended round of the evals loop, every step run in-process with
// its output captured. (1) refresh the sessions store; (2) with no review sample, stop (exit 1); else draw --more
// random sessions whose last activity is after the previous draw's quiet cut-off (`review sample --more <k> --since <the
// latest `at` of the sample's rows minus one hour>`; a row with no `at` counts by its session's start, so before any draw
// recorded its time the cut-off is the latest sampled start; with neither, nothing is drawn). A session with nothing to
// judge, or that may still be running, is never drawn, and one that was running is a candidate of the next round; (3) `keep renders`: the redacted render of each sample session that is not
// under judgeExclude is kept in <evals>/review/renders/ (0600, lib/eval-renders.mjs) so the labeled set outlives the host's
// transcript cleanup (a session whose transcript changed within the last hour may still be running: it is kept by a later
// round; a session that became excluded loses its kept render; one session's failure fails the step, not the others); (4) `review propose --accept`; (5) `check`, then `judge` over the sample for each judge category;
// (6) `referee`; (7) score every category (appended to <evals>/scores.jsonl as `eval score` does) and validate every judge
// category; (8) the failure rates. A session with nothing to judge is skipped by steps 4 to 6 (not an error, not left). It
// writes <evals>/rounds/<YYYY-MM-DDTHHMMSSZ>.json (0600) and prints at most 30 lines: the
// counts, one line per category, the judge categories to revise and the report's path; never transcript text. Exit
// codes: 0 done; 1 no sample, or the store or the taxonomy is unusable; 2 usage; 3 any step after the first returned
// non-zero or threw (the report's `failed` names each, so a failed round reads differently from an idle one).
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIMIT_NOTE, PAID_NOTE } from './lib/eval-auth.mjs';
import { appendPrivate, sampleSessions } from './lib/eval-ask.mjs';
import { checkVersion } from './lib/eval-checks.mjs';
import { JudgePromptError, spawnCapture } from './lib/eval-judge.mjs';
import { reviseList, verdictsOf } from './lib/eval-improve.mjs';
import { ensureDir, evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { QUIET_MS, keepRenders } from './lib/eval-renders.mjs';
import { ratesTables } from './lib/eval-rates.mjs';
import { currentVersion, scoreCategory } from './lib/eval-score.mjs';
import { readJsonl, refreshSessions } from './lib/eval-store.mjs';
import { TaxonomyError, loadLabelCategories, loadRulings, loadTaxonomy } from './lib/eval-taxonomy.mjs';
import { withStoreLock } from './lib/role-eval.mjs';
import { main as check } from './eval-check.mjs';
import { main as judge } from './eval-judge.mjs';
import { main as referee } from './eval-referee.mjs';
import { main as review } from './eval-review.mjs';
import { main as validate } from './eval-validate.mjs';

export const SUMMARY = 'run one unattended round: sample, label, judge, referee, score, rates, and write its report (improve)';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');
const DEFAULT_REFERENCE = join(HERE, '..', 'evals', 'reference.md');
const DEFAULT_REFEREE = join(HERE, '..', 'evals', 'referee.md');
const PLUGIN_JSON = join(HERE, '..', '.claude-plugin', 'plugin.json');
const PRICES = JSON.parse(readFileSync(join(HERE, 'lib', 'prices.json'), 'utf8')).models;
const DEFAULT_MORE = 30;
const MAX_LINES = 30;
const LABELS_NOTE = 'labels are checked only where a judge disagreed with them';

const USAGE = [
  'usage:',
  '  triqual eval improve [--more <k>] [--paid]',
  '      One unattended round over the review sample (it needs one: "triqual eval review sample"):',
  '        1 refreshes the sessions store;',
  '        2 draws --more <k> (default 30; 0 draws nothing) random sessions whose last activity is after the previous',
  '          draw\'s quiet cut-off (the latest `at` of the sample rows minus one hour; before any draw recorded its time,',
  '          after every sampled session\'s start); a session whose transcript holds no user or assistant text, or changed',
  '          within the last hour, is not drawn, and one that was still running is a candidate of the next round;',
  '        3 "keep renders": the redacted render of each sample session that is not under a judgeExclude pattern is',
  '          kept in <evals>/review/renders/<sessionId>.txt (0600), so the session can be judged after the host deletes',
  '          its transcript; a session with a kept render is not rendered again; a session whose transcript changed within',
  '          the last hour (it may still be running) is kept by a later round; the kept render of a session that became',
  '          excluded is deleted; a render that cannot be written fails the step, not the round;',
  '        4 "review propose --accept"; 5 "check", then "judge" over the sample for each judge category;',
  '        6 "referee";',
  '        7 scores every category (appended to <evals>/scores.jsonl) and validates every judge category;',
  '        8 the failure rates by month and by methodology version.',
  '      A sample session with nothing to judge is skipped by steps 4 to 6: it is not an error and does not fail the round.',
  '      --paid is passed to steps 4, 5 and 6 (a credential entry marked "paid" is used only with it). Writes',
  '      <evals>/rounds/<YYYY-MM-DDTHHMMSSZ>.json (0600) with at, pluginVersion, added, kept (renders written this',
  '      round), empty (sample sessions with nothing to judge), proposed, judged, refereed,',
  '      limits, errors, failed (the name of each step that returned non-zero or threw), paidOnly (a step found every',
  '      credential entry paid), scores, rates ({ month, version }) and revise (the judge categories with at least 3',
  '      ruled disagreements between the judge and the label over the train and dev sessions). Prints at most 30',
  '      lines: counts, a renders line (kept and empty, when either is not 0), one line per category, the categories to',
  '      revise and the report\'s path. Exit 0 done; 1 no',
  '      sample or an unusable store; 3 any step after the first returned non-zero or threw (a limit, an error, an',
  '      unreadable credential, sessions left, a failed write).',
  '  triqual eval improve --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = { more: DEFAULT_MORE, paid: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--paid') { opts.paid = true; continue; }
    const m = /^--more(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[1] ?? argv[++i];
    if (value === undefined || (m[1] === undefined && value.startsWith('--'))) return { error: '--more needs a value' };
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return { error: '--more needs a non-negative integer' };
    opts.more = Number(value);
  }
  return { opts };
}

function pluginVersionOf() {
  try { return JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).version ?? null; } catch { return null; }
}

// The last non-empty stdout line, and the number that follows `word` in it (0 when the word is not there).
const lastLine = (text) => text.trim().split('\n').at(-1) ?? '';
const count = (line, word) => Number(new RegExp(`(?:^|[ ;])${word} (\\d+)`).exec(line)?.[1] ?? 0);

// The ISO timestamp as the report's file name: 2026-11-16T120000Z.
const stamp = (iso) => `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}Z`;

function writeReport(file, report) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, 0o600);
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
  judgesDir = DEFAULT_JUDGES, referencePrompt = DEFAULT_REFERENCE, refereePrompt = DEFAULT_REFEREE, platform = process.platform,
  version, pluginVersion = pluginVersionOf(), commands = {},
} = {}) {
  const cmd = { review, check, judge, referee, validate, ...commands }; // the steps' entry points; `commands` replaces one in a test
  const usage = (m) => { stderr.write(`triqual eval improve: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval improve: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);

  const clock = typeof now === 'function' ? now : () => now;
  const home = env.HOME || homedir();
  const evals = evalsDir(env, home);
  const sampleFile = join(evals, 'review', 'sample.jsonl');
  const sampleRows = () => readJsonl(sampleFile).rows.filter((r) => typeof r.sessionId === 'string');

  // One step, in-process, its output kept; a throw is a non-zero exit. `date` hands it `now` as a Date (eval-review.mjs),
  // else as a function. Every step after the first goes through here and is kept in `steps`, in order.
  const steps = [];
  const call = async (name, fn, args, { date = false } = {}) => {
    const s = { name, code: 0, out: '', err: '' };
    steps.push(s);
    const deps = {
      env, spawn, judgesDir, platform, version, referencePrompt, refereePrompt,
      now: date ? new Date(clock()) : clock,
      stdout: { write: (t) => { s.out += t; } }, stderr: { write: (t) => { s.err += t; } },
    };
    try { s.code = await fn(args, deps); } catch (err) { s.code = 1; s.err += `${name}: ${err?.code ?? 'failed'}\n`; }
    return s;
  };

  // (1) the sessions store
  let stored;
  try {
    stored = refreshSessions({ root: transcriptsRoot(env, home), file: join(evals, 'sessions.jsonl'), prices: PRICES, now: new Date(clock()) }).sessions;
  } catch (err) {
    return fail(`the sessions store could not be updated: ${err?.code ?? err?.message ?? 'error'}`);
  }

  // (2) more random sessions, newer than every sampled one
  const before = sampleRows();
  if (before.length === 0) return fail(`no review sample at ${sampleFile}; run "triqual eval review sample" first`);
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
  } catch (err) {
    if (err instanceof TaxonomyError) return fail(err.message);
    throw err;
  }
  // The window of the draw is when a session went quiet: a row drawn by an earlier round carries `at` (the time of that
  // draw) and anything active after `at` minus QUIET_MS is still a candidate; a row with no `at` counts by its session's start.
  const byId = new Map(stored.map((s) => [s.sessionId, s]));
  let latest = null;
  for (const row of before) {
    let cut = null;
    if (typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at))) cut = new Date(Date.parse(row.at) - QUIET_MS).toISOString();
    else if (typeof byId.get(row.sessionId)?.start === 'string' && !Number.isNaN(Date.parse(byId.get(row.sessionId).start))) cut = byId.get(row.sessionId).start;
    if (cut !== null && (latest === null || Date.parse(cut) > Date.parse(latest))) latest = cut;
  }
  if (opts.more > 0 && latest !== null) await call('review sample', cmd.review, ['sample', '--more', String(opts.more), '--since', latest], { date: true });
  const added = sampleRows().length - before.length;

  // (3) the renders: kept before anything reads the sample, so a labeled session outlives its transcript
  let kept = 0;
  let empty = 0;
  await call('keep renders', () => {
    const done = keepRenders({ evals, sessions: sampleSessions({ evals, root: transcriptsRoot(env, home), taxonomy, home, platform }), now: () => new Date(clock()).getTime() });
    ({ kept, empty } = done);
    return done.failed > 0 ? 1 : 0;
  }, []);

  // (4) the reference labels
  const paid = opts.paid ? ['--paid'] : [];
  const propose = await call('review propose', cmd.review, ['propose', '--accept', ...paid], { date: true });
  const proposed = count(lastLine(propose.out), 'proposed');
  let errors = count(lastLine(propose.out), 'errors');

  // The categories with an evaluator: a judge category without a prompt has none, so no step reads it (as eval score does).
  const evaluated = [];
  for (const category of taxonomy.categories) {
    try { evaluated.push({ category, current: currentVersion(category, { judgesDir, version: version ?? checkVersion() }) }); } catch (err) {
      if (!(err instanceof JudgePromptError)) throw err;
    }
  }
  const judgeIds = evaluated.map((e) => e.category).filter((c) => c.check === 'judge').map((c) => c.id);

  // (5) the verdicts
  await call('check', cmd.check, []);
  let judged = 0;
  for (const id of judgeIds) {
    const s = await call(`judge ${id}`, cmd.judge, ['--category', id, '--sessions', sampleFile, ...paid]);
    judged += count(lastLine(s.out), 'judged');
    errors += count(lastLine(s.out), 'errors');
  }

  // (6) the rulings
  const ruled = await call('referee', cmd.referee, [...paid]);
  const refereed = count(lastLine(ruled.out), 'refereed');
  errors += count(lastLine(ruled.out), 'errors');

  // (7) the scores and the validations
  const sample = sampleRows();
  const labels = readJsonl(join(evals, 'review', 'labels.jsonl')).rows;
  const labelCategories = loadLabelCategories(join(evals, 'label-categories.jsonl'));
  const at = new Date(clock()).toISOString();
  const scoresFile = join(evals, 'scores.jsonl');
  const scores = [];
  const verdicts = new Map();
  for (const { category, current } of evaluated) {
    const judgments = readJsonl(join(evals, 'judgments', `${category.id}.jsonl`)).rows;
    verdicts.set(category.id, verdictsOf(judgments, category.id, current));
    const scored = scoreCategory({ category, sample, labels, labelCategories, judgments, version: current });
    scores.push(scored);
    await call(`score ${category.id}`, () => {
      withStoreLock(`${scoresFile}.lock`, () => appendPrivate(scoresFile, { ...scored, at, pluginVersion }), { waitMs: 30000 });
      return 0;
    }, []);
  }
  for (const id of judgeIds) await call(`validate ${id}`, cmd.validate, ['--category', id]);

  const failed = steps.filter((s) => s.code !== 0).map((s) => s.name);
  const limits = steps.some((s) => s.err.includes(LIMIT_NOTE));
  const paidOnly = steps.some((s) => s.err.includes(PAID_NOTE));

  // (8) the rates
  const sessions = new Map(readJsonl(join(evals, 'sessions.jsonl')).rows.filter((r) => typeof r.sessionId === 'string').map((r) => [r.sessionId, r]));
  const categories = evaluated.map((e) => e.category);
  const tables = ratesTables({ sample, sessions, categories, verdicts });
  const rates = { month: tables.month, version: tables.version };

  const revise = reviseList({ categories, sample, labelCategories, rulings: loadRulings(join(evals, 'rulings.jsonl')), verdicts });
  const file = join(evals, 'rounds', `${stamp(at)}.json`);
  writeReport(file, { at, pluginVersion, added, kept, empty, proposed, judged, refereed, limits, errors, failed, paidOnly, scores, rates, revise });

  // The summary: the lines around the categories are fixed, the category lines take what is left of MAX_LINES.
  const head = [`added ${added}, proposed ${proposed}, judged ${judged}, refereed ${refereed}, errors ${errors}, limits ${limits}`];
  if (kept > 0 || empty > 0) head.push(`renders: kept ${kept}, empty ${empty}`);
  if (paidOnly) head.push(PAID_NOTE);
  if (failed.length > 0) head.push(`steps that returned non-zero: ${failed.join(', ')}`);
  const tail = [`revise: ${revise.length === 0 ? 'none' : revise.join(', ')}`, LABELS_NOTE, `report: ${file}`];
  const room = MAX_LINES - head.length - tail.length;
  const side = (c) => `${c.tp + c.tn}/${c.tp + c.fn + c.tn + c.fp}`;
  const lines = scores.map((r) => `${r.category}: dev ${side(r.dev)}, test ${side(r.test)}, ${r.verdict}`);
  const shown = lines.length > room ? [...lines.slice(0, room - 1), `... ${lines.length - room + 1} more categories in the report`] : lines;
  stdout.write(`${[...head, ...shown, ...tail].join('\n')}\n`);
  return failed.length > 0 ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
