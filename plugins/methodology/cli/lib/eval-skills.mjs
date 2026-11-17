// The skill replay: one `claude plugin eval` suite per experiment arm, and the reading of its aggregate result.
// node: built-ins only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { limitText } from './eval-auth.mjs';
import { spawnCapture } from './eval-judge.mjs';

// A suite is many model runs (and judge calls) of one plugin: well over a judge call.
export const SUITE_TIMEOUT_MS = 3_600_000;
export const AGGREGATE_FILE = 'aggregate-result.json';

// Thrown when `claude plugin eval` leaves no readable aggregate. The message holds the exit code, never the child's output.
export class SuiteError extends Error {
  constructor(message) { super(message); this.name = 'SuiteError'; }
}

// Runs the suite of `pluginDir` into `outDir` and resolves the parsed aggregate result. The command exits non-zero when
// a case fails or hits an API error, so the exit code is not read: the aggregate is. Never publishes (--no-publish: the
// default publishes the HTML report to claude.ai) and never trusts the plugin (--trust-plugin).
export async function runSuite({ pluginDir, outDir, spawn = spawnCapture, env = process.env }) {
  const bin = env.TRIQUAL_CLAUDE_BIN || 'claude';
  const args = ['plugin', 'eval', pluginDir, '--eval-dir', 'evals/cases', '--ablation', 'none', '--output-dir', outDir, '--no-publish'];
  const out = await spawn(bin, args, { env, timeoutMs: SUITE_TIMEOUT_MS });
  let aggregate;
  try {
    aggregate = JSON.parse(readFileSync(join(outDir, AGGREGATE_FILE), 'utf8'));
  } catch {
    throw new SuiteError(`claude plugin eval left no aggregate result (exit ${out?.spawnError ?? out?.code ?? 'unknown'})`);
  }
  if (aggregate === null || typeof aggregate !== 'object' || !Array.isArray(aggregate.cases)) {
    throw new SuiteError(`claude plugin eval left an aggregate result without cases (exit ${out?.code ?? 'unknown'})`);
  }
  return aggregate;
}

const runsOf = (c, arm) => (Array.isArray(c?.arms?.[arm]) ? c.arms[arm] : []);

// True when any run of the suite ended on a usage limit: `claude plugin eval` scores that run 0 with the error text in
// `error`. `partial` is not read: an authentication error sets it too.
export function suiteLimited(aggregate) {
  return (aggregate?.cases ?? []).some((c) => ['with', 'without'].some((arm) => runsOf(c, arm).some((r) => limitText(r?.error))));
}

// How many runs of the suite ended on an API error that is not a usage limit (an authentication error, a server error):
// `error` is non-null and `limitText` does not match it. Such a run has no verdict, so the arm is not scored.
export function suiteErrors(aggregate) {
  return (aggregate?.cases ?? []).reduce((n, c) => n + ['with', 'without']
    .reduce((m, arm) => m + runsOf(c, arm).filter((r) => r?.error != null && !limitText(r.error)).length, 0), 0);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// One unit per case: `pass` when the case has runs and every run of the plugin passed, `usd` the model and judge cost of all its runs.
export function toUnits(aggregate) {
  return (aggregate?.cases ?? []).map((c) => {
    const withRuns = runsOf(c, 'with');
    return {
      caseId: c.name,
      pass: withRuns.length > 0 && withRuns.every((r) => r?.passed === true),
      usd: [...withRuns, ...runsOf(c, 'without')].reduce((sum, r) => sum + num(r?.costUsd) + num(r?.judgeCostUsd), 0),
    };
  });
}
