import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { main, helpText } from '../src/cli/index.mjs';
import { HUMAN_ONLY, SUDO, COMMANDS, humanOnly, overrideImplsForTest } from '../src/cli/humanonly.mjs';
import { fencePaths } from '../src/cli/paths.mjs';

// Hermetic: every test gets a temp HOME, admin directory and state under os.tmpdir(). npm, git,
// sudo, claude and codex are never run: the host's `run` is a fake that records every call (a fake
// `npm install` copies this package into the temp prefix with the requested version). Node is the
// only real program: the installed launcher check runs the copied watchdog with process.execPath
// against temp directories. stdin is a PassThrough pretending to be a terminal; its lines are the
// human's answers. The implementation map is replaced only through overrideImplsForTest, a module
// seam that no argument or environment variable can reach.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-wiring-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NPM = '/fake/bin/npm';
const V1 = '0.1.0';
const V2 = '0.2.0';
const DEADLINE = 20_000;
const SPAWN_TIMEOUT_MS = 60_000;
const AUDIT_OK = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n';

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

// stdin: a "terminal" that answers with `lines`.
function tty(...lines) {
  const s = new PassThrough();
  s.isTTY = true;
  s.end(lines.length ? `${lines.join('\n')}\n` : '');
  return s;
}

const sink = () => new PassThrough();

function capture() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err, text: () => `${out.join('\n')}\n${err.join('\n')}` };
}

// The host: everything the production wiring reads from the real machine, replaced.
function hostFor({ answers = [], run, env, over = {} } = {}) {
  const home = newDir('home');
  const admin = newDir('admin');
  const f = run ?? fakeRun();
  return {
    host: {
      stdin: tty(...answers),
      stdout: sink(),
      env: env ?? { PATH: binDir('git') },
      home,
      platform: process.platform,
      cwd: newDir('cwd'),
      uid: process.getuid?.() ?? 0,
      run: f.run,
      nodePath: NODE,
      npmPath: NPM,
      adminDir: admin,
      sudoers: { read: () => '', list: () => [] },
      smoke: () => ({ ok: true, failures: [], latencyMs: [1, 2] }),
      deadlineMs: DEADLINE,
      ...over,
    },
    home,
    admin,
    calls: f.calls,
    p: fencePaths(home),
  };
}

