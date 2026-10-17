// Engine entry (spec U18): one hook payload in, one canonical decision out.
//
//   node engine.mjs <pre|post|precompact|session-start> --host <claude|codex> [--record-only]
//                   [--policy f] [--state-dir d] [--admin-dir d]
//   runEngine(argv, {stdin, now, isRootOwned, fs, env}) -> {stdout, exit}
//
// Reads one payload from stdin and prints one canonical decision
// `{decision, rule, reason, scope, logFailed?}` as one JSON line, exit 0. Every failure of its own
// (bad arguments, a policy that does not load, an unreadable payload, an internal error) is a deny
// decision on stdout, never a crash: the watchdog accepts only exit 0 with a well-formed decision.
//
// `pre`, in order:
//   1. load the policy (a load error denies every call, naming the error)
//   2. parse the payload with the host adapter (ctx.home expands `~/`)
//   3. the hook event must be PreToolUse; anything else, "unknown" included (the payload had no
//      readable hook_event_name), denies naming the event. permission_mode, "unknown" included,
//      never changes a decision: undecided goes to the profile in every permission mode.
//   4. a CanonicalCall `opaque` mark becomes the normalized opaque result (evaluate reads only
//      normalized.opaque); otherwise a shell call's command text (Claude Bash/Monitor, Codex shell
//      tools) is normalized and evaluated together with the adapter's patch/file paths
//   5. the adapter's lexical paths are realpath-resolved (existing components) and each gets the
//      repository and branch of the directory holding it; the call gets the cwd's repository
//   6. allow-once grants are loaded and evaluate runs with them and the FENCE_PROFILE profile.
//      When the decision is not deny, evaluate's `lifted` list names every path whose
//      self-protection deny a grant lifted, with that grant; the engine reserves exactly those
//      grants by creating each used marker exclusively (`wx`) before the decision is returned; a failed reservation (EEXIST from
//      a parallel hook, an unwritable state dir, any error) turns the call into the
//      self-protection deny with the failure named. Grants that lifted nothing are left unused.
// `--record-only` (the watchdog's hatch mode) computes the same decision; its caller ignores it.
//   7. the decision is logged before it is returned (log/log.mjs: redacted, one O_APPEND line of at most
//      4 KiB; under --record-only the line's decision is `hatch`). A failed write sets `logFailed: true`
//      on the returned decision and records the failure in health.json (log/health.mjs); the decision
//      itself is never changed by logging.
//   The written-files index (log/written.mjs) is read across all sessions in the 30-day window before the
//      normalizer runs (ctx.writtenIndex: the git `.git/config` precondition) and, after a decision that is
//      not a deny, extended with the realpaths of the call's writes (the decision's scope.writes), also under
//      --record-only. A failed index write is recorded in health.json and never changes the decision.
// `post` appends one completion line (`phase: "post"`, keyed by `tool_use_id`; the tool, session, turn and
//   agent ids, the response size and its error flag, never the tool input or output) to the same log and
//   returns {}. It fails open: any failure is swallowed (a failed append is recorded in health.json) and
//   the output is {} with exit 0 whatever the payload, the host or the state directory.
// `precompact` is a stub returning {} (Task 41); `session-start` prunes logs and index
// files older than 30 days (log/prune.mjs, best effort) and returns {} (its context line comes with Task 42).
//
// The git tree check is bound to the git pinned at install (`<home>/.local/share/fence/git.json`);
// without a usable pin it stays unbound and answers UNKNOWN, which makes a tree update opaque in a
// repository tracking `.claude/` or `.codex/`.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { packageVersion } from './cli/version.mjs';

import { evaluate } from './eval/evaluate.mjs';
import { consume, loadGrants, realRootCheck } from './eval/grants.mjs';
import { claude } from './hosts/claude.mjs';
import { codex } from './hosts/codex.mjs';
import { recordHealth } from './log/health.mjs';
import { appendDecision, decisionEntry } from './log/log.mjs';
import { prune } from './log/prune.mjs';
import { appendWritten, readWritten } from './log/written.mjs';
import { normalize } from './norm/normalize.mjs';
import { UNKNOWN, isUnknown } from './norm/unknown.mjs';
import { loadPolicy } from './policy/load.mjs';
import { bindGitTreeDiff } from './resolve/git.mjs';
import { readGitPin } from './resolve/gitpin.mjs';
import { isCaseInsensitive, resolvePath } from './resolve/paths.mjs';
import { repoOf } from './resolve/repo.mjs';

