// The tracking dashboard (spec Addendum D.4): read-only, it fetches /api/snapshots (tracking-snapshot@1 documents)
// every 5 s while the tab is visible and renders them. Every piece of data is inserted with textContent or as an
// attribute value, never parsed as HTML. The page's CSP is default-src 'self', which blocks inline <style>, so the
// styles are a constructed stylesheet (CSSOM), with the dark theme under prefers-color-scheme.
'use strict';

const REFRESH_MS = 5000;
const LATEST_ENTRIES = 5;
const GROUPS = [
  ['in_progress', 'In progress'],
  ['in_review', 'In review'],
  ['blocked', 'Blocked'],
  ['pending', 'Pending'],
  ['done', 'Done'],
  ['dropped', 'Dropped'],
];
const WITH_REASON = new Set(['blocked', 'dropped']);

const CSS = `
:root {
  --bg: #f7f7f8; --panel: #ffffff; --text: #1b1b1f; --muted: #5f6068; --border: #dcdce0;
  --accent: #2f5bd3; --track: #e6e6ea; --code: #f0f0f3;
  --in_progress: #2f5bd3; --in_review: #7a4cc2; --blocked: #b3261e; --pending: #5f6068; --done: #1e7a3d;
  --dropped: #8a6d1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111114; --panel: #1b1b20; --text: #e8e8ec; --muted: #a0a0aa; --border: #33333b;
    --accent: #8aa8ff; --track: #2c2c33; --code: #16161a;
    --in_progress: #8aa8ff; --in_review: #c3a3f5; --blocked: #ff8a80; --pending: #a0a0aa; --done: #7ad28f;
    --dropped: #e2c46b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1100px; margin: 0 auto; display: grid; gap: 16px; }
.top { max-width: 1100px; margin: 0 auto 16px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 17px; margin: 0; overflow-wrap: anywhere; }
h3 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
h4 { font-size: 13px; margin: 8px 0 4px; }
.meta { color: var(--muted); margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.error { color: var(--blocked); }
.repo { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: grid; gap: 12px; }
.repo-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border);
  font-size: 12px; color: var(--muted);
}
.badge.local { color: var(--in_review); border-color: var(--in_review); }
.badge.store { color: var(--done); border-color: var(--done); }
.badge.active { color: var(--accent); border-color: var(--accent); }
.plan { border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; }
.plan-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.current { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--accent); }
progress { width: 100%; height: 8px; appearance: none; border: 0; border-radius: 4px; background: var(--track); }
progress::-webkit-progress-bar { background: var(--track); border-radius: 4px; }
progress::-webkit-progress-value { background: var(--done); border-radius: 4px; }
progress::-moz-progress-bar { background: var(--done); border-radius: 4px; }
ul { margin: 0; padding-left: 18px; }
li { margin: 2px 0; overflow-wrap: anywhere; }
.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-right: 6px; }
.reason { color: var(--muted); }
details > summary { cursor: pointer; }
.group-in_progress h4, .group-in_progress summary { color: var(--in_progress); }
.group-in_review h4, .group-in_review summary { color: var(--in_review); }
.group-blocked h4, .group-blocked summary { color: var(--blocked); }
.group-pending h4, .group-pending summary { color: var(--pending); }
.group-done h4, .group-done summary { color: var(--done); }
.group-dropped h4, .group-dropped summary { color: var(--dropped); }
.group summary { font-weight: 600; font-size: 13px; margin: 8px 0 4px; }
pre {
  margin: 0; padding: 10px; background: var(--code); border: 1px solid var(--border); border-radius: 6px;
  white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 360px; overflow: auto;
}
.entries { display: grid; gap: 6px; }
.entry summary { overflow-wrap: anywhere; }
.entry .stage { color: var(--muted); margin-left: 6px; }
.empty { color: var(--muted); }
`;

function applyStyles() {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [sheet];
  } catch {
    // an old browser: the page stays readable unstyled
  }
}

// An element with optional class and text (always textContent), then its children appended.
function el(tag, { cls, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, String(v));
  for (const child of children) if (child) node.append(child);
  return node;
}

// Remembers which <details> the viewer opened or closed, so the 5 s re-render keeps them as they were.
const openState = new Map();
function details(key, openByDefault, summary, children) {
  const node = el('details', {}, [summary, ...children]);
  node.open = openState.has(key) ? openState.get(key) : openByDefault;
  node.addEventListener('toggle', () => openState.set(key, node.open));
  return node;
}

// The status-line `<current>` (spec D.3) where the snapshot is enough to tell it: the first in_progress id, else the
// first in_review id + " review", else `done` when every non-dropped task is done, else (no pending task left) the
// first blocked id + " blocked". With pending tasks and nothing moving it is null: the next task depends on task
// dependencies, which the snapshot does not carry.
function currentOf(plan) {
  const first = (status) => plan.tasks.find((t) => t.status === status);
  if (first('in_progress')) return first('in_progress').id;
  if (first('in_review')) return `${first('in_review').id} review`;
  if (plan.done === plan.total) return 'done';
  if (first('pending')) return null;
  if (first('blocked')) return `${first('blocked').id} blocked`;
  return 'stalled';
}

