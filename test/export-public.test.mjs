// Tests for bin/lib/export.mjs: manifest, HEAD file selection, staging with the slug rewrite, the five-category content
// check and the staged test run. Every repository here is a throwaway with invented content; the private slug is acme/tools
// and nothing reads the real configuration (spec 4.3 to 4.6).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ex from '../bin/lib/export.mjs';
import { BRAND } from '../plugins/methodology/bin/lib/brand.mjs';

// Built into the URL forms below so no line of this file reads as an email address.
const AT = '@';
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `export-public-${label}-`));
  made.push(dir);
  return dir;
};

// git without the caller's GIT_* variables and without any global configuration.
const gitEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv(), encoding: 'utf8' });

// Writes `files` ({ path: text | Buffer | { text, mode } }) into a new repository, commits them and returns its path.
function makeRepo(files, { origin = `git${AT}github.com:acme/tools.git` } = {}) {
  const dir = tmp('repo');
  git(dir, 'init', '-q');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  writeFiles(dir, files);
  commitAll(dir, 'init');
  return dir;
}
function writeFiles(dir, files) {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    const content = typeof spec === 'object' && !Buffer.isBuffer(spec) ? spec.text : spec;
    writeFileSync(full, content);
    if (typeof spec === 'object' && !Buffer.isBuffer(spec) && spec.mode) chmodSync(full, spec.mode);
  }
}
function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
}

const MANIFEST = { include: ['src/', 'package.json', 'README.md'], exclude: ['src/skip.txt'], keepInTarget: ['.github/'], allowSecrets: [] };
const manifestOf = (over = {}) => ({ ...structuredClone(MANIFEST), ...over });
// A manifest for repositories that hold only src/ files: every include and exclude entry must match a file at HEAD.
const srcManifest = (over = {}) => manifestOf({ include: ['src/'], exclude: [], ...over });
const writeManifest = (dir, manifest) => writeFileSync(join(dir, 'public-export.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));

// A value shaped like a secret, built here so this file holds no such literal.
const fakeKey = () => ['sk', '-', 'a'.repeat(24)].join('');

// ---- readManifest ----

// A repository whose HEAD holds `public-export.json` (a manifest object or raw text) beside a placeholder file.
const manifestRepo = (manifest) => makeRepo({ 'a.txt': 'x', 'public-export.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest) });

test('readManifest returns the four lists of a valid manifest from HEAD', () => {
  const manifest = manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains: 'fake value' }] });
  assert.deepEqual(ex.readManifest(manifestRepo(manifest)), manifest);
});

test('readManifest refuses a missing, unparsable or mis-shaped manifest with code 2', () => {
  const refusesRepo = (repo, what) => assert.throws(() => ex.readManifest(repo), (err) => err instanceof ex.ExportError && err.code === 2, what);
  const refuses = (content, what) => refusesRepo(manifestRepo(content), what);
  refusesRepo(makeRepo({ 'a.txt': 'x' }), 'missing in HEAD');
  refusesRepo(tmp('not-a-repo'), 'not a git repository');
  refuses('{ not json', 'not JSON');
  refuses('[]', 'not an object');
  for (const key of ['include', 'exclude', 'keepInTarget', 'allowSecrets']) {
    const manifest = manifestOf();
    delete manifest[key];
    refuses(manifest, `${key} missing`);
  }
  refuses(manifestOf({ include: 'src/' }), 'include not an array');
  refuses(manifestOf({ include: [''] }), 'empty include entry');
  refuses(manifestOf({ exclude: [3] }), 'non-string exclude entry');
  refuses(manifestOf({ include: ['/etc/passwd'] }), 'absolute path');
  refuses(manifestOf({ include: ['../outside/'] }), 'path with ..');
  refuses(manifestOf({ allowSecrets: [{ path: 'a' }] }), 'allowSecrets entry without contains');
  refuses(manifestOf({ allowSecrets: [{ path: 'a', contains: '' }] }), 'allowSecrets entry with empty contains');
  refuses(manifestOf({ allowSecrets: ['a'] }), 'allowSecrets entry not an object');
});

test('readManifest refuses an allowSecrets contains that itself matches a secret pattern', () => {
  const repo = manifestRepo(manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains: `key is ${fakeKey()}` }] }));
  assert.throws(() => ex.readManifest(repo), (err) => err instanceof ex.ExportError && err.code === 2 && /secret/i.test(err.message));
  // The message never repeats the offending text.
  assert.throws(() => ex.readManifest(repo), (err) => !err.message.includes(fakeKey()));
});

// Spellings that can never equal a git tree path (git writes `docs/x/a.txt`, with single separators and no dot segments).
const BAD_SPELLINGS = ['./docs/', 'docs//x/', 'docs\\x/', 'docs/x/ ', 'docs/./x/', ' docs/'];

test('readManifest refuses path spellings that can never match', () => {
  const refuses = (manifest, what) => assert.throws(() => ex.readManifest(manifestRepo(manifest)), (err) => err instanceof ex.ExportError && err.code === 2, what);
  for (const spelling of BAD_SPELLINGS) {
    refuses(manifestOf({ exclude: [spelling] }), `exclude ${JSON.stringify(spelling)}`);
    refuses(manifestOf({ include: [spelling] }), `include ${JSON.stringify(spelling)}`);
    refuses(manifestOf({ keepInTarget: [spelling] }), `keepInTarget ${JSON.stringify(spelling)}`);
    refuses(manifestOf({ allowSecrets: [{ path: spelling, contains: 'fake value' }] }), `allowSecrets path ${JSON.stringify(spelling)}`);
  }
  refuses(manifestOf({ exclude: ['docs/..'] }), 'final .. segment');
  refuses(manifestOf({ exclude: ['docs/.'] }), 'final . segment');
  refuses(manifestOf({ exclude: ['/'] }), 'a bare slash');
  // Spellings that can match are still accepted: a nested file, a nested directory, a dotted name.
  const ok = manifestOf({ include: ['docs/x/', 'docs/x/a.txt', '.github/'], exclude: ['docs/.hidden', 'a.b/'] });
  assert.deepEqual(ex.readManifest(manifestRepo(ok)), ok);
});

test('readManifest refuses an allowSecrets contains shorter than 6 characters', () => {
  const entry = (contains) => manifestRepo(manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains }] }));
  const tooShort = (err) => err instanceof ex.ExportError && err.code === 2 && err.message === 'public-export.json: allowSecrets[0].contains must be at least 6 characters';
  assert.throws(() => ex.readManifest(entry('sk-')), tooShort);
  assert.throws(() => ex.readManifest(entry('abcde')), tooShort);
  // The index in the message is the entry's own.
  const second = manifestRepo(manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains: 'long enough' }, { path: 'src/b.txt', contains: 'abc' }] }));
  assert.throws(() => ex.readManifest(second), (err) => err.code === 2 && err.message.includes('allowSecrets[1].contains must be at least 6 characters'));
  // Six characters that match no pattern are accepted.
  assert.deepEqual(ex.readManifest(entry('abcdef')).allowSecrets, [{ path: 'src/a.txt', contains: 'abcdef' }]);
});

test('readManifest counts the trimmed length of an allowSecrets contains', () => {
  const entry = (contains) => manifestRepo(manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains }] }));
  const tooShort = (err) => err instanceof ex.ExportError && err.code === 2 && err.message === 'public-export.json: allowSecrets[0].contains must be at least 6 characters';
  assert.throws(() => ex.readManifest(entry('   abc   ')), tooShort);
  assert.throws(() => ex.readManifest(entry('\t\u00A0abcde ')), tooShort);
  assert.throws(() => ex.readManifest(entry('        ')), tooShort);
  // Six characters after trimming are enough, and the entry is kept as written.
  assert.deepEqual(ex.readManifest(entry('  abcdef ')).allowSecrets, [{ path: 'src/a.txt', contains: '  abcdef ' }]);
});

test('readManifest names the failing index of a path list, and keeps the array message for a non-array', () => {
  const message = (key, index) => `public-export.json: "${key}"[${index}] must be a repository-relative path`;
  for (const key of ['include', 'exclude', 'keepInTarget']) {
    const list = ['src/', 'docs/./x/', 'also/ok.txt'];
    assert.throws(() => ex.readManifest(manifestRepo(manifestOf({ [key]: list }))), (err) => err instanceof ex.ExportError && err.code === 2 && err.message === message(key, 1), key);
    assert.throws(() => ex.readManifest(manifestRepo(manifestOf({ [key]: ['', 'src/'] }))), (err) => err.code === 2 && err.message === message(key, 0), `${key} empty`);
    assert.throws(() => ex.readManifest(manifestRepo(manifestOf({ [key]: ['src/', 'src/b.txt', 7] }))), (err) => err.code === 2 && err.message === message(key, 2), `${key} number`);
  }
  assert.throws(() => ex.readManifest(manifestRepo(manifestOf({ include: 'src/' }))), (err) => err.code === 2 && err.message === 'public-export.json: "include" must be an array of repository-relative paths');
  // The message never repeats the bad entry.
  assert.throws(() => ex.readManifest(manifestRepo(manifestOf({ exclude: ['src/', 'bad\\entry/'] }))), (err) => err.code === 2 && !err.message.includes('bad'));
});

test('readManifest keeps the pattern-match refusal and asks for a substring of at least 6 characters', () => {
  const repo = manifestRepo(manifestOf({ allowSecrets: [{ path: 'src/a.txt', contains: `key is ${fakeKey()}` }] }));
  assert.throws(() => ex.readManifest(repo), (err) => err.code === 2 && err.message.endsWith('use a distinctive substring of at least 6 characters'));
});

test('readManifest reads HEAD, never the working tree: an uncommitted manifest edit changes nothing', () => {
  const headManifest = srcManifest({ allowSecrets: [] });
  const repo = makeRepo({ 'src/a.txt': `value one ${fakeKey()}\n`, 'docs/d.md': 'not included at HEAD\n', 'public-export.json': JSON.stringify(headManifest) });
  // The working tree now allows the secret and includes docs/, uncommitted.
  writeManifest(repo, manifestOf({ include: ['src/', 'docs/'], allowSecrets: [{ path: 'src/a.txt', contains: 'value one' }] }));
  const manifest = ex.readManifest(repo);
  assert.deepEqual(manifest, headManifest);
  const files = ex.listExportFiles(repo, manifest);
  assert.deepEqual(files.map((f) => f.path), ['src/a.txt']);
  const { stagingDir } = build(repo, files);
  const hits = ex.checkContent(stagingDir, files, { ...base, allowSecrets: manifest.allowSecrets });
  assert.deepEqual(categories(hits), ['src/a.txt:1 secret']);
});

test('readManifest of a manifest present only in the working tree is code 2', () => {
  const repo = makeRepo({ 'a.txt': 'x' });
  writeManifest(repo, manifestOf());
  assert.throws(() => ex.readManifest(repo), (err) => err instanceof ex.ExportError && err.code === 2);
});

test('readManifest reads an optional allowLegacy, validated like allowSecrets, and leaves it out when the key is absent', () => {
  const allowLegacy = [{ path: 'src/a.txt', contains: 'the old name' }];
  assert.deepEqual(ex.readManifest(manifestRepo(manifestOf({ allowLegacy }))), manifestOf({ allowLegacy }));
  assert.deepEqual(ex.readManifest(manifestRepo(manifestOf({ allowLegacy: [] }))).allowLegacy, []);
  assert.equal(Object.hasOwn(ex.readManifest(manifestRepo(manifestOf())), 'allowLegacy'), false, 'an absent key stays absent');
  const refuses = (manifest, message, what) => assert.throws(() => ex.readManifest(manifestRepo(manifest)), (err) => err instanceof ex.ExportError && err.code === 2 && message.test(err.message), what);
  refuses(manifestOf({ allowLegacy: 'src/a.txt' }), /^public-export\.json: "allowLegacy" must be an array$/, 'not an array');
  refuses(manifestOf({ allowLegacy: null }), /^public-export\.json: "allowLegacy" must be an array$/, 'null');
  refuses(manifestOf({ allowLegacy: [{ path: 'src/a.txt' }] }), /allowLegacy\[0\] needs a repository path and a non-empty "contains"/, 'no contains');
  refuses(manifestOf({ allowLegacy: [{ path: './src/a.txt', contains: 'the old name' }] }), /allowLegacy\[0\] needs a repository path/, 'bad path');
  refuses(manifestOf({ allowLegacy: ['src/a.txt'] }), /allowLegacy\[0\] needs a repository path/, 'not an object');
  refuses(manifestOf({ allowLegacy: [{ path: 'src/a.txt', contains: `key is ${fakeKey()}` }] }), /allowLegacy\[0\]\.contains matches a secret pattern/, 'secret pattern');
});

test('allowLegacy contains shorter than MIN_ALLOW_CONTAINS is exit 2', () => {
  const entry = (contains) => manifestRepo(manifestOf({ allowLegacy: [{ path: 'src/a.txt', contains }] }));
  const tooShort = (err) => err instanceof ex.ExportError && err.code === 2 && err.message === 'public-export.json: allowLegacy[0].contains must be at least 6 characters';
  assert.throws(() => ex.readManifest(entry('abcde')), tooShort);
  assert.throws(() => ex.readManifest(entry('  abc   ')), tooShort);
  assert.deepEqual(ex.readManifest(entry('abcdef')).allowLegacy, [{ path: 'src/a.txt', contains: 'abcdef' }]);
});

// ---- privateSlug ----

test('privateSlug reads owner/name from every origin URL form', () => {
  for (const url of [
    `git${AT}github.com:acme/tools.git`,
    'https://github.com/acme/tools.git',
    'https://github.com/acme/tools',
    'https://github.com/acme/tools/',
    `ssh://git${AT}github.com/acme/tools.git`,
    `https://token${AT}github.com/acme/tools.git`,
  ]) {
    assert.equal(ex.privateSlug(makeRepo({ 'a.txt': 'x' }, { origin: url })), 'acme/tools', url);
  }
});

test('privateSlug without an origin, or one that names no owner/name, is code 2', () => {
  const none = makeRepo({ 'a.txt': 'x' }, { origin: null });
  assert.throws(() => ex.privateSlug(none), (err) => err instanceof ex.ExportError && err.code === 2);
  const odd = makeRepo({ 'a.txt': 'x' }, { origin: 'tools' });
  assert.throws(() => ex.privateSlug(odd), (err) => err instanceof ex.ExportError && err.code === 2);
});

// ---- listExportFiles ----

test('listExportFiles selects from HEAD by the manifest: prefixes, exact paths and excludes', () => {
  const repo = makeRepo({
    'src/a.txt': 'a',
    'src/deep/b.txt': 'b',
    'src/skip.txt': 'skipped',
    'srcother/c.txt': 'not a prefix match',
    'package.json': '{}',
    'package.json.bak': 'not an exact match',
    'README.md': 'readme',
    'docs/d.md': 'not included',
  });
  const files = ex.listExportFiles(repo, manifestOf());
  assert.deepEqual(files.map((f) => f.path), ['README.md', 'package.json', 'src/a.txt', 'src/deep/b.txt']);
  assert.ok(files.every((f) => f.mode === '100644'));
});

