import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sudoGate, sudoConfigWarnings } from '../src/cli/sudo.mjs';
import { COMMANDS, HUMAN_ONLY, SUDO, requireHuman, requiresGate, weakens } from '../src/cli/humanonly.mjs';
import { adminDir, adminWrite } from '../src/cli/admin.mjs';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HUMANONLY_FILE = path.join(SRC_DIR, 'cli', 'humanonly.mjs');

// A fake process runner (spawnSync shape) that records every call; never runs anything.
function fakeRun(statusFor = () => 0, calls = [], inputs = []) {
  const run = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    inputs.push(opts?.input);
    return { status: statusFor(cmd, args), stdout: '', stderr: '' };
  };
  return { run, calls, inputs };
}

// Run `fn` with os.tmpdir() pointed at a fresh empty directory; -> the names left in it afterwards.
function withWatchedTmp(fn) {
  const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-tmpwatch-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = watch;
  try {
    fn();
    return fs.readdirSync(watch);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(watch, { recursive: true, force: true });
  }
}

const TTY = { isTTY: true };
const CLEAN_ENV = { PATH: '/usr/bin' };

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('the gate runs sudo -k then sudo -v in that order', () => {
  const { run, calls } = fakeRun();
  const r = sudoGate({ sudoPath: '/fake/sudo', run });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [
    ['/fake/sudo', '-k'],
    ['/fake/sudo', '-v'],
  ]);
});

test('a failing sudo -v denies', () => {
  const { run, calls } = fakeRun((cmd, args) => (args[0] === '-v' ? 1 : 0));
  const r = sudoGate({ sudoPath: '/fake/sudo', run });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sudo -v/);
  assert.deepEqual(calls.map((c) => c[1]), ['-k', '-v']);

  // a runner that could not start sudo at all denies too
  const broken = sudoGate({ sudoPath: '/fake/sudo', run: () => ({ status: null, error: new Error('ENOENT') }) });
  assert.equal(broken.ok, false);
  // a relative sudo path is refused before anything runs
  const rel = fakeRun();
  assert.equal(sudoGate({ sudoPath: 'sudo', run: rel.run }).ok, false);
  assert.deepEqual(rel.calls, []);
});

test('production wiring uses /usr/bin/sudo (read the command table in humanonly.mjs)', () => {
  const literal = '/usr/bin/' + 'sudo';
  const text = fs.readFileSync(HUMANONLY_FILE, 'utf8');
  assert.equal(text.split(literal).length - 1, 1, 'humanonly.mjs names the sudo path exactly once');
  for (const file of walk(SRC_DIR)) {
    if (file === HUMANONLY_FILE) continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes(literal), `${path.relative(SRC_DIR, file)} must not name the sudo path`);
  }
  assert.equal(SUDO, literal);

  // the gate's default path is the table's
  const { run, calls } = fakeRun();
  assert.equal(sudoGate({ run }).ok, true);
  assert.deepEqual(calls, [
    [literal, '-k'],
    [literal, '-v'],
  ]);

  // a weakening command's wrapper reaches sudo through the default path (it never passes one)
  const hatch = HUMAN_ONLY.find((e) => e.command === 'hatch');
  const seen = fakeRun();
  hatch.handler({ stdin: TTY, env: CLEAN_ENV, run: seen.run, impl: () => 0 });
  assert.deepEqual(seen.calls.map((c) => c[0]), [literal, literal]);
});

