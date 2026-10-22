// `triqual cost [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <text>] [--json]`: the token spend in this
// machine's Claude Code transcripts (<root>/<project dir>/**/*.jsonl; root ~/.claude/projects, or
// TRIQUAL_TRANSCRIPTS_DIR), per model, split into the main session transcripts (controller) and the subagent ones (a
// path with a `subagents` directory; of those, the ones whose sibling agent-<id>.meta.json names agentType
// `phase-orchestrator` are reported apart as orchestrators), with an estimated USD from lib/prices.json. Read-only;
// it prints counts, model names and project directory names, never message content, prompts or other paths. An
// assistant message is counted once per message id and request id (a transcript repeats it per content block).
// Exit codes: 0 a report (zeros when there are no transcripts), 2 usage.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'prices.json'), 'utf8')).models;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = [
  'usage:',
  '  triqual cost [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <text>] [--json]',
  '      Tokens per model (input, output, cache read, cache write) in the Claude Code transcripts of this machine,',
  '      controller (main sessions), orchestrators (phase-orchestrator subagents) and the other subagents apart,',
  '      between --since and --until (UTC days, both included),',
  '      in the project directories whose name contains --project (default: all). The USD is an ESTIMATE at the list',
  '      prices in the methodology plugin\'s cli/lib/prices.json; a model not listed there shows tokens and no price.',
  '      For one plan, pass its first and last day as --since/--until: the ledger\'s event times are not read.',
  '      Transcripts: ~/.claude/projects, or TRIQUAL_TRANSCRIPTS_DIR. Read-only; prints project directory names only,',
  '      never message content or other paths. A transcript or subagent meta file it cannot read is unreadable.',
  '  triqual cost --help',
  '',
].join('\n');

const realDay = (t) => DAY.test(t) && new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) === t;
const n = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

// Every *.jsonl below `dir`, with whether it lies under a `subagents` directory.
function transcripts(dir, sub = false, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) transcripts(join(dir, e.name), sub || e.name === 'subagents', out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: join(dir, e.name), sub });
  }
  return out;
}

function priceOf(model) {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')] ?? null;
}

// Whether the subagent transcript at `path` is a phase orchestrator, from its sibling agent-<id>.meta.json. No meta file
// (older transcripts have none) is a plain subagent; one that exists but cannot be read or parsed is a plain subagent
// too and is reported through `onUnreadable`.
const ORCHESTRATOR = /^(?:roles:)?phase-orchestrator$/;
function isOrchestrator(path, onUnreadable) {
  let text;
  try { text = readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') onUnreadable();
    return false;
  }
  try { return ORCHESTRATOR.test(JSON.parse(text)?.agentType); } catch { onUnreadable(); return false; }
}

// { since, until, projects, controller: { model: totals }, orchestrators: { ... }, subagents: { ... }, totalUsd,
//   unpriced, unreadable }.
export function collect(root, { since, until, project }) {
  // Null-prototype maps: a model name is only ever a key (`__proto__` included).
  const groups = { controller: Object.create(null), orchestrators: Object.create(null), subagents: Object.create(null) };
  const seen = new Set();
  const projects = [];
  let unreadable = 0;
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* no transcripts */ }
  for (const d of dirs) {
    if (project && !d.name.includes(project)) continue;
    projects.push(d.name);
    for (const { path, sub } of transcripts(join(root, d.name))) {
      let text;
      // A file it cannot read (permissions, or past the ~512 MB string limit) is counted, never silently skipped.
      try { text = readFileSync(path, 'utf8'); } catch { unreadable += 1; continue; }
      const group = !sub ? 'controller' : isOrchestrator(path, () => { unreadable += 1; }) ? 'orchestrators' : 'subagents';
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const msg = rec?.message;
        const u = msg?.usage;
        if (typeof msg?.model !== 'string' || msg.model.startsWith('<') || u === null || typeof u !== 'object') continue;
        const day = typeof rec.timestamp === 'string' ? rec.timestamp.slice(0, 10) : '';
        // With a window, a record with no usable timestamp is always left out.
        if ((since || until) && !DAY.test(day)) continue;
        if ((since && day < since) || (until && day > until)) continue;
        const id = `${msg.id ?? ''}\0${rec.requestId ?? ''}`;
        if (id !== '\0') { if (seen.has(id)) continue; seen.add(id); }
        const t = groups[group][msg.model] ??= {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, messages: 0,
        };
        t.input += n(u.input_tokens);
        t.output += n(u.output_tokens);
        t.cacheRead += n(u.cache_read_input_tokens);
        t.cacheWrite += n(u.cache_creation_input_tokens);
        t.cacheWrite1h += Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), n(u.cache_creation_input_tokens));
        t.messages += 1;
      }
    }
  }
  let totalUsd = 0;
  let unpriced = false;
  for (const bucket of Object.values(groups)) {
    for (const [model, t] of Object.entries(bucket)) {
      const p = priceOf(model);
      const { cacheWrite1h, ...shown } = t;
      if (p === null) unpriced = true;
      const usd = p === null ? null : (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead
        + (t.cacheWrite - cacheWrite1h) * p.cacheWrite5m + cacheWrite1h * p.cacheWrite1h) / 1e6;
      bucket[model] = { ...shown, usd };
      totalUsd += usd ?? 0;
    }
  }
  return { since: since ?? null, until: until ?? null, projects, ...groups, totalUsd, unpriced, unreadable };
}

const fmt = (v) => v.toLocaleString('en-US');

function format(r) {
  const out = [`Window: ${r.since ?? 'start'} .. ${r.until ?? 'now'} (UTC days), ${r.projects.length} project(s)`];
  for (const name of ['controller', 'orchestrators', 'subagents']) {
    out.push('', name);
    const models = Object.keys(r[name]).sort();
    if (models.length === 0) out.push('  (none)');
    for (const m of models) {
      const t = r[name][m];
      out.push(`  ${m}: input ${fmt(t.input)}, output ${fmt(t.output)}, cache read ${fmt(t.cacheRead)}, `
        + `cache write ${fmt(t.cacheWrite)}, ${t.usd === null ? 'no price' : `~$${t.usd.toFixed(2)}`}`);
    }
  }
  out.push('', `Total: ~$${r.totalUsd.toFixed(2)}, an estimate at list prices (cli/lib/prices.json)`
    + `${r.unpriced ? '; models with no price are left out of it' : ''}.`);
  return `${out.join('\n')}\n`;
}

// Runs the command and returns its exit code; every dependency is injected so a test never reads the real transcripts.
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const usage = (m) => { stderr.write(`triqual cost: ${m}\n${USAGE}`); return 2; };
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { stdout.write(USAGE); return 0; }
    if (arg === '--json') { json = true; continue; }
    const m = /^--(since|until|project)(?:=(.*))?$/s.exec(arg);
    if (!m) return usage(`unknown argument ${arg.length > 40 ? `${arg.slice(0, 40)}...` : arg}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return usage(`--${m[1]} needs a value`);
    if (m[1] !== 'project' && !realDay(value)) return usage(`--${m[1]} needs a calendar date, YYYY-MM-DD`);
    opts[m[1]] = value;
  }
  if (opts.since && opts.until && opts.since > opts.until) {
    stderr.write(`triqual cost: --since ${opts.since} is after --until ${opts.until}\n`);
    return 2;
  }
  const root = env.TRIQUAL_TRANSCRIPTS_DIR || join(env.HOME || homedir(), '.claude', 'projects');
  const result = collect(root, opts);
  if (result.unreadable > 0) stderr.write(`${result.unreadable} transcripts unreadable\n`);
  stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : format(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
