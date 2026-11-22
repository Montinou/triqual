import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneAt, cloneForValidation, removeClone } from '../cli/lib/eval-replay-clone.mjs';

// A private temp root: the triqual-replay-* counts below must see only this file's dirs,
// not the clones of test files running concurrently (os.tmpdir() reads TMPDIR on each call).
const privateTmp = mkdtempSync(join(tmpdir(), 'replay-clone-tmp-'));
process.env.TMPDIR = privateTmp;

// Invented repo, commits and author only. Runs git with an args array and a timeout; `{ allowFail: true }` returns the raw result.
function git(cwd, ...args) {
  const last = args.at(-1);
  const opts = last && typeof last === 'object' && !Array.isArray(last) ? args.pop() : {};
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (opts.allowFail) return r;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const commitFile = (cwd, name) => {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, 'add', name);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `add ${name}`);
};

const replayDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('triqual-replay-')).length;

let repo;
let firstSha;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
  git(repo, 'init', '-q', '-b', 'main');
  commitFile(repo, 'a.txt');
  firstSha = git(repo, 'rev-parse', 'HEAD').trim();
  commitFile(repo, 'b.txt');
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(privateTmp, { recursive: true, force: true });
});

test('a clone has no remote and its HEAD is the sha', () => {
  const dir = cloneAt(repo, firstSha);
  try {
    assert.equal(git(dir, 'remote').trim(), '');
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), firstSha);
    assert.equal(git(dir, 'symbolic-ref', '-q', 'HEAD', { allowFail: true }).status, 1); // detached
  } finally { removeClone(dir); }
});

test('a commit inside the clone leaves the main checkout unchanged', () => {
  const before = git(repo, 'for-each-ref').trim();
  const dir = cloneAt(repo, firstSha);
  try { commitFile(dir, 'x.txt'); } finally { removeClone(dir); }
  assert.equal(git(repo, 'for-each-ref').trim(), before);
  assert.equal(existsSync(dir), false);
});

test('the clone has no hooks', () => {
  writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const dir = cloneAt(repo, firstSha);
  try {
    assert.equal(existsSync(join(dir, '.git/hooks/pre-commit')), false);
    assert.equal(git(dir, 'config', '--get', 'core.hooksPath', { allowFail: true }).stdout.trim(), '');
  } finally { removeClone(dir); }
});

test('an unknown sha throws "clone failed" and leaves no directory', () => {
  const before = replayDirs();
  assert.throws(() => cloneAt(repo, 'f'.repeat(40)), /^Error: clone failed$/);
  assert.equal(replayDirs(), before);
});

test('the clone holds no history beyond the base: no refs, no alternates, the later commit is unreachable', () => {
  const later = git(repo, 'rev-parse', 'HEAD').trim();
  assert.notEqual(later, firstSha);
  const dir = cloneAt(repo, firstSha);
  try {
    assert.equal(git(dir, 'for-each-ref').trim(), '');
    assert.equal(git(dir, 'rev-list', '--all').trim(), firstSha); // the detached HEAD only
    assert.equal(git(dir, 'rev-list', 'HEAD').trim(), firstSha);
    assert.equal(git(dir, 'cat-file', '-e', later, { allowFail: true }).status === 0, false);
    assert.equal(git(dir, 'show', 'main:b.txt', { allowFail: true }).status === 0, false);
    assert.equal(existsSync(join(dir, '.git/objects/info/alternates')), false);
    assert.equal(git(dir, 'remote').trim(), '');
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), firstSha);
  } finally { removeClone(dir); }
});

test('a sha that is not a full hex object name throws "clone failed"', () => {
  assert.throws(() => cloneAt(repo, '--upload-pack=true'), /^Error: clone failed$/);
  assert.throws(() => cloneAt(repo, 'main'), /^Error: clone failed$/);
});

test('cloneForValidation holds base and original, checks out base, and can move to original; no remote or alternates', () => {
  const later = git(repo, 'rev-parse', 'HEAD').trim();
  const dir = cloneForValidation(repo, firstSha, later);
  try {
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), firstSha);
    assert.equal(existsSync(join(dir, 'b.txt')), false);
    assert.equal(git(dir, 'remote').trim(), '');
    assert.equal(existsSync(join(dir, '.git/objects/info/alternates')), false);
    git(dir, 'checkout', '-q', '-f', '--detach', later);
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), later);
    assert.equal(existsSync(join(dir, 'b.txt')), true);
  } finally { removeClone(dir); }
});

test('cloneForValidation throws "clone failed" and leaves no directory for a bad or unknown sha', () => {
  const before = replayDirs();
  const later = git(repo, 'rev-parse', 'HEAD').trim();
  assert.throws(() => cloneForValidation(repo, firstSha, 'f'.repeat(40)), /^Error: clone failed$/);
  assert.throws(() => cloneForValidation(repo, 'main', later), /^Error: clone failed$/);
  assert.throws(() => cloneForValidation(repo, firstSha, '--upload-pack=true'), /^Error: clone failed$/);
  assert.equal(replayDirs(), before);
});