test('listExportFiles ignores working-tree edits and untracked files, and keeps 100755', () => {
  const repo = makeRepo({ 'src/a.txt': 'a', 'src/run.sh': { text: '#!/bin/sh\n', mode: 0o755 }, 'src/gone.txt': 'g' });
  writeFiles(repo, { 'src/a.txt': 'edited', 'src/untracked.txt': 'u' });
  rmSync(join(repo, 'src/gone.txt'));
  const files = ex.listExportFiles(repo, srcManifest());
  assert.deepEqual(files, [
    { path: 'src/a.txt', mode: '100644' },
    { path: 'src/gone.txt', mode: '100644' },
    { path: 'src/run.sh', mode: '100755' },
  ]);
});

test('listExportFiles refuses an included symlink with code 1', () => {
  const repo = makeRepo({ 'src/a.txt': 'a' });
  execFileSync('ln', ['-s', 'a.txt', join(repo, 'src/link.txt')]);
  commitAll(repo, 'link');
  assert.throws(() => ex.listExportFiles(repo, srcManifest()), (err) => err instanceof ex.ExportError && err.code === 1);
});

const directoryMessage = (key, index) => `public-export.json: "${key}"[${index}] names a directory; end it with "/"`;
const refusesDirectory = (key, index) => (err) => err instanceof ex.ExportError && err.code === 2 && err.message === directoryMessage(key, index);

const unmatchedMessage = (key, index) => `public-export.json: "${key}"[${index}] matches no file at HEAD`;
const refusesUnmatched = (key, index) => (err) => err instanceof ex.ExportError && err.code === 2 && err.message === unmatchedMessage(key, index);

test('listExportFiles refuses an include or exclude entry that matches no file at HEAD, naming only key and index', () => {
  const nfc = 'caf\u00e9';
  const repo = makeRepo({ 'src/a.txt': 'a', 'docs/a.txt': 'd', [`${nfc}/x.txt`]: 'x' });
  const unmatched = {
    'a missing path': 'docs/missing',
    'a wrong case': 'Docs/',
    'a glob': 'docs/*',
    'a recursive glob': '**/a.txt',
    'a file with a trailing slash': 'docs/a.txt/',
    'an NFD spelling of an NFC path': 'cafe\u0301/',
    'a zero-width character': 'docs\u200B/',
    'a no-break space': 'docs\u00A0/',
    'a stale file name': 'src/old.txt',
  };
  for (const [what, entry] of Object.entries(unmatched)) {
    assert.equal(ex.listExportFiles(repo, manifestOf({ include: ['src/a.txt'], exclude: [] })).length, 1, 'the control manifest is valid');
    assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/a.txt', entry], exclude: [] })), refusesUnmatched('include', 1), `include: ${what}`);
    assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/'], exclude: ['src/a.txt', entry] })), refusesUnmatched('exclude', 1), `exclude: ${what}`);
    assert.throws(
      () => ex.listExportFiles(repo, manifestOf({ include: [entry], exclude: [] })),
      (err) => refusesUnmatched('include', 0)(err) && !err.message.includes(entry),
      `the message never carries the entry: ${what}`,
    );
  }
  // An entry that does match is fine, whether it is a file, a directory or an NFC spelling.
  const matched = ex.listExportFiles(repo, manifestOf({ include: ['docs/', `${nfc}/`], exclude: ['docs/a.txt'] }));
  assert.deepEqual(matched.map((f) => f.path), [`${nfc}/x.txt`]);
});

test('listExportFiles does not apply the matches-nothing rule to keepInTarget, which names paths of the target', () => {
  const repo = makeRepo({ 'src/a.txt': 'a' });
  const files = ex.listExportFiles(repo, manifestOf({ include: ['src/'], exclude: [], keepInTarget: ['.github/', 'only-in-the-target.txt'] }));
  assert.deepEqual(files.map((f) => f.path), ['src/a.txt']);
});

test('listExportFiles refuses an entry naming a directory without "/"', () => {
  const repo = makeRepo({ 'src/a.txt': 'a', 'docs/private/a.txt': 'p', 'docs/b.txt': 'b' });
  assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/', 'docs/b.txt'], exclude: ['docs/private'] })), refusesDirectory('exclude', 0));
  assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/', 'docs/b.txt'], exclude: ['docs/b.txt', 'docs/private'] })), refusesDirectory('exclude', 1));
  assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['docs'] })), refusesDirectory('include', 0));
  // An exact file and a directory with "/" are not this error.
  const files = ex.listExportFiles(repo, manifestOf({ include: ['src/', 'docs/b.txt'], exclude: ['docs/private/'] }));
  assert.deepEqual(files.map((f) => f.path), ['docs/b.txt', 'src/a.txt']);
  // A name that is only a string prefix of a directory ("do" for "docs/") is not a directory name; it matches nothing instead.
  assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/'], exclude: ['do'] })), refusesUnmatched('exclude', 0));
});

test('listExportFiles refuses a keepInTarget directory written without "/"', () => {
  const repo = makeRepo({ 'src/a.txt': 'a', '.github/x.yml': 'ci' });
  assert.throws(() => ex.listExportFiles(repo, manifestOf({ include: ['src/'], exclude: [], keepInTarget: ['.github'] })), refusesDirectory('keepInTarget', 0));
  assert.deepEqual(ex.listExportFiles(repo, manifestOf({ include: ['src/'], exclude: [], keepInTarget: ['.github/'] })).map((f) => f.path), ['src/a.txt']);
});

// ---- buildStaging ----

const PUBLIC = 'octo/widgets';
const build = (repo, files, over = {}) => {
  const stagingDir = tmp('staging');
  const result = ex.buildStaging(repo, files, { privateSlug: 'acme/tools', publicSlug: PUBLIC, stagingDir, ...over });
  return { stagingDir, ...result };
};

test('buildStaging writes HEAD content, ignoring working-tree edits, with modes from the tree', () => {
  const repo = makeRepo({ 'src/a.txt': 'committed\n', 'src/bin/run.sh': { text: '#!/bin/sh\necho hi\n', mode: 0o755 } });
  writeFiles(repo, { 'src/a.txt': 'edited in the working tree\n' });
  const files = ex.listExportFiles(repo, srcManifest());
  const { stagingDir, rewrites } = build(repo, files);
  assert.equal(readFileSync(join(stagingDir, 'src/a.txt'), 'utf8'), 'committed\n');
  assert.equal(statSync(join(stagingDir, 'src/a.txt')).mode & 0o777, 0o644);
  assert.equal(statSync(join(stagingDir, 'src/bin/run.sh')).mode & 0o777, 0o755);
  assert.equal(rewrites, 0);
  assert.ok(!existsSync(join(stagingDir, '.git')));
});

test('buildStaging rewrites the private slug in every URL form and case, and counts the rewrites', () => {
  const repo = makeRepo({
    'src/a.txt': [
      'https://github.com/acme/tools.git',
      `git${AT}github.com:acme/tools.git`,
      'https://GitHub.com/Acme/Tools/issues',
      'plain acme/tools and ACME/TOOLS',
      'a "$&" tail: acme/tools$1',
      'untouched: acme/other, tools, acme',
    ].join('\n') + '\n',
    'src/b.txt': 'one more acme/tools\n',
  });
  const { stagingDir, rewrites } = build(repo, ex.listExportFiles(repo, srcManifest()));
  assert.equal(readFileSync(join(stagingDir, 'src/a.txt'), 'utf8'), [
    `https://github.com/${PUBLIC}.git`,
    `git${AT}github.com:${PUBLIC}.git`,
    `https://GitHub.com/${PUBLIC}/issues`,
    `plain ${PUBLIC} and ${PUBLIC}`,
    `a "$&" tail: ${PUBLIC}$1`,
    'untouched: acme/other, tools, acme',
  ].join('\n') + '\n');
  assert.equal(readFileSync(join(stagingDir, 'src/b.txt'), 'utf8'), `one more ${PUBLIC}\n`);
  assert.equal(rewrites, 7);
});

// Selected files that look binary (a NUL byte anywhere, which includes UTF-16 text) are refused, path only.
const BINARY_SAMPLES = {
  'src/img.bin': Buffer.concat([Buffer.from([0x00, 0xff, 0x10]), Buffer.from('acme/tools'), Buffer.from([0x00])]),
  'src/utf16.txt': Buffer.from('plain words\n', 'utf16le'),
  'src/edge.txt': Buffer.concat([Buffer.alloc(7999, 'a'), Buffer.from([0x00]), Buffer.from('tail')]), // the NUL is byte 7999
};
const refusedWith1 = (err) => err instanceof ex.ExportError && err.code === 1;

test('buildStaging refuses a binary file with code 1 naming only its path, and does not stage it', () => {
  for (const [path, data] of Object.entries(BINARY_SAMPLES)) {
    const repo = makeRepo({ [path]: data });
    const stagingDir = tmp('staging');
    assert.throws(
      () => ex.buildStaging(repo, ex.listExportFiles(repo, srcManifest()), { privateSlug: 'acme/tools', publicSlug: PUBLIC, stagingDir }),
      (err) => refusedWith1(err) && err.message.includes(path) && !err.message.includes('acme/tools'),
      path,
    );
    assert.ok(!existsSync(join(stagingDir, path)), `${path} was staged`);
  }
});

test('buildStaging refuses a file with a NUL after byte 8000 with the Binary message, path only', () => {
  const lateNul = Buffer.concat([Buffer.alloc(8200, 'a'), Buffer.from([0x00]), Buffer.from(' acme/tools\n')]);
  const repo = makeRepo({ 'src/late.txt': lateNul });
  const stagingDir = tmp('staging');
  assert.throws(
    () => ex.buildStaging(repo, ex.listExportFiles(repo, srcManifest()), { privateSlug: 'acme/tools', publicSlug: PUBLIC, stagingDir }),
    (err) => refusedWith1(err) && err.message === 'src/late.txt: binary file (a NUL byte) cannot be checked, so it is not exported',
  );
  assert.ok(!existsSync(join(stagingDir, 'src/late.txt')));
});

test('buildStaging leaves a clean slug-free tree as a byte-for-byte copy', () => {
  const text = 'café ✓ no slug here\r\nsecond line\n';
  const repo = makeRepo({ 'src/u.txt': text });
  const { stagingDir, rewrites } = build(repo, ex.listExportFiles(repo, srcManifest()));
  assert.equal(readFileSync(join(stagingDir, 'src/u.txt'), 'utf8'), text);
  assert.equal(rewrites, 0);
});

// ---- loadLocalTerms ----

const CONFIG_REL = join('.config', 'triqual', 'memory-report.json');
const DENY_REL = join('.config', 'triqual', 'public-export-deny.txt');
const putHomeFile = (home, rel, text) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};

test('loadLocalTerms collects clientTerms, neverSend and the deny file lines, trimmed and de-duplicated', () => {
  const home = tmp('home');
  putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, clientTerms: ['Globex Corp', 'initech'], neverSend: ['umbrella-app'] }));
  putHomeFile(home, DENY_REL, ['# a comment', '', '   ', '  hooli  ', '\t', '​', '#another', 'GLOBEX corp', 'pied piper'].join('\n'));
  const { terms, empty } = ex.loadLocalTerms({ env: {}, home });
  assert.equal(empty, false);
  assert.deepEqual([...terms].sort(), ['Globex Corp', 'hooli', 'initech', 'pied piper', 'umbrella-app']);
});

test('loadLocalTerms is empty when nothing is configured, and writes nothing', () => {
  const home = tmp('home-empty');
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: [], empty: true });
  assert.ok(!existsSync(join(home, '.config')), 'read-only: no directory created');
  putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, allowlist: ['some-project'] }));
  putHomeFile(home, DENY_REL, '# only comments\n\n   \n');
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: [], empty: true });
});

test('loadLocalTerms reads the deny file named by PUBLIC_EXPORT_DENY and the config named by MEMORY_REPORT_CONFIG', () => {
  const home = tmp('home-env');
  const other = tmp('other');
  putHomeFile(home, DENY_REL, 'from-default-location');
  writeFileSync(join(other, 'deny.txt'), 'from-override\n');
  writeFileSync(join(other, 'cfg.json'), JSON.stringify({ clientTerms: ['cfg-term'] }));
  const env = { PUBLIC_EXPORT_DENY: join(other, 'deny.txt'), MEMORY_REPORT_CONFIG: join(other, 'cfg.json') };
  assert.deepEqual([...ex.loadLocalTerms({ env, home }).terms].sort(), ['cfg-term', 'from-override']);
  // An empty value counts as unset.
  assert.deepEqual(ex.loadLocalTerms({ env: { PUBLIC_EXPORT_DENY: '' }, home }).terms, ['from-default-location']);
});

test('loadLocalTerms fails closed (code 2) on an unreadable source instead of treating it as empty', () => {
  const refuses = (home, env = {}) => assert.throws(() => ex.loadLocalTerms({ env, home }), (err) => err instanceof ex.ExportError && err.code === 2);
  const unparsable = tmp('home-bad-json');
  putHomeFile(unparsable, CONFIG_REL, '{ nope');
  refuses(unparsable);
  const badTerms = tmp('home-bad-terms');
  putHomeFile(badTerms, CONFIG_REL, JSON.stringify({ clientTerms: 'not-a-list' }));
  refuses(badTerms);
  const denyIsDir = tmp('home-deny-dir');
  mkdirSync(join(denyIsDir, DENY_REL), { recursive: true });
  refuses(denyIsDir);
});

test('loadLocalTerms refuses (code 2) while a real legacy config dir sits beside the new one, naming both', () => {
  const home = tmp('home-both-dirs');
  const current = join(home, '.config', BRAND.dir);
  const legacy = join(home, '.config', BRAND.legacy.dir);
  putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, clientTerms: ['new-term'] }));
  putHomeFile(home, join('.config', BRAND.legacy.dir, 'public-export-deny.txt'), 'legacy-only-term\n');
  assert.throws(() => ex.loadLocalTerms({ env: {}, home }), (err) => err instanceof ex.ExportError && err.code === 2
    && err.message.includes(current) && err.message.includes(legacy));
  // Both sources named elsewhere: the config dirs are not read, so nothing is ambiguous.
  const other = tmp('other-both-dirs');
  writeFileSync(join(other, 'deny.txt'), 'named-deny\n');
  writeFileSync(join(other, 'cfg.json'), JSON.stringify({ clientTerms: [] }));
  const env = { PUBLIC_EXPORT_DENY: join(other, 'deny.txt'), MEMORY_REPORT_CONFIG: join(other, 'cfg.json') };
  assert.deepEqual(ex.loadLocalTerms({ env, home }).terms, ['named-deny']);
  // The compatibility link migrate leaves is not a second dir.
  rmSync(legacy, { recursive: true });
  symlinkSync(BRAND.dir, legacy);
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }).terms, ['new-term']);
});

