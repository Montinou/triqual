import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(ROOT, 'bin', 'triqual-hook');
const FORWARDER = join(ROOT, 'bin', `${BRAND.legacy.launcher}-forwarder`);
const BASH = '/bin/bash'; // absolute: the child's PATH is under test
// A PATH that finds this node and the base tools (date, mkdir, wc, mv), and nothing from the test's HOME.
const TOOLS_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

const stateDir = (home) => join(home, '.local', 'state', BRAND.dir);
const legacyStateDir = (home) => join(home, '.local', 'state', BRAND.legacy.dir);
const shimPath = (home) => join(home, '.local', 'bin', BRAND.cliFile);

function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triqual-hook-home-')));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeShim(home, body) {
  mkdirSync(dirname(shimPath(home)), { recursive: true });
  writeFileSync(shimPath(home), body);
}

function launch(home, args, { path = TOOLS_PATH, input = '' } = {}) {
  const env = { HOME: home, PATH: path };
  return spawnSync(BASH, [LAUNCHER, ...args], { env, input, encoding: 'utf8' });
}

const ECHO_SHIM = "process.stdout.write(process.argv.slice(2).join(' ') + '\\n');\nprocess.stdin.pipe(process.stdout);\n";

test('line 2 of bin/triqual-hook is BRAND.ownership.launcher', () => {
  assert.equal(readFileSync(LAUNCHER, 'utf8').split('\n')[1], BRAND.ownership.launcher);
});

// The launcher's PATH line. Tests that must hide node run a copy with only this line changed.
const PREPEND = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
const BASE_PATH = '/usr/bin:/bin'; // mkdir, date, wc and mv, so the launcher gets as far as the node step

test('the PATH prepend comes before the first tool call', () => {
  const lines = readFileSync(LAUNCHER, 'utf8').split('\n');
  const at = lines.indexOf(PREPEND);
  assert.ok(at > 0, 'PATH line missing');
  assert.ok(at < lines.findIndex((line) => /^\s*mkdir /.test(line)), `PATH line ${at + 1} is after mkdir`);
});

