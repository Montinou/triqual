import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderDecision, renderSessionStart } from '../src/hosts/render.mjs';
import { PRE, START } from '../src/hosts/commands.mjs';

const deny = (reason) => ({ decision: 'deny', rule: 'r', reason, scope: {} });
const allow = { decision: 'allow', rule: 'r', reason: 'ok', scope: {} };
const undecided = { decision: 'undecided', rule: null, reason: 'none', scope: {} };

test('claude deny is exactly one JSON line and exit 0', () => {
  const out = renderDecision('claude', deny('blocked by rule r'));
  assert.equal(out.exit, 0);
  assert.equal(out.stderr, '');
  assert.ok(out.stdout.endsWith('\n'));
  assert.equal(out.stdout.indexOf('\n'), out.stdout.length - 1, 'one line only');
  assert.deepEqual(JSON.parse(out.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked by rule r',
    },
  });
  // Claude allow is an explicit allow, still exit 0.
  const ok = renderDecision('claude', allow);
  assert.equal(ok.exit, 0);
  assert.equal(ok.stderr, '');
  assert.deepEqual(JSON.parse(ok.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  });
});

test('codex deny writes stderr only and exits 2', () => {
  const out = renderDecision('codex', deny('blocked by rule r'));
  assert.deepEqual(out, { stdout: '', stderr: 'blocked by rule r', exit: 2 });
});

test('undecided prints nothing on both hosts', () => {
  const none = { stdout: '', stderr: '', exit: 0 };
  for (const host of ['claude', 'codex']) {
    assert.deepEqual(renderDecision(host, undecided), none, host);
  }
  // Codex accepts allow only with an input rewrite: no output for it.
  assert.deepEqual(renderDecision('codex', allow), none);
  // A hatch decision is the host's no-output shape.
  for (const host of ['claude', 'codex']) {
    assert.deepEqual(renderDecision(host, { decision: 'hatch' }), none, host);
  }
});

test('reason text is preserved byte for byte including quotes and newlines', () => {
  const reason = 'line one "quoted" \'single\' \\ back\nline two\ttab é \u{1F512} </script> {"a":1}\r\n';
  const claude = renderDecision('claude', deny(reason));
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecisionReason, reason);
  assert.equal(claude.stdout.split('\n').length, 2, 'embedded newlines are escaped, one physical line');
  const codex = renderDecision('codex', deny(reason));
  assert.equal(codex.stderr, reason);
  assert.equal(Buffer.from(codex.stderr).equals(Buffer.from(reason)), true);
});

