import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShell, literalValue, literalText } from '../src/norm/parser.mjs';

// The literal argv of a simple node (null for a word that is not literal).
function argv(node) {
  assert.equal(node.type, 'simple');
  return node.words.map(literalValue);
}

// Parse text that must succeed and return the root node.
function ok(text) {
  const r = parseShell(text);
  assert.equal(r.opaque, undefined, `unexpected opaque for ${JSON.stringify(text)}: ${JSON.stringify(r.opaque)}`);
  return r;
}

// The single command of a one-command program.
function only(text) {
  const root = ok(text);
  assert.equal(root.type, 'list');
  assert.equal(root.items.length, 1);
  return root.items[0].node;
}

function opaque(text) {
  const r = parseShell(text);
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 200)}`);
  assert.equal(typeof r.opaque.reason, 'string');
  assert.equal(typeof r.opaque.construct, 'string');
  assert.equal(typeof r.opaque.offset, 'number');
  return r.opaque;
}

test('parses ; && || | & lists', () => {
  const root = ok('a 1; b && c || d | e & f\ng');
  assert.equal(root.type, 'list');
  assert.equal(root.items.length, 4);
  assert.deepEqual(argv(root.items[0].node), ['a', '1']);
  assert.equal(root.items[0].async, false);

  const andOr = root.items[1].node;
  assert.equal(root.items[1].async, true);
  assert.equal(andOr.type, 'or');
  assert.equal(andOr.left.type, 'and');
  assert.deepEqual(argv(andOr.left.left), ['b']);
  assert.deepEqual(argv(andOr.left.right), ['c']);
  assert.equal(andOr.right.type, 'pipeline');
  assert.equal(andOr.right.negated, false);
  assert.deepEqual(andOr.right.commands.map((c) => argv(c)[0]), ['d', 'e']);

  assert.deepEqual(argv(root.items[2].node), ['f']);
  assert.deepEqual(argv(root.items[3].node), ['g']);

  // newlines after && || | continue the command; a trailing ; is fine
  const cont = ok('a &&\n b |\n c;');
  assert.equal(cont.items.length, 1);
  assert.equal(cont.items[0].node.type, 'and');
  assert.equal(cont.items[0].node.right.type, 'pipeline');

  // ! negates a pipeline; comments are skipped
  const neg = only('! a | b # rm -rf /');
  assert.equal(neg.type, 'pipeline');
  assert.equal(neg.negated, true);
  assert.equal(neg.commands.length, 2);

  // a dangling operator is not a program
  opaque('a &&');
  opaque('| a');
  opaque('a ;; b');
});

test('single double and ANSI-C quotes and escapes', () => {
  assert.deepEqual(argv(only(`echo 'a b' "c d" $'e\\tf' g\\ h`)), ['echo', 'a b', 'c d', 'e\tf', 'g h']);
  // single quotes keep everything literal
  assert.deepEqual(argv(only(`echo '$X \\n "q"'`)), ['echo', '$X \\n "q"']);
  // double quotes: \ escapes only $ ` " \ and newline
  assert.deepEqual(argv(only(`echo "a\\$b \\"c\\" \\\\ \\n"`)), ['echo', 'a$b "c" \\ \\n']);
  // ANSI-C escapes
  assert.deepEqual(argv(only(`printf $'\\x41\\101\\u00e9\\n\\'\\\\'`)), ['printf', "AAé\n'\\"]);
  // line continuation joins
  assert.deepEqual(argv(only('ec\\\nho hi')), ['echo', 'hi']);
  // an empty quoted string is an empty argument
  assert.deepEqual(argv(only(`echo '' ""`)), ['echo', '', '']);

  // quoting is recorded per part
  const w = only(`x 'a'b"c"`).words[1];
  assert.deepEqual(w.parts.map((p) => [p.type, p.text, p.quoted]), [
    ['lit', 'a', true],
    ['lit', 'b', false],
    ['lit', 'c', true],
  ]);

  // expansions inside double quotes are quoted vars; inside single quotes they are text
  const v = only(`echo "$HOME/x" '$HOME' $HOME \${HOME} \${X:-lit}`).words;
  assert.equal(v[1].parts[0].type, 'var');
  assert.equal(v[1].parts[0].name, 'HOME');
  assert.equal(v[1].parts[0].quoted, true);
  assert.equal(literalValue(v[1]), null);
  assert.equal(literalValue(v[2]), '$HOME');
  assert.equal(v[3].parts[0].quoted, false);
  assert.equal(v[4].parts[0].name, 'HOME');
  assert.equal(v[5].parts[0].name, 'X');
  assert.equal(v[5].parts[0].op, ':-');
  assert.equal(literalValue(v[5].parts[0].arg), 'lit');

  // globs outside quotes are glob parts; inside quotes they are literal
  const g = only(`ls *.js '*.md' a?[bc]`).words;
  assert.deepEqual(g[1].parts.map((p) => p.type), ['glob', 'lit']);
  assert.equal(literalValue(g[1]), null);
  assert.equal(literalValue(g[2]), '*.md');
  assert.deepEqual(g[3].parts.map((p) => p.type), ['lit', 'glob', 'glob', 'lit', 'glob']);
  // an unmatched [ is a literal, so the test command reads as [
  assert.deepEqual(argv(only('[ -f x ]')), ['[', '-f', 'x', ']']);

  // brace expansion is not modelled
  assert.equal(opaque('{rm,-rf,/}').construct, 'brace-expansion');
  assert.equal(opaque('echo a{1..3}').construct, 'brace-expansion');
  assert.deepEqual(argv(only('find . -exec echo {} ;')), ['find', '.', '-exec', 'echo', '{}']);
});

