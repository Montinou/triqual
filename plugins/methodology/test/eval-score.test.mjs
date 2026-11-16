import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-score.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { currentVersion, previousVersion, scoreCategory } from '../cli/lib/eval-score.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';
import { splitOf } from '../cli/lib/eval-validate.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-score-'));
const mode = (f) => statSync(f).mode & 0o777;
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

// Fixture session ids with a known split: random-stratum ids found by computing splitOf, stratified ones are train.
const ids = { dev: [], test: [] };
for (let i = 0; ids.dev.length < 14 || ids.test.length < 4; i += 1) {
  const id = `sess-${i}`;
  const s = splitOf(id, 'random');
  if (ids[s].length < 14) ids[s].push(id);
}
const trainIds = ['tr-0', 'tr-1'];
for (const id of trainIds) assert.equal(splitOf(id, 'cost'), 'train');
let devCursor = 0;
const nextDev = () => ids.dev[devCursor++];

const CAT = { id: 'repeat-ask', check: 'judge' };

// spec: [{ id, positive, v1, v2, stratum? }] -> the inputs of scoreCategory. v1/v2: the verdict under 'v1'/'v2' or undefined.
function build(specs) {
  const sample = []; const labels = []; const labelCategories = new Map(); const judgments = [];
  for (const s of specs) {
    sample.push({ sessionId: s.id, stratum: s.stratum ?? 'random' });
    labels.push({ sessionId: s.id });
    labelCategories.set(s.id, s.positive ? [CAT.id] : []);
  }
  for (const v of ['v1', 'v2']) {
    for (const s of specs) if (s[v] !== undefined) judgments.push({ sessionId: s.id, category: CAT.id, result: s[v], promptHash: v });
  }
  return { category: CAT, sample, labels, labelCategories, judgments, version: 'v2' };
}
const dev = (positive, v1, v2) => ({ id: nextDev(), positive, v1, v2 });
const reset = () => { devCursor = 0; };

test('a newer version that fixes one dev error is better, and previous.n counts only sessions judged under both', () => {
  reset();
  const specs = [
    dev(true, 'pass', 'fail'), // the newer version fixes this miss
    dev(true, 'fail', 'fail'),
    dev(false, 'pass', 'pass'),
    dev(false, 'pass', 'pass'),
    dev(false, undefined, 'pass'), // judged under the newer version only
  ];
  const r = scoreCategory(build(specs));
  assert.equal(r.category, 'repeat-ask');
  assert.equal(r.check, 'judge');
  assert.equal(r.version, 'v2');
  assert.equal(r.previous.version, 'v1');
  assert.equal(r.previous.n, 4);
  assert.deepEqual(r.previous.previous, { tp: 1, fn: 1, tn: 2, fp: 0, balanced: 0.75 });
  assert.deepEqual(r.previous.current, { tp: 2, fn: 0, tn: 2, fp: 0, balanced: 1 });
  assert.equal(r.verdict, 'better');
  assert.equal(r.dev.tp + r.dev.fn + r.dev.tn + r.dev.fp, 5);
});

test('fewer failures found and one false alarm fewer is not better: the balanced rate decides, not the count', () => {
  reset();
  const specs = [
    dev(true, 'fail', 'fail'),
    dev(true, 'fail', 'pass'), // the newer version misses this one
    ...Array.from({ length: 8 }, () => dev(false, 'pass', 'pass')),
    dev(false, 'fail', 'pass'), // a false alarm gone ...
    dev(false, 'fail', 'fail'),
  ];
  const r = scoreCategory(build(specs));
  assert.equal(r.previous.previous.balanced, (1 + 0.8) / 2);
  assert.equal(r.previous.current.balanced, (0.5 + 0.9) / 2);
  assert.equal(r.previous.previous.tp + r.previous.previous.tn, 10);
  assert.equal(r.previous.current.tp + r.previous.current.tn, 10);
  assert.equal(r.verdict, 'not-better');
});

