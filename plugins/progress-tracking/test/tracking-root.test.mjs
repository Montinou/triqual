// TRIQUAL_TRACKING_ROOT: `triqual tasks` and `triqual tracking` resolve the tracking from the named root while the
// working directory is a plain clone; `tracking hook …` and a run without the variable are unchanged. Every test runs in
// temp dirs with a temp HOME and TRIQUAL_TRACKING_DB; no test touches a real data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore, repoKey } from '../lib/store.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(PLUGIN, 'cli', 'tasks.mjs');
const TRACKING = join(PLUGIN, 'cli', 'tracking.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NAME = '2026-11-03-example';
const PLAN = '# Example plan\n\n### Task 1: Alpha\n';

await loadSqlite();

const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT']) delete env[k];
  return { ...env, ...extra };
};

const initRepo = (path) => {
  mkdirSync(path);
  const g = (...args) => execFileSync('git', [...ID, ...args], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q');
  writeFileSync(join(path, 'README.md'), '# repo\n');
  g('add', 'README.md');
  g('commit', '-qm', 'initial');
  return g;
};

// A temp dir with a store-mode `root` (the plan registered, T1 started), a plain `clone` beside it and a temp HOME.
function withRootAndClone(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-root-')));
  const home = join(dir, 'home');
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') };
  mkdirSync(home);
  const root = join(dir, 'root');
  const clone = join(dir, 'clone');
  const rootGit = initRepo(root);
  const cloneGit = initRepo(clone);
  rootGit('config', '--local', 'triqual.tracking', 'store');
  openStore({ home, env: dbEnv, create: true }).close();
  const plansDir = join(dir, 'data', 'repos', repoKey(rootGit('rev-parse', '--path-format=absolute', '--git-common-dir')), 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, `${NAME}.md`), PLAN);
  const run = (bin, args, { cwd = clone, env = {} } = {}) => spawnSync(process.execPath, [bin, ...args], {
    cwd, env: cleanEnv(home, { ...dbEnv, ...env }), encoding: 'utf8',
  });
  const withVar = { TRIQUAL_TRACKING_ROOT: root };
  const setup = run(TASKS, ['init', join(plansDir, `${NAME}.md`)], { cwd: root });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(run(TASKS, ['start', 'T1'], { cwd: root }).status, 0);
  const commits = () => {
    const store = openStore({ home, env: dbEnv });
    try {
      return store.ledgerOf(store.plans(store.get('SELECT id FROM repos').id)[0].id).tasks[0].commits;
    } finally {
      store.close();
    }
  };
  try {
    return fn({ dir, root, clone, rootGit, cloneGit, run, withVar, commits });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('paths from a clone with the variable', () => {
  withRootAndClone(({ root, clone, run, withVar }) => {
    const r = run(TASKS, ['paths', '--json'], { env: withVar });
    assert.equal(r.status, 0, r.stderr);
    const paths = JSON.parse(r.stdout);
    assert.equal(paths.optedIn, true);
    assert.equal(paths.mode, 'store');
    assert.equal(paths.root, root);
    assert.equal(paths.workRepo, clone);
    const fromRoot = JSON.parse(run(TASKS, ['paths', '--json'], { cwd: root, env: withVar }).stdout);
    assert.equal(fromRoot.workRepo, null, 'the cwd is the root itself');
  });
});

test('paths without it is unchanged (exit 2)', () => {
  withRootAndClone(({ run }) => {
    const r = run(TASKS, ['status']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not opted in/);
    const paths = JSON.parse(run(TASKS, ['paths', '--json']).stdout);
    assert.equal(paths.optedIn, false);
    assert.equal('workRepo' in paths, false);
    assert.equal(run(TRACKING, ['log']).status, 2);
  });
});

test('a root that is not opted in is exit 2 naming the variable', () => {
  withRootAndClone(({ dir, clone, run }) => {
    const plain = join(dir, 'plain');
    initRepo(plain);
    for (const bin of [TASKS, TRACKING]) {
      const args = bin === TASKS ? ['paths', '--json'] : ['log'];
      const r = run(bin, args, { cwd: clone, env: { TRIQUAL_TRACKING_ROOT: plain } });
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr, new RegExp(`TRIQUAL_TRACKING_ROOT ${plain}: not opted in`));
    }
    const missing = run(TASKS, ['status'], { env: { TRIQUAL_TRACKING_ROOT: join(dir, 'nope') } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /TRIQUAL_TRACKING_ROOT .*nope: not a git repository/);
  });
});

test('tracking hook pre-commit ignores the variable', () => {
  withRootAndClone(({ clone, run, withVar }) => {
    const r = run(TRACKING, ['hook', 'pre-commit'], { env: withVar });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not in store mode/);
    assert.doesNotMatch(r.stderr, /TRIQUAL_TRACKING_ROOT/);
    const view = run(TRACKING, ['log'], { env: withVar });
    assert.equal(view.status, 0, view.stderr);
    assert.ok(clone);
  });
});

test('done from a clone records ext:<path>@<sha>', () => {
  withRootAndClone(({ cloneGit, run, withVar, commits }) => {
    const sha = cloneGit('rev-parse', 'HEAD');
    const r = run(TASKS, ['done', 'T1', '--commit', 'HEAD'], { env: withVar });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'T1: in_progress -> done\n');
    assert.deepEqual(commits(), [`ext:../clone@${sha}`]);
  });
});

