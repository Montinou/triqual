// The Codex adapter: a PreToolUse (or PostToolUse) payload -> a canonical call.
//
// Effective cwd: a shell tool's own `workdir` (resolved against the payload cwd) when present,
// else the payload `cwd`. Resolution is lexical, as in the Claude adapter, and path values go
// through the same resolver, so the same file edit gives the same canonical paths on both hosts.
//
// apply_patch: the envelope in `tool_input.command` gives write paths (an Update also reads its
// file, like Claude's Edit; a Move reads and writes its source and writes its destination). The
// same envelope inside a shell call, as `apply_patch <<'EOF' … EOF` (optionally after `cd <dir> &&`)
// or as the argv `["apply_patch", <envelope>]`, adds those paths to the shell call; that form
// with an unreadable envelope, cd operand or expanding body is opaque. A shell call in any other
// form (one that only mentions apply_patch) is a plain shell call.

import nodePath from 'node:path';

import { UNKNOWN } from '../norm/unknown.mjs';
import { pathEntries, resolveValue } from './claude.mjs';
import { parseApplyPatch } from './patch.mjs';
import { OPAQUE_INPUT_FIELDS, lookupCodexTool } from './tools.mjs';
import { compact } from './types.mjs';

const isAbsolute = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\u0000');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);

