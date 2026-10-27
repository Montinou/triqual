// The tracking snapshot (spec Addendum D.1, `claude-methodology/tracking-snapshot@1`): one JSON document per repo,
// the only thing the local dashboard and a future hosted UI read.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { ledgerPaths, readEntry } from './ledger-files.mjs';
import { counts, renderSection, upsertStatusSection } from './ledger.mjs';
import { storeTracking } from './tracking.mjs';

export const SNAPSHOT_SCHEMA = 'claude-methodology/tracking-snapshot@1';
export const MAX_ENTRIES = 20;

const GIT_TIMEOUT_MS = 10000;
// Repo-selecting variables a git hook exports to its children. Dropped so git discovers the repo from `cwd` alone.
const INHERITED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];
const HEADING = /^## (.*)$/;
const DATED = /^(\d{4}-\d{2}-\d{2}) — (.*)$/;
// The entry's stage line, English or Spanish (committed entries are never edited, so both formats stay).
const STAGE_TASK = /^- \*\*(?:Stage\/task|Etapa\/tarea):\*\*[ \t]*(.*)$/m;

// The newest `max` progress.md entries, in file order (newest first). An entry starts at a `## ` heading and runs to
// the next one; text before the first heading is not an entry.
export function parseProgressEntries(text, max = MAX_ENTRIES) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      if (entries.length === max) break;
      current = { heading: h[1].trim(), lines: [] };
      entries.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return entries.map(({ heading, lines }) => {
    const d = DATED.exec(heading);
    const body = lines.join('\n').trim();
    const stage = STAGE_TASK.exec(body);
    return {
      date: d ? d[1] : null,
      title: d ? d[2].trim() : heading,
      stageTask: stage ? stage[1].trim() : null,
      body,
    };
  });
}

// The current branch name, or null on a detached HEAD (git prints `HEAD`) or when git fails.
export function branchOf(repoRoot) {
  const env = { ...process.env };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

export function planView(name, ledger) {
  const { done, total } = counts(ledger);
  return {
    name,
    state: ledger.state,
    done,
    total,
    tasks: ledger.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      since: Number.isFinite(Date.parse(t.history?.at(-1)?.at)) ? Date.parse(t.history.at(-1).at) : null,
      reason: t.reason ?? null,
      tier: t.tier ?? null,
      effectiveTier: t.effectiveTier ?? null,
      commits: Array.isArray(t.commits) ? [...t.commits] : [],
      skills: Array.isArray(t.skills) ? [...t.skills] : [],
    })),
  };
}

// Every ledger in plansDir, active and done, newest name first. A ledger that cannot be read or shaped is skipped.
function plans(t) {
  const views = [];
  for (const path of ledgerPaths(t)) {
    try {
      const { name, ledger } = readEntry(path, readFileSync(path, 'utf8'));
      views.push(planView(name, ledger));
    } catch {
      // skipped: unreadable, not JSON, not a ledger, or tasks too malformed to count
    }
  }
  return views.sort(byNameDesc);
}

// ---- Store mode ----

