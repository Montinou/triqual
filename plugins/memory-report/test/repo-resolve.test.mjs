import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, defaultRun, defaultSshHost, normalizeRemote, resolveFolder } from '../lib/repo.mjs';

// A fake `ssh -G`: maps a host to its HostName; any other host resolves to itself (ssh's behavior with no Host block).
// `calls` records every host asked, so tests can pin the cache and the refusals.
function fakeSsh(map = {}, { fail = [] } = {}) {
  const calls = [];
  const fn = async (host) => {
    calls.push(host);
    if (fail.includes(host)) throw new Error('ssh -G failed');
    return Object.hasOwn(map, host) ? map[host] : host;
  };
  fn.calls = calls;
  return fn;
}

const norm = (url, sshHost = fakeSsh()) => normalizeRemote(url, { sshHost });
const repoOf = async (url, sshHost) => (await norm(url, sshHost)).repo;

// ---- normalizeRemote (spec 2) ----

test('normalizeRemote: https, http and git:// drop credentials and port, lower-case, strip .git and /', async () => {
  assert.deepEqual(await norm('https://user:hunter2@Example.invalid:8443/Acme/App.git'), { repo: 'example.invalid/acme/app', sshFailed: false });
  assert.equal(await repoOf('https://GitHub.com/Acme/App.git'), 'github.com/acme/app');
  assert.equal(await repoOf('http://example.invalid/acme/app/'), 'example.invalid/acme/app');
  assert.equal(await repoOf('git://example.invalid:9418/Acme/App.git'), 'example.invalid/acme/app');
  assert.equal(await repoOf('https://github.com//acme///app.git'), 'github.com/acme/app');
});

test('normalizeRemote: https never asks ssh', async () => {
  const ssh = fakeSsh();
  await norm('https://github.com/acme/app.git', ssh);
  assert.deepEqual(ssh.calls, []);
});

test('normalizeRemote: scp style goes through sshHost', async () => {
  const ssh = fakeSsh({ 'github.com': 'github.com' });
  assert.deepEqual(await norm('git@github.com:Acme/App.git', ssh), { repo: 'github.com/acme/app', sshFailed: false });
  assert.deepEqual(ssh.calls, ['github.com']);
});

test('normalizeRemote: ssh:// with a port on ssh.github.com is github.com', async () => {
  const ssh = fakeSsh();
  assert.equal(await repoOf('ssh://git@ssh.github.com:443/Acme/App.git', ssh), 'github.com/acme/app');
  assert.deepEqual(ssh.calls, ['ssh.github.com']);
});

test('normalizeRemote: an SSH config alias such as github.com-work resolves through ssh -G', async () => {
  const ssh = fakeSsh({ 'github.com-work': 'github.com' });
  assert.equal(await repoOf('git@github.com-work:acme/app.git', ssh), 'github.com/acme/app');
  assert.equal(await repoOf('ssh://github.com-work/acme/app.git', ssh), 'github.com/acme/app');
});

test('normalizeRemote: sshHost answers are cached per host in a shared cache', async () => {
  const ssh = fakeSsh();
  const cache = new Map();
  await normalizeRemote('git@github.com:acme/a.git', { sshHost: ssh, cache });
  await normalizeRemote('ssh://github.com/acme/b.git', { sshHost: ssh, cache });
  await normalizeRemote('git@example.invalid:acme/c.git', { sshHost: ssh, cache });
  assert.deepEqual(ssh.calls, ['github.com', 'example.invalid']);
});

test('normalizeRemote: a GitLab subgroup keeps every path segment', async () => {
  assert.equal(await repoOf('https://gitlab.com/Group/Sub/Name.git'), 'gitlab.com/group/sub/name');
  assert.equal(await repoOf('git@gitlab.com:group/sub/name.git'), 'gitlab.com/group/sub/name');
});

