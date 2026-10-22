import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli/cost.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cost.mjs');
const PRICES = JSON.parse(readFileSync(join(dirname(SCRIPT), 'lib', 'prices.json'), 'utf8'));
const SENTINEL = 'zz-message-content-sentinel';

// One assistant line with usage, as Claude Code writes it (the content carries the sentinel, which must never print).
const line = ({ id, req = `r-${id}`, at, model = 'claude-opus-5-5', input = 0, output = 0, read = 0, write = 0, write1h = 0 }) => JSON.stringify({
  type: 'assistant', requestId: req, timestamp: at, cwd: '/secret/path',
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: SENTINEL }],
    usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
      cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h },
    },
  },
});

function withTranscripts(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cm-cost-'));
  const proj = join(root, '-home-me-repo');
  mkdirSync(join(proj, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 'sess-1.jsonl'), [
    line({ id: 'm1', at: '2026-10-10T10:00:00Z', input: 1000, output: 2000, read: 1_000_000, write: 100_000, write1h: 100_000 }),
    line({ id: 'm1', at: '2026-10-10T10:00:00Z', input: 1000, output: 2000 }), // the same message again: counted once
    '{"type":"user","message":{"content":"zz-message-content-sentinel"}}',
    'not json',
    line({ id: 'm2', at: '2026-10-12T10:00:00Z', model: 'some-future-model', input: 5, output: 7 }),
  ].join('\n'));
  writeFileSync(join(proj, 'sess-1', 'subagents', 'agent-a.jsonl'), [
    line({ id: 's1', at: '2026-10-11T10:00:00Z', model: 'claude-haiku-5-5', input: 10, output: 20, read: 30, write: 40 }),
    line({ id: 's2', at: '2026-09-01T10:00:00Z', model: 'claude-haiku-5-5', input: 1, output: 1 }),
  ].join('\n'));
  const other = join(root, '-home-me-other');
  mkdirSync(other);
  writeFileSync(join(other, 'x.jsonl'), line({ id: 'o1', at: '2026-10-10T10:00:00Z', input: 3, output: 3 }));
  return Promise.resolve().then(() => fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function run(argv, root) {
  let out = '';
  let err = '';
  const code = main(argv, {
    env: { TRIQUAL_TRANSCRIPTS_DIR: root }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

test('cost --json sums per model, controller apart from subagents, deduped by message and request', () => withTranscripts((root) => {
  const r = run(['--json', '--project', 'repo'], root);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.projects, ['-home-me-repo']);
  const opus = j.controller['claude-opus-5-5'];
  assert.deepEqual({ ...opus, usd: undefined }, { input: 1000, output: 2000, cacheRead: 1_000_000, cacheWrite: 100_000, messages: 1, usd: undefined });
  const p = PRICES.models['claude-opus-5-5'];
  const expected = (1000 * p.input + 2000 * p.output + 1_000_000 * p.cacheRead + 100_000 * p.cacheWrite1h) / 1e6;
  assert.ok(Math.abs(opus.usd - expected) < 1e-9, `${opus.usd} vs ${expected}`);
  assert.equal(j.controller['some-future-model'].usd, null, 'an unknown model has tokens and no price');
  assert.equal(j.controller['some-future-model'].output, 7);
  assert.equal(j.subagents['claude-haiku-5-5'].input, 11);
  assert.equal(j.unpriced, true);
}));

test('cost --since/--until keep the UTC days in the window; without --project every project counts', () => withTranscripts((root) => {
  const j = JSON.parse(run(['--json', '--since', '2026-10-10', '--until', '2026-10-11'], root).out);
  assert.deepEqual(j.projects.sort(), ['-home-me-other', '-home-me-repo']);
  assert.equal(j.controller['claude-opus-5-5'].input, 1003);
  assert.equal(j.controller['some-future-model'], undefined);
  assert.equal(j.subagents['claude-haiku-5-5'].input, 10);
}));

test('cost text report: per model rows, an estimate label, and never message content or paths', () => withTranscripts((root) => {
  const r = run(['--project', 'repo'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^controller$/m);
  assert.match(r.out, /^subagents$/m);
  assert.match(r.out, /claude-opus-5-5: input 1,000, output 2,000, cache read 1,000,000, cache write 100,000, ~\$/);
  assert.match(r.out, /some-future-model: .* no price/);
  assert.match(r.out, /estimate/i);
  for (const leak of [SENTINEL, '/secret/path', root]) assert.equal(r.out.includes(leak), false, leak);
}));

test('cost: usage errors exit 2; a missing transcripts root reports zeros', () => withTranscripts((root) => {
  for (const argv of [['--since', '2026-9-1'], ['--until', '2026-02-30'], ['--bogus'], ['extra'], ['--plan', 'p.md'], ['--since']]) {
    assert.equal(run(argv, root).code, 2, JSON.stringify(argv));
  }
  const none = run(['--json'], join(root, 'missing'));
  assert.equal(none.code, 0, none.err);
  assert.deepEqual(JSON.parse(none.out).controller, {});
}));

test('cost --help names the flags and the estimate; as a script it exits with main()\'s code', () => {
  const r = run(['--help'], '/nonexistent');
  assert.equal(r.code, 0);
  assert.match(r.out, /triqual cost \[--since YYYY-MM-DD\] \[--until YYYY-MM-DD\] \[--project <text>\] \[--json\]/);
  assert.match(r.out, /TRIQUAL_TRANSCRIPTS_DIR/);
  assert.match(r.out, /prices\.json/);
  const s = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(s.status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
});

test('cost: --since after --until, or --project with no value, exits 2 with one line', () => withTranscripts((root) => {
  for (const argv of [['--since', '2026-10-12', '--until', '2026-10-10'], ['--project'], ['--project', '--json']]) {
    const r = run(argv, root);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.out, '', JSON.stringify(argv));
  }
}));

test('cost: with --since or --until, a record with no timestamp is always left out', () => withTranscripts((root) => {
  writeFileSync(join(root, '-home-me-other', 'nots.jsonl'), line({ id: 'nt', at: undefined, input: 500 }));
  for (const argv of [['--since', '2026-10-10'], ['--until', '2026-10-11'], ['--since', '2026-10-10', '--until', '2026-10-11']]) {
    const j = JSON.parse(run(['--json', '--project', 'other', ...argv], root).out);
    assert.equal(j.controller['claude-opus-5-5'].input, 3, JSON.stringify(argv));
  }
  assert.equal(JSON.parse(run(['--json', '--project', 'other'], root).out).controller['claude-opus-5-5'].input, 503);
}));

test('cost: a model named __proto__ is just a key', () => withTranscripts((root) => {
  writeFileSync(join(root, '-home-me-other', 'proto.jsonl'), line({ id: 'p1', at: '2026-10-10T10:00:00Z', model: '__proto__', input: 9 }));
  const j = JSON.parse(run(['--json', '--project', 'other'], root).out);
  assert.equal(Object.hasOwn(j.controller, '__proto__'), true);
  assert.equal(j.controller.__proto__.input, 9);
}));

test('cost: an unreadable transcript is counted and reported, never silently skipped', { skip: process.getuid?.() === 0 }, () => withTranscripts((root) => {
  const bad = join(root, '-home-me-other', 'bad.jsonl');
  writeFileSync(bad, line({ id: 'b1', at: '2026-10-10T10:00:00Z', input: 1 }));
  chmodSync(bad, 0o000);
  const j = run(['--json', '--project', 'other'], root);
  assert.equal(JSON.parse(j.out).unreadable, 1);
  assert.match(j.err, /^1 transcripts? unreadable/m);
  const t = run(['--project', 'other'], root);
  assert.match(t.err, /1 transcripts? unreadable/);
  assert.equal(JSON.parse(run(['--json', '--project', 'repo'], root).out).unreadable, 0);
}));

// Adds two phase-orchestrator subagents and a hunter subagent, each with its meta file, to the fixture.
function addMetaSubagents(root) {
  const dir = join(root, '-home-me-repo', 'sess-1', 'subagents');
  writeFileSync(join(dir, 'agent-orch.jsonl'), line({ id: 'or1', at: '2026-10-11T10:00:00Z', model: 'claude-sonnet-5-5', input: 100, output: 200 }));
  writeFileSync(join(dir, 'agent-orch.meta.json'), JSON.stringify({ agentType: 'roles:phase-orchestrator' }));
  writeFileSync(join(dir, 'agent-hunt.jsonl'), line({ id: 'hu1', at: '2026-10-11T10:00:00Z', model: 'claude-sonnet-5-5', input: 7, output: 9 }));
  writeFileSync(join(dir, 'agent-hunt.meta.json'), JSON.stringify({ agentType: 'roles:hunter' }));
  writeFileSync(join(dir, 'agent-bare.jsonl'), line({ id: 'or2', at: '2026-10-11T10:00:00Z', model: 'claude-sonnet-5-5', input: 1000, output: 2000 }));
  writeFileSync(join(dir, 'agent-bare.meta.json'), JSON.stringify({ agentType: 'phase-orchestrator' }));
  return dir;
}

test('cost: orchestrator transcripts are counted apart', () => withTranscripts((root) => {
  addMetaSubagents(root);
  const j = JSON.parse(run(['--json', '--project', 'repo'], root).out);
  assert.equal(j.orchestrators['claude-sonnet-5-5'].input, 1100, 'roles:phase-orchestrator and phase-orchestrator both count');
  assert.equal(j.orchestrators['claude-sonnet-5-5'].output, 2200);
  assert.equal(j.subagents['claude-sonnet-5-5'].input, 7, 'a hunter stays a subagent');
  assert.equal(j.subagents['claude-haiku-5-5'].input, 11, 'a subagent with no meta file stays a subagent');
  assert.equal(j.controller['claude-sonnet-5-5'], undefined);
  assert.ok(j.orchestrators['claude-sonnet-5-5'].usd > 0);
  assert.equal(j.unreadable, 0);
}));

test('cost: the text report prints the orchestrators block between controller and subagents', () => withTranscripts((root) => {
  addMetaSubagents(root);
  const r = run(['--project', 'repo'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^controller$[\s\S]*^orchestrators$[\s\S]*^subagents$/m);
  assert.match(r.out, /^orchestrators\n {2}claude-sonnet-5-5: input 1,100, output 2,200, /m);
  assert.match(run([], join(root, 'missing')).out, /^orchestrators\n {2}\(none\)$/m);
}));

test('cost: an unparsable meta file is counted as a subagent and reported unreadable', () => withTranscripts((root) => {
  const dir = addMetaSubagents(root);
  writeFileSync(join(dir, 'agent-orch.meta.json'), '{not json');
  const j = run(['--json', '--project', 'repo'], root);
  const r = JSON.parse(j.out);
  assert.equal(r.unreadable, 1);
  assert.match(j.err, /^1 transcripts? unreadable/m);
  assert.equal(r.orchestrators['claude-sonnet-5-5'].input, 1000, 'only the intact orchestrator meta counts');
  assert.equal(r.subagents['claude-sonnet-5-5'].input, 107, 'the transcript behind the bad meta is a subagent');
}));

test('cost: a missing meta file is a subagent and not unreadable', () => withTranscripts((root) => {
  const j = run(['--json', '--project', 'repo'], root);
  const r = JSON.parse(j.out);
  assert.equal(r.unreadable, 0);
  assert.equal(j.err, '');
  assert.deepEqual(r.orchestrators, {});
  assert.equal(r.subagents['claude-haiku-5-5'].input, 11);
}));
