import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'skills', 'auditing-performance', 'scripts', 'collect.mjs');
const line = ({ id, model, output }) => JSON.stringify({
  timestamp: new Date().toISOString(), requestId: `r-${id}`,
  message: { id, model, usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

test('cost_by_role keeps every dollar: rows under $0.50 fold into one other row per period', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const session = join(home, 'transcripts', '-x-triqual', 's1');
  mkdirSync(join(session, 'subagents'), { recursive: true });
  // controller: 100k Opus 5.5 output tokens = $2.00; hunter: 1k Haiku 5.5 output tokens = $0.0005
  writeFileSync(`${session}.jsonl`, `${line({ id: 'c1', model: 'claude-opus-5-5', output: 100_000 })}\n`);
  writeFileSync(join(session, 'subagents', 'agent-h.jsonl'), `${line({ id: 'h1', model: 'claude-haiku-5-5', output: 1000 })}\n`);
  writeFileSync(join(session, 'subagents', 'agent-h.meta.json'), JSON.stringify({ agentType: 'roles:hunter' }));
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], { env: { ...process.env, HOME: home, TRIQUAL_TRANSCRIPTS_DIR: join(home, 'transcripts') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(readFileSync(join(out, 'cost_by_role.json'), 'utf8'));
  const other = rows.find((x) => x.role === 'other (<$0.50)');
  assert.ok(other, 'the sub-$0.50 hunter row is kept as other');
  assert.equal(other.runs, 1);
  assert.equal(rows.find((x) => x.role === 'controller').usd, 2);
  assert.ok(rows.every((x) => x.period === 'late'));
});

test('escapes: final-review escapes per window and tier, over the tasks reviewed at that tier', () => {
  const home = mkdtempSync(join(tmpdir(), 'audit-collect-'));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const store = join(home, 'comparisons.jsonl');
  const review = (tier) => JSON.stringify({ v: 2, at: now, kind: 'task-review', tier, declaredTier: tier, fixRounds: 0 });
  writeFileSync(store, [
    review('light'), review('light'), review('heavy'),
    JSON.stringify({ v: 2, at: now, kind: 'final-escapes', escapes: [{ tier: 'light', severity: 'important' }, { tier: 'light', severity: 'minor' }, { tier: 'light', severity: 'critical' }] }),
  ].join('\n'));
  const out = join(home, 'out');
  const r = spawnSync('node', [SCRIPT, '--out', out, '--days', '1'], { env: { ...process.env, HOME: home, ROLE_EVAL_FILE: store, TRIQUAL_TRANSCRIPTS_DIR: join(home, 'none') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(readFileSync(join(out, 'escapes.json'), 'utf8'));
  const light = rows.find((x) => x.period === 'late' && x.tier === 'light');
  assert.deepEqual(light, { period: 'late', tier: 'light', tasks: 2, escapes: 3, important: 2, escapes_per_task: 1.5, important_per_task: 1 });
  assert.deepEqual(rows.find((x) => x.period === 'late' && x.tier === 'heavy'), { period: 'late', tier: 'heavy', tasks: 1, escapes: 0, important: 0, escapes_per_task: 0, important_per_task: 0 });
});
