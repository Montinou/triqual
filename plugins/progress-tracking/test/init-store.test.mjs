// `triqual progress-init --store` (plan tracking-store-1 T7, spec §8 "Switching", plan ruling S1): the switch of a
// committed or local repository to the store. Every test works in temp repositories with a temp HOME, a temp
// TRIQUAL_TRACKING_DB, a temp registry dir, no global or system git config, and a fake `triqual` first on PATH that runs
// this checkout's bin/tracking.mjs; no hook is ever installed into this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../lib/brand.mjs';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { STORE_HOOK_LINES } from '../lib/store-hooks.mjs';
import { LOCAL_HOOK_LINES } from '../scripts/init.mjs';
import { buildHistory, ENTRIES, HEADINGS, LEDGER_PATH, progressOf } from './fixtures/progress-history.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const INIT = join(PLUGIN, 'scripts', 'init.mjs');
const BIN = join(PLUGIN, 'bin', 'tracking.mjs');
const TEMPLATES = join(PLUGIN, 'templates');
const MESSAGE = 'the commit has changes but this worktree has no pending progress entry: add one with `triqual tracking add <draft>`';
const PRE_SCRIPT = 'progress-store-pre-commit.sh';
const POST_SCRIPT = 'progress-store-post-commit.sh';

await loadSqlite();

