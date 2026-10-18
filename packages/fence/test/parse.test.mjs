import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStrictJson } from '../src/policy/parse.mjs';
import { PolicyError } from '../src/policy/errors.mjs';

// Asserts that parsing `text` throws a PolicyError with `code` (and `pointer`, when given).
function rejects(text, code, pointer) {
  assert.throws(
    () => parseStrictJson(text),
    (err) => {
      assert.ok(err instanceof PolicyError, `expected PolicyError, got ${err && err.name}: ${err && err.message}`);
      assert.ok(err instanceof Error);
      assert.equal(err.code, code, `code for ${String(JSON.stringify(text)).slice(0, 80)}: ${err.message}`);
      if (pointer !== undefined) assert.equal(err.pointer, pointer);
      return true;
    },
  );
}

// Every object in the parsed tree has a null prototype; arrays are plain arrays.
function assertNullProtoTree(value) {
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    for (const v of value) assertNullProtoTree(v);
  } else if (value !== null && typeof value === 'object') {
    assert.equal(Object.getPrototypeOf(value), null);
    for (const k of Object.keys(value)) assertNullProtoTree(value[k]);
  }
}

// Compares structure and values without comparing prototypes (JSON.parse objects inherit Object.prototype).
function sameAsJsonParse(text) {
  const ours = parseStrictJson(text);
  const theirs = JSON.parse(text);
  assert.equal(JSON.stringify(ours), JSON.stringify(theirs), `mismatch for ${text.slice(0, 80)}`);
  assert.equal(typeof ours, typeof theirs);
  assertNullProtoTree(ours);
  return ours;
}

const nest = (n) => '['.repeat(n) + ']'.repeat(n);
const nestObj = (n) => '{"a":'.repeat(n - 1) + '{}' + '}'.repeat(n - 1);

test('rejects duplicate keys at depth', () => {
  rejects('{"a":{"b":1,"b":2}}', 'duplicate-key', '/a/b');
  rejects('{"a":1,"a":1}', 'duplicate-key', '/a');
  rejects('[{"x":[{"k":1,"j":2,"k":3}]}]', 'duplicate-key', '/0/x/0/k');
  // Compared after unescaping.
  rejects('{"a":1,"\\u0061":2}', 'duplicate-key', '/a');
  rejects('{"ab":1,"a\\u0062":2}', 'duplicate-key', '/ab');
  rejects('{"/":1,"\\/":2}', 'duplicate-key', '/~1');
  rejects('{"~":1,"\\u007e":2}', 'duplicate-key', '/~0');
  rejects('{"":1,"":2}', 'duplicate-key', '/');
  // Keys that differ are fine, including near-duplicates.
  sameAsJsonParse('{"a":1,"A":2,"a ":3," a":4}');
});

test('rejects __proto__, constructor and prototype keys at any depth', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    rejects(`[{"ok":{"${key}":{}}}]`, 'forbidden-key', `/0/ok/${key}`);
    rejects(`{"${key}":1}`, 'forbidden-key', `/${key}`);
    rejects(`[1,[2,{"${key}":null}]]`, 'forbidden-key', `/1/1/${key}`);
  }
  // Caught after unescaping.
  rejects('{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true}}', 'forbidden-key', '/__proto__');
  rejects('{"x":[{"construct\\u006fr":1}]}', 'forbidden-key', '/x/0/constructor');
  rejects('{"\\u0070rototype":1}', 'forbidden-key', '/prototype');
  // Forbidden wins over duplicate when both apply.
  rejects('{"__proto__":1,"__proto__":2}', 'forbidden-key', '/__proto__');
  // Only exact matches are forbidden; the values themselves are free text.
  const ok = sameAsJsonParse('{"__proto":1,"constructors":2,"Prototype":3,"k":"__proto__"}');
  assert.equal(ok.k, '__proto__');
});

test('rejects a BOM', () => {
  rejects('\uFEFF{}', 'bom', '');
  rejects('\uFEFF', 'bom', '');
  // A BOM later on is not whitespace.
  rejects('{}\uFEFF', 'syntax');
  rejects('{\uFEFF"a":1}', 'syntax');
  // Inside a string it is just a character.
  assert.equal(parseStrictJson('"\uFEFF"'), '\uFEFF');
});

