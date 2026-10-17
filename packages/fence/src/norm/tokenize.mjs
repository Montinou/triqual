// Hand-written tokenizer for the supported bash subset. It reads untrusted
// text, so it never guesses: anything it does not fully understand throws an
// Opaque error that parseShell turns into {opaque:{reason, construct, offset}}.
//
// The lexer is pulled by the parser one token at a time. A word that contains
// `$( … )` calls back into the parser, which parses the inner program from the
// same character stream and consumes the closing `)`; every character is read
// once, so tokenizing is linear in the input. Nesting is bounded by the
// parser's depth counter (MAX_DEPTH), so the call stack never grows past a
// fixed size whatever the input.

/**
 * @typedef {{type:'lit', text:string, quoted:boolean}} Lit
 *   Literal text. `quoted` is true when it came from quotes or an escape, so it
 *   never undergoes globbing, splitting or reserved-word recognition.
 * @typedef {{type:'var', name:string, quoted:boolean, op?:string, arg?:Word}} Var
 *   `$X`, `${X}`, `${X<op>word}` with op one of `:-` `-` `:=` `=` `:+` `+` `:?` `?`.
 * @typedef {{type:'cmdsub', program:import('./parser.mjs').ListNode, quoted:boolean, backtick:boolean}} CmdSub
 * @typedef {{type:'arith', text:string, quoted:boolean}} Arith
 *   `$(( … ))`, kept as raw text. The parser rejects a literal `$(`, backtick or
 *   quote inside it, but the part is NOT safe: a variable named in the text can
 *   hold `a[$(cmd)]`, which arithmetic evaluation runs. Treat it as UNKNOWN.
 * @typedef {{type:'glob', text:'*'|'?'|'['|']'}} Glob
 *   A glob character outside quotes (`[` and `]` only when they pair up).
 * @typedef {{parts:(Lit|Var|CmdSub|Arith|Glob)[], assign?:boolean}} Word
 *   `assign` marks an assignment value (where `~` after `:` also expands).
 * @typedef {{op:'<<'|'<<-', fd?:number, delimiter:string, quoted:boolean, body:string,
 *   parts:(Lit|Var|CmdSub|Arith)[]}} HeredocRedir
 *   `body` is the raw body text (after `<<-` tab stripping), every line ending
 *   in a newline, without the terminator line. With a quoted delimiter `parts`
 *   is the body as one quoted literal; otherwise it is the body parsed for
 *   `$x`, `${…}`, `$( … )`, backticks and `$(( … ))`, every part quoted (a
 *   heredoc body is never split or globbed). The body is data for the command
 *   it feeds; whether to re-parse it as a script is the caller's decision.
 * @typedef {{t:'op', v:string, off:number, adj:boolean}
 *   | {t:'redir', op:string, fd?:number, off:number, adj:boolean}
 *   | {t:'word', word:Word, off:number, adj:boolean, lo:number, hi:number}
 *   | {t:'eof', off:number, adj:boolean}} Token
 *   `adj` is true when no blank separates the token from the previous one.
 *   `lo`/`hi` are the word's bounds in this lexer's own text.
 */

export const MAX_DEPTH = 64;
export const MAX_BYTES = 32 * 1024;

export class Opaque extends Error {
  constructor(reason, construct, offset) {
    super(`opaque ${reason}: ${construct} at ${offset}`);
    this.opaque = { reason, construct, offset };
  }
}

// Characters that end an unquoted word.
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const SPECIAL_PARAMS = new Set(['@', '*', '#', '?', '-', '$', '!']);
const PARAM_OPS1 = new Set(['-', '=', '+', '?']);
// zsh `$=x` `$~x` `$^x` `$+x`: flags with no bash meaning.
const ZSH_DOLLAR_FLAGS = new Set(['=', '~', '^', '+']);
// zsh `${~x}` `${=x}` `${^x}` `${+x}` and `${(flags)x}`.
const ZSH_BRACE_FLAGS = new Set(['=', '~', '^', '+', '(']);