// Fakes sudo (with counts), npm (install copies this package at the version in the spec), git, and
// the host CLIs. `responses` maps "<program> <args...>" to {status, stdout}.
function fakeRun({ sudoFail = false, responses = {} } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const name = path.basename(cmd);
    calls.push({ cmd, name, args: [...args], input: opts.input });
    if (name === 'fence-hook' || cmd === NODE) {
      return spawnSync(cmd, args, { input: opts.input, env: opts.env, cwd: opts.cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    }
    if (cmd === SUDO) return { status: sudoFail && args[0] === '-v' ? 1 : 0, stdout: '', stderr: '' };
    if (cmd === NPM && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const spec = args[args.length - 1];
      copyPackage(path.join(prefix, 'node_modules', '@triqual', 'fence'), spec.endsWith('.tgz') ? V1 : spec.slice(spec.lastIndexOf('@') + 1));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === NPM && args[0] === 'audit') return { status: 0, stdout: AUDIT_OK, stderr: '' };
    if (name === 'git') return { status: 0, stdout: 'git version 2.47.1 (fake)\n', stderr: '' };
    const key = `${name} ${args.join(' ')}`;
    if (Object.hasOwn(responses, key)) return { status: 0, stderr: '', ...responses[key] };
    return { status: 127, stdout: '', stderr: `unexpected program ${cmd}` };
  };
  return { run, calls };
}

const sudoCalls = (calls) => calls.filter((c) => c.cmd === SUDO);
const gateRuns = (calls) => sudoCalls(calls).filter((c) => c.args[0] === '-k').length;
const read = (f) => fs.readFileSync(f, 'utf8');
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;

// ---- the table -----------------------------------------------------------------------------------

test('the table gates rollback and uninstall; hatch, allow-once, apply and repair gate inside their command', () => {
  const by = (c) => humanOnly(c);
  const gateOf = Object.fromEntries(HUMAN_ONLY.map((e) => [e.command, e.gate]));
  assert.deepEqual(gateOf, {
    install: 'none',
    upgrade: 'none',
    rollback: 'table',
    edit: 'none',
    apply: 'impl',
    repair: 'impl',
    hatch: 'impl',
    'allow-once': 'impl',
    uninstall: 'table',
    lock: 'none',
  });
  // running the handlers: only the table-gated ones touch sudo before the implementation
  const TTY = { isTTY: true };
  for (const cmd of Object.keys(gateOf)) {
    const f = fakeRun();
    let ran = 0;
    by(cmd).handler({ stdin: TTY, env: {}, run: f.run, impl: () => ran++ });
    assert.equal(ran, 1, cmd);
    assert.equal(gateRuns(f.calls), gateOf[cmd] === 'table' ? 1 : 0, cmd);
  }
});

// ---- every human-only command ------------------------------------------------------------------

function fakeImpls() {
  const seen = [];
  const map = Object.fromEntries(
    HUMAN_ONLY.map((e) => [
      e.command,
      (ctx) => {
        seen.push({ command: e.command, ctx });
        return 0;
      },
    ]),
  );
  return { seen, map };
}

test('each human-only command reaches its implementation after requireHuman, with the host and the arguments', async () => {
  const { seen, map } = fakeImpls();
  const restore = overrideImplsForTest(map);
  try {
    for (const e of HUMAN_ONLY) {
      const events = [];
      const stdin = new Proxy(tty(), {
        get(t, key) {
          if (key === 'isTTY') events.push('isTTY');
          return Reflect.get(t, key);
        },
      });
      const env = new Proxy(
        { PATH: '/usr/bin' },
        {
          get(t, key) {
            events.push(`env:${String(key)}`);
            return Reflect.get(t, key);
          },
        },
      );
      const w = hostFor({ over: { stdin, env } });
      const c = capture();
      const before = seen.length;
      const code = await main([e.command, 'alpha', '--beta'], c.io, w.host);
      assert.equal(code, 0, `${e.command}: ${c.text()}`);
      assert.equal(seen.length, before + 1, `${e.command}: the implementation ran once`);
      const { ctx } = seen.at(-1);
      assert.equal(seen.at(-1).command, e.command);
      assert.deepEqual(ctx.args, ['alpha', '--beta']);
      assert.equal(ctx.host.home, w.home);
      assert.equal(ctx.run, w.host.run);
      assert.equal(typeof ctx.io.out, 'function');
      // nothing a user types reaches an implementation seam
      assert.equal(ctx.impl, undefined, `${e.command}: no impl in the context`);
      assert.equal(Object.hasOwn(ctx, 'deadlineMs'), false, `${e.command}: no deadline in the context`);
      assert.ok(events.includes('isTTY') && events.includes('env:CLAUDE_CODE_SESSION_ID') && events.includes('env:CODEX_THREAD_ID'), `${e.command}: the human check ran`);
      // the table-gated ones ran the gate before the implementation, the others did not
      assert.equal(gateRuns(w.calls), e.gate === 'table' ? 1 : 0, `${e.command}: the sudo gate count`);
    }
  } finally {
    restore();
  }
});

test('a non-terminal stdin or an agent environment refuses every human-only command before any implementation runs', async () => {
  const { seen, map } = fakeImpls();
  const restore = overrideImplsForTest(map);
  try {
    for (const e of HUMAN_ONLY) {
      const cases = [
        [{ stdin: Object.assign(new PassThrough(), { isTTY: false }) }, /interactive terminal/],
        [{ stdin: new PassThrough() }, /interactive terminal/],
        [{ env: { PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 's-1' } }, /CLAUDE_CODE_SESSION_ID/],
        [{ env: { PATH: '/usr/bin', CODEX_THREAD_ID: 't-1' } }, /CODEX_THREAD_ID/],
      ];
      for (const [over, pattern] of cases) {
        const w = hostFor({ over });
        const c = capture();
        const code = await main([e.command, 'x'], c.io, w.host);
        assert.equal(code, 1, e.command);
        assert.match(c.err.join('\n'), pattern, e.command);
        assert.deepEqual(w.calls, [], `${e.command}: nothing ran (not even sudo)`);
      }
    }
    assert.deepEqual(seen, [], 'no implementation ran');
  } finally {
    restore();
  }

  // the same with the real implementations in place: a refusal comes before anything else
  for (const e of HUMAN_ONLY) {
    const w = hostFor({ over: { stdin: Object.assign(new PassThrough(), { isTTY: false }) } });
    const c = capture();
    assert.equal(await main([e.command, '--version', V1], c.io, w.host), 1, e.command);
    assert.match(c.err.join('\n'), /interactive terminal/, e.command);
    assert.deepEqual(w.calls, [], e.command);
  }
});

test('flags and the environment can not select an implementation or a deadline', async () => {
  const { seen, map } = fakeImpls();
  const restore = overrideImplsForTest(map);
  try {
    const w = hostFor({ over: { env: { PATH: '/usr/bin', FENCE_IMPL: '/tmp/x.mjs', FENCE_DEADLINE_MS: '1', NODE_OPTIONS: '--require=/tmp/x.js' } } });
    for (const arg of ['--impl=/tmp/x.mjs', '--deadline-ms=1', '--smoke=skip']) {
      assert.equal(await main(['hatch', arg], capture().io, w.host), 0);
      const { ctx } = seen.at(-1);
      assert.equal(ctx.impl, undefined);
      assert.deepEqual(ctx.args, [arg]);
      assert.equal(Object.hasOwn(ctx, 'deadlineMs') || Object.hasOwn(ctx, 'smoke'), false);
    }
  } finally {
    restore();
  }
  // the production main takes no seam from the process environment: with the real implementations an
  // unknown flag is an error of the command, not a hook
  const w = hostFor();
  const c = capture();
  assert.equal(await main(['hatch', '--impl=/tmp/x.mjs'], c.io, w.host), 1);
  assert.match(c.err.join('\n'), /unknown argument/);
  assert.equal(gateRuns(w.calls), 0, 'a bad argument is refused before the sudo gate');
});

test('an implementation result that is not an integer exits 1; an integer is the exit code', async () => {
  for (const [result, expected] of [[0, 0], [3, 3], [undefined, 1], [null, 1], ['0', 1], [2.5, 1], [true, 1], [Number.NaN, 1]]) {
    const restore = overrideImplsForTest({ hatch: () => result });
    try {
      const w = hostFor();
      assert.equal(await main(['hatch'], capture().io, w.host), expected, String(result));
    } finally {
      restore();
    }
  }
});

test('rollback and uninstall check their arguments before the sudo gate', async () => {
  for (const args of [['rollback', 'extra'], ['rollback', '--purge'], ['rollback', '--bogus'], ['uninstall', 'extra'], ['uninstall', '--bogus'], ['uninstall', '--purge=yes']]) {
    const w = hostFor();
    const c = capture();
    assert.equal(await main(args, c.io, w.host), 1, args.join(' '));
    assert.match(c.err.join('\n'), new RegExp(`usage: fence ${args[0]}`), args.join(' '));
    assert.deepEqual(sudoCalls(w.calls), [], `${args.join(' ')}: no sudo prompt for a usage error`);
  }
  // a valid call still reaches the gate, once
  const w = hostFor();
  const c = capture();
  await main(['uninstall', '--purge'], c.io, w.host);
  assert.equal(gateRuns(w.calls), 1);
});

test('lock and replay are not implemented yet; help says so', async () => {
  const w = hostFor();
  const c = capture();
  assert.equal(await main(['lock'], c.io, w.host), 1);
  assert.match(c.err.join('\n'), /not yet implemented/);
  const r = capture();
  assert.equal(await main(['replay'], r.io, w.host), 1);
  assert.match(r.err.join('\n'), /not yet implemented/);
  const h = helpText();
  assert.match(h, /Not yet implemented: replay, lock/);
  for (const cmd of ['install', 'upgrade', 'rollback', 'edit', 'apply', 'repair', 'hatch', 'allow-once', 'uninstall', 'doctor']) assert.ok(h.includes(cmd), cmd);
  assert.doesNotMatch(h, /doctor\s+\(not yet implemented\)/);
  assert.equal(await main(['bogus'], capture().io, w.host), 1);
});

// ---- apply: exactly one sudo gate ----------------------------------------------------------------

const BASE = {
  version: 1,
  profiles: { default: { undecided: 'host' } },
  branches: { protected: ['main'], denyFileWrites: true },
  rules: [
    {
      id: 'credentials',
      decision: 'deny',
      match: { paths: ['**/.env'], access: 'any' },
      why: 'Credential files are never read or written by the agent.',
      examples: { deny: [{ tool: 'Read', path: '.env' }] },
    },
  ],
};

function policyWorld(answers) {
  const w = hostFor({ answers });
  fs.mkdirSync(path.dirname(w.p.policy), { recursive: true });
  fs.writeFileSync(w.p.policy, text(BASE));
  const drafts = newDir('drafts');
  const draft = (p) => {
    const file = path.join(drafts, 'draft.json');
    fs.writeFileSync(file, text(p));
    return file;
  };
  return { ...w, draft };
}

test('apply runs the sudo gate exactly once for a weakening change, after the confirmation', async () => {
  const w = policyWorld(['y']);
  const weaker = structuredClone(BASE);
  weaker.branches.denyFileWrites = false;
  const c = capture();
  const code = await main(['apply', w.draft(weaker)], c.io, w.host);
  assert.equal(code, 0, c.text());
  assert.equal(gateRuns(w.calls), 1, 'one gate run: the command table does not gate apply a second time');
  assert.deepEqual(sudoCalls(w.calls).map((x) => x.args), [['-k'], ['-v']]);
  assert.deepEqual(JSON.parse(read(w.p.policy)), weaker);
  assert.match(c.out.join('\n'), /policy_sha [0-9a-f]{64}/);
});

test('apply needs no gate for a change that only tightens, and a "no" writes nothing', async () => {
  const tighter = structuredClone(BASE);
  tighter.rules.push({
    id: 'no-keys',
    decision: 'deny',
    match: { paths: ['**/*.pem'] },
    why: 'Private keys stay out of reach.',
    examples: { deny: [{ tool: 'Read', path: 'server.pem' }] },
  });
  const w = policyWorld(['yes']);
  const code = await main(['apply', w.draft(tighter)], capture().io, w.host);
  assert.equal(code, 0);
  assert.equal(w.calls.length, 0, 'no sudo for a tightening apply');
  assert.deepEqual(JSON.parse(read(w.p.policy)), tighter);

  const n = policyWorld(['n']);
  const weaker = structuredClone(BASE);
  weaker.branches.denyFileWrites = false;
  const c = capture();
  assert.equal(await main(['apply', n.draft(weaker)], c.io, n.host), 1);
  assert.match(c.err.join('\n'), /not confirmed/);
  assert.equal(n.calls.length, 0, 'a declined apply never reaches sudo');
  assert.deepEqual(JSON.parse(read(n.p.policy)), BASE);

  // a failing gate writes nothing
  const g = policyWorld(['y']);
  g.host.run = fakeRun({ sudoFail: true }).run;
  assert.equal(await main(['apply', g.draft(weaker)], capture().io, g.host), 1);
  assert.deepEqual(JSON.parse(read(g.p.policy)), BASE);

  // usage
  for (const args of [['apply'], ['apply', 'a', 'b'], ['apply', '--force']]) assert.equal(await main(args, capture().io, policyWorld([]).host), 1, args.join(' '));
});

// ---- hatch and allow-once -------------------------------------------------------------------------

test('hatch gates once, writes into the admin directory through sudo and refuses a bad duration before the gate', async () => {
  const w = hostFor();
  const c = capture();
  const code = await main(['hatch', '--for', '30m'], c.io, w.host);
  assert.equal(code, 0, c.text());
  assert.equal(gateRuns(w.calls), 1);
  const sudo = sudoCalls(w.calls).map((x) => x.args);
  assert.deepEqual(sudo.slice(0, 2), [['-k'], ['-v']], 'the gate comes first');
  const tees = sudo.filter((a) => a[0] === COMMANDS.tee);
  assert.deepEqual(tees.map((a) => path.basename(a[1])), ['integrity.json.tmp', 'hatch.json.tmp']);
  assert.ok(tees.every((a) => a[1].startsWith(w.admin)), 'the explicit admin directory is used');
  assert.match(c.out.join('\n'), /A hatch is open until/);

  const bad = hostFor();
  const b = capture();
  assert.equal(await main(['hatch', '--for', '9h'], b.io, bad.host), 1);
  assert.match(b.err.join('\n'), /too long/);
  assert.deepEqual(bad.calls, []);

  const failing = hostFor({ run: fakeRun({ sudoFail: true }) });
  assert.equal(await main(['hatch'], capture().io, failing.host), 1);
  assert.equal(sudoCalls(failing.calls).some((x) => x.args[0] === COMMANDS.tee), false, 'a failed gate writes nothing');

  const closed = hostFor();
  const cc = capture();
  assert.equal(await main(['hatch', '--close'], cc.io, closed.host), 1);
  assert.match(cc.err.join('\n'), /no hatch is open/);
});

test('hatch names the repository it runs in so its project settings are scanned', async () => {
  const w = hostFor();
  const repo = path.join(w.host.cwd, 'proj');
  for (const d of ['objects', 'refs']) fs.mkdirSync(path.join(repo, '.git', d), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(repo, 'src'));
  w.host.cwd = path.join(repo, 'src');
  // the fake sudo tee does not write: capture the manifest from the call input
  assert.equal(await main(['hatch'], capture().io, w.host), 0);
  const manifest = sudoCalls(w.calls).find((x) => x.args[0] === COMMANDS.tee && x.args[1].endsWith('integrity.json.tmp'));
  assert.deepEqual(JSON.parse(String(manifest.input)).repoRoots, [fs.realpathSync(repo)]);
});

test('allow-once gates once and writes one grant for the resolved path', async () => {
  const w = hostFor();
  const target = path.join(w.host.cwd, 'notes.txt');
  const c = capture();
  const code = await main(['allow-once', target], c.io, w.host);
  assert.equal(code, 0, c.text());
  assert.equal(gateRuns(w.calls), 1);
  const tee = sudoCalls(w.calls).find((x) => x.args[0] === COMMANDS.tee);
  assert.match(tee.args[1], /grants\/.*\.json\.tmp$/);
  assert.equal(JSON.parse(String(tee.input)).path, path.join(fs.realpathSync(w.host.cwd), 'notes.txt'));
  const before = c.out.findIndex((l) => /authenticating/.test(l));
  assert.ok(before >= 0, 'the real path is shown before the gate');
  assert.equal(await main(['allow-once'], capture().io, hostFor().host), 1);
});

// ---- edit -------------------------------------------------------------------------------------------

test('edit opens a copy in $EDITOR through the host spawn and never touches the policy', async () => {
  const w = policyWorld([]);
  w.host.env = { PATH: '/usr/bin', EDITOR: 'my-editor --wait' };
  const spawned = [];
  w.host.spawn = (cmd, args) => {
    spawned.push([cmd, ...args]);
    return { status: 0 };
  };
  w.host.draftDir = newDir('edit');
  const before = read(w.p.policy);
  const c = capture();
  assert.equal(await main(['edit'], c.io, w.host), 0, c.text());
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(0, 2), ['my-editor', '--wait']);
  assert.ok(spawned[0][2].startsWith(w.host.draftDir));
  assert.equal(read(w.p.policy), before);
  assert.match(c.out.join('\n'), /fence apply/);
  assert.equal(await main(['edit', 'extra'], capture().io, w.host), 1);
});

