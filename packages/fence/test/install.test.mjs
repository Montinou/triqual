import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { install, shimText } from '../src/cli/install.mjs';
import { fencePaths, enginePath } from '../src/cli/paths.mjs';
import { SUDO } from '../src/cli/humanonly.mjs';
import { readGitPin } from '../src/resolve/gitpin.mjs';

// Hermetic: every install gets a temp HOME under os.tmpdir(). npm, git and sudo are never run: the
// injected `run` fakes them (a fake `npm install` copies this package's src, bin, policies and
// package.json into the temp prefix it was given). Node is the only real program: the bundle
// start-up probe and the smoke test run the copied watchdog with process.execPath against temp
// directories. The real HOME, ~/.local, ~/.config and the admin directory are never touched.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-install-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NPM = '/fake/bin/npm';
const VERSION = '0.1.0';
const TTY = { isTTY: true };
// The watchdog deadline of the bundles these tests install, so the smoke test and the
// installed-launcher check do not flake on a loaded machine (production keeps 3000 ms).
const DEADLINE = 20_000;
const SPAWN_TIMEOUT_MS = 60_000;

const AUDIT_OK = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n';
const AUDIT_NO_ATTESTATION = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n';
const STRICT_TEXT = JSON.stringify({ version: 1, rules: [{ id: 'strict-privilege', decision: 'deny', match: { class: ['privilege'] }, why: 'Raising privileges is denied.' }] }, null, 2) + '\n';

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A directory holding an executable `git` file (never executed: the runner fakes it).
function gitDir() {
  const d = newDir('bin');
  fs.writeFileSync(path.join(d, 'git'), '', { mode: 0o755 });
  return d;
}

function copyPackage(dest, { strict }) {
  fs.mkdirSync(dest, { recursive: true });
  for (const part of ['src', 'bin', 'policies']) {
    const from = path.join(PKG_DIR, part);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, part), { recursive: true });
  }
  fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(dest, 'package.json'));
  // the real package ships policies/strict.json; a copy has it only when the test asks for one
  fs.rmSync(path.join(dest, 'policies', 'strict.json'), { force: true });
  if (strict) {
    fs.mkdirSync(path.join(dest, 'policies'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'policies', 'strict.json'), STRICT_TEXT);
  }
}

// `launcher`: 'real' runs the installed fence-hook trampoline (sh -> node -> the bundle, against
// the temp probe HOME install() builds); 'fail' answers its check with a failure.
function fakeRun({ audit = { status: 0, stdout: AUDIT_OK }, sudoFail = false, gitOut = 'git version 2.47.1 (fake)\n', gitStatus = 0, strict = false, nodeVersion, launcher = 'real' } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd, env: opts.env });
    if (path.basename(cmd) === 'fence-hook') {
      if (launcher === 'fail') return { status: 1, stdout: '', stderr: 'launcher failed (fake)' };
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    }
    if (cmd === SUDO) return { status: sudoFail && args[0] === '-v' ? 1 : 0, stdout: '', stderr: '' };
    if (cmd === NPM && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      copyPackage(path.join(prefix, 'node_modules', '@triqual', 'fence'), { strict });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === NPM && args[0] === 'audit') return { stderr: '', ...audit };
    if (path.basename(cmd) === 'git') return { status: gitStatus, stdout: gitOut, stderr: '' };
    if (cmd === NODE) {
      if (args[0] === '--version' && nodeVersion) return { status: 0, stdout: `${nodeVersion}\n`, stderr: '' };
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    }
    return { status: 127, stdout: '', stderr: `unexpected program ${cmd}` };
  };
  return { run, calls };
}

function okSmoke() {
  const calls = [];
  // records what the smoke test was given, and whether the engine it was pointed at existed then
  const smoke = (o) => {
    calls.push({ ...o, engineExisted: fs.existsSync(path.join(o.engineDir, 'src', 'engine.mjs')) });
    return { ok: true, failures: [], latencyMs: [1] };
  };
  return { calls, smoke };
}

function setup(runOpts = {}) {
  const home = newDir('home');
  const env = { PATH: gitDir() };
  const f = fakeRun(runOpts);
  const s = okSmoke();
  const opts = (extra = {}) => ({ version: VERSION, home, run: f.run, env, nodePath: NODE, npmPath: NPM, smoke: s.smoke, deadlineMs: DEADLINE, ...extra });
  return { home, env, f, s, opts, p: fencePaths(home) };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);