function isNameStart(c) {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}
function isNameChar(c) {
  return isNameStart(c) || isDigit(c);
}
function isDigit(c) {
  return c !== undefined && c >= '0' && c <= '9';
}
function isHex(c) {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

export function isName(s) {
  if (!isNameStart(s[0])) return false;
  for (let i = 1; i < s.length; i++) if (!isNameChar(s[i])) return false;
  return true;
}

// Append literal text, merging with a previous literal of the same quoting.
function pushLit(parts, text, quoted) {
  const last = parts[parts.length - 1];
  if (last && last.type === 'lit' && last.quoted === quoted) last.text += text;
  else parts.push({ type: 'lit', text, quoted });
}

// `[` and `]` are glob characters only when they pair up; an unmatched one is
// a literal (so `[ -f x ]` reads as the command `[`). One linear pass.
function fixBrackets(parts) {
  let open = -1;
  let any = false;
  const literal = new Set();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== 'glob' || (p.text !== '[' && p.text !== ']')) continue;
    any = true;
    if (p.text === '[') {
      if (open < 0) open = i;
      else literal.add(i);
    } else if (open >= 0 && i > open + 1) {
      open = -1;
    } else {
      // a `]` with no open bracket, or right after `[` (a class member)
      literal.add(i);
    }
  }
  if (open >= 0) literal.add(open);
  if (!any || literal.size === 0) return parts;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (literal.has(i)) pushLit(out, parts[i].text, false);
    else if (parts[i].type === 'lit') pushLit(out, parts[i].text, parts[i].quoted);
    else out.push(parts[i]);
  }
  return out;
}

const ANSI_SIMPLE = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

export class Lexer {
  /**
   * @param {string} text
   * @param {number} base offset of text[0] in the original command
   * @param {number[]|null} map when set, map[i] is the original offset of text[i]
   *   (backtick text, whose unescaping shifts positions)
   * @param {{enter(construct:string, off:number):void, leave():void,
   *   parseCmdSubBody(off:number):any, parseNested(text:string, map:number[]):any,
   *   parseHeredocBody(text:string, map:number[]):any[]}} host
   */
  constructor(text, base, host, map = null) {
    this.text = text;
    this.base = base;
    this.map = map;
    this.host = host;
    this.pos = 0;
    this.la = null;
    this.lastEnd = -1;
    // heredocs whose body starts after the next newline token, in order
    this.pending = [];
    // `$( … )` nesting inside this lexer's text (the same lexer reads it)
    this.subDepth = 0;
  }

  peek() {
    if (this.la === null) this.la = this.lexToken();
    return this.la;
  }

  next() {
    const t = this.peek();
    this.la = null;
    return t;
  }

  off(i) {
    if (this.map) return this.map[Math.min(i, this.map.length - 1)];
    return this.base + i;
  }

  unterminated(construct, i) {
    return new Opaque('unterminated', construct, this.off(i));
  }

  unsupported(construct, i) {
    return new Opaque('unsupported', construct, this.off(i));
  }

