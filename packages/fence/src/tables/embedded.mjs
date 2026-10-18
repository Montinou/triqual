// Programs that run embedded code (spec, "Normalizer": the embedded-code paragraph of the command
// classes, and "Interpreter inline code"). Data plus small parsers; nothing here runs anything.
//
//   embeddedCodeVerdict(argv) -> 'ok' | 'opaque'
//       argv is a command after wrapper unwrapping (strings or UNKNOWN). 'opaque' when the program
//       can run code its words carry and its flags and script are not proven clean:
//         rg --pre (and --hostname-bin), fd/fdfind -x/-X/--exec/--exec-batch
//         find -exec/-execdir/-ok/-okdir with an UNKNOWN word in the clause
//         awk/gawk/mawk/nawk: a program text holding system, a pipe (| or |&), output redirection
//             (> or >> in a print/printf statement), getline from a redirection, an `@` (gawk
//             directives, indirect calls), or an UNKNOWN program; options outside AWK_OPTIONS;
//             `-f`/`-E`/`-i` files are runs-repo-code (embeddedCode().files), `-l` loads a library
//         sed: the `e` command, the `e` flag of `s`, an unknown command or flag, an UNKNOWN word,
//             an unknown option (`w`/`W` write their file, `r`/`R` read theirs: embeddedCode());
//             `-f` files are runs-repo-code
//         tar: --to-command, --use-compress-program, -I, --checkpoint-action, --info-script /
//             --new-volume-script / -F (long names by unambiguous prefix, old-style letter bundles)
//         ssh/scp/sftp: -F, `-o` with a key in SSH_CODE_OPTIONS, scp/sftp -S, sftp -D and -b
//         git: `-c` / `--config-env` with a key isGitCodeKey() accepts (or an UNKNOWN one)
//         EDITORS_PAGERS: always
//       An UNKNOWN word where an option may stand (before `--`) is opaque for every program here:
//       it may be the option that runs code.
//
//   embeddedCode(argv) -> {verdict, reads, writes, files}
//       reads/writes: the words sed's r/R and w/W name (paths, relative to the command's cwd);
//       files: program files awk -f / sed -f run (a route for the normalizer: runs-repo-code).
//
//   inlineInterpreter(argv) -> null | {lang:'python'|'node', mode:'c'|'stdin', codes, isolated,
//                                      gated} | {opaque: {reason, construct}}
//       How an interpreter gets inline code: python -c (and the program from stdin when no file,
//       module or -c is given), node -e/-p/--eval/--print (and stdin). `gated` names a flag that
//       keeps the code from being checked (node: a preload, loader, env file, inspector or unknown
//       flag; python: -W, -X, -i, an unknown flag). codes are strings or UNKNOWN. Perl, Ruby, PHP,
//       Lua, Tcl, R, Julia, deno eval and bun -e: options parsed per language (OTHER_LANGS,
//       WORD_LANGS); inline code or an option outside the table is opaque `embedded-code`; no
//       operand (or `-`) is {lang, mode:'stdin'} (opaque when stdin is fed).
//
//   isGitCodeKey(key)   a git config key that names a program to run, a file of config, or a
//                       transport that runs commands (GIT_CODE_KEYS)
//   gitConfigWrite(args) -> null | {scope}: what a `git config …` (args after `config`) writes
//                       that can run code: null for a read or a key that runs nothing; scope is
//                       'local' | 'global' | 'system' | 'worktree' | {file}
//   awkProgramSafe(text), sedScript(text): the two tokenizers, exported for tests.
//
// Never throws: an internal error is 'opaque'. Linear in the input.

import { UNKNOWN } from '../norm/unknown.mjs';
import { NODE_OPTIONS_ALLOWED } from './envvars.mjs';

const isStr = (w) => typeof w === 'string';
const words = (s) => s.split(/\s+/).filter(Boolean);
const baseOf = (w) => w.slice(w.lastIndexOf('/') + 1).toLowerCase();

/** Editors, pagers and runners: each can run a command of its own (spec list; data). */
export const EDITORS_PAGERS = Object.freeze(words('less more man vi vim nvim emacs nano ed ex script expect parallel watch entr view gview gvim vimdiff rvim rview pico micro joe emacsclient nvi'));
const EDITORS = new Set(EDITORS_PAGERS);

/** ssh_config keys that run a local command or read another config. */
export const SSH_CODE_OPTIONS = Object.freeze(words('proxycommand localcommand permitlocalcommand knownhostscommand include match'));

/**
 * git config keys (lower case; `*` is one or more subsection characters) that run a program, load
 * more config, or reach a transport that runs commands. The spec's list (alias.*, core.hooksPath,
 * core.sshCommand, core.pager, core.editor, core.fsmonitor, include.*, includeIf.*, filter.*,
 * diff.*.textconv, credential.helper) plus the keys that do the same thing under other names.
 */
export const GIT_CODE_KEYS = Object.freeze([
  'alias.*', 'core.hookspath', 'core.sshcommand', 'core.pager', 'core.editor', 'core.fsmonitor',
  'include.*', 'includeif.*', 'filter.*', 'diff.*.textconv', 'credential.helper',
  // the same effect under other names
  'credential.*.helper', 'core.gitproxy', 'core.askpass', 'core.alternaterefscommand', 'diff.external',
  'diff.*.command', 'merge.*.driver', 'pager.*', 'sequence.editor', 'gpg.program', 'gpg.*.program',
  'uploadpack.packobjectshook', 'protocol.allow', 'protocol.*.allow', 'remote.*.uploadpack',
  'remote.*.receivepack', 'url.*.insteadof', 'url.*.pushinsteadof', 'interactive.difffilter',
  'mergetool.*', 'difftool.*', 'sendemail.*', 'browser.*.cmd',
]);

