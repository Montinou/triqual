import { test } from 'node:test';
import assert from 'node:assert/strict';
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
