import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync, realpathSync, statSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const INIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const SPANISH = /[áéíóúñ¿¡]/;
const PRE_LINE = 'node "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" || exit 1';
const POST_LINE = 'node "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" --post-commit';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Every child runs with a temp HOME (init writes the repo registry under it), no XDG_CONFIG_HOME, no global or
// system git config, and no inherited repo-selecting variables.
let HOME;
function env() {
  const e = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(HOME, 'gitconfig') };
  for (const key of ['XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete e[key];
  return e;
}

function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-init-')));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: env() });
  return dir;
}
const run = (cwd, args = []) => spawnSync('node', [INIT, ...args], { cwd, encoding: 'utf8', env: env() });
const init = (cwd, args = []) => {
  const r = run(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env() }).trim();
const porcelain = (cwd) => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: env() });
const commit = (cwd, msg) => spawnSync('git', [...ID, 'commit', '-qm', msg], { cwd, encoding: 'utf8', env: env() });
const withRepo = (fn) => {
  HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pt-init-home-')));
  writeFileSync(join(HOME, 'gitconfig'), '');
  const d = tempRepo();
  try { fn(d); } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
  }
};
const localRootOf = (dir) => join(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'methodology');

// ---- committed mode ----

test('in a fresh repo init creates both files, the CLAUDE.md section and a versioned pre-commit', () => withRepo((dir) => {
  const report = init(dir);
  for (const f of ['progress.md', 'status.md', 'CLAUDE.md', '.githooks/pre-commit', '.githooks/progress-gate.sh']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  assert.equal(git(dir, 'config', 'core.hooksPath'), '.githooks');
  assert.equal(report.hook.versioned, true);
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /progress-tracking:start[\s\S]*progress\.md[\s\S]*progress-tracking:end/);
}));

test('the templates are English, the CLAUDE.md section describes the ledger and progress.md starts with no entry', () => withRepo((dir) => {
  const report = init(dir);
  for (const f of ['progress.md', 'status.md', 'CLAUDE.md']) {
    assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), SPANISH, f);
  }
  const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /triqual tasks/);
  assert.match(md, /\.tasks\.json/);
  assert.doesNotMatch(readFileSync(join(dir, 'progress.md'), 'utf8'), /^## /m);
  assert.match(readFileSync(join(dir, 'status.md'), 'utf8'), /^\*\*Last updated:\*\*/m);
  for (const note of report.notes) assert.doesNotMatch(note, SPANISH, note);
}));

test('the installed hook rejects a code commit without both files and accepts one with them', () => withRepo((dir) => {
  init(dir);
  git(dir, 'add', '-A');
  assert.equal(commit(dir, 'setup').status, 0);
  writeFileSync(join(dir, 'code.js'), '1');
  git(dir, 'add', 'code.js');
  const rejected = commit(dir, 'code only');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /progress\.md and status\.md/);
  writeFileSync(join(dir, 'progress.md'), readFileSync(join(dir, 'progress.md'), 'utf8') + '\n## x\n');
  git(dir, 'add', 'progress.md');
  assert.match(commit(dir, 'no status').stderr, /does not include status\.md/);
  writeFileSync(join(dir, 'status.md'), 'new status');
  git(dir, 'add', 'status.md');
  assert.equal(commit(dir, 'complete').status, 0);
}));

test('a commit that only touches the tracking files passes', () => withRepo((dir) => {
  init(dir);
  git(dir, 'add', 'progress.md');
  assert.equal(commit(dir, 'only progress').status, 0);
}));

test('init is idempotent and never overwrites existing progress.md, status.md or other CLAUDE.md content', () => withRepo((dir) => {
  writeFileSync(join(dir, 'CLAUDE.md'), '# My project\n\nown rules\n');
  writeFileSync(join(dir, 'progress.md'), '# mine\n');
  init(dir);
  const report = init(dir);
  const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# My project\n\nown rules\n/);
  assert.equal(md.match(/progress-tracking:start/g).length, 1);
  assert.equal(readFileSync(join(dir, 'progress.md'), 'utf8'), '# mine\n');
  assert.ok(report.kept.includes('progress.md'));
  assert.equal(readFileSync(join(dir, '.githooks/pre-commit'), 'utf8').match(/progress-gate\.sh/g).length, 1);
}));

