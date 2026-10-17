// Post-hatch integrity manifest (spec, "Watchdog" step 3).
//
//   manifest = {version: 1, created, expires, files: {path: sha256}, hookKeys: {path: {key: sha256}}, repoRoots: string[]}
//   parseManifest(text) -> manifest | null
//   compareManifest(manifest, {now, deadlineAt, fs}) -> {equal, diffs, timedOut}
//
// `created` / `expires` are the ISO times of the hatch the manifest was taken for. `files` maps an
// absolute path to the sha256 of its bytes. `hookKeys` maps an absolute path of a JSON file (a
// host settings or hooks file) to {top-level key: sha256 of canonicalJson(value)}; a key missing
// from the file is a difference. `repoRoots` (absolute paths) is carried for the project-settings
// rule T38 adds; nothing compares it yet.
//
// compareManifest checks the clock (`now()`, default Date.now) before every file and between the
// read chunks of a file, and stops with {equal: false, timedOut: true} once it reaches `deadlineAt`.
// Every listed path is lstat()ed first: anything that is not a regular file (a FIFO, a device, a
// symlink, a directory) and any file over MAX_FILE_BYTES (16 MiB) is "unreadable" without being
// opened; the file is then opened with O_NOFOLLOW | O_NONBLOCK and fstat()ed again before reading,
// so a swap between the lstat and the open is also "unreadable". A diff is {path, key?, kind} with
// kind "changed", "missing" or "unreadable". Self-contained: imports only node: modules (the
// watchdog bundles it). Nothing here throws.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';

export const MANIFEST_VERSION = 1;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const KEYS = Object.freeze(['version', 'created', 'expires', 'files', 'hookKeys', 'repoRoots']);
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const HEX64 = /^[0-9a-f]{64}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** JSON with object keys sorted at every depth, so formatting and key order do not count. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hookKeyHash = (value) => sha256(canonicalJson(value));

/**
 * An ISO-8601 timestamp string (with a zone) -> ms, or NaN. Strict: every field must be in range
 * for its calendar month (no 2026-02-30, no hour 24, no second 60), at most 3 fractional digits,
 * and a zone offset of at most 23:59.
 */
export function parseIso(value) {
  if (typeof value !== 'string') return Number.NaN;
  const m = ISO.exec(value);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  const offH = m[9] === undefined ? 0 : Number(m[9]);
  const offM = m[10] === undefined ? 0 : Number(m[10]);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59 || offH > 23 || offM > 59) return Number.NaN;
  const local = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return Number.NaN;
  const offset = (offH * 60 + offM) * 60 * 1000;
  return m[8] === '-' ? local + offset : local - offset;
}

const isRegular = (st) => (typeof st?.isFile === 'function' ? st.isFile() : (st?.mode & S_IFMT) === S_IFREG);

// One listed file -> {bytes} | {kind: "missing" | "unreadable"} | {timedOut: true}. lstat first;
// a non-regular or oversized file is never opened.
export function readBounded(path, fsImpl, late) {
  let st;
  try {
    st = fsImpl.lstatSync(path);
  } catch (err) {
    return { kind: err?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!isRegular(st) || !(st.size <= MAX_FILE_BYTES)) return { kind: 'unreadable' };
  let fd;
  try {
    const c = nodeFs.constants;
    fd = fsImpl.openSync(path, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0));
  } catch (err) {
    return { kind: err?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const fst = fsImpl.fstatSync(fd);
    if (!isRegular(fst) || !(fst.size <= MAX_FILE_BYTES)) return { kind: 'unreadable' };
    const parts = [];
    let total = 0;
    for (;;) {
      if (late()) return { timedOut: true };
      const buf = Buffer.alloc(CHUNK);
      const n = fsImpl.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_FILE_BYTES) return { kind: 'unreadable' };
      parts.push(n === CHUNK ? buf : buf.subarray(0, n));
    }
    return { bytes: Buffer.concat(parts, total) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      // already closed
    }
  }
}

export function parseManifest(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v) || Object.keys(v).some((k) => !KEYS.includes(k)) || v.version !== MANIFEST_VERSION) return null;
  if (!Number.isFinite(parseIso(v.created)) || !Number.isFinite(parseIso(v.expires))) return null;
  if (!isObject(v.files) || !Object.entries(v.files).every(([p, h]) => isAbs(p) && typeof h === 'string' && HEX64.test(h))) return null;
  if (!isObject(v.hookKeys)) return null;
  for (const [p, keys] of Object.entries(v.hookKeys)) {
    if (!isAbs(p) || !isObject(keys) || !Object.values(keys).every((h) => typeof h === 'string' && HEX64.test(h))) return null;
  }
  if (!Array.isArray(v.repoRoots) || !v.repoRoots.every(isAbs)) return null;
  return v;
}

export function compareManifest(manifest, { now = Date.now, deadlineAt = Number.POSITIVE_INFINITY, fs: fsImpl = nodeFs } = {}) {
  const diffs = [];
  const clock = typeof now === 'function' ? now : () => Date.now();
  const late = () => !(clock() < deadlineAt);
  const stop = () => ({ equal: false, diffs, timedOut: true });
  try {
    if (!isObject(manifest) || !isObject(manifest.files) || !isObject(manifest.hookKeys)) {
      return { equal: false, diffs: [{ path: '', kind: 'unreadable' }], timedOut: false };
    }
    for (const [path, expected] of Object.entries(manifest.files)) {
      if (late()) return stop();
      const read = readBounded(path, fsImpl, late);
      if (read.timedOut) return stop();
      if (read.kind) diffs.push({ path, kind: read.kind });
      else if (sha256(read.bytes) !== expected) diffs.push({ path, kind: 'changed' });
    }
    for (const [path, keys] of Object.entries(manifest.hookKeys)) {
      if (late()) return stop();
      const read = readBounded(path, fsImpl, late);
      if (read.timedOut) return stop();
      let doc;
      try {
        if (read.kind) throw Object.assign(new Error(read.kind), { kind: read.kind });
        doc = JSON.parse(read.bytes.toString('utf8'));
      } catch (err) {
        for (const key of Object.keys(keys)) diffs.push({ path, key, kind: err?.kind === 'missing' ? 'missing' : 'unreadable' });
        continue;
      }
      for (const [key, expected] of Object.entries(keys)) {
        if (!isObject(doc) || !Object.hasOwn(doc, key)) diffs.push({ path, key, kind: 'missing' });
        else if (hookKeyHash(doc[key]) !== expected) diffs.push({ path, key, kind: 'changed' });
      }
    }
    if (late()) return stop();
    return { equal: diffs.length === 0, diffs, timedOut: false };
  } catch {
    return { equal: false, diffs: [...diffs, { path: '', kind: 'unreadable' }], timedOut: false };
  }
}
