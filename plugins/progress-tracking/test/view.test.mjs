import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, pickRepo, orderPlans, pickPlan, planTitle, currentOf, headline, railCells, legend, chips, taskRows, entryView, dataKey, nowItems, waitingCount, activity, agentTree, feedOf, agentCount,
  fmtAge, projectState, projectOf, boardLanes, STALE_MS,
} from '../ui/view.js';

const task = (id, status, extra = {}) => ({ id, title: `Title ${id}`, status, reason: null, tier: null, effectiveTier: null, ...extra });
const plan = (tasks, extra = {}) => {
  const done = tasks.filter((t) => t.status === 'done').length;
  const total = tasks.filter((t) => t.status !== 'dropped').length;
  return { name: '2026-10-19-p', state: 'active', done, total, tasks, ...extra };
};
const many = (n, status = 'done') => Array.from({ length: n }, (_, i) => task(`T${i + 1}`, status));

test('STATUS carries the glyph and label of every status', () => {
  assert.deepEqual(STATUS, {
    in_progress: { glyph: '◐', label: 'In progress' },
    in_review: { glyph: '◉', label: 'In review' },
    blocked: { glyph: '⊘', label: 'Blocked' },
    pending: { glyph: '○', label: 'Pending' },
    done: { glyph: '✓', label: 'Done' },
    dropped: { glyph: '–', label: 'Dropped' },
  });
});

test('pickRepo: matching root wins, unknown root falls to the first, none is null', () => {
  const snaps = [{ repo: { root: '/a' } }, { repo: { root: '/b' } }];
  assert.equal(pickRepo(snaps, '/b'), snaps[1]);
  assert.equal(pickRepo(snaps, '/gone'), snaps[0]);
  assert.equal(pickRepo(snaps, null), snaps[0]);
  assert.equal(pickRepo([], '/a'), null);
});

test('orderPlans puts active first then name descending; pickPlan falls back to the first', () => {
  const b = { name: '2026-10-20-b', state: 'done' };
  const a = { name: '2026-10-01-a', state: 'active' };
  const c = { name: '2026-10-19-c', state: 'active' };
  const input = [b, a, c];
  assert.deepEqual(orderPlans(input).map((p) => p.name), ['2026-10-19-c', '2026-10-01-a', '2026-10-20-b']);
  assert.deepEqual(input, [b, a, c], 'the input is not reordered');
  assert.equal(pickPlan(input, '2026-10-20-b'), b);
  assert.equal(pickPlan(input, 'gone'), c);
  assert.equal(pickPlan([], 'x'), null);
});

test('planTitle splits the date prefix and turns hyphens into spaces', () => {
  assert.deepEqual(planTitle('2026-10-19-fence-configurable-enforcement'), { date: '2026-10-19', title: 'fence configurable enforcement' });
  assert.deepEqual(planTitle('sp2-tracking'), { date: null, title: 'sp2 tracking' });
});

test('currentOf: the six cases', () => {
  assert.equal(currentOf(plan([task('T1', 'done'), task('T2', 'in_progress'), task('T3', 'in_review')])), 'T2');
  assert.equal(currentOf(plan([task('T1', 'done'), task('T3', 'in_review'), task('T4', 'pending')])), 'T3 review');
  assert.equal(currentOf(plan([task('T1', 'done'), task('T2', 'dropped')])), 'done');
  assert.equal(currentOf(plan([task('T1', 'done'), task('T2', 'pending')])), null);
  assert.equal(currentOf(plan([task('T1', 'done'), task('T14', 'blocked')])), 'T14 blocked');
  assert.equal(currentOf(plan([task('T1', 'done'), task('T2', 'unknown')])), 'stalled');
});

test('headline', () => {
  assert.equal(headline(plan(many(2), { state: 'done' })), 'Plan done');
  assert.equal(headline(plan([])), 'No tasks');
  assert.equal(headline(plan(many(3))), 'Plan complete');
  const mixed = plan([task('T1', 'done'), task('T2', 'in_progress'), task('T3', 'in_review'), task('T4', 'pending'), task('T5', 'pending'), task('T6', 'pending')]);
  assert.equal(headline(mixed), '1 in progress · 1 in review · 3 pending');
  const blocked = plan([task('T1', 'in_progress'), task('T2', 'blocked'), task('T3', 'pending')]);
  assert.equal(headline(blocked), '1 in progress · 1 blocked · 1 pending');
});

