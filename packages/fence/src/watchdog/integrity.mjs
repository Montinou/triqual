// Post-hatch integrity manifest (spec, "Watchdog" step 3).
//
//   manifest = {version: 1, created, expires, files: {path: sha256}, hookKeys: {path: {key: sha256}}, repoRoots: string[]}
//   parseManifest(text) -> manifest | null
//   compareManifest(manifest, {now, deadlineAt, fs, logDir}) -> {equal, diffs, timedOut}
//   hookKeyHashes(path, bytes, keys) -> {key: sha256 | ABSENT} | null (the file does not parse)
//
// `created` / `expires` are the ISO times of the hatch the manifest was taken for (closing a hatch
// early rewrites `expires`). `files` maps an absolute path to the sha256 of its bytes, or to ABSENT
// (64 zeros) for a listed file that did not exist: it must still not exist. `hookKeys` maps an
// absolute path of a host settings file to {key: hash | ABSENT}: for a JSON file (Claude settings)
// the hash is sha256 of canonicalJson(the top-level key's value); for a `.toml` file (Codex
// config.toml) it is sha256 of the key's TOML section lines (tomlSections: the `[key]` / `[key.*]`
// / `[[key…]]` tables and top-level `key = …` / `key.x = …` lines, comments and blank lines
// dropped, trimmed). A key with a hash that is gone is "missing"; a key recorded ABSENT that is now
// present is "added".
//
// The project-settings rule (spec, CLI `hatch`): project settings have no baseline. The repo roots
// are `repoRoots` plus, when `logDir` is given, every `repo.root` and `cwd` (absolute strings) of
// the log lines in <logDir>/YYYY-MM-DD.jsonl whose `ts` falls inside [created, expires]. For each
// root, a `.claude/settings*.json` or `.codex/config.toml` whose mtime (of the file, or of a
// symlink or its target) falls inside the window and that holds any hook-related key
// (CLAUDE_HOOK_KEYS for JSON, CODEX_HOOK_KEYS for TOML) is a difference {path, key, kind:
// "project-settings"}; such a file that is not a regular file or does not parse is "unreadable".
// A candidate that is a `hookKeys` path (as written or by its real path) is skipped: it has a
// baseline. The window is read from at most MAX_LOG_DAYS day files (more is "unreadable").
// Best effort: the agent could have removed log lines during the hatch.
//
// compareManifest checks the clock (`now()`, default Date.now) before every file and between the
// read chunks of a file, and stops with {equal: false, timedOut: true} once it reaches `deadlineAt`.
// Every listed path is lstat()ed first: anything that is not a regular file (a FIFO, a device, a
// symlink, a directory) and any file over MAX_FILE_BYTES (16 MiB) is "unreadable" without being
// opened; the file is then opened with O_NOFOLLOW | O_NONBLOCK and fstat()ed again before reading,
// so a swap between the lstat and the open is also "unreadable". A diff is {path, key?, kind} with
// kind "changed", "missing", "added", "unreadable" or "project-settings". Self-contained: imports
// only node: modules (the watchdog bundles it). Nothing here throws.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';

export const MANIFEST_VERSION = 1;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
// The largest integrity.json the watchdog reads; `fence hatch` refuses to write a larger one.
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
// A listed file or key that did not exist when the manifest was taken.
export const ABSENT = '0'.repeat(64);
// The hook-related keys (spec, CLI `hatch`): of Claude settings, and of Codex config.toml (trust
// records under [projects] excluded).
export const CLAUDE_HOOK_KEYS = Object.freeze(['hooks', 'disableAllHooks', 'enabledPlugins', 'extraKnownMarketplaces', 'env']);
export const CODEX_HOOK_KEYS = Object.freeze(['features', 'hooks', 'plugins']);
// Bounds of the project-settings scan.
export const MAX_REPO_ROOTS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

const join = (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

// A TOML line without its comment (a `#` outside a string).
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// Open minus close brackets/braces outside strings: a top-level value continues while it is > 0.
function bracketDelta(line) {
  let quote = null;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') n++;
    else if (c === ']' || c === '}') n--;
  }
  return n;
}

// The first dotted segment of a TOML key (bare or quoted), or null.
function firstSegment(s) {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(s);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3];
}

/**
 * The lines of a TOML text that belong to each of `keys`: the tables whose name starts with the key
 * (`[key]`, `[key.x]`, `[[key.x]]`, header line included) and top-level `key = …` / `key.x = …`
 * assignments (multi-line arrays and inline tables followed to their close). Comments and blank
 * lines are dropped and lines trimmed, so formatting outside those sections never counts.
 */
