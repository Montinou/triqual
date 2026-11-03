// The plan reader's Parent phase field, the forest flag and `Depends on: none` (plan-reader fields, task 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, readPhases, readTasks } from '../lib/plan.mjs';

const throwsPlan = (fn, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof PlanError, `expected PlanError, got ${e && e.constructor && e.constructor.name}`);
  assert.equal(e.code, 2);
  assert.match(e.message, re);
  return true;
});

// A phased plan of `count` phases; parents[n] is the raw `**Parent:**` value of phase n (omitted: no Parent line).
function plan(count, parents = {}) {
  const out = ['# Demo Implementation Plan', '', '**Branch prefix:** demo', ''];
  for (let n = 1; n <= count; n += 1) {
    const nn = String(n).padStart(2, '0');
    out.push(`## Phase ${n}: Part ${n}`, '', `**Branch:** \`demo/${nn}-part\``, `**PR title:** Part ${n}`);
    if (parents[n] !== undefined) out.push(`**Parent:** ${parents[n]}`);
    out.push('', `### Task ${n}: Do ${n}`, '', '**Depends on:** none', '');
  }
  return out.join('\n');
}

const parents = (text) => readPhases(text, 'demo').phases.map((p) => p.parent);
const trunk = { kind: 'trunk', value: null };
const phase = (value) => ({ kind: 'phase', value });

test('parent defaults are linear', () => {
  const r = readPhases(plan(3), 'demo');
  assert.deepEqual(r.phases.map((p) => p.parent), [trunk, phase('P1'), phase('P2')]);
  assert.deepEqual(r.phases.map((p) => p.parentDeclared), [false, false, false]);
  assert.equal(r.forest, false);
});

test('siblings of P1 make a forest', () => {
  const r = readPhases(plan(4, { 2: 'P1', 3: 'P1', 4: 'P1' }), 'demo');
  assert.deepEqual(r.phases.map((p) => p.parent), [trunk, phase('P1'), phase('P1'), phase('P1')]);
  assert.equal(r.forest, true);
});

test('Parent equal to the default stays linear', () => {
  const r = readPhases(plan(3, { 2: 'P1', 3: 'P2' }), 'demo');
  assert.equal(r.forest, false);
  assert.deepEqual(r.phases.map((p) => p.parentDeclared), [false, true, true]);
});

test('branch parent', () => {
  const r = readPhases(plan(2, { 2: '`other/03-x`' }), 'demo');
  assert.deepEqual(r.phases[1].parent, { kind: 'branch', value: 'other/03-x' });
  assert.equal(r.phases[1].parentDeclared, true);
  assert.equal(r.forest, true);
});

test('branch naming a phase of this plan becomes that phase', () => {
  const r = readPhases(plan(3, { 3: '`demo/01-part`' }), 'demo');
  assert.deepEqual(r.phases[2].parent, phase('P1'));
  assert.equal(r.forest, true);
});

test('trunk keyword', () => {
  const r = readPhases(plan(2, { 2: 'trunk' }), 'demo');
  assert.deepEqual(parents(plan(2, { 2: 'trunk' })), [trunk, trunk]);
  assert.equal(r.forest, true);
});

test('Parent errors name the phase', () => {
  throwsPlan(() => readPhases(plan(2, { 2: 'P0' }), 'demo'), /phase 2.*Parent/);
  throwsPlan(() => readPhases(plan(3, { 2: 'P3' }), 'demo'), /phase 2.*Parent/);
  throwsPlan(() => readPhases(plan(2, { 2: 'P2' }), 'demo'), /phase 2.*Parent/);
  throwsPlan(() => readPhases(plan(2, { 2: '' }), 'demo'), /phase 2.*Parent/);
});

test('Parent inside a code fence is ignored', () => {
  const fenced = plan(2).replace('**PR title:** Part 2', '**PR title:** Part 2\n\n```\n**Parent:** trunk\n```');
  const r = readPhases(fenced, 'demo');
  assert.deepEqual(r.phases.map((p) => p.parent), [trunk, phase('P1')]);
  assert.equal(r.forest, false);
  assert.equal(r.phases[1].parentDeclared, false);
});

