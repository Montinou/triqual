// stack.mjs joins: a phase whose `**Parent:**` names two or more earlier phases starts at one commit that merges every parent
// tip (made with git merge-tree and commit-tree, never in a checkout), records its parents and that commit as its base, and
// opens its PR against its first parent. Same harness as stack-forest.test.mjs: a temp git repo with a bare `origin` and a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parentsOf, phaseBase, readyPhases } from '../skills/executing-plans/scripts/stack.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'stack.mjs');
const FIXTURES = join(PLUGIN, 'test', 'fixtures');
const FAKE_GH = join(FIXTURES, 'fake-gh');
const PHASED = readFileSync(join(FIXTURES, 'phased-plan.md'), 'utf8');
const PLAN_REL = 'docs/plans/phased-plan.md';

// The phased fixture with a third phase: phase 2 starts at the trunk and phase 3 at phase 1, so the plan is a forest.
const phaseBlock = (n, name, parent, task) => `## Phase ${n}: ${name}

**Slice:** S${n}
**Parent:** ${parent}
**Branch:** demo/0${n}-${name.toLowerCase()}
**PR title:** feat: ${name.toLowerCase()}
**Stands alone because:** core only
**Phase check:** \`true\` → exit 0

### Task ${task}: Task ${task}

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do ${task}.

`;

const FOREST = PHASED
  .replace('**Branch:** demo/02-edge\n', '**Parent:** trunk\n**Branch:** demo/02-edge\n')
  .replace('## After Merge', `${phaseBlock(3, 'Extra', 'P1', 4)}## After Merge`);
// Phase 3 joins phases 1 and 2.
const JOIN = FOREST.replace('**Parent:** P1\n**Branch:** demo/03-extra', '**Parent:** P1, P2\n**Branch:** demo/03-extra');
// Four phases: three siblings from the trunk and a join of all three.
const THREE = FOREST
  .replace('**Parent:** P1\n**Branch:** demo/03-extra', '**Parent:** trunk\n**Branch:** demo/03-extra')
  .replace('## After Merge', `${phaseBlock(4, 'Last', 'P1, P2, P3', 5)}## After Merge`);

// Phases 1, 2 and 3 are siblings from the trunk, phase 4 joins phases 1 and 2.
const WORKTREE = THREE.replace('**Parent:** P1, P2, P3', '**Parent:** P1, P2');

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

const rig = ({ withGh = true, plan = JOIN } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-join-')));
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
    dir, git, statePath, plan: PLAN_REL, origin,
    run: (args, extra = {}) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    json: (res) => {
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    },
    ghLog: () =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    commit: (file, text, message) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setState: (fn) => {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      fn(state);
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
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

// GitHub mode against a bare repository: the remote's URL is a GitHub one, pushes go to the bare repository.
const githubRig = (r) => {
  r.git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
  r.git('config', 'remote.origin.pushurl', r.origin);
  return r.json(r.run(['init', r.plan, '--mode', 'github']));
};

// Starts phase n from the trunk's checkout, commits `file` (its text names the phase) on it, marks it done; with `submit`, submits it.
const finish = (r, n, file, submit = true) => {
  r.git('switch', '-q', 'main');
  assert.equal(r.run(['phase', r.plan, String(n)]).status, 0);
  r.commit(file, `p${n}\n`, `feat: p${n}`);
  assert.equal(r.run(['done', r.plan, String(n)]).status, 0);
  if (submit) {
    const res = r.run(['submit', r.plan, String(n)]);
    assert.equal(res.status, 0, res.stderr);
  }
};

const created = (r) => r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'create');
const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];
const tip = (r, branch) => r.git('rev-parse', `refs/heads/${branch}`).trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What `phase` makes: one commit of the merged tree of the parent tips, a parent per tip, in written order.
const handJoin = (r, branches, n = 3) => {
  const tips = branches.map((b) => tip(r, b));
  let left = tips[0];
  let tree;
  for (const next of tips.slice(1)) {
    tree = r.git('merge-tree', '--write-tree', left, next).trim().split('\n')[0];
    left = r.git('commit-tree', tree, '-p', left, '-p', next, '-m', 'step').trim();
  }
  return r.git('commit-tree', tree, ...tips.flatMap((t) => ['-p', t]), '-m', `Join of phase ${n}: ${branches.join(', ')}`).trim();
};

