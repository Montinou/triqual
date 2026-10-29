// The reconcile evidence classifier (design U1): pure proposals from a plan, entries and an injected probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTasks } from '../lib/reconcile-evidence.mjs';

const PLAN = `# Demo Plan Implementation Plan

### Task 1: Engine

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`lib/engine.mjs\`
- Test: \`test/engine.test.mjs\`

- [ ] **Step 1: Write the test**
- [ ] **Step 5: Commit**

\`\`\`bash
git commit -m "feat(demo): engine"
\`\`\`

### Task 2: Wiring

**Depends on:** T1
**Role:** roles:tdd-implementer

**Files:**
- Modify: \`lib/wire.mjs\`
- Test: \`test/wire.test.mjs\`

- [ ] **Step 5: Commit** \`feat(demo): wiring\`

### Task 3: Create only

**Depends on:** T1
**Role:** roles:tdd-implementer

**Files:**
- Create: \`lib/a.mjs\`, \`lib/b.mjs\`
- Modify: \`lib/c.mjs:10-20\`

### Task 4: No files

**Role:** coordinator

Just talk to people.
`;

const DATE = '2026-10-29';
const task = (id, status = 'pending', deps = []) => ({ id, title: id, status, deps });
const ALL = [task('T1'), task('T2', 'pending', ['T1']), task('T3', 'pending', ['T1']), task('T4')];

// A probe whose answers come from the fixture; every call is recorded. `commitsTouching` is optional in the contract:
// the probe has it only when `touching` is given.
function probe({ files = [], adding = () => [], bySubject = () => [], touching } = {}) {
  const calls = [];
  const p = {
    calls,
    fileExists: (path) => { calls.push(['fileExists', path]); return files.includes(path); },
    commitsAdding: (paths, since) => { calls.push(['commitsAdding', paths, since]); return adding(paths, since); },
    commitsBySubject: (s, since) => { calls.push(['commitsBySubject', s, since]); return bySubject(s, since); },
  };
  if (touching) p.commitsTouching = (paths, since) => { calls.push(['commitsTouching', paths, since]); return touching(paths, since); };
  return p;
}
const run = (over = {}) => classifyTasks({
  tasks: ALL, planText: PLAN, planDate: DATE, entries: [], probe: probe(), ...over,
});
const byId = (out, id) => out.find((p) => p.id === id);

test('(a) an entry naming this plan and task with a commit gives high done with that sha', () => {
  const out = run({ entries: [{ stage: 'Plan demo-plan · T1', commit: 'aaa1111' }] });
  assert.deepEqual(byId(out, 'T1'), {
    id: 'T1', to: 'done', confidence: 'high', commit: 'aaa1111', why: byId(out, 'T1').why,
  });
  assert.match(byId(out, 'T1').why, /entry/i);
});

test('(a) a topic of another plan, another task, or no commit does not match', () => {
  for (const entries of [
    [{ stage: 'Plan other-thing · T1', commit: 'aaa1111' }],
    [{ stage: 'Plan demo-plan · T9', commit: 'aaa1111' }],
    [{ stage: 'Plan demo-plan · T1', commit: null }],
    [{ stage: 'Plan plan · T1', commit: 'aaa1111' }], // contained but shorter than 6 characters
    [{ stage: 'off-plan', commit: 'aaa1111' }],
  ]) {
    assert.notEqual(byId(run({ entries }), 'T1').confidence, 'high', JSON.stringify(entries));
  }
});

test('(a) the classifier does not check that the entry commit resolves: the caller passes only resolving entries', () => {
  const p = probe();
  const out = run({ tasks: [task('T1')], probe: p, entries: [{ stage: 'Plan demo-plan · T1', commit: 'not-a-real-sha' }] });
  assert.equal(byId(out, 'T1').confidence, 'high');
  assert.equal(byId(out, 'T1').commit, 'not-a-real-sha');
  assert.deepEqual(p.calls, [], 'rule (a) never asks the probe about the commit');
});

test('(a) with planStem given, an entry for another plan topic does not match, even the plan title', () => {
  const planStem = '2026-10-29-fast-execution';
  for (const stage of ['Plan demo-plan · T1', 'Plan reconcile-and-lean-hunters · T1']) {
    const out = run({ planStem, entries: [{ stage, commit: 'bbb2222' }] });
    assert.notEqual(byId(out, 'T1').confidence, 'high', stage);
  }
  const own = run({ planStem, entries: [{ stage: 'Plan fast-execution · T1', commit: 'bbb2222' }] });
  assert.equal(byId(own, 'T1').confidence, 'high');
});

