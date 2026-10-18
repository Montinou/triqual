// Bulk writers (spec, "Built-in self-protection": the bulk-writer data table, ancestors of a
// protected path, git tree updates).
//
//   BULK_WRITERS            rows {name, kind, program, sub?, read(call) -> result|null}
//   bulkOf(argv, ctx?)      the first row that matches the command, read: {name, kind, ...} | null
//                           ctx.exists(word, base) says whether a word names an existing path
//                           (base: git -C, undefined when none)
//   TREE_PATHSPECS          the pathspecs the git tree check passes (from PROJECT_SUBGLOBS)
//   PROTECTED_SUBGLOBS      PROJECT_SUBGLOBS (builtin.mjs), re-exported for the walker
//   MAX_WALK_ENTRIES, MAX_WALK_DEPTH   the bound on the source walk under a protected subpath
//
// argv is the command after wrapper unwrapping (elements are strings or UNKNOWN). Kinds:
//   copy     {pairs: [{src, dest}]}: src's tree lands at dest (or dest/<basename src>). A src
//            whose contents cannot be known (UNKNOWN, a remote rsync operand, a cpio -p list read
//            from stdin) is UNKNOWN. Rows: cp -r/-R/-a/--recursive/--archive, rsync, ditto (no -x/-c),
//            pax -rw.
//   move     {pairs: [{src, dest}]}: mv, git mv, util-linux rename (dest = the computed new name;
//            a perl-style rename expression gives an UNKNOWN dest).
//   archive  {dests}: files of unknown names land under each dest: tar -x, bsdtar -x, unzip,
//            7z x/e, ditto -x, cpio -i/-p, pax -r, git clone, git worktree add. -P/--absolute-names,
//            cpio --absolute-filenames and pax -s make the dest UNKNOWN (names may go anywhere).
//   patch    {program, files, strip, dir, base, readOnly}: patch, git apply, git am. files = []
//            means the patch comes from stdin; an UNKNOWN element is a non-literal patch path.
//   index    {paths} | {opaque}: git update-index --cacheinfo (PATH is a write), --index-info/--stdin.
//   git-tree {sub, target, base}: every git command that updates the working tree without naming
//            files. target is a revision word, 'HEAD' (no change), {stash: 'stash@{N}'}, or
//            UNNAMEABLE (pull, am from a mailbox in progress, --continue/--abort forms, ranges,
//            several heads, an UNKNOWN word, switch --orphan, read-tree --prefix).
// The normalizer judges each kind (norm/normalize.mjs, bulkStep). Pure data and parsing; nothing
// here reads the file system except through ctx.exists(word) (git checkout <path>).

import { UNKNOWN } from '../norm/unknown.mjs';
import { PROJECT_SUBGLOBS } from '../eval/builtin.mjs';
import { parsedCall, parseOptions, gitSplit, gitBase, repoDirName } from './classes.mjs';

export const PROTECTED_SUBGLOBS = PROJECT_SUBGLOBS;
export const TREE_PATHSPECS = PROJECT_SUBGLOBS.map((s) => `:(glob,icase)${s}`);
export const MAX_WALK_ENTRIES = 200;
export const MAX_WALK_DEPTH = 6;
export const UNNAMEABLE = Object.freeze({ unnameable: true });

const isStr = (w) => typeof w === 'string';
const L = (s) => s.split(/\s+/).filter(Boolean).map((n) => `--${n}`);
const last = (a) => a[a.length - 1];

// An rsync operand on another host (host:path, user@host:path, rsync://).
const isRemote = (w) => isStr(w) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^[^/]*[^/\\]:/.test(w));

function pairs(sources, dests) {
  const out = [];
  for (const dest of dests) for (const src of sources) out.push({ src, dest });
  return out;
}

// sources and destination of `prog [-t DIR] SRC… DEST`
function srcDest(p) {
  const dirs = p.vals('t', '--target-directory');
  if (dirs.length > 0) return pairs(p.operands, dirs);
  if (p.operands.length < 2) return [];
  return pairs(p.operands.slice(0, -1), [last(p.operands)]);
}

// ---- option grammars for programs without a row in classes.mjs -----------------------------------

