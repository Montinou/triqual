// The replay runner: plans a role experiment's replay, resolves each arm's credential chain, and runs (arm, case, run)
// units in isolated clones, appending one line per finished unit to <evals>/replay/results.jsonl. It prints nothing and
// never uses the ambient login. node: built-ins only.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  AuthError, PAID_NOTE, authPath, childEnv, loadChain, usableChain, withChain,
} from './eval-auth.mjs';
import { ensureDir } from './eval-paths.mjs';
import { spawnCapture } from './eval-judge.mjs';
import { readJsonl } from './eval-store.mjs';
import { cloneAt, removeClone } from './eval-replay-clone.mjs';
import { agentsJson, claudeArgs, fillPrompt, modelOk, writeShim } from './eval-replay-agent.mjs';
import { casesDir, roleVersion } from './eval-replay-harvest.mjs';
import { gradeRun } from './eval-replay-grade.mjs';
import { runSetup } from './eval-replay-repos.mjs';
import { estimateUsd, loadCases, sampleCases } from './eval-replay-sample.mjs';

export const RESULTS_FILE = 'replay/results.jsonl';
export const ROLES = ['tdd-implementer', 'review-fixer'];
const AGENT_TIMEOUT_MS = 1_200_000;
const GIT_TIMEOUT_MS = 60_000;
const NOT_COUNTED = ['setup-failed', 'agent-error'];

// Each arm's usable credential chain: { ok: true, chains: { [arm]: entry[] } } or { ok: false, reason }. A missing file
// (the single `ambient` entry) is refused: the ambient login is never used.
export function armChains({ experiment, authFiles = {}, env, home, paid }) {
  const chains = {};
  for (const arm of Object.keys(experiment.arms)) {
    let chain;
    try { chain = loadChain(authFiles[arm] ?? authPath(env, home)); } catch (err) {
      if (err instanceof AuthError) return { ok: false, reason: err.message };
      throw err;
    }
    if (chain.length === 1 && chain[0].name === 'ambient' && Object.keys(chain[0].env).length === 0) {
      return { ok: false, reason: `arm ${arm}: no credential chain file (the ambient login is never used)` };
    }
    chains[arm] = usableChain(chain, { paid });
    if (chains[arm].length === 0) return { ok: false, reason: `arm ${arm}: ${PAID_NOTE}` };
  }
  return { ok: true, chains };
}

// The role of a role experiment this runner can replay; throws Error('experiment <id>: <why>') otherwise.
function roleOf(experiment) {
  const fail = (why) => new Error(`experiment ${experiment?.id}: ${why}`);
  if (experiment?.kind !== 'role') throw fail('not a role experiment');
  if (!['active', 'paused'].includes(experiment.status)) throw fail('must be active or paused');
  const roles = Object.values(experiment.arms ?? {}).map((a) => a?.role);
  if (roles.length === 0 || !roles.every((r) => r === roles[0]) || !ROLES.includes(roles[0])) {
    throw fail(`role must be ${ROLES.join(' or ')}`);
  }
  return roles[0];
}

// The cases a replay would run, the run count and the dry-run USD estimate per arm. Spawns nothing.
export function planReplay({ experiment, evals, checkout, n, seed, runs }) {
  const role = roleOf(experiment);
  const version = roleVersion(role, checkout);
  if (version === null) throw new Error(`experiment ${experiment.id}: the role file has no version in the checkout`);
  const cases = sampleCases(loadCases(casesDir(evals), { role, roleVersion: version.sha }), { n, seed });
  const perRepo = {};
  for (const c of cases) perRepo[c.repoName] = (perRepo[c.repoName] ?? 0) + 1;
  const arms = Object.keys(experiment.arms);
  const controlModel = experiment.arms[experiment.control].model;
  return {
    cases,
    perRepo,
    runCount: cases.length * runs * arms.length,
    estimate: Object.fromEntries(arms.map((a) => [a, estimateUsd(cases, { armModel: experiment.arms[a].model, controlModel, runs })])),
  };
}

