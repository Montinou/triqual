import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'cases');

const CASE_ROLE = {
  'safety-reviewer-forbidden-path': 'safety-reviewer',
  'safety-reviewer-clean-diff': 'safety-reviewer',
  'spec-reviewer-missing-requirement': 'spec-reviewer',
  'spec-reviewer-clean-diff': 'spec-reviewer',
};
const NAMES = Object.keys(CASE_ROLE);

const read = (...parts) => readFileSync(join(CASES, ...parts), 'utf8');
const graders = (name) => {
  const dir = join(CASES, name, 'graders');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
};
const frontMatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : '';
};

test('the four case directories exist', () => {
  for (const name of NAMES) {
    assert.ok(existsSync(join(CASES, name, 'prompt.md')), `${name}/prompt.md`);
    const n = graders(name).length;
    assert.ok(n >= 2 && n <= 3, `${name} has ${n} graders`);
  }
});

test('each prompt dispatches its own role', () => {
  for (const name of NAMES) {
    const text = read(name, 'prompt.md');
    const fm = frontMatter(text);
    assert.match(fm, /^max_turns: 6$/m, name);
    assert.match(fm, /^allowed_tools: \[Agent\]$/m, name);
    assert.doesNotMatch(fm, /scaffold_script/, name);
    assert.ok(text.includes(`roles:${CASE_ROLE[name]}`), name);
  }
});

test('each grader has type: llm and a positive weight', () => {
  for (const name of NAMES) {
    for (const g of graders(name)) {
      const fm = frontMatter(read(name, 'graders', g));
      assert.match(fm, /^type: llm$/m, `${name}/${g}`);
      const w = fm.match(/^weight: (\d+)$/m);
      assert.ok(w && Number(w[1]) > 0, `${name}/${g} weight`);
    }
  }
});

test('the planted-defect graders name the defect', () => {
  const forbidden = graders('safety-reviewer-forbidden-path');
  assert.ok(forbidden.length > 0);
  assert.ok(
    forbidden.some((g) => read('safety-reviewer-forbidden-path', 'graders', g).includes('config/production/mailer.json')),
  );
  const missing = graders('spec-reviewer-missing-requirement');
  assert.ok(missing.length > 0);
  assert.ok(
    missing.some((g) => read('spec-reviewer-missing-requirement', 'graders', g).includes('RangeError')),
  );
});

test('the clean cases ask for no blocking finding', () => {
  for (const [name, word] of [
    ['safety-reviewer-clean-diff', 'clean'],
    ['spec-reviewer-clean-diff', 'Approved'],
  ]) {
    const first = graders(name)[0];
    assert.ok(first, name);
    assert.ok(read(name, 'graders', first).includes(word), `${name}/${first}`);
  }
});
