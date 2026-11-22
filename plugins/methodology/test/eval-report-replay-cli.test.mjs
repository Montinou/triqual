// Task 6: `triqual eval report` prints the replay rows of a role experiment (text block and the `replay` JSON key) and the
// review-fixer task-level line, through the real command with injected env and a temp evals directory.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-report.mjs';

const roleExperiment = (id, role) => ({
  id,
  kind: 'role',
  status: 'active',
  start: '2026-11-01',
  control: 'off',
  arms: {
    off: { role, model: 'claude-opus-5-5', effort: 'medium' },
    on: { role, model: 'claude-sonnet-5-5', effort: 'medium' },
  },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'objective',
});

let f;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'replay-cli-'));
  const home = join(base, 'home');
  const evals = join(base, 'evals');
  const transcripts = join(base, 'transcripts');
  const roleEvalFile = join(base, 'role-eval', 'comparisons.jsonl');
  const experimentsFile = join(base, 'experiments.json');
  for (const dir of [home, evals, transcripts, join(base, 'role-eval')]) mkdirSync(dir, { recursive: true });
  writeFileSync(roleEvalFile, '');
  writeFileSync(join(evals, 'role-assignments.jsonl'), '');
  writeFileSync(experimentsFile, JSON.stringify({
    experiments: [roleExperiment('tdd-x', 'tdd-implementer'), roleExperiment('fix-x', 'review-fixer')],
  }, null, 2));
  f = {
    base,
    evals,
    env: {
      HOME: home,
      TRIQUAL_EVALS_DIR: evals,
      TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
      TRIQUAL_TRANSCRIPTS_DIR: transcripts,
      ROLE_EVAL_FILE: roleEvalFile,
    },
  };
});

afterEach(() => {
  rmSync(f.base, { recursive: true, force: true });
});

// The stdout of `triqual eval report` with `argv`; a non-zero exit fails the test with its stderr.
async function report(fixture, argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: fixture.env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    platform: 'linux',
  });
  assert.equal(code, 0, err);
  return out;
}

// The text of each experiment, in the order of the experiments file (an experiment's header starts at column 0).
const splitByExperiment = (text) => text.split(/^(?=\S)/m).filter((chunk) => chunk.length > 0);

// <evals>/replay/results.jsonl: `n` cases, each run once in the control arm (usd 2) and the arm (usd 1), both passing.
function writeResults(fixture, experiment, n, role = 'tdd-implementer') {
  const row = (arm, caseId, usd) => ({
    v: 1, at: '2026-11-22T00:00:00Z', experiment, arm, role, case: caseId, run: 1,
    model: 'm', effort: 'medium', account: 'a', outcome: 'pass', usd, seconds: 1,
  });
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(row('off', `c${i}`, 2), row('on', `c${i}`, 1));
  mkdirSync(join(fixture.evals, 'replay'), { recursive: true });
  writeFileSync(join(fixture.evals, 'replay', 'results.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

// <evals>/replay/cases/<id>/case.json, the file the report reads a case's repoName from.
function writeCase(fixture, caseId, data) {
  const dir = join(fixture.evals, 'replay', 'cases', caseId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify(data));
}

test('no results file: no replay block and no replay key', async () => {
  const text = await report(f, []);
  assert.doesNotMatch(text, /^\s+replay$/m);
  const json = JSON.parse(await report(f, ['--json']));
  assert.ok(json.experiments.every((e) => !Object.hasOwn(e, 'replay')));
});

test('the task-level line appears only under the review-fixer experiment', async () => {
  const text = await report(f, []);
  const [tdd, fix] = splitByExperiment(text);
  assert.doesNotMatch(tdd, /task-level/);
  assert.match(fix, /^  task-level: not attributable to review-fixer$/m);
});

test('results print a replay block and a replay key', async () => {
  writeResults(f, 'tdd-x', 30);
  writeCase(f, 'c0', { repoName: 'app' });
  const text = await report(f, ['--experiment', 'tdd-x']);
  assert.match(text, /^  replay$/m);
  assert.match(text, /verdict: (propose|non-inferior, not cheaper|insufficient data|worse|inconclusive)/);
  const json = JSON.parse(await report(f, ['--experiment', 'tdd-x', '--json']));
  assert.equal(json.experiments[0].replay.length, 2);
  assert.equal(json.experiments[0].replay[1].kind, 'replay');
});

test('the replay block prints one line per arm, its paired figures and a line per repo', async () => {
  writeResults(f, 'tdd-x', 30);
  writeCase(f, 'c0', { repoName: 'app' });
  const text = await report(f, ['--experiment', 'tdd-x']);
  assert.match(text, /^  off \(control\)  cases 30  pass 100\.0% \[.+\]  usd median 2$/m);
  assert.match(text, /^  on  cases 30  pass 100\.0% \[.+\]  usd median 1$/m);
  assert.match(text, /^    d 0 \[0, 0\]  c -1 \[-1, -1\]  paired 30  discordant arm-only 0, control-only 0  verdict: propose$/m);
  assert.match(text, /^    app  n 1  pass 100\.0%$/m);
  assert.match(text, /^    unknown  n 29  pass 100\.0%$/m);
});

test('--help documents the replay rows', async () => {
  assert.match(await report(f, ['--help']), /replay/);
  assert.match(await report(f, ['--help']), /task-level/);
});
