import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, {
  mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync, statSync, readdirSync, symlinkSync, writeFileSync, chmodSync, utimesSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import {
  loadSqlite, storePaths, repoKey, openStore, maybeDailySnapshot, StoreError, needsTighten, createPrivate,
} from '../lib/store.mjs';
import { createLedger, transition } from '../lib/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/store-schema.mjs';

const STORE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'store.mjs')).href;
const NOW = '2026-10-11T12:00:00.000Z';

await loadSqlite();
// Loaded after loadSqlite, which drops node:sqlite's experimental warning.
const { DatabaseSync } = await import('node:sqlite');

// A temp home and an env whose TRIQUAL_TRACKING_DB names a not-yet-created file: the real data dir is never touched.
function withEnv(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-store-')));
  const env = { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db') };
  const opened = [];
  const open = (opts = { create: true }) => {
    const s = openStore({ home: dir, env, ...opts });
    opened.push(s);
    return s;
  };
  try {
    return fn({ dir, env, open });
  } finally {
    for (const s of opened) try { s.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

const gitCommonDir = (dir) => {
  const p = join(dir, 'clone', '.git');
  mkdirSync(p, { recursive: true });
  return p;
};
const FIELDS = { title: 'A title', stage_task: 'off-plan', done: 'did it', files: 'a.mjs', verification: 'ok', next: 'more' };

function seedRepo(store, dir) {
  const { id: repoId } = store.ensureRepo({ gitCommonDir: gitCommonDir(dir), root: join(dir, 'clone'), origin: null, shareable: 1 });
  return { repoId, ctx: { repoId, gitDir: join(dir, 'clone', '.git'), branch: 'main' } };
}

test('schema: user_version 2, every table, the import_guard table and the (repo_id, git_dir, state) index exist', () => {
  withEnv(({ open }) => {
    const s = open();
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2);
    const names = (type) => s.db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((r) => r.name);
    const tables = names('table');
    for (const t of ['repos', 'entries', 'status', 'plans', 'tasks', 'task_events', 'import_guard']) {
      assert.ok(tables.includes(t), `table ${t}`);
    }
    const idx = s.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries'").all();
    assert.ok(idx.some((r) => r.sql && /repo_id,\s*git_dir,\s*state/.test(r.sql)), 'entries index');
    const cols = s.db.prepare('PRAGMA table_info(repos)').all().map((c) => c.name);
    assert.ok(cols.includes('repo_key'));
  });
});

test('schema: reopening keeps the data and the version', () => {
  withEnv(({ dir, open }) => {
    const a = open();
    seedRepo(a, dir);
    a.close();
    const b = open({ create: false });
    assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM repos').get().n, 1);
  });
});

test('storePaths: a relative or empty override disables, an absolute one names the file, unset uses XDG_DATA_HOME/triqual', () => {
  assert.equal(storePaths({ home: '/h', env: { TRIQUAL_TRACKING_DB: 'rel/tracking.db' } }), null);
  assert.equal(storePaths({ home: '/h', env: { TRIQUAL_TRACKING_DB: '' } }), null);
  assert.deepEqual(
    storePaths({ home: '/h', env: { TRIQUAL_TRACKING_DB: '/x/y/t.db' } }),
    { db: '/x/y/t.db', dataDir: '/x/y' },
  );
  withEnv(({ dir }) => {
    const xdg = join(dir, 'xdg');
    assert.deepEqual(
      storePaths({ home: '/h', env: { XDG_DATA_HOME: xdg } }),
      { db: join(xdg, 'triqual', 'tracking.db'), dataDir: join(xdg, 'triqual') },
    );
    assert.deepEqual(
      storePaths({ home: dir, env: {} }),
      { db: join(dir, '.local', 'share', 'triqual', 'tracking.db'), dataDir: join(dir, '.local', 'share', 'triqual') },
    );
  });
});

test('modes: the data dir is 0700 and tracking.db 0600 after a create', () => {
  withEnv(({ dir, open }) => {
    open();
    assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'data', 'tracking.db')).mode & 0o777, 0o600);
  });
});

