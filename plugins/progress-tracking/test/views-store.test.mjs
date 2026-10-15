// Store-mode views (plan tracking-store-1 T8): SessionStart built from the store, `triqual tracking status` and `log`,
// and the UI's snapshots of store repositories. Every test works in temp repositories with a temp HOME, a temp
// TRIQUAL_TRACKING_DB and a temp registry dir; no test touches a real data directory. A store repository is made from
// a committed one (same files in a twin that stays committed): `tracking import` fills the store, then the marker is
// set, so the committed twin is the reference for every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { StoreError, loadSqlite, openStore } from '../lib/store.mjs';
import { SNAPSHOT_SCHEMA, buildSnapshot, readStoreViews, statusText } from '../lib/snapshot.mjs';
import { resolveTracking } from '../lib/tracking.mjs';
import { storeNotice } from '../scripts/gate.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(PLUGIN, 'cli', 'tasks.mjs');
const TRACKING = join(PLUGIN, 'cli', 'tracking.mjs');
const GATE = join(PLUGIN, 'scripts', 'gate.mjs');
const UI = join(PLUGIN, 'cli', 'ui.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NOT_IN_STORE = 'not in store mode: run triqual progress-init --store';
const NAME = '2026-10-11-example';
const NODE22 = process.env.TRIQUAL_TEST_NODE22 ?? '/opt/homebrew/opt/node@22/bin/node';

await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

const PLAN = `# Example plan

### Task 1: Alpha

### Task 2: Beta

### Task 3: Gamma
**Depends on:** T1
`;
const STATUS = `# Status

**Last updated:** 2026-10-11

## Overview

Things are fine.

## Risks

- none yet
`;
// Oldest last, as progress.md keeps them. The middle entry carries a field the store has no column for (Notes), so only
// its original text can show it.
const PROGRESS = `# Progress

## 2026-10-11 — Third change
- **Stage/task:** Plan alpha-plan · T2
- **Done:** wired the thing
- **Files:** c.mjs
- **Verification:** npm test: 3 passed
- **Commit:** this commit
- **Next:** T3

## 2026-10-10 — Second change
- **Stage/task:** Plan beta-plan · T1
- **Done:** parsed the other thing
- **Files:** b.mjs
- **Verification:** npm test: 2 passed
- **Notes:** kept only in the original
- **Commit:** this commit
- **Next:** T2

## 2026-10-09 — First change
- **Stage/task:** Plan alpha-plan · T1
- **Done:** started
- **Files:** a.mjs
- **Verification:** npm test: 1 passed
- **Commit:** this commit
- **Next:** T2
`;
const DRAFT = `## 2026-10-12 — Added entry
- **Stage/task:** off-plan
- **Done:** added through the CLI
- **Files:** d.mjs
- **Verification:** none needed
- **Next:** more
`;

// A clean environment: no inherited GIT_* repo selection, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'CLAUDE_PLUGIN_DATA']) delete env[k];
  return { ...env, ...extra };
};

