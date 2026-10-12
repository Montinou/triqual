// Synthetic tracking histories for the import tests (plan tracking-store-1 T4), built at test time in a temp dir. Every
// name, title and path is made up; nothing is copied from a real repository.
//
// buildHistory(dir, { unparsed }) makes a committed-mode repository whose progress.md history has:
//   c1      2026-01-01  Alpha (plus status.md, a plan and its ledger)
//   c2      2026-01-02  Bravo
//   cu      2026-01-02  (unparsed only) Spanish-fields and missing-Verification entries
//   s1      2026-01-03  Charlie, on branch `side`
//   m1      2026-01-04  Delta, on main
//   merge   2026-01-05  `side` merged with a conflict; the resolution adds Echo (a `++` line) and keeps Charlie and
//                       Delta (`+ ` and ` +` lines of the combined diff)
//   x1      2026-01-06  Foxtrot, a ledger move and a status change, on branch `extra` (never merged)
//   working tree        Golf on top, not committed
// buildLocal(dir) makes a local-mode repository (tracking files under <git dir>/methodology).
// buildTreesame(dir) makes a history where `side` adds Hotel first and main adds the same line later, so their merge
// is TREESAME to both parents (git log's default simplification would follow main only and hide side's commit).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const HEADER = '# Progress\n\nAppend-only log, newest on top.\n\n';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// One entry in the CLAUDE.md format. `fields` overrides or removes (value null) a field; `names` renames bullets.
export function entry(date, title, { fields = {}, names = {} } = {}) {
  const base = {
    'Stage/task': `Plan sample · T1`,
    Done: `did ${title.toLowerCase()}`,
    Files: 'src/a.mjs',
    Verification: 'npm test passed',
    Commit: 'this commit',
    Next: 'the next step',
    ...fields,
  };
  const bullets = Object.entries(base).filter(([, v]) => v !== null).map(([k, v]) => `- **${names[k] ?? k}:** ${v}`);
  return `## ${date} — ${title}\n${bullets.join('\n')}\n`;
}

export const HEADINGS = {
  alpha: '## 2026-01-01 — Alpha',
  bravo: '## 2026-01-02 — Bravo',
  spanish: '## 2026-01-02 — Entrada en castellano',
  noVerification: '## 2026-01-02 — No verification',
  charlie: '## 2026-01-03 — Charlie',
  delta: '## 2026-01-04 — Delta',
  echo: '## 2026-01-05 — Echo',
  foxtrot: '## 2026-01-06 — Foxtrot',
  golf: '## 2026-01-07 — Golf',
};

export const ENTRIES = {
  alpha: entry('2026-01-01', 'Alpha'),
  bravo: entry('2026-01-02', 'Bravo'),
  spanish: entry('2026-01-02', 'Entrada en castellano', {
    names: { 'Stage/task': 'Etapa/tarea', Done: 'Hecho', Files: 'Archivos', Verification: 'Verificación', Next: 'Siguiente' },
  }),
  noVerification: entry('2026-01-02', 'No verification', { fields: { Verification: null } }),
  charlie: entry('2026-01-03', 'Charlie'),
  delta: entry('2026-01-04', 'Delta'),
  echo: entry('2026-01-05', 'Echo'),
  foxtrot: entry('2026-01-06', 'Foxtrot'),
  golf: entry('2026-01-07', 'Golf'),
};

// progress.md holding these entries (newest first), each followed by a blank line.
export const progressOf = (...entries) => HEADER + entries.map((e) => `${e}\n`).join('');

export const STATUS = '# Status\n\nIntro line.\n\n## Now\n\nWorking on the sample plan.\n\n## Risks\n\nNone yet.\n';
const STATUS_EXTRA = '# Status\n\nIntro line.\n\n## Now\n\nWorking on the extra branch.\n\n## Risks\n\nNone yet.\n';
const PLAN = '# Sample plan\n\n### Task 1: First thing\n\n### Task 2: Second thing\n\n**Depends on:** T1\n';

const task = (id, title, deps, history) => ({
  id, title, status: history.at(-1).to, deps, skills: [], role: null, commits: [], reason: null, history,
});
const ev = (at, from, to) => ({ at, from, to, note: null });
const ledger = (tasks) => ({
  version: 1, plan: 'docs/plans/2026-01-01-sample.md', spec: null, branch: 'main', state: 'active', tasks,
});
export const LEDGER = ledger([
  task('T1', 'First thing', [], [ev('2026-01-01T10:00:00Z', null, 'pending')]),
  task('T2', 'Second thing', ['T1'], [ev('2026-01-01T10:00:00Z', null, 'pending')]),
]);
// The `extra` branch starts T1 later than anything on main.
export const LEDGER_EXTRA = ledger([
  task('T1', 'First thing', [], [ev('2026-01-01T10:00:00Z', null, 'pending'), ev('2026-01-06T09:00:00Z', 'pending', 'in_progress')]),
  task('T2', 'Second thing', ['T1'], [ev('2026-01-01T10:00:00Z', null, 'pending')]),
]);
export const LEDGER_PATH = 'docs/plans/2026-01-01-sample.tasks.json';

