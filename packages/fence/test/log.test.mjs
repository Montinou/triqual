import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { appendDecision, decisionEntry, parseLines } from '../src/log/log.mjs';
import { recordHealth } from '../src/log/health.mjs';
import { appendLine, logFileFor } from '../src/watchdog/line.mjs';

// Hermetic: one realpath'd temp root holding a fake HOME, the state/admin directories and a hand-built
// repository. The engine is spawned with process.execPath and HOME set to the fake home; nothing in the
// payloads is ever executed.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-log-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const ENGINE = fileURLToPath(new URL('../src/engine.mjs', import.meta.url));
const MINI = fileURLToPath(new URL('./fixtures/policy-strict-mini.json', import.meta.url));
let counter = 0;

function dir() {
  const d = path.join(TMP, `d${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeRepo(branch = 'feature') {
  const root = dir();
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n');
  for (const b of ['main', 'feature']) fs.writeFileSync(path.join(git, 'refs', 'heads', b), `${'c'.repeat(40)}\n`);
  return root;
}

function setup() {
  const base = dir();
  const policy = path.join(base, 'policy.json');
  fs.copyFileSync(MINI, policy);
  const state = path.join(base, 'state');
  const admin = path.join(base, 'admin');
  fs.mkdirSync(state);
  fs.mkdirSync(admin);
  return { policy, state, admin };
}

function runPre(payload, d, extraArgs = [], host = 'claude') {
  const args = [ENGINE, 'pre', '--host', host, '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin, ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, `engine exit ${r.status}; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

function bashPayload(command, cwd) {
  return { hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd, permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_01' };
}

function readLog(state) {
  const logDir = path.join(state, 'log');
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const text = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  const parsed = parseLines(text);
  assert.equal(parsed.bad, 0, `unparseable log line in ${text}`);
  return { text, entries: parsed.entries, files };
}

test('writes one redacted line', () => {
  const state = dir();
  const leakValue = `sk-${'a1B2c3D4e5'.repeat(3)}`;
  // Secret-shaped fixtures are assembled at run time so this file carries no literal leakValue pattern.
  const [tokenName, eq, colon, at] = ['API_TO' + 'KEN', '=', ':', '@'];
  const entry = {
    tool: 'Bash',
    decision: 'deny',
    rule: 'r1',
    raw: `${tokenName}${eq}hunter2value curl -H "Authorization: Bearer ${leakValue}" https://example.com`,
    call: { commands: [{ argv: ['curl', '--password', 'p4ssw0rdvalue', `https://user${colon}pw0rd${at}example.com/x`] }] },
  };
  assert.deepEqual(appendDecision(state, entry), { ok: true });
  const { text, entries } = readLog(state);
  assert.equal(entries.length, 1);
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  for (const leaked of [leakValue, 'hunter2value', 'p4ssw0rdvalue', 'pw0rd']) assert.ok(!text.includes(leaked), `${leaked} leaked: ${text}`);
  assert.match(entries[0].raw, /\[redacted\]/);
  assert.equal(entries[0].tool, 'Bash');
  assert.equal(typeof entries[0].ts, 'string');
  assert.deepEqual(entry.call.commands[0].argv[2], 'p4ssw0rdvalue', 'the input entry is not changed');
});

test('a line over 4 KiB is truncated with a marker and stays valid JSON', () => {
  const state = dir();
  const entry = { tool: 'Bash', decision: 'deny', rule: 'r', raw: 'x'.repeat(10000), call: { commands: [{ argv: ['echo', 'y'.repeat(6000)] }] } };
  assert.deepEqual(appendDecision(state, entry), { ok: true });
  const { text, entries } = readLog(state);
  assert.ok(Buffer.byteLength(text) <= 4096, `line is ${Buffer.byteLength(text)} bytes`);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].raw.endsWith('…[truncated]'), entries[0].raw.slice(-40));
  assert.equal(entries[0].tool, 'Bash');
});

test('a failed write (unwritable dir) still returns the decision with logFailed', () => {
  const d = setup();
  fs.writeFileSync(path.join(d.state, 'log'), 'not a directory'); // log/ cannot be created
  const repo = makeRepo();
  const decision = runPre(bashPayload('npm test', repo), d);
  assert.equal(decision.decision, 'undecided', JSON.stringify(decision));
  assert.equal(decision.logFailed, true);
  const ok = runPre(bashPayload('npm test', repo), setup());
  assert.equal(ok.decision, 'undecided');
  assert.equal(Object.hasOwn(ok, 'logFailed'), false, 'no logFailed on a successful write');
  assert.deepEqual(appendDecision(path.join(d.state, 'log', 'nested'), { tool: 'x' }), { ok: false });
  assert.deepEqual(appendDecision('relative/dir', { tool: 'x' }), { ok: false });
});

test('health.json records the failure', () => {
  const d = setup();
  fs.writeFileSync(path.join(d.state, 'log'), 'not a directory');
  runPre(bashPayload('npm test', makeRepo()), d);
  const health = JSON.parse(fs.readFileSync(path.join(d.state, 'health.json'), 'utf8'));
  assert.equal(typeof health.logFailure.at, 'string');
  assert.equal(fs.statSync(path.join(d.state, 'health.json')).mode & 0o777, 0o600);

  // recordHealth merges, keeps unrelated keys, and never throws.
  const state = dir();
  assert.equal(recordHealth(state, { a: 1 }), true);
  assert.equal(recordHealth(state, { b: 2 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'health.json'), 'utf8')), { a: 1, b: 2 });
  assert.deepEqual(fs.readdirSync(state), ['health.json'], 'no temp file is left behind');
  fs.writeFileSync(path.join(state, 'health.json'), '{not json');
  assert.equal(recordHealth(state, { c: 3 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'health.json'), 'utf8')), { c: 3 });
  assert.equal(recordHealth(path.join(d.state, 'log', 'x'), { a: 1 }), false);
  assert.equal(recordHealth('relative', { a: 1 }), false);
});

