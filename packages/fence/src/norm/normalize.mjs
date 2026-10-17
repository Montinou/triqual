// Normalizer driver: turns a shell command string into the effective commands it runs, or an
// opaque verdict (spec, "Normalizer").
//
//   normalize(command, ctx) -> {commands: EffectiveCommand[]} | {opaque: {reason, construct, offset}}
//   ctx = {cwd, home, env, writtenIndex, readFile, gitTreeDiff, patchTargets, fs, expandGlob}
//
// EffectiveCommand = {argv, cwd, env, classes, reads, writes, ops, domains, repo} (carry-norm):
//   argv     words after value substitution and glob expansion (UNKNOWN where undetermined)
//   cwd      the directory the command runs in (UNKNOWN when it cannot be tracked)
//   env      the command's prefix assignments (`X=1 cmd`), values possibly UNKNOWN
//   reads/writes  realpaths from redirections and cd targets (T14 adds argument file effects)
//   ops      ancestor operations from ops.mjs, paths resolved from cwd
//   domains/classes  `/dev/tcp` and `/dev/udp` redirections give a domain and `network-fetch`
//   repo     {root, branch} of the repository the command works in, null outside one, UNKNOWN
// Commands come out in execution order as far as it is known; a command substitution's commands
// come before the command whose words contain it. Commands that may never run (a branch not
// taken, the right side of `||`, words after `exit`) are still reported: over-reporting is safe.
//
// In this task: simple commands, lists (`;` `&&` `||` `&` newline), pipelines, subshells and
// groups, if/for/while/until/case bodies, `$( … )` and backticks (walked; their output is UNKNOWN),
// redirections with file effects, cd/pushd/popd tracking, repository and branch resolution, value
// substitution through values.mjs. Later tasks add steps to FINISH_STEPS (command classes,
// wrappers, argument file effects, nested shells, env-var opacity, bulk writers).
//
// The walker keeps one mutable shell state per shell (variables, exported names, cwd, the
// pushd stack) and one global state for the file system (the commands found, paths named by an
// in-command mv/ln, branch changes). Subshells, command substitutions, pipeline members and
// background jobs run on a clone of the shell state; the file system state is shared.
//
// Soundness rules (any value not proven is UNKNOWN):
// - Every walk returns the set U of state keys (variable names, `#cwd`, `#dirs`, `#br:<gitdir>`)
//   in which the node's failure state may differ from the success state it leaves behind. A `;`
//   (or newline) sequence forgets U before the next command (it runs either way); `L && R` runs R
//   in L's success state; `L || R` runs R in L's failure view (U forgotten; for a lone cd or
//   checkout the exact old value) and afterwards forgets what R touched, unless R always exits.
// - Branches (if/elif/else, case arms) run on clones; afterwards every key any of them touched is
//   UNKNOWN. Loops: keys the body may assign (a linear syntactic scan) are UNKNOWN at the start of
//   every iteration and afterwards; `for` lists of literal words or globs are unrolled (bounded),
//   and the loop variable keeps its last value unless the body may break or assign it.
// - zsh (the host shell) runs the last pipeline member in the current shell: what it touched is
//   UNKNOWN afterwards. A negated pipeline assumes nothing about its member's outcome.
// - cd is logical (as both shells do by default): `..` drops the last component, but a `..` with a
//   symlink or a missing directory before it, `cd -`, `cd +N`, unsupported flags, two operands, a
//   glob, an UNKNOWN target, or a bare relative target while CDPATH may be set make the cwd
//   UNKNOWN (CDPATH as it was before the command). A cd may fail: it counts as certain only when
//   its target is an existing searchable directory and every earlier command in the call is on
//   CERTAIN_CD_PREDECESSORS; otherwise the commands after it that do not depend on its success
//   (`;`) see an UNKNOWN cwd. `builtin cd`/`command cd` are cd. With a tracked pushd stack, a cd
//   (zsh AUTO_PUSHD) or `pushd ±N` makes the stack UNKNOWN; popd on an unknown stack, UNKNOWN cwd.
// - eval, source and `.` leave cwd, pushd stack, branches and the set of repositories UNKNOWN for
//   later commands (eval's literal text is re-parsed as nested commands; source/`.` is T31's).
// - After an in-command mv or ln, a later word, redirect target, cd target or git -C directory whose
//   path names one of its operands, a path under one, or passes through one (`d/../x`, read
//   lexically and resolved; every prefix before a `..` is also resolved, so a path through another
//   symlink is caught) is UNKNOWN (all of them when an operand is UNKNOWN); a command word naming
//   one is opaque. While such a taint is active, any word whose resolution follows a symlink, or
//   leaves its lexical spelling, is UNKNOWN too (an existing link may point through an operand).
// - Redirect targets are normalized before they are judged: only exactly /dev/null, /dev/stdin,
//   /dev/stdout, /dev/stderr, /dev/tty and /dev/fd/<digits> name no file (lexically when the
//   spelling has no `..`, else by the resolved path); /dev/tcp|udp likewise give a domain.
// - Repository: walk up from the cwd (repo.mjs); git honours -C, --git-dir, --work-tree and
//   GIT_DIR/GIT_WORK_TREE (prefix assignments, or exported variables). `git checkout|switch <b>`
//   sets the branch for later commands when <b> is a local branch (or is created with -b/-c);
//   anything else (a tag, a commit, a remote name, `-`, a rename, rebase, symbolic-ref, bisect,
//   update-ref, any subcommand outside GIT_KNOWN_SUBS such as an alias) makes it UNKNOWN. Branch
//   changes are file-system state: a subshell's checkout counts too. A repository created in the
//   call (git init/clone/worktree add, a `.git` made by mkdir or a redirect) makes later lookups
//   at or under it, and every `null`, UNKNOWN. No process is ever spawned.
// - `exec < f` (only redirections) feeds stdin for the rest of that shell, including when it only
//   may have run (a branch, `||`, zsh's last pipeline member); a subshell's stays inside.
// - The loop scan classifies commands with the same PRE_STEPS unwrapping and commandKind() as the
//   walk. A repository lookup from a directory that does not exist yet is UNKNOWN.
// - PRE_STEPS unwrap wrappers before the cd/git/ops/taint dispatch; FINISH_STEPS enrich after it.
//   Wrappers come from tables/wrappers.mjs. A cd run through a wrapper that starts a new process
//   (env, nice, sudo, …) does not move the shell. env -C / sudo -D move the inner command (its
//   words resolve there; redirections stay in the shell's cwd). find -exec clauses are effective
//   commands of their own, under the wrappers around find. noglob keeps glob words literal (UNKNOWN).
// - A command word that is UNKNOWN, may split, or is a glob is opaque. An interpreter whose stdin is
//   a pipe, heredoc, herestring or file is opaque `stdin-interpreter`; a shell (or eval) goes to
//   unwrap.mjs, which re-parses a literal feed (echo/printf/cat/base64/xxd output, a literal or
//   tracked heredoc or herestring) and is opaque on any other.
// - Nested shells (T16): `sh|bash|zsh|dash|ksh -c CODE`, eval, a fed shell and wrapper scripts
//   (env -S, flock -c, watch, find -exec sh -c) are re-parsed by reparse() after the command itself
//   is recorded: a child walk on the same state (a subshell's changes undone, only exported values
//   inherited), nesting counted up to MAX_REPARSE_DEPTH, MAX_REPARSE_BYTES re-parsed per call.
//   Inside sh/bash/dash/ksh code a `**` glob is UNKNOWN (bash without globstar reads it as `*`).
// - Code-loading variables (T17, tables/envvars.mjs): a prefix assignment, a standalone assignment,
//   `export|declare|typeset|readonly|local NAME[=v]`, `read NAME`, `printf -v NAME`, `unset NAME`,
//   `env NAME=v|-u NAME|--unset=NAME|-i`, and `sudo|doas NAME=v` of a listed name are opaque
//   `code-loading-var` (loadingVar() is the one place that throws). A name that is not literal in
//   those positions is opaque too. Re-parsed text goes through the same walk.
// - Bulk writers, patch targets and git tree updates (T18, tables/bulk.mjs, bulkStep): a bulk
//   writer adds its source's would-be files under the protected subpaths to `writes` (the source
//   is not walked beyond them), archives and unknown sources give the destination a `bulk` op,
//   patch targets are writes (an unreadable patch is opaque `patch-unreadable`), and a git tree
//   update runs ctx.gitTreeDiff once (opaque `git-config-written` first when ctx.writtenIndex
//   holds the repo's config or an include; `git-tree-update` per the spec). ctx.writtenIndex,
//   ctx.readFile, ctx.gitTreeDiff and ctx.patchTargets are the injected capabilities; the
//   normalizer itself still never spawns.
// - Linear time: the parser is linear; the walker visits each node once except for loop unrolling,
//   which is bounded by UNROLL_BUDGET per loop and MAX_STEPS overall (past it: opaque `size`), and
//   glob expansion shares one time budget per call. Never throws: internal errors are opaque
//   `internal`.

import nodeFs from 'node:fs';

import { parseShell, literalValue, literalText } from './parser.mjs';
import { Opaque, isName, MAX_BYTES } from './tokenize.mjs';
import { UNKNOWN, isUnknown } from './unknown.mjs';
import {
  Env,
  resolveWord,
  splitsOnWhitespace,
  applySimple,
  forValues,
  POISON_COMMANDS,
  DECLARE_COMMANDS,
  MAX_VALUE,
} from './values.mjs';
import {
  unwrap as unwrapNested,
  shellInvocation,
  appletArgv,
  pipeFeeds,
  heredocLiteral,
  bashGlobUnknown,
  resetsEnv,
  MAX_REPARSE_DEPTH,
} from './unwrap.mjs';
import { opsOf } from './ops.mjs';
import { resolvePath, foldCase, isCaseInsensitive } from '../resolve/paths.mjs';
import { expandGlob as defaultExpandGlob } from '../resolve/glob.mjs';
import { repoOf, hasLocalBranch } from '../resolve/repo.mjs';
import { classesOf, fileEffects, domainsOf, hostToDomain, urlDomainOf, isEnvironPath, writesNothing, READ_ONLY_PROGRAMS } from '../tables/classes.mjs';
import { checkPathWrite } from '../eval/builtin.mjs';
import { stripOne, findExecs, valueFlags, MAX_WRAP_DEPTH } from '../tables/wrappers.mjs';
import { isCodeLoadingAssignment } from '../tables/envvars.mjs';
import { bulkOf, PROTECTED_SUBGLOBS, MAX_WALK_ENTRIES, MAX_WALK_DEPTH, TREE_PATHSPECS, UNNAMEABLE } from '../tables/bulk.mjs';
import { gitTreeDiff as defaultGitTreeDiff, gitConfigFiles, inProtectedSubpath, indexMentionsProtected, MAX_CONFIG_BYTES, NOT_A_REVISION } from '../resolve/git.mjs';
import { patchTargets as defaultPatchTargets, patchTargetsFromText } from '../resolve/patch.mjs';

/** Most nodes walked in one call (loop unrolling included); past it the call is opaque. */
export const MAX_STEPS = 200000;
/** Total text re-parsed by nested shells, eval and feeds in one call: the command cap per level. */
export const MAX_REPARSE_BYTES = MAX_BYTES * MAX_REPARSE_DEPTH;
/** A `for` loop unrolls only while values × body size × enclosing unrolled iterations stays under this. */
export const UNROLL_BUDGET = 20000;
/** Total glob expansion time per call; later globs are UNKNOWN. */
export const GLOB_BUDGET_MS = 250;
// More distinct mv/ln operands than this: every later path is UNKNOWN.
const MAX_TAINT = 64;
// More `..` segments than this in one word, while taint is active: the word is UNKNOWN.
const MAX_DOTDOT = 64;
const MAX_PATH = 4096;

// State keys besides variable names (which never start with `#`).
const POISON = '#poison';
const CWD = '#cwd';
const DIRS = '#dirs';
const BR = '#br:';
const BRALL = '#brall';
const BREAK = '#break';
const isGlobalKey = (k) => k.startsWith('#br');

const EMPTY = new Set();
const CD_KEYS = new Set([CWD, DIRS, 'PWD', 'OLDPWD']);

const WRITE_REDIRS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const READ_REDIRS = new Set(['<', '<&', '<>']);
const STDIN_REDIRS = new Set(['<', '<>', '<&', '<<', '<<-', '<<<']);
const NO_FILE = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const FD_PATH = /^\/dev\/fd\/[0-9]+$/;
const NET_PATH = /^\/dev\/(?:tcp|udp)\/([^/]*)/;
// Most wrapper layers PRE_STEPS may strip from one command (find counts as one for its clauses).
const MAX_UNWRAP = MAX_WRAP_DEPTH;

// Programs that run code read from stdin (carry rule 2). Shells and eval are left to unwrap.mjs,
// which re-parses a literal feed and is opaque on any other.
const STDIN_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'source', '.', 'node', 'nodejs', 'perl', 'ruby']);
const NESTED_HANDLED = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']);
const PYTHON = /^python[0-9.]*$/;

// git global options that take a separate value.
const GIT_VALUE_OPTS = new Set(['-c', '--namespace', '--config-env', '--super-prefix', '--exec-path']);
// git subcommands that can change which branch HEAD names (besides checkout/switch).
const GIT_BRANCH_CHANGERS = new Set(['branch', 'symbolic-ref', 'bisect', 'rebase', 'update-ref']);
// git builtins known to leave HEAD's branch name alone. git runs a builtin before any alias of the
// same name, so only a name outside this list (and outside checkout/switch/GIT_BRANCH_CHANGERS) can
// be an alias or an external `git-<x>`: it makes the branch UNKNOWN for later commands.
const GIT_KNOWN_SUBS = new Set([
  'status', 'diff', 'log', 'show', 'add', 'rm', 'mv', 'commit', 'restore', 'reset', 'merge', 'cherry-pick',
  'revert', 'stash', 'tag', 'fetch', 'pull', 'push', 'clone', 'init', 'remote', 'config', 'rev-parse',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'blame', 'annotate', 'grep', 'describe', 'shortlog', 'clean',
  'apply', 'am', 'worktree', 'submodule', 'gc', 'fsck', 'archive', 'format-patch', 'diff-tree', 'diff-index',
  'diff-files', 'show-ref', 'for-each-ref', 'rev-list', 'reflog', 'notes', 'help', 'version', 'whatchanged',
  'range-diff', 'merge-base', 'name-rev', 'check-ignore', 'check-attr', 'count-objects', 'hash-object',
  'verify-commit', 'verify-tag', 'var', 'prune', 'repack', 'pack-refs', 'maintenance', 'show-branch',
  'bundle', 'request-pull', 'mergetool', 'difftool', 'cherry', 'sparse-checkout',
]);

// Search and pager programs with options that run a command (rg --pre, ugrep --filter, ack --pager,
// fd -x, bat --pager): never certain.
const RUNS_PROGRAMS = new Set(['rg', 'ag', 'ack', 'ugrep', 'ug', 'pt', 'fd', 'fdfind', 'bat', 'batcat', 'locate', 'plocate', 'mdfind']);
const runsProgramFlag = (a) =>
  typeof a === 'string' && /^--(?:pre|pager|filter|compress-program|use-compress-program|hostname-bin|to-command)(?:=|$)/.test(a);

/**
 * Programs (and git subcommands) known not to remove a directory, change its permissions or
 * replace it. A cd counts as certain to succeed only when its target exists now and every earlier
 * command in the call is on this list (data: T14 extends it). An entry is {program, subcommands?,
 * test?}: `subcommands` restricts git to those subcommands, `test(argv)` must also hold.
 */
export const CERTAIN_CD_PREDECESSORS = [
  ...['echo', 'printf', 'true', 'false', ':', 'pwd', 'cd', 'pushd', 'popd', 'test', '[', 'read', 'type'].map((program) => ({ program })),
  // the read-only operand table (tables/classes.mjs): an invocation that writes nothing, with no
  // option that runs a program (--pre, --pager, --compress-program, ...)
  ...[...READ_ONLY_PROGRAMS]
    .filter((program) => !RUNS_PROGRAMS.has(program))
    .map((program) => ({ program, test: (argv) => writesNothing(argv) && !argv.some(runsProgramFlag) })),
  // rg runs a command with --pre and --hostname-bin
  { program: 'rg', test: (argv) => !argv.some((a) => typeof a !== 'string' || a.startsWith('--pre') || runsProgramFlag(a)) && writesNothing(argv) },
  {
    program: 'git',
    subcommands: ['status', 'diff', 'log', 'show', 'rev-parse', 'branch'],
    // `git branch` only in its listing form: no operands, only listing flags
    test: (argv, sub, args) =>
      sub !== 'branch' ||
      args.every((a) => typeof a === 'string' && /^(?:-[avrl]+|--(?:list|all|remotes|verbose|show-current|no-color|color(?:=.*)?|column(?:=.*)?|sort=.*|format=.*|contains(?:=.*)?|merged(?:=.*)?|no-merged(?:=.*)?|points-at=.*))$/.test(a)),
  },
];

