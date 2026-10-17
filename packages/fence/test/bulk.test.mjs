import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { normalize } from '../src/norm/normalize.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { BULK_WRITERS, bulkOf, TREE_PATHSPECS } from '../src/tables/bulk.mjs';
import { gitTreeDiff, gitVersionOk, bindGitTreeDiff, NOT_A_REVISION, GIT_MIN_VERSION, DEFAULT_DEADLINE_MS, MAX_OUTPUT } from '../src/resolve/git.mjs';
import { patchTargets, patchTargetsFromText } from '../src/resolve/patch.mjs';

// Hermetic fixtures: one realpath'd temp root (macOS: /var -> /private/var), a fake home inside it.
// The `.claude/settings.json` files below live only in these temp trees. Every test injects a fake
// gitTreeDiff or a fake spawn, except the one real-git temp-repo test at the end.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-bulk-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);

const SHA = 'c'.repeat(40);
let counter = 0;

function dir(name = `d${counter++}`) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A repository built by hand (no git binary): HEAD on main, branches main and feature.
function makeRepo() {
  const root = dir();
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  write(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(git, 'config'), '[core]\n\tbare = false\n');
  for (const b of ['main', 'feature']) write(path.join(git, 'refs', 'heads', b), `${SHA}\n`);
  return root;
}

// A fake gitTreeDiff: answers from a table, records every call.
function fakeDiff(answer) {
  const calls = [];
  const fn = (repo, target, subpaths) => {
    calls.push({ repo, target, subpaths });
    return typeof answer === 'function' ? answer(target) : answer;
  };
  fn.calls = calls;
  return fn;
}

function run(text, cwd, extra = {}) {
  return normalize(text, { cwd, home: HOME, env: {}, gitTreeDiff: fakeDiff([]), ...extra });
}

