// `triqual tracking import` (plan tracking-store-1 T4): the heading → first-commit resolution and the import of a
// committed or local repository's tracking files into the store. Histories come from fixtures/progress-history.mjs,
// built in a temp dir; TRIQUAL_TRACKING_DB always points into that dir and HOME is a temp one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, headingCommits, importRecords, parseHeadingLog, splitEntries } from '../lib/store-import.mjs';
import { transition } from '../lib/ledger.mjs';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { BRAND } from '../lib/brand.mjs';
import {
  buildHistory, buildLocal, buildTreesame, ENTRIES, HEADINGS, HOTEL, LEDGER_PATH, progressOf, sha256, STATUS,
} from './fixtures/progress-history.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tracking.mjs');

await loadSqlite();

const cleanEnv = (home, extra) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    `${BRAND.envPrefix}REGISTRY_DIR`, `${BRAND.legacy.envPrefix}REGISTRY_DIR`]) delete env[k];
  return { ...env, ...extra };
};

// A temp dir with a HOME and a store path; fn gets the dir, the CLI runner (cwd = the repo) and store readers.
function withTemp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-import-')));
  const home = join(dir, 'home');
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') };
  const run = (repo, args, env = dbEnv) => spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo, env: cleanEnv(home, env), encoding: 'utf8',
  });
  const inStore = (fn2, env = dbEnv) => {
    const store = openStore({ home, env });
    try { return fn2(store); } finally { store.close(); }
  };
  const entries = (env) => inStore((s) => s.all('SELECT * FROM entries ORDER BY id'), env);
  const count = (table, env) => inStore((s) => s.get(`SELECT COUNT(*) AS n FROM ${table}`).n, env);
  try {
    return fn({ dir, home, dbEnv, run, inStore, entries, count });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exit = (r, code) => assert.equal(r.status, code, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
const byTitle = (rows) => new Map(rows.map((r) => [r.title, r]));
const textOf = (e) => e.trimEnd();

// ---- The log parser and headingCommits ----

test('parseHeadingLog: a merge counts only lines added against every parent, and the first commit wins', () => {
  const log = [
    '\0aaa 2026-01-01 ',
    '',
    'diff --git a/progress.md b/progress.md',
    '--- /dev/null',
    '+++ b/progress.md',
    '@@ -0,0 +1,2 @@',
    '+# Progress',
    '+## 2026-01-01 — One',
    '\0bbb 2026-01-02 aaa ccc',
    '',
    'diff --cc progress.md',
    '--- a/progress.md',
    '+++ b/progress.md',
    '@@@ -1,1 -1,1 +1,3 @@@',
    '++## 2026-01-02 — Made in the merge',
    '+ ## 2026-01-01 — From the second parent',
    ' +## 2026-01-01 — From the first parent',
    '++## 2026-01-01 — One',
    '\0ddd 2026-01-03 bbb',
    '',
    'diff --git a/progress.md b/progress.md',
    '+++ b/progress.md',
    '@@ -1,0 +2,1 @@',
    '+## 2026-01-01 — From the second parent',
  ].join('\n');
  const { commits, dates } = parseHeadingLog(log);
  assert.deepEqual([...commits], [
    ['## 2026-01-01 — One', 'aaa'],
    ['## 2026-01-02 — Made in the merge', 'bbb'],
    ['## 2026-01-01 — From the second parent', 'ddd'],
  ]);
  assert.equal(dates.get('bbb'), '2026-01-02');
});

test('headingCommits maps every committed heading to the first commit that added it, merges through ++ only', () => withTemp(({ dir }) => {
  const { repo, shas } = buildHistory(dir);
  const map = headingCommits(repo);
  assert.equal(map.get(HEADINGS.alpha), shas.c1);
  assert.equal(map.get(HEADINGS.bravo), shas.c2);
  assert.equal(map.get(HEADINGS.charlie), shas.s1, 'a heading in the merge\'s combined diff keeps its first commit');
  assert.equal(map.get(HEADINGS.delta), shas.m1);
  assert.equal(map.get(HEADINGS.echo), shas.merge, 'a heading created by the merge resolution is the merge\'s');
  assert.equal(map.has(HEADINGS.golf), false, 'the uncommitted entry has no commit');
  assert.equal(map.has(HEADINGS.foxtrot), false, 'another branch is not read without its ref');
  assert.equal(headingCommits(repo, 'extra').get(HEADINGS.foxtrot), shas.x1);
}));

test('splitEntries cuts progress.md at each "## " heading, the header left out', () => {
  const text = `# Progress\n\nintro\n\n${ENTRIES.bravo}\n${ENTRIES.alpha}\n`;
  assert.deepEqual(splitEntries(text).map((e) => e.heading), [HEADINGS.bravo, HEADINGS.alpha]);
  assert.equal(splitEntries(text)[0].text, textOf(ENTRIES.bravo));
});

// ---- Import of a committed repository ----

test('import: committed headings get their first commit, the uncommitted top one is pending, oldest first', () => withTemp(({ dir, run, entries, count }) => {
  const { repo, shas, gitDir } = buildHistory(dir);
  const r = run(repo, ['import']);
  exit(r, 0);
  assert.match(r.stdout, /6 entries added \(committed 5, pending 1, unresolved 0, unparsed 0\)/);
  const rows = entries();
  assert.deepEqual(rows.map((e) => e.title), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Golf']);
  const t = byTitle(rows);
  const expected = { Alpha: shas.c1, Bravo: shas.c2, Charlie: shas.s1, Delta: shas.m1, Echo: shas.merge };
  for (const [title, sha] of Object.entries(expected)) {
    assert.equal(t.get(title).state, 'committed', title);
    assert.equal(t.get(title).commit_sha, sha, title);
  }
  assert.equal(t.get('Golf').state, 'pending');
  assert.equal(t.get('Golf').commit_sha, null);
  assert.equal(t.get('Golf').git_dir, gitDir, 'pending under this worktree\'s git dir');
  // created_at is a full UTC timestamp: the heading commit's author date, else the heading date at 00:00 local time.
  const authored = {
    alpha: '2026-01-01T10:00:00.000Z', bravo: '2026-01-02T10:00:00.000Z', charlie: '2026-01-03T10:00:00.000Z',
    delta: '2026-01-04T10:00:00.000Z', echo: '2026-01-05T10:00:00.000Z', golf: new Date(2026, 0, 7).toISOString(),
  };
  for (const key of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'golf']) {
    const row = rows.find((e) => e.original === textOf(ENTRIES[key]));
    assert.ok(row, key);
    assert.equal(row.created_at, authored[key], 'created_at is the heading commit\'s author date, or the heading date at 00:00 local');
    assert.equal(row.entry_date, HEADINGS[key].slice(3, 13), 'entry_date is the heading date');
    assert.equal(row.import_hash, sha256(row.original));
    assert.equal(row.parse_ok, 1);
    assert.equal(row.stage_task, 'Plan sample · T1');
    assert.equal(row.plan, 'sample');
  }
  assert.equal(count('status'), 3, 'preamble and two sections');
  assert.equal(count('plans'), 1);
  assert.equal(count('tasks'), 2);
  assert.equal(count('task_events'), 2);
}));

test('import: unparsed entries roll the whole import back and exit 1; --accept-unparsed keeps them flagged', () => withTemp(({ dir, run, entries, count }) => {
  const { repo } = buildHistory(dir, { unparsed: true });
  const r = run(repo, ['import']);
  exit(r, 1);
  assert.match(r.stdout, /unparsed 2/);
  assert.match(r.stdout, /Entrada en castellano/);
  assert.match(r.stdout, /No verification.*Verification/);
  assert.match(r.stderr, /--accept-unparsed/);
  assert.equal(entries().length, 0, 'nothing inserted');
  assert.equal(count('status'), 0);
  assert.equal(count('plans'), 0);

  exit(run(repo, ['import', '--accept-unparsed']), 0);
  const t = byTitle(entries());
  assert.equal(t.size, 8);
  for (const [title, key] of [['Entrada en castellano', 'spanish'], ['No verification', 'noVerification']]) {
    const row = t.get(title);
    assert.equal(row.parse_ok, 0, title);
    assert.equal(row.original, textOf(ENTRIES[key]), 'the original text is kept');
    for (const f of ['stage_task', 'done', 'files', 'verification', 'next']) assert.equal(row[f], '', `${title} ${f}`);
    assert.equal(row.created_at, '2026-01-02T12:00:00.000Z', 'the heading commit\'s author date');
    assert.equal(row.entry_date, '2026-01-02');
    assert.equal(row.state, 'committed');
  }
}));

test('import twice adds nothing; a pending entry committed since is promoted', () => withTemp(({ dir, run, entries }) => {
  const { repo, commit } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const again = run(repo, ['import']);
  exit(again, 0);
  assert.match(again.stdout, /0 entries added/);
  assert.match(again.stdout, /0 promoted/);
  const sha = commit('golf', '2026-01-07T10:00:00Z');
  const third = run(repo, ['import']);
  exit(third, 0);
  assert.match(third.stdout, /0 entries added/);
  assert.match(third.stdout, /1 promoted/);
  const golf = byTitle(entries()).get('Golf');
  assert.equal(golf.state, 'committed');
  assert.equal(golf.commit_sha, sha);
  assert.equal(entries().length, 6);
}));

test('import --ref brings in a branch\'s extra entries and its ledger states, and only reports its status', () => withTemp(({ dir, run, entries, inStore }) => {
  const { repo, shas } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const statusBefore = inStore((s) => s.all('SELECT heading, body FROM status ORDER BY position'));
  const r = run(repo, ['import', '--ref', 'extra']);
  exit(r, 0);
  assert.match(r.stdout, /1 entries added \(committed 1/);
  assert.match(r.stdout, /status on extra differs from the store \(not imported\): "Now"/);
  const foxtrot = byTitle(entries()).get('Foxtrot');
  assert.equal(foxtrot.state, 'committed');
  assert.equal(foxtrot.commit_sha, shas.x1);
  assert.equal(foxtrot.branch, 'extra');
  assert.equal(entries().length, 7);
  inStore((s) => {
    assert.deepEqual(s.all('SELECT heading, body FROM status ORDER BY position'), statusBefore, 'status untouched');
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    assert.equal(plan.path, 'docs/plans/2026-01-01-sample.md');
    const ledger = s.ledgerOf(plan.id);
    const t1 = ledger.tasks.find((t) => t.id === 'T1');
    assert.equal(t1.status, 'in_progress', 'the later state from the branch wins');
    assert.deepEqual(t1.history.map((h) => h.to), ['pending', 'in_progress']);
    assert.equal(ledger.tasks.find((t) => t.id === 'T2').status, 'pending');
  });
  const twice = run(repo, ['import', '--ref', 'extra']);
  exit(twice, 0);
  assert.match(twice.stdout, /0 entries added/);
  assert.equal(inStore((s) => s.get('SELECT COUNT(*) AS n FROM task_events').n), 3, 'no event repeated');
}));

test('import --ref on a ledger the store already moved further keeps the store\'s state', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const ledger = s.ledgerOf(plan.id);
    const t1 = ledger.tasks.find((t) => t.id === 'T1');
    t1.history.push({ at: '2026-02-01T00:00:00Z', from: 'pending', to: 'blocked', note: 'waiting' });
    t1.status = 'blocked';
    s.saveLedger(plan.id, ledger);
  });
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    assert.equal(s.ledgerOf(plan.id).tasks.find((t) => t.id === 'T1').status, 'blocked');
  });
}));

