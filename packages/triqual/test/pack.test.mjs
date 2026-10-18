// What `npm pack` puts in the triqual tarball: only the package's `files` and package.json (plan npm-packages T1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the tarball holds only package.json, README.md, LICENSE, bin/ and lib/', () => {
  const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PKG, encoding: 'utf8' }));
  const paths = report.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['LICENSE', 'README.md', 'bin/triqual.mjs', 'lib/forward.mjs', 'lib/plugins.mjs', 'lib/setup.mjs', 'package.json']);
});
