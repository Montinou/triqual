// Role dispatches and subagent activity read from Claude Code transcripts. Transcripts are untrusted input: every line is
// parsed defensively and every agent id is checked before it becomes a path. node: built-ins and the eval libraries only.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mainTranscripts, sessionSignals } from './eval-sessions.mjs';
import { PRICES, subagentTranscripts } from './eval-plans.mjs';

const DISPATCH_TOOLS = new Set(['Agent', 'Task']);
const AGENT_ID = /^[0-9a-f]+$/;
const AGENT_ID_TEXT = /agentId: ([0-9a-f]+)/;
const LINE_NUMBER = /^\s*\d+[\t→]/;

// The parsed records of a transcript; a line that does not parse is skipped, a missing file has no records.
function parseLines(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec !== null && typeof rec === 'object') out.push(rec);
  }
  return out;
}

// The text of a tool result: a plain string, or the concatenated text blocks of an array.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

// The tool uses of the assistant lines (in order) and the first tool result of each id in the user lines.
function indexTranscript(recs) {
  const uses = [];
  const results = new Map();
  for (const rec of recs) {
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (rec.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const input = b.input !== null && typeof b.input === 'object' ? b.input : {};
        uses.push({ id: b.id, name: b.name, input, at: rec.timestamp, cwd: rec.cwd });
      } else if (rec.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && !results.has(b.tool_use_id)) {
        results.set(b.tool_use_id, {
          text: resultText(b.content),
          isError: b.is_error === true,
          agentId: rec.toolUseResult?.agentId,
        });
      }
    }
  }
  return { uses, results };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

// The files the transcript wrote before its use number `before` that the prompt names: for each path the latest successful Write,
// unless a successful Edit of the path followed it. A path the prompt does not name is not kept.
function writesBefore(uses, results, before, prompt) {
  const latest = new Map();
  for (const u of uses.slice(0, before)) {
    const path = u.input.file_path ?? u.input.notebook_path;
    if (typeof path !== 'string' || results.get(u.id)?.isError !== false) continue;
    if (u.name === 'Write' && typeof u.input.content === 'string') latest.set(path, { path, content: u.input.content });
    else if (EDIT_TOOLS.has(u.name)) latest.delete(path);
  }
  return [...latest.values()].filter((w) => prompt.includes(w.path));
}

// Dispatches of `roles:<role>` (an `Agent` or `Task` tool use) in the main transcripts and in every subagent transcript
// under `root`, with a line timestamp at or after `since`. A tool_use id is kept once: its first occurrence wins.
export function findDispatches(root, role, { since } = {}) {
  const wanted = `roles:${role}`;
  const sinceMs = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error(`findDispatches: invalid since ${String(since)}`);
  const files = [
    ...mainTranscripts(root).map((t) => ({ file: t.file, main: true })),
    ...subagentTranscripts(root, false, []).map((file) => ({ file, main: false })),
  ];
  const out = [];
  const seen = new Set();
  for (const { file, main } of files) {
    const { uses, results } = indexTranscript(parseLines(file));
    // A main transcript keeps its subagents in <session>/subagents/; a subagent transcript is already in one.
    const subagentsDir = main ? join(dirname(file), basename(file, '.jsonl'), 'subagents') : dirname(file);
    for (const [index, u] of uses.entries()) {
      if (!DISPATCH_TOOLS.has(u.name) || u.input.subagent_type !== wanted || seen.has(u.id)) continue;
      seen.add(u.id);
      const at = typeof u.at === 'string' ? Date.parse(u.at) : NaN;
      if (Number.isNaN(at) || at < sinceMs) continue;
      const r = results.get(u.id);
      const fromResult = typeof r?.agentId === 'string' && AGENT_ID.test(r.agentId) ? r.agentId : null;
      const agentId = fromResult ?? AGENT_ID_TEXT.exec(r?.text ?? '')?.[1] ?? null;
      const candidate = agentId === null ? null : join(subagentsDir, `agent-${agentId}.jsonl`);
      out.push({
        toolUseId: u.id,
        description: typeof u.input.description === 'string' ? u.input.description : null,
        prompt: typeof u.input.prompt === 'string' ? u.input.prompt : null,
        dispatchedAt: u.at,
        cwd: typeof u.cwd === 'string' ? u.cwd : null,
        agentId,
        subagentFile: candidate !== null && existsSync(candidate) ? candidate : null,
        writes: writesBefore(uses, results, index, typeof u.input.prompt === 'string' ? u.input.prompt : ''),
      });
    }
  }
  return out;
}

// What one subagent transcript did: the distinct cwds, the whole successful Reads (no offset, no limit; the line-number
// prefixes stripped), each Bash command with its cwd and result, the time span of its lines ({ from, to } in ms, null when no line
// has a timestamp) and the USD estimate of the transcript.
export function subagentActivity(file) {
  const recs = parseLines(file);
  const { uses, results } = indexTranscript(recs);
  const cwds = new Set();
  for (const rec of recs) if (typeof rec.cwd === 'string' && rec.cwd !== '') cwds.add(rec.cwd);
  const reads = [];
  const bashes = [];
  for (const u of uses) {
    const r = results.get(u.id);
    if (!r) continue;
    if (u.name === 'Read' && typeof u.input.file_path === 'string' && !r.isError
      && [u.input.offset, u.input.limit].every((v) => v === undefined || v === null)) {
      const content = r.text.split('\n').map((line) => line.replace(LINE_NUMBER, '')).join('\n');
      reads.push({ path: u.input.file_path, content });
    } else if (u.name === 'Bash' && typeof u.input.command === 'string') {
      bashes.push({ command: u.input.command, ok: !r.isError, output: r.text, cwd: typeof u.cwd === 'string' ? u.cwd : undefined });
    }
  }
  const times = recs.map((rec) => (typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN)).filter((t) => !Number.isNaN(t));
  const span = times.length === 0 ? null : { from: times.reduce((a, t) => Math.min(a, t)), to: times.reduce((a, t) => Math.max(a, t)) };
  return { cwds: [...cwds], reads, bashes, span, usd: sessionSignals(file, { prices: PRICES }).usd };
}
