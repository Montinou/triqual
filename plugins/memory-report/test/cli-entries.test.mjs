// `triqual memory allow | deny | never | unnever` with repository and owner entries (repo-identity spec 4.1, 4.5) through
// main(). SSH hosts resolve through an injected sshHost, so no test runs the real `ssh -G`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { main } from '../cli/memory.mjs';
import { loadConfig } from '../lib/config.mjs';
import { withTempHome } from './helpers.mjs';

const SSH = { 'github.com': 'github.com', 'github.com-work': 'github.com' };
const deps = { sshHost: async (host) => SSH[host] ?? null };

// Runs main with captured streams and the fake sshHost.
async function run(env, argv, d = deps) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, deps: d });
  return { code, out, err };
}
const lines = (s) => s.split('\n').filter(Boolean);
const writeConfig = (paths, raw) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, typeof raw === 'string' ? raw : JSON.stringify(raw));
};
const bytes = (paths) => readFileSync(paths.configFile, 'utf8');

const REFUSED = ['mont*', 'github.com/mont*', 'github.com/*/x', 'github.com/*', '*', 'notes/*', 'gh-work/client-org/app'];

// ---- normalization on add ------------------------------------------------------------------------------------------

test('never stores a pasted https URL normalized (Review Focus 4)', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['never', 'https://github.com/Owner/App.git']);
  // final fix I1: no repo-map.json yet, so no known repository matches it.
  assert.deepEqual(r, { code: 0, out: 'github.com/owner/app\n', err: 'memory-report: no known repository matches https://github.com/Owner/App.git; check it\n' });
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/owner/app']);
}));

test('allow GitHub.com/Acme/* stores github.com/acme/*', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['allow', 'GitHub.com/Acme/*']);
  assert.deepEqual(r, { code: 0, out: 'github.com/acme/*\n', err: 'memory-report: no known repository matches GitHub.com/Acme/*; check it\n' });
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['github.com/acme/*']);
}));

test('a repository-shaped entry is lower-cased, loses .git and the trailing slash, and takes the host aliases', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['allow', 'GitHub.com/Acme/App.git/', 'ssh.github.com/Acme/Tools', 'acme.visualstudio.com/*', 'Acme Tools']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['github.com/acme/app', 'github.com/acme/tools', 'dev.azure.com/acme/*', 'Acme Tools']);
}));

test('an scp remote resolves its host through sshHost: an alias with a dot lands on the real host', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['never', 'git@github.com-work:Acme/App.git', 'ssh://git@github.com:22/Globex/Site.git']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/acme/app', 'github.com/globex/site']);
}));

test('a remote URL that normalizes to null, or whose SSH host does not resolve, is refused and nothing is written', () => withTempHome(async ({ env, paths }) => {
  for (const url of ['file:///srv/acme/app', 'https://github.com/acme', 'git@unknown.example.invalid:acme/app.git']) {
    for (const cmd of ['allow', 'never']) {
      const r = await run(env, [cmd, 'keep', url]);
      assert.equal(r.code, 1, `${cmd} ${url}`);
      assert.equal(r.out, '');
      assert.match(r.err, /^memory-report: /);
      assert.equal(existsSync(paths.configFile), false, `${cmd} ${url} wrote the config`);
    }
  }
}));

test('each refusal example exits 1 and leaves the config unchanged, alone or next to a valid entry', () => withTempHome(async ({ env, paths }) => {
  for (const entry of REFUSED) {
    for (const cmd of ['allow', 'never']) {
      const fresh = await run(env, [cmd, entry]);
      assert.equal(fresh.code, 1, `${cmd} ${entry}`);
      assert.equal(existsSync(paths.configFile), false, `${cmd} ${entry} created the config`);
    }
  }
  writeConfig(paths, { version: 1, allowlist: ['keep'], neverSend: ['client-x'] });
  const before = bytes(paths);
  for (const entry of REFUSED) {
    for (const cmd of ['allow', 'never']) {
      const r = await run(env, [cmd, 'github.com/acme/app', entry]);
      assert.equal(r.code, 1, `${cmd} ${entry}`);
      assert.equal(r.out, '');
      assert.match(r.err, /^memory-report: /);
      assert.equal(bytes(paths), before, `${cmd} ${entry} changed the config`);
    }
  }
}));

// ---- edits on an invalid key (Review Focus 5) ---------------------------------------------------------------------

const INVALID_NEVER = ['client-x', 'client-y', 'github.com/mont*'];

