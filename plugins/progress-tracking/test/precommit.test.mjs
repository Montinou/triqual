import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, realpathSync, existsSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../lib/brand.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const COMMITTED_GATE = join(TEMPLATES, 'progress-gate.sh');
const LOCAL_GATE = join(TEMPLATES, 'pre-commit-local.mjs');

const TEMPLATE = '# Progress\n\nAppend-only log: one entry per task, newest on top.\n';
const withEntry = (text, title) => text.replace(/\n(?=## |$)/, `\n## 2026-09-27 — ${title}\n- done\n\n`);
const LEDGER = 'docs/plans/2026-09-27-p.tasks.json';
const skipMsg = (what) => `pre-commit (progress-tracking): ${what} not available; skipped the ledger check.\n`;
const missingMsg = (missing) => `pre-commit (progress-tracking): the commit has changes but does not include ${missing}.\n` +
  "Add this task's entry at the top of progress.md, update status.md and git add both.\n";
const localMsg = (progress) => 'pre-commit (progress-tracking, local mode): progress.md has no new entry since the last ' +
  `commit. Write this task's entry to a draft file outside the repo and run \`triqual tracking write entry <draft>\` ` +
  `(it lands at the top of ${progress}; agents cannot edit files under the git dir).`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// PATH without any directory that holds a `triqual` or a `cm` (the real shim or alias may be installed on this machine).
const PATH_NO_CM = (process.env.PATH ?? '').split(delimiter)
  .filter((d) => d && ![BRAND.cli, BRAND.legacy.cli].some((name) => existsSync(join(d, name)))).join(delimiter);

// Every git call runs with a temp HOME, no global or system config, and no inherited repo-selecting variables.
function envFor(home, path = PATH_NO_CM) {
  const env = { ...process.env, HOME: home, PATH: path, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig') };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

// `unborn`: skip the initial commit, so HEAD does not resolve yet.
function withRepo(fn, { unborn = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-precommit-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-precommit-home-')));
  writeFileSync(join(home, 'gitconfig'), '');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir, encoding: 'utf8', env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  // A commit run the way a user runs it (hooks on); `path` picks the PATH the hook sees.
  const commit = (args, { path, cwd = dir } = {}) => spawnSync('git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...args], { cwd, encoding: 'utf8', env: envFor(home, path) });
  try {
    git('init', '-q', '-b', 'main');
    if (!unborn) {
      writeFileSync(join(dir, 'README.md'), 'readme\n');
      git('add', '.');
      git('commit', '-qm', 'init', '--no-verify');
    }
    return fn({ dir, home, git, commit });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// ---- committed mode ----

// Tracking files committed, the gate installed the way init does: .githooks/ + core.hooksPath.
function installCommitted({ dir, git }) {
  write(dir, 'progress.md', withEntry(TEMPLATE, 'Setup'));
  write(dir, 'status.md', '# Status\nphase one\n');
  mkdirSync(join(dir, '.githooks'));
  copyFileSync(COMMITTED_GATE, join(dir, '.githooks', 'progress-gate.sh'));
  write(dir, '.githooks/pre-commit', '#!/bin/sh\nsh "$(git rev-parse --show-toplevel)/.githooks/progress-gate.sh" || exit 1\n');
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o755);
  git('config', 'core.hooksPath', '.githooks');
  git('add', '-A');
  git('commit', '-qm', 'tracking', '--no-verify');
}

// A fake `cm` (or `name`) first on PATH: records its args and cwd, prints a line (none when `silent`), exits with
// `code`.
function fakeCm(home, code, { silent = false, name = BRAND.legacy.cli } = {}) {
  const bin = join(home, `bin-${name}-${code}${silent ? '-silent' : ''}`);
  mkdirSync(bin);
  const log = join(bin, 'calls.log');
  const say = silent ? '' : 'echo "fake cm drift line"\n';
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n${say}exit ${code}\n`);
  chmodSync(join(bin, name), 0o755);
  return { bin, path: `${bin}${delimiter}${PATH_NO_CM}`, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

const bumpTracking = (dir, which = ['progress.md', 'status.md']) => {
  if (which.includes('progress.md')) write(dir, 'progress.md', withEntry(readFileSync(join(dir, 'progress.md'), 'utf8'), 'Next'));
  if (which.includes('status.md')) write(dir, 'status.md', `${readFileSync(join(dir, 'status.md'), 'utf8')}more\n`);
};

test('committed: a code-only commit is rejected, naming both files', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  r.git('add', 'code.js');
  const res = r.commit(['-m', 'code only']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md and status.md'));
}));

test('committed: code plus progress.md alone is rejected, naming status.md', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  bumpTracking(r.dir, ['progress.md']);
  r.git('add', 'code.js', 'progress.md');
  const res = r.commit(['-m', 'no status']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('status.md'));
}));

test('committed: code plus status.md alone is rejected, naming progress.md', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  bumpTracking(r.dir, ['status.md']);
  r.git('add', 'code.js', 'status.md');
  const res = r.commit(['-m', 'no progress']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md'));
}));

test('committed: a ledger-only commit passes, and the staged ledger is checked', () => withRepo((r) => {
  installCommitted(r);
  const cm = fakeCm(r.home, 0);
  write(r.dir, LEDGER, '{}\n');
  r.git('add', LEDGER);
  const res = r.commit(['-m', 'ledger only'], { path: cm.path });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(cm.calls(), `${r.dir}|tasks check --staged\n`);
}));

test('committed: the ledger check runs through triqual when only it is on PATH, and through cm when only it is', () => withRepo((r) => {
  installCommitted(r);
  for (const [i, name] of [BRAND.cli, BRAND.legacy.cli].entries()) {
    const cli = fakeCm(r.home, 0, { name });
    write(r.dir, LEDGER, `{"n":${i}}\n`);
    r.git('add', LEDGER);
    const res = r.commit(['-m', `ledger via ${name}`], { path: cli.path });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(cli.calls(), `${r.dir}|tasks check --staged\n`, name);
  }
  // Both on PATH: triqual runs, cm does not.
  const triqual = fakeCm(r.home, 1, { name: BRAND.cli });
  const cm = fakeCm(r.home, 1);
  write(r.dir, LEDGER, '{"n":2}\n');
  r.git('add', LEDGER);
  const res = r.commit(['-m', 'both'], { path: `${triqual.bin}${delimiter}${cm.path}` });
  assert.equal(res.status, 1);
  assert.equal(triqual.calls(), `${r.dir}|tasks check --staged\n`);
  assert.equal(cm.calls(), '');
}));

test('committed: a ledger in a subdirectory of docs/plans is not a tracking file', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'docs/plans/old/x.tasks.json', '{}\n');
  r.git('add', '-A');
  const res = r.commit(['-m', 'nested ledger']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md and status.md'));
}));

test('committed: code, both files and a ledger pass when cm check exits 0', () => withRepo((r) => {
  installCommitted(r);
  const cm = fakeCm(r.home, 0);
  write(r.dir, 'code.js', '1\n');
  write(r.dir, LEDGER, '{}\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  const res = r.commit(['-m', 'full'], { path: cm.path });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.equal(cm.calls(), `${r.dir}|tasks check --staged\n`);
}));

test('committed: the same commit fails when cm check exits 1, after printing its output', () => withRepo((r) => {
  installCommitted(r);
  const cm = fakeCm(r.home, 1);
  write(r.dir, 'code.js', '1\n');
  write(r.dir, LEDGER, '{}\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  const res = r.commit(['-m', 'drift'], { path: cm.path });
  assert.equal(res.status, 1);
  assert.equal(res.stderr, 'fake cm drift line\n');
  assert.equal(cm.calls(), `${r.dir}|tasks check --staged\n`);
}));

test('committed: with neither triqual nor cm on PATH the commit passes with the skip warning', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  write(r.dir, LEDGER, '{}\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  const res = r.commit(['-m', 'no cli']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, skipMsg(`${BRAND.cli} or ${BRAND.legacy.cli}`));
}));

test('committed: when the CLI found exits 3 (plugin missing) the commit passes with a skip warning naming it', () => withRepo((r) => {
  installCommitted(r);
  for (const name of [BRAND.cli, BRAND.legacy.cli]) {
    write(r.dir, LEDGER, `${JSON.stringify({ name })}\n`);
    r.git('add', '-A');
    const cli = fakeCm(r.home, 3, { name });
    const res = r.commit(['-m', `${name} 3`], { path: cli.path });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, skipMsg(name), name);
    assert.equal(cli.calls(), `${r.dir}|tasks check --staged\n`, name);
  }
}));

test('committed: when cm fails with no output the gate names the check and its exit code', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, LEDGER, '{}\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  for (const code of [1, 2]) {
    const cm = fakeCm(r.home, code, { silent: true });
    const res = r.commit(['-m', `cm ${code}`], { path: cm.path });
    assert.equal(res.status, 1, `exit ${code}`);
    assert.equal(res.stderr, `pre-commit (progress-tracking): ${BRAND.legacy.cli} tasks check --staged failed (exit ${code}).\n`);
    assert.equal(cm.calls(), `${r.dir}|tasks check --staged\n`);
  }
}));

test('committed: renaming code into a ledger path is a code change, not a ledger-only commit', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  r.git('add', 'code.js');
  r.git('commit', '-qm', 'code', '--no-verify');
  mkdirSync(join(r.dir, 'docs', 'plans'), { recursive: true });
  r.git('mv', 'code.js', 'docs/plans/q.tasks.json');
  const res = r.commit(['-m', 'rename']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md and status.md'));
}));

test('committed: a ledger whose name has a non-ASCII character is still checked', () => withRepo((r) => {
  installCommitted(r);
  const cm = fakeCm(r.home, 1);
  write(r.dir, 'docs/plans/2026-09-27-plän.tasks.json', '{}\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  const res = r.commit(['-m', 'umlaut ledger'], { path: cm.path });
  assert.equal(res.status, 1);
  assert.equal(res.stderr, 'fake cm drift line\n');
  assert.equal(cm.calls(), `${r.dir}|tasks check --staged\n`);
}));

test('committed: a staged file named like progress.md with another character does not count as progress.md', () => withRepo((r) => {
  installCommitted(r);
  write(r.dir, 'code.js', '1\n');
  write(r.dir, 'progressXmd', 'x\n');
  bumpTracking(r.dir, ['status.md']);
  r.git('add', '-A');
  const res = r.commit(['-m', 'lookalike']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md'));
}));

test('committed: without a staged ledger cm is never run', () => withRepo((r) => {
  installCommitted(r);
  const cm = fakeCm(r.home, 1);
  write(r.dir, 'code.js', '1\n');
  bumpTracking(r.dir);
  r.git('add', '-A');
  const res = r.commit(['-m', 'no ledger'], { path: cm.path });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(cm.calls(), '');
}));

test('committed: a file turned into a symlink (type change) is a change that needs both files', () => withRepo((r) => {
  installCommitted(r);
  rmSync(join(r.dir, 'README.md'));
  symlinkSync('progress.md', join(r.dir, 'README.md'));
  r.git('add', 'README.md');
  const res = r.commit(['-m', 'file to symlink']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, missingMsg('progress.md and status.md'));
}));

test('committed: the gate installed in a global hooks dir lets a repo without progress.md commit', () => withRepo((r) => {
  const hooks = join(r.home, 'global-hooks');
  mkdirSync(hooks);
  copyFileSync(COMMITTED_GATE, join(hooks, 'progress-gate.sh'));
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nsh "${join(hooks, 'progress-gate.sh')}" || exit 1\n`);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  writeFileSync(join(r.home, 'gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
  write(r.dir, 'code.js', '1\n');
  r.git('add', 'code.js');
  const res = r.commit(['-m', 'not opted in']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
}));

test('committed: a repo with only PROGRESS.md is not opted in, so the gate lets commits through', () => withRepo((r) => {
  write(r.dir, 'PROGRESS.md', withEntry(TEMPLATE, 'Mine'));
  mkdirSync(join(r.dir, '.githooks'));
  copyFileSync(COMMITTED_GATE, join(r.dir, '.githooks', 'progress-gate.sh'));
  write(r.dir, '.githooks/pre-commit', '#!/bin/sh\nsh "$(git rev-parse --show-toplevel)/.githooks/progress-gate.sh" || exit 1\n');
  chmodSync(join(r.dir, '.githooks', 'pre-commit'), 0o755);
  r.git('config', 'core.hooksPath', '.githooks');
  write(r.dir, 'code.js', '1\n');
  r.git('add', 'code.js');
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 0, res.stderr);
}));

// ---- local mode ----

// Local tracking root with the template progress.md and its hash in state.json (what init --local writes), the gate
// copied to <root>/pre-commit.mjs and chained into .git/hooks/pre-commit and (with --post-commit) .git/hooks/post-commit.
function installLocal({ dir, git }) {
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const root = join(common, 'methodology');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'progress.md'), TEMPLATE);
  writeFileSync(join(root, 'status.md'), '# Status\nlocal\n');
  writeFileSync(join(root, 'state.json'), `${JSON.stringify({ version: 1, lastProgressSha256: sha256(TEMPLATE) }, null, 2)}\n`);
  copyFileSync(LOCAL_GATE, join(root, 'pre-commit.mjs'));
  mkdirSync(join(common, 'hooks'), { recursive: true });
  writeFileSync(join(common, 'hooks', 'pre-commit'),
    '#!/bin/sh\nnode "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" || exit 1\n');
  chmodSync(join(common, 'hooks', 'pre-commit'), 0o755);
  writeFileSync(join(common, 'hooks', 'post-commit'),
    '#!/bin/sh\nnode "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" --post-commit\n');
  chmodSync(join(common, 'hooks', 'post-commit'), 0o755);
  const progress = join(root, 'progress.md');
  const state = join(root, 'state.json');
  return {
    root, progress, state,
    addEntry: (title) => writeFileSync(progress, withEntry(readFileSync(progress, 'utf8'), title)),
    readState: () => JSON.parse(readFileSync(state, 'utf8')),
  };
}

// state.json once a commit landed (post-commit promoted the hash), and while one is in flight or aborted: then the
// pending hash comes with the tree pre-commit recorded (`git write-tree` of the index being committed).
const landed = (progress) => ({
  version: 1, lastProgressSha256: sha256(readFileSync(progress)), pendingProgressSha256: null, pendingTree: null,
});
const inFlight = (r, last, progress) => ({
  version: 1, lastProgressSha256: last, pendingProgressSha256: sha256(readFileSync(progress)), pendingTree: r.git('write-tree'),
});
const headOf = (r) => r.git('rev-parse', 'HEAD');
const runGate = (r, root, args = []) => spawnSync('node', [join(root, 'pre-commit.mjs'), ...args], {
  cwd: r.dir, encoding: 'utf8', env: envFor(r.home),
});

const stageCode = (r, name = 'code.js', text = '1\n') => {
  write(r.dir, name, text);
  r.git('add', name);
};

test('local: the first code commit after init fails, because state holds the template hash', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
  assert.deepEqual(l.readState(), { version: 1, lastProgressSha256: sha256(TEMPLATE) });
}));

test('local: after adding an entry the commit passes and state.json records the new hash', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
  assert.equal(readFileSync(l.state, 'utf8'), `${JSON.stringify(l.readState(), null, 2)}\n`);
}));

