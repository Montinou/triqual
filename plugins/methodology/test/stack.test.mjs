// stack.mjs (stacked execution, U4): plan parsing, the state file, mode detection, init, mode, path, status, phase,
// squash, done and submit.
// Every test runs in a temp git repo with a bare repo as `origin` and a fake `gh` on a PATH that holds no real gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePhases } from '../skills/executing-plans/scripts/stack.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const STACK = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'stack.mjs');
const FIXTURES = join(PLUGIN, 'test', 'fixtures');
const FAKE_GH = join(FIXTURES, 'fake-gh');
const PHASED = readFileSync(join(FIXTURES, 'phased-plan.md'), 'utf8');
const PLAN_REL = 'docs/plans/phased-plan.md';

const UNPHASED = `# Demo plan

## Global Constraints

- Nothing.

### Task 1: First

- [ ] **Step 1:** do one.

### Task 2: Second

- [ ] **Step 1:** do two.

\`\`\`
## Phase 9: inside a fence, not a phase
### Task 9: inside a fence, not a task
\`\`\`

### Task 3: Third

- [ ] **Step 1:** do three.
`;

// The GitHub remote URL forms of the Global Constraints.
const GITHUB_URLS = [
  'https://github.com/acme/demo.git',
  ['ssh://git', 'github.com/acme/demo.git'].join('@'), // built, so the literal does not read as an email to the export check
  'git@github.com:acme/demo.git',
];

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// A repo on `main` with the plan committed and pushed to a bare `origin`. `withGh` puts the fake gh on the PATH; the
// PATH is a temp bin dir plus /usr/bin:/bin. Without the fake, a gh that always fails stands in that dir, so a real gh
// in /usr/bin (GitHub's Linux runners ship one) is never reached either.
const rig = ({ withGh = true, plan = PHASED, planRel = PLAN_REL } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-')));
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
  const membership = join(work, 'membership');
  const env = {
    ...gitEnv(home),
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_GH_LOG: log,
    FAKE_GH_STACK: membership,
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, dirname(planRel)), { recursive: true });
  writeFileSync(join(dir, planRel), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const run = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [STACK, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const json = (res) => {
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const ghLog = () =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  const statePath = join(dir, '.methodology', 'stack', 'phased-plan.json');
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return {
    dir, bin, work, env, git, run, json, ghLog, commit, cleanup, statePath, plan: planRel,
    setUrl: (url) => git('remote', 'set-url', 'origin', url),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
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

test('init in local mode records the phases, trunk and reason', () => {
  withRig({ withGh: false }, (r) => {
    const state = r.json(r.run(['init', r.plan]));
    assert.equal(state.v, 1);
    assert.equal(state.plan, 'phased-plan.md');
    assert.equal(state.mode, 'local');
    assert.match(state.reason, /gh --version/);
    assert.equal(state.ghStackVersion, null);
    assert.equal(state.trunk, 'main');
    assert.deepEqual(
      state.phases.map((p) => [p.n, p.branch, p.title, p.pr, p.state]),
      [
        [1, 'demo/01-core', 'feat: core', null, 'pending'],
        [2, 'demo/02-edge', 'feat: edge', null, 'pending'],
      ],
    );
    assert.deepEqual(r.state(), state);
    assert.equal(r.ghLog().length, 0);
  });
});

test('init detects github mode for each GitHub URL form', () => {
  for (const url of GITHUB_URLS) {
    withRig({}, (r) => {
      r.setUrl(url);
      const state = r.json(r.run(['init', r.plan]));
      assert.equal(state.mode, 'github', url);
      assert.equal(state.reason, null, url);
      assert.equal(state.remote, 'origin', url);
      assert.equal(state.ghStackVersion, 'gh stack version 0.1.1', url);
      assert.equal(state.trunk, 'main', url);
      assert.deepEqual(
        r.ghLog().find((argv) => argv[0] === 'repo'),
        ['repo', 'view', 'acme/demo', '--json', 'nameWithOwner,defaultBranchRef'],
        url,
      );
    });
  }
});

test('init falls back to local naming the first failed check', () => {
  const cases = [
    ['gh stack --version failing', { FAKE_GH_FAIL_STACK_VERSION: '1' }, null, /gh stack --version/],
    ['gh repo view failing', { FAKE_GH_FAIL_REPO_VIEW: '1' }, null, /gh repo view/],
    ['a non-GitHub URL', {}, 'https://git.example.invalid/acme/demo.git', /GitHub remote/],
  ];
  for (const [name, extraEnv, url, reason] of cases) {
    withRig({}, (r) => {
      r.setUrl(url ?? 'git@github.com:acme/demo.git');
      const state = r.json(r.run(['init', r.plan], extraEnv));
      assert.equal(state.mode, 'local', name);
      assert.match(state.reason, reason, name);
      assert.equal(state.ghStackVersion, null, name);
    });
  }
});

test('init --mode github exits 3 when a check fails', () => {
  withRig({}, (r) => {
    r.setUrl('https://git.example.invalid/acme/demo.git');
    const res = r.run(['init', r.plan, '--mode', 'github']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /GitHub remote/);
    assert.equal(existsSync(r.statePath), false);
  });
  withRig({ withGh: false }, (r) => {
    const res = r.run(['init', r.plan, '--mode', 'github']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /gh --version/);
  });
});

test('init refuses committed tracking mode', () => {
  withRig({ withGh: false }, (r) => {
    writeFileSync(join(r.bin, 'triqual'), '#!/bin/sh\necho \'{"optedIn":true,"mode":"committed"}\'\n');
    chmodSync(join(r.bin, 'triqual'), 0o755);
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(
      res.stderr,
      /committed tracking mode cannot hold one commit per task: switch with triqual progress-init --store \(or --local\)/,
    );
    assert.equal(existsSync(r.statePath), false);
  });
  withRig({ withGh: false }, (r) => {
    writeFileSync(join(r.bin, 'triqual'), '#!/bin/sh\necho \'{"optedIn":true,"mode":"store"}\'\n');
    chmodSync(join(r.bin, 'triqual'), 0o755);
    assert.equal(r.run(['init', r.plan]).status, 0);
  });
});

test('init refuses a branch named exactly the prefix', () => {
  withRig({ withGh: false }, (r) => {
    r.git('branch', 'demo');
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /branch "demo"/);
    assert.equal(existsSync(r.statePath), false);
  });
});

test('init exits 2 on malformed phases', () => {
  const cases = {
    'a task before the first phase': PHASED.replace('## Phase 1: Core', '### Task 7: Early\n\n## Phase 1: Core'),
    'a phase lacking **Branch:**': PHASED.replace('**Branch:** demo/01-core\n', ''),
    'a phase lacking **PR title:**': PHASED.replace('**PR title:** feat: core\n', ''),
    'a branch without the prefix': PHASED.replace('demo/02-edge', 'other/02-edge'),
    'a branch whose NN differs from the phase number': PHASED.replace('demo/02-edge', 'demo/03-edge'),
    'a branch that is not a valid ref (..)': PHASED.replace('demo/01-core', 'demo/01-co..re'),
    'a branch that is not a valid ref (.lock)': PHASED.replace('demo/01-core', 'demo/01-core.lock'),
    'a branch that is not a valid ref (space)': PHASED.replace('**Branch:** demo/01-core', '**Branch:** `demo/01-co re`'),
    'a prefix that is not a valid ref': PHASED.replaceAll('demo', 'de mo'),
  };
  for (const [name, plan] of Object.entries(cases)) {
    withRig({ withGh: false, plan }, (r) => {
      const res = r.run(['init', r.plan]);
      assert.equal(res.status, 2, `${name}: ${res.stderr}`);
      assert.ok(res.stderr.trim().length > 0, name);
      assert.equal(existsSync(r.statePath), false, name);
    });
  }
});

test('init ignores phase lines inside fences', () => {
  withRig({ withGh: false }, (r) => {
    const state = r.json(r.run(['init', r.plan]));
    assert.deepEqual(state.phases.map((p) => p.branch), ['demo/01-core', 'demo/02-edge']);
  });
  const { phases } = parsePhases(PHASED, PLAN_REL);
  assert.deepEqual(phases.map((p) => p.tasks), [[1, 2], [3]]);
  assert.deepEqual(phases.map((p) => p.n), [1, 2]);
  const [first] = phases;
  assert.equal(first.title, 'Core');
  assert.equal(first.slice, 'S1');
  assert.equal(first.standsAlone, 'core only');
  assert.equal(first.check, '`true` → exit 0');
});

test('a plan without phases is one phase', () => {
  const parsed = parsePhases(UNPHASED, 'docs/plans/demo-plan.md');
  assert.equal(parsed.prefix, 'demo-plan');
  assert.equal(parsed.phases.length, 1);
  const [phase] = parsed.phases;
  assert.equal(phase.n, 1);
  assert.equal(phase.branch, 'demo-plan/01-plan');
  assert.equal(phase.prTitle, 'Demo plan');
  assert.equal(phase.title, 'Demo plan');
  assert.deepEqual(phase.tasks, [1, 2, 3]);
  withRig({ withGh: false, plan: UNPHASED, planRel: 'docs/plans/demo-plan.md' }, (r) => {
    const state = r.json(r.run(['init', r.plan]));
    assert.deepEqual(state.phases.map((p) => [p.branch, p.title]), [['demo-plan/01-plan', 'Demo plan']]);
  });
});

test('a plan without a branch prefix is one phase, whatever its ## Phase headings say', () => {
  // A plan written before phases existed, with hand-made ## Phase headings numbered from 0 and no phase fields.
  const OLD = `# Legacy Implementation Plan

## Global Constraints

- Nothing.

## Phase 0: Baseline

### Task 1: Measure

- [ ] **Step 1:** measure.

## Phase 1: Build

### Task 2: Build

- [ ] **Step 1:** build.

## Phase 2: Ship

### Task 3: Ship

- [ ] **Step 1:** ship.
`;
  const parsed = parsePhases(OLD, 'docs/plans/legacy-plan.md');
  assert.equal(parsed.prefix, 'legacy-plan');
  assert.equal(parsed.phases.length, 1);
  const [phase] = parsed.phases;
  assert.deepEqual(
    [phase.n, phase.branch, phase.prTitle, phase.check, phase.tasks],
    [1, 'legacy-plan/01-plan', 'Legacy', "the repository's full test command", [1, 2, 3]],
  );
  // The phased fixture without its prefix line is the same: one phase holding every task.
  const bare = parsePhases(PHASED.replace('**Branch prefix:** demo\n', ''), PLAN_REL);
  assert.deepEqual(bare.phases.map((p) => [p.branch, p.tasks]), [['phased-plan/01-plan', [1, 2, 3]]]);
  withRig({ withGh: false, plan: OLD, planRel: 'docs/plans/legacy-plan.md' }, (r) => {
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).phases.map((p) => [p.n, p.branch, p.title]), [[1, 'legacy-plan/01-plan', 'Legacy']]);
  });
});

test('trunk is the remote default branch, --trunk overrides it', () => {
  // Local mode: refs/remotes/origin/HEAD names develop, not main.
  withRig({ withGh: false }, (r) => {
    r.git('branch', 'develop');
    r.git('push', '-q', 'origin', 'develop');
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    assert.equal(r.json(r.run(['init', r.plan])).trunk, 'develop');
    rmSync(r.statePath);
    assert.equal(r.json(r.run(['init', r.plan, '--trunk', 'main'])).trunk, 'main');
  });
  // GitHub mode: gh repo view names develop.
  withRig({}, (r) => {
    r.git('branch', 'develop');
    r.git('push', '-q', 'origin', 'develop');
    r.setUrl(GITHUB_URLS[0]);
    const variant = join(r.work, 'repo-view-develop.json');
    writeFileSync(variant, '{"defaultBranchRef":{"name":"develop"},"nameWithOwner":"acme/demo"}\n');
    const env = { FAKE_GH_REPO_VIEW: variant };
    const state = r.json(r.run(['init', r.plan], env));
    assert.equal(state.mode, 'github');
    assert.equal(state.trunk, 'develop');
    rmSync(r.statePath);
    assert.equal(r.json(r.run(['init', r.plan, '--trunk', 'main'], env)).trunk, 'main');
  });
});

test('github mode requires the trunk tip on the remote', () => {
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[0]);
    r.commit('local-only.txt', 'x\n', 'local only');
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /main.*not on origin/);
    assert.equal(existsSync(r.statePath), false);
    // Local mode has no such requirement.
    assert.equal(r.json(r.run(['init', r.plan, '--mode', 'local'])).mode, 'local');
  });
});

