// The import-free plan reader (lib/plan.mjs): tasks with tiers and line extents, phases, registration rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, PlanError, readTasks, readPhases, validatePlanForRegistration } from '../lib/plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const METHODOLOGY_FIXTURES = join(HERE, '..', '..', 'methodology', 'test', 'fixtures');
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const TIERS_PLAN = read(join(HERE, 'fixtures'), 'tiers-plan.md');
const FENCES = read(METHODOLOGY_FIXTURES, 'fences-plan.md');
const PHASED = read(METHODOLOGY_FIXTURES, 'phased-plan.md');

const throwsPlan = (fn, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof PlanError, `expected PlanError, got ${e && e.constructor && e.constructor.name}`);
  assert.equal(e.code, 2);
  assert.match(e.message, re);
  return true;
});

test('TIERS is the frozen heavy, standard, light list', () => {
  assert.deepEqual([...TIERS], ['heavy', 'standard', 'light']);
  assert.ok(Object.isFrozen(TIERS));
});

test('readTasks reads tier, role, deps and skills', () => {
  const tasks = readTasks(TIERS_PLAN);
  assert.deepEqual(tasks.map((t) => [t.id, t.tier, t.role]), [
    ['T1', 'heavy', 'roles:complex-implementer'],
    ['T2', 'standard', 'roles:tdd-implementer'],
    ['T3', 'light', 'coordinator'],
  ]);
  assert.deepEqual(tasks.map((t) => [t.title, t.deps, t.skills]), [
    ['Heavy work', [], ['s1', 's2']],
    ['Standard work', ['T1'], []],
    ['Light work', ['T1', 'T2'], []],
  ]);
});

test('a missing tier reads as null', () => {
  const [t] = readTasks('### Task 1: A\n\n**Role:** coordinator\n');
  assert.equal(t.tier, null);
});

test('an unknown tier throws PlanError', () => {
  throwsPlan(() => readTasks('### Task 1: A\n**Tier:** light\n\n### Task 2: B\n**Tier:** medium\n'), /T2.*medium/);
});

test('a task ends at the next level 1-3 heading', () => {
  const lines = ['# Plan', '', '### Task 1: A', '**Role:** roles:complex-implementer', '', '- [ ] step', '',
    '## After Merge', '', '**Role:** coordinator', '**Tier:** light', '', '### Task 2: B', 'body', '#### Sub', 'more'];
  const [a, b] = readTasks(lines.join('\n'));
  assert.equal(a.role, 'roles:complex-implementer', 'a field under ## After Merge does not attach to the last task');
  assert.equal(a.tier, null);
  assert.equal(a.start, 3);
  assert.equal(a.end, 7, 'the line before ## After Merge');
  assert.equal(b.start, 13);
  assert.equal(b.end, 16, 'a level-4 heading does not end a task; the last task ends at the last line');
  const [h1] = readTasks('### Task 1: A\nx\n# Top\ny\n');
  assert.deepEqual([h1.start, h1.end], [1, 2]);
});

test('start and end let a brief of start..end include the heading', () => {
  const lines = TIERS_PLAN.split('\n');
  const tasks = readTasks(TIERS_PLAN);
  for (const t of tasks) assert.equal(lines[t.start - 1], `### Task ${t.id.slice(1)}: ${t.title}`);
  const last = tasks.at(-1);
  assert.ok(lines[last.end].startsWith('## After Merge'), 'the line after the last task is the next heading');
});

