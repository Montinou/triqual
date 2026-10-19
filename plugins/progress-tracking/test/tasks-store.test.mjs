// `triqual tasks …` and `triqual tracking write plan` on a store-mode repository (plan tracking-store-1 T5). Every test
// runs in a temp repo marked for store mode, with a temp HOME and TRIQUAL_TRACKING_DB pointing into the temp dir; no
// test touches a real data directory. The committed-mode repo of the same plan is the reference for every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSqlite, openStore, repoKey } from '../lib/store.mjs';
import { SNAPSHOT_SCHEMA, buildSnapshot } from '../lib/snapshot.mjs';
import { resolveTracking } from '../lib/tracking.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(PLUGIN, 'cli', 'tasks.mjs');
const TRACKING = join(PLUGIN, 'cli', 'tracking.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
// A Node 22 binary for the variants that run on it; TRIQUAL_TEST_NODE22 overrides the Homebrew location.
const NODE22 = process.env.TRIQUAL_TEST_NODE22 ?? '/opt/homebrew/opt/node@22/bin/node';
const NAME = '2026-10-11-example';
const HINT = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const HOOK_LINES = {
  'pre-commit': 'node "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" || exit 1',
  'post-commit': 'node "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" --post-commit',
};
const PLAN = `# Example plan

### Task 1: Alpha

### Task 2: Beta

### Task 3: Gamma
**Depends on:** T1
`;

await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

// A clean environment: no inherited GIT_* repo selection, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB']) delete env[k];
  return { ...env, ...extra };
};

// A temp dir with a repo (one commit), a HOME and the store env. `mode` is 'store' (marked, database created) or
// 'committed' (progress.md and status.md at the root, the plan under docs/plans).
function withRepo(mode, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-tstore-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const dataDir = join(dir, 'data');
  for (const d of [repo, home]) mkdirSync(d);
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db') };
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git('commit', '-qm', 'initial');
  let plansDir;
  if (mode === 'store') {
    git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
    plansDir = join(dataDir, 'repos', repoKey(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'plans');
  } else {
    writeFileSync(join(repo, 'progress.md'), '# Progress\n');
    writeFileSync(join(repo, 'status.md'), '# Status\n\n**Last updated:** today\n');
    plansDir = join(repo, 'docs', 'plans');
    git('add', 'progress.md', 'status.md');
    git('commit', '-qm', 'track');
  }
  mkdirSync(plansDir, { recursive: true });
  const run = (args, { bin = TASKS, node = process.execPath, extraEnv = {}, cwd = repo } = {}) => spawnSync(node, [bin, ...args], {
    cwd, env: cleanEnv(home, { ...dbEnv, ...extraEnv }), encoding: 'utf8',
  });
  const plan = (text = PLAN, name = NAME) => {
    writeFileSync(join(plansDir, `${name}.md`), text);
    return join(plansDir, `${name}.md`);
  };
  // Every path under .git with its size and mtime, the index (which any git command may refresh) left out.
  const gitListing = () => {
    const list = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, e.name);
        if (path === join(repo, '.git', 'index') || path === join(repo, '.git', 'index.lock')) continue;
        const st = statSync(path);
        list.push(`${path.slice(repo.length)} ${e.isDirectory() ? 'dir' : `${st.size} ${st.mtimeMs}`}`);
        if (e.isDirectory()) walk(path);
      }
    };
    walk(join(repo, '.git'));
    return list.sort();
  };
  const inStore = (f) => {
    const store = openStore({ home, env: dbEnv });
    try { return f(store); } finally { store.close(); }
  };
  try {
    return fn({ dir, repo, home, dataDir, plansDir, git, run, plan, gitListing, inStore, dbEnv });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
const refused = (r, pattern) => {
  assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, pattern);
};

// The same commands in a store repo and in a committed repo of the same plan; each [args, check] pair is run in both and
// the outputs compared (stdout and exit code), `check` being a transform of the stdout for the paths that differ.
const sameOutputs = (store, committed, calls) => {
  for (const args of calls) {
    const a = store.run(args);
    const b = committed.run(args);
    assert.equal(a.status, b.status, `${args.join(' ')}: exit ${a.status} vs ${b.status}\n${a.stderr}\n${b.stderr}`);
    assert.equal(a.stdout, b.stdout, `${args.join(' ')}: stdout`);
    assert.equal(a.stderr, b.stderr, `${args.join(' ')}: stderr`);
  }
};

// ---- lifecycle ----

