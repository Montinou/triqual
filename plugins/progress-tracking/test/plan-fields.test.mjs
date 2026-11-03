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
