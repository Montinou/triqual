import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShell } from '../src/norm/parser.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { Env, resolveWord, splitsOnWhitespace, applySimple, forValues, MAX_UNROLL } from '../src/norm/values.mjs';

// Fixed, fake context: never the real home directory.
const ctx = { home: '/home/tester', cwd: '/work/repo' };

// The top-level nodes of a program that must parse.
function nodes(text) {
  const r = parseShell(text);
  assert.equal(r.opaque, undefined, `unexpected opaque for ${JSON.stringify(text)}: ${JSON.stringify(r.opaque)}`);
  return r.items.map((i) => i.node);
}

// Apply every simple command but the last to a fresh env, then resolve each
// word of the last one.
function run(text, c = ctx, env = new Env()) {
  const ns = nodes(text);
  for (const n of ns.slice(0, -1)) applySimple(n, env, c);
  const last = ns[ns.length - 1];
  return { env, words: last.words.map((w) => resolveWord(w, env, c)), node: last };
}

function words(text, c) {
  return run(text, c).words;
}

test('X=rm; $X resolves to rm', () => {
  assert.deepEqual(words('X=rm; $X -rf build'), ['rm', '-rf', 'build']);
  assert.deepEqual(words('X=rm; ${X} x'), ['rm', 'x']);
  assert.deepEqual(words('X=rm; "$X"'), ['rm']);
  // assignments in one command run left to right
  assert.deepEqual(words('X=r Y=${X}m; $Y'), ['rm']);
  // quoting and concatenation
  assert.deepEqual(words(`X='a b'; "$X" "pre-$X" pre"$X"post`), ['a b', 'pre-a b', 'prea bpost']);
  // a prefix assignment applies to that command only, and $X in its own
  // words is expanded before it: an untracked X is UNKNOWN
  assert.deepEqual(words('X=rm $X'), [UNKNOWN]);
  assert.deepEqual(words('X=rm true; $X'), [UNKNOWN]);
  // an assignment value is not split or globbed
  assert.deepEqual(words(`X=*; Y=$X; "$Y"`), ['*']);
  // reassignment replaces
  assert.deepEqual(words('X=a; X=b; $X'), ['b']);
});

test('export and unset', () => {
  assert.deepEqual(words('export X=rm; $X'), ['rm']);
  assert.deepEqual(words('export X=rm Y=$X; $Y'), ['rm']);
  // export NAME keeps the value
  assert.deepEqual(words('X=rm; export X; $X'), ['rm']);
  // readonly assigns, and later assignments to it are not trusted
  assert.deepEqual(words('readonly X=rm; $X'), ['rm']);
  assert.deepEqual(words('readonly X=rm; X=ls; $X'), [UNKNOWN]);
  // unset makes it empty: "$X" is '' and an unquoted lone $X is elided (UNKNOWN)
  assert.deepEqual(words('X=rm; unset X; "$X" a$X'), ['', 'a']);
  assert.deepEqual(words('X=rm; unset -v X; $X'), [UNKNOWN]);
  // a value with an unquoted =word start in export is zsh EQUALS expansion
  assert.deepEqual(words('export X==ls; $X'), [UNKNOWN]);
  assert.deepEqual(words('export X=a:=ls; "$X"'), [UNKNOWN]);
  // declaration builtins whose flags change assignment semantics poison every variable
  assert.deepEqual(words('X=rm; declare -i Y=1; $X'), [UNKNOWN]);
  assert.deepEqual(words('X=rm; typeset -n R=X; $X'), [UNKNOWN]);
  // typeset/declare/local NAME without a value differ between shells
  assert.deepEqual(words('X=rm; typeset X; $X'), [UNKNOWN]);
  // local outside a function fails in bash and works in zsh
  assert.deepEqual(words('local X=rm; $X'), [UNKNOWN]);
  // read, getopts, mapfile and eval/source make values UNKNOWN
  assert.deepEqual(words('X=rm; read X; $X'), [UNKNOWN]);
  assert.deepEqual(words('X=rm; read -r Y X; $X'), [UNKNOWN]);
  assert.deepEqual(words("X=rm; read 'X?prompt'; $X"), [UNKNOWN]);
  assert.deepEqual(words('X=rm; eval true; $X'), [UNKNOWN]);
  assert.deepEqual(words('X=rm; source f; $X'), [UNKNOWN]);
  assert.deepEqual(words('X=rm; setopt shwordsplit; $X'), [UNKNOWN]);
  // set -e and friends keep tracking; other set options do not
  assert.deepEqual(words('set -euo pipefail; X=rm; $X'), ['rm']);
  assert.deepEqual(words('X=rm; set -f; $X'), [UNKNOWN]);
  // a prefix assignment before a special builtin may persist (bash POSIX) or not
  assert.deepEqual(words('X=rm; X=ls export Y=1; $X'), [UNKNOWN]);
});