test('import --ref of an unknown ref is a usage error, refused before the store is created', () => withTemp(({ dir, dbEnv, run }) => {
  const { repo } = buildHistory(dir);
  const r = run(repo, ['import', '--ref', 'no-such-branch']);
  exit(r, 2);
  assert.match(r.stderr, /no-such-branch/);
  assert.equal(existsSync(dbEnv.TRIQUAL_TRACKING_DB), false);
}));

test('import --replace without --from exits 2 in store mode and leaves the store as it was', () => withTemp(({ dir, run, entries }) => {
  const { repo, git } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  git(['config', '--local', 'triqual.tracking', 'store']);
  const r = run(repo, ['import', '--replace']);
  exit(r, 2);
  assert.match(r.stderr, /--from/);
  assert.equal(entries().length, 6);
  exit(run(repo, ['import', '--from', join(dir, 'x.jsonl')]), 2);
}));

test('import --replace in a committed repository re-imports from the files', () => withTemp(({ dir, run, entries }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const before = entries().map((e) => e.original);
  exit(run(repo, ['import', '--replace']), 0);
  assert.deepEqual(entries().map((e) => e.original), before);
}));

test('import with no tracking files anywhere is refused as not opted in', () => withTemp(({ dir, run }) => {
  const { repo } = buildLocal(dir);
  rmSync(join(repo, '.git', 'methodology'), { recursive: true });
  exit(run(repo, ['import']), 2);
}));

