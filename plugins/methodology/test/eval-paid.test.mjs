import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-judge.mjs';
import { AuthError, isLimit, loadChain, usableChain, LIMIT_NOTE, PAID_NOTE } from '../cli/lib/eval-auth.mjs';
import { readJsonl } from '../cli/lib/eval-store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evpaid-'));
const MODEL = 'claude-opus-5-5';

// ---- the library ----

const chainOf = (...entries) => entries;
const sub = { name: 'sub', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub-token' }, paid: false };
const paidOne = { name: 'paid-one', env: { ANTHROPIC_API_KEY: 'paid-1' }, paid: true };
const subTwo = { name: 'sub-two', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub-tok-2' }, paid: false };

test('usableChain drops the paid entries and keeps the order; paid: true returns every entry', () => {
  const chain = chainOf(sub, paidOne, subTwo);
  assert.deepEqual(usableChain(chain).map((e) => e.name), ['sub', 'sub-two']);
  assert.deepEqual(usableChain(chain, { paid: false }).map((e) => e.name), ['sub', 'sub-two']);
  assert.deepEqual(usableChain(chain, { paid: true }).map((e) => e.name), ['sub', 'paid-one', 'sub-two']);
  assert.deepEqual(usableChain([paidOne]), []);
});

function writeChain(doc) {
  const file = join(tmp(), 'eval-auth.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

test('loadChain: paid is false when the key is absent, true when set, and a non-boolean throws AuthError', () => {
  const file = writeChain({ chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }, { name: 'two', env: { ANTHROPIC_API_KEY: 'y' }, paid: true }, { name: 'three', paid: false }] });
  assert.deepEqual(loadChain(file).map((e) => [e.name, e.paid]), [['one', false], ['two', true], ['three', false]]);
  for (const bad of ['yes', 1, null, 'true']) {
    const f = writeChain({ chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, paid: bad }] });
    assert.throws(() => loadChain(f), (err) => err instanceof AuthError && /paid/.test(err.message), String(bad));
  }
});

test('loadChain: the ambient entry (no file) is not paid', () => {
  assert.deepEqual(loadChain(join(tmp(), 'missing.json')), [{ name: 'ambient', env: {}, paid: false }]);
});

test('isLimit: a bare 429 is not a limit; a 429 with usage_limit_reached or the limit text is', () => {
  assert.equal(isLimit({ is_error: true, api_error_status: 429, result: 'Too many requests' }), false);
  assert.equal(isLimit({ is_error: true, api_error_status: 429 }), false);
  assert.equal(isLimit({ is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: 'Too many requests' }), true);
  assert.equal(isLimit({
    type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 8:30am (America/Cordoba)",
    api_error_status: 429, api_error: 'usage_limit_reached', terminal_reason: 'api_error', total_cost_usd: 0,
  }), true);
  assert.equal(isLimit({ is_error: true, api_error_status: 429, result: "You've hit your limit" }), true);
});

test('LIMIT_NOTE is the text of the exhausted-chain message', () => {
  assert.equal(LIMIT_NOTE, 'every credential entry hit a usage limit');
});

// ---- the command ----

const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

function fixture({ chain, exclude = [], stored = ['s1'], listed = stored } = {}) {
  const dir = tmp();
  const evals = join(dir, 'evals');
  const root = join(dir, 'projects');
  const home = join(dir, 'home');
  const judges = join(dir, 'judges');
  for (const d of [home, evals, judges, join(root, '-home-x-proj')]) mkdirSync(d, { recursive: true });
  for (const id of stored) writeFileSync(join(root, '-home-x-proj', `${id}.jsonl`), `${turn('user', `invented task of ${id}`)}\n${turn('assistant', 'invented reply')}\n`);
  writeFileSync(join(evals, 'sessions.jsonl'), `${stored.map((id) => JSON.stringify({ sessionId: id, project: '/home/x/proj', projectDir: '-home-x-proj' })).join('\n')}\n`);
  writeFileSync(join(evals, 'label-categories.jsonl'), ['a', 'b', 'c'].map((id) => JSON.stringify({ sessionId: id, categories: ['stalls'] })).join('\n'));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify({
    judgeExclude: exclude,
    categories: [{ id: 'stalls', name: 'Stalls', definition: 'd', examples: ['a', 'b', 'c'], check: 'judge' }],
  }));
  writeFileSync(join(judges, 'stalls.md'), `---\nmodel: ${MODEL}\n---\nDecide whether the session shows the failure.\n`);
  const sessionsFile = join(dir, 'ids.txt');
  writeFileSync(sessionsFile, `${listed.join('\n')}\n`);
  const auth = join(dir, 'eval-auth.json');
  writeFileSync(auth, JSON.stringify({ chain }));
  const env = { HOME: home, PATH: process.env.PATH, TRIQUAL_EVALS_DIR: evals, TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVAL_AUTH_FILE: auth };
  return { env, judges, sessionsFile, judgments: join(evals, 'judgments', 'stalls.jsonl') };
}