test('init writes a prs state whose join records both parents', () => {
  withRig({ withGh: false }, (r) => {
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(state.v, 2);
    assert.deepEqual(state.phases[2].parent, 'demo/01-core');
    assert.deepEqual(state.phases[2].parents, ['demo/01-core', 'demo/02-edge']);
    assert.ok(!('parents' in state.phases[0]));
    assert.ok(!('parents' in state.phases[1]));
    assert.deepEqual(Object.keys(state.phases[2]).slice(0, 7), ['n', 'branch', 'title', 'pr', 'state', 'parent', 'parents']);
    assert.deepEqual(r.state(), state);
  });
});

test('the second parent is read by parentsOf, readyPhases and phaseBase', () => {
  withRig({ withGh: false }, (r) => {
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.deepEqual(parentsOf(state, state.phases[2]).map((p) => p.n), [1, 2]);
    // Done is a started state in local mode: the join is ready only when both parents are.
    state.phases[0].state = 'done';
    assert.deepEqual(readyPhases(state), [2]);
    state.phases[1].state = 'done';
    assert.deepEqual(readyPhases(state), [3]);
    // A recorded base is the floor; the join commit, not the first parent's tip.
    const sha = 'a'.repeat(40);
    state.phases[2].base = sha;
    assert.equal(phaseBase(r.dir, state, state.phases[2]), sha);
  });
});

test('phase 3 waits for both parents, then starts at a join commit holding both tips', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    r.git('switch', '-q', 'main');
    const early = r.run(['phase', r.plan, '3']);
    assert.equal(early.status, 3, early.stderr);
    assert.match(early.stderr, /phase 2 is pending: phase 3 needs it/);
    assert.equal(r.git('branch', '--list', 'demo/03-extra').trim(), '');
    // Phase 1 is submitted and phase 2 is not: status shows the join as not ready.
    assert.equal(r.json(r.run(['status', r.plan])).phases[2].ready, false);
    finish(r, 2, 'edge.txt');
    const ready = r.json(r.run(['status', r.plan]));
    assert.equal(ready.phases[2].ready, true);
    assert.equal(ready.phases[2].base, null);
    r.git('switch', '-q', 'main');
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'demo/03-extra');
    const [commit, ...parents] = r.git('rev-list', '--parents', '-n1', 'demo/03-extra').trim().split(' ');
    assert.deepEqual(parents, [tip(r, 'demo/01-core'), tip(r, 'demo/02-edge')]);
    assert.equal(r.git('log', '-1', '--format=%s', commit).trim(), 'Join of phase 3: demo/01-core, demo/02-edge');
    // Both parents' files are in the join commit's tree.
    assert.deepEqual(r.git('ls-tree', '--name-only', commit).trim().split('\n').filter((f) => f.endsWith('.txt')), ['core.txt', 'edge.txt']);
    assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'demo/03-extra');
    const phase3 = r.state().phases[2];
    assert.equal(phase3.state, 'active');
    assert.equal(phase3.base, commit);
    // `status` reads the recorded base back.
    assert.equal(r.json(r.run(['status', r.plan])).phases[2].base, commit);
  });
});

test('a squash of phase 3 from below its join commit is refused', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    r.git('switch', '-q', 'main');
    assert.equal(r.run(['phase', r.plan, '3']).status, 0);
    const join = r.state().phases[2].base;
    r.commit('one.txt', 'one\n', 'feat: one');
    r.commit('two.txt', 'two\n', 'feat: two');
    const below = r.run(['squash', r.plan, tip(r, 'demo/01-core')]);
    assert.equal(below.status, 3, below.stderr);
    assert.match(below.stderr, /below the start of phase 3/);
    const folded = r.run(['squash', r.plan, join, '--phase', '3']);
    assert.equal(folded.status, 0, folded.stderr);
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), join);
  });
});

