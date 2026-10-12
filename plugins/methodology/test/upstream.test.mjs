import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PLUGIN, '..', '..');
const UPSTREAM_JSON = 'plugins/methodology/upstream.json';
const SKILLS = 'plugins/methodology/skills';

// The vendor history lives only in the private checkout (its repository root carries .githooks/pre-commit); an exported
// tree has no such history, so every case here is skipped there.
const isPrivateCheckout = existsSync(join(REPO, '.githooks', 'pre-commit'));
const test = (name, fn) => nodeTest(name, { skip: !isPrivateCheckout && 'needs the private checkout (vendor history)' }, fn);

// Every git call runs without GIT_* (a git hook exports GIT_DIR, GIT_INDEX_FILE, …) and without XDG_CONFIG_HOME.
const gitEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return env;
};
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: REPO, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, ...opts });
const gitText = (args) => git(args, { encoding: 'utf8' });
const lines = (text) => text.split('\n').filter(Boolean);

const upstream = () => JSON.parse(readFileSync(join(PLUGIN, 'upstream.json'), 'utf8'));

// The vendor commit is the one that added upstream.json (not found by subject).
const vendorCommit = (repo = REPO) => {
  // In a shallow clone the boundary commit reads as adding every file, which would surface as a sha mismatch.
  const text = (args) => git(args, { cwd: repo, encoding: 'utf8' });
  if (text(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    assert.fail('vendor commit needs full history (git fetch --unshallow)');
  }
  const found = lines(text(['log', '--diff-filter=A', '--format=%H', '--', UPSTREAM_JSON]));
  assert.equal(found.length, 1, `expected one commit adding ${UPSTREAM_JSON}, got ${found.length}`);
  return found[0];
};

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (const p of [...pa, ...pb]) assert.ok(Number.isInteger(p), `not a numeric version: ${a} / ${b}`);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

test("upstream.json's vendored part lists every vendored file with its sha256 at the vendor commit", () => {
  const vendor = vendorCommit();
  const { files } = upstream().vendored;
  const inTree = lines(gitText(['ls-tree', '-r', '--name-only', vendor, `${SKILLS}/`]))
    .map((p) => p.slice(SKILLS.length + 1))
    .sort();
  assert.deepEqual(Object.keys(files).sort(), inTree);
  // One `git cat-file --batch` for every `<vendor>:<path>` (the same bytes `git show` prints), not 74 spawns.
  const paths = Object.keys(files);
  const out = git(['cat-file', '--batch'], {
    input: paths.map((path) => `${vendor}:${SKILLS}/${path}\n`).join(''),
  });
  let at = 0;
  for (const path of paths) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString('utf8');
    const m = /^[0-9a-f]{40} blob (\d+)$/.exec(header);
    assert.ok(m, `no blob for ${path}: ${header}`);
    const blob = out.subarray(nl + 1, nl + 1 + Number(m[1]));
    at = nl + 1 + Number(m[1]) + 1;
    assert.equal(createHash('sha256').update(blob).digest('hex'), files[path], `sha256 mismatch: ${path}`);
  }
  assert.equal(at, out.length);
});

test('upstream.json has vendored and reviewed, and reviewed is not older than vendored', () => {
  const doc = upstream();
  assert.equal(doc.source, 'https://github.com/obra/superpowers');
  assert.ok(doc.vendored && typeof doc.vendored === 'object', 'missing vendored');
  assert.ok(doc.reviewed && typeof doc.reviewed === 'object', 'missing reviewed');
  assert.equal(doc.vendored.version, '6.4.2');
  assert.equal(doc.vendored.tag, 'v6.4.2');
  assert.match(doc.reviewed.commit, /^[0-9a-f]{40}$/);
  assert.ok(compareVersions(doc.reviewed.version, doc.vendored.version) >= 0,
    `reviewed ${doc.reviewed.version} is older than vendored ${doc.vendored.version}`);
  assert.match(doc.reviewed.reviewedAt, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/);
  assert.ok(!Number.isNaN(Date.parse(doc.reviewed.reviewedAt)), `not a date: ${doc.reviewed.reviewedAt}`);
});

test('the vendor commit holds 15 skill directories and 74 files', () => {
  const vendor = vendorCommit();
  const dirs = lines(gitText(['ls-tree', '-d', '--name-only', vendor, `${SKILLS}/`]));
  const files = lines(gitText(['ls-tree', '-r', '--name-only', vendor, `${SKILLS}/`]));
  assert.equal(dirs.length, 15);
  assert.equal(files.length, 74);
});

test('the nine upstream executables keep mode 100755', () => {
  const vendor = vendorCommit();
  const executables = [
    'brainstorming/scripts/start-server.sh',
    'brainstorming/scripts/stop-server.sh',
    'executing-plans/scripts/task-start',
    'executing-plans/scripts/task-done',
    'subagent-driven-development/scripts/review-package',
    'subagent-driven-development/scripts/sdd-workspace',
    'subagent-driven-development/scripts/task-brief',
    'systematic-debugging/find-polluter.sh',
    'writing-skills/render-graphs.js',
  ];
  const modes = new Map(
    lines(gitText(['ls-tree', '-r', vendor, `${SKILLS}/`])).map((line) => {
      const [meta, path] = line.split('\t');
      return [path.slice(SKILLS.length + 1), meta.split(' ')[0]];
    }),
  );
  for (const path of executables) assert.equal(modes.get(path), '100755', `mode of ${path}`);
  const allExecutable = [...modes].filter(([, mode]) => mode === '100755').map(([path]) => path);
  assert.deepEqual(allExecutable.sort(), [...executables].sort());
});

test('upstream.json records the peeled commit', () => {
  const { vendored } = upstream();
  assert.match(vendored.commit, /^[0-9a-f]{40}$/);
  assert.ok(vendored.commit.startsWith('8ca22db'), `vendored.commit ${vendored.commit} is not the peeled commit`);
});

test('a shallow clone fails with the unshallow message instead of a sha mismatch', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'upstream-shallow-'));
  const run = (cwd, args) =>
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' });
  try {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'plugins', 'methodology'), { recursive: true });
    run(tmp, ['init', '-q', src]);
    writeFileSync(join(src, UPSTREAM_JSON), '{}\n');
    run(src, ['add', '-A']);
    run(src, ['commit', '-q', '-m', 'vendor']);
    writeFileSync(join(src, 'later.txt'), 'later\n');
    run(src, ['add', '-A']);
    run(src, ['commit', '-q', '-m', 'later']);
    const clone = join(tmp, 'clone');
    run(tmp, ['clone', '-q', '--depth', '1', `file://${src}`, clone]);
    assert.throws(() => vendorCommit(clone), {
      message: /vendor commit needs full history \(git fetch --unshallow\)/,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('git calls ignore GIT_* from the environment (a hook run must not redirect them)', () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(tmpdir(), 'no-such-git-dir');
  process.env.GIT_WORK_TREE = tmpdir();
  try {
    assert.match(vendorCommit(), /^[0-9a-f]{40}$/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
