import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plantInDiff } from '../skills/auditing-performance/scripts/lib/replay-seed.mjs';

// Synthetic diffs only. New-file line numbers are counted from the hunk header `+c`: context and added lines
// advance the counter, removed lines do not.
const FLIP = [
  'diff --git a/src/limit.js b/src/limit.js',
  '--- a/src/limit.js',
  '+++ b/src/limit.js',
  '@@ -10,4 +10,5 @@ function check(n) {',
  '   const max = 5;',
  '-  const old = 1;',
  '+  const next = 2;',
  '+  if (n >= max) {',
  '     return true;',
  '   }',
  '',
].join('\n');

const OFF_BY_ONE = [
  'diff --git a/src/loop.js b/src/loop.js',
  '--- a/src/loop.js',
  '+++ b/src/loop.js',
  '@@ -1,2 +1,4 @@',
  ' const items = [];',
  '+for (let i = 0; i < items.length; i++) {',
  '+  total += items[i];',
  ' }',
  '',
].join('\n');

const GUARD = [
  'diff --git a/src/guard.js b/src/guard.js',
  '--- a/src/guard.js',
  '+++ b/src/guard.js',
  '@@ -20,2 +20,4 @@ export function run(x) {',
  '   const a = 1;',
  '+  if (x == null) return;',
  '+  const b = x.value;',
  '   return a;',
  '@@ -40,1 +42,2 @@ export function other() {',
  '   const c = 3;',
  '+  return c;',
  '',
].join('\n');

// Index list of the lines that differ between two texts of the same line count.
const differing = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length, 'line count unchanged');
  return x.flatMap((l, i) => (l === y[i] ? [] : [i]));
};

test('flip-comparison changes exactly one added line and reports its new-file line', () => {
  const out = plantInDiff(FLIP, 'flip-comparison');
  assert.equal(out.kind, 'flip-comparison');
  assert.equal(out.file, 'src/limit.js');
  // Hunk starts at 10: context=10, removed (no count), +const next=11, +if=12.
  assert.equal(out.line, 12);
  const changed = differing(FLIP, out.diff);
  assert.equal(changed.length, 1);
  assert.equal(FLIP.split('\n')[changed[0]], '+  if (n >= max) {');
  assert.equal(out.diff.split('\n')[changed[0]], '+  if (n > max) {');
});

test('flip-comparison also turns > into >=', () => {
  const diff = FLIP.replace('n >= max', 'n > max');
  const out = plantInDiff(diff, 'flip-comparison');
  assert.equal(out.diff.split('\n')[7], '+  if (n >= max) {');
});

test('off-by-one widens < to <= in an added loop header', () => {
  const out = plantInDiff(OFF_BY_ONE, 'off-by-one');
  assert.equal(out.kind, 'off-by-one');
  assert.equal(out.file, 'src/loop.js');
  assert.equal(out.line, 2);
  const changed = differing(OFF_BY_ONE, out.diff);
  assert.equal(changed.length, 1);
  assert.equal(out.diff.split('\n')[changed[0]], '+for (let i = 0; i <= items.length; i++) {');
});

test('drop-guard removes the added guard line and keeps the diff consistent', () => {
  const out = plantInDiff(GUARD, 'drop-guard');
  assert.equal(out.kind, 'drop-guard');
  assert.equal(out.file, 'src/guard.js');
  // Hunk starts at 20: context=20, guard=21.
  assert.equal(out.line, 21);
  const before = GUARD.split('\n');
  const after = out.diff.split('\n');
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((l) => l.includes('x == null')));
  // The removed line is the only content difference; hunk counts follow it.
  assert.equal(after[3], '@@ -20,2 +20,3 @@ export function run(x) {');
  assert.equal(after[7], '@@ -40,1 +41,2 @@ export function other() {');
  assert.deepEqual(
    before.filter((l) => !after.includes(l)).sort(),
    ['+  if (x == null) return;', '@@ -20,2 +20,4 @@ export function run(x) {', '@@ -40,1 +42,2 @@ export function other() {'].sort(),
  );
});