// ---- doctor ---------------------------------------------------------------------------------------

const CLAUDE_PLUGINS = JSON.stringify([
  { id: 'other@somewhere', enabled: true, scope: 'user' },
  { id: 'fence@triqual', enabled: true, scope: 'user' },
]);
const CLAUDE_MARKETS = JSON.stringify([
  { name: 'triqual', source: 'github', repo: 'example/triqual', installLocation: '/x' },
]);
const CODEX_PLUGINS = JSON.stringify({
  installed: [{ pluginId: 'fence-codex@triqual', installed: true, enabled: true }],
  available: [],
});
const CODEX_FEATURES = 'agent_message_board      under development  false\nhooks                    stable             true\n';

function doctorWorld(over = {}) {
  const bin = binDir('claude', 'codex', 'git');
  const responses = {
    'claude --version': { stdout: '2.1.302 (Claude Code)\n' },
    'claude plugin list --json': { stdout: CLAUDE_PLUGINS },
    'claude plugin marketplace list --json': { stdout: CLAUDE_MARKETS },
    'codex plugin list --json': { stdout: CODEX_PLUGINS },
    'codex features list': { stdout: CODEX_FEATURES },
  };
  const w = hostFor({ run: fakeRun({ responses }), env: { PATH: bin } });
  fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(w.home, '.codex', 'config.toml'),
    '[features]\nhooks = true\n\n[hooks.state."fence-codex@triqual:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:' + 'a'.repeat(64) + '"\n',
  );
  Object.assign(w.host, over);
  return w;
}

