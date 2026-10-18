import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allowOnce, GRANT_LIFETIME_MS } from '../src/cli/allowonce.mjs';
import { COMMANDS } from '../src/cli/humanonly.mjs';
import { runEngine } from '../src/engine.mjs';
import { GRANT_MAX_LIFETIME_MS, MAX_GRANTS, loadGrants } from '../src/eval/grants.mjs';

// Hermetic: one realpath'd temp root (macOS: /var -> /private/var) holding a fake HOME, the policy,
// state and admin directories and hand-built repositories. The engine runs in-process with an
// isRootOwned stub (a temp file is never root-owned); `fence allow-once` runs with an injected gate
// and an admin writer that writes into the temp admin directory (nothing runs sudo). The payloads
// are only parsed, never executed.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-grants-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });

const MINI = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'policy-strict-mini.json');
const SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-10-17T12:00:00Z');
const MIN = 60 * 1000;
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
const isRootOwned = () => true;
const OK_GATE = () => ({ ok: true });
let counter = 0;

function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function put(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function makeRepo() {
  const root = dir();
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  put(path.join(git, 'HEAD'), 'ref: refs/heads/feature\n');
  put(path.join(git, 'config'), '[core]\n\tbare = false\n');
  for (const b of ['main', 'feature']) put(path.join(git, 'refs', 'heads', b), `${SHA}\n`);
  return root;
}

// Fresh policy/state/admin directories for one scenario.
function dirs(policyText) {
  const base = dir();
  const policy = put(path.join(base, 'policy.json'), policyText ?? fs.readFileSync(MINI, 'utf8'));
  const state = path.join(base, 'state');
  const admin = path.join(base, 'admin');
  fs.mkdirSync(state);
  fs.mkdirSync(admin);
  return { policy, state, admin };
}

// The admin writer the CLI wiring replaces with adminWrite through sudo: writes into a temp admin dir.
function fakeAdmin(adminDir) {
  const writes = [];
  const adminWriter = (rel, data) => {
    writes.push([rel, String(data)]);
    put(path.join(adminDir, rel), data);
    return { path: path.join(adminDir, rel) };
  };
  return { writes, adminWriter };
}

// `fence allow-once <target>` into d.admin at time `at`; returns the command result.
async function grant(d, target, { at = NOW, cwd } = {}) {
  const a = fakeAdmin(d.admin);
  const r = await allowOnce({ argv: [target], home: HOME, cwd, now: () => at, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: d.admin });
  assert.equal(r.ok, true, r.reason);
  return r;
}

function payload(tool_name, tool_input, cwd) {
  return { hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: 'toolu_01' };
}

// HOME (read by os.homedir()) and FENCE_PROFILE pinned for the in-process engine, restored after.
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

function engine(body, d, { at = NOW, stub = isRootOwned } = {}) {
  const argv = ['pre', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin];
  const r = runEngine(argv, { stdin: JSON.stringify(body), now: at, env: { PATH: process.env.PATH, HOME }, isRootOwned: stub });
  assert.equal(r.exit, 0);
  return JSON.parse(r.stdout);
}

const unused = (d, at = NOW, stub = isRootOwned) => loadGrants(d.admin, d.state, at, { isRootOwned: stub }).length;
const writeTo = (file, repo) => payload('Write', { file_path: file, content: '{}' }, repo);

function logLines(d) {
  const logDir = path.join(d.state, 'log');
  return fs.readdirSync(logDir).flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)));
}

