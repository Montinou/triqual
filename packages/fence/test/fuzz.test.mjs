import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize } from '../src/norm/normalize.mjs';

// Hermetic: a temp cwd and home; nothing reads the real HOME.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-fuzz-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
fs.mkdirSync(path.join(TMP, 'sub'));
const CTX = { cwd: TMP, home: TMP, env: {} };

// mulberry32: a small seeded PRNG so every run sees the same inputs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shell-ish fragments, weighted toward the constructs the normalizer walks.
const PIECES = [
  ' ', ' ', ' ', ';', '&&', '||', '|', '&', '\n', '(', ')', '{ ', ' }', '$(', '`', "'", '"', '\\',
  '$X', '${X:-a}', '${Y:=b}', '$((1+2))', 'X=rm', 'Y=$X', 'export Z=1', 'rm', '-rf', 'cd', 'sub', '..',
  '/tmp', '~/x', 'git', 'checkout', 'main', '-C', 'mv', 'ln', '-s', 'a', 'b', '*', '?', '[a]', '>', '>>',
  '2>&1', '<', '<<EOF\nx $(y)\nEOF\n', "<<'E'\nq\nE\n", '<<<', 'if', 'then', 'else', 'fi', 'for', 'in',
  'do', 'done', 'while', 'case', 'esac', ';;', 'pushd', 'popd', 'sh', 'bash', 'eval', '#', '!', '=',
  'GIT_DIR=/x', 'chmod', '-R', '/dev/null', '/dev/tcp/h/1', 'é', '\t',
];

function randomInput(next) {
  const n = 1 + Math.floor(next() * 40);
  let s = '';
  for (let i = 0; i < n; i++) {
    if (next() < 0.08) s += String.fromCharCode(32 + Math.floor(next() * 95));
    else s += PIECES[Math.floor(next() * PIECES.length)];
  }
  return s;
}

function wellFormed(r) {
  if (r && Array.isArray(r.commands)) return true;
  return !!(
    r &&
    r.opaque &&
    typeof r.opaque.reason === 'string' &&
    typeof r.opaque.construct === 'string' &&
    typeof r.opaque.offset === 'number'
  );
}

test('never throws on 2000 random inputs (seeded)', () => {
  const next = rng(0x5eed1);
  let opaque = 0;
  for (let i = 0; i < 2000; i++) {
    const input = randomInput(next);
    let r;
    assert.doesNotThrow(() => {
      r = normalize(input, CTX);
    }, `input ${i}: ${JSON.stringify(input)}`);
    assert.ok(wellFormed(r), `input ${i}: ${JSON.stringify(input)} -> ${JSON.stringify(r)}`);
    if (r.opaque) opaque++;
  }
  // both outcomes are exercised
  assert.ok(opaque > 0 && opaque < 2000, `opaque count ${opaque}`);
});

// A realistic compound command that walks every construct, repeated to the target size. Variable
// names, paths and repositories vary per repetition so caches and maps grow with the input.
function sized(bytes) {
  let s = '';
  let i = 0;
  while (s.length < bytes) {
    s +=
      `V${i}=f${i}; export W${i}=$V${i}; cd sub && rm -f "$V${i}" > /dev/null 2>&1 || echo $(cat x${i}) | grep -q y; ` +
      `if [ -f a${i} ]; then mv a${i} b${i}; else cp $W${i} c; fi; for k in 1 2; do echo $k >> log; done; (cd ..; ls)\n`;
    i++;
  }
  return s.slice(0, bytes);
}

function bestTime(input, runs) {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    const out = normalize(input, CTX);
    const dt = performance.now() - t0;
    assert.ok(wellFormed(out));
    if (dt < best) best = dt;
  }
  return best;
}

// Many distinct variables first, then many subshells and branches: per-subshell copying of the
// variables would make this quadratic.
function manyVars(bytes) {
  let s = '';
  for (let i = 0; s.length < bytes / 2; i++) s += `a${i}=1;`;
  const tail = 'a|b;c||d;if e;then f;fi;g $(h);';
  while (s.length < bytes - tail.length) s += tail;
  return s;
}

test('time grows linearly: 20 KiB takes under 60x the time of 1 KiB (catches quadratic growth, tolerant of CI noise)', () => {
  for (const make of [sized, manyVars]) {
    const small = make(1024);
    const large = make(20 * 1024);
    // the inputs are not cut mid-construct into something opaque early
    assert.ok(normalize(large.slice(0, large.lastIndexOf(make === sized ? '\n' : ';')), CTX).commands, make.name);
    bestTime(small, 5); // warm up
    bestTime(large, 2);
    const tSmall = Math.max(bestTime(small, 15), 0.05);
    const tLarge = bestTime(large, 5);
    const msg = `${make.name}: 1 KiB ${tSmall.toFixed(3)} ms, 20 KiB ${tLarge.toFixed(3)} ms (ratio ${(tLarge / tSmall).toFixed(1)})`;
    assert.ok(tLarge < 60 * tSmall, msg);
  }
});

test('inputs built to be unparseable (unbalanced quotes, stray fi) return opaque', () => {
  for (const input of [
    "echo 'abc",
    'echo "abc',
    'echo $(ls',
    'echo `ls',
    'fi',
    'echo a; fi',
    'done',
    'then echo',
    'if true; then echo',
    'for x in a; do echo',
    'case x in a) echo',
    '(echo',
    'echo )',
    '{ echo',
    'echo ${X',
    'cat <<EOF\nno terminator',
    'a && && b',
    '| a',
    'a ||',
  ]) {
    const r = normalize(input, CTX);
    assert.ok(r.opaque, `expected opaque for ${JSON.stringify(input)}, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(wellFormed(r));
  }
});
