// The hook command strings of the host registrations (spec, "Hook registrations"). They live
// only here: the Claude and Codex hooks.json files are generated from these two functions, and
// the Codex file is frozen, so the strings are final.
//
// Self-contained: imports nothing. Every command runs the launcher and nothing else.

const HOSTS = Object.freeze(['claude', 'codex']);
const LAUNCHER = '"$HOME/.local/bin/fence-hook"';

const PRE_MESSAGE =
  'fence denied this call: its launcher failed or is missing. In your own terminal run: fence doctor (or install fence as its README says).';

const START_NOTICE =
  'The fence launcher is missing or failed, so fence is not running and every tool call is denied by the PreToolUse hook. ' +
  'In your own terminal run: fence doctor (or install fence as its README says).';

// echo in sh may read backslashes and cannot hold a single quote inside single quotes, so the
// notice JSON must have neither. Checked once, when the module loads.
const START_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: START_NOTICE } });
if (/['\\]/.test(START_JSON)) throw new Error('the SessionStart notice must not contain a single quote or a backslash');

function checkHost(host) {
  if (!HOSTS.includes(host)) throw new TypeError(`unknown host ${JSON.stringify(String(host))}: expected one of ${HOSTS.join(', ')}`);
  return host;
}

// PreToolUse: exit 0 and exit 2 are the watchdog's own answers and pass through; anything else
// (127 for a missing launcher, a signal, a crash) becomes exit 2 with a message for the human.
export function PRE(host) {
  checkHost(host);
  return `${LAUNCHER} pre --host ${host}; s=$?; [ $s -eq 0 ] || [ $s -eq 2 ] || { echo "${PRE_MESSAGE}" >&2; s=2; }; exit $s`;
}

// SessionStart: the session-start call, then the launcher-missing notice when it fails, so a
// plugin installed before the package tells the session why every call is denied.
export function START(host) {
  checkHost(host);
  return `${LAUNCHER} session-start --host ${host} || echo '${START_JSON}'`;
}
