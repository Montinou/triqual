import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEntry, entryMatchesRepo, isUrlShaped, normalizeEntrySync, stripBrowserPath } from '../lib/entries.mjs';

// ---- classifyEntry (spec 4.1) ----

test('classifyEntry: names are anything not repository-shaped, without *, with at most one /', () => {
  for (const name of ['alpha', 'Delta Works', 'base/wt', 'my.project', 'my.project/wt', 'github.com/acme', ' padded ']) {
    assert.equal(classifyEntry(name), 'name', name);
  }
});

test('classifyEntry: repositories have a dotted host and at least two more segments, no *', () => {
  for (const repo of ['github.com/acme/app', 'gitlab.com/group/sub/name', 'GitHub.com/Acme/App.git/', 'dev.azure.com/acme/proj/repo']) {
    assert.equal(classifyEntry(repo), 'repo', repo);
  }
});

test('classifyEntry: owners end in a whole * segment with at least one segment between the host and *', () => {
  for (const owner of ['github.com/acme/*', 'gitlab.com/group/sub/*', 'GitHub.com/Acme/*']) {
    assert.equal(classifyEntry(owner), 'owner', owner);
  }
});

test('classifyEntry: every spec 4.1 refusal example is invalid', () => {
  for (const bad of ['mont*', 'github.com/mont*', 'github.com/*/x', 'github.com/*', '*', 'notes/*', 'gh-work/client-org/app']) {
    assert.equal(classifyEntry(bad), 'invalid', bad);
  }
});

test('classifyEntry: an empty segment, an empty string and a non-string are invalid', () => {
  for (const bad of ['github.com//app', 'github.com/acme//app', '/alpha', 'alpha/', '/', '', null, undefined, 42, ['alpha']]) {
    assert.equal(classifyEntry(bad), 'invalid', String(bad));
  }
});

test('classifyEntry: a stored entry that looks like a URL (:// or the scp shape) is invalid', () => {
  for (const url of ['https://github.com/acme/app', 'ssh://git@example.invalid/acme/app.git', 'git@github.com:acme/app.git', 'deploy@example.invalid:acme/app', 'name://x']) {
    assert.equal(classifyEntry(url), 'invalid', url);
  }
});

test('classifyEntry: repository-shaped entries with a ".", ".." or whitespace segment are invalid', () => {
  for (const bad of ['github.com/./app', 'github.com/acme/..', 'github.com/acme/my app', 'github.com/acme/a\u0001b']) {
    assert.equal(classifyEntry(bad), 'invalid', JSON.stringify(bad));
  }
});

// ---- normalizeEntrySync (spec 4.1 adding, step 2) ----

test('normalizeEntrySync: lower-cases and strips a trailing .git and /', () => {
  assert.equal(normalizeEntrySync('GitHub.com/Acme/App.git/'), 'github.com/acme/app');
  assert.equal(normalizeEntrySync('github.com/acme/app'), 'github.com/acme/app');
  assert.equal(normalizeEntrySync('gitlab.com/Group/Sub/Name.git'), 'gitlab.com/group/sub/name');
  assert.equal(normalizeEntrySync('GitHub.com/Acme/*'), 'github.com/acme/*');
  assert.equal(normalizeEntrySync('github.com/acme/*/'), 'github.com/acme/*');
});

test('normalizeEntrySync: applies the host aliases of normalizeRemote', () => {
  assert.equal(normalizeEntrySync('ssh.github.com/acme/app'), 'github.com/acme/app');
  assert.equal(normalizeEntrySync('ssh.github.com/acme/*'), 'github.com/acme/*');
  assert.equal(normalizeEntrySync('dev.azure.com/acme/proj/_git/repo'), 'dev.azure.com/acme/proj/repo');
  assert.equal(normalizeEntrySync('acme.visualstudio.com/proj/_git/repo'), 'dev.azure.com/acme/proj/repo');
  assert.equal(normalizeEntrySync('ssh.dev.azure.com/v3/acme/proj/repo'), 'dev.azure.com/acme/proj/repo');
});

