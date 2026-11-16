import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl } from '../cli/lib/eval-store.mjs';
import { SampleExists, drawSample, moreRandom, writeSample } from '../cli/lib/eval-sample.mjs';

const ROOT = '/fake/transcripts';
// Deterministic fixture: usd, turns, stopHookBlocks, idleRewrites all vary with the index.
const fixture = (count = 400) => Array.from({ length: count }, (_, i) => ({
  sessionId: `s${String(i).padStart(4, '0')}`,
  project: `/work/p${i % 7}`,
  projectDir: `-work-p${i % 7}`,
  entrypoint: 'cli',
  usd: ((i * 37) % 400) / 4,
  turns: 5 + ((i * 53) % 300),
  stopHookBlocks: (i * 11) % 9 === 0 ? i % 13 : 0,
  idleRewrites: (i * 17) % 23 === 0 ? i % 5 : 0,
}));
const counts = (rows) => rows.reduce((m, r) => ({ ...m, [r.stratum]: (m[r.stratum] ?? 0) + 1 }), {});
const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evsample-'));

test('proportions hold: 400 sessions, n=100 gives 50/25/25, no duplicates', () => {
  const rows = drawSample(fixture(), { n: 100, seed: 7, root: ROOT });
  assert.equal(rows.length, 100);
  assert.deepEqual(counts(rows), { random: 50, cost: 25, outlier: 25 });
  assert.equal(new Set(rows.map((r) => r.sessionId)).size, 100);
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['file', 'project', 'sessionId', 'stratum', 'turns', 'usd']);
  assert.equal(row.file, join(ROOT, `-work-p${Number(row.sessionId.slice(1)) % 7}`, `${row.sessionId}.jsonl`));
  // the cost stratum is the top usd among the sessions the random draw left
  const cost = rows.filter((r) => r.stratum === 'cost');
  const left = fixture().filter((s) => !rows.some((r) => r.stratum === 'random' && r.sessionId === s.sessionId));
  const top = left.map((s) => s.usd).sort((a, b) => b - a).slice(0, 25);
  assert.deepEqual(cost.map((r) => r.usd).sort((a, b) => b - a), top);
});

test('same seed same sample, another seed another one', () => {
  const a = drawSample(fixture(), { n: 100, seed: 42, root: ROOT });
  const b = drawSample(fixture().reverse(), { n: 100, seed: 42, root: ROOT });
  assert.deepEqual(a, b);
  const c = drawSample(fixture(), { n: 100, seed: 43, root: ROOT });
  assert.notDeepEqual(a.map((r) => r.sessionId), c.map((r) => r.sessionId));
});

test('non-cli sessions never sampled, excluded ones neither', () => {
  const sessions = fixture(200).map((s, i) => (i % 2 === 0 ? { ...s, entrypoint: 'sdk-cli' } : s));
  sessions[1].entrypoint = null;
  const exclude = new Set(['s0003', 's0005']);
  const rows = drawSample(sessions, { n: 100, seed: 1, exclude, root: ROOT });
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(byId.get(r.sessionId).entrypoint, 'cli');
  assert.ok(!rows.some((r) => exclude.has(r.sessionId)));
  assert.ok(rows.length <= 98); // 100 cli sessions, 2 of them excluded, null entrypoint is not cli
});

test('the outlier stratum takes the highest max percentile rank of stopHookBlocks, idleRewrites, turns', () => {
  // 10 sessions; with n=4: 2 random, 1 cost, 1 outlier. The unique stopHookBlocks outlier must be the outlier row
  // unless the random draw or the cost pick took it, so sweep seeds until it is left.
  const sessions = fixture(10).map((s, i) => ({ ...s, usd: i, turns: 10, stopHookBlocks: 0, idleRewrites: 0 }));
  sessions[4].stopHookBlocks = 50; // usd 4: not the top usd (9)
  for (let seed = 1; seed < 50; seed += 1) {
    const rows = drawSample(sessions, { n: 4, seed, root: ROOT });
    const random = rows.filter((r) => r.stratum === 'random').map((r) => r.sessionId);
    const outlier = rows.filter((r) => r.stratum === 'outlier');
    assert.equal(outlier.length, 1);
    if (!random.includes('s0004') && !rows.some((r) => r.stratum === 'cost' && r.sessionId === 's0004')) {
      assert.equal(outlier[0].sessionId, 's0004');
      return;
    }
  }
  assert.fail('no seed left the outlier session undrawn');
});

