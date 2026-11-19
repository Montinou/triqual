import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLanes } from '../lib/plan-lanes.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'plan.mjs');

// phases = [{ parent?, sequential?, tasks: [{ lane?, deps?, files?, create?, eval?, role? }] }]; `files` are Modify: paths, `create` Create: paths,
// `eval` the text after `**Eval:**`; an omitted parent writes `trunk`, `parent: null`
// writes no **Parent:** line; task numbers are global.
function planText(phases, header = []) {
  let n = 0;
  const out = ['# Demo Implementation Plan', '', '**Branch prefix:** demo', ...header, ''];
  phases.forEach((p, i) => {
    out.push(`## Phase ${i + 1}: phase ${i + 1}`, `**Branch:** demo/0${i + 1}-p`, `**PR title:** feat: demo ${i + 1}`);
    if (p.parent !== null) out.push(`**Parent:** ${p.parent ?? 'trunk'}`);
    if (p.sequential) out.push(`**Sequential because:** ${p.sequential}`);
    out.push('');
    for (const t of p.tasks) {
      n += 1;
      out.push(`### Task ${n}: t${n}`, '');
      if (t.lane) out.push(`**Lane:** ${t.lane}`);
      if (t.deps) out.push(`**Depends on:** ${t.deps.join(', ')}`);
      if (t.role) out.push(`**Role:** ${t.role}`);
      if (t.eval !== undefined) out.push(`**Eval:** ${t.eval}`);
      if (t.files || t.create) out.push('**Files:**', ...(t.create ?? []).map((f) => `- Create: \`${f}\``), ...(t.files ?? []).map((f) => `- Modify: \`${f}\``));
      out.push('');
    }
  });
  return `${out.join('\n')}\n`;
}

const lanesOf = (phases, header) => planLanes(planText(phases, header), 'demo');
const codes = (r) => r.violations.map((v) => [v.code, v.phase, v.task]);

const THREE_LANES = [{
  tasks: [
    { lane: 'A', files: ['f1.mjs'] },
    { lane: 'A', deps: ['T1'], files: ['f2.mjs'] },
    { lane: 'B', files: ['f3.mjs'] },
    { lane: 'B', deps: ['T3'], files: ['f4.mjs'] },
    { lane: 'C', files: ['f5.mjs'] },
    { lane: 'C', deps: ['T5'], files: ['f6.mjs'] },
    { lane: 'D', deps: ['T2', 'T4', 'T6'], files: ['f7.mjs'] },
  ],
}];

test('three lanes of two and a closing task: critical path 3, parallelism 7/3', () => {
  const r = lanesOf(THREE_LANES);
  assert.deepEqual([r.phaseRows[0].tasks, r.phaseRows[0].lanes, r.phaseRows[0].criticalPath, r.criticalPath], [7, 4, 3, 3]);
  assert.ok(Math.abs(r.parallelism - 7 / 3) < 1e-12);
  assert.deepEqual(r.violations, []);
});

test('a five-task chain with Sequential because gives parallelism 1 and no violation', () => {
  const reason = 'each task edits what the one before wrote';
  const r = lanesOf([{
    sequential: reason,
    tasks: [{}, { deps: ['T1'] }, { deps: ['T2'] }, { deps: ['T3'] }, { deps: ['T4'] }],
  }]);
  assert.equal(r.phaseRows[0].parallelism, 1);
  assert.equal(r.parallelism, 1);
  assert.equal(r.phaseRows[0].sequential, true);
  assert.equal(r.phaseRows[0].reason, reason);
  assert.deepEqual(r.violations, []);
});

test('no-lanes: two tasks, no lane and no Sequential because', () => {
  const r = lanesOf([{ tasks: [{}, {}] }]);
  assert.deepEqual(codes(r), [['no-lanes', 1, null]]);
  assert.match(r.violations[0].message, /^P1 has 2 tasks and 2 without a \*\*Lane:\*\* line: /);
});