function makeGit(repo) {
  return (args, { date, allowFail = false } = {}) => {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
    if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    try {
      return execFileSync('git', [...ID, ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      if (allowFail) return null;
      throw err;
    }
  };
}

export function buildHistory(dir, { unparsed = false } = {}) {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  const git = makeGit(repo);
  const write = (rel, text) => writeFileSync(join(repo, rel), text);
  const commit = (message, date) => {
    git(['add', '-A'], { date });
    git(['commit', '-qm', message], { date });
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  const shas = {};

  write('progress.md', progressOf(ENTRIES.alpha));
  write('status.md', STATUS);
  write('docs/plans/2026-01-01-sample.md', PLAN);
  write(LEDGER_PATH, `${JSON.stringify(LEDGER, null, 2)}\n`);
  shas.c1 = commit('first', '2026-01-01T10:00:00Z');

  let older = [ENTRIES.bravo, ENTRIES.alpha];
  write('progress.md', progressOf(...older));
  shas.c2 = commit('second', '2026-01-02T10:00:00Z');
  if (unparsed) {
    older = [ENTRIES.noVerification, ENTRIES.spanish, ...older];
    write('progress.md', progressOf(...older));
    shas.cu = commit('unparsed ones', '2026-01-02T12:00:00Z');
  }

  git(['checkout', '-qb', 'side']);
  write('progress.md', progressOf(ENTRIES.charlie, ...older));
  shas.s1 = commit('side work', '2026-01-03T10:00:00Z');

  git(['checkout', '-q', 'main']);
  write('progress.md', progressOf(ENTRIES.delta, ...older));
  shas.m1 = commit('main work', '2026-01-04T10:00:00Z');

  const date = '2026-01-05T10:00:00Z';
  // Both branches added an entry at the top: the merge conflicts, and its resolution adds a new entry of its own.
  const conflicted = git(['merge', '--no-ff', '--no-commit', 'side'], { date, allowFail: true });
  if (conflicted !== null) throw new Error('the fixture merge was expected to conflict');
  write('progress.md', progressOf(ENTRIES.echo, ENTRIES.delta, ENTRIES.charlie, ...older));
  shas.merge = commit('merge side', date);

  git(['checkout', '-qb', 'extra']);
  write('progress.md', progressOf(ENTRIES.foxtrot, ENTRIES.echo, ENTRIES.delta, ENTRIES.charlie, ...older));
  write('status.md', STATUS_EXTRA);
  write(LEDGER_PATH, `${JSON.stringify(LEDGER_EXTRA, null, 2)}\n`);
  shas.x1 = commit('extra work', '2026-01-06T10:00:00Z');
  git(['checkout', '-q', 'main']);

  // The newest entry is written but not committed.
  write('progress.md', progressOf(ENTRIES.golf, ENTRIES.echo, ENTRIES.delta, ENTRIES.charlie, ...older));
  const gitDir = realpathSync(join(repo, '.git'));
  return { repo, git, shas, gitDir, commit };
}

// A local-mode repository: one commit, progress.md (two entries) and state.json under <git dir>/methodology, the
// state recording the current progress.md as the last gated one. addTop() writes a newer entry on top.
export function buildLocal(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = makeGit(repo);
  git(['init', '-q']);
  writeFileSync(join(repo, 'README.md'), '# sample\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'initial'], { date: '2026-01-01T10:00:00Z' });
  const local = join(repo, '.git', 'methodology');
  mkdirSync(local, { recursive: true });
  const progress = join(local, 'progress.md');
  writeFileSync(progress, progressOf(ENTRIES.bravo, ENTRIES.alpha));
  const state = { version: 1, lastProgressSha256: sha256(readFileSync(progress)), pendingProgressSha256: null };
  writeFileSync(join(local, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const addTop = () => writeFileSync(progress, progressOf(ENTRIES.charlie, ENTRIES.bravo, ENTRIES.alpha));
  // A gated commit as the local pre-commit and post-commit record it: the current progress.md becomes the last seen.
  const gate = () => {
    const next = { ...state, lastProgressSha256: sha256(readFileSync(progress)) };
    writeFileSync(join(local, 'state.json'), `${JSON.stringify(next, null, 2)}\n`);
  };
  return { repo, git, local, progress, addTop, gate, gitDir: realpathSync(join(repo, '.git')) };
}

export const HOTEL = entry('2026-01-02', 'Hotel');

export function buildTreesame(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = makeGit(repo);
  const commit = (message, date) => {
    git(['add', '-A'], { date });
    git(['commit', '-qm', message], { date });
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  const shas = {};
  writeFileSync(join(repo, 'progress.md'), progressOf(ENTRIES.alpha));
  shas.c1 = commit('first', '2026-01-01T10:00:00Z');
  git(['checkout', '-qb', 'side']);
  writeFileSync(join(repo, 'progress.md'), progressOf(HOTEL, ENTRIES.alpha));
  shas.s1 = commit('side adds hotel', '2026-01-02T10:00:00Z');
  git(['checkout', '-q', 'main']);
  writeFileSync(join(repo, 'progress.md'), progressOf(HOTEL, ENTRIES.alpha));
  shas.m1 = commit('main adds the same hotel', '2026-01-03T10:00:00Z');
  const date = '2026-01-04T10:00:00Z';
  git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], { date });
  shas.merge = git(['rev-parse', 'HEAD']);
  return { repo, git, shas };
}
