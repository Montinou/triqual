// The stratified review sample of the evals data: which sessions a person reads. node: built-ins only.
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureDir, transcriptsRoot } from './eval-paths.mjs';

// Thrown by writeSample when the file exists and `force` is not set.
export class SampleExists extends Error {
  constructor(file) {
    super(`${file} already exists; pass force to replace it`);
    this.name = 'SampleExists';
    this.file = file;
  }
}

// A seeded PRNG in [0, 1): the same seed gives the same sequence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byId = (a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

// A copy of `list` in a seeded random order (Fisher-Yates).
function shuffled(list, seed) {
  const rand = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The transcript of a stored session: <transcripts root>/<projectDir>/<sessionId>.jsonl, the path mainTranscripts
// (lib/eval-sessions.mjs) read it from. The root is `root`, else TRIQUAL_TRANSCRIPTS_DIR / home/.claude/projects.
const fileOf = (s, root) => (typeof s.projectDir === 'string' ? join(root, s.projectDir, `${s.sessionId}.jsonl`) : null);

const rowOf = (s, stratum, root) => ({
  sessionId: s.sessionId, project: s.project ?? null, file: fileOf(s, root), stratum, usd: s.usd, turns: s.turns,
});

const defaultRoot = () => transcriptsRoot(process.env, homedir());
// The sessions a person may be asked to review: interactive CLI ones only.
const population = (sessions, skip) => sessions
  .filter((s) => s.entrypoint === 'cli' && typeof s.sessionId === 'string' && !skip.has(s.sessionId))
  .sort(byId);

// Percentile rank of each value among `values`: the share of values strictly below it, so a metric that is 0 for most
// sessions ranks them all 0 and only a real outlier ranks high.
function ranks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const below = (v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  };
  return values.map(below);
}

// n rows of the cli sessions not in `exclude`: round(n/2) random (seeded), then round(n/4) with the highest usd among
// the rest, then the remaining n - those by outlier score: the max of the percentile ranks of stopHookBlocks,
// idleRewrites and turns among the sessions still left. Fewer rows when the population is smaller. `root` overrides
// where a row's `file` points (see fileOf).
export function drawSample(sessions, { n = 100, seed, exclude = new Set(), root = defaultRoot() } = {}) {
  const pool = population(sessions, exclude);
  const nRandom = Math.min(Math.round(n / 2), pool.length);
  const random = shuffled(pool, seed).slice(0, nRandom);
  const taken = new Set(random.map((s) => s.sessionId));
  let rest = pool.filter((s) => !taken.has(s.sessionId));

  const nCost = Math.min(Math.round(n / 4), rest.length);
  const cost = [...rest].sort((a, b) => (b.usd - a.usd) || byId(a, b)).slice(0, nCost);
  for (const s of cost) taken.add(s.sessionId);
  rest = rest.filter((s) => !taken.has(s.sessionId));

  const nOutlier = Math.min(Math.max(n - nRandom - nCost, 0), rest.length);
  const r = [ranks(rest.map((s) => s.stopHookBlocks ?? 0)), ranks(rest.map((s) => s.idleRewrites ?? 0)), ranks(rest.map((s) => s.turns ?? 0))];
  const outlier = rest
    .map((s, i) => ({ s, score: Math.max(r[0][i], r[1][i], r[2][i]) }))
    .sort((a, b) => (b.score - a.score) || byId(a.s, b.s))
    .slice(0, nOutlier)
    .map((x) => x.s);

  return [
    ...random.map((s) => rowOf(s, 'random', root)),
    ...cost.map((s) => rowOf(s, 'cost', root)),
    ...outlier.map((s) => rowOf(s, 'outlier', root)),
  ];
}

// Writes `rows` as JSONL (mode 0600, its directory 0700). An existing file is refused with SampleExists unless
// `force`; a forced write goes through a temp file and a rename.
export function writeSample(file, rows, { force = false } = {}) {
  ensureDir(dirname(file));
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  if (!force) {
    try { writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); } catch (err) {
      if (err.code === 'EEXIST') throw new SampleExists(file);
      throw err;
    }
  } else {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
  chmodSync(file, 0o600);
}

// k more random-stratum rows (seeded) among the cli sessions whose id is not in `existing` (SampleRow[]); fewer when
// fewer are left. With `since` (YYYY-MM-DD or an ISO timestamp, compared as text with the session's `start`) only the
// sessions whose last activity is at or after it are candidates (the store's `end`, else its `start` for a line with no
// end: a session that started long ago and is still going counts). `at`, when given, is stamped on each added row (the time of the draw).
// `usable(row)` (default: every candidate) is asked of each candidate
// row, in draw order, and a candidate it refuses is passed over: the draw goes on to the next one, so k rows are added when
// the population allows. It is asked only until k rows are found; the order and the seed are the same with or without it.
export function moreRandom(sessions, existing, k, seed, { root = defaultRoot(), since, usable = () => true, at } = {}) {
  const had = new Set(existing.map((r) => r.sessionId));
  const lastActivity = (s) => (typeof s.end === 'string' ? s.end : s.start);
  const pool = population(sessions, had).filter((s) => since === undefined || (typeof lastActivity(s) === 'string' && lastActivity(s) >= since));
  const out = [];
  for (const s of shuffled(pool, seed)) {
    if (out.length >= k) break;
    const row = rowOf(s, 'random', root);
    if (usable(row)) out.push(at === undefined ? row : { ...row, at });
  }
  return out;
}