test('rerunning init refreshes progress-gate.sh', () => withRepo((dir) => {
  init(dir);
  writeFileSync(join(dir, '.githooks/progress-gate.sh'), 'stale\n');
  init(dir);
  assert.equal(readFileSync(join(dir, '.githooks/progress-gate.sh'), 'utf8'), readFileSync(join(TEMPLATES, 'progress-gate.sh'), 'utf8'));
}));

test('with core.hooksPath already set (husky), init chains into that pre-commit and keeps its content', () => withRepo((dir) => {
  mkdirSync(join(dir, '.husky'));
  writeFileSync(join(dir, '.husky/pre-commit'), 'npx lint-staged\n');
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const report = init(dir);
  assert.equal(git(dir, 'config', 'core.hooksPath'), '.husky/_');
  const hook = readFileSync(join(dir, '.husky/pre-commit'), 'utf8');
  assert.match(hook, /progress-gate\.sh/);
  assert.match(hook, /npx lint-staged/);
  assert.equal(report.hook.dir, '.husky');
}));

test('with an unversioned .git/hooks/pre-commit and no hooksPath, init chains there instead of disabling it', () => withRepo((dir) => {
  const hooks = join(dir, '.git/hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho local-check\nexec true\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const report = init(dir);
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir, env: env() }).status, 1);
  const hook = readFileSync(join(hooks, 'pre-commit'), 'utf8');
  assert.ok(hook.indexOf('progress-gate.sh') < hook.indexOf('exec true'), 'the check runs before an exec');
  assert.equal(report.hook.versioned, false);
}));

test('the hook stays out of merge commits', () => withRepo((dir) => {
  init(dir);
  git(dir, 'add', '-A');
  commit(dir, 'setup');
  git(dir, 'checkout', '-qb', 'side');
  writeFileSync(join(dir, 'a.js'), 'side');
  writeFileSync(join(dir, 'progress.md'), 'p side');
  writeFileSync(join(dir, 'status.md'), 's side');
  git(dir, 'add', '-A');
  commit(dir, 'side');
  git(dir, 'checkout', '-q', '-');
  writeFileSync(join(dir, 'a.js'), 'main');
  writeFileSync(join(dir, 'progress.md'), 'p main');
  writeFileSync(join(dir, 'status.md'), 's main');
  git(dir, 'add', '-A');
  commit(dir, 'main');
  spawnSync('git', [...ID, 'merge', 'side'], { cwd: dir, env: env() });
  writeFileSync(join(dir, 'a.js'), 'resolved');
  git(dir, 'add', 'a.js');
  git(dir, 'checkout', '--ours', 'progress.md', 'status.md'); // same as HEAD: without the merge exemption this commit would be rejected
  git(dir, 'add', 'progress.md', 'status.md');
  writeFileSync(join(dir, 'b.js'), 'x');
  git(dir, 'add', 'b.js');
  assert.equal(spawnSync('git', [...ID, 'commit', '-q', '--no-edit'], { cwd: dir, env: env() }).status, 0);
}));

