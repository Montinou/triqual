import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runEngine } from '../src/engine.mjs';
import { loadGrants } from '../src/eval/grants.mjs';
import { readGitPin } from '../src/resolve/gitpin.mjs';
import { isCaseInsensitive } from '../src/resolve/paths.mjs';

// Hermetic: one realpath'd temp root (macOS: /var -> /private/var) holding a fake HOME, the policy
// copies, the state and admin directories and hand-built repositories. The engine is spawned with
// process.execPath and HOME set to the fake home; nothing in the payloads is ever executed.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-engine-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const ENGINE = fileURLToPath(new URL('../src/engine.mjs', import.meta.url));
const MINI = fileURLToPath(new URL('./fixtures/policy-strict-mini.json', import.meta.url));
const SHA = 'c'.repeat(40);
let counter = 0;

function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A repository built by hand (no git binary): HEAD on `branch`, branches main and feature.
function makeRepo({ branch = 'main', claudeDir = false } = {}) {
  const root = dir();
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  write(path.join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
  write(path.join(git, 'config'), '[core]\n\tbare = false\n');
  for (const b of ['main', 'feature']) write(path.join(git, 'refs', 'heads', b), `${SHA}\n`);
  if (claudeDir) fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}

// Fresh policy/state/admin directories for one engine run.
function dirs(policyText) {
  const base = dir();
  const policy = path.join(base, 'policy.json');
  fs.writeFileSync(policy, policyText ?? fs.readFileSync(MINI, 'utf8'));
  const state = path.join(base, 'state');
  const admin = path.join(base, 'admin');
  fs.mkdirSync(state);
  fs.mkdirSync(admin);
  return { policy, state, admin };
}

function claudePayload(tool_name, tool_input, cwd, more = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    cwd,
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: 'toolu_01',
    ...more,
  };
}

function codexPayload(tool_name, tool_input, cwd) {
  return { hook_event_name: 'PreToolUse', session_id: 'sess-1', turn_id: 'turn-1', cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: 'call_01' };
}

