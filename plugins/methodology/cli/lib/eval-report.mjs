// The experiment report of the evals: per-session guardrail verdicts scored by the experiment's frozen evaluator
// snapshot, the arm rows (rate, cost, difference with the control) and the five non-inferiority verdicts.
// node: built-ins only.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadJudgePrompt } from './eval-judge.mjs';
import { planUnits } from './eval-plans.mjs';
import { bootstrapMeanPaired, bootstrapMedian, bootstrapMedianDiff, median, newcombe, requiredN, wilson } from './eval-stats.mjs';
import { judgeExcluded } from './eval-taxonomy.mjs';
import { planDescriptives, taskUnits } from './eval-tasks.mjs';

// The smallest arm the verdicts accept, whatever the required sample size says.
export const MIN_N = 30;
export const VERDICTS = ['insufficient data', 'worse', 'propose', 'non-inferior, not cheaper', 'inconclusive'];
// The entrypoint the sessions store keeps for an interactive session (print mode keeps "sdk-cli").
const INTERACTIVE_ENTRYPOINT = 'cli';
const UNKNOWN_PROJECT = '(unknown)';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Loads <evals>/snapshots/<hash>/ (see lib/eval-snapshot.mjs): { hash, categories, judgeExclude, prompts, checks }.
// `prompts` maps each judge category to the hash of its frozen prompt (the promptHash a judgment must carry); `checks` is
// the snapshot's own eval-checks.mjs (CHECKS, runCheck), so a later edit of the live checks changes nothing.
export async function loadSnapshot(dir) {
  const doc = JSON.parse(readFileSync(join(dir, 'taxonomy.json'), 'utf8'));
  // A snapshot with no categories list is as unreadable as a corrupt one: read as "no evaluators" it scores every session healthy.
  if (!Array.isArray(doc?.categories)) throw new Error('snapshot taxonomy.json has no categories list');
  const categories = doc.categories;
  const prompts = {};
  for (const c of categories) if (c.check === 'judge') prompts[c.id] = loadJudgePrompt(join(dir, 'judges', `${c.id}.md`)).hash;
  const checks = await import(pathToFileURL(join(dir, 'eval-checks.mjs')).href);
  return { hash: basename(dir), categories, judgeExclude: Array.isArray(doc?.judgeExclude) ? doc.judgeExclude : [], prompts, checks };
}

// The guardrail verdict of one session under `snapshot`: "unhealthy" when any evaluator fails, else "undecided" when any
// is undecided or has no judgment, else "healthy". A code category runs the snapshot's frozen check on `session.file`
// (the transcript); when that is undecided (the transcript is gone, the store outlives the 30-day cleanup) it takes the
// last line of judgments[category] for the session recorded under the snapshot's check version, else it stays
// undecided. A decided result (pass or fail) of a session with no line of that version is handed to `onCode({ sessionId,
// category, result, promptHash })`, so the caller can store it before the transcript is cleaned up. A judge category
// reads the last line of judgments[category] for the session and the snapshot's prompt hash; with none, or for a
// session whose project is under the snapshot's judgeExclude (an unknown project counts as excluded), it has no judgment.
export function sessionVerdict(session, snapshot, judgments, { home, platform, onCode } = {}) {
  let undecided = false;
  for (const c of snapshot.categories) {
    let result;
    if (c.check === 'code') {
      const { CHECKS, runCheck } = snapshot.checks;
      result = Object.hasOwn(CHECKS, c.id) ? runCheck(c.id, {}, session.file ?? '', CHECKS) : 'undecided';
      const version = typeof snapshot.checks.checkVersion === 'function' ? snapshot.checks.checkVersion() : null;
      const lines = version === null ? [] : (judgments?.[c.id] ?? []).filter((r) => r.sessionId === session.sessionId && r.promptHash === version);
      if (result === 'undecided') {
        if (lines.length > 0) result = lines[lines.length - 1].result;
      } else if (version !== null && lines.length === 0 && typeof onCode === 'function') {
        // A verdict computed while the transcript is still there: handed to the caller to store, once per session and version.
        onCode({ sessionId: session.sessionId, category: c.id, result, promptHash: version });
      }
    } else if (judgeExcluded(session.project ?? null, snapshot.judgeExclude, { home, platform })) {
      result = 'undecided';
    } else {
      const rows = (judgments?.[c.id] ?? []).filter((r) => r.sessionId === session.sessionId && r.promptHash === snapshot.prompts[c.id]);
      result = rows.length === 0 ? 'undecided' : rows[rows.length - 1].result;
    }
    if (result === 'fail') return 'unhealthy';
    if (result !== 'pass') undecided = true;
  }
  return undecided ? 'undecided' : 'healthy';
}

