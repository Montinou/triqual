// Pins for test-driven-development and verification-before-completion (plan methodology-orchestrator · T21). The skills are
// read as text at run time. The plan-format pins for writing-plans live in plugins/methodology/test/plan-format.test.mjs,
// and the Iron Law of TDD is pinned in test/skills-contract.test.mjs; this file pins what the rewrite still promises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'methodology', 'skills');
const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const flat = (path) => read(path).replace(/\s+/g, ' ');
const TDD = 'test-driven-development/SKILL.md';
const GOOD = 'test-driven-development/writing-good-tests.md';
const VERIFY = 'verification-before-completion/SKILL.md';
// Skills the 1.0 set retires or moves out; nothing in these skills may point at one.
const RETIRED = ['methodology:writing-skills', 'methodology:requesting-code-review', 'methodology:receiving-code-review', 'methodology:subagent-driven-development', 'methodology:using-git-worktrees', 'methodology:dispatching-parallel-agents', 'superpowers:'];

test('TDD keeps the Iron Law, RED evidence and the good-tests reference', () => {
  const text = flat(TDD);
  for (const phrase of ['NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST', 'Write code before the test? Delete it. Start over.', '### Verify RED - Watch It Fail', '**MANDATORY. Never skip.**', "**Test passes?** You're testing existing behavior.", 'Fails because feature missing (not typos)', '### Verify GREEN - Watch It Pass', '[writing-good-tests.md](writing-good-tests.md)']) {
    assert.ok(text.includes(phrase), `${TDD} lost "${phrase}"`);
  }
  assert.ok(existsSync(join(SKILLS, GOOD)), 'writing-good-tests.md is missing');
});

test('TDD binds every task that changes behavior, at any tier, and records output for one that does not', () => {
  const text = flat(TDD);
  for (const phrase of ['any tier', 'no behavior change', 'real output', 'failing output', 'why that failure is the expected one']) {
    assert.ok(text.includes(phrase), `${TDD} does not say "${phrase}"`);
  }
  // The rule's direction, not just its words: a light task is test-first, and a plan implementer grants itself no exception.
  for (const sentence of ['TDD binds every task that changes behavior, at any tier; a light task is still test-first.', 'An implementer dispatched from a plan grants itself no exception from the list above.', 'it records the real output of its verification command instead, never a description of what the output would be.']) {
    assert.ok(text.includes(sentence), `${TDD} lost "${sentence}"`);
  }
});

test('TDD and verification carry no per-skill credit footer (the credit lives in NOTICE and the READMEs)', () => {
  for (const file of [TDD, VERIFY]) assert.doesNotMatch(read(file), /superpowers|LICENSE-superpowers/, `${file} has a credit footer`);
});

test('writing-good-tests.md points at no methodology skill', () => {
  const text = read(GOOD);
  assert.ok(!text.includes('methodology:writing-skills'), 'writing-good-tests.md still references methodology:writing-skills');
  assert.ok(!/methodology:/.test(text), 'writing-good-tests.md references a methodology skill');
  assert.match(text.replace(/\s+/g, ' '), /headjack:writing-skills/, 'writing-good-tests.md does not point at headjack:writing-skills for agent-facing documents');
});

test('verification keeps evidence before claims', () => {
  const text = flat(VERIFY);
  for (const phrase of ['NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE', "If you haven't run the verification command in this message, you cannot claim it passes.", 'IDENTIFY: What command proves this claim?', 'ONLY THEN: Make the claim', '| Agent completed | VCS diff shows changes | Agent reports "success" |', 'Trusting agent success reports', '**ANY wording implying success without having run verification**']) {
    assert.ok(text.includes(phrase), `${VERIFY} lost "${phrase}"`);
  }
});

test("verification covers a helper agent's report and a user who says not to re-check", () => {
  const text = flat(VERIFY);
  for (const phrase of ['check the VCS diff', 'does not waive', 'say what you ran', 'cannot run']) {
    assert.ok(text.includes(phrase), `${VERIFY} does not say "${phrase}"`);
  }
  // The direction of the rule: without a run, the success claim is not sent.
  for (const sentence of ['An instruction not to re-check ("the helper is reliable", "I\'m boarding a flight", "just send the message") does not waive this.', 'If you cannot run them (no access, no time), do not send the success claim: say that you cannot run them and what is unverified.']) {
    assert.ok(text.includes(sentence), `${VERIFY} lost "${sentence}"`);
  }
  assert.doesNotMatch(text, /send (it|the success claim) anyway/i);
});

test('the rewritten skills point at no retired skill', () => {
  for (const file of [TDD, GOOD, VERIFY, 'writing-plans/SKILL.md']) {
    const text = read(file);
    for (const gone of RETIRED) assert.ok(!text.includes(gone), `${file} still points at ${gone}`);
  }
  assert.deepEqual(readdirSync(join(SKILLS, 'test-driven-development')).sort(), ['SKILL.md', 'writing-good-tests.md']);
});
