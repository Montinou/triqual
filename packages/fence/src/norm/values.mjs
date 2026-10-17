// Shell value tracking for the normalizer: which string a parsed Word stands
// for, given the literal assignments made earlier in the same command.
//
// A value is a string when bash and zsh (the host shell) would both produce
// exactly that one word, and UNKNOWN otherwise. UNKNOWN is never a guess
// gone wrong: it is the answer for command substitution output, arithmetic,
// `read`, host environment variables, special and positional parameters, glob
// words (use forValues for a loop list), `~user`, and every case where the two
// shells disagree (word splitting, globbing of an expanded value, tilde after
// `:` in an assignment, zsh `=cmd` in an assignment value).
//
// Side effects: `${X:=w}` assigns in env as the shell would; expansions that
// are not evaluated (after a part that is UNKNOWN, or arithmetic, which is
// never evaluated) set every name they could assign to UNKNOWN, or poison env.
//
// Everything here is pure (apart from the injected ctx.expandGlob), linear in
// the input, bounded in recursion by the parser's nesting limit, and never
// throws: anything unexpected is UNKNOWN (or, for applySimple, a poisoned env).
//
// Obligations of the caller (the walker):
// - `Env.get` returns null for a variable known to be unset (it expands to
//   nothing), UNKNOWN for an untracked or unknown one; only a string is a value.
// - ctx.cwd is the current directory: after a `cd` the caller updates it
//   (applySimple only forgets a tracked PWD/OLDPWD), and `$PWD` follows it.
// - Subshells, `$( … )`, and pipeline members run on `env.clone()`; zsh runs
//   the last pipeline member in the current shell and bash does not, so names
//   it assigns become UNKNOWN in the parent.
// - Loops: walking each iteration on a clone of the pre-loop env is NOT sound
//   (iteration 2 sees what iteration 1 assigned: `X=echo; for i in 1 2; do
//   $X -rf ~/.codex; X=rm; done` runs rm). The walker (normalize.mjs) uses
//   scan-and-forget instead: every name the body (or a while condition) may
//   assign, found by a syntactic scan, is made UNKNOWN at the start of every
//   iteration and after the loop; forValues values are unrolled with the loop
//   variable set per iteration, and afterwards the variable keeps its last
//   value only when the body can neither assign it nor break. Names assigned
//   in any branch of if/case, or on the right of && / ||, become UNKNOWN in the
//   parent.
// - Prefix assignments (`X=v cmd`) do not change env; their values, for the
//   command's own environment, come from resolveWord on the assignment Word.

import { UNKNOWN } from './unknown.mjs';
import { literalText, literalValue } from './parser.mjs';
import { isName } from './tokenize.mjs';

/** Longest value tracked; a longer one is UNKNOWN (keeps `X=$X$X` repeated linear). */
export const MAX_VALUE = 4096;
/** Most loop iterations (and glob matches per word) that forValues unrolls. */
export const MAX_UNROLL = 1000;
// Recursion guard for `${X:-${Y:-…}}`; the parser's own depth limit is lower.
const MAX_NEST = 80;

const DEFAULT_IFS = ' \t\n';
const ASSIGN_LIKE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

// Special builtins: a prefix assignment before one may persist (bash POSIX
// mode) or not (bash default, zsh), so the assigned names become UNKNOWN.
const SPECIAL_BUILTINS = new Set([
  ':', '.', 'break', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly',
  'return', 'set', 'shift', 'times', 'trap', 'unset', 'source',
]);

// Commands that can change any variable, or how every later expansion
// behaves: after one of them nothing is known.
export const POISON_COMMANDS = new Set([
  'eval', 'source', '.', 'let', 'setopt', 'unsetopt', 'emulate', 'shopt', 'enable', 'disable',
  'command', 'builtin', 'noglob', 'trap', 'alias', 'unalias', 'zmodload', 'autoload', 'vared',
  'zparseopts', 'fc', 'r', 'getln', 'sched', 'integer', 'float', 'functions',
]);

