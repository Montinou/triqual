import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askModel, appendPrivate, sampleSessions } from '../cli/lib/eval-ask.mjs';
import { acceptReference, loadReferencePrompt, proposeReference } from '../cli/lib/eval-reference.mjs';
import { keepRenders } from '../cli/lib/eval-renders.mjs';
import { readJsonl } from '../cli/lib/eval-store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evref-'));
const J = (...p) => p.join('');
const mode = (f) => statSync(f).mode & 0o777;
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'repeat-ask', name: 'Repeated request', definition: 'The owner had to say the same thing twice.', examples: ['a', 'b', 'c'], check: 'judge' },
    { id: 'big-diff', name: 'Large diff', definition: 'A change touched many files.', examples: ['a', 'b', 'c'], check: 'code' },
    { id: 'false-claim', name: 'False claim', definition: 'The assistant said something the record contradicts.', examples: ['a', 'b', 'c'], check: 'judge' },
  ],
};
const IDS = ['repeat-ask', 'false-claim'];
const validAnswer = () => ({
  label: 'bad',
  reason: 'The owner repeated an instruction.',
  categories: { 'repeat-ask': { present: true, quote: 'please do it again' }, 'false-claim': { present: false, quote: '' } },
});

const PROMPT_FILE_TEXT = '---\nmodel: claude-sonnet-5-5\n---\nLabel the session.\n';
const writePrompt = (dir, text = PROMPT_FILE_TEXT) => { mkdirSync(dir, { recursive: true }); const f = join(dir, 'reference.md'); writeFileSync(f, text); return f; };

const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

// A temp evals directory with a three-session sample, a store and the transcripts. Each session is `{ id, project, transcript }`.
function fixture({ sessions, excludeHome } = {}) {
  const dir = tmp();
  const evals = join(dir, 'evals');
  const root = join(dir, 'projects');
  mkdirSync(join(evals, 'review'), { recursive: true });
  const list = sessions ?? [
    { id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' },
    { id: 's2', project: '/home/x/beta', text: 'Please add a test.' },
    { id: 's3', project: '/home/x/gamma', text: 'Please rename the helper.' },
  ];
  const sample = []; const store = [];
  for (const s of list) {
    const projectDir = `-home-x-${s.id}`;
    sample.push({ sessionId: s.id, project: s.project, file: null, stratum: s.stratum ?? 'random' });
    if (s.missing !== true) {
      store.push({ sessionId: s.id, project: s.project, projectDir, entrypoint: 'cli' });
      mkdirSync(join(root, projectDir), { recursive: true });
      writeFileSync(join(root, projectDir, `${s.id}.jsonl`), `${turn('user', s.text)}\n${turn('assistant', 'Done.')}\n`);
    }
  }
  writeFileSync(join(evals, 'review', 'sample.jsonl'), sample.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'sessions.jsonl'), store.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const home = excludeHome ?? '/home/x';
  return { dir, evals, root, home };
}

// A spawn stub that records every call and answers with `answer(callIndex)`.
function stub(answer = () => ({ structured_output: validAnswer() })) {
  const calls = [];
  const spawn = async (bin, args, opts) => {
    calls.push({ bin, args, input: opts.input, env: opts.env, cwd: opts.cwd });
    return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, ...answer(calls.length - 1) }), stderr: '' };
  };
  return { spawn, calls };
}

const CHAIN = [{ name: 'pro', env: { EVAL_CHILD_MARK: 'pro-mark' } }];
const NOW = () => new Date('2026-11-16T12:00:00Z');
const run = (fx, over = {}) => {
  const prompt = over.prompt ?? loadReferencePrompt(writePrompt(join(fx.dir, 'prompts')), TAXONOMY);
  const sessions = over.sessions ?? sampleSessions({ evals: fx.evals, root: fx.root, taxonomy: TAXONOMY, home: fx.home, platform: 'linux' });
  return proposeReference({
    evals: fx.evals, sessions, prompt, chain: over.chain ?? CHAIN, spawn: over.spawn, env: { PATH: '/usr/bin' }, home: fx.home, cwd: fx.dir, bin: 'claude-stub', now: NOW,
  });
};

// ---- loadReferencePrompt ----