test('local: a second code commit without a new entry fails', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  stageCode(r, 'code2.js');
  const res = r.commit(['-m', 'two']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
}));

test('local: commit -a is gated on the changes it stages through its temporary index', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  write(r.dir, 'code.js', '2\n'); // tracked, modified, not staged: only `commit -a` stages it
  const res = r.commit(['-a', '-m', 'all']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
  l.addEntry('Second');
  assert.equal(r.commit(['-a', '-m', 'all']).status, 0);
}));

test('local: a commit with no staged changes passes and leaves state.json alone', () => withRepo((r) => {
  const l = installLocal(r);
  const before = readFileSync(l.state, 'utf8');
  const res = r.commit(['--allow-empty', '-m', 'empty']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(l.state, 'utf8'), before);
}));

test('local: a merge commit passes without a new entry', () => withRepo((r) => {
  const l = installLocal(r);
  r.git('checkout', '-qb', 'other');
  write(r.dir, 'other.js', 'o\n');
  r.git('add', 'other.js');
  r.git('commit', '-qm', 'other', '--no-verify');
  r.git('checkout', '-q', 'main');
  write(r.dir, 'main.js', 'm\n');
  r.git('add', 'main.js');
  r.git('commit', '-qm', 'main', '--no-verify');
  r.git('merge', '--no-ff', '--no-commit', 'other');
  const res = r.commit(['-m', 'merge other']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(l.readState(), { version: 1, lastProgressSha256: sha256(TEMPLATE) });
}));

test('local: a missing state.json passes only once progress.md holds an entry', () => withRepo((r) => {
  const l = installLocal(r);
  rmSync(l.state);
  stageCode(r);
  const blocked = r.commit(['-m', 'code']);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr, `${localMsg(l.progress)}\n`);
  assert.equal(existsSync(l.state), false);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'code']).status, 0);
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: a malformed state.json reads as no hash recorded', () => withRepo((r) => {
  const l = installLocal(r);
  writeFileSync(l.state, '{ not json');
  stageCode(r);
  assert.equal(r.commit(['-m', 'code']).status, 1);
  l.addEntry('First');
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: a state.json that cannot be read fails closed and says why', () => withRepo((r) => {
  const l = installLocal(r);
  l.addEntry('First');
  rmSync(l.state);
  mkdirSync(l.state); // reading a directory: EISDIR
  stageCode(r);
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`^${escape(localMsg(l.progress))} \\(could not read ${escape(l.state)}: EISDIR[^\\n]*\\)\\n$`));
}));