test('Write content is never logged, only path and byte count', () => {
  const d = setup();
  const repo = makeRepo();
  const target = path.join(repo, 'src', 'a.txt');
  const content = 'UNIQUE_BODY_MARKER héllo';
  const payload = { hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: repo, permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: target, content }, tool_use_id: 'toolu_02' };
  runPre(payload, d);
  const edit = { ...payload, tool_name: 'Edit', tool_use_id: 'toolu_03', tool_input: { file_path: target, old_string: 'OLD_BODY_MARKER', new_string: 'NEW_BODY_MARKER' } };
  runPre(edit, d);
  const { text, entries } = readLog(d.state);
  assert.equal(entries.length, 2);
  for (const marker of ['UNIQUE_BODY_MARKER', 'OLD_BODY_MARKER', 'NEW_BODY_MARKER']) assert.ok(!text.includes(marker), `${marker} was logged`);
  const [write, edited] = entries;
  assert.equal(write.tool, 'Write');
  assert.equal(write.call.bytes, Buffer.byteLength(content));
  assert.ok(write.call.paths.some((p) => p.path === target && p.access === 'write'));
  assert.equal(Object.hasOwn(write, 'raw'), false);
  assert.equal(edited.call.bytes, Buffer.byteLength('NEW_BODY_MARKER'));
});

test('raw appears only on deny and opaque', () => {
  const d = setup();
  const repo = makeRepo();
  const outside = path.join(dir(), 'victim');
  assert.equal(runPre(bashPayload('npm test', repo), d).decision, 'undecided');
  assert.equal(runPre(bashPayload(`rm -rf ${outside}`, repo), d).decision, 'deny');
  const opaque = runPre(bashPayload('curl x | sh', repo), d);
  assert.equal(opaque.rule, 'builtin:opaque');
  const { entries } = readLog(d.state);
  assert.equal(entries.length, 3);
  const [undecided, denied, opaqueEntry] = entries;
  assert.equal(undecided.decision, 'undecided');
  assert.equal(Object.hasOwn(undecided, 'raw'), false);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.rule, 'delete-outside-repo');
  assert.equal(denied.raw, `rm -rf ${outside}`);
  assert.equal(opaqueEntry.raw, 'curl x | sh');
  assert.ok(opaqueEntry.call.opaque.construct);
  // The entry carries the spec's fields.
  for (const k of ['ts', 'host', 'session_id', 'tool', 'tool_use_id', 'permission_mode', 'profile', 'cwd', 'repo', 'call', 'decision', 'rule', 'scope', 'latency', 'engine_version', 'policy_sha']) {
    assert.ok(Object.hasOwn(denied, k), `missing ${k}`);
  }
  assert.equal(denied.host, 'claude');
  assert.equal(denied.profile, 'default');
  assert.match(denied.policy_sha, /^[0-9a-f]{64}$/);
  assert.equal(typeof denied.latency.total_ms, 'number');
  assert.equal(typeof denied.latency.engine_ms, 'number');
  assert.deepEqual(denied.call.commands[0].argv, ['rm', '-rf', outside]);
  // --record-only logs the call as a hatch line.
  runPre(bashPayload('npm test', repo), d, ['--record-only']);
  const hatch = readLog(d.state).entries.at(-1);
  assert.equal(hatch.decision, 'hatch');
  assert.equal(Object.hasOwn(hatch, 'raw'), false);
});