test('normalizeEntrySync: null for names, URLs and refused entries', () => {
  for (const v of ['alpha', 'base/wt', 'github.com/acme', 'https://github.com/acme/app', 'git@github.com:acme/app',
    'mont*', 'github.com/mont*', 'github.com/*/x', 'github.com/*', '*', 'notes/*', 'gh-work/client-org/app',
    'github.com//app', '', null]) {
    assert.equal(normalizeEntrySync(v), null, String(v));
  }
});

test('normalizeEntrySync: entries on an aliased host take the alias target, so they match normalized remotes', async () => {
  const { normalizeRemote } = await import('../lib/repo.mjs');
  const remote = async (url) => (await normalizeRemote(url, { sshHost: async (h) => h })).repo;
  const cases = [
    // [entry, stored canonical form, a remote it must match]
    ['acme.visualstudio.com/Proj/*', 'dev.azure.com/acme/proj/*', 'https://acme.visualstudio.com/Proj/_git/Repo'],
    ['acme.visualstudio.com/proj/_git/*', 'dev.azure.com/acme/proj/*', 'https://acme.visualstudio.com/proj/_git/repo'],
    ['acme.visualstudio.com/proj/_git/repo', 'dev.azure.com/acme/proj/repo', 'https://acme.visualstudio.com/proj/_git/repo'],
    ['ssh.dev.azure.com/acme/*', 'dev.azure.com/acme/*', 'git@ssh.dev.azure.com:v3/acme/proj/repo'],
    ['ssh.dev.azure.com/v3/acme/*', 'dev.azure.com/acme/*', 'git@ssh.dev.azure.com:v3/acme/proj/repo'],
    ['ssh.dev.azure.com/acme/proj/*', 'dev.azure.com/acme/proj/*', 'git@ssh.dev.azure.com:v3/acme/proj/repo'],
    ['ssh.dev.azure.com/acme/proj/repo', 'dev.azure.com/acme/proj/repo', 'git@ssh.dev.azure.com:v3/acme/proj/repo'],
    ['dev.azure.com/acme/*', 'dev.azure.com/acme/*', 'git@ssh.dev.azure.com:acme/proj/repo'],
    ['ssh.dev.azure.com/acme/proj/repo', 'dev.azure.com/acme/proj/repo', 'git@ssh.dev.azure.com:acme/proj/repo'],
    ['ssh.dev.azure.com/v3/acme/proj/repo', 'dev.azure.com/acme/proj/repo', 'https://dev.azure.com/acme/proj/_git/repo'],
    ['dev.azure.com/acme/proj/_git/*', 'dev.azure.com/acme/proj/*', 'https://dev.azure.com/acme/proj/_git/repo'],
    ['ssh.github.com/acme/app', 'github.com/acme/app', 'ssh://git@ssh.github.com:443/acme/app.git'],
    ['ssh.github.com/acme/*', 'github.com/acme/*', 'git@github.com:acme/app.git'],
  ];
  for (const [entry, stored, url] of cases) {
    assert.equal(normalizeEntrySync(entry), stored, entry);
    assert.equal(classifyEntry(entry), stored.endsWith('/*') ? 'owner' : 'repo', entry);
    assert.equal(entryMatchesRepo(entry, await remote(url)), true, `${entry} ~ ${url}`);
  }
});