// Spawns the engine; returns the parsed decision (and asserts the process contract: exit 0, one JSON line).
function spawnEngine(payload, { host = 'claude', d = dirs(), extraArgs = [], env = {}, event = 'pre' } = {}) {
  const args = [ENGINE, event, '--host', host, '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin, ...extraArgs];
  const r = spawnSync(process.execPath, args, {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, `engine exit ${r.status}; stderr: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1, `expected one stdout line, got ${JSON.stringify(r.stdout)}`);
  return JSON.parse(lines[0]);
}

function bash(command, cwd, opts) {
  return spawnEngine(claudePayload('Bash', { command }, cwd), opts);
}

test('deny on rm -rf outside the repo under the mini fixture policy', () => {
  const repo = makeRepo({ branch: 'feature' });
  const outside = path.join(dir(), 'victim');
  const d = bash(`rm -rf ${outside}`, repo);
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'delete-outside-repo');
  assert.match(d.reason, /outside the current repository/);
  assert.ok(Array.isArray(d.scope.deletes) && d.scope.deletes.length > 0, JSON.stringify(d.scope));
});

test('undecided for npm test', () => {
  const repo = makeRepo({ branch: 'feature' });
  const d = bash('npm test', repo);
  assert.equal(d.decision, 'undecided', JSON.stringify(d));
  assert.equal(d.rule, null);
});

test('opaque for curl x | sh with the construct named', () => {
  const repo = makeRepo({ branch: 'feature' });
  const d = bash('curl x | sh', repo);
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:opaque');
  assert.match(d.reason, /stdin-interpreter/);
});

test('protected branch commit denies on main', () => {
  const repo = makeRepo({ branch: 'main' });
  const d = bash('git commit -m wip', repo);
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:protected-branch');
  assert.match(d.reason, /"main"/);
  const off = bash('git commit -m wip', makeRepo({ branch: 'feature' }));
  assert.notEqual(off.decision, 'deny', JSON.stringify(off));
});

test('file write on main is allowed unless denyFileWrites', () => {
  const repo = makeRepo({ branch: 'main' });
  const target = path.join(repo, 'src', 'a.txt');
  const payload = claudePayload('Write', { file_path: target, content: 'ok' }, repo);
  const plain = spawnEngine(payload);
  assert.equal(plain.decision, 'undecided', JSON.stringify(plain));
  assert.deepEqual(plain.scope.writes, [target]);

  const strict = JSON.parse(fs.readFileSync(MINI, 'utf8'));
  strict.branches.denyFileWrites = true;
  const denied = spawnEngine(payload, { d: dirs(JSON.stringify(strict)) });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.rule, 'builtin:protected-branch');
  assert.match(denied.reason, /denyFileWrites/);
});

test('a Write to ~/.claude/settings.json denies as builtin', () => {
  const repo = makeRepo({ branch: 'feature' });
  const d = spawnEngine(claudePayload('Write', { file_path: path.join(HOME, '.claude', 'settings.json'), content: '{}' }, repo));
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:self-protection');
  // the `~/` spelling is expanded against the engine's HOME and denied the same way
  const tilde = spawnEngine(claudePayload('Write', { file_path: '~/.claude/settings.json', content: '{}' }, repo));
  assert.equal(tilde.decision, 'deny');
  assert.equal(tilde.rule, 'builtin:self-protection');
});

// ---- grants (in-process, isRootOwned stubbed) --------------------------------------------------

const NOW = Date.parse('2026-10-17T12:00:00Z');

function writeGrant(admin, target, { expires = new Date(NOW + 5 * 60 * 1000).toISOString(), name = 'g1.json' } = {}) {
  const file = path.join(admin, 'grants', name);
  write(file, JSON.stringify({ path: target, expires }));
  return file;
}

// The pinned hook environment for in-process runs: no FENCE_PROFILE, the fake HOME.
const PINNED_ENV = Object.freeze({ PATH: process.env.PATH, HOME });

function inProcess(payload, d, opts = {}) {
  const argv = ['pre', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state, '--admin-dir', d.admin];
  const r = runEngine(argv, { stdin: JSON.stringify(payload), now: NOW, env: PINNED_ENV, ...opts });
  assert.equal(r.exit, 0);
  return JSON.parse(r.stdout);
}

// HOME (read by os.homedir()) and FENCE_PROFILE pinned for the in-process engine, restored after.
function withHome(fn) {
  const saved = { HOME: process.env.HOME, FENCE_PROFILE: process.env.FENCE_PROFILE };
  process.env.HOME = HOME;
  delete process.env.FENCE_PROFILE;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a grant is ignored when the final decision is deny (isRootOwned stubbed true)', () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const target = path.join(HOME, '.claude', 'settings.json');
    writeGrant(d.admin, target);
    const isRootOwned = () => true;

    // The write itself is granted, but the same call fetches from the network: the policy denies it,
    // and the grant is not consumed.
    const denied = inProcess(claudePayload('Bash', { command: `echo x > ${target}; curl https://example.com` }, repo), d, { isRootOwned });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.rule, 'network-fetch');
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 1, 'the grant must still be unused');

    // Control: the same grant on a plain write allows it once and is then used up.
    const allowed = inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d, { isRootOwned });
    assert.equal(allowed.decision, 'allow', JSON.stringify(allowed));
    assert.equal(allowed.rule, 'grant');
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 0);
    const again = inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d, { isRootOwned });
    assert.equal(again.decision, 'deny');
    assert.equal(again.rule, 'builtin:self-protection');
  });
});

test('with the real ownership check a non-root grant file is rejected', { skip: process.getuid?.() === 0 ? 'running as root' : false }, () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const target = path.join(HOME, '.claude', 'settings.json');
    writeGrant(d.admin, target);
    assert.deepEqual(loadGrants(d.admin, d.state, NOW), []);
    const r = inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d);
    assert.equal(r.decision, 'deny');
    assert.equal(r.rule, 'builtin:self-protection');
  });
});

// ---- load errors, modes, hosts ------------------------------------------------------------------

test('a load error denies everything with the error named', () => {
  const repo = makeRepo({ branch: 'feature' });
  const d = dirs('{"version": 1, "version": 1}');
  for (const payload of [claudePayload('Bash', { command: 'ls' }, repo), claudePayload('Read', { file_path: path.join(repo, 'README.md') }, repo)]) {
    const r = spawnEngine(payload, { d });
    assert.equal(r.decision, 'deny');
    assert.equal(r.rule, 'builtin:policy-load');
    assert.match(r.reason, /duplicate-key/);
  }
  const missing = dirs();
  fs.rmSync(missing.policy);
  const r = spawnEngine(claudePayload('Bash', { command: 'ls' }, repo), { d: missing });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /read/);
});

