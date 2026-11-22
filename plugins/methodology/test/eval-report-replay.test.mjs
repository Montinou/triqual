import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRows } from '../cli/lib/eval-report.mjs';

const range = (n) => Array.from({ length: n }, (_, i) => i);
const experiment = {
  id: 'x', kind: 'role', status: 'active', control: 'sonnet-high', margin: 0.1,
  arms: { 'sonnet-high': { model: 'sonnet', effort: 'high' }, 'haiku-high': { model: 'haiku', effort: 'high' } },
};
const run = (arm, kase, outcome, usd, runNo = 1) => ({
  v: 1, at: '2026-11-22T00:00:00Z', experiment: 'x', arm, role: 'tdd-implementer', case: kase, run: runNo,
  model: 'm', effort: 'high', account: 'a', outcome, usd, seconds: 1,
});

test('identical arms: d 0, no discordant cases', () => {
  const results = range(30).flatMap((i) => [run('sonnet-high', `c${i}`, 'pass', 1), run('haiku-high', `c${i}`, 'pass', 1)]);
  const [ctl, arm] = replayRows({ experiment, results });
  assert.equal(ctl.control, true);
  assert.equal(arm.paired, 30);
  assert.equal(arm.d, 0);
  assert.deepEqual(arm.discordant, { armOnly: 0, controlOnly: 0 });
  assert.equal(arm.required, null);
});

test('a case recorded in one arm only is left out of d and c', () => {
  const results = [run('sonnet-high', 'a', 'pass', 2), run('haiku-high', 'a', 'tests-failed', 1), run('sonnet-high', 'b', 'pass', 2)];
  const arm = replayRows({ experiment, results })[1];
  assert.equal(arm.paired, 1);
  assert.equal(arm.d, -1);
  assert.equal(arm.c, -1);
  assert.deepEqual(arm.discordant, { armOnly: 0, controlOnly: 1 });
});

test('a tie of runs fails the case', () => {
  const results = [run('haiku-high', 'a', 'pass', 1, 1), run('haiku-high', 'a', 'tests-failed', 1, 2)];
  const arm = replayRows({ experiment, results })[1];
  assert.equal(arm.n, 1);
  assert.equal(arm.rate, 0);
});

test('setup-failed and agent-error runs are not counted, so they can flip a case', () => {
  // Counted, each case is one pass of one run: passes. Counting the excluded runs would be one pass of three: fails.
  const results = [
    run('haiku-high', 'a', 'pass', 1, 1), run('haiku-high', 'a', 'agent-error', 1, 2), run('haiku-high', 'a', 'agent-error', 1, 3),
    run('haiku-high', 'b', 'pass', 1, 1), run('haiku-high', 'b', 'setup-failed', 1, 2), run('haiku-high', 'b', 'setup-failed', 1, 3),
  ];
  const arm = replayRows({ experiment, results })[1];
  assert.equal(arm.n, 2);
  assert.equal(arm.rate, 1);
});

test('only setup-failed and agent-error runs of the experiment give []', () => {
  const results = [run('haiku-high', 'a', 'setup-failed', 1), run('sonnet-high', 'a', 'agent-error', 1)];
  assert.deepEqual(replayRows({ experiment, results }), []);
});

test('below 30 paired cases the verdict is insufficient data', () => {
  const results = range(29).flatMap((i) => [run('sonnet-high', `c${i}`, 'pass', 2), run('haiku-high', `c${i}`, 'pass', 1)]);
  assert.equal(replayRows({ experiment, results })[1].verdict, 'insufficient data');
});

test('30 paired equal-pass cases, cheaper arm: propose', () => {
  const results = range(30).flatMap((i) => [run('sonnet-high', `c${i}`, 'pass', 2), run('haiku-high', `c${i}`, 'pass', 1)]);
  assert.equal(replayRows({ experiment, results })[1].verdict, 'propose');
});

test('pass rate per repoName from repoOf', () => {
  const results = [run('haiku-high', 'a', 'pass', 1), run('haiku-high', 'b', 'tests-failed', 1)];
  const arm = replayRows({ experiment, results, repoOf: new Map([['a', 'app'], ['b', 'app']]) })[1];
  assert.deepEqual(arm.perRepo, { app: { n: 2, rate: 0.5 } });
});

test('other experiments, unknown arms and v 2 rows are ignored; no counted run gives []', () => {
  const results = [{ ...run('haiku-high', 'a', 'pass', 1), experiment: 'y' }, run('opus-max', 'a', 'pass', 1), { ...run('haiku-high', 'a', 'pass', 1), v: 2 }];
  assert.deepEqual(replayRows({ experiment, results }), []);
});

test('row shape: control row nulls from paired on, a case missing from repoOf groups under unknown, usd per case and per run', () => {
  const results = [run('sonnet-high', 'a', 'pass', 2, 1), run('sonnet-high', 'a', 'pass', 4, 2), run('haiku-high', 'a', 'pass', null)];
  const [ctl, arm] = replayRows({ experiment, results });
  assert.deepEqual([ctl.experiment, ctl.kind, ctl.arm, ctl.n, ctl.rate, ctl.usdMedian], ['x', 'replay', 'sonnet-high', 1, 1, 3]);
  assert.deepEqual(ctl.perRepo, { unknown: { n: 1, rate: 1 } });
  for (const k of ['paired', 'discordant', 'd', 'dCI', 'c', 'cCI', 'required', 'verdict']) assert.equal(ctl[k], null);
  assert.equal(arm.paired, 1);
  assert.equal(arm.d, 0);
  assert.equal(arm.usdMedian, null);
  assert.equal(arm.c, null);
  assert.equal(arm.cCI, null);
});

test('a timeout counts as a fail, while setup-failed and agent-error are left out', () => {
  const results = [
    run('sonnet-high', 'a', 'pass', 1), run('haiku-high', 'a', 'timeout', null),
    run('sonnet-high', 'b', 'pass', 1), run('haiku-high', 'b', 'agent-error', 1),
    run('sonnet-high', 'c', 'pass', 1), run('haiku-high', 'c', 'setup-failed', null),
  ];
  const arm = replayRows({ experiment, results })[1];
  assert.equal(arm.paired, 1);
  assert.equal(arm.d, -1);
  assert.deepEqual(arm.discordant, { armOnly: 0, controlOnly: 1 });
});
