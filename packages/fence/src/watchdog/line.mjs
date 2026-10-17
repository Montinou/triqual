// Log line shape (spec, "Decision log"): one JSON object per line, capped at 4 KiB so an O_APPEND
// write stays atomic.
//
//   formatLine(entry, cap = 4096) -> string     (ends with "\n", at most `cap` UTF-8 bytes, valid JSON)
//   logFileFor(stateDir, ms) -> <stateDir>/log/YYYY-MM-DD.jsonl   (UTC date)
//   appendLine(stateDir, entry, {now, fs}) -> boolean   (best effort, never throws)
//
// How an oversized entry is shortened (linear time, multibyte-safe, every step measured in the
// exact UTF-8 bytes JSON.stringify produces):
//   1. top-level scalar metadata (PROTECTED_KEYS: ts, host, ids, tool, decision, rule, ...) is never cut;
//   2. strings are cut to a common level T, longest first (water level), each as a prefix plus
//      TRUNCATED, and only when that makes them shorter; first with a floor of FLOOR bytes per string;
//   3. arrays lose trailing elements and gain one "…[truncated N more]" element, only when that makes
//      them shorter, keeping at least one element while that can still fit;
//   4. strings are cut to the minimum (just the marker) if the line is still over;
//   5. last resort: only the protected scalars plus a marker, then `{ts, truncated}`, then a bare newline.
//
// Self-contained: imports only node: modules (the watchdog bundles it). The watchdog appends only
// its own `hatch` and `deny` lines, which carry no `raw` field and no command text, so nothing here
// redacts; the engine's lines (T26) are redacted before they reach formatLine.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

export const LINE_CAP = 4096;
export const TRUNCATED = '…[truncated]';
export const PROTECTED_KEYS = Object.freeze([
  'ts',
  'host',
  'session_id',
  'turn_id',
  'agent_id',
  'agent_type',
  'tool',
  'tool_use_id',
  'permission_mode',
  'profile',
  'decision',
  'rule',
  'scope',
  'engine_version',
  'policy_sha',
]);
const PROTECTED = new Set(PROTECTED_KEYS);
const FLOOR = 256; // bytes a string keeps before arrays are shortened
const MAX_PASSES = 40;

const byteLength = (s) => Buffer.byteLength(s, 'utf8');
const MARKER_COST = byteLength(JSON.stringify(TRUNCATED)); // the marker as a whole JSON string
const MIN_STRING = MARKER_COST; // a string cut to just the marker

// Bytes one code point takes inside a JSON string (JSON.stringify's escapes included).
function charCost(cp) {
  if (cp === 0x22 || cp === 0x5c || cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
  if (cp < 0x20) return 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate is written as \udXXX
  return cp < 0x10000 ? 3 : 4;
}

// Bytes of JSON.stringify(s).
function stringCost(s) {
  let n = 2;
  for (const ch of s) n += charCost(ch.codePointAt(0));
  return n;
}

// s cut to a JSON cost of at most `cost` bytes: a prefix and TRUNCATED. Needs cost >= MIN_STRING.
function cutString(s, cost) {
  const base = s.endsWith(TRUNCATED) ? s.slice(0, -TRUNCATED.length) : s;
  let room = cost - MARKER_COST;
  let end = 0;
  for (const ch of base) {
    const c = charCost(ch.codePointAt(0));
    if (c > room) break;
    room -= c;
    end += ch.length;
  }
  return base.slice(0, end) + TRUNCATED;
}

const isMore = (v) => typeof v === 'string' && v.startsWith('…[truncated ') && v !== TRUNCATED;

// Every cuttable string of the tree: {holder, key, cost}.
function collectStrings(root) {
  const out = [];
  const visit = (holder, key, top) => {
    const v = holder[key];
    if (typeof v === 'string') {
      if (top && PROTECTED.has(key)) return;
      if (isMore(v)) return;
      const cost = stringCost(v);
      if (cost > MIN_STRING) out.push({ holder, key, cost });
    } else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) visit(v, k, false);
    }
  };
  for (const k of Object.keys(root)) visit(root, k, true);
  return out;
}

// Cuts the longest strings to the largest common level that removes `need` bytes, but not below `floor`.
// Returns true when the level reached the need (the strings alone are enough).
function waterFill(strings, need, floor) {
  const sorted = strings.filter((x) => x.cost > floor).sort((a, b) => b.cost - a.cost);
  let sum = 0;
  let level = floor;
  let enough = false;
  for (let k = 1; k <= sorted.length; k++) {
    sum += sorted[k - 1].cost;
    const next = k < sorted.length ? sorted[k].cost : floor;
    const t = Math.floor((sum - need) / k);
    if (t >= Math.max(next, floor)) {
      level = t;
      enough = true;
      break;
    }
  }
  for (const x of sorted) {
    if (x.cost <= level) break;
    x.holder[x.key] = cutString(x.holder[x.key], level);
  }
  return enough;
}

const jsonSize = (v) => byteLength(JSON.stringify(v));

