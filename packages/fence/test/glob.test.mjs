import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileGlob, matchGlob, resolveGlobPrefix } from '../src/match/glob.mjs';
import { PolicyError } from '../src/policy/errors.mjs';

const VARS = { home: '/home/tester', repo: '/work/repo', cwd: '/work/repo/sub' };

function assertGlobError(fn) {
  assert.throws(fn, (e) => e instanceof PolicyError && e.code === 'glob');
}

test('star does not cross a slash', () => {
  assert.equal(matchGlob('/a/*', '/a/b', VARS), true);
  assert.equal(matchGlob('/a/*', '/a/b/c', VARS), false);
  assert.equal(matchGlob('/a/*.js', '/a/x.js', VARS), true);
  assert.equal(matchGlob('/a/*.js', '/a/x/y.js', VARS), false);
  assert.equal(matchGlob('/a/?', '/a/b', VARS), true);
  assert.equal(matchGlob('/a/?', '/a/bc', VARS), false);
  assert.equal(matchGlob('/a/?', '/a//', VARS), false);
  // anchored to the whole path
  assert.equal(matchGlob('/a/b', '/x/a/b', VARS), false);
  assert.equal(matchGlob('/a/b', '/a/bc', VARS), false);
  assert.equal(matchGlob('/a/b', '/a/b/', VARS), false);
});

test('double star matches zero segments', () => {
  assert.equal(matchGlob('/a/**/b', '/a/b', VARS), true);
  assert.equal(matchGlob('/a/**/b', '/a/x/b', VARS), true);
  assert.equal(matchGlob('/a/**/b', '/a/x/y/b', VARS), true);
  assert.equal(matchGlob('/a/**/b', '/a/xb', VARS), false);
  assert.equal(matchGlob('/a/**/b', '/a/x/yb', VARS), false);
  // trailing ** matches everything below, and the directory itself
  assert.equal(matchGlob('/a/**', '/a/b/c/d', VARS), true);
  assert.equal(matchGlob('/a/**', '/a/b', VARS), true);
  assert.equal(matchGlob('/a/**', '/a', VARS), true);
  assert.equal(matchGlob('/a/**', '/ab', VARS), false);
  assert.equal(matchGlob('/a/**', '/b/a/c', VARS), false);
  assert.equal(matchGlob('/**', '/anything/at/all', VARS), true);
  assert.equal(matchGlob('**', '/anything/at/all', VARS), true);
});

test('**/.env matches /a/b/.env and /.env', () => {
  assert.equal(matchGlob('**/.env', '/a/b/.env', VARS), true);
  assert.equal(matchGlob('**/.env', '/.env', VARS), true);
  assert.equal(matchGlob('**/.env', '/a/.env.local', VARS), false);
  assert.equal(matchGlob('**/.env', '/a/x.env', VARS), false);
  assert.equal(matchGlob('**/.env', '/a/b/.env/c', VARS), false);
});

test('**/.env.* does not match .env.example when excepted separately', () => {
  // The glob itself matches .env.example; the exception is a separate glob that
  // the engine consults. Both facts are what the policy relies on.
  const deny = '**/.env.*';
  const except = '**/.env.example';
  assert.equal(matchGlob(deny, '/r/.env.local', VARS), true);
  assert.equal(matchGlob(deny, '/r/.env', VARS), false);
  assert.equal(matchGlob(deny, '/r/.env.example', VARS), true);
  assert.equal(matchGlob(except, '/r/.env.example', VARS), true);
  assert.equal(matchGlob(except, '/r/.env.local', VARS), false);
  const denied = (p) => matchGlob(deny, p, VARS) && !matchGlob(except, p, VARS);
  assert.equal(denied('/r/.env.example'), false);
  assert.equal(denied('/r/.env.production'), true);
});

