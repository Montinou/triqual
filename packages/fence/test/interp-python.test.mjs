import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkPython, MODULE_ATTRS, VALUE_METHODS, SHADOW_NAMES, EXTRA_SHADOW_NAMES, MAX_NESTING } from '../src/tables/interp-python.mjs';

// Every Python source text below is an inert string: checkPython only tokenizes and judges it.
// Nothing here runs python or any other interpreter.

const CLEAN = { isolated: false, cwdFiles: ['README.md', 'src', 'data.json'], writtenIndex: new Set() };
const check = (code, ctx = {}) => checkPython(code, { ...CLEAN, ...ctx });
const safe = (code, ctx) => {
  const r = check(code, ctx);
  assert.equal(r.safe, true, `expected safe: ${code} -> ${JSON.stringify(r)}`);
  return r;
};
const opaque = (code, ctx) => {
  const r = check(code, ctx);
  assert.equal(r.opaque, true, `expected opaque: ${code} -> ${JSON.stringify(r)}`);
  assert.equal(typeof r.reason, 'string');
  assert.equal(r.safe, undefined);
  assert.notEqual(r.reason, 'internal', `internal error, not a judgment: ${code}`);
  return r;
};

test('print(json.dumps(...)) is safe', () => {
  const r = safe('import json; print(json.dumps({"a": [1, 2.5, None, True]}, indent=2, sort_keys=True))');
  assert.deepEqual(r.reads, []);
  safe('import json, sys\nprint(json.dumps(json.load(sys.stdin), indent=2))');
});

test('re.sub on sys.stdin is safe', () => {
  const r = safe("import re, sys; print(re.sub(r'\\s+', ' ', sys.stdin.read()).strip())");
  assert.deepEqual(r.reads, []);
  safe('import re\nimport sys\nprint(re.findall(r"[0-9]+", sys.stdin.readline()), sys.argv[1:])');
});

test("open('a.txt') yields a read, open('a.txt','w') is opaque", () => {
  assert.deepEqual(safe("print(open('a.txt').read())").reads, ['a.txt']);
  assert.deepEqual(safe("open('a.txt')").reads, ['a.txt']);
  assert.deepEqual(safe("print(open('a.txt', 'rb').read().decode())").reads, ['a.txt']);
  assert.deepEqual(safe("print(open('a' '.txt', mode='r', encoding='utf-8').readlines())").reads, ['a.txt']);
  assert.deepEqual(safe("print(open('a.txt').read(), open('b\\x2etxt').read(), open('a.txt').read())").reads, ['a.txt', 'b.txt']);
  assert.equal(opaque("open('a.txt','w')").reason, 'open');
  for (const mode of ['a', 'x', 'r+', 'w+', 'wb', 'rw', 'rr', '']) opaque(`open('a.txt', '${mode}')`);
  opaque('import sys; open(sys.argv[1])');
  opaque("open(f'a.txt')");
  opaque("open(b'a.txt')");
  opaque("open('a.txt', opener=print)");
  opaque('open(3)');
  opaque("open('\\N{DIGIT ONE}')");
  opaque('open');
});

test('the bypass corpus, each opaque', async (t) => {
  // [code, the reason the checker gives]
  const corpus = [
    ["import sys; print(sys.modules['o'+'s'])", 'attribute'],
    ['print(vars(__builtins__))', 'name'],
    ["getattr(__builtins__,'ev'+'al')", 'name'],
    ["__import__('os')", 'dunder'],
    ["exec('print(1)')", 'name'],
    ['().__class__.__bases__', 'dunder'],
    ['import os', 'import'],
    ['import subprocess', 'import'],
    ['from os import system', 'import'],
    ["globals()['x']", 'name'],
    ["print(f\"{eval('1')}\")", 'name'],
    // inert variants of the same shapes
    ["print(f'{json}')", 'name'],
    ["import json; print(f'{json.dumps(1):{eval(\"9\")}}')", 'name'],
    ["print(f'{f\"{eval(1)}\"}')", 'name'],
    ["print(\uff45\uff56\uff41\uff4c('1'))", 'name'],
    ["''.__class__", 'dunder'],
    ["''.format('{0.__class__}')", 'attribute'],
    ['import json; json.__dict__', 'dunder'],
    ["import json; json['loads']", 'module'],
    ['import json as j', 'import'],
    ['from json import dumps', 'import'],
    ['import json.decoder', 'import'],
    ['import sys; sys.stdin.buffer.read()', 'attribute'],
    ['import sys; sys.exit()', 'attribute'],
    ['print.__self__', 'builtin'],
    ['print[0]', 'builtin'],
    ['compile', 'name'],
    ["eval('1')", 'name'],
    ['x = 1', 'name'],
    ['print(lambda: 1)', 'lambda'],
    ['print([c for c in "ab"])', 'name'],
    ["t'{eval(1)}'", 'prefix'],
    ['breakpoint()', 'name'],
    ['import math; math.pi = 3', 'assignment'],
    ['import json; print(json.loads("1", object_hook=print))', 'builtin'],
  ];
  for (const [code, reason] of corpus) await t.test(code, () => assert.equal(opaque(code).reason, reason));
});

