import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { appendWritten, isAgentWritten, readWritten, writtenFileName } from '../src/log/written.mjs';
import { prune } from '../src/log/prune.mjs';
import { runEngine } from '../src/engine.mjs';
import { childEnv, withTempHome } from './helpers/isolation.mjs';

const LINES = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');

// Hermetic: one realpath'd temp root holding a fake HOME, state directories and hand-built repositories.
// The engine is spawned (or run in process) against temp directories only; nothing in a payload is ever
// executed and no real state directory is touched.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-written-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const ENGINE = fileURLToPath(new URL('../src/engine.mjs', import.meta.url));
const MINI = fileURLToPath(new URL('./fixtures/policy-strict-mini.json', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-17T12:00:00Z');
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

function payload(tool_name, tool_input, cwd, session_id = 'sess-1') {
  return { hook_event_name: 'PreToolUse', session_id, cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: 'toolu_01' };
}

function runPre(p, d, extraArgs = []) {
  const args = [ENGINE, 'pre', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin, ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify(p),
    env: { PATH: process.env.PATH, HOME },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, `engine exit ${r.status}; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.split('\n').filter((l) => l !== '')[0]);
}

const writtenDir = (state) => path.join(state, 'written');
const indexOf = (state, sid) => path.join(writtenDir(state), writtenFileName(sid));
const setAge = (file, ms) => {
  const t = new Date(NOW - ms);
  fs.utimesSync(file, t, t);
};

// ---- the engine records the writes of allowed and undecided calls --------------------------------

test('records writes of allowed calls only', () => {
  const repo = makeRepo('feature');
  const d = setup();

  const okTarget = path.join(repo, 'src', 'a.txt');
  const undecided = runPre(payload('Write', { file_path: okTarget, content: 'ok' }, repo), d);
  assert.equal(undecided.decision, 'undecided', JSON.stringify(undecided));

  // a denied call (built-in protected path) is never recorded
  const protectedTarget = path.join(HOME, '.claude', 'settings.json');
  const denied = runPre(payload('Write', { file_path: protectedTarget, content: 'x' }, repo), d);
  assert.equal(denied.decision, 'deny', JSON.stringify(denied));

  // a shell call that writes (touch) is recorded through its effective writes
  const marker = path.join(repo, 'marker');
  const shell = runPre(payload('Bash', { command: `touch ${marker}` }, repo), d);
  assert.notEqual(shell.decision, 'deny', JSON.stringify(shell));

  const lines = fs.readFileSync(indexOf(d.state, 'sess-1'), 'utf8').split('\n').filter((l) => l !== '');
  assert.deepEqual(lines, [okTarget, marker]);
  assert.ok(!lines.includes(protectedTarget));

  // a read-only call adds nothing
  runPre(payload('Read', { file_path: okTarget }, repo), d);
  assert.deepEqual(fs.readFileSync(indexOf(d.state, 'sess-1'), 'utf8').split('\n').filter((l) => l !== ''), [okTarget, marker]);

  // modes: file 0600, directory 0700
  assert.equal(fs.statSync(indexOf(d.state, 'sess-1')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(writtenDir(d.state)).mode & 0o777, 0o700);
});

test('a symlinked write target is recorded as its realpath', () => {
  const repo = makeRepo('feature');
  const d = setup();
  const real = path.join(repo, 'real.txt');
  fs.writeFileSync(real, '');
  const link = path.join(repo, 'link.txt');
  fs.symlinkSync(real, link);
  const r = runPre(payload('Write', { file_path: link, content: 'ok' }, repo), d);
  assert.notEqual(r.decision, 'deny', JSON.stringify(r));
  assert.deepEqual(fs.readFileSync(indexOf(d.state, 'sess-1'), 'utf8').split('\n').filter((l) => l !== ''), [real]);
});

test('a file written in an earlier session is found', () => {
  const repo = makeRepo('feature');
  const d = setup();
  const target = path.join(repo, 'notes.txt');
  runPre(payload('Write', { file_path: target, content: 'a' }, repo, 'session-one'), d);
  // a different session reads the index of all sessions
  const { set, incomplete } = readWritten(d.state, { now: Date.now() });
  assert.equal(incomplete, false);
  assert.ok(set.has(target), [...set].join('\n'));
  assert.ok(isAgentWritten(target, set, false));
  assert.ok(!isAgentWritten(path.join(repo, 'other.txt'), set, false));
});

test('an earlier session write of the repo config makes a git tree update opaque', () => {
  const repo = makeRepo('feature');
  const d = setup();
  const plain = runPre(payload('Bash', { command: 'git checkout main' }, repo, 'session-two'), d);
  assert.notEqual(plain.rule, 'builtin:opaque', JSON.stringify(plain));

  // an earlier session recorded a write of the repo's .git/config
  appendWritten(d.state, 'session-one', [path.join(repo, '.git', 'config')]);
  const after = runPre(payload('Bash', { command: 'git checkout main' }, repo, 'session-two'), d);
  assert.equal(after.decision, 'deny', JSON.stringify(after));
  assert.equal(after.rule, 'builtin:opaque');
  assert.match(after.reason, /git-config-written/);
});

test('hatch record-only mode still records writes', () => {
  const repo = makeRepo('feature');
  const d = setup();
  const target = path.join(repo, 'hatch.txt');
  runPre(payload('Write', { file_path: target, content: 'a' }, repo), d, ['--record-only']);
  assert.deepEqual(fs.readFileSync(indexOf(d.state, 'sess-1'), 'utf8').split('\n').filter((l) => l !== ''), [target]);
  // the hatch log line is written as before
  const day = fs.readdirSync(path.join(d.state, 'log'))[0];
  assert.match(fs.readFileSync(path.join(d.state, 'log', day), 'utf8'), /"decision":"hatch"/);
});

// ---- window and retention -------------------------------------------------------------------------

test('files older than 30 days are ignored and pruned', () => {
  const state = dir();
  appendWritten(state, 'old', ['/work/old.txt']);
  appendWritten(state, 'fresh', ['/work/fresh.txt']);
  setAge(indexOf(state, 'old'), 31 * DAY);
  setAge(indexOf(state, 'fresh'), 29 * DAY);

  const read = readWritten(state, { now: NOW });
  assert.deepEqual([...read.set], ['/work/fresh.txt']);
  assert.equal(read.incomplete, false);
  // a narrower window is honoured
  assert.deepEqual([...readWritten(state, { days: 10, now: NOW }).set], []);

  // logs: dated by file name
  const logDir = path.join(state, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, '2026-09-01.jsonl'), '{}\n'); // 46 days old
  fs.writeFileSync(path.join(logDir, '2026-09-17.jsonl'), '{}\n'); // 30 days old, kept
  fs.writeFileSync(path.join(logDir, '2026-09-16.jsonl'), '{}\n'); // 31 days old
  fs.writeFileSync(path.join(logDir, '2026-10-16.jsonl'), '{}\n');
  fs.writeFileSync(path.join(logDir, 'notes.txt'), 'not a log\n');
  fs.writeFileSync(path.join(state, 'health.json'), '{}');

  const r = prune(state, NOW);
  assert.equal(r.removed, 3);
  assert.ok(!fs.existsSync(indexOf(state, 'old')));
  assert.ok(fs.existsSync(indexOf(state, 'fresh')));
  assert.deepEqual(fs.readdirSync(logDir).sort(), ['2026-09-17.jsonl', '2026-10-16.jsonl', 'notes.txt']);
  assert.ok(fs.existsSync(path.join(state, 'health.json')));
});

test('prune never follows or removes a symlink and tolerates a missing state dir', () => {
  const state = dir();
  const victim = path.join(dir(), 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  fs.mkdirSync(writtenDir(state), { recursive: true });
  fs.symlinkSync(victim, path.join(writtenDir(state), 'link.txt'));
  const old = new Date(NOW - 90 * DAY);
  fs.lutimesSync(path.join(writtenDir(state), 'link.txt'), old, old);
  prune(state, NOW);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.deepEqual(prune(path.join(state, 'nope'), NOW), { removed: 0 });

  // a symlinked written/ directory is not entered
  const state2 = dir();
  const elsewhere = dir();
  const f = path.join(elsewhere, 'a.txt');
  fs.writeFileSync(f, '/x\n');
  setAge(f, 90 * DAY);
  fs.symlinkSync(elsewhere, writtenDir(state2));
  prune(state2, NOW);
  assert.ok(fs.existsSync(f));
  assert.equal(readWritten(state2, { now: NOW }).set.size, 0);
  assert.equal(readWritten(state2, { now: NOW }).incomplete, true); // a symlinked written/ is unreadable, not empty
});

test('the engine prunes at session start', () => {
  const { policy, state, admin } = setup();
  appendWritten(state, 'old', ['/work/old.txt']);
  setAge(indexOf(state, 'old'), 45 * DAY);
  // explicit temp policy, state and admin directories, and the home pinned: nothing real is read or written
  const argv = ['session-start', '--host', 'claude', '--policy', policy, '--state-dir', state, '--admin-dir', admin];
  const r = withTempHome(HOME, () => runEngine(argv, { stdin: '{}', now: NOW, env: childEnv(HOME) }));
  assert.equal(r.exit, 0);
  assert.match(JSON.parse(r.stdout).additionalContext, /^fence policy, profile default/); // the temp policy's start-of-session summary
  assert.ok(!fs.existsSync(indexOf(state, 'old')));
});

// ---- lookup ----------------------------------------------------------------------------------------

test('case-insensitive lookup', () => {
  const set = new Set(['/Work/Repo/Script.SH', '/work/straße.txt']);
  assert.equal(isAgentWritten('/work/repo/script.sh', set, true), true);
  assert.equal(isAgentWritten('/work/repo/script.sh', set, false), false);
  assert.equal(isAgentWritten('/Work/Repo/Script.SH', set, false), true);
  assert.equal(isAgentWritten('/WORK/STRASSE.TXT', set, true), true);
  assert.equal(isAgentWritten('/work/repo/other.sh', set, true), false);
  assert.equal(isAgentWritten(42, set, true), false);
  assert.equal(isAgentWritten('/work/x', null, true), false);
});

// ---- hostile session ids ---------------------------------------------------------------------------

test('a hostile session id cannot write outside written/', () => {
  const state = dir();
  const hostile = ['../../escape', '..', '.', '', 'a/b', 'a\\b', '/abs/path', 'x\0y', 'é'.repeat(300), 'A'.repeat(500), '.hidden', 'CON:'];
  for (const sid of hostile) {
    assert.equal(appendWritten(state, sid, ['/work/a.txt']).ok, true, JSON.stringify(sid));
  }
  const names = fs.readdirSync(writtenDir(state));
  for (const n of names) {
    assert.match(n, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.txt$/, n);
    assert.ok(Buffer.byteLength(n) <= 140);
  }
  assert.deepEqual(fs.readdirSync(state), ['written']);
  assert.equal(fs.existsSync(path.join(path.dirname(state), 'escape.txt')), false);
  // the same hostile id always maps to the same file, distinct ids to distinct files
  assert.equal(writtenFileName('../../escape'), writtenFileName('../../escape'));
  assert.notEqual(writtenFileName('../../escape'), writtenFileName('../../escape2'));
  assert.equal(writtenFileName('sess-1'), 'sess-1.txt');
  // a non-string id still maps to a safe name
  assert.match(writtenFileName(undefined), /^[A-Za-z0-9][A-Za-z0-9_-]*\.txt$/);
});

test('appendWritten refuses a symlinked written/ directory and a symlinked index file', () => {
  const state = dir();
  const elsewhere = dir();
  fs.symlinkSync(elsewhere, writtenDir(state));
  assert.equal(appendWritten(state, 'sess-1', ['/work/a.txt']).ok, false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const state2 = dir();
  fs.mkdirSync(writtenDir(state2), { mode: 0o700 });
  const victim = path.join(dir(), 'victim.txt');
  fs.writeFileSync(victim, 'keep\n');
  fs.symlinkSync(victim, indexOf(state2, 'sess-1'));
  assert.equal(appendWritten(state2, 'sess-1', ['/work/a.txt']).ok, false);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
});

test('appendWritten stores only absolute single-line paths and appends', () => {
  const state = dir();
  assert.equal(appendWritten(state, 's', ['/a/b.txt', 'relative.txt', '/has\nnewline', 7, '/c/d.txt', '/a/b.txt']).ok, true);
  assert.equal(appendWritten(state, 's', ['/e.txt']).ok, true);
  assert.deepEqual(fs.readFileSync(indexOf(state, 's'), 'utf8').split('\n').filter((l) => l !== ''), ['/a/b.txt', '/c/d.txt', '/e.txt']);
  // nothing to record creates nothing
  const empty = dir();
  assert.equal(appendWritten(empty, 's', []).ok, true);
  assert.equal(fs.existsSync(writtenDir(empty)), false);
  // a relative state dir is refused
  assert.equal(appendWritten('rel/state', 's', ['/x']).ok, false);
});

// ---- fix round 1 ------------------------------------------------------------------------------------

function inProcess(p, d, { extraArgs = [], ...opts } = {}) {
  const argv = ['pre', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin, ...extraArgs];
  const r = runEngine(argv, { stdin: JSON.stringify(p), now: NOW, env: { PATH: process.env.PATH, HOME }, ...opts });
  assert.equal(r.exit, 0);
  return JSON.parse(r.stdout);
}

function withHome(fn) {
  const saved = { HOME: process.env.HOME, FENCE_PROFILE: process.env.FENCE_PROFILE };
  process.env.HOME = HOME;
  delete process.env.FENCE_PROFILE;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('hatch: a computed-deny call under --record-only is indexed', () => {
  const repo = makeRepo('feature');
  const d = setup();
  const target = path.join(HOME, '.claude', 'settings.json');
  // enforcing: denied, not indexed
  const enforced = runPre(payload('Write', { file_path: target, content: 'x' }, repo), d);
  assert.equal(enforced.decision, 'deny');
  assert.equal(fs.existsSync(writtenDir(d.state)), false);
  // hatch: the same computed deny, but the call really writes
  const hatch = runPre(payload('Write', { file_path: target, content: 'x' }, repo), d, ['--record-only']);
  assert.equal(hatch.decision, 'deny');
  assert.deepEqual(LINES(indexOf(d.state, 'sess-1')), [target]);
});

test('hatch: a broken policy under --record-only still indexes the adapter write paths', () => {
  const repo = makeRepo('feature');
  const d = setup();
  fs.writeFileSync(d.policy, '{ not json');
  const relative = 'src/rel.txt';
  const absolute = path.join(repo, 'abs.txt');
  const r1 = runPre(payload('Write', { file_path: absolute, content: 'x' }, repo), d, ['--record-only']);
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.rule, 'builtin:policy-load');
  runPre(payload('Edit', { file_path: relative, old_string: 'a', new_string: 'b' }, repo), d, ['--record-only']);
  runPre(payload('NotebookEdit', { notebook_path: path.join(repo, 'n.ipynb'), new_source: 'x' }, repo), d, ['--record-only']);
  assert.deepEqual(LINES(indexOf(d.state, 'sess-1')), [absolute, path.join(repo, relative), path.join(repo, 'n.ipynb')]);
  // enforcing mode with the same broken policy records nothing
  const d2 = setup();
  fs.writeFileSync(d2.policy, '{ not json');
  runPre(payload('Write', { file_path: absolute, content: 'x' }, repo), d2);
  assert.equal(fs.existsSync(writtenDir(d2.state)), false);
});

test('readWritten reports an index file over the read cap as incomplete', () => {
  const state = dir();
  fs.mkdirSync(writtenDir(state), { mode: 0o700 });
  const file = indexOf(state, 's');
  fs.writeFileSync(file, `/first/one.txt\n${'/pad/x\n'.repeat(100)}/last/one.txt\n`);
  const cap = readWritten(state, { now: Date.now(), maxReadBytes: 64 });
  assert.equal(cap.incomplete, true);
  assert.ok(cap.set.has('/last/one.txt'));
  assert.ok(!cap.set.has('/first/one.txt'));
  const whole = readWritten(state, { now: Date.now() });
  assert.equal(whole.incomplete, false);
  assert.ok(whole.set.has('/first/one.txt'));
});

test('readWritten: a missing written/ is complete, an unreadable file or directory is incomplete', { skip: process.getuid?.() === 0 ? 'running as root' : false }, () => {
  const none = readWritten(dir(), { now: Date.now() });
  assert.equal(none.set.size, 0);
  assert.equal(none.incomplete, false);

  const state = dir();
  fs.mkdirSync(writtenDir(state), { mode: 0o700 });
  fs.writeFileSync(indexOf(state, 'good'), '/ok/a.txt\n');
  const bad = indexOf(state, 'bad');
  fs.writeFileSync(bad, '/ok/b.txt\n');
  fs.chmodSync(bad, 0o000);
  try {
    const r = readWritten(state, { now: Date.now() });
    assert.equal(r.incomplete, true);
    assert.ok(r.set.has('/ok/a.txt'));
  } finally {
    fs.chmodSync(bad, 0o600);
  }

  // a non-file entry that carries a session file name
  const odd = dir();
  fs.mkdirSync(path.join(writtenDir(odd), 'sub.txt'), { recursive: true });
  assert.equal(readWritten(odd, { now: Date.now() }).incomplete, true);
});

test('an index over the read cap makes git checkout opaque through the engine', () => {
  withHome(() => {
    const repo = makeRepo('feature');
    const d = setup();
    // .git/config was written first; padding pushed it out of the visible tail
    appendWritten(d.state, 'earlier', [path.join(repo, '.git', 'config')]);
    appendWritten(d.state, 'earlier', Array.from({ length: 50 }, (_, i) => `/pad/file-${i}.txt`));
    const command = payload('Bash', { command: 'git checkout main' }, repo, 'session-two');
    const visible = readWritten(d.state, { now: NOW, maxReadBytes: 200 });
    assert.equal(visible.incomplete, true);
    assert.ok(!visible.set.has(path.join(repo, '.git', 'config')));

    const complete = inProcess(command, d, { now: Date.now() });
    assert.equal(complete.rule, 'builtin:opaque', JSON.stringify(complete)); // the config is in the full index
    const clean = setup();
    appendWritten(clean.state, 'earlier', Array.from({ length: 50 }, (_, i) => `/pad/file-${i}.txt`));
    assert.notEqual(inProcess(command, clean, { now: Date.now() }).rule, 'builtin:opaque');

    const capped = inProcess(command, clean, { now: Date.now(), writtenMaxReadBytes: 200 });
    assert.equal(capped.decision, 'deny', JSON.stringify(capped));
    assert.equal(capped.rule, 'builtin:opaque');
    assert.match(capped.reason, /git-config-written/);
    // the failure is recorded in health.json
    assert.ok(JSON.parse(fs.readFileSync(path.join(clean.state, 'health.json'), 'utf8')).writtenReadFailure);
  });
});

test('cross-call dedupe skips a path already in the session file', () => {
  const state = dir();
  appendWritten(state, 's', ['/a.txt', '/b.txt']);
  appendWritten(state, 's', ['/b.txt', '/c.txt']);
  appendWritten(state, 's', ['/a.txt', '/c.txt']);
  assert.deepEqual(LINES(indexOf(state, 's')), ['/a.txt', '/b.txt', '/c.txt']);
  // nothing new: the file is untouched
  const before = fs.statSync(indexOf(state, 's')).size;
  assert.equal(appendWritten(state, 's', ['/a.txt']).ok, true);
  assert.equal(fs.statSync(indexOf(state, 's')).size, before);
  // a file of 1 MiB or more is not read for dedupe
  const big = dir();
  fs.mkdirSync(writtenDir(big), { mode: 0o700 });
  fs.writeFileSync(indexOf(big, 's'), `/dup.txt\n${'#'.repeat(1024 * 1024)}\n`);
  appendWritten(big, 's', ['/dup.txt']);
  assert.equal(LINES(indexOf(big, 's')).filter((l) => l === '/dup.txt').length, 2);
});

test('a call with more than 1000 paths appends the first 1000 and an #incomplete line', () => {
  const state = dir();
  const paths = Array.from({ length: 1005 }, (_, i) => `/bulk/f${i}.txt`);
  assert.equal(appendWritten(state, 's', paths).ok, true);
  const lines = LINES(indexOf(state, 's'));
  assert.equal(lines.length, 1001);
  assert.equal(lines[0], '/bulk/f0.txt');
  assert.equal(lines[999], '/bulk/f999.txt');
  assert.equal(lines[1000], '#incomplete');
  const r = readWritten(state, { now: Date.now() });
  assert.equal(r.incomplete, true);
  assert.equal(r.set.size, 1000);
  assert.ok(!r.set.has('/bulk/f1004.txt'));
  // exactly 1000 is complete
  const exact = dir();
  appendWritten(exact, 's', paths.slice(0, 1000));
  assert.equal(readWritten(exact, { now: Date.now() }).incomplete, false);
});
