#!/usr/bin/env node
// Replay harness CLI. `node replay.mjs sample --out <dir> --n 20 [--seed N] [--exclude <regex>]` reads
// `triqual tasks export --json --all`, drops client repos (/^attorney/i, always) and any repo matching --exclude (added on top, case-insensitive) and commits that do
// not resolve in their repo (`git cat-file -e`), and writes <dir>/sample.json (rows { repo, root, plan, task, tier, sha }).
// It prints counts only, never task content. Exit 0 done, 1 export failed, 2 usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeExport, sampleTasks } from './lib/replay-sample.mjs';

const USAGE = 'usage: replay.mjs sample --out <dir> [--n 20] [--seed N] [--exclude <regex>]\n';
const [command, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i < 0 ? fallback : rest[i + 1]; };
const usage = () => { process.stderr.write(USAGE); process.exit(2); };

if (command !== 'sample') usage();
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
