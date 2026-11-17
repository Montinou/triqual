// What a plan cost to write, from the subagent transcripts. Read-only; node: built-ins only; never returns transcript text.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionSignals } from './eval-sessions.mjs';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8')).models;

// Every *.jsonl below `dir` that lies under a `subagents` directory.
function subagentTranscripts(dir, inside, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) subagentTranscripts(join(dir, e.name), inside || e.name === 'subagents', out);
    else if (inside && e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
  }
  return out;
}

const descriptionOf = (transcript) => {
  try {
    const description = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.description;
    return typeof description === 'string' ? description : null;
  } catch {
    return null;
  }
};

// The USD (an estimate at the list prices of prices.json) of the subagent transcripts under `root` whose sibling
// agent-<id>.meta.json has the description `planner <plan file name>`; null when none matches. `planName` is the plan
// file's name, with or without `.md` and with or without a directory.
export function plannerUsd(root, planName, prices = PRICES) {
  const base = basename(planName);
  const wanted = `planner ${base.endsWith('.md') ? base : `${base}.md`}`;
  const matches = subagentTranscripts(root, false, []).filter((t) => descriptionOf(t) === wanted);
  if (matches.length === 0) return null;
  return matches.reduce((sum, t) => sum + sessionSignals(t, { prices }).usd, 0);
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => finite(v) && v >= 0;

// The units of a planner role experiment from the `plan-review` records of the role-eval store: one per record whose arm
// is `<experiment id>/<arm name>` of the experiment and whose `at` is on or after its start. A unit is the shape
// buildRows reads: guardrail `auditClean` (critical + important = 0; the verdict is "healthy" for a clean plan,
// "unhealthy" otherwise, "undecided" when the audit counts are unreadable), cost `plannerUsd` (null counts for no cost,
// the plan still counts everywhere else) and measure `parallelism` (tasks / critical path, as the record stores it).
// [] for an experiment that is not a role experiment of the planner.
export function planUnits(records, experiment) {
  if (experiment?.kind !== 'role' || !isObject(experiment.arms)) return [];
  if (Object.values(experiment.arms)[0]?.role !== 'planner') return [];
  const prefix = `${experiment.id}/`;
  const units = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObject(r) || r.kind !== 'plan-review' || typeof r.arm !== 'string' || !r.arm.startsWith(prefix)) continue;
    const arm = r.arm.slice(prefix.length);
    if (!Object.hasOwn(experiment.arms, arm)) continue;
    if (typeof experiment.start === 'string' && !(typeof r.at === 'string' && r.at >= experiment.start)) continue;
    const found = r.auditFindings;
    const readable = isObject(found) && count(found.critical) && count(found.important);
    const auditClean = readable ? found.critical + found.important === 0 : null;
    units.push({
      arm,
      contaminated: false,
      verdict: auditClean === null ? 'undecided' : auditClean ? 'healthy' : 'unhealthy',
      auditClean,
      cost: finite(r.plannerUsd) ? r.plannerUsd : null,
      parallelism: finite(r.parallelism) ? r.parallelism : null,
      project: null,
      models: typeof experiment.arms[arm].model === 'string' ? [experiment.arms[arm].model] : [],
    });
  }
  return units;
}
