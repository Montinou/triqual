// Targeted, line-based edits of Codex's config.toml (spec F.6). No TOML parser: a line scanner tracks multi-line
// strings (""" and ''') and bracket depth, so header-looking lines inside them are never taken as headers. New bare
// keys and new tables go right before the first table header, never at the end, where they would land in the last
// table. The file holds secrets: nothing here logs a value, and editTomlFile never writes a backup.
import { readFileSync, statSync } from 'node:fs';
import { realTarget, writeAtomic } from './fsx.mjs';

const CHANGED_DURING_EDIT = 'config.toml changed during the edit';
const REJECTED_RESTORED = 'codex rejected the edited config; restored';
const RESTORE_FAILED = 'codex rejected the edited config; restore failed';

// Lines split on '\n' with any '\r' kept on its line, plus whether the text ends in a newline, so join() gives
// the input back byte for byte. New lines get a '\r' when the file uses CRLF.
function split(text) {
  const lines = text.split('\n');
  const final = lines[lines.length - 1] === '';
  if (final) lines.pop();
  return { lines, final, crlf: text.includes('\r\n') };
}

function join({ lines, final }) {
  return lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : '');
}

const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

function newLines(doc, lines) {
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error('toml-edit: an inserted line must be a single line');
  }
  return lines.map((line) => (doc.crlf ? `${line}\r` : line));
}

// Whitespace outside quotes removed, so `[ a . "b" ]` and `a."b"` name the same table, and a quoted segment that a bare
// key could spell (`"agents"`) is written bare, so `["agents"]` and `[agents]` name the same table too.
function normalizeKey(key) {
  const bareIfPossible = (seg) => /^(["'])[A-Za-z0-9_-]+\1$/.test(seg) ? seg.slice(1, -1) : seg;
  const parts = [];
  let out = '';
  let quote = null;
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (quote) {
      out += c;
      if (quote === '"' && c === '\\' && i + 1 < key.length) out += key[++i];
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '.') {
      parts.push(bareIfPossible(out));
      out = '';
    } else if (c !== ' ' && c !== '\t') {
      out += c;
    }
  }
  parts.push(bareIfPossible(out));
  return parts.join('.');
}

function headerOf(trimmed) {
  const array = trimmed.startsWith('[[');
  const start = array ? 2 : 1;
  let quote = null;
  let i = start;
  for (; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ']') {
      break;
    }
  }
  return { array, name: normalizeKey(trimmed.slice(start, i)) };
}

// One entry per line: kind is 'header' (with name and array), 'blank', 'comment', 'key' (a line that starts a
// key/value pair) or 'cont' (a line that starts inside a multi-line string or array). `comment` is the index of a
// '#' that starts a comment on the line, or -1.
function scan(lines) {
  const info = [];
  let multi = null; // the open multi-line string's delimiter, '"""' or "'''"
  let depth = 0; // open [ and { outside strings
  for (const raw of lines) {
    const line = bare(raw);
    const clean = multi === null && depth === 0;
    const trimmed = line.trim();
    if (clean && trimmed === '') { info.push({ kind: 'blank', comment: -1 }); continue; }
    if (clean && trimmed.startsWith('#')) { info.push({ kind: 'comment', comment: line.indexOf('#') }); continue; }
    if (clean && trimmed.startsWith('[')) { info.push({ kind: 'header', comment: -1, ...headerOf(trimmed) }); continue; }
    let comment = -1;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (multi) {
        if (multi === '"""' && c === '\\') { i += 2; continue; }
        if (c === multi[0]) {
          let run = 0;
          while (line[i + run] === c) run++;
          if (run >= 3) multi = null; // a closing run may carry up to two quotes of content before the delimiter
          i += run;
          continue;
        }
        i++;
        continue;
      }
      if (c === '#') { comment = i; break; }
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { multi = c.repeat(3); i += 3; continue; }
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && depth > 0) depth--;
      i++;
    }
    info.push({ kind: clean ? 'key' : 'cont', comment });
  }
  return info;
}

function parse(text) {
  const doc = split(text);
  return { doc, info: scan(doc.lines) };
}

const firstHeader = (info) => info.findIndex((x) => x.kind === 'header');

// The first line of a header's block: the header, or the comment lines directly above it.
function blockStart(info, h) {
  let at = h;
  while (at > 0 && info[at - 1].kind === 'comment') at--;
  return at;
}

// One past the last line of the table at h: the start of the next header's block, or the end of the text.
function spanEnd(info, h) {
  for (let j = h + 1; j < info.length; j++) {
    if (info[j].kind === 'header') return blockStart(info, j);
  }
  return info.length;
}

