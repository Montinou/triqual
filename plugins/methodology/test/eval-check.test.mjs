import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-check.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { checkVersion } from '../cli/lib/eval-checks.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-check-'));
const mode = (f) => statSync(f).mode & 0o777;
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'owner-chased-progress', name: 'Owner chased progress', definition: 'The owner asked whether anything was happening.', examples: ['e1', 'e2', 'e3'], check: 'code' },
    { id: 'repeat-ask', name: 'Repeated request', definition: 'The owner had to say the same thing twice.', examples: ['e1', 'e2', 'e3'], check: 'judge' },
  ],
};

// Two sample sessions: s1 chases progress (fail), s2 does not (pass).
function fixture() {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  mkdirSync(join(evals, 'review'), { recursive: true });
  const rows = []; const store = [];
  for (const id of ['s1', 's2']) {
    const projectDir = `-home-x-${id}`;
    rows.push({ sessionId: id, project: `/home/x/${id}`, stratum: 'random' });
    store.push({ sessionId: id, project: `/home/x/${id}`, projectDir, entrypoint: 'cli' });
    mkdirSync(join(root, projectDir), { recursive: true });
    const ask = id === 's1' ? 'Is anything happening?' : 'Please fix the parser.';
    writeFileSync(join(root, projectDir, `${id}.jsonl`), `${turn('user', ask)}\n${turn('assistant', 'Done.')}\n`);
  }
  writeFileSync(join(evals, 'review', 'sample.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'sessions.jsonl'), store.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  writeFileSync(join(evals, 'label-categories.jsonl'), ['e1', 'e2', 'e3'].map((id) => `${JSON.stringify({ sessionId: id, categories: [] })}\n`).join(''));
  const env = { HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: evals };
  return { base, evals, root, env, out: join(evals, 'judgments', 'owner-chased-progress.jsonl') };
}

function run(argv, env, extra = {}) {
  let out = ''; let err = '';
  const p = main(argv, {
    env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, now: () => new Date('2026-11-16T12:00:00Z'), ...extra,
  });
  return p.then((code) => ({ code, out, err }));
}

test('checkVersion is 16 hex characters and stable', () => {
  assert.match(checkVersion(), /^[0-9a-f]{16}$/);
  assert.equal(checkVersion(), checkVersion());
});

test('check records one verdict per sample session and code category, and a second run adds none', async () => {
  const f = fixture();
  const first = await run([], f.env, { version: 'v1' });
  assert.equal(first.code, 0);
  assert.equal(first.out.trim().split('\n').at(-1), 'checked 2; undecided 0');
  const rows = lines(f.out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.result]), [['s1', 'fail'], ['s2', 'pass']]);
  for (const r of rows) {
    assert.equal(r.category, 'owner-chased-progress');
    assert.equal(r.promptHash, 'v1');
    assert.equal(r.model, null);
    assert.equal(r.auth, 'code');
    assert.equal(r.at, '2026-11-16T12:00:00.000Z');
  }
  assert.equal(mode(f.out), 0o600);
  const second = await run([], f.env, { version: 'v1' });
  assert.equal(second.code, 0);
  assert.equal(second.out.trim().split('\n').at(-1), 'checked 0; undecided 0');
  assert.equal(lines(f.out).length, 2);
});

test('a new check version adds a line per session and keeps the earlier ones', async () => {
  const f = fixture();
  await run([], f.env, { version: 'v1' });
  const again = await run([], f.env, { version: 'v2' });
  assert.equal(again.out.trim().split('\n').at(-1), 'checked 2; undecided 0');
  const rows = lines(f.out);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.promptHash), ['v1', 'v1', 'v2', 'v2']);
});

test('a session whose transcript is gone is recorded undecided and counted', async () => {
  const f = fixture();
  writeFileSync(join(f.evals, 'sessions.jsonl'), `${JSON.stringify({ sessionId: 's1', project: '/home/x/s1', projectDir: '-home-x-s1' })}\n`);
  const r = await run([], f.env, { version: 'v1' });
  assert.equal(r.out.trim().split('\n').at(-1), 'checked 2; undecided 1');
  assert.deepEqual(lines(f.out).map((x) => x.result), ['fail', 'undecided']);
});

test('the default version is checkVersion()', async () => {
  const f = fixture();
  await run([], f.env);
  assert.equal(lines(f.out)[0].promptHash, checkVersion());
});

test('--category with a judge category or an unknown one exits 2', async () => {
  const f = fixture();
  const judge = await run(['--category', 'repeat-ask'], f.env);
  assert.equal(judge.code, 2);
  assert.match(judge.err, /judge/);
  assert.equal((await run(['--category', 'nope-nope'], f.env)).code, 2);
  assert.equal((await run(['--bogus'], f.env)).code, 2);
});

test('--category names one code category', async () => {
  const f = fixture();
  const r = await run(['--category', 'owner-chased-progress'], f.env, { version: 'v1' });
  assert.equal(r.code, 0);
  assert.equal(lines(f.out).length, 2);
});

test('--help prints the usage and the command is discovered by eval', async () => {
  const r = await run(['--help'], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /triqual eval check/);
  let out = '';
  assert.equal(await evalMain(['--help'], { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } }), 0);
  assert.match(out, /\bcheck\b/);
});
