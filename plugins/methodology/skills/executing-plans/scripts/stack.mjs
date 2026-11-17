#!/usr/bin/env node
// Owns every git and gh operation of a stacked plan execution: one branch (and, in GitHub mode, one draft PR) per
// plan phase: plan parsing, the state file, mode detection and the init, mode, path, status, phase, squash, done,
// submit and push commands.
//
// Usage: stack.mjs <command> PLAN_FILE ...
//   init PLAN_FILE [--trunk <b>] [--mode github|local] [--remote <r>]   print the state (JSON), writing it first time
//   mode PLAN_FILE github|local                                         switch the mode (github re-runs the checks)
//   path PLAN_FILE                                                      print the state file's path
//   status PLAN_FILE [--tree]                                           print the state (JSON), PR states refreshed; --tree: the phases as a tree
//                                                                       (each phase also prints `ready` and `base`, keys never written to the file);
//                                                                       a join is printed under its first parent with ` + P<k>` per other parent
//   phase PLAN_FILE N                                                   check out phase N's branch, mark it active; while another phase
//                                                                       holds the main checkout, build it in <root>/.claude/worktrees/
//                                                                       <plan stem>-p<N> (a second line `workdir: <path>`); a join (a phase of
//                                                                       `**Parent:** P1, P2`) starts at one commit that merges every parent's tip
//   squash PLAN_FILE BASE [--phase N]                                   fold BASE..HEAD into one commit, print its sha; runs in
//                                                                       phase N's workdir (default: the only active phase)
//   done PLAN_FILE N                                                    mark phase N done (its worktree removed, its branch kept)
//   submit PLAN_FILE N [--open]                                         reconcile gh stack, submit, fill phase N's PR
//   push PLAN_FILE N                                                    push a submitted phase, refresh its PR body
//                                                                       (a `prs` plan: plain git push and gh pr create, no gh stack)
//
// Exit codes: 0 ok, 2 usage, malformed plan or TRIQUAL_NOW not an ISO time, 3 refused precondition, 5 a gh command failed.
// Node built-ins, git and gh only. Every gh call is non-interactive.
//
// State fields a phase may carry (a state is .methodology/stack/<plan stem>.json): `startedAt` and `doneAt` (UTC times, written by
// phase and done), `base` (v2 only: the commit the phase's own work starts after), `workdir` (a phase built in a phase worktree),
// `parents` (a join). Every write goes through updateState, which holds the lock directory <state>.lock around the re-read, the
// mutation and the write only; no git command that touches a worktree, no push and no gh call runs inside it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanError, readPhases } from './lib/plan.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_GH = 5;
const STATE_VERSION = 1;
// A `prs` state: the v1 keys plus a parent per phase. The version tells the layout; the state has no layout key.
const PRS_STATE_VERSION = 2;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
// The state lock: polled every LOCK_POLL_MS, taken over when its directory is older than STALE_LOCK_MS.
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 60_000;
const COMMITTED_MODE_MESSAGE =
  'committed tracking mode cannot hold one commit per task: switch with triqual progress-init --store (or --local)';

// GitHub remote URL forms, as regex literals only: owner is group 1, repository group 2.
const GITHUB_URL_FORMS = [
  /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  /^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
];

// SSH aliases (an ~/.ssh/config `Host github.com-<x>`): same groups. Only a host that starts `github.com-` counts; the
// push goes through the alias's key, which `gh stack` cannot use.
const GITHUB_ALIAS_URL_FORMS = [
  /^ssh:\/\/git@github\.com-[^\/:@]+(?::\d+)?\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  /^git@github\.com-[^\/:@]+:([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
];

class StackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StackError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new StackError(code, message);
}

// --- git and gh -------------------------------------------------------------------------------------------------

// Runs git and returns its stdout without the trailing newline; a non-zero exit throws an Error carrying the status
// and stderr. `opts.input` is written to git's stdin.
export function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
    err.status = res.status;
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout.replace(/\n+$/, '');
}

const gitOk = (args, opts) => {
  try {
    git(args, opts);
    return true;
  } catch {
    return false;
  }
};

const revParse = (ref, opts) => {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref], opts);
  } catch {
    return null;
  }
};

