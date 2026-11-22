// Harvests role dispatches into replay cases: one directory per dispatch with case.json and the recovered briefs. A case is
// kept only when its hidden tests fail at base and pass at original in a fresh clone (no model call). Reads transcripts and
// git; writes only the case store. node: built-ins and the eval libraries only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from './eval-paths.mjs';
import { cloneAt, removeClone } from './eval-replay-clone.mjs';
import { findDispatches, subagentActivity } from './eval-replay-transcripts.mjs';
import {
  caseFiles, countUnnamedLiterals, firstParent, isMerged, mainCheckout, resolveOriginal, restoreFiles, unnamedSymbols,
} from './eval-replay-git.mjs';
import { commitRefsOf, planOf, rewritePrompt, rewriteWorkPaths, taskOf, testCommandOf } from './eval-replay-text.mjs';
import { runSetup, runShell } from './eval-replay-repos.mjs';

export const REASONS = [
  'no-subagent-transcript', 'brief-lost', 'no-commit', 'unreachable', 'not-merged', 'known-escape', 'no-tests',
  'no-test-command', 'symbols-unnamed', 'no-setup', 'validation-failed',
];

const GIT_TIMEOUT_MS = 60_000;
// The test command's cap, fixed for both runs; the repo's setup timeout applies to setup only (runSetup).
const TEST_TIMEOUT_SECONDS = 600;
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

// The case of one dispatch, or the reason it is excluded. Checks run in REASONS order; the first that applies excludes.
function deriveCase(d, { role, id, version, records, repos, env }) {
  if (d.subagentFile === null) return { reason: 'no-subagent-transcript' };
  const act = subagentActivity(d.subagentFile);
  const workDirs = [d.cwd, ...act.cwds].filter(Boolean);
  const prompt = d.prompt ?? '';
  const rewritten = rewritePrompt(prompt, { workDirs, reads: act.reads, exists: (p) => existsSync(p) });
  if (rewritten.lost) return { reason: 'brief-lost' };
  const refs = commitRefsOf(act.bashes);
  if (refs.length === 0) return { reason: 'no-commit' };
  const repo = workDirs.map((dir) => mainCheckout(dir)).find(Boolean) ?? null;
  const original = repo === null ? null : resolveOriginal(repo, refs);
  const base = original === null ? null : firstParent(repo, original);
  if (base === null) return { reason: 'unreachable' };
  if (!isMerged(repo, original)) return { reason: 'not-merged' };
  if (knownEscape({ plan: planOf(prompt), task: taskOf(d.description ?? '') }, records)) return { reason: 'known-escape' };
  const named = [rewritten.prompt, ...rewritten.files.map((f) => f.content)].join('\n');
  const { hiddenTests, supportFiles } = caseFiles(repo, base, original, named);
  if (hiddenTests.length === 0) return { reason: 'no-tests' };
  const command = testCommandOf(act.bashes);
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
  return { doc: { ...doc, validated: validation === 'pass', validation }, files: rewritten.files };
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

// Harvests the role's dispatches under root into the case store of evals. An existing case is never rewritten; it counts as
// kept when validated, else as validation-failed. Returns the dispatch count, the kept count and a count per exclusion reason.
export function harvest({ role, since, root, evals, version, records = [], repos = {}, env = process.env }) {
  const excluded = Object.fromEntries(REASONS.map((reason) => [reason, 0]));
  const dispatches = findDispatches(root, role, { since });
  const cases = casesDir(evals);
  ensureDir(cases);
  let kept = 0;
  for (const d of dispatches) {
    const id = caseId(role, d.toolUseId);
    if (existsSync(join(cases, id))) {
      if (isValidated(join(cases, id, 'case.json'))) kept += 1;
      else excluded['validation-failed'] += 1;
      continue;
    }
    const got = deriveCase(d, { role, id, version, records, repos, env });
    if (got.reason) {
      excluded[got.reason] += 1;
      continue;
    }
    if (got.doc.validated) kept += 1;
    else excluded['validation-failed'] += 1;
    writeCase(cases, id, got.doc, got.files);
  }
  return { found: dispatches.length, kept, excluded };
}
