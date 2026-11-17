// stack.mjs phase worktrees: a phase started while another holds the main checkout is built in <root>/.claude/worktrees/
// <plan stem>-p<N> on its own branch; `done` removes the worktree and keeps the branch. Also the stale-lock takeover that
// never puts a directory back over the lock path. Same rig as stack-forest.test.mjs (a temp git repo with a bare `origin`),
// local mode; the github rig is only for the submit test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'TRIQUAL_NOW'));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

const rig = ({ withGh = false } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-worktree-')));
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
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).replace(/\n+$/, '');
  const git = (...args) => gitIn(dir, ...args);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, dirname(PLAN_REL)), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), FOREST);
  writeFileSync(join(dir, 'notes.txt'), 'notes\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const statePath = join(dir, '.methodology', 'stack', 'phased-plan.json');
  const ghLog = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    dir, bin, work, git, gitIn, statePath, plan: PLAN_REL, origin, ghLog,
    run: (args, extra = {}) => spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    runAsync: (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [STACK, ...args], { cwd: dir, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    commit: (file, text, message) => {
      writeFileSync(join(dir, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
};

const withRig = async (opts, fn) => {
  const r = rig(opts);
  try {
    return await fn(r);
  } finally {
    r.cleanup();
  }
};

const wtPath = (r, n) => join(r.dir, '.claude', 'worktrees', `phased-plan-p${n}`);
const ok = (res) => {
  assert.equal(res.status, 0, res.stderr);
  return res;
};
const init = (r) => ok(r.run(['init', r.plan, '--mode', 'local']));
const phase = (r, n) => ok(r.run(['phase', r.plan, String(n)]));
const listed = (r) => r.git('worktree', 'list', '--porcelain');
const registered = (r, path, branch) =>
  listed(r).split('\n\n').some((block) => block.includes(`worktree ${path}\n`) && block.includes(`branch refs/heads/${branch}`));
const branchOf = (cwd, r) => r.gitIn(cwd, 'branch', '--show-current');
const marker = (r, path) => join(r.gitIn(path, 'rev-parse', '--path-format=absolute', '--git-dir'), 'triqual-installed');

test('phase 2 is built in its own worktree while phase 1 is active in the main checkout', async () => {
  await withRig({}, (r) => {
    init(r);
    assert.equal(phase(r, 1).stdout, 'demo/01-core\n');
    const second = phase(r, 2);
    assert.equal(second.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    assert.equal(r.git('branch', '--show-current'), 'demo/01-core');
    assert.equal(branchOf(wtPath(r, 2), r), 'demo/02-edge');
    assert.equal(r.gitIn(wtPath(r, 2), 'rev-parse', 'HEAD'), r.git('rev-parse', 'main'));
    const state = r.state();
    assert.equal(state.phases[1].state, 'active');
    assert.equal(state.phases[1].workdir, wtPath(r, 2));
    assert.ok(!('workdir' in state.phases[0]));
    assert.equal(state.phases[1].base, r.git('rev-parse', 'main'));
    const exclude = readFileSync(join(r.dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    assert.equal(exclude.filter((l) => l === '.claude/worktrees/').length, 1);
  });
});

test('a dirty main checkout does not block a phase built in a worktree, and a dirty phase worktree blocks its done', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    writeFileSync(join(r.dir, 'notes.txt'), 'edited in main\n');
    phase(r, 2);
    ok(r.run(['done', r.plan, '2']));
    assert.equal(r.state().phases[1].state, 'done');
    assert.equal(r.git('status', '--porcelain', '--untracked-files=no'), ' M notes.txt');
  });
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    phase(r, 2);
    writeFileSync(join(wtPath(r, 2), 'notes.txt'), 'edited in the worktree\n');
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['done', r.plan, '2']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /phase 2's worktree .* has uncommitted changes to tracked files: commit or discard them, then run done again/);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.ok(existsSync(wtPath(r, 2)));
  });
});

test('done removes the phase worktree and keeps its branch', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    phase(r, 2);
    writeFileSync(join(wtPath(r, 2), 'edge.txt'), 'edge\n');
    r.gitIn(wtPath(r, 2), 'add', '-A');
    r.gitIn(wtPath(r, 2), 'commit', '-q', '-m', 'feat: edge');
    const tip = r.git('rev-parse', 'demo/02-edge');
    ok(r.run(['done', r.plan, '2']));
    assert.ok(!listed(r).includes(wtPath(r, 2)));
    assert.ok(!existsSync(wtPath(r, 2)));
    assert.equal(r.git('rev-parse', 'demo/02-edge'), tip);
    assert.equal(r.state().phases[1].state, 'done');
  });
});