// Runs gh without a prompt and returns { stdout, stderr }. A failure throws exit 5 carrying gh's stderr (`stderr`) and
// its own exit status (`ghStatus`, null when gh could not be started).
function ghRun(args, opts = {}) {
  const res = spawnSync('gh', args, {
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error || res.status !== 0) {
    const stderr = res.error ? res.error.message : res.stderr;
    const err = new StackError(EXIT_GH, stderr.trim() || `gh ${args.join(' ')} exited ${res.status}`);
    err.stderr = stderr;
    err.ghStatus = res.error ? null : res.status;
    throw err;
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

// gh's stdout.
export const gh = (args, opts) => ghRun(args, opts).stdout;

// The stack HEAD belongs to (or whose trunk HEAD is), as `gh stack view --json` prints it. On a branch outside any
// stack gh exits 2 with `is not part of a stack`: that is "not a member", null, never an error.
export function ghStackView(opts = {}) {
  let out;
  try {
    out = gh(['stack', 'view', '--json'], opts);
  } catch (e) {
    if (e.ghStatus === 2 && /is not part of a stack/.test(e.stderr)) return null;
    throw e;
  }
  try {
    return JSON.parse(out);
  } catch {
    return fail(EXIT_GH, 'gh stack view --json did not print JSON');
  }
}

// The branch names of that stack; empty when HEAD is not a member.
export function ghStackMembers(opts = {}) {
  return (ghStackView(opts)?.branches ?? []).map((b) => b.name);
}

// --- plan parsing -----------------------------------------------------------------------------------------------

function checkRef(name, what) {
  const res = spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' });
  if (res.status !== 0) fail(EXIT_USAGE, `${what} "${name}" is not a valid git branch name`);
}

// Phases of a plan: { prefix, forest, phases: [{ n, title, slice, branch, parent, prTitle, standsAlone, check, tasks }] },
// `parent` and `forest` being the reader's, read with the
// shared plan reader (lib/plan.mjs, a byte-identical copy of progress-tracking's), which skips heading and field lines
// inside fenced code blocks and checks the phase order, fields, prefix and branch numbers. A plan with no
// `**Branch prefix:**` line was written before phases existed (or has no `## Phase` heading): it is one phase, and any
// `## Phase` heading in it is ignored. The reader's names map back to the state file's (`branchPrefix` → `prefix`,
// `phaseCheck` → `check`, task ids `T<n>` → n), and every branch name passes `git check-ref-format` here, since the
// reader runs no process.
export function parsePhases(text, planFile) {
  let read;
  try {
    read = readPhases(text, basename(planFile, '.md'));
  } catch (e) {
    if (e instanceof PlanError) fail(EXIT_USAGE, e.message);
    throw e;
  }
  checkRef(read.branchPrefix, 'branch prefix');
  const phases = read.phases.map(({ phaseCheck, tasks, ...phase }) => {
    checkRef(phase.branch, 'branch');
    return { ...phase, check: phaseCheck, tasks: tasks.map((id) => Number(id.slice(1))) };
  });
  return { prefix: read.branchPrefix, forest: read.forest, phases };
}

// The layout a plan calls for: `prs` (one independent PR per phase, each against its parent) for a forest plan or a
// remote `gh stack` cannot use through an SSH alias, else the linear `stack`.
export const chooseLayout = ({ forest, alias }) => (forest || alias ? 'prs' : 'stack');

const layoutOf = (state) => (state.v === PRS_STATE_VERSION ? 'prs' : 'stack');

// The branch a phase starts from: the trunk, an earlier phase's branch, or a named branch.
function parentBranch(phase, phases, trunk) {
  const { kind, value } = phase.parent;
  if (kind === 'trunk') return trunk;
  return kind === 'phase' ? phases[Number(value.slice(1)) - 1].branch : value;
}

// The branches a phase starts from, in written order: a join's (every parent a phase of the plan), else its one parent.
const planParents = (phase, phases, trunk) =>
  phase.parents.length > 1 ? phase.parents.map((n) => phases[n - 1].branch) : [parentBranch(phase, phases, trunk)];

// --- state file -------------------------------------------------------------------------------------------------

export const statePath = (root, planFile) =>
  join(root, '.methodology', 'stack', `${basename(planFile, '.md')}.json`);

export function readState(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(EXIT_USAGE, `${path} is not valid JSON`);
  }
}

// Atomic: the JSON goes to <path>.<pid>.tmp, then a rename. .methodology/ keeps a self-ignoring .gitignore, as the SDD
// workspace does, so the state never shows in git status. Callers outside updateState hold no lock: only updateState writes.
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const ignore = join(dirname(dirname(path)), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A waiter that judged the lock directory stale (`seen`: the stat it judged by) renames it away (one atomic renameSync: only
// one waiter wins it). When the directory it moved is the one it judged (same inode and mtime) it says so on stderr and removes it
// (true). Otherwise another waiter had already taken that lock over and made a fresh one, which this rename has just moved: the
// waiter puts nothing back (a rename over the lock path would replace a lock a third contender made meanwhile), removes the moved
// directory (an empty marker nobody reads: a lock owner releases by the path and the inode it made) and goes on waiting (false).
export function takeOverStaleLock(lock, seen) {
  const stale = `${lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lock, stale);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const moved = statSync(stale);
  const judged = moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs;
  if (judged) process.stderr.write(`stack: taking over a stale state lock (${Math.round((Date.now() - seen.mtimeMs) / 1000)} s old): ${lock}\n`);
  rmSync(stale, { recursive: true, force: true });
  return judged;
}

// Takes the lock directory; returns the inode of the one it made, which releaseLock checks.
function acquireLock(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      return statSync(lock).ino;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let seen;
    try {
      seen = statSync(lock);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (Date.now() - seen.mtimeMs > STALE_LOCK_MS && takeOverStaleLock(lock, seen)) continue;
    sleepMs(LOCK_POLL_MS);
  }
}

// Removes the lock only while it is the directory this process made: one a waiter moved away is not another owner's to remove.
function releaseLock(lock, ino) {
  try {
    if (statSync(lock).ino === ino) rmSync(lock, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// The one way the state is written: take the lock, re-read the state (null when there is none), mutate it, write it,
// release the lock (also when mutate throws). `mutate(state)` changes the object it is given, or returns a state to write
// instead, or returns false to write nothing; it reads and changes the state object only (and may run a read-only `git worktree
// list`), so it runs no git command that touches a worktree, no install, no push and no gh call. Returns the state as written
// (or as found).
export function updateState(ctx, mutate) {
  const lock = `${ctx.path}.lock`;
  const ino = acquireLock(lock);
  try {
    const current = readState(ctx.path);
    const result = mutate(current);
    if (result === false) return current;
    const next = result ?? current;
    writeState(ctx.path, next);
    return next;
  } finally {
    releaseLock(lock, ino);
  }
}

// The time a phase starts or ends: TRIQUAL_NOW when set and not empty, else the clock; UTC, to the second.
export function nowIso() {
  const set = process.env.TRIQUAL_NOW;
  if (set === undefined || set === '') return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!ISO_TIME.test(set)) fail(EXIT_USAGE, `TRIQUAL_NOW must be an ISO time like 2026-11-16T10:00:00Z, not ${set}`);
  return set;
}

// --- mode detection, remote and trunk ---------------------------------------------------------------------------

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function remoteNames(cwd) {
  const out = git(['remote'], { cwd });
  return out ? out.split('\n').sort() : [];
}

// { slug: 'owner/repo', alias } for a GitHub remote (alias: its host is a `github.com-<x>` SSH alias), else null.
export function githubRemote(remote, cwd) {
  let url;
  try {
    url = git(['remote', 'get-url', remote], { cwd });
  } catch {
    return null;
  }
  for (const [forms, alias] of [[GITHUB_URL_FORMS, false], [GITHUB_ALIAS_URL_FORMS, true]]) {
    for (const form of forms) {
      const m = form.exec(url);
      if (m) return { slug: `${m[1]}/${m[2]}`, alias };
    }
  }
  return null;
}

const githubSlug = (remote, cwd) => githubRemote(remote, cwd)?.slug ?? null;

// --remote, else origin when it is a GitHub remote, else the first GitHub remote by name.
function pickGithubRemote(cwd, requested) {
  const names = remoteNames(cwd);
  const github = names.filter((name) => githubSlug(name, cwd));
  if (requested) return github.includes(requested) ? requested : null;
  return github.includes('origin') ? 'origin' : (github[0] ?? null);
}

// The remote a local-mode stack records: --remote, else origin, else the first remote, else none.
function pickLocalRemote(cwd, requested) {
  const names = remoteNames(cwd);
  if (requested) {
    if (!names.includes(requested)) fail(EXIT_REFUSED, `remote "${requested}" does not exist`);
    return requested;
  }
  return names.includes('origin') ? 'origin' : (names[0] ?? null);
}

// The four GitHub-mode checks, in order (the `prs` layout makes no gh stack call, so it skips the second).
// { ok: true, remote, slug, ghStackVersion, defaultBranch } or { ok: false, reason } naming the first check that failed.
function checkGithub(cwd, requestedRemote, layout) {
  try {
    gh(['--version'], { cwd });
  } catch (e) {
    return { ok: false, reason: `gh --version failed: ${oneLine(e.message)}` };
  }
  let ghStackVersion = null;
  if (layout === 'stack') {
    try {
      ghStackVersion = oneLine(gh(['stack', '--version'], { cwd }));
    } catch (e) {
      return { ok: false, reason: `gh stack --version failed: ${oneLine(e.message)}` };
    }
  }
  const remote = pickGithubRemote(cwd, requestedRemote);
  if (!remote) {
    const reason = requestedRemote
      ? `remote "${requestedRemote}" is not a GitHub remote`
      : 'no GitHub remote (neither origin nor another remote has a GitHub URL)';
    return { ok: false, reason };
  }
  const { slug, alias } = githubRemote(remote, cwd);
  if (alias && layout === 'stack') {
    return { ok: false, reason: `remote "${remote}" is an SSH alias: gh stack cannot use it (delete the stack state and run stack init again)` };
  }
  let defaultBranch = null;
  try {
    const view = JSON.parse(gh(['repo', 'view', slug, '--json', 'nameWithOwner,defaultBranchRef'], { cwd }));
    defaultBranch = view?.defaultBranchRef?.name ?? null;
  } catch (e) {
    return { ok: false, reason: `gh repo view ${slug} failed: ${oneLine(e.message)}` };
  }
  return { ok: true, remote, slug, ghStackVersion, defaultBranch };
}

// R9, local mode: the remote's default branch (refs/remotes/<remote>/HEAD), else main, else master.
function localTrunk(cwd, remote) {
  if (remote) {
    try {
      const head = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd });
      if (head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
    } catch {
      // no remote HEAD recorded
    }
  }
  for (const name of ['main', 'master']) if (revParse(`refs/heads/${name}`, { cwd })) return name;
  return fail(EXIT_REFUSED, 'cannot tell the trunk: pass --trunk <branch>');
}

// The trunk's tip: the local branch, else the remote's.
function trunkTip(cwd, trunk, remote) {
  const tip = revParse(`refs/heads/${trunk}`, { cwd }) ?? (remote ? revParse(`refs/remotes/${remote}/${trunk}`, { cwd }) : null);
  return tip ?? fail(EXIT_REFUSED, `trunk "${trunk}" does not exist: pass --trunk <branch>`);
}

// R9: GitHub mode needs the trunk's tip on the remote, read from the remote-tracking ref (the last fetch); the script
// never pushes the trunk and never reaches the network for this check.
function requireTrunkOnRemote(cwd, trunk, remote) {
  const tracked = revParse(`refs/remotes/${remote}/${trunk}`, { cwd });
  if (!tracked) {
    fail(EXIT_REFUSED, `trunk "${trunk}" is not on ${remote} (no ${remote}/${trunk}): push it and fetch first`);
  }
  const tip = trunkTip(cwd, trunk, remote);
  if (!gitOk(['merge-base', '--is-ancestor', tip, tracked], { cwd })) {
    fail(EXIT_REFUSED, `trunk "${trunk}" has commits that are not on ${remote}: push it and fetch first`);
  }
}

// R4: committed tracking mode cannot hold one commit per task. Not opted in, local and store modes are fine; without
// triqual on the PATH there is nothing to refuse.
function refuseCommittedTracking(cwd) {
  const res = spawnSync('triqual', ['tasks', 'paths', '--json'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.error || res.status !== 0) return;
  let info;
  try {
    info = JSON.parse(res.stdout);
  } catch {
    return;
  }
  if (info?.optedIn && info.mode === 'committed') fail(EXIT_REFUSED, COMMITTED_MODE_MESSAGE);
}

// --- commands ---------------------------------------------------------------------------------------------------

function parseOptions(args, allowed) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!allowed.includes(name)) fail(EXIT_USAGE, `unknown option ${a}`);
    if (i + 1 >= args.length) fail(EXIT_USAGE, `${a} needs a value`);
    opts[name] = args[++i];
  }
  return { opts, rest };
}

// { cwd, root, planFile, path } for a command's PLAN_FILE argument. Every command runs from the main checkout, where the
// workspace, the ledger and the stack state live: in a linked worktree the git dir differs from the common dir (exit 3).
function context(planFile) {
  if (!planFile) fail(EXIT_USAGE, 'missing PLAN_FILE');
  if (!existsSync(planFile)) fail(EXIT_USAGE, `no such plan file: ${planFile}`);
  const cwd = process.cwd();
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], { cwd });
  } catch {
    return fail(EXIT_USAGE, 'not inside a git repository');
  }
  const [gitDir, commonDir] = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd }).split('\n');
  if (gitDir !== commonDir) fail(EXIT_REFUSED, 'run from the main checkout');
  return { cwd, root, planFile, path: statePath(root, planFile) };
}

