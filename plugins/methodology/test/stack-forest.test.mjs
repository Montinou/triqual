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
    run: (args) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env, encoding: 'utf8' }),
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