// 2 positives and 10 negatives. v1: tp0 fn2 tn10 fp0 (10 correct, balanced 0.5); v2: tp2 fn0 tn7 fp3 (9 correct, balanced 0.85).
const skewed = (before, after) => [
  ...Array.from({ length: 2 }, () => dev(true, before.tp ? 'fail' : 'pass', after.tp ? 'fail' : 'pass')),
  ...Array.from({ length: 7 }, () => dev(false, 'pass', 'pass')),
  ...Array.from({ length: 3 }, () => dev(false, before.fp ? 'fail' : 'pass', after.fp ? 'fail' : 'pass')),
];

test('fewer correct verdicts but a higher balanced rate is better: the balanced rate decides, not the count', () => {
  reset();
  const r = scoreCategory(build(skewed({ tp: false, fp: false }, { tp: true, fp: true })));
  assert.deepEqual(r.previous.previous, { tp: 0, fn: 2, tn: 10, fp: 0, balanced: 0.5 });
  assert.deepEqual(r.previous.current, { tp: 2, fn: 0, tn: 7, fp: 3, balanced: (1 + 0.7) / 2 });
  assert.ok(r.previous.previous.tp + r.previous.previous.tn > r.previous.current.tp + r.previous.current.tn);
  assert.equal(r.verdict, 'better');
});

test('more correct verdicts but a lower balanced rate is not better', () => {
  reset();
  const r = scoreCategory(build(skewed({ tp: true, fp: true }, { tp: false, fp: false })));
  assert.deepEqual(r.previous.previous, { tp: 2, fn: 0, tn: 7, fp: 3, balanced: (1 + 0.7) / 2 });
  assert.deepEqual(r.previous.current, { tp: 0, fn: 2, tn: 10, fp: 0, balanced: 0.5 });
  assert.ok(r.previous.current.tp + r.previous.current.tn > r.previous.previous.tp + r.previous.previous.tn);
  assert.equal(r.verdict, 'not-better');
});

test('equal counts are not better', () => {
  reset();
  const r = scoreCategory(build([dev(true, 'fail', 'fail'), dev(false, 'pass', 'pass')]));
  assert.equal(r.verdict, 'not-better');
});

test('a dev set with no positive falls back to correct verdicts: one more correct is better', () => {
  reset();
  const r = scoreCategory(build([dev(false, 'fail', 'pass'), dev(false, 'pass', 'pass')]));
  assert.equal(r.previous.previous.balanced, null);
  assert.equal(r.previous.current.balanced, null);
  assert.equal(r.verdict, 'better');
  reset();
  assert.equal(scoreCategory(build([dev(false, 'pass', 'fail'), dev(false, 'pass', 'pass')])).verdict, 'not-better');
});

test('a dev session undecided under the previous version is in neither side', () => {
  reset();
  const r = scoreCategory(build([
    dev(true, 'fail', 'fail'),
    dev(false, 'pass', 'pass'),
    dev(false, 'undecided', 'fail'),
  ]));
  assert.equal(r.previous.n, 2);
  assert.deepEqual(r.previous.previous, { tp: 1, fn: 0, tn: 1, fp: 0, balanced: 1 });
  assert.deepEqual(r.previous.current, { tp: 1, fn: 0, tn: 1, fp: 0, balanced: 1 });
  assert.equal(r.verdict, 'not-better');
});

test('a single version is first and has no previous', () => {
  reset();
  const r = scoreCategory(build([dev(true, undefined, 'fail'), dev(false, undefined, 'pass')]));
  assert.equal(r.previous, null);
  assert.equal(r.verdict, 'first');
  assert.equal(r.dev.tp, 1);
  assert.equal(r.dev.tn, 1);
});

