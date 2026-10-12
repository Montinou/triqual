import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_IDS, EVENTS, HOOK_TIMEOUTS, GROK_RULES_HEAD, BRIDGE_VERSION, bridgeId, codexTrustKeys,
  harnessPaths, codexBridgeDir, detect, normalize, formatContext, formatBlock, expectedRules,
} from '../bin/lib/harnesses.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const FIXTURES = join(TEST_DIR, 'fixtures', 'harness');

const fixture = (id, file) => JSON.parse(readFileSync(join(FIXTURES, id, file), 'utf8'));

// Every single-payload fixture T1 recorded, with the event it is replayed as. The .jsonl files are batches (T4).
const FIXTURE_EVENTS = {
  codex: {
    'session-start-startup.json': 'session-start',
    'stop.json': 'stop',
    'stop-active.json': 'stop',
  },
  grok: {
    'pre-tool-use.json': 'pre-tool-use',
    'pre-tool-use-subagent.json': 'pre-tool-use',
    'post-tool-use.json': 'post-tool-use',
    'post-compact.json': 'post-compact',
    'session-start.json': 'session-start',
    'user-prompt-submit.json': 'user-prompt-submit',
    'stop-end-turn.json': 'stop',
    'stop-end-turn-active.json': 'stop',
    'stop-shutdown.json': 'stop',
  },
};

// Grok fixtures of events outside EVENTS.grok: normalize gives null for them.
const GROK_NULL = new Set([
  'session-start.json', 'user-prompt-submit.json', 'stop-end-turn.json', 'stop-end-turn-active.json',
  'stop-shutdown.json',
]);

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-harnesses-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('registry constants are the exact values', () => {
  assert.deepEqual(HARNESS_IDS, ['codex', 'grok']);
  assert.deepEqual(EVENTS, {
    codex: ['session-start', 'stop'],
    grok: ['pre-tool-use', 'post-tool-use', 'post-compact'],
  });
  assert.equal(GROK_RULES_HEAD,
    'Before responding, load and follow the methodology:using-methodology skill (skill using-methodology). '
    + 'The global rules are in ~/.claude/CLAUDE.md.');
});

test('HOOK_TIMEOUTS covers EVENTS', () => {
  for (const id of HARNESS_IDS) {
    assert.deepEqual(Object.keys(HOOK_TIMEOUTS[id]).sort(), [...EVENTS[id]].sort(), `${id} timeouts vs events`);
    for (const event of EVENTS[id]) {
      const seconds = HOOK_TIMEOUTS[id][event];
      assert.ok(Number.isFinite(seconds) && seconds > 0, `${id} ${event} timeout ${seconds}`);
    }
  }
  // F.2: Codex SessionStart 30 and Stop 60; Grok PreToolUse, PostToolUse and PostCompact 10.
  assert.deepEqual(HOOK_TIMEOUTS, {
    codex: { 'session-start': 30, stop: 60 },
    grok: { 'pre-tool-use': 10, 'post-tool-use': 10, 'post-compact': 10 },
  });
});

test('harnessPaths gives each harness its files under the given home', () => {
  const home = join(tmpdir(), 'cm-home');
  assert.deepEqual(harnessPaths(home, 'codex'), {
    dir: join(home, '.codex'),
    skills: join(home, '.codex', 'skills'),
    agents: join(home, '.codex', 'agents'),
    rules: join(home, '.codex', 'AGENTS.md'),
    hooksFile: null,
    config: join(home, '.codex', 'config.toml'),
    binary: 'codex',
  });
  assert.deepEqual(harnessPaths(home, 'grok'), {
    dir: join(home, '.grok'),
    skills: join(home, '.grok', 'skills'),
    agents: join(home, '.grok', 'agents'),
    rules: join(home, '.grok', 'rules', `${BRAND.grokName}.md`),
    hooksFile: join(home, '.grok', 'hooks', `${BRAND.grokName}.json`),
    legacyRules: join(home, '.grok', 'rules', `${BRAND.legacy.grokName}.md`),
    legacyHooksFile: join(home, '.grok', 'hooks', `${BRAND.legacy.grokName}.json`),
    config: null,
    binary: 'grok',
  });
});