test('tilde and repo placeholders expand', () => {
  assert.equal(matchGlob('~/.ssh/**', '/home/tester/.ssh/id_ed25519', VARS), true);
  assert.equal(matchGlob('~/.ssh/**', '/home/other/.ssh/id_ed25519', VARS), false);
  assert.equal(matchGlob('~', '/home/tester', VARS), true);
  assert.equal(matchGlob('${repo}/src/**', '/work/repo/src/a.js', VARS), true);
  assert.equal(matchGlob('${repo}/src/**', '/work/other/src/a.js', VARS), false);
  assert.equal(matchGlob('${cwd}/*', '/work/repo/sub/x', VARS), true);
  assert.equal(matchGlob('${cwd}/*', '/work/repo/x', VARS), false);
  // a tilde that is not the whole first segment is a plain character
  assert.equal(matchGlob('/a/*~', '/a/file~', VARS), true);
  assert.equal(matchGlob('~x/y', '/home/testerx/y', VARS), false);
  assert.equal(matchGlob('~x/y', '~x/y', VARS), true);
  // trailing slash on a value does not double up
  assert.equal(matchGlob('~/a', '/home/tester/a', { home: '/home/tester/' }), true);
  // expanded values are literal: metacharacters in them do not act as wildcards
  const odd = { home: '/h/a.b+c(d)[e]*?{f}$^|\\' };
  assert.equal(matchGlob('~/x', '/h/a.b+c(d)[e]*?{f}$^|\\/x', odd), true);
  assert.equal(matchGlob('~/x', '/h/aXb+c(d)[e]*?{f}$^|\\/x', odd), false);
  assert.equal(matchGlob('${repo}/x', '/r/anything/x', { home: '/h', repo: '/r/*' }), false);
  assert.equal(matchGlob('${repo}/x', '/r/*/x', { home: '/h', repo: '/r/*' }), true);
  // a value that looks like a placeholder is not expanded again
  assert.equal(matchGlob('${cwd}/x', '/r/${repo}/x', { home: '/h', cwd: '/r/${repo}' }), true);
  assert.equal(matchGlob('${cwd}/x', '/r/zzz/x', { home: '/h', cwd: '/r/${repo}', repo: '/r/zzz' }), false);
});

test('missing placeholder values and unknown placeholders throw', () => {
  assertGlobError(() => compileGlob('${repo}/x', { home: '/h' }));
  assertGlobError(() => compileGlob('${cwd}/x', { home: '/h' }));
  assertGlobError(() => compileGlob('${nope}/x', VARS));
  assertGlobError(() => compileGlob('~/x', {}));
});

test('a double star inside a segment behaves like a star', () => {
  assert.equal(matchGlob('/a/b**c', '/a/bXXc', VARS), true);
  assert.equal(matchGlob('/a/b**c', '/a/bc', VARS), true);
  assert.equal(matchGlob('/a/b**c', '/a/bX/Yc', VARS), false);
  assert.equal(matchGlob('/a/**c', '/a/x/c', VARS), false);
  assert.equal(matchGlob('/a/**c', '/a/xc', VARS), true);
  assert.equal(matchGlob('/a/c**', '/a/cx/y', VARS), false);
  assert.equal(matchGlob('/a/c**', '/a/cxy', VARS), true);
});

test('bracket classes', () => {
  assert.equal(matchGlob('/a/[abc].txt', '/a/b.txt', VARS), true);
  assert.equal(matchGlob('/a/[abc].txt', '/a/d.txt', VARS), false);
  assert.equal(matchGlob('/a/[a-c].txt', '/a/b.txt', VARS), true);
  assert.equal(matchGlob('/a/[a-c].txt', '/a/z.txt', VARS), false);
  assert.equal(matchGlob('/a/[!a-c].txt', '/a/z.txt', VARS), true);
  assert.equal(matchGlob('/a/[!a-c].txt', '/a/b.txt', VARS), false);
  assert.equal(matchGlob('/a/[^a-c].txt', '/a/z.txt', VARS), true);
  assert.equal(matchGlob('/a/[^a-c].txt', '/a/b.txt', VARS), false);
  // ] first in the class is literal
  assert.equal(matchGlob('/a/[]x]', '/a/]', VARS), true);
  assert.equal(matchGlob('/a/[]x]', '/a/x', VARS), true);
  assert.equal(matchGlob('/a/[]x]', '/a/y', VARS), false);
  assert.equal(matchGlob('/a/[!]x]', '/a/y', VARS), true);
  assert.equal(matchGlob('/a/[!]x]', '/a/]', VARS), false);
  // special regexp characters are inert inside a class
  assert.equal(matchGlob('/a/[.^\\-]', '/a/^', VARS), true);
  assert.equal(matchGlob('/a/[.^\\-]', '/a/\\', VARS), true);
  assert.equal(matchGlob('/a/[.^\\-]', '/a/-', VARS), true);
  assert.equal(matchGlob('/a/[.^\\-]', '/a/x', VARS), false);
  assert.equal(matchGlob('/a/[*]', '/a/*', VARS), true);
  assert.equal(matchGlob('/a/[*]', '/a/x', VARS), false);
  // a class never matches the separator, even negated or by range
  assert.equal(matchGlob('/a[!x]b', '/a/b', VARS), false);
  assert.equal(matchGlob('/a[ -~]b', '/a/b', VARS), false);
  assert.equal(matchGlob('/a[/]b', '/a/b', VARS), false);
  // a trailing or leading dash is literal
  assert.equal(matchGlob('/a/[a-]', '/a/-', VARS), true);
  assert.equal(matchGlob('/a/[-a]', '/a/-', VARS), true);
  // classes inside a placeholder value stay literal
  assert.equal(matchGlob('${repo}/x', '/r[ab]/x', { home: '/h', repo: '/r[ab]' }), true);
  assert.equal(matchGlob('${repo}/x', '/ra/x', { home: '/h', repo: '/r[ab]' }), false);
});