test('a train session and a test session that differ between versions do not change previous', () => {
  reset();
  const base = [dev(true, 'pass', 'fail'), dev(false, 'pass', 'pass')];
  const without = scoreCategory(build(base));
  const extra = [
    { id: trainIds[0], positive: true, v1: 'fail', v2: 'pass', stratum: 'cost' },
    { id: ids.test[0], positive: false, v1: 'pass', v2: 'fail' },
  ];
  const withExtra = scoreCategory(build([...base, ...extra]));
  assert.deepEqual(withExtra.previous, without.previous);
  assert.equal(withExtra.verdict, without.verdict);
  assert.equal(withExtra.train.fn, 1);
  assert.equal(withExtra.test.fp, 1);
  assert.equal(typeof withExtra.test.usable, 'boolean');
  assert.equal('usable' in withExtra.dev, false);
  assert.equal('positives' in withExtra.dev, false);
});

// Three versions: explicit judgment lines in file order, over dev sessions (labeled, positive or not) and a train one.
function build3(specs, judgments) {
  const sample = []; const labels = []; const labelCategories = new Map();
  for (const s of specs) {
    sample.push({ sessionId: s.id, stratum: s.stratum ?? 'random' });
    labels.push({ sessionId: s.id });
    labelCategories.set(s.id, s.positive ? [CAT.id] : []);
  }
  return { category: CAT, sample, labels, labelCategories, judgments: judgments.map(([id, version, result]) => ({ sessionId: id, category: CAT.id, result, promptHash: version })), version: 'v2' };
}

test('the most recent other version judged only on train sessions is skipped: the comparison uses the older version with sessions', () => {
  reset();
  const a = dev(true, undefined, undefined); const b = dev(false, undefined, undefined);
  const t = { id: trainIds[0], positive: true, stratum: 'cost' };
  const r = scoreCategory(build3([a, b, t], [
    [a.id, 'v0', 'pass'], [b.id, 'v0', 'pass'],
    [t.id, 'v1', 'fail'], // the latest other version: train only
    [a.id, 'v2', 'fail'], [b.id, 'v2', 'pass'],
  ]));
  assert.equal(r.previous.version, 'v0');
  assert.equal(r.previous.n, 2);
  assert.deepEqual(r.previous.previous, { tp: 0, fn: 1, tn: 1, fp: 0, balanced: 0.5 });
  assert.deepEqual(r.previous.current, { tp: 1, fn: 0, tn: 1, fp: 0, balanced: 1 });
  assert.equal(r.verdict, 'better');
});

test('the most recent other version with only undecided dev verdicts is skipped for an older one with decided verdicts', () => {
  reset();
  const a = dev(true, undefined, undefined); const b = dev(false, undefined, undefined);
  const r = scoreCategory(build3([a, b], [
    [a.id, 'v0', 'fail'], [b.id, 'v0', 'pass'],
    [a.id, 'v1', 'undecided'], [b.id, 'v1', 'undecided'],
    [a.id, 'v2', 'fail'], [b.id, 'v2', 'pass'],
  ]));
  assert.equal(r.previous.version, 'v0');
  assert.ok(r.previous.n > 0);
  assert.equal(r.verdict, 'not-better');
});

test('no other version shares a decided labeled dev session with the current one: previous is null and the verdict is first', () => {
  reset();
  const a = dev(true, undefined, undefined); const b = dev(false, undefined, undefined);
  const t = { id: trainIds[0], positive: false, stratum: 'cost' };
  const r = scoreCategory(build3([a, b, t], [
    [t.id, 'v0', 'pass'], // train only
    [a.id, 'v1', 'undecided'], // undecided on dev
    [a.id, 'v2', 'fail'], [b.id, 'v2', 'pass'],
  ]));
  assert.equal(r.previous, null);
  assert.equal(r.verdict, 'first');
});

test('a dev session that is not labeled does not make a version comparable', () => {
  reset();
  const a = dev(true, undefined, undefined); const b = dev(false, undefined, undefined);
  const input = build3([a, b], [[a.id, 'v1', 'fail'], [a.id, 'v2', 'fail'], [b.id, 'v2', 'pass']]);
  input.labels = input.labels.filter((l) => l.sessionId !== a.id);
  const r = scoreCategory(input);
  assert.equal(r.previous, null);
  assert.equal(r.verdict, 'first');
});