test('done removes a phase worktree that holds an untracked file, as removeWorktree does', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    phase(r, 2);
    writeFileSync(join(wtPath(r, 2), 'scratch.txt'), 'scratch\n');
    ok(r.run(['done', r.plan, '2']));
    assert.ok(!listed(r).includes(wtPath(r, 2)));
    assert.ok(!existsSync(wtPath(r, 2)));
    assert.notEqual(r.git('branch', '--list', 'demo/02-edge'), '');
    assert.equal(r.state().phases[1].state, 'done');
  });
});

test('a phase started when no phase is active is built in the main checkout, as today', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    ok(r.run(['done', r.plan, '1']));
    assert.equal(phase(r, 2).stdout, 'demo/02-edge\n');
    assert.equal(r.git('branch', '--show-current'), 'demo/02-edge');
    assert.ok(!('workdir' in r.state().phases[1]));
    assert.ok(!existsSync(join(r.dir, '.claude', 'worktrees')));
  });
});

test('two phase calls leave the state and the main checkout in agreement', async () => {
  for (let round = 0; round < 5; round++) {
    await withRig({}, async (r) => {
      init(r);
      const results = await Promise.all([r.runAsync(['phase', r.plan, '1']), r.runAsync(['phase', r.plan, '2'])]);
      for (const res of results) {
        if (res.status === 0) continue;
        assert.equal(res.status, 3, `round ${round}: ${res.stderr}`);
        const m = /phase (\d) holds the main checkout: run phase (\d) again/.exec(res.stderr);
        assert.ok(m, `round ${round}: ${res.stderr}`);
        ok(r.run(['phase', r.plan, m[2]]));
      }
      const [one, two] = r.state().phases;
      assert.deepEqual([one.state, two.state], ['active', 'active'], `round ${round}`);
      const inMain = [one, two].filter((p) => !p.workdir);
      assert.equal(inMain.length, 1, `round ${round}`);
      assert.equal(r.git('branch', '--show-current'), inMain[0].branch);
      const other = [one, two].find((p) => p.workdir);
      assert.equal(other.workdir, wtPath(r, other.n));
      assert.ok(registered(r, other.workdir, other.branch), `round ${round}`);
    });
  }
});

test('a phase whose worktree was added before the state write is picked up by phase N again', async () => {
  const crash = (r) => {
    r.git('branch', '--no-track', 'demo/02-edge', r.git('rev-parse', 'main'));
    r.git('worktree', 'add', '-q', wtPath(r, 2), 'demo/02-edge');
  };
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    crash(r);
    assert.equal(r.state().phases[1].state, 'pending');
    const res = phase(r, 2);
    assert.equal(res.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    const p2 = r.state().phases[1];
    assert.equal(p2.state, 'active');
    assert.equal(p2.workdir, wtPath(r, 2));
    assert.ok(p2.startedAt);
  });
  // Main is free (phase 1 is done): the registered worktree is still taken, and main stays where it was.
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    ok(r.run(['done', r.plan, '1']));
    crash(r);
    const res = phase(r, 2);
    assert.equal(res.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    assert.equal(r.git('branch', '--show-current'), 'demo/01-core');
    assert.equal(r.state().phases[1].workdir, wtPath(r, 2));
  });
});

// An `npm` stub on the PATH: logs its argv, and fails while the flag file exists.
const npmStub = (r) => {
  const calls = join(r.work, 'npm.calls');
  const flag = join(r.work, 'npm.fail');
  writeFileSync(join(r.bin, 'npm'), `#!/bin/sh\necho "$@" >> '${calls}'\nif [ -e '${flag}' ]; then echo 'npm ERR! boom' >&2; exit 1; fi\nexit 0\n`);
  chmodSync(join(r.bin, 'npm'), 0o755);
  writeFileSync(flag, '');
  return { calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []), flag };
};

test('a failed install is retried by phase N', async () => {
  await withRig({}, (r) => {
    r.commit('package-lock.json', '{}\n', 'chore: lockfile');
    const npm = npmStub(r);
    init(r);
    phase(r, 1);
    const failed = r.run(['phase', r.plan, '2']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /npm ERR! boom/);
    const p2 = r.state().phases[1];
    assert.equal(p2.state, 'active');
    assert.equal(p2.workdir, wtPath(r, 2));
    assert.ok(registered(r, wtPath(r, 2), 'demo/02-edge'));
    assert.ok(!existsSync(marker(r, wtPath(r, 2))));
    rmSync(npm.flag);
    const again = phase(r, 2);
    assert.equal(again.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    assert.deepEqual(npm.calls(), ['ci', 'ci']);
    assert.ok(existsSync(marker(r, wtPath(r, 2))));
  });
});

test('a lockfile in the worktree is installed once', async () => {
  await withRig({}, (r) => {
    r.commit('package-lock.json', '{}\n', 'chore: lockfile');
    const npm = npmStub(r);
    rmSync(npm.flag);
    init(r);
    phase(r, 1);
    phase(r, 2);
    phase(r, 2);
    phase(r, 2);
    assert.deepEqual(npm.calls(), ['ci']);
  });
});

test('a trunk phase built in a worktree is not refused as a stranded HEAD', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    r.commit('core.txt', 'core\n', 'feat: core');
    const res = phase(r, 2);
    assert.equal(res.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    assert.equal(r.gitIn(wtPath(r, 2), 'rev-parse', 'HEAD'), r.git('rev-parse', 'main'));
  });
});