// The final result object of `claude -p --output-format json` stdout: an object, or the last result in an array.
function parseResult(stdout) {
  let v;
  try { v = JSON.parse(String(stdout ?? '').trim()); } catch { return null; }
  if (Array.isArray(v)) v = [...v].reverse().find((m) => m?.type === 'result');
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// The paths `git status` lists in a clone right after setup: setup's output, not the agent's change.
function setupPathsOf(clone) {
  const r = spawnSync('git', ['-C', clone, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
}

// A clone's git command exited 0 within the timeout.
function gitOk(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return r.status === 0 && !r.error;
}

// Sets a clone up for a case: its setup, then the paths `git status` lists right after it (null: the setup failed).
function prepare(clone, kase, repos, baseEnv) {
  const entry = repos[kase.repoName];
  const setup = entry ? runSetup(clone, entry, { repo: kase.repo, env: baseEnv }) : { ok: false };
  return setup.ok ? setupPathsOf(clone) : null;
}

// Puts a clone back at the case's base with nothing untracked or ignored left: what a retry after a limit starts from.
const resetClone = (clone, base) => gitOk(['-C', clone, 'reset', '--hard', '-q', base]) && gitOk(['-C', clone, 'clean', '-fdxq']);

// The attempt result of a retry whose reset or setup failed: the chain stops there and the unit is setup-failed.
const SETUP_FAILED = Object.freeze({ setupFailed: true });

const unitKey = (e, arm, id, run) => `${e}\0${arm}\0${id}\0${run}`;

// Runs the plan's cases for every arm of the experiment and appends one line per finished unit. Units that are already in
// results.jsonl are skipped. Returns the figures of the units finished by this call, per arm. A ChainExhausted or AuthError
// stops the run after the units in flight finish.
export async function runReplay({
  experiment, plan, chains, runs, concurrency, evals, checkout, pluginDir, repos, bin, env, home, now = () => new Date(), spawn = spawnCapture,
}) {
  const role = roleOf(experiment);
  if (typeof pluginDir !== 'string' || pluginDir === '') throw new Error('the methodology plugin is not installed: no plugin directory');
  const arms = Object.keys(experiment.arms);
  for (const arm of arms) if (!Array.isArray(chains[arm]) || chains[arm].length === 0) throw new Error(`arm ${arm}: no credential chain`);
  const file = join(evals, RESULTS_FILE);
  ensureDir(dirname(file));
  const done = new Set(readJsonl(file).rows.filter((r) => r.v === 1).map((r) => unitKey(r.experiment, r.arm, r.case, r.run)));
  const units = [];
  for (const kase of plan.cases) {
    for (let run = 1; run <= runs; run += 1) {
      for (const arm of arms) if (!done.has(unitKey(experiment.id, arm, kase.id, run))) units.push({ arm, kase, run });
    }
  }
  const summary = Object.fromEntries(arms.map((a) => [a, {
    counted: 0, passes: 0, usd: 0, accounts: {}, literals: { unnamed: { counted: 0, passes: 0 }, named: { counted: 0, passes: 0 } },
  }]));
  const baseEnv = childEnv({ name: 'none', env: {} }, env, { home });
  const agents = Object.fromEntries(arms.map((a) => [a, agentsJson(checkout, role, experiment.arms[a])]));

  async function runUnit({ arm, kase, run }) {
    const spec = experiment.arms[arm];
    const started = Date.now();
    let clone = null;
    let shim = null;
    let outcome;
    let account = null;
    let usd = null;
    try {
      try { clone = cloneAt(kase.repo, kase.base); } catch { outcome = 'setup-failed'; }
      if (clone !== null) {
        let setupPaths = prepare(clone, kase, repos, baseEnv);
        if (setupPaths === null) outcome = 'setup-failed';
        else {
          shim = mkdtempSync(join(tmpdir(), 'triqual-replay-'));
          writeShim(shim);
          const prompt = fillPrompt(kase.prompt, { work: clone, caseDir: kase.dir });
          const args = claudeArgs({ role, agents: agents[arm], model: spec.model, effort: spec.effort, pluginDir });
          let attempts = 0;
          const attempt = async (_unit, e) => {
            attempts += 1;
            // A retry after a limit starts from the case's base: the earlier entry's edits and commits are not this unit's work.
            if (attempts > 1) {
              setupPaths = resetClone(clone, kase.base) ? prepare(clone, kase, repos, baseEnv) : null;
              if (setupPaths === null) return SETUP_FAILED;
            }
            const childEnvironment = { ...childEnv(e, env, { home }), PATH: `${shim}${delimiter}${env.PATH ?? ''}` };
            let out = null;
            try { out = await spawn(bin, args, { input: prompt, env: childEnvironment, cwd: clone, timeoutMs: AGENT_TIMEOUT_MS }); } catch { /* agent-error */ }
            // The agent did not start (a wrong bin): not a unit's outcome, so the run stops and nothing is recorded for it.
            if (out?.spawnError) throw new Error(`the agent could not be started: ${bin} (${out.spawnError})`);
            return parseResult(out?.stdout);
          };
          const { result, entry: used } = await chainFor[arm].run({ arm, kase, run }, attempt);
          if (result === SETUP_FAILED) outcome = 'setup-failed';
          else {
            account = used.name;
            if (typeof result?.total_cost_usd === 'number') usd = result.total_cost_usd;
            if (result === null || result.is_error === true || !modelOk(result.modelUsage ?? {}, spec.model)) outcome = 'agent-error';
            else outcome = gradeRun({ repo: kase.repo, clone, kase: { ...kase, setupPaths }, env: baseEnv }).outcome;
          }
        }
      }
    } finally {
      if (clone !== null) removeClone(clone);
      if (shim !== null) rmSync(shim, { recursive: true, force: true });
    }
    const line = {
      v: 1, at: now().toISOString(), experiment: experiment.id, arm, role, case: kase.id, run, model: spec.model, effort: spec.effort,
      account, outcome, usd, seconds: (Date.now() - started) / 1000,
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    const s = summary[arm];
    if (typeof usd === 'number') s.usd += usd;
    if (account !== null) s.accounts[account] = (s.accounts[account] ?? 0) + 1;
    if (!NOT_COUNTED.includes(outcome)) {
      const bucket = s.literals[kase.literalsUnnamed > 0 ? 'unnamed' : 'named'];
      s.counted += 1;
      bucket.counted += 1;
      if (outcome === 'pass') { s.passes += 1; bucket.passes += 1; }
    }
  }

  // One chain per arm, shared by all of the arm's units: `run(unit, attempt)` hands each unit's own attempt to withChain.
  const chainFor = Object.fromEntries(arms.map((a) => {
    const chain = withChain(chains[a], (unit, entry) => unit.attempt(unit, entry));
    return [a, { run: (unit, attempt) => chain.run({ ...unit, attempt }) }];
  }));

  let next = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null && next < units.length) {
      const unit = units[next];
      next += 1;
      try { await runUnit(unit); } catch (err) { failure ??= err; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, units.length)) }, worker));
  if (failure !== null) throw failure;
  return summary;
}
