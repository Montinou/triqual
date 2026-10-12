// The folder-keyed repository map and resolveRepos (repo-identity spec 2 and 3): resolution of every recorded folder,
// the budget and the concurrency cap, the 0600 always-written map with its re-read union, the sticky flags, the
// `rebuilt` rule, keyEvidence and emptyRepos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';
import { writeState } from '../lib/state.mjs';
import {
  childEnv, defaultRun, emptyRepos, keyEvidence, loadRepoMap, resolveRepos, saveRepoMap,
} from '../lib/repo.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';

const T0 = Date.parse('2026-10-09T03:00:00.000Z');
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, timedOut: false });
const never = () => new Promise(() => {});

// Folder behaviors for the scripted run below.
const missing = () => ({ kind: 'missing' });
const hang = () => ({ kind: 'hang' });
// remotes: { name: url }. `nested: true` reports the parent as the top level.
const repo = (remotes, { nested = false } = {}) => ({ kind: 'repo', remotes, nested });

// A fake run answering by folder: `script` maps a cwd to a behavior and may be changed between calls. `delayMs`
// delays every answer; `inFlight.max` records the most folders being resolved at once (from `stat` to the end of
// that folder's last command); `onCall(line)` runs before each answer.
function scriptedRun(script, { delayMs = 0, onCall } = {}) {
  const inFlight = { now: 0, max: 0 };
  const calls = [];
  const wait = () => (delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    onCall?.(line);
    const cwd = cmd === 'stat' ? args[0] : args[1];
    const behavior = script[cwd];
    if (behavior === undefined) throw new Error(`unexpected folder: ${line}`);
    if (cmd === 'stat') {
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
    }
    if (behavior.kind === 'hang') return never();
    await wait();
    const done = (result) => {
      inFlight.now -= 1;
      return result;
    };
    if (behavior.kind === 'missing') return done(fail(`stat: cannot stat '${cwd}': No such file or directory`));
    if (cmd === 'stat') return ok('stat output');
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') {
      const real = realpathSync(cwd);
      return ok(`${behavior.nested ? dirname(real) : real}\n`);
    }
    if (rest === 'remote get-url origin') {
      return Object.hasOwn(behavior.remotes, 'origin') ? ok(`${behavior.remotes.origin}\n`) : fail("error: No such remote 'origin'", 2);
    }
    if (rest === 'remote -v') {
      const lines = Object.entries(behavior.remotes).flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`]);
      return done(ok(lines.map((l) => `${l}\n`).join('')));
    }
    throw new Error(`unexpected command: ${line}`);
  };
  run.inFlight = inFlight;
  run.calls = calls;
  return run;
}

// A fake ssh -G: every host resolves to itself; `calls` records each host asked.
function fakeSsh() {
  const calls = [];
  const fn = async (host) => {
    calls.push(host);
    return host;
  };
  fn.calls = calls;
  return fn;
}

let nextSession = 1;
const session = (project, cwd, over = {}) => {
  const n = nextSession++;
  return { content_session_id: `c${n}`, memory_session_id: `m${n}`, project, cwd, started_at_epoch: T0 - HOUR, ...over };
};
const note = (memorySessionId, project, over = {}) => ({
  memory_session_id: memorySessionId, project, type: 'decision', title: 't', narrative: 'n', facts: '[]', created_at_epoch: T0 - HOUR, ...over,
});

// A temp home with a fixture database and `n` real folders (realpath needs them); fn({ paths, dirs, ctxFor, mapFile }).
// ctxFor(nowMs) opens a read-only context whose clock reads nowMs; every opened handle is closed at the end.
async function withFixture({ sessions = [], observations = [], dirs: n = 0 } = {}, fn) {
  await withTempHome(async ({ paths, home }) => {
    const dirs = Array.from({ length: n }, (_, i) => {
      const d = join(home, 'folders', `f${i}`);
      mkdirSync(d, { recursive: true });
      return d;
    });
    const resolvedSessions = typeof sessions === 'function' ? sessions(dirs) : sessions;
    const resolvedNotes = typeof observations === 'function' ? observations(dirs) : observations;
    mkdirSync(paths.claudeMemDir, { recursive: true });
    createClaudeMemDb(paths.dbFile, { sessions: resolvedSessions, observations: resolvedNotes });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const handles = [];
    const ctxFor = (nowMs = T0) => {
      const db = new DatabaseSync(paths.dbFile, { readOnly: true });
      handles.push(db);
      return { db, paths, now: () => nowMs };
    };
    try {
      await fn({ paths, dirs, ctxFor, mapFile: join(paths.stateDir, 'repo-map.json'), home });
    } finally {
      for (const db of handles) db.close();
    }
  });
}

const readMap = (file) => JSON.parse(readFileSync(file, 'utf8'));
const NO_FLAGS = { everNested: false, everUnresolvedRemote: false, everNoOrigin: false };
const sorted = (set) => [...set].sort();

// ---- emptyRepos ----

test('emptyRepos is a factory: the documented shape, a fresh value on every call', () => {
  const a = emptyRepos();
  assert.deepEqual(a, { folders: new Map(), keys: new Map(), complete: true, rebuilt: false, error: null });
  const b = emptyRepos();
  assert.notEqual(a, b);
  assert.notEqual(a.folders, b.folders);
  assert.notEqual(a.keys, b.keys);
});

// ---- resolution ----

test('resolveRepos with real git: every recorded folder is resolved, the existing ones and the missing one', { skip }, async () => {
  await withFixture({
    dirs: 2,
    sessions: ([a, b]) => [
      session('alpha', a), session('alpha', a), session('beta', b), session('gone', '/nonexistent/example.invalid/gone'),
      session('nowhere', null), session('blank', ''),
    ],
  }, async ({ dirs: [a, b], ctxFor, home }) => {
    const envBase = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') };
    mkdirSync(envBase.XDG_CONFIG_HOME);
    const git = (...args) => execFileSync('git', args, { env: childEnv(envBase), stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', a);
    git('-C', a, 'remote', 'add', 'origin', 'https://example.invalid/Acme/Alpha.git');
    git('init', '-q', b);
    git('-C', b, 'remote', 'add', 'origin', 'https://example.invalid/acme/beta.git');
    git('-C', b, 'remote', 'add', 'upstream', 'https://example.invalid/globex/beta.git');

    const repos = await resolveRepos(ctxFor(), { run: defaultRun({ envBase }), sshHost: fakeSsh(), budgetMs: 10000 });
    assert.deepEqual(sorted(repos.folders.keys()), ['/nonexistent/example.invalid/gone', a, b].sort());
    assert.deepEqual(repos.folders.get(a), {
      status: 'root', origin: 'example.invalid/acme/alpha', remotes: ['example.invalid/acme/alpha'], unresolvedRemote: false,
      stored: new Set(['example.invalid/acme/alpha']), ...NO_FLAGS,
    });
    assert.deepEqual(repos.folders.get(b).remotes, ['example.invalid/acme/beta', 'example.invalid/globex/beta']);
    assert.equal(repos.folders.get('/nonexistent/example.invalid/gone').status, 'missing');
    assert.deepEqual(repos.keys.get('beta'), {
      repos: new Set(['example.invalid/acme/beta', 'example.invalid/globex/beta']), unknown: false, folders: new Set([b]),
    });
    assert.equal(repos.keys.has('nowhere'), false);
    assert.equal(repos.keys.has('blank'), false);
    assert.equal(repos.complete, true);
    assert.equal(repos.rebuilt, false);
    assert.equal(repos.error, null);
  });
});

test('resolveRepos: a missing folder keeps its stored repos', { skip }, async () => {
  await withFixture({ dirs: 1, sessions: ([a]) => [session('alpha', a)] }, async ({ dirs: [a], ctxFor }) => {
    const script = { [a]: repo({ origin: 'https://github.com/acme/alpha.git' }) };
    await resolveRepos(ctxFor(T0), { run: scriptedRun(script), sshHost: fakeSsh() });
    script[a] = missing();
    const repos = await resolveRepos(ctxFor(T0 + HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.deepEqual(repos.folders.get(a), {
      status: 'missing', origin: null, remotes: [], unresolvedRemote: false, stored: new Set(['github.com/acme/alpha']), ...NO_FLAGS,
    });
    assert.deepEqual(repos.keys.get('alpha').repos, new Set(['github.com/acme/alpha']));
    assert.equal(repos.complete, true);
  });
});

test('resolveRepos: a re-pointed origin adds a second repo; a repo seen again updates its seenAt', { skip }, async () => {
  await withFixture({ dirs: 1, sessions: ([a]) => [session('alpha', a)] }, async ({ dirs: [a], ctxFor, mapFile }) => {
    const script = { [a]: repo({ origin: 'https://github.com/acme/alpha.git' }) };
    await resolveRepos(ctxFor(T0), { run: scriptedRun(script), sshHost: fakeSsh() });
    script[a] = repo({ origin: 'https://github.com/globex/alpha.git' });
    const repos = await resolveRepos(ctxFor(T0 + HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.equal(repos.folders.get(a).origin, 'github.com/globex/alpha');
    assert.deepEqual(repos.folders.get(a).stored, new Set(['github.com/acme/alpha', 'github.com/globex/alpha']));
    assert.deepEqual(repos.keys.get('alpha').repos, new Set(['github.com/acme/alpha', 'github.com/globex/alpha']));
    assert.deepEqual(readMap(mapFile).folders[a].repos, [
      { repo: 'github.com/acme/alpha', seenAt: iso(T0) },
      { repo: 'github.com/globex/alpha', seenAt: iso(T0 + HOUR) },
    ]);
    script[a] = repo({ origin: 'https://github.com/acme/alpha.git' });
    await resolveRepos(ctxFor(T0 + 2 * HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.deepEqual(readMap(mapFile).folders[a].repos, [
      { repo: 'github.com/acme/alpha', seenAt: iso(T0 + 2 * HOUR) },
      { repo: 'github.com/globex/alpha', seenAt: iso(T0 + HOUR) },
    ]);
  });
});

test('resolveRepos: a note keyed differently from its session adds that folder to its own key', { skip }, async () => {
  const s1 = session('home', null);
  await withFixture({
    dirs: 2,
    sessions: ([a, b]) => [Object.assign(s1, { cwd: a }), session('beta', b)],
    observations: [note(s1.memory_session_id, 'alpha'), note(s1.memory_session_id, 'gamma', { merged_into_project: 'delta' })],
  }, async ({ dirs: [a, b], ctxFor }) => {
    const script = {
      [a]: repo({ origin: 'https://github.com/acme/client.git' }),
      [b]: repo({ origin: 'https://github.com/me/beta.git' }),
    };
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun(script), sshHost: fakeSsh() });
    for (const key of ['home', 'alpha', 'gamma', 'delta']) {
      assert.deepEqual(repos.keys.get(key), { repos: new Set(['github.com/acme/client']), unknown: false, folders: new Set([a]) }, key);
    }
    assert.deepEqual(repos.keys.get('beta'), { repos: new Set(['github.com/me/beta']), unknown: false, folders: new Set([b]) });
  });
});

test('resolveRepos: ssh -G runs once per host for the whole run, across folders', { skip }, async () => {
  await withFixture({ dirs: 2, sessions: ([a, b]) => [session('alpha', a), session('beta', b)] }, async ({ dirs: [a, b], ctxFor }) => {
    const script = {
      [a]: repo({ origin: 'git@github.com:acme/alpha.git' }),
      [b]: repo({ origin: 'git@github.com:acme/beta.git', fork: 'ssh://github.com/me/beta.git' }),
    };
    const ssh = fakeSsh();
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun(script), sshHost: ssh });
    assert.deepEqual(ssh.calls, ['github.com']);
    assert.equal(repos.folders.get(a).origin, 'github.com/acme/alpha');
    assert.deepEqual(repos.folders.get(b).remotes, ['github.com/acme/beta', 'github.com/me/beta']);
  });
});

// ---- budget and concurrency ----

test('resolveRepos: folders not resolved within the budget are unknown and complete is false', { skip }, async () => {
  await withFixture({
    dirs: 6,
    sessions: (dirs) => dirs.map((d, i) => session(`p${i}`, d)),
  }, async ({ dirs, ctxFor, mapFile }) => {
    const script = { [dirs[0]]: repo({ origin: 'https://github.com/acme/p0.git' }) };
    for (const d of dirs.slice(1)) script[d] = hang();
    const started = Date.now();
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun(script), sshHost: fakeSsh(), budgetMs: 100 });
    assert.ok(Date.now() - started < 3000, 'the run ends at the budget, not when the stuck children do');
    assert.equal(repos.folders.get(dirs[0]).status, 'root');
    for (const d of dirs.slice(1)) {
      assert.deepEqual(repos.folders.get(d), { status: 'unknown', origin: null, remotes: [], unresolvedRemote: false, stored: new Set(), ...NO_FLAGS });
    }
    assert.equal(repos.keys.get('p1').unknown, true);
    assert.equal(repos.keys.get('p0').unknown, false);
    assert.equal(repos.complete, false);
    assert.deepEqual(Object.keys(readMap(mapFile).folders), [dirs[0]]);
  });
});

test('resolveRepos: a zero budget leaves every folder unknown without running anything', { skip }, async () => {
  await withFixture({ dirs: 2, sessions: (dirs) => dirs.map((d, i) => session(`p${i}`, d)) }, async ({ dirs, ctxFor }) => {
    const run = scriptedRun({ [dirs[0]]: repo({}), [dirs[1]]: repo({}) });
    const repos = await resolveRepos(ctxFor(), { run, sshHost: fakeSsh(), budgetMs: 0 });
    assert.deepEqual(run.calls, []);
    assert.deepEqual(dirs.map((d) => repos.folders.get(d).status), ['unknown', 'unknown']);
    assert.equal(repos.complete, false);
  });
});

test('resolveRepos: at most 4 folders are resolved at once', { skip }, async () => {
  await withFixture({ dirs: 10, sessions: (dirs) => dirs.map((d, i) => session(`p${i}`, d)) }, async ({ dirs, ctxFor }) => {
    const script = Object.fromEntries(dirs.map((d, i) => [d, i % 2 === 0 ? missing() : repo({ origin: `https://github.com/acme/p${i}.git` })]));
    const run = scriptedRun(script, { delayMs: 15 });
    const repos = await resolveRepos(ctxFor(), { run, sshHost: fakeSsh() });
    assert.equal(run.inFlight.max, 4);
    assert.equal(repos.folders.size, 10);
    assert.equal(repos.complete, true);
  });
});

