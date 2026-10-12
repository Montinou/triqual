#!/usr/bin/env node
// `triqual tracking write <entry|status|spec|plan> <draft> [--replace]`: lands a tracking file drafted anywhere. In local mode
// the tracking files live under the git dir, where Claude Code refuses an agent's Edit/Write and shell redirects
// ("sensitive file") but lets an allowed program write; so every local-mode tracking write goes through this command.
// It works the same in committed mode.
//   entry   the draft is one entry starting `## <YYYY-MM-DD> — ` (a second dated heading is refused); it goes above the
//           first `## ` heading of progress.md (the header block stays on top), or below the header when there is none.
//   status  the draft is the whole status.md; the managed tasks section is re-rendered from the ledgers in place of the
//           draft's own (appended when the draft has none). With no ledger and no section anywhere the draft is written
//           as it is. An unreadable ledger refuses the write, naming the file.
//   spec    copies the draft to <specsDir>/<its basename>; an existing file is refused unless --replace.
//   plan    `triqual tasks init --adopt <draft>`; --replace overwrites an adopted plan of that name and reconciles its ledger.
// In committed and local mode every write is atomic and runs under the tracking root's lock (tasksLockPath), like every
// mutating `triqual tasks` subcommand; store-mode writes rely on the database's own BEGIN IMMEDIATE transactions (a
// plan, which is also a file, additionally holds the lock in the repository's documents directory).
// Prints the written absolute path (plan: then the init message). Exit codes: 0 ok (and --help/-h); 2 bad arguments, a draft that cannot be read or is refused, not opted in, a lock timeout or any other failure.
//
// Store mode (`git config --local triqual.tracking store`, spec §4) keeps entries and status in the local database and
// documents under its data directory, never in the working tree or the git dir:
//   add <draft> [--no-commit | --commit <rev>] [--corrects <id>]   one entry (markdown or JSON, the five fields required);
//           pending for this worktree by default; prints `entry <id>`. It is ordered by its write time and shows its
//           draft's own heading date (a JSON draft has none: the local date of the write)
//   status set [--section <heading>] <draft>   replaces the stored status sections, or one of them. An `## Active plan`
//           section is not stored (it is rendered live from the ledgers): the command drops it and says so on stderr
//   write entry|status|spec|plan <draft>   entry is `add`, status is `status set`, spec and plan land in the documents
//           directory (a plan is then initialised in the store, as `triqual tasks init --adopt` does)
// Outside store mode `add` and `status set` exit 2 and `write` is unchanged. node:sqlite is loaded only on these paths.
//
// The store-mode views, read-only (a read-only connection; a repository the store has never seen is not added to it):
//   status [--json]   the stored status sections in order, then the Active plan section rendered live from the ledgers,
//           between the managed block's markers as in status.md (so a read, edited, goes back through `status set`);
//           --json gives { sections, plans, text }
//   log [--last N] [--plan <name>] [--since <YYYY-MM-DD>] [--grep <text>] [--json]   the entries newest first (N=10),
//           each as its progress.md block: the original text of an imported entry, the fields of one written by `add`;
//           --plan is the plan an entry's Stage/task names (`Plan <name> · T<N>`). --json gives an array of rows
// Outside store mode they exit 2, like `add`.
//
// Moving data in and out of the store (spec §8; import and export work in committed and local repositories too):
//   import [--ref <branch>] [--accept-unparsed] [--replace [--from <jsonl>]]   reads progress.md, status.md and the
//           ledgers (or a branch's, with --ref: its entries and ledgers, its status only reported) into the store;
//           exit 1, nothing written, when an entry cannot be parsed unless --accept-unparsed. --replace first wipes the
//           repository's rows; in store mode it needs --from, an export to rebuild them from (ids remapped)
//   export [--out <file>]   the repository's rows as JSONL, one {table, row} per line (stdout, or a 0600 file)
//   restore <snapshot> [--yes]   replaces every row of the database with a snapshot's; asks first on a terminal and
//           refuses without --yes anywhere else
//
// The store-mode git hooks (lib/store-hooks.mjs; the hook lines `progress-init --store` installs run them):
//   hook pre-commit    exit 1 when the commit stages changes and this worktree has no pending entry, or the store
//           fails; otherwise records the commit handshake (or clears it for a merge, a replay or nothing staged)
//   hook post-commit   stamps the handshake's entries with HEAD when `git commit` made it with the recorded tree;
//           always exits 0
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NOT_OPTED_IN } from '../scripts/init.mjs';
import { BRAND } from '../lib/brand.mjs';
import { resolveTracking, storeContext } from '../lib/tracking.mjs';
import { docsDirs, loadSqlite, maybeDailySnapshot, storePaths, StoreError } from '../lib/store.mjs';
import {
  importRecords, parseExport, prepareImport, reportLines, runImport, UnparsedEntries,
} from '../lib/store-import.mjs';
import { exportJsonl, restoreSnapshot } from '../lib/store-backup.mjs';
import { postCommit, preCommit } from '../lib/store-hooks.mjs';
import { entryDate, parseEntryDraft } from '../lib/entry-draft.mjs';
import { parseStatusSections, withoutActivePlan } from '../lib/status-sections.mjs';
import { writeAtomic } from '../lib/fsx.mjs';
import { withLock, tasksLockPath } from '../lib/lock.mjs';
import { ledgerPaths, readEntry } from '../lib/ledger-files.mjs';
import { renderSection, upsertStatusSection } from '../lib/ledger.mjs';
import { entryText, planView, readStoreEntries, readStoreViews, statusFileText } from '../lib/snapshot.mjs';
import { adoptPlan, openStoreTracking } from './tasks.mjs';

