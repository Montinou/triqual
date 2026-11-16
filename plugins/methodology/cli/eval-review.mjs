// `triqual eval review sample [--n 100] [--seed <int>] [--force]` and `triqual eval review serve [--port <n>]`: the
// human labeling of sessions. `sample` refreshes the sessions store, draws a stratified sample of the interactive
// sessions (half random, a quarter by cost, the rest outliers) and writes <evals>/review/sample.jsonl, printing the
// rows per stratum and the seed; an existing sample is kept unless --force. `serve` starts the loopback review page
// (lib/eval-serve.mjs, 127.0.0.1 only, Host and Origin checked) over that sample, appends the labels to
// <evals>/review/labels.jsonl, prints its plain URL, and runs until SIGINT or SIGTERM. A random per-run value is embedded in the
// served page and required on every label POST; it is never printed. `sample --more <k> [--since <day | ISO timestamp>]` appends k more random-stratum
// rows (sessions not yet in the sample) to the existing sample, keeping its rows and order; it needs a sample and takes
// no --n or --force. It prints counts, ids and paths, never transcript text. Exit codes: 0 done; 1 the store could not be updated, a sample exists (no --force), there is
// no sample to serve, or the server could not start; 2 usage.
// `propose [--accept] [--paid]` has a model read each sample session (lib/eval-reference.mjs: the redacted rendering, never the
// raw transcript, and never a session under the taxonomy's judgeExclude) and append its proposed label and categories to
// <evals>/review/reference.jsonl, once per session. --accept then copies the proposals into the label files for the
// sessions that have no human line. A chain entry marked paid is used only with --paid. The last stdout line is
// `proposed <n>: <entry> <k>[, ...]; errors <e>; left <m>`; the exit is 0 when `left` is 0, else 1.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthError, LIMIT_NOTE, PAID_NOTE, authPath, loadChain, usableChain } from './lib/eval-auth.mjs';
import { sampleSessions } from './lib/eval-ask.mjs';
import { JudgePromptError, spawnCapture } from './lib/eval-judge.mjs';
import { ensureDir, evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { acceptReference, loadReferencePrompt, proposeReference } from './lib/eval-reference.mjs';
import { drawSample, moreRandom, SampleExists, writeSample } from './lib/eval-sample.mjs';
import { readJsonl, refreshSessions } from './lib/eval-store.mjs';
import { startServer } from './lib/eval-serve.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';

export const SUMMARY = 'draw the stratified review sample (sample), serve the local labeling page (serve), propose labels with a model (propose)';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'prices.json'), 'utf8')).models;
const DEFAULT_REFERENCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'reference.md');
const DEFAULT_N = 100;
const STRATA = ['random', 'cost', 'outlier'];

const USAGE = [
  'usage:',
  '  triqual eval review sample [--n 100] [--seed <int>] [--force]',
  '      Refreshes the sessions store, then writes <evals>/review/sample.jsonl (the evals directory is',
  '      TRIQUAL_EVALS_DIR, else ~/.local/share/triqual/evals): --n interactive sessions, half drawn at random, a quarter',
  '      by highest cost, the rest by outlier score (stop-hook blocks, idle cache rewrites, turns). The same --seed',
  '      draws the same sample; without it the seed is the current epoch second, and it is printed. An existing',
  '      sample is kept unless --force. Prints the rows per stratum, never message content.',
  '  triqual eval review sample --more <k> [--seed <int>] [--since <YYYY-MM-DD | ISO timestamp>]',
  '      Appends k more random-stratum rows (interactive sessions not yet in the sample, seeded like --seed above) to the',
  '      existing sample.jsonl, keeping its rows; fewer when fewer sessions are left. Needs a sample; no --n or --force.',
  '      --since <YYYY-MM-DD | ISO timestamp> keeps only sessions that started at or after it; it needs --more.',
  '  triqual eval review serve [--port <n>]',
  '      Serves the sample on http://127.0.0.1:<port>/ (a free port when --port is absent or 0) and appends the',
  '      good/bad labels to <evals>/review/labels.jsonl. Binds to 127.0.0.1 only, checks the Host and Origin',
  '      headers, and requires a per-run token (embedded in the page) on every label POST. Prints the URL;',
  '      runs until SIGINT.',
  '  triqual eval review propose [--accept] [--paid]',
  '      A model reads each session of the sample (the redacted rendering; never a session under a judgeExclude',
  '      pattern of <evals>/taxonomy.json) and proposes the good/bad label and the failure categories present,',
  '      appended once per session to <evals>/review/reference.jsonl. The credentials come from the chain in',
  '      TRIQUAL_EVAL_AUTH_FILE, else ~/.config/triqual/eval-auth.json; an entry marked "paid": true is used only',
  '      with --paid. --accept then adds a label (review/labels.jsonl) and a category line (label-categories.jsonl)',
  '      for each proposed session that has none there; existing lines are never changed. Needs a sample.',
  '      Last line: proposed <n>: <entry> <k>[, ...]; errors <e>; left <m>. Exit 0 when left is 0, else 1.',
  '  triqual eval review --help',
  '',
].join('\n');