const DENY_MESSAGE = 'the public export deny file is not valid UTF-8 text';
const denyHome = (bytes) => {
  const home = tmp('home-deny');
  putHomeFile(home, DENY_REL, bytes);
  return home;
};
const refusesDeny = (bytes) => {
  const home = denyHome(bytes);
  assert.throws(
    () => ex.loadLocalTerms({ env: {}, home }),
    (err) => err instanceof ex.ExportError && err.code === 2 && err.message === DENY_MESSAGE,
  );
};

const NEVER_MATCH_MESSAGE = 'a local term holds a character that can never match (U+FFFD, DEL or a C1 control)';
const refusesNeverMatch = (err) => err instanceof ex.ExportError && err.code === 2 && err.message === NEVER_MATCH_MESSAGE;

test('loadLocalTerms refuses a term that can never match: U+FFFD, DEL or a C1 control, from the config or the deny file', () => {
  const marks = { 'U+FFFD': '\uFFFD', DEL: '\u007F', 'U+0080': '\u0080', 'U+009F': '\u009F' };
  for (const [what, mark] of Object.entries(marks)) {
    const term = `zor${mark}blax`;
    for (const key of ['clientTerms', 'neverSend']) {
      const home = tmp('home-never');
      putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, [key]: ['fine-term', term] }));
      assert.throws(() => ex.loadLocalTerms({ env: {}, home }), refusesNeverMatch, `${key} ${what}`);
    }
    const deny = denyHome(`alpha\n# a comment\n${term}\n`);
    assert.throws(() => ex.loadLocalTerms({ env: {}, home: deny }), refusesNeverMatch, `deny file ${what}`);
    assert.throws(() => ex.loadLocalTerms({ env: {}, home: deny }), (err) => !err.message.includes('zor') && !err.message.includes(mark), `no term text for ${what}`);
  }
  // A comment line is not a term, and ordinary non-ASCII letters stay fine.
  const ok = denyHome(`# note \u007F \uFFFD\nz\u00f6rblax\n`);
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home: ok }), { terms: ['z\u00f6rblax'], empty: false });
});

test('loadLocalTerms refuses a deny file named by PUBLIC_EXPORT_DENY that does not exist', () => {
  const home = tmp('home-named-missing');
  const missing = join(tmp('named-dir'), 'no-such-deny.txt');
  assert.throws(
    () => ex.loadLocalTerms({ env: { PUBLIC_EXPORT_DENY: missing }, home }),
    (err) => err instanceof ex.ExportError && err.code === 2 && err.message === 'the public export deny file named by PUBLIC_EXPORT_DENY does not exist',
  );
  // The default location is still fine when it is absent and no variable names a file.
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: [], empty: true });
});

test('loadLocalTerms refuses a default deny file that is a symlink to a missing target, and follows a good link', () => {
  const home = tmp('home-broken-link');
  mkdirSync(dirname(join(home, DENY_REL)), { recursive: true });
  symlinkSync(join(home, 'no-such-target.txt'), join(home, DENY_REL));
  assert.throws(
    () => ex.loadLocalTerms({ env: {}, home }),
    (err) => err instanceof ex.ExportError && err.code === 2 && err.message === 'the public export deny file is a broken link',
  );
  const good = tmp('home-good-link');
  mkdirSync(dirname(join(good, DENY_REL)), { recursive: true });
  writeFileSync(join(good, 'real-deny.txt'), 'zorblax\n');
  symlinkSync(join(good, 'real-deny.txt'), join(good, DENY_REL));
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home: good }), { terms: ['zorblax'], empty: false });
});

test('loadLocalTerms splits CR-only, NEL and U+2028 deny files', () => {
  for (const sep of ['\r', '\u0085', '\u2028', '\u2029', '\r\n', '\n']) {
    const home = denyHome(`alpha${sep}zorblax${sep}`);
    assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: ['alpha', 'zorblax'], empty: false }, JSON.stringify(sep));
  }
});

test('loadLocalTerms refuses a Latin-1 deny file', () => {
  refusesDeny(Buffer.concat([Buffer.from('Z'), Buffer.from([0xf6]), Buffer.from('rblax\n')]));
});

test('loadLocalTerms refuses a BOM-less UTF-16LE deny file and one holding a control character', () => {
  refusesDeny(Buffer.from('zorblax\n', 'utf16le'));
  refusesDeny(Buffer.from('zorblax\n', 'utf16le').subarray(0, 14));
  refusesDeny(Buffer.from(`zor${String.fromCharCode(1)}blax\n`));
  refusesDeny(Buffer.from(`zorblax\n${String.fromCharCode(0)}`));
});

test('loadLocalTerms counts a deny file of only a combining mark as empty', () => {
  const home = denyHome('\u0301\n');
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: [], empty: true });
});

test('loadLocalTerms drops a config term that folds to nothing', () => {
  const home = tmp('home-cfg-fold');
  putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, clientTerms: ['\u0301', 'acme-term'], neverSend: ['\u200B'] }));
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }), { terms: ['acme-term'], empty: false });
});

test('loadLocalTerms keeps a UTF-8 BOM deny file working', () => {
  const home = denyHome(`\uFEFFzorblax\n`);
  assert.deepEqual(ex.loadLocalTerms({ env: {}, home }).terms, ['zorblax']);
});

// Repository and owner never-send entries (repo-identity, Ruling B): `<owner>/<name>` and `<name>` for a repository, the
// owner path for an owner entry, beside the entry itself; names stay as they are.
const neverSendHome = (neverSend) => {
  const home = tmp('home-never');
  putHomeFile(home, CONFIG_REL, JSON.stringify({ version: 1, neverSend }));
  return home;
};

test('loadLocalTerms derives the owner from an owner entry and owner/name and name from a repository entry', () => {
  const { terms } = ex.loadLocalTerms({ env: {}, home: neverSendHome(['github.com/globex/*', 'github.com/acme/widgets']) });
  for (const term of ['globex', 'acme/widgets', 'widgets']) assert.ok(terms.includes(term), `${term} is a term`);
});

test('loadLocalTerms takes the stored form: owner entries at any depth, Azure and visualstudio.com entries, names kept', () => {
  const { terms } = ex.loadLocalTerms({
    env: {},
    home: neverSendHome(['gitlab.com/group/sub/*', 'acme.visualstudio.com/*', 'dev.azure.com/initech/proj/_git/Repo.git', 'umbrella-app']),
  });
  for (const term of ['group/sub', 'acme', 'initech/proj/repo', 'repo', 'umbrella-app']) assert.ok(terms.includes(term), `${term} is a term`);
});

// ---- checkContent ----

// Lays `files` ({ path: text | Buffer }) out as a staging directory and returns it with its file list.
function stageFiles(files) {
  const dir = tmp('stage');
  writeFiles(dir, files);
  return { dir, list: Object.keys(files).map((path) => ({ path, mode: '100644' })) };
}
const addr = (local, domain) => `${local}@${domain}`;
const TERM_A = 'globex';
const base = { terms: [], home: '/home/tester', privateSlug: 'acme/tools', publicSlug: 'acme/tools-public', allowSecrets: [] };
const check = (files, over = {}) => {
  const { dir, list } = stageFiles(files);
  return ex.checkContent(dir, list, { ...base, ...over });
};
const categories = (hits) => hits.map((h) => `${h.path}:${h.line} ${h.category}`);

test('checkContent reports each local term case-insensitively as <path>:<line> local-term, never the term itself', () => {
  const hits = check({ 'a.txt': 'clean\nsome GlobeX here\nclean again\nINITECH too\n' }, { terms: [TERM_A, 'initech'] });
  assert.deepEqual(hits, [
    { path: 'a.txt', line: 2, category: 'local-term' },
    { path: 'a.txt', line: 4, category: 'local-term' },
  ]);
  assert.ok(!JSON.stringify(hits).toLowerCase().includes(TERM_A));
});

test('checkContent reports a remote of a never-send owner as a local-term hit', () => {
  const { terms } = ex.loadLocalTerms({ env: {}, home: neverSendHome(['github.com/globex/*', 'github.com/acme/widgets']) });
  const remote = ['git', AT, 'github.com:globex/app.git'].join('');
  assert.deepEqual(check({ 'a.txt': `clean\nurl = ${remote}\n` }, { terms }), [{ path: 'a.txt', line: 2, category: 'local-term' }]);
});

test('repo-map.json is not an export path (repo-identity spec 7)', () => {
  // The map lives in the memory-report state directory, outside the repository; even a copy left in a working tree is not
  // exported, since the export reads HEAD only.
  const repo = makeRepo({ 'src/a.txt': 'x' });
  writeFiles(repo, { 'src/state/repo-map.json': '{"v":2,"folders":{}}' });
  assert.deepEqual(ex.listExportFiles(repo, srcManifest()).map((f) => f.path), ['src/a.txt']);
  const manifestText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public-export.json'), 'utf8');
  assert.ok(!manifestText.includes('repo-map'), 'the manifest names no repo-map path');
});

test('checkContent with no terms reports no local-term (an empty term never matches every line)', () => {
  assert.deepEqual(check({ 'a.txt': 'anything\n' }, { terms: [] }), []);
  assert.deepEqual(check({ 'a.txt': 'anything\n' }, { terms: ['', '  '] }), []);
});

test('checkContent reports the home directory path, ignoring a trailing slash and a bare root', () => {
  assert.deepEqual(categories(check({ 'a.txt': 'ok\ncd /home/tester/projects\n' })), ['a.txt:2 home-path']);
  assert.deepEqual(categories(check({ 'a.txt': 'cd /home/tester/x\n' }, { home: '/home/tester/' })), ['a.txt:1 home-path']);
  assert.deepEqual(check({ 'a.txt': 'cd /home/other\n/usr/bin\n' }, { home: '/' }), []);
  assert.deepEqual(check({ 'a.txt': 'cd /home/other\n' }, { home: '' }), []);
});

test('checkContent reports an email address, except the exempt domains', () => {
  const flagged = [addr('someone', 'globex.com'), addr('x', 'notexample.com'), addr('x', 'mail.anthropic.com'), addr('x', 'evilanthropic.com'), addr('x', 'noreply.github.com.evil.io'), addr('x', 'host.invalid.io')];
  assert.deepEqual(categories(check({ 'a.txt': flagged.map((e) => `contact ${e} now`).join('\n') + '\n' })), flagged.map((_, i) => `a.txt:${i + 1} email`));
  const exempt = [
    addr('12345+someone', 'users.noreply.github.com'), addr('x', 'noreply.github.com'), addr('noreply', 'anthropic.com'),
    addr('x', 'example.invalid'), addr('x', 'example.org'), addr('x', 'example.com'), addr('x', 'host.invalid'), addr('x', 'host.test'),
    addr('x', 'host.example'), addr('X', 'EXAMPLE.INVALID'), addr('x', 'sub.host.invalid'),
  ];
  assert.deepEqual(check({ 'a.txt': exempt.map((e) => `contact ${e}.`).join('\n') + '\n' }), []);
});

test('checkContent does not take version specifiers or scoped package names for emails', () => {
  const text = ['npm i react@18.3.1', 'use pkg@1.2.3-beta.1 or @scope/name', 'a@b', 'ping @someone about it'].join('\n') + '\n';
  assert.deepEqual(check({ 'a.txt': text }), []);
});

test('checkContent reports a secret pattern match, and allowSecrets suppresses only its path and the matches it overlaps', () => {
  const key = fakeKey();
  const head = key.slice(0, 5); // `contains` must overlap the match, so each one runs into the key
  const files = { 'a.txt': `value one ${key}\nvalue two ${key}\n`, 'b.txt': `value one ${key}\n` };
  assert.deepEqual(categories(check(files)), ['a.txt:1 secret', 'a.txt:2 secret', 'b.txt:1 secret']);
  const allow = [{ path: 'a.txt', contains: `one ${head}` }];
  assert.deepEqual(categories(check(files, { allowSecrets: allow })), ['a.txt:2 secret', 'b.txt:1 secret']);
  assert.deepEqual(categories(check(files, { allowSecrets: [{ path: 'a.txt', contains: `one ${head}` }, { path: 'a.txt', contains: `two ${head}` }, { path: 'b.txt', contains: `one ${head}` }] })), []);
  assert.deepEqual(categories(check(files, { allowSecrets: [{ path: 'a.txt', contains: 'not on any line' }] })), ['a.txt:1 secret', 'a.txt:2 secret', 'b.txt:1 secret']);
});

test('checkContent: an empty allowSecrets contains covers nothing and does not loop', { timeout: 5000 }, () => {
  const hits = check({ 'a.txt': `key ${fakeKey()}\n` }, { allowSecrets: [{ path: 'a.txt', contains: '' }] });
  assert.deepEqual(categories(hits), ['a.txt:1 secret']);
});

test('checkContent: an allowed secret covers its own match, not the rest of the line', () => {
  const key = fakeKey();
  const other = ['ghp', '_', 'b'.repeat(36)].join('');
  const allow = [{ path: 'a.txt', contains: 'value one' }];
  // The allowed match is `sk-...` and `contains` sits before it on the line, so it must overlap the match: use the key itself.
  const allowKey = [{ path: 'a.txt', contains: key.slice(0, 8) }];
  // The same line without a second secret is covered; with a second, separate secret after it the line is a hit.
  assert.deepEqual(check({ 'a.txt': `use ${key} here\n` }, { allowSecrets: allowKey }), []);
  assert.deepEqual(categories(check({ 'a.txt': `use ${key} and ${other}\n` }, { allowSecrets: allowKey })), ['a.txt:1 secret']);
  assert.deepEqual(categories(check({ 'a.txt': `use ${other} and ${key}\n` }, { allowSecrets: allowKey })), ['a.txt:1 secret']);
  // A contains present on the line but not overlapping the match does not cover it.
  assert.deepEqual(categories(check({ 'a.txt': `value one ${key}\n` }, { allowSecrets: allow })), ['a.txt:1 secret']);
  // Every occurrence of a contains counts, so a repeated secret under one entry is covered.
  assert.deepEqual(check({ 'a.txt': `${key} ${key}\n` }, { allowSecrets: allowKey }), []);
  // Two matches, each covered by a different entry, pass; one entry alone does not.
  const both = [...allowKey, { path: 'a.txt', contains: other.slice(0, 8) }];
  assert.deepEqual(check({ 'a.txt': `use ${key} and ${other}\n` }, { allowSecrets: both }), []);
  assert.deepEqual(categories(check({ 'a.txt': `use ${key} and ${other}\n` }, { allowSecrets: [{ path: 'b.txt', contains: other.slice(0, 8) }, ...allowKey] })), ['a.txt:1 secret']);
});

test('checkContent catches the other secret shapes (private key header, bearer token, URL with credentials)', () => {
  const header = ['-'.repeat(5), 'BEGIN'].join('');
  const bearer = ['Bearer', ' ', 'a'.repeat(30)].join('');
  const url = ['https', '://', 'user', ':', 'pa55word', '@', 'host.invalid', '/x'].join('');
  assert.deepEqual(categories(check({ 'a.txt': `${header} KEY\n${bearer}\nclone ${url}\n` })), ['a.txt:1 secret', 'a.txt:2 secret', 'a.txt:3 secret']);
});

