// Pins for systematic-debugging (plan methodology-orchestrator · T22): root cause before any fix, the four phases, the
// stop after three failed fixes, the two skills it hands off to, and no support file that only served upstream's own testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'methodology', 'skills', 'systematic-debugging');
const skill = () => readFileSync(join(DIR, 'SKILL.md'), 'utf8');
const flat = () => skill().replace(/\s*\n\s*/g, ' ');

test('the Iron Law stands: no fix without a root-cause investigation first', () => {
  assert.ok(skill().includes('NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST'));
});

test('the four phases are kept in order', () => {
  const headings = skill().split('\n').filter((l) => /^### Phase \d/.test(l));
  assert.deepEqual(headings.map((h) => h.replace(/^### /, '')), [
    'Phase 1: Root Cause Investigation',
    'Phase 2: Pattern Analysis',
    'Phase 3: Hypothesis and Testing',
    'Phase 4: Implementation',
  ]);
});

test('Phase 4 writes the failing test first, through test-driven-development, then makes one fix, and verifies before claiming success', () => {
  const body = skill();
  const phase4 = body.slice(body.indexOf('### Phase 4: Implementation'), body.indexOf('## Red flags'));
  const items = phase4.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.match(items[0] ?? '', /^1\. \*\*Write the failing test first\*\*/, 'Phase 4 does not start with the failing test');
  assert.ok(items[0].includes('`methodology:test-driven-development`'), 'no hand-off to test-driven-development in the test step');
  assert.match(items[1] ?? '', /^2\. \*\*Make one fix\*\*/, 'the single fix does not come second');
  assert.match(items[2] ?? '', /^3\. \*\*Verify it\*\*/, 'verification does not come third');
  assert.ok(items[2].includes('`methodology:verification-before-completion`'), 'no hand-off to verification-before-completion in the verify step');
});

test('after three failed fixes the architecture is questioned with your human partner before a fourth', () => {
  const text = flat();
  assert.match(text, /3\+? (fixes )?(have )?failed|three (fixes )?(have )?failed|≥ ?3/i, 'the three-failure stop is gone');
  assert.match(text, /architecture/i);
  assert.match(text, /your human partner/);
});

test('every support file the skill names exists, and every support file is named by the skill', () => {
  const text = skill();
  const named = [...text.matchAll(/`((?:[\w-]+)\.(?:md|ts|sh))`/g)].map((m) => m[1]);
  for (const file of named) assert.ok(existsSync(join(DIR, file)), `SKILL.md names ${file}, which does not exist`);
  for (const file of ['root-cause-tracing.md', 'defense-in-depth.md', 'condition-based-waiting.md']) {
    assert.ok(named.includes(file), `SKILL.md does not name ${file}`);
  }
});

test('files that only served upstream\'s own testing are gone', () => {
  const left = readdirSync(DIR).filter((f) => /^(CREATION-LOG\.md|test-pressure-\d+\.md|test-academic\.md)$/.test(f));
  assert.deepEqual(left, []);
});