test('doctor runs the host probes through the host runner, reads the home from the host and needs no terminal', async () => {
  // doctor is read-only: it is open to an agent session and a pipe
  const w2 = doctorWorld();
  w2.host.stdin = Object.assign(new PassThrough(), { isTTY: false });
  w2.host.env = { ...w2.host.env, CLAUDE_CODE_SESSION_ID: 'agent' };
  const c = capture();
  const code = await main(['doctor', '--json'], c.io, w2.host);
  const report = JSON.parse(c.out.join('\n'));
  const check = (id) => report.checks.find((x) => x.id === id);
  assert.equal(check('claude-version').status, 'ok');
  assert.match(check('claude-version').message, /2\.1\.302/);
  assert.equal(check('claude-plugin').status, 'fail', 'enabled, but this temp home has no launcher');
  assert.equal(check('claude-marketplace').status, 'ok');
  assert.match(check('claude-marketplace').message, /github/);
  assert.equal(check('codex-bridge').status, 'ok');
  assert.equal(check('codex-hooks-feature').status, 'ok');
  assert.equal(check('codex-hooks-trusted').status, 'ok');
  assert.equal(code, report.ok ? 0 : 1);
  // sudoers came from the host reader: an empty file is fine
  assert.equal(check('sudo').status, 'ok');
  // no sudo, no write: only the CLIs were run
  assert.deepEqual(sudoCalls(w2.calls), []);
  assert.ok(w2.calls.every((x) => ['claude', 'codex'].includes(x.name)), w2.calls.map((x) => x.name).join(','));
  // the host's home is where fence looked, not $HOME
  assert.ok(check('current').message.includes(w2.p.current), check('current').message);
});