// The --since value as moreRandom compares it: undefined when absent, a day kept as is, a full ISO timestamp as the
// UTC instant (the form a transcript's `start` has); null when it is neither.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function sinceOf(v) {
  if (v === undefined) return undefined;
  if (!DAY.test(v) && !STAMP.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return DAY.test(v) ? v : new Date(ms).toISOString();
}

const stopOnSignal = () => new Promise((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

function parse(rest, flags) {
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    const spec = m && flags[m[1]];
    if (!spec) return { error: `unknown argument ${arg.length > 40 ? `${arg.slice(0, 40)}...` : arg}` };
    if (spec === 'bool') {
      if (m[2] !== undefined) return { error: `--${m[1]} takes no value` };
      opts[m[1]] = true;
      continue;
    }
    const value = m[2] ?? rest[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

// Runs the command and returns its exit code; every dependency is injected so a test never reads the real home.
// `until` (serve only) is a promise that ends the server when it settles; the default is SIGINT or SIGTERM.
// `now` is a Date or a function returning one; `spawn`, `platform` and `referencePrompt` are for `propose`.
export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), until, spawn = spawnCapture,
  platform = process.platform, referencePrompt = DEFAULT_REFERENCE,
} = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  now = new Date(clock());
  const usage = (m) => { stderr.write(`triqual eval review: ${m}\n${USAGE}`); return 2; };
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) { stdout.write(USAGE); return 0; }
  if (sub !== 'sample' && sub !== 'serve' && sub !== 'propose') return usage(sub === undefined ? 'a subcommand is needed: sample, serve or propose' : `unknown subcommand ${sub.length > 40 ? `${sub.slice(0, 40)}...` : sub}`);

  const home = env.HOME || homedir();
  const dir = join(evalsDir(env, home), 'review');
  const sampleFile = join(dir, 'sample.jsonl');

  if (sub === 'sample') {
    const { opts, error } = parse(rest, { n: 'value', seed: 'value', force: 'bool', more: 'value', since: 'value' });
    if (error) return usage(error);
    if (opts.since !== undefined && opts.more === undefined) return usage('--since needs --more');
    if (opts.more !== undefined) {
      if (opts.n !== undefined || opts.force === true) return usage('--more takes no --n or --force');
      if (!/^\d+$/.test(opts.more) || !Number.isSafeInteger(Number(opts.more)) || Number(opts.more) < 1) return usage('--more needs a positive integer');
      if (opts.seed !== undefined && !/^\d+$/.test(opts.seed)) return usage('--seed needs a non-negative integer');
      const since = sinceOf(opts.since);
      if (since === null) return usage('--since needs a day (YYYY-MM-DD) or an ISO timestamp');
      const existing = readJsonl(sampleFile).rows.filter((r) => typeof r.sessionId === 'string');
      if (existing.length === 0) {
        stderr.write(`triqual eval review: no sample at ${sampleFile}; run "triqual eval review sample" first\n`);
        return 1;
      }
      const seed = opts.seed === undefined ? Math.floor(now.getTime() / 1000) : Number(opts.seed);
      let sessions;
      try {
        sessions = refreshSessions({ root: transcriptsRoot(env, home), file: join(evalsDir(env, home), 'sessions.jsonl'), prices: PRICES, now }).sessions;
      } catch (err) {
        stderr.write(`triqual eval review: the sessions store could not be updated: ${err?.code ?? err?.message ?? 'error'}\n`);
        return 1;
      }
      const added = moreRandom(sessions, existing, Number(opts.more), seed, { root: transcriptsRoot(env, home), since });
      try {
        writeSample(sampleFile, [...existing, ...added], { force: true });
      } catch (err) {
        stderr.write(`triqual eval review: the sample could not be written: ${err?.code ?? err?.message ?? 'error'}\n`);
        return 1;
      }
      stdout.write(`Added ${added.length} of ${opts.more} random row(s), seed ${seed}; the sample has ${existing.length + added.length}\nWritten to ${sampleFile}\n`);
      return 0;
    }
    const n = opts.n === undefined ? DEFAULT_N : Number(opts.n);
    if (!/^\d+$/.test(String(opts.n ?? DEFAULT_N)) || !Number.isSafeInteger(n) || n < 1) return usage('--n needs a positive integer');
    if (opts.seed !== undefined && !/^\d+$/.test(opts.seed)) return usage('--seed needs a non-negative integer');
    const seed = opts.seed === undefined ? Math.floor(now.getTime() / 1000) : Number(opts.seed);
    let sessions;
    try {
      sessions = refreshSessions({ root: transcriptsRoot(env, home), file: join(evalsDir(env, home), 'sessions.jsonl'), prices: PRICES, now }).sessions;
    } catch (err) {
      stderr.write(`triqual eval review: the sessions store could not be updated: ${err?.code ?? err?.message ?? 'error'}\n`);
      return 1;
    }
    const rows = drawSample(sessions, { n, seed, root: transcriptsRoot(env, home) });
    try {
      writeSample(sampleFile, rows, { force: opts.force === true });
    } catch (err) {
      if (err instanceof SampleExists) {
        stderr.write(`triqual eval review: ${sampleFile} already exists; pass --force to replace it\n`);
      } else {
        stderr.write(`triqual eval review: the sample could not be written: ${err?.code ?? err?.message ?? 'error'}\n`);
      }
      return 1;
    }
    const lines = [`Sample: ${rows.length} of ${sessions.length} session(s), seed ${seed}`];
    for (const s of STRATA) lines.push(`  ${s.padEnd(8)} ${rows.filter((r) => r.stratum === s).length}`);
    lines.push(`Written to ${sampleFile}`, '');
    stdout.write(lines.join('\n'));
    return 0;
  }

  if (sub === 'propose') {
    const { opts, error } = parse(rest, { accept: 'bool', paid: 'bool' });
    if (error) return usage(error);
    const fail = (m) => { stderr.write(`triqual eval review: ${m}\n`); return 1; };
    const evals = evalsDir(env, home);
    if (readJsonl(sampleFile).rows.every((r) => typeof r.sessionId !== 'string')) return fail(`no sample at ${sampleFile}; run "triqual eval review sample" first`);
    let taxonomy;
    let prompt;
    let chain;
    let paidOnly = false;
    try {
      taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
      prompt = loadReferencePrompt(referencePrompt, taxonomy);
      const loaded = loadChain(authPath(env, home));
      chain = usableChain(loaded, { paid: opts.paid === true });
      paidOnly = loaded.length > 0 && chain.length === 0;
    } catch (err) {
      if (err instanceof TaxonomyError || err instanceof JudgePromptError || err instanceof AuthError) return fail(err.message);
      throw err;
    }
    const root = transcriptsRoot(env, home);
    const sessions = sampleSessions({ evals, root, taxonomy, home, platform });
    const cwd = join(evals, 'judge-cwd');
    ensureDir(cwd);
    const result = await proposeReference({ evals, sessions, prompt, chain, spawn, env, home, cwd, bin: env.TRIQUAL_CLAUDE_BIN || 'claude', now: clock });
    if (result.stop === 'limit') stderr.write(`triqual eval review: ${paidOnly ? PAID_NOTE : LIMIT_NOTE}\n`);
    if (result.stop === 'auth') stderr.write('triqual eval review: a credential source could not be read\n');
    if (opts.accept === true) {
      const a = acceptReference({ evals, sessions, now: clock });
      stdout.write(`accepted: labels ${a.labels}, categories ${a.categories}\n`);
    }
    const pairs = Object.entries(result.byEntry).map(([name, k]) => `${name} ${k}`).join(', ');
    stdout.write(`proposed ${result.proposed}: ${pairs === '' ? 'none' : pairs}; errors ${result.errors}; left ${result.left}\n`);
    return result.left > 0 ? 1 : 0;
  }

  const { opts, error } = parse(rest, { port: 'value' });
  if (error) return usage(error);
  const port = opts.port === undefined ? 0 : Number(opts.port);
  if (!/^\d+$/.test(String(opts.port ?? 0)) || port > 65535) return usage('--port needs a port number, 0 to 65535');
  try {
    readFileSync(sampleFile);
  } catch {
    stderr.write(`triqual eval review: no sample at ${sampleFile}; run "triqual eval review sample" first\n`);
    return 1;
  }
  const labelGuard = randomBytes(16).toString('hex');
  let server;
  try {
    server = await startServer({ sampleFile, labelsFile: join(dir, 'labels.jsonl'), port, token: labelGuard });
  } catch (err) {
    stderr.write(`triqual eval review: the server could not start: ${err?.code ?? err?.message ?? 'error'}\n`);
    return 1;
  }
  stdout.write(`Review page: ${server.url}\nLabels are appended to ${join(dir, 'labels.jsonl')}. Ctrl-C stops the server.\n`);
  await (until ?? stopOnSignal());
  await server.close();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