test('checkContent reports the private slug unless it is followed by a slug character, after masking the public slug', () => {
  const hit = ['acme/tools', 'ACME/Tools', 'see acme/tools.', 'acme/tools.git', 'acme/tools/issues', 'x acme/tools'];
  assert.deepEqual(categories(check({ 'a.txt': hit.join('\n') + '\n' })), hit.map((_, i) => `a.txt:${i + 1} private-slug`));
  const clear = ['acme/tools-public', 'ACME/TOOLS-PUBLIC.git', 'acme/tools-other', 'acme/toolsmith', 'acme/tools_x', 'acme/tools9', 'acme/other'];
  assert.deepEqual(check({ 'a.txt': clear.join('\n') + '\n' }), []);
  // The public slug is masked, a bare private slug beside it is still a hit.
  assert.deepEqual(categories(check({ 'a.txt': 'acme/tools-public and acme/tools\nacme/tools-public/acme/tools\n' })), ['a.txt:1 private-slug', 'a.txt:2 private-slug']);
});

test('prefix pair: escaped private slug is caught when the public slug is its prefix', () => {
  const pair = { privateSlug: 'Acme/widgets-private', publicSlug: 'Acme/widgets' };
  const files = {
    'a.txt': 'see Acme\\/widgets-private here\n',
    'b.txt': 'see Acme%2Fwidgets-private here\n',
    'c.txt': 'see Acme\\widgets-private here\n',
  };
  assert.deepEqual(categories(check(files, pair)), ['a.txt:1 private-slug', 'b.txt:1 private-slug', 'c.txt:1 private-slug']);
  // The public slug itself, plain, escaped or followed by a path or `.git`, is still no hit.
  const clear = ['Acme/widgets', 'Acme\\/widgets', 'Acme%2Fwidgets', 'Acme/widgets.git', 'Acme/widgets/issues'];
  assert.deepEqual(check({ 'a.txt': clear.join('\n') + '\n' }, pair), []);
});

// The legacy terms the CLI derives: the old brand name and the bare name of the private repository.
const LEGACY = BRAND.legacy.marketplace;
const legacyOn = { legacyTerms: [LEGACY, 'widgets-private'] };

test('legacy term is an old-name hit unless an allowLegacy entry covers it', () => {
  const files = { 'a.txt': `clean\nthe ${LEGACY} name\nsee WIDGETS-PRIVATE too\n`, 'b.txt': `the ${LEGACY} name\n` };
  const hits = check(files, legacyOn);
  assert.deepEqual(categories(hits), ['a.txt:2 old-name', 'a.txt:3 old-name', 'b.txt:1 old-name']);
  assert.ok(!JSON.stringify(hits).toLowerCase().includes(LEGACY) && !JSON.stringify(hits).toLowerCase().includes('widgets'), 'a hit never carries the matched text');
  // Without legacy terms (the default) nothing is an old-name hit.
  assert.deepEqual(check(files), []);
  // An entry covers the matches it overlaps, in its own path only.
  assert.deepEqual(categories(check(files, { ...legacyOn, allowLegacy: [{ path: 'a.txt', contains: `the ${LEGACY}` }] })), ['a.txt:3 old-name', 'b.txt:1 old-name']);
  const all = [{ path: 'a.txt', contains: `the ${LEGACY}` }, { path: 'a.txt', contains: 'see WIDGETS' }, { path: 'b.txt', contains: LEGACY }];
  assert.deepEqual(check(files, { ...legacyOn, allowLegacy: all }), []);
  // A contains on the line that does not overlap the match covers nothing.
  assert.deepEqual(categories(check({ 'a.txt': `clean prefix ${LEGACY}\n` }, { ...legacyOn, allowLegacy: [{ path: 'a.txt', contains: 'clean prefix' }] })), ['a.txt:1 old-name']);
  // A second, uncovered match on the line is a hit.
  assert.deepEqual(categories(check({ 'a.txt': `the ${LEGACY} and widgets-private\n` }, { ...legacyOn, allowLegacy: [{ path: 'a.txt', contains: `the ${LEGACY}` }] })), ['a.txt:1 old-name']);
  // The path is checked too (line 0), after the other path categories.
  assert.deepEqual(categories(check({ [`docs/${LEGACY}.md`]: 'x\n' }, legacyOn)), [`docs/${LEGACY}.md:0 old-name`]);
});

test('legacy term inside a longer word is not a hit', () => {
  const clear = [`x${LEGACY}`, `${LEGACY}x`, `my-${LEGACY}`, `${LEGACY}-two`, `${LEGACY}_x`, `9${LEGACY}`, `_${LEGACY}`, 'widgets-privates', 'pre-widgets-private', 'Acme/widgets'];
  assert.deepEqual(check({ 'a.txt': clear.join('\n') + '\n' }, legacyOn), []);
  const hit = [`.${LEGACY}`, `~/.config/${LEGACY}/x`, `"${LEGACY}"`, `${LEGACY}.git`, `@${LEGACY}`, `${LEGACY.toUpperCase()}`, 'Acme/widgets-private'];
  assert.deepEqual(categories(check({ 'a.txt': hit.join('\n') + '\n' }, legacyOn)), hit.map((_, i) => `a.txt:${i + 1} old-name`));
});

test('checkContent counts lines from 1 across LF and CRLF, scans every file, and lists several categories of one line', () => {
  const key = fakeKey();
  const files = { 'one.txt': `a\r\nb\r\n${addr('p', 'globex.com')} ${TERM_A} ${key}\r\n`, 'dir/two.txt': 'acme/tools\n' };
  assert.deepEqual(check(files, { terms: [TERM_A] }), [
    { path: 'one.txt', line: 3, category: 'local-term' },
    { path: 'one.txt', line: 3, category: 'email' },
    { path: 'one.txt', line: 3, category: 'secret' },
    { path: 'dir/two.txt', line: 1, category: 'private-slug' },
  ]);
});

test('checkContent refuses a binary file with code 1 naming only its path, also with the NUL after byte 8000', () => {
  for (const [path, data] of Object.entries(BINARY_SAMPLES)) {
    assert.throws(() => check({ [path]: data }, { terms: [TERM_A] }), (err) => refusedWith1(err) && err.message.includes(path) && !err.message.includes('acme/tools'), path);
  }
  const text = Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.from([0x00]), Buffer.from(`\n${TERM_A}\n`)]);
  assert.throws(
    () => check({ 'edge.txt': text }, { terms: [TERM_A] }),
    (err) => refusedWith1(err) && err.message === 'edge.txt: binary file (a NUL byte) cannot be checked, so it is not exported',
  );
});

test('checkContent refuses UTF-16LE text with no NUL in the first 8000 bytes', () => {
  // Cyrillic filler has no zero byte in UTF-16LE, so the first NUL (from the ASCII tail) comes after byte 8000.
  const data = Buffer.from('\u0436'.repeat(4100) + ' ' + TERM_A, 'utf16le');
  assert.equal(data.subarray(0, 8000).includes(0), false);
  assert.throws(() => check({ 'u16.txt': data }, { terms: [TERM_A] }), (err) => refusedWith1(err) && err.message.includes('u16.txt'));
});

const NOT_UTF8 = 'a.txt: not valid UTF-8, so its content cannot be checked';
test('checkContent refuses a Latin-1 file holding a term, without echoing any of it', () => {
  const latin1 = Buffer.concat([Buffer.from('owner: Z'), Buffer.from([0xf6]), Buffer.from('rblax\n')]);
  assert.throws(
    () => check({ 'a.txt': latin1 }, { terms: ['zorblax'] }),
    (err) => refusedWith1(err) && err.message === NOT_UTF8 && !err.message.includes('rblax'),
  );
});

test('checkContent refuses an overlong UTF-8 sequence', () => {
  const overlong = Buffer.concat([Buffer.from([0xc1, 0xba]), Buffer.from('orblax\n')]); // an overlong spelling of "z"
  assert.throws(() => check({ 'a.txt': overlong }, { terms: ['zorblax'] }), (err) => refusedWith1(err) && err.message === NOT_UTF8);
});

test('checkContent still finds the UTF-8 spelling of an accented term', () => {
  assert.deepEqual(categories(check({ 'a.txt': 'owner: Z\u00F6rblax\n' }, { terms: ['zorblax'] })), ['a.txt:1 local-term']);
});

test('checkContent finds escaped private slug forms, and not the escaped public slug', () => {
  const forms = ['acme\\/tools', 'acme\\u002ftools', 'acme\\x2ftools', 'acme%2Ftools', 'acme%252Ftools', 'acme&#47;tools', 'acme&#x2F;tools', 'acme&sol;tools'];
  const text = forms.map((form) => `see ${form} here`).join('\n') + '\nsee acme\\/tools-public here\n';
  assert.deepEqual(categories(check({ 'a.txt': text })), forms.map((_, i) => `a.txt:${i + 1} private-slug`));
});

test('checkContent normalizes the escaped slug to a fixed point and knows the u{2f} and octal forms', () => {
  const forms = ['acme\\\\/tools', 'acme\\\\\\\\/tools', 'acme%25252Ftools', 'acme%2525252525252Ftools', 'acme\\u{2f}tools', 'acme\\u{002F}tools', 'acme\\057tools', 'acme\\\\057tools'];
  const text = forms.map((form) => `see ${form} here`).join('\n') + '\n';
  assert.deepEqual(categories(check({ 'a.txt': text })), forms.map((_, i) => `a.txt:${i + 1} private-slug`));
  // The public slug, escaped once or twice, is masked after the last pass and is no hit.
  const publicForms = ['acme\\/tools-public', 'acme\\\\/tools-public', 'acme%25252Ftools-public', 'acme\\u{2f}tools-public', 'acme\\057tools-public'];
  assert.deepEqual(check({ 'a.txt': publicForms.join('\n') + '\n' }), []);
  // The path is normalized the same way.
  assert.deepEqual(categories(check({ 'acme%25252Ftools.txt': 'x\n' })), ['acme%25252Ftools.txt:0 private-slug']);
});

test('checkContent masks a public slug that the lookahead would not protect, also when it is escaped', () => {
  const dotted = { publicSlug: 'acme/tools.pub' };
  const forms = ['acme/tools.pub', 'acme\\/tools.pub', 'acme\\\\/tools.pub', 'acme%252Ftools.pub', 'acme\\u002ftools.pub', 'ACME/TOOLS.PUB'];
  assert.deepEqual(check({ 'a.txt': forms.join('\n') + '\n' }, dotted), []);
  // The private slug beside it is still a hit.
  assert.deepEqual(categories(check({ 'a.txt': 'acme\\/tools.pub and acme\\/tools\n' }, dotted)), ['a.txt:1 private-slug']);
});

// The private slug is also tested on the form a reader or parser would see: escapes decoded, NFKC, default-ignorables removed.
const fullwidth = (text) => text.replace(/[a-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0));
const SLUG_FOLD_FORMS = (slug) => {
  const [owner, name] = slug.split('/');
  return [
    `${owner.slice(0, 2)}\u200B${owner.slice(2)}/${name}`, // zero-width space inside the owner
    `${owner.slice(0, 2)}\u00AD${owner.slice(2)}/${name}`, // soft hyphen
    `${owner}\uFF0F${name}`, // fullwidth solidus
    fullwidth(`${owner}/${name}`), // fullwidth letters
    `\\u0061${owner.slice(1)}/${name}`, // JSON letter escape
    `\\u{61}${owner.slice(1)}/${name}`, // braced letter escape
    `${owner}/%74${name.slice(1)}`, // percent-encoded letter
    `&#97;${owner.slice(1)}/${name}`, // numeric entity with semicolon
    `${owner}&#x2f${name}`, // hex entity slash without semicolon (the next letter is not a hex digit)
    `${owner}&#47${name}`, // entity slash without semicolon
    `${owner}\\${name}`, // backslash separator
    `${owner}${'\\'.repeat(5)}/${name}`, // five backslashes before the slash
    `${owner}/%252574${name.slice(1)}`, // double percent-encoded letter
  ];
};
test('checkContent finds the private slug through Unicode folding, escaped letters and a backslash separator', () => {
  const forms = SLUG_FOLD_FORMS('acme/tools');
  const text = forms.map((form) => `see ${form} here`).join('\n') + '\n';
  assert.deepEqual(categories(check({ 'a.txt': text })), forms.map((_, i) => `a.txt:${i + 1} private-slug`));
  // The path is folded the same way.
  assert.deepEqual(categories(check({ 'acme\uFF0Ftools.txt': 'x\n' })), ['acme\uFF0Ftools.txt:0 private-slug']);
});

test('checkContent does not flag the same forms of the public slug, and the fold never hides a hit the raw text has', () => {
  const dotted = { publicSlug: 'acme/tools.pub' };
  const forms = SLUG_FOLD_FORMS('acme/tools.pub');
  assert.deepEqual(check({ 'a.txt': forms.map((form) => `see ${form} here`).join('\n') + '\n' }, dotted), []);
  // A hit in the raw text stays when the fold would end the slug with a slug character.
  assert.deepEqual(categories(check({ 'a.txt': 'acme/tools&#45;x\nacme/tools\\u002dx\nacme/tools%2dx\n' })), ['a.txt:1 private-slug', 'a.txt:2 private-slug', 'a.txt:3 private-slug']);
  // A private slug beside the folded public slug is still a hit.
  assert.deepEqual(categories(check({ 'a.txt': `ac\u200Bme/tools.pub and acme/tools\n` }, dotted)), ['a.txt:1 private-slug']);
});

test('checkContent stays linear on a long run of backslashes and still folds 1 to 6 backslashes before the slash', () => {
  const run = '\\'.repeat(200000);
  const started = performance.now();
  assert.deepEqual(check({ 'a.txt': `${run}\n` }), []);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `a run of 200000 backslashes took ${Math.round(elapsed)} ms`);
  for (let count = 1; count <= 6; count += 1) {
    assert.deepEqual(categories(check({ 'a.txt': `acme${'\\'.repeat(count)}/tools\n` })), ['a.txt:1 private-slug'], `${count} backslashes`);
  }
});

test('checkContent applies the same folding as the insights gate: split, fullwidth, escaped and accented terms are hits', () => {
  const variants = [
    'glo\u200Bbex', // zero-width space inside the term
    'g\u00ADlobex', // soft hyphen
    '\uFF47\uFF4C\uFF4F\uFF42\uFF45\uFF58', // fullwidth letters
    '\\u0067lobex', // a literal \u0067 escape for the first letter
    'gl\u00F4bex', // diacritic
    'GLOBEX', // upper case
  ];
  const text = variants.map((v) => `see ${v} here`).join('\n') + '\nsee globe here\n';
  assert.deepEqual(categories(check({ 'a.txt': text }, { terms: [TERM_A] })), variants.map((_, i) => `a.txt:${i + 1} local-term`));
  // A term that folds to nothing never matches.
  assert.deepEqual(check({ 'a.txt': 'anything\n' }, { terms: ['\u200B', ' '] }), []);
});

