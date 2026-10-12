import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LedgerError, parsePlan, createLedger,
  renderSection, upsertStatusSection, nextTask, statusLine, checkLedger, checkSchema, checkSection,
} from '../lib/ledger.mjs';
import { roleOf } from '../lib/roles.mjs';

const T0 = '2026-09-28T10:00:00Z';
const SHA1 = 'abcdef1234567890abcdef1234567890abcdef12';

const PLAN = `# Example plan

### Task 1: Alpha

### Task 2: Beta

### Task 3: Gamma
**Depends on:** T1

### Task 4: Delta
**Depends on:** T3

### Task 5: Epsilon

### Task 6: Zeta

### Task 7: Eta
**Depends on:** T1, T6
`;

const ledgerOf = (planText, plan = 'docs/plans/2026-09-28-example.md') => createLedger({
  plan, spec: 'docs/specs/x-design.md', branch: 'feat/x', tasks: parsePlan(planText), now: T0,
});
// Force task statuses (test setup only): { T1: ['done', { commits: [...] }], T2: 'in_progress', ... }.
const withStatuses = (ledger, map) => ({
  ...ledger,
  tasks: ledger.tasks.map((t) => {
    const v = map[t.id];
    if (!v) return t;
    const [status, extra = {}] = Array.isArray(v) ? v : [v];
    return { ...t, status, ...extra };
  }),
});

// T1 done, T2 in progress, T3 in review, T4 pending (dep T3 unmet), T5 blocked, T6 dropped, T7 pending (deps met).
const mixed = () => withStatuses(ledgerOf(PLAN), {
  T1: ['done', { commits: [SHA1] }],
  T2: 'in_progress',
  T3: 'in_review',
  T5: ['blocked', { reason: 'waiting on API' }],
  T6: ['dropped', { reason: 'out of scope' }],
});

const throwsLedger = (fn, message) => assert.throws(fn, (e) => {
  assert.ok(e instanceof LedgerError, `expected LedgerError, got ${e && e.constructor && e.constructor.name}`);
  assert.equal(e.code, 2);
  assert.equal(e.message, message);
  return true;
});

test('renderSection formats one active plan exactly', () => {
  assert.equal(renderSection([{ name: '2026-09-28-example', ledger: mixed() }]), [
    '## Active plan',
    '',
    '### 2026-09-28-example — 1/6 done',
    '- In progress: T2 Beta',
    '- In review: T3 Gamma',
    '- Blocked: T5 Epsilon — waiting on API',
    '- Dropped: T6 Zeta — out of scope',
    '- Next: T7 Eta',
  ].join('\n'));
});

test('renderSection orders two plans newest first and omits done plans', () => {
  const a = withStatuses(ledgerOf('### Task 1: A one\n\n### Task 2: A two\n', 'docs/plans/2026-09-27-a.md'), {
    T1: 'in_progress', T2: 'in_progress',
  });
  const b = withStatuses(ledgerOf('### Task 1: B one\n\n### Task 2: B two\n', 'docs/plans/2026-09-28-b.md'), {
    T1: ['done', { commits: [SHA1] }],
  });
  const c = {
    ...withStatuses(ledgerOf('### Task 1: C one\n', 'docs/plans/2026-09-29-c.md'), {
      T1: ['done', { commits: [SHA1] }],
    }),
    state: 'done',
  };
  const out = renderSection([
    { name: '2026-09-27-a', ledger: a },
    { name: '2026-09-29-c', ledger: c },
    { name: '2026-09-28-b', ledger: b },
  ]);
  assert.equal(out, [
    '## Active plan',
    '',
    '### 2026-09-28-b — 1/2 done',
    '- Next: T2 B two',
    '',
    '### 2026-09-27-a — 0/2 done',
    '- In progress: T1 A one; T2 A two',
  ].join('\n'));
});

test('renderSection with no active plan', () => {
  assert.equal(renderSection([]), '## Active plan\n\nNo active plan.');
  const closed = { ...withStatuses(ledgerOf('### Task 1: Only\n'), { T1: 'done' }), state: 'done' };
  assert.equal(renderSection([{ name: 'closed', ledger: closed }]), '## Active plan\n\nNo active plan.');
});

