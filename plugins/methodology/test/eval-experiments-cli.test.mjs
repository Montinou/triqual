import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-experiments.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { snapshot, usableSet } from '../cli/lib/eval-snapshot.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';

const NOW = new Date('2026-11-17T23:30:00Z');
const PROMPT = (body = 'Judge only this invented failure.') => `---\nmodel: claude-haiku-5-5\n---\n${body}\n`;
const CHECKS = '// invented checks file\nexport const CHECKS = {};\n';

const cat = (id, check) => ({ id, name: id, definition: `definition of ${id}`, examples: ['x1', 'x2', 'x3'], check });
const exp = (over = {}) => ({
  id: 'e1', kind: 'session', status: 'paused', control: 'a',
  arms: { a: { model: 'm1' }, b: { model: 'm2' } }, margin: 0.1, objective: 'cost', ...over,
});

// A temp home with a taxonomy (one code and one judge category), the judge prompt, a checks file and an experiments file.
function fixture({ validation, experiments = [exp()], taxonomy, promptBody } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cm-t16-'));
  const evals = join(base, 'evals');
  const judgesDir = join(base, 'judges');
  mkdirSync(evals, { recursive: true });
  mkdirSync(judgesDir);
  const judgeFile = join(judgesDir, 'stopped-early.md');
  writeFileSync(judgeFile, PROMPT(promptBody));
  const checksFile = join(base, 'eval-checks.mjs');
  writeFileSync(checksFile, CHECKS);
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(taxonomy ?? {
    judgeExclude: ['/home/x/Client'],
    categories: [cat('owner-chased-progress', 'code'), cat('stopped-early', 'judge')],
  }));
  writeFileSync(join(evals, 'label-categories.jsonl'), ['x1', 'x2', 'x3'].map((sessionId) => JSON.stringify({ sessionId, categories: [] })).join('\n'));
  const entry = (over) => ({ tp: 15, fn: 1, tn: 15, fp: 1, positives: 16, negatives: 16, undecided: 0, tpr: 0.9, tnr: 0.9, usable: true, reason: null, promptHash: loadJudgePrompt(judgeFile).hash, model: 'claude-haiku-5-5', at: '2026-11-16T10:00:00Z', ...over });
  if (validation !== null) writeFileSync(join(evals, 'validation.json'), JSON.stringify(validation ?? { 'stopped-early': entry() }));
  const file = join(base, 'config', 'experiments.json');
  mkdirSync(join(base, 'config'));
  writeFileSync(file, JSON.stringify({ experiments }, null, 2));
  return {
    base, evals, judgesDir, judgeFile, checksFile, file, entry,
    env: { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals, TRIQUAL_EXPERIMENTS_FILE: file },
  };
}

async function run(f, argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: f.env, now: () => NOW, judgesDir: f.judgesDir, checksFile: f.checksFile,
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}
const saved = (f) => JSON.parse(readFileSync(f.file, 'utf8')).experiments;
const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });
const mode = (p) => statSync(p).mode & 0o777;

test('start with no usable evaluator is refused', async () => {
  const f = fixture({
    validation: null,
    taxonomy: { categories: [cat('stopped-early', 'judge')] },
  });
  try {
    const before = readFileSync(f.file, 'utf8');
    const r = await run(f, ['start', 'e1']);
    assert.equal(r.code, 2);
    assert.match(r.err, /no usable evaluator/);
    assert.match(r.err, /stopped-early/);
    assert.equal(readFileSync(f.file, 'utf8'), before, 'the file is untouched');
    assert.equal(existsSync(join(f.evals, 'snapshots')), false);
  } finally { cleanup(f); }
});

test('start writes the snapshot and the hash', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['start', 'e1']);
    assert.equal(r.code, 0, r.err);
    const [e] = saved(f);
    assert.equal(e.status, 'active');
    assert.equal(e.start, '2026-11-17');
    assert.match(e.evaluators, /^[0-9a-f]{64}$/);
    assert.ok(r.out.includes(e.evaluators));
    const dir = join(f.evals, 'snapshots', e.evaluators);
    assert.deepEqual(readdirSync(dir).sort(), ['eval-checks.mjs', 'judges', 'taxonomy.json', 'validation.json']);
    assert.equal(readFileSync(join(dir, 'eval-checks.mjs'), 'utf8'), CHECKS);
    assert.equal(readFileSync(join(dir, 'judges', 'stopped-early.md'), 'utf8'), readFileSync(f.judgeFile, 'utf8'));
    const tax = JSON.parse(readFileSync(join(dir, 'taxonomy.json'), 'utf8'));
    assert.deepEqual(tax.categories.map((c) => c.id), ['owner-chased-progress', 'stopped-early']);
    assert.deepEqual(tax.judgeExclude, ['/home/x/Client']);
    assert.deepEqual(tax.excluded, []);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8'))), ['stopped-early']);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'taxonomy.json')), 0o600);
    assert.equal(mode(join(dir, 'judges', 'stopped-early.md')), 0o600);
    assert.equal(mode(f.file), 0o600);
    assert.equal(readdirSync(join(f.base, 'config')).filter((n) => n.endsWith('.tmp')).length, 0);
  } finally { cleanup(f); }
});