test('checkContent finds a multi-word term wrapped across lines: per pair at the first line, per file at line 0, no duplicates', () => {
  const term = 'Globex Corp';
  const opts = { terms: [term] };
  // wrapped over two lines: reported at the first line of the pair
  assert.deepEqual(categories(check({ 'a.txt': 'ok\nthe Globex\nCorp team\nok\n' }, opts)), ['a.txt:2 local-term']);
  // CRLF, indentation and a different case still join with one space
  assert.deepEqual(categories(check({ 'a.txt': 'ok\r\nthe GLOBEX\r\n   corp team\r\n' }, opts)), ['a.txt:2 local-term']);
  // wrapped over three short lines: only the whole text holds it, line 0
  const three = { terms: ['alpha beta gamma'] };
  assert.deepEqual(categories(check({ 'a.txt': 'alpha\nbeta\ngamma\n' }, three)), ['a.txt:0 local-term']);
  // a single-line hit stays one hit at its own line, not repeated by the pair or the file
  assert.deepEqual(categories(check({ 'a.txt': 'ok\nGlobex Corp here\nok\n' }, opts)), ['a.txt:2 local-term']);
  // two lines that both hold the term alone, and a pair that also holds it: no duplicate for the pair
  assert.deepEqual(categories(check({ 'a.txt': 'Globex Corp\nGlobex Corp\n' }, opts)), ['a.txt:1 local-term', 'a.txt:2 local-term']);
  // nothing wrapped, nothing found; the term must not be glued together or split by other words either
  assert.deepEqual(check({ 'a.txt': 'Globex\nfoo\nCorp\nGlobexCorp\n' }, opts), []);
  // the hit carries no matched text
  assert.ok(!JSON.stringify(check({ 'a.txt': 'Globex\nCorp\n' }, opts)).toLowerCase().includes('globex'));
});

test('checkContent finds a term wrapped across lines that carry a comment or quote prefix', () => {
  const opts = { terms: ['Zenith Quartz'] };
  const prefixed = {
    'slashes.txt': 'ok\n// Zenith\n// Quartz\nok\n',
    'quote.txt': 'ok\n> Zenith\n> Quartz\nok\n',
    'star.txt': 'ok\n/**\n * Zenith\n * Quartz\n */\n',
    'hash.txt': 'ok\n# Zenith\n# Quartz\nok\n',
    'dashes.txt': 'ok\n-- Zenith\n-- Quartz\nok\n',
    'semi.txt': 'ok\n; Zenith\n; Quartz\nok\n',
    'html.txt': 'ok\n<!-- Zenith\n     Quartz -->\nok\n',
    'nested.txt': 'ok\n> > Zenith\n> > Quartz\nok\n',
    'crlf.txt': 'ok\r\n  // Zenith\r\n  // Quartz\r\n',
  };
  const expected = Object.keys(prefixed).map((path) => `${path}:${path === 'star.txt' ? 3 : 2} local-term`);
  assert.deepEqual(categories(check(prefixed, opts)).sort(), expected.sort());
  // wrapped over three prefixed lines: only the whole file holds it, line 0
  assert.deepEqual(categories(check({ 'a.txt': '// alpha\n// beta\n// gamma\n' }, { terms: ['alpha beta gamma'] })), ['a.txt:0 local-term']);
  // a single line that already hits is one hit, not repeated by a pair or by the file
  assert.deepEqual(categories(check({ 'a.txt': '// Zenith Quartz\n// Zenith Quartz\n' }, opts)), ['a.txt:1 local-term', 'a.txt:2 local-term']);
  // prefixes do not glue or invent a term
  assert.deepEqual(check({ 'a.txt': '// Zenith\n// foo\n// Quartz\n//Zenith\n//Quartz\n' }, opts), []);
  assert.ok(!JSON.stringify(check({ 'a.txt': '# Zenith\n# Quartz\n' }, opts)).toLowerCase().includes('zenith'));
});

test('checkContent also checks each path for a local term, the home path and the private slug, before the line hits', () => {
  const files = {
    'docs/Globex-notes.txt': `ok\n${TERM_A}\n`,
    'docs/gl\u200Bobex.txt': 'ok\n',
    'a/home/tester/x.txt': 'ok\n',
    'a/acme/tools/x.txt': 'ok\n',
    'a/acme/tools-public/x.txt': 'ok\n',
    'a/acme/tools-other/x.txt': 'ok\n',
    'clean/name.txt': 'ok\n',
  };
  assert.deepEqual(check(files, { terms: [TERM_A] }), [
    { path: 'docs/Globex-notes.txt', line: 0, category: 'local-term' },
    { path: 'docs/Globex-notes.txt', line: 2, category: 'local-term' },
    { path: 'docs/gl\u200Bobex.txt', line: 0, category: 'local-term' },
    { path: 'a/home/tester/x.txt', line: 0, category: 'home-path' },
    { path: 'a/acme/tools/x.txt', line: 0, category: 'private-slug' },
  ]);
});

test('checkContent does not take an scp-style git remote for an email, and only that form', () => {
  const scp = `${addr('git', 'globex.com')}:owner/repo`;
  assert.deepEqual(check({ 'a.txt': `git clone ${scp}\n` }), []);
  const flagged = [addr('git', 'globex.com'), `${addr('git', 'globex.com')}.`, `${addr('xgit', 'globex.com')}:owner/repo`, `${addr('someone', 'globex.com')}:owner/repo`, `${addr('git', 'globex.com')} :owner/repo`];
  assert.deepEqual(categories(check({ 'a.txt': flagged.map((e) => `use ${e}\n`).join('') })), flagged.map((_, i) => `a.txt:${i + 1} email`));
});

test('checkContent reports an email whose local part is not ASCII', () => {
  const flagged = [addr('josé', 'globex.com'), addr('иван', 'globex.com'), addr('naïve.user', 'globex.com'), addr('张伟', 'globex.com')];
  assert.deepEqual(categories(check({ 'a.txt': flagged.map((e) => `write ${e}\n`).join('') })), flagged.map((_, i) => `a.txt:${i + 1} email`));
  assert.deepEqual(check({ 'a.txt': `${addr('josé', 'example.invalid')}\n` }), []);
});

test('checkContent reports a bare Stripe-style key (built at runtime), not a short look-alike', () => {
  const live = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9'].join('_');
  const restricted = ['rk', 'test', 'a1B2c3D4e5F6g7H8i9'].join('_');
  const publishable = ['pk', 'live', 'a1B2c3D4e5F6g7H8i9'].join('_');
  const short = ['sk', 'live', 'a1B2c3D4e5F6g7H'].join('_');
  assert.deepEqual(categories(check({ 'a.txt': [live, restricted, publishable, short].map((k) => `key ${k}\n`).join('') })), ['a.txt:1 secret', 'a.txt:2 secret', 'a.txt:3 secret']);
});

// ---- runStagedTests ----

const fixturePackage = (script) => JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, type: 'module', scripts: { test: script } });
const NODE_TEST_PASS = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passes', () => assert.equal(1, 1));\n";
const NODE_TEST_FAIL = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n";

test('runStagedTests passes a green fixture and reports the test counts', () => {
  const { dir } = stageFiles({ 'package.json': fixturePackage('node --test'), 'a.test.mjs': NODE_TEST_PASS });
  const result = ex.runStagedTests(dir, { tmpHome: tmp('home-run'), pathEnv: process.env.PATH });
  assert.equal(result.ok, true);
  assert.match(result.summary, /tests 1\b.*pass 1\b.*fail 0\b.*skipped 0\b/);
});

test('runStagedTests fails a red fixture and reports the failing count', () => {
  const { dir } = stageFiles({ 'package.json': fixturePackage('node --test'), 'a.test.mjs': NODE_TEST_FAIL });
  const result = ex.runStagedTests(dir, { tmpHome: tmp('home-run'), pathEnv: process.env.PATH });
  assert.equal(result.ok, false);
  assert.match(result.summary, /tests 1\b.*pass 0\b.*fail 1\b/);
  assert.match(result.summary, /failed: .*a\.test\.mjs:\d+:\d+ fails\b/, 'the summary names the failing test and its file');
});

test('runStagedTests falls back to the last output lines when there are no counts', () => {
  const script = `node -e "console.log('first line'); console.error('last line'); process.exit(3)"`;
  const { dir } = stageFiles({ 'package.json': fixturePackage(script) });
  const result = ex.runStagedTests(dir, { tmpHome: tmp('home-run'), pathEnv: process.env.PATH });
  assert.equal(result.ok, false);
  assert.match(result.summary, /last line/);
});

// The keys of the environment `npm test` runs a script in, written to <HOME>/keys.json; npm and the shell add their own keys
// (npm_*, INIT_CWD, PWD...), so the child of runStagedTests is compared with a run given exactly the allowed variables.
const KEYS_SCRIPT = `node -e "require('fs').writeFileSync(process.env.HOME + '/keys.json', JSON.stringify(Object.keys(process.env).sort()))"`;

test('runStagedTests gives the child exactly PATH, HOME=tmpHome and, when the parent has them, TMPDIR and LANG', () => {
  const { dir } = stageFiles({ 'package.json': fixturePackage(KEYS_SCRIPT) });
  const allowed = { PATH: process.env.PATH };
  for (const key of ['TMPDIR', 'LANG']) if (process.env[key] !== undefined) allowed[key] = process.env[key];

  const baselineHome = tmp('home-baseline');
  const baseline = spawnSync('npm', ['test'], { cwd: dir, env: { ...allowed, HOME: baselineHome }, encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  const expectedKeys = JSON.parse(readFileSync(join(baselineHome, 'keys.json'), 'utf8'));
  for (const key of [...Object.keys(allowed), 'HOME']) assert.ok(expectedKeys.includes(key), `baseline lacks ${key}`);

  const tmpHome = tmp('home-run');
  const leaks = { GIT_DIR: '/nonexistent', MEMORY_REPORT_STATE_DIR: '/nonexistent', CM_HOOK_X: '1', EXPORT_PROBE_VALUE: '1', SOME_TOKEN: 'x' };
  Object.assign(process.env, leaks);
  try {
    const result = ex.runStagedTests(dir, { tmpHome, pathEnv: process.env.PATH });
    assert.equal(result.ok, true, result.summary);
  } finally {
    for (const key of Object.keys(leaks)) delete process.env[key];
  }
  assert.deepEqual(JSON.parse(readFileSync(join(tmpHome, 'keys.json'), 'utf8')), expectedKeys);
});

test('runStagedTests stops a run that exceeds its timeout and says so', () => {
  const { dir } = stageFiles({ 'package.json': fixturePackage(`node -e "setTimeout(() => {}, 4000)"`) });
  const result = ex.runStagedTests(dir, { tmpHome: tmp('home-run'), pathEnv: process.env.PATH, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.summary, /timed out/);
  assert.equal(typeof ex.STAGED_TEST_TIMEOUT_MS, 'number');
});

// ---- target safety, update, commit and the CLI (spec 4.1, 4.2, 4.7) ----
// Every run below targets a throwaway repository and a throwaway "private" repository whose slug is the invented acme/tools;
// the CLI is never pointed at this repository, and each run is given its own repoRoot. The target's remote is a local bare
// repository in a temp dir, and its bytes are compared after every run: the export never pushes and never adds a remote.

const cli = () => import('../bin/export-public.mjs');
const PRIVATE_SLUG = 'acme/tools';
const PUBLIC_SLUG = 'acme/tools-public';
const PUB_NAME = 'Pub Tester';
const PUB_EMAIL = 'pub@example.invalid';
const USAGE = 'usage: node bin/export-public.mjs --to <dir> --public-repo <owner/name> [--dry-run] [--no-local-terms]';

const sink = () => {
  const chunks = [];
  return { write: (text) => (chunks.push(String(text)), true), text: () => chunks.join('') };
};

// The environment of one export run: no global git configuration, an empty HOME, an explicit identity and a deny file with the
// invented term `globex`. A key given as undefined is removed.
function runEnv(over = {}) {
  const deny = join(tmp('deny'), 'deny.txt');
  writeFileSync(deny, '# invented terms\nglobex\n');
  const env = {
    PATH: process.env.PATH,
    HOME: tmp('home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: PUB_NAME,
    GIT_AUTHOR_EMAIL: PUB_EMAIL,
    GIT_COMMITTER_NAME: PUB_NAME,
    GIT_COMMITTER_EMAIL: PUB_EMAIL,
    PUBLIC_EXPORT_DENY: deny,
  };
  for (const key of ['TMPDIR', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// Runs main on a throwaway repository; `repoRoot` is mandatory so no run can fall back to this repository.
async function exportRun(argv, { repoRoot, env = runEnv(), afterCopy, stdout = sink() } = {}) {
  assert.ok(repoRoot, 'a test must name its own throwaway repoRoot');
  const { main } = await cli();
  const stderr = sink();
  const code = main(argv, { env, stdout, stderr, repoRoot, afterCopy });
  return { code, out: stdout.text(), err: stderr.text() };
}

// path -> content hash (and mode) of every entry under `dir`, `.git` included: equal snapshots mean equal bytes.
function snapshot(dir) {
  const entries = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) entries[path] = `link ${readlinkSync(join(dir, path))}`;
      else if (stat.isDirectory()) {
        entries[path] = 'dir';
        walk(path);
      } else entries[path] = `${(stat.mode & 0o777).toString(8)} ${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')}`;
    }
  };
  walk('');
  return entries;
}

const GREEN_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const RED_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => assert.equal(1, 2));\n";
const FIXTURE_MANIFEST = { include: ['package.json', 'README.md', 'src/', 'test/', 'public-export.json'], exclude: [], keepInTarget: ['.github/'], allowSecrets: [] };

// The throwaway private repository: origin acme/tools, a manifest at HEAD, a README that names the slug once, an executable
// script and one passing test (`npm test` runs in the staging copy).
function privateRepo(over = {}, repoOptions = {}) {
  return makeRepo({
    'package.json': JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }),
    'README.md': 'see https://github.com/acme/tools for details\n',
    'src/run.sh': { text: '#!/bin/sh\necho hi\n', mode: 0o755 },
    'src/lib.txt': 'lib\n',
    'test/ok.test.mjs': GREEN_TEST,
    'public-export.json': JSON.stringify(FIXTURE_MANIFEST),
    ...over,
  }, repoOptions);
}

// A private repository, a target with a local bare remote and `run`, which runs the CLI against them and asserts that the
// bare remote and the target's remote list are unchanged afterwards. The target holds a seed commit pushed to the bare
// remote, or no commit at all when `unborn`.
function scenario({ unborn = false, privOver, privOrigin, seed = { 'old.txt': 'old\n', '.github/ci.yml': 'ci\n', 'src/lib.txt': 'stale\n' } } = {}) {
  const priv = privateRepo(privOver, privOrigin ? { origin: privOrigin } : {});
  const bare = tmp('bare');
  git(bare, 'init', '--bare', '-q');
  const target = tmp('target');
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'remote', 'add', 'origin', bare);
  if (!unborn) {
    writeFiles(target, seed);
    commitAll(target, 'seed');
    git(target, 'push', '-q', 'origin', 'main');
  }
  const args = (...extra) => ['--to', target, '--public-repo', PUBLIC_SLUG, ...extra];
  const run = async (argv = args(), opts = {}) => {
    const bareBefore = snapshot(bare);
    const remotesBefore = git(target, 'remote', '-v');
    const result = await exportRun(argv, { repoRoot: priv, ...opts });
    assert.deepEqual(snapshot(bare), bareBefore, 'the bare remote changed');
    assert.equal(git(target, 'remote', '-v'), remotesBefore, 'the target remotes changed');
    return result;
  };
  return { priv, bare, target, args, run };
}

