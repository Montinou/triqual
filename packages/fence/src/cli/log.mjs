// `fence log` (read-only, open to the agent): plain-text views over the decision log
// (spec, "Decision log, redaction, written-files index" and "CLI").
//
//   fence log [--state-dir d] [--session id] [--agent id] [view]
//
// views (at most one; the default lists the last DEFAULT_LAST decisions):
//   --denies           only denies, each with its rule id
//   --undecided        only undecided calls
//   --unknown-tools    tools seen that are in no known-tool table of their host (no rule can name them)
//   --agent id --reads the files read by one Claude subagent (agent_id), or by one Codex turn or session
//                      (Codex has no agent id: its entries group by session_id and turn_id)
//   --latency          p50 and p95 of the engine's own latency (total_ms and engine_ms)
// `--session` and `--agent` also filter the list views. There is no prune command: retention is applied
// at session start (log/prune.mjs). The state directory defaults to the engine's own default
// (~/.local/state/fence); `--state-dir` overrides it (tests).
//
// A log line is untrusted text (it carries command text the agent chose): output has its control
// characters replaced so it can not drive the terminal.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { lookupCodexTool, lookupTool } from '../hosts/tools.mjs';
import { parseLines } from '../log/log.mjs';

export const DEFAULT_LAST = 50;
const MAX_SUMMARY = 160;
const VIEWS = ['--denies', '--undecided', '--unknown-tools', '--reads', '--latency'];
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

class UsageError extends Error {}

export const defaultStateDir = (home = os.homedir()) => nodePath.join(home, '.local', 'state', 'fence');