test('a grant allows exactly one write to exactly that realpath', async () => {
  const repo = makeRepo();
  const d = dirs();
  // the argument is spelled through a symlink; the grant records the realpath
  const alias = path.join(dir(), 'alias');
  fs.symlinkSync(path.join(HOME, '.claude'), alias);
  const r = await grant(d, path.join(alias, 'settings.json'));
  assert.equal(r.path, SETTINGS);
  const [g] = loadGrants(d.admin, d.state, NOW, { isRootOwned });
  assert.equal(g.path, SETTINGS);

  withHome(() => {
    // Control: without any grant the write is denied by the built-in self-protection.
    const bare = dirs();
    assert.equal(engine(writeTo(SETTINGS, repo), bare).rule, 'builtin:self-protection');

    // Another protected path is not covered by the grant, and the grant stays unused.
    const other = engine(writeTo(CODEX_CONFIG, repo), d);
    assert.equal(other.decision, 'deny');
    assert.equal(other.rule, 'builtin:self-protection');
    assert.equal(unused(d), 1, 'a write to another path leaves the grant unused');

    // The path itself, written through the symlink spelling, is allowed once.
    const first = engine(writeTo(path.join(alias, 'settings.json'), repo), d);
    assert.equal(first.decision, 'allow', JSON.stringify(first));
    assert.equal(first.rule, 'grant');
    assert.equal(unused(d), 0, 'the grant is consumed');
  });
});

test('a second write is denied again', async () => {
  const repo = makeRepo();
  const d = dirs();
  await grant(d, SETTINGS);
  withHome(() => {
    assert.equal(engine(writeTo(SETTINGS, repo), d).rule, 'grant');
    const second = engine(writeTo(SETTINGS, repo), d);
    assert.equal(second.decision, 'deny');
    assert.equal(second.rule, 'builtin:self-protection');
    // a shell write is denied too
    const shell = engine(payload('Bash', { command: `cp ./marker ${SETTINGS}` }, repo), d);
    assert.equal(shell.decision, 'deny');
  });
});

test('an expired grant is ignored', async () => {
  const repo = makeRepo();
  const d = dirs();
  const r = await grant(d, SETTINGS);
  assert.equal(r.expires, new Date(NOW + 10 * MIN).toISOString());
  withHome(() => {
    // 11 minutes later the grant has expired
    const late = NOW + 11 * MIN;
    assert.equal(unused(d, late), 0);
    const denied = engine(writeTo(SETTINGS, repo), d, { at: late });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.rule, 'builtin:self-protection');
    // and a grant that was written already expired (the clock behind it) never applies
    const stale = dirs();
    writeStaleGrant(stale, NOW - 11 * MIN);
    assert.equal(engine(writeTo(SETTINGS, repo), stale).rule, 'builtin:self-protection');
  });
});

// A synchronous grant file the way allowOnce writes it, for a clock in the past.
function writeStaleGrant(d, at) {
  put(path.join(d.admin, 'grants', 'stale.json'), JSON.stringify({ path: SETTINGS, expires: new Date(at + GRANT_LIFETIME_MS).toISOString() }));
}

test('a non-root-owned grant file is ignored', async () => {
  const repo = makeRepo();
  const d = dirs();
  await grant(d, SETTINGS);
  withHome(() => {
    // the ownership check refuses the file
    const refused = engine(writeTo(SETTINGS, repo), d, { stub: () => false });
    assert.equal(refused.decision, 'deny');
    assert.equal(refused.rule, 'builtin:self-protection');
    assert.equal(unused(d, NOW, () => false), 0);
    assert.equal(unused(d), 1, 'the grant itself is intact and was never consumed');
    // the real ownership check refuses a temp file owned by the current (non-root) user
    if (process.getuid?.() !== 0) {
      assert.deepEqual(loadGrants(d.admin, d.state, NOW), []);
      const real = runEngine(['pre', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin], {
        stdin: JSON.stringify(writeTo(SETTINGS, repo)),
        now: NOW,
        env: { PATH: process.env.PATH, HOME },
      });
      assert.equal(JSON.parse(real.stdout).rule, 'builtin:self-protection');
    }
  });
});

test('a grant never overrides a policy deny', async () => {
  const repo = makeRepo();
  const policy = JSON.parse(fs.readFileSync(MINI, 'utf8'));
  policy.rules.push({
    id: 'no-claude-settings',
    decision: 'deny',
    match: { paths: ['~/.claude/settings.json'], access: 'write' },
    why: 'The policy denies this file.',
  });
  const d = dirs(JSON.stringify(policy));
  await grant(d, SETTINGS);
  withHome(() => {
    const denied = engine(writeTo(SETTINGS, repo), d);
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.rule, 'no-claude-settings');
    assert.equal(unused(d), 1, 'the policy deny leaves the grant unused');
  });
});