// One refused run: exit 2, a message matching `reason`, and the target's bytes as they were.
async function assertRefused(s, argv, reason, opts, dir = s.target) {
  const before = snapshot(dir);
  const result = await s.run(argv, opts);
  assert.equal(result.code, 2, `${reason}: exit ${result.code}\n${result.err}`);
  assert.match(result.err, reason);
  assert.deepEqual(snapshot(dir), before, `${reason}: the target changed`);
  return result;
}

test('the CLI refuses a --public-repo that is malformed or names the private repository, in any case', async () => {
  const s = scenario();
  for (const bad of ['notaslug', 'a/b/c', 'acme/', '/tools', 'acme/tools', 'ACME/TOOLS', 'ac me/tools', 'acme/repo.git', 'acme/repo.GIT', 'acme/repo.']) {
    await assertRefused(s, ['--to', s.target, '--public-repo', bad], /--public-repo/);
  }
});

test('the CLI refuses a subdirectory of a repository, the private repository, its worktree and its clone', async () => {
  const s = scenario();
  mkdirSync(join(s.target, 'sub'));
  await assertRefused(s, ['--to', join(s.target, 'sub'), '--public-repo', PUBLIC_SLUG], /root of its repository/);
  await assertRefused(s, ['--to', s.priv, '--public-repo', PUBLIC_SLUG], /private repository/, undefined, s.priv);
  const worktree = join(tmp('wt-parent'), 'wt');
  git(s.priv, 'worktree', 'add', '-q', '--detach', worktree);
  await assertRefused(s, ['--to', worktree, '--public-repo', PUBLIC_SLUG], /private repository/, undefined, worktree);
  const clone = join(tmp('clone-parent'), 'clone');
  execFileSync('git', ['clone', '-q', s.priv, clone], { env: gitEnv() });
  await assertRefused(s, ['--to', clone, '--public-repo', PUBLIC_SLUG], /history/, undefined, clone);
});

// A private repository whose history is A (root) and B, and a depth-1 clone of it taken while B is the tip. The clone's remote is
// removed and commit C is then added to the private repository, so the target holds B only. Returns the three shas.
function shallowCloneOfOlderCommit(s) {
  const a = git(s.priv, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(s.priv, 'b.txt'), 'b\n');
  commitAll(s.priv, 'b');
  const b = git(s.priv, 'rev-parse', 'HEAD').trim();
  const clone = join(tmp('shallow-parent'), 'clone');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${s.priv}`, clone], { env: gitEnv() });
  git(clone, 'remote', 'remove', 'origin');
  writeFileSync(join(s.priv, 'c.txt'), 'c\n');
  commitAll(s.priv, 'c');
  const c = git(s.priv, 'rev-parse', 'HEAD').trim();
  assert.ok(existsSync(join(clone, '.git', 'shallow')), 'the clone is shallow');
  const holds = (sha) => spawnSync('git', ['-C', clone, 'cat-file', '-e', sha], { env: gitEnv() }).status === 0;
  assert.equal(holds(a), false, 'the clone does not hold the root commit');
  assert.equal(holds(c), false, 'the clone does not hold the private tip');
  assert.equal(holds(b), true, 'the clone holds the older private commit');
  return { clone, a, b, c };
}

test('checkTarget refuses a shallow clone of an older private commit', async () => {
  const s = scenario({ unborn: true });
  const { clone } = shallowCloneOfOlderCommit(s);
  assert.throws(() => ex.checkTarget(clone, targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2 && /shares history/.test(err.message));
  await assertRefused(s, ['--to', clone, '--public-repo', PUBLIC_SLUG], /shares history/, undefined, clone);
});

test('checkTarget refuses the same clone switched to an orphan branch', async () => {
  const s = scenario({ unborn: true });
  const { clone } = shallowCloneOfOlderCommit(s);
  git(clone, 'checkout', '-q', '--orphan', 'pub');
  git(clone, 'rm', '-rf', '-q', '.');
  assert.equal(git(clone, 'status', '--porcelain'), '', 'the orphan branch is clean');
  assert.throws(() => git(clone, 'rev-parse', '--verify', '-q', 'HEAD'), 'HEAD is unborn');
  assert.throws(() => ex.checkTarget(clone, targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2 && /shares history/.test(err.message));
  await assertRefused(s, ['--to', clone, '--public-repo', PUBLIC_SLUG], /shares history/, undefined, clone);
});

test('checkTarget refuses a target that holds only the private root commit', () => {
  const s = scenario({ unborn: true });
  const a = git(s.priv, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(s.priv, 'b.txt'), 'b\n');
  commitAll(s.priv, 'b');
  const target = tmp('root-only');
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'fetch', '-q', s.priv, `${a}:refs/heads/a`);
  assert.throws(() => ex.checkTarget(target, targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2 && /shares history/.test(err.message));
});

test('checkTarget reads the target with replace refs off: a graft that hides a private parent does not let the target in', () => {
  const s = scenario({ unborn: true });
  const { clone } = shallowCloneOfOlderCommit(s);
  writeFileSync(join(clone, 'own.txt'), 'own\n');
  commitAll(clone, 'own');
  const own = git(clone, 'rev-parse', 'HEAD').trim();
  git(clone, 'replace', '--graft', own);
  assert.equal(git(clone, 'rev-list', '--count', 'HEAD').trim(), '1', 'with the graft honoured the target looks parentless');
  assert.equal(git(clone, '--no-replace-objects', 'rev-list', '--count', 'HEAD').trim(), '2', 'without it the private parent shows');
  assert.throws(() => ex.checkTarget(clone, targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2 && /shares history/.test(err.message));
});

test('checkTarget refuses a target that holds the private root, or the private tip, as an object with no ref', () => {
  const s = scenario({ unborn: true });
  const a = git(s.priv, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(s.priv, 'b.txt'), 'b\n');
  commitAll(s.priv, 'b');
  const heldWithoutRef = (label, fetchArgs, sha) => {
    const target = tmp(label);
    git(target, 'init', '-q', '-b', 'main');
    execFileSync('git', ['-C', target, 'fetch', '-q', ...fetchArgs], { env: gitEnv() });
    git(target, 'update-ref', '-d', 'refs/heads/held');
    git(target, 'reflog', 'expire', '--expire=now', '--all');
    assert.equal(git(target, 'for-each-ref'), '', 'the target holds no ref');
    assert.equal(git(target, '--no-replace-objects', 'rev-list', '--all'), '', 'nothing is reachable');
    assert.equal(spawnSync('git', ['-C', target, 'cat-file', '-e', sha], { env: gitEnv() }).status, 0, 'the object is still held');
    return target;
  };
  const refuses = (target) => assert.throws(() => ex.checkTarget(target, targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2 && /shares history/.test(err.message));
  refuses(heldWithoutRef('root-no-ref', [s.priv, `${a}:refs/heads/held`], a));
  const tip = git(s.priv, 'rev-parse', 'HEAD').trim();
  refuses(heldWithoutRef('tip-no-ref', ['--depth', '1', `file://${s.priv}`, 'HEAD:refs/heads/held'], tip));
});

test('checkTarget accepts an unrelated target with its own history', () => {
  const s = scenario({ unborn: true });
  const target = tmp('unrelated');
  git(target, 'init', '-q', '-b', 'main');
  writeFileSync(join(target, 'other.txt'), 'zorblax-free\n');
  commitAll(target, 'own');
  git(target, 'checkout', '-q', '--orphan', 'second');
  writeFileSync(join(target, 'more.txt'), 'more\n');
  commitAll(target, 'own two');
  assert.equal(ex.checkTarget(target, targetOpts({ repoRoot: s.priv, terms: [] })).unborn, false);
});

test('the CLI refuses a target with a remote that names the private repository, in any URL form or case, even through insteadOf', async () => {
  const s = scenario({ unborn: true });
  const urls = [`git${AT}github.com:acme/tools.git`, 'https://github.com/ACME/Tools.git/', `ssh://git${AT}github.com/acme/tools`, 'https://github.com/acme/tools/'];
  for (const url of urls) {
    git(s.target, 'remote', 'add', 'extra', url);
    await assertRefused(s, s.args(), /remote/);
    git(s.target, 'remote', 'remove', 'extra');
  }
  git(s.target, 'config', 'url.https://example.invalid/acme/.insteadOf', 'mirror:');
  git(s.target, 'remote', 'add', 'extra', 'mirror:tools');
  await assertRefused(s, s.args(), /remote/);
  git(s.target, 'remote', 'remove', 'extra');
  git(s.target, 'remote', 'add', 'extra', `git${AT}github.com:acme/tools.git`);
  git(s.target, 'remote', 'set-url', '--push', 'extra', 'https://example.invalid/other/place.git');
  await assertRefused(s, s.args(), /remote/);
});

test('the CLI refuses a dirty target: a modified tracked file, an untracked file, and an untracked file in an unborn target', async () => {
  const s = scenario();
  writeFileSync(join(s.target, 'old.txt'), 'edited\n');
  await assertRefused(s, s.args(), /uncommitted/);
  git(s.target, 'checkout', '-q', '--', 'old.txt');
  writeFileSync(join(s.target, 'stray.txt'), 'x\n');
  await assertRefused(s, s.args(), /uncommitted/);
  const unborn = scenario({ unborn: true });
  writeFileSync(join(unborn.target, 'stray.txt'), 'x\n');
  await assertRefused(unborn, unborn.args(), /uncommitted/);
});

test('the CLI refuses a target without an explicit identity, but accepts one set in the target config', async () => {
  const s = scenario();
  const none = { GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined };
  await assertRefused(s, s.args(), /identity/, { env: runEnv(none) });
  await assertRefused(s, s.args(), /identity/, { env: runEnv({ GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined }) });
  git(s.target, 'config', 'user.name', 'Cfg Person');
  await assertRefused(s, s.args(), /identity/, { env: runEnv(none) }); // a name alone is not an identity
  git(s.target, 'config', 'user.email', 'cfg@example.invalid');
  const done = await s.run(s.args(), { env: runEnv(none) });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /author: Cfg Person <cfg@example\.invalid>/);
  assert.equal(git(s.target, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim(), 'Cfg Person <cfg@example.invalid>|Cfg Person <cfg@example.invalid>');
});

test('the CLI refuses an author or committer identity that contains a local term, without printing the term', async () => {
  const s = scenario();
  for (const over of [{ GIT_AUTHOR_NAME: 'Globex Dev' }, { GIT_COMMITTER_EMAIL: 'dev@globex.example.invalid' }]) {
    const result = await assertRefused(s, s.args(), /identity.*local term/i, { env: runEnv(over) });
    assert.doesNotMatch(result.err, /globex/i);
  }
});

test('the CLI exits 2 when no local term is configured, unless --no-local-terms is passed', async () => {
  const s = scenario({ unborn: true });
  const empty = join(tmp('deny-empty'), 'deny.txt');
  writeFileSync(empty, '# nothing here\n\n');
  await assertRefused(s, s.args(), /no local terms are configured/, { env: runEnv({ PUBLIC_EXPORT_DENY: empty }) });
  const done = await s.run(s.args('--no-local-terms'), { env: runEnv({ PUBLIC_EXPORT_DENY: empty }) });
  assert.equal(done.code, 0, done.err);
});