// The fixture builders spawn git with process.env: no global or system config may reach them (a global
// core.hooksPath would change where hooks live).
const GIT_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pt-istore-git-')));
writeFileSync(join(GIT_HOME, 'gitconfig'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(GIT_HOME, 'gitconfig');
process.on('exit', () => rmSync(GIT_HOME, { recursive: true, force: true }));

const DRAFT = `## 2026-10-11 — Switch work
- **Stage/task:** off-plan
- **Done:** changed a file
- **Files:** a.txt
- **Verification:** none needed
- **Next:** more
`;

function writeExec(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// A temp dir with a HOME, a store path, a registry dir, drafts and a fake `triqual` on PATH. fn gets the runners.
function withSetup(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-istore-')));
  const home = join(dir, 'home');
  const fakebin = join(dir, 'fakebin');
  const registryDir = join(dir, 'registry');
  const drafts = join(dir, 'drafts');
  for (const d of [home, fakebin, registryDir, drafts]) mkdirSync(d);
  writeExec(join(fakebin, 'triqual'), `#!/bin/sh
[ "$1" = tracking ] || { echo "fake triqual runs tracking only" >&2; exit 3; }
shift
exec '${process.execPath}' '${BIN}' "$@"
`);
  const dbFile = join(dir, 'data', 'tracking.db');
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: home };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_REFLOG_ACTION', 'XDG_CONFIG_HOME',
      'XDG_DATA_HOME', `${BRAND.legacy.envPrefix}REGISTRY_DIR`, 'CLAUDE_PLUGIN_DATA']) delete e[k];
    return {
      ...e, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      GIT_EDITOR: 'true', TRIQUAL_TRACKING_DB: dbFile, TRIQUAL_REGISTRY_DIR: registryDir,
      PATH: `${fakebin}:${process.env.PATH}`, ...extra,
    };
  };
  const gitRun = (cwd, args) => spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
  const git = (cwd, ...args) => {
    const r = gitRun(cwd, args);
    assert.equal(r.status, 0, `git ${args.join(' ')} failed\n${r.stderr}`);
    return r.stdout.trim();
  };
  const init = (cwd, args = []) => spawnSync(process.execPath, [INIT, ...args], { cwd, env: env(), encoding: 'utf8' });
  const switched = (cwd, args = []) => {
    const r = init(cwd, ['--store', ...args]);
    assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const cli = (cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: env(), encoding: 'utf8' });
  let draftN = 0;
  const add = (cwd) => {
    draftN += 1;
    const path = join(drafts, `d${draftN}.md`);
    writeFileSync(path, DRAFT);
    const r = cli(cwd, ['add', path]);
    assert.equal(r.status, 0, r.stderr);
    return Number(/^entry (\d+)$/m.exec(r.stdout)[1]);
  };
  const inStore = (f) => {
    const store = openStore({ home, env: { TRIQUAL_TRACKING_DB: dbFile } });
    try { return f(store); } finally { store.close(); }
  };
  const registry = () => {
    try {
      return JSON.parse(readFileSync(join(registryDir, 'repos.json'), 'utf8')).repos;
    } catch {
      return [];
    }
  };
  const marker = (cwd) => gitRun(cwd, ['config', '--local', '--get', 'triqual.tracking']).stdout.trim();
  // A committed-mode repository: the fixture history with `extra` dropped and the top entry committed, then
  // `progress-init` (committed), which leaves CLAUDE.md and .githooks untracked.
  const committedRepo = () => {
    const h = buildHistory(dir);
    h.git(['branch', '-qD', 'extra']);
    h.commit('golf', '2026-01-07T10:00:00Z');
    const r = init(h.repo);
    assert.equal(r.status, 0, r.stderr);
    return h;
  };
  try {
    return fn({
      dir, home, dbFile, registryDir, env, git, gitRun, init, switched, cli, add, inStore, registry, marker, committedRepo,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exit = (r, code) => assert.equal(r.status, code, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
const hookScript = (lines) => lines.join('\n');
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

// Every file under `root` (recursively, .git skipped) with its content.
function tree(root) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name === '.git') continue;
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out[p.slice(root.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

// ---- Committed repository ----

test('--store on a committed repository imports, sets the marker, installs the hooks and deletes the tracking files without committing', () => withSetup(({
  git, gitRun, switched, add, inStore, registry, marker, committedRepo,
}) => {
  const { repo } = committedRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  const report = switched(repo);

  assert.equal(marker(repo), 'store');
  assert.equal(report.mode, 'store');
  assert.equal(report.from, 'committed');
  inStore((s) => {
    const rows = s.all('SELECT title, state FROM entries ORDER BY id');
    assert.deepEqual(rows.map((r) => r.title), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Golf']);
    assert.ok(rows.every((r) => r.state === 'committed'), 'every imported entry is committed');
    assert.equal(s.get('SELECT COUNT(*) AS n FROM status').n > 0, true, 'status sections imported');
    assert.equal(s.get('SELECT COUNT(*) AS n FROM plans').n, 1, 'the ledger imported');
    const row = s.get('SELECT root, shareable FROM repos');
    assert.equal(row.root, repo);
  });
  assert.deepEqual(registry().filter((r) => r.root === repo).map((r) => r.mode), ['store']);

  // The tracking files are gone from the working tree; the plan document stays; nothing is staged or committed.
  for (const f of ['progress.md', 'status.md', LEDGER_PATH]) assert.equal(existsSync(join(repo, f)), false, f);
  assert.equal(existsSync(join(repo, 'docs', 'plans', '2026-01-01-sample.md')), true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'no commit made');
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.ok(report.commit.paths.includes('progress.md'), JSON.stringify(report.commit));
  assert.ok(report.commit.steps.some((s) => s.includes('triqual tracking add')), JSON.stringify(report.commit));

  // The hooks: the store scripts beside the old gate's place, chained once; the progress-gate.sh chain is gone.
  const hooks = join(repo, '.githooks');
  assert.equal(existsSync(join(hooks, 'progress-gate.sh')), false);
  const pre = read(join(hooks, 'pre-commit'));
  assert.doesNotMatch(pre, /progress-gate\.sh/);
  assert.match(pre, new RegExp(PRE_SCRIPT.replace(/\./g, '\\.')));
  assert.match(read(join(hooks, 'post-commit')), new RegExp(POST_SCRIPT.replace(/\./g, '\\.')));
  assert.ok(read(join(hooks, PRE_SCRIPT)).includes(hookScript(STORE_HOOK_LINES['pre-commit'])));
  assert.ok(read(join(hooks, POST_SCRIPT)).includes(hookScript(STORE_HOOK_LINES['post-commit'])));

  // The CLAUDE.md section comes from the store template.
  const section = readFileSync(join(TEMPLATES, 'claude-section-store.md'), 'utf8').trim();
  assert.ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').includes(section));

  // The switch commit needs its entry: refused without one, stamped with one.
  git(repo, 'add', '-A');
  const refused = gitRun(repo, ['commit', '-qm', 'switch to the store']);
  exit(refused, 1);
  assert.match(refused.stderr, new RegExp(MESSAGE.replace(/[`<>]/g, '.')));
  const id = add(repo);
  exit(gitRun(repo, ['commit', '-qm', 'switch to the store']), 0);
  const stamped = inStore((s) => s.get('SELECT state, commit_sha FROM entries WHERE id = ?', id));
  assert.deepEqual({ ...stamped }, { state: 'committed', commit_sha: git(repo, 'rev-parse', 'HEAD') });
}));

test('--store marks an imported draft whose heading was retitled before its commit unresolved, so one commit is not let through', () => withSetup(({
  git, gitRun, switched, cli, inStore, committedRepo,
}) => {
  const { repo } = committedRepo();
  const progress = join(repo, 'progress.md');
  writeFileSync(progress, readFileSync(progress, 'utf8').replace('Append-only log, newest on top.\n\n', 'Append-only log, newest on top.\n\n## 2026-01-08 — WIP draft\n- **Stage/task:** off-plan\n- **Done:** started\n- **Files:** w.txt\n- **Verification:** none yet\n- **Commit:** this commit\n- **Next:** finish\n\n'));
  exit(cli(repo, ['import']), 0);
  assert.deepEqual(inStore((s) => s.all("SELECT title, state FROM entries WHERE title = 'WIP draft'").map((r) => ({ ...r }))), [{ title: 'WIP draft', state: 'pending' }]);

  // The author retitles the draft on disk and commits it; the old row is not on disk any more.
  writeFileSync(progress, readFileSync(progress, 'utf8').replace('WIP draft', 'Finished work'));
  writeFileSync(join(repo, 'status.md'), `${readFileSync(join(repo, 'status.md'), 'utf8')}\nFinished the work.\n`);
  git(repo, 'add', '-A');
  exit(gitRun(repo, ['commit', '-qm', 'finish the work']), 0);
  switched(repo);

  const rows = inStore((s) => s.all("SELECT title, state FROM entries WHERE title IN ('WIP draft', 'Finished work') ORDER BY id").map((r) => ({ ...r })));
  assert.deepEqual(rows, [{ title: 'WIP draft', state: 'unresolved' }, { title: 'Finished work', state: 'committed' }]);
  assert.deepEqual(inStore((s) => s.all("SELECT title, git_dir FROM entries WHERE state = 'pending'").map((r) => ({ ...r }))), [], 'no pending row is left');

  // The next commit has no pending entry: it is refused, and no row is stamped.
  git(repo, 'add', '-A');
  const refused = gitRun(repo, ['commit', '-qm', 'switch to the store']);
  exit(refused, 1);
  assert.match(refused.stderr, /no pending progress entry/);
}));

// ---- Local repository ----

test('--store on a local repository with its hooks outside the tree removes the local lines and keeps an existing hook running', () => withSetup(({
  dir, git, gitRun, init, switched, add, inStore, marker,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'initial');
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const ran = join(dir, 'user-hook-ran');
  writeExec(join(hooks, 'pre-commit'), `#!/bin/sh\necho ran >> '${ran}'\n`);
  exit(init(repo, ['--local']), 0);
  assert.ok(read(join(hooks, 'pre-commit')).includes(LOCAL_HOOK_LINES['pre-commit']), 'local init chained its line');

  const report = switched(repo);
  assert.equal(report.from, 'local');
  assert.equal(marker(repo), 'store');
  const pre = read(join(hooks, 'pre-commit'));
  assert.equal(pre.includes(LOCAL_HOOK_LINES['pre-commit']), false, 'the local pre-commit line is gone');
  assert.equal((read(join(hooks, 'post-commit')) ?? '').includes(LOCAL_HOOK_LINES['post-commit']), false, 'the local post-commit line is gone');
  assert.match(pre, /echo ran/, 'the existing hook line is kept');
  assert.equal(existsSync(join(hooks, PRE_SCRIPT)), true);
  assert.equal(gitRun(repo, ['status', '--porcelain']).stdout, '', 'nothing written inside the working tree');
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);
  assert.equal(report.commit, null, 'no commit to make');
  assert.equal(inStore((s) => s.get('SELECT shareable FROM repos').shareable), 0, 'a local repository is never shareable');

  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'add', 'a.txt');
  const refused = gitRun(repo, ['commit', '-qm', 'change']);
  exit(refused, 1);
  assert.match(refused.stderr, /no pending progress entry/);
  const id = add(repo);
  exit(gitRun(repo, ['commit', '-qm', 'change']), 0);
  assert.equal(inStore((s) => s.get('SELECT state FROM entries WHERE id = ?', id).state), 'committed');
  assert.equal(existsSync(ran), true, 'the existing pre-commit line still runs after the switch');
}));

test('--store refuses a local repository whose core.hooksPath is a versioned directory (S1), changing nothing', () => withSetup(({
  dir, dbFile, registryDir, git, init, marker,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.githooks'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeExec(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho team hook\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'config', 'core.hooksPath', '.githooks');
  exit(init(repo, ['--local']), 0);
  const before = {
    tree: tree(repo), config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
    registry: read(join(registryDir, 'repos.json')), local: tree(join(repo, '.git', 'methodology')),
  };

  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /\.githooks/);
  assert.match(r.stderr, /working tree/);
  assert.match(r.stderr, /local mode/);
  assert.equal(marker(repo), '');
  assert.deepEqual({
    tree: tree(repo), config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
    registry: read(join(registryDir, 'repos.json')), local: tree(join(repo, '.git', 'methodology')),
  }, before);
  assert.equal(existsSync(dbFile), false, 'no database created');
}));

// ---- Live branches and worktrees ----

test('--store refuses while an unmerged branch has entries and ledger moves not imported, and proceeds after import --ref', () => withSetup(({
  dir, cli, init, switched, inStore, marker,
}) => {
  const { repo } = buildHistory(dir);
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /branch extra/);
  assert.match(r.stderr, /branch extra: 1 entry, 1 ledger change not in the store/);
  assert.match(r.stderr, /import --ref extra/);
  assert.doesNotMatch(r.stderr, /branch side/, 'a merged branch is on this branch already');
  assert.equal(marker(repo), '');
  assert.equal(existsSync(join(repo, 'progress.md')), true);

  exit(cli(repo, ['import', '--ref', 'extra']), 0);
  switched(repo);
  assert.equal(marker(repo), 'store');
  inStore((s) => {
    assert.equal(s.get("SELECT state FROM entries WHERE title = 'Foxtrot'").state, 'committed');
    assert.equal(s.get("SELECT state FROM entries WHERE title = 'Golf'").state, 'pending', 'the uncommitted top entry is pending');
  });
}));

test('--store refuses while another worktree has uncommitted entries not imported, and proceeds once they are committed and imported', () => withSetup(({
  dir, git, init, cli, switched, inStore, marker,
}) => {
  const { repo } = buildHistory(dir);
  git(repo, 'branch', '-qD', 'extra');
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  writeFileSync(join(wt, 'progress.md'), progressOf(ENTRIES.foxtrot, ENTRIES.echo, ENTRIES.delta, ENTRIES.charlie, ENTRIES.bravo, ENTRIES.alpha));
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.ok(r.stderr.includes(`worktree ${realpathSync(wt)}`), r.stderr);
  assert.equal(marker(repo), '');

  git(wt, 'add', 'progress.md');
  git(wt, 'commit', '-qm', 'foxtrot on the worktree branch');
  exit(cli(repo, ['import', '--ref', 'wt-branch']), 0);
  switched(repo);
  assert.equal(marker(repo), 'store');
  assert.equal(inStore((s) => s.get("SELECT branch FROM entries WHERE title = 'Foxtrot'").branch), 'wt-branch');
}));

// ---- Unparsed entries ----

test('--store refuses an unparsed entry unless --accept-unparsed, and nothing is switched on the refusal', () => withSetup(({
  dir, dbFile, git, init, switched, inStore, marker,
}) => {
  const { repo } = buildHistory(dir, { unparsed: true });
  git(repo, 'branch', '-qD', 'extra');
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /unparsed/);
  assert.match(r.stderr, /--accept-unparsed/);
  assert.ok(r.stderr.includes(HEADINGS.spanish), r.stderr);
  assert.equal(marker(repo), '');
  assert.equal(existsSync(join(repo, 'progress.md')), true);
  assert.equal(existsSync(join(repo, '.git', 'hooks', PRE_SCRIPT)), false);
  assert.equal(existsSync(dbFile), false, 'the refusal opens no store: no database created');

  switched(repo, ['--accept-unparsed']);
  assert.equal(marker(repo), 'store');
  assert.equal(inStore((s) => s.get('SELECT COUNT(*) AS n FROM entries WHERE parse_ok = 0').n), 2);
}));

// ---- Repeat ----

test('a second --store run changes nothing', () => withSetup(({
  git, switched, inStore, registry, committedRepo,
}) => {
  const { repo } = committedRepo();
  switched(repo);
  const state = () => ({
    tree: tree(repo),
    status: git(repo, 'status', '--porcelain'),
    config: git(repo, 'config', '--local', '--list'),
    rows: inStore((s) => ['entries', 'status', 'plans', 'tasks', 'task_events', 'repos']
      .map((t) => s.all(`SELECT * FROM ${t}`).map((row) => ({ ...row })))),
    registry: registry().map(({ lastSeen, ...r }) => r),
  });
  const before = state();
  const again = switched(repo);
  assert.equal(again.from, 'store');
  assert.deepEqual(state(), before);
}));

// ---- Linked worktree ----

test('--store from a linked worktree pins the store row to the main worktree root and its registry entry', () => withSetup(({
  dir, git, registryDir, switched, inStore, registry, committedRepo,
}) => {
  const { repo } = committedRepo();
  writeFileSync(join(registryDir, 'repos.json'), `${JSON.stringify({
    version: 1, repos: [{ root: repo, mode: 'committed', lastSeen: '2026-01-01T00:00:00.000Z', shareable: true }],
  }, null, 2)}\n`);
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  const report = switched(wt);
  assert.equal(report.root, repo);
  inStore((s) => {
    const row = s.get('SELECT root, shareable FROM repos');
    assert.equal(row.root, repo, 'the main worktree root, not the linked worktree');
    assert.equal(row.shareable, 1, 'shareable from the main root\'s registry entry');
  });
  assert.deepEqual(registry().map((r) => [r.root, r.mode]), [[repo, 'store']]);
  assert.equal(existsSync(join(wt, 'progress.md')), false, 'the switching worktree loses its tracking files');
  assert.equal(existsSync(join(repo, 'progress.md')), true, 'the main worktree is not touched');
}));

// ---- Arguments and fresh repositories ----

test('--accept-unparsed needs --store, and --store excludes --local', () => withSetup(({ dir, git, init }) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  exit(init(repo, ['--accept-unparsed']), 2);
  exit(init(repo, ['--store', '--local']), 2);
  exit(init(repo, ['--store', '--remove']), 2);
}));

test('--store on a repository not opted in starts it in store mode with nothing to import', () => withSetup(({
  dir, git, switched, inStore, marker,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const report = switched(repo);
  assert.equal(report.from, null);
  assert.equal(marker(repo), 'store');
  assert.equal(inStore((s) => s.get('SELECT COUNT(*) AS n FROM repos').n), 1);
  assert.equal(existsSync(join(repo, '.git', 'hooks', PRE_SCRIPT)), true);
  assert.equal(existsSync(join(repo, 'progress.md')), false);
}));

// ---- Fix round 1 ----

// A branch `name` off HEAD whose commit writes `files` (relative path → text), made in a throwaway worktree.
function branchWith(git, dir, repo, name, files) {
  const tmp = join(dir, `branch-${Object.keys(files).length}-${Date.now()}`);
  git(repo, 'worktree', 'add', '-q', tmp, '-b', name);
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(tmp, rel), text);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-qm', `work on ${name}`);
  git(repo, 'worktree', 'remove', '--force', tmp);
}

const ledgerText = (repo, edit) => {
  const ledger = JSON.parse(readFileSync(join(repo, LEDGER_PATH), 'utf8'));
  edit(ledger);
  return `${JSON.stringify(ledger, null, 2)}\n`;
};

test('a switch that fails partway keeps commits gated, and a re-run finishes it: files deleted and listed in the commit', () => withSetup(({
  git, gitRun, init, switched, marker, committedRepo,
}) => {
  const { repo } = committedRepo();
  chmodSync(repo, 0o555); // CLAUDE.md cannot be rewritten: the switch fails after the hooks and the marker
  let failed;
  try {
    failed = init(repo, ['--store']);
  } finally {
    chmodSync(repo, 0o755);
  }
  exit(failed, 1);
  assert.match(failed.stderr, /progress-init --store` again/);
  assert.equal(marker(repo), 'store');
  assert.equal(existsSync(join(repo, 'progress.md')), true, 'the files are still there');
  writeFileSync(join(repo, 'docs', 'plans', 'note.md'), 'note\n');
  git(repo, 'add', 'docs/plans/note.md');
  const refused = gitRun(repo, ['commit', '-qm', 'change']);
  exit(refused, 1);
  assert.match(refused.stderr, /no pending progress entry/, 'the store pre-commit gates the half-switched repo');

  const report = switched(repo);
  assert.equal(report.from, 'store');
  for (const f of ['progress.md', 'status.md', LEDGER_PATH]) {
    assert.equal(existsSync(join(repo, f)), false, f);
    assert.ok(report.deleted.includes(f), `${f} deleted by the re-run`);
    assert.ok(report.commit.paths.includes(f), `${f} listed in the commit`);
  }
  assert.ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').includes(readFileSync(join(TEMPLATES, 'claude-section-store.md'), 'utf8').trim()));
}));

test('--store refuses a pre-commit that is not a shell script, changing nothing', () => withSetup(({
  dbFile, init, marker, committedRepo,
}) => {
  const { repo } = committedRepo();
  const hook = join(repo, '.githooks', 'pre-commit');
  writeExec(hook, '#!/usr/bin/env python3\nprint("team hook")\n');
  const before = tree(repo);
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /not a shell script/);
  assert.equal(marker(repo), '');
  assert.deepEqual(tree(repo), before);
  assert.equal(existsSync(dbFile), false);
}));

test('tracking import --ref from a linked worktree pins the main worktree root, and --store keeps it', () => withSetup(({
  dir, git, registryDir, cli, switched, inStore, committedRepo,
}) => {
  const { repo } = committedRepo();
  writeFileSync(join(registryDir, 'repos.json'), `${JSON.stringify({
    version: 1, repos: [{ root: repo, mode: 'committed', lastSeen: '2026-01-01T00:00:00.000Z', shareable: true }],
  }, null, 2)}\n`);
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  exit(cli(wt, ['import', '--ref', 'main']), 0);
  switched(repo);
  inStore((s) => {
    const row = s.get('SELECT root, shareable FROM repos');
    assert.equal(row.root, repo, 'the first writer, run from a linked worktree, named the main root');
    assert.equal(row.shareable, 1, 'shareable from the main root\'s registry entry');
  });
}));

test('progress-gate.sh is kept while another hook line still calls it', () => withSetup(({ switched, committedRepo }) => {
  const { repo } = committedRepo();
  const hook = join(repo, '.githooks', 'pre-commit');
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}sh ./.githooks/progress-gate.sh # called by hand\n`);
  const report = switched(repo);
  assert.equal(existsSync(join(repo, '.githooks', 'progress-gate.sh')), true);
  assert.ok(report.notes.some((n) => n.includes('progress-gate.sh')), JSON.stringify(report.notes));
  assert.match(read(hook), /# called by hand/);
}));

test('an unreadable ledger on a branch blocks, with a hint to fix or delete it there', () => withSetup(({ dir, git, init }) => {
  const { repo } = buildHistory(dir);
  git(repo, 'branch', '-qD', 'extra');
  branchWith(git, dir, repo, 'broken', { [LEDGER_PATH]: '{ not json' });
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /branch broken: unreadable ledger/);
  assert.match(r.stderr, /fix or delete it on that branch/);
  assert.doesNotMatch(r.stderr, /import --ref broken/);
}));

test('a branch that changes only a task title warns and does not block, its name shell-quoted, and a re-run is still a no-op', () => withSetup(({
  dir, git, init, inStore,
}) => {
  const { repo } = buildHistory(dir);
  git(repo, 'branch', '-qD', 'extra');
  branchWith(git, dir, repo, 're$title', { [LEDGER_PATH]: ledgerText(repo, (l) => { l.tasks[1].title = 'Second thing, renamed'; }) });
  const r = init(repo, ['--store']);
  exit(r, 0);
  const report = JSON.parse(r.stdout);
  const warning = report.notes.find((n) => n.includes('branch re$title'));
  assert.ok(warning, JSON.stringify(report.notes));
  assert.match(warning, /T2/);
  assert.ok(warning.includes("import --ref 're$title'"), warning);
  assert.match(r.stderr, /warning: branch re\$title/);

  const state = () => ({ tree: tree(repo), rows: inStore((s) => ['entries', 'status', 'plans', 'tasks', 'task_events']
    .map((t) => s.all(`SELECT * FROM ${t}`).map((row) => ({ ...row })))) });
  const before = state();
  const again = init(repo, ['--store']);
  exit(again, 0);
  assert.match(again.stderr, /warning: branch re\$title/);
  assert.deepEqual(state(), before, 'the re-run changes nothing');
}));

test('two branches retitling the same task differently both warn and neither blocks', () => withSetup(({ dir, git, init, marker }) => {
  const { repo } = buildHistory(dir);
  git(repo, 'branch', '-qD', 'extra');
  branchWith(git, dir, repo, 'title-a', { [LEDGER_PATH]: ledgerText(repo, (l) => { l.tasks[1].title = 'Title A'; }) });
  branchWith(git, dir, repo, 'title-b', { [LEDGER_PATH]: ledgerText(repo, (l) => { l.tasks[1].title = 'Title B'; }) });
  const r = init(repo, ['--store']);
  exit(r, 0);
  const notes = JSON.parse(r.stdout).notes;
  for (const b of ['title-a', 'title-b']) assert.ok(notes.some((n) => n.includes(`branch ${b}`) && n.includes('T2')), `${b}: ${JSON.stringify(notes)}`);
  assert.equal(marker(repo), 'store');
}));

test('--store refuses a post-commit that is not a shell script, changing nothing', () => withSetup(({
  dbFile, init, marker, committedRepo,
}) => {
  const { repo } = committedRepo();
  writeExec(join(repo, '.githooks', 'post-commit'), '#!/usr/bin/env python3\nprint("team hook")\n');
  const before = tree(repo);
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /post-commit is not a shell script/);
  assert.equal(marker(repo), '');
  assert.deepEqual(tree(repo), before);
  assert.equal(existsSync(dbFile), false);
}));

test('a never-opted-in repo whose first switch failed at CLAUDE.md gets the section on the re-run', () => withSetup(({
  dir, git, init, switched, marker,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  chmodSync(repo, 0o555);
  let failed;
  try {
    failed = init(repo, ['--store']);
  } finally {
    chmodSync(repo, 0o755);
  }
  exit(failed, 1);
  assert.equal(marker(repo), 'store');
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);
  const report = switched(repo);
  assert.equal(report.from, 'store');
  assert.equal(report.claudeMd, 'created');
  assert.ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').includes(readFileSync(join(TEMPLATES, 'claude-section-store.md'), 'utf8').trim()));
}));

test('a branch that changes only status.md does not block, and the switch warns that its status is not carried', () => withSetup(({
  dir, git, init,
}) => {
  const { repo } = buildHistory(dir);
  git(repo, 'branch', '-qD', 'extra');
  branchWith(git, dir, repo, 'notes', { 'status.md': `${readFileSync(join(repo, 'status.md'), 'utf8')}\n## Later\n\nA note.\n` });
  const r = init(repo, ['--store']);
  exit(r, 0);
  const report = JSON.parse(r.stdout);
  const warning = report.notes.find((n) => n.includes('branch notes'));
  assert.ok(warning, JSON.stringify(report.notes));
  assert.match(warning, /tracking status set/);
  assert.match(r.stderr, /branch notes/);
}));

test('--store with an absolute core.hooksPath outside the tree installs there, by absolute path, and gates commits', () => withSetup(({
  dir, git, gitRun, init, switched, add, inStore,
}) => {
  const repo = join(dir, 'repo');
  const outside = join(dir, 'shared-hooks');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'config', 'core.hooksPath', outside);
  exit(init(repo), 0);
  const report = switched(repo);
  assert.equal(report.hook.dir, outside);
  assert.equal(report.hook.versioned, false);
  assert.ok(read(join(outside, 'pre-commit')).includes(`'${join(outside, PRE_SCRIPT)}'`));
  assert.doesNotMatch(read(join(outside, 'pre-commit')), /progress-gate\.sh/);
  git(repo, 'add', '-A');
  exit(gitRun(repo, ['commit', '-qm', 'switch']), 1);
  const id = add(repo);
  exit(gitRun(repo, ['commit', '-qm', 'switch']), 0);
  assert.equal(inStore((s) => s.get('SELECT state FROM entries WHERE id = ?', id).state), 'committed');
}));

test('--store with husky (core.hooksPath .husky/_) chains into .husky and its wrappers run the store gates', () => withSetup(({
  dir, git, gitRun, init, switched, add, inStore,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.husky', '_'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const name of ['pre-commit', 'post-commit']) {
    writeExec(join(repo, '.husky', '_', name), `#!/bin/sh\nh="$(dirname "$0")/../${name}"\n[ -f "$h" ] || exit 0\nexec sh -e "$h" "$@"\n`);
  }
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'config', 'core.hooksPath', '.husky/_');
  exit(init(repo), 0);
  const report = switched(repo);
  assert.equal(report.hook.dir, join(repo, '.husky'));
  assert.equal(existsSync(join(repo, '.husky', PRE_SCRIPT)), true);
  assert.match(read(join(repo, '.husky', 'pre-commit')), new RegExp(PRE_SCRIPT.replace(/\./g, '\\.')));
  git(repo, 'add', '-A');
  exit(gitRun(repo, ['commit', '-qm', 'switch']), 1);
  const id = add(repo);
  exit(gitRun(repo, ['commit', '-qm', 'switch']), 0);
  assert.equal(inStore((s) => s.get('SELECT state FROM entries WHERE id = ?', id).state), 'committed', 'post-commit ran through husky');
}));

test('an in-tree hooks dir whose name holds a $ is quoted in the chained call', () => withSetup(({
  dir, git, gitRun, switched, add,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'config', 'core.hooksPath', 'hooks$dir');
  switched(repo);
  assert.equal(existsSync(join(repo, 'hooks$dir', PRE_SCRIPT)), true);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'add', 'a.txt');
  exit(gitRun(repo, ['commit', '-qm', 'change']), 1);
  add(repo);
  exit(gitRun(repo, ['commit', '-qm', 'change']), 0);
}));

test('S1 also refuses a versioned hooks dir named "..hooks", and one inside another worktree\'s tree', () => withSetup(({
  dir, dbFile, git, init, marker,
}) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'initial');
  exit(init(repo, ['--local']), 0);
  git(repo, 'config', 'core.hooksPath', '..hooks');
  exit(init(repo, ['--store']), 1);
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  git(repo, 'config', 'core.hooksPath', join(realpathSync(wt), 'hooks'));
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /local mode/);
  assert.equal(marker(repo), '');
  assert.equal(existsSync(dbFile), false);
}));

