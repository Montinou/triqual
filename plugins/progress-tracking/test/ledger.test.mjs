import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LedgerError, parsePlan, createLedger, reconcile, transition, statusLine, checkSchema, checkLedger, renderSection, upsertStatusSection,
  parseExternalCommit,
} from '../lib/ledger.mjs';
import { TASK_ROLES, DEFAULT_ROLE, TIERS, roleOf } from '../lib/roles.mjs';
import { TIERS as PLAN_TIERS } from '../lib/plan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// docs/plans/ exists only in the private checkout (its root carries .githooks/pre-commit).
const isPrivateCheckout = existsSync(join(REPO_ROOT, '.githooks', 'pre-commit'));

const T0 = '2026-09-28T10:00:00Z';
const T1 = '2026-09-28T11:00:00Z';

const PLAN = `# Example plan

Intro text. **Depends on:** T9 (before any task: ignored)

### Task 1: First thing
Some text.

### Task 2: Second: with a colon
**Skills:**

### Task 3: Third thing
**Depends on:** T1, T2
**Skills:** jules-pr-reviews ,  skill-b

### Notes
**Depends on:** T7
`;

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

// A ledger with T1..T3 from PLAN (T3 depends on T1 and T2), all pending.
const fresh = () => createLedger({
  plan: 'docs/plans/2026-09-28-example.md', spec: 'docs/specs/x-design.md', branch: 'feat/x',
  tasks: parsePlan(PLAN), now: T0,
});
// Force one task into a status (test setup only), without touching history.
const withStatus = (ledger, id, status, extra = {}) => ({
  ...ledger,
  tasks: ledger.tasks.map((t) => (t.id === id ? { ...t, status, ...extra } : t)),
});
const task = (ledger, id) => ledger.tasks.find((t) => t.id === id);
const lastHistory = (ledger, id) => task(ledger, id).history.at(-1);
const throwsLedger = (fn, re) => assert.throws(fn, (e) => {
  assert.ok(e instanceof LedgerError, `expected LedgerError, got ${e && e.constructor && e.constructor.name}`);
  assert.equal(e.code, 2);
  assert.match(e.message, re);
  return true;
});

test('parsePlan reads headings, deps and skills', () => {
  assert.deepEqual(parsePlan(PLAN), [
    { id: 'T1', title: 'First thing', deps: [], skills: [], role: null, tier: null },
    { id: 'T2', title: 'Second: with a colon', deps: [], skills: [], role: null, tier: null },
    { id: 'T3', title: 'Third thing', deps: ['T1', 'T2'], skills: ['jules-pr-reviews', 'skill-b'], role: null, tier: null },
  ]);
});

test('parsePlan rejects duplicate task numbers', () => {
  throwsLedger(() => parsePlan('### Task 1: A\n\n### Task 2: B\n\n### Task 1: C\n'), /^duplicate task T1 in plan$/);
});

test('createLedger builds the §6.2 schema', () => {
  const l = fresh();
  assert.deepEqual(Object.keys(l), ['version', 'plan', 'spec', 'branch', 'state', 'tasks']);
  assert.equal(l.version, 1);
  assert.equal(l.state, 'active');
  assert.equal(l.plan, 'docs/plans/2026-09-28-example.md');
  assert.equal(l.spec, 'docs/specs/x-design.md');
  assert.equal(l.branch, 'feat/x');
  assert.deepEqual(l.tasks[2], {
    id: 'T3', title: 'Third thing', status: 'pending', deps: ['T1', 'T2'], skills: ['jules-pr-reviews', 'skill-b'],
    role: null, tier: null, effectiveTier: null, commits: [], reason: null, history: [{ at: T0, from: null, to: 'pending', note: null }],
  });
});

// One test per row of the spec §6.2 transition table, plus restore and retitle.
test('transition table: start from pending and from blocked (clears reason)', () => {
  const r1 = transition(fresh(), 'start', 'T1', null, T1);
  assert.equal(r1.changed, true);
  assert.equal(task(r1.ledger, 'T1').status, 'in_progress');
  assert.deepEqual(lastHistory(r1.ledger, 'T1'), { at: T1, from: 'pending', to: 'in_progress', note: null });
  assert.equal(task(r1.ledger, 'T1').reason, null);

  const blocked = withStatus(fresh(), 'T1', 'blocked', { reason: 'waiting' });
  const r2 = transition(blocked, 'start', 'T1', null, T1);
  assert.equal(task(r2.ledger, 'T1').status, 'in_progress');
  assert.deepEqual(lastHistory(r2.ledger, 'T1'), { at: T1, from: 'blocked', to: 'in_progress', note: null });
  assert.equal(task(r2.ledger, 'T1').reason, null);
});

test('transition table: start allowed when deps are done or dropped', () => {
  let l = withStatus(fresh(), 'T1', 'done');
  l = withStatus(l, 'T2', 'dropped', { reason: 'n/a' });
  const r = transition(l, 'start', 'T3', null, T1);
  assert.equal(task(r.ledger, 'T3').status, 'in_progress');
});

test('transition table: review in_progress -> in_review', () => {
  const r = transition(withStatus(fresh(), 'T1', 'in_progress'), 'review', 'T1', null, T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T1').status, 'in_review');
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'in_progress', to: 'in_review', note: null });
  assert.equal(task(r.ledger, 'T1').reason, null);
});

test('transition table: rework in_review -> in_progress', () => {
  const r = transition(withStatus(fresh(), 'T1', 'in_review'), 'rework', 'T1', null, T1);
  assert.equal(task(r.ledger, 'T1').status, 'in_progress');
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'in_review', to: 'in_progress', note: null });
  assert.equal(task(r.ledger, 'T1').reason, null);
});