function findTable(info, table) {
  const want = normalizeKey(table);
  return info.findIndex((x) => x.kind === 'header' && !x.array && x.name === want);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A single-segment key as a regex source: bare, "basic" or 'literal' quoted, the same key in TOML.
const keyForms = (key) => `(?:${escapeRe(key)}|"${escapeRe(key)}"|'${escapeRe(key)}')`;

// The key's line in [from, to): { at, end, indent, eq }, where `end` is one past its value's last line and `eq`
// the index just after its '='. Null when absent.
function findKey(doc, info, from, to, key) {
  const re = new RegExp(`^(\\s*)${keyForms(key)}\\s*=`);
  for (let j = from; j < to; j++) {
    if (info[j].kind !== 'key') continue;
    const m = re.exec(bare(doc.lines[j]));
    if (!m) continue;
    let end = j + 1;
    while (end < info.length && info[end].kind === 'cont') end++;
    return { at: j, end, indent: m[1], eq: m[0].length };
  }
  return null;
}

function valueOf(doc, info, found) {
  const parts = [];
  for (let k = found.at; k < found.end; k++) {
    const line = bare(doc.lines[k]);
    const to = info[k].comment >= 0 ? info[k].comment : line.length;
    parts.push(line.slice(k === found.at ? found.eq : 0, to));
  }
  return parts.join('\n').trim();
}

export function firstTableHeaderIndex(text) {
  return firstHeader(parse(text).info);
}

// Whether `text` has the (non-array) table `table`; a header-looking line inside a multi-line string is not one.
export function hasTable(text, table) {
  return findTable(parse(text).info, table) !== -1;
}

// The name of each (non-array) table header in `text`, in order, normalized as hasTable compares them.
export function tableNames(text) {
  return parse(text).info.filter((x) => x.kind === 'header' && !x.array).map((x) => x.name);
}

export function hasTopLevelKey(text, key) {
  const { doc, info } = parse(text);
  const h = firstHeader(info);
  return findKey(doc, info, 0, h === -1 ? info.length : h, key) !== null;
}

// Inserts `lines` right before the first header, above any blank lines that separate it from the top-level keys
// (and above the header's own leading comments); appends when there is no header.
export function insertTopLevel(text, lines) {
  const { doc, info } = parse(text);
  const add = newLines(doc, lines);
  const h = firstHeader(info);
  if (h === -1) {
    doc.lines.push(...add);
  } else {
    let at = blockStart(info, h);
    while (at > 0 && info[at - 1].kind === 'blank') at--;
    doc.lines.splice(at, 0, ...add);
  }
  return join(doc);
}

// The text of a top-level key's value (comment dropped, trimmed), or null when the key is not there. A read only.
export function topLevelKeyValue(text, key) {
  const { doc, info } = parse(text);
  const h = firstHeader(info);
  const found = findKey(doc, info, 0, h === -1 ? info.length : h, key);
  return found ? valueOf(doc, info, found) : null;
}

// The text of `key`'s value in [table] (comment dropped, trimmed), or null when the table or the key is not there.
export function tableKeyValue(text, table, key) {
  const { doc, info } = parse(text);
  const h = findTable(info, table);
  const found = h === -1 ? null : findKey(doc, info, h + 1, spanEnd(info, h), key);
  return found ? valueOf(doc, info, found) : null;
}

// Sets `key = literal` in [table]. An existing key is edited in place (its trailing comment kept on a one-line
// value); a missing key goes after the table's last non-blank line; a missing table is inserted before the first
// header, followed by a blank line, or appended when there is no header. `was` is the prior value's text, or null.
export function setTableKey(text, table, key, literal) {
  const { doc, info } = parse(text);
  const [line] = newLines(doc, [`${key} = ${literal}`]);
  const h = findTable(info, table);
  if (h === -1) {
    const [header, blank] = newLines(doc, [`[${table}]`, '']);
    const first = firstHeader(info);
    if (first === -1) doc.lines.push(header, line);
    else doc.lines.splice(blockStart(info, first), 0, header, line, blank);
    return { text: join(doc), was: null, createdTable: true };
  }
  const end = spanEnd(info, h);
  const found = findKey(doc, info, h + 1, end, key);
  if (found) {
    const was = valueOf(doc, info, found);
    if (was === literal.trim()) return { text, was, createdTable: false };
    const last = found.end - 1;
    const tail = found.end - found.at === 1 && info[last].comment >= 0
      ? ` ${bare(doc.lines[last]).slice(info[last].comment)}`
      : '';
    const [replaced] = newLines(doc, [`${found.indent}${key} = ${literal}${tail}`]);
    doc.lines.splice(found.at, found.end - found.at, replaced);
    return { text: join(doc), was, createdTable: false };
  }
  let at = end;
  while (at > h + 1 && info[at - 1].kind === 'blank') at--;
  doc.lines.splice(at, 0, line);
  return { text: join(doc), was: null, createdTable: false };
}

export function removeTopLevelKey(text, key) {
  const { doc, info } = parse(text);
  const h = firstHeader(info);
  const found = findKey(doc, info, 0, h === -1 ? info.length : h, key);
  if (!found) return text;
  doc.lines.splice(found.at, found.end - found.at);
  return join(doc);
}

export function removeTableKey(text, table, key) {
  const { doc, info } = parse(text);
  const h = findTable(info, table);
  if (h === -1) return text;
  const found = findKey(doc, info, h + 1, spanEnd(info, h), key);
  if (!found) return text;
  doc.lines.splice(found.at, found.end - found.at);
  return join(doc);
}

// Removes the header and its whole span, up to the next table's block (its leading comments stay).
export function removeTable(text, table) {
  const { doc, info } = parse(text);
  const h = findTable(info, table);
  if (h === -1) return text;
  doc.lines.splice(h, spanEnd(info, h) - h);
  return join(doc);
}

// Removes [table] only when nothing but blank lines is left in it (after its recorded key was removed): keys, values
// and comments a user put there since stay, and so does the table.
export function removeTableIfEmpty(text, table) {
  const { doc, info } = parse(text);
  const h = findTable(info, table);
  if (h === -1) return text;
  const end = spanEnd(info, h);
  for (let j = h + 1; j < end; j++) {
    if (info[j].kind !== 'blank') return text;
  }
  doc.lines.splice(h, end - h);
  return join(doc);
}

// A top-level (before the first header) definition of [table] that setTableKey cannot edit: `table.key = v`,
// `table.other = v` or `table = { key = v }`. Null when there is none; otherwise { value }, the text of key's value
// or null when that definition does not set it. Adding a [table] header next to one of these is invalid TOML.
export function foreignTableKey(text, table, key) {
  const { doc, info } = parse(text);
  const h = firstHeader(info);
  const to = h === -1 ? info.length : h;
  const t = keyForms(table);
  const dotted = new RegExp(`^(\\s*)${t}\\s*\\.\\s*${keyForms(key)}\\s*=`);
  const other = new RegExp(`^\\s*${t}\\s*\\.`);
  const inline = new RegExp(`^(\\s*)${t}\\s*=\\s*\\{`);
  const member = new RegExp(`[{,]\\s*${keyForms(key)}\\s*=\\s*([^,}]*)`);
  let defined = false;
  for (let j = 0; j < to; j++) {
    if (info[j].kind !== 'key') continue;
    const line = bare(doc.lines[j]);
    const found = { at: j, end: j + 1, eq: 0 };
    while (found.end < info.length && info[found.end].kind === 'cont') found.end++;
    const m = dotted.exec(line);
    if (m) return { value: valueOf(doc, info, { ...found, eq: m[0].length }) };
    if (inline.test(line)) {
      const v = member.exec(valueOf(doc, info, { ...found, eq: line.indexOf('=') + 1 }));
      return { value: v ? v[1].trim() : null };
    }
    if (other.test(line)) defined = true;
  }
  return defined ? { value: null } : null;
}

// Edits the real file behind `path`: note the mtime, read, mutate, re-stat, write atomically (same dir, same mode),
// then validate. A changed mtime re-reads and retries once, then fails. The edit stands only when `validate()`
// resolves to exactly `true`: any other value (1, 'true', undefined…) or a throw counts as rejected, and the original
// bytes, held in memory only, are put back. A restore that itself fails returns an error, never throws, and names no
// content.
export async function editTomlFile(path, mutate, { validate } = {}) {
  if (typeof validate !== 'function') throw new TypeError('editTomlFile needs a validate function');
  const target = realTarget(path);
  let changes;
  for (let attempt = 0; attempt < 2; attempt++) {
    const mtime = statSync(target, { bigint: true }).mtimeNs;
    const original = readFileSync(target);
    const before = original.toString('utf8');
    const result = mutate(before);
    changes = result.changes;
    if (result.text === before) return { changed: false, changes };
    if (statSync(target, { bigint: true }).mtimeNs !== mtime) continue;
    writeAtomic(target, result.text);
    let ok = false;
    try {
      ok = (await validate()) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        writeAtomic(target, original);
      } catch {
        return { changed: false, changes, error: RESTORE_FAILED };
      }
      return { changed: false, changes, error: REJECTED_RESTORED };
    }
    return { changed: true, changes };
  }
  return { changed: false, changes, error: CHANGED_DURING_EDIT };
}
