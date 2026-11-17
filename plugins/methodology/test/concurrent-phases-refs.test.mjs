// The references of executing-plans name phase worktrees, joins and the `Serial: P<n>` line (parallel plans C, phase 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REFS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans', 'references');
const ref = (name) => readFileSync(join(REFS, `${name}.md`), 'utf8');
const EDITED = ['parallel-tasks', 'forest', 'ledger-vocabulary', 'setup', 'worktrees', 'final-review', 'landing-test', 'initiatives'];

test('parallel-tasks.md no longer says nothing runs in parallel across phases', () => {
  const text = ref('parallel-tasks');
  assert.doesNotMatch(text, /Nothing runs in parallel across phases/);
  assert.ok(text.includes('Phases of a plan may run at the same time, each in its own checkout (see the concurrent phases reference)'));
  assert.ok(text.includes('every rule here is per phase'));
  assert.ok(text.includes('the main checkout below means that worktree, while the scripts still run from the main checkout'));
  assert.ok(text.includes('A phase whose tasks each depend on the one before runs exactly as before.'));
});

test('parallel-tasks.md counts an undone task as built in the main checkout from its Rerun: line', () => {
  const text = ref('parallel-tasks');
  assert.doesNotMatch(text, /a task whose landing was undone counts as built there until its sequential re-run closes/);
  assert.match(text, /a task whose landing was undone counts as built there from its `Rerun:` line until its re-run closes, and blocks no main-checkout open before that/);
});

test('forest.md describes a join of several parents, its join commit and the phase worktree', () => {
  const text = ref('forest');
  assert.ok(text.includes('`**Parent:** P1, P2`'));
  assert.match(text, /`parents`/);
  assert.match(text, /`base`/);
  assert.ok(text.includes('.claude/worktrees/<plan stem>-p<N>'));
  assert.match(text, /`workdir`/);
  assert.match(text, /removed by `done`/);
  assert.match(text, / \+ P<k>/);
  assert.match(text, /join needs every parent submitted/);
  assert.match(text, /its first parent/);
  assert.match(text, /join conflict \(exit 3, nothing created\)/);
  assert.ok(text.includes('A phase that needs the work of two phases names both, `**Parent:** P<k>, P<m>`: it starts at one join commit that merges their tips, and its own range starts after that commit. A phase that needs a branch of another plan merges it on the trunk first and takes `**Parent:** trunk`.'));
  assert.doesNotMatch(text, /A phase has one parent, so a phase that needs the work of two branches is a join/);
});

test('the ledger vocabulary has Serial: P<n> — <reason>', () => {
  assert.ok(ref('ledger-vocabulary').includes('`Serial: P<n> — <reason>` (written by the main session before it leaves a ready phase unstarted)'));
});

test('setup.md and worktrees.md name phase worktrees beside the task worktrees', () => {
  const setup = ref('setup');
  assert.ok(setup.includes('without any request. Phase worktrees are a second exception: `stack.mjs phase` makes `.claude/worktrees/<plan stem>-p<N>` for a phase started while another phase holds the main checkout, and `stack.mjs done` removes it.'));
  assert.ok(setup.includes('With several phases active, `status` gives each active phase its orchestrator with `node scripts/phase-resume PLAN_FILE N` as its resume note'));
  const worktrees = ref('worktrees');
  assert.ok(worktrees.includes('(`task-open --worktree` makes them) and neither are phase worktrees (`stack.mjs phase` makes them)'));
  assert.match(worktrees, /scripts run from the main checkout/);
  assert.match(worktrees, /linked worktree/);
  assert.doesNotMatch(worktrees, /linked worktree: use it/);
});

test('final-review.md runs the seams review on the top branch in the main checkout', () => {
  const text = ref('final-review');
  assert.match(text, /seams review and its fixes run in the main checkout on the top phase's branch/);
  assert.match(text, /`git switch <top branch>` first when it is not checked out there \(a phase worktree is gone after `done`\)/);
});

test("the landing test runs in the phase's checkout", () => {
  const text = ref('landing-test');
  assert.doesNotMatch(text, /with the repository root as the working directory/);
  assert.ok(text.includes("with the phase's checkout as the working directory (the repository root, or the phase worktree)"));
});

test('initiatives.md says a plan keeps its phase worktrees inside its clone', () => {
  assert.ok(ref('initiatives').includes("A plan's own phase worktrees are inside that clone, and its scripts still run from its main checkout."));
});

test('no edited reference names the concurrent phases reference as a backticked path or a link', () => {
  for (const name of EDITED) assert.doesNotMatch(ref(name), /`[^`]*concurrent-phases\.md`|\]\([^)]*concurrent-phases\.md/, name);
});
