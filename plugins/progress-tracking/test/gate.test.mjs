import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync, rmSync, realpathSync, copyFileSync,
  utimesSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePorcelain, isTrackingFile, stopVerdict, latestEntry, sessionContext } from '../scripts/gate.mjs';
import { resolveTracking, writeState, progressHash } from '../lib/tracking.mjs';
import { createLedger, statusLine } from '../lib/ledger.mjs';
import { BRAND } from '../lib/brand.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(PLUGIN, 'scripts', 'gate.mjs');

const COMMITTED_REASON = 'There are uncommitted changes and progress.md is not updated. Before ending the turn, add the ' +
  'entry for this work at the top of progress.md (stage/task, done, files, real verification, commit, next) and ' +
  'update status.md if the overall state changed. Details: skill progress-tracking:progress-tracking.';
// Local mode: agents cannot edit files under the git dir, so the reasons name `triqual tracking write` (T16).
const localWrite = (t) => 'Before ending the turn, write the entry for this work to a draft file outside the repo and ' +
  `run \`${BRAND.cli} tracking write entry <draft>\` (it lands at the top of that file; agents cannot edit files under the git ` +
  `dir), and if the overall state changed, \`${BRAND.cli} tracking write status <draft>\` with the whole new ${t.status}. ` +
  'Details: skill progress-tracking:progress-tracking.';
const localReason = (t) => 'There are uncommitted changes and progress.md has no new entry since the last gated ' +
  `commit (local mode: ${t.progress}). ${localWrite(t)}`;
const HEADER = 'This repo uses strict progress tracking (skill progress-tracking:progress-tracking): at the end of ' +
  'every task, add an entry at the top of progress.md and update status.md, in the same commit.';
// Local mode: the tracking files live under the git dir, which agents cannot write, so the header names triqual tracking
// write.
const LOCAL_HEADER = (root) => 'This repo uses strict progress tracking in local mode (skill '
  + `progress-tracking:progress-tracking): the files live in ${root} and are never committed. At the end of every task, `
  + `write the entry to a draft file outside the repo and run \`${BRAND.cli} tracking write entry <draft>\`, and update status.md `
  + `the same way with \`${BRAND.cli} tracking write status <draft>\` (agents cannot edit files under the git dir).`;
const OUTPUT_CAP = 9_500;

const COMMITTED = { mode: 'committed', progress: '/r/progress.md', status: '/r/status.md', root: '/r' };
const ENTRY = '# Progress\n\n## 2026-09-27 — First\n- done\n';
const TEMPLATE = '# Progress\n\nAppend-only log: one entry per task, newest on top.\n';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
});

// A temp HOME plus a git repo with one commit; `fn(dir, home)`; both removed afterwards.
function withRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gate-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gate-home-')));
  try {
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'README.md'), 'readme\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return fn(dir, home);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

// The hook runs with a temp HOME and no XDG_CONFIG_HOME: session-start writes the repo registry under HOME.
const hookEnv = (home) => {
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  return env;
};
const spawnGate = (mode, cwd, home, payload = {}) => spawnSync('node', [GATE, mode], {
  cwd, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env: hookEnv(home),
});
function run(mode, cwd, home, payload) {
  const r = spawnGate(mode, cwd, home, payload);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const context = (out) => JSON.parse(out).hookSpecificOutput.additionalContext;

function committedRepo(dir, { progress = ENTRY, status = '# Status\nphase one\n' } = {}) {
  writeFileSync(join(dir, 'progress.md'), progress);
  writeFileSync(join(dir, 'status.md'), status);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'tracking', '--no-verify');
}

// Opts `dir` in to local mode: <git-common-dir>/methodology/{progress,status}.md. Returns the tracking.
function localRepo(dir, { progress = ENTRY, status = '# Status\nlocal phase\n' } = {}) {
  const root = join(dir, '.git', 'methodology');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'progress.md'), progress);
  writeFileSync(join(root, 'status.md'), status);
  const t = resolveTracking(dir);
  assert.equal(t.mode, 'local');
  return t;
}

const ledger = (state, statuses) => {
  const l = createLedger({
    plan: 'docs/plans/p.md', spec: null, branch: 'main', now: '2026-09-27T00:00:00Z',
    tasks: statuses.map((_, i) => ({ id: `T${i + 1}`, title: `Task ${i + 1}`, deps: [], skills: [] })),
  });
  l.state = state;
  statuses.forEach((s, i) => { l.tasks[i].status = s; });
  return l;
};

// ---- pure helpers ----