test('local: a progress.md that cannot be read fails closed and says why', () => withRepo((r) => {
  const l = installLocal(r);
  rmSync(l.progress);
  mkdirSync(l.progress);
  stageCode(r);
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`^${escape(localMsg(l.progress))} \\(could not read ${escape(l.progress)}: EISDIR[^\\n]*\\)\\n$`));
}));

test('local: from a linked worktree the gate uses the shared tracking root', () => withRepo((r) => {
  const l = installLocal(r);
  const wt = join(r.home, 'wt');
  r.git('worktree', 'add', '-q', '-b', 'side', wt);
  write(wt, 'side.js', 's\n');
  execFileSync('git', ['add', 'side.js'], { cwd: wt, env: envFor(r.home) });
  const blocked = r.commit(['-m', 'side'], { cwd: wt });
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr, `${localMsg(l.progress)}\n`);
  l.addEntry('Side');
  assert.equal(r.commit(['-m', 'side'], { cwd: wt }).status, 0);
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: the gate reads the tracking root it was copied into, not one derived from cwd', () => withRepo((r) => {
  const l = installLocal(r);
  l.addEntry('First');
  // A second copy of the gate in an unrelated directory, holding its own template progress.md and state.
  const other = join(r.home, 'elsewhere');
  mkdirSync(other);
  writeFileSync(join(other, 'progress.md'), TEMPLATE);
  writeFileSync(join(other, 'state.json'), JSON.stringify({ version: 1, lastProgressSha256: sha256(TEMPLATE) }));
  copyFileSync(LOCAL_GATE, join(other, 'pre-commit.mjs'));
  stageCode(r);
  const res = spawnSync('node', [join(other, 'pre-commit.mjs')], { cwd: r.dir, encoding: 'utf8', env: envFor(r.home) });
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(join(other, 'progress.md'))}\n`);
}));

// ---- local mode: the hash stays pending until post-commit (the commit landed) promotes it ----

test('local: after an aborted commit, a commit without a new entry since the last landed commit is blocked', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  const landedBytes = readFileSync(l.progress);
  stageCode(r, 'code2.js');
  l.addEntry('Second');
  const head = headOf(r);
  const aborted = r.commit(['-m', '']); // the pre-commit passes, then git aborts on the empty message
  assert.notEqual(aborted.status, 0);
  assert.equal(headOf(r), head);
  writeFileSync(l.progress, landedBytes); // the Second entry is gone: nothing new since commit "one"
  const res = r.commit(['-m', 'two']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
}));

test('local: after an aborted commit the same entry still lets the retry through', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  const one = sha256(readFileSync(l.progress));
  stageCode(r, 'code2.js');
  l.addEntry('Second');
  assert.notEqual(r.commit(['-m', '']).status, 0);
  assert.deepEqual(l.readState(), inFlight(r, one, l.progress));
  const retry = r.commit(['-m', 'two']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: a landed commit counts even when HEAD returns to the sha its pre-commit saw', () => withRepo((r) => {
  const l = installLocal(r);
  r.git('branch', 'feature'); // left at the current HEAD
  stageCode(r);
  l.addEntry('One');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  r.git('switch', '-q', 'feature');
  stageCode(r, 'feature.js');
  const res = r.commit(['-m', 'feature']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
}));

test('local: an amend needs a new entry, and the amended commit promotes it', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  stageCode(r, 'code2.js');
  const blocked = r.commit(['--amend', '--no-edit']);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr, `${localMsg(l.progress)}\n`);
  l.addEntry('Second');
  const res = r.commit(['--amend', '--no-edit']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
  stageCode(r, 'code3.js');
  assert.equal(r.commit(['-m', 'three']).status, 1);
}));

test('local: the first commit of an unborn repo is gated and promoted like any other', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.notEqual(r.commit(['-m', '']).status, 0); // aborted: HEAD still unborn
  assert.deepEqual(l.readState(), inFlight(r, sha256(TEMPLATE), l.progress));
  const retry = r.commit(['-m', 'first']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
  stageCode(r, 'code2.js');
  const res = r.commit(['-m', 'second']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
}, { unborn: true }));

test('local: a commit the gate lets through without recording clears a stale pending hash', () => withRepo((r) => {
  const l = installLocal(r);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  const landedBytes = readFileSync(l.progress);
  stageCode(r, 'code2.js');
  l.addEntry('Second');
  assert.notEqual(r.commit(['-m', '']).status, 0); // Second is pending
  writeFileSync(l.progress, landedBytes);
  r.git('restore', '--staged', 'code2.js'); // nothing staged: the next commit passes without recording
  const empty = r.commit(['--allow-empty', '-m', 'empty']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(l.readState(), landed(l.progress), 'the aborted Second hash was not promoted');
  r.git('add', 'code2.js');
  const res = r.commit(['-m', 'two']);
  assert.equal(res.status, 1);
  assert.equal(res.stderr, `${localMsg(l.progress)}\n`);
}));

test('local: --post-commit never blocks: a no-op with nothing pending, a warning when state.json cannot be read', () => withRepo((r) => {
  const l = installLocal(r);
  const before = readFileSync(l.state, 'utf8');
  const idle = runGate(r, l.root, ['--post-commit']);
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.stderr, '');
  assert.equal(readFileSync(l.state, 'utf8'), before);
  rmSync(l.state);
  mkdirSync(l.state); // EISDIR on read
  const broken = runGate(r, l.root, ['--post-commit']);
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, new RegExp(`^post-commit \\(progress-tracking, local mode\\): could not promote the progress\\.md hash in ${escape(l.state)}: EISDIR[^\\n]*\\n$`));
}));

// ---- local mode: post-commit promotes only the commit its pre-commit saw (spec Addendum E.8) ----

test('local: post-commit promotes only when HEAD^{tree} equals the recorded tree', () => withRepo((r) => {
  const l = installLocal(r);
  r.git('switch', '-qc', 'other');
  write(r.dir, 'other.js', 'o\n');
  r.git('add', 'other.js');
  r.git('commit', '-qm', 'other', '--no-verify');
  const picked = headOf(r);
  r.git('switch', '-q', 'main');
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  const one = sha256(readFileSync(l.progress));
  assert.deepEqual(l.readState(), landed(l.progress), 'the tree matched: promoted');
  stageCode(r, 'code2.js');
  l.addEntry('Second');
  assert.notEqual(r.commit(['-m', '']).status, 0); // aborted: Second is pending with the tree of code2.js staged
  assert.deepEqual(l.readState(), inFlight(r, one, l.progress));
  r.git('restore', '--staged', 'code2.js');
  // A cherry-pick replays a commit without running pre-commit, but git runs post-commit for it: its tree is not the
  // recorded one, so the aborted commit's hash is dropped, not promoted.
  const pick = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', picked], {
    cwd: r.dir, encoding: 'utf8', env: envFor(r.home),
  });
  assert.equal(pick.status, 0, pick.stderr);
  assert.deepEqual(l.readState(), { version: 1, lastProgressSha256: one, pendingProgressSha256: null, pendingTree: null });
}));

test('local: a state file without pendingTree reads as null, so its pending hash is never promoted', () => withRepo((r) => {
  const l = installLocal(r);
  const last = sha256(TEMPLATE);
  l.addEntry('First');
  // Written by an older gate: a pending hash with no recorded tree.
  writeFileSync(l.state, `${JSON.stringify({ version: 1, lastProgressSha256: last, pendingProgressSha256: sha256(readFileSync(l.progress)) }, null, 2)}\n`);
  const post = runGate(r, l.root, ['--post-commit']);
  assert.deepEqual([post.status, post.stderr], [0, '']);
  assert.deepEqual(l.readState(), { version: 1, lastProgressSha256: last, pendingProgressSha256: null, pendingTree: null });
  // The pre-commit reads it too: the entry still counts as new, and the commit records its tree.
  writeFileSync(l.state, `${JSON.stringify({ version: 1, lastProgressSha256: last, pendingProgressSha256: null }, null, 2)}\n`);
  stageCode(r);
  const res = r.commit(['-m', 'code']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: a hook line after ours that re-stages a file still promotes, so the next commit needs a new entry', () => withRepo((r) => {
  const l = installLocal(r);
  // A formatter-style line after the gate's: it changes the committed tree on every commit, so HEAD^{tree} never
  // equals the tree pre-commit recorded. git logs these commits as `commit:` in the reflog, and that promotes.
  const hook = join(r.dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}echo "$$" > stamp.txt && git add stamp.txt\n`);
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').includes('stamp.txt'), true, 'the hook re-staged');
  assert.deepEqual(l.readState(), landed(l.progress));
  stageCode(r, 'code2.js');
  const blocked = r.commit(['-m', 'two']);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stderr, `${localMsg(l.progress)}\n`);
  l.addEntry('Second');
  assert.equal(r.commit(['--amend', '--no-edit']).status, 0, 'an amend (reflog `commit (amend):`) promotes too');
  assert.deepEqual(l.readState(), landed(l.progress));
}));