test('(a) without planStem the plan title is the fallback topic', () => {
  const out = run({ entries: [{ stage: 'Plan Demo Plan · T1', commit: 'bbb2222' }] });
  assert.equal(byId(out, 'T1').confidence, 'high');
});

test('(a) a topic equal to the plan stem without its date, or containing it, matches', () => {
  const planStem = '2026-10-29-reconcile-and-lean-hunters';
  for (const stage of ['Plan reconcile-and-lean-hunters · T1', 'Plan Reconcile And Lean Hunters, part 2 · T1', 'Plan lean-hunters · T1']) {
    const out = run({ planStem, entries: [{ stage, commit: 'bbb2222' }] });
    assert.equal(byId(out, 'T1').confidence, 'high', stage);
    assert.equal(byId(out, 'T1').commit, 'bbb2222');
  }
});

test('(b) a planned commit subject found on a commit gives high done with that sha', () => {
  const p = probe({ bySubject: (s) => (s === 'feat(demo): engine' ? [{ sha: 'ccc3333', subject: s }, { sha: 'old0000', subject: s }] : []) });
  const out = run({ probe: p });
  const t1 = byId(out, 'T1');
  assert.equal(t1.confidence, 'high');
  assert.equal(t1.to, 'done');
  assert.equal(t1.commit, 'ccc3333');
  assert.deepEqual(p.calls.find((c) => c[0] === 'commitsBySubject'), ['commitsBySubject', 'feat(demo): engine', DATE]);
});

test('(b) the commit line of a "Commit `subject`" step is read as well', () => {
  const p = probe({ bySubject: (s) => (s === 'feat(demo): wiring' ? [{ sha: 'ddd4444', subject: s }] : []) });
  const out = run({ tasks: [task('T2')], probe: p });
  assert.equal(byId(out, 'T2').commit, 'ddd4444');
  assert.equal(byId(out, 'T2').confidence, 'high', 'no dependency listed in the ledger task, so none to drop');
});

test('(b) a commit whose subject differs is not a match', () => {
  const p = probe({ bySubject: () => [{ sha: 'eee5555', subject: 'fix(demo): something else' }] });
  assert.notEqual(byId(run({ probe: p }), 'T1').confidence, 'high');
});

test('(c) every Create path present and a commit that added them gives high done with the newest sha', () => {
  const p = probe({
    files: ['lib/a.mjs', 'lib/b.mjs'],
    adding: (paths) => (paths.join() === 'lib/a.mjs,lib/b.mjs' ? [{ sha: 'fff6666' }, { sha: 'old1111' }] : []),
  });
  const out = run({ tasks: [task('T3')], probe: p });
  assert.deepEqual(byId(out, 'T3'), { id: 'T3', to: 'done', confidence: 'high', commit: 'fff6666', why: byId(out, 'T3').why });
  assert.deepEqual(p.calls.find((c) => c[0] === 'commitsAdding'), ['commitsAdding', ['lib/a.mjs', 'lib/b.mjs'], DATE]);
});

test('(c) a missing Create path, or no adding commit, is not high', () => {
  const missing = probe({ files: ['lib/a.mjs'], adding: () => [{ sha: 'fff6666' }] });
  assert.notEqual(byId(run({ tasks: [task('T3')], probe: missing }), 'T3').confidence, 'high');
  const none = probe({ files: ['lib/a.mjs', 'lib/b.mjs'] });
  const t3 = byId(run({ tasks: [task('T3')], probe: none }), 'T3');
  assert.equal(t3.confidence, 'low');
  assert.equal(t3.to, 'keep');
  assert.equal(t3.commit, null);
});

const NO_COMMIT_STEP = PLAN.replace('\n- [ ] **Step 5: Commit** `feat(demo): wiring`', '');

test('(d) a Modify-only task with touching commits stays medium and is kept', () => {
  // A real add-only probe finds nothing for a file that already existed; the touching probe finds the commit.
  const p = probe({ files: ['lib/wire.mjs'], adding: () => [], touching: () => [{ sha: 'abc7777' }] });
  const out = run({ tasks: [task('T2')], planText: NO_COMMIT_STEP, probe: p });
  const t2 = byId(out, 'T2');
  assert.equal(t2.confidence, 'medium');
  assert.equal(t2.to, 'keep');
  assert.equal(t2.commit, 'abc7777');
});

