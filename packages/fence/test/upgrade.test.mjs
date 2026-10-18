import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { install } from '../src/cli/install.mjs';
import { upgrade, rollback } from '../src/cli/upgrade.mjs';
import { uninstall } from '../src/cli/uninstall.mjs';
import { humanOnly, SUDO } from '../src/cli/humanonly.mjs';
import { fencePaths } from '../src/cli/paths.mjs';

// Hermetic: every test gets a temp HOME under os.tmpdir(). npm, git, sudo, claude and codex are
// never run: the injected `run` fakes them (a fake `npm install` copies this package into the temp
// prefix with the requested version). Node is the only real program: the installed launcher check
// runs the copied watchdog with process.execPath against temp directories.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-upgrade-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NPM = '/fake/bin/npm';
const V1 = '0.1.0';
const V2 = '0.2.0';
const V3 = '0.3.0';
const TTY = { isTTY: true };
const AUDIT_OK = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n';

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A directory holding executable files with the given names (never executed: the runner fakes them).
function binDir(...names) {
  const d = newDir('bin');
  for (const n of names) fs.writeFileSync(path.join(d, n), '', { mode: 0o755 });
  return d;
}

function copyPackage(dest, version) {
  fs.mkdirSync(dest, { recursive: true });
  for (const part of ['src', 'bin', 'policies']) {
    const from = path.join(PKG_DIR, part);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, part), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify({ ...pkg, version })}\n`);
  fs.writeFileSync(path.join(dest, 'COPY'), `${version}\n`);
}

// Fakes npm (install copies the package at the version named by the last argument; audit passes),
// git, sudo, claude and codex. The installed launcher trampolines really run. Every call is recorded.
function fakeRun({ sudoFail = false, cliStatus = {}, audit = AUDIT_OK } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const name = path.basename(cmd);
    calls.push({ cmd, name, args: [...args] });
    if (name === 'fence-hook') {
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: 20_000 });
    }
    if (cmd === SUDO) return { status: sudoFail && args[0] === '-v' ? 1 : 0, stdout: '', stderr: '' };
    if (cmd === NPM && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const spec = args[args.length - 1];
      copyPackage(path.join(prefix, 'node_modules', '@triqual', 'fence'), spec.slice(spec.lastIndexOf('@') + 1));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === NPM && args[0] === 'audit') return { status: 0, stdout: audit, stderr: '' };
    if (name === 'git') return { status: 0, stdout: 'git version 2.47.1 (fake)\n', stderr: '' };
    if (name === 'claude' || name === 'codex') return { status: cliStatus[name] ?? 0, stdout: '', stderr: cliStatus[name] ? `${name} failed (fake)` : '' };
    if (cmd === NODE) {
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: 20_000 });
    }
    return { status: 127, stdout: '', stderr: `unexpected program ${cmd}` };
  };
  return { run, calls };
}

function okSmoke() {
  const calls = [];
  const smoke = (o) => {
    calls.push({ ...o, engineExisted: fs.existsSync(path.join(o.engineDir, 'src', 'engine.mjs')) });
    return { ok: true, failures: [], latencyMs: [1, 2] };
  };
  return { calls, smoke };
}

const failSmoke = () => ({ ok: false, failures: ['claude deny: expected permissionDecision deny'], latencyMs: [] });

const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);
const listing = (d) => (exists(d) ? fs.readdirSync(d).sort() : []);

// An installed fence 0.1.0 in a temp HOME (installed with an injected passing smoke test).
async function installed({ cli = [] } = {}) {
  const home = newDir('home');
  const env = { PATH: binDir('git', ...cli) };
  const f = fakeRun();
  const s = okSmoke();
  const base = { home, run: f.run, env, nodePath: NODE, npmPath: NPM, smoke: s.smoke };
  const r = await install({ ...base, version: V1 });
  assert.equal(r.ok, true, r.reason);
  return { home, env, p: fencePaths(home), base };
}

const noLeftovers = (p) => {
  for (const d of [p.binDir, p.shareDir, p.versionsDir]) {
    for (const name of listing(d)) assert.ok(!/tmp|staging|\.old-|\.bak-/.test(name), `${d}: ${name}`);
  }
};

test('a failed smoke test keeps the old version current', async () => {
  const { p, base } = await installed();
  const before = Object.fromEntries([p.current, p.watchdog, p.watchdogBundle, p.shim, p.shimModule, p.smokeResult].map((f) => [f, read(f)]));
  const f = fakeRun();
  const r = await upgrade({ ...base, run: f.run, version: V2, smoke: failSmoke });
  assert.equal(r.ok, false);
  assert.match(r.reason, /smoke/);
  assert.match(r.reason, new RegExp(`${V1.replaceAll('.', '\\.')} stays current`));
  assert.match(r.reason, /permissionDecision deny/);
  for (const [file, text] of Object.entries(before)) assert.equal(read(file), text, file);
  assert.deepEqual(listing(p.versionsDir), [V1]);
  assert.equal(read(path.join(p.versionsDir, V1, 'COPY')), `${V1}\n`);
  noLeftovers(p);
  // the launcher check never ran: nothing was replaced
  assert.equal(f.calls.some((c) => c.name === 'fence-hook'), false);
});

test('upgrade keeps exactly one previous version', async () => {
  const { p, base, home } = await installed();
  // a directory that is not a version is not pruned
  fs.mkdirSync(path.join(p.versionsDir, 'notes'));
  const s = okSmoke();
  const f = fakeRun();
  const r2 = await upgrade({ ...base, run: f.run, smoke: s.smoke, version: V2 });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.version, V2);
  assert.equal(r2.previous, V1);
  assert.deepEqual(r2.pruned, []);
  assert.deepEqual(listing(p.versionsDir), [V1, V2, 'notes']);
  assert.equal(read(p.current), `${V2}\n`);
  // the same verification as install: npm install, then npm audit signatures, then the smoke test
  const programs = f.calls.map((c) => (c.cmd === NPM ? `npm ${c.args[0]}` : c.name));
  assert.ok(programs.indexOf('npm install') < programs.indexOf('npm audit'));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].engineExisted, true);
  // the installed launcher was checked end to end before `current` moved
  assert.ok(f.calls.some((c) => c.name === 'fence-hook' && c.args[0] === 'pre'));
  // the smoke result is recorded for doctor
  const rec = JSON.parse(read(p.smokeResult));
  assert.equal(rec.version, V2);
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.latencyMs, [1, 2]);
  // the launchers are the same files, pointing at the same Node and bundle
  assert.equal(read(p.watchdog), `#!/bin/sh\nexec '${NODE}' '${p.watchdogBundle}' "$@"\n`);
  assert.equal(read(p.watchdogBundle).split('\n')[0], `#!${NODE}`);
  // a third version prunes the first one
  const r3 = await upgrade({ ...base, run: fakeRun().run, smoke: s.smoke, version: V3 });
  assert.equal(r3.ok, true, r3.reason);
  assert.equal(r3.previous, V2);
  assert.deepEqual(r3.pruned, [V1]);
  assert.deepEqual(listing(p.versionsDir), [V2, V3, 'notes']);
  assert.equal(read(p.current), `${V3}\n`);
  noLeftovers(p);
  // the installed CLI shim follows `current`
  const shimRun = spawnSync(p.shim, ['version'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(shimRun.stdout.trim(), `fence ${V3}`, shimRun.stderr);
});

