// Node inline code allowlist (spec, "Interpreter inline code": `node -e`, `node -p`, a heredoc fed
// to node).
//
//   checkNode(code, {isolated, cwdFiles, writtenIndex}?)
//     -> {safe: true, reads: string[]} | {opaque: true, reason}
//
//   The options are accepted for symmetry with checkPython and ignored: `node -e` resolves
//   `require` relative to the cwd, but `require`, `import`, `import()`, `module`, `process.binding`
//   and `process.mainModule` are all opaque here, so no module is ever loaded from the cwd or from an
//   agent-written file and no cwd rule is needed. Code-loading variables and flags (NODE_OPTIONS,
//   --require, --import) are the normalizer's concern. `reads` is always empty: nothing in the
//   allowlist opens a file.
//
// The code is tokenized by a real JavaScript tokenizer (single and double quoted strings with every
// escape form and line continuations, template literals with nested substitutions, regex literal
// versus divide decided by the previous token, line and block comments, numeric literals with
// separators, bigint, hex, octal and binary, identifiers with \u escapes decoded) and judged by a
// small recursive-descent checker over the tokens. Identifiers are compared by code points, as
// JavaScript does (no NFKC): any name outside the allowlist is opaque.
//
// Allowed: expression statements only (so `-p` prints the last one); literals, array literals,
// object literals with plain keys; operators; `JSON`, `console` and `Math` members from
// GLOBAL_MEMBERS (a method must be called where it is named); `process.argv`; `process.stdin` read
// through STDIN_METHODS; on values, VALUE_PROPERTIES, the methods in VALUE_METHODS (called where named)
// and a numeric literal index; arrow functions as call arguments, with plain parameters and an
// expression body that passes the same check. This keeps one invariant: the only function values
// are checked arrows, and every call names an allowlisted method directly, so no call reaches
// constructors, prototypes, call/apply/bind or a getter.
//
// Opaque: any other name (FORBIDDEN_NAMES lists the dangerous ones: require, eval, Function,
// globalThis, module, arguments...), escaped spellings of reserved words, computed member access,
// optional chaining, `new`, `this`, `import`, `delete`/`typeof`/`void`, `in`/`instanceof`,
// assignment, declarations, blocks, labels, other statements, function and class definitions,
// getters/setters/methods and `__proto__` keys in object literals, spread, tagged templates, calls
// of anything but a named method, HTML-like comments, a newline where automatic semicolon insertion
// could change the reading, carriage returns, NUL, BOM and non-ASCII whitespace. The checker never
// throws and runs in time linear in the input (capped at MAX_BYTES, nesting capped at MAX_NESTING).

import { MAX_BYTES } from '../norm/tokenize.mjs';

// At most MAX_NESTING brackets and template substitutions open at once; CHECK_DEPTH bounds the
// checker's recursion (a bracket level costs at most four frames).
export const MAX_NESTING = 32;
export const CHECK_DEPTH = MAX_NESTING * 4;

const member = (methods, properties = []) => Object.freeze({ methods: new Set(methods), properties: new Set(properties) });

export const GLOBAL_MEMBERS = Object.freeze({
  JSON: member(['parse', 'stringify']),
  console: member(['log', 'error', 'warn', 'info']),
  Math: member(
    [
      'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil', 'clz32', 'cos', 'cosh',
      'exp', 'expm1', 'floor', 'fround', 'hypot', 'imul', 'log', 'log10', 'log1p', 'log2', 'max', 'min', 'pow',
      'random', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc',
    ],
    ['E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'],
  ),
});

// String, array, regex and number methods callable on a value. None of them runs a string as code
// or reaches a constructor; callbacks they take can only be checked arrows.
export const VALUE_METHODS = Object.freeze(new Set([
  // String.prototype
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes', 'indexOf', 'lastIndexOf',
  'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search', 'slice',
  'split', 'startsWith', 'substring', 'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart',
  // Array.prototype
  'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'join',
  'map', 'reduce', 'reduceRight', 'reverse', 'some', 'sort', 'toReversed', 'toSorted',
  // RegExp.prototype, Number.prototype
  'test', 'exec', 'toFixed', 'toPrecision',
]));
export const VALUE_PROPERTIES = Object.freeze(new Set(['length']));