test('leading assignments', () => {
  const n = only(`A=1 B="x y" C= cmd D=2`);
  assert.deepEqual(n.assigns.map((a) => [a.name, literalValue(a.value)]), [
    ['A', '1'],
    ['B', 'x y'],
    ['C', ''],
  ]);
  assert.deepEqual(argv(n), ['cmd', 'D=2']);

  // assignments alone
  const bare = only('X=rm');
  assert.equal(bare.words.length, 0);
  assert.equal(bare.assigns[0].name, 'X');

  // a quoted name is not an assignment
  assert.deepEqual(argv(only(`'X'=1 cmd`)), ['X=1', 'cmd']);
  // the value keeps its expansions
  const e = only('P=$HOME/bin cmd').assigns[0].value;
  assert.equal(e.parts[0].type, 'var');
  assert.equal(literalValue(e), null);

  // arrays and append assignments are not modelled
  opaque('a=(1 2) cmd');
  opaque('a+=x cmd');
  opaque('a[1]=x cmd');
});

test('command substitution $() and backticks nest', () => {
  const w = only('echo $(a $(b) `c`) "`d \\`e\\``" x$(f)y').words;
  const cs = w[1].parts[0];
  assert.equal(cs.type, 'cmdsub');
  assert.equal(cs.quoted, false);
  const inner = cs.program.items[0].node;
  assert.equal(literalValue(inner.words[0]), 'a');
  assert.equal(inner.words[1].parts[0].type, 'cmdsub');
  assert.equal(literalValue(inner.words[1].parts[0].program.items[0].node.words[0]), 'b');
  assert.equal(inner.words[2].parts[0].type, 'cmdsub');
  assert.equal(literalValue(inner.words[2].parts[0].program.items[0].node.words[0]), 'c');

  const bq = w[2].parts[0];
  assert.equal(bq.type, 'cmdsub');
  assert.equal(bq.quoted, true);
  const bqInner = bq.program.items[0].node;
  assert.equal(literalValue(bqInner.words[0]), 'd');
  const nested = bqInner.words[1].parts[0];
  assert.equal(nested.type, 'cmdsub');
  assert.equal(literalValue(nested.program.items[0].node.words[0]), 'e');

  assert.deepEqual(w[3].parts.map((p) => p.type), ['lit', 'cmdsub', 'lit']);

  // a case pattern ) inside $( ) does not close it
  const c = only('echo $(case x in a) echo hit;; esac)').words[1].parts[0];
  assert.equal(c.program.items[0].node.type, 'case');

  // arithmetic expansion is its own part
  const ar = only('echo $((1 + 2))').words[1].parts[0];
  assert.equal(ar.type, 'arith');
  assert.equal(ar.text, '1 + 2');

  opaque('echo $(a');
  opaque('echo `a');
  opaque('echo $((1 + 2)');
});

