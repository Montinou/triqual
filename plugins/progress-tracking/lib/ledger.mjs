// Pure task-ledger model (spec §6.2): plan parsing, ledger creation, reconciliation and task transitions.
// No I/O and no clock: every timestamp comes in as `now` (an ISO string). Functions never mutate their input.
import { TASK_ROLES, roleOf } from './roles.mjs';
import { PlanError, TIERS, readTasks } from './plan.mjs';

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
    this.code = 2;
  }
}

// The plan format is read by lib/plan.mjs (import-free, shared byte-for-byte with methodology's scripts); parsePlan
// keeps the task shape ledgers are built from, plus the declared tier, and reports a PlanError as a LedgerError.
export function parsePlan(text) {
  try {
    return readTasks(text).map(({ id, title, deps, skills, role, tier }) => ({ id, title, deps, skills, role, tier }));
  } catch (e) {
    if (e instanceof PlanError) throw new LedgerError(e.message);
    throw e;
  }
}

// Tier order for "higher": heavy > standard > light, null (undeclared) counting as standard. On a tie `a` stays, so an
// undeclared effective tier is kept rather than replaced by an equal `standard`.
const TIER_RANK = { heavy: 2, standard: 1, light: 0 };
const rankOf = (tier) => TIER_RANK[tier ?? 'standard'] ?? TIER_RANK.standard;
export const higherTier = (a, b) => (rankOf(b) > rankOf(a) ? (b ?? null) : (a ?? null));

const newTask = ({ id, title, deps, skills, role, tier }, now) => ({
  id,
  title,
  status: 'pending',
  deps: [...deps],
  skills: [...skills],
  role: role ?? null,
  tier: tier ?? null,
  effectiveTier: tier ?? null,
  commits: [],
  reason: null,
  history: [{ at: now, from: null, to: 'pending', note: null }],
});

export function createLedger({ plan, spec, branch, tasks, now }) {
  return {
    version: 1,
    plan,
    spec,
    branch,
    state: 'active',
    tasks: tasks.map((t) => newTask(t, now)),
  };
}

// Reconciles by id and title: new plan tasks are appended as pending, tasks no longer in the plan are reported and
// kept, a changed title is reported as drift and the task is left untouched. Pending tasks take the plan's deps, skills,
// role and declared tier; their effective tier only ever rises to the declared one (higherTier), never falls. Adding a
// task reactivates a closed plan.
export function reconcile(ledger, planTasks, now) {
  const next = structuredClone(ledger);
  const planById = new Map(planTasks.map((t) => [t.id, t]));
  const added = [];
  const missing = [];
  const retitled = [];
  for (const task of next.tasks) {
    const p = planById.get(task.id);
    if (!p) { missing.push(task.id); continue; }
    if (p.title !== task.title) { retitled.push(task.id); continue; }
    if (task.status === 'pending') {
      task.deps = [...p.deps];
      task.skills = [...p.skills];
      task.role = p.role ?? null;
      task.tier = p.tier ?? null;
      task.effectiveTier = higherTier(task.effectiveTier, p.tier);
    }
  }
  const known = new Set(next.tasks.map((t) => t.id));
  for (const p of planTasks) {
    if (known.has(p.id)) continue;
    next.tasks.push(newTask(p, now));
    added.push(p.id);
  }
  if (added.length) next.state = 'active';
  return { ledger: next, added, missing, retitled };
}
// Task commands: the statuses each may start from, and its target status (spec §6.2 table plus `restore`).
const MOVES = {
  start: { from: ['pending', 'blocked'], to: 'in_progress' },
  review: { from: ['in_progress'], to: 'in_review' },
  rework: { from: ['in_review'], to: 'in_progress' },
  done: { from: ['in_progress', 'in_review'], to: 'done' },
  block: { from: ['pending', 'in_progress', 'in_review'], to: 'blocked' },
  drop: { from: ['pending', 'blocked'], to: 'dropped' },
  restore: { from: ['dropped'], to: 'pending' },
  reopen: { from: ['done'], to: 'in_progress' },
};
const NEEDS_TEXT = new Set(['block', 'drop', 'reopen', 'retitle', 'done']);
const ARG_NAME = { done: 'a commit sha', retitle: 'a title' };
const FINISHED = new Set(['done', 'dropped']);

