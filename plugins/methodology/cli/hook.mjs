#!/usr/bin/env node
// `triqual hook <event> --harness <id>` (spec Addendum F.3): the methodology hooks for Codex and Grok. The launcher
// ~/.local/bin/triqual-hook runs it through the triqual shim with the harness's hook payload on stdin.
//   Codex session-start, and Grok's first tool call: the session context, i.e. the methodology part (drift.mjs
//     --harness <id>: drift lines plus using-methodology, kept whole) and the progress-tracking part (gate.mjs
//     session-start --budget <n>), merged under 9,500 characters. It also starts the detached background run.
//   Codex stop: gate.mjs stop, a block forwarded as {"decision":"block","reason":…}.
//   Grok pre-tool-use / post-tool-use / post-compact: delivery state per session, so the context goes out once.
// Each part runs only while its plugin is enabled in Claude (user-scope enabledPlugins). Scripts get the environment
// Claude gives them, and one deadline per event (the harness timeout minus 2 s) is shared by drift and the gate.
// It never throws and always exits 0: any failure gives no output, and unknown input or an unexpected error one
// stderr line (never the payload).
//   node hook.mjs background --harness <id>   the detached background run (refresh; Codex: headjack cleanup)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pluginId } from './lib/brand.mjs';
import { EVENTS, HARNESS_IDS, HOOK_TIMEOUTS, formatBlock, formatContext, normalize } from './lib/harnesses.mjs';
import { enabledInClaude, resolvePlugin } from './lib/resolve.mjs';
import { readMethodologyConfig } from './lib/settings.mjs';
import { withLock } from './lib/lock.mjs';
import { writeAtomic } from './lib/fsx.mjs';

const METHODOLOGY = 'methodology';
const TRACKING = 'progress-tracking';
const TOTAL = 9500; // the merged context stays under this many characters (Grok clips at 10,000)
const SEPARATOR = '\n\n';
const DEADLINE_MARGIN_MS = 2000;
const CLEANUP_TIMEOUT_MS = 5000;
const SESSION_ID = /^[A-Za-z0-9_-]+$/; // a file name, never a path
const HOOK_FILE = fileURLToPath(import.meta.url);

const USAGE = `usage: node hook.mjs <event> --harness <id>
       node hook.mjs background --harness <id>

Runs a triqual hook for another harness, with the hook payload on stdin (triqual hook through triqual-hook).
  codex: session-start, stop
  grok:  pre-tool-use, post-tool-use, post-compact
Always exits 0; any failure prints nothing.
`;

// Claude's data dir of plugin `name`: <name>-<marketplace>, the marketplace of the id it is installed under.
const pluginData = (home, name) => join(home, '.claude', 'plugins', 'data',
  `${name}-${pluginId(home, name).slice(name.length + 1)}`);
const isEvent = (harness, event) => Object.hasOwn(EVENTS, harness) && EVENTS[harness].includes(event);

// One line on stderr (the launcher appends it to hook.log); a failing write is ignored.
function logLine(err) {
  try {
    process.stderr.write(`triqual hook: ${String(err?.message ?? err).replace(/\s*\n\s*/g, ' ')}\n`);
  } catch { /* never breaks the hook */ }
}

// text.slice(0, n), one shorter when that would split a surrogate pair.
function cut(text, n) {
  if (n <= 0) return '';
  const code = text.charCodeAt(n - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, n - 1) : text.slice(0, n);
}

// The room left for the gate part next to `methodologyPart`: the gate part, with the separator that joins it, is
// capped at max(0, total - methodologyPart.length - 3) characters, so the merged text stays under `total`.
function gateRoom(methodologyPart, total) {
  const cap = Math.max(0, total - methodologyPart.length - 3);
  return methodologyPart ? Math.max(0, cap - SEPARATOR.length) : cap;
}

// The merged session context: the methodology part whole, then the gate part cut to its room (above), joined by a
// blank line. An empty part leaves the other alone; null when both are empty.
export function mergeContext(methodologyPart, gatePart, total = TOTAL) {
  const m = typeof methodologyPart === 'string' ? methodologyPart : '';
  const g = cut(typeof gatePart === 'string' ? gatePart : '', gateRoom(m, total));
  if (!m && !g) return null;
  if (!g) return m;
  if (!m) return g;
  return `${m}${SEPARATOR}${g}`;
}