test('done --repo wins', () => {
  withRootAndClone(({ dir, rootGit, run, withVar, commits }) => {
    const other = join(dir, 'other');
    const otherGit = initRepo(other);
    const sha = otherGit('rev-parse', 'HEAD');
    const r = run(TASKS, ['done', 'T1', '--commit', sha, '--repo', other], { env: withVar });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(commits(), [`ext:../other@${sha}`]);
    assert.ok(rootGit('rev-parse', 'HEAD'));
  });
});

test('a rev missing in the clone is refused', () => {
  withRootAndClone(({ rootGit, run, withVar, commits }) => {
    writeFileSync(join(rootGit('rev-parse', '--show-toplevel'), 'more.txt'), 'x\n');
    rootGit('add', 'more.txt');
    rootGit('commit', '-qm', 'only in the root');
    const r = run(TASKS, ['done', 'T1', '--commit', rootGit('rev-parse', 'HEAD')], { env: withVar });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not resolve/);
    assert.deepEqual(commits(), []);
  });
});

const DRAFT = [
  '## 2026-11-03 — Alpha done', '- **Stage/task:** Plan example · T1', '- **Done:** did it', '- **Files:** a.txt',
  '- **Verification:** ok', '- **Next:** none', '',
].join('\n');
const entryCommits = (dir) => {
  const store = openStore({ home: join(dir, 'home'), env: { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') } });
  try {
    return store.all('SELECT state, commit_sha FROM entries ORDER BY id').map((r) => [r.state, r.commit_sha]);
  } finally {
    store.close();
  }
};

test('add --commit from a clone stores ext:<path>@<sha>', () => {
  withRootAndClone(({ dir, cloneGit, run, withVar }) => {
    const draft = join(dir, 'draft.md');
    writeFileSync(draft, DRAFT);
    const sha = cloneGit('rev-parse', 'HEAD');
    const r = run(TRACKING, ['add', draft, '--commit', 'HEAD'], { env: withVar });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(entryCommits(dir), [['committed', `ext:../clone@${sha}`]]);
  });
});

test('add --no-commit from a clone is recorded without a commit', () => {
  withRootAndClone(({ dir, run, withVar }) => {
    const draft = join(dir, 'draft.md');
    writeFileSync(draft, DRAFT);
    const r = run(TRACKING, ['add', draft, '--no-commit'], { env: withVar });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(entryCommits(dir), [['no_commit', null]]);
  });
});

test('add without --commit or --no-commit from a clone is exit 2', () => {
  withRootAndClone(({ dir, run, withVar }) => {
    const draft = join(dir, 'draft.md');
    writeFileSync(draft, DRAFT);
    const r = run(TRACKING, ['add', draft], { env: withVar });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /add from a work repository needs --commit or --no-commit/);
    assert.deepEqual(entryCommits(dir), []);
  });
});

test('add in the root with the variable unset is unchanged', () => {
  withRootAndClone(({ dir, root, rootGit, run }) => {
    const draft = join(dir, 'draft.md');
    writeFileSync(draft, DRAFT);
    const sha = rootGit('rev-parse', 'HEAD');
    assert.equal(run(TRACKING, ['add', draft], { cwd: root }).status, 0);
    assert.equal(run(TRACKING, ['add', draft, '--commit', 'HEAD'], { cwd: root }).status, 0);
    assert.deepEqual(entryCommits(dir), [['pending', null], ['committed', sha]]);
  });
});

test('log, log --json, status and reconcile over ext entries exit 0', () => {
  withRootAndClone(({ dir, cloneGit, run, withVar }) => {
    const draft = join(dir, 'draft.md');
    writeFileSync(draft, DRAFT);
    const sha = cloneGit('rev-parse', 'HEAD');
    assert.equal(run(TRACKING, ['add', draft, '--commit', 'HEAD'], { env: withVar }).status, 0);
    const before = run(TASKS, ['reconcile', '--json'], { env: withVar });
    assert.equal(before.status, 0, before.stderr);
    assert.equal(run(TASKS, ['reconcile'], { env: withVar }).status, 0);
    const applied = run(TASKS, ['reconcile', '--apply', '--json'], { env: withVar });
    assert.equal(applied.status, 0, applied.stderr);
    assert.ok(Array.isArray(JSON.parse(applied.stdout)));
    assert.equal(run(TASKS, ['done', 'T1', '--commit', 'HEAD'], { env: withVar }).status, 0);
    const log = run(TRACKING, ['log'], { env: withVar });
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /Alpha done/);
    const json = run(TRACKING, ['log', '--json'], { env: withVar });
    assert.equal(json.status, 0, json.stderr);
    assert.ok(JSON.parse(json.stdout), 'log --json parses');
    assert.match(json.stdout, new RegExp(`ext:\\.\\./clone@${sha}`));
    for (const args of [['status'], ['status', '--json']]) {
      const s = run(TRACKING, args, { env: withVar });
      assert.equal(s.status, 0, s.stderr);
    }
    const rec = run(TASKS, ['reconcile', '--json'], { env: withVar });
    assert.equal(rec.status, 0, rec.stderr);
    assert.doesNotMatch(rec.stderr, /does not resolve|not a commit/);
  });
});