// ---- Import of a local-mode repository ----

test('local mode: every entry is unresolved when progress.md is what the last gated commit saw', () => withTemp(({ dir, run, entries }) => {
  const { repo } = buildLocal(dir);
  exit(run(repo, ['import']), 0);
  const rows = entries();
  assert.deepEqual(rows.map((e) => [e.title, e.state]), [['Alpha', 'unresolved'], ['Bravo', 'unresolved']]);
  assert.ok(rows.every((e) => e.commit_sha === null));
}));

test('local mode: the top entry is pending when progress.md changed since the last gated commit', () => withTemp(({ dir, run, entries }) => {
  const { repo, addTop, gitDir } = buildLocal(dir);
  addTop();
  exit(run(repo, ['import']), 0);
  const rows = entries();
  assert.deepEqual(rows.map((e) => [e.title, e.state]), [['Alpha', 'unresolved'], ['Bravo', 'unresolved'], ['Charlie', 'pending']]);
  assert.equal(rows[2].git_dir, gitDir);
  assert.equal(rows[2].created_at, new Date(2026, 0, 3).toISOString(), 'no commit: the heading date at 00:00 local');
  assert.equal(rows[2].entry_date, '2026-01-03');
}));

test('local mode: --ref is refused, the files are not in git', () => withTemp(({ dir, run }) => {
  const { repo } = buildLocal(dir);
  const r = run(repo, ['import', '--ref', 'HEAD']);
  exit(r, 2);
  assert.match(r.stderr, /local mode/);
}));

