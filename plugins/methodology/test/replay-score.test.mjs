import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarize, judgeRecall } from '../skills/auditing-performance/scripts/lib/replay-score.mjs';

const row = (task, setting, findings, verdicts, usd = 0, seconds = 0) => ({
  task, setting, findings: findings.map((id) => ({ id })), verdicts, usd, seconds,
});
const v = (id, group, verdict) => ({ id, group, verdict });
const by = (summary, setting) => summary.find((s) => s.setting === setting);

test('recall is against the pooled confirmed groups', () => {
  // Pool for t1 = { g1, g2 }: g1 found by both settings, g2 only by "lean".
  const results = [
    row('t1', 'full', ['a'], [v('a', 'g1', 'confirmed')], 1.5, 30),
    row('t1', 'lean', ['b', 'c'], [v('b', 'g1', 'confirmed'), v('c', 'g2', 'confirmed')], 0.5, 10),
  ];
  const s = summarize(results);
  assert.equal(by(s, 'full').found, 1);
  assert.equal(by(s, 'full').recall, 0.5);
  assert.equal(by(s, 'lean').found, 2);
  assert.equal(by(s, 'lean').recall, 1);
  assert.equal(by(s, 'full').usd, 1.5);
  assert.equal(by(s, 'lean').seconds, 10);
});

test('precision counts refuted findings', () => {
  const results = [
    row('t1', 'full', ['a', 'b', 'c', 'd'], [
      v('a', 'g1', 'confirmed'), v('b', 'g1', 'confirmed'), v('c', 'g2', 'refuted'), v('d', 'g3', 'refuted'),
    ]),
  ];
  const [s] = summarize(results);
  // Two findings share group g1: found counts distinct groups, precision counts findings.
  assert.equal(s.found, 1);
  assert.equal(s.precision, 0.5);
});

test('a null verdict list is failed, not zero recall', () => {
  const results = [
    row('t1', 'full', ['a'], [v('a', 'g1', 'confirmed')]),
    row('t2', 'full', ['x', 'y'], null),
    row('t1', 'lean', ['b'], [v('b', 'g1', 'confirmed')]),
    row('t2', 'lean', ['z'], [v('z', 'g9', 'confirmed')]),
  ];
  const s = summarize(results);
  assert.equal(by(s, 'full').tasks, 2);
  assert.equal(by(s, 'full').failed, 1);
  assert.equal(by(s, 'lean').failed, 0);
  // full: t2 is excluded, so recall is t1 only (1 of pool {g1}); a zero for t2 would give 0.5.
  assert.equal(by(s, 'full').recall, 1);
  // full: its two t2 findings do not enter precision either (1 of 1, not 1 of 3).
  assert.equal(by(s, 'full').precision, 1);
  // lean: pool is t1 {g1} + t2 {g9}; the failed full run adds nothing to it.
  assert.equal(by(s, 'lean').recall, 1);
});

test('a setting whose every task failed has null recall and precision, not zero', () => {
  const [s] = summarize([row('t1', 'full', ['a'], null), row('t2', 'full', [], undefined)]);
  assert.equal(s.tasks, 2);
  assert.equal(s.failed, 2);
  assert.equal(s.found, 0);
  assert.equal(s.recall, null);
  assert.equal(s.precision, null);
});

test('unparsable verdicts of a non-array shape are failed too', () => {
  const [s] = summarize([row('t1', 'full', ['a'], 'not json')]);
  assert.equal(s.failed, 1);
  assert.equal(s.recall, null);
});

test('a confirmed verdict without a non-empty string group makes the run failed', () => {
  for (const bad of [undefined, null, '', 7]) {
    const [s] = summarize([row('t1', 'full', ['a', 'b'], [v('a', bad, 'confirmed'), v('b', 'g1', 'confirmed')])]);
    assert.equal(s.failed, 1, `group ${String(bad)}`);
    assert.equal(s.recall, null);
    assert.equal(s.precision, null);
  }
  // A refuted verdict needs no group, and a verdict for an unknown id is ignored before the check.
  const [ok] = summarize([row('t1', 'full', ['a', 'b'], [{ id: 'a', verdict: 'refuted' }, { id: 'ghost', verdict: 'confirmed' }, v('b', 'g1', 'confirmed')])]);
  assert.equal(ok.failed, 0);
  assert.equal(ok.found, 1);
});

test('an empty pool gives recall 0, never NaN', () => {
  const [s] = summarize([row('t1', 'full', ['a'], [v('a', 'g1', 'refuted')])]);
  assert.equal(s.recall, 0);
  assert.equal(s.precision, 0);
  assert.ok(!Number.isNaN(s.recall));
});