const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');
const programName = (w) => (typeof w === 'string' ? w.slice(w.lastIndexOf('/') + 1) : null);
const fold = (p) => foldCase(p, true);

function union(...sets) {
  const out = new Set();
  for (const s of sets) for (const k of s) out.add(k);
  return out;
}

// ---------------------------------------------------------------------------------------------
// State

// An Env that records every name it changes into `touched` (a Set, or null when not recording),
// and keeps an undo journal per open scope so a subshell or branch can run on the same object and
// be rolled back: O(1) per change, instead of copying every variable for every subshell (which
// is quadratic on inputs with many variables and many subshells).
class TrackedEnv extends Env {
  constructor() {
    super();
    this.touched = null;
    /** @type {Map<string, any>[]} one map per open scope: name -> its state at scope entry */
    this.journal = [];
  }

  note(name) {
    const j = this.journal[this.journal.length - 1];
    if (!j || j.has(name)) return;
    if (name === POISON) j.set(name, this.poisoned);
    else j.set(name, { had: this.vars.has(name), old: this.vars.get(name), pinned: this.pinned.has(name) });
  }

  rollback(j) {
    for (const [name, rec] of j) {
      if (name === POISON) {
        this.poisoned = rec;
        continue;
      }
      if (rec.had) this.vars.set(name, rec.old);
      else this.vars.delete(name);
      if (rec.pinned) this.pinned.add(name);
      else this.pinned.delete(name);
    }
  }

  set(name, value) {
    this.note(name);
    super.set(name, value);
    if (this.touched) this.touched.add(name);
  }

  unset(name) {
    this.note(name);
    super.unset(name);
    if (this.touched) this.touched.add(name);
  }

  forget(name) {
    this.note(name);
    super.forget(name);
    if (this.touched) this.touched.add(name);
  }

  pin(name) {
    this.note(name);
    super.pin(name);
    if (this.touched) this.touched.add(name);
  }

  poison() {
    this.note(POISON);
    super.poison();
    if (this.touched) this.touched.add(POISON);
  }

  // Run fn with every change to this env undone afterwards.
  scoped(fn) {
    const j = new Map();
    this.journal.push(j);
    try {
      return fn();
    } finally {
      this.journal.pop();
      this.rollback(j);
    }
  }
}

class Shell {
  constructor(env, cwd) {
    this.env = env;
    this.exported = new Set();
    this.cwd = cwd;
    // the pushd stack above the unknown one this shell started with, or UNKNOWN
    this.dirs = [];
    // stdin is a pipe, heredoc, herestring or file (a feed a shell could read code from)
    this.stdin = false;
    // set by `exec < f` (only redirections): stdin stays fed for the rest of this shell
    this.stdinPersist = false;
    // what a pipe hands one pipeline member: {node, text} (text: literal string, null, or a feed error)
    this.feed = null;
    // 'zsh' (the host shell) or 'bash' (sh, bash, dash, ksh run through a nested shell): glob rules
    this.kind = 'zsh';
    // the possible failure of the last simple command walked here: {node, verified, keys, fail}
    this.lastRisk = null;
    // names exported inside each open scope (removed on rollback)
    this.exportJournal = [];
  }

  exportName(name) {
    if (this.exported.has(name)) return;
    this.exported.add(name);
    const j = this.exportJournal[this.exportJournal.length - 1];
    if (j) j.push(name);
  }
}

// Run fn(sh) as if on a copy of the shell (a subshell, or a branch that may not run): every change
// to the shell state is undone afterwards (the file system state in g is not). Returns
// {touched, u}: the keys fn touched and its result. dirs arrays are never mutated in place, so
// restoring the reference restores them.
// sticky: the scope stands for code that may have run in this shell (a branch, the right side of
// ||, zsh's last pipeline member), so an `exec < f` inside it stays in effect afterwards.
function scoped(sh, fn, sticky = false) {
  const saved = {
    cwd: sh.cwd,
    dirs: sh.dirs,
    stdin: sh.stdin,
    stdinPersist: sh.stdinPersist,
    lastRisk: sh.lastRisk,
    touched: sh.env.touched,
    feed: sh.feed,
    kind: sh.kind,
  };
  const exported = [];
  sh.exportJournal.push(exported);
  const t = new Set();
  sh.env.touched = t;
  let u;
  try {
    u = sh.env.scoped(() => fn(sh));
  } finally {
    sh.exportJournal.pop();
    for (const name of exported) sh.exported.delete(name);
    sh.cwd = saved.cwd;
    sh.dirs = saved.dirs;
    sh.stdin = saved.stdin;
    sh.stdinPersist = saved.stdinPersist || (sticky && sh.stdinPersist);
    sh.lastRisk = saved.lastRisk;
    sh.env.touched = saved.touched;
    sh.feed = saved.feed;
    sh.kind = saved.kind;
  }
  return { touched: t, u };
}

function touch(sh, key) {
  if (sh.env.touched) sh.env.touched.add(key);
}

// Run fn recording the keys it touches; they are also added to the enclosing record.
function region(sh, fn) {
  const saved = sh.env.touched;
  const t = new Set();
  sh.env.touched = t;
  let out;
  try {
    out = fn();
  } finally {
    sh.env.touched = saved;
    if (saved) for (const k of t) saved.add(k);
  }
  return [t, out];
}

function setBranch(sh, g, key, value) {
  if (typeof key !== 'string') {
    g.branchesAll = true;
    touch(sh, BRALL);
    return;
  }
  g.branches.set(key, value);
  touch(sh, BR + key);
}

// Make every key UNKNOWN (except those in skip).
function forget(sh, g, keys, skip) {
  for (const k of [...keys]) {
    if (skip && skip.has(k)) continue;
    if (k === POISON) sh.env.poison();
    else if (k === CWD) {
      sh.cwd = UNKNOWN;
      touch(sh, CWD);
    } else if (k === DIRS) {
      sh.dirs = UNKNOWN;
      touch(sh, DIRS);
    } else if (k === BRALL) setBranch(sh, g, UNKNOWN, UNKNOWN);
    else if (k.startsWith(BR)) setBranch(sh, g, k.slice(BR.length), UNKNOWN);
    else if (k[0] !== '#') sh.env.set(k, UNKNOWN);
  }
}

function forgetGlobals(sh, g, keys) {
  forget(sh, g, [...keys].filter(isGlobalKey));
}

// Run fn as a subshell (or a branch): shell changes are undone; the file system keys it touched
// are reported to the parent's record. Returns {touched, u}.
function inSubshell(sh, g, fn, sticky = false) {
  const r = scoped(sh, fn, sticky);
  for (const k of r.touched) if (isGlobalKey(k)) touch(sh, k);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Syntactic helpers

function hasGlob(word) {
  return !!word && Array.isArray(word.parts) && word.parts.some((p) => p && p.type === 'glob');
}

function partsHaveSideEffects(parts) {
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'arith') return true;
    if (p.type === 'var') {
      if (p.op === '=' || p.op === ':=') return true;
      if (p.arg && Array.isArray(p.arg.parts) && partsHaveSideEffects(p.arg.parts)) return true;
    }
  }
  return false;
}

// Would expanding this command's words change shell variables (`${X:=v}`, arithmetic)?
function nodeHasSideEffects(node) {
  const words = [...node.words, ...node.assigns.map((a) => a.value)];
  for (const r of node.redirs) {
    if (r.target) words.push(r.target);
    if (Array.isArray(r.parts)) words.push({ parts: r.parts });
  }
  return words.some((w) => w && Array.isArray(w.parts) && partsHaveSideEffects(w.parts));
}

// The simple command whose outcome decides a node's success, through lists and groups.
function lastSimple(node) {
  if (!node) return null;
  if (node.type === 'simple') return node;
  if (node.type === 'group') return lastSimple(node.body);
  if (node.type === 'list') {
    const last = node.items[node.items.length - 1];
    return last && !last.async ? lastSimple(last.node) : null;
  }
  return null;
}

function riskOf(sh, node) {
  const s = lastSimple(node);
  return s && sh.lastRisk && sh.lastRisk.node === s ? sh.lastRisk : null;
}

// Does the node always end the shell (`exit`, or a group/list with an unconditional exit)?
function alwaysExits(node) {
  if (!node) return false;
  if (node.type === 'simple') return node.words.length > 0 && literalValue(node.words[0]) === 'exit';
  if (node.type === 'group') return alwaysExits(node.body);
  if (node.type === 'list') return node.items.some((it) => !it.async && alwaysExits(it.node));
  return false;
}

// AST children of a node (bodies, conditions), without command substitutions.
function childrenOf(node) {
  switch (node.type) {
    case 'list':
      return node.items.map((it) => it.node);
    case 'and':
    case 'or':
      return [node.left, node.right];
    case 'pipeline':
      return node.commands;
    case 'subshell':
    case 'group':
      return [node.body];
    case 'if':
      return [...node.clauses.flatMap((c) => [c.cond, c.body]), ...(node.else ? [node.else] : [])];
    case 'for':
      return [node.body];
    case 'while':
      return [node.cond, node.body];
    case 'case':
      return node.arms.filter((a) => a.body).map((a) => a.body);
    default:
      return [];
  }
}

// Every Word a node holds directly (not in child nodes).
function wordsOf(node) {
  const out = [];
  if (node.type === 'simple') {
    out.push(...node.words, ...node.assigns.map((a) => a.value));
  } else if (node.type === 'for') {
    if (node.items) out.push(...node.items);
  } else if (node.type === 'case') {
    out.push(node.word, ...node.arms.flatMap((a) => a.patterns));
  }
  for (const r of node.redirs || []) {
    if (r.target) out.push(r.target);
    if (Array.isArray(r.parts)) out.push({ parts: r.parts });
  }
  return out;
}

function cmdsubsOf(parts, out) {
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'cmdsub') out.push(p.program);
    else if (p.type === 'var' && p.arg && Array.isArray(p.arg.parts)) cmdsubsOf(p.arg.parts, out);
  }
  return out;
}

const SIZE = new WeakMap();
// Nodes in a subtree, command substitutions included (the cost of walking it once).
function sizeOf(node) {
  const known = SIZE.get(node);
  if (known !== undefined) return known;
  let n = 1;
  for (const c of childrenOf(node)) n += sizeOf(c);
  for (const w of wordsOf(node)) for (const p of cmdsubsOf(w.parts || [], [])) n += sizeOf(p);
  SIZE.set(node, n);
  return n;
}

// ---- Keys a loop body may change (a linear scan over-approximating applySimple) ---------------

const SCAN = new WeakMap();
function assignedIn(node) {
  let s = SCAN.get(node);
  if (!s) {
    s = new Set();
    scanNode(node, s, false);
    SCAN.set(node, s);
  }
  return s;
}

function scanAdd(out, key, globalOnly) {
  if (!globalOnly || isGlobalKey(key)) out.add(key);
}

function scanParts(parts, out, globalOnly) {
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'var') {
      if ((p.op === '=' || p.op === ':=') && typeof p.name === 'string') scanAdd(out, p.name, globalOnly);
      if (p.arg && Array.isArray(p.arg.parts)) scanParts(p.arg.parts, out, globalOnly);
    } else if (p.type === 'cmdsub') {
      scanNode(p.program, out, true); // a subshell: only file system keys escape
    } else if (p.type === 'arith' && !globalOnly) {
      // `$((x=1))` assigns: every name in the text may be assigned; `$1`, `${…}` may assign anything
      const text = typeof p.text === 'string' ? p.text : '$';
      for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.add(m[0]);
      if (/\$(?![A-Za-z_])/.test(text)) out.add(POISON);
    }
  }
}

// What a command (its argv after PRE_STEPS unwrapping) does to the walker's own state. Shared by
// the walk (walkSimple's dispatch) and the loop scan, so the two cannot drift.
function commandKind(argv) {
  const cmd = argv[0];
  if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') return 'cd';
  if (cmd === 'eval' || cmd === 'source' || cmd === '.') return 'opaque-run';
  if (programName(cmd) === 'git') return 'git';
  return null;
}

function scanSimple(node, out, globalOnly) {
  for (const a of node.assigns) scanAdd(out, a.name, globalOnly);
  if (node.words.length === 0) return;
  const cmd = literalValue(node.words[0]);
  const everything = () => {
    // a computed command word may be anything, including a declaration or cd
    for (const k of [POISON, CWD, DIRS, BREAK, BRALL]) scanAdd(out, k, globalOnly);
  };
  if (cmd === null) return everything();
  // the same unwrapping as the walk (PRE_STEPS see UNKNOWN for words that are not literal)
  let inner;
  try {
    const u = unwrap(node.words.map((w) => literalValue(w) ?? UNKNOWN), {}, node, null, null);
    inner = u.argv;
    // a find -exec clause, or a wrapper script (env -S, flock -c, watch), may run git (a branch
    // change) like any other command
    if (u.execs.length > 0 || u.scripts.length > 0) scanAdd(out, BRALL, globalOnly);
    // a nested shell is a subshell: only file system keys (branches) escape it
    if (shellInvocation(u.argv) !== null) scanAdd(out, BRALL, globalOnly);
  } catch (e) {
    if (e instanceof Opaque) throw e; // as opaque as in the walk
    return everything();
  }
  if (typeof inner[0] !== 'string') return everything();
  const kind = commandKind(inner);
  if (kind === 'git') {
    // as in gitEffect: checkout/switch, the branch changers, and any subcommand outside the known
    // list (an alias) may change the branch
    const o = gitOptions(inner);
    if (o === null || (o.sub !== null && !(GIT_KNOWN_SUBS.has(o.sub) && !GIT_BRANCH_CHANGERS.has(o.sub)))) {
      scanAdd(out, BRALL, globalOnly);
    }
  } else if (kind === 'opaque-run') {
    scanAdd(out, BRALL, globalOnly);
    if (!globalOnly) for (const k of [POISON, CWD, DIRS]) out.add(k);
  } else if (kind === 'cd' && !globalOnly) {
    for (const k of CD_KEYS) out.add(k);
  }
  const args = node.words.slice(1).map(literalText);
  if (globalOnly) return;
  if (POISON_COMMANDS.has(cmd) || cmd === 'set') out.add(POISON);
  else if (DECLARE_COMMANDS.has(cmd) || ['unset', 'read', 'getopts', 'mapfile', 'readarray'].includes(cmd)) {
    for (const n of ['REPLY', 'OPTARG', 'OPTIND', 'MAPFILE']) out.add(n);
    for (const a of args) {
      if (a === null) out.add(POISON);
      else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(a);
        if (m) out.add(m[0]);
      }
    }
  } else if (cmd === 'printf' || cmd === 'print' || cmd === 'wait') {
    for (const a of args) {
      if (a === null) {
        out.add(POISON);
        break;
      }
      if (a === '--' || !a.startsWith('-')) break;
      if (a.includes(cmd === 'wait' ? 'p' : 'v')) out.add(POISON);
    }
  } else if (cmd === 'break') out.add(BREAK);
}

function scanNode(node, out, globalOnly) {
  if (!node) return;
  if (node.type === 'simple') scanSimple(node, out, globalOnly);
  for (const w of wordsOf(node)) scanParts(w.parts || [], out, globalOnly);
  switch (node.type) {
    case 'list':
      for (const it of node.items) scanNode(it.node, out, globalOnly || it.async);
      return;
    case 'pipeline':
      node.commands.forEach((c, i) => scanNode(c, out, globalOnly || (node.commands.length > 1 && i < node.commands.length - 1)));
      return;
    case 'subshell':
      scanNode(node.body, out, true);
      return;
    case 'for':
      scanAdd(out, node.var, globalOnly);
      break;
    default:
      break;
  }
  if (node.type !== 'simple') for (const c of childrenOf(node)) scanNode(c, out, globalOnly);
}

// ---------------------------------------------------------------------------------------------
// Paths

// The path a word names, resolved from the shell's cwd; a `~` still present is literal (values.mjs
// already expanded every real tilde).
// Memoized per call: nothing runs during normalization, so the file system does not change.
function resolveIn(sh, g, w) {
  if (typeof w !== 'string' || w === '' || w.includes('\0')) return UNKNOWN;
  const p = w.startsWith('~') ? `./${w}` : w;
  if (!p.startsWith('/') && !isAbs(sh.cwd)) return UNKNOWN;
  const base = isAbs(sh.cwd) ? sh.cwd : '/';
  const key = p.startsWith('/') ? p : `${base}\0${p}`;
  if (!g.resolveCache.has(key)) g.resolveCache.set(key, resolvePath(p, base, g.home, g.fs));
  return g.resolveCache.get(key);
}