test('transition table: done from in_progress and in_review records the sha, replacing a reopened task\'s ids', () => {
  const r1 = transition(withStatus(fresh(), 'T1', 'in_progress'), 'done', 'T1', 'abc1234', T1);
  assert.equal(task(r1.ledger, 'T1').status, 'done');
  assert.deepEqual(task(r1.ledger, 'T1').commits, ['abc1234']);
  assert.deepEqual(lastHistory(r1.ledger, 'T1'), { at: T1, from: 'in_progress', to: 'done', note: null });
  assert.equal(task(r1.ledger, 'T1').reason, null);

  const r2 = transition(withStatus(fresh(), 'T1', 'in_review', { commits: ['old0001'] }), 'done', 'T1', 'def5678', T1);
  assert.equal(task(r2.ledger, 'T1').status, 'done');
  assert.deepEqual(task(r2.ledger, 'T1').commits, ['def5678']);
  assert.deepEqual(lastHistory(r2.ledger, 'T1'), { at: T1, from: 'in_review', to: 'done', note: null });
});

test('transition table: block from pending, in_progress and in_review stores the reason', () => {
  for (const from of ['pending', 'in_progress', 'in_review']) {
    const r = transition(withStatus(fresh(), 'T1', from), 'block', 'T1', 'waiting on API', T1);
    assert.equal(task(r.ledger, 'T1').status, 'blocked');
    assert.equal(task(r.ledger, 'T1').reason, 'waiting on API');
    assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from, to: 'blocked', note: 'waiting on API' });
  }
  throwsLedger(() => transition(fresh(), 'block', 'T1', '', T1), /T1/);
  throwsLedger(() => transition(fresh(), 'block', 'T1', null, T1), /T1/);
});

test('transition table: drop from pending and blocked stores the reason', () => {
  for (const from of ['pending', 'blocked']) {
    const r = transition(withStatus(fresh(), 'T1', from, { reason: from === 'blocked' ? 'old' : null }), 'drop', 'T1',
      'out of scope', T1);
    assert.equal(task(r.ledger, 'T1').status, 'dropped');
    assert.equal(task(r.ledger, 'T1').reason, 'out of scope');
    assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from, to: 'dropped', note: 'out of scope' });
  }
  throwsLedger(() => transition(fresh(), 'drop', 'T1', '   ', T1), /T1/);
});

test('transition table: restore dropped -> pending clears the reason', () => {
  const r = transition(withStatus(fresh(), 'T1', 'dropped', { reason: 'out of scope' }), 'restore', 'T1', null, T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T1').status, 'pending');
  assert.equal(task(r.ledger, 'T1').reason, null);
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'dropped', to: 'pending', note: null });
});

test('transition table: reopen done -> in_progress stores the reason and reactivates the plan', () => {
  const l = { ...withStatus(fresh(), 'T1', 'done', { commits: ['abc1234'] }), state: 'done' };
  const r = transition(l, 'reopen', 'T1', 'regression found', T1);
  assert.equal(task(r.ledger, 'T1').status, 'in_progress');
  assert.equal(task(r.ledger, 'T1').reason, 'regression found');
  assert.deepEqual(task(r.ledger, 'T1').commits, ['abc1234']);
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'done', to: 'in_progress', note: 'regression found' });
  assert.equal(r.ledger.state, 'active');
  throwsLedger(() => transition(l, 'reopen', 'T1', '', T1), /T1/);
});

test('transition table: close sets the plan done when every task is done or dropped', () => {
  let l = withStatus(fresh(), 'T1', 'done');
  l = withStatus(l, 'T2', 'dropped', { reason: 'x' });
  l = withStatus(l, 'T3', 'done');
  const r = transition(l, 'close', null, null, T1);
  assert.equal(r.changed, true);
  assert.equal(r.ledger.state, 'done');
  assert.deepEqual(r.ledger.tasks.map((t) => t.history.length), [1, 1, 1]);
  const again = transition(r.ledger, 'close', null, null, T1);
  assert.equal(again.changed, false);
});

