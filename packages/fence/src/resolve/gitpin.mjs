// The git binary pinned at install (T34 writes `<shareDir>/git.json` as {path, version}).
//
//   readGitPin(shareDir, fs?) -> {path, version, deadlineMs?} | null
//
// deadlineMs (optional, 1..MAX_PIN_DEADLINE_MS) is the bounded check's time limit for this pin;
// without it the check keeps its default.
//
// null when the file is missing, unreadable, not strict JSON, or does not carry an absolute `path`
// and a string `version`. The pin is returned as written, old versions included: the engine binds
// it into gitTreeDiff (bindGitTreeDiff), which answers UNKNOWN for a git older than 2.45.1, and a
// missing pin leaves the check unbound (UNKNOWN too). Either way a git tree update in a repository
// that tracks `.claude/` or `.codex/` comes out opaque. Never throws.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

const MAX_PIN_BYTES = 64 * 1024;
/** The longest time limit a pin may give the bounded git check. */
export const MAX_PIN_DEADLINE_MS = 30000;

const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');

export function readGitPin(shareDir, fsImpl = nodeFs) {
  try {
    if (!isAbs(shareDir)) return null;
    const file = nodePath.join(shareDir, 'git.json');
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > MAX_PIN_BYTES) return null;
    const v = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    if (!isAbs(v.path) || typeof v.version !== 'string' || v.version === '') return null;
    const pin = { path: v.path, version: v.version };
    if (Number.isInteger(v.deadlineMs) && v.deadlineMs > 0 && v.deadlineMs <= MAX_PIN_DEADLINE_MS) pin.deadlineMs = v.deadlineMs;
    return pin;
  } catch {
    return null;
  }
}