test('without -I and with a json.py in cwd is opaque', () => {
  const code = 'import json; print(json.dumps(1))';
  assert.equal(opaque(code, { cwdFiles: ['json.py'] }).reason, 'cwd-shadow');
  safe(code, { isolated: true, cwdFiles: ['json.py'] });
  for (const name of SHADOW_NAMES) opaque('print(1)', { cwdFiles: ['notes.txt', name] });
  opaque('print(1)', { cwdFiles: ['json'] });
  opaque('print(1)', { cwdFiles: ['JSON.PY'] });
  opaque('print(1)', { cwdFiles: ['re/'] });
  opaque('print(1)', { cwdFiles: null });
  safe('print(1)', { cwdFiles: ['jsonx.py', 'remath', 'readme.py'] });
});

test('without -I a cwd entry shadowing a transitive or codec-reached module is opaque', () => {
  assert.equal(opaque('import re', { cwdFiles: ['enum.py'] }).reason, 'cwd-shadow');
  for (const entry of ['_json.py', '_json.cpython-312-darwin.so'])
    assert.equal(opaque('import json; print(json.dumps(1))', { cwdFiles: [entry] }).reason, 'cwd-shadow', entry);
  for (const name of ['_json', '_collections_abc', '_sre', 'decoder', 'encoder', 'scanner']) assert.ok(EXTRA_SHADOW_NAMES.includes(name), name);
  safe('import re', { isolated: true, cwdFiles: ['enum.py'] });
  for (const name of EXTRA_SHADOW_NAMES) {
    assert.equal(opaque('print(1)', { cwdFiles: [`${name}.py`] }).reason, 'cwd-shadow', name);
    assert.equal(opaque('print(1)', { cwdFiles: [`${name}/`] }).reason, 'cwd-shadow', name);
  }
  for (const entry of ['unicodedata.cpython-312-darwin.so', 'codecs.pyc', 'math.pyd', 'json.pth', 'Functools.PY', 'encodings'])
    assert.equal(opaque('print(1)', { cwdFiles: [entry] }).reason, 'cwd-shadow', entry);
  safe('print(1)', { cwdFiles: ['math.txt', 'json.md', 'enum.json', 're.sh', 'string.c', 'types.d.ts'] });
});

test('encode, decode and open(encoding=) take only a built-in codec literal', () => {
  safe("print('x'.encode(), 'x'.encode('utf-8'), b'x'.decode('ASCII'), b'x'.decode('latin-1',))");
  assert.deepEqual(safe("print(open('a.txt', encoding='utf8').read())").reads, ['a.txt']);
  for (const code of ["'x'.encode('base64')", "b'x'.decode('quopri')", "import sys; print(''.encode(sys.argv[1]))", "''.encode('utf-8', 'strict')", "''.encode(encoding='utf-8')", "print(''.encode)", "import json; json.loads('1', parse_float=''.encode)", "''.encode(f'utf-8')"])
    assert.equal(opaque(code).reason, 'codec', code);
  assert.equal(opaque("print(open('a.txt', encoding='bz2').read())").reason, 'open');
});

