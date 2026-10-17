import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { main, hatchIsValid, DEADLINE_MS, STDIN_CAP } from '../src/watchdog.mjs';
import { compareManifest, parseIso, parseManifest, MAX_FILE_BYTES } from '../src/watchdog/integrity.mjs';
import { formatLine, TRUNCATED } from '../src/watchdog/line.mjs';
import { buildWatchdog } from '../src/build/bundle-watchdog.mjs';
import { renderSessionStart } from '../src/hosts/render.mjs';

// Hermetic: every install (fake HOME with .local/share/fence/{current,versions/<v>/src/engine.mjs}),
// state directory and admin directory lives in one temp root. The "engine" is a stub script written
// here and spawned by the watchdog with process.execPath; nothing else is ever executed. Root
// ownership is simulated by an injected lstat (io.lstat), never by touching real root-owned files.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-watchdog-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text = '', mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp', session_id: 's1' });
const UNDECIDED = { decision: 'undecided', rule: null, reason: "No fence rule decided this call; the host's normal permission flow applies.", scope: {} };
const DENY = { decision: 'deny', rule: 'credentials', reason: 'Credential files are never read or written by the agent. (fence rule "credentials")', scope: {} };
const SILENT = { stdout: '', stderr: '', exit: 0 };

// Stub engines. RECORD/PID are absolute paths baked into the stub source.
const ENGINES = {
  normal: (decision, record) =>
    `import fs from 'node:fs';\nconst input = fs.readFileSync(0);\n` +
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), bytes: input.length }));\n` +
    `process.stdout.write(${JSON.stringify(line(decision))});\n`,
  crash: () => `throw new Error('engine exploded');\n`,
  sleep: (pidFile) => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60000);\n`,
  garbage: () => `process.stdout.write('this is not a decision\\n');\n`,
  raw: (text) => `process.stdout.write(${JSON.stringify(text)});\n`,
  nonzero: () => `process.stdout.write(${JSON.stringify(line(UNDECIDED))});\nprocess.exitCode = 3;\n`,
  context: (text) =>
    `import fs from 'node:fs';\nfs.readFileSync(0);\nprocess.stdout.write(JSON.stringify({ additionalContext: ${JSON.stringify(text)} }) + '\\n');\n`,
};

// A fake install. `engine` is a function (record, pidFile) -> source, or null for no engine file.
function install({ engine = (record) => ENGINES.normal(UNDECIDED, record), current = '0.1.0\n' } = {}) {
  const home = dir();
  const share = path.join(home, '.local', 'share', 'fence');
  fs.mkdirSync(share, { recursive: true });
  const record = path.join(home, 'record.json');
  const pidFile = path.join(home, 'engine.pid');
  if (current !== null) write(path.join(share, 'current'), current);
  const version = typeof current === 'string' ? current.trim() : '0.1.0';
  if (engine !== null) write(path.join(share, 'versions', version, 'src', 'engine.mjs'), engine(record, pidFile));
  return { home, share, record, pidFile, state: dir(), admin: dir() };
}

const readRecord = (inst) => (fs.existsSync(inst.record) ? JSON.parse(fs.readFileSync(inst.record, 'utf8')) : null);

// A stat that claims a non-root owner for the listed files, so the root check is exercised even
// when the suite itself runs as root.
function userOwned(...files) {
  return (file) => {
    const st = fs.lstatSync(file);
    if (!files.includes(file)) return st;
    return { uid: 501, gid: 20, mode: st.mode & ~0o022, size: st.size, ino: st.ino, dev: st.dev, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs };
  };
}

// A stat that claims root ownership for the listed files (mode bits kept, minus group/world write).
function rootify(...files) {
  return (file) => {
    const st = fs.lstatSync(file);
    if (!files.includes(file)) return st;
    return { uid: 0, gid: 0, mode: st.mode & ~0o022, size: st.size, ino: st.ino, dev: st.dev, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs };
  };
}

function run(inst, argv, { stdin = Buffer.from(PAYLOAD), ...io } = {}) {
  return main([...argv, '--state-dir', inst.state, '--admin-dir', inst.admin], { stdin, env: { ...process.env, HOME: inst.home }, ...io });
}

