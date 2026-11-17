// stack.mjs phase state contract: the new state fields (base, startedAt, doneAt, workdir), the state lock, `squash --phase`,
// the linked-worktree refusal, the `status` keys `ready` and `base`, and the exported phase helpers. The rig is the one of
// stack-forest.test.mjs without a gh: a temp git repo with a bare `origin`, local mode only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'stack.mjs');
const PLAN_REL = 'docs/plans/phased-plan.md';
const BRANCHES = ['demo/01-core', 'demo/02-edge', 'demo/03-extra'];

const phaseBlock = (n, title, parent, task) => `## Phase ${n}: ${title}

**Slice:** S${n}
${parent ? `**Parent:** ${parent}\n` : ''}**Branch:** ${BRANCHES[n - 1]}
**PR title:** feat: ${title.toLowerCase()}
**Stands alone because:** core only
**Phase check:** \`true\` -> exit 0

### Task ${task}: Task ${task}

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do ${task}.

`;

// Two phases in a chain: the v1 `stack` layout.
const PHASED = `# Demo Implementation Plan

**Branch prefix:** demo

${phaseBlock(1, 'Core', null, 1)}${phaseBlock(2, 'Edge', null, 2)}`;

// Three phases: P1 and P2 start at the trunk, P3 at P1, so the plan is a forest (the v2 `prs` layout).
const FOREST = `# Demo Implementation Plan

**Branch prefix:** demo

${phaseBlock(1, 'Core', null, 1)}${phaseBlock(2, 'Edge', 'trunk', 2)}${phaseBlock(3, 'Extra', 'P1', 3)}`;

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'TRIQUAL_NOW'));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

const rig = ({ plan = PHASED } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-state-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const bin = join(base, 'bin');
  for (const d of [home, dir, origin, bin]) mkdirSync(d);
  symlinkSync(realGit, join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = { ...gitEnv(home), PATH: `${bin}:/usr/bin:/bin` };
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).replace(/\n+$/, '');
  const git = (...args) => gitIn(dir, ...args);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  mkdirSync(join(dir, dirname(PLAN_REL)), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const statePath = join(dir, '.methodology', 'stack', 'phased-plan.json');
  const r = {
    base, dir, git, gitIn, statePath, plan: PLAN_REL,
    run: (args, extra = {}, cwd = dir) => spawnSync(process.execPath, [STACK, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' }),
    runAsync: (args, extra = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extra } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      }),
    json: (res) => {
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    },
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    editState: (fn) => {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      fn(state);
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    },
    commit: (file, text, message) => {
      writeFileSync(join(dir, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    // A linked worktree of phase `n`'s branch under <dir>/.claude/worktrees (the branch is created from main when missing).
    wt: (n) => {
      const path = join(dir, '.claude', 'worktrees', `phased-plan-p${n}`);
      const branch = BRANCHES[n - 1];
      const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir, env }).status === 0;
      if (exists) git('worktree', 'add', '-q', path, branch);
      else git('worktree', 'add', '-q', '-b', branch, path, 'main');
      return path;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  return r;
};

const withRig = (opts, fn) => {
  const r = rig(opts);
  const done = () => r.cleanup();
  let result;
  try {
    result = fn(r);
  } catch (e) {
    done();
    throw e;
  }
  if (result && typeof result.then === 'function') return result.finally(done);
  done();
  return result;
};

const initLocal = (r) => r.json(r.run(['init', r.plan, '--mode', 'local']));
const ok = (res) => {
  assert.equal(res.status, 0, res.stderr);
  return res;
};

test('a state from before this change reads as before: one parent, no base, no times', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    ok(r.run(['phase', r.plan, '1']));
    r.commit('src/one.mjs', '1\n', 'one');
    r.commit('src/two.mjs', '2\n', 'two');
    const mergeBase = r.git('rev-parse', 'main');
    r.editState((s) => {
      delete s.phases[0].base;
      delete s.phases[0].startedAt;
    });
    const before = readFileSync(r.statePath, 'utf8');
    const shown = r.json(r.run(['status', r.plan])).phases.map((p) => [p.n, p.ready, p.base]);
    assert.deepEqual(shown, [[1, false, mergeBase], [2, true, null], [3, false, null]]);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    // a squash of phase 1 from below the merge-base is still 'below the start of phase 1'
    const below = r.run(['squash', r.plan, `${mergeBase}~1`]);
    assert.equal(below.status, 3);
    assert.match(below.stderr, /below the start of phase 1/);
    // the keys `ready` and `base` of status are never written
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
});

test('phase records startedAt once and a v2 base; done records doneAt; a v1 state gets no base', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    const main = r.git('rev-parse', 'main');
    ok(r.run(['phase', r.plan, '1'], { TRIQUAL_NOW: '2026-11-16T10:00:00Z' }));
    let p1 = r.state().phases[0];
    assert.equal(p1.state, 'active');
    assert.equal(p1.startedAt, '2026-11-16T10:00:00Z');
    assert.equal(p1.base, main);
    ok(r.run(['phase', r.plan, '1'], { TRIQUAL_NOW: '2026-11-16T10:05:00Z' }));
    p1 = r.state().phases[0];
    assert.equal(p1.startedAt, '2026-11-16T10:00:00Z');
    assert.equal(p1.base, main);
    ok(r.run(['done', r.plan, '1'], { TRIQUAL_NOW: '2026-11-16T10:30:00Z' }));
    p1 = r.state().phases[0];
    assert.equal(p1.state, 'done');
    assert.equal(p1.doneAt, '2026-11-16T10:30:00Z');
    assert.equal(p1.startedAt, '2026-11-16T10:00:00Z');
    assert.ok(!('workdir' in p1));
    assert.ok(!('parents' in p1));
  });
  withRig({ plan: PHASED }, (r) => {
    initLocal(r);
    ok(r.run(['phase', r.plan, '1'], { TRIQUAL_NOW: '2026-11-16T10:00:00Z' }));
    const p1 = r.state().phases[0];
    assert.equal(p1.startedAt, '2026-11-16T10:00:00Z');
    assert.ok(!('base' in p1));
    assert.ok(!('workdir' in p1));
    assert.ok(!('parents' in p1));
  });
});