// ---- Fix round 3: the recorded origin ----

// A local-mode repository with a tracked AGENTS.md, switched to the store.
function switchedLocalRepo({ dir, git, init, switched }) {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n\nteam text\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  exit(init(repo, ['--local']), 0);
  switched(repo);
  return repo;
}

test('a local-origin store repo stays local on a re-run after its methodology folder is gone: --local --remove refused, nothing written in the tree', () => withSetup((ctx) => {
  const { git, init, switched, marker } = ctx;
  const repo = switchedLocalRepo(ctx);
  assert.equal(git(repo, 'config', '--local', '--get', 'triqual.trackingFrom'), 'local');
  const removed = init(repo, ['--local', '--remove']);
  exit(removed, 1);
  assert.match(removed.stderr, /triqual\.tracking/);
  assert.equal(existsSync(join(repo, '.git', 'methodology')), true, 'the refused --remove deleted nothing');
  rmSync(join(repo, '.git', 'methodology'), { recursive: true, force: true });
  const before = tree(repo);
  const report = switched(repo);
  assert.equal(report.from, 'store');
  assert.equal(report.commit, null);
  assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);
  assert.deepEqual(tree(repo), before, 'no CLAUDE.md, no AGENTS.md change, nothing else in the tree');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(marker(repo), 'store');
}));

