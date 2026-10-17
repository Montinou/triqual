import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import {
  unwrap,
  shellInvocation,
  decodeBase64,
  decodeHex,
  printfOutput,
  MAX_REPARSE_DEPTH,
} from '../src/norm/unwrap.mjs';

// Hermetic fixtures: a realpath'd temp root with a fake home inside it (never the real HOME).
// Every command hidden inside nested shells, eval text, heredocs and encoded text is harmless
// (touch ./marker, echo ok, ls, cat ./notes, mkdir ./d, cp ./a ./b, chmod 644 ./f, git status).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-unwrap-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
let counter = 0;
function dir() {
  const d = path.join(TMP, `d${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(text, cwd, env = {}) {
  return normalize(text, { cwd, home: HOME, env });
}
function cmds(text, cwd = dir(), env = {}) {
  const r = run(text, cwd, env);
  assert.ok(Array.isArray(r.commands), `expected commands for ${JSON.stringify(text).slice(0, 200)}, got ${JSON.stringify(r).slice(0, 300)}`);
  return r.commands;
}
function opaque(text, cwd = dir(), env = {}) {
  const r = run(text, cwd, env);
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text).slice(0, 200)}, got ${JSON.stringify(r).slice(0, 300)}`);
  return r.opaque;
}
const argvs = (cs) => cs.map((c) => c.argv);
const byProgram = (cs, p) => cs.filter((c) => c.argv[0] === p);
// Single-quote a text for a shell (`'` becomes `'\''`).
const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// `bash -c` wrapped around a text n times.
function nest(text, n) {
  let s = text;
  for (let i = 0; i < n; i++) s = `bash -c ${sq(s)}`;
  return s;
}

// ---- the brief's contract (payloads made harmless per the task's corpus ruling) ------------------

test("bash -c 'touch ./marker' yields touch", () => {
  const d = dir();
  const cs = cmds("bash -c 'touch ./marker'", d);
  // the bash process itself stays an effective command, the nested command follows it
  assert.deepEqual(argvs(cs), [['bash', '-c', 'touch ./marker'], ['touch', './marker']]);
  assert.equal(cs[1].cwd, d);
  assert.ok(cs[1].writes.includes(path.join(d, 'marker')), JSON.stringify(cs[1].writes));
  // the nested command's classes are its own, not folded into the parent
  const ch = cmds("bash -c 'chmod 644 ./f'", d);
  assert.deepEqual(ch[1].argv, ['chmod', '644', './f']);
  assert.ok(ch[1].classes.includes('perm-change'));
  assert.ok(!ch[0].classes.includes('perm-change'));
});

test('bash -lc and -euc clusters', () => {
  for (const t of [
    "bash -lc 'touch ./marker'",
    "sh -euc 'touch ./marker'",
    "bash -ec 'touch ./marker'",
    "sh -ceu 'touch ./marker'",
    "bash --norc -c 'touch ./marker'",
    "bash --posix -c 'touch ./marker'",
    "sh -c -- 'touch ./marker'",
    "bash -eo pipefail -c 'touch ./marker'",
    "bash -O extglob -c 'touch ./marker'",
    "/bin/dash -c 'touch ./marker'",
    "ksh -c 'touch ./marker'",
    "zsh -fc 'touch ./marker'",
    "exec sh -c 'touch ./marker'",
  ]) {
    const cs = cmds(t);
    assert.deepEqual(cs.at(-1).argv, ['touch', './marker'], t);
  }
  // extra words are $0 $1 …: UNKNOWN inside the text
  const cs = cmds("bash -c 'cat \"$1\" \"$0\"' arg0 ./notes");
  assert.deepEqual(cs.at(-1).argv, ['cat', UNKNOWN, UNKNOWN]);
  // an option that loads a file, or that is not understood, is opaque
  assert.equal(opaque("bash --rcfile ./rc -c 'echo ok'").construct, 'shell-option');
  assert.equal(opaque("bash --init-file ./rc -c 'echo ok'").construct, 'shell-option');
  // -c with nothing after it, or an UNKNOWN word where an option could go
  assert.equal(opaque('bash -c').construct, 'nested-script');
  assert.equal(opaque('bash "$Q" ./x').construct, 'nested-script');
});