test('(d) a probe without commitsTouching gives low, saying so, never medium from commitsAdding', () => {
  const p = probe({ files: ['lib/wire.mjs'], adding: () => [{ sha: 'abc7777' }] });
  const t2 = byId(run({ tasks: [task('T2')], planText: NO_COMMIT_STEP, probe: p }), 'T2');
  assert.equal(t2.confidence, 'low');
  assert.equal(t2.to, 'keep');
  assert.equal(t2.commit, null);
  assert.match(t2.why, /commitsTouching/);
});

test('(e) a dependency that is not done drops a high task to medium; a done one does not', () => {
  const entries = [{ stage: 'Plan demo-plan · T2', commit: 'a222222' }];
  const pending = byId(run({ entries }), 'T2');
  assert.equal(pending.confidence, 'medium');
  assert.equal(pending.to, 'keep');
  assert.match(pending.why, /T1/);

  const done = byId(run({ entries, tasks: [task('T1', 'done'), task('T2', 'pending', ['T1'])] }), 'T2');
  assert.equal(done.confidence, 'high');
  assert.equal(done.to, 'done');
});

test('(e) a dependency proposed done with high confidence keeps the task high; a medium one drops it', () => {
  const both = [{ stage: 'Plan demo-plan · T1', commit: 'a111111' }, { stage: 'Plan demo-plan · T2', commit: 'a222222' }];
  const out = run({ entries: both });
  assert.equal(byId(out, 'T1').confidence, 'high');
  assert.equal(byId(out, 'T2').confidence, 'high');

  // T1 only medium (touching commits), T2 has its own entry: T2 drops.
  const p = probe({ files: [], touching: () => [{ sha: 'abc7777' }] });
  const out2 = run({ entries: [{ stage: 'Plan demo-plan · T2', commit: 'a222222' }], probe: p });
  assert.equal(byId(out2, 'T1').confidence, 'medium');
  assert.equal(byId(out2, 'T2').confidence, 'medium');
});

test('(f) a task with no Files and no evidence is low and does not throw', () => {
  const t4 = byId(run(), 'T4');
  assert.equal(t4.confidence, 'low');
  assert.equal(t4.to, 'keep');
  assert.equal(t4.commit, null);
  assert.ok(t4.why.length > 0);
});

test('(f) a task missing from the plan text is low, not a crash', () => {
  const out = run({ tasks: [task('T9')] });
  assert.equal(byId(out, 'T9').confidence, 'low');
});

test('(g) a probe that throws gives low with the reason, and the other tasks are still classified', () => {
  const p = probe();
  p.fileExists = () => { throw new Error('git exploded'); };
  p.commitsBySubject = () => { throw new Error('git exploded'); };
  const out = run({ probe: p, entries: [{ stage: 'Plan demo-plan · T4', commit: 'a444444' }] });
  const t3 = byId(out, 'T3');
  assert.equal(t3.confidence, 'low');
  assert.equal(t3.to, 'keep');
  assert.equal(t3.commit, null);
  assert.match(t3.why, /git exploded/);
  assert.equal(byId(out, 'T4').confidence, 'high', 'an entry needs no probe');
});

test('(h) done tasks are skipped; a dropped one is kept; order follows the tasks', () => {
  const out = run({ tasks: [task('T4'), task('T1', 'done'), task('T3', 'dropped')] });
  assert.deepEqual(out.map((p) => p.id), ['T4', 'T3']);
  assert.equal(byId(out, 'T3').to, 'keep');
  assert.equal(byId(out, 'T3').confidence, 'low');
});

test('the planned-commit read stays inside the task own block', () => {
  const p = probe();
  run({ tasks: [task('T3')], probe: p });
  assert.equal(p.calls.some((c) => c[0] === 'commitsBySubject'), false, 'T3 plans no commit; T1 and T2 lines are not its');
});

test('Modify and Test paths strip a line range and are all asked for touching commits', () => {
  const p = probe({ touching: () => [] });
  run({ tasks: [task('T3')], probe: p });
  const touch = p.calls.find((c) => c[0] === 'commitsTouching');
  assert.deepEqual(touch[1], ['lib/a.mjs', 'lib/b.mjs', 'lib/c.mjs']);
});
