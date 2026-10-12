import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, realpathSync, writeFileSync, readFileSync, symlinkSync, lstatSync, statSync, chmodSync, rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, sha256 } from '../lib/fsx.mjs';
import { resolveTracking, localRoot, readState, writeState, progressHash } from '../lib/tracking.mjs';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const tempDir = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const withDir = (prefix, fn) => { const d = tempDir(prefix); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
// A temp dir holding a fresh repo at <dir>/repo, so a linked worktree can live next to it inside the same temp dir.
const withRepo = (fn) => withDir('pt-trk-', (dir) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  fn(repo, dir);
});
// readState with nothing pending.
const settled = (last) => ({ version: 1, lastProgressSha256: last, pendingProgressSha256: null });
const localProgress = (repo) => {
  mkdirSync(join(repo, '.git', 'methodology'), { recursive: true });
  writeFileSync(join(repo, '.git', 'methodology', 'progress.md'), '# Progress\n');
};

test('sha256 returns the hex digest', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('writeAtomic writes through a symlink and keeps the mode', () => withDir('pt-fsx-', (dir) => {
  const real = join(dir, 'real.md');
  const link = join(dir, 'link.md');
  writeFileSync(real, 'old');
  chmodSync(real, 0o600);
  symlinkSync(real, link);
  writeAtomic(link, 'new');
  assert.ok(lstatSync(link).isSymbolicLink(), 'the link stays a link');
  assert.equal(readFileSync(real, 'utf8'), 'new');
  assert.equal(statSync(real).mode & 0o777, 0o600);
  const fresh = join(dir, 'fresh.md');
  writeAtomic(fresh, 'x');
  assert.equal(readFileSync(fresh, 'utf8'), 'x');
  assert.equal(statSync(fresh).mode & 0o777, 0o644);
}));

test('returns null outside git', () => withDir('pt-nogit-', (dir) => {
  assert.equal(resolveTracking(dir), null);
  assert.equal(localRoot(dir), null);
}));

test('returns null in a repo without progress.md', () => withRepo((repo) => {
  assert.equal(resolveTracking(repo), null);
}));

test('committed mode resolves the repo root and docs/ dirs', () => withRepo((repo) => {
  writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  const sub = join(repo, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(resolveTracking(sub), {
    mode: 'committed',
    repoRoot: repo,
    root: repo,
    progress: join(repo, 'progress.md'),
    status: join(repo, 'status.md'),
    plansDir: join(repo, 'docs', 'plans'),
    specsDir: join(repo, 'docs', 'specs'),
    statePath: null,
    duplicate: false,
  });
}));

test('local mode resolves <git-common-dir>/methodology', () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  const root = join(repo, '.git', 'methodology');
  assert.equal(t.mode, 'local');
  assert.equal(t.repoRoot, repo);
  assert.equal(t.root, root);
  assert.equal(t.progress, join(root, 'progress.md'));
  assert.equal(t.status, join(root, 'status.md'));
  assert.ok(t.plansDir.endsWith(join('.git', 'methodology', 'plans')), t.plansDir);
  assert.equal(t.specsDir, join(root, 'specs'));
  assert.ok(t.statePath.endsWith('state.json'), t.statePath);
  assert.equal(t.statePath, join(root, 'state.json'));
  assert.equal(t.duplicate, false);
  assert.equal(localRoot(repo), root);
}));

test('local mode from a linked worktree resolves the main common dir', () => withRepo((repo, dir) => {
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, ...ID, 'commit', '-qm', 'one');
  git(repo, 'worktree', 'add', '-q', '../wt', '-b', 'x');
  localProgress(repo);
  const wt = join(dir, 'wt');
  const t = resolveTracking(wt);
  assert.equal(t.mode, 'local');
  assert.equal(t.repoRoot, realpathSync(wt));
  assert.equal(realpathSync(t.root), realpathSync(join(repo, '.git', 'methodology')));
  assert.equal(t.root, realpathSync(join(repo, '.git', 'methodology')));
}));

test('both roots → committed with duplicate: true', () => withRepo((repo) => {
  writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  localProgress(repo);
  const t = resolveTracking(repo);
  assert.equal(t.mode, 'committed');
  assert.equal(t.root, repo);
  assert.equal(t.statePath, null);
  assert.equal(t.duplicate, true);
}));