const out = (text) => process.stdout.write(`${text}\n`);
const printState = (state) => out(JSON.stringify(state, null, 2));

// Phases whose branch already exists when the state is first written: `done` when chained on its parent (the previous
// phase, an earlier one or the trunk); in GitHub mode with the PR number, `submitted`, when gh finds one. An unchained
// branch exits 3. A `prs` state records each phase's parent branch, and a join's parent branches (`parents`); an adopted join branch
// must hold every parent's tip and records its join commit as `base`.
function adoptExisting(cwd, phases, trunk, trunkSha, github, layout) {
  return phases.map((phase) => {
    const sha = revParse(`refs/heads/${phase.branch}`, { cwd });
    const parents = planParents(phase, phases, trunk);
    const entry = { n: phase.n, branch: phase.branch, title: phase.prTitle, pr: null, state: 'pending' };
    if (layout === 'prs') {
      entry.parent = parents[0];
      if (parents.length > 1) entry.parents = parents;
    }
    if (sha) {
      const shas = parents.map((parent) => {
        const parentSha = parent === trunk ? trunkSha : revParse(`refs/heads/${parent}`, { cwd });
        if (!parentSha) fail(EXIT_REFUSED, `branch ${phase.branch} exists but its parent's branch ${parent} does not`);
        if (!gitOk(['merge-base', '--is-ancestor', parentSha, sha], { cwd })) {
          fail(EXIT_REFUSED, `branch ${phase.branch} is not chained on ${parent}: its history lacks ${parent}'s tip`);
        }
        return parentSha;
      });
      if (parents.length > 1) entry.base = joinCommitOf(cwd, phase, shas[0], sha, parents.length);
      entry.state = 'done';
      if (github) {
        const found = JSON.parse(
          gh(['pr', 'list', '--repo', github.slug, '--head', phase.branch, '--json', 'number,isDraft'], { cwd }),
        );
        if (found.length > 0) {
          entry.pr = found[0].number;
          entry.state = 'submitted';
        }
      }
    }
    return entry;
  });
}

// Mode and remote from the flags: local when asked or when a check fails (naming it); --mode github refuses (3).
function chooseMode(cwd, requestedMode, requestedRemote, layout) {
  if (requestedMode === 'local') {
    return { mode: 'local', reason: '--mode local', ghStackVersion: null, remote: pickLocalRemote(cwd, requestedRemote) };
  }
  const found = checkGithub(cwd, requestedRemote, layout);
  if (found.ok) return { mode: 'github', reason: null, ...found };
  if (requestedMode === 'github') fail(EXIT_REFUSED, `--mode github refused: ${found.reason}`);
  return { mode: 'local', reason: found.reason, ghStackVersion: null, remote: pickLocalRemote(cwd, requestedRemote) };
}

function cmdInit(args) {
  const { opts, rest } = parseOptions(args, ['trunk', 'mode', 'remote']);
  if (opts.mode && !['github', 'local'].includes(opts.mode)) fail(EXIT_USAGE, '--mode is github or local');
  const ctx = context(rest[0]);
  refuseCommittedTracking(ctx.cwd);
  const { prefix, forest, phases } = parsePhases(readFileSync(ctx.planFile, 'utf8'), ctx.planFile);
  const aliasRemote = () => {
    const githubName = pickGithubRemote(ctx.cwd, opts.remote);
    return githubName ? githubRemote(githubName, ctx.cwd).alias : false;
  };
  const existing = readState(ctx.path);
  if (existing) {
    // An existing state keeps its layout: the alias only decides the layout of a new state, so a re-run on a v1 state
    // prints it. Only the plan's shape can contradict the state (a forest needs prs).
    const had = layoutOf(existing);
    if (had !== chooseLayout({ forest, alias: false }) && !(had === 'prs' && !forest && aliasRemote())) {
      fail(EXIT_REFUSED, `state was written for the ${had} layout: delete ${ctx.path} and run stack init again`);
    }
    // The parents a phase starts from are part of the state: a plan that changed them needs a new state.
    if (had === 'prs') {
      for (const phase of phases) {
        const recorded = existing.phases.find((p) => p.n === phase.n);
        if (!recorded) continue;
        const have = recorded.parents ?? [recorded.parent];
        if (have.join(',') !== planParents(phase, phases, existing.trunk).join(',')) {
          fail(EXIT_REFUSED, `state was written for other parents of phase ${phase.n} (${have.join(', ')}): delete ${ctx.path} and run stack init again`);
        }
      }
    }
    return printState(existing);
  }
  const layout = chooseLayout({ forest, alias: aliasRemote() });
  if (revParse(`refs/heads/${prefix}`, { cwd: ctx.cwd })) {
    fail(EXIT_REFUSED, `branch "${prefix}" exists: it blocks the phase branches ${prefix}/NN-*; rename or delete it`);
  }
  const picked = chooseMode(ctx.cwd, opts.mode, opts.remote, layout);
  const trunk = opts.trunk ?? picked.defaultBranch ?? localTrunk(ctx.cwd, picked.remote);
  const trunkSha = trunkTip(ctx.cwd, trunk, picked.remote);
  if (picked.mode === 'github') requireTrunkOnRemote(ctx.cwd, trunk, picked.remote);

  const state = {
    v: layout === 'prs' ? PRS_STATE_VERSION : STATE_VERSION,
    plan: basename(ctx.planFile),
    mode: picked.mode,
    reason: picked.reason,
    ghStackVersion: picked.ghStackVersion,
    trunk,
    remote: picked.remote,
    phases: adoptExisting(ctx.cwd, phases, trunk, trunkSha, picked.mode === 'github' ? picked : null, layout),
  };
  // An existing state found under the lock (another init won the race) is printed, not overwritten.
  return printState(updateState(ctx, (found) => (found ? false : state)));
}

function cmdMode(args) {
  const [planFile, mode] = args;
  if (!['github', 'local'].includes(mode)) fail(EXIT_USAGE, 'usage: stack.mjs mode PLAN_FILE github|local');
  const ctx = context(planFile);
  const state = readState(ctx.path);
  if (!state) fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
  let change;
  if (mode === 'github') {
    const found = checkGithub(ctx.cwd, undefined, layoutOf(state));
    if (!found.ok) fail(EXIT_REFUSED, `cannot switch to github mode: ${found.reason}`);
    requireTrunkOnRemote(ctx.cwd, state.trunk, found.remote);
    change = { mode, reason: null, ghStackVersion: found.ghStackVersion, remote: found.remote };
  } else {
    change = { mode, reason: 'switched with stack mode local', ghStackVersion: null };
  }
  updateState(ctx, (fresh) => {
    if (!fresh) fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
    Object.assign(fresh, change);
  });
  return out(`mode: ${mode}`);
}

