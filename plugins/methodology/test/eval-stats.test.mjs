import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Z90, bootstrapMeanPaired, bootstrapMedian, bootstrapMedianDiff, median, mulberry32, newcombe, quantile, requiredN, wilson } from '../cli/lib/eval-stats.mjs';

const near = (a, b, msg) => assert.equal(a.toFixed(4), b.toFixed(4), msg);
const Z95 = 1.959963984540054;

test('Z90 is the two-sided 90% normal quantile', () => {
  assert.equal(Z90, 1.6448536269514722);
});

test('wilson reproduces Newcombe 1998 single-proportion values', () => {
  const [l1, u1] = wilson(81, 263, Z95);
  near(l1, 0.2553, '81/263 lower');
  near(u1, 0.3662, '81/263 upper');
  const [l2, u2] = wilson(15, 148, Z95);
  near(l2, 0.0624, '15/148 lower');
  near(u2, 0.1605, '15/148 upper');
});

test('wilson defaults to z = Z90', () => {
  assert.deepEqual(wilson(30, 100), wilson(30, 100, Z90));
  const [lo, hi] = wilson(30, 100);
  assert.ok(lo > 0.2 && lo < 0.3 && hi > 0.3 && hi < 0.4);
});

test('wilson with n = 0 is the whole unit interval', () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('wilson stays inside [0, 1] at the extremes', () => {
  const [l, u] = wilson(15, 15);
  assert.ok(l > 0.8 && l < 1);
  assert.equal(u, 1);
  const [l0, u0] = wilson(0, 15);
  assert.equal(l0, 0);
  assert.ok(u0 > 0 && u0 < 0.2);
});

test('mulberry32 is deterministic per seed, in [0, 1), and differs across seeds', () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, ((r) => () => r())(mulberry32(2))));
  assert.ok(new Set(xs).size > 45);
});

test('newcombe reproduces 56/70 vs 48/80', () => {
  const r = newcombe(56, 70, 48, 80, Z95);
  near(r.d, 0.2);
  near(r.lower, 0.0524);
  near(r.upper, 0.3339);
});

test('newcombe defaults to z = Z90 and is narrower than at 95%', () => {
  const r90 = newcombe(56, 70, 48, 80);
  const r95 = newcombe(56, 70, 48, 80, Z95);
  assert.ok(r90.lower > r95.lower && r90.upper < r95.upper);
  assert.equal(r90.d, 56 / 70 - 48 / 80);
});

test('requiredN is ceil(2 (1.645 + 0.842)^2 p(1-p) / m^2)', () => {
  assert.equal(requiredN(0.8, 0.10), 198);
  assert.equal(requiredN(0.8, 0.15), 88);
  assert.equal(requiredN(1, 0.10), 0);
});

test('median and quantile (type 7)', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.05), 1.15);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.equal(quantile([7], 0.9), 7);
});

test('bootstrap is deterministic with seed 1', () => {
  const xs = [1.2, 3.4, 2.2, 9.1, 4.4, 0.7, 5.5, 3.1];
  const ys = [2.2, 4.4, 3.3, 10.1, 5.4, 1.7, 6.5, 4.1];
  assert.deepEqual(bootstrapMedian(xs), bootstrapMedian(xs));
  assert.deepEqual(bootstrapMedian(xs), bootstrapMedian(xs, { B: 2000, seed: 1 }));
  assert.deepEqual(bootstrapMedianDiff(ys, xs), bootstrapMedianDiff(ys, xs, { B: 2000, seed: 1 }));
  const [l, u] = bootstrapMedian(xs);
  assert.ok(l <= median(xs) && median(xs) <= u);
  const big = Array.from({ length: 60 }, (_, i) => (i * 7919) % 101);
  assert.notDeepEqual(bootstrapMedianDiff(big, xs, { seed: 2 }), bootstrapMedianDiff(big, xs));
  const d = bootstrapMedianDiff(ys, xs);
  assert.equal(d.c, median(ys) - median(xs));
  assert.ok(d.lower <= d.upper);
});

test('all-equal costs give a zero-width interval', () => {
  assert.deepEqual(bootstrapMedian([5, 5, 5, 5]), [5, 5]);
  assert.deepEqual(bootstrapMedianDiff([5, 5, 5], [3, 3, 3]), { c: 2, lower: 2, upper: 2 });
});

test('empty arm gives null, never NaN', () => {
  assert.equal(bootstrapMedian([]), null);
  assert.equal(bootstrapMedianDiff([], [1, 2]), null);
  assert.equal(bootstrapMedianDiff([1, 2], []), null);
});

test('bootstrapMeanPaired: empty is null, constant diffs give a point interval', () => {
  assert.equal(bootstrapMeanPaired([]), null);
  assert.deepEqual(bootstrapMeanPaired([0, 0, 0]), { mean: 0, lower: 0, upper: 0 });
});

test('bootstrapMeanPaired is seeded and brackets the mean', () => {
  const diffs = [1, 0, 0, -1, 0, 1, 0, 0, 1, 0];
  const a = bootstrapMeanPaired(diffs);
  assert.deepEqual(a, bootstrapMeanPaired(diffs, { seed: 1 }));
  near(a.mean, 0.2);
  assert.ok(a.lower <= 0.2 && a.upper >= 0.2 && a.lower < a.upper);
});