test('a re pattern must be a string literal without \\N{', () => {
  safe("import re; print(re.sub(r'[a-z]+', 'x', 'ab'), re.compile(b'x'), re.escape('a.b'), re.I)");
  for (const code of ["import re; print(re.sub(r'\\N{DIGIT ONE}', '', 'x'))", "import re, sys; print(re.findall(sys.argv[1], 'x'))", "import re; print(re.sub('a', '\\N{DIGIT ONE}', 'a'))", "import re; print(re.match(f'a', 'a'))", 'import re; print(re.compile)', "import re; print(re.search(('a'), 'a'))", "import re; print(re.split(pattern='a', string='a'))"])
    assert.equal(opaque(code).reason, 're-pattern', code);
  // The decoded value counts, not only the source text, even with -I.
  for (const code of ["import re; print(re.sub('\\x5cN{DIGIT ONE}', '', 'x'))", "import re; print(re.sub('\\134N{DIGIT ONE}', '', 'x'))", "import re; print(re.sub('\\\\' 'N{DIGIT ONE}', '', 'x'))", "import re; print(re.sub('a', '\\x5c' 'N{DIGIT ONE}', 'a'))", "import re; print(re.sub('a', f'\\x5cN{\"{DIGIT ONE}\"}', 'a'))"])
    assert.equal(opaque(code, { isolated: true }).reason, 're-pattern', code);
  safe("import re; print(re.sub('\\\\d' '+', 'N', 'a1'))", { isolated: true });
});

test('a lone surrogate in an open path is opaque', () => {
  for (const code of ["print(open('\\udcff').read())", "print(open('secret\\udc80x'))", "open('\\ud83d\\ude00')", "open('\\U0000dc80')", "open('a\udc80')"])
    assert.equal(opaque(code).reason, 'open', code);
  assert.deepEqual(safe("open('\\U0001F600.txt')").reads, ['\u{1F600}.txt']);
});

test('the nesting limit is MAX_NESTING brackets', () => {
  assert.equal(MAX_NESTING, 32);
  safe('print' + '('.repeat(MAX_NESTING) + '1' + ')'.repeat(MAX_NESTING));
  assert.equal(opaque('print(' + '('.repeat(MAX_NESTING) + '1' + ')'.repeat(MAX_NESTING) + ')').reason, 'nesting');
  safe("print(f'{1:{2:{3}}}')");
  assert.equal(opaque("print(f'{1:{2:{3:{4}}}}')").reason, 'fstring');
});

test('a coding cookie on line 1 or 2 other than utf-8 is opaque, even inside a string', () => {
  for (const code of ["print('''a\n# coding: latin-1\n''')", '#!/usr/bin/env python\n# coding: latin-1\nprint(1)', 'print(1)\n# vim: set fileencoding=unicode_escape :'])
    assert.equal(opaque(code).reason, 'encoding', code);
  safe('print(1)\n\n# coding: unicode_escape');
});

test('a .pth file in the written index makes it opaque', () => {
  const site = path.join(os.tmpdir(), 'fence-py', 'site-packages');
  const code = 'print(1)';
  assert.equal(opaque(code, { writtenIndex: new Set([path.join(site, 'evil.pth')]) }).reason, 'startup-file');
  opaque(code, { isolated: true, writtenIndex: new Set([path.join(site, 'evil.pth')]) });
  opaque(code, { isolated: true, writtenIndex: new Set([path.join(site, 'sitecustomize.py')]) });
  opaque(code, { isolated: true, writtenIndex: new Set([path.join(site, 'usercustomize.py')]) });
  opaque(code, { isolated: true, writtenIndex: null });
  opaque(code, { isolated: true, writtenIndex: undefined });
  safe(code, { isolated: true, writtenIndex: new Set([path.join(site, 'notes.txt'), path.join(site, 'pthx.py')]) });
  for (const p of [
    '/x/site-packages/sitecustomize/__init__.py',
    '/x/site-packages/__pycache__/sitecustomize.cpython-312.pyc',
    '/x/site-packages/sitecustomize.cpython-312-darwin.so',
    '/x/site-packages/usercustomize.pyd',
    '/x/site-packages/UserCustomize/helper.py',
  ]) assert.equal(opaque(code, { isolated: true, writtenIndex: new Set([p]) }).reason, 'startup-file', p);
  safe(code, { isolated: true, writtenIndex: new Set(['/x/site-packages/mysitecustomize.py', '/x/pth/notes.txt']) });
});