test('normalizeRemote: Azure DevOps forms all give dev.azure.com/org/proj/repo', async () => {
  assert.equal(await repoOf('git@ssh.dev.azure.com:v3/Acme/Proj/Repo'), 'dev.azure.com/acme/proj/repo');
  assert.equal(await repoOf('https://dev.azure.com/Acme/Proj/_git/Repo'), 'dev.azure.com/acme/proj/repo');
  assert.equal(await repoOf('https://acme.visualstudio.com/Proj/_git/Repo'), 'dev.azure.com/acme/proj/repo');
  // Without `v3` too, so a `dev.azure.com/acme/*` never-send entry still blocks it.
  assert.equal(await repoOf('git@ssh.dev.azure.com:Acme/Proj/Repo'), 'dev.azure.com/acme/proj/repo');
  assert.equal(await repoOf('ssh://ssh.dev.azure.com/acme/proj/repo.git'), 'dev.azure.com/acme/proj/repo');
});

test('normalizeRemote: null for local paths, file:// and other schemes', async () => {
  for (const url of ['/srv/git/app.git', './app', '../app.git', '~/app', 'file:///srv/git/app.git', 'ftp://example.invalid/acme/app', '', '   ']) {
    assert.deepEqual(await norm(url), { repo: null, sshFailed: false }, url);
  }
  assert.deepEqual(await norm(null), { repo: null, sshFailed: false });
});

test('normalizeRemote: null for a dotless host after sshHost', async () => {
  assert.equal(await repoOf('git@gh-work:acme/app.git', fakeSsh()), null);
  assert.equal(await repoOf('git@github.com-work:acme/app.git', fakeSsh({ 'github.com-work': 'localhost' })), null);
  assert.equal(await repoOf('https://intranet/acme/app.git'), null);
});

test('normalizeRemote: null for one segment, an empty segment, ".", "..", a space or a control character', async () => {
  for (const url of [
    'https://github.com/acme.git',
    'https://github.com/acme/',
    'https://github.com/acme/app/.git',
    'https://github.com/acme/.',
    'https://github.com/acme/../app',
    'https://github.com/acme/my app.git',
    'git@github.com:acme/my app.git',
    'https://github.com/acme/a\u0001pp.git',
    'https://github.com/acme/app\u007f',
  ]) {
    assert.equal(await repoOf(url), null, JSON.stringify(url));
  }
});

test('normalizeRemote: null for a URL containing ?, # or a backslash', async () => {
  for (const url of [
    'https://evil.example.invalid#@github.com/acme/public',
    'https://evil.example.invalid?@github.com/acme/public',
    'https://github.com/acme/app.git?ref=main',
    'https://github.com/acme/app#readme',
    'https://evil.example.invalid\\@github.com/acme/public',
    'https://github.com/acme\\app/x',
    'git@github.com:acme/app#x.git',
    'git@github.com:acme/app?x.git',
    'git@github.com:acme\\app/x.git',
  ]) {
    const ssh = fakeSsh();
    assert.deepEqual(await norm(url, ssh), { repo: null, sshFailed: false }, url);
    assert.deepEqual(ssh.calls, [], url);
  }
});

test('normalizeRemote: sshFailed when sshHost rejects or answers nothing, never a literal-host fallback', async () => {
  assert.deepEqual(await norm('git@github.com:acme/app.git', fakeSsh({}, { fail: ['github.com'] })), { repo: null, sshFailed: true });
  assert.deepEqual(await norm('ssh://github.com/acme/app.git', fakeSsh({ 'github.com': null })), { repo: null, sshFailed: true });
});

test('normalizeRemote: a host starting with - is refused without asking ssh', async () => {
  const ssh = fakeSsh();
  assert.deepEqual(await norm('-oProxyCommand=x:acme/app.git', ssh), { repo: null, sshFailed: true });
  assert.deepEqual(await norm('ssh://-oProxyCommand=x/acme/app.git', ssh), { repo: null, sshFailed: true });
  assert.deepEqual(ssh.calls, []);
});

// ---- defaultSshHost (with a fake run; the real ssh never runs in tests) ----

test('defaultSshHost: runs ssh -G <host> and reads the hostname line', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return { code: 0, stdout: 'user git\nhostname github.com\nport 22\n', stderr: '', timedOut: false };
  };
  assert.equal(await defaultSshHost({ run })('github.com-work'), 'github.com');
  assert.deepEqual(calls, [['ssh', ['-G', 'github.com-work'], { timeoutMs: 3000 }]]);
});

