// Code-loading variables (spec, "Normalizer", Values): environment variables whose value makes a
// program load or run code, or move the configuration it trusts. A call that sets, exports,
// unsets or wipes one of them is opaque to the normalizer, because what the program then runs is
// not what the command text says. The list is DATA; normalize.mjs decides where to look.
//
//   CODE_LOADING_VARS   {names, prefixes, prefixesNoCase}: exact names (case-sensitive), prefixes
//                       (case-sensitive), and prefixes matched case-insensitively (npm_config_*)
//   isCodeLoadingAssignment(name, value) -> boolean
//   HOST_CONFIG_VARS    {names, prefixes}: the subset that moves the host's own configuration
//                       (HOME, the fence profile, the Claude and Codex config dirs, XDG_*). The
//                       names stay in CODE_LOADING_VARS too (doctor builds its lists from that
//                       table); loadingVar() asks isHostConfigName first.
//   isHostConfigName(name) -> boolean
//
// NODE_OPTIONS is the one name that depends on its value: it is harmless only when the value is a
// literal and every flag is on NODE_OPTIONS_ALLOWED (flags that tune memory or diagnostics, none
// that loads a file).

import { isUnknown } from '../norm/unknown.mjs';

export const CODE_LOADING_VARS = Object.freeze({
  names: Object.freeze([
    'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONUSERBASE',
    // changes what inline python imports from the cwd (the interpreter allowlist's cwd rule)
    'PYTHONSAFEPATH',
    // runs an interactive interpreter on stdin after the program (python -i)
    'PYTHONINSPECT',
    'BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PAGER', 'PAGER',
    'EDITOR', 'VISUAL', 'GIT_EDITOR', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
    'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME', 'FENCE_PROFILE',
    // bash enables inherited SHELLOPTS options (keyword) at startup; PS4 expands substitutions under -x
    'SHELLOPTS', 'PS4',
  ]),
  prefixes: Object.freeze(['DYLD_', 'GIT_CONFIG_', 'XDG_']),
  prefixesNoCase: Object.freeze(['npm_config_']),
});

/**
 * Host-configuration variables: setting, exporting, unsetting or clearing one changes which
 * configuration (and so which policy) the host program reads. A construct of their own,
 * `host-config-var`, apart from the other code-loading names.
 */
export const HOST_CONFIG_VARS = Object.freeze({
  names: Object.freeze(['HOME', 'FENCE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME']),
  prefixes: Object.freeze(['XDG_']),
});

/** NODE_OPTIONS flags (the part before any `=`) that keep NODE_OPTIONS from being code-loading. */
export const NODE_OPTIONS_ALLOWED = Object.freeze([
  '--max-old-space-size', '--max-semi-space-size', '--stack-size', '--enable-source-maps', '--no-warnings',
  '--experimental-vm-modules', '--trace-warnings', '--trace-deprecation', '--trace-uncaught',
]);

const NAMES = new Set(CODE_LOADING_VARS.names);
const ALLOWED = new Set(NODE_OPTIONS_ALLOWED);
const HOST_NAMES = new Set(HOST_CONFIG_VARS.names);

// `NAME[subscript]` and `NAME+` (from `NAME+=value`) are judged by NAME.
function baseName(name) {
  let n = name;
  const b = n.indexOf('[');
  if (b >= 0) n = n.slice(0, b);
  if (n.endsWith('+')) n = n.slice(0, -1);
  return n;
}

// Literal value whose every whitespace-separated flag is allowed. Linear: one pass, no regex backtracking.
function nodeOptionsAllowed(value) {
  if (typeof value !== 'string') return false;
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && isSpace(value.charCodeAt(i))) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !isSpace(value.charCodeAt(j))) j++;
    const word = value.slice(i, j);
    const eq = word.indexOf('=');
    if (!ALLOWED.has(eq < 0 ? word : word.slice(0, eq))) return false;
    i = j;
  }
  return true;
}

function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13);
}

/**
 * Does `NAME=value` (or exporting, unsetting, wiping NAME: pass UNKNOWN) load code? value may be
 * UNKNOWN or any non-string; only NODE_OPTIONS depends on it. A name that is not a string cannot
 * be shown not to be listed: true.
 */
export function isCodeLoadingAssignment(name, value) {
  if (typeof name !== 'string' || isUnknown(name)) return true;
  const n = baseName(name);
  if (n === 'NODE_OPTIONS') return !nodeOptionsAllowed(value);
  if (NAMES.has(n)) return true;
  for (const p of CODE_LOADING_VARS.prefixes) if (n.startsWith(p)) return true;
  if (n.length > 0) {
    const lower = n.toLowerCase();
    for (const p of CODE_LOADING_VARS.prefixesNoCase) if (lower.startsWith(p)) return true;
  }
  return false;
}

/**
 * Is `name` (or exporting, unsetting, wiping it: the value never matters) a host-configuration
 * variable? A name that is not a string, or is UNKNOWN, cannot be shown not to be one: true.
 */
export function isHostConfigName(name) {
  if (typeof name !== 'string' || isUnknown(name)) return true;
  const n = baseName(name);
  if (HOST_NAMES.has(n)) return true;
  for (const p of HOST_CONFIG_VARS.prefixes) if (n.startsWith(p)) return true;
  return false;
}
