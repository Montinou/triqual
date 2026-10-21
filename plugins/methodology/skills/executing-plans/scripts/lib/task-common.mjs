// What task-open, task-prep and task-close share: the workspace and its ledger, the failure contract, the tracking calls and the plan's
// tasks. Plain Node, node: built-ins and the plan reader next to it only.
//
// Failure contract (every script of the thin controller): exit 0 ok, 2 usage, 3 refused precondition, 1 any other
// failure; the one-line cause goes to stderr and, once the plan's workspace exists, `Error: <step> T<N> — exit <code> —
// <first line of the cause>` is appended to `<workspace>/sdd-ledger.md` before the script exits. Nothing is retried,
// defaulted or swallowed: a step that cannot run throws a ScriptError, and the script's one catch turns it into `fail`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanError, readTasks } from './plan.mjs';

import { TIERS } from './plan.mjs';

export { TIERS };

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'sdd-ledger.md';
export const EXIT_OTHER = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

// A failed step with the exit code the script ends with.
export class ScriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

const firstLine = (text) => String(text).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

// Print `message` on stderr, append the `Error:` line when the workspace is known, and exit `code`.
export function fail(step, n, code, message, workspace) {
  process.stderr.write(`${message}\n`);
  if (workspace) {
    try {
      appendLedger(workspace, `Error: ${step} T${n} — exit ${code} — ${firstLine(message) || `exit ${code}`}`);
    } catch (e) {
      process.stderr.write(`${step}: cannot write the Error line to the ledger: ${e.message}\n`);
    }
  }
  process.exit(code);
}

// ---- processes ----

// Run a command with its output captured. A command that cannot start is a ScriptError; the exit status is the caller's.
export function exec(command, args) {
  const res = spawnSync(command, args, { encoding: 'utf8' });
  if (res.error) throw new ScriptError(EXIT_OTHER, `cannot run ${basename(command)}: ${res.error.message}`);
  return { status: res.status ?? EXIT_OTHER, stdout: res.stdout, stderr: res.stderr };
}

// A sibling script of the skill, by its interpreter (some extractors drop exec bits).
export const runScript = (name, args) => exec(process.execPath, [join(SCRIPTS, name), ...args]);

// A failed sibling script: its exit 2 or 3 stands, anything else is a plain failure.
export function scriptError(label, res) {
  const code = res.status === EXIT_USAGE || res.status === EXIT_REFUSED ? res.status : EXIT_OTHER;
  return new ScriptError(code, `${label}: ${firstLine(res.stderr) || `exited ${res.status}`}`);
}

export function git(args) {
  const res = exec('git', args);
  if (res.status !== 0) throw new ScriptError(EXIT_OTHER, `git ${args[0]}: ${firstLine(res.stderr) || `exited ${res.status}`}`);
  return res.stdout.trim();
}

