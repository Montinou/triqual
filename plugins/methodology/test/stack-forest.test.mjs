// stack.mjs layouts: a linear plan keeps the v1 `stack` state and its gh stack calls; a forest plan is the `prs` layout,
// a v2 state with a parent per phase. Same harness as stack.test.mjs: a temp git repo with a bare `origin` and a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseLayout, parsePhases } from '../skills/executing-plans/scripts/stack.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'stack.mjs');
const FIXTURES = join(PLUGIN, 'test', 'fixtures');
const FAKE_GH = join(FIXTURES, 'fake-gh');
const PHASED = readFileSync(join(FIXTURES, 'phased-plan.md'), 'utf8');
const PLAN_REL = 'docs/plans/phased-plan.md';

// The phased fixture with a third phase: phase 2 starts at the trunk and phase 3 at phase 1, so the plan is a forest.
const FOREST = PHASED
  .replace('**Branch:** demo/02-edge\n', '**Parent:** trunk\n**Branch:** demo/02-edge\n')
  .replace(
    '## After Merge',
    `## Phase 3: Extra

**Slice:** S3
**Parent:** P1
**Branch:** demo/03-extra
**PR title:** feat: extra
**Stands alone because:** core only
**Phase check:** \`true\` → exit 0

### Task 4: Four

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do four.

## After Merge`,
  );

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

const rig = ({ withGh = true, plan = PHASED } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-forest-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  for (const d of [home, dir, origin, bin, work]) mkdirSync(d);
  symlinkSync(realGit, join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'gh'), withGh ? `#!/bin/sh\nexec bash '${FAKE_GH}' "$@"\n` : '#!/bin/sh\nexit 127\n');
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
  writeFileSync(join(dir, PLAN_REL), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const statePath = join(dir, '.methodology', 'stack', 'phased-plan.json');
  return {
    dir, git, statePath, plan: PLAN_REL,
    origin,
    run: (args, extra = {}) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    json: (res) => {
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    },
    ghLog: () =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    commit: (file, text, message) => {
      writeFileSync(join(dir, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    setPlan: (text) => writeFileSync(join(dir, PLAN_REL), text),
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

test('chooseLayout is prs for a forest or an alias remote, stack otherwise', () => {
  assert.equal(chooseLayout({ forest: false, alias: false }), 'stack');
  assert.equal(chooseLayout({ forest: true, alias: false }), 'prs');
  assert.equal(chooseLayout({ forest: false, alias: true }), 'prs');
  const parsed = parsePhases(FOREST, PLAN_REL);
  assert.equal(parsed.forest, true);
  assert.deepEqual(parsed.phases.map((p) => p.parent), [
    { kind: 'trunk', value: null },
    { kind: 'trunk', value: null },
    { kind: 'phase', value: 'P1' },
  ]);
  assert.equal(parsePhases(PHASED, PLAN_REL).forest, false);
});

test('a linear plan writes the v1 state byte-identical to main\'s', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(readFileSync(r.statePath, 'utf8'), readFileSync(join(FIXTURES, 'stack-state-v1.json'), 'utf8'));
  });
});

test('a forest plan writes v2 with a parent per phase', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(state.v, 2);
    assert.deepEqual(
      state.phases.map((p) => [p.n, p.branch, p.title, p.pr, p.state, p.parent]),
      [
        [1, 'demo/01-core', 'feat: core', null, 'pending', 'main'],
        [2, 'demo/02-edge', 'feat: edge', null, 'pending', 'main'],
        [3, 'demo/03-extra', 'feat: extra', null, 'pending', 'demo/01-core'],
      ],
    );
    assert.deepEqual(JSON.parse(readFileSync(r.statePath, 'utf8')), state);
  });
});

test('prs in GitHub mode makes no gh stack call', () => {
  withRig({ plan: FOREST }, (r) => {
    r.git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
    const state = r.json(r.run(['init', r.plan, '--mode', 'github']));
    assert.equal(state.v, 2);
    assert.equal(state.mode, 'github');
    assert.equal(state.ghStackVersion, null);
    const calls = r.ghLog();
    assert.ok(calls.length > 0);
    assert.deepEqual(calls.filter((argv) => argv[0] === 'stack'), []);
  });
});

test('a v1 state for a plan that became a forest is refused', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    r.setPlan(FOREST);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(
      res.stderr,
      new RegExp(`state was written for the stack layout: delete ${r.statePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and run stack init again`),
    );
  });
  // And the other way round: a v2 state for a plan that became linear.
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    r.setPlan(PHASED);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /state was written for the prs layout: delete .* and run stack init again/);
  });
});

