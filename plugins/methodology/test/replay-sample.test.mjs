import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTasks, normalizeExport } from '../skills/auditing-performance/scripts/lib/replay-sample.mjs';

const row = (repo, tier, i) => ({ repo, root: `/r/${repo}`, plan: `p-${repo}.md`, task: `T${i}`, tier, sha: `${repo}-${tier}-${i}`.padEnd(40, '0') });

const pool = () => {
  const rows = [];
  for (const repo of ['alpha', 'beta']) for (const tier of ['light', 'standard', 'heavy']) for (let i = 1; i <= 5; i++) rows.push(row(repo, tier, i));
  return rows;
};

test('excludes client repos case-insensitively', () => {
  const rows = [...pool(), ...['light', 'standard', 'heavy'].flatMap((t) => [1, 2, 3, 4].map((i) => row('Attorney-Client-QA', t, i)))];
  const got = sampleTasks(rows, { n: rows.length });
  assert.ok(got.length > 0);
  assert.ok(got.every((r) => r.repo !== 'Attorney-Client-QA'));
});

const withClient = () => [...pool(), ...['light', 'standard', 'heavy'].flatMap((t) => [1, 2, 3].map((i) => row('Attorney-Client-QA', t, i)))];

test('a custom exclude is additive: it never lifts the client exclusion', () => {
  const rows = withClient();
  const got = sampleTasks(rows, { n: rows.length, exclude: /^alpha$/i });
  assert.ok(got.length > 0);
  assert.ok(got.every((r) => r.repo !== 'alpha'), 'the custom pattern applies');
  assert.ok(got.every((r) => r.repo !== 'Attorney-Client-QA'), 'the client pattern still applies');
  assert.ok(got.some((r) => r.repo === 'beta'));
});

test('a case-sensitive or global RegExp cannot bypass the filter', () => {
  const rows = withClient();
  for (const exclude of [/^alpha$/, /^attorney/, /^alpha$/g, /^attorney/y, /^beta$/gi]) {
    const got = sampleTasks(rows, { n: rows.length, exclude });
    assert.ok(got.every((r) => r.repo !== 'Attorney-Client-QA'), String(exclude));
    if (exclude.source === '^alpha$') assert.ok(got.every((r) => r.repo !== 'alpha'), String(exclude));
    if (exclude.source === '^beta$') assert.ok(got.every((r) => r.repo !== 'beta'), String(exclude));
  }
});

test('stratifies by tier', () => {
  const got = sampleTasks(pool(), { n: 6 });
  assert.equal(got.length, 6);
  for (const tier of ['light', 'standard', 'heavy']) assert.equal(got.filter((r) => r.tier === tier).length, 2, tier);
});

test('spreads a tier across repos', () => {
  const got = sampleTasks(pool(), { n: 6 });
  for (const tier of ['light', 'standard', 'heavy']) assert.deepEqual(new Set(got.filter((r) => r.tier === tier).map((r) => r.repo)), new Set(['alpha', 'beta']), tier);
});

test('is deterministic for a seed', () => {
  const a = sampleTasks(pool(), { n: 8, seed: 7 });
  const b = sampleTasks(pool(), { n: 8, seed: 7 });
  const c = sampleTasks(pool(), { n: 8, seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('skips commits that do not resolve', () => {
  const bad = new Set(pool().filter((r) => r.task === 'T1' || r.task === 'T2').map((r) => r.sha));
  const calls = [];
  const resolves = (root, sha) => { calls.push([root, sha]); return !bad.has(sha); };
  const got = sampleTasks(pool(), { n: 10, resolves });
  assert.equal(got.length, 10);
  assert.ok(got.every((r) => !bad.has(r.sha)));
  assert.ok(calls.some(([root, sha]) => root.startsWith('/r/') && sha.length === 40));
});

test('returns fewer rows than n when the pool runs out', () => {
  assert.equal(sampleTasks(pool().slice(0, 3), { n: 20 }).length, 3);
  assert.deepEqual(sampleTasks([], { n: 5 }), []);
});

const snapshot = (name, plans) => ({ schema: 'claude-methodology/tracking-snapshot@1', repo: { name, root: `/r/${name}` }, plans });
const task = (id, over = {}) => ({ id, title: 't', status: 'done', tier: 'standard', effectiveTier: 'heavy', commits: ['a'.repeat(40), 'b'.repeat(40)], ...over });

test('normalizeExport flattens the snapshot array into rows of finished tasks with a commit', () => {
  const json = [
    snapshot('alpha', [{ name: 'p1.md', tasks: [task('T1'), task('T2', { status: 'pending' }), task('T3', { commits: [] }), task('T4', { tier: null, effectiveTier: null })] }]),
    snapshot('beta', [{ name: 'p2.md', tasks: [task('T1', { tier: null })] }]),
  ];
  assert.deepEqual(normalizeExport(json), [
    { repo: 'alpha', root: '/r/alpha', plan: 'p1.md', task: 'T1', tier: 'standard', sha: 'a'.repeat(40) },
    { repo: 'alpha', root: '/r/alpha', plan: 'p1.md', task: 'T4', tier: 'unknown', sha: 'a'.repeat(40) },
    { repo: 'beta', root: '/r/beta', plan: 'p2.md', task: 'T1', tier: 'heavy', sha: 'a'.repeat(40) },
  ]);
});

test('normalizeExport accepts one snapshot object and ignores malformed entries', () => {
  assert.equal(normalizeExport(snapshot('alpha', [{ name: 'p.md', tasks: [task('T1')] }])).length, 1);
  assert.deepEqual(normalizeExport(null), []);
  assert.deepEqual(normalizeExport([{}, { repo: { name: 'x' }, plans: [{ name: 'p', tasks: 'nope' }] }]), []);
});