test('unclosed bracket throws', () => {
  assertGlobError(() => compileGlob('/a/[abc', VARS));
  assertGlobError(() => compileGlob('/a/[', VARS));
  assertGlobError(() => compileGlob('/a/[!', VARS));
  assertGlobError(() => compileGlob('/a/[]', VARS));
  assertGlobError(() => matchGlob('/a/[abc', '/a/a', VARS));
});

test('empty patterns, NUL bytes and reversed ranges throw', () => {
  assertGlobError(() => compileGlob('', VARS));
  assertGlobError(() => compileGlob('/a/\u0000b', VARS));
  assertGlobError(() => compileGlob('/a/[z-a]', VARS));
  assertGlobError(() => resolveGlobPrefix('', VARS));
  assertGlobError(() => resolveGlobPrefix('/a/\u0000', VARS));
});

test('relative patterns match as-is and paths with NUL never match', () => {
  assert.equal(matchGlob('src/*.js', 'src/a.js', VARS), true);
  assert.equal(matchGlob('src/*.js', '/src/a.js', VARS), false);
  assert.equal(matchGlob('/a/*', '/a/b\u0000', VARS), false);
  assert.equal(matchGlob('/a/*', undefined, VARS), false);
});

test('compileGlob returns an anchored RegExp', () => {
  const re = compileGlob('/a/*', VARS);
  assert.ok(re instanceof RegExp);
  assert.equal(re.test('/a/b'), true);
  assert.equal(re.test('/x/a/b'), false);
  // no global/sticky flags: test() is stateless across calls
  assert.equal(re.test('/a/b'), true);
  assert.equal(re.test('/a/b'), true);
});

test('glob matching of long adversarial paths stays linear-ish', () => {
  const budgetMs = 1500;
  const cases = [
    ['/**/*a*a*a*a*a*a*a*a*b', '/' + 'a'.repeat(60000)],
    ['**/*a*a*a*a*a*a*a*a*b', 'a'.repeat(60000)],
    ['/x/' + '*a'.repeat(30) + 'b', '/x/' + 'a'.repeat(60000)],
    ['**/a/**/a/**/a/**/a/**/a/**/b', '/' + 'a/'.repeat(8000) + 'c'],
    ['/**/a*/**/a*/**/a*/**/a*/**/z', '/' + 'aa/'.repeat(8000)],
    ['/a/**/' + '[ab]*'.repeat(20) + '?c', '/a/' + 'ab'.repeat(30000)],
    ['/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*x', '/' + 'a/'.repeat(8000)],
  ];
  for (const [pattern, p] of cases) {
    const start = process.hrtime.bigint();
    assert.equal(matchGlob(pattern, p, VARS), false, pattern);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < budgetMs, `${pattern.slice(0, 40)} took ${ms.toFixed(0)} ms`);
  }
  // and a positive case at the same size
  const start = process.hrtime.bigint();
  assert.equal(matchGlob('/**/*a*a*a*a*a*b', '/' + 'a'.repeat(60000) + 'b', VARS), true);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < budgetMs);
});

test('compiled regexps contain no nested quantifiers', () => {
  const patterns = ['**/a/**/b/**', '/a/*b*c*/**/d?', '~/**', '/**/x*y*z'];
  for (const p of patterns) {
    const src = compileGlob(p, VARS).source;
    // a quantified group whose body contains a quantifier: (...)* or (...)+ with *,+ or {n} inside
    assert.equal(/\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)[*+{]/.test(src.replaceAll('(?:', '(').replaceAll('(?=', '(').replaceAll('(?!', '(')), false, `${p} -> ${src}`);
  }
});

// ----- differential test against a naive segment-wise reference matcher -----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segmentRegex(seg) {
  let src = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') {
      while (seg[i + 1] === '*') i++;
      src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'u');
}

function refMatch(patSegs, pathSegs) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * 1000 + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === patSegs.length) r = j === pathSegs.length;
    else if (patSegs[i] === '**') {
      r = false;
      for (let k = j; k <= pathSegs.length && !r; k++) r = go(i + 1, k);
    } else r = j < pathSegs.length && segmentRegex(patSegs[i]).test(pathSegs[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

test('compiled globs agree with a naive reference matcher on random inputs', () => {
  const rand = mulberry32(20261017);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const patSegPool = ['a', 'b', 'ab', 'ba', '*', '**', '**', '*a', 'a*', '*a*', 'a*b', '?', 'a?', '*a*b*', '**a', '', 'b*a'];
  const pathSegPool = ['a', 'b', 'ab', 'ba', 'aab', 'abab', 'bb', 'aa', '', 'bab'];
  let checked = 0;
  let matched = 0;
  for (let n = 0; n < 4000; n++) {
    const patSegs = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(patSegPool));
    const pathSegs = Array.from({ length: Math.floor(rand() * 7) }, () => pick(pathSegPool));
    if (rand() < 0.7) pathSegs.unshift('');
    const pattern = patSegs.join('/');
    if (pattern === '') continue; // the empty pattern is invalid
    const p = pathSegs.join('/');
    const got = matchGlob(pattern, p, VARS);
    const want = refMatch(patSegs, pathSegs.length ? pathSegs : ['']);
    assert.equal(got, want, `pattern ${JSON.stringify(pattern)} path ${JSON.stringify(p)}`);
    checked++;
    if (want) matched++;
  }
  assert.ok(checked > 3900);
  assert.ok(matched > 150, `only ${matched} positive cases; the generator is too weak`);
});

// ----- resolveGlobPrefix -----

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fence-glob-'));
}