test('${X:-fallback}', () => {
  assert.deepEqual(words('${X:-fallback}'), [UNKNOWN]); // host variable may be set
  assert.deepEqual(words('X=; ${X:-fallback} ${X-other}'), ['fallback', UNKNOWN]);
  assert.deepEqual(words('X=; "${X-other}"'), ['']);
  assert.deepEqual(words('unset X; ${X:-fb} ${X-fb2}'), ['fb', 'fb2']);
  assert.deepEqual(words('X=set; ${X:-fb} ${X:+alt} ${Y:+alt}'), ['set', 'alt', UNKNOWN]);
  assert.deepEqual(words('Y=; X=a; ${Y:+alt}b ${X:?boom}'), ['b', 'a']);
  assert.deepEqual(words('unset X; ${X:?boom}'), [UNKNOWN]);
  // := assigns
  assert.deepEqual(words('unset X; ${X:=rm}; $X'), ['rm']);
  // nested references in the fallback
  assert.deepEqual(words('Y=rm; unset X; ${X:-$Y}'), ['rm']);
  // an unquoted fallback with blanks splits in bash only
  assert.deepEqual(words('unset X; ${X:-a b} "${X:-a b}"'), [UNKNOWN, 'a b']);
  // a fallback with a command substitution is UNKNOWN
  assert.deepEqual(words('unset X; ${X:-$(id)}'), [UNKNOWN]);
});

test('$HOME and ~ resolve from ctx', () => {
  assert.deepEqual(words('$HOME ~ ~/x "$HOME/y" ${HOME}/z $PWD'), [
    '/home/tester',
    '/home/tester',
    '/home/tester/x',
    '/home/tester/y',
    '/home/tester/z',
    '/work/repo',
  ]);
  // quoted tilde is literal
  assert.deepEqual(words(`'~' "~/x"`), ['~', '~/x']);
  // ~user, ~+ and ~- are UNKNOWN
  assert.deepEqual(words('~root ~+ ~-'), [UNKNOWN, UNKNOWN, UNKNOWN]);
  // assignment values: a leading ~ expands; ~ after : differs between shells
  assert.deepEqual(words('X=~/bin; $X'), ['/home/tester/bin']);
  assert.deepEqual(words('X=/a:~/bin; "$X"'), [UNKNOWN]);
  // an assignment-like argument expands ~ in bash only
  assert.deepEqual(words('echo a=~/x'), ['echo', UNKNOWN]);
  // a tracked HOME wins over ctx; no home in ctx is UNKNOWN
  assert.deepEqual(words('HOME=/h; ~/x'), ['/h/x']);
  assert.deepEqual(words('~/x $HOME', { cwd: '/w' }), [UNKNOWN, UNKNOWN]);
  // cd forgets a tracked PWD: $PWD follows ctx.cwd, which the caller updates
  assert.deepEqual(words('PWD=/p; cd sub; $PWD'), ['/work/repo']);
  // HOME with blanks is fine quoted, UNKNOWN unquoted
  assert.deepEqual(words('"$HOME" $HOME', { home: '/h/a b', cwd: '/w' }), ['/h/a b', UNKNOWN]);
});

