// Harvests role dispatches into replay cases: one directory per dispatch with case.json and the recovered briefs. A case is
// kept only when its hidden tests fail at base and pass at original in a fresh clone (no model call). Reads transcripts and
// git; writes only the case store. node: built-ins and the eval libraries only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from './eval-paths.mjs';
import { cloneAt, removeClone } from './eval-replay-clone.mjs';
import { findDispatches, subagentActivity } from './eval-replay-transcripts.mjs';
import {
  caseFiles, countUnnamedLiterals, existsAt, firstParent, isMerged, mainCheckout, resolveRef, restoreFiles, unnamedSymbols,
} from './eval-replay-git.mjs';
import {
  catReadsOf, commitDirsOf, commitRefsOf, dirsOf, planOf, rewritePrompt, rewriteWorkPaths, taskOf, testCommandOf,
} from './eval-replay-text.mjs';
import { runSetup, runShell } from './eval-replay-repos.mjs';

export const REASONS = [
  'no-subagent-transcript', 'brief-lost', 'no-commit', 'unreachable', 'not-merged', 'known-escape', 'no-tests',
  'no-test-command', 'symbols-unnamed', 'no-setup', 'validation-failed',
];

const GIT_TIMEOUT_MS = 60_000;
// The test command's cap, fixed for both runs; the repo's setup timeout applies to setup only (runSetup).
const TEST_TIMEOUT_SECONDS = 600;
// A commit made by the agent is dated inside its transcript; the slack covers the clock of the committer date (whole seconds).
const WINDOW_SLACK_MS = 60_000;
const BLOCKING = ['critical', 'important'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

// The id of a dispatch's case: the first 16 hex characters of sha256(`<role>\n<tool_use id>`).
export function caseId(role, toolUseId) {
  return createHash('sha256').update(`${role}\n${toolUseId}`).digest('hex').slice(0, 16);
}

export function casesDir(evals) {
  return join(evals, 'replay', 'cases');
}

// git with an args array; a missing git or a timeout reads as a failed result.
function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
}

// The checkout that holds the role files: the top level of this file's directory, else of cwd. Null when neither does.
export function resolveCheckout({ cwd } = {}) {
  for (const dir of [dirname(fileURLToPath(import.meta.url)), cwd]) {
    if (!dir) continue;
    const r = git(dir, ['rev-parse', '--show-toplevel']);
    const top = r.error || r.status !== 0 ? '' : r.stdout.trim();
    if (top && existsSync(join(top, 'plugins', 'roles', 'agents'))) return top;
  }
  return null;
}

// The last commit of the role file in the checkout: { sha, at } (at is the committer date), null when there is none.
export function roleVersion(role, checkout) {
  if (!checkout) return null;
  const r = git(checkout, ['log', '-1', '--format=%H%n%cI', '--', `plugins/roles/agents/${role}.md`]);
  if (r.error || r.status !== 0) return null;
  const [sha, at] = r.stdout.trim().split('\n');
  return sha && at ? { sha, at } : null;
}

// A plan's name without its directory and without `.md`; null when it is no string.
const planBase = (plan) => (typeof plan === 'string' && plan !== '' ? basename(plan).replace(/\.md$/, '') : null);

// Whether the role-eval records name an important defect of this plan task: a final-escapes entry traced to the task, or an
// escape record of the plan and task. Without a plan or a task nothing matches.
export function knownEscape({ plan, task }, records) {
  const base = planBase(plan);
  if (base === null || !task) return false;
  return asArray(records).some((r) => {
    if (!isObject(r) || planBase(r.plan) !== base) return false;
    if (r.kind === 'escape') return r.task === task;
    return r.kind === 'final-escapes'
      && asArray(r.escapes).some((e) => isObject(e) && e.task === task && BLOCKING.includes(e.severity));
  });
}

function checkoutDetached(dir, sha) {
  const r = git(dir, ['checkout', '-q', '-f', '--detach', sha]);
  return r.status === 0 && !r.error;
}

// In a fresh clone at base: setup, then the hidden tests and support files from original, then the test command must fail;
// then the clone moves to original (setup not rerun) and the command must pass. Returns "pass" or the reason it did not.
function validate({ repo, base, original, hiddenTests, supportFiles, testCommand, entry, env }) {
  let clone;
  try {
    clone = cloneAt(repo, base);
  } catch {
    return 'clone-failed';
  }
  try {
    if (!runSetup(clone, entry, { repo, env }).ok) return 'setup-failed';
    if (!restoreFiles(repo, original, [...hiddenTests, ...supportFiles], clone)) return 'clone-failed';
    const command = testCommand.replaceAll('{{WORK}}', clone);
    const run = { timeoutSeconds: TEST_TIMEOUT_SECONDS, env };
    if (runShell(clone, command, run).ok) return 'passes-at-base';
    if (!checkoutDetached(clone, original)) return 'clone-failed';
    return runShell(clone, command, run).ok ? 'pass' : 'fails-at-original';
  } finally {
    removeClone(clone);
  }
}