const GIT_KEY_RES = GIT_CODE_KEYS.map((k) => {
  const parts = k.split('.');
  // alias.* / include.* / filter.* …: anything under the section
  if (parts.length === 2 && parts[1] === '*') return (key) => key.startsWith(`${parts[0]}.`);
  if (parts.length === 2) return (key) => key === k;
  // section.*.name: a subsection of any length (dots included) and the name
  return (key) => key.startsWith(`${parts[0]}.`) && key.endsWith(`.${parts[2]}`) && key.length > parts[0].length + parts[2].length + 2;
});

/** Does setting this git config key make git run code (or read more config)? UNKNOWN: true. */
export function isGitCodeKey(key) {
  if (!isStr(key)) return true;
  const k = key.toLowerCase();
  return GIT_KEY_RES.some((f) => f(k));
}

// ---------------------------------------------------------------------------------------------
// awk

/** Option letters awk takes with a value, and the bool ones accepted (gawk, mawk, POSIX). */
const AWK_VALUE = new Set(['F', 'v', 'f', 'e', 'E', 'i', 'l', 'W']);
const AWK_BOOL = new Set(words('b c C M n N O P r s S t V h'));
const AWK_LONG = Object.freeze({
  value: new Set(words('--field-separator --assign --file --source --exec --include --load')),
  bool: new Set(words('--posix --traditional --compat --re-interval --characters-as-bytes --sandbox --bignum --non-decimal-data --optimize --no-optimize --use-lc-numeric --lint-old --copyright --version --help --usage')),
});

const AWK_FORBIDDEN_NAMES = new Set(['system', 'extension']);
const AWK_STATEMENT_KEYWORDS = new Set(['print', 'printf']);
// keywords after which a `/` starts a regex
const AWK_OPERATOR_WORDS = new Set(['print', 'printf', 'return', 'in', 'case', 'if', 'while', 'for', 'do', 'else', 'getline', 'delete', 'exit']);

/**
 * Is the awk program text free of code that reaches outside its operands: no system(), no pipe,
 * no output redirection, no getline from a redirection, no `@`? A small tokenizer: strings, regex
 * literals (decided by the previous token, as awk's lexer does), comments, line continuations,
 * parentheses; a print/printf statement tracks the paren depth it started at, so `print (a > b)` is
 * a comparison and `print a > "f"` a redirection. Anything it cannot read is unsafe.
 */
export function awkProgramSafe(text) {
  try {
    if (!isStr(text)) return false;
    let i = 0;
    const n = text.length;
    let prev = 'op'; // 'operand' | 'op': what the previous significant token was
    let depth = 0;
    let printAt = -1; // paren depth of the open print/printf statement, -1 when none
    let getline = false; // a getline in the current statement
    const endStatement = () => {
      printAt = -1;
      getline = false;
      prev = 'op';
    };
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t') {
        i++;
        continue;
      }
      if (c === '\\') {
        if (text[i + 1] === '\n') {
          i += 2;
          continue;
        }
        return false;
      }
      if (c === '\n') {
        // a newline after an operator continues the statement (`print a,\n b > "f"`)
        if (prev === 'operand') endStatement();
        i++;
        continue;
      }
      if (c === ';' || c === '{' || c === '}') {
        if (c === '{' || c === '}') {
          if (depth !== 0) return false;
        }
        endStatement();
        i++;
        continue;
      }
      if (c === '#') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (c === '"') {
        i++;
        for (;;) {
          if (i >= n || text[i] === '\n') return false;
          if (text[i] === '\\') {
            if (i + 1 >= n) return false;
            i += 2;
            continue;
          }
          if (text[i] === '"') break;
          i++;
        }
        i++;
        prev = 'operand';
        continue;
      }
      if (c === '/') {
        if (prev === 'operand') {
          i += text[i + 1] === '=' ? 2 : 1;
          prev = 'op';
          continue;
        }
        // a regex literal; no bracket handling, so a `/` inside brackets ends it early and the rest
        // is read as code (only ever more cautious than awk)
        i++;
        for (;;) {
          if (i >= n || text[i] === '\n') return false;
          if (text[i] === '\\') {
            if (i + 1 >= n || text[i + 1] === '\n') return false;
            i += 2;
            continue;
          }
          if (text[i] === '/') break;
          i++;
        }
        i++;
        prev = 'operand';
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
        const name = text.slice(i, j);
        i = j;
        if (AWK_FORBIDDEN_NAMES.has(name)) return false;
        if (AWK_STATEMENT_KEYWORDS.has(name)) printAt = depth;
        if (name === 'getline') getline = true;
        prev = AWK_OPERATOR_WORDS.has(name) ? 'op' : 'operand';
        continue;
      }
      if (/[0-9.]/.test(c)) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(text[j])) {
          // an exponent sign: 1e+5
          if ((text[j] === 'e' || text[j] === 'E') && (text[j + 1] === '+' || text[j + 1] === '-')) j++;
          j++;
        }
        i = j;
        prev = 'operand';
        continue;
      }
      if (c === '(' || c === '[') {
        depth++;
        i++;
        prev = 'op';
        continue;
      }
      if (c === ')' || c === ']') {
        depth--;
        if (depth < 0) return false;
        i++;
        prev = 'operand';
        continue;
      }
      if (c === '|') {
        if (text[i + 1] === '|') {
          i += 2;
          prev = 'op';
          continue;
        }
        return false; // print | "cmd", "cmd" | getline, |&
      }
      if (c === '&') {
        if (text[i + 1] === '&') {
          i += 2;
          prev = 'op';
          continue;
        }
        return false;
      }
      if (c === '>') {
        if (text[i + 1] === '>') return false; // >> is only ever a redirection
        if (printAt >= 0 && depth <= printAt) return false; // print … > file
        i += text[i + 1] === '=' ? 2 : 1;
        prev = 'op';
        continue;
      }
      if (c === '<') {
        if (getline) return false; // getline < file: a read fence does not record
        i += text[i + 1] === '=' ? 2 : 1;
        prev = 'op';
        continue;
      }
      if (c === '+' || c === '-') {
        if (text[i + 1] === c) {
          // ++/--: postfix after an operand keeps it an operand
          i += 2;
          continue;
        }
        i += text[i + 1] === '=' ? 2 : 1;
        prev = 'op';
        continue;
      }
      if (c === '$') {
        i++;
        prev = 'op';
        continue;
      }
      if ('*%^!=~?:,'.includes(c)) {
        i++;
        if (text[i] === '=' || (c === '*' && text[i] === '*')) i++;
        prev = 'op';
        continue;
      }
      return false; // @, backtick, a carriage return, anything else
    }
    return depth === 0;
  } catch {
    return false;
  }
}

