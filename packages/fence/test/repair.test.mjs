import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { install } from '../src/cli/install.mjs';
import { rollback, upgrade } from '../src/cli/upgrade.mjs';
import { repair } from '../src/cli/repair.mjs';
import { COMMANDS, SUDO } from '../src/cli/humanonly.mjs';
import { fencePaths } from '../src/cli/paths.mjs';

// Hermetic: every test gets a temp HOME, admin directory and state under os.tmpdir(). npm, git,
// sudo, claude and codex are never run: the injected `run` fakes them (a fake `npm install` copies
// this package into the temp prefix with the requested version). Node is the only real program: the
// installed launcher check runs the copied watchdog with process.execPath against temp directories.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-repair-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NPM = '/fake/bin/npm';
const V1 = '0.1.0';
const V2 = '0.2.0';
const DEADLINE = 20_000;
const SPAWN_TIMEOUT_MS = 60_000;
const AUDIT_OK = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n';
const HOUR = 60 * 60 * 1000;

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

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
}

function fakeRun() {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const name = path.basename(cmd);
    calls.push({ cmd, name, args: [...args] });
    if (name === 'fence-hook' || cmd === NODE) {
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    }
    if (cmd === SUDO) return { status: 0, stdout: '', stderr: '' };
    if (cmd === NPM && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const spec = args[args.length - 1];
      copyPackage(path.join(prefix, 'node_modules', '@triqual', 'fence'), spec.slice(spec.lastIndexOf('@') + 1));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === NPM && args[0] === 'audit') return { status: 0, stdout: AUDIT_OK, stderr: '' };
    if (name === 'git') return { status: 0, stdout: 'git version 2.47.1 (fake)\n', stderr: '' };
    return { status: 127, stdout: '', stderr: `unexpected program ${cmd}` };
  };
  return { run, calls };
}

// A smoke test that passes except for the engine directories named in `failing`.
function smokeFailing(...failing) {
  const calls = [];
  const smoke = (o) => {
    calls.push(path.basename(o.engineDir));
    if (failing.includes(path.basename(o.engineDir))) return { ok: false, failures: ['claude deny: expected permissionDecision deny'], latencyMs: [] };
    return { ok: true, failures: [], latencyMs: [1, 2] };
  };
  return { smoke, calls };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Fence 0.1.0 installed, then upgraded to 0.2.0 (so versions/ holds both), in a temp HOME with an
// empty temp admin directory.
async function installedTwice() {
  const home = newDir('home');
  const admin = newDir('admin');
  const env = { PATH: binDir('git') };
  const base = { home, run: fakeRun().run, env, nodePath: NODE, npmPath: NPM, smoke: smokeFailing().smoke, deadlineMs: DEADLINE };
  const r1 = await install({ ...base, version: V1 });
  assert.equal(r1.ok, true, r1.reason);
  const r2 = await upgrade({ ...base, run: fakeRun().run, version: V2 });
  assert.equal(r2.ok, true, r2.reason);
  const p = fencePaths(home);
  const common = {
    home,
    env,
    nodePath: NODE,
    adminDir: admin,
    deadlineMs: DEADLINE,
    probes: {},
    sudoers: null,
    cwd: newDir('repo'),
    isRootOwned: () => true,
  };
  return { home, admin, env, p, common };
}

// A pending integrity denial: a watched file, the manifest of an expired hatch that recorded it,
// the needs-repair marker the watchdog writes, and then the file changes.
function mismatch(w, { manifestText } = {}) {
  const watched = path.join(newDir('watched'), 'settings.txt');
  fs.writeFileSync(watched, 'original\n');
  const created = new Date(Date.now() - 3 * HOUR).toISOString();
  const expires = new Date(Date.now() - 2 * HOUR).toISOString();
  const manifest = { version: 1, created, expires, files: { [watched]: sha('original\n') }, hookKeys: {}, repoRoots: [] };
  const raw = manifestText ?? `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(path.join(w.admin, 'integrity.json'), raw);
  fs.writeFileSync(path.join(w.admin, 'hatch.json'), `${JSON.stringify({ created, expires })}\n`);
  fs.mkdirSync(w.p.stateDir, { recursive: true });
  const marker = path.join(w.p.stateDir, 'needs-repair');
  fs.writeFileSync(marker, `integrity ${sha(raw)}\nchanged ${watched}\n`);
  fs.writeFileSync(watched, 'tampered\n');
  return { watched, marker, raw, expiresMs: Date.parse(expires), integrity: path.join(w.admin, 'integrity.json') };
}

const files = (p) => [p.current, p.watchdog, p.watchdogBundle, p.shim, p.shimModule, p.smokeResult].map((f) => (fs.existsSync(f) ? read(f) : null));

test('repair restores a missing watchdog from the newest passing version', async () => {
  const w = await installedTwice();
  const { p } = w;
  const goodBundle = read(p.watchdogBundle);
  const goodTrampoline = read(p.watchdog);
  fs.rmSync(p.watchdog);
  fs.rmSync(p.watchdogBundle);
  fs.rmSync(p.smokeResult);
  const f = fakeRun();
  const s = smokeFailing();
  const out = [];
  const r = await repair({ ...w.common, run: f.run, smoke: s.smoke, io: { out: (l) => out.push(l) } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, V2, 'the newest installed version');
  assert.deepEqual(r.skipped, []);
  assert.equal(r.integrity.pending, false);
  // the watchdog is back: trampoline and bundle, and the installed launcher was checked end to end
  assert.equal(read(p.watchdog), goodTrampoline);
  assert.equal(read(p.watchdogBundle).split('\n')[0], `#!${NODE}`);
  assert.equal(read(p.watchdogBundle), goodBundle);
  assert.equal(read(p.current), `${V2}\n`);
  assert.ok(f.calls.some((c) => c.name === 'fence-hook' && c.args[0] === 'pre'));
  // the smoke test ran on the newest version first, and is recorded for doctor
  assert.equal(s.calls[0], V2);
  const rec = JSON.parse(read(p.smokeResult));
  assert.equal(rec.version, V2);
  assert.equal(rec.ok, true);
  // the registrations are re-checked with doctor's checks
  assert.ok(r.registrations.some((c) => c.id === 'launcher' && c.status === 'ok'));
  assert.ok(out.some((l) => /launcher/.test(l)));
  // nothing is left behind
  for (const name of fs.readdirSync(p.binDir)) assert.ok(!/tmp|\.bak-/.test(name), name);
});

