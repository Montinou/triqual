// Claude Code hooks for strict progress tracking. A repo opts in by having progress.md in either tracking root
// (lib/tracking.mjs); anywhere else (no git repo, or not opted in) both hooks are silent.
//   node gate.mjs stop            Stop hook: no turn ends with uncommitted work unless progress.md records it; with a
//                                 session_id it blocks once per change set (state outside every working tree)
//   node gate.mjs session-start   SessionStart hook: registers the repo in ~/.config/triqual/repos.json
//                                 (silently), then injects status.md, the latest progress.md entry, active plans
//     [--budget <n>]              the hook output stays under n characters instead of 9,500 (n: an integer from
//                                 1000 to 9500; anything else is ignored). Used by `triqual hook` (spec Addendum F.3).
// A hook never breaks a session: any error ends it with exit 0 and no output. The exception is fail-closed on
// purpose: in local mode an unreadable state.json or progress.md blocks the stop instead of silently disabling the gate.
// Store mode (`git config --local triqual.tracking store`) has its own Stop: a dirty worktree needs a pending entry of
// its own in the tracking store, and a store that cannot be read blocks too (lib/store-hooks.mjs). Its SessionStart
// builds the same context from the store, read-only (a repository the store has not seen is not added to it); on any
// store error it prints one notice line instead.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTracking, readState, progressHash, storeFingerprint } from '../lib/tracking.mjs';
import { pendingIds, stopVerdictStore, storeFailure, storeWhere } from '../lib/store-hooks.mjs';
import { loadSqlite } from '../lib/store.mjs';
import { entryText, readStoreViews, statusFileText } from '../lib/snapshot.mjs';
import { statusLine } from '../lib/ledger.mjs';
import { ledgerPaths, readEntry } from '../lib/ledger-files.mjs';
import { registerRepo } from '../lib/registry.mjs';
import { BRAND, brandDir } from '../lib/brand.mjs';
import { writeAtomic, sha256 } from '../lib/fsx.mjs';

const PROGRESS = 'progress.md';
const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const OUTPUT_CAP = 9_500; // the SessionStart hook's whole stdout stays under this many characters
const BUDGET_MIN = 1_000;
const STATUS_TRUNCATED = '[status.md truncated: read the full file]';
const CONTEXT_TRUNCATED = '[session context truncated]';
const SKILL = 'Details: skill progress-tracking:progress-tracking.';

const COMMITTED_REASON = 'There are uncommitted changes and progress.md is not updated. Before ending the turn, add ' +
  'the entry for this work at the top of progress.md (stage/task, done, files, real verification, commit, next) and ' +
  `update status.md if the overall state changed. ${SKILL}`;
// Local mode: the files live under the git dir, where Claude Code refuses an agent's file writes, so the reasons name
// `triqual tracking write`, which writes them itself.
const WRITE = `${BRAND.cli} tracking write`;
const localWrite = (t) => 'Before ending the turn, write the entry for this work to a draft file outside the repo and ' +
  `run \`${WRITE} entry <draft>\` (it lands at the top of that file; agents cannot edit files under the git ` +
  `dir), and if the overall state changed, \`${WRITE} status <draft>\` with the whole new ${t.status}. ${SKILL}`;
const localReason = (t) => 'There are uncommitted changes and progress.md has no new entry since the last gated ' +
  `commit (local mode: ${t.progress}). ${localWrite(t)}`;
const hooklessReason = (t) => 'There are uncommitted changes and progress.md has not changed since the last commit ' +
  `(local mode without git hooks: ${t.progress}). ${localWrite(t)}`;
const HEADER = 'This repo uses strict progress tracking (skill progress-tracking:progress-tracking): at the end of ' +
  'every task, add an entry at the top of progress.md and update status.md, in the same commit.';
// Local mode: the files are under the git dir, which agents cannot write, so the header names `triqual tracking write`.
const localHeader = (root) => 'This repo uses strict progress tracking in local mode (skill ' +
  `progress-tracking:progress-tracking): the files live in ${root} and are never committed. At the end of every task, ` +
  `write the entry to a draft file outside the repo and run \`${WRITE} entry <draft>\`, and update status.md ` +
  `the same way with \`${WRITE} status <draft>\` (agents cannot edit files under the git dir).`;
