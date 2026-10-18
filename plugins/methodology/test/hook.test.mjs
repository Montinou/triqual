import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hook, backgroundRun, mergeContext } from '../cli/hook.mjs';
import { sessionContext as driftContext } from '../cli/drift.mjs';
import { sessionContext as gateContext } from '../../progress-tracking/scripts/gate.mjs';
import { NO_PENDING } from '../../progress-tracking/lib/store-hooks.mjs';
import { formatBlock, formatContext } from '../cli/lib/harnesses.mjs';
import { BRAND } from '../cli/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const HOOK = join(PLUGIN_ROOT, 'cli', 'hook.mjs');
const FIXTURES = join(TEST_DIR, 'fixtures', 'harness');

// The fixture home knows no marketplace and has nothing installed: the plugins resolve under triqual.
const METHODOLOGY = `methodology@${BRAND.marketplace}`;
const TRACKING = `progress-tracking@${BRAND.marketplace}`;
const M_ROOT = '/installs/methodology/0.3.0';
const PT_ROOT = '/installs/progress-tracking/0.2.3';
const DRIFT = join(M_ROOT, 'cli', 'drift.mjs');
const GATE = join(PT_ROOT, 'scripts', 'gate.mjs');
const resolve = (id) => ({ [METHODOLOGY]: M_ROOT, [TRACKING]: PT_ROOT })[id] ?? null;

const HEADER = 'This repo uses strict progress tracking (skill progress-tracking:progress-tracking)';
const ENTRY = '# Progress\n\n## 2026-09-29 — Hook\n- done\n';
const TRACKED = { mode: 'committed', progress: '/r/progress.md', status: '/r/status.md', root: '/r' };