test('a grant is not consumed when the call is denied by another rule', async () => {
  const repo = makeRepo();
  const d = dirs();
  await grant(d, SETTINGS);
  withHome(() => {
    // the granted write rides with a network fetch: the policy denies the call
    const mixed = engine(payload('Bash', { command: `echo x > ${SETTINGS}; curl https://example.com` }, repo), d);
    assert.equal(mixed.decision, 'deny');
    assert.equal(mixed.rule, 'network-fetch');
    assert.equal(unused(d), 1, 'the grant must still be unused');
    // the same grant then covers its one write
    assert.equal(engine(writeTo(SETTINGS, repo), d).rule, 'grant');
    assert.equal(unused(d), 0);
  });
});

test('the use is logged', async () => {
  const repo = makeRepo();
  const d = dirs();
  await grant(d, SETTINGS);
  withHome(() => {
    const allowed = engine(writeTo(SETTINGS, repo), d);
    assert.equal(allowed.rule, 'grant');
    const denied = engine(writeTo(SETTINGS, repo), d);
    assert.equal(denied.rule, 'builtin:self-protection');
  });
  const lines = logLines(d);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision, 'allow');
  assert.equal(lines[0].rule, 'grant');
  assert.deepEqual(lines[0].scope.writes, [SETTINGS]);
  assert.equal(lines[1].decision, 'deny');
  assert.equal(lines[1].rule, 'builtin:self-protection');
  // the used marker is keyed by the grant's sha in the user state directory
  const markers = fs.readdirSync(path.join(d.state, 'grants-used'));
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^[0-9a-f]{64}$/);
});

test('allow-once requires the gate and writes through adminWrite', async () => {
  const adminDir = path.join(dir(), 'admin');
  const target = SETTINGS;

  // no gate: refused, nothing written
  const a = fakeAdmin(adminDir);
  const noGate = await allowOnce({ argv: [target], home: HOME, now: () => NOW, adminWriter: a.adminWriter, adminDir });
  assert.equal(noGate.ok, false);
  assert.match(noGate.reason, /sudo/);
  assert.equal(a.writes.length, 0);

  // a refusing gate (as a value, as a throw): nothing written
  for (const gate of [() => ({ ok: false, reason: 'no fresh sudo' }), () => false, () => { throw new Error('boom'); }]) {
    const b = fakeAdmin(adminDir);
    const r = await allowOnce({ argv: [target], home: HOME, now: () => NOW, gate, adminWriter: b.adminWriter, adminDir });
    assert.equal(r.ok, false);
    assert.equal(b.writes.length, 0);
  }

  // an argument problem is refused before the gate is asked
  let asked = 0;
  const gate = () => (asked++, { ok: true });
  for (const argv of [[], [''], ['a\nb'], [`${HOME}/x\0y`], ['~someone/x'], [target, 'extra'], ['--bogus']]) {
    const c = fakeAdmin(adminDir);
    const r = await allowOnce({ argv, home: HOME, now: () => NOW, gate, adminWriter: c.adminWriter, adminDir });
    assert.equal(r.ok, false, JSON.stringify(argv));
    assert.equal(c.writes.length, 0);
  }
  assert.equal(asked, 0, 'refused before the gate');

  // no writer and no process runner: nothing can be written
  const noRun = await allowOnce({ argv: [target], home: HOME, now: () => NOW, gate, adminDir });
  assert.equal(noRun.ok, false);
  assert.equal(asked, 0);

  // the default writer is adminWrite: every step is a sudo call by an absolute program, the data
  // arrives on tee's stdin, and the target is a new file under grants/
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await allowOnce({ argv: [target], home: HOME, now: () => NOW, gate, run, adminDir });
  assert.equal(r.ok, true, r.reason);
  assert.equal(asked, 1);
  // install -d for the admin directory and for grants/, then tee, chmod, chown and mv
  assert.equal(calls.length, 6);
  for (const c of calls) {
    assert.equal(c.cmd, '/usr/bin/sudo');
    assert.ok(path.isAbsolute(c.args[0]), `${c.args[0]} is an absolute program`);
  }
  const tee = calls.find((c) => c.args[0] === COMMANDS.tee);
  assert.ok(tee, 'the data goes through sudo tee');
  const { nonce: teeNonce, ...teeBody } = JSON.parse(tee.input);
  assert.match(teeNonce, /^[0-9a-f]{16,}$/);
  assert.deepEqual(teeBody, { path: SETTINGS, expires: new Date(NOW + GRANT_LIFETIME_MS).toISOString() });
  assert.match(tee.args[1], new RegExp(`^${adminDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/grants/[A-Za-z0-9][A-Za-z0-9._-]*\\.json\\.tmp$`));
  const mv = calls.find((c) => c.args[0] === COMMANDS.mv);
  assert.equal(mv.args[3], r.file);
  assert.equal(calls.some((c) => c.args[0] === COMMANDS.install && c.args.at(-1) === path.join(adminDir, 'grants')), true);
});

