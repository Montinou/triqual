// `triqual tracking import` (spec §8): moves a repository's tracking files (progress.md, status.md, the *.tasks.json
// ledgers) into the store, or rebuilds its rows from an export. Two phases, so no transaction ever waits on git:
//   prepareImport  reads the files (working tree, <git-common-dir>/methodology for local mode, or a `--ref`) and
//                  resolves every entry's state and commit, with no store access;
//   runImport      writes them in one transaction (or one replaceRows), oldest entry first.
// Entries are idempotent by import_hash (sha256 of the entry text); a re-import adds only new entries and promotes a
// pending (or demoted, unresolved) one whose heading now has a commit. Committed mode resolves an entry's commit as the
// first commit that added its heading line (headingCommits), whatever its "Commit:" text says.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './fsx.mjs';
import { parseEntryDraft } from './entry-draft.mjs';
import { parseStatusSections } from './status-sections.mjs';
import { ledgerPaths, readEntry, LEDGER_EXT } from './ledger-files.mjs';
import { progressHash, readState } from './tracking.mjs';
import { sameEvent } from './store.mjs';

const GIT_TIMEOUT_MS = 60000;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const INHERITED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];
const PROGRESS = 'progress.md';
const STATUS = 'status.md';
const PLANS_DIR = 'docs/plans';
const HEADING_LINE = /^## /;
const DATED = /^## (\d{4}-\d{2}-\d{2}) — /;
// The log's own commit line: NUL, then `<sha> <author date> <parents...>`. A diff line never starts with NUL.
const COMMIT_MARK = '\0';
const REQUIRED = [
  ['stage_task', 'Stage/task'], ['done', 'Done'], ['files', 'Files'], ['verification', 'Verification'], ['next', 'Next'],
];

// A refusal of the import (bad ref, unreadable ledger or status, malformed export): the CLI exits 2 with its message.
export class ImportError extends Error {}

// Thrown inside the import's transaction when it would add unparsed entries without --accept-unparsed: the
// transaction rolls back and the CLI prints `report` and exits 1.
export class UnparsedEntries extends Error {
  constructor(report) {
    super(`nothing imported: ${report.unparsed.length} unparsed entr${report.unparsed.length === 1 ? 'y' : 'ies'}`);
    this.report = report;
  }
}