// ---- writing the map ----

test('the map is written with mode 0600, even when there are no folders', { skip }, async () => {
  await withFixture({}, async ({ ctxFor, mapFile }) => {
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun({}), sshHost: fakeSsh() });
    assert.equal(repos.folders.size, 0);
    assert.equal(repos.keys.size, 0);
    assert.deepEqual(readMap(mapFile), { v: 2, rebuiltAt: null, folders: {} });
    assert.equal(statSync(mapFile).mode & 0o777, 0o600);
  });
});

test('saveRepoMap: the re-read union keeps a concurrent writer\'s folder', async () => {
  await withTempHome(async ({ paths }) => {
    const mapFile = join(paths.stateDir, 'repo-map.json');
    const { map } = loadRepoMap(paths);
    const other = {
      v: 2, rebuiltAt: null,
      folders: { '/other/acme': { repos: [{ repo: 'github.com/acme/other', seenAt: iso(T0) }], ...NO_FLAGS } },
    };
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(mapFile, JSON.stringify(other));
    map.folders['/mine/globex'] = { repos: [{ repo: 'github.com/globex/mine', seenAt: iso(T0) }], ...NO_FLAGS };
    saveRepoMap(paths, map);
    const written = readMap(mapFile);
    assert.deepEqual(Object.keys(written.folders).sort(), ['/mine/globex', '/other/acme']);
    assert.equal(statSync(mapFile).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(paths.stateDir).filter((n) => n.endsWith('.tmp')), []);
  });
});

