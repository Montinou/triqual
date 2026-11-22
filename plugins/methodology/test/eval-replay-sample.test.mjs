import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateUsd, familyPrice, loadCases, sampleCases } from '../cli/lib/eval-replay-sample.mjs';

const mk = (repoName, n) => Array.from({ length: n }, (_, i) => ({
  id: `${repoName}-${String(i).padStart(3, '0')}`,
  repoName,
}));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9);

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'replay-sample-'));
  const write = (id, doc) => {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'case.json'), typeof doc === 'string' ? doc : `${JSON.stringify(doc)}\n`);
  };
  const keep = (id) => write(id, {
    v: 1, id, validated: true, role: 'tdd-implementer', roleVersion: 'v1',
  });
  keep('c');
  keep('a');
  keep('b');
  write('skip-v', { v: 2, id: 'skip-v', validated: true, role: 'tdd-implementer', roleVersion: 'v1' });
  write('skip-val', { v: 1, id: 'skip-val', validated: false, role: 'tdd-implementer', roleVersion: 'v1' });
  write('skip-role', { v: 1, id: 'skip-role', validated: true, role: 'review-fixer', roleVersion: 'v1' });
  write('skip-ver', { v: 1, id: 'skip-ver', validated: true, role: 'tdd-implementer', roleVersion: 'v2' });
  write('bad-json', '{');
  writeFileSync(join(dir, 'loose.json'), '{}\n');
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

test('loadCases keeps validated cases of the role version', () => {
  assert.deepEqual(loadCases(dir, { role: 'tdd-implementer', roleVersion: 'v1' }).map((c) => c.id), ['a', 'b', 'c']);
});
test('sampleCases is stratified by repoName and seeded', () => {
  const cases = [...mk('app', 60), ...mk('lib', 20)];
  const s = sampleCases(cases, { n: 40, seed: 1 });
  assert.equal(s.length, 40);
  assert.equal(s.filter((c) => c.repoName === 'app').length, 30);
  assert.deepEqual(s, sampleCases(cases, { n: 40, seed: 1 }));
  assert.notDeepEqual(s.map((c) => c.id), sampleCases(cases, { n: 40, seed: 2 }).map((c) => c.id));
});
test('estimateUsd scales by the arm price ratio', () => {
  const prices = { 'claude-sonnet-5-5': { input: 3 }, 'claude-haiku-5-5': { input: 1 } };
  assert.equal(familyPrice('haiku', prices), 1);
  near(estimateUsd([{ originalUsd: 3 }, { originalUsd: 3 }], { armModel: 'haiku', controlModel: 'sonnet', runs: 1, prices }), 2);
});