test('a command substitution is UNKNOWN', () => {
  assert.deepEqual(words('$(echo rm) `echo rm` "$(echo rm)" a$(b)'), [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
  assert.deepEqual(words('X=$(echo rm); $X'), [UNKNOWN]);
  // arithmetic is never evaluated: a name inside it can run code
  assert.deepEqual(words('$((1+2)) "$((x))" X=$((1))'), [UNKNOWN, UNKNOWN, UNKNOWN]);
  assert.deepEqual(words('X=$((1)); $X'), [UNKNOWN]);
  // special and positional parameters
  assert.deepEqual(words('$1 $@ "$*" $$ $? $#'), [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
});

test('an undefined host variable is UNKNOWN', () => {
  assert.deepEqual(words('$EDITOR "$PATH" ${USER}'), [UNKNOWN, UNKNOWN, UNKNOWN]);
  const env = new Env();
  assert.equal(env.get('X'), UNKNOWN);
  env.set('X', 'v');
  assert.equal(env.get('X'), 'v');
  const copy = env.clone();
  copy.set('X', 'w');
  assert.equal(env.get('X'), 'v');
  assert.equal(copy.get('X'), 'w');
  env.set('Y', UNKNOWN);
  assert.equal(env.get('Y'), UNKNOWN);
  env.unset('X');
  assert.equal(env.get('X'), null);
  // a glob word on its own is not a single value
  assert.deepEqual(words('*.txt'), [UNKNOWN]);
  // literal words resolve
  assert.deepEqual(words(`r''m "-rf" \\x`), ['rm', '-rf', 'x']);
  // garbage never throws
  assert.equal(resolveWord(null, env, ctx), UNKNOWN);
  assert.equal(resolveWord({ parts: [{ type: 'bogus' }] }, env, ctx), UNKNOWN);
  assert.equal(splitsOnWhitespace(null, env), true);
});

test('an unquoted value containing whitespace is reported by splitsOnWhitespace', () => {
  const { env, node } = run(`X='rm -rf'; Y=rm; $X "$X" $Y a$Y $(id) $HOME`);
  const [x, qx, y, ay, sub, home] = node.words;
  assert.equal(splitsOnWhitespace(x, env, ctx), true);
  assert.equal(resolveWord(x, env, ctx), UNKNOWN);
  assert.equal(splitsOnWhitespace(qx, env, ctx), false);
  assert.equal(resolveWord(qx, env, ctx), 'rm -rf');
  assert.equal(splitsOnWhitespace(y, env, ctx), false);
  assert.equal(splitsOnWhitespace(ay, env, ctx), false);
  // an unknown unquoted expansion may split
  assert.equal(splitsOnWhitespace(sub, env, ctx), true);
  assert.equal(splitsOnWhitespace(home, env, ctx), false);
  assert.equal(splitsOnWhitespace(home, env, { home: '/a b', cwd: '/' }), true);
  // a custom IFS: its characters split in bash, not in zsh
  const r = run('IFS=/; X=a/b; $X "$X"');
  assert.equal(splitsOnWhitespace(r.node.words[0], r.env, ctx), true);
  assert.deepEqual(r.words, [UNKNOWN, 'a/b']);
  // glob characters in an unquoted value are globbed by bash only
  assert.deepEqual(words(`X='*'; $X "$X"`), [UNKNOWN, '*']);
});

test('for over literal words unrolls, over a glob list unrolls within the caps, over a non-literal list is UNKNOWN', () => {
  const forNode = (text) => {
    const n = nodes(text)[0];
    assert.equal(n.type, 'for');
    return n;
  };
  const env = new Env();
  env.set('D', 'src');
  assert.deepEqual(forValues(forNode('for f in a "b c" $D; do rm $f; done'), env, ctx), ['a', 'b c', 'src']);

  const seen = [];
  const expandGlob = (pattern, cwd) => {
    seen.push([pattern, cwd]);
    if (pattern === 'many/*') return Array.from({ length: MAX_UNROLL + 1 }, (_, i) => `many/${i}`);
    if (pattern === 'unknown/*') return UNKNOWN;
    if (pattern === 'none/*') return [];
    return ['src/a.js', 'src/b.js'];
  };
  const g = { ...ctx, expandGlob };
  assert.deepEqual(forValues(forNode('for f in $D/*.js x; do rm $f; done'), env, g), ['src/a.js', 'src/b.js', 'x']);
  assert.deepEqual(seen[0], ['src/*.js', '/work/repo']);
  // quoted glob characters are escaped in the pattern
  forValues(forNode(`for f in '*'*; do :; done`), env, g);
  assert.deepEqual(seen[1], ['\\**', '/work/repo']);
  // past the cap, an UNKNOWN expansion, no matches, no expander: UNKNOWN
  assert.equal(forValues(forNode('for f in many/*; do :; done'), env, g), UNKNOWN);
  assert.equal(forValues(forNode('for f in unknown/*; do :; done'), env, g), UNKNOWN);
  assert.equal(forValues(forNode('for f in none/*; do :; done'), env, g), UNKNOWN);
  assert.equal(forValues(forNode('for f in *; do :; done'), env, ctx), UNKNOWN);
  // the total number of iterations is capped too
  const many = Array.from({ length: MAX_UNROLL + 1 }, (_, i) => `w${i}`).join(' ');
  assert.equal(forValues(forNode(`for f in ${many}; do :; done`), env, ctx), UNKNOWN);

  // non-literal lists
  assert.equal(forValues(forNode('for f in $(ls); do rm $f; done'), env, ctx), UNKNOWN);
  assert.equal(forValues(forNode('for f in $HOSTVAR; do rm $f; done'), env, ctx), UNKNOWN);
  assert.equal(forValues(forNode('for f; do rm $f; done'), env, ctx), UNKNOWN);
  env.set('L', 'a b');
  assert.equal(forValues(forNode('for f in $L; do rm $f; done'), env, ctx), UNKNOWN);
});

test('values are capped in length so repeated doubling stays linear', () => {
  let text = 'X=aaaaaaaaaaaaaaaa';
  for (let i = 0; i < 400; i++) text += '; X=$X$X';
  const { words: w } = run(`${text}; "$X"`);
  assert.deepEqual(w, [UNKNOWN]);
});

test('assignments in unevaluated parts make their names UNKNOWN', () => {
  // ${X:=…} after a part that is already UNKNOWN
  assert.deepEqual(words('unset X; : "$(true)${X:=r}"; "${X}m" -rf /'), [UNKNOWN, '-rf', '/']);
  assert.deepEqual(words('unset X; : ${HOSTV}${X:=r}; "${X}m" -rf /'), [UNKNOWN, '-rf', '/']);
  assert.deepEqual(words('unset X; : ${HOSTV:-${X:=r}}; "${X}m" -rf /'), [UNKNOWN, '-rf', '/']);
  assert.deepEqual(words('unset X; : ~root${X:=r}; "${X}m"'), [UNKNOWN]);
  assert.deepEqual(words('unset X; : ${HOSTV:+${X=r}}; "${X}m"'), [UNKNOWN]);
  // nested: the := sits inside another unevaluated argument
  assert.deepEqual(words('unset X; : ${HOSTV:-${Y:-${X:=r}}}; "${X}m"'), [UNKNOWN]);
  assert.deepEqual(words('unset X; : $(true)${H:-a${X:=r}}; "${X}m"'), [UNKNOWN]);
  // an UNKNOWN fallback assigns UNKNOWN
  assert.deepEqual(words('unset X; : ${X:=$(id)}; "${X}m"'), [UNKNOWN]);
  // a set variable does not expand its fallback: nothing is assigned
  assert.deepEqual(words('Y=set; X=a; : ${Y:-${X:=r}}; "${X}m"'), ['am']);
  // a later word of a declaration still runs its expansions
  assert.deepEqual(words('unset X; local Z=${X:=r}; "${X}m"'), ['rm']);
  // for list items after an UNKNOWN one are still expanded
  const env = new Env();
  env.unset('X');
  const [loop] = nodes('for f in $(ls) ${X:=r}; do :; done');
  assert.equal(forValues(loop, env, ctx), UNKNOWN);
  assert.equal(env.get('X'), UNKNOWN);
});

test('arithmetic assignments are applied as UNKNOWN, never evaluated', () => {
  assert.deepEqual(words('X=1; : $((X=2)); rm /b$X'), ['rm', UNKNOWN]);
  assert.deepEqual(words('X=a; : $((X++)); echo $X'), ['echo', UNKNOWN]);
  for (const op of ['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']) {
    assert.deepEqual(words(`X=1; : $((X${op}2)); "$X"`), [UNKNOWN], op);
  }
  assert.deepEqual(words('X=1; : $((--X)); "$X"'), [UNKNOWN]);
  assert.deepEqual(words('X=1; : "$(( ${X:=3} + 1 ))"; "$X"'), [UNKNOWN]);
  // arithmetic inside an unevaluated fallback
  assert.deepEqual(words('X=1; : ${HOSTV:-$((X=2))}; "$X"'), [UNKNOWN]);
  // comparisons assign nothing; numeric names keep their values
  assert.deepEqual(words('X=1; Y=rm; : $((X==1 && X<=2 && X>=0 && X!=3)); "$X" "$Y"'), ['1', 'rm']);
  // a name whose value is not a number is evaluated as an expression: it may assign anything
  assert.deepEqual(words('X=1; E=Y; : $((E)); "$X"'), [UNKNOWN]);
  assert.deepEqual(words('X=1; : $((HOSTV + 1)); "$X"'), [UNKNOWN]);
  assert.deepEqual(words('X=1; : $(($1)); "$X"'), [UNKNOWN]);
});

test('zsh =cmd expansion after = or : makes any assignment value UNKNOWN', () => {
  assert.deepEqual(words('X=a:=ls; "$X"'), [UNKNOWN]);
  assert.deepEqual(words('export X=a:=ls; "$X"'), [UNKNOWN]);
  assert.deepEqual(words('X=a:b=c; "$X"'), ['a:b=c']);
  assert.deepEqual(words(`X=a:'='ls; "$X"`), ['a:=ls']);
});

test('a quoted or escaped declaration command takes plain arguments', () => {
  assert.deepEqual(words('\\export X=~/b; "$X"'), [UNKNOWN]);
  assert.deepEqual(words(`'export' X=a; "$X"`), [UNKNOWN]);
  assert.deepEqual(words('export X=~/b; "$X"'), ['/home/tester/b']);
});

test('splitsOnWhitespace reports unquoted values with glob characters', () => {
  const { env, node } = run(`X='*'; Y='a?'; $X "$X" $Y`);
  assert.equal(splitsOnWhitespace(node.words[0], env, ctx), true);
  assert.equal(splitsOnWhitespace(node.words[1], env, ctx), false);
  assert.equal(splitsOnWhitespace(node.words[2], env, ctx), true);
});