// A set of absolute paths, matched by segment (case-folded: fail closed on any volume). hit(path)
// is true when the path, read lexically segment by segment (`.` skipped, `..` stepping back),
// reaches one of them at any point: it names it, a path under it, or passes through it.
class PathTrie {
  constructor() {
    this.root = new Map();
    this.size = 0;
  }

  add(path) {
    let node = this.root;
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      const f = fold(seg);
      if (!node.has(f)) node.set(f, new Map());
      node = node.get(f);
    }
    node.set('', true); // end marker ('' is never a folded segment)
    this.size++;
  }

  hit(path) {
    if (this.size === 0 || typeof path !== 'string') return false;
    if (this.root.has('')) return true; // `/` itself
    const stack = [this.root];
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const top = stack[stack.length - 1];
      const next = top === null ? null : top.get(fold(seg)) || null;
      if (next !== null && next.has('')) return true;
      stack.push(next);
    }
    return false;
  }
}

// The absolute spelling of a word, `..` kept, or null when the cwd is needed and unknown.
function rawAbs(sh, w) {
  if (w.startsWith('/')) return w;
  return isAbs(sh.cwd) ? `${sh.cwd}/${w}` : null;
}

function addTaint(sh, g, word, resolved) {
  if (typeof word !== 'string' || g.taint.size >= MAX_TAINT) {
    g.taintAll = true;
    return;
  }
  const raw = rawAbs(sh, word.startsWith('~') ? `./${word}` : word);
  if (raw === null || !isAbs(resolved)) {
    g.taintAll = true;
    return;
  }
  g.taint.add(raw);
  g.taint.add(resolved);
}

// Does a word (or its resolved path) name, or pass through, a path an earlier mv/ln touched?
function taintedWord(sh, g, w, resolved) {
  if (g.taintAll) return true;
  if (g.taint.size === 0) return false;
  if (typeof w !== 'string') return true;
  const raw = rawAbs(sh, w.startsWith('~') ? `./${w}` : w);
  if (raw === null || !isAbs(resolved)) return true;
  if (g.taint.hit(raw) || g.taint.hit(resolved)) return true;
  // Coarse: a resolution that followed any symlink (an existing link may point through a path
  // this command moves or links), or that leaves its lexical spelling, is not trusted.
  const lex = lexical(sh, w.startsWith('~') ? `./${w}` : w);
  // exact, not folded: on a case-sensitive volume a link that differs only in case is a different path
  if (lex === null || lex !== resolved) return true;
  // A `..` steps back from where the path before it really is, which may be through another
  // symlink (`/tmp/dq/..` with /tmp -> /private/tmp): resolve every prefix that precedes a `..`.
  let prefix = '';
  let checks = 0;
  for (const seg of raw.split('/')) {
    if (seg === '..') {
      if (++checks > MAX_DOTDOT) return true;
      const r = resolvePath(prefix || '/', '/', g.home, g.fs);
      if (!isAbs(r) || g.taint.hit(r)) return true;
    }
    if (seg !== '') prefix += `/${seg}`;
  }
  return false;
}

// Words naming a path an earlier mv/ln touched become UNKNOWN.
function applyTaint(argv, sh, g) {
  if (!g.taintAll && g.taint.size === 0) return;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (typeof w !== 'string' || w.startsWith('-')) continue;
    if (i === 0 && !w.includes('/')) continue;
    if (g.taintAll || taintedWord(sh, g, w, resolveIn(sh, g, w))) argv[i] = UNKNOWN;
  }
}

// ---------------------------------------------------------------------------------------------
// Repositories

function withBranch(repo, g) {
  if (repo === null) return null;
  if (isUnknown(repo) || typeof repo !== 'object') return UNKNOWN;
  let branch = repo.branch;
  if (g.branchesAll) branch = UNKNOWN;
  else if (g.branches.has(repo.gitDir)) branch = g.branches.get(repo.gitDir);
  return { root: repo.root, branch };
}

// A repository lookup from dir, seen after the repositories created earlier in the call: at or
// under a created root it is UNKNOWN (the new repository shadows any outer one); after any
// creation a `null` (no repository at normalize time) is UNKNOWN; after a creation whose place is
// unknown (eval, source, an unparsed clone) every lookup is UNKNOWN.
function afterCreated(repo, dir, g) {
  // a directory that does not exist yet will be made by the command: whatever is copied or
  // extracted there may be a repository
  if (repo === null && isAbs(dir) && (!exists(dir, g) || removedEarlier(dir, g))) return UNKNOWN;
  if (!g.created.any) return repo;
  if (g.created.all || repo === null) return UNKNOWN;
  if (!isAbs(dir)) return UNKNOWN;
  if (g.created.roots.hit(dir) || g.created.roots.hit(resolvePath(dir, '/', g.home, g.fs))) return UNKNOWN;
  return repo;
}

// Was the directory (or one above it) deleted or moved by an earlier command? Then whatever is
// there now may be a copy of a repository.
function removedEarlier(dir, g) {
  if (g.removed.all) return true;
  if (g.removed.trie.size === 0) return false;
  if (!g.realCache.has(dir)) g.realCache.set(dir, resolvePath(dir, '/', g.home, g.fs));
  return g.removed.trie.hit(dir) || g.removed.trie.hit(g.realCache.get(dir));
}

// Whether a path exists at normalize time (nothing runs during normalization: cached per call).
function exists(p, g) {
  if (!g.existsCache.has(p)) {
    let ok = false;
    try {
      g.fs.statSync(p);
      ok = true;
    } catch {
      ok = false;
    }
    g.existsCache.set(p, ok);
  }
  return g.existsCache.get(p);
}

function cwdRepo(sh, g) {
  if (!isAbs(sh.cwd)) return UNKNOWN;
  if (!g.repoCache.has(sh.cwd)) g.repoCache.set(sh.cwd, repoOf(sh.cwd, { fs: g.fs }));
  return afterCreated(g.repoCache.get(sh.cwd), sh.cwd, g);
}

function createdUnknown(g) {
  g.created.any = true;
  g.created.all = true;
}

function createdAt(g, root) {
  if (!isAbs(root)) return createdUnknown(g);
  g.created.any = true;
  g.created.roots.add(root);
  return undefined;
}

// The non-option operands of args, given the options that take a separate value.
function operandsOf(args, valueOpts) {
  const out = [];
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return null;
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a.length > 1 && a.startsWith('-')) {
      if (valueOpts.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const INIT_VALUE_OPTS = ['--template', '--separate-git-dir', '-b', '--initial-branch', '--object-format', '--ref-format'];
const CLONE_VALUE_OPTS = [
  '-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '--depth', '--shallow-since', '--shallow-exclude',
  '--reference', '--reference-if-able', '-c', '--config', '--template', '--separate-git-dir', '-j', '--jobs',
  '--filter', '--server-option', '--bundle-uri', '--ref-format',
];
const WORKTREE_ADD_VALUE_OPTS = ['-b', '-B', '--reason'];

// git init / clone / worktree add: record where the new repository is.
function noteGitCreation(sub, args, dir, sh, g) {
  const at = (p) => (p.startsWith('/') ? p : isAbs(dir) ? `${dir}/${p}` : null);
  let root;
  if (sub === 'init') {
    const ops = operandsOf(args, INIT_VALUE_OPTS);
    root = ops === null ? null : ops.length === 0 ? dir : at(ops[ops.length - 1]);
  } else if (sub === 'clone') {
    const ops = operandsOf(args, CLONE_VALUE_OPTS);
    if (ops !== null && ops.length >= 2) root = at(ops[1]);
    else if (ops !== null && ops.length === 1) {
      // git's default: the last path component of the URL, without a trailing .git
      const name = ops[0].replace(/[/\\]+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
      root = name ? at(name) : null;
    } else root = null;
  } else if (sub === 'worktree' && args[0] === 'add') {
    const ops = operandsOf(args.slice(1), WORKTREE_ADD_VALUE_OPTS);
    root = ops !== null && ops.length > 0 ? at(ops[0]) : null;
  } else {
    return;
  }
  if (typeof root !== 'string') return createdUnknown(g);
  createdAt(g, root.startsWith('/') ? resolvePath(root, '/', g.home, g.fs) : UNKNOWN);
}

// A path with a `.git` segment that a command creates (mkdir, a redirect): its parent is a root.
function noteDotGit(path, g) {
  if (typeof path !== 'string') return;
  const segs = path.split('/');
  const i = segs.indexOf('.git');
  if (i > 0) createdAt(g, segs.slice(0, i).join('/') || '/');
}

// The value of GIT_DIR / GIT_WORK_TREE a git command sees: undefined when unset.
function gitEnv(name, prefix, sh, g) {
  if (Object.hasOwn(prefix, name)) {
    const v = prefix[name];
    return v === '' ? UNKNOWN : v;
  }
  if (sh.env.poisoned) return UNKNOWN;
  if (sh.env.has(name)) {
    const v = sh.env.get(name);
    if (v === null) return undefined;
    if (isUnknown(v)) return UNKNOWN;
    // a shell variable reaches git only when exported (here, or already in the host environment)
    if (!sh.exported.has(name) && !Object.hasOwn(g.hostEnv, name)) return undefined;
    return v === '' ? UNKNOWN : v;
  }
  const h = g.hostEnv[name];
  return typeof h === 'string' && h !== '' && Object.hasOwn(g.hostEnv, name) ? h : undefined;
}

// git's global options: {chdirs, gitDir, workTree, sub, subIndex} or null when undeterminable.
function gitOptions(argv) {
  const chdirs = [];
  let gitDir;
  let workTree;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') return null;
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      const v = argv[++i];
      if (typeof v !== 'string') return null;
      if (a === '-C') chdirs.push(v);
      else if (a === '--git-dir') gitDir = v;
      else workTree = v;
    } else if (a.startsWith('--git-dir=')) gitDir = a.slice('--git-dir='.length);
    else if (a.startsWith('--work-tree=')) workTree = a.slice('--work-tree='.length);
    else if (a === '--bare') gitDir = gitDir ?? '.';
    else if (GIT_VALUE_OPTS.has(a)) {
      if (typeof argv[++i] !== 'string') return null;
    } else if (!a.startsWith('-')) return { chdirs, gitDir, workTree, sub: a, subIndex: i };
  }
  return { chdirs, gitDir, workTree, sub: null, subIndex: argv.length };
}

// What `git checkout|switch args` does to the branch:
// {kind:'none'|'detach'|'unknown'} | {kind:'create'|'maybe', name}
function checkoutTarget(sub, args) {
  const create = sub === 'checkout' ? ['-b', '-B', '--orphan'] : ['-c', '-C', '--orphan', '--create', '--force-create'];
  const createLetters = sub === 'checkout' ? 'bB' : 'cC';
  const unknown = { kind: 'unknown' };
  let name;
  let detach = false;
  let afterDash = false;
  let paths = 0;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return unknown;
    if (afterDash) {
      paths++;
      continue;
    }
    if (a === '--') {
      afterDash = true;
      continue;
    }
    const eq = a.indexOf('=');
    if (create.includes(a)) {
      name = args[++i];
      if (typeof name !== 'string') return unknown;
    } else if (a.startsWith('--') && eq > 0 && create.includes(a.slice(0, eq))) {
      name = a.slice(eq + 1);
    } else if (a === '--detach' || (sub === 'switch' && a === '-d')) {
      detach = true;
    } else if (a === '--conflict' || a === '--pathspec-from-file') {
      i++;
    } else if (a.startsWith('--')) {
      // a flag without a value
    } else if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        if (createLetters.includes(a[k])) {
          name = k + 1 < a.length ? a.slice(k + 1) : args[++i];
          if (typeof name !== 'string') return unknown;
          break;
        }
        if (sub === 'switch' && a[k] === 'd') detach = true;
      }
    } else {
      pos.push(a);
    }
  }
  if (name !== undefined) return name === '' ? unknown : { kind: 'create', name };
  if (detach) return { kind: 'detach' };
  if (paths > 0 || pos.length !== 1) return { kind: 'none' };
  if (pos[0] === '-' || pos[0].includes('@{')) return unknown;
  return { kind: 'maybe', name: pos[0] };
}

// Effects of a git command: the repository it works on (on eff) and the post step that records a
// branch change for later commands.
function gitEffect(node, argv, prefix, eff, sh, g) {
  const o = gitOptions(argv);
  let repo = UNKNOWN;
  if (o !== null) {
    let dir = sh.cwd;
    for (const c of o.chdirs) {
      if (c === '') continue;
      dir = c.startsWith('/') ? c : isAbs(dir) ? `${dir}/${c}` : UNKNOWN;
    }
    const gitDir = o.gitDir !== undefined ? o.gitDir : gitEnv('GIT_DIR', prefix, sh, g);
    const workTree = o.workTree !== undefined ? o.workTree : gitEnv('GIT_WORK_TREE', prefix, sh, g);
    const named = [dir, gitDir, workTree].filter((p) => typeof p === 'string');
    const tainted = !isAbs(dir) || named.some((p) => taintedWord({ cwd: dir }, g, p, resolvePath(p, dir, g.home, g.fs)));
    if (isAbs(dir) && !isUnknown(gitDir) && !isUnknown(workTree) && !tainted) {
      repo = afterCreated(repoOf(dir, { gitDir, workTree, fs: g.fs }), dir, g);
    }
    // a repository named through GIT_DIR/GIT_WORK_TREE/--git-dir/--work-tree: the tree check
    // (which diffs with -C root) cannot describe it
    g.gitRepos.set(eff, { repo, custom: gitDir !== undefined || workTree !== undefined });
    if (o.sub === 'init' || o.sub === 'clone' || o.sub === 'worktree') {
      // the new repository exists only after this command
      const created = () => noteGitCreation(o.sub, argv.slice(o.subIndex + 1), dir, sh, g);
      eff.repo = withBranch(repo, g);
      return () => {
        created();
        return EMPTY;
      };
    }
  }
  eff.repo = withBranch(repo, g);
  if (!g.gitRepos.has(eff)) g.gitRepos.set(eff, { repo, custom: o === null });
  if (repo === null || (o !== null && o.sub === null)) return null; // not a repository: git fails
  const key = isUnknown(repo) ? UNKNOWN : repo.gitDir;
  const sub = o === null ? UNKNOWN : o.sub;
  const args = o === null ? [] : argv.slice(o.subIndex + 1);
  let value;
  if (isUnknown(sub)) value = UNKNOWN;
  else if (sub === 'checkout' || sub === 'switch') {
    const t = checkoutTarget(sub, args);
    if (t.kind === 'none') return null;
    if (t.kind === 'detach') value = null;
    else if (t.kind === 'create') value = t.name;
    else if (t.kind === 'maybe') value = !isUnknown(repo) && hasLocalBranch(repo, t.name, g.fs) ? t.name : UNKNOWN;
    else value = UNKNOWN;
  } else if (GIT_BRANCH_CHANGERS.has(sub)) {
    if (sub === 'branch' && !args.some((a) => typeof a !== 'string' || a === '--move' || /^-[A-Za-z]*[mM]/.test(a))) return null;
    if (sub === 'symbolic-ref' && args.filter((a) => typeof a !== 'string' || !a.startsWith('-')).length < 2) return null;
    value = UNKNOWN;
  } else if (GIT_KNOWN_SUBS.has(sub)) {
    return null;
  } else {
    // an alias (`git co`, `git -c alias.x=… x`) or an external git-<x>: it may switch branches
    value = UNKNOWN;
  }
  return () => {
    const hadAll = g.branchesAll;
    const had = typeof key === 'string' && g.branches.has(key);
    const prev = had ? g.branches.get(key) : undefined;
    setBranch(sh, g, key, typeof key === 'string' ? value : UNKNOWN);
    const k = typeof key === 'string' ? BR + key : BRALL;
    sh.lastRisk = {
      node,
      verified: false,
      keys: new Set([k]),
      fail: () => {
        g.branchesAll = hadAll;
        if (typeof key === 'string') {
          if (had) g.branches.set(key, prev);
          else g.branches.delete(key);
        }
      },
    };
    return new Set([k]);
  };
}

// ---------------------------------------------------------------------------------------------
// cd, pushd, popd

// The operands of cd/pushd/popd, or null for an UNKNOWN word or an option other than -L.
function cdOperands(argv) {
  const out = [];
  let opts = true;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') return null;
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a === '-L') continue;
    if (opts && a.length > 1 && a[0] === '-') return null;
    opts = false;
    out.push(a);
  }
  return out;
}

function cdpathMaybeSet(sh, g) {
  if (sh.env.poisoned) return true;
  for (const name of ['CDPATH', 'cdpath']) {
    if (sh.env.has(name)) {
      const v = sh.env.get(name);
      if (isUnknown(v) || (typeof v === 'string' && v !== '')) return true;
    } else if (name === 'CDPATH' && Object.hasOwn(g.hostEnv, name)) {
      const h = g.hostEnv[name];
      if (typeof h !== 'string' || h !== '') return true;
    }
  }
  return false;
}