// Store mode: the entries, the status and the plans live in the tracking store, so the header names `triqual tracking`.
const TRACKING_CLI = `${BRAND.cli} tracking`;
const STORE_HEADER = 'This repo uses strict progress tracking in store mode (skill progress-tracking:progress-tracking): ' +
  'the entries, the status and the plans live in the local tracking store, never in the working tree. At the end of ' +
  `every task, write the entry to a draft file outside the repo and run \`${TRACKING_CLI} add <draft>\`, and update ` +
  `the status with \`${TRACKING_CLI} status set <draft>\`. Read them back with \`${TRACKING_CLI} status\` and ` +
  `\`${TRACKING_CLI} log\`.`;

// Committed-mode tracking files: progress.md, status.md and docs/plans/<one segment>.tasks.json (paths from the repo
// root). Mirrored by the committed pre-commit gate.
const TRACKING_FILE = /^(?:progress\.md|status\.md|docs\/plans\/[^/]+\.tasks\.json)$/;
export const isTrackingFile = (relPath) => TRACKING_FILE.test(relPath);

// `git status --porcelain -z` records are "XY path", NUL-terminated and never quoted; a rename or copy (R or C in
// either column) is followed by one more record holding its old path, which is skipped: the new path is the one kept.
// Stop asks for --no-renames, so a file renamed into a tracking path shows as a deletion plus an addition.
export function parsePorcelain(out) {
  const records = out.split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    paths.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2))) i++;
  }
  return paths;
}

// The newest entry is the first "## " section (entries are added on top).
export function latestEntry(text) {
  const start = text.search(/^## /m);
  if (start === -1) return null;
  const rest = text.slice(start);
  const next = rest.slice(3).search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next + 3)).trim();
}

function hasEntry(path) {
  try {
    return latestEntry(readFileSync(path, 'utf8')) !== null;
  } catch {
    return false; // unreadable reads as "no entry", so the gate stays closed
  }
}

// Local mode: has progress.md changed since the last gated commit? With no hash recorded yet, only a progress.md that
// exists and holds at least one entry counts as changed (a fresh template does not).
function progressChanged(t, currentHash, lastHash) {
  if (lastHash !== null) return currentHash !== lastHash;
  return currentHash !== null && hasEntry(t.progress);
}

const block = (reason) => ({ decision: 'block', reason });

// Local mode without git hooks: is progress.md newer than the last commit? Commit times have one-second resolution, so
// a progress.md written during the commit's own second does not count (it may predate the commit): fail closed.
const newerThanCommit = ({ commitTime, progressMtimeMs }) => Math.floor(progressMtimeMs / 1000) > commitTime;

// Committed mode blocks when a non-tracking path is dirty and progress.md is not. Local mode blocks when anything is
// dirty (the tracking root is inside the git dir, so every dirty path is work) and progress.md has not changed since
// the last gated commit (state.json). With no git hooks installed (`sinceCommit`) state.json is never updated after
// init, so progress.md must ALSO be newer than the last commit: the hash alone never re-arms, the mtime alone lets
// the fresh template through.
export function stopVerdict({ dirty, tracking, input, currentHash, lastHash, sinceCommit = null }) {
  if (input?.stop_hook_active || !dirty.length) return null;
  if (tracking.mode === 'local' && sinceCommit) {
    const changed = newerThanCommit(sinceCommit) && progressChanged(tracking, currentHash, lastHash);
    return changed ? null : block(hooklessReason(tracking));
  }
  if (tracking.mode === 'local') {
    return progressChanged(tracking, currentHash, lastHash) ? null : block(localReason(tracking));
  }
  if (dirty.every(isTrackingFile) || dirty.includes(PROGRESS)) return null;
  return block(COMMITTED_REASON);
}

const sessionOutput = (ctx) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
const fits = (ctx, cap) => JSON.stringify(sessionOutput(ctx)).length < cap;

// text.slice(0, n), one shorter when that would split a surrogate pair.
function cut(text, n) {
  const code = text.charCodeAt(n - 1);
  return n > 0 && code >= 0xd800 && code <= 0xdbff ? text.slice(0, n - 1) : text.slice(0, n);
}

