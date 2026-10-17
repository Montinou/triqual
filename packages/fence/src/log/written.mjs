// Written-files index (spec, "Decision log, redaction, written-files index").
//
//   appendWritten(stateDir, sessionId, paths, {fs, maxPaths}) -> {ok: boolean}
//   readWritten(stateDir, {days = 30, now, fs, maxReadBytes}) -> {set: Set<string>, incomplete: boolean}
//   isAgentWritten(path, set, caseInsensitive) -> boolean
//   writtenFileName(sessionId) -> '<safe name>.txt'
//
// <stateDir>/written/<session>.txt holds one absolute realpath per line, appended (O_APPEND, file 0600,
// directory 0700) for every write of a call that was allowed or undecided. The normalizer's
// `writtenIndex` (git `.git/config` precondition) and the agent-written script check read the union of
// every session file modified within the retention window; prune.mjs removes the older ones.
//
// The session id comes from an untrusted payload: it becomes a file name only when it is a plain
// identifier ([A-Za-z0-9][A-Za-z0-9_-]{0,127}); anything else (separators, dots, control characters, an
// over-long or empty id) maps to `h-<sha256 prefix>`, so a hostile id can never leave written/.
// `incomplete` (readWritten) is true when the index may not show everything the agent wrote: a session file
// larger than the read cap (only its tail is read), a file or the written/ directory that exists but cannot
// be read (symlink, EACCES, ...), or a session file carrying the `#incomplete` line that appendWritten adds
// when one call has more than MAX_PATHS_PER_CALL paths. A missing written/ is normal and complete. Consumers
// treat incomplete as "everything may be agent-written".
// Like the day log, a path that exists must be what is expected (a real directory, a regular file):
// symlinks are never followed (lstat, then O_NOFOLLOW on the open). Nothing here throws.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { foldCase } from '../resolve/paths.mjs';

export const WRITTEN_DIR = 'written';
export const RETENTION_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WRITTEN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.txt$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Bytes of one index file read back (its tail); an index this large is far beyond a real session.
const MAX_READ_BYTES = 16 * 1024 * 1024;
// A path already in the session's file is not appended again while that file is smaller than this.
export const DEDUPE_BYTES = 1024 * 1024;
// Paths one call appends; past it the first MAX_PATHS_PER_CALL are written plus the INCOMPLETE_MARK line.
export const MAX_PATHS_PER_CALL = 1000;
export const INCOMPLETE_MARK = '#incomplete';

export function writtenFileName(sessionId) {
  if (typeof sessionId === 'string' && SAFE_ID.test(sessionId)) return `${sessionId}.txt`;
  const digest = createHash('sha256').update(typeof sessionId === 'string' ? sessionId : '', 'utf8').digest('hex');
  return `h-${digest.slice(0, 32)}.txt`;
}

