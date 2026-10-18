// Wrapper programs and their flag tables (spec, "Normalizer": Unwrapping). A wrapper runs another
// command; stripping it decides which program really runs, so every doubt is opaque.
//
//   stripWrappers(argv) -> {inner, wrappers, scripts, layers, env, chdirs, reads, writes, execs, external}
//                        | {opaque: {reason, construct}}
//   stripOne(argv)      -> one layer of the above, or null when argv[0] is not a wrapper call
//   findExecs(argv)     -> {execs: [{argv, dir}]} | {opaque} | null: the commands find -exec runs
//   shellScript(argv)   -> the code word of `sh -c CODE` (and bash, zsh, dash, ksh), or null
//
// inner     the command that runs after every wrapper layer is removed (argv unchanged when none)
// wrappers  the names of the stripped layers, outermost first; layers holds their full argv
// scripts   text a wrapper runs as a shell script (env -S, flock -c, watch, sudo -s/-i, doas -s);
//           stripping stops at such a layer, and inner is that layer's argv
// env       NAME=VALUE assignments a wrapper adds to the inner command (env, sudo)
// chdirs    directories the inner command is moved to, in order (env -C, sudo -D), as words
// reads/writes  words a wrapper flag reads or writes (xargs -a, time -o, the flock lock file),
//           relative to the directory the wrapper itself runs in
// execs     find -exec/-execdir/-ok/-okdir clauses: {argv, dir: 'same'|'unknown'}, `{}` (and any
//           word containing it) UNKNOWN; find itself stays the command and keeps its own effects
// external  true when a layer runs the command as a new process (everything except builtin,
//           command, noglob and nocorrect): a cd there cannot move the shell
//
// Rules (carry-T15): each flag has an arity and at most one effect; the tables are the union of
// GNU and BSD spellings; a long option matches exactly or by unique prefix, and an ambiguous prefix
// takes the union of its candidates' effects (opaque when their arities disagree). An unknown flag,
// a value given to a flag that takes none, a missing value, or an UNKNOWN word where a flag or the
// program name goes is opaque. Nesting is bounded by MAX_WRAP_DEPTH layers.
//
// The flag data is derived from Handrail v0.5.1's wrapper tables (github.com/svyatov/handrail, MIT;
// see NOTICE), checked against the upstream manuals cited on each row.

import { UNKNOWN } from '../norm/unknown.mjs';

const isStr = (w) => typeof w === 'string';

/** Most wrapper layers stripped from one command (find counts as a layer for its clauses). */
export const MAX_WRAP_DEPTH = 8;

// ---------------------------------------------------------------------------------------------
// Data. `short`: letters; `:` after a letter = takes a value (attached or the next word), `::` =
// optional value (attached only). `long`: names; `=` suffix = takes a value (`--x=v` or `--x v`),
// `?` suffix = optional value (`--x=v` only). `effects`: flag (letter or long name) -> effect:
//   read | write   the value is a path read or written
//   chdir          the value is the inner command's directory
//   script         the value is shell text the wrapper runs
//   stop           not a command run (prints, edits, checks): the call is left unstripped
//   opaque         the inner command's paths cannot be tracked (chroot)
//   replace        xargs replace string (value, `{}` when none): words containing it are UNKNOWN
//   shell          the command words are joined into a shell script (sudo -s/-i, doas -s)
//   exec           watch -x: the command words run directly, not through sh -c
// `operands`: positional words before the command (timeout DURATION, flock FILE); `assigns`:
// NAME=VALUE words before the command go to its environment; `internal`: runs in the current
// shell; `noOptions`: the next word is the command, whatever it looks like.