test('a conflict at the join leaves nothing behind', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'src/same.txt');
    finish(r, 2, 'src/same.txt');
    r.git('switch', '-q', 'main');
    const before = readFileSync(r.statePath, 'utf8');
    const refs = r.git('for-each-ref', '--format=%(refname)').trim();
    const worktrees = r.git('worktree', 'list').trim();
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /the join of phase 3 conflicts in src\/same\.txt: nothing was created/);
    assert.equal(r.git('branch', '--list', 'demo/03-extra').trim(), '');
    assert.equal(r.git('for-each-ref', '--format=%(refname)').trim(), refs);
    assert.equal(r.git('worktree', 'list').trim(), worktrees);
    assert.equal(existsSync(join(r.dir, '.claude', 'worktrees', 'phased-plan-p3')), false);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.equal(r.git('status', '--porcelain', '--untracked-files=no').trim(), '');
  });
});

test('three parents join in one commit', () => {
  withRig({ plan: THREE }, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    finish(r, 3, 'extra.txt');
    r.git('switch', '-q', 'main');
    const res = r.run(['phase', r.plan, '4']);
    assert.equal(res.status, 0, res.stderr);
    const [commit, ...parents] = r.git('rev-list', '--parents', '-n1', 'demo/04-last').trim().split(' ');
    assert.deepEqual(parents, ['demo/01-core', 'demo/02-edge', 'demo/03-extra'].map((b) => tip(r, b)));
    assert.equal(r.git('log', '-1', '--format=%s', commit).trim(), 'Join of phase 4: demo/01-core, demo/02-edge, demo/03-extra');
    assert.deepEqual(r.git('ls-tree', '--name-only', commit).trim().split('\n').filter((f) => f.endsWith('.txt')), ['core.txt', 'edge.txt', 'extra.txt']);
    const phase4 = r.state().phases[3];
    assert.deepEqual(phase4.parents, ['demo/01-core', 'demo/02-edge', 'demo/03-extra']);
    assert.equal(phase4.base, commit);
    // The intermediate merge commit of the first two parents is on no branch: only the plan's branches and main exist.
    assert.deepEqual(r.git('branch', '--format=%(refname:short)').trim().split('\n').sort(), ['demo/01-core', 'demo/02-edge', 'demo/03-extra', 'demo/04-last', 'main']);
  });
});

test('a join started while another phase holds the main checkout gets its join commit in its worktree', () => {
  withRig({ withGh: false, plan: WORKTREE }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    finish(r, 1, 'core.txt', false);
    finish(r, 2, 'edge.txt', false);
    r.git('switch', '-q', 'main');
    assert.equal(r.run(['phase', r.plan, '3']).status, 0);
    const res = r.run(['phase', r.plan, '4']);
    assert.equal(res.status, 0, res.stderr);
    const path = join(r.dir, '.claude', 'worktrees', 'phased-plan-p4');
    assert.equal(res.stdout, `demo/04-last\nworkdir: ${path}\n`);
    const phase4 = r.state().phases[3];
    assert.equal(phase4.workdir, path);
    assert.deepEqual(r.git('rev-list', '--parents', '-n1', 'demo/04-last').trim().split(' ').slice(1), [tip(r, 'demo/01-core'), tip(r, 'demo/02-edge')]);
    assert.equal(phase4.base, r.git('rev-parse', 'demo/04-last').trim());
    assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'demo/03-extra');
    // Re-entering the active join records nothing new.
    assert.equal(r.run(['phase', r.plan, '4']).status, 0);
    assert.equal(r.state().phases[3].base, phase4.base);
  });
});

test('init on an existing state refuses a plan whose parents changed, and leaves the file unchanged', () => {
  withRig({ withGh: false, plan: FOREST }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const before = readFileSync(r.statePath, 'utf8');
    r.setPlan(JOIN);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /state was written for other parents of phase 3 \(demo\/01-core\)/);
    assert.match(res.stderr, new RegExp(`delete ${escape(r.statePath)} and run stack init again`));
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
  // The other way: a state with a join, a plan that dropped it.
  withRig({ withGh: false, plan: JOIN }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const before = readFileSync(r.statePath, 'utf8');
    r.setPlan(FOREST);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /state was written for other parents of phase 3 \(demo\/01-core, demo\/02-edge\)/);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
  // The same plan again prints the state.
  withRig({ withGh: false, plan: JOIN }, (r) => {
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.deepEqual(r.json(r.run(['init', r.plan])), state);
  });
});

