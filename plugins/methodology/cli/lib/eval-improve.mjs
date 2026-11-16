// What one improvement round reads off the evals data: the verdicts of each category under its current version and the
// judge categories whose prompt the round's own rulings say to revise. node: built-ins only.
import { splitOf } from './eval-validate.mjs';

// The fewest ruled disagreements, over the train and dev sessions, for a judge category to be listed.
export const MIN_RULED = 3;

// sessionId -> result of the last line of `version` for `category` (the rule validateCategory applies).
export function verdictsOf(judgments, category, version) {
  const out = new Map();
  for (const j of judgments ?? []) {
    if (j?.promptHash === version && (j.category === undefined || j.category === category) && typeof j.sessionId === 'string') out.set(j.sessionId, j.result);
  }
  return out;
}

// The ids of the `judge` categories to revise: those with at least MIN_RULED (session, category) pairs, over the train and
// dev sessions of `sample`, that have a ruling in `rulings` (a Map from loadRulings), a pass or fail verdict in `verdicts`
// (Map category id -> Map sessionId -> result, under the current version) and a line in `labelCategories` (Map sessionId ->
// [category]) that the verdict contradicts (fail against a label without the category, pass against one with it). The test
// split is never read: a prompt is revised from what it is measured on, not from what it is judged on. In `categories` order.
export function reviseList({ categories, sample, labelCategories, rulings, verdicts }) {
  const ids = [...new Set((sample ?? []).filter((r) => typeof r?.sessionId === 'string' && splitOf(r.sessionId, r.stratum) !== 'test').map((r) => r.sessionId))];
  const out = [];
  for (const c of categories ?? []) {
    if (c.check !== 'judge') continue;
    const byId = verdicts?.get(c.id) ?? new Map();
    let n = 0;
    for (const id of ids) {
      if (!rulings?.has(`${id}\0${c.id}`)) continue;
      const labeled = labelCategories?.get(id);
      const verdict = byId.get(id);
      if (labeled === undefined || (verdict !== 'pass' && verdict !== 'fail')) continue;
      if ((verdict === 'fail') !== labeled.includes(c.id)) n += 1;
    }
    if (n >= MIN_RULED) out.push(c.id);
  }
  return out;
}
