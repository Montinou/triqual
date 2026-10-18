import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { doctor, MIN_CLAUDE } from '../src/cli/doctor.mjs';
import { fencePaths } from '../src/cli/paths.mjs';
import { trampolineText } from '../src/cli/install.mjs';

// Hermetic: every case builds a temp HOME (plus a temp admin directory, state directory and repo)
// under os.tmpdir(). The host probes and the sudoers reader are injected fakes; nothing is spawned
// and the real HOME, ~/.claude, ~/.codex and /etc/sudoers are never read.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-doctor-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const VERSION = '0.1.0';
const POLICY = JSON.stringify({ version: 1, rules: [{ id: 'strict-privilege', decision: 'deny', match: { class: ['privilege'] }, why: 'Raising privileges is denied.' }] }) + '\n';
const SUDOERS_OK = { read: () => 'root ALL=(ALL) ALL\n%admin ALL=(ALL) ALL\n', list: () => [] };

let counter = 0;
function put(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

// A healthy install in a fresh temp HOME, with a repository to run in.
function world({ files = {} } = {}) {
  const root = path.join(TMP, `case-${counter++}`);
  const home = path.join(root, 'home');
  const admin = path.join(root, 'admin');
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(admin, { recursive: true });
  for (const d of ['objects', 'refs']) fs.mkdirSync(path.join(cwd, '.git', d), { recursive: true });
  put(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const p = fencePaths(home);
  put(p.policy, POLICY);
  put(p.current, `${VERSION}\n`);
  put(path.join(p.versionsDir, VERSION, 'src', 'engine.mjs'), '// engine\n');
  put(p.watchdogBundle, '// bundle\n');
  put(p.shimModule, '// cli\n');
  put(p.watchdog, trampolineText(process.execPath, p.watchdogBundle), 0o755);
  put(p.shim, trampolineText(process.execPath, p.shimModule), 0o755);
  put(p.smokeResult, JSON.stringify({ version: VERSION, ok: true, latencyMs: [12, 14], at: '2026-10-18T10:00:00.000Z' }) + '\n');
  put(p.gitPin, JSON.stringify({ path: process.execPath, version: '2.50.1' }) + '\n');
  fs.mkdirSync(p.logDir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) put(path.join(root, rel), text);
  const probes = {
    claudeVersion: () => '2.1.300 (Claude Code)',
    claudePluginEnabled: () => true,
    claudeMarketplaceSource: () => ({ kind: 'github', repo: 'example/triqual' }),
    codexBridgeInstalled: () => true,
    codexHooksFeature: () => true,
    codexHooksTrusted: () => true,
  };
  const args = { home, cwd, env: { HOME: home }, probes, now: () => NOW, adminDir: admin, sudoers: SUDOERS_OK, uid: process.getuid?.() ?? 0 };
  return { root, home, admin, cwd, p, probes, args };
}

const run = (w, over = {}) => doctor({ ...w.args, ...over });
const check = (result, id) => result.report.checks.find((c) => c.id === id);
const failing = (result) => result.report.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('exit code is 0 when all pass', async () => {
  const w = world();
  const r = await run(w);
  assert.deepEqual(failing(r), []);
  assert.equal(r.report.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(check(r, 'claude-version').status, 'ok');
  assert.equal(check(r, 'current').status, 'ok');
  assert.equal(check(r, 'policy').status, 'ok');
  assert.match(check(r, 'policy').message, /sha256 [0-9a-f]{64}/);
});

test('flags a bridge with no launcher', async () => {
  const w = world();
  fs.rmSync(w.p.watchdog);
  const r = await run(w);
  assert.equal(r.exitCode, 1);
  const c = check(r, 'codex-launcher');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /no launcher/);
  assert.equal(check(r, 'launcher').status, 'fail');
});

test('flags a launcher whose node path is gone, without assuming an exit code', async () => {
  const w = world();
  put(w.p.watchdog, trampolineText(path.join(w.root, 'no-such-node'), w.p.watchdogBundle), 0o755);
  const r = await run(w);
  const c = check(r, 'launcher');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /node/);
  assert.equal(r.exitCode, 1);
});

test('flags Claude older than 2.1.295', async () => {
  const w = world();
  assert.equal(MIN_CLAUDE.join('.'), '2.1.295');
  const r = await run(w, { probes: { ...w.probes, claudeVersion: () => '2.1.294 (Claude Code)' } });
  const c = check(r, 'claude-version');
  assert.equal(c.status, 'warn'); // the spec says doctor warns; the exit code is unaffected
  assert.match(c.message, /2\.1\.294/);
  assert.match(c.message, /2\.1\.295/);
  assert.equal(r.exitCode, 0);
  const exact = await run(w, { probes: { ...w.probes, claudeVersion: () => '2.1.295' } });
  assert.equal(check(exact, 'claude-version').status, 'ok');
});

test('compares the Claude version per semver, prerelease included', async () => {
  const w = world();
  const at = async (v) => check(await run(w, { probes: { ...w.probes, claudeVersion: () => v } }), 'claude-version');
  assert.equal((await at('2.1.295-beta.1 (Claude Code)')).status, 'warn'); // a prerelease is below its release
  assert.equal((await at('2.1.295+build.7')).status, 'ok'); // build metadata is ignored
  assert.equal((await at('2.1.296-rc.1')).status, 'ok');
  assert.equal((await at('2.2.0')).status, 'ok');
  assert.equal((await at('2.1.99')).status, 'warn');
});

test('flags Claude with the plugin not enabled', async () => {
  const w = world();
  const r = await run(w, { probes: { ...w.probes, claudePluginEnabled: () => false } });
  assert.equal(check(r, 'claude-plugin').status, 'fail');
  assert.equal(r.exitCode, 1);
});

test('reports Grok as not enforced', async () => {
  const w = world();
  const r = await run(w);
  const c = check(r, 'grok');
  assert.equal(c.status, 'info');
  assert.match(c.message, /not enforced/);
  assert.equal(r.exitCode, 0);
  assert.match(r.text, /not enforced/);
});

test('flags the Codex hooks feature disabled', async () => {
  const w = world();
  const r = await run(w, { probes: { ...w.probes, codexHooksFeature: () => false } });
  const c = check(r, 'codex-hooks-feature');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /hooks/);
  assert.equal(r.exitCode, 1);
  const untrusted = await run(w, { probes: { ...w.probes, codexHooksTrusted: () => false } });
  assert.equal(check(untrusted, 'codex-hooks-trusted').status, 'fail');
});