export function transition(ledger, cmd, id, arg, now) {
  const next = structuredClone(ledger);

  if (cmd === 'close') {
    const open = next.tasks.filter((t) => !FINISHED.has(t.status)).map((t) => t.id);
    if (open.length) throw new LedgerError(`plan has unfinished tasks: ${open.join(', ')}`);
    if (next.state === 'done') return { ledger: next, changed: false };
    next.state = 'done';
    return { ledger: next, changed: true };
  }

  if (cmd !== 'retitle' && !MOVES[cmd]) throw new LedgerError(`unknown command ${cmd}`);
  const task = next.tasks.find((t) => t.id === id);
  if (!task) throw new LedgerError(`unknown task ${id}`);
  const text = typeof arg === 'string' ? arg.trim() : '';
  if (NEEDS_TEXT.has(cmd) && !text) throw new LedgerError(`${id}: ${cmd} requires ${ARG_NAME[cmd] ?? 'a reason'}`);

  if (cmd === 'retitle') {
    if (task.title === text) return { ledger: next, changed: false };
    task.history.push({ at: now, from: task.status, to: task.status, note: `retitle: ${task.title} -> ${text}` });
    task.title = text;
    return { ledger: next, changed: true };
  }

  const { from, to } = MOVES[cmd];
  if (task.status === to) {
    if (cmd === 'done' && !task.commits.includes(text)) throw new LedgerError(`${id} is done; cannot done`);
    return { ledger: next, changed: false };
  }
  if (!from.includes(task.status)) throw new LedgerError(`${id} is ${task.status}; cannot ${cmd}`);

  if (cmd === 'start') {
    for (const dep of task.deps) {
      const status = next.tasks.find((t) => t.id === dep)?.status ?? 'unknown';
      if (!FINISHED.has(status)) throw new LedgerError(`${id} depends on ${dep} (${status})`);
    }
  }

  let note = null;
  if (cmd === 'block' || cmd === 'drop' || cmd === 'reopen') { task.reason = text; note = text; }
  if (cmd === 'start' || cmd === 'restore') task.reason = null;
  // A task reaches done with commits already recorded only after a reopen: the new sha replaces them, so a sha lost to
  // rewritten history is fixed with reopen + done --commit <new>.
  if (cmd === 'done') task.commits = [text];
  if (cmd === 'reopen' || cmd === 'restore') next.state = 'active';
  task.history.push({ at: now, from: task.status, to, note });
  task.status = to;
  return { ledger: next, changed: true };
}

// `retier`: raises a task's effective tier to `tier` and records `reason` as the task's history note (the status stays).
// The same tier (null counting as standard) changes nothing; a lower one, an unknown task or tier and a missing reason
// throw. The declared tier is never touched, and no path lowers the effective one.
export function retier(ledger, id, tier, reason, now) {
  const next = structuredClone(ledger);
  const task = next.tasks.find((t) => t.id === id);
  if (!task) throw new LedgerError(`unknown task ${id}`);
  if (!TIERS.includes(tier)) throw new LedgerError(`unknown tier "${tier}" (expected ${TIERS.join(', ')})`);
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new LedgerError(`${id}: retier requires a reason`);
  const current = task.effectiveTier ?? null;
  if (rankOf(tier) === rankOf(current)) return { ledger: next, changed: false };
  if (rankOf(tier) < rankOf(current)) {
    throw new LedgerError(`${id}: cannot lower the tier from ${current ?? 'standard'} to ${tier}`);
  }
  task.effectiveTier = tier;
  task.history.push({ at: now, from: task.status, to: task.status, note: text });
  return { ledger: next, changed: true };
}

// ---- Views (spec §6.2 `render`, `status`, `next`, `check`) ----

const START = '<!-- tasks:start -->';
const END = '<!-- tasks:end -->';
const STATUSES = new Set(['pending', 'in_progress', 'in_review', 'done', 'blocked', 'dropped']);
const PLAN_STATES = new Set(['active', 'done']);
const NO_ACTIVE = '## Active plan\n\nNo active plan.';