const LIMIT = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 8:30am", api_error_status: 429, api_error: 'usage_limit_reached' };
const OK = { type: 'result', subtype: 'success', is_error: false, structured_output: { critique: 'fine', result: 'pass' } };

// A spawn stub: the subscription token is limited, any other credential judges. Every call is recorded with its variables.
function stub() {
  const calls = [];
  const spawn = async (bin, args, { env }) => {
    calls.push({ oauth: env.CLAUDE_CODE_OAUTH_TOKEN ?? null, key: env.ANTHROPIC_API_KEY ?? null });
    return { code: 0, stdout: JSON.stringify(env.CLAUDE_CODE_OAUTH_TOKEN === 'sub-token' ? LIMIT : OK), stderr: '' };
  };
  return { calls, spawn };
}

async function run(e, argv, spawn) {
  let out = '';
  let err = '';
  const code = await main(argv, { env: e.env, judgesDir: e.judges, spawn, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, platform: 'linux' });
  return { code, out, err, last: out.trim().split('\n').at(-1) };
}

const entries = [
  { name: 'sub', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub-token' } },
  { name: 'paid-one', env: { ANTHROPIC_API_KEY: 'paid-1' }, paid: true },
];

test('without --paid a paid entry is never used: the session is left, exit 1', async () => {
  const e = fixture({ chain: entries });
  const s = stub();
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile], s.spawn);
  assert.equal(r.code, 1, r.err);
  assert.ok(s.calls.length > 0);
  assert.ok(s.calls.every((c) => c.key === null), 'no call carries the paid variable');
  assert.match(r.last, /left 1$/);
  assert.ok(r.err.includes(LIMIT_NOTE), r.err);
  assert.deepEqual(readJsonl(e.judgments).rows, []);
});

test('with --paid the session falls through to the paid entry and is judged on it', async () => {
  const e = fixture({ chain: entries });
  const s = stub();
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile, '--paid'], s.spawn);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.calls.at(-1).key, 'paid-1');
  assert.equal(r.last, 'judged 1: paid-one 1; errors 0; left 0');
  assert.deepEqual(readJsonl(e.judgments).rows.map((x) => [x.sessionId, x.result, x.auth]), [['s1', 'pass', 'paid-one']]);
});

test('a chain of paid entries only, without --paid, makes no call and exits 1', async () => {
  const e = fixture({ chain: [{ name: 'only-paid', env: { ANTHROPIC_API_KEY: 'paid-1' }, paid: true }] });
  const s = stub();
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile], s.spawn);
  assert.equal(r.code, 1, r.err);
  assert.equal(s.calls.length, 0);
  assert.match(r.last, /left 1$/);
  assert.deepEqual(readJsonl(e.judgments).rows, []);
  assert.equal(PAID_NOTE, 'every credential entry is paid; pass --paid');
  assert.equal(r.err.split(PAID_NOTE).length - 1, 1, `the paid note is printed once: ${r.err}`);
  assert.ok(!r.err.includes(LIMIT_NOTE), `a paid-only chain is not a usage limit: ${r.err}`);
  assert.ok(!r.err.includes('tried:'), r.err);
});

test('--paid takes no value and is listed in the usage', async () => {
  const e = fixture({ chain: entries });
  const s = stub();
  const help = await run(e, ['--help'], s.spawn);
  assert.equal(help.code, 0);
  assert.match(help.out, /--paid/);
  const bad = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile, '--paid=yes'], s.spawn);
  assert.equal(bad.code, 2);
});

test('with a judgeExclude pattern, an id missing from the sessions store gets no line and counts as an error', async () => {
  const e = fixture({ chain: [{ name: 'sub-two', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub-tok-2' } }], exclude: ['/home/x/other'], stored: ['s1'], listed: ['s1', 'ghost'] });
  const s = stub();
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile], s.spawn);
  assert.equal(r.code, 1, r.err);
  const rows = readJsonl(e.judgments).rows;
  assert.ok(!rows.some((x) => x.sessionId === 'ghost'), 'no line for the missing id');
  assert.match(r.err, /ghost: not in the sessions store/);
  assert.equal(r.last, 'judged 1: sub-two 1; errors 1; left 1');
});