// build(the longest prefix of `text` whose built output fits in `cap`), or null when not even build('') fits. `build`
// must grow with its argument, so the search can bisect.
function longestFit(text, build, cap) {
  if (!fits(build(''), cap)) return null;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(cut(text, mid)), cap)) lo = mid;
    else hi = mid - 1;
  }
  return build(cut(text, lo));
}

// The SessionStart context. Its hook output (the JSON the hook prints) stays under `cap` characters: status.md is
// truncated first, and only if that is not enough is the whole context cut.
export function sessionContext({ tracking, status, progress, activeLines, cap = OUTPUT_CAP, note = null }) {
  const entry = latestEntry(progress);
  const header = tracking.mode === 'local' ? localHeader(tracking.root) : tracking.mode === 'store' ? STORE_HEADER : HEADER;
  const build = (statusBody) => [
    header,
    ...(note ? [note] : []),
    `=== status.md ===\n${statusBody}`,
    `=== Latest progress.md entry ===\n${entry ?? '(no entries yet)'}`,
    ...(activeLines.length ? [`=== Active plans ===\n${activeLines.join('\n')}`] : []),
  ].join('\n\n');
  const body = status.trim();
  const full = build(body || '(empty)');
  if (fits(full, cap)) return full;
  const truncated = longestFit(body, (prefix) => {
    const kept = prefix.trimEnd();
    return build(kept ? `${kept}\n\n${STATUS_TRUNCATED}` : STATUS_TRUNCATED);
  }, cap);
  if (truncated !== null) return truncated;
  return longestFit(build(STATUS_TRUNCATED), (prefix) => `${prefix.trimEnd()}\n\n${CONTEXT_TRUNCATED}`, cap);
}

// The cap `--budget <n>` asks for: n when it is an integer from BUDGET_MIN to OUTPUT_CAP, else OUTPUT_CAP.
function budgetCap(args) {
  const i = args.indexOf('--budget');
  const raw = i === -1 ? undefined : args[i + 1];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return OUTPUT_CAP;
  const n = Number(raw);
  return n >= BUDGET_MIN && n <= OUTPUT_CAP ? n : OUTPUT_CAP;
}

// ---- hook I/O ----

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

const byNameDesc = (a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

// One statusLine per active ledger, newest name first. An unusable ledger is skipped; any other failure (plansDir
// unreadable) omits the block.
function activeLines(t) {
  try {
    const active = [];
    for (const path of ledgerPaths(t)) {
      try {
        const { name, ledger } = readEntry(path, readFileSync(path, 'utf8'));
        if (ledger.state === 'active') active.push({ name, line: statusLine(name, ledger) });
      } catch {
        // skipped: unreadable, not JSON, or not a ledger
      }
    }
    return active.sort(byNameDesc).map((a) => a.line);
  } catch {
    return [];
  }
}

const git = (repoRoot, args) => execFileSync('git', args, {
  cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER,
  stdio: ['ignore', 'pipe', 'ignore'],
});

// The trimmed output of a git command that may fail on purpose (an unset config key, an unborn HEAD): '' then.
function gitOr(repoRoot, args) {
  try {
    return git(repoRoot, args).trim();
  } catch {
    return '';
  }
}

const dirtyPaths = (repoRoot) => parsePorcelain(
  git(repoRoot, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']));

// With core.hooksPath set (repo or global config) init --local installs no hook, so nothing records a gated commit
// in state.json: the last commit's time (seconds) is the reference instead. null when hooks are installed or HEAD is
// unborn (the hash rule applies).
function hooklessCommitTime(repoRoot) {
  if (!gitOr(repoRoot, ['config', 'core.hooksPath'])) return null;
  const ct = gitOr(repoRoot, ['log', '-1', '--format=%ct']);
  return /^\d+$/.test(ct) ? Number(ct) : null;
}

// Fail closed on what could not be read, and say why (only reached with dirty paths and no stop_hook_active).
const closed = (reason, detail) => block(`${reason} (${detail})`);

function judge(t, input, dirty) {
  if (t.mode !== 'local') return stopVerdict({ dirty, tracking: t, input, currentHash: null, lastHash: null });
  if (input?.stop_hook_active || !dirty.length) return null;
  const commitTime = hooklessCommitTime(t.repoRoot);
  const reason = commitTime === null ? localReason(t) : hooklessReason(t);
  let currentHash;
  try {
    currentHash = progressHash(t);
  } catch (err) {
    return closed(reason, `progress.md could not be read: ${err.message}`);
  }
  let lastHash;
  try {
    lastHash = readState(t).lastProgressSha256; // a pending hash is ignored: only post-commit promotes it
  } catch (err) {
    return closed(reason, `state.json could not be read: ${err.message}`);
  }
  if (commitTime === null) return stopVerdict({ dirty, tracking: t, input, currentHash, lastHash });
  let progressMtimeMs;
  try {
    progressMtimeMs = statSync(t.progress).mtimeMs;
  } catch (err) {
    return closed(reason, `progress.md could not be read: ${err.message}`);
  }
  return stopVerdict({ dirty, tracking: t, input, currentHash, lastHash, sinceCommit: { commitTime, progressMtimeMs } });
}

// ---- once per change set ----

const SESSION_ID = /^[A-Za-z0-9_-]+$/; // a file name, never a path
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // state files untouched this long are pruned

// Best effort: removes the *.json state files in `dir` whose mtime is older than STATE_MAX_AGE_MS. Errors are ignored.
function pruneStates(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const path = join(dir, name);
        if (now - lstatSync(path).mtimeMs > STATE_MAX_AGE_MS) unlinkSync(path);
      } catch {
        // skipped: gone, or not removable
      }
    }
  } catch {
    // the dir could not be listed: nothing pruned
  }
}

