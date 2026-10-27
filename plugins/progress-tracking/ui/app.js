// The run board: a read-only page over the /api/events snapshot stream. view.js turns snapshots and viewer choices into what the page shows; this module only builds the DOM,
// receives messages and keeps the viewer's choices. Data goes in as textContent or attribute values, never as markup; dynamic
// visual values go through style.setProperty on a custom property, so the page needs no inline style (CSP default-src 'self').
import {
  chips, currentOf, dataKey, entryView, headline, legend, pickPlan, pickRepo, planTitle, railCells, taskRows, orderPlans, nowItems, waitingCount, activity,
} from './view.js';

const HIGHLIGHT_MS = 1600;
const LATEST_ENTRIES = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

const shortName = (name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
const clock = (date) => date.toTimeString().slice(0, 8);

// env = { document, EventSource, setTimeout, clearTimeout, now }. All state lives in this closure; the env functions are
// always called unbound.
export function mount(env) {
  const { document, EventSource, setTimeout, clearTimeout, now } = env;
  const top = document.getElementById('top');
  const repoSlot = document.getElementById('repo-slot');
  const updated = document.getElementById('updated');
  const banner = document.getElementById('banner');
  const app = document.getElementById('app');

  let snaps = [];
  let lastKey = null;
  let introPending = true;
  let highlightTimer = null;
  const viewer = { repo: null, planByRepo: new Map(), filter: 'running', openEntry: 0, statusOpen: false, highlight: null };
  // Controls and task rows of the render in place, by their data-key / task id.
  const keyed = new Map();
  const rowNodes = new Map();

  // Builds one element: class, text, attributes, data-key (also remembered so focus can return to it), events, custom
  // properties and children.
  function el(tag, className, { text, attrs, key, on, vars } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, String(value));
    if (key) {
      node.setAttribute('data-key', key);
      keyed.set(key, node);
    }
    for (const [type, fn] of Object.entries(on ?? {})) node.addEventListener(type, fn);
    for (const [name, value] of Object.entries(vars ?? {})) node.style.setProperty(name, value);
    if (children.length) node.append(...children);
    return node;
  }

  function svgEl(tag, attrs, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (children.length) node.append(...children);
    return node;
  }

  function logo(size) {
    const bar = (x, y, height, color) => svgEl('rect', { x, y, width: 5, height, rx: 1.5, fill: `var(--s-${color})` });
    return svgEl('svg', { width: size, height: size, viewBox: '0 0 26 26', 'aria-hidden': 'true', class: 'logo' }, [
      bar(2, 16, 8, 'done'), bar(10.5, 9, 15, 'in_progress'), bar(19, 2, 22, 'in_review'),
    ]);
  }

  function brand() {
    return el('span', 'brand', {}, [logo(26), el('b', '', { text: 'triqual' }), el('span', 'tag', { text: 'run board' })]);
  }

  // A state card: what happened and the one thing to do next (a command to copy). `mark` adds the logo above the title.
  function stateCard({ tag, title, text, command, mark = false }) {
    const intro = introPending ? ' intro' : '';
    return el('div', `card${intro}`, {}, [
      ...(mark ? [logo(40)] : []),
      ...(tag ? [el('span', 'card-tag', { text: tag })] : []),
      el('h2', '', { text: title }),
      el('p', '', { text }),
      el('code', 'code', { text: command }),
    ]);
  }

  function repoLabel(snap) {
    return `${snap.repo.mode} · ${snap.repo.branch ?? 'detached HEAD'}`;
  }

  function renderRepo(snap, nowMs) {
    if (!snap) { repoSlot.replaceChildren(); return; }
    const groups = activity(snaps, nowMs);
    const item = (s, running = false) => el('button', 'repo-pill repo-item', {
      key: `repo:${s.repo.root}`,
      attrs: { type: 'button', 'aria-pressed': s.repo.root === snap.repo.root },
      on: { click: () => { viewer.repo = s.repo.root; resetView(); renderData({ focus: `repo:${s.repo.root}` }); } },
    }, [
      ...(running ? [el('span', 'repo-dot', { attrs: { 'aria-label': 'Running' } })] : []),
      el('b', '', { text: s.repo.name }), el('span', '', { text: repoLabel(s) }),
    ]);
    repoSlot.replaceChildren(el('div', 'repo-list', { attrs: { 'aria-label': 'Repos' } }, [
      ...groups.running.map((s) => item(s, true)), ...groups.working.map((s) => item(s)),
      ...(groups.idle.length ? [el('details', 'idle-repos', {}, [
        el('summary', '', { text: `${groups.idle.length} idle` }), ...groups.idle.map((s) => item(s)),
      ])] : []),
    ]));
  }

  function nowStrip(nowMs) {
    const items = nowItems(snaps, nowMs);
    const waiting = waitingCount(snaps);
    return el('section', 'now-strip', { attrs: { 'aria-label': 'Now' } }, [
      el('h2', '', { text: 'Now' }),
      ...items.map((item) => el('button', 'now-chip', {
        key: `now:${item.repoRoot}:${item.planName}:${item.taskId}`,
        attrs: { type: 'button' },
        on: { click: () => {
          viewer.repo = item.repoRoot;
          viewer.planByRepo.set(item.repoRoot, item.planName);
          resetView();
          const plan = snaps.find((s) => s.repo.root === item.repoRoot)?.plans.find((p) => p.name === item.planName);
          pickCell(plan, item.taskId);
        } },
      }, [el('span', '', { text: `${item.repoName} · ${item.taskId} · ${item.title}` }),
        el('span', '', { text: `${item.agents} agents · ${item.elapsedMs == null ? 'elapsed unknown' : `${Math.max(0, Math.floor(item.elapsedMs / 60000))}m elapsed`}` })])),
      ...(items.length ? [] : [el('span', 'muted', { text: 'Nothing running' })]),
      ...(waiting ? [el('span', 'waiting-chip', { text: `waiting on you: ${waiting}` })] : []),
    ]);
  }

  // A different plan or repo starts from the default view.
  function resetView() {
    viewer.filter = 'running';
    viewer.openEntry = 0;
    viewer.highlight = null;
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }

  function pickTab(snap, name) {
    viewer.planByRepo.set(snap.repo.root, name);
    resetView();
    renderData({ focus: `plan:${name}` });
  }

  function pickChip(key) {
    viewer.filter = key;
    renderData({ focus: `chip:${key}` });
  }

  // A rail cell selects its task in the list: the filter widens to All when it hides the task, the row scrolls into
  // view and stays highlighted for HIGHLIGHT_MS.
  function pickCell(plan, id) {
    if (!taskRows(plan, viewer.filter).some((r) => r.id === id)) viewer.filter = 'all';
    viewer.highlight = id;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightTimer = null;
      viewer.highlight = null;
      renderData();
    }, HIGHLIGHT_MS);
    renderData({ focus: `cell:${id}`, scrollTo: id });
  }

  function pickEntry(index) {
    viewer.openEntry = viewer.openEntry === index ? -1 : index;
    renderData({ focus: `entry:${index}` });
  }

  function planSection(snap, plan, intro) {
    const plans = orderPlans(snap.plans);
    const tabs = el('div', 'tabs', { attrs: { 'aria-label': 'Plans', role: 'group' } }, plans.map((p) => el('button', 'ptab', {
      key: `plan:${p.name}`,
      attrs: { type: 'button', 'aria-pressed': p.name === plan.name, title: p.name },
      on: { click: () => pickTab(snap, p.name) },
    }, [el('span', '', { text: shortName(p.name) }), el('span', '', { text: `${p.done}/${p.total}` })])));

    const { date, title } = planTitle(plan.name);
    const current = currentOf(plan);
    // A plan whose current is a blocked task says why, right under the headline.
    const blockedReason = current?.endsWith(' blocked') ? (plan.tasks.find((t) => t.status === 'blocked')?.reason ?? null) : null;
    const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
    const hero = el('div', 'hero', {}, [
      el('div', '', {}, [
        el('span', 'hero-date', { text: date ?? '' }),
        el('h1', 'hero-title', { text: title }),
        el('span', 'headline', { text: headline(plan) }),
        ...(current === null ? [] : [el('span', 'current', { text: `▸ ${current}` })]),
        ...(blockedReason === null ? [] : [el('span', 'hero-reason', { text: blockedReason })]),
      ]),
      el('div', 'count', {}, [
        el('b', '', { text: String(plan.done) }, [el('span', '', { text: `/${plan.total}` })]),
        el('small', '', { text: `done ${pct}%` }),
      ]),
    ]);

    const rail = el('div', 'rail', { attrs: { 'aria-label': 'Tasks in order', role: 'group' } }, railCells(plan).map((c, i) => el('button', `cell s-${c.status}`, {
      key: `cell:${c.id}`,
      attrs: { type: 'button', 'aria-label': c.label, title: c.label },
      vars: { '--i': i },
      on: { click: () => pickCell(plan, c.id) },
    }, [
      el('span', `bar s-${c.status}${c.pulse ? ' pulse' : ''}`, { text: c.showGlyph ? c.glyph : '' }),
      ...(c.showGlyph ? [el('span', 'cell-id', { text: c.id })] : []),
    ])));

    const key = el('div', 'legend', {}, legend(plan).map((l) => el('span', `s-${l.status}`, {}, [
      el('span', '', { text: l.glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span', '', { text: l.label }),
      el('b', '', { text: String(l.count) }),
    ])));

    return el('section', 'panel plan', {}, [tabs, hero, rail, key]);
  }

  function nothingOpen(plan) {
    if (plan.total === 0) return 'Nothing here. This plan has no tasks yet.';
    return plan.done === plan.total ? 'Nothing here. Every task in this plan is done.' : 'Nothing here. No task in this plan is open.';
  }

  function tasksSection(plan) {
    if (!chips(plan).some((c) => c.key === viewer.filter)) viewer.filter = 'open';
    const chipNodes = chips(plan).map((c) => el('button', 'chip', {
      key: `chip:${c.key}`,
      attrs: { type: 'button', 'aria-pressed': viewer.filter === c.key },
      on: { click: () => pickChip(c.key) },
    }, [el('span', '', { text: c.label }), el('span', '', { text: String(c.count) })]));
    const rows = taskRows(plan, viewer.filter).map((r) => {
      const node = el('div', `trow s-${r.status}${viewer.highlight === r.id ? ' highlight' : ''}`, { attrs: { 'data-id': r.id } }, [
        el('span', 't-glyph', { text: r.glyph, attrs: { 'aria-hidden': 'true' } }),
        el('span', 't-id', { text: r.id }),
        el('span', 't-title', { text: r.title }),
        el('span', 't-status', { text: r.label }),
        ...(r.tier === null ? [] : [el('span', 't-tier', { text: String(r.tier) })]),
        ...(r.reason === null ? [] : [el('span', 't-reason', { text: r.reason })]),
      ]);
      rowNodes.set(r.id, node);
      return node;
    });
    const empty = rows.length > 0 || viewer.filter !== 'open' ? [] : [el('p', 'empty', { text: nothingOpen(plan) })];
    return el('section', 'panel tasks', {}, [el('div', 'chips', {}, [el('h2', '', { text: 'Tasks' }), ...chipNodes]), ...rows, ...empty]);
  }

  function entriesSection(snap) {
    const list = (snap.progress?.entries ?? []).slice(0, LATEST_ENTRIES).map((entry, i) => {
      const view = entryView(entry);
      const open = viewer.openEntry === i;
      const head = el('button', 'entry-h', {
        key: `entry:${i}`,
        attrs: { type: 'button', 'aria-expanded': open },
        on: { click: () => pickEntry(i) },
      }, [
        el('span', '', {}, [el('span', '', { text: view.date ?? '' }), el('span', '', { text: open ? '–' : '+', attrs: { 'aria-hidden': 'true' } })]),
        el('span', '', { text: view.title }),
        el('span', '', { text: view.stage ?? '' }),
      ]);
      const body = !open ? [] : [el('div', 'entry-body', {}, view.fields
        ? view.fields.map((f) => el('span', '', {}, [el('b', '', { text: f.label }), el('span', '', { text: ` ${f.text}` })]))
        : [el('pre', '', { text: view.body })])];
      return el('div', 'entry', {}, [head, ...body]);
    });
    return el('section', 'panel entries', {}, [el('h2', '', { text: 'Latest entries' }), ...list]);
  }

  function statusPanel(snap) {
    const details = el('details', 'status-panel', {}, [
      el('summary', '', { text: 'Status' }),
      el('pre', '', { text: snap.status?.text ?? '' }),
    ]);
    details.open = viewer.statusOpen;
    details.addEventListener('toggle', () => { viewer.statusOpen = details.open; });
    return details;
  }

  // Rebuilds the repo switcher and #app from the last data. `focus` is the data-key of the control a viewer action came
  // from; without it, focus stays on whichever keyed control had it. `scrollTo` is a task id to bring into view.
  function renderData({ focus = null, scrollTo = null } = {}) {
    const activeKey = document.activeElement?.getAttribute?.('data-key') ?? null;
    keyed.clear();
    rowNodes.clear();
    const nowMs = now().getTime();
    const snap = pickRepo(snaps, viewer.repo, introPending, nowMs);
    if (snap && viewer.repo === null) viewer.repo = snap.repo.root;
    renderRepo(snap, nowMs);
    const plan = snap ? pickPlan(snap.plans, viewer.planByRepo.get(snap.repo.root)) : null;
    if (!snap || !plan) {
      const card = snap
        ? stateCard({ title: 'No plans yet', text: 'This repo tracks progress, but has no plan. Write one and its tasks show up here.', command: 'triqual tracking write plan' })
        : stateCard({
          mark: true,
          title: 'No repos registered yet',
          text: 'Open a Claude Code session in a repo that tracks progress, or opt one in from its folder.',
          command: '/progress-tracking:progress-init',
        });
      introPending = false;
      app.replaceChildren(snap ? el('div', '', {}, [nowStrip(nowMs), card]) : card);
      return;
    }
    const root = el('div', introPending ? 'intro' : '', {}, [nowStrip(nowMs), planSection(snap, plan), tasksSection(plan), entriesSection(snap), statusPanel(snap)]);
    introPending = false;
    app.replaceChildren(root);
    // preventScroll: restoring focus must not move the viewport back to the control (the highlight timer and messages render too).
    (keyed.get(focus ?? activeKey))?.focus({ preventScroll: true });
    if (scrollTo !== null) rowNodes.get(scrollTo)?.scrollIntoView({ block: 'nearest' });
  }

  // The live indicator's time and the banner; written only here, so a viewer action never blanks them. Called after
  // every message: a good one stamps the time and clears the banner, a failed one (`failure`: tag, title, error, optional command) raises it
  // above the last good render.
  function renderChrome(failure) {
    if (failure) {
      banner.className = 'banner';
      banner.replaceChildren(
        el('span', 'banner-tag', { text: failure.tag }),
        el('b', 'banner-title', { text: failure.title }),
        el('span', 'banner-text', { text: `${failure.error}. ${failure.closed ? 'Reload the page to reconnect' : 'The browser will reconnect automatically'}; the last good data stays on screen.` }),
        ...(failure.command ? [el('code', 'code', { text: failure.command })] : []),
      );
      return;
    }
    updated.textContent = `· updated ${clock(now())}`;
    banner.className = '';
    banner.replaceChildren();
  }

  // Shows `data` unless it is what is on screen already. lastKey moves only after the render succeeds, so a render that
  // throws leaves the last good tree and is tried again by the next message.
  function show(data) {
    const nowMs = now().getTime();
    const key = `${dataKey(data)}:${Math.floor(nowMs / 60000)}`;
    if (key === lastKey) return;
    const previous = snaps;
    snaps = data;
    try {
      renderData();
    } catch (error) {
      snaps = previous;
      throw error;
    }
    lastKey = key;
  }

  const stream = new EventSource('/api/events');
  stream.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
      if (!Array.isArray(data)) throw new Error('unexpected response');
    } catch (error) {
      renderChrome({ tag: 'Connection lost', title: 'Cannot reach the local server', error: error?.message || 'Invalid message' });
      return;
    }
    try {
      show(data);
      renderChrome(null);
    } catch (error) {
      renderChrome({ tag: 'Display error', title: 'Cannot show the latest data', error: error?.message || 'Render failed' });
    }
  });
  stream.addEventListener('error', () => {
    renderChrome({ tag: 'Connection lost', title: 'Cannot reach the local server', error: 'Event stream disconnected', closed: stream.readyState === EventSource.CLOSED, command: 'triqual ui --open' });
  });

  let theme = 'system';
  try {
    const saved = env.localStorage?.getItem('triqual-ui:theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {}
  const themeButtons = ['system', 'light', 'dark'].map((value) => el('button', 'theme-button', {
    text: value[0].toUpperCase() + value.slice(1),
    attrs: { type: 'button', 'aria-pressed': value === theme },
    on: { click: () => {
      theme = value;
      if (value === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
      try { env.localStorage?.setItem('triqual-ui:theme', value); } catch {}
      themeButtons.forEach((button, index) => button.setAttribute('aria-pressed', ['system', 'light', 'dark'][index] === theme));
    } },
  }));
  top.append(el('div', 'theme-switch', { attrs: { role: 'group', 'aria-label': 'Theme' } }, themeButtons));
  top.prepend(brand());

}

// In a browser the page mounts itself; importing this module anywhere else (node tests) mounts nothing. The wrappers
// keep the browser functions bound to their globals.
if (globalThis.document) {
  mount({
    document: globalThis.document,
    get localStorage() { return globalThis.localStorage; },
    EventSource: globalThis.EventSource,
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    now: () => new Date(),
  });
}
