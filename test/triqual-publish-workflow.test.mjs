// The triqual package's publish workflow (plan npm-packages T3), read as text like test/ci-workflow.test.mjs: a
// triqual-v tag publishes through npm trusted publishing, only from a commit on main, with no npm token anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, '.github', 'workflows', 'triqual-publish.yml'), 'utf8');
const steps = text.slice(text.indexOf('steps:'));

test('a triqual-v tag triggers it', () => {
  assert.match(text, /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ['"]triqual-v\*['"]/);
  assert.doesNotMatch(text, /pull_request|branches:/);
});

test('it holds only the OIDC and read permissions and runs only in the public repository', () => {
  assert.match(text, /id-token: write/);
  assert.match(text, /contents: read/);
  assert.match(text, /if: github\.repository == 'Montinou\/triqual'/);
});

test('Node 24, full history, no npm token, secret or cache', () => {
  assert.match(text, /node-version: 24/);
  assert.match(text, /fetch-depth: 0/);
  for (const banned of ['NODE_AUTH_TOKEN', 'secrets.', '_authToken', 'cache:']) assert.ok(!text.includes(banned), banned);
});

test('the steps run in order: ancestor guard, tag check, npm check, tests, pack check, publish', () => {
  assert.ok(steps.length > 0, 'a steps: block');
  const markers = [
    'merge-base --is-ancestor',
    'triqual-v',
    'npm install -g npm@11',
    'node --test packages/triqual/test/',
    'pack.test.mjs',
    'npm publish --access public',
  ];
  let at = -1;
  for (const marker of markers) {
    const found = steps.indexOf(marker, at + 1);
    assert.ok(found > at, `${marker} after the previous step`);
    at = found;
  }
  assert.match(steps, /working-directory: packages\/triqual/);
});