// The verdict of an arm against its control, in the order of the plan: insufficient data (either arm below
// max(required, 30), or no interval), worse (U < 0), propose (L >= -m and the cost median difference's upper bound
// cUpper < 0), non-inferior, not cheaper (L >= -m otherwise), else inconclusive. With objective "parallelism" the last
// two tests use the lower bound pLower of the parallelism median difference: propose needs pLower > 0, else
// "non-inferior, not more parallel". A missing cUpper or pLower never proves an advantage.
export function verdict({ nArm, nControl, required, lower, upper, cUpper = null, margin, objective = 'cost', pLower = null }) {
  const need = Math.max(finite(required) ? required : 0, MIN_N);
  if (nArm < need || nControl < need || !finite(lower) || !finite(upper)) return 'insufficient data';
  if (upper < 0) return 'worse';
  const parallel = objective === 'parallelism';
  if (lower >= -margin) {
    if (parallel) return finite(pLower) && pLower > 0 ? 'propose' : 'non-inferior, not more parallel';
    return finite(cUpper) && cUpper < 0 ? 'propose' : 'non-inferior, not cheaper';
  }
  return 'inconclusive';
}

// The statistics of a group of units: counts, healthy rate and its Wilson interval, the cost median and its bootstrap interval.
function summarize(group) {
  const n = group.length;
  const k = group.filter((u) => u.verdict === 'healthy').length;
  const costs = group.map((u) => u.cost).filter(finite);
  return {
    n,
    rate: n === 0 ? null : k / n,
    rateCI: n === 0 ? null : wilson(k, n),
    costMedian: median(costs),
    costCI: bootstrapMedian(costs),
  };
}

function perProject(group) {
  const by = new Map();
  for (const u of group) {
    const key = typeof u.project === 'string' && u.project !== '' ? u.project : UNKNOWN_PROJECT;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(u);
  }
  return Object.fromEntries([...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, group2]) => [key, summarize(group2)]));
}

