// Opts the current git repo into strict progress tracking. Prints a JSON report for /progress-tracking:progress-init
// to relay.
//   init.mjs                   committed mode: progress.md and status.md at the root (created only when missing), the
//                              managed CLAUDE.md section (also in an existing AGENTS.md, never created), and
//                              progress-gate.sh (refreshed) chained into pre-commit once.
//   init.mjs --local           local mode, for shared team/client repos: everything lives under
//                              <git-common-dir>/methodology/ and nothing is written inside the working tree.
//   init.mjs --local --remove  deletes that root and removes the chained hook lines (refused, exit 1, in store mode).
// Both setup modes then register the repo in ~/.config/triqual/repos.json (lib/registry.mjs). Both are refused (exit 2,
// nothing written) in a store-mode repository: only --store applies there.
//   init.mjs --store [--accept-unparsed]
//                              store mode (spec §8 "Switching"): imports the tracking files into the local tracking
//                              store, sets `git config --local triqual.tracking store`, registers `mode: store`, installs
//                              the store pre-commit and post-commit as scripts of their own chained into the hooks,
//                              removes the local-mode lines and the progress-gate.sh chain, and rewrites the CLAUDE.md
//                              section from the store template. A committed repo's progress.md, status.md and ledgers
//                              are deleted from the working tree and the commit to make is printed: it never stages or
//                              commits. Refuses (exit 1, nothing changed) a local repo whose hooks dir is versioned
//                              (plan ruling S1), tracking changes on other branches or worktrees not imported yet, and
//                              unparsed entries without --accept-unparsed. A second run changes nothing. The mode it
//                              switched from is recorded once in `git config --local triqual.trackingFrom`.
//   init.mjs --help | -h       prints the usage and writes nothing.
// Exit codes: 0 ok (and for --help/-h), 1 not inside a git repository or a --store refusal, 2 bad arguments, the repo
// already uses the other mode, or plain/--local init in a store-mode repo.
// Also a module: it exports LOCAL_HOOK_LINES and NOT_OPTED_IN (the single source bin/tasks.mjs prints in `paths --json`)
// and `cli`, which bin/progress-init.mjs runs; importing it runs nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, chmodSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { basename, join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BRAND } from '../lib/brand.mjs';
import { writeAtomic, sha256 } from '../lib/fsx.mjs';
import { ledgerPaths, readEntry, LEDGER_EXT } from '../lib/ledger-files.mjs';
import {
  localRoot, mainWorktreeRoot, resolveTracking, readState, writeState, progressHash, storeContext,
} from '../lib/tracking.mjs';
import { registerRepo } from '../lib/registry.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const START = '<!-- progress-tracking:start';
const END = '<!-- progress-tracking:end -->';
const HOOK_MODE = 0o755;
const LOCAL_GATE = 'pre-commit.mjs';
const LOCAL_GATE_REF = `"$(git rev-parse --path-format=absolute --git-common-dir)/methodology/${LOCAL_GATE}"`;
// The lines local mode chains into <git-common-dir>/hooks, by hook name.
export const LOCAL_HOOK_LINES = Object.freeze({
  'pre-commit': `node ${LOCAL_GATE_REF} || exit 1`,
  'post-commit': `node ${LOCAL_GATE_REF} --post-commit`,
});
// What `triqual tasks` prints for a repo that is not opted in.
export const NOT_OPTED_IN = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const tpl = (f) => readFileSync(join(TEMPLATES, f), 'utf8');
// The store-mode marker (`git config --local`), and the mode a store repository was switched from.
const STORE_MARKER = `${BRAND.cli}.tracking`;
const ORIGIN_KEY = `${BRAND.cli}.trackingFrom`;
const ORIGINS = new Set(['committed', 'local', 'none']);

class InitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// `text` with the managed section replaced by `section` (or appended): { next, result }.
function withSection(text, section) {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s !== -1 && e > s) return { next: text.slice(0, s) + section.trim() + text.slice(e + END.length), result: 'updated' };
  const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { next: text + sep + section.trim() + '\n', result: text === '' ? 'created' : 'appended' };
}

function upsertSection(file, section) {
  const { next, result } = withSection(existsSync(file) ? readFileSync(file, 'utf8') : '', section);
  writeAtomic(file, next);
  return result;
}