test('outside a git repo init fails with a clear message', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-nogit-')));
  try {
    const e = { ...process.env, HOME: dir, GIT_CEILING_DIRECTORIES: dirname(dir) };
    delete e.XDG_CONFIG_HOME;
    const r = spawnSync('node', [INIT], { cwd: dir, encoding: 'utf8', env: e });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not inside a git repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('committed-mode init on a repo that already uses local mode exits 2 and writes nothing', () => withRepo((dir) => {
  init(dir, ['--local']);
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`this repo already uses local mode \\(${localRootOf(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  for (const f of ['progress.md', 'status.md', 'CLAUDE.md', '.githooks']) assert.equal(existsSync(join(dir, f)), false, f);
}));

test('plain progress-init and --local each exit 2 in a store-marked repository and write nothing', () => withRepo((dir) => {
  git(dir, 'config', '--local', 'triqual.tracking', 'store');
  const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
  const message = 'progress-init: this repository is in store mode (`git config --local triqual.tracking` is store): '
    + 'progress-init without --store does not apply to it; run triqual progress-init --store to finish or repair a switch\n';
  for (const args of [[], ['--local']]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, `${args.join(' ') || '(no flag)'}: ${r.stderr}`);
    assert.equal(r.stderr, message, args.join(' ') || '(no flag)');
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(readdirSync(dir), ['.git'], 'no progress.md, status.md, CLAUDE.md or .githooks');
  assert.equal(existsSync(localRootOf(dir)), false, 'no <git-common-dir>/methodology/');
  for (const hook of ['pre-commit', 'post-commit']) assert.equal(existsSync(join(dir, '.git', 'hooks', hook)), false, hook);
  assert.equal(readFileSync(join(dir, '.git', 'config'), 'utf8'), config, 'no core.hooksPath or other config change');
  assert.equal(existsSync(join(HOME, '.config')), false, 'no registry write');
}));

// ---- local mode ----

test('--local creates the local root from the templates, state.json and the gate, and reports mode and root', () => withRepo((dir) => {
  const report = init(dir, ['--local']);
  const root = localRootOf(dir);
  assert.equal(report.mode, 'local');
  assert.equal(report.root, root);
  assert.equal(readFileSync(join(root, 'progress.md'), 'utf8'), readFileSync(join(TEMPLATES, 'progress.md'), 'utf8'));
  assert.equal(readFileSync(join(root, 'status.md'), 'utf8'), readFileSync(join(TEMPLATES, 'status.md'), 'utf8'));
  for (const d of ['plans', 'specs']) assert.ok(statSync(join(root, d)).isDirectory(), d);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')), {
    version: 1, lastProgressSha256: sha256(readFileSync(join(root, 'progress.md'))), pendingProgressSha256: null,
  });
  const gate = join(root, 'pre-commit.mjs');
  assert.equal(readFileSync(gate, 'utf8'), readFileSync(join(TEMPLATES, 'pre-commit-local.mjs'), 'utf8'));
  assert.equal(statSync(gate).mode & 0o777, 0o755);
  assert.deepEqual(report.created.sort(), ['plans/', 'progress.md', 'specs/', 'status.md']);
}));

test('--local keeps existing local files and a valid state.json, and refreshes pre-commit.mjs', () => withRepo((dir) => {
  init(dir, ['--local']);
  const root = localRootOf(dir);
  const before = readFileSync(join(root, 'state.json'), 'utf8');
  writeFileSync(join(root, 'progress.md'), '# Progress\n\n## 2026-09-27 — mine\n- done\n');
  writeFileSync(join(root, 'status.md'), '# mine\n');
  writeFileSync(join(root, 'pre-commit.mjs'), 'stale\n');
  const report = init(dir, ['--local']);
  assert.equal(readFileSync(join(root, 'progress.md'), 'utf8'), '# Progress\n\n## 2026-09-27 — mine\n- done\n');
  assert.equal(readFileSync(join(root, 'status.md'), 'utf8'), '# mine\n');
  assert.deepEqual(report.kept.sort(), ['plans/', 'progress.md', 'specs/', 'status.md']);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before, 'an uncommitted entry is not consumed');
  assert.equal(readFileSync(join(root, 'pre-commit.mjs'), 'utf8'), readFileSync(join(TEMPLATES, 'pre-commit-local.mjs'), 'utf8'));
}));

test('--local rewrites a missing or unparsable state.json with the kept progress.md hash', () => withRepo((dir) => {
  init(dir, ['--local']);
  const root = localRootOf(dir);
  const state = join(root, 'state.json');
  writeFileSync(join(root, 'progress.md'), '# Progress\n\n## 2026-09-27 — mine\n- done\n');
  const expected = { version: 1, lastProgressSha256: sha256(readFileSync(join(root, 'progress.md'))), pendingProgressSha256: null };
  rmSync(state);
  init(dir, ['--local']);
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), expected);
  writeFileSync(state, '{ not json');
  init(dir, ['--local']);
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), expected);
}));

test('--local leaves the working tree clean', () => withRepo((dir) => {
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git(dir, 'add', 'README.md');
  git(dir, ...ID, 'commit', '-qm', 'init');
  init(dir, ['--local']);
  assert.equal(porcelain(dir), '');
  assert.deepEqual(readdirSync(dir).sort(), ['.git', 'README.md']);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
}));

test('--local chains into .git/hooks/pre-commit once and is idempotent', () => withRepo((dir) => {
  const hooks = join(dir, '.git/hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/bash\necho mine\nexec true\n');
  const first = init(dir, ['--local']);
  const second = init(dir, ['--local']);
  const pre = readFileSync(join(hooks, 'pre-commit'), 'utf8');
  assert.equal(pre, `#!/bin/bash\n${PRE_LINE}\necho mine\nexec true\n`);
  assert.equal(readFileSync(join(hooks, 'post-commit'), 'utf8'), `#!/bin/sh\n${POST_LINE}\n`);
  for (const f of ['pre-commit', 'post-commit']) assert.equal(statSync(join(hooks, f)).mode & 0o777, 0o755, f);
  assert.equal(first.hook.preCommit, 'chained');
  assert.equal(first.hook.postCommit, 'chained');
  assert.equal(second.hook.preCommit, 'present');
  assert.equal(second.hook.postCommit, 'present');
  assert.equal(first.hook.dir, realpathSync(hooks));
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir, env: env() }).status, 1);
}));

