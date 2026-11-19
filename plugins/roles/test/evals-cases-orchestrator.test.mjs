import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'cases');
const read = (...parts) => readFileSync(join(CASES, ...parts), 'utf8');

const ORCHESTRATOR = {
  'phase-orchestrator-orders-the-loop': ['parallel', 'loop', 'scope'],
  'phase-orchestrator-stops-at-the-breaker': ['blocked', 'halt', 'short'],
};

test('the two case directories exist', () => {
  for (const [dir, graders] of Object.entries(ORCHESTRATOR)) {
    assert.ok(existsSync(join(CASES, dir, 'prompt.md')), `${dir}/prompt.md`);
    for (const g of graders) assert.ok(existsSync(join(CASES, dir, 'graders', `${g}.md`)), `${dir}/graders/${g}.md`);
  }
});

test('both are written exercises that read nothing', () => {
  for (const dir of Object.keys(ORCHESTRATOR)) {
    const prompt = read(dir, 'prompt.md');
    assert.ok(prompt.includes('EXERCISE MODE'), dir);
    assert.match(prompt, /^allowed_tools: \[Agent\]$/m, dir);
    assert.match(prompt, /^max_turns: 6$/m, dir);
    assert.ok(prompt.includes('roles:phase-orchestrator'), dir);
  }
});

test('the loop case names its tasks and tiers', () => {
  const prompt = read('phase-orchestrator-orders-the-loop', 'prompt.md');
  for (const word of ['T4', 'T5', 'T6', 'light', 'standard']) assert.ok(prompt.includes(word), word);
});

test('the breaker case names T5 and round 5 of 5', () => {
  const prompt = read('phase-orchestrator-stops-at-the-breaker', 'prompt.md');
  assert.ok(prompt.includes('T5'));
  assert.ok(prompt.includes('round 5 of 5'));
});