test('a setting with zero findings has precision 0, not NaN', () => {
  const results = [
    row('t1', 'quiet', [], []),
    row('t1', 'loud', ['a'], [v('a', 'g1', 'confirmed')]),
  ];
  const s = summarize(results);
  assert.equal(by(s, 'quiet').precision, 0);
  assert.equal(by(s, 'quiet').recall, 0);
  assert.equal(by(s, 'quiet').failed, 0);
  assert.equal(by(s, 'loud').recall, 1);
});

test('findings without a verdict are not confirmed, and verdicts for unknown ids are ignored', () => {
  const [s] = summarize([
    row('t1', 'full', ['a', 'b'], [v('a', 'g1', 'confirmed'), v('ghost', 'g2', 'confirmed')]),
  ]);
  assert.equal(s.found, 1);
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 1);
});

test('summary rows hold only counts and rates, in first-seen setting order', () => {
  const s = summarize([row('t1', 'b', [], []), row('t1', 'a', [], [])]);
  assert.deepEqual(s.map((x) => x.setting), ['b', 'a']);
  assert.deepEqual(Object.keys(s[0]), ['setting', 'tasks', 'failed', 'found', 'recall', 'precision', 'usd', 'seconds']);
});

test('summarize rejects input that is not a list of runs', () => {
  assert.throws(() => summarize({}), /array/);
  assert.throws(() => summarize([null]), /run/);
  assert.throws(() => summarize([{ task: 't1' }]), /run/);
});

test('judgeRecall counts planted defects', () => {
  const seeded = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
  const verdicts = [
    v('p1', 'g1', 'confirmed'), v('p2', 'g2', 'refuted'), v('p3', 'g3', 'confirmed'),
  ];
  assert.equal(judgeRecall(seeded, verdicts), 0.5);
});

test('judgeRecall edge cases: empty planted list, unparsable verdicts, duplicates, plain ids', () => {
  assert.equal(judgeRecall([], [v('a', 'g', 'confirmed')]), 0);
  assert.equal(judgeRecall([{ id: 'p1' }], null), null);
  assert.equal(judgeRecall(['p1', 'p1', 'p2'], [v('p1', 'g', 'confirmed'), v('p1', 'h', 'confirmed')]), 0.5);
  assert.equal(judgeRecall([{ id: 'p1' }], []), 0);
});

// ---- CLI: `replay.mjs score --results <file>` ----
const SCRIPT = new URL('../skills/auditing-performance/scripts/replay.mjs', import.meta.url).pathname;
const runScore = (...args) => spawnSync(process.execPath, [SCRIPT, 'score', ...args], { encoding: 'utf8' });
const scratchDir = () => mkdtempSync(join(tmpdir(), 'replay-score-'));

test('score prints the summary as JSON and writes replay_summary.json beside its input', () => {
  const dir = scratchDir();
  try {
    const input = join(dir, 'results.json');
    writeFileSync(input, JSON.stringify([
      row('t1', 'full', ['a'], [v('a', 'g1', 'confirmed')], 1, 2),
      row('t1', 'lean', ['b'], null, 3, 4),
    ]));
    const res = runScore('--results', input);
    assert.equal(res.status, 0, res.stderr);
    const printed = JSON.parse(res.stdout);
    const written = JSON.parse(readFileSync(join(dir, 'replay_summary.json'), 'utf8'));
    assert.deepEqual(written, printed);
    assert.equal(printed.length, 2);
    assert.equal(printed[0].setting, 'full');
    assert.equal(printed[0].recall, 1);
    assert.equal(printed[1].failed, 1);
    assert.equal(printed[1].recall, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('score output carries no finding or verdict text', () => {
  const dir = scratchDir();
  try {
    const input = join(dir, 'results.json');
    writeFileSync(input, JSON.stringify([
      { task: 't1', setting: 'full', findings: [{ id: 'a', text: 'SECRET-DIFF-LINE' }], verdicts: [{ id: 'a', group: 'g1', verdict: 'confirmed', note: 'SECRET-DIFF-LINE' }], usd: 0, seconds: 0 },
    ]));
    const res = runScore('--results', input);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes('SECRET-DIFF-LINE'));
    assert.ok(!readFileSync(join(dir, 'replay_summary.json'), 'utf8').includes('SECRET-DIFF-LINE'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('score exits 2 without --results and 1 on unreadable, non-JSON or malformed input', () => {
  assert.equal(runScore().status, 2);
  const dir = scratchDir();
  try {
    assert.equal(runScore('--results', join(dir, 'missing.json')).status, 1);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'not json SECRET-TEXT');
    const res = runScore('--results', bad);
    assert.equal(res.status, 1);
    assert.ok(!res.stderr.includes('SECRET-TEXT'));
    writeFileSync(bad, '{"not":"an array"}');
    assert.equal(runScore('--results', bad).status, 1);
    writeFileSync(bad, '[{"task":"t1"}]');
    assert.equal(runScore('--results', bad).status, 1);
    assert.ok(!existsSync(join(dir, 'replay_summary.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