test('init twice keeps the state file (resume)', () => {
  withRig({ withGh: false }, (r) => {
    const first = r.json(r.run(['init', r.plan]));
    const edited = { ...first, phases: first.phases.map((p) => (p.n === 1 ? { ...p, state: 'submitted', pr: 7 } : p)) };
    writeFileSync(r.statePath, `${JSON.stringify(edited, null, 2)}\n`);
    const second = r.json(r.run(['init', r.plan]));
    assert.deepEqual(second, edited);
    assert.deepEqual(r.state(), edited);
  });
});

test('init adopts existing chained phase branches as done, submitted when a PR exists, and refuses an unchained one', () => {
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[0]);
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'demo/02-edge');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    r.git('switch', '-q', 'main');
    const state = r.json(r.run(['init', r.plan], { FAKE_GH_PR_HEADS: 'demo/01-core' }));
    assert.equal(state.mode, 'github');
    assert.deepEqual(
      state.phases.map((p) => [p.branch, p.state, p.pr]),
      [
        ['demo/01-core', 'submitted', 7],
        ['demo/02-edge', 'done', null],
      ],
    );
    const list = r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'list');
    assert.deepEqual(
      list.map((argv) => argv[argv.indexOf('--head') + 1]),
      ['demo/01-core', 'demo/02-edge'],
    );
    assert.ok(list.every((argv) => argv.includes('number,isDraft')));
  });
  // Local mode adopts as done, with no PR lookup.
  withRig({ withGh: false }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', 'main');
    const state = r.json(r.run(['init', r.plan]));
    assert.deepEqual(state.phases.map((p) => [p.state, p.pr]), [['done', null], ['pending', null]]);
  });
  // An unchained branch: phase 2 forked from the trunk, not from phase 1.
  withRig({ withGh: false }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', 'main');
    r.git('switch', '-q', '-c', 'demo/02-edge');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    r.git('switch', '-q', 'main');
    const res = r.run(['init', r.plan]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /demo\/02-edge.*not chained/);
    assert.equal(existsSync(r.statePath), false);
  });
});

