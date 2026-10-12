// Candidate suggestions from observations (local-setup spec 2.6): grouping, exclusions, roots, ordering, limit, privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { suggestCandidates } from '../lib/suggest.mjs';
import { emptyRepos } from '../lib/repo.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;

let nextId = 1;
const obs = (project, over = {}) => ({
  id: nextId++, project, type: 'decision', title: `title ${nextId}`, narrative: `narrative ${nextId}`, facts: '["fact"]',
  created_at_epoch: NOW - DAY, ...over,
});
const many = (project, n, over = {}) => Array.from({ length: n }, () => obs(project, over));
const session = (project, cwd, startedAt = NOW - DAY) => ({ project, cwd, started_at_epoch: startedAt });

// Opens a read-only context over a fixture database under a temp home, then runs fn(ctx, home).
async function withCtx({ observations = [], sessions = [], config = {} }, fn) {
  await withTempHome(async ({ paths }) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dbPath = join(paths.home, 'suggest.db');
    createClaudeMemDb(dbPath, { observations, sessions });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await fn({ db, config: { ...DEFAULTS, ...config }, paths, now: () => NOW, repos: emptyRepos() }, paths.home);
    } finally {
      db.close();
    }
  });
}

const entries = (result) => result.candidates.map((c) => [c.project, c.notes]);

test('suggestCandidates: a worktree key counts under its base and a merged row counts once under the merge target', { skip }, async () => {
  const observations = [
    obs('acme'), obs('acme/feature'), obs('acme/feature/deep'),
    obs('scratch', { merged_into_project: 'acme' }),
    obs('globex/x', { merged_into_project: 'initech/y' }),
  ];
  await withCtx({ observations }, (ctx) => {
    assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['acme', 4], ['initech', 1]]);
  });
});

test('suggestCandidates: subagent rows, rows outside the window and rows without a project are excluded', { skip }, async () => {
  const observations = [
    obs('acme'),
    obs('acme', { agent_id: 'agent-1' }),
    obs('acme', { created_at_epoch: NOW - 8 * DAY }),
    obs('acme', { created_at_epoch: NOW }), // the window is half-open: [now - days, now)
    obs('acme', { created_at_epoch: NOW - 7 * DAY }), // the start is included
    obs(null), obs(''),
  ];
  await withCtx({ observations }, (ctx) => {
    assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['acme', 2]]);
    assert.deepEqual(entries(suggestCandidates(ctx, { days: 30 })), [['acme', 3]]);
  });
});

test('suggestCandidates: bases covered by the allowlist or in neverSend are excluded', { skip }, async () => {
  const observations = [obs('covered'), obs('covered/wt'), obs('blocked'), obs('blocked/wt'), obs('open'), obs('other', { merged_into_project: 'covered' })];
  await withCtx({ observations, config: { allowlist: ['covered'], neverSend: ['blocked'] } }, (ctx) => {
    assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['open', 1]]);
  });
});

test('suggestCandidates: suggestRoots keeps only bases with a cwd under a root, on a path-component boundary', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const home = paths.home;
    const dbPath = join(home, 'roots.db');
    createClaudeMemDb(dbPath, {
      observations: [...many('inroot', 3), ...many('exact', 2), ...many('sibling', 5), ...many('nocwd', 4), ...many('elsewhere', 6)],
      sessions: [
        session('inroot', `${home}/Code/inroot`),
        session('exact', `${home}/Code`),
        session('sibling', `${home}/Code2/x`),
        session('elsewhere', `${home}/Other/y`),
      ],
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const ctx = { db, config: { ...DEFAULTS, suggestRoots: ['~/Code'] }, paths, now: () => NOW, repos: emptyRepos() };
      assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['inroot', 3], ['exact', 2]]);
      ctx.config = { ...DEFAULTS, suggestRoots: ['~/Code', `${home}/Other`] };
      assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['elsewhere', 6], ['inroot', 3], ['exact', 2]]);
    } finally {
      db.close();
    }
  });
});

test('suggestCandidates: with no suggestRoots a base without any cwd is kept', { skip }, async () => {
  await withCtx({ observations: [...many('nocwd', 2), ...many('withcwd', 1)], sessions: [session('withcwd', '/somewhere/else')] }, (ctx) => {
    assert.deepEqual(entries(suggestCandidates(ctx, { days: 7 })), [['nocwd', 2], ['withcwd', 1]]);
  });
});

test('suggestCandidates: sorted by notes descending then name, cwd is the most recent non-empty one or null', { skip }, async () => {
  const observations = [...many('beta', 2), ...many('alpha', 2), ...many('gamma', 5), ...many('delta', 1)];
  const sessions = [
    session('alpha', '/old/alpha', NOW - 3 * DAY),
    session('alpha', '/new/alpha', NOW - 1 * DAY),
    session('alpha', '', NOW - 100),
    session('alpha/wt', '/wt/alpha', NOW - 2 * DAY),
    { project: 'beta', cwd: null, started_at_epoch: NOW - 1 },
  ];
  await withCtx({ observations, sessions }, (ctx) => {
    const none = { coveredNotes: 0, repo: null, owner: null };
    assert.deepEqual(suggestCandidates(ctx, { days: 7 }).candidates, [
      { project: 'gamma', notes: 5, cwd: null, ...none },
      { project: 'alpha', notes: 2, cwd: '/new/alpha', ...none },
      { project: 'beta', notes: 2, cwd: null, ...none },
      { project: 'delta', notes: 1, cwd: null, ...none },
    ]);
  });
});

