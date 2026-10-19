// The role-eval store (spec 5): validated records, an idempotent locked append, and the summary. `triqual role-eval` is
// the CLI on top of it. node: built-ins only; no repository, plan, path, diff or finding text ever enters a record.
import {
  chmodSync, closeSync, constants, fstatSync, linkSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { brandDir } from './brand.mjs';

// ---- the store location -------------------------------------------------------------------------------------

// Where the store lives. ROLE_EVAL_FILE (the test override) names the file itself and never makes its parent the
// default directory; otherwise the file is under brandDir(${XDG_DATA_HOME or home/.local/share})/role-eval.
export function storePath(env, home) {
  if (env.ROLE_EVAL_FILE) {
    return { file: env.ROLE_EVAL_FILE, dir: dirname(env.ROLE_EVAL_FILE), isDefault: false };
  }
  const base = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dir = join(brandDir(base), 'role-eval');
  return { file: join(dir, 'comparisons.jsonl'), dir, isDefault: true };
}

// The idempotency key: hex sha256 of the git common dir, the plan's basename, the task and the kind. A task-review
// also hashes its attempt (1, then +1 after each reopen), so a re-review is stored; every other kind ignores `attempt`,
// which keeps the keys of the lines stored before v 2 as they were.
export function recordKey({ commonDir, plan, task, kind, attempt }) {
  const base = `${commonDir}\0${basename(plan)}\0${task}\0${kind}`;
  return createHash('sha256').update(kind === 'task-review' ? `${base}\0${attempt}` : base).digest('hex');
}

// ---- validation ---------------------------------------------------------------------------------------------

const PROVIDERS = ['claude', 'codex'];
// v 1 kinds (safety-shadow, hunters) and v 2 kinds (task-review, final-escapes); a line's `v` must match its kind.
const KINDS = ['safety-shadow', 'hunters', 'task-review', 'final-escapes'];
const V2_KINDS = ['task-review', 'final-escapes'];
export const TIERS = Object.freeze(['heavy', 'standard', 'light']);
// The top-level keys each kind may carry; any other key is rejected by name.
const V1_KEYS = ['v', 'at', 'provider', 'task', 'kind', 'gate', 'shadow', 'hunters', 'budget'];
const TASK_REVIEW_KEYS = [
  'v', 'at', 'provider', 'task', 'kind', 'attempt', 'tier', 'declaredTier', 'raised', 'hunters', 'gate', 'spec', 'fixRounds',
  'blocked', 'coordinator',
];
const FINAL_ESCAPES_KEYS = ['v', 'at', 'provider', 'task', 'kind', 'escapes'];
const ALL_KEYS = [...new Set([...V1_KEYS, ...TASK_REVIEW_KEYS, ...FINAL_ESCAPES_KEYS])];
// Kinds `record` no longer accepts: the safety shadow was retired (roles 0.3.0). validateRecord still accepts them, so
// the lines stored before stay valid and the summary keeps reporting them.
export const RETIRED_KINDS = Object.freeze(['safety-shadow']);
export const CATEGORIES = ['correctness', 'security', 'spec-drift', 'state'];
const SEVERITIES = ['critical', 'important', 'minor'];
const TASK = /^(T[0-9]+|final)$/;
const MODEL = /^(sonnet|opus|haiku|claude-[a-z0-9-]+|gpt-[0-9.]+-[a-z]+)$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ITEM_COUNT = 6;
// A key name goes into the answer only when it is a plain identifier: it is a name, never a value, but an odd one
// could be anything the caller typed.
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const sum = (list) => list.reduce((a, b) => a + b, 0);
const join2 = (path, key) => (path === '' ? String(key) : `${path}.${key}`);

class Invalid extends Error {
  constructor(field) {
    super('invalid');
    this.field = field;
  }
}
const fail = (field) => { throw new Invalid(field); };

// Throws Invalid at the first unknown key of `obj` (an object at `path`, allowed keys `allowed`).
function noUnknown(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(PLAIN_KEY.test(key) ? join2(path, key) : join2(path, '<unknown>'));
  }
}

