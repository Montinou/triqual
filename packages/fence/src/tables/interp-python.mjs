// Python inline code allowlist (spec, "Interpreter inline code": `python -c`, `python3 -I -c`, a
// heredoc fed to python).
//
//   checkPython(code, {isolated, cwdFiles, writtenIndex})
//     -> {safe: true, reads: string[]} | {opaque: true, reason}
//
//   isolated      true when `-I` was given
//   cwdFiles      entry names (basenames) of the effective cwd; a trailing '/' marks a directory
//   writtenIndex  the written-files index (a Set of realpaths); null/undefined (unknown or
//                 incomplete) is opaque
//   reads         the literal paths of `open(<literal>, <literal read mode>)`, first-seen order
//
// The code is tokenized by a real Python tokenizer (string prefixes, triple quotes, f-string
// replacement fields, comments, line continuations, unicode identifiers judged after NFKC, numbers,
// operators, brackets) and judged by a small recursive-descent checker over the tokens. Allowed:
// `import json|re|math|sys` (plain, comma-separated, no `as`, no dots, no `from`), the module
// attributes in MODULE_ATTRS, `print(...)`, `open(...)` as above, literals, f-strings whose fields
// pass the same check, operators, subscripts and calls on values, and on values only the method
// names in VALUE_METHODS. Everything else is opaque: any other name (builtins such as getattr,
// vars, globals, eval, exec, compile, __import__, undefined variables), dunder names, assignment,
// compound statements, comprehensions, lambda, a bare module or builtin used as a value (so no
// subscript of a module or builtin), `str.format`. A construct the tokenizer cannot classify with
// certainty (an ambiguity between Python versions, an unknown string prefix such as t'', a coding
// cookie other than utf-8, a carriage return, a BOM) is opaque. Constructs that would import a module
// at run time are opaque too: encode/decode/open(encoding=) with a codec outside SAFE_ENCODINGS, and a
// re pattern that is not a string literal or holds \N{ (unicodedata). The cwd rule (without -I) covers
// SHADOW_NAMES and EXTRA_SHADOW_NAMES. The checker never throws and runs in time linear in the input
// (capped at MAX_BYTES, nesting capped at MAX_NESTING).

import { MAX_BYTES } from '../norm/tokenize.mjs';

// The nesting limit: at most MAX_NESTING open brackets at once in one tokenized text (the code, or
// one f-string field). CHECK_DEPTH bounds the checker's recursion (a bracket level costs at most
// four frames); deeper input, such as brackets inside nested f-string fields, is opaque 'nesting'.
export const MAX_NESTING = 32;
export const CHECK_DEPTH = MAX_NESTING * 4;

export const MODULES = Object.freeze(['json', 're', 'math', 'sys']);

// Entries of the cwd that shadow a module the allowlist imports, or a startup hook (spec list).
export const SHADOW_NAMES = Object.freeze(['json.py', 're.py', 'math.py', 'sys.py', 'sitecustomize.py', 'usercustomize.py']);
// Modules json, re and math import transitively on CPython 3.8-3.13, and the modules codec lookups
// and lazy imports reach (\N{...} escapes load unicodedata). Without -I a cwd entry of these names
// would load first, so it is opaque like the spec's names.
export const EXTRA_SHADOW_NAMES = Object.freeze([
  'enum', 'functools', 'copyreg', 'collections', 'types', 'operator', 'keyword', 'reprlib', 'abc', 'codecs',
  'string', 'contextlib', 'itertools', 'heapq', 'decoder', 'encoder', 'scanner',
  'sre_compile', 'sre_parse', 'sre_constants', '_sre', '_json', '_collections_abc',
  'unicodedata', 'base64', 'quopri', 'bz2', 'zlib', 'lzma', 'stringprep', 'binascii', 'encodings', 'idna', 'uu',
]);
const SHADOW_STEMS = new Set([...SHADOW_NAMES.map((n) => n.slice(0, -3)), ...EXTRA_SHADOW_NAMES]);
// A cwd entry shadows a module when it is a directory of the stem's name, or a file `<stem>.<...>.<ext>`
// with one of these extensions (source, sourceless bytecode, extension module, path file).
export const SHADOW_EXTENSIONS = Object.freeze(['py', 'pyc', 'so', 'pyd', 'pth']);
const STARTUP_STEMS = new Set(['sitecustomize', 'usercustomize']);