function cmdPath(args) {
  return out(context(args[0]).path);
}

// The phases as a tree under the trunk, two spaces per depth, a phase under the phase it starts from (its parent in a
// `prs` state, the previous phase in a `stack` one; the trunk or a named branch is the root).
function renderTree(state, root) {
  const parentOf = (phase) =>
    layoutOf(state) === 'prs' ? state.phases.find((p) => p.branch === phase.parent) : state.phases.find((p) => p.n === phase.n - 1);
  const lines = [state.trunk];
  const walk = (parent, depth) => {
    for (const phase of state.phases.filter((p) => parentOf(p) === parent)) {
      const where = phase.state === 'active' && phase.workdir ? ` ${relative(root, phase.workdir)}` : '';
      // A join is printed once, under its first parent, with its other parents after it.
      const joins = (phase.parents ?? []).slice(1).map((b) => ` + P${state.phases.find((p) => p.branch === b)?.n ?? b}`).join('');
      lines.push(`${'  '.repeat(depth)}P${phase.n} ${phase.branch} [${phase.state}${phase.pr === null ? '' : ` #${phase.pr}`}]${where}${joins}`);
      walk(phase, depth + 1);
    }
  };
  walk(undefined, 1);
  return lines.join('\n');
}

// GitHub mode: each recorded PR is read with gh pr view; a merged PR marks its phase merged.
function cmdStatus(args) {
  const tree = args.includes('--tree');
  const ctx = context(args.filter((a) => a !== '--tree')[0]);
  const state = readState(ctx.path);
  if (!state) fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
  let shown = state;
  if (state.mode === 'github') {
    // The gh calls run first, outside the lock; updateState then sets the merged marks on the state it re-reads.
    const slug = state.remote ? githubSlug(state.remote, ctx.cwd) : null;
    const merged = [];
    for (const phase of state.phases) {
      if (phase.pr === null || phase.state === 'merged') continue;
      if (!slug) fail(EXIT_REFUSED, `remote "${state.remote}" is no longer a GitHub remote: switch with stack mode local`);
      const view = JSON.parse(gh(['pr', 'view', String(phase.pr), '--repo', slug, '--json', 'number,state,isDraft'], { cwd: ctx.cwd }));
      if (view.state === 'MERGED') merged.push(phase.n);
    }
    if (merged.length > 0) {
      shown = updateState(ctx, (fresh) => {
        for (const phase of fresh.phases) if (merged.includes(phase.n)) phase.state = 'merged';
      });
    }
  }
  if (tree) return out(renderTree(shown, ctx.root));
  // `ready` and `base` are printed, never written to the file.
  const ready = readyPhases(shown);
  const phases = shown.phases.map((phase) => {
    let base = null;
    try {
      base = phaseBase(ctx.cwd, shown, phase);
    } catch {
      // a floor that cannot be computed (a parent's branch deleted after its merge) prints as null
    }
    return { ...phase, ready: ready.includes(phase.n), base };
  });
  return printState({ ...shown, phases });
}

// --- phase, squash and done -------------------------------------------------------------------------------------

// R1 and U4: the predecessor states that let the next phase start (merged once status records it). Local mode also
// takes done, its final state.
const STARTED_AFTER = { github: ['submitted', 'ready', 'merged'], local: ['done', 'submitted', 'ready', 'merged'] };
// A phase in one of these states is entered again with phase; any later state is final.
const ENTERABLE = ['pending', 'active'];

function loadState(ctx) {
  return readState(ctx.path) ?? fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
}

function phaseOf(state, value, usage) {
  if (!/^\d+$/.test(value ?? '')) fail(EXIT_USAGE, usage);
  const phase = state.phases.find((p) => p.n === Number(value));
  return phase ?? fail(EXIT_USAGE, `no phase ${value}: the plan has phases 1-${state.phases.length}`);
}

// Clean means tracked files only: untracked files never block phase or squash. --no-optional-locks: a read-only check never takes
// the index lock another command of the same checkout (a phase's branch switch) may be holding.
function requireCleanTree(cwd) {
  if (git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd })) {
    fail(EXIT_REFUSED, 'the working tree is not clean: commit or stash the changes to tracked files first');
  }
}

// A state-file branch name is checked before it reaches git, so a value starting with `-` is never an option.
function branchOf(phase) {
  checkRef(phase.branch, `phase ${phase.n} branch`);
  return phase.branch;
}

// A branch's tip: the local branch first, else the remote's; null when neither exists.
function branchTip(cwd, state, branch) {
  return revParse(`refs/heads/${branch}`, { cwd }) ?? (state.remote ? revParse(`refs/remotes/${state.remote}/${branch}`, { cwd }) : null);
}

// The tip a `prs` phase starts from: its parent's, the trunk, an earlier phase's branch or a named branch.
function parentTip(cwd, state, phase) {
  if (phase.parent === state.trunk) return trunkTip(cwd, state.trunk, state.remote);
  return branchTip(cwd, state, phase.parent) ?? fail(EXIT_REFUSED, `phase ${phase.n}'s parent ${phase.parent} does not exist`);
}

// The phase of the plan a `prs` phase branches from; undefined when its parent is the trunk or a named branch.
const parentPhase = (state, phase) => state.phases.find((p) => p.branch === phase.parent);

// The start of a new phase branch: the previous phase's tip (or the trunk's), local branch first, else the remote's. A
// `prs` phase starts at its parent's tip.
function startPoint(cwd, state, n) {
  if (layoutOf(state) === 'prs') return parentTip(cwd, state, state.phases.find((p) => p.n === n));
  if (n === 1) return trunkTip(cwd, state.trunk, state.remote);
  const prev = state.phases.find((p) => p.n === n - 1).branch;
  const tip = branchTip(cwd, state, prev);
  return tip ?? fail(EXIT_REFUSED, `phase ${n - 1}'s branch ${prev} does not exist`);
}

// The state entries a phase starts from. v2: each branch of `parents ?? [parent]` that is a phase branch of the state (the
// trunk and a named branch give none); v1: the previous phase, none for phase 1.
export function parentsOf(state, phase) {
  if (layoutOf(state) !== 'prs') return state.phases.filter((p) => p.n === phase.n - 1);
  return (phase.parents ?? [phase.parent]).map((b) => state.phases.find((p) => p.branch === b)).filter(Boolean);
}

// The pending phases whose every parent entry has started (is in a state the next phase may start after), ascending.
export function readyPhases(state) {
  const started = STARTED_AFTER[state.mode === 'local' ? 'local' : 'github'];
  return state.phases
    .filter((phase) => phase.state === 'pending' && parentsOf(state, phase).every((p) => started.includes(p.state)))
    .map((phase) => phase.n)
    .sort((a, b) => a - b);
}

// The commit a phase's own work starts after: the recorded `base`; null when its branch has no tip; else the floor as it
// was computed before `base` existed: the start point of a phase that has a parent entry, else where the branch forked
// from the trunk (or from a named branch).
export function phaseBase(cwd, state, phase) {
  if (phase.base) return phase.base;
  const tip = branchTip(cwd, state, phase.branch);
  if (!tip) return null;
  const start = startPoint(cwd, state, phase.n);
  return parentsOf(state, phase).length > 0 ? start : git(['merge-base', start, tip], { cwd });
}

// A join's `base` when none is recorded: the first commit, oldest first, of `git rev-list --first-parent --reverse <first parent's
// branch>..<head>` that has as many parents as the join (`git rev-list --parents -n 1 <commit>`). None found is exit 3.
function joinCommitOf(cwd, phase, firstTip, head, count) {
  const walked = git(['rev-list', '--first-parent', '--reverse', `${firstTip}..${head}`], { cwd });
  const found = (walked ? walked.split('\n') : []).find((c) => git(['rev-list', '--parents', '-n', '1', c], { cwd }).split(' ').length - 1 === count);
  return found ?? fail(EXIT_REFUSED, `phase ${phase.n}'s branch ${phase.branch} has no join commit of its ${count} parents: delete the branch and run phase ${phase.n} again`);
}