function awkCode(argv) {
  const programs = [];
  const files = [];
  let positional = null;
  let haveProgram = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-' || !a.startsWith('-')) break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (AWK_LONG.bool.has(name) && eq < 0) continue;
      if (!AWK_LONG.value.has(name)) return null;
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (!isStr(v)) return null;
      if (name === '--load') return null; // a shared library
      if (name === '--source') programs.push(v);
      else if (name === '--file' || name === '--exec' || name === '--include') files.push(v);
      if (name === '--source' || name === '--file' || name === '--exec') haveProgram = true;
      if (name === '--exec') {
        i++;
        break;
      }
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (AWK_BOOL.has(ch)) continue;
      if (!AWK_VALUE.has(ch)) return null;
      const v = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (!isStr(v)) return null;
      if (ch === 'l' || ch === 'W') return null; // a library; mawk -W exec and friends
      if (ch === 'e') programs.push(v);
      else if (ch === 'f' || ch === 'E' || ch === 'i') files.push(v);
      if (ch === 'e' || ch === 'f' || ch === 'E') haveProgram = true;
      break;
    }
  }
  if (!haveProgram) {
    positional = argv[i];
    if (!isStr(positional)) return null;
    programs.push(positional);
  }
  for (const p of programs) if (!awkProgramSafe(p)) return null;
  return { reads: [], writes: [], files };
}

// ---------------------------------------------------------------------------------------------
// sed

const SED_SIMPLE = new Set(['=', 'd', 'D', 'g', 'G', 'h', 'H', 'n', 'N', 'p', 'P', 'x', 'z', 'F']);
const SED_COUNT = new Set(['q', 'Q', 'l', 'L']);
const SED_LABEL = new Set(['b', 't', 'T']);
const SED_FILE = { r: 'reads', R: 'reads', w: 'writes', W: 'writes' };
const NO_FILE = new Set(['/dev/stdout', '/dev/stderr', '/dev/stdin']);

/**
 * Parse a sed script (GNU and POSIX syntax): {reads, writes} — the files r/R and w/W (also the `w`
 * flag of `s`) name — or {opaque: true} for the `e` command, the `e` flag, or anything the parser
 * cannot read (an unknown command or flag, an unterminated regex or text, unbalanced braces).
 */