test('never newname on an invalid never-send list exits 1 with the fixed message and leaves the file unchanged', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: INVALID_NEVER });
  const before = bytes(paths);
  const r = await run(env, ['never', 'newname']);
  assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: neverSend is invalid; fix the config first\n' });
  assert.equal(bytes(paths), before);
  assert.deepEqual(loadConfig(paths).raw.neverSend, INVALID_NEVER, 'the valid entries survive');
}));

test('allow on an invalid allowlist exits 1 with the fixed message and leaves the file unchanged', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, allowlist: ['keep', 'https://github.com/acme/app'] });
  const before = bytes(paths);
  const r = await run(env, ['allow', 'github.com/acme/*']);
  assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: allowlist is invalid; fix the config first\n' });
  assert.equal(bytes(paths), before);
}));

test('unnever github.com/mont* removes exactly that entry from an invalid list', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: INVALID_NEVER, other: 7 });
  const r = await run(env, ['unnever', 'github.com/mont*']);
  assert.deepEqual(r, { code: 0, out: 'client-x\nclient-y\n', err: '' });
  assert.deepEqual(loadConfig(paths).raw, { version: 1, neverSend: ['client-x', 'client-y'], other: 7 });
  assert.deepEqual(loadConfig(paths).invalidKeys, []);
}));

test('unnever nothing-here on an invalid list prints missing nothing-here, exits 0 and writes nothing', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: INVALID_NEVER });
  const before = bytes(paths);
  const r = await run(env, ['unnever', 'nothing-here']);
  assert.equal(r.code, 0);
  assert.match(r.out, /missing \(not in the never-send list\): nothing-here/);
  assert.equal(bytes(paths), before);
}));

test('never --list prints the raw entries, the invalid one marked (invalid)', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: INVALID_NEVER });
  const r = await run(env, ['never', '--list']);
  assert.deepEqual(r, { code: 0, out: 'client-x\nclient-y\ngithub.com/mont* (invalid)\n', err: '' });
}));

test('allow --list and block --list mark invalid entries too; a non-list value is one invalid entry, a non-string prints as JSON', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, allowlist: ['git@github.com:acme/app.git', 'acme/tools', 'github.com/acme/*', 7], clientTerms: ['acme', 'globex', ''] });
  assert.equal((await run(env, ['allow', '--list'])).out, 'git@github.com:acme/app.git (invalid)\nacme/tools\ngithub.com/acme/*\n7 (invalid)\n');
  assert.equal((await run(env, ['block', '--list'])).out, 'acme\nglobex\n (invalid)\n');
  writeConfig(paths, { version: 1, allowlist: 'acme/tools' });
  assert.equal((await run(env, ['allow', '--list'])).out, 'acme/tools (invalid)\n');
}));

// ---- removing: the exact stored string first, then the normalized form ----------------------------------------------

test('unnever removes the exact stored string first and only then the normalized form', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: ['GitHub.com/Acme/App', 'github.com/acme/app', 'https://github.com/acme/site'] });
  let r = await run(env, ['unnever', 'GitHub.com/Acme/App']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/acme/app', 'https://github.com/acme/site'], 'only the exact match goes');
  r = await run(env, ['unnever', 'https://github.com/acme/site']);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/acme/app'], 'a stored URL-shaped entry goes by its exact string');
  r = await run(env, ['unnever', 'https://github.com/Acme/App.git']);
  assert.deepEqual(r, { code: 0, out: '', err: '' });
  assert.deepEqual(loadConfig(paths).raw.neverSend, [], 'the pasted URL removes its normalized form');
}));

test('deny falls back to the normalized form of a repository-shaped or scp argument', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, allowlist: ['github.com/acme/*', 'github.com/acme/app', 'keep'] });
  const r = await run(env, ['deny', 'GitHub.com/Acme/*', 'git@github.com-work:Acme/App.git', 'git@unknown.example.invalid:acme/x.git']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(lines(r.out), ['keep', 'missing (not in the allowlist): git@unknown.example.invalid:acme/x.git']);
  assert.deepEqual(loadConfig(paths).raw.allowlist, ['keep']);
}));

// ---- final fix I1: never and allow store only entries that can match a repository -----------------------------------

