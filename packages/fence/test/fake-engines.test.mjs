// Failure acceptance with fake engines (test/acceptance/real-host): an engine that kills itself,
// sleeps past the budget or prints garbage must make the staged watchdog deny, and a missing
// launcher must make the PRE command exit 2 with the human message (spec, "Hook registrations" and
// "Watchdog").
//
// Hermetic: each test stages its own temp HOME (stageHome), state and admin directory; the only
// processes spawned are process.execPath through the staged trampoline (which execs the staged
// watchdog bundle, which spawns the fake engine) and /bin/sh for the PRE command. The admin
// directory is passed with --admin-dir so the machine's real one is never read.
//
// The sleep test bakes a SHORT engine deadline (1000 ms, module API only) into the staged bundle, so
// the 3000 ms production deadline does not decide the wall-clock bound of 3500 ms; the production
// deadline is asserted separately from the constant and from the default bundle's text. The short
// deadline is 1000 ms, not less: on a loaded machine Node alone needs 250 ms to start, and an
// engine killed before its first line never writes its pid, which would leave "no stray process"
// unproven.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { buildWatchdog } from '../src/build/bundle-watchdog.mjs';
import { fencePaths } from '../src/cli/paths.mjs';
import { PRE } from '../src/hosts/commands.mjs';
import { DEADLINE_MS } from '../src/watchdog.mjs';
import { installFake } from './acceptance/real-host/install-fake.mjs';
import { stageHome } from './acceptance/stage-home.mjs';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-fake-engines-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const STRICT = fileURLToPath(new URL('../policies/strict.json', import.meta.url));
const SPAWN_TIMEOUT_MS = 60_000;
const SHORT_DEADLINE_MS = 1000;
const WALL_CLOCK_BOUND_MS = 3500;
const REAP_POLL_MS = 50;
const REAP_BOUND_MS = 5000;
const PAYLOAD = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  cwd: TMP,
  session_id: 'fake-engines',
});
// the human message of the PRE command's launcher-failure branch (spec, "Hook registrations")
const PRE_MESSAGE = 'fence denied this call: its launcher failed or is missing. In your own terminal run: fence doctor (or install fence as its README says).';

let counter = 0;
// A fresh staged home. `deadlineMs` replaces the staged watchdog bundle with one that has a short
// engine deadline (buildWatchdog's module-API-only option).
function stage({ deadlineMs } = {}) {
  const dir = path.join(TMP, `s${counter++}`);
  const { home, watchdog } = stageHome(dir, { policyPath: STRICT });
  const admin = path.join(dir, 'admin');
  fs.mkdirSync(admin);
  if (deadlineMs !== undefined) {
    fs.writeFileSync(fencePaths(home).watchdogBundle, buildWatchdog({ nodePath: process.execPath, deadlineMs }), { mode: 0o644 });
  }
  return { home, watchdog, admin, paths: fencePaths(home) };
}