// A real directory, not a symlink (so a logical `..` after it agrees with the physical one).
function plainDir(p, fsImpl) {
  try {
    const st = fsImpl.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// The logical directory `cd target` reaches from cwd, or UNKNOWN.
function logicalCd(cwd, target, fsImpl) {
  let stack;
  if (target.startsWith('/')) stack = [];
  else if (!isAbs(cwd)) return UNKNOWN;
  else stack = cwd.split('/').filter((s) => s !== '' && s !== '.');
  if (stack.includes('..')) return UNKNOWN;
  const prefixes = [];
  for (const seg of stack) prefixes.push(`${prefixes.length ? prefixes[prefixes.length - 1] : ''}/${seg}`);
  let checked = 0; // prefixes[0..checked) are known plain directories
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      while (checked < stack.length) {
        if (!plainDir(prefixes[checked], fsImpl)) return UNKNOWN;
        checked++;
      }
      stack.pop();
      prefixes.pop();
      checked = Math.min(checked, stack.length);
    } else {
      stack.push(seg);
      prefixes.push(`${prefixes.length ? prefixes[prefixes.length - 1] : ''}/${seg}`);
    }
  }
  const out = prefixes.length ? prefixes[prefixes.length - 1] : '/';
  return out.length > MAX_PATH ? UNKNOWN : out;
}

// cdpath: whether CDPATH may be set when the command starts (read before applySimple, which
// poisons the env for `builtin`/`command`).
function cdTargetPath(op, sh, g, cdpath) {
  if (op === '' || op === '-' || /^[+-][0-9]+$/.test(op)) return UNKNOWN;
  const explicit = op.startsWith('/') || op === '.' || op === '..' || op.startsWith('./') || op.startsWith('../');
  if (!explicit && cdpath) return UNKNOWN;
  return logicalCd(sh.cwd, op, g.fs);
}

function homeTarget(sh, g) {
  // a poisoned env (eval, source, or a nested shell under sudo/env) may hold any HOME
  if (sh.env.poisoned) return UNKNOWN;
  const v = sh.env.has('HOME') ? sh.env.get('HOME') : g.home;
  return isAbs(v) ? logicalCd('/', v, g.fs) : UNKNOWN;
}