test('transition table: retitle sets the title and records a same-status history note', () => {
  const l = withStatus(fresh(), 'T2', 'in_review', { reason: 'kept' });
  const r = transition(l, 'retitle', 'T2', 'Second, renamed', T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T2').title, 'Second, renamed');
  assert.equal(task(r.ledger, 'T2').status, 'in_review');
  assert.equal(task(r.ledger, 'T2').reason, 'kept');
  assert.deepEqual(lastHistory(r.ledger, 'T2'), {
    at: T1, from: 'in_review', to: 'in_review', note: 'retitle: Second: with a colon -> Second, renamed',
  });
  const again = transition(r.ledger, 'retitle', 'T2', 'Second, renamed', T1);
  assert.equal(again.changed, false);
});

test('retitle works on a dropped task and keeps it dropped', () => {
  const l = withStatus(fresh(), 'T2', 'dropped', { reason: 'out of scope' });
  const r = transition(l, 'retitle', 'T2', 'Second, renamed', T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T2').title, 'Second, renamed');
  assert.equal(task(r.ledger, 'T2').status, 'dropped');
  assert.equal(task(r.ledger, 'T2').reason, 'out of scope');
});

test('start refuses unmet deps', () => {
  throwsLedger(() => transition(fresh(), 'start', 'T3', null, T1), /T3 depends on T1 \(pending\)/);
  const l = withStatus(withStatus(fresh(), 'T1', 'done'), 'T2', 'in_review');
  throwsLedger(() => transition(l, 'start', 'T3', null, T1), /^T3 depends on T2 \(in_review\)$/);
});

test('repeat transitions are idempotent', () => {
  const s1 = transition(fresh(), 'start', 'T1', null, T0).ledger;
  const s2 = transition(s1, 'start', 'T1', null, T1);
  assert.equal(s2.changed, false);
  assert.equal(task(s2.ledger, 'T1').history.length, task(s1, 'T1').history.length);
  assert.deepEqual(s2.ledger, s1);

  const d1 = transition(s1, 'done', 'T1', 'abc1234', T0).ledger;
  const d2 = transition(d1, 'done', 'T1', 'abc1234', T1);
  assert.equal(d2.changed, false);
  assert.equal(task(d2.ledger, 'T1').history.length, task(d1, 'T1').history.length);
  assert.deepEqual(task(d2.ledger, 'T1').commits, ['abc1234']);

  const repeats = [
    ['rework', 'in_progress', null],
    ['review', 'in_review', null],
    ['block', 'blocked', 'again'],
    ['drop', 'dropped', 'again'],
    ['restore', 'pending', null],
  ];
  for (const [cmd, status, arg] of repeats) {
    const l = withStatus(fresh(), 'T1', status, { reason: 'first' });
    const r = transition(l, cmd, 'T1', arg, T1);
    assert.equal(r.changed, false, `${cmd} on ${status}`);
    assert.deepEqual(r.ledger, l, `${cmd} on ${status} records nothing`);
  }
});

test('invalid transitions throw LedgerError with code 2', () => {
  throwsLedger(() => transition(fresh(), 'review', 'T1', null, T1), /^T1 is pending; cannot review$/);
  throwsLedger(() => transition(fresh(), 'done', 'T1', 'abc1234', T1), /^T1 is pending; cannot done$/);
  throwsLedger(() => transition(withStatus(fresh(), 'T1', 'in_progress'), 'drop', 'T1', 'x', T1),
    /^T1 is in_progress; cannot drop$/);
  throwsLedger(() => transition(withStatus(fresh(), 'T1', 'done', { commits: ['abc1234'] }), 'done', 'T1', 'fff9999', T1),
    /^T1 is done; cannot done$/);
  throwsLedger(() => transition(fresh(), 'reopen', 'T1', 'why', T1), /^T1 is pending; cannot reopen$/);
  throwsLedger(() => transition(withStatus(fresh(), 'T1', 'blocked'), 'restore', 'T1', null, T1),
    /^T1 is blocked; cannot restore$/);
  throwsLedger(() => transition(fresh(), 'start', 'T9', null, T1), /^unknown task T9$/);
  throwsLedger(() => transition(withStatus(fresh(), 'T1', 'done'), 'close', null, null, T1),
    /^plan has unfinished tasks: T2, T3$/);
  const e = (() => { try { transition(fresh(), 'review', 'T1', null, T1); } catch (err) { return err; } })();
  assert.equal(e.name, 'LedgerError');
  assert.ok(e instanceof Error);
});

test('reconcile adds new tasks, reports missing and retitled, keeps history', () => {
  let l = transition(fresh(), 'start', 'T1', null, T0).ledger;
  l = withStatus(l, 'T2', 'blocked', { reason: 'r' });
  const planTasks = [
    { id: 'T1', title: 'First thing, renamed', deps: ['T9'], skills: ['s'] },
    { id: 'T2', title: 'Second: with a colon', deps: ['T1'], skills: [] },
    { id: 'T4', title: 'Fourth thing', deps: ['T1'], skills: ['x'] },
  ];
  // T3 (pending) gets new deps from the plan only if still in the plan; it is missing here.
  const before = structuredClone(l);
  const r = reconcile(deepFreeze(l), planTasks, T1);
  assert.deepEqual(r.added, ['T4']);
  assert.deepEqual(r.missing, ['T3']);
  assert.deepEqual(r.retitled, ['T1']);
  assert.deepEqual(r.ledger.tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'T4']);
  // Retitled task is untouched: title, status, history, and (not pending) deps/skills.
  assert.deepEqual(task(r.ledger, 'T1'), task(before, 'T1'));
  // Non-pending task keeps its deps; missing task is kept as it was.
  assert.deepEqual(task(r.ledger, 'T2'), task(before, 'T2'));
  assert.deepEqual(task(r.ledger, 'T3'), task(before, 'T3'));
  assert.deepEqual(task(r.ledger, 'T4'), {
    id: 'T4', title: 'Fourth thing', status: 'pending', deps: ['T1'], skills: ['x'],
    role: null, tier: null, effectiveTier: null, commits: [], reason: null, history: [{ at: T1, from: null, to: 'pending', note: null }],
  });
  assert.deepEqual(l, before);
});

test('reconcile refreshes deps and skills for pending tasks only', () => {
  const l = fresh();
  const planTasks = [
    { id: 'T1', title: 'First thing', deps: [], skills: ['new-skill'] },
    { id: 'T2', title: 'Second: with a colon', deps: ['T1'], skills: [] },
    { id: 'T3', title: 'Third thing', deps: ['T2'], skills: [] },
  ];
  const r = reconcile(withStatus(l, 'T2', 'in_progress'), planTasks, T1);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.retitled, []);
  assert.deepEqual(task(r.ledger, 'T1').skills, ['new-skill']);
  assert.deepEqual(task(r.ledger, 'T2').deps, []);
  assert.deepEqual(task(r.ledger, 'T3').deps, ['T2']);
  assert.deepEqual(task(r.ledger, 'T3').skills, []);
  assert.equal(task(r.ledger, 'T3').history.length, 1);
});