test('--local with core.hooksPath=.husky/_ touches no hook file and reports the note', () => withRepo((dir) => {
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/pre-commit'), 'npx lint-staged\n');
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const report = init(dir, ['--local']);
  assert.equal(readFileSync(join(dir, '.husky/pre-commit'), 'utf8'), 'npx lint-staged\n');
  assert.deepEqual(readdirSync(join(dir, '.husky')).sort(), ['_', 'pre-commit']);
  assert.deepEqual(readdirSync(join(dir, '.husky/_')), []);
  for (const f of ['pre-commit', 'post-commit']) assert.equal(existsSync(join(dir, '.git/hooks', f)), false, f);
  assert.equal(report.hook, null);
  assert.ok(report.notes.includes('local mode: core.hooksPath is set (.husky/_); no git hooks installed, so commits are not gated — the Stop hook checks for a progress.md entry newer than the last commit'), report.notes.join('\n'));
  assert.ok(existsSync(join(localRootOf(dir), 'progress.md')));
}));

test('--local from a linked worktree writes to the main common dir', () => withRepo((dir) => {
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git(dir, 'add', 'README.md');
  git(dir, ...ID, 'commit', '-qm', 'init');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pt-init-wt-')));
  const wt = join(parent, 'wt');
  try {
    git(dir, 'worktree', 'add', '-q', wt);
    const report = init(wt, ['--local']);
    const root = join(realpathSync(join(dir, '.git')), 'methodology');
    assert.equal(report.root, root);
    assert.ok(existsSync(join(root, 'progress.md')));
    assert.ok(readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8').includes(PRE_LINE));
    assert.ok(readFileSync(join(dir, '.git/hooks/post-commit'), 'utf8').includes(POST_LINE));
    assert.equal(porcelain(wt), '');
    assert.deepEqual(readdirSync(wt).sort(), ['.git', 'README.md']);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}));

test('--local --remove removes the root and the chained lines, keeping other lines in the hook', () => withRepo((dir) => {
  const hooks = join(dir, '.git/hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  init(dir, ['--local']);
  const root = localRootOf(dir);
  const r = run(dir, ['--local', '--remove']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(root), r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'local');
  assert.equal(report.root, root);
  assert.equal(existsSync(root), false);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(existsSync(join(hooks, 'post-commit')), false, 'a hook left with only its #!/bin/sh shebang is deleted');
  assert.equal(porcelain(dir), '');
}));

test('--local --remove deletes a hook left with only the #!/bin/sh shebang and blank lines, and keeps any other', () => withRepo((dir) => {
  const hooks = join(dir, '.git/hooks');
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n\n');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/bash\n');
  init(dir, ['--local']);
  assert.equal(init(dir, ['--local', '--remove']).hook.preCommit, 'removed');
  assert.equal(existsSync(join(hooks, 'pre-commit')), false);
  assert.equal(readFileSync(join(hooks, 'post-commit'), 'utf8'), '#!/bin/bash\n');
}));

test('--local on a committed-mode repo exits 2', () => withRepo((dir) => {
  writeFileSync(join(dir, 'progress.md'), '# Progress\n');
  const r = run(dir, ['--local']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /this repo already uses committed mode \(progress\.md at the root\)/);
  assert.equal(existsSync(localRootOf(dir)), false);
  assert.equal(existsSync(join(dir, '.git/hooks/pre-commit')), false);
}));

test('an unknown flag or --remove without --local exits 2 and writes nothing', () => withRepo((dir) => {
  for (const args of [['--locl'], ['--remove']]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^progress-init: /);
  }
  assert.deepEqual(readdirSync(dir), ['.git']);
  assert.equal(existsSync(localRootOf(dir)), false);
}));

test('--local end to end: a code commit is blocked until an entry is added, and the working tree stays clean', () => withRepo((dir) => {
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git(dir, 'add', 'README.md');
  git(dir, ...ID, 'commit', '-qm', 'init');
  init(dir, ['--local']);
  const root = localRootOf(dir);
  const progress = join(root, 'progress.md');
  assert.equal(porcelain(dir), '');

  writeFileSync(join(dir, 'code.js'), '1\n');
  git(dir, 'add', 'code.js');
  const blocked = commit(dir, 'code');
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stderr.includes('run `triqual tracking write entry <draft>` '), blocked.stderr);
  assert.ok(blocked.stderr.includes(`(it lands at the top of ${progress}; `), blocked.stderr);
  assert.equal(porcelain(dir), 'A  code.js\n');

  writeFileSync(progress, `${readFileSync(progress, 'utf8')}\n## 2026-09-27 — First task\n- done\n`);
  assert.equal(porcelain(dir), 'A  code.js\n');
  const passed = commit(dir, 'code');
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(porcelain(dir), '');
  assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).lastProgressSha256, sha256(readFileSync(progress)));

  writeFileSync(join(dir, 'code.js'), '2\n');
  git(dir, 'add', 'code.js');
  assert.equal(commit(dir, 'again').status, 1);
}));