test('repair skips a version whose smoke test fails', async () => {
  const w = await installedTwice();
  const { p } = w;
  fs.rmSync(p.watchdog);
  const s = smokeFailing(V2);
  const prompts = [];
  let gated = 0;
  const confirm = (summary) => {
    prompts.push(summary);
    return true;
  };
  const gate = () => {
    gated++;
    return { ok: true };
  };
  const r = await repair({ ...w.common, run: fakeRun().run, smoke: s.smoke, confirm, gate });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, V1, 'falls back to the next newest passing version');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].version, V2);
  assert.match(r.skipped[0].reason, /smoke test failed/);
  assert.deepEqual(s.calls, [V2, V1]);
  assert.equal(read(p.current), `${V1}\n`);
  assert.equal(JSON.parse(read(p.smokeResult)).version, V1);
  assert.ok(fs.existsSync(p.watchdog));
  // the switch to a fallback was confirmed by name, then gated, once
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].fallback.version, V1);
  assert.equal(prompts[0].fallback.from, V2);
  assert.equal(gated, 1);

  // when no version passes, nothing is touched and the reason names each one
  fs.writeFileSync(p.current, `${V2}\n`);
  const before = files(p);
  const none = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing(V1, V2).smoke, confirm, gate });
  assert.equal(none.ok, false);
  assert.match(none.reason, new RegExp(`${V2.replaceAll('.', '\\.')}`));
  assert.match(none.reason, new RegExp(`${V1.replaceAll('.', '\\.')}`));
  assert.deepEqual(files(p), before);
});

