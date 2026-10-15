// Blocking per project, allowing per note and fail-closed insights (repo-identity spec 4.2, 4.3, 7): the coverage
// matrix over hand-built resolutions, then resolveRepos, runInsights and runReport over fixture databases with a
// scripted `run` and a fake `ssh -G`, so no test runs a real git or ssh child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canImportSqlite, openConfig, withTempHome } from './helpers.mjs';
import { createClaudeMemDb, memFs } from './fixtures/claude-mem-schema.mjs';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { allowedByNameKey, folderUnlistedRepos, isBlocked, isCovered, isCoveredKey, selectForInsights } from '../lib/policy.mjs';
import { emptyRepos, resolveRepos } from '../lib/repo.mjs';
import { readWindowRows, runInsights } from '../lib/insights.mjs';
import { repoBudgetMs, runReport } from '../lib/report.mjs';
import { collectHygiene } from '../lib/collect/hygiene.mjs';
import { suggestCandidates } from '../lib/suggest.mjs';
import { closeSources, openSources } from '../lib/sources.mjs';
import { readState } from '../lib/state.mjs';
import { main } from '../cli/memory.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';

const REASON = 'Repository identity unavailable: insights are off for this run because never-send has repository or owner entries.';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;

const ME = 'github.com/me/*';
const CLIENT = 'github.com/client/*';

const cfg = (over = {}) => ({ ...DEFAULTS, ...over });

// A folder as resolveRepos returns it. For `root` and `nested` the map has already recorded this run's origin and
// remotes, so `stored` holds them too; a `missing` or `unknown` folder carries no origin or remotes.
function folder(status, { origin = null, remotes = [], unresolvedRemote = false, stored = [], everNested = false, everUnresolvedRemote = false, everNoOrigin = false } = {}) {
  const live = status === 'root' || status === 'nested';
  const all = live ? [...new Set([...(origin ? [origin] : []), ...remotes])].sort() : [];
  return {
    status,
    origin: live ? origin : null,
    remotes: all,
    unresolvedRemote,
    stored: new Set([...stored, ...all]),
    everNested: everNested || status === 'nested',
    everUnresolvedRemote: everUnresolvedRemote || unresolvedRemote,
    everNoOrigin: everNoOrigin || (live && origin === null),
  };
}

// A resolution: `folders` maps cwd → folder(); `keyFolders` maps a key → the cwds it used, and the key evidence is
// built from them the way resolveRepos builds it.
function reposOf(folders, keyFolders = {}, extra = {}) {
  const f = new Map(Object.entries(folders));
  const keys = new Map();
  for (const [key, cwds] of Object.entries(keyFolders)) {
    const entry = { repos: new Set(), unknown: false, folders: new Set() };
    for (const cwd of cwds) {
      const x = f.get(cwd);
      entry.folders.add(cwd);
      for (const r of [...x.stored, ...x.remotes, ...(x.origin ? [x.origin] : [])]) entry.repos.add(r);
      if (x.status === 'unknown') entry.unknown = true;
    }
    keys.set(key, entry);
  }
  return { folders: f, keys, complete: [...f.values()].every((x) => x.status !== 'unknown'), rebuilt: false, error: null, ...extra };
}

const note = (project, cwd = null, over = {}) => ({ project, merged_into_project: null, cwd, ...over });

// ---- each kind of entry on each list ---------------------------------------------------------------------------------

test('allowlist: a name, a repository and an owner entry each allow', () => {
  const repos = reposOf({
    '/code/mine': folder('root', { origin: 'github.com/me/mine' }),
    '/code/other': folder('root', { origin: 'github.com/me/other' }),
    '/code/deep': folder('root', { origin: 'gitlab.com/group/sub/name' }),
  }, { mine: ['/code/mine'], other: ['/code/other'], deep: ['/code/deep'] });
  assert.equal(isCovered(note('alpha'), cfg({ allowlist: ['alpha'] }), repos), true);
  const byRepo = cfg({ allowlist: ['github.com/me/mine'] });
  assert.equal(isCovered(note('mine', '/code/mine'), byRepo, repos), true);
  assert.equal(isCovered(note('other', '/code/other'), byRepo, repos), false);
  const byOwner = cfg({ allowlist: [ME] });
  assert.equal(isCovered(note('mine', '/code/mine'), byOwner, repos), true);
  assert.equal(isCovered(note('other', '/code/other'), byOwner, repos), true);
  // Ruling 1: an owner entry covers every depth under its path.
  assert.equal(isCovered(note('deep', '/code/deep'), cfg({ allowlist: ['gitlab.com/group/*'] }), repos), true);
});

test('never-send: a name, a repository and an owner entry each block', () => {
  const repos = reposOf({
    '/code/hidden': folder('root', { origin: 'github.com/me/secret' }),
    '/code/client': folder('root', { origin: 'github.com/client/app' }),
  }, { hidden: ['/code/hidden'], app: ['/code/client'] });
  const allowAll = { allowlist: ['alpha', 'hidden', 'app', ME, CLIENT] };
  assert.equal(isBlocked('alpha', null, cfg({ ...allowAll, neverSend: ['alpha'] }), repos), true);
  assert.equal(isBlocked('hidden', null, cfg({ ...allowAll, neverSend: ['github.com/me/secret'] }), repos), true);
  assert.equal(isBlocked('app', null, cfg({ ...allowAll, neverSend: [CLIENT] }), repos), true);
  assert.equal(isBlocked('hidden', null, cfg({ ...allowAll, neverSend: [CLIENT] }), repos), false);
  assert.equal(isCovered(note('app', '/code/client'), cfg({ ...allowAll, neverSend: [CLIENT] }), repos), false);
  assert.equal(isCovered(note('hidden', '/code/hidden'), cfg({ ...allowAll, neverSend: [CLIENT] }), repos), true);
});

test('never-send beats every allow', () => {
  const repos = reposOf({ '/code/x': folder('root', { origin: 'github.com/me/x' }) }, { x: ['/code/x'] });
  const row = note('x', '/code/x');
  for (const allowlist of [['x'], ['github.com/me/x'], [ME], ['x', 'github.com/me/x', ME]]) {
    for (const neverSend of [['x'], ['github.com/me/x'], [ME]]) {
      const c = cfg({ allowlist, neverSend });
      assert.equal(isCovered(row, c, repos), false, JSON.stringify(c));
      assert.equal(isCoveredKey('x', null, c, repos), false, JSON.stringify(c));
    }
  }
});

test('case rules: never-send names compare case-insensitively, allowlist names exactly, repository entries lower-cased', () => {
  const repos = reposOf({
    '/code/mine': folder('root', { origin: 'github.com/me/mine' }),
    '/code/client': folder('root', { origin: 'github.com/client/app' }),
  }, { mine: ['/code/mine'], app: ['/code/client'] });
  const never = cfg({ allowlist: ['alpha'], neverSend: ['Alpha'] });
  assert.equal(isBlocked('alpha', null, never, repos), true);
  assert.equal(isBlocked('ALPHA/wt', null, never, repos), true);
  assert.equal(isBlocked('other', 'aLpHa', never, repos), true);
  assert.equal(isCovered(note('alpha'), never, repos), false);
  // Allowlist names keep the exact comparison.
  assert.equal(isCovered(note('alpha'), cfg({ allowlist: ['Alpha'] }), repos), false);
  assert.equal(isCovered(note('Alpha'), cfg({ allowlist: ['Alpha'] }), repos), true);
  // Hand-edited repository and owner entries with capitals still match the lower-cased evidence.
  assert.equal(isCovered(note('mine', '/code/mine'), cfg({ allowlist: ['GitHub.com/Me/*'] }), repos), true);
  assert.equal(isBlocked('app', null, cfg({ allowlist: ['app'], neverSend: ['GitHub.com/Client/App'] }), repos), true);
});