export const EVENTS = Object.freeze(['pre', 'post', 'precompact', 'session-start']);
const STUB_EVENTS = new Set(['precompact', 'session-start']);
const POST = 'post';
const SESSION_START = 'session-start';
const ADAPTERS = Object.freeze({ claude, codex });
const PRE_HOOK_EVENT = 'PreToolUse';
const VALUE_FLAGS = new Map([
  ['--host', 'host'],
  ['--policy', 'policy'],
  ['--state-dir', 'stateDir'],
  ['--admin-dir', 'adminDir'],
]);

const SELF = 'builtin:self-protection';

// What each adapter opaque reason means, for the deny text (evaluate shows `reason: construct`).
const ADAPTER_OPAQUE = Object.freeze({
  'malformed-payload': 'the hook payload is not a JSON object naming a tool',
  'missing-cwd': 'the payload has no absolute working directory, so its relative paths cannot be resolved',
  'malformed-input': 'the tool input is not a JSON object',
  'unknown-tool-input': 'a tool fence does not know carries a command-like input field',
  'missing-command': 'the shell tool call has no command string',
  'malformed-command': 'the shell command is neither a string nor a list of string arguments',
  'malformed-workdir': 'the shell workdir is not a usable path',
  'malformed-patch': 'the apply_patch envelope does not parse',
  'unparsed-apply-patch': 'the apply_patch inside this shell call does not name its files literally',
  'write-stdin': 'the tool writes input into a running process, whose effect fence cannot read',
});

function adapterOpaque(reason) {
  const code = typeof reason === 'string' && reason !== '' ? reason : 'unreadable-call';
  const text = Object.hasOwn(ADAPTER_OPAQUE, code) ? ADAPTER_OPAQUE[code] : 'the host adapter could not read this call';
  return { opaque: { reason: text, construct: code, offset: 0 } };
}

const emptyScope = () => ({ reads: [], writes: [], deletes: [], domains: [], vcs: [], mcp: [], runsRepoCode: false });
const deny = (rule, reason) => ({ decision: 'deny', rule, reason, scope: emptyScope() });
const out = (value) => ({ stdout: `${JSON.stringify(value)}\n`, exit: 0 });

function defaultAdminDir() {
  return process.platform === 'darwin' ? '/Library/Application Support/fence' : '/var/lib/fence';
}

// argv -> {event, host, recordOnly, policy?, stateDir?, adminDir?} or {error}.
function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { error: 'no event given' };
  const [event, ...rest] = argv;
  if (!EVENTS.includes(event)) return { error: `unknown engine event ${JSON.stringify(String(event))} (expected ${EVENTS.join(', ')})` };
  const args = { event, recordOnly: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--record-only') {
      args.recordOnly = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = rest[i + 1];
      if (typeof v !== 'string' || v === '' || v.includes('\0')) return { error: `${a} needs a value` };
      args[VALUE_FLAGS.get(a)] = v;
      i++;
    } else {
      return { error: `unknown engine argument ${JSON.stringify(String(a))}` };
    }
  }
  return args;
}

function stdinText(stdin) {
  if (typeof stdin === 'string') return stdin;
  if (Buffer.isBuffer(stdin) || stdin instanceof Uint8Array) return Buffer.from(stdin).toString('utf8');
  return '';
}

// A repoOf result -> what evaluate reads ({root, branch} | null | UNKNOWN).
function repoView(repo) {
  if (repo === null) return null;
  if (isUnknown(repo) || repo === undefined || typeof repo !== 'object') return UNKNOWN;
  return { root: repo.root, branch: repo.branch };
}