test('legacy visualstudio.com remotes, with or without DefaultCollection, are blocked by every entry form', async () => {
  const { normalizeRemote } = await import('../lib/repo.mjs');
  const remotes = [
    'https://acme.visualstudio.com/DefaultCollection/Proj/_git/Repo',
    'https://acme.visualstudio.com/Proj/_git/Repo',
    'https://acme.visualstudio.com/DefaultCollection/Proj/_git/Repo.git/',
    'ssh://acme.visualstudio.com:22/DefaultCollection/Proj/_ssh/Repo',
    'git@vs-ssh.visualstudio.com:v3/acme/Proj/Repo',
    'git@ssh.dev.azure.com:v3/acme/Proj/Repo',
  ];
  const entries = [
    ['dev.azure.com/acme/*', 'dev.azure.com/acme/*'],
    ['acme.visualstudio.com/*', 'dev.azure.com/acme/*'],
    ['acme.visualstudio.com/DefaultCollection/*', 'dev.azure.com/acme/*'],
    ['acme.visualstudio.com/DefaultCollection/Proj/*', 'dev.azure.com/acme/proj/*'],
    ['acme.visualstudio.com/proj/*', 'dev.azure.com/acme/proj/*'],
    ['acme.visualstudio.com/defaultcollection/proj/_git/repo', 'dev.azure.com/acme/proj/repo'],
    ['acme.visualstudio.com/proj/_git/repo', 'dev.azure.com/acme/proj/repo'],
    ['vs-ssh.visualstudio.com/v3/acme/proj/repo', 'dev.azure.com/acme/proj/repo'],
    ['dev.azure.com/acme/proj/repo', 'dev.azure.com/acme/proj/repo'],
  ];
  for (const url of remotes) {
    const repo = (await normalizeRemote(url, { sshHost: async (h) => h })).repo;
    assert.equal(repo, 'dev.azure.com/acme/proj/repo', url);
    for (const [entry, stored] of entries) {
      assert.equal(normalizeEntrySync(entry), stored, entry);
      assert.equal(entryMatchesRepo(entry, repo), true, `${entry} ~ ${url}`);
    }
  }
});

test('classifyEntry: an entry on an aliased host that no alias pattern maps is invalid, and such remotes are null', async () => {
  const { normalizeRemote } = await import('../lib/repo.mjs');
  for (const bad of [
    'a.b.visualstudio.com/proj/_git/repo',
    'a.b.visualstudio.com/*',
    'ssh.dev.azure.com/v3/*',
    'ssh.dev.azure.com/v3/acme',
    'vs-ssh.visualstudio.com/v3/*',
  ]) {
    assert.equal(normalizeEntrySync(bad), null, bad);
    assert.equal(classifyEntry(bad), 'invalid', bad);
  }
  // No entry can name a multi-label visualstudio.com host, so its remotes fail closed: null, never an unblockable repo.
  assert.equal((await normalizeRemote('https://a.b.visualstudio.com/proj/_git/repo', { sshHost: async (h) => h })).repo, null);
});

// ---- entryMatchesRepo ----

test('entryMatchesRepo: a repository entry matches its repository, lower-cased on both sides', () => {
  assert.equal(entryMatchesRepo('github.com/acme/app', 'github.com/acme/app'), true);
  assert.equal(entryMatchesRepo('GitHub.com/Acme/App.git', 'github.com/acme/app'), true);
  assert.equal(entryMatchesRepo('github.com/acme/app', 'GITHUB.COM/ACME/APP'), true);
  assert.equal(entryMatchesRepo('github.com/acme/app', 'github.com/acme/app2'), false);
  assert.equal(entryMatchesRepo('github.com/acme/app', 'github.com/acme/app/sub'), false);
});

test('entryMatchesRepo: the stored form of a repository whose name ends in .git blocks that repository (fix 1 M1)', async () => {
  const { normalizeRemote } = await import('../lib/repo.mjs');
  const repo = (await normalizeRemote('https://github.com/acme/app.git.git', { sshHost: async (h) => h })).repo;
  assert.equal(repo, 'github.com/acme/app.git');
  assert.equal(entryMatchesRepo(repo, repo), true);
  assert.equal(entryMatchesRepo('GitHub.com/Acme/App.git', 'github.com/acme/app.git'), true);
  assert.equal(entryMatchesRepo('github.com/acme/app', 'github.com/acme/app.git'), false);
});

test('entryMatchesRepo: an owner entry matches every repository under it and nothing else', () => {
  assert.equal(entryMatchesRepo('github.com/acme/*', 'github.com/acme/app'), true);
  assert.equal(entryMatchesRepo('GitHub.com/ACME/*', 'github.com/acme/app'), true);
  assert.equal(entryMatchesRepo('gitlab.com/group/*', 'gitlab.com/group/sub/name'), true);
  assert.equal(entryMatchesRepo('github.com/acme/*', 'github.com/acmex/app'), false);
  assert.equal(entryMatchesRepo('github.com/acme/*', 'github.com/acme'), false);
  assert.equal(entryMatchesRepo('github.com/acme/*', 'gitlab.com/acme/app'), false);
});

