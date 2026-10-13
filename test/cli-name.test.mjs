import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD_NAME = ['skill', 'vault'].join('');

// Test directories and the manifest itself are not shipped content for this guard.
const skipped = (path) => {
  const parts = relative(ROOT, path).split(sep);
  return parts[0] === 'test' || (parts[0] === 'plugins' && parts[2] === 'test') || parts.join('/') === 'public-export.json';
};

const walk = (path) => {
  if (skipped(path)) return [];
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
};

test('no shipped file calls the vault CLI by its old name', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public-export.json'), 'utf8'));
  const pattern = new RegExp(OLD_NAME, 'i');
  const offenders = [];
  let checked = 0;
  for (const entry of manifest.include) {
    for (const file of walk(join(ROOT, entry))) {
      const buffer = readFileSync(file);
      if (buffer.includes(0)) continue; // binary
      checked += 1;
      if (pattern.test(buffer.toString('utf8'))) offenders.push(relative(ROOT, file));
    }
  }
  assert.ok(checked > 50, `walked ${checked} files`);
  assert.deepEqual(offenders, [], `files that still use the old name: ${offenders.join(', ')}`);
});
