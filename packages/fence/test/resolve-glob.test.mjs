import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandGlob } from '../src/resolve/glob.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// Every fixture lives under one temp dir; nothing here reads the real HOME.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-glob-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// A fresh directory holding the given files ("name" or "dir/name"; a trailing slash makes an empty dir).
function fixture(files) {
  const dir = path.join(TMP, `f${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = path.join(dir, f);
    if (f.endsWith('/')) {
      fs.mkdirSync(p, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    }
  }
  return dir;
}

// An fs whose every read is counted and which can be told to fail.
function spyFs({ fail } = {}) {
  const calls = [];
  return {
    calls,
    readdirSync(p, opts) {
      calls.push(p);
      if (fail) throw Object.assign(new Error(fail), { code: fail });
      return fs.readdirSync(p, opts);
    },
  };
}

test('expands *.ts in a temp dir', () => {
  const dir = fixture(['b.ts', 'a.ts', 'c.js', '.hidden.ts', 'sub/d.ts', 'e.tsx']);
  assert.deepEqual(expandGlob('*.ts', dir), ['a.ts', 'b.ts']);
  // an absolute pattern gives absolute results
  assert.deepEqual(expandGlob(`${dir}/*.ts`, '/nonexistent-cwd'), [`${dir}/a.ts`, `${dir}/b.ts`]);
  // a sub-directory pattern keeps the relative form
  assert.deepEqual(expandGlob('sub/*.ts', dir), ['sub/d.ts']);
  // * does not cross a slash: */ one level only
  assert.deepEqual(expandGlob('*/*.ts', dir), ['sub/d.ts']);
});

test('? and bracket classes, with ! and ^ negation', () => {
  const dir = fixture(['a1', 'a2', 'b1', 'c1', 'D1', '_1', 'ab']);
  assert.deepEqual(expandGlob('a?', dir), ['a1', 'a2', 'ab']);
  assert.deepEqual(expandGlob('[ab]1', dir), ['a1', 'b1']);
  assert.deepEqual(expandGlob('[!ab]1', dir), ['D1', '_1', 'c1']);
  assert.deepEqual(expandGlob('[^ab]1', dir), ['D1', '_1', 'c1']);
  assert.deepEqual(expandGlob('[a-b]1', dir), ['a1', 'b1']);
  assert.deepEqual(expandGlob('[0-9]*', dir), UNKNOWN); // no match
  // a leading ] is a member, a trailing - is a literal dash
  assert.deepEqual(expandGlob('[]a]1', dir), ['a1']);
  assert.deepEqual(expandGlob('[a-]1', dir), ['a1']);
});

test('classes the two shells may disagree on are UNKNOWN', () => {
  const dir = fixture(['a1']);
  assert.equal(expandGlob('[[:alpha:]]1', dir), UNKNOWN); // POSIX class
  assert.equal(expandGlob('[a1', dir), UNKNOWN); // unterminated
  assert.equal(expandGlob('[a-%]1', dir), UNKNOWN); // locale-dependent range
  assert.equal(expandGlob('[z-a]1', dir), UNKNOWN); // reversed range
});

test('escaped glob characters are literal', () => {
  const dir = fixture(['a*b', 'a*bc', 'axb', 'x[1]', 'x1', 'q?']);
  assert.deepEqual(expandGlob('a\\*b*', dir), ['a*b', 'a*bc']);
  assert.deepEqual(expandGlob('x\\[1\\]*', dir), ['x[1]']);
  assert.deepEqual(expandGlob('q\\??', dir), UNKNOWN); // "q?" + one more char: no match
  assert.deepEqual(expandGlob('q\\?*', dir), ['q?']);
});

test('a pattern with no wildcard returns the unescaped literal without touching the disk', () => {
  const sfs = spyFs({ fail: 'EACCES' });
  assert.deepEqual(expandGlob('plain.txt', '/does/not/exist', { fs: sfs }), ['plain.txt']);
  assert.deepEqual(expandGlob('a\\*b', '/does/not/exist', { fs: sfs }), ['a*b']);
  assert.deepEqual(expandGlob('dir/\\[x\\]/\\\\y', '/does/not/exist', { fs: sfs }), ['dir/[x]/\\y']);
  assert.deepEqual(expandGlob('/abs/lit]eral', '/does/not/exist', { fs: sfs }), ['/abs/lit]eral']);
  assert.deepEqual(sfs.calls, []);
});