test('suggestCandidates: returns at most 40 candidates, the most noted first', { skip }, async () => {
  const observations = Array.from({ length: 45 }, (_, i) => many(`proj${String(i).padStart(2, '0')}`, i + 1)).flat();
  await withCtx({ observations }, (ctx) => {
    const { candidates } = suggestCandidates(ctx, { days: 7 });
    assert.equal(candidates.length, 40);
    assert.equal(candidates[0].project, 'proj44');
    assert.equal(candidates[39].project, 'proj05');
  });
});

test('suggestCandidates: homeProject is the base named like the home directory when it has notes, else null', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const homeName = paths.home.split('/').pop();
    const dbPath = join(paths.home, 'home.db');
    createClaudeMemDb(dbPath, { observations: [obs(`${homeName}/wt`), obs('acme')] });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const ctx = { db, config: { ...DEFAULTS }, paths, now: () => NOW, repos: emptyRepos() };
      assert.equal(suggestCandidates(ctx, { days: 7 }).homeProject, homeName);
      assert.equal(suggestCandidates({ ...ctx, now: () => NOW + 30 * DAY }, { days: 7 }).homeProject, null);
    } finally {
      db.close();
    }
  });
  await withCtx({ observations: [obs('acme')] }, (ctx) => {
    assert.equal(suggestCandidates(ctx, { days: 7 }).homeProject, null);
  });
});

test('suggestCandidates: the result never carries a title or narrative', { skip }, async () => {
  const observations = [
    obs('acme', { title: 'TITLE-MARKER-1', narrative: 'NARRATIVE-MARKER-1', facts: '["FACT-MARKER-1"]' }),
    obs('acme/wt', { title: 'TITLE-MARKER-2', narrative: 'NARRATIVE-MARKER-2' }),
  ];
  await withCtx({ observations }, (ctx) => {
    const text = JSON.stringify(suggestCandidates(ctx, { days: 7 }));
    for (const marker of ['TITLE-MARKER', 'NARRATIVE-MARKER', 'FACT-MARKER']) assert.ok(!text.includes(marker), marker);
    assert.deepEqual(Object.keys(suggestCandidates(ctx, { days: 7 }).candidates[0]).sort(), ['coveredNotes', 'cwd', 'notes', 'owner', 'project', 'repo']);
  });
});

// ---- repo-identity spec 5.1: per-note counts, repo and owner, owners, repos ----------------------------------------------

// A folder as resolveRepos returns it.
function folder(status, { origin = null, remotes = null, stored = null, unresolvedRemote = false } = {}) {
  const repos = origin === null ? [] : [origin];
  return {
    status, origin, remotes: remotes ?? repos, unresolvedRemote, stored: new Set(stored ?? repos),
    everNested: false, everUnresolvedRemote: false, everNoOrigin: false,
  };
}
// A hand-built resolution: folders by cwd and the folders each key used.
function reposOf(folders, keyFolders, extra = {}) {
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
  return { folders: f, keys, complete: true, rebuilt: false, error: null, ...extra };
}
let nextSession = 1;
// A session with its own memory_session_id, and `n` notes written in it.
function inSession(project, cwd, n, over = {}) {
  const id = `m${nextSession++}`;
  return { session: { memory_session_id: id, project, cwd, started_at_epoch: NOW - DAY }, notes: many(project, n, { memory_session_id: id, ...over }) };
}
const build = (...parts) => ({ sessions: parts.map((p) => p.session), observations: parts.flatMap((p) => p.notes) });

const ME = 'github.com/me/*';

test('candidates: a partly covered key has coveredNotes > 0, and a key with notes from no-cwd sessions is still a candidate', { skip }, async () => {
  const fixture = build(
    inSession('mixed', '/code/mixed', 2), inSession('mixed', '/code/plain', 1),
    inSession('k', '/code/k', 2), inSession('k', null, 1),
    inSession('full', '/code/full', 3),
  );
  const repos = reposOf({
    '/code/mixed': folder('root', { origin: 'github.com/me/mixed' }),
    '/code/plain': folder('nogit'),
    '/code/k': folder('root', { origin: 'github.com/me/k' }),
    '/code/full': folder('root', { origin: 'github.com/me/full' }),
  }, { mixed: ['/code/mixed', '/code/plain'], k: ['/code/k'], full: ['/code/full'] });
  await withCtx({ ...fixture, config: { allowlist: [ME] } }, (ctx) => {
    const { candidates } = suggestCandidates({ ...ctx, repos }, { days: 7 });
    assert.deepEqual(candidates, [
      { project: 'k', notes: 1, coveredNotes: 2, cwd: '/code/k', repo: 'github.com/me/k', owner: ME },
      { project: 'mixed', notes: 1, coveredNotes: 2, cwd: '/code/plain', repo: null, owner: null },
    ]);
  });
});