// ---- per note, own folder blocks -------------------------------------------------------------------------------------

test('own folder blocks: a note keyed K in a session keyed S whose folder is a client repository (Review Focus 2)', () => {
  // The key evidence of K does not include the client folder; only the note's own session folder links them.
  const repos = reposOf({ '/code/client': folder('root', { origin: 'github.com/client/app' }) }, { s: ['/code/client'] });
  const c = cfg({ allowlist: ['k'], neverSend: [CLIENT] });
  assert.equal(isBlocked('k', null, c, repos), false);
  assert.equal(isCovered(note('k', '/code/client'), c, repos), false);
  assert.equal(isCovered(note('k'), c, repos), true);
});

test('own folder blocks: github.com/me/secret never-sent under an allowed github.com/me/*', () => {
  const repos = reposOf({ '/code/hidden': folder('root', { origin: 'github.com/me/secret' }) });
  const c = cfg({ allowlist: [ME, 'k'], neverSend: ['github.com/me/secret'] });
  assert.equal(isCovered(note('k', '/code/hidden'), c, repos), false);
});

test('own folder blocks: an unknown folder, or one absent from the resolution, when never-send has repository entries', () => {
  const repos = reposOf({ '/code/u': folder('unknown') });
  const withRepoNever = cfg({ allowlist: ['k'], neverSend: [CLIENT] });
  assert.equal(isCovered(note('k', '/code/u'), withRepoNever, repos), false);
  assert.equal(isCovered(note('k', '/code/not-resolved'), withRepoNever, repos), false);
  // With only name entries in never-send, the name rule still allows it.
  const namesOnly = cfg({ allowlist: ['k'], neverSend: ['other'] });
  assert.equal(isCovered(note('k', '/code/u'), namesOnly, repos), true);
  assert.equal(isCovered(note('k', '/code/not-resolved'), namesOnly, repos), true);
});

// ---- candidates (the per-note half; coveredNotes is T5) -------------------------------------------------------------

test('a key with one allowing folder and one folder without git: notes from the first are covered, the key is not', () => {
  const repos = reposOf({
    '/code/mixed': folder('root', { origin: 'github.com/me/mixed' }),
    '/code/plain': folder('nogit'),
  }, { mixed: ['/code/mixed', '/code/plain'] });
  const c = cfg({ allowlist: [ME] });
  assert.equal(isCovered(note('mixed', '/code/mixed'), c, repos), true);
  assert.equal(isCovered(note('mixed', '/code/plain'), c, repos), false);
  assert.equal(isCoveredKey('mixed', null, c, repos), false);
});

test('a key whose notes come from sessions with no cwd is not covered by an owner entry', () => {
  const c = cfg({ allowlist: [ME] });
  assert.equal(isCovered(note('nocwd'), c, emptyRepos()), false);
  assert.equal(isCoveredKey('nocwd', null, c, emptyRepos()), false);
});

// ---- per note: one name, a client folder and a personal folder (Review Focus 1) --------------------------------------

test('one name from a client folder and a personal folder: client notes never allowed by the personal owner; blocked when the client is never-sent', () => {
  const repos = reposOf({
    '/code/client-shared': folder('root', { origin: 'github.com/client/shared' }),
    '/code/shared': folder('root', { origin: 'github.com/me/shared' }),
  }, { shared: ['/code/client-shared', '/code/shared'] });
  const rows = [
    { id: 1, ...note('shared', '/code/client-shared'), agent_id: null, created_at_epoch: NOW - DAY, type: 'note', title: 't', narrative: 'n', facts: '[]' },
    { id: 2, ...note('shared', '/code/shared'), agent_id: null, created_at_epoch: NOW - DAY, type: 'note', title: 't', narrative: 'n', facts: '[]' },
  ];
  const window = { startMs: NOW - 7 * DAY, endMs: NOW };
  const allowed = cfg({ allowlist: [ME] });
  assert.equal(isCovered(rows[0], allowed, repos), false);
  assert.equal(isCovered(rows[1], allowed, repos), true);
  assert.deepEqual(selectForInsights(rows, allowed, window, repos).selected.map((r) => r.id), [2]);
  const blocked = cfg({ allowlist: [ME], neverSend: [CLIENT] });
  assert.equal(isBlocked('shared', null, blocked, repos), true);
  assert.equal(isCovered(rows[1], blocked, repos), false);
  assert.deepEqual(selectForInsights(rows, blocked, window, repos).selected, []);
});

// ---- allowed by name only ---------------------------------------------------------------------------------------------

test('a folder without git, nested, unknown, missing with nothing stored, root without origin, or no cwd: allowed by name only', () => {
  const repos = reposOf({
    '/f/nogit': folder('nogit'),
    '/f/nested': folder('nested', { origin: 'github.com/me/parent' }),
    '/f/unknown': folder('unknown'),
    '/f/missing': folder('missing'),
    '/f/noorigin': folder('root', { remotes: ['github.com/me/x'] }),
  });
  const cwds = ['/f/nogit', '/f/nested', '/f/unknown', '/f/missing', '/f/noorigin', null];
  for (const cwd of cwds) {
    assert.equal(isCovered(note('k', cwd), cfg({ allowlist: [ME] }), repos), false, String(cwd));
    assert.equal(isCovered(note('k', cwd), cfg({ allowlist: ['k'] }), repos), true, String(cwd));
  }
});

test('a deleted folder with a stored repository is allowed by that repository', () => {
  const repos = reposOf({ '/f/gone': folder('missing', { stored: ['github.com/me/x'] }) }, { k: ['/f/gone'] });
  assert.equal(isCovered(note('k', '/f/gone'), cfg({ allowlist: [ME] }), repos), true);
  assert.equal(isCovered(note('k', '/f/gone'), cfg({ allowlist: ['github.com/me/x'] }), repos), true);
  assert.equal(isCoveredKey('k', null, cfg({ allowlist: [ME] }), repos), true);
});

test('a deleted folder with any sticky flag is never allowed by repository; without flags it is', () => {
  const allow = cfg({ allowlist: [ME] });
  for (const flag of ['everNested', 'everUnresolvedRemote', 'everNoOrigin']) {
    const repos = reposOf({ '/f/gone': folder('missing', { stored: ['github.com/me/x'], [flag]: true }) }, { k: ['/f/gone'] });
    assert.equal(isCovered(note('k', '/f/gone'), allow, repos), false, flag);
    assert.equal(isCoveredKey('k', null, allow, repos), false, flag);
    // Still allowed by name.
    assert.equal(isCovered(note('k', '/f/gone'), cfg({ allowlist: ['k'] }), repos), true, flag);
  }
  const plain = reposOf({ '/f/gone': folder('missing', { stored: ['github.com/me/x'] }) }, { k: ['/f/gone'] });
  assert.equal(isCovered(note('k', '/f/gone'), allow, plain), true);
  assert.equal(isCoveredKey('k', null, allow, plain), true);
});