test('a TRIQUAL_NOW that is not an ISO time is exit 2 and writes nothing', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['phase', r.plan, '1'], { TRIQUAL_NOW: 'yesterday' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /TRIQUAL_NOW must be an ISO time like 2026-11-16T10:00:00Z, not yesterday/);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.equal(r.git('branch', '--list', 'demo/01-core'), '');
  });
});

test('the squash floor is the recorded base after the parent moved on', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    ok(r.run(['phase', r.plan, '1']));
    r.commit('src/one.mjs', '1\n', 'one');
    ok(r.run(['done', r.plan, '1']));
    const p1Tip = r.git('rev-parse', 'demo/01-core');
    ok(r.run(['phase', r.plan, '3']));
    assert.equal(r.state().phases[2].base, p1Tip);
    r.commit('src/three-a.mjs', 'a\n', 'three a');
    r.commit('src/three-b.mjs', 'b\n', 'three b');
    r.git('switch', '--quiet', 'demo/01-core');
    r.commit('src/one-more.mjs', 'm\n', 'one more');
    const movedTip = r.git('rev-parse', 'HEAD');
    r.git('switch', '--quiet', 'demo/03-extra');

    const notAncestor = r.run(['squash', r.plan, movedTip]);
    assert.equal(notAncestor.status, 3);
    assert.match(notAncestor.stderr, /not an ancestor/);
    const below = r.run(['squash', r.plan, `${p1Tip}~1`]);
    assert.equal(below.status, 3);
    assert.match(below.stderr, /below the start of phase 3/);

    const sha = ok(r.run(['squash', r.plan, p1Tip])).stdout.trim();
    assert.equal(r.git('rev-parse', 'HEAD'), sha);
    assert.equal(r.git('rev-list', '--count', `${p1Tip}..HEAD`), '1');
  });
});

