// The task and plan figures of a role experiment: whether a task came out clean, what it cost, the units of a role
// experiment of a task role, and the descriptive figures of a planner experiment's plans. Read-only; node: built-ins
// only; never returns transcript text.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { PRICES, subagentTranscripts } from './eval-plans.mjs';
import { sessionSignals } from './eval-sessions.mjs';
import { median } from './eval-stats.mjs';
import { validateRecord } from './role-eval.mjs';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
// A subagent the orchestrator names after its task: `T<N> <role>`.
const TASK_DESCRIPTION = /^T(\d+) (\S+)$/;
const TASKS_TIMEOUT_MS = 10_000;
const TASKS_BUFFER = 64 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const BLOCKING = ['critical', 'important'];

// A plan's name without its directory and without `.md`: `plan-review` records and the task ledger carry it bare, the
// records `role-eval record --plan` and `eval arm --plan` write carry the file name. Null when it is no string.
const planBase = (plan) => (typeof plan === 'string' && plan !== '' ? basename(plan).replace(/\.md$/, '') : null);
const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

// The valid records of the role-eval store file `file` (a line that is not JSON, fails validation or repeats a key is
// left out, first write wins), keys removed; [] when the file is missing or unreadable.
export function loadRoleRecords(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const seen = new Set();
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!isObject(obj)) continue;
    const { key, ...record } = obj;
    if (typeof key !== 'string' || key === '' || seen.has(key) || !validateRecord(record).ok) continue;
    seen.add(key);
    records.push(record);
  }
  return records;
}

// Whether the task `task` of plan `plan` came out clean, from the role-eval `records`: null when no `task-review` of
// that plan and task exists yet; false when one has `attempt` > 1 (the task was reopened), when a `final-escapes` record
// of the plan has an entry traced to the task with severity critical or important, or when an `escape` record (a defect
// that reached trunk after the merge, counted as important) names the plan and the task; else true. The plan joins with
// or without `.md` on either side.
export function cleanTask({ plan, task }, records) {
  const base = planBase(plan);
  if (base === null) return null;
  const mine = asArray(records).filter((r) => isObject(r) && planBase(r.plan) === base);
  const reviews = mine.filter((r) => r.kind === 'task-review' && r.task === task);
  if (reviews.length === 0) return null;
  if (reviews.some((r) => r.attempt > 1)) return false;
  const escaped = mine.some((r) => r.kind === 'final-escapes' && asArray(r.escapes).some((e) => e?.task === task && BLOCKING.includes(e.severity)));
  if (escaped) return false;
  return !mine.some((r) => r.kind === 'escape' && r.task === task);
}

// The cost of the subagents described `T<N> <role>` under the transcripts `root`: one row per (project, task, role),
// { project (the project directory name), task ("T<N>"), role, runs, usd (an estimate at the list prices of prices.json),
// firstAt (the first timestamp of its earliest run) }. A run counts when its first timestamp lies in since..until (ISO
// instants, both ends included, either may be undefined); `project` keeps one project directory only.
export function subagentTaskCosts(root, { since, until, project } = {}) {
  const from = since === undefined ? -Infinity : ms(since);
  const to = until === undefined ? Infinity : ms(until);
  const windowed = from !== -Infinity || to !== Infinity;
  const groups = new Map();
  for (const transcript of subagentTranscripts(root, false, [])) {
    const dir = relative(root, transcript).split(sep)[0];
    if (project !== undefined && dir !== project) continue;
    let description;
    try { description = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.description; } catch { continue; }
    const found = typeof description === 'string' ? TASK_DESCRIPTION.exec(description) : null;
    if (found === null) continue;
    const signals = sessionSignals(transcript, { prices: PRICES });
    const start = ms(signals.start);
    if (windowed && !(start >= from && start <= to)) continue;
    const task = `T${found[1]}`;
    const role = found[2];
    const key = `${dir}\0${task}\0${role}`;
    const row = groups.get(key) ?? { project: dir, task, role, runs: 0, usd: 0, firstAt: null };
    row.runs += 1;
    row.usd += signals.usd;
    if (signals.start !== null && (row.firstAt === null || start < ms(row.firstAt))) row.firstAt = signals.start;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => (a.project + a.task + a.role < b.project + b.task + b.role ? -1 : 1));
}

// The project directory of a working directory: every non-alphanumeric character becomes "-".
const projectDirOf = (cwd) => (typeof cwd === 'string' ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null);

// The USD of the assignment's task: the sum over the `costs` rows (subagentTaskCosts) of the assignment's project
// directory and task whose `firstAt` is from the assignment's `at` to `until` (the task's `task-review` `at`; open at
// the end when undefined). null when no row matches.
export function taskCost(assignment, costs, until) {
  const dir = projectDirOf(assignment?.cwd);
  const from = ms(assignment?.at);
  const to = until === undefined ? Infinity : ms(until);
  if (dir === null || Number.isNaN(from)) return null;
  const rows = asArray(costs).filter((c) => c?.project === dir && c.task === assignment.task && finite(ms(c.firstAt)) && ms(c.firstAt) >= from && ms(c.firstAt) <= to);
  return rows.length === 0 ? null : rows.reduce((sum, c) => sum + (finite(c.usd) ? c.usd : 0), 0);
}

