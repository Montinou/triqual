// Path resolver: turns a path an agent named into the absolute, realpath-resolved path the
// self-protection checks and the evaluator compare.
//
//   resolvePath(p, cwd, home, fs?)   absolute path, or UNKNOWN when it cannot be determined
//   isCaseInsensitive(dir, fs?)      whether the volume holding dir folds case (fails closed: true)
//   foldCase(path, caseInsensitive)  NFC + full case fold, only on a case-insensitive volume
//
// Rules (spec, Normalizer, "Paths and repositories"):
// - Relative paths resolve from the given cwd, never process.cwd(). Only `~` and `~/…` expand
//   (from `home`); any other `~…` form is UNKNOWN.
// - Existing components resolve with fs.realpathSync.native, one component at a time, so `..`
//   is applied to the realpath of what precedes it (`a/link/../b` follows link first).
// - For a missing target the deepest existing parent is resolved and the rest appended. A
//   dangling symlink is followed to where it points: symlinks are never skipped.
// - `..` after a missing component is collapsed and the result resolved again, so a link reached
//   that way is still followed.
// - Bad input (non-string, empty, NUL), symlink loops and any error other than "does not exist"
//   (EACCES, ELOOP, ENAMETOOLONG, …) give UNKNOWN. Nothing here throws.
//
// `..` follows links (physical semantics, as the kernel and `cd -P` do), NOT the shell's logical
// `cd` semantics where `cd link/..` returns to the directory holding `link`. Callers that track an
// in-command `cd` must apply the shell's own `..` handling to the logical cwd themselves and must
// not use resolvePath for that; resolvePath is for the file a path finally names.

import fs from 'node:fs';

import { UNKNOWN } from '../norm/unknown.mjs';

// Bound on the links and re-resolutions followed for one path (the kernel's own limit is 32-40).
const MAX_DEPTH = 40;
// Errors that mean "this component does not exist".
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

const validString = (s) => typeof s === 'string' && s.length > 0 && !s.includes('\0');
const isAbsolute = (s) => s.startsWith('/');
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (dir) => {
  const i = dir.lastIndexOf('/');
  return i <= 0 ? '/' : dir.slice(0, i);
};

export function resolvePath(p, cwd, home, fsImpl = fs) {
  try {
    if (!validString(p) || !validString(cwd) || !isAbsolute(cwd)) return UNKNOWN;
    let abs;
    if (p.startsWith('~')) {
      if (p !== '~' && !p.startsWith('~/')) return UNKNOWN;
      if (!validString(home) || !isAbsolute(home)) return UNKNOWN;
      abs = `${home}/${p.slice(1)}`;
    } else if (isAbsolute(p)) {
      abs = p;
    } else {
      abs = `${cwd}/${p}`;
    }
    return walk(abs, fsImpl, 0);
  } catch {
    return UNKNOWN;
  }
}

function walk(abs, fsImpl, depth) {
  if (depth > MAX_DEPTH) return UNKNOWN;
  const segs = abs.split('/').filter((s) => s !== '' && s !== '.');
  let resolved = '/';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '..') {
      // `resolved` is a realpath, so its parent is one too.
      resolved = parentOf(resolved);
      continue;
    }
    const candidate = join(resolved, seg);
    let real;
    try {
      real = fsImpl.realpathSync.native(candidate);
    } catch (err) {
      if (!MISSING.has(err?.code)) return UNKNOWN;
      return missing(resolved, candidate, segs.slice(i), fsImpl, depth);
    }
    if (!validString(real) || !isAbsolute(real)) return UNKNOWN;
    resolved = real;
  }
  return resolved;
}