test('path prints <root>/.methodology/stack/phased-plan.json', () => {
  withRig({ withGh: false }, (r) => {
    const res = r.run(['path', r.plan]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${join(r.dir, '.methodology', 'stack', 'phased-plan.json')}\n`);
  });
});

test('mode switches local to github and refuses github when a check fails', () => {
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[2]);
    assert.equal(r.json(r.run(['init', r.plan, '--mode', 'local'])).mode, 'local');
    assert.equal(r.state().ghStackVersion, null);

    const refused = r.run(['mode', r.plan, 'github'], { FAKE_GH_FAIL_REPO_VIEW: '1' });
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /gh repo view/);
    assert.equal(r.state().mode, 'local');

    const res = r.run(['mode', r.plan, 'github']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim().split('\n').length, 1);
    const state = r.state();
    assert.equal(state.mode, 'github');
    assert.equal(state.reason, null);
    assert.equal(state.remote, 'origin');
    assert.equal(state.ghStackVersion, 'gh stack version 0.1.1');

    assert.equal(r.run(['mode', r.plan, 'local']).status, 0);
    assert.equal(r.state().mode, 'local');
    assert.equal(r.run(['mode', r.plan, 'sideways']).status, 2);
  });
});

test('status refreshes each recorded PR with gh pr view and marks merged ones merged', () => {
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[1]);
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', 'main');
    r.json(r.run(['init', r.plan], { FAKE_GH_PR_HEADS: 'demo/01-core' }));
    assert.equal(r.state().phases[0].state, 'submitted');
    assert.equal(r.git('branch', '--show-current').trim(), 'main');

    const merged = join(r.work, 'pr-view-merged.json');
    writeFileSync(merged, '{"isDraft":false,"number":7,"state":"MERGED"}\n');
    const state = r.json(r.run(['status', r.plan], { FAKE_GH_PR_VIEW: merged }));
    assert.deepEqual(state.phases.map((p) => p.state), ['merged', 'pending']);
    assert.equal(r.state().phases[0].state, 'merged');
    const views = r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'view');
    assert.equal(views.length, 1);
    assert.equal(views[0][2], '7');
    assert.ok(
      r.ghLog().every((argv) => !(argv[0] === 'stack' && argv[1] === 'view')),
      'status needs no stack view',
    );

    // An open PR leaves its phase as recorded.
    const open = r.json(r.run(['status', r.plan]));
    assert.equal(open.phases[0].state, 'merged');
  });
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[0]);
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', 'main');
    r.json(r.run(['init', r.plan], { FAKE_GH_PR_HEADS: 'demo/01-core' }));
    const state = r.json(r.run(['status', r.plan]));
    assert.deepEqual(state.phases.map((p) => p.state), ['submitted', 'pending']);
    const res = r.run(['status', r.plan], { FAKE_GH_FAIL_PR_VIEW: '1' });
    assert.equal(res.status, 5, res.stderr);
  });
  withRig({ withGh: false }, (r) => {
    assert.equal(r.run(['status', r.plan]).status, 3, 'no state file yet');
  });
});

// --- phase, squash and done -------------------------------------------------------------------------------------

// The fixture plan with a third phase, for chaining across three phases.
const THREE_PHASES = PHASED.replace(
  '## After Merge',
  `## Phase 3: Top

**Slice:** S3
**Branch:** demo/03-top
**PR title:** feat: top
**Stands alone because:** core and edge only
**Phase check:** \`true\` → exit 0

### Task 4: Four

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do four.

## After Merge`,
);

const head = (r, ref = 'HEAD') => r.git('rev-parse', ref).trim();
const branchNow = (r) => r.git('branch', '--show-current').trim();
const show = (r, format, ref = 'HEAD') => r.git('log', '-1', `--format=${format}`, ref).replace(/\n+$/, '');

// Sets phase n's state in the state file directly, standing in for the commands that move it.
const mark = (r, n, state) => {
  const s = r.state();
  s.phases.find((p) => p.n === n).state = state;
  writeFileSync(r.statePath, `${JSON.stringify(s, null, 2)}\n`);
};

// A commit with its own author and author date.
const commitAs = (r, file, text, message, author) => {
  writeFileSync(join(r.dir, file), text);
  r.git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: r.dir,
    env: {
      ...r.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.date,
    },
  });
};

const failingPreCommitHook = (r) => {
  const hook = join(r.dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "pre-commit hook ran" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
};

test('phase chains three branches', () => {
  withRig({ withGh: false, plan: THREE_PHASES }, (r) => {
    r.json(r.run(['init', r.plan]));
    const trunkSha = head(r, 'main');

    const one = r.run(['phase', r.plan, '1']);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout, 'demo/01-core\n');
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(head(r), trunkSha, 'phase 1 starts at the trunk tip');
    assert.equal(r.state().phases[0].state, 'active');
    r.commit('core.txt', 'core\n', 'feat: core');
    const oneTip = head(r);
    mark(r, 1, 'done');

    r.git('switch', '-q', 'main');
    const two = r.run(['phase', r.plan, '2']);
    assert.equal(two.status, 0, two.stderr);
    assert.equal(two.stdout, 'demo/02-edge\n');
    assert.equal(branchNow(r), 'demo/02-edge', 'HEAD is never left on the trunk');
    assert.equal(head(r), oneTip, "phase 2 starts at phase 1's tip");
    assert.equal(r.state().phases[1].state, 'active');
    r.commit('edge.txt', 'edge\n', 'feat: edge');
    const twoTip = head(r);
    mark(r, 2, 'done');

    const three = r.run(['phase', r.plan, '3']);
    assert.equal(three.status, 0, three.stderr);
    assert.equal(three.stdout, 'demo/03-top\n');
    assert.equal(branchNow(r), 'demo/03-top');
    assert.equal(head(r), twoTip, "phase 3 starts at phase 2's tip");
    assert.deepEqual(r.state().phases.map((p) => p.state), ['done', 'done', 'active']);
    assert.equal(head(r, 'main'), trunkSha, 'the trunk never moves');
  });
});

test('phase refuses a dirty tree and an unfinished predecessor', () => {
  // Local mode: the predecessor must be done.
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    const before = readFileSync(r.statePath, 'utf8');
    writeFileSync(join(r.dir, r.plan), `${PHASED}\nedited\n`);
    const dirty = r.run(['phase', r.plan, '1']);
    assert.equal(dirty.status, 3, dirty.stderr);
    assert.match(dirty.stderr, /clean|uncommitted/);
    assert.equal(branchNow(r), 'main');
    assert.equal(readFileSync(r.statePath, 'utf8'), before, 'a refusal writes nothing');
    r.git('checkout', '--', r.plan);

    for (const state of ['pending', 'active']) {
      mark(r, 1, state);
      const res = r.run(['phase', r.plan, '2']);
      assert.equal(res.status, 3, `${state}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`phase 1 is ${state}`));
      assert.equal(branchNow(r), 'main', state);
      assert.equal(r.state().phases[1].state, 'pending', state);
    }
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    mark(r, 1, 'done');
    const ok = r.run(['phase', r.plan, '2']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(branchNow(r), 'demo/02-edge');
    // A predecessor that status recorded merged still lets phase 2 be entered again.
    mark(r, 1, 'merged');
    r.git('switch', '-q', 'main');
    const merged = r.run(['phase', r.plan, '2']);
    assert.equal(merged.status, 0, `merged: ${merged.stderr}`);
    assert.equal(branchNow(r), 'demo/02-edge');
  });
  // GitHub mode: the predecessor must be submitted or ready; done is not enough.
  withRig({}, (r) => {
    r.setUrl(GITHUB_URLS[0]);
    assert.equal(r.json(r.run(['init', r.plan])).mode, 'github');
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    mark(r, 1, 'done');
    const refused = r.run(['phase', r.plan, '2']);
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /phase 1 is done/);
    assert.equal(branchNow(r), 'demo/01-core');
    for (const state of ['submitted', 'ready', 'merged']) {
      mark(r, 1, state);
      r.git('switch', '-q', 'demo/01-core');
      const res = r.run(['phase', r.plan, '2']);
      assert.equal(res.status, 0, `${state}: ${res.stderr}`);
      assert.equal(branchNow(r), 'demo/02-edge', state);
    }
  });
});

test('phase 1 refuses to leave a non-trunk branch that holds commits the trunk lacks', () => {
  // A run that began before stacked execution: its tasks were committed on an old feature branch.
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    r.git('switch', '-q', '-c', 'old-feature');
    r.commit('task1.txt', 'one\n', 'feat: task one');
    const tip = head(r);
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['phase', r.plan, '1']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /old-feature/);
    assert.equal(branchNow(r), 'old-feature', 'HEAD stays put');
    assert.equal(head(r), tip);
    assert.equal(r.git('branch', '--list', 'demo/01-core').trim(), '', 'no phase branch was created');
    assert.equal(readFileSync(r.statePath, 'utf8'), before, 'the state is untouched');
  });
  // A worktree branch with no commits beyond the trunk is the normal start.
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    r.git('switch', '-q', '-c', 'worktree-branch');
    const res = r.run(['phase', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(branchNow(r), 'demo/01-core');
  });
  // Phase 1's branch already existing (a resume) is never refused.
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('switch', '-q', '-c', 'elsewhere');
    r.commit('other.txt', 'x\n', 'other work');
    const res = r.run(['phase', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(branchNow(r), 'demo/01-core');
  });
});

test('phase ignores untracked files', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    writeFileSync(join(r.dir, 'scratch.txt'), 'scratch\n');
    const res = r.run(['phase', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(r.git('status', '--porcelain').trim(), '?? scratch.txt');
  });
});

test('phase checks out a remote-only branch tracking the remote', () => {
  withRig({ withGh: false }, (r) => {
    r.git('switch', '-q', '-c', 'demo/01-core');
    r.commit('core.txt', 'core\n', 'feat: core');
    r.git('push', '-q', 'origin', 'demo/01-core');
    r.git('switch', '-q', 'main');
    r.git('branch', '-q', '-D', 'demo/01-core');
    const remoteSha = head(r, 'refs/remotes/origin/demo/01-core');
    assert.notEqual(remoteSha, head(r, 'main'));
    r.json(r.run(['init', r.plan]));

    const res = r.run(['phase', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'demo/01-core\n');
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(head(r), remoteSha, 'the local branch is the remote one, not a new branch off the trunk');
    assert.equal(r.git('rev-parse', '--abbrev-ref', 'demo/01-core@{upstream}').trim(), 'origin/demo/01-core');
    assert.equal(r.state().phases[0].state, 'active');
  });
});

test('phase re-entered on an existing active branch just checks it out', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    r.commit('core.txt', 'core\n', 'feat: core');
    const tip = head(r);
    r.git('switch', '-q', 'main');

    const again = r.run(['phase', r.plan, '1']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, 'demo/01-core\n');
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(head(r), tip, 'the branch keeps its commits');
    assert.equal(r.state().phases[0].state, 'active');
    // Already on it: still a plain checkout.
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    assert.equal(head(r), tip);

    // A phase past active is never reopened, so its commits stay final (R1).
    mark(r, 1, 'submitted');
    const final = r.run(['phase', r.plan, '1']);
    assert.equal(final.status, 3, final.stderr);
    assert.match(final.stderr, /phase 1 is submitted/);
    assert.equal(r.state().phases[0].state, 'submitted');

    assert.equal(r.run(['phase', r.plan, '9']).status, 2, 'no such phase');
    assert.equal(r.run(['phase', r.plan]).status, 2, 'missing N');
  });
});

test('squash folds three commits into one', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const base = head(r);
    const authors = [
      { name: 'First Author', email: 'first@example.invalid', date: '2026-01-02T03:04:05+02:00' },
      { name: 'Second Author', email: 'second@example.invalid', date: '2026-02-03T04:05:06-03:00' },
      { name: 'Third Author', email: 'third@example.invalid', date: '2026-03-04T05:06:07+00:00' },
    ];
    commitAs(r, 'one.txt', 'one\n', 'feat: one\n\nThe first commit body.\n', authors[0]);
    const first = head(r);
    commitAs(r, 'two.txt', 'two\n', 'fixup! feat: one', authors[1]);
    commitAs(r, 'one.txt', 'one, fixed\n', 'fixup! feat: one', authors[2]);
    const dates = r.git('log', '--format=%aI', `${base}..HEAD`).trim().split('\n');
    assert.equal(new Set(dates).size, 3, 'the three author dates are distinct');
    const tree = head(r, 'HEAD^{tree}');

    failingPreCommitHook(r);
    const blocked = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'blocked'], { cwd: r.dir, env: r.env });
    assert.notEqual(blocked.status, 0, 'the hook does stop a git commit');

    const res = r.run(['squash', r.plan, base]);
    assert.equal(res.status, 0, res.stderr);
    const sha = res.stdout.trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(head(r), sha);
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(head(r, 'HEAD^{tree}'), tree, 'the tree is the pre-squash HEAD tree');
    assert.equal(show(r, '%P'), base, 'the only parent is BASE');
    assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '1');
    assert.equal(show(r, '%B'), show(r, '%B', first));
    assert.equal(show(r, '%B'), 'feat: one\n\nThe first commit body.');
    for (const field of ['%an', '%ae', '%aI']) {
      assert.equal(show(r, field), show(r, field, first), field);
    }
    assert.equal(show(r, '%an'), 'First Author');
    assert.equal(show(r, '%aI'), '2026-01-02T03:04:05+02:00');
    assert.equal(r.git('status', '--porcelain').trim(), '', 'the index and tree are unchanged');
    assert.doesNotMatch(res.stderr, /pre-commit hook ran/);
  });
});

test('squash of one commit is a no-op and of none prints no commits', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const base = head(r);

    const none = r.run(['squash', r.plan, base]);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, 'no commits\n');
    assert.equal(head(r), base);

    r.commit('one.txt', 'one\n', 'feat: one');
    const only = head(r);
    const one = r.run(['squash', r.plan, base]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout, `${only}\n`);
    assert.equal(head(r), only, 'one commit is left as it is');
  });
});

test('squash refuses a dirty tree, HEAD off the active phase branch, and BASE not an ancestor', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    r.git('switch', '-q', '-c', 'side');
    r.commit('side.txt', 'side\n', 'side');
    const side = head(r);
    r.git('switch', '-q', 'main');
    r.commit('trunk.txt', 'trunk\n', 'trunk');
    const belowTrunk = head(r, 'main~1');
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const base = head(r);
    r.commit('one.txt', 'one\n', 'feat: one');
    r.commit('two.txt', 'two\n', 'feat: two');
    const tip = head(r);
    const refused = (args, pattern, name) => {
      const res = r.run(['squash', r.plan, ...args]);
      assert.equal(res.status, 3, `${name}: ${res.stderr}`);
      assert.match(res.stderr, pattern, name);
      assert.equal(head(r, 'refs/heads/demo/01-core'), tip, `${name}: nothing rewritten`);
    };

    writeFileSync(join(r.dir, 'one.txt'), 'dirty\n');
    refused([base], /clean|uncommitted/, 'dirty tree');
    r.git('checkout', '--', 'one.txt');

    r.git('switch', '-q', 'main');
    refused([base], /not the active phase/, 'HEAD on the trunk');
    r.git('switch', '-q', '--detach', 'demo/01-core');
    refused([base], /not the active phase|detached/, 'detached HEAD');
    r.git('switch', '-q', 'demo/01-core');
    mark(r, 1, 'done');
    refused([base], /not the active phase/, 'phase 1 no longer active');
    mark(r, 1, 'active');

    refused([side], /not an ancestor/, 'BASE off the branch');
    refused([belowTrunk], /below the start of phase 1/, 'BASE below the phase start (phase 1: under the trunk fork point)');
    refused(['no-such-ref'], /not a commit/, 'BASE that does not resolve');
    refused(['--help'], /not a commit/, 'BASE that looks like an option');

    assert.equal(r.run(['squash', r.plan]).status, 2, 'missing BASE');
    assert.equal(r.run(['squash', r.plan, base]).status, 0, 'the same squash passes once the preconditions hold');
  });
  // Phase n > 1: a BASE under the predecessor's tip would fold phase 1's commits into phase 2's (R1).
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    const trunk = head(r, 'main');
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    r.commit('one.txt', 'one\n', 'feat: one');
    r.commit('two.txt', 'two\n', 'feat: two');
    const oneTip = head(r);
    mark(r, 1, 'submitted');
    assert.equal(r.run(['phase', r.plan, '2']).status, 0);
    r.commit('three.txt', 'three\n', 'feat: three');
    r.commit('four.txt', 'four\n', 'feat: four');
    const twoTip = head(r);
    for (const [below, name] of [[trunk, 'the trunk'], [`${oneTip}~1`, "inside phase 1"]]) {
      const res = r.run(['squash', r.plan, below]);
      assert.equal(res.status, 3, `${name}: ${res.stderr}`);
      assert.match(res.stderr, /below the start of phase 2/, name);
      assert.equal(head(r, 'refs/heads/demo/02-edge'), twoTip, `${name}: phase 2 not rewritten`);
      assert.equal(head(r, 'HEAD~2'), oneTip, `${name}: phase 2 still sits on phase 1's tip`);
    }
    assert.equal(head(r, 'refs/heads/demo/01-core'), oneTip);
    const ok = r.run(['squash', r.plan, oneTip]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(show(r, '%P'), oneTip, "BASE at phase 1's tip is the phase's own range");
  });
});

test('squash never adds untracked files', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const base = head(r);
    r.commit('one.txt', 'one\n', 'feat: one');
    r.commit('two.txt', 'two\n', 'feat: two');
    const tree = head(r, 'HEAD^{tree}');
    writeFileSync(join(r.dir, 'scratch.txt'), 'scratch\n');

    const res = r.run(['squash', r.plan, base]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(head(r, 'HEAD^{tree}'), tree);
    assert.doesNotMatch(r.git('ls-tree', '-r', '--name-only', 'HEAD'), /scratch\.txt/);
    assert.equal(r.git('status', '--porcelain').trim(), '?? scratch.txt');
  });
});