function object(value, path) {
  if (!isObject(value)) fail(path);
  return value;
}

function model(obj, path) {
  if (typeof obj.model !== 'string' || !MODEL.test(obj.model)) fail(join2(path, 'model'));
}

function items(obj, path, { allowEmpty }) {
  const field = join2(path, 'items');
  if (!Array.isArray(obj.items)) fail(field);
  if (obj.items.length !== ITEM_COUNT && !(allowEmpty && obj.items.length === 0)) fail(field);
  obj.items.forEach((v, i) => { if (typeof v !== 'boolean') fail(`${field}.${i}`); });
}

function count(obj, key, path) {
  if (!isCount(obj[key])) fail(join2(path, key));
}

function flag(obj, key, path) {
  if (typeof obj[key] !== 'boolean') fail(join2(path, key));
}

// The verdict counts shared by the shadow and every hunter. `confirmed` is a number for the shadow and an object per
// severity for a hunter; returns the confirmed total.
function verdicts(obj, path, { bySeverity }) {
  let confirmed;
  if (bySeverity) {
    const c = object(obj.confirmed, join2(path, 'confirmed'));
    noUnknown(c, SEVERITIES, join2(path, 'confirmed'));
    for (const s of SEVERITIES) count(c, s, join2(path, 'confirmed'));
    confirmed = sum(SEVERITIES.map((s) => c[s]));
  } else {
    count(obj, 'confirmed', path);
    confirmed = obj.confirmed;
  }
  for (const key of ['refuted', 'duplicateCandidate', 'duplicateReview']) count(obj, key, path);
  count(obj, 'candidates', path);
  return confirmed;
}

function checkCandidates(obj, path, confirmed) {
  if (obj.candidates !== confirmed + obj.refuted + obj.duplicateCandidate + obj.duplicateReview) fail(join2(path, 'candidates'));
}

// A failed shadow or hunter carries no items and only zero counts.
function checkFailedIsZero(obj, path, { bySeverity }) {
  if (bySeverity) {
    for (const s of SEVERITIES) if (obj.confirmed[s] !== 0) fail(join2(join2(path, 'confirmed'), s));
  } else if (obj.confirmed !== 0) {
    fail(join2(path, 'confirmed'));
  }
  for (const key of ['refuted', 'duplicateCandidate', 'duplicateReview', 'candidates']) {
    if (obj[key] !== 0) fail(join2(path, key));
  }
}

function validateGate(gate) {
  object(gate, 'gate');
  noUnknown(gate, ['model', 'items'], 'gate');
  model(gate, 'gate');
  items(gate, 'gate', { allowEmpty: false });
}

function validateShadow(shadow, gate) {
  object(shadow, 'shadow');
  noUnknown(shadow, ['model', 'items', 'failed', 'candidates', 'confirmed', 'refuted', 'duplicateCandidate', 'duplicateReview'], 'shadow');
  model(shadow, 'shadow');
  flag(shadow, 'failed', 'shadow');
  items(shadow, 'shadow', { allowEmpty: shadow.failed });
  if (shadow.failed && shadow.items.length !== 0) fail('shadow.items');
  const confirmed = verdicts(shadow, 'shadow', { bySeverity: false });
  if (shadow.failed) {
    checkFailedIsZero(shadow, 'shadow', { bySeverity: false });
    return;
  }
  checkCandidates(shadow, 'shadow', confirmed);
  // The shadow-only failures: the shadow failed the item, the gate passed it.
  const shadowOnly = shadow.items.filter((passed, i) => passed === false && gate.items[i] === true).length;
  if (shadow.candidates !== shadowOnly) fail('shadow.candidates');
}