test('adoption checks the parent, not the previous phase', () => {
  // Phase 3's parent is phase 1: its branch holds phase 1's tip and phase 2's branch does not exist.
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'demo/03-extra');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.deepEqual(state.phases.map((p) => p.state), ['done', 'pending', 'done']);
  });
  // Phase 3 forked from the trunk lacks phase 1's tip.
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', 'main');
    r.git('switch', '-q', '-c', 'demo/03-extra');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    const res = r.run(['init', r.plan, '--mode', 'local']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /demo\/03-extra.*not chained on demo\/01-core/);
    assert.equal(existsSync(r.statePath), false);
  });
});

// The phased fixture whose phase 2 starts from a named branch, not a phase of the plan.
const NAMED = PHASED.replace('**Branch:** demo/02-edge\n', '**Parent:** release/1.0\n**Branch:** demo/02-edge\n');

const tree = (r) => r.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');

test('siblings start at P1\'s tip', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    r.commit('core.txt', 'core\n', 'feat: core');
    assert.equal(r.run(['done', r.plan, '1']).status, 0);
    r.git('switch', '-q', 'main');
    assert.equal(r.run(['phase', r.plan, '2']).status, 0);
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    assert.equal(r.run(['done', r.plan, '2']).status, 0);
    // HEAD is on phase 2's branch, which has commits the trunk lacks: phase 3's parent is P1, not the trunk.
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), r.git('rev-parse', 'demo/01-core').trim());
    assert.deepEqual(tree(r).filter((f) => f.endsWith('.txt')), ['core.txt']);
  });
});

test('phase refuses while its parent phase is pending', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 1 is pending: phase 3 needs it/);
    assert.equal(r.git('branch', '--list', 'demo/03-extra').trim(), '');
    // Phase 2's parent is the trunk: it starts whatever phase 1's state is.
    assert.equal(r.run(['phase', r.plan, '2']).status, 0);
  });
});

test('a named branch parent on the remote only', () => {
  withRig({ withGh: false, plan: NAMED }, (r) => {
    r.git('switch', '-q', '-c', 'release/1.0');
    r.commit('release.txt', 'release\n', 'feat: release');
    r.git('push', '-q', 'origin', 'release/1.0');
    const tip = r.git('rev-parse', 'release/1.0').trim();
    r.git('switch', '-q', 'main');
    r.git('branch', '-q', '-D', 'release/1.0');
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(state.v, 2);
    assert.equal(state.phases[1].parent, 'release/1.0');
    const res = r.run(['phase', r.plan, '2']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), tip);
    assert.ok(tree(r).includes('release.txt'));
  });
  // A local branch wins over the remote's.
  withRig({ withGh: false, plan: NAMED }, (r) => {
    r.git('switch', '-q', '-c', 'release/1.0');
    r.commit('release.txt', 'release\n', 'feat: release');
    r.git('push', '-q', 'origin', 'release/1.0');
    r.commit('local.txt', 'local\n', 'feat: local only');
    const tip = r.git('rev-parse', 'release/1.0').trim();
    r.git('switch', '-q', 'main');
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(r.run(['phase', r.plan, '2']).status, 0);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), tip);
  });
});

test('a missing named parent is refused', () => {
  withRig({ withGh: false, plan: NAMED }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const res = r.run(['phase', r.plan, '2']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 2's parent release\/1\.0 does not exist/);
    assert.equal(r.git('branch', '--list', 'demo/02-edge').trim(), '');
  });
});

test('squash folds only a sibling\'s own commits', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    r.run(['phase', r.plan, '1']);
    r.commit('core.txt', 'core\n', 'feat: core');
    r.run(['done', r.plan, '1']);
    const p1 = r.git('rev-parse', 'HEAD').trim();
    // Phase 3 forks from P1: its range starts at P1's tip.
    assert.equal(r.run(['phase', r.plan, '3']).status, 0);
    r.commit('a.txt', 'a\n', 'feat: a');
    r.commit('b.txt', 'b\n', 'feat: b');
    const folded = r.run(['squash', r.plan, p1]);
    assert.equal(folded.status, 0, folded.stderr);
    assert.equal(r.git('rev-list', '--count', `${p1}..HEAD`).trim(), '1');
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), p1);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), folded.stdout.trim());
    // A BASE under the phase's start (P1's parent, the trunk) would fold P1's commit in: refused.
    const below = r.run(['squash', r.plan, 'main']);
    assert.equal(below.status, 3, below.stderr);
    assert.match(below.stderr, /below the start of phase 3/);
  });
  // Phase 2's parent is the trunk: its range starts where it forked from the trunk, not at phase 1.
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    r.run(['phase', r.plan, '1']);
    r.commit('core.txt', 'core\n', 'feat: core');
    r.run(['done', r.plan, '1']);
    r.git('switch', '-q', 'main');
    const trunk = r.git('rev-parse', 'HEAD').trim();
    assert.equal(r.run(['phase', r.plan, '2']).status, 0);
    r.commit('x.txt', 'x\n', 'feat: x');
    r.commit('y.txt', 'y\n', 'feat: y');
    const folded = r.run(['squash', r.plan, trunk]);
    assert.equal(folded.status, 0, folded.stderr);
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), trunk);
    assert.ok(!tree(r).includes('core.txt'));
  });
});