test('eval with literal args joins with spaces', () => {
  const d = dir();
  let cs = cmds("eval echo 'ok'", d);
  assert.deepEqual(argvs(cs), [['eval', 'echo', 'ok'], ['echo', 'ok']]);
  cs = cmds("eval 'mkdir' './d'", d);
  assert.deepEqual(cs.at(-1).argv, ['mkdir', './d']);
  // the joined text is parsed again: quotes and operators inside the arguments count
  cs = cmds(`eval "touch ./marker;" "echo ok"`, d);
  assert.deepEqual(argvs(cs).slice(1), [['touch', './marker'], ['echo', 'ok']]);
  // a non-literal argument is opaque
  assert.equal(opaque('eval "$Q"', d).construct, 'eval-dynamic');
  assert.equal(opaque('eval echo $(ls)', d).construct, 'eval-dynamic');
  // tracked values are literal after substitution
  cs = cmds('X=ok; eval echo "$X"', d);
  assert.deepEqual(cs.at(-1).argv, ['echo', 'ok']);
  // eval runs in the current shell: after it the cwd is not trusted (as before T16)
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  cs = cmds("eval 'cd sub'; touch ./marker", d);
  assert.equal(cs.at(-1).cwd, UNKNOWN);
});

test('heredoc fed to sh is re-parsed', () => {
  const d = dir();
  let cs = cmds("sh <<'EOF'\ntouch ./marker\necho ok\nEOF", d);
  assert.deepEqual(argvs(cs), [['sh'], ['touch', './marker'], ['echo', 'ok']]);
  // an unquoted delimiter without expansions is literal too
  cs = cmds('bash <<EOF\nmkdir ./d\nEOF', d);
  assert.deepEqual(cs.at(-1).argv, ['mkdir', './d']);
  // expansions resolve through tracked values
  cs = cmds('X=ok; bash <<EOF\necho $X\nEOF', d);
  assert.deepEqual(cs.at(-1).argv, ['echo', 'ok']);
  // anything UNKNOWN in the body is opaque
  assert.equal(opaque('bash <<EOF\necho $Q\nEOF', d).construct, 'heredoc-dynamic');
  assert.equal(opaque('bash <<EOF\n$(ls)\nEOF', d).construct, 'heredoc-dynamic');
  // herestrings
  cs = cmds("sh <<< 'git status'", d);
  assert.deepEqual(cs.at(-1).argv, ['git', 'status']);
  assert.equal(opaque('sh <<< "$Q"', d).construct, 'heredoc-dynamic');
  // a heredoc or herestring piped from cat
  cs = cmds("cat <<'EOF' | sh\ncp ./a ./b\nEOF", d);
  assert.deepEqual(cs.at(-1).argv, ['cp', './a', './b']);
  cs = cmds("cat <<< 'ls' | bash", d);
  assert.deepEqual(cs.at(-1).argv, ['ls']);
  // echo and printf feeding a shell
  cs = cmds("echo 'cat ./notes' | sh", d);
  assert.deepEqual(cs.at(-1).argv, ['cat', './notes']);
  cs = cmds("printf '%s\\n' 'chmod 644 ./f' | bash", d);
  assert.deepEqual(cs.at(-1).argv, ['chmod', '644', './f']);
  assert.ok(cs.at(-1).classes.includes('perm-change'));
  cs = cmds("printf '\\x6c\\x73\\n' | sh", d);
  assert.deepEqual(cs.at(-1).argv, ['ls']);
});