export const DECLARE_COMMANDS = new Set(['export', 'readonly', 'declare', 'typeset', 'local']);
// Declaration flags that keep plain string semantics; any other (-i, -n, -l,
// -u, -a, -A, -T, …) changes what an assignment stores.
const DECLARE_FLAGS = new Set(['x', 'r', 'g', 'p']);

const SET_FLAGS = new Set(['e', 'u', 'x', 'v', 'o']);
const SET_OPTIONS = new Set(['errexit', 'nounset', 'pipefail', 'xtrace', 'verbose']);

/**
 * Shell variables known so far in one command. A tracked value is a string,
 * `null` (known to be unset) or UNKNOWN; an untracked name is UNKNOWN (it may
 * come from the host environment). A poisoned env answers UNKNOWN for every
 * name, for good.
 */
export class Env {
  constructor() {
    /** @type {Map<string, string|null|typeof UNKNOWN>} */
    this.vars = new Map();
    /** names whose later assignments are not trusted (readonly) */
    this.pinned = new Set();
    this.poisoned = false;
  }

  /** True when the name has a tracked value (string, null or UNKNOWN). */
  has(name) {
    return !this.poisoned && this.vars.has(name);
  }

  /** @returns {string|null|typeof UNKNOWN} null means known to be unset */
  get(name) {
    if (this.poisoned) return UNKNOWN;
    const v = this.vars.get(name);
    return v === undefined ? UNKNOWN : v;
  }

  /** @param {string} name @param {string|typeof UNKNOWN} value */
  set(name, value) {
    if (typeof name !== 'string') return;
    let v = value;
    if (v !== UNKNOWN && (typeof v !== 'string' || v.length > MAX_VALUE)) v = UNKNOWN;
    if (this.pinned.has(name)) v = UNKNOWN;
    this.vars.set(name, v);
  }

  /** `unset NAME`: the variable expands to nothing. */
  unset(name) {
    if (typeof name !== 'string') return;
    this.vars.set(name, this.pinned.has(name) ? UNKNOWN : null);
  }

  /** Drop tracking: the name falls back to the host value (UNKNOWN, or ctx for HOME/PWD). */
  forget(name) {
    this.vars.delete(name);
  }

  /** Later assignments to the name store UNKNOWN. */
  pin(name) {
    this.pinned.add(name);
  }

  /** Every name is UNKNOWN from now on. */
  poison() {
    this.poisoned = true;
  }

  clone() {
    const e = new Env();
    e.vars = new Map(this.vars);
    e.pinned = new Set(this.pinned);
    e.poisoned = this.poisoned;
    return e;
  }
}

function ctxString(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_VALUE ? s : UNKNOWN;
}

// The value of a parameter before any `${…}` operator.
function lookup(name, st) {
  const { env, ctx } = st;
  if (env.poisoned) return UNKNOWN;
  if (typeof name !== 'string' || !isName(name)) return UNKNOWN; // special and positional
  if (env.vars.has(name)) return env.vars.get(name);
  if (name === 'HOME') return ctxString(ctx.home);
  if (name === 'PWD') return ctxString(ctx.cwd);
  return UNKNOWN;
}

function ifsOf(env) {
  if (env.poisoned) return UNKNOWN;
  if (!env.vars.has('IFS')) return DEFAULT_IFS;
  const v = env.vars.get('IFS');
  return v === null ? DEFAULT_IFS : v;
}

// Would bash split this unquoted value (zsh never does by default)?
function splits(v, ifs) {
  if (v === '') return false;
  if (ifs === UNKNOWN) return true;
  if (ifs === '') return false;
  const set = ifs.length > 3 ? new Set(ifs) : null;
  for (let i = 0; i < v.length; i++) {
    if (set ? set.has(v[i]) : ifs.includes(v[i])) return true;
  }
  return false;
}

// Would bash glob this unquoted value (zsh does not without GLOB_SUBST)?
function mayGlob(v) {
  return v.includes('*') || v.includes('?') || v.includes('[');
}