// A worktree path names its root: <anything>/.claude/worktrees/<name> or <anything>/.worktrees/<name>.
const WORKTREE_ROOT = /^(.*\/\.(?:claude\/)?worktrees\/[^/]+)(?:\/.*)?$/;

// Whether dir is the top level of a git checkout; a directory that no longer exists is taken as one (it cannot be asked).
function isCheckoutTop(dir) {
  if (!existsSync(dir)) return true;
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0) return false;
  try { return realpathSync(r.stdout.trim()) === realpathSync(dir); } catch { return false; }
}

// The root of the checkout a directory belongs to, spelled as the directory is: the top level while the directory exists. For a
// deleted directory: the worktree a .claude/worktrees or .worktrees path names, else the shallowest other directory of the
// transcript (`known`) above it that is a checkout top (a deleted one counts), else the directory itself: a deleted directory is
// a top only when no known directory above it on its path is one.
function checkoutRoot(dir, known) {
  if (!existsSync(dir)) {
    const named = WORKTREE_ROOT.exec(dir)?.[1];
    if (named) return named;
    const above = known.filter((k) => k !== dir && dir.startsWith(`${k.replace(/\/$/, '')}/`)).sort((a, b) => a.length - b.length);
    return above.find(isCheckoutTop) ?? dir;
  }
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0) return dir;
  let below = '';
  try { below = relative(realpathSync(r.stdout.trim()), realpathSync(dir)); } catch { return dir; }
  const depth = below === '' ? 0 : below.split('/').length;
  return depth === 0 ? dir : dir.split('/').slice(0, -depth).join('/') || '/';
}

// The nearest ancestor of dir (itself included) that exists, so the repository of a deleted worktree can still be asked.
function nearestExisting(dir) {
  let d = dir;
  while (d !== '/' && !existsSync(d)) d = dirname(d);
  return d;
}

