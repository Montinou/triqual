// fence replay (spec, "Acceptance", items 3 and 4): transcript tool_use events -> decisions through
// the staged watchdog, denies.md, undecided.md, latency.json and summary.md.
//
// Hermetic: a temp root holds a staged HOME (test/acceptance/stage-home.mjs) with a small test policy,
// a project directory, synthetic Claude Code transcripts and the output directories. The transcripts
// carry harmless commands only (ls, echo, touch, a small script, a Read, one mcp__ call); replay never
// runs any of them, it only sends them as hook payloads to the staged trampoline, which execs
// process.execPath on the staged watchdog bundle with HOME=<staged home>. No git, claude or codex runs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReplay, spawnHook as realSpawnHook } from '../src/cli/replay.mjs';
import { stageHome } from './acceptance/stage-home.mjs';

const STAGED_SCRIPT = fileURLToPath(new URL('./acceptance/replay-staged.mjs', import.meta.url));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-replay-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const POLICY = {
  version: 1,
  profiles: { default: { undecided: 'host' } },
  rules: [
    { id: 'credentials', decision: 'deny', match: { paths: ['**/.env'], access: 'any' }, why: 'Credential files are never read or written.' },
    { id: 'no-touch', decision: 'deny', match: { argv: [['touch']] }, why: 'touch is denied in this test policy.' },
    { id: 'no-gen-writes', decision: 'deny', match: { paths: ['**/gen/**'], access: 'write' }, why: 'gen/ is generated.' },
    { id: 'ok-ls', decision: 'allow', match: { argv: [['ls']] }, why: 'ls is fine.' },
    { id: 'ok-mcp', decision: 'allow', match: { mcp: ['mcp__good__*'] }, why: 'The good MCP server is fine.' },
  ],
};

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// One staged home shared by every test (staging copies the package; nothing in it is written by replay).
const STAGE_ROOT = newDir('stage');
const POLICY_FILE = path.join(TMP, 'policy.json');
fs.writeFileSync(POLICY_FILE, `${JSON.stringify(POLICY, null, 2)}\n`);
const { home: HOME } = stageHome(path.join(STAGE_ROOT, 'staged'), { policyPath: POLICY_FILE });
const PROJECT = newDir('project');
fs.writeFileSync(path.join(PROJECT, 'README.md'), '# test project\n');

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const assistant = (items, { session = 'sess-a', cwd = PROJECT, ts = '2026-10-01T10:00:00.000Z' } = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: session, cwd, timestamp: ts, message: { role: 'assistant', content: items } });

// transcripts: {relative path: [lines]} -> the transcripts directory
function transcripts(files) {
  const dir = newDir('transcripts');
  for (const [rel, lines] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `${lines.join('\n')}\n`);
  }
  return dir;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

function replay(dir, extra = [], seams = {}) {
  const out = path.join(newDir('out'), 'replay');
  const c = capture();
  const code = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', out, ...extra], c.io, { home: HOME, hookHome: HOME, ...seams });
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  return { code, out, c, read };
}

const CANARY = path.join(TMP, 'canary-touched');
const CANARY_ECHO = path.join(TMP, 'canary-echoed');