export function tomlSections(text, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, []]));
  let table = null; // the current table's first segment; null at the top level
  let carry = null; // a top-level key whose value continues on the next lines
  let depth = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (carry !== null) {
      if (line !== '') out[carry].push(line);
      depth += bracketDelta(line);
      if (depth <= 0) {
        carry = null;
        depth = 0;
      }
      continue;
    }
    if (line === '') continue;
    const header = /^\[\[?(.*?)\]\]?$/.exec(line);
    if (header) {
      table = firstSegment(header[1]);
      if (table !== null && Object.hasOwn(out, table)) out[table].push(line);
      continue;
    }
    if (table === null) {
      const key = firstSegment(line);
      if (key === null || !Object.hasOwn(out, key)) continue;
      out[key].push(line);
      const eq = line.indexOf('=');
      const d = eq === -1 ? 0 : bracketDelta(line.slice(eq + 1));
      if (d > 0) {
        carry = key;
        depth = d;
      }
    } else if (Object.hasOwn(out, table)) {
      out[table].push(line);
    }
  }
  return out;
}

/**
 * {key: hash | ABSENT} of a settings file's bytes for the given keys, or null when it does not parse
 * (JSON that is not an object; TOML is read line by line and always "parses").
 */
export function hookKeyHashes(path, bytes, keys) {
  try {
    const text = Buffer.from(bytes).toString('utf8');
    if (String(path).toLowerCase().endsWith('.toml')) {
      const sections = tomlSections(text, keys);
      return Object.fromEntries(keys.map((k) => [k, sections[k].length === 0 ? ABSENT : sha256(sections[k].join('\n'))]));
    }
    const doc = JSON.parse(text);
    if (!isObject(doc)) return null;
    return Object.fromEntries(keys.map((k) => [k, Object.hasOwn(doc, k) ? hookKeyHash(doc[k]) : ABSENT]));
  } catch {
    return null;
  }
}