test('--record-only still returns a decision', () => {
  const repo = makeRepo({ branch: 'feature' });
  const outside = path.join(dir(), 'victim');
  const d = bash(`rm -rf ${outside}`, repo, { extraArgs: ['--record-only'] });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'delete-outside-repo');
});

test('a Codex apply_patch touching a protected path denies', () => {
  const repo = makeRepo({ branch: 'feature' });
  const envelope = ['*** Begin Patch', '*** Add File: .claude/settings.json', '+{}', '*** End Patch'].join('\n');
  const d = spawnEngine(codexPayload('apply_patch', { command: envelope }, repo), { host: 'codex' });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:self-protection');
  // the heredoc form inside a shell call is judged the same way (patch paths plus the shell text)
  const shell = spawnEngine(codexPayload('shell', { command: ['bash', '-lc', `apply_patch <<'EOF'\n${envelope}\nEOF`] }, repo), { host: 'codex' });
  assert.equal(shell.decision, 'deny');
  assert.equal(shell.rule, 'builtin:self-protection');
});

test('a relative path with no cwd is opaque', () => {
  const payload = claudePayload('Read', { file_path: 'notes.txt' }, undefined);
  delete payload.cwd;
  const d = spawnEngine(payload);
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:opaque');
  assert.match(d.reason, /missing-cwd/);
});

test('a missing git.json makes git checkout opaque in a repo tracking .claude/', () => {
  assert.equal(readGitPin(path.join(HOME, '.local', 'share', 'fence')), null);
  const repo = makeRepo({ branch: 'feature', claudeDir: true });
  const d = bash('git checkout main', repo);
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:opaque');
  assert.match(d.reason, /git-tree-update/);
  // a pin older than 2.45.1 is no better
  const share = dir();
  write(path.join(share, 'git.json'), JSON.stringify({ path: '/usr/bin/git', version: '2.39.0' }));
  assert.deepEqual(readGitPin(share), { path: '/usr/bin/git', version: '2.39.0' });
});

test('an unknown FENCE_PROFILE denies', () => {
  const repo = makeRepo({ branch: 'feature' });
  const d = bash('ls', repo, { env: { FENCE_PROFILE: 'nightly' } });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:unknown-profile');
  assert.match(d.reason, /nightly/);
});

test('an unknown event on pre denies with the event named', () => {
  const repo = makeRepo({ branch: 'feature' });
  const missing = claudePayload('Bash', { command: 'ls' }, repo);
  delete missing.hook_event_name;
  const d = spawnEngine(missing);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /"unknown"/);
  const post = spawnEngine(claudePayload('Bash', { command: 'ls' }, repo, { hook_event_name: 'PostToolUse' }));
  assert.equal(post.decision, 'deny');
  assert.match(post.reason, /PostToolUse/);
});

test('post, precompact and session-start are stubs returning {}', () => {
  const repo = makeRepo({ branch: 'feature' });
  for (const event of ['post', 'precompact', 'session-start']) {
    assert.deepEqual(spawnEngine(claudePayload('Bash', { command: 'ls' }, repo), { event }), {});
  }
});

// ---- fix round 1 --------------------------------------------------------------------------------

const asNonRoot = { skip: process.getuid?.() === 0 ? 'running as root' : false };

test('an unwritable state dir denies a granted write (the grant cannot be reserved)', asNonRoot, () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const target = path.join(HOME, '.claude', 'settings.json');
    writeGrant(d.admin, target);
    fs.chmodSync(d.state, 0o500);
    try {
      const r = inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d, { isRootOwned: () => true });
      assert.equal(r.decision, 'deny');
      assert.equal(r.rule, 'builtin:self-protection');
      assert.match(r.reason, /could not be reserved/);
      assert.match(r.reason, /EACCES/);
    } finally {
      fs.chmodSync(d.state, 0o700);
    }
  });
});

