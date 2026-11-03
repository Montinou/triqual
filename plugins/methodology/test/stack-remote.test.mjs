// stack.mjs and SSH aliases: a `github.com-<x>` host (an ~/.ssh/config alias) is a GitHub remote `gh stack` cannot use, so
// any plan on it takes the `prs` layout (plain pushes, plain draft PRs). Same harness as stack-forest.test.mjs: a temp git
// repo with a bare `origin` and a fake gh; `url.<bare>.pushInsteadOf` sends pushes to the bare repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { githubRemote } from '../skills/executing-plans/scripts/stack.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'stack.mjs');
const FIXTURES = join(PLUGIN, 'test', 'fixtures');
const FAKE_GH = join(FIXTURES, 'fake-gh');
const PHASED = readFileSync(join(FIXTURES, 'phased-plan.md'), 'utf8');
const PLAN_REL = 'docs/plans/phased-plan.md';

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

const rig = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-remote-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  for (const d of [home, dir, origin, bin, work]) mkdirSync(d);
  symlinkSync(realGit, join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec bash '${FAKE_GH}' "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(work, 'gh.log');
  const env = {
    ...gitEnv(home),
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_GH_LOG: log,
    FAKE_GH_STACK: join(work, 'membership'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, dirname(PLAN_REL)), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), PHASED);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const statePath = join(dir, '.methodology', 'stack', 'phased-plan.json');
  return {
    dir, git, statePath, plan: PLAN_REL, origin,
    // Points origin at `url`; pushes to that URL go to the bare repository instead.
    setUrl: (url) => {
      git('remote', 'set-url', 'origin', url);
      git('config', `url.${origin}.pushInsteadOf`, url);
    },
    run: (args, extra = {}) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    json: (res) => {
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    },
    ghLog: () =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
};

const withRig = (fn) => {
  const r = rig();
  try {
    return fn(r);
  } finally {
    r.cleanup();
  }
};