// The environment the hook helpers detect fence in: a PATH with nothing on it, so a fence installed on this machine
// never changes a test. A test that wants fence passes `env` with the directory withFence() makes.
const NO_FENCE_ENV = { PATH: join(tmpdir(), 'triqual-hook-no-fence-path') };
const FAKE_FENCE = join(TEST_DIR, 'fixtures', 'fake-fence');
const FENCE_LINE = 'fence is active: a denied call is a stop-and-ask, never a retry.';
async function withFence(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'triqual-hook-fence-'));
  copyFileSync(FAKE_FENCE, join(dir, 'fence'));
  try {
    return await fn({ PATH: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixture = (id, file) => JSON.parse(readFileSync(join(FIXTURES, id, file), 'utf8'));
const batch = (file) => readFileSync(join(FIXTURES, 'grok', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .sort((a, b) => a.seq - b.seq);
// Fixtures come from different sessions: a test that mixes them rewrites the session id first.
const inSession = (payload, id) => ({ ...payload, sessionId: id, session_id: id });
const withTool = (payload, toolUseId) => ({ ...payload, toolUseId, tool_use_id: toolUseId });

// The real methodology part: drift's session context for a home with no Codex rules synced yet.
const METHODOLOGY_TEXT = (() => {
  const home = mkdtempSync(join(tmpdir(), 'triqual-hook-m-'));
  try {
    return driftContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
})();

const contextJson = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
const budgetOf = (args) => {
  const i = args.indexOf('--budget');
  return i === -1 ? undefined : Number(args[i + 1]);
};

// A fake runScript that answers for drift and the gate, recording each call. `drift` and `gate` may be replaced.
function scripts({ drift, gate } = {}) {
  const calls = [];
  const driftRun = drift ?? (() => ({ code: 0, stdout: contextJson(METHODOLOGY_TEXT) }));
  const gateRun = gate ?? ((args) => {
    if (args[0] !== 'session-start') return { code: 0, stdout: '' };
    const cap = budgetOf(args);
    const text = gateContext({ tracking: TRACKED, status: `# Status\n${'s'.repeat(20_000)}`, progress: ENTRY, activeLines: [], cap });
    return { code: 0, stdout: contextJson(text) };
  });
  const runScript = (path, args, opts) => {
    calls.push({ path, args, ...opts });
    if (path === DRIFT) return driftRun(args, opts);
    if (path === GATE) return gateRun(args, opts);
    return { code: 1, stdout: '' };
  };
  return { runScript, calls, of: (path) => calls.filter((c) => c.path === path) };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function makeHome({ methodology = true, tracking = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'triqual-hook-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { [METHODOLOGY]: methodology, [TRACKING]: tracking, 'other@x': true },
  }));
  return home;
}

async function withHome(opts, fn) {
  const home = makeHome(opts);
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const stateDir = (home) => join(home, '.claude', 'plugins', 'data', `methodology-${BRAND.marketplace}`, 'harness', 'grok');
const stateFile = (home, id) => join(stateDir(home), `${id}.json`);
const readState = (home, id) => JSON.parse(readFileSync(stateFile(home, id), 'utf8'));
const contextOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;

// Every path under `dir`, relative to it.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      out.push(relative(dir, p));
      if (name.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function grok(home, deps = {}) {
  const s = deps.scripts ?? scripts();
  const c = deps.clock ?? clock();
  const backgrounds = [];
  const logged = [];
  const run = async (event, payload) => {
    let out;
    logged.push(...await quietly(async () => {
      out = await hook({
        home, harness: 'grok', event, payload, resolve, runScript: s.runScript, env: deps.env ?? NO_FENCE_ENV, detect: deps.detect,
        background: (arg) => { backgrounds.push(arg); }, now: c.now,
      });
    }));
    return out;
  };
  return { run, scripts: s, backgrounds, logged };
}

function codex(home, deps = {}) {
  const s = deps.scripts ?? scripts();
  const c = deps.clock ?? clock();
  const backgrounds = [];
  const logged = [];
  const run = async (event, payload) => {
    let out;
    logged.push(...await quietly(async () => {
      out = await hook({
        home, harness: 'codex', event, payload, resolve, runScript: s.runScript, env: deps.env ?? NO_FENCE_ENV,
        background: deps.background ?? ((arg) => { backgrounds.push(arg); }), now: c.now,
      });
    }));
    return out;
  };
  return { run, scripts: s, backgrounds, logged };
}

// Runs fn with process.stderr.write captured and resolves to the lines written meanwhile: what the hook logs for
// ignored input or an unexpected error (one line each, F.3). Re-entrant, for hooks run together.
let captureDepth = 0;
let captured = [];
let realWrite = null;
async function quietly(fn) {
  if (captureDepth++ === 0) {
    realWrite = process.stderr.write;
    captured = [];
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  }
  const from = captured.length;
  try {
    await fn();
  } finally {
    if (--captureDepth === 0) process.stderr.write = realWrite;
  }
  return captured.slice(from);
}

const SESSION = 'id-test-session';
const PRE = inSession(fixture('grok', 'pre-tool-use.json'), SESSION);
const POST = inSession(fixture('grok', 'post-tool-use.json'), SESSION); // the same toolUseId as PRE

// ---- Codex session start ----

test('codex session-start emits both parts', () => withHome({}, async (home) => {
  const h = codex(home);
  const { stdout } = await h.run('session-start', fixture('codex', 'session-start-startup.json'));
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = out.hookSpecificOutput.additionalContext;
  assert.ok(context.includes('You have the methodology skills'), context.slice(0, 200));
  assert.ok(context.includes(HEADER));
  assert.ok(context.startsWith(`${METHODOLOGY_TEXT}\n\n${HEADER}`));
  assert.ok(context.length < 9500, `${context.length}`);
  assert.equal(stdout, formatContext('codex', 'session-start', context));
  assert.deepEqual(h.scripts.calls.map((c) => [c.path, c.args]), [
    [DRIFT, ['--harness', 'codex']],
    [GATE, ['session-start', '--budget', String(9500 - METHODOLOGY_TEXT.length - 5)]],
  ]);
}));

test('the gate part is hard-capped when the gate ignores --budget', () => withHome({}, async (home) => {
  const h = codex(home, { scripts: scripts({ gate: () => ({ code: 0, stdout: contextJson('g'.repeat(9_400)) }) }) });
  const context = contextOf((await h.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout);
  assert.ok(context.length < 9500, `${context.length}`);
  assert.ok(context.startsWith(`${METHODOLOGY_TEXT}\n\ng`), 'the methodology part is intact');
  assert.equal(mergeContext('m'.repeat(1000), 'g'.repeat(20000)).length, 9497);
  // A methodology part larger than the total leaves no room: the cap is clamped at 0, and no gate text is added.
  assert.equal(mergeContext('m'.repeat(9600), 'g'.repeat(100)), 'm'.repeat(9600));
  const big = codex(home, {
    scripts: scripts({ drift: () => ({ code: 0, stdout: contextJson('m'.repeat(9600)) }), gate: () => ({ code: 0, stdout: contextJson('g'.repeat(500)) }) }),
  });
  assert.equal(contextOf((await big.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout), 'm'.repeat(9600));
  // An empty part leaves the other alone; two empty parts give nothing.
  assert.equal(mergeContext('abc', ''), 'abc');
  assert.equal(mergeContext('', 'def'), 'def');
  assert.equal(mergeContext('', ''), null);
  assert.equal(mergeContext('', 'g'.repeat(20000)).length, 9497);
}));

test('one deadline per event', () => withHome({}, async (home) => {
  // Codex session-start: 30 s minus 2 s. Drift takes 25 s: the gate gets what is left.
  let c = clock();
  let h = codex(home, { clock: c, scripts: scripts({ drift: () => { c.advance(25_000); return { code: 0, stdout: contextJson('m') }; } }) });
  await h.run('session-start', fixture('codex', 'session-start-startup.json'));
  assert.equal(h.scripts.of(DRIFT)[0].timeoutMs, 28_000);
  assert.ok(h.scripts.of(GATE)[0].timeoutMs <= 3_000, `${h.scripts.of(GATE)[0].timeoutMs}`);
  assert.ok(h.scripts.of(GATE)[0].timeoutMs > 0);

  // Drift uses the whole 28 s: the gate is not started, and the methodology part still goes out.
  c = clock();
  h = codex(home, { clock: c, scripts: scripts({ drift: () => { c.advance(28_000); return { code: 0, stdout: contextJson('m') }; } }) });
  const { stdout } = await h.run('session-start', fixture('codex', 'session-start-startup.json'));
  assert.equal(h.scripts.of(GATE).length, 0);
  assert.equal(contextOf(stdout), 'm');

  // Grok pre-tool-use: 10 s minus 2 s, shared. What drift used plus the gate's timeout stays within 8 s.
  c = clock();
  const used = 3_000;
  const g = grok(home, { clock: c, scripts: scripts({ drift: () => { c.advance(used); return { code: 0, stdout: contextJson('m') }; } }) });
  await g.run('pre-tool-use', PRE);
  const [driftCall] = g.scripts.of(DRIFT);
  const [gateCall] = g.scripts.of(GATE);
  assert.equal(driftCall.timeoutMs, 8_000);
  assert.ok(used + gateCall.timeoutMs <= 8_000, `${used} + ${gateCall.timeoutMs}`);
  assert.equal(gateCall.timeoutMs, 5_000);

  // The Codex Stop gets 60 s minus 2 s.
  const s = codex(home);
  await s.run('stop', fixture('codex', 'stop.json'));
  assert.equal(s.scripts.of(GATE)[0].timeoutMs, 58_000);
}));

test('child scripts inherit the environment', () => withHome({}, async (home) => {
  // Both names of the registry variable are set aside: an ambient one of either would otherwise leak into the assertion.
  const saved = { new: process.env.TRIQUAL_REGISTRY_DIR, legacy: process.env.CM_REGISTRY_DIR };
  delete process.env.CM_REGISTRY_DIR;
  process.env.TRIQUAL_REGISTRY_DIR = join(home, 'registry');
  try {
    const h = codex(home);
    const payload = fixture('codex', 'session-start-startup.json');
    await h.run('session-start', payload);
    const [d, g] = h.scripts.calls;
    for (const call of [d, g]) {
      assert.equal(call.env.PATH, process.env.PATH);
      assert.equal(call.env.TRIQUAL_REGISTRY_DIR, join(home, 'registry'));
      assert.equal(call.env.CLAUDE_PROJECT_DIR, payload.cwd);
      const input = JSON.parse(call.input);
      assert.equal(input.cwd, payload.cwd);
      assert.equal(input.session_id, payload.session_id);
      assert.equal(input.source, 'startup');
    }
    assert.equal(d.env.CLAUDE_PLUGIN_ROOT, M_ROOT);
    assert.equal(d.env.CLAUDE_PLUGIN_DATA, join(home, '.claude', 'plugins', 'data', `methodology-${BRAND.marketplace}`));
    assert.equal(g.env.CLAUDE_PLUGIN_ROOT, PT_ROOT);
    assert.equal(g.env.CLAUDE_PLUGIN_DATA, join(home, '.claude', 'plugins', 'data', `progress-tracking-${BRAND.marketplace}`));
  } finally {
    if (saved.new === undefined) delete process.env.TRIQUAL_REGISTRY_DIR;
    else process.env.TRIQUAL_REGISTRY_DIR = saved.new;
    if (saved.legacy === undefined) delete process.env.CM_REGISTRY_DIR;
    else process.env.CM_REGISTRY_DIR = saved.legacy;
  }
}));

// ---- enabled state in Claude ----

test('plugin data dir follows the installed id', () => withHome({}, async (home) => {
  // triqual is known; methodology is still installed only under its legacy id, progress-tracking under triqual.
  const legacyMethodology = `methodology@${BRAND.legacy.marketplace}`;
  const tracking = `progress-tracking@${BRAND.marketplace}`;
  const plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ [BRAND.marketplace]: { installLocation: '/m' } }));
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    [legacyMethodology]: [{ scope: 'user', installPath: M_ROOT, version: '0.3.0' }],
    [tracking]: [{ scope: 'user', installPath: PT_ROOT, version: '0.2.3' }],
  } }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { [legacyMethodology]: true, [tracking]: true },
  }));
  const s = scripts();
  const byId = (id) => ({ [legacyMethodology]: M_ROOT, [tracking]: PT_ROOT })[id] ?? null;
  await quietly(() => hook({
    home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'),
    resolve: byId, runScript: s.runScript, background: () => {}, now: clock().now,
  }));
  const [d, g] = [s.of(DRIFT)[0], s.of(GATE)[0]];
  assert.ok(d && g, `both parts ran: ${s.calls.map((c) => c.path).join(', ')}`);
  assert.equal(d.env.CLAUDE_PLUGIN_DATA, join(plugins, 'data', `methodology-${BRAND.legacy.marketplace}`));
  assert.equal(g.env.CLAUDE_PLUGIN_DATA, join(plugins, 'data', `progress-tracking-${BRAND.marketplace}`));
}));

test('a triqual id installed only at local scope does not hide the legacy user install from the gate',
  () => withHome({}, async (home) => {
    // progress-tracking is installed and enabled under its legacy id at user scope, and under triqual only for one
    // project (local scope, never enabled at user scope): the gate part still runs, under the legacy id.
    const legacyMethodology = `methodology@${BRAND.legacy.marketplace}`;
    const legacyTracking = `progress-tracking@${BRAND.legacy.marketplace}`;
    const localTracking = `progress-tracking@${BRAND.marketplace}`;
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({
      [BRAND.marketplace]: { installLocation: '/m' }, [BRAND.legacy.marketplace]: { installLocation: '/l' },
    }));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      [legacyMethodology]: [{ scope: 'user', installPath: M_ROOT, version: '0.3.0' }],
      [legacyTracking]: [{ scope: 'user', installPath: PT_ROOT, version: '0.2.3' }],
      [localTracking]: [{ scope: 'local', projectPath: '/elsewhere', installPath: '/local/pt', version: '0.2.4' }],
    } }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { [legacyMethodology]: true, [legacyTracking]: true },
    }));
    const s = scripts();
    const byId = (id) => ({ [legacyMethodology]: M_ROOT, [legacyTracking]: PT_ROOT })[id] ?? null;
    await quietly(() => hook({
      home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'),
      resolve: byId, runScript: s.runScript, background: () => {}, now: clock().now,
    }));
    const g = s.of(GATE)[0];
    assert.ok(g, `the gate part ran: ${s.calls.map((c) => c.path).join(', ')}`);
    assert.equal(g.env.CLAUDE_PLUGIN_ROOT, PT_ROOT);
    assert.equal(g.env.CLAUDE_PLUGIN_DATA, join(plugins, 'data', `progress-tracking-${BRAND.legacy.marketplace}`));
  }));

