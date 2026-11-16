import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../cli/eval-validate.mjs';
import { main as reviewMain } from '../cli/eval-review.mjs';
import { FewShotLeak, splitOf, validateCategory } from '../cli/lib/eval-validate.mjs';

const CAT = 'stalls';
const HASH = 'a'.repeat(64);
const MODEL = 'claude-opus-5-5';

// Session ids of a split: the first `n` ids `${prefix}${i}` whose random-stratum split is `split`.
function ids(split, n, prefix = 's') {
  const out = [];
  for (let i = 0; out.length < n; i += 1) if (splitOf(`${prefix}${i}`, 'random') === split) out.push(`${prefix}${i}`);
  return out;
}

// A validation fixture: `pos` and `neg` are [agree, disagree] counts of judged sessions of the split.
function build({ split = 'test', pos = [15, 0], neg = [15, 0], undecided = 0, prefix = 's', hash = HASH } = {}) {
  const pool = ids(split, pos[0] + pos[1] + neg[0] + neg[1] + undecided, prefix);
  const sample = []; const labels = []; const judgments = []; const labelCategories = new Map();
  let at = 0;
  const add = (positive, judged) => {
    const id = pool[at]; at += 1;
    sample.push({ sessionId: id, stratum: 'random' });
    labels.push({ sessionId: id, label: positive ? 'bad' : 'good' });
    if (positive) labelCategories.set(id, [CAT]);
    if (judged !== null) judgments.push({ sessionId: id, category: CAT, result: judged, promptHash: hash, model: MODEL, at: '2026-11-16T10:00:00Z' });
  };
  for (let i = 0; i < pos[0]; i += 1) add(true, 'fail');
  for (let i = 0; i < pos[1]; i += 1) add(true, 'pass');
  for (let i = 0; i < neg[0]; i += 1) add(false, 'pass');
  for (let i = 0; i < neg[1]; i += 1) add(false, 'fail');
  for (let i = 0; i < undecided; i += 1) add(i % 2 === 0, i % 4 === 0 ? 'undecided' : null);
  return { category: CAT, labels, sample, labelCategories, judgments, promptHash: HASH };
}

// ---- splitOf ----

test('split never puts a stratified session in dev or test', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(splitOf(`s${i}`, 'cost'), 'train');
    assert.equal(splitOf(`s${i}`, 'outlier'), 'train');
  }
});

test('split sends the random stratum to dev or test by the parity of the first byte of SHA-256', async () => {
  const { createHash } = await import('node:crypto');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const first = createHash('sha256').update(`s${i}`).digest()[0];
    const want = first % 2 === 0 ? 'dev' : 'test';
    assert.equal(splitOf(`s${i}`, 'random'), want);
    seen.add(want);
  }
  assert.deepEqual([...seen].sort(), ['dev', 'test']);
});

// ---- validateCategory ----

test('a judge with 14 test positives is unusable', () => {
  const r = validateCategory(build({ pos: [14, 0], neg: [15, 0] }));
  assert.equal(r.positives, 14);
  assert.equal(r.negatives, 15);
  assert.equal(r.usable, false);
  assert.match(r.reason, /positives/);
});

test('15+15 perfect agreement is usable', () => {
  const r = validateCategory(build({ pos: [15, 0], neg: [15, 0] }));
  assert.deepEqual([r.tp, r.fn, r.tn, r.fp], [15, 0, 15, 0]);
  assert.equal(r.tpr, 1);
  assert.equal(r.tnr, 1);
  assert.ok(r.tprCI[0] >= 0.7 && r.tnrCI[0] >= 0.7);
  assert.equal(r.usable, true);
  assert.equal(r.reason, null);
});

test('a lower bound under 0.7 makes the judge unusable even with enough sessions', () => {
  const r = validateCategory(build({ pos: [15, 10], neg: [25, 0] }));
  assert.equal(r.positives, 25);
  assert.ok(r.tprCI[0] < 0.7);
  assert.equal(r.usable, false);
  assert.match(r.reason, /TPR/);
});

