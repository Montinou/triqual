// The install smoke test (spec, "CLI": install and upgrade run it before switching `current`).
//
//   runSmoke({watchdogPath, engineDir, policy?, samples?, deadlineMs?}) -> {ok, failures, latencyMs}
//
// Runs the REAL watchdog (the installed bundle, or src/watchdog.mjs) with process.execPath, which
// in turn spawns the engine of `engineDir` (a versions/<v> directory: <engineDir>/src/engine.mjs),
// against fixed, harmless payloads for each host shape: one deny, one allow, one undecided and one
// opaque call, then a latency sample (the undecided payload, `samples` times, wall-clock ms per
// full watchdog run). Nothing in a payload is executed; they are strings the engine reads.
//
// Isolation: everything lives in one temporary directory that is removed afterwards. The watchdog
// gets a temp HOME (so `<HOME>/.local/share/fence/{current,versions/<v>}` is a private install
// pointing at `engineDir`), an explicit temp `--state-dir` and `--admin-dir` (no live hatch, no
// integrity manifest, no real log or written-files index) and a minimal environment. The caller's
// HOME, ~/.claude, ~/.config/fence and the real admin directory are never read or written.
//
// `policy` is a policy file path, a policy object, or omitted (an empty policy). The run uses a
// temporary copy of it with one extra allow rule (`fence-smoke-allow`, an exact `echo` argv) so the
// allow payload has something to match; the supplied rules stay in force. A deny needs no rule:
// the payload writes to a built-in protected path under the temp HOME. The undecided payload is
// expected to be denied when the policy's default profile says `undecided: "deny"`.
// runSmoke never throws: any problem is a failure string.
//
// `deadlineMs` (module API only; default the watchdog's DEADLINE_MS, 3000) is the deadline the
// watchdog runs under. At the default the watchdog file is run as is, exactly as in production.
// Any other value (tests on loaded machines pass a longer one) runs it through a two-line ESM
// wrapper in the temp directory that imports the watchdog's `main` and passes the deadline; the
// watchdog itself takes no flag or environment variable for it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEADLINE_MS } from '../watchdog.mjs';

export const DEFAULT_SAMPLES = 5;
const SPAWN_TIMEOUT_MS = 10_000;
const SPAWN_GRACE_MS = 5_000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FALLBACK_VERSION = '0.0.0';
const ALLOW_RULE_ID = 'fence-smoke-allow';
const ALLOW_WORD = 'fence-smoke-allow';
const UNDECIDED_PROGRAM = 'fence-smoke-probe';
// The watchdog's own failure text (watchdog.mjs failureText): a deny made of it did not come
// from the engine deciding the call.
const WATCHDOG_FAILURE = /could not check it/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The version name for the temp install: the directory name when it is a semver, else the
// package.json version, else a fixed fallback.
function versionOf(engineDir) {
  const base = path.basename(engineDir);
  if (SEMVER.test(base)) return base;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(engineDir, 'package.json'), 'utf8')).version;
    if (typeof v === 'string' && SEMVER.test(v)) return v;
  } catch {
    // no readable package.json
  }
  return FALLBACK_VERSION;
}