test('a plan in the documents directory goes through init, start, review, done, next and status like a committed one', () => {
  withRepo('store', (s) => withRepo('committed', (c) => {
    s.plan();
    c.plan();
    const before = s.gitListing();
    const sInit = ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    ok(c.run(['init', `docs/plans/${NAME}.md`]));
    assert.match(sInit.stdout, new RegExp(`^created .*${NAME}\\.md\\n$`));

    sameOutputs(s, c, [['status'], ['next'], ['start', 'T1'], ['start', 'T1'], ['status'], ['review', 'T1'], ['rework', 'T1']]);
    sameOutputs(s, c, [['review', 'T1']]);
    const shaS = s.git('rev-parse', 'HEAD');
    const shaC = c.git('rev-parse', 'HEAD');
    const doneS = ok(s.run(['done', 'T1', '--commit', shaS]));
    const doneC = ok(c.run(['done', 'T1', '--commit', shaC]));
    assert.equal(doneS.stdout, doneC.stdout);
    sameOutputs(s, c, [['done', 'T1', '--commit', 'HEAD'], ['next'], ['status'], ['start', 'T2'], ['block', 'T2', 'waiting'], ['status'],
      ['start', 'T2'], ['retitle', 'T2', 'Beta two'], ['retitle', 'T2', 'Beta two'], ['drop', 'T3', 'not needed'], ['restore', 'T3'],
      ['reopen', 'T1', 'sha lost'], ['next']]);

    // The store holds the ledger; the working tree and the git dir hold nothing.
    s.inStore((store) => {
      const [p] = store.plans(store.get('SELECT id FROM repos').id);
      const ledger = store.ledgerOf(p.id);
      assert.equal(ledger.tasks.find((x) => x.id === 'T1').status, 'in_progress');
      assert.equal(ledger.tasks.find((x) => x.id === 'T2').title, 'Beta two');
      assert.deepEqual(ledger.tasks.find((x) => x.id === 'T1').commits, [shaS]);
      assert.equal(ledger.tasks.find((x) => x.id === 'T2').history.at(-1).note, 'retitle: Beta -> Beta two');
    });
    assert.equal(s.git('status', '--porcelain'), '');
    assert.deepEqual(s.gitListing(), before, 'no file under .git changed or appeared');
    assert.ok(!existsSync(join(s.repo, 'status.md')));
    assert.ok(!readdirSync(s.plansDir).some((f) => f.endsWith('.tasks.json')), 'the store is the ledger: no ledger file');
  }));
});

test('status --json, next --plan and close work on the store; close of a finished plan repeats', () => {
  withRepo('store', (s) => {
    s.plan(`### Task 1: Only\n`);
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    const j = JSON.parse(ok(s.run(['status', '--json'])).stdout);
    assert.equal(j.length, 1);
    assert.equal(j[0].name, NAME);
    assert.deepEqual({ ...j[0], ledgerPath: undefined }, {
      name: NAME, ledgerPath: undefined, done: 0, total: 1, inProgress: [], next: 'T1',
      tiers: { T1: { tier: null, effectiveTier: null } },
    });
    assert.equal(ok(s.run(['next', '--plan', NAME])).stdout, 'T1 Only [roles:tdd-implementer]\n');
    refused(s.run(['close']), /plan has unfinished tasks: T1/);
    ok(s.run(['start', 'T1']));
    ok(s.run(['done', 'T1', '--commit', 'HEAD']));
    assert.equal(ok(s.run(['close'])).stdout, 'plan: active -> done\n');
    assert.equal(ok(s.run(['close'])).stdout, 'plan: already done\n');
    assert.equal(ok(s.run(['status'])).stdout, '');
    refused(s.run(['next']), /no active ledger/);
  });
});

test('--plan names a plan by its file name, with or without extension, by a path or by its stored path', () => {
  withRepo('store', (s) => {
    s.plan(`### Task 1: Only\n`, 'a-plan');
    s.plan(`### Task 1: Other\n`, 'b-plan');
    ok(s.run(['init', join(s.plansDir, 'a-plan.md')]));
    ok(s.run(['init', join(s.plansDir, 'b-plan.md')]));
    refused(s.run(['next']), /2 active ledgers; pick one with --plan/);
    for (const plan of ['a-plan', 'a-plan.md', join(s.plansDir, 'a-plan.md'), 'plans/a-plan.md']) {
      assert.equal(ok(s.run(['next', '--plan', plan])).stdout, 'T1 Only [roles:tdd-implementer]\n', plan);
    }
    refused(s.run(['next', '--plan', 'nope']), /no ledger/);
    assert.equal(ok(s.run(['start', 'T1', '--plan', 'b-plan'])).stdout, 'T1: pending -> in_progress\n');
    assert.equal(ok(s.run(['next', '--plan', 'a-plan'])).stdout, 'T1 Only [roles:tdd-implementer]\n');
  });
});

test('--plan matches an imported plan by its stored docs/plans path as well as by file name', () => {
  withRepo('store', (s) => {
    s.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    // An imported plan keeps the path it had in the repository.
    s.inStore((store) => store.db.exec(`UPDATE plans SET path = 'docs/plans/${NAME}.md'`));
    for (const plan of [`docs/plans/${NAME}.md`, `${NAME}.md`, NAME]) {
      assert.equal(ok(s.run(['next', '--plan', plan])).stdout, 'T1 Alpha [roles:tdd-implementer]\n', plan);
    }
    assert.equal(ok(s.run(['start', 'T1', '--plan', `docs/plans/${NAME}.md`])).stdout, 'T1: pending -> in_progress\n');
    refused(s.run(['next', '--plan', `docs/plans/other.md`]), /no ledger/);
  });
});

test('init reconciles an edited plan and refuses a plan outside the documents directory', () => {
  withRepo('store', (s) => {
    const file = s.plan();
    ok(s.run(['init', file]));
    writeFileSync(file, `${PLAN}\n### Task 4: Delta\n`);
    const again = ok(s.run(['init', file]));
    assert.match(again.stdout, /^reconciled .*: added T4; missing none; retitled none\n$/);
    const elsewhere = join(s.dir, 'elsewhere.md');
    writeFileSync(elsewhere, PLAN);
    refused(s.run(['init', elsewhere]), /plan must be in/);
    refused(s.run(['init', join(s.plansDir, 'missing.md')]), /not found/);
    // --adopt lands a draft from anywhere in the documents directory, as in the other modes.
    const adopted = ok(s.run(['init', '--adopt', elsewhere]));
    assert.match(adopted.stdout, /^created /);
    assert.ok(existsSync(join(s.plansDir, 'elsewhere.md')));
  });
});