test('a probe that cannot answer is reported as could not verify, not a failure', async () => {
  const w = world();
  const r = await run(w, { probes: { ...w.probes, codexHooksTrusted: () => null, claudeVersion: () => { throw new Error('boom'); } } });
  assert.equal(check(r, 'codex-hooks-trusted').status, 'unknown');
  assert.equal(check(r, 'claude-version').status, 'unknown');
  assert.equal(r.exitCode, 0);
});

test('flags a fence plugin served from a local-folder marketplace', async () => {
  const w = world();
  const r = await run(w, { probes: { ...w.probes, claudeMarketplaceSource: () => ({ kind: 'directory', path: path.join(w.root, 'market') }) } });
  const c = check(r, 'claude-marketplace');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /local/);
  assert.match(c.message, /hooks\.json/);
});

test('flags disableAllHooks in project settings', async () => {
  const w = world({ files: { 'repo/.claude/settings.local.json': JSON.stringify({ disableAllHooks: true }) } });
  const sub = path.join(w.cwd, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const r = await run(w, { cwd: sub });
  const c = check(r, 'project-settings');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /disableAllHooks/);
  assert.match(c.message, /settings\.local\.json/);
  assert.equal(r.exitCode, 1);
  const clean = world({ files: { 'repo/.claude/settings.json': JSON.stringify({ disableAllHooks: false, permissions: {} }) } });
  assert.equal(check(await run(clean), 'project-settings').status, 'ok');
});

test('flags a log write failure from health.json', async () => {
  const w = world();
  put(path.join(w.home, '.local', 'state', 'fence', 'health.json'), JSON.stringify({ logFailure: { at: '2026-10-18T09:00:00.000Z' } }) + '\n');
  const r = await run(w);
  const c = check(r, 'log-health');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /the last log write failed at 2026-10-18T09:00:00\.000Z; the log may be missing decisions/);
  assert.equal(r.exitCode, 1);
});

