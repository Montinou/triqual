// Text pins for the concurrent-phases procedure (parallel plans C, phase 3): the main session starts every ready phase,
// one `stack.mjs phase` call after another, then dispatches their orchestrators in one message; a phase that returns is
// ended without waiting for the others; a phase review reads the recorded base and the phase tip. Each check names the
// sentence that carries a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSkillText } from './skill-text.mjs';

const EP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans');
const read = (path) => readFileSync(join(EP, path), 'utf8');
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const SKILL = read('SKILL.md');
const REF = existsSync(join(EP, 'references', 'concurrent-phases.md')) ? read('references/concurrent-phases.md') : '';
const section = (text, heading) => {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `no heading ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};
const para = (text, lead) => {
  const p = text.split(/\n\s*\n/).find((x) => x.startsWith(lead));
  assert.ok(p, `no paragraph that starts with ${lead}`);
  return flat(p);
};

test('the main session starts every ready phase, one stack.mjs phase call each, and dispatches their orchestrators in one message', () => {
  assert.ok(flat(section(SKILL, '## The Process')).includes('starts every ready phase'), 'The Process does not start every ready phase');
  const thin = flat(section(SKILL, '## The Thin Controller'));
  assert.ok(thin.includes('one call each'), 'the Thin Controller does not say one call each');
  assert.ok(thin.includes('in one message'), 'the Thin Controller does not dispatch the orchestrators in one message');
});

test('the stack.mjs phase calls run one after another, and the orchestrators are dispatched only after the last returned', () => {
  const thin = flat(section(SKILL, '## The Thin Controller'));
  assert.ok(thin.includes('one after another, each after the previous one has returned'), 'the Thin Controller lacks the order of the phase calls');
  assert.ok(thin.includes('only then'), 'the Thin Controller lacks "only then"');
  const start = para(REF, '**Start.**');
  assert.ok(start.includes('one after another, each after the previous one has returned'), 'the reference Start paragraph lacks the order of the phase calls');
  assert.ok(start.includes('only then'), 'the reference Start paragraph lacks "only then"');
  assert.doesNotMatch(REF, /phase calls? (?:at once|in parallel|in one message)/, 'the reference runs the phase calls together');
});

test('a phase that returns is ended without waiting for the others, in Claude and in Codex', () => {
  const flatRef = flat(REF);
  assert.ok(flatRef.includes('without waiting for the other running phases'), 'the reference makes a returned phase wait');
  assert.ok(flatRef.includes('`wait_agent`'), 'the reference does not name Codex `wait_agent`');
});

test('one Phase check at a time across phases', () => {
  assert.ok(flat(REF).includes('one Phase check at a time'), 'the reference lacks the one-check rule');
  assert.ok(flat(section(SKILL, '### 7. End the phase')).includes('one Phase check at a time'), 'step 7 lacks the one-check rule');
});

test('a ready phase that is not started gets a Serial line', () => {
  assert.ok(flat(REF).includes('`Serial: P<n> — <reason>`'), 'the reference lacks the Serial line form');
});

test('a phase starts only after the phase review of each of its parents', () => {
  const flatSkill = flat(SKILL);
  assert.ok(flatSkill.includes('A phase never starts before the phase review of each of its parents'), 'step 8 lacks the parents rule');
  assert.doesNotMatch(flatSkill, /The next phase never starts before its predecessor/, 'the predecessor rule stayed');
});

test('the phase review reads the recorded base and the phase tip, never the main checkout HEAD', () => {
  const eight = flat(section(SKILL, '### 8. Review the phase'));
  assert.ok(eight.includes('node scripts/review-package PLAN_FILE PHASE_BASE PHASE_TIP'), 'step 8 package lacks PHASE_TIP');
  assert.doesNotMatch(eight, /review-package PLAN_FILE PHASE_BASE HEAD/, 'step 8 still reviews PHASE_BASE..HEAD');
  assert.ok(eight.includes('`base` of `node scripts/stack.mjs status PLAN_FILE`'), 'step 8 does not read the recorded base');
  const prompt = flat(read('final-review-prompt.md'));
  assert.doesNotMatch(prompt, /previous phase's branch tip/, 'PHASE_RANGE still says the previous phase branch tip');
  assert.ok(prompt.includes("its `base` as `node scripts/stack.mjs status PLAN_FILE` prints it, to its branch tip"), 'PHASE_RANGE lacks the base as status prints it');
});

test("phase close removes only the closing phase's own task worktrees", () => {
  assert.ok(flat(section(SKILL, '### 7. End the phase')).includes("of this phase's own tasks"), "step 7 lacks 'of this phase's own tasks'");
});

test("a HEAD in a command is the phase worktree's, passed as a sha", () => {
  const flatRef = flat(REF);
  assert.ok(flatRef.includes('`git -C <workdir> rev-parse HEAD`'), 'the reference lacks the rev-parse form');
  assert.ok(flatRef.includes("never the main checkout's `HEAD`"), 'the reference lacks the main checkout HEAD rule');
});

test('on BLOCKED the running phases go on to their end and no new phase starts', () => {
  const thin = flat(section(SKILL, '## The Thin Controller'));
  assert.ok(thin.includes('no new phase starts first (phases already running go on to their own end)'), 'On BLOCKED lacks the running-phases rule');
  assert.doesNotMatch(thin, /and nothing else moves first/, 'On BLOCKED still stops everything');
  assert.ok(para(REF, '**A stop.**').includes('no new phase starts until the decision'), 'the reference lacks the stop rule');
});

test('the Fallback runs one phase at a time and ledgers the others as Serial', () => {
  const thin = flat(section(SKILL, '## The Thin Controller'));
  assert.ok(thin.includes('It runs one phase at a time and writes `Serial: P<n> — Fallback runs one phase at a time` for each other ready phase.'), 'the Fallback lacks the one-phase rule');
});

test("the reference lists the procedure's commands, in order", () => {
  const block = /\*\*Commands\.\*\*[^\n]*\n+```text\n([\s\S]*?)\n```/.exec(REF);
  assert.ok(block, 'no fenced block under **Commands**');
  assert.equal(block[1], [
    'node scripts/stack.mjs init PLAN_FILE',
    'node scripts/stack.mjs status PLAN_FILE',
    'node scripts/stack.mjs phase PLAN_FILE N',
    'node scripts/stack.mjs done PLAN_FILE N',
    'node scripts/stack.mjs submit PLAN_FILE N',
    'node scripts/phase-resume PLAN_FILE N',
  ].join('\n'));
  assert.ok(REF.includes('## Concurrent phases'), 'the reference lacks its heading');
  assert.doesNotMatch(REF, /^### .*(?:Start the phase|End the phase|Review the phase)/m, 'the reference has a heading named like a SKILL step');
});

test('SKILL.md points at the reference with a Read pointer', () => {
  assert.ok(SKILL.includes('Read references/concurrent-phases.md when more than one phase is ready, or a phase becomes ready while another is running.'), 'no Read pointer');
  assert.ok(readSkillText(EP).includes('## Concurrent phases'), 'the skill text lacks the reference');
  assert.ok(Buffer.byteLength(SKILL) < 87040, 'SKILL.md is over its byte budget');
});

test('the task-open exit-3 list names the worktree refusal beside an undone task', () => {
  assert.ok(flat(SKILL).includes('cannot open in a worktree while T<m> is undone and waits for its sequential re-run'), 'task-open exit 3 list lacks the refusal');
});

test('the forest line names a join of several parents', () => {
  assert.ok(flat(SKILL).includes(', or a join of several)'), 'Forest does not name a join');
});

const HEAD_RULE =
  'When the phase is built in a phase worktree, every `HEAD` written in a `tier-check` or `review-package` command is the phase worktree\'s commit, passed as a sha (`git -C <workdir> rev-parse HEAD`), never the word `HEAD`.';

test('step 7 tells the orchestrator that HEAD in a tier-check or review-package command is the phase worktree sha', () => {
  const step7 = flat(section(SKILL, '### 7. End the phase'));
  assert.ok(step7.includes(HEAD_RULE), 'step 7 lacks the HEAD rule for a phase worktree');
});

test("step 7's worktree removal is limited to the tasks of this phase", () => {
  const step7 = flat(section(SKILL, '### 7. End the phase'));
  assert.ok(step7.includes('with N a task of this phase'), 'step 7 does not limit the removal loop to this phase\'s tasks');
});
