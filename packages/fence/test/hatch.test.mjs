import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { hatch, parseDuration, DEFAULT_HATCH_MS, MAX_HATCH_MS } from '../src/cli/hatch.mjs';
import { buildManifest, manifestText } from '../src/cli/integrity.mjs';
import { adminWrite } from '../src/cli/admin.mjs';
import { fencePaths } from '../src/cli/paths.mjs';
import { compareManifest, parseManifest, ABSENT } from '../src/watchdog/integrity.mjs';
import { hatchIsValid } from '../src/watchdog.mjs';
import { buildWatchdog } from '../src/build/bundle-watchdog.mjs';

// Hermetic: every HOME, state directory and admin directory is a temp directory; the admin writer
// and the gate are injected (nothing runs sudo); root ownership is simulated by an injected lstat.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-hatch-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function put(file, text = '', mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;
const UNDECIDED = { decision: 'undecided', rule: null, reason: 'No fence rule decided this call.', scope: {} };
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp', session_id: 's1' });

// A fake installed HOME: policy, the watchdog and CLI bundles with their trampolines, `current`
// and an engine directory, both plugins, Claude and Codex settings, rc files, a skill, a mod,
// fence state and Claude shell snapshots.
function home() {
  const h = dir();
  const p = fencePaths(h);
  put(p.policy, '{"version":1,"rules":[]}\n');
  put(p.watchdogBundle, '// bundled watchdog\n');
  put(p.watchdog, '#!/bin/sh\nexec node fence-hook.mjs "$@"\n', 0o755);
  put(p.shimModule, '// cli shim\n');
  put(p.shim, '#!/bin/sh\nexec node fence-cli.mjs "$@"\n', 0o755);
  put(p.current, '0.1.0\n');
  const engineDir = path.join(p.versionsDir, '0.1.0');
  put(path.join(engineDir, 'src', 'engine.mjs'), `process.stdout.write(${JSON.stringify(`${JSON.stringify(UNDECIDED)}\n`)});\n`);
  put(path.join(engineDir, 'package.json'), '{"name":"@triqual/fence"}\n');
  const claudePlugin = path.join(h, '.claude', 'plugins', 'cache', 'triqual', 'fence', '0.1.0');
  put(path.join(claudePlugin, '.claude-plugin', 'plugin.json'), '{"name":"fence"}\n');
  put(path.join(claudePlugin, 'hooks', 'hooks.json'), '{"hooks":{"PreToolUse":[]}}\n');
  put(path.join(claudePlugin, 'README.md'), 'readme\n');
  put(path.join(claudePlugin, 'lib', 'big.mjs'), 'export const x = 1;\n');
  const codexPlugin = path.join(h, '.codex', 'plugins', 'fence-codex');
  put(path.join(codexPlugin, '.codex-plugin', 'plugin.json'), '{"name":"fence-codex"}\n');
  put(path.join(codexPlugin, 'hooks', 'hooks.json'), '{"hooks":{"PreToolUse":[]}}\n');
  put(path.join(codexPlugin, 'docs', 'notes.md'), 'notes\n');
  put(path.join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'fence@triqual': true }, theme: 'dark' }));
  put(path.join(h, '.codex', 'config.toml'), '[features]\nhooks = true\n\n[projects."/work/x"]\ntrust_level = "trusted"\n');
  put(path.join(h, '.codex', 'hooks.json'), '{"hooks":{}}\n');
  put(path.join(h, '.zshrc'), 'export PATH=$PATH\n');
  put(path.join(h, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
  put(path.join(h, '.claude', 'skills', 'demo', 'notes.txt'), 'notes\n');
  put(path.join(h, '.claude', 'dev-mods', 'm1', 'mod.json'), '{"entry":"index.mjs"}\n');
  put(path.join(p.stateDir, 'log', '2026-10-17.jsonl'), '{}\n');
  put(path.join(p.stateDir, 'health.json'), '{}\n');
  put(path.join(h, '.claude', 'shell-snapshots', 'snap.sh'), 'echo\n');
  return { h, p, engineDir, claudePlugin, codexPlugin };
}

// The admin writer the CLI wiring replaces with adminWrite through sudo: writes into a temp admin dir.
function fakeAdmin() {
  const adminDir = dir();
  const writes = [];
  const adminWriter = (rel, data) => {
    writes.push([rel, String(data)]);
    put(path.join(adminDir, rel), data);
    return { path: path.join(adminDir, rel) };
  };
  return { adminDir, writes, adminWriter };
}

const OK_GATE = () => ({ ok: true });
const NO_MANAGED = { claudeManaged: [], codexManaged: [] };

function rootify(...files) {
  return (file) => {
    const st = fs.lstatSync(file);
    if (!files.includes(file)) return st;
    return { uid: 0, gid: 0, mode: st.mode & ~0o022, size: st.size, ino: st.ino, dev: st.dev, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs };
  };
}

test('default lifetime is one hour and the maximum is eight', async () => {
  assert.equal(DEFAULT_HATCH_MS, H);
  assert.equal(MAX_HATCH_MS, 8 * H);
  const now = Date.parse('2026-10-18T09:00:00.000Z');
  for (const [argv, ms] of [
    [[], H],
    [['--for', '1h'], H],
    [['--for', '30m'], 30 * 60 * 1000],
    [['--for=8h'], 8 * H],
    [['--for', '2h30m'], 2.5 * H],
  ]) {
    const { h } = home();
    const a = fakeAdmin();
    const r = await hatch({ argv, home: h, now: () => now, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
    assert.equal(r.ok, true, `${argv.join(' ')}: ${r.reason}`);
    assert.deepEqual(a.writes.map((w) => w[0]), ['integrity.json', 'hatch.json'], 'the manifest is written before the hatch');
    const hj = JSON.parse(a.writes[1][1]);
    assert.equal(hj.created, iso(now));
    assert.equal(Date.parse(hj.expires) - Date.parse(hj.created), ms, argv.join(' '));
    assert.equal(hatchIsValid({ uid: 0, mode: 0o100644 }, a.writes[1][1], now + 1000), true, 'the watchdog accepts the hatch');
    const m = parseManifest(a.writes[0][1]);
    assert.ok(m, 'the manifest parses');
    assert.equal(m.created, hj.created);
    assert.equal(m.expires, hj.expires);
  }
  assert.equal(parseDuration('8h'), 8 * H);
});

test('--for 9h is refused', async () => {
  for (const argv of [['--for', '9h'], ['--for', '8h1m'], ['--for', '0h'], ['--for', 'soon'], ['--for'], ['--forever']]) {
    const { h } = home();
    const a = fakeAdmin();
    let gated = 0;
    const r = await hatch({ argv, home: h, gate: () => (gated++, { ok: true }), adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
    assert.equal(r.ok, false, argv.join(' '));
    assert.equal(a.writes.length, 0, 'nothing written');
    assert.equal(gated, 0, 'refused before the gate');
  }
  const { h } = home();
  const b = fakeAdmin();
  const r = await hatch({ argv: ['--for', '9h'], home: h, gate: OK_GATE, adminWriter: b.adminWriter, adminDir: b.adminDir, ...NO_MANAGED });
  assert.match(r.reason, /8 h/);
});

test('the manifest hashes the listed files and excludes fence state', () => {
  const { h, p, engineDir, claudePlugin, codexPlugin } = home();
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  assert.ok(parseManifest(manifestText(m)), 'the manifest parses as the watchdog reads it');
  const hashed = (f) => {
    assert.ok(Object.hasOwn(m.files, f), `${f} is listed`);
    assert.equal(m.files[f], sha(fs.readFileSync(f)), f);
  };
  // policy, both bundles and both trampolines, current, the engine files
  for (const f of [p.policy, p.watchdogBundle, p.watchdog, p.shimModule, p.shim, p.current]) hashed(f);
  hashed(path.join(engineDir, 'src', 'engine.mjs'));
  hashed(path.join(engineDir, 'package.json'));
  // both plugins' hooks.json, Codex hooks.json, rc files
  hashed(path.join(claudePlugin, 'hooks', 'hooks.json'));
  hashed(path.join(codexPlugin, 'hooks', 'hooks.json'));
  hashed(path.join(h, '.codex', 'hooks.json'));
  hashed(path.join(h, '.zshrc'));
  // listed files that do not exist yet are recorded as absent, so creating one is a difference
  assert.equal(m.files[path.join(h, '.codex', 'requirements.toml')], ABSENT);
  assert.equal(m.files[path.join(h, '.bashrc')], ABSENT);
  // hook-related keys only (settings), and only features/hooks/plugins of config.toml
  const settings = path.join(h, '.claude', 'settings.json');
  assert.deepEqual(Object.keys(m.hookKeys[settings]).sort(), ['disableAllHooks', 'enabledPlugins', 'env', 'extraKnownMarketplaces', 'hooks']);
  assert.equal(m.hookKeys[settings].disableAllHooks, ABSENT);
  assert.notEqual(m.hookKeys[settings].enabledPlugins, ABSENT);
  assert.ok(!Object.hasOwn(m.hookKeys[settings], 'theme'));
  const toml = path.join(h, '.codex', 'config.toml');
  assert.deepEqual(Object.keys(m.hookKeys[toml]).sort(), ['features', 'hooks', 'plugins']);
  assert.notEqual(m.hookKeys[toml].features, ABSENT);
  assert.equal(m.hookKeys[toml].plugins, ABSENT);
  // the trust record is not part of it: editing it is no difference
  put(toml, fs.readFileSync(toml, 'utf8').replace('"trusted"', '"untrusted"'));
  assert.equal(compareManifest(m).equal, true, JSON.stringify(compareManifest(m).diffs));
  // nothing from fence state or shell snapshots
  const all = [...Object.keys(m.files), ...Object.keys(m.hookKeys)];
  assert.ok(all.every((f) => !f.startsWith(p.stateDir + path.sep)), 'no fence state');
  assert.ok(all.every((f) => !f.includes(`${path.sep}shell-snapshots${path.sep}`)), 'no shell snapshots');
  // and the untouched tree compares equal
  const r = compareManifest(m);
  assert.deepEqual(r, { equal: true, diffs: [], timedOut: false });
});

test('the manifest records resolved real paths (a dotfile-managed settings.json is a symlink)', () => {
  const { h, p } = home();
  const dotfiles = dir();
  const settings = path.join(h, '.claude', 'settings.json');
  const real = put(path.join(dotfiles, 'claude-settings.json'), JSON.stringify({ hooks: {} }));
  fs.rmSync(settings);
  fs.symlinkSync(real, settings);
  const realRc = put(path.join(dotfiles, 'zshrc'), 'alias ll=ls\n');
  fs.rmSync(path.join(h, '.zshrc'));
  fs.symlinkSync(realRc, path.join(h, '.zshrc'));
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  assert.ok(Object.hasOwn(m.hookKeys, real) && !Object.hasOwn(m.hookKeys, settings), 'hookKeys has the real path');
  assert.ok(Object.hasOwn(m.files, realRc) && !Object.hasOwn(m.files, path.join(h, '.zshrc')), 'files has the real path');
  // the watchdog treats a symlinked listed path as unreadable: with real paths the comparison is clean
  assert.deepEqual(compareManifest(m), { equal: true, diffs: [], timedOut: false });
});

test('plugin directories hash only manifest and hook files', () => {
  const { h, p, claudePlugin, codexPlugin } = home();
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  for (const f of [
    path.join(claudePlugin, '.claude-plugin', 'plugin.json'),
    path.join(claudePlugin, 'hooks', 'hooks.json'),
    path.join(codexPlugin, '.codex-plugin', 'plugin.json'),
    path.join(h, '.claude', 'skills', 'demo', 'SKILL.md'),
    path.join(h, '.claude', 'dev-mods', 'm1', 'mod.json'),
  ]) {
    assert.equal(m.files[f], sha(fs.readFileSync(f)), f);
  }
  for (const f of [path.join(claudePlugin, 'README.md'), path.join(claudePlugin, 'lib', 'big.mjs'), path.join(codexPlugin, 'docs', 'notes.md'), path.join(h, '.claude', 'skills', 'demo', 'notes.txt')]) {
    assert.ok(!Object.hasOwn(m.files, f), `${f} is not listed`);
  }
  // a changed README is no difference; a changed plugin.json is
  put(path.join(claudePlugin, 'README.md'), 'changed\n');
  assert.equal(compareManifest(m).equal, true);
  const pluginJson = path.join(claudePlugin, '.claude-plugin', 'plugin.json');
  put(pluginJson, '{"name":"fence","hooks":"./other.json"}\n');
  assert.deepEqual(compareManifest(m).diffs, [{ path: pluginJson, kind: 'changed' }]);
});

test('re-opening a hatch carries over the open baseline; an expired one carries over until it was verified', async () => {
  const fx = home();
  const a = fakeAdmin();
  const settings = path.join(fx.h, '.claude', 'settings.json');
  const integrity = () => fs.readFileSync(path.join(a.adminDir, 'integrity.json'));
  const open = (t, argv = ['--for', '1h']) => hatch({ argv, home: fx.h, now: () => t, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
  // (b) extend while open: created and the baseline stay, expires moves, hatch.json is new
  const t0 = Date.now() - 6 * H;
  assert.equal((await open(t0)).ok, true);
  const first = parseManifest(integrity().toString('utf8'));
  // (a) the agent sets disableAllHooks during the hatch, then the hatch is re-opened
  put(settings, JSON.stringify({ enabledPlugins: { 'fence@triqual': true }, theme: 'dark', disableAllHooks: true }));
  const t1 = t0 + 30 * 60 * 1000;
  assert.equal((await open(t1, ['--for', '2h'])).ok, true);
  const second = parseManifest(integrity().toString('utf8'));
  assert.deepEqual({ ...second, expires: first.expires }, first, 'only expires changed');
  assert.equal(second.expires, iso(t1 + 2 * H));
  const hj = JSON.parse(a.writes.at(-1)[1]);
  assert.deepEqual(hj, { created: iso(t1), expires: iso(t1 + 2 * H) });
  // the carried-over baseline still sees the change once the hatch expires
  assert.deepEqual(compareManifest(second).diffs, [{ path: settings, key: 'disableAllHooks', kind: 'added' }]);
  // expired and never verified (no stamp): re-opening still carries it over
  const t2 = t1 + 3 * H;
  assert.equal((await open(t2)).ok, true);
  const third = parseManifest(integrity().toString('utf8'));
  assert.equal(third.created, first.created);
  assert.deepEqual(third.files, first.files);
  assert.equal(third.expires, iso(t2 + H));
  // expired and verified clean (a stamp for its raw bytes, written after its expires): a fresh baseline
  const t3 = t2 + 2 * H; // still in the past, so the stamp's ctime (now) is after expires
  assert.ok(t3 < Date.now());
  put(path.join(fx.p.verifiedDir, sha(integrity())), 'ok\n', 0o600);
  assert.equal((await open(t3)).ok, true);
  const fresh = parseManifest(integrity().toString('utf8'));
  assert.equal(fresh.created, iso(t3));
  assert.notEqual(fresh.hookKeys[settings].disableAllHooks, ABSENT, 'the new baseline is taken now');
  assert.equal(compareManifest(fresh).equal, true);
});

test('re-opening over a carried baseline merges the old and the new repo roots', async () => {
  const fx = home();
  const a = fakeAdmin();
  const repoA = dir();
  const repoB = dir();
  const integrity = () => parseManifest(fs.readFileSync(path.join(a.adminDir, 'integrity.json'), 'utf8'));
  const open = (t, repoRoots) => hatch({ argv: ['--for', '1h'], home: fx.h, now: () => t, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, repoRoots, ...NO_MANAGED });
  const t0 = Date.now() - 6 * H;
  assert.equal((await open(t0, [repoA])).ok, true);
  assert.deepEqual(integrity().repoRoots, [repoA]);
  // re-opened while open, from another repository: both roots are scanned at comparison time
  assert.equal((await open(t0 + 20 * 60 * 1000, [repoB, 'relative/ignored', 7])).ok, true);
  assert.deepEqual(integrity().repoRoots, [repoA, repoB].sort());
  // re-opened with no roots: the old ones stay
  assert.equal((await open(t0 + 40 * 60 * 1000, [])).ok, true);
  assert.deepEqual(integrity().repoRoots, [repoA, repoB].sort());
  assert.equal(integrity().created, iso(t0), 'the carried baseline keeps its creation time');
  // a verified (stamped) manifest gives a fresh baseline: only the new roots
  const raw = fs.readFileSync(path.join(a.adminDir, 'integrity.json'));
  const later = t0 + 3 * H;
  put(path.join(fx.p.verifiedDir, sha(raw)), 'ok\n', 0o600);
  assert.equal((await open(later, [repoB])).ok, true);
  assert.deepEqual(integrity().repoRoots, [repoB]);
});

test('a close whose hatch.json write fails after integrity.json was rewritten says to run --close again', async () => {
  const { h } = home();
  const a = fakeAdmin();
  const t0 = Date.parse('2026-10-18T09:00:00.000Z');
  assert.equal((await hatch({ argv: [], home: h, now: () => t0, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED })).ok, true);
  const failing = (rel, data) => {
    if (rel === 'hatch.json') throw new Error('sudo mv failed (exit 1)');
    return a.adminWriter(rel, data);
  };
  const r = await hatch({ argv: ['--close'], home: h, now: () => t0 + 60000, gate: OK_GATE, adminWriter: failing, adminDir: a.adminDir, ...NO_MANAGED });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fence hatch --close again/);
});

test('a log cwd equal to HOME does not make ~/.claude/settings.json a project settings file', () => {
  const { h, p } = home();
  const created = Date.now() - 2 * H;
  const expires = Date.now() - H;
  const m = buildManifest(h, p, { created: iso(created), expires: iso(expires), ...NO_MANAGED });
  const settings = path.join(h, '.claude', 'settings.json');
  const inWindow = new Date(created + 10 * 60 * 1000);
  fs.utimesSync(settings, inWindow, inWindow);
  const logDir = path.join(p.stateDir, 'log');
  put(path.join(logDir, `${iso(created + 15 * 60 * 1000).slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: iso(created + 15 * 60 * 1000), cwd: h, repo: null })}\n`);
  assert.deepEqual(compareManifest(m, { logDir }), { equal: true, diffs: [], timedOut: false });
});

test('compare detects a changed hooks.json', () => {
  const { h, p, claudePlugin } = home();
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  const hooks = path.join(claudePlugin, 'hooks', 'hooks.json');
  put(hooks, '{"hooks":{}}\n');
  const r = compareManifest(m);
  assert.equal(r.equal, false);
  assert.deepEqual(r.diffs, [{ path: hooks, kind: 'changed' }]);
  // a file that was absent and now exists is a difference too
  put(path.join(h, '.codex', 'requirements.toml'), '[hooks]\n');
  assert.ok(compareManifest(m).diffs.some((d) => d.path === path.join(h, '.codex', 'requirements.toml') && d.kind === 'added'));
});

test('compare detects a removed plugin registration key', () => {
  const { h, p } = home();
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  const settings = path.join(h, '.claude', 'settings.json');
  put(settings, JSON.stringify({ theme: 'light' }));
  const r = compareManifest(m);
  assert.equal(r.equal, false);
  assert.deepEqual(r.diffs, [{ path: settings, key: 'enabledPlugins', kind: 'missing' }]);
  // an added hook key (disableAllHooks) is a difference; a non-hook key is not
  put(settings, JSON.stringify({ enabledPlugins: { 'fence@triqual': true }, theme: 'light', disableAllHooks: true }));
  assert.deepEqual(compareManifest(m).diffs, [{ path: settings, key: 'disableAllHooks', kind: 'added' }]);
  // a removed [features] table in config.toml
  put(settings, JSON.stringify({ enabledPlugins: { 'fence@triqual': true }, theme: 'dark' }));
  const toml = path.join(h, '.codex', 'config.toml');
  put(toml, '[projects."/work/x"]\ntrust_level = "trusted"\n');
  assert.deepEqual(compareManifest(m).diffs, [{ path: toml, key: 'features', kind: 'missing' }]);
});

test('compare detects a project settings file touched in the window with disableAllHooks', () => {
  const { h, p } = home();
  const created = Date.now() - 2 * H;
  const expires = Date.now() - H;
  const m = buildManifest(h, p, { created: iso(created), expires: iso(expires), ...NO_MANAGED });
  const repo = dir();
  const sub = path.join(repo, 'pkg');
  fs.mkdirSync(sub);
  const settings = put(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  const inWindow = new Date(created + 10 * 60 * 1000);
  fs.utimesSync(settings, inWindow, inWindow);
  const logDir = path.join(p.stateDir, 'log');
  const day = iso(created + 15 * 60 * 1000).slice(0, 10);
  put(path.join(logDir, `${day}.jsonl`), `${JSON.stringify({ ts: iso(created + 15 * 60 * 1000), decision: 'hatch', cwd: sub, repo: { root: repo, branch: 'main' } })}\n`);
  const r = compareManifest(m, { logDir });
  assert.equal(r.equal, false);
  assert.deepEqual(r.diffs, [{ path: settings, key: 'disableAllHooks', kind: 'project-settings' }]);
  // the same file touched outside the window is not a difference
  const before = new Date(created - H);
  fs.utimesSync(settings, before, before);
  assert.equal(compareManifest(m, { logDir }).equal, true);
  // nor is a file touched in the window that holds no hook-related key
  put(settings, JSON.stringify({ permissions: {} }));
  fs.utimesSync(settings, inWindow, inWindow);
  assert.equal(compareManifest(m, { logDir }).equal, true);
  // a repo root only seen in a log line outside the window is not checked
  put(settings, JSON.stringify({ hooks: {} }));
  fs.utimesSync(settings, inWindow, inWindow);
  put(path.join(logDir, `${day}.jsonl`), `${JSON.stringify({ ts: iso(created - H), cwd: repo, repo: { root: repo, branch: 'main' } })}\n`);
  assert.equal(compareManifest(m, { logDir }).equal, true);
  // a Codex project config with [hooks], touched in the window, for a root seen in the window
  put(path.join(logDir, `${day}.jsonl`), `${JSON.stringify({ ts: iso(created + 20 * 60 * 1000), cwd: repo, repo: null })}\n`);
  const codex = put(path.join(repo, '.codex', 'config.toml'), '[hooks]\nenabled = false\n');
  fs.utimesSync(codex, inWindow, inWindow);
  fs.utimesSync(settings, before, before);
  assert.deepEqual(compareManifest(m, { logDir }).diffs, [{ path: codex, key: 'hooks', kind: 'project-settings' }]);
});

test('compare reports timedOut past the deadline', () => {
  const { h, p } = home();
  const m = buildManifest(h, p, { created: iso(Date.now()), expires: iso(Date.now() + H), ...NO_MANAGED });
  let t = 1000;
  const r = compareManifest(m, { now: () => (t += 10), deadlineAt: 1050 });
  assert.equal(r.timedOut, true);
  assert.equal(r.equal, false);
  // the project-settings scan stops at the deadline too
  const late = compareManifest({ ...m, files: {}, hookKeys: {} }, { now: () => 2000, deadlineAt: 1500, logDir: path.join(p.stateDir, 'log') });
  assert.equal(late.timedOut, true);
});

test('hatch requires the gate', async () => {
  for (const gate of [undefined, () => ({ ok: false, reason: 'sudo -v failed (exit 1)' }), () => false]) {
    const { h } = home();
    const a = fakeAdmin();
    const r = await hatch({ argv: [], home: h, gate, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
    assert.equal(r.ok, false);
    assert.match(r.reason, /sudo/);
    assert.equal(a.writes.length, 0, 'nothing written without the gate');
  }
  // without an admin writer, a process runner is required (adminWrite through sudo)
  const { h } = home();
  const r = await hatch({ argv: [], home: h, gate: OK_GATE, adminDir: dir(), ...NO_MANAGED });
  assert.equal(r.ok, false);
  assert.match(r.reason, /runner/);
});

test('the default admin writer is adminWrite through sudo with the injected runner', async () => {
  const { h } = home();
  const adminDir = dir();
  const calls = [];
  const run = (cmd, args, opts) => (calls.push([cmd, ...args, opts?.input === undefined ? null : 'input']), { status: 0 });
  const r = await hatch({ argv: ['--for', '2h'], home: h, gate: OK_GATE, run, adminDir, ...NO_MANAGED });
  assert.equal(r.ok, true, r.reason);
  const tees = calls.filter((c) => c[1] === '/usr/bin/tee').map((c) => c[2]);
  assert.deepEqual(tees, [path.join(adminDir, 'integrity.json.tmp'), path.join(adminDir, 'hatch.json.tmp')]);
  assert.ok(calls.every((c) => c[0] === '/usr/bin/sudo'));
});

test('closing a hatch early rewrites the expires of integrity.json and hatch.json', async () => {
  const { h } = home();
  const a = fakeAdmin();
  const t0 = Date.parse('2026-10-18T09:00:00.000Z');
  assert.equal((await hatch({ argv: ['--for', '4h'], home: h, now: () => t0, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED })).ok, true);
  const before = parseManifest(fs.readFileSync(path.join(a.adminDir, 'integrity.json'), 'utf8'));
  const closeAt = t0 + 30 * 60 * 1000;
  const r = await hatch({ argv: ['--close'], home: h, now: () => closeAt, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(a.writes.slice(2).map((w) => w[0]), ['integrity.json', 'hatch.json'], 'integrity first, so the skip never outlives the hatch');
  const after = parseManifest(fs.readFileSync(path.join(a.adminDir, 'integrity.json'), 'utf8'));
  assert.equal(after.expires, iso(closeAt));
  assert.deepEqual({ ...after, expires: before.expires }, before, 'only expires changed');
  const hj = fs.readFileSync(path.join(a.adminDir, 'hatch.json'), 'utf8');
  assert.equal(JSON.parse(hj).expires, iso(closeAt));
  assert.equal(hatchIsValid({ uid: 0, mode: 0o100644 }, hj, closeAt), false, 'the hatch is over');
  // closing with no open hatch writes nothing
  const n = a.writes.length;
  const again = await hatch({ argv: ['--close'], home: h, now: () => closeAt + 1000, gate: OK_GATE, adminWriter: a.adminWriter, adminDir: a.adminDir, ...NO_MANAGED });
  assert.equal(again.ok, false);
  assert.equal(a.writes.length, n);
});

test('adminWrite refuses a directory target', () => {
  const adminDir = dir();
  fs.mkdirSync(path.join(adminDir, 'hatch.json'));
  const other = dir();
  fs.symlinkSync(other, path.join(adminDir, 'integrity.json'));
  for (const rel of ['hatch.json', 'integrity.json']) {
    const calls = [];
    const run = (cmd, args) => (calls.push([cmd, ...args]), { status: 0 });
    assert.throws(() => adminWrite(rel, 'x', { adminDir, run, sudoPath: '/fake/sudo' }), /directory/, rel);
    assert.deepEqual(calls, [], `${rel}: no sudo call`);
  }
});

// The real bundle, loaded as a module so the root-ownership seam (io.lstat) can be injected; the
// longer deadline (module API only) keeps a loaded machine from cutting the engine off.
async function bundledMain() {
  const file = path.join(dir(), 'fence-hook.mjs');
  put(file, buildWatchdog({ nodePath: process.execPath, deadlineMs: 30000 }), 0o755);
  const mod = await import(pathToFileURL(file).href);
  assert.equal(typeof mod.main, 'function');
  return mod.main;
}

function expiredHatch() {
  const fx = home();
  const admin = dir();
  const m = buildManifest(fx.h, fx.p, { created: iso(Date.now() - 2 * H), expires: iso(Date.now() - H), ...NO_MANAGED });
  const file = put(path.join(admin, 'integrity.json'), manifestText(m));
  return { ...fx, admin, file, lstat: rootify(file) };
}

const argvFor = (fx) => ['pre', '--host', 'claude', '--state-dir', fx.p.stateDir, '--admin-dir', fx.admin];

test('the bundled watchdog detects a mismatch against a manifest built by buildManifest and denies', async () => {
  const main = await bundledMain();
  const fx = expiredHatch();
  put(path.join(fx.claudePlugin, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  const r = await main(argvFor(fx), { stdin: PAYLOAD, env: { ...process.env, HOME: fx.h }, lstat: fx.lstat });
  assert.equal(r.exit, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /changed after the last hatch/);
  const marker = fs.readFileSync(path.join(fx.p.stateDir, 'needs-repair'), 'utf8');
  assert.match(marker, /hooks\.json/);
});

test('the bundled watchdog writes a stamp after a clean comparison', async () => {
  const main = await bundledMain();
  const fx = expiredHatch();
  const r = await main(argvFor(fx), { stdin: PAYLOAD, env: { ...process.env, HOME: fx.h }, lstat: fx.lstat });
  assert.deepEqual(r, { stdout: '', stderr: '', exit: 0 }, 'clean: the engine decides (undecided)');
  const stamp = path.join(fx.p.verifiedDir, sha(fs.readFileSync(fx.file)));
  assert.ok(fs.lstatSync(stamp).isFile(), 'the stamp is named by the sha256 of the raw manifest bytes');
  assert.equal(fs.existsSync(path.join(fx.p.stateDir, 'needs-repair')), false);
});
