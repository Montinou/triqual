// Tests for bin/lib/identity.mjs and bin/hooks/identity-pre-push.mjs: the owner-identity rules for the public repository.
// Each hook test builds temp repos with a bare remote and a stub `ssh` on PATH that answers like GitHub does (the `Hi <login>!`
// line on stderr, exit 1), the login coming from STUB_SSH_LOGIN. Foreign identities are invented and built at runtime.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER, PUBLIC_SSH_URL, SSH_HOST, checkCommits, readCommits, sshAccount } from '../bin/lib/identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'bin', 'lib', 'identity.mjs');
const HOOK = join(HERE, '..', 'bin', 'hooks', 'identity-pre-push.mjs');
const ZEROS = '0'.repeat(40);
const FOREIGN = { name: ['Other', 'Person'].join(' '), email: ['other', 'example.invalid'].join('@') };
const GITHUB = { name: 'GitHub', email: ['noreply', 'github.com'].join('@') };
const OTHER_LOGIN = 'other-login';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const baseEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return env;
};

const commit = (over = {}) => ({
  sha: 'a'.repeat(40),
  authorName: OWNER.name,
  authorEmail: OWNER.email,
  committerName: OWNER.name,
  committerEmail: OWNER.email,
  message: 'feat: something\n',
  ...over,
});

// A work repo whose `origin` is a bare repo, a stub ssh dir first on PATH, and helpers to commit as a given identity.
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'identity-'));
  made.push(dir);
  const bare = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const stubs = join(dir, 'stubs');
  const home = join(dir, 'home');
  for (const path of [work, stubs, home]) mkdirSync(path);
  writeFileSync(join(stubs, 'ssh'), `#!/bin/sh\necho "Hi $STUB_SSH_LOGIN! You've successfully authenticated, but GitHub does not provide shell access." >&2\nexit 1\n`);
  chmodSync(join(stubs, 'ssh'), 0o755);
  const env = { ...baseEnv(), HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', PATH: `${stubs}:${process.env.PATH}`, STUB_SSH_LOGIN: OWNER.login };
  const run = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const must = (cwd, args, extra) => {
    const result = run(cwd, args, extra);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  must(dir, ['init', '--bare', '-b', 'main', bare]);
  must(work, ['init', '-b', 'main']);
  must(work, ['remote', 'add', 'origin', bare]);
  const as = (who, file, message = `feat: ${file}\n`, cwd = work) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    must(cwd, ['add', file]);
    const identity = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    must(cwd, ['commit', '-m', message], identity);
    return must(cwd, ['rev-parse', 'HEAD']);
  };
  const hook = ({ url = PUBLIC_SSH_URL, lines, login = OWNER.login }) =>
    spawnSync('node', [HOOK, 'origin', url], { cwd: work, env: { ...env, STUB_SSH_LOGIN: login }, input: lines.join('\n') + '\n', encoding: 'utf8' });
  return { dir, bare, work, env, must, run, as, hook };
}

test('OWNER and PUBLIC_SSH_URL are the fixed values', () => {
  assert.deepEqual(OWNER, { login: 'Montinou', name: 'Montinou', email: '33442778+Montinou@users.noreply.github.com' });
  assert.equal(PUBLIC_SSH_URL, 'git@github.com:Montinou/triqual.git');
});

test('checkCommits flags each AI attribution line, strict or not', () => {
  const lines = [
    'Claude-Session: abc123',
    'Generated with a tool',
    'Co-Authored-By: Claude <noreply@example.invalid>',
    ['Co-Authored-By: Some Bot <bot', 'anthropic.com>'].join('@'),
    'co-authored-by: CLAUDE Opus <x@example.invalid>',
    'generated WITH a tool',
  ];
  for (const line of lines) {
    for (const strict of [false, true]) {
      const found = checkCommits([commit({ message: `feat: x\n\nbody\n${line}\n` })], { strict });
      assert.equal(found.length, 1, `${line} (strict ${strict})`);
      assert.equal(found[0].sha, 'a'.repeat(40));
      assert.match(found[0].reason, /attribution/);
    }
  }
});