test('docs/plans/x.md is not a tracking file, but docs/plans/x.tasks.json is', () => {
  assert.equal(isTrackingFile('progress.md'), true);
  assert.equal(isTrackingFile('status.md'), true);
  assert.equal(isTrackingFile('docs/plans/x.tasks.json'), true);
  assert.equal(isTrackingFile('docs/plans/x.md'), false);
  assert.equal(isTrackingFile('docs/plans/sub/x.tasks.json'), false);
  assert.equal(isTrackingFile('other/docs/plans/x.tasks.json'), false);
  assert.equal(isTrackingFile('docs/progress.md'), false);
  assert.equal(isTrackingFile('docs/plans/x.tasks.json.bak'), false);
});

test('committed: uncommitted work blocks with the exact message unless progress.md is among the changes', () => {
  const v = stopVerdict({ dirty: ['lib/a.mjs'], tracking: COMMITTED, input: {}, currentHash: null, lastHash: null });
  assert.deepEqual(v, { decision: 'block', reason: COMMITTED_REASON });
  assert.equal(stopVerdict({ dirty: ['lib/a.mjs', 'progress.md'], tracking: COMMITTED, input: {}, currentHash: null, lastHash: null }), null);
  assert.equal(stopVerdict({ dirty: ['docs/plans/x.md'], tracking: COMMITTED, input: {}, currentHash: null, lastHash: null }).decision, 'block');
});

test('committed: a clean tree, only tracking files dirty, or a stop that continues a block, never blocks', () => {
  const verdict = (dirty, input = {}) => stopVerdict({ dirty, tracking: COMMITTED, input, currentHash: null, lastHash: null });
  assert.equal(verdict([]), null);
  assert.equal(verdict(['status.md']), null);
  assert.equal(verdict(['lib/a.mjs'], { stop_hook_active: true }), null);
});

test('ledger-only dirt never blocks', () => {
  const verdict = (dirty) => stopVerdict({ dirty, tracking: COMMITTED, input: {}, currentHash: null, lastHash: null });
  assert.equal(verdict(['docs/plans/2026-09-27-x.tasks.json']), null);
  assert.equal(verdict(['docs/plans/a.tasks.json', 'docs/plans/b.tasks.json', 'status.md']), null);
});

test('local: dirt blocks while the hashes match, passes once they differ, and stop_hook_active never blocks', () => {
  const t = { mode: 'local', progress: '/g/methodology/progress.md', status: '/g/methodology/status.md', root: '/g/methodology' };
  assert.deepEqual(stopVerdict({ dirty: ['a.js'], tracking: t, input: {}, currentHash: 'h1', lastHash: 'h1' }),
    { decision: 'block', reason: localReason(t) });
  assert.equal(stopVerdict({ dirty: ['a.js'], tracking: t, input: {}, currentHash: 'h2', lastHash: 'h1' }), null);
  assert.equal(stopVerdict({ dirty: [], tracking: t, input: {}, currentHash: 'h1', lastHash: 'h1' }), null);
  assert.equal(stopVerdict({ dirty: ['a.js'], tracking: t, input: { stop_hook_active: true }, currentHash: 'h1', lastHash: 'h1' }), null);
  // every dirty path counts in local mode, even one named like a committed tracking file
  assert.equal(stopVerdict({ dirty: ['progress.md'], tracking: t, input: {}, currentHash: 'h1', lastHash: 'h1' }).decision, 'block');
});

test('latestEntry returns the first "## " section, without the file header or older entries', () => {
  const text = '# Progress\n\nintro\n\n## 2026-09-27 — B\n- b1\n\n## 2026-09-26 — A\n- a1\n';
  assert.equal(latestEntry(text), '## 2026-09-27 — B\n- b1');
  assert.equal(latestEntry('# Progress\n\nnothing yet\n'), null);
});

test('sessionContext: header, status.md, latest entry, in English; empty files say so', () => {
  const ctx = sessionContext({ tracking: COMMITTED, status: '# Status\nphase 2', progress: ENTRY, activeLines: [] });
  assert.equal(ctx, [HEADER, '=== status.md ===\n# Status\nphase 2', '=== Latest progress.md entry ===\n## 2026-09-27 — First\n- done'].join('\n\n'));
  const empty = sessionContext({ tracking: COMMITTED, status: '  \n', progress: TEMPLATE, activeLines: [] });
  assert.match(empty, /=== status\.md ===\n\(empty\)/);
  assert.match(empty, /=== Latest progress\.md entry ===\n\(no entries yet\)$/);
  assert.doesNotMatch(empty, /Active plans|Local mode/);
});