test('a local-origin store repo that adopts a versioned core.hooksPath is refused under S1 on a re-run, nothing changed', () => withSetup((ctx) => {
  const { dir, git, init } = ctx;
  const repo = switchedLocalRepo(ctx);
  mkdirSync(join(repo, '.githooks'));
  writeExec(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\necho team hook\n');
  git(repo, 'config', 'core.hooksPath', '.githooks');
  const before = { tree: tree(repo), config: readFileSync(join(repo, '.git', 'config'), 'utf8') };
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /local mode/);
  assert.deepEqual({ tree: tree(repo), config: readFileSync(join(repo, '.git', 'config'), 'utf8') }, before);
  assert.ok(dir);
}));

test('a store repo without the recorded origin is treated as local: nothing written in its tree, and S1 applies', () => withSetup(({
  dir, git, init, switched, committedRepo,
}) => {
  // Hooks in the git dir: the re-run writes no CLAUDE.md and prints no commit.
  const repo = join(dir, 'fresh');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  switched(repo);
  assert.equal(git(repo, 'config', '--local', '--get', 'triqual.trackingFrom'), 'none');
  git(repo, 'config', '--local', '--unset', 'triqual.trackingFrom');
  rmSync(join(repo, 'CLAUDE.md'));
  const before = tree(repo);
  const report = switched(repo);
  assert.equal(report.commit, null);
  assert.equal(report.claudeMd, null);
  assert.deepEqual(tree(repo), before);

  // A versioned hooks dir (committed origin, .githooks): refused under S1, nothing changed.
  const { repo: committed } = committedRepo();
  switched(committed);
  git(committed, 'config', '--local', '--unset', 'triqual.trackingFrom');
  const was = tree(committed);
  const r = init(committed, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /local mode/);
  assert.deepEqual(tree(committed), was);
}));