test('subshell and brace group', () => {
  const s = only('(cd x && rm y) > out');
  assert.equal(s.type, 'subshell');
  assert.equal(s.body.items[0].node.type, 'and');
  assert.equal(s.redirs[0].op, '>');
  assert.equal(literalValue(s.redirs[0].target), 'out');

  const g = only('{ a; b\n}');
  assert.equal(g.type, 'group');
  assert.equal(g.body.items.length, 2);

  // } as an argument is a word, not a closer
  assert.deepEqual(argv(only('echo }')), ['echo', '}']);

  opaque('(a');
  opaque('{ a; ');
  opaque('{ a }');
  opaque('a )');

  // deep nesting comes out opaque quickly instead of overflowing the stack
  const t0 = Date.now();
  // 20,000 balanced levels would be ~80 KB and hit the 32 KiB size cap first,
  // so these are long runs of openers, or balanced nesting that fits the cap.
  assert.equal(opaque('('.repeat(20000)).reason, 'depth');
  assert.equal(opaque('( '.repeat(16000)).reason, 'depth');
  assert.equal(opaque('$('.repeat(16000)).reason, 'depth');
  assert.equal(opaque('{ '.repeat(16000)).reason, 'depth');
  assert.equal(opaque('( '.repeat(8000) + 'a' + ' )'.repeat(8000)).reason, 'depth');
  assert.equal(opaque('$('.repeat(5000) + 'a' + ')'.repeat(5000)).reason, 'depth');
  assert.equal(opaque('echo ' + '${X:-'.repeat(5000) + '}'.repeat(5000)).reason, 'depth');
  assert.ok(Date.now() - t0 < 2000, 'deep nesting must be rejected quickly');
  // the boundary: 64 levels parse, 65 are opaque depth
  ok('( '.repeat(64) + 'a' + ' )'.repeat(64));
  assert.equal(opaque('( '.repeat(65) + 'a' + ' )'.repeat(65)).reason, 'depth');
  ok('echo ' + '$('.repeat(64) + 'a' + ')'.repeat(64));
  assert.equal(opaque('echo ' + '$('.repeat(65) + 'a' + ')'.repeat(65)).reason, 'depth');
  ok('{ '.repeat(64) + 'a' + '; }'.repeat(64));
  assert.equal(opaque('{ '.repeat(65) + 'a' + '; }'.repeat(65)).reason, 'depth');
});

test('if for while until case bodies parse', () => {
  const i = only('if a; then b; elif c; then d; else e; fi');
  assert.equal(i.type, 'if');
  assert.equal(i.clauses.length, 2);
  assert.deepEqual(argv(i.clauses[0].cond.items[0].node), ['a']);
  assert.deepEqual(argv(i.clauses[1].body.items[0].node), ['d']);
  assert.deepEqual(argv(i.else.items[0].node), ['e']);

  const f = only('for x in a "b c" *.js; do rm $x; done');
  assert.equal(f.type, 'for');
  assert.equal(f.var, 'x');
  assert.equal(f.items.length, 3);
  assert.equal(literalValue(f.items[1]), 'b c');
  assert.deepEqual(argv(f.body.items[0].node)[0], 'rm');
  assert.equal(only('for x; do a; done').items, null);
  ok('for x in a b\ndo\n a\ndone');

  const w = only('while read l; do echo "$l"; done < f');
  assert.equal(w.type, 'while');
  assert.equal(w.until, false);
  assert.equal(w.redirs[0].op, '<');
  const u = only('until a; do b; done');
  assert.equal(u.type, 'while');
  assert.equal(u.until, true);

  const c = only('case "$x" in a|b) one;; (c) two ;& *) ;; esac');
  assert.equal(c.type, 'case');
  assert.equal(c.arms.length, 3);
  assert.deepEqual(c.arms[0].patterns.map(literalValue), ['a', 'b']);
  assert.deepEqual(argv(c.arms[0].body.items[0].node), ['one']);
  assert.equal(c.arms[1].term, ';&');
  assert.equal(c.arms[2].body, null);
  ok('case x in\n a) b\n esac');

  // reserved words are only reserved in command position and when unquoted
  assert.deepEqual(argv(only('echo if then fi')), ['echo', 'if', 'then', 'fi']);
  assert.deepEqual(argv(only(`'if' x`)), ['if', 'x']);

  opaque('if a; then b');
  opaque('for x in a; do b');
  opaque('while a; do b; done done');
  opaque('case x in a) b');
  opaque('for ((i=0;i<3;i++)); do a; done');
  opaque('((x++))');
  opaque('[[ -f x ]]');
  opaque('select x in a; do b; done');
});