test('sessionContext adds the local-mode note and the active plans block', () => {
  const t = { mode: 'local', root: '/g/methodology' };
  const ctx = sessionContext({ tracking: t, status: 's', progress: ENTRY, activeLines: ['a: 1/2 done · in progress: none · next: T2', 'b: 0/1 done · in progress: T1 · next: none'] });
  assert.ok(ctx.startsWith(`${LOCAL_HEADER('/g/methodology')}\n\n`), ctx);
  assert.equal(ctx.includes('add an entry at the top of progress.md'), false, ctx);
  assert.ok(ctx.endsWith('\n\n=== Active plans ===\na: 1/2 done · in progress: none · next: T2\nb: 0/1 done · in progress: T1 · next: none'));
});

test('sessionContext caps a huge status.md first, counting the JSON escaping of the hook output', () => {
  const wrapped = (ctx) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
  for (const status of ['x'.repeat(50_000), '"\n'.repeat(20_000)]) {
    const ctx = sessionContext({ tracking: COMMITTED, status, progress: ENTRY, activeLines: ['a: 0/1 done · in progress: none · next: T1'] });
    assert.ok(wrapped(ctx).length < OUTPUT_CAP, `${wrapped(ctx).length}`);
    assert.match(ctx, /\[status\.md truncated: read the full file\]/);
    assert.match(ctx, /## 2026-09-27 — First/);
    assert.match(ctx, /=== Active plans ===\na: 0\/1 done/);
    assert.ok(wrapped(ctx).length > OUTPUT_CAP - 200, 'status fills the room it has');
  }
  const huge = sessionContext({ tracking: COMMITTED, status: 's', progress: `## 2026-09-27 — X\n${'y'.repeat(50_000)}`, activeLines: [] });
  assert.ok(wrapped(huge).length < OUTPUT_CAP);
});

test('hooks.json: the Stop hook status message is in English', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.Stop[0].hooks[0].statusMessage, 'Checking progress tracking');
});

// ---- the real hook process ----

test('in a repo without progress.md both hooks stay silent, whatever the tree state', () => withRepo((dir, home) => {
  writeFileSync(join(dir, 'a.txt'), 'x');
  assert.equal(run('stop', dir, home), '');
  assert.equal(run('session-start', dir, home), '');
}));

test('outside any git repo both hooks stay silent', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-nogit-')));
  try {
    assert.equal(run('stop', dir, dir), '');
    assert.equal(run('session-start', dir, dir), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('committed: the stop hook blocks dirty work and session-start injects the context', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: COMMITTED_REASON });
  const out = JSON.parse(run('session-start', dir, home));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /phase one/);
  assert.match(out.hookSpecificOutput.additionalContext, /First/);
  assert.equal(run('stop', dir, home, { stop_hook_active: true }), '');
  appendFileSync(join(dir, 'progress.md'), '\n');
  assert.equal(run('stop', dir, home), '');
}));

test('committed: ledger-only dirt never blocks, a changed plan .md does', () => withRepo((dir, home) => {
  committedRepo(dir);
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plans', 'x.tasks.json'), '{}\n');
  writeFileSync(join(dir, 'status.md'), '# Status\nchanged\n');
  assert.equal(run('stop', dir, home), '');
  writeFileSync(join(dir, 'docs', 'plans', 'x.md'), '# plan\n');
  assert.equal(JSON.parse(run('stop', dir, home)).decision, 'block');
}));

test('the hooks resolve the repo from a subdirectory cwd', () => withRepo((dir, home) => {
  committedRepo(dir);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'x.js'), '1');
  assert.equal(JSON.parse(run('stop', join(dir, 'sub'), home)).decision, 'block');
}));

test('local mode blocks until progress.md changes, then passes', () => withRepo((dir, home) => {
  const t = localRepo(dir);
  writeState(t, progressHash(t));
  assert.equal(run('stop', dir, home), '', 'clean tree');
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localReason(t) });
  assert.equal(run('stop', dir, home, { stop_hook_active: true }), '');
  writeFileSync(t.progress, `${ENTRY.replace('## ', '## 2026-09-28 — Second\n- more\n\n## ')}`);
  assert.equal(run('stop', dir, home), '');
}));

test('local mode with a fresh template progress.md and null lastHash blocks', () => withRepo((dir, home) => {
  const t = localRepo(dir, { progress: TEMPLATE });
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localReason(t) });
  writeFileSync(t.progress, ENTRY); // the first entry counts as a change against no recorded hash
  assert.equal(run('stop', dir, home), '');
}));

test('local mode ignores a pending hash (its commit may have aborted) and never writes state.json', () => withRepo((dir, home) => {
  const t = localRepo(dir);
  const state = `${JSON.stringify({
    version: 1, lastProgressSha256: 'f'.repeat(64), // an older progress.md
    pendingProgressSha256: progressHash(t), pendingHead: '0'.repeat(40), // unknown fields from older files are ignored
  }, null, 2)}\n`;
  writeFileSync(t.statePath, state);
  writeFileSync(join(dir, 'code.js'), '1');
  assert.equal(run('stop', dir, home), '');
  assert.equal(readFileSync(t.statePath, 'utf8'), state);
}));