test('echo dG91Y2ggLi9tYXJrZXI= | base64 -d | sh decodes to touch ./marker', () => {
  const d = dir();
  let cs = cmds('echo dG91Y2ggLi9tYXJrZXI= | base64 -d | sh', d);
  assert.deepEqual(argvs(cs), [['echo', 'dG91Y2ggLi9tYXJrZXI='], ['base64', '-d'], ['sh'], ['touch', './marker']]);
  assert.ok(cs.at(-1).writes.includes(path.join(d, 'marker')));
  for (const t of [
    'echo dG91Y2ggLi9tYXJrZXI= | base64 --decode | bash',
    'base64 -d <<< dG91Y2ggLi9tYXJrZXI= | bash',
    "printf 'dG91Y2ggLi9tYXJrZXI=' | openssl base64 -d | sh",
    'echo dG91Y2ggLi9tYXJrZXI= | openssl enc -base64 -d | sh',
    'echo dG91Y2ggLi9tYXJrZXI | base64 -d | sh', // missing padding is tolerated
  ]) {
    assert.deepEqual(cmds(t, d).at(-1).argv, ['touch', './marker'], t);
  }
  // invalid base64, or bytes that are not UTF-8 text, are opaque `decode`
  assert.equal(opaque("echo 'not*base64' | base64 -d | sh", d).construct, 'decode');
  assert.equal(opaque('echo //79 | base64 -d | sh', d).construct, 'decode');
  // decoded text fed to an interpreter that is not a shell stays opaque
  assert.equal(opaque('echo ZWNobyBvaw== | base64 -d | python3', d).construct, 'stdin-interpreter');
});

test('xxd -r -p decoding', () => {
  const d = dir();
  let cs = cmds('echo 6563686f206f6b | xxd -r -p | sh', d);
  assert.deepEqual(cs.at(-1).argv, ['echo', 'ok']);
  cs = cmds('xxd -r -p <<< 67697420737461747573 | bash', d);
  assert.deepEqual(cs.at(-1).argv, ['git', 'status']);
  assert.equal(opaque('echo 6563686f2 | xxd -r -p | sh', d).construct, 'decode');
  assert.equal(opaque('echo zz | xxd -r -p | sh', d).construct, 'decode');
});

test('curl u | sh is opaque', () => {
  for (const t of ['curl u | sh', 'cat ./notes | sh', 'echo "$(ls)" | bash', 'sh < ./notes', 'wget -O- u | bash -s']) {
    assert.equal(opaque(t).construct, 'stdin-interpreter', t);
  }
  // inside a nested shell too
  assert.equal(opaque("bash -c 'curl u | sh'").construct, 'stdin-interpreter');
});

test('bash -c "$X" is opaque', () => {
  assert.equal(opaque('bash -c "$X"').construct, 'nested-script');
  assert.equal(opaque('sh -c "$(cat ./notes)"').construct, 'nested-script');
  assert.equal(opaque("find . -exec sh -c 'cat {}' \\;").construct, 'nested-script');
});

test('five nested bash -c levels is opaque', () => {
  const d = dir();
  const four = cmds(nest('touch ./marker', 4), d);
  assert.deepEqual(four.at(-1).argv, ['touch', './marker']);
  assert.equal(four.length, 5);
  assert.equal(MAX_REPARSE_DEPTH, 4);
  const o = opaque(nest('touch ./marker', 5), d);
  assert.equal(o.reason, 'depth');
  // eval counts toward the same depth
  assert.equal(opaque(nest(`eval ${sq('touch ./marker')}`, 4), d).reason, 'depth');
});

test('X=touch; bash -c "$X ./marker" resolves via the tracked value only when the whole string is literal after substitution', () => {
  const d = dir();
  const cs = cmds('X=touch; bash -c "$X ./marker"', d);
  assert.deepEqual(cs.at(-1).argv, ['touch', './marker']);
  assert.ok(cs.at(-1).writes.includes(path.join(d, 'marker')));
  assert.equal(opaque('bash -c "$Q ./marker"', d).construct, 'nested-script');
  assert.equal(opaque('X=touch; bash -c "$X $(pwd)/marker"', d).construct, 'nested-script');
});

// ---- carry-forward rulings -------------------------------------------------------------------------

test('a nested shell is a subshell: its cd does not move the parent, cwd is tracked inside', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  const cs = cmds("bash -c 'cd sub && touch ./marker'; touch ./marker", d);
  assert.deepEqual(argvs(cs), [['bash', '-c', 'cd sub && touch ./marker'], ['cd', 'sub'], ['touch', './marker'], ['touch', './marker']]);
  assert.equal(cs[2].cwd, path.join(d, 'sub'));
  assert.equal(cs[3].cwd, d);
  // env -C moves the nested shell
  const moved = cmds(`env -C sub bash -c 'touch ./marker'`, d);
  assert.equal(moved.at(-1).cwd, path.join(d, 'sub'));
});

