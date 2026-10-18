import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkNode,
  GLOBAL_MEMBERS,
  VALUE_METHODS,
  VALUE_PROPERTIES,
  STDIN_METHODS,
  STDIN_EVENTS,
  FORBIDDEN_NAMES,
  FORBIDDEN_PROPERTIES,
  MAX_NESTING,
} from '../src/tables/interp-node.mjs';

// Every JavaScript source text below is an inert string: checkNode only tokenizes and judges it.
// Nothing here runs node -e, eval, vm, new Function or any other interpreter on these inputs.

const safe = (code, opts) => {
  const r = checkNode(code, opts);
  assert.equal(r.safe, true, `expected safe: ${code} -> ${JSON.stringify(r)}`);
  assert.deepEqual(r.reads, []);
  return r;
};
const opaque = (code, opts) => {
  const r = checkNode(code, opts);
  assert.equal(r.opaque, true, `expected opaque: ${code} -> ${JSON.stringify(r)}`);
  assert.equal(typeof r.reason, 'string');
  assert.equal(r.safe, undefined);
  assert.notEqual(r.reason, 'internal', `internal error, not a judgment: ${code}`);
  return r;
};

test('console.log(JSON.stringify(process.argv.slice(2))) is safe', () => {
  safe('console.log(JSON.stringify(process.argv.slice(2)))');
  safe('console.log(process.argv[2], process.argv.length, process.argv.slice(2).join(" "))');
  safe('console.error(JSON.parse(process.argv[1]), Math.max(1, 2), Math.PI)');
  // -p prints the final expression: the program is expression statements only.
  safe('[1, 2, 3].map(x => x * 2).filter((x, i) => i > 0)');
  safe('({a: 1, "b": [2, , 3], 4: null, c: undefined, d: -Infinity})');
  safe('console.log(1); console.info(2)\nconsole.warn(3);;');
});

