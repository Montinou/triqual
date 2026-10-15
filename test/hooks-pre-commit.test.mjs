// Tests for bin/hooks/content-gate-pre-commit.mjs: the pre-commit hook that runs the content gate on the index (spec U2). Each
// test builds a temp git repo with the script wired as .git/hooks/pre-commit, a temp deny file, and a sandboxed HOME. Terms are
// invented; identities and the secret are built at runtime so no fixture needs an allowlist entry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'bin', 'hooks', 'content-gate-pre-commit.mjs');
const TERM = 'globex';

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

// A repo wired with the hook. `deny` false leaves PUBLIC_EXPORT_DENY unset and the sandbox home without a deny file.
function makeRepo({ deny = true, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-hook-'));
  made.push(dir);
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...baseEnv(), HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extraEnv };
  if (deny) {
    const file = join(dir, 'deny.txt');
    writeFileSync(file, `${TERM}\n`);
    env.PUBLIC_EXPORT_DENY = file;
  }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    return result;
  };
  const must = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result;
  };
  must('init', '-q');
  const who = ['tester', 'example.invalid'].join('@');
  must('config', 'user.name', 'Tester');
  must('config', 'user.email', who);
  must('config', 'commit.gpgsign', 'false');
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`);
  chmodSync(hook, 0o755);
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  return { repo, git, must, write };
}

test('a staged deny term is refused with path:line · category and no matched text, and the commit without it passes', () => {
  const { git, must, write } = makeRepo();
  write('a.txt', `first\nowned by ${TERM} inc\n`);
  must('add', 'a.txt');
  const refused = git('commit', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^a\.txt:2 · local-term$/m);
  assert.ok(!refused.stderr.includes(TERM), 'the matched term is never printed');
  write('a.txt', 'clean\n');
  must('add', 'a.txt');
  assert.equal(git('commit', '-m', 'x').status, 0);
});

test('git commit -a is refused for a term only in the working tree change to a tracked file', () => {
  const { git, must, write } = makeRepo();
  write('a.txt', 'clean\n');
  must('add', 'a.txt');
  must('commit', '-m', 'one');
  write('a.txt', `now ${TERM}\n`);
  const refused = git('commit', '-a', '-m', 'two');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^a\.txt:1 · local-term$/m);
});

test('git commit <path> is refused for a term only in the working tree, and passes for a clean path with a dirty one left out', () => {
  const { git, must, write } = makeRepo();
  write('a.txt', 'clean\n');
  write('b.txt', 'clean\n');
  must('add', 'a.txt', 'b.txt');
  must('commit', '-m', 'one');
  write('a.txt', `now ${TERM}\n`);
  write('b.txt', 'still clean, edited\n');
  const refused = git('commit', '-m', 'two', 'a.txt');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^a\.txt:1 · local-term$/m);
  const passed = git('commit', '-m', 'two', 'b.txt');
  assert.equal(passed.status, 0, passed.stderr);
});

test('a renamed file is checked under its new name', () => {
  const { git, must, write } = makeRepo();
  write('old.txt', `a long enough body\nowned by ${TERM} inc\nmore text here\n`);
  // The term is only in the index copy of the original, so commit it past the hook, then rename.
  must('-c', 'core.hooksPath=/dev/null', 'add', 'old.txt');
  must('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'one');
  must('mv', 'old.txt', 'new.txt');
  const refused = git('commit', '-m', 'two');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^new\.txt:2 · local-term$/m);
});

test('a path with a space is read and reported by its real name', () => {
  const { git, must, write } = makeRepo();
  write('my notes/a b.txt', `${TERM}\n`);
  must('add', '--all');
  const refused = git('commit', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^my notes\/a b\.txt:1 · local-term$/m);
});

test('a deleted file is not read: deleting a file that holds a term is not refused', () => {
  const { git, must, write } = makeRepo();
  write('a.txt', `${TERM}\n`);
  write('keep.txt', 'ok\n');
  must('-c', 'core.hooksPath=/dev/null', 'add', '--all');
  must('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'one');
  must('rm', '-q', 'a.txt');
  const passed = git('commit', '-m', 'two');
  assert.equal(passed.status, 0, passed.stderr);
});

test('a forbidden path is refused', () => {
  const { git, must, write } = makeRepo();
  write('docs/x.md', 'hello\n');
  must('add', '--all');
  const refused = git('commit', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^docs\/x\.md:0 · forbidden-path$/m);
});

test('a secret is refused', () => {
  const { git, must, write } = makeRepo();
  write('k.txt', `key ${['sk', '-', 'b'.repeat(24)].join('')}\n`);
  must('add', 'k.txt');
  const refused = git('commit', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^k\.txt:1 · secret$/m);
});

test('with no deny list configured the commit is refused, saying why', () => {
  const { git, must, write } = makeRepo({ deny: false });
  write('a.txt', 'clean\n');
  must('add', 'a.txt');
  const refused = git('commit', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no local terms/);
});

test('TRIQUAL_GATE_NO_LOCAL_TERMS=1 lets a clean commit pass without terms, and still refuses a secret', () => {
  const { git, must, write } = makeRepo({ deny: false, extraEnv: { TRIQUAL_GATE_NO_LOCAL_TERMS: '1' } });
  write('a.txt', 'clean\n');
  must('add', 'a.txt');
  const passed = git('commit', '-m', 'x');
  assert.equal(passed.status, 0, passed.stderr);
  write('k.txt', `key ${['sk', '-', 'c'.repeat(24)].join('')}\n`);
  must('add', 'k.txt');
  assert.notEqual(git('commit', '-m', 'y').status, 0);
});