function isSearchableDir(p, fsImpl) {
  try {
    if (!fsImpl.statSync(p).isDirectory()) return false;
    if (typeof fsImpl.accessSync === 'function') fsImpl.accessSync(p, nodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Effects of cd/pushd/popd: a read of the target (on eff) and the post step that moves the cwd.
function cdEffect(node, prog, argv, eff, sh, g, cdpath) {
  const prevCwd = sh.cwd;
  const prevDirs = sh.dirs;
  // a glob anywhere in the command's words: the operand may be one
  const ops = node.words.some(hasGlob) ? null : cdOperands(argv);
  let target = UNKNOWN;
  let dirsNext = UNKNOWN;
  if (prog === 'cd') {
    // zsh AUTO_PUSHD makes cd push: with a tracked stack, the stack is no longer known
    dirsNext = Array.isArray(prevDirs) && prevDirs.length === 0 ? prevDirs : UNKNOWN;
    if (ops && ops.length === 0) target = homeTarget(sh, g);
    else if (ops && ops.length === 1) target = cdTargetPath(ops[0], sh, g, cdpath);
  } else if (prog === 'pushd') {
    if (ops && ops.length === 1 && /^[+-][0-9]+$/.test(ops[0])) {
      // pushd +N / -N rotates the stack
      target = UNKNOWN;
    } else if (ops && ops.length === 1) {
      target = cdTargetPath(ops[0], sh, g, cdpath);
      dirsNext = isUnknown(prevDirs) ? UNKNOWN : [...prevDirs, prevCwd];
    } else if (ops && ops.length === 0 && Array.isArray(prevDirs) && prevDirs.length > 0) {
      target = prevDirs[prevDirs.length - 1];
      dirsNext = [...prevDirs.slice(0, -1), prevCwd];
    }
  } else if (ops && ops.length === 0 && Array.isArray(prevDirs) && prevDirs.length > 0) {
    target = prevDirs[prevDirs.length - 1];
    dirsNext = prevDirs.slice(0, -1);
  }
  const stack = dirsNext !== prevDirs;
  let real = UNKNOWN;
  if (isAbs(target)) {
    real = resolvePath(target, '/', g.home, g.fs);
    const operand = ops && ops.length === 1 ? ops[0] : target;
    if (taintedWord(sh, g, operand, real) || taintedWord(sh, g, target, real)) target = UNKNOWN;
  } else {
    target = UNKNOWN;
  }
  eff.reads.push(isAbs(target) ? real : UNKNOWN);
  const verified = isAbs(target) && g.allSafe && isSearchableDir(target, g.fs);
  return () => {
    sh.cwd = target;
    touch(sh, CWD);
    if (stack) {
      sh.dirs = dirsNext;
      touch(sh, DIRS);
    }
    sh.lastRisk = {
      node,
      verified,
      keys: CD_KEYS,
      fail: (s) => {
        s.cwd = prevCwd;
        if (stack) s.dirs = prevDirs;
      },
    };
    if (verified) return EMPTY;
    return stack ? new Set([CWD, DIRS]) : new Set([CWD]);
  };
}

// ---------------------------------------------------------------------------------------------
// Redirections

// Exactly one of the names that are not files (checked on a normalized or resolved path only).
function isNoFile(p) {
  return NO_FILE.has(p) || FD_PATH.test(p);
}

// The absolute path with `.`, empty segments and `..` collapsed lexically, or null.
function lexical(sh, w) {
  const raw = rawAbs(sh, w);
  if (raw === null) return null;
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

function feedsStdin(redirs) {
  return redirs.some((r) => STDIN_REDIRS.has(r.op) && (r.fd === undefined || r.fd === 0));
}

function addClass(eff, c) {
  if (!eff.classes.includes(c)) eff.classes.push(c);
}

// File effects of redirections; targets[i] is the value of redirs[i].target.
function redirEffects(redirs, targets, eff, sh, g) {
  for (let i = 0; i < redirs.length; i++) {
    const { op } = redirs[i];
    const v = targets[i];
    if (op === '<<' || op === '<<-' || op === '<<<') continue;
    if ((op === '>&' || op === '<&') && typeof v === 'string' && (/^[0-9]+$/.test(v) || v === '-')) continue;
    const write = WRITE_REDIRS.has(op);
    const read = READ_REDIRS.has(op);
    let p = UNKNOWN;
    if (typeof v === 'string' && v !== '') {
      // Normalize first, then judge: a raw `/dev/fd/../../etc/hosts` is a file. Without `..` the
      // lexical form is exact (`.` and `//` cannot cross a symlink); with `..` only the resolved
      // path counts.
      const word = v.startsWith('~') ? `./${v}` : v;
      const lex = lexical(sh, word);
      const net = lex === null ? null : NET_PATH.exec(lex);
      if (net) {
        eff.domains.push(hostToDomain(net[1]));
        addClass(eff, 'network-fetch');
        // bash opens /dev/tcp only for that exact spelling; any other spelling is also a path
        if (word === lex) continue;
      }
      const dotdot = word.split('/').includes('..');
      if (!dotdot && lex !== null && isNoFile(lex)) continue;
      p = resolveIn(sh, g, v);
      if (typeof p === 'string' && isNoFile(p)) continue;
      if (taintedWord(sh, g, v, p)) p = UNKNOWN;
    }
    if (write) eff.writes.push(p);
    if (read) eff.reads.push(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Finishing an effective command. Later tasks (T14-T18) add steps here; each step may change the
// command, add commands to g.commands, or throw an Opaque.

function stdinInterpreterStep(eff, info) {
  // a busybox/toybox applet is the program it names
  const prog = programName(appletArgv(eff.argv)[0]);
  if (!info.stdin || prog === null) return;
  const base = prog.toLowerCase(); // case-insensitive volumes run `BASH` as bash
  // a shell (or eval) spelled exactly as unwrap.mjs reads it: its feed is judged there
  if (NESTED_HANDLED.has(base) && (base !== 'eval' || eff.argv[0] === 'eval')) return;
  if (STDIN_INTERPRETERS.has(base) || PYTHON.test(base)) {
    throw new Opaque('unsupported', 'stdin-interpreter', info.off);
  }
}

// Proxy variables that send a connection to another host (a prefix assignment of the command).
const PROXY_VARS = /^(?:http|https|all|ftp|socks|rsync)_proxy$/i;

function pushAll(list, items) {
  const seen = new Set(list);
  for (const x of items) {
    if (seen.has(x)) continue;
    seen.add(x);
    list.push(x);
  }
}

// Is the path (or a path just below it) one of the built-in protected paths? `projectRoots`
// bring the per-project `.claude/` and `.codex/` globs. Injectable through ctx.isProtected(path,
// roots); an error while deciding counts as protected (fail closed).
function protectedDir(path, roots, g) {
  const key = `${path}\0${roots.join('\0')}`;
  if (g.protectedCache.has(key)) return g.protectedCache.get(key);
  let hit;
  try {
    if (g.isProtected) hit = g.isProtected(path, roots) === true;
    else {
      const opts = {
        home: g.home,
        platform: process.platform,
        caseInsensitive: isCaseInsensitive(path, g.fs),
        projectRoots: roots,
      };
      if (g.fs.realpathSync && typeof g.fs.realpathSync.native === 'function') opts.realpath = g.fs.realpathSync.native;
      // the directory itself, and a child (a glob like `skills/**` does not name `skills`)
      hit = checkPathWrite(path, opts) !== null || checkPathWrite(path === '/' ? '/x' : `${path}/x`, opts) !== null;
    }
  } catch {
    hit = true;
  }
  g.protectedCache.set(key, hit);
  return hit;
}

// Classes, network domains and file effects of the command's arguments (tables/classes.mjs).
function commandEffectsStep(eff, info, sh, g) {
  const argv = eff.argv;
  if (argv.length > 0) {
    // a wrapper PRE_STEPS removed still contributes its own class (sudo -> privilege)
    for (const layer of info.unwrapped) for (const c of classesOf(layer)) addClass(eff, c);
    const classes = classesOf(argv);
    for (const c of classes) addClass(eff, c);
    const domains = domainsOf(argv);
    if (classes.includes('network-fetch') && eff.env && typeof eff.env === 'object') {
      for (const k of Object.keys(eff.env)) {
        if (!PROXY_VARS.test(k)) continue;
        const v = eff.env[k];
        if (v === '') continue;
        domains.push(typeof v === 'string' ? (urlDomainOf(v) ?? UNKNOWN) : UNKNOWN);
      }
    }
    pushAll(eff.domains, domains);
    const roots = [];
    if (eff.repo && typeof eff.repo === 'object' && typeof eff.repo.root === 'string') roots.push(eff.repo.root);
    if (isAbs(eff.cwd)) roots.push(eff.cwd);
    const fx = fileEffects(argv, {
      cwd: eff.cwd,
      home: g.home,
      // a path named after an in-command mv or ln is UNKNOWN, attached values included
      resolve: (w) => {
        const p = resolveIn(sh, g, w);
        return taintedWord(sh, g, w, p) ? UNKNOWN : p;
      },
      isProtected: (p) => protectedDir(p, roots, g),
      exists: (p) => exists(p, g),
    });
    pushAll(eff.reads, fx.reads);
    pushAll(eff.writes, fx.writes);
  }
  // /proc/*/environ read through an operand or a redirection
  if (eff.reads.some(isEnvironPath)) addClass(eff, 'env-dump');
}

// ---------------------------------------------------------------------------------------------
// Bulk writers, patch targets and git tree updates (T18; tables/bulk.mjs reads the command line).
//
// - copy/move: for each (source, destination) pair the source's tree lands at the destination or
//   at destination/<source basename> (both are judged). Only the source's files under the
//   protected relative subpaths (PROJECT_SUBGLOBS) are looked for, and added to `writes` as
//   <landing>/<relpath>; when the landing itself is named like the first segment of a subglob
//   (`mv evil .claude`), the source's top-level children matching the rest are added too. Nothing
//   else in the source is read: literal segments are lstat'ed, a wildcard segment reads one
//   directory, `**` walks at most MAX_WALK_ENTRIES entries MAX_WALK_DEPTH deep (past that, or on
//   a read error: an UNKNOWN write). A symlink on a literal segment lands as a link: a `link` op.
//   A source whose contents cannot be known (UNKNOWN, remote) gives the destination a `bulk` op;
//   an UNKNOWN destination is an UNKNOWN `bulk` op. move adds `move` ops on source and destination.
// - archive: each destination gets a `bulk` op (the evaluator's ancestor check judges it).
// - patch: the targets read from the patch (resolve/patch.mjs through ctx.patchTargets, or a literal
//   stdin feed) are writes, joined to the patch base (patch -d, else the cwd; git apply/am: the
//   repository root and the cwd, plus --directory). An unreadable or non-literal patch is opaque
//   `patch-unreadable`. `patch ORIGINAL …` writes ORIGINAL only (already an operand write).
// - git tree update: opaque `git-tree-update` when the repository cannot be resolved; opaque
//   `git-config-written` when the repo's config or any file it includes is in ctx.writtenIndex or
//   was written earlier in this call (before ctx.gitTreeDiff is called); a HEAD target is
//   unaffected; otherwise one ctx.gitTreeDiff call over TREE_PATHSPECS. Listed protected files
//   are added to `writes`; an UNKNOWN answer, an unnameable target, or a listed protected file
//   in a repository that has `.claude/` or `.codex/` at its root is opaque `git-tree-update`
//   (spec: "makes the call opaque when the repo tracks anything under its protected subpaths").

const WILD = /[*?[]/;
const segmentRes = new Map();
function segmentRe(seg) {
  if (!segmentRes.has(seg)) {
    const src = seg.replace(/[.+^${}()|\\\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    segmentRes.set(seg, new RegExp(`^${src}$`, 'i'));
  }
  return segmentRes.get(seg);
}

class WalkLimit extends Error {}
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function lstatOrNull(p, g) {
  try {
    return g.fs.lstatSync(p);
  } catch (e) {
    if (MISSING_CODES.has(e && e.code)) return null;
    throw new WalkLimit('read');
  }
}

function direntsOf(dir, g, budget) {
  let ents;
  try {
    ents = g.fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (MISSING_CODES.has(e && e.code)) return [];
    throw new WalkLimit('read');
  }
  if (!Array.isArray(ents)) throw new WalkLimit('read');
  budget.n += ents.length;
  if (budget.n > MAX_WALK_ENTRIES) throw new WalkLimit('entries');
  return ents;
}

const joinRel = (a, b) => (a === '' ? b : `${a}/${b}`);
const joinAbs = (a, b) => (a === '/' ? `/${b}` : `${a}/${b}`);

// Every path under dir (dir itself included, as prefix), bounded.
function walkAll(dir, prefix, out, budget, depth, g) {
  out.files.push(prefix);
  if (depth >= MAX_WALK_DEPTH) throw new WalkLimit('depth');
  for (const e of direntsOf(dir, g, budget)) {
    const rel = joinRel(prefix, String(e.name));
    if (e.isDirectory()) walkAll(joinAbs(dir, String(e.name)), rel, out, budget, depth + 1, g);
    else out.files.push(rel);
  }
}

// The paths under dir matching the glob segments, relative to dir (prefixed).
function globWalk(dir, segs, prefix, out, budget, g) {
  if (segs.length === 0) {
    out.files.push(prefix);
    return;
  }
  const [seg, ...rest] = segs;
  if (seg === '**') {
    walkAll(dir, prefix, out, budget, 0, g);
    return;
  }
  const visit = (name) => {
    const p = joinAbs(dir, name);
    const rel = joinRel(prefix, name);
    const st = lstatOrNull(p, g);
    if (st === null) return;
    if (st.isSymbolicLink() && rest.length > 0) {
      out.links.push(rel);
      return;
    }
    if (rest.length === 0 || !st.isDirectory()) out.files.push(rel);
    else globWalk(p, rest, rel, out, budget, g);
  };
  if (!WILD.test(seg)) visit(seg);
  else for (const e of direntsOf(dir, g, budget)) if (segmentRe(seg).test(String(e.name))) visit(String(e.name));
}

// What landing at `landing` from source directory `src` writes under the protected subpaths:
// {files: rel[], links: rel[], unknown: boolean}.
// Memoized per source (and per first segment the landing is named after).
function protectedRels(src, landing, g) {
  const name = landing.slice(landing.lastIndexOf('/') + 1).toLowerCase();
  const merged = { files: [], links: [], unknown: false };
  const parts = [scanSource(src, null, g)];
  for (const glob of PROTECTED_SUBGLOBS) {
    const first = glob.split('/')[0];
    if (!WILD.test(first) && first.toLowerCase() === name) parts.push(scanSource(src, first, g));
  }
  for (const r of parts) {
    merged.files.push(...r.files);
    merged.links.push(...r.links);
    merged.unknown = merged.unknown || r.unknown;
  }
  return merged;
}

// first = null: the source's own protected subpaths; first = '.claude': the rest of every
// subglob that starts with it (the landing becomes that directory).
function scanSource(src, first, g) {
  const key = `${src}\0${first ?? ''}`;
  if (g.bulkScans.has(key)) return g.bulkScans.get(key);
  const out = { files: [], links: [], unknown: false };
  const budget = { n: 0 };
  try {
    for (const glob of PROTECTED_SUBGLOBS) {
      const segs = glob.split('/');
      if (first === null) globWalk(src, segs, '', out, budget, g);
      else if (segs.length > 1 && segs[0] === first) {
        // the source's top-level children are the landing's children
        if (segs[1] === '**') out.files.push('');
        else globWalk(src, segs.slice(1), '', out, budget, g);
      }
    }
  } catch (e) {
    if (!(e instanceof WalkLimit)) throw e;
    out.unknown = true;
  }
  g.bulkScans.set(key, out);
  return out;
}

function pushOp(eff, path, op) {
  if (!eff.ops.some((o) => o.op === op && o.path === path)) eff.ops.push({ path, op });
}

// A word resolved like an argument (taint-aware), relative to a git -C base when given.
function bulkResolver(sh, g, base) {
  return (w) => {
    if (typeof w !== 'string') return UNKNOWN;
    let word = w;
    if (base !== undefined && !w.startsWith('/')) {
      if (typeof base !== 'string') return UNKNOWN;
      word = w === '.' ? base : `${base}/${w}`;
    }
    const p = resolveIn(sh, g, word);
    return isAbs(p) && !taintedWord(sh, g, word, p) ? p : UNKNOWN;
  };
}

function wordBase(w) {
  if (typeof w !== 'string') return null;
  const t = w.replace(/\/+$/, '');
  const b = t.slice(t.lastIndexOf('/') + 1);
  return b === '' || b === '.' || b === '..' ? null : b;
}

function judgePairs(eff, b, sh, g, res) {
  for (const { src, dest } of b.pairs) {
    const d = res(dest);
    if (!isAbs(d)) {
      pushOp(eff, UNKNOWN, 'bulk');
      continue;
    }
    const s = res(src);
    if (b.kind === 'move') {
      pushOp(eff, d, 'move');
      if (isAbs(s)) pushOp(eff, s, 'move');
    }
    if (!isAbs(s)) {
      pushOp(eff, d, 'bulk');
      continue;
    }
    const landings = new Set([d]);
    for (const n of [wordBase(src), wordBase(s)]) if (n !== null) landings.add(joinAbs(d, n));
    for (const l of landings) {
      pushAll(eff.writes, [l]);
      const r = protectedRels(s, l, g);
      if (r.unknown) pushAll(eff.writes, [UNKNOWN]);
      for (const rel of r.files) pushAll(eff.writes, [rel === '' ? l : res(joinAbs(l, rel))]);
      for (const rel of r.links) pushOp(eff, res(joinAbs(l, rel)), 'link');
    }
  }
}

// The text or targets of the patch a command reads from stdin, or null when nothing is fed.
function stdinPatch(info, sh, g, strip) {
  if (!info.stdin) return null;
  if (typeof info.feed === 'string') return patchTargetsFromText(info.feed, { strip });
  const redirs = info.node && Array.isArray(info.node.redirs) ? info.node.redirs : [];
  let file = null;
  for (const r of redirs) {
    if (!(r.fd === undefined || r.fd === 0)) continue;
    if (r.op === '<') file = r.target ? literalValue(r.target) : null;
    else if (STDIN_REDIRS.has(r.op)) file = null;
  }
  if (typeof file !== 'string') return UNKNOWN;
  const abs = resolveIn(sh, g, file);
  return isAbs(abs) ? g.patchTargets(abs, g.fs, { strip }) : UNKNOWN;
}

function judgePatch(eff, b, info, sh, g, res) {
  if (b.readOnly) return;
  const off = info.off || 0;
  const unreadable = () => new Opaque('unknown', 'patch-unreadable', off);
  if (b.program === 'patch' && b.original !== undefined) return;
  if (isUnknown(b.strip)) throw unreadable();
  const lists = [];
  if (b.files.length === 0) {
    const t = stdinPatch(info, sh, g, b.strip);
    if (t === null) return;
    lists.push(t);
  } else {
    for (const f of b.files) {
      if (f === '-') {
        // git apply - / git am -: the patch is stdin
        const t = stdinPatch(info, sh, g, b.strip);
        lists.push(t === null ? UNKNOWN : t);
        continue;
      }
      const abs = res(f);
      if (!isAbs(abs)) throw unreadable();
      let t;
      try {
        t = g.patchTargets(abs, g.fs, { strip: b.strip });
      } catch {
        t = UNKNOWN;
      }
      lists.push(t);
    }
  }
  if (lists.some((t) => !Array.isArray(t))) throw unreadable();
  const bases = [];
  if (b.program === 'patch') bases.push(res(b.dir ?? '.'));
  else {
    const repo = eff.repo;
    if (!b.noIndex && repo !== null) bases.push(repo && isAbs(repo.root) ? repo.root : UNKNOWN);
    bases.push(res('.'));
  }
  const dir = b.program !== 'patch' && typeof b.dir === 'string' ? b.dir.replace(/\/+$/, '') : '';
  for (const base of new Set(bases)) {
    if (!isAbs(base)) {
      pushAll(eff.writes, [UNKNOWN]);
      continue;
    }
    for (const t of lists.flat()) {
      if (typeof t !== 'string') {
        pushAll(eff.writes, [UNKNOWN]);
        continue;
      }
      const rel = dir !== '' && !t.startsWith('/') ? `${dir}/${t}` : t;
      const p = resolveIn(sh, g, rel.startsWith('/') ? rel : joinAbs(base, rel));
      pushAll(eff.writes, [isAbs(p) ? p : UNKNOWN]);
    }
  }
}

function writtenSet(index) {
  const out = new Set();
  if (index === null || typeof index !== 'object' || typeof index[Symbol.iterator] !== 'function') return out;
  for (const p of index) if (isAbs(p)) out.add(p);
  return out;
}

// Was the repository's config (or a file it includes) written by the agent, earlier in the
// session (ctx.writtenIndex) or earlier in this call? Undeterminable counts as written.
function configWritten(gitDir, eff, g) {
  const earlier = new Set();
  for (const c of [...g.commands, eff]) for (const w of c.writes) if (isAbs(w)) earlier.add(w);
  if (g.written.size === 0 && earlier.size === 0) return false;
  if (!isAbs(gitDir)) return true;
  const read = (p) => {
    try {
      // the size first: a file over the cap is never read (gitConfigFiles answers UNKNOWN)
      const st = g.fs.statSync(p);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new Error('config-size');
      const t = g.readFile ? g.readFile(p) : g.fs.readFileSync(p, 'utf8');
      return typeof t === 'string' ? t : t === null || t === undefined ? null : String(t);
    } catch (e) {
      if (MISSING_CODES.has(e && e.code)) return null;
      throw e;
    }
  };
  const files = gitConfigFiles(gitDir, { read, home: g.home });
  if (!Array.isArray(files)) return true;
  const hit = (p) => g.written.has(p) || earlier.has(p);
  return files.some((f) => hit(f) || hit(resolvePath(f, '/', g.home, g.fs)));
}

// target: the revision the tree moves to; land: where the listed files land (the repository
// root, or a new worktree's path).
function judgeGitTree(eff, b, info, sh, g, target = b.target, land = undefined) {
  const off = info.off || 0;
  const repo = eff.repo;
  if (repo === null) return; // not a repository: git fails
  const entry = g.gitRepos.has(eff) ? g.gitRepos.get(eff) : { repo: cwdRepo(sh, g), custom: false };
  const raw = entry.repo;
  if (isUnknown(repo) || !isAbs(repo.root) || !raw || isUnknown(raw) || !isAbs(raw.gitDir)) throw new Opaque('unknown', 'git-tree-update', off);
  if (configWritten(raw.gitDir, eff, g)) throw new Opaque('unsupported', 'git-config-written', off);
  if (target === 'HEAD') return;
  let listed = UNKNOWN;
  if (target !== UNNAMEABLE && !entry.custom) {
    try {
      listed = g.gitTreeDiff({ root: repo.root, branch: repo.branch }, target, TREE_PATHSPECS);
    } catch {
      listed = UNKNOWN;
    }
    // git itself said WORD is not a revision: `git checkout WORD` (WORD also a path) restores the
    // path, `git worktree add PATH` makes a new branch from HEAD. Anything else is unnameable.
    if (listed === NOT_A_REVISION && (b.ambiguousPath || b.newBranchGuess)) return;
  }
  const tracked = exists(joinAbs(repo.root, '.claude'), g) || exists(joinAbs(repo.root, '.codex'), g) || indexMentionsProtected(joinAbs(raw.gitDir, 'index'), g.fs);
  if (!Array.isArray(listed)) {
    if (tracked) throw new Opaque('unknown', 'git-tree-update', off);
    return;
  }
  const hits = listed.filter((p) => typeof p !== 'string' || inProtectedSubpath(p));
  if (hits.length === 0) return;
  if (tracked) throw new Opaque('unknown', 'git-tree-update', off);
  const at = isAbs(land) ? land : land === undefined ? repo.root : UNKNOWN;
  for (const h of hits) {
    const p = typeof h === 'string' && !h.startsWith('/') && isAbs(at) ? resolveIn(sh, g, joinAbs(at, h)) : UNKNOWN;
    pushAll(eff.writes, [isAbs(p) ? p : UNKNOWN]);
  }
}

function bulkStep(eff, info, sh, g) {
  const argv = eff.argv;
  if (argv.length === 0 || typeof argv[0] !== 'string') return;
  const b = bulkOf(argv, {
    exists: (w, base) => {
      const p = bulkResolver(sh, g, base)(w);
      return isAbs(p) && exists(p, g);
    },
  });
  if (b === null) return;
  const res = bulkResolver(sh, g, b.base);
  switch (b.kind) {
    case 'copy':
    case 'move':
      judgePairs(eff, b, sh, g, res);
      break;
    case 'archive':
      for (const d of b.dests) {
        const p = res(d);
        pushOp(eff, isAbs(p) ? p : UNKNOWN, 'bulk');
      }
      // a new worktree checks out with this repository's hooks and config, from its commit-ish
      if (b.sub === 'worktree') {
        const land = res(b.dests[0]);
        judgeGitTree(eff, b, info, sh, g, b.treeTarget, isAbs(land) ? land : UNKNOWN);
      }
      break;
    case 'index':
      if (b.opaque) throw new Opaque('unsupported', 'index-write', info.off || 0);
      for (const p of b.paths) {
        const r = res(p);
        pushAll(eff.writes, [isAbs(r) ? r : UNKNOWN]);
      }
      break;
    case 'patch':
      judgePatch(eff, b, info, sh, g, res);
      break;
    case 'git-tree':
      judgeGitTree(eff, b, info, sh, g);
      break;
    default:
      break;
  }
}

/**
 * Steps run on every finished effective command, after cd/git/ops dispatch (enrichment: classes,
 * file effects). Each is step(eff, info, sh, g); it may change eff, add commands to g.commands, or
 * throw an Opaque. info = {node, off, stdin, unwrapped}: unwrapped lists the argv of every wrapper
 * layer PRE_STEPS removed, outermost first.
 */
export const FINISH_STEPS = [stdinInterpreterStep, commandEffectsStep, bulkStep];

// ---------------------------------------------------------------------------------------------
// Code-loading variables (tables/envvars.mjs holds the list). loadingVar is the one place that
// throws; every site below calls it with the variable's name and the value it would get (UNKNOWN
// when there is none, as for export, unset and env -u).
const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

function loadingVar(name, value, off) {
  if (isCodeLoadingAssignment(name, value)) throw new Opaque('unsupported', 'code-loading-var', off);
}

// The literal text a word starts with (up to its first expansion or glob) and whether the whole
// word is literal: what a word's name can still be shown to be when its value is UNKNOWN.
function leadOf(word) {
  const ps = word && Array.isArray(word.parts) ? word.parts : [];
  let lead = '';
  let full = true;
  for (const p of ps) {
    if (p.type === 'lit') lead += p.text;
    else {
      full = false;
      break;
    }
  }
  return { lead, full };
}

// The variable a declaration-style word names: `NAME`, `NAME=v`, `NAME+=v`, `NAME[i]=v`, zsh
// `NAME?prompt` (read). null when the word names no variable (a prompt, a number).
function wordVar(text) {
  const m = NAME_PREFIX.exec(text);
  if (m === null) return null;
  const rest = text.slice(m[0].length);
  if (rest === '' || rest[0] === '?') return { name: m[0], value: UNKNOWN };
  if (rest[0] === '=') return { name: m[0], value: rest.slice(1) };
  if (rest.startsWith('+=')) return { name: m[0], value: rest.slice(2) };
  if (rest[0] === '[') {
    const close = rest.indexOf(']=');
    return { name: m[0], value: close >= 0 ? rest.slice(close + 2) : UNKNOWN };
  }
  return null;
}

// One word that names a variable. text is the resolved word (a string) or UNKNOWN; lead is the
// word's literal start, used when the word is UNKNOWN. A word whose name cannot be shown is opaque.
function checkVarWord(text, lead, off) {
  if (typeof text === 'string') {
    if (text.startsWith('-') || text.startsWith('+')) return; // a flag
    const v = wordVar(text);
    if (v !== null) loadingVar(v.name, v.value, off);
    return;
  }
  if (lead !== undefined && lead !== null) {
    if (lead.lead.startsWith('-') || lead.lead.startsWith('+')) return;
    const m = NAME_PREFIX.exec(lead.lead);
    if (m !== null) {
      const rest = lead.lead.slice(m[0].length);
      // the name ends inside the literal start: NAME=…, NAME+=…, NAME[…, or NAME alone
      const ends = rest === '' ? lead.full : rest[0] === '=' || rest[0] === '[' || rest[0] === '?' || rest.startsWith('+=');
      if (ends) {
        loadingVar(m[0], UNKNOWN, off);
        return;
      }
    }
  }
  loadingVar(UNKNOWN, UNKNOWN, off); // cannot be shown not to be listed
}

// The leads of the unwrapped command's words: the original words' tail (a word a wrapper replaced
// has none).
function leadsFor(argv, inner, leads) {
  if (!Array.isArray(leads) || leads.length !== argv.length) return null;
  const k = argv.length - inner.length;
  if (k < 0) return null;
  return inner.map((x, j) => (argv[k + j] === x ? leads[k + j] : undefined));
}

// Arithmetic text (`$(( … ))`, a `let` argument) that assigns: `NAME=`, `NAME+=`, `NAME++`, `++NAME`,
// `NAME[i]=` of a listed name, or any assignment next to a computed name (`$`, backtick). Linear:
// the lookbehind keeps a match from starting inside an identifier.
const ARITH_ASSIGN_OP = /(?:^|[^=!<>])=(?!=)|[-+*/%&|^]=|<<=|>>=/;
const ARITH_TARGET = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:(?:<<|>>|[-+*/%&|^])?=(?!=)|\+\+|--)/g;
const ARITH_PRE = /(?:\+\+|--)[ \t]*([A-Za-z_][A-Za-z0-9_]*)/g;
const ARITH_SUBSCRIPT = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)[ \t]*\[/g;
function arithAssigns(text, off) {
  if (typeof text !== 'string') return loadingVar(UNKNOWN, UNKNOWN, off);
  for (const m of text.matchAll(ARITH_TARGET)) loadingVar(m[1], UNKNOWN, off);
  for (const m of text.matchAll(ARITH_PRE)) loadingVar(m[1], UNKNOWN, off);
  if (ARITH_ASSIGN_OP.test(text) || text.includes('++') || text.includes('--')) {
    for (const m of text.matchAll(ARITH_SUBSCRIPT)) loadingVar(m[1], UNKNOWN, off);
    if (/[$`]/.test(text) && ARITH_ASSIGN_OP.test(text)) loadingVar(UNKNOWN, UNKNOWN, off);
    // `$n++`, `++$n`, `n--` on a computed name
    if (/[$`]/.test(text) && (text.includes('++') || text.includes('--'))) loadingVar(UNKNOWN, UNKNOWN, off);
  }
}

// Leading flag words of a declaration builtin or unset: their letters (all, and those given with
// `-`), and the index of the first word that is not a flag.
function leadingFlags(argv) {
  let i = 1;
  let letters = '';
  let minus = '';
  while (i < argv.length && typeof argv[i] === 'string' && argv[i].length > 1 && (argv[i][0] === '-' || argv[i][0] === '+')) {
    if (argv[i] === '--') {
      i++;
      break;
    }
    letters += argv[i].slice(1);
    if (argv[i][0] === '-') minus += argv[i].slice(1);
    i++;
  }
  return { letters, minus, next: i };
}

// read: bash/sh take option values (-p PROMPT -t -u -d -n -N -i) that are not names, and -a NAME;
// zsh's -p has no operand, so every word is a name except the values of -u and -d.
function readTargets(argv, at, kind, off) {
  const zsh = kind !== 'bash';
  const valued = zsh ? 'ud' : 'ptudnNi';
  let names = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!names && typeof a === 'string' && a.length > 1 && a[0] === '-') {
      if (a === '--') {
        names = true;
        continue;
      }
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (valued.includes(c)) {
          if (k === a.length - 1) i++; // the value is the next word
          break;
        }
        if (!zsh && c === 'a') {
          if (k < a.length - 1) checkVarWord(a.slice(k + 1), undefined, off);
          else if (++i < argv.length) checkVarWord(argv[i], at(i), off);
          break;
        }
      }
      continue;
    }
    names = true;
    checkVarWord(a, at(i), off);
  }
}

// mapfile/readarray: options with a value (-d -n -O -s -u -C -c), then the target array.
function mapfileTarget(argv, at, off) {
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || a.length < 2 || a[0] !== '-') break;
    if (a === '--') {
      i++;
      break;
    }
    for (let k = 1; k < a.length; k++) {
      if ('dnOsuCc'.includes(a[k])) {
        if (k === a.length - 1) i++;
        break;
      }
    }
  }
  if (i < argv.length) checkVarWord(argv[i], at(i), off); // no target: MAPFILE, which is not listed
}

// vared [-Aache] [-p P] [-r R] [-M M] [-m m] [-i W] [-f W] [-t TTY] NAME: flag values are not names.
function varedTarget(argv, at, off) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a === 'string' && a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        if ('prMmifLt'.includes(a[k])) {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    checkVarWord(a, at(i), off);
  }
}

// zparseopts [-D -E -F -K -M] [-a ARRAY] [-A ASSOC] [-] SPEC…: ARRAY and ASSOC are targets, and so is
// the NAME of every spec `x=NAME`, `x:=NAME`, `x+=NAME`, `-long=NAME`. A word that is not literal
// cannot be shown not to name a listed target.
function zparseTargets(argv, at, off) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      loadingVar(UNKNOWN, UNKNOWN, off);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      checkVarWord(a.slice(eq + 1), undefined, off);
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'a' || a[k] === 'A') {
          if (k < a.length - 1) checkVarWord(a.slice(k + 1), undefined, off);
          else if (++i < argv.length) checkVarWord(argv[i], at(i), off);
          break;
        }
      }
    }
  }
}