// The default runScript: the script under this node, with the payload on stdin, killed at timeoutMs.
export function runScript(path, args, { env, input, timeoutMs }) {
  const r = spawnSync(process.execPath, [path, ...args], {
    env, input, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'],
  });
  return { code: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

// The default background: this file's `background` entry, detached and unref'd, so it never delays the hook.
function spawnBackground({ harness }) {
  const child = spawn(process.execPath, [HOOK_FILE, 'background', '--harness', harness], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const parse = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};
const additionalContext = (stdout) => {
  const text = parse(stdout)?.hookSpecificOutput?.additionalContext;
  return typeof text === 'string' ? text : '';
};

// Runs one installed script of an enabled plugin before the deadline: its stdout, or null when the plugin is disabled
// in Claude, does not resolve for the cwd, or the deadline has passed.
function runPart(ctx, name, rel, args) {
  const id = pluginId(ctx.home, name);
  if (!enabledInClaude(ctx.home, id)) return null;
  const root = ctx.resolve(id, ctx.input.cwd);
  if (typeof root !== 'string' || root === '') return null;
  const timeoutMs = ctx.deadline - ctx.now();
  if (timeoutMs <= 0) return null;
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_DATA: pluginData(ctx.home, name),
    CLAUDE_PROJECT_DIR: ctx.input.cwd,
  };
  const r = ctx.runScript(join(root, rel), args, { env, input: JSON.stringify(ctx.input), timeoutMs });
  return typeof r?.stdout === 'string' ? r.stdout : '';
}

// The session context (methodology part, then the gate part fitted to what is left), or null. Starts the background
// run first, without waiting for it.
function sessionRun(ctx) {
  try {
    const pending = ctx.background({ home: ctx.home, harness: ctx.harness });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* background work never affects the hook */ }
  const m = additionalContext(runPart(ctx, METHODOLOGY, join('cli', 'drift.mjs'), ['--harness', ctx.harness]) ?? '');
  const budget = gateRoom(m, TOTAL);
  // No room left next to the methodology part: the gate is not run at all.
  const gateArgs = ['session-start', '--budget', String(budget)];
  const g = budget > 0 ? additionalContext(runPart(ctx, TRACKING, join('scripts', 'gate.mjs'), gateArgs) ?? '') : '';
  return mergeContext(m, g);
}

function codexStop(ctx) {
  const out = runPart(ctx, TRACKING, join('scripts', 'gate.mjs'), ['stop']);
  const verdict = out ? parse(out) : null;
  if (verdict?.decision !== 'block' || typeof verdict.reason !== 'string') return null;
  return formatBlock('codex', verdict.reason);
}

// ---- Grok delivery state (F.3): { delivered, pending: [toolUseId…], batchOpen, attempted } per session ----

const grokStatePath = (home, sessionId) => join(pluginData(home, METHODOLOGY), 'harness', 'grok', `${sessionId}.json`);
const FRESH = () => ({ delivered: false, pending: [], batchOpen: false, attempted: false });

function readGrokState(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return FRESH();
  }
  if (!raw || typeof raw !== 'object') return FRESH();
  return {
    delivered: raw.delivered === true,
    pending: Array.isArray(raw.pending) ? raw.pending.filter((id) => typeof id === 'string') : [],
    batchOpen: raw.batchOpen === true,
    attempted: raw.attempted === true,
  };
}

const writeGrokState = (path, state) => writeAtomic(path, `${JSON.stringify(state)}\n`);

// A batch is the run of PreToolUse events since the last PostToolUse. pre-tool-use emits unless delivered, or unless
// the open batch already holds a pending id; an emit adds its toolUseId to pending. post-tool-use for any pending id
// records delivered, and every post-tool-use closes the batch. post-compact deletes the state.
// Two guards keep a quiet session quiet: an attempt that yields no text (both plugins disabled in Claude, nothing
// resolves) sets `attempted`, so the session context and its background run are tried once per session, not on every
// tool call. It latches on a transient failure too: a drift or gate run that fails or times out once and yields no
// text leaves the session without context until a post-compact clears the state. And an emit with no toolUseId, which
// no PostToolUse can confirm, counts as delivered at once, so the context is not re-sent every batch (a denied call of
// that kind loses it; the rules file covers turn 1).
async function grokEvent(ctx) {
  const { input, event } = ctx;
  if (input.subagent) return null;
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  const path = grokStatePath(ctx.home, sessionId);
  const { locked, value } = await withLock(path, () => {
    if (event === 'post-compact') {
      try { unlinkSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      return null;
    }
    const state = readGrokState(path);
    if (event === 'post-tool-use') {
      if (input.tool_use_id !== null && state.pending.includes(input.tool_use_id)) {
        state.delivered = true;
        state.pending = [];
      }
      state.batchOpen = false;
      writeGrokState(path, state);
      return null;
    }
    // pre-tool-use
    const held = state.batchOpen && state.pending.length > 0;
    let stdout = null;
    if (!state.delivered && !held && !state.attempted) {
      const text = sessionRun(ctx);
      if (text === null) {
        state.attempted = true;
      } else {
        stdout = formatContext('grok', 'pre-tool-use', text);
        if (input.tool_use_id !== null) state.pending.push(input.tool_use_id);
        else state.delivered = true;
      }
    }
    state.batchOpen = true;
    writeGrokState(path, state);
    return stdout;
  });
  return locked ? value : null;
}

// ---- entry points ----

// Unknown input: no output, one stderr line (never the payload itself).
function ignored(why) {
  logLine(`ignored: ${why}`);
  return { stdout: null };
}

// Runs one hook event: { stdout } with the JSON to print, or null for nothing. Never throws.
export async function hook({
  home, harness, event, payload, resolve, runScript: run = runScript, background = spawnBackground, now = Date.now,
}) {
  try {
    const start = now();
    if (!Object.hasOwn(EVENTS, harness)) return ignored(`unknown harness ${harness}`);
    if (!isEvent(harness, event)) return ignored(`${harness} has no ${event} hook`);
    const input = normalize(harness, event, payload);
    if (input === null) return ignored(`${harness} ${event} payload not recognized`);
    const ctx = {
      home, harness, event, input, resolve, runScript: run, background, now,
      deadline: start + HOOK_TIMEOUTS[harness][event] * 1000 - DEADLINE_MARGIN_MS,
    };
    if (harness === 'codex') {
      if (event === 'session-start') {
        const text = sessionRun(ctx);
        return { stdout: text === null ? null : formatContext('codex', 'session-start', text) };
      }
      return { stdout: codexStop(ctx) };
    }
    return { stdout: await grokEvent(ctx) };
  } catch (err) {
    logLine(err);
    return { stdout: null };
  }
}

// The default `run` for background work: { code, stdout: '', stderr: '' }, killed at timeoutMs. Its output is
// discarded (stdio 'ignore'): nothing reads it, and a detached child has no terminal to write to.
function realRun(cmd, args, { timeoutMs, cwd }) {
  const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', stdio: 'ignore' });
  return { code: r.status ?? 1, stdout: '', stderr: '' };
}

// The background entry: refresh (the CLI passes refreshHarness: the Codex skill links and role agents), then for Codex
// `headjack cleanup --older-than 48h` when ~/.local/bin/headjack exists, output discarded. Nothing runs when
// config.json records the harness as removed (`harnesses.<id>.enabled === false`). Never throws.
export async function backgroundRun({ home, harness, run, refresh = async () => {} }) {
  if (readMethodologyConfig(home).harnesses[harness]?.enabled === false) return; // never throws
  try {
    await refresh();
  } catch (err) {
    logLine(err);
  }
  if (harness !== 'codex') return;
  try {
    const headjack = join(home, '.local', 'bin', 'headjack');
    if (existsSync(headjack)) {
      await run(headjack, ['cleanup', '--older-than', '48h'], { timeoutMs: CLEANUP_TIMEOUT_MS, cwd: home });
    }
  } catch (err) {
    logLine(err);
  }
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function harnessArg(argv) {
  const i = argv.indexOf('--harness');
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const home = homedir();
  const [event] = argv;
  const harness = harnessArg(argv);
  if (event === 'background') {
    // harness-sync is loaded here only, off the hot path of every tool-call hook; a failed load is logged by
    // backgroundRun like any refresh error.
    const refresh = async () => {
      const { refreshHarness } = await import('./lib/harness-sync.mjs');
      return refreshHarness({ home, id: harness });
    };
    if (HARNESS_IDS.includes(harness)) await backgroundRun({ home, harness, run: realRun, refresh });
    return;
  }
  let payload = null;
  try {
    const raw = await readStdin();
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  const { stdout } = await hook({
    home, harness, event, payload, resolve: (id, cwd) => resolvePlugin(home, id, cwd),
  });
  if (stdout !== null) process.stdout.write(stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    logLine(err);
  }
  process.exitCode = 0;
}
