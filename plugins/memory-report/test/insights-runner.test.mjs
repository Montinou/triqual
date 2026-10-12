import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEMA, buildArgv, buildChildEnv, filterEvidence, parseEnvelope, runClaude, validateResult,
} from '../lib/insights.mjs';

// Writes an executable Node script into a fresh temp dir and returns { dir, bin }.
function fakeBin(body) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-report-bin-'));
  const bin = join(dir, 'fake-claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const goodResult = () => ({
  rules: [{ title: 't', target: 'global', text: 'x', rationale: 'r', evidence: [1, 2] }],
  skills: [{ title: 't', kind: 'new', skill: 's', change: 'c', rationale: 'r', evidence: [3] }],
  stale: [{ older: 1, newer: 2, relation: 'supersedes', reason: 'r' }],
});

test('buildArgv is exactly the spec 7.3 argv', () => {
  assert.deepEqual(buildArgv({ model: 'claude-haiku-4-5' }), [
    '-p', '--safe-mode', '--model', 'claude-haiku-4-5', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--no-session-persistence', '--permission-prompts', 'none', '--settings', '{"disableAllHooks":true}',
    '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
  ]);
});

test('SCHEMA carries the spec 7.4 limits', () => {
  assert.deepEqual(SCHEMA.required, ['rules', 'skills', 'stale']);
  assert.equal(SCHEMA.properties.rules.maxItems, 5);
  assert.equal(SCHEMA.properties.skills.maxItems, 5);
  assert.equal(SCHEMA.properties.stale.maxItems, 20);
  assert.deepEqual(SCHEMA.properties.skills.items.properties.kind.enum, ['new', 'edit']);
});