test('done marks the phase done', () => {
  withRig({ withGh: false }, (r) => {
    assert.equal(r.run(['done', r.plan, '1']).status, 3, 'no state file yet');
    r.json(r.run(['init', r.plan]));
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const res = r.run(['done', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'phase 1 done\n');
    assert.deepEqual(r.state().phases.map((p) => p.state), ['done', 'pending']);

    // Again on a done phase: a no-op.
    const again = r.run(['done', r.plan, '1']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, 'phase 1 done\n');
    assert.deepEqual(r.state().phases.map((p) => p.state), ['done', 'pending']);

    // Only an active phase becomes done: pending would deadlock the stack, later states would move back.
    const pending = r.run(['done', r.plan, '2']);
    assert.equal(pending.status, 3, pending.stderr);
    assert.match(pending.stderr, /phase 2 is pending/);
    assert.equal(r.state().phases[1].state, 'pending');
    for (const state of ['submitted', 'ready', 'merged']) {
      mark(r, 1, state);
      const res = r.run(['done', r.plan, '1']);
      assert.equal(res.status, 3, `${state}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`phase 1 is ${state}`), state);
      assert.equal(r.state().phases[0].state, state, state);
    }
    assert.equal(r.run(['done', r.plan, '9']).status, 2, 'no such phase');
    assert.equal(r.run(['done', r.plan, 'one']).status, 2, 'N is a number');
  });
});

// --- submit -----------------------------------------------------------------------------------------------------

const clearLog = (r) => rmSync(join(r.work, 'gh.log'), { force: true });
const stackCalls = (r) => r.ghLog().filter((argv) => argv[0] === 'stack' || (argv[0] === 'pr' && argv[1] === 'edit'));
const view = ['stack', 'view', '--json'];
const submitArgv = ['stack', 'submit', '--auto', '--remote', 'origin'];
const forcedFailure = { FAKE_GH_FAIL_STACK_SUBMIT: '1' };

// A GitHub-mode rig with the state initialised; fn gets it.
const withGithub = (fn, opts = {}) =>
  withRig(opts, (r) => {
    r.setUrl(GITHUB_URLS[0]);
    assert.equal(r.json(r.run(['init', r.plan])).mode, 'github');
    clearLog(r);
    fn(r);
  });

// Phase n entered, given one commit per subject and marked done.
const finishPhase = (r, n, ...subjects) => {
  const entered = r.run(['phase', r.plan, String(n)]);
  assert.equal(entered.status, 0, entered.stderr);
  for (const [i, subject] of (subjects.length ? subjects : [`feat: work ${n}`]).entries()) {
    r.commit(`p${n}-${i}.txt`, `${n}.${i}\n`, subject);
  }
  const done = r.run(['done', r.plan, String(n)]);
  assert.equal(done.status, 0, done.stderr);
};

const states = (r) => r.state().phases.map((p) => [p.state, p.pr]);
const addedFrom = (r) => readFileSync(`${join(r.work, 'membership')}.add-from`, 'utf8').trim().split('\n');

test('submit in local mode is a no-op that records done', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    finishPhase(r, 1);
    const res = r.run(['submit', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'local mode: nothing to submit\n');
    assert.equal(r.ghLog().length, 0);
    assert.deepEqual(states(r), [['done', null], ['pending', null]]);
    // --open in local mode: the phases are done, never submitted.
    finishPhase(r, 2);
    const open = r.run(['submit', r.plan, '2', '--open']);
    assert.equal(open.status, 0, open.stderr);
    assert.equal(open.stdout, 'local mode: nothing to submit\n');
    assert.deepEqual(states(r), [['done', null], ['done', null]]);
    assert.equal(r.ghLog().length, 0);
  });
});

test('submit refuses a phase that is not done, and --open refuses while any phase is not submitted or ready', () => {
  withGithub((r) => {
    for (const phase of [1, 2, 3]) {
      const res = r.run(['submit', r.plan, String(phase)]);
      assert.equal(res.status, phase === 3 ? 2 : 3, `${phase}: ${res.stderr}`);
    }
    assert.match(r.run(['submit', r.plan, '1']).stderr, /phase 1 is pending/);
    assert.equal(r.run(['submit', r.plan, 'one']).status, 2);
    assert.equal(r.run(['submit', r.plan, '1', '--sideways']).status, 2);
    assert.equal(r.run(['phase', r.plan, '1']).status, 0);
    const active = r.run(['submit', r.plan, '1']);
    assert.equal(active.status, 3, active.stderr);
    assert.match(active.stderr, /phase 1 is active/);

    r.commit('one.txt', '1\n', 'feat: one');
    assert.equal(r.run(['done', r.plan, '1']).status, 0);
    const doneOpen = r.run(['submit', r.plan, '1', '--open']);
    assert.equal(doneOpen.status, 3, doneOpen.stderr);
    assert.match(doneOpen.stderr, /phase 1 is done/);

    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    const pendingOpen = r.run(['submit', r.plan, '1', '--open']);
    assert.equal(pendingOpen.status, 3, pendingOpen.stderr);
    assert.match(pendingOpen.stderr, /phase 2 is pending/);
    assert.deepEqual(states(r), [['submitted', 7], ['pending', null]]);
    assert.equal(r.ghLog().filter((argv) => argv.includes('--open')).length, 0, 'a refusal calls no gh');
  });
});

test('submit refuses a dirty tree', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    writeFileSync(join(r.dir, r.plan), `${PHASED}\nedited\n`);
    const res = r.run(['submit', r.plan, '1']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /clean/);
    assert.equal(r.ghLog().length, 0);
  });
});

test('submit of phase 1 inits the stack, submits and fills the PR', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    const res = r.run(['submit', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 1: submitted (demo/01-core, PR #7 draft)\n');
    const calls = stackCalls(r);
    assert.equal(calls.length, 5, JSON.stringify(calls));
    assert.deepEqual(calls[0], view);
    assert.deepEqual(calls[1], ['stack', 'init', '--base', 'main', 'demo/01-core']);
    assert.deepEqual(calls[2], submitArgv);
    assert.deepEqual(calls[3], view);
    assert.deepEqual(calls[4].slice(0, 8), ['pr', 'edit', '7', '--repo', 'acme/demo', '--title', 'feat: core', '--body-file']);
    assert.equal(calls[4].length, 9);
    assert.match(calls[4][8], /\.methodology\/sdd\/phased-plan\/[^/]+$/);
    assert.equal(existsSync(calls[4][8]), true);
    assert.deepEqual(states(r), [['submitted', 7], ['pending', null]]);
    assert.equal(branchNow(r), 'demo/01-core');
    assert.equal(r.ghLog().filter((argv) => argv[1] === 'view' && argv[0] !== 'stack').length, 0);
  });
});

test('submit of phase 2 adds only demo/02-edge, from demo/01-core', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    clearLog(r);
    const res = r.run(['submit', r.plan, '2']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n');
    const calls = stackCalls(r);
    assert.deepEqual(calls.slice(0, 4), [view, ['stack', 'add', 'demo/02-edge'], submitArgv, view]);
    assert.deepEqual(calls[4].slice(0, 8), ['pr', 'edit', '8', '--repo', 'acme/demo', '--title', 'feat: edge', '--body-file']);
    assert.equal(calls.length, 5, JSON.stringify(calls));
    assert.equal(calls.filter((argv) => argv[1] === 'init').length, 0, 'no second stack init');
    assert.deepEqual(addedFrom(r), ['demo/02-edge demo/01-core']);
    assert.equal(branchNow(r), 'demo/02-edge');
    assert.deepEqual(states(r), [['submitted', 7], ['submitted', 8]]);
  });
});

test('a repeated submit adds nothing', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    // The add happened, then gh failed: nothing recorded, the call is repeated.
    const failed = r.run(['submit', r.plan, '2'], forcedFailure);
    assert.equal(failed.status, 5, failed.stderr);
    assert.deepEqual(addedFrom(r), ['demo/02-edge demo/01-core']);
    clearLog(r);
    const res = r.run(['submit', r.plan, '2']);
    assert.equal(res.status, 0, res.stderr);
    const calls = stackCalls(r);
    assert.deepEqual(calls.slice(0, 3), [view, submitArgv, view]);
    assert.deepEqual(calls[3].slice(0, 5), ['pr', 'edit', '8', '--repo', 'acme/demo']);
    assert.equal(calls.length, 4, JSON.stringify(calls));
    assert.deepEqual(addedFrom(r), ['demo/02-edge demo/01-core'], 'no second add');
    assert.equal(branchNow(r), 'demo/02-edge');
  });
  // The same for phase 1: the stack exists, the repeat does not init it again.
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1'], forcedFailure).status, 5);
    clearLog(r);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    const calls = stackCalls(r);
    assert.deepEqual(calls.slice(0, 3), [view, submitArgv, view]);
    assert.equal(calls.length, 4, JSON.stringify(calls));
  });
});

test('the PR body holds the slice, the stands-alone reason, the phase check and the commit subjects, and no attribution line', () => {
  withGithub((r) => {
    finishPhase(r, 1, 'feat: first subject', 'fix: second subject');
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    const bodyFile = r.ghLog().find((argv) => argv[1] === 'edit')[8];
    const body = readFileSync(bodyFile, 'utf8');
    assert.match(body, /S1/);
    assert.match(body, /core only/);
    assert.ok(body.includes('`true` → exit 0'), body);
    const subjects = r.git('log', '--format=%s', 'main..demo/01-core').trim().split('\n');
    assert.deepEqual(subjects.toSorted(), ['feat: first subject', 'fix: second subject']);
    for (const subject of subjects) assert.ok(body.includes(subject), `${subject}: ${body}`);
    assert.doesNotMatch(body, /Co-Authored-By|Claude-Session|Generated with/i);

    // Phase 2's body lists phase 2's commits only.
    finishPhase(r, 2, 'feat: edge subject');
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    const edge = readFileSync(r.ghLog().findLast((argv) => argv[1] === 'edit')[8], 'utf8');
    assert.ok(edge.includes('feat: edge subject'), edge);
    assert.ok(!edge.includes('feat: first subject'), edge);
    assert.match(edge, /S2/);
    assert.doesNotMatch(edge, /Co-Authored-By|Claude-Session|Generated with/i);
  });
});

test('submit --open passes --open and records every phase ready', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    clearLog(r);
    const res = r.run(['submit', r.plan, '2', '--open']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 1: ready (demo/01-core, PR #7)\nPhase 2: ready (demo/02-edge, PR #8)\n');
    const calls = stackCalls(r);
    assert.deepEqual(calls.slice(0, 3), [view, ['stack', 'submit', '--auto', '--open', '--remote', 'origin'], view]);
    assert.deepEqual(calls[3].slice(0, 5), ['pr', 'edit', '8', '--repo', 'acme/demo']);
    assert.equal(calls.length, 4, JSON.stringify(calls));
    assert.deepEqual(states(r), [['ready', 7], ['ready', 8]]);
    assert.equal(branchNow(r), 'demo/02-edge');
    // Ready phases are final: submit again with --open is allowed (every phase is ready), a plain submit is not.
    assert.equal(r.run(['submit', r.plan, '2']).status, 3);
  });
});

test('the stack link is read from gh stack submit stderr (the real tool prints nothing to stdout)', () => {
  const linked = (r, extraEnv) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    return r.run(['submit', r.plan, '2'], extraEnv);
  };
  // Default of the fake: the captured two-PR output on stderr, stdout empty.
  withGithub((r) => {
    assert.equal(linked(r, {}).stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n');
  });
  // The same output on stdout is a linked stack too.
  withGithub((r) => {
    assert.equal(linked(r, { FAKE_GH_SUBMIT_STDOUT: '1' }).stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n');
  });
  // The exact line the real v0.1.1 printed to stderr for a linked stack of three.
  withGithub((r) => {
    const real = join(r.work, 'submit-real.txt');
    writeFileSync(real, '✓ Stack on GitHub is up to date with 3 PRs (stack #9)\n');
    assert.equal(linked(r, { FAKE_GH_SUBMIT_OUT: real }).stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n');
  });
  // An unlinked stack still gets the suffix when the output is on stderr.
  withGithub((r) => {
    const bare = join(r.work, 'submit-bare.txt');
    writeFileSync(bare, 'Pushing to origin...\n');
    assert.match(linked(r, { FAKE_GH_SUBMIT_OUT: bare }).stdout, /; stack link missing\n$/);
  });
});

test('a PR without a stack link appends ; stack link missing', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    const one = r.run(['submit', r.plan, '1']);
    assert.equal(one.stdout, 'Phase 1: submitted (demo/01-core, PR #7 draft)\n', 'one PR cannot be stacked: no suffix');
    finishPhase(r, 2);
    const captured = readFileSync(join(FIXTURES, 'gh-stack', 'submit-2prs.txt'), 'utf8');
    assert.match(captured, /Stack created/);
    const unlinked = join(r.work, 'submit-unlinked.txt');
    writeFileSync(unlinked, captured.split('\n').filter((line) => !/Stack created/.test(line)).join('\n'));
    const res = r.run(['submit', r.plan, '2'], { FAKE_GH_SUBMIT_OUT: unlinked });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft); stack link missing\n');
    assert.deepEqual(states(r), [['submitted', 7], ['submitted', 8]]);
  });
  // Every success line of gh-stack v0.1.1 that says the stack is linked, and the captured two-PR output.
  const linkedLines = [
    'Stack #9 is already up to date',
    'Stack with 2 PRs is up to date',
    'Stack on GitHub is up to date with 2 PRs',
    'Updated stack to 2 PRs',
    'Created stack with 2 PRs',
    'Stack recreated on GitHub to match local state',
    'Stack created on GitHub with 2 PRs',
    'Stack synced on GitHub',
  ];
  for (const line of linkedLines) {
    withGithub((r) => {
      finishPhase(r, 1);
      assert.equal(r.run(['submit', r.plan, '1']).status, 0);
      finishPhase(r, 2);
      const linked = join(r.work, 'submit-linked.txt');
      writeFileSync(linked, `Checking stack state...\nPushing to origin...\n✓ ${line}\n✓ Pushed and synced 2 branches\n`);
      const res = r.run(['submit', r.plan, '2'], { FAKE_GH_SUBMIT_OUT: linked });
      assert.equal(res.stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n', line);
    });
  }
  // The captured two-PR output (the default of the fake) is a linked stack too, on a final --open submit.
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).stdout, 'Phase 2: submitted (demo/02-edge, PR #8 draft)\n');
    const open = r.run(['submit', r.plan, '2', '--open'], { FAKE_GH_SUBMIT_OUT: join(FIXTURES, 'gh-stack', 'submit-2prs.txt') });
    assert.equal(open.stdout, 'Phase 1: ready (demo/01-core, PR #7)\nPhase 2: ready (demo/02-edge, PR #8)\n');
  });
  // Two PRs and none of those lines: the suffix, also with --open.
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    const bare = join(r.work, 'submit-bare.txt');
    writeFileSync(bare, 'Checking stack state...\nPushing to origin...\n✓ Pushed and synced 2 branches\n');
    const open = r.run(['submit', r.plan, '2', '--open'], { FAKE_GH_SUBMIT_OUT: bare });
    assert.equal(open.stdout, 'Phase 1: ready (demo/01-core, PR #7)\nPhase 2: ready (demo/02-edge, PR #8); stack link missing\n');
  });
  // One PR never gets the suffix, whatever the output says.
  withGithub((r) => {
    finishPhase(r, 1);
    const bare = join(r.work, 'submit-bare.txt');
    writeFileSync(bare, 'Pushing to origin...\n');
    assert.equal(r.run(['submit', r.plan, '1'], { FAKE_GH_SUBMIT_OUT: bare }).stdout, 'Phase 1: submitted (demo/01-core, PR #7 draft)\n');
  });
  withGithub((r) => {
    finishPhase(r, 1);
    const one = join(FIXTURES, 'gh-stack', 'submit-1pr.txt');
    assert.equal(r.run(['submit', r.plan, '1'], { FAKE_GH_SUBMIT_OUT: one }).stdout, 'Phase 1: submitted (demo/01-core, PR #7 draft)\n');
  });
});

// A stack the plan does not own never reaches a gh write: gh stack submit pushes every member.
test('submit refuses a stack with a foreign member, an out-of-order membership or another trunk, before any gh write', () => {
  const cases = [
    ['a foreign member', 'main\ndemo/01-core\nother/feature\n', '1', /other\/feature/],
    ['a foreign member below the phases', 'main\nother/feature\ndemo/01-core\n', '1', /other\/feature/],
    ['an out-of-order membership', 'main\ndemo/02-edge\ndemo/01-core\n', '1', /demo\/02-edge/],
    ['another trunk', 'develop\ndemo/01-core\n', '1', /develop/],
  ];
  for (const [name, membership, phase, message] of cases) {
    withGithub((r) => {
      finishPhase(r, 1);
      r.git('switch', '--quiet', 'demo/01-core');
      writeFileSync(join(r.work, 'membership'), membership);
      const before = readFileSync(r.statePath, 'utf8');
      clearLog(r);
      const res = r.run(['submit', r.plan, phase]);
      assert.equal(res.status, 3, `${name}: ${res.stderr}`);
      assert.match(res.stderr, message, name);
      const writes = r.ghLog().filter(
        (argv) => (argv[0] === 'stack' && argv[1] !== 'view') || (argv[0] === 'pr' && argv[1] === 'edit'),
      );
      assert.deepEqual(writes, [], `${name}: no gh write`);
      assert.equal(readFileSync(r.statePath, 'utf8'), before, `${name}: nothing recorded`);
    });
  }
  // This plan's own prefix, in phase order from phase 1, and the plan's trunk: accepted.
  withGithub((r) => {
    finishPhase(r, 1);
    writeFileSync(join(r.work, 'membership'), 'main\ndemo/01-core\n');
    const res = r.run(['submit', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(r.ghLog().filter((argv) => argv[1] === 'init').length, 0);
  });
});

test('a failing gh exits 5 and records nothing', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['submit', r.plan, '2'], forcedFailure);
    assert.equal(res.status, 5, res.stderr);
    assert.match(res.stderr, /forced failure of: stack submit/);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.equal(r.state().phases[1].state, 'done');
    assert.equal(branchNow(r), 'demo/02-edge', 'HEAD is back on the phase branch');

    // pr edit failing, after a successful submit: still nothing recorded.
    clearLog(r);
    const edit = r.run(['submit', r.plan, '2'], { FAKE_GH_FAIL_PR_EDIT: '1' });
    assert.equal(edit.status, 5, edit.stderr);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
  // A gh that cannot show the stack after submit.
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1'], { FAKE_GH_FAIL_STACK_VIEW: '1' }).status, 5);
    assert.equal(r.state().phases[0].state, 'done');
  });
});

test("the fake gh's stack view has the shape of the real two-PR capture", () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    const mine = JSON.parse(execFileSync('gh', ['stack', 'view', '--json'], { cwd: r.dir, env: r.env, encoding: 'utf8' }));
    const real = JSON.parse(readFileSync(join(FIXTURES, 'gh-stack', 'view-2prs.json'), 'utf8'));
    const keys = (o) => Object.keys(o).filter((k) => k !== 'head').sort();
    assert.deepEqual(keys(mine), keys(real));
    assert.deepEqual(keys(mine.branches[1]), keys(real.branches[1]));
    assert.deepEqual(keys(mine.branches[1].pr), keys(real.branches[1].pr));
    assert.equal(mine.branches.length, real.branches.length);
  });
});

// --- push -------------------------------------------------------------------------------------------------------

test('push in local mode is a no-op, whatever the phase state', () => {
  withRig({ withGh: false }, (r) => {
    r.json(r.run(['init', r.plan]));
    finishPhase(r, 1);
    const res = r.run(['push', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'local mode: nothing pushed\n');
    assert.equal(r.ghLog().length, 0);
    assert.deepEqual(states(r), [['done', null], ['pending', null]]);
  });
});

test('push refuses a phase that was never submitted, a merged one, a dirty tree and bad arguments', () => {
  withGithub((r) => {
    for (const state of ['pending', 'active', 'done']) {
      mark(r, 1, state);
      const res = r.run(['push', r.plan, '1']);
      assert.equal(res.status, 3, `${state}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`phase 1 is ${state}`));
    }
    mark(r, 1, 'merged');
    assert.equal(r.run(['push', r.plan, '1']).status, 3, 'a merged phase is final');
    assert.equal(r.run(['push', r.plan, 'one']).status, 2);
    assert.equal(r.run(['push', r.plan, '9']).status, 2);
    assert.equal(r.run(['push', r.plan, '1', '--open']).status, 2);
    assert.equal(r.ghLog().length, 0, 'a refusal calls no gh');

    mark(r, 1, 'pending');
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    writeFileSync(join(r.dir, r.plan), `${PHASED}\nedited\n`);
    clearLog(r);
    const dirty = r.run(['push', r.plan, '1']);
    assert.equal(dirty.status, 3, dirty.stderr);
    assert.match(dirty.stderr, /clean/);
    assert.equal(r.ghLog().length, 0);
  });
});