// zsh `print -v NAME`.
function printTarget(argv, at, off) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || a.length < 2 || a[0] !== '-' || a === '--') return;
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (c === 'v') {
        if (k < a.length - 1) checkVarWord(a.slice(k + 1), undefined, off);
        else if (++i < argv.length) checkVarWord(argv[i], at(i), off);
        else return;
        break;
      }
      if (c === 'u' || c === 'C') {
        if (k === a.length - 1) i++;
        break;
      }
    }
  }
}

const KEYWORD_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// `set -k`, `set -o keyword`, and a shell started with -k or -o keyword: every NAME=v word, wherever it
// stands, then assigns (bash "keyword" mode).
function keywordAssign(argv0, off) {
  const argv = appletArgv(argv0);
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') return;
  const isSet = argv[0] === 'set';
  if (!isSet && !KEYWORD_SHELLS.has(programName(argv[0]))) return;
  const fail = () => {
    throw new Opaque('unsupported', 'keyword-assign', off);
  };
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (typeof w !== 'string') return isSet ? fail() : undefined; // a shell's unknown flag is opaque in unwrap.mjs
    if (w === '--' || w.length < 2 || (w[0] !== '-' && w[0] !== '+')) return;
    for (let k = 1; k < w.length; k++) {
      const c = w[k];
      if (c === 'k' && w[0] === '-') fail();
      if (c === 'o' || (c === 'O' && !isSet)) {
        const name = argv[++i];
        if (c === 'o' && w[0] === '-' && (typeof name !== 'string' || name === 'keyword')) fail();
      }
    }
  }
}

// zsh builtins that store a result in a named variable: getln NAME, zstyle -s|-g|-a|-b CTX STYLE NAME,
// zformat -f|-a|-F NAME …, zselect, zsystem, zstat, pcre_match and private (module builtins), strftime -s NAME FORMAT TIME, sysread [-c COUNTVAR] [-o|-i FD] [NAME]. (zcompile
// writes a file, not a variable.)
function zshWriter(argv) {
  const f = typeof argv[1] === 'string' ? argv[1] : '';
  switch (argv[0]) {
    case 'getln':
    case 'sysread':
    case 'zselect':
    case 'zsystem':
    case 'zstat':
    case 'pcre_match':
    case 'private':
      return true;
    case 'zstyle':
      return /^-[sgab]$/.test(f);
    case 'zformat':
      return /^-[faF]$/.test(f);
    case 'strftime':
      return argv.some((a, i) => i > 0 && typeof a === 'string' && /^-[A-Za-z]*s/.test(a));
    default:
      return false;
  }
}

// Commands that name variables: export, declare, typeset, readonly, local, unset, read, printf -v,
// print -v, getopts, mapfile, readarray, let, vared, zparseopts. kind is the shell's ('bash' or 'zsh').
function declaredVars(argv, leads, off, kind) {
  const cmd = argv[0];
  const at = (i) => (Array.isArray(leads) ? leads[i] : undefined);
  // a command word shaped like an assignment (`doas HOME=x ls`, which doas takes for a program, or
  // a quoted `'HOME=x'`): judged as the assignment it looks like
  const asg = typeof cmd === 'string' ? ENV_ASSIGNMENT.exec(cmd) : null;
  if (asg !== null) loadingVar(asg[1], asg[2], off);
  keywordAssign(argv, off);
  // zsh's integer and float declare (and assign) like typeset
  const zshDeclare = kind !== 'bash' && (cmd === 'integer' || cmd === 'float');
  if (DECLARE_COMMANDS.has(cmd) || cmd === 'unset' || zshDeclare) {
    const { letters, minus, next } = leadingFlags(argv);
    // unset -f works on functions: no variable is assigned
    if (cmd === 'unset' && letters.includes('f')) return;
    // a nameref (`declare -n r=X`, or `declare -n r` then `r=X`) makes later plain assignments land on
    // another variable, which is not tracked: any nameref declaration is opaque (export -n unexports)
    if ((cmd === 'declare' || cmd === 'typeset' || cmd === 'local') && minus.includes('n')) loadingVar(UNKNOWN, UNKNOWN, off);
    // -p prints and -f works on functions (bash -F lists them, zsh -F is a float format): the bare
    // NAME words assign nothing, but a NAME=value word still does
    const bare = cmd !== 'unset' && (kind === 'bash' ? /[pfF]/ : /[pf]/).test(letters);
    for (let i = next; i < argv.length; i++) {
      if (bare) {
        const w = argv[i];
        const l = at(i);
        if (typeof w === 'string' ? !w.includes('=') : !(l && l.lead.includes('='))) continue;
      }
      checkVarWord(argv[i], at(i), off);
    }
  } else if (cmd === 'read') {
    readTargets(argv, at, kind, off);
  } else if (cmd === 'printf' && typeof argv[1] === 'string' && argv[1].startsWith('-v')) {
    // `printf -v NAME …` / `printf -vNAME …`
    if (argv[1] === '-v') checkVarWord(argv[2], at(2), off);
    else checkVarWord(argv[1].slice(2), undefined, off);
  } else if (cmd === 'print') {
    printTarget(argv, at, off);
  } else if (cmd === 'getopts') {
    if (argv.length > 2) checkVarWord(argv[2], at(2), off);
  } else if (cmd === 'mapfile' || cmd === 'readarray') {
    mapfileTarget(argv, at, off);
  } else if (cmd === 'let') {
    for (let i = 1; i < argv.length; i++) {
      if (typeof argv[i] === 'string') arithAssigns(argv[i], off);
      else {
        // an UNKNOWN expression is judged by its literal start; its name must end there
        const l = at(i);
        const lead = l ? l.lead : '';
        arithAssigns(lead, off);
        if (!/^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:(?:<<|>>|[-+*/%&|^])?=|\+\+|--)/.test(lead)) loadingVar(UNKNOWN, UNKNOWN, off);
      }
    }
  } else if (cmd === 'vared') {
    varedTarget(argv, at, off);
  } else if (cmd === 'zparseopts') {
    zparseTargets(argv, at, off);
  } else if (zshWriter(argv)) {
    // zsh builtins that write a named variable: every bare word may be the target
    for (let i = 1; i < argv.length; i++) checkVarWord(argv[i], at(i), off);
  }
}

// env's own words (before the program): NAME=v, -u NAME, --unset=NAME, -i, - and
// --ignore-environment. Done on the layer's words, not on stripOne's result, which drops them for
// a script layer (`env -S`) and for a call that runs no command.
function envLayer(argv, off) {
  const { short, long } = valueFlags('env');
  const wipe = () => {
    throw new Opaque('unsupported', 'code-loading-var', off);
  };
  let done = false; // after `--`, only assignments remain
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') return; // stripOne is opaque on it
    const asg = ENV_ASSIGNMENT.exec(a);
    if (asg !== null) {
      loadingVar(asg[1], asg[2], off);
      continue;
    }
    if (a === '-') wipe(); // POSIX spelling of -i
    if (done || a.length < 2 || a[0] !== '-') return; // the program
    if (a === '--') {
      done = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const raw = (eq < 0 ? a : a.slice(0, eq)).slice(2);
      // GNU abbreviations: any prefix of --ignore-environment or --unset
      if ('ignore-environment'.startsWith(raw)) wipe();
      if ('unset'.startsWith(raw)) {
        const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
        loadingVar(v, UNKNOWN, off);
      } else if (eq < 0 && long.some((l) => l.slice(2).startsWith(raw))) i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (c === 'i') wipe();
      if (short.includes(c)) {
        const rest = a.slice(k + 1);
        const v = rest !== '' ? rest : argv[++i];
        if (c === 'u') loadingVar(v, UNKNOWN, off);
        break;
      }
    }
  }
}

// The wrapper a program word names, for the checks above (stripOne's own name rules: basename,
// lower case, a GNU `g` prefix).
function wrapperBase(word) {
  if (typeof word !== 'string') return null;
  const lower = word.slice(word.lastIndexOf('/') + 1).toLowerCase();
  return lower === 'genv' ? 'env' : lower;
}

// Wrappers (tables/wrappers.mjs): sudo, doas, env, timeout, time, nice, nohup, stdbuf, command
// (not -v/-V), builtin, exec, setsid, flock, watch, xargs, noglob, nocorrect. One layer per retry.
// `builtin X` / `command X` (and a leading `time`, the reserved word) run X in this shell (so
// `builtin cd` and `time cd` are cd); the others run X as a new process (`external`), where a cd
// cannot move the shell. A script layer (env -S, flock -c, watch, sudo -s) stops the stripping:
// the layer stays the command and its script is recorded in `scripts` for unwrap.mjs, which
// re-parses it after the command is finished (or is opaque). Any doubt (an unknown flag, an
// UNKNOWN word where a flag or the program goes) is opaque, in the walk and in the loop scan alike.
function wrapperStep({ argv, node, first, scripts }, sh, g) {
  const off = node && node.off ? node.off : 0;
  const base = wrapperBase(argv[0]);
  if (base === 'env') envLayer(argv, off);
  const r = stripOne(argv, { bareHead: first === true && bareHead(node) });
  if (r === null) {
    // sudo -s HOME=x, sudo -i HOME=x, sudo -E HOME=x: no program is left, but the shell it starts
    // (or the environment it keeps) still gets the assignments
    if (base === 'sudo' || base === 'doas' || base === 'su') {
      for (const a of argv.slice(1)) {
        const asg = typeof a === 'string' ? ENV_ASSIGNMENT.exec(a) : null;
        if (asg !== null) loadingVar(asg[1], asg[2], off);
      }
    }
    return null;
  }
  if (r.opaque) throw new Opaque(r.opaque.reason, r.opaque.construct, off);
  // sudo, doas: NAME=v words (env's were checked above); a script layer drops them from the result
  if (base !== 'env') {
    if (r.script !== undefined) {
      for (const a of argv.slice(1)) {
        const asg = typeof a === 'string' ? ENV_ASSIGNMENT.exec(a) : null;
        if (asg !== null) loadingVar(asg[1], asg[2], off);
      }
    } else {
      for (const k of Object.keys(r.env)) loadingVar(k, r.env[k], off);
    }
  }
  if (r.script !== undefined) {
    if (Array.isArray(scripts)) scripts.push({ name: r.name, text: r.script, exact: exactScript(r.name, argv, r.script) });
    return null;
  }
  return {
    argv: r.inner,
    env: r.env,
    external: r.external,
    // a `time` that is not the bare keyword: a cd through it is a program, or a command named `-p`
    timeProgram: r.name === 'time' && r.external,
    chdirs: r.chdirs,
    reads: r.reads,
    writes: r.writes,
  };
}

// Is the script the whole story of the layer? `env -S TEXT` must be exactly that (other env flags,
// such as -C or -u, or words after TEXT change what runs); flock's TEXT must be its last word
// (nothing is appended); watch joins all its words.
function exactScript(name, argv, text) {
  if (typeof text !== 'string') return false;
  const last = argv[argv.length - 1];
  if (name === 'env') {
    if (argv.length === 2) return last === `-S${text}` || last === `--split-string=${text}`;
    return argv.length === 3 && (argv[1] === '-S' || argv[1] === '--split-string') && last === text;
  }
  if (name === 'flock') return last === text || last === `-c${text}` || last === `--command=${text}`;
  return true;
}

// The command's first word is a bare unquoted literal (no quote, backslash, expansion) with no
// assignment before it: what the shell needs to see to read `time` as its reserved word.
function bareHead(node) {
  if (!node || !Array.isArray(node.words) || node.words.length === 0) return false;
  if (Array.isArray(node.assigns) && node.assigns.length > 0) return false;
  const ps = node.words[0].parts;
  return Array.isArray(ps) && ps.length === 1 && ps[0].type === 'lit' && ps[0].quoted === false;
}

/**
 * Steps that unwrap a command BEFORE cd/git/ops/taint dispatch. Each is
 * step({argv, env, node, first, scripts}, sh, g) -> null (not mine) | {argv, env?, external?, chdirs?, reads?, writes?}:
 * the inner command, assignments it adds to the command's environment, whether it runs as a new
 * process, directories it is moved to, and paths the wrapper's own flags read or write (words,
 * relative to where the wrapper runs). Steps are retried from the first after every unwrap, up to
 * MAX_UNWRAP layers (past it: opaque). sh and g are null in the loop scan.
 */
export const PRE_STEPS = [wrapperStep];

// Run fn with the shell's cwd temporarily set to cwd (undefined: unchanged).
function withCwd(sh, cwd, fn) {
  if (cwd === undefined) return fn();
  const saved = sh.cwd;
  sh.cwd = cwd;
  try {
    return fn();
  } finally {
    sh.cwd = saved;
  }
}

// A word resolved from the shell's current cwd, UNKNOWN when it names a path an earlier mv/ln touched.
function pathAt(sh, g, w) {
  const p = resolveIn(sh, g, w);
  return taintedWord(sh, g, w, p) ? UNKNOWN : p;
}