// The only codec names encode()/decode()/open(encoding=) accept: built-in codecs that import nothing.
export const SAFE_ENCODINGS = Object.freeze(new Set(['utf-8', 'utf8', 'ascii', 'latin-1', 'latin1', 'iso-8859-1']));
// re functions whose first argument is a pattern: it must be a string literal without \N{.
export const RE_PATTERN_FUNCS = Object.freeze(new Set(['sub', 'subn', 'match', 'search', 'fullmatch', 'findall', 'finditer', 'split', 'compile']));
// Value methods that take a codec name.
const CODEC_METHODS = new Set(['encode', 'decode']);

// Module attributes usable as `mod.attr`. sys.stdin is usable as a value (json.load(sys.stdin)) and
// then only through VALUE_METHODS (read, readline, readlines; no `.buffer`).
export const MODULE_ATTRS = Object.freeze({
  json: new Set(['dumps', 'loads', 'load']),
  re: new Set([
    'sub', 'subn', 'match', 'search', 'fullmatch', 'findall', 'finditer', 'split', 'escape', 'compile',
    'I', 'IGNORECASE', 'M', 'MULTILINE', 'S', 'DOTALL', 'X', 'VERBOSE', 'A', 'ASCII',
  ]),
  math: new Set([
    'pi', 'e', 'tau', 'inf', 'nan', 'sqrt', 'isqrt', 'floor', 'ceil', 'trunc', 'fabs', 'copysign', 'fmod',
    'modf', 'frexp', 'ldexp', 'log', 'log2', 'log10', 'log1p', 'exp', 'expm1', 'pow', 'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'hypot', 'dist', 'degrees', 'radians',
    'factorial', 'gcd', 'lcm', 'comb', 'perm', 'prod', 'fsum', 'isfinite', 'isinf', 'isnan', 'isclose',
  ]),
  sys: new Set(['argv', 'stdin']),
});

// str methods (minus format/format_map, which reach attributes through the format string).
export const STRING_METHODS = Object.freeze(new Set([
  'capitalize', 'casefold', 'center', 'count', 'encode', 'endswith', 'expandtabs', 'find', 'index',
  'isalnum', 'isalpha', 'isascii', 'isdecimal', 'isdigit', 'isidentifier', 'islower', 'isnumeric',
  'isprintable', 'isspace', 'istitle', 'isupper', 'join', 'ljust', 'lower', 'lstrip', 'maketrans',
  'partition', 'removeprefix', 'removesuffix', 'replace', 'rfind', 'rindex', 'rjust', 'rpartition',
  'rsplit', 'rstrip', 'split', 'splitlines', 'startswith', 'strip', 'swapcase', 'title', 'translate',
  'upper', 'zfill',
]));
// Read methods of sys.stdin and of a file open() returned in a read mode, and bytes.decode.
export const READ_METHODS = Object.freeze(new Set(['read', 'readline', 'readlines']));
export const VALUE_METHODS = Object.freeze(new Set([...STRING_METHODS, ...READ_METHODS, 'decode']));

