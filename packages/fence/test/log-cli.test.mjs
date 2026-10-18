import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli/index.mjs';
import { runEngine } from '../src/engine.mjs';
import { parseLines } from '../src/log/log.mjs';
import { appendLine } from '../src/watchdog/line.mjs';

// Hermetic: one realpath'd temp root holding fake state directories with fixture log lines. The
// engine is run in process or spawned with process.execPath and HOME set to a temp home; nothing in
// the payloads is ever executed and no real fence, Claude or Codex state is read.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-logcli-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const ENGINE = fileURLToPath(new URL('../src/engine.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/fence.mjs', import.meta.url));
const MINI = fileURLToPath(new URL('./fixtures/policy-strict-mini.json', import.meta.url));
let counter = 0;
let clock = Date.UTC(2026, 9, 17, 12, 0, 0);

function dir() {
  const d = path.join(TMP, `d${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// One fixture log line (the shape engine.mjs writes) in a state directory; each call is one second later.
function put(state, entry) {
  clock += 1000;
  assert.equal(appendLine(state, entry, { now: () => clock }), true);
}

function decision(over) {
  return {
    host: 'claude',
    session_id: 's1',
    turn_id: null,
    agent_id: null,
    agent_type: null,
    tool: 'Bash',
    tool_use_id: 'toolu_x',
    permission_mode: 'default',
    profile: 'default',
    cwd: '/work/repo',
    call: { commands: [{ argv: ['ls'], reads: [], writes: [] }] },
    decision: 'allow',
    rule: null,
    scope: { reads: [], writes: [], deletes: [], domains: [] },
    latency: { total_ms: 10, engine_ms: 5 },
    ...over,
  };
}

function fence(args) {
  const lines = [];
  const errs = [];
  const code = main(args, { out: (s) => lines.push(s), err: (s) => errs.push(s) });
  return { code, out: lines.join('\n'), err: errs.join('\n') };
}

function log(state, ...args) {
  return fence(['log', '--state-dir', state, ...args]);
}

test('--denies lists only denies with rule ids', () => {
  const state = dir();
  put(state, decision({ decision: 'allow', call: { commands: [{ argv: ['echo', 'allowed-line'] }] } }));
  put(state, decision({ decision: 'undecided', call: { commands: [{ argv: ['npm', 'test'] }] } }));
  put(state, decision({ decision: 'deny', rule: 'network-fetch', call: { commands: [{ argv: ['curl', 'https://example.com'] }] } }));
  put(state, decision({ decision: 'deny', rule: 'builtin:protected-branch', call: { commands: [{ argv: ['git', 'commit'] }] } }));
  const r = log(state, '--denies');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /network-fetch/);
  assert.match(r.out, /builtin:protected-branch/);
  assert.match(r.out, /curl https:\/\/example\.com/);
  assert.doesNotMatch(r.out, /allowed-line/);
  assert.doesNotMatch(r.out, /npm test/);
  assert.match(r.out, /2 entries/);
});

test('--undecided lists only undecided calls', () => {
  const state = dir();
  put(state, decision({ decision: 'allow', call: { commands: [{ argv: ['echo', 'ok'] }] } }));
  put(state, decision({ decision: 'undecided', call: { commands: [{ argv: ['npm', 'test'] }] } }));
  put(state, decision({ decision: 'deny', rule: 'privilege', call: { commands: [{ argv: ['sudo', 'ls'] }] } }));
  const r = log(state, '--undecided');
  assert.match(r.out, /npm test/);
  assert.doesNotMatch(r.out, /sudo/);
  assert.doesNotMatch(r.out, /echo ok/);
  assert.match(r.out, /1 entries/);
});

test('--session shows one session, with its completion lines, grouped by session', () => {
  const state = dir();
  put(state, decision({ session_id: 's1', call: { commands: [{ argv: ['echo', 'mine'] }] } }));
  put(state, decision({ session_id: 's2', call: { commands: [{ argv: ['echo', 'theirs'] }] } }));
  put(state, { phase: 'post', host: 'claude', session_id: 's1', tool: 'Bash', tool_use_id: 'toolu_x', response_bytes: 12 });
  const r = log(state, '--session', 's1');
  assert.match(r.out, /echo mine/);
  assert.match(r.out, /completed/);
  assert.match(r.out, /toolu_x/);
  assert.doesNotMatch(r.out, /theirs/);
  assert.match(r.out, /session s1/);
});

test('--unknown-tools lists tools seen with no rule', () => {
  const state = dir();
  put(state, decision({ tool: 'Bash', decision: 'undecided' }));
  put(state, decision({ tool: 'mcp__srv__lookup', decision: 'undecided', call: { mcp: 'mcp__srv__lookup' } }));
  put(state, decision({ tool: 'FancyNewTool', decision: 'undecided', call: {} }));
  put(state, decision({ tool: 'FancyNewTool', decision: 'undecided', call: {} }));
  put(state, decision({ host: 'codex', turn_id: 't1', tool: 'shell', decision: 'allow' }));
  put(state, decision({ host: 'codex', turn_id: 't1', tool: 'codex_mystery', decision: 'undecided', call: {} }));
  const r = log(state, '--unknown-tools');
  assert.match(r.out, /FancyNewTool/);
  assert.match(r.out, /codex_mystery/);
  assert.doesNotMatch(r.out, /\bBash\b/);
  assert.doesNotMatch(r.out, /mcp__srv__lookup/);
  assert.doesNotMatch(r.out, /\bshell\b/);
  assert.match(r.out, /FancyNewTool.*\b2\b/);
});

test('--agent <id> --reads lists the files that subagent read', () => {
  const state = dir();
  put(state, decision({ agent_id: 'sub-1', agent_type: 'Explore', tool: 'Read', call: { paths: [{ path: '/work/repo/a.txt', access: 'read' }] }, scope: { reads: ['/work/repo/a.txt'], writes: [] } }));
  put(state, decision({ agent_id: 'sub-1', tool: 'Bash', call: { commands: [{ argv: ['cat', '/work/repo/b.txt'], reads: ['/work/repo/b.txt'], writes: [] }] }, scope: { reads: ['/work/repo/b.txt'], writes: [] } }));
  put(state, decision({ agent_id: 'sub-1', tool: 'Read', decision: 'deny', rule: 'credentials', call: { paths: [{ path: '/work/repo/.env', access: 'read' }] }, scope: { reads: ['/work/repo/.env'], writes: [] } }));
  put(state, decision({ agent_id: 'sub-1', tool: 'Write', call: { paths: [{ path: '/work/repo/out.txt', access: 'write' }] }, scope: { reads: [], writes: ['/work/repo/out.txt'] } }));
  put(state, decision({ agent_id: 'sub-2', tool: 'Read', call: { paths: [{ path: '/work/repo/other.txt', access: 'read' }] }, scope: { reads: ['/work/repo/other.txt'], writes: [] } }));
  put(state, decision({ agent_id: null, tool: 'Read', call: { paths: [{ path: '/work/repo/main-thread.txt', access: 'read' }] }, scope: { reads: ['/work/repo/main-thread.txt'], writes: [] } }));
  const r = log(state, '--agent', 'sub-1', '--reads');
  assert.equal(r.code, 0, r.err);
  const files = r.out.split('\n').filter((l) => l.startsWith('/'));
  assert.deepEqual(files, ['/work/repo/a.txt', '/work/repo/b.txt']);
  assert.doesNotMatch(r.out, /\.env/);
  assert.doesNotMatch(r.out, /out\.txt|other\.txt|main-thread/);
  assert.match(r.out, /agent sub-1/);
});

test('Codex entries group by session and turn', () => {
  const state = dir();
  const codex = (turn, tool_use_id, file, session = 'cs1') =>
    decision({ host: 'codex', session_id: session, turn_id: turn, tool: 'shell', tool_use_id, call: { commands: [{ argv: ['cat', file], reads: [file] }] }, scope: { reads: [file], writes: [] } });
  put(state, codex('turn-a', 'c1', '/work/repo/one.txt'));
  put(state, codex('turn-b', 'c2', '/work/repo/two.txt'));
  put(state, codex('turn-a', 'c3', '/work/repo/three.txt'));
  put(state, codex('turn-z', 'c4', '/work/repo/elsewhere.txt', 'cs2'));

  // the session view groups its lines under one header per turn
  const s = log(state, '--session', 'cs1');
  const headers = s.out.split('\n').filter((l) => l.startsWith('#'));
  assert.deepEqual(headers, ['# codex session cs1 turn turn-a', '# codex session cs1 turn turn-b']);
  const afterA = s.out.slice(s.out.indexOf('turn turn-a'), s.out.indexOf('turn turn-b'));
  assert.match(afterA, /one\.txt/);
  assert.match(afterA, /three\.txt/);

  // the reads view takes a Codex turn id (or session id) as the agent
  const turn = log(state, '--agent', 'turn-a', '--reads');
  const files = turn.out.split('\n').filter((l) => l.startsWith('/'));
  assert.deepEqual(files, ['/work/repo/one.txt', '/work/repo/three.txt']);
  assert.match(turn.out, /codex session cs1 turn turn-a/);
  const session = log(state, '--agent', 'cs1', '--reads');
  assert.deepEqual(session.out.split('\n').filter((l) => l.startsWith('/')), ['/work/repo/one.txt', '/work/repo/three.txt', '/work/repo/two.txt']);
});

test('--latency prints p50 and p95', () => {
  const state = dir();
  for (let i = 1; i <= 20; i++) put(state, decision({ latency: { total_ms: i * 10, engine_ms: i } }));
  put(state, { phase: 'post', host: 'claude', session_id: 's1', tool: 'Bash', tool_use_id: 'toolu_x' });
  const r = log(state, '--latency');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /20 decisions/);
  assert.match(r.out, /total_ms\s+p50 100\s+p95 190/);
  assert.match(r.out, /engine_ms\s+p50 10\s+p95 19/);
});

test('an empty or missing state directory prints no entries and exits 0', () => {
  const r = log(path.join(dir(), 'nothing-here'), '--denies');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 entries/);
});

test('bad arguments are usage errors; there is no prune command', () => {
  const state = dir();
  assert.equal(log(state, '--reads').code, 1);
  assert.match(log(state, '--reads').err, /--agent/);
  assert.equal(log(state, '--session').code, 1);
  assert.equal(log(state, '--frobnicate').code, 1);
  assert.equal(log(state, '--denies', '--latency').code, 1);
  assert.equal(log(state, 'prune').code, 1);
  assert.equal(fence(['prune']).code, 1);
});

test('log output strips terminal control characters', () => {
  const state = dir();
  put(state, decision({ decision: 'deny', rule: 'r1', call: { commands: [{ argv: ['echo', 'a\u001b[31mred\u0007b'] }] } }));
  const r = log(state, '--denies');
  assert.doesNotMatch(r.out, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.match(r.out, /red/);
});

test('fence help lists log, and the bin runs it against a state directory', () => {
  const state = dir();
  put(state, decision({ decision: 'deny', rule: 'network-fetch', call: { commands: [{ argv: ['curl', 'x'] }] } }));
  const r = spawnSync(process.execPath, [BIN, 'log', '--denies', '--state-dir', state], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /network-fetch/);
  assert.doesNotMatch(fence(['help']).out, /log .*not yet implemented/);
});

// ---- engine post ---------------------------------------------------------------------------------

function setupEngine() {
  const base = dir();
  const policy = path.join(base, 'policy.json');
  fs.copyFileSync(MINI, policy);
  const state = path.join(base, 'state');
  const admin = path.join(base, 'admin');
  fs.mkdirSync(state);
  fs.mkdirSync(admin);
  return { policy, state, admin };
}

function postPayload(over = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-9',
    cwd: '/work/repo',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'echo sk-must-not-be-logged' },
    tool_response: { stdout: 'ok-output-text', is_error: false },
    tool_use_id: 'toolu_post1',
    agent_id: 'sub-9',
    ...over,
  };
}

function runPost(payload, d, { host = 'claude', stdin, event = 'post' } = {}) {
  return runEngine([event, '--host', host, '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin], { stdin: stdin ?? JSON.stringify(payload) });
}

function readEntries(state) {
  const logDir = path.join(state, 'log');
  const text = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  return parseLines(text).entries;
}

test('post appends a completion line and never throws', () => {
  const d = setupEngine();
  const r = runPost(postPayload(), d);
  assert.equal(r.exit, 0);
  assert.deepEqual(JSON.parse(r.stdout), {});
  const [line, ...rest] = readEntries(d.state);
  assert.equal(rest.length, 0);
  assert.equal(line.phase, 'post');
  assert.equal(line.event, 'PostToolUse');
  assert.equal(line.tool_use_id, 'toolu_post1');
  assert.equal(line.session_id, 'sess-9');
  assert.equal(line.agent_id, 'sub-9');
  assert.equal(line.host, 'claude');
  assert.equal(line.tool, 'Bash');
  assert.equal(line.decision, undefined);
  assert.equal(line.is_error, false);
  assert.equal(typeof line.response_bytes, 'number');
  const text = JSON.stringify(line);
  assert.ok(!text.includes('ok-output-text'), 'the tool response is never logged');
  assert.ok(!text.includes('must-not-be-logged'), 'the tool input is never logged');

  // Codex payload shape
  const c = runPost(postPayload({ session_id: 'cs-1', turn_id: 'turn-3', tool_name: 'shell', tool_use_id: 'call_7', agent_id: undefined }), d, { host: 'codex' });
  assert.deepEqual(JSON.parse(c.stdout), {});
  const codexLine = readEntries(d.state).at(-1);
  assert.equal(codexLine.host, 'codex');
  assert.equal(codexLine.turn_id, 'turn-3');
  assert.equal(codexLine.tool_use_id, 'call_7');

  // never throws, always {} with exit 0: unreadable payloads, an unknown host, a state dir that cannot be written
  const before = readEntries(d.state).length;
  for (const stdin of ['', 'not json', '[]', 'null', '{"tool_name":7}']) {
    const bad = runPost(null, d, { stdin });
    assert.equal(bad.exit, 0);
    assert.deepEqual(JSON.parse(bad.stdout), {});
  }
  const unknownHost = runEngine(['post', '--host', 'nope', '--state-dir', d.state], { stdin: JSON.stringify(postPayload()) });
  assert.deepEqual(JSON.parse(unknownHost.stdout), {});
  assert.equal(readEntries(d.state).length, before, 'an unreadable payload or unknown host adds no completion line, only valid ones do');

  const blocked = path.join(dir(), 'state-is-a-file');
  fs.writeFileSync(blocked, 'x');
  const failed = runEngine(['post', '--host', 'claude', '--state-dir', blocked], { stdin: JSON.stringify(postPayload()) });
  assert.equal(failed.exit, 0);
  assert.deepEqual(JSON.parse(failed.stdout), {});

  // a throwing filesystem is also swallowed
  const boom = new Proxy(fs, { get: () => () => { throw new Error('boom'); } });
  const thrown = runEngine(['post', '--host', 'claude', '--state-dir', d.state], { stdin: JSON.stringify(postPayload()), fs: boom });
  assert.equal(thrown.exit, 0);
  assert.deepEqual(JSON.parse(thrown.stdout), {});
});

test('a completion line is redacted like any other log line', () => {
  const d = setupEngine();
  const secret = ['sk', 'a1B2c3D4e5'.repeat(3)].join('-');
  runPost(postPayload({ tool_name: `Tool-${secret}` }), d);
  const text = fs.readFileSync(path.join(d.state, 'log', fs.readdirSync(path.join(d.state, 'log'))[0]), 'utf8');
  assert.ok(!text.includes(secret), text);
});

test('the spawned engine runs post and the log view shows the completion', () => {
  const d = setupEngine();
  const r = spawnSync(process.execPath, [ENGINE, 'post', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin], {
    input: JSON.stringify(postPayload()),
    env: { PATH: process.env.PATH, HOME },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '{}');
  const v = log(d.state, '--session', 'sess-9');
  assert.match(v.out, /completed Bash toolu_post1/);
});