test('dotfiles are only matched by a literal leading dot', () => {
  const dir = fixture(['.env', '.env.local', '.git/', 'plain', 'sub/.x', 'sub/y']);
  assert.deepEqual(expandGlob('*', dir), ['plain', 'sub']);
  assert.deepEqual(expandGlob('?env', dir), UNKNOWN);
  assert.deepEqual(expandGlob('[.]env', dir), UNKNOWN);
  assert.deepEqual(expandGlob('.env*', dir), ['.env', '.env.local']);
  assert.deepEqual(expandGlob('.e*', dir), ['.env', '.env.local']);
  assert.deepEqual(expandGlob('sub/*', dir), ['sub/y']);
  assert.deepEqual(expandGlob('sub/.x*', dir), ['sub/.x']);
  // a pattern that would also match . and .. differs between the shells
  assert.equal(expandGlob('.*', dir), UNKNOWN);
  assert.equal(expandGlob('.?*', dir), UNKNOWN);
});

test('results are sorted in byte order', () => {
  const dir = fixture(['b', 'C', '_', 'a', 'D', 'zé', 'zz', '10', '9']);
  assert.deepEqual(expandGlob('*', dir), ['10', '9', 'C', 'D', '_', 'a', 'b', 'zz', 'zé']);
});

test('trailing slash matches directories only and keeps the slash', () => {
  const dir = fixture(['d1/x', 'd2/y', 'file']);
  assert.deepEqual(expandGlob('*/', dir), ['d1/', 'd2/']);
  fs.symlinkSync(path.join(dir, 'd1'), path.join(dir, 'lnk'));
  assert.equal(expandGlob('*/', dir), UNKNOWN); // a symlink: cannot say without stat
});

test('an intermediate wildcard follows a symlinked directory; a literal final segment is looked up', () => {
  const dir = fixture(['real/pkg.json', 'other/none']);
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'lnk'));
  assert.deepEqual(expandGlob('*/pkg.json', dir), ['lnk/pkg.json', 'real/pkg.json']);
  assert.deepEqual(expandGlob('l*/pkg.json', dir), ['lnk/pkg.json']);
});

test('a final literal segment that differs from a directory entry only by case is UNKNOWN', () => {
  const dir = fixture(['d/Pkg.json']);
  assert.equal(expandGlob('*/pkg.json', dir), UNKNOWN);
});

test('** recursion', () => {
  const dir = fixture([
    'src/a.ts',
    'src/deep/b.ts',
    'src/deep/er/c.ts',
    'src/deep/er/c.js',
    'src/.hidden/d.ts',
    'top.ts',
    'src/e.tsx',
  ]);
  assert.deepEqual(expandGlob('src/**/*.ts', dir), ['src/a.ts', 'src/deep/b.ts', 'src/deep/er/c.ts']);
  // zero directories count: the start directory is searched too
  assert.deepEqual(expandGlob('**/*.ts', dir), ['src/a.ts', 'src/deep/b.ts', 'src/deep/er/c.ts', 'top.ts']);
  // a mid pattern after **
  assert.deepEqual(expandGlob('**/er/*.js', dir), ['src/deep/er/c.js']);
  assert.deepEqual(expandGlob(`${dir}/src/**/b.ts`, '/nonexistent-cwd'), [`${dir}/src/deep/b.ts`]);
  // ** that is not a whole segment is a plain *
  assert.deepEqual(expandGlob('src/**.ts', dir), ['src/a.ts']);
});

test('** never follows symlinks and does not descend into hidden directories', () => {
  const dir = fixture(['real/inner/x.ts', 'real/y.ts', '.dot/z.ts']);
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'lnk'));
  fs.symlinkSync(dir, path.join(dir, 'real', 'loop'));
  assert.deepEqual(expandGlob('**/*.ts', dir), ['real/inner/x.ts', 'real/y.ts']);
});