// git merge-tree --write-tree of two commits: { tree, conflicts } (conflicts: the paths, empty when the merge is clean).
function mergeTrees(cwd, a, b) {
  const res = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && res.status !== 1) throw new Error(`git merge-tree ${a} ${b} failed: ${res.stderr.trim()}`);
  const [tree, ...names] = res.stdout.split('\0');
  return { tree, conflicts: res.status === 1 ? [...new Set(names.filter((name) => name !== ''))] : [] };
}

// The commit a join phase starts at, made without any checkout: the first two parent tips are merged, then that result (a
// commit-tree object on no branch) and each next parent; one commit of the last tree has a parent per tip, in written order. A
// conflict is exit 3 and nothing exists but loose objects.
function makeJoinCommit(cwd, phase, branches, tips) {
  const message = `Join of phase ${phase.n}: ${branches.join(', ')}`;
  let left = tips[0];
  let tree;
  tips.slice(1).forEach((tipSha, i) => {
    const merged = mergeTrees(cwd, left, tipSha);
    if (merged.conflicts.length > 0) fail(EXIT_REFUSED, `the join of phase ${phase.n} conflicts in ${merged.conflicts.join(', ')}: nothing was created`);
    tree = merged.tree;
    if (i < tips.length - 2) left = git(['commit-tree', tree, '-p', left, '-p', tipSha, '-m', message], { cwd });
  });
  return git(['commit-tree', tree, ...tips.flatMap((tipSha) => ['-p', tipSha]), '-m', message], { cwd });
}

// Where a phase is built: its own worktree when the state records one, else the main checkout.
export const workdirOf = (root, phase) => phase.workdir ?? root;

// Phase 1 starts at the trunk's tip, so a HEAD on another branch with commits the trunk lacks (a run that began before
// stacked execution, finished on its own feature branch) would be left behind: refuse, naming that branch.
function refuseStrandedHead(cwd, state) {
  const current = currentBranch(cwd);
  if (current === state.trunk) return;
  const ahead = Number(git(['rev-list', '--count', `${trunkTip(cwd, state.trunk, state.remote)}..HEAD`], { cwd }));
  if (ahead === 0) return;
  fail(
    EXIT_REFUSED,
    `HEAD is on ${current ?? 'a detached HEAD'}, which has ${ahead} commit(s) the trunk ${state.trunk} lacks: phase 1 would start from ` +
      `the trunk and strand them. Finish that branch as before, or move its work onto the trunk's history first`,
  );
}

// --- phase worktrees --------------------------------------------------------------------------------------------

const WORKTREES_IGNORE = '.claude/worktrees/';
// How a phase's dependencies are installed, by its lockfile (the table of task-open --worktree).
const LOCKFILES = [
  ['package-lock.json', ['npm', 'ci']],
  ['pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
  ['yarn.lock', ['yarn', 'install', '--frozen-lockfile']],
];

// A phase worktree sits at <main root>/.claude/worktrees/<plan stem>-p<N>, on the phase's own branch.
const phaseWorktree = (root, planFile, n) => join(root, '.claude', 'worktrees', `${basename(planFile, '.md')}-p${n}`);

// The worktrees `git worktree list --porcelain` shows, [{ path, branch }] (branch null when detached); one whose directory is gone is left out.
function worktreeList(cwd) {
  return git(['worktree', 'list', '--porcelain'], { cwd })
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((l) => l.startsWith('branch refs/heads/'));
      return { path, branch: ref ? ref.slice('branch refs/heads/'.length) : null };
    })
    .filter((w) => w.path && existsSync(w.path));
}

// Whether a worktree is registered at `path` on `branch`.
const inWorktree = (cwd, path, branch) => worktreeList(cwd).some((w) => w.path === path && w.branch === branch);

// `.claude/worktrees/` goes into the repository's info/exclude once.
function excludeWorktrees(cwd) {
  const file = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(WORKTREES_IGNORE)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${WORKTREES_IGNORE}\n`);
}

// Installs a phase worktree's dependencies by its lockfile; a marker in the worktree's git dir makes a re-entry install again
// only after a failed install. A failure is exit 1 with the install's first stderr line.
function installDependencies(path) {
  const marker = join(git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: path }), 'triqual-installed');
  const lockfile = LOCKFILES.find(([name]) => existsSync(join(path, name)));
  if (!lockfile || existsSync(marker)) return;
  const [command, ...commandArgs] = lockfile[1];
  const res = spawnSync(command, commandArgs, { cwd: path, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const cause = res.error ? res.error.message : res.stderr;
  if (res.error || res.status !== 0) {
    fail(1, `${lockfile[1].join(' ')}: ${String(cause).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? `exited ${res.status}`}`);
  }
  writeFileSync(marker, `${lockfile[1].join(' ')}\n`);
}

// The checkout that has a phase's branch checked out (a worktree path, the main root for the main checkout), or null.
const checkoutOf = (cwd, branch) => worktreeList(cwd).find((w) => w.branch === branch)?.path ?? null;

// The other phase that holds the main checkout: active with no worktree.
const holdingMain = (state, n) => state.phases.find((p) => p.n !== n && p.state === 'active' && !p.workdir);

// Enters phase N, in the order that keeps the state lock off every git command that touches a worktree: (1) read the state, run
// the parent checks and decide whether the phase needs a worktree; (2) outside the lock, create the branch and the worktree, or
// run the main checkout's read-only checks; (3) one updateState makes the checkout choice from the state it re-reads and records
// `active` and `workdir` in the same write; (4) outside the lock, switch the main checkout to the branch, or install the worktree's
// dependencies.
function cmdPhase(args) {
  const usage = 'usage: stack.mjs phase PLAN_FILE N';
  const ctx = context(args[0]);
  const state = loadState(ctx);
  const phase = phaseOf(state, args[1], usage);
  const branch = branchOf(phase);
  if (!ENTERABLE.includes(phase.state)) {
    fail(EXIT_REFUSED, `phase ${phase.n} is ${phase.state}: its commits are final, it is not entered again`);
  }
  const prs = layoutOf(state) === 'prs';
  const allowed = state.mode === 'local' ? STARTED_AFTER.local : STARTED_AFTER.github;
  for (const prev of parentsOf(state, phase)) {
    if (!allowed.includes(prev.state)) {
      fail(EXIT_REFUSED, `phase ${prev.n} is ${prev.state}: phase ${phase.n} needs it ${allowed.join(' or ')} (${state.mode} mode)`);
    }
  }
  // The time is read before any write: a TRIQUAL_NOW that is no time leaves the branch and the state as they were.
  const at = nowIso();
  const path = phaseWorktree(ctx.root, ctx.planFile, phase.n);
  const remoteRef = state.remote ? `refs/remotes/${state.remote}/${branch}` : null;
  const hasBranch = revParse(`refs/heads/${branch}`, { cwd: ctx.cwd }) !== null;
  const remoteOnly = !hasBranch && remoteRef !== null && revParse(remoteRef, { cwd: ctx.cwd }) !== null;

  // 1. A phase is in its worktree when one is registered at the path on the phase's branch, whether or not the state records it
  // (a crash between `worktree add` and the state write leaves exactly that). Otherwise it needs one when another phase holds the
  // main checkout, or when its recorded worktree is gone.
  // A join starts at the commit that merges its parents, made here before any checkout, branch or state write; a join branch that exists
  // with no recorded base gets its join commit found by the rule (nothing is written when there is none).
  const parents = prs ? phase.parents ?? [phase.parent] : [];
  let joinStart = null;
  let joinFound = null;
  if (parents.length > 1) {
    const tipOf = (b) => branchTip(ctx.cwd, state, b) ?? fail(EXIT_REFUSED, `phase ${phase.n}'s parent ${b} does not exist`);
    if (!hasBranch && !remoteOnly) joinStart = phase.base ?? makeJoinCommit(ctx.cwd, phase, parents, parents.map(tipOf));
    else if (!phase.base) joinFound = joinCommitOf(ctx.cwd, phase, tipOf(parents[0]), branchTip(ctx.cwd, state, branch), parents.length);
  }
  const inItsWorktree = hasBranch && inWorktree(ctx.cwd, path, branch);
  const needsWorktree = !inItsWorktree && (Boolean(phase.workdir) || holdingMain(state, phase.n) !== undefined);

  // 2. Outside the lock.
  let created = null;
  if (needsWorktree) {
    if (!hasBranch) {
      if (remoteOnly) {
        git(['branch', '--quiet', '--track', branch, remoteRef], { cwd: ctx.cwd });
      } else {
        created = joinStart ?? startPoint(ctx.cwd, state, phase.n);
        git(['branch', '--quiet', '--no-track', branch, created], { cwd: ctx.cwd });
      }
    }
    // A recorded worktree that is gone (no directory, or no longer registered): prune the leftover, add it again from the branch.
    if (phase.workdir) git(['worktree', 'prune'], { cwd: ctx.cwd });
    excludeWorktrees(ctx.cwd);
    git(['worktree', 'add', '--quiet', path, branch], { cwd: ctx.cwd });
  } else if (inItsWorktree) {
    requireCleanTree(path);
  } else {
    requireCleanTree(ctx.cwd);
    if (!hasBranch && !remoteOnly) {
      if (prs ? phase.parent === state.trunk : phase.n === 1) refuseStrandedHead(ctx.cwd, state);
      created = joinStart ?? startPoint(ctx.cwd, state, phase.n);
    }
  }

  // 3. One write: the checkout is chosen from the state re-read under the lock and recorded in it.
  const next = updateState(ctx, (fresh) => {
    const entry = fresh.phases.find((p) => p.n === phase.n);
    if (inWorktree(ctx.cwd, path, branch)) {
      entry.workdir = path;
    } else {
      const holder = holdingMain(fresh, phase.n);
      if (holder) fail(EXIT_REFUSED, `phase ${holder.n} holds the main checkout: run phase ${phase.n} again`);
    }
    if (entry.state === 'pending') entry.startedAt = at;
    entry.state = 'active';
    // A v2 phase records the commit its own work starts after (a v1 branch can be restacked by gh stack: it keeps the computed floor).
    if (prs && (created ?? joinFound) && !entry.base) entry.base = created ?? joinFound;
  });

  // 4. Outside the lock.
  if (next.phases.find((p) => p.n === phase.n).workdir) {
    installDependencies(path);
    out(branch);
    return out(`workdir: ${path}`);
  }
  if (hasBranch) {
    git(['switch', '--quiet', branch], { cwd: ctx.cwd });
  } else if (remoteOnly) {
    // Review Focus 3: a branch on the remote only (a resumed run elsewhere) is checked out tracking it.
    git(['switch', '--quiet', '-c', branch, '--track', remoteRef], { cwd: ctx.cwd });
  } else {
    git(['switch', '--quiet', '--no-track', '-c', branch, created], { cwd: ctx.cwd });
  }
  return out(branch);
}

