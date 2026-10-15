#!/usr/bin/env node
// `triqual tasks`: the task-ledger CLI (spec §6.2). Exit codes: 0 ok (and for --help/-h), 1 `check` found drift, 2 invalid
// transition, bad arguments, ambiguous ledger, not opted in (except `paths --json`, which reports it) or a lock
// timeout; `line` always exits 0. Every ledger and status.md write is atomic, and every mutating subcommand runs under
// the tracking root's lock (tasksLockPath), from its first read through the status.md render, so concurrent sessions
// never lose an update. Importing this module runs nothing; it re-exports LOCAL_HOOK_LINES and NOT_OPTED_IN, and exports
// adoptPlan for `triqual tracking write plan`.
//
// Store mode (`git config --local triqual.tracking store`, plan tracking-store-1) keeps the ledgers in the local database:
// the same subcommands, exit codes and messages, but no `*.tasks.json`, no status.md and nothing under the git dir is
// written. A store command awaits loadSqlite() first and then runs synchronously, so committed and local mode never load
// node:sqlite. `--plan` names a stored plan by its file name (with or without `.md`), a path to it, or its stored path.
// The plan documents live in the repository's documents directory under the data directory (`paths --json` names it);
// a transition is one database transaction, and the writes also hold the lock in that directory. `render` prints the
// section instead of writing it; `check` compares each plan whose document exists against the store; `line` and the
// views open the database read-only.
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LOCAL_HOOK_LINES, NOT_OPTED_IN } from '../scripts/init.mjs';
import { roleOf } from '../lib/roles.mjs';
import { resolveTracking, storeTracking } from '../lib/tracking.mjs';
import { docsDirs, loadSqlite, maybeDailySnapshot, repoKey, storePaths } from '../lib/store.mjs';
import { writeAtomic } from '../lib/fsx.mjs';
import { withLock, tasksLockPath } from '../lib/lock.mjs';
import { buildSnapshot, byNameDesc, planName } from '../lib/snapshot.mjs';
import { readRegistry, listResolved } from '../lib/registry.mjs';
import { LEDGER_EXT, entry, readEntry, ledgerPaths } from '../lib/ledger-files.mjs';
import {
  LedgerError, parsePlan, createLedger, reconcile, transition,
  renderSection, upsertStatusSection, nextTask, statusLine, checkLedger, checkSchema, checkSection, counts,
} from '../lib/ledger.mjs';

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MARKER_ERRORS = new Set(['status.md tasks section is misordered', 'status.md tasks section is unterminated']);
const MARKER_HINT = ' — fix the <!-- tasks:start/end --> markers in status.md by hand';
// Repo-selecting variables a git hook exports. Scrubbed for repo-level queries, which then target the repo found from
// the tracking root; kept for index reads, because commit -a / commit <paths> point GIT_INDEX_FILE at a temp index.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

export { LOCAL_HOOK_LINES, NOT_OPTED_IN };

const USAGE = `usage: triqual tasks <subcommand> [args]
  init <plan.md> [--adopt] [--spec <path>] [--branch <b>]
  start|review|rework|restore T<N> [--plan <plan.md|ledger>]
  done T<N> --commit <sha> [--plan <plan.md|ledger>]
  block|drop|reopen T<N> "<reason>" [--plan <plan.md|ledger>]
  retitle T<N> "<title>" [--plan <plan.md|ledger>]
  close [--plan <plan.md|ledger>]
  status [--json]
  next [--plan <plan.md|ledger>]
  check [--staged]
  render
  paths --json
  export --json [--all]
  line`;

class UsageError extends Error {}

const out = (line) => process.stdout.write(`${line}\n`);
const withMarkerHint = (message) => (MARKER_ERRORS.has(message) ? `${message}${MARKER_HINT}` : message);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const serialize = (ledger) => `${JSON.stringify(ledger, null, 2)}\n`;
const ids = (list) => list.join(', ') || 'none';
const posix = (p) => p.split(sep).join('/');
const isActive = (l) => l.ledger.state === 'active';

// ---- git ----

function git(cwd, args, { inherit = false } = {}) {
  const env = { ...process.env };
  if (!inherit) for (const key of REPO_ENV) delete env[key];
  return execFileSync('git', args, {
    cwd, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
  });
}

// The full 40-char sha a revision names, or null when it does not resolve to a commit.
function resolveCommit(repoRoot, rev) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-')) return null;
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

function currentBranch(repoRoot) {
  try {
    return git(repoRoot, ['branch', '--show-current']).trim() || null;
  } catch {
    return null;
  }
}

// A staged file's content (`git show :<path>`, path from the repo top), or null when the index has no such path.
function showStaged(repoPath) {
  try {
    return git(process.cwd(), ['show', `:${repoPath}`], { inherit: true });
  } catch {
    return null;
  }
}

