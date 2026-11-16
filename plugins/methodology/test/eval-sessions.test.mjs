import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir, evalsDir, experimentsPath, transcriptsRoot } from '../cli/lib/eval-paths.mjs';
import { mainTranscripts, priceOf, sessionSignals } from '../cli/lib/eval-sessions.mjs';

// Per million tokens: input, output, cache read, cache write 5 min, cache write 1 h.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);

const assistant = ({ id, req = `r-${id}`, at, model = 'claude-opus-5-5', input = 0, output = 0, read = 0, write = 0, write1h = 0 }) => ({
  type: 'assistant', requestId: req, timestamp: at,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: 'zz' }],
    usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
      cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h },
    },
  },
});
const jsonl = (recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evsig-'));

test('entrypoint comes from the first record that has one, not from the first record', () => {
  const dir = tmp();
  const file = join(dir, 'sess-ep.jsonl');
  writeFileSync(file, jsonl([
    { type: 'mode', mode: 'default' },
    { type: 'session-owner', sessionId: 'sess-ep' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'user', cwd: '/work/proj', entrypoint: 'cli', timestamp: '2026-11-01T09:59:30.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'user', entrypoint: 'sdk-cli', timestamp: '2026-11-01T10:00:30.000Z', message: { role: 'user', content: 'again' } },
  ]));
  assert.equal(sessionSignals(file, { prices: PRICES }).entrypoint, 'cli');
});

test('entrypoint stays null when no record has one', () => {
  const dir = tmp();
  const file = join(dir, 'sess-none.jsonl');
  writeFileSync(file, jsonl([
    { type: 'mode', mode: 'default' },
    { type: 'user', entrypoint: 7, timestamp: '2026-11-01T09:59:30.000Z', message: { role: 'user', content: 'hi' } },
  ]));
  assert.equal(sessionSignals(file, { prices: PRICES }).entrypoint, null);
});

test('sessionSignals matches hand-computed values', () => {
  const dir = tmp();
  const file = join(dir, 'sess-abc.jsonl');
  writeFileSync(file, jsonl([
    { type: 'queue-operation', entrypoint: 'cli', timestamp: '2026-11-01T09:59:00.000Z' }, // first record: entrypoint, no cwd
    { type: 'user', cwd: '/work/proj', timestamp: '2026-11-01T09:59:30.000Z', message: { role: 'user', content: 'first prompt' } },
    // T1: ctx 100 + 0 + 1000 = 1100
    assistant({ id: 'm1', at: '2026-11-01T10:00:00.000Z', input: 100, output: 50, write: 1000 }),
    // the same message id and request id again (a second content block): counted once
    assistant({ id: 'm1', at: '2026-11-01T10:00:00.000Z', input: 100, output: 50, write: 1000 }),
    { type: 'user', timestamp: '2026-11-01T10:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', timestamp: '2026-11-01T10:00:20.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] } },
    'this line is not json',
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-01T10:01:00.000Z' },
    { type: 'system', subtype: 'stop_hook_summary', hookErrors: ['x'], timestamp: '2026-11-01T10:02:00.000Z' },
    { type: 'system', subtype: 'stop_hook_summary', hookErrors: [], timestamp: '2026-11-01T10:03:00.000Z' },
    { type: 'user', isMeta: true, timestamp: '2026-11-01T10:04:00.000Z', message: { role: 'user', content: 'meta caveat' } },
    // T2 301 s after T1: ctx 10 + 400 + 600 = 1010, write 600 >= 505 -> idle rewrite; 400 at 5 min, 200 at 1 h
    assistant({ id: 'm2', at: '2026-11-01T10:05:01.000Z', input: 10, output: 20, read: 400, write: 600, write1h: 200 }),
    { type: 'user', timestamp: '2026-11-01T10:06:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] } },
    // T3 299 s after T2: ctx 10 + 100 + 890 = 1000, write 89% of ctx but the gap is under 300 s -> not idle; a dated model name
    assistant({ id: 'm3', at: '2026-11-01T10:10:00.000Z', model: 'claude-opus-5-5-20261001', input: 10, output: 30, read: 100, write: 890 }),
    // T4 60 s later: ctx 5 + 2000 + 500 = 2505, write 20% of ctx -> not idle
    assistant({ id: 'm4', at: '2026-11-01T10:11:00.000Z', input: 5, output: 10, read: 2000, write: 500 }),
    { type: 'system', subtype: 'informational', timestamp: '2026-11-01T10:12:00.000Z' },
  ]));
  const s = sessionSignals(file, { prices: PRICES });
  assert.equal(s.sessionId, 'sess-abc');
  assert.equal(s.project, '/work/proj');
  assert.equal(s.entrypoint, 'cli');
  assert.equal(s.start, '2026-11-01T09:59:00.000Z');
  assert.equal(s.end, '2026-11-01T10:12:00.000Z');
  assert.deepEqual(Object.keys(s.models).sort(), ['claude-opus-5-5', 'claude-opus-5-5-20261001']);
  assert.equal(s.models['claude-opus-5-5'].messages, 3);
  assert.equal(s.models['claude-opus-5-5-20261001'].messages, 1);
  // usd per turn (millionths): T1 6400, T2 4120, T3 5110, T4 3120
  near(s.models['claude-opus-5-5'].usd, (6400 + 4120 + 3120) / 1e6);
  near(s.models['claude-opus-5-5-20261001'].usd, 5110 / 1e6);
  near(s.usd, 18750 / 1e6);
  assert.equal(s.turns, 4);
  assert.equal(s.ctxPeak, 2505);
  assert.equal(s.ctxAvg, (1100 + 1010 + 1000 + 2505) / 4);
  assert.equal(s.compactions, 1);
  assert.equal(s.idleRewrites, 1);
  near(s.rewriteUsd, 3600 / 1e6); // 400 * 5 + 200 * 8
  assert.equal(s.stopHookBlocks, 1);
  assert.equal(s.toolErrors, 1);
  assert.equal(s.userMessages, 2); // a string and a text block; tool results and the isMeta record are not prompts
  assert.deepEqual(s.unpriced, []);
  assert.equal(s.arm, null);
  assert.equal(s.contaminated, false);
});

test('an unpriced model is listed in unpriced and its usd is excluded', () => {
  const dir = tmp();
  const file = join(dir, 's.jsonl');
  writeFileSync(file, jsonl([
    assistant({ id: 'a', at: '2026-11-01T10:00:00.000Z', input: 1_000_000 }),
    assistant({ id: 'b', at: '2026-11-01T10:00:05.000Z', model: 'mystery-model', input: 9_000_000, output: 9_000_000 }),
    assistant({ id: 'c', at: '2026-11-01T10:00:06.000Z', model: '<synthetic>', input: 5 }),
  ]));
  const s = sessionSignals(file, { prices: PRICES });
  assert.deepEqual(s.unpriced, ['mystery-model']);
  assert.equal(s.models['mystery-model'].messages, 1);
  assert.equal(s.models['mystery-model'].usd, null);
  near(s.usd, 4); // only the priced model: 1M input tokens at 4
  assert.equal(s.turns, 2);
  assert.equal(s.project, null);
  assert.equal(s.entrypoint, null);
});

test('priceOf strips a date suffix and a [..] suffix', () => {
  assert.equal(priceOf('claude-opus-5-5-20261001', PRICES), PRICES['claude-opus-5-5']);
  assert.equal(priceOf('claude-opus-5-5[1m]', PRICES), PRICES['claude-opus-5-5']);
  assert.equal(priceOf('nope', PRICES), null);
});

test('mainTranscripts skips subagents and -claude-mem dirs', () => {
  const root = tmp();
  mkdirSync(join(root, '-home-me-repo', 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(root, '-home-me-repo', 'sess-1.jsonl'), '');
  writeFileSync(join(root, '-home-me-repo', 'sess-2.jsonl'), '');
  writeFileSync(join(root, '-home-me-repo', 'notes.txt'), '');
  writeFileSync(join(root, '-home-me-repo', 'sess-1', 'subagents', 'agent-a.jsonl'), '');
  writeFileSync(join(root, '-home-me-repo', 'sess-1', 'nested.jsonl'), '');
  mkdirSync(join(root, '-home-me-repo-claude-mem-observer'), { recursive: true });
  writeFileSync(join(root, '-home-me-repo-claude-mem-observer', 'mem.jsonl'), '');
  writeFileSync(join(root, 'stray.jsonl'), '');
  const got = mainTranscripts(root).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(got, [
    { file: join(root, '-home-me-repo', 'sess-1.jsonl'), projectDir: '-home-me-repo' },
    { file: join(root, '-home-me-repo', 'sess-2.jsonl'), projectDir: '-home-me-repo' },
  ]);
  assert.deepEqual(mainTranscripts(join(root, 'missing')), []);
});

test('evalsDir honours TRIQUAL_EVALS_DIR then XDG_DATA_HOME', () => {
  assert.equal(evalsDir({ TRIQUAL_EVALS_DIR: '/x/e', XDG_DATA_HOME: '/x/d' }, '/h'), '/x/e');
  const home = tmp();
  assert.equal(evalsDir({ XDG_DATA_HOME: '/x/d' }, home), join('/x/d', 'triqual', 'evals'));
  assert.equal(evalsDir({}, home), join(home, '.local', 'share', 'triqual', 'evals'));
  assert.equal(experimentsPath({ TRIQUAL_EXPERIMENTS_FILE: '/x/x.json' }, home), '/x/x.json');
  assert.equal(experimentsPath({ XDG_CONFIG_HOME: '/x/c' }, home), join('/x/c', 'triqual', 'experiments.json'));
  assert.equal(experimentsPath({}, home), join(home, '.config', 'triqual', 'experiments.json'));
  assert.equal(transcriptsRoot({ TRIQUAL_TRANSCRIPTS_DIR: '/x/t' }, home), '/x/t');
  assert.equal(transcriptsRoot({}, home), join(home, '.claude', 'projects'));
});

test('ensureDir creates the directory with mode 0700', () => {
  const dir = join(tmp(), 'a', 'b');
  ensureDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  ensureDir(dir); // idempotent
});
