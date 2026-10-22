// What task-open, task-prep and task-close share: the workspace and its ledger, the failure contract, the tracking calls and the plan's
// tasks. Plain Node, node: built-ins and the plan reader next to it only.
//
// Failure contract (every script of the thin controller): exit 0 ok, 2 usage, 3 refused precondition, 1 any other
// failure; the one-line cause goes to stderr and, once the plan's workspace exists, `Error: <step> T<N> — exit <code> —
// <first line of the cause>` is appended to `<workspace>/sdd-ledger.md` before the script exits. Nothing is retried,
// defaulted or swallowed: a step that cannot run throws a ScriptError, and the script's one catch turns it into `fail`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanError, readPhases, readTasks } from './plan.mjs';

import { TIERS } from './plan.mjs';

export { TIERS };

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = 'sdd-ledger.md';
export const EXIT_OTHER = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

// A failed step with the exit code the script ends with. `logged: false` is a refusal that is a wait, not a failure (a task
// that must wait for an earlier one): the script exits with its code and cause but appends no `Error:` line.
export class ScriptError extends Error {
  constructor(code, message, { logged = true } = {}) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
    this.logged = logged;
  }
}

export const firstLine = (text) => String(text).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

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

// Run a command with its output captured (`options`: cwd, env, input, timeout in ms). A command that cannot start is a ScriptError;
// the exit status is the caller's. A command cut off by `timeout` comes back with `timedOut: true` (and a non-zero status), never
// as a pass. The buffer is large: an install or a test run can print a lot, and a cut-off output is no result.
export function exec(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (res.error?.code === 'ETIMEDOUT') {
    return { status: res.status || EXIT_OTHER, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: true };
  }
  if (res.error) throw new ScriptError(EXIT_OTHER, `cannot run ${basename(command)}: ${res.error.message}`);
  return { status: res.status ?? EXIT_OTHER, stdout: res.stdout, stderr: res.stderr, timedOut: false };
}

// A sibling script of the skill, by its interpreter (some extractors drop exec bits).
export const runScript = (name, args) => exec(process.execPath, [join(SCRIPTS, name), ...args]);

// A failed sibling script: its exit 2 or 3 stands, anything else is a plain failure.
export function scriptError(label, res) {
  const code = res.status === EXIT_USAGE || res.status === EXIT_REFUSED ? res.status : EXIT_OTHER;
  return new ScriptError(code, `${label}: ${firstLine(res.stderr) || `exited ${res.status}`}`);
}

export function git(args, options = {}) {
  const res = exec('git', args, options);
  if (res.status !== 0) throw new ScriptError(EXIT_OTHER, `git ${args[0]}: ${firstLine(res.stderr) || `exited ${res.status}`}`);
  return res.stdout.trim();
}

