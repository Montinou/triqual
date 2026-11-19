import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'cases');
const read = (...parts) => readFileSync(join(CASES, ...parts), 'utf8');

const FINALS = {
  'final-adversarial-reviewer-double-conversion': ['defect', 'cross-task', 'verdict'],
  'final-adversarial-reviewer-clean-branch': ['ready', 'triage'],
};
const HUNTERS = ['hunter-finds-off-by-one', 'hunter-clean-diff'];

test('the four case directories exist', () => {
  for (const [dir, graders] of Object.entries(FINALS)) {
    assert.ok(existsSync(join(CASES, dir, 'prompt.md')), `${dir}/prompt.md`);
    for (const g of graders) assert.ok(existsSync(join(CASES, dir, 'graders', `${g}.md`)), `${dir}/graders/${g}.md`);
  }
  for (const dir of HUNTERS) {
    assert.ok(existsSync(join(CASES, dir, 'case.yaml')), `${dir}/case.yaml`);
    assert.ok(existsSync(join(CASES, dir, 'scaffold.sh')), `${dir}/scaffold.sh`);
  }
});

test('the hunter case.yaml files are nested', () => {
  for (const dir of HUNTERS) {
    const yaml = read(dir, 'case.yaml');
    assert.match(yaml, /^schema_version: "1\.0"$/m, dir);
    assert.match(yaml, new RegExp(`^name: ${dir}$`, 'm'), dir);
    assert.match(yaml, /^ {2}scaffold_script: scaffold\.sh$/m, dir);
    assert.match(yaml, /^ {2}max_turns: \d+$/m, dir);
    assert.match(yaml, /^ {2}allowed_tools: \[.+\]$/m, dir);
    assert.ok((yaml.match(/^ {2}- type: llm$/gm) ?? []).length >= 2, `${dir}: at least two llm graders`);
  }
});

test('each scaffold.sh starts #!/bin/sh and set -e', () => {
  for (const dir of HUNTERS) {
    const lines = read(dir, 'scaffold.sh').split('\n');
    assert.equal(lines[0], '#!/bin/sh', dir);
    assert.ok(lines.includes('set -e'), `${dir}: set -e`);
  }
});

test('the planted cases name the defect', () => {
  const defect = read('final-adversarial-reviewer-double-conversion', 'graders', 'defect.md');
  assert.ok(defect.includes('42500'));
  assert.ok(defect.includes('src/cart.mjs'));
  const finds = read('hunter-finds-off-by-one', 'case.yaml');
  assert.ok(finds.includes('drain'));
  assert.ok(finds.includes('i <= n'));
});

test('the clean hunter scaffold uses i < n', () => {
  const scaffold = read('hunter-clean-diff', 'scaffold.sh');
  assert.ok(scaffold.includes('i < n'));
  assert.ok(!scaffold.includes('i <= n'));
});