test('local mode blocks after a landed commit, even once HEAD is back where that commit started', () => withRepo((dir, home) => {
  const t = localRepo(dir, { progress: TEMPLATE });
  const common = join(dir, '.git');
  copyFileSync(join(PLUGIN, 'templates', 'pre-commit-local.mjs'), join(t.root, 'pre-commit.mjs'));
  mkdirSync(join(common, 'hooks'), { recursive: true });
  for (const [hook, line] of [['pre-commit', '|| exit 1'], ['post-commit', '--post-commit']]) {
    writeFileSync(join(common, 'hooks', hook),
      `#!/bin/sh\nnode "$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs" ${line}\n`);
    chmodSync(join(common, 'hooks', hook), 0o755);
  }
  // core.hooksPath stays unset, as init --local requires to install these hooks (set, the Stop hook has no hooks to
  // rely on and judges against the last commit instead).
  git(dir, 'branch', 'feature');
  writeFileSync(t.progress, ENTRY);
  writeFileSync(join(dir, 'one.js'), '1');
  git(dir, 'add', 'one.js');
  git(dir, 'commit', '-qm', 'one'); // gated: ENTRY is new against the missing state
  git(dir, 'switch', '-q', 'feature');
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localReason(t) });
}));

test('local mode fails closed when state.json cannot be read', () => withRepo((dir, home) => {
  const t = localRepo(dir);
  mkdirSync(t.statePath); // EISDIR on read
  writeFileSync(join(dir, 'code.js'), '1');
  const v = JSON.parse(run('stop', dir, home));
  assert.equal(v.decision, 'block');
  assert.ok(v.reason.startsWith(`${localReason(t)} (state.json could not be read: `), v.reason);
  assert.match(v.reason, /EISDIR/);
  assert.ok(v.reason.endsWith(')'));
}));

test('session-start in local mode names the root', () => withRepo((dir, home) => {
  const t = localRepo(dir);
  const ctx = context(run('session-start', dir, home));
  assert.ok(ctx.startsWith(`${LOCAL_HEADER(t.root)}\n\n`), ctx);
  assert.match(ctx, /local phase/);
  assert.match(ctx, /## 2026-09-27 — First/);
}));

test('session-start lists active plans', () => withRepo((dir, home) => {
  committedRepo(dir);
  const plans = join(dir, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const a = ledger('active', ['done', 'in_progress', 'pending']);
  const b = ledger('active', ['pending']);
  writeFileSync(join(plans, '2026-09-01-a.tasks.json'), JSON.stringify(a));
  writeFileSync(join(plans, '2026-09-02-b.tasks.json'), JSON.stringify(b));
  writeFileSync(join(plans, '2026-09-03-closed.tasks.json'), JSON.stringify(ledger('done', ['done'])));
  writeFileSync(join(plans, '2026-09-04-broken.tasks.json'), '{ not json');
  writeFileSync(join(plans, '2026-09-05-empty.tasks.json'), '[]');
  const ctx = context(run('session-start', dir, home));
  assert.ok(ctx.endsWith(`\n\n=== Active plans ===\n${statusLine('2026-09-02-b', b)}\n${statusLine('2026-09-01-a', a)}`), ctx);
  assert.doesNotMatch(ctx, /closed|broken|empty/);
}));

test('session-start without active ledgers has no active plans block', () => withRepo((dir, home) => {
  committedRepo(dir);
  const plans = join(dir, 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, 'closed.tasks.json'), JSON.stringify(ledger('done', ['done'])));
  assert.doesNotMatch(context(run('session-start', dir, home)), /Active plans/);
}));

test('session-start output stays under 9,500 characters with a huge status.md', () => withRepo((dir, home) => {
  committedRepo(dir, { status: `# Status\n${'"quoted"\tand\\slashed\n'.repeat(5_000)}` });
  const out = run('session-start', dir, home);
  assert.ok(out.length < OUTPUT_CAP, `${out.length}`);
  assert.match(context(out), /\[status\.md truncated: read the full file\]/);
  assert.match(context(out), /## 2026-09-27 — First/);
}));

test('session-start exits 0 with no output when progress.md cannot be read', { skip: process.getuid?.() === 0 && 'root reads mode-000 files' }, () => withRepo((dir, home) => {
  committedRepo(dir);
  chmodSync(join(dir, 'progress.md'), 0o000);
  try {
    const r = spawnGate('session-start', dir, home);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { chmodSync(join(dir, 'progress.md'), 0o644); }
}));

// ---- final fix wave ----

// A commit whose committer time is `sec` (epoch seconds), hooks bypassed: these tests drive the Stop hook only.
const commitAt = (dir, sec, msg) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg, '--no-verify'], {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_COMMITTER_DATE: `@${sec} +0000` },
});
const localHooklessReason = (t) => 'There are uncommitted changes and progress.md has not changed since the last commit ' +
  `(local mode without git hooks: ${t.progress}). ${localWrite(t)}`;