// Three versions in file order A, B, C (current), each judged on the same labeled dev sessions. B measures worse than A;
// C measures better than B and the same as A.
function threeVersions() {
  reset();
  const p1 = dev(true, undefined, undefined); const p2 = dev(true, undefined, undefined);
  const n1 = dev(false, undefined, undefined); const n2 = dev(false, undefined, undefined);
  const rows = [];
  const under = (v, verdicts) => [p1, p2, n1, n2].forEach((s, i) => rows.push([s.id, v, verdicts[i]]));
  under('A', ['fail', 'fail', 'pass', 'pass']);
  under('B', ['pass', 'fail', 'pass', 'pass']); // B misses one failure: worse than A
  under('C', ['fail', 'fail', 'pass', 'pass']);
  const input = build3([p1, p2, n1, n2], rows);
  input.version = 'C';
  return input;
}

test('with no baseline the comparison is with the most recent other version, B, a version that measured worse than A', () => {
  const r = scoreCategory(threeVersions());
  assert.equal(r.previous.version, 'B');
  assert.deepEqual(r.previous.previous, { tp: 1, fn: 1, tn: 2, fp: 0, balanced: 0.75 });
  assert.equal(r.verdict, 'better');
});

test('against names the version to compare with: A, in place of the most recent other version, and the verdict follows A', () => {
  const r = scoreCategory({ ...threeVersions(), against: 'A' });
  assert.equal(r.previous.version, 'A');
  assert.equal(r.previous.n, 4);
  assert.deepEqual(r.previous.previous, { tp: 2, fn: 0, tn: 2, fp: 0, balanced: 1 });
  assert.deepEqual(r.previous.current, { tp: 2, fn: 0, tn: 2, fp: 0, balanced: 1 });
  assert.equal(r.verdict, 'not-better');
});

test('against a version with no labeled dev session decided under both is first, and no other version is tried', () => {
  const input = threeVersions();
  input.judgments.push({ sessionId: trainIds[0], category: CAT.id, result: 'pass', promptHash: 'Z' }); // Z: a train session only
  const r = scoreCategory({ ...input, against: 'Z' });
  assert.equal(r.previous, null);
  assert.equal(r.verdict, 'first');
  const none = scoreCategory({ ...threeVersions(), against: 'never-judged' });
  assert.equal(none.previous, null);
  assert.equal(none.verdict, 'first');
});

test('previousVersion is the hash of the last differing line, not the first', () => {
  const j = (h) => ({ sessionId: 'x', promptHash: h });
  assert.equal(previousVersion([j('v1'), j('v2'), j('cur'), j('cur')], 'cur'), 'v2');
  assert.equal(previousVersion([j('v1'), j('cur'), j('v2'), j('cur')], 'cur'), 'v2');
  assert.equal(previousVersion([j('cur')], 'cur'), null);
  assert.equal(previousVersion([], 'cur'), null);
});

test('currentVersion is the judge prompt hash for a judge category and the version or checkVersion for a code one', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'repeat-ask.md'), '---\nmodel: claude-sonnet-4-5-20250929\n---\nJudge it.\n');
  assert.equal(currentVersion({ id: 'repeat-ask', check: 'judge' }, { judgesDir: dir }), loadJudgePrompt(join(dir, 'repeat-ask.md')).hash);
  assert.equal(currentVersion({ id: 'owner-chased-progress', check: 'code' }, { judgesDir: dir, version: 'cv1' }), 'cv1');
  assert.match(currentVersion({ id: 'owner-chased-progress', check: 'code' }, { judgesDir: dir }), /^[0-9a-f]{16}$/);
});

// ---- the command

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'owner-chased-progress', name: 'Owner chased progress', definition: 'The owner asked whether anything was happening.', examples: ['e1', 'e2', 'e3'], check: 'code' },
    { id: 'repeat-ask', name: 'Repeated request', definition: 'The owner had to say the same thing twice.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
  ],
};