test('methodology disabled in Claude → no entry point', () => withHome({ methodology: false }, async (home) => {
  const h = codex(home);
  const context = contextOf((await h.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout);
  assert.equal(context.includes('You have the methodology skills'), false);
  assert.ok(context.startsWith(HEADER));
  assert.equal(h.scripts.of(DRIFT).length, 0);
  assert.deepEqual(h.scripts.of(GATE)[0].args, ['session-start', '--budget', '9497']);
}));

test('progress-tracking disabled → no gate', () => withHome({ tracking: false }, async (home) => {
  const h = codex(home);
  const context = contextOf((await h.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout);
  assert.equal(context, METHODOLOGY_TEXT);
  assert.equal(h.scripts.of(GATE).length, 0);
  assert.equal((await h.run('stop', fixture('codex', 'stop.json'))).stdout, null);
  assert.equal(h.scripts.of(GATE).length, 0);
}));

test('both disabled → stdout null', () => withHome({ methodology: false, tracking: false }, async (home) => {
  const h = codex(home);
  assert.equal((await h.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout, null);
  const g = grok(home);
  assert.equal((await g.run('pre-tool-use', PRE)).stdout, null);
  assert.equal(h.scripts.calls.length + g.scripts.calls.length, 0);
  // No settings.json at all reads as disabled.
  rmSync(join(home, '.claude', 'settings.json'));
  assert.equal((await codex(home).run('session-start', fixture('codex', 'session-start-startup.json'))).stdout, null);
}));

test('grok with nothing to emit tries once per session, not on every tool call', () => withHome({ methodology: false, tracking: false }, async (home) => {
  const g = grok(home);
  for (const id of ['id-a', 'id-b', 'id-c']) {
    assert.equal((await g.run('pre-tool-use', withTool(PRE, id))).stdout, null, id);
    assert.equal((await g.run('post-tool-use', withTool(POST, id))).stdout, null, id);
  }
  assert.equal(g.backgrounds.length, 1, 'one background run, from the first attempt');
  assert.equal(g.scripts.calls.length, 0);
  assert.equal(readState(home, SESSION).attempted, true);
  // post-compact resets the attempt, like the rest of the state.
  await g.run('post-compact', inSession(fixture('grok', 'post-compact.json'), SESSION));
  await g.run('pre-tool-use', withTool(PRE, 'id-d'));
  assert.equal(g.backgrounds.length, 2);
}));

test('grok emit without a toolUseId is not repeated on every batch', () => withHome({}, async (home) => {
  const g = grok(home);
  const noId = { ...PRE };
  delete noId.toolUseId;
  delete noId.tool_use_id;
  const postNoId = { ...POST };
  delete postNoId.toolUseId;
  delete postNoId.tool_use_id;
  assert.notEqual((await g.run('pre-tool-use', noId)).stdout, null, 'the first call emits');
  assert.equal(readState(home, SESSION).delivered, true, 'it cannot be confirmed, so it counts as delivered');
  for (let i = 0; i < 3; i++) {
    await g.run('post-tool-use', postNoId);
    assert.equal((await g.run('pre-tool-use', noId)).stdout, null, `batch ${i + 2}`);
  }
  assert.equal(g.scripts.of(DRIFT).length, 1);
  assert.equal(g.backgrounds.length, 1);
}));

test('the gate is not run when it has no room', () => withHome({}, async (home) => {
  const h = codex(home, { scripts: scripts({ drift: () => ({ code: 0, stdout: contextJson('m'.repeat(9600)) }) }) });
  const { stdout } = await h.run('session-start', fixture('codex', 'session-start-startup.json'));
  assert.equal(contextOf(stdout), 'm'.repeat(9600));
  assert.equal(h.scripts.of(GATE).length, 0);
}));

test('a plugin that does not resolve is skipped like a disabled one', () => withHome({}, async (home) => {
  const s = scripts();
  const only = (id) => (pluginId) => (pluginId === id ? resolve(pluginId) : null);
  const run = (r) => hook({
    home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'),
    resolve: r, runScript: s.runScript, background: () => {}, now: clock().now,
  });
  assert.equal(contextOf((await run(only(METHODOLOGY))).stdout), METHODOLOGY_TEXT);
  assert.ok(contextOf((await run(only(TRACKING))).stdout).startsWith(HEADER));
  assert.equal((await run(() => null)).stdout, null);
}));

// ---- Codex Stop ----

test('codex stop forwards a block', () => withHome({}, async (home) => {
  const reason = 'There are uncommitted changes and progress.md is not updated.';
  const h = codex(home, { scripts: scripts({ gate: () => ({ code: 0, stdout: JSON.stringify({ decision: 'block', reason }) }) }) });
  const { stdout } = await h.run('stop', fixture('codex', 'stop.json'));
  assert.equal(stdout, formatBlock('codex', reason));
  assert.deepEqual(h.scripts.calls.map((c) => [c.path, c.args]), [[GATE, ['stop']]]);
  assert.equal(JSON.parse(h.scripts.calls[0].input).stop_hook_active, false);
  assert.equal(h.backgrounds.length, 0, 'a Stop runs no session context');
  // No block, junk, or a failing gate: nothing.
  for (const out of ['', '{', JSON.stringify({ decision: 'approve' }), JSON.stringify({ decision: 'block' })]) {
    const quiet = codex(home, { scripts: scripts({ gate: () => ({ code: 0, stdout: out }) }) });
    assert.equal((await quiet.run('stop', fixture('codex', 'stop.json'))).stdout, null, out);
  }
  const throwing = codex(home, { scripts: scripts({ gate: () => { throw new Error('spawn failed'); } }) });
  assert.equal((await throwing.run('stop', fixture('codex', 'stop.json'))).stdout, null);
  assert.deepEqual(throwing.logged, ['triqual hook: spawn failed\n']);
}));

test('stop-active.json passes stop_hook_active: true through to the gate', () => withHome({}, async (home) => {
  const h = codex(home);
  await h.run('stop', fixture('codex', 'stop-active.json'));
  const input = JSON.parse(h.scripts.of(GATE)[0].input);
  assert.equal(input.stop_hook_active, true);
  assert.equal(input.session_id, fixture('codex', 'stop-active.json').session_id);
}));

// ---- store mode through the Codex bridge (Plan Store-2 T5) ----

const TRACKING_ROOT = join(PLUGIN_ROOT, '..', 'progress-tracking');
const STORE_RESOLVE = (id) => ({ [METHODOLOGY]: PLUGIN_ROOT, [TRACKING]: TRACKING_ROOT })[id] ?? null;

// A store repository made by a real `progress-init --store`, its store and registry under `home`, with the store
// environment set on this process (the hooks' scripts inherit it) for the duration of fn. The repository has a stored
// status section, so the store holds a row for it.
async function inStoreRepo(home, fn) {
  const env = {
    HOME: home, TRIQUAL_TRACKING_DB: join(home, 'data', 'tracking.db'), TRIQUAL_REGISTRY_DIR: join(home, 'registry'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  };
  mkdirSync(env.TRIQUAL_REGISTRY_DIR);
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|XDG_|TRIQUAL_)/.test(k)));
  const spawnEnv = { ...clean, ...env };
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: spawnEnv, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README'), 'demo\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const node = (script, ...args) => execFileSync(process.execPath, [join(TRACKING_ROOT, script), ...args],
    { cwd: repo, env: spawnEnv, stdio: 'ignore' });
  node('cli/progress-init.mjs', '--store');
  const draft = join(home, 'status.md');
  writeFileSync(draft, '# Status\n\n## Notes\nstore-status-marker\n');
  node('cli/tracking.mjs', 'status', 'set', draft);
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(repo);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const storeHook = (home, event, payload) => hook({
  home, harness: 'codex', event, payload, resolve: STORE_RESOLVE, background: () => {}, now: Date.now,
});

test('codex stop in a store repository forwards the pending-entry refusal as a block', () => withHome({}, (home) => inStoreRepo(home, async (repo) => {
  writeFileSync(join(repo, 'README'), 'changed\n'); // uncommitted work, and no pending entry of this worktree
  const payload = { ...fixture('codex', 'stop.json'), cwd: repo };
  const { stdout } = await storeHook(home, 'stop', payload);
  assert.notEqual(stdout, null, 'the store Stop block did not reach Codex');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes(NO_PENDING), out.reason);
  assert.equal(stdout, formatBlock('codex', out.reason));
  // The same change set blocks once: a second stop of the session lets the turn end.
  assert.equal((await storeHook(home, 'stop', payload)).stdout, null);
})));

test('codex session-start in a store repository merges the store status into the context', () => withHome({}, (home) => inStoreRepo(home, async (repo) => {
  const { stdout } = await storeHook(home, 'session-start', { ...fixture('codex', 'session-start-startup.json'), cwd: repo });
  const context = contextOf(stdout);
  assert.ok(context.startsWith(METHODOLOGY_TEXT), 'the methodology part is whole');
  assert.ok(context.includes('store-status-marker'), context.slice(METHODOLOGY_TEXT.length));
  assert.ok(context.length < 9500, `${context.length}`);
  assert.equal(stdout, formatContext('codex', 'session-start', context));
})));

// ---- Grok delivery ----

test('grok delivers once and confirms', () => withHome({}, async (home) => {
  const g = grok(home);
  const first = await g.run('pre-tool-use', PRE);
  assert.equal(first.stdout, formatContext('grok', 'pre-tool-use', contextOf(first.stdout)));
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(contextOf(first.stdout).includes('You have the methodology skills'));
  assert.ok(contextOf(first.stdout).includes(HEADER));
  assert.deepEqual(g.scripts.of(DRIFT)[0].args, ['--harness', 'grok']);
  // A second call in the same batch.
  assert.equal((await g.run('pre-tool-use', withTool(PRE, 'id-sibling'))).stdout, null);
  assert.equal(readState(home, SESSION).delivered, false);
  assert.equal((await g.run('post-tool-use', POST)).stdout, null);
  assert.equal(readState(home, SESSION).delivered, true);
  assert.equal((await g.run('pre-tool-use', withTool(PRE, 'id-later'))).stdout, null);
  assert.equal(g.scripts.of(DRIFT).length, 1);
  assert.deepEqual(g.logged, [], 'nothing on stderr');
}));

// ---- fence (spec U9): the Grok session context says a denied call is a stop-and-ask ----

test('grok session context carries the fence line right after the methodology part, only with fence', () => withHome({}, async (home) => {
  await withFence(async (env) => {
    const g = grok(home, { env });
    const context = contextOf((await g.run('pre-tool-use', PRE)).stdout);
    assert.ok(context.startsWith(`${METHODOLOGY_TEXT}\n\n${FENCE_LINE}\n\n${HEADER}`), context.slice(METHODOLOGY_TEXT.length, METHODOLOGY_TEXT.length + 200));
    assert.equal(context.split(FENCE_LINE).length, 2, 'the line appears once');
    assert.ok(context.length < 9500, `${context.length}`);
    // The gate part is fitted to what the line leaves.
    const methodology = `${METHODOLOGY_TEXT}\n\n${FENCE_LINE}`;
    assert.equal(budgetOf(g.scripts.of(GATE)[0].args), 9500 - methodology.length - 5);
  });
  const plain = grok(home);
  const without = contextOf((await plain.run('pre-tool-use', inSession(PRE, 'id-no-fence-session'))).stdout);
  assert.ok(!without.includes('fence'), 'no mention of fence without it');
  assert.ok(without.startsWith(`${METHODOLOGY_TEXT}\n\n${HEADER}`));
  assert.equal(budgetOf(plain.scripts.of(GATE)[0].args), 9500 - METHODOLOGY_TEXT.length - 5);
}));

test('the fence line needs a fence that answers: a failing fence adds nothing', () => withHome({}, async (home) => {
  await withFence(async (env) => {
    const g = grok(home, { env: { ...env, FAKE_FENCE_EXIT: '3' } });
    const context = contextOf((await g.run('pre-tool-use', PRE)).stdout);
    assert.ok(!context.includes(FENCE_LINE));
  });
}));

test('codex session-start does not carry the fence line', () => withHome({}, async (home) => {
  await withFence(async (env) => {
    const c = codex(home, { env });
    assert.ok(!contextOf((await c.run('session-start', fixture('codex', 'session-start-startup.json'))).stdout).includes(FENCE_LINE));
  });
}));

test('the fence line follows the methodology plugin being enabled, not the text its drift part returned', () => withHome({}, async (home) => {
  await withFence(async (env) => {
    // Enabled, but drift printed nothing: the line still goes out, ahead of the gate part.
    const quiet = grok(home, { env, scripts: scripts({ drift: () => ({ code: 0, stdout: contextJson('') }) }) });
    const context = contextOf((await quiet.run('pre-tool-use', inSession(PRE, 'id-quiet-drift'))).stdout);
    assert.ok(context.startsWith(`${FENCE_LINE}\n\n${HEADER}`), context.slice(0, 160));
  });
}));

test('with methodology disabled in Claude the fence line is not sent, and fence is not even looked for', () => withHome({ methodology: false }, async (home) => {
  await withFence(async (env) => {
    const seen = [];
    const g = grok(home, { env, detect: (...args) => { seen.push(args); return { version: '1', profile: null }; } });
    const context = contextOf((await g.run('pre-tool-use', PRE)).stdout);
    assert.ok(context.startsWith(HEADER), context.slice(0, 120));
    assert.ok(!context.includes(FENCE_LINE));
    assert.deepEqual(seen, []);
  });
}));

test('fence detection gets at most the time left before the Grok deadline, and none when it has passed', () => withHome({}, async (home) => {
  const seen = [];
  const detect = (env, timeoutMs) => { seen.push(timeoutMs); return { version: '1', profile: null }; };
  // Grok pre-tool-use: 10 s minus 2 s. Nothing used: the hook offers all 8 s, and detectFence caps its run at 2 s.
  let g = grok(home, { detect });
  await g.run('pre-tool-use', inSession(PRE, 'id-fresh'));
  // Drift used 7.2 s: 800 ms are left.
  let c = clock();
  g = grok(home, { detect, clock: c, scripts: scripts({ drift: () => { c.advance(7_200); return { code: 0, stdout: contextJson('m') }; } }) });
  await g.run('pre-tool-use', inSession(PRE, 'id-late'));
  // Drift used everything: no detection, no line.
  c = clock();
  g = grok(home, { detect, clock: c, scripts: scripts({ drift: () => { c.advance(8_000); return { code: 0, stdout: contextJson('m') }; } }) });
  const out = await g.run('pre-tool-use', inSession(PRE, 'id-over'));
  assert.deepEqual(seen, [8000, 800]);
  assert.ok(!contextOf(out.stdout).includes(FENCE_LINE));
}));

test('grok parallel batch emits once', () => withHome({}, async (home) => {
  const g = grok(home);
  const outs = [];
  for (const { event, payload } of batch('parallel-batch.jsonl')) outs.push((await g.run(event, payload)).stdout);
  assert.equal(outs.filter((o) => o !== null).length, 1);
  const id = batch('parallel-batch.jsonl')[0].payload.sessionId;
  assert.equal(readState(home, id).delivered, true);
}));

test('concurrent pre-tool-use emits once', () => withHome({}, async (home) => {
  const g = grok(home);
  const outs = await Promise.all([
    g.run('pre-tool-use', withTool(PRE, 'id-one')),
    g.run('pre-tool-use', withTool(PRE, 'id-two')),
  ]);
  assert.equal(outs.filter((o) => o.stdout !== null).length, 1);
  assert.equal(readState(home, SESSION).pending.length, 1);
}));

// Two hook processes on one session: the lock makes the second wait for the first's state (a slow drift holds it).
test('concurrent pre-tool-use emits once across processes', () => withHome({}, async (home) => {
  const installs = join(home, 'installs');
  const fakeScript = (path, body) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  fakeScript(join(installs, 'm', 'cli', 'drift.mjs'), [
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);',
    `process.stdout.write(${JSON.stringify(contextJson('M-CONTEXT'))});`,
  ].join('\n'));
  fakeScript(join(installs, 'pt', 'scripts', 'gate.mjs'), '');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      [METHODOLOGY]: [{ scope: 'user', installPath: join(installs, 'm') }],
      [TRACKING]: [{ scope: 'user', installPath: join(installs, 'pt') }],
    },
  }));
  const { XDG_CONFIG_HOME: _, ...env } = process.env;
  const once = (toolUseId) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, 'pre-tool-use', '--harness', 'grok'], { env: { ...env, HOME: home } });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(withTool(PRE, toolUseId)));
  });
  const outs = await Promise.all([once('id-one'), once('id-two')]);
  assert.deepEqual(outs.map((o) => o.code), [0, 0]);
  const emitted = outs.filter((o) => o.stdout !== '');
  assert.equal(emitted.length, 1, JSON.stringify(outs));
  assert.equal(contextOf(emitted[0].stdout), 'M-CONTEXT');
  assert.equal(readState(home, SESSION).pending.length, 1);
}));