test('a nested shell sees exported and prefix values only; sudo and env reset them', () => {
  const d = dir();
  // not exported: the child does not inherit it
  assert.deepEqual(cmds("X=ok; bash -c 'echo $X'", d).at(-1).argv, ['echo', UNKNOWN]);
  assert.deepEqual(cmds("export X=ok; bash -c 'echo $X'", d).at(-1).argv, ['echo', 'ok']);
  assert.deepEqual(cmds("X=ok bash -c 'echo $X'", d).at(-1).argv, ['echo', 'ok']);
  // a value from the host environment is exported
  assert.deepEqual(cmds("X=ok; bash -c 'echo $X'", d, { X: 'host' }).at(-1).argv, ['echo', 'ok']);
  // the parent bash keeps its own prefix environment
  assert.deepEqual(cmds("X=ok bash -c 'echo ok'", d)[0].env, { X: 'ok' });
  // sudo and env replace the environment (and HOME): nothing is trusted inside
  assert.deepEqual(cmds("export X=ok; sudo bash -c 'echo $X'", d).at(-1).argv, ['echo', UNKNOWN]);
  assert.deepEqual(cmds("sudo bash -c 'cat ~/notes'", d).at(-1).argv, ['cat', UNKNOWN]);
  // (env -i clears the environment: since T17 the call is opaque instead, see envvars.test.mjs)
  assert.equal(opaque("export X=ok; env -i bash -c 'echo $X'", d).construct, 'code-loading-var');
  // without a wrapper the home is the payload's
  assert.deepEqual(cmds("bash -c 'cat ~/notes'", d).at(-1).argv, ['cat', path.join(HOME, 'notes')]);
});

test('glob ** inside bash/sh/dash text is UNKNOWN; zsh -c keeps zsh semantics', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'a'));
  fs.writeFileSync(path.join(d, 'a', 'notes'), '');
  assert.deepEqual(cmds("zsh -c 'cat **/notes'", d).at(-1).argv, ['cat', 'a/notes']);
  assert.deepEqual(cmds('cat **/notes', d).at(-1).argv, ['cat', 'a/notes']);
  for (const sh of ['bash', 'sh', 'dash', 'ksh']) {
    assert.deepEqual(cmds(`${sh} -c 'cat **/notes'`, d).at(-1).argv, ['cat', UNKNOWN], sh);
  }
  // a single star is the same in both
  assert.deepEqual(cmds("bash -c 'cat a/*'", d).at(-1).argv, ['cat', 'a/notes']);
});

test('wrapper scripts (env -S, flock -c, watch, find -exec sh -c) are re-parsed; sudo -s stays opaque', () => {
  const d = dir();
  assert.deepEqual(cmds("env -S 'touch ./marker'", d).at(-1).argv, ['touch', './marker']);
  assert.deepEqual(cmds("flock ./l -c 'echo ok'", d).at(-1).argv, ['echo', 'ok']);
  assert.deepEqual(cmds('watch -n 1 ls', d).at(-1).argv, ['ls']);
  let cs = cmds("find . -exec sh -c 'cp ./a ./b' \\;", d);
  assert.deepEqual(argvs(cs).slice(1), [['sh', '-c', 'cp ./a ./b'], ['cp', './a', './b']]);
  assert.equal(cs[0].argv[0], 'find');
  cs = cmds("find . -exec bash -ec 'cat \"$1\"' _ {} ';'", d);
  assert.deepEqual(cs.at(-1).argv, ['cat', UNKNOWN]);
  // sudo's own escaping of the joined words is not reconstructed
  assert.equal(opaque('sudo -s ls', d).construct, 'nested-script');
  // env -S splits its own syntax: anything beyond plain words, or other env options, is opaque
  assert.equal(opaque("env -S 'echo $X'", d).construct, 'nested-script');
  assert.equal(opaque("env -S 'ls; echo ok'", d).construct, 'nested-script');
  assert.equal(opaque("env -C sub -S 'ls'", d).construct, 'nested-script');
  assert.equal(opaque("env -S 'cat' ./notes", d).construct, 'nested-script');
});