test('the import never touches the working tree or the ledger file', () => withTemp(({ dir, run }) => {
  const { repo, git } = buildHistory(dir);
  const before = git(['status', '--porcelain']);
  exit(run(repo, ['import']), 0);
  assert.equal(git(['status', '--porcelain']), before);
  assert.equal(git(['diff', '--stat', '--', LEDGER_PATH]), '');
}));

// ---- Fix round 1: stale drafts, ledger merges, git failures, TREESAME merges ----

test('import: a pending entry edited before its commit leaves one committed row, the stale draft replaced in its place', () => withTemp(({ dir, run, entries }) => {
  const { repo, commit } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const draftId = byTitle(entries()).get('Golf').id;
  const p = join(repo, 'progress.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('did golf', 'did golf, edited'));
  const sha = commit('golf', '2026-01-07T10:00:00Z');
  const r = run(repo, ['import']);
  exit(r, 0);
  const golf = entries().filter((e) => e.title === 'Golf');
  assert.equal(golf.length, 1, 'no stale pending row survives');
  assert.equal(golf[0].state, 'committed');
  assert.equal(golf[0].commit_sha, sha);
  assert.match(golf[0].original, /did golf, edited/);
  assert.equal(golf[0].id, draftId, 'the committed text takes the draft\'s place');
  assert.equal(entries().filter((e) => e.state === 'pending').length, 0);
  assert.match(r.stdout, /1 pending drafts replaced/);
}));

test('import: a pending entry edited and re-imported before its commit stays one pending row', () => withTemp(({ dir, run, entries }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const p = join(repo, 'progress.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('did golf', 'did golf, edited'));
  exit(run(repo, ['import']), 0);
  const golf = entries().filter((e) => e.title === 'Golf');
  assert.equal(golf.length, 1);
  assert.equal(golf[0].state, 'pending');
  assert.match(golf[0].original, /did golf, edited/);
}));

test('local mode: a pending top entry no longer on top after a gated commit is demoted to unresolved', () => withTemp(({ dir, run, entries }) => {
  const { repo, progress, addTop, gate } = buildLocal(dir);
  addTop();
  exit(run(repo, ['import']), 0);
  const charlie = byTitle(entries()).get('Charlie');
  assert.equal(charlie.state, 'pending');
  gate();
  writeFileSync(progress, progressOf(ENTRIES.delta, ENTRIES.charlie, ENTRIES.bravo, ENTRIES.alpha));
  const r = run(repo, ['import']);
  exit(r, 0);
  const rows = entries();
  assert.deepEqual(rows.map((e) => [e.title, e.state]), [
    ['Alpha', 'unresolved'], ['Bravo', 'unresolved'], ['Charlie', 'unresolved'], ['Delta', 'pending'],
  ]);
  assert.match(r.stdout, /1 demoted/);
  assert.equal(byTitle(rows).get('Charlie').id, charlie.id, 'the demoted row keeps its id and text');
  assert.equal(byTitle(rows).get('Charlie').original, charlie.original);

  // Gated again with nothing newer: no pending row is left at all.
  gate();
  exit(run(repo, ['import']), 0);
  assert.equal(entries().filter((e) => e.state === 'pending').length, 0);
}));

test('local mode: a pending top entry edited before the next import stays one pending row', () => withTemp(({ dir, run, entries }) => {
  const { repo, progress, addTop } = buildLocal(dir);
  addTop();
  exit(run(repo, ['import']), 0);
  writeFileSync(progress, readFileSync(progress, 'utf8').replace('did charlie', 'did charlie, edited'));
  exit(run(repo, ['import']), 0);
  const charlie = entries().filter((e) => e.title === 'Charlie');
  assert.equal(charlie.length, 1);
  assert.equal(charlie[0].state, 'pending');
  assert.match(charlie[0].original, /edited/);
}));

test('a plain import after import --ref keeps the branch\'s newer task state, its status agreeing with the last event', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  exit(run(repo, ['import']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const t1 = s.ledgerOf(plan.id).tasks.find((t) => t.id === 'T1');
    assert.equal(t1.status, 'in_progress', 'the older disk ledger does not revert the merged state');
    const last = s.get("SELECT to_status FROM task_events WHERE plan_id = ? AND task_key = 'T1' ORDER BY id DESC LIMIT 1", plan.id);
    assert.equal(last.to_status, t1.status);
    assert.equal(s.get('SELECT COUNT(*) AS n FROM task_events').n, 3, 'no event repeated or lost');
  });
}));