// {argv, env, layers, external, cwd, reads, writes, execs}: cwd is undefined unless a wrapper moved
// the command (then a realpath or UNKNOWN); reads/writes are the wrappers' own resolved paths;
// execs are find's -exec clauses; scripts are wrapper script layers ({name, text, exact}, see
// wrapperStep). depth counts layers already stripped around this command.
function unwrap(argv, env, node, sh, g, depth = 0) {
  let cur = { argv, env };
  const layers = [];
  const scripts = [];
  const reads = [];
  const writes = [];
  let external = false;
  let timeProgram = false;
  let cwd;
  for (;;) {
    let next = null;
    for (const step of PRE_STEPS) {
      // first: the command as the shell sees it (a leading `time` is the reserved word)
      next = step({ argv: cur.argv, env: cur.env, node, first: layers.length === 0 && depth === 0, scripts }, sh, g);
      if (next) break;
    }
    if (!next) break;
    if (layers.length + depth >= MAX_UNWRAP) throw new Opaque('depth', 'unwrap', node.off);
    if (!Array.isArray(next.argv) || typeof next.argv[0] !== 'string') throw new Opaque('unknown', 'command-word', node.off);
    layers.push(cur.argv);
    if (next.external) external = true;
    if (next.timeProgram) timeProgram = true;
    if (sh && g) {
      withCwd(sh, cwd, () => {
        for (const w of next.reads || []) reads.push(pathAt(sh, g, w));
        for (const w of next.writes || []) writes.push(pathAt(sh, g, w));
      });
      for (const d of next.chdirs || []) {
        const p = withCwd(sh, cwd, () => pathAt(sh, g, d));
        cwd = isAbs(p) ? p : UNKNOWN;
      }
    }
    let merged = cur.env;
    if (next.env && typeof next.env === 'object') {
      merged = {};
      for (const src of [cur.env, next.env]) {
        for (const k of Object.keys(src)) Object.defineProperty(merged, k, { value: src[k], enumerable: true, writable: true, configurable: true });
      }
    }
    cur = { argv: next.argv, env: merged };
  }
  const f = findExecs(cur.argv);
  if (f && f.opaque) throw new Opaque(f.opaque.reason, f.opaque.construct, node.off);
  return { ...cur, layers, external, timeProgram, cwd, reads, writes, execs: f ? f.execs : [], scripts };
}

function predecessorOk(argv) {
  if (argv.length === 0) return true; // redirections only: they cannot remove or lock a directory
  const prog = programName(argv[0]);
  for (const e of CERTAIN_CD_PREDECESSORS) {
    if (e.program !== prog) continue;
    if (e.subcommands) {
      const o = gitOptions(argv);
      if (o === null || o.sub === null || !e.subcommands.includes(o.sub)) continue;
      if (e.test && !e.test(argv, o.sub, argv.slice(o.subIndex + 1))) continue;
    } else if (e.test && !e.test(argv)) continue;
    return true;
  }
  return false;
}

function finish(eff, info, sh, g) {
  for (const step of FINISH_STEPS) step(eff, info, sh, g);
  g.commands.push(eff);
  if (!predecessorOk(eff.argv)) g.allSafe = false;
  nestedCommands(eff, info, sh, g);
}

// ---------------------------------------------------------------------------------------------
// Nested shells, eval, feeds and wrapper scripts (unwrap.mjs decides what to re-parse; reparse
// walks it). The parent command is already in g.commands; the nested commands follow it, with
// their own classes. Nesting is counted in g.nest across every kind of re-parse.

// info.feed: what the command's stdin holds when info.stdin (walkSimple computes it for simple
// commands; anything else fed is not literal).
function nestedCommands(eff, info, sh, g) {
  const off = info.off || 0;
  const fed = info.stdin === true;
  const r = unwrapNested(eff, g.nest, {
    fed,
    feed: fed && info.feed !== undefined ? info.feed : null,
    kind: sh.kind,
    scripts: info.scripts || [],
    reset: resetsEnv(info.unwrapped),
    reparse: (text, depth, child) => reparse(text, depth, { ...child, cwd: eff.cwd, env: eff.env, sh, g, off }),
  });
  if (!Array.isArray(r)) throw new Opaque(r.opaque.reason, r.opaque.construct, off);
}

/**
 * Parse text as shell code and walk it as a child of the current shell; its effective commands are
 * appended to g.commands and returned, or {opaque} (offset: the parent command's). child = {kind,
 * subshell, stdin, reset, cwd, env, sh, g, off}: a subshell (bash -c, a fed shell, a wrapper
 * script) keeps its cd, pushd stack and variables to itself and sees only exported values plus the
 * command's prefix assignments (none at all after sudo/doas/env: `reset`); eval (not a subshell)
 * sees the shell as it is. The file system state (repositories, branches, mv/ln taint) is shared;
 * branch changes inside are uncertain afterwards (the nested code may stop early). The text counts
 * against the 32 KiB parser cap per level and MAX_REPARSE_BYTES per call.
 */
function reparse(text, depth, child) {
  const { sh, g, off } = child;
  const fail = (reason, construct) => ({ opaque: { reason, construct, offset: off } });
  if (typeof text !== 'string') return fail('unknown', 'nested-script');
  // text parsed after an alias was defined may expand it (eval reads aliases; so do shells that source rc files)
  if (g.aliases.all || g.aliases.names.size > 0) return fail('unsupported', 'alias');
  if (!Number.isInteger(depth) || depth > MAX_REPARSE_DEPTH) return fail('depth', 'nested-shell');
  g.reparseBytes += text.length;
  if (g.reparseBytes > MAX_REPARSE_BYTES) return fail('size', 'nested-shell');
  const tree = parseShell(text);
  if (!tree || Object.hasOwn(tree, 'opaque')) {
    const o = tree && tree.opaque ? tree.opaque : { reason: 'internal', construct: 'parse' };
    return fail(o.reason, o.construct);
  }
  const start = g.commands.length;
  const savedNest = g.nest;
  g.nest = depth;
  try {
    const r = inSubshell(sh, g, () => {
      enterChild(sh, g, child);
      return walk(tree, sh, g);
    });
    forgetGlobals(sh, g, r.touched);
  } catch (e) {
    if (e instanceof Opaque) return fail(e.opaque.reason, e.opaque.construct);
    throw e;
  } finally {
    g.nest = savedNest;
  }
  return g.commands.slice(start);
}

// The child's starting state, inside the scope reparse opened (undone afterwards).
function enterChild(sh, g, child) {
  sh.cwd = isAbs(child.cwd) ? child.cwd : UNKNOWN;
  sh.stdin = child.stdin === true;
  sh.stdinPersist = false;
  sh.feed = null;
  sh.lastRisk = null;
  sh.kind = child.kind === 'bash' ? 'bash' : 'zsh';
  if (!child.subshell) return;
  sh.dirs = [];
  if (child.reset) {
    sh.env.poison();
    return;
  }
  // a new shell process inherits only the environment: exported names and the host's own
  for (const name of [...sh.env.vars.keys()]) {
    if (!sh.exported.has(name) && !Object.hasOwn(g.hostEnv, name)) sh.env.set(name, UNKNOWN);
  }
  sh.env.forget('PWD'); // the child's PWD is its cwd
  sh.env.set('OLDPWD', UNKNOWN);
  const env = child.env !== null && typeof child.env === 'object' ? child.env : {};
  for (const k of Object.keys(env)) sh.env.set(k, env[k]);
}

function newEff(argv, env, sh, g) {
  return {
    argv,
    cwd: sh.cwd,
    env,
    classes: [],
    reads: [],
    writes: [],
    ops: [],
    domains: [],
    repo: withBranch(cwdRepo(sh, g), g),
  };
}

// ---------------------------------------------------------------------------------------------
// The walk. Every walk function returns U (see the header).

function vctxOf(sh, g) {
  return { home: g.home, cwd: sh.cwd, expandGlob: sh.kind === 'zsh' ? g.expandGlob : g.expandGlobBash };
}

function walkParts(parts, sh, g) {
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'cmdsub') {
      // the substitution may fail: what it did to the repository is uncertain afterwards
      const r = inSubshell(sh, g, (c) => walk(p.program, c, g));
      forgetGlobals(sh, g, r.touched);
    } else if (p.type === 'var') {
      // `${NAME:=v}` and `${NAME=v}` assign
      if (p.op === '=' || p.op === ':=') loadingVar(p.name, (p.arg && literalText(p.arg)) ?? UNKNOWN, g.off || 0);
      if (p.arg && Array.isArray(p.arg.parts)) walkParts(p.arg.parts, sh, g);
    } else if (p.type === 'arith') {
      arithAssigns(p.text, g.off || 0);
    }
  }
}

function walkWord(word, sh, g) {
  if (word && Array.isArray(word.parts)) walkParts(word.parts, sh, g);
}

function walkRedirSubs(r, sh, g) {
  if (r.target) walkWord(r.target, sh, g);
  if (Array.isArray(r.parts)) walkParts(r.parts, sh, g);
}

function noteExports(argv, sh) {
  const cmd = argv[0];
  const x = cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && argv.some((a) => typeof a === 'string' && /^-[A-Za-z]*x/.test(a)));
  if (!x) return;
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string' || a.startsWith('-') || a.startsWith('+')) continue;
    const name = a.split('=')[0];
    if (isName(name)) sh.exportName(name);
  }
}

// Aliases defined earlier in the same call. `alias NAME=…` is remembered by name (-g and -s forms,
// and names that are not literal, make every later command suspect); `unalias` forgets exact names.
// A later command whose first word is a defined name is opaque, and so is any re-parsed text.
function aliasStep(argv, inner, g, off) {
  const al = g.aliases;
  const prog = inner.argv[0];
  const isDef = prog === 'alias' || prog === 'unalias';
  if (!isDef) {
    const heads = [argv[0], ...inner.layers.map((l) => l[0]), prog];
    if (al.all || heads.some((h) => typeof h === 'string' && al.names.has(h))) throw new Opaque('unsupported', 'alias', off);
    return;
  }
  const args = inner.argv.slice(1);
  if (prog === 'unalias') {
    for (const a of args) {
      if (a === '-a') al.names.clear();
      else if (typeof a === 'string' && !a.startsWith('-')) al.names.delete(a);
    }
    return;
  }
  for (const a of args) {
    if (typeof a !== 'string') al.all = true;
    else if (a.startsWith('-')) {
      if (/[gs]/.test(a)) al.all = true;
    } else if (a.includes('=')) al.names.add(a.slice(0, a.indexOf('=')));
  }
}

function walkSimple(node, sh, g) {
  sh.lastRisk = null;
  // command substitutions run during expansion, each in a subshell
  for (const a of node.assigns) walkWord(a.value, sh, g);
  for (const w of node.words) walkWord(w, sh, g);
  for (const r of node.redirs) walkRedirSubs(r, sh, g);
  const vctx = vctxOf(sh, g);
  // Values are read in an undone scope when expansion has side effects (`${X:=v}`, arithmetic):
  // applySimple expands again on the real env and applies them exactly once.
  const env = sh.env;
  const reading = nodeHasSideEffects(node) ? (fn) => env.scoped(fn) : (fn) => fn();
  const stdin = sh.stdin || sh.stdinPersist || feedsStdin(node.redirs);

  if (node.words.length === 0) {
    // a listed variable may be exported later (`set -a`), so a plain assignment counts
    for (const a of node.assigns) loadingVar(a.name, reading(() => resolveWord(a.value, env, vctx)), node.off);
    // assignments and/or redirections only (zsh runs a redirect-only command; its effects count)
    const targets = reading(() => node.redirs.map((r) => (r.target ? resolveWord(r.target, env, vctx) : null)));
    applySimple(node, sh.env, vctx);
    applyHeredocs(node.redirs, sh, vctx);
    if (node.redirs.length > 0) {
      const eff = newEff([], {}, sh, g);
      redirEffects(node.redirs, targets, eff, sh, g);
      finish(eff, { node, off: node.off, stdin, unwrapped: [] }, sh, g);
      for (const w of eff.writes) noteDotGit(w, g);
    }
    return EMPTY;
  }

  const w0 = node.words[0];
  if (hasGlob(w0)) throw new Opaque('unsupported', 'glob-command', node.off);
  if (splitsOnWhitespace(w0, env, vctx)) throw new Opaque('unknown', 'command-word', node.off);
  const argv = [];
  const prefix = {};
  const heredocs = [];
  const literalGlobs = noglobPrefix(node);
  const targets = reading(() => {
    for (let i = 0; i < node.words.length; i++) {
      const w = node.words[i];
      // under zsh's noglob the pattern is a literal word fence does not resolve: UNKNOWN
      if (i > 0 && hasGlob(w) && literalGlobs) argv.push(UNKNOWN);
      else if (i > 0 && hasGlob(w)) {
        const vals = forValues({ type: 'for', var: '_', items: [w], body: null }, env, vctx);
        if (Array.isArray(vals)) argv.push(...vals);
        else argv.push(UNKNOWN);
      } else {
        argv.push(longLiteral(resolveWord(w, env, vctx), w));
      }
    }
    // words are expanded first, then redirections, then assignment values
    const ts = node.redirs.map((r) => (r.target ? resolveWord(r.target, env, vctx) : null));
    // heredoc bodies as the command reads them (a nested shell may run them)
    for (const r of node.redirs) heredocs.push(r.op === '<<' || r.op === '<<-' ? heredocText(r, env, vctx) : null);
    for (const a of node.assigns) {
      const value = resolveWord(a.value, env, vctx);
      loadingVar(a.name, value, node.off);
      Object.defineProperty(prefix, a.name, { value, enumerable: true, writable: true, configurable: true });
    }
    return ts;
  });
  const cdpath = cdpathMaybeSet(sh, g);
  applySimple(node, sh.env, vctx);
  applyHeredocs(node.redirs, sh, vctx);
  noteExports(argv, sh);
  applyTaint(argv, sh, g);
  if (typeof argv[0] !== 'string') throw new Opaque('unknown', 'command-word', node.off);
  const persistStdin = node.words.length === 1 && argv[0] === 'exec' && feedsStdin(node.redirs);

  // wrappers are stripped before the dispatch, so cd/git/ops/taint see the real command
  const inner = unwrap(argv, prefix, node, sh, g);
  declaredVars(inner.argv, leadsFor(argv, inner.argv, node.words.length === argv.length ? node.words.map(leadOf) : null), node.off, sh.kind);
  aliasStep(argv, inner, g, node.off);
  const cmdArgv = inner.argv;
  const eff = newEff(cmdArgv, inner.env, sh, g);
  // redirections are opened by the shell, in its own cwd
  redirEffects(node.redirs, targets, eff, sh, g);
  pushAll(eff.reads, inner.reads);
  pushAll(eff.writes, inner.writes);
  let post = null;
  const cmd = cmdArgv[0];
  const kind0 = commandKind(cmdArgv);
  // a cd run as a new process (env cd, nice cd) cannot move this shell; through a `time` that is not
  // the bare keyword (`/usr/bin/time`, `gtime`, `\time`, `'time'`, `X=1 time`, `time -p` in zsh)
  // which of the two happened is not decided here: the cwd and the pushd stack become UNKNOWN
  const kind = kind0 === 'cd' && inner.external ? null : kind0;
  if (kind0 === 'cd' && inner.external && inner.timeProgram) post = () => cwdUnknown(sh);
  withCwd(sh, inner.cwd, () => {
    // env -C / sudo -D: the command runs, and its words resolve, in the wrapper's directory
    if (inner.cwd !== undefined) {
      eff.cwd = sh.cwd;
      eff.repo = withBranch(cwdRepo(sh, g), g);
    }
    if (kind === 'cd') post = cdEffect(node, cmd, cmdArgv, eff, sh, g, cdpath);
    else if (kind === 'git') post = gitEffect(node, cmdArgv, inner.env, eff, sh, g);
    else if (kind === 'opaque-run') post = () => opaqueRun(sh, g);
    const opsRaw = opsOf(cmdArgv);
    eff.ops = opsRaw.map((o) => ({ path: resolveIn(sh, g, o.path), op: o.op }));
    const feed = stdin ? feedOf(node, sh, targets, heredocs) : undefined;
    finish(eff, { node, off: node.off, stdin, unwrapped: inner.layers, feed, scripts: inner.scripts }, sh, g);
    afterCommand(eff, opsRaw, sh, g);
    runExecs(inner, node, sh, g, stdin, inner.layers.length + 1);
  });
  if (persistStdin) sh.stdinPersist = true;
  return post ? post() : EMPTY;
}

// A literal word longer than values.mjs tracks (MAX_VALUE) is still exactly its text (a long
// `bash -c '…'` script): keep it instead of UNKNOWN.
function longLiteral(v, w) {
  if (!isUnknown(v)) return v;
  const lit = literalValue(w);
  return lit !== null && lit.length > MAX_VALUE ? lit : v;
}

// A heredoc body as the command reads it: literal, expanded through tracked values, or UNKNOWN.
function heredocText(r, env, vctx) {
  const lit = heredocLiteral(r);
  if (lit !== null) return lit;
  return resolveWord({ parts: r.parts }, env, vctx);
}

const HEREDOC_DYNAMIC = { reason: 'unknown', construct: 'heredoc-dynamic' };