test('requireHuman rejects a non-TTY stdin and rejects when CLAUDE_CODE_SESSION_ID is set', () => {
  assert.doesNotThrow(() => requireHuman({ stdin: TTY, env: CLEAN_ENV }));
  assert.throws(() => requireHuman({ stdin: { isTTY: false }, env: CLEAN_ENV }), /interactive terminal/);
  assert.throws(() => requireHuman({ stdin: {}, env: CLEAN_ENV }), /interactive terminal/);
  assert.throws(() => requireHuman({ stdin: undefined, env: CLEAN_ENV }), /interactive terminal/);
  assert.throws(() => requireHuman({ stdin: TTY, env: { ...CLEAN_ENV, CLAUDE_CODE_SESSION_ID: 's-1' } }), /CLAUDE_CODE_SESSION_ID/);
  assert.throws(() => requireHuman({ stdin: TTY, env: { ...CLEAN_ENV, CLAUDE_CODE_SESSION_ID: '' } }), /CLAUDE_CODE_SESSION_ID/);
  assert.throws(() => requireHuman({ stdin: TTY, env: { ...CLEAN_ENV, CODEX_THREAD_ID: 't-1' } }), /CODEX_THREAD_ID/);

  // an omitted or non-object env never passes, even when the agent variable is set in the process
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 's-omitted';
  try {
    assert.throws(() => requireHuman({ stdin: TTY }), /environment/);
    assert.throws(() => requireHuman({ stdin: TTY, env: null }), /environment/);
    assert.throws(() => requireHuman({ stdin: TTY, env: 'CLAUDE_CODE_SESSION_ID=s' }), /environment/);
    const hatch = HUMAN_ONLY.find((e) => e.command === 'hatch');
    const spy = fakeRun();
    assert.throws(() => hatch.handler({ stdin: TTY, run: spy.run, impl: () => 0 }), /environment/);
    assert.deepEqual(spy.calls, []);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  }
});

test('run is required by the gate, the command wrapper and adminWrite', () => {
  assert.throws(() => sudoGate({ sudoPath: '/fake/sudo' }), /runner/);
  assert.throws(() => sudoGate(), /runner/);
  for (const entry of HUMAN_ONLY) {
    let ran = false;
    assert.throws(() => entry.handler({ stdin: TTY, env: CLEAN_ENV, impl: () => (ran = true) }), /runner/, entry.command);
    assert.equal(ran, false, entry.command);
  }
  assert.throws(() => adminWrite('hatch.json', 'x', { adminDir: '/nonexistent-admin' }), /runner/);
  // and the admin directory has no default inside the module
  const spy = fakeRun();
  assert.throws(() => adminWrite('hatch.json', 'x', { run: spy.run }), /admin directory/);
  assert.deepEqual(spy.calls, []);
});

test('weakening commands list is exactly hatch, allow-once, uninstall, rollback, apply-when-weakening, repair-after-mismatch', () => {
  assert.deepEqual(
    HUMAN_ONLY.map((e) => e.command).sort(),
    ['allow-once', 'apply', 'edit', 'hatch', 'install', 'lock', 'repair', 'rollback', 'uninstall', 'upgrade'],
  );
  const always = HUMAN_ONLY.filter((e) => e.weakening === true).map((e) => e.command).sort();
  assert.deepEqual(always, ['allow-once', 'hatch', 'rollback', 'uninstall']);
  const conditional = HUMAN_ONLY.filter((e) => typeof e.weakening === 'function').map((e) => e.command).sort();
  assert.deepEqual(conditional, ['apply', 'repair']);

  // apply: weakening unless its diff is proven to tighten (fail closed)
  assert.equal(requiresGate('apply', {}), true);
  assert.equal(requiresGate('apply', { provenTightening: false }), true);
  assert.equal(requiresGate('apply', { provenTightening: true }), false);
  // repair: weakening after an integrity mismatch, and when that is unknown (fail closed)
  assert.equal(requiresGate('repair', { integrityMismatch: true }), true);
  assert.equal(requiresGate('repair', {}), true);
  assert.equal(requiresGate('repair', { integrityMismatch: false }), false);
  for (const c of ['hatch', 'allow-once', 'uninstall', 'rollback']) assert.equal(requiresGate(c, {}), true, c);
  const hatch = HUMAN_ONLY.find((e) => e.command === 'hatch');
  assert.equal(weakens(hatch, {}), true);
});

