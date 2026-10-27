// Run-board view logic: pure functions from snapshots and viewer state to what the page shows. No DOM, no globals.

export const STATUS = {
  in_progress: { glyph: '◐', label: 'In progress' },
  in_review: { glyph: '◉', label: 'In review' },
  blocked: { glyph: '⊘', label: 'Blocked' },
  pending: { glyph: '○', label: 'Pending' },
  done: { glyph: '✓', label: 'Done' },
  dropped: { glyph: '–', label: 'Dropped' },
};

const LEGEND_ORDER = ['done', 'in_review', 'in_progress', 'blocked', 'pending', 'dropped'];
const CHIP_ORDER = ['blocked', 'in_progress', 'in_review', 'pending', 'done', 'dropped'];
const OPEN_ORDER = ['blocked', 'in_progress', 'in_review', 'pending'];
const HEADLINE_ORDER = ['in_progress', 'in_review', 'blocked', 'pending'];
const REASON_STATUSES = new Set(['blocked', 'dropped']);
// Above this many tasks the rail cells drop their glyph and id.
const GLYPH_MAX_TASKS = 20;

const infoOf = (status) => STATUS[status] ?? { glyph: '?', label: status };
const countOf = (plan, status) => plan.tasks.filter((t) => t.status === status).length;

export function pickRepo(snaps, rememberedRoot, firstLoad, nowMs) {
  const remembered = snaps.find((s) => s.repo.root === rememberedRoot);
  if (remembered) return remembered;
  if (firstLoad && !rememberedRoot) {
    const groups = activity(snaps, nowMs);
    return groups.running[0] ?? groups.working[0] ?? snaps[0] ?? null;
  }
  return snaps[0] ?? null;
}

export function nowItems(snaps, nowMs) {
  return snaps.flatMap((s) => (s.plans ?? [])
    .filter((p) => p.state === 'active')
    .flatMap((p) => p.tasks.filter((t) => t.status === 'in_progress').map((t) => ({
      repoRoot: s.repo.root, repoName: s.repo.name, planName: p.name,
      taskId: t.id, title: t.title, since: t.since ?? null,
      elapsedMs: t.since == null ? null : nowMs - t.since, agents: agentCount(s.sessions ?? [], nowMs),
    }))))
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}

export function waitingCount(snaps) {
  return snaps.reduce((sum, s) => sum + (s.plans ?? []).reduce((n, p) => n + countOf(p, 'blocked'), 0), 0);
}

export function activity(snaps, nowMs) {
  const groups = { running: [], working: [], idle: [] };
  const newest = (s) => Math.max(0,
    ...(s.plans ?? []).flatMap((p) => p.tasks.map((t) => t.since ?? 0)),
    ...(s.sessions ?? []).map((session) => session.lastAt ?? 0));
  for (const s of snaps) {
    const running = agentCount(s.sessions ?? [], nowMs) > 0;
    const working = nowItems([s], nowMs).length > 0;
    groups[running ? 'running' : working ? 'working' : 'idle'].push(s);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => newest(b) - newest(a));
  return groups;
}

// ---- The project board: one row per repo, grouped into lanes by what the viewer has to do ----

