// The statistics of the evals: the Wilson score interval and the seeded PRNG. node: built-ins only (none needed).

// The two-sided 90% quantile of the standard normal: the default z of every interval of the evals.
export const Z90 = 1.6448536269514722;

// The Wilson score interval [lower, upper] of k successes in n trials at the confidence `z` stands for (default 90%),
// clamped to [0, 1]. No trials gives the whole unit interval.
export function wilson(k, n, z = Z90) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // The bounds are exact at the ends (no success: lower 0; every trial a success: upper 1), where rounding would miss them.
  return [k === 0 ? 0 : Math.max(0, centre - half), k === n ? 1 : Math.min(1, centre + half)];
}

// A seeded PRNG in [0, 1): the same seed gives the same sequence.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The Newcombe hybrid score interval (method 10) of the difference d = k1/n1 - k2/n2, built from the two Wilson intervals.
// Without trials in either arm there is no difference to bound: null, never NaN.
export function newcombe(k1, n1, k2, n2, z = Z90) {
  if (n1 === 0 || n2 === 0) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1, z);
  const [l2, u2] = wilson(k2, n2, z);
  const d = p1 - p2;
  return {
    d,
    lower: d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
    upper: d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2),
  };
}

// The trials per arm to detect a margin `m` on a proportion `p` at 5% significance and 80% power (z 1.645 and 0.842).
export function requiredN(p, m) {
  return Math.ceil((2 * (1.645 + 0.842) ** 2 * p * (1 - p)) / (m * m));
}

// The quantile `q` of an ascending-sorted array by linear interpolation (type 7); null for an empty array.
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// The median of an array (not modified); null for an empty array.
export function median(xs) {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

// The median of a with-replacement resample of xs drawn with `rng`.
function resampleMedian(xs, rng) {
  const sample = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) sample[i] = xs[Math.floor(rng() * xs.length)];
  return median(sample);
}

// The 90% percentile interval [5%, 95%] of the bootstrap distribution `values`.
function interval90(values) {
  values.sort((a, b) => a - b);
  return [quantile(values, 0.05), quantile(values, 0.95)];
}

// The bootstrap 90% interval [lower, upper] of the median of xs (B resamples, seeded); null for an empty array.
export function bootstrapMedian(xs, { B = 2000, seed = 1 } = {}) {
  if (xs.length === 0) return null;
  const rng = mulberry32(seed);
  return interval90(Array.from({ length: B }, () => resampleMedian(xs, rng)));
}

// The median difference c = median(arm) - median(control) with its bootstrap 90% interval (both arms resampled each
// round, seeded); null when either arm is empty.
export function bootstrapMedianDiff(arm, control, { B = 2000, seed = 1 } = {}) {
  if (arm.length === 0 || control.length === 0) return null;
  const rng = mulberry32(seed);
  const diffs = Array.from({ length: B }, () => resampleMedian(arm, rng) - resampleMedian(control, rng));
  const [lower, upper] = interval90(diffs);
  return { c: median(arm) - median(control), lower, upper };
}