function fixture({ judgeVersions = 2 } = {}) {
  const base = tmp();
  const evals = join(base, 'evals');
  const judges = join(base, 'judges');
  mkdirSync(join(evals, 'review'), { recursive: true });
  mkdirSync(join(evals, 'judgments'), { recursive: true });
  mkdirSync(judges, { recursive: true });
  const judgeFile = join(judges, 'repeat-ask.md');
  writeFileSync(judgeFile, '---\nmodel: claude-sonnet-4-5-20250929\n---\nJudge the repeat.\n');
  const hash = loadJudgePrompt(judgeFile).hash;
  const [d1, d2] = ids.dev;
  writeFileSync(join(evals, 'review', 'sample.jsonl'), [d1, d2].map((id) => `${JSON.stringify({ sessionId: id, stratum: 'random' })}\n`).join(''));
  writeFileSync(join(evals, 'review', 'labels.jsonl'), [d1, d2].map((id) => `${JSON.stringify({ sessionId: id })}\n`).join(''));
  writeFileSync(join(evals, 'label-categories.jsonl'), [
    ...['e1', 'e2', 'e3'].map((id) => ({ sessionId: id, categories: [] })),
    { sessionId: d1, categories: ['repeat-ask', 'owner-chased-progress'] },
    { sessionId: d2, categories: [] },
  ].map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  const rows = (cat, hashes) => hashes.flatMap((h, k) => [
    { sessionId: d1, category: cat, result: k === hashes.length - 1 ? 'fail' : 'pass', promptHash: h },
    { sessionId: d2, category: cat, result: 'pass', promptHash: h },
  ]);
  const judgeHashes = judgeVersions === 2 ? ['old-judge', hash] : [hash];
  writeFileSync(join(evals, 'judgments', 'repeat-ask.jsonl'), rows('repeat-ask', judgeHashes).map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'judgments', 'owner-chased-progress.jsonl'), rows('owner-chased-progress', ['c1']).map((r) => `${JSON.stringify(r)}\n`).join(''));
  const env = { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals };
  return { base, evals, judges, env, out: join(evals, 'scores.jsonl') };
}

function run(argv, f, extra = {}) {
  let out = ''; let err = '';
  const p = main(argv, {
    env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    now: () => new Date('2026-11-16T12:00:00Z'), judgesDir: f.judges, version: 'c1', ...extra,
  });
  return p.then((code) => ({ code, out, err }));
}

const pluginVersion = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;

test('score prints a table and a dev line per category and appends one scores.jsonl line per category, 0600', async () => {
  const f = fixture();
  const r = await run([], f);
  assert.equal(r.code, 0);
  const rows = lines(f.out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.category), ['owner-chased-progress', 'repeat-ask']);
  for (const x of rows) {
    assert.equal(x.pluginVersion, pluginVersion);
    assert.equal(x.at, '2026-11-16T12:00:00.000Z');
    assert.ok(['train', 'dev', 'test'].every((k) => k in x));
  }
  assert.equal(rows[0].verdict, 'first');
  assert.equal(rows[0].version, 'c1');
  assert.equal(rows[1].verdict, 'better');
  assert.equal(rows[1].previous.version, 'old-judge');
  assert.equal(mode(f.out), 0o600);
  const text = r.out.split('\n');
  assert.ok(text.includes('dev: first version'));
  assert.ok(text.some((l) => /^dev: previous 0\.500 \(1\/2\), current 1\.000 \(2\/2\): better$/.test(l)));
  for (const split of ['train', 'dev', 'test']) assert.ok(text.some((l) => /^repeat-ask\s/.test(l) && new RegExp(`\\s${split}\\s`).test(l)));
  assert.doesNotMatch(r.out, /Judge the repeat/);
});

test('a second run appends again and keeps the earlier lines', async () => {
  const f = fixture();
  await run([], f);
  await run([], f);
  assert.equal(lines(f.out).length, 4);
});