// The supplied policy -> {object} or {error}.
function readPolicy(policy) {
  if (policy === undefined || policy === null) return { object: { version: 1, rules: [] } };
  if (isObject(policy)) return { object: structuredClone(policy) };
  if (typeof policy !== 'string') return { error: 'the policy must be a file path or a policy object' };
  try {
    const value = JSON.parse(fs.readFileSync(policy, 'utf8'));
    return isObject(value) ? { object: value } : { error: `the policy ${policy} is not a JSON object` };
  } catch (err) {
    return { error: `the policy ${policy} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// The temp copy of the policy: the supplied rules plus the smoke allow rule.
function withSmokeRule(object) {
  const rules = Array.isArray(object.rules) ? object.rules : object.rules === undefined ? [] : null;
  if (rules === null) return object; // not a valid policy: the engine reports it
  const rule = {
    id: ALLOW_RULE_ID,
    decision: 'allow',
    match: { argv: [['echo', ALLOW_WORD]] },
    why: 'The install smoke test needs one call that a rule allows.',
  };
  return { ...object, rules: [...rules, rule] };
}

// The fixed payloads: [name, expected decision kind, per-host payload].
function payloads(home, cwd) {
  const base = { hook_event_name: 'PreToolUse', cwd, session_id: 'fence-smoke', permission_mode: 'default' };
  const protectedFile = path.join(home, '.claude', 'settings.json');
  const patch = `*** Begin Patch\n*** Add File: ${protectedFile}\n+x\n*** End Patch`;
  const bash = (command) => ({ ...base, tool_name: 'Bash', tool_input: { command } });
  const shell = (...command) => ({ ...base, tool_name: 'shell', tool_input: { command } });
  return [
    {
      name: 'deny',
      kind: 'deny',
      claude: { ...base, tool_name: 'Write', tool_input: { file_path: protectedFile, content: 'x' } },
      codex: { ...base, tool_name: 'apply_patch', tool_input: { command: patch } },
    },
    { name: 'allow', kind: 'allow', claude: bash(`echo ${ALLOW_WORD}`), codex: shell('echo', ALLOW_WORD) },
    { name: 'undecided', kind: 'undecided', claude: bash(`${UNDECIDED_PROGRAM} --version`), codex: shell(UNDECIDED_PROGRAM, '--version') },
    // `eval` of an expansion: fence can not tell what it would run
    { name: 'opaque', kind: 'deny', claude: bash('eval "$(echo ls)"'), codex: shell('bash', '-lc', 'eval "$(echo ls)"') },
  ];
}

// -> an array of mismatch descriptions (empty when the run matches `kind` for `host`).
function mismatches(host, kind, run) {
  const got = `exit ${run.status}${run.signal ? ` signal ${run.signal}` : ''}, stdout ${JSON.stringify(run.stdout.slice(0, 120))}, stderr ${JSON.stringify(run.stderr.slice(0, 120))}`;
  if (run.error) return [`the watchdog could not be run (${run.error.message})`];
  if (host === 'claude') {
    if (run.status !== 0) return [`expected exit 0, got ${got}`];
    if (kind === 'undecided') return run.stdout === '' ? [] : [`expected no output, got ${got}`];
    let out;
    try {
      out = JSON.parse(run.stdout).hookSpecificOutput;
    } catch {
      return [`expected one JSON decision line, got ${got}`];
    }
    if (!isObject(out) || out.permissionDecision !== kind) return [`expected permissionDecision ${kind}, got ${got}`];
    if (kind === 'deny' && WATCHDOG_FAILURE.test(String(out.permissionDecisionReason))) {
      return [`expected the engine to deny it, but the watchdog denied it: ${out.permissionDecisionReason}`];
    }
    return [];
  }
  if (kind === 'deny') {
    if (run.status !== 2 || run.stdout !== '' || run.stderr === '') return [`expected exit 2 with the reason on stderr, got ${got}`];
    if (WATCHDOG_FAILURE.test(run.stderr)) return [`expected the engine to deny it, but the watchdog denied it: ${run.stderr.trim()}`];
    return [];
  }
  return run.status === 0 && run.stdout === '' && run.stderr === '' ? [] : [`expected exit 0 and no output, got ${got}`];
}

// The ESM wrapper that runs the watchdog's main under `deadlineMs`.
function wrapperText(watchdogPath, deadlineMs) {
  return [
    `import { main } from ${JSON.stringify(pathToFileURL(watchdogPath).href)};`,
    `const r = await main(process.argv.slice(2), { stdin: process.stdin, deadlineMs: ${deadlineMs} });`,
    'process.stderr.write(r.stderr, () => process.stdout.write(r.stdout, () => process.exit(r.exit)));',
    '',
  ].join('\n');
}

export function runSmoke({ watchdogPath, engineDir, policy, samples = DEFAULT_SAMPLES, deadlineMs = DEADLINE_MS } = {}) {
  const failures = [];
  const latencyMs = [];
  const result = () => ({ ok: failures.length === 0, failures, latencyMs });
  let root = null;
  try {
    if (!(Number.isSafeInteger(deadlineMs) && deadlineMs > 0)) {
      failures.push(`the deadline must be a positive whole number of milliseconds, got ${String(deadlineMs)}`);
      return result();
    }
    if (typeof watchdogPath !== 'string' || !fs.existsSync(watchdogPath)) {
      failures.push(`the watchdog was not found${typeof watchdogPath === 'string' ? ` at ${watchdogPath}` : ''}`);
      return result();
    }
    const engineRoot = typeof engineDir === 'string' ? path.resolve(engineDir) : null;
    if (engineRoot === null || !fs.existsSync(path.join(engineRoot, 'src', 'engine.mjs'))) {
      failures.push(`the engine was not found${engineRoot ? ` at ${path.join(engineRoot, 'src', 'engine.mjs')}` : ''}`);
      return result();
    }
    const read = readPolicy(policy);
    if (read.error) {
      failures.push(read.error);
      return result();
    }
    const profile = read.object.profiles?.default?.undecided;
    const undecidedKind = profile === 'deny' ? 'deny' : 'undecided';

    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-smoke-')));
    const home = path.join(root, 'home');
    const share = path.join(home, '.local', 'share', 'fence');
    const state = path.join(root, 'state');
    const admin = path.join(root, 'admin');
    const cwd = path.join(root, 'cwd');
    const version = versionOf(engineRoot);
    for (const d of [home, share, path.join(share, 'versions'), state, admin, cwd]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(share, 'current'), `${version}\n`);
    fs.symlinkSync(engineRoot, path.join(share, 'versions', version), 'dir');
    const policyFile = path.join(root, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify(withSmokeRule(read.object)));

    let entry = watchdogPath;
    if (deadlineMs !== DEADLINE_MS) {
      entry = path.join(root, 'run-watchdog.mjs');
      fs.writeFileSync(entry, wrapperText(path.resolve(watchdogPath), deadlineMs));
    }
    const timeout = Math.max(SPAWN_TIMEOUT_MS, deadlineMs + SPAWN_GRACE_MS);
    const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const run = (host, payload) =>
      spawnSync(
        process.execPath,
        [entry, 'pre', '--host', host, '--policy', policyFile, '--state-dir', state, '--admin-dir', admin],
        { input: JSON.stringify(payload), encoding: 'utf8', env, cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
      );

    const fixed = payloads(home, cwd);
    for (const host of ['claude', 'codex']) {
      for (const p of fixed) {
        const kind = p.name === 'undecided' ? undecidedKind : p.kind;
        for (const why of mismatches(host, kind, run(host, p[host]))) failures.push(`${host} ${p.name}: ${why}`);
      }
    }

    const sample = fixed.find((p) => p.name === 'undecided');
    const count = Number.isInteger(samples) && samples > 0 ? samples : DEFAULT_SAMPLES;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const r = run('claude', sample.claude);
      latencyMs.push(performance.now() - t0);
      if (r.error || r.status !== 0) failures.push(`latency sample ${i + 1}: the watchdog run failed (exit ${r.status})`);
    }
  } catch (err) {
    failures.push(`the smoke test failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (root !== null) fs.rmSync(root, { recursive: true, force: true });
  }
  return result();
}