test('normalize maps every recorded fixture', () => {
  for (const id of Object.keys(FIXTURE_EVENTS)) {
    const recorded = readdirSync(join(FIXTURES, id)).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(recorded, Object.keys(FIXTURE_EVENTS[id]).sort(), `${id}: the table lists every .json fixture`);
    for (const [file, event] of Object.entries(FIXTURE_EVENTS[id])) {
      const payload = fixture(id, file);
      const out = normalize(id, event, payload);
      if (id === 'grok' && GROK_NULL.has(file)) {
        assert.equal(out, null, `${id}/${file} (${event}) is outside EVENTS.grok`);
        continue;
      }
      assert.ok(out, `${id}/${file} normalizes`);
      assert.deepEqual(Object.keys(out).sort(),
        ['cwd', 'prompt_id', 'reason', 'session_id', 'source', 'stop_hook_active', 'subagent', 'tool_use_id']);
      assert.equal(out.session_id, payload.session_id, `${id}/${file} session_id`);
      assert.equal(out.cwd, payload.cwd, `${id}/${file} cwd`);
      assert.equal(typeof out.stop_hook_active, 'boolean', `${id}/${file} stop_hook_active`);
      assert.equal(typeof out.subagent, 'boolean', `${id}/${file} subagent`);
      if (id === 'codex') assert.equal(out.subagent, false, `${id}/${file} subagent`);
      if (id === 'grok') {
        assert.equal(out.stop_hook_active, false, `${id}/${file} stop_hook_active`);
        assert.equal(out.reason, null, `${id}/${file} reason`);
      }
    }
  }
  assert.equal(normalize('codex', 'stop', fixture('codex', 'stop-active.json')).stop_hook_active, true);
  assert.equal(normalize('codex', 'stop', fixture('codex', 'stop.json')).stop_hook_active, false);
  assert.equal(normalize('codex', 'session-start', fixture('codex', 'session-start-startup.json')).source, 'startup');
  assert.equal(normalize('grok', 'pre-tool-use', fixture('grok', 'pre-tool-use-subagent.json')).subagent, true);
  const pre = normalize('grok', 'pre-tool-use', fixture('grok', 'pre-tool-use.json'));
  assert.equal(pre.subagent, false);
  // Only a non-empty string subagentType marks a child: null, "" and a non-string do not.
  for (const subagentType of [null, '', 0, false, {}]) {
    const payload = { ...fixture('grok', 'pre-tool-use.json'), subagentType };
    assert.equal(normalize('grok', 'pre-tool-use', payload).subagent, false, JSON.stringify(subagentType));
  }
  assert.equal(pre.prompt_id, null);
  assert.equal(pre.tool_use_id, fixture('grok', 'pre-tool-use.json').toolUseId);
  assert.equal(normalize('grok', 'post-tool-use', fixture('grok', 'post-tool-use.json')).tool_use_id,
    fixture('grok', 'post-tool-use.json').toolUseId);
});

test('normalize rejects junk', () => {
  const stop = fixture('codex', 'stop.json');
  const { cwd, ...noCwd } = stop;
  assert.ok(cwd);
  for (const payload of [null, [], {}, 'x', 42, undefined]) {
    assert.equal(normalize('codex', 'stop', payload), null, `payload ${JSON.stringify(payload)}`);
    assert.equal(normalize('grok', 'pre-tool-use', payload), null, `payload ${JSON.stringify(payload)}`);
  }
  assert.equal(normalize('codex', 'pre-tool-use', stop), null, 'unknown Codex event');
  assert.equal(normalize('codex', 'nope', stop), null, 'unknown event');
  assert.equal(normalize('claude', 'stop', stop), null, 'unknown harness');
  assert.equal(normalize('codex', 'stop', noCwd), null, 'payload without cwd');
  const { cwd: _grokCwd, ...grokNoCwd } = fixture('grok', 'pre-tool-use.json');
  assert.equal(normalize('grok', 'pre-tool-use', grokNoCwd), null, 'Grok payload without cwd');
});

test('format round-trips', () => {
  assert.deepEqual(JSON.parse(formatContext('codex', 'session-start', 'x')),
    { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'x' } });
  assert.deepEqual(JSON.parse(formatContext('grok', 'pre-tool-use', 'x')),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'x' } });
  for (const id of HARNESS_IDS) {
    assert.deepEqual(JSON.parse(formatBlock(id, 'r')), { decision: 'block', reason: 'r' });
  }
  const text = 'line "one"\nline \\two\\ é';
  assert.equal(JSON.parse(formatContext('codex', 'session-start', text)).hookSpecificOutput.additionalContext, text);
  assert.equal(JSON.parse(formatBlock('codex', text)).reason, text);
});

test('detect: a home dir counts, else the binary answering --version', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.codex'));
    const calls = [];
    const failing = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 127, stdout: '', stderr: `${cmd}: not found` };
    };
    assert.deepEqual(await detect({ home, run: failing }), [
      { id: 'codex', present: true, via: 'dir' },
      { id: 'grok', present: false, via: null },
    ]);
    assert.deepEqual(calls.map(({ cmd, args }) => [cmd, args]), [['grok', ['--version']]],
      'the binary is asked only when the dir is missing');
    assert.ok(calls[0].opts.timeoutMs > 0, 'run gets a timeout');

    const answering = async (cmd) => ({ code: cmd === 'grok' ? 0 : 1, stdout: '1.0.41\n', stderr: '' });
    assert.deepEqual(await detect({ home, run: answering }), [
      { id: 'codex', present: true, via: 'dir' },
      { id: 'grok', present: true, via: 'binary' },
    ]);

    const throwing = async () => { throw new Error('spawn failed'); };
    assert.deepEqual(await detect({ home, run: throwing }), [
      { id: 'codex', present: true, via: 'dir' },
      { id: 'grok', present: false, via: null },
    ]);
  });
});