test('the tokenizer reads strings, comments, prefixes and continuations like Python', () => {
  safe("print('eval(1) __import__ os')  # __import__('os') in a comment");
  safe('print("""a \' " \'\' b""", r\'\\\'\', Rb\'x\', BR"y", u\'z\', F\'{1}\', fR"{2}", rf\'{{x}}\')');
  safe("print(1 + \\\n  2)");
  safe('print(\n  1,\n  2,\n)\n\n# trailing comment\n');
  safe("print('a'.upper().replace('A', 'b').split(','))");
  safe('print(f"{1 + 2!r:>{4}} {\'x\'=}")');
  safe('import math; print(math.sqrt(2) ** 2, math.pi, -1, 0x1f, 1_000, 1e-3, 2j, ...)');
  safe('print({"k": (1, 2)}["k"][0], [1, 2][::-1], not 1 or 2 if 3 else 4)');
  opaque("print('unterminated)");
  opaque('print("""never closed)');
  opaque('print(1) \\ print(2)');
  opaque('  print(1)');
  opaque('print(1)\n  print(2)');
  opaque('print(1 $ 2)');
  opaque("ur'x'");
  opaque("print(f'{1}}')");
  opaque("print(f'{1')");
  opaque("print(f'{'a'}')");
  opaque("print(f'{\"\\'\"}')");
  opaque("print(f'{1 # c}')");
  opaque('print(1)\r\nprint(2)');
  opaque('# -*- coding: unicode_escape -*-\nprint(1)');
  safe('# -*- coding: utf-8 -*-\nprint(1)');
  opaque('\ufeffprint(1)');
  opaque('print(1)\0');
});

test('names are judged after NFKC normalization and dunder names are opaque', () => {
  safe('\uff50\uff52\uff49\uff4e\uff54(1)');
  opaque('__builtins__');
  opaque('print(__name__)');
  opaque("print(''.__doc__)");
  opaque('import sys; print(sys.\uff4d\uff4f\uff44\uff55\uff4c\uff45\uff53)');
});

test('the allowlists are explicit data', () => {
  assert.deepEqual(Object.keys(MODULE_ATTRS).sort(), ['json', 'math', 're', 'sys']);
  assert.deepEqual([...MODULE_ATTRS.sys].sort(), ['argv', 'stdin']);
  assert.ok(MODULE_ATTRS.json.has('dumps') && !MODULE_ATTRS.json.has('dump'));
  assert.ok(VALUE_METHODS.has('upper') && VALUE_METHODS.has('read') && !VALUE_METHODS.has('format'));
  assert.ok(Object.isFrozen(MODULE_ATTRS));
  // The BOM rule is spelled as an escape, not an invisible literal character.
  const source = fs.readFileSync(new URL('../src/tables/interp-python.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('﻿') && source.includes('\\ufeff'));
  assert.equal(opaque('﻿print(1)').reason, 'char');
});

test('it never throws, caps the size and stays linear', () => {
  assert.equal(opaque('print(1)'.padEnd(40 * 1024, ' ')).reason, 'size');
  for (const bad of [null, undefined, 42, {}, '(' .repeat(5000), '['.repeat(100) + ']'.repeat(100), "f'" + '{'.repeat(300)]) {
    const r = checkPython(bad, CLEAN);
    assert.equal(r.opaque, true);
  }
  assert.equal(checkPython('print(1)', undefined).opaque, true);
  let seed = 7;
  const alphabet = "abcdefjsonrimpt_ ()[]{}.,:;'\"\\#\n\t=+-*/!fb0123456789\u00e9\uff45";
  for (let n = 0; n < 2000; n += 1) {
    let s = '';
    for (let k = 0; k < 40; k += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      s += alphabet[seed % alphabet.length];
    }
    const r = checkPython(s, CLEAN);
    assert.ok(r.safe === true || r.opaque === true, s);
  }
  const big = 'print(' + "'x'.upper(), ".repeat(2000) + ')';
  const t0 = performance.now();
  safe(big);
  safe("print(f'" + '{1}'.repeat(5000) + "')");
  assert.ok(performance.now() - t0 < 20000);
});