// Builtins callable by name (only in call position).
export const CALLABLES = Object.freeze(new Set(['print', 'open']));
// Keyword arguments open() accepts, each a literal string.
const OPEN_KWARGS = new Set(['mode', 'encoding']);

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);
const STRING_PREFIXES = new Set(['r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf']);
const BINARY_KEYWORDS = new Set(['and', 'or', 'in', 'is']);
const BINARY_OPS = new Set([
  '+', '-', '*', '/', '//', '%', '**', '@', '<<', '>>', '&', '|', '^', '<', '>', '<=', '>=', '==', '!=',
]);
const UNARY_OPS = new Set(['+', '-', '~']);
// Longest first.
const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...', '->', ':=', '!=', '==', '<=', '>=', '**', '//', '<<', '>>', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '@=', '+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '(',
  ')', '[', ']', '{', '}', ',', ':', '.', ';', '=',
];
const OPEN_BRACKETS = { '(': ')', '[': ']', '{': '}' };
const CLOSE_BRACKETS = new Set([')', ']', '}']);
const NUMBER = /^(?:(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:0(?:_?0)*|[1-9](?:_?[0-9])*))|(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?[jJ]?|[0-9](?:_?[0-9])*[jJ])$/;
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
const CODING = /coding[:=][ \t]*([-\w.]+)/;
const CODING_LINE = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;
const ESCAPES = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

class Opaque extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason) => {
  throw new Opaque(reason);
};

const isDunder = (name) => name.length > 4 && name.startsWith('__') && name.endsWith('__');
const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) >= 0x80;
const isIdChar = (c) => isIdStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

// --- tokenizer ---------------------------------------------------------------------------------
// Tokens: {t:'name', v} (NFKC), {t:'num'}, {t:'str', bytes, raw, f, body, fields}, {t:'op', v},
// {t:'nl'}, {t:'eof'}. With expr=true (an f-string field) there is no indentation and no newline.

function tokenize(src, expr) {
  const toks = [];
  const brackets = [];
  let i = 0;
  let line = 1;
  let lineStart = !expr;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (lineStart && brackets.length === 0) {
      lineStart = false;
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\f')) j += 1;
      if (j > i && j < n && src[j] !== '\n' && src[j] !== '#') fail('indent');
      i = j;
      continue;
    }
    if (c === '#') {
      if (expr) fail('fstring');
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      const m = line <= 2 ? CODING.exec(src.slice(i, j)) : null;
      if (m && !['utf-8', 'utf8'].includes(m[1].toLowerCase())) fail('encoding');
      i = j;
      continue;
    }
    if (c === '\n') {
      if (expr) fail('fstring');
      line += 1;
      i += 1;
      if (brackets.length > 0) continue;
      const last = toks[toks.length - 1];
      if (last && last.t !== 'nl') toks.push({ t: 'nl' });
      lineStart = true;
      continue;
    }
    if (c === '\\') {
      if (expr || src[i + 1] !== '\n') fail('backslash');
      line += 1;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') {
      i += 1;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n) {
        const d = src[j];
        if (isIdChar(d) || d === '.') j += 1;
        else if ((d === '+' || d === '-') && /[eE]/.test(src[j - 1]) && !/^0[xX]/.test(src.slice(i, j))) j += 1;
        else break;
      }
      if (!NUMBER.test(src.slice(i, j))) fail('number');
      toks.push({ t: 'num' });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdChar(src[j])) j += 1;
      const raw = src.slice(i, j);
      if (src[j] === '"' || src[j] === "'") {
        const prefix = raw.toLowerCase();
        if (!STRING_PREFIXES.has(prefix)) fail('prefix');
        const r = readString(src, j, prefix, expr);
        toks.push(r.tok);
        line += r.lines;
        i = r.end;
        continue;
      }
      toks.push({ t: 'name', v: identifier(raw) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const r = readString(src, i, '', expr);
      toks.push(r.tok);
      line += r.lines;
      i = r.end;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) fail('char');
    if (OPEN_BRACKETS[op]) {
      if (brackets.length >= MAX_NESTING) fail('nesting');
      brackets.push(OPEN_BRACKETS[op]);
    } else if (CLOSE_BRACKETS.has(op)) {
      if (brackets.pop() !== op) fail('syntax');
    }
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  if (brackets.length > 0) fail('syntax');
  toks.push({ t: 'eof' });
  return toks;
}

function identifier(raw) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  const v = raw.normalize('NFKC');
  if (!IDENTIFIER.test(v) || KEYWORDS.has(v)) fail('name');
  return v;
}

