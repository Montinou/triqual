import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../cli/cost.mjs';
import { main } from '../cli/eval-sessions.mjs';
import { readJsonl } from '../cli/lib/eval-store.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'eval-sessions.mjs');
const SENTINEL = 'zz-message-content-sentinel';

// One assistant line with usage, as Claude Code writes it; the content carries the sentinel, which must never print.
const turn = ({ id, at, model = 'claude-opus-5-5', input = 0, output = 0, read = 0, write = 0, write1h = 0 }) => JSON.stringify({
  type: 'assistant', requestId: `r-${id}`, timestamp: at,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: SENTINEL }],
    usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
      cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h },
    },
  },
});
const opening = (at) => JSON.stringify({ type: 'user', cwd: '/work/proj', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: SENTINEL } });

function env() {
  const base = mkdtempSync(join(tmpdir(), 'cm-evsess-'));
  const root = join(base, 'projects');
  mkdirSync(root);
  return { base, root, evals: join(base, 'evals'), home: join(base, 'home') };
}
const write = (e, projectDir, name, lines) => {
  mkdirSync(join(e.root, projectDir), { recursive: true });
  writeFileSync(join(e.root, projectDir, `${name}.jsonl`), `${lines.join('\n')}\n`);
};
function run(e, argv) {
  let out = '';
  let err = '';
  const code = main(argv, {
    env: { HOME: e.home, TRIQUAL_TRANSCRIPTS_DIR: e.root, TRIQUAL_EVALS_DIR: e.evals },
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}
const runJson = (e, argv = []) => {
  const r = run(e, [...argv, '--json']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
const cleanup = (e) => rmSync(e.base, { recursive: true, force: true });
const controllerUsd = (c) => Object.values(c.controller).reduce((a, t) => a + t.usd, 0);

test('window total equals cost controller total minus -claude-mem projects', () => {
  const e = env();
  try {
    // s1 lies before the window; s2 straddles its start (the 11-01 turn is out); s3 is in; a subagent file is not a session.
    write(e, '-home-me-a', 's1', [opening('2026-11-01T08:00:00Z'), turn({ id: 'a1', at: '2026-11-01T08:00:10Z', input: 1000, output: 500, read: 20_000, write: 3000 })]);
    write(e, '-home-me-a', 's2', [
      opening('2026-11-01T23:00:00Z'),
      turn({ id: 'b1', at: '2026-11-01T23:00:10Z', input: 7000, output: 7000, read: 70_000 }),
      turn({ id: 'b2', at: '2026-11-02T10:00:00Z', input: 100, output: 200, read: 3000, write: 400, write1h: 100 }),
      turn({ id: 'b3', at: '2026-11-02T10:01:00Z', model: 'claude-haiku-5-5', input: 50, output: 60 }),
    ]);
    write(e, '-home-me-b', 's3', [opening('2026-11-03T09:00:00Z'), turn({ id: 'c1', at: '2026-11-03T09:00:10Z', input: 10, output: 9000, read: 500, write: 2000, write1h: 2000 })]);
    write(e, '-claude-mem-x', 'm1', [opening('2026-11-02T09:00:00Z'), turn({ id: 'd1', at: '2026-11-02T09:00:10Z', input: 100_000, output: 100_000 })]);
    mkdirSync(join(e.root, '-home-me-a', 's2', 'subagents'), { recursive: true });
    writeFileSync(join(e.root, '-home-me-a', 's2', 'subagents', 'agent-x.jsonl'), `${turn({ id: 'e1', at: '2026-11-02T11:00:00Z', input: 999_999 })}\n`);

    const since = '2026-11-02';
    const until = '2026-11-03';
    const j = runJson(e, ['--since', since, '--until', until]);
    assert.deepEqual(j.sessions.map((s) => s.sessionId).sort(), ['s2', 's3']);
    const s2 = j.sessions.find((s) => s.sessionId === 's2');
    assert.equal(s2.turns, 2); // b2 and b3 only
    const sum = j.sessions.reduce((a, s) => a + s.usd, 0);
    assert.ok(Number.isFinite(j.totalUsd) && j.totalUsd > 0);
    assert.ok(Math.abs(j.totalUsd - sum) < 1e-12);
    const all = collect(e.root, { since, until });
    const mem = collect(e.root, { since, until, project: '-claude-mem-x' });
    assert.ok(controllerUsd(mem) > 0, 'the claude-mem fixture is priced and in the window');
    assert.ok(Math.abs(sum - (controllerUsd(all) - controllerUsd(mem))) < 1e-9, `${sum} vs ${controllerUsd(all)} - ${controllerUsd(mem)}`);
    assert.equal(j.since, since);
    assert.equal(j.until, until);
    assert.deepEqual(j.unpriced, []);
    assert.equal(j.skipped, 0);

    // No window: whole sessions, all three.
    const whole = runJson(e);
    assert.deepEqual(whole.sessions.map((s) => s.sessionId).sort(), ['s1', 's2', 's3']);
    assert.equal(whole.sessions.find((s) => s.sessionId === 's2').turns, 3);
    assert.equal(whole.since, null);
    // --project filters on the project directory name.
    assert.deepEqual(runJson(e, ['--project', '-home-me-b']).sessions.map((s) => s.sessionId), ['s3']);
  } finally { cleanup(e); }
});

test('a deleted transcript keeps its stored line', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'gone', [opening('2026-11-01T08:00:00Z'), turn({ id: 'g1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    write(e, '-home-me-a', 'kept', [opening('2026-11-01T09:00:00Z'), turn({ id: 'k1', at: '2026-11-01T09:00:10Z', input: 10, output: 10 })]);
    const first = runJson(e);
    assert.equal(first.sessions.length, 2);
    rmSync(join(e.root, '-home-me-a', 'gone.jsonl'));
    const again = runJson(e);
    assert.deepEqual(again.sessions.map((s) => s.sessionId).sort(), ['gone', 'kept']);
    // A stored line also serves a window.
    assert.equal(runJson(e, ['--since', '2026-11-01', '--until', '2026-11-01']).sessions.length, 2);
    assert.equal(readJsonl(join(e.evals, 'sessions.jsonl')).rows.length, 2);
  } finally { cleanup(e); }
});

test('a growing session is rewritten, not duplicated', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'grow', [opening('2026-11-01T08:00:00Z'), turn({ id: 'x1', at: '2026-11-01T08:00:10Z', input: 100, output: 100 })]);
    const first = runJson(e);
    assert.equal(first.sessions[0].turns, 1);
    appendFileSync(join(e.root, '-home-me-a', 'grow.jsonl'), `${turn({ id: 'x2', at: '2026-11-02T08:00:10Z', input: 100, output: 100 })}\n`);
    const second = runJson(e);
    assert.equal(second.sessions.length, 1);
    assert.equal(second.sessions[0].turns, 2);
    assert.ok(second.sessions[0].usd > first.sessions[0].usd);
    const stored = readJsonl(join(e.evals, 'sessions.jsonl'));
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].turns, 2);
    assert.equal(stored.skipped, 0);
  } finally { cleanup(e); }
});