test('expectedRules: Codex is global.md plus the Codex note, Grok the head plus the Grok note', () => {
  const read = (...p) => readFileSync(join(PLUGIN_ROOT, 'rules', ...p), 'utf8');
  const global = read('global.md');
  const codexNote = read('harness', 'codex.md');
  const grokNote = read('harness', 'grok.md');
  const lastLine = (text) => text.trimEnd().split('\n').at(-1);

  const codex = expectedRules(PLUGIN_ROOT, 'codex');
  assert.ok(codex.startsWith(global.split('\n')[0]), 'Codex starts with global.md');
  assert.ok(codex.trimEnd().endsWith(lastLine(codexNote)), 'Codex ends with codex.md');
  assert.equal(codex, `${global.replace(/\n+$/, '')}\n\n${codexNote}`);

  const grok = expectedRules(PLUGIN_ROOT, 'grok');
  assert.ok(grok.startsWith(GROK_RULES_HEAD), 'Grok starts with the head');
  assert.equal(grok, `${GROK_RULES_HEAD}\n\n${grokNote}`);
  assert.ok(!grok.includes(global.split('\n')[0]), 'Grok holds no global.md');
});

test('harness notes: Codex routes roles to agent_type, Grok says SDD and roles are unavailable', () => {
  const codexNote = readFileSync(join(PLUGIN_ROOT, 'rules', 'harness', 'codex.md'), 'utf8');
  const grokNote = readFileSync(join(PLUGIN_ROOT, 'rules', 'harness', 'grok.md'), 'utf8');
  assert.match(codexNote, /spawn_agent/);
  assert.match(codexNote, /agent_type: "<name>"/);
  assert.match(codexNote, /`methodology:<x>` is skill `<x>`/);
  assert.match(grokNote, /stop and ask your human partner/);
  assert.match(grokNote, /`methodology:<x>` is skill `<x>`/);
  assert.doesNotMatch(grokNote, /agent_type/);
});

// The bridge's Codex config table, as `codex plugin add` writes it.
const bridgeTable = (marketplace) => `[plugins."methodology-codex@${marketplace}"]\nenabled = true\n`;
const writeCodexConfig = (home, text) => {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), text);
};

test('bridgeId and codexTrustKeys follow the installed bridge', () => withTmp((home) => {
  const current = `methodology-codex@${BRAND.marketplace}`;
  const legacy = `methodology-codex@${BRAND.legacy.marketplace}`;
  // F.11 P5a: `<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>`.
  const keys = (id) => [`${id}:hooks/hooks.json:session_start:0:0`, `${id}:hooks/hooks.json:stop:0:0`];
  const cache = (marketplace) => join(home, '.codex', 'plugins', 'cache', marketplace, 'methodology-codex');
  // No config.toml: the triqual bridge.
  assert.equal(bridgeId(home), current);
  assert.deepEqual(codexTrustKeys(home), keys(current));
  assert.equal(codexBridgeDir(home), join(cache(BRAND.marketplace), BRIDGE_VERSION));
  // Only the legacy bridge's table: the legacy id, its trust keys and its cache dir.
  writeCodexConfig(home, `model = "gpt"\n\n${bridgeTable(BRAND.legacy.marketplace)}`);
  assert.equal(bridgeId(home), legacy);
  assert.deepEqual(codexTrustKeys(home), keys(legacy));
  assert.equal(codexBridgeDir(home, '9.9.9'), join(cache(BRAND.legacy.marketplace), '9.9.9'));
  // Both tables: triqual wins.
  writeCodexConfig(home, `${bridgeTable(BRAND.legacy.marketplace)}\n${bridgeTable(BRAND.marketplace)}`);
  assert.equal(bridgeId(home), current);
  assert.deepEqual(codexTrustKeys(home), keys(current));
  // A table name only inside a multi-line string is not a table, and another plugin's table is not the bridge's.
  writeCodexConfig(home, `note = """\n${bridgeTable(BRAND.legacy.marketplace)}"""\n\n[plugins."other@x"]\nenabled = true\n`);
  assert.equal(bridgeId(home), current);
}));

test('codexBridgeDir returns the F.11 P5a path under a temp home', () => withTmp((home) => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '..', 'methodology-codex', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(BRIDGE_VERSION, '0.2.0');
  assert.equal(BRIDGE_VERSION, manifest.version, 'BRIDGE_VERSION equals the bridge plugin.json version');
  const base = join(home, '.codex', 'plugins', 'cache', BRAND.marketplace, 'methodology-codex');
  assert.equal(codexBridgeDir(home), join(base, '0.2.0'));
  assert.equal(codexBridgeDir(home, '9.9.9'), join(base, '9.9.9'));
}));