test('after a rollback, repair keeps current and asks nothing', async () => {
  const w = await installedTwice();
  const { p } = w;
  const rb = await rollback({ home: w.home, run: fakeRun().run, env: w.env, nodePath: NODE, smoke: smokeFailing().smoke, deadlineMs: DEADLINE });
  assert.equal(rb.ok, true, rb.reason);
  assert.equal(read(p.current), `${V1}\n`);
  fs.rmSync(p.watchdog);
  const s = smokeFailing();
  const r = await repair({
    ...w.common,
    run: fakeRun().run,
    smoke: s.smoke,
    confirm: () => assert.fail('no confirmation is asked when current is intact'),
    gate: () => assert.fail('no sudo gate when current is intact'),
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, V1, 'the rolled-back version stays current');
  assert.equal(read(p.current), `${V1}\n`);
  assert.deepEqual(s.calls, [V1], 'the newer kept version is not even smoke-tested');
  assert.ok(fs.existsSync(p.watchdog), 'the watchdog is re-placed from current');
  assert.equal(JSON.parse(read(p.smokeResult)).version, V1);
});

test('a planted newer version is never activated without the confirmation and the gate', async () => {
  const w = await installedTwice();
  const { p } = w;
  const PLANTED = '0.3.0';
  copyPackage(path.join(p.versionsDir, PLANTED), PLANTED);

  // current intact: the planted version is neither smoke-tested nor activated, nothing is asked
  const keep = smokeFailing();
  const kept = await repair({
    ...w.common,
    run: fakeRun().run,
    smoke: keep.smoke,
    confirm: () => assert.fail('asked'),
    gate: () => assert.fail('gated'),
  });
  assert.equal(kept.ok, true, kept.reason);
  assert.equal(kept.version, V2);
  assert.deepEqual(keep.calls, [V2]);
  assert.equal(read(p.current), `${V2}\n`);

  // current failing its smoke test: the newest candidate is the planted one; it is named, and only
  // a yes plus the gate activates it
  const events = [];
  const refusals = [
    { label: 'declined', confirm: (s) => (events.push(`confirm ${s.fallback.version}`), false), gate: () => (events.push('gate'), true) },
    { label: 'gate refused', confirm: (s) => (events.push(`confirm ${s.fallback.version}`), true), gate: () => (events.push('gate'), { ok: false, reason: 'sudo -v failed' }) },
    { label: 'gate throws', confirm: () => true, gate: () => { throw new Error('no tty'); } },
    { label: 'no gate', confirm: () => true, gate: undefined },
  ];
  for (const a of refusals) {
    fs.rmSync(p.watchdog, { force: true });
    const before = files(p);
    const r = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing(V2).smoke, confirm: a.confirm, gate: a.gate });
    assert.equal(r.ok, false, a.label);
    assert.equal(read(p.current), `${V2}\n`, a.label);
    assert.deepEqual(files(p), before, `${a.label}: nothing changed`);
  }
  assert.deepEqual(events, [`confirm ${PLANTED}`, `confirm ${PLANTED}`, 'gate']);

  const ok = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing(V2).smoke, confirm: () => true, gate: () => true });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.version, PLANTED);
  assert.equal(read(p.current), `${PLANTED}\n`);
});