test('a mostly heavy plan registered in the store gets the heavy-tier warning, and is stored as usual', () => {
  withRepo('store', (s) => {
    const heavy = Array.from({ length: 5 }, (_, i) => `### Task ${i + 1}: T${i + 1}\n**Tier:** heavy\n`).join('\n');
    const file = s.plan(`# p\n\n${heavy}`);
    const r = ok(s.run(['init', file]));
    assert.match(r.stdout, /^created /);
    assert.match(r.stderr, /^warning: 5 of 5 tasks are heavy \(100%\): heavy review costs the most; re-check each tier \(see the tier rules in methodology:writing-plans\)$/m);
    assert.equal(ok(s.run(['init', file])).stderr, '', 'a reconcile does not warn again');
  });
});

// ---- failures ----

test('an invalid transition exits 2 with the committed-mode message', () => {
  withRepo('store', (s) => withRepo('committed', (c) => {
    s.plan();
    c.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    ok(c.run(['init', `docs/plans/${NAME}.md`]));
    for (const args of [['review', 'T1'], ['done', 'T1', '--commit', 'HEAD'], ['start', 'T3'], ['start', 'T9'], ['done', 'T1'],
      ['done', 'T1', '--commit', 'nonsense'], ['block', 'T1'], ['frobnicate', 'T1']]) {
      const a = s.run(args);
      const b = c.run(args);
      assert.equal(a.status, 2, args.join(' '));
      assert.equal(a.status, b.status);
      assert.equal(a.stderr, b.stderr, args.join(' '));
      assert.equal(a.stdout, b.stdout);
    }
    assert.match(s.run(['review', 'T1']).stderr, /^T1 is pending; cannot review\n$/);
  }));
});

test('a missing store database fails with the restore hint and creates nothing', () => {
  withRepo('store', (s) => {
    rmSync(join(s.dataDir, 'tracking.db'));
    for (const args of [['status'], ['start', 'T1'], ['render'], ['check']]) {
      refused(s.run(args), /triqual tracking restore/);
    }
    assert.ok(!existsSync(join(s.dataDir, 'tracking.db')));
    // line never fails and prints nothing
    const line = s.run(['line']);
    assert.equal(line.status, 0);
    assert.equal(line.stdout, '');
    assert.equal(line.stderr, '');
  });
});

// ---- paths, render, check ----

test('paths --json reports the store shape', () => withRepo('store', (s) => {
  const j = JSON.parse(ok(s.run(['paths', '--json'])).stdout);
  const docs = join(s.dataDir, 'repos', repoKey(join(s.repo, '.git')));
  assert.deepEqual(j, {
    optedIn: true,
    mode: 'store',
    root: s.repo,
    specsDir: join(docs, 'specs'),
    plansDir: join(docs, 'plans'),
    store: join(s.dataDir, 'tracking.db'),
    notOptedInMessage: HINT,
    localHookLines: HOOK_LINES,
  });
  assert.ok(!('progress' in j) && !('status' in j) && !('duplicate' in j));
}));

test('render prints the Active plan section and writes nothing', () => {
  withRepo('store', (s) => withRepo('committed', (c) => {
    s.plan();
    c.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    ok(c.run(['init', `docs/plans/${NAME}.md`]));
    ok(s.run(['start', 'T1']));
    ok(c.run(['start', 'T1']));
    const before = s.gitListing();
    const r = ok(s.run(['render']));
    const section = readFileSync(join(c.repo, 'status.md'), 'utf8').split('<!-- tasks:start -->\n')[1].split('\n<!-- tasks:end -->')[0];
    assert.equal(r.stdout, `${section}\n`);
    assert.match(r.stdout, /^## Active plan\n\n### 2026-10-11-example — 0\/3 done\n- In progress: T1 Alpha\n- Next: T2 Beta\n$/);
    assert.deepEqual(s.gitListing(), before);
    assert.ok(!existsSync(join(s.repo, 'status.md')));
  }));
});

test('check compares the plans whose document exists against the store', () => {
  withRepo('store', (s) => {
    const file = s.plan();
    ok(s.run(['init', file]));
    assert.equal(ok(s.run(['check'])).stdout, '');
    // A task retitled in the plan is drift.
    writeFileSync(file, PLAN.replace('Beta', 'Beta renamed'));
    const r = s.run(['check']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'T2 title differs: plan "Beta renamed", ledger "Beta" — run triqual tasks retitle\n');
    ok(s.run(['retitle', 'T2', 'Beta renamed']));
    assert.equal(ok(s.run(['check'])).stdout, '');
    // A task added to the plan and a task removed from it.
    writeFileSync(file, '### Task 1: Alpha\n\n### Task 2: Beta renamed\n\n### Task 4: Delta\n');
    const drift = s.run(['check']);
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /T4 is in the plan but not in the ledger — run triqual tasks init/);
    assert.match(drift.stdout, /T3 is not in the plan — restore the heading or drop the task/);
    // A stored plan whose document is not in the documents directory is not compared.
    rmSync(file);
    assert.equal(ok(s.run(['check'])).stdout, '');
    // No rendered section exists to drift, so the stale message never appears.
    assert.ok(!/Active plan section/.test(drift.stdout));
  });
});