// Where the pre-commit lives: an existing core.hooksPath (husky's ".husky/_" wrappers source ".husky/<hook>"),
// an existing unversioned .git/hooks/pre-commit, or a new versioned .githooks/.
function hookTarget(root) {
  const hooksPath = git(root, 'config', 'core.hooksPath');
  if (hooksPath) {
    const abs = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
    const dir = /(^|\/)\.husky\/_\/?$/.test(hooksPath) ? dirname(abs) : abs;
    return { dir, setHooksPath: false };
  }
  const gitHooks = join(root, git(root, 'rev-parse', '--git-path', 'hooks'));
  const existing = join(gitHooks, 'pre-commit');
  if (existsSync(existing)) return { dir: gitHooks, setHooksPath: false };
  return { dir: join(root, '.githooks'), setHooksPath: true };
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

// True when a hook whose first line is `first` runs as a shell script: no shebang (git runs it with sh), or a shebang
// naming sh, bash, dash, zsh or ksh, directly or through `/usr/bin/env` (its options skipped).
function isShellHook(first) {
  if (!first.startsWith('#!')) return true;
  const words = first.slice(2).trim().split(/\s+/);
  const base = (w) => w?.split('/').pop();
  const program = base(words[0]) === 'env' ? base(words.slice(1).find((w) => !w.startsWith('-'))) : base(words[0]);
  return SHELLS.has(program);
}

// Adds `line` to the hook `file` unless the hook already contains `marker`: right after the shebang of an existing
// hook, so a later `exec` in it cannot skip the check, or in a new `#!/bin/sh` hook. An existing hook in another
// language is left untouched ('not-shell'), with a note in `notes` asking for the line by hand.
function chainInto(file, line, marker, notes) {
  if (!existsSync(file)) {
    writeAtomic(file, `#!/bin/sh\n${line}\n`);
  } else {
    const text = readFileSync(file, 'utf8');
    if (text.includes(marker)) return 'present';
    const lines = text.split('\n');
    if (!isShellHook(lines[0])) {
      notes.push(`${realpathSync(file)} is not a shell script (${lines[0].trim()}), so it was left untouched: add this `
        + `line to it by hand, or run it from the hook: ${line}`);
      return 'not-shell';
    }
    lines.splice(lines[0].startsWith('#!') ? 1 : 0, 0, line);
    writeAtomic(file, lines.join('\n'));
  }
  chmodSync(file, HOOK_MODE);
  return 'chained';
}

// Removes every line equal to `line` from the hook `file`, keeping the rest. A hook left with nothing but the
// `#!/bin/sh` shebang (and blank lines) is deleted.
function unchain(file, line) {
  return unchainWhere(file, (l) => l === line);
}

// unchain for every line `drop` matches.
function unchainWhere(file, drop) {
  if (!existsSync(file)) return 'absent';
  const lines = readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((l) => !drop(l));
  if (kept.length === lines.length) return 'absent';
  const rest = kept.join('\n');
  if (/^#!\/bin\/sh\s*$/.test(rest)) unlinkSync(file);
  else writeAtomic(file, rest);
  return 'removed';
}

// True when `dir` holds an entry named exactly `name` (as lib/tracking.mjs decides opt-in): existsSync also finds a
// case variant (PROGRESS.md) on a case-insensitive file system.
function hasExact(dir, name) {
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

// Refuses, before anything is written, a tracking file that exists only under another case: writing it would replace
// that file's content and keep its name, so the repo would still not be opted in.
function refuseCaseVariants(root, files) {
  for (const f of files) {
    if (existsSync(join(root, f)) && !hasExact(root, f)) {
      const variant = readdirSync(root).find((n) => n.toLowerCase() === f.toLowerCase()) ?? f;
      throw new InitError(`${variant} differs from ${f} only in case: rename it to ${f} (tracking needs that exact name)`, 2);
    }
  }
}

// Creates each template file and directory missing under `root`, recording it in report.created or report.kept.
// Files are matched by exact name (callers run refuseCaseVariants first).
function scaffold(root, files, dirs, report) {
  for (const f of files) {
    if (hasExact(root, f)) report.kept.push(f);
    else { writeAtomic(join(root, f), tpl(f)); report.created.push(f); }
  }
  for (const d of dirs) {
    if (existsSync(join(root, d))) report.kept.push(`${d}/`);
    else { mkdirSync(join(root, d)); report.created.push(`${d}/`); }
  }
}

function committedInit(root) {
  const local = localRoot(root);
  if (!hasExact(root, 'progress.md') && local !== null && hasExact(local, 'progress.md')) {
    throw new InitError(`this repo already uses local mode (${local})`, 2);
  }
  refuseCaseVariants(root, ['progress.md', 'status.md']);
  const report = { root, created: [], kept: [], claudeMd: null, agentsMd: null, hook: null, notes: [] };
  scaffold(root, ['progress.md', 'status.md'], [], report);
  report.claudeMd = upsertSection(join(root, 'CLAUDE.md'), tpl('claude-section.md'));
  // The same section in the repo's own AGENTS.md, for Codex (spec Addendum F.5); an AGENTS.md is never created.
  if (hasExact(root, 'AGENTS.md')) report.agentsMd = upsertSection(join(root, 'AGENTS.md'), tpl('claude-section.md'));

  const { dir, setHooksPath } = hookTarget(root);
  mkdirSync(dir, { recursive: true });
  const gate = join(dir, 'progress-gate.sh');
  writeAtomic(gate, tpl('progress-gate.sh'));
  chmodSync(gate, HOOK_MODE);
  const rel = relative(root, dir);
  const insideGitDir = rel === '.git' || rel.startsWith('.git/');
  const gateRef = insideGitDir ? '"$(git rev-parse --git-path hooks)/progress-gate.sh"' : `"$(git rev-parse --show-toplevel)/${rel}/progress-gate.sh"`;
  const chained = chainInto(join(dir, 'pre-commit'), `sh ${gateRef} || exit 1`, 'progress-gate.sh', report.notes);
  if (setHooksPath) execFileSync('git', ['config', 'core.hooksPath', rel], { cwd: root });
  report.hook = { dir: rel, versioned: !insideGitDir, preCommit: chained, hooksPathSet: setHooksPath };

  if (insideGitDir) report.notes.push('The pre-commit is in .git/hooks (not versioned): every new clone needs to run /progress-tracking:progress-init.');
  if (setHooksPath) {
    const pkg = join(root, 'package.json');
    const hasPrepare = existsSync(pkg) && /"prepare"\s*:/.test(readFileSync(pkg, 'utf8'));
    report.notes.push(existsSync(pkg) && !hasPrepare
      ? 'core.hooksPath is local config: add "prepare": "git config core.hooksPath .githooks" to package.json so every clone enables it on npm install.'
      : 'core.hooksPath is local config: a new clone needs to run /progress-tracking:progress-init again (or `git config core.hooksPath .githooks`).');
  }
  return report;
}

function localInit(repoRoot, root) {
  if (hasExact(repoRoot, 'progress.md')) {
    throw new InitError('this repo already uses committed mode (progress.md at the root)', 2);
  }
  const report = { mode: 'local', root, created: [], kept: [], hook: null, notes: [] };
  mkdirSync(root, { recursive: true });
  refuseCaseVariants(root, ['progress.md', 'status.md']);
  scaffold(root, ['progress.md', 'status.md'], ['plans', 'specs'], report);
  // A valid state.json is kept, so rerunning init never consumes an entry not yet committed; a progress.md created
  // just now resets it, since a hash left from an older progress.md would let the next commit through ungated.
  const t = resolveTracking(repoRoot);
  if (report.created.includes('progress.md') || readState(t).lastProgressSha256 === null) writeState(t, progressHash(t));
  const gate = join(root, LOCAL_GATE);
  writeAtomic(gate, tpl('pre-commit-local.mjs'));
  chmodSync(gate, HOOK_MODE);

  const hooksPath = git(repoRoot, 'config', 'core.hooksPath');
  if (hooksPath) {
    report.notes.push(`local mode: core.hooksPath is set (${hooksPath}); no git hooks installed, so commits are not gated `
      + '— the Stop hook checks for a progress.md entry newer than the last commit');
    return report;
  }
  const hooks = join(dirname(root), 'hooks');
  mkdirSync(hooks, { recursive: true });
  const [preCommit, postCommit] = Object.entries(LOCAL_HOOK_LINES).map(([name, line]) => {
    const file = join(hooks, name);
    const result = chainInto(file, line, line, report.notes);
    if (result !== 'not-shell') chmodSync(file, HOOK_MODE);
    return result;
  });
  report.hook = { dir: hooks, preCommit, postCommit };
  return report;
}

function localRemove(root) {
  const hooks = join(dirname(root), 'hooks');
  const [preCommit, postCommit] = Object.entries(LOCAL_HOOK_LINES).map(([name, line]) => unchain(join(hooks, name), line));
  const existed = existsSync(root);
  if (existed) {
    process.stderr.write(`progress-init: deleting ${root}\n`);
    rmSync(root, { recursive: true, force: true });
  }
  return { mode: 'local', root, deleted: existed, hook: { dir: hooks, preCommit, postCommit }, notes: [] };
}

// Unknown flags and a bare --remove are refused: falling back to committed mode would write inside the working tree.
function parseFlags(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { local: { type: 'boolean' }, remove: { type: 'boolean' }, store: { type: 'boolean' }, 'accept-unparsed': { type: 'boolean' } },
      strict: true,
    }));
  } catch (err) {
    throw new InitError(err.message, 2);
  }
  if (values.store && (values.local || values.remove)) throw new InitError('--store excludes --local and --remove', 2);
  if (values['accept-unparsed'] && !values.store) throw new InitError('--accept-unparsed needs --store', 2);
  if (values.remove && !values.local) throw new InitError('--remove needs --local', 2);
  return {
    local: values.local === true, remove: values.remove === true, store: values.store === true,
    acceptUnparsed: values['accept-unparsed'] === true,
  };
}