test('a prompt hash other than the one asked is ignored, a missing judgment is undecided', () => {
  const f = build({ pos: [15, 0], neg: [15, 0] });
  f.judgments = f.judgments.map((j) => ({ ...j, promptHash: 'b'.repeat(64) }));
  const r = validateCategory(f);
  assert.equal(r.undecided, 30);
  assert.equal(r.positives, 0);
  assert.equal(r.negatives, 0);
  assert.equal(r.usable, false);
});

test('undecided judgments are counted apart and leave the rates alone', () => {
  const r = validateCategory(build({ pos: [15, 0], neg: [15, 0], undecided: 4 }));
  assert.equal(r.undecided, 4);
  assert.equal(r.positives, 15);
  assert.equal(r.negatives, 15);
});

test('only the requested split is counted', () => {
  const test = build({ split: 'test', pos: [15, 0], neg: [15, 0] });
  const dev = build({ split: 'dev', pos: [0, 15], neg: [0, 15], prefix: 'd' });
  const merged = { ...test, sample: [...test.sample, ...dev.sample], labels: [...test.labels, ...dev.labels], judgments: [...test.judgments, ...dev.judgments], labelCategories: new Map([...test.labelCategories, ...dev.labelCategories]) };
  assert.deepEqual(validateCategory(merged), validateCategory(test));
  const asDev = validateCategory({ ...merged, split: 'dev' });
  assert.deepEqual([asDev.tp, asDev.fn, asDev.tn, asDev.fp], [0, 15, 0, 15]);
});

test('a stratified or unlabeled session is never counted', () => {
  const f = build({ pos: [15, 0], neg: [15, 0] });
  const extra = ids('test', 2, 'x');
  f.sample.push({ sessionId: extra[0], stratum: 'cost' }, { sessionId: extra[1], stratum: 'random' });
  f.labels.push({ sessionId: extra[0], label: 'bad' }); // extra[1] has no label
  f.labelCategories.set(extra[0], [CAT]);
  f.judgments.push(
    { sessionId: extra[0], category: CAT, result: 'pass', promptHash: HASH },
    { sessionId: extra[1], category: CAT, result: 'pass', promptHash: HASH },
  );
  assert.deepEqual(validateCategory(f), validateCategory(build({ pos: [15, 0], neg: [15, 0] })));
});

test('a prompt citing a test session id is refused', () => {
  const f = build({ pos: [15, 0], neg: [15, 0] });
  const cited = f.sample[3].sessionId;
  assert.throws(() => validateCategory({ ...f, promptBody: `Example: session ${cited} stalls.` }), (err) => err instanceof FewShotLeak && err.message.includes(cited));
  const dev = build({ split: 'dev', pos: [1, 0], neg: [1, 0], prefix: 'd' });
  assert.throws(() => validateCategory({ ...f, sample: [...f.sample, ...dev.sample], promptBody: `see ${dev.sample[0].sessionId}` }), FewShotLeak);
  // a stratified (train) session named in the prompt is fine
  assert.doesNotThrow(() => validateCategory({ ...f, sample: [...f.sample, { sessionId: 'tr-1', stratum: 'cost' }], promptBody: 'see tr-1' }));
});

// ---- the CLI ----

function cliFixture(opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cm-evval-'));
  const evals = join(base, 'evals');
  const judges = join(base, 'judges');
  mkdirSync(join(evals, 'review'), { recursive: true });
  mkdirSync(join(evals, 'judgments'), { recursive: true });
  mkdirSync(judges, { recursive: true });
  const body = opts.body ?? 'Decide whether the session shows the failure.\n';
  const promptText = `---\nmodel: ${MODEL}\n---\n${body}`;
  writeFileSync(join(judges, `${CAT}.md`), promptText);
  return { base, evals, judges, promptText, env: { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals } };
}

