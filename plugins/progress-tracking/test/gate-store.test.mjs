// Store-mode gates (plan tracking-store-1 T6): the pre-commit → post-commit handshake run through the installed hook
// lines, the replay and merge exemptions, the Stop gate, and failure containment when the store is missing, disabled
// or corrupt. Every test works in temp repositories with a temp HOME, a temp TRIQUAL_TRACKING_DB and a fake `triqual`
// first on PATH that runs this checkout's bin/tracking.mjs; no hook is ever installed into this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, closeSync,
  utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { EXEMPT, NO_PENDING, STORE_HOOK_LINES, stopVerdictStore } from '../lib/store-hooks.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'cli', 'tracking.mjs');
const GATE = join(PLUGIN, 'scripts', 'gate.mjs');
const TEMPLATES = join(PLUGIN, 'templates');
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const MESSAGE = 'the commit has changes but this worktree has no pending progress entry: add one with `triqual tracking add <draft>`';
const COMMITTED_REASON = 'There are uncommitted changes and progress.md is not updated. Before ending the turn, add the ' +
  'entry for this work at the top of progress.md (stage/task, done, files, real verification, commit, next) and ' +
  'update status.md if the overall state changed. Details: skill progress-tracking:progress-tracking.';

await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

const DRAFT = `## 2026-10-11 — Gate work
- **Stage/task:** off-plan
- **Done:** changed a file
- **Files:** a.txt
- **Verification:** none needed
- **Next:** more
`;

// A clean environment: no inherited GIT_* repo selection or identity, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_REFLOG_ACTION', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'CLAUDE_PLUGIN_DATA']) delete env[k];
  return {
    ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_EDITOR: 'true', ...extra,
  };
};

const hookScript = (lines) => `#!/bin/sh\n${lines.join('\n')}\n`;