test('grok stop is not ours', () => withHome({}, async (home) => {
  const g = grok(home);
  await g.run('pre-tool-use', inSession(fixture('grok', 'pre-tool-use.json'), 'id-f9292758ca48'));
  const before = readFileSync(stateFile(home, 'id-f9292758ca48'), 'utf8');
  const callsBefore = g.scripts.calls.length;
  const bare = grok(home);
  for (const file of ['stop-end-turn.json', 'stop-end-turn-active.json', 'stop-shutdown.json']) {
    assert.equal((await bare.run('stop', inSession(fixture('grok', file), 'id-f9292758ca48'))).stdout, null, file);
  }
  assert.equal(bare.scripts.calls.length, 0);
  assert.equal(g.scripts.calls.length, callsBefore);
  assert.deepEqual(bare.logged, Array(3).fill('triqual hook: ignored: grok has no stop hook\n'));
  assert.equal(readFileSync(stateFile(home, 'id-f9292758ca48'), 'utf8'), before);
}));

test('grok denied call that ends the turn', () => withHome({}, async (home) => {
  const g = grok(home);
  // Turn 1: the only call is denied (no PostToolUse).
  assert.notEqual((await g.run('pre-tool-use', withTool(PRE, 'id-denied'))).stdout, null);
  // The next prompt's first call finds the batch still open.
  assert.equal((await g.run('pre-tool-use', withTool(PRE, 'id-next'))).stdout, null);
  assert.equal((await g.run('post-tool-use', withTool(POST, 'id-next'))).stdout, null);
  assert.equal(readState(home, SESSION).delivered, false);
  // The call after that PostToolUse emits again.
  assert.notEqual((await g.run('pre-tool-use', withTool(PRE, 'id-after'))).stdout, null);
  assert.equal((await g.run('post-tool-use', withTool(POST, 'id-after'))).stdout, null);
  assert.equal(readState(home, SESSION).delivered, true);
}));