test('upsertStatusSection appends when markers are missing, replaces in place, refuses an unterminated section', () => {
  const body = '## Active plan\n\nNo active plan.';
  const section = `<!-- tasks:start -->\n${body}\n<!-- tasks:end -->\n`;

  // Missing markers: a trailing newline is ensured first, then the section is appended after a blank line.
  assert.equal(upsertStatusSection('# Status\n\nText', body), `# Status\n\nText\n\n${section}`);
  assert.equal(upsertStatusSection('# Status\n\nText\n', body), `# Status\n\nText\n\n${section}`);

  // Existing markers: only the text between them changes.
  const existing = '# Status\n\nBefore\n<!-- tasks:start -->\nold line 1\nold line 2\n<!-- tasks:end -->\nAfter\n';
  const replaced = upsertStatusSection(existing, body);
  assert.equal(replaced, `# Status\n\nBefore\n<!-- tasks:start -->\n${body}\n<!-- tasks:end -->\nAfter\n`);
  assert.equal(upsertStatusSection(replaced, body), replaced);

  throwsLedger(
    () => upsertStatusSection('# Status\n<!-- tasks:start -->\nold\n', body),
    'status.md tasks section is unterminated',
  );
});

test('upsertStatusSection refuses an end marker without a start or before the start', () => {
  const body = '## Active plan\n\nNo active plan.';
  const misordered = 'status.md tasks section is misordered';
  throwsLedger(() => upsertStatusSection('# Status\n<!-- tasks:end -->\n', body), misordered);
  throwsLedger(() => upsertStatusSection('# Status\n<!-- tasks:end -->\nx\n<!-- tasks:start -->\n', body), misordered);
  throwsLedger(
    () => upsertStatusSection('# Status\n<!-- tasks:end -->\n<!-- tasks:start -->\nold\n<!-- tasks:end -->\n', body),
    misordered,
  );
});

test('checkLedger reports a misordered status section with its own message', () => {
  const c = clean();
  const misordered = ['status.md tasks section is misordered'];
  assert.deepEqual(checkLedger({ ...c, statusText: `# Status\n<!-- tasks:end -->\n` }), misordered);
  assert.deepEqual(checkLedger({
    ...c, statusText: `# Status\n<!-- tasks:end -->\n<!-- tasks:start -->\n${c.renderedBody}\n<!-- tasks:end -->\n`,
  }), misordered);
});

test('upsertStatusSection refuses a body containing a tasks section marker', () => {
  const status = '# Status\n<!-- tasks:start -->\nold\n<!-- tasks:end -->\n';
  for (const marker of ['<!-- tasks:end -->', '<!-- tasks:start -->']) {
    const ledger = withStatuses(ledgerOf('### Task 1: Only\n'), { T1: ['blocked', { reason: `see ${marker} here` }] });
    const body = renderSection([{ name: 'x', ledger }]);
    throwsLedger(() => upsertStatusSection(status, body), 'task text contains a tasks section marker');
    throwsLedger(() => upsertStatusSection('# Status\n', body), 'task text contains a tasks section marker');
  }
  const titled = ledgerOf('### Task 1: Title <!-- tasks:end --> injected\n');
  throwsLedger(
    () => upsertStatusSection(status, renderSection([{ name: 'x', ledger: titled }])),
    'task text contains a tasks section marker',
  );
});

test('checkLedger rethrows an error that is not a LedgerError', () => {
  const c = clean();
  assert.throws(() => checkLedger({ ...c, statusText: undefined }), TypeError);
});

test('checkLedger ignores a dropped task removed from the plan', () => {
  const c = clean(); // T6 Zeta is dropped
  const planText = PLAN.replace('### Task 6: Zeta\n\n', '');
  assert.equal(parsePlan(planText).some((t) => t.id === 'T6'), false);
  assert.deepEqual(checkLedger({ ...c, planText }), []);
});

test('nextTask skips tasks with unmet deps', () => {
  const l = withStatuses(ledgerOf(PLAN), {
    T1: 'done', T2: 'in_progress', T3: 'done', T4: 'blocked', T5: 'in_review', T6: 'dropped',
  });
  // T7 depends on T1 (done) and T6 (dropped): deps met.
  assert.equal(nextTask(l).id, 'T7');

  // T3 depends on T1 (pending): skipped; T1 comes first in ledger order.
  const fresh = ledgerOf(PLAN);
  assert.equal(nextTask(fresh).id, 'T1');
  const t1Running = withStatuses(fresh, { T1: 'in_progress', T2: 'done', T5: 'done', T6: 'blocked' });
  // T3 (dep T1 in progress), T4 (dep T3 pending) and T7 (dep T6 blocked) are all unmet.
  assert.equal(nextTask(t1Running), null);

  // A dep that is not in the ledger is unmet.
  const ghost = ledgerOf('### Task 1: Needs ghost\n**Depends on:** T9\n');
  assert.equal(nextTask(ghost), null);
});