// Runs git; any failure (an exit status, a timeout, too much output, a corrupt object) is an ImportError naming the
// command, so an import never goes on as if git had found nothing. Callers that expect a status say so first.
function git(repoRoot, args) {
  const env = { ...process.env };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  try {
    return execFileSync('git', args, {
      cwd: repoRoot, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const command = args.find((a) => !a.startsWith('-') && !a.includes('='));
    const why = err.code ?? (String(err.stderr ?? '').trim().split('\n')[0] || err.message);
    const failure = new ImportError(`git ${command} failed: ${why}`);
    failure.status = err.status;
    throw failure;
  }
}

// The commit `ref` names, or null when it names none (`rev-parse --verify --quiet` exits 1 and says nothing). Any
// other failure is rethrown.
function commitOf(repoRoot, ref) {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch (err) {
    if (err.status === 1) return null;
    throw err;
  }
}

// True when HEAD is an unborn branch, the one case where an empty history is the truth: HEAD names a branch
// (`symbolic-ref`) that does not exist yet (`show-ref --verify` exits 1). A detached HEAD is never unborn; a branch
// whose commit object is missing makes show-ref fail otherwise, which is rethrown.
function unborn(repoRoot) {
  let branch;
  try {
    branch = git(repoRoot, ['symbolic-ref', '-q', 'HEAD']).trim();
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
  try {
    git(repoRoot, ['show-ref', '--verify', '--quiet', branch]);
    return false;
  } catch (err) {
    if (err.status === 1) return true;
    throw err;
  }
}

// `git show <ref>:<path>`, or null when the ref's tree has no such file (ls-tree lists nothing). A git failure is
// rethrown, never read as "no file".
function showFile(repoRoot, ref, path) {
  if (git(repoRoot, ['-c', 'core.quotePath=false', 'ls-tree', '--name-only', ref, '--', path]).trim() === '') return null;
  return git(repoRoot, ['show', `${ref}:${path}`]);
}

// ---- Heading → commit ----

// Parses `git log --format=%x00%H %aI %P --cc -p -U0` output: { commits: Map<heading line, sha>, dates: Map<sha,
// strict ISO author date> }. A heading is attributed to the first commit (in log order) whose diff adds its line: in a plain
// commit a `+` line, in a merge only a line added against every parent (`++` for two), since a ` +` or `+ ` line
// came from one parent and belongs to that parent's commit. Only lines inside hunks count, never the diff headers.
export function parseHeadingLog(text) {
  const commits = new Map();
  const dates = new Map();
  let sha = null;
  let added = '+';
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(COMMIT_MARK)) {
      const [id, date, ...parents] = line.slice(1).trim().split(/\s+/);
      sha = id;
      dates.set(id, date);
      added = '+'.repeat(Math.max(1, parents.length));
      inHunk = false;
    } else if (line.startsWith('diff ')) {
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && sha !== null && line.startsWith(added)) {
      const content = line.slice(added.length);
      // The `+` columns are exactly as many as the parents: a further `+` would be content, never a `## ` heading.
      if (HEADING_LINE.test(content)) {
        const heading = content.trimEnd();
        if (!commits.has(heading)) commits.set(heading, sha);
      }
    }
  }
  return { commits, dates };
}

// One pass over the history of progress.md reachable from `ref`, oldest first; { commits, dates } as parseHeadingLog.
// `--date-order` keeps every parent before its children (so a heading's first commit is never a later merge) and is
// otherwise chronological. `--full-history` keeps both sides of a merge TREESAME to one parent: the default
// simplification would follow that parent only and hide a side that added a heading first. An unborn HEAD has no
// history; a ref that names no commit, or any git failure, throws ImportError.
export function headingLog(repoRoot, ref = 'HEAD') {
  if (commitOf(repoRoot, ref) === null) {
    if (ref === 'HEAD' && unborn(repoRoot)) return { commits: new Map(), dates: new Map() };
    throw new ImportError(`"${ref}" does not name a commit of this repository`);
  }
  return parseHeadingLog(git(repoRoot, [
    '-c', 'core.quotePath=false', 'log', '--reverse', '--date-order', '--full-history', '--cc', '-p', '-U0', '--no-color',
    '--no-ext-diff', '--no-textconv', '--format=%x00%H %aI %P', ref, '--', PROGRESS,
  ]));
}

// Map<heading line, sha of the first commit that added it> for progress.md as reachable from `ref`.
export function headingCommits(repoRoot, ref = 'HEAD') {
  return headingLog(repoRoot, ref).commits;
}

// ---- Entries ----

// The entries of a progress.md text in file order (newest first): [{ heading, text }], each cut at the next `## `
// line with its trailing blank lines removed. The header before the first `## ` line is not an entry.
export function splitEntries(text) {
  const out = [];
  let current = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (HEADING_LINE.test(line)) {
      current = [line];
      out.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return out.map((lines) => ({ heading: lines[0].trimEnd(), text: lines.join('\n').trimEnd() }));
}

// The entry's fields and whether they parsed. An entry is unparsed (parse_ok=0, the five fields '') when its heading
// is not `## <date> — <title>` with a calendar date, or one of the five fields is missing (a Spanish or loose-shape
// bullet lands among the extra fields and leaves its field empty). Extra fields stay in `original` only.
function parseFields(e) {
  const parsed = parseEntryDraft(e.text);
  const fallbackTitle = e.heading.replace(/^## /, '').replace(/^\d{4}-\d{2}-\d{2} — /, '');
  if (parsed.error) return { date: null, title: fallbackTitle, problem: parsed.error };
  const problems = [];
  if (parsed.date === null) problems.push(`the heading date ${DATED.exec(e.heading)[1]} is not a calendar date`);
  const missing = REQUIRED.filter(([k]) => parsed[k] === '').map(([, name]) => name);
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (problems.length && parsed.extra.length) problems.push(`unknown fields ${parsed.extra.join(', ')}`);
  const fields = Object.fromEntries(REQUIRED.map(([k]) => [k, parsed[k]]));
  return { date: parsed.date, title: parsed.title, fields, problem: problems.length ? problems.join('; ') : null };
}

const EMPTY = Object.fromEntries(REQUIRED.map(([k]) => [k, '']));

// An imported entry's created_at, a UTC timestamp like an `add` entry's so mixed sources sort chronologically: the
// heading commit's author date; else the heading date at 00:00 local time; else (no usable date) `now`. `authored` is
// git's strict ISO author date (or a bare date, taken as 00:00 local).
function createdAtOf(authored, date, now) {
  const local = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
  if (authored) {
    const at = /^\d{4}-\d{2}-\d{2}$/.test(authored) ? local(authored) : new Date(authored);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return (date ? local(date) : now).toISOString();
}

// ---- Sources ----

const readIfExists = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

const ledgerOf = (path, text) => {
  try {
    return readEntry(path, text);
  } catch (err) {
    throw new ImportError(`${err.message}: fix it (or remove it) before importing`);
  }
};

// The files on disk: under the git dir for local mode, else the committed layout at the repository root (a store-mode
// repository normally has none left, and then nothing is read).
function diskSources(t) {
  const local = t.mode === 'local';
  const progress = local ? t.progress : join(t.repoRoot, PROGRESS);
  const status = local ? t.status : join(t.repoRoot, STATUS);
  const plansDir = local ? t.plansDir : join(t.repoRoot, ...PLANS_DIR.split('/'));
  const text = readIfExists(progress);
  return {
    progress: text ?? '',
    hasProgress: text !== null,
    status: readIfExists(status),
    ledgers: ledgerPaths({ plansDir }).map((p) => ledgerOf(p, readFileSync(p, 'utf8'))),
  };
}

// The same files as committed on `ref`.
function refSources(repoRoot, ref) {
  const names = git(repoRoot, ['-c', 'core.quotePath=false', 'ls-tree', '--name-only', ref, '--', `${PLANS_DIR}/`]).split('\n');
  const ledgers = names.filter((n) => n.endsWith(LEDGER_EXT) && !n.slice(PLANS_DIR.length + 1).includes('/')).sort()
    .map((n) => ledgerOf(`${ref}:${n}`, showFile(repoRoot, ref, n) ?? ''));
  return { progress: showFile(repoRoot, ref, PROGRESS) ?? '', status: showFile(repoRoot, ref, STATUS), ledgers };
}

function verifyRef(repoRoot, ref) {
  if (ref.startsWith('-')) throw new ImportError(`--ref: "${ref}" is not a ref`);
  if (commitOf(repoRoot, ref) === null) throw new ImportError(`--ref: "${ref}" does not name a commit of this repository`);
}

// ---- Phase 1: read and resolve ----

// Everything the import writes, read and resolved outside any transaction: { entries (oldest first), sections (null:
// leave the stored status alone), statusRef, ledgers, ref, mode, treeProgress (a plain import whose working tree, or
// local root, has a progress.md) }. Each entry is { heading, text, hash, title, fields, parseOk, problem, state, commit,
// createdAt, entryDate, branch } (branch: the --ref, else null for the worktree's own).
//   committed (and store) mode: a heading with a commit is `committed`; a heading on disk that HEAD's progress.md does
//     not hold yet is `pending`; any other one (committed, but no commit found to add it) is `unresolved`.
//   local mode: every entry is `unresolved`, except the top one, `pending` when progress.md changed since the last
//     gated commit (state.json's lastProgressSha256 differs from its hash).
//   --ref: that branch's files; an entry is `committed` or `unresolved`, never pending.
// created_at is the heading commit's author date, else the heading date at 00:00 local, else now (createdAtOf);
// entryDate is the heading's date (null when it is not a calendar date).
export function prepareImport(t, { ref = null, now = new Date() } = {}) {
  if (ref !== null && t.mode === 'local') {
    throw new ImportError('--ref: this repository is in local mode, its tracking files are not in git');
  }
  if (ref !== null) verifyRef(t.repoRoot, ref);
  const src = ref === null ? diskSources(t) : refSources(t.repoRoot, ref);
  const blocks = splitEntries(src.progress);

  let stateOf;
  let dates = new Map();
  if (t.mode === 'local') {
    const changed = readState(t).lastProgressSha256 !== progressHash(t);
    stateOf = (_, i) => ({ state: i === 0 && changed ? 'pending' : 'unresolved', commit: null });
  } else {
    const log = headingLog(t.repoRoot, ref ?? 'HEAD');
    dates = log.dates;
    const headProgress = ref !== null || unborn(t.repoRoot) ? '' : showFile(t.repoRoot, 'HEAD', PROGRESS) ?? '';
    const atHead = ref === null ? new Set(splitEntries(headProgress).map((e) => e.heading)) : null;
    stateOf = (e) => {
      const sha = log.commits.get(e.heading);
      if (sha) return { state: 'committed', commit: sha };
      if (atHead !== null && !atHead.has(e.heading)) return { state: 'pending', commit: null };
      return { state: 'unresolved', commit: null };
    };
  }

  const entries = blocks.map((e, i) => {
    const { date, title, fields, problem } = parseFields(e);
    const { state, commit } = stateOf(e, i);
    return {
      heading: e.heading,
      text: e.text,
      hash: sha256(e.text),
      title,
      fields: problem === null ? fields : EMPTY,
      parseOk: problem === null,
      problem,
      state,
      commit,
      createdAt: createdAtOf(commit && dates.get(commit), date, now),
      entryDate: date,
      branch: ref,
    };
  }).reverse();

  let sections = null;
  if (src.status !== null) {
    try {
      sections = parseStatusSections(src.status);
    } catch (err) {
      throw new ImportError(`${ref === null ? STATUS : `${ref}:${STATUS}`}: ${err.message}`);
    }
  }
  return {
    entries, sections: ref === null ? sections : null, statusRef: ref === null ? null : sections, ledgers: src.ledgers, ref,
    mode: t.mode, treeProgress: ref === null && src.hasProgress === true,
  };
}

// ---- Phase 2: write ----

const lastAt = (task) => (task.history ?? []).reduce((max, h) => (typeof h.at === 'string' && h.at > max ? h.at : max), '');
const planPathOf = (l) => (typeof l.ledger.plan === 'string' && l.ledger.plan ? l.ledger.plan : `${PLANS_DIR}/${l.name}.md`);

// The stored ledger with another copy merged in (a branch's, or the files on disk). Per task the side whose latest
// history time is later wins the progress (status, commits, reason) and appends its history events the store lacks; a
// task only the incoming side has is added. The metadata (a task's title, deps, skills and role; the plan's spec and
// branch) follows the same clock: it is the incoming side's unless the store's latest time is later, so a title changed
// after the switch (a history event of its own) survives a later `--ref` import, while files edited on disk with no new
// event are still picked up. The plan's state follows the side with the latest time overall. On a tie the store's
// progress stays.
function mergeLedger(stored, incoming) {
  const merged = structuredClone(stored);
  const latest = (l) => l.tasks.reduce((max, x) => (lastAt(x) > max ? lastAt(x) : max), '');
  if (!(latest(stored) > latest(incoming))) {
    merged.spec = incoming.spec ?? null;
    merged.branch = incoming.branch ?? null;
  }
  for (const bt of incoming.tasks) {
    const st = merged.tasks.find((x) => x.id === bt.id);
    if (!st) {
      merged.tasks.push(structuredClone(bt));
      continue;
    }
    if (!(lastAt(st) > lastAt(bt))) Object.assign(st, { title: bt.title, deps: bt.deps ?? [], skills: bt.skills ?? [], role: bt.role ?? null });
    if (lastAt(bt) > lastAt(st)) {
      const extra = (bt.history ?? []).filter((h) => !st.history.some((s) => sameEvent(s, h)));
      Object.assign(st, { status: bt.status, commits: bt.commits ?? [], reason: bt.reason ?? null });
      st.history = [...st.history, ...structuredClone(extra)];
    }
  }
  if (latest(incoming) > latest(stored)) merged.state = incoming.state;
  return merged;
}

function importLedgers(store, repoId, ledgers) {
  let tasks = 0;
  for (const l of ledgers) {
    const path = planPathOf(l);
    const existing = store.get('SELECT id FROM plans WHERE repo_id = ? AND path = ?', repoId, path);
    // A plan the store already holds is always merged, never overwritten: a plain import after `--ref` must not
    // revert what the branch moved further.
    const ledger = existing ? mergeLedger(store.ledgerOf(existing.id), l.ledger) : l.ledger;
    const planId = existing
      ? existing.id
      : store.upsertPlan(repoId, { path, spec: ledger.spec, branch: ledger.branch, state: ledger.state });
    store.saveLedger(planId, ledger);
    tasks += ledger.tasks.length;
  }
  return tasks;
}

// The stored status with `sections` in its place; a section whose body is unchanged keeps its updated_at.
function importStatus(store, repoId, sections, now) {
  const current = new Map(store.all('SELECT heading, body, updated_at FROM status WHERE repo_id = ?', repoId).map((s) => [s.heading, s]));
  store.setStatus(repoId, sections.map((s) => {
    const c = current.get(s.heading);
    return c && c.body === s.body ? { ...s, updated_at: c.updated_at } : s;
  }), now);
}

// The headings whose text differs between a branch's status and the stored one: changed, only on the branch, only
// in the store.
function statusDiff(store, repoId, sections) {
  const stored = new Map(store.status(repoId).map((s) => [s.heading, s.body]));
  const theirs = new Map(sections.map((s) => [s.heading, s.body]));
  return {
    changed: sections.filter((s) => stored.has(s.heading) && stored.get(s.heading) !== s.body).map((s) => s.heading),
    added: sections.filter((s) => !stored.has(s.heading)).map((s) => s.heading),
    removed: [...stored.keys()].filter((h) => !theirs.has(h)),
  };
}

// The import guard (the one thing that lets a row of entries be deleted), held for the rest of the caller's
// transaction from the first need on: open() inserts its row once, close() deletes that row only (replaceRows holds a
// row of its own). Foreign keys are checked at commit, so a draft re-inserted under its own id keeps a `corrects`
// that names it valid. A rollback removes the row with everything else.
function importGuard(store) {
  let rowid = null;
  return {
    open() {
      if (rowid !== null) return;
      store.run('PRAGMA defer_foreign_keys = ON');
      rowid = Number(store.run('INSERT INTO import_guard (active) VALUES (1)').lastInsertRowid);
    },
    close() {
      if (rowid !== null) store.run('DELETE FROM import_guard WHERE rowid = ?', rowid);
      rowid = null;
    },
  };
}

const headingOf = (original) => original.split('\n', 1)[0].trimEnd();

// A stored row of entries deleted and inserted again, under the guard, with `changes` applied and its id kept.
function rewriteEntry(store, guard, row, changes) {
  guard.open();
  const next = { ...row, ...changes };
  const cols = Object.keys(next);
  store.run('DELETE FROM entries WHERE id = ?', row.id);
  store.run(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => next[c]));
}

// Writes a prepared import for ctx's repository in one transaction (`replace`: one replaceRows, which first wipes the
// repository's rows under the import guard). Returns the report; throws UnparsedEntries (rolling everything back) when
// it would add an unparsed entry without `acceptUnparsed`.
// A stored `pending` row that an import wrote is a draft until its heading is committed. An entry whose text differs
// from such drafts with the same heading line replaces them: a committed entry replaces the repository's drafts (any
// worktree), an uncommitted entry of the worktree's own files only this worktree's (git_dir). The drafts are deleted
// under the import guard and the entry inserted under the first one's id; a row that `corrects` another of them is
// repointed to that id. In local mode a stored pending row that is no longer the top pending entry is demoted to
// `unresolved`, keeping its id and text; a plain committed-mode import (or a store-mode one whose working tree still has
// progress.md) demotes this worktree's drafts that are no longer pending on disk the same way. An `unresolved` row an
// import wrote whose text is now committed is promoted: rewritten under the guard as `committed` with that commit,
// keeping its id (a plain or --ref import alike). Every other row stays append-only.
export function runImport(store, ctx, prepared, { acceptUnparsed = false, replace = false, now = new Date().toISOString() } = {}) {
  const body = () => {
    const report = {
      ref: prepared.ref, added: 0, committed: 0, pending: 0, unresolved: 0, unparsed: [], promoted: 0, replaced: 0,
      demoted: 0, present: 0, sections: 0, plans: prepared.ledgers.length, tasks: 0, statusDiff: null,
    };
    const guard = importGuard(store);
    // The imported drafts by heading line, leaving out any whose text this import holds as it is (a heading line
    // shared by two entries never makes one replace the other).
    const hashes = new Set(prepared.entries.map((e) => e.hash));
    const drafts = new Map();
    for (const row of store.all(
      "SELECT id, git_dir, import_hash, original FROM entries WHERE repo_id = ? AND state = 'pending' AND import_hash IS NOT NULL AND original IS NOT NULL ORDER BY id",
      ctx.repoId,
    )) {
      if (hashes.has(row.import_hash)) continue;
      const h = headingOf(row.original);
      drafts.set(h, [...(drafts.get(h) ?? []), row]);
    }
    const seen = new Set();
    for (const e of prepared.entries) {
      if (seen.has(e.hash)) { report.present += 1; continue; } // the same text twice: one entry
      seen.add(e.hash);
      const existing = store.get('SELECT * FROM entries WHERE repo_id = ? AND import_hash = ?', ctx.repoId, e.hash);
      if (existing) {
        if (existing.state === 'pending' && e.state === 'committed') report.promoted += store.stampEntries([existing.id], e.commit);
        else if (existing.state === 'unresolved' && e.state === 'committed') {
          // A demoted draft whose text is now committed: stamped in place, under the guard, keeping its id.
          rewriteEntry(store, guard, existing, { state: 'committed', commit_sha: e.commit });
          report.promoted += 1;
        } else report.present += 1;
        continue;
      }
      const sameHeading = drafts.get(e.heading) ?? [];
      const stale = e.state === 'committed' ? sameHeading
        : prepared.ref === null ? sameHeading.filter((row) => row.git_dir === ctx.gitDir) : [];
      if (stale.length) {
        guard.open();
        const ids = stale.map((row) => row.id);
        for (const id of ids) store.run('DELETE FROM entries WHERE id = ?', id);
        // A correction of a later draft now names the row that replaces them all (the first draft's id).
        const marks = ids.map(() => '?').join(', ');
        for (const row of store.all(`SELECT * FROM entries WHERE corrects IN (${marks}) AND corrects <> ? ORDER BY id`, ...ids, ids[0])) {
          rewriteEntry(store, guard, row, { corrects: ids[0] });
        }
        drafts.set(e.heading, sameHeading.filter((row) => !ids.includes(row.id)));
        report.replaced += stale.length;
      }
      store.addEntry({ ...ctx, branch: e.branch ?? ctx.branch }, { title: e.title, ...e.fields }, {
        state: e.state, commit: e.commit, original: e.text, parseOk: e.parseOk, importHash: e.hash, createdAt: e.createdAt, entryDate: e.entryDate,
        id: stale.length ? stale[0].id : null,
      });
      report.added += 1;
      report[e.state] += 1;
      if (!e.parseOk) report.unparsed.push(e);
    }
    // A stored pending draft that is no longer the pending entry on disk is unresolved. Local mode keeps the top entry
    // only. A plain committed-mode import keeps the pending entries of the worktree's own files and touches only this
    // worktree's drafts (git_dir), so a draft retitled before its commit cannot stay pending and let one more commit
    // through (spec §8 switching). A store-marked clone whose working tree still has progress.md (a re-run finishing a
    // partial switch, a worktree not switched yet) is read the same way. A --ref import reads another branch's files
    // and demotes nothing.
    const pendingOnDisk = new Set(prepared.entries.filter((e) => e.state === 'pending').map((e) => e.hash));
    const top = prepared.entries.at(-1);
    const keepLocal = top?.state === 'pending' ? top.hash : null;
    let demote = null;
    if (prepared.mode === 'local') demote = (row) => row.import_hash !== keepLocal;
    else if (prepared.ref === null
      && (prepared.mode === 'committed' || (prepared.mode === 'store' && prepared.treeProgress))) {
      demote = (row) => row.git_dir === ctx.gitDir && !pendingOnDisk.has(row.import_hash);
    }
    if (demote !== null) {
      for (const row of store.all(
        "SELECT * FROM entries WHERE repo_id = ? AND state = 'pending' AND import_hash IS NOT NULL ORDER BY id", ctx.repoId,
      )) {
        if (!demote(row)) continue;
        rewriteEntry(store, guard, row, { state: 'unresolved', commit_sha: null });
        report.demoted += 1;
      }
    }
    guard.close();
    if (prepared.sections !== null) {
      importStatus(store, ctx.repoId, prepared.sections, now);
      report.sections = prepared.sections.length;
    }
    if (prepared.statusRef !== null) report.statusDiff = statusDiff(store, ctx.repoId, prepared.statusRef);
    report.tasks = importLedgers(store, ctx.repoId, prepared.ledgers);
    if (report.unparsed.length && !acceptUnparsed) throw new UnparsedEntries(report);
    return report;
  };
  return replace ? store.replaceRows(ctx.repoId, body) : store.tx(body);
}

// The report's lines: the counts, each unparsed entry with its problem, and a --ref status difference.
export function reportLines(r) {
  const lines = [
    `import${r.ref ? ` --ref ${r.ref}` : ''}: ${r.added} entries added (committed ${r.committed}, pending ${r.pending}, `
      + `unresolved ${r.unresolved}, unparsed ${r.unparsed.length}), ${r.promoted} promoted, `
      + `${r.replaced} pending drafts replaced, ${r.demoted} demoted, ${r.present} already present; `
      + `${r.sections} status sections; ${r.plans} plans, ${r.tasks} tasks`,
  ];
  for (const e of r.unparsed) lines.push(`unparsed: ${e.heading} (${e.problem})`);
  if (r.statusDiff) {
    const { changed, added, removed } = r.statusDiff;
    const q = (hs) => hs.map((h) => `"${h}"`).join(', ');
    const parts = [changed.length && q(changed), added.length && `only on ${r.ref}: ${q(added)}`, removed.length && `only in the store: ${q(removed)}`].filter(Boolean);
    lines.push(parts.length ? `status on ${r.ref} differs from the store (not imported): ${parts.join('; ')}` : `status on ${r.ref}: same as the store`);
  }
  return lines;
}

// ---- Rebuilding from an export (--replace --from) ----

export const EXPORT_TABLES = ['repos', 'entries', 'status', 'plans', 'tasks', 'task_events'];
// The columns written back for each table, id and repo/plan links aside (those are remapped).
const COLUMNS = {
  entries: ['git_dir', 'branch', 'created_at', 'entry_date', 'title', 'stage_task', 'done', 'files', 'verification', 'next', 'state',
    'commit_sha', 'plan', 'task_key', 'original', 'parse_ok', 'import_hash'],
  status: ['position', 'heading', 'body', 'updated_at'],
  plans: ['path', 'spec', 'branch', 'state'],
  tasks: ['key', 'position', 'title', 'deps', 'role', 'skills', 'status', 'commits', 'reason'],
  task_events: ['task_key', 'at', 'from_status', 'to_status', 'note'],
};

// The {table, row} records of an export's JSONL text, validated before anything is written. Throws ImportError naming
// the first bad line.
export function parseExport(text, name = 'the export') {
  const records = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      throw new ImportError(`${name} line ${i + 1}: not JSON (${err.message})`);
    }
    if (!rec || typeof rec !== 'object' || !EXPORT_TABLES.includes(rec.table) || !rec.row || typeof rec.row !== 'object' || Array.isArray(rec.row)) {
      throw new ImportError(`${name} line ${i + 1}: expected {"table": <${EXPORT_TABLES.join('|')}>, "row": {...}}`);
    }
    records.push(rec);
  });
  if (records.filter((r) => r.table === 'repos').length > 1) throw new ImportError(`${name} holds more than one repository`);
  return records;
}

