import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../cli/eval-replay.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { LIMIT_NOTE } from '../cli/lib/eval-auth.mjs';
import { ensureDir } from '../cli/lib/eval-paths.mjs';
import { casesDir, resolveCheckout, roleVersion } from '../cli/lib/eval-replay-harvest.mjs';
import { RESULTS_FILE } from '../cli/lib/eval-replay-run.mjs';

const SENTINEL_PROMPT_TEXT = 'zz-replay-prompt-sentinel';
const ROLE = 'tdd-implementer';

let base;
let env;

// One main transcript with one dispatch of the role and no subagent transcript: harvest finds it and excludes it, so the
// command runs without any git or test command. NODE_TEST_CONTEXT is dropped from the env (a nested `node --test` under
// it would exit 0 without running anything).
before(() => {
  base = mkdtempSync(join(tmpdir(), 'cm-replay-cli-'));
  const root = join(base, 'projects');
  mkdirSync(join(root, 'proj'), { recursive: true });
  const line = {
    type: 'assistant',
    timestamp: '2026-11-20T10:00:00Z',
    cwd: join(base, 'work'),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_X', name: 'Agent', input: { subagent_type: `roles:${ROLE}`, description: 'Task 1: x', prompt: SENTINEL_PROMPT_TEXT } }],
    },
  };
  writeFileSync(join(root, 'proj', 'sess.jsonl'), `${JSON.stringify(line)}\n`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  env = {
    ...inherited,
    HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'config'),
    TRIQUAL_TRANSCRIPTS_DIR: root,
    TRIQUAL_EVALS_DIR: join(base, 'evals'),
    ROLE_EVAL_FILE: join(base, 'none.jsonl'),
  };
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

async function run(argv, over = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { env: { ...env, ...over }, cwd: base, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

async function evalHelp() {
  let out = '';
  await evalMain([], { env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  return out;
}

test('eval lists replay', async () => { assert.match(await evalHelp(), /^\s+replay\s+\S/m); });

test('harvest prints counts only', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-19']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^tdd-implementer: dispatches \d+, cases kept \d+/);
  assert.equal(r.out, 'tdd-implementer: dispatches 1, cases kept 0; excluded no-subagent-transcript 1\n');
  assert.ok(!r.out.includes(SENTINEL_PROMPT_TEXT));
  assert.ok(!r.err.includes(SENTINEL_PROMPT_TEXT));
});

test('harvest --json', async () => {
  const j = JSON.parse((await run(['harvest', '--role', ROLE, '--since', '2026-11-19', '--json'])).out);
  assert.deepEqual(Object.keys(j), ['role', 'found', 'kept', 'excluded']);
  assert.equal(j.found, 1);
  assert.equal(j.excluded['no-subagent-transcript'], 1);
});

test('--since after the dispatch finds nothing', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-21T00:00:00Z']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'tdd-implementer: dispatches 0, cases kept 0\n');
});

test('a bad --since is a usage error', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', 'not-a-date']);
  assert.equal(r.code, 2);
  assert.ok(!r.out);
});

test('an unknown role is a usage error', async () => {
  assert.equal((await run(['harvest', '--role', 'spec-reviewer'])).code, 2);
  assert.equal((await run(['harvest'])).code, 2);
});

test('an invalid replay-repos file is a usage error', async () => {
  mkdirSync(join(base, 'config', 'triqual'), { recursive: true });
  writeFileSync(join(base, 'config', 'triqual', 'replay-repos.json'), '{ not json');
  try {
    const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-19']);
    assert.equal(r.code, 2);
    assert.match(r.err, /replay-repos file/);
  } finally {
    rmSync(join(base, 'config'), { recursive: true, force: true });
  }
});

test('no action or an unknown action prints usage and exits 2', async () => {
  for (const argv of [[], ['run'], ['harvest', '--bogus']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /usage:/);
  }
});

test('--help documents harvest', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /harvest --role <R> \[--since <ISO/);
  assert.match(r.out, /validation-failed/);
});

describe('replay run', () => {
  const TOK = 'tok-a';
  const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1];
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ model, argv }) + '\\n');
if (process.env.STUB_MODE === 'limit') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your limit" }));
} else {
  fs.writeFileSync('src/b.mjs', 'export function mul(a, b) { return a * b; }\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.5, modelUsage: { ['claude-' + model + '-5-0']: {} } }));
}
`;

  let tmp;
  let home;
  let evals;
  let repo;
  let baseCommit;
  let originalCommit;
  let stubBin;
  let stubLogFile;
  let chainFile;
  let runEnv;
  let version;

  function git(cwd, ...args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  }

  function commitAll(cwd, msg) {
    git(cwd, 'add', '-A');
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD').trim();
  }

  function writeRepoFile(cwd, rel, body) {
    const full = join(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  function addCase(id, literalsUnnamed = 0) {
    const dir = join(casesDir(evals), id);
    ensureDir(dir);
    writeFileSync(join(dir, 'case.json'), JSON.stringify({
      v: 1,
      id,
      role: ROLE,
      roleVersion: version.sha,
      repo,
      repoName: 'app',
      base: baseCommit,
      original: originalCommit,
      prompt: `Implement mul in {{WORK}} (${SENTINEL_PROMPT_TEXT}).`,
      hiddenTests: ['test/b.test.mjs'],
      supportFiles: [],
      testCommand: 'node --test test/b.test.mjs',
      originalUsd: 1,
      literalsUnnamed,
      validated: true,
    }));
  }

  const stubLog = () => (existsSync(stubLogFile)
    ? readFileSync(stubLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);

  async function runCmd(argv, { over = {}, spawn } = {}) {
    let out = '';
    let err = '';
    const code = await main(argv, {
      env: { ...runEnv, ...over },
      cwd: tmp,
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      ...(spawn ? { spawn } : {}),
    });
    return { code, out, err };
  }

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cm-replay-run-cli-'));
    home = join(tmp, 'home');
    evals = join(tmp, 'evals');
    const configDir = join(tmp, 'config', 'triqual');
    const pluginDir = join(tmp, 'plugin');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'methodology@triqual': [{ scope: 'user', installPath: pluginDir, version: '1.0.0' }] },
    }));
    writeFileSync(join(configDir, 'replay-repos.json'), JSON.stringify({
      app: { setup: 'true', timeoutSeconds: 10 },
    }));
    writeFileSync(join(configDir, 'experiments.json'), JSON.stringify({
      experiments: [
        {
          id: 'tdd-x',
          kind: 'role',
          status: 'active',
          control: 'sonnet-high',
          arms: {
            'sonnet-high': { role: ROLE, model: 'sonnet', effort: 'high' },
            'haiku-high': { role: ROLE, model: 'haiku', effort: 'high' },
          },
          margin: 0.1,
          objective: 'cost',
          evaluators: 'objective',
        },
        {
          id: 'tdd-done',
          kind: 'role',
          status: 'done',
          control: 'sonnet-high',
          arms: {
            'sonnet-high': { role: ROLE, model: 'sonnet', effort: 'high' },
            'haiku-high': { role: ROLE, model: 'haiku', effort: 'high' },
          },
          margin: 0.1,
          objective: 'cost',
          evaluators: 'objective',
        },
      ],
    }));

    repo = join(tmp, 'app');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeRepoFile(repo, 'src/a.mjs', 'export function add(a, b) { return a + b; }\n');
    baseCommit = commitAll(repo, 'feat: a');
    writeRepoFile(repo, 'src/b.mjs', 'export function mul(a, b) { return a * b; }\n');
    writeRepoFile(repo, 'test/b.test.mjs', [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { mul } from '../src/b.mjs';",
      "test('mul', () => { assert.equal(mul(2, 3), 6); });",
      '',
    ].join('\n'));
    originalCommit = commitAll(repo, 'feat: b');

    stubBin = join(tmp, 'claude-stub');
    writeFileSync(stubBin, STUB);
    chmodSync(stubBin, 0o755);
    stubLogFile = join(tmp, 'stub.log');

    chainFile = join(tmp, 'chain.json');
    writeFileSync(chainFile, JSON.stringify({
      chain: [{ name: 'acct-a', env: { CLAUDE_CODE_OAUTH_TOKEN: TOK } }],
    }));
    writeFileSync(join(home, 'paid-chain.json'), JSON.stringify({
      chain: [{ name: 'paid-a', paid: true, env: { ANTHROPIC_API_KEY: TOK } }],
    }));

    const checkout = resolveCheckout({ cwd: process.cwd() });
    version = roleVersion(ROLE, checkout);

    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    runEnv = {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: join(tmp, 'config'),
      TRIQUAL_EVALS_DIR: evals,
      TRIQUAL_CLAUDE_BIN: stubBin,
      STUB_LOG: stubLogFile,
    };
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    rmSync(evals, { recursive: true, force: true });
    rmSync(stubLogFile, { force: true });
    addCase('case-a', 0);
    addCase('case-b', 1);
  });

  test('run --dry-run prints the sample and the estimate and spawns nothing', async () => {
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sample 2 cases: app 2$/m);
    assert.match(r.out, /^runs 4$/m);
    assert.match(r.out, /^estimate sonnet-high \d+\.\d{2} USD$/m);
    assert.match(r.out, /^estimate haiku-high \d+\.\d{2} USD$/m);
    assert.equal(stubLog().length, 0);
  });

  test('run refuses an arm with no chain file before any spawn', async () => {
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--auth', `haiku-high=${join(tmp, 'none.json')}`]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no credential chain file/);
    assert.equal(stubLog().length, 0);
  });

  test('run prints per-arm counts and never the prompt', async () => {
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--auth', `haiku-high=${chainFile}`, '--auth', `sonnet-high=${chainFile}`]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sonnet-high {2}counted 2 {2}passes 2 {2}usd 1\.00 {2}accounts acct-a 2 {2}unnamed-literals 1\/1 {2}rest 1\/1$/m);
    assert.match(r.out, /^haiku-high {2}counted 2 {2}passes 2 {2}usd 1\.00 {2}accounts acct-a 2 {2}unnamed-literals 1\/1 {2}rest 1\/1$/m);
    assert.ok(!r.out.includes(SENTINEL_PROMPT_TEXT));
    assert.ok(!r.err.includes(SENTINEL_PROMPT_TEXT));
    assert.ok(!r.out.includes(TOK));
    assert.ok(!r.err.includes(TOK));
    assert.ok(existsSync(join(evals, RESULTS_FILE)));
  });

  test('--auth for an unknown arm is a usage error; --help documents run', async () => {
    assert.equal((await runCmd(['run', '--experiment', 'tdd-x', '--auth', 'opus-max=/x'])).code, 2);
    const help = await runCmd(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /run --experiment <id> \[--sample <n>\]/);
    assert.match(help.out, /replay\/results\.jsonl/);
    assert.match(help.out, /--concurrency/);
    assert.match(help.out, /--paid/);
    assert.match(help.out, /--dry-run/);
  });

  test('run refuses when methodology plugin is not installed before any spawn', async () => {
    const emptyHome = join(tmp, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--auth', `haiku-high=${chainFile}`, '--auth', `sonnet-high=${chainFile}`], {
      over: { HOME: emptyHome },
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /methodology plugin/i);
    assert.equal(stubLog().length, 0);
  });

  test('run expands ~/ in --auth and enforces --paid', async () => {
    const refused = await runCmd(['run', '--experiment', 'tdd-x', '--sample', '1', '--auth', 'haiku-high=~/paid-chain.json', '--auth', 'sonnet-high=~/paid-chain.json']);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /--paid/);
    assert.equal(stubLog().length, 0);

    const ok = await runCmd(['run', '--experiment', 'tdd-x', '--sample', '1', '--paid', '--auth', 'haiku-high=~/paid-chain.json', '--auth', 'sonnet-high=~/paid-chain.json']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /^haiku-high {2}counted 1 {2}passes 1/m);
    assert.match(ok.out, /accounts paid-a 1/);
  });

  test('run exits 1 with LIMIT_NOTE on ChainExhausted', async () => {
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--sample', '1', '--auth', `haiku-high=${chainFile}`, '--auth', `sonnet-high=${chainFile}`], {
      over: { STUB_MODE: 'limit' },
    });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(LIMIT_NOTE), r.err);
  });

  test('run maps a bad experiment to exit 2 without a stack trace', async () => {
    const doneExp = await runCmd(['run', '--experiment', 'tdd-done', '--dry-run']);
    assert.equal(doneExp.code, 2);
    assert.match(doneExp.err, /experiment tdd-done:/);
    assert.ok(!/\n\s+at\s/.test(doneExp.err));

    const missingExp = await runCmd(['run', '--experiment', 'no-such-exp', '--dry-run']);
    assert.equal(missingExp.code, 2);
  });

  test('run aborts with exit 1 when claude bin cannot start', async () => {
    const r = await runCmd(['run', '--experiment', 'tdd-x', '--sample', '1', '--auth', `haiku-high=${chainFile}`, '--auth', `sonnet-high=${chainFile}`], {
      spawn: async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /the agent could not be started:/);
  });

  test('run rejects invalid flags with exit 2', async () => {
    for (const argv of [
      ['run', '--experiment', 'tdd-x', '--sample', '0'],
      ['run', '--experiment', 'tdd-x', '--runs', 'abc'],
      ['run', '--experiment', 'tdd-x', '--seed', '-1'],
      ['run', '--experiment', 'tdd-x', '--concurrency', '0'],
      ['run', '--experiment', 'tdd-x', '--auth', 'noequals'],
      ['run', '--experiment', 'tdd-x', '--bogus'],
    ]) {
      const r = await runCmd(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.doesNotMatch(r.err, /unknown action/);
    }
  });
});
