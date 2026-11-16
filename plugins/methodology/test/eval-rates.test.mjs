import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-rates.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { ratesTables } from '../cli/lib/eval-rates.mjs';
import { wilson } from '../cli/lib/eval-stats.mjs';

const CAT = { id: 'repeat-ask' };
const CATS = [CAT, { id: 'owner-chased-progress' }];

// spec: [{ id, start, version, stratum?, verdict }] -> the inputs of ratesTables for the category `repeat-ask`.
function build(specs) {
  const sample = []; const sessions = new Map(); const verdict = new Map();
  for (const s of specs) {
    sample.push({ sessionId: s.id, stratum: s.stratum ?? 'random' });
    const line = { sessionId: s.id, start: s.start };
    if (s.version !== undefined) line.methodologyVersion = s.version;
    sessions.set(s.id, line);
    if (s.verdict !== undefined) verdict.set(s.id, s.verdict);
  }
  return { sample, sessions, categories: CATS, verdicts: new Map([[CAT.id, verdict]]) };
}

const NOV = '2026-11-03T10:00:00Z';
const OCT = '2026-10-20T10:00:00Z';

test('six sessions in a month with two fails give share 2/6 and a Wilson interval; a month of two has no share', () => {
  const specs = [];
  for (let i = 0; i < 6; i += 1) specs.push({ id: `n${i}`, start: NOV, version: '1.0.0', verdict: i < 2 ? 'fail' : 'pass' });
  specs.push({ id: 'o0', start: OCT, version: '1.0.0', verdict: 'fail' }, { id: 'o1', start: OCT, version: '1.0.0', verdict: 'pass' });
  const { month } = ratesTables(build(specs));
  assert.deepEqual(month.map((r) => r.bucket), ['2026-10', '2026-11']);
  assert.deepEqual(month[0], { category: 'repeat-ask', bucket: '2026-10', n: 2, fail: 1, share: null, ci: null });
  assert.equal(month[1].n, 6);
  assert.equal(month[1].fail, 2);
  assert.equal(month[1].share, 2 / 6);
  assert.deepEqual(month[1].ci, wilson(2, 6));
});

test('a cost-stratum session and an undecided verdict are not counted', () => {
  const { month } = ratesTables(build([
    { id: 'a', start: NOV, verdict: 'fail' },
    { id: 'b', start: NOV, verdict: 'fail', stratum: 'cost' },
    { id: 'c', start: NOV, verdict: 'undecided' },
    { id: 'd', start: NOV },
  ]));
  assert.equal(month.length, 1);
  assert.equal(month[0].n, 1);
  assert.equal(month[0].fail, 1);
});

test('a store line without methodologyVersion, or with a null one, lands in unknown; versions sort ascending', () => {
  const { version } = ratesTables(build([
    { id: 'a', start: NOV, verdict: 'fail' },
    { id: 'b', start: NOV, version: null, verdict: 'pass' },
    { id: 'c', start: NOV, version: '1.2.0', verdict: 'pass' },
    { id: 'd', start: NOV, version: '1.1.0', verdict: 'pass' },
  ]));
  assert.deepEqual(version.map((r) => [r.bucket, r.n, r.fail]), [['1.1.0', 1, 0], ['1.2.0', 1, 0], ['unknown', 2, 1]]);
});

test('rows follow taxonomy order, then bucket', () => {
  const b = build([{ id: 'a', start: NOV, verdict: 'fail' }]);
  b.verdicts.set('owner-chased-progress', new Map([['a', 'pass']]));
  const { month } = ratesTables({ ...b, categories: [CATS[1], CATS[0]] });
  assert.deepEqual(month.map((r) => r.category), ['owner-chased-progress', 'repeat-ask']);
});

// ---- the command ----
const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'owner-chased-progress', name: 'Owner chased progress', definition: 'The owner asked whether anything was happening.', examples: ['e1', 'e2', 'e3'], check: 'code' },
  ],
};

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'cm-rates-'));
  const evals = join(base, 'evals');
  mkdirSync(join(evals, 'review'), { recursive: true });
  mkdirSync(join(evals, 'judgments'), { recursive: true });
  const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
  writeFileSync(join(evals, 'review', 'sample.jsonl'), ids.map((id) => `${JSON.stringify({ sessionId: id, stratum: 'random' })}\n`).join(''));
  writeFileSync(join(evals, 'sessions.jsonl'), ids.map((id, i) => `${JSON.stringify({ sessionId: id, start: i < 5 ? NOV : OCT, methodologyVersion: i < 5 ? '1.0.0' : null })}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  writeFileSync(join(evals, 'label-categories.jsonl'), ['e1', 'e2', 'e3'].map((id) => `${JSON.stringify({ sessionId: id, categories: [] })}\n`).join(''));
  const j = (id, result, promptHash = 'v1') => `${JSON.stringify({ sessionId: id, category: 'owner-chased-progress', result, promptHash })}\n`;
  writeFileSync(join(evals, 'judgments', 'owner-chased-progress.jsonl'),
    j('s0', 'pass', 'old') + j('s0', 'fail') + j('s1', 'pass') + j('s2', 'pass') + j('s3', 'pass') + j('s4', 'pass') + j('s5', 'fail') + j('s6', 'pass'));
  return { evals, env: { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals } };
}

function run(argv, env, extra = {}) {
  let out = ''; let err = '';
  const p = main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, version: 'v1', ...extra });
  return p.then((code) => ({ code, out, err }));
}

test('the command prints both tables and exits 0: a bucket of five shows a share, one under five shows fail/n', async () => {
  const f = fixture();
  const r = await run([], f.env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /by month/);
  assert.match(r.out, /by methodology version/);
  const month = r.out.split('\n').filter((l) => l.includes('2026-11'));
  assert.equal(month.length, 1);
  assert.match(month[0], /5/);
  assert.match(month[0], /20\.0%/); // 1 fail of 5
  const oct = r.out.split('\n').filter((l) => l.includes('2026-10'));
  assert.match(oct[0], /1\/2/);
  assert.doesNotMatch(oct[0], /%/);
  assert.ok(r.out.split('\n').some((l) => l.includes('unknown') && l.includes('1/2')));
  assert.equal(r.err, '');
  assert.ok(!r.out.includes('no verdicts under the current version'), r.out);
});

test('a category with no verdict under the current version gets one line and no table row', async () => {
  const f = fixture();
  writeFileSync(join(f.evals, 'judgments', 'owner-chased-progress.jsonl'), `${JSON.stringify({ sessionId: 's0', category: 'owner-chased-progress', result: 'fail', promptHash: 'old' })}\n`);
  const r = await run([], f.env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.split('\n').filter((l) => l.includes('no verdicts')), ['owner-chased-progress: no verdicts under the current version']);
  assert.ok(!r.out.split('\n').some((l) => l.startsWith('owner-chased-progress ') && l.includes('2026-')), r.out);
});

test('--help, an unknown argument, and the dispatcher', async () => {
  const f = fixture();
  const h = await run(['--help'], f.env);
  assert.equal(h.code, 0);
  assert.match(h.out, /triqual eval rates/);
  const bad = await run(['--nope'], f.env);
  assert.equal(bad.code, 2);
  let out = '';
  assert.equal(await evalMain([], { stdout: { write: (s) => { out += s; } } }), 0);
  assert.match(out, /rates/);
});

test('no sample is an error, exit 1', async () => {
  const f = fixture();
  writeFileSync(join(f.evals, 'review', 'sample.jsonl'), '');
  const r = await run([], f.env);
  assert.equal(r.code, 1);
});