test('a stored row with a null entrypoint is rewritten once its transcript yields one', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'ep', [opening('2026-11-01T08:00:00Z'), turn({ id: 'e1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    runJson(e);
    const file = join(e.evals, 'sessions.jsonl');
    // The store as an older extractor wrote it: same transcript end, entrypoint lost.
    const old = readJsonl(file).rows.map((r) => ({ ...r, entrypoint: null }));
    writeFileSync(file, old.map((r) => `${JSON.stringify(r)}\n`).join(''));
    assert.equal(readJsonl(file).rows[0].entrypoint, null);
    const again = runJson(e);
    assert.equal(again.sessions[0].entrypoint, 'cli');
    const stored = readJsonl(file).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].entrypoint, 'cli');
    assert.equal(stored[0].turns, 1);
  } finally { cleanup(e); }
});

test('unpriced lists the model', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'u1', [
      opening('2026-11-01T08:00:00Z'),
      turn({ id: 'p1', at: '2026-11-01T08:00:10Z', input: 100, output: 100 }),
      turn({ id: 'p2', at: '2026-11-01T08:00:20Z', model: 'mystery-model', input: 100, output: 100 }),
    ]);
    const j = runJson(e);
    assert.deepEqual(j.unpriced, ['mystery-model']);
    assert.ok(Number.isFinite(j.totalUsd));
    assert.equal(j.sessions[0].turns, 2);
    assert.deepEqual(runJson(e, ['--since', '2026-11-02']).unpriced, []);
  } finally { cleanup(e); }
});