export const byNameDesc = (a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
export const planName = (path) => basename(path).replace(/\.md$/, '');

// What a stored entry's progress.md block holds after its heading, one line per element. An imported entry keeps its
// original text; one written with `tracking add` is laid out from its fields.
function entryBodyLines(e) {
  return e.original === null
    ? [
      ['Stage/task', e.stage_task], ['Done', e.done], ['Files', e.files], ['Verification', e.verification],
      ['Commit', e.commit_sha], ['Next', e.next],
    ].filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`)
    : e.original.split('\n').slice(1);
}

// The date an entry shows: its heading date, else the date of its created_at.
const dateOf = (e) => e.entry_date ?? (/^\d{4}-\d{2}-\d{2}/.test(e.created_at) ? e.created_at.slice(0, 10) : null);

// The entry as progress.md would hold it: its original text when it has one, else the heading and its fields.
export function entryText(e) {
  if (e.original !== null) return e.original.trimEnd();
  return [`## ${dateOf(e) ?? e.created_at} — ${e.title}`, ...entryBodyLines(e)].join('\n');
}

// A stored entry as the snapshot shows it.
function entryView(e) {
  const body = entryBodyLines(e).join('\n').trim();
  const stage = STAGE_TASK.exec(body);
  return {
    date: dateOf(e),
    title: e.title,
    stageTask: e.stage_task || (stage ? stage[1].trim() : null),
    body,
  };
}

// The status sections as text blocks: the preamble as it is, each other section under its `## <heading>`.
const sectionParts = (sections) => sections.map((s) => (s.heading === 'preamble' ? s.body : `## ${s.heading}\n\n${s.body}`)).filter(Boolean);

// The status text of a store repository: its stored sections (the preamble first) and, once it has a plan, the Active
// plan section rendered from the ledgers: the shape status.md has in the other modes without the markers around that
// section.
export function statusText(sections, ledgers) {
  const parts = sectionParts(sections);
  if (ledgers.length) parts.push(renderSection(ledgers));
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// The same text laid out as the status.md of a committed repository: the stored sections, then (once the repository has
// a plan) the managed tasks section between its markers, appended as `tasks render` appends it to a file without one.
export function statusFileText(sections, ledgers) {
  const text = sectionParts(sections).join('\n\n');
  return ledgers.length ? upsertStatusSection(text, renderSection(ledgers)) : text;
}

// Reads from the store of `t` through a read-only connection and closes it: fn(store, repoId) inside one read
// transaction, or null when the repository has no row yet (it is only looked up, never created). `node:sqlite` must be loaded already (the async
// entry points do it). Throws the store's errors.
function readStore(t, { home, env }, fn) {
  const st = storeTracking(t, { home, env, access: 'read' });
  try {
    return st.repoId === null ? null : st.store.readTx(() => fn(st.store, st.repoId));
  } finally {
    st.store.close();
  }
}

// The stored status sections, every plan's ledger ({ name, ledger }, newest name first) and the entries `query`
// selects (Store.entries: last, since, plan, grep, worktree; newest first; `null` reads none), whether the store
// holds a row for the repository (`seen`) and whether that row is shareable (frozen when the row was created: a
// repository switched from local mode never is). A repository the store has not seen yet has none of the rest.
export function readStoreViews(t, io, query = { last: MAX_ENTRIES }) {
  return readStore(t, io, (store, repoId) => ({
    seen: true,
    shareable: store.get('SELECT shareable FROM repos WHERE id = ?', repoId)?.shareable === 1,
    sections: store.status(repoId),
    ledgers: store.plans(repoId).map((p) => ({ name: planName(p.path), ledger: store.ledgerOf(p.id) })).sort(byNameDesc),
    entries: query === null ? [] : store.entries(repoId, query),
  })) ?? { seen: false, shareable: false, sections: [], ledgers: [], entries: [] };
}

// The entries `query` selects, newest first, without reading the status or the plans.
export const readStoreEntries = (t, io, query) => readStore(t, io, (store, repoId) => store.entries(repoId, query)) ?? [];

// The views of a store repository, as the snapshot shows them.
function storeViews(t, io) {
  const { sections, ledgers, entries, shareable } = readStoreViews(t, io);
  return {
    shareable,
    plans: ledgers.map(({ name, ledger }) => planView(name, ledger)),
    status: statusText(sections, ledgers),
    entries: entries.map(entryView),
  };
}

// The tracking snapshot of a repository. A store repository is read from the store (`home` and `env` locate it).
export function buildSnapshot(t, options) {
  const { now, shareable, home = homedir(), env = process.env } = options;
  const store = t.mode === 'store' ? storeViews(t, { home, env }) : null;
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    repo: {
      name: basename(t.repoRoot),
      root: t.repoRoot,
      mode: t.mode,
      branch: Object.hasOwn(options, 'branch') ? options.branch : branchOf(t.repoRoot),
      // A store repository is shareable only when the registry and its frozen store row both say so: the row stays 0
      // for one switched from local mode, whatever the registry is later set to.
      shareable: shareable === true && t.mode !== 'local' && (store === null || store.shareable),
    },
    plans: store ? store.plans : plans(t),
    status: { text: store ? store.status : readText(t.status) },
    progress: { entries: store ? store.entries : parseProgressEntries(readText(t.progress), MAX_ENTRIES) },
  };
}