test('loadReferencePrompt appends one line per judge category and builds the schema', () => {
  const dir = tmp();
  const p = loadReferencePrompt(writePrompt(dir), TAXONOMY);
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.ok(p.body.startsWith('Label the session.'));
  assert.ok(p.body.includes('- repeat-ask (Repeated request): The owner had to say the same thing twice.'));
  assert.ok(p.body.includes('- false-claim (False claim): The assistant said something the record contradicts.'));
  assert.ok(!p.body.includes('big-diff'), 'a code category is not asked');
  assert.ok(p.body.indexOf('repeat-ask') < p.body.indexOf('false-claim'), 'taxonomy order');
  assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.schema.required, ['label', 'reason', 'categories']);
  assert.deepEqual(p.schema.properties.label.enum, ['good', 'bad']);
  assert.equal(p.schema.properties.reason.type, 'string');
  const c = p.schema.properties.categories;
  assert.equal(c.type, 'object');
  assert.deepEqual(Object.keys(c.properties), IDS);
  assert.deepEqual(c.required, IDS);
  assert.equal(c.additionalProperties, false);
  for (const id of IDS) {
    assert.equal(c.properties[id].properties.present.type, 'boolean');
    assert.equal(c.properties[id].properties.quote.type, 'string');
    assert.deepEqual(c.properties[id].required, ['present', 'quote']);
  }
});

test('the hash follows the body and the model, so a taxonomy change or another model changes it', () => {
  const dir = tmp();
  const a = loadReferencePrompt(writePrompt(dir), TAXONOMY);
  const again = loadReferencePrompt(writePrompt(dir), TAXONOMY);
  assert.equal(a.hash, again.hash);
  const other = loadReferencePrompt(writePrompt(dir), { ...TAXONOMY, categories: [{ ...TAXONOMY.categories[0], definition: 'A different definition.' }] });
  assert.notEqual(a.hash, other.hash);
  const model = loadReferencePrompt(writePrompt(dir, PROMPT_FILE_TEXT.replace('claude-sonnet-5-5', 'claude-haiku-5-5')), TAXONOMY);
  assert.notEqual(a.hash, model.hash);
});

// ---- eval-ask ----

test('askModel runs the claude args with the input on stdin and returns structured_output', async () => {
  const { spawn, calls } = stub(() => ({ structured_output: { x: 1 } }));
  const schema = { type: 'object' };
  const out = await askModel({ model: 'claude-sonnet-5-5', input: 'hello', schema, spawn, env: { A: 'b' }, cwd: '/c', bin: 'claude-stub' });
  assert.deepEqual(out, { answer: { x: 1 } });
  assert.equal(calls[0].bin, 'claude-stub');
  assert.deepEqual(calls[0].args, ['-p', '--no-session-persistence', '--model', 'claude-sonnet-5-5', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--setting-sources', 'project', '--strict-mcp-config', '--tools', '']);
  assert.equal(calls[0].input, 'hello');
  assert.deepEqual(calls[0].env, { A: 'b' });
  assert.equal(calls[0].cwd, '/c');
});

test('askModel reads the last result of an array, and maps limit, error and missing output', async () => {
  const arr = async () => ({ code: 0, stdout: JSON.stringify([{ type: 'system' }, { type: 'result', structured_output: { ok: true } }]) });
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: arr }), { answer: { ok: true } });
  const limit = stub(() => ({ is_error: true, api_error: 'usage_limit_reached', result: 'x' }));
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: limit.spawn }), { limit: true });
  const err = stub(() => ({ is_error: true, result: 'boom' }));
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: err.spawn }), { error: 'boom' });
  const none = stub(() => ({ result: 'text only' }));
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: none.spawn }), { error: 'no valid structured output' });
  const junk = async () => ({ code: 0, stdout: 'not json' });
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: junk }), { error: 'unparseable output' });
  const thrown = async () => { throw new Error('nope'); };
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: thrown }), { error: 'the model could not be started' });
  const nospawn = async () => ({ code: null, stdout: '', spawnError: 'ENOENT' });
  assert.deepEqual(await askModel({ model: 'm-1', input: 'x', schema: {}, spawn: nospawn }), { error: 'the model could not be started' });
});

