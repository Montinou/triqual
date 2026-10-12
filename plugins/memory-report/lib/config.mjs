// Paths, configuration defaults, validation and allowlist edits for memory-report (spec 4.1 to 4.3).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { brandDir } from './brand.mjs';
import { classifyEntry, normalizeEntrySync } from './entries.mjs';
import { ensureDir, writeAtomic } from './files.mjs';
import { foldTerm } from './policy.mjs';

// Every path the plugin reads or writes. Env overrides: MEMORY_REPORT_CONFIG, _STATE_DIR, _CLAUDE_MEM_DIR, _CRASH_DIR
// (an empty value counts as unset). The defaults sit under brandDir(<home>/.local/state) and brandDir(<home>/.config):
// the triqual dir, or the legacy dir until migration.
export function resolvePaths(env = process.env, home = homedir()) {
  const stateDir = env.MEMORY_REPORT_STATE_DIR || join(brandDir(join(home, '.local', 'state')), 'memory-report');
  const claudeMemDir = env.MEMORY_REPORT_CLAUDE_MEM_DIR || join(home, '.claude-mem');
  const dbFile = join(claudeMemDir, 'claude-mem.db');
  return {
    home,
    configFile: env.MEMORY_REPORT_CONFIG || join(brandDir(join(home, '.config')), 'memory-report.json'),
    stateDir,
    stateFile: join(stateDir, 'state.json'),
    noticeFile: join(stateDir, 'notice.json'),
    seenFile: join(stateDir, 'seen.json'),
    lockFile: join(stateDir, 'run.lock'),
    takeoverFile: join(stateDir, 'run.lock.takeover'),
    logFile: join(stateDir, 'run.log'),
    reportsDir: join(stateDir, 'reports'),
    workDir: join(stateDir, 'memory-report-work'),
    claudeMemDir,
    dbFile,
    walFile: `${dbFile}-wal`,
    chromaFile: join(claudeMemDir, 'chroma', 'chroma.sqlite3'),
    settingsFile: join(claudeMemDir, 'settings.json'),
    syncStateFile: join(claudeMemDir, 'chroma-sync-state.json'),
    logsDir: join(claudeMemDir, 'logs'),
    crashDir: env.MEMORY_REPORT_CRASH_DIR || join(home, 'Library', 'Logs', 'DiagnosticReports'),
  };
}

export const DEFAULTS = {
  version: 1,
  allowlist: [],
  clientTerms: [],
  neverSend: [],
  suggestRoots: [],
  model: 'claude-haiku-4-5',
  claudeBin: 'claude',
  maxObservations: 600,
  maxCharsPerObservation: 600,
  intervalDays: 7,
  llmTimeoutMs: 600000,
};

const isName = (v) => typeof v === 'string' && v !== '';
const isNameList = (v) => Array.isArray(v) && v.every(isName);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isDateString = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isBoolean = (v) => typeof v === 'boolean';
// An allowlist or never-send entry: a name, repository or owner entry (repo-identity spec 4.1). An entry the adding
// rules would refuse, or a URL-shaped one, is invalid and makes its whole key invalid.
const isEntry = (v) => classifyEntry(v) !== 'invalid';
const isEntryList = (v) => Array.isArray(v) && v.every(isEntry);

// The validity of one element of a list key; any other key has no per-element rule.
const ELEMENT_VALID = { allowlist: isEntry, neverSend: isEntry, clientTerms: isName, suggestRoots: isName };
export const isValidElement = (key, value) => (ELEMENT_VALID[key] ?? (() => false))(value);

// Per-key validity (spec 4.2, local-setup spec 2.1). `version` has no rule and is never warned about. `setupAt`,
// `setupDeclinedAt` and `noClientTermsAck` have no default: when absent or invalid they stay out of `config`.
const VALID = {
  allowlist: isEntryList,
  clientTerms: isNameList,
  neverSend: isEntryList,
  suggestRoots: isNameList,
  model: isName,
  claudeBin: isName,
  maxObservations: isPositiveInt,
  maxCharsPerObservation: isPositiveInt,
  intervalDays: isPositiveInt,
  llmTimeoutMs: isPositiveInt,
  setupAt: isDateString,
  setupDeclinedAt: isDateString,
  noClientTermsAck: isBoolean,
};

const clone = (v) => structuredClone(v);

