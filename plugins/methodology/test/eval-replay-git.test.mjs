import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  mainCheckout, resolveOriginal, resolveRef, firstParent, isMerged, existsAt, caseFiles,
  unnamedSymbols, countUnnamedLiterals, restoreFiles,
} from '../cli/lib/eval-replay-git.mjs';

// Invented repo only. git runs as an args array with a timeout; the fixture commits sign nothing.
function git(cwd, ...args) {
  const last = args.at(-1);
  const opts = last && typeof last === 'object' && !Array.isArray(last) ? args.pop() : {};
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (opts.allowFail) return r;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const commitAll = (cwd, message) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
};

const write = (cwd, path, body) => {
  const full = join(cwd, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};

// Invalid UTF-8 bytes, plus a file above spawnSync's 1 MiB default maxBuffer.
const BLOB = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x0a]);
const BIG = Buffer.alloc((1 << 20) + 4096);
for (let i = 0; i < BIG.length; i++) BIG[i] = i % 251;

let repo;
let base;
let original;
let sideSha;
let noTestBase;
let noTestOriginal;
let supportBase;
let supportOriginal;
let binOriginal;
let expectOriginal;
let worktreeParent;
let worktreeDir;
let out;

const showAt = (sha, path) => git(repo, 'show', `${sha}:${path}`);

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'replay-git-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', 'export function add(a, b) { return a + b; }\n');
  base = commitAll(repo, 'feat: a');

  git(repo, 'checkout', '-q', '-b', 'side');
  write(repo, 'src/side.mjs', 'export const side = 1;\n');
  sideSha = commitAll(repo, 'feat: side');
  git(repo, 'checkout', '-q', 'main');

  write(repo, 'src/b.mjs', 'export function mul(a, b) { return a * b; }\n');
  write(repo, 'test/b.test.mjs', [
    "import { mul } from '../src/b.mjs';",
    "import helper from './helpers/h.mjs';",
    '',
    "assert.equal(mul(2, 3), 6, 'returns the product');",
    'void helper;',
    '',
  ].join('\n'));
  write(repo, 'test/helpers/h.mjs', 'export default function helper(x) { return x; }\n');
  original = commitAll(repo, 'feat: b');

  noTestBase = original;
  write(repo, 'src/a.mjs', 'export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n');
  noTestOriginal = commitAll(repo, 'chore: touch src only');

  supportBase = base;
  git(repo, 'checkout', '-q', '-b', 'support', base);
  write(repo, 'test/use.test.mjs', [
    "import { readFileSync } from 'node:fs';",
    '',
    "const doc = readFileSync(new URL('../fixtures/h.json', import.meta.url), 'utf8');",
    'void doc;',
    '',
  ].join('\n'));
  write(repo, 'fixtures/h.json', '{ "ok": true }\n');
  supportOriginal = commitAll(repo, 'feat: support helper');
  git(repo, 'checkout', '-q', 'main');

  git(repo, 'checkout', '-q', '-b', 'bin', base);
  write(repo, 'fixtures/blob.bin', BLOB);
  write(repo, 'fixtures/big.bin', BIG);
  binOriginal = commitAll(repo, 'chore: binary fixtures');
  git(repo, 'checkout', '-q', '-b', 'expect', base);
  write(repo, 'test/expect.test.mjs', [
    "expect(x).toBe('three word literal');",
    "expect(x).not.toBe('another three words');",
    "expect(y).resolves.toBe('fourth three words');",
    '',
  ].join('\n'));
  expectOriginal = commitAll(repo, 'chore: expect matchers');
  git(repo, 'checkout', '-q', 'main');

  worktreeParent = mkdtempSync(join(tmpdir(), 'replay-git-wt-'));
  worktreeDir = join(worktreeParent, 'wt');
  git(repo, 'worktree', 'add', '--detach', '-q', worktreeDir, 'HEAD');
  out = mkdtempSync(join(tmpdir(), 'replay-git-out-'));
});

