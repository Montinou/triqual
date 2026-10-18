// `triqual setup` (plan npm-packages T2): argument check, prerequisites, legacy guard, marketplace, plugin install and
// the installed bootstrap. A stub `claude` on a temp PATH records every call but `--version`; fake version directories
// hold a stub setup/bootstrap.mjs that records its argv. Nothing touches the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../lib/setup.mjs';

const GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const STUB_CLAUDE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0 (stub)'); process.exit(0); }
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
const n = fs.readFileSync(process.env.STUB_LOG, 'utf8').trim().split('\\n').length;
if (process.env['STUB_FAIL_' + n]) process.exit(Number(process.env['STUB_FAIL_' + n]));
if (args.join(' ') === 'plugin marketplace list --json') { process.stdout.write(process.env.STUB_MARKETS ?? '[]'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'install' && process.env.STUB_INSTALL_DIR) {
  const file = path.join(process.env.HOME, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 2, plugins: { 'methodology@triqual': [{ scope: 'user', installPath: process.env.STUB_INSTALL_DIR }] } }));
}
process.exit(0);
`;

// A fake plugin version directory whose bootstrap appends { dir, argv } to $BOOT_LOG and exits $BOOT_EXIT.
function fakePlugin(dir) {
  mkdirSync(join(dir, 'setup'), { recursive: true });
  writeFileSync(join(dir, 'setup', 'bootstrap.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.BOOT_LOG, JSON.stringify({ dir: ${JSON.stringify(dir)}, argv: process.argv.slice(2) }) + '\\n');
process.exit(Number(process.env.BOOT_EXIT ?? 0));
`);
  return dir;
}

async function withMachine(fn, { homeName = 'home', claude = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'triqual-setup-'));
  const home = join(root, homeName);
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  const tools = join(root, 'tools');
  mkdirSync(tools);
  symlinkSync(GIT, join(tools, 'git'));
  if (claude) {
    writeFileSync(join(tools, 'claude'), STUB_CLAUDE);
    chmodSync(join(tools, 'claude'), 0o755);
  }
  const log = join(root, 'claude.log');
  const bootLog = join(root, 'boot.log');
  const env = { HOME: home, PATH: tools, STUB_LOG: log, BOOT_LOG: bootLog };
  const out = [];
  const err = [];
  const io = { env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).join(' ')) : []);
  const boots = () => (existsSync(bootLog) ? readFileSync(bootLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cache = join(home, '.claude', 'plugins', 'cache', 'triqual', 'methodology');
  const installed = (dir) => writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'methodology@triqual': [{ scope: 'user', installPath: dir }] } }));
  try {
    return await fn({ root, home, env, io, out, err, calls, boots, cache, installed });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LIST = 'plugin marketplace list --json';
const ADD = 'plugin marketplace add Montinou/triqual --scope user';
const INSTALL = 'plugin install methodology@triqual --scope user';

test('fresh machine', () => withMachine(async ({ env, io, calls, boots, cache }) => {
  const dir = fakePlugin(join(cache, '0.7.4'));
  Object.assign(env, { STUB_MARKETS: '[]', STUB_INSTALL_DIR: dir, BOOT_EXIT: '4' });
  assert.equal(await runSetup(['--yes', '--no-harness'], io), 4);
  assert.deepEqual(calls(), [LIST, ADD, INSTALL]);
  assert.deepEqual(boots(), [{ dir, argv: ['--yes', '--no-harness'] }]);
}));

test('installed machine', () => withMachine(async ({ env, io, calls, boots, cache, installed }) => {
  const dir = fakePlugin(join(cache, '0.7.3'));
  fakePlugin(join(cache, '0.9.0'));
  installed(dir);
  env.STUB_MARKETS = JSON.stringify([{ name: 'triqual', source: 'github', repo: 'Montinou/triqual', installLocation: '/x' }]);
  assert.equal(await runSetup([], io), 0);
  assert.deepEqual(calls(), [LIST, 'plugin marketplace update triqual']);
  assert.deepEqual(boots(), [{ dir, argv: [] }]);
}));

test('fallback to the cache', () => withMachine(async ({ env, io, boots, cache }) => {
  fakePlugin(join(cache, '0.9.1'));
  const newest = fakePlugin(join(cache, '0.10.0'));
  env.STUB_MARKETS = '[]';
  assert.equal(await runSetup([], io), 0);
  assert.deepEqual(boots(), [{ dir: newest, argv: [] }]);
}));

test('legacy marketplace', () => withMachine(async ({ env, io, err, calls, boots }) => {
  env.STUB_MARKETS = JSON.stringify([{ name: 'claude-methodology' }]);
  assert.equal(await runSetup([], io), 1);
  assert.match(err.join(''), /node bin\/bootstrap\.mjs/);
  assert.match(err.join(''), /Montinou\/triqual/);
  assert.deepEqual(calls(), [LIST]);
  assert.deepEqual(boots(), []);
}));

test('arguments checked first', () => withMachine(async ({ io, out, err, calls }) => {
  assert.equal(await runSetup(['--help'], io), 0);
  assert.match(out.join(''), /setup \[--yes\] \[--keep-language\] \[--no-harness\]/);
  assert.equal(await runSetup(['--nope'], io), 2);
  assert.match(err.join(''), /--nope/);
  assert.deepEqual(calls(), []);
}));

test('missing claude', () => withMachine(async ({ io, err, calls }) => {
  assert.equal(await runSetup([], io), 1);
  assert.match(err.join(''), /claude/);
  assert.deepEqual(calls(), []);
}, { claude: false }));

test('failing claude command', () => withMachine(async ({ env, io, err, calls }) => {
  Object.assign(env, { STUB_MARKETS: '[]', STUB_FAIL_2: '7' });
  assert.equal(await runSetup([], io), 7);
  assert.match(err.join(''), /claude plugin marketplace add Montinou\/triqual --scope user/);
  assert.deepEqual(calls(), [LIST, ADD]);
}));

test('list output not JSON', () => withMachine(async ({ env, io, err, calls }) => {
  env.STUB_MARKETS = 'oops';
  assert.equal(await runSetup([], io), 1);
  assert.match(err.join(''), /claude plugin marketplace list --json/);
  assert.deepEqual(calls(), [LIST]);
}));

test('HOME with a space', () => withMachine(async ({ env, io, calls, boots, cache }) => {
  const dir = fakePlugin(join(cache, '0.7.4'));
  Object.assign(env, { STUB_MARKETS: '[]', STUB_INSTALL_DIR: dir });
  assert.equal(await runSetup(['--yes'], io), 0);
  assert.deepEqual(calls(), [LIST, ADD, INSTALL]);
  assert.deepEqual(boots(), [{ dir, argv: ['--yes'] }]);
}, { homeName: 'my home' }));
