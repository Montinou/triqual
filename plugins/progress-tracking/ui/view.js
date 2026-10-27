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

export function pickRepo(snaps, rememberedRoot) {
  return snaps.find((s) => s.repo.root === rememberedRoot) ?? snaps[0] ?? null;
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
    { key: 'open', label: 'Open', count: open },
    { key: 'all', label: 'All', count: plan.tasks.length },
    ...CHIP_ORDER
      .map((status) => ({ key: status, label: STATUS[status].label, count: countOf(plan, status) }))
      .filter((c) => c.count > 0),
  ];
}

export function taskRows(plan, filter) {
  let tasks = plan.tasks;
  if (filter === 'open') {
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