test('a truncated last line in sessions.jsonl is skipped and counted', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'one', [opening('2026-11-01T08:00:00Z'), turn({ id: 't1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    runJson(e);
    const store = join(e.evals, 'sessions.jsonl');
    appendFileSync(store, '{"sessionId":"torn","project":"/wo');
    assert.deepEqual([readJsonl(store).rows.length, readJsonl(store).skipped], [1, 1]);
    const j = runJson(e);
    assert.equal(j.skipped, 1);
    assert.deepEqual(j.sessions.map((s) => s.sessionId), ['one']);
    // The next change rewrites the store without the torn line.
    write(e, '-home-me-a', 'two', [opening('2026-11-02T08:00:00Z'), turn({ id: 't2', at: '2026-11-02T08:00:10Z', input: 10, output: 10 })]);
    const k = runJson(e);
    assert.equal(k.sessions.length, 2);
    assert.deepEqual([readJsonl(store).rows.length, readJsonl(store).skipped], [2, 0]);
    assert.ok(readFileSync(store, 'utf8').endsWith('\n'));
  } finally { cleanup(e); }
});

test('two concurrent refreshes keep every session', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-evsess-par-'));
  try {
    const evals = join(base, 'evals');
    const roots = ['a', 'b'].map((k) => join(base, `projects-${k}`));
    const N = 40;
    roots.forEach((r, i) => {
      for (let n = 0; n < N; n++) {
        const dir = join(r, `-proj-${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `s${i}-${n}.jsonl`), `${opening('2026-11-01T08:00:00Z')}\n${turn({ id: `m${i}-${n}`, at: '2026-11-01T08:00:10Z', input: 5, output: 5 })}\n`);
      }
    });
    const child = (root) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [SCRIPT, '--json'], {
        env: { PATH: process.env.PATH, HOME: join(base, 'home'), TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVALS_DIR: evals },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`))));
    });
    await Promise.all(roots.map(child));
    const stored = readJsonl(join(evals, 'sessions.jsonl'));
    assert.equal(stored.skipped, 0);
    assert.equal(new Set(stored.rows.map((r) => r.sessionId)).size, 2 * N);
    assert.equal(stored.rows.length, 2 * N);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('prints no message content', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'q', [opening('2026-11-01T08:00:00Z'), turn({ id: 'q1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    const human = run(e, []);
    assert.equal(human.code, 0, human.err);
    assert.ok(human.out.length > 0);
    assert.ok(!human.out.includes(SENTINEL));
    assert.ok(human.out.includes('q'), 'lists the session id');
    const json = run(e, ['--json']);
    assert.ok(!json.out.includes(SENTINEL));
    assert.ok(!readFileSync(join(e.evals, 'sessions.jsonl'), 'utf8').includes(SENTINEL));
  } finally { cleanup(e); }
});

test('the store is private and bad arguments exit 2', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'q', [opening('2026-11-01T08:00:00Z'), turn({ id: 'q1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    runJson(e);
    assert.equal(statSync(e.evals).mode & 0o777, 0o700);
    assert.equal(statSync(join(e.evals, 'sessions.jsonl')).mode & 0o777, 0o600);
    for (const argv of [['--since', '2026-13-01'], ['--since', '2026-11-05', '--until', '2026-11-01'], ['--bogus'], ['--project']]) {
      const r = run(e, argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.ok(r.err.startsWith('triqual eval sessions:'));
    }
  } finally { cleanup(e); }
});

test('a session\'s arm comes from <evals>/session-arms.jsonl, also on a later run with the transcript unchanged', () => {
  const e = env();
  try {
    write(e, '-home-me-a', 'armed', [opening('2026-11-01T08:00:00Z'), turn({ id: 'r1', at: '2026-11-01T08:00:10Z', input: 10, output: 10 })]);
    assert.equal(runJson(e).sessions[0].arm, null);
    appendFileSync(join(e.evals, 'session-arms.jsonl'), `${JSON.stringify({ sessionId: 'armed', source: 'startup', arm: 'arm-a', launchId: 'l1', at: '2026-11-01T08:00:00.000Z' })}\n`);
    const second = runJson(e);
    assert.equal(second.sessions[0].arm, 'arm-a');
    assert.equal(second.sessions[0].contaminated, false);
    assert.equal(readJsonl(join(e.evals, 'sessions.jsonl')).rows[0].arm, 'arm-a');
  } finally { cleanup(e); }
});