export function sedScript(text) {
  const bad = { opaque: true };
  try {
    if (!isStr(text)) return bad;
    const out = { reads: [], writes: [] };
    const n = text.length;
    let i = 0;
    let depth = 0;
    const blank = () => {
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    };
    const toEol = () => {
      const s = i;
      while (i < n && text[i] !== '\n') i++;
      return text.slice(s, i);
    };
    // a delimited part (regex or replacement) up to its closing delimiter: false when unterminated.
    // An unescaped newline ends the command (an error); an escaped one only in a replacement.
    const part = (delim, escapedNewlineOk) => {
      for (;;) {
        if (i >= n) return false;
        const ch = text[i];
        if (ch === '\\') {
          if (i + 1 >= n) return false;
          if (text[i + 1] === '\n' && !escapedNewlineOk) return false;
          i += 2;
          continue;
        }
        if (ch === '\n') return false;
        i++;
        if (ch === delim) return true;
      }
    };
    const regexAddr = () => {
      let delim;
      if (text[i] === '/') delim = '/';
      else if (text[i] === '\\') {
        delim = text[i + 1];
        if (delim === undefined || delim === '\n' || delim === '\\') return false;
        i++;
      } else return null;
      i++;
      if (!part(delim, false)) return false;
      while (text[i] === 'I' || text[i] === 'M') i++;
      return true;
    };
    const address = () => {
      if (/[0-9]/.test(text[i] || '')) {
        while (/[0-9]/.test(text[i] || '')) i++;
        if (text[i] === '~') {
          i++;
          if (!/[0-9]/.test(text[i] || '')) return false;
          while (/[0-9]/.test(text[i] || '')) i++;
        }
        return true;
      }
      if (text[i] === '$') {
        i++;
        return true;
      }
      return regexAddr();
    };
    const fileArg = (kind) => {
      blank();
      const f = toEol();
      if (f === '') return false;
      if (!NO_FILE.has(f)) out[kind].push(f);
      return true;
    };
    while (i < n) {
      const ch0 = text[i];
      if (ch0 === ' ' || ch0 === '\t' || ch0 === '\n' || ch0 === ';') {
        i++;
        continue;
      }
      if (ch0 === '#') {
        toEol();
        continue;
      }
      let addressed = false;
      const a1 = address();
      if (a1 === false) return bad;
      if (a1 === true) {
        addressed = true;
        blank();
        if (text[i] === ',') {
          i++;
          blank();
          if (text[i] === '+' || text[i] === '~') {
            i++;
            if (!/[0-9]/.test(text[i] || '')) return bad;
            while (/[0-9]/.test(text[i] || '')) i++;
          } else if (address() !== true) return bad;
        }
      }
      blank();
      while (text[i] === '!') {
        i++;
        blank();
      }
      const cmd = text[i++];
      if (cmd === undefined) return bad;
      if (cmd === '{') {
        depth++;
        continue;
      }
      if (cmd === '}') {
        if (addressed) return bad;
        depth--;
        if (depth < 0) return bad;
      } else if (cmd === 'e') {
        return bad;
      } else if (SED_SIMPLE.has(cmd)) {
        // no argument
      } else if (SED_COUNT.has(cmd)) {
        blank();
        while (/[0-9]/.test(text[i] || '')) i++;
      } else if (cmd === ':') {
        if (addressed) return bad;
        blank();
        const s = i;
        while (i < n && text[i] !== '\n' && text[i] !== ';') i++;
        if (i === s) return bad;
      } else if (SED_LABEL.has(cmd)) {
        blank();
        while (i < n && text[i] !== '\n' && text[i] !== ';' && text[i] !== '}') i++;
      } else if (cmd === 'a' || cmd === 'i' || cmd === 'c') {
        // text to the end of the line; a backslash escapes the next character, newline included
        if (text[i] === '\\') {
          i++;
          if (text[i] === '\n') i++;
        }
        for (;;) {
          if (i >= n || text[i] === '\n') break;
          if (text[i] === '\\') {
            if (i + 1 >= n) return bad;
            i += 2;
            continue;
          }
          i++;
        }
      } else if (Object.hasOwn(SED_FILE, cmd)) {
        if (!fileArg(SED_FILE[cmd])) return bad;
      } else if (cmd === 's' || cmd === 'y') {
        const delim = text[i++];
        if (delim === undefined || delim === '\n' || delim === '\\') return bad;
        if (!part(delim, false)) return bad;
        if (!part(delim, true)) return bad;
        if (cmd === 's') {
          let done = false;
          while (!done && i < n) {
            const f = text[i];
            if (f === 'g' || f === 'p' || f === 'i' || f === 'I' || f === 'm' || f === 'M' || /[0-9]/.test(f)) i++;
            else if (f === 'e') return bad;
            else if (f === 'w') {
              i++;
              if (!fileArg('writes')) return bad;
              done = true;
            } else done = true;
          }
        }
      } else if (cmd === 'v') {
        blank();
        while (i < n && /[0-9.]/.test(text[i])) i++;
      } else {
        return bad;
      }
      // after a command: a separator, a closing brace, a comment, or the end
      blank();
      if (i < n && !['\n', ';', '}', '#'].includes(text[i])) return bad;
    }
    if (depth !== 0) return bad;
    return out;
  } catch {
    return bad;
  }
}

const SED_LONG = Object.freeze({
  value: new Set(['--expression', '--file', '--line-length']),
  bool: new Set(words('--quiet --silent --regexp-extended --separate --unbuffered --null-data --zero-terminated --posix --debug --sandbox --follow-symlinks --help --version --binary')),
});
const SED_BOOL = new Set(words('n E r s u z a'));

function sedCode(argv) {
  const scripts = [];
  const files = [];
  const operands = [];
  let altSuffix = false; // a bare -i/-I followed by a word: BSD reads that word as the suffix
  let altIndex = -1;
  let opts = true;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      if (opts) return null; // may be an option or the script
      operands.push(a);
      continue;
    }
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (!opts || a === '-' || !a.startsWith('-')) {
      operands.push(a);
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (name === '--in-place') continue;
      if (SED_LONG.bool.has(name) && eq < 0) continue;
      if (!SED_LONG.value.has(name)) return null;
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (!isStr(v)) return null;
      if (name === '--expression') scripts.push(v);
      else if (name === '--file') files.push(v);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (SED_BOOL.has(ch)) continue;
      if (ch === 'i' || ch === 'I') {
        // GNU: the rest of the word is the suffix; BSD: the next word is
        if (k + 1 === a.length) {
          altSuffix = true;
          altIndex = operands.length;
        }
        break;
      }
      if (ch !== 'e' && ch !== 'f' && ch !== 'l') return null;
      const v = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (!isStr(v)) return null;
      if (ch === 'e') scripts.push(v);
      else if (ch === 'f') files.push(v);
      break;
    }
  }
  const out = { reads: [], writes: [], files };
  const take = (r) => {
    out.reads.push(...r.reads);
    out.writes.push(...r.writes);
  };
  const given = scripts.length > 0 || files.length > 0;
  if (given) {
    const r = sedScript(scripts.join('\n'));
    if (r.opaque) return null;
    take(r);
    return out;
  }
  // GNU reading: the first operand is the script
  const primary = operands[0];
  if (primary === undefined) return out; // sed with no script: an error
  if (!isStr(primary)) return null;
  const r = sedScript(primary);
  if (r.opaque) return null;
  take(r);
  // BSD reading of `sed -i SUFFIX SCRIPT …`: the word after the suffix is the script. A script
  // BSD sed cannot compile makes it stop before running anything; one that compiles must be clean.
  if (altSuffix && altIndex === 0 && operands.length > 1) {
    const alt = operands[1];
    if (!isStr(alt)) return null;
    const r2 = sedScript(alt);
    if (!r2.opaque) take(r2);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// tar, ssh/scp/sftp, rg, fd, find, git

// real options that are also prefixes of a code option (an exact name wins in GNU tar)
const TAR_EXACT = new Set(['--checkpoint']);
const TAR_CODE_LONG = words('--to-command --use-compress-program --checkpoint-action --info-script --new-volume-script --rsh-command --rmt-command');
// short letters that take a value (GNU and BSD), and the code-running ones
const TAR_VALUE = new Set(['f', 'C', 'T', 'X', 'b', 'H', 'K', 'L', 'N', 'V', 'g', 's']);
const TAR_CODE_SHORT = new Set(['I', 'F']);

function tarCode(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      // an unambiguous prefix counts for GNU tar; any prefix of a code option is refused
      if (name.length > 2 && !TAR_EXACT.has(name) && TAR_CODE_LONG.some((o) => o.startsWith(name))) return null;
      continue;
    }
    const bundle = i === 1 && !a.startsWith('-') && /^[A-Za-z]+$/.test(a);
    if (bundle) {
      // old style: `tar xIf prog a.tar`
      for (const ch of a) if (TAR_CODE_SHORT.has(ch)) return null;
      continue;
    }
    if (!a.startsWith('-') || a === '-') continue;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (TAR_CODE_SHORT.has(ch)) return null;
      if (TAR_VALUE.has(ch)) {
        if (k + 1 === a.length) i++;
        break;
      }
    }
  }
  return { reads: [], writes: [], files: [] };
}