function validateHunter(hunter, path) {
  object(hunter, path);
  noUnknown(hunter, ['category', 'model', 'candidates', 'confirmed', 'refuted', 'duplicateCandidate', 'duplicateReview', 'failed'], path);
  if (!CATEGORIES.includes(hunter.category)) fail(join2(path, 'category'));
  model(hunter, path);
  flag(hunter, 'failed', path);
  const confirmed = verdicts(hunter, path, { bySeverity: true });
  if (hunter.failed) {
    checkFailedIsZero(hunter, path, { bySeverity: true });
    return;
  }
  checkCandidates(hunter, path, confirmed);
}

function validateBudget(budget) {
  object(budget, 'budget');
  noUnknown(budget, ['reference', 'used', 'overrun'], 'budget');
  count(budget, 'reference', 'budget');
  count(budget, 'used', 'budget');
  flag(budget, 'overrun', 'budget');
}

function tier(obj, key, path, { nullable }) {
  if (nullable && obj[key] === null) return;
  if (!TIERS.includes(obj[key])) fail(join2(path, key));
}

// The spec reviewer's confirmed findings per severity; a review that did not run counts nothing.
function validateSpec(spec) {
  object(spec, 'spec');
  noUnknown(spec, ['ran', 'confirmed'], 'spec');
  flag(spec, 'ran', 'spec');
  const confirmed = object(spec.confirmed, 'spec.confirmed');
  noUnknown(confirmed, SEVERITIES, 'spec.confirmed');
  for (const s of SEVERITIES) count(confirmed, s, 'spec.confirmed');
  if (!spec.ran) for (const s of SEVERITIES) if (confirmed[s] !== 0) fail(`spec.confirmed.${s}`);
}

function validateTaskReview(obj) {
  if (obj.task === 'final') fail('task');
  if (!Number.isSafeInteger(obj.attempt) || obj.attempt < 1) fail('attempt');
  tier(obj, 'tier', '', { nullable: false });
  tier(obj, 'declaredTier', '', { nullable: true });
  flag(obj, 'raised', '');
  // No code path lowers a tier, and `raised` says exactly that the tier is above the declared one (a tierless plan
  // declares nothing and counts as standard).
  // (TIERS runs from the highest tier down, so a smaller index is a higher tier.)
  const at = TIERS.indexOf(obj.tier);
  const declaredAt = TIERS.indexOf(obj.declaredTier ?? 'standard');
  if (at > declaredAt) fail('tier');
  if (obj.raised !== (at < declaredAt)) fail('raised');
  if (!Array.isArray(obj.hunters)) fail('hunters');
  obj.hunters.forEach((h, i) => validateHunter(h, `hunters.${i}`));
  object(obj.gate, 'gate');
  noUnknown(obj.gate, ['findings'], 'gate');
  count(obj.gate, 'findings', 'gate');
  validateSpec(obj.spec);
  count(obj, 'fixRounds', '');
  flag(obj, 'blocked', '');
  flag(obj, 'coordinator', '');
}

function validateFinalEscapes(obj) {
  if (obj.task !== 'final') fail('task');
  if (!Array.isArray(obj.escapes)) fail('escapes');
  obj.escapes.forEach((e, i) => {
    const path = `escapes.${i}`;
    object(e, path);
    noUnknown(e, ['tier', 'severity'], path);
    tier(e, 'tier', path, { nullable: false });
    if (!SEVERITIES.includes(e.severity)) fail(join2(path, 'severity'));
  });
}

