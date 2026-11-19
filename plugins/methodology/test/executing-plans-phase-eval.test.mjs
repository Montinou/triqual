// The Phase check runs the eval cases the phase's tasks name (evals every change, T13): step 7 of
// methodology:executing-plans has one Phase eval bullet, the ledger vocabulary has its line, and the replay case that
// checks the behavior exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = join(PLUGIN, 'skills', 'executing-plans');
const SKILL = join(EP, 'SKILL.md');
const CASE = join(PLUGIN, 'evals', 'cases', 'phase-check-runs-eval-cases');
const MAX_BYTES = 87040;

const skill = () => readFileSync(SKILL, 'utf8');
const bullet = () => {
  const text = skill();
  const start = text.indexOf('- **Phase eval.**');
  assert.ok(start >= 0, 'SKILL.md has a "- **Phase eval.**" bullet');
  const end = text.indexOf('\n', start);
  return text.slice(start, end);
};

test('SKILL.md step 7 has the Phase eval bullet', () => {
  const b = bullet();
  for (const s of [
    'triqual eval cases plugins/<plugin> --case',
    'once per plugin',
    'no call',
    'Eval: P<n> <plugin> <k>/<n> passed <usd>',
    'latest-landed',
  ]) {
    assert.ok(b.includes(s), `the bullet contains ${s}`);
  }
});

test('the bullet comes after "A submitted phase is final" and before "### 8."', () => {
  const text = skill();
  const final = text.indexOf('- **A submitted phase is final:**');
  const phaseEval = text.indexOf('- **Phase eval.**');
  const eight = text.indexOf('### 8.');
  assert.ok(final >= 0 && phaseEval >= 0 && eight >= 0);
  assert.ok(final < phaseEval, 'after "A submitted phase is final"');
  assert.ok(phaseEval < eight, 'before "### 8."');
});

test('ledger-vocabulary.md has the Eval line', () => {
  const text = readFileSync(join(EP, 'references', 'ledger-vocabulary.md'), 'utf8');
  assert.ok(text.includes('`Eval: P<n> <plugin> <k>/<n> passed <usd>`'));
});

test('SKILL.md stays under its byte budget', () => {
  const size = statSync(SKILL).size;
  assert.ok(size < MAX_BYTES, `SKILL.md is ${size} bytes, the budget is under ${MAX_BYTES}`);
});

test('the case exists', () => {
  const graders = readdirSync(join(CASE, 'graders')).filter((f) => f.endsWith('.md')).sort();
  assert.equal(graders.length, 3);
  const weights = graders
    .map((f) => Number(/^weight:\s*(\d+)\s*$/m.exec(readFileSync(join(CASE, 'graders', f), 'utf8'))?.[1]))
    .sort();
  assert.deepEqual(weights, [2, 2, 3]);
  assert.ok(readFileSync(join(CASE, 'prompt.md'), 'utf8').includes('planner-lanes-disjoint'));
});