test('a plain import of a ledger moved on disk since the last import takes the newer state', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const path = join(repo, LEDGER_PATH);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  ledger.tasks[1].history.push({ at: '2026-01-08T00:00:00Z', from: 'pending', to: 'blocked', note: 'waiting' });
  ledger.tasks[1].status = 'blocked';
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  exit(run(repo, ['import']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const t2 = s.ledgerOf(plan.id).tasks.find((t) => t.id === 'T2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.history.map((h) => h.to), ['pending', 'blocked']);
  });
}));

test('headingCommits: a merge TREESAME to its parents does not hide the side that added the heading first', () => withTemp(({ dir }) => {
  const { repo, shas } = buildTreesame(dir);
  const map = headingCommits(repo);
  assert.equal(map.get(HOTEL.split('\n')[0]), shas.s1);
  assert.equal(map.get(HEADINGS.alpha), shas.c1);
}));

// A loose object of the fixture repository removed, as a corrupt or partial clone would lack it.
const dropObject = (repo, git, spec) => {
  const oid = git(['rev-parse', spec]);
  rmSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
};

test('import: a git log failure (a missing object) is an error, exit 2, never every heading unresolved', () => withTemp(({ dir, dbEnv, run }) => {
  const { repo, git, shas } = buildHistory(dir);
  dropObject(repo, git, `${shas.c2}:progress.md`);
  const r = run(repo, ['import']);
  exit(r, 2);
  assert.match(r.stderr, /git log/);
  assert.equal(existsSync(dbEnv.TRIQUAL_TRACKING_DB), false, 'refused before the store is created');
}));

test('import --ref: a git ls-tree failure on the branch is an error, exit 2, never "no ledgers"', () => withTemp(({ dir, dbEnv, run }) => {
  const { repo, git } = buildHistory(dir);
  dropObject(repo, git, 'extra:docs/plans');
  const r = run(repo, ['import', '--ref', 'extra']);
  exit(r, 2);
  assert.match(r.stderr, /git ls-tree/);
  assert.equal(existsSync(dbEnv.TRIQUAL_TRACKING_DB), false);
}));

test('import in a repository with no commit yet (an unborn branch): every entry on disk is pending', () => withTemp(({ dir, run, entries }) => {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'progress.md'), progressOf(ENTRIES.bravo, ENTRIES.alpha));
  writeFileSync(join(repo, 'status.md'), STATUS);
  exit(run(repo, ['import']), 0);
  assert.deepEqual(entries().map((e) => [e.title, e.state]), [['Alpha', 'pending'], ['Bravo', 'pending']]);
}));

// ---- Fix round 2: per-worktree drafts, incoming ledger metadata, dangling HEAD, several stale drafts ----

