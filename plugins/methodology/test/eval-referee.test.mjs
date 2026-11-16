import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-referee.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { LIMIT_NOTE, PAID_NOTE } from '../cli/lib/eval-auth.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';
import { applyRulings, disagreements } from '../cli/lib/eval-referee.mjs';
import { keepRenders } from '../cli/lib/eval-renders.mjs';
import { loadRulings } from '../cli/lib/eval-taxonomy.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-referee-'));
const mode = (f) => statSync(f).mode & 0o777;
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');
const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });
// A fixture secret built from parts so this file holds no literal the content gate reads as a secret.
const SECRET = ['sk-', 'ant-', 'Q1w2E3r4T5y6U7i8O9p0'].join('');

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'repeat-ask', name: 'Repeated request', definition: 'The owner had to say the same thing twice.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
    { id: 'false-claim', name: 'False claim', definition: 'The assistant said something the record contradicts.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
    { id: 'big-diff', name: 'Big diff', definition: 'The change was larger than the ask.', examples: ['e1', 'e2', 'e3'], check: 'code' },
  ],
};
const S1_CATS = { sessionId: 's1', categories: ['repeat-ask', 'false-claim'] };
const S2_CATS = { sessionId: 's2', categories: ['false-claim'] };

// Sample of two sessions s1 (the judge says pass, the label says present: a disagreement) and s2 (judge pass, label
// absent: an agreement); a judge prompt for repeat-ask only; a reference line for s1.
function fixture({ reference = true, s1Text = 'Please fix the parser.' } = {}) {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  const judges = join(base, 'judges');
  mkdirSync(join(evals, 'review'), { recursive: true });
  mkdirSync(join(evals, 'judgments'), { recursive: true });
  mkdirSync(judges, { recursive: true });
  const rows = []; const store = [];
  for (const id of ['s1', 's2']) {
    const projectDir = `-home-x-${id}`;
    rows.push({ sessionId: id, project: `/home/x/${id}`, stratum: 'random' });
    store.push({ sessionId: id, project: `/home/x/${id}`, projectDir, entrypoint: 'cli' });
    mkdirSync(join(root, projectDir), { recursive: true });
    writeFileSync(join(root, projectDir, `${id}.jsonl`), `${turn('user', id === 's1' ? s1Text : 'Please fix the parser.')}\n${turn('assistant', 'Done.')}\n`);
  }
  writeFileSync(join(evals, 'review', 'sample.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'sessions.jsonl'), store.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  const catLines = [...['e1', 'e2', 'e3'].map((id) => ({ sessionId: id, categories: [] })), S1_CATS, S2_CATS];
  writeFileSync(join(evals, 'label-categories.jsonl'), catLines.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const judgeFile = join(judges, 'repeat-ask.md');
  writeFileSync(judgeFile, '---\nmodel: claude-haiku-5-5\n---\nJudge the failure.\n');
  const version = loadJudgePrompt(judgeFile).hash;
  const judgments = ['s1', 's2'].map((id) => ({ sessionId: id, category: 'repeat-ask', result: 'pass', promptHash: version, model: 'claude-haiku-5-5', at: '2026-11-15T00:00:00.000Z' }));
  writeFileSync(join(evals, 'judgments', 'repeat-ask.jsonl'), judgments.map((r) => `${JSON.stringify(r)}\n`).join(''));
  if (reference) {
    writeFileSync(join(evals, 'review', 'reference.jsonl'), `${JSON.stringify({ sessionId: 's1', label: 'bad', reason: 'x', categories: { 'repeat-ask': { present: true, quote: 'QUOTE-MARKER-1' } } })}\n`);
  }
  const refPrompt = join(base, 'referee.md');
  writeFileSync(refPrompt, '---\nmodel: claude-sonnet-5-5\n---\nA judge and a label disagree.\n');
  const authFile = join(base, 'eval-auth.json');
  writeFileSync(authFile, JSON.stringify({ chain: [{ name: 'pro', env: { CLAUDE_CODE_OAUTH_TOKEN: 'pro-tok' } }, { name: 'api', env: { ANTHROPIC_API_KEY: 'api-tok' }, paid: true }] }));
  const env = { HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: evals, TRIQUAL_EVAL_AUTH_FILE: authFile, TRIQUAL_CLAUDE_BIN: 'claude-stub' };
  return { base, evals, env, refPrompt, judges, authFile, version };
}

const answer = (over = {}) => ({ present: false, quote: '', why: 'Only part of the definition shows.', misleading: 'A polite retry can look like a repeat.', ...over });

function stub(reply = () => ({ structured_output: answer() })) {
  const calls = [];
  const spawn = async (bin, args, opts) => {
    calls.push({ bin, args, input: opts.input, env: opts.env, cwd: opts.cwd });
    return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, ...reply(calls.length - 1) }), stderr: '' };
  };
  return { spawn, calls };
}