test('local: a cherry-pick or a revert after an aborted commit still clears the pending hash', () => withRepo((r) => {
  const l = installLocal(r);
  r.git('switch', '-qc', 'other');
  write(r.dir, 'other.js', 'o\n');
  r.git('add', 'other.js');
  r.git('commit', '-qm', 'other', '--no-verify');
  const picked = headOf(r);
  r.git('switch', '-q', 'main');
  stageCode(r);
  l.addEntry('First');
  assert.equal(r.commit(['-m', 'one']).status, 0);
  const one = sha256(readFileSync(l.progress));
  const settled = { version: 1, lastProgressSha256: one, pendingProgressSha256: null, pendingTree: null };
  const replay = (args) => {
    stageCode(r, 'code2.js');
    assert.notEqual(r.commit(['-m', '']).status, 0); // aborted: its hash is pending
    assert.equal(l.readState().pendingProgressSha256, sha256(readFileSync(l.progress)));
    r.git('restore', '--staged', 'code2.js');
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: r.dir, encoding: 'utf8', env: envFor(r.home),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(l.readState(), settled, args.join(' '));
  };
  l.addEntry('Second');
  replay(['cherry-pick', picked]);
  assert.match(r.git('reflog', '-1', '--format=%gs', 'HEAD'), /^cherry-pick: /);
  replay(['revert', '--no-edit', 'HEAD']);
  assert.match(r.git('reflog', '-1', '--format=%gs', 'HEAD'), /^revert: /);
}));

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
