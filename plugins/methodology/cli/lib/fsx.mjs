// File helpers for editing files under ~/.claude safely: symlink-aware atomic writes, private backups, and the
// managed section of CLAUDE.md. Every caller passes explicit paths; nothing here resolves the real home.
import {
  lstatSync, readlinkSync, realpathSync, statSync, openSync, fchmodSync, fsyncSync, closeSync, renameSync, unlinkSync,
  mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BRAND } from './brand.mjs';

const MAX_LINKS = 40;

// Follows a symlink chain to the final path. A missing path (or a dangling link's missing target) is returned as is,
// so a write through a dangling link creates its target instead of replacing the link. Link text is resolved the way
// the kernel does, against the link's real directory, so `..` under a symlinked parent dir lands in the right place.
export function realTarget(path) {
  let current = path;
  for (let i = 0; i < MAX_LINKS; i++) {
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return current;
      throw err;
    }
    if (!st.isSymbolicLink()) return current;
    try {
      return realpathSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // The chain dangles somewhere: take one hop by hand, from the link's real directory.
    current = resolve(realpathSync(dirname(current)), readlinkSync(current));
  }
  const err = new Error(`too many symbolic links: ${path}`);
  err.code = 'ELOOP';
  throw err;
}

// Writes `content` to the real target of `path` through a temp file in the same dir plus rename. Keeps the existing
// mode, or 0644 for a new file. The temp file is removed when anything fails.
export function writeAtomic(path, content) {
  const target = realTarget(path);
  let mode = 0o644;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, content); // loops until every byte is written; a short write throws instead of renaming
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created or already gone */ }
    throw err;
  }
}

// Copies `src` into `backupDir` (created 0700 if missing) as basename(src), mode 0600. Returns the destination, or
// null when `src` does not exist. An existing backup of the same basename is kept: the first backup of a run wins.
export function backupFile(src, backupDir) {
  if (!existsSync(src)) return null;
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
  }
  const dest = join(backupDir, basename(src));
  if (existsSync(dest)) return dest;
  writeFileSync(dest, readFileSync(src), { mode: 0o600, flag: 'wx' });
  chmodSync(dest, 0o600);
  return dest;
}

const pad = (n) => String(n).padStart(2, '0');

// <home>/.claude/backups/<brand dir>-<YYYYMMDD-HHMMSS>, in local time.
export function backupDirFor(home, now) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(home, '.claude', 'backups', `${BRAND.dir}-${stamp}`);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// The markers written around the managed section. A section under the legacy markers (BRAND.legacy.markers) is still
// found, and the next write replaces it in place under these.
export const MARKERS = BRAND.markers;
const PAIRS = [BRAND.markers, BRAND.legacy.markers];

function occurrences(text, needle) {
  const found = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

// Locates the section between one marker pair. Returns { start, end, error }: `start` is the start marker's index,
// `end` the end marker's index, both null when there are no markers. A second end marker counts as 'duplicate' too.
function locatePair(text, markers) {
  const starts = occurrences(text, markers.start);
  const ends = occurrences(text, markers.end);
  if (starts.length > 1 || ends.length > 1) return { start: null, end: null, error: 'duplicate' };
  if (starts.length === 0 && ends.length === 0) return { start: null, end: null, error: null };
  if (ends.length === 0) return { start: null, end: null, error: 'unterminated' };
  if (starts.length === 0 || ends[0] < starts[0]) return { start: null, end: null, error: 'misordered' };
  return { start: starts[0], end: ends[0], error: null };
}

// Locates the managed section under the new or the legacy markers. Returns { start, end, pair, error }: `pair` is the
// marker pair found (null when neither is), and a malformed section names its pair too. A text holding markers of
// both pairs is 'duplicate'.
export function locate(text) {
  const found = PAIRS.map((pair) => ({ pair, ...locatePair(text, pair) }))
    .filter((loc) => loc.error !== null || loc.start !== null);
  if (found.length > 1) return { start: null, end: null, pair: null, error: 'duplicate' };
  return found[0] ?? { start: null, end: null, pair: null, error: null };
}

export function readManagedSection(text) {
  const loc = locate(text);
  if (loc.error) return { body: null, error: loc.error };
  if (loc.start === null) return { body: null, error: null };
  return { body: text.slice(loc.start + loc.pair.start.length, loc.end).trim(), error: null };
}

// The text with the managed section set to `body`, under MARKERS: created (empty text), appended (no section),
// unchanged, updated, or replaced (a legacy section rewritten in place, markers included). Throws on a malformed one.
export function upsertManagedSection(text, body) {
  const loc = locate(text);
  if (loc.error) throw new Error(`managed section is ${loc.error}`);
  const trimmed = body.trim();
  const section = `${MARKERS.start}\n${trimmed}\n${MARKERS.end}\n`;
  if (text === '') return { text: section, action: 'created' };
  if (loc.start === null) {
    return { text: `${text}${text.endsWith('\n') ? '' : '\n'}\n${section}`, action: 'appended' };
  }
  if (loc.pair !== MARKERS) {
    const [before, after] = [text.slice(0, loc.start), text.slice(loc.end + loc.pair.end.length)];
    return { text: `${before}${MARKERS.start}\n${trimmed}\n${MARKERS.end}${after}`, action: 'replaced' };
  }
  const bodyStart = loc.start + MARKERS.start.length;
  if (text.slice(bodyStart, loc.end).trim() === trimmed) return { text, action: 'unchanged' };
  return { text: `${text.slice(0, bodyStart)}\n${trimmed}\n${text.slice(loc.end)}`, action: 'updated' };
}

// The text with the managed section (start marker through end marker, either pair) removed. Text without markers comes
// back unchanged; a malformed section throws like upsertManagedSection, since its extent is unknown.
export function outsideManagedSection(text) {
  const loc = locate(text);
  if (loc.error) throw new Error(`managed section is ${loc.error}`);
  if (loc.start === null) return text;
  return text.slice(0, loc.start) + text.slice(loc.end + loc.pair.end.length);
}