const SAFE_WORD = /^[A-Za-z0-9_\-+=.,/:@%^]+$/;
const quote = (s) => (SAFE_WORD.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
const APPLY_PATCH_NAMES = new Set(['apply_patch', 'applypatch']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// The whole script is `[cd <operand> &&] apply_patch <<[-]DELIM` + body + the DELIM line. The
// terminator is at column 0; only `<<-` allows tabs before it (checked after the match).
const HEREDOC = /^(?:cd(?:[ \t]+([^\n&]*?))?[ \t]*&&[ \t]*)?(?:apply_patch|applypatch)[ \t]*<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3[ \t]*\n([\s\S]*?)\n(\t*)\4$/;
// A cd operand the adapter accepts: starts with `/`, `./` or `../` and holds no character that
// the shell would expand or split on (CDPATH applies to a bare name, so that is refused too).
const CD_OPERAND = /^(?:\/|\.\/|\.\.\/)[^\s*?[\]{}();|<>#'"$`\\~]*$/;
const SHELL_FLAGS = new Set(['-e', '-u', '-x', '-l']);
const SHELL_OPT_WITH_NAME = new Set(['-o', '+o']);

// argv `[shell, ...options, "-c"|"-lc", text]` with options from {-o NAME, +o NAME, -e, -u, -x,
// -l} -> text, or null when argv is not exactly that form.
function shellScript(argv) {
  if (argv.length < 3 || !SHELLS.has(nodePath.posix.basename(argv[0]))) return null;
  const last = argv.length - 1;
  if (!/^-l?c$/.test(argv[last - 1])) return null;
  for (let i = 1; i < last - 1; i++) {
    if (SHELL_FLAGS.has(argv[i])) continue;
    if (SHELL_OPT_WITH_NAME.has(argv[i]) && i + 1 < last - 1 && /^[a-z]+$/.test(argv[i + 1])) {
      i++;
      continue;
    }
    return null;
  }
  return argv[last];
}

// The `command` (or exec_command `cmd`) value -> {text, argv?} or null when it is neither a
// non-empty string nor an argv array of strings.
function readCommand(input) {
  const raw = input.command !== undefined ? input.command : input.cmd;
  if (typeof raw === 'string') return raw.trim() === '' ? null : { text: raw };
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((a) => typeof a === 'string')) return null;
  return { text: raw.map(quote).join(' '), argv: raw };
}

// The apply_patch a shell call runs, read only from its exact forms: {none: true} when the call
// is not one of them (a plain shell call: the normalizer judges it), {envelope, cd?} when the
// adapter can read it, or {unreadable: true} when it has the form but not literal paths.
function shellPatch(cmd) {
  const { argv } = cmd;
  if (argv && APPLY_PATCH_NAMES.has(nodePath.posix.basename(argv[0]))) {
    return argv.length === 2 ? { envelope: argv[1] } : { none: true };
  }
  const script = argv ? shellScript(argv) : cmd.text;
  if (script === null) return { none: true };
  const m = HEREDOC.exec(script.trim());
  if (m === null) return { none: true };
  const [, cdRaw, dash, delimQuote, , rawBody, tabs] = m;
  if (dash === '' && tabs !== '') return { none: true };
  // `<<-` strips leading tabs from every body line.
  const body = dash === '-' ? rawBody.replace(/^\t+/gm, '') : rawBody;
  // An unquoted delimiter expands `$` and backticks inside the body: the paths are not literal.
  if (delimQuote === '' && /[$`\\]/.test(body)) return { unreadable: true };
  let cd;
  if (m[0].startsWith('cd')) {
    cd = (cdRaw ?? '').trim();
    if (!CD_OPERAND.test(cd)) return { unreadable: true };
  }
  return { envelope: body, cd };
}

// Patch entries -> canonical path entries, resolved against `base`.
function patchPaths(entries, base, ctx) {
  const out = [];
  const seen = new Set();
  const add = (value, access) => {
    for (const p of resolveValue(value, base, ctx)) {
      const key = typeof p === 'string' ? `${access} ${p}` : null;
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({ path: p, access });
    }
  };
  for (const e of entries) {
    if (e.op === 'add' || e.op === 'delete') add(e.path, 'write');
    else if (e.op === 'update') {
      add(e.path, 'read');
      add(e.path, 'write');
    } else {
      add(e.from, 'read');
      add(e.from, 'write');
      add(e.path, 'write');
    }
  }
  return out;
}

function parse(payload, ctx = {}) {
  const p = isPlainObject(payload) ? payload : {};
  const tool = str(p.tool_name) ?? '';
  const call = {
    host: 'codex',
    event: str(p.hook_event_name) ?? 'unknown',
    tool,
    kind: 'other',
    cwd: isAbsolute(p.cwd) ? nodePath.posix.resolve(p.cwd) : '',
    session_id: str(p.session_id) ?? '',
    turn_id: str(p.turn_id),
    permission_mode: str(p.permission_mode) ?? 'unknown',
    tool_use_id: str(p.tool_use_id) ?? '',
    paths: [],
  };
  const done = (extra) => compact({ ...call, ...extra });
  const opaque = (reason, extra = {}) => done({ ...extra, opaque: { reason } });

  if (tool === '') return opaque('malformed-payload');
  const entry = lookupCodexTool(tool);
  if (entry !== null) call.kind = entry.kind;
  if (call.cwd === '') return opaque('missing-cwd');

  const rawInput = p.tool_input === undefined ? {} : p.tool_input;
  if (!isPlainObject(rawInput)) return opaque('malformed-input');
  const input = rawInput;

  if (entry === null) {
    const sus = OPAQUE_INPUT_FIELDS.some((f) => typeof input[f] === 'string');
    return sus ? opaque('unknown-tool-input') : done({});
  }
  if (entry.opaque) return opaque(entry.opaque);
  if (entry.kind === 'mcp') return done({ mcp: tool });

  if (entry.patch) {
    const entries = parseApplyPatch(input.command);
    return entries === null ? opaque('malformed-patch') : done({ paths: patchPaths(entries, call.cwd, ctx) });
  }

  if (entry.command) {
    const wd = input.workdir;
    if (wd !== undefined && wd !== null) {
      if (typeof wd !== 'string' || wd === '' || wd.includes('\u0000') || wd === '~' || wd.startsWith('~/')) return opaque('malformed-workdir');
      call.cwd = nodePath.posix.resolve(call.cwd, wd);
    }
    const cmd = readCommand(input);
    if (cmd === null) return opaque('malformed-command');
    const patch = shellPatch(cmd);
    if (patch.none) return done({ command: cmd.text });
    if (patch.unreadable) return opaque('unparsed-apply-patch', { command: cmd.text });
    const entries = parseApplyPatch(patch.envelope);
    if (entries === null) return opaque('malformed-patch', { command: cmd.text });
    const base = patch.cd === undefined ? call.cwd : nodePath.posix.resolve(call.cwd, patch.cd);
    return done({ command: cmd.text, paths: patchPaths(entries, base, ctx) });
  }

  const extra = {};
  if (entry.paths) extra.paths = pathEntries(entry, input, call.cwd, ctx);
  if (entry.egress?.urlField) extra.url = typeof input[entry.egress.urlField] === 'string' ? input[entry.egress.urlField] : UNKNOWN;
  return done(extra);
}

export const codex = Object.freeze({
  name: 'codex',
  events: Object.freeze(['PreToolUse', 'PostToolUse']),
  parse,
});