test('same evaluators give the same hash', async () => {
  const a = fixture();
  const b = fixture();
  const c = fixture({ promptBody: 'A different invented prompt.' });
  try {
    const hashOf = async (f) => { assert.equal((await run(f, ['start', 'e1'])).code, 0); return saved(f)[0].evaluators; };
    const ha = await hashOf(a);
    assert.equal(await hashOf(b), ha);
    assert.notEqual(await hashOf(c), ha, 'a changed prompt is another snapshot');

    const set = usableSet({ taxonomy: JSON.parse(readFileSync(join(a.evals, 'taxonomy.json'), 'utf8')), validation: JSON.parse(readFileSync(join(a.evals, 'validation.json'), 'utf8')), judgesDir: a.judgesDir });
    const again = snapshot(set, { evalsDir: a.evals, checksFile: a.checksFile, judgesDir: a.judgesDir });
    assert.equal(again, ha, 'snapshotting again finds the same directory');
    writeFileSync(a.checksFile, `${CHECKS}// edited\n`);
    assert.notEqual(snapshot(set, { evalsDir: a.evals, checksFile: a.checksFile, judgesDir: a.judgesDir }), ha, 'a changed checks file is another snapshot');
  } finally { cleanup(a); cleanup(b); cleanup(c); }
});

test('a judge validated on an older prompt hash is excluded', async () => {
  const f = fixture();
  try {
    const taxonomy = { categories: [cat('owner-chased-progress', 'code'), cat('stopped-early', 'judge')], judgeExclude: [] };
    const current = JSON.parse(readFileSync(join(f.evals, 'validation.json'), 'utf8'));
    const ok = usableSet({ taxonomy, validation: current, judgesDir: f.judgesDir });
    assert.deepEqual(ok.categories.map((c) => c.id), ['owner-chased-progress', 'stopped-early']);
    assert.deepEqual(ok.excluded, []);

    const stale = { 'stopped-early': { ...current['stopped-early'], promptHash: 'a'.repeat(64) } };
    const old = usableSet({ taxonomy, validation: stale, judgesDir: f.judgesDir });
    assert.deepEqual(old.categories.map((c) => c.id), ['owner-chased-progress']);
    assert.deepEqual(old.excluded, ['stopped-early']);

    const unusable = { 'stopped-early': { ...current['stopped-early'], usable: false } };
    assert.deepEqual(usableSet({ taxonomy, validation: unusable, judgesDir: f.judgesDir }).excluded, ['stopped-early']);
    assert.deepEqual(usableSet({ taxonomy, validation: {}, judgesDir: f.judgesDir }).excluded, ['stopped-early']);

    writeFileSync(join(f.evals, 'validation.json'), JSON.stringify(stale));
    assert.equal((await run(f, ['start', 'e1'])).code, 0);
    const dir = join(f.evals, 'snapshots', saved(f)[0].evaluators);
    const snap = JSON.parse(readFileSync(join(dir, 'taxonomy.json'), 'utf8'));
    assert.deepEqual(snap.categories.map((c) => c.id), ['owner-chased-progress']);
    assert.deepEqual(snap.excluded, ['stopped-early']);
    assert.equal(existsSync(join(dir, 'judges', 'stopped-early.md')), false);
  } finally { cleanup(f); }
});

