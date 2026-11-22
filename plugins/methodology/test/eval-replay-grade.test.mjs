import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneAt, removeClone } from '../cli/lib/eval-replay-clone.mjs';
import { gradeRun } from '../cli/lib/eval-replay-grade.mjs';

// Invented repo only. git runs as an args array with a timeout; the fixture commits sign nothing.
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
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

const writeOriginalSource = (dir) => {
  write(dir, 'src/b.mjs', 'export function mul(a, b) { return a * b; }\n');
};

let repo;
let base;
let original;
let supportOriginal;
let kase;
let kaseWithSupport;
let clone;
let cloneWithSetupLink;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'replay-grade-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', 'export function add(a, b) { return a + b; }\n');
  write(repo, 'test/a.test.mjs', "import test from 'node:test'; test('a', () => {});\n");
  base = commitAll(repo, 'feat: a');

  writeOriginalSource(repo);
  write(repo, 'test/b.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { mul } from '../src/b.mjs';",
    '',
    "test('mul', () => {",
    '  assert.equal(mul(2, 3), 6);',
    '});',
    '',
  ].join('\n'));
  original = commitAll(repo, 'feat: b');

  git(repo, 'checkout', '-q', '-b', 'support', base);
  writeOriginalSource(repo);
  write(repo, 'fixtures/h.json', '{ "a": 2, "b": 3, "product": 6 }\n');
  write(repo, 'test/b.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { mul } from '../src/b.mjs';",
    '',
    "test('mul with support', () => {",
    "  const { a, b, product } = JSON.parse(readFileSync(new URL('../fixtures/h.json', import.meta.url), 'utf8'));",
    '  assert.equal(mul(a, b), product);',
    '});',
    '',
  ].join('\n'));
  supportOriginal = commitAll(repo, 'feat: b with support');
  git(repo, 'checkout', '-q', 'main');

  kase = {
    base,
    original,
    hiddenTests: ['test/b.test.mjs'],
    supportFiles: [],
    testCommand: 'node --test test/b.test.mjs',
  };
  kaseWithSupport = {
    base,
    original: supportOriginal,
    hiddenTests: ['test/b.test.mjs'],
    supportFiles: ['fixtures/h.json'],
    testCommand: 'node --test test/b.test.mjs',
  };
});

after(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  clone = cloneAt(repo, base);
  cloneWithSetupLink = cloneAt(repo, base);
  symlinkSync(repo, join(cloneWithSetupLink, 'node_modules'));
});

afterEach(() => {
  if (clone) removeClone(clone);
  if (cloneWithSetupLink) removeClone(cloneWithSetupLink);
});

test('the original change passes', () => {
  writeOriginalSource(clone);
  assert.equal(gradeRun({ repo, clone, kase, env: process.env }).outcome, 'pass');
});
test('setup output listed in setupPaths is not a change', () => {
  // a node_modules symlink created by setup, recorded right after setup
  assert.equal(gradeRun({ repo, clone: cloneWithSetupLink, kase: { ...kase, setupPaths: ['node_modules'] }, env: process.env }).outcome, 'no-change');
});
test('no change is no-change', () => {
  assert.equal(gradeRun({ repo, clone, kase, env: process.env }).outcome, 'no-change');
});
test('editing only the hidden test is no-change', () => {
  writeFileSync(join(clone, 'test/b.test.mjs'), "import test from 'node:test'; test('ok', () => {});\n");
  assert.equal(gradeRun({ repo, clone, kase, env: process.env }).outcome, 'no-change');
});
test('a trivially passing test plus a wrong source change still fails after the overwrite', () => {
  writeFileSync(join(clone, 'test/b.test.mjs'), "import test from 'node:test'; test('ok', () => {});\n");
  writeFileSync(join(clone, 'src/b.mjs'), 'export const mul = () => 0;\n');
  assert.equal(gradeRun({ repo, clone, kase, env: process.env }).outcome, 'tests-failed');
});
test('a missing support file is restored before the tests run', () => {
  writeOriginalSource(clone); // the support fixture file is not written by the "model"
  assert.equal(gradeRun({ repo, clone, kase: kaseWithSupport, env: process.env }).outcome, 'pass');
});
test('{{WORK}} in the test command is the clone', () => {
  writeOriginalSource(clone);
  const k = { ...kase, testCommand: 'node --test {{WORK}}/test/b.test.mjs' };
  assert.equal(gradeRun({ repo, clone, kase: k, env: process.env }).outcome, 'pass');
});
test('a hanging test command is timeout', () => {
  writeOriginalSource(clone);
  assert.equal(gradeRun({ repo, clone, kase: { ...kase, testCommand: 'sleep 5' }, env: process.env, timeoutSeconds: 1 }).outcome, 'timeout');
});
test('editing only a support file is no-change, a failed restore is setup-failed, and a committed source change passes', () => {
  write(clone, 'fixtures/h.json', '{ "a": 0 }\n');
  assert.equal(gradeRun({ repo, clone, kase: kaseWithSupport, env: process.env }).outcome, 'no-change');
  writeOriginalSource(clone);
  commitAll(clone, 'feat: committed by model');
  assert.equal(gradeRun({ repo, clone, kase: { ...kase, original: 'f'.repeat(40) }, env: process.env }).outcome, 'setup-failed');
  assert.equal(gradeRun({ repo, clone, kase, env: process.env }).outcome, 'pass');
});