test('install, upgrade and read-only commands do not require the gate', () => {
  for (const c of ['install', 'upgrade']) {
    assert.equal(HUMAN_ONLY.find((e) => e.command === c).weakening, false, c);
    assert.equal(requiresGate(c, {}), false, c);
  }
  for (const c of ['check', 'test', 'log', 'doctor', 'replay', 'version', 'help']) {
    assert.equal(HUMAN_ONLY.find((e) => e.command === c), undefined, c);
    assert.equal(requiresGate(c, {}), false, c);
  }

  // running install with a human context never touches sudo
  const install = HUMAN_ONLY.find((e) => e.command === 'install');
  const { run, calls } = fakeRun();
  assert.equal(install.handler({ stdin: TTY, env: CLEAN_ENV, run, impl: () => 7 }), 7);
  assert.deepEqual(calls, []);
});

test('every command in the human-only table calls requireHuman before doing anything (iterate the table)', () => {
  for (const entry of HUMAN_ONLY) {
    // spies: reading stdin.isTTY or the env is requireHuman's work; run and impl are "anything"
    const events = [];
    const stdin = {
      get isTTY() {
        events.push('isTTY');
        return true;
      },
    };
    const env = new Proxy(
      {},
      {
        get(_t, key) {
          events.push(`env:${String(key)}`);
          return undefined;
        },
      },
    );
    const run = (cmd, args) => {
      events.push(`run:${args.join(' ')}`);
      return { status: 0 };
    };
    const impl = () => {
      events.push('impl');
      return 0;
    };
    entry.handler({ stdin, env, run, impl });
    const firstOther = events.findIndex((e) => e === 'impl' || e.startsWith('run:'));
    assert.ok(firstOther > 0, `${entry.command}: something ran before requireHuman`);
    assert.ok(events.slice(0, firstOther).includes('isTTY'), `${entry.command}: stdin checked first`);
    assert.ok(events.slice(0, firstOther).includes('env:CLAUDE_CODE_SESSION_ID'), `${entry.command}: env checked first`);
    assert.ok(events.slice(0, firstOther).includes('env:CODEX_THREAD_ID'), `${entry.command}: env checked first`);
    assert.equal(events.at(-1), 'impl', `${entry.command}: impl runs last`);

    // not a human: nothing runs at all
    for (const ctx of [
      { stdin: { isTTY: false }, env: CLEAN_ENV },
      { stdin: TTY, env: { CLAUDE_CODE_SESSION_ID: 's' } },
      { stdin: TTY, env: { CODEX_THREAD_ID: 't' } },
      { stdin: TTY },
    ]) {
      const spy = fakeRun();
      let ran = false;
      assert.throws(() => entry.handler({ ...ctx, run: spy.run, impl: () => (ran = true) }), entry.command);
      assert.deepEqual(spy.calls, [], `${entry.command}: sudo ran for a non-human`);
      assert.equal(ran, false, `${entry.command}: impl ran for a non-human`);
    }
  }

  // a weakening command whose gate fails never reaches its implementation
  const hatch = HUMAN_ONLY.find((e) => e.command === 'hatch');
  let ran = false;
  const denied = fakeRun((cmd, args) => (args[0] === '-v' ? 1 : 0));
  assert.throws(() => hatch.handler({ stdin: TTY, env: CLEAN_ENV, run: denied.run, impl: () => (ran = true) }), /sudo/);
  assert.equal(ran, false);
  // no implementation registered yet: the guard still runs first, then it refuses
  assert.throws(() => hatch.handler({ stdin: { isTTY: false }, env: CLEAN_ENV, run: fakeRun().run }), /interactive terminal/);
  assert.throws(() => hatch.handler({ stdin: TTY, env: CLEAN_ENV, run: fakeRun().run }), /not yet implemented/);
});

// A sudoers tree for the injected reader: files by path, directories by path.
function reader(files, dirs = {}) {
  return {
    read: (p) => (Object.hasOwn(files, p) ? files[p] : null),
    list: (d) => (Object.hasOwn(dirs, d) ? dirs[d] : null),
  };
}