// A deny for fence's own failure, Claude shape: one JSON line, exit 0, human text, no disable line.
function assertHumanDeny(r) {
  assert.equal(r.exit, 0);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, 'one JSON line');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assertNoDisableLine(reason);
  return reason;
}

function assertNoDisableLine(reason) {
  assert.match(reason, /fence repair/, 'names fence repair');
  assert.match(reason, /in your own terminal/);
  assert.match(reason, /fence hatch/, 'names the hatch as the last resort');
  assert.ok(reason.indexOf('fence repair') < reason.indexOf('fence hatch'), 'repair before the hatch');
  assert.doesNotMatch(reason, /\bsudo\b|\brm\s|--disable|FENCE_[A-Z_]*=|hatch\.json|uninstall|\bexport\s|chmod|`/);
  assert.doesNotMatch(reason, /fence hatch\s+(--|-|\d)/, 'the hatch is never given with pasteable arguments');
  assert.doesNotMatch(reason, /\n/, 'no separate command line to paste');
}

describe('HATCH', () => {
  const NOW = Date.parse('2026-10-17T12:00:00Z');
  const ROOT = { uid: 0, mode: 0o100644 };
  const hatch = (fields) => JSON.stringify(fields);
  const H = 3600 * 1000;

  test('valid hatch returns no-output and records', async () => {
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 60000), expires: iso(NOW + H) }), NOW), true);

    const inst = install({ engine: (record) => ENGINES.normal(DENY, record) });
    const file = path.join(inst.admin, 'hatch.json');
    write(file, hatch({ created: iso(Date.now() - 60000), expires: iso(Date.now() + H) }));
    for (const host of ['claude', 'codex']) {
      const r = await run(inst, ['pre', '--host', host], { lstat: rootify(file) });
      assert.deepEqual(r, SILENT, `${host}: the engine's deny is ignored under a hatch`);
      assert.ok(readRecord(inst).argv.includes('--record-only'), 'the engine ran in record-only mode');
    }
    const logs = fs.readdirSync(path.join(inst.state, 'log'));
    assert.equal(logs.length, 1);
    const lines = fs.readFileSync(path.join(inst.state, 'log', logs[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 2 && lines.every((l) => l.decision === 'hatch'));
    assert.ok(lines.every((l) => !('raw' in l) && !('command' in l)), 'hatch lines carry no raw or command text');
  });

  test('malformed JSON is no hatch', () => {
    assert.equal(hatchIsValid(ROOT, '{"created": "2026-10-17T11:00:00Z", "expires":', NOW), false);
    assert.equal(hatchIsValid(ROOT, '[]', NOW), false);
    assert.equal(hatchIsValid(ROOT, '', NOW), false);
  });

  test('missing expires is no hatch', () => {
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 60000) }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 60000), expires: 'tomorrow' }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 60000), expires: NOW + H }), NOW), false, 'a number is not an ISO timestamp');
  });

  test('expired is no hatch', () => {
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 2 * H), expires: iso(NOW - 1) }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - 2 * H), expires: iso(NOW) }), NOW), false, 'expires must be after now');
  });

  test('created in the future beyond skew is no hatch', () => {
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW + 60001), expires: iso(NOW + 2 * H) }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW + 60000), expires: iso(NOW + 2 * H) }), NOW), true, '60 s of skew is allowed');
  });

  test('lifetime over 8 h is no hatch', () => {
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - H), expires: iso(NOW + 7 * H + 1) }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - H), expires: iso(NOW + 7 * H) }), NOW), true, 'exactly 8 h is allowed');
  });

  test('non-root owner is no hatch', async () => {
    assert.equal(hatchIsValid({ uid: 501, mode: 0o100644 }, hatch({ created: iso(NOW - 60000), expires: iso(NOW + H) }), NOW), false);
    // Through main with an lstat reporting a non-root owner: the hatch file is ignored.
    const inst = install({ engine: (record) => ENGINES.normal(DENY, record) });
    const file = path.join(inst.admin, 'hatch.json');
    write(file, hatch({ created: iso(Date.now() - 60000), expires: iso(Date.now() + H) }));
    const r = await run(inst, ['pre', '--host', 'claude'], { lstat: userOwned(file) });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, DENY.reason);
    assert.ok(!readRecord(inst).argv.includes('--record-only'));
  });

  test('impossible or over-precise timestamps are no hatch', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-10-17T24:00:00Z', '2026-10-17T12:00:00.1234Z', '2026-13-01T00:00:00Z', '2026-10-17T12:60:00Z', '2026-10-17T12:00:60Z', '2026-10-17T12:00:00+24:00', '2025-02-29T00:00:00Z']) {
      assert.ok(Number.isNaN(parseIso(bad)), bad);
    }
    for (const good of ['2026-10-17T12:00:00.123Z', '2024-02-29T00:00:00Z', '2026-10-17T12:00Z', '2026-10-17T17:30:00+05:30', '2026-10-17T07:00:00-05:00']) {
      assert.equal(parseIso(good), Date.parse(good), good);
    }
    assert.equal(hatchIsValid(ROOT, hatch({ created: '2026-02-30T00:00:00Z', expires: iso(NOW + H) }), NOW), false);
    assert.equal(hatchIsValid(ROOT, hatch({ created: iso(NOW - H), expires: '2026-10-17T24:00:00Z' }), NOW), false);
  });

  test('group-writable file is no hatch', () => {
    const text = hatch({ created: iso(NOW - 60000), expires: iso(NOW + H) });
    assert.equal(hatchIsValid({ uid: 0, mode: 0o100664 }, text, NOW), false);
    assert.equal(hatchIsValid({ uid: 0, mode: 0o100646 }, text, NOW), false, 'world-writable too');
    assert.equal(hatchIsValid({ uid: 0, mode: 0o120644 }, text, NOW), false, 'a symlink is not a regular file');
  });
});