// Inserts an export's rows for ctx's repository (inside the caller's replaceRows): new ids for entries, plans and task
// events, with `corrects`, every plan_id and the repository id remapped. The repos row itself is not copied. Returns
// the counts per table.
export function importRecords(store, ctx, records, name = 'the export') {
  const of = (table) => records.filter((r) => r.table === table).map((r) => r.row);
  const byId = (rows) => [...rows].sort((a, b) => a.id - b.id);
  const insert = (table, cols, values) => Number(store.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...values,
  ).lastInsertRowid);
  const pick = (row, cols) => cols.map((c) => row[c] ?? null);
  const entryIds = new Map();
  const planIds = new Map();
  const mapped = (map, id, what) => {
    if (id === null || id === undefined) return null;
    if (!map.has(id)) throw new ImportError(`${name}: a row names ${what} ${id}, which the export does not hold (or holds later)`);
    return map.get(id);
  };
  for (const row of byId(of('entries'))) {
    const cols = ['repo_id', 'corrects', ...COLUMNS.entries];
    entryIds.set(row.id, insert('entries', cols, [ctx.repoId, mapped(entryIds, row.corrects, 'entry'), ...pick(row, COLUMNS.entries)]));
  }
  for (const row of of('status')) insert('status', ['repo_id', ...COLUMNS.status], [ctx.repoId, ...pick(row, COLUMNS.status)]);
  for (const row of byId(of('plans'))) {
    planIds.set(row.id, insert('plans', ['repo_id', ...COLUMNS.plans], [ctx.repoId, ...pick(row, COLUMNS.plans)]));
  }
  for (const row of of('tasks')) {
    insert('tasks', ['plan_id', ...COLUMNS.tasks], [mapped(planIds, row.plan_id, 'plan'), ...pick(row, COLUMNS.tasks)]);
  }
  for (const row of byId(of('task_events'))) {
    insert('task_events', ['plan_id', ...COLUMNS.task_events], [mapped(planIds, row.plan_id, 'plan'), ...pick(row, COLUMNS.task_events)]);
  }
  return Object.fromEntries(EXPORT_TABLES.slice(1).map((t) => [t, of(t).length]));
}
