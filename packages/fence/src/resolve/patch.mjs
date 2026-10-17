// Target paths of a patch file (spec, "Built-in self-protection": `patch` and `git apply`/`am`
// targets are read from the patch file and judged as writes; an unreadable patch is opaque).
//
//   patchTargets(file, fs, opts?)        -> string[] | UNKNOWN   (reads file, at most MAX_PATCH_BYTES)
//   patchTargetsFromText(text, opts?)    -> string[] | UNKNOWN   (a literal feed: heredoc, herestring)
//
// opts.strip: a number N strips N leading path components (patch -p N, git apply -p N); undefined
// strips a leading `a/` or `b/` only; 'patch-default' (GNU patch with no -p) gives every reading
// patch could take: the name as written, without `a/`/`b/`, and its basename.
//
// Names come from: `diff --git a/X b/Y`, `--- X` / `+++ Y` (a tab, or a space and a
// `YYYY-MM-DD HH:MM:SS` timestamp, ends the name; /dev/null names nothing), context-diff `*** X`, `Index: X`, `rename from|to`, `copy from|to`.
// Both sides count: the old side of a rename or a deletion is removed, which is a write too. Hunk
// bodies are skipped by their line counts (`@@ -a,b +c,d @@`), so a removed line that reads
// `--- x` names no file. A C-quoted name (`"a/\303\244"`) is unquoted; a malformed one, a text
// over the size cap, more than MAX_TARGETS names, or a patch with no name at all (a bare binary
// patch, an ed-style diff) is UNKNOWN. Results keep first-seen order, deduplicated. Linear in the
// text length; never throws.

import { UNKNOWN } from '../norm/unknown.mjs';

export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_TARGETS = 1000;

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const CONTEXT_RANGE = /^(?:\*\*\* \d+(?:,\d+)? \*\*\*\*|--- \d+(?:,\d+)? ----)\s*$/;
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
// A diff timestamp after a name: ` YYYY-MM-DD HH:MM:SS` (GNU diff -u; fractions and zone follow).
const ISO_STAMP = / [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/;
// The most ` b/` splits of one `diff --git` line read (a crafted line may hold many).
const MAX_GIT_SPLITS = 16;

class Bad extends Error {}

// A C-quoted git name (without its quotes) as text; throws Bad on a malformed escape.
function unquote(body) {
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n !== undefined && Object.hasOwn(ESCAPES, n)) bytes.push(ESCAPES[n]);
    else if (/^[0-3][0-7][0-7]$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else throw new Bad('escape');
  }
  return Buffer.from(bytes).toString('utf8');
}

// The names a header line carries after its keyword: a quoted name; else the text up to a tab,
// or up to a space followed by a timestamp. A name with a space and neither is ambiguous (a
// file name with a space, or a trailer in another format): both the whole text and the part
// before the first space are reported (more targets, never fewer). An unterminated quote or a
// bad escape is unparsable (Bad: the patch is UNKNOWN).
function headerNames(rest) {
  const s = rest.replace(/\r$/, '');
  if (s.startsWith('"')) {
    const end = closingQuote(s);
    if (end < 0) throw new Bad('quote');
    return [unquote(s.slice(1, end))];
  }
  const tab = s.indexOf('\t');
  if (tab >= 0) return [s.slice(0, tab).trimEnd()];
  // the stamp ends the name; the whole text is reported too (a name may itself hold such text)
  const m = ISO_STAMP.exec(s);
  if (m) return [s.slice(0, m.index).trimEnd(), s.trimEnd()];
  const name = s.trimEnd();
  const sp = name.indexOf(' ');
  return sp > 0 ? [name, name.slice(0, sp)] : [name];
}

