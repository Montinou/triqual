import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { CODE_LOADING_VARS, isCodeLoadingAssignment } from '../src/tables/envvars.mjs';

// Hermetic: a temp cwd and a fake home. Nothing is executed: the commands are only parsed and
// classified (argv labels such as `python3 x` never run).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-envvars-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
const CWD = path.join(TMP, 'work');
fs.mkdirSync(CWD);

function run(text) {
  return normalize(text, { cwd: CWD, home: HOME, env: {} });
}

function opaque(text) {
  const r = run(text);
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 300)}`);
  return r.opaque;
}

function loading(text) {
  const o = opaque(text);
  assert.equal(o.construct, 'code-loading-var', `${JSON.stringify(text)}: ${JSON.stringify(o)}`);
  assert.equal(o.reason, 'unsupported');
  assert.equal(typeof o.offset, 'number');
  return o;
}

function plain(text) {
  const r = run(text);
  assert.ok(!r.opaque, `unexpected opaque for ${JSON.stringify(text)}: ${JSON.stringify(r)}`);
  assert.ok(Array.isArray(r.commands));
  return r.commands;
}

test('PYTHONPATH=. python3 x is opaque', () => {
  loading('PYTHONPATH=. python3 x');
});

test('export BASH_ENV=f then bash is opaque', () => {
  loading('export BASH_ENV=f; bash');
  loading('export BASH_ENV=f && bash');
});

test('env LD_PRELOAD=x ls is opaque', () => {
  loading('env LD_PRELOAD=x ls');
});

test('HOME=/tmp/h claude -p is opaque', () => {
  loading('HOME=/tmp/h claude -p');
});

test('env -i cmd is opaque', () => {
  loading('env -i ls');
  loading('env --ignore-environment ls');
  loading('env - ls');
  loading('env -i');
  loading('env -0i ls');
  loading('/usr/bin/env -i ls');
  loading('sudo env -i ls');
});

test('unset HOME is opaque', () => {
  loading('unset HOME');
  loading('unset -v HOME');
  loading('unset -v FOO HOME');
});

test('NODE_OPTIONS=--max-old-space-size=4096 npm run build is not opaque', () => {
  const [c] = plain('NODE_OPTIONS=--max-old-space-size=4096 npm run build');
  assert.deepEqual(c.argv, ['npm', 'run', 'build']);
  plain('NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" npm run build');
  plain('export NODE_OPTIONS=--enable-source-maps');
  plain('env NODE_OPTIONS=--stack-size=2000 ls');
});

test('NODE_OPTIONS=--require ./x.js is opaque', () => {
  loading('NODE_OPTIONS="--require ./x.js" ls');
  loading('NODE_OPTIONS=--require ls');
  loading('NODE_OPTIONS="--max-old-space-size=4096 --require=./x.js" ls');
  loading('NODE_OPTIONS=--import=./x.mjs ls');
  loading('NODE_OPTIONS="--max-old-space-size 4096" ls');
  loading('env NODE_OPTIONS="--require ./x.js" ls');
  loading('export NODE_OPTIONS');
  loading('unset NODE_OPTIONS');
  loading('NODE_OPTIONS="$UNSET_VAR_X" ls');
});

test('FENCE_PROFILE=default cmd is opaque', () => {
  loading('FENCE_PROFILE=default ls');
});

test('git alias GIT_SSH_COMMAND is opaque', () => {
  loading('GIT_SSH_COMMAND=x git status');
  loading('GIT_SSH_COMMAND=x git fetch');
});

test('every listed name and prefix is opaque as a prefix assignment', () => {
  const names = [
    'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONUSERBASE', 'BASH_ENV', 'ENV', 'ZDOTDIR',
    'PROMPT_COMMAND', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS',
    'SSH_ASKPASS', 'GIT_PAGER', 'PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT',
    'RUBYLIB', 'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME', 'FENCE_PROFILE', 'SHELLOPTS', 'PS4',
  ];
  for (const n of names) {
    assert.ok(CODE_LOADING_VARS.names.includes(n), n);
    assert.equal(isCodeLoadingAssignment(n, 'x'), true, n);
    loading(`${n}=x ls`);
  }
  for (const p of ['DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_foo', 'NPM_CONFIG_FOO', 'Npm_Config_x']) {
    assert.equal(isCodeLoadingAssignment(p, 'x'), true, p);
    loading(`${p}=x ls`);
  }
});

test('an unlisted prefix assignment stays normal', () => {
  const [c] = plain('FOO=1 ls');
  assert.deepEqual(c.argv, ['ls']);
  assert.equal(c.env.FOO, '1');
  plain('GIT_DIR=x git status');
  plain('Node_Options=x ls');
  plain('xdg_cache_home=x ls');
  plain('DYLDX=1 ls');
  plain('HOMEX=1 ls');
  plain('MYHOME=1 ls');
  plain('ls');
  plain('echo ok');
  plain('env FOO=1 ls');
  plain('env -u FOO ls');
  plain('unset FOO');
  plain('export FOO=1');
  plain('read -r line');
  plain('printf -v out %s ok');
});

test('a standalone assignment of a listed name is opaque', () => {
  loading('HOME=/tmp/h');
  loading('BASH_ENV=f');
  loading('PYTHONPATH=.; ls');
  loading('XDG_DATA_HOME=x');
  plain('FOO=1');
  plain('NODE_OPTIONS=--no-warnings');
});

test('declaration builtins naming a listed variable are opaque', () => {
  loading('declare -x HOME=/tmp/h');
  loading('declare -g PAGER=less');
  loading('typeset -x BASH_ENV=f');
  loading('readonly HOME');
  loading('local PYTHONPATH=.');
  loading('export FOO=1 HOME=/tmp/h');
  loading('export -n HOME');
  loading('builtin export HOME=x');
  loading('command export HOME=x');
  loading('export "$N=x"');
  loading('export $N');
  plain('declare -x FOO=1');
  plain('readonly FOO=1');
});

test('read and printf -v targeting a listed variable are opaque', () => {
  loading('read HOME');
  loading('read -r PAGER');
  loading('read -r -p prompt EDITOR');
  loading('read $N');
  loading('printf -v HOME %s x');
  loading('printf -vHOME %s x');
  loading('printf -v $N %s x');
  loading('printf -v "BASH_ENV" %s x');
});

test('env --unset, -u and an unlisted-name env stay precise', () => {
  loading('env --unset=HOME ls');
  loading('env --unset HOME ls');
  loading('env --uns=HOME ls');
  loading('env -u HOME ls');
  loading('env -uHOME ls');
  loading('env -u FOO -u HOME ls');
  loading('env -u $N ls');
  loading('env -i FOO=1 ls');
  loading('env -C . HOME=x ls');
  plain('env -u FOO ls');
  plain('env --unset=FOO ls');
  plain('env -C . FOO=1 ls');
  plain('env FOO=1 BAR=2 ls');
});

test('names with an array subscript or += are judged by their base name', () => {
  assert.equal(isCodeLoadingAssignment('BASH_ENV[0]', 'x'), true);
  assert.equal(isCodeLoadingAssignment('BASH_ENV+', 'x'), true);
  assert.equal(isCodeLoadingAssignment('FOO[1]', 'x'), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS+', '--no-warnings'), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS+', '--require=x'), true);
  loading('export BASH_ENV+=x');
  loading('export BASH_ENV[0]=x');
  loading('unset BASH_ENV[0]');
  opaque('PATH+=x ls'); // the parser's own append-assign opacity
});

test('the check applies inside re-parsed text', () => {
  loading('bash -c "HOME=/tmp/h ls"');
  loading("sh -c 'export BASH_ENV=f; bash'");
  loading("bash -c 'unset HOME'");
  loading("eval 'PYTHONPATH=. ls'");
  loading("env -S 'LD_PRELOAD=x ls'");
  loading("sudo bash -c 'GIT_SSH_COMMAND=x git status'");
  loading('echo "HOME=x ls" | bash');
  plain("bash -c 'FOO=1 ls'");
  plain("bash -c 'NODE_OPTIONS=--no-warnings ls'");
});

test('wrapper assignments of listed names are opaque, others pass', () => {
  loading('sudo HOME=/tmp/h ls');
  loading('sudo -u root PAGER=x ls');
  loading('doas HOME=/tmp/h ls');
  loading('nice env LD_PRELOAD=x ls');
  loading('env FOO=1 LD_PRELOAD=x ls');
  loading('xargs env -i');
  plain('sudo FOO=1 ls');
  plain('sudo -E ls');
});

test('assignments inside control flow and substitutions are seen', () => {
  loading('if true; then HOME=x; fi');
  loading('for i in a b; do BASH_ENV=f ls; done');
  loading('(export HOME=x)');
  loading('echo $(HOME=x ls)');
  loading('{ PAGER=x; }');
  plain('for i in a b; do FOO=$i ls; done');
});

test('opaque offset points at the command', () => {
  const o = loading('ls; HOME=x ls');
  assert.equal(o.offset, 4);
});

test('isCodeLoadingAssignment handles UNKNOWN and non-string values', () => {
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', UNKNOWN), true);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', undefined), true);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', 42), true);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', ''), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--no-warnings'), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '  --no-warnings   --trace-warnings '), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--max-semi-space-size=16'), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--experimental-vm-modules --trace-deprecation --trace-uncaught'), false);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--no-warnings=x --require=y'), true);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--max-old-space-size 4096'), true);
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', '--inspect'), true);
  assert.equal(isCodeLoadingAssignment('HOME', UNKNOWN), true);
  assert.equal(isCodeLoadingAssignment('FOO', UNKNOWN), false);
  assert.equal(isCodeLoadingAssignment('node_options', 'x'), false); // names are case-sensitive
  assert.equal(isCodeLoadingAssignment('home', 'x'), false);
  assert.equal(isCodeLoadingAssignment(UNKNOWN, 'x'), true);
  assert.equal(isCodeLoadingAssignment(undefined, 'x'), true);
  assert.equal(isCodeLoadingAssignment('', 'x'), false);
  assert.ok(Object.isFrozen(CODE_LOADING_VARS));
  for (const p of ['DYLD_', 'GIT_CONFIG_', 'XDG_']) assert.ok(CODE_LOADING_VARS.prefixes.includes(p), p);
  assert.ok(CODE_LOADING_VARS.prefixesNoCase.includes('npm_config_'));
});

test('a long hostile word stays linear', () => {
  const big = 'A'.repeat(20000);
  const t0 = Date.now();
  assert.equal(isCodeLoadingAssignment('NODE_OPTIONS', ' '.repeat(20000) + '--no-warnings'), false);
  assert.equal(isCodeLoadingAssignment(big, big), false);
  assert.ok(Date.now() - t0 < 1000);
});

test('an UNKNOWN value of an unlisted literal name stays normal; an UNKNOWN name is opaque', () => {
  plain('export FOO=$(date)');
  plain('for i in a b; do export X=$i; done');
  plain('env FOO=1 -- ls');
  loading('export FOO=$(date) HOME=$(echo x)');
  loading('export $(date)=1');
  loading('unset $(echo a)');
  loading('export FOO$N=1');
  loading('env -- HOME=x ls');
  loading('env -S"HOME=x ls"');
});

// ---------------------------------------------------------------------------------------------
// Fix round 1. The host shell is zsh; `bash -c '…'` runs the same text with bash's rules.
const inBash = (text) => `bash -c '${text}'`;

function keyword(text) {
  const o = opaque(text);
  assert.equal(o.construct, 'keyword-assign', `${JSON.stringify(text)}: ${JSON.stringify(o)}`);
  assert.equal(o.reason, 'unsupported');
  return o;
}

test('read (bash): option values are not names; -a takes a name', () => {
  plain(inBash('read -r -p "$P" line'));
  plain(inBash('read -t "$T" a'));
  plain(inBash('read -u "$fd" line'));
  plain(inBash('read -p HOME line'));
  plain(inBash('read -d x -n 3 -N 4 line'));
  plain(inBash('read -pHOME line'));
  loading(inBash('read -p x HOME'));
  loading(inBash('read -a HOME'));
  loading(inBash('read -ra BASH_ENV'));
  loading(inBash('read -aHOME'));
  loading(inBash('read -r -p "$P" HOME'));
  loading(inBash('read $N'));
});

test('read (zsh): -p has no operand, every word is a name except the values of -u and -d', () => {
  loading('read -p HOME line');
  loading('read -p "$P" line');
  loading('read -r -p prompt PAGER');
  loading('read -u 3 HOME');
  plain('read -u HOME line');
  plain('read -d HOME line');
  plain('read -r line');
  loading('read -A BASH_ENV');
});

test('declare, typeset, local, readonly, export with -p, -f or -F, and unset -f, assign nothing', () => {
  plain(inBash('declare -p HOME'));
  plain(inBash('typeset -p HOME'));
  plain(inBash('declare -f "$fn"'));
  plain(inBash('unset -f fn'));
  plain(inBash('unset -f HOME'));
  plain(inBash('unset -f "$fn"'));
  plain('declare -p HOME');
  plain('export -p');
  plain('export -f HOME');
  plain(inBash('declare -F "$fn"')); // under zsh -F is a float format (fix round 3)
  plain('readonly -p HOME');
  plain('local -pf HOME');
  // without those flags the names count; flags after a name do not hide it
  loading('declare -x HOME');
  loading('unset -v HOME');
  loading('declare HOME -p');
});

test('any nameref declaration is opaque, whatever the name', () => {
  loading('declare -n r=BASH_ENV');
  loading('typeset -n r=HOME[0]');
  loading('local -n r=PAGER');
  loading('declare -nx r=HOME');
  loading('declare -n r=$X');
  loading('declare -n r=FOO');
  loading('declare -n r; r=ok');
  loading('typeset -n r');
  loading('local -n r=ok');
  loading('declare -n');
  plain('declare +n r');
  plain('declare r=BASH_ENV_X');
  plain('declare -x FOO=1');
});

test('expansion assignments of a listed name are opaque', () => {
  loading('echo ${HOME:=/x}');
  loading('echo ${HOME=/x}');
  loading('echo "${BASH_ENV:=f}"');
  loading('echo $((HOME=1))');
  loading('echo $((BASH_ENV+=1))');
  loading('echo $((x=1, HOME=2))');
  loading('echo $((HOME++))');
  loading('echo $((++HOME))');
  loading('echo $((HOME[0]=1))');
  loading('echo $(($n=1))');
  loading('echo $(( HOME = 1 ))');
  loading('cat <<EOF\n${HOME:=/x}\nEOF');
  loading('case ${PAGER:=less} in a) ls;; esac');
  loading('FOO=${HOME:=/x} ls');
  loading('echo ${NODE_OPTIONS:=--require=x}');
  plain('echo ${NODE_OPTIONS:=--no-warnings}');
  plain('echo ${FOO:=1}');
  plain('echo ${FOO=1}');
  plain('echo $((x = 1))');
  plain('echo $((i++))');
  plain('echo $((a==1))');
  plain('echo $((a<=1 && b>=2 || c!=3))');
  plain('echo $((HOME == 1))');
  plain('echo $((FOO[1]))');
  plain('echo ${HOME:-x}');
  plain('echo ${HOME}');
});

test('for, getopts, mapfile, readarray, let, print -v, vared and zparseopts targets', () => {
  loading('for HOME in a b; do ls; done');
  loading('for BASH_ENV; do ls; done');
  plain('for i in a b; do ls; done');
  loading('getopts ab HOME');
  loading('getopts ab "$N"');
  plain('getopts ab opt');
  loading('mapfile HOME');
  loading('mapfile -t -d x -n 3 BASH_ENV');
  loading('readarray -t HOME');
  loading('mapfile -t "$N"');
  plain('mapfile -t arr');
  plain('mapfile');
  plain('mapfile -C "$cb" -c 5 arr');
  loading('let HOME=1');
  loading('let "BASH_ENV=3"');
  loading('let i=1 HOME+=2');
  loading('let $x=1');
  loading('let "HOME$x=1"');
  loading('let "x=1, HOME=2"');
  loading('let HOME++');
  plain('let "x=1"');
  plain('let i++');
  plain('let "n=$n+1"');
  plain('let "n = n + 1"');
  loading('print -v HOME x');
  loading('print -r -v BASH_ENV x');
  loading('print -vHOME x');
  plain('print -r x');
  plain('print -u 2 -v out x');
  loading('vared HOME');
  loading('vared -p prompt HOME');
  plain('vared -p HOME line');
  plain('vared line');
  loading('zparseopts -a HOME x:');
  loading('zparseopts -A BASH_ENV');
  loading('zparseopts -D -E -aPAGER x:');
  plain('zparseopts -D -E -a arr x:');
});

test('zparseopts spec words name targets too', () => {
  loading('zparseopts x=HOME');
  loading('zparseopts -D -E x:=BASH_ENV');
  loading('zparseopts x+=PAGER');
  loading('zparseopts -D -E -- -foo=EDITOR');
  loading('zparseopts -D -E a=b c::=HOME');
  loading('zparseopts -D "$spec"');
  loading('zparseopts -D x=$N');
  plain('zparseopts x=opt');
  plain('zparseopts -D -E a=b c:=d -- e+:=f');
  plain('zparseopts -D -E -a arr x: y');
  plain('zparseopts -D');
});

test('set -k, set -o keyword, and a shell started with them, are keyword-assign', () => {
  keyword('set -k');
  keyword('set -ek');
  keyword('set -o keyword');
  keyword('set -eo keyword');
  keyword('set -o $X');
  keyword('bash -k -c ls');
  keyword('bash -ek -c ls');
  keyword('bash -o keyword -c ls');
  keyword('sh -k -c ls');
  keyword('sudo bash -k -c ls');
  keyword("bash -c 'set -k; ls'");
  keyword("bash -c 'bash -o keyword -c ls'");
  plain('set -e');
  plain('set -o pipefail');
  plain('set +k');
  plain('set -- a b');
  plain('bash -e -c ls');
  plain('bash -o pipefail -c ls');
  plain('bash -c ls');
});

test('sudo, doas and su left with no program still see NAME=v words', () => {
  loading('sudo -s HOME=x');
  loading('sudo -i HOME=x');
  loading('sudo -E HOME=x');
  loading('sudo -u root -s HOME=x');
  loading('doas -s HOME=x');
  loading('su HOME=x');
  loading('sudo -s BASH_ENV=f');
  plain('sudo -s FOO=1');
  plain('sudo -E FOO=1');
  plain('ls HOME=x');
});

test('the offset of a late assignment points at its command', () => {
  assert.equal(loading('ls; echo ${HOME:=x}').offset, 4);
  assert.equal(keyword('ls; set -k').offset, 4);
});

// ---------------------------------------------------------------------------------------------
// Fix round 3
test('SHELLOPTS and PS4 are code-loading names', () => {
  loading('SHELLOPTS=keyword bash -c ls');
  loading('export SHELLOPTS=keyword');
  loading("PS4='x' ls");
  loading('env SHELLOPTS=keyword ls');
  loading('unset PS4');
  loading('SHELLOPTS=keyword');
});

test('++ and -- on a computed name are assignments', () => {
  loading('echo $(($n++))');
  loading('echo $((++$n))');
  loading('echo $((n--$m))'.replace('n--$m', '$n--'));
  loading('echo $((--${n}))');
  loading('let "$n++"'.replace('$n', '$N'));
  plain('echo $((n--))');
  plain('echo $((i++))');
  plain('echo $((1 + 2))');
  plain('echo $(($a + $b))');
});

test('zsh builtins that write a named variable name their target', () => {
  loading('getln HOME');
  loading('getln "$N"');
  loading('zstyle -s :ctx style PAGER');
  loading('zstyle -g BASH_ENV :ctx style');
  loading('zformat -f HOME %a a:b');
  loading('zformat -a EDITOR : a:b');
  loading('strftime -s HOME %Y 0');
  loading('strftime -rs PAGER %Y x');
  loading('sysread -c HOME');
  loading('sysread -o 1 BASH_ENV');
  loading('sysread HOME');
  loading('sysread "$N"');
  plain('getln line');
  plain('zstyle -s :ctx style out');
  plain('zstyle :ctx style value');
  plain('zstyle -t :ctx style');
  plain('zformat -f out %a a:b');
  plain('strftime %Y 0');
  plain('strftime -s out %Y 0');
  plain('sysread -c n out');
});

test('-F and -E: skipped only under bash; bare words only under -p -f -F', () => {
  plain(inBash('typeset -F x'));
  plain(inBash('typeset -F HOME'));
  plain(inBash('declare -F'));
  loading('typeset -F HOME=1');
  loading('local -F PAGER');
  loading('typeset -E HOME');
  loading('typeset -F HOME');
  plain('typeset -F x');
  plain('typeset -p HOME');
  plain('typeset -f HOME');
  loading('typeset -p HOME=x');
  loading('declare -p HOME=x');
  loading(inBash('typeset -F HOME=x'));
  loading(inBash('declare -f BASH_ENV=1'));
  loading('declare -p "HOME=$x"');
  loading('export -n HOME');
  loading(inBash('export -n HOME'));
  plain('export -n FOO');
  plain(inBash('read -r -p "$P" line'));
  plain(inBash('declare -p HOME'));
  plain(inBash('unset -f fn'));
});

// ---------------------------------------------------------------------------------------------
// Fix round 4
test('zsh integer and float declare like typeset', () => {
  loading('integer HOME=1');
  loading('float PAGER=1');
  loading('integer -r BASH_ENV');
  loading('integer "$N"=1');
  loading('integer n=1 HOME');
  plain('integer n=1');
  plain('float x=1.5');
  plain('integer -p');
  // bash has no such builtins: they are plain commands there
  plain(inBash('integer HOME=1'));
});

test('zstyle -a/-b and zformat -F write their target too', () => {
  loading('zstyle -a :c st HOME');
  loading('zstyle -b :c st PAGER');
  loading('zformat -F HOME x');
  loading('zformat -F "$N" x');
  plain('zstyle -a :c st arr');
  plain('zstyle -b :c st flag');
  plain('zformat -F out x');
});

test('zsh module builtins write named variables', () => {
  loading('zselect -r HOME');
  loading('zselect -A BASH_ENV');
  loading('zsystem flock -f HOME ./f');
  loading('zsystem supports HOME');
  loading('zstat -A HOME ./f');
  loading('zstat -H PAGER ./f');
  loading('zstat +mtime -v HOME ./f');
  loading('zstat -A "$N" ./f');
  loading('pcre_match -a HOME -v PAGER x');
  loading('private HOME=1');
  loading('private -a BASH_ENV');
  loading('private "$N"=1');
  plain('zselect -r 0');
  plain('zsystem flock -f fd ./f');
  plain('zstat -A arr ./f');
  plain('zstat +mtime -v t ./f');
  plain('pcre_match -a arr -v v x');
  plain('private x=1');
  plain('private -a arr');
});