const SSH_VALUE = {
  ssh: new Set('BbcDEeFIiJLlmOoPpQRSWw'),
  scp: new Set('cDFiJloPSX'),
  sftp: new Set('BbcDFiJloPRSsX'),
};
const SSH_CODE_LETTERS = {
  ssh: new Set(['F']),
  scp: new Set(['F', 'S', 'D']),
  sftp: new Set(['F', 'S', 'D', 'b']),
};
const SSH_CODE = new Set(SSH_CODE_OPTIONS);

function sshCode(prog, argv) {
  const values = SSH_VALUE[prog];
  const code = SSH_CODE_LETTERS[prog];
  let operands = 0;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') {
      operands++;
      // ssh reads options after the host too; the second operand starts the remote command
      if (prog === 'ssh' && operands >= 2) break;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (code.has(ch)) return null;
      if (!values.has(ch)) continue;
      const v = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (!isStr(v)) return null;
      if (ch === 'o') {
        // -oKey=v, -o Key=v, -o 'Key v', leading blanks, any case
        const key = /^[^=\s]*/.exec(v.replace(/^\s+/, ''))[0].toLowerCase();
        if (SSH_CODE.has(key)) return null;
      }
      break;
    }
  }
  return { reads: [], writes: [], files: [] };
}

function rgCode(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '--') break;
    if (/^--(?:pre|hostname-bin)(?:=|$)/.test(a)) return null;
  }
  return { reads: [], writes: [], files: [] };
}

function fdCode(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '--') break;
    if (/^--(?:exec|exec-batch)(?:=|$)/.test(a)) return null;
    if (/^-[A-Za-z]+$/.test(a) && /[xX]/.test(a)) return null;
  }
  return { reads: [], writes: [], files: [] };
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function findCode(argv) {
  let inClause = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (inClause) {
      if (!isStr(a)) return null;
      if (a === ';' || a === '+') inClause = false;
      continue;
    }
    if (FIND_EXEC.has(a)) inClause = true;
  }
  return { reads: [], writes: [], files: [] };
}

function gitCode(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null;
    if (a === '-c' || a === '--config-env') {
      const v = argv[++i];
      if (!isStr(v)) return null;
      const key = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
      if (isGitCodeKey(key)) return null;
      continue;
    }
    if (a.startsWith('--config-env=')) {
      const v = a.slice('--config-env='.length);
      if (isGitCodeKey(v.includes('=') ? v.slice(0, v.indexOf('=')) : v)) return null;
      continue;
    }
    // --exec-path=<dir> runs git's sub-commands from that directory; bare --exec-path only prints it
    if (a.startsWith('--exec-path=')) return null;
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--super-prefix') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) break;
  }
  return { reads: [], writes: [], files: [] };
}

const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/** {verdict, reads, writes, files} for a command (see the header). */
export function embeddedCode(argv0) {
  const ok = { verdict: 'ok', reads: [], writes: [], files: [] };
  const no = { verdict: 'opaque', reads: [], writes: [], files: [] };
  try {
    let argv = argv0;
    // busybox/toybox applets are the program they name
    for (let n = 0; n < 3 && Array.isArray(argv) && argv.length > 1 && isStr(argv[0]); n++) {
      const b = baseOf(argv[0]);
      if (b !== 'busybox' && b !== 'toybox') break;
      argv = argv.slice(1);
    }
    if (!Array.isArray(argv) || argv.length === 0 || !isStr(argv[0])) return no;
    const prog = baseOf(argv[0]);
    if (EDITORS.has(prog)) return no;
    let r = undefined;
    if (prog === 'rg') r = rgCode(argv);
    else if (prog === 'fd' || prog === 'fdfind') r = fdCode(argv);
    else if (prog === 'find' || prog === 'gfind') r = findCode(argv);
    else if (AWKS.has(prog)) r = awkCode(argv);
    else if (prog === 'sed' || prog === 'gsed') r = sedCode(argv);
    else if (prog === 'tar' || prog === 'gtar' || prog === 'bsdtar') r = tarCode(argv);
    else if (prog === 'ssh' || prog === 'scp' || prog === 'sftp') r = sshCode(prog, argv);
    else if (prog === 'git') r = gitCode(argv);
    else return ok;
    if (r === null) return no;
    return { verdict: 'ok', reads: r.reads, writes: r.writes, files: r.files };
  } catch {
    return no;
  }
}

/** 'ok' | 'opaque' (see the header). */
export function embeddedCodeVerdict(argv) {
  return embeddedCode(argv).verdict;
}