test('resolveRepos: a folder another writer records during the run survives, in the file and in stored', { skip }, async () => {
  await withFixture({ dirs: 2, sessions: ([a, b]) => [session('alpha', a), session('beta', b)] }, async ({ dirs: [a, b], ctxFor, mapFile, paths }) => {
    let wrote = false;
    const onCall = () => {
      if (wrote) return;
      wrote = true;
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(mapFile, JSON.stringify({
        v: 2, rebuiltAt: null,
        folders: { [b]: { repos: [{ repo: 'github.com/globex/beta', seenAt: iso(T0 - HOUR) }], ...NO_FLAGS, everNested: true } },
      }));
    };
    const script = { [a]: repo({ origin: 'https://github.com/acme/alpha.git' }), [b]: hang() };
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun(script, { onCall }), sshHost: fakeSsh(), budgetMs: 200 });
    const written = readMap(mapFile);
    assert.deepEqual(Object.keys(written.folders).sort(), [a, b].sort());
    assert.equal(written.folders[b].everNested, true);
    assert.deepEqual(repos.folders.get(b).stored, new Set(['github.com/globex/beta']));
    assert.equal(repos.folders.get(b).everNested, true);
    assert.deepEqual(repos.keys.get('beta').repos, new Set(['github.com/globex/beta']));
  });
});

