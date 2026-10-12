import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gate.mjs');

// Runs the gate with `stdin` (an object is JSON-encoded, a string is sent as is), HOME and cwd in fresh temp
// dirs. Returns the parsed hookSpecificOutput, or null when the gate printed nothing.
function runGate(stdin, { env = {}, setup } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wg-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'wg-cwd-'));
  try {
    const payload = typeof stdin === 'function' ? stdin({ home, cwd }) : stdin;
    if (setup) setup({ home, cwd });
    const baseEnv = { ...process.env };
    delete baseEnv.WORKFLOW_MAX_AGENTS;
    const r = spawnSync('node', [GATE], {
      cwd,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...baseEnv, HOME: home, ...env },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `gate exited ${r.status}: ${r.stderr}`);
    return r.stdout === '' ? null : JSON.parse(r.stdout).hookSpecificOutput;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

const script = (s) => ({ tool_input: { script: s } });

function assertDeny(out, pattern) {
  assert.ok(out, 'expected a decision, got no output');
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  if (pattern instanceof RegExp) assert.match(out.permissionDecisionReason, pattern);
  else assert.ok(out.permissionDecisionReason.includes(pattern), out.permissionDecisionReason);
}

function assertAllow(out) {
  assert.ok(out, 'expected a decision, got no output');
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'allow', out.permissionDecisionReason);
  assert.ok(out.permissionDecisionReason.startsWith('[workflow-gate] ok:'), out.permissionDecisionReason);
}

const NO_BUDGET = 'const r = await agent("x", { agentType: "roles:spec-reviewer" });\n';

test('allows a built-in named workflow silently', () => {
  assert.equal(runGate({ tool_input: { name: 'deep-research' } }), null);
});

test('allows on malformed stdin', () => {
  assert.equal(runGate('{not json'), null);
});

test('denies a script without MAX_AGENTS', () => {
  assertDeny(runGate(script(NO_BUDGET)), /MAX_AGENTS: N/);
});

test('denies MAX_AGENTS above 15', () => {
  assertDeny(runGate(script('// MAX_AGENTS: 16\n' + NO_BUDGET)), /exceeds the cap of 15/);
});

test('honors WORKFLOW_MAX_AGENTS', () => {
  assertAllow(runGate(script('// MAX_AGENTS: 16\n' + NO_BUDGET), { env: { WORKFLOW_MAX_AGENTS: '20' } }));
});

test('denies agent() without agentType or model', () => {
  assertDeny(runGate(script('// MAX_AGENTS: 1\nconst r = await agent("do the thing");\n')), /1 of 1 agent\(\) call/);
});

test('does not validate agentType values', () => {
  assertAllow(runGate(script('// MAX_AGENTS: 1\nawait agent("x", { agentType: "no-such-agent" });\n')));
});

test('accepts a namespaced agentType', () => {
  assertAllow(runGate(script('// MAX_AGENTS: 1\nawait agent("x", { agentType: "roles:tdd-implementer" });\n')));
});

test('denies unbounded map', () => {
  const s = '// MAX_AGENTS: 5\nconst out = findings.map(f => agent(f, { agentType: "roles:spec-reviewer" }));\n';
  assertDeny(runGate(script(s)), 'unbounded fan-out: findings.map(');
});

test('allows sliced map', () => {
  const s = '// MAX_AGENTS: 5\nconst out = findings.slice(0, 5).map(f => agent(f, { agentType: "roles:spec-reviewer" }));\n';
  assertAllow(runGate(script(s)));
});

test('regression: a .slice cap counts anywhere earlier in the same .map chain', () => {
  const s = '// MAX_AGENTS: 3\nconst out = items.filter(x).slice(0, 3).map(i => agent(i, { model: "sonnet" }));\n';
  assertAllow(runGate(script(s)));
});

test('regression: an uncapped findings.map( is still denied', () => {
  const s = '// MAX_AGENTS: 5\nawait parallel(findings.map(f => () => agent(f, { agentType: "roles:spec-reviewer" })));\n';
  assertDeny(runGate(script(s)), 'unbounded fan-out: findings.map(');
});

test('regression: a sliced sibling argument does not cap an uncapped .map', () => {
  const s = '// MAX_AGENTS: 5\nawait run(extra.slice(0, 2), findings.map(f => agent(f, { model: "sonnet" })));\n';
  assertDeny(runGate(script(s)), 'unbounded fan-out: findings.map(');
});

test('regression: .filter links after the .slice cap keep the chain capped', () => {
  const s = '// MAX_AGENTS: 5\nconst out = findings.slice(0, 5).filter(Boolean).map(f => agent(f, { model: "sonnet" }));\n';
  assertAllow(runGate(script(s)));
});