const USAGE = `usage: triqual tracking write <entry|status|spec|plan> <draft> [--replace]
  entry   add one progress.md entry (the draft starts with "## <YYYY-MM-DD> — <title>") above the newest
  status  replace status.md with the draft, keeping the managed tasks section (re-rendered from the ledgers)
  spec    copy the draft into the specs directory under its own name (--replace overwrites)
  plan    adopt the draft into the plans directory and init its ledger (--replace re-adopts and reconciles)
The draft may live anywhere (in local mode: the OS temp dir). Prints the written path.
store mode only (triqual progress-init --store):
  triqual tracking add <draft> [--no-commit | --commit <rev>] [--corrects <id>]
  triqual tracking status set [--section <heading>] <draft>
  triqual tracking status [--json]
  triqual tracking log [--last N] [--plan <name>] [--since <YYYY-MM-DD>] [--grep <text>] [--json]
There \`write entry|status|spec|plan\` mean add, status set, a copy into the store's documents directory and (plan) the
adoption of the plan there with its ledger in the store.
moving data into and out of the store (any tracking mode):
  triqual tracking import [--ref <branch>] [--accept-unparsed] [--replace [--from <jsonl>]]
  triqual tracking export [--out <file>]
  triqual tracking restore <snapshot> [--yes]
the store-mode git hooks (installed by triqual progress-init --store):
  triqual tracking hook pre-commit|post-commit`;

const KINDS = new Set(['entry', 'status', 'spec', 'plan']);
const HOOKS = new Set(['pre-commit', 'post-commit']);
const REPLACEABLE = new Set(['spec', 'plan']);
const NOT_IN_STORE = `not in store mode: run ${BRAND.cli} progress-init --store`;
const LOG_DEFAULT = 10;
const ENTRY_HEADING = /^## \d{4}-\d{2}-\d{2} — /;
const START = '<!-- tasks:start -->';
const END = '<!-- tasks:end -->';

class UsageError extends Error {}
class Refusal extends Error {}