function cmds(text, cwd, extra) {
  const r = run(text, cwd, extra);
  assert.ok(Array.isArray(r.commands), `expected commands for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r.commands;
}

function opaque(text, cwd, extra) {
  const r = run(text, cwd, extra);
  assert.ok(r.opaque, `expected opaque for ${JSON.stringify(text)}, got ${JSON.stringify(r).slice(0, 400)}`);
  return r.opaque;
}

const PATCH = [
  'diff --git a/.claude/settings.json b/.claude/settings.json',
  'index 1111111..2222222 100644',
  '--- a/.claude/settings.json',
  '+++ b/.claude/settings.json',
  '@@ -1,1 +1,1 @@',
  '-{}',
  '+{"x": 1}',
  'diff --git a/src/a.js b/src/a.js',
  'index 3333333..4444444 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '--- this removed line is not a header',
  '+++ nor is this added one',
  '',
].join('\n');

// ---- brief's named tests -------------------------------------------------------------------------

test('cp -r src . with .claude/settings.json in src writes a protected path', () => {
  const proj = dir();
  write(path.join(proj, 'src', '.claude', 'settings.json'), '{}');
  write(path.join(proj, 'src', 'index.js'), '');
  const [cp] = cmds('cp -r src .', proj);
  assert.ok(cp.writes.includes(path.join(proj, '.claude', 'settings.json')), JSON.stringify(cp.writes));
  // a plain non-recursive copy of a file is not a bulk writer
  const [plain] = cmds('cp src/index.js .', proj);
  assert.ok(!plain.writes.includes(path.join(proj, '.claude', 'settings.json')));
  assert.ok(bulkOf(['cp', '-r', 'a', 'b']) !== null);
  assert.equal(bulkOf(['cp', 'a', 'b']), null);
});

test('cp -r node_modules x does not walk the tree beyond protected subpaths', () => {
  const proj = dir();
  const nm = path.join(proj, 'node_modules');
  for (let i = 0; i < 30; i++) write(path.join(nm, `pkg${i}`, 'lib', 'index.js'), '');
  write(path.join(nm, '.claude', 'skills', 'helper', 'SKILL.md'), 'harmless');
  const readdirs = [];
  const counting = new Proxy(fs, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (key === 'readdirSync' || key === 'opendirSync') {
        return (p, ...rest) => {
          readdirs.push(String(p));
          return v.call(target, p, ...rest);
        };
      }
      return v;
    },
  });
  const [cp] = cmds('cp -r node_modules x', proj, { fs: counting });
  assert.ok(cp.writes.includes(path.join(proj, 'x', '.claude', 'skills', 'helper', 'SKILL.md')), JSON.stringify(cp.writes));
  const protectedRoots = [path.join(nm, '.claude'), path.join(nm, '.codex')];
  for (const p of readdirs) {
    assert.ok(
      protectedRoots.some((r) => p === r || p.startsWith(`${r}/`)),
      `walked outside the protected subpaths: ${p}`,
    );
  }
  assert.ok(readdirs.length <= 4, `too many directory reads: ${readdirs.length}`);
});

test('mv evil .claude in a repo without .claude writes a protected ancestor', () => {
  const root = makeRepo();
  write(path.join(root, 'evil', 'settings.json'), '{}');
  write(path.join(root, 'evil', 'skills', 'x', 'SKILL.md'), 'harmless');
  write(path.join(root, 'evil', 'notes.txt'), '');
  const [mv] = cmds('mv evil .claude', root);
  assert.ok(mv.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(mv.writes));
  assert.ok(mv.writes.includes(path.join(root, '.claude', 'skills', 'x', 'SKILL.md')));
  assert.ok(!mv.writes.includes(path.join(root, '.claude', 'notes.txt')));
  assert.ok(mv.ops.some((o) => o.path === path.join(root, '.claude') && o.op === 'move'), JSON.stringify(mv.ops));
  // git mv and util-linux rename are judged the same way
  const [gmv] = cmds('git mv evil .claude', root);
  assert.ok(gmv.writes.includes(path.join(root, '.claude', 'settings.json')));
  assert.ok(gmv.ops.some((o) => o.path === path.join(root, '.claude') && o.op === 'move'));
  const [ren] = cmds('rename evil .claude evil', root);
  assert.ok(ren.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(ren.writes));
  assert.ok(ren.ops.some((o) => o.path === path.join(root, '.claude') && o.op === 'move'));
});

test('git apply x.patch reads targets from the patch', () => {
  const root = makeRepo();
  write(path.join(root, 'x.patch'), PATCH);
  const [apply] = cmds('git apply x.patch', root);
  assert.ok(apply.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(apply.writes));
  assert.ok(apply.writes.includes(path.join(root, 'src', 'a.js')));
  // hunk bodies are skipped: a removed `--- …` or added `+++ …` line names no file
  assert.ok(!apply.writes.some((w) => typeof w === 'string' && w.includes('removed line')));
  // patch -p1 < file, patch -i file and git am mbox read the same parser
  const [p1] = cmds('patch -p1 < x.patch', root);
  assert.ok(p1.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(p1.writes));
  const [p2] = cmds('patch -p1 -i x.patch', root);
  assert.ok(p2.writes.includes(path.join(root, '.claude', 'settings.json')));
  write(path.join(root, 'x.mbox'), `From ${SHA} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] t\n\n---\n${PATCH}`);
  const [am] = cmds('git am x.mbox', root);
  assert.ok(am.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(am.writes));
  // the parser itself: git headers, renames, copies, -p stripping, dedupe, order
  const text = [
    'diff --git a/old.txt b/new.txt',
    'similarity index 90%',
    'rename from old.txt',
    'rename to new.txt',
    'diff --git a/c1 b/c2',
    'copy from c1',
    'copy to c2',
    'diff --git a/gone b/gone',
    'deleted file mode 100644',
    '--- a/gone',
    '+++ /dev/null',
    '',
  ].join('\n');
  assert.deepEqual(patchTargetsFromText(text), ['old.txt', 'new.txt', 'c1', 'c2', 'gone']);
  assert.deepEqual(patchTargetsFromText('--- a/d/e/f\n+++ b/d/e/f\n@@ -1 +1 @@\n-x\n+y\n', { strip: 2 }), ['e/f']);
  assert.deepEqual(patchTargets(path.join(root, 'x.patch'), fs), ['.claude/settings.json', 'src/a.js']);
});

test('an unreadable patch is opaque', () => {
  const root = makeRepo();
  assert.equal(opaque('git apply missing.patch', root).construct, 'patch-unreadable');
  assert.equal(opaque('patch -p1 -i missing.patch', root).construct, 'patch-unreadable');
  assert.equal(opaque('git am "$(cat list)"', root).construct, 'patch-unreadable');
  // a patch with no file names (a bare binary blob), and one over the size cap
  write(path.join(root, 'blob.patch'), 'GIT binary patch\nliteral 3\nKcmV+^\n');
  assert.equal(opaque('git apply blob.patch', root).construct, 'patch-unreadable');
  assert.equal(patchTargets(path.join(root, 'missing.patch'), fs), UNKNOWN);
  assert.equal(patchTargetsFromText(`${'+++ b/x\n'.repeat(1)}${'x'.repeat(2 * 1024 * 1024)}`), UNKNOWN);
});

test('git checkout feature is opaque when the diff lists .claude/settings.json', () => {
  const root = makeRepo();
  write(path.join(root, '.claude', 'settings.local.json'), '{}');
  const diff = fakeDiff(['.claude/settings.json']);
  const o = opaque('git checkout feature', root, { gitTreeDiff: diff });
  assert.equal(o.construct, 'git-tree-update');
  assert.equal(diff.calls.length, 1);
  assert.equal(diff.calls[0].target, 'feature');
  assert.equal(diff.calls[0].repo.root, root);
  assert.deepEqual(diff.calls[0].subpaths, TREE_PATHSPECS);
  // other tree updates take the same path
  for (const c of ['git switch feature', 'git merge feature', 'git reset --hard feature', 'git rebase feature', 'git stash pop', 'git pull']) {
    assert.equal(opaque(c, root, { gitTreeDiff: fakeDiff(['.claude/settings.json']) }).construct, 'git-tree-update', c);
  }
  // in a repo with neither .claude/ nor .codex/, the listed file becomes a protected write
  const bare = makeRepo();
  const [co] = cmds('git checkout feature', bare, { gitTreeDiff: fakeDiff(['.claude/settings.json']) });
  assert.ok(co.writes.includes(path.join(bare, '.claude', 'settings.json')), JSON.stringify(co.writes));
});

test('git checkout feature is unaffected when the diff lists only src files', () => {
  const root = makeRepo();
  write(path.join(root, '.claude', 'settings.local.json'), '{}');
  const base = cmds('git checkout feature', root, { gitTreeDiff: fakeDiff([]) });
  const diff = fakeDiff(['src/a.js', 'src/b.js']);
  const got = cmds('git checkout feature', root, { gitTreeDiff: diff });
  assert.equal(diff.calls.length, 1);
  assert.deepEqual(got, base);
  // an unknown answer, or a target that cannot be named, leaves a repo without .claude/.codex alone
  const bare = makeRepo();
  assert.ok(Array.isArray(run('git checkout feature', bare, { gitTreeDiff: fakeDiff(UNKNOWN) }).commands));
  assert.ok(Array.isArray(run('git pull', bare).commands));
});

test('git checkout is opaque before spawning when .git/config is in the written index', () => {
  const root = makeRepo();
  const diff = fakeDiff([]);
  const o = opaque('git checkout feature', root, { gitTreeDiff: diff, writtenIndex: new Set([path.join(root, '.git', 'config')]) });
  assert.equal(o.construct, 'git-config-written');
  assert.equal(diff.calls.length, 0);
  // a file the config includes counts too
  write(path.join(root, '.git', 'config'), '[core]\n\tbare = false\n[include]\n\tpath = extra.conf\n');
  write(path.join(root, '.git', 'extra.conf'), '');
  const diff2 = fakeDiff([]);
  const o2 = opaque('git checkout feature', root, { gitTreeDiff: diff2, writtenIndex: [path.join(root, '.git', 'extra.conf')] });
  assert.equal(o2.construct, 'git-config-written');
  assert.equal(diff2.calls.length, 0);
  // so does a write earlier in the same call to an included file outside .git (a write under
  // .git itself already makes the repository UNKNOWN for later commands)
  write(path.join(root, '.git', 'config'), '[include]\n\tpath = ../team.conf\n');
  assert.equal(opaque('echo x >> team.conf && git checkout feature', root).construct, 'git-config-written');
  assert.ok(['git-config-written', 'git-tree-update'].includes(opaque('echo x >> .git/config && git checkout feature', root).construct));
  // an unrelated written file does not
  assert.ok(Array.isArray(run('git checkout feature', root, { writtenIndex: new Set([path.join(root, 'src', 'a.js')]) }).commands));
});

test('the spawn argv and env match the spec exactly (snapshot)', () => {
  const seen = [];
  const spawn = (file, args, options) => {
    seen.push({ file, args, options });
    return { status: 0, stdout: '.claude/settings.json\n' };
  };
  const opts = { gitPath: '/opt/git/bin/git', gitVersion: '2.45.1', deadlineMs: 1500, spawn, env: { PATH: '/usr/bin:/bin', HOME: '/home/tester', EXTRA_VAR: 'not-passed' } };
  const out = gitTreeDiff({ root: '/work/repo', branch: 'main' }, 'feature', TREE_PATHSPECS, opts);
  assert.deepEqual(out, ['.claude/settings.json']);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    [seen[0].file, ...seen[0].args],
    [
      '/opt/git/bin/git',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ssh.allow=never',
      '-c', 'protocol.git.allow=never',
      '-c', 'protocol.http.allow=never',
      '-c', 'protocol.https.allow=never',
      '-c', 'protocol.ext.allow=never',
      '-C', '/work/repo',
      'diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', 'feature',
      '--',
      ':(glob,icase).claude/settings*.json', ':(glob,icase).claude/skills/**', ':(glob,icase).codex/**',
    ],
  );
  assert.deepEqual(seen[0].options.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
  });
  assert.equal(seen[0].options.timeout, 1500);
  assert.equal(seen[0].options.maxBuffer, MAX_OUTPUT);
  assert.equal(MAX_OUTPUT, 1024 * 1024);
  assert.equal(DEFAULT_DEADLINE_MS, 2000);
  // stash entries: the separate `git stash show --name-only` form, filtered to the protected subpaths
  seen.length = 0;
  const stashSpawn = (file, args, options) => {
    seen.push({ file, args, options });
    return { status: 0, stdout: 'src/a.js\n.codex/config.toml\n' };
  };
  assert.deepEqual(gitTreeDiff({ root: '/work/repo' }, { stash: 'stash@{0}' }, TREE_PATHSPECS, { ...opts, spawn: stashSpawn }), ['.codex/config.toml']);
  assert.deepEqual(seen[0].args.slice(18), ['-C', '/work/repo', 'stash', 'show', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--include-untracked', 'stash@{0}']);
  // errors, a non-zero exit, a timeout and an option-shaped target are UNKNOWN
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...opts, spawn: () => ({ status: 128, stdout: '' }) }), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...opts, spawn: () => { throw new Error('ETIMEDOUT'); } }), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...opts, spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '' }) }), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, '--output=/tmp/x', TREE_PATHSPECS, { ...opts, spawn }), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...opts, gitPath: 'git' }), UNKNOWN);
});

test('a pinned git older than 2.45.1 makes the check opaque', () => {
  assert.equal(GIT_MIN_VERSION, '2.45.1');
  let spawned = 0;
  const spawn = () => {
    spawned++;
    return { status: 0, stdout: '' };
  };
  const base = { gitPath: '/opt/git/bin/git', spawn, env: { PATH: '/usr/bin', HOME: '/home/tester' } };
  for (const v of ['2.45.0', '2.44.9', '1.99.0', 'git version 2.39.3 (Apple Git-146)', '', undefined]) {
    assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...base, gitVersion: v }), UNKNOWN, String(v));
  }
  assert.equal(spawned, 0);
  for (const v of ['2.45.1', '2.46.0', '3.0.0', 'git version 2.54.0 (Apple Git-157)']) {
    assert.deepEqual(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...base, gitVersion: v }), [], v);
  }
  // through the normalizer: a repo that tracks .claude/ is opaque
  const root = makeRepo();
  write(path.join(root, '.claude', 'settings.json'), '{}');
  const bound = (r, t, s) => gitTreeDiff(r, t, s, { ...base, gitVersion: '2.45.0' });
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: bound }).construct, 'git-tree-update');
});

test('git reset --hard HEAD with a clean tree is unaffected', () => {
  const root = makeRepo();
  write(path.join(root, '.claude', 'settings.json'), '{}');
  const diff = fakeDiff([]);
  const [reset] = cmds('git reset --hard HEAD', root, { gitTreeDiff: diff });
  assert.ok(!reset.writes.includes(path.join(root, '.claude', 'settings.json')));
  for (const c of ['git reset --hard', 'git checkout -- .', 'git restore .', 'git reset HEAD~1']) {
    assert.ok(Array.isArray(run(c, root, { gitTreeDiff: fakeDiff(UNKNOWN) }).commands), c);
  }
});

// ---- table and archive coverage ----------------------------------------------------------------

test('BULK_WRITERS covers the spec list; archives give the destination a bulk op', () => {
  const kinds = new Map(BULK_WRITERS.map((r) => [r.name, r.kind]));
  for (const n of ['cp', 'rsync', 'tar', 'bsdtar', 'unzip', '7z', 'ditto', 'cpio', 'pax', 'patch', 'mv', 'rename', 'git clone', 'git apply', 'git am', 'git mv', 'git checkout', 'git switch', 'git restore', 'git reset', 'git merge', 'git pull', 'git rebase', 'git cherry-pick', 'git revert', 'git stash', 'git read-tree', 'git worktree']) {
    assert.ok(kinds.has(n), n);
  }
  const proj = dir();
  const [tar] = cmds('tar -xzf a.tgz -C out', proj);
  assert.ok(tar.ops.some((o) => o.path === path.join(proj, 'out') && o.op === 'bulk'), JSON.stringify(tar.ops));
  const [unzip] = cmds('unzip a.zip', proj);
  assert.ok(unzip.ops.some((o) => o.path === proj && o.op === 'bulk'));
  const [sz] = cmds('7z x a.7z -oout', proj);
  assert.ok(sz.ops.some((o) => o.path === path.join(proj, 'out') && o.op === 'bulk'));
  const [unk] = cmds('cp -r $SRC out', proj);
  assert.ok(unk.ops.some((o) => o.path === path.join(proj, 'out') && o.op === 'bulk'), JSON.stringify(unk.ops));
  assert.equal(bulkOf(['tar', '-tf', 'a.tar']), null);
  assert.equal(bulkOf(['unzip', '-l', 'a.zip']), null);
});

// ---- fix round 1 ------------------------------------------------------------------------------

// A repo with .claude/ at its root (the "tracks" side of the git tree rule).
function trackedRepo() {
  const root = makeRepo();
  write(path.join(root, '.claude', 'settings.local.json'), '{}');
  return root;
}
// A fake that says the engine's git is bound (ctx.gitTreeDiff.gitPath).
function boundDiff(answer) {
  const f = fakeDiff(answer);
  f.gitPath = '/opt/git/bin/git';
  return f;
}

test('fix1: git checkout WORD with an existing file named WORD still runs the tree check', () => {
  const root = trackedRepo();
  write(path.join(root, 'feature'), '');
  const diff = fakeDiff(['.claude/settings.json']);
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: diff }).construct, 'git-tree-update');
  assert.deepEqual(diff.calls.map((c) => c.target), ['feature']);
  // the ref lists nothing protected: unaffected
  assert.ok(Array.isArray(run('git checkout feature', root, { gitTreeDiff: fakeDiff([]) }).commands));
  // fix 2: UNKNOWN even from a bound git is unnameable (opaque in a tracked repo); only git's own
  // "not a revision" answer means a path restore
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: boundDiff(UNKNOWN) }).construct, 'git-tree-update');
  // an old pinned git answers UNKNOWN without spawning: opaque
  const bound = bindGitTreeDiff({ gitPath: '/opt/git/bin/git', gitVersion: '2.45.0', spawn: () => assert.fail('spawned') });
  assert.equal(bound.gitPath, '/opt/git/bin/git');
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: bound }).construct, 'git-tree-update');
  assert.ok(Array.isArray(run('git checkout feature', root, { gitTreeDiff: fakeDiff(NOT_A_REVISION) }).commands));
  // UNKNOWN with git unbound: unnameable, opaque in a tracked repo
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: fakeDiff(UNKNOWN) }).construct, 'git-tree-update');
  // `git checkout -- feature` is explicitly a path
  assert.ok(Array.isArray(run('git checkout -- feature', root, { gitTreeDiff: fakeDiff(UNKNOWN) }).commands));
});

test('fix1: patch headers end at a tab or a space plus timestamp; malformed hunks and headers are not swallowed', () => {
  // (fix 2: the whole text is reported as well)
  assert.ok(
    patchTargetsFromText('--- .claude/settings.json 1970-01-01 00:00:00\n+++ .claude/settings.json 1970-01-01 00:00:00\n@@ -0,0 +1 @@\n+{}\n').includes('.claude/settings.json'),
  );
  assert.ok(
    patchTargetsFromText('--- a/x 2020-01-01 00:00:00.000000000 +0000\n+++ b/x 2020-01-01 00:00:00.000000000 +0000\n@@ -1 +1 @@\n-a\n+b\n').includes('x'),
  );
  assert.deepEqual(patchTargetsFromText('--- a/y\t2020-01-01\n+++ b/y\t2020-01-01\n@@ -1 +1 @@\n-a\n+b\n'), ['y']);
  // an unknown trailer after a space: both readings are reported
  const both = patchTargetsFromText('--- a/z extra\n+++ b/z extra\n@@ -1 +1 @@\n-a\n+b\n');
  assert.ok(both.includes('z extra') && both.includes('z'), JSON.stringify(both));
  // a hunk whose counts overrun the next header still sees that header
  const over = patchTargetsFromText('--- a/x\n+++ b/x\n@@ -1 +1,3 @@\n-y\n--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{}\n');
  assert.ok(over.includes('.claude/settings.json'), JSON.stringify(over));
  // an ambiguous `diff --git` line is read every way it splits
  const amb = patchTargetsFromText('diff --git a/x b/y b/.claude/settings.json\nnew file mode 100644\n');
  assert.ok(amb.includes('.claude/settings.json'), JSON.stringify(amb));
  // unparsable: an unterminated quoted name
  assert.equal(patchTargetsFromText('--- "a/x\n+++ b/x\n'), UNKNOWN);
});

test('fix1: archives that keep absolute or .. member names have an UNKNOWN destination', () => {
  const dests = (argv) => bulkOf(argv).dests;
  assert.deepEqual(dests(['pax', '-r', '-f', 'a.pax']), [UNKNOWN]);
  assert.deepEqual(dests(['cpio', '-idv']), [UNKNOWN]);
  assert.deepEqual(dests(['cpio', '-id', '--no-absolute-filenames']), ['.']);
  assert.deepEqual(dests(['unzip', '-:', 'a.zip']), [UNKNOWN]);
  assert.deepEqual(dests(['unzip', 'a.zip']), ['.']);
  assert.deepEqual(dests(['bsdtar', '-xf', 'a.tar', '--insecure']), [UNKNOWN]);
  assert.deepEqual(dests(['bsdtar', '-xPf', 'a.tar']), [UNKNOWN]);
  assert.deepEqual(dests(['tar', '-xPf', 'a.tar']), [UNKNOWN]);
  assert.deepEqual(dests(['tar', '-xf', 'a.tar']), ['.']);
  const [pax] = cmds('pax -r -f a.pax', dir());
  assert.ok(pax.ops.some((o) => o.path === UNKNOWN && o.op === 'bulk'), JSON.stringify(pax.ops));
});

test('fix1: tar xCf out a.tgz reads C as the directory option', () => {
  assert.deepEqual(bulkOf(['tar', 'xCf', 'out', 'a.tgz']).dests, ['out']);
  assert.deepEqual(bulkOf(['tar', 'xfC', 'a.tgz', 'out']).dests, ['out']);
  assert.deepEqual(bulkOf(['tar', 'xPf', 'a.tgz']).dests, [UNKNOWN]);
});

test('fix1: git worktree add runs the tree check with its commit-ish', () => {
  const root = trackedRepo();
  const diff = fakeDiff(['.claude/settings.json']);
  assert.equal(opaque('git worktree add ../w feature', root, { gitTreeDiff: diff }).construct, 'git-tree-update');
  assert.deepEqual(diff.calls.map((c) => c.target), ['feature']);
  const diff2 = fakeDiff(['.claude/settings.json']);
  assert.equal(opaque('git worktree add -b topic ../w2 feature', root, { gitTreeDiff: diff2 }).construct, 'git-tree-update');
  assert.deepEqual(diff2.calls.map((c) => c.target), ['feature']);
  // no commit-ish: HEAD, nothing to diff
  const diff3 = fakeDiff(['.claude/settings.json']);
  // (fix 2: a bare PATH checks the branch named after it; --detach with no commit-ish is HEAD)
  assert.ok(Array.isArray(run('git worktree add --detach ../w3', root, { gitTreeDiff: diff3 }).commands));
  assert.equal(diff3.calls.length, 0);
});

test('fix1: git checkout-index is a bulk writer; update-index --cacheinfo writes its path; --index-info/--stdin are opaque', () => {
  const root = trackedRepo();
  assert.equal(opaque('git checkout-index -a -f', root).construct, 'git-tree-update');
  assert.ok(Array.isArray(run('git checkout-index -a -f', makeRepo()).commands));
  const [u1] = cmds(`git update-index --add --cacheinfo 100644,${SHA},.claude/settings.json`, root);
  assert.ok(u1.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(u1.writes));
  const [u2] = cmds(`git update-index --cacheinfo 100644 ${SHA} .codex/config.toml`, root);
  assert.ok(u2.writes.includes(path.join(root, '.codex', 'config.toml')), JSON.stringify(u2.writes));
  // (fix 2: the attached `--cacheinfo=` spelling too)
  const [u3] = cmds(`git update-index --cacheinfo=100644,${SHA},.claude/settings.json`, root);
  assert.ok(u3.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(u3.writes));
  assert.equal(opaque('git update-index --index-info', root).construct, 'index-write');
  assert.equal(opaque('git update-index --add --stdin', root).construct, 'index-write');
});

test('fix1: an oversized repo config is checked by size before it is read', () => {
  const root = makeRepo();
  // (repo.mjs already refuses a config over 64 KiB, so the oversized file is an include)
  write(path.join(root, '.git', 'config'), '[include]\n\tpath = big.conf\n');
  write(path.join(root, '.git', 'big.conf'), `${'#'.repeat(1024 * 1024 + 10)}\n`);
  let readBig = false;
  const readFile = (p) => {
    if (p === path.join(root, '.git', 'big.conf')) readBig = true;
    return fs.readFileSync(p, 'utf8');
  };
  const o = opaque('git checkout feature', root, { readFile, writtenIndex: [path.join(root, 'unrelated.txt')] });
  assert.equal(o.construct, 'git-config-written');
  assert.equal(readBig, false);
});

test('fix1: a repository named through GIT_DIR, GIT_WORK_TREE, --git-dir or --work-tree makes the tree check unnameable', () => {
  const root = trackedRepo();
  for (const c of ['GIT_DIR=.git git checkout feature', 'GIT_WORK_TREE=. git checkout feature', 'git --git-dir=.git checkout feature', 'git --work-tree=. checkout feature']) {
    const diff = fakeDiff([]);
    assert.equal(opaque(c, root, { gitTreeDiff: diff }).construct, 'git-tree-update', c);
    assert.equal(diff.calls.length, 0, c);
  }
  assert.ok(Array.isArray(run('git --git-dir=.git checkout feature', makeRepo(), { gitTreeDiff: fakeDiff([]) }).commands));
});

test('fix1: a repo tracks .claude/ when .git/index names it, even with no directory present', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, '.git', 'index'), Buffer.concat([Buffer.from('DIRC\0\0\0\x02'), Buffer.from('.claude/settings.json\0')]));
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: fakeDiff(UNKNOWN) }).construct, 'git-tree-update');
  const bare = makeRepo();
  fs.writeFileSync(path.join(bare, '.git', 'index'), Buffer.from('DIRC\0\0\0\x02src/a.js\0'));
  assert.ok(Array.isArray(run('git checkout feature', bare, { gitTreeDiff: fakeDiff(UNKNOWN) }).commands));
});

// ---- fix round 2 ------------------------------------------------------------------------------

test('fix2: only git\'s own unknown-revision answer is NOT_A_REVISION; every other failure is UNKNOWN', () => {
  assert.ok(Object.isFrozen(NOT_A_REVISION));
  assert.notEqual(NOT_A_REVISION, UNKNOWN);
  const opts = (r) => ({ gitPath: '/opt/git/bin/git', gitVersion: '2.45.1', env: { PATH: '/usr/bin', HOME: '/home/tester' }, spawn: () => r });
  for (const msg of [
    "fatal: ambiguous argument 'feature': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions",
    "fatal: bad revision 'feature'",
  ]) {
    assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, opts({ status: 128, stdout: '', stderr: msg })), NOT_A_REVISION, msg);
  }
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, opts({ status: 128, stdout: '', stderr: 'fatal: not a git repository' })), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, opts({ status: null, signal: 'SIGTERM', stdout: '', stderr: "unknown revision" })), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, opts({ status: 128, stdout: '', stderr: 'unknown revision', error: new Error('ETIMEDOUT') })), UNKNOWN);
  assert.equal(gitTreeDiff({ root: '/r' }, 'feature', TREE_PATHSPECS, { ...opts({ status: 128, stdout: '', stderr: 'unknown revision' }), gitVersion: '2.39.0' }), UNKNOWN);
  // through the normalizer: NOT_A_REVISION for a plain (unambiguous) checkout is still unnameable
  const root = trackedRepo();
  assert.equal(opaque('git checkout feature', root, { gitTreeDiff: fakeDiff(NOT_A_REVISION) }).construct, 'git-tree-update');
});

test('fix2: a header name before an ISO timestamp is reported both cut and whole', () => {
  const t = patchTargetsFromText('+++ b/x 2020-01-01 00:00:00/.claude/settings.json\n@@ -0,0 +1 @@\n+{}\n');
  assert.ok(t.includes('x'), JSON.stringify(t));
  assert.ok(t.includes('x 2020-01-01 00:00:00/.claude/settings.json'), JSON.stringify(t));
});

test('fix2: git worktree add PATH with no commit-ish checks the branch named after PATH', () => {
  const root = trackedRepo();
  const listing = fakeDiff((t) => (t === 'evil' ? ['.claude/settings.json'] : []));
  assert.equal(opaque('git worktree add ../evil', root, { gitTreeDiff: listing }).construct, 'git-tree-update');
  assert.deepEqual(listing.calls.map((c) => c.target), ['evil']);
  // no such branch: a new branch from HEAD, unaffected
  assert.ok(Array.isArray(run('git worktree add ../w4', root, { gitTreeDiff: fakeDiff(NOT_A_REVISION) }).commands));
  // UNKNOWN: unnameable, opaque in a tracked repo
  assert.equal(opaque('git worktree add ../w5', root, { gitTreeDiff: fakeDiff(UNKNOWN) }).construct, 'git-tree-update');
  // -b/-B/--detach without a commit-ish: HEAD, nothing to check
  for (const c of ['git worktree add -b topic ../w6', 'git worktree add -B topic ../w7', 'git worktree add --detach ../w8']) {
    const d = fakeDiff(['.claude/settings.json']);
    assert.ok(Array.isArray(run(c, root, { gitTreeDiff: d }).commands), c);
    assert.equal(d.calls.length, 0, c);
  }
});

// ---- real git ------------------------------------------------------------------------------------

function findGit() {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d.startsWith('/')) continue;
    const p = path.join(d, 'git');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

test('a temp repo with a tracked .claude/settings.json on another branch is detected', (t) => {
  const gitPath = findGit();
  if (gitPath === null) {
    t.skip('no git binary on PATH');
    return;
  }
  const home = dir();
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (cwd, ...args) => {
    const r = spawnSync(gitPath, ['-c', 'user.name=Fence Test', '-c', 'user.email=fence@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const version = git(TMP, '--version').trim();
  const root = dir();
  git(root, 'init', '-q');
  write(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'checkout', '-q', '-b', 'feature');
  write(path.join(root, '.claude', 'settings.json'), '{}\n');
  git(root, 'add', '.claude/settings.json');
  git(root, 'commit', '-q', '-m', 'settings');
  git(root, 'checkout', '-q', 'main');
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  const opts = { gitPath, gitVersion: version, env: { PATH: process.env.PATH, HOME: home } };
  if (!gitVersionOk(version)) {
    t.skip(`git on PATH is older than ${GIT_MIN_VERSION}: ${version}`);
    return;
  }
  const listed = gitTreeDiff({ root }, 'feature', TREE_PATHSPECS, opts);
  assert.deepEqual(listed, ['.claude/settings.json']);
  const [co] = cmds('git checkout feature', root, { gitTreeDiff: (r, tg, s) => gitTreeDiff(r, tg, s, opts) });
  assert.ok(co.writes.includes(path.join(root, '.claude', 'settings.json')), JSON.stringify(co.writes));
  // a branch that only changes other files lists nothing
  git(root, 'checkout', '-q', '-b', 'docs');
  write(path.join(root, 'README.md'), 'changed\n');
  git(root, 'commit', '-q', '-am', 'docs');
  git(root, 'checkout', '-q', 'main');
  assert.deepEqual(gitTreeDiff({ root }, 'docs', TREE_PATHSPECS, opts), []);
});