describe('STDIN', () => {
  const chunks = (total) => {
    const parts = [];
    for (let left = total; left > 0; left -= 1024 * 1024) parts.push(Buffer.alloc(Math.min(left, 1024 * 1024), 0x20));
    return parts;
  };

  test('exactly 8 MiB passes the cap', async () => {
    assert.equal(STDIN_CAP, 8 * 1024 * 1024);
    const inst = install();
    const r = await run(inst, ['pre', '--host', 'claude'], { stdin: Readable.from(chunks(STDIN_CAP)) });
    assert.deepEqual(r, SILENT);
    assert.equal(readRecord(inst).bytes, STDIN_CAP, 'the engine got the whole payload');
  });

  test('8 MiB + 1 denies', async () => {
    const inst = install();
    const r = await run(inst, ['pre', '--host', 'claude'], { stdin: Readable.from(chunks(STDIN_CAP + 1)) });
    assert.match(assertHumanDeny(r), /8 MiB/);
    const b = await run(inst, ['pre', '--host', 'claude'], { stdin: Buffer.alloc(STDIN_CAP + 1, 0x20) });
    assertHumanDeny(b);
    assert.equal(readRecord(inst), null, 'the engine never ran');
  });
});

describe('FAILURE', () => {
  test('engine crash', async () => {
    const inst = install({ engine: ENGINES.crash });
    assert.match(assertHumanDeny(await run(inst, ['pre', '--host', 'claude'])), /engine/);
  });

  test('engine timeout (kills it, denies within 3000 ms total)', async () => {
    assert.equal(DEADLINE_MS, 3000);
    const inst = install({ engine: (record, pidFile) => ENGINES.sleep(pidFile) });
    const t0 = Date.now();
    const r = await run(inst, ['pre', '--host', 'claude'], { deadlineMs: 800 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `denied after ${elapsed} ms`);
    assert.match(assertHumanDeny(r), /within/);
    const pid = Number(fs.readFileSync(inst.pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the engine was killed');
  });

  test('garbage stdout', async () => {
    assertHumanDeny(await run(install({ engine: ENGINES.garbage }), ['pre', '--host', 'claude']));
    // JSON that is not one well-formed canonical decision is garbage too.
    for (const text of ['{"decision":"allow"}\n', line({ ...UNDECIDED, decision: 'maybe' }), line(UNDECIDED) + line(UNDECIDED), '', '[]\n']) {
      assertHumanDeny(await run(install({ engine: () => ENGINES.raw(text) }), ['pre', '--host', 'claude']));
    }
  });

  test('non-zero exit with a decision on stdout', async () => {
    assertHumanDeny(await run(install({ engine: ENGINES.nonzero }), ['pre', '--host', 'claude']));
  });

  test('non-semver current', async () => {
    for (const current of ['latest\n', '../0.1.0\n', '0.1\n', '']) {
      const inst = install({ current });
      assert.match(assertHumanDeny(await run(inst, ['pre', '--host', 'claude'])), /version/, JSON.stringify(current));
      assert.equal(readRecord(inst), null);
    }
    assertHumanDeny(await run(install({ current: null }), ['pre', '--host', 'claude']));
  });

  test('missing engine', async () => {
    assert.match(assertHumanDeny(await run(install({ engine: null }), ['pre', '--host', 'claude'])), /engine/);
  });
});

describe('INTEGRITY', () => {
  const H = 3600 * 1000;
  // A tracked file, a manifest whose hatch expired a minute ago, and an injected root-owned lstat.
  function setup({ expires = Date.now() - 60000, files = 1 } = {}) {
    const inst = install();
    const repo = dir();
    const tracked = [];
    for (let i = 0; i < files; i++) {
      const f = path.join(repo, `settings-${i}.json`);
      write(f, `{"hooks":${i}}\n`);
      tracked.push(f);
    }
    const settings = path.join(repo, 'hooks.json');
    write(settings, JSON.stringify({ hooks: { PreToolUse: ['x'] }, other: 1 }));
    const manifest = {
      version: 1,
      created: iso(expires - H),
      expires: iso(expires),
      files: Object.fromEntries(tracked.map((f) => [f, sha(fs.readFileSync(f))])),
      hookKeys: { [settings]: { hooks: sha(JSON.stringify({ PreToolUse: ['x'] })) } },
      repoRoots: [repo],
    };
    const file = path.join(inst.admin, 'integrity.json');
    write(file, JSON.stringify(manifest));
    const stamp = path.join(inst.state, 'verified', sha(fs.readFileSync(file)));
    return { inst, tracked, settings, manifest, file, stamp, lstat: rootify(file) };
  }

  test('mismatch denies until repair', async () => {
    const s = setup();
    write(s.tracked[0], '{"hooks":"changed"}\n');
    const first = assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }));
    assert.match(first, /changed/);
    const marker = path.join(s.inst.state, 'needs-repair');
    const text = fs.readFileSync(marker, 'utf8');
    assert.ok(text.includes(sha(fs.readFileSync(s.file))), 'the marker names the integrity sha');
    assert.ok(text.includes(`changed ${s.tracked[0]}`), 'the marker summarizes the diffs');
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }));
    assert.equal(fs.existsSync(s.stamp), false, 'no stamp on a mismatch');
    assert.equal(readRecord(s.inst), null, 'the engine never ran');
    // fence repair (human, sudo) clears the marker and writes the stamp after confirmation.
    fs.rmSync(marker);
    write(s.stamp, 'repaired\n', 0o600);
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT);
  });

  test('the needs-repair marker denies every later pre without comparing', async () => {
    const s = setup();
    write(s.tracked[0], '{"hooks":"changed"}\n');
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }));
    const marker = path.join(s.inst.state, 'needs-repair');
    assert.equal(fs.existsSync(marker), true, 'marker written on mismatch');
    // The files are back and the manifest is gone: nothing could be compared, yet the deny sticks.
    write(s.tracked[0], '{"hooks":0}\n');
    fs.rmSync(s.file);
    let reads = 0;
    const counting = { ...fs, openSync: (...a) => (reads++, fs.openSync(...a)), readFileSync: (...a) => (reads++, fs.readFileSync(...a)) };
    for (const host of ['claude', 'codex']) {
      const r = await run(s.inst, ['pre', '--host', host], { lstat: s.lstat, fs: counting });
      if (host === 'claude') assert.match(assertHumanDeny(r), /fence repair has not cleared it/);
      else {
        assert.equal(r.exit, 2);
        assertNoDisableLine(r.stderr);
      }
    }
    assert.equal(reads, 0, 'no file was read: with no hatch the marker denies before the integrity step');
    assert.equal(readRecord(s.inst), null);
    // Marker absent: the normal flow runs again.
    fs.rmSync(marker);
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT);
    assert.equal(readRecord(s.inst).bytes, PAYLOAD.length);
  });

  test('a valid hatch wins over the needs-repair marker', async () => {
    const s = setup();
    const marker = path.join(s.inst.state, 'needs-repair');
    write(marker, 'integrity x\nchanged /somewhere\n', 0o600);
    const hatchFile = path.join(s.inst.admin, 'hatch.json');
    write(hatchFile, JSON.stringify({ created: iso(Date.now() - 60000), expires: iso(Date.now() + 3600000) }));
    const both = rootify(s.file, hatchFile);
    // Marker present + valid hatch: enforcement is off, the engine runs record-only, no output.
    for (const host of ['claude', 'codex']) {
      assert.deepEqual(await run(s.inst, ['pre', '--host', host], { lstat: both }), SILENT, host);
      assert.ok(readRecord(s.inst).argv.includes('--record-only'));
    }
    assert.equal(fs.existsSync(marker), true, 'the hatch does not clear the marker');
    // Marker present + no hatch (the hatch file is not root-owned): deny.
    fs.rmSync(s.inst.record);
    assert.match(assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat })), /fence repair has not cleared it/);
    assert.equal(readRecord(s.inst), null);
    // Marker absent: unchanged normal flow (clean comparison, engine runs without --record-only).
    fs.rmSync(marker);
    fs.rmSync(hatchFile);
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT);
    assert.ok(!readRecord(s.inst).argv.includes('--record-only'));
  });

  test('a hook key change is a mismatch', async () => {
    const s = setup();
    write(s.settings, JSON.stringify({ hooks: {}, other: 1 }));
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }));
  });

  test('a stamp with ctime before expires is rejected', async () => {
    // The hatch "expires" an hour from the real clock; the watchdog's clock is two hours ahead, so the
    // hatch has expired for it, and a stamp written now has a ctime before that expiry.
    const s = setup({ expires: Date.now() + H });
    write(s.stamp, 'stale\n', 0o600);
    write(s.tracked[0], '{"hooks":"changed"}\n');
    const now = () => Date.now() + 2 * H;
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat, now }));
  });

  test('a clean comparison writes a stamp and later calls skip it', async () => {
    const s = setup();
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT);
    assert.equal(fs.existsSync(s.stamp), true, 'the stamp was written');
    write(s.tracked[0], '{"hooks":"changed later"}\n');
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT, 'a valid stamp skips the comparison');
  });

  test('a manifest that is not root-owned or does not parse denies', async () => {
    const s = setup();
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: userOwned(s.file) }));
    write(s.file, '{"version":1');
    assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }));
  });

  test('exceeding the deadline during comparison denies', async () => {
    let t = Date.now();
    const clock = () => (t += 100);
    const s = setup({ files: 40 });
    const direct = compareManifest(parseManifest(fs.readFileSync(s.file, 'utf8')), { now: clock, deadlineAt: t + 1000, fs });
    assert.equal(direct.timedOut, true);
    assert.equal(direct.equal, false);

    t = Date.now();
    const r = await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat, now: clock });
    assert.match(assertHumanDeny(r), /within/);
    assert.equal(fs.existsSync(s.stamp), false);
    assert.match(fs.readFileSync(path.join(s.inst.state, 'needs-repair'), 'utf8'), /deadline/, 'an overrun is sticky too');
  });

  test('a listed path that is not a regular file is unreadable and never opened', async () => {
    const s = setup({ files: 2 });
    const fifo = s.tracked[1];
    const opened = [];
    const fake = {
      ...fs,
      lstatSync: (p, ...a) => (p === fifo ? { mode: 0o010644, size: 0, isFile: () => false } : fs.lstatSync(p, ...a)),
      openSync: (p, ...a) => (opened.push(p), fs.openSync(p, ...a)),
      readFileSync: (p, ...a) => {
        if (p === fifo) throw new Error('the FIFO was read');
        return fs.readFileSync(p, ...a);
      },
    };
    const r = compareManifest(parseManifest(fs.readFileSync(s.file, 'utf8')), { now: () => 0, deadlineAt: 1, fs: fake });
    assert.equal(r.equal, false);
    assert.equal(r.timedOut, false);
    assert.deepEqual(r.diffs, [{ path: fifo, kind: 'unreadable' }]);
    assert.ok(!opened.includes(fifo), 'never opened');
    assert.ok(opened.includes(s.tracked[0]), 'regular files are still compared');
    // Through main (default code path, io.fs): the comparison fails, the call is denied.
    assert.match(assertHumanDeny(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat, fs: fake })), /changed after the last hatch/);
    assert.ok(!opened.includes(fifo));
  });

  test('a listed file over 16 MiB is unreadable and never opened', () => {
    assert.equal(MAX_FILE_BYTES, 16 * 1024 * 1024);
    const s = setup();
    const big = s.tracked[0];
    const opened = [];
    const fake = {
      ...fs,
      lstatSync: (p, ...a) => {
        const st = fs.lstatSync(p, ...a);
        return p === big ? { mode: st.mode, size: MAX_FILE_BYTES + 1, isFile: () => true } : st;
      },
      openSync: (p, ...a) => (opened.push(p), fs.openSync(p, ...a)),
    };
    const r = compareManifest(parseManifest(fs.readFileSync(s.file, 'utf8')), { now: () => 0, deadlineAt: 1, fs: fake });
    assert.deepEqual(r.diffs, [{ path: big, kind: 'unreadable' }]);
    assert.ok(!opened.includes(big));
  });

  test('a chunked read stops at the deadline', () => {
    const s = setup();
    const f = s.tracked[0];
    write(f, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const manifest = { ...parseManifest(fs.readFileSync(s.file, 'utf8')), hookKeys: {}, files: { [f]: sha(fs.readFileSync(f)) } };
    let t = 0;
    let reads = 0;
    const fake = { ...fs, readSync: (...a) => (reads++, fs.readSync(...a)) };
    // Clock checks: before the file (100), before chunk 1 (200), before chunk 2 (300 >= deadline).
    const r = compareManifest(manifest, { now: () => (t += 100), deadlineAt: 250, fs: fake });
    assert.equal(r.timedOut, true);
    assert.equal(r.equal, false);
    assert.equal(reads, 1, 'stopped between chunks');
    assert.equal(compareManifest(manifest, { fs }).equal, true, 'the same file compares equal without a deadline');
  });

  test('the stamp name is the sha256 of the raw bytes of integrity.json', async () => {
    const s = setup();
    // A byte that is not UTF-8 inside a string: the text decodes to U+FFFD, so a text hash would differ.
    const text = JSON.stringify({ ...s.manifest, repoRoots: [`${s.manifest.repoRoots[0]}/X`] });
    const raw = Buffer.from(text, 'utf8');
    raw[raw.indexOf('/X"') + 1] = 0xff;
    write(s.file, raw);
    assert.deepEqual(await run(s.inst, ['pre', '--host', 'claude'], { lstat: s.lstat }), SILENT);
    assert.equal(fs.existsSync(path.join(s.inst.state, 'verified', sha(raw))), true);
    assert.equal(fs.existsSync(path.join(s.inst.state, 'verified', sha(raw.toString('utf8')))), false);
  });
});