test('upgrade refuses a range, the current version and an install that is not there', async () => {
  const { p, base } = await installed();
  for (const version of ['^0.2.0', 'latest', '0.2', '', V1]) {
    const f = fakeRun();
    const r = await upgrade({ ...base, run: f.run, version });
    assert.equal(r.ok, false, version);
    assert.deepEqual(f.calls, [], version);
  }
  assert.equal(read(p.current), `${V1}\n`);
  const empty = newDir('home');
  const r = await upgrade({ ...base, home: empty, version: V2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /install/);
  assert.deepEqual(listing(empty), []);
});

test('a failing provenance check or launcher check leaves the installed state as it was', async () => {
  const { p, base } = await installed();
  const before = Object.fromEntries([p.current, p.watchdog, p.watchdogBundle, p.shim, p.shimModule].map((f) => [f, read(f)]));
  const bad = await upgrade({ ...base, run: fakeRun({ audit: 'audited 1 package in 0s\n\n1 package has a verified registry signature\n' }).run, version: V2 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /attestation/);
  const f = fakeRun();
  const failing = (cmd, args, opts) => (path.basename(cmd) === 'fence-hook' ? { status: 1, stdout: '', stderr: 'launcher failed (fake)' } : f.run(cmd, args, opts));
  const launcher = await upgrade({ ...base, run: failing, smoke: okSmoke().smoke, version: V2 });
  assert.equal(launcher.ok, false);
  assert.match(launcher.reason, /launcher/);
  for (const [file, text] of Object.entries(before)) assert.equal(read(file), text, file);
  assert.deepEqual(listing(p.versionsDir), [V1]);
  noLeftovers(p);
});

// The command table runs requireHuman and then the sudo gate before the implementation.
const handle = (command, impl, ctx) => humanOnly(command).handler({ stdin: TTY, env: {}, impl, ...ctx });

test('rollback switches back and requires the gate', async () => {
  const { p, base, home } = await installed();
  const up = await upgrade({ ...base, run: fakeRun().run, version: V2 });
  assert.equal(up.ok, true, up.reason);
  // the target version's own bundler builds the bundle: mark it
  const bundler = path.join(p.versionsDir, V1, 'src', 'build', 'bundle-watchdog.mjs');
  fs.copyFileSync(bundler, path.join(path.dirname(bundler), 'bundle-watchdog-orig.mjs'));
  fs.writeFileSync(
    bundler,
    "import { buildWatchdog as orig } from './bundle-watchdog-orig.mjs';\nexport const buildWatchdog = (o) => `${orig(o)}// built-from-previous\\n`;\n",
  );
  const state = () => [p.current, p.watchdogBundle, p.smokeResult].map(read);
  const before = state();

  // not a terminal, an agent session, a failing sudo: nothing runs, nothing changes
  const noTty = fakeRun();
  assert.throws(() => handle('rollback', rollback, { ...base, run: noTty.run, stdin: { isTTY: false } }), /terminal/);
  assert.throws(() => handle('rollback', rollback, { ...base, run: noTty.run, env: { CLAUDE_CODE_SESSION_ID: 'x' } }), /CLAUDE_CODE_SESSION_ID/);
  assert.deepEqual(noTty.calls, []);
  const denied = fakeRun({ sudoFail: true });
  assert.throws(() => handle('rollback', rollback, { ...base, run: denied.run }), /sudo/);
  assert.deepEqual(denied.calls.map((c) => c.args[0]), ['-k', '-v']);
  assert.deepEqual(state(), before);
  assert.equal(read(p.current), `${V2}\n`);

  // authenticated: smoke test of the previous version, then the switch
  const s = okSmoke();
  const f = fakeRun();
  const r = await handle('rollback', rollback, { ...base, run: f.run, smoke: s.smoke });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.from, V2);
  assert.equal(r.to, V1);
  assert.deepEqual(f.calls.slice(0, 2).map((c) => [c.cmd, c.args[0]]), [[SUDO, '-k'], [SUDO, '-v']]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].engineDir, path.join(p.versionsDir, V1));
  assert.equal(read(p.current), `${V1}\n`);
  assert.match(read(p.watchdogBundle), /built-from-previous\n$/);
  assert.equal(read(p.watchdogBundle).split('\n')[0], `#!${NODE}`);
  assert.ok(f.calls.some((c) => c.name === 'fence-hook' && c.args[0] === 'pre'));
  const rec = JSON.parse(read(p.smokeResult));
  assert.equal(rec.version, V1);
  assert.equal(rec.ok, true);
  // both copies are kept, so rolling back again goes forward
  assert.deepEqual(listing(p.versionsDir), [V1, V2]);
  noLeftovers(p);
  const shimRun = spawnSync(p.shim, ['version'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(shimRun.stdout.trim(), `fence ${V1}`, shimRun.stderr);
});

test('rollback with a failing smoke test, or with no single previous version, changes nothing', async () => {
  const { p, base } = await installed();
  const none = await rollback({ ...base, run: fakeRun().run });
  assert.equal(none.ok, false);
  assert.match(none.reason, /previous/);
  assert.equal((await upgrade({ ...base, run: fakeRun().run, version: V2 })).ok, true);
  const before = [p.current, p.watchdogBundle, p.watchdog, p.smokeResult].map(read);
  const r = await rollback({ ...base, run: fakeRun().run, smoke: failSmoke });
  assert.equal(r.ok, false);
  assert.match(r.reason, /smoke/);
  assert.deepEqual([p.current, p.watchdogBundle, p.watchdog, p.smokeResult].map(read), before);
  // two other versions installed side by side: which one is "previous" is not guessed
  fs.cpSync(path.join(p.versionsDir, V1), path.join(p.versionsDir, V3), { recursive: true });
  const ambiguous = await rollback({ ...base, run: fakeRun().run, smoke: okSmoke().smoke });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason, /more than one/);
  assert.equal(read(p.current), `${V2}\n`);
});

// Seeds the state a running fence leaves: a policy, a log, a keep file.
function seedState(p) {
  fs.mkdirSync(p.logDir, { recursive: true });
  fs.writeFileSync(path.join(p.logDir, '2026-10-17.jsonl'), '{"decision":"deny"}\n');
  fs.mkdirSync(p.keepDir, { recursive: true });
  fs.writeFileSync(path.join(p.keepDir, 'k'), 'k');
  fs.writeFileSync(p.health, '{}');
}

const installedFiles = (p) => [p.watchdog, p.watchdogBundle, p.shim, p.shimModule, p.current, p.versionsDir, p.gitPin, p.smokeResult];

test('uninstall keeps policy and logs', async () => {
  const { p, base } = await installed();
  seedState(p);
  const policy = read(p.policy);
  for (const f of installedFiles(p)) assert.equal(exists(f), true, f);
  const lines = [];
  const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r.ok, true, r.warnings?.join('; '));
  for (const f of installedFiles(p)) assert.equal(exists(f), false, f);
  assert.equal(exists(p.shareDir), false);
  assert.equal(read(p.policy), policy);
  assert.equal(read(path.join(p.logDir, '2026-10-17.jsonl')), '{"decision":"deny"}\n');
  assert.equal(exists(path.join(p.keepDir, 'k')), true);
  assert.deepEqual(listing(p.binDir), []);
  assert.ok(lines.some((l) => /Kept/.test(l) && l.includes(p.policy)), lines.join('\n'));
});