// The adapter's lexical paths, realpath-resolved, each with the repository of its directory.
function resolvePaths(paths, home, fsImpl) {
  if (!Array.isArray(paths)) return [];
  return paths.map((entry) => {
    const lexical = entry?.path;
    if (typeof lexical !== 'string') return { path: UNKNOWN, access: entry?.access };
    const real = resolvePath(lexical, '/', home, fsImpl);
    if (isUnknown(real)) return { path: UNKNOWN, access: entry.access };
    return { path: real, access: entry.access, repo: repoView(repoOf(nodePath.posix.dirname(real), { fs: fsImpl })) };
  });
}

// `trace` is filled as the check proceeds and read by the log writer afterwards.
function decidePre(args, { stdin, now, isRootOwned, fsImpl, env, trace, written }) {
  const home = os.homedir();
  trace.stateDir = nodePath.resolve(args.stateDir ?? nodePath.join(home, '.local', 'state', 'fence'));
  const adapter = Object.hasOwn(ADAPTERS, args.host ?? '') ? ADAPTERS[args.host] : null;
  if (adapter === null) {
    return deny('builtin:engine', `fence was started for the unknown host ${JSON.stringify(String(args.host ?? ''))} (expected claude or codex); the call is denied.`);
  }
  const policyFile = nodePath.resolve(args.policy ?? nodePath.join(home, '.config', 'fence', 'policy.json'));
  const stateDir = trace.stateDir;
  const adminDir = nodePath.resolve(args.adminDir ?? defaultAdminDir());

  let payload = null;
  try {
    payload = JSON.parse(stdinText(stdin));
  } catch {
    payload = null; // the adapter reads a non-object payload as malformed (opaque)
  }
  const parsed = adapter.parse(payload, { home });
  trace.payload = payload;
  trace.parsed = parsed;

  let policy;
  try {
    ({ policy, sha: trace.policySha } = loadPolicy(policyFile, { fs: fsImpl, home }));
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return deny('builtin:policy-load', `fence could not load its policy (${code}: ${message}); every call is denied until it is fixed. Run fence check in your own terminal.`);
  }

  if (parsed.event !== PRE_HOOK_EVENT) {
    return deny('builtin:engine', `fence received the hook event ${JSON.stringify(parsed.event)} for a pre-tool check (expected ${PRE_HOOK_EVENT}); the call is denied.`);
  }

  let normalized = null;
  if (parsed.opaque) {
    normalized = adapterOpaque(parsed.opaque.reason);
  } else if (typeof parsed.command === 'string') {
    const pin = readGitPin(nodePath.join(home, '.local', 'share', 'fence'), fsImpl);
    const gitTreeDiff = bindGitTreeDiff(pin ? { gitPath: pin.path, gitVersion: pin.version } : {});
    const { set: writtenIndex, incomplete: writtenIndexIncomplete } = readWritten(stateDir, { now, fs: fsImpl, maxReadBytes: written.maxReadBytes });
    if (writtenIndexIncomplete) recordHealth(stateDir, { writtenReadFailure: { at: new Date(now).toISOString() } }, { fs: fsImpl });
    normalized = normalize(parsed.command, { cwd: parsed.cwd, home, env, gitTreeDiff, writtenIndex, writtenIndexIncomplete, fs: fsImpl });
  }

  trace.normalized = normalized;
  const call = { ...parsed, paths: resolvePaths(parsed.paths, home, fsImpl) };
  if (typeof call.cwd === 'string' && call.cwd.startsWith('/')) call.repo = repoView(repoOf(call.cwd, { fs: fsImpl }));
  // A call the adapter marked opaque has no shell reading of its own: evaluate gets the opaque record.
  if (parsed.opaque) delete call.command;

  const caseInsensitive = isCaseInsensitive(home, fsImpl) || (call.cwd.startsWith('/') && isCaseInsensitive(call.cwd, fsImpl));
  const grants = loadGrants(adminDir, stateDir, now, { isRootOwned, fs: fsImpl });
  const profile = env.FENCE_PROFILE === undefined ? 'default' : env.FENCE_PROFILE;
  trace.call = call;
  trace.profile = profile;
  const ctx = { home, platform: process.platform, caseInsensitive };
  const decision = evaluate(policy, call, normalized, { profile, grants, ctx });

  const { lifted, ...canonical } = decision;
  if (canonical.decision !== 'deny' && Array.isArray(lifted)) {
    for (const { path, grant } of lifted) {
      const r = consume(grant, fsImpl);
      if (!r.ok) {
        return {
          ...deny(SELF, `${path} is protected by fence's built-in self-protection and the allow-once grant for it could not be reserved (${r.reason}); the call is denied. A human can run "fence allow-once ${path}" again.`),
          scope: canonical.scope,
        };
      }
    }
  }
  return canonical;
}