const touch = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));
const withEntry = (text, title) => text.replace(/\n(?=## |$)/, `\n## 2026-09-27 — ${title}\n- done\n\n`);

test('local mode without git hooks (core.hooksPath set) re-arms after every commit', () => withRepo((dir, home) => {
  const t = localRepo(dir, { progress: TEMPLATE });
  writeState(t, progressHash(t)); // what init --local records
  git(dir, 'config', 'core.hooksPath', '.husky/_'); // init installs no hook: nothing ever updates state.json
  const c1 = Math.floor(Date.now() / 1000) + 1000;
  writeFileSync(t.progress, withEntry(TEMPLATE, 'One'));
  touch(t.progress, (c1 - 10) * 1000);
  writeFileSync(join(dir, 'one.js'), '1');
  assert.equal(run('stop', dir, home), '', 'an entry newer than HEAD passes');
  git(dir, 'add', 'one.js');
  commitAt(dir, c1, 'one');
  writeFileSync(join(dir, 'two.js'), '2');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localHooklessReason(t) },
    'dirty after a commit, with no entry since it');
  writeFileSync(t.progress, withEntry(readFileSync(t.progress, 'utf8'), 'Two'));
  touch(t.progress, (c1 + 10) * 1000);
  assert.equal(run('stop', dir, home), '', 'a new entry passes');
  git(dir, 'add', 'two.js');
  commitAt(dir, c1 + 20, 'two');
  writeFileSync(join(dir, 'three.js'), '3');
  assert.equal(JSON.parse(run('stop', dir, home)).decision, 'block', 'the next commit re-arms the gate');
  assert.equal(run('stop', dir, home, { stop_hook_active: true }), '');
}));

test('local mode without git hooks compares at git\'s one-second resolution: the commit\'s own second is not newer', () => withRepo((dir, home) => {
  const t = localRepo(dir);
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const c = Math.floor(Date.now() / 1000) + 1000;
  writeFileSync(join(dir, 'one.js'), '1');
  git(dir, 'add', 'one.js');
  commitAt(dir, c, 'one');
  writeFileSync(join(dir, 'two.js'), '2');
  touch(t.progress, c * 1000 + 900); // written in the second the commit carries: fails closed
  assert.equal(JSON.parse(run('stop', dir, home)).decision, 'block');
  touch(t.progress, (c + 1) * 1000);
  assert.equal(run('stop', dir, home), '');
}));

test('local mode without git hooks and an unborn HEAD keeps the hash rule', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gate-unborn-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-gate-home-')));
  try {
    git(dir, 'init', '-q');
    const t = localRepo(dir);
    writeState(t, progressHash(t));
    git(dir, 'config', 'core.hooksPath', '.husky/_');
    writeFileSync(join(dir, 'code.js'), '1');
    assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localReason(t) });
    writeFileSync(t.progress, withEntry(readFileSync(t.progress, 'utf8'), 'Two'));
    assert.equal(run('stop', dir, home), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('local mode fails closed when progress.md cannot be read', { skip: process.getuid?.() === 0 && 'root reads mode-000 files' }, () => withRepo((dir, home) => {
  const t = localRepo(dir);
  writeState(t, 'f'.repeat(64));
  writeFileSync(join(dir, 'code.js'), '1');
  chmodSync(t.progress, 0o000);
  try {
    const v = JSON.parse(run('stop', dir, home));
    assert.equal(v.decision, 'block');
    assert.ok(v.reason.startsWith(`${localReason(t)} (progress.md could not be read: `), v.reason);
    assert.match(v.reason, /EACCES/);
  } finally { chmodSync(t.progress, 0o644); }
}));

test('porcelain -z parsing: NUL-separated records, the new side of a rename or copy, no quoting', () => {
  assert.deepEqual(parsePorcelain(' M lib/a.mjs\0?? docs/new file.md\0R  new.mjs\0old.mjs\0C  copy.mjs\0orig.mjs\0?? plán x.md\0'),
    ['lib/a.mjs', 'docs/new file.md', 'new.mjs', 'copy.mjs', 'plán x.md']);
  assert.deepEqual(parsePorcelain(''), []);
});

test('committed: a ledger-only change never blocks, even when the plan name has non-ASCII characters and spaces', () => withRepo((dir, home) => {
  committedRepo(dir);
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  const ledgerPath = join(dir, 'docs', 'plans', '2026-09-27-plán x.tasks.json');
  writeFileSync(ledgerPath, '{}\n');
  assert.equal(run('stop', dir, home), '', 'untracked ledger');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ledger', '--no-verify');
  writeFileSync(ledgerPath, '{"x":1}\n');
  assert.equal(run('stop', dir, home), '', 'modified ledger');
  git(dir, 'mv', 'docs/plans/2026-09-27-plán x.tasks.json', 'docs/plans/2026-09-27-plán y.tasks.json');
  assert.equal(run('stop', dir, home), '', 'renamed ledger');
}));

// ---- final fix wave, residual ----

test('local mode without git hooks: a fresh template progress.md newer than HEAD still blocks', () => withRepo((dir, home) => {
  const t = localRepo(dir, { progress: TEMPLATE });
  writeState(t, progressHash(t)); // init --local, after the last commit
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const ct = Number(git(dir, 'log', '-1', '--format=%ct').trim());
  touch(t.progress, (ct + 10) * 1000);
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: localHooklessReason(t) });
  writeFileSync(t.progress, withEntry(TEMPLATE, 'One'));
  touch(t.progress, (ct + 20) * 1000);
  assert.equal(run('stop', dir, home), '', 'a first entry passes');
}));