test('no code of a non-current version runs before the human confirms and the gate passes', async () => {
  const w = await installedTwice();
  const { p } = w;
  const PLANTED = '0.3.0';
  const planted = path.join(p.versionsDir, PLANTED);
  copyPackage(planted, PLANTED);
  // the planted copy's bundler writes a marker file as soon as anything imports it
  const marker = path.join(newDir('marker'), 'ran');
  fs.writeFileSync(
    path.join(planted, 'src', 'build', 'bundle-watchdog.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\nexport function buildWatchdog() { throw new Error('planted bundler'); }\n`,
  );
  const prompts = [];
  const before = files(p);
  // current fails its smoke test, so the planted newest version is the fallback candidate
  const s = smokeFailing(V2);
  const attempts = [
    { label: 'declined', confirm: (x) => (prompts.push(x.fallback), false), gate: () => assert.fail('gated after a decline') },
    { label: 'gate refused', confirm: (x) => (prompts.push(x.fallback), true), gate: () => ({ ok: false, reason: 'sudo -v failed' }) },
    { label: 'gate throws', confirm: () => true, gate: () => { throw new Error('no tty'); } },
    { label: 'no gate', confirm: () => true, gate: undefined },
    { label: 'no confirm step', confirm: undefined, gate: () => true },
  ];
  for (const a of attempts) {
    const r = await repair({ ...w.common, run: fakeRun().run, smoke: s.smoke, confirm: a.confirm, gate: a.gate });
    assert.equal(r.ok, false, a.label);
    assert.equal(fs.existsSync(marker), false, `${a.label}: the planted version's code did not run`);
    assert.equal(read(p.current), `${V2}\n`, a.label);
    assert.deepEqual(files(p), before, a.label);
  }
  assert.deepEqual(s.calls, attempts.map(() => V2), 'only current was smoke-tested before the confirmation');
  // chosen by its directory name alone, and the prompt says it is outside the integrity check
  assert.equal(prompts[0].version, PLANTED);
  assert.equal(prompts[0].from, V2);

  // after the confirmation and the gate the build runs (and here fails): nothing is activated
  const r = await repair({ ...w.common, run: fakeRun().run, smoke: s.smoke, confirm: () => true, gate: () => true });
  assert.equal(fs.existsSync(marker), true, 'the build ran only after the confirmation and the gate');
  assert.equal(r.ok, false);
  assert.deepEqual(files(p), before);
  assert.equal(read(p.current), `${V2}\n`);
});

test('a confirmed fallback whose smoke test fails stops with nothing activated and does not try the next one', async () => {
  const w = await installedTwice();
  const { p } = w;
  const PLANTED = '0.3.0';
  copyPackage(path.join(p.versionsDir, PLANTED), PLANTED);
  fs.rmSync(p.watchdog);
  const before = files(p);
  const s = smokeFailing(V2, PLANTED);
  const asked = [];
  let gated = 0;
  const r = await repair({
    ...w.common,
    run: fakeRun().run,
    smoke: s.smoke,
    confirm: (x) => (asked.push(x.fallback.version), true),
    gate: () => (gated++, true),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`${PLANTED.replaceAll('.', '\\.')}.*smoke test failed`));
  assert.match(r.reason, /nothing was activated/);
  assert.match(r.reason, /Run fence repair again/);
  assert.deepEqual(asked, [PLANTED], 'the next version is not offered silently');
  assert.deepEqual(s.calls, [V2, PLANTED], 'the older version was never built or smoke-tested');
  assert.equal(gated, 1);
  assert.deepEqual(files(p), before);
  assert.equal(read(p.current), `${V2}\n`);
});

test('with current missing, repair names the fallback it would activate and asks first', async () => {
  const w = await installedTwice();
  const { p } = w;
  fs.rmSync(p.current);
  const before = files(p);
  const named = [];
  const declined = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke, confirm: (s) => (named.push(s.fallback), false), gate: () => true });
  assert.equal(declined.ok, false);
  assert.equal(declined.declined, true);
  assert.equal(named[0].version, V2, 'the newest passing version');
  assert.equal(named[0].from, null, 'there is no current version');
  assert.deepEqual(files(p), before);
  // invalid contents count as missing
  fs.writeFileSync(p.current, 'not-a-version\n');
  const r = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke, confirm: () => true, gate: () => true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(read(p.current), `${V2}\n`);
});

test('the integrity confirmation says whether a usable current exists', async () => {
  const w = await installedTwice();
  mismatch(w);
  const seen = [];
  const confirm = (summary) => (seen.push(summary), false);
  await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke, confirm, gate: () => true });
  fs.writeFileSync(w.p.current, 'not-a-version\n');
  await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke, confirm, gate: () => true });
  fs.rmSync(w.p.current);
  await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke, confirm, gate: () => true });
  assert.deepEqual(seen.map((s) => s.currentUsable), [true, false, false]);
  assert.deepEqual(seen.map((s) => s.fallback), [null, null, null]);
});

test('repair reads and writes through the injected fs', async () => {
  const w = await installedTwice();
  const m = mismatch(w);
  const seen = [];
  const wrapped = new Proxy(fs, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === 'function' ? (...a) => (seen.push(`${String(prop)} ${String(a[0])}`), v.apply(target, a)) : v;
    },
  });
  const r = await repair({ ...w.common, fs: wrapped, run: fakeRun().run, smoke: smokeFailing().smoke, confirm: () => true, gate: () => true });
  assert.equal(r.ok, true, r.reason);
  const stamp = path.join(w.p.stateDir, 'verified', sha(m.raw));
  assert.ok(seen.includes(`writeFileSync ${stamp}`), 'the verified stamp is written through it');
  assert.ok(seen.some((c) => c.startsWith('mkdtempSync ')), 'the work directory is made through it');
  assert.ok(seen.includes(`existsSync ${path.join(w.p.versionsDir, V2, 'src', 'engine.mjs')}`), 'the engine is looked up through it');
  assert.ok(seen.includes(`readFileSync ${w.p.current}`), 'current is read through it');
});