test('a deleted folder whose origin was a local mirror and whose upstream is personal (everNoOrigin) is never allowed by repository', () => {
  const repos = reposOf({ '/f/mirror': folder('missing', { stored: ['github.com/me/x'], everNoOrigin: true }) }, { k: ['/f/mirror'] });
  assert.equal(isCovered(note('k', '/f/mirror'), cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCoveredKey('k', null, cfg({ allowlist: [ME] }), repos), false);
});

test('a root folder with an unresolved non-origin remote can never allow by repository', () => {
  const repos = reposOf({ '/f/x': folder('root', { origin: 'github.com/me/x', unresolvedRemote: true }) }, { k: ['/f/x'] });
  assert.equal(isCovered(note('k', '/f/x'), cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCoveredKey('k', null, cfg({ allowlist: [ME] }), repos), false);
});

test('fix 1 I1: a root folder with a sticky everUnresolvedRemote never allows by repository (Ruling 11)', () => {
  const repos = reposOf({ '/f/x': folder('root', { origin: 'github.com/me/x', everUnresolvedRemote: true }) }, { k: ['/f/x'] });
  assert.equal(isCovered(note('k', '/f/x'), cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCoveredKey('k', null, cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCovered(note('k', '/f/x'), cfg({ allowlist: ['k'] }), repos), true);
});

test('fix 1 I1: a root folder with only everNoOrigin still allows by repository (Ruling 11)', () => {
  const repos = reposOf({ '/f/x': folder('root', { origin: 'github.com/me/x', everNoOrigin: true }) }, { k: ['/f/x'] });
  assert.equal(isCovered(note('k', '/f/x'), cfg({ allowlist: [ME] }), repos), true);
  assert.equal(isCoveredKey('k', null, cfg({ allowlist: [ME] }), repos), true);
});

test('fix 1 M3: the blocking evidence of a key unions its case variants, worktree bases included', () => {
  const repos = reposOf({ '/code/client': folder('root', { origin: 'github.com/client/app' }) }, { Foo: ['/code/client'] });
  const c = cfg({ allowlist: ['foo', 'foo/wt', 'bar'], neverSend: [CLIENT] });
  assert.equal(isBlocked('foo', null, c, repos), true);
  assert.equal(isBlocked('FOO/wt', null, c, repos), true);
  assert.equal(isBlocked('bar', 'fOO', c, repos), true);
  assert.equal(isCovered(note('foo'), c, repos), false);
  assert.equal(isCovered(note('foo/wt'), c, repos), false);
  assert.equal(isCoveredKey('foo', null, c, repos), false);
  assert.equal(isBlocked('bar', null, c, repos), false);
  assert.equal(isCovered(note('bar'), c, repos), true);
});

test('fix 2 N1: a key with no folders of its own is not covered by borrowing a case variant\'s folders', () => {
  const repos = reposOf({ '/f/x': folder('root', { origin: 'github.com/me/x' }) }, { Foo: ['/f/x'] });
  const c = cfg({ allowlist: [ME] });
  assert.equal(isCoveredKey('Foo', null, c, repos), true);
  assert.equal(isCoveredKey('foo', null, c, repos), false);
  assert.equal(isCovered(note('foo'), c, repos), false);
  assert.equal(isCoveredKey('foo', null, cfg({ allowlist: [ME, 'foo'] }), repos), true);
});

test('fix 2 N1 mirror: a key with its own allowed folder is not covered when a case variant has a folder that does not allow', () => {
  const repos = reposOf({
    '/f/x': folder('root', { origin: 'github.com/me/x' }),
    '/f/u': folder('unknown'),
    '/f/c': folder('root', { origin: 'github.com/client/app' }),
  }, { foo: ['/f/x'], Foo: ['/f/u'], bar: ['/f/x'], BAR: ['/f/c'] });
  assert.equal(isCoveredKey('foo', null, cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCoveredKey('bar', null, cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCoveredKey('bar', null, cfg({ allowlist: [ME], neverSend: [CLIENT] }), repos), false);
  assert.equal(isBlocked('bar', null, cfg({ allowlist: [ME], neverSend: [CLIENT] }), repos), true);
});

test('fix 2 N3: a key added to the resolution after a first lookup still blocks its case variants', () => {
  const repos = reposOf({ '/code/client': folder('root', { origin: 'github.com/client/app' }) }, { other: ['/code/client'] });
  const c = cfg({ allowlist: ['foo'], neverSend: [CLIENT] });
  assert.equal(isBlocked('foo', null, c, repos), false);
  repos.keys.set('Foo', { repos: new Set(['github.com/client/app']), unknown: false, folders: new Set(['/code/client']) });
  assert.equal(isBlocked('foo', null, c, repos), true);
});

// ---- remotes ----------------------------------------------------------------------------------------------------------

test('a client upstream remote: never allowed by the personal owner; blocked when the client owner is never-sent', () => {
  const repos = reposOf({ '/f/fork': folder('root', { origin: 'github.com/me/fork', remotes: ['github.com/client/app'] }) }, { fork: ['/f/fork'] });
  assert.equal(isCovered(note('fork', '/f/fork'), cfg({ allowlist: [ME] }), repos), false);
  assert.equal(isCovered(note('fork', '/f/fork'), cfg({ allowlist: [ME, CLIENT] }), repos), true);
  assert.equal(isBlocked('fork', null, cfg({ allowlist: ['fork'], neverSend: [CLIENT] }), repos), true);
  assert.equal(isCovered(note('fork', '/f/fork'), cfg({ allowlist: ['fork'], neverSend: [CLIENT] }), repos), false);
});

test('a personal repository with two personal remotes is allowed', () => {
  const repos = reposOf({ '/f/two': folder('root', { origin: 'github.com/me/two', remotes: ['gitlab.com/me/two'] }) }, { two: ['/f/two'] });
  assert.equal(isCovered(note('two', '/f/two'), cfg({ allowlist: [ME, 'gitlab.com/me/*'] }), repos), true);
  assert.equal(isCoveredKey('two', null, cfg({ allowlist: [ME, 'gitlab.com/me/*'] }), repos), true);
});

test('with repository or owner never-send entries, a project with any unknown folder is blocked', () => {
  const repos = reposOf({
    '/f/a': folder('root', { origin: 'github.com/me/a' }),
    '/f/b': folder('unknown'),
  }, { proj: ['/f/a', '/f/b'] });
  for (const neverSend of [[CLIENT], ['github.com/client/app']]) {
    const c = cfg({ allowlist: ['proj', ME], neverSend });
    assert.equal(isBlocked('proj', null, c, repos), true);
    assert.equal(isCovered(note('proj', '/f/a'), c, repos), false);
  }
  const namesOnly = cfg({ allowlist: ['proj'], neverSend: ['other'] });
  assert.equal(isBlocked('proj', null, namesOnly, repos), false);
  assert.equal(isCovered(note('proj', '/f/a'), namesOnly, repos), true);
});

// ---- isCoveredKey -----------------------------------------------------------------------------------------------------

test('isCoveredKey requires every folder of the key; a key with no folders needs a name rule', () => {
  const repos = reposOf({
    '/f/a': folder('root', { origin: 'github.com/me/a' }),
    '/f/b': folder('root', { origin: 'github.com/me/b' }),
    '/f/c': folder('root', { origin: 'github.com/other/c' }),
  }, { both: ['/f/a', '/f/b'], mixed: ['/f/a', '/f/c'] });
  const c = cfg({ allowlist: [ME] });
  assert.equal(isCoveredKey('both', null, c, repos), true);
  assert.equal(isCoveredKey('mixed', null, c, repos), false);
  assert.equal(isCoveredKey('nofolders', null, c, repos), false);
  assert.equal(isCoveredKey('nofolders', null, cfg({ allowlist: [ME, 'nofolders'] }), repos), true);
  assert.equal(isCoveredKey('', null, c, repos), false);
  assert.equal(isCoveredKey(null, null, c, repos), false);
});

// ---- worktree keys and merge targets --------------------------------------------------------------------------------

test('worktree keys and merge targets take their base key evidence', () => {
  const repos = reposOf({ '/f/app': folder('root', { origin: 'github.com/client/app' }) }, { app: ['/f/app'] });
  const c = cfg({ allowlist: ['app', 'other'], neverSend: [CLIENT] });
  assert.equal(isBlocked('app/wt', null, c, repos), true);
  assert.equal(isBlocked('other', 'app', c, repos), true);
  assert.equal(isBlocked('other', 'app/wt', c, repos), true);
  assert.equal(isCovered(note('app/wt'), c, repos), false);
  assert.equal(isCovered(note('other', null, { merged_into_project: 'app' }), c, repos), false);
  assert.equal(isCovered(note('other'), c, repos), true);
});

// ---- empty resolution -------------------------------------------------------------------------------------------------

test('an empty resolution falls back to name rules only', () => {
  const c = cfg({ allowlist: ['alpha', ME], neverSend: [CLIENT, 'beta'] });
  const repos = emptyRepos();
  assert.equal(isCovered(note('alpha'), c, repos), true);
  assert.equal(isCovered(note('alpha/wt'), c, repos), true);
  assert.equal(isCovered(note('gamma'), c, repos), false);
  assert.equal(isCovered(note('beta'), cfg({ allowlist: ['beta'], neverSend: ['beta'] }), repos), false);
  assert.equal(isBlocked('alpha', null, c, repos), false);
  assert.equal(isCoveredKey('alpha', null, c, repos), true);
  assert.equal(isCoveredKey('gamma', null, c, repos), false);
});

test('the predicates require a resolution', () => {
  const c = cfg({ allowlist: ['alpha'] });
  assert.throws(() => isCovered(note('alpha'), c), TypeError);
  assert.throws(() => isBlocked('alpha', null, c), TypeError);
  assert.throws(() => isCoveredKey('alpha', null, c), TypeError);
  assert.throws(() => selectForInsights([], c, { startMs: 0, endMs: 1 }), TypeError);
});

// ---- fixture databases --------------------------------------------------------------------------------------------------

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, timedOut: false });
const TIMED_OUT = { code: null, stdout: '', stderr: '', timedOut: true };

// A scripted `run` answering by folder: script[cwd] = { stat: 'ok' | 'missing' | 'timeout', nested, nogit, remotes }.
function scriptedRun(script) {
  const run = async (cmd, args) => {
    const cwd = cmd === 'stat' ? args[0] : args[1];
    const b = script[cwd];
    if (b === undefined) return fail('unexpected folder');
    if (cmd === 'stat') {
      if (b.stat === 'timeout') return TIMED_OUT;
      if (b.stat === 'missing') return fail(`stat: cannot stat '${cwd}': No such file or directory`);
      return ok('stat output');
    }
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') {
      if (b.nogit) return fail('fatal: not a git repository (or any of the parent directories): .git', 128);
      const real = realpathSync(cwd);
      return ok(`${b.nested ? dirname(real) : real}\n`);
    }
    const remotes = b.remotes ?? {};
    if (rest === 'remote get-url origin') return Object.hasOwn(remotes, 'origin') ? ok(`${remotes.origin}\n`) : fail("error: No such remote 'origin'", 2);
    if (rest === 'remote -v') return ok(Object.entries(remotes).flatMap(([n, u]) => [`${n}\t${u} (fetch)\n`, `${n}\t${u} (push)\n`]).join(''));
    return fail('unexpected command');
  };
  return run;
}

const SSH = { 'github.com': 'github.com', 'github.com-work': 'github.com' };
const sshHost = async (host) => (Object.hasOwn(SSH, host) ? SSH[host] : null);

let nextSession = 1;
const session = (project, cwd) => {
  const n = nextSession++;
  return { content_session_id: `c${n}`, memory_session_id: `m${n}`, project, cwd, started_at_epoch: NOW - DAY };
};
let nextObs = 1;
const obs = (memorySessionId, project, over = {}) => {
  const id = nextObs++;
  return {
    id, memory_session_id: memorySessionId, project, type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`, facts: '["fact"]',
    created_at_epoch: NOW - DAY - id * 1000, ...over,
  };
};

// A temp home with `n` real folders and a fixture database built from them; fn({ env, paths, home, dirs, openDb }).
// `duplicates(sessions, dirs)`: more sdk_sessions rows inserted after the UNIQUE on memory_session_id is dropped.
async function withDb({ dirs: n = 0, sessions = () => [], observations = () => [], dropCwd = false, dropNoteSession = false, duplicates = null } = {}, fn) {
  await withTempHome(async ({ env, paths, home }) => {
    const dirs = Array.from({ length: n }, (_, i) => {
      const d = join(home, 'folders', `f${i}`);
      mkdirSync(d, { recursive: true });
      return d;
    });
    const s = sessions(dirs);
    mkdirSync(paths.claudeMemDir, { recursive: true });
    createClaudeMemDb(paths.dbFile, { sessions: s, observations: observations(s, dirs) });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    if (duplicates !== null) {
      const rw = new DatabaseSync(paths.dbFile);
      try {
        rw.exec(`ALTER TABLE sdk_sessions RENAME TO sdk_sessions_unique;
          CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT, memory_session_id TEXT,
            project TEXT, cwd TEXT, started_at_epoch INTEGER);
          INSERT INTO sdk_sessions SELECT * FROM sdk_sessions_unique;
          DROP TABLE sdk_sessions_unique;`);
        const insert = rw.prepare('INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, cwd, started_at_epoch) VALUES (?, ?, ?, ?, ?)');
        for (const d of duplicates(s, dirs)) insert.run(d.content_session_id, d.memory_session_id, d.project, d.cwd, d.started_at_epoch);
      } finally {
        rw.close();
      }
    }
    if (dropCwd || dropNoteSession) {
      const rw = new DatabaseSync(paths.dbFile);
      try {
        if (dropCwd) rw.exec('ALTER TABLE sdk_sessions DROP COLUMN cwd');
        if (dropNoteSession) rw.exec('ALTER TABLE observations DROP COLUMN memory_session_id');
      } finally {
        rw.close();
      }
    }
    const handles = [];
    const openDb = () => {
      const db = new DatabaseSync(paths.dbFile, { readOnly: true });
      handles.push(db);
      return db;
    };
    try {
      await fn({ env, paths, home, dirs, openDb });
    } finally {
      for (const h of handles) h.close();
    }
  });
}

test('an SSH alias with a dot (github.com-work) resolves through ssh -G and is blocked by github.com/<owner>/*', { skip }, async () => {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('work', d[0])],
  }, async ({ paths, dirs, openDb }) => {
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'git@github.com-work:Client/App.git' } } });
    const repos = await resolveRepos({ db: openDb(), paths, now: () => NOW }, { run, sshHost });
    assert.equal(repos.folders.get(dirs[0]).origin, 'github.com/client/app');
    assert.equal(isBlocked('work', null, cfg({ allowlist: ['work'], neverSend: [CLIENT] }), repos), true);
  });
});

test('a pasted https URL in never-send blocks an origin of git@github.com:OWNER/app.git (Review Focus 4, blocking half)', { skip }, async () => {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('app', d[0])],
  }, async ({ env, paths, dirs, openDb }) => {
    const code = await main(['never', 'https://github.com/Owner/App.git'], { env, stdout: { write() {} }, stderr: { write() {} }, deps: { sshHost } });
    assert.equal(code, 0);
    const { config } = loadConfig(paths);
    assert.deepEqual(config.neverSend, ['github.com/owner/app']);
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'git@github.com:OWNER/app.git' } } });
    const repos = await resolveRepos({ db: openDb(), paths, now: () => NOW }, { run, sshHost });
    const c = { ...config, allowlist: ['app'] };
    assert.equal(isBlocked('app', null, c, repos), true);
    assert.equal(isCovered(note('app', dirs[0]), c, repos), false);
  });
});

test('own folder blocks through resolveRepos: a note keyed K in a client session keyed S is blocked by key and by folder', { skip }, async () => {
  await withDb({
    dirs: 2,
    sessions: (d) => [session('s', d[0]), session('k', d[1])],
    observations: (s) => [obs(s[0].memory_session_id, 'k'), obs(s[1].memory_session_id, 'k')],
  }, async ({ paths, dirs, openDb }) => {
    const run = scriptedRun({
      [dirs[0]]: { remotes: { origin: 'https://github.com/client/app.git' } },
      [dirs[1]]: { remotes: { origin: 'https://github.com/me/k.git' } },
    });
    const repos = await resolveRepos({ db: openDb(), paths, now: () => NOW }, { run, sshHost });
    const c = cfg({ allowlist: ['k'], neverSend: [CLIENT] });
    assert.equal(isBlocked('k', null, c, repos), true);
    assert.equal(isCovered(note('k', dirs[0]), c, repos), false);
  });
});

// ---- readWindowRows -------------------------------------------------------------------------------------------------

const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW };

test('readWindowRows: the cwd comes from the joined session; an empty cwd and a session-less note give null', { skip }, async () => {
  await withDb({
    sessions: () => [session('a', '/code/a'), session('b', '')],
    observations: (s) => [obs(s[0].memory_session_id, 'a'), obs(s[1].memory_session_id, 'b'), obs('m-none', 'c'), obs(null, 'd')],
  }, async ({ paths, openDb }) => {
    const rows = readWindowRows({ db: openDb(), window: WINDOW, pageSize: 2, paths });
    assert.deepEqual(rows.map((r) => [r.project, r.cwd]), [['a', '/code/a'], ['b', null], ['c', null], ['d', null]]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['agent_id', 'created_at_epoch', 'cwd', 'facts', 'id', 'merged_into_project', 'narrative', 'project', 'title', 'type']);
  });
});

test('readWindowRows: an older claude-mem without sdk_sessions.cwd reads every cwd as null', { skip }, async () => {
  await withDb({
    sessions: () => [session('a', '/code/a')],
    observations: (s) => [obs(s[0].memory_session_id, 'a')],
    dropCwd: true,
  }, async ({ paths, openDb }) => {
    const rows = readWindowRows({ db: openDb(), window: WINDOW, pageSize: 10, paths });
    assert.deepEqual(rows.map((r) => [r.project, r.cwd]), [['a', null]]);
  });
});

// ---- runInsights and §4.3 ------------------------------------------------------------------------------------------

const goodResult = () => ({ rules: [], skills: [], stale: [] });
const okRun = (data) => ({ code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: data }), stderr: '', timedOut: false, spawnError: false, envKeys: [] });
const spyRunner = () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return okRun(goodResult());
  };
  return { runner, calls };
};

test('runInsights: a failed or rebuilt resolution with repository never-send entries is off with the fixed reason, and the runner is not called', { skip }, async () => {
  await withDb({
    sessions: () => [session('proj', null)],
    observations: (s) => [obs(s[0].memory_session_id, 'proj')],
  }, async ({ paths, openDb }) => {
    const config = { ...DEFAULTS, ...openConfig(['proj'], { neverSend: [CLIENT] }) };
    for (const repos of [{ ...emptyRepos(), error: 'resolve' }, { ...emptyRepos(), rebuilt: true }, undefined]) {
      const { runner, calls } = spyRunner();
      const out = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos }, { runner, env: {} });
      assert.deepEqual(out, { status: 'off', reason: REASON });
      assert.equal(calls.length, 0);
    }
    const { runner, calls } = spyRunner();
    const out = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos: emptyRepos(), reposRebuilt: true }, { runner, env: {} });
    assert.deepEqual(out, { status: 'off', reason: REASON });
    assert.equal(calls.length, 0);
  });
});

test('runInsights: a failed or rebuilt resolution without repository never-send entries still runs by name', { skip }, async () => {
  await withDb({
    sessions: () => [session('proj', null)],
    observations: (s) => [obs(s[0].memory_session_id, 'proj')],
  }, async ({ paths, openDb }) => {
    const config = { ...DEFAULTS, ...openConfig(['proj', ME], { neverSend: ['other'] }) };
    for (const repos of [{ ...emptyRepos(), error: 'resolve' }, { ...emptyRepos(), rebuilt: true }]) {
      const { runner, calls } = spyRunner();
      const out = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos }, { runner, env: {} });
      assert.equal(out.status, 'ok');
      assert.equal(out.counts.sent, 1);
      assert.equal(calls.length, 1);
    }
  });
});

test('runInsights: a rebuilt resolution allows by name only, never by repository (the stored evidence is gone)', { skip }, async () => {
  await withDb({
    sessions: () => [session('mine', '/code/mine')],
    observations: (s) => [obs(s[0].memory_session_id, 'mine')],
  }, async ({ paths, openDb }) => {
    const repos = reposOf({ '/code/mine': folder('root', { origin: 'github.com/me/mine' }) }, { mine: ['/code/mine'] }, { rebuilt: true });
    const config = { ...DEFAULTS, ...openConfig([ME]) };
    const { runner, calls } = spyRunner();
    const out = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos }, { runner, env: {} });
    assert.equal(out.status, 'ok');
    assert.equal(out.counts.sent, 0);
    assert.equal(calls.length, 0);
    const fresh = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos: { ...repos, rebuilt: false } }, { runner, env: {} });
    assert.equal(fresh.counts.sent, 1);
  });
});

test('runInsights: a note is allowed by the repository of its own session folder', { skip }, async () => {
  await withDb({
    sessions: () => [session('mine', '/code/mine'), session('mine', '/code/plain')],
    observations: (s) => [obs(s[0].memory_session_id, 'mine', { id: 1 }), obs(s[1].memory_session_id, 'mine', { id: 2 })],
  }, async ({ paths, openDb }) => {
    const repos = reposOf({ '/code/mine': folder('root', { origin: 'github.com/me/mine' }), '/code/plain': folder('nogit') }, { mine: ['/code/mine', '/code/plain'] });
    const config = { ...DEFAULTS, ...openConfig([ME]) };
    const { runner, calls } = spyRunner();
    const out = await runInsights({ db: openDb(), window: WINDOW, config, paths, pageSize: 10, repos }, { runner, env: {} });
    assert.equal(out.counts.sent, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].input, /#1 \[mine\]/);
    assert.ok(!calls[0].input.includes('#2 '));
  });
});

// ---- hygiene titles ---------------------------------------------------------------------------------------------------

test('hygiene titles: hidden for a key with no folders and no name rule, shown for a key whose every folder allows', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    const dup = (project, title) => [{ project, title, created_at_epoch: NOW - DAY }, { project, title, created_at_epoch: NOW - DAY }];
    createClaudeMemDb(paths.dbFile, { observations: [...dup('nofolders', 'Loose title'), ...dup('mine', 'Owned title')] });
    const config = { ...loadConfig(paths).config, allowlist: [ME] };
    const ctx = await openSources(paths, config, { now: () => NOW, fs: memFs() });
    try {
      ctx.repos = reposOf({ '/code/mine': folder('root', { origin: 'github.com/me/mine' }) }, { mine: ['/code/mine'] });
      const titles = Object.fromEntries(collectHygiene(ctx).duplicates.largest.map((g) => [g.project, g.title]));
      assert.deepEqual(titles, { nofolders: null, mine: 'Owned title' });
    } finally {
      closeSources(ctx);
    }
  });
});

// ---- suggest --------------------------------------------------------------------------------------------------------

test('suggest: blocked keys are left out (never-send names case-insensitively) and keys with a note that is not sent are kept', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dbPath = join(paths.home, 'suggest.db');
    const mk = (project) => ({ project, type: 'note', title: 't', narrative: 'n', facts: '[]', created_at_epoch: NOW - DAY });
    // `mine`'s only note was written in its allowing folder, so it is sent and `mine` is no candidate (spec 5.1).
    createClaudeMemDb(dbPath, {
      observations: [...['Secret', 'mixed', 'client', 'nocwd'].map(mk), { ...mk('mine'), memory_session_id: 'sm' }],
      sessions: [{ memory_session_id: 'sm', project: 'mine', cwd: '/code/mine', started_at_epoch: NOW - DAY }],
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const repos = reposOf({
        '/code/mine': folder('root', { origin: 'github.com/me/mine' }),
        '/code/plain': folder('nogit'),
        '/code/client': folder('root', { origin: 'github.com/client/app' }),
      }, { mixed: ['/code/mine', '/code/plain'], mine: ['/code/mine'], client: ['/code/client'] });
      const config = { ...DEFAULTS, allowlist: [ME], neverSend: ['secret', CLIENT] };
      const { candidates } = suggestCandidates({ db, config, paths, now: () => NOW, repos }, { days: 7 });
      assert.deepEqual(candidates.map((c) => c.project).sort(), ['mixed', 'nocwd']);
    } finally {
      db.close();
    }
  });
});

test('fix 1 M5: hygiene and suggestions require the resolution (no fallback to an empty one)', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    const dup = { project: 'alpha', title: 'Same', created_at_epoch: NOW - DAY };
    createClaudeMemDb(paths.dbFile, { observations: [dup, dup] });
    const ctx = await openSources(paths, { ...loadConfig(paths).config, allowlist: ['alpha'] }, { now: () => NOW, fs: memFs() });
    try {
      assert.throws(() => collectHygiene(ctx), TypeError);
      assert.throws(() => suggestCandidates(ctx, { days: 7 }), TypeError);
      ctx.repos = emptyRepos();
      assert.equal(collectHygiene(ctx).duplicates.largest[0].title, 'Same');
      assert.deepEqual(suggestCandidates(ctx, { days: 7 }).candidates, []);
    } finally {
      closeSources(ctx);
    }
  });
});

// ---- the repository budget (Ruling 8) -------------------------------------------------------------------------------

test('repoBudgetMs: MEMORY_REPORT_REPO_BUDGET_MS clamped to 1..2^31-1 ms, the 10 s default when not numeric', () => {
  assert.equal(repoBudgetMs(undefined), 10000);
  assert.equal(repoBudgetMs(''), 10000);
  assert.equal(repoBudgetMs('abc'), 10000);
  assert.equal(repoBudgetMs('2500'), 2500);
  assert.equal(repoBudgetMs('0'), 1);
  assert.equal(repoBudgetMs('-5'), 1);
  assert.equal(repoBudgetMs('99999999999'), 2 ** 31 - 1);
  assert.equal(repoBudgetMs(250), 250);
  assert.equal(repoBudgetMs(0), 1);
  assert.equal(repoBudgetMs(Number.NaN), 10000);
});

// ---- the report ---------------------------------------------------------------------------------------------------------

const readLog = (paths) => (existsSync(paths.logFile) ? readFileSync(paths.logFile, 'utf8') : '');
const insightsOf = (text) => text.split('## Insights\n\n')[1].split('\n\n## Allowlist suggestions')[0];
const writeConfig = (paths, config) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify(config));
};
const report = (env, deps, runner) => runReport({ paths: env.paths, env: env.env, mode: 'now', now: () => NOW, isAlive: () => false, runner, deps });

// A name-allowed key and an owner never-sent: a resolution that throws or is rebuilt switches insights off.
async function assertReportOff({ dropCwd = false, setup }, logLine) {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('proj', d[0])],
    observations: (s) => [obs(s[0].memory_session_id, 'proj'), obs(s[0].memory_session_id, 'proj')],
    dropCwd,
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['proj'], { neverSend: [CLIENT] }));
    setup?.(paths);
    const { runner, calls } = spyRunner();
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://github.com/me/proj.git' } } });
    assert.equal(await report({ env, paths, home }, { run, sshHost }, runner), 0);
    assert.equal(calls.length, 0, 'the runner is never called');
    assert.ok(!existsSync(paths.workDir));
    const state = readState(paths);
    assert.equal(state.lastSummary.insights, 'off');
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.equal(insightsOf(text), REASON);
    assert.ok(text.includes(`- Insights: off (${REASON})\n`));
    assert.match(readLog(paths), logLine);
  });
}

test('report fail-closed (a): sdk_sessions without a cwd column makes the folder query throw', { skip }, () => assertReportOff({ dropCwd: true }, /repo-resolve-failed\n/));

test('report fail-closed (b): a corrupt map is rebuilt', { skip }, () => assertReportOff({
  setup: (paths) => {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json');
  },
}, /repo-map-rebuilt corrupt\n/));

test('report fail-closed (b): a map absent after a previous success is rebuilt', { skip }, () => assertReportOff({
  setup: (paths) => {
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.stateFile, JSON.stringify({ lastSuccessAt: new Date(NOW - 8 * DAY).toISOString() }));
  },
}, /repo-map-rebuilt absent\n/));

test('report: an older claude-mem without sdk_sessions.cwd still sends by name when never-send has no repository entries', { skip }, async () => {
  await withDb({
    sessions: () => [session('proj', '/code/proj')],
    observations: (s) => [obs(s[0].memory_session_id, 'proj')],
    dropCwd: true,
  }, async ({ env, paths, home }) => {
    writeConfig(paths, openConfig(['proj'], { neverSend: ['other'] }));
    const { runner, calls } = spyRunner();
    assert.equal(await report({ env, paths, home }, { run: scriptedRun({}), sshHost }, runner), 0);
    assert.equal(calls.length, 1);
    assert.equal(readState(paths).lastSummary.insights, 'ok');
    assert.match(readLog(paths), /repo-resolve-failed\n/);
  });
});

test('report: a partial resolution blocks only the project with an unknown folder', { skip }, async () => {
  await withDb({
    dirs: 2,
    sessions: (d) => [session('good', d[0]), session('bad', d[1])],
    observations: (s) => [obs(s[0].memory_session_id, 'good'), obs(s[1].memory_session_id, 'bad')],
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['good', 'bad'], { neverSend: [CLIENT] }));
    const { runner, calls } = spyRunner();
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://github.com/me/good.git' } }, [dirs[1]]: { stat: 'timeout' } });
    assert.equal(await report({ env, paths, home }, { run, sshHost }, runner), 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].input, /\[good\]/);
    assert.ok(!calls[0].input.includes('[bad]'));
  });
});

test('report: MEMORY_REPORT_REPO_BUDGET_MS reaches the resolution (a hanging folder is unknown within the budget)', { skip }, async () => {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('good', d[0]), session('hang', '/code/hang')],
    observations: (s) => [obs(s[0].memory_session_id, 'good'), obs(s[1].memory_session_id, 'hang')],
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['good', 'hang'], { neverSend: [CLIENT] }));
    const { runner, calls } = spyRunner();
    const scripted = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://github.com/me/good.git' } } });
    const run = (cmd, args, opts) => (args[0] === '/code/hang' ? new Promise(() => {}) : scripted(cmd, args, opts));
    const started = Date.now();
    const code = await report({ env: { ...env, MEMORY_REPORT_REPO_BUDGET_MS: '300' }, paths, home }, { run, sshHost }, runner);
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000, 'the 300 ms budget, not the 10 s default');
    assert.equal(calls.length, 1);
    assert.match(calls[0].input, /\[good\]/);
    assert.ok(!calls[0].input.includes('[hang]'));
  });
});

test('privacy: the prompt, the report text and run.log carry no repository, owner or folder path', { skip }, async () => {
  await withDb({
    dirs: 3,
    sessions: (d) => [session('alpha', d[0]), session('beta', d[1]), session('gamma', d[2])],
    observations: (s) => [
      obs(s[0].memory_session_id, 'alpha'), obs(s[0].memory_session_id, 'alpha'),
      obs(s[1].memory_session_id, 'beta'), obs(s[2].memory_session_id, 'gamma'),
    ],
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['github.com/zz-owner-mine/*'], { neverSend: ['github.com/zz-owner-client/*'] }));
    const { runner, calls } = spyRunner();
    const run = scriptedRun({
      [dirs[0]]: { remotes: { origin: 'https://github.com/zz-owner-mine/zz-repo-one.git', upstream: 'git@github.com-work:zz-owner-mine/zz-repo-up.git' } },
      [dirs[1]]: { remotes: { origin: 'https://github.com/zz-owner-client/zz-repo-two.git' } },
      [dirs[2]]: { stat: 'missing' },
    });
    assert.equal(await report({ env, paths, home }, { run, sshHost }, runner), 0);
    assert.equal(calls.length, 1);
    const prompt = calls[0].input;
    assert.match(prompt, /\[alpha\]/);
    const text = readFileSync(readState(paths).lastReportPath, 'utf8');
    const log = readLog(paths);
    for (const [name, out] of [['prompt', prompt], ['report', text], ['run.log', log]]) {
      for (const needle of ['github.com', 'zz-owner', 'zz-repo', home, realpathSync(home), ...dirs]) {
        assert.ok(!out.includes(needle), `${name} holds ${needle}`);
      }
    }
  });
});

// ---- fix 1 M1 (Ruling 12): local titles and suggestions on a failed or rebuilt resolution ----------------------------

const suggestionsOf = (text) => text.split('## Allowlist suggestions\n\n')[1];

// `proj` is name-allowed and has a duplicate title; `stray` has no name rule, so it is a suggestion candidate.
async function localSections({ neverSend, dropNoteSession = false, corruptMap = false }) {
  let out;
  await withDb({
    dirs: 1,
    sessions: (d) => [session('proj', d[0])],
    observations: (s) => [
      obs(s[0].memory_session_id, 'proj', { title: 'Zq duplicate marker' }),
      obs(s[0].memory_session_id, 'proj', { title: 'Zq duplicate marker' }),
      obs(s[0].memory_session_id, 'stray'),
    ],
    dropNoteSession,
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['proj'], { neverSend }));
    if (corruptMap) {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json');
    }
    const { runner } = spyRunner();
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://github.com/me/proj.git' } } });
    assert.equal(await report({ env, paths, home }, { run, sshHost }, runner), 0);
    out = { text: readFileSync(readState(paths).lastReportPath, 'utf8'), log: readLog(paths) };
  });
  return out;
}

test('fix 2 N2: a fresh resolution with an owner never-send still shows titles and suggestions', { skip }, async () => {
  const { text, log } = await localSections({ neverSend: [CLIENT] });
  assert.ok(!/repo-resolve-failed|repo-map-rebuilt/.test(log));
  assert.ok(text.includes('Zq duplicate marker'));
  assert.ok(suggestionsOf(text).includes('`stray`'));
});

for (const [label, opts, logLine] of [
  ['failed', { dropNoteSession: true }, /repo-resolve-failed\n/],
  ['rebuilt', { corruptMap: true }, /repo-map-rebuilt corrupt\n/],
]) {
  test(`fix 1 M1: a ${label} resolution with owner never-send entries hides every hygiene title and every suggestion`, { skip }, async () => {
    const { text, log } = await localSections({ ...opts, neverSend: [CLIENT] });
    assert.match(log, logLine);
    assert.ok(!text.includes('Zq duplicate marker'), 'no hygiene title');
    assert.ok(text.includes('Total groups: 1'), 'the counts stay');
    assert.equal(suggestionsOf(text), 'None.\n');
  });

  test(`fix 1 M1: a ${label} resolution without repository never-send entries keeps the name rules for titles and suggestions`, { skip }, async () => {
    const { text, log } = await localSections({ ...opts, neverSend: ['nobody'] });
    assert.match(log, logLine);
    assert.ok(text.includes('Zq duplicate marker'));
    assert.ok(suggestionsOf(text).includes('`stray`'));
  });
}

// ---- final fix I1: a never-send typed on an SSH alias host blocks the client clone ----------------------------------

test('final fix I1: after never github.com-work/client/*, a note from a client clone in a name-allowed project is not sent', { skip }, async () => {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('app', d[0])],
    observations: (s) => [obs(s[0].memory_session_id, 'app')],
  }, async ({ env, paths, dirs, openDb }) => {
    const code = await main(['never', 'github.com-work/client/*'], { env, stdout: { write() {} }, stderr: { write() {} }, deps: { sshHost } });
    assert.equal(code, 0);
    const config = { ...loadConfig(paths).config, allowlist: ['app'] };
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'git@github.com-work:client/app.git' } } });
    const db = openDb();
    const repos = await resolveRepos({ db, paths, now: () => NOW }, { run, sshHost });
    assert.equal(isBlocked('app', null, config, repos), true);
    const { selected } = selectForInsights(readWindowRows({ db, window: WINDOW, pageSize: 10, paths }), config, WINDOW, repos);
    assert.deepEqual(selected, []);
  });
});

// ---- final fix M1: a www. origin is blocked by the bare-host owner ---------------------------------------------------

test('final fix M1: an origin of https://www.github.com/client/app is blocked by github.com/client/*', { skip }, async () => {
  await withDb({
    dirs: 1,
    sessions: (d) => [session('app', d[0])],
  }, async ({ paths, dirs, openDb }) => {
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://www.github.com/client/app' } } });
    const repos = await resolveRepos({ db: openDb(), paths, now: () => NOW }, { run, sshHost });
    const c = cfg({ allowlist: ['app'], neverSend: [CLIENT] });
    assert.equal(isBlocked('app', null, c, repos), true);
    assert.equal(isCovered(note('app', dirs[0]), c, repos), false);
  });
});

// ---- final fix insurance: a memory_session_id shared by sessions with different folders ------------------------------

test('final fix insurance: a note whose session id has two folders reads once, with an unknown folder that never allows by repository', { skip }, async () => {
  await withDb({
    dirs: 2,
    sessions: (d) => [session('app', d[0])],
    observations: (s) => [obs(s[0].memory_session_id, 'app')],
    duplicates: (s, d) => [{ ...s[0], content_session_id: 'c-dup', cwd: d[1] }],
  }, async ({ paths, dirs, openDb }) => {
    const db = openDb();
    const run = scriptedRun({
      [dirs[0]]: { remotes: { origin: 'https://github.com/me/app.git' } },
      [dirs[1]]: { remotes: { origin: 'https://github.com/client/app.git' } },
    });
    const repos = await resolveRepos({ db, paths, now: () => NOW }, { run, sshHost });
    const rows = readWindowRows({ db, window: WINDOW, pageSize: 10, paths });
    assert.equal(rows.length, 1, 'one row per note');
    assert.ok(!dirs.includes(rows[0].cwd), 'the folder is neither of the two');
    const c = cfg({ allowlist: [ME] });
    assert.equal(isCovered(rows[0], c, repos), false);
    assert.deepEqual(selectForInsights(rows, c, WINDOW, repos).selected, []);
  });
});

test('final fix insurance: with repository never-send entries, a key whose note has an ambiguous session is blocked', { skip }, async () => {
  await withDb({
    dirs: 2,
    sessions: (d) => [session('s', d[0])],
    observations: (s) => [obs(s[0].memory_session_id, 'app')],
    duplicates: (s, d) => [{ ...s[0], content_session_id: 'c-dup', cwd: d[1] }],
  }, async ({ paths, dirs, openDb }) => {
    const run = scriptedRun({
      [dirs[0]]: { remotes: { origin: 'https://github.com/me/app.git' } },
      [dirs[1]]: { remotes: { origin: 'https://github.com/me/other.git' } },
    });
    const repos = await resolveRepos({ db: openDb(), paths, now: () => NOW }, { run, sshHost });
    assert.equal(repos.keys.get('app').unknown, true);
    assert.equal(isBlocked('app', null, cfg({ allowlist: ['app'], neverSend: [CLIENT] }), repos), true);
    assert.equal(isBlocked('app', null, cfg({ allowlist: ['app'], neverSend: ['nobody'] }), repos), false, 'unknown blocks only with repository entries');
  });
});

// ---- final fix M4 (Ruling 15): no report suggestion for a name that cannot be pasted as written ----------------------

test('final fix M4: the report suggests no name holding a control, bidi or line-separator character, or a stored NUL', { skip }, async () => {
  const hostile = ['nul\u0000z', 'bidi‮name', 'ls x', 'zw​x', 'esc\u001bx'];
  let text;
  await withDb({
    dirs: 1,
    sessions: (d) => [session('proj', d[0])],
    observations: (s) => [obs(s[0].memory_session_id, 'proj'), obs(s[0].memory_session_id, 'stray'), ...hostile.map((n) => obs(s[0].memory_session_id, n))],
  }, async ({ env, paths, home, dirs }) => {
    writeConfig(paths, openConfig(['proj']));
    const { runner } = spyRunner();
    const run = scriptedRun({ [dirs[0]]: { remotes: { origin: 'https://github.com/me/proj.git' } } });
    assert.equal(await report({ env, paths, home }, { run, sshHost }, runner), 0);
    text = readFileSync(readState(paths).lastReportPath, 'utf8');
  });
  const commands = suggestionsOf(text).split('\n').filter((l) => l.startsWith('  triqual memory allow '));
  assert.deepEqual(commands, ["  triqual memory allow 'stray'"]);
});

// ---- 0.3.1 fix 1: the read-only helpers behind the `triqual memory repos` status ------------------------------------------

test('0.3.1 fix 1: folderUnlistedRepos lists an eligible folder\'s repositories that no allowlist repository or owner entry matches', () => {
  const repos = reposOf({
    '/w/fork': folder('root', { origin: 'github.com/me/fork', remotes: ['github.com/upstream/fork'] }),
    '/w/gone': folder('missing', { stored: ['github.com/upstream/gone', 'github.com/me/gone'] }),
    '/w/stale': folder('missing'),
    '/w/nested': folder('nested', { origin: 'github.com/upstream/nested' }),
    '/w/plain': folder('nogit'),
  });
  const config = cfg({ allowlist: [ME, 'fork'], neverSend: [] });
  assert.deepEqual(folderUnlistedRepos(repos, '/w/fork', config), ['github.com/upstream/fork']);
  assert.deepEqual(folderUnlistedRepos(repos, '/w/gone', config), ['github.com/upstream/gone']);
  assert.deepEqual(folderUnlistedRepos(repos, '/w/fork', cfg({ allowlist: [ME, 'github.com/upstream/*'] })), []);
  assert.deepEqual(folderUnlistedRepos(repos, '/w/fork', cfg({ allowlist: [] })), ['github.com/me/fork', 'github.com/upstream/fork']);
  for (const cwd of ['/w/stale', '/w/nested', '/w/plain', '/w/not-recorded']) assert.deepEqual(folderUnlistedRepos(repos, cwd, config), [], cwd);
  assert.throws(() => folderUnlistedRepos(undefined, '/w/fork', config), /repos is required/);
});

test('0.3.1 fix 1: allowedByNameKey is the allowlist name rule for a key alone', () => {
  const config = cfg({ allowlist: ['vault', ME] });
  assert.equal(allowedByNameKey('vault', config), true);
  assert.equal(allowedByNameKey('vault/feature', config), true, 'a worktree key under the name');
  assert.equal(allowedByNameKey('Vault', config), false, 'allowlist names compare exactly');
  assert.equal(allowedByNameKey('vaulted', config), false);
  assert.equal(allowedByNameKey('github.com/me/x', config), false, 'an owner entry is not a name rule');
  assert.equal(allowedByNameKey(null, config), false);
});