test('local mode without git hooks fails closed on an unreadable progress.md', { skip: process.getuid?.() === 0 && 'root reads mode-000 files' }, () => withRepo((dir, home) => {
  const t = localRepo(dir);
  writeState(t, 'f'.repeat(64));
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const ct = Number(git(dir, 'log', '-1', '--format=%ct').trim());
  touch(t.progress, (ct + 10) * 1000);
  writeFileSync(join(dir, 'code.js'), '1');
  chmodSync(t.progress, 0o000);
  try {
    const v = JSON.parse(run('stop', dir, home));
    assert.equal(v.decision, 'block');
    assert.ok(v.reason.startsWith(`${localHooklessReason(t)} (progress.md could not be read: `), v.reason);
    assert.match(v.reason, /EACCES/);
  } finally { chmodSync(t.progress, 0o644); }
}));

test('committed: a code file renamed into a ledger path still blocks (no rename detection)', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), 'x\n');
  git(dir, 'add', 'code.js');
  git(dir, 'commit', '-qm', 'code', '--no-verify');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  git(dir, 'mv', 'code.js', 'docs/plans/x.tasks.json');
  assert.deepEqual(JSON.parse(run('stop', dir, home)), { decision: 'block', reason: COMMITTED_REASON });
}));

// ---- T15: the Stop gate blocks once per change set ----