test('a log write failure that later writes outlived is a warning, not a failure', async () => {
  const failedAt = '2026-10-18T09:00:00.000Z';
  const entry = (ts) => JSON.stringify({ ts, host: 'claude', tool: 'Bash', decision: 'allow', rule: null }) + '\n';
  const health = (w) => put(path.join(w.home, '.local', 'state', 'fence', 'health.json'), JSON.stringify({ logFailure: { at: failedAt } }) + '\n');

  const later = world();
  health(later);
  put(path.join(later.p.logDir, '2026-10-18.jsonl'), entry('2026-10-18T08:00:00.000Z') + entry('2026-10-18T10:30:00.000Z'));
  const r = await run(later);
  assert.equal(check(r, 'log-health').status, 'warn');
  assert.match(check(r, 'log-health').message, /a log write failed on 2026-10-18T09:00:00\.000Z; later writes succeeded/);
  assert.equal(r.exitCode, 0);

  const earlier = world();
  health(earlier);
  put(path.join(earlier.p.logDir, '2026-10-18.jsonl'), entry('2026-10-18T08:00:00.000Z'));
  assert.equal(check(await run(earlier), 'log-health').status, 'fail');

  const empty = world();
  health(empty);
  assert.equal(check(await run(empty), 'log-health').status, 'fail');

  // only the newest day file counts: an older day's later-looking entry does not clear it
  const older = world();
  health(older);
  put(path.join(older.p.logDir, '2026-10-17.jsonl'), entry('2026-10-17T23:00:00.000Z'));
  put(path.join(older.p.logDir, '2026-10-18.jsonl'), entry('2026-10-18T08:59:59.000Z'));
  assert.equal(check(await run(older), 'log-health').status, 'fail');
});

test('flags an active hatch with its expiry', async () => {
  const w = world();
  const expires = '2026-10-18T13:00:00.000Z';
  put(path.join(w.admin, 'hatch.json'), JSON.stringify({ created: '2026-10-18T12:00:00.000Z', expires }) + '\n');
  const r = await run(w);
  const c = check(r, 'hatch');
  assert.equal(c.status, 'fail');
  assert.match(c.message, new RegExp(expires.replace(/\./g, '\\.')));
  assert.equal(r.exitCode, 1);
  const expired = world();
  put(path.join(expired.admin, 'hatch.json'), JSON.stringify({ created: '2026-10-18T09:00:00.000Z', expires: '2026-10-18T10:00:00.000Z' }) + '\n');
  assert.notEqual(check(await run(expired), 'hatch').status, 'fail');
});

test('flags the needs-repair marker and a pending integrity manifest', async () => {
  const w = world();
  put(path.join(w.home, '.local', 'state', 'fence', 'needs-repair'), 'integrity mismatch\n');
  put(path.join(w.admin, 'integrity.json'), JSON.stringify({ version: 1, created: '2026-10-18T08:00:00.000Z', expires: '2026-10-18T09:00:00.000Z', files: {}, hookKeys: {}, repoRoots: [] }) + '\n');
  const r = await run(w);
  const c = check(r, 'integrity');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /needs-repair/);
  assert.match(c.message, /fence repair/);
  assert.equal(r.exitCode, 1);
});

test('flags NOPASSWD sudo', async () => {
  const w = world();
  const sudoers = { read: () => 'root ALL=(ALL) ALL\nagent ALL=(ALL) NOPASSWD: ALL\n', list: () => [] };
  const r = await run(w, { sudoers });
  const c = check(r, 'sudo');
  assert.equal(c.status, 'warn'); // the spec says doctor warns; the exit code is unaffected
  assert.match(c.message, /NOPASSWD/);
  assert.equal(r.exitCode, 0);
});

test('warns about a long sudo timestamp_timeout', async () => {
  const w = world();
  const sudoers = { read: () => 'Defaults timestamp_timeout=60\nroot ALL=(ALL) ALL\n', list: () => [] };
  const r = await run(w, { sudoers });
  assert.equal(check(r, 'sudo').status, 'warn');
  assert.match(check(r, 'sudo').message, /timestamp_timeout/);
  assert.equal(r.exitCode, 0);
});

test('an unreadable /etc/sudoers is "could not verify", not a sudo misconfiguration', async () => {
  const w = world();
  const sudoers = {
    read: () => {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    },
    list: () => [],
  };
  const r = await run(w, { sudoers });
  const c = check(r, 'sudo');
  assert.equal(c.status, 'unknown');
  assert.match(c.message, /could not verify/);
  assert.doesNotMatch(c.message, /misconfigured/);
  assert.equal(r.exitCode, 0);
});

