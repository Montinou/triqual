// The dispatch prompts and the phase-orchestrator role work in their phase's checkout beside other phases:
// the orchestrator prompt takes the checkout as [PHASE_WORKDIR], the implementer's [WORK_DIR] may be a phase worktree,
// and the role never touches another phase's checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', 'skills', 'executing-plans');
const ORCHESTRATOR = join(SKILL, 'orchestrator-prompt.md');
const IMPLEMENTER = join(SKILL, 'implementer-prompt.md');
const ROLE = join(HERE, '..', '..', 'roles', 'agents', 'phase-orchestrator.md');

// A paragraph or list item as one line: the files wrap their prose.
const flat = (file) => readFileSync(file, 'utf8').replace(/\s+/g, ' ');

test('the orchestrator prompt takes the phase checkout as [PHASE_WORKDIR], used and defined', () => {
  const text = flat(ORCHESTRATOR);
  assert.ok(
    text.includes(
      "so the phase's branch is checked out in [PHASE_WORKDIR], the checkout this phase's tasks built in place and its coordinator tasks use.",
    ),
    'the prompt does not name [PHASE_WORKDIR] as the phase checkout',
  );
  assert.ok(
    text.includes(
      '- `[PHASE_WORKDIR]` — the `workdir:` line `stack.mjs phase` printed for this phase, else the main checkout\'s path',
    ),
    '[PHASE_WORKDIR] has no Placeholders line',
  );
  assert.ok(!text.includes("so HEAD is on the phase's branch"), 'the old HEAD sentence is still there');
});

test('the orchestrator prompt says other phases may run and their checkouts are not its own', () => {
  const text = flat(ORCHESTRATOR);
  assert.ok(
    text.includes(
      'Other phases of the plan may be running beside you, each in its own checkout: never touch one.',
    ),
    'the prompt does not warn about other phases beside it',
  );
});

test('the orchestrator prompt keeps the scripts run from the main checkout', () => {
  const text = flat(ORCHESTRATOR);
  assert.ok(
    text.includes('(`task-open`, `task-prep`, `task-close`) run from the main checkout'),
    'the scripts are no longer run from the main checkout',
  );
  assert.ok(
    text.includes('dispatched with `WORK_DIR` = the `workdir:` `task-open` printed'),
    'a task opened in place in a phase worktree has no WORK_DIR rule',
  );
});

test('[WORK_DIR] names a phase worktree for a task built in place, and the tracking entry landing from there', () => {
  const text = flat(IMPLEMENTER);
  assert.ok(
    text.includes(
      'for a task built in place in a phase worktree, that worktree (`task-open` prints it as `workdir:` too); your tracking entry lands from there',
    ),
    'the [WORK_DIR] line does not name a phase worktree',
  );
  assert.ok(
    text.includes(
      'for a task opened with `task-open --worktree`, the task worktree it printed as `workdir:`, for the implementer and for its fixer',
    ),
    'the pinned task-worktree clause changed',
  );
});

test('the phase-orchestrator role runs beside other orchestrators and never touches their checkouts', () => {
  const text = flat(ROLE);
  assert.ok(
    text.includes(
      "Do not start another phase, do not submit or merge, and do not change the plan. Other phases may run at the same time under their own orchestrators: your phase's tasks built in place and its coordinator tasks use the checkout the main session names for the phase, and you never touch another phase's checkout or its task worktrees.",
    ),
    'the role does not say other phases run beside it',
  );
  for (const pinned of [
    'the Phase check and the phase review stay with the main session',
    'only once every earlier task of the phase is done or dropped and nothing else runs there',
    'one that edits no file you run yourself',
  ]) {
    assert.ok(text.includes(pinned), `the pinned sentence is gone: ${pinned}`);
  }
});

test('no edited file names the concurrent phases reference as a backticked path or a link', () => {
  for (const file of [ORCHESTRATOR, IMPLEMENTER, ROLE]) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /`[^`]*concurrent-phases\.md`|\]\([^)]*concurrent-phases\.md/, file);
  }
});