const S1 = { session_id: 'sess-1' };
const S2 = { session_id: 'sess-2' };
// The hook env with the plugin's data dir under the temp HOME (CLAUDE_PLUGIN_DATA), unless `data` is null.
function dataEnv(home, data = join(home, 'plugin-data')) {
  const env = hookEnv(home);
  if (data === null) delete env.CLAUDE_PLUGIN_DATA;
  else env.CLAUDE_PLUGIN_DATA = data;
  return env;
}
function stopWith(cwd, env, payload = {}) {
  const r = spawnSync('node', [GATE, 'stop'], { cwd, input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const stateFile = (home, id, data = join(home, 'plugin-data')) => join(data, 'stop', `${id}.json`);
const BLOCK = { decision: 'block', reason: COMMITTED_REASON };

test('the second Stop with an unchanged dirty state passes', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '', 'same change set');
  assert.equal(stopWith(dir, env, S1), '', 'still the same change set');
  const state = JSON.parse(readFileSync(stateFile(home, 'sess-1'), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['blockedAt', 'fingerprint']);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(new Date(state.blockedAt).toISOString(), state.blockedAt);
  writeFileSync(join(dir, 'status.md'), '# Status\nledger moved\n'); // tracking files are not part of the change set
  assert.equal(stopWith(dir, env, S1), '', 'a tracking-file move is not a new change set');
  for (const payload of [{}, { session_id: '' }, { session_id: 42 }, { session_id: '../escape' }]) {
    assert.deepEqual(JSON.parse(stopWith(dir, env, payload)), BLOCK, `no usable session_id blocks: ${JSON.stringify(payload)}`);
    assert.deepEqual(JSON.parse(stopWith(dir, env, payload)), BLOCK, `every time: ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(readdirSync(join(home, 'plugin-data', 'stop')), ['sess-1.json']);
  assert.equal(stopWith(dir, env, { ...S1, stop_hook_active: true }), '');
}));

test('touching a dirty file again re-blocks', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  git(dir, 'add', 'code.js');
  git(dir, 'commit', '-qm', 'code', '--no-verify');
  writeFileSync(join(dir, 'code.js'), '2');
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '');
  touch(join(dir, 'code.js'), Date.now() + 60_000);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK, 'a new mtime');
  assert.equal(stopWith(dir, env, S1), '');
  writeFileSync(join(dir, 'code.js'), '22');
  touch(join(dir, 'code.js'), Date.now() + 60_000); // same mtime as before is not guaranteed; the size differs anyway
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK, 'a new size');
  assert.equal(stopWith(dir, env, S1), '');
  rmSync(join(dir, 'code.js'));
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK, 'deleted: the path counts with -1');
  assert.equal(stopWith(dir, env, S1), '');
}));

test('a new dirty file re-blocks', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'other.js'), '1');
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '');
}));

test('adding the progress.md entry passes as today', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  const recorded = readFileSync(stateFile(home, 'sess-1'), 'utf8');
  writeFileSync(join(dir, 'progress.md'), withEntry(ENTRY, 'Second'));
  assert.equal(stopWith(dir, env, S1), '');
  assert.equal(readFileSync(stateFile(home, 'sess-1'), 'utf8'), recorded, 'a pass leaves the state alone');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'work', '--no-verify');
  writeFileSync(join(dir, 'code.js'), '2');
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK, 'the next change set blocks again');
  assert.equal(stopWith(dir, env, S1), '');
}));

test('different sessions keep separate state', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S2)), BLOCK, 'another session has its own record');
  assert.equal(stopWith(dir, env, S1), '');
  assert.equal(stopWith(dir, env, S2), '');
  assert.deepEqual(readdirSync(join(home, 'plugin-data', 'stop')).sort(), ['sess-1.json', 'sess-2.json']);
}));

test('an unwritable state dir falls back to blocking', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const file = join(home, 'not-a-dir');
  writeFileSync(file, 'x'); // CLAUDE_PLUGIN_DATA is a file: mkdir fails
  for (let i = 0; i < 2; i++) assert.deepEqual(JSON.parse(stopWith(dir, dataEnv(home, file), S1)), BLOCK);
  mkdirSync(stateFile(home, 'sess-1'), { recursive: true }); // the state file is a directory: read and write fail
  for (let i = 0; i < 2; i++) assert.deepEqual(JSON.parse(stopWith(dir, dataEnv(home), S1)), BLOCK);
}));

test('the state file never lands inside the repo', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const tmp = join(home, 'tmp');
  mkdirSync(tmp);
  const env = { ...dataEnv(home, null), TMPDIR: tmp };
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '', 'recorded under os.tmpdir()/<the triqual dir>');
  assert.match(JSON.parse(readFileSync(join(tmp, BRAND.dir, 'stop', 'sess-1.json'), 'utf8')).fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '?? code.js\n');
  for (const inside of [join(dir, '.data'), '.data', '..data']) { // absolute, and relative to the hook's cwd (the repo)
    const envIn = dataEnv(home, inside);
    assert.deepEqual(JSON.parse(stopWith(dir, envIn, S2)), BLOCK);
    assert.deepEqual(JSON.parse(stopWith(dir, envIn, S2)), BLOCK, `nothing recorded inside the repo: ${inside}`);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all', '--ignored'), '?? code.js\n');
  }
}));

test('without CLAUDE_PLUGIN_DATA the state stays under os.tmpdir()/<the legacy dir> while only that dir exists', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const tmp = join(home, 'tmp');
  mkdirSync(join(tmp, BRAND.legacy.dir), { recursive: true });
  const env = { ...dataEnv(home, null), TMPDIR: tmp };
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.equal(stopWith(dir, env, S1), '', 'the block recorded under the legacy dir lets the turn end');
  assert.match(JSON.parse(readFileSync(join(tmp, BRAND.legacy.dir, 'stop', 'sess-1.json'), 'utf8')).fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(tmp), [BRAND.legacy.dir]);
}));

test('local mode without git hooks: the dedupe applies after the hookless rule decides to block', () => withRepo((dir, home) => {
  const t = localRepo(dir, { progress: TEMPLATE });
  writeState(t, progressHash(t));
  git(dir, 'config', 'core.hooksPath', '.husky/_');
  const env = dataEnv(home);
  const ct = Number(git(dir, 'log', '-1', '--format=%ct').trim());
  writeFileSync(join(dir, 'code.js'), '1');
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), { decision: 'block', reason: localHooklessReason(t) });
  assert.equal(stopWith(dir, env, S1), '');
  writeFileSync(t.progress, withEntry(TEMPLATE, 'One'));
  touch(t.progress, (ct + 10) * 1000);
  assert.equal(stopWith(dir, env, S1), '', 'an entry newer than HEAD passes as today');
  git(dir, 'add', 'code.js');
  commitAt(dir, ct + 20, 'one');
  writeFileSync(join(dir, 'two.js'), '2');
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), { decision: 'block', reason: localHooklessReason(t) }, 're-armed');
  assert.equal(stopWith(dir, env, S1), '');
}));

// ---- T15 fix 1: writing a state file prunes the stop/ dir ----

const DAY_MS = 24 * 60 * 60 * 1000;

test('recording a block prunes state files older than 7 days and keeps fresh ones', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const stop = join(home, 'plugin-data', 'stop');
  mkdirSync(stop, { recursive: true });
  const old = join(stop, 'old-session.json');
  const fresh = join(stop, 'fresh-session.json');
  writeFileSync(old, '{"fingerprint":"x","blockedAt":"2026-01-01T00:00:00.000Z"}\n');
  writeFileSync(fresh, '{"fingerprint":"y","blockedAt":"2026-01-01T00:00:00.000Z"}\n');
  touch(old, Date.now() - 8 * DAY_MS);
  touch(fresh, Date.now() - 6 * DAY_MS);
  assert.deepEqual(JSON.parse(stopWith(dir, dataEnv(home), S1)), BLOCK);
  assert.deepEqual(readdirSync(stop).sort(), ['fresh-session.json', 'sess-1.json']);
}));

test('a pruning error is ignored and never changes the block decision', () => withRepo((dir, home) => {
  committedRepo(dir);
  writeFileSync(join(dir, 'code.js'), '1');
  const stop = join(home, 'plugin-data', 'stop');
  const stuck = join(stop, 'a-stuck.json'); // a non-empty directory: removing it as a file fails
  mkdirSync(stuck, { recursive: true });
  writeFileSync(join(stuck, 'inner'), 'x');
  touch(stuck, Date.now() - 8 * DAY_MS);
  const old = join(stop, 'z-old.json');
  writeFileSync(old, '{}\n');
  touch(old, Date.now() - 8 * DAY_MS);
  const env = dataEnv(home);
  assert.deepEqual(JSON.parse(stopWith(dir, env, S1)), BLOCK);
  assert.deepEqual(readdirSync(stop).sort(), ['a-stuck.json', 'sess-1.json'], 'the other old file is still pruned');
  assert.equal(stopWith(dir, env, S1), '', 'the block was recorded despite the error');
}));

// ---- session-start --budget (spec Addendum F.3): the caller's room for the gate's context ----

const spawnBudget = (cwd, home, args) => spawnSync('node', [GATE, 'session-start', ...args], {
  cwd, input: JSON.stringify({ cwd }), encoding: 'utf8', env: hookEnv(home),
});
const budgetRun = (cwd, home, args) => {
  const r = spawnBudget(cwd, home, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const BIG_STATUS = `# Status\n${'a line of status that keeps going\n'.repeat(1_000)}`;

test('sessionContext fits a given cap, trimming status.md first', () => {
  const wrapped = (ctx) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
  const args = { tracking: COMMITTED, status: BIG_STATUS, progress: ENTRY, activeLines: ['a: 0/1 done · in progress: none · next: T1'] };
  const ctx = sessionContext({ ...args, cap: 3000 });
  assert.ok(wrapped(ctx).length < 3000, `${wrapped(ctx).length}`);
  assert.ok(wrapped(ctx).length > 3000 - 200, 'status fills the room it has');
  assert.match(ctx, /\[status\.md truncated: read the full file\]/);
  assert.match(ctx, /## 2026-09-27 — First/);
  assert.match(ctx, /=== Active plans ===/);
  assert.equal(sessionContext(args), sessionContext({ ...args, cap: OUTPUT_CAP }), 'the default cap is 9,500');
});

test('gate --budget 3000 fits the context into 3000 characters; invalid budgets keep the default cap', () => withRepo((dir, home) => {
  committedRepo(dir, { status: BIG_STATUS });
  const plain = budgetRun(dir, home, []);
  assert.ok(context(plain).length > 3000, 'the default output is larger than the budget');
  const small = context(budgetRun(dir, home, ['--budget', '3000']));
  assert.ok(small.length <= 3000, `${small.length}`);
  assert.match(small, /\[status\.md truncated: read the full file\]/);
  assert.match(small, /## 2026-09-27 — First/);
  for (const bad of ['abc', '20000', '999', '9501', '3000.5', '-3000', '']) {
    assert.equal(budgetRun(dir, home, ['--budget', bad]), plain, `--budget ${bad}`);
  }
  assert.equal(budgetRun(dir, home, ['--budget']), plain, '--budget without a value');
  assert.ok(context(budgetRun(dir, home, ['--budget', '1000'])).length <= 1000);
  assert.equal(budgetRun(dir, home, ['--budget', '9500']), plain);
}));