// Two sibling branches from the trunk, made by hand: phases 1 and 2 as `phase` and `done` would leave them.
const siblings = (r) => {
  for (const [branch, file] of [['demo/01-core', 'core.txt'], ['demo/02-edge', 'edge.txt']]) {
    r.git('switch', '-q', '-c', branch, 'main');
    r.commit(file, `${file}\n`, `feat: ${file}`);
  }
  r.git('switch', '-q', 'main');
};

test('init adopts a join branch only when every parent is its ancestor', () => {
  // Phase 3's branch holds phase 1's tip and not phase 2's.
  withRig({ withGh: false }, (r) => {
    siblings(r);
    r.git('switch', '-q', '-c', 'demo/03-extra', 'demo/01-core');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    const res = r.run(['init', r.plan, '--mode', 'local']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /branch demo\/03-extra is not chained on demo\/02-edge: its history lacks demo\/02-edge's tip/);
    assert.equal(existsSync(r.statePath), false);
  });
  // A parent branch that does not exist.
  withRig({ withGh: false }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core', 'main');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'demo/03-extra', 'demo/01-core');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    const res = r.run(['init', r.plan, '--mode', 'local']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /branch demo\/03-extra exists but its parent's branch demo\/02-edge does not/);
    assert.equal(existsSync(r.statePath), false);
  });
  // Both tips are its ancestors, through a join commit.
  withRig({ withGh: false }, (r) => {
    siblings(r);
    const join = handJoin(r, ['demo/01-core', 'demo/02-edge']);
    r.git('branch', 'demo/03-extra', join);
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.deepEqual(state.phases.map((p) => p.state), ['done', 'done', 'done']);
  });
});

test('an adopted join branch gets its join commit as base, and squash refuses a BASE below it', () => {
  withRig({ withGh: false }, (r) => {
    siblings(r);
    const join = handJoin(r, ['demo/01-core', 'demo/02-edge']);
    r.git('branch', 'demo/03-extra', join);
    r.git('switch', '-q', 'demo/03-extra');
    r.commit('c.mjs', 'c\n', 'feat: c');
    r.commit('d.mjs', 'd\n', 'feat: d');
    r.git('switch', '-q', 'main');
    assert.equal(existsSync(r.statePath), false);
    const state = r.json(r.run(['init', r.plan, '--mode', 'local']));
    assert.equal(state.phases[2].base, join);
    assert.ok(!('base' in state.phases[0]));
    // Init adopts the branch as done: the test puts phase 3 back on its branch as active, to squash it.
    r.setState((s) => { s.phases[2].state = 'active'; });
    r.git('switch', '-q', 'demo/03-extra');
    const below = r.run(['squash', r.plan, tip(r, 'demo/01-core'), '--phase', '3']);
    assert.equal(below.status, 3, below.stderr);
    assert.match(below.stderr, /below the start of phase 3/);
    const folded = r.run(['squash', r.plan, join, '--phase', '3']);
    assert.equal(folded.status, 0, folded.stderr);
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), join);
    assert.equal(r.git('diff', '--name-only', join, 'HEAD').trim(), 'c.mjs\nd.mjs');
  });
});

test('init records the first merge commit of an adopted join branch, and refuses one with none', () => {
  // A join branch made by a plain merge: that merge is its join commit.
  withRig({ withGh: false }, (r) => {
    siblings(r);
    r.git('switch', '-q', '-c', 'demo/03-extra', 'demo/01-core');
    r.git('merge', '-q', '--no-ff', '-m', 'merge', 'demo/02-edge');
    const merge = tip(r, 'demo/03-extra');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    assert.equal(r.json(r.run(['init', r.plan, '--mode', 'local'])).phases[2].base, merge);
  });
  // Both tips are ancestors, but no commit has two parents (phase 2's branch was made on phase 1's).
  withRig({ withGh: false }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core', 'main');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'demo/02-edge', 'demo/01-core');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    r.git('switch', '-q', '-c', 'demo/03-extra', 'demo/02-edge');
    r.commit('extra.txt', 'extra\n', 'feat: extra');
    r.git('switch', '-q', 'main');
    const res = r.run(['init', r.plan, '--mode', 'local']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 3's branch demo\/03-extra has no join commit of its 2 parents: delete the branch and run phase 3 again/);
    assert.equal(existsSync(r.statePath), false);
  });
});