test('statusLine prints done/total, in-progress ids and next id', () => {
  assert.equal(statusLine('2026-09-28-example', mixed()),
    '2026-09-28-example: 1/6 done · in progress: T2 · next: T7');
  const two = withStatuses(ledgerOf(PLAN), { T1: 'in_progress', T2: 'in_progress', T5: 'in_progress', T6: 'blocked' });
  assert.equal(statusLine('p', two), 'p: 0/7 done · in progress: T1, T2, T5 · next: none');
});

// A clean fixture: the status section holds exactly the rendered body and every commit resolves.
const clean = () => {
  const ledger = mixed();
  const renderedBody = renderSection([{ name: '2026-09-28-example', ledger }]);
  return {
    ledger,
    planText: PLAN,
    statusText: upsertStatusSection('# Status\n\nSummary.\n', renderedBody),
    renderedBody,
    commitExists: (sha) => sha === SHA1,
  };
};

test('checkLedger reports each drift kind', () => {
  assert.deepEqual(checkLedger(clean()), []);

  // Schema.
  let c = clean();
  assert.deepEqual(checkLedger({ ...c, ledger: { ...c.ledger, version: 2 } }),
    ['unsupported ledger version 2 (expected 1)']);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, ledger: { ...c.ledger, state: 'closed' } }),
    ['unknown plan state "closed"']);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, ledger: withStatuses(c.ledger, { T4: 'finished' }) }),
    ['T4 has unknown status "finished"']);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, ledger: withStatuses(c.ledger, { T4: ['pending', { history: null }] }) }),
    ['T4 history is not an array']);

  // Plan and ledger titles.
  c = clean();
  assert.deepEqual(checkLedger({ ...c, planText: PLAN.replace('### Task 3: Gamma', '### Task 3: Gamma prime') }),
    ['T3 title differs: plan "Gamma prime", ledger "Gamma" — run triqual tasks retitle']);

  // A plan task missing from the ledger.
  c = clean();
  assert.deepEqual(checkLedger({ ...c, planText: `${PLAN}\n### Task 8: Theta\n` }),
    ['T8 is in the plan but not in the ledger — run triqual tasks init']);

  // A ledger task missing from the plan.
  c = clean();
  assert.deepEqual(checkLedger({ ...c, planText: PLAN.replace(/### Task 7: Eta\n\*\*Depends on:\*\* T1, T6\n/, '') }),
    ['T7 is not in the plan — restore the heading or drop the task']);

  // The status section: different body, missing section; an unterminated section reports its own message.
  const stale = ['status.md Active plan section is stale — run triqual tasks render'];
  c = clean();
  assert.deepEqual(checkLedger({ ...c, statusText: upsertStatusSection('# Status\n', '## Active plan\n\nold') }), stale);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, statusText: '# Status\n\nNo section here.\n' }), stale);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, statusText: `# Status\n<!-- tasks:start -->\n${c.renderedBody}\n` }),
    ['status.md tasks section is unterminated']);
  // Surrounding whitespace inside the markers is not drift.
  c = clean();
  assert.deepEqual(checkLedger({
    ...c, statusText: `# Status\n<!-- tasks:start -->\n\n${c.renderedBody}\n\n<!-- tasks:end -->\n`,
  }), []);

  // Commits.
  c = clean();
  assert.deepEqual(checkLedger({ ...c, commitExists: () => false }), ['T1 commit abcdef1 does not resolve']);

  // A plan that cannot be parsed is one drift message, not an exception.
  c = clean();
  assert.deepEqual(checkLedger({ ...c, planText: `${PLAN}\n### Task 1: Again\n` }),
    ['plan: duplicate task T1 in plan']);
  c = clean();
  assert.deepEqual(checkLedger({ ...c, planText: `${PLAN}\n\`\`\`\n### Task 9: Hidden\n` }),
    ['plan: unclosed code fence opened at line 20']);
});

test('checkLedger skips commit resolution for a done plan', () => {
  const ledger = {
    ...withStatuses(ledgerOf('### Task 1: Only\n\n### Task 2: Gone\n'), {
      T1: ['done', { commits: [SHA1] }],
      T2: ['dropped', { reason: 'not needed' }],
    }),
    state: 'done',
  };
  const renderedBody = renderSection([{ name: 'x', ledger }]);
  let calls = 0;
  const args = {
    ledger,
    planText: '### Task 1: Only\n\n### Task 2: Gone\n',
    statusText: upsertStatusSection('# Status\n', renderedBody),
    renderedBody,
    commitExists: () => { calls += 1; return false; },
  };
  assert.deepEqual(checkLedger(args), []);
  assert.equal(calls, 0);
  // The same ledger while active reports the unresolved commit.
  assert.deepEqual(checkLedger({ ...args, ledger: { ...ledger, state: 'active' } }),
    ['T1 commit abcdef1 does not resolve']);
});