// ---- final fix wave ----

const PYTHON_HOOK = '#!/usr/bin/env python3\nprint("lint")\n';
const COMMITTED_LINE = 'sh "$(git rev-parse --git-path hooks)/progress-gate.sh" || exit 1';
const notShellNote = (file, shebang, line) => `${file} is not a shell script (${shebang}), so it was left untouched: `
  + `add this line to it by hand, or run it from the hook: ${line}`;

test('a pre-commit hook in another language (python3) is left untouched, with a note', () => withRepo((dir) => {
  const hook = join(dir, '.git/hooks/pre-commit');
  writeFileSync(hook, PYTHON_HOOK);
  chmodSync(hook, 0o755);
  const report = init(dir);
  assert.equal(readFileSync(hook, 'utf8'), PYTHON_HOOK);
  assert.equal(report.hook.preCommit, 'not-shell');
  assert.ok(report.notes.includes(notShellNote(realpathSync(hook), '#!/usr/bin/env python3', COMMITTED_LINE)),
    report.notes.join('\n'));
}));

test('--local leaves a python3 pre-commit untouched, with a note, and still chains the post-commit', () => withRepo((dir) => {
  const hooks = join(dir, '.git/hooks');
  writeFileSync(join(hooks, 'pre-commit'), PYTHON_HOOK);
  const report = init(dir, ['--local']);
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), PYTHON_HOOK);
  assert.equal(report.hook.preCommit, 'not-shell');
  assert.equal(report.hook.postCommit, 'chained');
  assert.ok(report.notes.includes(notShellNote(join(realpathSync(hooks), 'pre-commit'), '#!/usr/bin/env python3', PRE_LINE)),
    report.notes.join('\n'));
}));

test('hooks with no shebang or a sh, bash, dash, zsh or ksh shebang (env included) are chained', () => {
  for (const first of ['', '#!/bin/sh -e\n', '#!/usr/bin/env bash\n', '#!/bin/dash\n', '#!/bin/zsh\n', '#!/usr/bin/env -S ksh -e\n']) {
    withRepo((dir) => {
      const hook = join(dir, '.git/hooks/pre-commit');
      writeFileSync(hook, `${first}echo mine\n`);
      const report = init(dir, ['--local']);
      assert.equal(report.hook.preCommit, 'chained', first);
      assert.ok(readFileSync(hook, 'utf8').includes(PRE_LINE), first);
    });
  }
});

