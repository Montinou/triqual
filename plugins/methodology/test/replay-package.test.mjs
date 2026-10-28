import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildPackage } from '../skills/auditing-performance/scripts/lib/replay-package.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

// A throwaway repo in the OS temp dir: a base commit, a feature commit on a branch, a plain commit on main, then a merge.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'replay-package-repo-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'replay@example.test');
  git(root, 'config', 'user.name', 'Replay Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'b.txt'), 'feature\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'add b');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'extend a\n\nbody line');
  const plain = git(root, 'rev-parse', 'HEAD');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  const merge = git(root, 'rev-parse', 'HEAD');
  const base = git(root, 'rev-list', '--max-parents=0', 'HEAD');
  return { root, plain, merge, base };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'replay-package-out-'));
const cleanup = (...dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

test('writes the diff and message', () => {
  const { root, plain } = makeRepo();
  const out = scratch();
  try {
    const res = buildPackage({ root, sha: plain, out });
    assert.equal(res.tooLarge, false);
    assert.ok(existsSync(res.diffPath));
    const diff = readFileSync(res.diffPath, 'utf8');
    assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(diff, /^\+two$/m);
    assert.equal(res.bytes, Buffer.byteLength(diff));
    const message = readFileSync(join(out, 'message.txt'), 'utf8');
    assert.match(message, /^extend a/);
    assert.match(message, /body line/);
  } finally { cleanup(root, out); }
});

test('flags a diff over maxBytes', () => {
  const { root, plain } = makeRepo();
  const out = scratch();
  try {
    const small = buildPackage({ root, sha: plain, out, maxBytes: 1000000 });
    assert.equal(small.tooLarge, false);
    const res = buildPackage({ root, sha: plain, out, maxBytes: small.bytes - 1 });
    assert.equal(res.tooLarge, true);
    assert.equal(res.bytes, small.bytes);
    const exact = buildPackage({ root, sha: plain, out, maxBytes: small.bytes });
    assert.equal(exact.tooLarge, false, 'a diff exactly at the limit is not too large');
  } finally { cleanup(root, out); }
});

test('refuses a merge commit', () => {
  const { root, merge } = makeRepo();
  const out = scratch();
  try {
    assert.throws(() => buildPackage({ root, sha: merge, out }), /merge/i);
    assert.equal(existsSync(join(out, 'diff.patch')), false, 'nothing is written for a refused commit');
  } finally { cleanup(root, out); }
});

test('refuses a root commit and an unknown sha', () => {
  const { root, base } = makeRepo();
  const out = scratch();
  try {
    assert.throws(() => buildPackage({ root, sha: base, out }), /root|parent/i);
    assert.throws(() => buildPackage({ root, sha: 'f'.repeat(40), out }), /resolve|unknown|not/i);
  } finally { cleanup(root, out); }
});

test('creates the out directory when it does not exist', () => {
  const { root, plain } = makeRepo();
  const out = join(scratch(), 'nested', 'dir');
  try {
    const res = buildPackage({ root, sha: plain, out });
    assert.ok(existsSync(res.diffPath));
  } finally { cleanup(root, out); }
});

const SCRIPT = join(import.meta.dirname, '..', 'skills', 'auditing-performance', 'scripts', 'replay.mjs');
const REFS = join(import.meta.dirname, '..', 'skills', 'auditing-performance', 'references');

test('the package subcommand prints counts and paths only, never diff or message text', () => {
  const { root, plain, merge } = makeRepo();
  const out = scratch();
  try {
    const samplePath = join(out, 'sample.json');
    const row = (sha) => ({ repo: 'tmp', root, plan: 'p.md', task: 'T1', tier: 'light', sha });
    writeFileSync(samplePath, JSON.stringify([row(plain), row(merge)]));
    const res = spawnSync(process.execPath, [SCRIPT, 'package', '--sample', samplePath, '--out', join(out, 'pkg')], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /packaged 1 of 2 sampled tasks \(0 too large, 1 refused\)/);
    for (const secret of ['two', 'extend a', 'body line', 'diff --git']) assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret), secret);
    const manifest = JSON.parse(readFileSync(join(out, 'pkg', 'packages.json'), 'utf8'));
    assert.equal(manifest.length, 2);
    assert.ok(existsSync(join(manifest[0].dir, 'diff.patch')));
    assert.match(manifest[1].error, /merge/);
  } finally { cleanup(root, out); }
});

test('the package subcommand exits 2 on missing options and 1 on an unreadable sample', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(run('package', '--out', scratch()).status, 2);
  assert.equal(run('package', '--sample', '/nonexistent/sample.json', '--out', scratch()).status, 1);
});

test('the prompts name the exact JSON fields the harness reads', () => {
  const review = readFileSync(join(REFS, 'replay-review-prompt.md'), 'utf8');
  for (const key of ['"id"', '"file"', '"line"', '"claim"']) assert.ok(review.includes(key), `review prompt names ${key}`);
  const judge = readFileSync(join(REFS, 'replay-judge-prompt.md'), 'utf8');
  for (const key of ['"id"', '"group"', '"verdict"', '"severity"', 'confirmed', 'refuted']) assert.ok(judge.includes(key), `judge prompt names ${key}`);
});
