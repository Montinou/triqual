import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { main } from '../bin/memory.mjs';
import { loadConfig } from '../lib/config.mjs';
import { withTempHome } from './helpers.mjs';

// Runs main with captured streams.
async function run(env, argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}
const lines = (s) => s.split('\n').filter(Boolean);

test('allow adds names, prints the list, stores each once', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['allow', 'Acme Tools', 'a/b', 'é|x']);
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.out), ['Acme Tools', 'a/b', 'é|x']);
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['Acme Tools', 'a/b', 'é|x']);
  const again = await run(env, ['allow', 'a/b', 'Acme Tools', 'é|x']);
  assert.equal(again.code, 0);
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['Acme Tools', 'a/b', 'é|x']);
}));

test('deny removes names and reports the missing ones with exit 0', () => withTempHome(async ({ env, paths }) => {
  await run(env, ['allow', 'a/b', 'keep']);
  const r = await run(env, ['deny', 'a/b', 'missing']);
  assert.equal(r.code, 0);
  assert.match(r.out, /missing/);
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['keep']);
}));

test('allow --list prints one name per line', () => withTempHome(async ({ env }) => {
  await run(env, ['allow', 'p one', 'p two']);
  const r = await run(env, ['allow', '--list']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'p one\np two\n');
  const empty = await withTempHome(({ env: e2 }) => run(e2, ['allow', '--list']));
  assert.equal(empty.code, 0);
  assert.equal(empty.out, '');
}));

test('allow or deny without a name exits 1 with usage on stderr', () => withTempHome(async ({ env, paths }) => {
  for (const argv of [['allow'], ['deny'], ['allow', '  '], ['deny', '']]) {
    const r = await run(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /Usage/);
    assert.equal(r.out, '');
  }
  assert.deepEqual(loadConfig(paths).raw, {});
}));

test('an unknown subcommand or no arguments exits 1 with usage on stderr', () => withTempHome(async ({ env }) => {
  for (const argv of [['nope'], [], ['allow', '--bogus'], ['deny']]) {
    const r = await run(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /Usage/);
  }
}));

test('--help exits 0 and lists allow, deny, status, report but not generate', () => withTempHome(async ({ env }) => {
  for (const flag of ['--help', '-h']) {
    const r = await run(env, [flag]);
    assert.equal(r.code, 0);
    for (const word of ['allow', 'deny', 'status', 'report']) assert.ok(r.out.includes(word), word);
    assert.ok(!r.out.includes('generate'));
  }
}));

test('an unparsable config makes allow and deny exit 1 naming the file, bytes unchanged', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, '{ broken');
  for (const argv of [['allow', 'x'], ['deny', 'x']]) {
    const r = await run(env, argv);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(paths.configFile), r.err);
    assert.equal(readFileSync(paths.configFile, 'utf8'), '{ broken');
  }
}));

test('allow keeps an invalid-but-raw clientTerms: [] in the saved file', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ clientTerms: [], other: 7 }));
  const r = await run(env, ['allow', 'x']);
  assert.equal(r.code, 0);
  const saved = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  assert.deepEqual(saved.clientTerms, []);
  assert.equal(saved.other, 7);
  assert.deepEqual(saved.allowlist, ['x']);
}));