test('railCells: glyphs up to 20 tasks, pulse only on in_progress, labels with the title', () => {
  const cells = railCells(plan([task('T1', 'done', { title: 'Alpha' }), ...many(14, 'pending').map((t, i) => ({ ...t, id: `T${i + 2}`, status: i === 0 ? 'in_progress' : 'pending' }))]));
  assert.equal(cells.length, 15);
  assert.ok(cells.every((c) => c.showGlyph === true));
  assert.deepEqual(cells[0], { id: 'T1', status: 'done', glyph: '✓', label: 'T1 Alpha · Done', pulse: false, showGlyph: true });
  assert.deepEqual(cells.filter((c) => c.pulse).map((c) => c.id), ['T2']);
});

test('railCells: above 20 tasks no glyph shows; a null title leaves the id and status', () => {
  assert.ok(railCells(plan(many(21))).every((c) => c.showGlyph === false));
  assert.ok(railCells(plan(many(20))).every((c) => c.showGlyph === true));
  assert.equal(railCells(plan([task('T1', 'done', { title: null })]))[0].label, 'T1 · Done');
  assert.deepEqual(railCells(plan([])), []);
});

test('legend: fixed order, zero counts omitted', () => {
  const p = plan([task('T1', 'pending'), task('T2', 'done'), task('T3', 'done'), task('T4', 'blocked'), task('T5', 'dropped'), task('T6', 'in_review'), task('T7', 'in_progress')]);
  assert.deepEqual(legend(p).map((l) => [l.status, l.count]), [['done', 2], ['in_review', 1], ['in_progress', 1], ['blocked', 1], ['pending', 1], ['dropped', 1]]);
  assert.deepEqual(legend(plan([task('T1', 'done')])), [{ status: 'done', glyph: '✓', label: 'Done', count: 1 }]);
  assert.deepEqual(legend(plan([])), []);
});

test('chips: open excludes done and dropped, all counts every task, then non-empty statuses', () => {
  const p = plan([task('T1', 'done'), task('T2', 'dropped'), task('T3', 'pending'), task('T4', 'blocked'), task('T5', 'pending')]);
  assert.deepEqual(chips(p), [
    { key: 'open', label: 'Open', count: 3 },
    { key: 'all', label: 'All', count: 5 },
    { key: 'blocked', label: 'Blocked', count: 1 },
    { key: 'pending', label: 'Pending', count: 2 },
    { key: 'done', label: 'Done', count: 1 },
    { key: 'dropped', label: 'Dropped', count: 1 },
  ]);
  assert.deepEqual(chips(plan([])).map((c) => [c.key, c.count]), [['open', 0], ['all', 0]]);
});

test('taskRows: open sorts by status and keeps file order; fields; reasons; filters', () => {
  const p = plan([
    task('T1', 'pending'), task('T2', 'done'), task('T3', 'in_review'), task('T4', 'blocked', { reason: 'waiting' }),
    task('T5', 'in_progress', { tier: 'standard', effectiveTier: 'light' }), task('T6', 'blocked'), task('T7', 'pending', { title: null, tier: 'heavy' }),
    task('T8', 'dropped', { reason: 'out of scope' }),
  ]);
  const open = taskRows(p, 'open');
  assert.deepEqual(open.map((r) => r.id), ['T4', 'T6', 'T5', 'T3', 'T1', 'T7']);
  const byId = Object.fromEntries(taskRows(p, 'all').map((r) => [r.id, r]));
  assert.equal(taskRows(p, 'all').length, 8);
  assert.equal(byId.T7.title, '');
  assert.equal(byId.T7.tier, 'heavy');
  assert.equal(byId.T5.tier, 'light');
  assert.equal(byId.T4.reason, 'waiting');
  assert.equal(byId.T6.reason, 'no reason given');
  assert.equal(byId.T1.reason, null);
  assert.equal(byId.T8.reason, 'out of scope');
  assert.deepEqual(byId.T2, { id: 'T2', title: 'Title T2', status: 'done', glyph: '✓', label: 'Done', tier: null, reason: null });
  assert.deepEqual(taskRows(p, 'done').map((r) => r.id), ['T2']);
});