function check(obj) {
  object(obj, '$');
  noUnknown(obj, ALL_KEYS, '');
  if (obj.v !== 1 && obj.v !== 2) fail('v');
  if (typeof obj.at !== 'string' || !AT.test(obj.at) || Number.isNaN(Date.parse(obj.at))) fail('at');
  if (!PROVIDERS.includes(obj.provider)) fail('provider');
  if (!KINDS.includes(obj.kind)) fail('kind');
  if (V2_KINDS.includes(obj.kind) !== (obj.v === 2)) fail('v');
  if (typeof obj.task !== 'string' || !TASK.test(obj.task)) fail('task');
  noUnknown(obj, obj.kind === 'task-review' ? TASK_REVIEW_KEYS : obj.kind === 'final-escapes' ? FINAL_ESCAPES_KEYS : V1_KEYS, '');
  if (obj.kind === 'task-review') {
    validateTaskReview(obj);
    return;
  }
  if (obj.kind === 'final-escapes') {
    validateFinalEscapes(obj);
    return;
  }
  if (obj.kind === 'safety-shadow') {
    if (obj.hunters !== undefined) fail('hunters');
    if (obj.gate === undefined) fail('gate');
    if (obj.shadow === undefined) fail('shadow');
    validateGate(obj.gate);
    validateShadow(obj.shadow, obj.gate);
  } else {
    if (obj.gate !== undefined) fail('gate');
    if (obj.shadow !== undefined) fail('shadow');
    if (!Array.isArray(obj.hunters)) fail('hunters');
    obj.hunters.forEach((h, i) => validateHunter(h, `hunters.${i}`));
  }
  if (obj.budget !== undefined) validateBudget(obj.budget);
}

// { ok: true } or { ok: false, field }: `field` is a dotted path (`shadow.items`, `hunters.0.candidates`), never a value.
export function validateRecord(obj) {
  try {
    check(obj);
    return { ok: true };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, field: err.field };
    throw err;
  }
}

// ---- the lock (copied from plugins/progress-tracking/lib/lock.mjs: plugins cannot import across plugin dirs) ----

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RETRY_MS = 25;

const code = (err) => err?.code;

// Age in ms of the file at `path`, or null when it is gone.
function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (err) {
    if (code(err) === 'ENOENT') return null;
    throw err;
  }
}

// Takes over a lock older than `staleMs`: renames it to a unique name, then re-checks the renamed file's age. Only a
// still-stale file is deleted (returns true); a fresh one (its holder re-took the lock between the first check and
// the rename) is put back unless someone else created the lock meanwhile (returns false). Exported for tests (the
// race is not reproducible on demand).
export function takeOverStale(lockPath, staleMs) {
  const aside = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if (code(err) === 'ENOENT') return false; // released or taken over by someone else: just retry
    throw err;
  }
  const age = ageOf(aside);
  if (age === null) return false;
  if (age > staleMs) {
    try { unlinkSync(aside); } catch (err) { if (code(err) !== 'ENOENT') throw err; }
    return true;
  }
  try {
    linkSync(aside, lockPath);
  } catch (err) {
    if (code(err) !== 'EEXIST') throw err;
  } finally {
    try { unlinkSync(aside); } catch { /* already gone */ }
  }
  return false;
}

// Runs `fn` while holding the lock file at `lockPath` and returns its value; the lock is released in `finally`. The
// file is created exclusively (`wx`); only EEXIST is retried, every RETRY_MS until `waitMs`, any other error is
// rethrown at once. A lock older than `staleMs` is taken over. On timeout it throws Error('lock timeout: <lockPath>').
export function withStoreLock(lockPath, fn, { waitMs = 2000, staleMs = 30000 } = {}) {
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err;
    }
    const age = ageOf(lockPath);
    if (age === null) continue; // released between our open and stat
    if (age > staleMs) {
      takeOverStale(lockPath, staleMs);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
    sleep(RETRY_MS);
  }
  try {
    try { writeSync(fd, `${process.pid} ${hostname()}\n`); } catch { /* the holder note is informational */ }
    return fn();
  } finally {
    // Removed only while it is still our file: after a takeover (we outlived staleMs) the path is someone else's.
    try {
      if (statSync(lockPath).ino === fstatSync(fd).ino) unlinkSync(lockPath);
    } catch { /* already gone */ }
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

// ---- the append ---------------------------------------------------------------------------------------------

// The keys already in `text`: lines that do not parse, or carry no string key, are ignored.
function keysIn(text) {
  const keys = new Set();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const obj = JSON.parse(line);
      if (isObject(obj) && typeof obj.key === 'string') keys.add(obj.key);
    } catch { /* a malformed line is the summary's to report */ }
  }
  return keys;
}