test('grok denied call then another tool', () => withHome({}, async (home) => {
  const lines = batch('denied-batch.jsonl');
  const id = lines[0].payload.sessionId;
  const g = grok(home);
  const results = [];
  for (const { seq, event, payload } of lines) {
    const before = existsSync(stateFile(home, id)) ? readFileSync(stateFile(home, id), 'utf8') : null;
    const { stdout } = await g.run(event, payload);
    results.push({ seq, event, stdout });
    if (!['pre-tool-use', 'post-tool-use', 'post-compact'].includes(event)) {
      assert.equal(stdout, null, `seq ${seq}`);
      const after = existsSync(stateFile(home, id)) ? readFileSync(stateFile(home, id), 'utf8') : null;
      assert.equal(after, before, `seq ${seq} left the state unchanged`);
    }
  }
  assert.deepEqual(g.logged, [
    'triqual hook: ignored: grok has no session-start hook\n', 'triqual hook: ignored: grok has no user-prompt-submit hook\n',
    'triqual hook: ignored: grok has no stop hook\n', 'triqual hook: ignored: grok has no stop hook\n',
  ]);
  const pre = results.filter((r) => r.event === 'pre-tool-use');
  assert.equal(pre.length, 2);
  assert.notEqual(pre[0].stdout, null, 'the first pre-tool-use emits');
  assert.equal(pre[1].stdout, null, 'the second one, in the open batch, does not');
  assert.equal(readState(home, id).delivered, false, 'the second id was never pending');
  // The next batch's first call: a copy of seq 4 with a new toolUseId.
  const seq4 = lines.find((l) => l.seq === 4).payload;
  assert.notEqual((await g.run('pre-tool-use', withTool(seq4, 'id-next-batch'))).stdout, null);
}));

