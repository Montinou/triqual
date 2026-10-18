import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProbes, marketplaceKind, parseCodexHookTrust } from '../src/cli/probes.mjs';
import { captureRun, makeWiringRun } from '../src/cli/run.mjs';
import { SUDO } from '../src/cli/humanonly.mjs';

// Hermetic: the probes get an injected runner shaped like the real CLIs' answers, and a temp home.
// The real claude and codex are never run; the only real program here is process.execPath.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-probes-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function bin(...names) {
  const d = newDir('bin');
  for (const n of names) fs.writeFileSync(path.join(d, n), '', { mode: 0o755 });
  return d;
}

// run: "<program> <args>" -> {status, stdout} | (error) ; records the calls
function runner(responses) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const key = `${path.basename(cmd)} ${args.join(' ')}`;
    if (!Object.hasOwn(responses, key)) return { status: 127, stdout: '', stderr: 'unexpected' };
    const r = responses[key];
    if (r instanceof Error) throw r;
    return { status: 0, stderr: '', ...r };
  };
  return { run, calls };
}

function probesFor(responses, { names = ['claude', 'codex'], home = newDir('home'), readText } = {}) {
  const r = runner(responses);
  const probes = createProbes({ run: r.run, env: { PATH: bin(...names) }, home, readText });
  return { probes, calls: r.calls, home };
}

test('claudeVersion is the first line of claude --version', () => {
  const { probes, calls } = probesFor({ 'claude --version': { stdout: '2.1.302 (Claude Code)\n' } });
  assert.equal(probes.claudeVersion(), '2.1.302 (Claude Code)');
  assert.ok(path.isAbsolute(calls[0].cmd), 'the program is named by an absolute path found on PATH');
  assert.equal(typeof calls[0].opts.timeout, 'number');
});

test('claudePluginEnabled reads the fence plugin from claude plugin list --json', () => {
  const list = (entries) => ({ 'claude plugin list --json': { stdout: JSON.stringify(entries) } });
  assert.equal(probesFor(list([{ id: 'fence@triqual', enabled: true, scope: 'user' }])).probes.claudePluginEnabled(), true);
  assert.equal(probesFor(list([{ id: 'fence@triqual', enabled: false }])).probes.claudePluginEnabled(), false);
  assert.equal(probesFor(list([{ id: 'other@x', enabled: true }])).probes.claudePluginEnabled(), false, 'not installed is not enabled');
  assert.equal(probesFor(list([{ id: 'fence@triqual', enabled: false }, { id: 'fence@triqual', enabled: true, scope: 'project' }])).probes.claudePluginEnabled(), true);
  // an answer that is not the list is "could not verify"
  assert.equal(probesFor({ 'claude plugin list --json': { stdout: 'not json' } }).probes.claudePluginEnabled(), null);
  assert.equal(probesFor({ 'claude plugin list --json': { stdout: '{"a":1}' } }).probes.claudePluginEnabled(), null);
});

test('claudeMarketplaceSource maps the source field of the marketplace the plugin is served from', () => {
  const market = (m) => probesFor({ 'claude plugin marketplace list --json': { stdout: JSON.stringify(m) } }).probes.claudeMarketplaceSource();
  assert.deepEqual(market([{ name: 'triqual', source: 'github', repo: 'example/triqual' }]), { kind: 'github' });
  assert.deepEqual(market([{ name: 'triqual', source: 'git', url: 'https://example.invalid/x.git' }]), { kind: 'git' });
  assert.deepEqual(market([{ name: 'triqual', source: 'url', url: 'https://example.invalid/m.json' }]), { kind: 'url' });
  assert.deepEqual(market([{ name: 'triqual', source: 'directory', path: '/work/triqual' }]), { kind: 'directory', path: '/work/triqual' });
  assert.deepEqual(market([{ name: 'triqual', source: 'file', path: '/work/m.json' }]), { kind: 'file', path: '/work/m.json' });
  // only the marketplace that serves fence counts
  assert.deepEqual(market([{ name: 'local-dev', source: 'directory', path: '/x' }, { name: 'triqual', source: 'github', repo: 'a/b' }]), { kind: 'github' });
  assert.equal(market([{ name: 'other', source: 'github', repo: 'a/b' }]), null, 'no such marketplace: could not verify');
  assert.equal(market([{ name: 'triqual' }]), null, 'no source field: could not verify');
  assert.equal(market([{ name: 'triqual', source: 'something-new' }]), null, 'an unknown kind is could-not-verify, never passed through');
  for (const odd of ['', 'GitHub', 'Directory', ' file', 'constructor', '__proto__', 'toString']) {
    assert.equal(market([{ name: 'triqual', source: odd }]), null, JSON.stringify(odd));
    assert.equal(marketplaceKind(odd), null, JSON.stringify(odd));
  }
  for (const kind of ['github', 'git', 'url', 'directory', 'file']) assert.equal(marketplaceKind(kind), kind);
  assert.equal(marketplaceKind(7), null);
  assert.equal(marketplaceKind(undefined), null);
});

test('codexBridgeInstalled reads the installed plugins of codex plugin list --json', () => {
  const list = (installed) => probesFor({ 'codex plugin list --json': { stdout: JSON.stringify({ installed, available: [] }) } }).probes.codexBridgeInstalled();
  assert.equal(list([{ pluginId: 'fence-codex@triqual', installed: true, enabled: true }]), true);
  assert.equal(list([{ pluginId: 'fence-codex@triqual', installed: true, enabled: false }]), false, 'a disabled bridge covers nothing');
  assert.equal(list([{ pluginId: 'fence-codex@triqual', installed: false }]), false);
  assert.equal(list([{ pluginId: 'documents@x', installed: true, enabled: true }]), false);
  assert.equal(probesFor({ 'codex plugin list --json': { stdout: '[]' } }).probes.codexBridgeInstalled(), null);
});