test('transition is pure', () => {
  const base = withStatus(withStatus(fresh(), 'T1', 'done', { commits: ['a1'] }), 'T2', 'dropped', { reason: 'x' });
  const snapshot = structuredClone(base);
  const frozen = deepFreeze(base);
  const calls = [
    ['start', 'T3', null], ['retitle', 'T1', 'New title'], ['reopen', 'T1', 'why'], ['restore', 'T2', null],
    ['block', 'T3', 'wait'], ['drop', 'T3', 'gone'], ['done', 'T1', 'a1'],
  ];
  for (const [cmd, id, arg] of calls) {
    const r = transition(frozen, cmd, id, arg, T1);
    assert.notEqual(r.ledger, frozen);
  }
  let chain = transition(frozen, 'start', 'T3', null, T1).ledger;
  chain = transition(deepFreeze(chain), 'review', 'T3', null, T1).ledger;
  chain = transition(deepFreeze(chain), 'rework', 'T3', null, T1).ledger;
  chain = transition(deepFreeze(chain), 'done', 'T3', 'c3', T1).ledger;
  const closed = transition(deepFreeze(chain), 'close', null, null, T1);
  assert.equal(closed.ledger.state, 'done');
  assert.deepEqual(base, snapshot);
});

// Fix round 1: a done plan never holds unfinished tasks.
const closedPlan = () => {
  let l = withStatus(fresh(), 'T1', 'done', { commits: ['a1'] });
  l = withStatus(l, 'T2', 'dropped', { reason: 'x' });
  l = withStatus(l, 'T3', 'done', { commits: ['c3'] });
  return transition(l, 'close', null, null, T0).ledger;
};

test('restore on a closed plan reactivates it and close re-validates', () => {
  const closed = closedPlan();
  assert.equal(closed.state, 'done');
  const r = transition(deepFreeze(closed), 'restore', 'T2', null, T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T2').status, 'pending');
  assert.equal(r.ledger.state, 'active');
  throwsLedger(() => transition(r.ledger, 'close', null, null, T1), /^plan has unfinished tasks: T2$/);
});

test('reconcile adding a task to a closed plan reactivates it; no additions keep it done', () => {
  const closed = deepFreeze(closedPlan());
  const planTasks = parsePlan(PLAN);
  const same = reconcile(closed, planTasks, T1);
  assert.deepEqual(same.added, []);
  assert.equal(same.ledger.state, 'done');
  const grown = reconcile(closed, [...planTasks, { id: 'T4', title: 'Fourth', deps: [], skills: [] }], T1);
  assert.deepEqual(grown.added, ['T4']);
  assert.equal(grown.ledger.state, 'active');
  throwsLedger(() => transition(grown.ledger, 'close', null, null, T1), /^plan has unfinished tasks: T4$/);
});

test('close on a done-state ledger re-validates instead of reporting a repeat', () => {
  const inconsistent = { ...withStatus(closedPlan(), 'T3', 'in_progress'), state: 'done' };
  throwsLedger(() => transition(inconsistent, 'close', null, null, T1), /^plan has unfinished tasks: T3$/);
  const again = transition(closedPlan(), 'close', null, null, T1);
  assert.equal(again.changed, false);
  assert.equal(again.ledger.state, 'done');
});

test('done after reopen does not append a sha already in commits', () => {
  const l = withStatus(fresh(), 'T1', 'done', { commits: ['abc1234'] });
  const reopened = transition(l, 'reopen', 'T1', 'regression', T0).ledger;
  const r = transition(reopened, 'done', 'T1', 'abc1234', T1);
  assert.equal(r.changed, true);
  assert.equal(task(r.ledger, 'T1').status, 'done');
  assert.deepEqual(task(r.ledger, 'T1').commits, ['abc1234']);
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'in_progress', to: 'done', note: null });
});

test('transition matrix: every status x every task command', () => {
  const STATUSES = ['pending', 'in_progress', 'in_review', 'done', 'blocked', 'dropped'];
  // Spec §6.2 table plus restore, written out independently of the implementation.
  const TABLE = {
    start: [['pending', 'blocked'], 'in_progress'],
    review: [['in_progress'], 'in_review'],
    rework: [['in_review'], 'in_progress'],
    done: [['in_progress', 'in_review'], 'done'],
    block: [['pending', 'in_progress', 'in_review'], 'blocked'],
    drop: [['pending', 'blocked'], 'dropped'],
    restore: [['dropped'], 'pending'],
    reopen: [['done'], 'in_progress'],
  };
  const ARG = { done: 'abc1234', block: 'why', drop: 'why', reopen: 'why' };
  for (const status of STATUSES) {
    for (const [cmd, [from, to]] of Object.entries(TABLE)) {
      const cell = `${cmd} on ${status}`;
      const one = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
        tasks: [{ id: 'T1', title: 'Only', deps: [], skills: [] }] });
      const l = deepFreeze(withStatus(one, 'T1', status, {
        commits: status === 'done' ? ['abc1234'] : [],
        reason: status === 'blocked' || status === 'dropped' ? 'old' : null,
      }));
      if (status === to) {
        const r = transition(l, cmd, 'T1', ARG[cmd] ?? null, T1);
        assert.equal(r.changed, false, cell);
        assert.deepEqual(r.ledger, l, `${cell} records nothing`);
      } else if (from.includes(status)) {
        const r = transition(l, cmd, 'T1', ARG[cmd] ?? null, T1);
        assert.equal(r.changed, true, cell);
        assert.equal(task(r.ledger, 'T1').status, to, cell);
        assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: status, to, note: ARG[cmd] === 'why' ? 'why' : null },
          cell);
        const reason = ARG[cmd] === 'why' ? 'why' : cmd === 'start' || cmd === 'restore' ? null : task(l, 'T1').reason;
        assert.equal(task(r.ledger, 'T1').reason, reason, `${cell} reason`);
      } else {
        throwsLedger(() => transition(l, cmd, 'T1', ARG[cmd] ?? null, T1),
          new RegExp(`^T1 is ${status}; cannot ${cmd}$`));
      }
    }
  }
});