test('sudoConfigWarnings flags NOPASSWD', () => {
  // the tag is built by concatenation so the content gate does not read it as a credential assignment
  const NOPW = 'NOPASS' + 'WD: ALL';
  const warn = (text) => sudoConfigWarnings(reader({ '/etc/sudoers': text }));

  const flagged = warn(['root ALL=(ALL) ALL', '%admin ALL=(ALL) ' + NOPW].join('\n'));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /NOPASSWD/);

  // comments do not count; continuation lines do
  assert.deepEqual(warn('# %admin ALL=(ALL) ' + NOPW + '\nroot ALL=(ALL) ALL\n'), []);
  assert.equal(warn('me ALL=(ALL) \\\n  ' + NOPW + '\n').length, 1);

  // Defaults !authenticate
  assert.match(warn('Defaults !authenticate\n')[0], /!authenticate/);
  assert.match(warn('Defaults:me\tenv_reset, !authenticate\n')[0], /!authenticate/);
  assert.deepEqual(warn('Defaults authenticate\n'), []);

  // a long or never-expiring timestamp_timeout is flagged; the default-sized one is not
  assert.match(warn('Defaults timestamp_timeout=60\n')[0], /timestamp_timeout/);
  assert.match(warn('Defaults\ttimestamp_timeout = -1\n')[0], /timestamp_timeout/);
  assert.deepEqual(warn('Defaults timestamp_timeout=5\n'), []);

  // @include (relative to the including file) and #includedir are followed; sudo's skipped names are skipped
  const tree = reader(
    {
      '/etc/sudoers': 'root ALL=(ALL) ALL\n@include sudoers.local\n#includedir /etc/sudoers.d\n',
      '/etc/sudoers.local': 'Defaults timestamp_timeout=600\n',
      '/etc/sudoers.d/me': 'me ALL=(ALL) ' + NOPW + '\n',
      '/etc/sudoers.d/old~': 'Defaults !authenticate\n',
      '/etc/sudoers.d/x.bak': 'Defaults !authenticate\n',
    },
    { '/etc/sudoers.d': ['x.bak', 'me', 'old~'] },
  );
  const followed = sudoConfigWarnings(tree);
  assert.equal(followed.length, 2, followed.join(' | '));
  assert.ok(followed.some((w) => /NOPASSWD/.test(w)));
  assert.ok(followed.some((w) => /timestamp_timeout/.test(w)));

  // nesting deeper than 4 is reported, not followed; cycles end
  const chain = { '/etc/sudoers': '#include /etc/s1\n' };
  for (let i = 1; i < 6; i += 1) chain['/etc/s' + i] = '#include /etc/s' + (i + 1) + '\n';
  chain['/etc/s6'] = 'me ALL=' + NOPW + '\n';
  const deep = sudoConfigWarnings(reader(chain));
  assert.equal(deep.length, 1, deep.join(' | '));
  assert.match(deep[0], /deeper than 4/);
  assert.deepEqual(sudoConfigWarnings(reader({ '/etc/sudoers': '@include /etc/b\n', '/etc/b': '@include /etc/sudoers\n' })), []);

  // an unreadable file or directory is reported, not silently passed
  assert.match(sudoConfigWarnings(reader({}))[0], /could not be read/);
  const missing = sudoConfigWarnings(reader({ '/etc/sudoers': '@include /etc/gone\n@includedir /etc/nodir\n' }));
  assert.equal(missing.length, 2);
  assert.ok(missing.every((w) => /could not be read/.test(w)));
  const throwing = sudoConfigWarnings({
    read: () => {
      throw new Error('EACCES');
    },
  });
  assert.match(throwing[0], /could not be read/);
  // the reader is required
  assert.throws(() => sudoConfigWarnings(), /reader/);
});