const TAR_SPEC = { short: 'fCbTXIKLNgFVH', long: L('file directory exclude files-from exclude-from use-compress-program format blocking-factor transform xform to-command') };
const UNZIP_SPEC = { short: 'dP' };
const SEVENZ_SPEC = { short: 'o' };
const DITTO_SPEC = { long: L('arch bom') };
const CPIO_SPEC = { short: 'DEFHIMORC', long: L('directory file format pattern-file owner message') };
const PAX_SPEC = { short: 'fsoxbpEGTU' };
const PATCH_SPEC = { short: 'pdioBDFrVYzg', long: L('strip directory input output reject-file prefix ifdef fuzz version-control basename-prefix suffix get quoting-style') };
const RENAME_SPEC = {};
const GIT_APPLY_SPEC = { short: 'pC', long: L('directory exclude include whitespace build-fake-ancestor') };
const GIT_AM_SPEC = { short: 'pCS', long: L('directory exclude include whitespace patch-format resolvemsg quoted-cr empty') };
const GIT_CLONE_SPEC = {
  short: 'bocju',
  long: L('branch origin depth reference reference-if-able separate-git-dir jobs template config upload-pack filter shallow-since shallow-exclude bundle-uri ref-format revision server-option'),
};
const GIT_WORKTREE_SPEC = { short: 'bB', long: L('reason') };
const GIT_CHECKOUT_SPEC = { short: 'bB', long: L('orphan conflict pathspec-from-file') };
const GIT_SWITCH_SPEC = { short: 'cC', long: L('create force-create orphan conflict') };
const GIT_RESTORE_SPEC = { short: 's', long: L('source pathspec-from-file') };
const GIT_MERGE_SPEC = { short: 'mFsX', long: L('message file strategy strategy-option into-name cleanup log') };
const GIT_REBASE_SPEC = { short: 'sXx', long: L('onto strategy strategy-option exec empty whitespace') };
const GIT_PICK_SPEC = { short: 'mX', long: L('mainline strategy strategy-option cleanup') };
const GIT_READ_TREE_SPEC = { long: L('index-output exclude-per-directory') };

// ---- readers -------------------------------------------------------------------------------------

// GNU tar strips leading `/` and refuses `..` members by default, and so does bsdtar; -P
// (--absolute-names) and bsdtar's --insecure keep them: the names may land anywhere.
function tarExtract(c) {
  const a1 = c.argv[1];
  // old style: `tar xvf a.tar`, `tar xCf out a.tgz` (a first word of mode letters without a dash;
  // each value-taking letter takes the next word, in order)
  const oldStyle = isStr(a1) && /^[A-Za-z]+$/.test(a1) ? a1 : '';
  const oldDirs = [];
  let k = 2;
  for (const ch of oldStyle) {
    if (!TAR_SPEC.short.includes(ch)) continue;
    const v = c.argv[k++];
    if (ch === 'C') oldDirs.push(v === undefined ? UNKNOWN : v);
  }
  const extract = c.p.has('x', '--extract', '--get') || c.p.longLike('extract', 3) || oldStyle.includes('x');
  if (!extract) return null;
  const anywhere = c.p.has('P', '--absolute-names', '--insecure') || c.p.longLike('absolute-names', 3) || c.p.longLike('insecure', 3) || oldStyle.includes('P');
  const dirs = [...oldDirs, ...c.p.vals('C', '--directory')];
  return { dests: anywhere ? [UNKNOWN] : dirs.length > 0 ? dirs : ['.'] };
}

// unzip strips `/` and `../` unless -: is given
function unzipRead(c) {
  if (c.p.has('l', 't', 'v', 'Z', 'p', 'c', 'z')) return null;
  if (c.p.has(':')) return { dests: [UNKNOWN] };
  const d = c.p.vals('d');
  return { dests: d.length > 0 ? d : ['.'] };
}

function sevenZRead(c) {
  const verb = c.p.operands[0];
  if (verb !== 'x' && verb !== 'e' && verb !== UNKNOWN) return null;
  const o = c.p.vals('o');
  return { dests: o.length > 0 ? o : ['.'] };
}