test('defaultSshHost: null on a failure, a timeout, no hostname line or a host starting with -', async () => {
  const ran = [];
  const runWith = (res) => async (cmd, args) => { ran.push(args); return { code: 0, stdout: '', stderr: '', timedOut: false, ...res }; };
  assert.equal(await defaultSshHost({ run: runWith({ code: 255, stderr: 'bad' }) })('x.example.invalid'), null);
  assert.equal(await defaultSshHost({ run: runWith({ code: null, timedOut: true }) })('x.example.invalid'), null);
  assert.equal(await defaultSshHost({ run: runWith({ stdout: 'user git\n' }) })('x.example.invalid'), null);
  ran.length = 0;
  assert.equal(await defaultSshHost({ run: runWith({ stdout: 'hostname evil\n' }) })('-oProxyCommand=x'), null);
  assert.deepEqual(ran, []);
});

test('defaultSshHost: only plain host names or a bracketed IPv6 address reach ssh', async () => {
  const ran = [];
  const run = async (cmd, args) => { ran.push(args[1]); return { code: 0, stdout: `hostname ${args[1]}\n`, stderr: '', timedOut: false }; };
  const sshHost = defaultSshHost({ run });
  for (const bad of ['a$b.example.invalid', '$(id).example.invalid', 'a`id`.example.invalid', 'a;b.example.invalid', 'a|b.example.invalid',
    'a b.example.invalid', 'a%b.example.invalid', '[::1', 'a[::1]', '[x;y]']) {
    assert.equal(await sshHost(bad), null, bad);
  }
  assert.deepEqual(ran, []);
  for (const good of ['github.com-work', 'GitHub.com', 'gh_work.example.invalid', '10.0.0.1', '[::1]', '[fe80::1]']) {
    assert.equal(await sshHost(good), good, good);
  }
  assert.deepEqual(ran, ['github.com-work', 'GitHub.com', 'gh_work.example.invalid', '10.0.0.1', '[::1]', '[fe80::1]']);
});

test('normalizeRemote with defaultSshHost: a host with $, ` or ; is sshFailed and ssh never runs', async () => {
  const ran = [];
  const run = async (cmd, args) => { ran.push(args); return { code: 0, stdout: 'hostname github.com\n', stderr: '', timedOut: false }; };
  const sshHost = defaultSshHost({ run });
  for (const url of ['git@a$b.example.invalid:acme/app.git', 'git@a`id`.example.invalid:acme/app.git', 'ssh://git@a;b.example.invalid/acme/app.git']) {
    assert.deepEqual(await normalizeRemote(url, { sshHost }), { repo: null, sshFailed: true }, url);
  }
  assert.deepEqual(ran, []);
});

// ---- resolveFolder with a fake run ----

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
// One `git remote -v` line: `<name>\t<url> (<kind>)`, plus an optional suffix such as a partial clone's ` [blob:none]`.
const listing = (name, url, kind, suffix = '') => `${name}\t${url} (${kind})${suffix}`;
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, timedOut: false });
const TIMEOUT = { code: null, stdout: '', stderr: '', timedOut: true };

// A fake run answering by command line. `answers` maps 'stat', 'toplevel', 'origin' and 'remotes' to results;
// defaults describe a root repository whose only remote is an https origin.
function fakeRun(cwd, answers = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    assert.equal(opts?.timeoutMs, 3000);
    const line = [cmd, ...args].join(' ');
    if (line === `stat ${cwd}`) return answers.stat ?? ok('stat output');
    if (line === `git -C ${cwd} rev-parse --show-toplevel`) return answers.toplevel ?? ok(`${realpathSync(cwd)}\n`);
    if (line === `git -C ${cwd} remote get-url origin`) return answers.origin ?? ok('https://github.com/acme/app.git\n');
    if (line === `git -C ${cwd} remote -v`) {
      return answers.remotes ?? ok('origin\thttps://github.com/acme/app.git (fetch)\norigin\thttps://github.com/acme/app.git (push)\n');
    }
    throw new Error(`unexpected command: ${line}`);
  };
  run.calls = calls;
  return run;
}