test('sampleSessions lists the sample in order with the transcript file and the exclusion', () => {
  const fx = fixture({ sessions: [
    { id: 's1', project: '/home/x/alpha', text: 'a', stratum: 'random' },
    { id: 's2', project: '/home/x/secret/beta', text: 'b', stratum: 'cost' },
    { id: 's3', project: '/home/x/gamma', text: 'c', missing: true, stratum: 'outlier' },
  ] });
  const taxonomy = { ...TAXONOMY, judgeExclude: ['~/secret'] };
  const out = sampleSessions({ evals: fx.evals, root: fx.root, taxonomy, home: '/home/x', platform: 'linux' });
  assert.deepEqual(out.map((s) => s.sessionId), ['s1', 's2', 's3']);
  assert.deepEqual(out.map((s) => s.stratum), ['random', 'cost', 'outlier']);
  assert.equal(out[0].file, join(fx.root, '-home-x-s1', 's1.jsonl'));
  assert.equal(out[2].file, null);
  assert.deepEqual(out.map((s) => s.excluded), [false, true, false]);
});

test('appendPrivate appends one JSON line with mode 0600 and starts a fresh line after a torn one', () => {
  const dir = tmp();
  const f = join(dir, 'sub', 'x.jsonl');
  appendPrivate(f, { a: 1 });
  appendPrivate(f, { b: 2 });
  assert.deepEqual(lines(f).map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }]);
  assert.equal(mode(f), 0o600);
  const torn = join(dir, 'torn.jsonl');
  writeFileSync(torn, '{"a":', { mode: 0o644 });
  appendPrivate(torn, { c: 3 });
  assert.deepEqual(readJsonl(torn).rows, [{ c: 3 }]);
  assert.equal(mode(torn), 0o600);
});

// ---- proposeReference ----

test('three lines are written with the eight keys and mode 0600', async () => {
  const fx = fixture();
  const { spawn, calls } = stub();
  const prompt = loadReferencePrompt(writePrompt(join(fx.dir, 'prompts')), TAXONOMY);
  const out = await run(fx, { spawn, prompt });
  assert.equal(out.proposed, 3);
  assert.deepEqual(out.byEntry, { pro: 3 });
  assert.equal(out.errors, 0);
  assert.equal(out.left, 0);
  assert.equal(out.stop, null);
  assert.equal(calls.length, 3);
  const file = join(fx.evals, 'review', 'reference.jsonl');
  const rows = readJsonl(file).rows;
  assert.deepEqual(rows.map((r) => r.sessionId), ['s1', 's2', 's3']);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['at', 'auth', 'categories', 'label', 'model', 'promptHash', 'reason', 'sessionId']);
    assert.equal(r.label, 'bad');
    assert.equal(r.model, 'claude-sonnet-5-5');
    assert.equal(r.promptHash, prompt.hash);
    assert.equal(r.auth, 'pro');
    assert.equal(r.at, '2026-11-16T12:00:00.000Z');
    assert.deepEqual(r.categories, validAnswer().categories);
  }
  assert.equal(mode(file), 0o600);
  // The model is asked with the prompt body, the transcript marker and the rendered session; the entry's variables are in the child env.
  assert.ok(calls[0].input.startsWith(prompt.body + '\n\n--- session transcript ---\n'));
  assert.ok(calls[0].input.includes('Please fix the parser.'));
  assert.equal(calls[0].env.EVAL_CHILD_MARK, 'pro-mark');
  assert.equal(calls[0].bin, 'claude-stub');
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(calls[0].args[calls[0].args.indexOf('--json-schema') + 1], JSON.stringify(prompt.schema));
});

test('a reason is cut to 400 characters and each quote to 300', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' }] });
  const { spawn } = stub(() => ({ structured_output: {
    label: 'good', reason: 'r'.repeat(900),
    categories: { 'repeat-ask': { present: true, quote: 'q'.repeat(900) }, 'false-claim': { present: false, quote: '' } },
  } }));
  await run(fx, { spawn });
  const [row] = readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows;
  assert.equal(row.reason.length, 400);
  assert.equal(row.categories['repeat-ask'].quote.length, 300);
});

test('a second run makes no call, and neither does one with a prompt of another hash', async () => {
  const fx = fixture();
  const first = stub();
  await run(fx, { spawn: first.spawn });
  const second = stub();
  const again = await run(fx, { spawn: second.spawn });
  assert.equal(second.calls.length, 0);
  assert.equal(again.proposed, 0);
  assert.equal(again.left, 0);
  const other = loadReferencePrompt(writePrompt(join(fx.dir, 'p2'), PROMPT_FILE_TEXT.replace('Label the session.', 'Label it differently.')), TAXONOMY);
  const third = stub();
  await run(fx, { spawn: third.spawn, prompt: other });
  assert.equal(third.calls.length, 0);
  assert.equal(lines(join(fx.evals, 'review', 'reference.jsonl')).length, 3);
});