// ---- files ----

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Every ledger in plansDir. Writes fail closed on an unusable one; read-only views pass `skip` to warn and go on
// (`warn: false` skips silently, for `line`).
function loadLedgers(t, { skip = false, warn = true } = {}) {
  const ledgers = [];
  for (const path of ledgerPaths(t)) {
    try {
      ledgers.push(readEntry(path, readFileSync(path, 'utf8')));
    } catch (err) {
      if (!skip || !(err instanceof LedgerError)) throw err;
      if (warn) process.stderr.write(`warning: skipping ${path}: ${err.reason ?? err.message}\n`);
    }
  }
  return ledgers;
}

// True when `path` sits directly in plansDir (both sides compared through symlinks).
function inPlansDir(t, path) {
  try {
    return realpathSync(dirname(path)) === realpathSync(t.plansDir);
  } catch {
    return false;
  }
}

// The status.md text with the section rendered over `ledgers`; throws (before any write) on bad markers.
function renderedStatus(t, ledgers) {
  const current = readIfExists(t.status);
  const next = upsertStatusSection(current ?? '', renderSection(ledgers.map(({ name, ledger }) => ({ name, ledger }))));
  return { current, next };
}

function writeStatus(t, { current, next }) {
  if (current !== next) writeAtomic(t.status, next);
}

// ---- ledger selection ----

function selectLedger(t, planOpt, { skip = false } = {}) {
  if (planOpt !== undefined) {
    const abs = resolve(process.cwd(), planOpt);
    const path = abs.endsWith('.md') ? `${abs.slice(0, -3)}${LEDGER_EXT}` : abs;
    if (!path.endsWith(LEDGER_EXT) || !existsSync(path)) throw new LedgerError(`no ledger at ${path}`);
    if (!inPlansDir(t, path)) throw new LedgerError(`ledger must be in ${t.plansDir}: ${path}`);
    const inDir = join(t.plansDir, basename(path));
    return readEntry(inDir, readFileSync(inDir, 'utf8'));
  }
  const active = loadLedgers(t, { skip }).filter(isActive);
  if (active.length === 1) return active[0];
  if (!active.length) throw new LedgerError(`no active ledger in ${t.plansDir}`);
  throw new LedgerError(`${active.length} active ledgers; pick one with --plan:\n${active.map((l) => `  ${l.path}`).join('\n')}`);
}

// Saves `ledger` at `path` and re-renders status.md over every ledger, with `ledger` in place of the one at `path`.
// status.md is computed first, so a bad marker refuses the change before anything is written.
function save(t, path, ledger) {
  const ledgers = loadLedgers(t).filter((l) => l.path !== path).concat(entry(path, ledger));
  const status = renderedStatus(t, ledgers);
  writeAtomic(path, serialize(ledger));
  writeStatus(t, status);
}

// ---- subcommands ----

// The plan's tasks; throws when a dependency names a task neither the plan nor the existing ledger (`known`) holds.
function planTasks(text, known = []) {
  const tasks = parsePlan(text);
  const ids = new Set([...tasks.map((x) => x.id), ...known]);
  for (const { id, deps } of tasks) {
    const unknown = deps.find((d) => !ids.has(d));
    if (unknown !== undefined) throw new LedgerError(`${id} depends on ${unknown} (unknown task)`);
  }
  return tasks;
}