const out = (line) => process.stdout.write(`${line}\n`);

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readDraft(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Refusal(`draft ${abs} not found`);
    throw new Refusal(`draft ${abs} cannot be read: ${err.message}`);
  }
}

// progress.md with `draft` inserted before its first `## ` heading, or appended below the header when it has none.
function withEntry(progress, draft) {
  const body = `${draft.replace(/\s+$/, '')}\n`;
  const newline = progress.indexOf('\n## ');
  const at = progress.startsWith('## ') ? 0 : newline === -1 ? -1 : newline + 1;
  if (at === -1) {
    if (progress === '') return body;
    return `${progress.endsWith('\n') ? progress : `${progress}\n`}\n${body}`;
  }
  let head = progress.slice(0, at);
  if (head !== '' && !head.endsWith('\n\n')) head += '\n';
  return `${head}${body}\n${progress.slice(at)}`;
}

function writeEntry(t, draft) {
  if (!ENTRY_HEADING.test(draft)) {
    throw new Refusal('the draft must start with the entry heading "## <YYYY-MM-DD> — <title>" on its first line');
  }
  const headings = draft.split('\n').filter((line) => ENTRY_HEADING.test(line)).length;
  if (headings > 1) {
    throw new Refusal(`the draft must hold one entry, but it has ${headings} dated headings ("## <YYYY-MM-DD> — "): `
      + 'write each entry with its own triqual tracking write entry');
  }
  writeAtomic(t.progress, withEntry(readIfExists(t.progress) ?? '', draft));
  return [t.progress];
}

const hasSection = (text) => text !== null && (text.includes(START) || text.includes(END));