// Names never allowed as members (documentation and a test that the allowlists exclude them).
export const FORBIDDEN_PROPERTIES = Object.freeze(new Set([
  'constructor', '__proto__', 'prototype', 'call', 'apply', 'bind', 'toString', 'valueOf', 'toLocaleString',
  'caller', 'callee', 'arguments', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'then', 'toJSON', 'mainModule', 'binding', 'env',
]));

// Globals that reach code loading, the global object, constructors or reflection; reason 'forbidden'.
// Every other unknown name is opaque too (reason 'name').
export const FORBIDDEN_NAMES = Object.freeze(new Set([
  'require', 'eval', 'Function', 'globalThis', 'global', 'window', 'self', 'module', 'exports', 'arguments',
  '__filename', '__dirname', 'Reflect', 'Proxy', 'Symbol', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'Promise', 'Buffer', 'WebAssembly', 'setTimeout', 'setInterval', 'setImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'Atomics', 'SharedArrayBuffer', 'Worker', 'navigator',
]));

// process.stdin read forms: setEncoding(<STDIN_ENCODINGS literal>), on|once(<STDIN_EVENTS literal>,
// <arrow>), read() with no argument. setEncoding/on/once return the stream; read() returns a value.
export const STDIN_METHODS = Object.freeze(new Set(['setEncoding', 'on', 'once', 'read']));
export const STDIN_EVENTS = Object.freeze(new Set(['data', 'end', 'readable']));
export const STDIN_ENCODINGS = Object.freeze(new Set(['utf8', 'utf-8', 'ascii', 'latin1']));

// Global value names usable as values (non-writable globals).
const VALUE_NAMES = new Set(['undefined', 'NaN', 'Infinity']);

// Reserved and contextual words: an escaped spelling of any of them is opaque.
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'async',
  'of', 'get', 'set',
]);
// Keywords after which a `/` starts a regex (they cannot end an expression).
const REGEX_AFTER = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);
// The reason a keyword in expression position gives.
const KEYWORD_REASONS = {
  this: 'this', super: 'this', new: 'new', import: 'import', export: 'import', function: 'function',
  class: 'function', async: 'function', typeof: 'unary', void: 'unary', delete: 'unary', in: 'operator',
  instanceof: 'operator', const: 'declaration', let: 'declaration', var: 'declaration', with: 'with',
  if: 'statement', for: 'statement', while: 'statement', do: 'statement', switch: 'statement', try: 'statement',
  return: 'statement', throw: 'statement', break: 'statement', continue: 'statement', debugger: 'statement',
  yield: 'statement', await: 'statement', case: 'statement', default: 'statement', else: 'statement',
  catch: 'statement', finally: 'statement', extends: 'statement', enum: 'statement',
};