// A real temp folder (realpath needs one) with a subfolder; fn({ dir, sub }).
async function withDirs(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-report-repo-'));
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  try {
    return await fn({ dir, sub });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EMPTY = { origin: null, remotes: [], unresolvedRemote: false };

test('resolveFolder: stat "No such file or directory" is missing and runs no git', async () => {
  const cwd = '/nonexistent/example.invalid/app';
  const run = fakeRun(cwd, { stat: fail(`stat: ${cwd}: stat: No such file or directory`) });
  assert.deepEqual(await resolveFolder(cwd, { run, sshHost: fakeSsh() }), { status: 'missing', ...EMPTY });
  assert.deepEqual(run.calls, [['stat', cwd]]);
});

test('resolveFolder: any other stat error, a timeout or a relative path is unknown', async () => {
  const cwd = '/locked/example.invalid/app';
  for (const stat of [fail(`stat: ${cwd}: stat: Permission denied`), fail(`stat: ${cwd}: stat: Operation not permitted`), TIMEOUT]) {
    assert.deepEqual(await resolveFolder(cwd, { run: fakeRun(cwd, { stat }), sshHost: fakeSsh() }), { status: 'unknown', ...EMPTY });
  }
  // A folder whose own name contains the phrase is still judged by the error at the end of the message.
  const odd = '/x/No such file or directory/app';
  const run = fakeRun(odd, { stat: fail(`stat: ${odd}: stat: Permission denied`) });
  assert.equal((await resolveFolder(odd, { run, sshHost: fakeSsh() })).status, 'unknown');
  const rel = fakeRun('relative/app');
  assert.equal((await resolveFolder('relative/app', { run: rel, sshHost: fakeSsh() })).status, 'unknown');
  assert.deepEqual(rel.calls, []);
});

test('resolveFolder: "not a git repository" is nogit; dubious ownership, a timeout or another failure is unknown', async () => {
  await withDirs(async ({ dir }) => {
    const nogit = fakeRun(dir, { toplevel: fail('fatal: not a git repository (or any of the parent directories): .git', 128) });
    assert.deepEqual(await resolveFolder(dir, { run: nogit, sshHost: fakeSsh() }), { status: 'nogit', ...EMPTY });
    const dubious = fail(`fatal: detected dubious ownership in repository at '${dir}'\nTo add an exception for this directory, call:\n`, 128);
    for (const toplevel of [dubious, TIMEOUT, fail("fatal: cannot change to 'x': Not a directory", 128)]) {
      assert.deepEqual(await resolveFolder(dir, { run: fakeRun(dir, { toplevel }), sshHost: fakeSsh() }), { status: 'unknown', ...EMPTY });
    }
  });
});

test('resolveFolder: top level equal to realpath(cwd) is root, otherwise nested', async () => {
  await withDirs(async ({ dir, sub }) => {
    const root = await resolveFolder(dir, { run: fakeRun(dir), sshHost: fakeSsh() });
    assert.deepEqual(root, { status: 'root', origin: 'github.com/acme/app', remotes: ['github.com/acme/app'], unresolvedRemote: false });
    const nested = await resolveFolder(sub, { run: fakeRun(sub, { toplevel: ok(`${realpathSync(dir)}\n`) }), sshHost: fakeSsh() });
    assert.equal(nested.status, 'nested');
    assert.equal(nested.origin, 'github.com/acme/app');
  });
});

test('resolveFolder: every remote is normalized, origin included; a missing origin is null', async () => {
  await withDirs(async ({ dir }) => {
    const remotes = ok([
      listing('origin', 'git@github.com:Acme/App.git', 'fetch', ' [blob:none]'),
      listing('origin', 'git@github.com:Acme/App.git', 'push'),
      'upstream\thttps://github.com/Globex/App.git (fetch)',
      'upstream\thttps://github.com/Globex/App.git (push)',
      '',
    ].join('\n'));
    const ssh = fakeSsh();
    const r = await resolveFolder(dir, { run: fakeRun(dir, { origin: ok('git@github.com:Acme/App.git\n'), remotes }), sshHost: ssh });
    assert.deepEqual(r, { status: 'root', origin: 'github.com/acme/app', remotes: ['github.com/acme/app', 'github.com/globex/app'], unresolvedRemote: false });
    assert.deepEqual(ssh.calls, ['github.com'], 'one ssh -G per host per folder');

    const noOrigin = fakeRun(dir, {
      origin: fail("error: No such remote 'origin'", 2),
      remotes: ok('upstream\thttps://github.com/globex/app.git (fetch)\nupstream\thttps://github.com/globex/app.git (push)\n'),
    });
    assert.deepEqual(await resolveFolder(dir, { run: noOrigin, sshHost: fakeSsh() }),
      { status: 'root', origin: null, remotes: ['github.com/globex/app'], unresolvedRemote: false });
  });
});

test('resolveFolder: an origin that normalizes to null is a null origin, not an unresolved remote', async () => {
  await withDirs(async ({ dir }) => {
    const run = fakeRun(dir, { origin: ok('/srv/git/app.git\n'), remotes: ok('origin\t/srv/git/app.git (fetch)\norigin\t/srv/git/app.git (push)\n') });
    assert.deepEqual(await resolveFolder(dir, { run, sshHost: fakeSsh() }), { status: 'root', origin: null, remotes: [], unresolvedRemote: false });
  });
});

test('resolveFolder: a non-origin remote whose ssh -G fails makes the folder unknown', async () => {
  await withDirs(async ({ dir }) => {
    const remotes = ok('origin\thttps://github.com/acme/app.git (fetch)\norigin\thttps://github.com/acme/app.git (push)\n'
      + `${listing('work', 'git@github.com-work:globex/app.git', 'fetch')}\n${listing('work', 'git@github.com-work:globex/app.git', 'push')}\n`);
    const r = await resolveFolder(dir, { run: fakeRun(dir, { remotes }), sshHost: fakeSsh({}, { fail: ['github.com-work'] }) });
    assert.deepEqual(r, { status: 'unknown', ...EMPTY });
  });
});

test('resolveFolder: an origin whose ssh -G fails makes the folder unknown', async () => {
  await withDirs(async ({ dir }) => {
    const run = fakeRun(dir, { origin: ok('git@github.com:acme/app.git\n'), remotes: ok(`${listing('origin', 'git@github.com:acme/app.git', 'fetch')}\n`) });
    assert.deepEqual(await resolveFolder(dir, { run, sshHost: fakeSsh({}, { fail: ['github.com'] }) }), { status: 'unknown', ...EMPTY });
  });
});

test('resolveFolder: a non-origin remote that normalizes to null sets unresolvedRemote', async () => {
  await withDirs(async ({ dir }) => {
    const remotes = ok('origin\thttps://github.com/acme/app.git (fetch)\norigin\thttps://github.com/acme/app.git (push)\n'
      + 'backup\t/mnt/backup/app.git (fetch)\nbackup\t/mnt/backup/app.git (push)\n');
    const r = await resolveFolder(dir, { run: fakeRun(dir, { remotes }), sshHost: fakeSsh() });
    assert.deepEqual(r, { status: 'root', origin: 'github.com/acme/app', remotes: ['github.com/acme/app'], unresolvedRemote: true });
  });
});

test('resolveFolder: a failed, timed-out or unparsable remote listing is unknown', async () => {
  await withDirs(async ({ dir }) => {
    const unparsable = ok('origin\thttps://github.com/acme/app.git (fetch)\nsomething unexpected\n');
    for (const answers of [{ origin: TIMEOUT }, { origin: fail('fatal: something else', 128) }, { remotes: TIMEOUT }, { remotes: fail('fatal: x', 128) }, { remotes: unparsable }]) {
      assert.deepEqual(await resolveFolder(dir, { run: fakeRun(dir, answers), sshHost: fakeSsh() }), { status: 'unknown', ...EMPTY });
    }
  });
});

// ---- defaultRun (child rules) ----

test('childEnv: the base env minus every GIT_* variable, plus LC_ALL=C', () => {
  const env = childEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_CONFIG_GLOBAL: '/y', LC_ALL: 'es_AR.UTF-8', HOME: '/h', MYGIT_X: '1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', MYGIT_X: '1', LC_ALL: 'C' });
});