// Reads the config file. { status: 'missing' | 'unparsable' | 'ok', raw }: raw is {} unless status is 'ok'. A file that
// is not a JSON object counts as unparsable.
function readRaw(paths) {
  let text;
  try {
    text = readFileSync(paths.configFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', raw: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { status: 'ok', raw: parsed };
  } catch { /* falls through */ }
  return { status: 'unparsable', raw: {} };
}

// { config, raw, warnings, unparsable, invalidKeys }. `config` is validated with per-key fallback to DEFAULTS; `raw` is
// the user's object exactly as stored, so a save never rewrites a value the user wrote. Warnings name keys, never
// values; `invalidKeys` lists the keys that fell back (data for insightsGate, never parsed from warning text).
// `neverSend` is a deny list and falls back closed: an invalid array keeps its valid elements as stored, which can only
// block more, while the key stays in `invalidKeys`.
export function loadConfig(paths) {
  const { status, raw } = readRaw(paths);
  const config = clone(DEFAULTS);
  const warnings = [];
  if (status === 'unparsable') {
    warnings.push('config file is not valid JSON; using defaults');
    return { config, raw, warnings, unparsable: true, invalidKeys: [] };
  }
  const invalidKeys = [];
  if ('version' in raw) config.version = raw.version;
  for (const [key, valid] of Object.entries(VALID)) {
    if (!(key in raw)) continue;
    if (valid(raw[key])) config[key] = clone(raw[key]);
    else {
      // Ruling 10 N1: a never-send array keeps its valid entries, and the warning says so.
      const keeps = key === 'neverSend' && Array.isArray(raw[key]);
      warnings.push(`invalid config key: ${key}; ${keeps ? 'keeping its valid entries' : 'using default'}`);
      invalidKeys.push(key);
      if (keeps) config[key] = clone(raw[key].filter(isEntry));
    }
  }
  return { config, raw, warnings, unparsable: false, invalidKeys };
}

// Writes the raw object (unknown keys included) as JSON, 0600, in a 0700 directory.
export function saveConfig(paths, raw) {
  ensureDir(dirname(paths.configFile));
  writeAtomic(paths.configFile, `${JSON.stringify(raw, null, 2)}\n`);
}

// The file to edit: refuses an unparsable one (nothing is written). A missing one starts from `{ version }` alone, so an
// edit writes only the keys it changes and every other key keeps following DEFAULTS. `list` is the current validated
// value of `key` (a fresh copy, safe to mutate); when `key` is invalid (`invalid` true) it is the stored array as written
// (`[]` for a non-array), so a removal works on the user's entries rather than the fallback. It never refuses an invalid
// key: the adds refuse (repo-identity spec 4.5), the removals and the setup markers do not.
function loadForEdit(paths, key = 'allowlist') {
  const { status, raw } = readRaw(paths);
  if (status === 'unparsable') throw new Error(`config file is not valid JSON: ${paths.configFile}`);
  const loaded = loadConfig(paths);
  const invalid = loaded.invalidKeys.includes(key);
  let list = loaded.config[key];
  if (invalid) list = Array.isArray(raw[key]) ? [...raw[key]] : [];
  return { raw: status === 'ok' ? raw : { version: DEFAULTS.version }, list, invalid };
}

// Every add to an invalid key refuses (spec 4.5): editing the fallback `[]` would drop the stored entries on save.
function refuseInvalid(key, invalid) {
  if (invalid) throw new Error(`${key} is invalid; fix the config first`);
}

const cleanNames = (names) => names.map((n) => n.trim()).filter(Boolean);

// Adds each cleaned entry not already present (`same` decides equality); returns the resulting list. Refuses, writing
// nothing, while `key` is invalid or when any entry is one the adding rules refuse (spec 4.1). Entries arrive already
// normalized: the CLI runs the adding normalization, async for remote URLs, before this sync edit.
function addToList(paths, key, names, same) {
  const { raw, list, invalid } = loadForEdit(paths, key);
  refuseInvalid(key, invalid);
  const entries = cleanNames(names);
  const bad = entries.find((e) => !isValidElement(key, e));
  if (bad !== undefined) throw new Error(`not a valid entry: ${bad}`);
  for (const entry of entries) {
    if (!list.some((n) => same(n, entry))) list.push(entry);
  }
  raw[key] = list;
  saveConfig(paths, raw);
  return list;
}

// Removes each name present; names not present come back in `missing`. Writes only when something was removed.
// Spec 4.1: the entries equal to the argument as stored go first (valid or not); only when none matches does
// `normalize(name)` give the adding normalization, and every stored entry of that normalized form goes.
function removeFromList(paths, key, names, same, normalize = () => null) {
  const { raw, list } = loadForEdit(paths, key);
  const missing = [];
  let next = list;
  for (const name of cleanNames(names)) {
    const asStored = (n) => typeof n === 'string' && same(n, name);
    if (next.some(asStored)) {
      next = next.filter((n) => !asStored(n));
      continue;
    }
    const form = normalize(name);
    const asNormalized = (n) => typeof n === 'string' && (n === form || normalizeEntrySync(n) === form);
    if (form !== null && next.some(asNormalized)) next = next.filter((n) => !asNormalized(n));
    else if (!missing.includes(name)) missing.push(name);
  }
  if (next.length !== list.length) {
    raw[key] = next;
    saveConfig(paths, raw);
  }
  return { list: next, missing };
}

const exact = (a, b) => a === b;
const sameTerm = (a, b) => a.toLowerCase() === b.toLowerCase();
// The adding normalization for a removal: `normalized` (a Map from the typed argument to its form, which the CLI fills
// for remote URLs through the async normalizeRemote), else the sync normalization of a repository-shaped argument.
const entryForm = (normalized) => (name) => normalized?.get(name) ?? normalizeEntrySync(name);

// Adds each trimmed, non-empty entry not already present; returns the resulting allowlist.
export const allowProjects = (paths, names) => addToList(paths, 'allowlist', names, exact);

// Removes each entry present; entries not present come back in `missing`. Writes only when something was removed.
export const denyProjects = (paths, names, { normalized } = {}) => removeFromList(paths, 'allowlist', names, exact, entryForm(normalized));

// Client terms: trimmed, non-empty, de-duplicated and matched case-insensitively. Adding a term clears `noClientTermsAck`
// in the same write: the acknowledgment says the user chose to have no terms, and that choice no longer holds. A call that
// adds nothing (duplicates, blanks) keeps every other key as it was. Refuses, writing nothing, while clientTerms is invalid.
export function blockTerms(paths, terms) {
  const { raw, list, invalid } = loadForEdit(paths, 'clientTerms');
  refuseInvalid('clientTerms', invalid);
  let added = false;
  for (const term of cleanNames(terms)) {
    if (list.some((t) => sameTerm(t, term))) continue;
    list.push(term);
    added = true;
  }
  raw.clientTerms = list;
  if (added) delete raw.noClientTermsAck;
  saveConfig(paths, raw);
  return list;
}
export const unblockTerms = (paths, terms) => removeFromList(paths, 'clientTerms', terms, sameTerm);

// Never-send entries: same rules as the allowlist (exact stored strings).
export const neverProjects = (paths, names) => addToList(paths, 'neverSend', names, exact);
export const unneverProjects = (paths, names, { normalized } = {}) => removeFromList(paths, 'neverSend', names, exact, entryForm(normalized));

// The raw stored elements of a list key for `--list` (spec 4.5): [{ value, valid }], `valid` false for each element that
// fails validation. A present non-array value is one invalid element; an absent key or an unparsable file gives [].
export function listEntries(paths, key) {
  const { raw } = loadConfig(paths);
  if (!(key in raw)) return [];
  if (!Array.isArray(raw[key])) return [{ value: raw[key], valid: false }];
  return raw[key].map((value) => ({ value, valid: isValidElement(key, value) }));
}

// Setup markers. Each writes only the keys it changes (and refuses an unparsable file).
// `setupAt` = now, `setupDeclinedAt` removed; `noClientTermsAck: true` with `noClientTerms`, otherwise removed.
export function markSetupDone(paths, { noClientTerms, nowIso }) {
  const { raw } = loadForEdit(paths);
  raw.setupAt = nowIso;
  delete raw.setupDeclinedAt;
  if (noClientTerms) raw.noClientTermsAck = true;
  else delete raw.noClientTermsAck;
  saveConfig(paths, raw);
}

// `setupDeclinedAt` = now; `setupAt` and everything else stay.
export function markSetupDeclined(paths, { nowIso }) {
  const { raw } = loadForEdit(paths);
  raw.setupDeclinedAt = nowIso;
  saveConfig(paths, raw);
}

export const REASON_NOT_SET_UP = 'Not set up: insights are off until you run the memory-report setup (ask Claude: "set up memory-report").';
export const REASON_INCOMPLETE = 'Setup incomplete: insights are off until you finish the memory-report setup (ask Claude: "set up memory-report").';

// A term counts when something is left after the folding `contentVerdict` compares on (invisible code points, diacritics
// and whitespace removed, escapes decoded): a term that folds to nothing would block nothing.
const isEffectiveTerm = (t) => foldTerm(t) !== '';

// The insights gate (local-setup spec 2.2), pure. `failing` names the rules that do not hold: setup, allowlist, invalid,
// terms. The reason is R1 when rule 1 fails, R2 when only later rules fail, null when open.
export function insightsGate(config, invalidKeys = []) {
  const failing = [];
  const setupAt = isDateString(config.setupAt) ? Date.parse(config.setupAt) : null;
  const declinedAt = isDateString(config.setupDeclinedAt) ? Date.parse(config.setupDeclinedAt) : null;
  if (setupAt === null || (declinedAt !== null && declinedAt > setupAt)) failing.push('setup');
  if (!Array.isArray(config.allowlist) || config.allowlist.length === 0) failing.push('allowlist');
  if (['allowlist', 'clientTerms', 'neverSend', 'setupDeclinedAt'].some((k) => invalidKeys.includes(k))) failing.push('invalid');
  const hasTerm = Array.isArray(config.clientTerms) && config.clientTerms.some(isEffectiveTerm);
  if (!hasTerm && config.noClientTermsAck !== true) failing.push('terms');
  if (failing.length === 0) return { open: true, reason: null, failing };
  return { open: false, reason: failing.includes('setup') ? REASON_NOT_SET_UP : REASON_INCOMPLETE, failing };
}