test('doctor reports an unreadable sudoers as could-not-verify, never as misconfigured', async () => {
  const w = doctorWorld();
  w.host.sudoers = {
    read: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
    list: () => {
      throw new Error('EACCES');
    },
  };
  const c = capture();
  await main(['doctor', '--json'], c.io, w.host);
  const sudo = JSON.parse(c.out.join('\n')).checks.find((x) => x.id === 'sudo');
  assert.equal(sudo.status, 'unknown');
  assert.match(sudo.message, /could not verify/);
});

test('doctor degrades to could-not-verify when the host CLIs are absent or fail', async () => {
  const w = hostFor({ env: { PATH: binDir('git') } });
  const c = capture();
  await main(['doctor', '--json'], c.io, w.host);
  const report = JSON.parse(c.out.join('\n'));
  for (const id of ['claude-version', 'claude-plugin', 'claude-marketplace', 'codex-bridge']) {
    assert.equal(report.checks.find((x) => x.id === id).status, 'unknown', id);
  }
  assert.deepEqual(w.calls, [], 'no CLI was found, so none was run');
  assert.equal(await main(['doctor', 'extra'], capture().io, w.host), 1);
});

// ---- the lifecycle through main ---------------------------------------------------------------------

test('install, upgrade, repair, rollback and uninstall run through the wiring with their gates', async () => {
  const w = hostFor();
  const { p } = w;
  const run = (args, over = {}) => {
    const c = capture();
    return main(args, c.io, { ...w.host, stdin: tty(...(over.answers ?? [])), ...over.host }).then((code) => ({ code, c }));
  };

  // install: from the registry (no gate), through the wiring's human check
  let r = await run(['install', '--version', V1]);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(read(p.current), `${V1}\n`);
  assert.equal(sudoCalls(w.calls).length, 0, 'a registry install needs no sudo');
  assert.ok(w.calls.some((x) => x.name === 'npm' && x.args[0] === 'audit'), 'provenance was checked');
  assert.ok(fs.existsSync(p.policy), 'the example policy was written');

  // a range is refused, and so is a missing version
  for (const args of [['install', '--version', '^0.1.0'], ['install'], ['install', '--version']]) assert.equal((await run(args)).code, 1, args.join(' '));

  // install --from-tarball: install's own gate, once (the table does not add a second)
  const tarball = path.join(newDir('tar'), 'fence.tgz');
  fs.writeFileSync(tarball, 'x');
  const before = gateRuns(w.calls);
  r = await run(['install', '--version', V1, '--from-tarball', tarball]);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(gateRuns(w.calls) - before, 1, 'from-tarball: exactly one gate run');
  const noTarballTty = await main(['install', '--version', V1, '--from-tarball', tarball], capture().io, { ...w.host, stdin: Object.assign(new PassThrough(), { isTTY: false }) });
  assert.equal(noTarballTty, 1);

  // upgrade: no gate
  const g0 = gateRuns(w.calls);
  r = await run(['upgrade', '--version', V2]);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(read(p.current), `${V2}\n`);
  assert.equal(gateRuns(w.calls), g0, 'upgrade needs no sudo');
  assert.equal((await run(['upgrade'])).code, 1);

  // repair with nothing pending: reinstalls, no confirmation, no gate
  fs.rmSync(p.watchdog);
  r = await run(['repair']);
  assert.equal(r.code, 0, r.c.text());
  assert.ok(fs.existsSync(p.watchdog));
  assert.equal(gateRuns(w.calls), g0, 'repair with nothing pending needs no sudo');
  assert.match(r.c.out.join('\n'), /Registrations:/);

  // repair after a mismatch: the human is asked, then one gate run; a "no" changes nothing
  fs.mkdirSync(p.stateDir, { recursive: true });
  const marker = path.join(p.stateDir, 'needs-repair');
  fs.writeFileSync(marker, 'integrity x\nchanged /somewhere\n');
  r = await run(['repair'], { answers: ['n'] });
  assert.equal(r.code, 1);
  assert.match(r.c.err.join('\n'), /not confirmed/);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(gateRuns(w.calls), g0);
  r = await run(['repair'], { answers: ['y'] });
  assert.equal(r.code, 0, r.c.text());
  assert.equal(gateRuns(w.calls) - g0, 1, 'one gate run for the whole repair');
  assert.equal(fs.existsSync(marker), false);

  // rollback: the table gates it once; a failing sudo stops it
  const failing = await run(['rollback'], { host: { run: fakeRunWith(w, { sudoFail: true }) } });
  assert.equal(failing.code, 1);
  assert.equal(read(p.current), `${V2}\n`);
  const g1 = gateRuns(w.calls);
  r = await run(['rollback']);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(gateRuns(w.calls) - g1, 1);
  assert.equal(read(p.current), `${V1}\n`);
  assert.equal((await run(['rollback', 'extra'])).code, 1);

  // uninstall: gated once by the table; the host CLIs are not on PATH, so their steps are printed
  const g2 = gateRuns(w.calls);
  r = await run(['uninstall']);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(gateRuns(w.calls) - g2, 1);
  assert.equal(fs.existsSync(p.watchdog), false);
  assert.equal(fs.existsSync(p.versionsDir), false);
  assert.ok(fs.existsSync(p.policy), 'the policy is kept without --purge');
  assert.match(r.c.out.join('\n'), /claude plugin uninstall fence@triqual/);
  assert.equal((await run(['uninstall', '--bogus'])).code, 1);
});

