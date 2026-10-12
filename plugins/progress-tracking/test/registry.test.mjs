import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  registerRepo, listRepos, listResolved, registryPath, readRegistry as readEntries,
} from '../lib/registry.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(PLUGIN, 'lib', 'registry.mjs');
const GATE = join(PLUGIN, 'scripts', 'gate.mjs');
const INIT = join(PLUGIN, 'scripts', 'init.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const T1 = new Date('2026-09-27T12:00:00.000Z');
const T2 = new Date('2026-09-28T08:30:00.000Z');
const registryOf = (home) => join(home, '.config', 'triqual', 'repos.json');
const readRegistry = (home) => JSON.parse(readFileSync(registryOf(home), 'utf8'));
const PROBE_CM = join(PLUGIN, '..', '..', 'probes', 'e2e', 'cm');
// probes/ exists only in the private checkout (its root carries .githooks/pre-commit).
const isPrivateCheckout = existsSync(join(PLUGIN, '..', '..', '.githooks', 'pre-commit'));
delete process.env.TRIQUAL_REGISTRY_DIR; // the in-process tests start from the default registry
delete process.env.CM_REGISTRY_DIR;

// Runs fn with CM_REGISTRY_DIR set to value (deleted when undefined), then restores it.
function withRegistryEnv(value, fn) {
  const saved = process.env.CM_REGISTRY_DIR;
  if (value === undefined) delete process.env.CM_REGISTRY_DIR;
  else process.env.CM_REGISTRY_DIR = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CM_REGISTRY_DIR;
    else process.env.CM_REGISTRY_DIR = saved;
  }
}

// Every child runs with a temp HOME, no XDG_CONFIG_HOME, no global or system git config and no inherited
// repo-selecting variables.
const cleanEnv = (home) => {
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig') };
  for (const k of ['XDG_CONFIG_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return env;
};

// A temp dir with `home/` and a helper that makes git repos (one commit) under it; removed afterwards.
function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-reg-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'gitconfig'), '');
  const env = cleanEnv(home);
  const makeRepo = (name) => {
    const repo = join(dir, name);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, env });
    execFileSync('git', [...ID, 'commit', '-qm', 'initial'], { cwd: repo, env });
    return repo;
  };
  try {
    fn({ dir, home, env, makeRepo });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registerRepo creates, upserts and keeps shareable', () => withDir(({ dir, home, makeRepo }) => {
  const repo = makeRepo('repo');
  registerRepo(home, { root: repo, mode: 'committed', now: T1 });
  assert.deepEqual(readRegistry(home), {
    version: 1,
    repos: [{ root: repo, mode: 'committed', lastSeen: '2026-09-27T12:00:00.000Z', shareable: false }],
  });

  // The user marks it shareable; a later upsert (through a symlink, so the realpath matters) keeps that.
  const reg = readRegistry(home);
  reg.repos[0].shareable = true;
  writeFileSync(registryOf(home), JSON.stringify(reg));
  const link = join(dir, 'link');
  symlinkSync(repo, link);
  registerRepo(home, { root: link, mode: 'local', now: T2 });
  assert.deepEqual(readRegistry(home).repos, [
    { root: repo, mode: 'local', lastSeen: '2026-09-28T08:30:00.000Z', shareable: true },
  ]);

  // A second repo is appended, with shareable defaulting to false.
  const other = makeRepo('other');
  registerRepo(home, { root: other, mode: 'committed', now: T1 });
  assert.deepEqual(readRegistry(home).repos.map((r) => [r.root, r.shareable]), [[repo, true], [other, false]]);

}));

test('registerRepo leaves an unparsable or misshapen registry untouched', () => withDir(({ home, makeRepo }) => {
  const repo = makeRepo('repo');
  mkdirSync(dirname(registryOf(home)), { recursive: true });
  for (const bad of ['{ nope', '', '[]', 'null', '42', '{"version":1}', '{"version":1,"repos":"x"}', '{"repos":{}}']) {
    writeFileSync(registryOf(home), bad);
    registerRepo(home, { root: repo, mode: 'committed', now: T1 });
    assert.equal(readFileSync(registryOf(home), 'utf8'), bad, JSON.stringify(bad));
  }
}));

