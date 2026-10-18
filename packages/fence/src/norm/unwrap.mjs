// Nested shells, eval and decoding (spec, "Normalizer": Unwrapping). Decides which text a finished
// effective command runs as shell code, so the normalizer judges the commands that really run
// instead of the wrapper text:
//
//   unwrap(eff, depth, ctx) -> EffectiveCommand[] | {opaque: {reason, construct}}
//     ctx = {reparse(text, depth, child), fed, feed, kind, scripts}
//       reparse   parses and walks text as a child shell; returns its effective commands or {opaque}
//       fed       the command's stdin is a pipe, heredoc, herestring or file
//       feed      what that stdin holds: a literal string, null (not literal: a file, curl, `$( )`),
//                 or a feed error {reason, construct} (undecodable text, an UNKNOWN heredoc)
//       kind      the current shell's kind ('zsh' | 'bash'), for eval
//       scripts   [{name, text, exact}] script text a wrapper layer runs (env -S, flock -c, watch,
//                 sudo -s); exact: the layer is exactly `env -S TEXT` / TEXT is flock's last word
//     child = {kind, subshell, stdin, reset}: subshell (a new shell process: its cd, variables and
//       pushd stack stay inside), stdin (the child's own stdin is fed), reset (a wrapper replaced
//       the environment: sudo, doas, env)
//
// What is re-parsed (each one counts one level; deeper than MAX_REPARSE_DEPTH is opaque `depth`):
// - `sh|bash|zsh|dash|ksh` with -c (or a flag cluster containing c): the code word. Extra words are
//   $0 $1 … (UNKNOWN inside the text). An UNKNOWN code word, or an UNKNOWN word where an option
//   could go, is opaque `nested-script`; a long option outside SHELL_LONG (`--rcfile f` loads a
//   file) is opaque `shell-option`.
// - A shell reading its script from stdin (no operand, or -s): a literal feed is re-parsed; a feed
//   that is not literal is opaque `stdin-interpreter`. A file operand naming stdin (`-`, /dev/stdin,
//   /dev/fd/0, /proc/*/fd/0) is the same; another descriptor (/dev/fd/N) is opaque. Any other file
//   operand is left to the normalizer, which reads the file (resolve/script.mjs).
// - `eval` with literal arguments: the arguments joined with one space; an UNKNOWN argument (or an
//   option) is opaque `eval-dynamic`.
// - Wrapper scripts: flock -c and watch run `sh -c TEXT`; `env -S TEXT` is re-parsed as `env TEXT`
//   only when TEXT is plain words (env -S has its own splitting: no expansion, no operators, no
//   tilde) and nothing else is on the env layer; sudo -s/-i and doas -s are opaque (sudo's
//   escaping of the joined words is not reconstructed).
// Feeds (pipeFeeds / heredocs): echo (no backslash, only -n), printf (escapes \n \t \r \\ \a \b
// \f \v \xHH, %s and %%), cat of a literal heredoc/herestring/pipe, `base64 -d|--decode|-D`,
// `openssl base64 -d`, `openssl enc -base64|-a -d`, `xxd -r -p` of a literal input. Decoded text
// must be valid UTF-8 with no NUL and at most MAX_DECODED bytes, else opaque `decode`. Decoded text
// fed to a non-shell interpreter stays opaque (the stdin-interpreter step).
//
// Pure: no file system, no process. Linear in its input; never throws (an internal error is
// opaque `internal`).

import { isUnknown } from './unknown.mjs';
import { literalValue } from './parser.mjs';
import { programOf } from '../tables/classes.mjs';