test('--local writes state.json from a progress.md it just created, even over an existing state.json', () => withRepo((dir) => {
  init(dir, ['--local']);
  const root = localRootOf(dir);
  writeFileSync(join(root, 'state.json'), `${JSON.stringify({ version: 1, lastProgressSha256: 'a'.repeat(64), pendingProgressSha256: null })}\n`);
  rmSync(join(root, 'progress.md')); // opted out by hand, state.json left behind
  const report = init(dir, ['--local']);
  assert.ok(report.created.includes('progress.md'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')), {
    version: 1, lastProgressSha256: sha256(readFileSync(join(root, 'progress.md'))), pendingProgressSha256: null,
  });
}));

// ---- final fix wave, residual ----

test('init never takes PROGRESS.md for progress.md: refused where the file system ignores case, created elsewhere', () => withRepo((dir) => {
  writeFileSync(join(dir, 'PROGRESS.md'), 'mine\n');
  const r = run(dir);
  if (existsSync(join(dir, 'progress.md')) && !readdirSync(dir).includes('progress.md')) { // case-insensitive
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stderr, 'progress-init: PROGRESS.md differs from progress.md only in case: rename it to progress.md '
      + '(tracking needs that exact name)\n');
    assert.equal(r.stdout, '');
    // Local mode writes nothing at the root, so PROGRESS.md there is no obstacle.
    const local = init(dir, ['--local']);
    assert.ok(local.created.includes('progress.md'), JSON.stringify(local));
  } else {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).created.includes('progress.md'), r.stdout);
  }
  assert.equal(readFileSync(join(dir, 'PROGRESS.md'), 'utf8'), 'mine\n');
}));

test('--help and -h print the usage and one line per flag, exit 0 and write nothing', () => withRepo((dir) => {
  for (const args of [['--help'], ['-h'], ['--local', '--help'], ['--local', '--remove', '-h']]) {
    const r = run(dir, args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stderr, '', args.join(' '));
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'usage: triqual progress-init [--local [--remove]]', args.join(' '));
    for (const flag of ['--local', '--remove', '--help']) {
      assert.equal(lines.filter((l) => l.trimStart().split(/\s/).some((w) => w.replace(/,$/, '') === flag)).length, 1, `${flag} line`);
    }
    assert.equal(porcelain(dir), '', args.join(' '));
    assert.equal(existsSync(localRootOf(dir)), false, args.join(' '));
    assert.deepEqual(readdirSync(HOME), ['gitconfig'], args.join(' '));
  }
}));

// ---- AGENTS.md (multi-harness, spec Addendum F.5) ----

test('progress-init writes the tracking section into an existing AGENTS.md in committed mode, not in local mode, and creates no AGENTS.md', () => {
  const section = readFileSync(join(TEMPLATES, 'claude-section.md'), 'utf8').trim();
  // Committed mode with an AGENTS.md: the section is appended once, the user's text kept, and a rerun changes nothing.
  withRepo((dir) => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n\nown text\n');
    const report = init(dir);
    const once = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(once, `# Agents\n\nown text\n\n${section}\n`);
    assert.equal(report.agentsMd, 'appended');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), `${section}\n`);
    const again = init(dir);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), once);
    assert.equal(again.agentsMd, 'updated');
  });
  // An outdated section in AGENTS.md is replaced in place.
  withRepo((dir) => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n\n<!-- progress-tracking:start -->\nold\n<!-- progress-tracking:end -->\ntail\n');
    init(dir);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), `# Agents\n\n${section}\ntail\n`);
  });
  // Committed mode without an AGENTS.md creates none.
  withRepo((dir) => {
    const report = init(dir);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
    assert.ok(!readdirSync(dir).some((n) => n.toLowerCase() === 'agents.md'));
    assert.equal(report.agentsMd, null);
  });
  // Local mode leaves an existing AGENTS.md untouched and creates none.
  withRepo((dir) => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n');
    init(dir, ['--local']);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# Agents\n');
  });
  withRepo((dir) => {
    init(dir, ['--local']);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });
});
