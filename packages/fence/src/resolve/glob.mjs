// Capped glob expansion for the normalizer ("Values": globs expand against the filesystem from the
// payload's cwd, capped at 1000 matches and 50 ms; past either cap the word is UNKNOWN).
//
//   expandGlob(pattern, cwd, {maxMatches=1000, maxMs=50, fs, now}) -> string[] | UNKNOWN
//
// The pattern is the one values.mjs builds: active glob characters raw, every literal `\ * ? [ ]`
// backslash-escaped (an escaped `\*` is a literal star). The host shell is zsh; the rules below
// are the common subset of zsh and bash defaults, and anything where they differ is UNKNOWN:
//
// - `*` and `?` never cross `/`. A name starting with `.` matches only a segment whose first
//   character is a literal dot. A segment that would also match `.` or `..` (`.*`) is UNKNOWN
//   (the shells disagree on whether they are listed).
// - `[...]` classes with `!`/`^` negation; ranges only between two digits, two lower-case or two
//   upper-case ASCII letters (other ranges are locale-dependent); POSIX classes `[[:x:]]`, an
//   unterminated `[` and an unescaped `~ ^ # ( ) | < >` outside a class (zsh extended glob, glob
//   qualifiers, alternation) are UNKNOWN, with or without a wildcard; a non-ASCII character inside a
//   class is UNKNOWN (locale-dependent in bash). No brace expansion (the parser makes braces opaque).
// - A segment that is exactly `**` and is followed by `/` recurses (zsh default) through
//   directories, never through symlinks and never into hidden directories; `**/` matches zero or
//   more directories. `***/` (follows symlinks), a trailing `**/` and two recursive segments are
//   UNKNOWN. Any other run of stars is a plain `*`. (bash without globstar reads `**` as `*`:
//   callers that run the command under bash must not trust a recursive pattern.)
// - Results are sorted in byte order (the shells may collate differently, which only affects unroll
//   order) and keep the form of the pattern (relative pattern, relative
//   results). A pattern without a wildcard returns [its unescaped text] without touching the disk;
//   a pattern with no match is UNKNOWN (the shells disagree on what it expands to).
// - Directories are read with fs.readdirSync(withFileTypes) only. A symlink at a directory
//   position is followed (as the shells do); a read error of any kind (EACCES, ENOENT, ENOTDIR…)
//   anywhere is UNKNOWN. The caps are checked with the injected clock per directory read and per
//   directory entry; more than maxMatches matches, or more than maxMs elapsed, is UNKNOWN.
//
// Nothing here throws; any unexpected condition is UNKNOWN.

import nodeFs from 'node:fs';

import { UNKNOWN } from '../norm/unknown.mjs';

const MAX_PATTERN = 4096;
// Characters that make zsh read a pattern as something this module does not model.
const ZSH_SPECIAL = new Set(['~', '^', '#', '(', ')', '|', '<', '>']);

const CAP = Symbol('cap');

// -- pattern parsing --------------------------------------------------------

// The pattern as items {c, esc}; null on a dangling backslash or NUL.
function items(pattern) {
  const out = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\0') return null;
    if (c === '\\') {
      if (i + 1 >= pattern.length) return null;
      out.push({ c: pattern[++i], esc: true });
    } else {
      out.push({ c, esc: false });
    }
  }
  return out;
}

const kindOf = (ch) => {
  if (ch >= '0' && ch <= '9') return 'd';
  if (ch >= 'a' && ch <= 'z') return 'l';
  if (ch >= 'A' && ch <= 'Z') return 'u';
  return null;
};

// Parse a class starting just after `[` at seg[i]; returns {tok, next} or null.
function parseClass(seg, i) {
  let neg = false;
  if (i < seg.length && !seg[i].esc && (seg[i].c === '!' || seg[i].c === '^')) {
    neg = true;
    i++;
  }
  const chars = new Set();
  const ranges = [];
  let first = true;
  for (;;) {
    if (i >= seg.length) return null; // unterminated
    const it = seg[i];
    if (!it.esc && it.c === ']' && !first) return { tok: { t: 'cls', neg, chars, ranges }, next: i + 1 };
    first = false;
    if (!it.esc && it.c === '[' && i + 1 < seg.length && !seg[i + 1].esc && ':.='.includes(seg[i + 1].c)) return null;
    // a non-ASCII member: the pattern is read by UTF-16 unit here but names by whole character,
    // and bash's class matching is locale-dependent for it
    if (it.c.charCodeAt(0) > 127) return null;
    const lo = it.c;
    // range: member - member
    if (i + 2 < seg.length && !seg[i + 1].esc && seg[i + 1].c === '-' && !(!seg[i + 2].esc && seg[i + 2].c === ']')) {
      const hi = seg[i + 2].c;
      if (hi.charCodeAt(0) > 127) return null;
      const kl = kindOf(lo);
      if (kl === null || kl !== kindOf(hi) || lo > hi) return null;
      ranges.push([lo, hi]);
      i += 3;
      continue;
    }
    chars.add(lo);
    i++;
  }
}