// The rows of `experiment` over `units`: [control row, arm row]. A unit is { arm (the arm name), contaminated, verdict
// ("healthy" | "unhealthy" | "undecided"), cost, project, models, parallelism? }; a unit of another arm is ignored,
// contaminated and undecided units are excluded from n and counted in `excluded`. A row is { experiment, kind, arm,
// control, n, excluded, rate, rateCI, costMedian, costCI, perProject, models, parallelismMedian, parallelismCI, d, dCI,
// c, cCI, p, pCI, required, verdict }: d is the healthy-rate difference arm - control (Newcombe interval), c the cost
// median difference with its bootstrap interval, required the sample size for the control's rate and the margin. With
// objective "parallelism" the rows also hold the median parallelism and its interval, and the arm row p, the median
// parallelism difference arm - control with its bootstrap interval (null for a cost experiment, whose parallelism fields
// are all null). The control row carries null from d on. Every statistic of an empty group is null, never NaN.
export function buildRows(units, experiment) {
  const margin = experiment.margin;
  const parallel = experiment.objective === 'parallelism';
  const names = Object.keys(experiment.arms);
  const ordered = [experiment.control, ...names.filter((a) => a !== experiment.control)];
  const groups = new Map(ordered.map((name) => {
    const own = units.filter((u) => u.arm === name);
    const counted = own.filter((u) => u.contaminated !== true && u.verdict !== 'undecided');
    return [name, {
      own,
      counted,
      excluded: {
        contaminated: own.filter((u) => u.contaminated === true).length,
        undecided: own.filter((u) => u.contaminated !== true && u.verdict === 'undecided').length,
      },
    }];
  }));
  const costs = (name) => groups.get(name).counted.map((u) => u.cost).filter(finite);
  const parallelisms = (name) => groups.get(name).counted.map((u) => u.parallelism).filter(finite);
  const control = groups.get(experiment.control).counted;
  const controlStats = summarize(control);
  const kControl = control.filter((u) => u.verdict === 'healthy').length;

  return ordered.map((name) => {
    const g = groups.get(name);
    const isControl = name === experiment.control;
    const row = {
      experiment: experiment.id,
      kind: experiment.kind,
      arm: name,
      control: isControl,
      ...summarize(g.counted),
      excluded: g.excluded,
      perProject: perProject(g.counted),
      models: [...new Set(g.own.flatMap((u) => (Array.isArray(u.models) ? u.models : [])))].sort(),
      // A cost experiment has no parallelism figures; a parallelism one shows them on every row, whatever the sample size.
      parallelismMedian: parallel ? median(parallelisms(name)) : null,
      parallelismCI: parallel ? bootstrapMedian(parallelisms(name)) : null,
      d: null, dCI: null, c: null, cCI: null, p: null, pCI: null, required: null, verdict: null,
    };
    if (isControl) return row;
    const k = g.counted.filter((u) => u.verdict === 'healthy').length;
    const diff = newcombe(k, g.counted.length, kControl, control.length);
    const shift = bootstrapMedianDiff(costs(name), costs(experiment.control));
    const spread = parallel ? bootstrapMedianDiff(parallelisms(name), parallelisms(experiment.control)) : null;
    row.required = controlStats.rate === null ? null : requiredN(controlStats.rate, margin);
    if (diff !== null) { row.d = diff.d; row.dCI = [diff.lower, diff.upper]; }
    if (shift !== null) { row.c = shift.c; row.cCI = [shift.lower, shift.upper]; }
    if (spread !== null) { row.p = spread.c; row.pCI = [spread.lower, spread.upper]; }
    row.verdict = verdict({
      nArm: row.n,
      nControl: controlStats.n,
      required: row.required,
      lower: diff?.lower ?? null,
      upper: diff?.upper ?? null,
      cUpper: shift?.upper ?? null,
      pLower: spread?.lower ?? null,
      margin,
      objective: experiment.objective,
    });
    return row;
  });
}