test('push of a submitted draft phase submits the stack and refreshes the body, never marking it ready', () => {
  withGithub((r) => {
    finishPhase(r, 1, 'feat: first subject');
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    r.commit('review-fix.txt', 'fix\n', 'fix: review feedback');
    clearLog(r);
    const res = r.run(['push', r.plan, '1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 1: pushed (demo/01-core, PR #7)\n');
    const calls = stackCalls(r);
    assert.equal(calls.length, 4, JSON.stringify(calls));
    assert.deepEqual(calls.slice(0, 3), [view, submitArgv, view]);
    assert.deepEqual(calls[3].slice(0, 6), ['pr', 'edit', '7', '--repo', 'acme/demo', '--body-file']);
    assert.equal(calls[3].length, 7, 'the title is left as it is');
    const body = readFileSync(calls[3][6], 'utf8');
    assert.ok(body.includes('feat: first subject') && body.includes('fix: review feedback'), body);
    assert.equal(r.ghLog().filter((argv) => argv.includes('ready') || argv.includes('--open') || argv.includes('--draft')).length, 0);
    assert.deepEqual(states(r), [['submitted', 7], ['pending', null]]);
    assert.equal(branchNow(r), 'demo/01-core');
  });
});

test('push of phase 2 adds nothing to the stack and keeps a ready phase ready', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    mark(r, 2, 'ready');
    r.git('switch', '--quiet', 'demo/01-core');
    clearLog(r);
    const res = r.run(['push', r.plan, '2']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 2: pushed (demo/02-edge, PR #8)\n');
    const calls = stackCalls(r);
    assert.deepEqual(calls.slice(0, 3), [view, submitArgv, view]);
    assert.deepEqual(calls[3].slice(0, 6), ['pr', 'edit', '8', '--repo', 'acme/demo', '--body-file']);
    assert.equal(calls.length, 4, JSON.stringify(calls));
    assert.deepEqual(addedFrom(r), ['demo/02-edge demo/01-core'], 'no second add');
    assert.deepEqual(states(r), [['submitted', 7], ['ready', 8]]);
    assert.equal(branchNow(r), 'demo/02-edge');
    assert.equal(r.ghLog().filter((argv) => argv.includes('ready')).length, 0);
  });
});