test('the bypass corpus, each opaque', async (t) => {
  // [code, the reason the checker gives]
  const corpus = [
    ["globalThis['req'+'uire']", 'forbidden'],
    ['process.mainModule.require', 'process'],
    ["require('child_process')", 'forbidden'],
    ["import('fs')", 'import'],
    ["Function('return process')()", 'forbidden'],
    ["eval('1')", 'forbidden'],
    ['this.constructor.constructor', 'this'],
    ["`${require('fs')}`", 'forbidden'],
    ['(0,eval)(x)', 'forbidden'],
    // inert variants of the same shapes
    ["\\u0065val('1')", 'forbidden'],
    ["\\u{72}equire('fs')", 'forbidden'],
    ["re\\u0071uire('fs')", 'forbidden'],
    ["\\u0069mport('fs')", 'escape'],
    ['\\u0074his.x', 'escape'],
    ["\uff45\uff56\uff41\uff4c('1')", 'name'],
    ['(0, console.log)(1)', 'reference'],
    ["(0, JSON.parse)('1')", 'reference'],
    ['globalThis?.process', 'forbidden'],
    ['process?.mainModule', 'optional'],
    ['console?.log(1)', 'optional'],
    ["[]?.['constructor']", 'optional'],
    ["[]['constructor']", 'computed'],
    ["''['constructor']['constructor']('return 1')()", 'computed'],
    ['process.argv[process.argv.length - 1]', 'computed'],
    ["JSON['parse']('1')", 'computed'],
    ['[].constructor', 'attribute'],
    ["''.__proto__", 'attribute'],
    ['process.argv.toString()', 'attribute'],
    ['[].map.call', 'reference'],
    ['Math.max.apply', 'reference'],
    ['console.log`x`', 'tagged'],
    ["[].join`x`", 'tagged'],
    ['String.raw`x`', 'forbidden'],
    ['new.target', 'new'],
    ["new Function('x')", 'new'],
    ['({get x() { return 1 }})', 'accessor'],
    ['({set x(v) {}})', 'accessor'],
    ['({__proto__: null})', 'object'],
    ['({"__proto__": []})', 'object'],
    ['({"\\u005f_proto__": []})', 'object'],
    ["({['a']: 1})", 'computed'],
    ['({a() {}})', 'function'],
    ['({...process.argv})', 'spread'],
    ['delete process.argv', 'unary'],
    ['typeof require', 'unary'],
    ['void 0', 'unary'],
    ['console.log(...process.argv)', 'spread'],
    ['[...process.argv]', 'spread'],
    ["process.binding('fs')", 'process'],
    ["process.env.X = '1'", 'process'],
    ['process.env', 'process'],
    ["process.stdout.write('x')", 'process'],
    ['process', 'process'],
    ['Symbol.iterator', 'forbidden'],
    ['Reflect.get', 'forbidden'],
    ["arguments[1]('fs')", 'forbidden'],
    ["module.require('fs')", 'forbidden'],
    ['global.process', 'forbidden'],
    ["JSON.parse('1', eval)", 'forbidden'],
    ['x => x', 'function'],
    ['function f() {}', 'function'],
    ['[1].map(function (x) { return x })', 'function'],
    ['[1].map(x => { return x })', 'function'],
    ['async () => 1', 'function'],
    ['class A {}', 'function'],
    ['with (Math) max(1)', 'with'],
    ['a: console.log(1)', 'label'],
    ['const a = 1', 'declaration'],
    ['let a = 1', 'declaration'],
    ['var x', 'declaration'],
    ['x = 1', 'name'],
    ["process.argv[0] = 'x'", 'assignment'],
    ['import.meta.url', 'import'],
    ["import fs from 'fs'", 'import'],
    ['export {}', 'import'],
    ['[1].map(x => x.constructor)', 'attribute'],
    ['[1].map(process => process)', 'param'],
    ['[1].map((a, a) => a)', 'param'],
    ['[1].map(({a}) => a)', 'param'],
    ['[1].map((a = eval) => a)', 'param'],
    ['[1].map((...a) => a)', 'param'],
    ['{ console.log(1) }', 'block'],
    ["'x' in process.argv", 'operator'],
    ['[] instanceof Math.max', 'operator'],
    ['process.argv[0]++', 'assignment'],
    ['(1, 2)(3)', 'call'],
    ['process.argv.slice(2)[0](1)', 'call'],
    ['JSON', 'global'],
    ['(console).log(1)', 'global'],
    ['console.log', 'reference'],
    ['console.dir(1)', 'attribute'],
    ['Math.constructor', 'attribute'],
    ['debugger', 'statement'],
    ['if (1) console.log(1)', 'statement'],
  ];
  for (const [code, reason] of corpus) await t.test(code, () => assert.equal(opaque(code).reason, reason));
});

test('a regex literal containing quotes does not confuse the tokenizer', () => {
  safe(`console.log('a"b'.replace(/["']/g, ''))`);
  safe(`console.log(/'/.test("it's"), /"[^"]*"/g.exec('x "y"'))`);
  safe("console.log('a/b'.split(/[/]/), /\\/'/.test('/'), /`/.test('`'))");
  safe("console.log(/eval\\('x'\\)/.test('x'), /[*/]/.test('*'))");
  // After a value, `/` divides: a tokenizer that read a regex here would hide the call.
  safe('console.log(4 / 2 / 1, process.argv.length / 2)');
  assert.equal(opaque("[1][0] /eval('x')/ 1").reason, 'forbidden');
  assert.equal(opaque("(1) /eval('x')/ 1").reason, 'forbidden');
  assert.equal(opaque("Math.PI /require('fs')/ 1").reason, 'forbidden');
  for (const code of ["console.log(/'unterminated)", "console.log(/a\n/)", 'console.log(/a/gg)', 'console.log(/a/x)', 'console.log(/a/uv)'])
    assert.equal(opaque(code).reason, 'regex', code);
});

