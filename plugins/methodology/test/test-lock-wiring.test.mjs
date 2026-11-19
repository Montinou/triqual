// The test-lock script, task-close, the prompts, the skill and the author agents name one contract (execution-port, T10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXECUTING = join(PLUGINS, 'methodology', 'skills', 'executing-plans');
const SCRIPT = join(EXECUTING, 'scripts', 'test-lock');
const TASK_CLOSE = join(EXECUTING, 'scripts', 'task-close');
const read = (path) => readFileSync(path, 'utf8');

const NAMES_THE_SCRIPT = {
  'scripts/task-close': TASK_CLOSE,
  'orchestrator-prompt.md': join(EXECUTING, 'orchestrator-prompt.md'),
  'implementer-prompt.md': join(EXECUTING, 'implementer-prompt.md'),
  'SKILL.md': join(EXECUTING, 'SKILL.md'),
  'references/concurrent-phases.md': join(EXECUTING, 'references', 'concurrent-phases.md'),
};
const AUTHORS = ['tdd-implementer', 'complex-implementer', 'review-fixer'];

test('scripts/test-lock exists, has an exec bit, and prints its usage line with no arguments', () => {
  assert.doesNotThrow(() => accessSync(SCRIPT, constants.X_OK));
  const ran = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(ran.status, 1);
  assert.ok(ran.stderr.includes('usage: node test-lock -- COMMAND ARG...'), ran.stderr);
});

for (const [label, path] of Object.entries(NAMES_THE_SCRIPT)) {
  test(`${label} names test-lock`, () => {
    assert.ok(read(path).includes('test-lock'));
  });
}

for (const agent of AUTHORS) {
  test(`${agent} agent says what to do with a test-lock command`, () => {
    assert.ok(read(join(PLUGINS, 'roles', 'agents', `${agent}.md`)).includes('test-lock command'));
  });
}

test('orchestrator-prompt.md and SKILL.md name the busy lock; task-close maps it to exit 75', () => {
  assert.ok(read(NAMES_THE_SCRIPT['orchestrator-prompt.md']).includes('test lock busy'));
  assert.ok(read(NAMES_THE_SCRIPT['SKILL.md']).includes('test lock busy'));
  assert.ok(read(TASK_CLOSE).includes('75'));
});
