import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { casesDir, resolveCheckout, roleVersion } from '../cli/lib/eval-replay-harvest.mjs';
import { ensureDir } from '../cli/lib/eval-paths.mjs';
import { spawnCapture } from '../cli/lib/eval-judge.mjs';
import { RESULTS_FILE, armChains, planReplay, runReplay } from '../cli/lib/eval-replay-run.mjs';

// Invented repo, invented chain entries and a stub `claude`; nothing reads the real ~/.claude, ~/.config or evals directory.
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const commitAll = (cwd, message) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
};
const write = (cwd, path, body) => {
  const full = join(cwd, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};

const STUB = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const mode = process.env.STUB_MODE;
const login = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
const stdin = fs.readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, stdin, token: login, cwd: process.cwd(), hasB: fs.existsSync('src/b.mjs') }) + '\\n');
const model = argv[argv.indexOf('--model') + 1];
const done = (extra = {}) => process.stdout.write(JSON.stringify({
  type: 'result', is_error: false, result: 'done', total_cost_usd: 0.5, modelUsage: { ['claude-' + model + '-5-0']: {} }, ...extra,
}));
const original = () => fs.writeFileSync('src/b.mjs', 'export function mul(a, b) { return a * b; }\\n');
if (mode === 'dirty-limit-first' && login === 'tok-a') {
  fs.writeFileSync('src/b.mjs', 'export const mul = () => 0;\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your limit" }));
} else if (mode === 'dirty-limit-first') done();
else if (mode === 'limit-first' && login === 'tok-a') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your limit" }));
} else if (mode === 'nothing') done();
else if (mode === 'cheat') {
  fs.mkdirSync('test', { recursive: true });
  fs.writeFileSync('test/b.test.mjs', "import test from 'node:test'; test('ok', () => {});\\n");
  fs.writeFileSync('src/b.mjs', 'export const mul = () => 0;\\n');
  done();
} else if (mode === 'wrong-model') { original(); done({ modelUsage: { 'claude-opus-5-5': {} } }); }
else if (mode === 'garbage') process.stdout.write('not json');
else {
  if (mode === 'tracking') spawnSync('triqual', ['tracking', 'add', 'x']);
  original();
  done();
}
`;

const ARM_CTRL = 'sonnet-high';
const ARM_NEW = 'haiku-high';
const experiment = {
  id: 'exp1',
  kind: 'role',
  status: 'active',
  control: ARM_CTRL,
  arms: {
    [ARM_CTRL]: { role: 'tdd-implementer', model: 'sonnet', effort: 'high' },
    [ARM_NEW]: { role: 'tdd-implementer', model: 'haiku', effort: 'high' },
  },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'x',
};

let tmp; let home; let evals; let repo; let base; let original; let bin; let stubLog; let marker; let fakeBin; let chainFile; let env;
let checkout; let version; let pluginDir; let seq = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'replay-run-'));
  home = join(tmp, 'home');
  evals = join(tmp, 'evals');
  mkdirSync(home);
  repo = join(tmp, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', 'export function add(a, b) { return a + b; }\n');
  base = commitAll(repo, 'feat: a');
  write(repo, 'src/b.mjs', 'export function mul(a, b) { return a * b; }\n');
  write(repo, 'test/b.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { mul } from '../src/b.mjs';",
    "test('mul', () => { assert.equal(mul(2, 3), 6); });",
    '',
  ].join('\n'));
  original = commitAll(repo, 'feat: b');
  bin = join(tmp, 'claude-stub');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  stubLog = join(tmp, 'stub.log');
  marker = join(tmp, 'marker');
  fakeBin = join(tmp, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'triqual'), '#!/bin/sh\ntouch "$MARKER"\n');
  chmodSync(join(fakeBin, 'triqual'), 0o755);
  pluginDir = join(tmp, 'plugin');
  mkdirSync(pluginDir);
  checkout = resolveCheckout({ cwd: process.cwd() });
  version = roleVersion('tdd-implementer', checkout);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const writeChain = (names) => {
  const file = join(tmp, `chain-${names.join('')}-${seq++}.json`);
  writeFileSync(file, JSON.stringify({ chain: names.map((n) => ({ name: n, env: { CLAUDE_CODE_OAUTH_TOKEN: `tok-${n}` } })) }));
  return file;
};

const addCase = (id) => {
  const dir = join(casesDir(evals), id);
  ensureDir(dir);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({
    v: 1,
    id,
    role: 'tdd-implementer',
    roleVersion: version.sha,
    repo,
    repoName: 'app',
    base,
    original,
    prompt: 'Implement mul in {{WORK}} (case {{CASE}}).',
    hiddenTests: ['test/b.test.mjs'],
    supportFiles: [],
    testCommand: 'node --test test/b.test.mjs',
    originalUsd: 1,
    literalsUnnamed: id === 'case-b' ? 1 : 0,
    validated: true,
  }));
};

beforeEach(() => {
  rmSync(evals, { recursive: true, force: true });
  rmSync(stubLog, { force: true });
  rmSync(marker, { force: true });
  chainFile = writeChain(['a', 'b']);
  const { NODE_TEST_CONTEXT: _, ...rest } = process.env;
  env = { ...rest, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, STUB_LOG: stubLog, MARKER: marker, TRIQUAL_EVAL_AUTH_FILE: chainFile };
});

const stub = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const resultsLines = () => {
  const file = join(evals, RESULTS_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const repos = { app: { setup: 'true', timeoutSeconds: 10 } };

// Runs `mode` over `cases` cases for the arms given (both by default) and returns the appended results lines.
async function go(mode, { cases = 1, arms = [ARM_CTRL, ARM_NEW], chain = ['a', 'b'], concurrency = 1, runs = 1, repos: r = repos, bin: agentBin = bin, spawn } = {}) {
  const ids = ['case-a', 'case-b', 'case-c'].slice(0, cases);
  ids.forEach(addCase);
  const exp = { ...experiment, arms: Object.fromEntries(arms.map((a) => [a, experiment.arms[a]])), control: arms[0] };
  const file = writeChain(chain);
  const e = { ...env, STUB_MODE: mode, TRIQUAL_EVAL_AUTH_FILE: file };
  const chains = armChains({ experiment: exp, authFiles: {}, env: e, home, paid: false });
  assert.equal(chains.ok, true, chains.reason);
  const plan = planReplay({ experiment: exp, evals, checkout, n: 40, seed: 1, runs });
  const before = resultsLines().length;
  const summary = await runReplay({
    experiment: exp, plan, chains: chains.chains, runs, concurrency, evals, checkout, pluginDir, repos: r, bin: agentBin, env: e, home, spawn, now: () => new Date('2026-11-22T10:00:00Z'),
  });
  return { lines: resultsLines().slice(before), summary };
}
const one = async (mode, opts = {}) => {
  const { arm = ARM_CTRL, ...rest } = opts;
  return (await go(mode, { ...rest, arms: [arm] })).lines[0];
};

test('original change passes, nothing is no-change, a cheat still fails', async () => {
  assert.equal((await one('original')).outcome, 'pass');
  rmSync(evals, { recursive: true, force: true });
  assert.equal((await one('nothing')).outcome, 'no-change');
  rmSync(evals, { recursive: true, force: true });
  assert.equal((await one('cheat')).outcome, 'tests-failed');
});

test('a line carries the U3 fields and the file is private', async () => {
  const r = await one('original');
  assert.deepEqual(r, {
    v: 1, at: '2026-11-22T10:00:00.000Z', experiment: 'exp1', arm: ARM_CTRL, role: 'tdd-implementer', case: 'case-a', run: 1,
    model: 'sonnet', effort: 'high', account: 'a', outcome: 'pass', usd: 0.5, seconds: r.seconds,
  });
  assert.equal(typeof r.seconds, 'number');
  assert.equal(statSync(join(evals, RESULTS_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(join(evals, RESULTS_FILE))).mode & 0o777, 0o700);
});

test('the arm model reaches the agents JSON and --model, and the prompt is filled on stdin', async () => {
  await one('original', { arm: ARM_NEW });
  const { argv, stdin } = stub()[0];
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
  assert.equal(JSON.parse(argv[argv.indexOf('--agents') + 1])['tdd-implementer'].model, 'haiku');
  assert.equal(argv[argv.indexOf('--plugin-dir') + 1], pluginDir);
  assert.match(stdin, /^Implement mul in \S*triqual-replay-\S+ \(case \S+case-a\)\.$/);
});

test('a usage limit on the first entry is retried on the second and recorded with its account', async () => {
  const r = await one('limit-first');
  assert.equal(r.account, 'b');
  assert.equal(r.outcome, 'pass');
  assert.deepEqual(stub().map((s) => s.token), ['tok-a', 'tok-b']);
});

test('two in-flight limits advance the chain once', async () => {
  const { lines } = await go('limit-first', { cases: 2, concurrency: 2, chain: ['a', 'b', 'c'], arms: [ARM_CTRL] });
  assert.deepEqual(lines.map((l) => l.account), ['b', 'b']);
  assert.equal(stub().filter((s) => s.token === 'tok-c').length, 0);
});

test('every entry on a limit throws ChainExhausted and records nothing for the unit', async () => {
  await assert.rejects(go('limit-first', { chain: ['a'], arms: [ARM_CTRL] }), { name: 'ChainExhausted' });
  assert.equal(resultsLines().length, 0);
});

test('a limit retry starts from the case base: the edit of the first entry is gone on the second', async () => {
  const { lines } = await go('dirty-limit-first', { arms: [ARM_CTRL] });
  assert.deepEqual(lines.map((l) => [l.account, l.outcome]), [['b', 'no-change']]);
  assert.deepEqual(stub().map((s) => s.hasB), [false, false]);
});

test('a limit retry whose setup fails is setup-failed and runs no second agent', async () => {
  const count = join(tmp, 'setup-count');
  rmSync(count, { force: true });
  const setup = `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}; test "$n" -eq 0`;
  const { lines } = await go('limit-first', { arms: [ARM_CTRL], repos: { app: { setup, timeoutSeconds: 10 } } });
  assert.deepEqual(lines.map((l) => [l.account, l.outcome]), [[null, 'setup-failed']]);
  assert.equal(stub().length, 1);
});

test('an agent that cannot start aborts the run and writes no line for the unit', async () => {
  // A failed spawn leaves spawnCapture's timeout armed (Node clears it only on exit), so the test uses a 1 s one.
  const shortTimeout = (b, a, o) => spawnCapture(b, a, { ...o, timeoutMs: 1000 });
  const missing = join(tmp, 'no-such-claude');
  await assert.rejects(go('original', { bin: missing, spawn: shortTimeout }), /could not be started: .*no-such-claude \(ENOENT\)/);
  assert.equal(resultsLines().length, 0);
});

test('another model in modelUsage is agent-error', async () => {
  assert.equal((await one('wrong-model')).outcome, 'agent-error');
});

test('unparseable output is agent-error', async () => {
  assert.equal((await one('garbage')).outcome, 'agent-error');
});

test('a triqual call inside the run writes nothing', async () => {
  await one('tracking');
  assert.equal(existsSync(marker), false);
});

test('a rerun skips recorded runs', async () => {
  await go('original', { cases: 2 });
  const before = resultsLines().length;
  assert.equal(before, 4);
  await go('original', { cases: 2 });
  assert.equal(resultsLines().length, before);
  assert.equal(stub().length, before);
});

test('the summary counts passes, usd, accounts and literal buckets', async () => {
  const { summary } = await go('original', { cases: 2, arms: [ARM_CTRL] });
  assert.deepEqual(summary[ARM_CTRL], {
    counted: 2, passes: 2, usd: 1, accounts: { a: 2 },
    literals: { unnamed: { counted: 1, passes: 1 }, named: { counted: 1, passes: 1 } },
  });
});

test('a missing chain file refuses before any spawn', () => {
  const r = armChains({ experiment, authFiles: { [ARM_NEW]: join(tmp, 'none.json') }, env: { ...env, TRIQUAL_EVAL_AUTH_FILE: chainFile }, home, paid: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^arm haiku-high: no credential chain file/);
  assert.equal(stub().length, 0);
});

test('a paid-only chain is refused without --paid and used with it; a bad file gives its message', () => {
  const file = join(tmp, 'paid.json');
  writeFileSync(file, JSON.stringify({ chain: [{ name: 'p', paid: true, env: { ANTHROPIC_API_KEY: 'k' } }] }));
  const args = { experiment, authFiles: { [ARM_CTRL]: file, [ARM_NEW]: file }, env, home };
  assert.match(armChains({ ...args, paid: false }).reason, /^arm sonnet-high: every credential entry is paid; pass --paid$/);
  assert.deepEqual(armChains({ ...args, paid: true }).chains[ARM_NEW].map((e) => e.name), ['p']);
  writeFileSync(file, '{');
  assert.equal(armChains({ ...args, paid: true }).reason, 'eval-auth file: not JSON');
});

test('clones are removed, also when setup fails', async () => {
  const count = () => readdirSync(tmpdir()).filter((n) => n.startsWith('triqual-replay-')).length;
  const before = count();
  const r = await one('original', { repos: { app: { setup: 'exit 1', timeoutSeconds: 10 } } });
  assert.equal(r.outcome, 'setup-failed');
  assert.equal(r.account, null);
  assert.equal(stub().length, 0);
  assert.equal(count(), before);
  await one('original');
  assert.equal(count(), before);
});

test('a missing plugin dir or a foreign role refuses before any spawn', async () => {
  addCase('case-a');
  const plan = planReplay({ experiment, evals, checkout, n: 40, seed: 1, runs: 1 });
  const chains = armChains({ experiment, authFiles: {}, env: { ...env, STUB_MODE: 'original' }, home, paid: false }).chains;
  const args = { experiment, plan, chains, runs: 1, concurrency: 1, evals, checkout, pluginDir: null, repos, bin, env, home, now: () => new Date() };
  await assert.rejects(runReplay(args), /plugin/);
  const other = { ...experiment, arms: { x: { role: 'planner', model: 'sonnet', effort: 'high' }, y: { role: 'planner', model: 'haiku', effort: 'high' } }, control: 'x' };
  await assert.rejects(runReplay({ ...args, experiment: other, pluginDir }), /role/);
  assert.equal(stub().length, 0);
});

test('planReplay: sample, run count and estimate; spawns nothing', () => {
  ['case-a', 'case-b'].forEach(addCase);
  const p = planReplay({ experiment, evals, checkout, n: 40, seed: 1, runs: 2 });
  assert.equal(p.cases.length, 2);
  assert.equal(p.runCount, p.cases.length * 2 * 2);
  assert.deepEqual(p.perRepo, { app: 2 });
  assert.ok(Object.hasOwn(p.estimate, ARM_NEW));
  assert.equal(stub().length, 0);
  assert.throws(() => planReplay({ experiment: { ...experiment, status: 'done' }, evals, checkout, n: 1, seed: 1, runs: 1 }), /^Error: experiment exp1: /);
  assert.throws(() => planReplay({ experiment: { ...experiment, kind: 'skill' }, evals, checkout, n: 1, seed: 1, runs: 1 }), /^Error: experiment exp1: /);
});
