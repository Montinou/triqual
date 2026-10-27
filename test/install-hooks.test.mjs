// Tests for bin/install-hooks.mjs: it chains the content gate (pre-commit) and the identity hook (pre-push) after the store gate
// that `progress-init --store` wrote into <git-common-dir>/hooks/pre-commit. Each test builds a temp repo with the store gate
// written the way progress-init writes it (the shipped STORE_HOOK_LINES script plus the chained line), a fake `triqual` on PATH
// that records each call, the gate's own files copied in and committed (so every worktree has them), a temp deny file and a
// sandboxed HOME. Terms are invented; identities are built at runtime so no fixture needs an allowlist entry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER, PUBLIC_SSH_URL } from '../bin/lib/identity.mjs';
import { STORE_HOOK_LINES } from '../plugins/progress-tracking/lib/store-hooks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INSTALL = join(ROOT, 'bin', 'install-hooks.mjs');
const TERM = 'globex';
const STORE_SCRIPT = 'progress-store-pre-commit.sh';
// The line progress-init writes right after the shebang of the clone's own hooks dir.
const STORE_LINE = `sh "$(git rev-parse --git-path hooks)/${STORE_SCRIPT}" || exit 1`;
const GATE_LINE = 'node "$(git rev-parse --show-toplevel)/bin/hooks/content-gate-pre-commit.mjs" || exit 1';
const PUSH_LINE = 'node "$(git rev-parse --show-toplevel)/bin/hooks/identity-pre-push.mjs" "$@" || exit 1';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const baseEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'PUBLIC_EXPORT_DENY' && key !== 'MEMORY_REPORT_CONFIG' && key !== 'TRIQUAL_GATE_NO_LOCAL_TERMS') env[key] = value;
  }
  return env;
};

const writeExec = (path, text) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

const count = (text, line) => text.split('\n').filter((l) => l === line).length;