// ---------------------------------------------------------------------------------------------
// git config writes

const CONFIG_READS = new Set(words('--get --get-all --get-regexp --get-urlmatch --get-color --get-colorbool -l --list'));
const CONFIG_VALUE = new Set(words('-f --file --blob --type --default --comment --value -t'));
const CONFIG_BOOL = new Set(
  words('--global --system --local --worktree --add --replace-all --unset --unset-all --bool --int --bool-or-int --path --expiry-date -z --null --name-only --show-origin --show-scope --includes --no-includes --fixed-value --all --append --no-type'),
);

/**
 * What a `git config` invocation (args after `config`) writes that can run code: null when it
 * only reads, or sets a key that runs nothing; else {scope}. An edit, a section rename or removal,
 * an UNKNOWN word, or an option fence does not know count as writing a code key.
 */
export function gitConfigWrite(args) {
  let scope = 'local';
  let edit = false;
  let read = false;
  let sections = false;
  let unknown = false;
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!isStr(a)) {
      unknown = true;
      continue;
    }
    if (a === '--') {
      for (const x of args.slice(i + 1)) ops.push(x);
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      ops.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (CONFIG_READS.has(name)) read = true;
    else if (name === '-e' || name === '--edit') edit = true;
    else if (name === '--rename-section' || name === '--remove-section') sections = true;
    else if (name === '--global' || name === '--system' || name === '--worktree' || name === '--local') scope = name.slice(2);
    else if (CONFIG_VALUE.has(name)) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : args[++i];
      if (name === '-f' || name === '--file') scope = { file: isStr(v) ? v : UNKNOWN };
      if (name === '--blob') read = true;
    } else if (!CONFIG_BOOL.has(name)) unknown = true;
  }
  let key = ops[0];
  const sub = isStr(key) ? key : null;
  if (sub === 'get' || sub === 'list') return null;
  if (sub === 'edit') edit = true;
  else if (sub === 'rename-section' || sub === 'remove-section') sections = true;
  else if (sub === 'set' || sub === 'unset') key = ops[1];
  else if (!edit && !sections && !unknown && ops.length <= 1 && !args.some((a) => isStr(a) && /^--(?:unset|unset-all|add|replace-all)$/.test(a))) {
    // `git config KEY` reads it
    return null;
  }
  if (read && !edit && !sections) return null;
  if (edit || sections || unknown || key === undefined || isGitCodeKey(key)) return { scope };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Interpreter inline code

const PYTHON = /^pythonw?[0-9.]*$/;
// python flags with no value that keep the code checkable (-I is the isolated mode)
const PY_OK = new Set(['I', 'E', 's', 'S', 'B', 'u', 'O', 'q', 'b', 'd', 'v', 'P', 'R', 'x']);
const PY_VALUE = new Set(['W', 'X']);
const NODE_INLINE = new Set(['-e', '--eval', '-p', '--print', '-pe']);
// node options that take a separate value (their value is never the main file)
const NODE_VALUE = new Set(
  words(
    '-r --require --import --loader --experimental-loader -C --conditions --input-type --title --env-file --env-file-if-exists --disable-warning --unhandled-rejections --experimental-default-type --watch-path --test-name-pattern --test-skip-pattern --test-reporter --test-reporter-destination --test-concurrency --test-shard --test-timeout --redirect-warnings --diagnostic-dir --report-dir --icu-data-dir --openssl-config --localstorage-file --max-old-space-size --max-semi-space-size --stack-size --stack-trace-limit',
  ),
);
const NODE_OK = new Set([...NODE_OPTIONS_ALLOWED, '--no-deprecation', '--throw-deprecation', '--pending-deprecation', '--input-type']);
// Other interpreters (spec: Perl, Ruby, PHP, Lua and others are opaque in v1). Each language's
// options are parsed with its own table so a value is never read as a flag (`perl -I lib -e …`,
// `php -d x=1 -r …`) and a module name is never read as a code flag (`-MExporter`, `-rerb`):
//   code      inline code (or a library load that runs code): opaque `embedded-code`
//   bool      no value
//   value     a value: the rest of the cluster, else the next word
//   attached  an optional value glued to the letter (the rest of the cluster)
//   module    a module name value (validated: anything else may smuggle code)
//   ini       php -d / --define: a `key=value` whose key must not load code
// Any option outside the table is opaque (fail closed). No operand, or `-`, is the program read
// from stdin (mode 'stdin': opaque when stdin is fed).
const flags = (spec) => {
  const out = {};
  for (const [kind, letters] of Object.entries(spec)) for (const l of letters.split(' ').filter(Boolean)) out[l] = kind;
  return Object.freeze(out);
};
const OTHER_LANGS = Object.freeze({
  perl: {
    short: flags({ code: 'e E', value: 'I', module: 'M m', attached: 'x C F i l 0 d D V', bool: 'w W X n p a s T t c u U v h S' }),
    long: flags({}),
    module: /^-?[A-Za-z_][A-Za-z0-9_:]*(?:=[A-Za-z0-9_,:.-]*)?$/,
  },
  ruby: {
    short: flags({ code: 'e', value: 'I C E', module: 'r', attached: 'x W K T 0 F i', bool: 'a c d l n p s S v w y h U' }),
    long: flags({ value: '--enable --disable --encoding --external-encoding --internal-encoding --dump', bool: '--verbose --version --help --copyright --yjit --jit --disable-gems' }),
    module: /^[A-Za-z0-9_./-]+$/,
  },
  php: {
    // -S (built-in server running the docroot), -z (a zend extension), -c (an ini file that may
    // auto-prepend code) load code; -f names the script file
    short: flags({ code: 'r R B E S z c', value: 'F t', file: 'f', ini: 'd', bool: 'a n q h i l m s v w H C e' }),
    long: flags({ code: '--run --process-begin --process-code --process-end --php-ini --zend-extension', value: '--process-file', file: '--file', ini: '--define', bool: '--no-php-ini --syntax-check --version --help --info --modules --hide-args --no-header --ini' }),
  },
  lua: { short: flags({ code: 'e l', bool: 'i v E W' }), long: flags({}) },
});
// php ini keys that load or run code
const PHP_CODE_INI = new Set(['auto_prepend_file', 'auto_append_file', 'extension', 'zend_extension', 'extension_dir', 'include_path', 'user_ini.filename', 'disable_functions']);
// whole-word option tables (no clusters): tclsh/wish, Rscript, julia
const WORD_LANGS = Object.freeze({
  tcl: flags({ value: '-encoding' }),
  r: flags({ code: '-e', value: '--default-packages', bool: '--vanilla --verbose --version --no-environ --no-site-file --no-init-file --restore --no-restore --save --no-save --slave --quiet --silent --no-echo' }),
  julia: flags({
    code: '-e --eval -E --print -L --load',
    value: '-t --threads -p --procs -J --sysimage --project --startup-file --color --history-file --compile --check-bounds --math-mode --depwarn --inline --banner -O --optimize',
    bool: '-q --quiet -i -v --version -h --help',
  }),
});