test('uninstall --purge removes them', async () => {
  const { p, base } = await installed();
  seedState(p);
  const admin = newDir('admin');
  fs.writeFileSync(path.join(admin, 'integrity.json'), '{}');
  const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, purge: true, adminDir: admin, lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r.ok, true, r.warnings?.join('; '));
  for (const f of [...installedFiles(p), p.policy, p.configDir, p.stateDir, p.logDir]) assert.equal(exists(f), false, f);
  // the root-owned admin directory is not ours to remove: the step is printed instead
  assert.equal(exists(path.join(admin, 'integrity.json')), true);
  assert.ok(r.manual.some((m) => m.includes(admin)), r.manual.join('\n'));
  // the home itself and unrelated files are untouched
  assert.equal(exists(p.home), true);
});

test('uninstall removes the Claude plugin and the Codex bridge through the CLIs when present (injected run)', async () => {
  const { p, base, env } = await installed({ cli: ['claude', 'codex'] });
  const claude = path.join(env.PATH, 'claude');
  const codex = path.join(env.PATH, 'codex');
  const f = fakeRun();
  // the launcher still exists when the plugins are removed: hooks do not outlive it
  const seen = [];
  const run = (cmd, args, opts) => {
    if (path.basename(cmd) === 'claude' || path.basename(cmd) === 'codex') seen.push({ cmd, args: [...args], launcher: exists(p.watchdog) });
    return f.run(cmd, args, opts);
  };
  const r = await handle('uninstall', uninstall, { ...base, run, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r.ok, true, r.warnings?.join('; '));
  assert.deepEqual(seen, [
    { cmd: claude, args: ['plugin', 'uninstall', 'fence@triqual'], launcher: true },
    { cmd: codex, args: ['plugin', 'remove', 'fence-codex@triqual'], launcher: true },
  ]);
  assert.equal(exists(p.watchdog), false);
  assert.equal(r.manual.some((m) => /claude plugin uninstall/.test(m)), false);
  assert.equal(r.manual.some((m) => /codex plugin remove/.test(m)), false);

  // absent CLIs are skipped and the step is printed for the human
  const bare = await installed();
  const f2 = fakeRun();
  const lines = [];
  const r2 = await handle('uninstall', uninstall, { ...bare.base, run: f2.run, io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r2.ok, true, r2.warnings?.join('; '));
  assert.equal(f2.calls.some((c) => c.name === 'claude' || c.name === 'codex'), false);
  assert.ok(r2.manual.some((m) => m.includes('claude plugin uninstall fence@triqual')), r2.manual.join('\n'));
  assert.ok(r2.manual.some((m) => m.includes('codex plugin remove fence-codex@triqual')), r2.manual.join('\n'));
  for (const m of r2.manual) assert.ok(lines.includes(m), m);

});

test('a present host CLI that fails (exit or throw) stops uninstall before anything is removed', async () => {
  const seedCopy = (p) => fs.writeFileSync(path.join(p.versionsDir, V1, 'MARK'), 'x');
  for (const [label, makeRun, expected] of [
    ['claude exits 1', (f) => f.run, { claude: 1 }],
    ['codex exits 1', (f) => f.run, { codex: 1 }],
    [
      'claude throws',
      (f) => (cmd, args, opts) => {
        if (path.basename(cmd) === 'claude') throw new Error('spawn blew up (fake)');
        return f.run(cmd, args, opts);
      },
      {},
    ],
  ]) {
    const { p, base } = await installed({ cli: ['claude', 'codex'] });
    seedCopy(p);
    const before = [p.watchdog, p.watchdogBundle, p.shim, p.shimModule, p.current, p.smokeResult, p.policy].map(read);
    const f = fakeRun({ cliStatus: expected });
    const lines = [];
    const r = await handle('uninstall', uninstall, { ...base, run: makeRun(f), io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
    assert.equal(r.ok, false, label);
    assert.equal(r.stopped, true, label);
    assert.match(r.reason, /hooks are still registered/, label);
    assert.deepEqual(r.removed, [], label);
    const name = Object.keys(expected)[0] ?? 'claude';
    assert.ok(r.manual.some((m) => m.includes(`${name} plugin`) && /failed/.test(m)), `${label}: ${r.manual.join('\n')}`);
    if (label === 'claude throws') assert.ok(r.manual.some((m) => /spawn blew up/.test(m)), r.manual.join('\n'));
    assert.ok(lines.some((l) => /hooks are still registered/.test(l)), label);
    // the launcher, bundle, shim, versions, current and the recorded state are all still there
    assert.deepEqual([p.watchdog, p.watchdogBundle, p.shim, p.shimModule, p.current, p.smokeResult, p.policy].map(read), before, label);
    assert.equal(read(path.join(p.versionsDir, V1, 'MARK')), 'x', label);
    assert.equal(lines.some((l) => /Restart Claude Code/.test(l)), false, label);
    // once the step works, running uninstall again finishes the job
    const again = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
    assert.equal(again.ok, true, label);
    assert.equal(exists(p.watchdog), false, label);
  }
});

test('a successful uninstall tells the human to restart Claude Code and Codex', async () => {
  const { base } = await installed();
  const lines = [];
  const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r.ok, true);
  assert.match(r.notice, /Restart Claude Code and Codex/);
  assert.ok(lines.some((l) => /Restart Claude Code and Codex/.test(l)), lines.join('\n'));
});

test('uninstall removes install leftovers and reports a directory it could not remove', async () => {
  const { p, base } = await installed();
  const leftovers = [
    path.join(p.versionsDir, '.staging-0.2.0-abc123'),
    path.join(p.versionsDir, '.old-0.1.0-def456'),
    `${p.watchdog}.bak-123-abcd`,
    `${p.shim}.tmp-123-abcd`,
    `${p.watchdogBundle}.bak-123-abcd`,
    `${p.shimModule}.tmp-123-abcd`,
    `${p.current}.tmp-123-abcd`,
    `${p.smokeResult}.tmp-123-abcd`,
    `${p.policy}.tmp-123-abcd`,
  ];
  for (const l of leftovers) {
    if (l.includes('.staging-') || l.includes('.old-')) fs.mkdirSync(l, { recursive: true });
    else fs.writeFileSync(l, 'x');
  }
  // something that is not fence's, in fence's share directory, and next to the launchers
  fs.writeFileSync(path.join(p.shareDir, 'user-notes.txt'), 'mine');
  fs.writeFileSync(path.join(p.binDir, 'other-tool'), 'mine', { mode: 0o755 });
  const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
  assert.equal(r.ok, true, r.warnings.join('; '));
  for (const l of leftovers.filter((x) => !x.startsWith(p.policy) && !x.startsWith(p.smokeResult))) assert.equal(exists(l), false, l);
  // the policy and state directories are kept, but fence's own temp files in them are not
  assert.equal(exists(`${p.policy}.tmp-123-abcd`), false);
  assert.equal(exists(`${p.smokeResult}.tmp-123-abcd`), false);
  assert.equal(exists(p.policy), true);
  assert.equal(read(path.join(p.shareDir, 'user-notes.txt')), 'mine');
  assert.equal(read(path.join(p.binDir, 'other-tool')), 'mine');
  // the share directory still holds the user's file: reported, not forced
  assert.ok(r.warnings.some((w) => w.includes(p.shareDir) && /not empty/.test(w) && w.includes('user-notes.txt')), r.warnings.join('\n'));
  assert.equal(exists(p.shareDir), true);
});

test('uninstall prints the locked-mode copy as a root-owned step when it exists', async () => {
  const { base } = await installed();
  const locked = newDir('locked');
  fs.writeFileSync(path.join(locked, 'fence-hook.mjs'), 'x');
  const lines = [];
  const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: locked });
  assert.equal(r.ok, true, r.warnings.join('; '));
  assert.equal(exists(path.join(locked, 'fence-hook.mjs')), true);
  const step = r.manual.find((m) => m.includes(locked));
  assert.ok(step && /root-owned/.test(step) && /sudo rm -rf/.test(step), r.manual.join('\n'));
  assert.ok(lines.includes(step));
});

test('upgrade only moves forward by semver precedence; going back is rollback', async () => {
  const { p, base } = await installed();
  assert.equal((await upgrade({ ...base, run: fakeRun().run, version: '0.10.0' })).ok, true);
  assert.equal(read(p.current), '0.10.0\n');
  const refusals = [
    ['0.10.0', /already current|nothing to upgrade/],
    ['0.10.0+build.7', /already current|nothing to upgrade/],
    ['0.9.0', /older[\s\S]*fence rollback/],
    ['0.2.0', /older[\s\S]*fence rollback/],
    ['0.10.0-rc.1', /older[\s\S]*fence rollback/],
  ];
  for (const [version, re] of refusals) {
    const f = fakeRun();
    const before = [p.current, p.watchdog, p.watchdogBundle, p.smokeResult].map(read);
    const r = await upgrade({ ...base, run: f.run, version });
    assert.equal(r.ok, false, version);
    assert.match(r.reason, re, version);
    assert.deepEqual(f.calls, [], version);
    assert.deepEqual([p.current, p.watchdog, p.watchdogBundle, p.smokeResult].map(read), before, version);
  }
  assert.deepEqual(listing(p.versionsDir), [V1, '0.10.0']);
  // a newer prerelease of a higher core and a release after a prerelease are forward moves
  const pre = await upgrade({ ...base, run: fakeRun().run, version: '0.11.0-rc.2' });
  assert.equal(pre.ok, true, pre.reason);
  const rel = await upgrade({ ...base, run: fakeRun().run, version: '0.11.0-rc.10' });
  assert.equal(rel.ok, true, rel.reason);
  const rel2 = await upgrade({ ...base, run: fakeRun().run, version: '0.11.0' });
  assert.equal(rel2.ok, true, rel2.reason);
  assert.equal(read(p.current), '0.11.0\n');
});

test('install keeps exactly one previous version, so rollback works after a third bare install', async () => {
  const { home, p, base } = await installed();
  for (const version of [V2, V3]) {
    const r = await install({ ...base, run: fakeRun().run, version });
    assert.equal(r.ok, true, r.reason);
  }
  assert.deepEqual(listing(p.versionsDir), [V2, V3]);
  assert.equal(read(p.current), `${V3}\n`);
  const third = await install({ ...base, run: fakeRun().run, version: '0.4.0' });
  assert.equal(third.previous, V3);
  assert.deepEqual(third.pruned, [V2]);
  assert.deepEqual(listing(p.versionsDir), [V3, '0.4.0']);
  // a reinstall of the current version prunes nothing and keeps its previous version
  const again = await install({ ...base, run: fakeRun().run, version: '0.4.0' });
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.previous, null);
  assert.deepEqual(listing(p.versionsDir), [V3, '0.4.0']);
  // rollback has exactly one candidate
  const rb = await handle('rollback', rollback, { ...base, run: fakeRun().run });
  assert.equal(rb.ok, true, rb.reason);
  assert.equal(rb.to, V3);
  assert.equal(read(p.current), `${V3}\n`);
  assert.ok(exists(home));
});