after(() => {
  if (repo && worktreeDir) {
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktreeDir], { timeout: 60_000 });
  }
  if (worktreeParent) rmSync(worktreeParent, { recursive: true, force: true });
  if (out) rmSync(out, { recursive: true, force: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('resolveOriginal by sha and by subject; the last ref wins', () => {
  assert.equal(resolveOriginal(repo, [{ subject: 'feat: b' }]), original);
  assert.equal(resolveOriginal(repo, [{ sha: 'deadbeef' }, { sha: original.slice(0, 7) }]), original);
  assert.equal(resolveOriginal(repo, [{ subject: 'nothing like it' }]), null);
  assert.equal(resolveOriginal(repo, [{ sha: base }, { subject: 'feat: b' }]), original);
});

test('firstParent and isMerged', () => {
  assert.equal(firstParent(repo, original), base);
  assert.equal(isMerged(repo, original), true);
  assert.equal(isMerged(repo, sideSha), false);
});

test('existsAt tells whether a path is a file of the commit', () => {
  assert.equal(existsAt(repo, original, 'src/b.mjs'), true);
  assert.equal(existsAt(repo, base, 'src/b.mjs'), false);
  assert.equal(existsAt(repo, original, '.methodology/x.md'), false);
});

test('isMerged counts a commit whose changed files landed on main unchanged (squash merge, branch deleted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-squash-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'src/a.mjs', 'export const a = 1;\n');
    commitAll(dir, 'feat: base');
    git(dir, 'checkout', '-q', '-b', 'wt/x');
    write(dir, 'src/n.mjs', 'export const n = 1;\n');
    write(dir, 'test/n.test.mjs', "import { n } from '../src/n.mjs';\n");
    const first = commitAll(dir, 'feat: n');
    write(dir, 'src/m.mjs', 'export const m = 1;\n');
    const second = commitAll(dir, 'feat: m');
    write(dir, 'src/n.mjs', 'export const n = 2;\n');
    const third = commitAll(dir, 'fix: n again');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--squash', 'wt/x');
    commitAll(dir, 'feat: squashed');
    git(dir, 'branch', '-D', 'wt/x');
    assert.equal(isMerged(dir, third), true);
    assert.equal(isMerged(dir, second), true);
    // n.mjs was changed again after the first commit, so its content did not land as committed.
    assert.equal(isMerged(dir, first), false);
    write(dir, 'src/m.mjs', 'export const m = 3;\n');
    commitAll(dir, 'feat: m later');
    assert.equal(isMerged(dir, second), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMerged does not count a deletion-only commit as merged just because the file is gone from main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-del-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'src/old.mjs', 'export const old = 1;\n');
    write(dir, 'src/keep.mjs', 'export const keep = 1;\n');
    commitAll(dir, 'feat: base');
    git(dir, 'checkout', '-q', '-b', 'wt/del');
    git(dir, 'rm', '-q', 'src/old.mjs');
    const onlyDelete = commitAll(dir, 'chore: drop old');
    write(dir, 'src/new.mjs', 'export const added = 1;\n');
    git(dir, 'rm', '-q', 'src/keep.mjs');
    const deleteAndAdd = commitAll(dir, 'feat: add new, drop keep');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'rm', '-q', 'src/old.mjs');
    commitAll(dir, 'chore: drop old on main');
    assert.equal(isMerged(dir, onlyDelete), false);
    // With one added file that is on main byte-identical, the deletions count as landed.
    git(dir, 'rm', '-q', 'src/keep.mjs');
    write(dir, 'src/new.mjs', 'export const added = 1;\n');
    commitAll(dir, 'feat: same content by another route');
    assert.equal(isMerged(dir, deleteAndAdd), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRef: a subject shared by several commits is ambiguous unless exactly one falls in the time window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-ref-'));
  const commitAt = (subject, at) => {
    git(dir, 'add', '-A');
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at },
    });
    assert.equal(r.status, 0, r.stderr);
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'a.txt', '1\n');
    commitAt('feat: base', '2026-11-01T10:00:00Z');
    write(dir, 'a.txt', '2\n');
    const old = commitAt('fix: twin', '2026-11-10T10:00:00Z');
    write(dir, 'a.txt', '3\n');
    const recent = commitAt('fix: twin', '2026-11-20T10:00:00Z');
    const window = { from: Date.parse('2026-11-20T09:00:00Z'), to: Date.parse('2026-11-20T11:00:00Z') };
    assert.deepEqual(resolveRef(dir, [{ subject: 'fix: twin' }], window), { sha: recent, bySubject: true, ambiguous: false });
    assert.equal(resolveRef(dir, [{ subject: 'fix: twin' }]).ambiguous, true);
    assert.equal(resolveRef(dir, [{ subject: 'fix: twin' }], { from: Date.parse('2026-11-05T00:00:00Z'), to: Date.parse('2026-11-25T00:00:00Z') }).ambiguous, true);
    assert.equal(resolveRef(dir, [{ subject: 'fix: twin' }], { from: Date.parse('2026-12-01T00:00:00Z'), to: Date.parse('2026-12-02T00:00:00Z') }).ambiguous, true);
    // One match is taken whether or not it is in the window; a sha is never ambiguous.
    assert.equal(resolveRef(dir, [{ subject: 'feat: base' }], window).ambiguous, false);
    assert.equal(resolveRef(dir, [{ subject: 'feat: base' }]).bySubject, true);
    assert.deepEqual(resolveRef(dir, [{ sha: old }], window), { sha: old, bySubject: false, ambiguous: false });
    assert.equal(resolveRef(dir, [{ subject: 'no such subject' }], window), null);
    assert.equal(resolveOriginal(dir, [{ subject: 'fix: twin' }]), recent);
    // A longer subject that contains the wanted one (a squash suffix, a sibling commit) is no second match while one commit has exactly it.
    write(dir, 'a.txt', '4\n');
    commitAt('fix: twin again', '2026-11-20T10:01:00Z');
    write(dir, 'a.txt', '5\n');
    const squash = commitAt('fix: lone (#7)', '2026-11-20T10:02:00Z');
    write(dir, 'a.txt', '6\n');
    const exact = commitAt('fix: lone', '2026-11-20T10:03:00Z');
    assert.deepEqual(resolveRef(dir, [{ subject: 'fix: lone' }], window), { sha: exact, bySubject: true, ambiguous: false });
    assert.deepEqual(resolveRef(dir, [{ subject: 'fix: lone' }]), { sha: exact, bySubject: true, ambiguous: false });
    assert.deepEqual(resolveRef(dir, [{ subject: 'fix: twin' }], window), { sha: recent, bySubject: true, ambiguous: false });
    assert.equal(resolveRef(dir, [{ subject: 'fix: twin' }]).ambiguous, true);
    // With no commit that has exactly the subject, the one that contains it is taken.
    assert.deepEqual(resolveRef(dir, [{ subject: 'fix: lone (#' }], window), { sha: squash, bySubject: true, ambiguous: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('caseFiles: hidden tests and unnamed support files', () => {
  assert.deepEqual(caseFiles(repo, base, original, 'implement mul in src/b.mjs'), {
    hiddenTests: ['test/b.test.mjs', 'test/helpers/h.mjs'], supportFiles: [] });
  assert.deepEqual(caseFiles(repo, noTestBase, noTestOriginal, 'x').hiddenTests, []);
  assert.deepEqual(caseFiles(repo, supportBase, supportOriginal, 'x'), {
    hiddenTests: ['test/use.test.mjs'], supportFiles: ['fixtures/h.json'] });
  assert.deepEqual(caseFiles(repo, supportBase, supportOriginal, 'fixtures/h.json').supportFiles, []);
});

test('unnamedSymbols: a name neither at base nor in the brief', () => {
  assert.deepEqual(unnamedSymbols(repo, base, original, ['test/b.test.mjs'], 'export mul'), { checked: true, names: ['helper'] });
  assert.deepEqual(unnamedSymbols(repo, base, original, ['test/b.test.mjs'], 'export mul and helper'), { checked: true, names: [] });
  assert.equal(unnamedSymbols(repo, base, original, ['tests/test_b.py'], '').checked, false);
});

test('countUnnamedLiterals counts asserted three-word literals absent from base and brief', () => {
  assert.equal(countUnnamedLiterals(repo, base, original, ['test/b.test.mjs'], ''), 1);
  assert.equal(countUnnamedLiterals(repo, base, original, ['test/b.test.mjs'], 'it returns the product'), 0);
});

test('restoreFiles writes the original content', () => {
  assert.equal(restoreFiles(repo, original, ['test/b.test.mjs'], out), true);
  assert.equal(readFileSync(join(out, 'test/b.test.mjs'), 'utf8'), showAt(original, 'test/b.test.mjs'));
});

test('countUnnamedLiterals reads literals in expect() matcher arguments', () => {
  assert.equal(countUnnamedLiterals(repo, base, expectOriginal, ['test/expect.test.mjs'], ''), 3);
  assert.equal(countUnnamedLiterals(repo, base, expectOriginal, ['test/expect.test.mjs'], 'fourth three words'), 2);
});

test('restoreFiles restores binary and over-1-MiB files byte for byte', () => {
  assert.equal(restoreFiles(repo, binOriginal, ['fixtures/blob.bin', 'fixtures/big.bin'], out), true);
  assert.ok(readFileSync(join(out, 'fixtures/blob.bin')).equals(BLOB));
  assert.ok(readFileSync(join(out, 'fixtures/big.bin')).equals(BIG));
});

test('mainCheckout of a worktree is the main checkout', () => {
  assert.equal(mainCheckout(worktreeDir), realpathSync(repo));
});