test('the first export into an unborn target commits "Export <date> from <sha>" with the explicit identity, printed before writing', async () => {
  const s = scenario({ unborn: true });
  const stdout = sink();
  let printedBeforeWrite = '';
  const result = await s.run(s.args(), { stdout, afterCopy: () => { printedBeforeWrite = stdout.text(); } });
  assert.equal(result.code, 0, result.err);
  assert.match(printedBeforeWrite, new RegExp(`author: ${PUB_NAME} <${PUB_EMAIL.replace('.', '\\.')}>`));
  assert.match(printedBeforeWrite, new RegExp(`committer: ${PUB_NAME} <${PUB_EMAIL.replace('.', '\\.')}>`));
  assert.doesNotMatch(printedBeforeWrite, /\b\d{9,}\b/, 'the identity is printed without its timestamp');
  const short = git(s.priv, 'rev-parse', '--short', 'HEAD').trim();
  const subject = git(s.target, 'log', '-1', '--format=%s').trim();
  assert.match(subject, /^Export \d{4}-\d{2}-\d{2} from [0-9a-f]{7,}$/);
  assert.ok(subject.endsWith(` from ${short}`), subject);
  assert.equal(git(s.target, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim(), `${PUB_NAME} <${PUB_EMAIL}>|${PUB_NAME} <${PUB_EMAIL}>`);
  assert.equal(git(s.target, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(readFileSync(join(s.target, 'README.md'), 'utf8'), 'see https://github.com/acme/tools-public for details\n');
  assert.ok((statSync(join(s.target, 'src/run.sh')).mode & 0o111) !== 0, 'the executable bit survives');
  assert.equal(git(s.target, 'status', '--porcelain'), '');
  assert.equal(git(s.target, 'ls-tree', '-r', 'HEAD', 'src/run.sh').split(' ')[0], '100755');
});

test('a second identical export prints no changes, makes no commit and exits 0', async () => {
  const s = scenario({ unborn: true });
  assert.equal((await s.run()).code, 0);
  const head = git(s.target, 'rev-parse', 'HEAD');
  const again = await s.run();
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^no changes$/m);
  assert.equal(git(s.target, 'rev-parse', 'HEAD'), head);
});

test('an export into a seeded target deletes stale tracked files, keeps keepInTarget, updates files and commits', async () => {
  const s = scenario();
  const result = await s.run();
  assert.equal(result.code, 0, result.err);
  assert.equal(existsSync(join(s.target, 'old.txt')), false, 'a stale tracked file is deleted');
  assert.equal(readFileSync(join(s.target, '.github/ci.yml'), 'utf8'), 'ci\n', 'keepInTarget survives');
  assert.equal(readFileSync(join(s.target, 'src/lib.txt'), 'utf8'), 'lib\n');
  assert.equal(git(s.target, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(git(s.target, 'status', '--porcelain'), '');
  const changed = git(s.target, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort();
  assert.ok(changed.includes('D\told.txt'), changed.join('|'));
  assert.ok(!changed.some((line) => line.includes('.github')), 'keepInTarget is not touched');
});

test('a target accepts a remote named acme/tools-public', async () => {
  const s = scenario({ unborn: true });
  git(s.target, 'remote', 'add', 'public', `git${AT}github.com:${PUBLIC_SLUG}.git`);
  const result = await s.run();
  assert.equal(result.code, 0, result.err);
});

test('failing staged tests exit 1 and leave the target untouched; the identity was already printed', async () => {
  const s = scenario({ privOver: { 'test/ok.test.mjs': RED_TEST } });
  const before = snapshot(s.target);
  const result = await s.run();
  assert.equal(result.code, 1);
  assert.match(result.err, /staged tests failed/);
  assert.match(result.out, new RegExp(`author: ${PUB_NAME}`));
  assert.deepEqual(snapshot(s.target), before);
});

test('a content check hit exits 1 listing <path>:<line> <category> without the matched text, and the target stays untouched', async () => {
  const note = `first\n${addr('dev', 'umbrella.org')}\nsecond\nthe globex plan\n`;
  const s = scenario({ privOver: { 'src/note.txt': note } });
  const before = snapshot(s.target);
  const result = await s.run();
  assert.equal(result.code, 1);
  assert.match(result.err, /^src\/note\.txt:2 email$/m);
  assert.match(result.err, /^src\/note\.txt:4 local-term$/m);
  assert.doesNotMatch(result.err, /umbrella|globex/i);
  assert.doesNotMatch(result.out, /umbrella|globex/i);
  assert.deepEqual(snapshot(s.target), before);
});

test('a CR-only deny file still blocks a staged term and exits 1', async () => {
  const deny = join(tmp('deny-cr'), 'deny.txt');
  writeFileSync(deny, 'alpha\rzorblax\r');
  const s = scenario({ privOver: { 'src/note.txt': 'the zorblax plan\n' } });
  const before = snapshot(s.target);
  const result = await s.run(undefined, { env: runEnv({ PUBLIC_EXPORT_DENY: deny }) });
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /^src\/note\.txt:1 local-term$/m);
  assert.doesNotMatch(result.err, /zorblax/i);
  assert.deepEqual(snapshot(s.target), before);
});

test('a binary file in the export exits 1 before the target is touched', async () => {
  const s = scenario({ privOver: { 'src/blob.bin': Buffer.from([1, 0, 2, 0]) } });
  const before = snapshot(s.target);
  const result = await s.run();
  assert.equal(result.code, 1);
  assert.match(result.err, /src\/blob\.bin/);
  assert.deepEqual(snapshot(s.target), before);
});

test('an extra file written by afterCopy exits 1 without a commit and prints the restore command, which restores the target', async () => {
  const s = scenario();
  const before = snapshot(s.target);
  const result = await s.run(undefined, { afterCopy: () => writeFileSync(join(s.target, 'stray.txt'), 'x\n') });
  assert.equal(result.code, 1);
  assert.match(result.err, /stray\.txt/);
  assert.ok(result.err.includes(`git -C ${s.target} reset --hard && git -C ${s.target} clean -fd`), result.err);
  assert.equal(git(s.target, 'rev-list', '--count', 'HEAD').trim(), '1', 'no commit was made');
  assert.notEqual(git(s.target, 'status', '--porcelain'), '', 'the target was left modified for the user to restore');
  git(s.target, 'reset', '--hard', '-q');
  git(s.target, 'clean', '-fdq');
  assert.deepEqual(Object.keys(snapshot(s.target)).filter((p) => !p.startsWith('.git')), Object.keys(before).filter((p) => !p.startsWith('.git')));
  assert.equal(git(s.target, 'status', '--porcelain'), '');
});

test('for an unborn target the failure message lists the copied files to delete instead of a git restore', async () => {
  const s = scenario({ unborn: true });
  const result = await s.run(undefined, { afterCopy: () => writeFileSync(join(s.target, 'stray.txt'), 'x\n') });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.err, /reset --hard/);
  for (const path of ['README.md', 'package.json', 'src/run.sh', 'src/lib.txt', 'test/ok.test.mjs', 'public-export.json', 'stray.txt']) {
    assert.ok(result.err.includes(path), `the list names ${path}`);
  }
  const head = spawnSync('git', ['-C', s.target, 'rev-parse', '--verify', '-q', 'HEAD'], { env: gitEnv() });
  assert.notEqual(head.status, 0, 'the unborn target got no commit');
});

test('--dry-run prints the file count, the rewrite count and the test summary, and never touches the target', async () => {
  const s = scenario();
  const before = snapshot(s.target);
  const result = await s.run(s.args('--dry-run'));
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^files: 6$/m);
  const listing = result.out.slice(result.out.indexOf('files: 6'), result.out.indexOf('rewrites: 1'));
  assert.equal(listing, 'files: 6\nREADME.md\npackage.json\npublic-export.json\nsrc/lib.txt\nsrc/run.sh\ntest/ok.test.mjs\n', 'one exported path per line, sorted, before rewrites');
  assert.match(result.out, /^rewrites: 1$/m);
  assert.match(result.out, /^tests: tests 1, pass 1, fail 0, skipped 0$/m);
  assert.deepEqual(snapshot(s.target), before);
  await assertRefused(s, s.args('--dry-run'), /identity/, { env: runEnv({ GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined }) });
});

test('usage errors exit 2 and print the one-line usage', async () => {
  const repoRoot = privateRepo();
  const both = ['--to', 'x', '--public-repo', 'acme/tools-public'];
  const cases = [[], ['--to'], ['--to', 'x'], ['--public-repo', 'acme/tools-public'], ['--to', 'x', '--public-repo', 'acme/tools-public', '--bogus'], ['--to', 'x', '--to', 'y', '--public-repo', 'acme/tools-public'], ['stray'],
    ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].map((name) => [...both, name])];
  for (const argv of cases) {
    const result = await exportRun(argv, { repoRoot });
    assert.equal(result.code, 2, argv.join(' '));
    assert.ok(result.err.split('\n').includes(USAGE), result.err);
  }
});

test('the script exits 2 with the usage on bad arguments, and finds its own repository from import.meta.url, never cwd', async () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'export-public.mjs');
  const run = spawnSync(process.execPath, [script, '--to'], { cwd: tmp('cwd'), encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.split('\n').includes(USAGE), run.stderr);
  const { SCRIPT_REPO_ROOT } = await cli();
  assert.equal(SCRIPT_REPO_ROOT, join(dirname(fileURLToPath(import.meta.url)), '..'));
});

// ---- checkTarget, updateTarget and commitTarget called directly ----

const targetOpts = (over = {}) => ({ repoRoot: over.repoRoot, privateSlug: PRIVATE_SLUG, publicSlug: PUBLIC_SLUG, terms: ['globex'], env: runEnv(), ...over });