test('--category scores one category; a single judge version prints first version', async () => {
  const f = fixture({ judgeVersions: 1 });
  const r = await run(['--category', 'repeat-ask'], f);
  assert.equal(r.code, 0);
  assert.equal(lines(f.out).length, 1);
  assert.equal(lines(f.out)[0].verdict, 'first');
  assert.match(r.out, /^dev: first version$/m);
});

test('usage errors exit 2 and --help prints the usage; eval discovers the command', async () => {
  const f = fixture();
  assert.equal((await run(['--bogus'], f)).code, 2);
  assert.equal((await run(['--category', 'nope-nope'], f)).code, 2);
  assert.equal((await run(['--category', 'Bad Id'], f)).code, 2);
  const h = await run(['--help'], f);
  assert.equal(h.code, 0);
  assert.match(h.out, /triqual eval score/);
  let out = '';
  assert.equal(await evalMain(['--help'], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
  assert.match(out, /\bscore\b/);
});

test('no sample exits 1 and writes nothing', async () => {
  const f = fixture();
  writeFileSync(join(f.evals, 'review', 'sample.jsonl'), '');
  const r = await run([], f);
  assert.equal(r.code, 1);
  assert.throws(() => statSync(f.out));
});

// ---- --against on the command

function threeVersionFixture() {
  const f = fixture();
  const hash = loadJudgePrompt(join(f.judges, 'repeat-ask.md')).hash;
  const [d1, d2] = ids.dev;
  const rows = [
    [d1, 'vA', 'fail'], [d2, 'vA', 'pass'], // A: both right
    [d1, 'vB', 'pass'], [d2, 'vB', 'pass'], // B: misses the failure
    [d1, hash, 'fail'], [d2, hash, 'pass'], // C, the current one: both right
  ].map(([sessionId, promptHash, result]) => `${JSON.stringify({ sessionId, category: 'repeat-ask', result, promptHash })}\n`).join('');
  writeFileSync(join(f.evals, 'judgments', 'repeat-ask.jsonl'), rows);
  return { ...f, hash };
}

test('--against compares with that version, where no flag compares with the most recent other one', async () => {
  const f = threeVersionFixture();
  const plain = await run(['--category', 'repeat-ask'], f);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^dev: previous 0\.500 \(1\/2\), current 1\.000 \(2\/2\): better$/m);
  const against = await run(['--category', 'repeat-ask', '--against', 'vA'], f);
  assert.equal(against.code, 0);
  assert.match(against.out, /^dev: previous 1\.000 \(2\/2\), current 1\.000 \(2\/2\): not-better$/m);
  const written = lines(f.out);
  assert.equal(written.length, 2);
  assert.equal(written[1].previous.version, 'vA');
  assert.equal(written[1].verdict, 'not-better');
});

test('--against a version that shares no dev session prints first version', async () => {
  const f = threeVersionFixture();
  const r = await run(['--category', 'repeat-ask', '--against=vNone'], f);
  assert.equal(r.code, 0);
  assert.match(r.out, /^dev: first version$/m);
  assert.equal(lines(f.out)[0].previous, null);
});

test('--against without --category is a usage error, exit 2, and the usage text names it', async () => {
  const f = threeVersionFixture();
  const r = await run(['--against', 'vA'], f);
  assert.equal(r.code, 2);
  assert.match(r.err, /--against needs --category/);
  assert.match(r.err, /triqual eval score \[--category <id>\] \[--against <version>\]/);
  assert.throws(() => statSync(f.out));
});

test('--against the current version is an error, exit 2 like the other argument errors, and nothing is written', async () => {
  const f = threeVersionFixture();
  const r = await run(['--category', 'repeat-ask', '--against', f.hash], f);
  assert.equal(r.code, 2);
  assert.match(r.err, /did not change/);
  assert.throws(() => statSync(f.out));
});

test('--help documents --against', async () => {
  const h = await run(['--help'], threeVersionFixture());
  assert.equal(h.code, 0);
  assert.match(h.out, /--against <version>/);
});