function otherLanguage(prog) {
  if (/^perl[0-9.]*$/.test(prog)) return 'perl';
  if (/^ruby[0-9.]*$/.test(prog)) return 'ruby';
  if (/^php[0-9.]*$/.test(prog)) return 'php';
  if (/^lua[0-9.]*$/.test(prog) || prog === 'luajit') return 'lua';
  if (/^(?:tclsh|wish)[0-9.]*$/.test(prog)) return 'tcl';
  if (prog === 'rscript') return 'r';
  if (/^julia[0-9.]*$/.test(prog)) return 'julia';
  if (prog === 'deno' || prog === 'bun') return prog;
  return null;
}

const EMBEDDED = Object.freeze({ opaque: { reason: 'unsupported', construct: 'embedded-code' } });
const OTHER_STDIN = (lang) => ({ lang, mode: 'stdin', codes: [], isolated: false, gated: null });
// the program is a file (a word, UNKNOWN, or null when it is not a file fence can name)
const OTHER_FILE = (lang, file) => ({ lang, mode: 'file', file });

function phpIniOk(v) {
  const key = v.includes('=') ? v.slice(0, v.indexOf('=')) : v;
  return !PHP_CODE_INI.has(key.trim().toLowerCase());
}

// A cluster language (perl, ruby, php, lua): EMBEDDED, null (a script operand) or stdin mode.
function clusterLanguage(lang, argv) {
  const t = OTHER_LANGS[lang];
  const take = (kind, v) => {
    if (!isStr(v)) return false;
    if (kind === 'module' && !t.module.test(v)) return false;
    if (kind === 'ini' && !phpIniOk(v)) return false;
    return true;
  };
  let module = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return EMBEDDED; // may be the inline-code option
    if (a === '-') return OTHER_STDIN(lang);
    if (a === '--') return i + 1 < argv.length ? OTHER_FILE(lang, argv[i + 1]) : OTHER_STDIN(lang);
    if (!a.startsWith('-')) return OTHER_FILE(lang, a); // the script file
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const kind = Object.hasOwn(t.long, name) ? t.long[name] : undefined;
      if (kind === undefined || kind === 'code') return EMBEDDED;
      if (kind === 'bool') {
        if (eq > 0) return EMBEDDED;
        continue;
      }
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (kind === 'file') return isStr(v) ? OTHER_FILE(lang, v) : EMBEDDED;
      if (!take(kind, v)) return EMBEDDED;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      const kind = Object.hasOwn(t.short, ch) ? t.short[ch] : undefined;
      if (kind === undefined || kind === 'code') return EMBEDDED;
      if (kind === 'bool') continue;
      if (kind === 'attached') {
        // perl -d:Mod loads Devel::Mod (code); plain -d is the interactive debugger
        if (lang === 'perl' && ch === 'd' && a[k + 1] === ':') return EMBEDDED;
        break;
      }
      const v = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (kind === 'file') return isStr(v) ? OTHER_FILE(lang, v) : EMBEDDED;
      if (!take(kind, v)) return EMBEDDED;
      if (kind === 'module') module = true;
      break;
    }
  }
  // modules loaded with no script (perl -Ilib -MFoo): their code runs and the program is stdin
  return module ? EMBEDDED : OTHER_STDIN(lang);
}

// A whole-word language (tcl, R, julia).
function wordLanguage(lang, argv) {
  const t = WORD_LANGS[lang];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return EMBEDDED;
    if (a === '-') return OTHER_STDIN(lang);
    if (a === '--') return i + 1 < argv.length ? OTHER_FILE(lang, argv[i + 1]) : OTHER_STDIN(lang);
    if (!a.startsWith('-')) return OTHER_FILE(lang, a);
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const kind = Object.hasOwn(t, name) ? t[name] : undefined;
    if (kind === undefined || kind === 'code') return EMBEDDED;
    if (kind === 'bool') {
      if (eq > 0 && name !== a) return EMBEDDED;
      continue;
    }
    if (!(eq > 0 && name !== a) && !isStr(argv[++i])) return EMBEDDED;
  }
  return OTHER_STDIN(lang);
}

// deno eval / deno repl --eval / bare deno (a REPL on stdin); bun -e/--eval/-p/--print.
const BUN_SUBS = new Set(words('install i add a remove rm update link unlink x create init build test pm upgrade outdated publish patch exec repl why audit info'));