const BINARY_OPS = new Set([
  '+', '-', '*', '/', '%', '**', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '&&', '||', '??', '&', '|', '^',
  '<<', '>>', '>>>',
]);
const UNARY_OPS = new Set(['!', '-', '+', '~']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
// Longest first.
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=',
  '&&', '||', '??', '?.', '**', '++', '--', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '{', '}',
  '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.',
];
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
// Punctuators that cannot continue an expression after a newline (so no ASI ambiguity).
const NON_CONTINUING = new Set([')', ']', '}', ';', '!', '~', '{']);
// Characters JavaScript treats as line terminators or whitespace beyond ' ', '\t', '\n' (and NUL):
// opaque anywhere, so there is one reading of where lines and tokens end.
const BAD_CHARS = /[\r\0\v\f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const IDENT_RAW = /(?:[\p{ID_Start}$_]|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4}))(?:[\p{ID_Continue}$\u200c\u200d]|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4}))*/uy;
const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
const IDENT_CHAR = /[\p{ID_Continue}$\\]/uy;
const NUMBER = /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|(?:0|[1-9](?:_?[0-9])*)n|(?:(?:0|[1-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?/y;
const REGEX_FLAGS = /^[dgimsuyv]*$/;
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

class Opaque extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason) => {
  throw new Opaque(reason);
};

const isDigit = (c) => c >= '0' && c <= '9';

// --- tokenizer ---------------------------------------------------------------------------------
// Tokens: {t:'name', v, esc}, {t:'num', int}, {t:'str', v (null when not known exactly)},
// {t:'regex'}, {t:'tmpl'} (no substitution), {t:'tmplHead'|'tmplMid'|'tmplTail'}, {t:'op', v},
// {t:'eof'}. Every token carries nl (a line terminator before it) and end (it can end an
// expression, so a following `/` divides). match[k] is the index of the ')' closing the '(' at k.

function tokenize(src) {
  const toks = [];
  const match = [];
  const stack = []; // {c: '(' | '[' | '{' | 'tmpl', k}
  const n = src.length;
  let i = 0;
  let nl = false;
  const push = (tok, end) => {
    tok.nl = nl;
    tok.end = end;
    nl = false;
    toks.push(tok);
  };
  const open = (c) => {
    if (stack.length >= MAX_NESTING) fail('nesting');
    stack.push({ c, k: toks.length });
  };
  const prevEnds = () => toks.length > 0 && toks[toks.length - 1].end;
  const template = (j, first) => {
    const r = scanTemplate(src, j);
    if (r.closed) push({ t: first ? 'tmpl' : 'tmplTail' }, true);
    else {
      open('tmpl');
      push({ t: first ? 'tmplHead' : 'tmplMid' }, false);
    }
    return r.end;
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      nl = true;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) fail('comment');
      if (src.slice(i + 2, j).includes('\n')) nl = true;
      i = j + 2;
      continue;
    }
    if (src.startsWith('<!--', i) || src.startsWith('-->', i)) fail('comment');
    if (c === '"' || c === "'") {
      const r = scanString(src, i);
      push({ t: 'str', v: r.value }, true);
      i = r.end;
      continue;
    }
    if (c === '`') {
      i = template(i + 1, true);
      continue;
    }
    if (c === '/' && !prevEnds()) {
      i = scanRegex(src, i);
      push({ t: 'regex' }, true);
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m === null) fail('number');
      const j = i + m[0].length;
      IDENT_CHAR.lastIndex = j;
      if (j < n && IDENT_CHAR.test(src)) fail('number');
      push({ t: 'num', int: /^(?:0|[1-9][0-9]*)$/.test(m[0]) }, true);
      i = j;
      continue;
    }
    IDENT_RAW.lastIndex = i;
    const id = IDENT_RAW.exec(src);
    if (id !== null) {
      const raw = id[0];
      const esc = raw.includes('\\');
      const v = esc ? decodeIdentifier(raw) : raw;
      const prev = toks[toks.length - 1];
      const afterDot = prev !== undefined && prev.t === 'op' && (prev.v === '.' || prev.v === '?.');
      push({ t: 'name', v, esc }, afterDot || esc || !REGEX_AFTER.has(v));
      i += raw.length;
      continue;
    }
    if (c === '\\') fail('escape');
    let op = PUNCTUATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) fail('char');
    if (op === '?.' && isDigit(src[i + 2] ?? '')) op = '?';
    if (op === '(' || op === '[' || op === '{') {
      open(op);
      push({ t: 'op', v: op }, false);
    } else if (op === '}' && stack.length > 0 && stack[stack.length - 1].c === 'tmpl') {
      stack.pop();
      i = template(i + 1, false);
      continue;
    } else if (CLOSERS[op]) {
      const top = stack.pop();
      if (top === undefined || top.c !== CLOSERS[op]) fail(top?.c === 'tmpl' ? 'template' : 'syntax');
      if (op === ')') match[top.k] = toks.length;
      push({ t: 'op', v: op }, true);
    } else {
      push({ t: 'op', v: op }, op === '++' || op === '--');
    }
    i += op.length;
  }
  if (stack.length > 0) fail(stack.some((s) => s.c === 'tmpl') ? 'template' : 'syntax');
  push({ t: 'eof' }, false);
  // A newline between a token that can end an expression and one that can continue it: whether a
  // semicolon is inserted there depends on the grammar, so refuse to guess.
  for (let k = 1; k < toks.length; k += 1) {
    const t = toks[k];
    if (!t.nl || !toks[k - 1].end) continue;
    if (t.t === 'tmpl' || t.t === 'tmplHead' || (t.t === 'op' && !NON_CONTINUING.has(t.v))) fail('asi');
  }
  return { toks, match };
}