// A temp dir holding HOME, the store path, a registry dir and two committed repositories with the same files, `a`
// (stays committed) and `b` (imported into the store and marked). fn gets the runners.
function withPair(fn, { markB = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-views-')));
  const home = join(dir, 'home');
  const registryDir = join(dir, 'registry');
  const dbFile = join(dir, 'data', 'tracking.db');
  for (const d of [home, registryDir]) mkdirSync(d);
  const dbEnv = { TRIQUAL_TRACKING_DB: dbFile, TRIQUAL_REGISTRY_DIR: registryDir };
  const env = (extra = {}) => cleanEnv(home, { ...dbEnv, ...extra });
  const git = (cwd, ...args) => {
    const r = spawnSync('git', [...ID, ...args], { cwd, env: env(), encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (bin, cwd, args, { node = process.execPath, extraEnv = {}, input } = {}) => spawnSync(node, [bin, ...args], {
    cwd, env: env(extraEnv), encoding: 'utf8', input,
  });
  const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
  const makeRepo = (name, { plan = true } = {}) => {
    const repo = join(dir, name);
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    writeFileSync(join(repo, 'progress.md'), PROGRESS);
    writeFileSync(join(repo, 'status.md'), STATUS);
    if (plan) writeFileSync(join(repo, 'docs', 'plans', `${NAME}.md`), PLAN);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
    if (plan) ok(run(TASKS, repo, ['init', `docs/plans/${NAME}.md`]));
    return repo;
  };
  const a = makeRepo('a');
  const b = makeRepo('b');
  ok(run(TRACKING, b, ['import']));
  if (markB) git(b, 'config', '--local', 'triqual.tracking', 'store');
  const session = (repo, args = []) => run(GATE, repo, ['session-start', ...args], { input: JSON.stringify({ cwd: repo }) });
  // The additionalContext of a SessionStart run.
  const context = (r) => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const inStore = (f) => {
    const store = openStore({ home, env: dbEnv });
    try { return f(store); } finally { store.close(); }
  };
  try {
    return fn({ dir, home, a, b, dbFile, dbEnv, env, git, run, ok, session, context, inStore, makeRepo });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What follows the mode header: the status.md block onwards.
const afterHeader = (ctx) => ctx.slice(ctx.indexOf('=== status.md ==='));

// ---- SessionStart ----

test('SessionStart in store mode equals the committed context from the same files, except the mode header', () => {
  withPair(({ a, b, ok, run, session, context }) => {
    const committed = context(session(a));
    const store = context(session(b));
    assert.notEqual(store.slice(0, store.indexOf('=== status.md ===')), committed.slice(0, committed.indexOf('=== status.md ===')));
    assert.match(store, /^This repo uses strict progress tracking in store mode/);
    assert.equal(afterHeader(store), afterHeader(committed));
    // The latest entry is the newest one, and the status sections come in order.
    assert.match(store, /=== Latest progress\.md entry ===\n## 2026-10-11 — Third change\n/);
    assert.ok(store.indexOf('## Overview') < store.indexOf('## Risks'));
    assert.ok(!store.includes('Second change'), 'only the latest entry');
    assert.match(store, new RegExp(`=== Active plans ===\\n${NAME}: 0/3 done · in progress: none · next: T1$`));

    // The active plans are live: a transition shows at once on both sides, and still agrees.
    ok(run(TASKS, a, ['start', 'T1']));
    ok(run(TASKS, b, ['start', 'T1']));
    const startedStore = context(session(b));
    assert.match(startedStore, /in progress: T1 · next: T2/);
    assert.match(startedStore, /- In progress: T1 Alpha/);
    assert.equal(afterHeader(startedStore), afterHeader(context(session(a))));
  });
});

test('SessionStart in store mode stays within --budget and truncates the status like the other modes', () => {
  withPair(({ b, run, session, context }) => {
    const long = `${STATUS}\n## Notes\n\n${'a long line of notes. '.repeat(400)}\n`;
    const draft = join(dirname(b), 'long-status.md');
    writeFileSync(draft, long);
    assert.equal(run(TRACKING, b, ['status', 'set', draft]).status, 0);
    for (const budget of ['1000', '2000', '9500']) {
      const r = session(b, ['--budget', budget]);
      const out = r.stdout;
      assert.ok(out.length < Number(budget), `${budget}: output is ${out.length} characters`);
      context(r);
    }
    assert.match(context(session(b, ['--budget', '2000'])), /\[status\.md truncated: read the full file\]/);
  });
});

test('SessionStart on a store error prints one notice line and exits 0', () => {
  withPair(({ b, session, dbFile, run }) => {
    const notice = (r, pattern) => {
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.ok(!ctx.includes('\n'), `one line: ${JSON.stringify(ctx)}`);
      assert.doesNotMatch(ctx, /\bat .*\.mjs:\d+/, 'no stack trace');
      assert.match(ctx, pattern);
      return ctx;
    };
    const healthy = session(b);
    assert.match(JSON.parse(healthy.stdout).hookSpecificOutput.additionalContext, /=== status\.md ===/);

    // disabled: an override that is not an absolute path. It runs with the fixture's own HOME and registry dir, so the
    // SessionStart registration never lands in the shared OS temp dir.
    const sharedConfig = join(realpathSync(tmpdir()), '.config');
    const listing = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : null);
    const leakBefore = listing(sharedConfig);
    const disabled = run(GATE, b, ['session-start'], { extraEnv: { TRIQUAL_TRACKING_DB: 'relative.db' }, input: JSON.stringify({ cwd: b }) });
    notice(disabled, /\(disabled\)/);
    assert.deepEqual(listing(sharedConfig), leakBefore, 'nothing is created under the OS temp dir\'s .config');

    // corrupt: not an SQLite file
    writeFileSync(dbFile, 'this is not a database\n'.repeat(20));
    notice(session(b), /\(open\).*not a tracking database/);

    // older schema: a valid SQLite file with no schema
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
    const older = new DatabaseSync(dbFile);
    older.exec('CREATE TABLE x (y INTEGER)');
    older.close();
    notice(session(b), /\(open\).*older than this triqual/);

    // missing: no database file at all
    rmSync(dbFile, { force: true });
    const ctx = notice(session(b), /\(missing\).*triqual tracking restore/);
    assert.ok(ctx.includes(dbFile), 'names the database path');
  });
});

test('a non-store error in SessionStart is one line naming the error, with no stack and no restore advice', () => {
  const io = { home: '/nowhere', env: { TRIQUAL_TRACKING_DB: '/nowhere/tracking.db' } };
  const bug = (() => { try { null.x; } catch (e) { return e; } })();
  assert.ok(bug instanceof TypeError && bug.stack.includes('\n'));
  const line = storeNotice(bug, io, 9500);
  assert.ok(!line.includes('\n'), 'one line');
  assert.ok(line.includes(bug.message), line);
  assert.match(line, /TypeError/);
  assert.doesNotMatch(line, /restore/);
  assert.doesNotMatch(line, /\bat .*:\d+/, 'no stack trace');
  // A store failure keeps its words, restore advice included.
  const store = storeNotice(new StoreError('missing', 'no database here'), io, 9500);
  assert.match(store, /\(missing\)/);
  assert.match(store, /triqual tracking restore/);
  // An SQLite error thrown after the open (a busy or corrupt database) is a store failure too.
  const sqlite = Object.assign(new Error('database disk image is malformed'), { errcode: 11 });
  assert.match(storeNotice(sqlite, io, 9500), /triqual tracking restore/);
});

test('SessionStart says, neutrally, that a store-marked repository has no rows yet, and never suggests an import', () => {
  withPair(({ b, dir, git, session, context, dbFile }) => {
    const c = join(dir, 'c');
    mkdirSync(c);
    git(c, 'init', '-q', '-b', 'main');
    git(c, 'config', '--local', 'triqual.tracking', 'store');
    const ctx = context(session(c));
    const line = `this repository has no rows in the tracking store at ${dbFile} yet`;
    assert.equal(ctx.split('\n').filter((l) => l === line).length, 1, ctx);
    assert.doesNotMatch(ctx, /tracking import/);
    assert.match(ctx, /=== status\.md ===/);
    // A repository the store holds has no such line.
    assert.ok(!context(session(b)).includes('has no rows in the tracking store'));
    // And it stays within the budget.
    assert.ok(session(c, ['--budget', '1000']).stdout.length < 1000);
  });
});

test('SessionStart shows the newest entry that is committed or belongs to this worktree, not another worktree\'s draft', () => {
  withPair(({ b, dir, git, run, ok, session, context }) => {
    const b2 = join(dir, 'b2');
    git(b, 'worktree', 'add', '-q', '-b', 'side', b2);
    const draft = (title) => {
      const file = join(dir, `${title.replace(/\W/g, '-')}.md`);
      writeFileSync(file, DRAFT.replace('Added entry', title));
      return file;
    };
    const latest = (ctx) => /=== Latest progress\.md entry ===\n## [^\n]* — ([^\n]*)/.exec(ctx)?.[1];
    ok(run(TRACKING, b2, ['add', draft('Side draft')]));
    // The draft is pending in b2: b2 sees it, b does not.
    assert.equal(latest(context(session(b2))), 'Side draft');
    assert.equal(latest(context(session(b))), 'Third change');
    // The log keeps the whole repository, every entry with its state.
    const rows = JSON.parse(ok(run(TRACKING, b, ['log', '--json'])).stdout);
    assert.deepEqual(rows.map((r) => [r.title, r.state]), [['Side draft', 'pending'], ['Third change', 'committed'], ['Second change', 'committed'], ['First change', 'committed']]);
    // Once committed it belongs to the repository: b sees it too.
    ok(run(TRACKING, b2, ['add', '--commit', 'HEAD', draft('Side commit')]));
    assert.equal(latest(context(session(b))), 'Side commit');
    // A draft written with --no-commit is not pending, so it is shown wherever it was written.
    ok(run(TRACKING, b2, ['add', '--no-commit', draft('Side note')]));
    assert.equal(latest(context(session(b))), 'Side note');
  });
});

test('SessionStart and tracking status of a store repository with no plans carry no Active plan section, like status.md', () => {
  withPair(({ dir, makeRepo, run, ok, git, session, context }) => {
    const d = makeRepo('d', { plan: false });
    ok(run(TRACKING, d, ['import']));
    git(d, 'config', '--local', 'triqual.tracking', 'store');
    const status = ok(run(TRACKING, d, ['status'])).stdout;
    assert.equal(status, `${STATUS.trim()}\n`);
    assert.doesNotMatch(status, /Active plan/);
    const ctx = context(session(d));
    assert.doesNotMatch(ctx, /Active plan/);
    assert.ok(ctx.includes(STATUS.trim()), 'the recorded status.md, as it is');
    assert.equal(JSON.parse(ok(run(TRACKING, d, ['status', '--json'])).stdout).text, status);
    // The snapshot's status text is the same function.
    assert.equal(statusText([{ heading: 'preamble', body: '# S' }], []), '# S\n');
  });
});

// ---- tracking status ----

test('tracking status reprints the stored sections in order with the active plans rendered live', () => {
  withPair(({ a, b, ok, run }) => {
    const r = ok(run(TRACKING, b, ['status']));
    const text = r.stdout;
    assert.ok(text.indexOf('# Status') < text.indexOf('## Overview'));
    assert.ok(text.indexOf('## Overview') < text.indexOf('## Risks'));
    assert.ok(text.indexOf('## Risks') < text.indexOf('## Active plan'));
    assert.match(text, /Things are fine\./);
    assert.match(text, new RegExp(`### ${NAME} — 0/3 done\\n- Next: T1 Alpha`));
    assert.match(text, /<!-- tasks:start -->\n## Active plan/, 'the managed block keeps its markers');
    // The committed twin's status.md is the same text.
    assert.equal(text, readFileSync(join(a, 'status.md'), 'utf8'));

    ok(run(TASKS, b, ['start', 'T1']));
    assert.match(ok(run(TRACKING, b, ['status'])).stdout, /- In progress: T1 Alpha/);

    const json = JSON.parse(ok(run(TRACKING, b, ['status', '--json'])).stdout);
    assert.deepEqual(json.sections.map((s) => s.heading), ['preamble', 'Overview', 'Risks']);
    assert.deepEqual(json.plans.map((p) => [p.name, p.done, p.total, p.state]), [[NAME, 0, 3, 'active']]);
    assert.equal(json.text, ok(run(TRACKING, b, ['status'])).stdout);
  });
});

test('the status read, edit and set round trip keeps exactly one Active plan section, rendered live', () => {
  withPair(({ b, dir, ok, run }) => {
    const read = ok(run(TRACKING, b, ['status'])).stdout;
    assert.match(read, /<!-- tasks:start -->\n## Active plan\n/, 'the read keeps the managed block markers');
    assert.match(read, /<!-- tasks:end -->\n$/);
    assert.equal(JSON.parse(ok(run(TRACKING, b, ['status', '--json'])).stdout).text, read);
    const draft = join(dir, 'round.md');
    writeFileSync(draft, read.replace('Things are fine.', 'Things are fine, edited.'));
    ok(run(TRACKING, b, ['status', 'set', draft]));
    ok(run(TASKS, b, ['start', 'T1']));
    const after = ok(run(TRACKING, b, ['status'])).stdout;
    assert.equal(after.match(/^## Active plan$/gm).length, 1, 'one Active plan section');
    assert.match(after, /Things are fine, edited\./);
    assert.match(after, /- In progress: T1 Alpha/, 'live, not the stale stored copy');
  });
});

test('status set drops an unmarked Active plan section, with one stderr note, and stores the rest', () => {
  withPair(({ b, dir, ok, run, inStore }) => {
    const draft = join(dir, 'unmarked.md');
    writeFileSync(draft, `${STATUS}\n## Active plan\n\nstale copy\n`);
    const r = ok(run(TRACKING, b, ['status', 'set', draft]));
    assert.equal(r.stderr.match(/Active plan/g)?.length, 1, r.stderr);
    assert.match(r.stderr, /rendered live/);
    assert.match(r.stdout, /3 sections/);
    assert.deepEqual(inStore((s) => s.status(s.get('SELECT id FROM repos').id).map((x) => x.heading)), ['preamble', 'Overview', 'Risks']);
    // Without one, nothing is said.
    writeFileSync(draft, STATUS);
    assert.equal(ok(run(TRACKING, b, ['status', 'set', draft])).stderr, '');
  });
});

test('tracking status and log outside store mode exit 2 and say so', () => {
  withPair(({ a, run }) => {
    for (const args of [['status'], ['log'], ['status', '--json'], ['log', '--last', '1']]) {
      const r = run(TRACKING, a, args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stderr, `${NOT_IN_STORE}\n`);
    }
  });
});

test('tracking status keeps `status set` working and refuses --section without it', () => {
  withPair(({ b, run, ok }) => {
    const draft = join(dirname(b), 's.md');
    writeFileSync(draft, '# Status\n\n## Only\n\nthis\n');
    ok(run(TRACKING, b, ['status', 'set', draft]));
    const text = ok(run(TRACKING, b, ['status'])).stdout;
    assert.match(text, /## Only\n\nthis/);
    assert.ok(!text.includes('## Overview'));
    const r = run(TRACKING, b, ['status', '--section', 'Only']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--section applies to status set only/);
  });
});

// ---- tracking log ----

const headings = (stdout) => [...stdout.matchAll(/^## (.*)$/gm)].map((m) => m[1]);

test('tracking log prints the newest entries first, ten by default, and filters', () => {
  withPair(({ b, run, ok }) => {
    const all = ok(run(TRACKING, b, ['log'])).stdout;
    assert.deepEqual(headings(all), ['2026-10-11 — Third change', '2026-10-10 — Second change', '2026-10-09 — First change']);
    assert.deepEqual(headings(ok(run(TRACKING, b, ['log', '--last', '2'])).stdout), ['2026-10-11 — Third change', '2026-10-10 — Second change']);
    assert.deepEqual(headings(ok(run(TRACKING, b, ['log', '--plan', 'alpha-plan'])).stdout), ['2026-10-11 — Third change', '2026-10-09 — First change']);
    assert.deepEqual(headings(ok(run(TRACKING, b, ['log', '--grep', 'parsed the other'])).stdout), ['2026-10-10 — Second change']);
    assert.deepEqual(headings(ok(run(TRACKING, b, ['log', '--since', '2026-10-10'])).stdout), ['2026-10-11 — Third change', '2026-10-10 — Second change']);
    assert.deepEqual(headings(ok(run(TRACKING, b, ['log', '--since', '2026-10-10', '--plan', 'alpha-plan', '--last', '5'])).stdout), ['2026-10-11 — Third change']);
    const none = ok(run(TRACKING, b, ['log', '--grep', 'no entry says this']));
    assert.equal(none.stdout, '');
    // Entries are separated by one blank line, and an imported entry prints its original text, field and all.
    assert.match(all, /- \*\*Next:\*\* T3\n\n## 2026-10-10 — Second change\n/);
    assert.match(all, /- \*\*Notes:\*\* kept only in the original/);
  });
});

test('tracking log --json gives an array, an imported entry carrying its original', () => {
  withPair(({ b, run, ok }) => {
    const rows = JSON.parse(ok(run(TRACKING, b, ['log', '--json'])).stdout);
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.map((r) => r.title), ['Third change', 'Second change', 'First change']);
    assert.equal(rows[1].plan, 'beta-plan');
    assert.equal(rows[1].stage_task, 'Plan beta-plan · T1');
    assert.match(rows[1].original, /^## 2026-10-10 — Second change\n/);
    assert.match(rows[1].original, /Notes:\*\* kept only in the original/);
    assert.deepEqual(JSON.parse(ok(run(TRACKING, b, ['log', '--json', '--last', '1'])).stdout).map((r) => r.title), ['Third change']);
    assert.deepEqual(JSON.parse(ok(run(TRACKING, b, ['log', '--json', '--grep', 'zzz'])).stdout), []);
  });
});

test('tracking log prints an entry added by the CLI from its fields', () => {
  withPair(({ b, run, ok }) => {
    const draft = join(dirname(b), 'draft.md');
    writeFileSync(draft, DRAFT);
    ok(run(TRACKING, b, ['add', draft]));
    const [first] = ok(run(TRACKING, b, ['log', '--last', '1'])).stdout.trimEnd().split('\n\n');
    assert.match(first, /^## \d{4}-\d{2}-\d{2} — Added entry\n- \*\*Stage\/task:\*\* off-plan\n- \*\*Done:\*\* added through the CLI\n- \*\*Files:\*\* d\.mjs\n- \*\*Verification:\*\* none needed\n- \*\*Next:\*\* more$/);
  });
});

test('tracking log refuses bad flag values with exit 2', () => {
  withPair(({ b, run }) => {
    const cases = [
      [['--last', '0'], /log: --last takes a positive whole number, not "0"/],
      [['--last', 'x'], /log: --last takes a positive whole number, not "x"/],
      [['--last', '-1'], /--last/],
      [['--since', 'yesterday'], /log: --since takes a date as YYYY-MM-DD, not "yesterday"/],
      [['--since', '2026-13-45'], /log: --since takes a date as YYYY-MM-DD, not "2026-13-45"/],
      [['--plan'], /--plan/],
      [['--json=1'], /--json/],
      [['--section', 'x'], /--section applies to status set only/],
      [['extra'], /log: unexpected argument extra/],
    ];
    for (const [args, pattern] of cases) {
      const r = run(TRACKING, b, ['log', ...args]);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, pattern, args.join(' '));
      assert.match(r.stderr, /usage: triqual tracking write/);
    }
    const status = run(TRACKING, b, ['status', 'extra']);
    assert.equal(status.status, 2);
    assert.match(status.stderr, /status: unknown subcommand extra/);
  });
});

test('tracking log keeps the newest entry first when older entries are imported after it', () => {
  withPair(({ dir, makeRepo, run, ok, git }) => {
    const c = makeRepo('c');
    git(c, 'config', '--local', 'triqual.tracking', 'store');
    const draft = join(dir, 'newer.md');
    writeFileSync(draft, DRAFT);
    ok(run(TRACKING, c, ['add', '--commit', 'HEAD', draft]));
    // Their rows get later ids than the entry added above, but their dates are older.
    ok(run(TRACKING, c, ['import', '--ref', 'HEAD']));
    const rows = JSON.parse(ok(run(TRACKING, c, ['log', '--json'])).stdout);
    assert.deepEqual(rows.map((r) => r.title), ['Added entry', 'Third change', 'Second change', 'First change']);
    assert.ok(rows[0].id < rows[1].id, 'the imported rows have later ids');
    assert.deepEqual(JSON.parse(ok(run(TRACKING, c, ['log', '--json', '--last', '1'])).stdout).map((r) => r.title), ['Added entry']);
  });
});

// ---- one read transaction ----

test('the store views read everything inside one read transaction', () => {
  withPair(({ b, home, dbEnv }) => {
    const t = resolveTracking(b);
    assert.equal(t.mode, 'store');
    const events = [];
    const { prepare, exec } = DatabaseSync.prototype;
    DatabaseSync.prototype.prepare = function recordPrepare(sql) { events.push(['prepare', sql.trim()]); return prepare.call(this, sql); };
    DatabaseSync.prototype.exec = function recordExec(sql) { events.push(['exec', sql.trim()]); return exec.call(this, sql); };
    let views;
    try {
      views = readStoreViews(t, { home, env: dbEnv });
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      DatabaseSync.prototype.exec = exec;
    }
    assert.equal(views.entries.length, 3);
    const begin = events.findIndex(([kind, sql]) => kind === 'exec' && /^BEGIN\b/.test(sql));
    const commit = events.findIndex(([kind, sql]) => kind === 'exec' && /^COMMIT\b/.test(sql));
    assert.ok(begin >= 0 && commit > begin, JSON.stringify(events));
    const reads = events.map(([kind, sql], i) => [kind, sql, i]).filter(([kind, sql]) => kind === 'prepare' && /FROM (status|plans|tasks|task_events|entries)\b/.test(sql));
    assert.ok(reads.length >= 4, 'the views read the status, plans, tasks and entries');
    for (const [, sql, i] of reads) assert.ok(i > begin && i < commit, `outside the transaction: ${sql}`);
  });
});

test('a read transaction sees one snapshot while another connection commits', () => {
  withPair(({ b, home, dbEnv, dbFile }) => {
    const store = openStore({ home, env: dbEnv, readOnly: true });
    const writer = new DatabaseSync(dbFile);
    writer.exec('PRAGMA busy_timeout = 5000');
    try {
      const count = () => store.get('SELECT count(*) AS n FROM entries').n;
      const [first, second] = store.readTx(() => {
        const one = count();
        writer.exec(`INSERT INTO entries (repo_id, git_dir, created_at, title, stage_task, done, files, verification, next, state, parse_ok)
          SELECT id, 'g', '2026-10-12', 'late', 's', 'd', 'f', 'v', 'n', 'no_commit', 1 FROM repos LIMIT 1`);
        return [one, count()];
      });
      assert.equal(first, second, 'both reads saw the same snapshot');
      assert.equal(count(), first + 1, 'outside the transaction the new row is visible');
    } finally {
      writer.close();
      store.close();
    }
  });
});

// ---- the views are read-only ----

const stat = (path) => {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
};

for (const [label, node] of [['this node', process.execPath], ['node 22', NODE22]]) {
  test(`SessionStart, tracking status and tracking log write nothing, a repository the store never saw included (${label})`, {
    skip: node === NODE22 && !statSync(NODE22, { throwIfNoEntry: false }) ? 'node 22 not found' : false,
  }, () => {
    withPair(({ b, dir, git, dbFile, ok, run, inStore }) => {
      // A third repository, marked for store mode, that the store has no row for.
      const c = join(dir, 'c');
      mkdirSync(c);
      git(c, 'init', '-q', '-b', 'main');
      git(c, 'config', '--local', 'triqual.tracking', 'store');
      const rowsOf = () => inStore((s) => s.all('SELECT id, git_common_dir, root, shareable FROM repos ORDER BY id'));
      const before = rowsOf();
      assert.equal(before.length, 1, 'only the imported repository has a row');
      // A connection held open keeps the WAL file alive, so a write shows in tracking.db-wal (under WAL a write alone
      // does not touch tracking.db's mtime).
      const holder = new DatabaseSync(dbFile);
      holder.exec('PRAGMA busy_timeout = 5000');
      holder.prepare('SELECT count(*) FROM entries').get();
      try {
        const snapshot = () => [dbFile, `${dbFile}-wal`].map(stat);
        const files = snapshot();
        assert.notEqual(files[1], 'absent', 'the held connection keeps a WAL file');
        for (const repo of [b, c]) {
          const s = run(GATE, repo, ['session-start'], { node, input: JSON.stringify({ cwd: repo }) });
          assert.equal(s.status, 0);
          assert.equal(s.stderr, '');
          assert.match(JSON.parse(s.stdout).hookSpecificOutput.additionalContext, /=== status\.md ===/);
          for (const args of [['status'], ['status', '--json'], ['log'], ['log', '--json']]) {
            const r = run(TRACKING, repo, args, { node });
            assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
            assert.equal(r.stderr, '');
          }
        }
        assert.deepEqual(snapshot(), files, 'tracking.db and its WAL are untouched');
        assert.deepEqual(rowsOf(), before, 'no repos row was inserted');
        // The check can fail: a writing command moves the WAL.
        const draft = join(dir, 'w.md');
        writeFileSync(draft, DRAFT);
        ok(run(TRACKING, b, ['add', draft], { node }));
        assert.notDeepEqual(snapshot(), files, 'a write is visible in tracking.db or its WAL');
      } finally {
        holder.close();
      }
    });
  });
}

// ---- the UI ----

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` }, setHost: false, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A probe preloaded into the UI child: at exit it records whether node:sqlite was loaded.
const sqliteProbe = (out) => `import { writeFileSync } from 'node:fs';
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.moduleLoadList.includes('NativeModule sqlite'))));
`;

// Starts bin/ui.mjs as a child, fetches /api/snapshots, stops it with SIGTERM and returns [snapshots, sqliteWasLoaded].
async function uiRun({ cwd, env, probe, out }) {
  rmSync(out, { force: true });
  const child = spawn(process.execPath, ['--import', probe, UI], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (c) => {
        buf += c;
        const m = /triqual ui: http:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', (code) => reject(new Error(`ui exited early (${code})`)));
    });
    const r = await get(port, '/api/snapshots');
    assert.equal(r.status, 200);
    const snaps = JSON.parse(r.body);
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
    return [snaps, JSON.parse(readFileSync(out, 'utf8'))];
  } finally {
    child.kill('SIGKILL');
  }
}

// A temp dir with HOME, a registry, a store path and two committed repositories with the same files, each registered
// by its own SessionStart; `store-repo` is imported into the store and marked when `withStore`. The UI runs as a child
// process, so nothing here has loaded node:sqlite on its behalf.
async function withUiFixture({ withStore }, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-views-ui-')));
  try {
    const home = join(dir, 'home');
    const registryDir = join(dir, 'registry');
    mkdirSync(home);
    mkdirSync(registryDir);
    const env = cleanEnv(home, { TRIQUAL_TRACKING_DB: join(dir, 'data', 'tracking.db'), TRIQUAL_REGISTRY_DIR: registryDir });
    const sh = (bin, cwd, args) => {
      const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
    };
    const [storeRepo, committedRepo] = ['store-repo', 'committed-repo'].map((name) => {
      const repo = join(dir, name);
      mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
      sh('git', repo, ['init', '-q', '-b', 'main']);
      writeFileSync(join(repo, 'README.md'), '# repo\n');
      writeFileSync(join(repo, 'progress.md'), PROGRESS);
      writeFileSync(join(repo, 'status.md'), STATUS);
      writeFileSync(join(repo, 'docs', 'plans', `${NAME}.md`), PLAN);
      sh('git', repo, [...ID, 'add', '.']);
      sh('git', repo, [...ID, 'commit', '-qm', 'initial']);
      sh(process.execPath, repo, [TASKS, 'init', `docs/plans/${NAME}.md`]);
      return repo;
    });
    if (withStore) {
      sh(process.execPath, storeRepo, [TRACKING, 'import']);
      sh('git', storeRepo, ['config', '--local', 'triqual.tracking', 'store']);
    }
    for (const repo of [storeRepo, committedRepo]) sh(process.execPath, repo, [GATE, 'session-start']);
    const probe = join(dir, 'probe.mjs');
    const out = join(dir, 'loaded.json');
    writeFileSync(probe, sqliteProbe(out));
    return await fn({ storeRepo, committedRepo, ui: () => uiRun({ cwd: dir, env, probe, out }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('/api/snapshots includes a store repository with the schema id unchanged', () => withUiFixture({ withStore: true }, async ({ storeRepo, committedRepo, ui }) => {
  const [snaps, sqliteLoaded] = await ui();
  assert.equal(snaps.length, 2);
  const store = snaps.find((s) => s.repo.mode === 'store');
  const committed = snaps.find((s) => s.repo.mode === 'committed');
  assert.ok(store && committed, JSON.stringify(snaps.map((s) => s.repo)));
  assert.equal(store.schema, SNAPSHOT_SCHEMA);
  assert.equal(committed.schema, SNAPSHOT_SCHEMA);
  assert.equal(store.repo.root, storeRepo);
  assert.equal(committed.repo.root, committedRepo);
  assert.deepEqual(store.plans.map((p) => [p.name, p.done, p.total]), [[NAME, 0, 3]]);
  assert.deepEqual(store.progress.entries.map((e) => e.title), ['Third change', 'Second change', 'First change']);
  assert.match(store.status.text, /## Overview\n\nThings are fine\./);
  // Same views as the committed twin, apart from where they live.
  assert.deepEqual(store.plans, committed.plans);
  assert.deepEqual(store.progress.entries, committed.progress.entries);
  assert.equal(sqliteLoaded, true, 'the check can fail: a store repository loads node:sqlite');
}));

test('a store repository is shareable only when the registry and its frozen store row both say so', () => {
  withPair(({ a, b, home, dbEnv, inStore }) => {
    const now = new Date('2026-10-11T00:00:00Z');
    const snap = (repo, shareable) => buildSnapshot(resolveTracking(repo), { now, shareable, home, env: dbEnv }).repo.shareable;
    // The row was created by an import from a committed repository, as the registry then said: not shareable. A
    // repository switched from local mode is created the same way (shareable 0), whatever the registry says later.
    inStore((s) => assert.equal(s.get('SELECT shareable FROM repos').shareable, 0));
    assert.equal(snap(b, true), false, 'registry true, row 0');
    assert.equal(snap(b, false), false);
    inStore((s) => s.run('UPDATE repos SET shareable = 1'));
    assert.equal(snap(b, true), true, 'registry true, row 1');
    assert.equal(snap(b, false), false, 'registry false, row 1');
    // Committed repositories are unchanged: the registry alone decides.
    assert.equal(snap(a, true), true);
    assert.equal(snap(a, false), false);
  });
});

test('the UI never loads node:sqlite for committed and local repositories', () => withUiFixture({ withStore: false }, async ({ ui }) => {
  const [snaps, sqliteLoaded] = await ui();
  assert.deepEqual(snaps.map((s) => s.repo.mode), ['committed', 'committed']);
  assert.equal(sqliteLoaded, false);
}));
