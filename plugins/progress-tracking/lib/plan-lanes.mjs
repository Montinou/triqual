// The lane check of a plan (`triqual plan lanes`): for each phase its lanes, parents and dependencies are compared with
// what the phase needs, and the critical path and parallelism of each phase and of the plan are computed. Pure: no I/O.
import { PlanError, readPhases, readTasks } from './plan.mjs';

const RUNNER = /\b(pytest|vitest|jest|mocha|rspec|phpunit|go test|cargo test|test runner)\b/i;
const NO_TASK = 'no ### Task heading: not a plan';

const asc = (a, b) => a - b;
const names = (phases) => phases.map((k) => `P${k}`).join(', ');
const pathsOf = (task) => [...task.files.create, ...task.files.modify, ...task.files.test];
const ratio = (tasks, path) => (path === 0 ? 0 : tasks / path);

// { plan, tasks, phases, parallelism, criticalPath, runnerOnly, landingTest, violations, phaseRows } (see the task brief for
// the fields). Throws the parser's PlanError, and PlanError(NO_TASK) when the text has no task.
export function planLanes(text, stem) {
  const tasks = readTasks(text);
  if (tasks.length === 0) throw new PlanError(NO_TASK);
  const { phases, landingTest } = readPhases(text, stem);

  const byId = new Map(tasks.map((t, i) => [t.id, { ...t, index: i }]));
  const phaseOf = new Map(phases.flatMap((p) => p.tasks.map((id) => [id, p.n])));
  const byN = new Map(phases.map((p) => [p.n, p]));
  // A dependency counts only when it names a task that comes earlier in the plan.
  const depsOf = (task) => task.deps.filter((d) => byId.has(d) && byId.get(d).index < byId.get(task.id).index);

  const ancestorsOf = (n) => {
    const seen = new Set();
    const walk = (k) => {
      for (const parent of byN.get(k)?.parents ?? []) {
        if (!seen.has(parent)) { seen.add(parent); walk(parent); }
      }
    };
    walk(n);
    return seen;
  };

  const rows = [];
  const detail = []; // per phase: { phase, own tasks, frontier }
  for (const phase of phases) {
    const own = phase.tasks.map((id) => byId.get(id));
    const needs = new Set();
    const pathOwners = new Map(); // path -> earlier phases holding it
    for (const q of phases) {
      if (q.n >= phase.n) break;
      for (const id of q.tasks) for (const p of pathsOf(byId.get(id))) pathOwners.set(p, (pathOwners.get(p) ?? new Set()).add(q.n));
    }
    for (const task of own) {
      for (const dep of depsOf(task)) if (phaseOf.get(dep) < phase.n) needs.add(phaseOf.get(dep));
      for (const p of pathsOf(task)) for (const q of pathOwners.get(p) ?? []) needs.add(q);
    }
    const frontier = [...needs].filter((q) => ![...needs].some((o) => o !== q && ancestorsOf(o).has(q))).sort(asc);

    const depth = new Map();
    for (const task of own) {
      depth.set(task.id, 1 + Math.max(0, ...depsOf(task).filter((d) => depth.has(d)).map((d) => depth.get(d))));
    }
    const critical = Math.max(0, ...depth.values());
    rows.push({
      n: phase.n,
      tasks: own.length,
      lanes: new Set(own.map((t) => t.lane).filter(Boolean)).size,
      sequential: Boolean(phase.sequentialBecause),
      reason: phase.sequentialBecause || null,
      parents: [...phase.parents],
      frontier,
      criticalPath: critical,
      parallelism: ratio(own.length, critical),
    });
    detail.push({ phase, own, frontier });
  }

  const violations = [];
  const add = (code, phase, task, message) => violations.push({ code, phase, task, message });
  const phased = phases.length >= 2;
  for (const { phase, own, frontier } of detail) {
    const n = phase.n;
    const f = frontier.length > 0 ? names(frontier) : 'trunk';
    if (phased) {
      if (!phase.parentDeclared) add('no-parent', n, null, `P${n} has no **Parent:** line: write **Parent:** ${f}`);
      else if (phase.parent.kind !== 'branch') {
        for (const k of phase.parents.filter((k) => !frontier.includes(k))) {
          add('false-parent', n, null, `P${n} names P${k} as a parent but does not need it: write **Parent:** ${f}`);
        }
        for (const q of frontier.filter((q) => !phase.parents.includes(q) && !phase.parents.some((k) => ancestorsOf(k).has(q)))) {
          add('missing-parent', n, null, `P${n} needs P${q} but neither names it nor descends from it: write **Parent:** ${f}`);
        }
      }
    }
    const withLane = own.filter((t) => t.lane);
    if (own.length >= 2 && !phase.sequentialBecause && withLane.length < own.length) {
      add('no-lanes', n, null, `P${n} has ${own.length} tasks and ${own.length - withLane.length} without a **Lane:** line: lay them out in lanes, or write **Sequential because:** with the fact that forces one chain`);
    }
    const laneOfPath = new Map();
    for (const task of withLane) {
      for (const p of pathsOf(task)) {
        const lanes = laneOfPath.get(p) ?? [];
        if (!lanes.includes(task.lane)) lanes.push(task.lane);
        laneOfPath.set(p, lanes);
      }
    }
    for (const [p, lanes] of laneOfPath) {
      if (lanes.length > 1) add('lane-files', n, null, `P${n} lists ${p} in lanes ${lanes.join(', ')}: give the file one owner lane`);
    }
    const allLanes = new Set(withLane.map((t) => t.lane));
    for (const task of withLane) {
      const deps = depsOf(task).map((d) => byId.get(d)).filter((d) => phaseOf.get(d.id) === n && d.lane);
      const others = [...allLanes].filter((l) => l !== task.lane);
      if (others.every((l) => deps.some((d) => d.lane === l))) continue;
      for (const dep of deps.filter((d) => d.lane !== task.lane)) {
        add('lane-depends', n, task.id, `${task.id} (lane ${task.lane}) depends on ${dep.id} (lane ${dep.lane}): put both in one lane, or make ${task.id} the closing task that depends on every lane`);
      }
    }
  }
  if (phased) {
    const named = new Set(phases.flatMap((p) => p.parents));
    const tops = phases.map((p) => p.n).filter((k) => !named.has(k));
    if (tops.length > 1) add('several-tops', null, null, `${names(tops)} are the parent of no phase: a plan ends in one phase; make the last one a join (**Parent:** ${names(tops)})`);
  }

  const best = new Map();
  for (const row of rows) {
    best.set(row.n, row.criticalPath + Math.max(0, ...row.parents.filter((k) => best.has(k)).map((k) => best.get(k))));
  }
  const criticalPath = Math.max(0, ...best.values());
  const runnerOnly = landingTest !== null ? 0 : phases.filter((p) => RUNNER.test(p.sequentialBecause ?? '')).length;
  return {
    plan: stem,
    tasks: tasks.length,
    phases: phases.length,
    parallelism: ratio(tasks.length, criticalPath),
    criticalPath,
    runnerOnly,
    landingTest: landingTest !== null,
    violations,
    phaseRows: rows,
  };
}