test('start refuses a second active session experiment', async () => {
  const f = fixture({
    experiments: [exp({ id: 'e1', status: 'active', evaluators: 'h0' }), exp({ id: 'e2' })],
  });
  try {
    const before = readFileSync(f.file, 'utf8');
    const r = await run(f, ['start', 'e2']);
    assert.equal(r.code, 2);
    assert.match(r.err, /experiments\.1\.status/);
    assert.match(r.err, /already active/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
    assert.equal(existsSync(join(f.evals, 'snapshots')), false, 'no snapshot is made for a refused start');
  } finally { cleanup(f); }
});

test('list exits 2 on an invalid file, naming the field', async () => {
  const f = fixture({ experiments: [exp(), exp({ id: 'e2', kind: 'nope' })] });
  try {
    const r = await run(f, []);
    assert.equal(r.code, 2);
    assert.match(r.err, /experiments\.1\.kind/);
    writeFileSync(f.file, JSON.stringify({ experiments: 'nope' }));
    const shape = await run(f, []);
    assert.equal(shape.code, 2);
    assert.match(shape.err, /experiments/);
    writeFileSync(f.file, '{ not json');
    assert.equal((await run(f, [])).code, 2);
  } finally { cleanup(f); }
});

test('list prints each experiment, and nothing for a missing file', async () => {
  const f = fixture({ experiments: [exp(), exp({ id: 'e2', kind: 'skill', arms: { a: { skill: 's' }, b: { skill: 't' } } })] });
  try {
    const r = await run(f, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /e1\s+session\s+paused/);
    assert.match(r.out, /e2\s+skill\s+paused/);
    rmSync(f.file);
    const none = await run(f, []);
    assert.equal(none.code, 0);
    assert.match(none.out, /no experiments/);
  } finally { cleanup(f); }
});

test('start of a role or skill experiment records the objective evaluators and needs no snapshot', async () => {
  const f = fixture({
    validation: null,
    taxonomy: { categories: [] },
    experiments: [exp({ id: 'r1', kind: 'role', arms: { a: { role: 'planner', model: 'opus', effort: 'low' }, b: { role: 'planner', model: 'sonnet', effort: 'low' } } })],
  });
  try {
    const r = await run(f, ['start', 'r1']);
    assert.equal(r.code, 0, r.err);
    const [e] = saved(f);
    assert.equal(e.status, 'active');
    assert.equal(e.evaluators, 'objective');
    assert.equal(e.start, '2026-11-17');
    assert.equal(existsSync(join(f.evals, 'snapshots')), false);
  } finally { cleanup(f); }
});

test('start of an unknown or active experiment is refused; stop marks it done', async () => {
  const f = fixture({ experiments: [exp({ id: 'e1', status: 'active', evaluators: 'h0' })] });
  try {
    const unknown = await run(f, ['start', 'zz']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /no experiment/);
    const again = await run(f, ['start', 'e1']);
    assert.equal(again.code, 2);
    assert.match(again.err, /already active/);
    assert.equal((await run(f, ['stop', 'zz'])).code, 2);
    const stopped = await run(f, ['stop', 'e1']);
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(saved(f)[0].status, 'done');
    assert.equal(saved(f)[0].evaluators, 'h0', 'the evaluators stay for the report');
    assert.equal(mode(f.file), 0o600);
    assert.equal((await run(f, ['start'])).code, 2);
    assert.equal((await run(f, ['bogus'])).code, 2);
  } finally { cleanup(f); }
});

test('triqual eval dispatches to experiments', async () => {
  const f = fixture();
  try {
    let out = '';
    const code = await evalMain(['experiments'], { env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    assert.equal(code, 0);
    assert.match(out, /e1/);
  } finally { cleanup(f); }
});

test('start refuses a validation.json that is not JSON, and writes no snapshot', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.evals, 'validation.json'), '{ not json');
    const before = readFileSync(f.file, 'utf8');
    const r = await run(f, ['start', 'e1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /validation\.json: not JSON/);
    assert.equal(readFileSync(f.file, 'utf8'), before, 'the file is untouched');
    assert.equal(existsSync(join(f.evals, 'snapshots')), false);
  } finally { cleanup(f); }
});

test('start refuses a validation.json that cannot be read, and writes no snapshot', async () => {
  const f = fixture({ validation: null });
  try {
    mkdirSync(join(f.evals, 'validation.json'));
    const r = await run(f, ['start', 'e1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /validation\.json: EISDIR/);
    assert.equal(existsSync(join(f.evals, 'snapshots')), false);
  } finally { cleanup(f); }
});

test('snapshot throws on a corrupt validation.json instead of copying no entries', () => {
  const f = fixture();
  try {
    const taxonomy = { categories: [cat('owner-chased-progress', 'code'), cat('stopped-early', 'judge')], judgeExclude: [] };
    const set = usableSet({ taxonomy, validation: { 'stopped-early': f.entry() }, judgesDir: f.judgesDir });
    writeFileSync(join(f.evals, 'validation.json'), '{ not json');
    assert.throws(() => snapshot(set, { evalsDir: f.evals, checksFile: f.checksFile, judgesDir: f.judgesDir }), /validation\.json: not JSON/);
    assert.equal(existsSync(join(f.evals, 'snapshots')), false);
  } finally { cleanup(f); }
});