test('no-lanes: three tasks where one has no lane', () => {
  const r = lanesOf([{ tasks: [{ lane: 'A' }, { lane: 'B' }, {}] }]);
  assert.deepEqual(codes(r), [['no-lanes', 1, null]]);
  assert.match(r.violations[0].message, /^P1 has 3 tasks and 1 without a \*\*Lane:\*\* line: lay them out in lanes, or write \*\*Sequential because:\*\* with the fact that forces one chain$/);
});

test('an empty Sequential because line does not excuse a plan from lanes', () => {
  const text = planText([{ tasks: [{}, {}] }]).replace('**Parent:** trunk\n', '**Parent:** trunk\n**Sequential because:**\n');
  const r = planLanes(text, 'demo');
  assert.deepEqual(codes(r), [['no-lanes', 1, null]]);
  assert.equal(r.phaseRows[0].sequential, false);
  assert.equal(r.phaseRows[0].reason, null);
});

test('lane-files: a path in two lanes, also when one writes a line range', () => {
  const r = lanesOf([{ tasks: [{ lane: 'A', files: ['src/a.mjs:10-20'] }, { lane: 'B', files: ['src/a.mjs'] }] }]);
  assert.deepEqual(codes(r), [['lane-files', 1, null]]);
  assert.equal(r.violations[0].message, 'P1 lists src/a.mjs in lanes A, B: give the file one owner lane');
});

test('lane-depends: a Depends on across lanes, and the closing task is exempt', () => {
  const r = lanesOf([{ tasks: [{ lane: 'A' }, { lane: 'B', deps: ['T1'] }, { lane: 'C', deps: ['T1', 'T2'] }] }]);
  assert.deepEqual(codes(r), [['lane-depends', 1, 'T2']]);
  assert.equal(r.violations[0].message, 'T2 (lane B) depends on T1 (lane A): put both in one lane, or make T2 the closing task that depends on every lane');
});

// Two lanes: T1 is lane A, T2 and T3 lane B; T3 reaches into lane A in the middle of lane B, T4 continues lane B.
const TWO_LANES = (t3deps) => [{
  tasks: [
    { lane: 'A' },
    { lane: 'B' },
    { lane: 'B', deps: t3deps },
    { lane: 'B', deps: ['T3'] },
  ],
}];

test('lane-depends: with two lanes a lane-B task depending only on lane A is a violation, and plan lanes exits 1', (t) => {
  const r = lanesOf(TWO_LANES(['T1']));
  assert.deepEqual(codes(r), [['lane-depends', 1, 'T3']]);
  assert.equal(r.violations[0].message, 'T3 (lane B) depends on T1 (lane A): put both in one lane, or make T3 the closing task that depends on every lane');
  const s = setup(t, planText(TWO_LANES(['T1'])));
  assert.equal(s.run().status, 1);
});

test('lane-depends: a convergence task that depends on the other lane and continues its own lane is exempt', () => {
  assert.deepEqual(lanesOf(TWO_LANES(['T1', 'T2'])).violations, []);
});

test('lane-depends: a convergence task continuing lane A with a later task after it is exempt in three lanes', () => {
  const r = lanesOf([{
    tasks: [
      { lane: 'A', files: ['f1.mjs'] },
      { lane: 'A', deps: ['T1'], files: ['f2.mjs'] },
      { lane: 'B', files: ['f3.mjs'] },
      { lane: 'C', files: ['f4.mjs'] },
      { lane: 'A', deps: ['T2', 'T3', 'T4'], files: ['f5.mjs'] },
      { lane: 'A', deps: ['T3', 'T5', 'T4'], files: ['f6.mjs'] },
    ],
  }]);
  assert.deepEqual(r.violations, []);
});