test('writeSample refuses to overwrite without force, writes 0600 JSONL, force replaces', () => {
  const dir = tmp();
  const file = join(dir, 'sub', 'sample.jsonl');
  const rows = drawSample(fixture(40), { n: 8, seed: 3, root: ROOT });
  writeSample(file, rows, { force: false });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  assert.deepEqual(readJsonl(file).rows, rows);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => writeSample(file, [], {}), (e) => e instanceof SampleExists && e.name === 'SampleExists');
  assert.equal(readFileSync(file, 'utf8'), before);
  writeSample(file, rows.slice(0, 2), { force: true });
  assert.equal(readJsonl(file).rows.length, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('moreRandom adds only unsampled cli sessions, stratum random, deterministic', () => {
  const sessions = fixture(60);
  sessions[0].entrypoint = 'sdk-cli';
  const existing = drawSample(sessions, { n: 20, seed: 5, root: ROOT });
  const more = moreRandom(sessions, existing, 15, 99, { root: ROOT });
  assert.equal(more.length, 15);
  assert.ok(more.every((r) => r.stratum === 'random'));
  const had = new Set(existing.map((r) => r.sessionId));
  assert.ok(more.every((r) => !had.has(r.sessionId) && r.sessionId !== 's0000'));
  assert.equal(new Set(more.map((r) => r.sessionId)).size, 15);
  assert.deepEqual(moreRandom(sessions, existing, 15, 99, { root: ROOT }), more);
  // asking for more than is left returns what is left
  assert.equal(moreRandom(sessions, existing, 1000, 99, { root: ROOT }).length, 59 - 20);
});

test('file defaults to the TRIQUAL_TRANSCRIPTS_DIR root of the sessions store', () => {
  const prev = process.env.TRIQUAL_TRANSCRIPTS_DIR;
  process.env.TRIQUAL_TRANSCRIPTS_DIR = '/env/root';
  try {
    const [row] = drawSample(fixture(1), { n: 1, seed: 1 });
    assert.equal(row.file, join('/env/root', '-work-p0', 's0000.jsonl'));
  } finally {
    if (prev === undefined) delete process.env.TRIQUAL_TRANSCRIPTS_DIR; else process.env.TRIQUAL_TRANSCRIPTS_DIR = prev;
  }
});

test('moreRandom with a usable predicate passes over the candidates it refuses and draws on, in the same order', () => {
  const sessions = fixture(60);
  const existing = drawSample(sessions, { n: 20, seed: 5, root: ROOT });
  const all = moreRandom(sessions, existing, 1000, 99, { root: ROOT });
  const blocked = new Set(all.slice(0, 10).map((r) => r.sessionId).concat(all.slice(12, 14).map((r) => r.sessionId)));
  const seen = [];
  const usable = (row) => { seen.push(row); return !blocked.has(row.sessionId); };
  const more = moreRandom(sessions, existing, 15, 99, { root: ROOT, usable });
  assert.equal(more.length, 15, 'k rows are still added');
  assert.ok(more.every((r) => !blocked.has(r.sessionId)));
  assert.deepEqual(more, all.filter((r) => !blocked.has(r.sessionId)).slice(0, 15), 'the candidates in draw order, minus the passed-over ones');
  assert.ok(seen.every((r) => typeof r.file === 'string' && r.file.endsWith(`${r.sessionId}.jsonl`)), 'the predicate gets the row with its transcript file');
  assert.ok(seen.length < all.length, 'the draw stops once k rows are found');
  assert.deepEqual(moreRandom(sessions, existing, 15, 99, { root: ROOT, usable }), more, 'deterministic');
  // fewer usable candidates than k: what there is
  const few = moreRandom(sessions, existing, 15, 99, { root: ROOT, usable: (row) => row.sessionId === all[3].sessionId });
  assert.deepEqual(few.map((r) => r.sessionId), [all[3].sessionId]);
  // without a predicate nothing changes
  assert.deepEqual(moreRandom(sessions, existing, 15, 99, { root: ROOT }), all.slice(0, 15));
});