/** Most nested re-parses (shell -c, eval, stdin feeds, wrapper scripts) around one command. */
export const MAX_REPARSE_DEPTH = 4;
/** Largest decoded or printf-produced text. */
export const MAX_DECODED = 32 * 1024;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Shells this module does not parse: inline code or a fed stdin is opaque `foreign-shell`.
const FOREIGN_SHELLS = new Set([
  'csh', 'tcsh', 'fish', 'mksh', 'ksh93', 'ash', 'yash', 'rc', 'nu', 'pwsh', 'powershell', 'xonsh', 'elvish', 'osh', 'oil', 'ysh',
]);
// Options of a foreign shell that load nothing and run nothing.
const FOREIGN_QUIET = /^(?:-[filnqNhvV]|--(?:version|help|login|interactive|no-config|norc|noprofile)|-(?:NoProfile|NoLogo|Version))$/i;
// Programs that start a shell as another user.
const USER_SWITCHERS = new Set(['su', 'runuser', 'sg', 'newgrp']);
// Programs that run a command operand inside another program (a terminal or session runner).
const COMMAND_RUNNERS = new Set(['script', 'expect', 'tmux', 'screen']);
// Privilege wrappers: left unstripped (a shell option, or no command operand), they start a shell
// that reads stdin.
const PRIVILEGE = new Set(['sudo', 'doas']);
// Long options that neither take a value nor load a file.
const SHELL_LONG = new Set(['--norc', '--noprofile', '--posix', '--login', '--noediting', '--verbose', '--restricted']);
// env -S text that its own splitting and the shell parser read the same way.
const ENV_S_PLAIN = /^[A-Za-z0-9_\-./=:,+@% \t'"]*$/;

const isStr = (w) => typeof w === 'string';
const opaque = (reason, construct) => ({ opaque: { reason, construct } });
const feedError = (reason, construct) => ({ reason, construct });
const DECODE = () => feedError('unsupported', 'decode');
const isFeedError = (v) => v !== null && typeof v === 'object' && isStr(v.construct) && !isUnknown(v);

/** 'zsh' for zsh, 'bash' for the others (sh, dash, ksh parse as bash; zsh-only syntax is opaque). */
export function shellKind(base) {
  return base === 'zsh' ? 'zsh' : 'bash';
}

function baseName(w) {
  return w.slice(w.lastIndexOf('/') + 1).toLowerCase();
}

/** argv with leading busybox/toybox removed: an applet is the program it names (as classes.mjs reads it). */
export function appletArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  let a = argv;
  for (let n = 0; n < 3 && a.length > 1 && isStr(a[0]); n++) {
    const p = programOf(a[0]).toLowerCase();
    if (p !== 'busybox' && p !== 'toybox') break;
    a = a.slice(1);
  }
  return a;
}

// Inline-code options of the foreign shells: -c (and short clusters holding c or e), -e,
// -Command/-EncodedCommand (pwsh: any case, abbreviations included), --command[=…].
function foreignCode(a) {
  if (/^-[A-Za-z]*[ce][A-Za-z]*$/.test(a)) return true;
  const m = /^-{1,2}([A-Za-z]+)(?:[=:].*)?$/.exec(a);
  if (!m) return false;
  const name = m[1].toLowerCase();
  return 'command'.startsWith(name) || (name.length >= 2 && 'encodedcommand'.startsWith(name)) || name === 'ec';
}

/**
 * A foreign shell or a command runner that would run code fence cannot read: {opaque} or null.
 * Foreign shells: inline code, an UNKNOWN argument, or a fed stdin. script/expect/tmux/screen: a
 * command operand (any non-option word, or -c/--command for script), or a fed stdin for expect.
 * A bare launch (no code, nothing fed) is not opaque.
 */