test('modes: the WAL and shm side files are 0600 while the store is open', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    seedRepo(s, dir);
    for (const suffix of ['-wal', '-shm']) {
      assert.equal(statSync(join(dir, 'data', `tracking.db${suffix}`)).mode & 0o777, 0o600, suffix);
    }
  });
});

test('modes: a pre-existing default data dir is tightened to 0700 on open, an override parent is left alone', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-store-')));
  try {
    const env = { XDG_DATA_HOME: join(dir, 'xdg') };
    const { dataDir } = storePaths({ home: dir, env });
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o755);
    openStore({ home: dir, env, create: true }).close();
    assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'dir tightened on create');
    chmodSync(dataDir, 0o755);
    openStore({ home: dir, env }).close();
    assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'dir tightened on a plain open');

    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    openStore({ home: dir, env: { TRIQUAL_TRACKING_DB: join(shared, 'tracking.db') }, create: true }).close();
    assert.equal(statSync(shared).mode & 0o777, 0o755, 'an override parent keeps its mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modes: needsTighten is true only for a mode with group or other bits', () => {
  assert.equal(needsTighten(0o40700), false);
  assert.equal(needsTighten(0o40755), true);
  assert.equal(needsTighten(0o40710), true);
});

test('modes: a write open on a default data dir already 0700 calls no chmodSync on it; one at 0755 is still tightened', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-store-')));
  const original = fs.chmodSync;
  const calls = [];
  try {
    const env = { XDG_DATA_HOME: join(dir, 'xdg') };
    const { dataDir } = storePaths({ home: dir, env });
    openStore({ home: dir, env, create: true }).close();
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    fs.chmodSync = (path, mode) => {
      calls.push(String(path));
      return original(path, mode);
    };
    syncBuiltinESMExports();
    openStore({ home: dir, env }).close();
    assert.deepEqual(calls.filter((p) => p === dataDir), [], 'no chmodSync on a dir that is already 0700');

    original(dataDir, 0o755);
    openStore({ home: dir, env }).close();
    assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'a 0755 dir is tightened');
    assert.ok(calls.includes(dataDir), 'tightened through chmodSync');
  } finally {
    fs.chmodSync = original;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening: without create an absent file throws missing (naming restore) and creates nothing; a disabled path throws disabled', () => {
  withEnv(({ dir, env }) => {
    assert.throws(
      () => openStore({ home: dir, env }),
      (e) => e instanceof StoreError && e.code === 'missing' && /triqual tracking restore/.test(e.message),
    );
    assert.equal(existsSync(join(dir, 'data')), false);
    assert.throws(
      () => openStore({ home: dir, env: { TRIQUAL_TRACKING_DB: '' }, create: true }),
      (e) => e instanceof StoreError && e.code === 'disabled',
    );
  });
});

test('opening: an unreadable database file throws open', () => {
  withEnv(({ dir, env }) => {
    mkdirSync(join(dir, 'data'));
    // A file that is not SQLite: the header check fails on the first statement.
    writeFileSync(env.TRIQUAL_TRACKING_DB, Buffer.alloc(4096, 0x41));
    assert.throws(
      () => openStore({ home: dir, env }),
      (e) => e instanceof StoreError && e.code === 'open',
    );
  });
});

test('repositories: findRepo never writes, ensureRepo keeps shareable from the first insert, repoKey follows the realpath', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const common = gitCommonDir(dir);
    assert.equal(s.findRepo(common), null);
    // A WAL write would not move tracking.db's mtime, so count the connection's row changes instead.
    const changes = () => Number(s.db.prepare('SELECT total_changes() AS n').get().n);
    const before = changes();
    s.findRepo(common);
    assert.equal(changes(), before, 'findRepo changed no rows');

    const first = s.ensureRepo({ gitCommonDir: common, root: join(dir, 'clone'), origin: 'o', shareable: 0 });
    const again = s.ensureRepo({ gitCommonDir: common, root: join(dir, 'clone'), origin: 'o', shareable: 1 });
    assert.ok(changes() > before, 'ensureRepo does change rows, so the check above can fail');
    assert.equal(again.id, first.id);
    assert.equal(first.repo_key, repoKey(common));
    assert.match(first.repo_key, /^[0-9a-f]{16}$/);
    assert.deepEqual(s.findRepo(common), { id: first.id, repo_key: first.repo_key, shareable: 0 });

    const link = join(dir, 'link');
    symlinkSync(common, link);
    assert.equal(repoKey(link), repoKey(common));
    assert.equal(s.findRepo(link).id, first.id);
    assert.notEqual(repoKey(join(dir, 'other')), repoKey(common));
  });
});

