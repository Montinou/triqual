import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCases, casesOf, problems, ROLE_NAMES } from './lib/case-files.mjs';

test('every role has one or two cases', () => {
  for (const role of ROLE_NAMES) {
    const n = casesOf(role).length;
    assert.ok(n >= 1 && n <= 2, `${role} has ${n} cases, want 1 or 2`);
  }
  const tdd = casesOf('tdd-implementer').map((c) => c.name);
  assert.ok(tdd.includes('tdd-implementer-red-then-green'), `tdd-implementer cases: ${tdd}`);
  for (const name of tdd) {
    assert.ok(
      ['tdd-implementer-red-then-green', 'tdd-implementer-escalates-oversize'].includes(name),
      `unexpected tdd-implementer case ${name}`,
    );
  }
});

test('at least nineteen cases and unique names', () => {
  const names = readCases().map((c) => c.name);
  assert.ok(names.length >= 19, `${names.length} cases`);
  assert.equal(new Set(names).size, names.length);
});

test('every case in the directory is valid', () => {
  for (const c of readCases()) assert.deepEqual(problems(c), [], c.name);
});

test('every case belongs to a role', () => {
  for (const c of readCases()) {
    assert.ok(ROLE_NAMES.some((role) => c.name.startsWith(`${role}-`)), `${c.name} belongs to no role`);
  }
});
