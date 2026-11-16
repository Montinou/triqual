import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Z90, mulberry32, wilson } from '../cli/lib/eval-stats.mjs';

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
