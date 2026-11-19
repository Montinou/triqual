import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_VARS, PAID_NOTE } from '../cli/lib/eval-auth.mjs';
import { runSuite } from '../cli/lib/eval-skills.mjs';
import { SUMMARY, main } from '../cli/eval-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = join(HERE, 'fixtures', 'plugin-eval', 'aggregate-result.json');

// Fixture secrets are built at run time so no secret-looking literal sits in the source.
const J = (...p) => p.join('-');
const SECRET_ONE = J('fixture', 'first', 'token', '0123456789');
const SECRET_TWO = J('fixture', 'second', 'token', '9876543210');
const FIRST_VAR = CREDENTIAL_VARS[0];

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evcases-'));

// The fake `claude`: answers each spawn with an aggregate holding the one case named by `--case`, built from the fixture
// aggregate (a case the fixture does not hold is a copy of its first case under that name). FAKE_RUNS maps a case name to
// the list of its runs' verdicts. The log keeps the argv, the output directory and whether stdin was closed.
const FAKE = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const e = process.env;
const outIdx = argv.indexOf('--output-dir');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
const caseIdx = argv.indexOf('--case');
const caseName = caseIdx >= 0 ? argv[caseIdx + 1] : null;
appendFileSync(e.FAKE_LOG, JSON.stringify({ argv, outDir, cred: e.CLAUDE_CODE_OAUTH_TOKEN ?? null }) + '\\n');
const mode = e.FAKE_MODE || 'ok';
if (outDir && mode !== 'no-aggregate') {
  mkdirSync(outDir, { recursive: true });
  const doc = JSON.parse(readFileSync(e.FAKE_FIXTURE, 'utf8'));
  let c = doc.cases.find((x) => x.name === caseName);
  if (!c) { c = structuredClone(doc.cases[0]); c.name = caseName; }
  const verdicts = JSON.parse(e.FAKE_RUNS || '{}')[caseName];
  if (verdicts) {
    c.arms.with = verdicts.map((passed) => ({ ...c.arms.with[0], passed, score: passed ? 1 : 0 }));
  }
  if (mode === 'auth-error') {
    c.arms.with[0].passed = false;
    c.arms.with[0].error = e.FAKE_ERROR_TEXT;
  }
  if (mode === 'limit-first' && e.CLAUDE_CODE_OAUTH_TOKEN === e.FAKE_FIRST) {
    for (const r of c.arms.with) { r.passed = false; r.error = "You've hit your 5-hour limit · resets 8:30am"; }
    writeFileSync(join(outDir, 'limited-marker.txt'), 'limited');
  }
  doc.cases = [c];
  writeFileSync(join(outDir, 'aggregate-result.json'), JSON.stringify(doc));
  process.exit(1);
}
process.exit(1);
`;

const CASE_YAML = (scaffoldLine) => `schema_version: 1
name: scaffolded
${scaffoldLine}
execution:
  prompt: Say hello.
  max_turns: 3
  allowed_tools: [Bash]
  timeout_seconds: 300
runs: 1
graders:
  - type: llm
    name: criteria
    criteria: The reply greets.
    weight: 1
