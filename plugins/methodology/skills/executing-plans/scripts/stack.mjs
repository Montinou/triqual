#!/usr/bin/env node
// Owns every git and gh operation of a stacked plan execution: one branch (and, in GitHub mode, one draft PR) per
// plan phase: plan parsing, the state file, mode detection and the init, mode, path, status, phase, squash, done and
// submit commands.
//
// Usage: stack.mjs <command> PLAN_FILE ...
//   init PLAN_FILE [--trunk <b>] [--mode github|local] [--remote <r>]   print the state (JSON), writing it first time
//   mode PLAN_FILE github|local                                         switch the mode (github re-runs the checks)
//   path PLAN_FILE                                                      print the state file's path
//   status PLAN_FILE                                                    print the state (JSON), PR states refreshed
//   phase PLAN_FILE N                                                   check out phase N's branch, mark it active
//   squash PLAN_FILE BASE                                               fold BASE..HEAD into one commit, print its sha
//   done PLAN_FILE N                                                    mark phase N done
//   submit PLAN_FILE N [--open]                                         reconcile gh stack, submit, fill phase N's PR
//
// Exit codes: 0 ok, 2 usage or malformed plan, 3 refused precondition, 5 a gh command failed.
// Node built-ins, git and gh only. Every gh call is non-interactive.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanError, readPhases } from './lib/plan.mjs';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_GH = 5;
const STATE_VERSION = 1;
const COMMITTED_MODE_MESSAGE =
  'committed tracking mode cannot hold one commit per task: switch with triqual progress-init --store (or --local)';

// GitHub remote URL forms, as regex literals only: owner is group 1, repository group 2.
const GITHUB_URL_FORMS = [
  /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  /^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
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

// Phases of a plan: { prefix, phases: [{ n, title, slice, branch, prTitle, standsAlone, check, tasks }] }, read with the
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
  return { prefix: read.branchPrefix, phases };
}

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