test('S1 on a store repo without the recorded origin says the origin is unknown and names triqual.trackingFrom committed', () => withSetup(({
  git, init, switched, committedRepo,
}) => {
  const { repo } = committedRepo();
  switched(repo);
  git(repo, 'config', '--local', '--unset', 'triqual.trackingFrom');
  const was = tree(repo);
  const r = init(repo, ['--store']);
  exit(r, 1);
  assert.match(r.stderr, /origin is unknown/);
  assert.ok(r.stderr.includes('`git config --local triqual.trackingFrom committed`'), r.stderr);
  assert.match(r.stderr, /treated as local mode, so nothing is written in its tree/);
  assert.match(r.stderr, /\.githooks/);
  assert.doesNotMatch(r.stderr, /local-mode repository/);
  assert.deepEqual(tree(repo), was);
}));

test('a committed-origin re-run restores a missing CLAUDE.md section', () => withSetup(({ git, switched, committedRepo }) => {
  const { repo } = committedRepo();
  switched(repo);
  assert.equal(git(repo, 'config', '--local', '--get', 'triqual.trackingFrom'), 'committed');
  rmSync(join(repo, 'CLAUDE.md'));
  const report = switched(repo);
  assert.equal(report.claudeMd, 'created');
  assert.ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').includes(readFileSync(join(TEMPLATES, 'claude-section-store.md'), 'utf8').trim()));
}));

