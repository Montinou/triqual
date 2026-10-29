import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideAgent, BUILTIN_MODELS } from '../scripts/agent-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const GATE = join(PLUGIN, 'scripts', 'gate.mjs');
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

const CAPS = { fable: 3, opus: 8, sonnet: 12, haiku: Infinity };
const ROLE_MODELS = { hunter: 'haiku', 'tdd-implementer': 'sonnet', 'final-adversarial-reviewer': 'opus' };
const T0 = 1_700_000_000_000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wg-agent-'));
}

// A PreToolUse input for the Agent tool.
const agentInput = (toolInput, over = {}) => ({ session_id: 'sess-1', tool_name: 'Agent', tool_input: toolInput, ...over });

function decide(stateDir, input, over = {}) {
  return decideAgent(input, { now: T0, stateDir, caps: CAPS, windowS: 120, roleModels: ROLE_MODELS, ...over });
}

// Starts `n` agents one second apart from T0 and returns the decisions.
async function startMany(stateDir, toolInput, n, over = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await decide(stateDir, agentInput(toolInput), { ...over, now: (over.now ?? T0) + i * 1000 }));
  return out;
}

test('model input wins over the role model', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:hunter', model: 'opus' }, 9);
    assert.deepEqual(out.slice(0, 8).map((d) => d.decision), Array(8).fill('allow'));
    assert.equal(out[8].decision, 'deny');
    assert.match(out[8].reason, /opus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('roles map through the role models', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:tdd-implementer' }, 13);
    assert.equal(out[11].decision, 'allow');
    assert.equal(out[12].decision, 'deny');
    assert.match(out[12].reason, /sonnet/);
    assert.match(out[12].reason, /13/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unresolved starts are counted in their own bucket with the Opus cap', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'general-purpose' }, 9);
    assert.deepEqual(out.slice(0, 8).map((d) => d.decision), Array(8).fill('allow'));
    assert.equal(out[8].decision, 'deny');
    assert.match(out[8].reason, /unresolved/);
    assert.match(out[8].reason, /\b9\b/);
    assert.match(out[8].reason, /\b8\b/);
    const state = JSON.parse(readFileSync(join(dir, 'sess-1.json'), 'utf8'));
    assert.ok(state.starts.every((s) => s.model === 'unresolved'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4 unresolved starts and 5 real Opus starts in one window are all allowed', async () => {
  const dir = tempDir();
  try {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await decide(dir, agentInput({ subagent_type: i % 2 ? 'Explore' : 'general-purpose' }), { now: T0 + i * 1000 }));
    for (let i = 4; i < 9; i++) out.push(await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + i * 1000 }));
    assert.deepEqual(out.map((d) => d.decision), Array(9).fill('allow'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown roles: type is unresolved, not Opus', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:not-a-role' }, 9);
    assert.equal(out[8].decision, 'deny');
    assert.match(out[8].reason, /unresolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a start without subagent_type (or with a non-string one) is counted as unresolved', async () => {
  const dir = tempDir();
  try {
    const shapes = [{ prompt: 'no type' }, { subagent_type: 7 }, { subagent_type: null }, {}];
    const out = [];
    for (let i = 0; i < 9; i++) out.push(await decide(dir, agentInput(shapes[i % shapes.length]), { now: T0 + i * 1000 }));
    assert.deepEqual(out.slice(0, 8).map((d) => d.decision), Array(8).fill('allow'));
    assert.equal(out[8].decision, 'deny');
    assert.match(out[8].reason, /unresolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a start without subagent_type still honours its model input', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { model: 'sonnet' }, 13);
    assert.equal(out[11].decision, 'allow');
    assert.equal(out[12].decision, 'deny');
    assert.match(out[12].reason, /sonnet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised model string falls back to the role model', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:tdd-implementer', model: 'inherit' }, 13);
    assert.equal(out[12].decision, 'deny');
    assert.match(out[12].reason, /sonnet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the 9th Opus start within 120 s is denied, naming the model, the count and the window', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 9);
    assert.deepEqual(out.slice(0, 8).map((d) => d.decision), Array(8).fill('allow'));
    assert.equal(out[8].decision, 'deny');
    assert.match(out[8].reason, /opus/);
    assert.match(out[8].reason, /\b9\b/);
    assert.match(out[8].reason, /120/);
    assert.match(out[8].reason, /\b8\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a denied start is not counted, so a later start is allowed once an old one expires', async () => {
  const dir = tempDir();
  try {
    await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 8); // at T0 .. T0+7s
    const denied = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + 8_000 });
    assert.equal(denied.decision, 'deny');
    // The first start (T0) leaves the window at T0 + 120 s.
    const later = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + 120_500 });
    assert.equal(later.decision, 'allow');
    const again = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + 120_600 });
    assert.equal(again.decision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Haiku is never denied', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:hunter' }, 20);
    assert.deepEqual(out.map((d) => d.decision), Array(20).fill('allow'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the caps come from the caps option', async () => {
  const dir = tempDir();
  try {
    const out = await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 3, { caps: { ...CAPS, opus: 2 } });
    assert.deepEqual(out.map((d) => d.decision), ['allow', 'allow', 'deny']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('models are counted separately and sessions do not share a count', async () => {
  const dir = tempDir();
  try {
    await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 8);
    const sonnet = await decide(dir, agentInput({ subagent_type: 'roles:tdd-implementer' }), { now: T0 + 9_000 });
    assert.equal(sonnet.decision, 'allow');
    const other = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { session_id: 'sess-2' }), { now: T0 + 9_000 });
    assert.equal(other.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('old starts expire', async () => {
  const dir = tempDir();
  try {
    await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 8);
    const out = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + 200_000 });
    assert.equal(out.decision, 'allow');
    const state = JSON.parse(readFileSync(join(dir, 'sess-1.json'), 'utf8'));
    assert.equal(state.v, 1);
    assert.deepEqual(state.starts, [{ model: 'opus', at: T0 + 200_000 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the window comes from the windowS option', async () => {
  const dir = tempDir();
  try {
    await startMany(dir, { subagent_type: 'roles:final-adversarial-reviewer' }, 8);
    const out = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { now: T0 + 20_000, windowS: 10 });
    assert.equal(out.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad or missing session_id allows and writes nothing', async () => {
  const dir = tempDir();
  try {
    for (const session_id of [undefined, '', '../escape', 'a/b', 'x'.repeat(129), 42, 'has space']) {
      const input = agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { session_id });
      for (let i = 0; i < 10; i++) {
        const decision = await decide(dir, input);
        assert.equal(decision.decision, 'allow', `session_id ${JSON.stringify(session_id)}`);
      }
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad session_id never creates the state dir', async () => {
  const parent = tempDir();
  const dir = join(parent, 'state');
  try {
    const out = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { session_id: '../escape' }));
    assert.equal(out.decision, 'allow');
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('anything that is not an Agent or Task start allows and writes nothing', async () => {
  const dir = tempDir();
  try {
    const cases = [
      agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { tool_name: 'Workflow' }),
      agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { tool_name: 'Bash' }),
      agentInput({ prompt: 'no type' }, { tool_name: 'Read' }),
      agentInput({ subagent_type: 7 }, { tool_name: 'Workflow' }),
      { session_id: 'sess-1', tool_name: 'Agent' },
      null,
      'text',
    ];
    for (let i = 0; i < 10; i++) {
      for (const c of cases) assert.equal((await decide(dir, c)).decision, 'allow');
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Task tool name is gated like Agent', async () => {
  const dir = tempDir();
  try {
    const out = [];
    for (let i = 0; i < 9; i++) out.push(await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }, { tool_name: 'Task' }), { now: T0 + i }));
    assert.equal(out[8].decision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt state file is treated as empty', async () => {
  const dir = tempDir();
  try {
    await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }));
    const file = join(dir, 'sess-1.json');
    for (const bad of ['{not json', '{"v":2,"starts":[]}', '{"v":1,"starts":"x"}', '{"v":1,"starts":[{"model":1}]}']) {
      writeFileSync(file, bad);
      const out = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }));
      assert.equal(out.decision, 'allow', bad);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).starts.length, 1, bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock timeout allows', async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'sess-1.json.lock')); // fresh, so not stale
    const started = Date.now();
    const out = await decide(dir, agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }), { lockWaitMs: 150, now: Date.now() });
    assert.equal(out.decision, 'allow');
    assert.match(out.reason, /lock/);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(readdirSync(dir), ['sess-1.json.lock']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unusable state dir allows', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'file'), 'x');
    const out = await decide(join(dir, 'file', 'state'), agentInput({ subagent_type: 'roles:final-adversarial-reviewer' }));
    assert.equal(out.decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUILTIN_MODELS lists only verified fixed models (none so far)', () => {
  assert.deepEqual(Object.keys(BUILTIN_MODELS), []);
});

// --- the hook as Claude Code runs it: node gate.mjs agent, JSON on stdin --------------------------------

function runHook(input, stateHome, env = {}) {
  const r = spawnSync('node', [GATE, 'agent'], {
    input: JSON.stringify(input),
    env: { ...process.env, XDG_STATE_HOME: stateHome, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `gate exited ${r.status}: ${r.stderr}`);
  return r.stdout === '' ? null : JSON.parse(r.stdout).hookSpecificOutput;
}

test('the hook denies the 9th Opus start from the fixture and prints a PreToolUse deny', () => {
  const home = tempDir();
  try {
    const input = fixture('agent-pretooluse-opus.json');
    for (let i = 0; i < 8; i++) assert.equal(runHook(input, home), null);
    const out = runHook(input, home);
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason.startsWith('[workflow-gate] '), out.permissionDecisionReason);
    assert.match(out.permissionDecisionReason, /opus/);
    // The state lives under <XDG_STATE_HOME>/triqual/workflow-gate/<session_id>.json.
    const state = JSON.parse(readFileSync(join(home, 'triqual', 'workflow-gate', 'fixture-session.json'), 'utf8'));
    assert.equal(state.v, 1);
    assert.equal(state.starts.length, 8);
    assert.ok(state.starts.every((s) => s.model === 'opus' && Number.isFinite(s.at)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook maps roles through the real ROLE_MODELS and lets Haiku through', () => {
  const home = tempDir();
  try {
    const sonnet = fixture('agent-pretooluse.json'); // roles:tdd-implementer with model sonnet
    for (let i = 0; i < 12; i++) assert.equal(runHook(sonnet, home), null);
    assert.equal(runHook(sonnet, home).permissionDecision, 'deny');
    const hunter = { ...sonnet, tool_input: { subagent_type: 'roles:hunter' } };
    for (let i = 0; i < 20; i++) assert.equal(runHook(hunter, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook counts roles:spec-reviewer as an opus start through the real ROLE_MODELS', () => {
  const home = tempDir();
  try {
    const reviewer = { ...fixture('agent-pretooluse.json'), tool_input: { subagent_type: 'roles:spec-reviewer' } };
    for (let i = 0; i < 8; i++) assert.equal(runHook(reviewer, home), null);
    const out = runHook(reviewer, home);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /opus/);
    const state = JSON.parse(readFileSync(join(home, 'triqual', 'workflow-gate', `${reviewer.session_id}.json`), 'utf8'));
    assert.ok(state.starts.every((s) => s.model === 'opus'), JSON.stringify(state.starts));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook counts roles:phase-orchestrator as a sonnet start through the real ROLE_MODELS', () => {
  const home = tempDir();
  try {
    const orchestrator = { ...fixture('agent-pretooluse.json'), tool_input: { subagent_type: 'roles:phase-orchestrator' } };
    for (let i = 0; i < 12; i++) assert.equal(runHook(orchestrator, home), null);
    const out = runHook(orchestrator, home);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /sonnet/);
    const state = JSON.parse(readFileSync(join(home, 'triqual', 'workflow-gate', `${orchestrator.session_id}.json`), 'utf8'));
    assert.ok(state.starts.every((s) => s.model === 'sonnet'), JSON.stringify(state.starts));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook honours WORKFLOW_MAX_OPUS and WORKFLOW_GATE_AGENT_WINDOW_S', () => {
  const home = tempDir();
  try {
    const input = fixture('agent-pretooluse-opus.json');
    const env = { WORKFLOW_MAX_OPUS: '1' };
    assert.equal(runHook(input, home, env), null);
    const out = runHook(input, home, env);
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /120 s/);
    const shortWindow = runHook({ ...input, session_id: 'other' }, home, { ...env, WORKFLOW_GATE_AGENT_WINDOW_S: '30' });
    assert.equal(shortWindow, null);
    const denied = runHook({ ...input, session_id: 'other' }, home, { ...env, WORKFLOW_GATE_AGENT_WINDOW_S: '30' });
    assert.match(denied.permissionDecisionReason, /30 s/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hook allows silently on malformed stdin and on a non-agent tool', () => {
  const home = tempDir();
  try {
    const r = spawnSync('node', [GATE, 'agent'], { input: '{not json', env: { ...process.env, XDG_STATE_HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }, home), null);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent hooks lose no update: 9 simultaneous Opus starts give exactly 1 deny', async () => {
  const home = tempDir();
  try {
    const input = JSON.stringify(fixture('agent-pretooluse-opus.json'));
    const runs = Array.from({ length: 9 }, () => new Promise((resolve, reject) => {
      const child = spawn('node', [GATE, 'agent'], { env: { ...process.env, XDG_STATE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    }));
    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const denies = results.filter((r) => r.stdout !== '' && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny');
    assert.equal(denies.length, 1, results.map((r) => r.stdout).join('\n'));
    const state = JSON.parse(readFileSync(join(home, 'triqual', 'workflow-gate', 'fixture-session.json'), 'utf8'));
    assert.equal(state.starts.length, 8);
    // The lock is released: no lock dir is left behind.
    assert.deepEqual(readdirSync(join(home, 'triqual', 'workflow-gate')), ['fixture-session.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('hooks.json also wires PreToolUse(Agent|Task) to gate.mjs agent', () => {
  const { hooks } = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.PreToolUse.find((e) => e.matcher === 'Agent|Task');
  assert.ok(entry, 'no PreToolUse entry with matcher Agent|Task');
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" agent');
  assert.equal(entry.hooks[0].timeout, 10);
});

test('lock.mjs copies are byte-identical', () => {
  const source = readFileSync(join(PLUGIN, '..', 'methodology', 'cli', 'lib', 'lock.mjs'));
  const copy = readFileSync(join(PLUGIN, 'scripts', 'lock.mjs'));
  assert.ok(source.equals(copy), 'plugins/workflow-gate/scripts/lock.mjs differs from plugins/methodology/cli/lib/lock.mjs: copy it again byte for byte');
});

test('the fixtures are marked as hand-written', () => {
  for (const name of ['agent-pretooluse.json', 'agent-pretooluse-opus.json']) {
    assert.match(fixture(name)._comment, /Hand-written/);
  }
});