test('checkCommits does not flag a human Co-Authored-By or a mid-line mention', () => {
  const message = `feat: x\n\nCo-Authored-By: ${FOREIGN.name} <${FOREIGN.email}>\nthe words Generated with appear mid-line, and so does Claude-Session: here\n`;
  assert.deepEqual(checkCommits([commit({ message })], { strict: true }), []);
});

test('checkCommits flags a foreign author or committer only under strict', () => {
  const foreignAuthor = commit({ sha: 'b'.repeat(40), authorName: FOREIGN.name, authorEmail: FOREIGN.email });
  const foreignCommitter = commit({ sha: 'c'.repeat(40), committerName: FOREIGN.name, committerEmail: FOREIGN.email });
  assert.deepEqual(checkCommits([foreignAuthor, foreignCommitter], { strict: false }), []);
  const found = checkCommits([foreignAuthor, foreignCommitter, commit()], { strict: true });
  assert.deepEqual(found.map((entry) => entry.sha), ['b'.repeat(40), 'c'.repeat(40)]);
  assert.match(found[0].reason, /author/);
  assert.match(found[1].reason, /committer/);
});

test('checkCommits passes an owner commit under strict', () => {
  assert.deepEqual(checkCommits([commit()], { strict: true }), []);
});

test('readCommits parses author, committer and a multi-line message', () => {
  const world = makeWorld();
  world.as(FOREIGN, 'a.txt', 'feat: first\n\nbody line\nCo-Authored-By: someone\n');
  const sha = world.as(OWNER, 'b.txt', 'feat: second\n');
  const commits = readCommits('HEAD', { cwd: world.work });
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, sha);
  assert.equal(commits[0].authorEmail, OWNER.email);
  assert.equal(commits[1].authorName, FOREIGN.name);
  assert.equal(commits[1].committerEmail, FOREIGN.email);
  assert.match(commits[1].message, /^feat: first\n\nbody line\nCo-Authored-By: someone/);
});