test('import: two worktrees with the same pending heading line and different text keep both drafts', () => withTemp(({ dir, run, entries }) => {
  const { repo, git, gitDir } = buildHistory(dir);
  const wt = join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wtb', wt, 'HEAD']);
  exit(run(repo, ['import']), 0);
  const mine = byTitle(entries()).get('Golf');
  // The other worktree's own uncommitted entry: the same heading line, another body.
  const other = ENTRIES.golf.replace('did golf', 'did another golf');
  const wp = join(wt, 'progress.md');
  writeFileSync(wp, readFileSync(wp, 'utf8').replace(/^## /m, `${other}\n## `));
  exit(run(wt, ['import']), 0);
  exit(run(repo, ['import']), 0);
  const golf = entries().filter((e) => e.title === 'Golf');
  assert.equal(golf.length, 2, 'neither worktree replaces the other\'s draft');
  assert.ok(golf.every((e) => e.state === 'pending'));
  const a = golf.find((e) => e.git_dir === gitDir);
  assert.equal(a.id, mine.id);
  assert.equal(a.original, mine.original, 'the first worktree\'s draft is untouched');
  const b = golf.find((e) => e.git_dir !== gitDir);
  assert.match(b.original, /did another golf/);
}));

test('import: a stored pending draft that is no longer on disk is marked unresolved, the other worktree\'s and a --ref import left alone', () => withTemp(({ dir, run, entries }) => {
  const { repo, git } = buildHistory(dir);
  const wt = join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'wtb', wt, 'HEAD']);
  exit(run(repo, ['import']), 0);
  const wp = join(wt, 'progress.md');
  writeFileSync(wp, readFileSync(wp, 'utf8').replace(/^## /m, `${ENTRIES.golf.replace('Golf', 'Hotel draft')}\n## `));
  exit(run(wt, ['import']), 0);
  const state = (title) => entries().find((e) => e.title === title).state;
  assert.equal(state('Golf'), 'pending');
  assert.equal(state('Hotel draft'), 'pending');

  // A --ref import never demotes: it reads another branch's files, not this worktree's.
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  assert.equal(state('Golf'), 'pending');

  // The draft is retitled on disk: the old row is no longer on disk, the new one is the pending entry.
  const p = join(repo, 'progress.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('— Golf', '— Golf renamed'));
  const r = run(repo, ['import']);
  exit(r, 0);
  assert.equal(state('Golf'), 'unresolved');
  assert.equal(state('Golf renamed'), 'pending');
  assert.equal(state('Hotel draft'), 'pending', 'another worktree\'s draft is not this worktree\'s to demote');
  assert.match(r.stdout, /1 demoted/);
  const demoted = entries().find((e) => e.title === 'Golf');
  assert.match(demoted.original, /— Golf\n/, 'the demoted row keeps its text');
  assert.equal(demoted.commit_sha, null);

  // Running it again changes nothing.
  exit(run(repo, ['import']), 0);
  assert.equal(entries().filter((e) => e.state === 'pending').length, 2);
}));

// ---- Store-2 T7: demoted drafts promoted, demotion on a store-marked clone ----

test('import: a demoted draft whose original text is committed later is promoted in place, same id, no second row', () => withTemp(({ dir, run, entries }) => {
  const { repo, commit } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const hash = sha256(textOf(ENTRIES.golf));
  const draft = entries().find((e) => e.import_hash === hash);
  assert.equal(draft.state, 'pending');
  const p = join(repo, 'progress.md');
  const original = readFileSync(p, 'utf8');
  writeFileSync(p, original.replace('— Golf', '— Golf renamed'));
  exit(run(repo, ['import']), 0);
  assert.equal(entries().find((e) => e.import_hash === hash).state, 'unresolved', 'the retitled draft is demoted');

  writeFileSync(p, original);
  const sha = commit('golf', '2026-01-07T10:00:00Z');
  const r = run(repo, ['import']);
  exit(r, 0);
  assert.match(r.stdout, /0 entries added/);
  assert.match(r.stdout, /1 promoted/);
  const rows = entries().filter((e) => e.import_hash === hash);
  assert.equal(rows.length, 1, 'no second row for that text');
  assert.equal(rows[0].id, draft.id, 'the row keeps its id');
  assert.equal(rows[0].state, 'committed');
  assert.equal(rows[0].commit_sha, sha);
  assert.equal(rows[0].original, draft.original);
  assert.equal(entries().find((e) => e.title === 'Golf renamed').state, 'unresolved', 'the renamed draft is no longer pending on disk');
}));

test('import --ref: a demoted draft whose original text is committed on the branch is promoted in place', () => withTemp(({ dir, run, entries }) => {
  const { repo, git } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const hash = sha256(textOf(ENTRIES.golf));
  const draft = entries().find((e) => e.import_hash === hash);
  const p = join(repo, 'progress.md');
  const original = readFileSync(p, 'utf8');
  writeFileSync(p, original.replace('— Golf', '— Golf renamed'));
  exit(run(repo, ['import']), 0);
  assert.equal(entries().find((e) => e.import_hash === hash).state, 'unresolved');

  // The original text committed on another branch, in a worktree of its own.
  const wt = join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'golfb', wt, 'HEAD']);
  writeFileSync(join(wt, 'progress.md'), original);
  git(['-C', wt, 'add', 'progress.md']);
  git(['-C', wt, 'commit', '-qm', 'golf on a branch']);
  const sha = git(['-C', wt, 'rev-parse', 'HEAD']);
  const r = run(repo, ['import', '--ref', 'golfb']);
  exit(r, 0);
  assert.match(r.stdout, /1 promoted/);
  const rows = entries().filter((e) => e.import_hash === hash);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, draft.id);
  assert.equal(rows[0].state, 'committed');
  assert.equal(rows[0].commit_sha, sha);
  assert.equal(entries().find((e) => e.title === 'Golf renamed').state, 'pending', '--ref demotes nothing');
}));