test('squash --phase 2 folds phase 2 in its recorded workdir while phase 1 is active in a dirty main checkout', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    r.git('switch', '--quiet', '-c', 'demo/01-core');
    r.commit('src/one.mjs', '1\n', 'one');
    const trunkTip = r.git('rev-parse', 'main');
    const work = r.wt(2);
    writeFileSync(join(work, 'src', 'e1.mjs'), 'e1\n');
    r.gitIn(work, 'add', '-A');
    r.gitIn(work, 'commit', '-q', '-m', 'edge one');
    writeFileSync(join(work, 'src', 'e2.mjs'), 'e2\n');
    r.gitIn(work, 'add', '-A');
    r.gitIn(work, 'commit', '-q', '-m', 'edge two');
    r.editState((s) => {
      s.phases[0].state = 'active';
      s.phases[1].state = 'active';
      s.phases[1].workdir = work;
    });
    writeFileSync(join(r.dir, 'src', 'a.mjs'), 'export const a = 2; // dirty\n');
    const mainHead = r.git('rev-parse', 'HEAD');
    const mainStatus = r.git('status', '--porcelain', '--untracked-files=no');
    assert.notEqual(mainStatus, '');

    const sha = ok(r.run(['squash', r.plan, trunkTip, '--phase', '2'])).stdout.trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(r.gitIn(work, 'rev-parse', 'HEAD'), sha);
    assert.equal(r.gitIn(work, 'rev-list', '--count', `${trunkTip}..HEAD`), '1');
    assert.equal(r.git('rev-parse', 'HEAD'), mainHead);
    assert.equal(r.git('status', '--porcelain', '--untracked-files=no'), mainStatus);
    assert.equal(readFileSync(join(r.dir, 'src', 'a.mjs'), 'utf8'), 'export const a = 2; // dirty\n');
  });
});

test('squash names --phase when several phases are active, and refuses --phase on a phase that is not active', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    r.editState((s) => {
      s.phases[0].state = 'active';
      s.phases[1].state = 'active';
    });
    const sha = r.git('rev-parse', 'main');
    const several = r.run(['squash', r.plan, sha]);
    assert.equal(several.status, 3);
    assert.match(several.stderr, /several phases are active \(P1, P2\): name one with --phase N/);
    const pending = r.run(['squash', r.plan, sha, '--phase', '3']);
    assert.equal(pending.status, 3);
    assert.match(pending.stderr, /phase 3 is pending: only an active phase is squashed/);
    const usage = r.run(['squash', r.plan]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: stack\.mjs squash PLAN_FILE BASE \[--phase N\]/);
  });
});

const bothActive = (r) =>
  r.editState((s) => {
    s.phases[0].state = 'active';
    s.phases[1].state = 'active';
  });
const lockOf = (r) => `${r.statePath}.lock`;
const ageLock = (path, seconds) => {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(path, when, when);
};
const lockLeftovers = (r) => readdirSync(dirname(r.statePath)).filter((f) => f.includes('.lock'));

