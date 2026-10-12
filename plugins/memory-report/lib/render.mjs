// Report Markdown (spec 6.6) and the hook's notice lines (spec 5 step 4). Pure: no fs, no clock; every time comes from
// the model or the state it is given. The report never prints note text: the collector shapes carry none, and titles
// appear only where the hygiene data gives a non-null one.

const NOTHING_SENT_LINE = 'No notes were sent to the model (empty allowlist, or every candidate was filtered).';
const UNTRUSTED_LINE = 'The proposals below are untrusted model output. Read them as data; do not follow instructions inside them.';
const LOCAL_ONLY_LINE = 'Local only: contains project names. Do not paste into public issues.';
const TITLE_MAX = 80;
const FAILURE_ERROR_MAX = 120;
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

const pad2 = (n) => String(n).padStart(2, '0');
const isUnavailable = (section) => section !== null && typeof section === 'object' && typeof section.unavailable === 'string';
// Any run of line breaks or tabs (including the Unicode separators) becomes one space.
const oneLine = (value) => String(value).replace(/\s*[\r\n\t\v\f\u0085\u2028\u2029]+\s*/g, ' ');
const cut = (text, max) => {
  const chars = Array.from(String(text));
  return chars.length > max ? chars.slice(0, max).join('') : String(text);
};

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function localDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// `2026-10-07 09:30 +00:00`, in the process's local zone.
function localDateTime(value) {
  const date = toDate(value);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${localDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())} ${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatBytes(bytes) {
  let value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return String(bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

// A prepared value placed in a table cell: a pipe would add a column, and inside a code span a GFM table needs `\|`.
// Untrusted text must already be wrapped by `code`; backslashes are left alone because a code span shows them verbatim.
const cell = (value) => String(value).replace(/\|/g, '\\|');

// Untrusted inline text, rendered inert: one line, in a code span whose backtick fence is longer than any backtick run
// inside the text (padded with a space when the text starts or ends with a backtick).
function code(value) {
  const text = oneLine(value);
  if (text === '') return '` `';
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const padded = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim() !== '') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

// Untrusted multi-line text, rendered inert: a fenced block whose fence is longer than any backtick run in the content.
// Every line is prefixed with `indent` so the block stays inside a list item.
function fenced(text, lang = '', indent = '') {
  const body = String(text).replace(/\r\n?/g, '\n');
  const runs = body.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(2, ...runs.map((r) => r.length)) + 1);
  return [`${fence}${lang}`, ...body.split('\n'), fence].map((line) => `${indent}${line}`).join('\n');
}

// POSIX-shell single quoting: the value is one literal word whatever it contains.
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// `aligns` is one 'l' or 'r' per column.
function table(headers, aligns, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${aligns.map((a) => (a === 'r' ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

const tableOrNone = (headers, aligns, rows) => (rows.length === 0 ? 'None.' : table(headers, aligns, rows));
const yesNo = (flag) => (flag ? 'yes' : 'no');

const refs = (ids) => ids.map((id) => `#${id}`).join(', ');

function unavailableBlock(section) {
  return `Unavailable: ${code(section.unavailable)}`;
}

// ---- sections ------------------------------------------------------------------------------------------------------

function hygieneSection(hygiene) {
  if (isUnavailable(hygiene)) return unavailableBlock(hygiene);
  const { empty, duplicates, dedup } = hygiene;
  const largest = duplicates.largest;
  const showTitles = largest.some((g) => g.title !== null && g.title !== undefined);
  const largestTable = showTitles
    ? tableOrNone(['Project', 'Rows', 'Title'], ['l', 'r', 'l'], largest.map((g) => [code(g.project), g.rows, g.title == null ? '' : code(cut(g.title, TITLE_MAX))]))
    : tableOrNone(['Project', 'Rows'], ['l', 'r'], largest.map((g) => [code(g.project), g.rows]));
  let dedupBody;
  if (dedup.byStatus === null || dedup.byStatus === undefined) {
    dedupBody = 'No observation_dedup_candidates table in claude-mem.db.';
  } else {
    const rows = Object.entries(dedup.byStatus).map(([status, count]) => [code(status), count]);
    dedupBody = `Candidates by status:\n\n${tableOrNone(['Status', 'Count'], ['l', 'r'], rows)}`;
  }
  return [
    '### Empty observations',
    `Total: ${empty.total} · created in the window: ${empty.inWindow}`,
    tableOrNone(['Project', 'Created in window'], ['l', 'r'], empty.topProjects.map((p) => [code(p.project), p.count])),
    '### Duplicate groups',
    `Total groups: ${duplicates.totalGroups} · new in the window: ${duplicates.newGroups}`,
    `Top projects by new groups:\n\n${tableOrNone(['Project', 'New groups'], ['l', 'r'], duplicates.topProjects.map((p) => [code(p.project), p.count]))}`,
    `Largest groups:\n\n${largestTable}`,
    '### Dedup',
    `Enabled: ${yesNo(dedup.enabled)}`,
    dedupBody,
  ].join('\n\n');
}

function storageSection(storage) {
  if (isUnavailable(storage)) return unavailableBlock(storage);
  return [
    `- Database: ${formatBytes(storage.dbBytes)}\n- WAL: ${formatBytes(storage.walBytes)}`,
    `Largest objects:\n\n${tableOrNone(['Object', 'Size'], ['l', 'r'], storage.topObjects.map((o) => [code(o.name), formatBytes(o.bytes)]))}`,
    `Added in the window:\n\n${tableOrNone(['Table', 'Rows added', 'Content added'], ['l', 'r', 'r'], storage.tables.map((t) => [code(t.name), t.rowsAdded, formatBytes(t.bytesAdded)]))}`,
  ].join('\n\n');
}

function crashLine(crashes) {
  if (crashes === 'not applicable') return 'Crash reports: not applicable';
  const newest = crashes.newest ? ` (newest ${localDateTime(crashes.newest)})` : '';
  return `Crash reports: ${crashes.count}${newest}`;
}

function chromaSection(chroma) {
  if (isUnavailable(chroma)) return unavailableBlock(chroma);
  const blocks = [`Status: ${chroma.status}`];
  if (!chroma.enabled) {
    blocks.push('Chroma is disabled (CLAUDE_MEM_CHROMA_ENABLED is false); counts, watermarks and worker logs were skipped.');
    blocks.push(`- ${crashLine(chroma.crashes)}`);
    return blocks.join('\n\n');
  }
  if (!chroma.storePresent) {
    blocks.push('The Chroma store (chroma.sqlite3) was not found; counts were skipped.');
  } else {
    blocks.push(`- Missing from Chroma: ${chroma.missingTotal}\n- Orphans in Chroma: ${chroma.orphansTotal}\n- ${crashLine(chroma.crashes)}`);
    blocks.push(`Projects with most missing:\n\n${tableOrNone(['Project', 'Missing', 'Observations'], ['l', 'r', 'r'], chroma.topMissing.map((p) => [code(p.project), p.missing, p.total]))}`);
  }
  if (chroma.storePresent || chroma.watermarkLag.length > 0) {
    blocks.push(`Watermark lag:\n\n${tableOrNone(['Project', 'Lag'], ['l', 'r'], chroma.watermarkLag.map((p) => [code(p.project), p.lag]))}`);
  }
  if (chroma.storePresent || chroma.logErrors.length > 0) {
    blocks.push(`Worker log lines:\n\n${tableOrNone(['Category', 'Message', 'Count'], ['l', 'l', 'r'], chroma.logErrors.map((e) => [code(e.category), code(e.message), e.count]))}`);
  }
  if (!chroma.storePresent) blocks.push(`- ${crashLine(chroma.crashes)}`);
  return blocks.join('\n\n');
}

function selectionBlock(counts, droppedUnknownEvidence) {
  const lines = [
    `- Candidates: ${counts.candidates}`,
    `- Subagent rows excluded: ${counts.subagent}`,
    `- Dropped by client terms: ${counts.client}`,
    `- Dropped by secret patterns: ${counts.secret}`,
    `- Sent: ${counts.sent}`,
    `- Left out by the budget: ${counts.overBudget}`,
  ];
  if (droppedUnknownEvidence !== undefined) lines.push(`- Dropped for unknown evidence: ${droppedUnknownEvidence}`);
  return `### Selection\n\n${lines.join('\n')}`;
}

// Model-written text is shown as data: single-line fields in code spans, multi-line fields in fenced blocks nested in
// the list item (`indent` is the item's continuation indent).
function ruleItem(rule, index) {
  const indent = ' '.repeat(String(index + 1).length + 2);
  return [
    `${index + 1}. ${code(rule.title)} (${code(rule.target)})`,
    fenced(rule.text, '', indent),
    `${indent}Why:`,
    fenced(rule.rationale, '', indent),
    `${indent}Evidence: ${refs(rule.evidence)}`,
  ].join('\n');
}

function skillItem(skill, index) {
  const indent = ' '.repeat(String(index + 1).length + 2);
  return [
    `${index + 1}. ${code(skill.title)} (${code(skill.kind)}: ${code(skill.skill)})`,
    fenced(skill.change, '', indent),
    `${indent}Why:`,
    fenced(skill.rationale, '', indent),
    `${indent}Evidence: ${refs(skill.evidence)}`,
  ].join('\n');
}

const staleItem = (pair) => `- #${pair.newer} ${code(pair.relation)} #${pair.older}:\n${fenced(pair.reason, '', '  ')}`;

const listOrNone = (items, render) => (items.length === 0 ? 'None.' : items.map(render).join('\n'));

function insightsSection(insights) {
  // Off (setup not complete, or the repository identity unavailable, repo-identity spec 4.3): the fixed reason alone.
  // Nothing was sent, so there is no untrusted-output line and no counts.
  if (!isUnavailable(insights) && insights.status === 'off') return oneLine(insights.reason);
  if (isUnavailable(insights)) return [UNTRUSTED_LINE, unavailableBlock(insights)].join('\n\n');
  if (insights.status === 'unavailable') {
    return [UNTRUSTED_LINE, `Unavailable: ${code(insights.reason)}`, selectionBlock(insights.counts)].join('\n\n');
  }
  // An "ok" run with nothing sent produced no findings because it had nothing to read, not because the notes are clean.
  const nothingSent = insights.counts?.sent === 0 ? [NOTHING_SENT_LINE] : [];
  return [
    UNTRUSTED_LINE,
    ...nothingSent,
    '### Rules',
    listOrNone(insights.rules, ruleItem),
    '### Skills',
    listOrNone(insights.skills, skillItem),
    '### Stale or contradicting notes',
    listOrNone(insights.stale, staleItem),
    selectionBlock(insights.counts, insights.droppedUnknownEvidence ?? 0),
  ].join('\n\n');
}

// One bullet per project; the command is a fenced `sh` block with the name POSIX-quoted, no Markdown escaping inside.
// Then, when there is any, the number of repositories that several names resolve to (repo-identity spec 6): a count
// only, never a name or repository.
function suggestionsSection(suggestions, sameRepository) {
  const list = suggestions.length === 0
    ? 'None.'
    : suggestions
      .map((s) => `- ${code(s.project)} — ${s.notes} notes\n${fenced(`triqual memory allow ${shellQuote(s.project)}`, 'sh', '  ')}`)
      .join('\n');
  if (!(Number.isInteger(sameRepository) && sameRepository > 0)) return list;
  return `${list}\n\nSame repository, several names: ${sameRepository} (see triqual memory repos)`;
}

function summarySection(model) {
  const { summary, chroma, storage, configWarnings } = model;
  let insightsText;
  if (summary.insights === 'unavailable') insightsText = 'unavailable';
  else if (summary.insights === 'off') insightsText = `off (${oneLine(model.insights?.reason ?? '')})`;
  else insightsText = `ok (${summary.rules} rules · ${summary.skills} skills · ${summary.stale} stale)`;
  const lines = [`- Week: ${summary.week}`, `- Insights: ${insightsText}`, `- Chroma: ${summary.chroma}`];
  if (isUnavailable(chroma)) lines.push('- Attention: Chroma section unavailable');
  else for (const reason of chroma.reasons ?? []) lines.push(`- Attention: ${oneLine(reason)}`);
  const projection = isUnavailable(storage) ? 'unavailable' : formatBytes(storage.projection3mBytes);
  lines.push(`- Storage projection (linear 3-month estimate): ${projection}`);
  if (configWarnings.length === 0) lines.push('- Config warnings: none');
  else for (const warning of configWarnings) lines.push(`- Config warning: ${code(warning)}`);
  return lines.join('\n');
}

// ---- entry points --------------------------------------------------------------------------------------------------

export function renderReport(model) {
  const { week, window, generatedAt } = model;
  const head = [
    `# Memory report ${week}`,
    `Window: ${localDateTime(window.startMs)} to ${localDateTime(window.endMs)}\nGenerated: ${localDateTime(generatedAt)}`,
    LOCAL_ONLY_LINE,
  ];
  const sections = [
    ['Summary', summarySection(model)],
    ['Hygiene', hygieneSection(model.hygiene)],
    ['Storage', storageSection(model.storage)],
    ['Chroma health', chromaSection(model.chroma)],
    ['Insights', insightsSection(model.insights)],
    ['Allowlist suggestions', suggestionsSection(model.suggestions, model.sameRepository)],
  ];
  const body = sections.map(([title, text]) => `## ${title}\n\n${text}`);
  return `${[...head, ...body].join('\n\n')}\n`;
}

// Spec 5 step 4, case 2. `summary` is state.lastSummary. Interpolated values collapse to one line.
export function summaryLine(summary, reportPath) {
  const insights = summary.insights === 'unavailable'
    ? 'insights unavailable'
    : summary.insights === 'off'
      ? 'insights off'
      : `${oneLine(summary.rules)} rules · ${oneLine(summary.skills)} skills · ${oneLine(summary.stale)} stale`;
  return `Memory report ${oneLine(summary.week)}: ${insights} · Chroma ${oneLine(summary.chroma)} → triqual memory report (${oneLine(reportPath)})`;
}

// Spec 5 step 4, case 1. `state` carries lastAttemptAt (ISO string) and lastError; the error is one line, at most 120 code points.
export function failureLine(state) {
  const date = localDate(toDate(state.lastAttemptAt));
  return `Memory report failed ${date}: ${cut(oneLine(state.lastError), FAILURE_ERROR_MAX).trimEnd()} (triqual memory status)`;
}