// Writes `text` to `dest` only when `dest` does not exist: a complete temp file in dest's directory, then a hard link,
// which fails with EEXIST instead of replacing a file created meanwhile.
function writeNew(dest, text) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { flag: 'wx' });
  try {
    linkSync(tmp, dest);
  } catch (err) {
    if (err.code === 'EEXIST') throw new LedgerError(`plan ${basename(dest)} already exists`);
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

// `init --adopt <file>`: lands a plan drafted anywhere (in local mode, outside the git dir that agents may not write)
// in plansDir under its own name, then inits it. A draft that would not init is refused before anything is copied, and
// cmdInit removes the copy when a later step fails, so no orphan blocks the name.
function adopt(t, planArg) {
  const abs = resolve(process.cwd(), planArg);
  if (!abs.endsWith('.md')) throw new LedgerError(`plan must be a .md file: ${planArg}`);
  if (!existsSync(abs)) throw new LedgerError(`plan ${abs} not found`);
  const dest = join(t.plansDir, basename(abs));
  if (existsSync(dest)) throw new LedgerError(`plan ${basename(abs)} already exists`);
  const text = readFileSync(abs, 'utf8');
  planTasks(text);
  if (t.mode === 'store') mkdirSync(t.plansDir, { recursive: true, mode: 0o700 });
  writeNew(dest, text);
  return dest;
}

// Adopts the plan drafted at `planArg` and inits it; returns { plan: <copy in plansDir>, message }. The caller holds the
// tracking root's lock. `replace` (`triqual tracking write plan --replace`): an existing plan of that name is overwritten
// atomically and its ledger reconciled; when a later step fails the previous plan text is put back.
export function adoptPlan(t, planArg, { replace = false, spec, branch } = {}) {
  const abs = resolve(process.cwd(), planArg);
  const dest = join(t.plansDir, basename(abs));
  const previous = replace && abs.endsWith('.md') ? readIfExists(dest) : null;
  if (previous === null) {
    const copy = adopt(t, planArg);
    const ledgerPath = `${copy.slice(0, -3)}${LEDGER_EXT}`;
    const hadLedger = existsSync(ledgerPath);
    try {
      return { plan: copy, message: initFor(t, { spec, branch }, copy, planArg) };
    } catch (err) {
      try {
        unlinkSync(copy);
        if (!hadLedger && t.mode !== 'store') rmSync(ledgerPath, { force: true });
      } catch { /* the original error is the one to report */ }
      throw err;
    }
  }
  if (!existsSync(abs)) throw new LedgerError(`plan ${abs} not found`);
  const text = readFileSync(abs, 'utf8');
  planTasks(text);
  writeAtomic(dest, text);
  try {
    return { plan: dest, message: initFor(t, { spec, branch }, dest, planArg) };
  } catch (err) {
    try { writeAtomic(dest, previous); } catch { /* the original error is the one to report */ }
    throw err;
  }
}

function cmdInit(t, values, positionals) {
  const message = values.adopt
    ? adoptPlan(t, positionals[0], values).message
    : initFor(t, values, resolve(process.cwd(), positionals[0]), positionals[0]);
  out(message);
  return 0;
}

// The init of the repository's own storage: the ledger file and status.md, or (store mode) the database.
const initFor = (t, opts, abs, planArg) => (t.mode === 'store' ? storeInit : initPlan)(t, opts, abs, planArg);

// Inits (or reconciles) the ledger of the plan at `abs` in plansDir and re-renders status.md; returns the message.
function initPlan(t, { spec, branch }, abs, planArg) {
  if (!abs.endsWith('.md')) throw new LedgerError(`plan must be a .md file: ${planArg}`);
  if (!existsSync(abs)) throw new LedgerError(`plan ${abs} not found`);
  if (!inPlansDir(t, abs)) throw new LedgerError(`plan must be in ${t.plansDir}: ${abs}`);
  const planPath = join(t.plansDir, basename(abs));
  const ledgerPath = `${planPath.slice(0, -3)}${LEDGER_EXT}`;
  const base = t.mode === 'committed' ? t.repoRoot : t.root;
  const current = existsSync(ledgerPath) ? readEntry(ledgerPath, readFileSync(ledgerPath, 'utf8')).ledger : null;
  const known = Array.isArray(current?.tasks) ? current.tasks.map((x) => x?.id) : [];
  const tasks = planTasks(readFileSync(planPath, 'utf8'), known);
  const at = now();

  let ledger;
  let message;
  let changed = true;
  if (current) {
    const r = reconcile(current, tasks, at);
    ledger = r.ledger;
    changed = serialize(ledger) !== serialize(current);
    message = `reconciled ${ledgerPath}: added ${ids(r.added)}; missing ${ids(r.missing)}; retitled ${ids(r.retitled)}`;
  } else {
    ledger = createLedger({
      plan: posix(relative(base, planPath)),
      spec: spec === undefined ? null : posix(relative(base, resolve(process.cwd(), spec))),
      branch: branch ?? currentBranch(t.repoRoot),
      tasks,
      now: at,
    });
    message = `created ${ledgerPath}`;
  }
  const ledgers = loadLedgers(t).filter((l) => l.path !== ledgerPath).concat(entry(ledgerPath, ledger));
  const status = renderedStatus(t, ledgers);
  if (changed) writeAtomic(ledgerPath, serialize(ledger));
  writeStatus(t, status);
  return message;
}

// ---- store mode ----

// Every stored plan of the repository as a ledger entry: { path (as stored), name, planId, ledger }.
function storeLedgers(st) {
  if (st.repoId === null) return [];
  return st.store.plans(st.repoId).map((p) => ({ path: p.path, name: planName(p.path), planId: p.id, ledger: st.store.ledgerOf(p.id) }));
}

// The stored plan `planOpt` names (its file name with or without `.md`, a path to it, its stored path), else the one
// active plan.
function selectStoreLedger(st, planOpt) {
  const all = storeLedgers(st);
  if (planOpt !== undefined) {
    const stem = basename(planOpt).replace(/(\.tasks\.json|\.md)$/, '');
    const found = all.filter((l) => l.path === planOpt || l.name === stem);
    if (!found.length) throw new LedgerError(`no ledger for ${planOpt} in the store`);
    if (found.length > 1) throw new LedgerError(`${found.length} plans match ${planOpt}; use a stored path:\n${found.map((l) => `  ${l.path}`).join('\n')}`);
    return found[0];
  }
  const active = all.filter(isActive);
  if (active.length === 1) return active[0];
  if (!active.length) throw new LedgerError('no active ledger in the store');
  throw new LedgerError(`${active.length} active ledgers; pick one with --plan:\n${active.map((l) => `  ${l.path}`).join('\n')}`);
}

// A spec path as the ledger stores it: relative to the documents directory when it lives there, else to the repository.
function storeSpec(st, spec) {
  const abs = resolve(process.cwd(), spec);
  const inDocs = relative(st.docsDir, abs);
  return posix(inDocs && !inDocs.startsWith('..') && !inDocs.includes(':') ? inDocs : relative(st.repoRoot, abs));
}

// The store counterpart of initPlan: the plan at `abs` (in the documents directory) inits or reconciles its stored
// ledger, in one transaction; returns the message. A plan already stored under another path with the same file name is
// the same plan.
function storeInit(st, { spec, branch }, abs, planArg) {
  if (!abs.endsWith('.md')) throw new LedgerError(`plan must be a .md file: ${planArg}`);
  if (!existsSync(abs)) throw new LedgerError(`plan ${abs} not found`);
  if (!inPlansDir(st, abs)) throw new LedgerError(`plan must be in ${st.plansDir}: ${abs}`);
  const file = basename(abs);
  const planPath = join(st.plansDir, file);
  const text = readFileSync(planPath, 'utf8');
  const specPath = spec === undefined ? null : storeSpec(st, spec);
  const branchName = branch ?? currentBranch(st.repoRoot);
  const at = now();
  return st.store.tx(() => {
    const existing = storeLedgers(st).find((l) => basename(l.path) === file);
    const current = existing?.ledger ?? null;
    const tasks = planTasks(text, current?.tasks.map((x) => x.id) ?? []);
    if (current) {
      const r = reconcile(current, tasks, at);
      if (serialize(r.ledger) !== serialize(current)) st.store.saveLedger(existing.planId, r.ledger);
      return `reconciled ${planPath}: added ${ids(r.added)}; missing ${ids(r.missing)}; retitled ${ids(r.retitled)}`;
    }
    const ledger = createLedger({ plan: `plans/${file}`, spec: specPath, branch: branchName, tasks, now: at });
    const planId = st.store.upsertPlan(st.repoId, { path: ledger.plan, spec: ledger.spec, branch: ledger.branch, state: ledger.state });
    st.store.saveLedger(planId, ledger);
    return `created ${planPath}`;
  });
}

function storeTransition(cmd) {
  return (st, values, [id, text]) => {
    if (cmd === 'close' && values.plan === undefined) {
      // Every plan already closed: an idempotent repeat (exit 0, nothing recorded).
      const all = storeLedgers(st);
      if (all.length && all.every((l) => l.ledger.state === 'done')) {
        out('plan: already done');
        return 0;
      }
    }
    const selected = selectStoreLedger(st, values.plan);
    let arg = text;
    if (cmd === 'done' && values.commit !== undefined) {
      arg = resolveCommit(st.repoRoot, values.commit); // git runs before the transaction opens
      if (arg === null) throw new LedgerError(`commit ${values.commit} does not resolve`);
    }
    // The ledger is read again inside the transaction, so a concurrent writer's change is never overwritten.
    const done = st.store.tx(() => {
      const fresh = st.store.ledgerOf(selected.planId);
      const before = fresh.tasks.find((x) => x.id === id);
      let result;
      try {
        result = transition(fresh, cmd, id, arg, now());
      } catch (err) {
        if (err instanceof LedgerError) throw err;
        throw new LedgerError(`${selected.path} cannot be updated: ${err.message}`);
      }
      if (result.changed) st.store.saveLedger(selected.planId, result.ledger);
      return { before, state: fresh.state, ...result };
    });
    const after = done.ledger.tasks.find((x) => x.id === id);
    if (cmd === 'close') out(done.changed ? `plan: ${done.state} -> ${done.ledger.state}` : `plan: already ${done.ledger.state}`);
    else if (cmd === 'retitle') out(done.changed ? `${id}: "${done.before.title}" -> "${after.title}"` : `${id}: already "${after.title}"`);
    else out(done.changed ? `${id}: ${done.before.status} -> ${after.status}` : `${id}: already ${after.status}`);
    return 0;
  };
}

function storeStatus(st, { json }) {
  return cmdStatusOf(storeLedgers(st).filter(isActive).sort(byNameDesc), json);
}

function storeNext(st, { plan }) {
  return cmdNextOf(selectStoreLedger(st, plan).ledger);
}

// `render` prints the Active plan section: a store repository has no status.md to write it into.
function storeRender(st) {
  out(renderSection(storeLedgers(st).map(({ name, ledger }) => ({ name, ledger }))));
  return 0;
}

// `check` in store mode: each plan whose document is in the documents directory is compared against the store (titles,
// roles, deps, commits). There is no rendered section to drift, and a plan without its document is not compared.
function storeCheck(st) {
  const commitExists = (sha) => resolveCommit(st.repoRoot, sha) !== null;
  const drift = [];
  const compared = [];
  for (const l of storeLedgers(st).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const planText = readIfExists(join(st.plansDir, basename(l.path)));
    if (planText === null) continue;
    compared.push(l);
    const add = (message) => drift.push({ name: l.name, message });
    if (!isActive(l)) checkSchema(l.ledger).forEach(add);
    else checkLedger({ ledger: l.ledger, planText, statusText: '', renderedBody: '', commitExists }).filter((m) => m !== STALE).forEach(add);
  }
  const messages = [...new Set(drift.map(({ name, message }) => (compared.length > 1 ? `${name}: ${message}` : message)))];
  for (const m of messages) out(m);
  return messages.length ? 1 : 0;
}

// The data directory of the store and the repository's documents directory in it; null paths when the store is disabled.
function storeLocations(t) {
  const paths = storePaths({ home: homedir(), env: process.env });
  if (!paths) return { store: null, plansDir: null, specsDir: null };
  const { plansDir, specsDir } = docsDirs(paths.dataDir, repoKey(t.gitCommonDir));
  return { store: paths.db, plansDir, specsDir };
}

// The daily snapshot runs after the write has committed; a failure to take it is reported and never fails the write.
function snapshotAfterWrite(st) {
  try {
    maybeDailySnapshot(st.store, st.dataDir, new Date());
  } catch (err) {
    process.stderr.write(`warning: the daily snapshot failed: ${err.message}\n`);
  }
}

// Runs a store-mode subcommand: loads node:sqlite, opens the store as the command needs it (`def.access`) and runs the
// synchronous body, the writing ones under the lock in the documents directory, then closes the store.
async function runStore(def, t, values, positionals) {
  await loadSqlite();
  const st = storeTracking(t, { home: homedir(), env: process.env, access: def.access });
  try {
    if (def.access === 'read') return def.store(st, values, positionals);
    const code = withLock(tasksLockPath(st), () => def.store(st, values, positionals));
    snapshotAfterWrite(st);
    return code;
  } finally {
    st.store.close();
  }
}

// The store handle `triqual tracking write plan` runs under: opened for writing (the repository row created), to be
// closed by the caller.
export async function openStoreTracking(t) {
  await loadSqlite();
  return storeTracking(t, { home: homedir(), env: process.env, access: 'create' });
}

function cmdTransition(cmd) {
  return (t, values, [id, text]) => {
    if (cmd === 'close' && values.plan === undefined) {
      // Every ledger already closed: an idempotent repeat (exit 0, nothing recorded), status.md re-rendered.
      const ledgers = loadLedgers(t);
      if (ledgers.length && ledgers.every((l) => l.ledger.state === 'done')) {
        writeStatus(t, renderedStatus(t, ledgers));
        out('plan: already done');
        return 0;
      }
    }
    const selected = selectLedger(t, values.plan);
    let arg = text;
    if (cmd === 'done' && values.commit !== undefined) {
      arg = resolveCommit(t.repoRoot, values.commit);
      if (arg === null) throw new LedgerError(`commit ${values.commit} does not resolve`);
    }
    const before = Array.isArray(selected.ledger.tasks) ? selected.ledger.tasks.find((x) => x.id === id) : undefined;
    let result;
    try {
      result = transition(selected.ledger, cmd, id, arg, now());
    } catch (err) {
      if (err instanceof LedgerError) throw err;
      throw new LedgerError(`${selected.path} cannot be updated: ${err.message}`);
    }
    const { ledger, changed } = result;
    const after = ledger.tasks.find((x) => x.id === id);
    // A repeat still re-renders status.md (a no-op when current), so a crash between the two writes self-heals.
    if (changed) save(t, selected.path, ledger);
    else writeStatus(t, renderedStatus(t, loadLedgers(t)));
    if (cmd === 'close') out(changed ? `plan: ${selected.ledger.state} -> ${ledger.state}` : `plan: already ${ledger.state}`);
    else if (cmd === 'retitle') out(changed ? `${id}: "${before.title}" -> "${after.title}"` : `${id}: already "${after.title}"`);
    else out(changed ? `${id}: ${before.status} -> ${after.status}` : `${id}: already ${after.status}`);
    return 0;
  };
}

function cmdStatus(t, { json }) {
  return cmdStatusOf(loadLedgers(t, { skip: true }).filter(isActive).sort(byNameDesc), json);
}

// `status` over the active ledgers `active` (newest name first).
function cmdStatusOf(active, json) {
  if (json) {
    out(JSON.stringify(active.map(({ path, name, ledger }) => ({
      name,
      ledgerPath: path,
      ...counts(ledger),
      inProgress: ledger.tasks.filter((x) => x.status === 'in_progress').map((x) => x.id),
      next: nextTask(ledger)?.id ?? null,
    })), null, 2));
  } else {
    for (const { name, ledger } of active) out(statusLine(name, ledger));
  }
  return 0;
}

function cmdNext(t, { plan }) {
  return cmdNextOf(selectLedger(t, plan, { skip: true }).ledger);
}

function cmdNextOf(ledger) {
  const task = nextTask(ledger);
  out(task ? `${task.id} ${task.title} [${roleOf(task)}]` : 'none');
  return 0;
}

function cmdRender(t) {
  writeStatus(t, renderedStatus(t, loadLedgers(t)));
  return 0;
}

// Where `check` reads from: the working tree, or (committed mode, --staged) the index.
function worktreeSource(t) {
  const base = t.mode === 'committed' ? t.repoRoot : t.root;
  return {
    files: () => ledgerPaths(t).map((path) => ({ path, text: readFileSync(path, 'utf8') })),
    plan: (rel) => {
      const abs = resolve(base, rel);
      const text = readIfExists(abs);
      return text === null ? { text: null, missing: `plan ${abs} not found` } : { text };
    },
    status: () => readIfExists(t.status) ?? '',
  };
}

function indexSource(t) {
  const plansRel = posix(relative(t.repoRoot, t.plansDir));
  return {
    files: () => git(process.cwd(), ['ls-files', '-z', '--full-name', '--', `:(top)${plansRel}`], { inherit: true })
      .split('\0')
      .filter((p) => p.endsWith(LEDGER_EXT) && dirname(p) === plansRel)
      .sort()
      .map((p) => ({ path: join(t.repoRoot, p), text: showStaged(p) ?? '' })),
    plan: (rel) => {
      const text = showStaged(rel);
      return text === null ? { text: null, missing: `plan ${rel} is not in the index` } : { text };
    },
    status: () => showStaged(posix(relative(t.repoRoot, t.status))) ?? '',
  };
}

// Drift messages about status.md itself: shared by every ledger, so printed once and never prefixed.
const STALE = 'status.md Active plan section is stale — run triqual tasks render';
const SECTION_MESSAGES = new Set([STALE, ...MARKER_ERRORS]);

function cmdCheck(t, { staged }) {
  const source = staged && t.mode === 'committed' ? indexSource(t) : worktreeSource(t);
  const drift = []; // { name, message }: name is the ledger a message is about
  const ledgers = [];
  const files = source.files();
  for (const { path, text } of files) {
    try {
      ledgers.push(readEntry(path, text)); // a ledger too malformed to render is drift, and stays out of the section
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      drift.push({ name: basename(path, LEDGER_EXT), message: err.message });
    }
  }
  const renderedBody = renderSection(ledgers);
  const statusText = source.status();
  const commitExists = (sha) => resolveCommit(t.repoRoot, sha) !== null;
  const active = ledgers.filter(isActive);
  for (const { name, ledger } of active) {
    const add = (message) => drift.push({ name, message });
    let planText = '';
    if (typeof ledger.plan !== 'string') add(`ledger plan path is ${JSON.stringify(ledger.plan)}`);
    else {
      const plan = source.plan(ledger.plan);
      if (plan.text === null) add(plan.missing);
      else planText = plan.text;
    }
    checkLedger({ ledger, planText, statusText, renderedBody, commitExists }).forEach(add);
  }
  // Ledgers that are not active (done, or an unknown state) still get their schema checked; with none active the
  // section is compared once, since checkLedger (which compares it) ran for no ledger.
  for (const { name, ledger } of ledgers.filter((l) => !isActive(l))) {
    checkSchema(ledger).forEach((message) => drift.push({ name, message }));
  }
  if (ledgers.length && !active.length) {
    checkSection(statusText, renderedBody).forEach((message) => drift.push({ name: null, message }));
  }
  // With more than one ledger file covered, a per-ledger message names its plan.
  const several = files.length > 1;
  const messages = [...new Set(drift.map(({ name, message }) => (several && !SECTION_MESSAGES.has(message)
    ? `${name}: ${message}` : withMarkerHint(message))))];
  for (const m of messages) out(m);
  return messages.length ? 1 : 0;
}

// `paths --json` (spec Addendum E.5, E.8): the tracking paths, or `optedIn: false` (exit 0) outside an opted-in repo;
// both carry the not-opted-in message and the local hook lines, the facts doctor checks against.
function cmdPaths(t) {
  const facts = { notOptedInMessage: NOT_OPTED_IN, localHookLines: LOCAL_HOOK_LINES };
  if (!t) {
    out(JSON.stringify({ optedIn: false, ...facts }, null, 2));
    return 0;
  }
  if (t.mode === 'store') {
    // The documents directories and the database; a store repository has no progress, status or ledger paths.
    out(JSON.stringify({ optedIn: true, mode: 'store', root: t.root, ...storeLocations(t), ...facts }, null, 2));
    return 0;
  }
  const { mode, root, progress, status, plansDir, specsDir, duplicate } = t;
  out(JSON.stringify({ optedIn: true, mode, root, progress, status, plansDir, specsDir, duplicate, ...facts }, null, 2));
  return 0;
}

// `export --json`: this repo's tracking snapshot (spec Addendum D.1), shareable from its registry entry (else false).
// `--all`: an array with the snapshot of every registered repo that still resolves, from any cwd; a repo whose
// snapshot fails is skipped with a warning and never aborts the array.
async function cmdExport(t, { all }) {
  const home = homedir();
  const at = new Date();
  if (!all) {
    if (t.mode === 'store') await loadSqlite();
    const shareable = readRegistry(home).find((r) => r.root === t.repoRoot)?.shareable === true;
    out(JSON.stringify(buildSnapshot(t, { now: at, shareable }), null, 2));
    return 0;
  }
  const snapshots = [];
  for (const { root, shareable, tracking } of listResolved(home)) { // each repo resolved once
    try {
      if (tracking.mode === 'store') await loadSqlite();
      snapshots.push(buildSnapshot(tracking, { now: at, shareable }));
    } catch (err) {
      process.stderr.write(`warning: skipping ${root}: ${err.message}\n`);
    }
  }
  out(JSON.stringify(snapshots, null, 2));
  return 0;
}

// A task as the status-line segment names it: `<id> (<role short name>)`, e.g. `T4 (tdd-implementer)`.
const withRole = (task) => task && `${task.id} (${String(roleOf(task)).replace(/^roles:/, '')})`;

// The `<current>` of the status-line segment (spec D.3, E.5): the first in_progress task, else the first in_review
// task + ` review`, else the next task, else the first blocked task + ` blocked` (each task with its role), else `done`
// when every non-dropped task is done, otherwise `stalled`. It never reads `done` for an unfinished plan.
function currentOf(ledger) {
  const first = (status) => withRole(ledger.tasks.find((x) => x.status === status));
  const { done, total } = counts(ledger);
  return first('in_progress')
    ?? (first('in_review') && `${first('in_review')} review`)
    ?? withRole(nextTask(ledger))
    ?? (first('blocked') && `${first('blocked')} blocked`)
    ?? (done === total ? 'done' : 'stalled');
}

// `line`: the status-line segment (spec Addendum D.3), `▸ <name> <done>/<total> · <current>` for the newest active
// ledger, plus ` (+<n-1>)` with n usable active ledgers. Runs on every status-line refresh, so it is read-only (no
// ledger, status.md or registry write) and silent: a ledger that fails with LedgerError is skipped without a warning
// (as `status` skips it); not opted in, no active plan, extra arguments or any other throw print nothing and exit 0,
// and nothing ever reaches stderr.
async function lineSegment(argv) {
  if (argv.length) return '';
  const t = resolveTracking(process.cwd());
  if (!t) return '';
  let active;
  if (t.mode === 'store') {
    await loadSqlite();
    const st = storeTracking(t, { home: homedir(), env: process.env, access: 'read' }); // read-only: nothing is written
    try {
      active = storeLedgers(st).filter(isActive).sort(byNameDesc);
    } finally {
      st.store.close();
    }
  } else {
    active = loadLedgers(t, { skip: true, warn: false }).filter(isActive).sort(byNameDesc);
  }
  if (!active.length) return '';
  const [{ name, ledger }] = active;
  const { done, total } = counts(ledger);
  const current = currentOf(ledger);
  return `▸ ${name} ${done}/${total} · ${current}${active.length > 1 ? ` (+${active.length - 1})` : ''}\n`;
}

async function runLine(argv) {
  process.stdout.on('error', () => {}); // a closed pipe must not surface as an uncaught error on stderr
  let text = '';
  try {
    text = await lineSegment(argv);
  } catch {
    text = '';
  }
  if (text) process.stdout.write(text);
  process.exitCode = 0;
}

// positionals: [min, max]; options: the flags a subcommand accepts; required: flags that must be present;
// untracked(values): true when the call needs no opted-in repo in the cwd; writes: true when it may write the ledger or
// status.md (it then runs under the tracking root's lock). In store mode `store(st, values, positionals)` replaces `run`
// (a command without one runs `run` as it is) and `access` is how it opens the store: 'read', 'write' or 'create'.
const PLAN = { plan: { type: 'string' } };
const move = (cmd, max = 1) => ({
  positionals: [1, max], options: PLAN, writes: true, run: cmdTransition(cmd), access: 'write', store: storeTransition(cmd),
});
const COMMANDS = {
  init: {
    positionals: [1, 1],
    options: { spec: { type: 'string' }, branch: { type: 'string' }, adopt: { type: 'boolean' } },
    writes: true,
    run: cmdInit,
    access: 'create',
    store: cmdInit,
  },
  start: move('start'),
  review: move('review'),
  rework: move('rework'),
  restore: move('restore'),
  done: {
    positionals: [1, 1], options: { ...PLAN, commit: { type: 'string' } }, writes: true, run: cmdTransition('done'),
    access: 'write', store: storeTransition('done'),
  },
  block: move('block', 2),
  drop: move('drop', 2),
  reopen: move('reopen', 2),
  retitle: move('retitle', 2),
  close: {
    positionals: [0, 0], options: PLAN, writes: true, run: cmdTransition('close'), access: 'write', store: storeTransition('close'),
  },
  status: { positionals: [0, 0], options: { json: { type: 'boolean' } }, run: cmdStatus, access: 'read', store: storeStatus },
  next: { positionals: [0, 0], options: PLAN, run: cmdNext, access: 'read', store: storeNext },
  check: { positionals: [0, 0], options: { staged: { type: 'boolean' } }, run: cmdCheck, access: 'read', store: storeCheck },
  render: { positionals: [0, 0], options: {}, writes: true, run: cmdRender, access: 'read', store: storeRender },
  paths: { positionals: [0, 0], options: { json: { type: 'boolean' } }, required: ['json'], untracked: () => true, run: cmdPaths },
  export: {
    positionals: [0, 0],
    options: { json: { type: 'boolean' }, all: { type: 'boolean' } },
    required: ['json'],
    untracked: (values) => values.all === true,
    run: cmdExport,
  },
};

function parse(argv) {
  const [sub, ...rest] = argv;
  const def = Object.hasOwn(COMMANDS, sub ?? '') ? COMMANDS[sub] : null;
  if (!def) throw new UsageError(sub === undefined ? '' : `unknown subcommand ${sub}`);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: def.options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const [min, max] = def.positionals;
  const n = parsed.positionals.length;
  if (n < min || n > max) throw new UsageError(`${sub}: expected ${min === max ? min : `${min}-${max}`} argument(s), got ${n}`);
  for (const flag of def.required ?? []) if (!parsed.values[flag]) throw new UsageError(`${sub}: --${flag} is required`);
  return { def, values: parsed.values, positionals: parsed.positionals };
}

async function main(argv) {
  const { def, values, positionals } = parse(argv);
  const t = resolveTracking(process.cwd());
  if (!t && !def.untracked?.(values)) {
    process.stderr.write(`${NOT_OPTED_IN}\n`);
    return 2;
  }
  if (t?.mode === 'store' && def.store) return runStore(def, t, values, positionals);
  if (def.writes) return withLock(tasksLockPath(t), () => def.run(t, values, positionals));
  return def.run(t, values, positionals);
}

// `--help` or `-h` anywhere before a `--` (after the subcommand too): the usage on stdout, exit 0, nothing resolved.
const wantsHelp = (argv) => {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).some((a) => a === '--help' || a === '-h');
};

async function cli(argv) {
  const [subcommand, ...args] = argv;
  if (wantsHelp(argv)) {
    out(USAGE);
    process.exitCode = 0;
  } else if (subcommand === 'line') await runLine(args);
  else {
    try {
      process.exitCode = await main(argv);
    } catch (err) {
      if (err instanceof UsageError) process.stderr.write(`${err.message ? `${err.message}\n` : ''}${USAGE}\n`);
      else process.stderr.write(`${withMarkerHint(err.message)}\n`);
      process.exitCode = 2;
    }
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