// A project that has a task moving but no live agent and no event for this long counts as stalled.
export const STALE_MS = 15 * 60 * 1000;
// Fixed urgency order; a project moves between lanes, the lanes never reorder.
export const LANES = [
  { key: 'needs', title: 'Needs you', hint: 'Blocked or gone silent: a person has to act', tone: 'blocked', glyph: '⊘' },
  { key: 'running', title: 'Running', hint: 'Agents are working: nothing to do', tone: 'in_progress', glyph: '◐' },
  { key: 'next', title: 'Up next', hint: 'Planned, not started', tone: 'pending', glyph: '○' },
  { key: 'quiet', title: 'Done & quiet', hint: 'Finished, nothing to watch', tone: 'done', glyph: '✓' },
];
// One state per project, shown as one word. `lane` says which lane each belongs to.
export const PROJECT_STATE = {
  blocked: { glyph: '⊘', label: 'Blocked', tone: 'blocked', lane: 'needs' },
  stale: { glyph: '!', label: 'Stalled', tone: 'dropped', lane: 'needs' },
  running: { glyph: '◐', label: 'Running', tone: 'in_progress', lane: 'running' },
  in_review: { glyph: '◉', label: 'In review', tone: 'in_review', lane: 'running' },
  next: { glyph: '○', label: 'Up next', tone: 'pending', lane: 'next' },
  done: { glyph: '✓', label: 'Done', tone: 'done', lane: 'quiet' },
};

// 'now' under 45 s, then 12m, 3h, 2d.
export function fmtAge(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const newestAt = (snap) => Math.max(0,
  ...(snap.plans ?? []).flatMap((p) => p.tasks.map((t) => t.since ?? 0)),
  ...(snap.sessions ?? []).map((session) => session.lastAt ?? 0));

// The state of a project from its shown plan's tasks, by precedence: blocked, done, stalled, running, in review, up next.
export function projectState(tasks, idleMs, agents) {
  const n = (status) => tasks.filter((t) => t.status === status).length;
  if (n('blocked') > 0) return 'blocked';
  if (tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'dropped')) return 'done';
  const moving = n('in_progress') + n('in_review') > 0;
  if (moving && agents === 0 && idleMs != null && idleMs > STALE_MS) return 'stale';
  if (n('in_progress') > 0) return 'running';
  if (n('in_review') > 0) return 'in_review';
  return 'next';
}

// What a project row shows: its active plan (else the newest), the state and the one line of "what now".
export function projectOf(snap, nowMs) {
  const plans = orderPlans(snap.plans ?? []);
  const plan = plans[0] ?? null;
  const tasks = plan?.tasks ?? [];
  const newest = newestAt(snap);
  const idleMs = newest === 0 ? null : Math.max(0, nowMs - newest);
  const agents = agentCount(snap.sessions ?? [], nowMs);
  const state = projectState(tasks, idleMs, agents);
  const first = (status) => tasks.find((t) => t.status === status);
  const cur = first('in_progress') ?? first('in_review');
  const label = (t) => `${t.id} · ${t.title ?? ''}`.trim();
  const blocked = first('blocked');
  const next = first('pending');
  const line = {
    blocked: blocked ? `${blocked.id} · ${blocked.reason ?? 'blocked, no reason given'}` : 'Blocked',
    stale: `No activity for ${fmtAge(idleMs)}${cur ? ` · ${label(cur)}` : ''}`,
    running: cur ? label(cur) : 'Running',
    in_review: cur ? `${label(cur)} (in review)` : 'In review',
    done: `All ${tasks.length} tasks done`,
    next: !plan ? 'No plan yet' : next ? `Next: ${label(next)}` : 'Nothing planned',
  }[state];
  return {
    root: snap.repo.root, name: snap.repo.name, branch: snap.repo.branch ?? null, mode: snap.repo.mode,
    planName: plan?.name ?? null, otherPlans: Math.max(0, plans.length - 1),
    tasks: tasks.map((t) => ({ id: t.id, status: t.status })),
    done: tasks.filter((t) => t.status === 'done').length, total: tasks.length,
    state, idleMs, agents, line, currentId: (state === 'blocked' ? blocked?.id : cur?.id) ?? null,
  };
}

