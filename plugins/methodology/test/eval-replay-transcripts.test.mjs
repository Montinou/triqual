import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDispatches, subagentActivity } from '../cli/lib/eval-replay-transcripts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay');
const subFile = join(root, 'proj', 'sess1', 'subagents', 'agent-a1b2c3.jsonl');

test('findDispatches keeps the role, dedupes by tool_use id and applies since', () => {
  const ds = findDispatches(root, 'tdd-implementer', { since: '2026-11-19T00:00:00Z' });
  assert.deepEqual(ds.map((d) => d.toolUseId), ['toolu_A', 'toolu_B']);
  assert.equal(ds[0].agentId, 'a1b2c3');
  assert.equal(ds[0].subagentFile, join(root, 'proj', 'sess1', 'subagents', 'agent-a1b2c3.jsonl'));
  assert.equal(ds[1].subagentFile, null); // its agent file is absent
});

test('a repeated tool_use id keeps the first occurrence', () => {
  const [a] = findDispatches(root, 'tdd-implementer', { since: '2026-11-19T00:00:00Z' });
  assert.equal(a.cwd, '/work/a');
  assert.equal(a.description, 'implement T7');
  assert.equal(a.prompt, 'Implement T7 from the brief');
  assert.equal(a.dispatchedAt, '2026-11-20T10:00:00Z');
});

test('a dispatch made inside a subagent transcript is found', () => {
  const nested = findDispatches(root, 'tdd-implementer').find((d) => d.toolUseId === 'toolu_N');
  assert.ok(nested, 'the dispatch in the phase-orchestrator transcript is returned');
  assert.equal(nested.cwd, '/work/orch');
  assert.equal(nested.agentId, 'c3c3c3');
  assert.equal(nested.subagentFile, join(root, 'proj', 'sess1', 'subagents', 'agent-c3c3c3.jsonl'));
});

test('findDispatches returns no dispatches for a missing root', () => {
  assert.deepEqual(findDispatches(join(root, 'does-not-exist'), 'tdd-implementer', {}), []);
});

test('subagentActivity keeps only whole, successful reads, prefixes stripped', () => {
  const a = subagentActivity(subFile);
  assert.deepEqual(a.reads, [{ path: '/tmp/briefs/T7.md', content: '# Brief\nline two\n' }]);
});

test('subagentActivity pairs bash commands with success', () => {
  const a = subagentActivity(subFile);
  assert.deepEqual(a.bashes.map((b) => [b.command, b.ok]), [['npm test', false], ['node --test test/a.test.mjs', true]]);
  assert.ok(a.usd >= 0);
});

// Synthetic transcript lines: a tool use with its result, or just the use when `result` is null.
const line = (rec) => JSON.stringify(rec);
function step(id, name, input, { result = 'ok', error = false, at = '2026-11-20T10:00:00Z', cwd = '/w' } = {}) {
  const use = { type: 'assistant', timestamp: at, cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
  if (result === null) return [line(use)];
  const res = { type: 'user', timestamp: at, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(error ? { is_error: true } : {}) }] }, toolUseResult: {} };
  return [line(use), line(res)];
}
const dispatch = (id, prompt, at) => step(id, 'Agent', { subagent_type: 'roles:tdd-implementer', description: 'T1', prompt }, { at });

