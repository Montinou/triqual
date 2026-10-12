// The `prepare` script of package.json sets core.hooksPath only where a `.githooks` directory exists, so a tree without it
// (the public export) leaves the git configuration of whoever installs it alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const prepare = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.prepare;

// A fresh repository in a temporary directory; `env` drops every GIT_* variable so the caller's repository is never touched.
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-script-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    execFileSync('git', ['init', '-q', dir], { env });
    fn(dir, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hooksPath = (dir, env) => spawnSync('git', ['-C', dir, 'config', '--local', '--get', 'core.hooksPath'], { env, encoding: 'utf8' }).stdout.trim();
const runPrepare = (dir, env) => spawnSync(prepare, { cwd: dir, env, shell: true, encoding: 'utf8' });

test('prepare sets core.hooksPath to .githooks when the directory exists', () => withRepo((dir, env) => {
  mkdirSync(join(dir, '.githooks'));
  const run = runPrepare(dir, env);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(hooksPath(dir, env), '.githooks');
}));

test('prepare does nothing, and succeeds, when there is no .githooks directory', () => withRepo((dir, env) => {
  const run = runPrepare(dir, env);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(hooksPath(dir, env), '');
}));