// The lanes with their projects; empty lanes stay in the list so the summary can show a zero.
// Needs you: blocked before stalled, longest waiting first. Others: most recent first. Name breaks every tie.
export function boardLanes(snaps, nowMs) {
  const projects = snaps.map((s) => projectOf(s, nowMs));
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return LANES.map((lane) => {
    const mine = projects.filter((p) => PROJECT_STATE[p.state].lane === lane.key);
    mine.sort(lane.key === 'needs'
      ? (a, b) => (a.state === 'blocked' ? 0 : 1) - (b.state === 'blocked' ? 0 : 1) || (b.idleMs ?? 0) - (a.idleMs ?? 0) || byName(a, b)
      : (a, b) => (a.idleMs ?? Infinity) - (b.idleMs ?? Infinity) || byName(a, b));
    return { ...lane, projects: mine };
  });
}

// Active plans first, then newest name first.
export function orderPlans(plans) {
  const rank = (p) => (p.state === 'active' ? 0 : 1);
  return [...plans].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export function pickPlan(plans, rememberedName) {
  return plans.find((p) => p.name === rememberedName) ?? orderPlans(plans)[0] ?? null;
}

export function planTitle(name) {
  const m = /^(\d{4}-\d{2}-\d{2})-(.*)$/.exec(name);
  return m ? { date: m[1], title: m[2].replace(/-/g, ' ') } : { date: null, title: name.replace(/-/g, ' ') };
}

// The task to look at now: the first in_progress id, else the first in_review id + " review", else `done` when every
// non-dropped task is done, else (no pending task left) the first blocked id + " blocked". With pending tasks and nothing
// moving it is null: the next task depends on task dependencies, which the snapshot does not carry.
export function currentOf(plan) {
  const first = (status) => plan.tasks.find((t) => t.status === status);
  if (first('in_progress')) return first('in_progress').id;
  if (first('in_review')) return `${first('in_review').id} review`;
  if (plan.done === plan.total) return 'done';
  if (first('pending')) return null;
  if (first('blocked')) return `${first('blocked').id} blocked`;
  return 'stalled';
}

export function headline(plan) {
  if (plan.state === 'done') return 'Plan done';
  if (plan.total === 0) return 'No tasks';
  if (plan.done === plan.total) return 'Plan complete';
  return HEADLINE_ORDER
    .map((status) => [status, countOf(plan, status)])
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${STATUS[status].label.toLowerCase()}`)
    .join(' · ');
}

export function railCells(plan) {
  const showGlyph = plan.tasks.length <= GLYPH_MAX_TASKS;
  return plan.tasks.map((t) => {
    const { glyph, label } = infoOf(t.status);
    return {
      id: t.id,
      status: t.status,
      glyph,
      label: `${t.id}${t.title ? ` ${t.title}` : ''} · ${label}`,
      pulse: t.status === 'in_progress',
      showGlyph,
    };
  });
}

export function legend(plan) {
  return LEGEND_ORDER
    .map((status) => ({ status, glyph: STATUS[status].glyph, label: STATUS[status].label, count: countOf(plan, status) }))
    .filter((l) => l.count > 0);
}

export function chips(plan) {
  const open = plan.tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped').length;
  return [
    ...(countOf(plan, 'in_progress') ? [{ key: 'running', label: 'Running', count: countOf(plan, 'in_progress') }] : []),
    { key: 'open', label: 'Open', count: open },
    { key: 'all', label: 'All', count: plan.tasks.length },
    ...CHIP_ORDER
      .map((status) => ({ key: status, label: STATUS[status].label, count: countOf(plan, status) }))
      .filter((c) => c.count > 0),
  ];
}

export function taskRows(plan, filter) {
  let tasks = plan.tasks;
  if (filter === 'running') {
    tasks = tasks.filter((t) => t.status === 'in_progress');
  } else if (filter === 'open') {
    // Array.prototype.sort is stable, so file order holds within a status.
    tasks = tasks.filter((t) => OPEN_ORDER.includes(t.status)).sort((a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status));
  } else if (filter !== 'all') {
    tasks = tasks.filter((t) => t.status === filter);
  }
  return tasks.map((t) => {
    const { glyph, label } = infoOf(t.status);
    return {
      id: t.id,
      title: t.title ?? '',
      status: t.status,
      glyph,
      label,
      tier: t.effectiveTier ?? t.tier ?? null,
      reason: REASON_STATUSES.has(t.status) ? (t.reason ?? 'no reason given') : null,
    };
  });
}

// English and Spanish labels of the body lines the entry view shows, in display order.
const FIELDS = [
  { label: 'Done', names: ['Done', 'Hecho'] },
  { label: 'Verification', names: ['Verification', 'Verificación'] },
  { label: 'Next', names: ['Next', 'Siguiente'] },
];

function fieldText(body, names) {
  const re = new RegExp(`^\\s*[-*]\\s+\\*\\*(?:${names.join('|')})(?::\\*\\*|\\*\\*:)[ \\t]*(.*)$`, 'mu');
  const m = re.exec(body);
  return m && m[1].trim() ? m[1].trim() : null;
}

export function entryView(entry) {
  const body = entry.body ?? '';
  const fields = FIELDS
    .map(({ label, names }) => ({ label, text: fieldText(body, names) }))
    .filter((f) => f.text !== null);
  return {
    date: entry.date ?? null,
    title: entry.title,
    stage: entry.stageTask ?? null,
    fields: fields.length ? fields : null,
    body,
  };
}

// The re-render key: the data without the one field that changes on every poll.
export function dataKey(snaps) {
  return JSON.stringify(snaps.map((s) => ({ ...s, generatedAt: null })));
}


const agentState = (session, nowMs) => session.endedAt != null ? 'done'
  : nowMs - session.lastAt <= 30 * 60 * 1000 ? 'running' : 'stale';
const agentKey = (session) => `${session.sessionId}/${session.agentId}`;

export function agentCount(sessions, nowMs) {
  return sessions.filter((session) => agentState(session, nowMs) === 'running').length;
}

export function feedOf(session, showNotes) {
  const events = (session.events ?? []).map((event) => ({ at: event.at, kind: event.kind.toUpperCase(), text: event.label }));
  const notes = showNotes ? (session.notes ?? []).map((note) => ({ at: note.at, kind: 'NOTE', text: note.title })) : [];
  return [...events, ...notes].sort((a, b) => b.at - a.at);
}

export function agentTree(sessions, nowMs) {
  const byKey = new Map(sessions.map((session) => [agentKey(session), session]));
  const children = new Map();
  const parentOf = (session) => {
    const controllerKey = `${session.sessionId}/`;
    if (session.agentId === '' || !byKey.has(controllerKey)) return null;
    const fallback = controllerKey;
    if (session.parentAgentId == null) return fallback;
    const parentKey = `${session.sessionId}/${session.parentAgentId}`;
    let current = session;
    const seen = new Set();
    while (current && current.agentId !== '') {
      const key = agentKey(current);
      if (seen.has(key)) return fallback;
      seen.add(key);
      if (current.parentAgentId == null) break;
      current = byKey.get(`${current.sessionId}/${current.parentAgentId}`);
    }
    return byKey.has(parentKey) ? parentKey : fallback;
  };
  for (const session of sessions) {
    const parentKey = parentOf(session);
    if (!children.has(parentKey)) children.set(parentKey, []);
    children.get(parentKey).push(session);
  }
  const rows = [];
  const visit = (session, depth, parentKey) => {
    const key = agentKey(session);
    const events = session.events ?? [];
    rows.push({ key, depth, parentKey, agentType: session.agentType, task: session.task, model: session.model,
      state: agentState(session, nowMs), elapsedMs: session.startedAt == null ? null : (session.endedAt ?? nowMs) - session.startedAt,
      latest: [...events].sort((a, b) => b.at - a.at)[0]?.label ?? null, count: events.length });
    for (const child of children.get(key) ?? []) visit(child, depth + 1, key);
  };
  for (const root of children.get(null) ?? []) visit(root, 0, null);
  return rows;
}