test('after a mismatch it shows the diffs and clears only on confirmation', async () => {
  const w = await installedTwice();
  const m = mismatch(w);
  const events = [];
  const out = [];
  // a clock that jumps ten minutes per reading: the comparison has no deadline, so it still finishes
  let t = Date.now();
  const now = () => (t += 10 * 60 * 1000);
  const r = await repair({
    ...w.common,
    run: fakeRun().run,
    smoke: smokeFailing().smoke,
    now,
    io: { out: (l) => out.push(l) },
    confirm: (summary) => {
      events.push('confirm');
      assert.ok(summary.diffs.some((d) => d.kind === 'changed' && d.path === m.watched), 'the diffs reach the confirmation');
      assert.equal(fs.existsSync(m.marker), true, 'nothing is cleared before the confirmation');
      return true;
    },
    gate: () => {
      events.push('gate');
      return { ok: true };
    },
  });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(events, ['confirm', 'gate'], 'the sudo gate runs after the confirmation');
  assert.equal(r.integrity.cleared, true);
  assert.equal(r.integrity.timedOut, false);
  assert.ok(r.integrity.diffs.some((d) => d.kind === 'changed' && d.path === m.watched));
  // the differences were shown to the human
  assert.ok(out.some((l) => l.includes(`changed ${m.watched}`)), out.join('\n'));
  // cleared: the sticky marker is gone and the manifest's verified stamp (sha256 of its RAW bytes) exists
  assert.equal(fs.existsSync(m.marker), false);
  const stamp = path.join(w.p.stateDir, 'verified', sha(m.raw));
  assert.ok(fs.statSync(stamp).isFile());
  assert.ok(fs.statSync(stamp).ctimeMs > m.expiresMs, 'the stamp is newer than the manifest expiry');
  // integrity.json itself is root-owned and is not touched
  assert.equal(read(m.integrity), m.raw);
  // the reinstall happened too
  assert.equal(r.version, V2);
});

test('declining leaves the denial in place', async () => {
  const w = await installedTwice();
  fs.rmSync(w.p.watchdog);
  const m = mismatch(w);
  const before = files(w.p);
  let gated = 0;
  const f = fakeRun();
  const s = smokeFailing();
  for (const answer of [false, undefined, 'yes', 1]) {
    const r = await repair({
      ...w.common,
      run: f.run,
      smoke: s.smoke,
      confirm: () => answer,
      gate: () => {
        gated++;
        return { ok: true };
      },
    });
    assert.equal(r.ok, false, String(answer));
    assert.equal(r.integrity.cleared, false);
    assert.match(r.reason, /not confirmed/);
  }
  // without a confirmation step at all, the same
  const none = await repair({ ...w.common, run: f.run, smoke: s.smoke, gate: () => ({ ok: true }) });
  assert.equal(none.ok, false);
  assert.equal(gated, 0, 'the gate is not reached without a confirmation');
  assert.equal(fs.existsSync(m.marker), true);
  assert.equal(read(m.integrity), m.raw);
  assert.equal(fs.existsSync(path.join(w.p.stateDir, 'verified')), false, 'no stamp');
  assert.deepEqual(files(w.p), before, 'nothing was reinstalled');
  assert.equal(s.calls.length, 0);
  assert.deepEqual(f.calls, []);
});