function main(argv) {
  const { local, remove } = parseFlags(argv);
  const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
  if (!repoRoot) throw new InitError('not inside a git repository.', 1);
  // A store repository switched from local mode keeps its local files as history; --remove would only take the record
  // of its origin's files away.
  const storeMarked = git(repoRoot, 'config', '--local', '--get', STORE_MARKER) === 'store';
  if (remove && storeMarked) {
    throw new InitError(`this repository is in store mode (\`git config --local ${STORE_MARKER}\` is store): --local --remove `
      + 'does not apply to it', 1);
  }
  // Committed or local files in a store repository would bring back what the switch removed (and gate nothing).
  if (storeMarked) {
    throw new InitError(`this repository is in store mode (\`git config --local ${STORE_MARKER}\` is store): progress-init `
      + `without --store does not apply to it; run ${BRAND.cli} progress-init --store to finish or repair a switch`, 2);
  }
  if (!local) return registered(repoRoot, 'committed', committedInit(repoRoot));
  const root = localRoot(repoRoot);
  return remove ? localRemove(root) : registered(repoRoot, 'local', localInit(repoRoot, root));
}

// Records the repo in the machine registry once its files are written; registerRepo never throws or prints.
function registered(repoRoot, mode, report) {
  registerRepo(homedir(), { root: repoRoot, mode, now: new Date() });
  return report;
}

// ---- Store mode (spec §8 "Switching", plan ruling S1) ----

const STORE_SCRIPTS = Object.freeze({ 'pre-commit': 'progress-store-pre-commit.sh', 'post-commit': 'progress-store-post-commit.sh' });
const GATE_SCRIPT = 'progress-gate.sh';
// The chain line committed mode installs for progress-gate.sh, wherever its hooks dir is.
const GATE_CHAIN = /^sh ".*\/progress-gate\.sh" \|\| exit 1$/;
const MARKER_KEY = STORE_MARKER;
const LEDGER_DIR = ['docs', 'plans'];
const SWITCH_SUBJECT = 'chore(tracking): move progress tracking to the store';
const RERUN = `\`${BRAND.cli} progress-init --store\``;

