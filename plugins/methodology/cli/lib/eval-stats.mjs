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
