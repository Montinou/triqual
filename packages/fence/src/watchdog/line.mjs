// Log line shape (spec, "Decision log"): one JSON object per line, capped at 4 KiB so an O_APPEND
// write stays atomic. Oversized string fields are cut, longest first, and end with TRUNCATED.
//
//   formatLine(entry, cap = 4096) -> string     (ends with "\n", at most `cap` UTF-8 bytes)
//   logFileFor(stateDir, ms) -> <stateDir>/log/YYYY-MM-DD.jsonl   (UTC date)
//   appendLine(stateDir, entry, {now, fs}) -> boolean   (best effort, never throws)
//
// Self-contained: imports only node: modules (the watchdog bundles it). The watchdog appends only
// its own `hatch` and `deny` lines, which carry no `raw` field and no command text, so nothing here
// redacts; the engine's lines (T26) are redacted before they reach formatLine.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

export const LINE_CAP = 4096;
export const TRUNCATED = '…[truncated]';
const MARKER_BYTES = Buffer.byteLength(TRUNCATED, 'utf8');
const MAX_ROUNDS = 10000;

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

// The longest string value (by code points) in a JSON tree that can still be shortened.
function longestString(node) {
  let best = null;
  const visit = (holder, key) => {
    const v = holder[key];
    if (typeof v === 'string') {
      if (v !== TRUNCATED && (best === null || v.length > best.value.length)) best = { holder, key, value: v };
    } else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) visit(v, k);
    }
  };
  visit(node, 'root');
  return best;
}

function fallback(value, cap) {
  const ts = value !== null && typeof value === 'object' && typeof value.ts === 'string' && value.ts.length <= 64 ? value.ts : undefined;
  const text = `${JSON.stringify({ ts, truncated: TRUNCATED })}\n`;
  return byteLength(text) <= cap ? text : '\n';
}

export function formatLine(entry, cap = LINE_CAP) {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : LINE_CAP;
  let box;
  try {
    box = { root: JSON.parse(JSON.stringify(entry ?? null)) };
  } catch {
    return fallback(null, limit); // a cycle or a BigInt: nothing loggable but the marker
  }
  let text = `${JSON.stringify(box.root)}\n`;
  for (let round = 0; byteLength(text) > limit && round < MAX_ROUNDS; round++) {
    const target = longestString(box);
    if (target === null) break;
    const base = target.value.endsWith(TRUNCATED) ? target.value.slice(0, -TRUNCATED.length) : target.value;
    const chars = Array.from(base);
    // Each removed code point saves at least one byte; the marker costs MARKER_BYTES.
    const keep = Math.max(0, chars.length - (byteLength(text) - limit) - MARKER_BYTES);
    target.holder[target.key] = chars.slice(0, keep).join('') + TRUNCATED;
    text = `${JSON.stringify(box.root)}\n`;
  }
  return byteLength(text) <= limit ? text : fallback(box.root, limit);
}

export function logFileFor(stateDir, ms) {
  const day = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10);
  return nodePath.join(stateDir, 'log', `${day}.jsonl`);
}

export function appendLine(stateDir, entry, { now = Date.now, fs: fsImpl = nodeFs } = {}) {
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return false;
    const ms = typeof now === 'function' ? now() : Date.now();
    const file = logFileFor(stateDir, ms);
    fsImpl.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    fsImpl.appendFileSync(file, formatLine({ ts: new Date(ms).toISOString(), ...entry }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