// Writes the sample, labels, label-categories and judgments of `fixture` (see build) into the evals dir; the judgments
// carry the prompt hash of the prompt file.
async function load(f, parts, hash) {
  const { createHash } = await import('node:crypto');
  const h = hash ?? createHash('sha256').update(f.promptText).digest('hex');
  const w = (file, rows) => writeFileSync(join(f.evals, file), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const sample = parts.flatMap((p) => p.sample);
  w('review/sample.jsonl', sample);
  w('review/labels.jsonl', parts.flatMap((p) => p.labels));
  w('label-categories.jsonl', parts.flatMap((p) => [...p.labelCategories].map(([sessionId, categories]) => ({ sessionId, categories }))));
  w(`judgments/${CAT}.jsonl`, parts.flatMap((p) => p.judgments.map((j) => ({ ...j, promptHash: h }))));
  return h;
}

async function run(f, argv, deps = {}) {
  let out = ''; let err = '';
  const code = await main(argv, { env: f.env, judgesDir: f.judges, now: () => new Date('2026-11-16T12:00:00Z'), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...deps });
  return { code, out, err };
}

test('validate writes validation.json from the test split only; dev judgments change nothing', async () => {
  const f = cliFixture();
  try {
    const test = build({ split: 'test', pos: [15, 0], neg: [15, 0] });
    const dev = build({ split: 'dev', pos: [0, 15], neg: [0, 15], prefix: 'd' });
    const hash = await load(f, [test, dev]);
    const r = await run(f, ['--category', CAT]);
    assert.equal(r.code, 0, r.err);
    const file = join(f.evals, 'validation.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc), [CAT]);
    const row = doc[CAT];
    assert.deepEqual([row.tp, row.fn, row.tn, row.fp], [15, 0, 15, 0]);
    assert.equal(row.usable, true);
    assert.equal(row.promptHash, hash);
    assert.equal(row.model, MODEL);
    assert.equal(row.at, '2026-11-16T12:00:00.000Z');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // dev judgments added or changed: the file stays the same
    const before = readFileSync(file, 'utf8');
    const dev2 = build({ split: 'dev', pos: [15, 0], neg: [15, 0], prefix: 'd' });
    await load(f, [test, dev2]);
    assert.equal((await run(f, ['--category', CAT, '--split', 'test'])).code, 0);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('validate keeps the other categories of validation.json', async () => {
  const f = cliFixture();
  try {
    await load(f, [build({ pos: [15, 0], neg: [15, 0] })]);
    writeFileSync(join(f.evals, 'validation.json'), JSON.stringify({ other: { usable: true } }));
    assert.equal((await run(f, ['--category', CAT])).code, 0);
    const doc = JSON.parse(readFileSync(join(f.evals, 'validation.json'), 'utf8'));
    assert.deepEqual(Object.keys(doc).sort(), ['other', CAT]);
    assert.deepEqual(doc.other, { usable: true });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('validate --split dev prints and writes nothing', async () => {
  const f = cliFixture();
  try {
    await load(f, [build({ split: 'dev', pos: [15, 0], neg: [15, 0] })]);
    const r = await run(f, ['--category', CAT, '--split', 'dev']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /tp 15/);
    assert.ok(!existsSync(join(f.evals, 'validation.json')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('an unusable judge for lack of positives prints the sample-more line', async () => {
  const f = cliFixture();
  try {
    await load(f, [build({ pos: [5, 0], neg: [15, 0] })]);
    const r = await run(f, ['--category', CAT]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /usable: no/);
    assert.match(r.out, /^sample \d+ more: triqual eval review sample --more \d+$/m);
    const k = Number(/^sample (\d+) more/m.exec(r.out)[1]);
    assert.ok(k >= 10, `k=${k}`);
    assert.equal(JSON.parse(readFileSync(join(f.evals, 'validation.json'), 'utf8'))[CAT].usable, false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a usable judge prints no sample-more line', async () => {
  const f = cliFixture();
  try {
    await load(f, [build({ pos: [15, 0], neg: [15, 0] })]);
    const r = await run(f, ['--category', CAT]);
    assert.match(r.out, /usable: yes/);
    assert.doesNotMatch(r.out, /more:/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a prompt that cites a dev or test session id is refused and nothing is written', async () => {
  const probe = build({ pos: [15, 0], neg: [15, 0] });
  const f = cliFixture({ body: `Example: ${probe.sample[0].sessionId} is a stall.\n` });
  try {
    await load(f, [probe]);
    const r = await run(f, ['--category', CAT]);
    assert.equal(r.code, 1);
    assert.match(r.err, /names/);
    assert.ok(r.err.includes(probe.sample[0].sessionId));
    assert.ok(!existsSync(join(f.evals, 'validation.json')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('usage errors exit 2 and a missing prompt exits 1', async () => {
  const f = cliFixture();
  try {
    await load(f, [build()]);
    assert.equal((await run(f, [])).code, 2);
    assert.equal((await run(f, ['--category', 'Bad Id'])).code, 2);
    assert.equal((await run(f, ['--category', CAT, '--split', 'train'])).code, 2);
    assert.equal((await run(f, ['--category', CAT, '--bogus'])).code, 2);
    assert.equal((await run(f, ['--category', 'nojudge'])).code, 1);
    const h = await run(f, ['--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /usage:/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

// ---- review sample --more ----

const turn = (id, at, output) => JSON.stringify({
  type: 'assistant', requestId: `r-${id}`, timestamp: at,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
const opening = (at) => JSON.stringify({ type: 'user', cwd: '/work/proj', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: 'x' } });

function reviewFixture(count) {
  const base = mkdtempSync(join(tmpdir(), 'cm-evmore-'));
  const root = join(base, 'projects');
  mkdirSync(join(root, '-work-proj'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    const file = join(root, '-work-proj', `${id}.jsonl`);
    writeFileSync(file, `${[opening('2026-11-01T10:00:00Z'), turn(`m${id}`, '2026-11-01T10:01:00Z', 1000 * (i + 1))].join('\n')}\n`);
    utimesSync(file, new Date('2026-11-01T11:00:00Z'), new Date('2026-11-01T11:00:00Z')); // long quiet, whatever the clock of the run

  }
  return { base, evals: join(base, 'evals'), env: { HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: join(base, 'evals') } };
}
async function review(f, argv) {
  let out = ''; let err = '';
  const code = await reviewMain(argv, { env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}
const rowsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('review sample --more 20 appends 20 random rows', async () => {
  const f = reviewFixture(80);
  try {
    assert.equal((await review(f, ['sample', '--n', '40', '--seed', '3'])).code, 0);
    const file = join(f.evals, 'review', 'sample.jsonl');
    const before = rowsOf(file);
    assert.equal(before.length, 40);
    const r = await review(f, ['sample', '--more', '20', '--seed', '9']);
    assert.equal(r.code, 0, r.err);
    const after = rowsOf(file);
    assert.equal(after.length, 60);
    assert.deepEqual(after.slice(0, 40), before, 'the existing rows are kept, in order');
    const added = after.slice(40);
    assert.ok(added.every((x) => x.stratum === 'random'));
    assert.equal(new Set(after.map((x) => x.sessionId)).size, 60, 'no session is sampled twice');
    assert.match(r.out, /20/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // the same seed and sample draw the same rows
    const again = await review(f, ['sample', '--more', '5', '--seed', '9']);
    assert.equal(again.code, 0, again.err);
    assert.equal(rowsOf(file).length, 65);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('review sample --more needs a sample, a positive integer, and refuses --n and --force', async () => {
  const f = reviewFixture(10);
  try {
    const none = await review(f, ['sample', '--more', '5']);
    assert.equal(none.code, 1);
    assert.match(none.err, /no sample/);
    assert.equal((await review(f, ['sample', '--n', '5', '--seed', '1'])).code, 0);
    for (const bad of [['--more', '0'], ['--more', 'x'], ['--more', '5', '--n', '3'], ['--more', '5', '--force']]) {
      assert.equal((await review(f, ['sample', ...bad])).code, 2, bad.join(' '));
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