// A string literal at src[q] (the opening quote). Inside an f-string field (expr) a backslash is
// opaque. Returns {tok, end, lines}.
function readString(src, q, prefix, expr) {
  const quote = src[q];
  const triple = src.startsWith(quote.repeat(3), q);
  const delim = triple ? quote.repeat(3) : quote;
  const raw = prefix.includes('r');
  const f = prefix.includes('f');
  const tok = { t: 'str', bytes: prefix.includes('b'), raw, f, body: '', fields: [] };
  let i = q + delim.length;
  let lines = 0;
  const start = i;
  const n = src.length;
  while (true) {
    if (i >= n) fail('string');
    const c = src[i];
    if (src.startsWith(delim, i)) break;
    if (c === '\r' || c === '\0') fail('char');
    if (c === '\n') {
      if (!triple) fail('string');
      lines += 1;
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (expr) fail('fstring');
      const d = src[i + 1];
      if (d === undefined) fail('string');
      if (f && (d === '{' || d === '}' || (!raw && d === 'N'))) fail('fstring');
      if (d === '\n') lines += 1;
      i += 2;
      continue;
    }
    if (f && c === '{') {
      if (src[i + 1] === '{') {
        i += 2;
        continue;
      }
      i = readField(src, i + 1, quote, tok.fields, 0);
      continue;
    }
    if (f && c === '}') {
      if (src[i + 1] !== '}') fail('fstring');
      i += 2;
      continue;
    }
    i += 1;
  }
  tok.body = src.slice(start, i);
  return { tok, end: i + delim.length, lines };
}

// An f-string replacement field starting at src[i] (after '{'). The expression text is pushed on
// fields; returns the index after the closing '}'. Inside a field the enclosing quote character,
// a backslash, '#' or a newline is opaque: Python 3.11 rejects them and 3.12 reads them differently,
// so refusing them gives one reading of where the string ends.
function readField(src, i, quote, fields, depth) {
  if (depth > 2) fail('fstring');
  const n = src.length;
  const stack = [];
  const exprStart = i;
  let exprEnd = -1;
  while (true) {
    if (i >= n) fail('fstring');
    const c = src[i];
    if (c === quote || c === '\\' || c === '#' || c === '\n' || c === '\r') fail('fstring');
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      let j = i + delim.length;
      while (!src.startsWith(delim, j)) {
        if (j >= n) fail('fstring');
        const d = src[j];
        if (d === quote || d === '\\' || d === '\n' || d === '\r') fail('fstring');
        j += 1;
      }
      i = j + delim.length;
      continue;
    }
    if (OPEN_BRACKETS[c]) {
      if (stack.length >= MAX_NESTING) fail('nesting');
      stack.push(OPEN_BRACKETS[c]);
      i += 1;
      continue;
    }
    if (stack.length > 0) {
      if (CLOSE_BRACKETS.has(c) && stack.pop() !== c) fail('fstring');
      i += 1;
      continue;
    }
    if (c === '}' || c === ':' || (c === '!' && src[i + 1] !== '=')) {
      exprEnd = i;
      break;
    }
    if (CLOSE_BRACKETS.has(c)) fail('fstring');
    i += 1;
  }
  let text = src.slice(exprStart, exprEnd);
  const trimmed = text.trimEnd();
  if (trimmed.endsWith('=') && !/[=!<>]=$/.test(trimmed)) text = trimmed.slice(0, -1);
  if (text.trim() === '') fail('fstring');
  fields.push(text);
  i = exprEnd;
  if (src[i] === '!') {
    if (!'sra'.includes(src[i + 1] ?? 'x') || (src[i + 2] !== ':' && src[i + 2] !== '}')) fail('fstring');
    i += 2;
  }
  if (src[i] === ':') {
    i += 1;
    while (true) {
      if (i >= n) fail('fstring');
      const c = src[i];
      if (c === quote || c === '\\' || c === '\n' || c === '\r') fail('fstring');
      if (c === '}') break;
      if (c === '{') {
        i = readField(src, i + 1, quote, fields, depth + 1);
        continue;
      }
      i += 1;
    }
  }
  if (src[i] !== '}') fail('fstring');
  return i + 1;
}