// [mtimeMs, size] of a dirty path; [-1, -1] when it is gone.
function statOf(path) {
  try {
    const s = lstatSync(path);
    return [s.mtimeMs, s.size];
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [-1, -1];
    throw err;
  }
}

// sha256 of the repo root, the sorted dirty non-tracking paths with their mtimeMs and size, and the progress hash. In
// local mode every dirty path is work (the tracking files live in the git dir); committed mode leaves out the tracking
// files, so a ledger move alone is not a new change set.
function fingerprint(t, dirty) {
  const work = t.mode === 'local' ? dirty : dirty.filter((p) => !isTrackingFile(p));
  const paths = [...work].sort().map((p) => [p, ...statOf(join(t.repoRoot, p))]);
  return sha256(JSON.stringify({ repoRoot: t.repoRoot, paths, progress: progressHash(t) }));
}

// `path` absolute with its nearest existing ancestor's symlinks resolved, so a data dir reached through a link into
// the repo is still seen as inside it.
function resolveExisting(path) {
  const rest = [];
  let cur = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (err) {
      const up = dirname(cur);
      if (up === cur) throw err;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// This session's state file, <CLAUDE_PLUGIN_DATA, else brandDir(tmpdir)>/stop/<session_id>.json, or null when the
// session_id is unusable or that dir lies inside the working tree. Throws when the dir cannot be resolved.
function stopStatePath(t, input) {
  const id = input?.session_id;
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
  const dir = resolveExisting(join(process.env.CLAUDE_PLUGIN_DATA || brandDir(tmpdir()), 'stop'));
  if (isInside(t.repoRoot, dir)) return null;
  return join(dir, `${id}.json`);
}

// The fingerprint of the session's last recorded block, or null when there is no usable record.
function lastFingerprint(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).fingerprint;
  } catch {
    return null;
  }
}

function recordBlock(path, current) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  writeAtomic(path, `${JSON.stringify({ fingerprint: current, blockedAt: now.toISOString() })}\n`);
  pruneStates(dir, now.getTime());
}

// A block whose fingerprint matches this session's last recorded block lets the turn end silently; a new one is
// recorded in <CLAUDE_PLUGIN_DATA, else brandDir(tmpdir)>/stop/<session_id>.json. No usable session_id, a data
// dir inside the working tree, or any failure computing, reading or writing the state keeps the block.
function oncePerChangeSet(t, dirty, input, verdict) {
  try {
    const path = stopStatePath(t, input);
    if (path === null) return verdict;
    const current = fingerprint(t, dirty);
    if (lastFingerprint(path) === current) return null;
    recordBlock(path, current);
  } catch {
    // today's behavior: block
  }
  return verdict;
}

function stop(t, input) {
  const dirty = dirtyPaths(t.repoRoot);
  const verdict = judge(t, input, dirty);
  return verdict ? oncePerChangeSet(t, dirty, input, verdict) : null;
}