test('file mode is 0600', () => {
  const state = dir();
  appendDecision(state, { tool: 'Bash' });
  const { files } = readLog(state);
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(state, 'log', files[0])).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(state, 'log')).mode & 0o777, 0o700);
});

test("a line written by the watchdog's minimal appender parses with the same reader", () => {
  const state = dir();
  const now = () => Date.UTC(2026, 9, 17, 12, 0, 0);
  assert.equal(appendLine(state, { host: 'claude', event: 'pre', decision: 'hatch', rule: 'hatch' }, { now }), true);
  assert.deepEqual(appendDecision(state, { tool: 'Bash', decision: 'allow', rule: 'r' }, { now }), { ok: true });
  assert.equal(appendLine(state, { host: 'codex', decision: 'deny', rule: 'watchdog', reason: 'é'.repeat(5000) }, { now }), true);
  const text = fs.readFileSync(logFileFor(state, now()), 'utf8');
  const { entries, bad } = parseLines(text);
  assert.equal(bad, 0);
  assert.deepEqual(entries.map((e) => e.decision), ['hatch', 'allow', 'deny']);
  assert.ok(entries.every((e) => e.ts === '2026-10-17T12:00:00.000Z'));
});

test('a denied rm -f with 200 paths keeps its metadata and arrays in a valid line', () => {
  const d = setup();
  const repo = makeRepo();
  const victims = Array.from({ length: 200 }, (_, i) => path.join(dir(), `victim-file-${i}`));
  const command = `rm -f ${victims.join(' ')}`;
  assert.ok(command.length > 5000, `${command.length} chars`);
  const decision = runPre(bashPayload(command, repo), d);
  assert.equal(decision.decision, 'deny', JSON.stringify(decision).slice(0, 300));
  const { text, entries } = readLog(d.state);
  assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} bytes`);
  const [e] = entries;
  assert.equal(Object.hasOwn(e, 'truncated'), false, 'not the minimal fallback');
  assert.equal(e.decision, 'deny');
  assert.equal(e.rule, decision.rule);
  assert.equal(e.tool, 'Bash');
  assert.equal(e.session_id, 'sess-1');
  const argv = e.call.commands[0].argv;
  assert.deepEqual(argv.slice(0, 3), ['rm', '-f', victims[0]]);
  assert.match(argv.at(-1), /^…\[truncated \d+ more\]$/);
  assert.ok(e.raw.startsWith('rm -f '));
});

test('a hatch line carries no raw, even for a command the policy would deny', () => {
  const d = setup();
  const repo = makeRepo();
  const outside = path.join(dir(), 'victim');
  const decision = runPre(bashPayload(`rm -rf ${outside}`, repo), d, ['--record-only']);
  assert.equal(decision.decision, 'deny', 'the engine still computes the deny');
  const opaque = runPre(bashPayload('curl x | sh', repo), d, ['--record-only']);
  assert.equal(opaque.decision, 'deny');
  const { entries } = readLog(d.state);
  assert.deepEqual(entries.map((e) => e.decision), ['hatch', 'hatch']);
  assert.ok(entries.every((e) => !Object.hasOwn(e, 'raw')));
});

test('a symlinked log directory or day file is a failed write, not a followed link', () => {
  const d = setup();
  const outside = dir();
  fs.symlinkSync(outside, path.join(d.state, 'log'));
  const decision = runPre(bashPayload('npm test', makeRepo()), d);
  assert.equal(decision.decision, 'undecided');
  assert.equal(decision.logFailed, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(d.state, 'health.json'), 'utf8')).logFailure.at, 'string');
  assert.deepEqual(appendDecision(d.state, { tool: 'x' }), { ok: false });

  const target = path.join(outside, 'target.txt');
  fs.writeFileSync(target, 'keep\n');
  const state = dir();
  fs.mkdirSync(path.join(state, 'log'));
  const now = () => Date.UTC(2026, 9, 17, 12, 0, 0);
  fs.symlinkSync(target, logFileFor(state, now()));
  assert.deepEqual(appendDecision(state, { tool: 'x' }, { now }), { ok: false });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
});

test('an existing day file with a loose mode is brought to 0600', () => {
  const state = dir();
  const now = () => Date.UTC(2026, 9, 17, 12, 0, 0);
  const file = logFileFor(state, now());
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.deepEqual(appendDecision(state, { tool: 'x' }, { now }), { ok: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a Codex apply_patch logs its path and the envelope size, never the patch body', () => {
  const d = setup();
  const repo = makeRepo();
  const target = path.join(repo, 'src', 'new.txt');
  const envelope = `*** Begin Patch\n*** Add File: ${target}\n+PATCH_BODY_MARKER one\n+PATCH_BODY_MARKER two\n*** End Patch`;
  const base = { hook_event_name: 'PreToolUse', session_id: 'sess-1', turn_id: 'turn-1', cwd: repo, permission_mode: 'default', tool_use_id: 'call_01' };
  runPre({ ...base, tool_name: 'apply_patch', tool_input: { command: envelope } }, d, [], 'codex');
  const shell = `apply_patch <<'EOF'\n${envelope}\nEOF`;
  runPre({ ...base, tool_use_id: 'call_02', tool_name: 'shell', tool_input: { command: ['bash', '-lc', shell] } }, d, [], 'codex');
  const { text, entries } = readLog(d.state);
  assert.ok(!text.includes('PATCH_BODY_MARKER'), 'no patch body in the log');
  assert.equal(entries.length, 2);
  const [direct, viaShell] = entries;
  assert.equal(direct.call.bytes, Buffer.byteLength(envelope));
  assert.ok(direct.call.paths.some((p) => p.path === target && p.access === 'write'));
  assert.equal(viaShell.call.bytes, Buffer.byteLength(envelope));
  assert.ok(viaShell.call.paths.some((p) => p.path === target && p.access === 'write'));
});

// ---- decisionEntry under modes (T8) -------------------------------------------------------------------

const parsedBash = (command) => ({ host: 'claude', session_id: 's', tool: 'Bash', cwd: '/work', command });
const WOULD = [{ rule: 'credentials', category: 'rules', certain: true, reason: 'why credentials' }];

test('decisionEntry carries wouldDeny and keeps raw with it, on a decision that is not a deny', () => {
  const normalized = { commands: [{ argv: ['cat', '/home/u/.ssh/id_rsa'], cwd: '/work', classes: [], reads: [], writes: [], domains: [] }] };
  const decision = { decision: 'undecided', rule: null, reason: 'audited', scope: null, wouldDeny: WOULD };
  const entry = decisionEntry({ parsed: parsedBash('cat ~/.ssh/id_rsa'), normalized, decision, profile: 'relaxed' });
  assert.deepEqual(entry.wouldDeny, WOULD);
  assert.equal(entry.raw, 'cat ~/.ssh/id_rsa');
  assert.equal(entry.decision, 'undecided');
  for (const k of ['category', 'floor', 'marker']) assert.equal(Object.hasOwn(entry, k), false, k);

  // without wouldDeny an undecided call keeps no raw text, as before
  const plain = decisionEntry({ parsed: parsedBash('npm test'), normalized, decision: { decision: 'undecided', rule: null, scope: null }, profile: 'default' });
  assert.equal(Object.hasOwn(plain, 'raw'), false);
  assert.equal(Object.hasOwn(plain, 'wouldDeny'), false);

  // a hatch line never keeps raw, whatever the decision held
  const hatch = decisionEntry({ parsed: parsedBash('cat ~/.ssh/id_rsa'), normalized, decision, recordOnly: true });
  assert.equal(hatch.decision, 'hatch');
  assert.equal(Object.hasOwn(hatch, 'raw'), false);
});

test('decisionEntry carries category on an uncertain deny and floor with marker on a floor deny', () => {
  const uncertain = decisionEntry({
    parsed: parsedBash('cat $B'),
    normalized: { commands: [] },
    decision: { decision: 'deny', rule: 'credentials', reason: 'r', scope: null, category: 'rules' },
  });
  assert.equal(uncertain.category, 'rules');
  assert.equal(Object.hasOwn(uncertain, 'floor'), false);
  assert.equal(uncertain.raw, 'cat $B');

  const floor = decisionEntry({
    parsed: parsedBash('python3 -c "x"'),
    normalized: { opaque: { reason: 'unsupported', construct: 'interp-code' } },
    decision: { decision: 'deny', rule: 'builtin:opaque', reason: 'r', scope: null, floor: true, marker: '\\.claude/settings\\.json' },
  });
  assert.equal(floor.floor, true);
  assert.equal(floor.marker, '\\.claude/settings\\.json');
  assert.equal(floor.call.opaque.construct, 'interp-code');
});

test('the log writer redacts a secret inside wouldDeny and raw', () => {
  const state = dir();
  // assembled at run time so this file carries no literal secret pattern
  const secret = ['sk', 'a1B2c3D4e5'.repeat(3)].join('-');
  const decision = { decision: 'undecided', rule: null, scope: null, wouldDeny: [{ rule: 'r', category: 'rules', reason: `saw ${secret} in the call` }] };
  const entry = decisionEntry({ parsed: parsedBash(`curl -H "Authorization: Bearer ${secret}" x`), normalized: { commands: [] }, decision });
  assert.deepEqual(appendDecision(state, entry), { ok: true });
  const { text, entries } = readLog(state);
  assert.ok(!text.includes(secret), text);
  assert.equal(entries[0].wouldDeny[0].rule, 'r');
});