// The value of a plain (non-f) string literal body; null when it cannot be known exactly.
function stringValue(tok) {
  if (tok.raw) return tok.body;
  let out = '';
  const s = tok.body;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const d = s[i + 1];
    i += 1;
    if (d === '\n') continue;
    if (Object.hasOwn(ESCAPES, d)) {
      out += ESCAPES[d];
      continue;
    }
    const hex = { x: 2, u: 4, U: 8 }[d];
    if (hex !== undefined && !(tok.bytes && d !== 'x')) {
      const h = s.slice(i + 1, i + 1 + hex);
      if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(h)) return null;
      const cp = parseInt(h, 16);
      // Python keeps each \uD8xx escape a separate (lone) surrogate; JS would pair them.
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
      out += String.fromCodePoint(cp);
      i += hex;
      continue;
    }
    if (d >= '0' && d <= '7') {
      let j = i;
      while (j < i + 3 && s[j] >= '0' && s[j] <= '7') j += 1;
      out += String.fromCodePoint(parseInt(s.slice(i, j), 8));
      i = j - 1;
      continue;
    }
    if (d === 'N') return null;
    out += `\\${d}`;
  }
  return out;
}

// --- checker -----------------------------------------------------------------------------------

class Checker {
  constructor(toks, state) {
    this.toks = toks;
    this.p = 0;
    this.state = state; // {imported: Set, reads: string[], depth}
  }

  peek(k = 0) {
    return this.toks[this.p + k];
  }

  isOp(v, k = 0) {
    const t = this.peek(k);
    return t.t === 'op' && t.v === v;
  }

  isName(v, k = 0) {
    const t = this.peek(k);
    return t.t === 'name' && t.v === v;
  }

  next() {
    const t = this.toks[this.p];
    if (t.t !== 'eof') this.p += 1;
    return t;
  }

  expectOp(v, reason = 'syntax') {
    if (!this.isOp(v)) fail(reason);
    this.p += 1;
  }

  enter() {
    this.state.depth += 1;
    if (this.state.depth > CHECK_DEPTH) fail('nesting');
  }

  leave() {
    this.state.depth -= 1;
  }

  module() {
    while (this.peek().t !== 'eof') {
      if (this.peek().t === 'nl' || this.isOp(';')) {
        this.p += 1;
        continue;
      }
      this.statement();
      const t = this.peek();
      if (t.t === 'eof' || t.t === 'nl' || (t.t === 'op' && t.v === ';')) continue;
      fail(t.t === 'op' && t.v.endsWith('=') && t.v !== '==' ? 'assignment' : 'syntax');
    }
  }

  statement() {
    if (this.isName('import')) {
      this.p += 1;
      while (true) {
        const t = this.next();
        if (t.t !== 'name' || !MODULES.includes(t.v)) fail('import');
        if (this.isOp('.') || this.isName('as')) fail('import');
        this.state.imported.add(t.v);
        if (!this.isOp(',')) return;
        this.p += 1;
      }
    }
    if (this.isName('from')) fail('import');
    this.exprList();
  }

  exprList() {
    this.expr();
    while (this.isOp(',')) {
      this.p += 1;
      if (this.endsList()) return;
      this.expr();
    }
  }

  endsList() {
    const t = this.peek();
    return t.t === 'eof' || t.t === 'nl' || (t.t === 'op' && (CLOSE_BRACKETS.has(t.v) || t.v === ';' || t.v === '='));
  }