// git that refuses: any failure is an InitError (exit 1) naming the command, so a check never passes on a git error.
function gitStrict(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    throw new InitError(`git ${args.join(' ')} failed: ${(err.stderr || err.message).toString().trim()}`, 1);
  }
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// True when `p` is `base` or lies under it (a child named `..hooks` included).
const within = (base, p) => {
  const rel = relative(base, p);
  return rel === '' || (!(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel));
};

// `s` in single quotes for sh (an embedded quote closed, escaped and reopened).
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
// `s` as one sh word: as it is when it holds only safe characters, else single-quoted.
const shq = (s) => (/^[\w./-]+$/.test(s) ? s : sq(s));

// The worktrees of the clone (`git worktree list --porcelain -z`): [{ worktree, HEAD, branch, bare, ... }], the main
// one first.
function worktrees(root) {
  const list = [];
  let cur = null;
  for (const field of gitStrict(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (field === '') {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const [key, value] = sp === -1 ? [field, true] : [field.slice(0, sp), field.slice(sp + 1)];
    if (key === 'worktree') {
      if (cur) list.push(cur);
      cur = { worktree: real(value) };
    } else if (cur) {
      cur[key] = value;
    }
  }
  if (cur) list.push(cur);
  return list;
}

// The effective hooks dir for the store hooks: core.hooksPath when set (hookTarget: husky's ".husky/_" means
// ".husky"), else the clone's own <git-common-dir>/hooks (`gitHooks`; never a new versioned .githooks/).
function storeHooksDir(root, gitHooks) {
  return git(root, 'config', 'core.hooksPath') ? real(hookTarget(root).dir) : gitHooks;
}

// How a hook line names `file` in the hooks dir `dir`: through git for the clone's own hooks dir (core.hooksPath unset,
// so `--git-path hooks` names it from any worktree), from the top of the working tree for a versioned dir (each
// worktree runs its own checkout's copy), else by its absolute path. Paths are single-quoted, so no `$` or backquote
// in a directory name is expanded.
function hookRef(dir, file, { root, gitHooks }) {
  if (dir === gitHooks) return `"$(git rev-parse --git-path hooks)/${file}"`;
  if (within(root, dir)) return `"$(git rev-parse --show-toplevel)"${sq(`/${relative(root, dir)}/${file}`)}`;
  return sq(join(dir, file));
}

// Writes `text` to `file` (mode 0755) unless it already holds exactly that: 'written' or 'unchanged'.
function writeIfChanged(file, text, mode = HOOK_MODE) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return 'unchanged';
  writeAtomic(file, text);
  chmodSync(file, mode);
  return 'written';
}

const storeScript = (name, lines) => `#!/bin/sh
# progress-tracking (store mode): the ${name} gate. Installed by \`${BRAND.cli} progress-init --store\`; re-running it
# updates this file. It does nothing in a checkout whose \`${MARKER_KEY}\` marker is unset.
${lines.join('\n')}
`;

// ---- Live branches: tracking changes the switch would leave behind ----

const planPathOf = (name, ledger) => (typeof ledger.plan === 'string' && ledger.plan ? ledger.plan : `${LEDGER_DIR.join('/')}/${name}.md`);

// The units the store can hold of a ledger, keyed by plan path: each task, its title, role and deps (`meta`: a
// difference there only warns), and each history event.
function addLedgerUnits(units, plan, ledger) {
  for (const task of Array.isArray(ledger?.tasks) ? ledger.tasks : []) {
    units.add(`task\0${plan}\0${task.id}`);
    units.add(`meta\0${plan}\0${task.id}\0${JSON.stringify([task.title ?? null, task.role ?? null, task.deps ?? []])}`);
    for (const h of Array.isArray(task.history) ? task.history : []) {
      units.add(`event\0${plan}\0${task.id}\0${JSON.stringify([h.at, h.from ?? null, h.to, h.note ?? null])}`);
    }
  }
}

// The units of a set of tracking files: one per entry (by the sha256 of its text, the import's import_hash) and the
// ledger units. A ledger that cannot be read is a unit of its own, which nothing can hold.
function unitsOf({ progress, ledgers }, splitEntries) {
  const units = new Set();
  for (const e of splitEntries(progress ?? '')) units.add(`entry\0${sha256(e.text)}`);
  for (const { path, name, text } of ledgers) {
    let ledger;
    try {
      ledger = readEntry(path, text).ledger;
    } catch {
      units.add(`unreadable\0${path}`);
      continue;
    }
    addLedgerUnits(units, planPathOf(name, ledger), ledger);
  }
  return units;
}

// The status sections of a status.md text as units (heading and body); none for no text or one that does not parse.
function statusUnits(text, parseStatusSections) {
  if (text === null) return [];
  try {
    return parseStatusSections(text).map((sct) => ({ heading: sct.heading, unit: `status\0${sct.heading}\0${sct.body}` }));
  } catch {
    return [];
  }
}

// The tracking files of a working tree at `root`, as committed mode lays them out.
function diskFiles(root) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const plansDir = join(root, ...LEDGER_DIR);
  return {
    progress: hasExact(root, 'progress.md') ? read(join(root, 'progress.md')) : null,
    status: hasExact(root, 'status.md') ? read(join(root, 'status.md')) : null,
    ledgers: ledgerPaths({ plansDir }).map((path) => ({ path, name: basename(path, LEDGER_EXT), text: read(path) ?? '' })),
  };
}