// ---------------------------------------------------------------------------
// Side effects of parts that are not evaluated
//
// When a word's evaluation stops early (a part is UNKNOWN), or a part is
// never evaluated (arithmetic), the shell still runs the remaining
// expansions. Their only effects on shell variables are `${X:=w}` / `${X=w}`
// and arithmetic assignment, so every name those could assign becomes
// UNKNOWN; when the scan cannot be precise the env is poisoned.

const NUMERIC = /^[0-9]+$/;

function isNameStartChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isNameCharAt(c) {
  return isNameStartChar(c) || (c >= '0' && c <= '9');
}

// Does arithmetic text contain an assignment operator (`=` `op=` `++` `--`)?
// `==` `!=` `<=` `>=` are comparisons; `<<=` `>>=` are assignments.
function arithAssigns(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ((c === '+' || c === '-') && text[i + 1] === c) return true;
    if (c !== '=') continue;
    if (text[i + 1] === '=') {
      i++; // `==`
      continue;
    }
    const prev = text[i - 1];
    if (prev === '!') continue;
    if ((prev === '<' || prev === '>') && text[i - 2] !== prev) continue;
    return true;
  }
  return false;
}

// The effect of arithmetic text, which is never evaluated: with an
// assignment operator every name in it becomes UNKNOWN; a name whose value is
// not a plain number is itself evaluated as an expression (it may assign
// anything), and so is `$1`, `${…}`: the env is poisoned.
function arithEffects(text, st) {
  if (!st.mutate) return;
  const env = st.env;
  if (typeof text !== 'string') return env.poison();
  const names = [];
  let poison = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '$') {
      const n = text[i + 1];
      if (n === undefined || !isNameStartChar(n)) poison = true; // $1 $@ ${…} $(…)
      i++;
    } else if (isNameStartChar(c)) {
      let j = i + 1;
      while (j < text.length && isNameCharAt(text[j])) j++;
      names.push(text.slice(i, j));
      i = j;
    } else if (c >= '0' && c <= '9') {
      // a number, including 0x1f and 16#ff
      let j = i + 1;
      while (j < text.length && (isNameCharAt(text[j]) || text[j] === '#' || text[j] === '@')) j++;
      i = j;
    } else {
      i++;
    }
  }
  for (const name of names) {
    const v = lookup(name, st);
    if (v === UNKNOWN || (v !== null && v !== '' && !NUMERIC.test(v))) poison = true;
  }
  if (poison) return env.poison();
  if (arithAssigns(text)) for (const name of names) env.set(name, UNKNOWN);
  return undefined;
}

// Apply the possible effects of parts that were not evaluated.
function scanEffects(parts, st, depth) {
  if (!st.mutate) return;
  if (depth > MAX_NEST || !Array.isArray(parts)) return st.env.poison();
  for (const p of parts) {
    if (!p || typeof p !== 'object') return st.env.poison();
    if (p.type === 'var') {
      if ((p.op === '=' || p.op === ':=') && typeof p.name === 'string' && isName(p.name)) {
        st.env.set(p.name, UNKNOWN);
      }
      if (p.arg !== undefined) {
        if (!p.arg || !Array.isArray(p.arg.parts)) return st.env.poison();
        scanEffects(p.arg.parts, st, depth + 1);
      }
    } else if (p.type === 'arith') {
      arithEffects(p.text, st);
    } else if (p.type !== 'lit' && p.type !== 'glob' && p.type !== 'cmdsub') {
      // a command substitution runs in a subshell: no effect on this env
      return st.env.poison();
    }
  }
  return undefined;
}

// Stop at parts[i] (already handled): apply the effects of the rest.
function cut(parts, i, st, depth) {
  scanEffects(parts.slice(i + 1), st, depth);
  return UNKNOWN;
}