export function foreignShell(argv0, fed) {
  const argv = appletArgv(argv0);
  if (!Array.isArray(argv) || !isStr(argv[0])) return null;
  const base = baseName(argv[0]);
  const args = argv.slice(1);
  const bad = opaque('unsupported', 'foreign-shell');
  if (FOREIGN_SHELLS.has(base)) {
    if (fed) return bad;
    // any option outside the few that load nothing and run nothing may carry code (--init-command,
    // -CommandWithArgs, --commands …); a script file operand is runs-repo-code (resolve/script.mjs)
    if (args.some((a) => !isStr(a) || foreignCode(a) || (a.startsWith('-') && !FOREIGN_QUIET.test(a)))) return bad;
    return null;
  }
  if (USER_SWITCHERS.has(base)) {
    // su/runuser/sg/newgrp start a shell as another user: it reads stdin, runs -c text, or runs a
    // command operand; none is re-parsed
    if (fed) return opaque('unsupported', 'stdin-interpreter');
    if (args.some((a) => !isStr(a) || /^-[A-Za-z]*c/.test(a) || a.startsWith('--command') || a.startsWith('--session-command'))) return bad;
    if (base === 'runuser' && args.some((a) => a === '--' || /^-[A-Za-z]*u/.test(a) || a.startsWith('--user'))) return bad;
    if (base === 'sg' && args.filter((a) => !a.startsWith('-')).length >= 2) return bad;
    return null;
  }
  if (!COMMAND_RUNNERS.has(base)) return null;
  if (args.some((a) => !isStr(a))) return bad;
  if (base === 'expect') return fed || args.length > 0 ? bad : null;
  const operands = args.filter((a) => !a.startsWith('-'));
  if (base === 'script') {
    // util-linux: -c CMD / --command; BSD: script [file [command …]]
    if (args.some((a) => a === '-c' || a.startsWith('--command') || /^-[A-Za-z]*c/.test(a))) return bad;
    return operands.length >= 2 ? bad : null;
  }
  // tmux, screen: any operand may be (or start) a command; tmux -c runs a shell command
  if (base === 'tmux' && args.some((a) => /^-[A-Za-z]*c/.test(a))) return bad;
  return operands.length > 0 ? bad : null;
}

/**
 * How a shell invocation gets its code: {mode:'c', text, kind} (text may be UNKNOWN),
 * {mode:'stdin', kind}, {mode:'file', kind}, {opaque}, or null when argv[0] is not a shell.
 * `o`/`O` in a `-`/`+` cluster take the next word as an option name (`-eo pipefail`, `-O extglob`).
 */
export function shellInvocation(argv0) {
  const r = parseShellArgs(argv0);
  if (r === null || r.mode !== 'file') return r;
  return { mode: 'file', kind: r.kind };
}

/**
 * The script file a shell runs (`bash x.sh`, `sh -e ./x`): {file, kind} (file may be UNKNOWN), or
 * null when argv is not a shell given a file operand (-c code, stdin, an opaque option).
 */
export function shellScriptFile(argv0) {
  const r = parseShellArgs(argv0);
  return r !== null && r.mode === 'file' ? { file: r.file, kind: r.kind } : null;
}

/**
 * Is the word a path that names a process's stdin or another inherited descriptor: `-`, /dev/stdin,
 * /dev/fd/N, /proc/<pid|self>/fd/N (read lexically: `.`, `..` and repeated slashes collapsed)?
 * Returns 'stdin' for descriptor 0, 'fd' for another descriptor, null otherwise.
 */
export function stdinPath(word) {
  if (!isStr(word)) return null;
  if (word === '-') return 'stdin';
  if (!word.startsWith('/')) return null;
  const segs = [];
  for (const seg of word.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  const p = `/${segs.join('/')}`;
  if (p === '/dev/stdin') return 'stdin';
  const m = /^\/(?:dev\/fd|proc\/[^/]+\/fd)\/([0-9]+)$/.exec(p);
  if (m) return Number(m[1]) === 0 ? 'stdin' : 'fd';
  if (/^\/(?:dev\/fd|proc\/[^/]+\/fd)(?:\/|$)/.test(p)) return 'fd';
  return null;
}

// shellInvocation's parse; a file mode also carries the operand.
function parseShellArgs(argv0) {
  const argv = appletArgv(argv0);
  if (!Array.isArray(argv) || !isStr(argv[0])) return null;
  const base = baseName(argv[0]);
  if (!SHELLS.has(base)) return null;
  const kind = shellKind(base);
  let c = false;
  let s = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return opaque('unknown', 'nested-script'); // may be -c
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      if (!SHELL_LONG.has(a)) return opaque('unsupported', 'shell-option');
      continue;
    }
    if (a.length < 2 || (a[0] !== '-' && a[0] !== '+')) break;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === 'c') c = true;
      else if (ch === 's') s = true;
      else if (ch === 'o' || ch === 'O') {
        i++;
        if (i >= argv.length || !isStr(argv[i])) return opaque('unknown', 'shell-option');
      } else if (!/[A-Za-z]/.test(ch)) return opaque('unsupported', 'shell-option');
    }
  }
  if (c) return i < argv.length ? { mode: 'c', text: argv[i], kind } : opaque('unknown', 'nested-script');
  if (s || i >= argv.length) return { mode: 'stdin', kind };
  return { mode: 'file', kind, file: argv[i] };
}