test('checkTarget returns { unborn, identity } for an accepted target, identity without timestamps', () => {
  const s = scenario();
  const seeded = ex.checkTarget(s.target, targetOpts({ repoRoot: s.priv }));
  assert.deepEqual(seeded, { unborn: false, identity: { author: `${PUB_NAME} <${PUB_EMAIL}>`, committer: `${PUB_NAME} <${PUB_EMAIL}>` } });
  const fresh = scenario({ unborn: true });
  assert.equal(ex.checkTarget(fresh.target, targetOpts({ repoRoot: fresh.priv })).unborn, true);
  assert.throws(() => ex.checkTarget(join(tmp('none'), 'missing'), targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2);
  assert.throws(() => ex.checkTarget(tmp('plain-dir'), targetOpts({ repoRoot: s.priv })), (err) => err instanceof ex.ExportError && err.code === 2);
});

test('checkTarget passes the caller env to git: GIT_DIR and GIT_WORK_TREE are dropped, GIT_CONFIG_* are honoured', () => {
  const s = scenario();
  const env = runEnv({ GIT_DIR: join(s.priv, '.git'), GIT_WORK_TREE: s.priv, GIT_INDEX_FILE: join(s.priv, '.git', 'index') });
  assert.equal(ex.checkTarget(s.target, targetOpts({ repoRoot: s.priv, env })).unborn, false);
});

// A staging directory holding `files` ({ path: text }) with the list updateTarget takes.
const stagedSet = (files) => {
  const { dir, list } = stageFiles(files);
  return { dir, list };
};

test('updateTarget deletes stale tracked files, copies staged files with modes, and reports { deleted, unexpected }', () => {
  const s = scenario();
  const { dir, list } = stagedSet({ 'src/lib.txt': 'lib\n', 'run.sh': '#!/bin/sh\n' });
  list.find((f) => f.path === 'run.sh').mode = '100755';
  const result = ex.updateTarget(s.target, dir, list, manifestOf(), { env: runEnv() });
  assert.deepEqual(result, { deleted: ['old.txt'], unexpected: [] });
  assert.equal(existsSync(join(s.target, 'old.txt')), false);
  assert.equal(readFileSync(join(s.target, '.github/ci.yml'), 'utf8'), 'ci\n');
  assert.equal(statSync(join(s.target, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(statSync(join(s.target, 'src/lib.txt')).mode & 0o777, 0o644);
});

test('updateTarget calls afterCopy after copying and lists what the status reports beyond staged and deleted paths', () => {
  const s = scenario();
  const { dir, list } = stagedSet({ 'src/lib.txt': 'lib\n' });
  let calledWithCopied = false;
  const result = ex.updateTarget(s.target, dir, list, manifestOf(), {
    env: runEnv(),
    afterCopy: () => {
      calledWithCopied = readFileSync(join(s.target, 'src/lib.txt'), 'utf8') === 'lib\n';
      mkdirSync(join(s.target, 'tool'));
      writeFileSync(join(s.target, 'tool', 'cache.txt'), 'x');
      writeFileSync(join(s.target, '.github', 'ci.yml'), 'changed by a tool\n');
    },
  });
  assert.equal(calledWithCopied, true);
  assert.deepEqual(result.deleted, ['old.txt']);
  assert.deepEqual(result.unexpected.sort(), ['.github/ci.yml', 'tool/cache.txt']);
});

test('updateTarget refuses a staged path inside .git and one behind a symlinked directory, before changing anything', () => {
  const s = scenario();
  const before = snapshot(s.target);
  for (const path of ['.git/hooks/pre-commit', '.GIT/config']) {
    const { dir, list } = stagedSet({ [path]: 'x\n' });
    assert.throws(() => ex.updateTarget(s.target, dir, list, manifestOf(), { env: runEnv() }), (err) => err instanceof ex.ExportError && err.code === 1, path);
    assert.deepEqual(snapshot(s.target), before);
  }
  const outside = tmp('outside');
  symlinkSync(outside, join(s.target, 'link'));
  commitAll(s.target, 'add a symlink');
  const withLink = snapshot(s.target);
  const { dir, list } = stagedSet({ 'link/x.txt': 'x\n' });
  assert.throws(() => ex.updateTarget(s.target, dir, list, manifestOf(), { env: runEnv() }), (err) => err instanceof ex.ExportError && err.code === 1);
  assert.deepEqual(snapshot(s.target), withLink);
  assert.equal(existsSync(join(outside, 'x.txt')), false);
});

test('updateTarget replaces a tracked symlink at a staged path by the file, without writing through it', () => {
  const s = scenario();
  const outside = join(tmp('outside'), 'victim.txt');
  writeFileSync(outside, 'keep\n');
  symlinkSync(outside, join(s.target, 'src-link'));
  commitAll(s.target, 'add a symlink');
  const { dir, list } = stagedSet({ 'src-link': 'file now\n' });
  ex.updateTarget(s.target, dir, list, manifestOf(), { env: runEnv() });
  assert.equal(readFileSync(outside, 'utf8'), 'keep\n');
  assert.equal(lstatSync(join(s.target, 'src-link')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(s.target, 'src-link'), 'utf8'), 'file now\n');
});

test('commitTarget commits with the env identity, then answers no changes; an empty unborn target has nothing to commit', () => {
  const s = scenario();
  writeFileSync(join(s.target, 'new.txt'), 'new\n');
  assert.equal(ex.commitTarget(s.target, 'Export test message', { env: runEnv() }), 'committed');
  assert.equal(git(s.target, 'log', '-1', '--format=%s').trim(), 'Export test message');
  assert.equal(git(s.target, 'log', '-1', '--format=%an').trim(), PUB_NAME);
  assert.equal(ex.commitTarget(s.target, 'Export again', { env: runEnv() }), 'no changes');
  assert.equal(git(s.target, 'rev-list', '--count', 'HEAD').trim(), '2');
  const fresh = scenario({ unborn: true });
  assert.equal(ex.commitTarget(fresh.target, 'Export empty', { env: runEnv() }), 'no changes');
});

// ---- fix round 1: one HEAD, the checked bytes, a target that cannot change under the export ----

// Rewrites the private repository's only staged test so it runs `body` (JS source) and commits it; the export then runs it.
// Called after scenario() so the body can name the throwaway paths. The test source holds no term, secret or home path.
const hookTest = (repo, body) => {
  const source = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { appendFileSync, writeFileSync } from 'node:fs';\nimport { execFileSync } from 'node:child_process';\ntest('hook', () => {\n${body}\n});\n`;
  writeFiles(repo, { 'test/ok.test.mjs': source });
  commitAll(repo, 'hook test');
};
// JS source that commits `files` ({ path: text }) to the repository at `repo` from inside a staged test.
const commitFromTest = (repo, files) => `
  const gitEnv = { PATH: process.env.PATH };
  for (const [path, text] of Object.entries(${JSON.stringify(files)})) writeFileSync(${JSON.stringify(repo)} + '/' + path, text);
  execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'add', '-A'], { env: gitEnv });
  execFileSync('git', ['-C', ${JSON.stringify(repo)}, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later'], { env: gitEnv });`;

test('D2: the export pins one private HEAD: a commit during the staged tests changes neither the files nor the commit message', async () => {
  const s = scenario();
  hookTest(s.priv, commitFromTest(s.priv, { 'src/lib.txt': 'changed later\n', 'later.txt': 'later\n', 'public-export.json': JSON.stringify({ ...FIXTURE_MANIFEST, include: [...FIXTURE_MANIFEST.include, 'later.txt'] }) }));
  const pinned = git(s.priv, 'rev-parse', '--short', 'HEAD').trim();
  const result = await s.run();
  assert.equal(result.code, 0, result.err);
  assert.notEqual(git(s.priv, 'rev-parse', '--short', 'HEAD').trim(), pinned, 'the staged test did commit to the private repository');
  assert.ok(git(s.target, 'log', '-1', '--format=%s').trim().endsWith(` from ${pinned}`), git(s.target, 'log', '-1', '--format=%s'));
  assert.equal(readFileSync(join(s.target, 'src/lib.txt'), 'utf8'), 'lib\n');
  assert.equal(existsSync(join(s.target, 'later.txt')), false);
});

test('readManifest, listExportFiles and buildStaging read the revision they are given, not HEAD', () => {
  const repo = makeRepo({ 'src/a.txt': 'one\n', 'public-export.json': JSON.stringify(srcManifest()) });
  const first = git(repo, 'rev-parse', 'HEAD').trim();
  writeFiles(repo, { 'src/a.txt': 'two\n', 'src/b.txt': 'b\n', 'public-export.json': JSON.stringify(srcManifest({ keepInTarget: ['other/'] })) });
  commitAll(repo, 'second');
  const manifest = ex.readManifest(repo, { rev: first });
  assert.deepEqual(manifest.keepInTarget, ['.github/']);
  const files = ex.listExportFiles(repo, manifest, { rev: first });
  assert.deepEqual(files.map((f) => f.path), ['src/a.txt']);
  const stagingDir = tmp('stage-rev');
  ex.buildStaging(repo, files, { privateSlug: 'acme/tools', publicSlug: 'acme/tools-public', stagingDir, rev: first });
  assert.equal(readFileSync(join(stagingDir, 'src/a.txt'), 'utf8'), 'one\n');
  assert.equal(ex.headShortSha(repo, { rev: first }), git(repo, 'rev-parse', '--short', first).trim());
  assert.match(ex.resolveHead(repo), /^[0-9a-f]{40}$/);
  assert.equal(ex.resolveHead(repo), git(repo, 'rev-parse', 'HEAD').trim());
});

test('D1: the staged tests run on a copy, so what they write never reaches the target', async () => {
  const s = scenario();
  hookTest(s.priv, "writeFileSync('src/lib.txt', 'injected glo' + 'bex plan\\n');\n  writeFileSync('src/extra.txt', 'extra\\n');");
  const result = await s.run();
  assert.equal(result.code, 0, result.err);
  assert.equal(readFileSync(join(s.target, 'src/lib.txt'), 'utf8'), 'lib\n');
  assert.equal(git(s.target, 'show', 'HEAD:src/lib.txt'), 'lib\n');
  assert.equal(existsSync(join(s.target, 'src/extra.txt')), false);
  assert.equal(spawnSync('git', ['-C', s.target, 'grep', '-qi', 'globex', 'HEAD'], { env: gitEnv() }).status, 1, 'no committed blob holds the term');
});

test('D1: stagedDigests and assertStagedUnchanged fail closed on a changed byte, a new hit or a missing file', () => {
  const { dir, list } = stageFiles({ 'a.txt': 'clean\n', 'b.txt': 'also clean\n' });
  const opts = { ...base, terms: ['globex'] };
  const digests = ex.stagedDigests(dir, list);
  assert.doesNotThrow(() => ex.assertStagedUnchanged(dir, list, opts, digests));
  writeFileSync(join(dir, 'b.txt'), 'different but clean\n');
  assert.throws(() => ex.assertStagedUnchanged(dir, list, opts, digests), (err) => err instanceof ex.ExportError && err.code === 1 && /changed/.test(err.message));
  writeFileSync(join(dir, 'b.txt'), 'the globex plan\n');
  const dirty = ex.stagedDigests(dir, list);
  assert.throws(() => ex.assertStagedUnchanged(dir, list, opts, dirty), (err) => err instanceof ex.ExportError && err.code === 1 && /content check/.test(err.message) && !/globex/i.test(err.message));
  rmSync(join(dir, 'a.txt'));
  assert.throws(() => ex.assertStagedUnchanged(dir, list, opts, digests), (err) => err instanceof ex.ExportError && err.code === 1);
});

test('D6: a target edited during the staged tests is refused before the first write (exit 2) and the edit survives', async () => {
  const s = scenario();
  hookTest(s.priv, `writeFileSync(${JSON.stringify(join(s.target, 'old.txt'))}, 'edited meanwhile\\n');`);
  const result = await s.run();
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /uncommitted|changed/);
  assert.equal(readFileSync(join(s.target, 'old.txt'), 'utf8'), 'edited meanwhile\n');
  assert.equal(existsSync(join(s.target, 'README.md')), false, 'nothing was copied');
  assert.equal(git(s.target, 'status', '--porcelain'), ' M old.txt\n');
  assert.doesNotMatch(result.err, /reset --hard/, 'the target was not touched, so there is nothing to restore');
  assert.equal(git(s.target, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('D6: a remote naming the private repository, added during the staged tests, is refused before the first write (exit 2)', async () => {
  const s = scenario();
  hookTest(s.priv, `execFileSync('git', ['-C', ${JSON.stringify(s.target)}, 'remote', 'add', 'extra', 'https://example.invalid/acme/' + 'tools.git'] /* split: the staged copy of this file gets the slug rewrite */, { env: { PATH: process.env.PATH } });`);
  const result = await exportRun(s.args(), { repoRoot: s.priv }); // not s.run: the hook itself changes the remote list
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /remote/);
  assert.equal(existsSync(join(s.target, 'README.md')), false);
  assert.equal(git(s.target, 'status', '--porcelain'), '');
});

// A scenario whose private repository tracks `src/keep.log` (force-added where its own .gitignore would ignore it).
function ignoredScenario({ stagedIgnore }) {
  const manifest = { ...FIXTURE_MANIFEST, include: stagedIgnore ? [...FIXTURE_MANIFEST.include, '.gitignore'] : FIXTURE_MANIFEST.include, keepInTarget: stagedIgnore ? ['.github/'] : ['.github/', '.gitignore'] };
  const s = scenario({ seed: { 'old.txt': 'old\n', '.github/ci.yml': 'ci\n', ...(stagedIgnore ? {} : { '.gitignore': '*.log\n' }) } });
  writeFiles(s.priv, { 'public-export.json': JSON.stringify(manifest), 'src/keep.log': 'fixture the tests read\n', ...(stagedIgnore ? { '.gitignore': '*.log\n' } : {}) });
  git(s.priv, 'add', '-f', '-A');
  git(s.priv, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ignored fixture');
  return s;
}

test('D3: a staged path that the staged .gitignore would ignore in the target is refused (exit 2, the path named) before any copy', async () => {
  const s = ignoredScenario({ stagedIgnore: true });
  const result = await assertRefused(s, s.args(), /src\/keep\.log/);
  assert.match(result.err, /ignore/i);
  assert.equal(existsSync(join(s.target, 'README.md')), false);
});

test('D3: a staged path that a kept .gitignore of the target ignores is refused (exit 2, the path named) before any copy', async () => {
  const s = ignoredScenario({ stagedIgnore: false });
  const result = await assertRefused(s, s.args(), /src\/keep\.log/);
  assert.match(result.err, /ignore/i);
});

test('D3: updateTarget refuses an ignored staged path with code 2 and changes nothing', () => {
  const s = scenario();
  writeFiles(s.target, { '.gitignore': '*.log\n' });
  commitAll(s.target, 'ignore logs');
  const before = snapshot(s.target);
  const { dir, list } = stagedSet({ 'src/lib.txt': 'lib\n', 'src/keep.log': 'x\n' });
  assert.throws(() => ex.updateTarget(s.target, dir, list, manifestOf({ keepInTarget: ['.github/', '.gitignore'] }), { env: runEnv() }), (err) => err instanceof ex.ExportError && err.code === 2 && err.message.includes('src/keep.log') && !err.message.includes('src/lib.txt'));
  assert.deepEqual(snapshot(s.target), before);
});

test('D5: a pre-flight refusal in updateTarget does not print the restore advice, since nothing changed', async () => {
  const s = scenario({ seed: { 'old.txt': 'old\n' } });
  symlinkSync(tmp('outside'), join(s.target, 'src'));
  commitAll(s.target, 'src is a symlink');
  const before = snapshot(s.target);
  const result = await s.run();
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /symlink/);
  assert.doesNotMatch(result.err, /restore|reset --hard|was modified/);
  assert.deepEqual(snapshot(s.target), before);
});

test('D5: updateTarget calls beforeWrite after its pre-flight checks and before the first change', () => {
  const s = scenario();
  const before = snapshot(s.target);
  let seen = null;
  const { dir, list } = stagedSet({ 'src/lib.txt': 'lib\n' });
  ex.updateTarget(s.target, dir, list, manifestOf(), { env: runEnv(), beforeWrite: () => { seen = snapshot(s.target); } });
  assert.deepEqual(seen, before);
  assert.equal(readFileSync(join(s.target, 'src/lib.txt'), 'utf8'), 'lib\n');
  const refusing = stagedSet({ '.git/x': 'x\n' });
  let called = false;
  assert.throws(() => ex.updateTarget(s.target, refusing.dir, refusing.list, manifestOf(), { env: runEnv(), beforeWrite: () => { called = true; } }), ex.ExportError);
  assert.equal(called, false, 'a refused pre-flight never reaches beforeWrite');
  const stopping = stagedSet({ 'src/lib.txt': 'other\n' });
  const fresh = snapshot(s.target);
  assert.throws(() => ex.updateTarget(s.target, stopping.dir, stopping.list, manifestOf(), { env: runEnv(), beforeWrite: () => { throw new ex.ExportError('stop', 2); } }), /stop/);
  assert.deepEqual(snapshot(s.target), fresh, 'a beforeWrite that throws leaves the target as it was');
});

test('N2: a prototype property name as an argument is a usage error (exit 2), never a flag', async () => {
  const s = scenario();
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const result = await s.run([...s.args(), name]);
    assert.equal(result.code, 2, name);
    assert.ok(result.err.split('\n').includes(USAGE), result.err);
    assert.match(result.err, /unknown argument/);
  }
});

test('N3: a git failure while checking the target is a refusal (exit 2), not a raw error', async () => {
  const s = scenario({ unborn: true });
  writeFileSync(join(s.target, '.git', 'index'), 'garbage-not-an-index');
  const result = await s.run();
  assert.equal(result.code, 2, result.err);
  assert.doesNotMatch(result.err, /Command failed/);
  assert.match(result.err, /target/);
});

test('N4: the restore advice for an unborn target also empties the index, and following it leaves the target clean', async () => {
  const s = scenario({ unborn: true });
  writeFileSync(join(s.target, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(s.target, '.git', 'hooks', 'pre-commit'), 0o755);
  const result = await s.run();
  assert.equal(result.code, 1);
  const advice = `git -C ${s.target} rm -r --cached --quiet --ignore-unmatch .`;
  assert.ok(result.err.includes(advice), result.err);
  assert.ok(result.err.indexOf(advice) < result.err.indexOf('README.md'), 'the index command comes before the file list');
  assert.notEqual(git(s.target, 'status', '--porcelain'), '');
  execFileSync('git', ['-C', s.target, 'rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.'], { env: gitEnv() });
  const listed = result.err.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim());
  assert.ok(listed.includes('README.md'));
  for (const path of listed) rmSync(join(s.target, path), { force: true });
  assert.equal(git(s.target, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('N5: an unsafe target is refused (exit 2) before the content check, even when the export would have a hit', async () => {
  const s = scenario({ privOver: { 'src/note.txt': 'the globex plan\n' } });
  writeFileSync(join(s.target, 'old.txt'), 'edited\n');
  const result = await s.run();
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /uncommitted/);
  assert.doesNotMatch(result.err, /content check/);
});

test('N5: the content check runs before the staged tests: a hit reports the check failure and the tests never run', async () => {
  const s = scenario({ privOver: { 'src/note.txt': 'the globex plan\n' } });
  const marker = join(tmp('marker'), 'ran');
  hookTest(s.priv, `writeFileSync(${JSON.stringify(marker)}, 'ran');\n  assert.equal(1, 2);`);
  const result = await s.run();
  assert.equal(result.code, 1);
  assert.match(result.err, /content check failed/);
  assert.doesNotMatch(result.err, /staged tests failed/);
  assert.equal(existsSync(marker), false, 'the staged tests never ran');
});

// The manifest key `allowLegacy` switches the old-name check on: the CLI then looks for the old brand name and the bare name of
// the private repository (here `tools`, from acme/tools). Without the key the export behaves as before.
const legacyFiles = { 'src/old.txt': `the ${LEGACY} name\n`, 'src/name.txt': 'the tools dir\n' };

test('a manifest without allowLegacy behaves as before', async () => {
  const s = scenario({ privOver: legacyFiles });
  const result = await s.run(s.args('--dry-run'));
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^tests: tests 1, pass 1, fail 0, skipped 0$/m);
});

test('a manifest with allowLegacy turns the old-name check on, even when the list is empty', async () => {
  const s = scenario({ privOver: { ...legacyFiles, 'public-export.json': JSON.stringify({ ...FIXTURE_MANIFEST, allowLegacy: [] }) } });
  const before = snapshot(s.target);
  const result = await s.run(s.args('--dry-run'));
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /^content check failed: 2 hit\(s\)$/m);
  assert.match(result.err, /^src\/name\.txt:1 old-name$/m);
  assert.match(result.err, /^src\/old\.txt:1 old-name$/m);
  assert.ok(!result.err.toLowerCase().includes(LEGACY) && !result.out.toLowerCase().includes(LEGACY), 'the old name is never printed');
  assert.deepEqual(snapshot(s.target), before);
  // An entry for each path lets the export through. Each `contains` overlaps the match without holding the whole term, since
  // the manifest is exported and checked too.
  const allowLegacy = [{ path: 'src/old.txt', contains: `the ${LEGACY.slice(0, 4)}` }, { path: 'src/name.txt', contains: 'the too' }];
  const allowed = scenario({ privOver: { ...legacyFiles, 'public-export.json': JSON.stringify({ ...FIXTURE_MANIFEST, allowLegacy }) } });
  const done = await allowed.run(allowed.args('--dry-run'));
  assert.equal(done.code, 0, done.err);
});

// Whatever the origin is, the repository name of BRAND.source is an old-name term once the key is present: a machine whose
// origin still carries the legacy name must not export a tree that names the private repository. With origin = BRAND.source
// the slug is rewritten to the public one in staging first, so nothing is left to flag.
test('the repository name of BRAND.source is an old-name term when the origin still has the legacy name, and the slug rewrite clears it', async () => {
  const withKey = JSON.stringify({ ...FIXTURE_MANIFEST, allowLegacy: [] });
  const tree = { 'public-export.json': withKey, 'src/ref.txt': `see https://github.com/${BRAND.source} for details\n` };
  const legacyOrigin = scenario({ privOver: tree, privOrigin: `git${AT}github.com:acme/${LEGACY}.git` });
  const before = snapshot(legacyOrigin.target);
  const refused = await legacyOrigin.run(legacyOrigin.args('--dry-run'));
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.err, /^src\/ref\.txt:1 old-name$/m);
  assert.deepEqual(snapshot(legacyOrigin.target), before);

  const current = scenario({ privOver: tree, privOrigin: `git${AT}github.com:${BRAND.source}.git` });
  const done = await current.run(current.args('--dry-run'));
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^rewrites: [1-9]\d*$/m);
});

test('the CLI exits 2 on an allowLegacy contains shorter than MIN_ALLOW_CONTAINS', async () => {
  const s = scenario({ privOver: { 'public-export.json': JSON.stringify({ ...FIXTURE_MANIFEST, allowLegacy: [{ path: 'src/lib.txt', contains: 'lib' }] }) } });
  await assertRefused(s, s.args('--dry-run'), /^error: public-export\.json: allowLegacy\[0\]\.contains must be at least 6 characters$/m);
});

test('the run prints the derived private slug', async () => {
  const s = scenario();
  const result = await s.run(s.args('--dry-run'));
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^private slug: acme\/tools \(from origin\)$/m);
  assert.ok(result.out.indexOf('private slug:') < result.out.indexOf('author:'), 'printed before the checks');
});
