#!/usr/bin/env node
// Replay harness CLI. `node replay.mjs sample --out <dir> --n 20 [--seed N] [--exclude <regex>]` reads
// `triqual tasks export --json --all`, drops client repos (/^attorney/i, always) and any repo matching --exclude (added on top, case-insensitive) and commits that do
// not resolve in their repo (`git cat-file -e`), and writes <dir>/sample.json (rows { repo, root, plan, task, tier, sha }).
// `node replay.mjs package --sample <file> --out <dir> [--max-bytes N]` builds, for each sampled row, <dir>/NN/{diff.patch,message.txt}
// (lib/replay-package.mjs) and writes <dir>/packages.json (rows { dir, bytes, tooLarge } or { dir, error }).
// `node replay.mjs score --results <file>` reads judged runs ([{ task, setting, findings, verdicts | null, usd, seconds }])
// (lib/replay-score.mjs), prints the per-setting summary as JSON and writes it to replay_summary.json beside <file>.
// All three print counts, rates and paths only, never task, diff or commit-message text. Exit 0 done, 1 failed, 2 usage.
// Pass a scratch directory outside the repository as --out: replay outputs never enter it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeExport, sampleTasks } from './lib/replay-sample.mjs';
import { buildPackage } from './lib/replay-package.mjs';
import { summarize } from './lib/replay-score.mjs';

const USAGE = 'usage: replay.mjs sample --out <dir> [--n 20] [--seed N] [--exclude <regex>]\n'
  + '       replay.mjs package --sample <file> --out <dir> [--max-bytes N]\n'
  + '       replay.mjs score --results <file>\n';
const [command, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i < 0 ? fallback : rest[i + 1]; };
const usage = () => { process.stderr.write(USAGE); process.exit(2); };

if (command !== 'sample' && command !== 'package' && command !== 'score') usage();
if (command === 'package') runPackage();
else if (command === 'score') runScore();
else runSample();

function runScore() {
  const resultsPath = opt('results');
  if (!resultsPath) usage();
  let results;
  try { results = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { process.stderr.write('results file is missing or not JSON\n'); process.exit(1); }
  let summary;
  try { summary = summarize(results); } catch (err) { process.stderr.write(`${err instanceof Error ? err.message : 'results are malformed'}\n`); process.exit(1); }
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(dirname(resultsPath), 'replay_summary.json'), json);
  process.stdout.write(json);
}

function runPackage() {
  const samplePath = opt('sample');
  const packOut = opt('out');
  const maxBytes = Number(opt('max-bytes', '204800'));
  if (!samplePath || !packOut || !Number.isInteger(maxBytes) || maxBytes < 1) usage();
  let rows;
  try { rows = JSON.parse(readFileSync(samplePath, 'utf8')); } catch { process.stderr.write('sample file is missing or not JSON\n'); process.exit(1); }
  if (!Array.isArray(rows)) { process.stderr.write('sample file is not an array of rows\n'); process.exit(1); }
  const pad = String(rows.length).length;
  const manifest = rows.map((row, i) => {
    const dir = join(packOut, String(i + 1).padStart(Math.max(2, pad), '0'));
    try {
      const { bytes, tooLarge } = buildPackage({ root: row?.root, sha: row?.sha, out: dir, maxBytes });
      return { dir, bytes, tooLarge };
    } catch (err) {
      // The message is ours (buildPackage's fixed texts), never git output or commit content.
      return { dir, error: err instanceof Error ? err.message : 'failed' };
    }
  });
  mkdirSync(packOut, { recursive: true });
  writeFileSync(join(packOut, 'packages.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const ok = manifest.filter((m) => m.error === undefined);
  const large = ok.filter((m) => m.tooLarge).length;
  process.stdout.write(`packaged ${ok.length} of ${rows.length} sampled tasks (${large} too large, ${manifest.length - ok.length} refused) -> ${join(packOut, 'packages.json')}\n`);
  if (ok.length === 0 && rows.length > 0) process.exit(1);
}

function runSample() {
  const out = opt('out');
  const n = Number(opt('n', '20'));
  const seed = Number(opt('seed', '1'));
  let exclude;
  try { exclude = opt('exclude') === undefined ? undefined : new RegExp(opt('exclude'), 'i'); } catch { usage(); }
  if (!out || !Number.isInteger(n) || n < 1 || !Number.isInteger(seed)) usage();

  const exported = spawnSync('triqual', ['tasks', 'export', '--json', '--all'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (exported.status !== 0) { process.stderr.write(`triqual tasks export failed (exit ${exported.status})\n`); process.exit(1); }
  let json;
  try { json = JSON.parse(exported.stdout); } catch { process.stderr.write('triqual tasks export did not print JSON\n'); process.exit(1); }

  const rows = normalizeExport(json);
  const resolves = (root, sha) => spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }).status === 0;
  const sample = sampleTasks(rows, { n, exclude, seed, resolves });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'sample.json'), `${JSON.stringify(sample, null, 2)}\n`);
  const byTier = {};
  for (const r of sample) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
  process.stdout.write(`sampled ${sample.length} of ${rows.length} candidate tasks (n=${n}, seed=${seed}) by tier ${JSON.stringify(byTier)} -> ${join(out, 'sample.json')}\n`);
}
