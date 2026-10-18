// SessionStart output (spec, "Compaction keep-list and session start").
//
//   sessionContext({policyFile, stateDir, adminDir, home, now, env, payload, fs}) -> string
//   statusLines({policy, sha, profile, stateDir, adminDir, now, payload, fs}) -> string[]
//
// The text the engine returns as `additionalContext` for every SessionStart source on both hosts: the current
// rendering of the keep-list (hooks/keeplist.mjs) followed by status lines, one short line each, only for what
// applies. At most STATUS_MAX_LINES lines of STATUS_LINE_CAP characters, so the whole text stays within the
// keep-list cap plus a few hundred characters. Every line says what the human runs next.
//
//   hatch         a hatch the watchdog would honour (hatchIsValid: root-owned, ISO times, at most 8 h) is open:
//                 fence is not enforcing, with its expiry. (The watchdog renders this output for SessionStart
//                 during a hatch too, while every other event stays silent.)
//   integrity     <state>/needs-repair exists: a post-hatch comparison found a change or did not finish, and
//                 every call is denied until `fence repair`. The marker's contents are never echoed.
//   log           health.json holds a log write failure that no later successful write in the log has outlived
//                 (doctor's rule: health.json never clears itself, a newer log entry means the failure is past).
//   unknown tools tools of the last UNKNOWN_TOOLS_DAYS days of the decision log that are in no known-tool table
//                 of their host (the same test as doctor and `fence log --unknown-tools`); at most
//                 UNKNOWN_TOOLS_LISTED names, each cut to TOOL_NAME_CAP safe characters.
//   bypass        permission_mode is bypassPermissions and the active profile's undecided is `host`: calls no
//                 rule decides run without a question.
//   policy        source is `compact` and the sha256 of the policy file differs from the one recorded in this
//                 session's keep/ snapshot (PreCompact). A snapshot with no recorded sha says nothing.
//
// Fail open: nothing here throws. A status source that fails drops only its own line; a policy that does not
// load (so no keep-list) gives '' and the engine returns {}. Log files are read from the tail, at most
// SCAN_FILE_BYTES each, the newest LOG_MAX_FILES day files. Text taken from the log (tool names) is untrusted
// and reduced to a safe alphabet before it is shown.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { lookupCodexTool, lookupTool } from '../hosts/tools.mjs';
import { parseLines } from '../log/log.mjs';
import { loadPolicy } from '../policy/load.mjs';
import { hatchIsValid } from '../watchdog.mjs';
import { parseIso } from '../watchdog/integrity.mjs';
import { keepFileName, readKeepSnapshot, renderKeepList } from './keeplist.mjs';

export const STATUS_MAX_LINES = 6;
export const STATUS_LINE_CAP = 200;
export const UNKNOWN_TOOLS_DAYS = 7;
export const UNKNOWN_TOOLS_LISTED = 3;
export const TOOL_NAME_CAP = 40;
export const LOG_MAX_FILES = 8;
export const SCAN_FILE_BYTES = 4 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_SMALL_FILE = 1024 * 1024;
const MAX_HATCH_BYTES = 64 * 1024;
const BYPASS_MODE = 'bypassPermissions';
const ELLIPSIS = '…';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMissing = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

// Untrusted text -> a short, printable, single-line string (control, format and separator characters and
// anything outside a plain alphabet become `?`).
function safeName(value, cap) {
  const s = String(value).replace(/[^A-Za-z0-9_.:/@+-]/g, '?');
  return s.length > cap ? `${s.slice(0, cap - 1)}${ELLIPSIS}` : s;
}

function capLine(text) {
  const s = String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.length > STATUS_LINE_CAP ? `${s.slice(0, STATUS_LINE_CAP - 1)}${ELLIPSIS}` : s;
}