test('defaultRun: stdin closed, env from envBase without GIT_*, exit code and output', async () => {
  const run = defaultRun({ envBase: { PATH: process.env.PATH, GIT_DIR: '/x', KEEP_ME: 'yes' } });
  const script = "let n=0;process.stdin.on('data',()=>n++).on('end',()=>{process.stdout.write(JSON.stringify({n,git:process.env.GIT_DIR??null,keep:process.env.KEEP_ME,lc:process.env.LC_ALL}));process.stderr.write('e');process.exit(3)})";
  const r = await run(process.execPath, ['-e', script], { timeoutMs: 3000 });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.stderr, 'e');
  assert.deepEqual(JSON.parse(r.stdout), { n: 0, git: null, keep: 'yes', lc: 'C' });
});

test('defaultRun: a child still running at the timeout is killed and the result comes back without waiting', async () => {
  const run = defaultRun({ envBase: { PATH: process.env.PATH } });
  const started = Date.now();
  const r = await run(process.execPath, ['-e', "process.stdout.write('partial');setInterval(()=>{},1000)"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.ok(Date.now() - started < 2500, 'resolved promptly');
});

test('defaultRun: a command that cannot start resolves with a null code, never throws', async () => {
  const run = defaultRun({ envBase: { PATH: process.env.PATH } });
  const r = await run('/nonexistent/example.invalid/bin', [], { timeoutMs: 3000 });
  assert.equal(r.code, null);
  assert.equal(r.timedOut, false);
});

// ---- integration: real git in throwaway repositories ----

test('resolveFolder with real git: root, nested, nogit and missing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'memory-report-git-'));
  try {
    const envBase = { PATH: process.env.PATH, HOME: base, XDG_CONFIG_HOME: join(base, 'xdg') };
    mkdirSync(envBase.XDG_CONFIG_HOME);
    const git = (...args) => execFileSync('git', args, { env: childEnv(envBase), stdio: ['ignore', 'pipe', 'pipe'] });
    const repo = join(base, 'repo');
    const sub = join(repo, 'sub');
    const plain = join(base, 'plain');
    mkdirSync(sub, { recursive: true });
    mkdirSync(plain);
    git('init', '-q', repo);
    git('-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/Acme/App.git');
    git('-C', repo, 'remote', 'add', 'upstream', 'https://example.invalid/globex/app.git');
    // A partial clone's promisor remote: `git remote -v` prints `(fetch) [blob:none]` for it.
    git('-C', repo, 'config', 'remote.origin.promisor', 'true');
    git('-C', repo, 'config', 'remote.origin.partialclonefilter', 'blob:none');

    const deps = { run: defaultRun({ envBase }), sshHost: fakeSsh() };
    assert.deepEqual(await resolveFolder(repo, deps),
      { status: 'root', origin: 'example.invalid/acme/app', remotes: ['example.invalid/acme/app', 'example.invalid/globex/app'], unresolvedRemote: false });
    assert.equal((await resolveFolder(sub, deps)).status, 'nested');
    assert.deepEqual(await resolveFolder(plain, deps), { status: 'nogit', ...EMPTY });
    assert.deepEqual(await resolveFolder(join(base, 'gone'), deps), { status: 'missing', ...EMPTY });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- final fix M1: www. and a trailing dot on remote hosts ----

test('final fix M1: normalizeRemote drops one trailing dot and the www. of github.com, gitlab.com and bitbucket.org', async () => {
  assert.equal(await repoOf('https://www.github.com/Client/App.git'), 'github.com/client/app');
  assert.equal(await repoOf('https://github.com./client/app'), 'github.com/client/app');
  assert.equal(await repoOf('https://www.gitlab.com/group/sub/app'), 'gitlab.com/group/sub/app');
  assert.equal(await repoOf('https://www.bitbucket.org./team/app'), 'bitbucket.org/team/app');
  assert.equal(await repoOf('git@gh-work:client/app.git', fakeSsh({ 'gh-work': 'github.com.' })), 'github.com/client/app');
  assert.equal(await repoOf('https://www.example.invalid/acme/app'), 'www.example.invalid/acme/app', 'only the three known hosts lose www.');
});