const invalid = {
  'a category is missing': () => ({ ...validAnswer(), categories: { 'repeat-ask': { present: true, quote: 'x' } } }),
  'a category is extra': () => ({ ...validAnswer(), categories: { ...validAnswer().categories, 'other-one': { present: false, quote: '' } } }),
  'present is not a boolean': () => ({ ...validAnswer(), categories: { 'repeat-ask': { present: 'yes', quote: 'x' }, 'false-claim': { present: false, quote: '' } } }),
};
for (const [name, make] of Object.entries(invalid)) {
  test(`an answer where ${name} writes no line and counts as an error`, async () => {
    const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' }] });
    const { spawn, calls } = stub(() => ({ structured_output: make() }));
    const out = await run(fx, { spawn });
    assert.equal(calls.length, 1);
    assert.equal(out.errors, 1);
    assert.equal(out.proposed, 0);
    assert.equal(out.left, 1);
    assert.equal(out.stop, null);
    assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows, []);
  });
}

test('a model error and an answer that is not an object count as errors', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'a' }, { id: 's2', project: '/home/x/beta', text: 'b' }] });
  const { spawn } = stub((i) => (i === 0 ? { is_error: true, result: 'boom' } : { result: 'no structured output' }));
  const out = await run(fx, { spawn });
  assert.equal(out.errors, 2);
  assert.equal(out.left, 2);
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows, []);
});

test('a session with no transcript file writes no line and counts as an error', async () => {
  const fx = fixture({ sessions: [
    { id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' },
    { id: 's2', project: '/home/x/beta', text: 'b', missing: true },
  ] });
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn });
  assert.equal(calls.length, 1);
  assert.equal(out.proposed, 1);
  assert.equal(out.errors, 1);
  assert.equal(out.left, 1);
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows.map((r) => r.sessionId), ['s1']);
});

test('a readable transcript with no text is skipped: no call, not an error, not left, counted in empty', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'a' }, { id: 's2', project: '/home/x/beta', text: 'Please add a test.' }] });
  writeFileSync(join(fx.root, '-home-x-s1', 's1.jsonl'), '');
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn });
  assert.equal(calls.length, 1, 'only the session with text is sent');
  assert.deepEqual([out.proposed, out.errors, out.left, out.empty], [1, 0, 0, 1]);
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows.map((r) => r.sessionId), ['s2']);
  const again = await run(fx, { spawn });
  assert.deepEqual([again.proposed, again.errors, again.left, again.empty], [0, 0, 0, 1], 'it is counted every round');
  assert.equal(existsSync(join(fx.evals, 'review', 'renders')), false, 'a proposal never writes a render');
});

test('a transcript that is gone, with no kept render, is an error, is not sent and stays left; a session not in the store is the same', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'a' }, { id: 's2', project: '/home/x/beta', text: 'b', missing: true }] });
  unlinkSync(join(fx.root, '-home-x-s1', 's1.jsonl'));
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn });
  assert.equal(calls.length, 0);
  assert.deepEqual([out.proposed, out.errors, out.left, out.empty], [0, 2, 2, 0]);
});

test('a session whose transcript was deleted but whose render is kept is proposed from the kept text', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' }] });
  keepRenders({ evals: fx.evals, sessions: sampleSessions({ evals: fx.evals, root: fx.root, taxonomy: TAXONOMY, home: fx.home, platform: 'linux' }), now: () => Date.now() + 2 * 60 * 60 * 1000 });
  unlinkSync(join(fx.root, '-home-x-s1', 's1.jsonl'));
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes('Please fix the parser.'), 'the stub receives the kept text');
  assert.deepEqual([out.proposed, out.errors, out.left, out.empty], [1, 0, 0, 0]);
});