function decodeIdentifier(raw) {
  const v = raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (m, braced, four) => {
    const cp = parseInt(braced ?? four, 16);
    if (!(cp <= 0x10ffff)) fail('escape');
    return String.fromCodePoint(cp);
  });
  if (!IDENT.test(v) || RESERVED.has(v)) fail('escape');
  return v;
}

// A quoted string at src[q]. Returns {value (null when an escape's value is not certain), end}.
function scanString(src, q) {
  const quote = src[q];
  const n = src.length;
  let i = q + 1;
  let value = '';
  let known = true;
  while (true) {
    if (i >= n) fail('string');
    const c = src[i];
    if (c === quote) break;
    if (c === '\n') fail('string');
    if (c !== '\\') {
      value += c;
      i += 1;
      continue;
    }
    const d = src[i + 1];
    if (d === undefined) fail('string');
    if (d === '\n') {
      i += 2;
      continue;
    }
    if (Object.hasOwn(SIMPLE_ESCAPES, d)) {
      value += SIMPLE_ESCAPES[d];
      i += 2;
      continue;
    }
    if (d === 'x') {
      const h = src.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) fail('string');
      value += String.fromCharCode(parseInt(h, 16));
      i += 4;
      continue;
    }
    if (d === 'u') {
      let h;
      let len;
      if (src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        if (close < 0) fail('string');
        h = src.slice(i + 3, close);
        len = close + 1 - i;
      } else {
        h = src.slice(i + 2, i + 6);
        len = 6;
        if (h.length !== 4) fail('string');
      }
      if (!/^[0-9a-fA-F]+$/.test(h)) fail('string');
      const cp = parseInt(h, 16);
      if (!(cp <= 0x10ffff)) fail('string');
      value += String.fromCodePoint(cp);
      i += len;
      continue;
    }
    if (d === '0' && !isDigit(src[i + 2] ?? '')) {
      value += '\0';
      i += 2;
      continue;
    }
    // Legacy octal (\1, \01) and \8 \9: sloppy-mode forms whose value is not worth guessing.
    if (isDigit(d)) known = false;
    else value += d;
    i += 2;
  }
  return { value: known ? value : null, end: i + 1 };
}

// Template text from src[j] (after '`' or after the '}' closing a substitution) to the closing '`'
// ({closed: true}) or to the next '${' ({closed: false}). Returns the index after it.
function scanTemplate(src, j) {
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      if (j + 1 >= n) break;
      j += 2;
      continue;
    }
    if (c === '`') return { end: j + 1, closed: true };
    if (c === '$' && src[j + 1] === '{') return { end: j + 2, closed: false };
    j += 1;
  }
  fail('template');
}

