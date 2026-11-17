// `triqual eval report [--experiment <id>] [--json]`: for each experiment of the experiments file (or the one named), the
// rows of its arms: units counted, healthy rate with its Wilson interval, cost median, the difference with the control
// and the non-inferiority verdict. A session experiment is scored by its frozen evaluator snapshot
// (<evals>/snapshots/<hash>/), never by the live taxonomy or checks. `--json` prints
// { experiments: [{ id, kind, status, margin, evaluators, rows }] }, the row format later role and skill rows share; the
// text form prints the same rows. Role and skill experiments have no rows yet. Prints counts, ids, model names and
// project names, never transcript text. Exit codes: 0 done; 1 a snapshot or the store that cannot be read; 2 usage, an
// invalid experiments file or an unknown experiment id.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SESSION_ARMS_FILE } from './lib/eval-arms.mjs';
import { loadExperiments, validateExperiments } from './lib/eval-experiments.mjs';
import { evalsDir, experimentsPath, transcriptsRoot } from './lib/eval-paths.mjs';
import { buildRows, loadSnapshot, sessionUnits } from './lib/eval-report.mjs';
import { readJsonl } from './lib/eval-store.mjs';

export const SUMMARY = 'report the experiments: arm rows and non-inferiority verdicts (report)';

const USAGE = [
  'usage:',
  '  triqual eval report [--experiment <id>] [--json]',
  '      For each experiment of the experiments file (or the one named), prints a row per arm: units counted (excluded:',
  '      contaminated, undecided), healthy rate with its 90% interval, cost median, the difference with the control and',
  '      the verdict (insufficient data, worse, propose, non-inferior, not cheaper, inconclusive). A session experiment is',
  '      scored by its frozen evaluator snapshot. --json prints { experiments: [{ id, kind, status, margin, evaluators,',
  '      rows }] }.',
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
  env = process.env, stdout = process.stdout, stderr = process.stderr, platform = process.platform,
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
  let judgments = null;
  let armRecords = null;
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
      const units = sessionUnits({
        sessions, experiment: e, snapshot, judgments, home, platform, armRecords,
        file: (s) => (typeof s.projectDir === 'string' ? join(root, s.projectDir, `${s.sessionId}.jsonl`) : null),
      });
      rows = buildRows(units, e);
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