  // A superset of Python's expression grammar for the allowed atoms: operators between safe
  // values are safe, and an input Python rejects never runs.
  expr() {
    this.enter();
    this.operand();
    while (true) {
      const t = this.peek();
      if (t.t === 'op' && BINARY_OPS.has(t.v)) {
        this.p += 1;
      } else if (t.t === 'name' && BINARY_KEYWORDS.has(t.v)) {
        this.p += 1;
        if ((t.v === 'is' || t.v === 'in') && this.isName('not')) this.p += 1;
      } else if (t.t === 'name' && t.v === 'not' && this.isName('in', 1)) {
        this.p += 2;
      } else if (t.t === 'name' && t.v === 'if') {
        this.p += 1;
        this.operandChain();
        if (!this.isName('else')) fail('syntax');
        this.p += 1;
      } else {
        break;
      }
      this.operand();
    }
    this.leave();
  }

  operandChain() {
    this.operand();
    while (true) {
      const t = this.peek();
      if (t.t === 'op' && BINARY_OPS.has(t.v)) this.p += 1;
      else if (t.t === 'name' && BINARY_KEYWORDS.has(t.v)) {
        this.p += 1;
        if ((t.v === 'is' || t.v === 'in') && this.isName('not')) this.p += 1;
      } else if (t.t === 'name' && t.v === 'not' && this.isName('in', 1)) this.p += 2;
      else return;
      this.operand();
    }
  }

  operand() {
    while (this.isName('not') || (this.peek().t === 'op' && UNARY_OPS.has(this.peek().v))) this.p += 1;
    this.atom();
    this.trailers();
  }

  atom() {
    const t = this.next();
    if (t.t === 'num') return;
    if (t.t === 'str') {
      this.stringParts(t);
      while (this.peek().t === 'str') this.stringParts(this.next());
      return;
    }
    if (t.t === 'op') {
      if (t.v === '...') return;
      if (t.v === '(' || t.v === '[') {
        this.enter();
        const close = OPEN_BRACKETS[t.v];
        if (!this.isOp(close)) this.exprList();
        if (this.isName('for') || this.isName('async')) fail('comprehension');
        this.expectOp(close);
        this.leave();
        return;
      }
      if (t.v === '{') {
        this.enter();
        while (!this.isOp('}')) {
          if (this.isOp('**') || this.isOp('*')) fail('syntax');
          this.expr();
          if (this.isOp(':')) {
            this.p += 1;
            this.expr();
          }
          if (this.isName('for') || this.isName('async')) fail('comprehension');
          if (!this.isOp(',')) break;
          this.p += 1;
        }
        this.expectOp('}');
        this.leave();
        return;
      }
      fail('syntax');
    }
    if (t.t !== 'name') fail('syntax');
    const name = t.v;
    if (name === 'True' || name === 'False' || name === 'None') return;
    if (KEYWORDS.has(name)) fail(name === 'lambda' ? 'lambda' : 'syntax');
    if (isDunder(name)) fail('dunder');
    if (MODULES.includes(name) && this.state.imported.has(name)) {
      if (!this.isOp('.')) fail('module');
      this.p += 1;
      const a = this.next();
      if (a.t !== 'name' || !MODULE_ATTRS[name].has(a.v)) fail(a.t === 'name' && isDunder(a.v) ? 'dunder' : 'attribute');
      if (name === 're' && RE_PATTERN_FUNCS.has(a.v)) this.rePattern();
      return;
    }
    if (CALLABLES.has(name)) {
      if (!this.isOp('(')) fail('builtin');
      this.p += 1;
      if (name === 'open') this.openArgs();
      else this.callArgs();
      return;
    }
    fail('name');
  }