test('entryMatchesRepo: names, invalid entries and non-string repositories never match', () => {
  assert.equal(entryMatchesRepo('alpha', 'alpha'), false);
  assert.equal(entryMatchesRepo('my.project/wt', 'my.project/wt'), false);
  assert.equal(entryMatchesRepo('github.com/*', 'github.com/acme/app'), false);
  assert.equal(entryMatchesRepo('https://github.com/acme/app', 'github.com/acme/app'), false);
  assert.equal(entryMatchesRepo('github.com/acme/app', null), false);
  assert.equal(entryMatchesRepo(null, 'github.com/acme/app'), false);
});

test('entries.mjs is a leaf: it imports nothing from config.mjs or policy.mjs', () => {
  const src = readFileSync(new URL('../lib/entries.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"][^'"]*(config|policy)\.mjs['"]/);
});

// ---- final fix I1 and M1: hosts that can never match, the user-less scp form, www. and a trailing dot ----

test('final fix I1: a repository or owner entry whose host is not a plain host name is invalid', () => {
  for (const bad of ['github.com:client/sub/app', 'github.com:22/client/app', 'git@example.invalid/client/app', 'github.com%2e/client/app', 'github.com!/client/*']) {
    assert.equal(normalizeEntrySync(bad), null, bad);
    assert.equal(classifyEntry(bad), 'invalid', bad);
  }
  // Letters, digits, `.`, `_` and `-` stay plain: `_` because ssh host names may carry it, as remotes resolve them.
  assert.equal(normalizeEntrySync('git_host.example.invalid/Acme/App'), 'git_host.example.invalid/acme/app');
  assert.equal(normalizeEntrySync('git-host.example.invalid/acme/*'), 'git-host.example.invalid/acme/*');
});

test('final fix I1: the user-less scp form host:path is URL-shaped, so a stored one is invalid and never a name', () => {
  for (const url of ['github.com:client/app.git', 'gh-work:client/app', 'github.com:client/sub/app']) {
    assert.equal(isUrlShaped(url), true, url);
    assert.equal(classifyEntry(url), 'invalid', url);
  }
  for (const notUrl of ['github.com/client/app', 'acme', 'base/wt:x', 'my.project']) assert.equal(isUrlShaped(notUrl), false, notUrl);
});

test('final fix M1: www. and one trailing dot on the host are canonical on entries', () => {
  assert.equal(normalizeEntrySync('www.github.com/Client/*'), 'github.com/client/*');
  assert.equal(normalizeEntrySync('www.gitlab.com/group/app'), 'gitlab.com/group/app');
  assert.equal(normalizeEntrySync('www.bitbucket.org/team/app'), 'bitbucket.org/team/app');
  assert.equal(normalizeEntrySync('github.com./client/app'), 'github.com/client/app');
  assert.equal(normalizeEntrySync('www.github.com./client/app'), 'github.com/client/app');
  assert.equal(normalizeEntrySync('github./client/app'), null, 'no dot is left');
  assert.equal(entryMatchesRepo('www.github.com/client/*', 'github.com/client/app'), true);
});

test('final fix I1: stripBrowserPath cuts a GitHub /tree/ or /blob/ path and any /-/tree/ or /-/blob/ path, nothing else', () => {
  assert.equal(stripBrowserPath('github.com/client/app/tree/main'), 'github.com/client/app');
  assert.equal(stripBrowserPath('github.com/client/app/blob/main/readme.md'), 'github.com/client/app');
  assert.equal(stripBrowserPath('gitlab.com/group/sub/app/-/tree/main/src'), 'gitlab.com/group/sub/app');
  assert.equal(stripBrowserPath('gitlab.com/group/app/-/blob/main/x'), 'gitlab.com/group/app');
  // Narrow: a GitLab subgroup named tree, a repository named blob, and other paths stay as they are.
  for (const kept of ['gitlab.com/group/tree/app', 'gitlab.com/group/sub/tree/app', 'github.com/client/blob', 'github.com/client/app', 'gitlab.com/group/app/-/merge_requests/1']) {
    assert.equal(stripBrowserPath(kept), kept, kept);
  }
});