// `candidate` (= resolved + tail[0]) could not be realpath-resolved because something is missing.
function missing(resolved, candidate, tail, fsImpl, depth) {
  let st = null;
  try {
    st = fsImpl.lstatSync(candidate);
  } catch (err) {
    if (!MISSING.has(err?.code)) return UNKNOWN;
  }
  if (st) {
    // It exists but its realpath does not: a dangling symlink. Follow it.
    if (!st.isSymbolicLink()) return UNKNOWN;
    const target = fsImpl.readlinkSync(candidate);
    if (!validString(target)) return UNKNOWN;
    const base = isAbsolute(target) ? target : `${resolved}/${target}`;
    return walk([base, ...tail.slice(1)].join('/'), fsImpl, depth + 1);
  }
  // Genuinely missing: append the rest lexically.
  const out = [];
  let base = resolved;
  let collapsed = false;
  for (const seg of tail) {
    if (seg === '..') {
      collapsed = true;
      if (out.length) out.pop();
      else base = parentOf(base);
    } else {
      out.push(seg);
    }
  }
  const result = out.reduce(join, base);
  // `..` dropped a missing component, so what remains may name existing links again.
  return collapsed ? walk(result, fsImpl, depth + 1) : result;
}

// ---- Case sensitivity ---------------------------------------------------------------------------

// Per fs implementation, per device id: the verdict of a conclusive probe.
const CASE_CACHE = new WeakMap();

const hasAsciiLetter = (name) => /[A-Za-z]/.test(name);
const flipAscii = (name) =>
  name.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));

export function isCaseInsensitive(dir, fsImpl = fs) {
  try {
    if (!validString(dir) || !isAbsolute(dir)) return true;
    const st = fsImpl.statSync(dir);
    let cache = CASE_CACHE.get(fsImpl);
    if (!cache) {
      cache = new Map();
      CASE_CACHE.set(fsImpl, cache);
    }
    const key = String(st.dev);
    if (cache.has(key)) return cache.get(key);
    const verdict = probeVolume(dir, st, fsImpl);
    if (verdict === null) return true; // inconclusive: folding more is the safe direction
    cache.set(key, verdict);
    return verdict;
  } catch {
    return true;
  }
}

// true / false when a probe was conclusive, null otherwise.
function probeVolume(dir, st, fsImpl) {
  // The directory itself or an ancestor whose name has a letter, flipped inside its parent. The
  // parent must be on the volume being probed: a mount point or a symlink to another volume puts
  // its parent on a different file system, which would answer for the wrong device. Stop there.
  let cur = dir.replace(/\/+$/, '') || '/';
  let curSt = st;
  while (cur !== '/') {
    const parent = parentOf(cur);
    const parentSt = fsImpl.statSync(parent);
    if (parentSt.dev !== st.dev || curSt.dev !== st.dev) break;
    const name = cur.slice(cur.lastIndexOf('/') + 1);
    if (hasAsciiLetter(name)) return probeOne(curSt, join(parent, flipAscii(name)), fsImpl);
    cur = parent;
    curSt = parentSt;
  }
  // Otherwise a child entry on the same volume.
  for (const name of fsImpl.readdirSync(dir)) {
    if (typeof name !== 'string' || !hasAsciiLetter(name)) continue;
    const childSt = fsImpl.statSync(join(dir, name));
    if (childSt.dev !== st.dev) continue;
    return probeOne(childSt, join(dir, flipAscii(name)), fsImpl);
  }
  return null;
}

function probeOne(origSt, flipped, fsImpl) {
  let flippedSt;
  try {
    flippedSt = fsImpl.statSync(flipped);
  } catch (err) {
    return MISSING.has(err?.code) ? false : null;
  }
  return flippedSt.dev === origSt.dev && flippedSt.ino === origSt.ino;
}

// A case-insensitive volume (APFS, HFS+) applies full Unicode case folding, not just lower case:
// U+017F (long s) opens `s`, U+FB00 (ff ligature) opens `ff`, U+212A (Kelvin sign) opens `k`.
// Upper-casing first expands those (ſ→S, ﬀ→FF, ß→SS) and lower-casing then folds the result;
// NFC on both sides makes the volume's normalization insensitivity match too. builtin.mjs imports
// this function so both always fold alike.
export function foldCase(path, caseInsensitive) {
  if (typeof path !== 'string') return path;
  if (!caseInsensitive) return path;
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}