// Appends `{ ...record, key }` as one line unless `key` is already in the file (first write wins). Under the lock the
// existing keys are read, then the line goes out in one write on an O_APPEND descriptor. The file is chmodded to 0600
// on every call; the directory to 0700 only when it is the default store directory or the caller created it.
// Returns 'written' or 'already'. The caller creates the directory.
export function appendRecord(file, record, { key, isDefault, created }) {
  return withStoreLock(`${file}.lock`, () => {
    let existing = '';
    try {
      existing = readFileSync(file, 'utf8');
    } catch (err) {
      if (code(err) !== 'ENOENT') throw err;
    }
    let result = 'already';
    if (!keysIn(existing).has(key)) {
      // A torn last line (no newline) must not swallow ours.
      const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
      try {
        writeSync(fd, `${lead}${JSON.stringify({ ...record, key })}\n`);
      } finally {
        closeSync(fd);
      }
      result = 'written';
    }
    chmodSync(file, 0o600);
    if (isDefault || created) chmodSync(dirname(file), 0o700);
    return result;
  });
}

// ---- the summary --------------------------------------------------------------------------------------------

const ratio = (num, den) => (den === 0 ? null : num / den);

function emptyHunter() {
  return {
    candidates: 0, confirmed: { critical: 0, important: 0, minor: 0 }, refuted: 0, duplicateCandidate: 0,
    duplicateReview: 0, failed: 0, rightRate: null, newRate: null,
  };
}

function emptyProvider() {
  return {
    shadow: {
      tasksCompared: 0, failed: 0, itemsCompared: 0, itemsAgreed: 0, agreement: null, gateOnlyFailures: 0,
      shadowOnly: { candidates: 0, right: 0, refuted: 0, duplicateCandidate: 0 },
    },
    hunters: Object.fromEntries(CATEGORIES.map((c) => [c, emptyHunter()])),
    budget: { records: 0, reference: 0, used: 0, overruns: 0 },
  };
}

function addShadow(p, record) {
  const s = p.shadow;
  const { gate, shadow } = record;
  if (shadow.failed) {
    s.failed += 1;
    return;
  }
  s.tasksCompared += 1;
  s.itemsCompared += ITEM_COUNT;
  for (let i = 0; i < ITEM_COUNT; i++) {
    if (gate.items[i] === shadow.items[i]) s.itemsAgreed += 1;
    if (gate.items[i] === false && shadow.items[i] === true) s.gateOnlyFailures += 1;
  }
  s.shadowOnly.candidates += shadow.candidates;
  s.shadowOnly.right += shadow.confirmed + shadow.duplicateReview;
  s.shadowOnly.refuted += shadow.refuted;
  s.shadowOnly.duplicateCandidate += shadow.duplicateCandidate;
}

function addHunters(p, record) {
  for (const hunter of record.hunters) {
    const h = p.hunters[hunter.category];
    if (hunter.failed) {
      h.failed += 1;
      continue;
    }
    h.candidates += hunter.candidates;
    for (const s of SEVERITIES) h.confirmed[s] += hunter.confirmed[s];
    h.refuted += hunter.refuted;
    h.duplicateCandidate += hunter.duplicateCandidate;
    h.duplicateReview += hunter.duplicateReview;
  }
}

function addBudget(p, budget) {
  p.budget.records += 1;
  p.budget.reference += budget.reference;
  p.budget.used += budget.used;
  if (budget.overrun) p.budget.overruns += 1;
}