// Each shape has a .slice( somewhere before an uncapped .map; the original hook denies all of them.
const A = 'agent(f, { model: "sonnet" })';
const UNCAPPED = [
  ['a slice in an earlier statement', `run(xs.slice(0, 1)); findings.map(f => ${A});`, 'findings.map('],
  ['a slice in a for header', `for (const y of ys.slice(0, 2)) findings.map(f => ${A});`, 'findings.map('],
  ['a slice in the other ternary branch', `await parallel(c ? xs.slice(0, 2) : findings.map(f => () => ${A}));`, 'findings.map('],
  ['a .concat link after the slice', `xs.slice(0, 1).concat(findings).map(f => ${A});`, '<expr>.map('],
  ['a slice inside a || group', `(findings || xs.slice(0, 1)).map(f => ${A});`, '<expr>.map('],
  ['a slice inside a string', `log("use .slice(0, 5)"); findings.map(f => ${A});`, 'findings.map('],
  ['a .filter chain with a slice on an earlier line', `const top = other.slice(0, 1);\nconst out = findings.filter(Boolean).map(f => ${A});`, '<expr>.map('],
  ['a .slice( inside a string argument of the chain', `findings.filter(s => s !== ".slice(").map(f => ${A});`, '<expr>.map('],
  ['a slice bound to another name', `const top = findings.slice(0, 5); top.map(f => ${A});`, 'top.map('],
];
for (const [label, body, offender] of UNCAPPED) {
  test(`regression: denies an uncapped .map despite ${label}`, () => {
    assertDeny(runGate(script(`// MAX_AGENTS: 5\n${body}\n`)), `unbounded fan-out: ${offender}`);
  });
}

test('allows literal-const map', () => {
  const s = '// MAX_AGENTS: 2\nconst LENSES = ["a","b"];\nconst out = LENSES.map(l => agent(l, { model: "sonnet" }));\n';
  assertAllow(runGate(script(s)));
});

test('denies parallel over a dynamic list', () => {
  const s = '// MAX_AGENTS: 5\nconst items = await load();\nawait parallel(items);\n';
  assertDeny(runGate(script(s)), 'parallel(items');
});

test('allows literal fan-outs', () => {
  const s = [
    '// MAX_AGENTS: 5',
    'await parallel([() => agent("a", { agentType: "roles:spec-reviewer" }), () => agent("b", { model: "sonnet" })]);',
    'await pipeline(Array.from({ length: 3 }), (i) => agent("c" + i, { agentType: "roles:tdd-implementer" }));',
    '',
  ].join('\n');
  assertAllow(runGate(script(s)));
});

test('reads scriptPath', () => {
  const inline = runGate(script(NO_BUDGET));
  const fromPath = runGate(({ cwd }) => {
    const p = join(cwd, 'wf.js');
    writeFileSync(p, NO_BUDGET);
    return { tool_input: { scriptPath: p } };
  });
  assertDeny(fromPath, /MAX_AGENTS: N/);
  assert.deepEqual(fromPath, inline);
});

test('resolves a named workflow from cwd', () => {
  const out = runGate({ tool_input: { name: 'x' } }, {
    setup: ({ cwd }) => {
      mkdirSync(join(cwd, '.claude', 'workflows'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'workflows', 'x.js'), NO_BUDGET);
    },
  });
  assertDeny(out, /MAX_AGENTS: N/);
});

test('the undispatched message names the roles plugin', () => {
  const out = runGate(script('// MAX_AGENTS: 1\nconst r = await agent("do the thing");\n'));
  assertDeny(out, /roles:tdd-implementer/);
  assert.doesNotMatch(out.permissionDecisionReason, /~\/\.claude\/agents/);
});

test('the undispatched message lists every role agent the roles plugin ships', () => {
  const agents = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles', 'agents');
  const names = readdirSync(agents).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.ok(names.includes('complex-implementer') && names.includes('hunter'), names.join(', '));
  const out = runGate(script('// MAX_AGENTS: 1\nconst r = await agent("do the thing");\n'));
  for (const name of names) assertDeny(out, new RegExp(`roles:${name}\\b`));
  assert.doesNotMatch(out.permissionDecisionReason, /safety-shadow/);
});

test('hooks.json wires PreToolUse(Workflow) to scripts/gate.mjs', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hooks.json');
  const { hooks } = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
  assert.equal(hooks.PreToolUse.length, 1);
  const [entry] = hooks.PreToolUse;
  assert.equal(entry.matcher, 'Workflow');
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"');
  assert.equal(entry.hooks[0].timeout, 10);
  assert.equal(entry.hooks[0].statusMessage, 'workflow-gate: checking agent budget and role dispatch');
});