test('** forms with unclear semantics are UNKNOWN', () => {
  const dir = fixture(['a/b.ts']);
  assert.equal(expandGlob('***/b.ts', dir), UNKNOWN); // zsh follows symlinks here
  assert.equal(expandGlob('**/', dir), UNKNOWN); // nothing after **
  assert.equal(expandGlob('**/a/**/b.ts', dir), UNKNOWN); // two recursive segments
});

test('shell-special characters outside a class are UNKNOWN', () => {
  const dir = fixture(['a.ts', '#x', '^y']);
  for (const p of ['*.ts~x', '^x*', 'a#*', '*(.)', '(a|b)*', '<->*']) {
    assert.equal(expandGlob(p, dir), UNKNOWN, p);
  }
  // inside a class they are plain members
  assert.deepEqual(expandGlob('[#^]*', dir), ['#x', '^y']);
});

test('returns UNKNOWN past 1000 matches', () => {
  const names = [];
  for (let i = 0; i < 1001; i++) names.push(`f${i}`);
  const dir = fixture(names);
  assert.equal(expandGlob('f*', dir), UNKNOWN);
  // exactly at the cap is fine
  const exact = fixture(names.slice(0, 1000));
  assert.equal(expandGlob('f*', exact).length, 1000);
  // the cap is configurable
  assert.equal(expandGlob('f*', exact, { maxMatches: 999 }), UNKNOWN);
  assert.equal(expandGlob('f*', exact, { maxMatches: 1000 }).length, 1000);
});

test('returns UNKNOWN past the time cap using an injected clock', () => {
  const dir = fixture(['a', 'b', 'c', 'd']);
  // 10 ms per reading of the clock: the cap (50) is crossed during the walk
  let t = 0;
  const now = () => (t += 10);
  assert.equal(expandGlob('*', dir, { now }), UNKNOWN);
  // a clock that does not move never trips the cap
  assert.deepEqual(expandGlob('*', dir, { now: () => 5 }), ['a', 'b', 'c', 'd']);
  // a jump past maxMs on the very first directory read
  const times = [0, 51];
  let i = 0;
  assert.equal(expandGlob('*', dir, { now: () => times[Math.min(i++, 1)] }), UNKNOWN);
  // exactly maxMs elapsed is not past the cap
  let k = 0;
  assert.deepEqual(expandGlob('*', dir, { now: () => (k++ === 0 ? 0 : 50) }), ['a', 'b', 'c', 'd']);
  // maxMs is configurable
  let u = 0;
  assert.equal(expandGlob('*', dir, { maxMs: 5, now: () => (u += 3) }), UNKNOWN);
});

test('a read error in any directory is UNKNOWN', () => {
  for (const code of ['EACCES', 'ENOENT', 'ENOTDIR']) {
    assert.equal(expandGlob('*', '/some/cwd', { fs: spyFs({ fail: code }) }), UNKNOWN, code);
    assert.equal(expandGlob('*/x', '/some/cwd', { fs: spyFs({ fail: code }) }), UNKNOWN, code);
  }
  // a missing directory named in the pattern
  const dir = fixture([]);
  assert.equal(expandGlob('nope/*.ts', dir), UNKNOWN);
  // an unreadable sub-directory halfway through
  const dir2 = fixture(['ok/x.ts', 'bad/x.ts']);
  const real = fs.readdirSync;
  const failing = {
    readdirSync(p, o) {
      if (p.endsWith('/bad')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, o);
    },
  };
  assert.equal(expandGlob('*/x.ts', dir2, { fs: failing }), UNKNOWN);
});

test('a symlink to a non-directory at a directory position is UNKNOWN (ENOTDIR)', () => {
  const dir = fixture(['file']);
  fs.symlinkSync(path.join(dir, 'file'), path.join(dir, 'lnk'));
  assert.equal(expandGlob('*/x', dir), UNKNOWN);
});

