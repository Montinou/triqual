#!/usr/bin/env node
// Collects the numbers of a performance audit of the triqual plugins into one JSON file per dataset, read-only:
// `node collect.mjs --out <dir> [--days 10] [--project triqual] [--hooks]`. Late window = the last --days UTC days
// (today included); early window = the --days before it. Datasets (arrays of row objects, written to <out>/<name>.json):
// cost_by_role, controller_sessions, latency, tier_by_day, hunter_yield, hooks (with --hooks). USD is an ESTIMATE at
// cli/lib/prices.json. It prints counts and role names, never message content. Exit 0 done, 2 usage.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { storePath } from '../../../cli/lib/role-eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginsRoot = join(here, '..', '..', '..', '..');
const PRICES = JSON.parse(readFileSync(join(here, '..', '..', '..', 'cli', 'lib', 'prices.json'), 'utf8')).models;
const HOOK_RUNS = 7;
const ORCHESTRATOR = /^(?:roles:)?phase-orchestrator$/;

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const out = opt('out');
const days = Number(opt('days', '10'));
const project = opt('project', 'triqual');
if (!out || !Number.isInteger(days) || days < 1) { process.stderr.write('usage: collect.mjs --out <dir> [--days N] [--project <text>] [--hooks]\n'); process.exit(2); }

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const windows = { late: { since: day(-(days - 1)), until: day(0) }, early: { since: day(-(2 * days - 1)), until: day(-days) } };
const windowOf = (d) => Object.entries(windows).find(([, w]) => d >= w.since && d <= w.until)?.[0];
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(0.9 * (s.length - 1))] : 0; };

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []));
const root = process.env.TRIQUAL_TRANSCRIPTS_DIR || join(process.env.HOME || homedir(), '.claude', 'projects');
const files = existsSync(root) ? readdirSync(root).filter((d) => d.includes(project)).flatMap((d) => walk(join(root, d))) : [];

const agentType = (path) => {
  if (!path.includes('/subagents/')) return 'controller';
  try { return JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || 'unknown'; } catch { return 'unknown'; }
};