// GNU cpio -i keeps absolute and `..` member names unless --no-absolute-filenames is given.
function cpioRead(c) {
  const anywhere = c.p.longLike('absolute-filenames', 3);
  if (c.p.has('i', '--extract') || c.p.longLike('extract', 3)) {
    const d = c.p.vals('D', '--directory');
    const stripped = c.p.longLike('no-absolute-filenames', 4) && !anywhere;
    return { kind: 'archive', dests: !stripped ? [UNKNOWN] : d.length > 0 ? d : ['.'] };
  }
  // pass-through: the file list comes from stdin, the destination is the operand
  if (c.p.has('p', '--pass-through') || c.p.longLike('pass-through', 3)) return { kind: 'archive', dests: anywhere ? [UNKNOWN] : [c.p.operands[0] ?? UNKNOWN] };
  return null;
}

function paxRead(c) {
  if (!c.p.has('r')) return null;
  const anywhere = c.p.has('s');
  if (c.p.has('w')) {
    if (c.p.operands.length === 0) return null;
    if (anywhere) return { kind: 'archive', dests: [UNKNOWN] };
    // copy mode: the operands are the files, the last one the directory
    return { kind: 'copy', pairs: c.p.operands.length < 2 ? [{ src: UNKNOWN, dest: c.p.operands[0] }] : pairs(c.p.operands.slice(0, -1), [last(c.p.operands)]) };
  }
  // pax -r extracts member names as stored (absolute and `..` included): they may land anywhere
  return { kind: 'archive', dests: [UNKNOWN] };
}

function dittoRead(c) {
  if (c.p.has('c')) return null; // creates an archive file: an ordinary write
  if (c.p.operands.length < 2) return null;
  if (c.p.has('x')) return { kind: 'archive', dests: [last(c.p.operands)] };
  return { kind: 'copy', pairs: pairs(c.p.operands.slice(0, -1), [last(c.p.operands)]) };
}

function stripOf(p, fallback) {
  const v = p.vals('p', '--strip');
  if (v.length === 0) return fallback;
  const n = isStr(last(v)) && /^[0-9]{1,3}$/.test(last(v)) ? Number(last(v)) : UNKNOWN;
  return n;
}

function patchRead(c) {
  const p = c.p;
  const input = p.vals('i', '--input');
  let files;
  if (input.length > 0) files = input;
  else if (p.operands.length >= 2) files = [p.operands[1]];
  else files = [];
  // `patch ORIGINAL [PATCH]`: every hunk goes to ORIGINAL, an operand (already an ordinary write)
  const original = p.operands.length >= 1 ? p.operands[0] : undefined;
  const dir = p.vals('d', '--directory');
  return { program: 'patch', files, original, strip: stripOf(p, 'patch-default'), dir: dir.length > 0 ? last(dir) : undefined, readOnly: p.has('--dry-run') || p.longLike('dry-run', 3) };
}

// ---- git -----------------------------------------------------------------------------------------

function gitArgs(g, spec) {
  const dash = g.rest.indexOf('--');
  const before = dash < 0 ? g.rest : g.rest.slice(0, dash);
  return { p: parseOptions([g.sub, ...g.rest], spec), pos: parseOptions([g.sub, ...before], spec).operands, dashed: dash >= 0 };
}

const tree = (target) => ({ kind: 'git-tree', target });
const hasUnknown = (g) => g.rest.some((w) => !isStr(w));

function checkoutRead(g, ctx) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p, pos, dashed } = gitArgs(g, GIT_CHECKOUT_SPEC);
  const create = p.hasVal('b', 'B', '--orphan');
  if (create) return tree(pos[0] ?? 'HEAD');
  if (pos.length === 0) return tree('HEAD');
  // `git checkout WORD` with no `--` where WORD is also an existing path: git takes it as a ref when
  // it resolves as one, so the check still runs; only git's NOT_A_REVISION answer makes it a path
  // restore (ambiguousPath)
  if (!dashed && pos.length >= 1 && ctx.exists(pos[0], gitBase(g.chdirs))) return { kind: 'git-tree', target: pos[0], ambiguousPath: true };
  return tree(pos[0] === '-' ? '@{-1}' : pos[0]);
}

function switchRead(g) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p, pos } = gitArgs(g, GIT_SWITCH_SPEC);
  if (p.hasVal('--orphan')) return tree(UNNAMEABLE); // every tracked file is removed
  return tree(pos[0] === undefined ? 'HEAD' : pos[0] === '-' ? '@{-1}' : pos[0]);
}

function restoreRead(g) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p } = gitArgs(g, GIT_RESTORE_SPEC);
  const src = p.vals('s', '--source');
  return tree(src.length > 0 ? last(src) : 'HEAD');
}