test('Parent after the first task of a phase is not read', () => {
  const text = plan(2).replace('**Depends on:** none\n\n## Phase 2', '**Depends on:** none\n**Parent:** trunk\n\n## Phase 2');
  assert.equal(readPhases(text, 'demo').forest, false);
});

test('an implicit one-phase plan has a trunk parent and no forest', () => {
  const r = readPhases('# Solo\n\n### Task 1: A\n', 'solo');
  assert.equal(r.forest, false);
  assert.deepEqual(r.phases[0].parent, trunk);
  assert.equal(r.phases[0].parentDeclared, false);
});

test('Depends on: none and NONE read as no dependency', () => {
  const text = '# P\n\n### Task 1: A\n\n**Depends on:** none\n\n### Task 2: B\n\n**Depends on:** NONE\n\n### Task 3: C\n\n**Depends on:** T1, T2\n\n### Task 4: D\n\n**Depends on:** None\n';
  assert.deepEqual(readTasks(text).map((t) => t.deps), [[], [], ['T1', 'T2'], []]);
});

// The Validate phase field and the Landing test header (plan-reader fields, task 3).
// A two-phase plan whose phase 2 carries `fields` (raw lines) after its PR title; `header` goes below the prefix.
function validatePlan(fields, header = []) {
  const text = plan(2).replace('**PR title:** Part 2', ['**PR title:** Part 2', ...fields].join('\n'));
  return header.length ? text.replace('**Branch prefix:** demo\n', `**Branch prefix:** demo\n${header.join('\n')}\n`) : text;
}
const validateOf = (fields) => readPhases(validatePlan(fields), 'demo').phases[1].validate;

test('Validate with workflow only', () => {
  assert.deepEqual(validateOf(['**Validate:** ci']), { workflow: 'ci', compare: null });
});

test('Validate with compare', () => {
  assert.deepEqual(
    validateOf(['**Validate:** playwright-vercel.yml compare=`node tools/cmp.mjs --x`']),
    { workflow: 'playwright-vercel.yml', compare: 'node tools/cmp.mjs --x' },
  );
});

test('Validate: none and no Validate line read as null', () => {
  assert.equal(validateOf(['**Validate:** none']), null);
  const r = readPhases(plan(2), 'demo');
  assert.deepEqual(r.phases.map((p) => p.validate), [null, null]);
  assert.equal(readPhases('# Solo\n\n### Task 1: A\n', 'solo').phases[0].validate, null);
});

test('Validate errors name the phase', () => {
  throwsPlan(() => validateOf(['**Validate:** ci foo=1']), /phase 2.*Validate.*foo/);
  throwsPlan(() => validateOf(['**Validate:** ci reference=none']), /phase 2.*Validate.*unknown key.*reference/);
  throwsPlan(() => validateOf(['**Validate:** ci reference=parent compare=`a`']), /phase 2.*Validate.*unknown key.*reference/);
  throwsPlan(() => validateOf(['**Validate:** ci compare=`a` compare=`b`']), /phase 2.*Validate.*compare/);
  throwsPlan(() => validateOf(['**Validate:** ci compare=node x.mjs']), /phase 2.*Validate.*compare/);
  throwsPlan(() => validateOf(['**Validate:**']), /phase 2.*Validate.*workflow/);
  throwsPlan(() => validateOf(['**Validate:** reference=none']), /phase 2.*Validate.*workflow/);
});

test('Validate inside a code fence or after the first task is not read', () => {
  assert.equal(validateOf(['', '```', '**Validate:** ci', '```']), null);
  const late = plan(2).replace('**Depends on:** none\n\n## Phase 2', '**Depends on:** none\n**Validate:** ci\n\n## Phase 2');
  assert.equal(readPhases(late, 'demo').phases[0].validate, null);
});

test('Landing test read', () => {
  const r = readPhases(validatePlan([], ['**Landing test:** `npx vitest run {files}`']), 'demo');
  assert.equal(r.landingTest, 'npx vitest run {files}');
});