test('the store CLAUDE.md section words the entries, the status and the moves by R1-R7 and keeps its markers', () => {
  const text = readFileSync(join(TEMPLATES, 'claude-section-store.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(text.startsWith('<!-- progress-tracking:start'), 'start marker');
  assert.ok(text.trim().endsWith('<!-- progress-tracking:end -->'), 'end marker');
  assert.ok(text.includes('## Progress tracking (strict, mandatory, store mode)'), 'heading');
  // R3: every task that ends with no commit lands with --no-commit, not only a production operation.
  for (const needle of ['a review', 'a ruling', 'a status-only step', 'a spec or plan registration', "the plan's close",
    '`triqual tracking add <draft> --no-commit`', 'stamped onto the next, unrelated commit']) {
    assert.ok(text.includes(needle), `R3: ${needle}`);
  }
  assert.doesNotMatch(text, /--no-commit` records work that ends in no commit \(a production operation\)/);
  // R4: one section first, the whole-file set only for a full rewrite.
  assert.ok(text.indexOf('`triqual tracking status set --section <heading> <draft>`') < text.indexOf('only for a full rewrite'), 'R4');
  // R7: the moves take the bare plan file name, the check takes no --plan; R5; the reference.
  for (const needle of ['--plan <plan file name>', 'never the docs-dir path', 'it takes no `--plan`', 'No tracking file is ever staged',
    '`store-mode.md` under `references` in skill `progress-tracking:progress-tracking`']) {
    assert.ok(text.includes(needle), needle);
  }
});
