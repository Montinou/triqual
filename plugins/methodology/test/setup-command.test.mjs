import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMMAND = join(REPO, 'plugins', 'methodology', 'commands', 'setup.md');
const BOOTSTRAP = join(REPO, 'plugins', 'methodology', 'setup', 'bootstrap.mjs');

test('commands/setup.md runs the bootstrap and lists what it changes', () => {
  const text = readFileSync(COMMAND, 'utf8');
  assert.match(text, /^---\ndescription: [^\n]+\n---\n/);
  for (const needle of [
    'node "${CLAUDE_PLUGIN_ROOT}/setup/bootstrap.mjs" --yes --keep-language --no-harness',
    '600000',
    '~/.claude/plugins/cache/triqual/methodology/*/setup/bootstrap.mjs',
    '/reload-plugins',
    '~/.local/bin',
    '~/.claude/CLAUDE.md',
    '~/.claude/settings.json',
    'Bash(triqual tracking:*)',
    'restore --yes',
    'import --replace',
    '~/.claude/backups/',
  ]) {
    assert.ok(text.includes(needle), `setup.md is missing: ${needle}`);
  }
  assert.ok(existsSync(BOOTSTRAP), 'the bootstrap the command runs exists');
});

test('the command invocation runs main in setup/bootstrap.mjs directly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'setup-command-'));
  try {
    const home = join(tmp, 'home');
    const emptyDir = join(tmp, 'empty');
    mkdirSync(home);
    mkdirSync(emptyDir);
    const r = spawnSync(process.execPath, [BOOTSTRAP, '--yes', '--keep-language', '--no-harness'], {
      env: { HOME: home, PATH: emptyDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /prereqs: failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