// Every ledger, read to render the tasks section. An unusable one refuses the write, naming the file.
function readLedgers(t) {
  return ledgerPaths(t).map((path) => {
    try {
      return readEntry(path, readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Refusal(`${err.message}: fix it (or remove it) first; tracking writes that render status.md need `
        + 'every ledger readable');
    }
  });
}

function writeStatus(t, draft) {
  const ledgers = readLedgers(t);
  const next = ledgers.length || hasSection(readIfExists(t.status)) || hasSection(draft)
    ? upsertStatusSection(draft, renderSection(ledgers))
    : draft;
  writeAtomic(t.status, next);
  return [t.status];
}

// Writes `text` to `dest` only when `dest` does not exist: a complete temp file beside it, then a hard link, which
// fails with EEXIST instead of replacing a file created meanwhile.
function writeNew(dest, text, refusal) {
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { flag: 'wx' });
  try {
    linkSync(tmp, dest);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Refusal(refusal);
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function writeSpec(specsDir, draft, abs, replace) {
  const dest = join(specsDir, basename(abs));
  mkdirSync(specsDir, { recursive: true });
  const refusal = `spec ${basename(abs)} already exists in ${specsDir}: pass --replace to overwrite it`;
  if (replace) writeAtomic(dest, draft);
  else writeNew(dest, draft, refusal);
  return [dest];
}

function writePlan(t, abs, replace) {
  const { plan, message } = adoptPlan(t, abs, { replace });
  return [plan, message];
}

// ---- Store mode ----

// The full sha that `rev` (a commit-ish) names, as `git rev-parse` resolves it, run with the hook-exported repo
// variables dropped so git discovers the repository from `cwd` alone.
function resolveCommit(repoRoot, rev) {
  if (rev.startsWith('-')) throw new Refusal(`--commit: "${rev}" is not a revision`);
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Refusal(`--commit: "${rev}" does not name a commit of this repository`);
  }
}

// The daily snapshot runs after the write has committed, never inside it; a failure to take it is reported but never
// fails (or repeats) a write that is already recorded.
function snapshotAfterWrite(store, dataDir) {
  try {
    maybeDailySnapshot(store, dataDir, new Date());
  } catch (err) {
    process.stderr.write(`warning: the daily snapshot failed: ${err.message}\n`);
  }
}

// Runs fn({ store, ctx, dataDir, docsDir }) on the store of `t`'s repository, creating the repository row on the first
// write, and closes the store afterwards.
async function withStore(t, fn) {
  await loadSqlite();
  const sc = storeContext(t, { home: homedir(), env: process.env, write: true });
  try {
    return fn(sc);
  } finally {
    sc.store.close();
  }
}

async function storeAdd(t, draft, { noCommit = false, commit = null, corrects = null }) {
  const entry = parseEntryDraft(draft, { strict: true });
  if (entry.error) throw new Refusal(entry.error);
  const opts = noCommit
    ? { state: 'no_commit' }
    : commit === null ? { state: 'pending' } : { state: 'committed', commit: resolveCommit(t.repoRoot, commit) };
  const now = new Date();
  // created_at is the write time (it orders entries); the date the entry shows is the draft's own heading date.
  const dates = { createdAt: now.toISOString(), entryDate: entryDate(entry, now) };
  return withStore(t, ({ store, ctx, dataDir }) => {
    const id = store.tx(() => {
      if (corrects !== null) {
        const target = store.get('SELECT repo_id FROM entries WHERE id = ?', corrects);
        if (!target || target.repo_id !== ctx.repoId) throw new Refusal(`--corrects ${corrects}: this repository has no entry ${corrects}`);
      }
      return store.addEntry(ctx, entry, { ...opts, ...dates, corrects });
    });
    snapshotAfterWrite(store, dataDir);
    return [`entry ${id}`];
  });
}

// The body a `status set --section <heading>` draft stands for: the draft is the section as it appears in status.md
// (its `## <heading>` line, then the body) or just the body.
function sectionBody(heading, draft) {
  const parsed = parseStatusSections(draft);
  const [preamble, section, ...more] = parsed;
  if (section === undefined) return preamble.body;
  if (preamble.body !== '' || more.length) {
    throw new Refusal(`the draft holds more than one section: replace the whole status with \`${BRAND.cli} tracking status set <draft>\``);
  }
  if (section.heading !== heading) throw new Refusal(`the draft is the section "${section.heading}", not "${heading}"`);
  return section.body;
}

async function storeStatusSet(t, draft, section) {
  const parsed = section === null ? withoutActivePlan(parseStatusSections(draft)) : null;
  const sections = parsed?.sections ?? null;
  if (parsed?.dropped) process.stderr.write('note: the "Active plan" section is not stored: it is rendered live from the plan ledgers\n');
  const body = section === null ? null : sectionBody(section, draft);
  return withStore(t, ({ store, ctx, dataDir }) => {
    const now = new Date().toISOString();
    store.tx(() => {
      if (section === null) {
        store.setStatus(ctx.repoId, sections, now);
        return;
      }
      const current = store.all('SELECT heading, body, updated_at FROM status WHERE repo_id = ? ORDER BY position', ctx.repoId);
      if (!current.some((s) => s.heading === section)) {
        const known = current.map((s) => `"${s.heading}"`).join(', ') || 'none';
        throw new Refusal(`no section "${section}" in the stored status (sections: ${known}): set the whole status first`);
      }
      store.setStatus(ctx.repoId, current.map((s) => (s.heading === section ? { heading: section, body, updated_at: now } : s)), now);
    });
    snapshotAfterWrite(store, dataDir);
    return [section === null ? `status ${sections.length} sections` : `status section ${section}`];
  });
}

async function storeSpec(t, draft, abs, replace) {
  return withStore(t, ({ ctx, dataDir }) => {
    const { specsDir } = docsDirs(dataDir, ctx.repoKey);
    mkdirSync(specsDir, { recursive: true, mode: 0o700 });
    return writeSpec(specsDir, draft, abs, replace);
  });
}

// `write entry|status|spec|plan` and `add` / `status set` on a store-mode repository.
async function storeCommand(t, p) {
  const draft = readDraft(p.abs);
  if (p.verb === 'add' || p.kind === 'entry') return storeAdd(t, draft, p);
  if (p.verb === 'status' || p.kind === 'status') return storeStatusSet(t, draft, p.section ?? null);
  if (p.kind === 'spec') return storeSpec(t, draft, p.abs, p.replace);
  return storePlan(t, p.abs, p.replace);
}

// `write plan`: copies the draft into the documents directory and inits its stored ledger (`tasks init --adopt`), under
// the lock in that directory; the working tree is not touched.
async function storePlan(t, abs, replace) {
  const st = await openStoreTracking(t);
  try {
    const lines = withLock(tasksLockPath(st), () => writePlan(st, abs, replace));
    snapshotAfterWrite(st.store, st.dataDir);
    return lines;
  } finally {
    st.store.close();
  }
}

// ---- Views ----

const viewIo = () => ({ home: homedir(), env: process.env });

// `status`: the stored sections and the live Active plan section, read-only.
async function statusView(t, p) {
  await loadSqlite();
  const { sections, ledgers } = readStoreViews(t, viewIo(), null);
  // The text has the managed block's markers, as status.md and SessionStart do, so setting a read back is a round trip.
  const file = statusFileText(sections, ledgers);
  const text = file === '' || file.endsWith('\n') ? file : `${file}\n`;
  if (p.json) {
    out(JSON.stringify({ sections, plans: ledgers.map(({ name, ledger }) => planView(name, ledger)), text }, null, 2));
  } else {
    process.stdout.write(text);
  }
  return 0;
}

// What `log --json` shows of an entry: its columns without the worktree's git dir; `original` is its progress.md text
// (null for an entry written with `add`).
const ENTRY_COLUMNS = [
  'id', 'created_at', 'entry_date', 'title', 'stage_task', 'done', 'files', 'verification', 'next', 'state', 'commit_sha', 'corrects',
  'plan', 'task_key', 'branch', 'original', 'parse_ok',
];
const entryRow = (e) => Object.fromEntries(ENTRY_COLUMNS.map((k) => [k, e[k]]));

// `log`: the entries that match, newest first, read-only.
async function logView(t, p) {
  await loadSqlite();
  const entries = readStoreEntries(t, viewIo(), { last: p.last, since: p.since, plan: p.plan, grep: p.grep });
  if (p.json) out(JSON.stringify(entries.map(entryRow), null, 2));
  else if (entries.length) out(entries.map(entryText).join('\n\n'));
  return 0;
}

// ---- Import, export and restore ----

// Writes `text` to `path` readable by its owner only: a 0600 temp file beside it, renamed over it.
function writePrivate(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    unlinkSync(tmp);
    throw err;
  }
}

