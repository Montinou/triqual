// `triqual eval arm --kind role --role <R> (--key <k> | --plan <P> --task T<N>)`: which arm of the active role experiment
// for <R> a unit of work belongs to, for the planner dispatch and the orchestrator to choose the model. Prints `none`
// when no experiment is active for the role (nothing is written); else `<experiment>/<arm> <model> <effort>` and appends
// { key, plan, task, role, experiment, arm, model, effort, cwd, at } to <evals>/role-assignments.jsonl once per (key, role, experiment).
// The key is --key, or `<plan base name>/T<N>` with --plan and --task. Exit codes: 0 done; 1 an unreadable experiments
// file or a write failure; 2 usage (both key forms, or neither).
// Prints ids and model names, never transcript text. node: built-ins only. main() is exported for tests and runs only when
// this file is the entry point.
import { appendFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDir, evalsDir, experimentsPath } from './lib/eval-paths.mjs';
import { armFor, loadExperiments } from './lib/eval-experiments.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'the arm of a role experiment for a role and key (arm)';

// The file, inside the evals directory, the assignments are appended to.
export const ASSIGNMENTS_FILE = 'role-assignments.jsonl';

const TASK = /^T[0-9]+$/;
const FLAGS = new Set(['--kind', '--role', '--key', '--plan', '--task']);

const USAGE = [
  'usage:',
  '  triqual eval arm --kind role --role <role> --key <key>',
  '  triqual eval arm --kind role --role <role> --plan <plan file> --task T<N>',
  '      Prints "none" when no role experiment is active for <role>; else "<experiment>/<arm> <model> <effort>" and records',
  '      the assignment once per (key, role, experiment) in <evals>/role-assignments.jsonl. The key of the second form is',
  '      "<plan base name>/T<N>". Exit 0; 2 on usage (both key forms, or neither).',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

// { values } of the `--flag value` pairs of `argv`, or { problem }.
function parse(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) return { problem: `unknown argument ${clip(flag)}` };
    const value = argv[i + 1];
    if (value === undefined || value === '' || FLAGS.has(value)) return { problem: `${flag} needs a value` };
    if (Object.hasOwn(values, flag)) return { problem: `${flag} given twice` };
    values[flag] = value;
    i += 1;
  }
  return { values };
}

// Appends `row` unless a line of the same (key, role, experiment) is already there; the read and the append are one step under a lock.
function recordOnce(file, row) {
  withStoreLock(`${file}.lock`, () => {
    let existing = '';
    try { existing = readFileSync(file, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    for (const line of existing.split('\n')) {
      if (line === '') continue;
      let seen;
      try { seen = JSON.parse(line); } catch { continue; }
      if (seen?.key === row.key && seen?.role === row.role && seen?.experiment === row.experiment) return;
    }
    const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${lead}${JSON.stringify(row)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  });
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), now = () => new Date(),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const usage = (m) => { stderr.write(`triqual eval arm: ${m}\n${USAGE}`); return 2; };
  const parsed = parse(argv);
  if (parsed.problem) return usage(parsed.problem);
  const v = parsed.values;
  if (v['--kind'] !== 'role') return usage('--kind role is required');
  if (v['--role'] === undefined) return usage('--role is required');
  const byKey = v['--key'] !== undefined;
  const byPlan = v['--plan'] !== undefined || v['--task'] !== undefined;
  if (byKey && byPlan) return usage('give --key, or --plan with --task, not both');
  if (!byKey && !byPlan) return usage('give --key, or --plan with --task');
  let plan = null;
  let task = null;
  let key = v['--key'];
  if (!byKey) {
    if (v['--plan'] === undefined || v['--task'] === undefined) return usage('--plan and --task go together');
    if (!TASK.test(v['--task'])) return usage('--task must look like T<N>');
    plan = basename(v['--plan']);
    task = v['--task'];
    key = `${plan}/${task}`;
  }

  const role = v['--role'];
  const home = env.HOME || homedir();
  let hit;
  try {
    hit = armFor('role', key, { experiments: loadExperiments(experimentsPath(env, home)), target: role });
  } catch (err) {
    stderr.write(`triqual eval arm: experiments file: unreadable or invalid (${err?.code ?? 'error'})\n`);
    return 1;
  }
  if (!hit) { stdout.write('none\n'); return 0; }

  const { experiment, arm, payload } = hit;
  const model = payload?.model ?? null;
  const effort = payload?.effort ?? null;
  try {
    const dir = evalsDir(env, home);
    ensureDir(dir);
    recordOnce(join(dir, ASSIGNMENTS_FILE), {
      key, plan, task, role, experiment: experiment.id, arm, model, effort, cwd, at: now().toISOString(),
    });
  } catch (err) {
    stderr.write(`triqual eval arm: could not record the assignment (${err?.code ?? 'error'})\n`);
    return 1;
  }
  stdout.write(`${experiment.id}/${arm} ${model} ${effort}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