describe('HOSTS', () => {
  test('claude deny output shape', async () => {
    const r = await run(install({ engine: null }), ['pre', '--host', 'claude']);
    assertHumanDeny(r);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout).hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    // A policy deny from the engine is rendered with its own reason.
    const p = await run(install({ engine: (record) => ENGINES.normal(DENY, record) }), ['pre', '--host', 'claude']);
    assert.deepEqual(p, { stdout: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY.reason } }), stderr: '', exit: 0 });
  });

  test('codex deny exits 2', async () => {
    const r = await run(install({ engine: null }), ['pre', '--host', 'codex']);
    assert.equal(r.exit, 2);
    assert.equal(r.stdout, '');
    assertNoDisableLine(r.stderr);
    const p = await run(install({ engine: (record) => ENGINES.normal(DENY, record) }), ['pre', '--host', 'codex']);
    assert.deepEqual(p, { stdout: '', stderr: DENY.reason, exit: 2 });
  });
});

describe('EVENTS', () => {
  const failing = [() => install({ engine: ENGINES.crash }), () => install({ engine: ENGINES.garbage }), () => install({ engine: null }), () => install({ current: 'latest' })];

  test('post and precompact failures print nothing and exit 0', async () => {
    for (const event of ['post', 'precompact']) {
      for (const host of ['claude', 'codex']) {
        for (const make of failing) assert.deepEqual(await run(make(), [event, '--host', host]), SILENT, `${event} ${host}`);
        assert.deepEqual(await run(install({ engine: (record, pidFile) => ENGINES.sleep(pidFile) }), [event, '--host', host], { deadlineMs: 300 }), SILENT);
      }
    }
  });

  test('session-start success renders additionalContext through the bundled watchdog', () => {
    const inst = install({ engine: () => ENGINES.context('fence is on: policy default') });
    const bundle = buildWatchdog({ nodePath: process.execPath });
    assert.equal(bundle.split('\n')[0], `#!${process.execPath}`, 'the install-time Node path is on the first line');
    const specs = [...bundle.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const spec of specs) assert.ok(['node:fs', 'node:path', 'node:child_process', 'node:crypto'].includes(spec), `bundle imports ${spec}`);
    assert.doesNotMatch(bundle, /\bimport\s*\(|\brequire\s*\(/);
    const hook = path.join(inst.home, '.local', 'bin', 'fence-hook');
    write(hook, bundle, 0o755);

    for (const host of ['claude', 'codex']) {
      const r = spawnSync(process.execPath, [hook, 'session-start', '--host', host, '--state-dir', inst.state, '--admin-dir', inst.admin], {
        input: '{"hook_event_name":"SessionStart"}',
        env: { ...process.env, HOME: inst.home },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, renderSessionStart(host, 'fence is on: policy default').stdout);
    }

    // The same bundle fails closed on pre when the engine is missing (Codex: stderr + exit 2).
    fs.rmSync(path.join(inst.share, 'versions'), { recursive: true });
    const d = spawnSync(process.execPath, [hook, 'pre', '--host', 'codex', '--state-dir', inst.state, '--admin-dir', inst.admin], {
      input: PAYLOAD,
      env: { ...process.env, HOME: inst.home },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(d.status, 2);
    assert.equal(d.stdout, '');
    assertNoDisableLine(d.stderr);
  });

  test('session-start failure prints nothing and exits 0', async () => {
    for (const host of ['claude', 'codex']) {
      for (const make of failing) assert.deepEqual(await run(make(), ['session-start', '--host', host]), SILENT, host);
    }
  });
});

describe('LINE', () => {
  test('formatLine caps a line at 4096 bytes with the truncation marker', () => {
    const small = formatLine({ ts: 't', decision: 'deny' });
    assert.equal(small, '{"ts":"t","decision":"deny"}\n');
    const big = formatLine({ ts: 't', decision: 'deny', reason: 'é'.repeat(5000), rule: 'r' });
    assert.ok(Buffer.byteLength(big) <= 4096, `${Buffer.byteLength(big)} bytes`);
    assert.ok(big.endsWith('\n'));
    const v = JSON.parse(big);
    assert.equal(v.ts, 't');
    assert.ok(v.reason.endsWith(TRUNCATED));
    assert.ok(Buffer.byteLength(formatLine({ a: 'x'.repeat(300) }, 128)) <= 128);
  });
});