function writeExec(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// A temp dir holding a repository (`repo`, one commit, no hooks yet), a HOME, drafts, a data dir for the store, a fake
// `triqual` on PATH and a hooks dir. `storeOn()` switches the repository to store mode: the marker, the store hook
// lines (plus a commit-msg that fails while ABORT_COMMIT is set) as core.hooksPath, and the database. With
// `initialCommit: false` the repository has no commit yet (an unborn branch).
function withSetup(fn, { initialCommit = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gstore-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const drafts = join(dir, 'drafts');
  const fakebin = join(dir, 'fakebin');
  const hooks = join(dir, 'hooks');
  const postOnly = join(dir, 'hooks-post-only');
  const pluginData = join(dir, 'plugin-data');
  for (const d of [repo, home, drafts, fakebin, hooks, postOnly, pluginData]) mkdirSync(d);
  writeExec(join(fakebin, 'triqual'), `#!/bin/sh
[ "$1" = tracking ] || { echo "fake triqual runs tracking only" >&2; exit 3; }
shift
exec '${process.execPath}' '${BIN}' "$@"
`);
  const dbFile = join(dir, 'data', 'tracking.db');
  let dbEnv = { TRIQUAL_TRACKING_DB: dbFile };
  const env = (extra = {}) => cleanEnv(home, {
    ...dbEnv, PATH: `${fakebin}:${process.env.PATH}`, CLAUDE_PLUGIN_DATA: pluginData, ...extra,
  });
  const gitRun = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, env: env(extra), encoding: 'utf8' });
  const git = (cwd, ...args) => {
    const r = gitRun(cwd, args);
    assert.equal(r.status, 0, `git ${args.join(' ')} failed\n${r.stderr}`);
    return r.stdout.trim();
  };
  git(repo, 'init', '-q', '-b', 'main');
  if (initialCommit) {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'initial');
  }

  const storeOn = () => {
    git(repo, 'config', '--local', 'triqual.tracking', 'store');
    writeExec(join(hooks, 'pre-commit'), hookScript(STORE_HOOK_LINES['pre-commit']));
    writeExec(join(hooks, 'post-commit'), hookScript(STORE_HOOK_LINES['post-commit']));
    writeExec(join(hooks, 'commit-msg'), '#!/bin/sh\n[ -z "$ABORT_COMMIT" ] || exit 1\n');
    writeExec(join(postOnly, 'post-commit'), hookScript(STORE_HOOK_LINES['post-commit']));
    git(repo, 'config', '--local', 'core.hooksPath', hooks);
    openStore({ home, env: dbEnv, create: true }).close();
  };
  let draftN = 0;
  const cli = (cwd, args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: env(extra), encoding: 'utf8' });
  // `triqual tracking add` in `cwd`: the new entry's id.
  const add = (cwd, flags = []) => {
    draftN += 1;
    const path = join(drafts, `d${draftN}.md`);
    writeFileSync(path, DRAFT);
    const r = cli(cwd, ['add', path, ...flags]);
    assert.equal(r.status, 0, r.stderr);
    return Number(/^entry (\d+)$/m.exec(r.stdout)[1]);
  };
  const inStore = (f) => {
    const store = openStore({ home, env: { TRIQUAL_TRACKING_DB: dbFile } });
    try { return f(store); } finally { store.close(); }
  };
  const entry = (id) => inStore((s) => s.get('SELECT state, commit_sha FROM entries WHERE id = ?', id));
  // Writes `content` to `file` in `cwd`, stages it and commits: the spawn result.
  const commit = (cwd, file = 'a.txt', content = `${Date.now()}-${Math.random()}\n`, extra = {}) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, 'add', file);
    return gitRun(cwd, ['commit', '-m', `change ${file}`], extra);
  };
  const head = (cwd) => git(cwd, 'rev-parse', 'HEAD');
  const gitDir = (cwd) => realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir'));
  const handshake = (cwd) => join(gitDir(cwd), 'triqual', 'commit-handshake.json');
  const stop = (cwd, payload = {}, extra = {}) => spawnSync(process.execPath, [GATE, 'stop'], {
    cwd, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env: env(extra),
  });
  const setDb = (next) => { dbEnv = next; };
  try {
    return fn({
      dir, repo, home, hooks, postOnly, dbFile, env, git, gitRun, storeOn, cli, add, inStore, entry, commit, head, gitDir,
      handshake, stop, setDb,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
const refusedWithMessage = (r) => {
  assert.equal(r.status, 1, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stderr.split('\n').includes(MESSAGE), r.stderr);
};
const blockOf = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout === '' ? null : JSON.parse(r.stdout);
};

// ---- EXEMPT and the hook lines ----

test('EXEMPT is the local pre-commit template\'s list and progress-gate.sh\'s loop', () => {
  const local = /const EXEMPT = (\[[^\]]*\]);/.exec(readFileSync(join(TEMPLATES, 'pre-commit-local.mjs'), 'utf8'))[1];
  assert.deepEqual([...EXEMPT], JSON.parse(local.replace(/'/g, '"')));
  const loop = /^for f in ([^;]+); do$/m.exec(readFileSync(join(TEMPLATES, 'progress-gate.sh'), 'utf8'))[1];
  assert.deepEqual([...EXEMPT], loop.trim().split(/\s+/));
});

test('the store hook lines check the marker, then triqual, then exec the hook', () => {
  for (const name of ['pre-commit', 'post-commit']) {
    const lines = STORE_HOOK_LINES[name];
    assert.equal(lines[0], '[ "$(git config --local --get triqual.tracking)" = store ] || exit 0');
    assert.match(lines[1], /^command -v triqual >\/dev\/null 2>&1 \|\| \{ echo "[^"$`]*triqual[^"$`]*" >&2; exit [01]; \}$/);
    assert.equal(lines[2], `exec triqual tracking hook ${name}`);
  }
  assert.match(STORE_HOOK_LINES['pre-commit'][1], /exit 1; \}$/);
  assert.match(STORE_HOOK_LINES['post-commit'][1], /exit 0; \}$/);
});

test('hook lines: with the marker unset they exit 0 without running triqual', () => withSetup(({ dir, repo, env }) => {
  const rec = join(dir, 'recorder');
  mkdirSync(rec);
  writeExec(join(rec, 'triqual'), `#!/bin/sh\necho ran >> '${join(dir, 'ran')}'\nexit 7\n`);
  for (const name of ['pre-commit', 'post-commit']) {
    const script = join(dir, `${name}.sh`);
    writeExec(script, hookScript(STORE_HOOK_LINES[name]));
    const r = spawnSync('sh', [script], { cwd: repo, env: env({ PATH: `${rec}:${process.env.PATH}` }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(existsSync(join(dir, 'ran')), false);
}));

test('hook lines: with triqual absent, pre-commit exits 1 naming triqual and post-commit exits 0', () => withSetup(({ dir, repo, git, env }) => {
  git(repo, 'config', '--local', 'triqual.tracking', 'store');
  const bare = join(dir, 'bare-bin');
  mkdirSync(bare);
  writeExec(join(bare, 'git'), `#!/bin/sh\nexec '${GIT_BIN}' "$@"\n`);
  const path = `${bare}:/usr/bin:/bin`;
  assert.notEqual(spawnSync('sh', ['-c', 'command -v triqual'], { env: { PATH: path } }).status, 0, 'triqual must be absent');
  const run = (name) => {
    const script = join(dir, `${name}.sh`);
    writeExec(script, hookScript(STORE_HOOK_LINES[name]));
    return spawnSync('sh', [script], { cwd: repo, env: env({ PATH: path }), encoding: 'utf8' });
  };
  const pre = run('pre-commit');
  assert.equal(pre.status, 1);
  assert.match(pre.stderr, /triqual/);
  assert.equal(run('post-commit').status, 0);
}));

// ---- stopVerdictStore ----

test('stopVerdictStore: null on stop_hook_active or a clean tree, a block without a pending entry, null with one', () => {
  const base = { dirty: ['a.txt'], input: {}, pending: [], storeError: null, fingerprint: 'f1', lastFingerprint: null };
  assert.equal(stopVerdictStore({ ...base, input: { stop_hook_active: true } }), null);
  assert.equal(stopVerdictStore({ ...base, dirty: [] }), null);
  assert.deepEqual(stopVerdictStore(base), { decision: 'block', reason: MESSAGE });
  assert.equal(stopVerdictStore({ ...base, pending: [{ id: 3 }] }), null);
  assert.deepEqual(stopVerdictStore({ ...base, fingerprint: null, lastFingerprint: null }), { decision: 'block', reason: MESSAGE });
});

test('stopVerdictStore: a store error blocks once per change set, naming the failure', () => {
  const err = Object.assign(new Error('no tracking database at /x/tracking.db'), { code: 'missing', where: '/x/tracking.db' });
  const base = { dirty: ['a.txt'], input: {}, pending: [], storeError: err, fingerprint: 'f1', lastFingerprint: null };
  const v = stopVerdictStore(base);
  assert.equal(v.decision, 'block');
  // It leads with the failure: pending entries were never read, so the no-pending text would mislead.
  assert.ok(v.reason.startsWith('Stop (progress-tracking, store mode): the tracking store at /x/tracking.db failed (missing)'), v.reason);
  assert.ok(!v.reason.includes(MESSAGE), v.reason);
  assert.match(v.reason, /triqual tracking restore/);
  assert.equal(stopVerdictStore({ ...base, lastFingerprint: 'f1' }), null);
  assert.equal(stopVerdictStore({ ...base, lastFingerprint: 'f0' }).decision, 'block');
  assert.equal(stopVerdictStore({ ...base, input: { stop_hook_active: true } }), null);
});

// ---- pre-commit and post-commit across two worktrees ----

test('two worktrees: only a pending entry of this worktree lets the commit through, and post-commit stamps it', () => withSetup((s) => {
  s.storeOn();
  const other = join(s.dir, 'other');
  s.git(s.repo, 'worktree', 'add', '-q', '-b', 'other', other);

  // No pending entry anywhere: refused with the exact message, and the read-only gate created no repository row.
  refusedWithMessage(s.commit(s.repo));
  assert.equal(s.inStore((st) => st.get('SELECT COUNT(*) AS n FROM repos').n), 0);
  const direct = s.cli(s.repo, ['hook', 'pre-commit']);
  assert.equal(direct.status, 1);
  assert.equal(direct.stderr, `${MESSAGE}\n`);

  // A pending entry only in the other worktree does not count here.
  const otherId = s.add(other);
  refusedWithMessage(s.gitRun(s.repo, ['commit', '-m', 'still refused']));

  // A pending entry in this worktree: the pre-commit records the tree being committed and the ids.
  const id = s.add(s.repo);
  ok(s.cli(s.repo, ['hook', 'pre-commit']));
  const hs = JSON.parse(readFileSync(s.handshake(s.repo), 'utf8'));
  assert.deepEqual(hs, { tree: s.git(s.repo, 'write-tree'), ids: [id] });

  ok(s.gitRun(s.repo, ['commit', '-m', 'gated']));
  assert.deepEqual(s.entry(id), { state: 'committed', commit_sha: s.head(s.repo) });
  assert.deepEqual(s.entry(otherId), { state: 'pending', commit_sha: null });
  assert.equal(existsSync(s.handshake(s.repo)), false);

  // The entry is used up: the next commit in this worktree needs a new one; the other worktree's still works there.
  refusedWithMessage(s.commit(s.repo));
  s.git(s.repo, 'reset', '-q', '--hard');
  ok(s.commit(other));
  assert.deepEqual(s.entry(otherId), { state: 'committed', commit_sha: s.head(other) });
}));

test('post-commit stamps only the handshake\'s ids', () => withSetup((s) => {
  s.storeOn();
  const first = s.add(s.repo);
  writeFileSync(join(s.repo, 'a.txt'), 'changed\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.cli(s.repo, ['hook', 'pre-commit']));
  const later = s.add(s.repo); // added after the pre-commit ran: not this commit's
  ok(s.gitRun(s.repo, ['-c', `core.hooksPath=${s.postOnly}`, 'commit', '-m', 'post-commit only']));
  assert.deepEqual(s.entry(first), { state: 'committed', commit_sha: s.head(s.repo) });
  assert.deepEqual(s.entry(later), { state: 'pending', commit_sha: null });
  assert.equal(existsSync(s.handshake(s.repo)), false);
}));

test('post-commit reports a handshake id it could not stamp and still exits 0', () => withSetup((s) => {
  s.storeOn();
  const id = s.add(s.repo);
  ok(s.commit(s.repo)); // stamps id
  mkdirSync(dirname(s.handshake(s.repo)), { recursive: true });
  writeFileSync(s.handshake(s.repo), JSON.stringify({ tree: s.git(s.repo, 'rev-parse', 'HEAD^{tree}'), ids: [id] }));
  const r = s.cli(s.repo, ['hook', 'post-commit']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /stamped 0 of 1/);
  assert.equal(existsSync(s.handshake(s.repo)), false);
}));

test('a repository\'s first commit (an unborn branch) stamps its entry', () => withSetup((s) => {
  s.storeOn();
  const id = s.add(s.repo);
  ok(s.commit(s.repo, 'first.txt'));
  assert.match(s.git(s.repo, 'reflog', '-1', '--format=%gs', 'HEAD'), /^commit \(initial\): /);
  assert.deepEqual(s.entry(id), { state: 'committed', commit_sha: s.head(s.repo) });
  assert.equal(existsSync(s.handshake(s.repo)), false);
  // Used up: the second commit needs an entry of its own.
  refusedWithMessage(s.commit(s.repo, 'second.txt'));
}, { initialCommit: false }));

test('post-commit names the ids it skips when git commit made HEAD with another tree', () => withSetup((s) => {
  s.storeOn();
  const id = s.add(s.repo);
  writeFileSync(join(s.repo, 'a.txt'), 'changed\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.cli(s.repo, ['hook', 'pre-commit']));
  writeFileSync(join(s.repo, 'b.txt'), 'staged after the pre-commit\n');
  s.git(s.repo, 'add', 'b.txt');
  const r = ok(s.gitRun(s.repo, ['-c', `core.hooksPath=${s.postOnly}`, 'commit', '-m', 'other tree']));
  const lines = r.stderr.split('\n').filter((l) => l.includes('post-commit (progress-tracking, store mode)'));
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0].includes(`entries ${id} `) && lines[0].includes('not stamped'), lines[0]);
  assert.deepEqual(s.entry(id), { state: 'pending', commit_sha: null });
  assert.equal(existsSync(s.handshake(s.repo)), false);
}));

// ---- replays stamp nothing ----

// A history where `side` and `main` both changed a.txt (a conflict) and `clean` added c.txt, built before the switch.
function conflictHistory(s) {
  s.git(s.repo, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(s.repo, 'a.txt'), 'side\n');
  s.git(s.repo, 'commit', '-qam', 'side');
  s.git(s.repo, 'checkout', '-q', 'main');
  writeFileSync(join(s.repo, 'a.txt'), 'main\n');
  s.git(s.repo, 'commit', '-qam', 'main');
}

// An aborted commit (its commit-msg fails) whose pre-commit passed: it leaves a handshake naming `id` with the tree of
// the index it saw. The staged change is then undone.
function abortedCommit(s, file, content) {
  writeFileSync(join(s.repo, file), content);
  s.git(s.repo, 'add', file);
  const r = s.gitRun(s.repo, ['commit', '-m', 'aborted'], { ABORT_COMMIT: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(s.handshake(s.repo)), true);
  const tree = JSON.parse(readFileSync(s.handshake(s.repo), 'utf8')).tree;
  s.git(s.repo, 'reset', '-q', '--hard');
  return tree;
}

// After a replay: the entry is still pending, and the next real commit passes and stamps it.
function nextRealCommitStamps(s, id) {
  assert.deepEqual(s.entry(id), { state: 'pending', commit_sha: null });
  ok(s.commit(s.repo, 'next.txt'));
  assert.deepEqual(s.entry(id), { state: 'committed', commit_sha: s.head(s.repo) });
}

test('a conflicted cherry-pick finished with git commit stamps nothing', () => withSetup((s) => {
  conflictHistory(s);
  s.storeOn();
  const id = s.add(s.repo);
  assert.notEqual(s.gitRun(s.repo, ['cherry-pick', 'side']).status, 0);
  writeFileSync(join(s.repo, 'a.txt'), 'resolved\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.gitRun(s.repo, ['commit', '--no-edit']));
  nextRealCommitStamps(s, id);
}));

test('git revert stamps nothing, even over a stale handshake with the same tree', () => withSetup((s) => {
  s.git(s.repo, 'checkout', '-q', '-b', 'tmp');
  writeFileSync(join(s.repo, 'b.txt'), 'b\n');
  s.git(s.repo, 'add', 'b.txt');
  s.git(s.repo, 'commit', '-qm', 'add b');
  s.storeOn();
  const id = s.add(s.repo);
  // The aborted commit staged the removal of b.txt: the tree a revert of HEAD produces.
  rmSync(join(s.repo, 'b.txt'));
  s.git(s.repo, 'add', '-A');
  const r = s.gitRun(s.repo, ['commit', '-m', 'aborted'], { ABORT_COMMIT: '1' });
  assert.notEqual(r.status, 0);
  const tree = JSON.parse(readFileSync(s.handshake(s.repo), 'utf8')).tree;
  s.git(s.repo, 'reset', '-q', '--hard');
  ok(s.gitRun(s.repo, ['revert', '--no-edit', 'HEAD']));
  assert.equal(s.git(s.repo, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.match(s.git(s.repo, 'reflog', '-1', '--format=%gs', 'HEAD'), /^revert: /);
  assert.equal(existsSync(s.handshake(s.repo)), false);
  nextRealCommitStamps(s, id);
}));

test('a merge-conflict commit stamps nothing and clears a stale handshake', () => withSetup((s) => {
  conflictHistory(s);
  s.storeOn();
  const id = s.add(s.repo);
  abortedCommit(s, 'stale.txt', 'stale\n');
  assert.notEqual(s.gitRun(s.repo, ['merge', 'side']).status, 0);
  writeFileSync(join(s.repo, 'a.txt'), 'merged\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.gitRun(s.repo, ['commit', '--no-edit']));
  assert.equal(existsSync(s.handshake(s.repo)), false);
  nextRealCommitStamps(s, id);
}));

test('a merge-conflict commit with no pending entry passes the pre-commit', () => withSetup((s) => {
  conflictHistory(s);
  s.storeOn();
  assert.notEqual(s.gitRun(s.repo, ['merge', 'side']).status, 0);
  writeFileSync(join(s.repo, 'a.txt'), 'merged\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.gitRun(s.repo, ['commit', '--no-edit']));
  assert.match(s.git(s.repo, 'reflog', '-1', '--format=%gs', 'HEAD'), /^commit \(merge\): /);
}));

test('a conflicted cherry-pick finished with git commit and no pending entry passes the pre-commit', () => withSetup((s) => {
  conflictHistory(s);
  s.storeOn();
  assert.notEqual(s.gitRun(s.repo, ['cherry-pick', 'side']).status, 0);
  writeFileSync(join(s.repo, 'a.txt'), 'resolved\n');
  s.git(s.repo, 'add', 'a.txt');
  ok(s.gitRun(s.repo, ['commit', '--no-edit']));
  assert.equal(s.git(s.repo, 'show', 'HEAD:a.txt'), 'resolved');
}));

test('the pre-commit of a merge in progress clears a stale handshake and records none', () => withSetup((s) => {
  conflictHistory(s);
  s.storeOn();
  const id = s.add(s.repo);
  abortedCommit(s, 'stale.txt', 'stale\n');
  assert.notEqual(s.gitRun(s.repo, ['merge', 'side']).status, 0);
  writeFileSync(join(s.repo, 'a.txt'), 'merged\n');
  s.git(s.repo, 'add', 'a.txt');
  assert.equal(existsSync(join(s.gitDir(s.repo), 'MERGE_HEAD')), true);
  assert.equal(existsSync(s.handshake(s.repo)), true);
  ok(s.cli(s.repo, ['hook', 'pre-commit']));
  assert.equal(existsSync(s.handshake(s.repo)), false);
  assert.deepEqual(s.entry(id), { state: 'pending', commit_sha: null });
}));

test('commit --amend with nothing staged stamps nothing', () => withSetup((s) => {
  s.storeOn();
  const id = s.add(s.repo);
  abortedCommit(s, 'stale.txt', 'stale\n');
  ok(s.gitRun(s.repo, ['commit', '--amend', '--no-edit']));
  assert.match(s.git(s.repo, 'reflog', '-1', '--format=%gs', 'HEAD'), /^commit \(amend\): /);
  assert.equal(existsSync(s.handshake(s.repo)), false);
  nextRealCommitStamps(s, id);
}));

test('a clean cherry-pick over a stale handshake with the same tree stamps nothing', () => withSetup((s) => {
  s.git(s.repo, 'checkout', '-q', '-b', 'pick');
  writeFileSync(join(s.repo, 'c.txt'), 'c\n');
  s.git(s.repo, 'add', 'c.txt');
  s.git(s.repo, 'commit', '-qm', 'add c');
  s.git(s.repo, 'checkout', '-q', 'main');
  s.storeOn();
  const id = s.add(s.repo);
  const tree = abortedCommit(s, 'c.txt', 'c\n');
  ok(s.gitRun(s.repo, ['cherry-pick', 'pick']));
  assert.equal(s.git(s.repo, 'rev-parse', 'HEAD^{tree}'), tree);
  nextRealCommitStamps(s, id);
}));

// ---- --no-commit ----

test('a --no-commit entry satisfies neither the pre-commit nor Stop', () => withSetup((s) => {
  s.storeOn();
  s.add(s.repo, ['--no-commit']);
  refusedWithMessage(s.commit(s.repo));
  assert.deepEqual(blockOf(s.stop(s.repo)), { decision: 'block', reason: MESSAGE });
}));

// ---- Stop ----

test('Stop: dirty with no pending entry blocks once per change set; an entry lets it end', () => withSetup((s) => {
  s.storeOn();
  writeFileSync(join(s.repo, 'a.txt'), 'dirty\n');
  const payload = { session_id: 'sess-1' };
  assert.deepEqual(blockOf(s.stop(s.repo, payload)), { decision: 'block', reason: MESSAGE });
  assert.equal(blockOf(s.stop(s.repo, payload)), null);
  const later = new Date(Date.now() + 5000);
  utimesSync(join(s.repo, 'a.txt'), later, later);
  assert.deepEqual(blockOf(s.stop(s.repo, payload)), { decision: 'block', reason: MESSAGE });
  // Without a session id every stop blocks.
  assert.deepEqual(blockOf(s.stop(s.repo)), { decision: 'block', reason: MESSAGE });
  assert.deepEqual(blockOf(s.stop(s.repo)), { decision: 'block', reason: MESSAGE });
  s.add(s.repo);
  assert.equal(blockOf(s.stop(s.repo)), null);
  assert.equal(s.inStore((st) => st.get("SELECT COUNT(*) AS n FROM entries WHERE state = 'pending'").n), 1);
}));

test('Stop: a clean tree and stop_hook_active never block', () => withSetup((s) => {
  s.storeOn();
  assert.equal(blockOf(s.stop(s.repo)), null);
  writeFileSync(join(s.repo, 'a.txt'), 'dirty\n');
  assert.equal(blockOf(s.stop(s.repo, { stop_hook_active: true })), null);
}));

test('Stop: dirty with no pending entry in either of two worktrees blocks both', () => withSetup((s) => {
  s.storeOn();
  const other = join(s.dir, 'other');
  s.git(s.repo, 'worktree', 'add', '-q', '-b', 'other', other);
  writeFileSync(join(s.repo, 'a.txt'), 'dirty here\n');
  writeFileSync(join(other, 'a.txt'), 'dirty there\n');
  assert.deepEqual(blockOf(s.stop(s.repo, { session_id: 'a' })), { decision: 'block', reason: MESSAGE });
  assert.deepEqual(blockOf(s.stop(other, { session_id: 'b' })), { decision: 'block', reason: MESSAGE });
  s.add(s.repo);
  assert.equal(blockOf(s.stop(s.repo)), null);
  assert.deepEqual(blockOf(s.stop(other)), { decision: 'block', reason: MESSAGE });
}));

// ---- failure containment ----

// A committed-mode repository with progress-gate.sh as its pre-commit, for checking it is unaffected.
function committedRepo(s) {
  const c = join(s.dir, 'committed');
  const chooks = join(s.dir, 'committed-hooks');
  mkdirSync(c);
  mkdirSync(chooks);
  copyFileSync(join(TEMPLATES, 'progress-gate.sh'), join(chooks, 'pre-commit'));
  chmodSync(join(chooks, 'pre-commit'), 0o755);
  s.git(c, 'init', '-q', '-b', 'main');
  s.git(c, 'config', '--local', 'core.hooksPath', chooks);
  writeFileSync(join(c, 'progress.md'), '# Progress\n\n## 2026-10-11 — First\n- done\n');
  writeFileSync(join(c, 'status.md'), '# Status\n');
  s.git(c, 'add', '.');
  s.git(c, 'commit', '-qm', 'tracking');
  return c;
}

// The committed repository's gates, run with the broken store environment: unchanged behavior.
function committedGatesUnchanged(s, c) {
  writeFileSync(join(c, 'code.txt'), `${Math.random()}\n`);
  s.git(c, 'add', 'code.txt');
  const refused = s.gitRun(c, ['commit', '-m', 'no tracking']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not include progress\.md and status\.md/);
  assert.deepEqual(blockOf(s.stop(c)), { decision: 'block', reason: COMMITTED_REASON });
  writeFileSync(join(c, 'progress.md'), `${readFileSync(join(c, 'progress.md'), 'utf8')}\n## 2026-10-11 — More\n- more\n`);
  writeFileSync(join(c, 'status.md'), `# Status\n${Math.random()}\n`);
  assert.equal(blockOf(s.stop(c)), null);
  s.git(c, 'add', 'progress.md', 'status.md');
  ok(s.gitRun(c, ['commit', '-m', 'with tracking']));
}

// Overwrites the database's pages after the 100-byte header: it still opens, and the first query fails as corrupt.
function corruptPages(file) {
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, 100);
  } finally {
    closeSync(fd);
  }
}

const BROKEN = [
  { name: 'missing', code: 'missing', path: true, prepare: (s) => rmSync(s.dbFile) },
  { name: 'disabled (empty)', code: 'disabled', path: false, prepare: (s) => s.setDb({ TRIQUAL_TRACKING_DB: '' }) },
  { name: 'disabled (relative)', code: 'disabled', path: false, prepare: (s) => s.setDb({ TRIQUAL_TRACKING_DB: 'rel/tracking.db' }) },
  { name: 'not an SQLite file', code: 'open', path: true, prepare: (s) => writeFileSync(s.dbFile, 'this is not a database, just text that is long enough to fill a header.\n') },
  { name: 'corrupt pages', code: 'ERR_SQLITE_ERROR', path: true, prepare: (s) => corruptPages(s.dbFile) },
];

test('Stop: a store failure after a no-pending block of the same change set still blocks, once', () => withSetup((s) => {
  s.storeOn();
  writeFileSync(join(s.repo, 'a.txt'), 'dirty\n');
  const payload = { session_id: 'sess-fp' };
  assert.deepEqual(blockOf(s.stop(s.repo, payload)), { decision: 'block', reason: MESSAGE });
  rmSync(s.dbFile);
  const v = blockOf(s.stop(s.repo, payload));
  assert.ok(v && v.decision === 'block', JSON.stringify(v));
  assert.ok(v.reason.includes('(missing)'), v.reason);
  assert.equal(blockOf(s.stop(s.repo, payload)), null);
}));

test('a locked store (SQLITE_BUSY after busy_timeout) makes the pre-commit fail closed', () => withSetup((s) => {
  s.storeOn();
  s.add(s.repo);
  writeFileSync(join(s.repo, 'a.txt'), 'locked\n');
  s.git(s.repo, 'add', 'a.txt');
  // In WAL mode BEGIN EXCLUSIVE alone does not block readers; the exclusive locking mode does.
  const holder = openStore({ home: s.home, env: { TRIQUAL_TRACKING_DB: s.dbFile } });
  try {
    holder.db.exec('PRAGMA locking_mode = EXCLUSIVE');
    holder.db.exec('BEGIN EXCLUSIVE');
    holder.db.exec('DELETE FROM import_guard');
    const r = s.cli(s.repo, ['hook', 'pre-commit']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(s.dbFile), r.stderr);
    assert.match(r.stderr, /\(open\)/);
    assert.match(r.stderr, /locked/);
    assert.match(r.stderr, /triqual tracking restore/);
    assert.equal(existsSync(s.handshake(s.repo)), false);
  } finally {
    try { holder.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    holder.close();
  }
}));

for (const broken of BROKEN) {
  test(`store ${broken.name}: pre-commit fails closed naming it, Stop blocks once, a committed repository is unaffected`, () => withSetup((s) => {
    s.storeOn();
    s.add(s.repo); // a pending entry the broken store can no longer show
    const c = committedRepo(s);
    broken.prepare(s);

    const r = s.commit(s.repo);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(broken.path ? s.dbFile : 'TRIQUAL_TRACKING_DB'), r.stderr);
    assert.ok(r.stderr.includes(`(${broken.code})`), r.stderr);
    assert.match(r.stderr, /triqual tracking restore/);

    const payload = { session_id: `broken-${broken.code}` };
    const v = blockOf(s.stop(s.repo, payload));
    assert.equal(v.decision, 'block');
    assert.ok(v.reason.startsWith(`Stop (progress-tracking, store mode): the tracking store at ${broken.path ? s.dbFile : 'TRIQUAL_TRACKING_DB'}`), v.reason);
    assert.ok(v.reason.includes(`(${broken.code})`), v.reason);
    assert.ok(!v.reason.includes(MESSAGE), v.reason);
    assert.match(v.reason, /triqual tracking restore/);
    assert.equal(blockOf(s.stop(s.repo, payload)), null);

    committedGatesUnchanged(s, c);
  }));
}

// ---- the read-only open of the gates and a writer racing it ----

// A writer that commits to the WAL between the WAL check and the header read leaves a stale header in the main file;
// the read-only open must not take it for an older schema. fs.readSync is wrapped (and the builtin's ESM bindings
// synced) so that the writer commits right after the header is read, deterministically.
test('read-only open: a writer committing to the WAL during the header read is no false "older schema"', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gstore-race-')));
  const env = { TRIQUAL_TRACKING_DB: join(dir, 'tracking.db') };
  const file = env.TRIQUAL_TRACKING_DB;
  const realReadSync = fs.readSync;
  let writer = null;
  try {
    const store = openStore({ home: dir, env, create: true });
    const version = store.get('PRAGMA user_version').user_version;
    store.close();
    // The main file's header now says user_version 0; the writer will commit the current version to the WAL.
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 0');
    raw.close();
    assert.equal(existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0, false);
    let armed = true;
    fs.readSync = function readSync(...args) {
      const n = realReadSync.apply(this, args);
      if (armed) {
        armed = false;
        writer = new DatabaseSync(file);
        writer.exec('PRAGMA wal_autocheckpoint = 0');
        writer.exec(`PRAGMA user_version = ${version}`);
      }
      return n;
    };
    syncBuiltinESMExports();
    const ro = openStore({ home: dir, env, readOnly: true });
    try {
      assert.equal(armed, false, 'the header was read through fs.readSync');
      assert.equal(ro.get('PRAGMA user_version').user_version, version);
    } finally {
      ro.close();
    }
  } finally {
    fs.readSync = realReadSync;
    syncBuiltinESMExports();
    writer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