// The main fixture: 10 decided calls, one malformed line, one tool_use without a name, other record types.
const MAIN = {
  'proj-a/sess-a.jsonl': [
    JSON.stringify({ type: 'summary', summary: 'a session' }),
    'this line is not JSON',
    JSON.stringify({ type: 'user', sessionId: 'sess-a', cwd: PROJECT, message: { role: 'user', content: 'hello' } }),
    assistant([{ type: 'text', text: 'listing' }, toolUse('toolu_ls', 'Bash', { command: 'ls' })]),
    assistant([toolUse('toolu_echo', 'Bash', { command: `echo canary > ${CANARY_ECHO}` })]),
    assistant([toolUse('toolu_touch', 'Bash', { command: 'touch ./marker' })]),
    assistant([toolUse('toolu_canary', 'Bash', { command: `ls && touch ${CANARY}` })]),
    assistant([toolUse('toolu_write', 'Write', { file_path: 'script.sh', content: '#!/bin/sh\necho hi\n' })]),
    assistant([toolUse('toolu_run', 'Bash', { command: 'bash ./script.sh' })]),
    assistant([toolUse('toolu_read', 'Read', { file_path: path.join(PROJECT, 'README.md') })]),
    assistant([toolUse('toolu_env', 'Read', { file_path: '.env' })]),
    assistant([toolUse('toolu_mcp', 'mcp__good__lookup', { query: 'x' })]),
    assistant([toolUse('toolu_settings', 'Write', { file_path: path.join(HOME, '.claude', 'settings.json'), content: '{}' })]),
    assistant([{ type: 'tool_use', id: 'toolu_noname', input: {} }]),
    JSON.stringify({ type: 'user', sessionId: 'sess-a', cwd: PROJECT, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'README.md' }] } }),
  ],
};

let mainRun;
function mainReplay() {
  mainRun ??= replay(transcripts(MAIN));
  return mainRun;
}

test('decides Bash, Write, Read and mcp calls from tool_use events', () => {
  const r = mainReplay();
  assert.equal(r.code, 0, r.c.err.join('\n'));
  const summary = r.read('summary.md');
  assert.match(summary, /calls decided: 10\b/);
  assert.match(summary, /allow: 2\b/);
  assert.match(summary, /undecided: 3\b/);
  assert.match(summary, /deny: 5\b/);
  assert.match(summary, /malformed lines: 1\b/);
  assert.match(summary, /tool_use items skipped: 1\b/);
  // the profile the engine decided under (FENCE_PROFILE of the replay's environment, else default)
  assert.match(summary, new RegExp(`^- profile: ${process.env.FENCE_PROFILE ?? 'default'}$`, 'm'));
  const undecided = r.read('undecided.md');
  for (const id of ['toolu_echo', 'toolu_write', 'toolu_read']) assert.ok(undecided.includes(id), `${id} undecided`);
  const denies = r.read('denies.md');
  for (const id of ['toolu_touch', 'toolu_canary', 'toolu_run', 'toolu_env', 'toolu_settings']) assert.ok(denies.includes(id), `${id} denied`);
  for (const id of ['toolu_ls', 'toolu_mcp']) {
    assert.ok(!denies.includes(id), `${id} not denied`);
    assert.ok(!undecided.includes(id), `${id} not undecided`);
  }
  // Write content is never copied into the output
  assert.ok(!denies.includes('echo hi') && !undecided.includes('echo hi'));
});

test('a script written earlier in the transcript is opaque when run later', () => {
  const r = mainReplay();
  assert.match(section(r.read('denies.md'), 'toolu_run'), /builtin:opaque/);
  assert.match(section(r.read('denies.md'), 'toolu_run'), /agent-written-script/);
  // A Write the policy denies is still in the replay's index (the transcript says it happened), so
  // the engine's own index (which records only writes it did not deny) is not what makes this opaque.
  const seeded = replay(
    transcripts({
      'p/s.jsonl': [
        assistant([toolUse('toolu_gen', 'Write', { file_path: 'gen/run.sh', content: '#!/bin/sh\necho hi\n' })], { session: 'sess-g' }),
        assistant([toolUse('toolu_genrun', 'Bash', { command: 'bash ./gen/run.sh' })], { session: 'sess-g' }),
      ],
    }),
  );
  assert.equal(seeded.code, 0, seeded.c.err.join('\n'));
  assert.match(section(seeded.read('denies.md'), 'toolu_gen'), /no-gen-writes/);
  assert.match(section(seeded.read('denies.md'), 'toolu_genrun'), /builtin:opaque/);
  // the same run with no earlier Write: the operator's own (unreadable) script is not opaque
  const control = replay(transcripts({ 'p/s.jsonl': [assistant([toolUse('toolu_genrun', 'Bash', { command: 'bash ./gen/run.sh' })], { session: 'sess-c' })] }));
  assert.equal(control.code, 0, control.c.err.join('\n'));
  assert.ok(!control.read('denies.md').includes('toolu_genrun'));
  assert.ok(control.read('undecided.md').includes('toolu_genrun'));
});