const TABLE = {
  // GNU coreutils timeout --help; FreeBSD/macOS timeout(1)
  timeout: {
    short: 'fk:ps:v',
    long: 'foreground kill-after= preserve-status signal= verbose help version',
    operands: 1,
  },
  // GNU time 1.9 --help; FreeBSD/macOS time(1)
  time: {
    short: 'af:hlo:pqv',
    long: 'append format= output= portability quiet verbose help version',
    effects: { o: 'write', output: 'write' },
  },
  // GNU coreutils nice --help (obsolete -N); FreeBSD/macOS nice(1)
  nice: { short: 'n:0123456789', long: 'adjustment= help version' },
  // GNU coreutils nohup --help; FreeBSD/macOS nohup(1). nohup.out is written only when stdout is a
  // terminal, which an agent's tool call never has.
  nohup: { long: 'help version' },
  // GNU coreutils stdbuf --help; FreeBSD stdbuf(1)
  stdbuf: { short: 'e:i:o:', long: 'error= input= output= help version' },
  // bash manual, Bash Builtins: command [-pVv]
  command: { short: 'pvV', effects: { v: 'stop', V: 'stop' }, internal: true },
  // bash manual, Bash Builtins: builtin [shell-builtin [args]]
  builtin: { internal: true },
  // zsh manual, Precommand Modifiers
  noglob: { noOptions: true, internal: true },
  nocorrect: { noOptions: true, internal: true },
  // bash manual, Bourne Shell Builtins: exec [-cl] [-a name]; zsh exec [-cl] [-a argv0]
  exec: { short: 'a:cl' },
  // sudo 1.9 sudo(8); its getopt string makes -h's host an optional attached value
  sudo: {
    short: 'ABbEeHh::iKklNnPSsVva:c:C:D:g:p:R:r:T:t:U:u:',
    long:
      'askpass auth-type= background bell close-from= chdir= preserve-env? edit group= set-home help host= login ' +
      'login-class= remove-timestamp reset-timestamp list no-update non-interactive preserve-groups prompt= chroot= ' +
      'role= stdin shell type= command-timeout= other-user= user= version validate',
    effects: {
      e: 'stop',
      edit: 'stop',
      D: 'chdir',
      chdir: 'chdir',
      R: 'opaque',
      chroot: 'opaque',
      s: 'shell',
      shell: 'shell',
      i: 'shell',
      login: 'shell',
    },
    assigns: true,
  },
  // GNU coreutils env --help (9.x); FreeBSD/macOS env(1)
  env: {
    short: '0a:iC:L:P:S:U:u:v',
    long:
      'ignore-environment null unset= chdir= split-string= argv0= ignore-signal? default-signal? block-signal? ' +
      'list-signal-handling debug help version',
    effects: { C: 'chdir', chdir: 'chdir', S: 'script', 'split-string': 'script' },
    assigns: true,
  },
  // OpenBSD doas(1); OpenDoas doas(1)
  doas: { short: 'a:C:Lnsu:', effects: { C: 'stop', s: 'shell' } },
  // util-linux setsid(1)
  setsid: { short: 'cfwhV', long: 'ctty fork wait help version' },
  // util-linux flock(1); the operand is the lock file (created when missing) or a descriptor
  flock: {
    short: 'c:eE:FhnosuVw:x',
    long: 'command= shared exclusive unlock nonblock nb no-fork close wait= timeout= conflict-exit-code= verbose help version',
    effects: { c: 'script', command: 'script' },
    operands: 1,
  },
  // procps-ng watch(1): the command words are joined and run with sh -c, unless -x/--exec
  watch: {
    short: 'bcCd::eghn:pq:rs:tvwx',
    long:
      'beep color no-color differences? exec chgexit errexit help interval= precise equexit= no-rerun shotsdir= ' +
      'no-title version no-wrap',
    effects: { x: 'exec', exec: 'exec' },
  },
  // GNU findutils xargs --help; FreeBSD/macOS xargs(1). The command's stdin is not the pipe.
  xargs: {
    short: '0a:d:E:e::I:i::J:L:l::n:oP:prR:S:s:tx',
    long:
      'null arg-file= delimiter= eof? replace? max-lines? max-args= max-procs= interactive no-run-if-empty ' +
      'max-chars= verbose exit open-tty process-slot-var= show-limits help version',
    effects: { a: 'read', 'arg-file': 'read', I: 'replace', i: 'replace', replace: 'replace', J: 'replace' },
  },
};

// find primaries that take one argument in every implementation (GNU findutils find(1),
// FreeBSD/macOS find(1)), and the ones that run a command. A primary whose arity differs (BSD
// `-depth N`, GNU `-depth`) is left out: consuming a word that is really `-exec` would hide a clause,
// while an unknown primary only makes find fail.
const FIND_ARG1 = new Set(
  (
    '-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -type -xtype -user -group -uid ' +
    '-gid -perm -size -mtime -atime -ctime -mmin -amin -cmin -links -inum -fstype -context -printf -maxdepth ' +
    '-mindepth -regextype -used -newer -anewer -cnewer -samefile -fprint -fprint0 -fls -files0-from -Bmin -Bnewer ' +
    '-Btime -flags -mnewer'
  ).split(' '),
);
const FIND_EXEC = { '-exec': 'same', '-ok': 'same', '-execdir': 'unknown', '-okdir': 'unknown' };
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