const usd = (p, u) => {
  const cw = u.cache_creation_input_tokens || 0;
  const w1 = Math.min(u.cache_creation?.ephemeral_1h_input_tokens || 0, cw);
  return {
    read: ((u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6,
    write: ((cw - w1) * p.cacheWrite5m + w1 * p.cacheWrite1h) / 1e6,
    out: ((u.output_tokens || 0) * p.output) / 1e6,
    inp: ((u.input_tokens || 0) * p.input) / 1e6,
  };
};

const seen = new Set();
const byRole = new Map();
const sessions = [];
const durations = new Map();
for (const file of files) {
  const type = agentType(file);
  const sub = type !== 'controller';
  const session = { usd: 0, msgs: 0, read: 0, write: 0, out: 0, cacheRead: 0, window: null };
  const stamps = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.indexOf('"timestamp":"');
    if (t >= 0) stamps.push(line.slice(t + 13, t + 37));
    if (!line.includes('"usage"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const msg = rec.message, u = msg?.usage, p = PRICES[msg?.model];
    const w = windowOf((rec.timestamp || '').slice(0, 10));
    if (!u || !p || !w) continue;
    const id = `${msg.id || ''}|${rec.requestId || ''}`;
    if (id !== '|') { if (seen.has(id)) continue; seen.add(id); }
    const c = usd(p, u), total = c.read + c.write + c.out + c.inp;
    const key = `${w}|${type}|${msg.model}`;
    const r = byRole.get(key) || { period: w, role: type, model: msg.model, usd: 0, msgs: 0, out_tokens: 0, cache_read_m: 0, files: new Set() };
    r.usd += total; r.msgs += 1; r.out_tokens += u.output_tokens || 0; r.cache_read_m += (u.cache_read_input_tokens || 0) / 1e6; r.files.add(file);
    byRole.set(key, r);
    if (!sub) { session.usd += total; session.msgs += 1; session.read += c.read; session.write += c.write; session.out += c.out; session.cacheRead += u.cache_read_input_tokens || 0; session.window = w; }
  }
  if (!sub && session.msgs) sessions.push(session);
  if (sub && stamps.length > 1) {
    const w = windowOf(stamps[0].slice(0, 10));
    if (w === 'late') { const list = durations.get(type) || []; list.push((Date.parse(stamps.at(-1)) - Date.parse(stamps[0])) / 6e4); durations.set(type, list); }
  }
}

const write = (name, rows) => { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.json`), `${JSON.stringify(rows, null, 1)}\n`); process.stdout.write(`${name}: ${rows.length} rows\n`); };

write('cost_by_role', [...byRole.values()].map((r) => ({ period: r.period, role: r.role, model: r.model, usd: round(r.usd), runs: r.files.size, msgs: r.msgs, out_tokens: r.out_tokens, cache_read_m: round(r.cache_read_m, 1), usd_per_run: round(r.usd / r.files.size) })).filter((r) => r.usd >= 0.5).sort((a, b) => b.usd - a.usd));

write('controller_sessions', sessions.filter((s) => s.window === 'late').sort((a, b) => b.usd - a.usd).slice(0, 10).map((s, i) => ({
  rank: i + 1, usd: round(s.usd, 1), msgs: s.msgs, avg_context_k: Math.round(s.cacheRead / s.msgs / 1000),
  cache_read_pct: Math.round((100 * s.read) / s.usd), cache_write_pct: Math.round((100 * s.write) / s.usd), output_pct: Math.round((100 * s.out) / s.usd),
})));

write('latency', [...durations.entries()].map(([role, v]) => ({ role, runs: v.length, median_min: round(median(v), 1), p90_min: round(p90(v), 1), total_h: round(v.reduce((a, b) => a + b, 0) / 60, 1) })).sort((a, b) => b.total_h - a.total_h));

const { file } = storePath(process.env, process.env.HOME || homedir());
const records = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const reviews = records.filter((r) => r.kind === 'task-review' && !r.coordinator);
const perDay = new Map();
for (const r of reviews) {
  const d = r.at.slice(0, 10);
  const row = perDay.get(d) || { day: d, tasks: 0, light: 0, standard: 0, heavy: 0, declared_light: 0, fix_rounds: 0 };
  row.tasks += 1; row[r.tier] += 1; row.fix_rounds += r.fixRounds || 0; if (r.declaredTier === 'light') row.declared_light += 1;
  perDay.set(d, row);
}
write('tier_by_day', [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)));

const yieldRows = new Map();
for (const r of reviews) for (const h of r.hunters || []) {
  const k = `${r.tier}|${h.category}`;
  const y = yieldRows.get(k) || { tier: r.tier, category: h.category, runs: 0, candidates: 0, critical: 0, important: 0, minor: 0, refuted: 0 };
  y.runs += 1; y.candidates += h.candidates; y.critical += h.confirmed.critical; y.important += h.confirmed.important; y.minor += h.confirmed.minor; y.refuted += h.refuted;
  yieldRows.set(k, y);
}
write('hunter_yield', [...yieldRows.values()].map((y) => ({ ...y, precision_pct: Math.round((100 * (y.critical + y.important + y.minor)) / Math.max(1, y.candidates)), important_per_100_runs: round((100 * (y.critical + y.important)) / y.runs, 1) })));

if (args.includes('--hooks')) {
  const time = (cmd, plugin, input = '') => {
    const xs = [];
    for (let i = 0; i < HOOK_RUNS; i += 1) { const s = process.hrtime.bigint(); spawnSync('node', cmd, { input, env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(pluginsRoot, plugin) }, stdio: ['pipe', 'ignore', 'ignore'] }); xs.push(Number(process.hrtime.bigint() - s) / 1e6); }
    return Math.round(median(xs));
  };
  const p = (plugin, ...rest) => [join(pluginsRoot, plugin, ...rest)];
  const event = '{"hook_event_name":"PostToolUse","session_id":"audit","tool_name":"Bash"}';
  write('hooks', [
    { hook: 'node startup (floor)', blocking: 'no', median_ms: time(['-e', '0'], 'methodology') },
    { hook: 'methodology SessionStart', blocking: 'yes', median_ms: time(p('methodology', 'cli', 'drift.mjs'), 'methodology') },
    { hook: 'progress-tracking SessionStart', blocking: 'yes', median_ms: time([...p('progress-tracking', 'scripts', 'gate.mjs'), 'session-start'], 'progress-tracking') },
    { hook: 'progress-tracking Stop', blocking: 'yes', median_ms: time([...p('progress-tracking', 'scripts', 'gate.mjs'), 'stop'], 'progress-tracking') },
    { hook: 'progress-tracking tool recorder', blocking: 'no', median_ms: time(p('progress-tracking', 'scripts', 'session-event.mjs'), 'progress-tracking', event) },
    { hook: 'workflow-gate Agent', blocking: 'yes', median_ms: time([...p('workflow-gate', 'scripts', 'gate.mjs'), 'agent'], 'workflow-gate', '{"tool_name":"Agent","session_id":"audit","tool_input":{"subagent_type":"roles:hunter"}}') },
  ]);
}
process.stdout.write(`windows: early ${windows.early.since}..${windows.early.until}, late ${windows.late.since}..${windows.late.until}\n`);
