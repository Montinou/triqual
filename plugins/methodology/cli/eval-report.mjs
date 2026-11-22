// `triqual eval report [--experiment <id>] [--json]`: for each experiment of the experiments file (or the one named), the
// rows of its arms: units counted, healthy rate with its Wilson interval, cost median, the difference with the control
// and the non-inferiority verdict. A session experiment is scored by its frozen evaluator snapshot
// (<evals>/snapshots/<hash>/), never by the live taxonomy or checks. `--json` prints
// { experiments: [{ id, kind, status, margin, evaluators, rows }] }, the row format later role and skill rows share; the
// text form prints the same rows. A role experiment that was started (paused or not) has rows too: a planner experiment per plan
// (the parallelism figures, cleanTaskRate, wallClockHours), any other role per task (clean-task rate, cost per task),
// from the role-eval store, <evals>/role-assignments.jsonl and the subagent transcripts. A skill experiment has one row per arm
// from the suite runs of `triqual eval skills` (<evals>/skill-runs/<id>/<arm>.json), a case being a unit (pass = healthy, usd = cost). Prints counts, ids, model names and project names, never transcript text. It also stores, once per session and
// check version, the code verdict it computes for an assigned session whose transcript is still there
// (<evals>/judgments/<category>.jsonl, the line `triqual eval check` writes). Exit codes: 0 done; 1 a snapshot or the store that cannot be read; 2 usage, an
// invalid experiments file or an unknown experiment id.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSIGNMENTS_FILE } from './eval-arm.mjs';
import { SESSION_ARMS_FILE } from './lib/eval-arms.mjs';
import { appendPrivate } from './lib/eval-ask.mjs';
import { loadExperiments, validateExperiments } from './lib/eval-experiments.mjs';
import { ensureDir, evalsDir, experimentsPath, transcriptsRoot } from './lib/eval-paths.mjs';
import { buildRows, loadSnapshot, roleRows, sessionUnits, skillUnits } from './lib/eval-report.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { loadRoleRecords, taskSnapshots } from './lib/eval-tasks.mjs';
import { storePath, withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'report the experiments: arm rows and non-inferiority verdicts (report)';

const USAGE = [
  'usage:',
  '  triqual eval report [--experiment <id>] [--json]',
  '      For each experiment of the experiments file (or the one named), prints a row per arm: units counted (excluded:',
  '      contaminated, undecided), healthy rate with its 90% interval, cost median, the difference with the control and',
  '      the verdict (insufficient data, worse, propose, non-inferior, not cheaper, inconclusive). A session experiment is',
  '      scored by its frozen evaluator snapshot; a role experiment that was started is scored per plan (planner) or per',
  '      task (clean-task rate, cost per task). A task\'s cost is the subagents described `T<N> <role>` from its arm',
  '      assignment to its last review, in the assignment\'s project directory or, for a plan run from a worktree, any',
  '      project whose dispatch prompt names the plan. The report never refreshes the sessions store: when a session was',
  '      assigned after its newest session it says so on stderr (run `triqual eval sessions`). --json prints',
  '      { experiments: [{ id, kind, status, margin, evaluators, rows }] }.',
  '  triqual eval report --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') { opts.json = true; continue; }
    const m = /^--(experiment)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null ? '-' : String(Math.round(v * 10000) / 10000));
const pair = (ci, f) => (ci === null ? '-' : `[${f(ci[0])}, ${f(ci[1])}]`);

