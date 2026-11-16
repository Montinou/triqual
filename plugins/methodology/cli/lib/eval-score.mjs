// The score of one evaluator: its confusion counts on the train, dev and test splits under its current version, and,
// on the dev split only, a comparison with the version it replaced. The dev line decides whether a prompt change is
// kept; the test split is reported, never used to decide. node: built-ins only.
import { join } from 'node:path';
import { checkVersion } from './eval-checks.mjs';
import { loadJudgePrompt } from './eval-judge.mjs';
import { splitOf, validateCategory } from './eval-validate.mjs';

// The version a verdict of this category is recorded under now: the judge prompt's hash for a `judge` category, the
// check version for a `code` one (`version` overrides it, for a test).
export function currentVersion(category, { judgesDir, version } = {}) {
  if (category.check === 'judge') return loadJudgePrompt(join(judgesDir, `${category.id}.md`)).hash;
  return version ?? checkVersion();
}

// The promptHashes other than `current`, the one with the most recent line first, then the next most recent, and so on.
function otherVersions(judgments, current) {
  const out = [];
  const rows = [...(judgments ?? [])];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const h = rows[i]?.promptHash;
    if (typeof h === 'string' && h !== current && !out.includes(h)) out.push(h);
  }
  return out;
}

// The promptHash of the last line, in file order, whose promptHash is not `current`; null when there is none.
export function previousVersion(judgments, current) {
  return otherVersions(judgments, current)[0] ?? null;
}

const cut = (r) => ({ tp: r.tp, fn: r.fn, tn: r.tn, fp: r.fp, undecided: r.undecided, tpr: r.tpr, tnr: r.tnr, tprCI: r.tprCI, tnrCI: r.tnrCI });

// (tpr + tnr) / 2, or null when the sessions hold no positive or no negative.
const balancedOf = (r) => (r.tp + r.fn === 0 || r.tn + r.fp === 0 ? null : (r.tp / (r.tp + r.fn) + r.tn / (r.tn + r.fp)) / 2);
const counts = (r) => ({ tp: r.tp, fn: r.fn, tn: r.tn, fp: r.fp, balanced: balancedOf(r) });

// sessionId -> result of the last line of `version` (the rule validateCategory applies).
function verdicts(judgments, category, version) {
  const out = new Map();
  for (const j of judgments) {
    if (j?.promptHash === version && (j.category === undefined || j.category === category) && typeof j.sessionId === 'string') out.set(j.sessionId, j.result);
  }
  return out;
}

const decided = (r) => r === 'pass' || r === 'fail';

export function scoreCategory({ category, sample, labels, labelCategories, judgments, version }) {
  const id = category.id;
  const rows = (judgments ?? []).filter((j) => j?.category === undefined || j.category === id);
  const base = { category: id, labels, labelCategories, judgments: rows };
  const split = (s, over = {}) => validateCategory({ ...base, sample, promptHash: version, split: s, ...over });
  const train = cut(split('train'));
  const dev = cut(split('dev'));
  const test = { ...cut(split('test')), usable: split('test').usable };

  // The previous version is the most recent other version that has dev sessions to compare on; none: the first version.
  let previous = null;
  let verdict = 'first';
  const after = verdicts(rows, id, version);
  for (const prevVersion of otherVersions(rows, version)) {
    const before = verdicts(rows, id, prevVersion);
    // The labeled dev sessions with a pass or fail verdict under both versions: the only ones the two are compared on.
    const both = (sample ?? []).filter((r) => splitOf(r.sessionId, r.stratum) === 'dev' && decided(before.get(r.sessionId)) && decided(after.get(r.sessionId)));
    const prev = validateCategory({ ...base, sample: both, promptHash: prevVersion, split: 'dev' });
    const cur = validateCategory({ ...base, sample: both, promptHash: version, split: 'dev' });
    const n = cur.tp + cur.fn + cur.tn + cur.fp;
    if (n === 0) continue;
    previous = { version: prevVersion, n, previous: counts(prev), current: counts(cur) };
    const a = previous.previous.balanced;
    const b = previous.current.balanced;
    const better = a === null || b === null ? cur.tp + cur.tn > prev.tp + prev.tn : b > a;
    verdict = better ? 'better' : 'not-better';
    break;
  }
  return { category: id, check: category.check, version, train, dev, test, previous, verdict };
}