test('a failing gh during push exits 5, records nothing and puts HEAD back', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    r.git('switch', '--quiet', 'main');
    const before = readFileSync(r.statePath, 'utf8');
    const res = r.run(['push', r.plan, '1'], forcedFailure);
    assert.equal(res.status, 5, res.stderr);
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
    assert.equal(branchNow(r), 'main');
  });
});

test('push guards both halves: a merged phase with a PR and a submitted phase without one are refused', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    const setPhase = (fields) => {
      const s = r.state();
      Object.assign(s.phases[0], fields);
      writeFileSync(r.statePath, `${JSON.stringify(s, null, 2)}\n`);
    };
    clearLog(r);
    setPhase({ state: 'merged', pr: 7 });
    const merged = r.run(['push', r.plan, '1']);
    assert.equal(merged.status, 3, merged.stderr);
    assert.match(merged.stderr, /phase 1 is merged/);
    setPhase({ state: 'submitted', pr: null });
    const noPr = r.run(['push', r.plan, '1']);
    assert.equal(noPr.status, 3, noPr.stderr);
    assert.match(noPr.stderr, /phase 1 is submitted/);
    assert.equal(r.ghLog().length, 0, 'a refusal calls no gh');
  });
});

test('push exits 5 naming both numbers when the stack shows another PR than the recorded one, editing nothing', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    const s = r.state();
    s.phases[0].pr = 99;
    writeFileSync(r.statePath, `${JSON.stringify(s, null, 2)}\n`);
    const before = readFileSync(r.statePath, 'utf8');
    clearLog(r);
    const res = r.run(['push', r.plan, '1']);
    assert.equal(res.status, 5, res.stderr);
    assert.match(res.stderr, /#99/);
    assert.match(res.stderr, /#7/);
    assert.equal(r.ghLog().filter((argv) => argv[0] === 'pr' && argv[1] === 'edit').length, 0, 'no PR body is edited');
    assert.equal(readFileSync(r.statePath, 'utf8'), before);
  });
});

test('push keeps submit\'s ; stack link missing suffix', () => {
  withGithub((r) => {
    finishPhase(r, 1);
    assert.equal(r.run(['submit', r.plan, '1']).status, 0);
    finishPhase(r, 2);
    assert.equal(r.run(['submit', r.plan, '2']).status, 0);
    const bare = join(r.work, 'submit-bare.txt');
    writeFileSync(bare, 'Checking stack state...\nPushing to origin...\n');
    const res = r.run(['push', r.plan, '2'], { FAKE_GH_SUBMIT_OUT: bare });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'Phase 2: pushed (demo/02-edge, PR #8); stack link missing\n');
    // A linked stack (the fake's captured output) prints no suffix.
    assert.equal(r.run(['push', r.plan, '2']).stdout, 'Phase 2: pushed (demo/02-edge, PR #8)\n');
  });
});