test('entryView reads Done, Verification and Next in order', () => {
  const v = entryView({ date: '2026-10-26', title: 'T', stageTask: 'Plan x · T1', body: '- **Stage/task:** Plan x · T1\n- **Done:** a\n- **Files:** f\n- **Verification:** b\n- **Next:** c' });
  assert.deepEqual(v, {
    date: '2026-10-26',
    title: 'T',
    stage: 'Plan x · T1',
    fields: [{ label: 'Done', text: 'a' }, { label: 'Verification', text: 'b' }, { label: 'Next', text: 'c' }],
    body: '- **Stage/task:** Plan x · T1\n- **Done:** a\n- **Files:** f\n- **Verification:** b\n- **Next:** c',
  });
});

test('entryView reads the Spanish labels and keeps fields null when none parse', () => {
  const es = entryView({ date: null, title: 'T', stageTask: null, body: '- **Hecho:** a\n- **Verificación:** b\n- **Siguiente:** c' });
  assert.deepEqual(es.fields, [{ label: 'Done', text: 'a' }, { label: 'Verification', text: 'b' }, { label: 'Next', text: 'c' }]);
  assert.equal(es.stage, null);
  const none = entryView({ date: '2026-10-26', title: 'T', stageTask: 'S', body: 'free text\nonly' });
  assert.equal(none.fields, null);
  assert.equal(none.body, 'free text\nonly');
  assert.equal(none.stage, 'S');
});

test('dataKey ignores generatedAt and changes with the data', () => {
  const snap = (generatedAt, status) => [{ generatedAt, repo: { root: '/a' }, plans: [plan([task('T1', status)])] }];
  assert.equal(dataKey(snap('2026-10-26T10:00:00Z', 'done')), dataKey(snap('2026-10-26T10:00:05Z', 'done')));
  assert.notEqual(dataKey(snap('2026-10-26T10:00:00Z', 'done')), dataKey(snap('2026-10-26T10:00:00Z', 'pending')));
});


const snap = (root, tasks = [], sessions = [], extraPlans = []) => ({ repo: { root, name: root.slice(1) }, plans: [plan(tasks), ...extraPlans], sessions });

test('chips has a running chip and taskRows running returns in-progress tasks', () => {
  const p = plan([task('T1', 'in_progress'), task('T2', 'pending'), task('T3', 'in_progress')]);
  assert.deepEqual(chips(p)[0], { key: 'running', label: 'Running', count: 2 });
  assert.deepEqual(taskRows(p, 'running').map(t => t.id), ['T1', 'T3']);
  assert.ok(!chips(plan([])).some(c => c.key === 'running'));
});

test('nowItems lists in-progress tasks across repos newest first', () => {
  const snaps = [snap('/a', [task('T1', 'in_progress', { since: 10 }), task('T2', 'blocked')], [], [plan([task('T9', 'in_progress', { since: 99 })], { state: 'done' })]), snap('/b', [task('T3', 'in_progress', { since: 20 })])];
  assert.deepEqual(nowItems(snaps, 100), [
    { repoRoot: '/b', repoName: 'b', planName: '2026-10-19-p', taskId: 'T3', title: 'Title T3', since: 20, elapsedMs: 80, agents: 0 },
    { repoRoot: '/a', repoName: 'a', planName: '2026-10-19-p', taskId: 'T1', title: 'Title T1', since: 10, elapsedMs: 90, agents: 0 },
  ]);
  assert.equal(waitingCount(snaps), 1);
});

test('nowItems is empty when nothing runs', () => {
  assert.deepEqual(nowItems([snap('/a', [task('T1', 'pending')])], 100), []);
  assert.deepEqual(nowItems([], 100), []);
  assert.equal(waitingCount([]), 0);
});

