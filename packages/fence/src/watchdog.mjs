// The watchdog `fence-hook` (spec, "Watchdog"): the process every hook command runs.
//
//   fence-hook <pre|post|precompact|session-start> --host <claude|codex> [--policy f] [--state-dir d] [--admin-dir d]
//   main(argv, io) -> Promise<{stdout, stderr, exit}>
//   hatchIsValid(stat, text, now) -> boolean
//
// One deadline covers every step: DEADLINE_MS (3000) from start; reaching it at any step fails.
//   1. read stdin up to STDIN_CAP (8 MiB) under the deadline; over the cap fails
//   2. strict hatch: <admin>/hatch.json root-owned, not group/world-writable, a regular file, parses,
//      ISO `created` and `expires` with created <= now + 60 s, expires > now, expires - created <= 8 h.
//      A valid hatch: the engine runs with --record-only (it logs the call as `hatch` itself), its answer
//      is ignored, the watchdog appends its own minimal `hatch` line only for a `pre` call whose engine
//      failed, said nothing usable or could not log, and the host's no-output shape is returned.
//   3. (pre only) while <state>/needs-repair exists, every call without a valid hatch is denied
//      (`fence repair`, T40, clears it after the human confirms; a valid hatch wins, step 2). Then
//      post-hatch integrity: when <admin>/integrity.json exists and its hatch has expired,
//      a valid <state>/verified/<sha256 of the raw bytes of integrity.json> stamp (a regular file
//      whose ctime is after the manifest's `expires`) skips the check; otherwise the manifest is
//      compared within the deadline (with the project-settings rule over <state>/log, see
//      watchdog/integrity.mjs): equal writes the stamp; a difference or a deadline overrun
//      writes <state>/needs-repair (exclusive create, best effort: the integrity sha and a short
//      diff summary) and denies, so the deny is sticky until `fence repair`. A manifest that is not
//      root-owned or does not parse also denies.
//   4. spawn <share>/versions/<current>/src/engine.mjs with process.execPath, pipe stdin, wait for the
//      rest of the deadline, kill it on overrun
//   5. accept only exit 0 with one well-formed canonical decision; render the host shape.
// Every failure on `pre` is a deny written for the human (what failed, then fence repair, then
// fence hatch as the last resort; never a pasteable disable command), logged as a `deny` line.
// `post` and `precompact` run the engine under the same deadline and always print nothing, exit 0.
// `session-start` renders the engine's {additionalContext}; any failure prints nothing, exit 0.
//
// Bundled at install into one file (src/build/bundle-watchdog.mjs) together with hosts/render.mjs,
// watchdog/integrity.mjs and watchdog/line.mjs, so it imports only node:fs, node:path,
// node:child_process and node:crypto. HOME comes from the environment (no node:os).
//
// io (all optional; tests inject them, the CLI passes real values): stdin (Buffer | string |
// readable stream), env (default process.env; HOME locates <HOME>/.local/share/fence and the
// default state dir), now (clock function, default Date.now), deadlineMs (default 3000), lstat
// (file -> stat, default fs.lstatSync; the root-ownership seam), fs, execPath (default
// process.execPath). No flag or environment variable reaches lstat, now or deadlineMs.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { renderDecision, renderSessionStart } from './hosts/render.mjs';
import { compareManifest, MAX_MANIFEST_BYTES, parseIso, parseManifest } from './watchdog/integrity.mjs';
import { appendLine } from './watchdog/line.mjs';