test('parsePlan ignores headings, deps and skills inside fenced code blocks', () => {
  const plan = [
    '# Plan', '', '### Task 1: Real one', '**Skills:** a', '',
    '### Task 2: Real two', '**Depends on:** T1', '', '```js',
    '### Task 1: fake', '**Depends on:** T9', '**Skills:** fake-skill', '```', '',
    '  ~~~', '### Task 3: fake too', '```', '**Depends on:** T8', '  ~~~', '',
    '### Task 3: Real three', '**Depends on:** T2',
  ].join('\n');
  assert.deepEqual(parsePlan(plan), [
    { id: 'T1', title: 'Real one', deps: [], skills: ['a'], role: null, tier: null },
    { id: 'T2', title: 'Real two', deps: ['T1'], skills: [], role: null, tier: null },
    { id: 'T3', title: 'Real three', deps: ['T2'], skills: [], role: null, tier: null },
  ]);
});

// Fix round 2: CommonMark fence lengths; an unclosed fence is an error, not silent task loss.
test('parsePlan: a shorter fence inside a longer one does not close it', () => {
  const plan = ['### Task 1: A', '````md', '```js', '### Task 9: phantom', '**Depends on:** T7', '```', '````',
    '### Task 2: B'].join('\n');
  assert.deepEqual(parsePlan(plan), [
    { id: 'T1', title: 'A', deps: [], skills: [], role: null, tier: null },
    { id: 'T2', title: 'B', deps: [], skills: [], role: null, tier: null },
  ]);
});

test('parsePlan: a fence line with an info string does not close the fence', () => {
  const plan = ['### Task 1: A', '```js', '```js', '### Task 9: phantom', '**Depends on:** T7', '```  ',
    '### Task 2: B', '**Depends on:** T1'].join('\n');
  assert.deepEqual(parsePlan(plan), [
    { id: 'T1', title: 'A', deps: [], skills: [], role: null, tier: null },
    { id: 'T2', title: 'B', deps: ['T1'], skills: [], role: null, tier: null },
  ]);
});

test('parsePlan: a plan ending inside a fence throws', () => {
  const plan = ['### Task 1: A', '```', 'code', '### Task 2: B', '### Task 3: C'].join('\n');
  throwsLedger(() => parsePlan(plan), /^unclosed code fence opened at line 2$/);
});

// ---- final fix wave ----

test('done on a reopened task replaces its recorded ids (history rewritten: reopen, then done --commit <new>)', () => {
  const l = withStatus(fresh(), 'T1', 'done', { commits: ['dead000'] });
  const reopened = transition(l, 'reopen', 'T1', 'history rewritten', T0).ledger;
  const r = transition(reopened, 'done', 'T1', 'beef111', T1);
  assert.equal(r.changed, true);
  assert.deepEqual(task(r.ledger, 'T1').commits, ['beef111']);
  assert.deepEqual(lastHistory(r.ledger, 'T1'), { at: T1, from: 'in_progress', to: 'done', note: null });
});

test('parsePlan: a backtick run followed by text holding a backtick is inline code, not a fence', () => {
  const plan = ['### Task 1: A', '```x``` is inline code', '### Task 2: B', '```', 'code', '```', '### Task 3: C'].join('\n');
  assert.deepEqual(parsePlan(plan).map((t) => t.id), ['T1', 'T2', 'T3']);
  const tilde = ['### Task 1: A', '~~~ info with ` backtick', '### Task 9: hidden', '~~~', '### Task 2: B'].join('\n');
  assert.deepEqual(parsePlan(tilde).map((t) => t.id), ['T1', 'T2'], 'a tilde fence info string may hold a backtick');
});

// ---- Plan 2026-09-28-sp3-orchestration · T11: indented fences and task roles (spec Addendum E.5, E.8) ----

test('an indented fence pair does not hide a task (four spaces)', () => {
  const plan = ['### Task 1: A', '    ```', '### Task 2: B', '**Depends on:** T1', '    ```', '### Task 3: C'].join('\n');
  assert.deepEqual(parsePlan(plan).map(({ id, deps }) => [id, deps]), [['T1', []], ['T2', ['T1']], ['T3', []]]);
  // Inside a real fence, a four-space-indented run does not close it.
  const inside = ['### Task 1: A', '```', '    ```', '### Task 9: hidden', '```', '### Task 2: B'].join('\n');
  assert.deepEqual(parsePlan(inside).map((t) => t.id), ['T1', 'T2']);
  // Up to three spaces still open and close a fence.
  const three = ['### Task 1: A', '   ```', '### Task 9: hidden', '   ```', '### Task 2: B'].join('\n');
  assert.deepEqual(parsePlan(three).map((t) => t.id), ['T1', 'T2']);
});