test('flags a pinned git older than 2.45.1 and a missing pin', async () => {
  const w = world();
  put(w.p.gitPin, JSON.stringify({ path: process.execPath, version: '2.39.5 (Apple Git-154)' }) + '\n');
  const old = await run(w);
  assert.equal(check(old, 'git').status, 'fail');
  assert.match(check(old, 'git').message, /2\.45\.1/);
  fs.rmSync(w.p.gitPin);
  const missing = await run(w);
  assert.notEqual(check(missing, 'git').status, 'ok');
  assert.notEqual(check(missing, 'git').status, 'fail');
});

test('flags a config override in the environment', async () => {
  const w = world();
  const env = { HOME: path.join(w.root, 'other-home'), CLAUDE_CONFIG_DIR: '/somewhere', CODEX_HOME: '/elsewhere', XDG_CONFIG_HOME: '/xdg', FENCE_PROFILE: 'loose' };
  const r = await run(w, { env });
  const c = check(r, 'env-override');
  assert.equal(c.status, 'fail');
  for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'FENCE_PROFILE']) assert.match(c.message, new RegExp(name));
  assert.equal(r.exitCode, 1);
  assert.equal(check(await run(w, { env: { HOME: w.home, PATH: '/usr/bin' } }), 'env-override').status, 'ok');
});

test('warns that node-loading variables affect fence\'s own node; XDG_* is limited to three names', async () => {
  const w = world();
  const env = { HOME: w.home, NODE_OPTIONS: '--require /x', LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/x', DYLD_INSERT_LIBRARIES: '/x.dylib', XDG_RUNTIME_DIR: '/run/user/1', XDG_SESSION_TYPE: 'tty' };
  const r = await run(w, { env });
  const c = check(r, 'env-override');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /affects fence's own node/);
  for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) assert.match(c.message, new RegExp(name));
  assert.doesNotMatch(c.message, /XDG_RUNTIME_DIR|XDG_SESSION_TYPE/);
  assert.equal(r.exitCode, 0);
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const x = check(await run(w, { env: { HOME: w.home, [name]: '/xdg' } }), 'env-override');
    assert.equal(x.status, 'warn');
    assert.match(x.message, new RegExp(name));
  }
  // a host-config override still fails, with the node warning alongside
  const both = check(await run(w, { env: { HOME: w.home, CODEX_HOME: '/c', NODE_OPTIONS: '--x' } }), 'env-override');
  assert.equal(both.status, 'fail');
  assert.match(both.message, /CODEX_HOME/);
  assert.match(both.message, /NODE_OPTIONS/);
});

test('a node binary without an execute bit fails the launcher, also through an fs without accessSync', async () => {
  const w = world();
  const noExec = path.join(w.root, 'node-no-exec');
  put(noExec, '#!/bin/sh\n', 0o644);
  put(w.p.watchdog, trampolineText(noExec, w.p.watchdogBundle), 0o755);
  const real = await run(w);
  assert.equal(check(real, 'launcher').status, 'fail');
  assert.match(check(real, 'launcher').message, /not executable/);
  const { accessSync, ...rest } = fs; // an injected fs with only the basics
  void accessSync;
  const bare = await run(w, { fs: { ...rest } });
  assert.equal(check(bare, 'launcher').status, 'fail');
  assert.match(check(bare, 'launcher').message, /not executable/);
});

test('no Codex bridge and no launcher: the launcher fails, but there is no codex-launcher failure', async () => {
  const w = world();
  fs.rmSync(w.p.watchdog);
  for (const answer of [false, null]) {
    const r = await run(w, { probes: { ...w.probes, codexBridgeInstalled: () => answer } });
    assert.equal(check(r, 'launcher').status, 'fail');
    assert.equal(check(r, 'codex-launcher'), undefined);
    assert.notEqual(check(r, 'codex-bridge').status, 'fail');
  }
});

test('current must be an exact semver version, as the watchdog requires', async () => {
  for (const name of ['1.0', '01.2.3', 'latest', 'v1.2.3', '1.2.3-01', '1.2.3/..']) {
    const w = world();
    if (!name.includes('/')) put(path.join(w.p.versionsDir, name, 'src', 'engine.mjs'), '// engine\n');
    put(w.p.current, `${name}\n`);
    const c = check(await run(w), 'current');
    assert.equal(c.status, 'fail', name);
  }
  const w = world();
  put(path.join(w.p.versionsDir, '1.2.3-rc.1+build.5', 'src', 'engine.mjs'), '// engine\n');
  put(w.p.current, '1.2.3-rc.1+build.5\n');
  assert.equal(check(await run(w), 'current').status, 'ok');
});