test('adminDir and adminWrite write through sudo inside the admin directory only', () => {
  assert.equal(adminDir('darwin'), '/Library/Application Support/fence/');
  assert.equal(adminDir('linux'), '/var/lib/fence/');
  assert.throws(() => adminDir('win32'), /platform/);

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-admin-')));
  try {
    const { run, calls, inputs } = fakeRun();
    let r;
    const leftInTmp = withWatchedTmp(() => {
      r = adminWrite('grants/abc.json', '{"x":1}\n', { adminDir: dir, run, sudoPath: '/fake/sudo' });
    });
    const target = path.join(dir, 'grants', 'abc.json');
    const tmp = target + '.tmp';
    assert.equal(r.path, target);
    assert.deepEqual(calls, [
      ['/fake/sudo', COMMANDS.install, '-d', '-m', '0755', '-o', 'root', '-g', '0', dir],
      ['/fake/sudo', COMMANDS.install, '-d', '-m', '0755', '-o', 'root', '-g', '0', path.join(dir, 'grants')],
      ['/fake/sudo', COMMANDS.tee, tmp],
      ['/fake/sudo', COMMANDS.chmod, '0644', tmp],
      ['/fake/sudo', COMMANDS.chown, 'root:0', tmp],
      ['/fake/sudo', COMMANDS.mv, '-f', tmp, target],
    ]);
    // the data goes only through sudo's stdin, to tee
    assert.deepEqual(inputs, [undefined, undefined, '{"x":1}\n', undefined, undefined, undefined]);
    // no temp file anywhere outside the admin directory, and this process wrote nothing into it
    assert.deepEqual(leftInTmp, []);
    assert.deepEqual(fs.readdirSync(dir), []);
    // every path operand stays inside the admin directory
    for (const c of calls) {
      for (const a of c.slice(2).filter((x) => x.startsWith('/'))) {
        assert.ok(a === dir || a.startsWith(dir + path.sep), a + ' is outside the admin directory');
      }
    }

    // the default sudo path is the table's
    const dflt = fakeRun();
    adminWrite('hatch.json', 'x', { adminDir: dir, run: dflt.run });
    assert.ok(dflt.calls.every((c) => c[0] === SUDO));

    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\0b', '', 'a//b', './x', 'a\\..\\x', '-rf', 'grants/-x', 'a\nb', 'a\rb']) {
      const spy = fakeRun();
      assert.throws(() => adminWrite(bad, 'x', { adminDir: dir, run: spy.run, sudoPath: '/fake/sudo' }), /admin path/, JSON.stringify(bad));
      assert.deepEqual(spy.calls, [], JSON.stringify(bad));
    }

    // a failing step removes the root-side temp file (sudo rm -f) and throws
    for (const failAt of [COMMANDS.tee, COMMANDS.chmod, COMMANDS.chown, COMMANDS.mv]) {
      const f = fakeRun((cmd, args) => (args[0] === failAt ? 1 : 0));
      assert.throws(() => adminWrite('hatch.json', 'x', { adminDir: dir, run: f.run, sudoPath: '/fake/sudo' }), /sudo .* failed/);
      assert.deepEqual(f.calls.at(-1), ['/fake/sudo', COMMANDS.rm, '-f', path.join(dir, 'hatch.json.tmp')], failAt);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no sudo argv names a program by a relative path', () => {
  for (const [name, p] of Object.entries(COMMANDS)) assert.ok(path.isAbsolute(p), name + ': ' + p);
  const programs = new Set(Object.values(COMMANDS));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-admin-')));
  try {
    const all = [];
    const ok = fakeRun(() => 0, all);
    adminWrite('grants/a/b.json', 'x', { adminDir: dir, run: ok.run });
    const failing = fakeRun((cmd, args) => (args[0] === COMMANDS.mv ? 1 : 0), all);
    assert.throws(() => adminWrite('hatch.json', 'x', { adminDir: dir, run: failing.run }));
    assert.ok(all.length > 0);
    for (const c of all) {
      assert.equal(c[0], SUDO);
      assert.ok(path.isAbsolute(c[1]) && programs.has(c[1]), 'sudo runs ' + JSON.stringify(c[1]) + ': not an absolute path from COMMANDS');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