// A path that exists must be a real directory / regular file, never a symlink. Missing is fine (null).
function kindOf(fsImpl, target) {
  try {
    const st = fsImpl.lstatSync(target);
    if (st.isSymbolicLink()) return 'other';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch (err) {
    return err?.code === 'ENOENT' ? null : 'other';
  }
}

const usable = (p) => typeof p === 'string' && p.startsWith('/') && !/[\n\r\0]/.test(p);

export function appendWritten(stateDir, sessionId, paths, { fs: fsImpl = nodeFs, maxPaths = MAX_PATHS_PER_CALL } = {}) {
  let fd = null;
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return { ok: false };
    let lines = [...new Set((Array.isArray(paths) ? paths : []).filter(usable))];
    if (lines.length === 0) return { ok: true };
    const dir = nodePath.join(stateDir, WRITTEN_DIR);
    const file = nodePath.join(dir, writtenFileName(sessionId));
    fsImpl.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const dirKind = kindOf(fsImpl, dir);
    if (dirKind !== null && dirKind !== 'dir') return { ok: false };
    if (dirKind === null) fsImpl.mkdirSync(dir, { mode: 0o700 });
    if (kindOf(fsImpl, dir) !== 'dir') return { ok: false };
    const fileKind = kindOf(fsImpl, file);
    if (fileKind !== null && fileKind !== 'file') return { ok: false };
    const c = nodeFs.constants;
    // O_RDWR so the session's own file can be read once for the cross-call dedupe; O_APPEND still
    // sends every write to the end.
    fd = fsImpl.openSync(file, c.O_RDWR | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW ?? 0), 0o600);
    fsImpl.fchmodSync(fd, 0o600);
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return { ok: false };
    let known = new Set();
    if (st.size > 0 && st.size < DEDUPE_BYTES) {
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) {
        const n = fsImpl.readSync(fd, buf, got, st.size - got, got);
        if (n === 0) break;
        got += n;
      }
      known = new Set(buf.subarray(0, got).toString('utf8').split('\n'));
    }
    lines = lines.filter((l) => !known.has(l));
    const limit = Number.isInteger(maxPaths) && maxPaths >= 0 ? maxPaths : MAX_PATHS_PER_CALL;
    if (lines.length > limit) lines = [...lines.slice(0, limit), INCOMPLETE_MARK];
    if (lines.length === 0) return { ok: true };
    fsImpl.writeSync(fd, `${lines.join('\n')}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    try {
      if (fd !== null) fsImpl.closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

// -> {text, mtimeMs, truncated} | null (unreadable)
function readTail(fsImpl, file, cap) {
  let fd = null;
  try {
    const c = nodeFs.constants;
    fd = fsImpl.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW ?? 0));
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = st.size;
    const len = Math.min(size, cap);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fsImpl.readSync(fd, buf, got, len - got, size - len + got);
      if (n === 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1); // the first line of a tail may be cut
    return { text, mtimeMs: st.mtimeMs, truncated: size > len };
  } catch {
    return null;
  } finally {
    try {
      if (fd !== null) fsImpl.closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

// The union of every session file modified within the last `days` days (default 30) before `now`
// (a number or a function, default the clock), and whether that union may be missing writes (see the
// header). A missing written/ directory is complete and empty.
export function readWritten(stateDir, { days = RETENTION_DAYS, now = Date.now, fs: fsImpl = nodeFs, maxReadBytes = MAX_READ_BYTES } = {}) {
  const set = new Set();
  let incomplete = false;
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return { set, incomplete: true };
    const dir = nodePath.join(stateDir, WRITTEN_DIR);
    const dirKind = kindOf(fsImpl, dir);
    if (dirKind === null) return { set, incomplete };
    if (dirKind !== 'dir') return { set, incomplete: true };
    const nowMs = typeof now === 'function' ? now() : now;
    const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - days * DAY_MS;
    const cap = Number.isInteger(maxReadBytes) && maxReadBytes > 0 ? maxReadBytes : MAX_READ_BYTES;
    for (const name of fsImpl.readdirSync(dir)) {
      if (!WRITTEN_NAME.test(name)) continue;
      const file = nodePath.join(dir, name);
      const kind = kindOf(fsImpl, file);
      if (kind === null) continue; // vanished since the listing
      if (kind !== 'file') {
        incomplete = true;
        continue;
      }
      const r = readTail(fsImpl, file, cap);
      if (r === null) {
        incomplete = true;
        continue;
      }
      if (r.mtimeMs < cutoff) continue;
      if (r.truncated) incomplete = true;
      for (const line of r.text.split('\n')) {
        if (usable(line)) set.add(line);
        else if (line === INCOMPLETE_MARK) incomplete = true;
      }
    }
  } catch {
    incomplete = true; // best effort: what was read so far, flagged
  }
  return { set, incomplete };
}

// Case folding of a set, computed once per Set (and size) for repeated lookups.
const FOLDED = new WeakMap();
function foldedSet(set) {
  const cached = FOLDED.get(set);
  if (cached !== undefined && cached.size === set.size) return cached.folded;
  const folded = new Set();
  for (const p of set) folded.add(foldCase(p, true));
  FOLDED.set(set, { size: set.size, folded });
  return folded;
}

// Did the agent write this path (a realpath) in the window? On a case-insensitive volume the comparison
// folds case like the rest of fence (resolve/paths.mjs foldCase).
export function isAgentWritten(path, set, caseInsensitive) {
  if (typeof path !== 'string' || set === null || typeof set !== 'object' || typeof set.has !== 'function') return false;
  if (!caseInsensitive) return set.has(path);
  if (set.has(path)) return true;
  return foldedSet(set).has(foldCase(path, true));
}