test('the sudo gate is required to clear a mismatch', async () => {
  const w = await installedTwice();
  fs.rmSync(w.p.watchdog);
  const m = mismatch(w);
  const before = files(w.p);
  const f = fakeRun();
  const s = smokeFailing();
  const attempts = [
    { label: 'a refusing gate', gate: () => ({ ok: false, reason: 'sudo -v failed (exit 1)' }) },
    { label: 'a gate that throws', gate: () => { throw new Error('no tty'); } },
    { label: 'no gate', gate: undefined },
  ];
  for (const a of attempts) {
    const r = await repair({ ...w.common, run: f.run, smoke: s.smoke, confirm: () => true, gate: a.gate });
    assert.equal(r.ok, false, a.label);
    assert.equal(r.integrity.cleared, false, a.label);
    assert.match(r.reason, /sudo/, a.label);
    assert.equal(fs.existsSync(m.marker), true, a.label);
    assert.equal(fs.existsSync(path.join(w.p.stateDir, 'verified')), false, a.label);
  }
  assert.deepEqual(files(w.p), before, 'nothing was reinstalled either');
  assert.equal(s.calls.length, 0);

  // with a gate that answers true, the same call clears (a bare true is accepted)
  const r = await repair({ ...w.common, run: f.run, smoke: s.smoke, confirm: () => true, gate: () => true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.existsSync(m.marker), false);
});

test('a manifest that cannot be compared is removed only after confirmation and the gate', async () => {
  const w = await installedTwice();
  const m = mismatch(w, { manifestText: '{ not json\n' });
  const f = fakeRun();
  const out = [];
  const declined = await repair({ ...w.common, run: f.run, smoke: smokeFailing().smoke, confirm: () => false, gate: () => true, io: { out: (l) => out.push(l) } });
  assert.equal(declined.ok, false);
  assert.ok(out.some((l) => /does not parse/.test(l)), out.join('\n'));
  assert.equal(fs.existsSync(m.marker), true);
  assert.deepEqual(f.calls.filter((c) => c.cmd === SUDO), []);

  const r = await repair({ ...w.common, run: f.run, smoke: smokeFailing().smoke, confirm: () => true, gate: () => true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.integrity.cleared, true);
  // the root-owned integrity.json goes through sudo rm, by its absolute path from the command table
  const rm = f.calls.filter((c) => c.cmd === SUDO);
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].args, [COMMANDS.rm, '-f', m.integrity]);
  assert.equal(fs.existsSync(m.marker), false);
});

test('repair does not reinstall from a version directory the comparison found changed', async () => {
  const w = await installedTwice();
  // the manifest recorded the current engine file; it then changed
  const engine = path.join(w.p.versionsDir, V2, 'src', 'engine.mjs');
  const original = read(engine);
  const created = new Date(Date.now() - 3 * HOUR).toISOString();
  const expires = new Date(Date.now() - 2 * HOUR).toISOString();
  const raw = `${JSON.stringify({ version: 1, created, expires, files: { [engine]: sha(original) }, hookKeys: {}, repoRoots: [] })}\n`;
  fs.writeFileSync(path.join(w.admin, 'integrity.json'), raw);
  fs.mkdirSync(w.p.stateDir, { recursive: true });
  fs.writeFileSync(path.join(w.p.stateDir, 'needs-repair'), `integrity ${sha(raw)}\n`);
  fs.appendFileSync(engine, '// tampered\n');
  const s = smokeFailing();
  const asked = [];
  let gated = 0;
  const r = await repair({
    ...w.common,
    run: fakeRun().run,
    smoke: s.smoke,
    confirm: (summary) => (asked.push(summary.fallback?.version ?? null), true),
    gate: () => (gated++, true),
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, V1);
  assert.equal(r.skipped[0].version, V2);
  assert.match(r.skipped[0].reason, /changed since the hatch/);
  assert.deepEqual(s.calls, [V1], 'the changed version is never smoke-tested or installed');
  assert.deepEqual(asked, [null, V1], 'the integrity confirmation, then the fallback named');
  assert.equal(gated, 1, 'one sudo gate covers both confirmations');
});

test('with nothing pending, an unstamped but equal manifest is stamped and no confirmation is asked', async () => {
  const w = await installedTwice();
  const watched = path.join(newDir('watched'), 'a.txt');
  fs.writeFileSync(watched, 'same\n');
  const created = new Date(Date.now() - 3 * HOUR).toISOString();
  const expires = new Date(Date.now() - 2 * HOUR).toISOString();
  const raw = `${JSON.stringify({ version: 1, created, expires, files: { [watched]: sha('same\n') }, hookKeys: {}, repoRoots: [] })}\n`;
  fs.writeFileSync(path.join(w.admin, 'integrity.json'), raw);
  const r = await repair({ ...w.common, run: fakeRun().run, smoke: smokeFailing().smoke });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.integrity.pending, false);
  assert.ok(fs.statSync(path.join(w.p.stateDir, 'verified', sha(raw))).isFile());
});

test('repair needs an installed version and refuses a runner-less call', async () => {
  const home = newDir('home');
  const empty = await repair({ home, run: fakeRun().run, env: { PATH: '/usr/bin' }, nodePath: NODE, adminDir: newDir('admin'), probes: {}, sudoers: null, smoke: smokeFailing().smoke });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no installed version/);
  await assert.rejects(() => repair({ home }), /runner/);
});
