// Validation of a judge against the owner's labels: the dev/test split of the review sample, the confusion counts of a
// judge on one split and the usability rule (Global Constraints: >= 15 positives and >= 15 negatives, both Wilson 90%
// lower bounds >= 0.7). node: built-ins only.
import { createHash } from 'node:crypto';
import { Z90, wilson } from './eval-stats.mjs';

export const MIN_PER_CLASS = 15;
export const MIN_LOWER = 0.7;

// Thrown when a judge prompt names a session of the dev or test split: a few-shot example drawn from the data the judge
// is validated on would inflate its measured agreement. The message holds the ids, never the prompt text.
export class FewShotLeak extends Error {
  constructor(ids) {
    super(`the judge prompt names ${ids.length} dev or test session(s): ${ids.join(', ')}`);
    this.name = 'FewShotLeak';
    this.ids = ids;
  }
}

// The split of a sampled session: a session of a stratified stratum (cost, outlier) is always `train`; one of the
// random stratum is `dev` or `test` by the parity of the first byte of SHA-256(sessionId).
export function splitOf(sessionId, stratum) {
  if (stratum !== 'random') return 'train';
  return createHash('sha256').update(String(sessionId)).digest()[0] % 2 === 0 ? 'dev' : 'test';
}

// The labeled session ids of `labels`: a Set or Map of ids, or a list of ids or of { sessionId } rows.
function labeledIds(labels) {
  const out = new Set();
  const list = labels instanceof Map ? [...labels.keys()] : [...(labels ?? [])];
  for (const l of list) {
    const id = typeof l === 'string' ? l : l?.sessionId;
    if (typeof id === 'string') out.add(id);
  }
  return out;
}

// Judge result against the owner's label, over the labeled random-stratum sessions of `split`:
//   positive = the session carries `category` in `labelCategories` (Map sessionId -> [category]); negative = labeled
//   without it. A judge `fail` means the failure was found. A session with no judgment under `promptHash` (a judgment
//   of another hash or category is ignored) or with an `undecided` one is counted in `undecided` and in no rate.
// `promptBody` (optional) is the judge prompt's text: it must name no dev or test session (FewShotLeak).
export function validateCategory({ category, labels, sample, labelCategories, judgments, promptHash, split = 'test', promptBody = '' }) {
  const body = String(promptBody ?? '');
  const leaked = [...new Set((sample ?? []).filter((r) => splitOf(r.sessionId, r.stratum) !== 'train' && body.includes(r.sessionId)).map((r) => r.sessionId))];
  if (leaked.length > 0) throw new FewShotLeak(leaked);

  const labeled = labeledIds(labels);
  const verdict = new Map();
  for (const j of judgments ?? []) {
    if (j?.promptHash === promptHash && (j.category === undefined || j.category === category) && typeof j.sessionId === 'string') verdict.set(j.sessionId, j.result);
  }
  let tp = 0; let fn = 0; let tn = 0; let fp = 0; let undecided = 0;
  for (const row of new Map((sample ?? []).map((r) => [r.sessionId, r])).values()) {
    if (splitOf(row.sessionId, row.stratum) !== split || !labeled.has(row.sessionId)) continue;
    const positive = (labelCategories?.get(row.sessionId) ?? []).includes(category);
    const result = verdict.get(row.sessionId);
    if (result !== 'pass' && result !== 'fail') undecided += 1;
    else if (positive) { if (result === 'fail') tp += 1; else fn += 1; }
    else if (result === 'pass') tn += 1;
    else fp += 1;
  }
  const positives = tp + fn;
  const negatives = tn + fp;
  const tprCI = wilson(tp, positives, Z90);
  const tnrCI = wilson(tn, negatives, Z90);
  const lacks = [];
  if (positives < MIN_PER_CLASS) lacks.push(`positives ${positives} < ${MIN_PER_CLASS}`);
  if (negatives < MIN_PER_CLASS) lacks.push(`negatives ${negatives} < ${MIN_PER_CLASS}`);
  if (positives >= MIN_PER_CLASS && tprCI[0] < MIN_LOWER) lacks.push(`TPR lower bound ${tprCI[0].toFixed(3)} < ${MIN_LOWER}`);
  if (negatives >= MIN_PER_CLASS && tnrCI[0] < MIN_LOWER) lacks.push(`TNR lower bound ${tnrCI[0].toFixed(3)} < ${MIN_LOWER}`);
  return {
    tp, fn, tn, fp, positives, negatives, undecided,
    tpr: positives === 0 ? null : tp / positives, tnr: negatives === 0 ? null : tn / negatives, tprCI, tnrCI,
    usable: lacks.length === 0, reason: lacks.length === 0 ? null : lacks.join('; '),
  };
}

// How many more random-stratum sessions to sample (and label) to reach MIN_PER_CLASS in each class of the test split,
// from a validateCategory result: half of the new sessions land in test, and a class turns up at its rate so far
// (smoothed, so an empty class still gives a finite number). 0 when both classes have enough.
export function moreNeeded(result) {
  const short = (have) => Math.max(0, MIN_PER_CLASS - have);
  const labeled = result.positives + result.negatives;
  const need = (have, shortBy) => (shortBy === 0 ? 0 : (2 * shortBy * (labeled + 2)) / (have + 1));
  return Math.ceil(Math.max(
    need(result.positives, short(result.positives)),
    need(result.negatives, short(result.negatives)),
  ));
}