// R3: every commit of BASE..HEAD folded into one with commit-tree (HEAD's tree, parent BASE, the first commit's message
// and author), then reset --soft. Never a rebase and never git commit, so no hook runs and nothing can conflict.
function cmdSquash(args) {
  const usage = 'usage: stack.mjs squash PLAN_FILE BASE [--phase N]';
  // Only --phase is an option here: any other argument is positional, so a BASE that looks like an option reaches git as a ref.
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--phase') {
      rest.push(args[i]);
      continue;
    }
    if (i + 1 >= args.length) fail(EXIT_USAGE, '--phase needs a value');
    opts.phase = args[++i];
  }
  const ctx = context(rest[0]);
  if (rest[1] === undefined) fail(EXIT_USAGE, usage);
  const state = loadState(ctx);
  // The phase: --phase N (it must be active), else the only active phase.
  const actives = state.phases.filter((p) => p.state === 'active');
  let active;
  if (opts.phase !== undefined) {
    active = phaseOf(state, opts.phase, usage);
    if (active.state !== 'active') fail(EXIT_REFUSED, `phase ${active.n} is ${active.state}: only an active phase is squashed`);
  } else if (actives.length > 1) {
    fail(EXIT_REFUSED, `several phases are active (${actives.map((p) => `P${p.n}`).join(', ')}): name one with --phase N`);
  } else {
    active = actives[0];
  }
  // It runs in the phase's own checkout: its clean tree, its HEAD and branch, and its reset --soft.
  const cwd = active ? workdirOf(ctx.root, active) : ctx.cwd;
  requireCleanTree(cwd);
  let current = null;
  try {
    current = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  } catch {
    // detached HEAD
  }
  if (!active || current !== active.branch) {
    const where = current ? `HEAD is on ${current}` : 'HEAD is detached';
    const want = active ? `the active phase's branch ${active.branch}` : "the active phase's branch: no phase is active";
    fail(EXIT_REFUSED, `${where}, not ${want}`);
  }
  let base;
  try {
    base = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rest[1]}^{commit}`], { cwd });
  } catch {
    return fail(EXIT_REFUSED, `BASE "${rest[1]}" is not a commit`);
  }
  if (!gitOk(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd })) {
    fail(EXIT_REFUSED, `BASE ${base} is not an ancestor of HEAD (${active.branch})`);
  }
  // R1: the range stays inside the active phase. Its start is the phase's floor (phaseBase: the recorded base, else the
  // parent phase's tip, or where HEAD forked from the trunk or a named branch); a BASE under it would fold an earlier
  // phase's (or the trunk's) commits into this one.
  let start;
  try {
    start = phaseBase(cwd, state, active);
  } catch (e) {
    if (e instanceof StackError) throw e;
    return fail(EXIT_REFUSED, `${active.branch} shares no history with the trunk ${state.trunk}`);
  }
  if (!gitOk(['merge-base', '--is-ancestor', start, base], { cwd })) {
    fail(EXIT_REFUSED, `BASE ${base} is below the start of phase ${active.n} (${start}): it would fold commits that are not this phase's`);
  }
  const range = git(['rev-list', '--reverse', `${base}..HEAD`], { cwd });
  const commits = range ? range.split('\n') : [];
  if (commits.length === 0) return out('no commits');
  if (commits.length === 1) return out(commits[0]);

  const [name, email, date, message] = git(['log', '--format=%an%x00%ae%x00%aI%x00%B', '-1', commits[0]], { cwd }).split('\0');
  const tree = git(['rev-parse', 'HEAD^{tree}'], { cwd });
  const sha = git(['commit-tree', tree, '-p', base, '-F', '-'], {
    cwd,
    input: `${message}\n`,
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
  });
  git(['reset', '--quiet', '--soft', sha], { cwd });
  return out(sha);
}

// The caller ran the Phase check; the script runs no tests.
function cmdDone(args) {
  const ctx = context(args[0]);
  const state = loadState(ctx);
  const phase = phaseOf(state, args[1], 'usage: stack.mjs done PLAN_FILE N');
  // Only an active phase becomes done (again on a done phase: a no-op). A pending phase has no branch for the next
  // one to start from; a submitted, ready or merged one never moves back.
  if (phase.state !== 'active' && phase.state !== 'done') {
    fail(EXIT_REFUSED, `phase ${phase.n} is ${phase.state}: only an active phase is marked done`);
  }
  if (phase.state === 'active') {
    // A phase built in a worktree: it is removed as removeWorktree (lib/task-common.mjs) does, outside the lock and before the
    // state write. A tracked file changed there is refused with nothing written; untracked files go with the worktree; the branch stays.
    if (phase.workdir && worktreeList(ctx.cwd).some((w) => w.path === phase.workdir)) {
      if (git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: phase.workdir })) {
        fail(
          EXIT_REFUSED,
          `phase ${phase.n}'s worktree ${phase.workdir} has uncommitted changes to tracked files: commit or discard them, then run done again`,
        );
      }
      git(['worktree', 'remove', '--force', phase.workdir], { cwd: ctx.cwd });
    }
    updateState(ctx, (fresh) => {
      const entry = fresh.phases.find((p) => p.n === phase.n);
      if (entry.state !== 'active') return false;
      entry.state = 'done';
      entry.doneAt = nowIso();
    });
  }
  return out(`phase ${phase.n} done`);
}