// Each case makes a different step fail: mkdir (HOME is a file), the atomic write (a read-only config dir), and
// realpath (the root is gone). None throws, and none prints anything.
test('registerRepo never throws and never prints', { skip: process.getuid?.() === 0 && 'root writes read-only dirs' }, () => withDir(({ dir, home, env, makeRepo }) => {
  const repo = makeRepo('repo');
  const fileHome = join(dir, 'home-is-a-file');
  writeFileSync(fileHome, 'x');
  const roHome = join(dir, 'ro-home');
  mkdirSync(dirname(registryOf(roHome)), { recursive: true });
  chmodSync(dirname(registryOf(roHome)), 0o555);
  const cases = [[fileHome, repo], [roHome, repo], [home, join(dir, 'missing')]];
  try {
    for (const [h, root] of cases) {
      assert.doesNotThrow(() => registerRepo(h, { root, mode: 'committed', now: T1 }), h);
    }
    const script = `import { registerRepo } from ${JSON.stringify(pathToFileURL(REGISTRY).href)};
      for (const [h, root] of ${JSON.stringify(cases)}) registerRepo(h, { root, mode: 'committed', now: new Date() });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.equal(existsSync(registryOf(roHome)), false);
    assert.equal(existsSync(registryOf(home)), false);
  } finally {
    chmodSync(dirname(registryOf(roHome)), 0o755);
  }
}));

test('listRepos drops vanished roots and tolerates a corrupt file', () => withDir(({ dir, home, makeRepo }) => {
  assert.deepEqual(listRepos(home), []);
  mkdirSync(dirname(registryOf(home)), { recursive: true });
  for (const bad of ['{ nope', '[]', 'null', '{"version":1,"repos":"x"}']) {
    writeFileSync(registryOf(home), bad);
    assert.deepEqual(listRepos(home), [], bad);
  }

  const committed = makeRepo('committed');
  writeFileSync(join(committed, 'progress.md'), '# Progress\n');
  const local = makeRepo('local');
  mkdirSync(join(local, '.git', 'methodology'));
  writeFileSync(join(local, '.git', 'methodology', 'progress.md'), '# Progress\n');
  const optedOut = makeRepo('opted-out'); // progress.md removed since it registered
  const vanished = join(dir, 'vanished');
  writeFileSync(registryOf(home), JSON.stringify({
    version: 1,
    repos: [
      { root: committed, mode: 'committed', lastSeen: '2026-09-27T12:00:00.000Z', shareable: true },
      { root: optedOut, mode: 'committed', lastSeen: '2026-09-27T12:00:00.000Z', shareable: false },
      { root: vanished, mode: 'committed', lastSeen: '2026-09-27T12:00:00.000Z', shareable: false },
      { root: local, mode: 'local', lastSeen: '2026-09-28T08:30:00.000Z' },
      'not an entry',
    ],
  }));
  assert.deepEqual(listRepos(home), [
    { root: committed, mode: 'committed', lastSeen: '2026-09-27T12:00:00.000Z', shareable: true },
    { root: local, mode: 'local', lastSeen: '2026-09-28T08:30:00.000Z', shareable: false },
  ]);
}));

const spawnGate = (cwd, env) => spawnSync(process.execPath, [GATE, 'session-start'], {
  cwd, env, input: JSON.stringify({ cwd }), encoding: 'utf8',
});

test('session-start registers the repo', () => withDir(({ dir, home, env, makeRepo }) => {
  const repo = makeRepo('repo');
  writeFileSync(join(repo, 'progress.md'), '# Progress\n\n## 2026-09-27 — First\n- done\n');
  writeFileSync(join(repo, 'status.md'), '# Status\n');
  const before = Date.now();
  const r = spawnGate(repo, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout); // the hook's stdout is only the hook JSON
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  const { repos } = readRegistry(home);
  assert.equal(repos.length, 1);
  assert.deepEqual({ ...repos[0], lastSeen: null }, { root: repo, mode: 'committed', lastSeen: null, shareable: false });
  assert.ok(Date.parse(repos[0].lastSeen) >= before - 1000, repos[0].lastSeen);

  // A HOME where the registry cannot be written changes nothing in the hook's output.
  const fileHome = join(dir, 'home-is-a-file');
  writeFileSync(fileHome, 'x');
  const blocked = spawnGate(repo, { ...env, HOME: fileHome });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout, r.stdout);
  assert.equal(blocked.stderr, '');

  // A repo that is not opted in is not registered.
  const plain = makeRepo('plain');
  const silent = spawnGate(plain, env);
  assert.equal(silent.stdout, '');
  assert.equal(readRegistry(home).repos.length, 1);
}));

test('progress-init registers the repo in both modes', () => withDir(({ home, env, makeRepo }) => {
  const committed = makeRepo('committed');
  const local = makeRepo('local');
  for (const [cwd, args] of [[committed, []], [local, ['--local']]]) {
    const r = spawnSync(process.execPath, [INIT, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    JSON.parse(r.stdout); // the report is still the whole stdout
  }
  assert.deepEqual(readRegistry(home).repos.map((r) => [r.root, r.mode, r.shareable]),
    [[committed, 'committed', false], [local, 'local', false]]);
}));

// Review Focus 6: two processes registering at once must not lose each other's entries. Each process registers its
// own set of roots, from a common start barrier; any lost update drops a root for good.
test('registerRepo from two processes keeps both repos', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-reg-race-')));
  try {
    const home = join(dir, 'home');
    mkdirSync(home);
    const go = join(dir, 'go');
    const PER_PROCESS = 20;
    const rootsOf = (tag) => Array.from({ length: PER_PROCESS }, (_, i) => {
      const root = join(dir, `${tag}${i}`);
      mkdirSync(root);
      return root;
    });
    const sets = [rootsOf('a'), rootsOf('b')];
    const script = (roots) => `
      import { existsSync } from 'node:fs';
      import { registerRepo } from ${JSON.stringify(pathToFileURL(REGISTRY).href)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (!existsSync(${JSON.stringify(go)})) sleep(5);
      for (const root of ${JSON.stringify(roots)}) registerRepo(${JSON.stringify(home)}, { root, mode: 'committed', now: new Date() });`;
    const runChild = (roots) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(roots)], {
        env: cleanEnv(home), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    const children = sets.map(runChild);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(go, '');
    for (const r of await Promise.all(children)) assert.deepEqual([r.code, r.stderr], [0, '']);
    const roots = readRegistry(home).repos.map((r) => r.root).sort();
    assert.deepEqual(roots, [...sets[0], ...sets[1]].sort());
    assert.equal(existsSync(`${registryOf(home)}.lock`), false, 'the registry lock is released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registerRepo swallows a lock timeout: a held registry lock means no write and no throw', () => withDir(({ home, env, makeRepo }) => {
  const repo = makeRepo('repo');
  mkdirSync(dirname(registryOf(home)), { recursive: true });
  writeFileSync(`${registryOf(home)}.lock`, 'another session\n'); // fresh: waited for, never taken over
  const script = `import { registerRepo } from ${JSON.stringify(pathToFileURL(REGISTRY).href)};
    registerRepo(${JSON.stringify(home)}, { root: ${JSON.stringify(repo)}, mode: 'committed', now: new Date() });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, CM_LOCK_TIMEOUT_MS: '300' }, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  assert.equal(existsSync(registryOf(home)), false);
  assert.equal(readFileSync(`${registryOf(home)}.lock`, 'utf8'), 'another session\n');
}));

// CM_REGISTRY_DIR points the registry (repos.json and its lock) at another directory, so the e2e probe's throwaway repos
// never reach the real ~/.config/triqual/repos.json.
test('CM_REGISTRY_DIR moves the registry for every reader and writer, and home is left alone', () => withDir(({ dir, home, makeRepo }) => {
  const repo = makeRepo('repo');
  const override = join(dir, 'probe-registry');
  withRegistryEnv(override, () => {
    assert.equal(registryPath(home), join(override, 'repos.json'));
    registerRepo(home, { root: repo, mode: 'committed', now: T1 });
    assert.deepEqual(JSON.parse(readFileSync(join(override, 'repos.json'), 'utf8')).repos.map((r) => r.root), [repo]);
    assert.deepEqual(readEntries(home).map((r) => r.root), [repo]);
    assert.equal(existsSync(`${join(override, 'repos.json')}.lock`), false, 'the lock sits beside it and is released');
  });
  assert.equal(existsSync(join(home, '.config')), false, 'nothing under home');
  // Without the override the default registry is read again.
  assert.equal(registryPath(home), registryOf(home));
}));

test('an unusable CM_REGISTRY_DIR disables the registry: no write anywhere, no entries read, no throw', () => withDir(({ dir, home, makeRepo }) => {
  const repo = makeRepo('repo');
  registerRepo(home, { root: repo, mode: 'committed', now: T1 }); // the default registry holds the repo
  const before = readFileSync(registryOf(home), 'utf8');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const value of ['', 'relative/registry']) {
      withRegistryEnv(value, () => {
        assert.throws(() => registryPath(home), /TRIQUAL_REGISTRY_DIR must be an absolute path/);
        assert.doesNotThrow(() => registerRepo(home, { root: repo, mode: 'local', now: T2 }));
        assert.deepEqual(readEntries(home), [], `CM_REGISTRY_DIR=${JSON.stringify(value)} still reads the default registry`);
        assert.deepEqual(listRepos(home), []);
        assert.equal(existsSync(join(dir, 'relative')), false);
        assert.equal(existsSync(join(dir, 'repos.json')), false);
      });
    }
  } finally {
    process.chdir(cwd);
  }
  assert.equal(readFileSync(registryOf(home), 'utf8'), before, 'the default registry is untouched');
}));