test('activity groups running, working and idle', () => {
  const now = 4_000_000;
  const idle = snap('/idle');
  const older = snap('/older', [task('T1', 'in_progress', { since: 10 })]);
  const newer = snap('/newer', [task('T2', 'in_progress', { since: 20 })]);
  const running = snap('/running', [], [{ lastAt: now - 1_800_000, endedAt: null }]);
  const recent = snap('/recent', [], [{ lastAt: now, endedAt: null }]);
  const stale = snap('/stale', [], [{ lastAt: now - 1_800_001, endedAt: null }]);
  const done = snap('/done', [], [{ lastAt: now, endedAt: now }]);
  const input = [idle, older, running, stale, newer, done, recent];
  assert.deepEqual(activity(input, now), { running: [recent, running], working: [newer, older], idle: [done, stale, idle] });
  assert.deepEqual(input.map(s => s.repo.root), ['/idle', '/older', '/running', '/stale', '/newer', '/done', '/recent']);
});

test('pickRepo opens the most active repo only on first load', () => {
  const a = snap('/a');
  const b = snap('/b', [task('T1', 'in_progress', { since: 10 })]);
  const c = snap('/c', [], [{ lastAt: 100, endedAt: null }]);
  assert.equal(pickRepo([a, b, c], null, true, 100), c);
  assert.equal(pickRepo([a, b], null, true, 100), b);
  assert.equal(pickRepo([a, b, c], '/a', true, 100), a);
  assert.equal(pickRepo([a, b, c], null, false, 100), a);
  assert.equal(pickRepo([a, b, c], '/gone', true, 100), a);
});

const agent = (agentId, parentAgentId = null, extra = {}) => ({ sessionId: 's', agentId, parentAgentId, agentType: agentId || 'controller', task: null, model: null, startedAt: 10, lastAt: 100, endedAt: null, events: [], ...extra });

test('a controller, an orchestrator and two workers give four entries in parent/child order', () => {
  const rows = agentTree([agent('w2', 'o'), agent('o', ''), agent(''), agent('w1', 'o')], 100);
  assert.deepEqual(rows.map(r => [r.key, r.depth, r.parentKey]), [['s/', 0, null], ['s/o', 1, 's/'], ['s/w2', 2, 's/o'], ['s/w1', 2, 's/o']]);
  assert.equal(rows[0].count, 0);
  assert.equal(rows[0].elapsedMs, 90);
});

test('a cycle in parent links renders each card once', () => {
  const rows = agentTree([agent('a', 'b'), agent('b', 'a'), agent('self', 'self'), agent('')], 100);
  assert.deepEqual(rows.map(r => [r.key, r.parentKey]), [['s/', null], ['s/a', 's/'], ['s/b', 's/'], ['s/self', 's/']]);
  assert.equal(new Set(rows.map(r => r.key)).size, 4);
});

test('a child with an unknown parent hangs under the controller', () => {
  assert.equal(agentTree([agent('x', 'missing'), agent('')], 100)[1].parentKey, 's/');
  assert.equal(agentTree([agent('x')], 100)[0].parentKey, null);
  assert.equal(agentTree([agent('x'), agent('')], 100)[1].parentKey, 's/');
});

test('state is running, stale or done by the 30-minute rule', () => {
  const now = 4_000_000;
  const rows = agentTree([agent('', null, { lastAt: now - 1_800_000 }), agent('stale', '', { lastAt: now - 1_800_001 }), agent('done', '', { endedAt: 80 })], now);
  assert.deepEqual(rows.map(r => r.state), ['running', 'stale', 'done']);
  assert.equal(rows[2].elapsedMs, 70);
  assert.equal(agentCount([agent('', null, { lastAt: now }), agent('old', '', { lastAt: 0 })], now), 1);
});

test('feedOf lists events newest first and adds notes only when asked', () => {
  const row = agent('', null, { events: [{ at: 10, kind: 'start', label: 'start' }, { at: 30, kind: 'tool', label: 'Read f' }], notes: [{ at: 20, type: 'decision', title: 'Use ids' }] });
  assert.deepEqual(feedOf(row, false), [{ at: 30, kind: 'TOOL', text: 'Read f' }, { at: 10, kind: 'START', text: 'start' }]);
  assert.deepEqual(feedOf(row, true).map(r => [r.at, r.kind, r.text]), [[30, 'TOOL', 'Read f'], [20, 'NOTE', 'Use ids'], [10, 'START', 'start']]);
});