// The commit a revision names, or null when it names none.
export function commitOf(revision) {
  const res = exec('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

// Scripts run from the main checkout: in a linked worktree the git dir differs from the common dir.
export function assertMainCheckout() {
  const res = exec('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (res.status !== 0) throw new ScriptError(EXIT_USAGE, 'not inside a git repository');
  const [gitDir, commonDir] = res.stdout.split('\n');
  if (gitDir !== commonDir) throw new ScriptError(EXIT_REFUSED, 'run from the main checkout');
}

// ---- the workspace and its ledger ----

export function workspaceOf(planFile) {
  const res = runScript('sdd-workspace', [planFile]);
  if (res.status !== 0) throw scriptError('sdd-workspace', res);
  return res.stdout.replace(/\n+$/, '');
}

export function appendLedger(workspace, line) {
  if (/[\r\n]/.test(line)) throw new Error('a ledger line is one line');
  const file = join(workspace, LEDGER);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
}

export function ledgerLines(workspace) {
  const file = join(workspace, LEDGER);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : [];
}

// The sha of the last `BASE: T<N> <sha>` line, else null.
export function lastBase(lines, n) {
  const re = new RegExp(`^BASE: T${n} (\\S+)\\s*$`);
  const hits = lines.map((l) => re.exec(l)).filter(Boolean);
  return hits.length ? hits.at(-1)[1] : null;
}

// ---- the plan ----

// `3` or `T3` -> 3; anything else null.
export function taskNumber(arg) {
  const m = /^T?(\d+)$/.exec(arg ?? '');
  return m ? Number(m[1]) : null;
}

// The plan's lines and the task `n` in them ({id, title, start, end, tier, ...} from the shared reader).
export function readPlanTask(planFile, n) {
  let text;
  try {
    text = readFileSync(planFile, 'utf8');
  } catch {
    throw new ScriptError(EXIT_USAGE, `no such plan file: ${planFile}`);
  }
  let tasks;
  try {
    tasks = readTasks(text);
  } catch (e) {
    if (e instanceof PlanError) throw new ScriptError(EXIT_USAGE, `${planFile}: ${e.message}`);
    throw e;
  }
  const task = tasks.find((t) => t.id === `T${n}`);
  if (!task) throw new ScriptError(EXIT_REFUSED, `task ${n} not found in ${planFile} (no heading matching 'Task ${n}')`);
  return { task, lines: text.split('\n') };
}

// The plain line directly under the task's `**Tier:**` line (outside a fence), else null. `planTask` is readPlanTask's result.
export function reasonLine({ task, lines }) {
  let fenced = false;
  for (let i = task.start - 1; i < task.end; i++) {
    if (/^(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced || !/^\*\*Tier:\*\*/.test(lines[i])) continue;
    const next = (lines[i + 1] ?? '').trim();
    return next === '' || next.startsWith('**') ? null : next;
  }
  return null;
}

// The hunter categories of a heavy first round: `correctness` plus `state` for a Live state or Contract reason, else `security`.
export const hunterPick = (reason) => `correctness,${/^(live state|contract)\b/i.test(reason ?? '') ? 'state' : 'security'}`;

// The tier of the last `Tier: T<N> <tier>` / `Tier raised: T<N> <from> → <to>` line of the task, else null.
export function ledgerTier(lines, n) {
  const tierPattern = TIERS.join('|');
  const re = new RegExp(`^(?:Tier: T${n} (${tierPattern})\\b|Tier raised: T${n} \\S+ → (${tierPattern})\\b)`);
  const hits = lines.map((l) => re.exec(l)).filter(Boolean);
  return hits.length ? hits.at(-1)[1] ?? hits.at(-1)[2] : null;
}

// ---- tracking (the `triqual tasks` ledger) ----

const triqualError = (label, res) => new ScriptError(
  res.status === EXIT_USAGE ? EXIT_REFUSED : EXIT_OTHER,
  `${label}: ${firstLine(res.stderr) || `exited ${res.status}`}`,
);

function triqualJson(args) {
  const label = `triqual ${args.join(' ')}`;
  const res = exec('triqual', args);
  if (res.status !== 0) throw triqualError(label, res);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new ScriptError(EXIT_OTHER, `${label}: the output is not JSON`);
  }
}

// Whether this repo is opted in to tracking, its mode (null when not opted in) and, in local mode, the progress file.
export function tracking() {
  const paths = triqualJson(['tasks', 'paths', '--json']);
  return { optedIn: paths.optedIn === true, mode: paths.mode ?? null, progress: paths.progress ?? null };
}

// The task's row in the tracking ledger, or null when the repo is not opted in. A plan or task the ledger does not know
// is a refused precondition.
export function taskState(planName, n) {
  if (!tracking().optedIn) return null;
  const snapshot = triqualJson(['tasks', 'export', '--json']);
  const plan = snapshot.plans.find((p) => p.name === planName.replace(/\.md$/, ''));
  if (!plan) throw new ScriptError(EXIT_REFUSED, `${planName} is not registered in the tracking ledger`);
  const task = plan.tasks.find((t) => t.id === `T${n}`);
  if (!task) throw new ScriptError(EXIT_REFUSED, `T${n} is not in the tracking ledger of ${planName}`);
  return { status: task.status, tier: task.tier ?? null, effectiveTier: task.effectiveTier ?? null };
}

// `triqual tasks <command> T<N> [extra...] --plan <plan file name>`; a move the ledger refuses is exit 3.
export function taskMove(command, n, planName, extra = []) {
  const res = exec('triqual', ['tasks', command, `T${n}`, ...extra, '--plan', planName]);
  if (res.status !== 0) throw triqualError(`triqual tasks ${command}`, res);
}
