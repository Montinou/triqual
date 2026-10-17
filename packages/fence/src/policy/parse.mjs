// Strict, dependency-free JSON parser for policy files (trusted path).
//
// A single hand-written pass over the text; no JSON.parse result is trusted.
// It throws a PolicyError at the first violation:
//   bom            the text starts with U+FEFF
//   syntax         anything outside RFC 8259 JSON, plus: lone surrogates in
//                  strings, numbers that overflow to +/-Infinity, non-string input
//   duplicate-key  an object repeats a key (compared after unescaping)
//   forbidden-key  a key is __proto__, constructor or prototype (after unescaping)
//   depth          more than MAX_DEPTH nested arrays/objects
// Objects are created with Object.create(null); arrays are plain arrays.

import { PolicyError } from './errors.mjs';

export const MAX_DEPTH = 64;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const PLAIN_CHARS_RE = /[^"\\\u0000-\u001f]*/y;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function escapePointerToken(token) {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parseStrictJson(text) {
  if (typeof text !== 'string') {
    throw new PolicyError('syntax', `policy text must be a string, got ${text === null ? 'null' : typeof text}`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new PolicyError('bom', 'policy file starts with a byte order mark');
  }

  const len = text.length;
  const path = [];
  let pos = 0;

  const pointer = () => path.map((t) => '/' + escapePointerToken(String(t))).join('');
  const fail = (code, message) => {
    throw new PolicyError(code, `${message} at offset ${pos}`, { pointer: pointer() });
  };
  const describe = () => (pos >= len ? 'end of input' : JSON.stringify(text[pos]));

  // JSON whitespace only: space, tab, LF, CR.
  const skipWs = () => {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const expect = (ch) => {
    if (text[pos] !== ch) fail('syntax', `expected ${JSON.stringify(ch)}, found ${describe()}`);
    pos++;
  };

  const parseString = () => {
    expect('"');
    let out = '';
    for (;;) {
      PLAIN_CHARS_RE.lastIndex = pos;
      PLAIN_CHARS_RE.test(text);
      const end = PLAIN_CHARS_RE.lastIndex;
      if (end > pos) {
        out += text.slice(pos, end);
        pos = end;
      }
      if (pos >= len) fail('syntax', 'unterminated string');
      const ch = text[pos];
      if (ch === '"') {
        pos++;
        break;
      }
      if (ch === '\\') {
        const esc = text[pos + 1];
        if (esc === 'u') {
          const hex = text.slice(pos + 2, pos + 6);
          if (!HEX4_RE.test(hex)) fail('syntax', 'invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 6;
        } else if (esc !== undefined && Object.hasOwn(SIMPLE_ESCAPES, esc)) {
          out += SIMPLE_ESCAPES[esc];
          pos += 2;
        } else {
          fail('syntax', `invalid escape ${esc === undefined ? 'at end of input' : JSON.stringify('\\' + esc)}`);
        }
        continue;
      }
      // Only a raw control character (U+0000..U+001F) is left.
      fail('syntax', 'unescaped control character in string');
    }
    if (!out.isWellFormed()) fail('syntax', 'string contains a lone surrogate');
    return out;
  };

  const parseNumber = () => {
    NUMBER_RE.lastIndex = pos;
    if (!NUMBER_RE.test(text)) fail('syntax', `unexpected ${describe()}`);
    const end = NUMBER_RE.lastIndex;
    const n = Number(text.slice(pos, end));
    if (!Number.isFinite(n)) fail('syntax', 'number out of range');
    pos = end;
    return n;
  };

  const parseLiteral = (word, value) => {
    if (!text.startsWith(word, pos)) fail('syntax', `unexpected ${describe()}`);
    pos += word.length;
    return value;
  };

  const parseValue = (depth) => {
    skipWs();
    const ch = text[pos];
    if (ch === '{' || ch === '[') {
      if (depth >= MAX_DEPTH) fail('depth', `nesting deeper than ${MAX_DEPTH}`);
      return ch === '{' ? parseObject(depth + 1) : parseArray(depth + 1);
    }
    if (ch === '"') return parseString();
    if (ch === 't') return parseLiteral('true', true);
    if (ch === 'f') return parseLiteral('false', false);
    if (ch === 'n') return parseLiteral('null', null);
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    return fail('syntax', `unexpected ${describe()}`);
  };

  const parseObject = (depth) => {
    expect('{');
    const obj = Object.create(null);
    skipWs();
    if (text[pos] === '}') {
      pos++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[pos] !== '"') fail('syntax', `expected a string key, found ${describe()}`);
      const key = parseString();
      path.push(key);
      if (FORBIDDEN_KEYS.has(key)) fail('forbidden-key', `forbidden key ${JSON.stringify(key)}`);
      if (Object.hasOwn(obj, key)) fail('duplicate-key', `duplicate key ${JSON.stringify(key)}`);
      skipWs();
      expect(':');
      const value = parseValue(depth);
      Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
      path.pop();
      skipWs();
      if (text[pos] === ',') {
        pos++;
        continue;
      }
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      fail('syntax', `expected "," or "}", found ${describe()}`);
    }
  };

  const parseArray = (depth) => {
    expect('[');
    const arr = [];
    skipWs();
    if (text[pos] === ']') {
      pos++;
      return arr;
    }
    for (;;) {
      path.push(arr.length);
      arr.push(parseValue(depth));
      path.pop();
      skipWs();
      if (text[pos] === ',') {
        pos++;
        continue;
      }
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      fail('syntax', `expected "," or "]", found ${describe()}`);
    }
  };

  const result = parseValue(0);
  skipWs();
  if (pos < len) fail('syntax', `unexpected ${describe()} after the document`);
  return result;
}