test('a tab-indented fence line is not a fence', () => {
  const plan = ['### Task 1: A', '\t```', '### Task 2: B', '\t~~~', '### Task 3: C'].join('\n');
  assert.deepEqual(parsePlan(plan).map((t) => t.id), ['T1', 'T2', 'T3']);
  const mixed = ['### Task 1: A', ' \t```', '### Task 2: B'].join('\n'); // a tab after a space still reaches column 4
  assert.deepEqual(parsePlan(mixed).map((t) => t.id), ['T1', 'T2']);
  const inside = ['### Task 1: A', '~~~', '\t~~~', '### Task 9: hidden', '~~~', '### Task 2: B'].join('\n');
  assert.deepEqual(parsePlan(inside).map((t) => t.id), ['T1', 'T2']);
});

const planAt = (rel) => parsePlan(readFileSync(join(REPO_ROOT, rel), 'utf8'));
// The plan titles are the committed history's: they keep the names of their time.
const idTitleDeps = (tasks) => tasks.map(({ id, title, deps }) => [id, title, deps]);

test('the sp1 and sp2 plans parse to their pinned task lists', { skip: !isPrivateCheckout && 'needs docs/plans (private checkout)' }, () => {
  // Both hold real fences indented four spaces inside list items; after the fence rule their lines are plain text.
  for (const rel of ['docs/plans/2026-09-27-sp1-base.md', 'docs/plans/2026-09-27-sp2-tracking.md']) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.ok(/^ {4}```/m.test(text), `${rel} no longer holds a four-space-indented fence`);
  }
  assert.deepEqual(idTitleDeps(planAt('docs/plans/2026-09-27-sp1-base.md')), [
    ['T1', '`workflow-gate` plugin (behavior-preserving port)', []],
    ['T2', '`roles` plugin', []],
    ['T3', 'File helpers (`plugins/methodology/bin/lib/`)', []],
    ['T4', 'Global rules content and manifests', ['T2']],
    ['T5', '`cm sync` and the drift hook', ['T3', 'T4']],
    ['T6', '`cm doctor`', ['T5']],
    ['T7', 'The `cm` shim and `cm progress-init`', []],
    ['T8', 'Bootstrap core', ['T7']],
    ['T9', 'Bootstrap migration steps', ['T5', 'T8']],
    ['T10', 'Marketplace wiring and release checks', ['T1', 'T2', 'T5', 'T6', 'T7']],
    ['T11', 'Rollout on this machine (coordinator only; user checkpoint)', ['T9', 'T10']],
  ]);
  assert.deepEqual(idTitleDeps(planAt('docs/plans/2026-09-27-sp2-tracking.md')), [
    ['T1', 'Tracking resolver and local state', []],
    ['T2', 'Ledger model: plan parsing, init/reconcile, transitions', []],
    ['T3', 'Ledger views: render, status, next, check', ['T2']],
    ['T4', '`cm tasks` CLI', ['T1', 'T3']],
    ['T5', 'Hooks: tracking files, local mode, active plans, English', ['T1', 'T3']],
    ['T6', '`pre-commit` gates: committed and local', ['T1', 'T4']],
    ['T7', '`progress-init`: local mode, removal, English templates', ['T6']],
    ['T8', 'English skill and command, and the 0.2.0 release', ['T4', 'T7']],
    ['T9', '`cm doctor --repo` wiring and `methodology` 0.1.1', ['T4', 'T7', 'T8']],
    ['T10', 'Snapshot export and repo registry', ['T4', 'T5', 'T7']],
    ['T11', '`cm tasks line` (status line segment)', ['T4']],
    ['T12', 'Local dashboard `cm ui`', ['T10', 'T11']],
    ['T13', 'Rollout on this machine (coordinator only)', ['T12']],
  ]);
});

test('parsePlan reads a **Role:** line', () => {
  const plan = ['### Task 1: A', '**Role:** coordinator', '', '### Task 2: B', '**Depends on:** T1',
    '**Role:**   roles:review-fixer  ', '**Skills:** s', '', '### Task 3: C', '  **Role:** coordinator',
    '```', '**Role:** coordinator', '```'].join('\n');
  assert.deepEqual(parsePlan(plan), [
    { id: 'T1', title: 'A', deps: [], skills: [], role: 'coordinator', tier: null },
    { id: 'T2', title: 'B', deps: ['T1'], skills: ['s'], role: 'roles:review-fixer', tier: null },
    { id: 'T3', title: 'C', deps: [], skills: [], role: null, tier: null }, // an indented or fenced Role line is not read
  ]);
});

test('a task without **Role:** reads as roles:tdd-implementer', () => {
  const [t] = parsePlan('### Task 1: A\n**Depends on:**\n');
  assert.equal(t.role, null);
  assert.equal(DEFAULT_ROLE, 'roles:tdd-implementer');
  assert.equal(roleOf(t), 'roles:tdd-implementer');
  assert.equal(roleOf({ id: 'T1' }), 'roles:tdd-implementer', 'a ledger task without the field');
  assert.equal(roleOf({ id: 'T1', role: 'coordinator' }), 'coordinator');
  assert.deepEqual([...TASK_ROLES], ['coordinator', 'roles:tdd-implementer', 'roles:complex-implementer', 'roles:review-fixer']);
});

test('createLedger stores each task\'s role as parsed', () => {
  const l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
    tasks: parsePlan('### Task 1: A\n**Role:** coordinator\n\n### Task 2: B\n') });
  assert.deepEqual(l.tasks.map((t) => [t.id, t.role]), [['T1', 'coordinator'], ['T2', null]]);
});

test('reconcile refreshes a pending task\'s role from the plan and keeps a started task\'s', () => {
  const plan = (r1, r2) => parsePlan(`### Task 1: A\n**Role:** ${r1}\n\n### Task 2: B\n**Role:** ${r2}\n`);
  let l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0, tasks: plan('coordinator', 'coordinator') });
  l = transition(l, 'start', 'T2', null, T0).ledger;
  const r = reconcile(deepFreeze(l), plan('roles:review-fixer', 'roles:review-fixer'), T1);
  assert.equal(task(r.ledger, 'T1').role, 'roles:review-fixer');
  assert.equal(task(r.ledger, 'T2').role, 'coordinator');
  // A pending task of a ledger written before roles gets the field; a started one stays without it.
  const old = structuredClone(l);
  for (const t of old.tasks) delete t.role;
  const r2 = reconcile(old, parsePlan('### Task 1: A\n\n### Task 2: B\n'), T1);
  assert.equal(task(r2.ledger, 'T1').role, null);
  assert.equal(Object.hasOwn(task(r2.ledger, 'T2'), 'role'), false);
});