// The paths the adapter read as writes (Write/Edit/NotebookEdit file paths, apply_patch targets), resolved
// like the engine resolves them; the fallback when a decision carries no computed scope.
function adapterWrites(trace, home, fsImpl) {
  const paths = Array.isArray(trace.parsed?.paths) ? trace.parsed.paths : [];
  const cwd = typeof trace.parsed?.cwd === 'string' && trace.parsed.cwd.startsWith('/') ? trace.parsed.cwd : '/';
  const out = [];
  for (const entry of paths) {
    if (entry?.access !== 'write' || typeof entry.path !== 'string') continue;
    const r = resolvePath(entry.path, cwd, home, fsImpl);
    if (!isUnknown(r)) out.push(r);
  }
  return out;
}

// Appends the realpaths of the writes of a call to the written-files index (best effort). A denied call
// is not recorded (it does not run), except under --record-only: a hatch means enforcement is off and the
// call really writes, so every call is recorded whatever the computed decision, and when the decision has
// no computed writes (a policy that did not load, an early failure) the adapter's own write paths stand in.
function recordWrites(decision, trace, { now, fsImpl, recordOnly }) {
  if (trace.stateDir === undefined || trace.parsed === undefined) return;
  if (decision.decision === 'deny' && !recordOnly) return;
  const writes = Array.isArray(decision.scope?.writes) ? decision.scope.writes : [];
  const home = os.homedir();
  const real = [];
  for (const w of writes) {
    if (typeof w !== 'string' || !w.startsWith('/')) continue; // UNKNOWN markers are shown as text
    const r = resolvePath(w, '/', home, fsImpl);
    real.push(isUnknown(r) ? w : r);
  }
  if (recordOnly && real.length === 0) real.push(...adapterWrites(trace, home, fsImpl));
  if (real.length === 0) return;
  let ok = false;
  try {
    ok = appendWritten(trace.stateDir, trace.parsed.session_id, real, { fs: fsImpl }).ok;
  } catch {
    ok = false;
  }
  if (!ok) recordHealth(trace.stateDir, { writtenFailure: { at: new Date(now).toISOString() } }, { fs: fsImpl });
}

// PostToolUse: appends the completion line for a tool call (keyed by tool_use_id). Never throws; the
// caller prints {} whatever happens here.
function recordCompletion(args, { stdin, now, fsImpl }) {
  let stateDir;
  try {
    stateDir = nodePath.resolve(args.stateDir ?? nodePath.join(os.homedir(), '.local', 'state', 'fence'));
    const adapter = Object.hasOwn(ADAPTERS, args.host ?? '') ? ADAPTERS[args.host] : null;
    if (adapter === null) return;
    let payload;
    try {
      payload = JSON.parse(stdinText(stdin));
    } catch {
      return;
    }
    const parsed = adapter.parse(payload, { home: os.homedir() });
    if (typeof parsed?.tool !== 'string' || parsed.tool === '') return;
    const response = payload.tool_response;
    let responseBytes;
    if (response !== undefined) {
      const serialized = typeof response === 'string' ? response : JSON.stringify(response);
      if (typeof serialized === 'string') responseBytes = Buffer.byteLength(serialized, 'utf8');
    }
    const entry = {
      phase: 'post',
      event: parsed.event,
      host: parsed.host,
      session_id: parsed.session_id || null,
      turn_id: parsed.turn_id ?? null,
      agent_id: parsed.agent_id ?? null,
      agent_type: parsed.agent_type ?? null,
      tool: parsed.tool,
      tool_use_id: parsed.tool_use_id || null,
      permission_mode: parsed.permission_mode ?? null,
      cwd: parsed.cwd || null,
      response_bytes: responseBytes ?? null,
      is_error: typeof response?.is_error === 'boolean' ? response.is_error : null,
      engine_version: packageVersion(),
    };
    if (appendDecision(stateDir, entry, { now: () => now, fs: fsImpl }).ok) return;
  } catch {
    // fall through to the health record
  }
  if (typeof stateDir === 'string') recordHealth(stateDir, { logFailure: { at: new Date(now).toISOString() } }, { fs: fsImpl });
}