// ---------------------------------------------------------------------------------------------
// Grammar

const GRAMMARS = new Map();
function grammarOf(name) {
  if (GRAMMARS.has(name)) return GRAMMARS.get(name);
  const t = TABLE[name];
  const effects = t.effects || {};
  const short = new Map();
  const s = t.short || '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let arity = 'none';
    if (s[i + 1] === ':' && s[i + 2] === ':') {
      arity = 'opt';
      i += 2;
    } else if (s[i + 1] === ':') {
      arity = 'one';
      i += 1;
    }
    short.set(c, { arity, effect: effects[c] });
  }
  const long = new Map();
  for (const field of (t.long || '').split(' ').filter(Boolean)) {
    const last = field[field.length - 1];
    const bare = last === '=' || last === '?' ? field.slice(0, -1) : field;
    long.set(bare, { arity: last === '=' ? 'one' : last === '?' ? 'opt' : 'none', effect: effects[bare] });
  }
  const g = { ...t, shortMap: short, longMap: long };
  GRAMMARS.set(name, g);
  return g;
}

// A long option: exact, else every option it is a prefix of (union of effects; arities must agree).
function lookupLong(g, name) {
  if (g.longMap.has(name)) return { arity: g.longMap.get(name).arity, effects: [g.longMap.get(name).effect] };
  const hits = [...g.longMap.keys()].filter((k) => k.startsWith(name));
  if (hits.length === 0) return null;
  const arities = new Set(hits.map((k) => g.longMap.get(k).arity));
  if (arities.size > 1) return null;
  return { arity: [...arities][0], effects: hits.map((k) => g.longMap.get(k).effect) };
}

// GNU programs installed with a `g` prefix (Homebrew coreutils/findutils/time on macOS).
const G_PREFIXED = new Set(['timeout', 'xargs', 'env', 'nice', 'nohup', 'stdbuf', 'time']);

/**
 * The wrapper a program word names: basename, exact, then lower case (case-insensitive volumes),
 * then without the `g` of a GNU-prefixed name (gtimeout, gxargs, …).
 */
function wrapperName(word) {
  if (!isStr(word)) return null;
  const base = word.slice(word.lastIndexOf('/') + 1);
  if (Object.hasOwn(TABLE, base)) return base;
  const lower = base.toLowerCase();
  if (Object.hasOwn(TABLE, lower)) return lower;
  if (lower.length > 1 && lower[0] === 'g' && G_PREFIXED.has(lower.slice(1))) return lower.slice(1);
  return null;
}

/**
 * The options of a wrapper that take a separate value, for option parsers elsewhere (classes.mjs
 * reads env's own options with these): {short: letters, long: ['--name', …]}.
 */
export function valueFlags(name) {
  const g = grammarOf(name);
  return {
    short: [...g.shortMap].filter(([, v]) => v.arity === 'one').map(([k]) => k).join(''),
    long: [...g.longMap].filter(([, v]) => v.arity === 'one').map(([k]) => `--${k}`),
  };
}

const opaque = (reason, construct) => ({ opaque: { reason, construct } });
const badFlag = () => opaque('unsupported', 'wrapper-flag');
const badWord = () => opaque('unknown', 'command-word');
const joinScript = (ws) => (ws.every(isStr) ? ws.join(' ') : UNKNOWN);

// ---------------------------------------------------------------------------------------------
// One layer

/**
 * Strip one wrapper layer. Returns null when argv[0] is not a wrapper or the call runs no command
 * (`env`, `nice`, `timeout 5`, `command -v x`, `sudo -e f`), {opaque} on any doubt, or
 * {name, inner, env, chdirs, reads, writes, external} / {name, script, external} for a script.
 * opts.bareHead: the caller has checked that argv is the whole command and its first word is a
 * bare, unquoted literal with no assignment before it. Only then is `time` (spelled exactly
 * `time`, with no options: zsh's keyword takes none) the reserved word, which runs its command in
 * the current shell (not external). Every other `time` is a program.
 */