// done and total (every task except dropped ones) of one ledger: the numbers renderSection and statusLine show.
export const counts = (ledger) => ({
  done: ledger.tasks.filter((t) => t.status === 'done').length,
  total: ledger.tasks.filter((t) => t.status !== 'dropped').length,
});
const withStatus = (ledger, status) => ledger.tasks.filter((t) => t.status === status);

// The first pending task, in ledger order, whose deps are all done or dropped (an unknown dep is unmet).
export function nextTask(ledger) {
  const byId = new Map(ledger.tasks.map((t) => [t.id, t]));
  return ledger.tasks.find((t) => t.status === 'pending'
    && t.deps.every((d) => FINISHED.has(byId.get(d)?.status))) ?? null;
}

function renderPlan(name, ledger) {
  const { done, total } = counts(ledger);
  const titled = (ts) => ts.map((t) => `${t.id} ${t.title}`).join('; ');
  const reasoned = (ts) => ts.map((t) => `${t.id} ${t.title} — ${t.reason}`).join('; ');
  const next = nextTask(ledger);
  const lines = [
    ['In progress', titled(withStatus(ledger, 'in_progress'))],
    ['In review', titled(withStatus(ledger, 'in_review'))],
    ['Blocked', reasoned(withStatus(ledger, 'blocked'))],
    ['Dropped', reasoned(withStatus(ledger, 'dropped'))],
    ['Next', next ? `${next.id} ${next.title}` : ''],
  ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  return [`### ${name} — ${done}/${total} done`, ...lines].join('\n');
}

// The status.md "Active plan" section body (markers excluded): active ledgers only, newest name first.
export function renderSection(ledgers) {
  const active = ledgers.filter((l) => l.ledger.state !== 'done')
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  if (!active.length) return NO_ACTIVE;
  return ['## Active plan', ...active.map((l) => renderPlan(l.name, l.ledger))].join('\n\n');
}

// Locates the managed section: null when neither marker is present; throws when an end marker has no start before
// it (misordered) or the start marker has no end after it (unterminated).
function findSection(text) {
  const start = text.indexOf(START);
  const firstEnd = text.indexOf(END);
  if (firstEnd !== -1 && (start === -1 || firstEnd < start)) {
    throw new LedgerError('status.md tasks section is misordered');
  }
  if (start === -1) return null;
  const end = text.indexOf(END, start + START.length);
  if (end === -1) throw new LedgerError('status.md tasks section is unterminated');
  return { inner: start + START.length, end };
}

export function upsertStatusSection(statusText, body) {
  // A marker inside the body would end the section early on the next upsert and grow status.md every render.
  if (body.includes(START) || body.includes(END)) throw new LedgerError('task text contains a tasks section marker');
  const at = findSection(statusText);
  if (!at) {
    const base = statusText.endsWith('\n') ? statusText : `${statusText}\n`;
    return `${base}\n${START}\n${body}\n${END}\n`;
  }
  return `${statusText.slice(0, at.inner)}\n${body}\n${statusText.slice(at.end)}`;
}

export function statusLine(name, ledger) {
  const { done, total } = counts(ledger);
  const tagged = (t) => (t.effectiveTier ? `${t.id} [${t.effectiveTier}]` : t.id);
  const inProgress = withStatus(ledger, 'in_progress').map(tagged).join(', ') || 'none';
  const nt = nextTask(ledger);
  const next = nt ? tagged(nt) : 'none';
  return `${name}: ${done}/${total} done · in progress: ${inProgress} · next: ${next}`;
}

// Schema drift of one ledger in any plan state: version, plan state, task statuses and histories.
export function checkSchema(ledger) {
  const drift = [];
  if (ledger.version !== 1) drift.push(`unsupported ledger version ${ledger.version} (expected 1)`);
  if (!PLAN_STATES.has(ledger.state)) drift.push(`unknown plan state "${ledger.state}"`);
  if (!Array.isArray(ledger.tasks)) drift.push('ledger tasks is not an array');
  for (const t of Array.isArray(ledger.tasks) ? ledger.tasks : []) {
    if (!STATUSES.has(t.status)) drift.push(`${t.id} has unknown status "${t.status}"`);
    if (!Array.isArray(t.history)) drift.push(`${t.id} history is not an array`);
    // Absent (a ledger written before tiers) and null (undeclared) are both clean.
    if (t.tier != null && !TIERS.includes(t.tier)) drift.push(`${t.id} has unknown tier "${t.tier}"`);
    if (t.effectiveTier != null && !TIERS.includes(t.effectiveTier)) drift.push(`${t.id} has unknown effective tier "${t.effectiveTier}"`);
  }
  return drift;
}

// Drift of status.md's managed section against `renderedBody`: [] when equal (trimmed), the stale message when it
// differs or is absent, the LedgerError message when the markers are misordered or unterminated.
export function checkSection(statusText, renderedBody) {
  try {
    const at = findSection(statusText);
    if (at && statusText.slice(at.inner, at.end).trim() === renderedBody.trim()) return [];
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    return [e.message]; // misordered or unterminated: render would refuse it too
  }
  return ['status.md Active plan section is stale — run triqual tasks render'];
}

// Drift messages for one ledger, empty when clean. Never throws on a malformed plan, ledger or status text.
// A commit recorded from another repository is the string `ext:<path relative to this repo's root>@<sha>`, so no
// home-directory path enters a ledger. Parsed at the last `@`; null for any other string (a plain sha, a malformed form).
export const EXTERNAL_PREFIX = 'ext:';
export function parseExternalCommit(commit) {
  if (typeof commit !== 'string' || !commit.startsWith(EXTERNAL_PREFIX)) return null;
  const at = commit.lastIndexOf('@');
  const path = commit.slice(EXTERNAL_PREFIX.length, at);
  const sha = commit.slice(at + 1);
  return at === -1 || !path || !sha ? null : { path, sha };
}

// `commitExists(sha)` answers for a commit of this repo; for an external one it is called as `commitExists(sha, path)`
// and answers true, false, or null when the path cannot be checked (it is then a `warn` message, never drift).
export function checkLedger({ ledger, planText, statusText, renderedBody, commitExists, warn }) {
  const drift = checkSchema(ledger);
  const tasks = Array.isArray(ledger.tasks) ? ledger.tasks : [];

  let planTasks = null;
  try {
    planTasks = parsePlan(planText);
  } catch (e) {
    drift.push(`plan: ${e.message}`);
  }
  if (planTasks) {
    const ledgerById = new Map(tasks.map((t) => [t.id, t]));
    for (const p of planTasks) {
      const t = ledgerById.get(p.id);
      if (!t) drift.push(`${p.id} is in the plan but not in the ledger — run triqual tasks init`);
      else if (t.title !== p.title) {
        drift.push(`${p.id} title differs: plan "${p.title}", ledger "${t.title}" — run triqual tasks retitle`);
      }
    }
    const planIds = new Set(planTasks.map((p) => p.id));
    // Dropping is how a removal is recorded, so a dropped task missing from the plan is not drift.
    for (const t of tasks) {
      if (!planIds.has(t.id) && t.status !== 'dropped') {
        drift.push(`${t.id} is not in the plan — restore the heading or drop the task`);
      }
    }
  }

  // A role outside the task roles (a typo, a reviewer role) is drift while the task can still be dispatched: SDD stops
  // and asks instead. A done or dropped task's role no longer drives anything, and triqual cannot change it any more.
  for (const t of tasks.filter((x) => !FINISHED.has(x.status))) {
    const role = roleOf(t);
    if (!TASK_ROLES.includes(role)) drift.push(`${t.id} has role "${role}", not a task role (${TASK_ROLES.join(', ')})`);
  }

  drift.push(...checkSection(statusText, renderedBody));

  if (ledger.state === 'active') {
    for (const t of tasks) {
      for (const commit of Array.isArray(t.commits) ? t.commits : []) {
        const ext = parseExternalCommit(commit);
        if (!ext) {
          if (!commitExists(commit)) drift.push(`${t.id} commit ${String(commit).slice(0, 7)} does not resolve`);
          continue;
        }
        const found = commitExists(ext.sha, ext.path);
        if (found === null) warn?.(`external commit not checkable: ${ext.path}@${ext.sha}`);
        else if (!found) drift.push(`${t.id} commit ${ext.sha.slice(0, 7)} does not resolve in ${ext.path}`);
      }
    }
  }
  return drift;
}