// A repo with the store gate installed. `store` false leaves the store gate out; `hooksPath` sets core.hooksPath.
function makeRepo({ store = true, hooksPath = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-hooks-')));
  made.push(dir);
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const fakebin = join(dir, 'fakebin');
  const log = join(dir, 'triqual.log');
  const deny = join(dir, 'deny.txt');
  for (const d of [repo, home, fakebin]) mkdirSync(d);
  writeFileSync(deny, `${TERM}\n`);
  writeFileSync(log, '');
  writeExec(join(fakebin, 'triqual'), '#!/bin/sh\necho "$*" >> "$FAKE_TRIQUAL_LOG"\nexit "${FAKE_TRIQUAL_EXIT:-0}"\n');
  writeExec(join(fakebin, 'ssh'), `#!/bin/sh\necho "Hi $FAKE_SSH_LOGIN! You've successfully authenticated, but GitHub does not provide shell access." >&2\nexit 1\n`);
  const env = {
    ...baseEnv(), HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', PUBLIC_EXPORT_DENY: deny,
    PATH: `${fakebin}:${process.env.PATH}`, FAKE_TRIQUAL_LOG: log, FAKE_SSH_LOGIN: OWNER.login,
  };
  const run = (cwd, cmd, args, extra = {}, input) => spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', input });
  const git = (cwd, ...args) => run(cwd, 'git', args);
  const must = (cwd, ...args) => {
    const result = git(cwd, ...args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result;
  };
  must(repo, 'init', '-q');
  must(repo, 'config', 'user.name', 'Tester');
  must(repo, 'config', 'user.email', ['tester', 'example.invalid'].join('@'));
  must(repo, 'config', 'commit.gpgsign', 'false');
  // The gate's own files, committed before any hook exists so that a linked worktree has them too.
  cpSync(join(ROOT, 'bin'), join(repo, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'plugins', 'memory-report', 'lib'), join(repo, 'plugins', 'memory-report', 'lib'), { recursive: true });
  cpSync(join(ROOT, 'plugins', 'methodology', 'cli', 'lib'), join(repo, 'plugins', 'methodology', 'cli', 'lib'), { recursive: true });
  must(repo, 'add', '-A');
  must(repo, 'commit', '-q', '-m', 'base');
  const hooks = join(repo, '.git', 'hooks');
  if (store) {
    must(repo, 'config', '--local', 'triqual.tracking', 'store');
    writeExec(join(hooks, STORE_SCRIPT), `#!/bin/sh\n${STORE_HOOK_LINES['pre-commit'].join('\n')}\n`);
    writeExec(join(hooks, 'pre-commit'), `#!/bin/sh\n${STORE_LINE}\n`);
  }
  if (hooksPath) must(repo, 'config', '--local', 'core.hooksPath', hooksPath);
  const install = (cwd = repo) => run(cwd, process.execPath, [INSTALL]);
  const write = (cwd, path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { repo, dir, hooks, git, must, run, install, write, calls };
}

test('installs the content gate after the store gate in pre-commit and creates an executable pre-push, exit 0', () => {
  const { hooks, install } = makeRepo();
  const result = install();
  assert.equal(result.status, 0, result.stderr);
  const preCommit = readFileSync(join(hooks, 'pre-commit'), 'utf8').split('\n');
  assert.equal(preCommit[0], '#!/bin/sh');
  assert.equal(preCommit[1], STORE_LINE);
  assert.equal(preCommit[2], GATE_LINE);
  const prePush = readFileSync(join(hooks, 'pre-push'), 'utf8').split('\n');
  assert.equal(prePush[0], '#!/bin/sh');
  assert.equal(prePush[1], PUSH_LINE);
  assert.equal(statSync(join(hooks, 'pre-push')).mode & 0o777, 0o755);
  assert.equal(statSync(join(hooks, 'pre-commit')).mode & 0o111, 0o111);
});

test('running it twice leaves one line each', () => {
  const { hooks, install } = makeRepo();
  assert.equal(install().status, 0);
  assert.equal(install().status, 0);
  const preCommit = readFileSync(join(hooks, 'pre-commit'), 'utf8');
  const prePush = readFileSync(join(hooks, 'pre-push'), 'utf8');
  assert.equal(count(preCommit, GATE_LINE), 1);
  assert.equal(count(preCommit, STORE_LINE), 1);
  assert.equal(count(prePush, PUSH_LINE), 1);
});

test('an existing pre-push is kept and the line is appended to it, even without a trailing newline', () => {
  const { hooks, install } = makeRepo();
  writeExec(join(hooks, 'pre-push'), '#!/bin/sh\necho mine');
  assert.equal(install().status, 0);
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8'), `#!/bin/sh\necho mine\n${PUSH_LINE}\n`);
});

test('it refuses with exit 3 when core.hooksPath is set, and changes nothing', () => {
  const { hooks, install } = makeRepo({ hooksPath: '.husky' });
  const before = readFileSync(join(hooks, 'pre-commit'), 'utf8');
  const result = install();
  assert.equal(result.status, 3);
  assert.match(result.stderr, /core\.hooksPath/);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), before);
  assert.equal(existsSync(join(hooks, 'pre-push')), false);
});

test('it refuses with exit 3 without the store gate line, and changes nothing', () => {
  const { hooks, install } = makeRepo({ store: false });
  const none = install();
  assert.equal(none.status, 3);
  assert.match(none.stderr, /progress-init --store/);
  assert.equal(existsSync(join(hooks, 'pre-commit')), false);
  assert.equal(existsSync(join(hooks, 'pre-push')), false);
  const other = '#!/bin/sh\necho another gate\n';
  writeExec(join(hooks, 'pre-commit'), other);
  assert.equal(install().status, 3);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), other);
  assert.equal(existsSync(join(hooks, 'pre-push')), false);
});