test('entries: pendingEntries is scoped by git dir; stampEntries stamps once and the triggers refuse other updates', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId, ctx } = seedRepo(s, dir);
    const other = { ...ctx, gitDir: join(dir, 'other-worktree', '.git') };
    const a = s.addEntry(ctx, FIELDS, { createdAt: NOW });
    const b = s.addEntry(ctx, { ...FIELDS, title: 'B' });
    s.addEntry(other, FIELDS);
    assert.deepEqual(s.pendingEntries(ctx), [{ id: a }, { id: b }]);
    assert.equal(s.pendingEntries(other).length, 1);

    assert.equal(s.stampEntries([a, b], 'abc1234'), 2);
    assert.deepEqual(s.pendingEntries(ctx), []);
    const row = s.db.prepare('SELECT state, commit_sha FROM entries WHERE id = ?').get(a);
    assert.equal(row.state, 'committed');
    assert.equal(row.commit_sha, 'abc1234');

    // Once only: nothing is pending any more, so a second stamp changes nothing.
    assert.equal(s.stampEntries([a, b], 'ffff999'), 0);
    assert.equal(s.db.prepare('SELECT commit_sha FROM entries WHERE id = ?').get(a).commit_sha, 'abc1234');

    assert.throws(() => s.db.exec(`UPDATE entries SET done = 'changed' WHERE id = ${a}`), /append-only/);
    assert.throws(() => s.db.exec(`UPDATE entries SET commit_sha = 'zzz' WHERE id = ${a}`), /append-only/);
    assert.throws(() => s.db.exec(`UPDATE entries SET state = 'pending', commit_sha = NULL WHERE id = ${a}`), /append-only/);
    // pending -> committed together with other columns is refused too.
    const c = s.addEntry(ctx, FIELDS);
    assert.throws(
      () => s.db.exec(`UPDATE entries SET state = 'committed', commit_sha = 'a', title = 'x' WHERE id = ${c}`),
      /append-only/,
    );
    assert.throws(() => s.db.exec(`UPDATE entries SET state = 'committed' WHERE id = ${c}`), /append-only/);
  });
});

test('entries: fields, states, corrections, plan and task parsing, filters', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId, ctx } = seedRepo(s, dir);
    const a = s.addEntry(
      ctx,
      { ...FIELDS, stage_task: 'Plan tracking-store-1 · T1', title: 'First entry' },
      { createdAt: '2026-10-01T00:00:00.000Z' },
    );
    const b = s.addEntry(
      ctx,
      { ...FIELDS, title: 'Second', done: 'needle in the done field' },
      { state: 'no_commit', createdAt: '2026-10-05T00:00:00.000Z' },
    );
    const c = s.addEntry(
      ctx,
      { ...FIELDS, title: 'Third' },
      { state: 'committed', commit: 'deadbee', corrects: a, original: 'raw text', parseOk: false, importHash: 'h1',
        createdAt: '2026-10-09T00:00:00.000Z' },
    );
    const all = s.entries(repoId, {});
    assert.deepEqual(all.map((e) => e.id), [c, b, a]);
    const third = all[0];
    assert.equal(third.state, 'committed');
    assert.equal(third.commit_sha, 'deadbee');
    assert.equal(third.corrects, a);
    assert.equal(third.original, 'raw text');
    assert.equal(third.parse_ok, 0);
    assert.equal(third.import_hash, 'h1');
    assert.equal(third.branch, 'main');
    const first = all[2];
    assert.equal(first.plan, 'tracking-store-1');
    assert.equal(first.task_key, 'T1');
    assert.equal(first.state, 'pending');
    assert.equal(first.parse_ok, 1);
    assert.equal(first.original, null);

    assert.deepEqual(s.entries(repoId, { last: 2 }).map((e) => e.id), [c, b]);
    assert.deepEqual(s.entries(repoId, { since: '2026-10-05' }).map((e) => e.id), [c, b]);
    assert.deepEqual(s.entries(repoId, { plan: 'tracking-store-1' }).map((e) => e.id), [a]);
    assert.deepEqual(s.entries(repoId, { grep: 'needle' }).map((e) => e.id), [b]);
    assert.deepEqual(s.entries(repoId, { grep: '100%' }).map((e) => e.id), []);
    assert.throws(() => s.addEntry(ctx, FIELDS, { importHash: 'h1' }), /UNIQUE/);
  });
});

