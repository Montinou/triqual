import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneAt, removeClone } from '../cli/lib/eval-replay-clone.mjs';

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