test('a session whose project is under judgeExclude is never sent and is not in left', async () => {
  const fx = fixture({ sessions: [
    { id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' },
    { id: 's2', project: '/home/x/client/beta', text: 'CLIENT-ONLY-TEXT' },
    { id: 's3', project: '/home/x/gamma', text: 'Please rename the helper.' },
  ] });
  const taxonomy = { ...TAXONOMY, judgeExclude: ['~/client'] };
  const sessions = sampleSessions({ evals: fx.evals, root: fx.root, taxonomy, home: '/home/x', platform: 'linux' });
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn, sessions });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => !c.input.includes('CLIENT-ONLY-TEXT')));
  assert.equal(out.proposed, 2);
  assert.equal(out.errors, 0);
  assert.equal(out.left, 0);
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows.map((r) => r.sessionId), ['s1', 's3']);
});

test('a secret in a transcript is absent from the stub stdin', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: `Use this key ${J('sk-', 'ant-', 'A1b2C3d4E5f6G7h8I9j0')} for the call.` }] });
  const { spawn, calls } = stub();
  await run(fx, { spawn });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes('for the call.'));
  assert.ok(!calls[0].input.includes('A1b2C3d4E5f6G7h8I9j0'));
  assert.ok(calls[0].input.includes('[redacted]'));
});

test('a limit on a one-entry chain stops with limit, no line and left 3', async () => {
  const fx = fixture();
  const { spawn, calls } = stub(() => ({ is_error: true, api_error: 'usage_limit_reached', result: 'x' }));
  const out = await run(fx, { spawn });
  assert.equal(out.stop, 'limit');
  assert.equal(out.proposed, 0);
  assert.equal(out.left, 3);
  assert.equal(calls.length, 1, 'no further session is tried after the chain is exhausted');
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows, []);
});

test('a limit moves to the next entry, which then answers the rest', async () => {
  const fx = fixture();
  const chain = [{ name: 'pro', env: {} }, { name: 'work', env: {} }];
  const { spawn } = stub((i) => (i === 0 ? { is_error: true, api_error: 'usage_limit_reached', result: 'x' } : { structured_output: validAnswer() }));
  const out = await run(fx, { spawn, chain });
  assert.equal(out.stop, null);
  assert.deepEqual(out.byEntry, { work: 3 });
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows.map((r) => r.auth), ['work', 'work', 'work']);
});

test('an unreadable credential source stops with auth and writes nothing', async () => {
  const fx = fixture();
  const chain = [{ name: 'pro', env: { CLAUDE_CODE_OAUTH_TOKEN: { file: join(fx.dir, 'no-such-secret') } } }];
  const { spawn, calls } = stub();
  const out = await run(fx, { spawn, chain });
  assert.equal(out.stop, 'auth');
  assert.equal(calls.length, 0);
  assert.equal(out.left, 3);
});

// ---- acceptReference ----

test('acceptReference writes a label and a category line for a session that has neither, and leaves an existing line byte for byte', async () => {
  const fx = fixture();
  const { spawn } = stub((i) => ({ structured_output: i === 0 ? validAnswer() : { ...validAnswer(), label: 'good', categories: { 'repeat-ask': { present: false, quote: '' }, 'false-claim': { present: true, quote: 'q' } } } }));
  await run(fx, { spawn });
  const sessions = sampleSessions({ evals: fx.evals, root: fx.root, taxonomy: TAXONOMY, home: fx.home, platform: 'linux' });
  const catFile = join(fx.evals, 'label-categories.jsonl');
  const labelFile = join(fx.evals, 'review', 'labels.jsonl');
  const preCat = '{"sessionId":"s2","categories":[ "hand-made" ]}\n';
  writeFileSync(catFile, preCat);
  const preLabel = '{"sessionId":"s3","label":"good","note":"by hand","at":"2026-11-01T00:00:00Z"}\n';
  writeFileSync(labelFile, preLabel);

  const out = acceptReference({ evals: fx.evals, sessions, now: NOW });
  assert.deepEqual(out, { labels: 2, categories: 2 });

  const labels = readJsonl(labelFile).rows;
  assert.deepEqual(labels.map((r) => r.sessionId), ['s3', 's1', 's2']);
  const s1 = labels.find((r) => r.sessionId === 's1');
  assert.deepEqual(s1, { sessionId: 's1', label: 'bad', note: 'auto: The owner repeated an instruction.', at: '2026-11-16T12:00:00.000Z' });
  assert.ok(readFileSync(labelFile, 'utf8').startsWith(preLabel));
  const cats = readFileSync(catFile, 'utf8');
  assert.ok(cats.startsWith(preCat), 'the existing line is kept byte for byte');
  const catRows = readJsonl(catFile).rows;
  assert.deepEqual(catRows.map((r) => r.sessionId), ['s2', 's1', 's3']);
  assert.deepEqual(catRows.find((r) => r.sessionId === 's1'), { sessionId: 's1', categories: ['repeat-ask'] });
  assert.deepEqual(catRows.find((r) => r.sessionId === 's3'), { sessionId: 's3', categories: ['false-claim'] });
  assert.equal(mode(catFile), 0o600);
  assert.equal(mode(labelFile), 0o600);

  const catsText = readFileSync(catFile, 'utf8');
  const labelsText = readFileSync(labelFile, 'utf8');
  const again = acceptReference({ evals: fx.evals, sessions, now: NOW });
  assert.deepEqual(again, { labels: 0, categories: 0 });
  assert.equal(readFileSync(catFile, 'utf8'), catsText);
  assert.equal(readFileSync(labelFile, 'utf8'), labelsText);
});

