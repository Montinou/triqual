// Where setup finds the installed methodology plugin (plan npm-packages T2): the user-scope installPath in
// installed_plugins.json, else the highest version directory of the plugin cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPathOf, LEGACY_MARKETPLACE, MARKETPLACE, newestCacheDir } from '../lib/plugins.mjs';

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'triqual-plugins-'));
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const writeInstalled = (home, text) => writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), text);

test('marketplace names', () => {
  assert.equal(MARKETPLACE, 'triqual');
  assert.equal(LEGACY_MARKETPLACE, 'claude-methodology');
});

test('installPathOf returns the user entry and ignores local and project ones', () => withHome((home) => {
  writeInstalled(home, JSON.stringify({ version: 2, plugins: { 'methodology@triqual': [
    { scope: 'local', projectPath: '/x', installPath: '/local' },
    { scope: 'project', projectPath: '/y', installPath: '/project' },
    { scope: 'user', installPath: '/user/0.7.3' },
  ] } }));
  assert.equal(installPathOf(home), '/user/0.7.3');
}));

test('installPathOf is null for a missing file, malformed JSON or no user entry', () => withHome((home) => {
  assert.equal(installPathOf(home), null);
  writeInstalled(home, '{not json');
  assert.equal(installPathOf(home), null);
  writeInstalled(home, JSON.stringify({ plugins: { 'methodology@triqual': [{ scope: 'local', installPath: '/l' }] } }));
  assert.equal(installPathOf(home), null);
  writeInstalled(home, JSON.stringify({ plugins: { 'methodology@triqual': [{ scope: 'user', installPath: '' }] } }));
  assert.equal(installPathOf(home), null);
}));

test('newestCacheDir picks the highest version numerically and ignores other names', () => withHome((home) => {
  const cache = join(home, '.claude', 'plugins', 'cache', 'triqual', 'methodology');
  assert.equal(newestCacheDir(home), null);
  for (const name of ['0.9.1', '0.10.0', '0.7.3', 'latest', '0.7']) mkdirSync(join(cache, name), { recursive: true });
  assert.equal(newestCacheDir(home), join(cache, '0.10.0'));
}));