test('import in a store-marked clone that still has progress.md demotes a stale draft; --ref does not', () => withTemp(({ dir, run, entries }) => {
  const { repo, git } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  git(['config', '--local', 'triqual.tracking', 'store']);
  const p = join(repo, 'progress.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('— Golf', '— Golf renamed'));
  const state = (title) => entries().find((e) => e.title === title).state;

  const ref = run(repo, ['import', '--ref', 'extra']);
  exit(ref, 0);
  assert.match(ref.stdout, /0 demoted/);
  assert.equal(state('Golf'), 'pending', 'a --ref import demotes nothing');

  const r = run(repo, ['import']);
  exit(r, 0);
  assert.match(r.stdout, /1 demoted/);
  assert.equal(state('Golf'), 'unresolved');
  assert.equal(state('Golf renamed'), 'pending');
}));

// ---- Final fix: order of mixed sources, ledger metadata after the switch ----

test('an entry imported with --ref and committed after an `add` sorts above it: both carry full timestamps', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  // Written the same day as the `extra` branch's commit (2026-01-06T10:00:00Z), an hour before it.
  inStore((s) => {
    s.addEntry({ repoId: s.get('SELECT id FROM repos').id, gitDir: s.get('SELECT git_dir FROM entries LIMIT 1').git_dir, branch: 'main' },
      { title: 'Added by hand', stage_task: 'off-plan', done: 'd', files: 'f', verification: 'v', next: 'n' },
      { state: 'no_commit', createdAt: '2026-01-06T09:00:00.000Z', entryDate: '2026-01-06' });
  });
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  const order = inStore((s) => s.entries(s.get('SELECT id FROM repos').id, {}).map((e) => e.title));
  assert.ok(order.indexOf('Foxtrot') < order.indexOf('Added by hand'), order.join(', '));
  const [foxtrot] = inStore((s) => s.all("SELECT created_at, entry_date FROM entries WHERE title = 'Foxtrot'"));
  assert.equal(foxtrot.created_at, '2026-01-06T10:00:00.000Z');
  assert.equal(foxtrot.entry_date, '2026-01-06');
}));

test('import --ref after the switch keeps a title and plan metadata changed since, and still takes what the branch moved on', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  // After the switch: `tasks retitle T2` (a history event of its own) and the plan's spec and branch edited.
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const { ledger } = transition(s.ledgerOf(plan.id), 'retitle', 'T2', 'Second thing, renamed', '2026-02-01T00:00:00.000Z');
    ledger.spec = 'docs/specs/after-the-switch.md';
    ledger.branch = 'feat/after-the-switch';
    s.saveLedger(plan.id, ledger);
  });
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const stored = s.ledgerOf(plan.id);
    const t2 = stored.tasks.find((t) => t.id === 'T2');
    assert.equal(t2.title, 'Second thing, renamed', 'the branch\'s older title does not come back');
    assert.equal(plan.spec, 'docs/specs/after-the-switch.md');
    assert.equal(plan.branch, 'feat/after-the-switch');
    assert.equal(stored.tasks.find((t) => t.id === 'T1').status, 'in_progress', 'the branch\'s later task state still wins');
  });
}));

test('import --ref takes the branch\'s title and plan metadata when the branch has the later event', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  // The store has no event after the branch's (2026-01-06T09:00): the branch's metadata, equal or newer, applies.
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    const ledger = s.ledgerOf(plan.id);
    ledger.tasks[0].title = 'Stale title';
    ledger.spec = 'docs/specs/stale.md';
    s.saveLedger(plan.id, ledger);
  });
  exit(run(repo, ['import', '--ref', 'extra']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    assert.equal(s.ledgerOf(plan.id).tasks[0].title, 'First thing');
    assert.equal(plan.spec, null);
  });
}));

test('a plain re-import picks up a ledger\'s spec, branch and task titles changed on disk', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  const path = join(repo, LEDGER_PATH);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  ledger.spec = 'docs/specs/2026-01-01-sample.md';
  ledger.branch = 'feat/sample';
  ledger.tasks[0].title = 'First thing, renamed';
  ledger.tasks[1].deps = [];
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  exit(run(repo, ['import']), 0);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    assert.equal(plan.spec, 'docs/specs/2026-01-01-sample.md');
    assert.equal(plan.branch, 'feat/sample');
    const stored = s.ledgerOf(plan.id);
    assert.equal(stored.tasks[0].title, 'First thing, renamed');
    assert.deepEqual(stored.tasks[1].deps, []);
    assert.equal(stored.tasks[0].status, 'pending');
  });
}));

test('import: a HEAD whose commit object is missing is an error, exit 2, never an unborn branch', () => withTemp(({ dir, dbEnv, run }) => {
  const { repo, git } = buildHistory(dir);
  const oid = git(['rev-parse', 'HEAD']);
  rmSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
  const r = run(repo, ['import']);
  exit(r, 2);
  assert.match(r.stderr, /git show-ref failed/);
  assert.equal(existsSync(dbEnv.TRIQUAL_TRACKING_DB), false);
}));

