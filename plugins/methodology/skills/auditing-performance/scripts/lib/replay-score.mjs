// Replay scorer. `summarize(results)` turns judged replay runs into one row per setting; `judgeRecall(seeded, verdicts)`
// scores the judge itself against planted defects. Input and output hold ids, group labels, counts and rates only,
// never diff, finding or commit text.
//
// A run is { task, setting, findings: [{ id }], verdicts: [{ id, group, verdict }] | null, usd, seconds }.
//   - A run whose `verdicts` is not an array (null, undefined, unparsable judge output), or that holds a `confirmed`
//     verdict for one of its findings without a non-empty string `group`, is `failed`: it counts in
//     `tasks`, `usd` and `seconds`, but is excluded from recall and precision, and contributes nothing to the pool.
//   - A finding is confirmed when a verdict with its id says `confirmed`. A finding with no verdict, and a verdict
//     whose id is not one of the run's findings, count as not confirmed / are ignored.
//   - Pool: per task, the distinct confirmed groups across the settings' scored runs of that task.
//   - found: distinct confirmed groups the setting reached, summed over its scored tasks.
//   - recall: found over the pool sizes of those same tasks.
//   - precision: confirmed findings over findings, over its scored tasks.
// Edge cases (never NaN): a setting with no scored task has recall and precision `null` (nothing was measured);
// a scored setting facing an empty pool has recall 0; a scored setting with zero findings has precision 0.

const CONFIRMED = 'confirmed';
const isObject = (v) => v !== null && typeof v === 'object';
const num = (v) => (Number.isFinite(v) ? v : 0);

// Distinct confirmed groups and confirmed-finding count of one scored run, or null when a confirmed verdict for one of
// the run's findings has no non-empty string `group` (the run is then failed, like unparsable judge output).
function confirmedOf(run) {
  const ids = new Set((Array.isArray(run.findings) ? run.findings : []).map((f) => f?.id));
  const confirmedIds = new Set();
  const groups = new Set();
  for (const verdict of run.verdicts) {
    if (!isObject(verdict) || verdict.verdict !== CONFIRMED || !ids.has(verdict.id)) continue;
    if (typeof verdict.group !== 'string' || verdict.group === '') return null;
    confirmedIds.add(verdict.id);
    groups.add(verdict.group);
  }
  return { groups, confirmed: confirmedIds.size, findings: ids.size };
}

export function summarize(results) {
  if (!Array.isArray(results)) throw new TypeError('results must be an array of runs');
  for (const run of results) {
    if (!isObject(run) || typeof run.setting !== 'string' || run.task === undefined || run.task === null) {
      throw new TypeError('every run needs a task and a string setting');
    }
  }

  const scored = new Map(); // run -> confirmedOf(run), scored runs only
  const pool = new Map(); // task -> Set of confirmed groups, across settings
  for (const run of results) {
    if (!Array.isArray(run.verdicts)) continue;
    const c = confirmedOf(run);
    if (!c) continue;
    scored.set(run, c);
    const key = String(run.task);
    if (!pool.has(key)) pool.set(key, new Set());
    for (const g of c.groups) pool.get(key).add(g);
  }

  const rows = new Map(); // setting -> accumulator, in first-seen order
  for (const run of results) {
    if (!rows.has(run.setting)) {
      rows.set(run.setting, { setting: run.setting, tasks: 0, failed: 0, found: 0, poolSize: 0, confirmed: 0, findings: 0, usd: 0, seconds: 0 });
    }
    const acc = rows.get(run.setting);
    acc.tasks += 1;
    acc.usd += num(run.usd);
    acc.seconds += num(run.seconds);
    const c = scored.get(run);
    if (!c) { acc.failed += 1; continue; }
    acc.found += c.groups.size;
    acc.poolSize += pool.get(String(run.task)).size;
    acc.confirmed += c.confirmed;
    acc.findings += c.findings;
  }

  return [...rows.values()].map((a) => {
    const measured = a.tasks - a.failed > 0;
    return {
      setting: a.setting,
      tasks: a.tasks,
      failed: a.failed,
      found: a.found,
      recall: !measured ? null : a.poolSize === 0 ? 0 : a.found / a.poolSize,
      precision: !measured ? null : a.findings === 0 ? 0 : a.confirmed / a.findings,
      usd: a.usd,
      seconds: a.seconds,
    };
  });
}

// Share of the planted defects the judge confirmed. A planted defect is `{ id }` (or `{ group }`, or a bare id string);
// it counts as confirmed when a `confirmed` verdict carries that value as its id or its group. Duplicate planted ids
// count once. An empty planted list gives 0; unparsable judge output (verdicts not an array) gives null, not 0.
export function judgeRecall(seeded, verdicts) {
  if (!Array.isArray(verdicts)) return null;
  const planted = new Set(
    (Array.isArray(seeded) ? seeded : []).map((s) => (isObject(s) ? (s.id ?? s.group) : s)).filter((k) => k !== undefined && k !== null),
  );
  if (planted.size === 0) return 0;
  const confirmed = new Set();
  for (const verdict of verdicts) {
    if (!isObject(verdict) || verdict.verdict !== CONFIRMED) continue;
    if (planted.has(verdict.id)) confirmed.add(verdict.id);
    if (planted.has(verdict.group)) confirmed.add(verdict.group);
  }
  return confirmed.size / planted.size;
}
