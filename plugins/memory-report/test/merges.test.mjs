// Merge suggestions (repo-identity spec 5.4, Ruling A): groups, `into`, `from`, worktree commands, `stranded`, the bun and
// claude-mem lookups, POSIX quoting and the sqlite backup line. Printed only: nothing here runs bun or claude-mem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';
import { findBun, mergeSuggestions, shellQuote, NOTE_NO_BUN, NOTE_NO_INSTALL, NOTE_STRANDED, NOTE_UNSAFE, NOTE_UNSAFE_PATH } from '../lib/merges.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
// Node 22's node:sqlite reads a stored NUL-holding string cut at the NUL; Node 24 keeps it. Fixtures expect names as
// this Node reads them back.
const NUL_KEPT = (() => {
  if (!hasSqlite) return true;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('a\u0000b');
    return db.prepare('SELECT v FROM t').get().v === 'a\u0000b';
  } finally {
    db.close();
  }
})();
const readBack = (name) => (NUL_KEPT ? name : name.split('\u0000')[0]);
const hasSqliteCli = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86400000;
const BUN = '/fake/bin/bun';
const INSTALL = '/fake/plugins/cache/thedotmack/claude-mem/1.0.0';
const WORKER = `${INSTALL}/scripts/worker-service.cjs`;

// A folder as resolveRepos returns it: `root` with one origin by default.
function folder(origin, over = {}) {
  const repos = origin === null ? [] : [origin];
  return {
    status: 'root', origin, remotes: repos, unresolvedRemote: false, stored: new Set(repos),
    everNested: false, everUnresolvedRemote: false, everNoOrigin: false, ...over,
  };
}

// A hand-built resolution: folders by cwd and the folders each key used.
function reposOf(folders, keyFolders) {
  const f = new Map(Object.entries(folders));
  const keys = new Map();
  for (const [key, cwds] of Object.entries(keyFolders)) {
    const entry = { repos: new Set(), unknown: false, folders: new Set(cwds) };
    for (const cwd of cwds) {
      const x = f.get(cwd);
      for (const r of [...x.stored, ...x.remotes, ...(x.origin ? [x.origin] : [])]) entry.repos.add(r);
      if (x.status === 'unknown') entry.unknown = true;
    }
    keys.set(key, entry);
  }
  return { folders: f, keys, complete: true, rebuilt: false, error: null };
}

let nextId = 1;
const row = (project, over = {}) => ({
  id: nextId++, project, merged_into_project: null, type: 'decision', title: 't', narrative: 'n', facts: '[]',
  created_at_epoch: NOW - 5 * DAY, ...over,
});
const rows = (project, n, over = {}) => Array.from({ length: n }, () => row(project, over));

// A fake filesystem for the lookups: only the listed paths exist.
const only = (...paths) => (p) => paths.includes(p);
// Options under which bun and the install are both found.
const found = (paths, over = {}) => ({
  pluginsFile: join(paths.home, 'installed_plugins.json'), env: { PATH: '/fake/bin' }, nowIso: NOW_ISO,
  exists: only(BUN, WORKER), ...over,
});
const pluginsJson = (entries) => JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': entries, 'other@market': [{ scope: 'user', installPath: '/elsewhere' }] } });

// A temp home with a fixture database of `observations` and the plugins file; fn({ ctx, paths, home }).
async function withMergeDb(observations, fn, { plugins = [{ scope: 'project', installPath: '/fake/project-scope' }, { scope: 'user', installPath: INSTALL }] } = {}) {
  await withTempHome(async ({ paths, home }) => {
    mkdirSync(paths.claudeMemDir, { recursive: true });
    createClaudeMemDb(paths.dbFile, { observations });
    if (plugins !== null) writeFileSync(join(home, 'installed_plugins.json'), pluginsJson(plugins));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(paths.dbFile, { readOnly: true });
    try {
      await fn({ ctx: { db, paths, now: () => NOW }, paths, home });
    } finally {
      db.close();
    }
  });
}