test('deletes: DELETE FROM entries throws, the repos row is never deleted, replaceRows succeeds and keeps the repos row', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId, ctx } = seedRepo(s, dir);
    s.addEntry(ctx, FIELDS);
    s.setStatus(repoId, [{ heading: 'preamble', body: 'x' }], NOW);
    assert.throws(() => s.db.exec('DELETE FROM entries'), /append-only/);
    assert.throws(() => s.db.exec('DELETE FROM repos'), /never deleted/);
    assert.equal(s.entries(repoId, {}).length, 1);

    let sawGuard = null;
    s.replaceRows(repoId, (st) => {
      sawGuard = st.db.prepare('SELECT COUNT(*) AS n FROM import_guard').get().n;
      st.addEntry(ctx, { ...FIELDS, title: 'replacement' });
    });
    assert.equal(sawGuard, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM import_guard').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM repos').get().n, 1);
    assert.deepEqual(s.entries(repoId, {}).map((e) => e.title), ['replacement']);
    assert.deepEqual(s.status(repoId), []);

    // A throwing replace rolls back, guard row included.
    assert.throws(() => s.replaceRows(repoId, () => { throw new Error('boom'); }), /boom/);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM import_guard').get().n, 0);
    assert.deepEqual(s.entries(repoId, {}).map((e) => e.title), ['replacement']);
    assert.throws(() => s.db.exec('DELETE FROM entries'), /append-only/);
  });
});

test('status: sections round-trip in order with the preamble first, and a second set replaces them', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId } = seedRepo(s, dir);
    assert.deepEqual(s.status(repoId), []);
    const sections = [
      { heading: 'preamble', body: 'Last updated: today\n' },
      { heading: '## Zeta', body: 'z\n' },
      { heading: '## Alpha', body: 'a\n' },
    ];
    s.setStatus(repoId, sections, NOW);
    assert.deepEqual(s.status(repoId), sections);
    s.setStatus(repoId, [sections[0]], NOW);
    assert.deepEqual(s.status(repoId), [sections[0]]);
  });
});