// Stop in store mode. Nothing is read from tracking files (a store repository has none): the pending entries of this
// worktree come from the store, read-only, and the once-per-change-set fingerprint is the store one (dirty paths and
// pending ids). A store that cannot be read blocks with the failure, once per change set as well. A clean tree or a
// stop that continues a block never opens the store.
async function stopStore(t, input) {
  const dirty = dirtyPaths(t.repoRoot);
  if (input?.stop_hook_active || !dirty.length) return null;
  const io = { home: homedir(), env: process.env };
  let pending = [];
  let storeError = null;
  try {
    pending = await pendingIds(t, io);
  } catch (err) {
    storeError = { code: err?.code, message: err?.message ?? String(err), where: storeWhere(io) };
  }
  let path = null;
  let current = null;
  try {
    path = stopStatePath(t, input);
    // A failure is its own change set: a no-pending block of the same dirty state must not let it pass silently.
    current = storeFingerprint(t, pending, dirty);
    if (storeError) current = `${current}:store-failed:${storeError.code ?? 'error'}`;
  } catch {
    // no usable state: every stop blocks
  }
  const last = path === null ? null : lastFingerprint(path);
  const verdict = stopVerdictStore({ dirty, input, pending, storeError, fingerprint: current, lastFingerprint: last });
  if (verdict && path !== null && current !== null) {
    try {
      recordBlock(path, current);
    } catch {
      // not recorded: the next stop blocks again
    }
  }
  return verdict;
}

// The SessionStart context of a store repository: status.md's text (the stored sections, and the tasks section rendered
// live from the ledgers), the latest entry and the active plans, all read through a read-only connection. The latest
// entry is the newest one that is committed or written in this worktree: another worktree's pending draft is left out
// (`tracking log` lists the whole repository). A repository the store has not seen yet reads as an empty one, with a
// neutral line saying so.
async function storeSessionContext(t, io, cap) {
  await loadSqlite();
  const { seen, sections, ledgers, entries } = readStoreViews(t, io, { last: 1, worktree: t.gitDir });
  const active = ledgers.filter((l) => l.ledger.state === 'active').map((l) => statusLine(l.name, l.ledger));
  return sessionContext({
    tracking: t, status: statusFileText(sections, ledgers), progress: entries.length ? entryText(entries[0]) : '',
    activeLines: active, cap, note: seen ? null : `this repository has no rows in the tracking store at ${storeWhere(io)} yet`,
  });
}

// One line for a store that cannot be read. A store failure (a StoreError, or an SQLite error after the open) is told in
// the words of the Stop and pre-commit gates: database path, error code, recovery command. Any other error is a bug in
// the hook, not in the store, so it is named without the recovery advice. Never a stack trace, and never silence: the
// session shows why the context is missing.
export function storeNotice(err, io, cap) {
  const store = err?.name === 'StoreError' || typeof err?.errcode === 'number';
  const why = store ? storeFailure(err, io) : `could not build the tracking context (${err?.name ?? 'Error'}: ${err?.message ?? String(err)})`;
  const line = `progress-tracking (store mode): ${why}`.replace(/\s+/g, ' ').trim();
  return longestFit(line, (prefix) => prefix, cap) ?? '';
}

async function readInput() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main(mode, args = []) {
  const input = await readInput();
  const t = resolveTracking(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  if (!t) return;
  if (mode === 'stop') {
    const verdict = t.mode === 'store' ? await stopStore(t, input) : stop(t, input);
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } else if (mode === 'session-start') {
    registerRepo(homedir(), { root: t.repoRoot, mode: t.mode, now: new Date() }); // silent, never throws
    const cap = budgetCap(args);
    let ctx;
    if (t.mode === 'store') {
      const io = { home: homedir(), env: process.env };
      try {
        ctx = await storeSessionContext(t, io, cap);
      } catch (err) {
        ctx = storeNotice(err, io, cap);
      }
    } else {
      ctx = sessionContext({
        tracking: t, status: readText(t.status), progress: readText(t.progress), activeLines: activeLines(t), cap,
      });
    }
    process.stdout.write(JSON.stringify(sessionOutput(ctx)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main(process.argv[2], process.argv.slice(3));
  } catch {
    // a hook never breaks the session: exit 0, no output
  }
}