const round1 = (ms) => Math.round(ms * 10) / 10;

// Logs the decision (one redacted line) and returns what the caller prints: the same decision, plus
// `logFailed: true` when the line could not be written. Never throws and never changes the decision.
function withLog(args, decision, trace, { now, started, t0, fsImpl }) {
  if (args === undefined || trace.stateDir === undefined) return decision;
  try {
    const finished = performance.now();
    const entry = decisionEntry({
      ...trace,
      decision,
      recordOnly: args.recordOnly,
      engineVersion: packageVersion(),
      latency: { total_ms: round1(finished - t0), engine_ms: round1(finished - started) },
    });
    if (appendDecision(trace.stateDir, entry, { now: () => now, fs: fsImpl }).ok) return decision;
  } catch {
    // fall through: a log that cannot be built is a failed log
  }
  recordHealth(trace.stateDir, { logFailure: { at: new Date(now).toISOString() } }, { fs: fsImpl });
  return { ...decision, logFailed: true };
}

// `env` (default process.env) is the hook process environment: FENCE_PROFILE and the host
// environment the normalizer sees. Tests pin it. `t0` is the performance.now() reading that counts as
// the start of the whole hook (the process start for the CLI entry, so total_ms includes startup).
export function runEngine(argv, { stdin = '', now = Date.now(), isRootOwned = realRootCheck, fs: fsImpl = nodeFs, env = process.env, t0 = performance.now(), writtenMaxReadBytes } = {}) {
  const started = performance.now();
  const trace = {};
  let args;
  let decision;
  try {
    args = parseArgs(argv);
    if (args.event === POST || (args.error && argv?.[0] === POST)) {
      // PostToolUse fails open: nothing here can deny, and nothing here may throw.
      try {
        if (!args.error) recordCompletion(args, { stdin, now, fsImpl });
      } catch {
        // a completion line is best effort
      }
      return out({});
    }
    if (args.error) return out(deny('builtin:engine', `fence could not start: ${args.error}; the call is denied.`));
    if (STUB_EVENTS.has(args.event)) {
      if (args.event === SESSION_START) {
        const home = os.homedir();
        prune(nodePath.resolve(args.stateDir ?? nodePath.join(home, '.local', 'state', 'fence')), now, { fs: fsImpl });
      }
      return out({});
    }
    // --record-only computes and returns the same decision; the watchdog ignores it.
    decision = decidePre(args, { stdin, now, isRootOwned, fsImpl, env: env !== null && typeof env === 'object' ? env : {}, trace, written: { maxReadBytes: writtenMaxReadBytes } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision = deny('builtin:internal-error', `fence failed while deciding this call (${message}); it is denied.`);
  }
  recordWrites(decision, trace, { now, fsImpl, recordOnly: args?.recordOnly === true });
  return out(withLog(args, decision, trace, { now, started, t0, fsImpl }));
}

function isMain() {
  try {
    return process.argv[1] !== undefined && nodeFs.realpathSync(process.argv[1]) === nodeFs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let stdin = '';
  try {
    stdin = nodeFs.readFileSync(0);
  } catch {
    stdin = '';
  }
  const r = runEngine(process.argv.slice(2), { stdin, now: Date.now(), t0: 0 });
  process.stdout.write(r.stdout, () => process.exit(r.exit));
}
