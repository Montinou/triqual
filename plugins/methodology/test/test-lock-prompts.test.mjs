// Text pins for the test-lock prose (execution port, task 7): the skill's step 6 and the orchestrator prompt carry the
// rerun rule for a busy lock, step 7 and the concurrent-phases reference run the Phase check through the lock, and the
// orchestrator prompt runs focused tests through it and never deletes a lock file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans');
const read = (path) => readFileSync(join(EP, path), 'utf8');
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const SKILL = flat(read('SKILL.md'));
const REF = flat(read('references/concurrent-phases.md'));
const ORCH = flat(read('orchestrator-prompt.md'));

test('SKILL.md step 6 and the orchestrator prompt carry the rerun rule', () => {
  const rule =
    'a `task-close` that ends `test lock busy` is rerun as is once the lock is free; never undo it, and close no other task of the phase first';
  assert.ok(SKILL.includes(rule), 'SKILL.md lacks the rerun rule');
  assert.ok(ORCH.includes(rule), 'orchestrator-prompt.md lacks the rerun rule');
  assert.ok(SKILL.includes('**Test lock busy.**'), 'SKILL.md lacks the Test lock busy paragraph');
  assert.ok(
    SKILL.indexOf('**Test lock busy.**') < SKILL.indexOf('**Reopened tasks.**'),
    'the paragraph is not before Reopened tasks',
  );
});

test('step 7 and the concurrent-phases reference keep one Phase check at a time and name test-lock', () => {
  const clause =
    'one Phase check at a time across phases, enforced by running it as `node <scripts>/test-lock -- <command argv>` (a Phase check that is a shell compound runs as `node <scripts>/test-lock -- sh -c \'<command>\'`)';
  for (const [name, text] of [['SKILL.md', SKILL], ['concurrent-phases.md', REF]]) {
    assert.ok(text.includes('one Phase check at a time'), `${name} lost one Phase check at a time`);
    assert.ok(text.includes(clause), `${name} lacks the test-lock clause`);
  }
});

test('the orchestrator prompt runs focused tests through test-lock and never deletes a lock', () => {
  assert.ok(ORCH.includes('test-lock --'), 'no test-lock -- command');
  assert.ok(ORCH.includes('never delete a lock'), 'no never delete a lock');
  assert.ok(ORCH.includes('busy lock'), 'no busy lock report');
});
