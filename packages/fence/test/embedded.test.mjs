import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize } from '../src/norm/normalize.mjs';
import { evaluate } from '../src/eval/evaluate.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';
import { embeddedCodeVerdict, awkProgramSafe, sedScript, isGitCodeKey, EDITORS_PAGERS } from '../src/tables/embedded.mjs';

// Hermetic fixtures: temp project dirs under os.tmpdir() (realpath'd), a fake home, an injected
// written index. Every program text, script, hook and git config below is an inert string that the
// normalizer only reads and tokenizes; nothing is ever executed (no python, node, perl, awk, sed,
// git or shell runs in this file).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-embedded-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

let counter = 0;
function project() {
  const d = path.join(TMP, `p${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

// A fake repository: the files git discovery looks for, a config text and a hooks directory holding
// only a sample (inert text).
function repo(config = '[core]\n\tbare = false\n') {
  const d = project();
  write(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(d, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(d, '.git', 'refs', 'heads'), { recursive: true });
  write(path.join(d, '.git', 'config'), config);
  write(path.join(d, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\necho sample\n', 0o755);
  return d;
}

function run(text, cwd, written = [], extra = {}) {
  return normalize(text, { cwd, home: HOME, env: {}, writtenIndex: new Set(written), writtenIndexIncomplete: false, ...extra });
}

function cmds(text, cwd, written, extra) {
  const r = run(text, cwd, written, extra);
  assert.ok(Array.isArray(r.commands), `expected commands for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r.commands;
}

function opaque(text, cwd, written, extra) {
  const r = run(text, cwd, written, extra);
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 400)}`);
  return r.opaque;
}

const find = (cs, prog) => cs.find((c) => c.argv[0] === prog);

// ---- the brief's named tests -------------------------------------------------------------------

test('rg --pre cmd is opaque', () => {
  const d = project();
  assert.equal(embeddedCodeVerdict(['rg', '--pre', 'cmd', 'x']), 'opaque');
  assert.equal(embeddedCodeVerdict(['rg', '--pre=cmd', 'x']), 'opaque');
  assert.equal(embeddedCodeVerdict(['rg', 'x', '.']), 'ok');
  assert.equal(opaque('rg --pre cmd x', d).construct, 'embedded-code');
  assert.ok(find(cmds('rg x .', d), 'rg'));
  // fd -x / -X run a command per match
  assert.equal(embeddedCodeVerdict(['fd', '-x', 'cmd']), 'opaque');
  assert.equal(embeddedCodeVerdict(['fd', '-X', 'cmd']), 'opaque');
  assert.equal(embeddedCodeVerdict(['fd', '--exec', 'cmd']), 'opaque');
  assert.equal(embeddedCodeVerdict(['fd', 'pattern', '.']), 'ok');
});

test(`awk 'BEGIN{system("x")}' is opaque and awk '{print $1}' is ok`, () => {
  const d = project();
  assert.equal(embeddedCodeVerdict(['awk', 'BEGIN{system("x")}']), 'opaque');
  assert.equal(embeddedCodeVerdict(['awk', '{print $1}', 'f']), 'ok');
  assert.equal(opaque(`awk 'BEGIN{system("x")}'`, d).construct, 'embedded-code');
  assert.ok(find(cmds(`awk '{print $1}' f`, d), 'awk'));
  // the other ways an awk program runs or writes outside its operands
  for (const p of ['{print | "sort"}', '{"date" | getline x}', '{print > "out"}', '{printf("%s", $1) >> "out"}', '{print $1 |& "cmd"}', '@load "x"', '{f = "system"; @f("x")}']) {
    assert.equal(awkProgramSafe(p), false, p);
  }
  // comparisons, strings and regexes are not code
  for (const p of ['$1 > 5 {print $1}', '{print "system | > x"}', '/a|b/ {print}', '{print ($1 > 2)}', '{x = $1 / 2; print x}', 'NR==1{next} {n++} END{print n}']) {
    assert.equal(awkProgramSafe(p), true, p);
  }
  // an UNKNOWN program is not proven clean; -f is a file of repository code
  assert.equal(opaque('awk "$(cat p)" f', d).construct, 'embedded-code');
  write(path.join(d, 'prog.awk'), '{print $1}\n');
  const c = find(cmds('awk -f prog.awk data', d), 'awk');
  assert.ok(c.classes.includes('runs-repo-code'), JSON.stringify(c));
  assert.ok(c.reads.includes(path.join(d, 'prog.awk')));
});

test('sed -i s/a/b/ f writes f, sed e is opaque', () => {
  const d = project();
  const c = find(cmds('sed -i s/a/b/ f', d), 'sed');
  assert.ok(c.writes.includes(path.join(d, 'f')), JSON.stringify(c.writes));
  assert.equal(embeddedCodeVerdict(['sed', 'e', 'f']), 'opaque');
  assert.equal(opaque('sed e f', d).construct, 'embedded-code');
  assert.equal(opaque(`sed 's/a/b/e' f`, d).construct, 'embedded-code');
  assert.equal(opaque(`sed -n -e '1{e date' -e '}' f`, d).construct, 'embedded-code');
  // w / W write their file, r / R read theirs
  const w = find(cmds(`sed 's/a/b/w out.txt' f`, d), 'sed');
  assert.ok(w.writes.includes(path.join(d, 'out.txt')), JSON.stringify(w.writes));
  const r = find(cmds(`sed '/x/r extra.txt' f`, d), 'sed');
  assert.ok(r.reads.includes(path.join(d, 'extra.txt')), JSON.stringify(r.reads));
  // BSD `sed -i SUFFIX SCRIPT`: the word after the suffix is read as a script too
  const bsd = find(cmds(`sed -i '' 's/a/b/w out2.txt' f`, d), 'sed');
  assert.ok(bsd.writes.includes(path.join(d, 'out2.txt')), JSON.stringify(bsd.writes));
  assert.deepEqual(sedScript('1d;$p;s/a/b/g;y/ab/cd/'), { reads: [], writes: [] });
  assert.ok(sedScript('s/a/b/ x').opaque, 'an unknown flag is not proven clean');
});

test('tar --to-command is opaque', () => {
  for (const argv of [
    ['tar', '--to-command=x', '-xf', 'a.tar'],
    ['tar', '-x', '--use-compress-program', 'x', '-f', 'a.tar'],
    ['tar', '-I', 'x', '-xf', 'a.tar'],
    ['tar', '--checkpoint-action=exec=x', '-xf', 'a.tar'],
    ['tar', '--info-script=x', '-xf', 'a.tar'],
    ['tar', 'xIf', 'x', 'a.tar'],
  ]) {
    assert.equal(embeddedCodeVerdict(argv), 'opaque', argv.join(' '));
  }
  assert.equal(embeddedCodeVerdict(['tar', '-xzf', 'a.tar.gz', '-C', 'out']), 'ok');
  assert.equal(opaque('tar --to-command=x -xf a.tar', project()).construct, 'embedded-code');
});

test('ssh -o ProxyCommand=x is opaque', () => {
  const d = project();
  assert.equal(opaque('ssh -o ProxyCommand=x h', d).construct, 'embedded-code');
  for (const argv of [
    ['ssh', '-oProxyCommand=x', 'h'],
    ['ssh', '-o', 'LocalCommand x', 'h'],
    ['ssh', '-F', 'cfg', 'h'],
    ['ssh', 'h', '-o', 'proxycommand=x'],
    ['scp', '-o', 'ProxyCommand=x', 'a', 'h:b'],
    ['scp', '-S', 'prog', 'a', 'h:b'],
    ['ssh', '-o', ' ProxyCommand=x', 'h'],
    ['ssh', '-o', '\tPROXYCOMMAND x', 'h'],
    ['sftp', '-oKnownHostsCommand=x', 'h'],
  ]) {
    assert.equal(embeddedCodeVerdict(argv), 'opaque', argv.join(' '));
  }
  // the remote command is not a local option
  assert.equal(embeddedCodeVerdict(['ssh', 'h', 'grep', '-F', 'x']), 'ok');
  assert.equal(embeddedCodeVerdict(['ssh', '-p', '22', 'h', 'ls']), 'ok');
});

test('vim file is opaque', () => {
  const d = project();
  assert.equal(opaque('vim file', d).construct, 'embedded-code');
  for (const p of ['less', 'more', 'man', 'vi', 'vim', 'nvim', 'emacs', 'nano', 'ed', 'ex', 'script', 'expect', 'parallel', 'watch', 'entr', 'view', 'gview', 'gvim', 'vimdiff', 'rvim', 'rview', 'pico', 'micro', 'joe', 'emacsclient', 'nvi']) {
    assert.ok(EDITORS_PAGERS.includes(p), p);
    assert.equal(embeddedCodeVerdict([p, 'x']), 'opaque', p);
  }
  // through a wrapper too
  assert.equal(opaque('sudo vim /etc/hosts', d).construct, 'embedded-code');
});

test(`python3 -I -c 'print(1)' is allowed and python3 -c 'import os' is opaque`, () => {
  const d = project();
  const c = find(cmds(`python3 -I -c 'print(1)'`, d), 'python3');
  assert.ok(!c.classes.includes('runs-repo-code'));
  assert.equal(opaque(`python3 -c 'import os'`, d).construct, 'interp-code');
  // an UNKNOWN code word
  assert.equal(opaque('python3 -c "$(cat f)"', d).construct, 'interp-code');
  // a heredoc and a herestring fed to python go through the same check
  assert.ok(find(cmds(`python3 <<'EOF'\nprint(1)\nEOF`, d), 'python3'));
  assert.equal(opaque(`python3 <<'EOF'\nimport os\nEOF`, d).construct, 'interp-code');
  assert.equal(opaque(`python3 <<< 'import os'`, d).construct, 'interp-code');
  // stdin is data when the code comes from -c
  assert.ok(find(cmds(`echo '{}' | python3 -I -c 'import json,sys; print(json.load(sys.stdin))'`, d), 'python3'));
  // the cwd rule: a json.py in the effective cwd shadows the module unless -I
  const s = project();
  write(path.join(s, 'json.py'), 'x = 1\n');
  assert.equal(opaque(`python3 -c 'import json; print(1)'`, s).construct, 'interp-code');
  assert.ok(find(cmds(`python3 -I -c 'import json; print(1)'`, s), 'python3'));
  // a json.py written earlier in the same call shadows too
  assert.equal(opaque(`echo x > json.py; python3 -c 'import json; print(1)'`, d).construct, 'interp-code');
  // an incomplete written index is unknown: opaque (checkPython gets writtenIndex=null)
  assert.equal(opaque(`python3 -I -c 'print(1)'`, d, [], { writtenIndexIncomplete: true }).construct, 'interp-code');
  // an agent-written startup file
  assert.equal(opaque(`python3 -I -c 'print(1)'`, d, [path.join(d, 'evil.pth')]).construct, 'interp-code');
  // open() reads are realpath-resolved against the effective cwd
  fs.mkdirSync(path.join(d, 'sub'));
  write(path.join(d, 'sub', 'data.txt'), 'x');
  const o = find(cmds(`cd sub && python3 -I -c 'print(open("data.txt").read())'`, d), 'python3');
  assert.ok(o.reads.includes(path.join(d, 'sub', 'data.txt')), JSON.stringify(o.reads));
  // reads through a symlink resolve to the real file
  fs.mkdirSync(path.join(d, 'real'));
  write(path.join(d, 'real', 'target.txt'), 'x');
  fs.symlinkSync(path.join('real', 'target.txt'), path.join(d, 'link.txt'));
  const l = find(cmds(`python3 -I -c 'print(open("link.txt").read())'`, d), 'python3');
  assert.ok(l.reads.includes(path.join(d, 'real', 'target.txt')), JSON.stringify(l.reads));
  assert.ok(!l.reads.includes(path.join(d, 'link.txt')));
  // flags that load code are not proven clean
  assert.equal(opaque(`python3 -W error::foo.Bar -c 'print(1)'`, d).construct, 'interp-flag');
  // -m stays runs-repo-code
  assert.ok(find(cmds('python3 -m http.server', d), 'python3').classes.includes('runs-repo-code'));
});

test(`node -e 'process.argv' is allowed`, () => {
  const d = project();
  const c = find(cmds(`node -e 'process.argv'`, d), 'node');
  assert.ok(!c.classes.includes('runs-repo-code'));
  assert.ok(find(cmds(`node -p 'JSON.stringify(process.argv)' a b`, d), 'node'));
  assert.ok(find(cmds(`node --no-warnings -e 'console.log(1)'`, d), 'node'));
  assert.equal(opaque(`node -e 'require("fs")'`, d).construct, 'interp-code');
  assert.equal(opaque('node -e "$(cat f)"', d).construct, 'interp-code');
  // preload, loader, env-file and inspector flags (and unknown long flags) gate the route
  for (const t of [
    `node -r ./x.js -e 'process.argv'`,
    `node --require=./x.js -e 'process.argv'`,
    `node --import ./x.mjs -e 'process.argv'`,
    `node --loader ./l.mjs -e 'process.argv'`,
    `node --experimental-loader ./l.mjs -e 'process.argv'`,
    `node --env-file=.env -e 'process.argv'`,
    `node --inspect -e 'process.argv'`,
    `node --inspect-brk=9229 -p 'process.argv'`,
    `node --some-new-flag -e 'process.argv'`,
    `node -e 'process.argv' --require ./x.js`,
  ]) {
    assert.equal(opaque(t, d).construct, 'interp-flag', t);
  }
  // a heredoc fed to node
  assert.ok(find(cmds(`node <<'EOF'\nconsole.log(process.argv)\nEOF`, d), 'node'));
  assert.equal(opaque(`node <<'EOF'\nrequire("fs")\nEOF`, d).construct, 'interp-code');
});

test('perl -e is opaque', () => {
  const d = project();
  for (const t of [
    `perl -e 'print 1'`,
    `perl -ne 'print'`,
    `ruby -e 'puts 1'`,
    `php -r 'echo 1;'`,
    `lua -e 'print(1)'`,
    // option values are skipped by each language's table, so the code flag after them is seen
    `perl -I lib -e 'print 1'`,
    `perl -Ilib -e 'print 1'`,
    `ruby -I lib -e 'puts 1'`,
    `php -d display_errors=1 -r 'echo 1;'`,
    `lua -l mod -e 'print(1)'`,
    // an option outside the table, an unsafe module value, a code-loading ini key
    `perl --frobnicate s.pl`,
    `perl '-MPOSIX;print 1' s.pl`,
    `php -d auto_prepend_file=x.php s.php`,
    // other interpreters
    `tclsh -encoding utf-8 -e x`,
    `Rscript -e 'print(1)'`,
    `julia -e 'println(1)'`,
    `deno eval 'console.log(1)'`,
    `bun -e 'console.log(1)'`,
  ]) {
    assert.equal(opaque(t, d).construct, 'embedded-code', t);
  }
  // a module name is a value, not a code flag
  assert.ok(find(cmds('perl -MExporter s.pl', d), 'perl'));
  assert.ok(find(cmds('ruby -rerb x.rb', d), 'ruby'));
  // a program read from a fed stdin
  for (const t of [`perl <<'EOF'\nprint 1\nEOF`, `php <<< 'echo 1;'`, `lua <<< 'print(1)'`, `ruby -w <<< 'puts 1'`, `Rscript - <<< 'print(1)'`, `julia <<< 'println(1)'`]) {
    assert.equal(opaque(t, d).construct, 'stdin-interpreter', t);
  }
  // pythonw and versioned spellings route through the python allowlist
  assert.equal(opaque(`pythonw -c 'import os'`, d).construct, 'interp-code');
  assert.equal(opaque(`python3.12 -c 'import os'`, d).construct, 'interp-code');
});

test('an allow rule on search still leaves rg --pre denied', () => {
  const d = project();
  const pol = validatePolicy({
    version: 1,
    profiles: { default: { undecided: 'host' } },
    // reads must be covered for an allow, so the rule names the project
    rules: [{ id: 'srch', decision: 'allow', match: { class: ['search'], paths: [`${d}/**`], access: 'read' }, why: 'searching is fine' }],
  });
  const opts = { profile: 'default', grants: [], ctx: { home: HOME, platform: process.platform, caseInsensitive: false } };
  const call = (command) => ({ host: 'claude', tool: 'Bash', kind: 'shell', cwd: d, command, paths: [] });
  assert.equal(evaluate(pol, call('rg x .'), run('rg x .', d), opts).decision, 'allow');
  const r = evaluate(pol, call('rg --pre cmd x'), run('rg --pre cmd x', d), opts);
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:opaque');
});

test('git alias with a ! body is normalized', () => {
  const d = repo('[core]\n\tbare = false\n[alias]\n\tnuke = "!rm -rf dist"\n\tst = status\n');
  const cs = cmds('git nuke', d);
  const rm = find(cs, 'rm');
  assert.ok(rm, JSON.stringify(cs));
  assert.deepEqual(rm.ops, [{ path: path.join(d, 'dist'), op: 'delete' }]);
  // the arguments are appended to the body
  const cs2 = cmds('git nuke build', d);
  assert.deepEqual(find(cs2, 'rm').argv, ['rm', '-rf', 'dist', 'build']);
  // a plain alias expands to the git command it names
  assert.ok(cmds('git st', d).some((c) => c.argv[0] === 'git' && c.argv[1] === 'status'));
  // a global alias (the fake home's .gitconfig)
  const h = project();
  write(path.join(h, '.gitconfig'), '[alias]\n\twipe = !rm -f x\n');
  const g = repo();
  assert.ok(find(cmds('git wipe', g, [], { home: h }), 'rm'));
  // an alias defined earlier in the same call is not on disk yet: opaque
  assert.ok(opaque(`git config alias.zap '!rm -rf .' && git zap`, d));
  // the system config's aliases count (an injected stand-in for /etc/gitconfig)
  const sys = write(path.join(project(), 'gitconfig'), '[alias]\n\tsysnuke = !rm -rf sysdist\n');
  assert.ok(find(cmds('git sysnuke', g, [], { gitSystemConfig: sys }), 'rm'));
  // plumbing names are builtins: an alias of that name never runs
  const pl = repo('[alias]\n\twrite-tree = !rm -rf dist\n');
  assert.ok(!find(cmds('git write-tree', pl), 'rm'));
});

test('git commit with an agent-written hook is opaque', () => {
  const d = repo();
  const hook = write(path.join(d, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook\n', 0o755);
  // the operator's executable hook: runs-repo-code
  const c = find(cmds('git commit -m x', d), 'git');
  assert.ok(c.classes.includes('runs-repo-code'), JSON.stringify(c));
  // the agent wrote it: opaque
  assert.equal(opaque('git commit -m x', d, [hook]).construct, 'git-hooks');
  // an incomplete index cannot rule it out
  assert.ok(opaque('git commit -m x', d, [], { writtenIndexIncomplete: true }));
  // an agent-written .git/config
  assert.ok(opaque('git push', d, [path.join(d, '.git', 'config')]));
  // a hook written earlier in the same call
  const e = repo();
  assert.ok(opaque(`echo 'echo hi' > .git/hooks/pre-commit && git commit -m x`, e));
  // no executable hook (only a sample): nothing to run
  const plain = find(cmds('git commit -m x', e), 'git');
  assert.ok(!plain.classes.includes('runs-repo-code'), JSON.stringify(plain));
  // core.hooksPath names the hooks directory
  const p = repo('[core]\n\thooksPath = myhooks\n');
  write(path.join(p, 'myhooks', 'pre-push'), '#!/bin/sh\necho hook\n', 0o755);
  assert.ok(find(cmds('git push', p), 'git').classes.includes('runs-repo-code'));
  assert.ok(opaque('git push', p, [path.join(p, 'myhooks', 'pre-push')]));
  // revert runs hooks too
  assert.ok(find(cmds('git revert HEAD', d), 'git').classes.includes('runs-repo-code'));
  // every ref-updating sub-command runs reference-transaction: an agent-written hook is opaque,
  // while runs-repo-code stays with the spec's list
  for (const t of ['git branch x', 'git tag v1', 'git fetch', 'git stash', 'git reset --hard', 'git update-ref refs/heads/x HEAD']) {
    assert.equal(opaque(t, d, [hook]).construct, 'git-hooks', t);
    assert.ok(!find(cmds(t, d), 'git').classes.includes('runs-repo-code'), t);
  }
  // the system config's core.hooksPath (an injected stand-in for /etc/gitconfig)
  const sys = write(path.join(project(), 'gitconfig'), '[core]\n\thooksPath = /nonexistent-hooks\n');
  const s = repo();
  const shook = write(path.join(s, 'syshooks', 'pre-commit'), '#!/bin/sh\necho hook\n', 0o755);
  write(sys, `[core]\n\thooksPath = ${path.join(s, 'syshooks')}\n`);
  assert.ok(find(cmds('git commit -m x', s, [], { gitSystemConfig: sys }), 'git').classes.includes('runs-repo-code'));
  assert.equal(opaque('git commit -m x', s, [shook], { gitSystemConfig: sys }).construct, 'git-hooks');
});

test('git -c core.sshCommand=x fetch is opaque', () => {
  const d = repo();
  assert.equal(opaque('git -c core.sshCommand=x fetch', d).construct, 'embedded-code');
  assert.equal(embeddedCodeVerdict(['git', '-c', 'alias.x=!rm', 'x']), 'opaque');
  assert.equal(embeddedCodeVerdict(['git', '-c', 'core.hooksPath=h', 'commit']), 'opaque');
  assert.equal(embeddedCodeVerdict(['git', '-c', 'diff.foo.textconv=x', 'diff']), 'opaque');
  assert.equal(embeddedCodeVerdict(['git', '-c', 'user.name=x', 'commit']), 'ok');
  // --exec-path=<dir> runs git's sub-commands from that directory; a bare --exec-path only prints
  assert.equal(opaque('git --exec-path=/x status', d).construct, 'embedded-code');
  assert.equal(embeddedCodeVerdict(['git', '--exec-path', 'status']), 'ok');
  assert.ok(find(cmds('git --exec-path', d), 'git'));
  for (const k of ['alias.x', 'core.hooksPath', 'core.sshCommand', 'core.pager', 'core.editor', 'core.fsmonitor', 'include.path', 'includeIf.gitdir:x.path', 'filter.lfs.clean', 'diff.x.textconv', 'credential.helper']) {
    assert.ok(isGitCodeKey(k), k);
  }
  assert.ok(!isGitCodeKey('user.email'));
});

test(`git config alias.x '!rm' adds .git/config to the written set`, () => {
  const d = repo();
  const c = find(cmds(`git config alias.x '!rm'`, d), 'git');
  assert.ok(c.writes.includes(path.join(d, '.git', 'config')), JSON.stringify(c.writes));
  // a later hook-running command in the same call sees the config as written
  assert.equal(opaque(`git config core.hooksPath h && git commit -m x`, d).construct, 'git-config-written');
  assert.equal(opaque(`git config core.hooksPath h; git commit -m x`, d).construct, 'git-config-written');
  assert.equal(opaque(`git config alias.zap '!rm -rf .' && git zap`, d).construct, 'git-config-written');
  assert.equal(opaque(`git config core.hooksPath h && git branch -f x`, d).construct, 'git-config-written');
  // a key that runs nothing is not added
  const u = find(cmds('git config user.name x', d), 'git');
  assert.ok(!u.writes.includes(path.join(d, '.git', 'config')), JSON.stringify(u.writes));
  // reads are not writes
  assert.ok(!find(cmds('git config --get alias.x', d), 'git').writes.includes(path.join(d, '.git', 'config')));
});

// ---- fix round 2 -------------------------------------------------------------------------------

test('an incomplete written index makes a ref update opaque only when an executable hook exists', () => {
  const d = repo();
  write(path.join(d, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\necho hook\n', 0o755);
  for (const t of ['git branch x', 'git tag v1', 'git fetch', 'git stash', 'git reset --hard', 'git update-ref refs/heads/x HEAD']) {
    // (reset --hard is also a T18 tree update, opaque git-config-written first under an incomplete index)
    assert.equal(opaque(t, d, [], { writtenIndexIncomplete: true }).construct, t === 'git reset --hard' ? 'git-config-written' : 'git-hooks', t);
    // a complete index without the agent's hook: clean, and no runs-repo-code off the spec's list
    assert.ok(!find(cmds(t, d), 'git').classes.includes('runs-repo-code'), t);
  }
  // a repository without hooks stays clean with an incomplete index
  const e = repo();
  assert.ok(find(cmds('git branch x', e, [], { writtenIndexIncomplete: true }), 'git'));
});

test('perl, ruby, php, lua, tclsh, Rscript, julia, bun and deno run a file as repository code', () => {
  const d = project();
  const cases = [
    ['perl s.pl', 's.pl'],
    ['perl -w -Ilib s.pl', 's.pl'],
    ['ruby x.rb', 'x.rb'],
    ['php s.php', 's.php'],
    ['php -f s.php', 's.php'],
    ['lua s.lua', 's.lua'],
    ['tclsh s.tcl', 's.tcl'],
    ['Rscript s.R', 's.R'],
    ['julia s.jl', 's.jl'],
    ['bun run s.ts', 's.ts'],
    ['bun s.ts', 's.ts'],
    ['deno run s.ts', 's.ts'],
  ];
  for (const [t, f] of cases) {
    const file = write(path.join(d, f), 'inert text\n');
    const c = cmds(t, d)[0];
    assert.ok(c.classes.includes('runs-repo-code'), t);
    assert.ok(c.reads.includes(file), `${t}: ${JSON.stringify(c.reads)}`);
    // the agent wrote the file: it cannot be normalized
    assert.equal(opaque(t, d, [file]).construct, 'agent-written-script', t);
    // an incomplete index counts as agent-written
    assert.equal(opaque(t, d, [], { writtenIndexIncomplete: true }).construct, 'agent-written-script', t);
  }
  // a package.json script name is still repository code
  assert.ok(cmds('bun run build', d)[0].classes.includes('runs-repo-code'));
  // options that load code
  for (const t of ['php -S localhost:8000', 'php -z ext.so s.php', 'php -c my.ini s.php', 'perl -d:Trace s.pl', 'perl -Ilib -MFoo']) {
    assert.equal(opaque(t, d).construct, 'embedded-code', t);
  }
});