test("the e2e probe's cm wrapper registers progress-init repos under CM_REGISTRY_DIR, never under HOME", { skip: !isPrivateCheckout && 'needs probes/e2e (private checkout)' }, () => withDir(({ dir, home, env, makeRepo }) => {
  const repo = makeRepo('repo');
  const override = join(dir, 'probe-registry');
  const r = spawnSync(PROBE_CM, ['progress-init', '--local'], { cwd: repo, env: { ...env, CM_REGISTRY_DIR: override }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(override, 'repos.json'), 'utf8')).repos.map((e) => [e.root, e.mode]),
    [[repo, 'local']]);
  assert.equal(existsSync(registryOf(home)), false, 'the HOME registry was written');
  // The SessionStart hook, as the probe's claude runs fire it, honors it too.
  const seen = JSON.parse(readFileSync(join(override, 'repos.json'), 'utf8')).repos[0].lastSeen;
  const gate = spawnGate(repo, { ...env, CM_REGISTRY_DIR: override });
  assert.equal(gate.status, 0, gate.stderr);
  assert.notEqual(JSON.parse(readFileSync(join(override, 'repos.json'), 'utf8')).repos[0].lastSeen, seen);
  assert.equal(existsSync(registryOf(home)), false, 'the HOME registry was written by session-start');
}));

test('a store-mode entry is registered and reported by listResolved, with its store tracking', () => withDir(({ dir, home, env, makeRepo }) => {
  const repo = makeRepo('store-repo');
  const plain = makeRepo('plain'); // no marker, no progress.md: not an opted-in repo
  execFileSync('git', ['config', '--local', 'triqual.tracking', 'store'], { cwd: repo, env });
  registerRepo(home, { root: repo, mode: 'store', now: T1 });
  registerRepo(home, { root: plain, mode: 'store', now: T1 });
  assert.deepEqual(readRegistry(home).repos.map((r) => [r.root, r.mode]), [[repo, 'store'], [plain, 'store']]);
  assert.deepEqual(listRepos(home), [{ root: repo, mode: 'store', lastSeen: '2026-09-27T12:00:00.000Z', shareable: false }]);
  const [resolved] = listResolved(home);
  assert.equal(resolved.tracking.mode, 'store');
  assert.equal(resolved.tracking.repoRoot, repo);
  assert.equal(existsSync(join(dir, 'data')), false, 'resolving never creates a data dir');
}));