// Atomic: the JSON goes to <path>.tmp, then a rename. .methodology/ keeps a self-ignoring .gitignore, as the SDD
// workspace does, so the state never shows in git status.
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const ignore = join(dirname(dirname(path)), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

// --- mode detection, remote and trunk ---------------------------------------------------------------------------

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function remoteNames(cwd) {
  const out = git(['remote'], { cwd });
  return out ? out.split('\n').sort() : [];
}

function githubSlug(remote, cwd) {
  let url;
  try {
    url = git(['remote', 'get-url', remote], { cwd });
  } catch {
    return null;
  }
  for (const form of GITHUB_URL_FORMS) {
    const m = form.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

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

// The four GitHub-mode checks, in order. { ok: true, remote, slug, ghStackVersion, defaultBranch } or
// { ok: false, reason } naming the first check that failed.
function checkGithub(cwd, requestedRemote) {
  try {
    gh(['--version'], { cwd });
  } catch (e) {
    return { ok: false, reason: `gh --version failed: ${oneLine(e.message)}` };
  }
  let ghStackVersion;
  try {
    ghStackVersion = oneLine(gh(['stack', '--version'], { cwd }));
  } catch (e) {
    return { ok: false, reason: `gh stack --version failed: ${oneLine(e.message)}` };
  }
  const remote = pickGithubRemote(cwd, requestedRemote);
  if (!remote) {
    const reason = requestedRemote
      ? `remote "${requestedRemote}" is not a GitHub remote`
      : 'no GitHub remote (neither origin nor another remote has a GitHub URL)';
    return { ok: false, reason };
  }
  const slug = githubSlug(remote, cwd);
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

// { cwd, root, planFile, path } for a command's PLAN_FILE argument.
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
  return { cwd, root, planFile, path: statePath(root, planFile) };
}

const out = (text) => process.stdout.write(`${text}\n`);
const printState = (state) => out(JSON.stringify(state, null, 2));

// Phases whose branch already exists when the state is first written: `done` when chained on the previous phase (or
// the trunk); in GitHub mode with the PR number, `submitted`, when gh finds one. An unchained branch exits 3.
function adoptExisting(cwd, phases, trunk, trunkSha, github) {
  let prevName = trunk;
  let prevSha = trunkSha;
  return phases.map((phase) => {
    const sha = revParse(`refs/heads/${phase.branch}`, { cwd });
    const entry = { n: phase.n, branch: phase.branch, title: phase.prTitle, pr: null, state: 'pending' };
    if (sha) {
      if (!prevSha) fail(EXIT_REFUSED, `branch ${phase.branch} exists but the previous phase's branch ${prevName} does not`);
      if (!gitOk(['merge-base', '--is-ancestor', prevSha, sha], { cwd })) {
        fail(EXIT_REFUSED, `branch ${phase.branch} is not chained on ${prevName}: its history lacks ${prevName}'s tip`);
      }
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
    prevName = phase.branch;
    prevSha = sha;
    return entry;
  });
}

// Mode and remote from the flags: local when asked or when a check fails (naming it); --mode github refuses (3).
function chooseMode(cwd, requestedMode, requestedRemote) {
  if (requestedMode === 'local') {
    return { mode: 'local', reason: '--mode local', ghStackVersion: null, remote: pickLocalRemote(cwd, requestedRemote) };
  }
  const found = checkGithub(cwd, requestedRemote);
  if (found.ok) return { mode: 'github', reason: null, ...found };
  if (requestedMode === 'github') fail(EXIT_REFUSED, `--mode github refused: ${found.reason}`);
  return { mode: 'local', reason: found.reason, ghStackVersion: null, remote: pickLocalRemote(cwd, requestedRemote) };
}

function cmdInit(args) {
  const { opts, rest } = parseOptions(args, ['trunk', 'mode', 'remote']);
  if (opts.mode && !['github', 'local'].includes(opts.mode)) fail(EXIT_USAGE, '--mode is github or local');
  const ctx = context(rest[0]);
  refuseCommittedTracking(ctx.cwd);
  const existing = readState(ctx.path);
  if (existing) return printState(existing);

  const { prefix, phases } = parsePhases(readFileSync(ctx.planFile, 'utf8'), ctx.planFile);
  if (revParse(`refs/heads/${prefix}`, { cwd: ctx.cwd })) {
    fail(EXIT_REFUSED, `branch "${prefix}" exists: it blocks the phase branches ${prefix}/NN-*; rename or delete it`);
  }
  const picked = chooseMode(ctx.cwd, opts.mode, opts.remote);
  const trunk = opts.trunk ?? picked.defaultBranch ?? localTrunk(ctx.cwd, picked.remote);
  const trunkSha = trunkTip(ctx.cwd, trunk, picked.remote);
  if (picked.mode === 'github') requireTrunkOnRemote(ctx.cwd, trunk, picked.remote);

  const state = {
    v: STATE_VERSION,
    plan: basename(ctx.planFile),
    mode: picked.mode,
    reason: picked.reason,
    ghStackVersion: picked.ghStackVersion,
    trunk,
    remote: picked.remote,
    phases: adoptExisting(ctx.cwd, phases, trunk, trunkSha, picked.mode === 'github' ? picked : null),
  };
  writeState(ctx.path, state);
  return printState(state);
}

function cmdMode(args) {
  const [planFile, mode] = args;
  if (!['github', 'local'].includes(mode)) fail(EXIT_USAGE, 'usage: stack.mjs mode PLAN_FILE github|local');
  const ctx = context(planFile);
  const state = readState(ctx.path);
  if (!state) fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
  if (mode === 'github') {
    const found = checkGithub(ctx.cwd, undefined);
    if (!found.ok) fail(EXIT_REFUSED, `cannot switch to github mode: ${found.reason}`);
    requireTrunkOnRemote(ctx.cwd, state.trunk, found.remote);
    Object.assign(state, { mode, reason: null, ghStackVersion: found.ghStackVersion, remote: found.remote });
  } else {
    Object.assign(state, { mode, reason: 'switched with stack mode local', ghStackVersion: null });
  }
  writeState(ctx.path, state);
  return out(`mode: ${state.mode}`);
}

function cmdPath(args) {
  return out(context(args[0]).path);
}

// GitHub mode: each recorded PR is read with gh pr view; a merged PR marks its phase merged.
function cmdStatus(args) {
  const ctx = context(args[0]);
  const state = readState(ctx.path);
  if (!state) fail(EXIT_REFUSED, `no stack state at ${ctx.path}: run stack init first`);
  if (state.mode === 'github') {
    const slug = state.remote ? githubSlug(state.remote, ctx.cwd) : null;
    let changed = false;
    for (const phase of state.phases) {
      if (phase.pr === null || phase.state === 'merged') continue;
      if (!slug) fail(EXIT_REFUSED, `remote "${state.remote}" is no longer a GitHub remote: switch with stack mode local`);
      const view = JSON.parse(gh(['pr', 'view', String(phase.pr), '--repo', slug, '--json', 'number,state,isDraft'], { cwd: ctx.cwd }));
      if (view.state === 'MERGED') {
        phase.state = 'merged';
        changed = true;
      }
    }
    if (changed) writeState(ctx.path, state);
  }
  return printState(state);
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

// Clean means tracked files only: untracked files never block phase or squash.
function requireCleanTree(cwd) {
  if (git(['status', '--porcelain', '--untracked-files=no'], { cwd })) {
    fail(EXIT_REFUSED, 'the working tree is not clean: commit or stash the changes to tracked files first');
  }
}

// A state-file branch name is checked before it reaches git, so a value starting with `-` is never an option.
function branchOf(phase) {
  checkRef(phase.branch, `phase ${phase.n} branch`);
  return phase.branch;
}

// The start of a new phase branch: the previous phase's tip (or the trunk's), local branch first, else the remote's.
function startPoint(cwd, state, n) {
  if (n === 1) return trunkTip(cwd, state.trunk, state.remote);
  const prev = state.phases.find((p) => p.n === n - 1).branch;
  const tip = revParse(`refs/heads/${prev}`, { cwd }) ?? (state.remote ? revParse(`refs/remotes/${state.remote}/${prev}`, { cwd }) : null);
  return tip ?? fail(EXIT_REFUSED, `phase ${n - 1}'s branch ${prev} does not exist`);
}

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

function cmdPhase(args) {
  const usage = 'usage: stack.mjs phase PLAN_FILE N';
  const ctx = context(args[0]);
  const state = loadState(ctx);
  const phase = phaseOf(state, args[1], usage);
  const branch = branchOf(phase);
  if (!ENTERABLE.includes(phase.state)) {
    fail(EXIT_REFUSED, `phase ${phase.n} is ${phase.state}: its commits are final, it is not entered again`);
  }
  requireCleanTree(ctx.cwd);
  if (phase.n > 1) {
    const prev = state.phases.find((p) => p.n === phase.n - 1);
    const allowed = state.mode === 'local' ? STARTED_AFTER.local : STARTED_AFTER.github;
    if (!allowed.includes(prev.state)) {
      fail(EXIT_REFUSED, `phase ${prev.n} is ${prev.state}: phase ${phase.n} needs it ${allowed.join(' or ')} (${state.mode} mode)`);
    }
  }

  const remoteRef = state.remote ? `refs/remotes/${state.remote}/${branch}` : null;
  if (revParse(`refs/heads/${branch}`, { cwd: ctx.cwd })) {
    git(['switch', '--quiet', branch], { cwd: ctx.cwd });
  } else if (remoteRef && revParse(remoteRef, { cwd: ctx.cwd })) {
    // Review Focus 3: a branch on the remote only (a resumed run elsewhere) is checked out tracking it.
    git(['switch', '--quiet', '-c', branch, '--track', remoteRef], { cwd: ctx.cwd });
  } else {
    if (phase.n === 1) refuseStrandedHead(ctx.cwd, state);
    git(['switch', '--quiet', '--no-track', '-c', branch, startPoint(ctx.cwd, state, phase.n)], { cwd: ctx.cwd });
  }
  phase.state = 'active';
  writeState(ctx.path, state);
  return out(branch);
}

// R3: every commit of BASE..HEAD folded into one with commit-tree (HEAD's tree, parent BASE, the first commit's message
// and author), then reset --soft. Never a rebase and never git commit, so no hook runs and nothing can conflict.
function cmdSquash(args) {
  const ctx = context(args[0]);
  if (args[1] === undefined) fail(EXIT_USAGE, 'usage: stack.mjs squash PLAN_FILE BASE');
  const state = loadState(ctx);
  const cwd = ctx.cwd;
  requireCleanTree(cwd);
  const active = state.phases.find((p) => p.state === 'active');
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
    base = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${args[1]}^{commit}`], { cwd });
  } catch {
    return fail(EXIT_REFUSED, `BASE "${args[1]}" is not a commit`);
  }
  if (!gitOk(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd })) {
    fail(EXIT_REFUSED, `BASE ${base} is not an ancestor of HEAD (${active.branch})`);
  }
  // R1: the range stays inside the active phase. Its start is the previous phase's tip, or for phase 1 where HEAD
  // forked from the trunk; a BASE under it would fold an earlier phase's (or the trunk's) commits into this one.
  let start;
  try {
    start = active.n === 1 ? git(['merge-base', startPoint(cwd, state, 1), 'HEAD'], { cwd }) : startPoint(cwd, state, active.n);
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
    phase.state = 'done';
    writeState(ctx.path, state);
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
  const res = spawnSync('bash', [join(SCRIPT_DIR, 'sdd-workspace'), ctx.planFile], {
    cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error || res.status !== 0) {
    fail(EXIT_USAGE, `sdd-workspace failed: ${oneLine(res.error ? res.error.message : res.stderr)}`);
  }
  return res.stdout.trim();
}

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
  if (!state.remote) fail(EXIT_REFUSED, 'the state records no remote: switch with stack mode local, or run stack mode github');
  requireCleanTree(cwd);
  // --repo on pr edit: with several remotes or a default repo set to an upstream, a bare number may name another repo's PR.
  const slug = githubSlug(state.remote, cwd);
  if (!slug) fail(EXIT_REFUSED, `remote "${state.remote}" is no longer a GitHub remote: switch with stack mode local`);

  const bodyFile = join(workspaceOf(ctx), `pr-body-${String(phase.n).padStart(2, '0')}.md`);
  writeFileSync(bodyFile, prBody(ctx, state, phase));

  const startedOn = currentBranch(cwd);
  let lines;
  try {
    reconcileStack(ctx, state, phase.n);
    switchTo(cwd, branchOf(phase));
    // gh-stack v0.1.1 prints every status line to stderr and nothing to stdout: the link test reads both.
    const result = ghRun(['stack', 'submit', '--auto', ...(open ? ['--open'] : []), '--remote', state.remote], { cwd });
    const submitted = `${result.stdout}\n${result.stderr}`;
    const prs = new Map();
    for (const b of ghStackView({ cwd })?.branches ?? []) if (b.pr?.number) prs.set(b.name, b.pr.number);
    const prOf = (p) => prs.get(p.branch) ?? fail(EXIT_GH, `gh stack view --json shows no PR for ${p.branch} after the submit`);
    const touched = open ? state.phases : [phase];
    const numbers = touched.map(prOf);
    gh(['pr', 'edit', String(prOf(phase)), '--repo', slug, '--title', phase.title, '--body-file', bodyFile], { cwd });

    for (const [i, p] of touched.entries()) Object.assign(p, { pr: numbers[i], state: open ? 'ready' : 'submitted' });
    writeState(ctx.path, state);
    lines = touched.map((p) => (open ? `Phase ${p.n}: ready (${p.branch}, PR #${p.pr})` : `Phase ${p.n}: submitted (${p.branch}, PR #${p.pr} draft)`));
    if (prs.size >= 2 && !STACK_LINKED.test(submitted)) lines[lines.length - 1] += LINK_MISSING;
  } catch (e) {
    // HEAD goes back to where the call found it (reconcile moves it to phase N-1 and along the stack).
    if (startedOn && currentBranch(cwd) !== startedOn) gitOk(['switch', '--quiet', startedOn], { cwd });
    throw e;
  }
  return out(lines.join('\n'));
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