function runPre(s, host) {
  const t0 = Date.now();
  const r = spawnSync(s.watchdog, ['pre', '--host', host, '--admin-dir', s.admin], {
    input: PAYLOAD,
    encoding: 'utf8',
    env: { HOME: s.home, PATH: '/usr/bin:/bin' },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { ...r, elapsedMs: Date.now() - t0 };
}

// The deny shapes of the spec's output table; returns the reason.
function assertDeny(r, host) {
  assert.equal(r.error, undefined, String(r.error));
  if (host === 'claude') {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.endsWith('\n') && !r.stdout.slice(0, -1).includes('\n'), true, `one JSON line expected, got ${JSON.stringify(r.stdout)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
  }
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  return r.stderr;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('selfkill makes the watchdog deny', () => {
  for (const host of ['claude', 'codex']) {
    const s = stage();
    installFake(s.home, 'selfkill');
    const reason = assertDeny(runPre(s, host), host);
    assert.match(reason, /fence denied this call because it could not check it: its engine crashed \(signal SIGKILL\)\./);
    assert.match(reason, /fence repair/);
  }
});

test('garbage makes the watchdog deny', () => {
  for (const host of ['claude', 'codex']) {
    const s = stage();
    installFake(s.home, 'garbage');
    const reason = assertDeny(runPre(s, host), host);
    assert.match(reason, /its engine did not return a well-formed decision/);
    assert.match(reason, /fence repair/);
  }
});

test('sleep makes the watchdog deny within 3500 ms', async () => {
  for (const host of ['claude', 'codex']) {
    const s = stage({ deadlineMs: SHORT_DEADLINE_MS });
    installFake(s.home, 'sleep');
    const r = runPre(s, host);
    const reason = assertDeny(r, host);
    assert.match(reason, new RegExp(`its engine did not answer within ${SHORT_DEADLINE_MS} ms and was stopped`));
    assert.ok(r.elapsedMs < WALL_CLOCK_BOUND_MS, `the deny took ${r.elapsedMs} ms, expected under ${WALL_CLOCK_BOUND_MS} ms`);

    // the sleeping engine (30 s) was killed: its pid, which it wrote to the state directory, is gone
    const pidFile = path.join(s.paths.stateDir, 'fake-sleep.pid');
    assert.ok(fs.existsSync(pidFile), 'the fake sleep engine never started');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 1, `bad pid ${pid}`);
    const give = Date.now() + REAP_BOUND_MS;
    while (isAlive(pid) && Date.now() < give) await sleep(REAP_POLL_MS);
    assert.equal(isAlive(pid), false, `the sleeping engine (pid ${pid}) is still running`);
  }
});

test('the default watchdog deadline is 3000 ms, in the module and in the default bundle', () => {
  assert.equal(DEADLINE_MS, 3000);
  assert.match(buildWatchdog({ nodePath: process.execPath }), /^export const DEADLINE_MS = 3000;$/m);
  const s = stage();
  assert.match(fs.readFileSync(s.paths.watchdogBundle, 'utf8'), /^export const DEADLINE_MS = 3000;$/m);
});

test('remove-launcher makes the PRE command (imported from hosts/commands.mjs) exit 2 with the human message', () => {
  for (const host of ['claude', 'codex']) {
    const s = stage();
    assert.ok(fs.existsSync(s.paths.watchdog));
    installFake(s.home, 'remove-launcher');
    assert.equal(fs.existsSync(s.paths.watchdog), false);
    const r = spawnSync('/bin/sh', ['-c', PRE(host)], { input: PAYLOAD, encoding: 'utf8', env: { HOME: s.home, PATH: '/usr/bin:/bin' }, timeout: SPAWN_TIMEOUT_MS });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /fence denied this call: its launcher failed or is missing\./);
    assert.match(r.stderr, /fence doctor/);
    assert.ok(r.stderr.includes(PRE_MESSAGE), r.stderr);
  }
});

test('fake engines are installed at versions/<semver>/src/engine.mjs, by default under 0.0.0-fake', () => {
  const s = stage();
  const r = installFake(s.home, 'garbage');
  assert.equal(r.version, '0.0.0-fake');
  const engine = path.join(s.paths.versionsDir, '0.0.0-fake', 'src', 'engine.mjs');
  assert.equal(r.engine, engine);
  assert.equal(fs.readFileSync(engine, 'utf8'), fs.readFileSync(new URL('./acceptance/real-host/fake-engines/garbage.mjs', import.meta.url), 'utf8'));
  assert.equal(fs.readFileSync(s.paths.current, 'utf8'), '0.0.0-fake\n');

  // another semver directory, and `current` follows the last install
  const other = installFake(s.home, 'selfkill', { version: '2.3.4-fake.1' });
  assert.equal(other.engine, path.join(s.paths.versionsDir, '2.3.4-fake.1', 'src', 'engine.mjs'));
  assert.equal(fs.readFileSync(s.paths.current, 'utf8'), '2.3.4-fake.1\n');
  assert.ok(fs.existsSync(engine), 'the earlier fake stays installed');

  // a non-semver directory name (the watchdog would deny it) and an unknown kind are refused
  assert.throws(() => installFake(s.home, 'garbage', { version: 'fake' }), /semver/);
  assert.throws(() => installFake(s.home, 'garbage', { version: '../escape' }), /semver/);
  assert.throws(() => installFake(s.home, 'nope'), /unknown kind/);
});