test('sshAccount parses the login from stderr whatever the exit code', () => {
  const hi = (login) => ({ status: 1, stdout: '', stderr: `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.\n` });
  const calls = [];
  const account = sshAccount({ exec: (file, args) => (calls.push([file, args]), hi('Montinou')) });
  assert.equal(account, 'Montinou');
  assert.equal(calls[0][0], 'ssh');
  assert.deepEqual(calls[0][1], ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', SSH_HOST]);
  assert.equal(sshAccount({ exec: () => ({ ...hi(OTHER_LOGIN), status: 0 }) }), OTHER_LOGIN);
});

test('sshAccount is null without a Hi line', () => {
  assert.equal(sshAccount({ exec: () => ({ status: 255, stdout: '', stderr: 'git@github.com: Permission denied (publickey).\n' }) }), null);
  assert.equal(sshAccount({ exec: () => ({ status: 1, stdout: 'Hi Montinou! on stdout only', stderr: '' }) }), null);
  assert.equal(sshAccount({ exec: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn ssh ENOENT') }) }), null);
});

test('the CLI exits 0 clean and 1 with sha · reason lines', () => {
  const world = makeWorld();
  const base = world.as(OWNER, 'a.txt');
  const bad = world.as(FOREIGN, 'b.txt');
  const cli = (...args) => spawnSync('node', [LIB, ...args], { cwd: world.work, env: world.env, encoding: 'utf8' });
  const clean = cli('--range', `${base}..${base}`, '--strict');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(cli('--range', `${base}..${bad}`).status, 0, 'a foreign identity is fine without --strict');
  const strict = cli('--range', `${base}..${bad}`, '--strict');
  assert.equal(strict.status, 1);
  assert.match(strict.stdout + strict.stderr, new RegExp(`${bad} · .*author`));
  assert.equal(cli('--strict').status, 2, 'usage error without --range');
});

test('the CLI flags an AI line without --strict', () => {
  const world = makeWorld();
  const base = world.as(OWNER, 'a.txt');
  const bad = world.as(OWNER, 'b.txt', 'feat: b\n\nClaude-Session: abc\n');
  const result = spawnSync('node', [LIB, '--range', `${base}..${bad}`], { cwd: world.work, env: world.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, new RegExp(`${bad} · `));
});

test('the pre-push hook passes a clean push as the owner', () => {
  const world = makeWorld();
  const sha = world.as(OWNER, 'a.txt');
  const result = world.hook({ lines: [`refs/heads/main ${sha} refs/heads/main ${ZEROS}`] });
  assert.equal(result.status, 0, result.stderr);
});

test('the pre-push hook refuses an https URL', () => {
  const world = makeWorld();
  const sha = world.as(OWNER, 'a.txt');
  const result = world.hook({ url: 'https://github.com/Montinou/triqual.git', lines: [`refs/heads/main ${sha} refs/heads/main ${ZEROS}`] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ssh/i);
});

test('the pre-push hook refuses another GitHub account', () => {
  const world = makeWorld();
  const sha = world.as(OWNER, 'a.txt');
  const result = world.hook({ login: OTHER_LOGIN, lines: [`refs/heads/main ${sha} refs/heads/main ${ZEROS}`] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(OTHER_LOGIN));
});

test('the pre-push hook refuses a commit by another person and names its sha', () => {
  const world = makeWorld();
  world.as(OWNER, 'a.txt');
  const bad = world.as(FOREIGN, 'b.txt');
  const result = world.hook({ lines: [`refs/heads/main ${bad} refs/heads/main ${ZEROS}`] });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(bad), result.stderr);
});

test('the pre-push hook refuses an AI attribution line by the owner', () => {
  const world = makeWorld();
  const bad = world.as(OWNER, 'a.txt', 'feat: a\n\nGenerated with a tool\n');
  const result = world.hook({ lines: [`refs/heads/main ${bad} refs/heads/main ${ZEROS}`] });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(bad), result.stderr);
});

test('a new branch checks only its new commits', () => {
  const world = makeWorld();
  const old = world.as(FOREIGN, 'a.txt');
  world.must(world.work, ['push', 'origin', 'main']);
  world.must(world.work, ['checkout', '-b', 'feature']);
  const clean = world.as(OWNER, 'b.txt');
  const ok = world.hook({ lines: [`refs/heads/feature ${clean} refs/heads/feature ${ZEROS}`] });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = world.as(FOREIGN, 'c.txt');
  const refused = world.hook({ lines: [`refs/heads/feature ${bad} refs/heads/feature ${ZEROS}`] });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(bad), refused.stderr);
  assert.ok(!refused.stderr.includes(old), 'a commit already on the remote is not checked');
});

test('a branch that merged a GitHub commit from the remote pushes clean', () => {
  const world = makeWorld();
  const base = world.as(OWNER, 'a.txt');
  world.must(world.work, ['push', 'origin', 'main']);
  const other = join(world.dir, 'other');
  world.must(world.dir, ['clone', world.bare, other]);
  world.as(GITHUB, 'merged.txt', 'Merge pull request #1\n', other);
  world.must(other, ['push', 'origin', 'main']);
  world.must(world.work, ['fetch', 'origin']);
  world.must(world.work, ['checkout', '-b', 'feature', base]);
  world.as(OWNER, 'b.txt');
  const owner = { GIT_AUTHOR_NAME: OWNER.name, GIT_AUTHOR_EMAIL: OWNER.email, GIT_COMMITTER_NAME: OWNER.name, GIT_COMMITTER_EMAIL: OWNER.email };
  world.must(world.work, ['merge', '--no-ff', '-m', 'merge main', 'origin/main'], owner);
  const head = world.must(world.work, ['rev-parse', 'HEAD']);
  const result = world.hook({ lines: [`refs/heads/feature ${head} refs/heads/feature ${ZEROS}`] });
  assert.equal(result.status, 0, result.stderr);
});

test('a deletion line is skipped', () => {
  const world = makeWorld();
  const result = world.hook({ lines: [`(delete) ${ZEROS} refs/heads/old ${'d'.repeat(40)}`] });
  assert.equal(result.status, 0, result.stderr);
});
