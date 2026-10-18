// Glob matcher for fence policy paths.
//
// Dialect:
//   *      any run of characters inside one path segment
//   ?      exactly one character inside one path segment
//   **     as a whole segment: zero or more segments (so `a/**` also matches `a`);
//          inside a longer segment it behaves like `*`
//   [...]  a character class (never matches `/`); a leading `!` or `^` negates,
//          a `]` right after the opener is literal, `a-z` is a range
//   ~      the home directory, only as the whole first segment (`~` or `~/...`)
//   ${repo}, ${cwd}   placeholders; their values are always literal text
// There is no escape character; to match a metacharacter literally use a class (`[*]`).
// Matching is anchored to the whole path. Patterns are not normalised: a relative
// pattern is matched as written (callers pass absolute paths).
//
// Matching cost. Each pattern compiles to one anchored RegExp with no nested
// repetition. The only unbounded repeats are `[^/]*` (inside a segment) and `[\s\S]*`
// (a globstar), and every run of them that a later literal could make backtrack is
// wrapped in an emulated atomic group, `(?=(?<g>...))\k<g>`, taking the leftmost
// match of each chunk (the classic greedy glob algorithm, which is optimal). Cost
// stays near-linear in the path length for any number of stars.

import fs from 'node:fs';

import { PolicyError } from '../policy/errors.mjs';

const ANY = '[\\s\\S]';
const NOT_SLASH = '[^/]';
const AT_SEGMENT_END = '(?![^/])';

function fail(message) {
  throw new PolicyError('glob', message);
}

function checkVar(vars, name) {
  const v = vars?.[name];
  if (typeof v !== 'string' || v === '') fail(`placeholder ${name === 'home' ? '~' : '${' + name + '}'} has no value`);
  if (v.includes('\u0000')) fail(`placeholder value for ${name} contains NUL`);
  // A trailing slash would double up with the pattern's own separator.
  return v.replace(/\/+$/, '');
}

// Parses a `[...]` class starting at `start` (the index of `[`). Returns the token and
// the index of the closing `]`.
function parseClass(pattern, start) {
  let j = start + 1;
  let neg = false;
  if (pattern[j] === '!' || pattern[j] === '^') {
    neg = true;
    j++;
  }
  const bodyStart = j;
  if (pattern[j] === ']') j++;
  const close = pattern.indexOf(']', j);
  if (close === -1) fail(`unclosed "[" at index ${start} in ${JSON.stringify(pattern)}`);
  return { token: { t: 'class', neg, raw: pattern.slice(bodyStart, close) }, end: close };
}

// Splits a pattern into segments of tokens: {t:'lit',v} | {t:'star',n} | {t:'qm'} |
// {t:'class',neg,raw}. Placeholder values become literal tokens.
function parse(pattern, vars) {
  if (typeof pattern !== 'string') fail('glob must be a string');
  if (pattern === '') fail('glob must not be empty');
  if (pattern.includes('\u0000')) fail('glob must not contain NUL');
  if (vars === null || typeof vars !== 'object') fail('glob variables are required');

  const segments = [[]];
  const addLit = (s) => {
    const cur = segments[segments.length - 1];
    const last = cur[cur.length - 1];
    if (last && last.t === 'lit') last.v += s;
    else cur.push({ t: 'lit', v: s });
  };
  const addValue = (value) => {
    value.split('/').forEach((part, k) => {
      if (k > 0) segments.push([]);
      if (part !== '') addLit(part);
    });
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i === 0 && (pattern.length === 1 || pattern[1] === '/')) {
      addValue(checkVar(vars, 'home'));
    } else if (ch === '$' && pattern[i + 1] === '{') {
      const name = ['repo', 'cwd'].find((n) => pattern.startsWith('${' + n + '}', i));
      if (!name) fail(`unknown placeholder at index ${i} in ${JSON.stringify(pattern)} (allowed: ~, \${repo}, \${cwd})`);
      addValue(checkVar(vars, name));
      i += name.length + 2;
    } else if (ch === '*') {
      let n = 1;
      while (pattern[i + 1] === '*') {
        n++;
        i++;
      }
      segments[segments.length - 1].push({ t: 'star', n });
    } else if (ch === '?') {
      segments[segments.length - 1].push({ t: 'qm' });
    } else if (ch === '[') {
      const { token, end } = parseClass(pattern, i);
      segments[segments.length - 1].push(token);
      i = end;
    } else if (ch === '/') {
      segments.push([]);
    } else {
      addLit(ch);
    }
  }
  // A lone "/" value (for example home "/") expands to nothing; keep it meaning the root.
  if (segments.length === 1 && segments[0].length === 0) segments.push([]);
  return segments;
}

const isGlobstar = (seg) => seg.length === 1 && seg[0].t === 'star' && seg[0].n >= 2;
const isLiteralSegment = (seg) => seg.every((t) => t.t === 'lit');