function textOf(e) {
  const lines = [`${e.id}  ${e.kind}  ${e.status}  margin ${e.margin}  evaluators ${e.evaluators ?? '-'}`];
  if (e.rows.length === 0) lines.push('  no rows');
  for (const r of e.rows) {
    lines.push(`  ${r.arm}${r.control ? ' (control)' : ''}  n ${r.n}  excluded: contaminated ${r.excluded.contaminated}, undecided ${r.excluded.undecided}`);
    lines.push(`    healthy ${pct(r.rate)} ${pair(r.rateCI, pct)}  cost median ${num(r.costMedian)} ${pair(r.costCI, num)}  models ${r.models.join(', ') || '-'}`);
    if (r.parallelismMedian !== null) lines.push(`    parallelism median ${num(r.parallelismMedian)} ${pair(r.parallelismCI, num)}${r.control ? '' : `  p ${num(r.p)} ${pair(r.pCI, num)}`}`);
    if (Object.hasOwn(r, 'cleanTaskRate')) lines.push(`    clean-task rate ${pct(r.cleanTaskRate)}  wall-clock hours ${num(r.wallClockHours)}`);
    if (!r.control) {
      lines.push(`    d ${num(r.d)} ${pair(r.dCI, num)}  c ${num(r.c)} ${pair(r.cCI, num)}  required ${r.required ?? '-'}  verdict: ${r.verdict}`);
    }
    for (const [project, p] of Object.entries(r.perProject)) {
      lines.push(`    ${project}  n ${p.n}  healthy ${pct(p.rate)}  cost median ${num(p.costMedian)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, platform = process.platform, now = () => new Date(),
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval report: ${m}\n${USAGE}`); return 2; };
  const refuse = (m) => { stderr.write(`triqual eval report: ${m}\n`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval report: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);

  const home = env.HOME || homedir();
  const evals = evalsDir(env, home);
  let list;
  try {
    list = loadExperiments(experimentsPath(env, home));
  } catch {
    return refuse('experiments file: unreadable or not JSON');
  }
  const checked = validateExperiments(list);
  if (!checked.ok) return refuse(`invalid experiments file: ${checked.field}`);
  let chosen = list;
  if (opts.experiment !== undefined) {
    chosen = list.filter((e) => e.id === opts.experiment);
    if (chosen.length === 0) return refuse(`no experiment ${clip(opts.experiment)}`);
  }

  const out = [];
  let sessions = null;
  let staleNoted = false;
  let judgments = null;
  let armRecords = null;
  let roleRecords = null;
  let assignments = null;
  let snapshots = null;
  const root = transcriptsRoot(env, home);
  for (const e of chosen) {
    let rows = [];
    // Only a started session experiment has units: its snapshot is where its evaluators are frozen.
    if (e.kind === 'session' && typeof e.evaluators === 'string' && e.evaluators !== '') {
      let snapshot;
      try {
        snapshot = await loadSnapshot(join(evals, 'snapshots', e.evaluators));
      } catch {
        return fail(`${e.id}: snapshot ${clip(e.evaluators)} could not be read under ${join(evals, 'snapshots')}`);
      }
      sessions ??= readJsonl(join(evals, 'sessions.jsonl')).rows.filter((r) => typeof r.sessionId === 'string');
      armRecords ??= readJsonl(join(evals, SESSION_ARMS_FILE)).rows;
      judgments ??= {};
      for (const c of snapshot.categories) {
        if (!Object.hasOwn(judgments, c.id)) judgments[c.id] = readJsonl(join(evals, 'judgments', `${c.id}.jsonl`)).rows;
      }
      // The code verdict of an assigned session is stored while its transcript is still there (the sessions store
      // outlives the 30-day cleanup): one line per session and check version, as `triqual eval check` writes it, so a
      // second report run, or one after the cleanup, scores the same session.
      const onCode = ({ sessionId, category, result, promptHash }) => {
        if (result === 'undecided') return;
        const file = join(evals, 'judgments', `${category}.jsonl`);
        try {
          ensureDir(join(evals, 'judgments'));
          withStoreLock(`${file}.lock`, () => {
            const rows = readJsonl(file).rows;
            if (rows.some((r) => r.sessionId === sessionId && r.promptHash === promptHash)) return;
            const line = { sessionId, category, result, promptHash, model: null, auth: 'code', at: new Date(now()).toISOString() };
            appendPrivate(file, line);
            judgments[category] = [...rows, line];
          });
        } catch { /* storing is a convenience: a store that cannot be written never stops the report */ }
      };
      let units;
      try {
        units = sessionUnits({
          sessions, experiment: e, snapshot, judgments, home, platform, armRecords, onCode,
          file: (s) => (typeof s.projectDir === 'string' ? join(root, s.projectDir, `${s.sessionId}.jsonl`) : null),
        });
      } catch (err) {
        // A check of the frozen snapshot that throws: only its error name is printed, never its message.
        return fail(`${e.id}: a check of snapshot ${clip(e.evaluators)} could not be run (${err?.code ?? err?.name ?? 'error'})`);
      }
      rows = buildRows(units, e);
      // The report reads the sessions store and never refreshes it (`eval sessions` and `eval improve` do): a session
      // assigned after the store's newest session is not counted yet, so say so once.
      if (!staleNoted) {
        staleNoted = true;
        const latest = (rows2, key) => rows2.map((r) => r?.[key]).filter((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
          .reduce((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);
        const storeEnd = latest(sessions, 'end');
        const assigned = latest(armRecords, 'at');
        if (assigned !== null && (storeEnd === null || Date.parse(assigned) > Date.parse(storeEnd))) {
          stderr.write(`triqual eval report: the sessions store ends ${storeEnd ?? 'empty'}; a session was assigned ${assigned}: run \`triqual eval sessions\` to refresh it\n`);
        }
      }
    }
    // A role experiment that was started (it has evaluators, as a session experiment does), paused or not: its planner
    // or task rows.
    if (e.kind === 'role' && typeof e.evaluators === 'string' && e.evaluators !== '') {
      roleRecords ??= loadRoleRecords(storePath(env, home).file);
      assignments ??= readJsonl(join(evals, ASSIGNMENTS_FILE)).rows;
      if (Object.values(e.arms)[0]?.role === 'planner') snapshots ??= taskSnapshots(env);
      rows = roleRows({ experiment: e, records: roleRecords, assignments, root, snapshots });
    }
    // A skill experiment has rows once a suite run of its arms is written (`triqual eval skills`).
    if (e.kind === 'skill') {
      const units = skillUnits({ evalsDir: evals, experiment: e });
      if (units.length > 0) rows = buildRows(units, e);
    }
    out.push({ id: e.id, kind: e.kind, status: e.status, margin: e.margin, evaluators: e.evaluators ?? null, rows });
  }

  if (opts.json) stdout.write(`${JSON.stringify({ experiments: out }, null, 2)}\n`);
  else stdout.write(out.length === 0 ? 'no experiments\n' : out.map(textOf).join(''));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