// `import`: the files are read and every entry's commit resolved before the store is opened, then one transaction
// writes them. Exit 1 (nothing written) when it would add an unparsed entry without --accept-unparsed.
async function importCommand(t, p) {
  if (p.replace && p.from === null && t.mode === 'store') {
    process.stderr.write('import --replace in store mode needs --from <jsonl>: a store repository is never wiped and '
      + 'rebuilt from tracking files it no longer has\n');
    return 2;
  }
  const records = p.from === null ? null : parseExport(readDraft(p.from), p.from);
  const prepared = records === null ? prepareImport(t, { ref: p.ref }) : null;
  await loadSqlite();
  const sc = storeContext(t, { home: homedir(), env: process.env, write: true, create: true });
  try {
    if (records !== null) {
      const counts = sc.store.replaceRows(sc.ctx.repoId, (store) => importRecords(store, sc.ctx, records, p.from));
      out(`import --from ${p.from}: ${counts.entries} entries, ${counts.status} status sections, ${counts.plans} plans, `
        + `${counts.tasks} tasks, ${counts.task_events} task events`);
    } else {
      let report;
      try {
        report = runImport(sc.store, sc.ctx, prepared, { acceptUnparsed: p.acceptUnparsed, replace: p.replace });
      } catch (err) {
        if (!(err instanceof UnparsedEntries)) throw err;
        for (const line of reportLines(err.report)) out(line);
        process.stderr.write(`${err.message} (listed above): fix them, or pass --accept-unparsed to import them flagged `
          + 'with their original text\n');
        return 1;
      }
      for (const line of reportLines(report)) out(line);
    }
    snapshotAfterWrite(sc.store, sc.dataDir);
    return 0;
  } finally {
    sc.store.close();
  }
}