test('false-parent: an independent phase that names another, and none once it says trunk', (t) => {
  const phases = (p2) => [
    { tasks: [{ files: ['a.mjs'] }] },
    { parent: p2, tasks: [{ files: ['b.mjs'] }] },
    { parent: 'P1, P2', tasks: [{ deps: ['T1', 'T2'], files: ['c.mjs'] }] },
  ];
  const r = lanesOf(phases('P1'));
  assert.deepEqual(codes(r), [['false-parent', 2, null], ['false-parent', 3, null]]);
  assert.equal(r.violations[0].message, 'P2 names P1 as a parent but does not need it: write **Parent:** trunk');
  assert.equal(r.violations[1].message, 'P3 names P1 as a parent but does not need it: write **Parent:** P2');
  const dir = mkdtempSync(join(tmpdir(), 'plan-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = join(dir, 'bad.md');
  writeFileSync(bad, planText(phases('P1')));
  assert.equal(spawnSync(process.execPath, [CLI, 'lanes', bad], { encoding: 'utf8' }).status, 1);
  const fixed = lanesOf(phases('trunk'));
  assert.deepEqual(fixed.violations, []);
  const good = join(dir, 'good.md');
  writeFileSync(good, planText(phases('trunk')));
  const ok = spawnSync(process.execPath, [CLI, 'lanes', good], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test('missing-parent: a phase that needs two siblings and names one', () => {
  const phases = (p3) => [
    { tasks: [{}] },
    { tasks: [{}] },
    { parent: p3, tasks: [{ deps: ['T1', 'T2'] }] },
  ];
  const r = lanesOf(phases('P1'));
  assert.ok(codes(r).some(([c, p, t]) => c === 'missing-parent' && p === 3 && t === null), JSON.stringify(codes(r)));
  assert.ok(codes(r).some(([c, p, t]) => c === 'several-tops' && p === null && t === null));
  const missing = r.violations.find((v) => v.code === 'missing-parent');
  assert.equal(missing.message, 'P3 needs P2 but neither names it nor descends from it: write **Parent:** P1, P2');
  assert.deepEqual(lanesOf(phases('P1, P2')).violations, []);
});

test('false-parent: a phase that needs only its grandparent and names its parent', () => {
  const r = lanesOf([
    { tasks: [{}] },
    { parent: 'P1', tasks: [{ deps: ['T1'] }] },
    { parent: 'P2', tasks: [{ deps: ['T1'] }] },
  ]);
  assert.deepEqual(codes(r), [['false-parent', 3, null]]);
  assert.equal(r.violations[0].message, 'P3 names P2 as a parent but does not need it: write **Parent:** P1');
});

test('a coordinator-only phase that depends on a task of P2 needs Parent P2', () => {
  const phases = (p3) => [
    { tasks: [{}] },
    { parent: 'P1', tasks: [{ deps: ['T1'] }] },
    { parent: p3, tasks: [{ deps: ['T2'], role: 'coordinator' }] },
  ];
  assert.ok(codes(lanesOf(phases('trunk'))).some(([c, p]) => c === 'missing-parent' && p === 3));
  assert.deepEqual(lanesOf(phases('P2')).violations, []);
});

test('a branch parent gets no parent violation', () => {
  const r = lanesOf([
    { parent: 'other/03-x', tasks: [{}] },
    { parent: 'P1', tasks: [{ deps: ['T1'] }] },
  ]);
  assert.deepEqual(r.violations, []);
});

test('several-tops: two trunk phases with no phase after them', () => {
  const r = lanesOf([{ tasks: [{ files: ['a.mjs'] }] }, { tasks: [{ files: ['b.mjs'] }] }]);
  assert.deepEqual(codes(r), [['several-tops', null, null]]);
  assert.equal(r.violations[0].message, 'P1, P2 are the parent of no phase: a plan ends in one phase; make the last one a join (**Parent:** P1, P2)');
});

test('a plan with no Parent lines and two chained phases reports no-parent and still parses', () => {
  const r = lanesOf([{ parent: null, tasks: [{}] }, { parent: null, tasks: [{ deps: ['T1'] }] }]);
  assert.deepEqual(codes(r), [['no-parent', 1, null], ['no-parent', 2, null]]);
  assert.match(r.violations[0].message, /^P1 has no \*\*Parent:\*\* line: write \*\*Parent:\*\* trunk$/);
  assert.match(r.violations[1].message, /^P2 has no \*\*Parent:\*\* line: write \*\*Parent:\*\* P1$/);
  assert.deepEqual(r.phaseRows.map((row) => row.parents), [[], [1]]);
});

test('a one-phase plan and an unphased plan get no parent violation and no several-tops', () => {
  const parentCodes = ['no-parent', 'false-parent', 'missing-parent', 'several-tops'];
  const one = lanesOf([{ parent: null, tasks: [{ lane: 'A' }, { lane: 'B' }] }]);
  assert.deepEqual(one.violations, []);
  const unphased = planLanes('# Solo Implementation Plan\n\n### Task 1: a\n\n### Task 2: b\n', 'solo');
  assert.equal(unphased.phases, 1);
  assert.deepEqual(codes(unphased).filter(([c]) => parentCodes.includes(c)), []);
  assert.deepEqual(unphased.phaseRows[0].parents, []);
});

test('a Depends on naming a later task or no task is ignored', () => {
  const r = lanesOf([
    { tasks: [{ lane: 'A', deps: ['T3', 'T9'] }, { lane: 'B' }] },
    { parent: 'P1', tasks: [{ deps: ['T1'] }] },
  ]);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.phaseRows[0].frontier, []);
  assert.equal(r.phaseRows[0].criticalPath, 1);
});

test('a Depends on naming a later task of the same phase is ignored, so it cannot raise lane-depends', () => {
  const r = lanesOf([{ tasks: [{ lane: 'A', deps: ['T2'] }, { lane: 'B' }, { lane: 'C' }] }]);
  assert.deepEqual(r.violations, []);
  assert.equal(r.phaseRows[0].criticalPath, 1);
});

test('the plan critical path is the heaviest path through the phase graph', () => {
  const r = lanesOf([
    { tasks: [{ lane: 'A' }, { lane: 'A', deps: ['T1'] }] },
    { tasks: [{}] },
    { parent: 'P1, P2', tasks: [{ deps: ['T2', 'T3'] }] },
  ]);
  assert.equal(r.criticalPath, 3);
  assert.ok(Math.abs(r.parallelism - 4 / 3) < 1e-12);
  assert.deepEqual(r.phaseRows.map((row) => row.frontier), [[], [], [1, 2]]);
});

test('runnerOnly counts a test-runner reason only without a Landing test', () => {
  const phases = [{ sequential: 'one pytest run covers every task', tasks: [{}, {}] }];
  const without = lanesOf(phases);
  assert.equal(without.runnerOnly, 1);
  assert.equal(without.landingTest, false);
  const withLanding = lanesOf(phases, ['**Landing test:** `npx vitest run {files}`']);
  assert.equal(withLanding.runnerOnly, 0);
  assert.equal(withLanding.landingTest, true);
});

test('a text with no task is not a plan', () => {
  assert.throws(() => planLanes('# Notes\n', 'notes'), { name: 'PlanError', message: 'no ### Task heading: not a plan' });
  assert.throws(() => planLanes('### Task 1: a\n```\n', 'x'), { name: 'PlanError', message: /unclosed code fence/ });
});

// -- the command --

function setup(t, text, name = 'demo.md') {
  const dir = mkdtempSync(join(tmpdir(), 'plan-lanes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, text);
  return { dir, file, run: (...args) => spawnSync(process.execPath, [CLI, 'lanes', file, ...args], { encoding: 'utf8' }) };
}

test('the human output: one row per phase, the plan line, one line per violation', (t) => {
  const ok = setup(t, planText(THREE_LANES));
  const r = ok.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'P1 tasks 7 lanes 4 critical 3 parallelism 2.33',
    'plan tasks 7 phases 1 critical 3 parallelism 2.33 runnerOnly 0',
  ]);
  const seq = setup(t, planText([{ sequential: 'one chain', tasks: [{}, { deps: ['T1'] }] }]));
  assert.ok(seq.run().stdout.split('\n').includes('P1 tasks 2 lanes 0 critical 2 parallelism 1.00 sequential: one chain'));
  const bad = setup(t, planText([{ tasks: [{}, {}] }]));
  const b = bad.run();
  assert.equal(b.status, 1);
  const lines = b.stdout.trimEnd().split('\n');
  assert.ok(lines.at(-1).startsWith('no-lanes: P1 has 2 tasks'), b.stdout);
  assert.ok(lines.includes('plan tasks 2 phases 1 critical 1 parallelism 2.00 runnerOnly 0'));
});

test('--json prints the object with its keys, also on exit 1', (t) => {
  const ok = setup(t, planText(THREE_LANES));
  const r = ok.run('--json');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.endsWith('}\n'));
  const obj = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(obj), ['plan', 'tasks', 'phases', 'parallelism', 'criticalPath', 'runnerOnly', 'landingTest', 'violations', 'phaseRows']);
  assert.deepEqual(Object.keys(obj.phaseRows[0]), ['n', 'tasks', 'lanes', 'sequential', 'reason', 'parents', 'frontier', 'criticalPath', 'parallelism']);
  assert.equal(obj.plan, 'demo');
  assert.equal(r.stdout, `${JSON.stringify(obj, null, 2)}\n`);
  const bad = setup(t, planText([{ tasks: [{}, {}] }]));
  const b = bad.run('--json');
  assert.equal(b.status, 1);
  const parsed = JSON.parse(b.stdout);
  assert.ok(parsed.violations.length > 0);
  assert.deepEqual(Object.keys(parsed.violations[0]), ['code', 'phase', 'task', 'message']);
});

test('a missing file, a file that is not a plan and bad arguments exit 2', (t) => {
  const s = setup(t, '# Notes\n');
  const notPlan = s.run();
  assert.equal(notPlan.status, 2);
  assert.match(notPlan.stderr, /not a plan/);
  const fence = setup(t, '### Task 1: a\n```\n');
  const f = fence.run();
  assert.equal(f.status, 2);
  assert.match(f.stderr, /unclosed code fence/);
  const missing = spawnSync(process.execPath, [CLI, 'lanes', join(s.dir, 'absent.md')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read the plan/);
  const none = spawnSync(process.execPath, [CLI, 'lanes'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: triqual plan lanes/);
  const two = spawnSync(process.execPath, [CLI, 'lanes', s.file, s.file], { encoding: 'utf8' });
  assert.equal(two.status, 2);
  assert.match(two.stderr, /usage: triqual plan lanes/);
  const frob = s.run('--frob');
  assert.equal(frob.status, 2);
  assert.match(frob.stderr, /usage: triqual plan lanes/);
});

test('--help lists the lanes usage after the other two', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: triqual plan generate --template/);
  const at = (s) => help.stdout.indexOf(s);
  assert.ok(at('usage: triqual plan check-collisions') > at('usage: triqual plan generate'));
  assert.ok(at('usage: triqual plan lanes <plan.md> [--json]') > at('usage: triqual plan check-collisions'));
});

// -- the Eval line of prompt tasks --

const PROMPT = 'plugins/roles/agents/tdd-implementer.md';
const CASE_FILE = 'plugins/roles/evals/cases/x/case.yaml';
const evalLanes = (phases, opts) => planLanes(planText(phases), 'demo', opts);
const one = (task) => evalLanes([{ tasks: [task] }]);

test('a task that modifies a prompt file and names no case is eval-missing', () => {
  const r = one({ files: [PROMPT] });
  assert.deepEqual(codes(r), [['eval-missing', 1, 'T1']]);
  assert.equal(r.violations[0].message, `T1 changes the prompt file ${PROMPT} but has no **Eval:** line: add **Eval:** roles/<case>`);
  assert.deepEqual(codes(one({ create: ['plugins/methodology/skills/new/SKILL.md'] })), [['eval-missing', 1, 'T1']]);
  assert.deepEqual(codes(one({ files: [PROMPT], eval: '' })), [['eval-missing', 1, 'T1']]);
});

test('the skills, agents and rules globs count, and plugins/roles/README.md, an evals/cases prompt.md and skills/x/scripts/lib/plan.mjs do not', () => {
  for (const path of ['plugins/p/skills/a/SKILL.md', 'plugins/p/skills/a/b/c.md', 'plugins/p/agents/a.md', 'plugins/p/rules/a.md']) {
    assert.deepEqual(codes(one({ files: [path] })), [['eval-missing', 1, 'T1']], path);
  }
  for (const path of ['plugins/roles/README.md', 'plugins/roles/evals/cases/x/prompt.md', 'plugins/p/skills/x/scripts/lib/plan.mjs', 'plugins/p/agents/sub/a.md', 'plugins/p/rules/sub/a.md', 'plugins/p/skills/a.md.bak']) {
    assert.deepEqual(codes(one({ files: [path] })), [], path);
  }
});

test('a case of another plugin is eval-plugin', () => {
  const r = one({ files: [PROMPT], create: ['plugins/methodology/evals/cases/y/case.yaml'], eval: 'methodology/y' });
  assert.deepEqual(codes(r), [['eval-plugin', 1, 'T1']]);
  assert.equal(r.violations[0].message, 'T1 names methodology/y, but it changes no prompt file of plugin methodology: name a case of the plugin whose prompt it changes');
  assert.deepEqual(codes(one({ eval: 'roles/x' })), [['eval-plugin', 1, 'T1']]);
});

test('a case that does not exist is eval-case, and so is a malformed entry (roles, Roles/A)', () => {
  const r = one({ files: [PROMPT], eval: 'roles/x' });
  assert.deepEqual(codes(r), [['eval-case', 1, 'T1']]);
  assert.equal(r.violations[0].message, 'T1 names roles/x, which does not exist and is not created by this or an earlier task: create it first, or fix the name');
  for (const bad of ['roles', 'Roles/A', 'roles/a/b', 'roles/a_b']) {
    const m = one({ files: [PROMPT], eval: bad });
    assert.deepEqual(codes(m), [['eval-case', 1, 'T1']], bad);
    assert.equal(m.violations[0].message, `T1 names "${bad}", which is not <plugin>/<case>`);
  }
});

test('a case created by this task or an earlier task exists, one created by a later task does not', () => {
  assert.deepEqual(codes(one({ files: [PROMPT], create: [CASE_FILE], eval: 'roles/x' })), []);
  const earlier = evalLanes([{ sequential: 'chain', tasks: [{ create: [CASE_FILE] }, { deps: ['T1'], files: [PROMPT], eval: 'roles/x' }] }]);
  assert.deepEqual(codes(earlier), []);
  const later = evalLanes([{ sequential: 'chain', tasks: [{ files: [PROMPT], eval: 'roles/x' }, { deps: ['T1'], create: [CASE_FILE] }] }]);
  assert.deepEqual(codes(later), [['eval-case', 1, 'T1']]);
  const otherCase = one({ files: [PROMPT], create: ['plugins/roles/evals/cases/xy/case.yaml'], eval: 'roles/x' });
  assert.deepEqual(codes(otherCase), [['eval-case', 1, 'T1']]);
});

test('caseExists true makes an existing case pass, and is asked with the plugin and the case', () => {
  const asked = [];
  const r = one2({ files: [PROMPT], eval: 'roles/x' }, { caseExists: (p, c) => { asked.push([p, c]); return true; } });
  assert.deepEqual(codes(r), []);
  assert.deepEqual(asked, [['roles', 'x']]);
  assert.deepEqual(codes(one2({ files: [PROMPT], eval: 'roles/x' }, { caseExists: () => false })), [['eval-case', 1, 'T1']]);
});
function one2(task, opts) { return evalLanes([{ tasks: [task] }], opts); }

test('backticks, extra spaces, a duplicate entry and a :10-20 range on the modified path are read', () => {
  const r = one({ files: [`${PROMPT}:10-20`], create: [CASE_FILE], eval: '`roles/x` ,   roles/x,  roles/x ' });
  assert.deepEqual(r.violations, []);
  const bad = one({ files: [`${PROMPT}:10-20`], eval: ' roles/y ,roles/y' });
  assert.deepEqual(codes(bad), [['eval-case', 1, 'T1']]);
});

test('the Eval violations come after the lane violations, in plan order', () => {
  const r = evalLanes([{ tasks: [{ files: [PROMPT] }, { files: ['plugins/roles/rules/r.md'], eval: 'roles/zz' }] }]);
  assert.deepEqual(codes(r), [['no-lanes', 1, null], ['eval-missing', 1, 'T1'], ['eval-case', 1, 'T2']]);
});

test('the corrected plan has no violations', () => {
  const r = evalLanes([{
    tasks: [
      { lane: 'A', create: [CASE_FILE] },
      { lane: 'A', deps: ['T1'], files: [PROMPT, 'plugins/roles/rules/r.md'], eval: '`roles/x`' },
      { lane: 'B', files: ['plugins/roles/README.md'] },
      { lane: 'C', deps: ['T2', 'T3'], files: ['plugins/methodology/skills/s/SKILL.md'], create: ['plugins/methodology/evals/cases/m-1/case.yaml'], eval: 'methodology/m-1' },
    ],
  }]);
  assert.deepEqual(r.violations, []);
});

test('a plan with no prompt file has the violations it had before', () => {
  assert.deepEqual(codes(lanesOf(THREE_LANES)), []);
  assert.deepEqual(codes(lanesOf([{ tasks: [{}, {}] }])), [['no-lanes', 1, null]]);
  assert.deepEqual(codes(evalLanes(THREE_LANES, { caseExists: () => false })), []);
});

// -- the Eval check as the command runs it --

const EVAL_PLAN = (name) => planText([{ tasks: [{ files: [PROMPT], eval: name }] }]);
const lanesIn = (file, cwd) => spawnSync(process.execPath, [CLI, 'lanes', file], { encoding: 'utf8', cwd });

function repoWithCase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-lanes-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'plugins', 'roles', 'evals', 'cases', 'x'), { recursive: true });
  return dir;
}