test('strips control and bidi characters from every message and name, in text and json', async () => {
  const hostile = 'settings\u001b[2J‮\u0085.json';
  const w = world({ files: { [`repo/.claude/${hostile}`]: JSON.stringify({ disableAllHooks: true }) } });
  const r = await run(w);
  const c = check(r, 'project-settings');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /settings\[2J\.json/);
  const bad = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const nl = (s) => s.replace(/\n/g, ''); // the report's own line breaks
  assert.doesNotMatch(nl(r.text), bad);
  // JSON escapes control characters, so check the parsed string values themselves
  const parsed = JSON.parse((await run(w, { json: true })).text);
  for (const x of [...parsed.checks, ...r.report.checks]) {
    assert.doesNotMatch(x.id, bad);
    assert.doesNotMatch(x.message, bad);
  }
  // a hostile probe answer is cleaned too
  const odd = await run(w, { probes: { ...w.probes, claudeMarketplaceSource: () => ({ kind: 'directory', path: '/m\u001b]0;pwn\u0007' }) } });
  assert.doesNotMatch(nl(odd.text), bad);
});

test('reports a smoke result that is missing, failed, or for another version than current', async () => {
  const w = world();
  put(w.p.smokeResult, JSON.stringify({ version: '0.0.9', ok: true, latencyMs: [], at: '2026-10-18T10:00:00.000Z' }) + '\n');
  assert.equal(check(await run(w), 'smoke').status, 'fail');
  put(w.p.smokeResult, JSON.stringify({ version: VERSION, ok: false, latencyMs: [], at: '2026-10-18T10:00:00.000Z' }) + '\n');
  assert.equal(check(await run(w), 'smoke').status, 'fail');
  fs.rmSync(w.p.smokeResult);
  assert.equal(check(await run(w), 'smoke').status, 'fail');
  fs.rmSync(w.p.current);
  const r = await run(w);
  assert.equal(check(r, 'current').status, 'fail');
  assert.equal(r.exitCode, 1);
});

test('flags an invalid policy', async () => {
  const w = world();
  put(w.p.policy, '{ "version": 1, "rules": [ ');
  const r = await run(w);
  assert.equal(check(r, 'policy').status, 'fail');
  assert.equal(r.exitCode, 1);
});

test('lists unknown tools seen in the last 7 days only', async () => {
  const w = world();
  const line = (tool, ts, host = 'claude') => JSON.stringify({ ts, host, tool, decision: 'undecided', rule: null }) + '\n';
  const day = (d) => path.join(w.p.logDir, `${d}.jsonl`);
  put(day('2026-10-17'), line('Bash', '2026-10-17T10:00:00.000Z') + line('MadeUpTool', '2026-10-17T10:00:01.000Z') + line('MadeUpTool', '2026-10-17T10:00:02.000Z'));
  put(day('2026-09-01'), line('OldUnknownTool', '2026-09-01T10:00:00.000Z'));
  const r = await run(w);
  const c = check(r, 'unknown-tools');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /MadeUpTool/);
  assert.doesNotMatch(c.message, /OldUnknownTool/);
  assert.equal(r.exitCode, 0);
  const none = world();
  assert.equal(check(await run(none), 'unknown-tools').status, 'ok');
});

test('--json prints the structured report', async () => {
  const w = world();
  const out = [];
  const r = await run(w, { json: true, io: { out: (s) => out.push(s) } });
  const parsed = JSON.parse(out.join('\n'));
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.checks.every((c) => typeof c.id === 'string' && typeof c.status === 'string' && typeof c.message === 'string'));
  assert.equal(JSON.parse(r.text).ok, true);
});

test('doctor writes nothing', async () => {
  const w = world({ files: { 'repo/.claude/settings.json': '{}\n' } });
  put(path.join(w.admin, 'hatch.json'), JSON.stringify({ created: '2026-10-18T12:00:00.000Z', expires: '2026-10-18T13:00:00.000Z' }) + '\n');
  const snapshot = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out.push(`${f} ${fs.statSync(f).size} ${fs.statSync(f).mtimeMs}`);
      }
    };
    walk(w.root);
    return out.sort();
  };
  const before = snapshot();
  await run(w);
  await run(w, { json: true });
  assert.deepEqual(snapshot(), before);
});