const APP = 'github.com/acme/app';
const q = shellQuote;
const merge = (from, into, dry) => `${q(BUN)} ${q(WORKER)} project merge ${q(from)} ${q(into)}${dry ? ' --dry-run' : ''}`;
const backupFor = (paths) => `sqlite3 ${q(paths.dbFile)} ${q(`.backup "${paths.stateDir}/claude-mem-backup-2026-10-07T12-00-00-000Z.db"`)}`;

// Splits a printed command line into words with /bin/sh (a POSIX shell-word splitter): printf prints each word, so
// nothing named in the line runs.
const shellWords = (line) => execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' }).split('\0').slice(0, -1);

// ---- groups, into, from, worktrees, stranded ---------------------------------------------------------------------------

test('mergeSuggestions: into is the existing target; partly merged from; worktree commands; stranded rows', { skip }, async () => {
  const observations = [
    ...rows('new', 2),
    ...rows('old', 2, { merged_into_project: 'new' }), // partly merged: one row of `old` is still unmerged
    ...rows('old', 1),
    ...rows('older', 1, { created_at_epoch: NOW - DAY }), // the newest row, but `new` is already the target
    ...rows('old/wt', 1),
    ...rows('stray', 1, { merged_into_project: 'old' }), // points at a from name: no printed command moves it
  ];
  const repos = reposOf(
    { '/f/new': folder(APP), '/f/old': folder(APP), '/f/older': folder(APP) },
    { new: ['/f/new'], old: ['/f/old'], 'old/wt': ['/f/old'], older: ['/f/older'] },
  );
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const merges = mergeSuggestions(ctx, repos, found(paths));
    assert.deepEqual(merges, [{
      repo: APP,
      into: 'new',
      from: ['old', 'older'],
      worktrees: ['old/wt'],
      stranded: 1,
      commands: {
        backup: backupFor(paths),
        dryRun: [merge('old', 'new', true), merge('older', 'new', true), merge('old/wt', 'new', true)],
        run: [merge('old', 'new', false), merge('older', 'new', false), merge('old/wt', 'new', false)],
      },
      note: NOTE_STRANDED,
    }]);
  });
});

test('mergeSuggestions: with several existing targets, into is the one most rows point at', { skip }, async () => {
  const observations = [
    ...rows('a', 2, { merged_into_project: 'c' }),
    ...rows('b', 1, { merged_into_project: 'a' }),
    ...rows('a', 1), ...rows('b', 1, { created_at_epoch: NOW - DAY }), ...rows('c', 1),
  ];
  const tool = 'github.com/acme/tool';
  const repos = reposOf({ '/f/a': folder(tool), '/f/b': folder(tool), '/f/c': folder(tool) }, { a: ['/f/a'], b: ['/f/b'], c: ['/f/c'] });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, repos, found(paths));
    assert.equal(m.into, 'c');
    assert.deepEqual(m.from, ['a', 'b']);
    assert.equal(m.stranded, 1); // the `b` row already pointing at `a`
  });
});

test('mergeSuggestions: with no existing target, into is the member with the newest observation', { skip }, async () => {
  const observations = [...rows('x', 2), ...rows('y', 1, { created_at_epoch: NOW - DAY })];
  const repos = reposOf({ '/f/x': folder(APP), '/f/y': folder(APP) }, { x: ['/f/x'], y: ['/f/y'] });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, repos, found(paths));
    assert.deepEqual([m.into, m.from, m.worktrees, m.stranded, m.note], ['y', ['x'], [], 0, null]);
  });
});

test('mergeSuggestions: no group for one name, a folder with two repositories, an unknown or nested folder, or nothing left to merge', { skip }, async () => {
  const observations = [
    ...rows('solo', 1), ...rows('two', 1), ...rows('twin', 1), ...rows('u', 1), ...rows('nest', 1), ...rows('sib', 1),
    ...rows('done', 2, { merged_into_project: 'kept' }), ...rows('kept', 1),
  ];
  const other = 'github.com/acme/other';
  const repos = reposOf({
    '/f/solo': folder('github.com/acme/solo'),
    '/f/two': folder(other, { remotes: [other, 'github.com/client/other'], stored: new Set([other, 'github.com/client/other']) }),
    '/f/twin': folder(other),
    '/f/u': folder(null, { status: 'unknown' }),
    '/f/nest': folder(APP, { status: 'nested' }),
    '/f/sib': folder(APP),
    '/f/done': folder('github.com/acme/done'),
    '/f/kept': folder('github.com/acme/done'),
  }, {
    solo: ['/f/solo'], two: ['/f/two'], twin: ['/f/twin'], u: ['/f/u'], nest: ['/f/nest'], sib: ['/f/sib'],
    done: ['/f/done'], kept: ['/f/kept'],
  });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    assert.deepEqual(mergeSuggestions(ctx, repos, found(paths)), []);
  });
});