// ---- sticky flags ----

test('resolveRepos: nested, an unresolved non-origin remote and a root without an origin each set their flag', { skip }, async () => {
  await withFixture({
    dirs: 5,
    sessions: (dirs) => dirs.map((d, i) => session(`p${i}`, d)),
  }, async ({ dirs: [nested, unresolved, noOrigin, localOrigin, clean], ctxFor, mapFile }) => {
    const script = {
      [nested]: repo({ origin: 'https://github.com/me/n.git' }, { nested: true }),
      [unresolved]: repo({ origin: 'https://github.com/me/u.git', mirror: '/srv/mirror/u.git' }),
      [noOrigin]: repo({ upstream: 'https://github.com/me/o.git' }),
      [localOrigin]: repo({ origin: '/srv/mirror/l.git', upstream: 'https://github.com/me/l.git' }),
      [clean]: repo({ origin: 'https://github.com/me/c.git' }),
    };
    const repos = await resolveRepos(ctxFor(), { run: scriptedRun(script), sshHost: fakeSsh() });
    const map = readMap(mapFile);
    const expect = [
      [nested, { ...NO_FLAGS, everNested: true }],
      [unresolved, { ...NO_FLAGS, everUnresolvedRemote: true }],
      [noOrigin, { ...NO_FLAGS, everNoOrigin: true }],
      [localOrigin, { ...NO_FLAGS, everNoOrigin: true }],
      [clean, NO_FLAGS],
    ];
    for (const [dir, flags] of expect) {
      const { everNested, everUnresolvedRemote, everNoOrigin } = repos.folders.get(dir);
      assert.deepEqual({ everNested, everUnresolvedRemote, everNoOrigin }, flags, dir);
      const { repos: _r, ...stored } = map.folders[dir];
      assert.deepEqual(stored, flags, dir);
    }
  });
});

