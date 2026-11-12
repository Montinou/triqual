// Per-session signals from Claude Code transcripts (the evals data source): cost, context size, compactions, idle cache
// rewrites, stop-hook blocks, tool errors, user prompts. Read-only; node: built-ins only. A transcript repeats an
// assistant message per content block, so a turn is counted once per message id and request id (as cost.mjs).
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const IDLE_MS = 300_000;
const n = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

// The price rule of cost.mjs: the model name, else without a date suffix and a trailing [..]; null when unlisted.
export function priceOf(model, prices) {
  return prices[model] ?? prices[model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')] ?? null;
}

const usdOf = (p, u) => (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead
  + (u.cacheWrite - u.cacheWrite1h) * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h) / 1e6;

const isPrompt = (c) => typeof c === 'string'
  || (Array.isArray(c) && c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result'));

export function sessionSignals(file, { prices }) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* an unreadable file has no signals */ }
  // Null-prototype map: a model name is only ever a key (`__proto__` included).
  const models = Object.create(null);
  const seen = new Set();
  const unpriced = new Set();
  const sig = {
    sessionId: basename(file).replace(/\.jsonl$/, ''), project: null, entrypoint: null, start: null, end: null, models,
    usd: 0, turns: 0, ctxPeak: 0, ctxAvg: 0, compactions: 0, idleRewrites: 0, rewriteUsd: 0, stopHookBlocks: 0,
    toolErrors: 0, userMessages: 0, unpriced: [], arm: null, contaminated: false,
  };
  let first = true;
  let ctxSum = 0;
  let prevAt = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec === null || typeof rec !== 'object') continue;
    if (first) { sig.entrypoint = typeof rec.entrypoint === 'string' ? rec.entrypoint : null; first = false; }
    if (sig.project === null && typeof rec.cwd === 'string' && rec.cwd !== '') sig.project = rec.cwd;
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (at !== null && !Number.isNaN(Date.parse(at))) {
      if (sig.start === null || at < sig.start) sig.start = at;
      if (sig.end === null || at > sig.end) sig.end = at;
    }
    const msg = rec.message;
    if (rec.type === 'system') {
      if (rec.subtype === 'compact_boundary') sig.compactions += 1;
      else if (rec.subtype === 'stop_hook_summary' && Array.isArray(rec.hookErrors) && rec.hookErrors.length > 0) sig.stopHookBlocks += 1;
    } else if (rec.type === 'user') {
      const c = msg?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result' && b.is_error === true) sig.toolErrors += 1;
      if (rec.isMeta !== true && isPrompt(c)) sig.userMessages += 1;
    } else if (rec.type === 'assistant') {
      const u = msg?.usage;
      if (typeof msg?.model !== 'string' || msg.model.startsWith('<') || u === null || typeof u !== 'object') continue;
      const id = `${msg.id ?? ''}\0${rec.requestId ?? ''}`;
      if (id !== '\0') { if (seen.has(id)) continue; seen.add(id); }
      const t = {
        input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens),
        cacheWrite: n(u.cache_creation_input_tokens), cacheWrite1h: 0,
      };
      t.cacheWrite1h = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), t.cacheWrite);
      const p = priceOf(msg.model, prices);
      if (p === null) unpriced.add(msg.model);
      const m = models[msg.model] ??= { messages: 0, usd: p === null ? null : 0 };
      m.messages += 1;
      sig.turns += 1;
      const ctx = t.input + t.cacheRead + t.cacheWrite;
      ctxSum += ctx;
      if (ctx > sig.ctxPeak) sig.ctxPeak = ctx;
      if (p !== null) {
        const usd = usdOf(p, t);
        m.usd += usd;
        sig.usd += usd;
      }
      const ms = at === null ? NaN : Date.parse(at);
      if (prevAt !== null && !Number.isNaN(ms) && ms - prevAt > IDLE_MS && t.cacheWrite > 0 && t.cacheWrite >= 0.5 * ctx) {
        sig.idleRewrites += 1;
        if (p !== null) sig.rewriteUsd += ((t.cacheWrite - t.cacheWrite1h) * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
      }
      if (!Number.isNaN(ms)) prevAt = ms;
    }
  }
  sig.ctxAvg = sig.turns === 0 ? 0 : ctxSum / sig.turns;
  sig.unpriced = [...unpriced].sort();
  sig.models = { ...models };
  return sig;
}

// Top-level *.jsonl of each project directory under `root` (never a `subagents/` or deeper file), skipping project
// directories whose name contains `-claude-mem`. `projectDir` is the directory name.
export function mainTranscripts(root) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    if (d.name.includes('-claude-mem')) continue;
    let files = [];
    try { files = readdirSync(join(root, d.name), { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: join(root, d.name, f.name), projectDir: d.name });
    }
  }
  return out;
}