test('ledgers: ledgerOf and saveLedger round-trip commits, reason, retitle, plan state and history, in position order', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId } = seedRepo(s, dir);
    const tasks = [];
    for (let n = 1; n <= 10; n += 1) {
      tasks.push({
        id: `T${n}`, title: `Task ${n}`, deps: n > 1 ? [`T${n - 1}`] : [], skills: n === 2 ? ['a', 'b'] : [],
        role: n === 3 ? 'roles:tdd-implementer' : null,
      });
    }
    let ledger = createLedger({ plan: 'plans/p.md', spec: 'specs/p.md', branch: 'feat/p', tasks, now: '2026-10-01T00:00:00.000Z' });
    const planId = s.upsertPlan(repoId, { path: 'plans/p.md', spec: 'specs/p.md', branch: 'feat/p', state: 'active' });
    assert.equal(s.upsertPlan(repoId, { path: 'plans/p.md', spec: 'specs/p.md', branch: 'feat/p', state: 'active' }), planId);
    s.saveLedger(planId, ledger);
    assert.deepEqual(s.ledgerOf(planId), ledger);
    assert.deepEqual(s.ledgerOf(planId).tasks.map((t) => t.id).slice(0, 3), ['T1', 'T2', 'T3']);
    assert.equal(s.ledgerOf(planId).tasks[1].role, null);
    assert.equal(s.ledgerOf(planId).tasks[2].role, 'roles:tdd-implementer');

    const step = (cmd, id, arg, at) => { ledger = transition(ledger, cmd, id, arg, at).ledger; };
    step('start', 'T1', undefined, '2026-10-02T00:00:00.000Z');
    step('done', 'T1', 'abc1234', '2026-10-03T00:00:00.000Z');
    step('retitle', 'T2', 'Task two, renamed', '2026-10-03T01:00:00.000Z');
    step('start', 'T2', undefined, '2026-10-04T00:00:00.000Z');
    step('block', 'T2', 'waiting on review', '2026-10-05T00:00:00.000Z');
    s.saveLedger(planId, ledger);
    assert.deepEqual(s.ledgerOf(planId), ledger);
    // Saving again appends no duplicate events.
    s.saveLedger(planId, ledger);
    assert.deepEqual(s.ledgerOf(planId), ledger);
    const events = s.db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE plan_id = ?').get(planId).n;
    assert.equal(events, ledger.tasks.reduce((n, t) => n + t.history.length, 0));

    // Plan state: finish everything, close, save.
    for (const t of ledger.tasks) {
      if (t.status === 'done') continue;
      step('drop', t.id, 'cut', '2026-10-06T00:00:00.000Z');
    }
    step('close', null, undefined, '2026-10-07T00:00:00.000Z');
    assert.equal(ledger.state, 'done');
    s.saveLedger(planId, ledger);
    assert.deepEqual(s.ledgerOf(planId), ledger);
    assert.deepEqual(s.plans(repoId).map((p) => [p.path, p.state, p.spec, p.branch]), [['plans/p.md', 'done', 'specs/p.md', 'feat/p']]);
  });
});

test('rows: every row of one repository, tagged by table, repos row first', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId, ctx } = seedRepo(s, dir);
    s.addEntry(ctx, FIELDS);
    s.setStatus(repoId, [{ heading: 'preamble', body: 'p' }], NOW);
    const planId = s.upsertPlan(repoId, { path: 'p.md', spec: null, branch: null, state: 'active' });
    s.saveLedger(planId, createLedger({
      plan: 'p.md', spec: null, branch: null, now: NOW, tasks: [{ id: 'T1', title: 't', deps: [], skills: [], role: null }],
    }));
    const rows = s.rows(repoId);
    assert.equal(rows[0].table, 'repos');
    assert.deepEqual([...new Set(rows.map((r) => r.table))], ['repos', 'entries', 'status', 'plans', 'tasks', 'task_events']);
    assert.ok(rows.every((r) => r.row && typeof r.row === 'object'));
  });
});

test('snapshots: maybeDailySnapshot writes today once and keeps the 7 newest', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    seedRepo(s, dir);
    const dataDir = join(dir, 'data');
    const file = (d) => join(dataDir, 'backups', `tracking-${d}.db`);
    assert.equal(maybeDailySnapshot(s, dataDir, '2026-10-01T08:00:00.000Z'), file('2026-10-01'));
    assert.ok(existsSync(file('2026-10-01')));
    assert.equal(statSync(join(dataDir, 'backups')).mode & 0o777, 0o700);
    // Same day: nothing new, the file is left untouched.
    utimesSync(file('2026-10-01'), new Date(1e12), new Date(1e12));
    assert.equal(maybeDailySnapshot(s, dataDir, '2026-10-01T20:00:00.000Z'), null);
    assert.equal(statSync(file('2026-10-01')).mtimeMs, 1e12);
    for (let d = 2; d <= 7; d += 1) maybeDailySnapshot(s, dataDir, `2026-10-0${d}T00:00:00.000Z`);
    assert.equal(readdirSync(join(dataDir, 'backups')).length, 7);
    maybeDailySnapshot(s, dataDir, '2026-10-08T00:00:00.000Z');
    const kept = readdirSync(join(dataDir, 'backups')).sort();
    assert.equal(kept.length, 7);
    assert.equal(existsSync(file('2026-10-01')), false);
    assert.ok(kept.includes('tracking-2026-10-08.db'));
    assert.ok(kept.every((n) => !n.endsWith('.tmp')));
  });
});