test('fences are honored', () => {
  const tasks = readTasks(FENCES);
  assert.deepEqual(tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  assert.deepEqual(tasks.map((t) => t.deps), [[], ['T1'], [], ['T3'], [], ['T2', 'T5']]);
  assert.equal(tasks[0].role, 'coordinator');
  const lines = FENCES.split('\n');
  for (const t of tasks) assert.equal(lines[t.start - 1], `### Task ${t.id.slice(1)}: ${t.title}`);
  // Each task runs to the line before the next task's heading (the fence fixture has no other heading).
  tasks.slice(0, -1).forEach((t, i) => assert.equal(t.end, tasks[i + 1].start - 1));
  assert.equal(tasks.at(-1).end, lines.at(-1) === '' ? lines.length - 1 : lines.length);
});

test('an unclosed fence and a duplicate task throw PlanError', () => {
  throwsPlan(() => readTasks('# P\n```\n### Task 1: A\n'), /^unclosed code fence opened at line 2$/);
  throwsPlan(() => readTasks('### Task 1: A\n### Task 1: B\n'), /^duplicate task T1 in plan$/);
});

test('readPhases matches the phases stack.test.mjs asserts for phased-plan.md', () => {
  const { branchPrefix, sensitivePaths, phases } = readPhases(PHASED, 'phased-plan');
  assert.equal(branchPrefix, 'demo');
  assert.deepEqual(sensitivePaths, []);
  // stack.test.mjs: phases.map(p => p.tasks) is [[1, 2], [3]]; the reader carries task ids (T1 ...).
  assert.deepEqual(phases.map((p) => p.tasks), [['T1', 'T2'], ['T3']]);
  assert.deepEqual(phases.map((p) => p.n), [1, 2]);
  assert.deepEqual(phases.map((p) => p.branch), ['demo/01-core', 'demo/02-edge']);
  assert.deepEqual(phases.map((p) => p.prTitle), ['feat: core', 'feat: edge']);
  const [first] = phases;
  assert.equal(first.title, 'Core');
  assert.equal(first.slice, 'S1');
  assert.equal(first.standsAlone, 'core only');
  assert.equal(first.phaseCheck, '`true` → exit 0');
  assert.deepEqual(Object.keys(first), ['n', 'title', 'slice', 'branch', 'prTitle', 'standsAlone', 'phaseCheck', 'tasks']);
});

test('a plan without a branch prefix is one implicit phase', () => {
  const bare = readPhases(PHASED.replace('**Branch prefix:** demo\n', ''), 'phased-plan');
  assert.equal(bare.branchPrefix, 'phased-plan');
  assert.deepEqual(bare.phases.map((p) => [p.n, p.branch, p.title, p.prTitle, p.tasks]),
    [[1, 'phased-plan/01-plan', 'Demo', 'Demo', ['T1', 'T2', 'T3']]]);
  assert.equal(bare.phases[0].phaseCheck, "the repository's full test command");
  assert.equal(bare.phases[0].slice, null);
  const noPhase = readPhases('# Solo Implementation Plan\n\n**Branch prefix:** p\n\n### Task 1: A\n', 'solo');
  assert.deepEqual(noPhase.phases.map((p) => [p.branch, p.title, p.tasks]), [['solo/01-plan', 'Solo', ['T1']]]);
  assert.equal(noPhase.branchPrefix, 'solo');
});

test('**Sensitive paths:** reads a comma list', () => {
  const plan = PHASED.replace('**Branch prefix:** demo\n', '**Branch prefix:** demo\n**Sensitive paths:** a/**, b/*.mjs\n');
  assert.deepEqual(readPhases(plan, 'phased-plan').sensitivePaths, ['a/**', 'b/*.mjs']);
});

test('the branch is the first backticked token, else the first whitespace-free token', () => {
  const phase = (branch) => `# P\n\n**Branch prefix:** p\n\n## Phase 1: X\n\n**PR title:** t\n**Branch:** ${branch}\n\n### Task 1: A\n`;
  assert.equal(readPhases(phase('`p/01-x` (stacked on main)'), 'p').phases[0].branch, 'p/01-x');
  assert.equal(readPhases(phase('p/01-x — note'), 'p').phases[0].branch, 'p/01-x');
  assert.equal(readPhases(phase('p/01-x'), 'p').phases[0].branch, 'p/01-x');
});

test('readPhases rejects a malformed phased plan with PlanError', () => {
  const base = (body) => `# P\n\n**Branch prefix:** p\n\n${body}`;
  throwsPlan(() => readPhases(base('### Task 1: A\n\n## Phase 1: X\n'), 'p'), /task T1 comes before the first phase/);
  throwsPlan(() => readPhases(base('## Phase 2: X\n\n**Branch:** p/02-x\n**PR title:** t\n'), 'p'), /out of order/);
  throwsPlan(() => readPhases(base('## Phase 1: X\n\n**PR title:** t\n'), 'p'), /phase 1 lacks \*\*Branch:\*\*/);
  throwsPlan(() => readPhases(base('## Phase 1: X\n\n**Branch:** p/01-x\n'), 'p'), /phase 1 lacks \*\*PR title:\*\*/);
  throwsPlan(() => readPhases(base('## Phase 1: X\n\n**Branch:** q/01-x\n**PR title:** t\n'), 'p'), /does not start with the branch prefix "p\/"/);
  throwsPlan(() => readPhases(base('## Phase 1: X\n\n**Branch:** p/02-x\n**PR title:** t\n'), 'p'), /must be p\/01-<slug>/);
  throwsPlan(() => readPhases(base('## Phase 1: X\n\n**Branch:** p/01-x\n**PR title:** t\n\n## Other\n\n### Task 1: A\n'), 'p'), /task T1 is outside any phase \(line 12\)/);
});

test('validatePlanForRegistration: tiers are all or none', () => {
  const t = (id, tier, role = null) => ({ id, tier, role });
  assert.equal(validatePlanForRegistration([t('T1', 'heavy'), t('T2', 'light')]), undefined);
  assert.equal(validatePlanForRegistration([t('T1', null), t('T2', null)]), undefined);
  assert.equal(validatePlanForRegistration([]), undefined);
  throwsPlan(() => validatePlanForRegistration([t('T1', 'heavy'), t('T2', null), t('T3', null)]), /T2, T3/);
});

test('validatePlanForRegistration: coordinator requires light and complex-implementer requires heavy', () => {
  const t = (id, tier, role) => ({ id, tier, role });
  throwsPlan(() => validatePlanForRegistration([t('T1', 'standard', 'coordinator')]), /T1.*coordinator.*light/);
  throwsPlan(() => validatePlanForRegistration([t('T1', 'light', 'roles:complex-implementer')]), /T1.*roles:complex-implementer.*heavy/);
  assert.equal(validatePlanForRegistration([t('T1', 'light', 'coordinator'), t('T2', 'heavy', 'roles:complex-implementer'),
    t('T3', 'standard', 'roles:tdd-implementer'), t('T4', 'heavy', null)]), undefined);
  // A tierless plan is tiered at setup: roles alone never fail registration.
  assert.equal(validatePlanForRegistration([t('T1', null, 'coordinator'), t('T2', null, 'roles:complex-implementer')]), undefined);
});

test('plan.mjs imports nothing', () => {
  const src = readFileSync(join(HERE, '..', 'lib', 'plan.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b/m);
});