async function run(f, argv, over = {}) {
  let out = ''; let err = '';
  const code = await main(argv, {
    env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    now: () => new Date('2026-11-16T12:00:00Z'), refereePrompt: f.refPrompt, judgesDir: f.judges, platform: 'linux', ...over,
  });
  return { code, out, err };
}
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

test('loadRulings: the first line of a key wins and a missing file is an empty map', () => {
  const base = tmp();
  try {
    assert.equal(loadRulings(join(base, 'none.jsonl')).size, 0);
    const file = join(base, 'rulings.jsonl');
    writeFileSync(file, [
      { sessionId: 'a', category: 'c', present: true, source: 'owner' },
      { sessionId: 'a', category: 'c', present: false, source: 'referee' },
      { sessionId: 'b', category: 'c', present: 'yes' },
      { sessionId: 7, category: 'c', present: true },
      { sessionId: 'd', category: 5, present: true },
      { sessionId: 'e', category: 'c', present: false },
    ].map((r) => `${JSON.stringify(r)}\n`).join('') + 'not json\n');
    const map = loadRulings(file);
    assert.deepEqual([...map.keys()], ['a\0c', 'e\0c']);
    assert.equal(map.get('a\0c').present, true);
    assert.equal(map.get('a\0c').source, 'owner');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('disagreements: judge fail against a label without the category, and the reverse; excluded, no-label, undecided, other version and ruled pairs are left out', () => {
  const s = (sessionId, excluded = false) => ({ sessionId, file: null, excluded });
  const sessions = [s('a'), s('b'), s('c'), s('d'), s('e', true), s('f'), s('g'), s('h')];
  const labelCategories = new Map([['a', ['x']], ['b', ['x']], ['c', []], ['d', []], ['e', []], ['g', []], ['h', []]]);
  const j = (sessionId, result, promptHash = 'v1') => ({ sessionId, category: 'x', result, promptHash });
  const judgments = [j('a', 'pass'), j('b', 'fail'), j('c', 'fail'), j('d', 'pass'), j('e', 'fail'), j('f', 'fail'), j('g', 'undecided'), j('h', 'fail', 'v0')];
  const rulings = new Map([['c\0x', { sessionId: 'c', category: 'x', present: true }]]);
  const got = disagreements({ category: 'x', sessions, labelCategories, judgments, version: 'v1', rulings: new Map() });
  assert.deepEqual(got.map((d) => [d.session.sessionId, d.judge]), [['a', 'pass'], ['c', 'fail']]);
  const ruled = disagreements({ category: 'x', sessions, labelCategories, judgments, version: 'v1', rulings });
  assert.deepEqual(ruled.map((d) => d.session.sessionId), ['a']);
});

test('applyRulings: follows the ruling on existing lines only, keeps order, other categories and unruled lines byte for byte', () => {
  const base = tmp();
  try {
    const file = join(base, 'label-categories.jsonl');
    const l1 = '{"sessionId":"a","categories":["x","y"],"extra":1}';
    const l2 = '{ "sessionId": "b", "categories": ["y"] }';
    const l3 = '{"sessionId":"c","categories":[]}';
    writeFileSync(file, `${l1}\n${l2}\ntorn-line\n${l3}\n`);
    const rulings = new Map([
      ['a\0x', { present: false }], ['b\0x', { present: true }], ['c\0x', { present: false }], ['zz\0x', { present: true }],
    ]);
    assert.equal(applyRulings({ evals: base, rulings }), 2);
    const out = readFileSync(file, 'utf8').split('\n');
    assert.deepEqual(JSON.parse(out[0]), { sessionId: 'a', categories: ['y'], extra: 1 });
    assert.deepEqual(JSON.parse(out[1]).categories, ['y', 'x']);
    assert.equal(out[2], 'torn-line');
    assert.equal(out[3], l3);
    assert.equal(out.length, 5);
    assert.equal(mode(file), 0o600);
    assert.equal(applyRulings({ evals: base, rulings }), 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('one disagreement and one agreement: one call, one ruling with twelve keys, the label follows it, the other line is unchanged', async () => {
  const f = fixture();
  try {
    const { spawn, calls } = stub();
    const before = lines(join(f.evals, 'label-categories.jsonl'));
    const r = await run(f, [], { spawn });
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLine(r.out), 'refereed 1: pro 1; errors 0; left 0; empty 0');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, join(f.evals, 'judge-cwd'));
    assert.equal(calls[0].bin, 'claude-stub');
    assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, 'pro-tok');
    assert.ok(calls[0].args.includes('claude-sonnet-5-5'));
    const file = join(f.evals, 'rulings.jsonl');
    assert.equal(lines(file).length, 1);
    assert.equal(mode(file), 0o600);
    const row = JSON.parse(lines(file)[0]);
    assert.deepEqual(Object.keys(row).sort(), ['at', 'auth', 'category', 'judge', 'misleading', 'model', 'present', 'promptHash', 'quote', 'sessionId', 'source', 'why']);
    assert.equal(row.sessionId, 's1');
    assert.equal(row.category, 'repeat-ask');
    assert.equal(row.present, false);
    assert.equal(row.source, 'referee');
    assert.equal(row.judge, 'pass');
    assert.equal(row.model, 'claude-sonnet-5-5');
    assert.equal(row.auth, 'pro');
    assert.equal(row.at, '2026-11-16T12:00:00.000Z');
    const after = lines(join(f.evals, 'label-categories.jsonl'));
    assert.equal(after.length, before.length);
    assert.deepEqual(JSON.parse(after[3]), { sessionId: 's1', categories: ['false-claim'] });
    assert.equal(after[4], before[4], 'the other session line is unchanged byte for byte');
    assert.equal(mode(join(f.evals, 'label-categories.jsonl')), 0o600);
    assert.ok(!r.out.includes('Please fix the parser'), 'no transcript text is printed');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('the stub input holds the judge, the label, the reference quote and the definition; a secret is absent; without a reference line the quote is none', async () => {
  const f = fixture({ s1Text: `Please fix the parser, key ${SECRET}.` });
  try {
    const { spawn, calls } = stub();
    await run(f, [], { spawn });
    const input = calls[0].input;
    assert.ok(input.includes('A judge and a label disagree.'));
    assert.ok(input.includes('Failure category: repeat-ask (Repeated request)\nDefinition: The owner had to say the same thing twice.\n'));
    assert.ok(input.split('\n').includes('The judge said: pass'));
    assert.ok(input.split('\n').includes('The label says: present'));
    assert.ok(input.split('\n').includes('Reference quote: QUOTE-MARKER-1'));
    assert.ok(input.includes('\n\n--- session transcript ---\n'));
    assert.ok(input.includes('Please fix the parser'));
    assert.ok(!input.includes(SECRET), 'the secret never reaches the model');
    const schema = JSON.parse(calls[0].args[calls[0].args.indexOf('--json-schema') + 1]);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['misleading', 'present', 'quote', 'why']);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture({ reference: false });
  try {
    const { spawn, calls } = stub();
    await run(g, [], { spawn });
    assert.ok(calls[0].input.split('\n').includes('Reference quote: none'));
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test('a second run makes no call', async () => {
  const f = fixture();
  try {
    const { spawn, calls } = stub();
    await run(f, [], { spawn });
    const again = await run(f, [], { spawn });
    assert.equal(again.code, 0);
    assert.equal(lastLine(again.out), 'refereed 0: none; errors 0; left 0; empty 0');
    assert.equal(calls.length, 1);
    assert.equal(lines(join(f.evals, 'rulings.jsonl')).length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('an owner ruling for the pair prevents the call and the label carries its present; the first ruling wins', async () => {
  const f = fixture();
  try {
    // s2 has no repeat-ask on its label and the judge passed it; make the judge fail it so it is a disagreement
    writeFileSync(join(f.evals, 'judgments', 'repeat-ask.jsonl'), [
      { sessionId: 's1', category: 'repeat-ask', result: 'pass', promptHash: f.version },
      { sessionId: 's2', category: 'repeat-ask', result: 'fail', promptHash: f.version },
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    writeFileSync(join(f.evals, 'rulings.jsonl'), [
      { sessionId: 's1', category: 'repeat-ask', present: true, source: 'owner', judge: 'pass' },
      { sessionId: 's2', category: 'repeat-ask', present: true, source: 'owner', judge: 'fail' },
    ].map((r) => `${JSON.stringify(r)}\n`).join(''));
    const { spawn, calls } = stub();
    const r = await run(f, [], { spawn });
    assert.equal(r.code, 0, r.err);
    assert.equal(calls.length, 0);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 0; left 0; empty 0');
    const after = lines(join(f.evals, 'label-categories.jsonl')).map((l) => JSON.parse(l));
    assert.deepEqual(after[3].categories, ['repeat-ask', 'false-claim']);
    assert.deepEqual(after[4].categories, ['false-claim', 'repeat-ask']);
    assert.equal(lines(join(f.evals, 'rulings.jsonl')).length, 2);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a limit on a one-entry chain writes no ruling, says so on stderr and exits 1', async () => {
  const f = fixture();
  try {
    writeFileSync(f.authFile, JSON.stringify({ chain: [{ name: 'pro', env: { CLAUDE_CODE_OAUTH_TOKEN: 'pro-tok' } }] }));
    const before = readFileSync(join(f.evals, 'label-categories.jsonl'), 'utf8');
    const r = await run(f, [], stub(() => ({ is_error: true, result: 'You have hit your usage limit' })));
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 0; left 1; empty 0');
    assert.ok(r.err.includes(LIMIT_NOTE), r.err);
    assert.throws(() => statSync(join(f.evals, 'rulings.jsonl')));
    assert.equal(readFileSync(join(f.evals, 'label-categories.jsonl'), 'utf8'), before);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a chain of paid entries only, without --paid, says so once, makes no call and exits 1; --paid uses it', async () => {
  const f = fixture();
  try {
    writeFileSync(f.authFile, JSON.stringify({ chain: [{ name: 'api', env: { ANTHROPIC_API_KEY: 'api-tok' }, paid: true }] }));
    const s = stub();
    const r = await run(f, [], s);
    assert.equal(r.code, 1);
    assert.equal(s.calls.length, 0);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 0; left 1; empty 0');
    assert.equal(r.err.split(PAID_NOTE).length - 1, 1, r.err);
    const p = await run(f, ['--paid'], s);
    assert.equal(p.code, 0, p.err);
    assert.equal(lastLine(p.out), 'refereed 1: api 1; errors 0; left 0; empty 0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('an excluded session is never sent', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.evals, 'taxonomy.json'), JSON.stringify({ ...TAXONOMY, judgeExclude: ['/home/x/s1'] }));
    const s = stub();
    const r = await run(f, [], s);
    assert.equal(r.code, 0, r.err);
    assert.equal(s.calls.length, 0);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 0; left 0; empty 0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a pair whose session has a readable transcript with no text is skipped: no call, not an error, not left, exit 0, counted in empty', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.base, 'projects', '-home-x-s1', 's1.jsonl'), '');
    const s = stub();
    const r = await run(f, [], s);
    assert.equal(r.code, 0, r.err);
    assert.equal(s.calls.length, 0);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 0; left 0; empty 1');
    assert.throws(() => statSync(join(f.evals, 'rulings.jsonl')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a pair whose transcript is gone, with no kept render, is an error and stays left', async () => {
  const f = fixture();
  try {
    rmSync(join(f.base, 'projects', '-home-x-s1', 's1.jsonl'));
    const s = stub();
    const r = await run(f, [], s);
    assert.equal(r.code, 1);
    assert.equal(s.calls.length, 0);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 1; left 1; empty 0');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a pair whose transcript was deleted but whose render is kept is ruled from the kept text, and no render is written', async () => {
  const f = fixture();
  try {
    const file = join(f.base, 'projects', '-home-x-s1', 's1.jsonl');
    keepRenders({ evals: f.evals, sessions: [{ sessionId: 's1', file, excluded: false }] });
    rmSync(file);
    const s = stub();
    const r = await run(f, [], s);
    assert.equal(r.code, 0, r.err);
    assert.equal(s.calls.length, 1);
    assert.ok(s.calls[0].input.includes('Please fix the parser.'), 'the stub receives the kept text');
    assert.equal(lastLine(r.out), 'refereed 1: pro 1; errors 0; left 0; empty 0');
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')), ['s1.txt']);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('an answer that fails the schema writes no ruling and counts as an error', async () => {
  const f = fixture();
  try {
    const r = await run(f, [], stub(() => ({ structured_output: { present: 'maybe', quote: '', why: 'x', misleading: 'y' } })));
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.out), 'refereed 0: none; errors 1; left 1; empty 0');
    assert.throws(() => statSync(join(f.evals, 'rulings.jsonl')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('quote, why and misleading are cut to 300, 400 and 500 characters', async () => {
  const f = fixture();
  try {
    await run(f, [], stub(() => ({ structured_output: answer({ present: true, quote: 'q'.repeat(900), why: 'w'.repeat(900), misleading: 'm'.repeat(900) }) })));
    const row = JSON.parse(lines(join(f.evals, 'rulings.jsonl'))[0]);
    assert.equal(row.quote.length, 300);
    assert.equal(row.why.length, 400);
    assert.equal(row.misleading.length, 500);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('--category with a code category, an unknown one or a bad argument exits 2; --category limits the run to that category', async () => {
  const f = fixture();
  try {
    const s = stub();
    for (const argv of [['--category', 'big-diff'], ['--category', 'nope'], ['--category'], ['--bogus']]) {
      const r = await run(f, argv, s);
      assert.equal(r.code, 2, argv.join(' '));
    }
    assert.equal(s.calls.length, 0);
    const other = await run(f, ['--category', 'false-claim'], s);
    assert.equal(other.code, 1, 'a named category with no judge prompt is an error');
    assert.ok(other.err.includes('false-claim'), other.err);
    assert.equal(s.calls.length, 0);
    const one = await run(f, ['--category', 'repeat-ask'], s);
    assert.equal(one.code, 0, one.err);
    assert.equal(s.calls.length, 1);
    const help = await run(f, ['--help'], s);
    assert.equal(help.code, 0);
    assert.ok(help.out.includes('triqual eval referee'));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('eval --help lists referee', async () => {
  let out = '';
  assert.equal(await evalMain(['--help'], { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } }), 0);
  assert.ok(/^ {2}referee /m.test(out), out);
});