test('in a linked worktree a clean commit passes, and a planted term is refused after the store gate ran', () => {
  const { repo, dir, install, must, git, write, calls } = makeRepo();
  assert.equal(install().status, 0);
  const worktree = join(dir, 'wt');
  must(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  assert.ok(existsSync(join(worktree, 'bin', 'hooks', 'content-gate-pre-commit.mjs')), 'the worktree has the gate script');

  write(worktree, 'clean.txt', 'nothing to see\n');
  must(worktree, 'add', 'clean.txt');
  const passed = git(worktree, 'commit', '-q', '-m', 'clean');
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(calls(), ['tracking hook pre-commit']);

  write(worktree, 'a.txt', `first\nowned by ${TERM} inc\n`);
  must(worktree, 'add', 'a.txt');
  const refused = git(worktree, 'commit', '-q', '-m', 'planted');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^a\.txt:2 · local-term$/m);
  assert.ok(!refused.stderr.includes(TERM), 'the matched term is never printed');
  assert.deepEqual(calls(), ['tracking hook pre-commit', 'tracking hook pre-commit'], 'the store gate ran for each commit');
});

test('the content gate goes right after the store line, so a trailing exec in the existing pre-commit cannot skip it', () => {
  const { repo, hooks, install, must, git, write } = makeRepo();
  const kept = 'echo "framework hook"';
  const tail = 'exec true';
  writeExec(join(hooks, 'pre-commit'), `#!/bin/sh\n${STORE_LINE}\n${kept}\n${tail}\n`);
  assert.equal(install().status, 0);
  const lines = readFileSync(join(hooks, 'pre-commit'), 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 5), ['#!/bin/sh', STORE_LINE, GATE_LINE, kept, tail]);
  assert.equal(install().status, 0);
  assert.equal(count(readFileSync(join(hooks, 'pre-commit'), 'utf8'), GATE_LINE), 1, 'a second install adds no copy');

  write(repo, 'a.txt', `first\nowned by ${TERM} inc\n`);
  must(repo, 'add', 'a.txt');
  const refused = git(repo, 'commit', '-q', '-m', 'planted');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^a\.txt:2 · local-term$/m);

  must(repo, 'rm', '-q', '--cached', 'a.txt');
  write(repo, 'clean.txt', 'nothing to see\n');
  must(repo, 'add', 'clean.txt');
  const passed = git(repo, 'commit', '-q', '-m', 'clean');
  assert.equal(passed.status, 0, passed.stderr);
});

test('the store gate runs before the content gate: when it refuses, the content gate never reports', () => {
  const { repo, dir, install, must, run, write, calls } = makeRepo();
  assert.equal(install().status, 0);
  const worktree = join(dir, 'wt');
  must(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  write(worktree, 'a.txt', `owned by ${TERM} inc\n`);
  must(worktree, 'add', 'a.txt');
  const refused = run(worktree, 'git', ['commit', '-q', '-m', 'x'], { FAKE_TRIQUAL_EXIT: '1' });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(calls(), ['tracking hook pre-commit']);
  assert.doesNotMatch(refused.stderr, /local-term/);
});

test('the installed pre-push accepts foreign metadata and Claude attribution but keeps account routing', () => {
  const { repo, hooks, install, must, run } = makeRepo();
  assert.equal(install().status, 0);
  must(repo, 'commit', '--allow-empty', '-m', 'feat: from another session\n\nCo-Authored-By: Claude <bot@example.invalid>');
  const head = must(repo, 'rev-parse', 'HEAD').stdout.trim();
  const ranges = `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`;
  const push = join(hooks, 'pre-push');

  // The URL argument arrived: an https URL is refused for being one, not for a missing argument.
  const https = run(repo, 'sh', [push, 'origin', 'https://example.invalid/x.git'], {}, ranges);
  assert.equal(https.status, 1);
  assert.match(https.stderr, /identity: refusing the push, the remote URL is not /);
  assert.doesNotMatch(https.stderr, /usage/);

  // The existing commit has the fixture's foreign author/committer and Claude attribution.
  const ssh = run(repo, 'sh', [push, 'origin', PUBLIC_SSH_URL], {}, ranges);
  assert.equal(ssh.status, 0, ssh.stderr);
  assert.equal(ssh.stderr, '');
  const wrongAccount = run(repo, 'sh', [push, 'origin', PUBLIC_SSH_URL], { FAKE_SSH_LOGIN: 'other-login' }, ranges);
  assert.equal(wrongAccount.status, 1);
  assert.match(wrongAccount.stderr, /ssh authenticates as other-login/);
});