// --- submit and push: plain draft PRs, one per phase, each against its parent ----------------------------------------

// Phase 1 from the trunk; phases 2 and 3 both from phase 1.
const SIBLINGS = FOREST.replace('**Parent:** trunk\n**Branch:** demo/02-edge', '**Parent:** P1\n**Branch:** demo/02-edge');

// GitHub mode against a bare repository: the remote's URL is a GitHub one, pushes go to the bare repository.
const githubRig = (r) => {
  r.git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
  r.git('config', 'remote.origin.pushurl', r.origin);
  return r.json(r.run(['init', r.plan, '--mode', 'github']));
};

// Starts phase n, commits one file on it, marks it done.
const finish = (r, n, name) => {
  assert.equal(r.run(['phase', r.plan, String(n)]).status, 0);
  r.commit(`${name}.txt`, `${name}\n`, `feat: ${name}`);
  assert.equal(r.run(['done', r.plan, String(n)]).status, 0);
};

const created = (r) => r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'create');
const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];
// The bare remote's tip of a branch, '' when it has none.
const remoteTip = (r, branch) => r.git('--git-dir', r.origin, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`).trim();

test('three siblings submit with base P1', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    githubRig(r);
    finish(r, 1, 'core');
    const one = r.run(['submit', r.plan, '1']);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout.trim(), 'Phase 1: submitted (demo/01-core, PR #7 draft, base main)');
    finish(r, 2, 'edge');
    finish(r, 3, 'extra');
    assert.equal(r.run(['submit', r.plan, '2']).stdout.trim(), 'Phase 2: submitted (demo/02-edge, PR #8 draft, base demo/01-core)');
    assert.equal(r.run(['submit', r.plan, '3']).stdout.trim(), 'Phase 3: submitted (demo/03-extra, PR #9 draft, base demo/01-core)');
    const calls = created(r);
    assert.deepEqual(calls.map((argv) => [arg(argv, '--head'), arg(argv, '--base')]), [
      ['demo/01-core', 'main'],
      ['demo/02-edge', 'demo/01-core'],
      ['demo/03-extra', 'demo/01-core'],
    ]);
    for (const argv of calls) {
      assert.ok(argv.includes('--draft'));
      assert.equal(arg(argv, '--repo'), 'acme/demo');
    }
    assert.equal(arg(calls[1], '--title'), 'feat: edge');
    assert.deepEqual(r.ghLog().filter((argv) => argv[0] === 'stack'), []);
    for (const branch of ['demo/01-core', 'demo/02-edge', 'demo/03-extra']) {
      assert.equal(remoteTip(r, branch), r.git('rev-parse', branch).trim());
    }
    const state = JSON.parse(readFileSync(r.statePath, 'utf8'));
    assert.deepEqual(state.phases.map((p) => [p.state, p.pr]), [['submitted', 7], ['submitted', 8], ['submitted', 9]]);
  });
});

test('a child is not submitted before its parent', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    // Both branches already exist, chained: init adopts them as done.
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'demo/02-edge');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    r.git('switch', '-q', 'main');
    const state = githubRig(r);
    assert.deepEqual(state.phases.map((p) => p.state), ['done', 'done', 'pending']);
    const res = r.run(['submit', r.plan, '2']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 1 is done: phase 2's parent must be submitted, ready or merged first/);
    assert.deepEqual(created(r), []);
    assert.equal(remoteTip(r, 'demo/02-edge'), '');
  });
});

test('a named parent must be on the remote', () => {
  withRig({ plan: NAMED }, (r) => {
    r.git('switch', '-q', '-c', 'release/1.0');
    r.commit('release.txt', 'release\n', 'feat: release');
    r.git('switch', '-q', '-c', 'demo/02-edge');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    r.git('switch', '-q', 'main');
    githubRig(r);
    const res = r.run(['submit', r.plan, '2']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 2's parent release\/1\.0 is not on origin/);
    assert.deepEqual(created(r), []);
    assert.equal(remoteTip(r, 'demo/02-edge'), '');
    r.git('push', '-q', 'origin', 'release/1.0');
    const ok = r.run(['submit', r.plan, '2']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'Phase 2: submitted (demo/02-edge, PR #7 draft, base release/1.0)');
  });
});

test('submit adopts an open PR', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    githubRig(r);
    finish(r, 1, 'core');
    const res = r.run(['submit', r.plan, '1'], { FAKE_GH_PR_HEADS: 'demo/01-core' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'Phase 1: submitted (demo/01-core, PR #7 draft, base main)');
    assert.deepEqual(created(r), []);
    const list = r.ghLog().find((argv) => argv[0] === 'pr' && argv[1] === 'list');
    assert.deepEqual(list.slice(2), ['--repo', 'acme/demo', '--head', 'demo/01-core', '--state', 'open', '--json', 'number']);
    assert.equal(JSON.parse(readFileSync(r.statePath, 'utf8')).phases[0].pr, 7);
  });
});

test('--open readies every phase', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    githubRig(r);
    finish(r, 1, 'core');
    r.run(['submit', r.plan, '1']);
    finish(r, 2, 'edge');
    r.run(['submit', r.plan, '2']);
    // Phase 3 is not submitted yet: --open refuses.
    finish(r, 3, 'extra');
    const early = r.run(['submit', r.plan, '3', '--open']);
    assert.equal(early.status, 3, early.stderr);
    assert.match(early.stderr, /phase 3 is done: --open needs every phase submitted or ready/);
    r.run(['submit', r.plan, '3']);
    const res = r.run(['submit', r.plan, '3', '--open']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout.trim(),
      'Phase 1: ready (demo/01-core, PR #7)\nPhase 2: ready (demo/02-edge, PR #8)\nPhase 3: ready (demo/03-extra, PR #9)',
    );
    const ready = r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'ready');
    assert.deepEqual(ready, [7, 8, 9].map((n) => ['pr', 'ready', String(n), '--repo', 'acme/demo']));
    assert.deepEqual(JSON.parse(readFileSync(r.statePath, 'utf8')).phases.map((p) => p.state), ['ready', 'ready', 'ready']);
  });
});

test('push is fast-forward only', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    githubRig(r);
    finish(r, 1, 'core');
    r.run(['submit', r.plan, '1']);
    // A fast-forward push lands and refreshes the PR body.
    r.commit('more.txt', 'more\n', 'fix: more');
    const ok = r.run(['push', r.plan, '1']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'Phase 1: pushed (demo/01-core, PR #7)');
    assert.equal(remoteTip(r, 'demo/01-core'), r.git('rev-parse', 'demo/01-core').trim());
    const edit = r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'edit').at(-1);
    assert.deepEqual(edit.slice(0, 3), ['pr', 'edit', '7']);
    assert.ok(edit.includes('--body-file'));
    // The remote moves on; a local branch that diverged from it is rejected, never forced.
    r.git('switch', '-q', '-c', 'other');
    r.commit('other.txt', 'other\n', 'feat: other');
    r.git('push', '-q', 'origin', 'other:demo/01-core');
    const theirs = remoteTip(r, 'demo/01-core');
    r.git('switch', '-q', 'demo/01-core');
    r.commit('mine.txt', 'mine\n', 'feat: mine');
    const edits = r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'edit').length;
    const res = r.run(['push', r.plan, '1']);
    assert.equal(res.status, 5, res.stderr);
    assert.equal(remoteTip(r, 'demo/01-core'), theirs);
    assert.equal(r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'edit').length, edits);
    assert.ok(r.ghLog().every((argv) => !argv.includes('--force')));
  });
});

test('a sibling\'s PR body names its base', () => {
  withRig({ plan: SIBLINGS }, (r) => {
    githubRig(r);
    finish(r, 1, 'core');
    r.run(['submit', r.plan, '1']);
    finish(r, 2, 'edge');
    const res = r.run(['submit', r.plan, '2']);
    assert.equal(res.status, 0, res.stderr);
    const body = readFileSync(arg(created(r)[1], '--body-file'), 'utf8');
    assert.match(body, /## Base\n\n.*`demo\/01-core`/);
    assert.match(body, /## Commits\n\n- feat: edge\n$/);
    assert.ok(!body.includes('feat: core'));
    const first = readFileSync(arg(created(r)[0], '--body-file'), 'utf8');
    assert.match(first, /## Base\n\n.*`main`/);
  });
});

test('status --tree prints the phases as a tree', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const state = JSON.parse(readFileSync(r.statePath, 'utf8'));
    Object.assign(state.phases[1], { state: 'submitted', pr: 7 });
    writeFileSync(r.statePath, JSON.stringify(state));
    const res = r.run(['status', r.plan, '--tree']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      'main\n  P1 demo/01-core [pending]\n    P3 demo/03-extra [pending]\n  P2 demo/02-edge [submitted #7]\n',
    );
  });
  // A chain: each phase under the one before it.
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const res = r.run(['status', r.plan, '--tree']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'main\n  P1 demo/01-core [pending]\n    P2 demo/02-edge [pending]\n');
  });
});