test('every roles:* task role names an agent in plugins/roles/agents', () => {
  const agents = new Set(readdirSync(join(REPO_ROOT, 'plugins', 'roles', 'agents'))
    .filter((f) => f.endsWith('.md')).map((f) => `roles:${f.slice(0, -3)}`));
  const named = TASK_ROLES.filter((r) => r.startsWith('roles:'));
  assert.ok(named.length > 0);
  for (const role of named) assert.ok(agents.has(role), `${role} is not an agent in plugins/roles/agents`);
  assert.ok(TASK_ROLES.includes(DEFAULT_ROLE));
});

test('this plan parses with its roles', { skip: !isPrivateCheckout && 'needs docs/plans (private checkout)' }, () => {
  const tasks = planAt('docs/plans/2026-09-28-sp3-orchestration.md');
  const coordinator = new Set(['T1', 'T12', 'T13', 'T14']);
  assert.equal(tasks.length, 16);
  for (const t of tasks) {
    assert.equal(t.role, coordinator.has(t.id) ? 'coordinator' : 'roles:tdd-implementer', t.id);
  }
});

// Plan methodology-1.0 · T1: parsePlan is a thin wrapper over lib/plan.mjs's readTasks.
test('parsePlan carries tier', () => {
  const plan = '### Task 1: A\n**Tier:** heavy\n**Role:** roles:complex-implementer\n\n### Task 2: B\n';
  assert.deepEqual(parsePlan(plan), [
    { id: 'T1', title: 'A', deps: [], skills: [], role: 'roles:complex-implementer', tier: 'heavy' },
    { id: 'T2', title: 'B', deps: [], skills: [], role: null, tier: null },
  ]);
});

test('parsePlan maps PlanError to LedgerError', () => {
  throwsLedger(() => parsePlan('### Task 1: A\n**Tier:** medium\n'), /T1.*medium/);
  throwsLedger(() => parsePlan('### Task 1: A\n```\n'), /^unclosed code fence opened at line 2$/);
});

test('roles.mjs re-exports TIERS', () => {
  assert.equal(TIERS, PLAN_TIERS);
  assert.deepEqual([...TIERS], ['heavy', 'standard', 'light']);
});

// Plan methodology-1.0 · T2: the declared tier and the effective tier in the ledger.
test('newTask copies tier and sets effectiveTier = tier', () => {
  const l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
    tasks: parsePlan('### Task 1: A\n**Tier:** heavy\n\n### Task 2: B\n**Tier:** light\n\n### Task 3: C\n') });
  assert.deepEqual(l.tasks.map((t) => [t.id, t.tier, t.effectiveTier]),
    [['T1', 'heavy', 'heavy'], ['T2', 'light', 'light'], ['T3', null, null]]);
  // A task given without a tier (an older caller) reads null for both.
  const old = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
    tasks: [{ id: 'T1', title: 'A', deps: [], skills: [], role: null }] });
  assert.equal(old.tasks[0].tier, null);
  assert.equal(old.tasks[0].effectiveTier, null);
});

test('reconcile copies tier into pending tasks and raises effectiveTier to the higher', () => {
  const plan = (t1, t2, t3) => parsePlan(`### Task 1: A\n**Tier:** ${t1}\n\n### Task 2: B\n**Tier:** ${t2}\n\n### Task 3: C\n**Tier:** ${t3}\n`);
  let l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0, tasks: plan('light', 'standard', 'light') });
  l = transition(transition(l, 'start', 'T3', null, T0).ledger, 'done', 'T3', 'abc1234', T0).ledger;
  const before = structuredClone(l);
  const r = reconcile(deepFreeze(l), plan('heavy', 'light', 'heavy'), T1);
  // Pending, effective light, plan now heavy: both rise to heavy.
  assert.equal(task(r.ledger, 'T1').tier, 'heavy');
  assert.equal(task(r.ledger, 'T1').effectiveTier, 'heavy');
  // Pending, effective standard, plan now light: the declared tier follows the plan, the effective one stays.
  assert.equal(task(r.ledger, 'T2').tier, 'light');
  assert.equal(task(r.ledger, 'T2').effectiveTier, 'standard');
  // Done: untouched.
  assert.deepEqual(task(r.ledger, 'T3'), task(before, 'T3'));
  assert.equal(task(r.ledger, 'T3').effectiveTier, 'light');
  // null counts as standard: a light plan never lowers an undeclared task, a heavy one raises it.
  const undeclared = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0, tasks: parsePlan('### Task 1: A\n\n### Task 2: B\n') });
  const r2 = reconcile(undeclared, parsePlan('### Task 1: A\n**Tier:** light\n\n### Task 2: B\n**Tier:** heavy\n'), T1);
  assert.deepEqual(r2.ledger.tasks.map((t) => [t.tier, t.effectiveTier]), [['light', null], ['heavy', 'heavy']]);
});

