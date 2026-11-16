import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-review.mjs';
import { LIMIT_NOTE } from '../cli/lib/eval-auth.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evprop-'));
const mode = (f) => statSync(f).mode & 0o777;
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');
const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'repeat-ask', name: 'Repeated request', definition: 'The owner had to say the same thing twice.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
    { id: 'false-claim', name: 'False claim', definition: 'The assistant said something the record contradicts.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
  ],
};
const answer = () => ({
  label: 'bad',
  reason: 'The owner repeated an instruction.',
  categories: { 'repeat-ask': { present: true, quote: 'please do it again' }, 'false-claim': { present: false, quote: '' } },
});

// A full fixture: sample, sessions store, transcripts, taxonomy, label-categories (the taxonomy examples), prompt file.
function fixture({ sample = true } = {}) {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  mkdirSync(join(evals, 'review'), { recursive: true });
  const ids = ['s1', 's2'];
  const rows = []; const store = [];
  for (const id of ids) {
    const projectDir = `-home-x-${id}`;
    rows.push({ sessionId: id, project: `/home/x/${id}`, stratum: 'random' });
    store.push({ sessionId: id, project: `/home/x/${id}`, projectDir, entrypoint: 'cli' });
    mkdirSync(join(root, projectDir), { recursive: true });
    writeFileSync(join(root, projectDir, `${id}.jsonl`), `${turn('user', 'Please fix the parser.')}\n${turn('assistant', 'Done.')}\n`);
  }
  if (sample) writeFileSync(join(evals, 'review', 'sample.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'sessions.jsonl'), store.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  writeFileSync(join(evals, 'label-categories.jsonl'), ['e1', 'e2', 'e3'].map((id) => `${JSON.stringify({ sessionId: id, categories: [] })}\n`).join(''));
  const prompt = join(base, 'reference.md');
  writeFileSync(prompt, '---\nmodel: claude-sonnet-5-5\n---\nLabel the session.\n');
  const authFile = join(base, 'eval-auth.json');
  writeFileSync(authFile, JSON.stringify({ chain: [{ name: 'pro', env: { CLAUDE_CODE_OAUTH_TOKEN: 'pro-tok' } }, { name: 'api', env: { ANTHROPIC_API_KEY: 'api-tok' }, paid: true }] }));
  const env = { HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: evals, TRIQUAL_EVAL_AUTH_FILE: authFile, TRIQUAL_CLAUDE_BIN: 'claude-stub' };
  return { base, evals, env, prompt };
}

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
    now: () => new Date('2026-11-16T12:00:00Z'), referencePrompt: f.prompt, platform: 'linux', ...over,
  });
  return { code, out, err };
}
const lastLine = (out) => out.trimEnd().split('\n').at(-1);

test('propose over the fixture prints the last line with the entry name and exits 0', async () => {
  const f = fixture();
  try {
    const { spawn, calls } = stub();
    const r = await run(f, ['propose'], { spawn });
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLine(r.out), 'proposed 2: pro 2; errors 0; left 0');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cwd, join(f.evals, 'judge-cwd'));
    assert.equal(calls[0].bin, 'claude-stub');
    assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, 'pro-tok');
    const ref = join(f.evals, 'review', 'reference.jsonl');
    assert.equal(lines(ref).length, 2);
    assert.equal(mode(ref), 0o600);
    assert.ok(!existsSync(join(f.evals, 'review', 'labels.jsonl')), 'no labels without --accept');
    assert.ok(!r.out.includes('Please fix the parser'), 'no transcript text is printed');
    // a second run has nothing left to propose
    const again = await run(f, ['propose'], { spawn });
    assert.equal(again.code, 0);
    assert.equal(lastLine(again.out), 'proposed 0: none; errors 0; left 0');
    assert.equal(calls.length, 2);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('--accept prints the accepted line before the last line and writes both files', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['propose', '--accept'], stub());
    assert.equal(r.code, 0, r.err);
    const out = r.out.trimEnd().split('\n');
    assert.equal(out.at(-1), 'proposed 2: pro 2; errors 0; left 0');
    assert.equal(out.at(-2), 'accepted: labels 2, categories 2');
    const labels = join(f.evals, 'review', 'labels.jsonl');
    const cats = join(f.evals, 'label-categories.jsonl');
    assert.equal(lines(labels).length, 2);
    assert.equal(lines(cats).length, 5);
    assert.equal(mode(labels), 0o600);
    assert.deepEqual(JSON.parse(lines(cats).at(-1)).categories, ['repeat-ask']);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a paid chain entry is used only with --paid: the limit note goes to stderr and the exit is 1', async () => {
  const f = fixture();
  try {
    const limit = () => ({ is_error: true, result: 'You have hit your usage limit' });
    const r = await run(f, ['propose'], stub(limit));
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.out), 'proposed 0: none; errors 0; left 2');
    assert.ok(r.err.includes(LIMIT_NOTE), r.err);
    // without --paid the paid entry was never tried; with it the second entry answers
    let n = 0;
    const second = stub(() => (n++ === 0 ? limit() : { structured_output: answer() }));
    const p = await run(f, ['propose', '--paid'], second);
    assert.equal(p.code, 0, p.err);
    assert.equal(lastLine(p.out), 'proposed 2: api 2; errors 0; left 0');
    assert.equal(second.calls[1].env.ANTHROPIC_API_KEY, 'api-tok');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a missing sample exits 1 with a message naming triqual eval review sample', async () => {
  const f = fixture({ sample: false });
  try {
    const { spawn, calls } = stub();
    const r = await run(f, ['propose'], { spawn });
    assert.equal(r.code, 1);
    assert.match(r.err, /triqual eval review sample/);
    assert.equal(calls.length, 0);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('an unknown flag exits 2, --accept takes no value, and --help lists propose', async () => {
  const f = fixture();
  try {
    const { spawn, calls } = stub();
    const bad = await run(f, ['propose', '--bogus'], { spawn });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /unknown argument --bogus/);
    assert.equal((await run(f, ['propose', '--accept=yes'], { spawn })).code, 2);
    assert.equal(calls.length, 0);
    const h = await run(f, ['--help']);
    assert.equal(h.code, 0);
    assert.match(h.out, /triqual eval review propose \[--accept\] \[--paid\]/);
    const hp = await run(f, ['propose', '--help']);
    assert.equal(hp.code, 0);
    assert.match(hp.out, /propose/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
