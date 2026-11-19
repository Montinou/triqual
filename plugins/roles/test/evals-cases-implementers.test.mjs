import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'cases');

const NAMES = [
  'tdd-implementer-red-then-green',
  'complex-implementer-idempotent-migration',
  'complex-implementer-escalates-contradiction',
  'review-fixer-fixes-real-finding',
  'review-fixer-refutes-wrong-finding',
];

const read = (name, file) => readFileSync(join(CASES, name, file), 'utf8');

test('the five case directories exist', () => {
  for (const name of NAMES) {
    assert.ok(existsSync(join(CASES, name, 'case.yaml')), `${name}/case.yaml`);
    assert.ok(existsSync(join(CASES, name, 'scaffold.sh')), `${name}/scaffold.sh`);
    assert.match(read(name, 'case.yaml'), new RegExp(`^name: ${name}$`, 'm'));
  }
});

test('every case.yaml allows Agent, Bash, Read, Write and Edit', () => {
  for (const name of NAMES) {
    const yaml = read(name, 'case.yaml');
    assert.match(yaml, /^ {2}allowed_tools: \[Agent, Bash, Read, Write, Edit\]$/m, name);
    assert.match(yaml, /^ {2}max_turns: 14$/m, name);
    assert.match(yaml, /^ {2}timeout_seconds: 600$/m, name);
    assert.match(yaml, /^runs: 3$/m, name);
  }
});

test('every scaffold commits init', () => {
  for (const name of NAMES) {
    const sh = read(name, 'scaffold.sh');
    assert.ok(sh.startsWith('#!/bin/sh\nset -e\n'), name);
    assert.ok(sh.includes('git init -q .'), name);
    assert.ok(sh.includes('git config user.email t@example.invalid'), name);
    assert.ok(sh.includes('git config user.name T'), name);
    assert.ok(sh.includes('git add -A'), name);
    assert.ok(sh.includes('git commit -q -m init'), name);
  }
});

test('the escalation case brief carries both numbers', () => {
  const yaml = read('complex-implementer-escalates-contradiction', 'case.yaml');
  assert.ok(yaml.includes('at most 3 times'));
  assert.ok(yaml.includes('fifth failure'));
});

test("the refutation scaffold's clamp.mjs is correct", () => {
  assert.ok(read('review-fixer-refutes-wrong-finding', 'scaffold.sh').includes('Math.min(Math.max(v, min), max)'));
});

test("the fix scaffold's finding is real", () => {
  const sh = read('review-fixer-fixes-real-finding', 'scaffold.sh');
  const line = sh.split('\n').find((l) => l.includes('export function total'));
  assert.ok(line, 'price.mjs content');
  assert.ok(line.includes('item.price'));
  assert.ok(!line.includes('quantity'));
});