// The UTC day files of the log that can hold lines of [created, expires]; null past MAX_LOG_DAYS
// (a carried-over baseline can span several hatches; the log is kept 30 days).
export const MAX_LOG_DAYS = 40;
function logDays(created, expires) {
  const days = [];
  for (let t = Math.floor(created / DAY_MS) * DAY_MS; t <= expires; t += DAY_MS) {
    if (days.length >= MAX_LOG_DAYS) return null;
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

// Adds to `roots` the repo roots and cwds of the log lines inside the window, reading each day file
// in chunks under the deadline (no size cap: the deadline bounds it). -> "timedOut" | undefined.
function logRoots(logDir, created, expires, fsImpl, late, roots, diffs) {
  const days = logDays(created, expires);
  if (days === null) {
    diffs.push({ path: logDir, kind: 'unreadable' });
    return undefined;
  }
  const take = (bytes) => {
    let v;
    try {
      v = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (!isObject(v)) return;
    const ts = parseIso(v.ts);
    if (!(ts >= created && ts <= expires)) return;
    if (isObject(v.repo) && isAbs(v.repo.root)) roots.add(v.repo.root);
    if (isAbs(v.cwd)) roots.add(v.cwd);
  };
  for (const day of days) {
    if (late()) return 'timedOut';
    const file = join(logDir, `${day}.jsonl`);
    let st;
    try {
      st = fsImpl.lstatSync(file);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') diffs.push({ path: file, kind: 'unreadable' });
      continue;
    }
    if (!isRegular(st)) {
      diffs.push({ path: file, kind: 'unreadable' });
      continue;
    }
    let fd;
    try {
      const c = nodeFs.constants;
      fd = fsImpl.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0));
    } catch {
      diffs.push({ path: file, kind: 'unreadable' });
      continue;
    }
    try {
      let rest = Buffer.alloc(0);
      for (;;) {
        if (late()) return 'timedOut';
        const buf = Buffer.alloc(CHUNK);
        const n = fsImpl.readSync(fd, buf, 0, CHUNK, null);
        if (n === 0) break;
        let data = Buffer.concat([rest, buf.subarray(0, n)]);
        let nl;
        while ((nl = data.indexOf(0x0a)) !== -1) {
          take(data.subarray(0, nl));
          data = data.subarray(nl + 1);
        }
        rest = Buffer.from(data);
      }
      if (rest.length > 0) take(rest);
    } catch {
      diffs.push({ path: file, kind: 'unreadable' });
    } finally {
      try {
        fsImpl.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
  return undefined;
}

// The project settings files of one root that the rule looks at.
function projectCandidates(root, fsImpl) {
  const out = [];
  const claudeDir = join(root, '.claude');
  try {
    for (const name of fsImpl.readdirSync(claudeDir)) {
      if (typeof name === 'string' && /^settings.*\.json$/i.test(name)) out.push(join(claudeDir, name));
    }
  } catch {
    // no .claude directory
  }
  out.push(join(join(root, '.codex'), 'config.toml'));
  return out;
}

// Was the file (or a symlink, or its target) modified inside the window? -> {touched, stat} | null.
function touchedInWindow(file, created, expires, fsImpl) {
  let st;
  try {
    st = fsImpl.lstatSync(file);
  } catch {
    return null;
  }
  const inWindow = (s) => Number.isFinite(s?.mtimeMs) && s.mtimeMs >= created && s.mtimeMs <= expires;
  let touched = inWindow(st);
  if (!touched && typeof st?.isSymbolicLink === 'function' && st.isSymbolicLink()) {
    try {
      touched = inWindow(fsImpl.statSync(file));
    } catch {
      touched = false;
    }
  }
  return { touched, stat: st };
}

// Is `file` (as written, or by its real path) one of `skip`?
function skipped(file, skip, fsImpl) {
  if (skip.has(file)) return true;
  try {
    const rp = fsImpl.realpathSync;
    const real = typeof rp?.native === 'function' ? rp.native(file) : rp(file);
    return skip.has(real);
  } catch {
    return false;
  }
}

// The project-settings rule over `roots`; files in `skip` (the manifest's hookKeys paths: a log cwd
// equal to HOME must not make ~/.claude/settings.json a project file) are compared by hookKeys only.
// -> "timedOut" | undefined.
function projectSettings(roots, created, expires, fsImpl, late, diffs, skip) {
  let n = 0;
  for (const root of roots) {
    if (late()) return 'timedOut';
    if (++n > MAX_REPO_ROOTS) {
      diffs.push({ path: root, kind: 'unreadable' });
      return undefined;
    }
    for (const file of projectCandidates(root, fsImpl)) {
      if (late()) return 'timedOut';
      if (skipped(file, skip, fsImpl)) continue;
      const t = touchedInWindow(file, created, expires, fsImpl);
      if (t === null || !t.touched) continue;
      const toml = file.toLowerCase().endsWith('.toml');
      const keys = toml ? CODEX_HOOK_KEYS : CLAUDE_HOOK_KEYS;
      const read = readBounded(file, fsImpl, late);
      if (read.timedOut) return 'timedOut';
      if (read.kind === 'missing') continue;
      const hashes = read.kind ? null : hookKeyHashes(file, read.bytes, keys);
      if (hashes === null) {
        diffs.push({ path: file, kind: 'unreadable' });
        continue;
      }
      const key = keys.find((k) => hashes[k] !== ABSENT);
      if (key !== undefined) diffs.push({ path: file, key, kind: 'project-settings' });
    }
  }
  return undefined;
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

export function compareManifest(manifest, { now = Date.now, deadlineAt = Number.POSITIVE_INFINITY, fs: fsImpl = nodeFs, logDir } = {}) {
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
      if (expected === ABSENT) {
        if (read.kind === 'missing') continue;
        diffs.push({ path, kind: read.kind ?? 'added' });
      } else if (read.kind) diffs.push({ path, kind: read.kind });
      else if (sha256(read.bytes) !== expected) diffs.push({ path, kind: 'changed' });
    }
    for (const [path, keys] of Object.entries(manifest.hookKeys)) {
      if (late()) return stop();
      const read = readBounded(path, fsImpl, late);
      if (read.timedOut) return stop();
      const names = Object.keys(keys);
      if (read.kind === 'missing') {
        // a file that is gone holds none of its keys: only the recorded ones are differences
        for (const key of names) if (keys[key] !== ABSENT) diffs.push({ path, key, kind: 'missing' });
        continue;
      }
      const actual = read.kind ? null : hookKeyHashes(path, read.bytes, names);
      if (actual === null) {
        for (const key of names) diffs.push({ path, key, kind: 'unreadable' });
        continue;
      }
      for (const [key, expected] of Object.entries(keys)) {
        if (actual[key] === expected) continue;
        if (expected === ABSENT) diffs.push({ path, key, kind: 'added' });
        else if (actual[key] === ABSENT) diffs.push({ path, key, kind: 'missing' });
        else diffs.push({ path, key, kind: 'changed' });
      }
    }
    // the project-settings rule
    const created = parseIso(manifest.created);
    const expires = parseIso(manifest.expires);
    if (Number.isFinite(created) && Number.isFinite(expires)) {
      const roots = new Set(Array.isArray(manifest.repoRoots) ? manifest.repoRoots.filter(isAbs) : []);
      if (isAbs(logDir) && logRoots(logDir, created, expires, fsImpl, late, roots, diffs) === 'timedOut') return stop();
      if (projectSettings(roots, created, expires, fsImpl, late, diffs, new Set(Object.keys(manifest.hookKeys))) === 'timedOut') return stop();
    } else {
      diffs.push({ path: '', kind: 'unreadable' });
    }
    if (late()) return stop();
    return { equal: diffs.length === 0, diffs, timedOut: false };
  } catch {
    return { equal: false, diffs: [...diffs, { path: '', kind: 'unreadable' }], timedOut: false };
  }
}
