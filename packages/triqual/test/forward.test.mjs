// The triqual npm package: --version, help and forwarding to the installed shim (plan npm-packages T1). Every test
// uses a temp HOME holding a stub shim at <HOME>/.local/bin/triqual.mjs; nothing touches the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, USAGE } from '../bin/triqual.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG, 'bin', 'triqual.mjs');
const VERSION = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

// A stub shim that writes its argv to $STUB_ARGV and exits with $STUB_EXIT (0 by default), or kills itself with
// $STUB_SIGNAL.
const STUB = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.STUB_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.STUB_SIGNAL) process.kill(process.pid, process.env.STUB_SIGNAL);
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

async function withHome(fn, { shim = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'triqual-pkg-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  if (shim) writeFileSync(join(home, '.local', 'bin', 'triqual.mjs'), STUB);
  const argvFile = join(dir, 'argv.json');
  const env = { ...process.env, HOME: home, STUB_ARGV: argvFile };
  delete env.STUB_EXIT;
  delete env.STUB_SIGNAL;
  const out = [];
  const err = [];
  const io = { env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  const seen = () => JSON.parse(readFileSync(argvFile, 'utf8'));
  try {
    return await fn({ dir, home, env, io, out, err, seen, argvFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ran = (argvFile) => { try { readFileSync(argvFile); return true; } catch { return false; } };

test('version flag prints the package version', () => withHome(async ({ io, out, argvFile }) => {
  for (const flag of ['--version', '-v']) {
    out.length = 0;
    assert.deepEqual(await main([flag], io), { code: 0, signal: null });
    assert.equal(out.join(''), `${VERSION}\n`);
  }
  assert.equal(ran(argvFile), false, 'the shim never runs');
}));

test('a later --version is forwarded', () => withHome(async ({ io, seen }) => {
  assert.deepEqual(await main(['tasks', '--version'], io), { code: 0, signal: null });
  assert.deepEqual(seen(), ['tasks', '--version']);
}));

test('other commands are forwarded with their exit code', () => withHome(async ({ io, env, seen }) => {
  env.STUB_EXIT = '5';
  assert.deepEqual(await main(['doctor', '--repo'], io), { code: 5, signal: null });
  assert.deepEqual(seen(), ['doctor', '--repo']);
}));

test('help is forwarded then the setup line', () => withHome(async ({ io, out, seen }) => {
  for (const argv of [['--help'], [], ['help'], ['-h']]) {
    out.length = 0;
    assert.deepEqual(await main(argv, io), { code: 0, signal: null });
    assert.deepEqual(seen(), argv);
    assert.equal(out.join(''), 'npx triqual setup reruns the setup\n');
  }
}));

test('without the shim', () => withHome(async ({ io, out, err }) => {
  assert.deepEqual(await main(['tasks', 'line'], io), { code: 3, signal: null });
  assert.equal(err.join(''), 'triqual is not set up on this machine: run npx triqual setup\n');
  assert.deepEqual(await main(['--help'], io), { code: 0, signal: null });
  assert.equal(out.join(''), USAGE);
}, { shim: false }));

test('setup is routed to the installer, not forwarded', () => withHome(async ({ io, out, argvFile }) => {
  assert.deepEqual(await main(['setup', '--help'], io), { code: 0, signal: null });
  assert.match(out.join(''), /usage: triqual setup/);
  assert.equal(ran(argvFile), false, 'the shim never runs');
}));

test('a signal is re-raised', () => withHome(({ env }) => {
  const r = spawnSync(process.execPath, [BIN, 'doctor'], { env: { ...env, STUB_SIGNAL: 'SIGTERM' }, encoding: 'utf8' });
  assert.equal(r.signal, 'SIGTERM');
}));

test('runs through a symlink', () => withHome(({ dir, env }) => {
  mkdirSync(join(dir, 'bin'));
  symlinkSync(BIN, join(dir, 'bin', 'triqual'));
  const r = spawnSync(process.execPath, [join(dir, 'bin', 'triqual'), '--version'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${VERSION}\n`);
}));