function resetRead(g) {
  const { p, pos } = gitArgs(g, {});
  if (!(p.has('--hard', '--merge', '--keep') || p.hasUnknown)) return null;
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  return tree(pos[0] ?? 'HEAD');
}

function mergeRead(g) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p, pos } = gitArgs(g, GIT_MERGE_SPEC);
  if (p.has('--continue', '--quit')) return null;
  if (p.has('--abort')) return tree(UNNAMEABLE);
  if (pos.length === 0) return tree('@{upstream}');
  return tree(pos.length === 1 ? pos[0] : UNNAMEABLE);
}

function rebaseRead(g) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p, pos } = gitArgs(g, GIT_REBASE_SPEC);
  if (p.has('--edit-todo', '--show-current-patch')) return null;
  if (p.has('--continue', '--skip', '--abort', '--quit', '--root')) return tree(UNNAMEABLE);
  if (pos.length > 1) return tree(UNNAMEABLE); // `rebase upstream branch` checks out branch first
  const onto = p.vals('--onto');
  if (onto.length > 0) return tree(last(onto));
  return tree(pos[0] ?? '@{upstream}');
}

const isRange = (w) => w.includes('..') || w.startsWith('^');

function pickRead(g) {
  if (hasUnknown(g)) return tree(UNNAMEABLE);
  const { p, pos } = gitArgs(g, GIT_PICK_SPEC);
  if (p.has('--quit')) return null;
  if (p.has('--continue', '--skip', '--abort')) return tree(UNNAMEABLE);
  if (pos.length !== 1 || isRange(pos[0])) return tree(UNNAMEABLE);
  if (g.sub === 'cherry-pick') return tree(pos[0]);
  // revert C brings back C's parent (-m N: that parent)
  const m = p.vals('m', '--mainline');
  const n = m.length > 0 && isStr(last(m)) && /^[1-9][0-9]?$/.test(last(m)) ? last(m) : m.length > 0 ? null : '1';
  return tree(n === null ? UNNAMEABLE : `${pos[0]}^${n}`);
}

function stashRead(g) {
  const verb = g.rest[0];
  if (verb === undefined) return null; // bare `git stash` (push)
  if (!isStr(verb)) return tree(UNNAMEABLE);
  if (verb !== 'pop' && verb !== 'apply') return null;
  const { pos } = gitArgs({ sub: verb, rest: g.rest.slice(1) }, {});
  const ref = pos[0];
  if (ref === undefined) return tree({ stash: 'stash@{0}' });
  if (!isStr(ref)) return tree(UNNAMEABLE);
  if (/^[0-9]{1,6}$/.test(ref)) return tree({ stash: `stash@{${ref}}` });
  return tree(/^stash@\{[0-9]{1,6}\}$/.test(ref) ? { stash: ref } : UNNAMEABLE);
}

function readTreeRead(g) {
  const { p, pos } = gitArgs(g, GIT_READ_TREE_SPEC);
  if (!p.has('u') && !p.hasUnknown) return null;
  if (hasUnknown(g) || p.longStarts('prefix')) return tree(UNNAMEABLE);
  return tree(pos.length === 1 ? pos[0] : UNNAMEABLE);
}

function applyRead(g) {
  const { p } = gitArgs(g, GIT_APPLY_SPEC);
  const readOnly = p.has('--check', '--stat', '--numstat', '--summary') && !p.has('--apply');
  const dir = p.vals('--directory');
  return { kind: 'patch', program: 'apply', files: p.operands, strip: stripOf(p, 1), dir: dir.length > 0 ? last(dir) : undefined, readOnly, noIndex: p.has('--no-index') };
}

function amRead(g) {
  const { p } = gitArgs(g, GIT_AM_SPEC);
  if (p.has('--quit', '--show-current-patch') || p.longStarts('show-current-patch')) return null;
  if (p.has('--continue', '--skip', '--abort', '--resolved', 'r')) return tree(UNNAMEABLE);
  const dir = p.vals('--directory');
  return { kind: 'patch', program: 'am', files: p.operands, strip: stripOf(p, 1), dir: dir.length > 0 ? last(dir) : undefined, readOnly: false };
}