test('two stack.mjs done calls at once keep both changes', async () => {
  await withRig({ plan: PHASED }, async (r) => {
    initLocal(r);
    for (let round = 0; round < 5; round++) {
      bothActive(r);
      const [a, b] = await Promise.all([r.runAsync(['done', r.plan, '1']), r.runAsync(['done', r.plan, '2'])]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(r.state().phases.map((p) => p.state), ['done', 'done'], `round ${round}`);
      assert.deepEqual(lockLeftovers(r), []);
    }
  });
});

test('a stale lock is taken over with a warning, and a fresh lock is waited for', async () => {
  await withRig({ plan: PHASED }, async (r) => {
    initLocal(r);
    bothActive(r);
    mkdirSync(lockOf(r));
    ageLock(lockOf(r), 61);
    const stale = ok(r.run(['done', r.plan, '1']));
    assert.match(stale.stderr, /taking over a stale state lock \(6\d s old\)/);
    assert.equal(r.state().phases[0].state, 'done');
    assert.deepEqual(lockLeftovers(r), []);

    mkdirSync(lockOf(r));
    const started = Date.now();
    const pending = r.runAsync(['done', r.plan, '2']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(lockOf(r), { recursive: true });
    const res = await pending;
    assert.equal(res.status, 0, res.stderr);
    assert.ok(Date.now() - started >= 250, 'the fresh lock was waited for');
    assert.doesNotMatch(res.stderr, /stale/);
    assert.equal(r.state().phases[1].state, 'done');
  });
});

test('two waiters on one stale lock: one takes it over, the other waits, both changes land', async () => {
  await withRig({ plan: PHASED }, async (r) => {
    initLocal(r);
    for (let round = 0; round < 5; round++) {
      bothActive(r);
      mkdirSync(lockOf(r));
      ageLock(lockOf(r), 61);
      const [a, b] = await Promise.all([r.runAsync(['done', r.plan, '1']), r.runAsync(['done', r.plan, '2'])]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(r.state().phases.map((p) => p.state), ['done', 'done'], `round ${round}`);
      const takeovers = [a, b].filter((x) => /taking over a stale state lock/.test(x.stderr));
      assert.equal(takeovers.length, 1, `round ${round}: ${a.stderr} | ${b.stderr}`);
      assert.deepEqual(lockLeftovers(r), []);
    }
  });
});

test('parentsOf and readyPhases read v1 and v2 states, local and github', async () => {
  const { parentsOf, readyPhases, workdirOf, nowIso } = await import(STACK);
  const entry = (n, over = {}) => ({ n, branch: `b${n}`, pr: null, state: 'pending', ...over });

  const v1 = { v: 1, mode: 'local', trunk: 'main', phases: [entry(1), entry(2)] };
  assert.deepEqual(parentsOf(v1, v1.phases[0]), []);
  assert.deepEqual(parentsOf(v1, v1.phases[1]).map((p) => p.n), [1]);
  assert.deepEqual(readyPhases(v1), [1]);

  const v2 = (mode, p1) => ({
    v: 2, mode, trunk: 'main',
    phases: [entry(1, { parent: 'main', state: p1 }), entry(2, { parent: 'main' }), entry(3, { parent: 'b1' })],
  });
  const local = v2('local', 'done');
  assert.deepEqual(parentsOf(local, local.phases[0]), []);
  assert.deepEqual(parentsOf(local, local.phases[2]).map((p) => p.n), [1]);
  assert.deepEqual(readyPhases(local), [2, 3]);
  assert.deepEqual(readyPhases(v2('github', 'done')), [2]);
  assert.deepEqual(readyPhases(v2('github', 'submitted')), [2, 3]);
  const named = { v: 2, mode: 'local', trunk: 'main', phases: [entry(1, { parent: 'release/x' })] };
  assert.deepEqual(parentsOf(named, named.phases[0]), []);
  assert.deepEqual(readyPhases(named), [1]);

  const join = {
    v: 2, mode: 'local', trunk: 'main',
    phases: [entry(1, { parent: 'main', state: 'done' }), entry(2, { parent: 'main', state: 'active' }),
      entry(3, { parent: 'b1', parents: ['b1', 'b2'] })],
  };
  assert.deepEqual(parentsOf(join, join.phases[2]).map((p) => p.n), [1, 2]);
  assert.deepEqual(readyPhases(join), []);
  join.phases[1].state = 'done';
  assert.deepEqual(readyPhases(join), [3]);

  assert.equal(workdirOf('/repo', { n: 1 }), '/repo');
  assert.equal(workdirOf('/repo', { n: 1, workdir: '/repo/.claude/worktrees/x-p1' }), '/repo/.claude/worktrees/x-p1');

  const saved = process.env.TRIQUAL_NOW;
  try {
    process.env.TRIQUAL_NOW = '2026-11-16T10:00:00Z';
    assert.equal(nowIso(), '2026-11-16T10:00:00Z');
    delete process.env.TRIQUAL_NOW;
    assert.match(nowIso(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    process.env.TRIQUAL_NOW = 'yesterday';
    assert.throws(() => nowIso(), /TRIQUAL_NOW must be an ISO time like 2026-11-16T10:00:00Z, not yesterday/);
  } finally {
    if (saved === undefined) delete process.env.TRIQUAL_NOW;
    else process.env.TRIQUAL_NOW = saved;
  }
});

test('every command refuses a linked worktree and writes nothing there', () => {
  withRig({ plan: FOREST }, (r) => {
    initLocal(r);
    const work = r.wt(1);
    const before = readFileSync(r.statePath, 'utf8');
    for (const args of [['path', r.plan], ['status', r.plan], ['phase', r.plan, '1']]) {
      const res = r.run(args, {}, work);
      assert.equal(res.status, 3, `${args[0]}: ${res.stderr}`);
      assert.match(res.stderr, /run from the main checkout/);
    }
    assert.equal(existsSync(join(work, '.methodology')), false);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
});
