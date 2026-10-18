import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSmoke } from '../src/cli/smoke.mjs';
import { buildWatchdog, writeWatchdog } from '../src/build/bundle-watchdog.mjs';

// Hermetic: the real watchdog (the bundle, and src/watchdog.mjs) and the real engine run
// against temp directories only; runSmoke makes its own temp HOME, state and admin directories.
// The tool payloads are harmless strings (echo, ls, a path string under the temp home); nothing
// in them is ever executed. The process HOME is pointed at an empty sentinel directory to prove
// the smoke run never writes there.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-smoke-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG_DIR, 'bin', 'fence.mjs');
const SRC_WATCHDOG = path.join(PKG_DIR, 'src', 'watchdog.mjs');
// The deadline the real-watchdog runs get, so a loaded machine does not cut the engine off
// (production keeps the watchdog's 3000 ms).
const DEADLINE = 20_000;

let counter = 0;
function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A versions/<v> directory whose engine is a stub script.
function stubEngine(source) {
  const versionDir = path.join(dir(), '0.0.1');
  write(path.join(versionDir, 'src', 'engine.mjs'), source);
  return versionDir;
}

const DECISION = (decision) => ({ decision, rule: 'stub', reason: `stub ${decision}`, scope: {} });
const alwaysAnswer = (decision) =>
  `import fs from 'node:fs';\nfs.readFileSync(0);\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(DECISION(decision))}\n`)});\n`;

test('passes against the real watchdog and engine in a temp home', () => {
  const sentinel = dir('sentinel-home');
  const savedHome = process.env.HOME;
  process.env.HOME = sentinel;
  try {
    const bundle = path.join(dir(), 'fence-hook');
    writeWatchdog(bundle);
    for (const watchdogPath of [bundle, SRC_WATCHDOG]) {
      const r = runSmoke({ watchdogPath, engineDir: PKG_DIR, samples: 1, deadlineMs: DEADLINE });
      assert.deepEqual(r.failures, [], r.failures.join('\n'));
      assert.equal(r.ok, true);
    }

    // a supplied policy (as a file, and as an object) is checked too; its rules stay in force
    const policy = { version: 1, rules: [{ id: 'no-curl', decision: 'deny', match: { argv: [['curl']] }, why: 'no network tools' }] };
    const file = path.join(dir(), 'policy.json');
    write(file, JSON.stringify(policy));
    for (const p of [file, policy]) {
      const r = runSmoke({ watchdogPath: bundle, engineDir: PKG_DIR, policy: p, samples: 1, deadlineMs: DEADLINE });
      assert.deepEqual(r.failures, [], r.failures.join('\n'));
      assert.equal(r.ok, true);
    }

    // a policy whose profile denies the undecided payload is expected to deny it
    const strict = { version: 1, profiles: { default: { undecided: 'deny' } }, rules: [] };
    const s = runSmoke({ watchdogPath: bundle, engineDir: PKG_DIR, policy: strict, samples: 1, deadlineMs: DEADLINE });
    assert.deepEqual(s.failures, [], s.failures.join('\n'));

    // a policy that does not load fails the smoke test, with the reason
    const broken = runSmoke({ watchdogPath: bundle, engineDir: PKG_DIR, policy: { version: 99, rules: [] }, samples: 1, deadlineMs: DEADLINE });
    assert.equal(broken.ok, false);
    assert.ok(broken.failures.length > 0);

    assert.deepEqual(fs.readdirSync(sentinel), [], 'the smoke run must never write to the process HOME');
  } finally {
    process.env.HOME = savedHome;
  }
});

test('fails when the engine returns a wrong decision (fake engine)', () => {
  // an engine that allows everything: the deny payloads (and the opaque one) must fail
  const allowAll = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: stubEngine(alwaysAnswer('allow')), samples: 1 });
  assert.equal(allowAll.ok, false);
  assert.ok(allowAll.failures.some((f) => /deny/.test(f) && /claude/.test(f)), allowAll.failures.join('\n'));
  assert.ok(allowAll.failures.some((f) => /deny/.test(f) && /codex/.test(f)), allowAll.failures.join('\n'));
  assert.ok(allowAll.failures.some((f) => /opaque/.test(f)), allowAll.failures.join('\n'));
  assert.ok(allowAll.failures.some((f) => /undecided/.test(f)), allowAll.failures.join('\n'));

  // an engine that denies everything: the allow and undecided payloads must fail
  const denyAll = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: stubEngine(alwaysAnswer('deny')), samples: 1 });
  assert.equal(denyAll.ok, false);
  assert.ok(denyAll.failures.some((f) => /allow/.test(f)), denyAll.failures.join('\n'));

  // an engine that crashes makes the watchdog deny everything it should not
  const crash = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: stubEngine("throw new Error('boom');\n"), samples: 1 });
  assert.equal(crash.ok, false);

  // a missing engine directory fails too, never throws
  const missing = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: path.join(dir(), '0.0.1'), samples: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.length > 0);

  // a missing watchdog fails, never throws
  const noWatchdog = runSmoke({ watchdogPath: path.join(dir(), 'nope'), engineDir: PKG_DIR });
  assert.equal(noWatchdog.ok, false);
});

test('reports latency samples', () => {
  const r = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: PKG_DIR, samples: 3, deadlineMs: DEADLINE });
  assert.equal(r.ok, true, r.failures.join('\n'));
  assert.equal(r.latencyMs.length, 3);
  for (const ms of r.latencyMs) {
    assert.ok(Number.isFinite(ms) && ms > 0, String(ms));
  }
  const d = runSmoke({ watchdogPath: SRC_WATCHDOG, engineDir: PKG_DIR, deadlineMs: DEADLINE });
  assert.ok(d.latencyMs.length >= 1);
});

// An engine that answers every smoke payload correctly, but takes SLOW_MS (longer than the
// watchdog's 3000 ms deadline) to answer the Claude deny payload (the Write).
const SLOW_MS = 3300;
const slowEngine = () =>
  stubEngine(
    [
      "import fs from 'node:fs';",
      'const p = JSON.parse(fs.readFileSync(0, "utf8"));',
      'const input = p.tool_input ?? {};',
      'const cmd = Array.isArray(input.command) ? input.command.join(" ") : String(input.command ?? "");',
      'const answer = (decision) => process.stdout.write(JSON.stringify({ decision, rule: "stub", reason: `stub ${decision}`, scope: {} }) + "\\n");',
      `if (p.tool_name === 'Write') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_MS}); answer('deny'); }`,
      "else if (p.tool_name === 'apply_patch' || cmd.includes('eval')) answer('deny');",
      "else if (cmd.includes('fence-smoke-allow')) answer('allow');",
      "else answer('undecided');",
      '',
    ].join('\n'),
  );

test('runSmoke passes deadlineMs to the watchdog it runs (default: the watchdog deadline)', () => {
  const engineDir = slowEngine();
  const bundle = path.join(dir(), 'fence-hook');
  writeWatchdog(bundle);
  // the bundle is what install and upgrade smoke-test (src/watchdog.mjs runs the same main)
  for (const watchdogPath of [bundle]) {
    // the default deadline is the watchdog's own: the slow answer is cut off
    const short = runSmoke({ watchdogPath, engineDir, samples: 1 });
    assert.equal(short.ok, false);
    // the slow Claude deny is among the failures (a loaded machine may add others)
    const slow = short.failures.find((f) => f.startsWith('claude deny:'));
    assert.ok(slow, short.failures.join('\n'));
    assert.match(slow, /watchdog denied it/);
    // a longer deadline lets the engine answer
    const long = runSmoke({ watchdogPath, engineDir, samples: 1, deadlineMs: DEADLINE });
    assert.deepEqual(long.failures, [], long.failures.join('\n'));
    assert.equal(long.ok, true);
  }
});

test('the watchdog bundle keeps the 3000 ms deadline unless a deadlineMs is given', () => {
  assert.match(buildWatchdog(), /^export const DEADLINE_MS = 3000;$/m);
  const longer = buildWatchdog({ deadlineMs: DEADLINE });
  assert.match(longer, new RegExp(`^export const DEADLINE_MS = ${DEADLINE};$`, 'm'));
  assert.doesNotMatch(longer, /^export const DEADLINE_MS = 3000;$/m);
  // the only difference is that line
  const diff = buildWatchdog().split('\n').filter((l, i) => l !== longer.split('\n')[i]);
  assert.deepEqual(diff, ['export const DEADLINE_MS = 3000;']);
  for (const bad of [0, -1, 1.5, Number.NaN, '20000', Infinity]) {
    assert.throws(() => buildWatchdog({ deadlineMs: bad }), /deadline/, String(bad));
  }
});

function fence(args, home) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, cwd: home });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('fence test runs a Bash example expecting deny', () => {
  const home = dir();
  const policy = path.join(home, 'policy.json');
  write(
    policy,
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'credentials',
          decision: 'deny',
          match: { paths: ['**/.env'], access: 'any' },
          why: 'Credential files are never read or written by the agent.',
          examples: {
            deny: [
              { tool: 'Bash', command: 'cat .env' },
              { command: 'echo ok && cat ./sub/.env' },
              { tool: 'shell', command: ['cat', '.env'] },
            ],
            allow: [{ tool: 'Bash', command: 'ls' }],
          },
        },
        {
          id: 'repo-secrets',
          decision: 'deny',
          match: { paths: ['${repo}/secret/**'], access: 'any' },
          why: 'The secret directory of the repository is off limits.',
          examples: { deny: [{ tool: 'Bash', command: 'cat ./secret/a.txt' }], allow: [{ tool: 'Bash', command: 'cat ./public/a.txt' }] },
        },
      ],
    }),
  );
  const ok = fence(['test', '--policy', policy], home);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS credentials deny\[0\] Bash cat \.env/);
  assert.match(ok.stdout, /PASS credentials deny\[1\]/);
  assert.match(ok.stdout, /PASS credentials deny\[2\] shell cat \.env/);
  assert.match(ok.stdout, /PASS credentials allow\[0\] Bash ls/);
  assert.match(ok.stdout, /PASS repo-secrets deny\[0\] Bash cat \.\/secret\/a\.txt/);
  assert.match(ok.stdout, /6 passed, 0 failed, 0 skipped/);
  assert.ok(!/SKIP/.test(ok.stdout), ok.stdout);

  // a Bash example that expects a deny but is not denied fails the run
  const wrong = path.join(home, 'wrong.json');
  write(
    wrong,
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'credentials',
          decision: 'deny',
          match: { paths: ['**/.env'], access: 'any' },
          why: 'w',
          examples: { deny: [{ tool: 'Bash', command: 'ls' }] },
        },
      ],
    }),
  );
  const bad = fence(['test', '--policy', wrong], home);
  assert.equal(bad.code, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /FAIL credentials deny\[0\] Bash ls: expected deny, got undecided/);
  assert.match(bad.stdout, /0 passed, 1 failed, 0 skipped/);
});