// The case of one dispatch, or the reason it is excluded. Checks run in REASONS order; the first that applies excludes.
function deriveCase(d, { role, id, version, records, repos, env }) {
  if (d.subagentFile === null) return { reason: 'no-subagent-transcript' };
  const act = subagentActivity(d.subagentFile);
  // The directories the work happened in: the cwds and every directory a command cd'd or git -C'd into (an agent's cwd is reset
  // between commands). The repository is the first of them that holds the commit.
  const known = [...new Set([d.cwd, ...act.cwds, ...dirsOf(act.bashes)].filter(Boolean))];
  const workDirs = [...new Set(known.map((dir) => checkoutRoot(dir, known)))];
  const prompt = d.prompt ?? '';
  // Resolved before the prompt is rewritten: a brief under a work dir exists in a clone only when it is tracked at original.
  const refs = commitRefsOf(act.bashes);
  const repoOf = (dir) => mainCheckout(nearestExisting(checkoutRoot(dir, known)));
  const preferred = [...new Set(commitDirsOf(act.bashes).map(repoOf).filter(Boolean))];
  const checkouts = [...new Set([...preferred, ...workDirs.map((dir) => mainCheckout(nearestExisting(dir))).filter(Boolean)])];
  let repo = checkouts[0] ?? null;
  let original = null;
  const times = [Date.parse(d.dispatchedAt ?? ''), act.span?.from, act.span?.to].filter(Number.isFinite);
  const window = times.length === 0 ? null : { from: Math.min(...times) - WINDOW_SLACK_MS, to: Math.max(...times) + WINDOW_SLACK_MS };
  // The repositories of the commit's directories come first. A repository that holds the commit by sha is the one; a subject is
  // taken only when exactly one repository of the group has exactly one such commit (in the window when several share it).
  for (const group of refs.length === 0 ? [] : [preferred, checkouts.filter((c) => !preferred.includes(c))]) {
    const hits = group.map((candidate) => ({ candidate, found: resolveRef(candidate, refs, window) })).filter((hit) => hit.found !== null);
    if (hits.length === 0) continue;
    const chosen = hits.find((hit) => !hit.found.bySubject) ?? (hits.length === 1 && !hits[0].found.ambiguous ? hits[0] : null);
    if (chosen !== null) {
      repo = chosen.candidate;
      original = chosen.found.sha;
    }
    break;
  }
  const tracked = (p) => {
    if (original === null) return existsSync(p);
    return workDirs.some((dir) => p.startsWith(`${dir}/`) && existsAt(repo, original, p.slice(dir.length + 1)));
  };
  // A brief is recovered from a whole Read, a whole `cat` or a Write of the dispatching transcript, in that order.
  const reads = [...act.reads, ...catReadsOf(act.bashes), ...d.writes];
  const rewritten = rewritePrompt(prompt, { workDirs, reads, exists: (p) => existsSync(p), tracked });
  if (rewritten.lost) return { reason: 'brief-lost' };
  if (refs.length === 0) return { reason: 'no-commit' };
  const base = original === null ? null : firstParent(repo, original);
  if (base === null) return { reason: 'unreachable' };
  if (!isMerged(repo, original)) return { reason: 'not-merged' };
  if (knownEscape({ plan: planOf(prompt), task: taskOf(d.description ?? '') }, records)) return { reason: 'known-escape' };
  const named = [rewritten.prompt, ...rewritten.files.map((f) => f.content)].join('\n');
  const { hiddenTests, supportFiles } = caseFiles(repo, base, original, named);
  if (hiddenTests.length === 0) return { reason: 'no-tests' };
  const command = testCommandOf(act.bashes, workDirs);
  if (command === null) return { reason: 'no-test-command' };
  const symbols = unnamedSymbols(repo, base, original, hiddenTests, named);
  if (symbols.names.length > 0) return { reason: 'symbols-unnamed' };
  const repoName = basename(repo);
  if (!Object.hasOwn(repos, repoName)) return { reason: 'no-setup' };
  const doc = {
    v: 1,
    id,
    role,
    roleVersion: version?.sha ?? null,
    dispatchedAt: d.dispatchedAt ?? null,
    repo,
    repoName,
    base,
    original,
    prompt: rewritten.prompt,
    hiddenTests,
    supportFiles,
    testCommand: rewriteWorkPaths(command, workDirs),
    originalUsd: act.usd,
    symbolsChecked: symbols.checked,
    literalsUnnamed: countUnnamedLiterals(repo, base, original, hiddenTests, named),
  };
  const validation = validate({
    repo, base, original, hiddenTests, supportFiles, testCommand: doc.testCommand, entry: repos[repoName], env,
  });
  if (validation !== 'pass') return { reason: 'validation-failed' };
  return { doc: { ...doc, validated: true, validation }, files: rewritten.files };
}

function isValidated(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).validated === true;
  } catch {
    return false;
  }
}

// Builds the case in a temp directory (leftovers of the same id removed first) and moves it into place with one rename.
function writeCase(cases, id, doc, files) {
  for (const entry of readdirSync(cases)) {
    if (entry.startsWith(`.tmp-${id}-`)) rmSync(join(cases, entry), { recursive: true, force: true });
  }
  const tmp = join(cases, `.tmp-${id}-${process.pid}`);
  ensureDir(tmp);
  writeFileSync(join(tmp, 'case.json'), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  if (files.length > 0) {
    ensureDir(join(tmp, 'files'));
    for (const f of files) writeFileSync(join(tmp, 'files', f.name), f.content, { mode: 0o600 });
  }
  renameSync(tmp, join(cases, id));
}

// Harvests the role's dispatches under root into the case store of evals. Only a validated case is stored, and a stored validated
// case is never rewritten (it counts as kept). A dispatch that fails validation is an exclusion, not a case, so a later harvest
// retries it; a stored case that is not validated (an older harvest kept them) is removed and rebuilt. Returns the dispatch
// count, the kept count and a count per exclusion reason.
export function harvest({ role, since, root, evals, version, records = [], repos = {}, env = process.env }) {
  const excluded = Object.fromEntries(REASONS.map((reason) => [reason, 0]));
  const dispatches = findDispatches(root, role, { since });
  const cases = casesDir(evals);
  ensureDir(cases);
  let kept = 0;
  for (const d of dispatches) {
    const id = caseId(role, d.toolUseId);
    if (existsSync(join(cases, id))) {
      if (isValidated(join(cases, id, 'case.json'))) {
        kept += 1;
        continue;
      }
      rmSync(join(cases, id), { recursive: true, force: true });
    }
    const got = deriveCase(d, { role, id, version, records, repos, env });
    if (got.reason) {
      excluded[got.reason] += 1;
      continue;
    }
    kept += 1;
    writeCase(cases, id, got.doc, got.files);
  }
  return { found: dispatches.length, kept, excluded };
}