// Reads the whole store text, one line at a time, and calls `onRecord(record)` for each valid record in the window.
// A line that is not JSON, or a v 1 or v 2 line that fails validation or carries no string key, is malformed (reported
// by its 1-based line number); a line of another version is counted and skipped; a second line with a key already seen
// is counted and skipped (first write wins, whatever `since` says). `since` (YYYY-MM-DD) keeps the records at or after
// that day, UTC. Returns the skipped counts.
function readRecords(text, since, onRecord) {
  const skipped = { malformed: [], otherVersion: 0, duplicateKey: 0 };
  const cutoff = since ? Date.parse(`${since}T00:00:00Z`) : null;
  const seen = new Set();
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped.malformed.push(index + 1);
      return;
    }
    if (!isObject(obj) || obj.v === undefined) {
      skipped.malformed.push(index + 1);
      return;
    }
    if (obj.v !== 1 && obj.v !== 2) {
      skipped.otherVersion += 1;
      return;
    }
    const { key, ...record } = obj;
    if (typeof key !== 'string' || key === '' || !validateRecord(record).ok) {
      skipped.malformed.push(index + 1);
      return;
    }
    if (seen.has(key)) {
      skipped.duplicateKey += 1;
      return;
    }
    seen.add(key);
    if (cutoff !== null && Date.parse(record.at) < cutoff) return;
    onRecord(record);
  });
  return skipped;
}

// The per-provider summary: shadow agreement (the records stored before that kind was retired), hunters per category
// (from `hunters` and `task-review` records) and the budget. A `final-escapes` record names no provider here.
export function summarize(text, { since } = {}) {
  const providers = {};
  const skipped = readRecords(text, since, (record) => {
    if (record.kind === 'final-escapes') return;
    const p = providers[record.provider] ??= emptyProvider();
    if (record.kind === 'safety-shadow') addShadow(p, record);
    else addHunters(p, record);
    if (record.budget) addBudget(p, record.budget);
  });
  for (const p of Object.values(providers)) {
    p.shadow.agreement = ratio(p.shadow.itemsAgreed, p.shadow.itemsCompared);
    for (const h of Object.values(p.hunters)) {
      const confirmed = sum(SEVERITIES.map((s) => h.confirmed[s]));
      h.rightRate = ratio(confirmed + h.duplicateReview, h.candidates);
      h.newRate = ratio(confirmed, h.candidates);
    }
  }
  return { providers, skipped };
}

function emptyTier() {
  return { tasks: 0, raised: 0, candidates: 0, confirmed: 0, specConfirmed: 0, fixRounds: 0, blocked: 0, escapes: 0 };
}

// Per effective tier (heavy, standard, light; all three always present): `tasks` counts the task-review records of
// attempt 1, so a task reopened and reviewed again is still one task; `raised` the attempt-1 records whose tier was
// raised above the declared one; `hunterConfirmedRate` the confirmed hunter findings over the hunter candidates;
// `specConfirmedPerTask`, `fixRoundsPerTask` and `escapesPerTask` the spec confirmed findings, the fix rounds and the
// final-review escapes traced to that tier, over `tasks`; `blocked` the records that ended blocked. Every count other
// than `tasks` and `raised` sums over all attempts. A window that starts after a task's first attempt leaves that task
// out of `tasks`. A rate with no denominator is null. The window and the skipped lines work as in summarize.
export function summarizeByTier(text, { since } = {}) {
  const tiers = Object.fromEntries(TIERS.map((t) => [t, emptyTier()]));
  readRecords(text, since, (record) => {
    if (record.kind === 'final-escapes') {
      for (const escape of record.escapes) tiers[escape.tier].escapes += 1;
      return;
    }
    if (record.kind !== 'task-review') return;
    const t = tiers[record.tier];
    if (record.attempt === 1) {
      t.tasks += 1;
      if (record.raised) t.raised += 1;
    }
    if (record.blocked) t.blocked += 1;
    t.fixRounds += record.fixRounds;
    t.specConfirmed += sum(SEVERITIES.map((s) => record.spec.confirmed[s]));
    for (const hunter of record.hunters) {
      t.candidates += hunter.candidates;
      t.confirmed += sum(SEVERITIES.map((s) => hunter.confirmed[s]));
    }
  });
  return Object.fromEntries(TIERS.map((name) => {
    const t = tiers[name];
    return [name, {
      tasks: t.tasks,
      raised: t.raised,
      hunterConfirmedRate: ratio(t.confirmed, t.candidates),
      specConfirmedPerTask: ratio(t.specConfirmed, t.tasks),
      fixRoundsPerTask: ratio(t.fixRounds, t.tasks),
      blocked: t.blocked,
      escapesPerTask: ratio(t.escapes, t.tasks),
    }];
  }));
}