// Keeps the leading elements of every array (children first) whose size, with the marker, fits
// `ratio` of the array's current size; `minKeep` elements are kept regardless when they exist.
function shrinkArrays(node, ratio, minKeep) {
  if (node === null || typeof node !== 'object') return node;
  if (!Array.isArray(node)) {
    for (const k of Object.keys(node)) node[k] = shrinkArrays(node[k], ratio, minKeep);
    return node;
  }
  for (let i = 0; i < node.length; i++) node[i] = shrinkArrays(node[i], ratio, minKeep);
  const sizes = node.map(jsonSize);
  const total = 2 + sizes.reduce((a, b) => a + b, 0) + Math.max(0, node.length - 1);
  const budget = Math.floor(total * ratio);
  let used = 2;
  let keep = 0;
  while (keep < node.length) {
    const next = used + sizes[keep] + 1;
    const marker = byteLength(JSON.stringify(`…[truncated ${node.length - keep - 1} more]`));
    if (next + (keep + 1 < node.length ? marker : -1) > budget) break;
    used = next;
    keep++;
  }
  keep = Math.min(node.length, Math.max(keep, minKeep));
  if (keep >= node.length) return node;
  const marker = `…[truncated ${node.length - keep} more]`;
  const after = 2 + sizes.slice(0, keep).reduce((a, b) => a + b, 0) + keep + byteLength(JSON.stringify(marker));
  if (after >= total) return node;
  return [...node.slice(0, keep), marker];
}

// Sum of the sizes of the outermost arrays of the tree.
function arrayBytes(node) {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return jsonSize(node);
  return Object.values(node).reduce((a, v) => a + arrayBytes(v), 0);
}

function fallback(root, cap) {
  const kept = {};
  if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    for (const k of PROTECTED_KEYS) if (typeof root[k] === 'string') kept[k] = root[k];
  }
  for (const candidate of [{ ...kept, truncated: TRUNCATED }, { ts: typeof kept.ts === 'string' && kept.ts.length <= 64 ? kept.ts : undefined, truncated: TRUNCATED }, { truncated: TRUNCATED }]) {
    const text = `${JSON.stringify(candidate)}\n`;
    if (byteLength(text) <= cap) return text;
  }
  return '\n';
}

export function formatLine(entry, cap = LINE_CAP) {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : LINE_CAP;
  let root;
  try {
    root = JSON.parse(JSON.stringify(entry ?? null));
  } catch {
    return fallback(null, limit); // a cycle or a BigInt: nothing loggable but the marker
  }
  const text = () => `${JSON.stringify(root)}\n`;
  const over = () => byteLength(text()) - limit;
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return over() <= 0 ? text() : fallback(root, limit);
  if (over() <= 0) return text();

  // 2. strings, down to the floor; stop here when that is enough.
  waterFill(collectStrings(root), over(), FLOOR);
  if (over() > 0) {
    // 3. arrays, children first, keeping a shrinking share until the line fits.
    const total = arrayBytes(root);
    // The share of every array to keep: what the line can spare, a little below the estimate because
    // each shortened array also gains a marker. A pass that leaves the line over keeps a smaller share.
    let ratio = total > 0 ? Math.max(0, Math.min(0.9, ((total - over()) / total) * 0.9)) : 0;
    let minKeep = 1;
    for (let pass = 0; pass < MAX_PASSES && over() > 0; pass++) {
      shrinkArrays(root, ratio, minKeep);
      if (ratio === 0) minKeep = 0; // one element each was not enough: only the markers are left
      ratio = ratio * 0.6 < 0.01 ? 0 : ratio * 0.6;
    }
    // 4. strings, down to the marker alone.
    if (over() > 0) waterFill(collectStrings(root), over(), MIN_STRING);
  }
  return over() <= 0 ? text() : fallback(root, limit);
}

export function logFileFor(stateDir, ms) {
  const day = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10);
  return nodePath.join(stateDir, 'log', `${day}.jsonl`);
}

// A path that exists must be what we expect: a real directory (log/) or a regular file (the day file),
// never a symlink or anything else. A missing path is fine (it is created next).
function expectKind(fsImpl, target, kind) {
  let st;
  try {
    st = fsImpl.lstatSync(target);
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    return false;
  }
  if (st.isSymbolicLink()) return false;
  return kind === 'dir' ? st.isDirectory() : st.isFile();
}

export function appendLine(stateDir, entry, { now = Date.now, fs: fsImpl = nodeFs } = {}) {
  let fd = null;
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return false;
    const ms = typeof now === 'function' ? now() : Date.now();
    const file = logFileFor(stateDir, ms);
    const logDir = nodePath.dirname(file);
    fsImpl.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!expectKind(fsImpl, logDir, 'dir')) return false;
    fsImpl.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    if (!expectKind(fsImpl, logDir, 'dir') || !expectKind(fsImpl, file, 'file')) return false;
    const c = nodeFs.constants;
    // O_NOFOLLOW closes the window between the check and the open for the day file itself.
    fd = fsImpl.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW ?? 0), 0o600);
    fsImpl.fchmodSync(fd, 0o600);
    const text = formatLine({ ts: new Date(ms).toISOString(), ...entry });
    fsImpl.writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fd !== null) fsImpl.closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}
