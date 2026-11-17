#!/usr/bin/env node
// The parallelism a plan's run achieved, read from the time lines of the workspace ledger. Read-only: it reads the plan and the
// ledger, asks `triqual plan lanes` what the layout planned, and writes nothing.
//
// Usage: timeline.mjs PLAN_FILE
// Prints text:
//   no timeline                       alone, when the ledger has no `Opened:` / `Closed:` line
//   plan <stem>: wall-clock <W> min, task time <S> min, achieved <A>, <K> at once, planned: <P>
//   open: T<n> since <time>           one per window opened and never closed, in ledger order
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
// layout violations) and prints an object with a finite `parallelism`; otherwise `unknown`.
//
// Exit codes: 0 printed (also with no time lines), 2 usage / no such plan file / malformed plan, 3 refused (the plan has no
// ledger), 1 any other failure (`timeline: <message>`). Node built-ins and the files next to it only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import * as common from './lib/task-common.mjs';
import { PlanError, readPhases } from './lib/plan.mjs';

const { ScriptError, EXIT_USAGE, EXIT_REFUSED, EXIT_OTHER } = common;

const USAGE = 'usage: timeline.mjs PLAN_FILE';
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const TIME_LINE = /^(Opened|Closed): T(\d+) (\S+)\s*$/;
const MINUTE_MS = 60000;

const skip = (line) => process.stderr.write(`timeline: skipped ${line}\n`);

// The `parallelism` the layout planned, else 'unknown'.
function planned(planFile) {
  const res = spawnSync('triqual', ['plan', 'lanes', planFile, '--json'], { encoding: 'utf8' });
  if (res.error || (res.status !== 0 && res.status !== 1)) return 'unknown';
  try {
    const out = JSON.parse(res.stdout);
    if (out !== null && typeof out === 'object' && !Array.isArray(out) && typeof out.parallelism === 'number' && Number.isFinite(out.parallelism)) {
      return out.parallelism.toFixed(2);
    }
  } catch {
    // not JSON: unknown
  }
  return 'unknown';
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
  try {
    readPhases(text, stem);
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
  const wall = closed.length === 0 ? 0 : (Math.max(...closed.map((w) => w.close)) - Math.min(...closed.map((w) => w.open))) / MINUTE_MS;
  const sum = closed.reduce((total, w) => total + (w.close - w.open), 0) / MINUTE_MS;
  const achieved = wall === 0 ? 0 : sum / wall;
  return `${[
    `plan ${stem}: wall-clock ${wall.toFixed(1)} min, task time ${sum.toFixed(1)} min, achieved ${achieved.toFixed(2)}, ${atOnce(closed)} at once, planned: ${planned(plan)}`,
    ...open.map((w) => `open: T${w.n} since ${w.time}`),
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