// ---- the text report ----------------------------------------------------------------------------------------

const pct = (rate) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);

// The summary as text: rates as percentages with one decimal, a rate with no denominator as n/a.
export function formatSummary(summary) {
  const out = [];
  const names = Object.keys(summary.providers).sort();
  if (names.length === 0) out.push('No records in the window (0 records).');
  for (const name of names) {
    const p = summary.providers[name];
    const s = p.shadow;
    out.push(`Provider: ${name}`, '', '  Safety shadow');
    out.push(`    tasks compared: ${s.tasksCompared}`);
    out.push(`    failed shadows: ${s.failed}`);
    out.push(`    item agreement: ${pct(s.agreement)} (${s.itemsAgreed}/${s.itemsCompared})`);
    out.push(`    gate-only failures: ${s.gateOnlyFailures} (gate failures are not verified; some may be gate false positives)`);
    out.push(`    shadow-only failures: ${s.shadowOnly.candidates} (right ${s.shadowOnly.right}, refuted ${s.shadowOnly.refuted}, duplicate-candidate ${s.shadowOnly.duplicateCandidate})`);
    out.push('', '  Hunters');
    for (const category of CATEGORIES) {
      const h = p.hunters[category];
      out.push(`    ${category}: candidates ${h.candidates}, confirmed ${h.confirmed.critical}/${h.confirmed.important}/${h.confirmed.minor} (critical/important/minor), refuted ${h.refuted}, duplicate-candidate ${h.duplicateCandidate}, duplicate-review ${h.duplicateReview}, failed ${h.failed}, right rate ${pct(h.rightRate)}, new rate ${pct(h.newRate)}`);
    }
    const b = p.budget;
    out.push('', '  Budget');
    out.push(`    records with a budget: ${b.records}, reference ${b.reference}, used ${b.used}, overruns ${b.overruns}`, '');
  }
  const k = summary.skipped;
  const malformed = k.malformed.length === 0 ? '0' : `${k.malformed.length} (lines ${k.malformed.join(', ')})`;
  out.push(`Skipped: malformed ${malformed}, other version ${k.otherVersion}, duplicate key ${k.duplicateKey}`);
  return `${out.join('\n')}\n`;
}

const perTask = (value) => (value === null ? 'n/a' : value.toFixed(2));

// The by-tier summary as text, one line per tier: rates as percentages with one decimal, per-task figures with two, a
// figure with no denominator as n/a.
export function formatTierSummary(byTier) {
  const out = TIERS.map((name) => {
    const t = byTier[name];
    return `${name}: tasks ${t.tasks}, raised ${t.raised}, hunter confirmed ${pct(t.hunterConfirmedRate)}, `
      + `spec confirmed/task ${perTask(t.specConfirmedPerTask)}, fix rounds/task ${perTask(t.fixRoundsPerTask)}, `
      + `blocked ${t.blocked}, escapes/task ${perTask(t.escapesPerTask)}`;
  });
  return `${out.join('\n')}\n`;
}