// ---- quoting -------------------------------------------------------------------------------------------------------------

test('shellQuote: every argument single-quoted, every quote written as \'\\\'\'', () => {
  assert.equal(shellQuote('Delta Works'), "'Delta Works'");
  assert.equal(shellQuote("a' 'b"), "'a'\\'' '\\''b'");
  assert.equal(shellQuote(''), "''");
});

test('mergeSuggestions: names with spaces and quotes are quoted, and the shell splits them back exactly', { skip }, async () => {
  const names = ['Delta Works', "a' 'b"];
  const observations = [...rows(names[0], 1, { created_at_epoch: NOW - DAY }), ...rows(names[1], 1)];
  const repos = reposOf({ '/f/d': folder(APP), '/f/q': folder(APP) }, { [names[0]]: ['/f/d'], [names[1]]: ['/f/q'] });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, repos, found(paths));
    assert.equal(m.commands.run[0], `'${BUN}' '${WORKER}' project merge 'a'\\'' '\\''b' 'Delta Works'`);
    assert.deepEqual(shellWords(m.commands.run[0]), [BUN, WORKER, 'project', 'merge', "a' 'b", 'Delta Works']);
    assert.deepEqual(shellWords(m.commands.dryRun[0]), [BUN, WORKER, 'project', 'merge', "a' 'b", 'Delta Works', '--dry-run']);
  });
});

test('mergeSuggestions: a state dir with \', ", $ and a backtick gives a backup line the shell splits back and sqlite accepts', { skip }, async () => {
  const observations = [...rows('x', 1), ...rows('y', 1, { created_at_epoch: NOW - DAY })];
  const repos = reposOf({ '/f/x': folder(APP), '/f/y': folder(APP) }, { x: ['/f/x'], y: ['/f/y'] });
  await withMergeDb(observations, async ({ ctx, paths, home }) => {
    const stateDir = join(home, 'st\'a"te $HOME `x` \\n');
    mkdirSync(stateDir, { recursive: true });
    const weird = { ...ctx, paths: { ...paths, stateDir } };
    const [m] = mergeSuggestions(weird, repos, found(paths));
    const backupPath = join(stateDir, 'claude-mem-backup-2026-10-07T12-00-00-000Z.db');
    const dq = (s) => s.replace(/[\\"]/g, (c) => `\\${c}`);
    assert.deepEqual(shellWords(m.commands.backup), ['sqlite3', paths.dbFile, `.backup "${dq(backupPath)}"`]);
    if (!hasSqliteCli) return; // the shell check above still ran
    execFileSync('/bin/sh', ['-c', m.commands.backup], { stdio: 'pipe' });
    assert.ok(existsSync(backupPath), 'sqlite wrote the backup where the line says');
  });
});

test('mergeSuggestions: a name with leading or trailing whitespace, a leading - or a control character gets no command, only a note', { skip }, async () => {
  // fix 1 M6: a single leading `-`; fix 1 I1: C0 controls (newline, CR, ESC, NUL) and C1 controls.
  const unsafe = [' lead', 'trail ', '--flag', '-x', 'nl\nx', 'cr\rx', 'esc\u001b[2Kx', 'nul\u0000z', 'c1\u009bx', 'del\u007fx'];
  const observations = [...rows('base', 1, { created_at_epoch: NOW - DAY }), ...rows('ok', 1), ...unsafe.flatMap((n) => rows(n, 1))];
  const folders = { '/f/base': folder(APP), '/f/ok': folder(APP) };
  const keys = { base: ['/f/base'], ok: ['/f/ok'] };
  // Keyed as a real resolution reads the same database (a NUL-holding name comes back cut on Node 22).
  unsafe.forEach((n, i) => { folders[`/f/u${i}`] = folder(APP); keys[readBack(n)] = [`/f/u${i}`]; });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, reposOf(folders, keys), found(paths));
    assert.equal(m.into, 'base');
    assert.deepEqual(m.from, [...unsafe.map(readBack), 'ok'].sort());
    assert.deepEqual(m.commands.run, [merge('ok', 'base', false)]);
    assert.deepEqual(m.commands.dryRun, [merge('ok', 'base', true)]);
    assert.equal(m.note, NOTE_UNSAFE);
  });
  // An unsafe `into` leaves no command at all.
  const intoUnsafe = [...rows(' top', 1, { created_at_epoch: NOW - DAY }), ...rows('ok', 1)];
  await withMergeDb(intoUnsafe, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, reposOf({ '/f/t': folder(APP), '/f/ok': folder(APP) }, { ' top': ['/f/t'], ok: ['/f/ok'] }), found(paths));
    assert.deepEqual([m.into, m.from, m.commands, m.note], [' top', ['ok'], null, NOTE_UNSAFE]);
  });
});

