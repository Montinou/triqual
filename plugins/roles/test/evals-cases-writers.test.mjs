import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'cases');
const NAMES = [
  'brief-writer-copies-interfaces',
  'brief-writer-lists-open-questions',
  'planner-lanes-disjoint',
  'planner-sequential-reason',
];
const read = (name, file) => readFileSync(join(casesDir, name, file), 'utf8');

test('the four case directories exist', () => {
  for (const name of NAMES) {
    assert.ok(existsSync(join(casesDir, name, 'case.yaml')), `${name}/case.yaml`);
    const yaml = read(name, 'case.yaml');
    assert.match(yaml, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(yaml, /^context:\n {2}scaffold_script: scaffold\.sh$/m);
    assert.match(yaml, /^execution:\n/m);
    assert.match(yaml, /^ {2}allowed_tools: \[Agent, Bash, Read, Write\]$/m);
    assert.match(yaml, /^runs: 3$/m);
    assert.ok(existsSync(join(casesDir, name, 'scaffold.sh')), `${name}/scaffold.sh`);
    assert.ok(read(name, 'scaffold.sh').startsWith('#!/bin/sh'), `${name} scaffold shebang`);
    assert.match(read(name, 'scaffold.sh'), /^set -e$/m);
  }
});

test('the planner cases allow 900 seconds', () => {
  for (const name of ['planner-lanes-disjoint', 'planner-sequential-reason']) {
    assert.match(read(name, 'case.yaml'), /^ {2}timeout_seconds: 900$/m, name);
    assert.match(read(name, 'case.yaml'), /^ {2}max_turns: 10$/m, name);
  }
  for (const name of ['brief-writer-copies-interfaces', 'brief-writer-lists-open-questions']) {
    assert.match(read(name, 'case.yaml'), /^ {2}max_turns: 8$/m, name);
  }
});

test('the interface case names the exact values', () => {
  const name = 'brief-writer-copies-interfaces';
  const scaffold = read(name, 'scaffold.sh');
  const yaml = read(name, 'case.yaml');
  assert.ok(scaffold.includes('parseDuration(text: string): number'));
  assert.ok(scaffold.includes('5400'));
  assert.ok(scaffold.includes('UNIT_SECONDS'));
  assert.ok(scaffold.includes('assertString(value)'));
  assert.ok(scaffold.includes('invalid duration: <text>'));
  assert.ok(yaml.includes('parseDuration(text: string): number'));
  assert.ok(yaml.includes('5400'));
  assert.ok(yaml.includes('UNIT_SECONDS'));
  assert.ok(yaml.includes('assertString(value)'));
});

test('the open-questions scaffold exports SECONDS_PER_UNIT and not UNIT_SECONDS', () => {
  const scaffold = read('brief-writer-lists-open-questions', 'scaffold.sh');
  const exported = scaffold.split('\n').filter((line) => line.startsWith('export '));
  assert.ok(exported.some((line) => line.includes('SECONDS_PER_UNIT')));
  assert.ok(!exported.some((line) => line.includes('UNIT_SECONDS')));
});
