import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli/eval.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli');
const SENTINEL = 'zz-message-content-sentinel';

const turn = (id, at, output) => JSON.stringify({
  type: 'assistant', requestId: `r-${id}`, timestamp: at,
  message: {
    id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: SENTINEL }],
    usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const opening = (at) => JSON.stringify({ type: 'user', cwd: '/work/proj', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: SENTINEL } });

// `count` interactive sessions, each with a different cost, under the transcripts root of a temp home.
function fixture(count) {
  const base = mkdtempSync(join(tmpdir(), 'cm-evcli-'));
  const root = join(base, 'projects');
  mkdirSync(join(root, '-work-proj'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const id = `s${String(i).padStart(3, '0')}`;
    writeFileSync(join(root, '-work-proj', `${id}.jsonl`), `${[opening('2026-11-01T10:00:00Z'), turn(`m${id}`, '2026-11-01T10:01:00Z', 1000 * (i + 1))].join('\n')}\n`);
  }
  return { base, root, evals: join(base, 'evals'), env: { HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: join(base, 'evals') } };
}

async function run(f, argv, deps = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...deps });
  return { code, out, err };
}
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('dispatches to eval-sessions', async () => {
  const f = fixture(3);
  try {
    const r = await run(f, ['sessions', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).sessions.length, 3);
    assert.ok(existsSync(join(f.evals, 'sessions.jsonl')), 'the sessions store was written under the evals dir');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('help lists sessions and review', async () => {
  const f = fixture(0);
  try {
    for (const argv of [[], ['--help'], ['-h']]) {
      const r = await run(f, argv);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /^\s+sessions\s+\S/m, `${argv.join(' ')}: a sessions line with its summary`);
      assert.match(r.out, /^\s+review\s+\S/m, `${argv.join(' ')}: a review line with its summary`);
      assert.doesNotMatch(r.out, /undefined/);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('unknown subcommand exits 2', async () => {
  const f = fixture(0);
  try {
    for (const sub of ['nope', '../cost', 'Sessions', 'sessions.mjs', 'lib']) {
      const r = await run(f, [sub]);
      assert.equal(r.code, 2, `${sub}: ${r.out}`);
      assert.match(r.err, /unknown/);
      assert.equal(r.out, '');
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('review sample writes 100 rows with the strata', async () => {
  const f = fixture(120);
  try {
    const r = await run(f, ['review', 'sample', '--seed', '7']);
    assert.equal(r.code, 0, r.err);
    const file = join(f.evals, 'review', 'sample.jsonl');
    const rows = lines(file);
    assert.equal(rows.length, 100);
    const by = (s) => rows.filter((x) => x.stratum === s).length;
    assert.deepEqual([by('random'), by('cost'), by('outlier')], [50, 25, 25]);
    assert.equal(new Set(rows.map((x) => x.sessionId)).size, 100);
    assert.equal(rows[0].file, join(f.root, '-work-proj', `${rows[0].sessionId}.jsonl`), 'a row points at the transcript under the transcripts root');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.match(r.out, /random\s+50/);
    assert.match(r.out, /cost\s+25/);
    assert.match(r.out, /outlier\s+25/);
    assert.match(r.out, /seed 7/);
    assert.ok(!r.out.includes(SENTINEL) && !r.err.includes(SENTINEL), 'no transcript text is printed');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('review sample keeps an existing sample unless --force, and --n and --seed are honoured', async () => {
  const f = fixture(30);
  try {
    const file = join(f.evals, 'review', 'sample.jsonl');
    assert.equal((await run(f, ['review', 'sample', '--n', '8', '--seed', '1'])).code, 0);
    const first = readFileSync(file, 'utf8');
    assert.equal(lines(file).length, 8);
    const again = await run(f, ['review', 'sample', '--n', '8', '--seed', '2']);
    assert.equal(again.code, 1);
    assert.match(again.err, /--force/);
    assert.equal(readFileSync(file, 'utf8'), first, 'the sample is untouched');
    const forced = await run(f, ['review', 'sample', '--n', '8', '--seed', '1', '--force']);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(readFileSync(file, 'utf8'), first, 'the same seed draws the same sample');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('review rejects bad arguments with exit 2', async () => {
  const f = fixture(1);
  try {
    for (const argv of [['review'], ['review', 'nope'], ['review', 'sample', '--n', '0'], ['review', 'sample', '--n', 'x'],
      ['review', 'sample', '--seed', '1.5'], ['review', 'sample', '--bogus'], ['review', 'serve', '--port', '70000'], ['review', 'serve', '--port', 'x']]) {
      const r = await run(f, argv);
      assert.equal(r.code, 2, `${argv.join(' ')}: ${r.err}`);
    }
    assert.equal((await run(f, ['review', '--help'])).code, 0);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('review serve prints a plain loopback URL that serves the sample, and refuses connections once stopped', async () => {
  const f = fixture(5);
  let stop = () => {};
  try {
    assert.equal((await run(f, ['review', 'serve'])).code, 1, 'no sample yet: a message, not a server');
    assert.equal((await run(f, ['review', 'sample', '--n', '4', '--seed', '3'])).code, 0);
    const sample = lines(join(f.evals, 'review', 'sample.jsonl'));
    const until = new Promise((resolve) => { stop = resolve; });
    let out = '';
    let printed;
    const seen = new Promise((resolve) => { printed = resolve; });
    const pending = run(f, ['review', 'serve', '--port', '0'], { until, stdout: { write: (s) => { out += s; if (/http:\/\//.test(out)) printed(); } } });
    await seen;
    const m = /^Review page: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(out);
    assert.ok(m, `a plain loopback URL, no query string: ${out}`);
    const url = m[1];
    const res = await fetch(url);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes(sample[0].sessionId), 'the page shows the first sample session');
    stop();
    const r = await pending;
    assert.equal(r.code, 0, r.err);
    await assert.rejects(fetch(url), 'the server is closed after the stop');
    assert.ok(!out.includes(SENTINEL));
  } finally { stop(); rmSync(f.base, { recursive: true, force: true }); }
});

test('eval.mjs run as a script lists its subcommands and exits 2 on an unknown one', () => {
  const help = spawnSync(process.execPath, [join(CLI, 'eval.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sessions/);
  assert.match(help.stdout, /review/);
  assert.equal(spawnSync(process.execPath, [join(CLI, 'eval.mjs'), 'nope'], { encoding: 'utf8' }).status, 2);
});