test('readState on a missing or corrupt state.json returns a null hash', () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  assert.deepEqual(readState(t), settled(null));
  writeFileSync(t.statePath, '{ not json');
  assert.deepEqual(readState(t), settled(null));
}));

test('writeState then readState round-trips', () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  const hash = sha256('entry');
  writeState(t, hash);
  assert.deepEqual(readState(t), settled(hash));
  assert.equal(readFileSync(t.statePath, 'utf8'), `${JSON.stringify(settled(hash), null, 2)}\n`);
}));

test('readState reads the pending hash, each field on its own, and ignores unknown fields', () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  const [a, b] = [sha256('a'), sha256('b')];
  writeFileSync(t.statePath, JSON.stringify({ version: 1, lastProgressSha256: a, pendingProgressSha256: b, pendingHead: 'c0ffee' }));
  assert.deepEqual(readState(t), { version: 1, lastProgressSha256: a, pendingProgressSha256: b });
  // written by a first commit with no state.json: nothing was ever promoted
  writeFileSync(t.statePath, JSON.stringify({ version: 1, lastProgressSha256: null, pendingProgressSha256: b }));
  assert.deepEqual(readState(t), { version: 1, lastProgressSha256: null, pendingProgressSha256: b });
  writeFileSync(t.statePath, JSON.stringify({ version: 1, lastProgressSha256: a, pendingProgressSha256: 7 }));
  assert.deepEqual(readState(t), settled(a));
}));

test('progressHash is the sha256 of progress.md, or null when it is missing', () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  assert.equal(progressHash(t), sha256('# Progress\n'));
  rmSync(t.progress);
  assert.equal(progressHash(t), null);
}));

test('readState throws when state.json exists but cannot be read', { skip: process.getuid?.() === 0 && 'root reads mode-000 files' }, () => withRepo((repo) => {
  localProgress(repo);
  const t = resolveTracking(repo);
  writeFileSync(t.statePath, JSON.stringify({ version: 1, lastProgressSha256: sha256('x') }));
  chmodSync(t.statePath, 0o000);
  try {
    assert.throws(() => readState(t), { code: 'EACCES' });
  } finally {
    chmodSync(t.statePath, 0o644);
  }
  rmSync(t.statePath);
  mkdirSync(t.statePath);
  assert.throws(() => readState(t), { code: 'EISDIR' });
}));

test('readState returns a null hash for a committed tracking and for non-object JSON', () => withRepo((repo) => {
  writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  assert.deepEqual(readState(resolveTracking(repo)), settled(null));
  rmSync(join(repo, 'progress.md'));
  localProgress(repo);
  const t = resolveTracking(repo);
  for (const body of ['null', '42', '"str"', '[]']) {
    writeFileSync(t.statePath, body);
    assert.deepEqual(readState(t), settled(null), body);
  }
}));

test('resolveTracking ignores inherited GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE', () => withRepo((repo, dir) => {
  writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  const sub = join(repo, 'src');
  mkdirSync(sub);
  const other = join(dir, 'other');
  mkdirSync(other);
  git(other, 'init', '-q');
  localProgress(other);
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.GIT_DIR = join(other, '.git');
    const t = resolveTracking(sub);
    assert.equal(t?.mode, 'committed');
    assert.equal(t.repoRoot, repo);
    assert.equal(localRoot(sub), join(repo, '.git', 'methodology'));
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_COMMON_DIR = join(other, '.git');
    process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
    assert.equal(resolveTracking(sub)?.repoRoot, repo);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}));

// ---- final fix wave ----

test('opting in needs the exact name progress.md in either root: PROGRESS.md alone is not opted in', () => withRepo((repo) => {
  writeFileSync(join(repo, 'PROGRESS.md'), '# Progress\n');
  assert.equal(resolveTracking(repo), null, 'committed root');
  mkdirSync(join(repo, '.git', 'methodology'), { recursive: true });
  writeFileSync(join(repo, '.git', 'methodology', 'Progress.md'), '# Progress\n');
  assert.equal(resolveTracking(repo), null, 'local root');
  rmSync(join(repo, '.git', 'methodology', 'Progress.md'));
  localProgress(repo);
  assert.equal(resolveTracking(repo).mode, 'local');
  assert.equal(resolveTracking(repo).duplicate, false);
}));