test('snapshots: a stale "<target>.tmp" of another process is left alone, and the temp name is unique to the call', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    seedRepo(s, dir);
    const dataDir = join(dir, 'data');
    const backups = join(dataDir, 'backups');
    mkdirSync(backups, { recursive: true });
    const stale = join(backups, 'tracking-2026-10-01.db.tmp');
    writeFileSync(stale, 'another process, mid-write');
    const target = maybeDailySnapshot(s, dataDir, '2026-10-01T08:00:00.000Z');
    assert.equal(target, join(backups, 'tracking-2026-10-01.db'));
    assert.equal(readFileSync(stale, 'utf8'), 'another process, mid-write', 'the other process\'s partial file is untouched');
    assert.ok(statSync(target).size > 100, 'the snapshot is a database, not the stale text');
    assert.deepEqual(readdirSync(backups).sort(), ['tracking-2026-10-01.db', 'tracking-2026-10-01.db.tmp'], 'no temp of ours remains');
  });
});

test('snapshotTo: writes a readable copy of the database', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId, ctx } = seedRepo(s, dir);
    s.addEntry(ctx, FIELDS);
    const out = join(dir, 'copy.db');
    s.snapshotTo(out);
    assert.ok(existsSync(out));
    const copy = openStore({ home: dir, env: { TRIQUAL_TRACKING_DB: out } });
    try {
      assert.equal(copy.entries(repoId, {}).length, 1);
    } finally {
      copy.close();
    }
  });
});

test('snapshots: under umask 022 the daily snapshot and a snapshotTo output are 0600, and a pre-existing backups dir becomes 0700', () => {
  const previous = process.umask(0o022);
  try {
    withEnv(({ dir, open }) => {
      const s = open();
      seedRepo(s, dir);
      const dataDir = join(dir, 'data');
      mkdirSync(join(dataDir, 'backups'));
      chmodSync(join(dataDir, 'backups'), 0o755);
      const daily = maybeDailySnapshot(s, dataDir, '2026-10-01T08:00:00.000Z');
      assert.equal(statSync(daily).mode & 0o777, 0o600, 'daily snapshot');
      assert.equal(statSync(join(dataDir, 'backups')).mode & 0o777, 0o700, 'backups dir');
      const out = join(dir, 'copy.db');
      s.snapshotTo(out);
      assert.equal(statSync(out).mode & 0o777, 0o600, 'snapshotTo output');
    });
  } finally {
    process.umask(previous);
  }
});

test('createPrivate: under umask 022 an empty 0600 file, and EEXIST for an existing one', () => {
  const previous = process.umask(0o022);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-store-')));
  try {
    const f = join(dir, 'private.db');
    createPrivate(f);
    assert.equal(statSync(f).size, 0);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.throws(() => createPrivate(f), { code: 'EEXIST' });
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotTo: an existing empty file is refused with EEXIST, never written over', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    seedRepo(s, dir);
    const out = join(dir, 'existing.db');
    writeFileSync(out, '');
    assert.throws(() => s.snapshotTo(out), { code: 'EEXIST' });
    assert.equal(statSync(out).size, 0, 'the existing file is left as it was');
  });
});

test('transactions: when ROLLBACK itself throws, the original error is the one rethrown and the store stays usable state-wise', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    seedRepo(s, dir);
    assert.throws(
      () => s.tx(() => {
        s.db.close(); // makes the ROLLBACK that follows throw too
        throw new Error('the original failure');
      }),
      (e) => e.message === 'the original failure',
    );
    assert.equal(s.depth, 0);
  });
});

test('warning: a child node that loads and opens the store prints nothing on stderr', () => {
  withEnv(({ dir, env }) => {
    const script = `
      import { loadSqlite, openStore } from ${JSON.stringify(STORE_URL)};
      await loadSqlite();
      const s = openStore({ home: ${JSON.stringify(dir)}, env: { TRIQUAL_TRACKING_DB: ${JSON.stringify(env.TRIQUAL_TRACKING_DB)} }, create: true });
      s.close();
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  });
});

test('warning: only the SQLite warning is dropped', () => {
  const script = `
    import { loadSqlite } from ${JSON.stringify(STORE_URL)};
    await loadSqlite();
    process.emitWarning('keep this one');
    process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /keep this one/);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental/);
});