// The units of a session experiment from the sessions store: the sessions of its arms (`arm` = "<id>/<name>") that
// started on or after the experiment's start day, each scored by sessionVerdict under `snapshot`. A contaminated session
// is not scored; a session whose stored entrypoint is not the interactive one is no unit at all. `file(session)` is its transcript path. The store keeps no arm on a contaminated session (its records
// disagree), so its arm is read from `armRecords` (the parsed lines of <evals>/session-arms.jsonl): the one arm of this
// experiment its records name; none, or two different arms of it, and the session cannot be placed and is left out.
export function sessionUnits({ sessions, experiment, snapshot, judgments, file, home, platform, armRecords = [], onCode }) {
  const prefix = `${experiment.id}/`;
  const units = [];
  for (const s of sessions) {
    // Only a new interactive session is assigned an arm. A `claude -p` started inside one runs the SessionStart hook under
    // its own session id with the parent's arm in the environment, but never got the arm's settings: not a unit. A line
    // with no entrypoint (an older store) keeps counting.
    if (typeof s.entrypoint === 'string' && s.entrypoint !== INTERACTIVE_ENTRYPOINT) continue;
    let named = typeof s.arm === 'string' ? s.arm : null;
    if (named === null && s.contaminated === true) {
      const own = new Set(armRecords.filter((r) => r?.sessionId === s.sessionId && typeof r.arm === 'string' && r.arm.startsWith(prefix)).map((r) => r.arm));
      if (own.size === 1) [named] = own;
    }
    if (named === null || !named.startsWith(prefix)) continue;
    const arm = named.slice(prefix.length);
    if (!isObject(experiment.arms) || !Object.hasOwn(experiment.arms, arm)) continue;
    if (typeof experiment.start === 'string' && !(typeof s.start === 'string' && s.start >= experiment.start)) continue;
    const contaminated = s.contaminated === true;
    units.push({
      arm,
      contaminated,
      verdict: contaminated ? null : sessionVerdict({ sessionId: s.sessionId, project: s.project ?? null, file: file(s) }, snapshot, judgments, { home, platform, onCode }),
      cost: finite(s.usd) ? s.usd : null,
      project: s.project ?? null,
      models: Object.keys(isObject(s.models) ? s.models : {}).sort(),
    });
  }
  return units;
}

// The rows of a role experiment: [control row, arm row] over its units. An experiment of the planner is scored per plan
// (planUnits over the `plan-review` records, the rows with their parallelism figures and, per arm, the descriptive
// cleanTaskRate and wallClockHours from `snapshots`, the parsed `triqual tasks export --json --all`); any other role per
// task (taskUnits over `assignments`, the parsed role-assignments.jsonl, the clean-task rate as the healthy rate and the
// subagent cost of the task under `root` as the cost). `records` are the valid records of the role-eval store.
export function roleRows({ experiment, records, assignments, root, snapshots }) {
  if (Object.values(experiment.arms)[0]?.role === 'planner') {
    const units = planUnits(records, experiment);
    return planDescriptives(buildRows(units, experiment), units, { records, snapshots });
  }
  return buildRows(taskUnits({ experiment, assignments, records, root }), experiment);
}

// The units of a skill experiment: one per case of the suite run each arm wrote, <evalsDir>/skill-runs/<id>/<arm>.json as
// `triqual eval skills` writes it ({ experiment, arm, at, auth, units: [{ caseId, pass, usd }] }). A case passed is
// "healthy", failed "unhealthy"; a case whose `pass` is neither a boolean is "undecided", never counted. The cost of a unit
// is its usd. A suite run holds no project or model, so a unit has none; an arm with no file (or one that cannot be read)
// has no units. An arm name that is not a plain file name is skipped.
export function skillUnits({ evalsDir, experiment }) {
  const units = [];
  for (const arm of Object.keys(isObject(experiment.arms) ? experiment.arms : {})) {
    if (arm !== basename(arm) || arm.startsWith('.')) continue;
    const file = join(evalsDir, 'skill-runs', experiment.id, `${arm}.json`);
    if (!existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const u of Array.isArray(doc?.units) ? doc.units : []) {
      units.push({
        arm,
        contaminated: false,
        verdict: u?.pass === true ? 'healthy' : u?.pass === false ? 'unhealthy' : 'undecided',
        cost: finite(u?.usd) ? u.usd : null,
        project: null,
        models: [],
      });
    }
  }
  return units;
}

// The per-case figures of an arm in a replay: Map case -> { pass, usd }. `runs` are the arm's counted runs (setup-failed
// and agent-error left out). A case passes when more than half of its counted runs pass (a tie fails); its usd is the
// median of its runs' finite usd, null when it has none.
function replayCases(runs) {
  const by = new Map();
  for (const r of runs) {
    if (!by.has(r.case)) by.set(r.case, []);
    by.get(r.case).push(r);
  }
  return new Map([...by].map(([id, rs]) => {
    const usds = rs.map((r) => r.usd).filter(finite);
    return [id, { pass: rs.filter((r) => r.outcome === 'pass').length > rs.length / 2, usd: usds.length === 0 ? null : median(usds) }];
  }));
}