// The text of one deny entry (from its heading to the next).
function section(md, id) {
  const start = md.indexOf(`## ${id}\n`);
  assert.ok(start >= 0, `no entry for ${id} in:\n${md}`);
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start, next < 0 ? md.length : next);
}

test('denies.md lists each deny with its rule id', () => {
  const md = mainReplay().read('denies.md');
  const want = {
    toolu_touch: 'no-touch',
    toolu_canary: 'no-touch',
    toolu_run: 'builtin:opaque',
    toolu_env: 'credentials',
    toolu_settings: 'builtin:self-protection',
  };
  for (const [id, rule] of Object.entries(want)) {
    const s = section(md, id);
    assert.match(s, new RegExp(`^- rule: \`${rule}\`$`, 'm'), s);
    assert.match(s, /^- label: *$/m, s);
    assert.match(s, /^- tool: /m, s);
  }
  assert.equal((md.match(/^## /gm) ?? []).length, 5);
  // the header documents the labels file format
  assert.match(md, /`<id>: would-allow`/);
});

test('summary computes the would-allow rate from a labels file', () => {
  const dir = transcripts(MAIN);
  const labels = path.join(newDir('labels'), 'labels.txt');
  fs.writeFileSync(labels, ['# owner labels', '', 'toolu_touch: would-allow', 'toolu_canary: correct', 'toolu_env: correct', 'toolu_settings: correct', ''].join('\n'));
  const r = replay(dir, ['--labels', labels]);
  assert.equal(r.code, 0, r.c.err.join('\n'));
  const summary = r.read('summary.md');
  assert.match(summary, /would-allow: 1\b/);
  assert.match(summary, /correct: 3\b/);
  assert.match(summary, /unlabelled: 1\b/);
  // the denominator is the replayed commands (the 5 Bash calls), not every call decided (10)
  assert.match(summary, /^- commands replayed \(Bash\/shell\): 5$/m);
  assert.match(summary, /^- calls decided: 10$/m);
  assert.match(summary, /would-allow rate: 1 \/ 5 commands = 20\.00%/);
  assert.match(section(r.read('denies.md'), 'toolu_touch'), /^- label: would-allow$/m);
  // a label line the parser cannot read is refused, and nothing is written
  fs.writeFileSync(labels, 'toolu_touch: maybe\n');
  const bad = replay(dir, ['--labels', labels]);
  assert.equal(bad.code, 1);
  assert.match(bad.c.err.join('\n'), /labels/);
  assert.equal(fs.existsSync(bad.out), false);
});

test('latency.json has p50 and p95 measured around the watchdog spawn', () => {
  // the real clock: one sample per decided call
  const real = JSON.parse(mainReplay().read('latency.json'));
  assert.equal(real.unit, 'ms');
  assert.equal(real.samples, 10);
  assert.ok(real.p50 > 0 && real.p95 >= real.p50, JSON.stringify(real));
  // a controlled clock that only moves while the hook is being spawned: the samples are exactly the
  // durations of the spawns, so p50/p95 (nearest rank) are known
  const durations = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
  let t = 1000;
  const spawned = [];
  const r = replay(transcripts(MAIN), [], {
    now: () => t,
    spawnHook: (file, args, opts) => {
      spawned.push({ file, args, env: opts.env });
      t += durations[spawned.length - 1];
      return realSpawnHook(file, args, opts);
    },
  });
  assert.equal(r.code, 0, r.c.err.join('\n'));
  assert.equal(spawned.length, 10);
  for (const s of spawned) {
    assert.equal(s.file, path.join(HOME, '.local', 'bin', 'fence-hook'));
    assert.deepEqual(s.args.slice(0, 5), ['pre', '--host', 'claude', '--policy', POLICY_FILE]);
    assert.ok(s.args.includes('--state-dir') && s.args.includes('--admin-dir'));
    assert.equal(s.env.HOME, HOME);
  }
  const lat = JSON.parse(r.read('latency.json'));
  assert.equal(lat.samples, 10);
  assert.equal(lat.p50, 5);
  assert.equal(lat.p95, 10);
  assert.match(r.read('summary.md'), /p50 5 ms/);
});

test('--out under ~/.claude is refused', () => {
  const dir = transcripts(MAIN);
  const tryOut = (out) => {
    const c = capture();
    const code = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', out], c.io, { home: HOME, hookHome: HOME });
    return { code, err: c.err.join('\n') };
  };
  for (const out of [
    path.join(HOME, '.claude', 'replay-out'),
    path.join(HOME, '.claude'),
    path.join(HOME, '.codex', 'x'),
    path.join(HOME, '.config', 'fence', 'out'),
    path.join(HOME, '.local', 'share', 'fence', 'out'),
    path.join(PROJECT, '.claude', 'out'),
  ]) {
    const existed = fs.existsSync(out);
    const r = tryOut(out);
    assert.equal(r.code, 1, out);
    assert.match(r.err, /protected/, out);
    assert.equal(fs.existsSync(out), existed, `${out} was not created`);
  }
  // a symlink to a protected directory is refused by its real path
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  const link = path.join(newDir('links'), 'out-link');
  fs.symlinkSync(path.join(HOME, '.claude'), link);
  const viaLink = tryOut(path.join(link, 'sub'));
  assert.equal(viaLink.code, 1);
  assert.match(viaLink.err, /protected/);
  assert.equal(fs.existsSync(path.join(HOME, '.claude', 'sub')), false);
});

// A spawnHook seam that records every spawn and runs the real one.
function recordingSpawn() {
  const calls = [];
  return {
    calls,
    spawnHook: (file, args, opts) => {
      calls.push(file);
      return realSpawnHook(file, args, opts);
    },
  };
}

test('--home is not a flag: a usage error that spawns nothing', () => {
  const dir = transcripts(MAIN);
  for (const flag of [['--home', HOME], [`--home=${HOME}`]]) {
    const rec = recordingSpawn();
    const out = path.join(newDir('out'), 'replay');
    const c = capture();
    const code = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', out, ...flag], c.io, { home: HOME, hookHome: HOME, spawnHook: rec.spawnHook });
    assert.equal(code, 1);
    assert.match(c.err.join('\n'), /unknown argument "--home/);
    assert.match(c.err.join('\n'), /usage: fence replay/);
    assert.deepEqual(rec.calls, []);
    assert.equal(fs.existsSync(out), false);
  }
});

test('an --out that exists and is not empty is refused before anything is replayed', () => {
  const dir = transcripts(MAIN);
  const out = newDir('out-full');
  fs.writeFileSync(path.join(out, '.gitignore'), 'keep-me\n');
  fs.writeFileSync(path.join(out, 'denies.md'), 'mine\n');
  const rec = recordingSpawn();
  const c = capture();
  const code = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', out], c.io, { home: HOME, hookHome: HOME, spawnHook: rec.spawnHook });
  assert.equal(code, 1);
  assert.match(c.err.join('\n'), /not empty/);
  assert.deepEqual(rec.calls, []);
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), 'keep-me\n');
  assert.equal(fs.readFileSync(path.join(out, 'denies.md'), 'utf8'), 'mine\n');
  assert.deepEqual(fs.readdirSync(out).sort(), ['.gitignore', 'denies.md']);
  // an existing empty directory is fine
  const empty = newDir('out-empty');
  const ok = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', empty], capture().io, { home: HOME, hookHome: HOME });
  assert.equal(ok, 0);
  assert.equal(fs.readFileSync(path.join(empty, '.gitignore'), 'utf8'), '*\n');
});

test('--out is checked again by its real path after it is created, before the first write', () => {
  // the parent of --out does not exist when replay starts; while the calls are being decided it
  // becomes a symlink into a protected directory, so the directory replay then creates is protected
  const dir = transcripts(MAIN);
  const base = newDir('swap');
  const target = path.join(HOME, '.local', 'share', 'fence', 'swapped');
  fs.mkdirSync(target, { recursive: true });
  const out = path.join(base, 'parent', 'out');
  let swapped = false;
  const c = capture();
  const code = runReplay(['--transcripts', dir, '--policy', POLICY_FILE, '--out', out], c.io, {
    home: HOME,
    hookHome: HOME,
    spawnHook: (file, args, opts) => {
      if (!swapped) {
        fs.symlinkSync(target, path.join(base, 'parent'));
        swapped = true;
      }
      return realSpawnHook(file, args, opts);
    },
  });
  assert.equal(swapped, true);
  assert.equal(code, 1);
  assert.match(c.err.join('\n'), /protected/);
  const created = path.join(target, 'out');
  assert.deepEqual(fs.existsSync(created) ? fs.readdirSync(created) : [], []);
});

test('replay-staged.mjs replays through a freshly staged home', () => {
  const dir = transcripts({ 'p/s.jsonl': [assistant([toolUse('toolu_s1', 'Bash', { command: 'touch ./x' })], { session: 'sess-s' })] });
  const out = path.join(newDir('out'), 'replay');
  const r = spawnSync(process.execPath, [STAGED_SCRIPT, '--transcripts', dir, '--policy', POLICY_FILE, '--out', out], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 calls decided/);
  assert.match(section(fs.readFileSync(path.join(out, 'denies.md'), 'utf8'), 'toolu_s1'), /no-touch/);
  // the script passes the arguments through: --home is still a usage error
  const h = spawnSync(process.execPath, [STAGED_SCRIPT, '--transcripts', dir, '--policy', POLICY_FILE, '--out', path.join(newDir('out'), 'r'), '--home', HOME], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(h.status, 1);
  assert.match(h.stderr, /unknown argument "--home"/);
});

test('a tool_use id seen in an earlier transcript is decided and counted once', () => {
  const rec = recordingSpawn();
  const dir = transcripts({
    'p/a.jsonl': [assistant([toolUse('toolu_dup', 'Bash', { command: 'touch ./a' })], { ts: '2026-10-01T10:00:00.000Z' })],
    'p/b.jsonl': [
      assistant([toolUse('toolu_dup', 'Bash', { command: 'touch ./a' })], { ts: '2026-10-01T11:00:00.000Z' }),
      assistant([toolUse('toolu_other', 'Bash', { command: 'ls' })], { ts: '2026-10-01T11:00:01.000Z' }),
    ],
  });
  const r = replay(dir, [], { spawnHook: rec.spawnHook });
  assert.equal(r.code, 0, r.c.err.join('\n'));
  assert.equal(rec.calls.length, 2);
  const summary = r.read('summary.md');
  assert.match(summary, /^- calls decided: 2$/m);
  assert.match(summary, /^- duplicate tool_use items: 1$/m);
  const md = r.read('denies.md');
  assert.equal((md.match(/^## /gm) ?? []).length, 1);
  assert.match(section(md, 'toolu_dup'), /transcript: p\/a\.jsonl:1/);
});

test('no transcript command is executed (a canary file named in a replayed command never appears)', () => {
  const r = mainReplay();
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(CANARY), false);
  assert.equal(fs.existsSync(CANARY_ECHO), false);
  assert.equal(fs.existsSync(path.join(PROJECT, 'marker')), false);
  assert.equal(fs.existsSync(path.join(PROJECT, 'script.sh')), false);
  assert.equal(fs.existsSync(path.join(HOME, '.claude', 'settings.json')), false);
  // the canary command was decided, not skipped
  assert.ok(r.read('denies.md').includes(CANARY));
  assert.ok(r.read('undecided.md').includes(CANARY_ECHO));
});