test('nested opaque constructs propagate with the parent offset; never throws', () => {
  const t = "echo ok; bash -c 'cat <(ls)'";
  const o = opaque(t);
  assert.equal(o.offset, t.indexOf('bash'));
  for (const s of ["bash -c '", "bash -c 'if'", "eval 'fi'", "sh <<< ')'", "bash -c 'echo \"'", 'eval', 'eval ""']) {
    const r = run(s, dir());
    assert.ok(r && (Array.isArray(r.commands) || typeof r.opaque.reason === 'string'), s);
  }
  // unwrap itself never throws
  assert.deepEqual(unwrap(null, 0, null).opaque.reason, 'internal');
  assert.deepEqual(unwrap({ argv: ['bash', '-c', 'x'] }, 0, { reparse: () => { throw new Error('boom'); } }).opaque.reason, 'internal');
});

test('decoders: base64, hex and printf escapes', () => {
  assert.equal(decodeBase64('ZWNo\nbyBvaw=='), 'echo ok');
  assert.equal(decodeBase64('ZWNobyBvaw'), 'echo ok');
  assert.equal(decodeBase64('Pz8_'), '???'); // base64url
  assert.equal(decodeBase64('Pj4-'), '>>>');
  assert.equal(decodeBase64('a=b').construct, 'decode');
  assert.equal(decodeBase64('AA==').construct, 'decode'); // NUL is binary, not text
  assert.equal(decodeHex('6563686f\n206f6b'), 'echo ok');
  assert.equal(decodeHex('abc').construct, 'decode');
  assert.equal(printfOutput(['printf', 'echo %s\\n', 'ok']), 'echo ok\n');
  assert.equal(printfOutput(['printf', '%s;', 'ls', 'echo ok']), 'ls;echo ok;');
  // astral characters survive (one code point, not two UTF-16 halves)
  assert.equal(printfOutput(['printf', 'touch ./\u{1F600}\\n']), 'touch ./\u{1F600}\n');
  assert.equal(printfOutput(['printf', '%s', 'touch ./\u{1F600}']), 'touch ./\u{1F600}');
  assert.equal(printfOutput(['printf', '100%%']), '100%');
  assert.equal(printfOutput(['printf', '\\q']).construct, 'decode');
  assert.equal(printfOutput(['printf', '%d', '1']).construct, 'decode');
  assert.equal(printfOutput(['printf', '-v', 'X', 'ls']), null);
  // the output is capped
  assert.equal(printfOutput(['printf', 'x'.repeat(1000) + '%s', ...Array(100).fill('y')]).reason, 'size');
});

test('shellInvocation reads -c, stdin and file modes', () => {
  assert.deepEqual(shellInvocation(['bash', '-c', 'ls', 'a0']), { mode: 'c', text: 'ls', kind: 'bash' });
  assert.deepEqual(shellInvocation(['zsh', '-c', 'ls']), { mode: 'c', text: 'ls', kind: 'zsh' });
  assert.deepEqual(shellInvocation(['sh']), { mode: 'stdin', kind: 'bash' });
  assert.deepEqual(shellInvocation(['bash', '-s', 'a1']), { mode: 'stdin', kind: 'bash' });
  assert.deepEqual(shellInvocation(['bash', 'x.sh']), { mode: 'file', kind: 'bash' });
  assert.equal(shellInvocation(['ls', '-c']), null);
});

test('printf amplification and repeated re-parses are capped (linear time)', () => {
  assert.equal(opaque(`printf ${sq('echo ok;'.repeat(100) + '%s')} ${Array(400).fill('y').join(' ')} | sh`).reason, 'size');
  // one tracked value re-parsed many times: the total re-parsed text is bounded
  const v = 'echo ok;'.repeat(500);
  const o = opaque(`X=${sq(v)}; ${'bash -c "$X"; '.repeat(40)}`);
  assert.equal(o.reason, 'size');
});