test('nowItems counts running agents for the repo', () => {
  const now = 4_000_000;
  const sessions = [agent('', null, { lastAt: now }), agent('a', '', { lastAt: now }), agent('b', '', { lastAt: 0 }), agent('c', '', { lastAt: now, endedAt: now })];
  assert.equal(nowItems([snap('/a', [task('T1', 'in_progress')], sessions)], now)[0].agents, 2);
  assert.equal(activity([snap('/a', [], sessions)], now).running.length, 1);
});

test('fmtAge is now, minutes, hours, then days', () => {
  assert.deepEqual([null, 0, 44_000, 60_000, 59 * 60_000, 3_600_000, 23 * 3_600_000, 48 * 3_600_000].map(fmtAge), ['', 'now', 'now', '1m', '59m', '1h', '23h', '2d']);
});

test('projectState applies its precedence: blocked, done, stalled, running, in review, up next', () => {
  const quiet = STALE_MS + 1;
  assert.equal(projectState([task('T1', 'blocked'), task('T2', 'in_progress')], 0, 1), 'blocked');
  assert.equal(projectState([task('T1', 'done'), task('T2', 'dropped')], quiet, 0), 'done');
  assert.equal(projectState([task('T1', 'in_progress')], quiet, 0), 'stale');
  assert.equal(projectState([task('T1', 'in_progress')], quiet, 1), 'running', 'a live agent is proof of life');
  assert.equal(projectState([task('T1', 'in_progress')], STALE_MS, 0), 'running', 'exactly the limit is not stalled yet');
  assert.equal(projectState([task('T1', 'in_review')], 0, 0), 'in_review');
  assert.equal(projectState([task('T1', 'pending')], quiet, 0), 'next', 'idle pending work is only up next, never stalled');
  assert.equal(projectState([], null, 0), 'next');
});

test('projectOf shows the active plan, its one line and how many plans are hidden', () => {
  const s = snap('/a', [], []);
  s.repo.name = 'a'; s.repo.branch = 'feat/x';
  s.plans = [
    plan([task('T1', 'done')], { name: '2026-10-01-old', state: 'done' }),
    plan([task('T1', 'done'), task('T2', 'in_progress', { since: 900_000 }), task('T3', 'pending')], { name: '2026-10-20-new' }),
  ];
  const p = projectOf(s, 1_000_000);
  assert.deepEqual([p.planName, p.otherPlans, p.state, p.line, p.currentId, p.done, p.total, p.idleMs], ['2026-10-20-new', 1, 'running', 'T2 · Title T2', 'T2', 1, 3, 100_000]);
  s.plans[1].tasks[1].status = 'blocked'; s.plans[1].tasks[1].reason = 'needs a token';
  const b = projectOf(s, 1_000_000);
  assert.deepEqual([b.state, b.line, b.currentId], ['blocked', 'T2 · needs a token', 'T2']);
  assert.equal(projectOf({ ...s, plans: [] }, 1).line, 'No plan yet');
});

test('boardLanes keeps the lane order and sorts rows by urgency, then recency, then name', () => {
  const mk = (root, tasks, since) => { const s = snap(root, [], []); s.repo.name = root.slice(1); s.plans = [plan(tasks)]; if (since) s.plans[0].tasks[0].since = since; return s; };
  const now = 10_000_000;
  const lanes = boardLanes([
    mk('/b-run', [task('T1', 'in_progress')], now - 1000), mk('/a-run', [task('T1', 'in_progress')], now - 1000),
    mk('/stale', [task('T1', 'in_progress')], now - 2 * STALE_MS), mk('/blocked', [task('T1', 'blocked')], now - 5 * STALE_MS),
    mk('/done', [task('T1', 'done')], now), mk('/next', [task('T1', 'pending')], now - 10),
  ], now);
  assert.deepEqual(lanes.map((l) => l.key), ['needs', 'running', 'next', 'quiet']);
  assert.deepEqual(lanes.map((l) => l.projects.map((p) => p.name)), [['blocked', 'stale'], ['a-run', 'b-run'], ['next'], ['done']]);
});