test('the sticky flags survive a later clean resolution, a deletion and the re-read union', { skip }, async () => {
  await withFixture({ dirs: 1, sessions: ([a]) => [session('alpha', a)] }, async ({ dirs: [a], ctxFor, mapFile, paths }) => {
    const script = { [a]: repo({ mirror: '/srv/mirror/a.git' }, { nested: true }) };
    await resolveRepos(ctxFor(T0), { run: scriptedRun(script), sshHost: fakeSsh() });
    const ALL = { everNested: true, everUnresolvedRemote: true, everNoOrigin: true };
    const flagsOf = (f) => ({ everNested: f.everNested, everUnresolvedRemote: f.everUnresolvedRemote, everNoOrigin: f.everNoOrigin });
    assert.deepEqual(flagsOf(readMap(mapFile).folders[a]), ALL);

    script[a] = repo({ origin: 'https://github.com/me/a.git' });
    let repos = await resolveRepos(ctxFor(T0 + HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.deepEqual(flagsOf(repos.folders.get(a)), ALL);
    assert.deepEqual(flagsOf(readMap(mapFile).folders[a]), ALL);

    script[a] = missing();
    repos = await resolveRepos(ctxFor(T0 + 2 * HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.deepEqual(flagsOf(repos.folders.get(a)), ALL);

    // A writer that loaded the map before any flag was set saves after: the union ORs the flags.
    const stale = { v: 2, rebuiltAt: null, folders: { [a]: { repos: [{ repo: 'github.com/me/a', seenAt: iso(T0) }], ...NO_FLAGS } } };
    saveRepoMap(paths, stale);
    assert.deepEqual(flagsOf(readMap(mapFile).folders[a]), ALL);
  });
});

// ---- rebuilt ----

const corruptions = [
  ['unparsable', (file) => writeFileSync(file, '{ not json')],
  ['wrong version', (file) => writeFileSync(file, JSON.stringify({ v: 1, folders: {} }))],
  ['bad shape', (file) => writeFileSync(file, JSON.stringify({ v: 2, rebuiltAt: null, folders: { '/a': { repos: 'x' } } }))],
  ['missing flags', (file) => writeFileSync(file, JSON.stringify({ v: 2, rebuiltAt: null, folders: { '/a': { repos: [] } } }))],
  ['unreadable (a directory)', (file) => mkdirSync(file)],
];

for (const [label, corrupt] of corruptions) {
  test(`loadRepoMap: a ${label} map with no lastSuccessAt is set aside and rebuilt`, async () => {
    await withTempHome(async ({ paths }) => {
      mkdirSync(paths.stateDir, { recursive: true });
      const mapFile = join(paths.stateDir, 'repo-map.json');
      corrupt(mapFile);
      const { map, rebuilt } = loadRepoMap(paths, { now: () => T0 });
      assert.equal(rebuilt, true);
      assert.deepEqual(map, { v: 2, rebuiltAt: iso(T0), folders: {} });
      assert.equal(existsSync(mapFile), false);
      const bad = readdirSync(paths.stateDir).filter((n) => n.startsWith('repo-map.json.bad-'));
      assert.equal(bad.length, 1);
      assert.match(readFileSync(paths.logFile, 'utf8'), /repo-map-rebuilt/);
    });
  });
}

test('loadRepoMap: a first run is not rebuilt', async () => {
  await withTempHome(async ({ paths }) => {
    assert.deepEqual(loadRepoMap(paths, { now: () => T0 }), { map: { v: 2, rebuiltAt: null, folders: {} }, rebuilt: false });
  });
});

test('loadRepoMap: a deleted map with lastSuccessAt set is rebuilt', async () => {
  await withTempHome(async ({ paths }) => {
    writeState(paths, { lastSuccessAt: iso(T0 - 24 * HOUR) });
    const { map, rebuilt } = loadRepoMap(paths, { now: () => T0 });
    assert.equal(rebuilt, true);
    assert.equal(map.rebuiltAt, iso(T0));
  });
});

test('loadRepoMap: a corrupt map is rebuilt even after a previous success', async () => {
  await withTempHome(async ({ paths }) => {
    writeState(paths, { lastSuccessAt: iso(T0 - 24 * HOUR) });
    writeFileSync(join(paths.stateDir, 'repo-map.json'), 'garbage');
    assert.equal(loadRepoMap(paths, { now: () => T0 }).rebuilt, true);
  });
});

test('a concurrent writer holding the old map does not erase rebuiltAt', async () => {
  await withTempHome(async ({ paths }) => {
    const mapFile = join(paths.stateDir, 'repo-map.json');
    saveRepoMap(paths, { v: 2, rebuiltAt: null, folders: {} });
    const old = loadRepoMap(paths, { now: () => T0 });
    assert.equal(old.rebuilt, false);
    writeFileSync(mapFile, 'garbage');
    const fresh = loadRepoMap(paths, { now: () => T0 + HOUR });
    assert.equal(fresh.rebuilt, true);
    saveRepoMap(paths, fresh.map);
    saveRepoMap(paths, old.map);
    assert.equal(readMap(mapFile).rebuiltAt, iso(T0 + HOUR));
    assert.equal(loadRepoMap(paths, { now: () => T0 + 2 * HOUR }).rebuilt, true);
  });
});

test('the re-read union keeps the later rebuiltAt', async () => {
  await withTempHome(async ({ paths }) => {
    const mapFile = join(paths.stateDir, 'repo-map.json');
    saveRepoMap(paths, { v: 2, rebuiltAt: iso(T0 + HOUR), folders: {} });
    saveRepoMap(paths, { v: 2, rebuiltAt: iso(T0), folders: {} });
    assert.equal(readMap(mapFile).rebuiltAt, iso(T0 + HOUR));
    saveRepoMap(paths, { v: 2, rebuiltAt: iso(T0 + 2 * HOUR), folders: {} });
    assert.equal(readMap(mapFile).rebuiltAt, iso(T0 + 2 * HOUR));
  });
});

test('rebuilt: a setup-style rebuild is still seen by the next report-style load, until a later success', { skip }, async () => {
  await withFixture({ dirs: 1, sessions: ([a]) => [session('alpha', a)] }, async ({ dirs: [a], ctxFor, paths }) => {
    writeState(paths, { lastSuccessAt: iso(T0 - 24 * HOUR) });
    const script = { [a]: repo({ origin: 'https://github.com/me/a.git' }) };
    const setup = await resolveRepos(ctxFor(T0), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.equal(setup.rebuilt, true);
    const report = await resolveRepos(ctxFor(T0 + HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.equal(report.rebuilt, true);
    assert.equal(loadRepoMap(paths, { now: () => T0 + HOUR }).rebuilt, true);
    writeState(paths, { lastSuccessAt: iso(T0 + HOUR) });
    assert.equal(loadRepoMap(paths, { now: () => T0 + 2 * HOUR }).rebuilt, false);
    const next = await resolveRepos(ctxFor(T0 + 2 * HOUR), { run: scriptedRun(script), sshHost: fakeSsh() });
    assert.equal(next.rebuilt, false);
  });
});

// ---- keyEvidence ----

test('keyEvidence: the union of the key and its worktree base covers repos, unknown and folders', () => {
  const repos = emptyRepos();
  repos.keys.set('alpha', { repos: new Set(['github.com/me/alpha']), unknown: false, folders: new Set(['/w/alpha']) });
  repos.keys.set('alpha/feature', { repos: new Set(['github.com/acme/alpha']), unknown: false, folders: new Set(['/w/alpha-feature']) });
  repos.keys.set('beta', { repos: new Set(), unknown: true, folders: new Set(['/w/beta']) });

  assert.deepEqual(keyEvidence(repos, 'alpha/feature'), {
    repos: new Set(['github.com/acme/alpha', 'github.com/me/alpha']), unknown: false, folders: new Set(['/w/alpha', '/w/alpha-feature']),
  });
  // A worktree key with no entry of its own takes its base's, including `unknown`.
  assert.deepEqual(keyEvidence(repos, 'beta/fix'), { repos: new Set(), unknown: true, folders: new Set(['/w/beta']) });
  assert.deepEqual(keyEvidence(repos, 'alpha'), { repos: new Set(['github.com/me/alpha']), unknown: false, folders: new Set(['/w/alpha']) });
  assert.deepEqual(keyEvidence(repos, 'nothing'), { repos: new Set(), unknown: false, folders: new Set() });
  assert.deepEqual(keyEvidence(emptyRepos(), 'alpha/feature'), { repos: new Set(), unknown: false, folders: new Set() });

  // The result never shares a set with the map.
  keyEvidence(repos, 'alpha').repos.add('github.com/globex/x');
  assert.deepEqual(repos.keys.get('alpha').repos, new Set(['github.com/me/alpha']));
});

// ---- fix round 1 ----

// I1: a rebuild is `rebuilt` even when the last success is at or after `now` (the clock moved back), and stays so on
// the next load until a later success.
for (const [label, setup] of [
  ['corrupt', (paths) => writeFileSync(join(paths.stateDir, 'repo-map.json'), 'garbage')],
  ['absent', () => {}],
]) {
  for (const [when, successMs] of [['ahead of now', T0 + HOUR], ['equal to now', T0]]) {
    test(`loadRepoMap: a ${label} map is rebuilt when lastSuccessAt is ${when}`, async () => {
      await withTempHome(async ({ paths }) => {
        writeState(paths, { lastSuccessAt: iso(successMs) });
        setup(paths);
        const first = loadRepoMap(paths, { now: () => T0 });
        assert.equal(first.rebuilt, true);
        assert.ok(Date.parse(first.map.rebuiltAt) > successMs, 'rebuiltAt is after the last success');
        saveRepoMap(paths, first.map, { now: () => T0 });
        assert.equal(loadRepoMap(paths, { now: () => T0 }).rebuilt, true);
        writeState(paths, { lastSuccessAt: iso(successMs + 1000) });
        assert.equal(loadRepoMap(paths, { now: () => T0 }).rebuilt, false);
      });
    });
  }
}

// M4: a state.json that exists but cannot be parsed counts as a recorded success.
test('loadRepoMap: an absent map with an unparsable state.json is rebuilt', async () => {
  await withTempHome(async ({ paths }) => {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.stateFile, '{ not json');
    const { map, rebuilt } = loadRepoMap(paths, { now: () => T0 });
    assert.equal(rebuilt, true);
    assert.equal(map.rebuiltAt, iso(T0));
  });
});

// M2: a map that went bad between the load and the save is set aside, and the save stamps rebuiltAt.
test('saveRepoMap: a map corrupted after the load is set aside and rebuiltAt is stamped', async () => {
  await withTempHome(async ({ paths }) => {
    const mapFile = join(paths.stateDir, 'repo-map.json');
    const { map } = loadRepoMap(paths, { now: () => T0 });
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(mapFile, 'garbage');
    saveRepoMap(paths, map, { now: () => T0 + HOUR });
    assert.equal(readMap(mapFile).rebuiltAt, iso(T0 + HOUR));
    assert.equal(readdirSync(paths.stateDir).filter((n) => n.startsWith('repo-map.json.bad-')).length, 1);
    assert.equal(loadRepoMap(paths, { now: () => T0 + HOUR }).rebuilt, true);
  });
});

test('saveRepoMap: a map that cannot be read at save time is set aside and rebuiltAt is stamped', {
  skip: process.getuid?.() === 0 && 'root reads any file',
}, async () => {
  await withTempHome(async ({ paths }) => {
    const mapFile = join(paths.stateDir, 'repo-map.json');
    saveRepoMap(paths, {
      v: 2, rebuiltAt: null, folders: { '/w/acme': { repos: [{ repo: 'github.com/acme/x', seenAt: iso(T0) }], ...NO_FLAGS } },
    });
    const { map } = loadRepoMap(paths, { now: () => T0 });
    chmodSync(mapFile, 0o000);
    saveRepoMap(paths, map, { now: () => T0 + HOUR });
    assert.equal(readMap(mapFile).rebuiltAt, iso(T0 + HOUR));
    assert.equal(readdirSync(paths.stateDir).filter((n) => n.startsWith('repo-map.json.bad-')).length, 1);
    assert.equal(loadRepoMap(paths, { now: () => T0 + HOUR }).rebuilt, true);
  });
});

// M1: once the budget ends, no folder still resolving runs another command.
test('resolveRepos: no command runs after the budget ends', { skip }, async () => {
  await withFixture({ dirs: 1, sessions: ([a]) => [session('alpha', a)] }, async ({ dirs: [a], ctxFor }) => {
    const run = scriptedRun({ [a]: repo({ origin: 'https://github.com/acme/alpha.git' }) }, { delayMs: 150 });
    const repos = await resolveRepos(ctxFor(), { run, sshHost: fakeSsh(), budgetMs: 50 });
    assert.equal(repos.folders.get(a).status, 'unknown');
    const atReturn = run.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(run.calls.slice(atReturn), []);
  });
});