test('resolveGlobPrefix follows a symlinked directory in the literal prefix (temp dir)', () => {
  const root = tempDir();
  try {
    const real = fs.realpathSync.native(root);
    fs.mkdirSync(path.join(real, 'target', 'inner'), { recursive: true });
    fs.symlinkSync(path.join(real, 'target'), path.join(real, 'link'));
    const vars = { home: path.join(real, 'link'), repo: path.join(real, 'link', 'inner') };

    assert.equal(resolveGlobPrefix(`${real}/link/**`, VARS), `${real}/target/**`);
    assert.equal(resolveGlobPrefix(`${real}/link/inner/*.js`, VARS), `${real}/target/inner/*.js`);
    // placeholders expand first, then resolve
    assert.equal(resolveGlobPrefix('~/inner/**', vars), `${real}/target/inner/**`);
    assert.equal(resolveGlobPrefix('${repo}/**/x', vars), `${real}/target/inner/**/x`);
    // a missing tail is kept verbatim after the resolved part
    assert.equal(resolveGlobPrefix(`${real}/link/missing/deeper/**`, VARS), `${real}/target/missing/deeper/**`);
    // only the literal prefix is resolved: a wildcard segment stops resolution
    assert.equal(resolveGlobPrefix(`${real}/li*/inner`, VARS), `${real}/li*/inner`);
    // a fully literal pattern is resolved whole
    assert.equal(resolveGlobPrefix(`${real}/link/inner`, VARS), `${real}/target/inner`);
    // the resolved pattern still matches the realpath
    const resolved = resolveGlobPrefix(`${real}/link/**`, VARS);
    assert.equal(matchGlob(resolved, `${real}/target/inner/file`, VARS), true);
    assert.equal(matchGlob(resolved, `${real}/link/inner/file`, VARS), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGlobPrefix keeps literal metacharacters in resolved prefixes inert', () => {
  const calls = [];
  const fake = (p) => {
    calls.push(p);
    if (p === '/real*dir') return '/other[x]dir';
    const e = new Error('ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  const vars = { home: '/h', repo: '/real*dir' };
  const out = resolveGlobPrefix('${repo}/sub/**', vars, fake);
  // the star in the resolved value is escaped so it cannot act as a wildcard when recompiled
  assert.equal(matchGlob(out, '/other[x]dir/sub/f', VARS), true);
  assert.equal(matchGlob(out, '/otherxdir/sub/f', VARS), false);
  assert.ok(calls.includes('/real*dir/sub'));
});

test('resolveGlobPrefix leaves a pattern with no existing prefix unchanged', () => {
  const root = tempDir();
  try {
    const real = fs.realpathSync.native(root);
    const missing = `${real}/does/not/exist/**/x`;
    assert.equal(resolveGlobPrefix(missing, VARS), missing);
    assert.equal(resolveGlobPrefix('**/.env', VARS), '**/.env');
    assert.equal(resolveGlobPrefix('relative/dir/*', VARS), 'relative/dir/*');
    // a realpath that always fails leaves even an absolute pattern as it was
    const failing = () => {
      throw new Error('boom');
    };
    assert.equal(resolveGlobPrefix('/tmp/**', VARS, failing), '/tmp/**');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGlobPrefix resolves /tmp like the platform does', () => {
  const expected = fs.realpathSync.native('/tmp');
  assert.equal(resolveGlobPrefix('/tmp/**', VARS), `${expected}/**`);
});

test('resolveGlobPrefix uses the injected realpath for the longest existing prefix', () => {
  const seen = [];
  const fake = (p) => {
    seen.push(p);
    if (p === '/a/b') return '/z/b';
    const e = new Error('ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  assert.equal(resolveGlobPrefix('/a/b/c/d/**', VARS, fake), '/z/b/c/d/**');
  assert.deepEqual(seen, ['/a/b/c/d', '/a/b/c', '/a/b']);
  // root-level resolution
  assert.equal(resolveGlobPrefix('/**', VARS, (p) => p), '/**');
});
