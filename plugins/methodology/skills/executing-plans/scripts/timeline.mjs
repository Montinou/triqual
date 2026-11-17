#!/usr/bin/env node
// The parallelism a plan's run achieved, read from the time lines of the workspace ledger. Read-only: it reads the plan and the
// ledger, asks `triqual plan lanes` what the layout planned, and writes nothing.
//
// Usage: timeline.mjs PLAN_FILE
// Prints text:
//   no timeline                       alone, when the ledger has no `Opened:` / `Closed:` line
//   plan <stem>: wall-clock <W> min, task time <S> min, achieved <A>, <K> at once, planned: <P>
//   P<n>: wall-clock ..., planned: <P>   one row per phase in plan order, in the plan line's form over the closed windows of
//                                     that phase's tasks (`P<n>: no timeline` when it has none); only for a plan of 2+ phases
//   phase windows: <M> phases at once    (`1 phase at once`) the most closed phase windows, `startedAt` to `doneAt` of the stack
//                                     state, open at one instant; `phase windows: unknown` with no state file
//   open: T<n> since <time>           one per window opened and never closed, in ledger order
//   open: P<n> since <startedAt>      one per phase with a `startedAt` and no `doneAt` (2+ phases), after the task `open:` lines
//   Serial: ...                       every `Serial:` line as written, in ledger order
//
// Lines read (the form task-open and task-close write): `Opened: T<n> <time>`, `Closed: T<n> <time>` (a time is UTC
// YYYY-MM-DDTHH:MM:SSZ) and `Serial: ...`. A window is a task's `Opened:` to its next `Closed:`; a reopened task has one window per
// pair. A time that is not a time, an `Opened:` while the task's window is open, and a `Closed:` with no open window or earlier than
// its `Opened:` are skipped, each with `timeline: skipped <line>` on stderr. A window never closed is open and left out of every
// sum. Over the closed windows: wall-clock = last close - first open, task time = the sum of the windows, achieved = task time /
// wall-clock (0 when the wall-clock is 0) and at once = the most windows open at one instant (a window that closes when another
// opens does not count as both).
// Planned is the `parallelism` of `triqual plan lanes PLAN_FILE --json`, read when that command exits 0 or 1 (1: the plan has
// layout violations) and prints an object with a finite `parallelism`; otherwise `unknown`. A phase row's planned is the
// `parallelism` of the `phaseRows` entry with its `n`, else `unknown`. A phase time of the state that is not an ISO time, or a
// `doneAt` earlier than its `startedAt`, is skipped with `timeline: skipped P<n> <field> <value>` on stderr.
//
// Exit codes: 0 printed (also with no time lines), 2 usage / no such plan file / malformed plan, 3 refused (the plan has no
// ledger), 1 any other failure (`timeline: <message>`). Node built-ins and the files next to it only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import * as common from './lib/task-common.mjs';
import { PlanError, readPhases } from './lib/plan.mjs';
import { readState, statePath } from './stack.mjs';

const { ScriptError, EXIT_USAGE, EXIT_REFUSED, EXIT_OTHER } = common;

const USAGE = 'usage: timeline.mjs PLAN_FILE';
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const TIME_LINE = /^(Opened|Closed): T(\d+) (\S+)\s*$/;
const MINUTE_MS = 60000;

const skip = (line) => process.stderr.write(`timeline: skipped ${line}\n`);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const parallelismOf = (value) => (isObject(value) && typeof value.parallelism === 'number' && Number.isFinite(value.parallelism) ? value.parallelism.toFixed(2) : 'unknown');

// What the layout planned: { plan: the `parallelism` or 'unknown', phase(n): that phase row's `parallelism` or 'unknown' }.
function planned(planFile) {
  const res = spawnSync('triqual', ['plan', 'lanes', planFile, '--json'], { encoding: 'utf8' });
  let out = null;
  if (!res.error && (res.status === 0 || res.status === 1)) {
    try {
      out = JSON.parse(res.stdout);
    } catch {
      // not JSON: unknown
    }
  }
  const rows = isObject(out) && Array.isArray(out.phaseRows) ? out.phaseRows : [];
  return { plan: parallelismOf(out), phase: (n) => parallelismOf(rows.find((row) => isObject(row) && row.n === n)) };
}

// { closed: [{ n, open, close }] (ms), open: [{ n, time }] } from the ledger lines; lines that cannot be windows are skipped.
function windowsOf(lines) {
  const closed = [];
  const open = new Map();
  for (const line of lines) {
    const m = TIME_LINE.exec(line);
    if (!m) continue;
    const [, kind, number, time] = m;
    const n = Number(number);
    const ms = ISO_TIME.test(time) ? Date.parse(time) : NaN;
    if (Number.isNaN(ms)) {
      skip(line);
    } else if (kind === 'Opened') {
      if (open.has(n)) skip(line);
      else open.set(n, { time, ms });
    } else if (!open.has(n) || ms < open.get(n).ms) {
      skip(line);
    } else {
      closed.push({ n, open: open.get(n).ms, close: ms });
      open.delete(n);
    }
  }
  return { closed, open: [...open].map(([n, { time }]) => ({ n, time })) };
}

