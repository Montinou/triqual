// Tests for bin/lib/content-gate.mjs: the content gate for files bound for the public repository (spec U2). Every term, home
// path, email and secret here is invented, and the ones that look like real data are built at runtime so no fixture needs an
// allowlist entry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gate from '../bin/lib/content-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(ROOT, 'bin', 'lib', 'content-gate.mjs');

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `content-gate-${label}-`));
  made.push(dir);
  return dir;
};

const addr = (local, domain) => `${local}@${domain}`;
const fakeKey = () => ['sk', '-', 'a'.repeat(24)].join('');
const TERM = 'globex';
const HOME = '/home/tester';

// gateFiles over in-memory files: { path: string | Buffer }.
const run = (files, over = {}) => gate.gateFiles(Object.keys(files), {
  readFile: (path) => Buffer.from(files[path]),
  terms: [TERM],
  home: HOME,
  allowSecrets: [],
  ...over,
});
const shown = (result) => result.hits.map((hit) => gate.formatHit(hit));

// ---- text checks ----

test('a clean file is not a hit', () => {
  const result = run({ 'src/a.txt': 'nothing to see here\n' });
  assert.deepEqual(result, { configured: true, hits: [] });
});

test('a deny term, a home path, an email and a secret are each a hit reported without the matched text', () => {
  const files = {
    'src/term.txt': `one\nowned by ${TERM} inc\n`,
    'src/home.txt': `path ${HOME}/work/x\n`,
    'src/mail.txt': `ask ${addr('someone', 'corp.com')}\n`,
    'src/key.txt': `key ${fakeKey()}\n`,
  };
  const result = run(files);
  assert.deepEqual(shown(result), [
    'src/term.txt:2 · local-term',
    'src/home.txt:1 · home-path',
    'src/mail.txt:1 · email',
    'src/key.txt:1 · secret',
  ]);
  const text = JSON.stringify(result) + shown(result).join('\n');
  for (const secret of [TERM, HOME, 'someone', fakeKey()]) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test('a term in a path is a path-level hit on line 0', () => {
  const result = run({ [`src/${TERM}.txt`]: 'clean\n' });
  assert.deepEqual(result.hits, [{ path: `src/${TERM}.txt`, line: 0, category: 'local-term' }]);
});

test('an ssh remote URL is not a hit', () => {
  const result = run({ 'README.md': `clone ${['git', 'github.com'].join('@')}:owner/repo.git\n` });
  assert.deepEqual(result.hits, []);
});

test('an allowSecrets entry covers a matching secret in its path only', () => {
  const allowSecrets = [{ path: 'src/key.txt', contains: fakeKey() }];
  const files = { 'src/key.txt': `key ${fakeKey()}\n`, 'src/other.txt': `key ${fakeKey()}\n` };
  assert.deepEqual(shown(run(files, { allowSecrets })), ['src/other.txt:1 · secret']);
});

test('the private slug is never a category: it is a term, so it reports as local-term', () => {
  const result = run({ 'src/a.txt': 'see acme/tools-private\n' }, { terms: ['acme/tools-private'] });
  assert.deepEqual(result.hits, [{ path: 'src/a.txt', line: 1, category: 'local-term' }]);
});

// ---- not-text ----

test('a NUL byte and an invalid UTF-8 byte are not-text hits on line 0, not a throw', () => {
  const files = {
    'bin/blob.dat': Buffer.from([0x61, 0x00, 0x62]),
    'src/latin.txt': Buffer.from([0x63, 0xe9, 0x0a]),
    'src/ok.txt': 'fine\n',
  };
  const result = run(files);
  assert.deepEqual(result.hits, [
    { path: 'bin/blob.dat', line: 0, category: 'not-text' },
    { path: 'src/latin.txt', line: 0, category: 'not-text' },
  ]);
});

test('a not-text file is not scanned, so a term inside invalid UTF-8 is still only not-text', () => {
  const bytes = Buffer.concat([Buffer.from(`${TERM} `), Buffer.from([0xff, 0x0a])]);
  assert.deepEqual(run({ 'src/x.txt': bytes }).hits, [{ path: 'src/x.txt', line: 0, category: 'not-text' }]);
});

// ---- forbidden paths ----

test('FORBIDDEN_PATHS is exactly the spec list', () => {
  assert.deepEqual(gate.FORBIDDEN_PATHS, [
    '/docs/', '/probes/', '/CLAUDE.md', '/AGENTS.md', '/.githooks/', '/.methodology/', '/progress.md', '/status.md',
    '/test/no-personal-data.test.mjs', '/test/brand-guard.test.mjs', '/test/e2e-probe.test.mjs', '/test/provider-probes.test.mjs',
  ]);
});

test('isForbidden matches root-anchored patterns only', () => {
  for (const path of ['docs/x.md', 'probes/a', 'CLAUDE.md', 'AGENTS.md', 'progress.md', 'status.md', '.githooks/pre-commit',
    '.methodology/sdd/x.md', 'test/brand-guard.test.mjs', 'test/no-personal-data.test.mjs', 'test/e2e-probe.test.mjs',
    'test/provider-probes.test.mjs', 'docs/deep/er/x.md']) {
    assert.equal(gate.isForbidden(path), true, path);
  }
  for (const path of ['plugins/progress-tracking/templates/progress.md', 'plugins/x/docs/a.md', 'src/CLAUDE.md', 'docsx/a.md',
    'docs', 'progress.md.bak', 'test/export-public.test.mjs', 'README.md']) {
    assert.equal(gate.isForbidden(path), false, path);
  }
});

test('a forbidden path is a forbidden-path hit on line 0 whatever its content', () => {
  const result = run({ 'docs/x.md': 'clean\n', 'CLAUDE.md': 'clean\n', 'plugins/progress-tracking/templates/progress.md': 'clean\n' });
  assert.deepEqual(result.hits, [
    { path: 'docs/x.md', line: 0, category: 'forbidden-path' },
    { path: 'CLAUDE.md', line: 0, category: 'forbidden-path' },
  ]);
});

test('a forbidden path is still scanned for content', () => {
  const result = run({ 'probes/a': `${TERM}\n` });
  assert.deepEqual(shown(result), ['probes/a:0 · forbidden-path', 'probes/a:1 · local-term']);
});

// ---- configuration ----

test('no terms means configured is false, and the other checks still run', () => {
  const result = run({ 'src/a.txt': `${TERM} ${addr('a', 'corp.com')}\n` }, { terms: [] });
  assert.equal(result.configured, false);
  assert.deepEqual(shown(result), ['src/a.txt:1 · email']);
});

test('formatHit is path:line · category', () => {
  assert.equal(gate.formatHit({ path: 'a/b.txt', line: 7, category: 'secret' }), 'a/b.txt:7 · secret');
});

test('gate-allow.json equals the export manifest allowSecrets', () => {
  const allow = JSON.parse(readFileSync(join(ROOT, 'bin', 'lib', 'gate-allow.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public-export.json'), 'utf8'));
  assert.deepEqual(allow, manifest.allowSecrets);
});

// ---- CLI ----

const gitEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv(), encoding: 'utf8' });
const commitAll = (dir, message) => {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
};
function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
function makeRepo(files) {
  const dir = tmp('repo');
  git(dir, 'init', '-q');
  writeFiles(dir, files);
  commitAll(dir, 'init');
  return dir;
}
// A HOME with no configuration and a deny file listing only the invented term.
function sandbox(terms = [TERM]) {
  const home = tmp('home');
  const deny = join(home, 'deny.txt');
  writeFileSync(deny, `# invented\n${terms.join('\n')}\n`);
  const env = { ...gitEnv(), HOME: home, PUBLIC_EXPORT_DENY: deny };
  delete env.TRIQUAL_GATE_NO_LOCAL_TERMS;
  delete env.MEMORY_REPORT_CONFIG;
  return env;
}
const cli = (cwd, args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });

test('CLI --all exits 1 on a planted term and 0 without it, printing path:line · category only', () => {
  const env = sandbox();
  const clean = makeRepo({ 'src/a.txt': 'fine\n' });
  const ok = cli(clean, ['--all'], env);
  assert.equal(ok.status, 0, ok.stderr);

  const dirty = makeRepo({ 'src/a.txt': 'fine\n', 'src/b.txt': `x\nowned by ${TERM}\n` });
  const bad = cli(dirty, ['--all'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /src\/b\.txt:2 · local-term/);
  assert.ok(!(bad.stdout + bad.stderr).includes(TERM));
});

test('CLI --all checks the index, not the working tree, and from a subdirectory', () => {
  const env = sandbox();
  const repo = makeRepo({ 'src/a.txt': 'fine\n' });
  writeFiles(repo, { 'src/a.txt': `${TERM}\n` });
  assert.equal(cli(join(repo, 'src'), ['--all'], env).status, 0);
  git(repo, 'add', 'src/a.txt');
  const bad = cli(join(repo, 'src'), ['--all'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /src\/a\.txt:1 · local-term/);
});

test('CLI --range reads the changed files at the head of the range', () => {
  const env = sandbox();
  const repo = makeRepo({ 'src/a.txt': `${TERM} already here\n`, 'src/b.txt': 'fine\n' });
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  writeFiles(repo, { 'src/b.txt': 'still fine\n', 'src/c.txt': `new ${TERM}\n`, 'docs/n.md': 'clean\n' });
  commitAll(repo, 'change');
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  for (const range of [`${base}..${head}`, `${base}...${head}`]) {
    const bad = cli(repo, ['--range', range], env);
    assert.equal(bad.status, 1, range);
    const out = bad.stdout + bad.stderr;
    assert.match(out, /src\/c\.txt:1 · local-term/);
    assert.match(out, /docs\/n\.md:0 · forbidden-path/);
    assert.ok(!out.includes('src/a.txt'), 'an unchanged file is not checked');
  }
});

test('CLI --range on a clean change exits 0 and a deleted file is not read', () => {
  const env = sandbox();
  const repo = makeRepo({ 'src/a.txt': `${TERM}\n`, 'src/b.txt': 'fine\n' });
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'rm', '-q', 'src/a.txt');
  writeFiles(repo, { 'src/b.txt': 'changed\n' });
  commitAll(repo, 'drop');
  const result = cli(repo, ['--range', `${base}..HEAD`], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('CLI exits 2 on a missing mode, both modes, an unknown flag, a bad range and outside a repository', () => {
  const env = sandbox();
  const repo = makeRepo({ 'src/a.txt': 'fine\n' });
  assert.equal(cli(repo, [], env).status, 2);
  assert.equal(cli(repo, ['--all', '--range', 'a..b'], env).status, 2);
  assert.equal(cli(repo, ['--all', '--bogus'], env).status, 2);
  assert.equal(cli(repo, ['--range'], env).status, 2);
  assert.equal(cli(repo, ['--range', 'HEAD'], env).status, 2);
  assert.equal(cli(repo, ['--range', '--output=x..HEAD'], env).status, 2);
  assert.equal(cli(repo, ['--range', 'nope..alsonope'], env).status, 2);
  assert.equal(cli(tmp('plain'), ['--all'], env).status, 2);
});

test('CLI exits 2 when no terms are configured, unless --no-terms or TRIQUAL_GATE_NO_LOCAL_TERMS=1', () => {
  const env = sandbox([]);
  const repo = makeRepo({ 'src/a.txt': `${TERM}\n` });
  const unconfigured = cli(repo, ['--all'], env);
  assert.equal(unconfigured.status, 2);
  assert.match(unconfigured.stderr, /no local terms/);
  assert.equal(cli(repo, ['--all', '--no-terms'], env).status, 0);
  assert.equal(cli(repo, ['--all'], { ...env, TRIQUAL_GATE_NO_LOCAL_TERMS: '1' }).status, 0);
});

test('CLI --no-terms still reports the other categories and uses no local configuration', () => {
  const env = { ...sandbox(), PUBLIC_EXPORT_DENY: join(tmp('absent'), 'missing.txt') };
  const repo = makeRepo({ 'src/a.txt': `${addr('someone', 'corp.com')}\n`, 'CLAUDE.md': 'x\n' });
  const result = cli(repo, ['--all', '--no-terms'], env);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /src\/a\.txt:1 · email/);
  assert.match(result.stdout + result.stderr, /CLAUDE\.md:0 · forbidden-path/);
});

test('CLI exits 2 when the deny file named by PUBLIC_EXPORT_DENY does not exist', () => {
  const env = { ...sandbox(), PUBLIC_EXPORT_DENY: join(tmp('absent'), 'missing.txt') };
  const repo = makeRepo({ 'src/a.txt': 'fine\n' });
  assert.equal(cli(repo, ['--all'], env).status, 2);
});

test('CLI --all covers a binary tracked file as not-text', () => {
  const env = sandbox();
  const repo = makeRepo({ 'src/a.txt': 'fine\n' });
  writeFileSync(join(repo, 'src', 'blob.bin'), Buffer.from([1, 0, 2]));
  commitAll(repo, 'bin');
  const result = cli(repo, ['--all'], env);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /src\/blob\.bin:0 · not-text/);
});