export const DEADLINE_MS = 3000;
export const STDIN_CAP = 8 * 1024 * 1024;
export const CLOCK_SKEW_MS = 60 * 1000;
export const HATCH_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;
const EVENTS = Object.freeze(['pre', 'post', 'precompact', 'session-start']);
const DECISIONS = Object.freeze(['deny', 'allow', 'undecided']);
const MAX_HATCH_BYTES = 64 * 1024;
const MAX_ENGINE_STDOUT = 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VALUE_FLAGS = new Map([
  ['--host', 'host'],
  ['--policy', 'policy'],
  ['--state-dir', 'stateDir'],
  ['--admin-dir', 'adminDir'],
]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const SILENT = Object.freeze({ stdout: '', stderr: '', exit: 0 });
const RULE = 'builtin:watchdog';
const NEEDS_REPAIR = 'needs-repair';
const SUMMARY_DIFFS = 20;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');

// Owned by root, not group- or world-writable, a regular file (mode bits, so a plain stat object works).
function rootOwnedFile(stat) {
  return isObject(stat) && stat.uid === 0 && Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0 && (stat.mode & S_IFMT) === S_IFREG;
}

/** The strict hatch check. `stat` is the hatch file's lstat, `text` its contents, `now` ms. */
export function hatchIsValid(stat, text, now) {
  try {
    if (!rootOwnedFile(stat) || typeof text !== 'string' || !Number.isFinite(now)) return false;
    const v = JSON.parse(text);
    if (!isObject(v) || typeof v.created !== 'string' || typeof v.expires !== 'string') return false;
    const created = parseIso(v.created);
    const expires = parseIso(v.expires);
    if (!Number.isFinite(created) || !Number.isFinite(expires)) return false;
    return created <= now + CLOCK_SKEW_MS && expires > now && expires - created <= HATCH_MAX_LIFETIME_MS;
  } catch {
    return false;
  }
}

// The deny text for fence's own failures: what failed, then repair, then the hatch as last resort.
function failureText(what) {
  return (
    `fence denied this call because it could not check it: ${what}. ` +
    'Run fence repair in your own terminal to find and fix the problem. ' +
    'If fence cannot be repaired, a human can open a time-limited fence hatch as the last resort.'
  );
}

function defaultAdminDir() {
  return process.platform === 'darwin' ? '/Library/Application Support/fence' : '/var/lib/fence';
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { error: 'no hook event was given' };
  const [event, ...rest] = argv;
  if (!EVENTS.includes(event)) return { event, error: `the hook event ${JSON.stringify(String(event))} is unknown` };
  const args = { event };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if (!VALUE_FLAGS.has(a)) return { ...args, error: `the launcher argument ${JSON.stringify(String(a))} is unknown` };
    if (typeof v !== 'string' || v === '' || v.includes('\0')) return { ...args, error: `the launcher argument ${a} has no value` };
    args[VALUE_FLAGS.get(a)] = v;
    i++;
  }
  if (args.host !== 'claude' && args.host !== 'codex') return { ...args, error: 'the launcher was not given a known --host' };
  return args;
}

// stdin -> {bytes} | {over: true} | {timedOut: true} | {error}
function readStdin(source, deadlineAt, clock) {
  if (typeof source === 'string') source = Buffer.from(source, 'utf8');
  if (source === undefined || source === null) source = Buffer.alloc(0);
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const bytes = Buffer.from(source);
    return Promise.resolve(bytes.length > STDIN_CAP ? { over: true } : { bytes });
  }
  return new Promise((resolve) => {
    const parts = [];
    let total = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      source.removeListener?.('data', onData);
      if (!('bytes' in result)) {
        try {
          source.pause?.();
          if (source !== process.stdin) source.destroy?.();
        } catch {
          // best effort
        }
      }
      resolve(result);
    };
    const onData = (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.length;
      if (total > STDIN_CAP) return finish({ over: true });
      parts.push(buf);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), Math.max(0, deadlineAt - clock()));
    source.on('data', onData);
    source.once('end', () => finish({ bytes: Buffer.concat(parts, total) }));
    source.once('error', (err) => finish({ error: err }));
  });
}

// A file in the admin directory: {missing} | {stat, text} | {error}. Symlinks and oversized files are refused.
function readAdminFile(file, maxBytes, lstat, fsImpl) {
  let stat;
  try {
    stat = lstat(file);
  } catch (err) {
    return err?.code === 'ENOENT' ? { missing: true } : { error: err };
  }
  try {
    if (!Number.isFinite(stat?.size) || stat.size > maxBytes || (stat.mode & S_IFMT) !== S_IFREG) return { stat, text: null };
    const bytes = Buffer.from(fsImpl.readFileSync(file));
    return { stat, bytes, text: bytes.toString('utf8') };
  } catch (err) {
    return { error: err };
  }
}