export function stripOne(argv, opts = {}) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const name = wrapperName(argv[0]);
  if (name === null) return null;
  const g = grammarOf(name);
  const out = { name, inner: null, env: {}, chdirs: [], reads: [], writes: [], external: !g.internal };
  let replace = null;
  let shell = false;
  let execMode = false;
  let script;
  let stop = false;
  let bad = null;
  const apply = (effect, value) => {
    switch (effect) {
      case 'read':
        out.reads.push(value);
        break;
      case 'write':
        out.writes.push(value);
        break;
      case 'chdir':
        out.chdirs.push(value);
        break;
      case 'script':
        script = value;
        break;
      case 'stop':
        stop = true;
        break;
      case 'opaque':
        bad = badFlag();
        break;
      case 'replace':
        replace = isStr(value) && value !== '' ? value : '{}';
        break;
      case 'shell':
        shell = true;
        break;
      case 'exec':
        execMode = true;
        break;
      default:
        break;
    }
  };

  let i = 1;
  let assigning = false;
  if (!g.noOptions) {
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (!isStr(a)) return badWord(); // a flag or the program: unknowable
      if (g.assigns && ASSIGNMENT.test(a)) {
        const [, k, v] = ASSIGNMENT.exec(a);
        Object.defineProperty(out.env, k, { value: v, enumerable: true, writable: true, configurable: true });
        assigning = true;
        continue;
      }
      if (assigning) break; // options end at the first non-option word
      if (a === '--') {
        i++;
        break;
      }
      if (name === 'env' && a === '-') continue; // POSIX spelling of -i
      if (a.length < 2 || a[0] !== '-') break;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const raw = (eq < 0 ? a : a.slice(0, eq)).slice(2);
        // nice --N: an obsolete negative adjustment
        if (name === 'nice' && /^[0-9]+$/.test(raw) && eq < 0) continue;
        const hit = lookupLong(g, raw);
        if (hit === null) return badFlag();
        let value;
        if (hit.arity === 'none') {
          if (eq >= 0) return badFlag();
        } else if (eq >= 0) value = a.slice(eq + 1);
        else if (hit.arity === 'one') {
          if (i + 1 >= argv.length) return badFlag();
          value = argv[++i];
        }
        for (const e of hit.effects) apply(e, value);
      } else {
        for (let k = 1; k < a.length; k++) {
          const c = a[k];
          const spec = g.shortMap.get(c);
          if (!spec) return badFlag();
          if (spec.arity === 'none') {
            apply(spec.effect, undefined);
            continue;
          }
          const rest = a.slice(k + 1);
          let value;
          if (rest !== '') value = rest;
          else if (spec.arity === 'one') {
            if (i + 1 >= argv.length) return badFlag();
            value = argv[++i];
          }
          apply(spec.effect, value);
          break;
        }
      }
      if (bad) return bad;
      if (stop) return null; // prints, edits or checks: whatever follows is not run
    }
  }
  if (bad) return bad;
  if (stop) return null;
  if (script !== undefined) return { name, script, external: out.external };

  // positional operands before the command
  for (let n = 0; n < (g.operands || 0); n++, i++) {
    if (i >= argv.length) return null; // `timeout 5`, `flock 9`: no command
    // flock FILE cmd: the operand is a lock file flock creates, digits included (`flock 9 cmd`);
    // `flock 9` alone (a descriptor) runs no command and is not stripped
    if (name === 'flock') out.writes.push(argv[i]);
  }
  if (name === 'flock' && i < argv.length) {
    const a = argv[i];
    if (a === '-c' || a === '--command') {
      return i + 1 < argv.length ? { name, script: argv[i + 1], external: true } : badFlag();
    }
    if (isStr(a) && a.startsWith('--command=')) return { name, script: a.slice(10), external: true };
    if (isStr(a) && a.startsWith('-c') && a.length > 2) return { name, script: a.slice(2), external: true };
  }

  let inner = argv.slice(i);
  if (name === 'xargs') {
    if (inner.length === 0) inner = ['echo'];
    inner = replace !== null ? inner.map((w) => (isStr(w) && w.includes(replace) ? UNKNOWN : w)) : [...inner, UNKNOWN];
  }
  if (inner.length === 0) return null;
  if (name === 'watch' && !execMode) return { name, script: joinScript(inner), external: true };
  if (shell) return { name, script: joinScript(inner), external: true };
  if (!isStr(inner[0])) return badWord();
  if (name === 'time' && argv[0] === 'time' && opts.bareHead === true && i === 1) out.external = false;
  out.inner = inner;
  return out;
}

// ---------------------------------------------------------------------------------------------
// find

