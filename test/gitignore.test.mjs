// Tests for .gitignore: every FORBIDDEN_PATHS pattern is ignored (so a private-only file is not committed by accident in the
// public repository) and the progress-tracking templates, which ship in the plugin, are not. The file is read from this
// repository's root, so the test also passes in the export's staging directory, which has no .git.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_PATHS } from '../bin/lib/content-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// A fresh repository holding only a copy of .gitignore: no global ignore file, no index, nothing else can decide the answer.
function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitignore-test-'));
  made.push(dir);
  execFileSync('git', ['init', '--quiet', dir]);
  copyFileSync(join(ROOT, '.gitignore'), join(dir, '.gitignore'));
  return dir;
}

function ignored(dir, path) {
  try {
    execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', dir, 'check-ignore', '--no-index', '--quiet', path], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// A trailing slash is a directory: a file under it. Anything else is that one file.
const sample = (pattern) => (pattern.endsWith('/') ? `${pattern.slice(1)}sample.md` : pattern.slice(1));

test('.gitignore ignores a sample path under every FORBIDDEN_PATHS entry', () => {
  const dir = freshRepo();
  for (const pattern of FORBIDDEN_PATHS) assert.ok(ignored(dir, sample(pattern)), `${pattern} is ignored (${sample(pattern)})`);
});

test('.gitignore ignores the forbidden paths only at the repository root', () => {
  const dir = freshRepo();
  assert.equal(ignored(dir, 'plugins/progress-tracking/templates/progress.md'), false);
  assert.equal(ignored(dir, 'plugins/progress-tracking/templates/status.md'), false);
  assert.equal(ignored(dir, 'plugins/methodology/docs/guide.md'), false);
  assert.equal(ignored(dir, 'plugins/methodology/CLAUDE.md'), false);
});

test('.gitignore keeps the existing ignores', () => {
  const dir = freshRepo();
  for (const path of ['node_modules/x/index.js', '.DS_Store', '.worktrees/a/b.txt']) assert.ok(ignored(dir, path), path);
});