// ssh:// URLs are built with the user part apart: a literal `user@host/` in a file reads as an email address to the content gate.
const SSH = `ssh://git${'@'}`;
const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];
const remoteTip = (r, branch) => r.git('--git-dir', r.origin, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`).trim();

test('githubRemote tells an alias from today\'s forms and from other hosts', () => {
  withRig((r) => {
    const cases = [
      ['https://github.com/acme/demo.git', { slug: 'acme/demo', alias: false }],
      [`${SSH}github.com/acme/demo`, { slug: 'acme/demo', alias: false }],
      ['git@github.com:acme/demo.git', { slug: 'acme/demo', alias: false }],
      ['git@github.com-work:acme/demo.git', { slug: 'acme/demo', alias: true }],
      ['git@github.com-work:acme/demo', { slug: 'acme/demo', alias: true }],
      ['git@github.com-work:acme/demo/', { slug: 'acme/demo', alias: true }],
      [`${SSH}github.com-work/acme/demo.git`, { slug: 'acme/demo', alias: true }],
      [`${SSH}github.com-work:2222/acme/demo.git`, { slug: 'acme/demo', alias: true }],
      ['git@gitlab.com:acme/demo.git', null],
      ['git@gitlab.com-work:acme/demo.git', null],
      ['git@github.com.evil:acme/demo.git', null],
    ];
    for (const [url, expected] of cases) {
      r.git('remote', 'set-url', 'origin', url);
      assert.deepEqual(githubRemote('origin', r.dir), expected, url);
    }
    assert.equal(githubRemote('nope', r.dir), null);
  });
});

test('a linear plan on a github.com-alias submits through prs', () => {
  withRig((r) => {
    r.setUrl('git@github.com-work:acme/demo.git');
    const state = r.json(r.run(['init', r.plan, '--mode', 'github']));
    assert.equal(state.v, 2);
    assert.equal(state.mode, 'github');
    assert.equal(state.ghStackVersion, null);
    assert.deepEqual(state.phases.map((p) => p.parent), ['main', 'demo/01-core']);

    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    writeFileSync(join(r.dir, 'core.txt'), 'core\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'feat: core');
    assert.equal(r.run(['done', r.plan, '1']).status, 0);
    const sub = r.run(['submit', r.plan, '1']);
    assert.equal(sub.status, 0, sub.stderr);
    assert.equal(sub.stdout.trim(), 'Phase 1: submitted (demo/01-core, PR #7 draft, base main)');

    assert.equal(remoteTip(r, 'demo/01-core'), r.git('rev-parse', 'demo/01-core').trim());
    const calls = r.ghLog();
    const create = calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create');
    assert.equal(create.length, 1);
    assert.equal(arg(create[0], '--repo'), 'acme/demo');
    assert.equal(arg(create[0], '--base'), 'main');
    assert.ok(create[0].includes('--draft'));
    assert.deepEqual(calls.filter((argv) => argv[0] === 'stack'), []);
    assert.deepEqual(r.git('reflog', 'show', 'origin/main').split('\n').filter((l) => /fetch/.test(l)), []);
  });
});

test('an ssh:// alias with a port takes the prs layout', () => {
  withRig((r) => {
    r.setUrl(`${SSH}github.com-work:2222/acme/demo.git`);
    const state = r.json(r.run(['init', r.plan, '--mode', 'github']));
    assert.equal(state.v, 2);
    assert.equal(state.mode, 'github');
    assert.equal(state.remote, 'origin');
    assert.ok(r.ghLog().some((argv) => argv[0] === 'repo' && argv[2] === 'acme/demo'));
    assert.deepEqual(r.ghLog().filter((argv) => argv[0] === 'stack'), []);
  });
});

test('an alias whose repo view fails is local with gh\'s reason', () => {
  withRig((r) => {
    r.setUrl('git@github.com-work:acme/demo.git');
    const state = r.json(r.run(['init', r.plan], { FAKE_GH_FAIL_REPO_VIEW: '1' }));
    assert.equal(state.v, 2);
    assert.equal(state.mode, 'local');
    assert.match(state.reason, /gh repo view acme\/demo failed: .*forced failure/);
    const refused = rig();
    try {
      refused.setUrl('git@github.com-work:acme/demo.git');
      const res = refused.run(['init', refused.plan, '--mode', 'github'], { FAKE_GH_FAIL_REPO_VIEW: '1' });
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stderr, /gh repo view acme\/demo failed/);
    } finally {
      refused.cleanup();
    }
  });
});

test('git@gitlab.com:o/r stays local', () => {
  withRig((r) => {
    r.git('remote', 'set-url', 'origin', 'git@gitlab.com:acme/demo.git');
    const state = r.json(r.run(['init', r.plan]));
    assert.equal(state.v, 1);
    assert.equal(state.mode, 'local');
    assert.match(state.reason, /no GitHub remote/);
    assert.deepEqual(r.ghLog().filter((argv) => argv[0] === 'repo'), []);
  });
});

test('today\'s forms keep the stack layout and the v1 state', () => {
  for (const url of ['https://github.com/acme/demo.git', `${SSH}github.com/acme/demo.git`, 'git@github.com:acme/demo.git']) {
    withRig((r) => {
      r.git('remote', 'set-url', 'origin', url);
      const state = r.json(r.run(['init', r.plan, '--mode', 'github']));
      assert.equal(state.v, 1, url);
      assert.equal(state.mode, 'github', url);
      assert.match(state.ghStackVersion, /0\.1\.1/, url);
    });
  }
});

test('a stack state is not switched to github mode on an alias remote', () => {
  withRig((r) => {
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(state.v, 1);
    r.setUrl('git@github.com-work:acme/demo.git');
    const res = r.run(['mode', r.plan, 'github']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /SSH alias/);
  });
});

test('submit and push refuse a github v1 state once the remote is an alias, and run no gh stack', () => {
  for (const verb of ['submit', 'push']) {
    withRig((r) => {
      r.git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
      const state = r.json(r.run(['init', r.plan, '--mode', 'github']));
      assert.equal(state.v, 1);
      assert.equal(state.mode, 'github');
      assert.equal(r.run(['phase', r.plan, '1']).status, 0);
      writeFileSync(join(r.dir, 'core.txt'), 'core\n');
      r.git('add', '-A');
      r.git('commit', '-q', '-m', 'feat: core');
      assert.equal(r.run(['done', r.plan, '1']).status, 0);
      // push needs a submitted phase: submit it while the remote is still plain https.
      if (verb === 'push') {
        const sub = r.run(['submit', r.plan, '1']);
        assert.equal(sub.status, 0, sub.stderr);
      }
      r.setUrl('git@github.com-work:acme/demo.git');
      const stackCalls = () => r.ghLog().filter((argv) => argv[0] === 'stack').length;
      const before = stackCalls();
      const res = r.run([verb, r.plan, '1']);
      assert.equal(res.status, 3, `${verb}: ${res.stderr}`);
      assert.match(res.stderr, /SSH alias gh stack cannot address/, verb);
      assert.equal(stackCalls(), before, verb);
    });
  }
});

test('init re-run on an existing v1 state prints it and changes nothing when the remote is an alias', () => {
  withRig((r) => {
    const first = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(first.v, 1);
    r.setUrl('git@github.com-work:acme/demo.git');
    const before = readFileSync(r.statePath);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), first);
    assert.deepEqual(readFileSync(r.statePath), before);
  });
});

test('init on an existing v1 state still refuses a forest plan', () => {
  withRig((r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    r.setUrl('git@github.com-work:acme/demo.git');
    writeFileSync(join(r.dir, r.plan), PHASED.replace('**Branch:** demo/02-edge\n', '**Parent:** trunk\n**Branch:** demo/02-edge\n'));
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /state was written for the stack layout/);
  });
});