test('repair keeps current without asking; a missing current is replaced only after a prompt that names the version, and one gate run', async () => {
  const w = hostFor();
  const { p } = w;
  const run = (args, answers = []) => {
    const c = capture();
    const shown = [];
    const stdout = new PassThrough();
    stdout.on('data', (d) => shown.push(String(d)));
    return main(args, c.io, { ...w.host, stdin: tty(...answers), stdout }).then((code) => ({ code, c, shown: shown.join('') }));
  };
  assert.equal((await run(['install', '--version', V1])).code, 0);
  assert.equal((await run(['upgrade', '--version', V2])).code, 0);
  assert.equal((await run(['rollback'])).code, 0);
  assert.equal(read(p.current), `${V1}\n`);

  // after a rollback: current stays, no prompt, no extra gate
  const g0 = gateRuns(w.calls);
  let r = await run(['repair']);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(read(p.current), `${V1}\n`);
  assert.equal(r.shown, '', 'no question was asked');
  assert.equal(gateRuns(w.calls), g0);

  // current missing: the prompt names the fallback version; "no" changes nothing
  fs.rmSync(p.current);
  r = await run(['repair'], ['n']);
  assert.equal(r.code, 1);
  assert.match(r.shown, new RegExp(`Switch to version ${V2.replaceAll('.', '\\.')}`), 'the newest passing version is named');
  assert.match(r.shown, /not covered by the integrity check/);
  assert.equal(fs.existsSync(p.current), false);
  assert.equal(gateRuns(w.calls), g0, 'declined: no gate');
  r = await run(['repair'], ['y']);
  assert.equal(r.code, 0, r.c.text());
  assert.equal(read(p.current), `${V2}\n`);

  // an integrity denial while current is unusable: the first question does not claim a reinstall
  // from the current version
  const marker = path.join(p.stateDir, 'needs-repair');
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.writeFileSync(marker, 'integrity x\n');
  r = await run(['repair'], ['y']);
  assert.equal(r.code, 0, r.c.text());
  assert.match(r.shown, /Reinstall from the current version/, 'with a usable current the question says so');
  fs.writeFileSync(marker, 'integrity x\n');
  fs.rmSync(p.current);
  r = await run(['repair'], ['n']);
  assert.equal(r.code, 1);
  assert.match(r.shown, /no usable current version/);
  assert.doesNotMatch(r.shown, /Reinstall from the current version/);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(gateRuns(w.calls) - g0, 2, 'the earlier switch and the integrity clear: one gate run each, the declined one none');
});

// a runner that shares the call log of `w` but fails the sudo -v step
function fakeRunWith(w, opts) {
  const f = fakeRun(opts);
  return (cmd, args, o) => {
    const r = f.run(cmd, args, o);
    w.calls.push(...f.calls.splice(0));
    return r;
  };
}