test('Landing test absent is null', () => {
  assert.equal(readPhases(plan(2), 'demo').landingTest, null);
  assert.equal(readPhases('# Solo\n\n### Task 1: A\n', 'solo').landingTest, null);
});

test('Landing test needs {files} exactly once', () => {
  throwsPlan(() => readPhases(validatePlan([], ['**Landing test:** `npx vitest run`']), 'demo'), /Landing test.*\{files\}/);
  throwsPlan(() => readPhases(validatePlan([], ['**Landing test:** `npx vitest {files} {files}`']), 'demo'), /Landing test.*\{files\}/);
});

test('Landing test in an implicit one-phase plan is read', () => {
  const r = readPhases('# Solo\n\n**Landing test:** `node --test {files}`\n\n### Task 1: A\n', 'solo');
  assert.equal(r.landingTest, 'node --test {files}');
  throwsPlan(() => readPhases('# Solo\n\n**Landing test:** `node --test`\n\n### Task 1: A\n', 'solo'), /Landing test/);
});

test('Landing test after the header is not read', () => {
  const bad = '**Landing test:** `node --test`';
  const noHeader = plan(2).replace('### Task 2: Do 2', `### Task 2: Do 2\n\n${bad}`);
  assert.equal(readPhases(noHeader, 'demo').landingTest, null);
  const inPreamble = plan(2).replace('**Branch:** `demo/02-part`', `${bad}\n**Branch:** \`demo/02-part\``);
  assert.equal(readPhases(inPreamble, 'demo').landingTest, null);
  const solo = '# Solo\n\n### Task 1: A\n\n**Landing test:** `node --test`\n';
  assert.equal(readPhases(solo, 'solo').landingTest, null);
});

test('a header Landing test wins over a task-body one', () => {
  const text = validatePlan([], ['**Landing test:** `npx vitest run {files}`']).replace('### Task 2: Do 2', '### Task 2: Do 2\n\n**Landing test:** `node --test`');
  assert.equal(readPhases(text, 'demo').landingTest, 'npx vitest run {files}');
});

test('an empty compare= throws', () => {
  throwsPlan(() => validateOf(['**Validate:** ci compare=``']), /phase 2.*Validate.*compare/);
  throwsPlan(() => validateOf(['**Validate:** ci compare=` `']), /phase 2.*Validate.*compare/);
});

const filesOf = (text) => readTasks(text).map((t) => t.files);

test('files of a task', () => {
  const text = [
    '# Demo', '', '### Task 1: A', '',
    '**Files:**',
    '- Create: `src/new.mjs`',
    '- Modify: `src/old.mjs:123-145`',
    '- Modify: `src/a.mjs`, `src/b.mjs:7`',
    '- Test: test/bare.test.mjs',
    '',
  ].join('\n');
  assert.deepEqual(filesOf(text), [{
    create: ['src/new.mjs'],
    modify: ['src/old.mjs', 'src/a.mjs', 'src/b.mjs'],
    test: ['test/bare.test.mjs'],
  }]);
});

test('a Files line inside a fence is ignored', () => {
  const text = '# Demo\n\n### Task 1: A\n\n```\n- Create: `src/x.mjs`\n```\n\n- Test: `t.test.mjs`\n';
  assert.deepEqual(filesOf(text), [{ create: [], modify: [], test: ['t.test.mjs'] }]);
});

test("a Files line of the next task is not this task's", () => {
  const text = '# Demo\n\n### Task 1: A\n\n- Create: `a.mjs`\n\n### Task 2: B\n\n- Modify: `b.mjs`\n';
  assert.deepEqual(filesOf(text), [
    { create: ['a.mjs'], modify: [], test: [] },
    { create: [], modify: ['b.mjs'], test: [] },
  ]);
});

test('a task without Files has three empty arrays', () => {
  assert.deepEqual(filesOf('# Demo\n\n### Task 1: A\n\n**Depends on:** none\n'), [{ create: [], modify: [], test: [] }]);
});