test('a template literal with a safe expression is safe', () => {
  safe('console.log(`argv: ${process.argv.slice(2).join(", ")} pi=${Math.PI.toFixed(2)}`)');
  safe('console.log(`a${`b${1 + 2}c`}d`, `{}\'"`, `${"}"}`, `${({a: 1}) !== null}`, `line1\nline2`)');
  safe('console.log(`\\${require("fs")}`)');
  safe('console.log(`$ {x} $`)');
  assert.equal(opaque('console.log(`${eval("1")}`)').reason, 'forbidden');
  assert.equal(opaque('console.log(`${`${require("fs")}`}`)').reason, 'forbidden');
  assert.equal(opaque('console.log(`${process.mainModule}`)').reason, 'process');
  assert.equal(opaque('console.log(`never closed)').reason, 'template');
  assert.equal(opaque('console.log(`${1`)').reason, 'template');
});

test('process.stdin is read only through the listed forms', () => {
  safe("process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d), null, 2)))");
  safe("process.stdin.setEncoding('utf8').on('data', (c) => console.log(c.toUpperCase())).on('end', () => console.log('done'))");
  safe("process.stdin.once('readable', () => console.log(process.stdin.read()))");
  for (const code of [
    'process.stdin.pipe(process.stdout)',
    "process.stdin.on('data', console.log)",
    'process.stdin.on(eval, x => x)',
    "process.stdin.on('error', e => e)",
    "process.stdin.setEncoding('base64')",
    'process.stdin.fd',
    'process.stdin',
    'console.log(process.stdin)',
    "process.stdin.on('data', d => d) + 1",
    'process.stdin.read(1)',
  ]) assert.equal(opaque(code).reason, 'stdin', code);
});

test('automatic semicolon insertion hazards are opaque', () => {
  for (const code of ['console.log(1)\n(2)', 'console.log(1)\n[0]', 'console.log(1)\n`x`', 'console.log(1)\n/x/g', 'console.log(1)\n+1', 'console.log(1)\n.length', "Math.PI\n/* c */ (console.log(1))", 'x\n=> 1'])
    assert.equal(opaque(code).reason, 'asi', JSON.stringify(code));
  safe('console.log(1)\nconsole.log(2)');
  safe('console.log(\n  1,\n  2\n)');
  safe('console.log(1 +\n 2)');
});

test('HTML-like comments are opaque', () => {
  for (const code of ['<!-- x\nconsole.log(1)', "console.log(1)\n--> require('fs')", 'console.log(1) <!-- 2'])
    assert.equal(opaque(code).reason, 'comment', JSON.stringify(code));
  safe("console.log('<!--', `-->`, /<!--/.test('x')) // <!-- -->");
});

test('the tokenizer reads strings, comments, numbers and identifiers like JavaScript', () => {
  safe("console.log(1) // eval('x')");
  safe("/* require('fs') \n */ console.log(1)");
  safe("console.log('a\\\nb', \"it's\", '\\u{1F600}', '\\x41\\u0041\\n\\'')");
  safe('console.log(1_000, 0xff, 0o17, 0b1, 10n, .5, 1e-3, 1., 0.5e+2, 0XAB_CDn)');
  safe('\\u0063onsole.log(1); console.\\u{6c}og(2)');
  safe('console.log([1, 2].at(-1), "abc".padStart(5).trim().length)');
  for (const code of ['console.log(017)', 'console.log(08)', 'console.log(1_)', 'console.log(0x)', 'console.log(1a)', 'console.log(1__0)', 'console.log(.5n)', 'console.log(1.5n)'])
    assert.equal(opaque(code).reason, 'number', code);
  assert.equal(opaque("console.log('unterminated)").reason, 'string');
  assert.equal(opaque("console.log('a\nb')").reason, 'string');
  assert.equal(opaque('/* unterminated').reason, 'comment');
  for (const code of ['console.log(1)\r\nconsole.log(2)', 'console.log(1)\u2028', '\ufeffconsole.log(1)', 'console.log(1)\0', 'console.log(1)\u00a0', '#!/usr/bin/env node\nconsole.log(1)', 'console.log(1) @ 2'])
    assert.equal(opaque(code).reason, 'char', JSON.stringify(code));
  assert.equal(opaque('\\u006G').reason, 'escape');
  assert.equal(opaque('\\u{110000}x').reason, 'escape');
  assert.equal(opaque('con\u200dsole.log(1)').reason, 'name');
});