test('final fix M3: a name with a line separator or a bidi or invisible format character gets no command, only a note', { skip }, async () => {
  const unsafe = ['ls\u2028x', 'ps\u2029x', 'alm\u061cx', 'zw\u200bx', 'lrm\u200ex', 'rlo\u202ex', 'lri\u2066x', 'pdi\u2069x', 'bom\ufeffx'];
  const observations = [...rows('base', 1, { created_at_epoch: NOW - DAY }), ...rows('ok', 1), ...unsafe.flatMap((n) => rows(n, 1))];
  const folders = { '/f/base': folder(APP), '/f/ok': folder(APP) };
  const keys = { base: ['/f/base'], ok: ['/f/ok'] };
  unsafe.forEach((n, i) => { folders[`/f/u${i}`] = folder(APP); keys[n] = [`/f/u${i}`]; });
  await withMergeDb(observations, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, reposOf(folders, keys), found(paths));
    assert.deepEqual(m.from, [...unsafe, 'ok'].sort());
    assert.deepEqual(m.commands.run, [merge('ok', 'base', false)]);
    assert.equal(m.note, NOTE_UNSAFE);
  });
  for (const into of ['rlo\u202einto', 'ls\u2028into']) {
    await withMergeDb([...rows(into, 1, { created_at_epoch: NOW - DAY }), ...rows('ok', 1)], async ({ ctx, paths }) => {
      const [m] = mergeSuggestions(ctx, reposOf({ '/f/t': folder(APP), '/f/ok': folder(APP) }, { [into]: ['/f/t'], ok: ['/f/ok'] }), found(paths));
      assert.deepEqual([m.into, m.commands, m.note], [into, null, NOTE_UNSAFE]);
    });
  }
});

// ---- locating bun and claude-mem -----------------------------------------------------------------------------------------

const pair = [...rows('x', 1), ...rows('y', 1, { created_at_epoch: NOW - DAY })];
const pairRepos = () => reposOf({ '/f/x': folder(APP), '/f/y': folder(APP) }, { x: ['/f/x'], y: ['/f/y'] });

test('mergeSuggestions: with no bun, names only plus a note', { skip }, async () => {
  await withMergeDb(pair, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, pairRepos(), found(paths, { exists: only(WORKER) }));
    assert.deepEqual([m.into, m.from, m.commands, m.note], ['y', ['x'], null, NOTE_NO_BUN]);
  });
});

test('mergeSuggestions: with no user entry in installed_plugins.json the first entry is used', { skip }, async () => {
  const first = '/fake/first-scope';
  await withMergeDb(pair, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, pairRepos(), found(paths, { exists: only(BUN, `${first}/scripts/worker-service.cjs`) }));
    assert.equal(m.commands.run[0], `'${BUN}' '${first}/scripts/worker-service.cjs' project merge 'x' 'y'`);
  }, { plugins: [{ scope: 'project', installPath: first }, { scope: 'local', installPath: '/fake/second' }] });
});