test('line numbers follow later hunks and files', () => {
  const diff = [
    '--- a/one.js',
    '+++ b/one.js',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-gone',
    '+if (a > 1) {}',
    '--- a/two.js',
    '+++ b/two.js',
    '@@ -5 +7,3 @@',
    ' ctx',
    '+x',
    '+while (i < n) {',
    '',
  ].join('\n');
  const second = plantInDiff(diff, 'off-by-one');
  assert.equal(second.file, 'two.js');
  // Hunk starts at 7: ctx=7, x=8, while=9.
  assert.equal(second.line, 9);
  const first = plantInDiff(diff, 'flip-comparison');
  assert.equal(first.file, 'one.js');
  assert.equal(first.line, 2);
});

test('pick selects among candidates deterministically', () => {
  const diff = [
    '--- a/p.js',
    '+++ b/p.js',
    '@@ -1,1 +1,3 @@',
    ' ctx',
    '+if (a > b) {}',
    '+if (c >= d) {}',
    '',
  ].join('\n');
  const a = plantInDiff(diff, 'flip-comparison', 0);
  const b = plantInDiff(diff, 'flip-comparison', 1);
  assert.equal(a.line, 2);
  assert.equal(b.line, 3);
  assert.deepEqual(plantInDiff(diff, 'flip-comparison', 1), b);
  // An out-of-range pick wraps around.
  assert.equal(plantInDiff(diff, 'flip-comparison', 2).line, 2);
});

test('returns null without a candidate', () => {
  const diff = [
    '--- a/q.js',
    '+++ b/q.js',
    '@@ -1,2 +1,2 @@',
    ' if (a >= b) {}',
    '-if (a >= c) {}',
    '+const z = 1;',
    '',
  ].join('\n');
  for (const kind of ['flip-comparison', 'off-by-one', 'drop-guard']) {
    assert.equal(plantInDiff(diff, kind), null, kind);
  }
  assert.equal(plantInDiff('', 'flip-comparison'), null);
});

test('never touches +++ headers, context or removed lines', () => {
  const diff = [
    '--- a/x >= y.js',
    '+++ b/x >= y.js',
    '@@ -1,2 +1,2 @@',
    ' while (a < b) {}',
    '-if (q == null) return;',
    '+const ok = 1;',
    '',
  ].join('\n');
  for (const kind of ['flip-comparison', 'off-by-one', 'drop-guard']) {
    assert.equal(plantInDiff(diff, kind), null, kind);
  }
});

test('an added line that looks like a header inside a hunk is still a body line', () => {
  const diff = [
    '--- a/h.js',
    '+++ b/h.js',
    '@@ -1,1 +1,2 @@',
    ' ctx',
    '+++ if (a > b) {}',
    '',
  ].join('\n');
  const out = plantInDiff(diff, 'flip-comparison');
  assert.equal(out.file, 'h.js');
  assert.equal(out.line, 2);
});

test('does not plant on arrows, generics or comments', () => {
  const diff = [
    '--- a/r.js',
    '+++ b/r.js',
    '@@ -1,1 +1,4 @@',
    ' ctx',
    '+const f = (a) => a;',
    '+const m: Map<string, number> = new Map();',
    '+// if (a > b) is documented here',
    '',
  ].join('\n');
  assert.equal(plantInDiff(diff, 'flip-comparison'), null);
});

test('drop-guard skips a guard that is the only new line of its hunk', () => {
  const diff = [
    '--- a/s.js',
    '+++ b/s.js',
    '@@ -3,1 +3,1 @@',
    '-old();',
    '+if (v === undefined) return;',
    '',
  ].join('\n');
  assert.equal(plantInDiff(diff, 'drop-guard'), null);
});

test('an unknown kind is rejected', () => {
  assert.throws(() => plantInDiff(FLIP, 'nope'), /unknown kind/);
});