test('the allowlists are explicit data', () => {
  assert.deepEqual(Object.keys(GLOBAL_MEMBERS).sort(), ['JSON', 'Math', 'console']);
  assert.deepEqual([...GLOBAL_MEMBERS.console.methods].sort(), ['error', 'info', 'log', 'warn']);
  assert.deepEqual([...GLOBAL_MEMBERS.JSON.methods].sort(), ['parse', 'stringify']);
  assert.ok(GLOBAL_MEMBERS.Math.properties.has('PI') && GLOBAL_MEMBERS.Math.methods.has('max'));
  assert.ok(VALUE_METHODS.has('map') && VALUE_METHODS.has('slice') && VALUE_METHODS.has('toUpperCase'));
  assert.deepEqual([...VALUE_PROPERTIES], ['length']);
  assert.deepEqual([...STDIN_EVENTS].sort(), ['data', 'end', 'readable']);
  assert.ok(STDIN_METHODS.has('on') && STDIN_METHODS.has('read') && !STDIN_METHODS.has('pipe'));
  for (const name of ['require', 'eval', 'Function', 'globalThis', 'global', 'window', 'self', 'module', 'arguments'])
    assert.ok(FORBIDDEN_NAMES.has(name), name);
  for (const name of FORBIDDEN_PROPERTIES) {
    assert.ok(!VALUE_METHODS.has(name) && !VALUE_PROPERTIES.has(name), name);
    for (const g of Object.values(GLOBAL_MEMBERS)) assert.ok(!g.methods.has(name) && !g.properties.has(name), name);
  }
  for (const name of ['constructor', '__proto__', 'prototype', 'call', 'apply', 'bind', 'toString'])
    assert.ok(FORBIDDEN_PROPERTIES.has(name), name);
  assert.ok(Object.isFrozen(GLOBAL_MEMBERS) && Object.isFrozen(GLOBAL_MEMBERS.Math));
});

test('options are optional and the cwd and written index do not matter', () => {
  const code = 'console.log(JSON.stringify(process.argv.slice(2)))';
  safe(code);
  safe(code, {});
  safe(code, { isolated: false, cwdFiles: ['json.js', 'node_modules/', 'package.json'], writtenIndex: null });
  assert.equal(opaque(code, null).reason, 'input');
  assert.equal(opaque(code, 'x').reason, 'input');
});

test('it never throws, caps the size and nesting, and stays linear', () => {
  assert.equal(MAX_NESTING, 32);
  assert.equal(opaque('console.log(1)'.padEnd(40 * 1024, ' ')).reason, 'size');
  safe('console.log' + '('.repeat(MAX_NESTING) + '1' + ')'.repeat(MAX_NESTING));
  assert.equal(opaque('console.log(' + '('.repeat(MAX_NESTING) + '1' + ')'.repeat(MAX_NESTING) + ')').reason, 'nesting');
  for (const bad of [null, undefined, 42, {}, '('.repeat(5000), '['.repeat(100) + ']'.repeat(100), '`${'.repeat(300), '{'.repeat(300)]) {
    const r = checkNode(bad);
    assert.equal(r.opaque, true);
  }
  let seed = 11;
  const alphabet = "abcdefJSONMathconsolelogprocessargv_$ ()[]{}.,:;?'\"`\\/*+-=<>!#\n\t0123456789xn\u00e9\uff45";
  for (let n = 0; n < 3000; n += 1) {
    let s = '';
    for (let k = 0; k < 40; k += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      s += alphabet[seed % alphabet.length];
    }
    const r = checkNode(s);
    assert.ok(r.safe === true || r.opaque === true, s);
    if (r.opaque) assert.notEqual(r.reason, 'internal', s);
  }
  const big = 'console.log(' + "'x'.toUpperCase(), ".repeat(1500) + ')';
  const t0 = performance.now();
  safe(big);
  safe('console.log(`' + '${1}'.repeat(5000) + '`)');
  safe('console.log(' + '[1].map(x => x + 1), '.repeat(1200) + ')');
  assert.ok(performance.now() - t0 < 2000);
});