test('a grant already reserved by a parallel hook (EEXIST) denies', () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const target = path.join(HOME, '.claude', 'settings.json');
    writeGrant(d.admin, target);
    const isRootOwned = () => true;
    const [g] = loadGrants(d.admin, d.state, NOW, { isRootOwned });
    // the parallel hook's marker lands between this engine's load and its reservation
    const slowFs = { ...fs, writeFileSync: (file, data, opts) => {
      if (String(file).includes('grants-used')) fs.writeFileSync(path.join(d.state, 'grants-used', g.sha), 'parallel\n');
      return fs.writeFileSync(file, data, opts);
    } };
    const r = inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d, { isRootOwned, fs: slowFs });
    assert.equal(r.decision, 'deny');
    assert.equal(r.rule, 'builtin:self-protection');
    assert.match(r.reason, /EEXIST/);
  });
});

test('two grants on one path: one is consumed per allowed call', () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const target = path.join(HOME, '.claude', 'settings.json');
    writeGrant(d.admin, target, { name: 'a.json' });
    writeGrant(d.admin, target, { name: 'b.json', expires: new Date(NOW + 4 * 60 * 1000).toISOString() });
    const isRootOwned = () => true;
    const write = () => inProcess(claudePayload('Write', { file_path: target, content: '{}' }, repo), d, { isRootOwned });
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 2);
    assert.equal(write().rule, 'grant');
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 1);
    assert.equal(write().rule, 'grant');
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 0);
    assert.equal(write().rule, 'builtin:self-protection');
  });
});

test('a grant that lifted nothing is not consumed', () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const d = dirs();
    const plain = path.join(repo, 'notes.txt'); // not protected: no deny for a grant to lift
    writeGrant(d.admin, plain);
    const isRootOwned = () => true;
    const r = inProcess(claudePayload('Write', { file_path: plain, content: 'ok' }, repo), d, { isRootOwned });
    assert.equal(r.decision, 'undecided');
    assert.equal(loadGrants(d.admin, d.state, NOW, { isRootOwned }).length, 1);
  });
});

// A home of its own (with an optional git.json pin) for the pin tests.
function pinnedHome(pin) {
  const home = dir();
  if (pin) write(path.join(home, '.local', 'share', 'fence', 'git.json'), JSON.stringify(pin));
  return home;
}

test('the git pin is wired: an old pin makes git checkout opaque through the engine', () => {
  const home = pinnedHome({ path: '/usr/bin/git', version: '2.39.0' });
  const repo = makeRepo({ branch: 'feature', claudeDir: true });
  const d = bash('git checkout main', repo, { env: { HOME: home } });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'builtin:opaque');
  assert.match(d.reason, /git-tree-update/);
});

test('the git pin is wired: a recorded pin runs the check through the pinned binary', () => {
  // The "git" is a node script written into the temp tree: it records its argv and lists nothing.
  const log = path.join(dir(), 'fake-git.log');
  const fake = path.join(dir(), 'fake-git');
  write(fake, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const home = pinnedHome({ path: fake, version: '2.46.0' });
  const repo = makeRepo({ branch: 'feature', claudeDir: true });
  const d = bash('git checkout main', repo, { env: { HOME: home } });
  assert.equal(d.decision, 'undecided', JSON.stringify(d));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('diff') && calls[0].includes('HEAD') && calls[0].includes('main'), JSON.stringify(calls[0]));
  assert.ok(calls[0].includes(repo), JSON.stringify(calls[0]));
});

test('a symlink to a protected path inside the temp tree is denied through the engine', () => {
  const repo = makeRepo({ branch: 'feature' });
  const settings = path.join(HOME, '.claude', 'settings.json');
  write(settings, '{}');
  const link = path.join(repo, 'link.json');
  fs.symlinkSync(settings, link);
  const viaWrite = spawnEngine(claudePayload('Write', { file_path: link, content: '{}' }, repo));
  assert.equal(viaWrite.decision, 'deny');
  assert.equal(viaWrite.rule, 'builtin:self-protection');
  assert.match(viaWrite.reason, /\.claude\/settings\.json/);
  const viaShell = bash('echo x > link.json', repo);
  assert.equal(viaShell.decision, 'deny');
  assert.equal(viaShell.rule, 'builtin:self-protection');
});