const warning = (entry) => `memory-report: no known repository matches ${entry}; check it\n`;
// A repo-map.json recording `repos` for one folder, as saveRepoMap writes it.
const writeMap = (paths, repos) => {
  mkdirSync(paths.stateDir, { recursive: true });
  const folder = { repos: repos.map((repo) => ({ repo, seenAt: '2026-10-07T12:00:00.000Z' })), everNested: false, everUnresolvedRemote: false, everNoOrigin: false };
  writeFileSync(`${paths.stateDir}/repo-map.json`, JSON.stringify({ v: 2, rebuiltAt: null, folders: { '/code/app': folder } }));
};

test('final fix I1: the user-less scp form is a URL: never github.com:client/app.git stores github.com/client/app', () => withTempHome(async ({ env, paths }) => {
  writeMap(paths, ['github.com/client/app']);
  const r = await run(env, ['never', 'github.com:client/app.git', 'github.com:Client/Sub/App']);
  assert.deepEqual(r, { code: 0, out: 'github.com/client/app\ngithub.com/client/sub/app\n', err: warning('github.com:Client/Sub/App') });
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/client/app', 'github.com/client/sub/app']);
}));

test('final fix I1: a typed entry on an SSH alias host is stored resolved (never keeps the typed form too), and refused when ssh -G fails', () => withTempHome(async ({ env, paths }) => {
  writeMap(paths, ['github.com/client/app']);
  const never = await run(env, ['never', 'github.com-work/Client/*']);
  assert.deepEqual(never, { code: 0, out: 'github.com-work/client/*\ngithub.com/client/*\n', err: '' });
  const allow = await run(env, ['allow', 'github.com-work/me/*']);
  assert.deepEqual(allow, { code: 0, out: 'github.com/me/*\n', err: warning('github.com-work/me/*') });
  const before = bytes(paths);
  for (const cmd of ['allow', 'never']) {
    const r = await run(env, [cmd, 'keep', 'gh-unknown.example.invalid/client/*']);
    assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: argument 2: its host did not resolve through ssh -G to a usable host\n' }, cmd);
    assert.equal(bytes(paths), before, `${cmd} wrote the config`);
  }
}));

test('final fix I1: typed entries on github.com, gitlab.com, bitbucket.org and dev.azure.com never ask ssh', () => withTempHome(async ({ env, paths }) => {
  const asked = [];
  const d = { sshHost: async (host) => { asked.push(host); return null; } };
  const r = await run(env, ['never', 'github.com/a/*', 'www.gitlab.com/b/app', 'bitbucket.org/c/*', 'acme.visualstudio.com/*', 'ssh.github.com/d/app'], d);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked, []);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['github.com/a/*', 'gitlab.com/b/app', 'bitbucket.org/c/*', 'dev.azure.com/acme/*', 'github.com/d/app']);
}));

test('final fix I1: a pasted browser URL loses its /tree/ or /blob/ path', () => withTempHome(async ({ env, paths }) => {
  writeMap(paths, ['github.com/client/app', 'gitlab.com/group/sub/app']);
  const r = await run(env, ['never', 'https://github.com/client/app/tree/main', 'https://github.com/Client/App/blob/main/README.md', 'https://gitlab.com/group/sub/app/-/tree/main/src']);
  assert.deepEqual(r, { code: 0, out: 'github.com/client/app\ngitlab.com/group/sub/app\n', err: '' });
}));

test('final fix I1: an entry that matches no repository in repo-map.json is added with a warning on stderr', () => withTempHome(async ({ env, paths }) => {
  writeMap(paths, ['github.com/client/app']);
  const r = await run(env, ['never', 'github.com/clinet/*', 'github.com/client/*', 'acme']);
  assert.deepEqual(r, { code: 0, out: 'github.com/clinet/*\ngithub.com/client/*\nacme\n', err: warning('github.com/clinet/*') });
  const fresh = await run(env, ['allow', 'github.com/me/app']);
  assert.deepEqual(fresh, { code: 0, out: 'github.com/me/app\n', err: warning('github.com/me/app') });
}));

// ---- final fix M4 (Ruling 10 N2): a stored form must be a fixed point of the sync normalization ---------------------

test('final fix M4: allow or never of a URL or entry whose stored form re-normalizes differently is refused', () => withTempHome(async ({ env, paths }) => {
  for (const cmd of ['allow', 'never']) {
    for (const entry of ['https://github.com/acme/app.git.git', 'github.com/acme/app.git.git']) {
      const r = await run(env, [cmd, entry]);
      assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: argument 1 does not normalize to a stable entry\n' }, `${cmd} ${entry}`);
      assert.equal(existsSync(paths.configFile), false, `${cmd} ${entry} wrote the config`);
    }
  }
}));