test('install refuses a range like ^0.1.0', async () => {
  for (const version of ['^0.1.0', '~0.1.0', '0.1', 'latest', '>=0.1.0', '0.1.x', '']) {
    const { f, s, opts, home } = setup();
    const r = await install(opts({ version }));
    assert.equal(r.ok, false, version);
    assert.match(r.reason, /exact/, version);
    assert.deepEqual(f.calls, [], version);
    assert.deepEqual(s.calls, [], version);
    assert.deepEqual(fs.readdirSync(home), [], version);
  }
});

test('a failing provenance check aborts before the smoke test', async () => {
  const { f, s, opts, p } = setup({ audit: { status: 0, stdout: AUDIT_NO_ATTESTATION } });
  const r = await install(opts());
  assert.equal(r.ok, false);
  assert.match(r.reason, /attestation/);
  assert.ok(f.calls.some((c) => c.args[0] === 'audit'));
  assert.deepEqual(s.calls, []);
  assert.equal(exists(path.join(p.versionsDir, VERSION)), false);
  assert.equal(exists(p.current), false);
  assert.equal(exists(p.watchdog), false);
  assert.equal(exists(p.shim), false);
  assert.equal(exists(p.policy), false);
});

test('a failing smoke test leaves no current and no launcher', async () => {
  const { opts, p } = setup();
  const smokeCalls = [];
  const smoke = (o) => (smokeCalls.push(o), { ok: false, failures: ['claude deny: expected permissionDecision deny'], latencyMs: [] });
  const r = await install(opts({ smoke }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /smoke/);
  assert.equal(smokeCalls.length, 1);
  assert.equal(exists(p.current), false);
  assert.equal(exists(p.watchdog), false);
  assert.equal(exists(p.shim), false);
  assert.equal(exists(path.join(p.versionsDir, VERSION)), false);
  assert.equal(exists(p.policy), false);
  assert.equal(exists(p.gitPin), false);
  // no staging leftovers
  assert.deepEqual(exists(p.versionsDir) ? fs.readdirSync(p.versionsDir) : [], []);
  assert.deepEqual(exists(p.binDir) ? fs.readdirSync(p.binDir) : [], []);
});

test('a successful install writes versions/<v>, current, fence-hook, fence', async () => {
  const home = newDir('home');
  const f = fakeRun();
  // the real smoke test: the bundled watchdog of the copied package against its own engine
  const r = await install({ version: VERSION, home, run: f.run, env: { PATH: gitDir() }, nodePath: NODE, npmPath: NPM, deadlineMs: DEADLINE });
  assert.equal(r.ok, true, r.reason);
  const p = fencePaths(home);
  // the injected deadline reached the bundle that the smoke test and the launcher check ran
  assert.match(read(p.watchdogBundle), new RegExp(`^export const DEADLINE_MS = ${DEADLINE};$`, 'm'));
  assert.equal(JSON.parse(read(path.join(p.versionsDir, VERSION, 'package.json'))).version, VERSION);
  assert.equal(read(p.current), `${VERSION}\n`);
  // ~/.local/bin/fence-hook and ~/.local/bin/fence are two-line sh trampolines that exec the pinned
  // Node on .mjs modules in the share directory; the bundle keeps the Node path pin on line 1
  assert.equal(read(p.watchdog), `#!/bin/sh\nexec '${NODE}' '${p.watchdogBundle}' "$@"\n`);
  assert.equal(read(p.shim), `#!/bin/sh\nexec '${NODE}' '${p.shimModule}' "$@"\n`);
  for (const file of [p.watchdog, p.shim]) assert.equal(fs.statSync(file).mode & 0o777, 0o755, file);
  assert.equal(p.watchdogBundle, path.join(p.shareDir, 'fence-hook.mjs'));
  assert.equal(read(p.watchdogBundle).split('\n')[0], `#!${NODE}`);
  // the smoke result is recorded for doctor
  const smoke = JSON.parse(read(p.smokeResult));
  assert.equal(smoke.version, VERSION);
  assert.equal(smoke.ok, true);
  assert.ok(Array.isArray(smoke.latencyMs) && smoke.latencyMs.length > 0);
  assert.ok(!Number.isNaN(Date.parse(smoke.at)));
  // the order: exact version, provenance, then node probes of the bundle; nothing writes before
  const programs = f.calls.map((c) => (c.cmd === NPM ? `npm ${c.args[0]}` : path.basename(c.cmd)));
  assert.ok(programs.indexOf('npm install') < programs.indexOf('npm audit'));
  // the shim follows `current` and runs the installed CLI
  const shimRun = spawnSync(p.shim, ['version'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(shimRun.status, 0, shimRun.stderr);
  assert.equal(shimRun.stdout.trim(), `fence ${VERSION}`);
  // the shipped example policy was shown (returned) and written
  assert.equal(r.policy.written, true);
  assert.equal(read(p.policy), r.policy.text);
  assert.equal(read(p.policy), read(path.join(PKG_DIR, 'policies', 'example.json')));
  // per-host steps
  assert.ok(r.steps.some((s) => /Claude Code/.test(s)));
  assert.ok(r.steps.some((s) => /Codex/.test(s)));
  // no temp files left beside the written ones
  for (const d of [p.binDir, p.shareDir, p.versionsDir, p.configDir]) {
    for (const name of fs.readdirSync(d)) assert.ok(!/tmp|staging|\.old-|\.bak-/.test(name), `${d}: ${name}`);
  }
});

// A deny payload for the installed launcher: a Write to a built-in protected path under `home`.
function denyPayload(home) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'fence-test',
    cwd: home,
    permission_mode: 'default',
    tool_name: 'Write',
    tool_input: { file_path: path.join(home, '.claude', 'settings.json'), content: 'x' },
  });
}