async function exportCommand(t, p) {
  await loadSqlite();
  const sc = storeContext(t, { home: homedir(), env: process.env });
  try {
    const text = exportJsonl(sc.store, sc.ctx.repoId);
    if (p.out === null) process.stdout.write(text);
    else {
      writePrivate(p.out, text);
      out(p.out);
    }
    return 0;
  } finally {
    sc.store.close();
  }
}

async function confirmed(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

// `restore`. `io` replaces the process's environment, terminal and prompt (the tests answer the confirmation through
// it); every field defaults to the real one.
export async function restoreCommand(p, io = {}) {
  const {
    env = process.env, home = homedir(), isTTY = process.stdin.isTTY, confirm = confirmed,
    out: print = out, err = (text) => process.stderr.write(text),
  } = io;
  const paths = storePaths({ home, env });
  if (!paths) throw new StoreError('disabled', 'the tracking store is disabled: nothing to restore into');
  if (!p.yes) {
    if (!isTTY) {
      err(`restore replaces every row of ${paths.db} with the snapshot's: confirm it in a terminal, or pass --yes\n`);
      return 2;
    }
    if (!await confirm(`Replace every row of ${paths.db} with ${p.snapshot}? Type "yes" to go on: `)) {
      err('restore cancelled: nothing changed\n');
      return 1;
    }
  }
  await loadSqlite();
  const r = await restoreSnapshot({ home, env }, p.snapshot);
  const c = r.counts;
  if (r.safety) print(`saved the replaced database as ${r.safety}`);
  for (const file of r.orphans ?? []) print(`moved a leftover write-ahead log file of the lost database to ${file}`);
  print(`restored ${p.snapshot} into ${r.db}${r.copied ? ' (there was no database: the snapshot was copied in)' : ''}: `
    + `${c.entries} entries, ${c.status} status sections, ${c.plans} plans, ${c.tasks} tasks, ${c.task_events} task events`);
  return 0;
}

// ---- Arguments ----

const OPTIONS = {
  replace: { type: 'boolean' },
  'no-commit': { type: 'boolean' },
  commit: { type: 'string' },
  corrects: { type: 'string' },
  section: { type: 'string' },
  ref: { type: 'string' },
  'accept-unparsed': { type: 'boolean' },
  from: { type: 'string' },
  out: { type: 'string' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  last: { type: 'string' },
  plan: { type: 'string' },
  since: { type: 'string' },
  grep: { type: 'string' },
};

// The commands that take each flag, for the "applies to" refusal.
const FLAG_TAKEN_BY = {
  replace: 'write spec and write plan only, and to import', 'no-commit': 'add only', commit: 'add only',
  corrects: 'add only', section: 'status set only', ref: 'import only', 'accept-unparsed': 'import only',
  from: 'import only', out: 'export only', yes: 'restore only', json: 'status and log only', last: 'log only',
  plan: 'log only', since: 'log only', grep: 'log only',
};
// The flags each command takes; any other command is checked as `write`.
const TAKES = {
  add: ['no-commit', 'commit', 'corrects'], status: ['section', 'json'], log: ['last', 'plan', 'since', 'grep', 'json'], write: ['replace'],
  import: ['ref', 'accept-unparsed', 'replace', 'from'], export: ['out'], restore: ['yes'], hook: [],
};

// The `log` filters from the parsed flags: { last, plan, since, grep }, the absent ones null (last: the default).
function logOptions(values) {
  let last = LOG_DEFAULT;
  if (values.last !== undefined) {
    if (!/^[1-9]\d*$/.test(values.last) || !Number.isSafeInteger(Number(values.last))) {
      throw new UsageError(`log: --last takes a positive whole number, not "${values.last}"`);
    }
    last = Number(values.last);
  }
  if (values.since !== undefined && !isDate(values.since)) {
    throw new UsageError(`log: --since takes a date as YYYY-MM-DD, not "${values.since}"`);
  }
  return { last, plan: values.plan ?? null, since: values.since ?? null, grep: values.grep ?? null };
}

// A calendar date written YYYY-MM-DD: the month and day exist in that year.
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values } = parsed;
  const [verb, ...rest] = parsed.positionals;
  const taken = Object.hasOwn(TAKES, verb ?? '') ? TAKES[verb] : TAKES.write;
  for (const flag of Object.keys(OPTIONS)) {
    if (values[flag] !== undefined && !taken.includes(flag)) throw new UsageError(`--${flag} applies to ${FLAG_TAKEN_BY[flag]}`);
  }
  if (verb === 'import') {
    if (rest.length) throw new UsageError(`import: unexpected argument ${rest[0]}`);
    if (values.from !== undefined && !values.replace) throw new UsageError('import: --from needs --replace (it rebuilds the repository\'s rows)');
    if (values.ref !== undefined && values.replace) throw new UsageError('import: --ref and --replace exclude each other');
    return {
      verb, ref: values.ref ?? null, acceptUnparsed: values['accept-unparsed'] === true, replace: values.replace === true,
      from: values.from === undefined ? null : resolve(process.cwd(), values.from),
    };
  }
  if (verb === 'export') {
    if (rest.length) throw new UsageError(`export: unexpected argument ${rest[0]}`);
    return { verb, out: values.out === undefined ? null : resolve(process.cwd(), values.out) };
  }
  if (verb === 'restore') {
    const [snapshot, ...extra] = rest;
    if (snapshot === undefined) throw new UsageError('restore: the snapshot path is missing');
    if (extra.length) throw new UsageError(`restore: unexpected argument ${extra[0]}`);
    return { verb, snapshot: resolve(process.cwd(), snapshot), yes: values.yes === true };
  }
  if (verb === 'hook') {
    const [name, ...extra] = rest;
    if (!HOOKS.has(name ?? '')) throw new UsageError(name === undefined ? 'hook: which hook is missing (pre-commit or post-commit)' : `hook: unknown hook ${name}`);
    if (extra.length) throw new UsageError(`hook ${name}: unexpected argument ${extra[0]}`);
    return { verb, name };
  }
  if (verb === 'add') {
    const [draft, ...extra] = rest;
    if (draft === undefined) throw new UsageError('add: the draft path is missing');
    if (extra.length) throw new UsageError(`add: unexpected argument ${extra[0]}`);
    if (values['no-commit'] && values.commit !== undefined) throw new UsageError('add: --no-commit and --commit exclude each other');
    let corrects = null;
    if (values.corrects !== undefined) {
      if (!/^[1-9]\d*$/.test(values.corrects)) throw new UsageError(`add: --corrects takes an entry id, not "${values.corrects}"`);
      corrects = Number(values.corrects);
    }
    return {
      verb, abs: resolve(process.cwd(), draft), noCommit: values['no-commit'] === true, commit: values.commit ?? null, corrects,
    };
  }
  if (verb === 'log') {
    if (rest.length) throw new UsageError(`log: unexpected argument ${rest[0]}`);
    return { verb, ...logOptions(values), json: values.json === true };
  }
  if (verb === 'status') {
    const [sub, draft, ...extra] = rest;
    if (sub === undefined) {
      if (values.section !== undefined) throw new UsageError('--section applies to status set only');
      return { verb, view: true, json: values.json === true };
    }
    if (sub !== 'set') throw new UsageError(`status: unknown subcommand ${sub}`);
    if (values.json !== undefined) throw new UsageError('status set: --json applies to the status view only');
    if (draft === undefined) throw new UsageError('status set: the draft path is missing');
    if (extra.length) throw new UsageError(`status set: unexpected argument ${extra[0]}`);
    return { verb, view: false, abs: resolve(process.cwd(), draft), section: values.section?.replace(/^##\s+/, '') ?? null };
  }
  const [kind, draft, ...extra] = rest;
  if (verb !== 'write') throw new UsageError(verb === undefined ? '' : `unknown subcommand ${verb}`);
  if (!KINDS.has(kind ?? '')) throw new UsageError(kind === undefined ? 'write: what to write is missing' : `write: unknown kind ${kind}`);
  if (draft === undefined) throw new UsageError('write: the draft path is missing');
  if (extra.length) throw new UsageError(`write: unexpected argument ${extra[0]}`);
  if (values.replace && !REPLACEABLE.has(kind)) throw new UsageError(`write ${kind}: --replace applies to write spec and write plan only`);
  return { verb, kind, abs: resolve(process.cwd(), draft), replace: values.replace === true };
}

// `hook pre-commit|post-commit`, run by git from the top of the working tree. Outside store mode the pre-commit
// refuses (exit 2) and the post-commit only says so: the installed hook lines run them only when the marker is set.
async function hookCommand(t, p) {
  const io = { cwd: process.cwd(), home: homedir(), env: process.env };
  if (t?.mode !== 'store') {
    process.stderr.write(`${p.name} (progress-tracking): ${NOT_IN_STORE}\n`);
    return p.name === 'pre-commit' ? 2 : 0;
  }
  return p.name === 'pre-commit' ? preCommit(t, io) : postCommit(t, io);
}

async function main(argv) {
  const p = parse(argv);
  if (p.verb === 'restore') return restoreCommand(p);
  const t = resolveTracking(process.cwd());
  if (p.verb === 'hook') return hookCommand(t, p);
  const storeMode = t?.mode === 'store';
  if ((p.verb === 'add' || p.verb === 'status' || p.verb === 'log') && !storeMode) {
    process.stderr.write(`${NOT_IN_STORE}\n`);
    return 2;
  }
  if (!t) {
    process.stderr.write(`${NOT_OPTED_IN}\n`);
    return 2;
  }
  if (p.verb === 'import') return importCommand(t, p);
  if (p.verb === 'export') return exportCommand(t, p);
  if (storeMode) {
    if (p.verb === 'log') return logView(t, p);
    if (p.verb === 'status' && p.view) return statusView(t, p);
    for (const line of await storeCommand(t, p)) out(line);
    return 0;
  }
  const { kind, abs, replace } = p;
  const draft = readDraft(abs);
  const lines = withLock(tasksLockPath(t), () => {
    if (kind === 'entry') return writeEntry(t, draft);
    if (kind === 'status') return writeStatus(t, draft);
    if (kind === 'spec') return writeSpec(t.specsDir, draft, abs, replace);
    return writePlan(t, abs, replace);
  });
  for (const line of lines) out(line);
  return 0;
}

// `--help` or `-h` anywhere before a `--`: the usage on stdout, exit 0, nothing resolved.
const wantsHelp = (argv) => {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).some((a) => a === '--help' || a === '-h');
};

export async function cli(argv) {
  if (wantsHelp(argv)) {
    out(USAGE);
    process.exitCode = 0;
    return;
  }
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    if (err instanceof UsageError) process.stderr.write(`${err.message ? `${err.message}\n` : ''}${USAGE}\n`);
    else process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
  }
}

// True when node runs this file itself (the `triqual` shim spawns it), not when another module imports it.
function isEntry() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntry()) cli(process.argv.slice(2));