test('a deny without a usable reason and an unreadable decision fail closed', () => {
  for (const reason of [undefined, '', 5]) {
    const c = renderDecision('codex', { decision: 'deny', reason });
    assert.equal(c.exit, 2);
    assert.notEqual(c.stderr, '');
    const j = renderDecision('claude', { decision: 'deny', reason });
    assert.notEqual(JSON.parse(j.stdout).hookSpecificOutput.permissionDecisionReason, '');
  }
  for (const bad of [null, undefined, 'deny', {}, { decision: 'maybe' }]) {
    assert.equal(renderDecision('codex', bad).exit, 2);
    assert.equal(JSON.parse(renderDecision('claude', bad).stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  // An unknown host cannot be rendered for: deny the call with exit 2.
  const unknown = renderDecision('grok', allow);
  assert.equal(unknown.exit, 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /grok/);
});

test('renderSessionStart emits the additionalContext JSON for both hosts', () => {
  const text = 'fence rules: "no writes to ~/.claude"\nsecond line';
  for (const host of ['claude', 'codex']) {
    const out = renderSessionStart(host, text);
    assert.equal(out.exit, 0, host);
    assert.equal(out.stderr, '', host);
    assert.ok(out.stdout.endsWith('\n'));
    assert.deepEqual(JSON.parse(out.stdout), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    });
  }
});

// ---- the command strings, run in sh against stub launchers ----

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-render-'));
  fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
  return h;
}

function stub(h, body) {
  const file = path.join(h, '.local', 'bin', 'fence-hook');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function sh(h, command) {
  const r = spawnSync('sh', ['-c', command], { env: { HOME: h, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const MESSAGE = 'fence denied this call: its launcher failed or is missing. In your own terminal run: fence doctor (or install fence as its README says).\n';

test('PRE(h) passes exit 0 and 2 through and turns 127 into exit 2 with the message (run it in sh against stub launchers)', () => {
  assert.equal(
    PRE('claude'),
    '"$HOME/.local/bin/fence-hook" pre --host claude; s=$?; [ $s -eq 0 ] || [ $s -eq 2 ] || { echo "fence denied this call: its launcher failed or is missing. In your own terminal run: fence doctor (or install fence as its README says)." >&2; s=2; }; exit $s',
  );
  assert.equal(PRE('codex'), PRE('claude').replace('--host claude', '--host codex'));
  assert.throws(() => PRE('x; rm -rf ~'), /host/);

  const h = home();
  try {
    for (const host of ['claude', 'codex']) {
      // The launcher gets exactly `pre --host <h>`.
      stub(h, 'echo "args:$*"; exit 0');
      assert.deepEqual(sh(h, PRE(host)), { status: 0, stdout: `args:pre --host ${host}\n`, stderr: '' });

      // Exit 2 is the watchdog's own deny and passes through untouched.
      stub(h, 'echo "denied by rule" >&2; exit 2');
      assert.deepEqual(sh(h, PRE(host)), { status: 2, stdout: '', stderr: 'denied by rule\n' });

      // 127 (and any other status, a crash, a signal) becomes exit 2 plus the human message.
      for (const body of ['exit 127', 'exit 1', 'exit 126']) {
        stub(h, body);
        assert.deepEqual(sh(h, PRE(host)), { status: 2, stdout: '', stderr: MESSAGE }, body);
      }
      // A signal: the shell may print its own job notice first, the message still comes last.
      stub(h, 'kill -9 $$');
      const killed = sh(h, PRE(host));
      assert.equal(killed.status, 2);
      assert.equal(killed.stdout, '');
      assert.ok(killed.stderr.endsWith(MESSAGE), killed.stderr);
    }
    // A missing launcher: the shell itself answers 127.
    fs.rmSync(path.join(h, '.local', 'bin', 'fence-hook'));
    const missing = sh(h, PRE('claude'));
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout, '');
    assert.ok(missing.stderr.endsWith(MESSAGE), missing.stderr);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('START(h) prints the launcher-missing notice when the launcher is absent', () => {
  assert.throws(() => START("claude'; x"), /host/);
  const h = home();
  try {
    for (const host of ['claude', 'codex']) {
      // Launcher present and succeeding: its own output, no notice.
      stub(h, 'echo "args:$*"; exit 0');
      assert.deepEqual(sh(h, START(host)), { status: 0, stdout: `args:session-start --host ${host}\n`, stderr: '' });

      // Launcher failing: the notice, exit 0 (SessionStart fails open).
      stub(h, 'exit 1');
      const failed = sh(h, START(host));
      assert.equal(failed.status, 0, host);

      // Launcher absent: the notice is valid SessionStart JSON naming the launcher and the fix.
      fs.rmSync(path.join(h, '.local', 'bin', 'fence-hook'), { force: true });
      const out = sh(h, START(host));
      assert.equal(out.status, 0, host);
      assert.equal(out.stdout, failed.stdout, 'a failing launcher prints the same notice');
      assert.equal(out.stdout.split('\n').length, 2, 'one line');
      const json = JSON.parse(out.stdout);
      assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(json.hookSpecificOutput.additionalContext, /fence launcher is missing/);
      assert.match(json.hookSpecificOutput.additionalContext, /fence doctor/);
      assert.match(json.hookSpecificOutput.additionalContext, /denied/);
    }
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('render.mjs and commands.mjs import only node: modules', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hosts');
  for (const file of ['render.mjs', 'commands.mjs']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const specs = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) assert.ok(spec.startsWith('node:'), `${file} imports ${spec}`);
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, `${file} loads nothing dynamically`);
  }
});