test('an ancestor package.json with type commonjs does not break the installed launcher', async () => {
  const { opts, p, home, f } = setup();
  // planted above the bin directory (and the share directory)
  fs.writeFileSync(path.join(home, 'package.json'), '{"type":"commonjs"}\n');
  fs.mkdirSync(path.join(home, '.local'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'package.json'), '{"type":"commonjs"}\n');
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  // the install itself ran the installed trampoline before switching `current`
  const checks = f.calls.filter((c) => c.cmd === p.watchdog);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].args[0], 'pre');
  // and it denies a fixed payload end to end (Claude shape: one JSON line, exit 0)
  const state = newDir('state');
  const admin = newDir('admin');
  const hook = spawnSync(p.watchdog, ['pre', '--host', 'claude', '--policy', p.policy, '--state-dir', state, '--admin-dir', admin], {
    input: denyPayload(home),
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    cwd: home,
    encoding: 'utf8',
  });
  assert.equal(hook.status, 0, hook.stderr);
  const out = JSON.parse(hook.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.doesNotMatch(out.permissionDecisionReason, /could not check it/);
  // the CLI shim works under the same package.json
  const shimRun = spawnSync(p.shim, ['version'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(shimRun.stdout.trim(), `fence ${VERSION}`, shimRun.stderr);
});

test('a failing check of the installed launcher restores the old files and leaves current alone', async () => {
  // a first install, then a second one whose launcher check fails
  const first = setup();
  assert.equal((await install(first.opts())).ok, true);
  const { p } = first;
  const marker = path.join(p.versionsDir, VERSION, 'MARKER');
  fs.writeFileSync(marker, 'old copy');
  const before = Object.fromEntries([p.current, p.watchdog, p.watchdogBundle, p.shim, p.shimModule].map((f) => [f, read(f)]));
  fs.writeFileSync(p.watchdogBundle, before[p.watchdogBundle] + '// old\n');
  before[p.watchdogBundle] += '// old\n';
  const currentIno = fs.statSync(p.current).ino;
  const f = fakeRun({ launcher: 'fail' });
  const r = await install({ ...first.opts(), run: f.run });
  assert.equal(r.ok, false);
  assert.match(r.reason, /launcher/);
  for (const [file, text] of Object.entries(before)) assert.equal(read(file), text, file);
  assert.equal(fs.statSync(p.current).ino, currentIno);
  assert.equal(read(marker), 'old copy');
  for (const d of [p.binDir, p.shareDir, p.versionsDir]) {
    for (const name of fs.readdirSync(d)) assert.ok(!/tmp|staging|\.old-|\.bak-/.test(name), `${d}: ${name}`);
  }
  // with no earlier install, nothing is left behind
  const fresh = setup({ launcher: 'fail' });
  const r2 = await install(fresh.opts());
  assert.equal(r2.ok, false);
  for (const file of [fresh.p.current, fresh.p.watchdog, fresh.p.watchdogBundle, fresh.p.shim, fresh.p.shimModule, path.join(fresh.p.versionsDir, VERSION)]) {
    assert.equal(exists(file), false, file);
  }
});

test('a failed smoke test after an earlier install keeps the old versions/<v> and current', async () => {
  const first = setup();
  assert.equal((await install(first.opts())).ok, true);
  const { p } = first;
  const marker = path.join(p.versionsDir, VERSION, 'MARKER');
  fs.writeFileSync(marker, 'old copy');
  const currentIno = fs.statSync(p.current).ino;
  const launcher = read(p.watchdog);
  const smoke = () => ({ ok: false, failures: ['codex allow: expected exit 0 and no output'], latencyMs: [] });
  const r = await install(first.opts({ smoke }));
  assert.equal(r.ok, false);
  assert.equal(read(marker), 'old copy');
  assert.equal(read(p.current), `${VERSION}\n`);
  assert.equal(fs.statSync(p.current).ino, currentIno);
  assert.equal(read(p.watchdog), launcher);
  assert.deepEqual(fs.readdirSync(p.versionsDir), [VERSION]);
  // the recorded smoke result is still the one of the installed version
  assert.equal(JSON.parse(read(p.smokeResult)).ok, true);
});

test('failures after current is switched are warnings that ask for repair', async () => {
  const { opts, p, home } = setup();
  // ~/.config/fence is a file, so the policy can not be written
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.writeFileSync(p.configDir, 'not a directory');
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  assert.equal(read(p.current), `${VERSION}\n`);
  assert.equal(r.policy.written, false);
  assert.ok(r.warnings.some((w) => /policy/.test(w)), r.warnings.join('\n'));
  assert.match(r.repairNeeded, /fence repair/);
});

test('a git that can not be probed removes a stale git.json; an old git is a warning', async () => {
  {
    const { opts, p } = setup({ gitStatus: 1, gitOut: '' });
    fs.mkdirSync(p.shareDir, { recursive: true });
    fs.writeFileSync(p.gitPin, JSON.stringify({ path: '/stale/git', version: '2.50.0' }));
    const r = await install(opts());
    assert.equal(r.ok, true, r.reason);
    assert.equal(exists(p.gitPin), false);
    assert.equal(r.gitPin, null);
    assert.ok(r.warnings.some((w) => /git/.test(w)));
  }
  {
    const { opts, p } = setup({ gitOut: 'git version 2.39.5 (Apple Git-154)\n' });
    const r = await install(opts());
    assert.equal(r.ok, true, r.reason);
    assert.equal(JSON.parse(read(p.gitPin)).version, '2.39.5');
    assert.equal(r.gitPin.version, '2.39.5');
    assert.ok(r.warnings.some((w) => /2\.39\.5/.test(w) && /2\.45\.1/.test(w)), r.warnings.join('\n'));
  }
  {
    const { opts } = setup({ gitOut: 'git version 2.45.1\n' });
    const r = await install(opts());
    assert.ok(!r.warnings.some((w) => /2\.45\.1/.test(w)), r.warnings.join('\n'));
  }
});

test('current is switched by rename', async () => {
  const { opts, p } = setup();
  fs.mkdirSync(p.shareDir, { recursive: true });
  fs.writeFileSync(p.current, '0.0.9\n');
  const before = path.join(p.shareDir, 'current.before');
  fs.linkSync(p.current, before);
  const inode = fs.statSync(p.current).ino;
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  assert.equal(read(p.current), `${VERSION}\n`);
  // a rename replaces the directory entry: the old inode (still linked) keeps the old text
  assert.equal(read(before), '0.0.9\n');
  assert.notEqual(fs.statSync(p.current).ino, inode);
  assert.deepEqual(fs.readdirSync(p.shareDir).filter((n) => n.startsWith('current')).sort(), ['current', 'current.before']);
});

test('an existing policy is not overwritten', async () => {
  const { opts, p, s } = setup();
  fs.mkdirSync(p.configDir, { recursive: true });
  const mine = JSON.stringify({ version: 1, rules: [] }) + '\n// mine\n';
  fs.writeFileSync(p.policy, mine);
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  assert.equal(read(p.policy), mine);
  assert.equal(r.policy.written, false);
  // the smoke test ran against the policy in force
  assert.equal(s.calls[0].policy, p.policy);
});

test('--from-tarball requires the sudo gate', async () => {
  const tarball = path.join(newDir('tarball'), 'triqual-fence-0.1.0.tgz');
  fs.writeFileSync(tarball, 'not really a tarball');

  // a failing sudo -v: nothing is installed
  {
    const { f, s, opts, home } = setup({ sudoFail: true });
    const r = await install(opts({ fromTarball: tarball, stdin: TTY }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /sudo/);
    assert.deepEqual(f.calls.map((c) => [c.cmd, ...c.args]), [[SUDO, '-k'], [SUDO, '-v']]);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(fs.readdirSync(home), []);
  }
  // not an interactive terminal (or an agent session): refused before sudo
  for (const [stdin, extraEnv] of [[{ isTTY: false }, {}], [TTY, { CLAUDE_CODE_SESSION_ID: 'x' }]]) {
    const { f, opts, env } = setup();
    const r = await install(opts({ fromTarball: tarball, stdin, env: { ...env, ...extraEnv } }));
    assert.equal(r.ok, false);
    assert.deepEqual(f.calls, []);
  }
  // with the gate passed: sudo -k, sudo -v, then npm installs the tarball; provenance is skipped
  {
    const { f, opts, p } = setup();
    const r = await install(opts({ fromTarball: tarball, stdin: TTY }));
    assert.equal(r.ok, true, r.reason);
    // (the Node probes are left out: `node --version` runs between the gate and npm)
    const notNode = f.calls.filter((c) => c.cmd !== NODE);
    assert.deepEqual(notNode.slice(0, 3).map((c) => [c.cmd, c.args[0]]), [[SUDO, '-k'], [SUDO, '-v'], [NPM, 'install']]);
    assert.equal(f.calls[0].cmd, SUDO);
    assert.equal(notNode[2].args.at(-1), tarball);
    // the tarball install is isolated from npm configuration like the registry install
    assert.ok(notNode[2].args.includes('--ignore-scripts'));
    assert.ok(notNode[2].args.some((a) => a.startsWith('--userconfig=')) && notNode[2].args.some((a) => a.startsWith('--globalconfig=')));
    assert.ok(!Object.keys(notNode[2].env).some((k) => /^npm_config_/i.test(k) || k === 'NODE_OPTIONS'));
    assert.ok(!f.calls.some((c) => c.args[0] === 'audit'));
    assert.equal(read(p.current), `${VERSION}\n`);
  }
});

test('the pinned git version is recorded in git.json', async () => {
  const { opts, p, env, f } = setup({ gitOut: 'git version 2.47.1 (Apple Git-154)\n' });
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  const gitPath = fs.realpathSync(path.join(env.PATH, 'git'));
  assert.deepEqual(JSON.parse(read(p.gitPin)), { path: gitPath, version: '2.47.1' });
  assert.deepEqual(readGitPin(p.shareDir), { path: gitPath, version: '2.47.1' });
  assert.ok(f.calls.some((c) => c.cmd === gitPath && c.args[0] === '--version'));
});

test('the engine path inside versions/<v> is src/engine.mjs', async () => {
  const { opts, p, home, s } = setup();
  const r = await install(opts());
  assert.equal(r.ok, true, r.reason);
  const engine = path.join(p.versionsDir, VERSION, 'src', 'engine.mjs');
  assert.equal(enginePath(home, VERSION), engine);
  assert.equal(r.enginePath, engine);
  assert.ok(fs.statSync(engine).isFile());
  // the smoke test ran the copy staged inside versions/, which carried the engine at src/engine.mjs
  assert.equal(path.dirname(s.calls[0].engineDir), p.versionsDir);
  assert.equal(s.calls[0].engineExisted, true);
});

test('the install offers strict.json as a choice', async () => {
  // without a shipped strict.json only the example is offered
  {
    const { opts } = setup();
    const r = await install(opts());
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.choices.map((c) => c.name), ['example']);
  }
  // with it: strict beside the default example
  {
    const { opts, p } = setup({ strict: true });
    const r = await install(opts());
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.choices.map((c) => [c.name, c.default === true]), [['example', true], ['strict', false]]);
    assert.equal(r.choices[1].path, path.join(p.versionsDir, VERSION, 'policies', 'strict.json'));
  }
  // choosing it writes strict.json
  {
    const { opts, p } = setup({ strict: true });
    const r = await install(opts({ policyChoice: 'strict' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(read(p.policy), STRICT_TEXT);
    assert.equal(r.policy.text, STRICT_TEXT);
  }
  // choosing it when it is not shipped writes nothing
  {
    const { opts, p } = setup();
    const r = await install(opts({ policyChoice: 'strict' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /strict/);
    assert.equal(exists(p.current), false);
    assert.equal(exists(p.policy), false);
  }
});

test('a Node path with whitespace or a Node older than 22.13 is refused before anything is written', async () => {
  for (const nodePath of ['/opt/my node/bin/node', '/opt/my\tnode', "/opt/it's/node", '/opt/"q"/node', '/opt/a`b`/node', '/opt/a\\b/node', '/opt/a\x01b/node']) {
    const { f, opts, home } = setup();
    const r = await install(opts({ nodePath }));
    assert.equal(r.ok, false, nodePath);
    assert.match(r.reason, /whitespace, a quote or a control character/, nodePath);
    assert.deepEqual(f.calls, [], nodePath);
    assert.deepEqual(fs.readdirSync(home), [], nodePath);
  }
  {
    const { opts, home, s } = setup({ nodeVersion: 'v22.12.0' });
    const r = await install(opts());
    assert.equal(r.ok, false);
    assert.match(r.reason, /22\.13/);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(fs.readdirSync(home), []);
  }
  {
    const { opts } = setup({ nodeVersion: 'v22.13.0' });
    const r = await install(opts());
    assert.equal(r.ok, true, r.reason);
  }
});

test('fencePaths returns every path in the Installed state list', () => {
  const home = newDir('home');
  const p = fencePaths(home, { platform: 'linux' });
  const share = path.join(home, '.local', 'share', 'fence');
  const state = path.join(home, '.local', 'state', 'fence');
  assert.equal(p.shareDir, share);
  assert.equal(p.versionsDir, path.join(share, 'versions'));
  assert.equal(p.current, path.join(share, 'current'));
  assert.equal(p.gitPin, path.join(share, 'git.json'));
  assert.equal(p.watchdog, path.join(home, '.local', 'bin', 'fence-hook'));
  assert.equal(p.shim, path.join(home, '.local', 'bin', 'fence'));
  assert.equal(p.policy, path.join(home, '.config', 'fence', 'policy.json'));
  assert.equal(p.stateDir, state);
  assert.equal(p.logDir, path.join(state, 'log'));
  assert.equal(p.keepDir, path.join(state, 'keep'));
  assert.equal(p.writtenDir, path.join(state, 'written'));
  assert.equal(p.health, path.join(state, 'health.json'));
  assert.equal(p.verifiedDir, path.join(state, 'verified'));
  assert.equal(path.resolve(p.adminDir), '/var/lib/fence');
  assert.equal(p.hatch, path.join(p.adminDir, 'hatch.json'));
  assert.equal(p.integrity, path.join(p.adminDir, 'integrity.json'));
  assert.equal(p.grantsDir, path.join(p.adminDir, 'grants'));
  // the launcher trampoline and the bundle it runs, the shim and its module, the smoke record
  assert.equal(p.watchdogBundle, path.join(share, 'fence-hook.mjs'));
  assert.equal(p.shimModule, path.join(share, 'fence-cli.mjs'));
  assert.equal(p.smokeResult, path.join(state, 'smoke.json'));
  assert.throws(() => fencePaths('relative/home'), /absolute/);
});

// ---- the CLI shim when `current` is unusable ---------------------------------------------------------

// Writes shimText(share) next to a share directory holding stub CLIs (versions/<name>/src/cli/index.mjs
// whose module body writes a marker file when it is imported and whose main prints which version ran
// and the arguments), then runs it with process.execPath. `rootName` lets a test put the share
// directory under a path that needs shell quoting.
function shimWorld({ current, versions, rootName = 'shim' }) {
  const root = path.join(newDir('shimbase'), rootName);
  const share = path.join(root, 'share');
  const marker = path.join(newDir('shimmarker'), 'imported');
  fs.mkdirSync(path.join(share, 'versions'), { recursive: true });
  for (const v of versions) {
    const dir = path.join(share, 'versions', v, 'src', 'cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(v)} + '\\n');\nexport function main(args) { process.stdout.write(JSON.stringify({ ran: ${JSON.stringify(v)}, args })); return 0; }\n`,
    );
  }
  if (current !== undefined) fs.writeFileSync(path.join(share, 'current'), current);
  const module = path.join(root, 'fence-cli.mjs');
  fs.writeFileSync(module, shimText(share));
  const run = (...args) => spawnSync(NODE, [module, ...args], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  return { run, share, marker, imported: () => fs.existsSync(marker) };
}

// POSIX single-quote quoting, as the shim prints paths.
const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

test('with current missing or invalid, the shim imports no version: help is static, everything else exits 1 with both recovery commands', () => {
  const versions = ['0.9.0', '0.10.0', '0.10.0-rc.1', '0.2.0', 'latest', '9.9', 'zzz', '1.0.0.bak'];
  for (const current of [undefined, '', 'not-a-version\n', '../x\n', '0.5.0\n']) {
    const w = shimWorld({ current, versions });
    const label = JSON.stringify(current);
    // help (and -h / --help) prints static text, exit 0
    for (const command of ['help', '-h', '--help']) {
      const r = w.run(command);
      assert.equal(r.status, 0, `${label} ${command}: ${r.stderr}`);
      assert.match(r.stdout, /Usage: fence/, `${label} ${command}`);
      assert.match(r.stdout, /repair/, `${label} ${command}`);
    }
    // repair included, every other command exits 1 with the old message and the two commands
    for (const command of ['repair', 'doctor', 'rollback', 'uninstall', 'check', 'version', 'hatch', 'install']) {
      const r = w.run(command, '--x');
      assert.equal(r.status, 1, `${label} ${command}`);
      assert.equal(r.stdout, '', `${label} ${command}`);
      assert.match(r.stderr, /does not name an installed version; run fence repair in your own terminal/, command);
      assert.ok(r.stderr.includes('npx @triqual/fence@0.10.0 install'), `${label} ${command}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`${shq(NODE)} ${shq(path.join(w.share, 'versions', '0.10.0', 'src', 'cli', 'index.mjs'))} repair`), `${label} ${command}: ${r.stderr}`);
      assert.match(r.stderr, /not covered by the integrity check/, command);
    }
    assert.equal(w.run().status, 1, 'no command at all');
    assert.equal(w.imported(), false, `${label}: no version's code was imported`);
  }
});

test('the shim names the same newest version as semver precedence does', async () => {
  const { compareVersions } = await import('../src/cli/upgrade.mjs');
  const sets = [
    ['0.9.0', '0.10.0', '0.2.0'],
    ['1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-beta.11', '1.0.0-beta.2'],
    ['1.0.0-rc.1', '1.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-1'],
    ['2.0.0+build.5', '1.99.99'],
  ];
  for (const versions of sets) {
    const expected = [...versions].sort((a, b) => compareVersions(b, a))[0];
    const w = shimWorld({ current: undefined, versions });
    const r = w.run('repair');
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`npx @triqual/fence@${expected} install`), `${versions.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`${path.join(w.share, 'versions', expected)}/src/cli/index.mjs`), versions.join(' '));
    assert.equal(w.imported(), false);
  }
});

test('the shim with no version directory names latest and no local repair; paths are shell-quoted', () => {
  const none = shimWorld({ current: undefined, versions: ['latest'] });
  const r = none.run('repair');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('npx @triqual/fence@latest install'), r.stderr);
  assert.doesNotMatch(r.stderr, /index\.mjs/);
  assert.equal(none.imported(), false);
  // a share directory whose path holds a space and a single quote
  const w = shimWorld({ current: undefined, versions: ['0.1.0'], rootName: "it's a dir" });
  const q = w.run('repair');
  assert.ok(q.stderr.includes(`${shq(NODE)} ${shq(path.join(w.share, 'versions', '0.1.0', 'src', 'cli', 'index.mjs'))} repair`), q.stderr);
  assert.match(q.stderr, /'\\''/, 'the quote is escaped');
  assert.equal(w.imported(), false);
});

test('with a valid current the shim still follows current for every command', () => {
  const w = shimWorld({ current: '0.2.0\n', versions: ['0.2.0', '0.10.0'] });
  for (const command of ['repair', 'doctor', 'version']) {
    assert.equal(JSON.parse(w.run(command).stdout).ran, '0.2.0', command);
  }
});