test('uninstall prints the Codex trust step it cannot perform', async () => {
  for (const cli of [[], ['claude', 'codex']]) {
    const { p, base, home } = await installed({ cli });
    const lines = [];
    const r = await handle('uninstall', uninstall, { ...base, run: fakeRun().run, io: { out: (s) => lines.push(s) }, adminDir: newDir('admin'), lockedDir: path.join(newDir('locked'), 'none') });
    assert.equal(r.ok, true, r.warnings?.join('; '));
    const trust = r.manual.filter((m) => /trust/i.test(m));
    assert.equal(trust.length, 1, r.manual.join('\n'));
    assert.ok(trust[0].includes(path.join(home, '.codex', 'config.toml')), trust[0]);
    assert.ok(lines.includes(trust[0]));
    assert.equal(exists(p.watchdog), false);
  }
});

test('uninstall and rollback are refused without a terminal and never reach the filesystem', async () => {
  const { p, base } = await installed();
  const f = fakeRun();
  assert.throws(() => handle('uninstall', uninstall, { ...base, run: f.run, stdin: { isTTY: false } }), /terminal/);
  assert.throws(() => handle('uninstall', uninstall, { ...base, run: f.run, env: { CODEX_THREAD_ID: '1' } }), /CODEX_THREAD_ID/);
  assert.deepEqual(f.calls, []);
  for (const file of installedFiles(p)) assert.equal(exists(file), true, file);
});
