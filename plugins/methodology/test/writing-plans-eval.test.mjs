// writing-plans asks for the `**Eval:**` line on a task that changes a prompt file. Texts of the skill and the
// replay case it is checked with are pinned, not behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const METHODOLOGY = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(METHODOLOGY, 'skills', 'writing-plans', 'SKILL.md'), 'utf8');
const CASE = join(METHODOLOGY, 'evals', 'cases', 'plan-task-names-eval');

// The text from a heading line to the next heading of the same or a higher level (fence-aware not needed here:
// the headings asked for are outside code fences).
const section = (heading) => {
  const level = /^#+/.exec(heading)[0].length;
  const lines = SKILL.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  assert.ok(start >= 0, `heading ${heading} exists`);
  const out = [lines[start]];
  let fence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^(#+) /.exec(line);
    if (h && h[1].length <= level) break;
    out.push(line);
  }
  return out.join('\n');
};

test('the Task Structure example shows the Eval line', () => {
  const example = section('## Task Structure');
  const lines = example.split('\n').map((l) => l.trim());
  const skills = lines.indexOf('**Skills:** slug-a, slug-b');
  assert.ok(skills >= 0, 'the example keeps the Skills line');
  assert.match(lines[skills + 1], /^\*\*Eval:\*\* <plugin>\/<case>\[, <plugin>\/<case>…\]/);
  assert.match(lines[skills + 1], /only for a task that changes a prompt file/);
});

test('the Eval bullet names the three prompt-file globs and the three plan-lanes faults', () => {
  const bullet = section('## Task Structure').split('\n').find((l) => l.startsWith('- `**Eval:**`'));
  assert.ok(bullet, 'a bullet for **Eval:**');
  for (const glob of ['plugins/*/skills/**/*.md', 'plugins/*/agents/*.md', 'plugins/*/rules/*.md']) {
    assert.ok(bullet.includes(`\`${glob}\``), `names ${glob}`);
  }
  assert.match(bullet, /`Create:` or `Modify:`/);
  assert.match(bullet, /exists or is created by this or an earlier task/);
  assert.match(bullet, /`triqual plan lanes` reports/);
  assert.match(bullet, /a prompt task without it/);
  assert.match(bullet, /a case of another plugin/);
  assert.match(bullet, /a case that does not exist/);
  assert.match(bullet, /task id and the fix/);
  assert.match(bullet, /a code task keeps its `Test:` files/i);
});

test('the test-first paragraph runs triqual eval cases for a prompt task', () => {
  const paragraph = section('## Task Structure').split('\n').find((l) => l.startsWith('Test-first applies'));
  assert.ok(paragraph, 'the test-first paragraph');
  assert.match(paragraph, /a task that changes a prompt replaces the test steps/i);
  assert.match(paragraph, /triqual eval cases plugins\/<plugin> --case <case>/);
  assert.match(paragraph, /fail without the change/);
  assert.match(paragraph, /pass/);
});

test('the Plan Audit section tells the auditor each named case would fail without the change', () => {
  const audit = section('## Plan Audit');
  assert.match(audit, /each named case would fail without the change it covers/);
  assert.match(audit, /a case that would pass on the unchanged prompt does not judge it, and is a finding/);
});

test('the case exists with two graders', () => {
  const prompt = readFileSync(join(CASE, 'prompt.md'), 'utf8');
  assert.match(prompt, /spec-reviewer-missing-requirement/);
  assert.match(prompt, /spec-reviewer-clean-diff/);
  assert.match(prompt, /^---\nmax_turns: 4\nallowed_tools: \[Read, Glob, Grep, Skill\]\n---/);
  assert.ok(!existsSync(join(CASE, 'case.yaml')), 'a prompt.md case, no case.yaml');
  const weight = (name) => {
    const text = readFileSync(join(CASE, 'graders', name), 'utf8');
    assert.match(text, /^---\ntype: llm\n/);
    return Number(/^weight: (\d+)$/m.exec(text)?.[1]);
  };
  assert.equal(weight('names-a-case.md'), 3);
  assert.equal(weight('code-task-keeps-test.md'), 2);
});
