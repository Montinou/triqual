// How often each failure happens: for each category, the share of the random-stratum sample sessions with a `fail`
// verdict, by month of the session's start and by the methodology version it ran under. Only a `pass` or `fail`
// verdict counts. A bucket under MIN_N sessions has no share and no interval (too few to say). node: built-ins only.
import { wilson } from './eval-stats.mjs';

// The fewest sessions in a bucket for a share to be reported.
export const MIN_N = 5;

const UNKNOWN = 'unknown';

// The YYYY-MM of an ISO timestamp; 'unknown' when there is none.
const monthOf = (start) => (typeof start === 'string' && /^\d{4}-\d{2}/.test(start) ? start.slice(0, 7) : UNKNOWN);
const versionOf = (v) => (typeof v === 'string' && v !== '' ? v : UNKNOWN);

function rowsOf(category, counted, bucketOf) {
  const buckets = new Map();
  for (const c of counted) {
    const b = bucketOf(c.session);
    const cur = buckets.get(b) ?? { n: 0, fail: 0 };
    cur.n += 1;
    if (c.result === 'fail') cur.fail += 1;
    buckets.set(b, cur);
  }
  return [...buckets.keys()].sort().map((bucket) => {
    const { n, fail } = buckets.get(bucket);
    const enough = n >= MIN_N;
    return { category, bucket, n, fail, share: enough ? fail / n : null, ci: enough ? wilson(fail, n) : null };
  });
}

// `sample`: the review sample rows; `sessions`: Map sessionId -> store line; `categories`: the taxonomy categories, in
// order; `verdicts`: Map category id -> Map sessionId -> result under the category's current version.
// -> { month: [row], version: [row] }, row = { category, bucket, n, fail, share, ci }, by category, then bucket.
export function ratesTables({ sample, sessions, categories, verdicts }) {
  const month = [];
  const version = [];
  for (const c of categories) {
    const byId = verdicts.get(c.id) ?? new Map();
    const counted = [];
    for (const r of sample) {
      if (r.stratum !== 'random') continue;
      const result = byId.get(r.sessionId);
      if (result !== 'pass' && result !== 'fail') continue;
      counted.push({ session: sessions.get(r.sessionId) ?? {}, result });
    }
    month.push(...rowsOf(c.id, counted, (s) => monthOf(s.start)));
    version.push(...rowsOf(c.id, counted, (s) => versionOf(s.methodologyVersion)));
  }
  return { month, version };
}