  // At a re pattern function: it must be called here, its first argument must be plain string
  // literals, its arguments hold no f-string, and no run of adjacent string literals in them may
  // hold \N{ (which loads unicodedata), in its source text or in its decoded value ('\x5cN{',
  // '\134N{', '\\' 'N{').
  rePattern() {
    if (!this.isOp('(')) fail('re-pattern');
    let k = this.p + 1;
    if (this.toks[k].t !== 'str') fail('re-pattern');
    while (this.toks[k].t === 'str') {
      if (this.toks[k].f) fail('re-pattern');
      k += 1;
    }
    const after = this.toks[k];
    if (after.t !== 'op' || (after.v !== ',' && after.v !== ')')) fail('re-pattern');
    let depth = 0;
    for (k = this.p; k < this.toks.length; k += 1) {
      const t = this.toks[k];
      if (t.t === 'str') {
        let decoded = '';
        while (this.toks[k].t === 'str') {
          const s = this.toks[k];
          // An f-string's value is not known here (f'\x5cN{"{DIGIT ONE}"}' builds \N{ at run time).
          if (s.f || s.body.includes('\\N{')) fail('re-pattern');
          const v = stringValue(s);
          if (v === null) fail('re-pattern');
          decoded += v;
          k += 1;
        }
        if (decoded.includes('\\N{')) fail('re-pattern');
        k -= 1;
        continue;
      }
      if (t.t !== 'op') continue;
      if (OPEN_BRACKETS[t.v]) depth += 1;
      else if (CLOSE_BRACKETS.has(t.v)) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  // After `.encode`/`.decode`: called here with no argument or one literal from SAFE_ENCODINGS.
  codecCall() {
    if (!this.isOp('(')) fail('codec');
    this.p += 1;
    if (this.isOp(')')) {
      this.p += 1;
      return;
    }
    const v = this.literal();
    if (v === null || !SAFE_ENCODINGS.has(v.toLowerCase())) fail('codec');
    if (this.isOp(',')) this.p += 1;
    this.expectOp(')', 'codec');
  }

  stringParts(t) {
    if (!t.f) return;
    for (const text of t.fields) {
      const sub = new Checker(tokenize(text, true), this.state);
      sub.exprList();
      if (sub.peek().t !== 'eof') fail('fstring');
    }
  }

  trailers() {
    while (true) {
      if (this.isOp('.')) {
        this.p += 1;
        const a = this.next();
        if (a.t !== 'name') fail('syntax');
        if (isDunder(a.v)) fail('dunder');
        if (!VALUE_METHODS.has(a.v)) fail('attribute');
        if (CODEC_METHODS.has(a.v)) this.codecCall();
      } else if (this.isOp('(')) {
        this.p += 1;
        this.callArgs();
      } else if (this.isOp('[')) {
        this.p += 1;
        this.enter();
        this.subscript();
        this.expectOp(']');
        this.leave();
      } else {
        return;
      }
    }
  }

  subscript() {
    while (true) {
      for (let k = 0; k < 3; k += 1) {
        if (!this.isOp(':') && !this.isOp(',') && !this.isOp(']')) this.expr();
        if (k < 2 && this.isOp(':')) this.p += 1;
        else break;
      }
      if (!this.isOp(',')) return;
      this.p += 1;
      if (this.isOp(']')) return;
    }
  }

  // After '(' of a call; consumes ')'.
  callArgs() {
    this.enter();
    while (!this.isOp(')')) {
      if (this.isOp('**')) fail('syntax');
      if (this.isOp('*')) this.p += 1;
      else if (this.peek().t === 'name' && this.isOp('=', 1)) {
        if (isDunder(this.peek().v)) fail('dunder');
        this.p += 2;
      }
      this.expr();
      if (this.isName('for') || this.isName('async')) fail('comprehension');
      if (!this.isOp(',')) break;
      this.p += 1;
    }
    this.expectOp(')');
    this.leave();
  }

  // A literal str from one or more adjacent plain string tokens, or null.
  literal() {
    let out = '';
    let any = false;
    while (this.peek().t === 'str') {
      const t = this.next();
      if (t.f || t.bytes) return null;
      const v = stringValue(t);
      if (v === null) return null;
      out += v;
      any = true;
    }
    return any ? out : null;
  }

  // open(<literal path>[, <literal read mode>][, mode=<lit>][, encoding=<lit>]); consumes ')'.
  openArgs() {
    const path = this.literal();
    if (path === null || path === '' || path.includes('\0') || !path.isWellFormed()) fail('open');
    let mode = 'r';
    let positional = 1;
    const seen = new Set();
    while (this.isOp(',')) {
      this.p += 1;
      if (this.isOp(')')) break;
      let key;
      if (this.peek().t === 'name' && this.isOp('=', 1)) {
        key = this.next().v;
        this.p += 1;
        if (!OPEN_KWARGS.has(key) || seen.has(key)) fail('open');
      } else {
        if (seen.size > 0 || positional !== 1) fail('open');
        key = 'mode';
        positional += 1;
      }
      seen.add(key);
      const v = this.literal();
      if (v === null) fail('open');
      if (key === 'mode') mode = v;
      if (key === 'encoding' && !SAFE_ENCODINGS.has(v.toLowerCase())) fail('open');
      if (!this.isOp(',') && !this.isOp(')')) fail('open');
    }
    this.expectOp(')', 'open');
    if (!isReadMode(mode)) fail('open');
    if (!this.state.reads.includes(path)) this.state.reads.push(path);
  }
}

function isReadMode(mode) {
  if (!/^[rbt]{1,3}$/.test(mode) || new Set(mode).size !== mode.length) return false;
  return mode.includes('r') && !(mode.includes('b') && mode.includes('t'));
}

// --- environment rules -------------------------------------------------------------------------

function shadowed(cwdFiles) {
  if (!Array.isArray(cwdFiles)) return true;
  for (const entry of cwdFiles) {
    if (typeof entry !== 'string') return true;
    // A name without a dot may be a directory (a package); a name with one shadows only with an
    // importable extension (json.py, json.cpython-312-darwin.so); math.txt does not.
    const name = entry.replace(/\/+$/, '').toLowerCase();
    if (SHADOW_STEMS.has(name)) return true;
    const dot = name.indexOf('.');
    if (dot < 0) continue;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    if (SHADOW_STEMS.has(name.slice(0, dot)) && SHADOW_EXTENSIONS.includes(ext)) return true;
  }
  return false;
}

// A startup file in the written index: any `*.pth`, or a path component whose stem is
// sitecustomize/usercustomize (the module, its package directory, .pyc, .so, .pyd).
function startupFileWritten(index) {
  if (index === null || typeof index !== 'object' || typeof index[Symbol.iterator] !== 'function') return true;
  for (const p of index) {
    if (typeof p !== 'string') return true;
    const parts = p.toLowerCase().split(/[/\\]/);
    if (parts[parts.length - 1].endsWith('.pth')) return true;
    for (const part of parts) {
      const dot = part.indexOf('.');
      if (STARTUP_STEMS.has(dot < 0 ? part : part.slice(0, dot))) return true;
    }
  }
  return false;
}

// A coding cookie on physical line 1 or 2 (anywhere on those lines' text, even inside a string)
// other than utf-8.
function foreignCoding(code) {
  for (const line of code.split('\n', 2)) {
    const m = CODING_LINE.exec(line);
    if (m && !['utf-8', 'utf8'].includes(m[1].toLowerCase())) return true;
  }
  return false;
}

export function checkPython(code, opts) {
  try {
    if (typeof code !== 'string' || opts === null || typeof opts !== 'object') return { opaque: true, reason: 'input' };
    if (code.length > MAX_BYTES || Buffer.byteLength(code, 'utf8') > MAX_BYTES) return { opaque: true, reason: 'size' };
    const { isolated, cwdFiles, writtenIndex } = opts;
    if (startupFileWritten(writtenIndex)) return { opaque: true, reason: 'startup-file' };
    if (isolated !== true && shadowed(cwdFiles)) return { opaque: true, reason: 'cwd-shadow' };
    if (/[\r\0\ufeff]/.test(code)) return { opaque: true, reason: 'char' };
    if (foreignCoding(code)) return { opaque: true, reason: 'encoding' };
    const state = { imported: new Set(), reads: [], depth: 0 };
    new Checker(tokenize(code, false), state).module();
    return { safe: true, reads: state.reads };
  } catch (err) {
    return { opaque: true, reason: err instanceof Opaque ? err.reason : 'internal' };
  }
}