test('import: several stale drafts of one heading are replaced by one row, a correction of any of them repointed to it', () => withTemp(({ dir, home, dbEnv, run, entries }) => {
  const { repo, commit, gitDir } = buildHistory(dir);
  exit(run(repo, ['import']), 0);
  // A second draft of the same heading (an earlier edit) and a correction pointing at it.
  const store = openStore({ home, env: dbEnv });
  let second;
  let fix;
  try {
    const repoId = store.get('SELECT id FROM repos').id;
    const ctx = { repoId, gitDir, branch: 'main' };
    const text = ENTRIES.golf.replace('did golf', 'did golf, first edit').trimEnd();
    const fields = { title: 'Golf', stage_task: 'Plan sample · T1', done: 'x', files: 'f', verification: 'v', next: 'n' };
    second = store.addEntry(ctx, fields, { original: text, importHash: sha256(text), createdAt: '2026-01-07' });
    fix = store.addEntry(ctx, { ...fields, title: 'A correction' }, { state: 'no_commit', corrects: second });
  } finally {
    store.close();
  }
  const first = Math.min(...entries().filter((e) => e.title === 'Golf').map((e) => e.id));
  assert.ok(first < second);
  const p = join(repo, 'progress.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('did golf', 'did golf, final'));
  const sha = commit('golf', '2026-01-07T10:00:00Z');
  const r = run(repo, ['import']);
  exit(r, 0);
  assert.match(r.stdout, /2 pending drafts replaced/);
  const golf = entries().filter((e) => e.title === 'Golf');
  assert.equal(golf.length, 1);
  assert.equal(golf[0].id, first);
  assert.equal(golf[0].commit_sha, sha);
  const correction = entries().find((e) => e.id === fix);
  assert.equal(correction.corrects, first, 'the correction now names the row that replaced its draft');
}));

// Plan methodology-1.0 · T2: the declared and the effective tier survive an import, a merge and an export rebuild.
test('store keeps tiers through import', () => withTemp(({ dir, run, inStore }) => {
  const { repo } = buildHistory(dir);
  const path = join(repo, LEDGER_PATH);
  const edit = (fn) => {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    fn(ledger);
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  };
  const tiers = () => inStore((s) => s.all('SELECT key, tier, effective_tier FROM tasks ORDER BY position')
    .map((r) => [r.key, r.tier, r.effective_tier]));
  // A first import of a ledger with tiers stores both values.
  edit((l) => {
    Object.assign(l.tasks[0], { tier: 'heavy', effectiveTier: 'heavy' });
    Object.assign(l.tasks[1], { tier: 'light', effectiveTier: 'standard' });
  });
  exit(run(repo, ['import']), 0);
  assert.deepEqual(tiers(), [['T1', 'heavy', 'heavy'], ['T2', 'light', 'standard']]);
  // A merge where the incoming side is newer copies both; an incoming lower effective tier never lowers the stored one.
  edit((l) => {
    Object.assign(l.tasks[1], { tier: 'heavy', effectiveTier: 'heavy', status: 'blocked' });
    l.tasks[1].history.push({ at: '2026-01-08T00:00:00Z', from: 'pending', to: 'blocked', note: 'waiting' });
    Object.assign(l.tasks[0], { tier: 'light', effectiveTier: 'light', status: 'in_progress' });
    l.tasks[0].history.push({ at: '2026-01-08T00:00:00Z', from: 'pending', to: 'in_progress', note: null });
  });
  exit(run(repo, ['import']), 0);
  assert.deepEqual(tiers(), [['T1', 'light', 'heavy'], ['T2', 'heavy', 'heavy']]);
  inStore((s) => {
    const [plan] = s.plans(s.get('SELECT id FROM repos').id);
    assert.deepEqual(s.ledgerOf(plan.id).tasks.map((t) => [t.id, t.status, t.tier, t.effectiveTier]),
      [['T1', 'in_progress', 'light', 'heavy'], ['T2', 'blocked', 'heavy', 'heavy']]);
    // An export rebuild (--replace --from) writes both columns back.
    const repoId = s.get('SELECT id FROM repos').id;
    const records = s.rows(repoId).map(({ table, row }) => ({ table, row: { ...row } }));
    s.replaceRows(repoId, (st) => importRecords(st, { repoId }, records));
  });
  assert.deepEqual(tiers(), [['T1', 'light', 'heavy'], ['T2', 'heavy', 'heavy']]);
}));

// Plan methodology-1.0 · T2 fix round 1: a column added to the schema cannot be dropped silently by --replace --from.
test('the --from column lists, plus the remapped links, are every column of a freshly migrated store', () => withTemp(({ home, dbEnv }) => {
  // The id and the repository/plan links each table's insert writes itself (remapped), outside COLUMNS.
  const LINKS = { entries: ['id', 'repo_id', 'corrects'], status: ['repo_id'], plans: ['id', 'repo_id'], tasks: ['plan_id'], task_events: ['id', 'plan_id'] };
  const store = openStore({ home, env: dbEnv, create: true });
  try {
    assert.deepEqual(Object.keys(COLUMNS).sort(), Object.keys(LINKS).sort());
    for (const table of Object.keys(LINKS)) {
      const schema = store.all(`PRAGMA table_info(${table})`).map((c) => c.name).sort();
      assert.deepEqual([...LINKS[table], ...COLUMNS[table]].sort(), schema, table);
    }
  } finally {
    store.close();
  }
}));