test('redirections > >> >| &> < <> and fd duplication', () => {
  const n = only('cmd > a >> b >| c &> d &>> e < f <> g 2>&1 3<&0 >&- 2> h');
  assert.deepEqual(argv(n), ['cmd']);
  assert.deepEqual(
    n.redirs.map((r) => [r.op, r.fd ?? null, literalValue(r.target)]),
    [
      ['>', null, 'a'],
      ['>>', null, 'b'],
      ['>|', null, 'c'],
      ['&>', null, 'd'],
      ['&>>', null, 'e'],
      ['<', null, 'f'],
      ['<>', null, 'g'],
      ['>&', 2, '1'],
      ['<&', 3, '0'],
      ['>&', null, '-'],
      ['>', 2, 'h'],
    ],
  );
  // redirections may come before the command and between arguments
  const m = only('>out A=1 cmd x 2>/dev/null y');
  assert.deepEqual(m.assigns.map((a) => a.name), ['A']);
  assert.deepEqual(argv(m), ['cmd', 'x', 'y']);
  assert.equal(m.redirs.length, 2);
  // a digit word not touching the operator is an argument
  assert.deepEqual(argv(only('echo 2 > f')), ['echo', '2']);

  opaque('cmd >');
  opaque('cmd > ;');
  // heredocs and herestrings are not modelled yet
  assert.equal(opaque('cat <<EOF\nx\nEOF').construct, 'heredoc');
  assert.equal(opaque('cat <<< x').construct, 'herestring');
});

test("quote-split r''m reads as rm", () => {
  for (const text of [`r''m -rf /`, `"r"m -rf /`, `\\rm -rf /`, `r\\m -rf /`, `'rm' -rf /`, `$'r'm -rf /`]) {
    assert.deepEqual(argv(only(text)), ['rm', '-rf', '/'], text);
  }
});

test('unterminated quote is opaque', () => {
  const s = opaque(`echo 'abc`);
  assert.equal(s.reason, 'unterminated');
  assert.equal(s.offset, 5);
  assert.equal(opaque('echo "abc').reason, 'unterminated');
  assert.equal(opaque(`echo $'abc`).reason, 'unterminated');
  assert.equal(opaque('echo ${X').reason, 'unterminated');
  assert.equal(opaque('echo abc\\').reason, 'unterminated');
});

test('a 33 KiB command is opaque with reason size', () => {
  const o = opaque('echo ' + 'a'.repeat(33 * 1024));
  assert.equal(o.reason, 'size');
  // just under the cap still parses, and quickly
  const t0 = Date.now();
  ok('echo ' + 'a'.repeat(32 * 1024 - 10));
  ok(('a b; ').repeat(5000));
  assert.ok(Date.now() - t0 < 1000);
  // the cap counts bytes, not UTF-16 units
  assert.equal(opaque('echo ' + 'é'.repeat(17 * 1024)).reason, 'size');
});

test('function definition is opaque', () => {
  assert.equal(opaque('f() { rm -rf /; }; f').construct, 'function');
  assert.equal(opaque('f () { a; }').construct, 'function');
  assert.equal(opaque('function f { a; }').construct, 'function');
});

test('process substitution is opaque', () => {
  assert.equal(opaque('diff <(a) <(b)').construct, 'process-substitution');
  assert.equal(opaque('tee >(sh)').construct, 'process-substitution');
  assert.equal(opaque('sh < <(curl x)').construct, 'process-substitution');
  // never throws on arbitrary input
  for (const text of ['', ' ', ';', '&', ')', '}', '$', '`', '"', "'", '\\', '$(', '${', '${}', '$((', '<', '>&']) {
    const r = parseShell(text);
    assert.ok(r && (r.opaque || r.type === 'list'), JSON.stringify(text));
  }
});

test('named fd {NAME}> redirection is opaque', () => {
  for (const text of ['{x}>f rm -rf /', '{fd}<x cat', 'exec {fd}>f', 'echo hi {out}>>log']) {
    assert.equal(opaque(text).construct, 'named-fd', text);
  }
  // a braced word that does not touch a redirection is an ordinary word
  assert.deepEqual(argv(only('echo {x} > f')), ['echo', '{x}']);
});

