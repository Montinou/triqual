import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { repoOf, hasLocalBranch } from '../src/resolve/repo.mjs';
import { normalize } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// Every fixture lives under one temp dir (realpath'd: macOS puts tmp behind /var -> /private/var).
// No git binary is used: repositories are built by hand from the files git itself would read.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-repo-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SHA = 'a'.repeat(40);
let counter = 0;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A plain repository at a fresh dir: .git/{HEAD, objects/, refs/heads/<branches>}.
function makeRepo({ head = 'ref: refs/heads/feature\n', branches = ['feature'] } = {}) {
  const root = path.join(TMP, `r${counter++}`);
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  write(path.join(git, 'HEAD'), head);
  for (const b of branches) write(path.join(git, 'refs', 'heads', b), `${SHA}\n`);
  return root;
}

test('finds the root and branch of a plain repo', () => {
  const root = makeRepo();
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.deepEqual(repoOf(deep, {}), { root, gitDir: path.join(root, '.git'), branch: 'feature' });
  assert.deepEqual(repoOf(root, {}), { root, gitDir: path.join(root, '.git'), branch: 'feature' });
});

test("reads a linked worktree's gitdir file", () => {
  const main = makeRepo({ head: 'ref: refs/heads/main\n', branches: ['main', 'topic'] });
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  write(path.join(wtGit, 'HEAD'), 'ref: refs/heads/topic\n');
  write(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(TMP, `wt${counter++}`);
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(repoOf(path.join(wt, 'src'), {}), { root: wt, gitDir: wtGit, branch: 'topic' });
  // a relative gitdir is relative to the directory holding the .git file
  const wt2 = path.join(TMP, `wt${counter++}`);
  fs.mkdirSync(wt2);
  write(path.join(wt2, '.git'), `gitdir: ${path.relative(wt2, wtGit)}\n`);
  assert.deepEqual(repoOf(wt2, {}), { root: wt2, gitDir: wtGit, branch: 'topic' });
  // the worktree's branches live in the common dir
  const r = repoOf(wt, {});
  assert.equal(hasLocalBranch(r, 'main'), true);
  assert.equal(hasLocalBranch(r, 'nope'), false);
});

test('detached HEAD yields null branch', () => {
  const root = makeRepo({ head: `${SHA}\n` });
  assert.equal(repoOf(root, {}).branch, null);
  const sha256 = makeRepo({ head: `${'b'.repeat(64)}\n` });
  assert.equal(repoOf(sha256, {}).branch, null);
});

test('no git process is spawned (child_process stubbed)', () => {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const calls = [];
  const mocks = names.map((n) =>
    mock.method(childProcess, n, (...args) => {
      calls.push([n, args[0]]);
      throw new Error(`child_process.${n} must not be called`);
    }),
  );
  syncBuiltinESMExports();
  try {
    const root = makeRepo({ branches: ['feature', 'main'] });
    const other = makeRepo();
    assert.equal(repoOf(root, {}).branch, 'feature');
    const r = normalize(
      `git status; git -C ${other} commit -m x && git checkout main && git commit -m y; GIT_DIR=${other}/.git git log`,
      { cwd: root, home: TMP, env: {} },
    );
    assert.ok(r.commands, JSON.stringify(r));
    assert.equal(r.commands[2].repo.branch, 'feature');
    assert.equal(r.commands[3].repo.branch, 'main');
  } finally {
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, []);
  // and neither module can reach a process API at all
  for (const rel of ['../src/resolve/repo.mjs', '../src/norm/normalize.mjs', '../src/norm/ops.mjs']) {
    const src = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.ok(!/child_process|process\.binding|worker_threads/.test(src), `${rel} references a process API`);
  }
});

test('no repository above the directory is null', () => {
  const dir = path.join(TMP, `plain${counter++}`);
  fs.mkdirSync(dir);
  assert.equal(repoOf(dir, {}), null);
});

test('a .git directory git would not accept is skipped, as git skips it', () => {
  // git requires HEAD, objects/ and refs/: a lone .git/HEAD written by an agent must not shadow the
  // real repository above it
  const root = makeRepo({ head: 'ref: refs/heads/main\n', branches: ['main'] });
  const sub = path.join(root, 'sub');
  write(path.join(sub, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  assert.deepEqual(repoOf(sub, {}), { root, gitDir: path.join(root, '.git'), branch: 'main' });
});

test('gitDir and workTree options select the repository', () => {
  const a = makeRepo();
  const b = makeRepo({ head: 'ref: refs/heads/main\n', branches: ['main'] });
  const wt = path.join(TMP, `w${counter++}`);
  fs.mkdirSync(wt);
  // gitDir without workTree: the current directory is the top of the work tree
  assert.deepEqual(repoOf(a, { gitDir: path.join(b, '.git') }), { root: a, gitDir: path.join(b, '.git'), branch: 'main' });
  // relative gitDir resolves from the directory
  assert.deepEqual(repoOf(a, { gitDir: path.relative(a, path.join(b, '.git')), workTree: wt }), {
    root: wt,
    gitDir: path.join(b, '.git'),
    branch: 'main',
  });
  // workTree alone keeps the discovered gitdir
  assert.deepEqual(repoOf(a, { workTree: wt }), { root: wt, gitDir: path.join(a, '.git'), branch: 'feature' });
  // a gitDir that is not a repository: git fails, nothing to protect, but never a guess
  assert.equal(repoOf(a, { gitDir: path.join(TMP, 'missing') }), UNKNOWN);
  assert.equal(repoOf(a, { gitDir: UNKNOWN }), UNKNOWN);
});

test('HEAD that is not a local branch or a hash is UNKNOWN; unreadable input is UNKNOWN', () => {
  assert.equal(repoOf(makeRepo({ head: 'ref: refs/remotes/origin/main\n' }), {}).branch, UNKNOWN);
  assert.equal(repoOf(makeRepo({ head: 'garbage\n' }), {}).branch, UNKNOWN);
  // reftable repositories keep a placeholder HEAD
  assert.equal(repoOf(makeRepo({ head: 'ref: refs/heads/.invalid\n' }), {}).branch, UNKNOWN);
  assert.equal(repoOf('relative/dir', {}), UNKNOWN);
  assert.equal(repoOf(UNKNOWN, {}), UNKNOWN);
  const failing = {
    ...fs,
    statSync() {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
  failing.realpathSync = fs.realpathSync;
  assert.equal(repoOf(makeRepo(), { fs: failing }), UNKNOWN);
});

test('packed refs count as local branches', () => {
  const root = makeRepo({ branches: [] });
  write(path.join(root, '.git', 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/packed\n`);
  const r = repoOf(root, {});
  assert.equal(hasLocalBranch(r, 'packed'), true);
  assert.equal(hasLocalBranch(r, 'pack'), false);
  assert.equal(hasLocalBranch(r, '../HEAD'), false);
  assert.equal(hasLocalBranch(UNKNOWN, 'packed'), false);
});

test('core.worktree in the repository config makes the root UNKNOWN', () => {
  const root = makeRepo();
  write(path.join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tworktree = /elsewhere\n');
  const r = repoOf(path.join(root), {});
  assert.equal(r.root, UNKNOWN);
  assert.equal(r.branch, 'feature');
  // in a linked worktree's common config or its config.worktree too
  const main = makeRepo({ head: 'ref: refs/heads/main\n', branches: ['main'] });
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  write(path.join(wtGit, 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(wtGit, 'commondir'), '../..\n');
  write(path.join(wtGit, 'config.worktree'), '[core]\n\tworktree = /x\n');
  const wt = path.join(TMP, `wt${counter++}`);
  fs.mkdirSync(wt);
  write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(repoOf(wt, {}).root, UNKNOWN);
  // an explicit work tree wins
  const wt2 = path.join(TMP, `w${counter++}`);
  fs.mkdirSync(wt2);
  assert.equal(repoOf(root, { workTree: wt2 }).root, wt2);
});