function escapeLit(s) {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

function escapeClassChar(c) {
  return /[\\\]^[-]/.test(c) ? `\\${c}` : c;
}

function classSource(token) {
  const chars = Array.from(token.raw);
  let body = '';
  for (let i = 0; i < chars.length; i++) {
    const lo = chars[i];
    if (chars[i + 1] === '-' && i + 2 < chars.length) {
      const hi = chars[i + 2];
      if (lo.codePointAt(0) > hi.codePointAt(0)) fail(`reversed range "${lo}-${hi}" in class "[${token.raw}]"`);
      body += `${escapeClassChar(lo)}-${escapeClassChar(hi)}`;
      i += 2;
    } else {
      body += escapeClassChar(lo);
    }
  }
  // A class never matches the separator, whether listed, ranged or negated.
  return `(?!/)[${token.neg ? '^' : ''}${body}]`;
}

function pieceSource(tokens) {
  return tokens
    .map((t) => (t.t === 'lit' ? escapeLit(t.v) : t.t === 'qm' ? NOT_SLASH : classSource(t)))
    .join('');
}

let groupCounter = 0;
function atomic(source) {
  const name = `g${groupCounter++}`;
  return `(?=(?<${name}>${source}))\\k<${name}>`;
}

// A segment with stars is P0 * P1 * ... * Pk. P0 is anchored, the middle pieces take
// their leftmost match, and Pk is matched against the end of the segment.
function segmentSource(seg) {
  const pieces = [[]];
  for (const t of seg) {
    if (t.t === 'star') pieces.push([]);
    else pieces[pieces.length - 1].push(t);
  }
  if (pieces.length === 1) return pieceSource(pieces[0]);
  let out = pieceSource(pieces[0]);
  for (let k = 1; k < pieces.length - 1; k++) out += atomic(`${NOT_SLASH}*?${pieceSource(pieces[k])}`);
  return `${out}${NOT_SLASH}*${pieceSource(pieces[pieces.length - 1])}`;
}

const chunkSource = (segs) => segs.map(segmentSource).join('/');

function toRegExp(segments) {
  // Collapse runs of globstars, then split into chunks of plain segments between them.
  const items = [];
  for (const seg of segments) {
    if (isGlobstar(seg)) {
      if (!items.length || items[items.length - 1] !== null) items.push(null);
    } else {
      items.push(seg);
    }
  }
  const leadG = items[0] === null;
  const trailG = items[items.length - 1] === null;
  const chunks = [];
  let open = false;
  for (const it of items) {
    if (it === null) {
      open = false;
    } else if (open) {
      chunks[chunks.length - 1].push(it);
    } else {
      chunks.push([it]);
      open = true;
    }
  }
  if (chunks.length === 0) return new RegExp(`^${ANY}*$`, 'u');

  let out = '^';
  chunks.forEach((chunk, ci) => {
    const first = ci === 0;
    const last = ci === chunks.length - 1;
    const src = chunkSource(chunk);
    if (first && !leadG) {
      out += src;
      return;
    }
    if (!first) out += '/';
    if (last && !trailG) out += `(?:${ANY}*/)?${src}`;
    else out += atomic(`(?:${ANY}*?/)??${src}${AT_SEGMENT_END}`);
  });
  out += trailG ? `(?:/${ANY}*)?$` : '$';
  return new RegExp(out, 'u');
}

export function compileGlob(pattern, vars) {
  return toRegExp(parse(pattern, vars));
}

export function matchGlob(pattern, absPath, vars) {
  const re = compileGlob(pattern, vars);
  if (typeof absPath !== 'string' || absPath.includes('\u0000')) return false;
  return re.test(absPath);
}

// Serialisation back to glob text. Literal text that would be read as syntax is
// wrapped in a one-character class, so the result recompiles to the same matcher.
function escapeLitForGlob(s) {
  return s.replace(/[*?[$~]/g, (c) => `[${c}]`);
}

function serializeSegment(seg) {
  return seg
    .map((t) => {
      if (t.t === 'lit') return escapeLitForGlob(t.v);
      if (t.t === 'star') return '*'.repeat(t.n);
      if (t.t === 'qm') return '?';
      return `[${t.neg ? '!' : ''}${t.raw}]`;
    })
    .join('');
}

// Resolves the literal prefix of a pattern (its leading segments up to the first one
// holding a wildcard) with `realpath`, existing components only: the longest prefix
// that resolves is replaced by its real path and the rest is appended unchanged. A
// relative pattern, or one whose prefix does not resolve at all, comes back expanded
// but otherwise as written.
export function resolveGlobPrefix(pattern, vars, realpath = fs.realpathSync.native) {
  const segments = parse(pattern, vars);
  let k = 0;
  while (k < segments.length && isLiteralSegment(segments[k])) k++;
  const tail = segments.slice(k).map(serializeSegment);
  const asWritten = () => segments.map(serializeSegment).join('/') || '/';

  const absolute = segments.length > 1 && segments[0].length === 0;
  if (!absolute || k === 0) return asWritten();

  const parts = segments.slice(0, k).map((seg) => (seg.length ? seg[0].v : ''));
  // Keep a trailing slash of a fully literal pattern out of the lookup.
  const keepTrailingSlash = k === segments.length && parts.length > 1 && parts[parts.length - 1] === '';
  if (keepTrailingSlash) parts.pop();

  let i = parts.length;
  let real = null;
  for (; i >= 1; i--) {
    try {
      real = realpath(parts.slice(0, i).join('/') || '/');
      break;
    } catch {
      // not resolvable: try the parent
    }
  }
  if (real === null || typeof real !== 'string') return asWritten();

  const realParts = real === '/' ? [''] : real.split('/');
  const out = [...realParts.map(escapeLitForGlob), ...parts.slice(i).map(escapeLitForGlob)];
  if (keepTrailingSlash) out.push('');
  out.push(...tail);
  return out.join('/') || '/';
}