// Expand a part list. splitCheck: an unquoted expansion must not split or
// glob (an argument word). globLiteral: glob parts are plain text (an
// assignment value). Returns {text, quoted} or UNKNOWN; `quoted` is true when
// any quoted part was present (the word is never elided). Whatever is not
// evaluated has its possible assignments applied (scanEffects).
function expandParts(parts, st, splitCheck, globLiteral, depth) {
  if (!Array.isArray(parts)) return UNKNOWN;
  if (depth > MAX_NEST) {
    if (st.mutate) st.env.poison();
    return UNKNOWN;
  }
  let text = '';
  let quoted = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || typeof p !== 'object') {
      if (st.mutate) st.env.poison();
      return UNKNOWN;
    }
    let piece;
    if (p.type === 'lit') {
      if (typeof p.text !== 'string') return cut(parts, i, st, depth);
      piece = p.text;
      if (p.quoted) quoted = true;
    } else if (p.type === 'glob') {
      if (!globLiteral || typeof p.text !== 'string') return cut(parts, i, st, depth);
      piece = p.text;
    } else if (p.type === 'var') {
      const v = varValue(p, st, globLiteral, depth);
      if (v === UNKNOWN) return cut(parts, i, st, depth);
      if (p.quoted) quoted = true;
      else if (splitCheck && (mayGlob(v) || splits(v, ifsOf(st.env)))) return cut(parts, i, st, depth);
      piece = v;
    } else {
      // cmdsub (its output), arith (never evaluated: a name in it can run code), anything else
      return cut(parts, i - 1, st, depth);
    }
    text += piece;
    if (text.length > MAX_VALUE) return cut(parts, i, st, depth);
  }
  return { text, quoted };
}

// The word of `${X<op>word}`. A `~` in it is UNKNOWN (whether it expands
// depends on the shell and the quoting).
function argValue(arg, st, globLiteral, depth) {
  if (!arg || !Array.isArray(arg.parts)) {
    if (st.mutate) st.env.poison();
    return UNKNOWN;
  }
  for (const p of arg.parts) {
    if (p && p.type === 'lit' && typeof p.text === 'string' && p.text.includes('~')) {
      scanEffects(arg.parts, st, depth + 1);
      return UNKNOWN;
    }
  }
  const r = expandParts(arg.parts, st, false, globLiteral, depth + 1);
  return r === UNKNOWN ? UNKNOWN : r.text;
}

// The expansion of one Var part (before splitting).
function varValue(p, st, globLiteral, depth) {
  const v = lookup(p.name, st);
  const op = p.op;
  if (op === undefined) return v === null ? '' : v;
  if (v === UNKNOWN || typeof op !== 'string' || op.length === 0) {
    // set or not, the argument may be expanded (and may assign)
    scanEffects([p], st, depth);
    return UNKNOWN;
  }
  const colon = op[0] === ':';
  const kind = colon ? op[1] : op[0];
  const isSet = v !== null && (!colon || v !== '');
  switch (kind) {
    case '-':
      return isSet ? v : argValue(p.arg, st, globLiteral, depth);
    case '=': {
      if (isSet) return v;
      const r = argValue(p.arg, st, globLiteral, depth);
      if (st.mutate) st.env.set(p.name, r);
      return r;
    }
    case '+':
      return isSet ? argValue(p.arg, st, globLiteral, depth) : '';
    case '?':
      return isSet ? v : UNKNOWN; // unset: the shell aborts the command
    default:
      scanEffects([p], st, depth);
      return UNKNOWN;
  }
}

// A word starting with an unquoted `~`: the parts with the tilde prefix
// replaced by $HOME (as a quoted literal: it is never split, globbed or
// elided), null when there is no tilde prefix, UNKNOWN for `~user`, `~+`,
// `~-`, a partly quoted prefix, or an unknown HOME.
function tildeParts(parts, st) {
  const first = parts[0];
  if (!first || first.type !== 'lit' || first.quoted || typeof first.text !== 'string') return null;
  const t = first.text;
  if (!t.startsWith('~')) return null;
  if (t === '~') {
    if (parts.length !== 1) return UNKNOWN;
  } else if (t[1] !== '/') {
    return UNKNOWN;
  }
  const home = lookup('HOME', st);
  if (typeof home !== 'string' || home === '') return UNKNOWN;
  return [{ type: 'lit', text: home + t.slice(1), quoted: true }, ...parts.slice(1)];
}