// {text, mtimeMs} of a regular file, or of its last `cap` bytes when larger (a cut first line is just a bad
// log line); null when it is not a regular file. One open descriptor decides everything: no symlink is
// followed (O_NOFOLLOW), a FIFO does not block the open (O_NONBLOCK), the type and size come from fstat of
// that descriptor, and never more than `cap` bytes are read from it, whatever the file grows to meanwhile.
function readTail(fsImpl, file, cap = SCAN_FILE_BYTES) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = nodeFs.constants;
  const fd = fsImpl.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, cap));
    const from = st.size - buf.length;
    let n = 0;
    while (n < buf.length) {
      const got = fsImpl.readSync(fd, buf, n, buf.length - n, from + n);
      if (got === 0) break;
      n += got;
    }
    return { text: buf.subarray(0, n).toString('utf8'), mtimeMs: st.mtimeMs };
  } finally {
    fsImpl.closeSync(fd);
  }
}

// A small JSON object file: the object, null when missing, or throws.
function readObject(fsImpl, file) {
  let st;
  try {
    st = fsImpl.statSync(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (!st.isFile() || st.size > MAX_SMALL_FILE) throw new Error(`${file} is not a regular file of a sane size`);
  const v = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  if (!isObject(v)) throw new Error(`${file} is not a JSON object`);
  return v;
}

function hatchLine({ adminDir, now, fs: fsImpl }) {
  const file = nodePath.join(adminDir, 'hatch.json');
  let stat;
  try {
    stat = fsImpl.lstatSync(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (!Number.isFinite(stat.size) || stat.size > MAX_HATCH_BYTES) return null;
  const text = fsImpl.readFileSync(file, 'utf8');
  if (!hatchIsValid(stat, text, now)) return null;
  const expires = parseIso(JSON.parse(text).expires);
  return `A fence hatch is open until ${new Date(expires).toISOString()}: fence is NOT enforcing anything, self-protection included. Close it with "fence hatch --close" in your own terminal.`;
}

function integrityLine({ stateDir, fs: fsImpl }) {
  try {
    fsImpl.lstatSync(nodePath.join(stateDir, 'needs-repair'));
  } catch (err) {
    if (isMissing(err)) return null;
    // any other error counts as set, as in the watchdog
  }
  return 'A post-hatch integrity check found changes or did not finish: every tool call is denied until you run "fence repair" in your own terminal.';
}

// The time (ms) of the newest write in the decision log: the latest entry timestamp of the newest day file,
// else that file's mtime; null when there is none.
function newestLogWrite(fsImpl, logDir) {
  const names = fsImpl.readdirSync(logDir).filter((n) => DAY_FILE.test(n)).sort();
  if (names.length === 0) return null;
  const file = nodePath.join(logDir, names[names.length - 1]);
  const tail = readTail(fsImpl, file);
  if (tail === null) return null;
  let newest = Number.NaN;
  for (const e of parseLines(tail.text).entries) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : Number.NaN;
    if (Number.isFinite(ts) && !(ts <= newest)) newest = ts;
  }
  if (Number.isFinite(newest)) return newest;
  return Number.isFinite(tail.mtimeMs) ? tail.mtimeMs : null;
}

function logLine({ stateDir, fs: fsImpl }) {
  const h = readObject(fsImpl, nodePath.join(stateDir, 'health.json'));
  if (h === null || (h.logFailure === undefined && h.logFailed !== true)) return null;
  // strict ISO-8601 (the watchdog's parseIso): a time written any other way is unreadable, so no later write clears the failure
  const at = isObject(h.logFailure) ? parseIso(h.logFailure.at) : Number.NaN;
  if (Number.isFinite(at)) {
    let latest = null;
    try {
      latest = newestLogWrite(fsImpl, nodePath.join(stateDir, 'log'));
    } catch {
      latest = null;
    }
    if (latest !== null && latest > at) return null; // a later write succeeded: the failure is past
  }
  const when = Number.isFinite(at) ? ` on ${new Date(at).toISOString()}` : '';
  return `A fence decision-log write failed${when}: some decisions may be missing from the log. Run "fence doctor" in your own terminal.`;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function unknownToolsLine({ stateDir, now, fs: fsImpl }) {
  const logDir = nodePath.join(stateDir, 'log');
  const cutoff = now - UNKNOWN_TOOLS_DAYS * DAY_MS;
  let names;
  try {
    names = fsImpl.readdirSync(logDir);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  names = names.filter((n) => DAY_FILE.test(n) && n.slice(0, 10) >= isoDay(cutoff)).sort().slice(-LOG_MAX_FILES);
  const seen = new Map();
  for (const name of names) {
    try {
      const tail = readTail(fsImpl, nodePath.join(logDir, name));
      if (tail === null) continue;
      for (const e of parseLines(tail.text).entries) {
        if (typeof e.decision !== 'string' || typeof e.tool !== 'string' || e.tool === '') continue;
        const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : Number.NaN;
        if (Number.isFinite(ts) && ts < cutoff) continue;
        const known = e.host === 'codex' ? lookupCodexTool(e.tool) !== null : e.host === 'claude' ? lookupTool(e.tool) !== null : lookupTool(e.tool) !== null || lookupCodexTool(e.tool) !== null;
        if (known) continue;
        const key = `${safeName(typeof e.host === 'string' ? e.host : 'unknown', 16)} ${safeName(e.tool, TOOL_NAME_CAP)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    } catch {
      // an unreadable day file is skipped
    }
  }
  if (seen.size === 0) return null;
  const rows = [...seen].sort((a, b) => b[1] - a[1]).slice(0, UNKNOWN_TOOLS_LISTED).map(([k, n]) => `${k} x${n}`);
  const more = seen.size > UNKNOWN_TOOLS_LISTED ? `, +${seen.size - UNKNOWN_TOOLS_LISTED} more` : '';
  return `${seen.size} unknown tool${seen.size === 1 ? '' : 's'} in the last ${UNKNOWN_TOOLS_DAYS} days that no rule can name (run "fence log --unknown-tools"): ${rows.join(', ')}${more}`;
}

function bypassLine({ policy, profile, payload }) {
  if (payload.permission_mode !== BYPASS_MODE) return null;
  if (!isObject(policy?.profiles) || !Object.hasOwn(policy.profiles, profile) || policy.profiles[profile]?.undecided !== 'host') return null;
  // the guidance first, the (untrusted, variable length) profile name last: a cut line loses the name, not the advice
  return `Bypass mode is on: calls no rule decides run without asking. Start with a FENCE_PROFILE whose undecided is "deny" to block them. Profile "${safeName(profile, 32)}" has undecided: host.`;
}

function policyLine({ sha, stateDir, payload, fs: fsImpl }) {
  if (payload.source !== 'compact' || typeof sha !== 'string') return null;
  if (keepFileName(payload.session_id) === null) return null;
  const snapshot = readKeepSnapshot(stateDir, payload.session_id, { fs: fsImpl });
  if (snapshot === null || snapshot.sha === null || snapshot.sha === sha) return null;
  return 'The fence policy changed since this session\'s compaction snapshot; the rules above are the current ones. Run "fence check" in your own terminal to review it.';
}

const SOURCES = [hatchLine, integrityLine, logLine, unknownToolsLine, bypassLine, policyLine];

export function statusLines(ctx) {
  const out = [];
  for (const source of SOURCES) {
    try {
      const line = source(ctx);
      if (typeof line === 'string' && line !== '') out.push(capLine(line));
    } catch {
      // a source that fails drops only its own line
    }
  }
  return out.slice(0, STATUS_MAX_LINES);
}

export function sessionContext({ policyFile, stateDir, adminDir, home, now = Date.now(), env = {}, payload, fs: fsImpl = nodeFs } = {}) {
  let policy;
  let sha;
  let keep;
  const profile = env !== null && typeof env === 'object' && env.FENCE_PROFILE !== undefined ? env.FENCE_PROFILE : 'default';
  try {
    ({ policy, sha } = loadPolicy(policyFile, { fs: fsImpl, home }));
    keep = renderKeepList(policy, { profile });
  } catch {
    return '';
  }
  let lines = [];
  try {
    lines = statusLines({ policy, sha, profile, stateDir, adminDir, now, payload: isObject(payload) ? payload : {}, fs: fsImpl });
  } catch {
    lines = [];
  }
  return [keep, ...lines].join('\n');
}