test('check names the plan when several are compared, and checks the commits of an active plan', () => {
  withRepo('store', (s) => {
    s.plan(`### Task 1: Only\n`, 'a-plan');
    s.plan(`### Task 1: Other\n`, 'b-plan');
    ok(s.run(['init', join(s.plansDir, 'a-plan.md')]));
    ok(s.run(['init', join(s.plansDir, 'b-plan.md')]));
    ok(s.run(['start', 'T1', '--plan', 'a-plan']));
    ok(s.run(['done', 'T1', '--commit', 'HEAD', '--plan', 'a-plan']));
    assert.equal(ok(s.run(['check'])).stdout, '');
    s.inStore((store) => {
      const p = store.plans(store.get('SELECT id FROM repos').id).find((x) => x.path.endsWith('a-plan.md'));
      const ledger = store.ledgerOf(p.id);
      ledger.tasks[0].commits = ['0'.repeat(40)];
      store.saveLedger(p.id, ledger);
    });
    const r = s.run(['check']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'a-plan: T1 commit 0000000 does not resolve\n');
  });
});

// ---- export ----

test('export --json and export --json --all include the store repository snapshot', () => {
  withRepo('store', (s) => {
    const registry = join(s.dir, 'registry');
    mkdirSync(registry);
    writeFileSync(join(registry, 'repos.json'), JSON.stringify({
      version: 1, repos: [{ root: s.repo, mode: 'store', lastSeen: '2026-10-11T00:00:00.000Z', shareable: false }],
    }));
    s.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    ok(s.run(['start', 'T1']));
    s.inStore((store) => {
      const { id } = store.get('SELECT id FROM repos');
      store.setStatus(id, [{ heading: 'preamble', body: '# Status' }, { heading: 'Notes', body: 'all good' }], '2026-10-11T00:00:00.000Z');
      store.addEntry({ repoId: id, gitDir: join(s.repo, '.git'), branch: 'main' }, {
        title: 'Did a thing', stage_task: `Plan ${NAME} · T1`, done: 'the thing', files: 'a.mjs', verification: 'ran', next: 'T2',
      }, { createdAt: '2026-10-11T10:00:00Z' });
    });
    const env = { TRIQUAL_REGISTRY_DIR: registry };
    // From another directory, --all finds the repository through the registry.
    const all = JSON.parse(ok(s.run(['export', '--json', '--all'], { extraEnv: env, cwd: s.dir })).stdout);
    assert.equal(all.length, 1);
    const one = JSON.parse(ok(s.run(['export', '--json'], { extraEnv: env })).stdout);
    for (const snap of [all[0], one]) {
      assert.equal(snap.schema, SNAPSHOT_SCHEMA);
      assert.equal(snap.repo.mode, 'store');
      assert.equal(snap.repo.root, s.repo);
      assert.equal(snap.repo.shareable, false);
      assert.deepEqual(snap.plans.map((p) => [p.name, p.state, p.done, p.total]), [[NAME, 'active', 0, 3]]);
      assert.deepEqual(snap.plans[0].tasks.map((t) => [t.id, t.status]), [['T1', 'in_progress'], ['T2', 'pending'], ['T3', 'pending']]);
      assert.match(snap.status.text, /^# Status\n/);
      assert.match(snap.status.text, /## Notes\n\nall good/);
      assert.match(snap.status.text, /## Active plan\n\n### 2026-10-11-example — 0\/3 done\n- In progress: T1 Alpha/);
      assert.deepEqual(snap.progress.entries, [{
        date: '2026-10-11',
        title: 'Did a thing',
        stageTask: `Plan ${NAME} · T1`,
        body: `- **Stage/task:** Plan ${NAME} · T1\n- **Done:** the thing\n- **Files:** a.mjs\n- **Verification:** ran\n- **Next:** T2`,
      }]);
    }
    // A store repository is shareable only when the registry entry and its frozen store row both say so: the registry
    // alone (the other modes' rule) is not enough while the row, created unshareable, says 0.
    writeFileSync(join(registry, 'repos.json'), JSON.stringify({
      version: 1, repos: [{ root: s.repo, mode: 'store', lastSeen: '2026-10-11T00:00:00.000Z', shareable: true }],
    }));
    const shareable = () => JSON.parse(ok(s.run(['export', '--json', '--all'], { extraEnv: env, cwd: s.dir })).stdout)[0].repo.shareable;
    assert.equal(shareable(), false, 'registry true, store row 0');
    s.inStore((store) => store.run('UPDATE repos SET shareable = 1'));
    assert.equal(shareable(), true, 'registry true, store row 1');
  });
});

test('buildSnapshot of a store repository is empty, not an error, before the store has seen it', () => {
  withRepo('store', (s) => {
    const t = resolveTracking(s.repo);
    const snap = buildSnapshot(t, { now: new Date('2026-10-11T00:00:00Z'), shareable: false, home: s.home, env: s.dbEnv });
    assert.deepEqual(snap.plans, []);
    assert.deepEqual(snap.progress.entries, []);
    assert.equal(snap.status.text, '', 'no status sections and no plan: no text, as a repository with no status.md');
  });
});

// ---- line is read-only ----

const stat = (path) => {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
};

const nodes = [['this node', process.execPath], ['node 22', NODE22]];
// A missing Node 22 shows as a skipped test, never as a silently absent one.
const nodeOpts = (node) => (existsSync(node) ? {} : { skip: 'node 22 not found' });

for (const [label, node] of nodes) {
  test(`line prints the segment from the store, writes nothing and keeps stderr empty (${label})`, nodeOpts(node), () => {
    withRepo('store', (s) => withRepo('committed', (c) => {
      s.plan();
      c.plan();
      ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
      ok(c.run(['init', `docs/plans/${NAME}.md`]));
      ok(s.run(['start', 'T1']));
      ok(c.run(['start', 'T1']));
      const db = join(s.dataDir, 'tracking.db');
      // A connection held open keeps the WAL file alive, so a write by `line` would show in tracking.db-wal (under WAL a
      // write alone does not touch tracking.db's mtime).
      const holder = new DatabaseSync(db);
      holder.exec('PRAGMA busy_timeout = 5000');
      holder.prepare('SELECT count(*) FROM plans').get();
      try {
        const snapshot = () => [db, `${db}-wal`].map(stat);
        const before = snapshot();
        assert.notEqual(before[1], 'absent', 'the held connection keeps a WAL file');
        const r = s.run(['line'], { node });
        assert.equal(r.status, 0);
        assert.equal(r.stderr, '', `stderr: ${r.stderr}`);
        assert.equal(r.stdout, c.run(['line'], { node }).stdout);
        assert.equal(r.stdout, `▸ ${NAME} 0/3 · T1 (tdd-implementer)\n`);
        assert.deepEqual(snapshot(), before, 'tracking.db and its WAL are untouched');
        // The check can fail: a write command moves the WAL.
        ok(s.run(['review', 'T1'], { node }));
        assert.notDeepEqual(snapshot(), before, 'a write is visible in tracking.db or its WAL');
      } finally {
        holder.close();
      }
    }));
  });
}

// A probe preloaded into the child: it wraps node:sqlite's DatabaseSync and, at exit, writes the options of every
// connection the process opened. A read-write open that never writes leaves the files as they were, so file stats alone
// cannot tell it from a read-only one.
const connectionProbe = (out) => `import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const sqlite = process.getBuiltinModule('node:sqlite');
const Real = sqlite.DatabaseSync;
const opened = [];
sqlite.DatabaseSync = class extends Real {
  constructor(file, options) {
    if (options === undefined) super(file);
    else super(file, options);
    opened.push({ readOnly: options?.readOnly === true });
  }
};
syncBuiltinESMExports();
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(opened)));
`;

for (const [label, node] of nodes) {
  test(`line and the read commands open the database read-only, the writing ones read-write (${label})`, nodeOpts(node), () => {
    withRepo('store', (s) => {
      s.plan();
      ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
      const out = join(s.dir, 'opened.json');
      const probe = join(s.dir, 'probe.mjs');
      writeFileSync(probe, connectionProbe(out));
      const opened = (args) => {
        rmSync(out, { force: true });
        const r = s.run(args, { node, extraEnv: { NODE_OPTIONS: `--import ${probe} --disable-warning=ExperimentalWarning` } });
        assert.ok(r.status === 0 || r.status === 1, `${args.join(' ')}: ${r.stderr}`);
        return JSON.parse(readFileSync(out, 'utf8'));
      };
      for (const args of [['line'], ['status'], ['next'], ['check'], ['render'], ['export', '--json']]) {
        assert.deepEqual(opened(args), [{ readOnly: true }], `${args.join(' ')} opens one read-only connection`);
      }
      for (const args of [['start', 'T1'], ['review', 'T1']]) {
        assert.ok(opened(args).every((o) => o.readOnly === false), `${args.join(' ')} writes through a read-write connection`);
      }
    });
  });
}

// A store older than this triqual's schema is upgraded only by a writing command: the read-only paths refuse it and
// leave the files exactly as they were.
test('a read-only open of an older schema is refused and neither migrates nor creates a WAL', () => {
  withRepo('store', (s) => {
    s.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    const db = join(s.dataDir, 'tracking.db');
    const old = new DatabaseSync(db);
    old.exec('PRAGMA user_version = 0');
    old.close();
    const files = () => readdirSync(s.dataDir).sort();
    const before = [stat(db), files()];
    const version = () => {
      const d = new DatabaseSync(db, { readOnly: true });
      try { return d.prepare('PRAGMA user_version').get().user_version; } finally { d.close(); }
    };
    const line = s.run(['line']);
    assert.equal(line.status, 0);
    assert.equal(line.stdout, '');
    assert.equal(line.stderr, '');
    for (const args of [['status'], ['next'], ['check'], ['render'], ['export', '--json']]) {
      refused(s.run(args), /schema 0, older than this triqual.*run a command that writes.* to upgrade it/);
    }
    assert.ok(!files().some((f) => f.endsWith('-wal')), 'no -wal was created');
    assert.deepEqual([stat(db), files()], before, 'tracking.db and the data directory are unchanged');
    // Reading the version itself may leave sidecar files; it is done last, only to prove the version stayed 0.
    assert.equal(version(), 0);
  });
});

// The header of the main file is the live schema version only when no WAL holds newer pages: a migration still in the
// WAL (a writer holding the store open, or a creator killed after migrating) must not read as an older schema.
test('a read-only open succeeds while a writer holds a migration that is still in the WAL', () => {
  withRepo('store', (s) => {
    const db = join(s.dataDir, 'tracking.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    const writer = openStore({ home: s.home, env: s.dbEnv, create: true });
    try {
      const header = readFileSync(db).readUInt32BE(60);
      assert.equal(header, 0, 'precondition: the main file still says schema 0 while the live version is 1');
      assert.ok(statSync(`${db}-wal`).size > 0, 'precondition: the WAL holds the migration');
      for (const args of [['line'], ['status'], ['render']]) {
        const r = ok(s.run(args));
        assert.equal(r.stderr, '', args.join(' '));
      }
    } finally {
      writer.close();
    }
  });
});

test('a read-only open succeeds after the creator was killed with its migration in the WAL', () => {
  withRepo('store', (s) => {
    const db = join(s.dataDir, 'tracking.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    const crash = join(s.dir, 'crash.mjs');
    writeFileSync(crash, `import { loadSqlite, openStore } from ${JSON.stringify(pathToFileURL(join(PLUGIN, 'lib', 'store.mjs')).href)};
await loadSqlite();
openStore({ home: ${JSON.stringify(s.home)}, env: ${JSON.stringify(s.dbEnv)}, create: true });
process.kill(process.pid, 'SIGKILL');
`);
    const killed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', crash], { env: cleanEnv(s.home, s.dbEnv) });
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(readFileSync(db).readUInt32BE(60), 0, 'precondition: the main file still says schema 0');
    assert.ok(statSync(`${db}-wal`).size > 0, 'precondition: a WAL with content and no live writer is left behind');
    for (const args of [['line'], ['status'], ['render']]) ok(s.run(args));
  });
});

test('a file that is not a tracking database is named as such; an empty one is an interrupted create', () => {
  withRepo('store', (s) => {
    const db = join(s.dataDir, 'tracking.db');
    for (const bytes of [Buffer.from('not a database'), Buffer.alloc(200, 'x')]) {
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      writeFileSync(db, bytes);
      refused(s.run(['status']), /is not a tracking database/);
      assert.doesNotMatch(s.run(['status']).stderr, /older than this triqual|run a command that writes/);
      const line = s.run(['line']);
      assert.equal(line.stdout, '');
      assert.deepEqual(readFileSync(db), bytes);
    }
    rmSync(db, { force: true });
    writeFileSync(db, '');
    refused(s.run(['status']), /schema 0, older than this triqual.*run a command that writes/);
  });
});

test('line is silent outside an active plan and for extra arguments', () => {
  withRepo('store', (s) => {
    for (const args of [['line'], ['line', 'extra']]) {
      const r = s.run(args);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    }
    s.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    assert.equal(s.run(['line', 'extra']).stdout, '');
  });
});

test('a read-only store connection refuses writes', () => {
  withRepo('store', (s) => {
    const store = openStore({ home: s.home, env: s.dbEnv, readOnly: true });
    try {
      assert.equal(store.all('SELECT count(*) AS n FROM repos')[0].n, 0);
      assert.throws(() => store.run("INSERT INTO import_guard (active) VALUES (1)"), /readonly/i);
    } finally {
      store.close();
    }
  });
});

// ---- tracking write plan ----

test('write plan in store mode copies the draft into the documents directory and inits it', () => {
  withRepo('store', (s) => {
    const draft = join(s.dir, `${NAME}.md`);
    writeFileSync(draft, PLAN);
    const before = s.gitListing();
    const r = ok(s.run(['write', 'plan', draft], { bin: TRACKING }));
    const [path, message] = r.stdout.trimEnd().split('\n');
    assert.equal(path, join(s.plansDir, `${NAME}.md`));
    assert.equal(readFileSync(path, 'utf8'), PLAN);
    assert.match(message, new RegExp(`^created .*${NAME}\\.md$`));
    assert.equal(ok(s.run(['next'])).stdout, 'T1 Alpha [roles:tdd-implementer]\n');
    refused(s.run(['write', 'plan', draft], { bin: TRACKING }), /already exists/);
    // --replace re-adopts and reconciles.
    writeFileSync(draft, `${PLAN}\n### Task 4: Delta\n`);
    const again = ok(s.run(['write', 'plan', draft, '--replace'], { bin: TRACKING }));
    assert.match(again.stdout, /reconciled .*: added T4; missing none; retitled none/);
    assert.match(readFileSync(path, 'utf8'), /Task 4: Delta/);
    s.inStore((store) => {
      const ledger = store.ledgerOf(store.plans(store.get('SELECT id FROM repos').id)[0].id);
      assert.deepEqual(ledger.tasks.map((x) => x.id), ['T1', 'T2', 'T3', 'T4']);
    });
    assert.equal(s.git('status', '--porcelain'), '');
    assert.deepEqual(s.gitListing(), before, 'no file under .git changed or appeared');
    assert.ok(!existsSync(join(s.repo, 'docs')));
  });
});

test('a draft that would not init is refused before anything lands in the documents directory', () => {
  withRepo('store', (s) => {
    const draft = join(s.dir, 'bad.md');
    writeFileSync(draft, '### Task 1: A\n**Depends on:** T9\n');
    refused(s.run(['write', 'plan', draft], { bin: TRACKING }), /T1 depends on T9 \(unknown task\)/);
    assert.deepEqual(readdirSync(s.plansDir), []);
    s.inStore((store) => assert.equal(store.get('SELECT count(*) AS n FROM plans').n, 0));
  });
});

// ---- committed and local modes never load node:sqlite ----

test('tasks in a committed repository never loads node:sqlite', () => {
  withRepo('committed', (c) => {
    const out = join(c.dir, 'modules.json');
    const probe = join(c.dir, 'probe.mjs');
    writeFileSync(probe, `import { writeFileSync } from 'node:fs';
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/i.test(m)))));`);
    c.plan();
    for (const args of [['init', `docs/plans/${NAME}.md`], ['start', 'T1'], ['status'], ['next'], ['check'], ['render'], ['line'],
      ['paths', '--json'], ['export', '--json']]) {
      const r = spawnSync(process.execPath, ['--import', probe, TASKS, ...args], {
        cwd: c.repo, env: cleanEnv(c.home, c.dbEnv), encoding: 'utf8',
      });
      assert.ok(r.status === 0 || r.status === 1, `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [], `${args.join(' ')} loaded node:sqlite`);
    }
    assert.ok(!existsSync(c.dataDir), 'a committed repository never creates the data directory');
  });
});

test('tasks outside any repository still says not opted in, without node:sqlite', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-tstore-')));
  try {
    const r = spawnSync(process.execPath, [TASKS, 'status'], {
      cwd: dir, env: cleanEnv(dir, { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') }), encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `${HINT}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- tiers: registration rule, retier, views (plan methodology-1.0 T3) ----

const tiered = (...tiers) => `# Tiered plan\n\n${tiers.map((tier, i) => `### Task ${i + 1}: Task ${i + 1}\n${tier ? `**Tier:** ${tier}\n` : ''}`).join('\n')}`;
const PARTLY = tiered('heavy', null, 'light');
const FULL = tiered('heavy', 'standard', 'light');
const ledgerOf = (s) => s.inStore((store) => store.ledgerOf(store.plans(store.get('SELECT id FROM repos').id)[0].id));

test('store init rejects a partly tiered plan and stores no plan', () => {
  withRepo('store', (s) => {
    const file = s.plan(PARTLY);
    const r = s.run(['init', file]);
    refused(r, /the plan declares tiers but T2 has none/);
    s.inStore((store) => assert.equal(store.get('SELECT count(*) AS n FROM plans').n, 0));
  });
});

test('store init accepts a tierless plan and a fully tiered plan', () => {
  withRepo('store', (s) => {
    ok(s.run(['init', s.plan()]));
    assert.deepEqual(ledgerOf(s).tasks.map((t) => [t.tier, t.effectiveTier]), [[null, null], [null, null], [null, null]]);
  });
  withRepo('store', (s) => {
    ok(s.run(['init', s.plan(FULL)]));
    assert.deepEqual(ledgerOf(s).tasks.map((t) => [t.tier, t.effectiveTier]),
      [['heavy', 'heavy'], ['standard', 'standard'], ['light', 'light']]);
  });
});

test('store init on an existing ledger does not validate, and write plan --replace reconciles a partly tiered plan', () => {
  withRepo('store', (s) => {
    const file = s.plan(tiered(null, null, null));
    ok(s.run(['init', file]));
    writeFileSync(file, PARTLY);
    assert.match(ok(s.run(['init', file])).stdout, /^reconciled /);
    assert.deepEqual(ledgerOf(s).tasks.map((t) => t.tier), ['heavy', null, 'light']);
    const draft = join(s.dir, `${NAME}.md`);
    writeFileSync(draft, `${PARTLY}\n### Task 4: Task 4\n`);
    assert.match(ok(s.run(['write', 'plan', draft, '--replace'], { bin: TRACKING })).stdout, /reconciled .*: added T4;/);
  });
});

test('write plan rejects a partly tiered draft and lands nothing in the documents directory', () => {
  withRepo('store', (s) => {
    const draft = join(s.dir, 'partly.md');
    writeFileSync(draft, PARTLY);
    refused(s.run(['write', 'plan', draft], { bin: TRACKING }), /the plan declares tiers but T2 has none/);
    assert.deepEqual(readdirSync(s.plansDir), []);
    s.inStore((store) => assert.equal(store.get('SELECT count(*) AS n FROM plans').n, 0));
  });
});

test('store retier behaves like committed retier: raise, same tier, lower, bad arguments', () => {
  withRepo('store', (s) => withRepo('committed', (c) => {
    ok(s.run(['init', s.plan(FULL)]));
    c.plan(FULL);
    ok(c.run(['init', `docs/plans/${NAME}.md`]));
    const reason = ['--reason', 'touches the gate'];
    sameOutputs(s, c, [
      ['retier', 'T3', 'heavy', ...reason], ['retier', 'T3', 'heavy', ...reason], ['retier', 'T1', 'light', ...reason],
      ['retier', 'T1', 'huge', ...reason], ['retier', 'T9', 'heavy', ...reason], ['retier', 'T2', 'heavy'],
      ['status'],
    ]);
    const t = ledgerOf(s).tasks.find((x) => x.id === 'T3');
    assert.equal(t.tier, 'light');
    assert.equal(t.effectiveTier, 'heavy');
    assert.equal(t.history.at(-1).note, 'touches the gate');
    assert.equal(t.history.length, 2);
    assert.equal(s.run(['retier', 'T3', 'heavy', ...reason]).stdout, 'T3: already heavy\n');
    assert.equal(ledgerOf(s).tasks.find((x) => x.id === 'T3').history.length, 2, 'a no-op records nothing');
  }));
});

test('store status --json, next --json and export --json carry tier and effectiveTier', () => {
  withRepo('store', (s) => {
    ok(s.run(['init', s.plan(FULL)]));
    ok(s.run(['start', 'T1']));
    ok(s.run(['retier', 'T2', 'heavy', '--reason', 'risky']));
    const [st] = JSON.parse(ok(s.run(['status', '--json'])).stdout);
    assert.deepEqual(st.tiers, { T1: { tier: 'heavy', effectiveTier: 'heavy' }, T2: { tier: 'standard', effectiveTier: 'heavy' } });
    assert.deepEqual(JSON.parse(ok(s.run(['next', '--json'])).stdout), {
      id: 'T2', title: 'Task 2', role: 'roles:tdd-implementer', tier: 'standard', effectiveTier: 'heavy',
    });
    const snap = JSON.parse(ok(s.run(['export', '--json'])).stdout);
    assert.deepEqual(snap.plans[0].tasks.map((t) => [t.id, t.tier, t.effectiveTier]),
      [['T1', 'heavy', 'heavy'], ['T2', 'standard', 'heavy'], ['T3', 'light', 'light']]);
  });
});

// ---- done --repo: a commit from another repository (plan methodology-1.0 T6) ----

// A second repo at <dir>/other with one commit: its path, a runner and the commit's full sha.
function otherRepo(dir) {
  const path = join(dir, 'other');
  mkdirSync(path);
  const g = (...args) => execFileSync('git', [...ID, ...args], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q');
  writeFileSync(join(path, 'file.txt'), 'other\n');
  g('add', 'file.txt');
  g('commit', '-qm', 'other initial');
  return { path, sha: g('rev-parse', 'HEAD') };
}

test('store done --repo records ext:<relative path>@<full sha>, repeats as a no-op and refuses a sha the repo lacks', () => {
  withRepo('store', (s) => {
    const other = otherRepo(s.dir);
    ok(s.run(['init', s.plan()]));
    ok(s.run(['start', 'T1']));
    const refusedRun = s.run(['done', 'T1', '--commit', s.git('rev-parse', 'HEAD'), '--repo', other.path]);
    refused(refusedRun, /does not resolve/);
    assert.deepEqual(ledgerOf(s).tasks[0].commits, []);
    refused(s.run(['done', 'T1', '--repo', other.path]), /--repo requires --commit/);

    assert.equal(ok(s.run(['done', 'T1', '--commit', other.sha.slice(0, 8), '--repo', other.path])).stdout, 'T1: in_progress -> done\n');
    const commits = ledgerOf(s).tasks[0].commits;
    assert.deepEqual(commits, [`ext:../other@${other.sha}`]);
    assert.equal(JSON.stringify(commits).includes(s.dir), false, 'no absolute path enters the store');
    assert.equal(ok(s.run(['done', 'T1', '--commit', other.sha, '--repo', '../other'])).stdout, 'T1: already done\n');
    assert.deepEqual(ledgerOf(s).tasks[0].commits, [`ext:../other@${other.sha}`]);
    assert.equal(ledgerOf(s).tasks[0].history.length, 3, 'the repeat records nothing');
  });
});

test('store check verifies an external commit in its path and warns, without drift, when the path is missing', () => {
  withRepo('store', (s) => {
    const other = otherRepo(s.dir);
    s.plan();
    ok(s.run(['init', join(s.plansDir, `${NAME}.md`)]));
    ok(s.run(['start', 'T1']));
    ok(s.run(['done', 'T1', '--commit', other.sha, '--repo', other.path]));
    const clean = ok(s.run(['check']));
    assert.equal(clean.stdout, '');
    assert.equal(clean.stderr, '');

    renameSync(other.path, join(s.dir, 'moved'));
    const gone = ok(s.run(['check']));
    assert.equal(gone.stdout, '');
    assert.match(gone.stderr, new RegExp(`external commit not checkable: \\.\\./other@${other.sha}\\n`));
    renameSync(join(s.dir, 'moved'), other.path);

    s.inStore((store) => {
      const p = store.plans(store.get('SELECT id FROM repos').id)[0];
      const ledger = store.ledgerOf(p.id);
      ledger.tasks[0].commits = [`ext:../other@${'0'.repeat(40)}`];
      store.saveLedger(p.id, ledger);
    });
    const bad = s.run(['check']);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, 'T1 commit 0000000 does not resolve in ../other\n');
  });
});

test('store done --repo is anchored to the main worktree root: a linked worktree and the main checkout share one ledger', () => {
  withRepo('store', (s) => {
    const other = otherRepo(s.dir);
    ok(s.run(['init', s.plan()]));
    ok(s.run(['start', 'T1']));
    // A linked worktree two levels deeper than the main checkout.
    const wt = join(s.dir, 'wts', 'deep', 'wt');
    mkdirSync(dirname(wt), { recursive: true });
    s.git('worktree', 'add', '-q', '-b', 'linked', wt);
    const fromWt = (args) => s.run(args, { cwd: wt });
    assert.equal(ok(fromWt(['done', 'T1', '--commit', other.sha, '--repo', other.path])).stdout, 'T1: in_progress -> done\n');
    assert.deepEqual(ledgerOf(s).tasks[0].commits, [`ext:../other@${other.sha}`]);
    assert.equal(ok(fromWt(['check'])).stderr, '');

    const clean = ok(s.run(['check']));
    assert.equal(clean.stdout, '');
    assert.equal(clean.stderr, '');
    assert.equal(ok(s.run(['done', 'T1', '--commit', other.sha, '--repo', other.path])).stdout, 'T1: already done\n');
    assert.equal(ok(fromWt(['done', 'T1', '--commit', other.sha, '--repo', other.path])).stdout, 'T1: already done\n');
    assert.deepEqual(ledgerOf(s).tasks[0].commits, [`ext:../other@${other.sha}`]);
  });
});
