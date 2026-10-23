import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stripWrappers, shellScript } from '../src/tables/wrappers.mjs';
import { classesOf } from '../src/tables/classes.mjs';
import { normalize, FINISH_STEPS } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// Hermetic fixtures: a realpath'd temp root with a fake home inside it (never the real HOME).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-wrap-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
let counter = 0;
function dir() {
  const d = path.join(TMP, `d${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cmds(text, cwd = dir()) {
  const r = normalize(text, { cwd, home: HOME, env: {} });
  assert.ok(Array.isArray(r.commands), `expected commands for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r.commands;
}
function opaque(text, cwd = dir()) {
  const r = normalize(text, { cwd, home: HOME, env: {} });
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 300)}`);
  return r.opaque;
}
const strip = (...argv) => stripWrappers(argv);
const inner = (...argv) => {
  const r = stripWrappers(argv);
  assert.ok(!r.opaque, `unexpected opaque for ${argv.join(' ')}: ${JSON.stringify(r)}`);
  return r.inner;
};
const construct = (...argv) => {
  const r = stripWrappers(argv);
  assert.ok(r.opaque, `expected opaque for ${argv.join(' ')}, got ${JSON.stringify(r)}`);
  return r.opaque.construct;
};

// ---- the brief's contract -------------------------------------------------------------------------

test('sudo -u root rm x strips to rm x and keeps privilege', () => {
  const r = strip('sudo', '-u', 'root', 'rm', 'x');
  assert.deepEqual(r.inner, ['rm', 'x']);
  assert.deepEqual(r.wrappers, ['sudo']);
  assert.deepEqual(r.scripts, []);
  assert.ok(classesOf(r.layers[0]).includes('privilege'));
  const d = dir();
  const [c] = cmds('sudo -u root rm x', d);
  assert.deepEqual(c.argv, ['rm', 'x']);
  assert.ok(c.classes.includes('privilege'));
  assert.ok(c.classes.includes('delete'));
  assert.deepEqual(c.ops, [{ path: path.join(d, 'x'), op: 'delete' }]);
  // the motivating case: the protected path is seen as rm's target, with privilege
  const [p] = cmds('sudo -u root rm -rf ~/.claude', d);
  assert.deepEqual(p.argv, ['rm', '-rf', path.join(HOME, '.claude')]);
  assert.ok(p.classes.includes('privilege') && p.classes.includes('delete'));
  assert.ok(p.writes.includes(path.join(HOME, '.claude')));
});

test('timeout 30 rm x', () => {
  assert.deepEqual(inner('timeout', '30', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(strip('timeout', '30', 'rm', 'x').wrappers, ['timeout']);
  assert.deepEqual(inner('timeout', '--signal=KILL', '5', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('timeout', '-s', 'KILL', '5', 'rm'), ['rm']);
  assert.deepEqual(inner('timeout', '-k5', '-sKILL', '--preserve-status', '5', 'rm'), ['rm']);
  assert.deepEqual(inner('timeout', '--kill', '1', '5', 'rm'), ['rm']); // unique prefix of --kill-after
  // an UNKNOWN word before the command may be a flag that shifts every later word: opaque
  assert.equal(construct('timeout', UNKNOWN, 'rm', 'x'), 'command-word');
  // no command: nothing to strip
  assert.deepEqual(strip('timeout', '5'), { inner: ['timeout', '5'], wrappers: [], scripts: [], layers: [], env: {}, chdirs: [], reads: [], writes: [], execs: [], external: false });
  assert.deepEqual(cmds('timeout 30 rm x')[0].argv, ['rm', 'x']);
});

test('env A=1 B=2 cmd', () => {
  const r = strip('env', 'A=1', 'B=2', 'cmd');
  assert.deepEqual(r.inner, ['cmd']);
  assert.deepEqual(r.env, { A: '1', B: '2' });
  assert.deepEqual(r.wrappers, ['env']);
  const [c] = cmds('env A=1 B=2 cmd');
  assert.deepEqual(c.argv, ['cmd']);
  assert.deepEqual(c.env, { A: '1', B: '2' });
  // after the first assignment env parses no more options: `-i` is the program
  assert.deepEqual(inner('env', 'A=1', '-i', 'cmd'), ['-i', 'cmd']);
  assert.deepEqual(inner('env', '-i', 'PATH=/x', 'rm', 'y'), ['rm', 'y']);
  assert.deepEqual(strip('env', '-i', 'PATH=/x', 'rm', 'y').env, { PATH: '/x' });
  assert.deepEqual(inner('env', '-', 'rm'), ['rm']); // `-` is -i
  assert.deepEqual(inner('env', '-u', 'HOME', '--unset=X', 'rm'), ['rm']);
  assert.deepEqual(inner('env', '-uHOME', '-0', 'rm'), ['rm']);
  // env with no command prints the environment: not unwrapped, still env-dump
  assert.deepEqual(strip('env', 'A=1').inner, ['env', 'A=1']);
  assert.deepEqual(strip('env', '-i').wrappers, []);
  assert.ok(cmds('env')[0].classes.includes('env-dump'));
  // `env FOO=1 cmd` differs from bare env
  assert.ok(!cmds('env FOO=1 ls')[0].classes.includes('env-dump'));
});

test('nice -n 5 cmd', () => {
  assert.deepEqual(inner('nice', '-n', '5', 'cmd'), ['cmd']);
  assert.deepEqual(inner('nice', '-n5', 'cmd'), ['cmd']);
  assert.deepEqual(inner('nice', '-5', 'cmd'), ['cmd']); // obsolete -N
  assert.deepEqual(inner('nice', '-n', '-5', 'cmd'), ['cmd']);
  assert.deepEqual(inner('nice', '--adjustment=5', 'cmd'), ['cmd']);
  assert.deepEqual(inner('nice', '--adj', '5', 'cmd'), ['cmd']);
  assert.deepEqual(strip('nice').inner, ['nice']); // prints the niceness
  const [c] = cmds('nice -n5 rm x');
  assert.deepEqual(c.argv, ['rm', 'x']);
  assert.ok(c.classes.includes('delete'));
});

test('xargs rm marks stdin args UNKNOWN', () => {
  assert.deepEqual(inner('xargs', 'rm'), ['rm', UNKNOWN]);
  assert.deepEqual(inner('xargs', '-0', 'rm', '-f'), ['rm', '-f', UNKNOWN]);
  assert.deepEqual(inner('xargs', '-0n1', '-P4', 'rm'), ['rm', UNKNOWN]);
  // -I replaces its string and appends nothing
  assert.deepEqual(inner('xargs', '-0', '-I{}', 'rm', '{}'), ['rm', UNKNOWN]);
  assert.deepEqual(inner('xargs', '-I', 'F', 'mv', 'F', 'F.bak'), ['mv', UNKNOWN, UNKNOWN]);
  assert.deepEqual(inner('xargs', '-i', 'rm', '{}'), ['rm', UNKNOWN]);
  assert.deepEqual(inner('xargs', '--replace=@', 'cp', '@', 'dst'), ['cp', UNKNOWN, 'dst']);
  // -a FILE is a read; no command runs echo
  assert.deepEqual(strip('xargs', '-a', 'list', 'rm').reads, ['list']);
  assert.deepEqual(inner('xargs'), ['echo', UNKNOWN]);
  const [c] = cmds('xargs rm');
  assert.deepEqual(c.argv, ['rm', UNKNOWN]);
  assert.ok(c.classes.includes('delete'));
  assert.ok(c.writes.includes(UNKNOWN));
  const d = dir();
  assert.ok(cmds('xargs -a list rm', d)[0].reads.includes(path.join(d, 'list')));
});

test('find . -exec rm {} + yields rm', () => {
  const r = strip('find', '.', '-exec', 'rm', '{}', '+');
  assert.deepEqual(r.inner, ['find', '.', '-exec', 'rm', '{}', '+']);
  assert.deepEqual(r.execs, [{ argv: ['rm', UNKNOWN], dir: 'same' }]);
  const d = dir();
  const cs = cmds('find . -exec rm {} +', d);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].argv[0], 'find');
  assert.ok(cs[0].classes.includes('search') && cs[0].classes.includes('delete')); // find keeps its own effects
  assert.deepEqual(cs[1].argv, ['rm', UNKNOWN]);
  assert.ok(cs[1].classes.includes('delete'));
  assert.equal(cs[1].cwd, d);
  // several clauses, ; and \; terminators, -execdir runs somewhere unknown
  const m = strip('find', '.', '-name', '*.o', '-exec', 'rm', '-f', '{}', ';', '-execdir', 'chmod', '600', '{}', '+', '-ok', 'mv', '{}', '{}.bak', ';');
  assert.deepEqual(m.execs, [
    { argv: ['rm', '-f', UNKNOWN], dir: 'same' },
    { argv: ['chmod', '600', UNKNOWN], dir: 'unknown' },
    { argv: ['mv', UNKNOWN, UNKNOWN], dir: 'same' },
  ]);
  assert.equal(cmds('find . -execdir rm {} +')[1].cwd, UNKNOWN);
  // a primary's value is not a primary
  assert.deepEqual(strip('find', '.', '-name', '-exec').execs, []);
  // an UNKNOWN program in a clause is opaque
  assert.equal(construct('find', '.', '-exec', UNKNOWN, '{}', ';'), 'command-word');
});

test('an unknown flag on sudo is opaque', () => {
  assert.equal(construct('sudo', '-Z', 'rm', 'x'), 'wrapper-flag');
  assert.equal(construct('sudo', '--frobnicate', 'rm'), 'wrapper-flag');
  assert.equal(construct('sudo', '-nZ', 'rm'), 'wrapper-flag');
  assert.equal(construct('timeout', '--bogus', '5', 'rm'), 'wrapper-flag');
  assert.equal(construct('nice', '-q', 'rm'), 'wrapper-flag');
  assert.equal(construct('env', '--nope', 'rm'), 'wrapper-flag');
  assert.equal(construct('xargs', '-Q', 'rm'), 'wrapper-flag');
  // a value-less flag given a value, an ambiguous prefix whose arities disagree, chroot
  assert.equal(construct('sudo', '--non-interactive=1', 'rm'), 'wrapper-flag');
  assert.equal(construct('sudo', '--p', 'rm'), 'wrapper-flag');
  assert.equal(construct('sudo', '-R', '/', 'rm'), 'wrapper-flag');
  assert.equal(opaque('sudo -Z rm -rf x').construct, 'wrapper-flag');
});

test("env -S 'rm x' yields a script", () => {
  const r = strip('env', '-S', 'rm x');
  assert.deepEqual(r.scripts, ['rm x']);
  assert.deepEqual(strip('env', '--split-string=rm x').scripts, ['rm x']);
  assert.deepEqual(strip('env', '-Srm x').scripts, ['rm x']);
  assert.deepEqual(strip('flock', '-c', 'rm x').scripts, ['rm x']);
  assert.deepEqual(strip('flock', '/tmp/l', '-c', 'rm x').scripts, ['rm x']);
  assert.deepEqual(strip('flock', '-n', '/tmp/l', '--command=rm x').scripts, ['rm x']);
  assert.deepEqual(strip('watch', 'rm', 'x').scripts, ['rm x']);
  assert.deepEqual(strip('watch', '-n', '1', 'ls -l').scripts, ['ls -l']);
  assert.deepEqual(strip('sudo', 'env', '-S', 'rm x').wrappers, ['sudo']);
  // T16 re-parses script layers after the layer itself; sudo -s stays opaque (sudo's escaping of
  // the joined words is not reconstructed)
  assert.deepEqual(cmds("env -S 'touch ./marker'").map((c) => c.argv), [['env', '-S', 'touch ./marker'], ['touch', './marker']]);
  assert.deepEqual(cmds("flock /tmp/l -c 'echo ok'").at(-1).argv, ['echo', 'ok']);
  // T32: watch is on the spec's embedded-code list: the normalizer is opaque on it
  assert.equal(opaque('watch ls').construct, 'embedded-code');
  assert.equal(opaque('sudo -s ls').construct, 'nested-script');
  // watch -x runs its argv directly
  assert.deepEqual(inner('watch', '-x', 'rm', 'x'), ['rm', 'x']);
});

test('command -v rm is not stripped', () => {
  assert.deepEqual(strip('command', '-v', 'rm').inner, ['command', '-v', 'rm']);
  assert.deepEqual(strip('command', '-v', 'rm').wrappers, []);
  assert.deepEqual(strip('command', '-V', 'rm').inner, ['command', '-V', 'rm']);
  assert.deepEqual(strip('command', '-pv', 'rm').wrappers, []);
  assert.deepEqual(inner('command', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('command', '-p', '--', 'rm'), ['rm']);
  assert.deepEqual(cmds('command -v rm')[0].argv, ['command', '-v', 'rm']);
  assert.ok(!cmds('command -v rm')[0].classes.includes('delete'));
  assert.ok(cmds('command rm x')[0].classes.includes('delete'));
});

test('nested wrappers sudo timeout nice', () => {
  const r = strip('sudo', 'timeout', '5', 'nice', '-n', '5', 'rm', '-rf', 'x');
  assert.deepEqual(r.inner, ['rm', '-rf', 'x']);
  assert.deepEqual(r.wrappers, ['sudo', 'timeout', 'nice']);
  assert.equal(r.layers.length, 3);
  assert.deepEqual(r.layers[1], ['timeout', '5', 'nice', '-n', '5', 'rm', '-rf', 'x']); // full inner argv
  const [c] = cmds('sudo timeout 5 nice -n 5 rm -rf x');
  assert.deepEqual(c.argv, ['rm', '-rf', 'x']);
  assert.ok(c.classes.includes('privilege') && c.classes.includes('delete'));
  // depth is bounded at 8 layers
  const deep = Array(9).fill('nice');
  assert.deepEqual(inner(...Array(8).fill('nice'), 'rm'), ['rm']);
  assert.equal(stripWrappers([...deep, 'rm']).opaque.reason, 'depth');
  assert.equal(opaque(`${deep.join(' ')} rm x`).reason, 'depth');
});

// ---- adversarial flag parsing -----------------------------------------------------------------------

test('sudo: clusters, attached values, long options, assignments, -- and dash program names', () => {
  assert.deepEqual(inner('sudo', '-nEu', 'root', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('sudo', '-nuroot', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('sudo', '-uroot', 'rm'), ['rm']);
  assert.deepEqual(inner('sudo', '--user=root', 'rm'), ['rm']);
  assert.deepEqual(inner('sudo', '--user', 'root', 'rm'), ['rm']);
  assert.deepEqual(inner('sudo', '--us', 'root', 'rm'), ['rm']); // unique prefix
  assert.deepEqual(inner('sudo', '--preserve-env=PATH,HOME', 'rm'), ['rm']);
  assert.deepEqual(inner('sudo', '-u', UNKNOWN, 'rm', 'x'), ['rm', 'x']); // an UNKNOWN value is fine
  assert.deepEqual(inner('sudo', '--', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('sudo', '-u', 'root', '--', '-rm'), ['-rm']);
  assert.deepEqual(inner('sudo', '-h', 'rm'), ['rm']); // -h takes only an attached host
  const a = strip('sudo', 'FOO=1', 'rm');
  assert.deepEqual([a.inner, a.env], [['rm'], { FOO: '1' }]);
  // an UNKNOWN word where a flag or the program goes is opaque
  assert.equal(construct('sudo', UNKNOWN, 'rm'), 'command-word');
  assert.equal(construct('sudo', '-u', 'root', UNKNOWN), 'command-word');
  assert.equal(construct('nice', UNKNOWN, 'rm'), 'command-word');
  // sudo -e edits files, -l lists: not a command run
  assert.deepEqual(strip('sudo', '-e', 'f').inner, ['sudo', '-e', 'f']);
  assert.deepEqual(strip('sudo', '-l').wrappers, []);
  // -D changes the directory
  assert.deepEqual(strip('sudo', '-D', '/x', 'rm', 'y').chdirs, ['/x']);
});

test('sudo -E env FOO=1 rm', () => {
  const r = strip('sudo', '-E', 'env', 'FOO=1', 'rm', 'x');
  assert.deepEqual(r.inner, ['rm', 'x']);
  assert.deepEqual(r.wrappers, ['sudo', 'env']);
  assert.deepEqual(r.env, { FOO: '1' });
  const [c] = cmds('sudo -E env FOO=1 rm x');
  assert.deepEqual(c.env, { FOO: '1' });
  assert.ok(c.classes.includes('privilege') && c.classes.includes('delete'));
});

test('env -C changes the inner cwd; env PATH=/x rm', () => {
  const [c] = cmds('env -C ~/.claude rm settings.json');
  const target = path.join(HOME, '.claude', 'settings.json');
  assert.equal(c.cwd, path.join(HOME, '.claude'));
  assert.deepEqual(c.argv, ['rm', 'settings.json']);
  assert.ok(c.writes.includes(target));
  assert.deepEqual(c.ops, [{ path: target, op: 'delete' }]);
  assert.deepEqual(strip('env', '--chdir=/a', 'rm').chdirs, ['/a']);
  // a directory that is not literal makes the cwd UNKNOWN
  assert.equal(cmds('env -C "$D" rm x')[0].cwd, UNKNOWN);
  // redirections still happen in the shell's own cwd
  const d = dir();
  const [r] = cmds('env -C /tmp cat a > out', d);
  assert.ok(r.writes.includes(path.join(d, 'out')));
  const [e] = cmds('env PATH=/x rm y', d);
  assert.deepEqual([e.argv, e.env], [['rm', 'y'], { PATH: '/x' }]);
  // env -i clears the environment: host-config-var (it clears HOME and the rest)
  assert.equal(opaque('env -i PATH=/x rm y', d).construct, 'host-config-var');
});

test('a cd run by an external wrapper does not move the shell; builtin and command still do', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'sub'));
  assert.equal(cmds('env cd sub && rm f', d).at(-1).cwd, d);
  assert.equal(cmds('nice cd sub; rm f', d).at(-1).cwd, d);
  assert.equal(cmds('builtin cd sub && rm f', d).at(-1).cwd, path.join(d, 'sub'));
  assert.equal(cmds('command cd sub && rm f', d).at(-1).cwd, path.join(d, 'sub'));
  assert.equal(cmds('noglob cd sub && rm f', d).at(-1).cwd, path.join(d, 'sub'));
});

test('timeout --signal=KILL 5 rm, nice -n5 rm, other wrappers', () => {
  assert.ok(cmds('timeout --signal=KILL 5 rm x')[0].classes.includes('delete'));
  assert.deepEqual(inner('stdbuf', '-oL', '-e', '0', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('stdbuf', '--output=L', 'rm'), ['rm']);
  assert.deepEqual(inner('setsid', '-f', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('setsid', '--wait', 'rm'), ['rm']);
  assert.deepEqual(inner('nohup', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('doas', '-u', 'root', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(strip('doas', '-C', 'conf').wrappers, []); // checks a config
  assert.deepEqual(inner('exec', '-a', 'foo', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('exec', '-cl', 'rm'), ['rm']);
  assert.deepEqual(strip('exec').wrappers, []);
  assert.deepEqual(inner('builtin', 'cd', '/'), ['cd', '/']);
  assert.deepEqual(inner('time', '-p', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(strip('time', '-o', 'out', 'rm').writes, ['out']);
  assert.deepEqual(strip('time', '--output=out', '-a', 'rm').writes, ['out']);
  assert.deepEqual(inner('flock', '-x', '-w', '5', '/tmp/l', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(strip('flock', '/tmp/l', 'rm').writes, ['/tmp/l']); // the lock file is created
  assert.deepEqual(strip('flock', '9').wrappers, []); // a descriptor, no command
  assert.deepEqual(inner('/usr/bin/sudo', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('nocorrect', 'noglob', '-x'), ['-x']); // no options at all
  const d = dir();
  assert.ok(cmds('time -o out rm x', d)[0].writes.includes(path.join(d, 'out')));
});

test('xargs -0 -I{} rm {}', () => {
  const [c] = cmds('xargs -0 -I{} rm {}');
  assert.deepEqual(c.argv, ['rm', UNKNOWN]);
  assert.ok(c.classes.includes('delete'));
});

test("find . -execdir sh -c 'cat {}' \\; is a non-literal nested script (opaque)", () => {
  assert.deepEqual(strip('find', '.', '-execdir', 'sh', '-c', 'cat {}', ';').execs, [{ argv: ['sh', '-c', UNKNOWN], dir: 'unknown' }]);
  assert.equal(opaque("find . -execdir sh -c 'cat {}' \\;").construct, 'nested-script');
  // T16: literal code is re-parsed; the clause's extra words are $0 $1 (UNKNOWN inside)
  assert.deepEqual(cmds("find . -exec bash -ec 'cat \"$1\"' _ {} ';'").at(-1).argv, ['cat', UNKNOWN]);
});

test('find exec clauses inherit outer wrappers and strip their own', () => {
  const inside = cmds('find . -exec sudo rm {} \\;');
  assert.deepEqual(inside[1].argv, ['rm', UNKNOWN]);
  assert.ok(inside[1].classes.includes('privilege') && inside[1].classes.includes('delete'));
  const outside = cmds('sudo find . -exec rm {} +');
  assert.equal(outside[0].argv[0], 'find');
  assert.ok(outside[1].classes.includes('privilege') && outside[1].classes.includes('delete'));
  // nesting through find counts toward the depth bound
  assert.equal(opaque(`find . -exec ${Array(8).fill('nice').join(' ')} rm {} \\;`).reason, 'depth');
});

test('noglob rm *', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'a'), '');
  const [c] = cmds('noglob rm *', d);
  assert.deepEqual(c.argv, ['rm', UNKNOWN]); // the literal `*`, not the expansion
  assert.ok(c.classes.includes('delete'));
  assert.deepEqual(cmds('rm *', d)[0].argv, ['rm', 'a']);
});

test('env does not read the inner command flags as its own (env rsync -S --delete)', () => {
  assert.ok(classesOf(['env', 'rsync', '-S', '--delete', 'a/', 'b/']).includes('delete'));
  const [c] = cmds('env rsync -S --delete a/ b/');
  assert.equal(c.argv[0], 'rsync');
  assert.ok(c.classes.includes('delete'));
});

test('info.unwrapped carries every stripped layer with its full inner argv', () => {
  let seen = null;
  const probe = (eff, info) => {
    if (eff.argv[0] === 'rm') seen = info.unwrapped;
  };
  FINISH_STEPS.push(probe);
  try {
    cmds('sudo -u root nice rm x');
  } finally {
    FINISH_STEPS.splice(FINISH_STEPS.indexOf(probe), 1);
  }
  assert.deepEqual(seen, [
    ['sudo', '-u', 'root', 'nice', 'rm', 'x'],
    ['nice', 'rm', 'x'],
  ]);
});

// ---- fix round 1 --------------------------------------------------------------------------------

test('NOTICE reproduces the Handrail copyright line and the MIT permission notice', () => {
  const notice = fs.readFileSync(new URL('../NOTICE', import.meta.url), 'utf8');
  assert.ok(notice.split('\n').includes('Copyright (c) 2026 Leonid Svyatov'));
  assert.ok(notice.includes('Permission is hereby granted'));
  assert.ok(notice.includes('github.com/svyatov/handrail'));
});

test('a leading time (and time -p) is the shell keyword: its cd moves the shell', () => {
  // (fix round 2 narrowed this: only a bare, unquoted `time` with no options is the keyword)
  const d = dir();
  fs.mkdirSync(path.join(d, 'src'));
  assert.equal(cmds('time cd src && rm f', d).at(-1).cwd, path.join(d, 'src'));
  // time reached through another wrapper, or with options, is a program: the cwd is UNKNOWN
  assert.equal(cmds('command time cd src && rm f', d).at(-1).cwd, UNKNOWN);
  assert.equal(cmds('sudo time cd src && rm f', d).at(-1).cwd, UNKNOWN);
  assert.equal(cmds('time -o out cd src && rm f', d).at(-1).cwd, UNKNOWN);
  assert.equal(cmds('time -p cd ~/.claude && rm settings.json', d).at(-1).ops[0].path, UNKNOWN);
  // the pure API cannot see quoting: time is the keyword only when the caller says the head is bare
  assert.equal(strip('time', 'cd', 'x').external, true);
  assert.equal(stripWrappers(['time', 'cd', 'x'], { bareHead: true }).external, false);
  assert.equal(stripWrappers(['time', '-p', 'cd', 'x'], { bareHead: true }).external, true);
  assert.equal(stripWrappers(['gtime', 'cd', 'x'], { bareHead: true }).external, true);
  assert.equal(stripWrappers(['/usr/bin/time', 'cd', 'x'], { bareHead: true }).external, true);
  assert.equal(strip('nice', 'time', 'cd', 'x').external, true);
});

test('shellScript reads option values before -c (bash -eo pipefail -c, bash -O extglob -c)', () => {
  assert.equal(shellScript(['bash', '-eo', 'pipefail', '-c', 'rm x']), 'rm x');
  assert.equal(shellScript(['bash', '-O', 'extglob', '-c', 'rm x']), 'rm x');
  assert.equal(shellScript(['bash', '+O', 'extglob', '-o', 'errexit', '-c', 'rm x']), 'rm x');
  assert.equal(shellScript(['bash', '+o', 'posix', '-ec', 'rm x']), 'rm x');
  assert.equal(shellScript(['bash', '-o', 'pipefail', 'script.sh']), null);
  assert.equal(opaque("find . -exec bash -eo pipefail -c 'cat {}' \\;").construct, 'nested-script');
  assert.deepEqual(cmds("find . -exec bash -O extglob -c 'cat ./notes' ';'").at(-1).argv, ['cat', './notes']);
});

test('flock 9 cmd: a numeric operand followed by a command is a lock file flock creates', () => {
  assert.deepEqual(strip('flock', '9', 'rm', 'x').writes, ['9']);
  assert.deepEqual(strip('flock', '9').wrappers, []); // a descriptor alone: no command
  const d = dir();
  const [c] = cmds('flock 9 rm x', d);
  assert.deepEqual(c.argv, ['rm', 'x']);
  assert.ok(c.writes.includes(path.join(d, '9')));
});

test('g-prefixed GNU names are the same wrappers', () => {
  assert.deepEqual(inner('gtimeout', '-s', 'KILL', '5', 'rm', 'x'), ['rm', 'x']);
  assert.deepEqual(inner('gxargs', '-0', 'rm'), ['rm', UNKNOWN]);
  assert.deepEqual(strip('genv', 'A=1', 'rm').env, { A: '1' });
  assert.deepEqual(inner('gnice', '-n5', 'rm'), ['rm']);
  assert.deepEqual(inner('gnohup', 'rm'), ['rm']);
  assert.deepEqual(inner('gstdbuf', '-oL', 'rm'), ['rm']);
  assert.deepEqual(inner('/opt/homebrew/bin/gtime', '-o', 'out', 'rm'), ['rm']);
  assert.equal(construct('gtimeout', '--bogus', '5', 'rm'), 'wrapper-flag');
  assert.deepEqual(strip('gfind', '.', '-exec', 'rm', '{}', ';').execs, [{ argv: ['rm', UNKNOWN], dir: 'same' }]);
  assert.ok(cmds('gtimeout 5 rm x')[0].classes.includes('delete'));
});

test('env -a/-L/-U take a value in the classes table too (env -a rm ls / is ls)', () => {
  for (const f of ['-a', '-L', '-U']) {
    assert.ok(!classesOf(['env', f, 'rm', 'ls', '/']).includes('delete'), f);
    assert.deepEqual(inner('env', f, 'rm', 'ls', '/'), ['ls', '/'], f);
  }
  assert.ok(!classesOf(['env', '--argv0', 'rm', 'ls', '/']).includes('delete'));
  assert.ok(classesOf(['env', '-a', 'x', 'rm', 'f']).includes('delete'));
  const [c] = cmds('env -a rm ls /');
  assert.deepEqual(c.argv, ['ls', '/']);
  assert.ok(!c.classes.includes('delete'));
});

// ---- fix round 2 --------------------------------------------------------------------------------

test('only a bare unquoted time is the keyword: other spellings make a cd through it UNKNOWN', () => {
  const claude = path.join(HOME, '.claude');
  const other = dir();
  for (const head of ['/usr/bin/time', 'gtime', '\\time', "'time'", 't"ime"', 'FOO=1 time', 'time -p', 'time --']) {
    const cs = cmds(`${head} cd ${other}; rm settings.json`, claude);
    const rm = cs.at(-1);
    assert.deepEqual(rm.argv, ['rm', 'settings.json'], head);
    assert.equal(rm.cwd, UNKNOWN, head);
    assert.deepEqual(rm.ops, [{ path: UNKNOWN, op: 'delete' }], head);
    assert.ok(!rm.writes.includes(path.join(other, 'settings.json')), head);
  }
  // pushd/popd through such a time also fail closed
  assert.equal(cmds(`gtime pushd ${other}; rm settings.json`, claude).at(-1).cwd, UNKNOWN);
  // the bare keyword still moves the shell
  const d = dir();
  fs.mkdirSync(path.join(d, 'src'));
  assert.equal(cmds('time cd src && rm f', d).at(-1).cwd, path.join(d, 'src'));
  assert.equal(cmds(`time cd ${other}; rm settings.json`, claude).at(-1).ops[0].path, path.join(other, 'settings.json'));
});