test('zsh clobber redirects are opaque', () => {
  for (const text of ['echo x >! .claude/settings.json', 'echo x >>! f', 'cmd &>! f', 'cmd >&! f', 'cmd >>&! f', 'cmd >>& f', 'cmd 2>! f']) {
    assert.equal(opaque(text).construct, 'zsh-syntax', text);
  }
});

test('zsh parameter forms are opaque', () => {
  for (const text of ['echo $=x', 'echo $~x', 'echo $^x', 'echo $+x', 'echo $#name', 'echo $x[1]', 'echo "$x[1]"', 'echo ${x}[1]', 'echo $#{x}']) {
    assert.equal(opaque(text).construct, 'zsh-syntax', text);
  }
  // bash $# is the argument count, a special parameter on its own
  const w = only('echo $# "$#"').words;
  assert.deepEqual([w[1].parts[0].type, w[1].parts[0].name], ['var', '#']);
  assert.deepEqual([w[2].parts[0].type, w[2].parts[0].name], ['var', '#']);
  // the flags followed by a digit or a special parameter too
  for (const text of ['set -- rm; $=1 -rf /', 'echo $=@', 'echo $^@', 'echo $~1', 'echo $+1', 'echo $=*', 'echo $~*', 'echo $=#', 'echo $^?', 'echo $+!', 'echo $=-', 'echo $~$', 'echo $=0', 'echo "$=1"']) {
    assert.equal(opaque(text).construct, 'zsh-syntax', text);
  }
  // a lone $= or $+ is literal text in both shells
  assert.deepEqual(argv(only('echo $= $+')), ['echo', '$=', '$+']);
});

test('zsh command words repeat coproc foreach and - are opaque', () => {
  for (const text of ['repeat 3 rm -rf x', 'coproc rm x', '- rm x', 'foreach x (a b) rm $x; end', 'X=1 repeat 3 rm x', 'a && - rm x']) {
    assert.equal(opaque(text).construct, 'zsh-syntax', text);
  }
  assert.deepEqual(argv(only('noglob rm x')), ['noglob', 'rm', 'x']);
  assert.deepEqual(argv(only('nocorrect rm x')), ['nocorrect', 'rm', 'x']);
  // as arguments, or quoted, they are plain words
  assert.deepEqual(argv(only("echo repeat - foreach")), ['echo', 'repeat', '-', 'foreach']);
  assert.deepEqual(argv(only("'repeat' 3")), ['repeat', '3']);
});

test('tilde words have no literal value', () => {
  const w = only('ls ~ ~/x ~root/y "~"/z \\~/q a~b HEAD~1 host:~/x').words;
  assert.deepEqual(w.map(literalValue), ['ls', null, null, null, '~/z', '~/q', 'a~b', 'HEAD~1', 'host:~/x']);
  assert.equal(literalText(w[2]), '~/x');
  // assignment values: leading ~ and ~ after : expand; so do assignment-like words
  const n = only('A=~/bin B=x:~/y C="~"/z cmd X=~/w');
  assert.deepEqual(n.assigns.map((a) => literalValue(a.value)), [null, null, '~/z']);
  assert.equal(literalText(n.assigns[0].value), '~/bin');
  assert.deepEqual(argv(n), ['cmd', null]);
});

test('backtick offsets point into the original text', () => {
  // inside backticks \\\\ is an escaped backslash; the quote after it is unterminated
  const text = 'echo `a ' + '\\'.repeat(4) + " 'b`";
  const o = opaque(text);
  assert.equal(o.reason, 'unterminated');
  assert.equal(o.offset, text.indexOf("'"));
  // nested backticks map through both levels
  const t2 = 'echo `x \\`y ' + '\\'.repeat(8) + ' "z\\`' + '`';
  const o2 = opaque(t2);
  assert.equal(o2.reason, 'unterminated');
  assert.equal(o2.offset, t2.indexOf('"'));
  // a syntax error inside backticks too
  const t3 = 'echo `a \\$b ;; c`';
  assert.equal(opaque(t3).offset, t3.indexOf(';;'));
});

test('construct labels for ( after a word', () => {
  assert.notEqual(opaque('time ( rm x )').construct, 'function');
  assert.notEqual(opaque('cat =(ls)').construct, 'function');
  assert.equal(opaque('cat =(ls)').construct, 'zsh-syntax');
  assert.notEqual(opaque('=(ls)').construct, 'function');
  assert.equal(opaque('f() { a; }').construct, 'function');
  assert.equal(opaque('f ( ) { a; }').construct, 'function');
});