function closingQuote(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

// `diff --git a/X b/Y`: both names. A same-name header splits exactly; otherwise the line is read
// at every ` b/` (up to MAX_GIT_SPLITS, past it UNKNOWN), since X may itself contain ` b/`
// (renames also carry `rename from/to` lines, which name the files exactly).
function gitHeaderNames(rest) {
  const s = rest.replace(/\r$/, '');
  if (s.startsWith('"')) {
    const end = closingQuote(s);
    if (end < 0) throw new Bad('quote');
    const first = unquote(s.slice(1, end));
    return [first, ...headerNames(s.slice(end + 1).trimStart())];
  }
  if ((s.length - 1) % 2 === 0) {
    const half = (s.length - 1) / 2;
    const a = s.slice(0, half);
    const b = s.slice(half + 1);
    if (s[half] === ' ' && a.slice(2) === b.slice(2) && a.startsWith('a/') && b.startsWith('b/')) return [a, b];
  }
  const out = [];
  let splits = 0;
  for (let at = s.indexOf(' b/'); at > 0; at = s.indexOf(' b/', at + 1)) {
    if (++splits > MAX_GIT_SPLITS) throw new Bad('splits');
    out.push(s.slice(0, at), ...headerNames(s.slice(at + 1)));
  }
  if (out.length > 0) return out;
  const sp = s.indexOf(' ');
  return sp > 0 ? [s.slice(0, sp), ...headerNames(s.slice(sp + 1))] : [s];
}

function stripped(name, strip) {
  if (strip === undefined) return [/^[ab]\//.test(name) ? name.slice(2) : name];
  if (strip === 'patch-default') {
    const out = [name, ...stripped(name, undefined)];
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (base !== '') out.push(base);
    return out;
  }
  // patch -p N / git apply -p N: N leading components (runs of slashes count as one)
  if (strip <= 0) return [name];
  // `-p1` removes everything up to and including the first slash (`/a/b` -> `a/b`)
  const rest = name.split(/\/+/).slice(strip).filter((s) => s !== '');
  if (rest.length === 0) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    return base === '' ? [] : [base];
  }
  return [rest.join('/')];
}

/**
 * The files a patch text writes.
 * @param {string} text
 * @param {{strip?: number|'patch-default'}} [opts]
 * @returns {string[]|typeof UNKNOWN}
 */
export function patchTargetsFromText(text, opts = {}) {
  try {
    if (typeof text !== 'string' || text.length > MAX_PATCH_BYTES) return UNKNOWN;
    const strip = opts && (Number.isInteger(opts.strip) || opts.strip === 'patch-default') ? opts.strip : undefined;
    const out = [];
    const seen = new Set();
    const add = (name) => {
      if (typeof name !== 'string' || name === '' || name === '/dev/null' || name.includes('\0')) return;
      for (const n of stripped(name, strip)) {
        if (n === '' || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (out.length > MAX_TARGETS) throw new Bad('targets');
      }
    };
    let oldLeft = 0;
    let newLeft = 0;
    let start = 0;
    while (start <= text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      if (oldLeft > 0 || newLeft > 0) {
        // a line counts only while its side has lines left: a hunk whose header overstates one
        // side cannot swallow the next file's header
        const c = line[0];
        if ((c === ' ' || line === '' || line === '\r') && oldLeft > 0 && newLeft > 0) {
          oldLeft--;
          newLeft--;
          continue;
        }
        if (c === '-' && oldLeft > 0) {
          oldLeft--;
          continue;
        }
        if (c === '+' && newLeft > 0) {
          newLeft--;
          continue;
        }
        if (c === '\\') continue;
        oldLeft = 0;
        newLeft = 0;
      }
      const h = HUNK.exec(line);
      if (h) {
        oldLeft = h[1] === undefined ? 1 : Number(h[1]);
        newLeft = h[2] === undefined ? 1 : Number(h[2]);
        continue;
      }
      if (line.startsWith('diff --git ')) for (const n of gitHeaderNames(line.slice(11))) add(n);
      else if ((line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('*** ')) && !CONTEXT_RANGE.test(line)) headerNames(line.slice(4)).forEach(add);
      else if (line.startsWith('Index: ')) headerNames(line.slice(7)).forEach(add);
      else if (line.startsWith('rename from ') || line.startsWith('copy from ')) headerNames(line.slice(line.indexOf(' from ') + 6)).forEach(add);
      else if (line.startsWith('rename to ') || line.startsWith('copy to ')) headerNames(line.slice(line.indexOf(' to ') + 4)).forEach(add);
      if (end === text.length) break;
    }
    return out.length === 0 ? UNKNOWN : out;
  } catch {
    return UNKNOWN;
  }
}

/**
 * The files a patch file writes.
 * @param {string} file absolute path
 * @param {{readFileSync: Function, statSync?: Function}} fsImpl
 * @param {{strip?: number|'patch-default'}} [opts]
 * @returns {string[]|typeof UNKNOWN}
 */
export function patchTargets(file, fsImpl, opts = {}) {
  try {
    if (typeof file !== 'string' || !file.startsWith('/') || file.includes('\0')) return UNKNOWN;
    if (!fsImpl || typeof fsImpl.readFileSync !== 'function') return UNKNOWN;
    if (typeof fsImpl.statSync === 'function') {
      const st = fsImpl.statSync(file);
      if (!st.isFile() || st.size > MAX_PATCH_BYTES) return UNKNOWN;
    }
    const text = fsImpl.readFileSync(file, 'utf8');
    return patchTargetsFromText(typeof text === 'string' ? text : String(text), opts);
  } catch {
    return UNKNOWN;
  }
}