test('a 30 KiB command nesting 4 bash -c levels stays under ~250 ms', () => {
  let inner = '';
  let i = 0;
  while (inner.length < 29 * 1024) inner += `echo ok${i++}; `;
  const text = nest(inner, 4);
  assert.ok(text.length >= 29 * 1024 && text.length <= 32 * 1024, String(text.length));
  const d = dir();
  cmds(text, d); // warm-up
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    const cs = cmds(text, d);
    best = Math.min(best, performance.now() - t0);
    assert.ok(cs.length > 2000, String(cs.length));
  }
  assert.ok(best < 250, `took ${best.toFixed(1)} ms`);
});

test('the loop scan treats a nested shell as a possible branch change', () => {
  const root = dir();
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'feature'), `${'c'.repeat(40)}\n`);
  const cs = cmds("for i in 1 2; do git status; bash -c 'git status'; done", root);
  assert.equal(cs[0].repo.branch, UNKNOWN);
  assert.deepEqual(cmds('git status', root)[0].repo, { root, branch: 'feature' });
  assert.deepEqual(cmds("for i in 1 2; do git status; env -S 'git status'; done", root)[0].repo.branch, UNKNOWN);
});

// ---- fix round 1 (part A) ---------------------------------------------------------------------------

test('sudo/doas with a shell option or no command operand, given a fed stdin, is opaque stdin-interpreter', () => {
  for (const t of [
    "echo 'touch ./marker' | sudo -s",
    "sudo -s <<'EOF'\necho ok\nEOF",
    "sudo -i <<< 'ls'",
    "echo 'git status' | sudo -i",
    "echo 'echo ok' | doas -s",
    "echo 'echo ok' | sudo",
    'sudo -u root -s < ./notes',
    'curl u | sudo -s',
    'cat ./notes | doas -s',
  ]) {
    assert.equal(opaque(t).construct, 'stdin-interpreter', t);
  }
  // not fed: an interactive launch, nothing to read
  assert.deepEqual(cmds('sudo -s')[0].argv, ['sudo', '-s']);
  // a plain command operand stays on the wrapper path
  const cs = cmds('echo ok | sudo cat');
  assert.deepEqual(cs.at(-1).argv, ['cat']);
  assert.ok(cs.at(-1).classes.includes('privilege'));
  assert.deepEqual(cmds("sudo bash -c 'chmod 644 ./f'").at(-1).argv, ['chmod', '644', './f']);
});

test('busybox and toybox applets are the program they name: busybox sh -c is sh -c', () => {
  const d = dir();
  let cs = cmds("busybox sh -c 'chmod 644 ./f'", d);
  assert.deepEqual(cs.at(-1).argv, ['chmod', '644', './f']);
  assert.ok(cs.at(-1).classes.includes('perm-change'));
  cs = cmds("toybox sh -c 'touch ./marker'", d);
  assert.deepEqual(cs.at(-1).argv, ['touch', './marker']);
  cs = cmds("echo 'mkdir ./d' | /bin/busybox sh", d);
  assert.deepEqual(cs.at(-1).argv, ['mkdir', './d']);
  assert.equal(opaque("busybox sh -c \"$Q\"", d).construct, 'nested-script');
  // busybox's ash applet is not one of the five shells parsed here
  assert.equal(opaque("echo 'mkdir ./d' | busybox ash", d).construct, 'foreign-shell');
});