test('a deleted phase worktree is recreated by phase N from its branch', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    phase(r, 2);
    writeFileSync(join(wtPath(r, 2), 'edge.txt'), 'edge\n');
    r.gitIn(wtPath(r, 2), 'add', '-A');
    r.gitIn(wtPath(r, 2), 'commit', '-q', '-m', 'feat: edge');
    rmSync(wtPath(r, 2), { recursive: true, force: true });
    const res = phase(r, 2);
    assert.equal(res.stdout, `demo/02-edge\nworkdir: ${wtPath(r, 2)}\n`);
    assert.ok(existsSync(join(wtPath(r, 2), 'edge.txt')));
    assert.equal(branchOf(wtPath(r, 2), r), 'demo/02-edge');
    assert.equal(r.state().phases[1].workdir, wtPath(r, 2));
  });
});

// GitHub mode against a bare repository: the remote's URL is a GitHub one, pushes go to the bare repository.
const githubRig = (r) => {
  r.git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
  r.git('config', 'remote.origin.pushurl', r.origin);
  return ok(r.run(['init', r.plan, '--mode', 'github']));
};

test('submit of a phase in the prs layout checks only the checkout holding its branch', async () => {
  await withRig({ withGh: true }, (r) => {
    githubRig(r);
    phase(r, 1);
    writeFileSync(join(r.dir, 'notes.txt'), 'edited in main\n');
    phase(r, 2);
    writeFileSync(join(wtPath(r, 2), 'edge.txt'), 'edge\n');
    r.gitIn(wtPath(r, 2), 'add', '-A');
    r.gitIn(wtPath(r, 2), 'commit', '-q', '-m', 'feat: edge');
    ok(r.run(['done', r.plan, '2']));
    const res = ok(r.run(['submit', r.plan, '2']));
    assert.match(res.stdout, /Phase 2: submitted \(demo\/02-edge, PR #\d+ draft, base main\)/);
    // Phase 1's branch is checked out in the dirty main checkout: its submit is refused there.
    ok(r.run(['done', r.plan, '1']));
    const refused = r.run(['submit', r.plan, '1']);
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /the working tree is not clean/);
  });
});

test('status --tree shows the workdir of an active worktree phase only', async () => {
  await withRig({}, (r) => {
    init(r);
    phase(r, 1);
    phase(r, 2);
    const lines = ok(r.run(['status', r.plan, '--tree'])).stdout.split('\n');
    assert.ok(lines.includes('  P1 demo/01-core [active]'), lines.join('|'));
    assert.ok(lines.includes('  P2 demo/02-edge [active] .claude/worktrees/phased-plan-p2'), lines.join('|'));
  });
});

// --- the stale-lock takeover --------------------------------------------------------------------------------------

test('a waiter that moved away a lock it did not judge stale puts nothing back over a third contender', async () => {
  const { takeOverStaleLock } = await import(STACK);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stack-lock-')));
  const lock = join(dir, 'plan.json.lock');
  const realRename = fs.renameSync;
  try {
    // Contender A finds the lock old and means to take it over.
    mkdirSync(lock);
    const old = new Date(Date.now() - 61_000);
    utimesSync(lock, old, old);
    const seen = statSync(lock);
    // Contender B takes that lock over first and makes a fresh one of its own.
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    // Contender C makes its lock the moment A has moved B's away.
    let third = null;
    fs.renameSync = (from, to) => {
      realRename(from, to);
      if (third === null) {
        mkdirSync(lock);
        third = statSync(lock);
      }
    };
    syncBuiltinESMExports();
    const took = takeOverStaleLock(lock, seen);
    assert.equal(took, false);
    assert.ok(third, 'the third contender made its lock');
    assert.equal(statSync(lock).ino, third.ino, 'the third contender still holds the lock path');
    assert.deepEqual(readdirSync(dir), ['plan.json.lock']);
  } finally {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