test('a pattern with no match returns UNKNOWN (controller ruling; the shells disagree on the literal)', () => {
  const dir = fixture(['a.js']);
  assert.equal(expandGlob('*.ts', dir), UNKNOWN);
  assert.equal(expandGlob('nomatch*', dir), UNKNOWN);
  assert.equal(expandGlob('sub/*.ts', fixture(['sub/']) ), UNKNOWN);
});

test('bad input is UNKNOWN and never throws', () => {
  const dir = fixture(['a']);
  for (const [p, c] of [
    [undefined, dir],
    ['', dir],
    [42, dir],
    ['a*\0', dir],
    ['*', 'relative/cwd'],
    ['*', undefined],
    ['*\\', dir], // dangling backslash
    ['a//*', dir],
    ['//*', dir],
    ['*'.repeat(5000), dir],
  ]) {
    assert.equal(expandGlob(p, c), UNKNOWN, String(p).slice(0, 12));
  }
  assert.equal(expandGlob('*', dir, { maxMatches: 'x' }), UNKNOWN);
  assert.equal(expandGlob('*', dir, { maxMs: -1 }), UNKNOWN);
});

test('fix 1: a non-ASCII character inside a bracket class is UNKNOWN', () => {
  const dir = fixture(['x', 'y', '\u{1F600}']);
  assert.equal(expandGlob('[\u{1F600}x]', dir), UNKNOWN);
  assert.equal(expandGlob('[!\u{1F600}]', dir), UNKNOWN);
  assert.equal(expandGlob('[\u00e9-\u00ff]', dir), UNKNOWN);
  assert.equal(expandGlob('[a-\u00ff]', dir), UNKNOWN);
  assert.equal(expandGlob('[\\\u00e9]', dir), UNKNOWN); // escaped, still non-ASCII
  // non-ASCII outside a class is fine
  const d2 = fixture(['\u{1F600}a', 'zz']);
  assert.deepEqual(expandGlob('?a', d2), ['\u{1F600}a']);
});

test('fix 2: a final . or .. under a symlink parent is UNKNOWN, under a real directory it is added', () => {
  const dir = fixture(['d/f', 'file']);
  assert.deepEqual(expandGlob('d*/.', dir), ['d/.']);
  assert.deepEqual(expandGlob('d*/..', dir), ['d/..']);
  assert.deepEqual(expandGlob('d*/../', dir), ['d/../']);
  fs.symlinkSync(path.join(dir, 'file'), path.join(dir, 'lnk'));
  assert.equal(expandGlob('l*/..', dir), UNKNOWN);
  assert.equal(expandGlob('l*/.', dir), UNKNOWN);
  assert.equal(expandGlob('*/..', dir), UNKNOWN); // reaches lnk among the entries
  // reached through a literal lookup of the link
  assert.equal(expandGlob('*/lnk/..', dir), UNKNOWN);
});

test('fix 3: an unreadable directory inside ** is UNKNOWN', () => {
  const dir = fixture(['ok/x.ts', 'bad/x.ts', 'top.ts']);
  const real = fs.readdirSync;
  const failing = {
    readdirSync(p, o) {
      if (p.endsWith('/bad')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(p, o);
    },
  };
  assert.equal(expandGlob('**/*.ts', dir, { fs: failing }), UNKNOWN);
  assert.deepEqual(expandGlob('**/*.ts', dir), ['bad/x.ts', 'ok/x.ts', 'top.ts']);
});

test('fix 4: an unescaped zsh pattern character is UNKNOWN even without * ? [', () => {
  const sfs = spyFs({ fail: 'EACCES' });
  for (const p of ['<1-5>', 'file<1-5>', '(a|b)', 'a|b', 'x~y', '^x', 'a#', 'f(1)']) {
    assert.equal(expandGlob(p, '/some/cwd', { fs: sfs }), UNKNOWN, p);
  }
  assert.deepEqual(sfs.calls, []);
  // escaped, they are plain characters
  assert.deepEqual(expandGlob('a\\~b\\#c', '/some/cwd', { fs: sfs }), ['a\\~b\\#c'.replaceAll('\\', '')]);
});