test('post-compact resets', () => withHome({}, async (home) => {
  const g = grok(home);
  assert.notEqual((await g.run('pre-tool-use', PRE)).stdout, null);
  await g.run('post-tool-use', POST);
  assert.equal(readState(home, SESSION).delivered, true);
  assert.equal((await g.run('post-compact', inSession(fixture('grok', 'post-compact.json'), SESSION))).stdout, null);
  assert.equal(existsSync(stateFile(home, SESSION)), false);
  assert.notEqual((await g.run('pre-tool-use', withTool(PRE, 'id-after-compact'))).stdout, null);
}));

test('subagent payload skipped', () => withHome({}, async (home) => {
  const g = grok(home);
  const child = fixture('grok', 'pre-tool-use-subagent.json');
  assert.equal((await g.run('pre-tool-use', child)).stdout, null);
  assert.equal(g.scripts.calls.length, 0);
  assert.equal(existsSync(stateFile(home, child.sessionId)), false);
  assert.equal(g.backgrounds.length, 0);
}));

test('unsafe sessionId skipped', () => withHome({}, async (home) => {
  const before = tree(home);
  const g = grok(home);
  for (const id of ['../x', 'a/b', '', 'a.b', 'a b']) {
    assert.equal((await g.run('pre-tool-use', inSession(PRE, id))).stdout, null, JSON.stringify(id));
    assert.equal((await g.run('post-tool-use', inSession(POST, id))).stdout, null, JSON.stringify(id));
    assert.equal((await g.run('post-compact', inSession(fixture('grok', 'post-compact.json'), id))).stdout, null);
  }
  const noId = { ...PRE };
  delete noId.sessionId;
  delete noId.session_id;
  assert.equal((await g.run('pre-tool-use', noId)).stdout, null);
  assert.equal(g.scripts.calls.length, 0);
  assert.deepEqual(tree(home), before, 'no file written anywhere under the home');
}));