test('the grant records the realpath and lives ten minutes', async () => {
  assert.equal(GRANT_LIFETIME_MS, 10 * MIN);
  assert.equal(GRANT_LIFETIME_MS, GRANT_MAX_LIFETIME_MS);
  const adminDir = dir();

  // a path that does not exist yet resolves through its nearest existing parent (a symlinked one)
  const real = dir();
  const link = path.join(dir(), 'link');
  fs.symlinkSync(real, link);
  const a = fakeAdmin(adminDir);
  const r = await allowOnce({ argv: [path.join(link, 'sub', 'new.txt')], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: a.adminWriter, adminDir });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.path, path.join(real, 'sub', 'new.txt'));
  assert.equal(a.writes.length, 1);
  const [rel, text] = a.writes[0];
  assert.match(rel, /^grants\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);
  const { nonce, ...body } = JSON.parse(text);
  assert.match(nonce, /^[0-9a-f]{16,}$/);
  assert.deepEqual(body, { path: path.join(real, 'sub', 'new.txt'), expires: new Date(NOW + 10 * MIN).toISOString() });

  // a relative path resolves against the given working directory, `~/` against home
  const cwdDir = dir();
  put(path.join(cwdDir, 'marker'), '');
  const b = fakeAdmin(adminDir);
  const rel1 = await allowOnce({ argv: ['./marker'], home: HOME, cwd: cwdDir, now: () => NOW, gate: OK_GATE, adminWriter: b.adminWriter, adminDir });
  assert.equal(rel1.path, path.join(cwdDir, 'marker'));
  const tilde = await allowOnce({ argv: ['~/.claude/settings.json'], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: b.adminWriter, adminDir });
  assert.equal(tilde.path, SETTINGS);
  // a relative path with no working directory to resolve against is refused
  const none = await allowOnce({ argv: ['./marker'], home: HOME, cwd: 'not/absolute', now: () => NOW, gate: OK_GATE, adminWriter: b.adminWriter, adminDir });
  assert.equal(none.ok, false);
  assert.equal(b.writes.length, 2, 'only the two good grants were written');

  // two grants for one path get two distinct file names
  const c = fakeAdmin(adminDir);
  for (let i = 0; i < 2; i++) await allowOnce({ argv: [SETTINGS], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: c.adminWriter, adminDir });
  assert.notEqual(c.writes[0][0], c.writes[1][0]);

  // a failing admin writer is reported, not thrown
  const failing = await allowOnce({ argv: [SETTINGS], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: () => { throw new Error('sudo tee failed'); }, adminDir });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /sudo tee failed/);
});

// Fill d.admin/grants with `n` already-expired grant files named like allowOnce names them, older
// than NOW (so, by name, older than a grant made at NOW).
function fillExpired(d, n) {
  for (let i = 0; i < n; i++) {
    const name = `${NOW - 20 * MIN - (n - i) * 1000}-${String(i).padStart(12, '0')}.json`;
    put(path.join(d.admin, 'grants', name), JSON.stringify({ path: SETTINGS, expires: new Date(NOW - 10 * MIN).toISOString() }));
  }
}