test('candidates: repo is the single repository every folder of the key would allow by, its worktree keys included', { skip }, async () => {
  const fixture = build(
    inSession('one', '/code/one', 1), inSession('one/wt', '/code/one-wt', 1),
    inSession('fork', '/code/fork', 1), inSession('split', '/code/s1', 1), inSession('split', '/code/s2', 1),
    inSession('gone', '/code/gone', 1), inSession('deep', '/code/deep', 1),
  );
  const repos = reposOf({
    '/code/one': folder('root', { origin: 'github.com/acme/one' }),
    '/code/one-wt': folder('root', { origin: 'github.com/acme/one' }),
    '/code/fork': folder('root', { origin: 'github.com/me/fork', remotes: ['github.com/me/fork', 'github.com/client/fork'] }),
    '/code/s1': folder('root', { origin: 'github.com/acme/s1' }),
    '/code/s2': folder('root', { origin: 'github.com/acme/s2' }),
    '/code/gone': folder('missing', { stored: ['gitlab.com/grp/gone'] }),
    '/code/deep': folder('root', { origin: 'gitlab.com/grp/sub/deep' }),
  }, {
    one: ['/code/one'], 'one/wt': ['/code/one-wt'], fork: ['/code/fork'], split: ['/code/s1', '/code/s2'], gone: ['/code/gone'],
    deep: ['/code/deep'],
  });
  await withCtx(fixture, (ctx) => {
    const byName = Object.fromEntries(suggestCandidates({ ...ctx, repos }, { days: 7 }).candidates.map((c) => [c.project, [c.repo, c.owner]]));
    assert.deepEqual(byName, {
      one: ['github.com/acme/one', 'github.com/acme/*'],
      fork: [null, null],
      split: [null, null],
      gone: ['gitlab.com/grp/gone', 'gitlab.com/grp/*'],
      deep: ['gitlab.com/grp/sub/deep', 'gitlab.com/grp/*'],
    });
  });
});

test('owners: one per owner of an allowing folder\'s origin, sorted by notes, owners on either list left out', { skip }, async () => {
  const fixture = build(
    inSession('a', '/code/a', 2), inSession('b', '/code/b', 1), inSession('b/wt', '/code/b', 1),
    inSession('gone', '/code/gone', 4),
    inSession('client', '/code/client', 9), inSession('other', '/code/other', 9),
    inSession('plain', '/code/plain', 9), inSession('odd', '/code/odd', 9), inSession('up', '/code/up', 1),
  );
  const repos = reposOf({
    '/code/a': folder('root', { origin: 'github.com/me/a' }),
    '/code/b': folder('root', { origin: 'github.com/me/b' }),
    '/code/gone': folder('missing', { stored: ['gitlab.com/grp/sub/gone'] }),
    '/code/client': folder('root', { origin: 'github.com/client/x' }),
    '/code/other': folder('root', { origin: 'github.com/other/w' }),
    '/code/plain': folder('nogit'),
    '/code/odd': folder('root', { origin: 'github.com/odd/z', unresolvedRemote: true }),
    // Only the origin's owner counts: a client upstream adds no owner.
    '/code/up': folder('root', { origin: 'github.com/me/up', remotes: ['github.com/me/up', 'github.com/upstream/up'] }),
  }, {
    a: ['/code/a'], b: ['/code/b'], 'b/wt': ['/code/b'], gone: ['/code/gone'], client: ['/code/client'], other: ['/code/other'],
    plain: ['/code/plain'], odd: ['/code/odd'], up: ['/code/up'],
  });
  await withCtx({ ...fixture, config: { neverSend: ['github.com/client/*'], allowlist: ['GitHub.com/Other/*'] } }, (ctx) => {
    assert.deepEqual(suggestCandidates({ ...ctx, repos }, { days: 7 }).owners, [
      { owner: 'github.com/me/*', projects: 3, notes: 5 },
      { owner: 'gitlab.com/grp/*', projects: 1, notes: 4 },
    ]);
  });
});

test('repos: resolved, withCwd, unambiguous and complete count the keys with a recorded folder', { skip }, async () => {
  const fixture = build(inSession('a', '/code/a', 1), inSession('u', '/code/u', 1), inSession('n', '/code/n', 1), inSession('none', null, 1));
  const repos = reposOf({
    '/code/a': folder('root', { origin: 'github.com/me/a' }),
    '/code/u': folder('unknown'),
    '/code/n': folder('nogit'),
  }, { a: ['/code/a'], 'a/wt': ['/code/a'], u: ['/code/u'], n: ['/code/n'] }, { complete: false });
  await withCtx(fixture, (ctx) => {
    const result = suggestCandidates({ ...ctx, repos }, { days: 7 });
    assert.deepEqual(result.repos, { resolved: 2, withCwd: 3, unambiguous: 1, complete: false });
    assert.deepEqual(Object.keys(result), ['candidates', 'homeProject', 'owners', 'merges', 'repos']);
    assert.deepEqual(result.merges, []);
  });
});