// Step 3. -> {ok: true} | {ok: false, what}
function checkIntegrity(adminDir, stateDir, { clock, deadlineAt, lstat, fsImpl }) {
  const file = nodePath.join(adminDir, 'integrity.json');
  const read = readAdminFile(file, MAX_MANIFEST_BYTES, lstat, fsImpl);
  if (read.missing) return { ok: true };
  if (read.error || read.text === null) return { ok: false, what: 'its post-hatch integrity manifest could not be read' };
  if (!rootOwnedFile(read.stat)) return { ok: false, what: 'its post-hatch integrity manifest is not a root-owned, write-protected file' };
  const manifest = parseManifest(read.text);
  if (manifest === null) return { ok: false, what: 'its post-hatch integrity manifest does not parse' };
  const expires = parseIso(manifest.expires);
  if (clock() < expires) return { ok: true }; // its hatch has not expired yet

  const sha = createHash('sha256').update(read.bytes).digest('hex');
  const stamp = nodePath.join(stateDir, 'verified', sha);
  try {
    const st = lstat(stamp);
    if ((st.mode & S_IFMT) === S_IFREG && st.ctimeMs > expires) return { ok: true };
  } catch {
    // no stamp: compare
  }
  const overrun = `the post-hatch integrity comparison did not finish within ${DEADLINE_MS} ms, and every call is denied until a human repairs it`;
  if (!(clock() < deadlineAt)) {
    markNeedsRepair(stateDir, sha, ['comparison not started: deadline reached'], fsImpl);
    return { ok: false, what: overrun };
  }
  // the project-settings rule reads the repo roots of the hatch window's log lines
  const result = compareManifest(manifest, { now: clock, deadlineAt, fs: fsImpl, logDir: nodePath.join(stateDir, 'log') });
  if (result.timedOut) {
    markNeedsRepair(stateDir, sha, ['comparison stopped at the deadline', ...result.diffs.map(describeDiff)], fsImpl);
    return { ok: false, what: overrun };
  }
  if (!result.equal) {
    markNeedsRepair(stateDir, sha, result.diffs.map(describeDiff), fsImpl);
    const n = result.diffs.length;
    return { ok: false, what: `${n} file${n === 1 ? '' : 's'} or hook setting${n === 1 ? '' : 's'} fence protects changed after the last hatch, and every call is denied until a human repairs it` };
  }
  try {
    fsImpl.mkdirSync(nodePath.dirname(stamp), { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(stamp, `${new Date(clock()).toISOString()}\n`, { mode: 0o600 });
  } catch {
    // an unwritable stamp only means the next call compares again
  }
  return { ok: true };
}

const describeDiff = (d) => `${d.kind} ${d.path}${d.key === undefined ? '' : ` [${d.key}]`}`;

// The sticky deny: <state>/needs-repair, created exclusively (an existing marker is kept as is).
function markNeedsRepair(stateDir, sha, lines, fsImpl) {
  try {
    fsImpl.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const shown = lines.slice(0, SUMMARY_DIFFS);
    const more = lines.length > shown.length ? [`… and ${lines.length - shown.length} more`] : [];
    const text = [`integrity ${sha}`, ...shown, ...more].join('\n');
    fsImpl.writeFileSync(nodePath.join(stateDir, NEEDS_REPAIR), `${text}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    // best effort: this call is denied either way
  }
}

// Anything at <state>/needs-repair (any file type), or an lstat error other than ENOENT, counts.
function needsRepair(stateDir, lstat) {
  try {
    lstat(nodePath.join(stateDir, NEEDS_REPAIR));
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

// Step 4: <share>/current -> engine path, or {what}.
function locateEngine(shareDir, fsImpl) {
  let current;
  try {
    current = fsImpl.readFileSync(nodePath.join(shareDir, 'current'), 'utf8');
  } catch {
    return { what: 'its installed version pointer (current) is missing' };
  }
  const version = current.replace(/\r?\n$/, '');
  if (!SEMVER.test(version)) return { what: 'its installed version pointer (current) does not name a semver version' };
  const engine = nodePath.join(shareDir, 'versions', version, 'src', 'engine.mjs');
  try {
    if (!fsImpl.statSync(engine).isFile()) return { what: `its engine for version ${version} is missing` };
  } catch {
    return { what: `its engine for version ${version} is missing` };
  }
  return { engine };
}

// -> {code, signal, stdout} | {timedOut: true} | {error}
function runEngine(execPath, args, input, { env, deadlineAt, clock }) {
  return new Promise((resolve) => {
    const remaining = deadlineAt - clock();
    if (!(remaining > 0)) return resolve({ timedOut: true });
    let child;
    try {
      child = spawn(execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], env });
    } catch (err) {
      return resolve({ error: err });
    }
    const parts = [];
    let size = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ timedOut: true });
    }, remaining);
    child.on('error', (err) => finish({ error: err }));
    child.stdin.on('error', () => {}); // an engine that exits without reading its input (EPIPE)
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_ENGINE_STDOUT) {
        kill();
        finish({ overflow: true });
      } else {
        parts.push(chunk);
      }
    });
    child.on('close', (code, signal) => finish({ code, signal, stdout: Buffer.concat(parts).toString('utf8') }));
    child.stdin.end(input);
  });
}

// Exactly one JSON line (one trailing newline allowed) holding a plain object, else null.
function oneObjectLine(stdout) {
  if (typeof stdout !== 'string') return null;
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (body.trim() === '' || body.includes('\n')) return null;
  try {
    const v = JSON.parse(body);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function wellFormedDecision(v) {
  return (
    isObject(v) &&
    DECISIONS.includes(v.decision) &&
    (v.rule === null || typeof v.rule === 'string') &&
    typeof v.reason === 'string' &&
    isObject(v.scope) &&
    (v.logFailed === undefined || typeof v.logFailed === 'boolean')
  );
}

// What went wrong with an engine run, or null when it answered (exit 0, one object line).
function engineFailure(run) {
  if (run.timedOut) return `its engine did not answer within ${DEADLINE_MS} ms and was stopped`;
  if (run.overflow) return 'its engine printed more output than a decision';
  if (run.error) return 'its engine could not be started';
  if (run.signal) return `its engine crashed (signal ${run.signal})`;
  if (run.code !== 0) return `its engine failed (exit ${run.code})`;
  return null;
}

export async function main(argv, io = {}) {
  const clock = typeof io.now === 'function' ? io.now : Date.now;
  const start = clock();
  const deadlineMs = Number.isFinite(io.deadlineMs) && io.deadlineMs > 0 ? io.deadlineMs : DEADLINE_MS;
  const deadlineAt = start + deadlineMs;
  const env = isObject(io.env) ? io.env : process.env;
  const fsImpl = io.fs ?? nodeFs;
  const lstat = typeof io.lstat === 'function' ? io.lstat : (f) => fsImpl.lstatSync(f);
  const execPath = typeof io.execPath === 'string' ? io.execPath : process.execPath;

  const args = parseArgs(argv);
  const home = isAbs(env.HOME) ? env.HOME : null;
  const stateDir = args.stateDir ? nodePath.resolve(args.stateDir) : home ? nodePath.join(home, '.local', 'state', 'fence') : null;
  const adminDir = nodePath.resolve(args.adminDir ?? defaultAdminDir());

  const fail = (what) => {
    if (args.event !== undefined && args.event !== 'pre' && EVENTS.includes(args.event)) return { ...SILENT };
    const reason = failureText(what);
    if (stateDir) appendLine(stateDir, { host: args.host ?? null, event: args.event ?? null, decision: 'deny', rule: RULE, reason }, { now: clock, fs: fsImpl });
    return renderDecision(args.host, { decision: 'deny', rule: RULE, reason });
  };

  try {
    if (args.error) return fail(args.error);
    if (home === null) return fail('the HOME environment variable is not an absolute path');

    const input = await readStdin(io.stdin ?? process.stdin, deadlineAt, clock);
    if (input.over) return fail('the hook payload is larger than 8 MiB');
    if (input.timedOut) return fail(`reading the hook payload did not finish within ${DEADLINE_MS} ms`);
    if (input.error) return fail('the hook payload could not be read');

    const shareDir = nodePath.join(home, '.local', 'share', 'fence');
    const engineArgs = (recordOnly) => [
      args.event,
      '--host',
      args.host,
      ...(recordOnly ? ['--record-only'] : []),
      ...(args.policy ? ['--policy', nodePath.resolve(args.policy)] : []),
      '--state-dir',
      stateDir,
      '--admin-dir',
      adminDir,
    ];

    // Step 2: hatch.
    const hatch = readAdminFile(nodePath.join(adminDir, 'hatch.json'), MAX_HATCH_BYTES, lstat, fsImpl);
    if (!hatch.missing && !hatch.error && hatchIsValid(hatch.stat, hatch.text, clock())) {
      const located = locateEngine(shareDir, fsImpl);
      const run = located.engine ? await runEngine(execPath, [located.engine, ...engineArgs(true)], input.bytes, { env, deadlineAt, clock }) : null;
      // The engine logs the call itself (decision "hatch"); this minimal line is for a hatch call it
      // could not log: no engine, a failure, no decision, or a log write that failed. Only a `pre`
      // call is a decision: post/precompact/session-start answers carry none (post returns {}).
      const answer = run !== null && engineFailure(run) === null ? oneObjectLine(run.stdout) : null;
      if (args.event === 'pre' && (answer === null || !wellFormedDecision(answer) || answer.logFailed === true)) {
        appendLine(stateDir, { host: args.host, event: args.event, decision: 'hatch', rule: 'hatch' }, { now: clock, fs: fsImpl });
      }
      return { ...SILENT };
    }

    // Step 3: the sticky needs-repair deny, then post-hatch integrity (pre only). A valid hatch
    // (step 2) wins over the marker: enforcement is off entirely during a hatch.
    if (args.event === 'pre') {
      if (needsRepair(stateDir, lstat)) {
        return fail('an earlier post-hatch integrity check found changes or did not finish, and fence repair has not cleared it yet');
      }
      const integrity = checkIntegrity(adminDir, stateDir, { clock, deadlineAt, lstat, fsImpl });
      if (!integrity.ok) return fail(integrity.what);
    }

    // Steps 4 and 5.
    const located = locateEngine(shareDir, fsImpl);
    if (!located.engine) return fail(located.what);
    const run = await runEngine(execPath, [located.engine, ...engineArgs(false)], input.bytes, { env, deadlineAt, clock });
    const failure = engineFailure(run);
    if (failure) return fail(failure);
    const answer = oneObjectLine(run.stdout);

    if (args.event === 'post' || args.event === 'precompact') return { ...SILENT };
    if (args.event === 'session-start') {
      return answer && typeof answer.additionalContext === 'string' && answer.additionalContext !== ''
        ? renderSessionStart(args.host, answer.additionalContext)
        : { ...SILENT };
    }
    if (!wellFormedDecision(answer)) return fail('its engine did not return a well-formed decision');
    return renderDecision(args.host, answer);
  } catch {
    return fail('the launcher failed unexpectedly');
  }
}

function isMain() {
  try {
    return typeof process.argv[1] === 'string' && nodeFs.realpathSync(process.argv[1]) === nodeFs.realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const r = await main(process.argv.slice(2), { stdin: process.stdin });
  const exit = () => process.exit(r.exit);
  process.stderr.write(r.stderr, () => process.stdout.write(r.stdout, exit));
}