test('adapter opaque reasons are named per reason', () => {
  const repo = makeRepo({ branch: 'feature' });
  const noCwd = claudePayload('Read', { file_path: 'notes.txt' }, undefined);
  delete noCwd.cwd;
  const cases = [
    [noCwd, 'claude', 'missing-cwd', /working directory/],
    [codexPayload('write_stdin', { session_id: 1, chars: 'y\n' }, repo), 'codex', 'write-stdin', /running process/],
    [claudePayload('SomeNewTool', { command: 'ls' }, repo), 'claude', 'unknown-tool-input', /does not know/],
    [codexPayload('apply_patch', { command: 'not a patch' }, repo), 'codex', 'malformed-patch', /envelope does not parse/],
    [codexPayload('shell', { command: ['bash', '-lc', "apply_patch <<EOF\n*** Begin Patch\n*** Add File: $X\n+a\n*** End Patch\nEOF"] }, repo), 'codex', 'unparsed-apply-patch', /does not name its files literally/],
  ];
  for (const [payload, host, code, text] of cases) {
    const d = spawnEngine(payload, { host });
    assert.equal(d.decision, 'deny', code);
    assert.equal(d.rule, 'builtin:opaque', code);
    assert.ok(d.reason.includes(code), `${code}: ${d.reason}`);
    assert.match(d.reason, text, code);
  }
});

// ---- fix round 2 --------------------------------------------------------------------------------

// The engine reserves exactly what evaluate lifted, so the fold evaluate matches a grant with can
// never differ from the one the reservation uses: no case variant gives a repeatable allow.
test('a ß/ẞ grant and target never give a repeatable allow', () => {
  withHome(() => {
    const repo = makeRepo({ branch: 'feature' });
    const isRootOwned = () => true;
    const claudeDir = path.join(HOME, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const ci = isCaseInsensitive(claudeDir);
    const sharpS = path.join(claudeDir, 'settingsß.json'); // ß
    const capSharpS = path.join(claudeDir, 'settingsẞ.json'); // ẞ
    const tryWrite = (d, file_path) => inProcess(claudePayload('Write', { file_path, content: '{}' }, repo), d, { isRootOwned });
    const unused = (d) => loadGrants(d.admin, d.state, NOW, { isRootOwned }).length;

    // 1. Grant for settingsß.json, Write to settingsẞ.json, neither on disk: foldCase gives ß -> ss
    //    and ẞ -> ß, so nothing is lifted, the deny stays and the grant stays unused (before this
    //    fix evaluate's NFC+lower fold lifted it while the engine reserved nothing: allow, allow).
    {
      const d = dirs();
      writeGrant(d.admin, sharpS);
      const first = tryWrite(d, capSharpS);
      assert.equal(first.decision, 'deny', JSON.stringify(first));
      assert.equal(first.rule, 'builtin:self-protection');
      assert.equal(unused(d), 1);
      assert.equal(tryWrite(d, capSharpS).decision, 'deny');
    }

    // 2. settingsß.json exists: on a case-insensitive volume the resolver realpaths the Write to
    //    settingsẞ.json onto it, so the first call is allowed by the grant and consumes it, and the
    //    repeat is denied. On a case-sensitive volume they are different files and the deny stays.
    {
      const d = dirs();
      fs.writeFileSync(sharpS, '{}');
      writeGrant(d.admin, sharpS);
      const first = tryWrite(d, capSharpS);
      if (ci) {
        assert.equal(first.decision, 'allow', JSON.stringify(first));
        assert.equal(first.rule, 'grant');
        assert.deepEqual(first.scope.writes, [sharpS]);
        assert.equal(unused(d), 0);
      } else {
        assert.equal(first.decision, 'deny');
        assert.equal(unused(d), 1);
      }
      const again = tryWrite(d, capSharpS);
      assert.equal(again.decision, 'deny');
      assert.equal(again.rule, 'builtin:self-protection');
      fs.rmSync(sharpS);
    }

    // 3. A case variant foldCase does match (settingsSS.json for a settingsß.json grant, not on
    //    disk): allowed once on a case-insensitive volume, the grant is consumed, the repeat denied.
    {
      const d = dirs();
      writeGrant(d.admin, sharpS);
      const variant = path.join(claudeDir, 'settingsSS.json');
      const first = tryWrite(d, variant);
      if (ci) {
        assert.equal(first.rule, 'grant', JSON.stringify(first));
        assert.equal(unused(d), 0);
      } else {
        assert.equal(first.rule, 'builtin:self-protection');
      }
      assert.equal(tryWrite(d, variant).rule, 'builtin:self-protection');
    }
    // the canonical decision never carries evaluate's lifted list
    const d = dirs();
    writeGrant(d.admin, sharpS);
    assert.equal(Object.hasOwn(tryWrite(d, sharpS), 'lifted'), false);
  });
});
