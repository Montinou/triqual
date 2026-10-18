import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyPackage } from '../src/cli/provenance.mjs';

// Hermetic: npm is never run. The injected `run` records every call and fakes npm's answers; a
// fake `npm install` writes a minimal package.json into the prefix it was given (a temp dir).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-provenance-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NPM = '/fake/bin/npm';
const SPEC = '@triqual/fence@0.1.0';

const AUDIT_OK = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n';
const AUDIT_NO_ATTESTATION = 'audited 1 package in 0s\n\n1 package has a verified registry signature\n';
const AUDIT_INVALID = 'audited 1 package in 0s\n\n1 package has an invalid registry signature:\n\n@triqual/fence@0.1.0 (https://registry.npmjs.org/)\n';

function fakeRun({ install = 0, audit = { status: 0, stdout: AUDIT_OK }, pkg = { name: '@triqual/fence', version: '0.1.0' } } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd, env: opts.env });
    if (args[0] === 'install') {
      if (install !== 0) return { status: install, stdout: '', stderr: 'npm error 404' };
      const prefix = args[args.indexOf('--prefix') + 1];
      const dir = path.join(prefix, 'node_modules', '@triqual', 'fence');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'audit') return { stderr: '', ...audit };
    return { status: 127, stdout: '', stderr: 'unexpected program' };
  };
  return { run, calls };
}

test('verifyPackage refuses a spec that is not @triqual/fence@<exact>', () => {
  for (const spec of ['@triqual/fence@^0.1.0', '@triqual/fence@latest', '@triqual/fence', 'other@0.1.0', '@triqual/fence@0.1', '@triqual/fence@~0.1.0', '@triqual/fence@0.1.x']) {
    const f = fakeRun();
    const r = verifyPackage(spec, { run: f.run, npmPath: NPM });
    assert.equal(r.ok, false, spec);
    assert.match(r.reason, /exact/, spec);
    assert.deepEqual(f.calls, [], spec);
  }
});

test('verifyPackage installs into a temp prefix and runs npm audit signatures there', () => {
  const f = fakeRun();
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM });
  assert.equal(r.ok, true, r.reason);
  assert.equal(f.calls.length, 2);
  const [install, audit] = f.calls;
  assert.equal(install.cmd, NPM);
  assert.equal(install.args[0], 'install');
  assert.ok(install.args.includes('--ignore-scripts'));
  assert.equal(install.args.at(-1), SPEC);
  const prefix = install.args[install.args.indexOf('--prefix') + 1];
  assert.ok(prefix.startsWith(fs.realpathSync(os.tmpdir())) || prefix.startsWith(os.tmpdir()), prefix);
  assert.equal(audit.cmd, NPM);
  assert.deepEqual(audit.args.slice(0, 2), ['audit', 'signatures']);
  assert.equal(audit.cwd, prefix);
  // its own temp prefix is removed afterwards
  assert.equal(fs.existsSync(prefix), false);
});

test('verifyPackage leaves the package in a prefix the caller supplies', () => {
  const prefix = fs.mkdtempSync(path.join(TMP, 'prefix-'));
  const f = fakeRun();
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM, prefix });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.packageDir, path.join(prefix, 'node_modules', '@triqual', 'fence'));
  assert.ok(fs.existsSync(path.join(r.packageDir, 'package.json')));
});

test('a missing attestation is not ok', () => {
  const f = fakeRun({ audit: { status: 0, stdout: AUDIT_NO_ATTESTATION } });
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM });
  assert.equal(r.ok, false);
  assert.match(r.reason, /attestation/);
});

test('an invalid signature is not ok', () => {
  const f = fakeRun({ audit: { status: 1, stdout: AUDIT_INVALID } });
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM });
  assert.equal(r.ok, false);
  assert.match(r.reason, /npm audit signatures/);
});

test('a failing npm install is not ok and the audit does not run', () => {
  const f = fakeRun({ install: 1 });
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1);
});

test('a package whose name or version differs from the spec is not ok', () => {
  for (const pkg of [{ name: '@triqual/fence', version: '0.1.1' }, { name: 'fence', version: '0.1.0' }]) {
    const f = fakeRun({ pkg });
    const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM });
    assert.equal(r.ok, false, JSON.stringify(pkg));
  }
});

test('npm runs against the public registry with empty npm configs, no scripts and a cleaned environment', () => {
  const f = fakeRun();
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: TMP,
    npm_config_registry: 'https://registry.example.invalid/',
    NPM_CONFIG_USERCONFIG: '/elsewhere/.npmrc',
    npm_config__auth: 'x',
    NODE_OPTIONS: '--require /elsewhere/hook.js',
    NODE_EXTRA_CA_CERTS: '/elsewhere/ca.pem',
  };
  const r = verifyPackage(SPEC, { run: f.run, npmPath: NPM, env });
  assert.equal(r.ok, true, r.reason);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.args.includes('--registry=https://registry.npmjs.org/'), c.args.join(' '));
    assert.ok(c.args.includes('--ignore-scripts'), c.args.join(' '));
    const user = c.args.find((a) => a.startsWith('--userconfig='));
    const global = c.args.find((a) => a.startsWith('--globalconfig='));
    assert.ok(user && global, c.args.join(' '));
    for (const flag of [user, global]) {
      const file = flag.slice(flag.indexOf('=') + 1);
      assert.ok(path.isAbsolute(file) && file.startsWith(fs.realpathSync(os.tmpdir())), file);
    }
    assert.notEqual(user, global);
    // the environment: PATH and HOME kept, every npm config and Node hook variable removed
    assert.equal(c.env.PATH, env.PATH);
    assert.equal(c.env.HOME, env.HOME);
    for (const k of Object.keys(c.env)) {
      assert.ok(!/^npm_config_/i.test(k) && k !== 'NODE_OPTIONS' && k !== 'NODE_EXTRA_CA_CERTS', k);
    }
  }
  // the config files were empty while npm ran, and are gone afterwards
  const user = f.calls[0].args.find((a) => a.startsWith('--userconfig=')).split('=')[1];
  assert.equal(fs.existsSync(user), false);
});

test('the empty npm config files exist and are empty while npm runs', () => {
  const seen = [];
  const f = fakeRun();
  const run = (cmd, args, opts) => {
    for (const a of args) if (/^--(user|global)config=/.test(a)) seen.push(fs.readFileSync(a.split('=')[1], 'utf8'));
    return f.run(cmd, args, opts);
  };
  assert.equal(verifyPackage(SPEC, { run, npmPath: NPM, env: {} }).ok, true);
  assert.deepEqual(seen, ['', '', '', '']);
});

test('a prerelease with a leading-zero numeric identifier is not an exact version', () => {
  for (const v of ['0.1.0-01', '0.1.0-rc.01', '0.1.0-00']) {
    const f = fakeRun();
    assert.equal(verifyPackage(`@triqual/fence@${v}`, { run: f.run, npmPath: NPM }).ok, false, v);
    assert.deepEqual(f.calls, [], v);
  }
  for (const v of ['0.1.0-0', '0.1.0-rc.1', '0.1.0-0a', '0.1.0-rc.0+build.01']) {
    const f = fakeRun({ pkg: { name: '@triqual/fence', version: v } });
    assert.equal(verifyPackage(`@triqual/fence@${v}`, { run: f.run, npmPath: NPM }).ok, true, v);
  }
});

test('run is required', () => {
  assert.throws(() => verifyPackage(SPEC, { npmPath: NPM }), /runner/);
});
