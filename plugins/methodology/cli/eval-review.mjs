// `triqual eval review sample [--n 100] [--seed <int>] [--force]` and `triqual eval review serve [--port <n>]`: the
// human labeling of sessions. `sample` refreshes the sessions store, draws a stratified sample of the interactive
// sessions (half random, a quarter by cost, the rest outliers) and writes <evals>/review/sample.jsonl, printing the
// rows per stratum and the seed; an existing sample is kept unless --force. `serve` starts the loopback review page
// (lib/eval-serve.mjs, 127.0.0.1 only, Host and Origin checked) over that sample, appends the labels to
// <evals>/review/labels.jsonl, prints its plain URL, and runs until SIGINT or SIGTERM. A random per-run value is embedded in the
// served page and required on every label POST; it is never printed. It prints counts, ids and paths, never transcript text. Exit codes: 0 done; 1 the store could not be updated, a sample exists (no --force), there is
// no sample to serve, or the server could not start; 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { drawSample, SampleExists, writeSample } from './lib/eval-sample.mjs';
import { refreshSessions } from './lib/eval-store.mjs';
import { startServer } from './lib/eval-serve.mjs';

export const SUMMARY = 'draw the stratified review sample (sample) and serve the local labeling page (serve)';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'prices.json'), 'utf8')).models;
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
  '  triqual eval review serve [--port <n>]',
  '      Serves the sample on http://127.0.0.1:<port>/ (a free port when --port is absent or 0) and appends the',
  '      good/bad labels to <evals>/review/labels.jsonl. Binds to 127.0.0.1 only, checks the Host and Origin',
  '      headers, and requires a per-run token (embedded in the page) on every label POST. Prints the URL;',
  '      runs until SIGINT.',
  '  triqual eval review --help',
  '',
].join('\n');

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
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, now = new Date(), until } = {}) {
  const usage = (m) => { stderr.write(`triqual eval review: ${m}\n${USAGE}`); return 2; };
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) { stdout.write(USAGE); return 0; }
  if (sub !== 'sample' && sub !== 'serve') return usage(sub === undefined ? 'a subcommand is needed: sample or serve' : `unknown subcommand ${sub.length > 40 ? `${sub.slice(0, 40)}...` : sub}`);

  const home = env.HOME || homedir();
  const dir = join(evalsDir(env, home), 'review');
  const sampleFile = join(dir, 'sample.jsonl');

  if (sub === 'sample') {
    const { opts, error } = parse(rest, { n: 'value', seed: 'value', force: 'bool' });
    if (error) return usage(error);
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
