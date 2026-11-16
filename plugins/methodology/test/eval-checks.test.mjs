import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECKS, TranscriptMissing, runCheck } from '../cli/lib/eval-checks.mjs';

const SRC = new URL('../cli/lib/eval-checks.mjs', import.meta.url);

test("runCheck returns the check's verdict", () => {
  const checks = {
    a: (signals) => (signals.n > 1 ? 'pass' : 'fail'),
    b: (_signals, transcriptPath) => (transcriptPath === '/t.jsonl' ? 'pass' : 'fail'),
  };
  assert.equal(runCheck('a', { n: 2 }, '/t.jsonl', checks), 'pass');
  assert.equal(runCheck('a', { n: 0 }, '/t.jsonl', checks), 'fail');
  assert.equal(runCheck('b', {}, '/t.jsonl', checks), 'pass');
});

test('an unknown id throws', () => {
  assert.throws(() => runCheck('nope', {}, '/t.jsonl', {}), /nope/);
  assert.throws(() => runCheck('toString', {}, '/t.jsonl', {}), /toString/);
  assert.deepEqual(Object.keys(CHECKS), []);
});

test('a missing transcript gives undecided', () => {
  const checks = { a: () => { throw new TranscriptMissing('/gone.jsonl'); } };
  assert.equal(runCheck('a', {}, '/gone.jsonl', checks), 'undecided');
});

test('other errors from a check propagate', () => {
  const checks = { a: () => { throw new Error('boom'); } };
  assert.throws(() => runCheck('a', {}, '/t.jsonl', checks), /boom/);
});

test('the module imports only node: built-ins', () => {
  const lines = readFileSync(SRC, 'utf8').split('\n')
    .filter((l) => /^\s*(import\b|export\b[^\n]*\bfrom\b)/.test(l) || /\brequire\(|\bimport\(/.test(l));
  for (const l of lines) assert.match(l, /from\s+['"]node:[a-z/_]+['"]/, `non-builtin import: ${l}`);
});