// --- submit -----------------------------------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// The lines `gh stack submit` (v0.1.1) prints when the PRs are linked as a GitHub stack: created, already up to date,
// updated or recreated. The link is not in `gh stack view --json`.
const STACK_LINKED = /stack #\d+|\bstack\b.*\b(created|synced|updated|up to date|recreated)\b|\b(created|updated) stack\b/i;
const LINK_MISSING = '; stack link missing';
// With --open every phase must already be submitted or ready; local mode also takes done, its final state.
const OPENABLE = { github: ['submitted', 'ready'], local: ['done', 'submitted', 'ready'] };

function switchTo(cwd, branch) {
  checkRef(branch, 'branch');
  try {
    git(['switch', '--quiet', branch], { cwd });
  } catch (e) {
    fail(EXIT_REFUSED, `cannot check out ${branch}: ${oneLine(e.stderr ?? e.message)}`);
  }
}

// The plan's workspace directory, as `sdd-workspace PLAN_FILE` prints it.
function workspaceOf(ctx) {
  const res = spawnSync(process.execPath, [join(SCRIPT_DIR, 'sdd-workspace'), ctx.planFile], {
    cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error || res.status !== 0) {
    fail(EXIT_USAGE, `sdd-workspace failed: ${oneLine(res.error ? res.error.message : res.stderr)}`);
  }
  return res.stdout.trim();
}

// What a `prs` PR body says about its base: the branch it is against, and that a phase's PR merges after its parent's.
// A join's PR is against its first parent and says it also merges the others.
const baseText = (state, phase) => {
  const others = (phase.parents ?? []).slice(1).map((b) => `\`${b}\``);
  const first = `\`${phase.parent}\`${parentPhase(state, phase) ? `, phase ${parentPhase(state, phase).n}'s branch: merge its PR first` : ''}`;
  return others.length > 0 ? `${first}. It also merges ${others.join(', ')}: merge those first.` : first;
};

// The PR body: the plan's phase block (Slice, Stands alone because, Phase check) and the subjects of the phase's
// commits (the range from the previous phase's tip, or the trunk's, to this phase's branch).
function prBody(ctx, state, phase) {
  const { phases } = parsePhases(readFileSync(ctx.planFile, 'utf8'), ctx.planFile);
  const block = phases.find((p) => p.n === phase.n);
  const subjects = git(['log', '--reverse', '--format=%s', `${startPoint(ctx.cwd, state, phase.n)}..${branchOf(phase)}`], {
    cwd: ctx.cwd,
  });
  const sections = [
    ['Slice', block?.slice],
    ['Base', layoutOf(state) === 'prs' ? baseText(state, phase) : null],
    ['Stands alone because', block?.standsAlone],
    ['Phase check', block?.check],
    ['Commits', subjects ? subjects.split('\n').map((subject) => `- ${subject}`).join('\n') : null],
  ];
  return `${sections.filter(([, text]) => text).map(([title, text]) => `## ${title}\n\n${text}`).join('\n\n')}\n`;
}

// `gh stack submit` pushes every member, so before any gh write the stack must be this plan's: the trunk the state's and
// the members a prefix of the plan's phase branches, in phase order from phase 1.
function requireOwnStack(state, view, members) {
  if (!view) return;
  if (view.trunk !== state.trunk) {
    fail(EXIT_REFUSED, `the gh stack's trunk is ${view.trunk}, the plan's is ${state.trunk}: it is not this plan's stack`);
  }
  members.forEach((name, i) => {
    const expected = state.phases[i]?.branch;
    if (name === expected) return;
    const mine = state.phases.some((p) => p.branch === name);
    fail(
      EXIT_REFUSED,
      mine
        ? `the gh stack lists ${name} out of phase order (position ${i + 1} is ${expected ?? 'beyond the plan'}): not pushing`
        : `the gh stack has ${name}, which is not a phase branch of this plan: not pushing`,
    );
  });
}

// R8: with HEAD on phase N-1's branch (phase 1's for N=1) read the stack's members; none: init it with phase 1's branch;
// then add, one at a time from the stack's top, each later phase branch up to N that is not a member (gh adopts the
// existing branch and moves HEAD onto it). A second call finds every branch a member and runs nothing but the view.
function reconcileStack(ctx, state, n) {
  const { cwd } = ctx;
  const phases = state.phases.filter((p) => p.n <= n);
  switchTo(cwd, branchOf(phases[Math.max(n - 2, 0)]));
  const view = ghStackView({ cwd });
  let members = (view?.branches ?? []).map((b) => b.name);
  requireOwnStack(state, view, members);
  if (members.length === 0) {
    gh(['stack', 'init', '--base', state.trunk, branchOf(phases[0])], { cwd });
    members = [phases[0].branch];
  }
  for (const phase of phases.slice(1)) {
    if (members.includes(phase.branch)) continue;
    switchTo(cwd, members.at(-1));
    gh(['stack', 'add', branchOf(phase)], { cwd });
    members.push(phase.branch);
  }
}

function currentBranch(cwd) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  } catch {
    return null;
  }
}

// The GitHub-mode preconditions of submit and push, then the PR body written to the plan's workspace: { slug, bodyFile }.
function prepareGithub(ctx, state, phase) {
  const { cwd } = ctx;
  if (!state.remote) fail(EXIT_REFUSED, 'the state records no remote: switch with stack mode local, or run stack mode github');
  // The `prs` layout checks the checkout where the phase's branch is checked out (none when it is checked out nowhere); the `stack`
  // layout moves HEAD in the main checkout, so it checks that one.
  if (layoutOf(state) === 'prs') {
    const holder = checkoutOf(cwd, branchOf(phase));
    if (holder) requireCleanTree(holder);
  } else {
    requireCleanTree(cwd);
  }
  // --repo on pr edit: with several remotes or a default repo set to an upstream, a bare number may name another repo's PR.
  const slug = githubSlug(state.remote, cwd);
  if (!slug) fail(EXIT_REFUSED, `remote "${state.remote}" is no longer a GitHub remote: switch with stack mode local`);
  if (layoutOf(state) === 'stack' && githubRemote(state.remote, cwd)?.alias) {
    fail(EXIT_REFUSED, `remote "${state.remote}" is an SSH alias gh stack cannot address: delete the state and run stack init again to use the prs layout`);
  }

  const bodyFile = join(workspaceOf(ctx), `pr-body-${String(phase.n).padStart(2, '0')}.md`);
  writeFileSync(bodyFile, prBody(ctx, state, phase));
  return { slug, bodyFile };
}

// Reconciles the stack, checks phase N's branch out and runs gh stack submit (with --open, the PRs leave draft); then reads
// the stack back: { submitted (gh's output), prs (branch -> PR number), prOf (phase -> PR number, exit 5 when none) }.
function submitStack(ctx, state, phase, open) {
  const { cwd } = ctx;
  reconcileStack(ctx, state, phase.n);
  switchTo(cwd, branchOf(phase));
  // gh-stack v0.1.1 prints every status line to stderr and nothing to stdout: the link test reads both.
  const result = ghRun(['stack', 'submit', '--auto', ...(open ? ['--open'] : []), '--remote', state.remote], { cwd });
  const submitted = `${result.stdout}\n${result.stderr}`;
  const prs = new Map();
  for (const b of ghStackView({ cwd })?.branches ?? []) if (b.pr?.number) prs.set(b.name, b.pr.number);
  const prOf = (p) => prs.get(p.branch) ?? fail(EXIT_GH, `gh stack view --json shows no PR for ${p.branch} after the submit`);
  return { submitted, prs, prOf };
}

// --- submit and push, `prs` layout: a plain push and a plain draft PR per phase, against its parent --------------------

// A plain push (never --force: a rejected one exits 5). `upstream` also sets the branch's upstream.
function pushBranch(cwd, state, phase, upstream) {
  try {
    git(['push', ...(upstream ? ['--set-upstream'] : []), state.remote, branchOf(phase)], { cwd });
  } catch (e) {
    fail(EXIT_GH, `git push ${state.remote} ${phase.branch} failed: ${oneLine(e.stderr ?? e.message)}`);
  }
}