function parseArgs(args, home) {
  const o = { stateDir: defaultStateDir(home), view: null, session: null, agent: null, reads: false };
  const setView = (v) => {
    if (o.view !== null && o.view !== v) throw new UsageError(`${o.view} and ${v} can not be combined`);
    o.view = v;
  };
  const value = (i, flag) => {
    const v = args[i + 1];
    if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--state-dir') o.stateDir = nodePath.resolve(value(i++, a));
    else if (a === '--session') o.session = value(i++, a);
    else if (a === '--agent') o.agent = value(i++, a);
    else if (a === '--reads') o.reads = true;
    else if (VIEWS.includes(a)) setView(a);
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (o.reads) {
    if (o.agent === null) throw new UsageError('--reads needs --agent <id>');
    setView('--reads');
  }
  return o;
}

// All lines of the log directory, oldest file first: {entries, bad}.
function readLog(stateDir, fsImpl) {
  const dir = nodePath.join(stateDir, 'log');
  let names;
  try {
    names = fsImpl.readdirSync(dir).filter((n) => DAY_FILE.test(n)).sort();
  } catch {
    return { entries: [], bad: 0 };
  }
  const entries = [];
  let bad = 0;
  for (const name of names) {
    try {
      const file = nodePath.join(dir, name);
      if (!fsImpl.lstatSync(file).isFile()) continue;
      const parsed = parseLines(fsImpl.readFileSync(file, 'utf8'));
      entries.push(...parsed.entries);
      bad += parsed.bad;
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

const clean = (v) => String(v).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');
const text = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const isDecision = (e) => typeof e.decision === 'string';
const isCompletion = (e) => e.phase === 'post';
const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);

function summary(e) {
  const call = e.call !== null && typeof e.call === 'object' ? e.call : {};
  let s;
  if (call.opaque) s = `[opaque: ${text(call.opaque.construct) || text(call.opaque.reason)}]`;
  else if (Array.isArray(call.commands) && call.commands.length > 0) s = call.commands.map((c) => strings(c?.argv).join(' ')).join(' ; ');
  else if (Array.isArray(call.paths) && call.paths.length > 0) s = call.paths.map((p) => `${text(p?.path)} (${text(p?.access)})`).join(', ');
  else if (typeof call.mcp === 'string') s = call.mcp;
  else if (typeof call.url === 'string') s = call.url;
  else s = '';
  s = clean(s);
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s;
}

function line(e) {
  if (isCompletion(e)) {
    const extra = [typeof e.response_bytes === 'number' ? `${e.response_bytes} bytes` : '', e.is_error === true ? 'error' : ''].filter(Boolean).join(', ');
    return clean(`${text(e.ts)}   completed ${text(e.tool)} ${text(e.tool_use_id)}${extra ? ` (${extra})` : ''}`);
  }
  const parts = [text(e.ts), text(e.decision).padEnd(9), text(e.tool), text(e.rule) || '-', summary(e)];
  if (typeof e.agent_id === 'string' && e.agent_id !== '') parts.push(`[agent ${e.agent_id}]`);
  return clean(parts.join(' ').trimEnd());
}

// Claude entries group by session; Codex entries by session and turn (Codex has no agent id).
function groupKey(e) {
  const host = text(e.host) || 'unknown';
  const turn = host === 'codex' && typeof e.turn_id === 'string' && e.turn_id !== '' ? ` turn ${e.turn_id}` : '';
  return `${host} session ${text(e.session_id) || '-'}${turn}`;
}

function grouped(entries, render) {
  const groups = new Map();
  for (const e of entries) {
    const k = groupKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const [k, list] of groups) {
    out.push(clean(`# ${k}`));
    for (const e of list) out.push(render(e));
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function latencyView(decisions) {
  const out = [`latency over ${decisions.length} decisions (ms)`];
  for (const key of ['total_ms', 'engine_ms']) {
    const values = decisions.map((e) => e.latency?.[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    out.push(p50 === null ? `${key.padEnd(9)} no data` : `${key.padEnd(9)} p50 ${p50}  p95 ${p95}`);
  }
  return out;
}

function unknownToolsView(decisions) {
  const seen = new Map();
  for (const e of decisions) {
    const tool = text(e.tool);
    const known = e.host === 'codex' ? lookupCodexTool(tool) !== null : e.host === 'claude' ? lookupTool(tool) !== null : lookupTool(tool) !== null || lookupCodexTool(tool) !== null;
    if (known || tool === '') continue;
    const key = `${text(e.host) || 'unknown'} ${tool}`;
    const row = seen.get(key) ?? { count: 0, last: '', outcomes: new Map() };
    row.count++;
    row.last = text(e.ts);
    const outcome = `${text(e.decision)}${e.rule ? `:${text(e.rule)}` : ''}`;
    row.outcomes.set(outcome, (row.outcomes.get(outcome) ?? 0) + 1);
    seen.set(key, row);
  }
  const out = [...seen].map(([key, row]) => {
    const outcomes = [...row.outcomes].map(([o, n]) => `${o} x${n}`).join(', ');
    return clean(`${key}  seen ${row.count}  last ${row.last}  ${outcomes}`);
  });
  out.push(`${seen.size} entries`);
  return out;
}

function readsOf(e) {
  const out = new Set();
  const call = e.call !== null && typeof e.call === 'object' ? e.call : {};
  for (const p of Array.isArray(call.paths) ? call.paths : []) if (p?.access === 'read' && typeof p.path === 'string') out.add(p.path);
  for (const c of Array.isArray(call.commands) ? call.commands : []) for (const r of strings(c?.reads)) out.add(r);
  for (const r of strings(e.scope?.reads)) out.add(r);
  return out;
}

// A denied call did not run, so it read nothing.
function readsView(decisions, id) {
  const groups = new Map();
  for (const e of decisions) {
    if (e.decision === 'deny') continue;
    const match = e.host === 'codex' ? e.turn_id === id || e.session_id === id : e.agent_id === id;
    if (!match) continue;
    const key = e.host === 'codex' ? groupKey(e) : `${text(e.host) || 'unknown'} session ${text(e.session_id) || '-'} agent ${id}`;
    if (!groups.has(key)) groups.set(key, new Set());
    for (const r of readsOf(e)) groups.get(key).add(r);
  }
  const out = [];
  let total = 0;
  for (const [key, files] of groups) {
    out.push(clean(`# ${key}`));
    for (const f of [...files].sort()) out.push(clean(f));
    total += files.size;
  }
  out.push(`${total} files`);
  return out;
}

// args: the arguments after `log`. opts: {fs, home} (tests).
export function runLog(args, io, { fs: fsImpl = nodeFs, home = os.homedir() } = {}) {
  let o;
  try {
    o = parseArgs(args, home);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`fence: log: ${err.message}`);
    io.err('usage: fence log [--state-dir d] [--session id] [--denies | --undecided | --unknown-tools | --agent id --reads | --latency]');
    return 1;
  }
  const { entries, bad } = readLog(o.stateDir, fsImpl);
  if (bad > 0) io.err(`fence: log: ${bad} unreadable log line${bad === 1 ? '' : 's'} skipped`);

  const inScope = (e) => (o.session === null || e.session_id === o.session) && (o.view === '--reads' || o.agent === null || e.agent_id === o.agent || (e.host === 'codex' && (e.turn_id === o.agent || e.session_id === o.agent)));
  const scoped = entries.filter(inScope);
  const decisions = scoped.filter(isDecision);
  let lines;
  if (o.view === '--latency') {
    lines = latencyView(decisions);
  } else if (o.view === '--unknown-tools') {
    lines = unknownToolsView(decisions);
  } else if (o.view === '--reads') {
    lines = readsView(decisions, o.agent);
  } else {
    let shown;
    if (o.view === '--denies') shown = decisions.filter((e) => e.decision === 'deny');
    else if (o.view === '--undecided') shown = decisions.filter((e) => e.decision === 'undecided');
    else if (o.session !== null) shown = scoped.filter((e) => isDecision(e) || isCompletion(e));
    else shown = decisions.slice(-DEFAULT_LAST);
    lines = [...grouped(shown, line), `${shown.length} entries`];
  }
  for (const l of lines) io.out(l);
  return 0;
}