// The units of a role experiment of a task role (an implementer, a reviewer: any role but the planner) in the shape
// buildRows reads: one per assignment of the experiment in `assignments` (the parsed lines of role-assignments.jsonl)
// that names a plan and a task, whose arm is one of the experiment's and whose `at` is on or after its start; of several
// lines for one plan and task the last wins. The guardrail is the clean task ("healthy" when cleanTask is true,
// "unhealthy" when false, "undecided" while the task has no review) and the cost is taskCost over the subagent rows
// under `root`, up to the task's last review.
export function taskUnits({ experiment, assignments, records, root }) {
  const role = Object.values(experiment.arms)[0]?.role;
  const start = typeof experiment.start === 'string' ? ms(experiment.start) : -Infinity;
  const last = new Map();
  for (const a of asArray(assignments)) {
    if (!isObject(a) || a.experiment !== experiment.id || a.role !== role) continue;
    if (planBase(a.plan) === null || typeof a.task !== 'string' || !Object.hasOwn(experiment.arms, a.arm)) continue;
    if (!(ms(a.at) >= start)) continue;
    last.set(`${planBase(a.plan)}/${a.task}`, a);
  }
  const units = [];
  for (const a of last.values()) {
    const clean = cleanTask({ plan: a.plan, task: a.task }, records);
    let cost = null;
    if (clean !== null) {
      const reviews = asArray(records).filter((r) => r?.kind === 'task-review' && r.task === a.task && planBase(r.plan) === planBase(a.plan));
      const until = reviews.map((r) => r.at).reduce((latest, at) => (ms(at) > ms(latest) ? at : latest));
      cost = taskCost(a, subagentTaskCosts(root, { since: a.at, until, project: projectDirOf(a.cwd) }), until);
    }
    units.push({
      arm: a.arm,
      contaminated: false,
      verdict: clean === null ? 'undecided' : clean ? 'healthy' : 'unhealthy',
      cost,
      project: typeof a.cwd === 'string' ? a.cwd : null,
      models: typeof experiment.arms[a.arm].model === 'string' ? [experiment.arms[a.arm].model] : [],
    });
  }
  return units;
}

// The tracking snapshots of `triqual tasks export --json --all` (one per registered repository); [] when the command is
// missing, fails or prints no JSON array.
export function taskSnapshots(env) {
  const res = spawnSync('triqual', ['tasks', 'export', '--json', '--all'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TASKS_TIMEOUT_MS, maxBuffer: TASKS_BUFFER,
  });
  try {
    if (res.status !== 0) return [];
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The hours of a plan from the `since` of its first task to the last close (the `since` of its last done task), from the
// `snapshots`; null when no snapshot has the plan, or no task is done.
function wallClockHours(plan, snapshots) {
  const found = asArray(snapshots).flatMap((s) => asArray(s?.plans)).find((p) => p?.name === planBase(plan));
  const tasks = asArray(found?.tasks);
  const sinces = tasks.map((t) => t?.since).filter(finite);
  const closes = tasks.filter((t) => t?.status === 'done').map((t) => t.since).filter(finite);
  if (sinces.length === 0 || closes.length === 0) return null;
  return (Math.max(...closes) - Math.min(...sinces)) / HOUR_MS;
}

// The rows of a planner experiment with two descriptive figures per arm, over the plans it counts (the units that are
// neither contaminated nor undecided): `cleanTaskRate`, the clean tasks over the reviewed tasks of those plans (null
// with no reviewed task), and `wallClockHours`, the median hours from a plan's first task to its last close (null with
// no figure). They describe; no verdict reads them.
export function planDescriptives(rows, units, { records, snapshots }) {
  return rows.map((row) => {
    const mine = units.filter((u) => u.arm === row.arm && u.contaminated !== true && u.verdict !== 'undecided');
    let reviewed = 0;
    let clean = 0;
    for (const u of mine) {
      const ids = new Set(asArray(records).filter((r) => r?.kind === 'task-review' && planBase(r.plan) === planBase(u.plan)).map((r) => r.task));
      for (const task of ids) {
        reviewed += 1;
        if (cleanTask({ plan: u.plan, task }, records)) clean += 1;
      }
    }
    const hours = mine.map((u) => wallClockHours(u.plan, snapshots)).filter(finite);
    return { ...row, cleanTaskRate: reviewed === 0 ? null : clean / reviewed, wallClockHours: hours.length === 0 ? null : median(hours) };
  });
}