test('rejects trailing commas, comments and single quotes', () => {
  const bad = [
    '[1,]',
    '{"a":1,}',
    '[,1]',
    '{,}',
    '[1,,2]',
    '{"a":1 // c\n}',
    '{"a":1 /* c */}',
    '// c\n{}',
    '# c\n{}',
    "{'a':1}",
    "['a']",
    '{a:1}',
    '{"a" 1}',
    '{"a":}',
    '{"a"}',
    '[1 2]',
    '{"a":1 "b":2}',
    '{1:2}',
    '',
    '   ',
    '\r\n',
    '{}{}',
    '{} x',
    '[] ]',
    '1 2',
    '{',
    '[',
    '"abc',
    '{"a":1',
    'nul',
    'nulll',
    'True',
    'undefined',
    'NaN',
    '-NaN',
    'Infinity',
    '-Infinity',
    '[NaN]',
    '01',
    '-01',
    '00',
    '1.',
    '.5',
    '-',
    '+1',
    '1e',
    '1e+',
    '1.e5',
    '0x10',
    '1_000',
    '1e400',
    '-1e400',
    '"\\x41"',
    '"\\u12"',
    '"\\u12G4"',
    '"\\U0041"',
    '"\\a"',
    '"\\\'"',
    '"a\nb"',
    '"a\tb"',
    '"\u0000"',
    '"\u001f"',
    '"\\ud800"',
    '"\\udc00"',
    '"\\ud800\\u0041"',
    '"\\udc00\\ud800"',
    '"\ud800"',
    '"\udfff"',
    '{"\\ud800":1}',
    '\u00a0{}',
    '\u000b{}',
    '\u000c{}',
    '\u2028{}',
  ];
  for (const text of bad) rejects(text, 'syntax');
});

test('rejects nesting deeper than 64', () => {
  assert.equal(JSON.stringify(parseStrictJson(nest(64))), nest(64));
  rejects(nest(65), 'depth');
  sameAsJsonParse(nestObj(64));
  rejects(nestObj(65), 'depth');
  // Mixed containers count together.
  const mixed64 = '[{"a":'.repeat(32) + 'null' + '}]'.repeat(32);
  sameAsJsonParse(mixed64);
  rejects('[' + mixed64 + ']', 'depth');
  // A pathologically deep input fails with depth, not a stack overflow.
  rejects('['.repeat(1_000_000), 'depth');
  rejects('{"a":'.repeat(200_000), 'depth');
});

test('parses a valid document identically to JSON.parse', () => {
  const docs = [
    '{}',
    '[]',
    'null',
    'true',
    'false',
    '0',
    '-0',
    '1',
    '-1',
    '1.5',
    '-0.0',
    '1e5',
    '1E+5',
    '1e-5',
    '123456789012345678901234567890',
    '0.1e-400',
    '"x"',
    '""',
    '"\\"\\\\\\/\\b\\f\\n\\r\\t"',
    '"\\u0041\\u00e9\\u4e2d\\uD83D\\uDE00"',
    '"\ud83d\ude00 caf\u00e9 \u007f"',
    ' \t\r\n{ "a" :\r\n [ 1 , 2 ] }\r\n ',
    '{"version":1,"rules":[{"id":"r1","why":"because","match":{"tool":"Bash","cmd":["git","push"]},"enabled":true,"weight":-2.5e3,"note":null}],"nested":{"a":{"b":{"c":[[],{}]}}}}',
    '[{"a":1},{"a":1},{"a":1}]',
  ];
  for (const d of docs) sameAsJsonParse(d);
  assert.ok(Object.is(parseStrictJson('-0'), -0));
  // Key order is preserved.
  assert.deepEqual(Object.keys(parseStrictJson('{"z":1,"a":2,"m":3}')), ['z', 'a', 'm']);
  // A large document parses correctly and in linear time.
  const big = JSON.stringify({
    items: Array.from({ length: 50_000 }, (_, i) => ({ id: `r${i}`, n: i, s: 'x'.repeat(i % 50) + '\\"\n' })),
    blob: 'y'.repeat(2_000_000),
  });
  const t0 = Date.now();
  sameAsJsonParse(big);
  assert.ok(Date.now() - t0 < 100_000, 'large input took too long');
});

test('a key __proto__ never reaches Object.prototype', () => {
  const texts = [
    '{"__proto__":{"polluted":true}}',
    '{"a":{"__proto__":{"polluted":true}}}',
    '[{"__proto__":{"polluted":true}}]',
    '{"\\u005f_proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
  ];
  for (const t of texts) {
    assert.throws(() => parseStrictJson(t), PolicyError);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  }
  // Returned objects are null-prototype, so inherited names are absent.
  const obj = parseStrictJson('{"a":{"b":[{"c":1}]}}');
  assertNullProtoTree(obj);
  assert.equal('toString' in obj, false);
  assert.equal('hasOwnProperty' in obj.a, false);
});

test('PolicyError carries code, pointer and a message', () => {
  const err = new PolicyError('syntax', 'bad thing', { pointer: '/a' });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'PolicyError');
  assert.equal(err.code, 'syntax');
  assert.equal(err.pointer, '/a');
  assert.equal(err.message, 'bad thing');
  assert.equal(new PolicyError('bom', 'x').pointer, '');
  // Non-string input is a syntax error, never a crash or a pass.
  for (const v of [undefined, null, 1, {}, Buffer.from('{}')]) rejects(v, 'syntax');
});
