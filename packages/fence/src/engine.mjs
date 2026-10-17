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
// `post`, `precompact` and `session-start` are stubs returning {} (Tasks 28, 41, 42); their log lines
// and the written-files index come with those tasks.
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
import { normalize } from './norm/normalize.mjs';
import { UNKNOWN, isUnknown } from './norm/unknown.mjs';
import { loadPolicy } from './policy/load.mjs';
import { bindGitTreeDiff } from './resolve/git.mjs';
import { readGitPin } from './resolve/gitpin.mjs';
import { isCaseInsensitive, resolvePath } from './resolve/paths.mjs';
import { repoOf } from './resolve/repo.mjs';

export const EVENTS = Object.freeze(['pre', 'post', 'precompact', 'session-start']);
const STUB_EVENTS = new Set(['post', 'precompact', 'session-start']);
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
function decidePre(args, { stdin, now, isRootOwned, fsImpl, env, trace }) {
  const home = os.homedir();
  trace.stateDir = nodePath.resolve(args.stateDir ?? nodePath.join(home, '.local', 'state', 'fence'));
  const adapter = Object.hasOwn(ADAPTERS, args.host ?? '') ? ADAPTERS[args.host] : null;
  if (adapter === null) {
    return deny('builtin:engine', `fence was started for the unknown host ${JSON.stringify(String(args.host ?? ''))} (expected claude or codex); the call is denied.`);
  }
  const policyFile = nodePath.resolve(args.policy ?? nodePath.join(home, '.config', 'fence', 'policy.json'));
  const stateDir = trace.stateDir;
  const adminDir = nodePath.resolve(args.adminDir ?? defaultAdminDir());

  let policy;
  try {
    ({ policy, sha: trace.policySha } = loadPolicy(policyFile, { fs: fsImpl, home }));
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return deny('builtin:policy-load', `fence could not load its policy (${code}: ${message}); every call is denied until it is fixed. Run fence check in your own terminal.`);
  }

  let payload = null;
  try {
    payload = JSON.parse(stdinText(stdin));
  } catch {
    payload = null; // the adapter reads a non-object payload as malformed (opaque)
  }
  const parsed = adapter.parse(payload, { home });
  trace.payload = payload;
  trace.parsed = parsed;

  if (parsed.event !== PRE_HOOK_EVENT) {
    return deny('builtin:engine', `fence received the hook event ${JSON.stringify(parsed.event)} for a pre-tool check (expected ${PRE_HOOK_EVENT}); the call is denied.`);
  }

  let normalized = null;
  if (parsed.opaque) {
    normalized = adapterOpaque(parsed.opaque.reason);
  } else if (typeof parsed.command === 'string') {
    const pin = readGitPin(nodePath.join(home, '.local', 'share', 'fence'), fsImpl);
    const gitTreeDiff = bindGitTreeDiff(pin ? { gitPath: pin.path, gitVersion: pin.version } : {});
    normalized = normalize(parsed.command, { cwd: parsed.cwd, home, env, gitTreeDiff, fs: fsImpl });
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
export function runEngine(argv, { stdin = '', now = Date.now(), isRootOwned = realRootCheck, fs: fsImpl = nodeFs, env = process.env, t0 = performance.now() } = {}) {
  const started = performance.now();
  const trace = {};
  let args;
  let decision;
  try {
    args = parseArgs(argv);
    if (args.error) return out(deny('builtin:engine', `fence could not start: ${args.error}; the call is denied.`));
    if (STUB_EVENTS.has(args.event)) return out({});
    // --record-only computes and returns the same decision; the watchdog ignores it.
    decision = decidePre(args, { stdin, now, isRootOwned, fsImpl, env: env !== null && typeof env === 'object' ? env : {}, trace });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision = deny('builtin:internal-error', `fence failed while deciding this call (${message}); it is denied.`);
  }
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