test('a join whose branch was made before a crash records its join commit on re-entry', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    r.git('switch', '-q', 'main');
    const join = handJoin(r, ['demo/01-core', 'demo/02-edge']);
    r.git('branch', 'demo/03-extra', join);
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(r.state().phases[2].state, 'active');
    assert.equal(r.state().phases[2].base, join);
    // A second variant: active, the base key deleted by hand.
    r.setState((s) => { delete s.phases[2].base; });
    assert.equal(r.run(['phase', r.plan, '3']).status, 0);
    assert.equal(r.state().phases[2].base, join);
    r.commit('c.txt', 'c\n', 'feat: c');
    const below = r.run(['squash', r.plan, tip(r, 'demo/02-edge')]);
    assert.equal(below.status, 3, below.stderr);
    assert.match(below.stderr, /below the start of phase 3/);
  });
});

test('a join branch with no join commit is refused', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    r.git('switch', '-q', 'main');
    r.git('branch', 'demo/03-extra', 'demo/01-core');
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['phase', r.plan, '3']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 3's branch demo\/03-extra has no join commit of its 2 parents: delete the branch and run phase 3 again/);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'main');
  });
});

test("the join's PR targets its first parent and its body names the other", () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    finish(r, 3, 'extra.txt');
    const [call] = created(r).slice(-1);
    assert.equal(arg(call, '--head'), 'demo/03-extra');
    assert.equal(arg(call, '--base'), 'demo/01-core');
    const body = readFileSync(arg(call, '--body-file'), 'utf8');
    assert.match(body, /## Base\n\n.*`demo\/01-core`[\s\S]*It also merges `demo\/02-edge`: merge those first\./);
  });
  withRig({ plan: THREE }, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    finish(r, 3, 'extra.txt');
    finish(r, 4, 'last.txt');
    const body = readFileSync(arg(created(r).at(-1), '--body-file'), 'utf8');
    assert.match(body, /It also merges `demo\/02-edge`, `demo\/03-extra`: merge those first\./);
    // A plain phase's body says nothing of the kind.
    assert.ok(!readFileSync(arg(created(r)[0], '--body-file'), 'utf8').includes('It also merges'));
  });
});

test('submit needs every parent of a join submitted, naming the first unmet', () => {
  withRig({}, (r) => {
    githubRig(r);
    finish(r, 1, 'core.txt');
    finish(r, 2, 'edge.txt');
    finish(r, 3, 'extra.txt', false);
    const calls = created(r).length;
    r.setState((s) => { s.phases[1].state = 'done'; });
    const second = r.run(['submit', r.plan, '3']);
    assert.equal(second.status, 3, second.stderr);
    assert.match(second.stderr, /phase 2 is done: phase 3's parent must be submitted, ready or merged first/);
    r.setState((s) => { s.phases[0].state = 'done'; });
    const first = r.run(['submit', r.plan, '3']);
    assert.equal(first.status, 3, first.stderr);
    assert.match(first.stderr, /phase 1 is done: phase 3's parent must be submitted, ready or merged first/);
    assert.equal(created(r).length, calls);
  });
});

test('status --tree shows a join under its first parent', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const res = r.run(['status', r.plan, '--tree']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      'main\n  P1 demo/01-core [pending]\n    P3 demo/03-extra [pending] + P2\n  P2 demo/02-edge [pending]\n',
    );
  });
  withRig({ withGh: false, plan: THREE }, (r) => {
    r.json(r.run(['init', r.plan, '--mode', 'local']));
    const lines = r.run(['status', r.plan, '--tree']).stdout.split('\n');
    assert.ok(lines.includes('    P4 demo/04-last [pending] + P2 + P3'), lines.join('\n'));
  });
});
