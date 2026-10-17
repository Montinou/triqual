// Ancestor-operation table for the normalizer. The evaluator feeds every op to
// builtin.checkAncestorOp, which denies an operation on a protected path or on a directory that
// holds one. The simple operand tools (rm, mv, chmod, ln) live here; the operations of programs
// with real option grammars (find -delete, rsync --delete, git clean, git rm) come from the
// command class tables (tables/classes.mjs, extraOps).
//
//   opsOf(argv) -> {path: string|UNKNOWN, op: 'delete'|'move'|'chmod'|'link'}[]
//
// `path` is the argv word as written (the caller resolves it from the command's cwd).
//
// - rm, rmdir, unlink, shred, srm, trash, trash-put, rip: every operand is a delete.
// - mv: every operand (sources and destination, including `-t DIR`) is a move.
// - chmod, chown, chgrp, chattr, chflags, setfacl with -R/--recursive (any option cluster containing
//   R, including a chmod mode cluster such as -Rw): every operand after the mode/owner (all of them
//   with --reference) is a chmod.
// - ln: every operand (targets and the link name, including `-t DIR`) is a link.
//
// Option parsing is the union of GNU and BSD and errs toward more operands: options are read
// anywhere before `--` (GNU), and a dash word that follows an operand (BSD stops option parsing
// there) or that cannot be an option cluster (`-/../x`) counts as an operand too. An UNKNOWN word
// is an operand (it may be a path), and so is a word after an UNKNOWN one where an option value
// could have been expected.

import { UNKNOWN } from './unknown.mjs';
import { extraOps } from '../tables/classes.mjs';

const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put', 'rip']);
const PERM = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'chflags', 'setfacl']);
// Tools whose first operand is a mode (`-x`, `+i`, `u+x`): a dash word that is not an option cluster is one.
const MODE_FIRST = new Set(['chmod', 'chattr', 'chflags', 'setfacl']);

// Short option letters that take a value (the value is the rest of the cluster or the next word).
const SHORT_VALUE = { shred: 'ns', mv: 'tS', ln: 'tS' };
// Long options that take a value (`--opt=v` or `--opt v`).
const LONG_VALUE = {
  shred: ['--iterations', '--size', '--random-source'],
  mv: ['--target-directory', '--suffix'],
  ln: ['--target-directory', '--suffix'],
  chmod: ['--reference'],
  chown: ['--reference', '--from'],
  chgrp: ['--reference'],
};
// Options of chmod/chown/chgrp; any other dash word given to chmod is a mode (`-x`, `-rwx`).
const PERM_LETTERS = new Set(['R', 'c', 'f', 'v', 'H', 'L', 'P', 'h']);
const TARGET_DIR_LETTER = 't';
const TARGET_DIR_LONG = '--target-directory';

const isOptionCluster = (w) => /^-[A-Za-z0-9]+$/.test(w);

function programOf(word) {
  if (typeof word !== 'string') return null;
  const i = word.lastIndexOf('/');
  return word.slice(i + 1);
}

// The operands and options of argv for one program.
function parse(argv, prog) {
  const operands = [];
  const flags = new Set();
  const shortValue = SHORT_VALUE[prog] || '';
  const longValue = LONG_VALUE[prog] || [];
  let endOpts = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === UNKNOWN || typeof a !== 'string') {
      operands.push(UNKNOWN);
      continue;
    }
    if (endOpts || a === '-' || !a.startsWith('-')) {
      operands.push(a);
      continue;
    }
    if (a === '--') {
      endOpts = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      flags.add(name);
      if (longValue.includes(name)) {
        const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
        if (name === TARGET_DIR_LONG && value !== undefined) operands.push(value);
      }
      continue;
    }
    if (MODE_FIRST.has(prog) && [...a.slice(1)].some((c) => !PERM_LETTERS.has(c))) {
      // a mode such as -x; a cluster such as -Rw is also recursive
      if (a.includes('R')) flags.add('R');
      operands.push(a);
      continue;
    }
    // a dash word after an operand is a file to BSD tools; one that is not a cluster is never an option
    if (operands.length > 0 || !isOptionCluster(a)) operands.push(a);
    if (!isOptionCluster(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      flags.add(c);
      if (shortValue.includes(c)) {
        const value = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
        if (c === TARGET_DIR_LETTER && value !== undefined) operands.push(value);
        break;
      }
    }
  }
  return { operands, flags };
}

/**
 * The ancestor operations a command performs on the paths it names.
 * @param {(string|typeof UNKNOWN)[]} argv
 * @returns {{path:string|typeof UNKNOWN, op:'delete'|'move'|'chmod'|'link'}[]}
 */
export function opsOf(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const prog = programOf(argv[0]);
  if (prog === null) return [];
  if (DELETE.has(prog)) return parse(argv, prog).operands.map((p) => ({ path: p, op: 'delete' }));
  if (prog === 'mv') return parse(argv, prog).operands.map((p) => ({ path: p, op: 'move' }));
  if (prog === 'ln') return parse(argv, prog).operands.map((p) => ({ path: p, op: 'link' }));
  if (PERM.has(prog)) {
    const { operands, flags } = parse(argv, prog);
    if (!flags.has('R') && !flags.has('--recursive')) return [];
    const files = flags.has('--reference') ? operands : operands.slice(1);
    return files.map((p) => ({ path: p, op: 'chmod' }));
  }
  return extraOps(argv);
}
