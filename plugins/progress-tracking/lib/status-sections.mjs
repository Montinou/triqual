// Splits a status.md text into the store's sections (spec §2): the text before the first `## ` heading is the section
// `preamble` (always first, possibly empty), then each `## <heading>` section in order. The managed
// `<!-- tasks:start -->`…`<!-- tasks:end -->` block is dropped, since active plans are rendered live. Pure: no I/O.
//
// The store's key is (repo, heading), so a heading may appear once: a repeated one, or a `## preamble` heading that
// would collide with the preamble, is an error. A body is the text under its heading with the blank lines around it
// removed; a `## ` line inside a fenced code block is text, not a heading.

export const PREAMBLE = 'preamble';
export const ACTIVE_PLAN = 'Active plan';
const START = '<!-- tasks:start -->';
const END = '<!-- tasks:end -->';
const HEADING = /^## (.*\S)\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

export class StatusParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatusParseError';
  }
}

// `text` without the tasks block (the marker lines included). A marker without its pair is an error.
function withoutTasksBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 && end === -1) return text;
  if (start === -1 || end === -1 || end < start) {
    throw new StatusParseError(`unbalanced tasks block: "${START}" and "${END}" must come as a pair, start first`);
  }
  if (text.indexOf(START, start + START.length) !== -1 || text.indexOf(END, end + END.length) !== -1) {
    throw new StatusParseError('more than one tasks block');
  }
  const from = text.lastIndexOf('\n', start) + 1; // the whole marker line
  const after = text.indexOf('\n', end);
  return text.slice(0, from) + (after === -1 ? '' : text.slice(after + 1));
}

const trimBlankLines = (lines) => lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

// [{ heading, body }]: the preamble first, then the sections in order. Throws StatusParseError.
export function parseStatusSections(text) {
  const sections = [{ heading: PREAMBLE, lines: [] }];
  let fence = null;
  for (const line of withoutTasksBlock(text.replace(/\r\n?/g, '\n')).split('\n')) {
    const fenced = FENCE.exec(line);
    if (fenced) fence = fence === null ? fenced[1] : fence === fenced[1] ? null : fence;
    const heading = fence === null ? HEADING.exec(line) : null;
    if (heading) sections.push({ heading: heading[1], lines: [] });
    else sections.at(-1).lines.push(line);
  }
  const seen = new Set();
  for (const { heading } of sections) {
    if (seen.has(heading)) {
      throw new StatusParseError(heading === PREAMBLE
        ? `the heading "${PREAMBLE}" is reserved for the text before the first section`
        : `repeated heading "${heading}": each "## " heading may appear once`);
    }
    seen.add(heading);
  }
  return sections.map(({ heading, lines }) => ({ heading, body: trimBlankLines(lines) }));
}

// The sections without the one named `Active plan`, and whether there was one. The managed block is rendered live from
// the ledgers; a copy of it that lost its markers (a `tracking status` read edited and set back) would be stored as a
// stale section beside the live one, so a store never keeps it.
export function withoutActivePlan(sections) {
  const kept = sections.filter((s) => s.heading !== ACTIVE_PLAN);
  return { sections: kept, dropped: kept.length !== sections.length };
}