// An unquoted `~` after `:` or `=` in an assignment (or an assignment-like
// argument): whether it expands differs between the shells and their modes.
function tildeAfterSeparator(parts) {
  let prev = '';
  for (const p of parts) {
    if (!p || p.type !== 'lit' || typeof p.text !== 'string') {
      prev = '';
      continue;
    }
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text[i];
      if (!p.quoted && c === '~' && (prev === ':' || prev === '=')) return true;
      prev = c;
    }
  }
  return false;
}

// zsh treats the value of any assignment like PATH: an unquoted `=` at the
// value start or after `:` starts `=cmd` expansion.
function zshEquals(parts) {
  let prev = ':';
  for (const p of parts) {
    if (!p || p.type !== 'lit' || typeof p.text !== 'string') {
      prev = '';
      continue;
    }
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text[i];
      if (!p.quoted && c === '=' && prev === ':') return true;
      prev = c;
    }
  }
  return false;
}

function isAssignLike(parts) {
  const f = parts[0];
  return !!f && f.type === 'lit' && !f.quoted && typeof f.text === 'string' && ASSIGN_LIKE.test(f.text);
}

function resolveIn(word, st) {
  if (!word || typeof word !== 'object' || !Array.isArray(word.parts)) return UNKNOWN;
  const assign = word.assign === true;
  let parts = word.parts;
  const t = tildeParts(parts, st);
  if (t === UNKNOWN) return cut(parts, -1, st, 0);
  if (t) parts = t;
  if ((assign || isAssignLike(parts)) && tildeAfterSeparator(parts)) return cut(parts, -1, st, 0);
  const r = expandParts(parts, st, !assign, assign, 0);
  if (r === UNKNOWN) return UNKNOWN;
  if (assign && zshEquals(parts)) return UNKNOWN;
  // an unquoted word that expands to nothing is removed from the command
  if (!assign && r.text === '' && !r.quoted) return UNKNOWN;
  return r.text;
}

function makeState(env, ctx, mutate) {
  return { env, ctx: ctx && typeof ctx === 'object' ? ctx : {}, mutate };
}

/**
 * The single string a word expands to, or UNKNOWN. An assignment value
 * (`word.assign`: bare and prefix assignments, declaration arguments) is not
 * split, globbed or elided, and is UNKNOWN when zsh would apply `=cmd`
 * expansion to it. `${X:=v}` assigns X in env, as the shell would; parts that
 * are not evaluated (after an UNKNOWN part, arithmetic) set every name they
 * could assign to UNKNOWN. Works on any Word, including heredoc and
 * herestring parts.
 * @param {import('./parser.mjs').Word} word
 * @param {Env} env
 * @param {{home?:string, cwd?:string}} ctx
 * @returns {string|typeof UNKNOWN}
 */
export function resolveWord(word, env, ctx) {
  try {
    if (!(env instanceof Env)) return UNKNOWN;
    return resolveIn(word, makeState(env, ctx, true));
  } catch {
    if (env instanceof Env) env.poison();
    return UNKNOWN;
  }
}

/**
 * True when an unquoted expansion in the word may expand to other than one
 * word: its value contains an IFS character (bash splits, zsh does not), a
 * glob character `*` `?` `[` (bash globs it, zsh does not), or is UNKNOWN. In
 * command position the caller makes that opaque; resolveWord already returns
 * UNKNOWN for such a word. Literal glob parts (`*.txt`) are not reported:
 * they are the caller's glob expansion. Pass ctx so `$HOME`/`$PWD` are
 * known; never mutates env.
 * @param {import('./parser.mjs').Word} word
 * @param {Env} env
 * @param {{home?:string, cwd?:string}} [ctx]
 * @returns {boolean}
 */