test('junk stdin → null, no throw', () => withHome({}, async (home) => {
  const h = codex(home);
  const junk = ['', '{', null, undefined, 42, [], {}];
  for (const payload of junk) {
    assert.deepEqual(await h.run('session-start', payload), { stdout: null }, JSON.stringify(payload));
  }
  assert.deepEqual(h.logged, Array(junk.length).fill('triqual hook: ignored: codex session-start payload not recognized\n'));
  assert.deepEqual(await h.run('bogus', fixture('codex', 'session-start-startup.json')), { stdout: null });
  assert.equal(h.logged.at(-1), 'triqual hook: ignored: codex has no bogus hook\n');
  const logged = await quietly(async () => {
    assert.deepEqual(await hook({ home, harness: 'bogus', event: 'stop', payload: {}, resolve, runScript: h.scripts.runScript, background: () => {}, now: Date.now }), { stdout: null });
    assert.deepEqual(await hook({ home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'), resolve: () => { throw new Error('x'); }, runScript: h.scripts.runScript, background: () => {}, now: Date.now }), { stdout: null });
  });
  assert.deepEqual(logged, ['triqual hook: ignored: unknown harness bogus\n', 'triqual hook: x\n']);
  assert.equal(h.scripts.calls.length, 0);
  assert.equal(h.backgrounds.length, 0);
  // The CLI: empty stdin, broken JSON, an unknown event, a missing --harness. Exit 0, no stdout.
  for (const [args, input] of [
    [['session-start', '--harness', 'codex'], ''],
    [['session-start', '--harness', 'codex'], '{'],
    [['bogus', '--harness', 'codex'], JSON.stringify(fixture('codex', 'session-start-startup.json'))],
    [['session-start'], JSON.stringify(fixture('codex', 'session-start-startup.json'))],
    [['pre-tool-use', '--harness', 'grok'], '{'],
  ]) {
    const r = spawnSync(process.execPath, [HOOK, ...args], { input, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^triqual hook: ignored: [^\n]+\n$/, args.join(' '));
  }
}));

// ---- background work ----

test('background work never delays the hook', () => withHome({}, async (home) => {
  let calls = 0;
  const pending = () => { calls += 1; return new Promise(() => {}); };
  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve('timed out'), ms));
  const s = scripts();
  const codexRun = hook({
    home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'),
    resolve, runScript: s.runScript, background: pending, now: clock().now,
  });
  const codexResult = await Promise.race([codexRun, timeout(2000)]);
  assert.notEqual(codexResult, 'timed out');
  assert.notEqual(codexResult.stdout, null);
  assert.equal(calls, 1);
  const grokRun = (payload) => hook({
    home, harness: 'grok', event: 'pre-tool-use', payload, resolve, runScript: s.runScript, background: pending, now: clock().now,
  });
  const grokResult = await Promise.race([grokRun(PRE), timeout(2000)]);
  assert.notEqual(grokResult, 'timed out');
  assert.notEqual(grokResult.stdout, null);
  assert.equal(calls, 2);
  // No emit, no background run.
  assert.equal((await grokRun(withTool(PRE, 'id-sibling'))).stdout, null);
  assert.equal(calls, 2);
  // A background that throws or rejects changes nothing.
  for (const background of [() => { throw new Error('x'); }, () => Promise.reject(new Error('y'))]) {
    const r = await hook({
      home, harness: 'codex', event: 'session-start', payload: fixture('codex', 'session-start-startup.json'),
      resolve, runScript: s.runScript, background, now: clock().now,
    });
    assert.notEqual(r.stdout, null);
  }
  // It gets the home and the harness.
  const h = codex(home);
  await h.run('session-start', fixture('codex', 'session-start-startup.json'));
  assert.deepEqual(h.backgrounds, [{ home, harness: 'codex' }]);
}));

test('backgroundRun', () => withHome({}, async (home) => {
  const headjack = join(home, '.local', 'bin', 'headjack');
  const recorder = () => {
    const runs = [];
    return { runs, run: async (cmd, args, opts) => { runs.push({ cmd, args, ...opts }); return { code: 0, stdout: '', stderr: '' }; } };
  };
  // Refresh is called; the cleanup runs only for Codex, and only when headjack is there.
  let refreshed = 0;
  let r = recorder();
  await backgroundRun({ home, harness: 'codex', run: r.run, refresh: async () => { refreshed += 1; } });
  assert.equal(refreshed, 1);
  assert.deepEqual(r.runs, []);
  mkdirSync(dirname(headjack), { recursive: true });
  writeFileSync(headjack, '#!/bin/sh\n', { mode: 0o755 });
  r = recorder();
  await backgroundRun({ home, harness: 'codex', run: r.run, refresh: async () => { refreshed += 1; } });
  assert.equal(refreshed, 2);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].cmd, headjack);
  assert.deepEqual(r.runs[0].args, ['cleanup', '--older-than', '48h']);
  assert.ok(r.runs[0].timeoutMs <= 5000);
  r = recorder();
  await backgroundRun({ home, harness: 'grok', run: r.run, refresh: async () => { refreshed += 1; } });
  assert.equal(refreshed, 3);
  assert.deepEqual(r.runs, [], 'Grok never runs it');
  // The default refresh, a throwing refresh and a failing run: it never throws.
  await backgroundRun({ home, harness: 'codex', run: recorder().run });
  const logged = await quietly(async () => {
    await backgroundRun({ home, harness: 'codex', run: async () => { throw new Error('x'); }, refresh: () => { throw new Error('y'); } });
    await backgroundRun({ home, harness: 'codex', run: () => { throw new Error('sync'); }, refresh: async () => { throw new Error('z'); } });
  });
  assert.deepEqual(logged, ['triqual hook: y\n', 'triqual hook: x\n', 'triqual hook: z\n', 'triqual hook: sync\n']);
  // A harness config.json records as removed (enabled: false): no refresh and no cleanup, for either harness.
  const config = join(home, '.config', 'triqual', 'config.json');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ harnesses: { codex: { enabled: false }, grok: { enabled: false } } }));
  for (const harness of ['codex', 'grok']) {
    r = recorder();
    await backgroundRun({ home, harness, run: r.run, refresh: async () => { refreshed += 1; } });
    assert.equal(refreshed, 3, harness);
    assert.deepEqual(r.runs, [], harness);
  }
}));

// ---- CLI ----

test('hook.mjs --help prints usage and exits 0', () => withHome({}, async (home) => {
  for (const flag of ['--help', '-h']) {
    const child = spawn(process.execPath, [HOOK, flag], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    clearTimeout(killer);
    child.stdin.destroy();
    assert.equal(code, 0, `${flag}: exited ${code} (null: killed while waiting on stdin)`);
    assert.match(stdout, /^usage: /, flag);
    assert.match(stdout, /--harness/);
  }
}));