/** The commands `find … -exec|-execdir|-ok|-okdir cmd … ;|+` runs, or null when argv is not find. */
export function findExecs(argv) {
  if (!Array.isArray(argv) || !isStr(argv[0])) return null;
  const base = argv[0].slice(argv[0].lastIndexOf('/') + 1);
  if (base !== 'find' && base.toLowerCase() !== 'find' && base.toLowerCase() !== 'gfind') return null;
  const execs = [];
  let i = 1;
  // leading options
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) break;
    if (/^-[HLPEXdsx]+$/.test(a) || /^-O[0-9]?$/.test(a)) continue;
    if (a === '-D' || a === '-f') {
      i++;
      continue;
    }
    break;
  }
  // start paths (an UNKNOWN start is a path: find's own row widens its classes for it)
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (isStr(a) && ((a.startsWith('-') && a.length > 1) || a === '(' || a === ')' || a === '!' || a === ',')) break;
  }
  // the expression
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return opaque('unsupported', 'wrapper-flag'); // may be -exec
    if (Object.hasOwn(FIND_EXEC, a)) {
      const clause = [];
      let j = i + 1;
      for (; j < argv.length; j++) {
        const w = argv[j];
        if (w === ';' || w === '\\;' || (w === '+' && clause.length > 0 && argv[j - 1] === '{}')) break;
        clause.push(w);
      }
      i = j;
      if (clause.length === 0) continue;
      const words = clause.map((w) => (isStr(w) && w.includes('{}') ? UNKNOWN : w));
      if (!isStr(words[0])) return badWord();
      execs.push({ argv: words, dir: FIND_EXEC[a] });
    } else if (a === '-fprintf' || /^-newer[aBcmt][aBcmt]$/.test(a)) i += a === '-fprintf' ? 2 : 1;
    else if (FIND_ARG1.has(a)) i++;
  }
  return { execs };
}

/**
 * `sh -c CODE …` (or a cluster containing c, before the first operand): CODE, else null. Each `o`
 * or `O` in a `-`/`+` cluster takes the next word as its option name (`bash -eo pipefail -c`,
 * `bash -O extglob -c`, `+o posix`); long options (`--norc`) take none.
 */
export function shellScript(argv) {
  if (!Array.isArray(argv) || !isStr(argv[0])) return null;
  const base = argv[0].slice(argv[0].lastIndexOf('/') + 1).toLowerCase();
  if (!SHELLS.has(base)) return null;
  let c = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return c ? UNKNOWN : null;
    if (a === '--' || a === '-') return c ? (i + 1 < argv.length ? argv[i + 1] : UNKNOWN) : null;
    if (!/^[-+]/.test(a)) return c ? a : null;
    if (a.startsWith('--')) continue;
    const letters = a.slice(1);
    if (letters.includes('c')) c = true;
    for (const ch of letters) if (ch === 'o' || ch === 'O') i++; // the option name
  }
  return c ? UNKNOWN : null;
}

// ---------------------------------------------------------------------------------------------
// All layers

/**
 * Strip every wrapper layer from argv (pure; directories and paths are left as words).
 * opts.bareHead: argv[0] was a bare unquoted word with no assignment before it (see stripOne).
 * @param {(string|typeof UNKNOWN)[]} argv
 */
export function stripWrappers(argv, opts = {}) {
  const r = { inner: argv, wrappers: [], scripts: [], layers: [], env: {}, chdirs: [], reads: [], writes: [], execs: [], external: false };
  let cur = argv;
  for (;;) {
    const one = stripOne(cur, { bareHead: r.layers.length === 0 && opts.bareHead === true });
    if (one === null) break;
    if (one.opaque) return one;
    if (one.script !== undefined) {
      r.scripts.push(one.script);
      break;
    }
    if (r.layers.length >= MAX_WRAP_DEPTH) return opaque('depth', 'unwrap');
    r.layers.push(cur);
    r.wrappers.push(one.name);
    if (one.external) r.external = true;
    for (const k of Object.keys(one.env)) Object.defineProperty(r.env, k, { value: one.env[k], enumerable: true, writable: true, configurable: true });
    r.chdirs.push(...one.chdirs);
    r.reads.push(...one.reads);
    r.writes.push(...one.writes);
    cur = one.inner;
  }
  r.inner = cur;
  if (r.scripts.length === 0) {
    const f = findExecs(cur);
    if (f && f.opaque) return f;
    if (f) r.execs = f.execs;
  }
  return r;
}