test('a new grant applies when grants/ already holds MAX_GRANTS expired files', async () => {
  const repo = makeRepo();
  const d = dirs();
  fillExpired(d, MAX_GRANTS);
  assert.equal(unused(d), 0, 'expired grants never apply');
  const a = fakeAdmin(d.admin);
  const r = await allowOnce({ argv: [SETTINGS], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: d.admin });
  assert.equal(r.ok, true, r.reason);
  // the engine reads the newest names first, so the new grant is among the MAX_GRANTS it reads
  assert.equal(unused(d), 1);
  withHome(() => {
    const allowed = engine(writeTo(SETTINGS, repo), d);
    assert.equal(allowed.decision, 'allow', JSON.stringify(allowed));
    assert.equal(allowed.rule, 'grant');
  });
});

test('allow-once warns when grants/ holds MAX_GRANTS or more files', async () => {
  const full = dirs();
  fillExpired(full, MAX_GRANTS);
  const out = [];
  const a = fakeAdmin(full.admin);
  const r = await allowOnce({ argv: [SETTINGS], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: full.admin, io: { out: (s) => out.push(s) } });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.warning, /ignored/);
  assert.match(r.warning, /root/);
  assert.ok(out.some((s) => /ignored/.test(s) && /root/.test(s)), 'the warning is also shown to the human');

  const few = dirs();
  fillExpired(few, MAX_GRANTS - 1);
  const b = fakeAdmin(few.admin);
  const ok = await allowOnce({ argv: [SETTINGS], home: HOME, now: () => NOW, gate: OK_GATE, adminWriter: b.adminWriter, adminDir: few.admin });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.warning, undefined);
});

test('a finite clock outside the Date range is a refusal, not a throw', async () => {
  const d = dirs();
  const a = fakeAdmin(d.admin);
  for (const at of [8.64e15, 8.64e15 + 1, -8.64e15 - 2 * GRANT_LIFETIME_MS]) {
    const r = await allowOnce({ argv: [SETTINGS], home: HOME, now: () => at, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: d.admin });
    assert.equal(r.ok, false, String(at));
    assert.match(r.reason, /clock/);
  }
  assert.equal(a.writes.length, 0);
});

test('two grants for one path in the same millisecond have different content and shas', async () => {
  const d = dirs();
  await grant(d, SETTINGS);
  await grant(d, SETTINGS);
  const files = fs.readdirSync(path.join(d.admin, 'grants'));
  assert.equal(files.length, 2);
  const texts = files.map((f) => fs.readFileSync(path.join(d.admin, 'grants', f), 'utf8'));
  assert.notEqual(texts[0], texts[1]);
  const grants = loadGrants(d.admin, d.state, NOW, { isRootOwned });
  assert.equal(grants.length, 2);
  assert.notEqual(grants[0].sha, grants[1].sha);
});

test('allow-once shows the resolved realpath before the sudo gate runs', async () => {
  const alias = path.join(dir(), 'alias');
  fs.symlinkSync(path.join(HOME, '.claude'), alias);
  const d = dirs();
  const a = fakeAdmin(d.admin);
  const out = [];
  let seenAtGate = null;
  let gateArg = null;
  const gate = (arg) => {
    seenAtGate = out.slice();
    gateArg = arg;
    return { ok: true };
  };
  const r = await allowOnce({ argv: [path.join(alias, 'settings.json')], home: HOME, now: () => NOW, gate, adminWriter: a.adminWriter, adminDir: d.admin, io: { out: (s) => out.push(s) } });
  assert.equal(r.ok, true, r.reason);
  assert.ok(seenAtGate, 'the gate ran');
  assert.ok(seenAtGate.some((s) => s.includes(SETTINGS)), `the realpath was shown before the gate: ${JSON.stringify(seenAtGate)}`);
  assert.equal(gateArg?.path, SETTINGS, 'the gate also receives the realpath');

  // a refused gate still showed the human which path was at stake
  const out2 = [];
  const refused = await allowOnce({ argv: [path.join(alias, 'settings.json')], home: HOME, now: () => NOW, gate: () => false, adminWriter: a.adminWriter, adminDir: d.admin, io: { out: (s) => out2.push(s) } });
  assert.equal(refused.ok, false);
  assert.ok(out2.some((s) => s.includes(SETTINGS)));
});