// The same files as committed on the branch `ref` (a full refs/heads/ name; `name` its short one, for messages).
function refFiles(root, ref, name) {
  const show = (path) => gitStrict(root, ['cat-file', 'blob', `${ref}:${path}`]);
  const top = gitStrict(root, ['ls-tree', '--name-only', '-z', ref, '--', 'progress.md', 'status.md']).split('\0').filter(Boolean);
  const plans = `${LEDGER_DIR.join('/')}/`;
  const names = gitStrict(root, ['ls-tree', '--name-only', '-z', ref, '--', plans]).split('\0')
    .filter((n) => n.startsWith(plans) && n.endsWith(LEDGER_EXT) && !n.slice(plans.length).includes('/')).sort();
  return {
    progress: top.includes('progress.md') ? show('progress.md') : null,
    status: top.includes('status.md') ? show('status.md') : null,
    ledgers: names.map((n) => ({ path: `${name}:${n}`, name: basename(n, LEDGER_EXT), text: show(n) })),
  };
}

// What the store holds of the clone, read without writing: { units } (imported entries' hashes and the ledger units)
// and { status } (its status sections as units). A store or a repository row that does not exist yet holds nothing.
function storeKnown(mods, { home, env, gitCommonDir }) {
  const known = { units: new Set(), status: new Set() };
  let store;
  try {
    store = mods.openStore({ home, env, readOnly: true });
  } catch (err) {
    if (err?.code === 'missing') return known;
    throw err;
  }
  try {
    const repo = store.findRepo(gitCommonDir);
    if (repo === null) return known;
    for (const r of store.all('SELECT import_hash FROM entries WHERE repo_id = ? AND import_hash IS NOT NULL', repo.id)) {
      known.units.add(`entry\0${r.import_hash}`);
    }
    for (const p of store.plans(repo.id)) addLedgerUnits(known.units, p.path, store.ledgerOf(p.id));
    for (const sct of store.status(repo.id)) known.status.add(`status\0${sct.heading}\0${sct.body}`);
  } finally {
    store.close();
  }
  return known;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One refusal line for `label` (a branch or a worktree) and the units it holds that nothing knows: the count of
// entries and ledger changes with how to import them, and each unreadable ledger with how to clear it (an import cannot
// read it either).
function blockLine(label, missing, importHint, place) {
  const unreadable = missing.filter((u) => u.startsWith('unreadable\0')).map((u) => u.split('\0')[1]);
  const importable = missing.filter((u) => !u.startsWith('unreadable\0'));
  const entries = importable.filter((u) => u.startsWith('entry\0')).length;
  const ledger = importable.length - entries;
  const parts = [];
  if (importable.length) {
    const counts = [entries && plural(entries, 'entry', 'entries'), ledger && plural(ledger, 'ledger change', 'ledger changes')];
    parts.push(`${counts.filter(Boolean).join(', ')} not in the store: ${importHint}`);
  }
  for (const path of unreadable) parts.push(`unreadable ledger ${path}: fix or delete it on ${place}`);
  return `${label}: ${parts.join('; ')}`;
}

// The unmerged local branches and the other worktrees that hold tracking changes neither on this worktree nor in the
// store (`known`): { blocking } lines, one each naming how to import them, and { warnings } for status.md sections the
// switch does not carry (an unmerged branch's, or a worktree's uncommitted ones; `import --ref` only reports status).
// Branches merged into HEAD are on this branch already.
function liveChanges(root, known, mods) {
  // Units nothing knows: `meta` ones (title, role, deps) apart, since they only warn.
  const missingOf = (units) => [...units].filter((u) => !known.units.has(u) && !u.startsWith('meta\0'));
  const metaOf = (units) => [...new Set([...units].filter((u) => u.startsWith('meta\0') && !known.units.has(u))
    .map((u) => u.split('\0')[2]))];
  const metaWarning = (label, ids, name) => `${label}: task titles, roles or deps differ for ${ids.join(', ')} (not `
    + `carried by the switch): run \`${BRAND.cli} tracking import --ref ${shq(name)}\` after the switch if that branch's `
    + 'should win';
  const statusOf = (text) => [...new Set(statusUnits(text, mods.parseStatusSections)
    .filter((sct) => !known.status.has(sct.unit)).map((sct) => `"${sct.heading}"`))];
  const statusWarning = (label, headings) => `${label}: status.md edits not carried by the switch (sections `
    + `${headings.join(', ')}): re-apply them with \`${BRAND.cli} tracking status set\` once they reach this branch`;
  const blocking = [];
  const warnings = [];
  const born = git(root, 'rev-parse', '--verify', '-q', 'HEAD') !== null;
  const own = git(root, 'symbolic-ref', '-q', 'HEAD');
  const refs = gitStrict(root, ['for-each-ref', '--format=%(refname)', ...(born ? ['--no-merged=HEAD'] : []), 'refs/heads/'])
    .split('\n').filter((r) => r && r !== own);
  for (const ref of refs) {
    const name = ref.slice('refs/heads/'.length);
    const files = refFiles(root, ref, name);
    const units = unitsOf(files, mods.splitEntries);
    const missing = missingOf(units);
    if (missing.length) {
      blocking.push(blockLine(`branch ${name}`, missing, `run \`${BRAND.cli} tracking import --ref ${shq(name)}\``, 'that branch'));
      continue;
    }
    const ids = metaOf(units);
    if (ids.length) warnings.push(metaWarning(`branch ${name}`, ids, name));
    const headings = statusOf(files.status);
    if (headings.length) warnings.push(statusWarning(`branch ${name}`, headings));
  }
  for (const wt of worktrees(root)) {
    if (wt.bare || wt.worktree === root || !existsSync(wt.worktree)) continue;
    const files = diskFiles(wt.worktree);
    const units = unitsOf(files, mods.splitEntries);
    const missing = missingOf(units);
    const branch = typeof wt.branch === 'string' ? wt.branch.replace(/^refs\/heads\//, '') : null;
    const label = `worktree ${wt.worktree}${branch ? ` (branch ${branch})` : ''}`;
    if (missing.length) {
      const hint = `commit them${branch ? `, then run \`${BRAND.cli} tracking import --ref ${shq(branch)}\`` : ' on a branch and import it with --ref'}`;
      blocking.push(blockLine(label, missing, hint, 'that worktree'));
      continue;
    }
    const ids = branch ? metaOf(units) : [];
    if (ids.length) warnings.push(metaWarning(label, ids, branch));
    const dirty = git(wt.worktree, 'status', '--porcelain', '--', 'status.md');
    const headings = dirty ? statusOf(files.status) : [];
    if (headings.length) warnings.push(statusWarning(label, headings));
  }
  return { blocking, warnings };
}

// ---- The switch ----

// The paths of this worktree the user commits after the switch: the deleted tracking files, the store hook files in a
// versioned hooks dir, and a CLAUDE.md or AGENTS.md holding the store section, each only when git sees it changed.
function switchCommit(root, hookFiles, section) {
  const specs = ['progress.md', 'status.md', `:(glob)${LEDGER_DIR.join('/')}/*${LEDGER_EXT}`, ...hookFiles];
  const docs = ['CLAUDE.md', 'AGENTS.md'].filter((f) => hasExact(root, f) && readFileSync(join(root, f), 'utf8').includes(section));
  const out = gitStrict(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', ...specs, ...docs]);
  const paths = out.split('\0').filter((rec) => rec.length >= 4).map((rec) => rec.slice(3));
  if (!paths.length) return null;
  return {
    paths,
    steps: [
      `${BRAND.cli} tracking add <draft>  (the switch commit's entry: the store pre-commit refuses the commit without one)`,
      `git add -A -- ${paths.map(shq).join(' ')}`,
      `git commit -m "${SWITCH_SUBJECT}"`,
    ],
  };
}

// Deletes `GATE_SCRIPT` from each of `dirs` unless another file there still names it (a call written by hand survives
// the unchain and would fail every commit without the script): 'removed', 'kept' (with a note) or 'absent'.
function removeGateScript(dirs, notes) {
  let result = 'absent';
  for (const d of dirs) {
    const gate = join(d, GATE_SCRIPT);
    if (!existsSync(gate)) continue;
    const users = readdirSync(d).filter((n) => n !== GATE_SCRIPT && !Object.values(STORE_SCRIPTS).includes(n)).filter((n) => {
      try {
        return readFileSync(join(d, n), 'utf8').includes(GATE_SCRIPT);
      } catch {
        return false; // a directory (husky's `_`) or an unreadable file
      }
    });
    if (users.length) {
      notes.push(`${gate} is kept: ${users.join(', ')} still call${users.length === 1 ? 's' : ''} it; remove those calls, then the script`);
      result = 'kept';
    } else {
      rmSync(gate);
      if (result === 'absent') result = 'removed';
    }
  }
  return result;
}

// `progress-init --store`. Checks first, changing nothing on a refusal (exit 1): a local repository whose hooks dir is
// versioned (S1), a pre-commit that is not a shell script (the store gate could not be chained into it), tracking
// changes on other branches or worktrees not imported, and unparsed entries without --accept-unparsed (found before
// any store is opened for writing). Then, in an order a re-run can always finish: (1) the import of this worktree's
// tracking files; (2) the store hook scripts, chained into the hooks (inert while the marker is unset); (3) the marker
// and the registry entry; (4) the local-mode lines and the progress-gate.sh chain removed, the CLAUDE.md section
// written, and the imported tracking files deleted from the working tree, the commit to make printed. It never stages
// or commits. `state.marked` tells the caller a failure came after the marker (a partial switch).
async function storeInit({ acceptUnparsed }, state) {
  const mods = {
    ...(await import('../lib/store.mjs')),
    ...(await import('../lib/store-import.mjs')),
    ...(await import('../lib/store-hooks.mjs')),
    ...(await import('../lib/status-sections.mjs')),
  };
  const home = homedir();
  const { env } = process;
  const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
  if (!repoRoot) throw new InitError('not inside a git repository.', 1);
  const root = real(repoRoot);
  const t = resolveTracking(root);
  const from = t?.mode ?? null;
  const gitCommonDir = real(gitStrict(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const mainRoot = mainWorktreeRoot(root, gitCommonDir) ?? root;
  const gitHooks = join(gitCommonDir, 'hooks');
  const hooksDir = storeHooksDir(root, gitHooks);
  const trees = [root, ...worktrees(root).filter((w) => !w.bare).map((w) => w.worktree)];
  const versioned = !within(gitCommonDir, hooksDir) && trees.some((r) => within(r, hooksDir));
  // The working tree's tracking files are read (and deleted after the import): a committed repository's, or a store
  // repository's left by a switch that stopped before deleting them (progress.md is deleted last).
  // The mode the repository is switched from: today's, or the one the first switch recorded in ORIGIN_KEY (never
  // changed after). A store repository without a valid record is treated as local, so nothing is written in its tree.
  const recorded = from === 'store' ? git(root, 'config', '--local', '--get', ORIGIN_KEY) : null;
  const origin = from === 'store' ? (ORIGINS.has(recorded) ? recorded : 'local') : (from ?? 'none');
  const fromLocal = origin === 'local';
  const importsTree = from === 'committed' || (from === 'store' && !fromLocal && hasExact(root, 'progress.md'));

  // S1: a repository from local mode stays local when its hooks would land inside a working tree (a re-run included).
  if (fromLocal && versioned) {
    // A store repository without a valid record: its origin is unknown, so it is not called a local-mode repository.
    if (from === 'store' && !ORIGINS.has(recorded)) {
      throw new InitError(`this store repository's origin is unknown (no valid \`git config --local ${ORIGIN_KEY}\`): it is `
        + `treated as local mode, so nothing is written in its tree, and its hooks directory (${hooksDir}) is inside its `
        + 'working tree (core.hooksPath), where store hooks are never written; for a repository that came from committed '
        + `mode, run \`git config --local ${ORIGIN_KEY} committed\`, then ${RERUN} again`, 1);
    }
    throw new InitError(`this local-mode repository's hooks directory (${hooksDir}) is inside its working tree `
      + '(core.hooksPath), and store hooks are never written there: it stays in local mode', 1);
  }
  // Both store hooks must chain: without the pre-commit nothing is gated, and without the post-commit no entry is
  // stamped, so one pending entry would let every later commit through.
  for (const [name, script] of Object.entries(STORE_SCRIPTS)) {
    const hook = join(hooksDir, name);
    if (!existsSync(hook)) continue;
    const text = readFileSync(hook, 'utf8');
    const first = text.split('\n')[0];
    if (!text.includes(script) && !isShellHook(first)) {
      throw new InitError(`${hook} is not a shell script (${first.trim()}), so the store ${name} cannot be chained into `
        + `it: nothing was switched; make it a shell script (or call ${script} from it by hand), then run ${RERUN} again`, 1);
    }
  }

  await mods.loadSqlite();
  const known = storeKnown(mods, { home, env, gitCommonDir });
  const stored = new Set(known.units);
  const prepared = t === null || (t.mode === 'store' && !importsTree) ? null : mods.prepareImport(t);
  const notes = [];
  if (!fromLocal) {
    if (importsTree) {
      const current = diskFiles(root);
      for (const u of unitsOf(current, mods.splitEntries)) known.units.add(u);
      for (const sct of statusUnits(current.status, mods.parseStatusSections)) known.status.add(sct.unit);
    }
    const { blocking, warnings } = liveChanges(root, known, mods);
    if (blocking.length) {
      throw new InitError(`other branches or worktrees hold tracking changes the switch would leave behind; import each `
        + `first:\n${blocking.map((l) => `  ${l}`).join('\n')}`, 1);
    }
    for (const w of warnings) {
      process.stderr.write(`progress-init: warning: ${w}\n`);
      notes.push(w);
    }
  }
  const seen = new Set();
  const unparsed = (prepared?.entries ?? []).filter((e) => !e.parseOk && !stored.has(`entry\0${e.hash}`)
    && !seen.has(e.hash) && seen.add(e.hash));
  if (unparsed.length && !acceptUnparsed) {
    throw new InitError(`${unparsed.map((e) => `unparsed: ${e.heading} (${e.problem})`).join('\n')}\n`
      + `${plural(unparsed.length, 'entry', 'entries')} cannot be parsed (listed above): nothing was switched; fix them, `
      + 'or run again with --accept-unparsed to import them flagged with their original text', 1);
  }

  // (1) The import. The first write creates the repository row (storeContext names the main worktree's root).
  const sc = storeContext(t ?? { mode: 'none', repoRoot: root }, { home, env, write: true, create: true });
  let importLines = [];
  try {
    if (prepared !== null) {
      let result;
      try {
        result = mods.runImport(sc.store, sc.ctx, prepared, { acceptUnparsed });
      } catch (err) {
        if (!(err instanceof mods.UnparsedEntries)) throw err;
        throw new InitError(`${mods.reportLines(err.report).join('\n')}\n${err.message} (listed above): nothing was `
          + 'switched; fix them, or run again with --accept-unparsed to import them flagged with their original text', 1);
      }
      importLines = mods.reportLines(result);
      try {
        mods.maybeDailySnapshot(sc.store, sc.dataDir, new Date());
      } catch (err) {
        process.stderr.write(`progress-init: warning: the daily snapshot failed: ${err.message}\n`);
      }
    }
  } finally {
    sc.store.close();
  }

  const report = {
    mode: 'store', from, root: mainRoot, worktree: root, import: importLines, hook: null, claudeMd: null, agentsMd: null,
    deleted: [], commit: null, notes,
  };

  // (2) The store hook scripts, each chained once; they do nothing until the marker is set.
  mkdirSync(hooksDir, { recursive: true });
  const chained = {};
  for (const [name, script] of Object.entries(STORE_SCRIPTS)) {
    writeIfChanged(join(hooksDir, script), storeScript(name, mods.STORE_HOOK_LINES[name]));
    const ref = hookRef(hooksDir, script, { root, gitHooks });
    const line = name === 'pre-commit' ? `sh ${ref} || exit 1` : `sh ${ref} || true`;
    chained[name] = chainInto(join(hooksDir, name), line, script, report.notes);
  }
  for (const [name, result] of Object.entries(chained)) {
    if (result === 'not-shell') throw new InitError(`${join(hooksDir, name)} became a non-shell script: nothing was switched`, 1);
  }

  // (3) The origin (recorded once, before the marker), the marker and the registry entry.
  if (from !== 'store') gitStrict(root, ['config', '--local', ORIGIN_KEY, origin]);
  if (git(root, 'config', '--local', '--get', MARKER_KEY) !== 'store') gitStrict(root, ['config', '--local', MARKER_KEY, 'store']);
  state.marked = true;
  registerRepo(home, { root: mainRoot, mode: 'store', now: new Date() });

  // (4) The old gates out, the CLAUDE.md section, the imported tracking files deleted.
  const dirs = [...new Set([hooksDir, gitHooks])];
  const removed = {
    localPreCommit: unchain(join(gitHooks, 'pre-commit'), LOCAL_HOOK_LINES['pre-commit']),
    localPostCommit: unchain(join(gitHooks, 'post-commit'), LOCAL_HOOK_LINES['post-commit']),
    gate: dirs.map((d) => unchainWhere(join(d, 'pre-commit'), (l) => GATE_CHAIN.test(l))).includes('removed') ? 'removed' : 'absent',
    gateScript: removeGateScript(dirs, report.notes),
  };
  report.hook = { dir: hooksDir, versioned, preCommit: chained['pre-commit'], postCommit: chained['post-commit'], removed };

  // The CLAUDE.md section (and an existing AGENTS.md's), created when missing, also by a re-run that finishes a switch;
  // never for a repository switched from local mode (nothing in its tree; the recorded origin says so on a re-run).
  const section = tpl('claude-section-store.md');
  const sectionFiles = fromLocal ? [] : [['claudeMd', 'CLAUDE.md'], ['agentsMd', 'AGENTS.md']];
  for (const [key, name] of sectionFiles) {
    const file = join(root, name);
    const exists = hasExact(root, name);
    const text = exists ? readFileSync(file, 'utf8') : '';
    if (!exists && name !== 'CLAUDE.md') continue;
    const { next, result } = withSection(text, section);
    report[key] = next === text ? 'unchanged' : result;
    if (next !== text) writeAtomic(file, next);
  }
  if (from === 'local') {
    report.notes.push(`local mode: ${localRoot(root)} is kept as it was (the store now holds its import); nothing was `
      + 'written inside the working tree');
  }

  if (importsTree) {
    // progress.md last: while it exists, a re-run knows the switch has files left to import and delete.
    const files = [...ledgerPaths({ plansDir: join(root, ...LEDGER_DIR) }),
      ...['status.md', 'progress.md'].filter((f) => hasExact(root, f)).map((f) => join(root, f))];
    for (const f of files) {
      rmSync(f);
      report.deleted.push(relative(root, f));
    }
  }
  const hookFiles = versioned && within(root, hooksDir)
    ? ['pre-commit', 'post-commit', GATE_SCRIPT, ...Object.values(STORE_SCRIPTS)].map((f) => relative(root, join(hooksDir, f)))
    : [];
  if (!fromLocal) report.commit = switchCommit(root, hookFiles, section.trim());
  if (report.commit) {
    report.notes.push(`Nothing was staged or committed: the switch commit (\`commit\`) needs its entry first, with \`${BRAND.cli} `
      + 'tracking add <draft>`, then `git add -A` of its paths and `git commit`.');
  }
  return report;
}

// --store from the command line: the JSON report, or the failure and its exit code (1 unless an InitError says
// otherwise). A failure after the marker names the re-run that finishes the switch.
async function storeCli(flags) {
  const state = { marked: false };
  try {
    const report = await storeInit(flags, state);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (err) {
    const { ImportError } = await import('../lib/store-import.mjs');
    const known = err instanceof InitError || err instanceof ImportError || ['StoreError', 'LedgerError'].includes(err?.name)
      || typeof err?.code === 'string';
    const partial = state.marked
      ? `\nthe switch stopped partway: the store hooks and the marker are in place, so commits are gated by the store; `
        + `fix the cause, then run ${RERUN} again to finish it`
      : '';
    process.stderr.write(`progress-init: ${known ? err.message : err?.stack ?? String(err)}${partial}\n`);
    process.exitCode = err instanceof InitError ? err.code : 1;
  }
}

const USAGE = `usage: triqual progress-init [--local [--remove]]
       triqual progress-init --store [--accept-unparsed]
  --local            local mode, for shared team/client repos: tracking files under <git-common-dir>/methodology/
  --remove           with --local: delete that root and remove the chained hook lines
  --store            switch to store mode: import the tracking files into the local tracking store, set the marker,
                     install the store hooks; a committed repo's tracking files are deleted (the commit is yours)
  --accept-unparsed  with --store: import entries whose fields cannot be parsed, flagged with their original text
  -h, --help         print this help`;

// The command line: the usage for --help/-h, else the JSON report (or the error and its exit code). --store runs
// asynchronously (node:sqlite is loaded then) and returns its promise; every other run is synchronous.
export function cli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return undefined;
  }
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`progress-init: ${err.message}\n`);
    process.exitCode = err.code;
    return undefined;
  }
  if (flags.store) return storeCli(flags);
  try {
    process.stdout.write(JSON.stringify(main(argv), null, 2) + '\n');
  } catch (err) {
    if (!(err instanceof InitError)) throw err;
    process.stderr.write(`progress-init: ${err.message}\n`);
    process.exitCode = err.code;
  }
}

// True when node runs this file itself, not when another module (bin/progress-init.mjs, bin/tasks.mjs) imports it.
function isEntry() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntry()) cli(process.argv.slice(2));