// A phase is submitted once its parents are: each parent phase submitted, ready or merged, a named branch on the remote.
function requireParentSubmitted(cwd, state, phase) {
  const parents = parentsOf(state, phase);
  const unmet = parents.find((p) => !['submitted', 'ready', 'merged'].includes(p.state));
  if (unmet) {
    fail(EXIT_REFUSED, `phase ${unmet.n} is ${unmet.state}: phase ${phase.n}'s parent must be submitted, ready or merged first`);
  } else if (parents.length === 0 && phase.parent !== state.trunk && !revParse(`refs/remotes/${state.remote}/${phase.parent}`, { cwd })) {
    fail(EXIT_REFUSED, `phase ${phase.n}'s parent ${phase.parent} is not on ${state.remote}: push it and fetch first`);
  }
}

// Pushes the phase, adopts its open PR or opens a draft one against its parent; with --open every phase's PR leaves draft.
function submitPrs(ctx, state, phase, open, { slug, bodyFile }) {
  const { cwd } = ctx;
  if (open) {
    for (const p of state.phases) gh(['pr', 'ready', String(p.pr), '--repo', slug], { cwd });
    updateState(ctx, (fresh) => {
      for (const p of fresh.phases) p.state = 'ready';
    });
    for (const p of state.phases) p.state = 'ready';
    return out(state.phases.map((p) => `Phase ${p.n}: ready (${p.branch}, PR #${p.pr})`).join('\n'));
  }
  pushBranch(cwd, state, phase, true);
  const [found] = JSON.parse(gh(['pr', 'list', '--repo', slug, '--head', phase.branch, '--state', 'open', '--json', 'number'], { cwd }));
  let number = found?.number;
  if (number === undefined) {
    const created = gh(
      ['pr', 'create', '--repo', slug, '--draft', '--base', phase.parent, '--head', phase.branch, '--title', phase.title, '--body-file', bodyFile],
      { cwd },
    );
    number = Number(/\/pull\/(\d+)\s*$/.exec(created)?.[1]);
    if (!number) fail(EXIT_GH, `gh pr create printed no PR URL for ${phase.branch}`);
  }
  updateState(ctx, (fresh) => {
    Object.assign(fresh.phases.find((p) => p.n === phase.n), { pr: number, state: 'submitted' });
  });
  Object.assign(phase, { pr: number, state: 'submitted' });
  return out(`Phase ${phase.n}: submitted (${phase.branch}, PR #${number} draft, base ${phase.parent})`);
}

function cmdSubmit(args) {
  const usage = 'usage: stack.mjs submit PLAN_FILE N [--open]';
  const open = args.includes('--open');
  const rest = args.filter((a) => a !== '--open');
  const unknown = rest.find((a) => a.startsWith('--'));
  if (unknown) fail(EXIT_USAGE, `unknown option ${unknown}`);
  const ctx = context(rest[0]);
  const { cwd } = ctx;
  const state = loadState(ctx);
  const phase = phaseOf(state, rest[1], usage);

  if (open) {
    const allowed = OPENABLE[state.mode === 'local' ? 'local' : 'github'];
    const blocked = state.phases.find((p) => !allowed.includes(p.state));
    if (blocked) fail(EXIT_REFUSED, `phase ${blocked.n} is ${blocked.state}: --open needs every phase ${allowed.join(' or ')}`);
  } else if (phase.state !== 'done') {
    fail(EXIT_REFUSED, `phase ${phase.n} is ${phase.state}: only a done phase is submitted`);
  }
  if (state.mode === 'local') return out('local mode: nothing to submit');
  const prs = layoutOf(state) === 'prs';
  if (prs && !open) requireParentSubmitted(cwd, state, phase);
  const github = prepareGithub(ctx, state, phase);
  if (prs) return submitPrs(ctx, state, phase, open, github);
  const { slug, bodyFile } = github;

  const startedOn = currentBranch(cwd);
  let lines;
  try {
    const { submitted, prs, prOf } = submitStack(ctx, state, phase, open);
    const touched = open ? state.phases : [phase];
    const numbers = touched.map(prOf);
    gh(['pr', 'edit', String(prOf(phase)), '--repo', slug, '--title', phase.title, '--body-file', bodyFile], { cwd });

    // The gh calls are done: one updateState sets the touched phases' pr and state.
    updateState(ctx, (fresh) => {
      for (const [i, p] of touched.entries()) Object.assign(fresh.phases.find((q) => q.n === p.n), { pr: numbers[i], state: open ? 'ready' : 'submitted' });
    });
    for (const [i, p] of touched.entries()) Object.assign(p, { pr: numbers[i], state: open ? 'ready' : 'submitted' });
    lines = touched.map((p) => (open ? `Phase ${p.n}: ready (${p.branch}, PR #${p.pr})` : `Phase ${p.n}: submitted (${p.branch}, PR #${p.pr} draft)`));
    if (prs.size >= 2 && !STACK_LINKED.test(submitted)) lines[lines.length - 1] += LINK_MISSING;
  } catch (e) {
    // HEAD goes back to where the call found it (reconcile moves it to phase N-1 and along the stack).
    if (startedOn && currentBranch(cwd) !== startedOn) gitOk(['switch', '--quiet', startedOn], { cwd });
    throw e;
  }
  return out(lines.join('\n'));
}

// Pushes a submitted (draft or ready) phase again, after review fixes: the stack is reconciled and submitted without
// --open, and the PR body is rewritten. The PR's draft state, its title and the state file stay as they were.
// `gh stack submit --auto` pushes every member of this plan's stack (requireOwnStack limits the members to the plan's
// phase branches, in order) and never marks a PR ready. A PR number in `gh stack view` that differs from the recorded
// one exits 5 before any body is edited.
function cmdPush(args) {
  const usage = 'usage: stack.mjs push PLAN_FILE N';
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) fail(EXIT_USAGE, `unknown option ${unknown}`);
  const ctx = context(args[0]);
  const { cwd } = ctx;
  const state = loadState(ctx);
  const phase = phaseOf(state, args[1], usage);
  if (state.mode === 'local') return out('local mode: nothing pushed');
  if (phase.pr === null || !['submitted', 'ready'].includes(phase.state)) {
    fail(EXIT_REFUSED, `phase ${phase.n} is ${phase.state}: only a submitted or ready phase is pushed (submit it first)`);
  }
  const { slug, bodyFile } = prepareGithub(ctx, state, phase);
  if (layoutOf(state) === 'prs') {
    pushBranch(cwd, state, phase, false);
    gh(['pr', 'edit', String(phase.pr), '--repo', slug, '--body-file', bodyFile], { cwd });
    return out(`Phase ${phase.n}: pushed (${phase.branch}, PR #${phase.pr})`);
  }

  const startedOn = currentBranch(cwd);
  try {
    const { submitted, prs, prOf } = submitStack(ctx, state, phase, false);
    const number = prOf(phase);
    // The recorded PR may have been closed and --auto may have opened a new draft: no body is edited, nothing recorded.
    if (number !== phase.pr) {
      fail(EXIT_GH, `phase ${phase.n}: the state records PR #${phase.pr} but gh stack view shows PR #${number} for ${phase.branch}`);
    }
    gh(['pr', 'edit', String(number), '--repo', slug, '--body-file', bodyFile], { cwd });
    const linkMissing = prs.size >= 2 && !STACK_LINKED.test(submitted) ? LINK_MISSING : '';
    return out(`Phase ${phase.n}: pushed (${phase.branch}, PR #${number})${linkMissing}`);
  } catch (e) {
    if (startedOn && currentBranch(cwd) !== startedOn) gitOk(['switch', '--quiet', startedOn], { cwd });
    throw e;
  }
}

const COMMANDS = {
  init: cmdInit,
  mode: cmdMode,
  path: cmdPath,
  status: cmdStatus,
  phase: cmdPhase,
  squash: cmdSquash,
  done: cmdDone,
  submit: cmdSubmit,
  push: cmdPush,
};

export function main(argv) {
  try {
    const [command, ...args] = argv;
    const run = COMMANDS[command];
    if (!run) fail(EXIT_USAGE, `usage: stack.mjs <${Object.keys(COMMANDS).join('|')}> PLAN_FILE ...`);
    run(args);
    return 0;
  } catch (e) {
    process.stderr.write(`stack: ${e.message}\n`);
    return e instanceof StackError ? e.code : 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
