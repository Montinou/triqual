// Parses a progress entry draft, markdown or JSON, into the store's fields (spec §4). Pure: no I/O.
//   markdown  `## <YYYY-MM-DD> — <title>`, then top-level bullets `- **<Name>:** text`. A bullet runs until the next
//             top-level `- **` bullet, so sub-bullets, indented lines and blank lines belong to it.
//   JSON      an object with the keys title, stage_task, done, files, verification and next.
// `Commit` (`commit` in JSON) is known and always ignored: the store records the commit itself. With `strict` (what
// `tracking add` uses) any other field name, a missing or empty required field, or text outside every field is an
// error; without it extra field names are listed in `extra` and a missing field reads as ''. Import uses that form.
// Any top-level line starting `- **` ends the bullet before it, formatted as a field (`- **Name:** text`) or not
// (`- **Name**: text`, `- **Name** text`); one that is not a known field is an extra field. Only the display names
// map to the fields: a name spelled like an internal key (`stage_task`) is extra too.

const REQUIRED = ['stage_task', 'done', 'files', 'verification', 'next'];
const KNOWN_JSON = new Set(['title', ...REQUIRED, 'commit']);
const MARKDOWN_NAMES = new Map([
  ['stage/task', 'stage_task'], ['done', 'done'], ['files', 'files'], ['verification', 'verification'],
  ['commit', 'commit'], ['next', 'next'],
]);
const HEADING = /^## (\d{4}-\d{2}-\d{2}) — (.*)$/;
const FIELD = /^- \*\*([^*]+?):\*\*[ \t]*(.*)$/;
const BOUNDARY = /^- \*\*/;
// A calendar date: the month and day exist in that year.
const isDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
};
// The name of a top-level `- **` line that is not shaped like a field: the bold text, or the line when it never closes.
const looseName = (line) => {
  const m = /^- \*\*([^*]*)\*\*/.exec(line);
  return (m ? m[1] : line.slice(4)).trim().replace(/:$/, '').trim().slice(0, 60) || line.trim().slice(0, 60);
};

const fail = (error) => ({ error });
const blank = (line) => line.trim() === '';

function parseJson(text, strict) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return fail(`the draft looks like JSON but does not parse: ${e.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail('the JSON draft must be an object');
  const extra = Object.keys(data).filter((k) => !KNOWN_JSON.has(k));
  for (const key of KNOWN_JSON) {
    if (data[key] !== undefined && typeof data[key] !== 'string') return fail(`field "${key}" must be a string`);
  }
  const field = (key) => (data[key] ?? '').trim();
  return finish({ date: null, title: field('title'), ...Object.fromEntries(REQUIRED.map((k) => [k, field(k)])), extra }, strict);
}

function parseMarkdown(text, strict) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => !blank(l));
  const heading = start === -1 ? null : HEADING.exec(lines[start]);
  if (!heading) return fail('the draft must start with the entry heading "## <YYYY-MM-DD> — <title>" on its first line');
  const bodies = new Map(); // a known field's key → lines (an unknown field's name goes under `extra:` + name)
  const extra = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) return fail('the draft must hold one entry, but it has a second dated heading');
    if (BOUNDARY.test(line)) {
      const field = FIELD.exec(line);
      const label = field ? field[1].trim() : looseName(line);
      const known = field ? MARKDOWN_NAMES.get(label.toLowerCase()) : undefined;
      const slot = known ?? `extra:${label}`;
      if (bodies.has(slot)) {
        if (strict) return fail(`field "${label}" appears twice`);
        current = null; // a repeat is kept out of the first one's text
        continue;
      }
      if (known === undefined) extra.push(label);
      current = [field ? field[2] : ''];
      bodies.set(slot, current);
    } else if (current) {
      current.push(line);
    } else if (strict && !blank(line)) {
      return fail(`text outside a field: "${line.trim().slice(0, 60)}": put it inside a "- **<Name>:** ..." bullet`);
    }
  }
  const field = (key) => (bodies.get(key) ?? []).join('\n').trim();
  // An impossible date (2026-13-45) is an error on add; elsewhere (import) it reads as no date, the entry kept.
  if (!isDate(heading[1]) && strict) return fail(`the heading date ${heading[1]} is not a calendar date: the draft's date must be a real "<YYYY-MM-DD>"`);
  return finish({
    date: isDate(heading[1]) ? heading[1] : null, title: heading[2].trim(), ...Object.fromEntries(REQUIRED.map((k) => [k, field(k)])), extra,
  }, strict);
}

// Strict mode: the title and the five required fields must be non-empty, and no extra field may remain.
function finish(entry, strict) {
  if (strict) {
    if (entry.extra.length) {
      return fail(`unknown field ${entry.extra.map((k) => `"${k}"`).join(', ')}: an entry has only ${['Stage/task', 'Done', 'Files', 'Verification', 'Next'].join(', ')} (Commit is ignored)`);
    }
    const missing = ['title', ...REQUIRED].filter((k) => entry[k] === '');
    if (missing.length) return fail(`the draft lacks the required field${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
  }
  return entry;
}

// The date an entry written at `now` shows: its draft's own heading date, else (a JSON draft has none) the local date
// of `now`, never the UTC date of the write.
export function entryDate(entry, now = new Date()) {
  if (entry.date) return entry.date;
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// { date, title, stage_task, done, files, verification, next, extra: [names] } or { error }. `date` is the heading's
// date (null for a JSON draft).
export function parseEntryDraft(text, { strict = false } = {}) {
  return text.trimStart().startsWith('{') ? parseJson(text, strict) : parseMarkdown(text, strict);
}
