// The run board: a read-only page over /api/snapshots (tracking-snapshot@1 documents), refreshed every 5 s while the tab
// is visible. view.js turns snapshots and viewer choices into what the page shows; this module only builds the DOM,
// polls and keeps the viewer's choices. Data goes in as textContent or attribute values, never as markup; dynamic
// visual values go through style.setProperty on a custom property, so the page needs no inline style (CSP default-src 'self').
import {
  chips, currentOf, dataKey, entryView, headline, legend, pickPlan, pickRepo, planTitle, railCells, taskRows, orderPlans,
} from './view.js';

const REFRESH_MS = 5000;
const HIGHLIGHT_MS = 1600;
const LATEST_ENTRIES = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

const shortName = (name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
const clock = (date) => date.toTimeString().slice(0, 8);

// env = { document, fetch, setTimeout, clearTimeout, now }. All state lives in this closure; the env functions are
// always called unbound.
export function mount(env) {
  const { document, fetch, setTimeout, clearTimeout, now } = env;
  const top = document.getElementById('top');
  const repoSlot = document.getElementById('repo-slot');
  const updated = document.getElementById('updated');
  const banner = document.getElementById('banner');
  const app = document.getElementById('app');

  let snaps = [];
  let lastKey = null;
  let introPending = true;
  let pollTimer = null;
  let highlightTimer = null;
  let inFlight = false;
  const viewer = { repo: null, planByRepo: new Map(), filter: 'open', openEntry: 0, statusOpen: false, highlight: null };
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

  function renderRepo(snap) {
    if (!snap) {
      repoSlot.replaceChildren();
      return;
    }
    if (snaps.length > 1) {
      const options = snaps.map((s) => el('option', '', { text: `${s.repo.name} · ${repoLabel(s)}`, attrs: { value: s.repo.root } }));
      const select = el('select', 'repo-pill', { key: 'repo', attrs: { 'aria-label': 'Repo' } }, options);
      select.value = snap.repo.root;
      select.addEventListener('change', () => {
        viewer.repo = select.value;
        resetView();
        renderData({ focus: 'repo' });
      });
      repoSlot.replaceChildren(select);
      return;
    }
    repoSlot.replaceChildren(el('span', 'repo-pill', {}, [el('b', '', { text: snap.repo.name }), el('span', '', { text: repoLabel(snap) })]));
  }

  // A different plan or repo starts from the default view.
  function resetView() {
    viewer.filter = 'open';
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
    const snap = pickRepo(snaps, viewer.repo);
    renderRepo(snap);
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
      app.replaceChildren(card);
      return;
    }
    const root = el('div', introPending ? 'intro' : '', {}, [planSection(snap, plan), tasksSection(plan), entriesSection(snap), statusPanel(snap)]);
    introPending = false;
    app.replaceChildren(root);
    (keyed.get(focus ?? activeKey))?.focus();
    if (scrollTo !== null) rowNodes.get(scrollTo)?.scrollIntoView({ block: 'nearest' });
  }

  // The live indicator's time and the banner; written only here, so a viewer action never blanks them. Called after
  // every poll: a good one stamps the time and clears the banner, a failed one (`failure`: tag, title, error, optional command) raises it
  // above the last good render.
  function renderChrome(failure) {
    if (failure) {
      banner.className = 'banner';
      banner.replaceChildren(
        el('span', 'banner-tag', { text: failure.tag }),
        el('b', 'banner-title', { text: failure.title }),
        el('span', 'banner-text', { text: `${failure.error}. Retrying every 5 s; the last good data stays on screen.` }),
        ...(failure.command ? [el('code', 'code', { text: failure.command })] : []),
      );
      return;
    }
    updated.textContent = `· updated ${clock(now())}`;
    banner.className = '';
    banner.replaceChildren();
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!document.hidden) pollTimer = setTimeout(tick, REFRESH_MS);
  }

  // Shows `data` unless it is what is on screen already. lastKey moves only after the render succeeds, so a render that
  // throws leaves the last good tree and is tried again by the next poll.
  function show(data) {
    const key = dataKey(data);
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

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      let data;
      try {
        const res = await fetch('/api/snapshots');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        if (!Array.isArray(data)) throw new Error('unexpected response');
      } catch (error) {
        // The last good render stays on screen; the next poll tries again.
        renderChrome({ tag: 'Connection lost', title: 'Cannot reach the local server', error: error?.message || 'Request failed', command: 'triqual ui --open' });
        return;
      }
      try {
        show(data);
      } catch (error) {
        renderChrome({ tag: 'Display error', title: 'Cannot show the latest data', error: error?.message || 'Render failed' });
        return;
      }
      renderChrome(null);
    } finally {
      inFlight = false;
      schedule();
    }
  }

  // A hidden tab stops the loop (each poll runs git in every registered repo); becoming visible refreshes at once.
  function tick() {
    pollTimer = null;
    if (!document.hidden) refresh();
  }

  top.prepend(brand());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      pollTimer = null;
    } else {
      refresh();
    }
  });
  if (!document.hidden) refresh();
}

// In a browser the page mounts itself; importing this module anywhere else (node tests) mounts nothing. The wrappers
// keep the browser functions bound to their globals.
if (globalThis.document) {
  mount({
    document: globalThis.document,
    fetch: (...args) => globalThis.fetch(...args),
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    now: () => new Date(),
  });
}