function cloneRead(g) {
  const { p } = gitArgs(g, GIT_CLONE_SPEC);
  const [url, dest] = p.operands;
  return { kind: 'archive', dests: [dest !== undefined ? dest : url === undefined ? UNKNOWN : repoDirName(url)] };
}

// `git worktree add PATH [COMMIT-ISH]`: a new tree at PATH, and the tree check runs with COMMIT-ISH
// as for any tree update. With no commit-ish: -b/-B/--detach start from HEAD; otherwise git checks
// out the branch named basename(PATH) when it exists (else a new branch from HEAD): the target is
// that name, and a NOT_A_REVISION answer means the new-branch case (newBranchGuess).
function worktreeRead(g) {
  if (g.rest[0] !== 'add') return g.rest[0] === UNKNOWN ? { kind: 'archive', dests: [UNKNOWN], treeTarget: UNNAMEABLE } : null;
  const p = parseOptions(['add', ...g.rest.slice(1)], GIT_WORKTREE_SPEC);
  const dest = p.operands[0] ?? UNKNOWN;
  const commit = p.operands[1];
  if (p.hasUnknown || p.unknownValue) return { kind: 'archive', dests: [dest], treeTarget: UNNAMEABLE };
  if (commit !== undefined) return { kind: 'archive', dests: [dest], treeTarget: commit === '-' ? '@{-1}' : commit };
  if (p.hasVal('b', 'B') || p.has('--detach')) return { kind: 'archive', dests: [dest], treeTarget: 'HEAD' };
  const name = isStr(dest) ? dest.replace(/\/+$/, '').slice(dest.replace(/\/+$/, '').lastIndexOf('/') + 1) : '';
  if (name === '' || name === '.' || name === '..') return { kind: 'archive', dests: [dest], treeTarget: UNNAMEABLE };
  return { kind: 'archive', dests: [dest], treeTarget: name, newBranchGuess: true };
}

// `git update-index --cacheinfo MODE,SHA,PATH` (or three words) stages PATH; --index-info and
// --stdin read entries from stdin (opaque).
function updateIndexRead(g) {
  const out = [];
  for (let i = 0; i < g.rest.length; i++) {
    const a = g.rest[i];
    if (!isStr(a)) continue;
    if (a === '--index-info' || a === '--stdin') return { kind: 'index', opaque: true };
    if (a.startsWith('--cacheinfo=')) {
      const parts = a.slice('--cacheinfo='.length).split(',');
      out.push(parts.length >= 3 ? parts.slice(2).join(',') : UNKNOWN);
      continue;
    }
    if (a !== '--cacheinfo') continue;
    const v = g.rest[i + 1];
    if (isStr(v) && v.includes(',')) {
      const parts = v.split(',');
      out.push(parts.length >= 3 ? parts.slice(2).join(',') : UNKNOWN);
      i++;
    } else {
      out.push(g.rest[i + 3] === undefined ? UNKNOWN : g.rest[i + 3]);
      i += 3;
    }
  }
  return out.length === 0 ? null : { kind: 'index', paths: out };
}

function gitMvRead(g) {
  const p = parseOptions([g.sub, ...g.rest], {});
  return { kind: 'move', pairs: p.operands.length < 2 ? [] : pairs(p.operands.slice(0, -1), [last(p.operands)]) };
}

// util-linux `rename [opts] FROM TO FILE…`: each FILE's new name has FROM replaced by TO (first,
// last and every occurrence, so -l/-a are covered). Perl `rename 's/…/…/' FILE…`: UNKNOWN names.
function renameRead(c) {
  const ops = c.p.operands;
  const perl = ops.length < 3 || (isStr(ops[0]) && /^(?:s|y|tr)\W/.test(ops[0]));
  if (perl) return { pairs: ops.slice(1).map((src) => ({ src, dest: UNKNOWN })) };
  const [from, to, ...files] = ops;
  const out = [];
  for (const src of files) {
    if (!isStr(src) || !isStr(from) || !isStr(to)) {
      out.push({ src, dest: UNKNOWN });
      continue;
    }
    if (from === '' || !src.includes(from)) continue;
    const i = src.lastIndexOf(from);
    for (const dest of new Set([src.replace(from, to), src.slice(0, i) + to + src.slice(i + from.length), src.split(from).join(to)])) out.push({ src, dest });
  }
  return { pairs: out };
}