// A regex literal at src[q] ('/'); returns the index after its flags.
function scanRegex(src, q) {
  const n = src.length;
  let i = q + 1;
  let inClass = false;
  while (true) {
    if (i >= n) fail('regex');
    const c = src[i];
    if (c === '\n') fail('regex');
    if (c === '\\') {
      if (i + 1 >= n || src[i + 1] === '\n') fail('regex');
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    i += 1;
  }
  i += 1;
  IDENT_RAW.lastIndex = i;
  const m = IDENT_RAW.exec(src);
  const flags = m === null ? '' : m[0];
  if (!REGEX_FLAGS.test(flags) || new Set(flags).size !== flags.length || (flags.includes('u') && flags.includes('v'))) fail('regex');
  return i + flags.length;
}

// --- checker -----------------------------------------------------------------------------------
// Expression kinds: 'value'; 'stdin0' (process.stdin itself, usable only through STDIN_METHODS);
// 'stdin' (the stream a stdin method returned; allowed only as a whole statement).

class Checker {
  constructor({ toks, match }) {
    this.toks = toks;
    this.match = match;
    this.p = 0;
    this.depth = 0;
    this.scopes = [];
  }

  peek(k = 0) {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }

  isOp(v, k = 0) {
    const t = this.peek(k);
    return t.t === 'op' && t.v === v;
  }

  next() {
    const t = this.toks[this.p];
    if (t.t !== 'eof') this.p += 1;
    return t;
  }

  expectOp(v) {
    if (!this.isOp(v)) this.failAt(this.peek());
    this.p += 1;
  }

  // The reason for a token found where it cannot stand.
  failAt(t) {
    if (t.t === 'op') {
      if (ASSIGN_OPS.has(t.v) || t.v === '++' || t.v === '--') fail('assignment');
      if (t.v === '=>') fail('function');
      if (t.v === '?.') fail('optional');
      if (t.v === '...') fail('spread');
    }
    if (t.t === 'name' && !t.esc && (t.v === 'in' || t.v === 'instanceof')) fail('operator');
    fail('syntax');
  }

  enter() {
    this.depth += 1;
    if (this.depth > CHECK_DEPTH) fail('nesting');
  }

  leave() {
    this.depth -= 1;
  }

  program() {
    while (this.peek().t !== 'eof') {
      if (this.isOp(';')) {
        this.p += 1;
        continue;
      }
      this.statement();
      const t = this.peek();
      if (t.t === 'eof') return;
      if (t.t === 'op' && t.v === ';') {
        this.p += 1;
        continue;
      }
      if (t.nl) continue;
      this.failAt(t);
    }
  }

  statement() {
    const t = this.peek();
    if (t.t === 'op' && t.v === '{') fail('block');
    if (t.t === 'name' && this.isOp(':', 1)) fail('label');
    this.expr(true);
    while (this.isOp(',')) {
      this.p += 1;
      this.expr(false);
    }
  }

  // An assignment-level expression (no comma). Superset of the grammar for the allowed atoms:
  // operators between values are safe, and an input JavaScript rejects never runs.
  expr(allowStream) {
    this.enter();
    let kind = this.operand();
    let single = true;
    while (true) {
      const t = this.peek();
      if (t.t === 'op' && BINARY_OPS.has(t.v)) {
        this.p += 1;
      } else if (t.t === 'op' && t.v === '?') {
        this.p += 1;
        this.expr(false);
        this.expectOp(':');
      } else if (t.t === 'name' && !t.esc && (t.v === 'in' || t.v === 'instanceof')) {
        fail('operator');
      } else {
        break;
      }
      if (kind !== 'value') fail('stdin');
      single = false;
      kind = this.operand();
    }
    if (kind !== 'value' && !(allowStream && single && kind === 'stdin')) fail('stdin');
    this.leave();
    return kind;
  }

  operand() {
    let unary = false;
    while (true) {
      const t = this.peek();
      if (t.t === 'op' && UNARY_OPS.has(t.v)) {
        this.p += 1;
        unary = true;
      } else if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
        fail('assignment');
      } else {
        break;
      }
    }
    const kind = this.primary();
    if (unary && kind !== 'value') fail('stdin');
    return kind;
  }

  primary() {
    let kind = this.atom();
    while (true) {
      const t = this.peek();
      if (kind !== 'value') {
        if (!(t.t === 'op' && t.v === '.')) {
          if (kind === 'stdin0') fail('stdin');
          return kind;
        }
        this.p += 1;
        kind = this.stdinMethod(this.next());
        continue;
      }
      if (t.t === 'tmpl' || t.t === 'tmplHead') fail('tagged');
      if (t.t !== 'op') return kind;
      if (t.v === '.') {
        this.p += 1;
        const a = this.next();
        if (a.t !== 'name') fail('syntax');
        if (VALUE_PROPERTIES.has(a.v)) continue;
        if (!VALUE_METHODS.has(a.v)) fail('attribute');
        this.methodCall();
      } else if (t.v === '[') {
        this.p += 1;
        const idx = this.next();
        if (idx.t !== 'num' || !idx.int || !this.isOp(']')) fail('computed');
        this.p += 1;
      } else if (t.v === '?.') {
        fail('optional');
      } else if (t.v === '(') {
        fail('call');
      } else if (t.v === '++' || t.v === '--') {
        fail('assignment');
      } else {
        return kind;
      }
    }
  }

  // After a method name: it must be called right here.
  methodCall() {
    const t = this.peek();
    if (t.t === 'op' && t.v === '(') {
      this.p += 1;
      this.callArgs();
      return;
    }
    if (t.t === 'tmpl' || t.t === 'tmplHead') fail('tagged');
    if (t.t === 'op' && t.v === '?.') fail('optional');
    fail('reference');
  }

  atom() {
    const t = this.next();
    if (t.t === 'num' || t.t === 'str' || t.t === 'regex' || t.t === 'tmpl') return 'value';
    if (t.t === 'tmplHead') {
      this.templateRest();
      return 'value';
    }
    if (t.t === 'op') {
      if (t.v === '(') {
        if (this.isArrowAt(this.p - 1)) fail('function');
        this.enter();
        if (this.isOp(')')) fail('syntax');
        this.expr(false);
        while (this.isOp(',')) {
          this.p += 1;
          this.expr(false);
        }
        this.expectOp(')');
        this.leave();
        return 'value';
      }
      if (t.v === '[') {
        this.arrayLiteral();
        return 'value';
      }
      if (t.v === '{') {
        this.objectLiteral();
        return 'value';
      }
      this.failAt(t);
    }
    if (t.t !== 'name') fail('syntax');
    const name = t.v;
    if (this.isOp('=>')) fail('function');
    if (this.inScope(name)) return 'value';
    if (name === 'true' || name === 'false' || name === 'null' || VALUE_NAMES.has(name)) return 'value';
    if (Object.hasOwn(KEYWORD_REASONS, name)) fail(KEYWORD_REASONS[name]);
    if (FORBIDDEN_NAMES.has(name)) fail('forbidden');
    if (Object.hasOwn(GLOBAL_MEMBERS, name)) return this.globalMember(GLOBAL_MEMBERS[name]);
    if (name === 'process') return this.processMember();
    fail('name');
  }

  globalMember(g) {
    const t = this.peek();
    if (t.t === 'op' && t.v === '?.') fail('optional');
    if (t.t === 'op' && t.v === '[') fail('computed');
    if (!(t.t === 'op' && t.v === '.')) fail('global');
    this.p += 1;
    const a = this.next();
    if (a.t !== 'name') fail('syntax');
    if (g.properties.has(a.v)) return 'value';
    if (!g.methods.has(a.v)) fail('attribute');
    this.methodCall();
    return 'value';
  }

  processMember() {
    const t = this.peek();
    if (t.t === 'op' && t.v === '?.') fail('optional');
    if (!(t.t === 'op' && t.v === '.')) fail('process');
    this.p += 1;
    const a = this.next();
    if (a.t === 'name' && a.v === 'argv') return 'value';
    if (a.t === 'name' && a.v === 'stdin') return 'stdin0';
    fail('process');
  }

  // The token after `process.stdin.` (or after a stdin method's result and '.').
  stdinMethod(m) {
    if (m.t !== 'name' || !STDIN_METHODS.has(m.v) || !this.isOp('(')) fail('stdin');
    this.p += 1;
    if (m.v === 'read') {
      if (!this.isOp(')')) fail('stdin');
      this.p += 1;
      return 'value';
    }
    const lit = this.next();
    if (lit.t !== 'str' || lit.v === null) fail('stdin');
    if (m.v === 'setEncoding') {
      if (!STDIN_ENCODINGS.has(lit.v)) fail('stdin');
    } else {
      if (!STDIN_EVENTS.has(lit.v) || !this.isOp(',')) fail('stdin');
      this.p += 1;
      if (!this.isArrowAt(this.p)) fail('stdin');
      this.enter();
      this.arrow();
      this.leave();
    }
    if (this.isOp(',')) this.p += 1;
    if (!this.isOp(')')) fail('stdin');
    this.p += 1;
    return 'stdin';
  }

  templateRest() {
    this.enter();
    while (true) {
      this.expr(false);
      const t = this.next();
      if (t.t === 'tmplTail') break;
      if (t.t !== 'tmplMid') this.failAt(t);
    }
    this.leave();
  }

  arrayLiteral() {
    this.enter();
    while (!this.isOp(']')) {
      if (this.isOp(',')) {
        this.p += 1;
        continue;
      }
      if (this.isOp('...')) fail('spread');
      this.expr(false);
      if (!this.isOp(',')) break;
      this.p += 1;
    }
    this.expectOp(']');
    this.leave();
  }

  objectLiteral() {
    this.enter();
    while (!this.isOp('}')) {
      const t = this.peek();
      if (t.t === 'op') {
        if (t.v === '...') fail('spread');
        if (t.v === '[') fail('computed');
        if (t.v === '*') fail('function');
        this.failAt(t);
      }
      let key;
      if (t.t === 'name') {
        const after = this.peek(1);
        const keyLike = after.t === 'name' || after.t === 'str' || after.t === 'num' || (after.t === 'op' && after.v === '[');
        if (!t.esc && (t.v === 'get' || t.v === 'set') && keyLike) fail('accessor');
        if (!t.esc && t.v === 'async' && (keyLike || (after.t === 'op' && after.v === '*'))) fail('function');
        key = t.v;
        this.p += 1;
        if (this.isOp(',') || this.isOp('}')) {
          // Shorthand {a}: a reference to the name a.
          if (key === '__proto__') fail('object');
          if (!this.inScope(key)) fail(FORBIDDEN_NAMES.has(key) ? 'forbidden' : 'name');
          if (this.isOp(',')) this.p += 1;
          continue;
        }
      } else if (t.t === 'str') {
        key = t.v;
        if (key === null) fail('object');
        this.p += 1;
      } else if (t.t === 'num') {
        this.p += 1;
      } else {
        this.failAt(t);
      }
      if (key === '__proto__') fail('object');
      if (this.isOp('(')) fail('function');
      this.expectOp(':');
      this.expr(false);
      if (!this.isOp(',')) break;
      this.p += 1;
    }
    this.expectOp('}');
    this.leave();
  }

  // After '(' of a call; consumes ')'.
  callArgs() {
    this.enter();
    while (!this.isOp(')')) {
      if (this.isOp('...')) fail('spread');
      if (this.isArrowAt(this.p)) this.arrow();
      else this.expr(false);
      if (!this.isOp(',')) break;
      this.p += 1;
    }
    this.expectOp(')');
    this.leave();
  }

  inScope(name) {
    for (const s of this.scopes) if (s.has(name)) return true;
    return false;
  }

  // An arrow function starts at token k: `name =>` or `( ... ) =>`.
  isArrowAt(k) {
    const t = this.toks[k];
    if (t.t === 'name') return this.toks[k + 1].t === 'op' && this.toks[k + 1].v === '=>';
    if (t.t === 'op' && t.v === '(') {
      const after = this.toks[this.match[k] + 1];
      return after !== undefined && after.t === 'op' && after.v === '=>';
    }
    return false;
  }

  // An arrow with plain parameters and an expression body, checked with the parameters as values.
  arrow() {
    const params = [];
    if (this.peek().t === 'name') {
      params.push(this.next());
    } else {
      this.p += 1;
      while (!this.isOp(')')) {
        const t = this.next();
        if (t.t !== 'name') fail('param');
        params.push(t);
        if (this.isOp(',')) {
          this.p += 1;
          continue;
        }
        if (!this.isOp(')')) fail('param');
      }
      this.p += 1;
    }
    this.expectOp('=>');
    const names = new Set();
    for (const t of params) {
      const v = t.v;
      if (names.has(v) || RESERVED.has(v) || FORBIDDEN_NAMES.has(v) || Object.hasOwn(GLOBAL_MEMBERS, v) || v === 'process' || VALUE_NAMES.has(v) || v === 'eval' || v === 'arguments')
        fail('param');
      names.add(v);
    }
    if (this.isOp('{')) fail('function');
    this.scopes.push(names);
    this.enter();
    this.expr(false);
    this.leave();
    this.scopes.pop();
  }
}

export function checkNode(code, opts) {
  try {
    if (typeof code !== 'string') return { opaque: true, reason: 'input' };
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) return { opaque: true, reason: 'input' };
    if (code.length > MAX_BYTES || Buffer.byteLength(code, 'utf8') > MAX_BYTES) return { opaque: true, reason: 'size' };
    if (BAD_CHARS.test(code)) return { opaque: true, reason: 'char' };
    new Checker(tokenize(code)).program();
    return { safe: true, reads: [] };
  } catch (err) {
    return { opaque: true, reason: err instanceof Opaque ? err.reason : 'internal' };
  }
}