test('acceptReference waits for the label-categories lock a concurrent applyRulings holds, and releases its own', async () => {
  const fx = fixture();
  const { spawn } = stub(() => ({ structured_output: validAnswer() }));
  await run(fx, { spawn });
  const sessions = sampleSessions({ evals: fx.evals, root: fx.root, taxonomy: TAXONOMY, home: fx.home, platform: 'linux' });
  const catFile = join(fx.evals, 'label-categories.jsonl');
  const lock = `${catFile}.lock`;
  writeFileSync(lock, 'holder\n'); // a fresh lock, as applyRulings holds it while it rewrites the file
  assert.throws(() => acceptReference({ evals: fx.evals, sessions, now: NOW }), /lock timeout/);
  assert.equal(readJsonl(catFile).rows.length, 0, 'nothing is appended while the lock is held');
  assert.equal(readFileSync(lock, 'utf8'), 'holder\n', 'the holder keeps its lock');
  unlinkSync(lock);
  assert.deepEqual(acceptReference({ evals: fx.evals, sessions, now: NOW }), { labels: 3, categories: 3 });
  assert.equal(existsSync(lock), false, 'the lock is released');
});

test('acceptReference skips a session with no reference line', () => {
  const fx = fixture();
  const sessions = sampleSessions({ evals: fx.evals, root: fx.root, taxonomy: TAXONOMY, home: fx.home, platform: 'linux' });
  assert.deepEqual(acceptReference({ evals: fx.evals, sessions, now: NOW }), { labels: 0, categories: 0 });
});

test('a missing structured output is one error for the session, nothing is written', async () => {
  const fx = fixture();
  const none = stub(() => ({ result: 'text only' }));
  const r = await run(fx, { spawn: none.spawn });
  assert.equal(r.proposed, 0);
  assert.equal(r.errors, 3);
  assert.equal(r.left, 3);
  assert.deepEqual(readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows, []);
});

test('two overlapping runs over one evals directory leave one line per session and neither is busy', async () => {
  const fx = fixture();
  let calls = 0;
  const spawn = async () => {
    calls += 1;
    await new Promise((res) => setTimeout(res, 5));
    return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: validAnswer() }), stderr: '' };
  };
  const [a, b] = await Promise.all([run(fx, { spawn }), run(fx, { spawn })]);
  assert.notEqual(a.stop, 'busy');
  assert.notEqual(b.stop, 'busy');
  assert.ok(calls >= 3, 'a session may be sent twice');
  assert.equal(a.proposed + b.proposed, 3, 'a line counts for the run that wrote it');
  const rows = readJsonl(join(fx.evals, 'review', 'reference.jsonl')).rows;
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['s1', 's2', 's3']);
  assert.equal(a.left, 0);
  assert.equal(b.left, 0);
});

test('a row is not appended twice when another writer added it after the done set was read', async () => {
  const fx = fixture({ sessions: [{ id: 's1', project: '/home/x/alpha', text: 'Please fix the parser.' }] });
  const file = join(fx.evals, 'review', 'reference.jsonl');
  const spawn = async () => {
    writeFileSync(file, `${JSON.stringify({ sessionId: 's1', label: 'good', reason: 'x', categories: {}, promptHash: 'other' })}\n`);
    return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: validAnswer() }), stderr: '' };
  };
  const r = await run(fx, { spawn });
  assert.equal(r.proposed, 0);
  assert.equal(lines(file).length, 1);
  assert.equal(r.left, 0);
});