test('mergeSuggestions: a missing install, or no claude-mem entry or plugins file, gives names only plus a note', { skip }, async () => {
  await withMergeDb(pair, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, pairRepos(), found(paths, { exists: only(BUN) })); // listed, but its script is absent
    assert.deepEqual([m.from, m.commands, m.note], [['x'], null, NOTE_NO_INSTALL]);
  });
  await withMergeDb(pair, async ({ ctx, paths }) => {
    const [m] = mergeSuggestions(ctx, pairRepos(), found(paths));
    assert.deepEqual([m.commands, m.note], [null, NOTE_NO_INSTALL]);
  }, { plugins: null });
});

test('mergeSuggestions: the plugins file is read from CLAUDE_CONFIG_DIR, and bun from BUN, on real temp files', { skip }, async () => {
  await withMergeDb(pair, async ({ ctx, home }) => {
    const configDir = join(home, 'claude-config');
    const install = join(home, 'install');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    mkdirSync(join(install, 'scripts'), { recursive: true });
    writeFileSync(join(install, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), pluginsJson([{ scope: 'user', installPath: install }]));
    const bun = join(home, 'bun-here');
    writeFileSync(bun, '');
    const [m] = mergeSuggestions(ctx, pairRepos(), { env: { CLAUDE_CONFIG_DIR: configDir, BUN: bun }, nowIso: NOW_ISO });
    assert.equal(m.commands.run[0], `${q(bun)} ${q(join(install, 'scripts', 'worker-service.cjs'))} project merge 'x' 'y'`);
  }, { plugins: null });
});

test('mergeSuggestions: a control character in the bun path, the install path, the database file or the state dir gives no command at all (fix 1 I1)', { skip }, async () => {
  const twoGroups = [...pair, ...rows('p', 1), ...rows('q', 1, { created_at_epoch: NOW - DAY })];
  const repos = () => reposOf(
    { '/f/x': folder(APP), '/f/y': folder(APP), '/f/p': folder('github.com/acme/two'), '/f/q': folder('github.com/acme/two') },
    { x: ['/f/x'], y: ['/f/y'], p: ['/f/p'], q: ['/f/q'] },
  );
  const badBun = '/fake/bin\u001b[2K/bun';
  const badInstall = '/fake/in\nstall';
  const cases = [
    { label: 'bun', opts: { env: { BUN: badBun }, exists: only(badBun, WORKER) } },
    { label: 'install', opts: { exists: only(BUN, `${badInstall}/scripts/worker-service.cjs`) }, plugins: [{ scope: 'user', installPath: badInstall }] },
    { label: 'db file', opts: {}, paths: (p) => ({ ...p, dbFile: `${p.home}/claude-mem\r.db` }) },
    { label: 'state dir', opts: {}, paths: (p) => ({ ...p, stateDir: `${p.home}/st\u0000ate` }) },
  ];
  for (const { label, opts, paths, plugins } of cases) {
    await withMergeDb(twoGroups, async ({ ctx, paths: p }) => {
      const c = paths === undefined ? ctx : { ...ctx, paths: paths(p) };
      const merges = mergeSuggestions(c, repos(), found(p, opts));
      assert.equal(merges.length, 2, label);
      for (const m of merges) {
        assert.equal(m.commands, null, label);
        assert.equal(m.note, NOTE_UNSAFE_PATH, label);
      }
    }, plugins === undefined ? undefined : { plugins });
  }
});

test('findBun: PATH, then BUN, BUN_PATH, BUN_INSTALL/bin/bun, BUN_INSTALL/bun, ~/.bun/bin/bun, /usr/local/bin/bun and Homebrew', () => {
  const env = { PATH: '/p1:relative:/p2', BUN: ' /env/bun ', BUN_PATH: '/env/bun-path\n', BUN_INSTALL: '  /inst ' };
  const order = ['/p2/bun', '/env/bun', '/env/bun-path', '/inst/bin/bun', '/inst/bun', '/h/.bun/bin/bun', '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];
  for (let i = 0; i < order.length; i += 1) {
    assert.equal(findBun({ env, home: '/h', exists: only(...order.slice(i)) }), order[i], order[i]);
  }
  assert.equal(findBun({ env, home: '/h', exists: only('relative/bun') }), null); // a relative PATH entry is skipped
  assert.equal(findBun({ env: {}, home: '/h', exists: () => false }), null);
});