test('statusLine shows the effective tier', () => {
  let l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
    tasks: parsePlan('### Task 1: A\n**Tier:** heavy\n\n### Task 2: B\n\n### Task 3: C\n**Tier:** light\n') });
  assert.equal(statusLine('p', l), 'p: 0/3 done · in progress: none · next: T1 [heavy]');
  l = transition(l, 'start', 'T1', null, T1).ledger;
  l = transition(l, 'start', 'T2', null, T1).ledger;
  assert.equal(statusLine('p', l), 'p: 0/3 done · in progress: T1 [heavy], T2 · next: T3 [light]');
});

test('checkSchema reports an unknown tier or effective tier; absent and null ones are clean', () => {
  const l = createLedger({ plan: 'p.md', spec: null, branch: 'b', now: T0,
    tasks: parsePlan('### Task 1: A\n**Tier:** heavy\n\n### Task 2: B\n\n### Task 3: C\n') });
  assert.deepEqual(checkSchema(l), []);
  const old = structuredClone(l);
  for (const t of old.tasks) { delete t.tier; delete t.effectiveTier; }
  assert.deepEqual(checkSchema(old), []);
  const bad = structuredClone(l);
  bad.tasks[1].tier = 'medium';
  bad.tasks[2].effectiveTier = 'huge';
  assert.deepEqual(checkSchema(bad), ['T2 has unknown tier "medium"', 'T3 has unknown effective tier "huge"']);
});

const SHA40 = 'a'.repeat(40);

test('parseExternalCommit splits ext:<path>@<sha> at the last @ and ignores every other form', () => {
  assert.deepEqual(parseExternalCommit(`ext:../other@${SHA40}`), { path: '../other', sha: SHA40 });
  assert.deepEqual(parseExternalCommit(`ext:../we@ird/repo@${SHA40}`), { path: '../we@ird/repo', sha: SHA40 });
  for (const bad of [SHA40, 'ext:', 'ext:@abc', 'ext:../other@', 'ext:no-at-sign', 'xext:a@b', null, undefined, 7]) {
    assert.equal(parseExternalCommit(bad), null, String(bad));
  }
});

// A done task whose only commit is `commit`, in an otherwise clean active ledger.
const withCommit = (commit) => {
  const planText = '### Task 1: Alpha\n';
  const ledger = createLedger({ plan: 'plans/p.md', spec: null, branch: null, tasks: parsePlan(planText), now: T0 });
  ledger.tasks[0].status = 'done';
  ledger.tasks[0].commits = [commit];
  const renderedBody = renderSection([{ name: 'p', ledger }]);
  return { ledger, planText, statusText: upsertStatusSection('# Status\n', renderedBody), renderedBody };
};

test('checkLedger checks an external commit in its path: a hit is clean, a miss is drift, an unreachable path warns', () => {
  const commit = `ext:../other@${SHA40}`;
  const calls = [];
  const exists = (answer) => (sha, path) => { calls.push([sha, path]); return answer; };
  const warnings = [];
  const warn = (m) => warnings.push(m);

  assert.deepEqual(checkLedger({ ...withCommit(commit), commitExists: exists(true), warn }), []);
  assert.deepEqual(calls, [[SHA40, '../other']]);

  assert.deepEqual(checkLedger({ ...withCommit(commit), commitExists: exists(false), warn }),
    ['T1 commit aaaaaaa does not resolve in ../other']);
  assert.deepEqual(warnings, []);

  assert.deepEqual(checkLedger({ ...withCommit(commit), commitExists: exists(null), warn }), []);
  assert.deepEqual(warnings, [`external commit not checkable: ../other@${SHA40}`]);

  // Without a warn callback an unreachable path is still not drift.
  assert.deepEqual(checkLedger({ ...withCommit(commit), commitExists: exists(null) }), []);
});

test('checkLedger still checks a plain commit with the sha alone, and a malformed ext: form as a plain commit', () => {
  const seen = [];
  const commitExists = (...args) => { seen.push(args); return false; };
  assert.deepEqual(checkLedger({ ...withCommit(SHA40), commitExists }), ['T1 commit aaaaaaa does not resolve']);
  assert.deepEqual(checkLedger({ ...withCommit('ext:nope'), commitExists }), ['T1 commit ext:nop does not resolve']);
  assert.deepEqual(seen, [[SHA40], ['ext:nope']]);
});

test('transition done stores an external commit string as given; a repeat of the same string is a no-op', () => {
  const commit = `ext:../other@${SHA40}`;
  const l0 = createLedger({ plan: 'plans/p.md', spec: null, branch: null, tasks: parsePlan('### Task 1: Alpha\n'), now: T0 });
  const l1 = transition(l0, 'start', 'T1', null, T0).ledger;
  const l2 = transition(l1, 'done', 'T1', commit, T1);
  assert.deepEqual(l2.ledger.tasks[0].commits, [commit]);
  assert.equal(transition(l2.ledger, 'done', 'T1', commit, T1).changed, false);
  assert.throws(() => transition(l2.ledger, 'done', 'T1', `ext:../other@${'b'.repeat(40)}`, T1), /is done; cannot done/);
});