test('foreign shells with inline code or a fed stdin, and command runners with a command operand, are opaque foreign-shell', () => {
  const d = dir();
  for (const t of [
    "csh -c 'echo ok'",
    "tcsh -fc 'ls'",
    "fish -c 'echo ok'",
    "fish --command='echo ok'",
    "mksh -c 'ls'",
    "ksh93 -c 'ls'",
    "ash -c 'ls'",
    "yash -c 'ls'",
    "rc -c 'ls'",
    "nu -c 'ls'",
    "pwsh -Command 'echo ok'",
    "pwsh -c 'echo ok'",
    "powershell -command 'echo ok'",
    'pwsh -EncodedCommand ZQBjAGgAbwA=',
    "xonsh -c 'ls'",
    "elvish -c 'ls'",
    "osh -c 'ls'",
    "ysh -c 'ls'",
    "fish --init-command='ls'",
    "fish --init-command 'ls'",
    "pwsh -CommandWithArgs 'ls'",
    "nu --commands 'ls'",
    "su -c 'chmod 644 ./f'",
    "su root -c 'ls'",
    "su --session-command='ls'",
    "su --session-command 'ls'",
    "runuser -u nobody -- sh -c ls",
    "runuser -c 'ls' nobody",
    "sg staff -c 'ls'",
    'sg staff ls',
    "echo 'echo ok' | fish",
    "csh <<'EOF'\nls\nEOF",
    "tcsh <<< 'ls'",
    'fish < ./notes',
    'fish "$Q"',
    "script -q -c 'touch ./marker' /dev/null",
    "script --command='ls' ./log",
    'script ./log ls',
    "expect -c 'spawn ls'",
    'expect ./run.exp',
    "echo 'spawn ls' | expect",
    "tmux new-session 'touch ./marker'",
    'tmux send-keys ls Enter',
    "tmux -c 'ls'",
    "screen -dm sh -c 'echo ok'",
    'screen ls',
  ]) {
    assert.equal(opaque(t, d).construct, 'foreign-shell', t);
  }
  // a bare launch (no code, nothing fed) is not opaque
  for (const t of ['fish', 'pwsh', 'csh -f', 'fish --version', 'tmux', 'screen -r', 'script', 'script ./log', 'su', 'su - root', 'sg staff', 'newgrp staff']) {
    assert.ok(Array.isArray(run(t, d).commands), t);
  }
});

test('an alias defined earlier in the call makes a later use of its name, and any re-parsed text, opaque', () => {
  const d = dir();
  assert.equal(opaque("alias x='touch ./marker'; eval x", d).construct, 'alias');
  assert.equal(opaque("alias x='touch ./marker'; x", d).construct, 'alias');
  assert.equal(opaque("alias x='touch ./marker'; sudo x", d).construct, 'alias');
  assert.equal(opaque("alias x='touch ./marker'; bash -c 'ls'", d).construct, 'alias');
  // an alias defined inside nested code reaches the parent's later commands too
  assert.equal(opaque("eval \"alias x='touch ./marker'\"; x", d).construct, 'alias');
  // the global and suffix forms, and a name that is not literal: every later command is suspect
  assert.equal(opaque("alias -g G='./marker'; touch G", d).construct, 'alias');
  assert.equal(opaque('alias "$N"=ls; ls', d).construct, 'alias');
  assert.equal(opaque("aliases[x]='touch ./marker'; ls", d).construct, 'array-assign'); // already opaque
  // an unrelated command stays normal, and so does a name that was never defined
  const ok = cmds("alias x='echo ok'; touch ./marker", d);
  assert.deepEqual(ok.at(-1).argv, ['touch', './marker']);
  // unalias forgets exactly the name it gives; -a forgets all
  assert.deepEqual(cmds("alias x='echo ok'; unalias x; x", d).at(-1).argv, ['x']);
  assert.equal(opaque("alias x='echo ok'; alias y='echo ok'; unalias x; y", d).construct, 'alias');
  assert.deepEqual(cmds("alias x='echo ok'; alias y='echo ok'; unalias -a; y", d).at(-1).argv, ['y']);
  assert.deepEqual(cmds("alias x='echo ok'; unalias x; eval 'touch ./marker'", d).at(-1).argv, ['touch', './marker']);
});

test('su, runuser, sg and newgrp read a fed stdin as a shell: opaque stdin-interpreter', () => {
  const d = dir();
  for (const t of ["echo 'ls' | su", "echo 'ls' | su root", "echo 'ls' | runuser -u nobody", 'su root <<< "ls"', "echo 'ls' | newgrp staff"]) {
    assert.equal(opaque(t, d).construct, 'stdin-interpreter', t);
  }
});
