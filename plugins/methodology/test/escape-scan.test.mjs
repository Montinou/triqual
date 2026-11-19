import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/role-eval.mjs';

// Every text below is invented. A world is a temp git repo (default branch main) with one closed task whose commit
// touches a.txt, a fake `triqual` that prints a tasks snapshot, a fake `gh` that prints canned runs, and a temp store.
const T0 = '2026-10-01T10:00:00Z';
const DONE_AT = Date.parse('2026-10-01T12:00:00Z');
const day = (n) => new Date(Date.parse(T0) + n * 86400000).toISOString();
const SHA_A = 'deadbeef'.repeat(5);
const SHA_B = 'cafebabe'.repeat(5);
const SHA_C = '0123abcd'.repeat(5);

function git(repo, args, date) {
  const env = {
    PATH: process.env.PATH, HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
}

function commit(repo, file, message, date) {
  writeFileSync(join(repo, file), `${message}\n${date}\n`);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', message], date);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// `runs` is what the fake gh prints; null leaves gh out of PATH. `tasks` overrides the closed task.
// `build(repo)` replaces the default history (the task commit straight on main) and returns the task's commit sha.
async function withWorld(fn, { runs = [], gh = true, task = {}, build = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-escape-scan-')));
  try {
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    mkdirSync(repo);
    mkdirSync(bin);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    let taskSha;
    if (build) {
      taskSha = build(repo);
    } else {
      taskSha = commit(repo, 'a.txt', 'feat: the parser', T0);
      commit(repo, 'b.txt', 'feat: the printer', day(0.2));
    }

    const snapshot = [{
      repo: { name: 'repo', root: repo },
      plans: [{
        name: 'demo-plan', state: 'done', done: 1, total: 1,
        tasks: [{
          id: 'T1', title: 'parser', status: 'done', since: DONE_AT, effectiveTier: 'heavy', tier: 'heavy', commits: [taskSha],
          ...task,
        }],
      }],
    }];
    writeFileSync(join(root, 'tasks.json'), JSON.stringify(snapshot));
    script(join(bin, 'triqual'), `[ "$*" = "tasks export --json --all" ] || exit 9\n/bin/cat '${join(root, 'tasks.json')}'`);
    if (gh) {
      writeFileSync(join(root, 'runs.json'), JSON.stringify(runs));
      script(join(bin, 'gh'), `echo "$*" >> '${join(root, 'gh.log')}'\n/bin/cat '${join(root, 'runs.json')}'`);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ROLE_EVAL_FILE: join(root, 'store', 'comparisons.jsonl') };
    await fn({ root, repo, taskSha, env, store: env.ROLE_EVAL_FILE, ghLog: join(root, 'gh.log') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(argv, { env, cwd }) {
  let out = '';
  let err = '';
  const code = main(argv, { env, cwd, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const stored = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const bySource = (records) => records.toSorted((a, b) => a.source.localeCompare(b.source));

// A planted revert of the task's commit (day 2) and a planted fix on its file (day 3).
function plant(w, { fixFile = 'a.txt', fixDay = 3 } = {}) {
  git(w.repo, ['revert', '--no-edit', w.taskSha], day(2));
  const revert = git(w.repo, ['rev-parse', 'HEAD']).trim();
  const fix = commit(w.repo, fixFile, 'fix(parser): handle the empty input', day(fixDay));
  return { revert, fix };
}

test('escapes scan finds the planted revert and fix commit and records each once', () => withWorld((w) => {
  const { revert, fix } = plant(w);
  const first = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out, '2 new\n');
  const records = bySource(stored(w.store));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => [r.kind, r.v, r.source, r.ref, r.plan, r.task, r.tier]), [
    ['escape', 2, 'post-merge-fix', fix, 'demo-plan.md', 'T1', 'heavy'],
    ['escape', 2, 'revert', revert, 'demo-plan.md', 'T1', 'heavy'],
  ]);
  assert.equal(records[0].at, new Date(day(3)).toISOString());
  const second = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(second.code, 0, second.err);
  assert.equal(second.out, '0 new\n');
  assert.equal(stored(w.store).length, 2);
}));

test('a fix commit after 14 days is ignored', () => withWorld((w) => {
  const { fix } = plant(w, { fixDay: 20 });
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1 new\n'); // only the revert
  assert.deepEqual(stored(w.store).map((x) => x.source), ['revert']);
  assert.ok(!stored(w.store).some((x) => x.ref === fix));
}));

test('a fix commit on another file is ignored', () => withWorld((w) => {
  commit(w.repo, 'c.txt', 'fix(other): something else', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '0 new\n');
  assert.deepEqual(stored(w.store), []);
}));

test('a fix commit that belongs to another task of the same plan is a planned change, not an escape', () => withWorld((w) => {
  const fix = commit(w.repo, 'a.txt', 'fix(parser): handle the empty input', day(3));
  const snapshot = JSON.parse(readFileSync(join(w.root, 'tasks.json'), 'utf8'));
  snapshot[0].plans[0].tasks.push({
    id: 'T2', title: 'parser fix', status: 'done', since: Date.parse(day(3)) + 3600000, effectiveTier: 'heavy', tier: 'heavy', commits: [fix],
  });
  snapshot[0].plans[0].total = 2;
  snapshot[0].plans[0].done = 2;
  writeFileSync(join(w.root, 'tasks.json'), JSON.stringify(snapshot));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '0 new\n');
  assert.deepEqual(stored(w.store), []);
}));

test('a commit that does not start with fix( or fix: is ignored even on the task\'s file', () => withWorld((w) => {
  commit(w.repo, 'a.txt', 'feat(parser): fixes nothing, extends it', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.out, '0 new\n');
}));

test('red CI after merge is recorded once per plan and sha; runs outside the window are ignored', () => withWorld((w) => {
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1 new\n');
  assert.deepEqual(stored(w.store).map((x) => [x.kind, x.source, x.ref, x.plan, x.task]), [
    ['escape', 'red-ci', SHA_A, 'demo-plan.md', undefined],
  ]);
  const log = readFileSync(w.ghLog, 'utf8');
  assert.match(log, /run list --branch main --status failure --json headSha,createdAt/);
  assert.equal(run(['escapes', 'scan'], { env: w.env, cwd: w.repo }).out, '0 new\n');
}, {
  // two failing workflows on one sha, one run past the window, one before the plan's last task closed.
  runs: [
    { headSha: SHA_A, createdAt: day(1) }, { headSha: SHA_A, createdAt: day(1.1) },
    { headSha: SHA_B, createdAt: day(30) }, { headSha: SHA_C, createdAt: day(-5) },
  ],
}));

test('no gh: git escapes are still recorded and one stderr line says red CI was skipped', () => withWorld((w) => {
  const { revert, fix } = plant(w);
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0);
  assert.equal(r.out, '2 new\n');
  assert.deepEqual(stored(w.store).map((x) => x.ref).sort(), [fix, revert].sort());
  assert.equal(r.err.trim().split('\n').length, 1);
  assert.match(r.err, /gh/);
}, { gh: false }));

test('--since drops the escapes dated before it', () => withWorld((w) => {
  plant(w);
  const r = run(['escapes', 'scan', '--since', day(3).slice(0, 10)], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1 new\n'); // the fix on day 3; the revert (day 2) is before
  assert.deepEqual(stored(w.store).map((x) => x.source), ['post-merge-fix']);
}));

test('a task that is not done is not scanned', () => withWorld((w) => {
  plant(w);
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.out, '0 new\n');
}, { task: { status: 'in_progress' } }));

test('output carries counts only, never commit text', () => withWorld((w) => {
  plant(w);
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.doesNotMatch(r.out + r.err, /parser|empty input/);
}));

test('escapes scan: usage errors exit 2', () => withWorld((w) => {
  for (const argv of [['escapes'], ['escapes', 'nope'], ['escapes', 'scan', '--since', '2026-02-30'], ['escapes', 'scan', 'extra']]) {
    const r = run(argv, { env: w.env, cwd: w.repo });
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.deepEqual(stored(w.store), []);
}));

// A phase branch: the task commit and a review-fix commit on it, merged into main by a merge commit.
const phaseBranch = (repo, { merge }) => {
  commit(repo, 'base.txt', 'chore: base', day(-1));
  git(repo, ['checkout', '-q', '-b', 'phase']);
  const taskSha = commit(repo, 'a.txt', 'feat: the parser', T0);
  commit(repo, 'a.txt', 'fix(parser): phase review round 1', day(0.1));
  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'other.txt', 'chore: unrelated work on main', day(0.2));
  if (merge) git(repo, ['merge', '--no-ff', '-q', '-m', 'merge: the phase', 'phase'], day(0.3));
  return taskSha;
};

test('a review fix merged with the task is not an escape; a fix after the merge is, once', () => withWorld((w) => {
  const fix = commit(w.repo, 'a.txt', 'fix(parser): handle the empty input', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1 new\n');
  assert.deepEqual(stored(w.store).map((x) => [x.source, x.ref]), [['post-merge-fix', fix]]);
}, { build: (repo) => phaseBranch(repo, { merge: true }) }));

test('a task whose commit is not on the default branch yet records nothing', () => withWorld((w) => {
  commit(w.repo, 'a.txt', 'fix(parser): a fix on main that touches the same file', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '0 new\n');
  assert.deepEqual(stored(w.store), []);
}, { build: (repo) => phaseBranch(repo, { merge: false }) }));

// Several files in one commit (paths may sit in subdirectories).
function commitFiles(repo, files, message, date) {
  for (const file of files) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), `${message}\n${date}\n`);
    git(repo, ['add', file]);
  }
  git(repo, ['commit', '-q', '-m', message], date);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

// Replaces the snapshot's plans with `plans`: { name: sha } (one done task T1 per plan, closed after its commit).
function setPlans(w, plans) {
  const snapshot = JSON.parse(readFileSync(join(w.root, 'tasks.json'), 'utf8'));
  snapshot[0].plans = Object.entries(plans).map(([name, sha]) => ({
    name, state: 'done', done: 1, total: 1,
    tasks: [{ id: 'T1', title: name, status: 'done', since: DONE_AT, effectiveTier: 'heavy', tier: 'heavy', commits: [sha] }],
  }));
  writeFileSync(join(w.root, 'tasks.json'), JSON.stringify(snapshot));
}

const escapesOf = (w) => stored(w.store).map((r) => [r.source, r.ref, r.plan, r.task]);

test('a fix that touches only shared release files is no escape, even when the task touched them too', () => withWorld((w) => {
  commitFiles(w.repo, ['README.md', 'plugins/x/.claude-plugin/plugin.json', 'CHANGELOG.md'], 'fix(release): bump the version', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '0 new\n');
  assert.deepEqual(stored(w.store), []);
}, { build: (repo) => commitFiles(repo, ['a.txt', 'README.md', 'plugins/x/.claude-plugin/plugin.json', 'CHANGELOG.md'], 'feat: the parser', T0) }));

test('a fix that touches a shared file and the task\'s real file is still an escape', () => withWorld((w) => {
  const fix = commitFiles(w.repo, ['CHANGELOG.md', 'a.txt'], 'fix(parser): handle the empty input', day(3));
  const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1 new\n');
  assert.deepEqual(escapesOf(w), [['post-merge-fix', fix, 'demo-plan.md', 'T1']]);
}, { build: (repo) => commitFiles(repo, ['a.txt', 'CHANGELOG.md'], 'feat: the parser', T0) }));

// Two plans whose tasks shipped on main one after the other; `shas` collects their commits.
const twoPlanWorld = (shas, { first, second }) => (repo) => {
  shas.first = commitFiles(repo, first, 'feat: first plan work', T0);
  shas.second = commitFiles(repo, second, 'feat: second plan work', day(0.2));
  return shas.first;
};

test('a fix overlapping tasks of two plans is one record, assigned to the larger overlap', () => {
  const shas = {};
  return withWorld((w) => {
    // a-plan overlaps on one file, b-plan on two: b-plan wins although a-plan sorts first.
    setPlans(w, { 'a-plan': shas.first, 'b-plan': shas.second });
    const fix = commitFiles(w.repo, ['x.txt', 'y.txt'], 'fix(parser): handle the empty input', day(3));
    const r = run(['escapes', 'scan'], { env: w.env, cwd: w.repo });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '1 new\n');
    assert.deepEqual(escapesOf(w), [['post-merge-fix', fix, 'b-plan.md', 'T1']]);
  }, { build: twoPlanWorld(shas, { first: ['x.txt'], second: ['x.txt', 'y.txt'] }) });
});

test('a tie on overlap goes to the task that shipped latest', () => {
  const shas = {};
  return withWorld((w) => {
    // equal overlap: b-plan shipped later, so it wins over the earlier a-plan.
    setPlans(w, { 'a-plan': shas.first, 'b-plan': shas.second });
    const fix = commitFiles(w.repo, ['x.txt'], 'fix(parser): handle the empty input', day(3));
    assert.equal(run(['escapes', 'scan'], { env: w.env, cwd: w.repo }).out, '1 new\n');
    assert.deepEqual(escapesOf(w), [['post-merge-fix', fix, 'b-plan.md', 'T1']]);
  }, { build: twoPlanWorld(shas, { first: ['x.txt'], second: ['x.txt'] }) });
});

test('a full tie (same ship point and overlap) goes to the first plan name, then the first task id', () => withWorld((w) => {
  const snapshot = JSON.parse(readFileSync(join(w.root, 'tasks.json'), 'utf8'));
  const task = (id) => ({ id, title: id, status: 'done', since: DONE_AT, effectiveTier: 'heavy', tier: 'heavy', commits: [w.taskSha] });
  snapshot[0].plans = [
    { name: 'b-plan', state: 'done', done: 1, total: 1, tasks: [task('T1')] },
    { name: 'a-plan', state: 'done', done: 2, total: 2, tasks: [task('T2'), task('T1')] },
  ];
  writeFileSync(join(w.root, 'tasks.json'), JSON.stringify(snapshot));
  const fix = commitFiles(w.repo, ['x.txt'], 'fix(parser): handle the empty input', day(3));
  assert.equal(run(['escapes', 'scan'], { env: w.env, cwd: w.repo }).out, '1 new\n');
  assert.deepEqual(escapesOf(w), [['post-merge-fix', fix, 'a-plan.md', 'T1']]);
}, { build: (repo) => commitFiles(repo, ['x.txt'], 'feat: shared work', T0) }));

test('a revert of commits of two plans keeps one record per task', () => {
  const shas = {};
  return withWorld((w) => {
    setPlans(w, { 'a-plan': shas.first, 'b-plan': shas.second });
    git(w.repo, ['revert', '--no-edit', '-n', shas.second, shas.first], day(2));
    git(w.repo, ['commit', '-q', '-m', `Revert both\n\nThis reverts commit ${shas.first}.\n\nThis reverts commit ${shas.second}.`], day(2));
    const revert = git(w.repo, ['rev-parse', 'HEAD']).trim();
    assert.equal(run(['escapes', 'scan'], { env: w.env, cwd: w.repo }).out, '2 new\n');
    assert.deepEqual(escapesOf(w).toSorted(), [['revert', revert, 'a-plan.md', 'T1'], ['revert', revert, 'b-plan.md', 'T1']]);
  }, { build: twoPlanWorld(shas, { first: ['x.txt'], second: ['y.txt'] }) });
});