// The rows of a role experiment's replay over `results` (the parsed lines of <evals>/replay/results.jsonl): [control row,
// arm row ...], or [] when no counted run of the experiment exists. Rows of another experiment, of an arm the experiment
// does not have or whose v is not 1 are ignored; a run counts unless its outcome is setup-failed or agent-error. n and
// rate count cases (see replayCases), usdMedian is the median usd per counted run, perRepo the pass rate per repoName
// (`repoOf`: case id -> repoName; a case missing from it is "unknown"). The comparison with the control is paired: only
// cases counted in both arms enter it. d is the mean over them of (arm pass - control pass) with its bootstrap interval,
// c the median of (arm usd - control usd) over those with a usd on both sides, discordant the paired cases only one side
// passed. The verdict takes the paired count as both arm sizes and no required sample size (the unpaired requiredN does
// not apply), so MIN_N is the only floor. The control row carries null from paired on; required is always null.
export function replayRows({ experiment, results, repoOf = new Map() }) {
  const runs = results.filter((r) => isObject(r) && r.v === 1 && r.experiment === experiment.id && typeof r.case === 'string'
    && Object.hasOwn(experiment.arms, r.arm) && r.outcome !== 'setup-failed' && r.outcome !== 'agent-error');
  if (runs.length === 0) return [];
  const ordered = [experiment.control, ...Object.keys(experiment.arms).filter((a) => a !== experiment.control)];
  const control = replayCases(runs.filter((r) => r.arm === experiment.control));
  return ordered.map((name) => {
    const own = runs.filter((r) => r.arm === name);
    const cases = replayCases(own);
    const n = cases.size;
    const k = [...cases.values()].filter((c) => c.pass).length;
    const repos = new Map();
    for (const [id, c] of cases) {
      const repo = repoOf.get(id) ?? 'unknown';
      const t = repos.get(repo) ?? { n: 0, k: 0 };
      repos.set(repo, { n: t.n + 1, k: t.k + (c.pass ? 1 : 0) });
    }
    const row = {
      experiment: experiment.id,
      kind: 'replay',
      arm: name,
      control: name === experiment.control,
      n,
      rate: n === 0 ? null : k / n,
      rateCI: n === 0 ? null : wilson(k, n),
      usdMedian: median(own.map((r) => r.usd).filter(finite)),
      perRepo: Object.fromEntries([...repos].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([repo, t]) => [repo, { n: t.n, rate: t.k / t.n }])),
      paired: null, discordant: null, d: null, dCI: null, c: null, cCI: null, required: null, verdict: null,
    };
    if (row.control) return row;
    const both = [...cases].filter(([id]) => control.has(id));
    const pass = (c) => (c.pass ? 1 : 0);
    const mean = bootstrapMeanPaired(both.map(([id, c]) => pass(c) - pass(control.get(id))));
    const costs = both.filter(([id, c]) => c.usd !== null && control.get(id).usd !== null).map(([id, c]) => c.usd - control.get(id).usd);
    row.paired = both.length;
    row.discordant = {
      armOnly: both.filter(([id, c]) => c.pass && !control.get(id).pass).length,
      controlOnly: both.filter(([id, c]) => !c.pass && control.get(id).pass).length,
    };
    if (mean !== null) { row.d = mean.mean; row.dCI = [mean.lower, mean.upper]; }
    if (costs.length > 0) { row.c = median(costs); row.cCI = bootstrapMedian(costs); }
    row.verdict = verdict({
      nArm: row.paired,
      nControl: row.paired,
      required: null,
      lower: row.dCI?.[0] ?? null,
      upper: row.dCI?.[1] ?? null,
      cUpper: row.cCI?.[1] ?? null,
      margin: experiment.margin,
    });
    return row;
  });
}