const recursiveCopy = (p) => p.has('r', 'R', 'a') || p.longLike('recursive', 3) || p.longLike('archive', 3);

// ---- the table -----------------------------------------------------------------------------------

const prog = (name, kind, read, spec) => ({ name, kind, program: name, spec, read });
const git = (sub, kind, read) => ({ name: `git ${sub}`, kind, program: 'git', sub, read });

/** The bulk writers. Each row's read(call, ctx) returns its reading of the command, or null when that invocation is not a bulk write (git rows get gitSplit()'s {chdirs, sub, rest}). */
export const BULK_WRITERS = [
  prog('cp', 'copy', (c) => (recursiveCopy(c.p) ? { pairs: srcDest(c.p) } : null)),
  prog('rsync', 'copy', (c) => ({ pairs: srcDest(c.p).map(({ src, dest }) => ({ src: isRemote(src) ? UNKNOWN : src, dest })).filter(({ dest }) => !isRemote(dest)) })),
  prog('tar', 'archive', tarExtract, TAR_SPEC),
  prog('bsdtar', 'archive', tarExtract, TAR_SPEC),
  prog('unzip', 'archive', unzipRead, UNZIP_SPEC),
  ...['7z', '7za', '7zr', '7zz'].map((n) => prog(n, 'archive', sevenZRead, SEVENZ_SPEC)),
  prog('ditto', 'copy', dittoRead, DITTO_SPEC),
  prog('cpio', 'archive', cpioRead, CPIO_SPEC),
  prog('pax', 'archive', paxRead, PAX_SPEC),
  prog('patch', 'patch', patchRead, PATCH_SPEC),
  prog('mv', 'move', (c) => ({ pairs: srcDest(c.p) })),
  prog('rename', 'move', renameRead, RENAME_SPEC),
  git('clone', 'archive', cloneRead),
  git('worktree', 'archive', worktreeRead),
  git('apply', 'patch', applyRead),
  git('am', 'patch', amRead),
  git('mv', 'move', gitMvRead),
  git('checkout', 'git-tree', checkoutRead),
  git('switch', 'git-tree', switchRead),
  git('restore', 'git-tree', restoreRead),
  git('reset', 'git-tree', resetRead),
  git('merge', 'git-tree', mergeRead),
  git('pull', 'git-tree', () => tree(UNNAMEABLE)),
  git('rebase', 'git-tree', rebaseRead),
  git('cherry-pick', 'git-tree', pickRead),
  git('revert', 'git-tree', pickRead),
  git('stash', 'git-tree', stashRead),
  git('read-tree', 'git-tree', readTreeRead),
  // writes the index's content to the working tree: the index is not nameable
  git('checkout-index', 'git-tree', () => tree(UNNAMEABLE)),
  git('update-index', 'index', updateIndexRead),
];

const BY_PROGRAM = new Map();
for (const r of BULK_WRITERS) {
  const key = r.sub ? `git ${r.sub}` : r.program;
  BY_PROGRAM.set(key, r);
}

/**
 * The bulk-writer reading of a command, or null.
 * @param {(string|typeof UNKNOWN)[]} argv after wrapper unwrapping
 * @param {{exists?: (word: string) => boolean}} [ctx]
 * @returns {null | {name: string, kind: string, base?: string|typeof UNKNOWN, [k: string]: unknown}}
 */
export function bulkOf(argv, ctx = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !isStr(argv[0])) return null;
  const c0 = parsedCall(argv);
  if (c0 === null) return null;
  const exists = ctx && typeof ctx.exists === 'function' ? ctx.exists : () => false;
  if (c0.name === 'git') {
    const g = gitSplit(c0.argv);
    if (!isStr(g.sub)) return null; // an UNKNOWN sub-command is opaque-or-unmodeled upstream
    const row = BY_PROGRAM.get(`git ${g.sub}`);
    if (!row) return null;
    const r = row.read(g, { exists });
    if (r === null) return null;
    return { name: row.name, kind: r.kind || row.kind, sub: g.sub, base: gitBase(g.chdirs), ...r };
  }
  const row = BY_PROGRAM.get(c0.name);
  if (!row) return null;
  const c = row.spec ? parsedCall(argv, row.spec) : c0;
  const r = row.read(c, { exists });
  if (r === null) return null;
  return { name: row.name, kind: r.kind || row.kind, ...r };
}