function taskItem(task) {
  const li = el('li', {}, [el('span', { cls: 'id', text: task.id }), document.createTextNode(task.title ?? '')]);
  if (WITH_REASON.has(task.status)) li.append(el('span', { cls: 'reason', text: ` — ${task.reason ?? 'no reason given'}` }));
  return li;
}

function renderPlan(repoKey, plan) {
  const key = `${repoKey}\u0000${plan.name}`;
  const current = plan.state === 'active' ? currentOf(plan) : null;
  const head = el('div', { cls: 'plan-head' }, [
    el('h3', { text: plan.name }),
    el('span', { cls: `badge ${plan.state === 'active' ? 'active' : ''}`, text: plan.state }),
    el('span', { cls: 'meta', text: `${plan.done}/${plan.total} done` }),
    current ? el('span', { cls: 'current', text: `▸ ${current}` }) : null,
  ]);
  const bar = el('progress', { attrs: { max: Math.max(plan.total, 1), value: plan.done } });
  bar.setAttribute('aria-label', `${plan.name}: ${plan.done} of ${plan.total} done`);
  const groups = [];
  for (const [status, label] of GROUPS) {
    const tasks = plan.tasks.filter((t) => t.status === status);
    if (!tasks.length) continue;
    const list = el('ul', {}, tasks.map(taskItem));
    const summary = el('summary', { text: `${label} (${tasks.length})` });
    // Done tasks start folded; everything else, blocked and dropped reasons included, starts visible.
    groups.push(el('div', { cls: `group group-${status}` }, [details(`${key}\u0000${status}`, status !== 'done', summary, [list])]));
  }
  const body = [bar, ...groups];
  if (plan.state === 'active') return el('section', { cls: 'plan' }, [head, ...body]);
  // A finished plan folds into one line.
  return el('section', { cls: 'plan' }, [details(key, false, el('summary', {}, [head]), body)]);
}

function renderEntries(repoKey, entries) {
  const latest = entries.slice(0, LATEST_ENTRIES);
  if (!latest.length) return el('p', { cls: 'empty', text: 'No progress entries yet.' });
  return el('div', { cls: 'entries' }, latest.map((e, i) => {
    const summary = el('summary', {}, [
      el('span', { text: [e.date, e.title].filter(Boolean).join(' — ') }),
      e.stageTask ? el('span', { cls: 'stage', text: `(${e.stageTask})` }) : null,
    ]);
    return el('div', { cls: 'entry' }, [details(`${repoKey}\u0000entry\u0000${e.date}\u0000${e.title}\u0000${i}`, false, summary, [el('pre', { text: e.body })])]);
  }));
}

function renderRepo(snap) {
  const repo = snap.repo ?? {};
  const key = repo.root ?? repo.name ?? '';
  const plans = Array.isArray(snap.plans) ? snap.plans : [];
  const head = el('div', { cls: 'repo-head' }, [
    el('h2', { text: repo.name }),
    el('span', { cls: `badge ${repo.mode === 'local' || repo.mode === 'store' ? repo.mode : ''}`, text: repo.mode }),
    el('span', { cls: 'badge', text: repo.branch ?? 'detached HEAD' }),
  ]);
  return el('article', { cls: 'repo' }, [
    head,
    el('p', { cls: 'meta', text: repo.root }),
    plans.length ? el('div', {}, plans.map((p) => renderPlan(key, p))) : el('p', { cls: 'empty', text: 'No plans.' }),
    details(`${key}\u0000status`, true, el('summary', { text: 'status' }), [el('pre', { text: snap.status?.text ?? '' })]),
    el('h4', { text: `Latest ${LATEST_ENTRIES} progress entries` }),
    renderEntries(key, snap.progress?.entries ?? []),
  ]);
}

let lastKey = null;

function render(snaps) {
  // generatedAt changes on every fetch; re-render only when the tracking data itself changed.
  const key = JSON.stringify(snaps.map((s) => ({ ...s, generatedAt: null })));
  if (key === lastKey) return;
  lastKey = key;
  const root = document.getElementById('repos');
  if (!snaps.length) {
    root.replaceChildren(el('p', { cls: 'empty', text: 'No registered repos. Run triqual progress-init in a repo, or open a Claude Code session in an opted-in one.' }));
    return;
  }
  root.replaceChildren(...snaps.map(renderRepo));
}

function setState(text, isError) {
  const node = document.getElementById('state');
  node.textContent = text;
  node.className = isError ? 'meta error' : 'meta';
}

// Polls every REFRESH_MS while the tab is visible. A hidden tab stops the loop (each poll runs git in every
// registered repo); becoming visible refreshes at once and restarts it.
let timer = null;

async function refresh() {
  if (document.hidden) return;
  try {
    const res = await fetch('/api/snapshots', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snaps = await res.json();
    if (!Array.isArray(snaps)) throw new Error('unexpected response');
    render(snaps);
    setState(`${snaps.length} repo${snaps.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString()}`, false);
  } catch (err) {
    setState(`Cannot load snapshots (${err.message}); retrying every ${REFRESH_MS / 1000} s`, true);
  } finally {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_MS);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  clearTimeout(timer);
  refresh();
});

applyStyles();
refresh();