// The commit a revision names, or null when it names none. `--end-of-options`: a revision that starts with `-` is never an option.
export function commitOf(revision) {
  const res = exec('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

// Whether commit `ancestor` is reachable from `descendant` (a commit is its own ancestor). Anything but git's yes (0) or no (1) is a failure.
export function isAncestor(ancestor, descendant) {
  const res = exec('git', ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]);
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new ScriptError(EXIT_OTHER, `git merge-base --is-ancestor: ${firstLine(res.stderr) || `exited ${res.status}`}`);
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

// Append one line, or several lines in ONE write (lines that must stand or fall together, like the two lines of an undo).
export function appendLedger(workspace, ...lines) {
  if (lines.length === 0 || lines.some((line) => /[\r\n]/.test(line))) throw new Error('a ledger line is one line');
  const file = join(workspace, LEDGER);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${lines.map((line) => `${line}\n`).join('')}`);
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

// The index in `lines` of the last `BASE: T<N> <sha>` line, else -1.
export function lastBaseIndex(lines, n) {
  const re = new RegExp(`^BASE: T${n} (\\S+)\\s*$`);
  return lines.findLastIndex((l) => re.test(l));
}

// Every `Prep: T<N> r<R> <sha>` line of `lines` as { round, head, index }, in order.
export function prepsOf(lines, n) {
  const re = new RegExp(`^Prep: T${n} r(\\d+) (\\S+)\\s*$`);
  return lines.flatMap((l, index) => {
    const m = re.exec(l);
    return m ? [{ round: Number(m[1]), head: m[2], index }] : [];
  });
}

// The sha of the last `Landed: T<N> <sha>` line that no later `BASE: T<N>` line has undone (an undone landing starts the task
// over from a fresh BASE), else null.
export function lastLanded(lines, n) {
  const re = new RegExp(`^Landed: T${n} (\\S+)\\s*$`);
  const at = lines.findLastIndex((l) => re.test(l));
  return at > lastBaseIndex(lines, n) ? re.exec(lines[at])[1] : null;
}

// The line the undo of a landing writes (after the fresh `BASE:` line, in one write with it).
export const UNDONE_LINE = (n) => `Task ${n}: landing conflict — re-run sequential`;
// The index in `lines` of the last undo line of the task, else -1.
export function lastUndoIndex(lines, n) {
  return lines.findLastIndex((l) => l === UNDONE_LINE(n));
}

// Whether a `Tested: T<N> <sha>` line (written after the landing's Test files passed at <sha>) is among `lines`.
export function isTested(lines, n, sha) {
  const re = new RegExp(`^Tested: T${n} (\\S+)\\s*$`);
  return lines.some((l) => re.exec(l)?.[1] === sha);
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

// The Test: paths of the task (the backticked paths of its `- Test:` lines, outside fences), in plan order.
export function testPaths({ task, lines }) {
  const paths = [];
  let fenced = false;
  for (let i = task.start - 1; i < task.end; i++) {
    if (/^(```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    const m = !fenced && /^\s*[-*]\s+Test:(.*)$/.exec(lines[i]);
    if (m) paths.push(...[...m[1].matchAll(/`([^`]+)`/g)].map((hit) => hit[1]));
  }
  return paths;
}

// Why a `Test:` path of a plan cannot be run by the landing, or null: it must name one file inside the repository, so a glob (node
// --test expands them) and a path that leaves `root` (one that climbs out of it, an absolute path) are refused.
export function testPathProblem(root, path) {
  if (/[*?[\]{}]/.test(path)) return `the Test: path ${path} is a glob: name each Test file`;
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return `the Test: path ${path} is outside the repository`;
  return null;
}

// The branch of the stack's active phase (the one `stack.mjs squash` closes on): a worktree task lands there and nowhere else.
export function activePhaseBranch(plan) {
  const res = runScript('stack.mjs', ['path', plan]);
  if (res.status !== 0) throw scriptError('stack.mjs path', res);
  const file = res.stdout.trim();
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ScriptError(e.code === 'ENOENT' ? EXIT_REFUSED : EXIT_OTHER, e.code === 'ENOENT' ? `no stack state at ${file}: run stack init first` : `${file} is not readable JSON`);
  }
  const active = (state.phases ?? []).find((p) => p.state === 'active');
  if (!active) throw new ScriptError(EXIT_REFUSED, "no phase is active: a worktree task lands on the active phase's branch");
  return active.branch;
}

// How long the landing's `node --test` may run before it counts as a failure: the TRIQUAL_LANDING_TEST_TIMEOUT_MS environment
// variable, else this default (milliseconds).
export const DEFAULT_LANDING_TEST_TIMEOUT_MS = 600000;
export function landingTestTimeoutMs() {
  const raw = process.env.TRIQUAL_LANDING_TEST_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_LANDING_TEST_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(raw)) throw new ScriptError(EXIT_USAGE, `TRIQUAL_LANDING_TEST_TIMEOUT_MS must be a positive number of milliseconds, not ${raw}`);
  return Number(raw);
}

// The numbers of the tasks before T<N> in its phase (a plan with no phases is one phase of every task).
export function earlierTasks(planFile, n) {
  let phases;
  try {
    phases = readPhases(readFileSync(planFile, 'utf8'), basename(planFile).replace(/\.md$/, '')).phases;
  } catch (e) {
    if (e instanceof PlanError) throw new ScriptError(EXIT_USAGE, `${planFile}: ${e.message}`);
    throw e;
  }
  const phase = phases.find((p) => p.tasks.includes(`T${n}`));
  if (!phase) throw new ScriptError(EXIT_REFUSED, `T${n} is in no phase of ${planFile}`);
  return phase.tasks.slice(0, phase.tasks.indexOf(`T${n}`)).map((id) => Number(id.slice(1)));
}

// The earlier tasks of T<N>'s phase that are neither done nor dropped: in the tracking ledger when the repo is opted in, else those
// with no `Task <M>: complete` line. A worktree task's landing and a coordinator task's start both wait for this list to be empty.
export function earlierUnfinished(plan, planName, n, ledger) {
  const statuses = taskStatuses(planName);
  return earlierTasks(plan, n).filter((m) => (statuses
    ? !['done', 'dropped'].includes(statuses[`T${m}`])
    : !ledger.some((l) => l.startsWith(`Task ${m}: complete (commits `))));
}

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

// The plan's rows in the tracking ledger, or null when the repo is not opted in; a plan the ledger does not know is refused.
function trackedPlan(planName) {
  if (!tracking().optedIn) return null;
  const snapshot = triqualJson(['tasks', 'export', '--json']);
  const plan = snapshot.plans.find((p) => p.name === planName.replace(/\.md$/, ''));
  if (!plan) throw new ScriptError(EXIT_REFUSED, `${planName} is not registered in the tracking ledger`);
  return plan;
}

// The status of each task of the plan in the tracking ledger ({ T1: 'done', ... }), or null when the repo is not opted in.
export function taskStatuses(planName) {
  const plan = trackedPlan(planName);
  return plan === null ? null : Object.fromEntries(plan.tasks.map((t) => [t.id, t.status]));
}

// The task's row in the tracking ledger, or null when the repo is not opted in. A plan or task the ledger does not know
// is a refused precondition.
export function taskState(planName, n) {
  const plan = trackedPlan(planName);
  if (plan === null) return null;
  const task = plan.tasks.find((t) => t.id === `T${n}`);
  if (!task) throw new ScriptError(EXIT_REFUSED, `T${n} is not in the tracking ledger of ${planName}`);
  return { status: task.status, tier: task.tier ?? null, effectiveTier: task.effectiveTier ?? null };
}

// `triqual tasks <command> T<N> [extra...] --plan <plan path>`; a move the ledger refuses is exit 3. The plan goes as an absolute
// path: store mode matches it by file name, and local and committed mode resolve it against the working directory, where a bare
// file name finds no ledger.
export function taskMove(command, n, plan, extra = []) {
  const res = exec('triqual', ['tasks', command, `T${n}`, ...extra, '--plan', resolve(plan)]);
  if (res.status !== 0) throw triqualError(`triqual tasks ${command}`, res);
}

// ---- the worktrees of parallel tasks ----

export const WORKTREES_IGNORE = '.claude/worktrees/';

// The worktree and the branch of a task: `.claude/worktrees/<plan stem>-t<N>` on `wt/<plan stem>-t<N>`, in the main checkout.
export function worktreeOf(planName, n) {
  const name = `${planName.replace(/\.md$/, '')}-t${n}`;
  return { branch: `wt/${name}`, path: join(git(['rev-parse', '--show-toplevel']), '.claude', 'worktrees', name) };
}

// The paths `git worktree list` shows.
export const registeredWorktrees = () => git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));

// Add `.claude/worktrees/` to the repository's `info/exclude` once.
export function excludeWorktrees() {
  const file = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(WORKTREES_IGNORE)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${WORKTREES_IGNORE}\n`);
}

// The commit a worktree task opens at: the last CLOSED commit of the main checkout's branch. HEAD is closed unless a task built in the
// main checkout has commits on it that no close has squashed yet (nobody has reviewed them): then it is that task's BASE (the phase tip
// when the task opened, a closed commit by the same rule). Worktree tasks are not main-checkout tasks (their commits are not on
// HEAD), and a task that is done, dropped or has landed has nothing unreviewed on HEAD. When several tasks qualify, the one whose BASE
// is the oldest wins (the most commits `BASE..HEAD`).
export function worktreeBase(planName, n, ledger) {
  const head = git(['rev-parse', 'HEAD']);
  const statuses = taskStatuses(planName);
  const stem = planName.replace(/\.md$/, '');
  const others = [...new Set(ledger.flatMap((l) => { const m = /^BASE: T(\d+) /.exec(l); return m && Number(m[1]) !== n ? [Number(m[1])] : []; }))];
  const open = others.filter((m) => !(statuses
    ? ['done', 'dropped'].includes(statuses[`T${m}`])
    : ledger.some((l) => l.startsWith(`Task ${m}: complete (commits `)))
    && lastLanded(ledger, m) === null
    && commitOf(`refs/heads/wt/${stem}-t${m}`) === null);
  let closed = { base: head, count: 0 };
  for (const m of open) {
    const base = commitOf(lastBase(ledger, m));
    if (base === null || !isAncestor(base, head)) continue;
    const count = Number(git(['rev-list', '--count', `${base}..${head}`]));
    if (count > closed.count) closed = { base, count };
  }
  return closed.base;
}

// Remove a task's worktree and its branch, then check that `git worktree list` no longer shows the worktree. Without an option a
// worktree holding changes git does not know is refused (work nobody reviewed is never thrown away). `force`: the undo of a landing
// takes the worktree down whatever it holds. `dropUntracked`: the close of a landed task takes it down with its untracked files
// (an install's output that no .gitignore covers), and refuses only when a TRACKED file has uncommitted changes. Returns the
// untracked paths it dropped. Safe to repeat: what is already gone is skipped.
export function removeWorktree({ branch, path }, { force = false, dropUntracked = false } = {}) {
  let dropped = [];
  if (registeredWorktrees().includes(path)) {
    if (!force && dropUntracked) {
      const changed = git(['status', '--porcelain', '--untracked-files=no'], { cwd: path });
      if (changed !== '') {
        throw new ScriptError(EXIT_OTHER, `${path} holds uncommitted changes to tracked files (${firstLine(changed)}): the task is closed and recorded; commit or discard them, then run task-close again to remove the worktree`);
      }
      dropped = git(['ls-files', '--others', '--exclude-standard'], { cwd: path }).split('\n').filter(Boolean);
    }
    git(['worktree', 'remove', ...(force || dropUntracked ? ['--force'] : []), path]);
  }
  if (commitOf(`refs/heads/${branch}`) !== null) git(['branch', '-D', branch]);
  if (registeredWorktrees().includes(path)) throw new ScriptError(EXIT_OTHER, `git worktree list still shows ${path}`);
  return dropped;
}
