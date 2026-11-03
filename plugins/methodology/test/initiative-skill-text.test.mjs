// Text pins for the initiative features (forest, SSH remotes, child repository, validation, landing test, resume):
// executing-plans links each reference, names the scripts, and the vocabulary and parallel-tasks rules carry the
// new lines. The README names the same features. Each check names the sentence that carries a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = join(PLUGIN, 'skills', 'executing-plans');
const README = join(PLUGIN, '..', '..', 'README.md');
const SKILL = readFileSync(join(EP, 'SKILL.md'), 'utf8');
const ref = (name) => readFileSync(join(EP, 'references', name), 'utf8');

test('executing-plans links every initiative reference and each one exists', () => {
  for (const name of ['forest.md', 'ssh-remotes.md', 'child-repo.md', 'validation.md', 'landing-test.md', 'initiatives.md']) {
    assert.ok(SKILL.includes(`references/${name}`), `SKILL.md links references/${name}`);
    assert.ok(existsSync(join(EP, 'references', name)), `references/${name} exists`);
  }
});

test('The Process runs validate after submit and names phase-resume and status --tree', () => {
  const process = SKILL.slice(SKILL.indexOf('## The Process'), SKILL.indexOf('## Role Dispatch'));
  const submit = process.indexOf('stack.mjs submit PLAN_FILE N`');
  assert.ok(submit >= 0, 'The Process names submit');
  assert.ok(process.indexOf('scripts/validate', submit) > submit, 'validate comes after submit in The Process');
  assert.ok(SKILL.includes('scripts/phase-resume'), 'SKILL.md names scripts/phase-resume');
  assert.ok(SKILL.includes('status PLAN_FILE --tree'), 'SKILL.md names status --tree');
  for (const script of ['validate', 'phase-resume']) {
    assert.ok(existsSync(join(EP, 'scripts', script)), `scripts/${script} exists`);
  }
});

test('the ledger vocabulary carries the lines of initiatives.md', () => {
  const vocabulary = ref('ledger-vocabulary.md');
  for (const line of ['`Validation: P<n> run <id> verdict <clean|failed> — <url>`', '`Validation fix: P<n> <sha> — <finding>`',
    '`Phase fix: P<n> round <k> <sha> — <findings>`', '`Ruling: candidate <id> confirmed without a reviewer round — <why>`', 'phase-<n>-report.md']) {
    assert.ok(vocabulary.includes(line), `ledger-vocabulary.md has ${line}`);
    assert.ok(ref('initiatives.md').includes(line), `initiatives.md has ${line}`);
  }
});

test('parallel-tasks says a Landing test lifts the node-only rule', () => {
  const text = ref('parallel-tasks.md').replace(/\s*\n\s*/g, ' ');
  assert.match(text, /`\*\*Landing test:\*\*` line lifts the node-only rule/, 'parallel-tasks.md: a **Landing test:** line lifts the node-only rule');
  assert.ok(text.includes('references/landing-test.md') || text.includes('landing-test.md'), 'parallel-tasks.md points to landing-test.md');
});

test('the README names the initiative features on the plan row', () => {
  const readme = readFileSync(README, 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith('| `triqual plan generate'));
  assert.ok(row, 'the plan row is there');
  for (const needle of ['check-collisions', 'child-repo', 'validate', 'landing-test', 'phase-resume']) {
    assert.ok(row.includes(needle), `the plan row names ${needle}`);
  }
});