// ---------------------------------------------------------------------------------------------
// Decoders

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Bytes as text: valid UTF-8, no NUL, within MAX_DECODED; else a feed error.
function asText(bytes) {
  if (bytes.length > MAX_DECODED) return feedError('size', 'decode');
  if (bytes.includes(0)) return DECODE();
  try {
    return UTF8.decode(bytes);
  } catch {
    return DECODE();
  }
}

/** Literal base64 (or base64url) text, whitespace ignored, padding optional: the text, or a feed error. */
export function decodeBase64(text) {
  if (!isStr(text)) return DECODE();
  const s = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return DECODE();
  const body = s.replace(/=+$/, '');
  if (body.length % 4 === 1) return DECODE();
  if (s.length !== body.length && s.length % 4 !== 0) return DECODE();
  return asText(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/** Literal hex text (`xxd -r -p`), whitespace ignored: the text, or a feed error. */
export function decodeHex(text) {
  if (!isStr(text)) return DECODE();
  const s = text.replace(/\s+/g, '');
  if (!/^[0-9A-Fa-f]*$/.test(s) || s.length % 2 !== 0) return DECODE();
  return asText(Buffer.from(s, 'hex'));
}

const SIMPLE_ESCAPES = { n: 10, t: 9, r: 13, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

/**
 * The output of `printf FORMAT ARGS…` (literal words), or null when the call is not one this
 * models (`printf -v`, no format), or a feed error for an escape or directive outside the subset
 * (\n \t \r \\ \a \b \f \v \xH \xHH, %s, %%) or an output over MAX_DECODED. The format is reused
 * while arguments remain, as printf does.
 */
export function printfOutput(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every(isStr)) return null;
  const format = argv[1];
  if (format.startsWith('-')) return null;
  const args = argv.slice(2);
  const bytes = [];
  const push = (b) => bytes.push(b);
  const pushText = (t) => {
    for (const b of Buffer.from(t, 'utf8')) bytes.push(b);
  };
  let ai = 0;
  for (;;) {
    let used = 0;
    for (let k = 0; k < format.length; k++) {
      const ch = format[k];
      if (ch === '\\') {
        const e = format[k + 1];
        if (e === undefined) return DECODE();
        if (Object.hasOwn(SIMPLE_ESCAPES, e)) {
          push(SIMPLE_ESCAPES[e]);
          k++;
        } else if (e === 'x' && HEX_DIGIT.test(format[k + 2] || '')) {
          const two = HEX_DIGIT.test(format[k + 3] || '');
          push(parseInt(format.slice(k + 2, k + (two ? 4 : 3)), 16));
          k += two ? 3 : 2;
        } else return DECODE();
      } else if (ch === '%') {
        const d = format[k + 1];
        if (d === '%') push(37);
        else if (d === 's') {
          if (ai < args.length) {
            pushText(args[ai++]);
            used++;
          }
        } else return DECODE();
        k++;
      } else {
        // a surrogate pair is one character: encode both halves together
        const lit = String.fromCodePoint(format.codePointAt(k));
        pushText(lit);
        k += lit.length - 1;
      }
      if (bytes.length > MAX_DECODED) return feedError('size', 'decode');
    }
    if (used === 0 || ai >= args.length) break;
  }
  return asText(Uint8Array.from(bytes));
}

// `echo` output: only -n, no backslash anywhere (zsh's echo reads escapes, bash's does not), no
// other option-like first word.
function echoOutput(argv) {
  let i = 1;
  let nl = true;
  while (i < argv.length && argv[i] === '-n') {
    nl = false;
    i++;
  }
  const rest = argv.slice(i);
  if (rest.length > 0 && rest[0].startsWith('-')) return null;
  if (rest.some((w) => w.includes('\\'))) return null;
  return rest.join(' ') + (nl ? '\n' : '');
}

const onlyFlags = (args, allowed) => args.every((a) => allowed.includes(a));

// stdout of a filter given its input (a literal string, null, or a feed error).
function filterOutput(argv, input) {
  const prog = argv[0];
  const args = argv.slice(1);
  let decode = null;
  if (prog === 'cat') {
    if (args.length === 0 || (args.length === 1 && args[0] === '-')) return input;
    return null;
  }
  if (prog === 'base64' && args.length > 0 && onlyFlags(args, ['-d', '--decode', '-D'])) decode = decodeBase64;
  else if (prog === 'openssl' && args[0] === 'base64' && args.includes('-d') && onlyFlags(args.slice(1), ['-d', '-A'])) decode = decodeBase64;
  else if (
    prog === 'openssl' &&
    args[0] === 'enc' &&
    args.includes('-d') &&
    (args.includes('-base64') || args.includes('-a')) &&
    onlyFlags(args.slice(1), ['-d', '-A', '-base64', '-a'])
  ) {
    decode = decodeBase64;
  } else if (
    prog === 'xxd' &&
    args.some((a) => a === '-r' || a === '-revert') &&
    args.some((a) => a === '-p' || a === '-ps' || a === '-plain' || a === '-postscript') &&
    onlyFlags(args, ['-r', '-revert', '-p', '-ps', '-plain', '-postscript'])
  ) {
    decode = decodeHex;
  }
  if (decode === null) return null;
  if (!isStr(input)) return input; // null stays null, a feed error stays an error
  return decode(input);
}

/** A heredoc's literal body: the raw body for a quoted delimiter, the text when nothing expands, else null. */
export function heredocLiteral(r) {
  if (r.quoted) return isStr(r.body) ? r.body : null;
  if (!Array.isArray(r.parts) || !r.parts.every((p) => p && p.type === 'lit' && isStr(p.text))) return null;
  return r.parts.map((p) => p.text).join('');
}

// What a pipeline member writes to the pipe, from its literal words and stdin: a string, null
// (not literal / not modelled), or a feed error.
function outputOf(node, input) {
  if (!node || node.type !== 'simple' || node.words.length === 0) return null;
  let stdin = input;
  for (const r of node.redirs) {
    const fd0 = r.fd === undefined || r.fd === 0;
    if ((r.op === '<<' || r.op === '<<-') && fd0) stdin = heredocLiteral(r);
    else if (r.op === '<<<' && fd0) {
      const v = r.target ? literalValue(r.target) : null;
      stdin = v === null ? null : `${v}\n`;
    } else return null; // stdout may go elsewhere, stdin may be a file
  }
  const argv = node.words.map(literalValue);
  if (argv.some((w) => w === null)) return null;
  if (argv[0] === 'echo') return echoOutput(argv);
  if (argv[0] === 'printf') return printfOutput(argv);
  return filterOutput(argv, stdin);
}

/**
 * What each pipeline member reads from the pipe before it: feeds[i] for i ≥ 1 is a literal string,
 * null, or a feed error (feeds[0] is null: the pipeline's own stdin is not modelled here).
 */
export function pipeFeeds(commands, ops) {
  const feeds = [null];
  try {
    for (let i = 0; i + 1 < commands.length; i++) {
      const out = outputOf(commands[i], i === 0 ? null : feeds[i]);
      feeds.push(Array.isArray(ops) && ops[i] === '|&' ? null : out);
    }
  } catch {
    while (feeds.length < commands.length) feeds.push(null);
  }
  return feeds;
}

/** bash (without globstar) reads `**` as `*`: a pattern with two unescaped stars in a row is not trusted. */
export function bashGlobUnknown(pattern) {
  if (!isStr(pattern)) return true;
  let prevStar = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      prevStar = false;
    } else if (c === '*') {
      if (prevStar) return true;
      prevStar = true;
    } else prevStar = false;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Plans

const RESET_WRAPPERS = new Set(['sudo', 'doas', 'env']);

/** Did a stripped wrapper layer replace the environment (sudo, doas, env)? */
export function resetsEnv(layers) {
  return Array.isArray(layers) && layers.some((l) => Array.isArray(l) && isStr(l[0]) && RESET_WRAPPERS.has(baseName(l[0])));
}

function scriptPlan(s, c) {
  if (s.name === 'sudo' || s.name === 'doas') return opaque('unsupported', 'nested-script');
  if (!isStr(s.text) || s.exact !== true) return opaque('unknown', 'nested-script');
  if (s.name === 'env') {
    if (!ENV_S_PLAIN.test(s.text)) return opaque('unsupported', 'nested-script');
    return { text: `env ${s.text}`, child: { kind: 'bash', subshell: true, stdin: c.fed === true, reset: true } };
  }
  return { text: s.text, child: { kind: 'bash', subshell: true, stdin: c.fed === true, reset: c.reset === true } };
}

function feedPlan(c, kind) {
  const f = c.feed;
  if (isStr(f)) return { text: f, child: { kind, subshell: true, stdin: true, reset: c.reset === true } };
  if (isFeedError(f)) return opaque(f.reason, f.construct);
  return opaque('unsupported', 'stdin-interpreter');
}

function commandPlan(argv, c) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const fed = c.fed === true;
  // sudo/doas left as the command: a shell option (-s/-i) or no command operand starts a shell
  // that reads stdin; re-parsing through sudo's shell is not supported
  if (fed && isStr(argv[0]) && PRIVILEGE.has(baseName(argv[0]))) return opaque('unsupported', 'stdin-interpreter');
  const foreign = foreignShell(argv, fed);
  if (foreign) return foreign;
  if (argv[0] === 'eval') {
    const args = argv.slice(1);
    if (args.some((a) => !isStr(a))) return opaque('unknown', 'eval-dynamic');
    if (args.length > 0 && args[0].startsWith('-')) return opaque('unsupported', 'eval-dynamic');
    if (args.length === 0) return fed ? opaque('unsupported', 'stdin-interpreter') : null;
    return { text: args.join(' '), child: { kind: c.kind === 'bash' ? 'bash' : 'zsh', subshell: false, stdin: fed, reset: false } };
  }
  const inv = shellInvocation(argv);
  if (inv === null) return null;
  if (inv.opaque) return inv;
  if (inv.mode === 'c') {
    if (!isStr(inv.text)) return opaque('unknown', 'nested-script');
    return { text: inv.text, child: { kind: inv.kind, subshell: true, stdin: fed, reset: c.reset === true } };
  }
  if (inv.mode === 'file') {
    // a file operand that is stdin (`bash /dev/stdin`, `sh /dev/fd/0`, `bash /proc/self/fd/0`)
    // keeps the stdin rule; another descriptor is never literal
    const sp = parseShellArgs(argv).file;
    const kind = stdinPath(sp);
    if (kind === 'stdin') return fed ? feedPlan(c, inv.kind) : opaque('unsupported', 'stdin-interpreter');
    if (kind === 'fd') return opaque('unsupported', 'stdin-interpreter');
    // any other file: its code comes from the file, which the normalizer reads (resolve/script.mjs)
    return null;
  }
  if (!fed) return null;
  return feedPlan(c, inv.kind);
}

/**
 * The commands a finished effective command runs as nested shell code, re-parsed through
 * ctx.reparse, or {opaque}. depth is the nesting level the command itself sits at. Never throws.
 * @param {{argv: any[]}} eff
 * @param {number} depth
 * @param {object} ctx
 */
export function unwrap(eff, depth, ctx) {
  try {
    const c = ctx !== null && typeof ctx === 'object' ? ctx : {};
    if (!eff || !Array.isArray(eff.argv)) return opaque('internal', 'unwrap');
    const plan = [];
    for (const s of Array.isArray(c.scripts) ? c.scripts : []) {
      const p = scriptPlan(s, c);
      if (p.opaque) return p;
      plan.push(p);
    }
    const p = commandPlan(eff.argv, c);
    if (p && p.opaque) return p;
    if (p) plan.push(p);
    if (plan.length === 0) return [];
    if (!Number.isInteger(depth) || depth + 1 > MAX_REPARSE_DEPTH) return opaque('depth', 'nested-shell');
    if (typeof c.reparse !== 'function') return opaque('internal', 'reparse');
    const out = [];
    for (const item of plan) {
      const r = c.reparse(item.text, depth + 1, item.child);
      if (!Array.isArray(r)) return r && r.opaque ? { opaque: r.opaque } : opaque('internal', 'reparse');
      for (const x of r) out.push(x);
    }
    return out;
  } catch {
    return opaque('internal', 'unwrap');
  }
}