// What a fed command's stdin holds (unwrap.mjs ctx.feed): the pipe's text when this node is the
// pipeline member the pipe feeds, overridden by the node's own stdin redirections in order (a
// literal heredoc/herestring is its text, an UNKNOWN one `heredoc-dynamic`, a file null).
function feedOf(node, sh, targets, heredocs) {
  let feed = null;
  if (!sh.stdinPersist && sh.stdin && sh.feed && sh.feed.node === node) feed = sh.feed.text;
  node.redirs.forEach((r, i) => {
    if (!(r.fd === undefined || r.fd === 0) || !STDIN_REDIRS.has(r.op)) return;
    if (r.op === '<<' || r.op === '<<-') feed = typeof heredocs[i] === 'string' ? heredocs[i] : HEREDOC_DYNAMIC;
    else if (r.op === '<<<') {
      const v = r.target ? longLiteral(targets[i], r.target) : UNKNOWN;
      feed = typeof v === 'string' ? `${v}\n` : HEREDOC_DYNAMIC;
    } else feed = null;
  });
  return feed;
}

function cwdUnknown(sh) {
  sh.cwd = UNKNOWN;
  touch(sh, CWD);
  sh.dirs = UNKNOWN;
  touch(sh, DIRS);
  return EMPTY;
}

// What a finished command does to later ones: moved/linked paths taint, removed paths, `.git`
// directories created.
function afterCommand(eff, opsRaw, sh, g) {
  opsRaw.forEach((o, i) => {
    if (o.op === 'move' || o.op === 'link') addTaint(sh, g, o.path, eff.ops[i].path);
    if (o.op === 'move' || o.op === 'delete') {
      const r = eff.ops[i].path;
      if (isAbs(r)) g.removed.trie.add(r);
      else g.removed.all = true;
    }
  });
  if (programName(eff.argv[0]) === 'mkdir') for (const w of eff.argv.slice(1)) noteDotGit(typeof w === 'string' ? resolveIn(sh, g, w) : UNKNOWN, g);
  for (const w of eff.writes) noteDotGit(w, g);
}

// find -exec/-execdir/-ok/-okdir clauses: each is an effective command of its own, run as a new
// process in find's directory (-execdir/-okdir: the matched file's, UNKNOWN), under the wrappers
// around find. A clause's own wrappers are stripped, nesting counted. A shell given -c code in a
// clause is re-parsed like any nested shell (a `{}` in the code makes it UNKNOWN: opaque). A clause
// that runs git may change any branch.
function runExecs(parent, node, sh, g, stdin, depth) {
  for (const ex of parent.execs) {
    withCwd(sh, ex.dir === 'unknown' ? UNKNOWN : undefined, () => {
      const sub = unwrap(ex.argv, parent.env, node, sh, g, depth);
      declaredVars(sub.argv, null, node.off, sh.kind);
      withCwd(sh, sub.cwd, () => {
        const eff = newEff(sub.argv, sub.env, sh, g);
        pushAll(eff.reads, sub.reads);
        pushAll(eff.writes, sub.writes);
        const opsRaw = opsOf(sub.argv);
        eff.ops = opsRaw.map((o) => ({ path: resolveIn(sh, g, o.path), op: o.op }));
        // a clause's stdin is find's: never a literal feed
        finish(eff, { node, off: node.off, stdin, unwrapped: [...parent.layers, ...sub.layers], scripts: sub.scripts }, sh, g);
        afterCommand(eff, opsRaw, sh, g);
        if (commandKind(sub.argv) === 'git') setBranch(sh, g, UNKNOWN, UNKNOWN);
        runExecs({ ...sub, layers: [...parent.layers, ...sub.layers] }, node, sh, g, stdin, depth + sub.layers.length + 1);
      });
    });
  }
}

// zsh `noglob cmd …` (possibly after nocorrect): glob characters in the words stay literal.
function noglobPrefix(node) {
  for (const w of node.words) {
    const v = literalValue(w);
    if (v === 'noglob') return true;
    if (v !== 'nocorrect') return false;
  }
  return false;
}

// eval, source and `.` run code that may change the shell in ways not tracked (eval's text is
// re-parsed, but on a copy of the state): the cwd, the pushd stack, every branch and the set of
// repositories are unknown afterwards.
function opaqueRun(sh, g) {
  sh.cwd = UNKNOWN;
  touch(sh, CWD);
  sh.dirs = UNKNOWN;
  touch(sh, DIRS);
  setBranch(sh, g, UNKNOWN, UNKNOWN);
  createdUnknown(g);
  return EMPTY;
}

// An unquoted heredoc body is expanded by the shell: `${Y:=v}` in it assigns.
function applyHeredocs(redirs, sh, vctx) {
  for (const r of redirs) {
    if ((r.op === '<<' || r.op === '<<-') && Array.isArray(r.parts) && partsHaveSideEffects(r.parts)) {
      resolveWord({ parts: r.parts }, sh.env, vctx);
    }
  }
}

// Redirections on a compound command: their effects (as a command with no argv), and stdin.
function withRedirs(node, sh, g, body) {
  const redirs = node.redirs || [];
  if (redirs.length === 0) return body();
  for (const r of redirs) walkRedirSubs(r, sh, g);
  const vctx = vctxOf(sh, g);
  const targets = redirs.map((r) => (r.target ? resolveWord(r.target, sh.env, vctx) : null));
  applyHeredocs(redirs, sh, vctx);
  const eff = newEff([], {}, sh, g);
  redirEffects(redirs, targets, eff, sh, g);
  finish(eff, { node, off: 0, stdin: sh.stdin || sh.stdinPersist, unwrapped: [] }, sh, g);
  for (const w of eff.writes) noteDotGit(w, g);
  const saved = sh.stdin;
  if (feedsStdin(redirs)) sh.stdin = true;
  try {
    return body();
  } finally {
    sh.stdin = saved;
  }
}

function walkList(node, sh, g) {
  let u = EMPTY;
  const items = node.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.async) {
      // a background job: a subshell that changes the repository at an unknown time
      const r = inSubshell(sh, g, (c) => walk(it.node, c, g));
      forgetGlobals(sh, g, r.touched);
      u = EMPTY;
      continue;
    }
    u = walk(it.node, sh, g);
    if (i < items.length - 1) {
      // the next command runs whether this one succeeded or not
      forget(sh, g, u);
      u = EMPTY;
    }
  }
  return u;
}

function walkAnd(node, sh, g) {
  const uL = walk(node.left, sh, g);
  // R runs only after L succeeded: in L's success state
  const [tR, uR] = region(sh, () => walk(node.right, sh, g));
  // on failure, L's own uncertainty, everything R would have done, or R's failure
  return union(uL, tR, uR);
}

function walkOr(node, sh, g) {
  const uL = walk(node.left, sh, g);
  const risk = riskOf(sh, node.left);
  const savedBranches = new Map(g.branches);
  const savedAll = g.branchesAll;
  // R runs only after L failed: in L's failure view, undone afterwards
  const { touched: tR, u: uR } = scoped(sh, () => {
    if (risk) {
      risk.fail(sh, g);
      forget(sh, g, uL, risk.keys);
    } else {
      forget(sh, g, uL);
    }
    return walk(node.right, sh, g);
  }, true);
  if (alwaysExits(node.right)) {
    // only L's success continues, and sh holds exactly that
    g.branches = savedBranches;
    g.branchesAll = savedAll;
    return EMPTY;
  }
  for (const k of tR) if (isGlobalKey(k)) touch(sh, k);
  // either L's success or R's end: what differs between them is UNKNOWN
  forget(sh, g, union(tR, uL));
  return uR;
}

function walkPipeline(node, sh, g) {
  const n = node.commands.length;
  if (n === 1) {
    // `! cmd`: success and failure swap, so nothing about the outcome is assumed
    const [t] = region(sh, () => walk(node.commands[0], sh, g));
    forget(sh, g, t);
    return EMPTY;
  }
  // what each member reads from the pipe: literal echo/printf/cat/decoder output, or null
  const feeds = pipeFeeds(node.commands, node.ops);
  for (let i = 0; i < n; i++) {
    const r = inSubshell(
      sh,
      g,
      () => {
        if (i > 0) {
          sh.stdin = true;
          sh.feed = { node: node.commands[i], text: feeds[i] === undefined ? null : feeds[i] };
        }
        return walk(node.commands[i], sh, g);
      },
      i === n - 1,
    );
    // zsh runs the last member in the current shell (bash does not): its changes are UNKNOWN
    if (i === n - 1) forget(sh, g, r.touched);
    else forgetGlobals(sh, g, r.touched);
  }
  return EMPTY;
}

// Run fn as a branch that may or may not run: undone afterwards; returns what it touched.
function inBranch(sh, g, fn) {
  return inSubshell(sh, g, fn, true).touched;
}

function walkIf(node, sh, g) {
  const pending = [];
  for (const cl of node.clauses) {
    const [tC, uC] = region(sh, () => walk(cl.cond, sh, g));
    pending.push(tC);
    const risk = riskOf(sh, cl.cond);
    pending.push(inBranch(sh, g, (c) => walk(cl.body, c, g)));
    // the next clause and the else run only after this condition failed
    if (risk) {
      risk.fail(sh, g);
      forget(sh, g, uC, risk.keys);
    } else {
      forget(sh, g, uC);
    }
  }
  if (node.else) pending.push(inBranch(sh, g, (c) => walk(node.else, c, g)));
  for (const t of pending) forget(sh, g, t);
  return EMPTY;
}

function walkCase(node, sh, g) {
  walkWord(node.word, sh, g);
  resolveWord(node.word, sh.env, vctxOf(sh, g));
  const pending = [];
  let prev = null;
  for (const arm of node.arms) {
    for (const p of arm.patterns) {
      walkWord(p, sh, g);
      // patterns are expanded only until one matches
      pending.push(region(sh, () => resolveWord(p, sh.env, vctxOf(sh, g)))[0]);
    }
    const fallsThrough = arm.term === ';&' || arm.term === ';;&';
    if (arm.body) {
      const before = prev;
      const t = inBranch(sh, g, (c) => {
        // after `;&` the previous arm's body ran first
        if (before) forget(c, g, before);
        walk(arm.body, c, g);
      });
      pending.push(t);
      prev = fallsThrough ? t : null;
    } else if (!fallsThrough) {
      prev = null;
    }
  }
  for (const t of pending) forget(sh, g, t);
  return EMPTY;
}

function walkFor(node, sh, g) {
  loadingVar(node.var, UNKNOWN, g.off || 0); // the loop variable is assigned each round
  for (const w of node.items || []) walkWord(w, sh, g);
  const values = node.items === null ? UNKNOWN : forValues(node, sh.env, vctxOf(sh, g));
  if (Array.isArray(values) && values.length === 0) return EMPTY;
  const scan = assignedIn(node.body);
  const T = new Set(scan);
  T.add(node.var);
  // nested unrolled loops multiply: the budget counts every enclosing unrolled loop
  const unroll = Array.isArray(values) && g.unroll * values.length * sizeOf(node.body) <= UNROLL_BUDGET;
  const iterations = unroll ? values : [UNKNOWN];
  const outer = g.unroll;
  g.unroll *= iterations.length;
  let t;
  try {
    [t] = region(sh, () => {
      for (const v of iterations) {
        // an earlier iteration may have assigned these, or stopped before assigning them
        forget(sh, g, T);
        sh.env.set(node.var, v);
        walk(node.body, sh, g);
      }
    });
  } finally {
    g.unroll = outer;
  }
  forget(sh, g, union(T, t));
  const keep = unroll && !scan.has(node.var) && !scan.has(BREAK) && !scan.has(POISON);
  sh.env.set(node.var, keep ? values[values.length - 1] : UNKNOWN);
  return EMPTY;
}

function walkWhile(node, sh, g) {
  const T = union(assignedIn(node.cond), assignedIn(node.body));
  const [t] = region(sh, () => {
    forget(sh, g, T);
    const uC = walk(node.cond, sh, g);
    // `until` runs the body after the condition failed
    if (node.until) forget(sh, g, uC);
    walk(node.body, sh, g);
  });
  forget(sh, g, union(T, t));
  return EMPTY;
}

function walk(node, sh, g) {
  if (node && typeof node.off === 'number') g.off = node.off;
  if (++g.steps > MAX_STEPS) throw new Opaque('size', 'walk', node && node.off ? node.off : 0);
  switch (node.type) {
    case 'simple':
      return walkSimple(node, sh, g);
    case 'list':
      return walkList(node, sh, g);
    case 'and':
      return walkAnd(node, sh, g);
    case 'or':
      return walkOr(node, sh, g);
    case 'pipeline':
      return walkPipeline(node, sh, g);
    case 'subshell':
      return withRedirs(node, sh, g, () => {
        const r = inSubshell(sh, g, (c) => walk(node.body, c, g));
        // only the repository is shared with the parent
        return new Set([...r.u].filter(isGlobalKey));
      });
    case 'group':
      return withRedirs(node, sh, g, () => walk(node.body, sh, g));
    case 'if':
      return withRedirs(node, sh, g, () => walkIf(node, sh, g));
    case 'for':
      return withRedirs(node, sh, g, () => walkFor(node, sh, g));
    case 'while':
      return withRedirs(node, sh, g, () => walkWhile(node, sh, g));
    case 'case':
      return withRedirs(node, sh, g, () => walkCase(node, sh, g));
    default:
      throw new Opaque('internal', String(node.type), 0);
  }
}

// ---------------------------------------------------------------------------------------------

function globWithBudget(expand, fsImpl, g) {
  return (pattern, cwd) => {
    if (g.globMs > GLOB_BUDGET_MS) return UNKNOWN;
    const t0 = performance.now();
    try {
      return expand === null ? defaultExpandGlob(pattern, cwd, { fs: fsImpl }) : expand(pattern, cwd);
    } finally {
      g.globMs += performance.now() - t0;
    }
  };
}

/**
 * Normalize a shell command into effective commands, or an opaque verdict. Never throws.
 * @param {string} command
 * @param {{cwd?:string, home?:string, env?:object, fs?:object, expandGlob?:Function, isProtected?:Function}} ctx
 * @returns {{commands: object[]} | {opaque: {reason:string, construct:string, offset:number}}}
 */
export function normalize(command, ctx) {
  try {
    const c = ctx !== null && typeof ctx === 'object' ? ctx : {};
    const tree = parseShell(command);
    if (!tree || Object.hasOwn(tree, 'opaque')) return { opaque: tree ? tree.opaque : { reason: 'internal', construct: 'parse', offset: 0 } };
    const fsImpl = c.fs || nodeFs;
    const g = {
      fs: fsImpl,
      home: isAbs(c.home) ? c.home : undefined,
      hostEnv: c.env !== null && typeof c.env === 'object' ? c.env : {},
      expandGlob: null,
      globMs: 0,
      commands: [],
      taint: new PathTrie(),
      taintAll: false,
      // every command so far is on CERTAIN_CD_PREDECESSORS
      allSafe: true,
      created: { any: false, all: false, roots: new PathTrie() },
      branches: new Map(),
      branchesAll: false,
      steps: 0,
      unroll: 1,
      repoCache: new Map(),
      existsCache: new Map(),
      realCache: new Map(),
      resolveCache: new Map(),
      protectedCache: new Map(),
      isProtected: typeof c.isProtected === 'function' ? c.isProtected : null,
      // nesting level of the code being walked (nested shells, eval, feeds), and text re-parsed so far
      nest: 0,
      reparseBytes: 0,
      // aliases defined earlier in this call: a later command word or re-parsed text may expand one
      aliases: { names: new Set(), all: false },
      removed: { all: false, trie: new PathTrie() },
      // T18 capabilities: paths the agent wrote earlier in the session, a file reader, the bounded
      // git tree check and the patch reader (defaults: the real ones; the git check needs a pinned
      // git path and version, so unbound it answers UNKNOWN)
      written: writtenSet(c.writtenIndex),
      readFile: typeof c.readFile === 'function' ? c.readFile : null,
      gitTreeDiff: typeof c.gitTreeDiff === 'function' ? c.gitTreeDiff : (repo, target, subpaths) => defaultGitTreeDiff(repo, target, subpaths, {}),
      patchTargets: typeof c.patchTargets === 'function' ? c.patchTargets : defaultPatchTargets,
      // the repoOf() result each git command works on (eff.repo drops the gitdir)
      gitRepos: new WeakMap(),
      // bulk-writer source scans, per source directory
      bulkScans: new Map(),
    };
    g.expandGlob = globWithBudget(typeof c.expandGlob === 'function' ? c.expandGlob : null, fsImpl, g);
    // bash without globstar reads `**` as `*`: inside sh/bash/dash/ksh text such a glob is UNKNOWN
    g.expandGlobBash = (pattern, cwd) => (bashGlobUnknown(pattern) ? UNKNOWN : g.expandGlob(pattern, cwd));
    const env = new TrackedEnv();
    env.touched = new Set();
    const sh = new Shell(env, isAbs(c.cwd) ? c.cwd : UNKNOWN);
    walk(tree, sh, g);
    return { commands: g.commands };
  } catch (e) {
    if (e instanceof Opaque) return { opaque: e.opaque };
    return { opaque: { reason: 'internal', construct: (e && e.name) || 'error', offset: 0 } };
  }
}
