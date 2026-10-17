// Append-only decision log (spec, "Decision log, redaction, written-files index").
//
//   appendDecision(stateDir, entry, {now, fs}) -> {ok: boolean}
//   decisionEntry(info) -> the log entry for one PreToolUse decision (see below)
//   parseLines(text) -> {entries, bad}   the reader: one JSON object per non-blank line
//
// appendDecision redacts every string of the entry (redact.mjs), then appends one line to
// <stateDir>/log/YYYY-MM-DD.jsonl (UTC date; directory 0700, file 0600, O_APPEND) in the shape and with the
// 4096-byte cap of the watchdog's own appender (watchdog/line.mjs): oversized strings are cut, longest first,
// with the `…[truncated]` marker, so the line stays valid JSON and the append stays atomic. It never throws.
//
// decisionEntry: Write/Edit content is never logged, only the path and a byte count; `raw` (the command
// text) appears only on a deny and on an opaque call, never on a hatch line; an apply_patch envelope inside
// any string of the entry is replaced by its byte count, and `call.bytes` carries the envelope size.

import { appendLine } from '../watchdog/line.mjs';
import { redact } from './redact.mjs';

export function appendDecision(stateDir, entry, { now = Date.now, fs } = {}) {
  try {
    const opts = fs === undefined ? { now } : { now, fs };
    return { ok: appendLine(stateDir, redact(entry), opts) === true };
  } catch {
    return { ok: false };
  }
}

export function parseLines(text) {
  const entries = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) entries.push(v);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

const CONTENT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATCH_MARK = '*** Begin Patch';
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// Bytes of an apply_patch envelope inside a text: from its first line to its End Patch line (or the end).
const PATCH_END = '*** End Patch';
function envelopeBytes(text) {
  const start = text.indexOf(PATCH_MARK);
  if (start < 0) return undefined;
  const end = text.indexOf(PATCH_END, start);
  return bytes(text.slice(start, end < 0 ? text.length : end + PATCH_END.length));
}

// Bytes of the content a file-writing tool call carries (never the content itself): the content of
// Write/Edit-style tools, the whole envelope of an apply_patch (direct, or inside a shell command).
function contentBytes(tool, input, command) {
  if (typeof command === 'string') {
    const inShell = envelopeBytes(command);
    if (inShell !== undefined) return inShell;
  }
  if (input !== null && typeof input === 'object' && typeof input.command === 'string' && /^apply_?patch$/i.test(String(tool))) {
    return envelopeBytes(input.command) ?? bytes(input.command);
  }
  if (!CONTENT_TOOLS.has(tool) || input === null || typeof input !== 'object') return undefined;
  const size = (v) => (typeof v === 'string' ? bytes(v) : 0);
  let total = size(input.content) + size(input.new_string) + size(input.new_source);
  if (Array.isArray(input.edits)) for (const e of input.edits) total += size(e?.new_string);
  return total;
}

// Strings of a JSON tree with an apply_patch envelope replaced by its size.
function dropPatches(node) {
  if (typeof node === 'string') return node.includes(PATCH_MARK) ? `[apply_patch content omitted, ${bytes(node)} bytes]` : node;
  if (Array.isArray(node)) return node.map(dropPatches);
  if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, dropPatches(v)]));
  return node;
}

function callView(parsed, normalized, call, payload) {
  const view = {};
  if (normalized?.opaque) {
    const { reason, construct } = normalized.opaque;
    view.opaque = { reason, construct };
  } else if (Array.isArray(normalized?.commands)) {
    view.commands = normalized.commands.map((c) => ({
      argv: c.argv,
      cwd: c.cwd,
      classes: c.classes,
      reads: c.reads,
      writes: c.writes,
      domains: c.domains,
    }));
  }
  if (Array.isArray(call?.paths) && call.paths.length > 0) view.paths = call.paths.map((p) => ({ path: p.path, access: p.access }));
  if (parsed?.mcp !== undefined) view.mcp = parsed.mcp;
  if (parsed?.url !== undefined) view.url = parsed.url;
  const size = contentBytes(parsed?.tool, payload?.tool_input, parsed?.command);
  if (size !== undefined) view.bytes = size;
  return view;
}

// info: {parsed, normalized, call, payload, decision, profile, policySha, engineVersion, latency, recordOnly}
export function decisionEntry(info) {
  const { parsed, normalized, call, payload, decision, recordOnly } = info;
  const view = dropPatches(callView(parsed, normalized, call, payload));
  const opaque = view.opaque !== undefined;
  const logged = recordOnly ? 'hatch' : decision.decision;
  const entry = {
    host: parsed?.host ?? null,
    session_id: parsed?.session_id ?? null,
    turn_id: parsed?.turn_id ?? null,
    agent_id: parsed?.agent_id ?? null,
    agent_type: parsed?.agent_type ?? null,
    tool: parsed?.tool ?? null,
    tool_use_id: parsed?.tool_use_id ?? null,
    permission_mode: parsed?.permission_mode ?? null,
    profile: info.profile ?? null,
    cwd: parsed?.cwd ?? null,
    repo: call?.repo ?? null,
    call: view,
    decision: logged,
    rule: decision.rule ?? null,
    scope: dropPatches(decision.scope ?? null),
    latency: info.latency,
    engine_version: info.engineVersion ?? null,
    policy_sha: info.policySha ?? null,
  };
  if (logged !== 'hatch' && (logged === 'deny' || opaque) && typeof parsed?.command === 'string') entry.raw = dropPatches(parsed.command);
  return entry;
}