test('exits 0 silently when node is missing', (t) => {
  // node often lives in /opt/homebrew/bin or /usr/local/bin, which the launcher prepends, so this runs a copy whose
  // PATH line prepends only $HOME/.local/bin (empty in the temp HOME). node is then unfindable unless it is in
  // /usr/bin or /bin; hook.log holding bash's not-found line proves the node step ran and failed.
  if (BASE_PATH.split(':').some((dir) => existsSync(join(dir, 'node')))) {
    t.skip('node is installed in /usr/bin or /bin, so it cannot be hidden from the launcher');
    return;
  }
  withHome((home) => {
    const source = readFileSync(LAUNCHER, 'utf8');
    assert.equal(source.split('\n').filter((line) => line === PREPEND).length, 1);
    const copy = join(home, BRAND.launcher);
    writeFileSync(copy, source.replace(PREPEND, 'export PATH="$HOME/.local/bin:$PATH"'));
    const r = spawnSync(BASH, [copy, 'stop', '--harness', 'codex'], {
      env: { HOME: home, PATH: BASE_PATH }, input: '{}', encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.match(readFileSync(join(stateDir(home), 'hook.log'), 'utf8'), /node: command not found/);
  });
});

test('still runs node when the state dir cannot be written', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root writes through mode 0555');
    return;
  }
  withHome((home) => {
    fakeShim(home, "process.stdout.write('RAN\\n');\n");
    const parent = dirname(stateDir(home));
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      const r = launch(home, ['stop', '--harness', 'codex']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'RAN\n');
      assert.equal(r.stderr, '');
      assert.equal(existsSync(stateDir(home)), false);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

test('exits 0 silently when triqual.mjs is missing', () => {
  withHome((home) => {
    const r = launch(home, ['stop', '--harness', 'codex'], { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});

test('passes stdin and stdout through', () => {
  withHome((home) => {
    fakeShim(home, ECHO_SHIM);
    const input = '{"hook_event_name":"Stop","cwd":"/tmp"}\n';
    const r = launch(home, ['stop', '--harness', 'codex'], { input });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `hook stop --harness codex\n${input}`);
    assert.equal(r.stderr, '');
  });
});

test('swallows a non-zero shim exit', () => {
  withHome((home) => {
    fakeShim(home, "process.stderr.write('shim failed: hook unresolved\\n');\nprocess.exit(3);\n");
    const r = launch(home, ['stop', '--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(readFileSync(join(stateDir(home), 'hook.log'), 'utf8').includes('shim failed: hook unresolved\n'));
  });
});

test('writes the last-run stamp', () => {
  withHome((home) => {
    fakeShim(home, '');
    const r = launch(home, ['session-start', '--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    const stamp = readFileSync(join(stateDir(home), 'last-run-codex'), 'utf8');
    assert.ok(stamp.endsWith('\n'), JSON.stringify(stamp));
    assert.match(stamp.slice(0, -1), /^\d{4}-\d\d-\d\dT.*Z session-start$/);
  });
});

test('writes no stamp without --harness', () => {
  withHome((home) => {
    fakeShim(home, '');
    const r = launch(home, ['session-start']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const stamps = existsSync(stateDir(home)) ? readdirSync(stateDir(home)).filter((f) => f.startsWith('last-run')) : [];
    assert.deepEqual(stamps, []);
  });
});

test('writes no stamp for a harness id outside [A-Za-z0-9_-]', () => {
  withHome((home) => {
    fakeShim(home, '');
    // A last-run- dir lets `last-run-/../../x` resolve to <home>/.local/state/x, outside the state dir.
    mkdirSync(join(stateDir(home), 'last-run-'), { recursive: true });
    for (const id of ['../x', '/../../x']) {
      const r = launch(home, ['stop', '--harness', id]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(readdirSync(dirname(stateDir(home))), [BRAND.dir]);
    assert.deepEqual(readdirSync(stateDir(home)).filter((f) => f.startsWith('last-run')), ['last-run-']);
    assert.deepEqual(readdirSync(join(stateDir(home), 'last-run-')), []);
  });
});

test('writes no stamp when the event is an option', () => {
  withHome((home) => {
    fakeShim(home, '');
    const r = launch(home, ['--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(stateDir(home), 'last-run-codex')), false);
  });
});

test('rotates hook.log past 1 MiB', () => {
  withHome((home) => {
    fakeShim(home, "process.stderr.write('after rotation\\n');\n");
    mkdirSync(stateDir(home), { recursive: true });
    const big = 'x'.repeat(1_048_577);
    writeFileSync(join(stateDir(home), 'hook.log'), big);
    const r = launch(home, ['stop', '--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(join(stateDir(home), 'hook.log.1')).size, 1_048_577);
    assert.equal(readFileSync(join(stateDir(home), 'hook.log.1'), 'utf8'), big);
    assert.equal(readFileSync(join(stateDir(home), 'hook.log'), 'utf8'), 'after rotation\n');
  });
});

test('keeps hook.log at exactly 1 MiB', () => {
  withHome((home) => {
    fakeShim(home, "process.stderr.write('appended\\n');\n");
    mkdirSync(stateDir(home), { recursive: true });
    writeFileSync(join(stateDir(home), 'hook.log'), 'x'.repeat(1_048_576));
    const r = launch(home, ['stop', '--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(stateDir(home), 'hook.log.1')), false);
    assert.equal(statSync(join(stateDir(home), 'hook.log')).size, 1_048_576 + 'appended\n'.length);
  });
});

test('launcher stamps last-run under the legacy state dir when only it exists, else under triqual', () => {
  // Only the legacy dir: the stamp and hook.log go there, and no triqual dir is created.
  withHome((home) => {
    fakeShim(home, "process.stderr.write('logged\\n');\n");
    mkdirSync(legacyStateDir(home), { recursive: true });
    const r = launch(home, ['stop', '--harness', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(legacyStateDir(home), 'last-run-codex'), 'utf8'), /^\d{4}-\d\d-\d\dT.*Z stop\n$/);
    assert.equal(readFileSync(join(legacyStateDir(home), 'hook.log'), 'utf8'), 'logged\n');
    assert.equal(existsSync(stateDir(home)), false);
  });
  // Neither dir: triqual is created. Both: triqual wins and the legacy dir is left alone.
  for (const both of [false, true]) {
    withHome((home) => {
      fakeShim(home, '');
      if (both) for (const dir of [stateDir(home), legacyStateDir(home)]) mkdirSync(dir, { recursive: true });
      const r = launch(home, ['stop', '--harness', 'codex']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(join(stateDir(home), 'last-run-codex'), 'utf8'), /^\d{4}-\d\d-\d\dT.*Z stop\n$/);
      if (both) assert.deepEqual(readdirSync(legacyStateDir(home)), []);
      else assert.equal(existsSync(legacyStateDir(home)), false);
    });
  }
});

// ---- the forwarder from the legacy launcher name (installed under BRAND.legacy.launcher for one release) ----

const forward = (home, args, input = '') => spawnSync(BASH, [FORWARDER, ...args], {
  env: { HOME: home, PATH: TOOLS_PATH }, input, encoding: 'utf8',
});

test(`line 2 of bin/${BRAND.legacy.launcher}-forwarder is BRAND.ownership.forwarder`, () => {
  assert.equal(readFileSync(FORWARDER, 'utf8').split('\n')[1], BRAND.ownership.forwarder);
});

test('forwarder without triqual-hook exits 0 with empty stdout', () => {
  withHome((home) => {
    let r = forward(home, ['stop', '--harness', 'codex'], '{}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    // Present but not executable counts as missing.
    const launcher = join(home, '.local', 'bin', BRAND.launcher);
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\necho ran\n', { mode: 0o644 });
    r = forward(home, ['stop', '--harness', 'codex'], '{}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  });
});

test('forwarder runs triqual-hook with its args, stdin and exit code', () => {
  withHome((home) => {
    const launcher = join(home, '.local', 'bin', BRAND.launcher);
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\necho "args: $*"\ncat\nexit 4\n', { mode: 0o755 });
    const r = forward(home, ['session-start', '--harness', 'codex'], '{"a":1}\n');
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stdout, 'args: session-start --harness codex\n{"a":1}\n');
  });
});