export function splitsOnWhitespace(word, env, ctx) {
  try {
    if (!(env instanceof Env) || !word || !Array.isArray(word.parts)) return true;
    if (word.assign === true) return false;
    const st = makeState(env, ctx, false);
    const ifs = ifsOf(env);
    for (const p of word.parts) {
      if (!p || typeof p !== 'object') return true;
      if (p.type === 'lit' || p.type === 'glob' || p.quoted) continue;
      if (p.type !== 'var') return true; // unquoted cmdsub / arith: unknown output
      const v = varValue(p, st, false, 0);
      if (v === UNKNOWN || splits(v, ifs) || mayGlob(v)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Commands that change variables

// The option words at the start of argv[1…]: {letters, next} or null when an
// option word is not literal. `--` ends the options.
function readOptions(words) {
  const letters = [];
  let i = 1;
  for (; i < words.length; i++) {
    const lt = literalText(words[i]);
    if (lt === null) {
      const f = words[i].parts[0];
      if (f && f.type === 'lit' && (f.text.startsWith('-') || f.text.startsWith('+'))) return null;
      break;
    }
    if (lt === '--') {
      i++;
      break;
    }
    if (lt.length < 2 || (lt[0] !== '-' && lt[0] !== '+')) break;
    for (let k = 1; k < lt.length; k++) letters.push(lt[k]);
  }
  return { letters, next: i };
}

// `NAME=value` as an argument word: {name, value:Word} or null.
function assignArg(word) {
  const ps = word.parts;
  const f = ps[0];
  if (!f || f.type !== 'lit' || f.quoted || typeof f.text !== 'string') return null;
  const eq = f.text.indexOf('=');
  if (eq <= 0) return null;
  const rest = f.text.slice(eq + 1);
  const parts = rest ? [{ type: 'lit', text: rest, quoted: false }, ...ps.slice(1)] : ps.slice(1);
  return { name: f.text.slice(0, eq), value: { parts, assign: true } };
}

// The command word is a plain unquoted literal: only then do the shells
// parse `NAME=value` arguments of a declaration builtin as assignments (zsh
// runs `\export` as a plain builtin, with no assignment-style expansion).
function isPlainCommandWord(word) {
  const ps = word && word.parts;
  return Array.isArray(ps) && ps.length === 1 && ps[0].type === 'lit' && !ps[0].quoted;
}

function applyDeclare(cmd, words, env, ctx) {
  const opts = readOptions(words);
  if (!opts || opts.letters.some((l) => !DECLARE_FLAGS.has(l))) return env.poison();
  const readonly = cmd === 'readonly' || opts.letters.includes('r');
  const plain = isPlainCommandWord(words[0]);
  for (let i = opts.next; i < words.length; i++) {
    const w = words[i];
    const a = assignArg(w);
    if (a) {
      let name = a.name;
      // always expanded: `${Y:=v}` in the value assigns Y whatever happens to NAME
      let value = resolveWord(a.value, env, ctx);
      if (name.endsWith('+') && isName(name.slice(0, -1))) {
        name = name.slice(0, -1); // NAME+=value appends
        value = UNKNOWN;
      } else if (!isName(name)) {
        return env.poison();
      } else if (cmd === 'local' || !plain) {
        value = UNKNOWN;
      }
      env.set(name, value);
      if (readonly) env.pin(name);
      continue;
    }
    const name = literalValue(w);
    if (name === null || !isName(name)) return env.poison();
    // export/readonly NAME keep the value; typeset/declare/local NAME differ between shells
    if (cmd !== 'export' && cmd !== 'readonly') env.set(name, UNKNOWN);
    if (readonly) env.pin(name);
  }
  return undefined;
}

function applyUnset(words, env) {
  const opts = readOptions(words);
  if (!opts) return env.poison();
  if (opts.letters.includes('f') && opts.letters.every((l) => l === 'f')) return undefined; // functions only
  if (opts.letters.some((l) => l !== 'v')) return env.poison();
  for (let i = opts.next; i < words.length; i++) {
    const name = literalValue(words[i]);
    if (name === null || !isName(name)) return env.poison();
    env.unset(name);
  }
  return undefined;
}

// read, getopts, mapfile: every name-like argument (and the implicit ones)
// gets an UNKNOWN value. zsh `read 'X?prompt'` names X.
function applyReadLike(words, env, implicit) {
  for (const n of implicit) env.set(n, UNKNOWN);
  for (let i = 1; i < words.length; i++) {
    const lt = literalText(words[i]);
    if (lt === null) return env.poison();
    const m = NAME_PREFIX.exec(lt);
    if (m) env.set(m[0], UNKNOWN);
  }
  return undefined;
}

function applySet(words, env) {
  let options = true;
  for (let i = 1; i < words.length; i++) {
    const lt = literalText(words[i]);
    if (lt === null) return env.poison();
    if (!options) continue; // positional parameters
    if (lt === '--' || lt === '-' || lt.length < 2 || (lt[0] !== '-' && lt[0] !== '+')) {
      options = false;
      continue;
    }
    for (let k = 1; k < lt.length; k++) {
      if (!SET_FLAGS.has(lt[k])) return env.poison();
      if (lt[k] === 'o') {
        const name = i + 1 < words.length ? literalText(words[i + 1]) : null;
        if (name === null) {
          if (i + 1 < words.length) return env.poison();
          continue; // `set -o` lists the options
        }
        if (!SET_OPTIONS.has(name)) return env.poison();
        i++;
      }
    }
  }
  return undefined;
}

// An option cluster before the first operand that contains the letter.
function hasOption(words, letter) {
  for (let i = 1; i < words.length; i++) {
    const lt = literalText(words[i]);
    if (lt === null) return true;
    if (lt === '--' || lt.length < 2 || lt[0] !== '-') return false;
    if (lt.includes(letter)) return true;
  }
  return false;
}

/**
 * Apply one simple command's effect on shell variables to env (mutating it):
 * bare assignments, `export`/`readonly`/`declare`/`typeset`/`local`,
 * `unset`, `read`/`getopts`/`mapfile`, `cd` (forgets PWD; the caller tracks
 * ctx.cwd), `${X:=v}` in any word, and poisoning for commands that can change
 * anything (`eval`, `source`, `setopt`, an UNKNOWN command name, …). A
 * prefix assignment (`X=1 cmd`) applies to that command only and leaves env
 * unchanged. The caller applies subshells, pipeline members and command
 * substitutions to clones. Never throws: an internal error poisons env.
 * @param {import('./parser.mjs').SimpleNode} node
 * @param {Env} env
 * @param {{home?:string, cwd?:string}} ctx
 */
export function applySimple(node, env, ctx) {
  if (!(env instanceof Env)) return;
  try {
    if (!node || node.type !== 'simple') return;
    const assigns = node.assigns || [];
    const words = node.words || [];
    const redirs = node.redirs || [];
    if (words.length === 0) {
      for (const a of assigns) env.set(a.name, resolveWord(a.value, env, ctx));
      for (const r of redirs) if (r && r.target) resolveWord(r.target, env, ctx);
      return;
    }
    // words are expanded first, then redirections, then assignment values
    const argv = words.map((w) => resolveWord(w, env, ctx));
    for (const r of redirs) if (r && r.target) resolveWord(r.target, env, ctx);
    for (const a of assigns) resolveWord(a.value, env, ctx);
    const cmd = argv[0];
    if (cmd === UNKNOWN) {
      env.poison();
      return;
    }
    if (assigns.length > 0 && SPECIAL_BUILTINS.has(cmd)) for (const a of assigns) env.set(a.name, UNKNOWN);
    if (POISON_COMMANDS.has(cmd)) return env.poison();
    if (DECLARE_COMMANDS.has(cmd)) return applyDeclare(cmd, words, env, ctx);
    switch (cmd) {
      case 'unset':
        return applyUnset(words, env);
      case 'read':
        return applyReadLike(words, env, ['REPLY']);
      case 'getopts':
        return applyReadLike(words, env, ['OPTARG', 'OPTIND']);
      case 'mapfile':
      case 'readarray':
        return applyReadLike(words, env, ['MAPFILE']);
      case 'set':
        return applySet(words, env);
      case 'cd':
      case 'pushd':
      case 'popd':
        env.forget('PWD');
        env.forget('OLDPWD');
        return undefined;
      case 'printf':
      case 'print':
        if (hasOption(words, 'v')) env.poison();
        return undefined;
      case 'wait':
        if (hasOption(words, 'p')) env.poison();
        return undefined;
      default:
        return undefined;
    }
  } catch {
    env.poison();
  }
}

// ---------------------------------------------------------------------------
// for loops

function escapeGlob(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' || c === '*' || c === '?' || c === '[' || c === ']') out += '\\';
    out += c;
  }
  return out;
}

// The glob pattern of a word with unquoted glob parts: active glob
// characters raw, every literal character that is glob-special escaped with
// a backslash. UNKNOWN when any part is not known.
function globPattern(word, st) {
  let parts = word.parts;
  const t = tildeParts(parts, st);
  if (t === UNKNOWN) return cut(parts, -1, st, 0);
  if (t) parts = t;
  if (isAssignLike(parts) && tildeAfterSeparator(parts)) return cut(parts, -1, st, 0);
  let pat = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || typeof p !== 'object') return cut(parts, i, st, 0);
    if (p.type === 'lit' && typeof p.text === 'string') pat += escapeGlob(p.text);
    else if (p.type === 'glob' && typeof p.text === 'string') pat += p.text;
    else if (p.type === 'var') {
      const v = varValue(p, st, false, 0);
      if (v === UNKNOWN) return cut(parts, i, st, 0);
      if (!p.quoted && (mayGlob(v) || splits(v, ifsOf(st.env)))) return cut(parts, i, st, 0);
      pat += escapeGlob(v);
    } else return cut(parts, i - 1, st, 0);
    if (pat.length > MAX_VALUE) return cut(parts, i, st, 0);
  }
  return pat;
}

function listWordValues(word, st) {
  if (!word || !Array.isArray(word.parts)) return UNKNOWN;
  if (!word.parts.some((p) => p && p.type === 'glob')) {
    const v = resolveIn(word, st);
    return v === UNKNOWN ? UNKNOWN : [v];
  }
  const pattern = globPattern(word, st);
  if (pattern === UNKNOWN) return UNKNOWN;
  const { expandGlob, cwd } = st.ctx;
  if (typeof expandGlob !== 'function' || typeof cwd !== 'string') return UNKNOWN;
  const matches = expandGlob(pattern, cwd);
  // no match: bash keeps the pattern, zsh aborts the command
  if (!Array.isArray(matches) || matches.length === 0 || matches.length > MAX_UNROLL) return UNKNOWN;
  if (matches.some((m) => typeof m !== 'string')) return UNKNOWN;
  return matches;
}

/**
 * The values a `for` loop variable takes, in order, or UNKNOWN. Literal and
 * tracked words resolve; a word with unquoted glob characters is expanded by
 * ctx.expandGlob(pattern, ctx.cwd) → string[] | UNKNOWN, where the pattern
 * escapes literal glob characters with a backslash. More than MAX_UNROLL
 * values, a glob with no match, `for x; do` (positional parameters) and any
 * UNKNOWN item make the whole list UNKNOWN.
 * @param {import('./parser.mjs').ForNode} node
 * @param {Env} env
 * @param {{home?:string, cwd?:string, expandGlob?:(pattern:string, cwd:string)=>string[]|typeof UNKNOWN}} ctx
 * @returns {string[]|typeof UNKNOWN}
 */
export function forValues(node, env, ctx) {
  try {
    if (!(env instanceof Env) || !node || node.type !== 'for' || !Array.isArray(node.items)) return UNKNOWN;
    const st = makeState(env, ctx, true);
    const out = [];
    const items = node.items;
    for (let k = 0; k < items.length; k++) {
      const vals = listWordValues(items[k], st);
      if (vals !== UNKNOWN) for (const v of vals) out.push(v);
      if (vals === UNKNOWN || out.length > MAX_UNROLL) {
        // the shell still expands the remaining items
        for (let r = k + 1; r < items.length; r++) {
          const w = items[r];
          if (!w || !Array.isArray(w.parts)) env.poison();
          else scanEffects(w.parts, st, 0);
        }
        return UNKNOWN;
      }
    }
    return out;
  } catch {
    if (env instanceof Env) env.poison();
    return UNKNOWN;
  }
}