test('plan lanes run in a git repository holding plugins/roles/evals/cases/x/ accepts roles/x, and exits 1 naming eval-case for roles/y', (t) => {
  const repo = repoWithCase(t);
  const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const ok = setup(t, EVAL_PLAN('roles/x'));
  const good = lanesIn(ok.file, repo);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = lanesIn(setup(t, EVAL_PLAN('roles/y')).file, repo);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^eval-case: T1 names roles\/y, which does not exist/m);
});

test('the same plan run from a subdirectory of that repository gives the same result', (t) => {
  const repo = repoWithCase(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' }).status, 0);
  const sub = join(repo, 'plugins', 'roles');
  const good = lanesIn(setup(t, EVAL_PLAN('roles/x')).file, sub);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = lanesIn(setup(t, EVAL_PLAN('roles/y')).file, sub);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^eval-case: T1 names roles\/y/m);
});

test('outside a git repository the current directory is the root', (t) => {
  const dir = repoWithCase(t);
  const good = lanesIn(setup(t, EVAL_PLAN('roles/x')).file, dir);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = lanesIn(setup(t, EVAL_PLAN('roles/y')).file, dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^eval-case: T1 names roles\/y/m);
});

test('the lanes help line mentions the three Eval codes', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  const lanes = help.stdout.slice(help.stdout.indexOf('usage: triqual plan lanes'));
  for (const code of ['eval-missing', 'eval-plugin', 'eval-case']) assert.ok(lanes.includes(code), code);
  assert.ok(/applies to plans written after this release, so an older plan may exit 1 with eval-missing/.test(lanes.replace(/\s+/g, ' ')));
});
