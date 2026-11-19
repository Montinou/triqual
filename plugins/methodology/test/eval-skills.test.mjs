import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_VARS, PAID_NOTE } from '../cli/lib/eval-auth.mjs';
import { runSuite, suiteErrors, suiteLimited, toUnits } from '../cli/lib/eval-skills.mjs';
import { main } from '../cli/eval-skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = join(HERE, 'fixtures', 'plugin-eval', 'aggregate-result.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));

// Fixture secrets are built at run time so no secret-looking literal sits in the source.
const J = (...p) => p.join('-');
const SECRET_ONE = J('fixture', 'first', 'token', '0123456789');
const SECRET_TWO = J('fixture', 'second', 'token', '9876543210');

// The variables the fake `claude` reports: the credentials, the provider selectors and the arm marker.
const WATCHED = [...CREDENTIAL_VARS, 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'TRIQUAL_EVAL_ARM'];
const FIRST_VAR = CREDENTIAL_VARS[0];
const SECOND_VAR = CREDENTIAL_VARS[1];

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evskills-'));

const FAKE = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const e = process.env;
const outIdx = argv.indexOf('--output-dir');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
const WATCHED = JSON.parse(e.FAKE_WATCHED);
appendFileSync(e.FAKE_LOG, JSON.stringify({
  argv,
  outDir,
  env: Object.fromEntries(WATCHED.map((n) => [n, n in e ? e[n] : null])),
}) + '\\n');
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const doc = JSON.parse(readFileSync(e.FAKE_FIXTURE, 'utf8'));
  const mode = e.FAKE_MODE || 'ok';
  if (mode === 'auth-error') {
    doc.partial = true;
    doc.cases[0].arms.with[0].passed = false;
    doc.cases[0].arms.with[0].score = 0;
    doc.cases[0].arms.with[0].error = e.FAKE_ERROR_TEXT;
    doc.cases[1].arms.with = [];
    writeFileSync(join(outDir, 'aggregate-result.json'), JSON.stringify(doc));
    process.exit(1);
  }
  const limited = mode === 'limit-all' || (mode === 'limit-first' && e[WATCHED[0]] === e.FAKE_FIRST);
  if (limited) {
    doc.partial = true;
    doc.costUsd = 0;
    for (const c of doc.cases) {
      for (const r of c.arms.with) {
        r.score = 0;
        r.passed = false;
        r.costUsd = 0;
        r.judgeCostUsd = 0;
        r.error = "You've hit your 5-hour limit · resets 8:30am";
      }
    }
    writeFileSync(join(outDir, 'limited-marker.txt'), 'limited');
    writeFileSync(join(outDir, 'aggregate-result.json'), JSON.stringify(doc));
    process.exit(2);
  }
  copyFileSync(e.FAKE_FIXTURE, join(outDir, 'aggregate-result.json'));
}
`;

const skillExperiment = (over = {}) => ({
  id: 's1',
  kind: 'skill',
  status: 'active',
  start: '2026-11-17T00:00:00Z',
  control: 'a',
  arms: {
    a: { pluginDir: '/work/example/plugin-a' },
    b: { pluginDir: '/work/example/plugin-b' },
  },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'objective',
  ...over,
});

function fixture({ experiments = [skillExperiment()], chain, mode } = {}) {
  const dir = tmp();
  const home = join(dir, 'home');
  const evals = join(dir, 'evals');
  mkdirSync(home, { recursive: true });
  mkdirSync(evals, { recursive: true });
  const experimentsFile = join(dir, 'experiments.json');
  writeFileSync(experimentsFile, JSON.stringify({ experiments }));
  const bin = join(dir, 'claude');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  const authFile = join(dir, 'eval-auth.json');
  if (chain) writeFileSync(authFile, JSON.stringify({ chain }));
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TRIQUAL_EVALS_DIR: evals,
    TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
    TRIQUAL_EVAL_AUTH_FILE: authFile,
    TRIQUAL_CLAUDE_BIN: bin,
    FAKE_LOG: log,
    FAKE_FIXTURE: FIXTURE_FILE,
    FAKE_WATCHED: JSON.stringify(WATCHED),
  };
  if (mode) env.FAKE_MODE = mode;
  return { dir, evals, env, log, armFile: (id, arm) => join(evals, 'skill-runs', id, `${arm}.json`) };
}

const calls = (e) => readFileSync(e.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function run(e, argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: e.env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

test('a two-arm fixture experiment runs two suites and writes two files', async () => {
  const e = fixture();
  try {
    const r = await run(e, ['--experiment', 's1']);
    assert.equal(r.code, 0, r.err);
    const seen = calls(e);
    assert.equal(seen.length, 2);
    assert.match(r.out, /\ba\b/);
    assert.match(r.out, /\bb\b/);
    assert.deepEqual(
      seen.map((c) => c.argv.slice(0, 3)).sort((x, y) => x[2].localeCompare(y[2])),
      [['plugin', 'eval', '/work/example/plugin-a'], ['plugin', 'eval', '/work/example/plugin-b']],
    );
    for (const arm of ['a', 'b']) {
      const file = e.armFile('s1', arm);
      assert.equal(existsSync(file), true, `${arm}.json written`);
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(doc.experiment, 's1');
      assert.equal(doc.arm, arm);
      assert.equal(doc.auth, 'ambient');
      assert.match(doc.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(Object.keys(doc).sort(), ['arm', 'at', 'auth', 'experiment', 'units']);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
      assert.deepEqual(doc.units, [
        { caseId: 'probe-case', pass: true, usd: 0.0015 },
        { caseId: 'second-case', pass: false, usd: 0.0025 },
      ]);
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test("toUnits maps the fixture's cases to pass and usd", () => {
  assert.deepEqual(toUnits(FIXTURE), [
    { caseId: 'probe-case', pass: true, usd: 0.0015 },
    { caseId: 'second-case', pass: false, usd: 0.0025 },
  ]);
});

test('toUnits makes one unit per case: pass when more than half of the runs passed, usd the cost of all runs', () => {
  const agg = structuredClone(FIXTURE);
  const run = (passed, costUsd, judgeCostUsd) => ({ score: passed ? 1 : 0, passed, costUsd, judgeCostUsd, error: null });
  agg.cases[0].arms.with = [run(true, 0.5, 0.25), run(true, 0.5, 0.25)];
  agg.cases[1].arms.with = [run(true, 1, 0), run(false, 2, 0.5)];
  assert.deepEqual(toUnits(agg), [
    { caseId: 'probe-case', pass: true, usd: 1.5 },
    { caseId: 'second-case', pass: false, usd: 3.5 },
  ]);
  agg.cases[1].arms.with = [];
  assert.deepEqual(toUnits(agg)[1], { caseId: 'second-case', pass: false, usd: 0 });
});

test('toUnits: 2 of 3 runs passing passes the case, 1 of 3 fails it, 1 of 1 passes', () => {
  const agg = structuredClone(FIXTURE);
  const run = (passed) => ({ score: passed ? 1 : 0, passed, costUsd: 0, judgeCostUsd: 0, error: null });
  agg.cases[0].arms.with = [run(true), run(false), run(true)];
  agg.cases[1].arms.with = [run(false), run(true), run(false)];
  assert.deepEqual(toUnits(agg).map((u) => u.pass), [true, false]);
  agg.cases[1].arms.with = [run(true)];
  assert.equal(toUnits(agg)[1].pass, true);
});

test('no --trust-plugin in the spawned argv', async () => {
  const dir = tmp();
  try {
    const outDir = join(dir, 'out');
    const spawned = [];
    const spawn = async (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      mkdirSync(outDir, { recursive: true });
      copyFileSync(FIXTURE_FILE, join(outDir, 'aggregate-result.json'));
      return { code: 0, stdout: '', stderr: '' };
    };
    await runSuite({ pluginDir: '/work/example/plugin-a', outDir, spawn, env: { PATH: '/bin' } });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].args.includes('--trust-plugin'), false);

    const e = fixture();
    try {
      const r = await run(e, ['--experiment', 's1']);
      assert.equal(r.code, 0, r.err);
      for (const c of calls(e)) assert.equal(c.argv.includes('--trust-plugin'), false);
    } finally { rmSync(e.dir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--no-publish and the sonnet judge are in the spawned argv', async () => {
  const dir = tmp();
  try {
    const outDir = join(dir, 'out');
    const spawned = [];
    const spawn = async (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      mkdirSync(outDir, { recursive: true });
      copyFileSync(FIXTURE_FILE, join(outDir, 'aggregate-result.json'));
      return { code: 0, stdout: '', stderr: '' };
    };
    const agg = await runSuite({ pluginDir: '/work/example/plugin-a', outDir, spawn, env: { PATH: '/bin' } });
    assert.deepEqual(agg, FIXTURE);
    const { args } = spawned[0];
    assert.deepEqual(args, [
      'plugin', 'eval', '/work/example/plugin-a', '--eval-dir', 'evals/cases', '--ablation', 'none',
      '--output-dir', outDir, '--no-publish', '--judge-model', 'sonnet',
    ]);
    assert.equal(spawned[0].bin, 'claude');
    assert.equal(spawned[0].opts.env.PATH, '/bin');

    const e = fixture();
    try {
      const r = await run(e, ['--experiment', 's1']);
      assert.equal(r.code, 0, r.err);
      for (const c of calls(e)) assert.equal(c.argv.includes('--no-publish'), true);
    } finally { rmSync(e.dir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an inactive or non-skill experiment exits 2', async () => {
  const e = fixture({
    experiments: [
      skillExperiment({ id: 'paused-skill', status: 'paused' }),
      skillExperiment({ id: 'done-skill', status: 'done' }),
      {
        id: 'active-session',
        kind: 'session',
        status: 'active',
        start: '2026-11-17T00:00:00Z',
        control: 'a',
        arms: { a: { model: 'm1' }, b: { model: 'm2' } },
        margin: 0.1,
        objective: 'cost',
        evaluators: 'h1',
      },
      {
        id: 'active-role',
        kind: 'role',
        status: 'active',
        start: '2026-11-17T00:00:00Z',
        control: 'a',
        arms: { a: { role: 'planner', model: 'm1' }, b: { role: 'planner', model: 'm2' } },
        margin: 0.1,
        objective: 'cost',
        evaluators: 'h1',
      },
    ],
  });
  try {
    for (const id of ['paused-skill', 'done-skill', 'active-session', 'active-role', 'unknown-exp']) {
      const r = await run(e, ['--experiment', id]);
      assert.equal(r.code, 2, `expected exit 2 for ${id}`);
    }
    assert.equal((await run(e, [])).code, 2);
    assert.equal((await run(e, ['--bogus'])).code, 2);
    assert.equal(calls(e).length, 0);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test("the suite child gets the first entry's variables and no other credential", async () => {
  const e = fixture({
    chain: [
      { name: 'first', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
      { name: 'second', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_TWO } },
    ],
  });
  for (const v of CREDENTIAL_VARS) e.env[v] = `planted-${v}`;
  e.env.CLAUDE_CODE_USE_BEDROCK = '1';
  e.env.CLAUDE_CODE_USE_VERTEX = '1';
  e.env.CLAUDE_CODE_USE_FOUNDRY = '1';
  e.env.TRIQUAL_EVAL_ARM = 's1/a';
  try {
    const r = await run(e, ['--experiment', 's1']);
    assert.equal(r.code, 0, r.err);
    const seen = calls(e);
    assert.equal(seen.length, 2);
    for (const c of seen) {
      assert.equal(c.env[FIRST_VAR], SECRET_ONE);
      for (const n of WATCHED.filter((w) => w !== FIRST_VAR)) assert.equal(c.env[n], null, `${n} is not in the child environment`);
    }
    for (const arm of ['a', 'b']) {
      const doc = JSON.parse(readFileSync(e.armFile('s1', arm), 'utf8'));
      assert.equal(doc.auth, 'first');
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test("a limited suite run is run again on the next entry and only that run's file is written", async () => {
  assert.equal(suiteLimited(FIXTURE), false);
  const authFailed = structuredClone(FIXTURE);
  authFailed.partial = true;
  authFailed.cases[0].arms.with[0].error = 'exit 1: Failed to authenticate. API Error: 401 Invalid bearer token';
  assert.equal(suiteLimited(authFailed), false);
  const withLimited = structuredClone(FIXTURE);
  withLimited.cases[1].arms.with[0].error = "You've hit your 5-hour limit · resets 8:30am";
  assert.equal(suiteLimited(withLimited), true);
  const withoutLimited = structuredClone(FIXTURE);
  withoutLimited.cases[0].arms.without = [{ error: 'Credit balance is too low' }];
  assert.equal(suiteLimited(withoutLimited), true);

  const e = fixture({
    chain: [
      { name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
      { name: 'two', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_TWO } },
    ],
    mode: 'limit-first',
  });
  e.env.FAKE_FIRST = SECRET_ONE;
  try {
    const r = await run(e, ['--experiment', 's1']);
    assert.equal(r.code, 0, r.err);
    const seen = calls(e);
    assert.deepEqual(seen.map((c) => c.env[FIRST_VAR]), [SECRET_ONE, SECRET_TWO, SECRET_TWO]);
    assert.equal(existsSync(join(seen[0].outDir, 'limited-marker.txt')), false, 'limited output dir was removed');
    const written = readdirSync(join(e.evals, 'skill-runs', 's1')).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(written, ['a.json', 'b.json']);
    for (const arm of ['a', 'b']) {
      const doc = JSON.parse(readFileSync(e.armFile('s1', arm), 'utf8'));
      assert.equal(doc.auth, 'two');
      assert.deepEqual(doc.units, toUnits(FIXTURE));
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('every entry limited: exit 1 and no arm file', async () => {
  const e = fixture({
    chain: [
      { name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
      { name: 'two', env: { ANTHROPIC_API_KEY: SECRET_TWO } },
    ],
    mode: 'limit-all',
  });
  try {
    const r = await run(e, ['--experiment', 's1']);
    assert.equal(r.code, 1);
    assert.equal(existsSync(e.armFile('s1', 'a')), false);
    assert.equal(existsSync(e.armFile('s1', 'b')), false);
    assert.match(r.err, /one/);
    assert.match(r.err, /two/);
    for (const c of calls(e)) {
      assert.equal(existsSync(join(c.outDir, 'limited-marker.txt')), false);
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('a suite with a non-limit API error is not scored: exit 1, no arm file, only the entry name and the count in the output', async () => {
  const AUTH_TEXT = J('exit 1: Failed to authenticate. API Error: 401', 'acct', 'detail@example.invalid');
  const e = fixture({
    chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } }],
    mode: 'auth-error',
  });
  e.env.FAKE_ERROR_TEXT = AUTH_TEXT;
  try {
    const r = await run(e, ['--experiment', 's1']);
    assert.equal(r.code, 1);
    assert.equal(existsSync(e.armFile('s1', 'a')), false);
    assert.equal(existsSync(e.armFile('s1', 'b')), false);
    assert.match(r.err, /one/);
    assert.match(r.err, /1 run/);
    assert.equal(calls(e).length, 1);
    const everything = r.out + r.err;
    assert.equal(everything.includes('Failed to authenticate'), false);
    assert.equal(everything.includes('acct'), false);
    assert.equal(everything.includes(SECRET_ONE), false);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('suiteErrors counts the runs with a non-null error that is not a limit', () => {
  assert.equal(suiteErrors(FIXTURE), 0);
  const agg = structuredClone(FIXTURE);
  agg.cases[0].arms.with[0].error = 'exit 1: Failed to authenticate. API Error: 401';
  agg.cases[1].arms.without = [{ passed: false, error: 'API Error: 500' }];
  assert.equal(suiteErrors(agg), 2);
  agg.cases[0].arms.with[0].error = "You've hit your 5-hour limit · resets 8:30am";
  assert.equal(suiteErrors(agg), 1);
});

test('a paid entry is skipped without --paid and used with it', async () => {
  const e = fixture({
    chain: [{ name: 'paid-one', env: { ANTHROPIC_API_KEY: SECRET_ONE }, paid: true }],
  });
  try {
    const skipped = await run(e, ['--experiment', 's1']);
    assert.equal(skipped.code, 1);
    assert.equal(calls(e).length, 0);
    assert.equal(existsSync(e.armFile('s1', 'a')), false);
    assert.equal(existsSync(e.armFile('s1', 'b')), false);
    assert.equal((skipped.out + skipped.err).includes(PAID_NOTE), true);

    const used = await run(e, ['--experiment', 's1', '--paid']);
    assert.equal(used.code, 0, used.err);
    assert.equal(calls(e).length, 2);
    for (const c of calls(e)) assert.equal(c.env[SECOND_VAR], SECRET_ONE);
    for (const arm of ['a', 'b']) {
      const doc = JSON.parse(readFileSync(e.armFile('s1', arm), 'utf8'));
      assert.equal(doc.auth, 'paid-one');
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('the fixture secret is in no output', async () => {
  const e = fixture({
    chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } }],
  });
  try {
    const ok = await run(e, ['--experiment', 's1']);
    assert.equal(ok.code, 0, ok.err);
    const filesText = ['a', 'b'].map((arm) => readFileSync(e.armFile('s1', arm), 'utf8')).join('\n');
    const everything = ok.out + ok.err + filesText;
    assert.equal(everything.includes(SECRET_ONE), false);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }

  const eLimit = fixture({
    chain: [
      { name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
      { name: 'two', env: { ANTHROPIC_API_KEY: SECRET_TWO } },
    ],
    mode: 'limit-all',
  });
  try {
    const lim = await run(eLimit, ['--experiment', 's1']);
    assert.equal(lim.code, 1);
    assert.equal((lim.out + lim.err).includes(SECRET_ONE), false);
    assert.equal((lim.out + lim.err).includes(SECRET_TWO), false);
  } finally { rmSync(eLimit.dir, { recursive: true, force: true }); }
});