test('warning: a non-experimental warning that mentions SQLite is still emitted, in every call form', () => {
  const script = `
    import { loadSqlite } from ${JSON.stringify(STORE_URL)};
    await loadSqlite();
    process.emitWarning('SQLite deprecation one', 'DeprecationWarning');
    process.emitWarning('SQLite deprecation two', { type: 'DeprecationWarning' });
    const e = new Error('SQLite error-form'); e.name = 'DeprecationWarning';
    process.emitWarning(e);
    process.emitWarning('SQLite plain default-type');
    process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
    process.emitWarning('SQLite is an experimental feature too', { type: 'ExperimentalWarning' });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SQLite deprecation one/);
  assert.match(r.stderr, /SQLite deprecation two/);
  assert.match(r.stderr, /SQLite error-form/);
  assert.match(r.stderr, /SQLite plain default-type/);
  assert.doesNotMatch(r.stderr, /experimental feature/);
});

// Plan methodology-1.0 · T2: migration V2 adds the declared and the effective tier to tasks.
test('store migrates V1 to V2', () => {
  withEnv(({ dir, env, open }) => {
    assert.equal(SCHEMA_VERSION, 2);
    const file = env.TRIQUAL_TRACKING_DB;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // A V1 database with one repository, plan and task, written the way a V1 triqual wrote it.
    const v1 = new DatabaseSync(file);
    v1.exec(MIGRATIONS[0]);
    v1.exec('PRAGMA user_version = 1');
    v1.prepare('INSERT INTO repos (repo_key, git_common_dir, root, origin, shareable, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('k', gitCommonDir(dir), join(dir, 'clone'), null, 1, NOW);
    v1.prepare("INSERT INTO plans (repo_id, path, spec, branch, state) VALUES (1, 'p.md', NULL, NULL, 'active')").run();
    v1.prepare(`INSERT INTO tasks (plan_id, key, position, title, deps, role, skills, status, commits, reason)
      VALUES (1, 'T1', 0, 'Old task', '[]', NULL, '[]', 'pending', '[]', NULL)`).run();
    v1.close();
    const s = open({ create: false });
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2);
    const cols = s.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    assert.ok(cols.includes('tier') && cols.includes('effective_tier'), cols.join(', '));
    assert.deepEqual({ ...s.get('SELECT key, title, tier, effective_tier FROM tasks') },
      { key: 'T1', title: 'Old task', tier: null, effective_tier: null });
    const [task] = s.ledgerOf(1).tasks;
    assert.equal(task.tier, null);
    assert.equal(task.effectiveTier, null);
  });
});

test('ledgers: saveLedger and ledgerOf round-trip the declared and the effective tier', () => {
  withEnv(({ dir, open }) => {
    const s = open();
    const { repoId } = seedRepo(s, dir);
    const ledger = createLedger({
      plan: 'p.md', spec: null, branch: null, now: NOW,
      tasks: [
        { id: 'T1', title: 'a', deps: [], skills: [], role: null, tier: 'heavy' },
        { id: 'T2', title: 'b', deps: [], skills: [], role: null, tier: null },
      ],
    });
    ledger.tasks[1].effectiveTier = 'light';
    const planId = s.upsertPlan(repoId, { path: 'p.md', spec: null, branch: null, state: 'active' });
    s.saveLedger(planId, ledger);
    assert.deepEqual(s.ledgerOf(planId), ledger);
    assert.deepEqual(s.all('SELECT key, tier, effective_tier FROM tasks ORDER BY position').map((r) => ({ ...r })), [
      { key: 'T1', tier: 'heavy', effective_tier: 'heavy' },
      { key: 'T2', tier: null, effective_tier: 'light' },
    ]);
    // An upsert replaces both.
    ledger.tasks[1].effectiveTier = 'heavy';
    s.saveLedger(planId, ledger);
    assert.equal(s.ledgerOf(planId).tasks[1].effectiveTier, 'heavy');
  });
});