function denoBun(lang, argv) {
  let run = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return EMBEDDED;
    if (lang === 'bun') {
      if (a === 'run') {
        run = true;
        continue;
      }
      if (/^(?:-e|--eval|-p|--print)(?:=|$)/.test(a)) return EMBEDDED;
      if (a.startsWith('-')) continue;
      if (!run && BUN_SUBS.has(a)) return null; // a package-manager or tool sub-command
      // bun run NAME without a path or extension is a package.json script: no file fence can name
      return OTHER_FILE(lang, run && !/[./]/.test(a) ? null : a);
    }
    if (a.startsWith('-')) continue;
    if (a === 'eval') return EMBEDDED;
    if (a === 'repl') return argv.slice(i + 1).some((w) => !isStr(w) || /^--eval(?:-file)?(?:=|$)/.test(w)) ? EMBEDDED : OTHER_STDIN(lang);
    return null;
  }
  return lang === 'deno' ? OTHER_STDIN(lang) : null;
}


function pythonInline(argv) {
  let isolated = false;
  let gated = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return null; // a file operand fence cannot name: resolve/script.mjs's
    if (a === '-') return { lang: 'python', mode: 'stdin', codes: [], isolated, gated };
    if (a === '--' || !a.startsWith('-')) return null; // a program file
    if (a.startsWith('--')) {
      gated = gated ?? a;
      if (a === '--check-hash-based-pycs') i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === 'c') {
        const code = k + 1 < a.length ? a.slice(k + 1) : i + 1 < argv.length ? argv[i + 1] : UNKNOWN;
        return { lang: 'python', mode: 'c', codes: [isStr(code) ? code : UNKNOWN], isolated, gated };
      }
      if (ch === 'm') return null; // a module: runs-repo-code (resolve/script.mjs)
      if (ch === 'I') isolated = true;
      if (PY_VALUE.has(ch)) {
        gated = gated ?? `-${ch}`;
        if (k + 1 === a.length) i++;
        break;
      }
      if (!PY_OK.has(ch)) gated = gated ?? `-${ch}`;
    }
  }
  return { lang: 'python', mode: 'stdin', codes: [], isolated, gated };
}

function nodeInline(argv) {
  const codes = [];
  let gated = null;
  let stdin = true;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      if (codes.length === 0) return null; // a main file fence cannot name: resolve/script.mjs's
      gated = gated ?? 'unknown word';
      break;
    }
    if (a === '-') break;
    if (a === '--' || !a.startsWith('-')) {
      if (codes.length === 0) return null; // a main file
      break; // the program's own arguments
    }
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (NODE_INLINE.has(name)) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      codes.push(isStr(v) ? v : UNKNOWN);
      stdin = false;
      continue;
    }
    if (NODE_OK.has(name)) {
      if (eq < 0 && NODE_VALUE.has(name)) i++;
      continue;
    }
    if (eq < 0 && NODE_VALUE.has(name)) i++; // its value is not a main file
    // -r/--require, --import, --loader, --experimental-loader, --env-file*, --inspect*, any other
    // flag: a preloaded file can redefine JSON, console or Math
    gated = gated ?? a;
  }
  if (codes.length > 0) return { lang: 'node', mode: 'c', codes, isolated: true, gated };
  return stdin ? { lang: 'node', mode: 'stdin', codes: [], isolated: true, gated } : null;
}

/** How an interpreter gets inline code (see the header), or null when it does not. */
export function inlineInterpreter(argv0) {
  try {
    let argv = argv0;
    for (let n = 0; n < 3 && Array.isArray(argv) && argv.length > 1 && isStr(argv[0]); n++) {
      const b = baseOf(argv[0]);
      if (b !== 'busybox' && b !== 'toybox') break;
      argv = argv.slice(1);
    }
    if (!Array.isArray(argv) || argv.length === 0 || !isStr(argv[0])) return null;
    const prog = baseOf(argv[0]);
    if (PYTHON.test(prog)) return pythonInline(argv);
    if (prog === 'node' || prog === 'nodejs') return nodeInline(argv);
    const lang = otherLanguage(prog);
    if (lang === null) return null;
    const r = otherInterpreter(lang, argv);
    return r !== null && r.mode === 'file' ? null : r;
  } catch {
    return EMBEDDED;
  }
}

function otherInterpreter(lang, argv) {
  if (Object.hasOwn(OTHER_LANGS, lang)) return clusterLanguage(lang, argv);
  if (Object.hasOwn(WORD_LANGS, lang)) return wordLanguage(lang, argv);
  return denoBun(lang, argv);
}

/**
 * The script file an interpreter outside the spec's runs-repo-code list runs (perl, ruby, php,
 * lua, tclsh, Rscript, julia, bun run|file): {files} (a word or UNKNOWN; empty for a package script
 * fence cannot name), or null when the command runs no file (inline code and code-loading options
 * are inlineInterpreter's). resolve/script.mjs makes it a runs-repo-code route.
 */
export function interpreterScript(argv0) {
  try {
    let argv = argv0;
    for (let n = 0; n < 3 && Array.isArray(argv) && argv.length > 1 && isStr(argv[0]); n++) {
      const b = baseOf(argv[0]);
      if (b !== 'busybox' && b !== 'toybox') break;
      argv = argv.slice(1);
    }
    if (!Array.isArray(argv) || argv.length === 0 || !isStr(argv[0])) return null;
    const lang = otherLanguage(baseOf(argv[0]));
    if (lang === null || lang === 'deno') return null; // deno run is resolve/script.mjs's own route
    const r = otherInterpreter(lang, argv);
    if (r === null || r.mode !== 'file') return null;
    return { files: r.file === null ? [] : [r.file] };
  } catch {
    return null;
  }
}