test('checkSchema reports schema drift only, for a ledger in any state', () => {
  const done = { ...withStatuses(ledgerOf('### Task 1: Only\n'), { T1: 'done' }), state: 'done' };
  assert.deepEqual(checkSchema(done), []);
  assert.deepEqual(checkSchema({ ...done, version: 2 }), ['unsupported ledger version 2 (expected 1)']);
  assert.deepEqual(checkSchema({ ...done, state: 'paused' }), ['unknown plan state "paused"']);
  assert.deepEqual(checkSchema({ ...done, tasks: {} }), ['ledger tasks is not an array']);
  assert.deepEqual(checkSchema(withStatuses(done, { T1: ['finished', { history: null }] })),
    ['T1 has unknown status "finished"', 'T1 history is not an array']);
});

test('checkSection compares the managed section with the rendered body', () => {
  const body = renderSection([]); // "No active plan."
  assert.deepEqual(checkSection(upsertStatusSection('# Status\n', body), body), []);
  const stale = ['status.md Active plan section is stale — run triqual tasks render'];
  assert.deepEqual(checkSection(upsertStatusSection('# Status\n', '## Active plan\n\njunk'), body), stale);
  assert.deepEqual(checkSection('# Status\n', body), stale);
  assert.deepEqual(checkSection('# Status\n<!-- tasks:start -->\n', body), ['status.md tasks section is unterminated']);
  assert.deepEqual(checkSection('# Status\n<!-- tasks:end -->\n', body), ['status.md tasks section is misordered']);
  assert.throws(() => checkSection(undefined, body), TypeError);
});

// ---- Plan 2026-09-28-sp3-orchestration · T11: task roles (spec Addendum E.5) ----

const NOT_A_TASK_ROLE = (id, role) => `${id} has role "${role}", not a task role `
  + '(coordinator, roles:tdd-implementer, roles:complex-implementer, roles:review-fixer)';

test('a ledger written before roles reads its tasks as roles:tdd-implementer', () => {
  const c = clean();
  const old = structuredClone(c.ledger);
  for (const t of old.tasks) delete t.role;
  assert.ok(old.tasks.every((t) => !Object.hasOwn(t, 'role')));
  assert.ok(old.tasks.every((t) => roleOf(t) === 'roles:tdd-implementer'));
  assert.deepEqual(checkSchema(old), []);
  assert.deepEqual(checkLedger({ ...c, ledger: old }), []);
  // The plan may carry Role lines the old ledger lacks: still clean (roles are refreshed by triqual tasks init).
  const planText = PLAN.replace('### Task 4: Delta\n', '### Task 4: Delta\n**Role:** coordinator\n');
  assert.deepEqual(checkLedger({ ...c, ledger: old, planText }), []);
});

test('check flags a role outside TASK_ROLES', () => {
  const c = clean();
  const roles = {
    T2: 'coordinator', T3: 'roles:complex-implementer', T4: 'roles:tdd-implemnter', T5: 'roles:review-fixer',
    T7: 'roles:spec-reviewer',
  };
  const ledger = { ...c.ledger, tasks: c.ledger.tasks.map((t) => (roles[t.id] ? { ...t, role: roles[t.id] } : t)) };
  let drift;
  assert.doesNotThrow(() => { drift = checkLedger({ ...c, ledger }); });
  assert.deepEqual(drift, [NOT_A_TASK_ROLE('T4', 'roles:tdd-implemnter'), NOT_A_TASK_ROLE('T7', 'roles:spec-reviewer')]);
  // A hand-edited role that is not a string is drift too, never a throw.
  const odd = { ...c.ledger, tasks: c.ledger.tasks.map((t) => (t.id === 'T2' ? { ...t, role: 42 } : t)) };
  assert.deepEqual(checkLedger({ ...c, ledger: odd }), [NOT_A_TASK_ROLE('T2', '42')]);
});

test('check flags a non-task role only on tasks that are not done or dropped', () => {
  const c = clean(); // T1 done, T2 in progress, T3 in review, T4 pending, T5 blocked, T6 dropped, T7 pending
  const bad = 'roles:spec-reviewer';
  const ledger = { ...c.ledger, tasks: c.ledger.tasks.map((t) => ({ ...t, role: bad })) };
  assert.deepEqual(checkLedger({ ...c, ledger }), ['T2', 'T3', 'T4', 'T5', 'T7'].map((id) => NOT_A_TASK_ROLE(id, bad)));
});