// One segment's items -> {toks, wild, leadingDot, stars} or null (UNKNOWN).
function parseSegment(seg) {
  const toks = [];
  let wild = false;
  let stars = 0; // length of the star run if the whole segment is stars, else 0
  let onlyStars = seg.length > 0;
  for (let i = 0; i < seg.length; i++) {
    const it = seg[i];
    if (it.esc) {
      toks.push({ t: 'c', ch: it.c });
      onlyStars = false;
    } else if (it.c === '*') {
      wild = true;
      if (!(toks.length && toks[toks.length - 1].t === 'star')) toks.push({ t: 'star' });
    } else if (it.c === '?') {
      wild = true;
      onlyStars = false;
      toks.push({ t: 'any' });
    } else if (it.c === '[') {
      const r = parseClass(seg, i + 1);
      if (!r) return null;
      wild = true;
      onlyStars = false;
      toks.push(r.tok);
      i = r.next - 1;
    } else if (ZSH_SPECIAL.has(it.c)) {
      return null;
    } else {
      toks.push({ t: 'c', ch: it.c });
      onlyStars = false;
    }
  }
  if (onlyStars) stars = seg.length;
  const leadingDot = toks.length > 0 && toks[0].t === 'c' && toks[0].ch === '.';
  const text = wild ? null : toks.map((x) => x.ch).join('');
  return { toks, wild, leadingDot, stars, text };
}

// -- matching ---------------------------------------------------------------

function single(tok, ch) {
  if (tok.t === 'any') return true;
  if (tok.t === 'c') return tok.ch === ch;
  let inside = tok.chars.has(ch);
  if (!inside) for (const [lo, hi] of tok.ranges) if (ch >= lo && ch <= hi) inside = true;
  return tok.neg ? !inside : inside;
}