function withTranscripts(files, check) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-tr-'));
  try {
    for (const [path, lines] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${lines.join('\n')}\n`);
    }
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a dispatch carries the briefs its dispatcher wrote before it: the latest Write, not edited afterwards, that the prompt names', () => {
  const lines = [
    ...step('w1', 'Write', { file_path: '/b/T7.md', content: 'v1' }),
    ...step('w2', 'Write', { file_path: '/b/T8.md', content: 'edited later' }),
    ...step('e1', 'Edit', { file_path: '/b/T8.md', old_string: 'edited', new_string: 'changed' }),
    ...step('w3', 'Write', { file_path: '/b/T9.md', content: 'first' }),
    ...step('w4', 'Write', { file_path: '/b/T9.md', content: 'second' }),
    ...step('w5', 'Write', { file_path: '/b/T10.md', content: 'refused' }, { error: true }),
    ...step('w6', 'Write', { file_path: '/b/T11.md', content: 'edit failed' }),
    ...step('e2', 'Edit', { file_path: '/b/T11.md', old_string: 'x', new_string: 'y' }, { error: true }),
    ...step('w7', 'Write', { file_path: '/b/unnamed.md', content: 'not in the prompt' }),
    ...dispatch('toolu_1', 'Read /b/T7.md, /b/T8.md, /b/T9.md, /b/T10.md and /b/T11.md', '2026-11-20T10:05:00Z'),
    ...step('w8', 'Write', { file_path: '/b/T12.md', content: 'after the dispatch' }),
    ...dispatch('toolu_2', 'Read /b/T12.md', '2026-11-20T10:06:00Z'),
  ];
  withTranscripts({ 'proj/sess.jsonl': lines }, (root) => {
    const [first, second] = findDispatches(root, 'tdd-implementer');
    assert.deepEqual(first.writes, [{ path: '/b/T7.md', content: 'v1' }, { path: '/b/T9.md', content: 'second' }, { path: '/b/T11.md', content: 'edit failed' }]);
    assert.deepEqual(second.writes, [{ path: '/b/T12.md', content: 'after the dispatch' }]);
  });
});

test('a brief a later successful Bash wrote (>, >>, tee, relative to its cwd) is dropped; a failed or earlier one is not', () => {
  const bash = (id, command, opts) => step(id, 'Bash', { command }, opts);
  const lines = [
    ...step('w1', 'Write', { file_path: '/b/redir.md', content: 'v1' }),
    ...bash('b1', 'echo more > /b/redir.md'),
    ...step('w2', 'Write', { file_path: '/b/append.md', content: 'v1' }),
    ...bash('b2', 'echo more >> "/b/append.md"'),
    ...step('w3', 'Write', { file_path: '/b/tee.md', content: 'v1' }),
    ...bash('b3', 'echo more | tee -a /b/tee.md'),
    ...step('w4', 'Write', { file_path: '/b/rel.md', content: 'v1' }),
    ...bash('b4', "cat >> rel.md <<'EOF'\nmore\nEOF", { cwd: '/b' }),
    ...step('w5', 'Write', { file_path: '/b/cd.md', content: 'v1' }),
    ...bash('b5', 'cd /b && echo more > cd.md', { cwd: '/elsewhere' }),
    ...step('w6', 'Write', { file_path: '/b/failed.md', content: 'v1' }),
    ...bash('b6', 'echo more > /b/failed.md', { error: true }),
    ...step('w7', 'Write', { file_path: '/b/read.md', content: 'v1' }),
    ...bash('b7', 'cat /b/read.md > /tmp/copy.md; echo x 2>&1 | tee /dev/null'),
    ...step('w8', 'Write', { file_path: '/b/quoted.md', content: 'v1' }),
    ...bash('b8', 'echo "a > /b/quoted.md" && grep "tee /b/quoted.md" x'),
    ...bash('b9', 'echo first > /b/before.md'),
    ...step('w9', 'Write', { file_path: '/b/before.md', content: 'after the Bash' }),
    ...dispatch('toolu_1', 'Read /b/redir.md /b/append.md /b/tee.md /b/rel.md /b/cd.md /b/failed.md /b/read.md /b/quoted.md /b/before.md', '2026-11-20T10:05:00Z'),
  ];
  withTranscripts({ 'proj/sess.jsonl': lines }, (root) => {
    const [d] = findDispatches(root, 'tdd-implementer');
    assert.deepEqual(d.writes.map((w) => w.path), ['/b/failed.md', '/b/read.md', '/b/quoted.md', '/b/before.md']);
  });
});

test('briefs written by a phase-orchestrator subagent are carried by the dispatch it makes', () => {
  const lines = [...step('w1', 'Write', { file_path: '/b/T7.md', content: 'v1' }), ...dispatch('toolu_n', 'Read /b/T7.md', '2026-11-20T10:05:00Z')];
  withTranscripts({ 'proj/sess/subagents/agent-aa11.jsonl': lines, 'proj/sess.jsonl': [] }, (root) => {
    const [d] = findDispatches(root, 'tdd-implementer');
    assert.deepEqual(d.writes, [{ path: '/b/T7.md', content: 'v1' }]);
  });
  const none = dispatch('toolu_m', 'Implement T7', '2026-11-20T10:05:00Z');
  withTranscripts({ 'proj/sess.jsonl': none }, (root) => assert.deepEqual(findDispatches(root, 'tdd-implementer')[0].writes, []));
});

test('subagentActivity gives each bash its cwd and the transcript its time span', () => {
  const lines = [
    ...step('b1', 'Bash', { command: 'cat a.md' }, { at: '2026-11-20T10:00:10Z', cwd: '/w/one' }),
    ...step('b2', 'Bash', { command: 'ls' }, { at: '2026-11-20T10:03:00Z', cwd: '/w/two' }),
  ];
  withTranscripts({ 'a.jsonl': lines }, (root) => {
    const a = subagentActivity(join(root, 'a.jsonl'));
    assert.deepEqual(a.bashes.map((b) => b.cwd), ['/w/one', '/w/two']);
    assert.deepEqual(a.span, { from: Date.parse('2026-11-20T10:00:10Z'), to: Date.parse('2026-11-20T10:03:00Z') });
  });
  withTranscripts({ 'b.jsonl': [] }, (root) => assert.equal(subagentActivity(join(root, 'b.jsonl')).span, null));
});