// The most windows open at one instant: at equal times the closes come before the opens.
function atOnce(windows) {
  const events = windows.flatMap((w) => [[w.open, 1], [w.close, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let most = 0;
  for (const [, delta] of events) {
    now += delta;
    most = Math.max(most, now);
  }
  return most;
}

// The sums of a set of closed windows, in the form of the plan line (and of a phase row).
function row(windows, plannedValue) {
  const wall = windows.length === 0 ? 0 : (Math.max(...windows.map((w) => w.close)) - Math.min(...windows.map((w) => w.open))) / MINUTE_MS;
  const sum = windows.reduce((total, w) => total + (w.close - w.open), 0) / MINUTE_MS;
  const achieved = wall === 0 ? 0 : sum / wall;
  return `wall-clock ${wall.toFixed(1)} min, task time ${sum.toFixed(1)} min, achieved ${achieved.toFixed(2)}, ${atOnce(windows)} at once, planned: ${plannedValue}`;
}

// { closed: [{ open, close }] (ms), open: [{ n, time }] } from the state's phase times; a time that is not ISO is skipped.
function phaseWindows(state, phases) {
  const closed = [];
  const open = [];
  for (const { n } of phases) {
    const entry = Array.isArray(state.phases) ? state.phases.find((p) => isObject(p) && p.n === n) : undefined;
    if (!entry) continue;
    const times = {};
    for (const field of ['startedAt', 'doneAt']) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      const ms = typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : NaN;
      if (Number.isNaN(ms)) skip(`P${n} ${field} ${value}`);
      else times[field] = { ms, value };
    }
    if (times.startedAt && times.doneAt && times.doneAt.ms < times.startedAt.ms) {
      skip(`P${n} doneAt ${times.doneAt.value}`);
    } else if (times.startedAt && times.doneAt) {
      closed.push({ open: times.startedAt.ms, close: times.doneAt.ms });
    } else if (times.startedAt && (entry.doneAt === undefined || entry.doneAt === null)) {
      open.push({ n, time: times.startedAt.value });
    }
  }
  return { closed, open };
}

function main(args) {
  const [plan, ...extra] = args;
  if (!plan || extra.length > 0) throw new ScriptError(EXIT_USAGE, USAGE);
  let text;
  try {
    text = readFileSync(plan, 'utf8');
  } catch {
    throw new ScriptError(EXIT_USAGE, `no such plan file: ${plan}`);
  }
  const stem = basename(plan, '.md');
  let phases;
  try {
    ({ phases } = readPhases(text, stem));
  } catch (e) {
    if (e instanceof PlanError) throw new ScriptError(EXIT_USAGE, `${plan}: ${e.message}`);
    throw e;
  }
  const workspace = common.workspaceOf(plan);
  const ledgerFile = join(workspace, 'sdd-ledger.md');
  if (!existsSync(ledgerFile)) throw new ScriptError(EXIT_REFUSED, `no ledger at ${ledgerFile}: nothing to time`);
  const lines = common.ledgerLines(workspace);

  if (!lines.some((l) => TIME_LINE.test(l))) return 'no timeline\n';
  const { closed, open } = windowsOf(lines);
  const layout = planned(plan);
  const phaseLines = [];
  const phaseOpen = [];
  if (phases.length >= 2) {
    for (const phase of phases) {
      const own = closed.filter((w) => phase.tasks.includes(`T${w.n}`));
      phaseLines.push(own.length === 0 ? `P${phase.n}: no timeline` : `P${phase.n}: ${row(own, layout.phase(phase.n))}`);
    }
    const state = readState(statePath(common.git(['rev-parse', '--show-toplevel']), plan));
    if (state === null) {
      phaseLines.push('phase windows: unknown');
    } else {
      const windows = phaseWindows(state, phases);
      const most = atOnce(windows.closed);
      phaseLines.push(`phase windows: ${most} ${most === 1 ? 'phase' : 'phases'} at once`);
      phaseOpen.push(...windows.open.map((w) => `open: P${w.n} since ${w.time}`));
    }
  }
  return `${[
    `plan ${stem}: ${row(closed, layout.plan)}`,
    ...phaseLines,
    ...open.map((w) => `open: T${w.n} since ${w.time}`),
    ...phaseOpen,
    ...lines.filter((l) => l.startsWith('Serial: ')),
  ].join('\n')}\n`;
}

try {
  process.stdout.write(main(process.argv.slice(2)));
} catch (e) {
  const err = e instanceof ScriptError ? e : new ScriptError(EXIT_OTHER, `timeline: ${e.message}`);
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.code;
}