`;

function fixture({ chain, mode } = {}) {
  const dir = tmp();
  const plugin = join(dir, 'plugin');
  const cases = join(plugin, 'evals', 'cases');
  for (const name of ['probe-case', 'second-case']) {
    mkdirSync(join(cases, name), { recursive: true });
    writeFileSync(join(cases, name, 'prompt.md'), `---\nmax_turns: 3\n---\nSay ${name}.\n`);
  }
  mkdirSync(join(cases, 'scaffolded'), { recursive: true });
  writeFileSync(join(cases, 'scaffolded', 'case.yaml'), CASE_YAML('context:\n  scaffold_script: scaffold.sh'));
  writeFileSync(join(cases, 'scaffolded', 'scaffold.sh'), '#!/bin/sh\ntrue\n');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
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
    TRIQUAL_EVAL_AUTH_FILE: authFile,
    TRIQUAL_CLAUDE_BIN: bin,
    FAKE_LOG: log,
    FAKE_FIXTURE: FIXTURE_FILE,
  };
  if (mode) env.FAKE_MODE = mode;
  return { dir, plugin, cases, env, log };
}

const calls = (e) => readFileSync(e.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Every path under `root`, relative and sorted.
function listing(root) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      out.push(relative(root, p));
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

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

const todayArgv = (pluginDir, outDir) => [
  'plugin', 'eval', pluginDir, '--eval-dir', 'evals/cases', '--ablation', 'none',
  '--output-dir', outDir, '--no-publish', '--judge-model', 'sonnet',
];

test('SUMMARY names the command', () => {
  assert.equal(SUMMARY, 'run named replay cases of a plugin once (cases)');
});

test('runSuite: the new options append to the argv in order, the scaffold flags last; the defaults leave it untouched', async () => {
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
    const base = { pluginDir: '/work/example/plugin-a', outDir, spawn, env: { PATH: '/bin' } };
    await runSuite(base);
    await runSuite({ ...base, runs: 3 });
    await runSuite({ ...base, caseName: 'probe-case' });
    await runSuite({ ...base, runs: 2, caseName: 'probe-case', scaffold: true });
    await runSuite({ ...base, scaffold: true });
    const today = todayArgv('/work/example/plugin-a', outDir);
    assert.deepEqual(spawned[0].args, today);
    assert.deepEqual(spawned[1].args, [...today, '--runs', '3']);
    assert.deepEqual(spawned[2].args, [...today, '--case', 'probe-case']);
    assert.deepEqual(spawned[3].args, [...today, '--runs', '2', '--case', 'probe-case', '--scaffold', '--allow-tools', 'Bash', 'Write', 'Edit']);
    assert.deepEqual(spawned[4].args, [...today, '--scaffold', '--allow-tools', 'Bash', 'Write', 'Edit']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one spawn per named case, each with a single --case', async () => {
  const e = fixture();
  try {
    const r = await run(e, ['--case', 'probe-case', '--case', 'second-case', '--runs', '2', e.plugin]);
    assert.equal(r.code, 1, r.err);
    const seen = calls(e);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((c) => c.argv.at(-1)), ['probe-case', 'second-case']);
    for (const c of seen) {
      assert.deepEqual(c.argv, [...todayArgv(e.plugin, c.outDir), '--runs', '2', '--case', c.argv.at(-1)]);
      assert.equal(c.argv.filter((a) => a === '--case').length, 1);
      assert.equal(c.outDir.startsWith(`${e.plugin}/`), false, 'the output directory is outside the plugin directory');
      assert.equal(existsSync(c.outDir), false, 'the output directory is gone after main returns');
      for (const flag of ['--trust-plugin', '--publish-report', '--paid']) assert.equal(c.argv.includes(flag), false);
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('the spawn options carry no input and the runs default to 3', async () => {
  const dir = tmp();
  try {
    const outDirs = [];
    const spawned = [];
    const spawn = async (bin, args, opts) => {
      spawned.push({ args, opts });
      const outDir = args[args.indexOf('--output-dir') + 1];
      outDirs.push(outDir);
      mkdirSync(outDir, { recursive: true });
      copyFileSync(FIXTURE_FILE, join(outDir, 'aggregate-result.json'));
      return { code: 0, stdout: '', stderr: '' };
    };
    const plugin = join(dir, 'plugin');
    mkdirSync(join(plugin, 'evals', 'cases', 'probe-case'), { recursive: true });
    let out = '';
    await main([plugin, '--case', 'probe-case'], {
      env: { HOME: dir, PATH: process.env.PATH, TRIQUAL_EVAL_AUTH_FILE: join(dir, 'none.json') },
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
      spawn,
    });
    assert.equal(spawned.length, 1);
    assert.equal(Object.hasOwn(spawned[0].opts, 'input'), false);
    assert.deepEqual(spawned[0].args.slice(-4), ['--runs', '3', '--case', 'probe-case']);
    assert.equal(existsSync(outDirs[0]), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no --case spawns once per case directory, sorted', async () => {
  const e = fixture();
  try {
    writeFileSync(join(e.cases, 'a-file.txt'), 'not a case');
    const r = await run(e, [e.plugin]);
    assert.equal(r.code, 1, r.err);
    assert.deepEqual(calls(e).map((c) => c.argv[c.argv.indexOf('--case') + 1]), ['probe-case', 'scaffolded', 'second-case']);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('--scaffold --allow-tools Bash Write Edit come last, only in the spawn of the scaffolded case', async () => {
  const e = fixture();
  const TAIL = ['--scaffold', '--allow-tools', 'Bash', 'Write', 'Edit'];
  try {
    await run(e, ['--case', 'probe-case', '--case', 'second-case', e.plugin]);
    for (const c of calls(e)) {
      assert.equal(c.argv.includes('--scaffold'), false);
      assert.equal(c.argv.includes('--allow-tools'), false);
    }
    writeFileSync(e.log, '');
    await run(e, ['--case', 'scaffolded', e.plugin]);
    let seen = calls(e);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].argv.slice(-TAIL.length), TAIL);
    assert.deepEqual(seen[0].argv.slice(-TAIL.length - 2, -TAIL.length), ['--case', 'scaffolded']);

    writeFileSync(e.log, '');
    await run(e, ['--case', 'probe-case', '--case', 'scaffolded', e.plugin]);
    seen = calls(e);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].argv.includes('--scaffold'), false);
    assert.deepEqual(seen[1].argv.slice(-TAIL.length), TAIL);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('a case.yaml whose only scaffold_script is in a comment or has no indent is not scaffolded', async () => {
  const e = fixture();
  try {
    const yamls = {
      commented: CASE_YAML('context:\n  # scaffold_script: scaffold.sh'),
      unindented: CASE_YAML('scaffold_script: scaffold.sh'),
      afterblank: CASE_YAML('context:\n  other: x\n\nscaffold_script: scaffold.sh'),
      emptyvalue: CASE_YAML('context:\n  scaffold_script:\n'),
    };
    for (const [name, text] of Object.entries(yamls)) {
      mkdirSync(join(e.cases, name), { recursive: true });
      writeFileSync(join(e.cases, name, 'case.yaml'), text);
    }
    const names = Object.keys(yamls);
    const r = await run(e, [...names.flatMap((n) => ['--case', n]), e.plugin]);
    assert.equal(r.code, 0, r.err);
    const seen = calls(e);
    assert.equal(seen.length, names.length);
    for (const c of seen) {
      assert.equal(c.argv.includes('--scaffold'), false, c.argv.at(-1));
      assert.equal(c.argv.includes('--allow-tools'), false);
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('exit 2 and no spawn for a glob, a path, a wrong-case or unknown name, a bad --runs, a missing plugin directory, an unknown flag', async () => {
  const e = fixture();
  try {
    const bad = [
      ['--case', '*', e.plugin],
      ['--case', 'probe-*', e.plugin],
      ['--case', 'a/b', e.plugin],
      ['--case', '..', e.plugin],
      ['--case', 'Probe-Case', e.plugin],
      ['--case', 'nope', e.plugin],
      ['--case', 'probe-case', '--runs', '0', e.plugin],
      ['--case', 'probe-case', '--runs', 'x', e.plugin],
      ['--case', 'probe-case'],
      [],
      ['--case', 'probe-case', '--bogus', e.plugin],
      ['--case', 'probe-case', '--case', 'nope', e.plugin],
    ];
    for (const argv of bad) {
      const r = await run(e, argv);
      assert.equal(r.code, 2, `expected exit 2 for ${JSON.stringify(argv)}: ${r.err}`);
    }
    assert.equal(calls(e).length, 0);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('prints one line per case and the total', async () => {
  const e = fixture();
  try {
    const r = await run(e, ['--case', 'probe-case', '--case', 'second-case', e.plugin]);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, 'probe-case pass 1/1 0.00\nsecond-case fail 0/1 0.00\n1 of 2 cases passed, 0.00 USD\n');

    e.env.FAKE_RUNS = JSON.stringify({ 'second-case': [true] });
    const ok = await run(e, ['--case', 'probe-case', '--case', 'second-case', e.plugin]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out, 'probe-case pass 1/1 0.00\nsecond-case pass 1/1 0.00\n2 of 2 cases passed, 0.00 USD\n');
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('a case with 1 of 3 runs passing fails and 2 of 3 passes', async () => {
  const e = fixture();
  try {
    e.env.FAKE_RUNS = JSON.stringify({ 'probe-case': [true, false, false], 'second-case': [false, true, true] });
    const r = await run(e, ['--case', 'probe-case', '--case', 'second-case', e.plugin]);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, 'probe-case fail 1/3 0.00\nsecond-case pass 2/3 0.01\n1 of 2 cases passed, 0.01 USD\n');
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('a run that ended on an API error is no verdict: exit 1, no line for that case, only the entry name and a count', async () => {
  const AUTH_TEXT = J('exit 1: Failed to authenticate. API Error: 401', 'acct', 'detail@example.invalid');
  const e = fixture({ chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } }], mode: 'auth-error' });
  e.env.FAKE_ERROR_TEXT = AUTH_TEXT;
  try {
    const r = await run(e, ['--case', 'probe-case', e.plugin]);
    assert.equal(r.code, 1);
    assert.equal(r.out.includes('probe-case'), false, 'no per-case line');
    assert.equal(r.out.includes('cases passed'), false);
    assert.match(r.err, /one/);
    assert.match(r.err, /1 run/);
    const everything = r.out + r.err;
    for (const text of ['Failed to authenticate', 'acct', SECRET_ONE, 'Say probe-case', 'Reply with exactly one line']) {
      assert.equal(everything.includes(text), false, `${text} is not printed`);
    }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('a usage limit moves to the next credential entry and that case runs again whole', async () => {
  const e = fixture({
    chain: [
      { name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
      { name: 'two', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_TWO } },
    ],
    mode: 'limit-first',
  });
  e.env.FAKE_FIRST = SECRET_ONE;
  try {
    const r = await run(e, ['--case', 'probe-case', '--case', 'second-case', e.plugin]);
    assert.equal(r.code, 1, r.err);
    const seen = calls(e);
    assert.deepEqual(seen.map((c) => c.cred), [SECRET_ONE, SECRET_TWO, SECRET_TWO]);
    assert.deepEqual(seen.map((c) => c.argv.at(-1)), ['probe-case', 'probe-case', 'second-case']);
    assert.equal(existsSync(join(seen[0].outDir, 'limited-marker.txt')), false);
    assert.equal(r.out, 'probe-case pass 1/1 0.00\nsecond-case fail 0/1 0.00\n1 of 2 cases passed, 0.00 USD\n');
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('every entry limited exits 1 and prints no case line; every entry paid says so', async () => {
  const e = fixture({
    chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } }, { name: 'two', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_TWO } }],
    mode: 'limit-first',
  });
  e.env.FAKE_FIRST = SECRET_ONE;
  try {
    // the fake limits the entry whose secret is FAKE_FIRST; both entries carry it
    writeFileSync(e.env.TRIQUAL_EVAL_AUTH_FILE, JSON.stringify({ chain: [
      { name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } }, { name: 'two', env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET_ONE } },
    ] }));
    const r = await run(e, ['--case', 'probe-case', e.plugin]);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /one/);
    assert.match(r.err, /two/);

    writeFileSync(e.env.TRIQUAL_EVAL_AUTH_FILE, JSON.stringify({ chain: [{ name: 'paid-one', env: { ANTHROPIC_API_KEY: SECRET_ONE }, paid: true }] }));
    writeFileSync(e.log, '');
    const paid = await run(e, ['--case', 'probe-case', e.plugin]);
    assert.equal(paid.code, 1);
    assert.equal(calls(e).length, 0);
    assert.equal(paid.err.includes(PAID_NOTE), true);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('no aggregate left exits 1, and nothing is written under the plugin directory', async () => {
  const e = fixture({ mode: 'no-aggregate' });
  try {
    const before = listing(e.plugin);
    const r = await run(e, ['--case', 'probe-case', e.plugin]);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /no aggregate/);
    assert.deepEqual(listing(e.plugin), before);

    const e2 = fixture();
    try {
      const before2 = listing(e2.plugin);
      await run(e2, [e2.plugin]);
      assert.deepEqual(listing(e2.plugin), before2);
    } finally { rmSync(e2.dir, { recursive: true, force: true }); }
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});

test('--help exits 0 and says the scaffold runs the case author\'s bash as you', async () => {
  const e = fixture();
  try {
    for (const flag of ['--help', '-h']) {
      const r = await run(e, [flag]);
      assert.equal(r.code, 0);
      assert.match(r.out, /--scaffold/);
      assert.match(r.out, /runs the case author's bash as you/);
      assert.match(r.out, /plugin directories you wrote/);
    }
    assert.equal(calls(e).length, 0);
  } finally { rmSync(e.dir, { recursive: true, force: true }); }
});