  lexToken() {
    const s = this.text;
    for (;;) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t') this.pos++;
      else if (c === '\\' && s[this.pos + 1] === '\n') this.pos += 2;
      else if (c === '#') {
        const nl = s.indexOf('\n', this.pos);
        this.pos = nl < 0 ? s.length : nl;
      } else break;
    }
    const start = this.pos;
    const adj = start === this.lastEnd;
    const tok = this.lexAt(start, adj);
    this.lastEnd = this.pos;
    return tok;
  }

  lexAt(start, adj) {
    const s = this.text;
    const off = this.off(start);
    if (start >= s.length) {
      if (this.pending.length) throw new Opaque('unterminated', 'heredoc', this.pending[0].off);
      return { t: 'eof', off, adj };
    }
    const c = s[start];
    const c1 = s[start + 1];
    const c2 = s[start + 2];
    const op = (v) => {
      this.pos = start + v.length;
      return { t: 'op', v, off, adj };
    };
    switch (c) {
      case '\n': {
        const tok = op('\n');
        if (this.pending.length) this.readHeredocBodies(start);
        return tok;
      }
      case ';':
        if (c1 === ';') return op(c2 === '&' ? ';;&' : ';;');
        return op(c1 === '&' ? ';&' : ';');
      case '&':
        if (c1 === '&') return op('&&');
        if (c1 === '>') return this.redir(start, c2 === '>' ? '&>>' : '&>', undefined, off, adj);
        return op('&');
      case '|':
        if (c1 === '|') return op('||');
        return op(c1 === '&' ? '|&' : '|');
      case '(':
      case ')':
        return op(c);
      case '<':
      case '>':
        return this.redirAt(start, undefined, off, adj);
      default:
        break;
    }
    if (isDigit(c)) {
      let j = start;
      while (isDigit(s[j])) j++;
      if ((s[j] === '<' || s[j] === '>') && j - start <= 9) {
        return this.redirAt(j, Number(s.slice(start, j)), off, adj);
      }
    }
    const word = this.readWord();
    return { t: 'word', word, off, adj, lo: start, hi: this.pos };
  }

  // A redirection operator starting at i (which holds `<` or `>`).
  redirAt(i, fd, off, adj) {
    const s = this.text;
    const c = s[i];
    const c1 = s[i + 1];
    if (c1 === '(') throw this.unsupported('process-substitution', i);
    if (c === '<') {
      if (c1 === '<') {
        if (s[i + 2] === '<') return this.redir(i, '<<<', fd, off, adj);
        return this.redir(i, s[i + 2] === '-' ? '<<-' : '<<', fd, off, adj);
      }
      if (c1 === '>') return this.redir(i, '<>', fd, off, adj);
      if (c1 === '&') return this.redir(i, '<&', fd, off, adj);
      return this.redir(i, '<', fd, off, adj);
    }
    if (c1 === '>') {
      // zsh `>>&` (append stdout and stderr) has no bash meaning
      if (s[i + 2] === '&') throw this.unsupported('zsh-syntax', i);
      return this.redir(i, '>>', fd, off, adj);
    }
    if (c1 === '|') return this.redir(i, '>|', fd, off, adj);
    if (c1 === '&') return this.redir(i, '>&', fd, off, adj);
    return this.redir(i, '>', fd, off, adj);
  }

  redir(i, op, fd, off, adj) {
    // zsh clobber forms `>!` `>>!` `&>!` `>&!`: in bash the `!` would start
    // the target word, so never guess
    if (op.includes('>') && this.text[i + op.length] === '!') throw this.unsupported('zsh-syntax', i);
    this.pos = i + op.length;
    const tok = { t: 'redir', op, off, adj };
    if (fd !== undefined) tok.fd = fd;
    return tok;
  }

  // An unquoted word, from this.pos up to the first unquoted word end.
  readWord() {
    const s = this.text;
    // zsh EQUALS: a word starting with an unquoted `=` followed by anything
    // expands (`=ls` is the path of ls, `==` fails); a lone `=` is plain
    if (s[this.pos] === '=' && this.pos + 1 < s.length && !WORD_END.has(s[this.pos + 1])) {
      throw this.unsupported('zsh-syntax', this.pos);
    }
    const parts = [];
    let lit = '';
    const flush = () => {
      if (lit) {
        pushLit(parts, lit, false);
        lit = '';
      }
    };
    // brace expansion ({a,b} or {1..3}) is not modelled: opaque
    let braceOpen = false;
    let braceSep = false;
    let prevDot = false;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (WORD_END.has(c)) break;
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === undefined) throw this.unterminated('escape', this.pos);
        this.pos += 2;
        if (n === '\n') continue;
        flush();
        pushLit(parts, n, true);
        prevDot = false;
        continue;
      }
      if (c === "'") {
        flush();
        this.readSingle(parts);
      } else if (c === '"') {
        flush();
        this.readDouble(parts);
      } else if (c === '$') {
        flush();
        if (!this.readDollar(parts, false)) {
          lit += '$';
          this.pos++;
        }
      } else if (c === '`') {
        flush();
        this.readBacktick(parts, false);
      } else if (c === '*' || c === '?' || c === '[' || c === ']') {
        flush();
        parts.push({ type: 'glob', text: c });
        this.pos++;
      } else {
        if (c === '{') braceOpen = true;
        else if (braceOpen && (c === ',' || (c === '.' && prevDot))) braceSep = true;
        else if (c === '}' && braceOpen && braceSep) throw this.unsupported('brace-expansion', this.pos);
        prevDot = c === '.';
        lit += c;
        this.pos++;
        continue;
      }
      prevDot = false;
    }
    flush();
    return { parts: fixBrackets(parts) };
  }

  readSingle(parts) {
    const s = this.text;
    const end = s.indexOf("'", this.pos + 1);
    if (end < 0) throw this.unterminated('single-quote', this.pos);
    pushLit(parts, s.slice(this.pos + 1, end), true);
    this.pos = end + 1;
  }

  readDouble(parts) {
    const s = this.text;
    const open = this.pos;
    const before = parts.length;
    let buf = '';
    const flush = () => {
      if (buf) {
        pushLit(parts, buf, true);
        buf = '';
      }
    };
    this.pos++;
    for (;;) {
      if (this.pos >= s.length) throw this.unterminated('double-quote', open);
      const c = s[this.pos];
      if (c === '"') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === '$' || n === '`' || n === '"' || n === '\\') {
          buf += n;
          this.pos += 2;
        } else if (n === '\n') {
          this.pos += 2;
        } else {
          buf += '\\';
          this.pos++;
        }
      } else if (c === '$') {
        flush();
        if (!this.readDollar(parts, true)) {
          buf += '$';
          this.pos++;
        }
      } else if (c === '`') {
        flush();
        this.readBacktick(parts, true);
      } else {
        buf += c;
        this.pos++;
      }
    }
    flush();
    // "" is an empty argument, not nothing
    if (parts.length === before) pushLit(parts, '', true);
  }

  // At `$`. Returns false when the `$` is a plain character.
  readDollar(parts, quoted) {
    const s = this.text;
    const at = this.pos;
    const n = s[at + 1];
    if (!quoted && n === "'") {
      this.readAnsiC(parts);
      return true;
    }
    if (!quoted && n === '"') throw this.unsupported('locale-string', at);
    if (n === '(') {
      if (s[at + 2] === '(') this.readArith(parts, quoted);
      else this.readCmdSub(parts, quoted);
      return true;
    }
    if (n === '{') {
      this.readBraced(parts, quoted);
      return true;
    }
    if (n === '[') throw this.unsupported('arithmetic', at);
    const n2 = s[at + 2];
    // a flag before anything parameter-like (name, `{`, digit, special
    // parameter) is zsh syntax; a lone `$=` stays literal
    if (ZSH_DOLLAR_FLAGS.has(n) && (isNameChar(n2) || n2 === '{' || SPECIAL_PARAMS.has(n2))) {
      throw this.unsupported('zsh-syntax', at);
    }
    // zsh `$#name` is a length; bash reads `$#` (the argument count) then text
    if (n === '#' && (isNameChar(n2) || n2 === '{' || SPECIAL_PARAMS.has(n2))) {
      throw this.unsupported('zsh-syntax', at);
    }
    if (isNameStart(n)) {
      let j = at + 1;
      while (isNameChar(s[j])) j++;
      parts.push({ type: 'var', name: s.slice(at + 1, j), quoted });
      this.pos = j;
      this.noSubscript(at);
      return true;
    }
    if (isDigit(n) || SPECIAL_PARAMS.has(n)) {
      parts.push({ type: 'var', name: n, quoted });
      this.pos = at + 2;
      this.noSubscript(at);
      return true;
    }
    return false;
  }

  // zsh subscripts `$x[1]` (bash reads `$x` then a glob): never guess.
  noSubscript(at) {
    if (this.text[this.pos] === '[') throw this.unsupported('zsh-syntax', at);
  }

  readAnsiC(parts) {
    const s = this.text;
    const open = this.pos;
    let buf = '';
    let i = open + 2;
    for (;;) {
      if (i >= s.length) throw this.unterminated('ansi-c-quote', open);
      const c = s[i];
      if (c === "'") {
        i++;
        break;
      }
      if (c !== '\\') {
        buf += c;
        i++;
        continue;
      }
      const n = s[i + 1];
      if (n === undefined) throw this.unterminated('ansi-c-quote', open);
      if (Object.hasOwn(ANSI_SIMPLE, n)) {
        buf += ANSI_SIMPLE[n];
        i += 2;
        continue;
      }
      let code = -1;
      let j = i + 1;
      if (n >= '0' && n <= '7') {
        code = 0;
        while (j < i + 4 && s[j] >= '0' && s[j] <= '7') code = code * 8 + (s.charCodeAt(j++) - 48);
      } else if (n === 'x' || n === 'u' || n === 'U') {
        const max = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        j = i + 2;
        const from = j;
        while (j < from + max && isHex(s[j])) j++;
        if (j > from) code = parseInt(s.slice(from, j), 16);
        else j = i + 2;
      } else if (n === 'c') {
        throw this.unsupported('ansi-c-quote', i);
      }
      if (code < 0) {
        // an unknown escape keeps its backslash
        buf += '\\' + n;
        i += 2;
        continue;
      }
      // bash truncates at NUL, zsh does not: never guess
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw this.unsupported('ansi-c-quote', i);
      }
      buf += String.fromCodePoint(code);
      i = j;
    }
    pushLit(parts, buf, true);
    this.pos = i;
  }

  readCmdSub(parts, quoted) {
    const at = this.pos;
    const off = this.off(at);
    this.pos = at + 2;
    this.host.enter('command-substitution', off);
    this.subDepth++;
    const program = this.host.parseCmdSubBody(off);
    this.subDepth--;
    // a heredoc opened inside `$( … )` whose body did not start before the
    // closing `)`: where its body lies differs between shells
    const last = this.pending[this.pending.length - 1];
    if (last && last.level > this.subDepth) throw new Opaque('unsupported', 'heredoc', last.off);
    this.host.leave();
    parts.push({ type: 'cmdsub', program, quoted, backtick: false });
  }

  readArith(parts, quoted) {
    const s = this.text;
    const at = this.pos;
    const start = at + 3;
    let depth = 0;
    let i = start;
    for (;;) {
      if (i >= s.length) throw this.unterminated('arithmetic', at);
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          if (s[i + 1] !== ')') throw this.unsupported('arithmetic', at);
          break;
        }
        depth--;
      } else if (c === "'" || c === '"' || c === '`' || c === '\\' || (c === '$' && s[i + 1] === '(')) {
        // a command substitution or quoting inside arithmetic is not modelled
        throw this.unsupported('arithmetic', at);
      }
      i++;
    }
    parts.push({ type: 'arith', text: s.slice(start, i), quoted });
    this.pos = i + 2;
  }

  readBraced(parts, quoted) {
    const s = this.text;
    const at = this.pos;
    const off = this.off(at);
    let i = at + 2;
    if (i >= s.length) throw this.unterminated('parameter', at);
    let name;
    const c = s[i];
    if (isNameStart(c)) {
      let j = i + 1;
      while (isNameChar(s[j])) j++;
      name = s.slice(i, j);
      i = j;
    } else if (isDigit(c)) {
      let j = i + 1;
      while (isDigit(s[j])) j++;
      name = s.slice(i, j);
      i = j;
    } else if (SPECIAL_PARAMS.has(c) && (s[i + 1] === '}' || (c !== '#' && c !== '!'))) {
      name = c;
      i++;
    } else if (ZSH_BRACE_FLAGS.has(c)) {
      // zsh `${~x}` `${=x}` `${^x}` `${+x}` `${(f)x}`
      throw this.unsupported('zsh-syntax', at);
    } else {
      throw this.unsupported('parameter-expansion', at);
    }
    if (i >= s.length) throw this.unterminated('parameter', at);
    if (s[i] === '}') {
      parts.push({ type: 'var', name, quoted });
      this.pos = i + 1;
      this.noSubscript(at);
      return;
    }
    let op;
    if (s[i] === ':' && PARAM_OPS1.has(s[i + 1])) op = s.slice(i, i + 2);
    else if (PARAM_OPS1.has(s[i])) op = s[i];
    else throw this.unsupported('parameter-expansion', at);
    this.pos = i + op.length;
    this.host.enter('parameter', off);
    const arg = this.readParamWord(quoted, at);
    this.host.leave();
    parts.push({ type: 'var', name, quoted, op, arg });
  }

  // The word inside `${X:-…}`, up to the matching `}`. Blanks and operators
  // are plain characters here.
  readParamWord(quoted, at) {
    const s = this.text;
    const parts = [];
    let lit = '';
    const flush = () => {
      if (lit) {
        pushLit(parts, lit, quoted);
        lit = '';
      }
    };
    for (;;) {
      if (this.pos >= s.length) throw this.unterminated('parameter', at);
      const c = s[this.pos];
      if (c === '}') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === undefined) throw this.unterminated('parameter', at);
        if (n === '\n') {
          this.pos += 2;
        } else if (!quoted) {
          flush();
          pushLit(parts, n, true);
          this.pos += 2;
        } else if (n === '$' || n === '`' || n === '"' || n === '\\' || n === '}') {
          lit += n;
          this.pos += 2;
        } else {
          lit += '\\';
          this.pos++;
        }
      } else if (c === "'" && !quoted) {
        flush();
        this.readSingle(parts);
      } else if (c === '"') {
        if (quoted) throw this.unsupported('parameter-expansion', this.pos);
        flush();
        this.readDouble(parts);
      } else if (c === '$') {
        flush();
        if (!this.readDollar(parts, quoted)) {
          lit += '$';
          this.pos++;
        }
      } else if (c === '`') {
        flush();
        this.readBacktick(parts, quoted);
      } else if (!quoted && (c === '*' || c === '?' || c === '[' || c === ']')) {
        flush();
        parts.push({ type: 'glob', text: c });
        this.pos++;
      } else if (!quoted && c === '{') {
        throw this.unsupported('parameter-expansion', this.pos);
      } else {
        lit += c;
        this.pos++;
      }
    }
    flush();
    return { parts: fixBrackets(parts) };
  }

  // At a backtick: collect the inner text (undoing \` \\ \$ and, inside
  // double quotes, \") and parse it as a nested program. In a heredoc body
  // (`inBody`) a \" is not modelled.
  readBacktick(parts, quoted, inBody = false) {
    const s = this.text;
    const at = this.pos;
    let inner = '';
    // map[k] is the original offset of inner[k], so errors inside point at the
    // real position whatever the unescaping removed
    const map = [];
    let i = at + 1;
    for (;;) {
      if (i >= s.length) throw this.unterminated('backtick', at);
      const c = s[i];
      if (c === '`') {
        map.push(this.off(i));
        i++;
        break;
      }
      if (c === '\\') {
        const n = s[i + 1];
        if (inBody && n === '"') throw this.unsupported('heredoc', i);
        if (n === '`' || n === '\\' || n === '$' || (quoted && n === '"')) {
          inner += n;
          map.push(this.off(i + 1));
          i += 2;
          continue;
        }
      }
      inner += c;
      map.push(this.off(i));
      i++;
    }
    this.pos = i;
    const off = this.off(at);
    this.host.enter('command-substitution', off);
    const program = this.host.parseNested(inner, map);
    this.host.leave();
    parts.push({ type: 'cmdsub', program, quoted, backtick: true });
  }

  /**
   * Called by the parser after a `<<`/`<<-` token and its delimiter word: a
   * heredoc redirection whose body is filled in when the next newline token
   * is read.
   * @returns {HeredocRedir}
   */
  heredoc(r, target) {
    const raw = this.text.slice(target.lo, target.hi);
    // shells keep `$x` or a backtick in a delimiter as text, with differences
    // in detail: never guess
    if (raw.includes('$') || raw.includes('`')) throw new Opaque('unsupported', 'heredoc', target.off);
    let delimiter = '';
    let quoted = false;
    for (const p of target.word.parts) {
      if (p.type !== 'lit' && p.type !== 'glob') throw new Opaque('unsupported', 'heredoc', target.off);
      delimiter += p.text;
      if (p.quoted) quoted = true;
    }
    if (delimiter.includes('\n')) throw new Opaque('unsupported', 'heredoc', target.off);
    const node = { op: r.op, delimiter, quoted, body: '', parts: [] };
    if (r.fd !== undefined) node.fd = r.fd;
    this.pending.push({ node, regPos: this.pos, level: this.subDepth, off: r.off });
    return node;
  }

  // At the newline token at nl, with heredocs pending: read their bodies in
  // order from the next line and move past the last terminator line. Each
  // body character is read once, so this stays linear.
  readHeredocBodies(nl) {
    const s = this.text;
    const first = this.pending[0];
    // the body starts after the newline that ends the redirection's line; a
    // newline inside a quoted word, a line continuation or a `$( … )` before
    // it places the body differently in different shells
    for (const p of this.pending) {
      if (p.level !== this.subDepth) throw new Opaque('unsupported', 'heredoc', p.off);
    }
    if (s.indexOf('\n', first.regPos) !== nl) throw new Opaque('unsupported', 'heredoc', first.off);
    let pos = nl + 1;
    for (const p of this.pending) {
      const { node } = p;
      const strip = node.op === '<<-';
      let body = '';
      const map = node.quoted ? null : [];
      for (;;) {
        if (pos >= s.length) throw new Opaque('unterminated', 'heredoc', p.off);
        let end = s.indexOf('\n', pos);
        if (end < 0) end = s.length;
        let from = pos;
        if (strip) while (from < end && s[from] === '\t') from++;
        const line = s.slice(from, end);
        pos = end + 1;
        if (line === node.delimiter) break;
        if (!node.quoted) {
          // `\` at the end of a line joins it with the next in some shells,
          // which can hide the terminator: never guess
          let k = end - 1;
          while (k >= from && s[k] === '\\') k--;
          if ((end - 1 - k) % 2 === 1) throw new Opaque('unsupported', 'heredoc', this.off(end - 1));
          for (let i = from; i <= end; i++) map.push(this.off(Math.min(i, s.length - 1)));
        }
        body += line + '\n';
      }
      node.body = body;
      if (node.quoted || body === '') node.parts = [{ type: 'lit', text: body, quoted: true }];
      else node.parts = this.host.parseHeredocBody(body, map);
    }
    this.pending = [];
    this.pos = Math.min(pos, s.length);
  }

  // The whole text as an unquoted heredoc body: like double quotes, except
  // that `"` is plain and `\` escapes only `$` `` ` `` and `\`.
  readHeredocParts() {
    const s = this.text;
    const parts = [];
    let buf = '';
    const flush = () => {
      if (buf) {
        pushLit(parts, buf, true);
        buf = '';
      }
    };
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === '$' || n === '`' || n === '\\') {
          buf += n;
          this.pos += 2;
        } else {
          buf += '\\';
          this.pos++;
        }
      } else if (c === '$') {
        flush();
        if (!this.readDollar(parts, true)) {
          buf += '$';
          this.pos++;
        }
      } else if (c === '`') {
        flush();
        this.readBacktick(parts, true, true);
      } else {
        buf += c;
        this.pos++;
      }
    }
    flush();
    return parts;
  }
}
