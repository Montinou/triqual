import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstallPath, resolvePlugin, enabledInClaude } from '../cli/lib/resolve.mjs';
import { resolveInstallPath as shimResolveInstallPath } from '../../../bin/triqual-shim.mjs';

const ID = 'methodology@triqual';
const PROJECT = join(tmpdir(), 'acme-project');

const user = { scope: 'user', installPath: '/cache/user/1.0.0', version: '1.0.0' };
const local = { scope: 'local', projectPath: PROJECT, installPath: '/cache/local/1.1.0', version: '1.1.0' };
const project = { scope: 'project', projectPath: '/a/b', installPath: '/p' };
const deepLocal = { scope: 'local', projectPath: '/a/b/c', installPath: '/l' };
const aUser = { scope: 'user', installPath: '/u' };

// [installed_plugins.json content, pluginId, cwd]
const CASES = [
  // user scope
  [{ version: 2, plugins: { [ID]: [user] } }, ID, '/anywhere'],
  // local and project scope for the cwd, the deepest projectPath first
  [{ version: 2, plugins: { [ID]: [user, local] } }, ID, PROJECT],
  [{ version: 2, plugins: { [ID]: [user, local] } }, ID, join(PROJECT, 'src', 'deep')],
  [{ version: 2, plugins: { [ID]: [user, local] } }, ID, `${PROJECT}2`],
  [{ version: 2, plugins: { [ID]: [aUser, project, deepLocal] } }, ID, '/a/b/c/d'],
  [{ version: 2, plugins: { [ID]: [aUser, project, deepLocal] } }, ID, '/a/b/x'],
  [{ version: 2, plugins: { [ID]: [aUser, project, deepLocal] } }, ID, '/a/z'],
  [{ version: 2, plugins: { [ID]: [project, { scope: 'project', projectPath: '/a', installPath: '/shallow' }] } }, ID, '/a/b/c'],
  [{ version: 2, plugins: { [ID]: [local] } }, ID, join(tmpdir(), 'acme-other-project')],
  // missing plugin
  [{ version: 2, plugins: { [ID]: [user] } }, 'progress-tracking@triqual', '/x'],
  [{ version: 2, plugins: {} }, ID, '/x'],
  // malformed entries
  [null, ID, '/x'],
  [{}, ID, '/x'],
  ['text', ID, '/x'],
  [{ plugins: [] }, ID, '/x'],
  [{ plugins: { [ID]: 'nope' } }, ID, '/x'],
  [{ plugins: { [ID]: [null, 3, { scope: 'user' }] } }, ID, '/x'],
  [{ plugins: { [ID]: [{ scope: 'user', installPath: '' }, user] } }, ID, '/x'],
  [{ plugins: { [ID]: [{ scope: 'local', projectPath: 7, installPath: '/bad' }, user] } }, ID, '/x'],
  [{ plugins: { [ID]: [{ scope: 'project', installPath: '/no-project-path' }] } }, ID, '/x'],
];

test('resolveInstallPath matches the shim', () => {
  for (const [installed, pluginId, cwd] of CASES) {
    const label = JSON.stringify([installed, pluginId, cwd]);
    assert.equal(resolveInstallPath(installed, pluginId, cwd), shimResolveInstallPath(installed, pluginId, cwd), label);
  }
  // The table covers every outcome: a user install, a local and a project install, and null.
  const outcomes = new Set(CASES.map(([i, p, c]) => resolveInstallPath(i, p, c)));
  for (const expected of ['/cache/user/1.0.0', '/cache/local/1.1.0', '/l', '/p', '/u', null]) {
    assert.ok(outcomes.has(expected), `no case resolves to ${expected}`);
  }
});

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cm-resolve-'));
  try {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('resolvePlugin reads installed_plugins.json under the home', () => {
  withHome((home) => {
    const file = join(home, '.claude', 'plugins', 'installed_plugins.json');
    assert.equal(resolvePlugin(home, ID, PROJECT), null, 'missing file');
    writeFileSync(file, '{ not json');
    assert.equal(resolvePlugin(home, ID, PROJECT), null, 'broken file');
    writeFileSync(file, JSON.stringify({ version: 2, plugins: { [ID]: [user, local] } }));
    assert.equal(resolvePlugin(home, ID, PROJECT), '/cache/local/1.1.0');
    assert.equal(resolvePlugin(home, ID, '/elsewhere'), '/cache/user/1.0.0');
    assert.equal(resolvePlugin(home, 'other@triqual', '/elsewhere'), null);
  });
});

test('enabledInClaude is true only for enabledPlugins[id] === true in ~/.claude/settings.json', () => {
  withHome((home) => {
    const file = join(home, '.claude', 'settings.json');
    assert.equal(enabledInClaude(home, ID), false, 'missing file');
    writeFileSync(file, '{ not json');
    assert.equal(enabledInClaude(home, ID), false, 'broken file');
    for (const value of [false, 'true', 1, null]) {
      writeFileSync(file, JSON.stringify({ enabledPlugins: { [ID]: value } }));
      assert.equal(enabledInClaude(home, ID), false, JSON.stringify(value));
    }
    writeFileSync(file, JSON.stringify({ enabledPlugins: [ID] }));
    assert.equal(enabledInClaude(home, ID), false, 'an array');
    writeFileSync(file, 'null');
    assert.equal(enabledInClaude(home, ID), false, 'null settings');
    writeFileSync(file, JSON.stringify({ enabledPlugins: { [ID]: true } }));
    assert.equal(enabledInClaude(home, ID), true);
    assert.equal(enabledInClaude(home, 'progress-tracking@triqual'), false);
  });
  withHome((home) => {
    mkdirSync(join(home, '.claude', 'settings.json')); // a directory: reading it fails
    assert.equal(enabledInClaude(home, ID), false);
  });
});

test('lib/resolve.mjs imports only node: built-ins (the installed plugin carries it alone)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lib', 'resolve.mjs'), 'utf8');
  const specifiers = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) assert.ok(s.startsWith('node:'), s);
});
