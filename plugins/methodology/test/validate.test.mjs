// scripts/validate (spec 7.5): the CI verdict of a submitted phase, recorded in the ledger and the phase report. Every test runs the
// real script in a temp git repo with a bare remote and a submitted forest phase (same harness as stack-forest.test.mjs); the only
// stubs are the fake `gh` (`run list` answered from FAKE_GH_RUNS) and a `git` shim that sends `git fetch <remote> <branch>` to the bare
// repository, since the remote's URL is a GitHub one. The compare command is a real `sh -c` command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(PLUGIN, 'skills', 'executing-plans', 'scripts');
const STACK = join(SCRIPTS, 'stack.mjs');
const WORKSPACE = join(SCRIPTS, 'sdd-workspace');
const VALIDATE = join(SCRIPTS, 'validate');
const FIXTURES = join(PLUGIN, 'test', 'fixtures');
const FAKE_GH = join(FIXTURES, 'fake-gh');
const PLAN_REL = 'docs/plans/phased-plan.md';
const URL = (id) => `https://github.com/acme/demo/actions/runs/${id}`;
const COMPARE = 'echo "run=$TRIQUAL_RUN_ID slug=$TRIQUAL_REPO_SLUG cwd=$(pwd)"';

// The phased fixture as a forest (phase 2 starts at the trunk, so the `prs` layout); phase 1 validates with `ci.yml`.
const planWith = (validate) =>
  readFileSync(join(FIXTURES, 'phased-plan.md'), 'utf8')
    .replace('**Branch:** demo/02-edge\n', '**Parent:** trunk\n**Branch:** demo/02-edge\n')
    .replace('**PR title:** feat: core\n', `**PR title:** feat: core\n${validate === null ? '' : `**Validate:** ${validate}\n`}`);

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// A repo with a bare `origin` that has a GitHub URL (pushes and fetches go to the bare repository), phase 1 finished and submitted.
const rig = ({ plan, submit = true }) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'validate-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  for (const d of [home, dir, origin, bin, work]) mkdirSync(d);
  const fetchLog = join(work, 'fetch.log');
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = fetch ]; then',
      `  echo "$@" >> '${fetchLog}'`,
      `  exec '${realGit}' fetch -q '${origin}' "+refs/heads/$3:refs/remotes/$2/$3"`,
      'fi',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec bash '${FAKE_GH}' "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ghLog = join(work, 'gh.log');
  const runsFile = join(work, 'runs.json');
  const env = {
    ...gitEnv(home),
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_STACK: join(work, 'membership'),
    FAKE_GH_RUNS: runsFile,
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  execFileSync(realGit, ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, dirname(PLAN_REL)), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
  git('config', 'remote.origin.pushurl', origin);
  const stack = (...args) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env, encoding: 'utf8' });
  const ok = (res) => {
    assert.equal(res.status, 0, res.stderr);
    return res;
  };
  ok(stack('init', PLAN_REL, '--mode', 'github'));
  ok(stack('phase', PLAN_REL, '1'));
  writeFileSync(join(dir, 'core.txt'), 'core\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: core');
  ok(stack('done', PLAN_REL, '1'));
  if (submit) ok(stack('submit', PLAN_REL, '1'));
  return {
    dir, git, plan: PLAN_REL,
    workspace: () => ok(spawnSync(process.execPath, [WORKSPACE, PLAN_REL], { cwd: dir, env, encoding: 'utf8' })).stdout.trim(),
    remoteTip: (branch) => execFileSync(realGit, ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(),
    runs: (list) => writeFileSync(runsFile, JSON.stringify(list)),
    validate: (n, extra = {}) => spawnSync(process.execPath, [VALIDATE, PLAN_REL, String(n)], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    ghLog: () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    fetches: () => (existsSync(fetchLog) ? readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
};

const withRig = (opts, fn) => {
  const r = rig(opts);
  try {
    return fn(r);
  } finally {
    r.cleanup();
  }
};

const run = (id, status, conclusion) => ({ databaseId: id, status, conclusion, url: URL(id) });
const ledgerOf = (r) => {
  const file = join(r.workspace(), 'sdd-ledger.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const reportOf = (r) => readFileSync(join(r.workspace(), 'phase-1-report.md'), 'utf8');

test('clean: the compare command exits 0, the ledger and the report record it, exit 0', () => {
  withRig({ plan: planWith(`ci.yml compare=\`${COMPARE}\``) }, (r) => {
    // A newer run still in progress is skipped; the newest completed one is judged. A local commit not pushed is not what CI saw.
    r.git('commit', '-q', '--allow-empty', '-m', 'local only');
    const remote = r.remoteTip('demo/01-core');
    assert.notEqual(r.git('rev-parse', 'HEAD').trim(), remote);
    r.runs([run(5000, 'in_progress', ''), run(4242, 'completed', 'success'), run(4100, 'completed', 'failure')]);

    const res = r.validate(1);

    assert.equal(res.status, 0, res.stderr);
    const line = `Validation: P1 run 4242 verdict clean — ${URL(4242)}`;
    const report = join(r.workspace(), 'phase-1-report.md');
    assert.equal(res.stdout, `${line}\nreport: ${report}\n`);
    assert.ok(ledgerOf(r).split('\n').includes(line), 'the ledger lacks the Validation line');
    assert.match(reportOf(r), /^## Validation: run 4242 verdict clean$/m);
    assert.ok(reportOf(r).includes(`run=4242 slug=acme/demo cwd=${r.dir}`), reportOf(r));
    assert.deepEqual(r.fetches(), ['fetch origin demo/01-core']);
    const list = r.ghLog().find((argv) => argv[0] === 'run' && argv[1] === 'list');
    assert.deepEqual(list, [
      'run', 'list', '--repo', 'acme/demo', '--workflow', 'ci.yml', '--commit', remote,
      '--json', 'databaseId,status,conclusion,url', '--limit', '20',
    ]);
  });
});

test('failed: the compare command exits 1, verdict failed, exit 6', () => {
  withRig({ plan: planWith('ci.yml compare=`echo "2 findings differ from the reference"; exit 1`') }, (r) => {
    r.runs([run(4242, 'completed', 'success')]);

    const res = r.validate(1);

    assert.equal(res.status, 6, res.stderr);
    const line = `Validation: P1 run 4242 verdict failed — ${URL(4242)}`;
    assert.equal(res.stdout, `${line}\nreport: ${join(r.workspace(), 'phase-1-report.md')}\n`);
    assert.ok(ledgerOf(r).split('\n').includes(line));
    assert.match(reportOf(r), /^## Validation: run 4242 verdict failed$/m);
    assert.ok(reportOf(r).includes('2 findings differ from the reference'));
  });
});

test('without compare the run conclusion decides: failure is failed, exit 6', () => {
  withRig({ plan: planWith('ci.yml') }, (r) => {
    r.runs([run(4300, 'completed', 'failure')]);

    const res = r.validate(1);

    assert.equal(res.status, 6, res.stderr);
    assert.ok(ledgerOf(r).split('\n').includes(`Validation: P1 run 4300 verdict failed — ${URL(4300)}`));
    assert.ok(reportOf(r).includes('conclusion: failure'), reportOf(r));
  });
});

test('without compare a success conclusion is clean, exit 0', () => {
  withRig({ plan: planWith('ci.yml') }, (r) => {
    r.runs([run(4301, 'completed', 'success')]);

    const res = r.validate(1);

    assert.equal(res.status, 0, res.stderr);
    assert.ok(ledgerOf(r).split('\n').includes(`Validation: P1 run 4301 verdict clean — ${URL(4301)}`));
    assert.ok(reportOf(r).includes('conclusion: success'));
  });
});

test('no completed run yet: exit 3, nothing recorded', () => {
  withRig({ plan: planWith('ci.yml') }, (r) => {
    r.runs([run(5000, 'in_progress', '')]);
    const sha = r.remoteTip('demo/01-core');

    const res = r.validate(1);

    assert.equal(res.status, 3);
    assert.match(res.stderr, new RegExp(`no completed run of ci\\.yml for ${sha} yet`));
    assert.ok(!ledgerOf(r).includes('Validation:'), 'a retry-later refusal must not record a verdict');
    assert.ok(!existsSync(join(r.workspace(), 'phase-1-report.md')));
  });
});

test('a phase with no Validate field: exit 3', () => {
  withRig({ plan: planWith('ci.yml') }, (r) => {
    const res = r.validate(2);

    assert.equal(res.status, 3);
    assert.match(res.stderr, /phase 2 declares no validation/);
    assert.deepEqual(r.fetches(), []);
  });
});

test('a phase that is not submitted: exit 3', () => {
  withRig({ plan: planWith('ci.yml'), submit: false }, (r) => {
    const res = r.validate(1);

    assert.equal(res.status, 3);
    assert.match(res.stderr, /phase 1 is done: validate needs a submitted or ready phase/);
  });
});

test('usage: a bad phase number is exit 2', () => {
  withRig({ plan: planWith('ci.yml') }, (r) => {
    assert.equal(r.validate('x').status, 2);
    assert.equal(r.validate(9).status, 2);
  });
});
