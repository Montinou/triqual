// Host output renderer: a canonical decision -> what a hook process prints and exits with.
//
// Self-contained on purpose: the watchdog bundles this file, so it imports nothing (not even
// another fence module). Output side of the spec's "Host adapters":
//
//   deny      claude: one JSON line on stdout, exit 0       codex: reason on stderr, exit 2
//   allow     claude: permissionDecision "allow", exit 0    codex: no output, exit 0
//   undecided / hatch: no output, exit 0 on both hosts
//
// A decision this module cannot read, and a host it does not know, fail closed (a deny).

const HOSTS = Object.freeze(['claude', 'codex']);
const SILENT = Object.freeze({ stdout: '', stderr: '', exit: 0 });
const FALLBACK_REASON = 'fence denied this call.';

const reasonOf = (decision) =>
  decision !== null && typeof decision === 'object' && typeof decision.reason === 'string' && decision.reason !== ''
    ? decision.reason
    : FALLBACK_REASON;

const line = (value) => `${JSON.stringify(value)}\n`;

function denyFor(host, reason) {
  if (host === 'claude') {
    return {
      stdout: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
      stderr: '',
      exit: 0,
    };
  }
  return { stdout: '', stderr: reason, exit: 2 };
}

// renderDecision(host, decision) -> {stdout, stderr, exit}. `decision.decision` is "deny",
// "allow", "undecided" or "hatch"; anything else is a deny.
export function renderDecision(host, decision) {
  if (!HOSTS.includes(host)) {
    return { stdout: '', stderr: `fence cannot render a decision for the unknown host ${JSON.stringify(String(host))}; the call is denied.`, exit: 2 };
  }
  const kind = decision !== null && typeof decision === 'object' ? decision.decision : undefined;
  if (kind === 'undecided' || kind === 'hatch') return { ...SILENT };
  if (kind === 'allow') {
    if (host === 'codex') return { ...SILENT };
    return { stdout: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }), stderr: '', exit: 0 };
  }
  return denyFor(host, reasonOf(decision));
}

// renderSessionStart(host, text) -> {stdout, stderr, exit}: the text as additionalContext, the
// same JSON line on both hosts, exit 0 (SessionStart fails open).
export function renderSessionStart(host, text) {
  const additionalContext = typeof text === 'string' ? text : '';
  return { stdout: line({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }), stderr: '', exit: 0 };
}