test('buildChildEnv removes auth, base URL, session and CLAUDE_CODE_/CLAUDECODE_ variables and adds the markers', () => {
  const parent = {
    ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_BASE_URL: 'c', CLAUDECODE: '1', MCP_SESSION_ID: 'd',
    CLAUDE_CODE_OAUTH_TOKEN: 'e', CLAUDE_CODE_SESSION_ID: 'f', CLAUDECODE_X: 'g', PATH: '/bin', HOME: '/home/x',
  };
  const env = buildChildEnv(parent);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_MEM_INTERNAL', 'HOME', 'MEMORY_REPORT_CHILD', 'PATH']);
  assert.equal(env.MEMORY_REPORT_CHILD, '1');
  assert.equal(env.CLAUDE_MEM_INTERNAL, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(parent.CLAUDECODE, '1', 'the parent env is not mutated');
});

test('runClaude returns argv, cwd, env keys and stdin from a fake bin', async () => {
  const { dir, bin } = fakeBin(`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), input }));
});`);
  try {
    const r = await runClaude({
      bin, argv: ['-p', '--x', ''], env: { PATH: process.env.PATH, FOO: 'bar' }, cwd: dir, input: 'hello é', timeoutMs: 10000,
    });
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.spawnError, false);
    assert.deepEqual(r.envKeys, ['PATH', 'FOO']);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.argv, ['-p', '--x', '']);
    assert.equal(out.cwd, realpathSync(dir));
    assert.equal(out.input, 'hello é');
    assert.ok(out.env.includes('FOO'));
    assert.ok(!out.env.includes('HOME'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runClaude captures stderr and a non-zero exit code', async () => {
  const { dir, bin } = fakeBin(`process.stderr.write('boom'); process.exit(3);`);
  try {
    const r = await runClaude({ bin, argv: [], env: process.env, cwd: dir, input: 'x', timeoutMs: 10000 });
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'boom');
    assert.equal(r.timedOut, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runClaude resolves when the child exits without reading a 1 MB stdin (no uncaught EPIPE)', async () => {
  const { dir, bin } = fakeBin('process.exit(0);');
  try {
    const r = await runClaude({
      bin, argv: [], env: process.env, cwd: dir, input: 'x'.repeat(1024 * 1024), timeoutMs: 10000,
    });
    assert.equal(r.timedOut, false);
    assert.equal(r.spawnError, false);
    assert.equal(r.code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runClaude reports timedOut for a child that sleeps', async () => {
  const { dir, bin } = fakeBin('setTimeout(() => {}, 30000);');
  try {
    const started = Date.now();
    const r = await runClaude({ bin, argv: [], env: process.env, cwd: dir, input: '', timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 300 + 1000, `took ${Date.now() - started} ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runClaude reports spawnError for a nonexistent bin and does not throw', async () => {
  const r = await runClaude({
    bin: join(tmpdir(), 'memory-report-no-such-bin-xyz'), argv: [], env: process.env, cwd: tmpdir(), input: 'x', timeoutMs: 5000,
  });
  assert.equal(r.spawnError, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.code, null);
});

test('runClaude kills a child that ignores SIGTERM after killGraceMs and resolves timedOut', async () => {
  const { dir, bin } = fakeBin(`
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.on('SIGTERM', () => {});
setTimeout(() => {}, 30000);`);
  const pidFile = join(dir, 'pid');
  try {
    const started = Date.now();
    const r = await runClaude({
      bin, argv: [pidFile], env: process.env, cwd: dir, input: '', timeoutMs: 3000, killGraceMs: 300,
    });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 3000 + 300 + 1000, `took ${Date.now() - started} ms`);
    for (let i = 0; i < 40 && !existsSync(pidFile); i += 1) await sleep(50); // the child's start can lag under load
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    for (let i = 0; i < 20 && alive(pid); i += 1) await sleep(50);
    assert.equal(alive(pid), false, 'the child is gone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const envelope = (over = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, structured_output: goodResult(), ...over,
});

test('parseEnvelope accepts a success envelope and returns the structured output', () => {
  const r = parseEnvelope(envelope());
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, goodResult());
});

test('parseEnvelope returns the fixed reason for each failure', () => {
  assert.deepEqual(parseEnvelope(envelope({ is_error: true })), { ok: false, reason: 'claude reported an error' });
  assert.deepEqual(parseEnvelope(envelope({ subtype: 'error_max_turns' })), { ok: false, reason: 'unexpected result subtype' });
  assert.deepEqual(parseEnvelope(envelope({ subtype: 'structured_output_retry_exhausted' })), { ok: false, reason: 'unexpected result subtype' });
  const noOutput = JSON.parse(envelope());
  delete noOutput.structured_output;
  assert.deepEqual(parseEnvelope(JSON.stringify(noOutput)), { ok: false, reason: 'no structured output' });
  assert.deepEqual(parseEnvelope('not json'), { ok: false, reason: 'unparsable output' });
  assert.deepEqual(parseEnvelope(''), { ok: false, reason: 'unparsable output' });
  assert.deepEqual(parseEnvelope('[1]'), { ok: false, reason: 'unparsable output' });
  assert.deepEqual(parseEnvelope('null'), { ok: false, reason: 'unparsable output' });
});

test('parseEnvelope never echoes child text in its reason', () => {
  const secret = 'NOTE-TEXT-' + 'zq';
  const r = parseEnvelope(`{"result":"${secret}", broken`);
  assert.equal(JSON.stringify(r).includes(secret), false);
  const r2 = parseEnvelope(envelope({ subtype: secret }));
  assert.equal(JSON.stringify(r2).includes(secret), false);
});

test('validateResult returns null for a valid result, including empty arrays', () => {
  assert.equal(validateResult(goodResult()), null);
  assert.equal(validateResult({ rules: [], skills: [], stale: [] }), null);
});

test('validateResult returns an error path (never a value) for each violation', () => {
  const secret = 'NOTE-TEXT-' + 'zq';
  const variants = {
    extra: { ...goodResult(), [secret]: 1 },
    kind: (() => { const g = goodResult(); g.skills[0].kind = 'other'; return g; })(),
    emptyEvidence: (() => { const g = goodResult(); g.rules[0].evidence = []; return g; })(),
    sixRules: (() => { const g = goodResult(); g.rules = Array.from({ length: 6 }, () => g.rules[0]); return g; })(),
    olderNotInt: (() => { const g = goodResult(); g.stale[0].older = 1.5; return g; })(),
    missingKey: (() => { const g = goodResult(); delete g.rules[0].title; return g; })(),
    wrongType: (() => { const g = goodResult(); g.rules[0].text = 5; return g; })(),
    extraNested: (() => { const g = goodResult(); g.rules[0][secret] = 'x'; return g; })(),
    notObject: [],
    nullRoot: null,
    missingTop: { rules: [], skills: [] },
  };
  for (const [name, value] of Object.entries(variants)) {
    const err = validateResult(value);
    assert.equal(typeof err, 'string', name);
    assert.ok(err.startsWith('/'), `${name}: ${err}`);
    assert.equal(err.includes(secret), false, `${name} echoes input`);
  }
  assert.equal(validateResult(variants.kind), '/skills/0/kind');
  assert.equal(validateResult(variants.emptyEvidence), '/rules/0/evidence');
  assert.equal(validateResult(variants.sixRules), '/rules');
  assert.equal(validateResult(variants.olderNotInt), '/stale/0/older');
  assert.equal(validateResult(variants.missingKey), '/rules/0/title');
});

test('filterEvidence drops items citing ids that were not sent and counts them', () => {
  const result = {
    rules: [
      { title: 'keep', target: 'global', text: 'x', rationale: 'r', evidence: [1, 2] },
      { title: 'drop', target: 'global', text: 'x', rationale: 'r', evidence: [1, 99] },
    ],
    skills: [{ title: 'keep', kind: 'edit', skill: 's', change: 'c', rationale: 'r', evidence: [3] }],
    stale: [
      { older: 1, newer: 2, relation: 'supersedes', reason: 'r' },
      { older: 1, newer: 77, relation: 'contradicts', reason: 'r' },
    ],
  };
  const out = filterEvidence(result, new Set([1, 2, 3]));
  assert.equal(out.droppedUnknownEvidence, 2);
  assert.deepEqual(out.result.rules.map((r) => r.title), ['keep']);
  assert.equal(out.result.skills.length, 1);
  assert.deepEqual(out.result.stale, [{ older: 1, newer: 2, relation: 'supersedes', reason: 'r' }]);
  assert.equal(result.rules.length, 2, 'the input is not mutated');
});