test('codexHooksFeature reads the hooks row of codex features list', () => {
  const feature = (stdout) => probesFor({ 'codex features list': { stdout } }).probes.codexHooksFeature();
  assert.equal(feature('apps  stable  true\nhooks                                    stable             true\n'), true);
  assert.equal(feature('hooks  stable  false\n'), false);
  assert.equal(feature('plugin_hooks   removed   true\n'), null, 'only the hooks row counts; none: could not verify');
  assert.equal(feature(''), null);
});

test('codexHooksTrusted reads the trust records Codex keeps in its config.toml', () => {
  const hash = `sha256:${'b'.repeat(64)}`;
  const key = (n) => `fence-codex@triqual:hooks/hooks.json:pre_tool_use:0:${n}`;
  const toml = (...lines) => lines.join('\n');
  const trusted = (config) => probesFor({}, { readText: () => config }).probes.codexHooksTrusted();
  assert.equal(trusted(toml(`[hooks.state."${key(0)}"]`, `trusted_hash = "${hash}"`)), true);
  assert.equal(trusted(toml(`[hooks.state."${key(0)}"]`, `trusted_hash = "${hash}"`, '', `[hooks.state."${key(1)}"]`, `trusted_hash = "${hash}"`)), true);
  // one fence hook without a trust record is not trusted
  assert.equal(trusted(toml(`[hooks.state."${key(0)}"]`, `trusted_hash = "${hash}"`, '', `[hooks.state."${key(1)}"]`, 'enabled = true')), false);
  // other plugins' records do not count, and none at all is not trusted
  assert.equal(trusted(toml('[hooks.state."vercel-plugin@x:hooks/hooks.json:session_start:0:0"]', `trusted_hash = "${hash}"`)), false);
  assert.equal(trusted('[features]\nhooks = true\n'), false);
  // a missing file has no records; any other read error is "could not verify"
  const missing = probesFor({}, { readText: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(missing.probes.codexHooksTrusted(), false);
  const denied = probesFor({}, { readText: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
  assert.equal(denied.probes.codexHooksTrusted(), null);
  assert.deepEqual(parseCodexHookTrust(toml(`[hooks.state."${key(0)}"]`, `trusted_hash = "${hash}"`)).get(key(0)), true);
});

test('the config.toml read is under the given home, never the process home', () => {
  const home = newDir('home');
  fs.mkdirSync(path.join(home, '.codex'));
  const read = [];
  const { probes } = probesFor({}, { home, readText: (f) => { read.push(f); return ''; } });
  probes.codexHooksTrusted();
  assert.deepEqual(read, [path.join(home, '.codex', 'config.toml')]);
});

test('a missing CLI, a failing run and a throwing runner are could-not-verify, never a failure', () => {
  const absent = probesFor({}, { names: [] });
  for (const name of ['claudeVersion', 'claudePluginEnabled', 'claudeMarketplaceSource', 'codexBridgeInstalled', 'codexHooksFeature']) {
    assert.equal(absent.probes[name](), null, name);
  }
  assert.deepEqual(absent.calls, [], 'nothing ran: neither CLI was found on PATH');

  const failing = probesFor({
    'claude --version': { status: 1, stdout: '' },
    'claude plugin list --json': new Error('spawn failed'),
    'codex features list': { status: null, error: new Error('ETIMEDOUT'), stdout: '' },
  });
  assert.equal(failing.probes.claudeVersion(), null);
  assert.equal(failing.probes.claudePluginEnabled(), null);
  assert.equal(failing.probes.codexHooksFeature(), null);
  // the PATH is not searched when it holds no absolute directory
  const rel = createProbes({ run: () => { throw new Error('ran'); }, env: { PATH: 'relative/bin' }, home: newDir('home') });
  assert.equal(rel.claudeVersion(), null);
});

// ---- the runner -------------------------------------------------------------------------------------

test('captureRun captures stdout, stderr and the exit status, and feeds input', () => {
  const r = captureRun(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); console.error("err")'], { input: 'hello', timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.stderr.trim(), 'err');
  const bad = captureRun(process.execPath, ['-e', 'process.exit(3)'], { timeout: 20_000 });
  assert.equal(bad.status, 3);
  const slow = captureRun(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 100 });
  assert.ok(slow.error, 'a timeout is an error');
  // the environment given is the whole environment
  const env = captureRun(process.execPath, ['-e', 'process.stdout.write(String(process.env.FENCE_PROBE_X))'], { env: { PATH: process.env.PATH, FENCE_PROBE_X: 'seen' } });
  assert.equal(env.stdout, 'seen');
});

test('the wiring runner sends sudo to the terminal-inheriting runner and everything else to the capturing one', () => {
  const log = [];
  const run = makeWiringRun({
    sudoRun: (cmd, args) => (log.push(['sudo-run', cmd, ...args]), { status: 0 }),
    capture: (cmd, args) => (log.push(['capture', cmd, ...args]), { status: 0, stdout: 'x' }),
  });
  run(SUDO, ['-k']);
  run('/usr/bin/git', ['--version']);
  run('/fake/sudo', ['-k']);
  assert.deepEqual(log, [
    ['sudo-run', SUDO, '-k'],
    ['capture', '/usr/bin/git', '--version'],
    ['capture', '/fake/sudo', '-k'],
  ]);
});