// Greedy wildcard match with single-star backtracking: O(name * pattern), no nesting.
function matchName(toks, name) {
  const n = Array.from(name);
  let ti = 0;
  let ni = 0;
  let starTi = -1;
  let starNi = 0;
  while (ni < n.length) {
    if (ti < toks.length && toks[ti].t === 'star') {
      starTi = ti++;
      starNi = ni;
    } else if (ti < toks.length && single(toks[ti], n[ni])) {
      ti++;
      ni++;
    } else if (starTi >= 0) {
      ti = starTi + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  while (ti < toks.length && toks[ti].t === 'star') ti++;
  return ti === toks.length;
}

// -- expansion --------------------------------------------------------------

const joinOut = (out, name) => (out === '' ? name : out === '/' ? `/${name}` : `${out}/${name}`);
const foldName = (s) => s.normalize('NFC').toLowerCase();
const byteCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Never a directory: no need to descend.
const isLeaf = (d) => d.isFile() || d.isFIFO() || d.isSocket() || d.isCharacterDevice() || d.isBlockDevice();

export function expandGlob(pattern, cwd, opts = {}) {
  try {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN) return UNKNOWN;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) return UNKNOWN;
    const o = opts && typeof opts === 'object' ? opts : {};
    const { maxMatches = 1000, maxMs = 50, fs = nodeFs, now = () => performance.now() } = o;
    if (!Number.isFinite(maxMatches) || maxMatches < 0 || !Number.isFinite(maxMs) || maxMs < 0) return UNKNOWN;
    if (typeof now !== 'function' || !fs || typeof fs.readdirSync !== 'function') return UNKNOWN;

    const its = items(pattern);
    if (!its) return UNKNOWN;

    // no wildcard (after unescaping): the literal, without touching the disk, unless zsh reads it
    // as a pattern by default (`<1-5>`, `(a|b)`); with a wildcard, parseSegment checks per segment
    // (a class may hold these characters)
    if (!its.some((it) => !it.esc && (it.c === '*' || it.c === '?' || it.c === '['))) {
      if (its.some((it) => !it.esc && ZSH_SPECIAL.has(it.c))) return UNKNOWN;
      return [its.map((it) => it.c).join('')];
    }

    // split into segments on `/`
    const raw = [[]];
    for (const it of its) {
      if (it.c === '/') raw.push([]);
      else raw[raw.length - 1].push(it);
    }
    const absolute = raw[0].length === 0;
    if (absolute) {
      raw.shift();
      if (raw.length && raw[0].length === 0) return UNKNOWN; // `//…`
    }
    const dirOnly = raw.length > 1 && raw[raw.length - 1].length === 0;
    if (dirOnly) raw.pop();
    if (raw.length === 0 || raw.some((s) => s.length === 0)) return UNKNOWN; // `a//b`

    const segs = [];
    let recursive = 0;
    for (let k = 0; k < raw.length; k++) {
      const s = parseSegment(raw[k]);
      if (!s) return UNKNOWN;
      const followedBySlash = k < raw.length - 1 || dirOnly;
      if (s.stars >= 2 && followedBySlash) {
        if (s.stars !== 2) return UNKNOWN; // `***/` follows symlinks; longer runs are unclear
        if (k === raw.length - 1) return UNKNOWN; // nothing after `**/`
        s.recursive = true;
        if (++recursive > 1) return UNKNOWN;
      }
      if (s.wild && !s.recursive && s.leadingDot && (matchName(s.toks, '.') || matchName(s.toks, '..'))) {
        return UNKNOWN;
      }
      segs.push(s);
    }

    const start = now();
    if (typeof start !== 'number' || Number.isNaN(start)) return UNKNOWN;
    const tick = () => {
      const t = now();
      if (typeof t !== 'number' || Number.isNaN(t) || t - start > maxMs) throw CAP;
    };
    const fsPath = (out) => (out === '' ? cwd : out.startsWith('/') ? out : cwd === '/' ? `/${out}` : `${cwd}/${out}`);
    const list = (out) => {
      tick();
      const ents = fs.readdirSync(fsPath(out), { withFileTypes: true });
      tick();
      if (!Array.isArray(ents)) throw new Error('readdir');
      return ents;
    };

    const matches = [];
    const add = (m) => {
      matches.push(m);
      if (matches.length > maxMatches) throw CAP;
    };
    const check = (name) => {
      tick();
      if (typeof name !== 'string' || name.includes('�')) throw new Error('name');
    };

    const stack = [{ out: absolute ? '/' : '', idx: 0, viaWild: false, link: false }];
    while (stack.length) {
      const { out, idx, viaWild, link } = stack.pop();
      const seg = segs[idx];
      const last = idx === segs.length - 1;

      if (seg.recursive) {
        // the remainder applies to this directory and every directory below it
        stack.push({ out, idx: idx + 1, viaWild: true, link });
        for (const d of list(out)) {
          check(d.name);
          if (d.name.startsWith('.')) continue;
          if (d.isDirectory()) stack.push({ out: joinOut(out, d.name), idx, viaWild: true, link: false });
          else if (d.isSymbolicLink() || isLeaf(d)) continue;
          else throw new Error('unknown dirent type');
        }
        continue;
      }

      if (!seg.wild) {
        const here = joinOut(out, seg.text);
        if (!last && !viaWild) {
          // still in the literal prefix: the next read reports a missing directory
          stack.push({ out: here, idx: idx + 1, viaWild, link });
          continue;
        }
        // a literal segment below a wildcard: it may be absent, so look it up in the listing
        if (seg.text === '.' || seg.text === '..') {
          // `lnk/..` is an error in the shell when lnk is a link to a non-directory
          if (link) throw new Error('. or .. under a link');
          if (last) add(dirOnly ? `${here}/` : here);
          else stack.push({ out: here, idx: idx + 1, viaWild, link });
          continue;
        }
        let found = null;
        for (const d of list(out)) {
          check(d.name);
          if (d.name === seg.text) found = d;
          else if (foldName(d.name) === foldName(seg.text)) throw new Error('case-folded name');
        }
        if (!found) continue;
        if (!last) {
          if (!isLeaf(found)) stack.push({ out: here, idx: idx + 1, viaWild, link: !found.isDirectory() });
          continue;
        }
        if (dirOnly) {
          if (found.isDirectory()) add(`${here}/`);
          else if (!isLeaf(found)) throw new Error('trailing slash on a link');
        } else {
          add(here);
        }
        continue;
      }

      for (const d of list(out)) {
        check(d.name);
        if (d.name.startsWith('.') && !seg.leadingDot) continue;
        if (!matchName(seg.toks, d.name)) continue;
        const here = joinOut(out, d.name);
        if (last) {
          if (dirOnly) {
            if (d.isDirectory()) add(`${here}/`);
            else if (!isLeaf(d)) throw new Error('trailing slash on a link');
          } else {
            add(here);
          }
        } else if (!isLeaf(d)) {
          stack.push({ out: here, idx: idx + 1, viaWild: true, link: !d.isDirectory() });
        }
      }
    }

    if (matches.length === 0) return UNKNOWN;
    return Array.from(new Set(matches)).sort(byteCompare);
  } catch {
    return UNKNOWN;
  }
}
