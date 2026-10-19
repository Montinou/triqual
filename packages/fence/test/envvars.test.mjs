import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { CODE_LOADING_VARS, HOST_CONFIG_VARS, isCodeLoadingAssignment, isHostConfigName } from '../src/tables/envvars.mjs';

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

function hostConfig(text) {
  const o = opaque(text);
  assert.equal(o.construct, 'host-config-var', `${JSON.stringify(text)}: ${JSON.stringify(o)}`);
  assert.equal(o.reason, 'unsupported');
  assert.equal(typeof o.offset, 'number');
  return o;
}

// Literal membership in the HOST_CONFIG_VARS table (names and prefixes), not isHostConfigName.
function inHostConfigTable(name) {
  return HOST_CONFIG_VARS.names.includes(name) || HOST_CONFIG_VARS.prefixes.some((p) => name.startsWith(p));
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

test('PYTHONSAFEPATH is a code-loading variable', () => {
  assert.ok(CODE_LOADING_VARS.names.includes('PYTHONSAFEPATH'));
  assert.equal(isCodeLoadingAssignment('PYTHONSAFEPATH', '1'), true);
  loading(`PYTHONSAFEPATH=1 python3 -c 'print(1)'`);
  loading('export PYTHONSAFEPATH=1');
});

test('PYTHONINSPECT is a code-loading variable', () => {
  assert.ok(CODE_LOADING_VARS.names.includes('PYTHONINSPECT'));
  assert.equal(isCodeLoadingAssignment('PYTHONINSPECT', '1'), true);
  loading(`PYTHONINSPECT=1 python3 -I -c 'print(1)'`);
  loading('export PYTHONINSPECT=1');
});

test('export BASH_ENV=f then bash is opaque', () => {
  loading('export BASH_ENV=f; bash');
  loading('export BASH_ENV=f && bash');
});

test('env LD_PRELOAD=x ls is opaque', () => {
  loading('env LD_PRELOAD=x ls');
});

test('HOME=/tmp/h claude -p is opaque', () => {
  hostConfig('HOME=/tmp/h claude -p');
});

test('env -i cmd is opaque', () => {
  hostConfig('env -i ls');
  hostConfig('env --ignore-environment ls');
  hostConfig('env - ls');
  hostConfig('env -i');
  hostConfig('env -0i ls');
  hostConfig('/usr/bin/env -i ls');
  hostConfig('sudo env -i ls');
});

test('unset HOME is opaque', () => {
  hostConfig('unset HOME');
  hostConfig('unset -v HOME');
  hostConfig('unset -v FOO HOME');
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
  hostConfig('FENCE_PROFILE=default ls');
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
    if (inHostConfigTable(n)) hostConfig(`${n}=x ls`);
    else loading(`${n}=x ls`);
  }
  for (const p of ['DYLD_INSERT_LIBRARIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_foo', 'NPM_CONFIG_FOO', 'Npm_Config_x']) {
    assert.equal(isCodeLoadingAssignment(p, 'x'), true, p);
    if (inHostConfigTable(p)) hostConfig(`${p}=x ls`);
    else loading(`${p}=x ls`);
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
  hostConfig('HOME=/tmp/h');
  loading('BASH_ENV=f');
  loading('PYTHONPATH=.; ls');
  hostConfig('XDG_DATA_HOME=x');
  plain('FOO=1');
  plain('NODE_OPTIONS=--no-warnings');
});

test('declaration builtins naming a listed variable are opaque', () => {
  hostConfig('declare -x HOME=/tmp/h');
  loading('declare -g PAGER=less');
  loading('typeset -x BASH_ENV=f');
  hostConfig('readonly HOME');
  loading('local PYTHONPATH=.');
  hostConfig('export FOO=1 HOME=/tmp/h');
  hostConfig('export -n HOME');
  hostConfig('builtin export HOME=x');
  hostConfig('command export HOME=x');
  hostConfig('export "$N=x"');
  hostConfig('export $N');
  plain('declare -x FOO=1');
  plain('readonly FOO=1');
});

test('read and printf -v targeting a listed variable are opaque', () => {
  hostConfig('read HOME');
  loading('read -r PAGER');
  loading('read -r -p prompt EDITOR');
  hostConfig('read $N');
  hostConfig('printf -v HOME %s x');
  hostConfig('printf -vHOME %s x');
  hostConfig('printf -v $N %s x');
  loading('printf -v "BASH_ENV" %s x');
});

test('env --unset, -u and an unlisted-name env stay precise', () => {
  hostConfig('env --unset=HOME ls');
  hostConfig('env --unset HOME ls');
  hostConfig('env --uns=HOME ls');
  hostConfig('env -u HOME ls');
  hostConfig('env -uHOME ls');
  hostConfig('env -u FOO -u HOME ls');
  hostConfig('env -u $N ls');
  hostConfig('env -i FOO=1 ls');
  hostConfig('env -C . HOME=x ls');
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
  hostConfig('export BASH_ENV[0]=x');
  hostConfig('unset BASH_ENV[0]');
  opaque('PATH+=x ls'); // the parser's own append-assign opacity
});

test('the check applies inside re-parsed text', () => {
  hostConfig('bash -c "HOME=/tmp/h ls"');
  loading("sh -c 'export BASH_ENV=f; bash'");
  hostConfig("bash -c 'unset HOME'");
  loading("eval 'PYTHONPATH=. ls'");
  loading("env -S 'LD_PRELOAD=x ls'");
  loading("sudo bash -c 'GIT_SSH_COMMAND=x git status'");
  hostConfig('echo "HOME=x ls" | bash');
  plain("bash -c 'FOO=1 ls'");
  plain("bash -c 'NODE_OPTIONS=--no-warnings ls'");
});

test('wrapper assignments of listed names are opaque, others pass', () => {
  hostConfig('sudo HOME=/tmp/h ls');
  loading('sudo -u root PAGER=x ls');
  hostConfig('doas HOME=/tmp/h ls');
  loading('nice env LD_PRELOAD=x ls');
  loading('env FOO=1 LD_PRELOAD=x ls');
  hostConfig('xargs env -i');
  plain('sudo FOO=1 ls');
  plain('sudo -E ls');
});

test('assignments inside control flow and substitutions are seen', () => {
  hostConfig('if true; then HOME=x; fi');
  loading('for i in a b; do BASH_ENV=f ls; done');
  hostConfig('(export HOME=x)');
  hostConfig('echo $(HOME=x ls)');
  loading('{ PAGER=x; }');
  plain('for i in a b; do FOO=$i ls; done');
});

test('opaque offset points at the command', () => {
  const o = hostConfig('ls; HOME=x ls');
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
  assert.ok(Date.now() - t0 < 10000);
});

test('an UNKNOWN value of an unlisted literal name stays normal; an UNKNOWN name is opaque', () => {
  plain('export FOO=$(date)');
  plain('for i in a b; do export X=$i; done');
  plain('env FOO=1 -- ls');
  hostConfig('export FOO=$(date) HOME=$(echo x)');
  hostConfig('export $(date)=1');
  hostConfig('unset $(echo a)');
  hostConfig('export FOO$N=1');
  hostConfig('env -- HOME=x ls');
  hostConfig('env -S"HOME=x ls"');
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
  hostConfig(inBash('read -p x HOME'));
  hostConfig(inBash('read -a HOME'));
  loading(inBash('read -ra BASH_ENV'));
  hostConfig(inBash('read -aHOME'));
  hostConfig(inBash('read -r -p "$P" HOME'));
  hostConfig(inBash('read $N'));
});

test('read (zsh): -p has no operand, every word is a name except the values of -u and -d', () => {
  hostConfig('read -p HOME line');
  hostConfig('read -p "$P" line');
  loading('read -r -p prompt PAGER');
  hostConfig('read -u 3 HOME');
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
  hostConfig('declare -x HOME');
  hostConfig('unset -v HOME');
  hostConfig('declare HOME -p');
});

test('any nameref declaration is opaque, whatever the name', () => {
  hostConfig('declare -n r=BASH_ENV');
  hostConfig('typeset -n r=HOME[0]');
  hostConfig('local -n r=PAGER');
  hostConfig('declare -nx r=HOME');
  hostConfig('declare -n r=$X');
  hostConfig('declare -n r=FOO');
  hostConfig('declare -n r; r=ok');
  hostConfig('typeset -n r');
  hostConfig('local -n r=ok');
  hostConfig('declare -n');
  plain('declare +n r');
  plain('declare r=BASH_ENV_X');
  plain('declare -x FOO=1');
});

test('expansion assignments of a listed name are opaque', () => {
  hostConfig('echo ${HOME:=/x}');
  hostConfig('echo ${HOME=/x}');
  loading('echo "${BASH_ENV:=f}"');
  hostConfig('echo $((HOME=1))');
  loading('echo $((BASH_ENV+=1))');
  hostConfig('echo $((x=1, HOME=2))');
  hostConfig('echo $((HOME++))');
  hostConfig('echo $((++HOME))');
  hostConfig('echo $((HOME[0]=1))');
  hostConfig('echo $(($n=1))');
  hostConfig('echo $(( HOME = 1 ))');
  hostConfig('cat <<EOF\n${HOME:=/x}\nEOF');
  loading('case ${PAGER:=less} in a) ls;; esac');
  hostConfig('FOO=${HOME:=/x} ls');
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
  hostConfig('for HOME in a b; do ls; done');
  loading('for BASH_ENV; do ls; done');
  plain('for i in a b; do ls; done');
  hostConfig('getopts ab HOME');
  hostConfig('getopts ab "$N"');
  plain('getopts ab opt');
  hostConfig('mapfile HOME');
  loading('mapfile -t -d x -n 3 BASH_ENV');
  hostConfig('readarray -t HOME');
  hostConfig('mapfile -t "$N"');
  plain('mapfile -t arr');
  plain('mapfile');
  plain('mapfile -C "$cb" -c 5 arr');
  hostConfig('let HOME=1');
  loading('let "BASH_ENV=3"');
  hostConfig('let i=1 HOME+=2');
  hostConfig('let $x=1');
  hostConfig('let "HOME$x=1"');
  hostConfig('let "x=1, HOME=2"');
  hostConfig('let HOME++');
  plain('let "x=1"');
  plain('let i++');
  plain('let "n=$n+1"');
  plain('let "n = n + 1"');
  hostConfig('print -v HOME x');
  loading('print -r -v BASH_ENV x');
  hostConfig('print -vHOME x');
  plain('print -r x');
  plain('print -u 2 -v out x');
  hostConfig('vared HOME');
  hostConfig('vared -p prompt HOME');
  plain('vared -p HOME line');
  plain('vared line');
  hostConfig('zparseopts -a HOME x:');
  loading('zparseopts -A BASH_ENV');
  loading('zparseopts -D -E -aPAGER x:');
  plain('zparseopts -D -E -a arr x:');
});

test('zparseopts spec words name targets too', () => {
  hostConfig('zparseopts x=HOME');
  loading('zparseopts -D -E x:=BASH_ENV');
  loading('zparseopts x+=PAGER');
  loading('zparseopts -D -E -- -foo=EDITOR');
  hostConfig('zparseopts -D -E a=b c::=HOME');
  hostConfig('zparseopts -D "$spec"');
  hostConfig('zparseopts -D x=$N');
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
  hostConfig('sudo -s HOME=x');
  hostConfig('sudo -i HOME=x');
  hostConfig('sudo -E HOME=x');
  hostConfig('sudo -u root -s HOME=x');
  hostConfig('doas -s HOME=x');
  hostConfig('su HOME=x');
  loading('sudo -s BASH_ENV=f');
  plain('sudo -s FOO=1');
  plain('sudo -E FOO=1');
  plain('ls HOME=x');
});

test('the offset of a late assignment points at its command', () => {
  assert.equal(hostConfig('ls; echo ${HOME:=x}').offset, 4);
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
  hostConfig('echo $(($n++))');
  hostConfig('echo $((++$n))');
  hostConfig('echo $((n--$m))'.replace('n--$m', '$n--'));
  hostConfig('echo $((--${n}))');
  hostConfig('let "$n++"'.replace('$n', '$N'));
  plain('echo $((n--))');
  plain('echo $((i++))');
  plain('echo $((1 + 2))');
  plain('echo $(($a + $b))');
});

test('zsh builtins that write a named variable name their target', () => {
  hostConfig('getln HOME');
  hostConfig('getln "$N"');
  loading('zstyle -s :ctx style PAGER');
  loading('zstyle -g BASH_ENV :ctx style');
  hostConfig('zformat -f HOME %a a:b');
  loading('zformat -a EDITOR : a:b');
  hostConfig('strftime -s HOME %Y 0');
  loading('strftime -rs PAGER %Y x');
  hostConfig('sysread -c HOME');
  loading('sysread -o 1 BASH_ENV');
  hostConfig('sysread HOME');
  hostConfig('sysread "$N"');
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
  hostConfig('typeset -F HOME=1');
  loading('local -F PAGER');
  hostConfig('typeset -E HOME');
  hostConfig('typeset -F HOME');
  plain('typeset -F x');
  plain('typeset -p HOME');
  plain('typeset -f HOME');
  hostConfig('typeset -p HOME=x');
  hostConfig('declare -p HOME=x');
  hostConfig(inBash('typeset -F HOME=x'));
  loading(inBash('declare -f BASH_ENV=1'));
  hostConfig('declare -p "HOME=$x"');
  hostConfig('export -n HOME');
  hostConfig(inBash('export -n HOME'));
  plain('export -n FOO');
  plain(inBash('read -r -p "$P" line'));
  plain(inBash('declare -p HOME'));
  plain(inBash('unset -f fn'));
});

// ---------------------------------------------------------------------------------------------
// Fix round 4
test('zsh integer and float declare like typeset', () => {
  hostConfig('integer HOME=1');
  loading('float PAGER=1');
  loading('integer -r BASH_ENV');
  hostConfig('integer "$N"=1');
  hostConfig('integer n=1 HOME');
  plain('integer n=1');
  plain('float x=1.5');
  plain('integer -p');
  // bash has no such builtins: they are plain commands there
  plain(inBash('integer HOME=1'));
});

test('zstyle -a/-b and zformat -F write their target too', () => {
  hostConfig('zstyle -a :c st HOME');
  loading('zstyle -b :c st PAGER');
  hostConfig('zformat -F HOME x');
  hostConfig('zformat -F "$N" x');
  plain('zstyle -a :c st arr');
  plain('zstyle -b :c st flag');
  plain('zformat -F out x');
});

test('zsh module builtins write named variables', () => {
  hostConfig('zselect -r HOME');
  loading('zselect -A BASH_ENV');
  hostConfig('zsystem flock -f HOME ./f');
  hostConfig('zsystem supports HOME');
  hostConfig('zstat -A HOME ./f');
  loading('zstat -H PAGER ./f');
  hostConfig('zstat +mtime -v HOME ./f');
  hostConfig('zstat -A "$N" ./f');
  hostConfig('pcre_match -a HOME -v PAGER x');
  hostConfig('private HOME=1');
  loading('private -a BASH_ENV');
  hostConfig('private "$N"=1');
  plain('zselect -r 0');
  plain('zsystem flock -f fd ./f');
  plain('zstat -A arr ./f');
  plain('zstat +mtime -v t ./f');
  plain('pcre_match -a arr -v v x');
  plain('private x=1');
  plain('private -a arr');
});

// ---------------------------------------------------------------------------------------------
// T2 host-config-var: the five names and the XDG_ prefix are split out of code-loading-var; every
// way to set, export, unset or clear one of them is `host-config-var`. The names stay in
// CODE_LOADING_VARS (doctor builds its lists from it); the host-config check runs first.

test('HOST_CONFIG_VARS lists the host-config names and prefix; they stay code-loading names', () => {
  assert.deepEqual([...HOST_CONFIG_VARS.names], ['HOME', 'FENCE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME']);
  assert.deepEqual([...HOST_CONFIG_VARS.prefixes], ['XDG_']);
  assert.ok(Object.isFrozen(HOST_CONFIG_VARS));
  for (const n of HOST_CONFIG_VARS.names) assert.ok(CODE_LOADING_VARS.names.includes(n), n);
  assert.ok(CODE_LOADING_VARS.prefixes.includes('XDG_'));
});

test('isHostConfigName: names, XDG_ prefix, subscripts and +, UNKNOWN; not the other code-loading names', () => {
  for (const n of ['HOME', 'FENCE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_', 'HOME[0]', 'HOME+']) {
    assert.equal(isHostConfigName(n), true, n);
  }
  assert.equal(isHostConfigName(UNKNOWN), true);
  assert.equal(isHostConfigName(undefined), true);
  for (const n of ['PAGER', 'EDITOR', 'NODE_OPTIONS', 'BASH_ENV', 'GIT_SSH_COMMAND', 'DYLD_X', 'npm_config_x', 'FOO', 'home', 'HOMEX', 'xdg_cache_home', '']) {
    assert.equal(isHostConfigName(n), false, n);
  }
});

test('setting, exporting, unsetting or clearing a host-config variable is host-config-var', () => {
  hostConfig('HOME=/tmp/x claude');
  hostConfig('export FENCE_PROFILE=relaxed');
  hostConfig('env CLAUDE_CONFIG_DIR=/tmp claude');
  hostConfig('unset FENCE_PROFILE; claude -p hi');
  hostConfig('env -u CODEX_HOME codex');
  hostConfig('env -i claude');
  hostConfig('XDG_CONFIG_HOME=/tmp x');
  hostConfig('printf -v HOME x');
  hostConfig('CLAUDE_CODE_PLUGIN_DIRS=/tmp x');
  hostConfig('env --unset=HOME ls');
  hostConfig('env -uHOME ls');
  hostConfig('env --ignore-environment ls');
  hostConfig('env - ls');
  hostConfig('sudo HOME=/tmp/h ls');
  hostConfig('doas HOME=/tmp/h ls');
  hostConfig('read HOME');
  hostConfig('declare -x HOME=/tmp/h');
  hostConfig('readonly CODEX_HOME');
  hostConfig('export XDG_DATA_HOME=x');
  hostConfig('bash -c "HOME=/tmp/h ls"');
  hostConfig('echo ${HOME:=/x}');
  hostConfig('echo $((HOME=1))');
});

test('a name that is not literal is host-config-var: it cannot be shown not to be HOME', () => {
  hostConfig('export $N');
  hostConfig('read $N');
  hostConfig('env -u $N ls');
  hostConfig('printf -v $N %s x');
  hostConfig('unset $(echo a)');
});

test('the other code-loading variables stay code-loading-var', () => {
  loading('PAGER=cat git log');
  loading('EDITOR=vim git commit');
  loading('NODE_OPTIONS=--require ./x node a.js');
  loading('export BASH_ENV=f');
  loading('env LD_PRELOAD=x ls');
  loading('unset NODE_OPTIONS');
  loading('GIT_CONFIG_COUNT=1 git status');
});

test('a host-config name assigned with +=, a subscript or an array is host-config-var', () => {
  hostConfig('HOME+=x ls');
  hostConfig('FENCE_PROFILE+=relaxed claude');
  hostConfig('XDG_CONFIG_HOME+=/x claude');
  hostConfig('HOME[0]=x ls');
  hostConfig('HOME[0]=x');
  hostConfig('HOME=(a) ls');
  hostConfig('bash -c "HOME+=x ls"');
  hostConfig('bash -c "FENCE_PROFILE+=relaxed claude"');
  hostConfig('bash -c "XDG_CONFIG_HOME+=/x claude"');
  hostConfig('bash -c "HOME[0]=x ls"');
  hostConfig('bash -c "HOME=(a) ls"');
  // a name that is not host-config keeps the parser's own construct
  assert.equal(opaque('FOO+=x ls').construct, 'append-assign');
  assert.equal(opaque('ARR=(a) ls').construct, 'array-assign');
  assert.equal(opaque('FOO[0]=x ls').construct, 'array-assign');
  assert.equal(opaque('bash -c "FOO+=x ls"').construct, 'append-assign');
  assert.equal(opaque('bash -c "ARR=(a) ls"').construct, 'array-assign');
});

test('exec -c clears the environment like env -i: host-config-var', () => {
  hostConfig('exec -c claude');
  hostConfig('exec -cl claude');
  hostConfig('exec -lc claude');
  hostConfig('exec -a name -c claude');
  hostConfig('exec -ca name claude');
  hostConfig('bash -c "exec -c claude"');
  // exec without -c, and a -c that is another flag's value, keep the environment
  plain('exec -l ls');
  plain('exec -a c ls');
  plain('exec ls');
});

test('a host-config prefix assignment anywhere in the command wins over an unmodelled assignment form', () => {
  hostConfig('HOME=/x FOO+=y claude');
  hostConfig('FOO+=y HOME=/x claude');
  hostConfig('FENCE_PROFILE=relaxed FOO+=y claude');
  hostConfig('FOO+=y FENCE_PROFILE=relaxed claude');
  hostConfig('HOME=/x ARR=(a) claude');
  hostConfig('ARR=(a) HOME=/x claude');
  hostConfig('HOME=/x FOO[0]=y claude');
  hostConfig('FOO[0]=y HOME=/x claude');
  hostConfig('FOO+=y XDG_CONFIG_HOME=/x claude');
  hostConfig('ARR=(a b) FOO=1 HOME=/x claude');
  hostConfig('bash -c "HOME=/x FOO+=y claude"');
  hostConfig('bash -c "FOO+=y HOME=/x claude"');
  hostConfig('bash -c "ARR=(a) HOME=/x claude"');
  // only assignment positions count: a HOME= argument after the command word does not
  assert.equal(opaque('FOO+=y echo HOME=1').construct, 'append-assign');
  assert.equal(opaque('ARR=(a) echo HOME=1').construct, 'array-assign');
  // no host-config name anywhere: the parser's own construct
  assert.equal(opaque('FOO=1 BAR+=y claude').construct, 'append-assign');
  assert.equal(opaque('FOO=1 ARR=(a) BAR=2 claude').construct, 'array-assign');
});

test('a declaration of a host-config name with a zsh =( value is host-config-var', () => {
  hostConfig('export HOME=(a)');
  hostConfig('local FENCE_PROFILE=(a)');
  hostConfig('typeset XDG_X=(a)');
  hostConfig('export FOO=1 HOME=(a)');
  hostConfig('export FOO=(a) HOME=x');
  hostConfig('export HOME=x FOO=(a)');
  hostConfig('bash -c "export HOME=(a)"');
  // another name keeps the zsh construct
  assert.equal(opaque('export FOO=(a)').construct, 'zsh-syntax');
  assert.equal(opaque('local BAR=(a)').construct, 'zsh-syntax');
  assert.equal(opaque('typeset FOO=1 BAR=(a)').construct, 'zsh-syntax');
});
