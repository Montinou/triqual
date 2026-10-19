// tier-check (design U4): raises a task's tier from its actual diff, never lowers it.
// Every test builds a temp git repo, commits a base, commits a change and runs the script on BASE..HEAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PLUGIN, 'skills', 'executing-plans', 'scripts', 'tier-check');

const PLAN = `# Demo Implementation Plan

**Sensitive paths:** \`src/payments/**\`, config/secrets.*

## Global Constraints

- Nothing.

### Task 1: Light one

**Tier:** light

- [ ] **Step 1:** do one.

### Task 2: Heavy one

**Tier:** heavy

- [ ] **Step 1:** do two.

### Task 3: Tierless one

- [ ] **Step 1:** do three.

### Task 4: Standard one

**Tier:** standard

- [ ] **Step 1:** do four.
`;

const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

// The temp repos ignore the machine's git config (a global ignore file or hooks path would swallow some fixtures).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: '/nonexistent' };

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A temp repo with a plan file outside the tree and `base` committed.
function makeRepo(base) {
  const dir = mkdtempSync(join(tmpdir(), 'tier-check-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const planDir = mkdtempSync(join(tmpdir(), 'tier-check-plan-'));
  const plan = join(planDir, 'demo-plan.md');
  writeFileSync(plan, PLAN);
  const put = (files) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) { git(dir, 'rm', '-q', '-f', path); continue; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  put(base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  // change(files, renames): write/delete `files`, apply `renames` ([from, to] via git mv) first.
  const change = (files = {}, renames = []) => {
    for (const [from, to] of renames) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      git(dir, 'mv', from, to);
    }
    put(files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }); rmSync(planDir, { recursive: true, force: true }); };
  return { dir, plan, baseSha, change, cleanup };
}

function run(repo, n, head, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, repo.plan, String(n), repo.baseSha, head, ...extra], {
    cwd: repo.dir, encoding: 'utf8', env: GIT_ENV,
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// Like run(), with extra environment for the script only (the fixtures above keep the real temp dir).
function runWithEnv(repo, env, n, head, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, repo.plan, String(n), repo.baseSha, head, ...extra], {
    cwd: repo.dir, encoding: 'utf8', env: { ...GIT_ENV, ...env },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// Runs one scenario and cleans up.
function scenario(base, files, renames, fn) {
  const repo = makeRepo(base);
  try {
    const head = repo.change(files, renames);
    fn(repo, head);
  } finally {
    repo.cleanup();
  }
}

const RAISE = (from, to, path) => new RegExp(`^raise ${from} ${to}: .+: .*${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);

test('script is executable with a node shebang', () => {
  assert.ok(statSync(SCRIPT).mode & 0o100, 'owner execute bit');
});

test('a docs-only change stays light', () => {
  scenario({ 'README.md': lines(5), 'docs/guide.md': lines(5) }, { 'README.md': lines(9), 'docs/guide.md': lines(2) }, [], (repo, head) => {
    assert.deepEqual(run(repo, 1, head), { status: 0, out: 'ok light', err: '' });
  });
});

test('a SKILL.md under plugins/x/skills/ raises light to standard', () => {
  const path = 'plugins/x/skills/y/SKILL.md';
  scenario({ [path]: lines(3) }, { [path]: lines(4) }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.equal(r.status, 0);
    assert.match(r.out, RAISE('light', 'standard', path));
  });
});

test('other excluded Markdown classes raise light to standard', () => {
  for (const path of [
    'plugins/x/agents/a.md', 'plugins/x/rules/r.md', 'plugins/x/commands/c.md', 'docs/templates/t.md',
    'docs/review-prompt.md', 'CLAUDE.md', 'sub/CLAUDE-notes.md', 'AGENTS.md', 'sub/AGENTS.override.md',
  ]) {
    scenario({ [path]: lines(3) }, { [path]: lines(4) }, [], (repo, head) => {
      assert.match(run(repo, 1, head).out, RAISE('light', 'standard', path), path);
    });
  }
});

test('a Markdown file renamed into an excluded class raises', () => {
  scenario({ 'docs/a.md': lines(5) }, {}, [['docs/a.md', 'plugins/x/skills/a.md']], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'plugins/x/skills/a.md'));
  });
});

test('a 15-line .mjs fix plus its cases in an existing test file stays light; 25 lines raises', () => {
  const base = { 'src/a.mjs': lines(30), 'test/a.test.mjs': lines(30) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(10, 'fix'), 'test/a.test.mjs': lines(30) + lines(5, 'case') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario(base, { 'src/a.mjs': lines(30) + lines(15, 'fix'), 'test/a.test.mjs': lines(30) + lines(10, 'case') }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/a.mjs'));
    assert.match(r.out, /25/);
  });
});

test('--fix-round: code added in a fix round raises a light task, whatever its size; without the flag it stays light', () => {
  const base = { 'src/a.mjs': lines(30), 'docs/a.md': lines(5) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(4, 'fn') }, [], (repo, head) => {
    const flagged = run(repo, 1, head, '--fix-round');
    assert.match(flagged.out, /^raise light standard: fix round adds code: src\/a\.mjs$/);
    assert.equal(flagged.status, 0);
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario(base, { 'docs/a.md': lines(5) + lines(6, 'doc') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head, '--fix-round').out, 'ok light');
  });
});

test('--fix-round leaves other floors and heavy triggers alone, and rides along with --floor', () => {
  const base = { 'src/a.mjs': lines(30) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(4, 'fn') }, [], (repo, head) => {
    assert.equal(run(repo, 4, head, '--fix-round').out, 'ok standard');
    assert.equal(run(repo, 3, head, '--fix-round').out, 'ok standard'); // tierless, no --floor: floors at standard
    assert.match(run(repo, 3, head, '--fix-round', '--floor', 'light').out, RAISE('light', 'standard', 'src/a.mjs'));
    assert.equal(run(repo, 2, head, '--fix-round').out, 'ok heavy');
  });
  scenario(base, { 'src/hooks/x.mjs': lines(2) }, [], (repo, head) => {
    assert.match(run(repo, 1, head, '--fix-round').out, RAISE('light', 'heavy', 'src/hooks/x.mjs'));
  });
});

test('the light code allowance counts added plus removed lines, up to 20 inclusive', () => {
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30).replace(/^line 1\n/, '').replace(/^line 2\n/m, '') + lines(8, 'new') }, [], (repo, head) => {
    // 2 removed + 8 added = 10
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(20, 'new') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(21, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30).split('\n').slice(10).join('\n') + lines(11, 'new') }, [], (repo, head) => {
    // 10 removed + 11 added = 21
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
});

test('a new test file raises even when tiny', () => {
  scenario({ 'src/a.mjs': lines(3) }, { 'test/new.test.mjs': 'x\n' }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'test/new.test.mjs'));
    assert.match(r.out, /creat/);
  });
});

test('a lockfile change raises, whatever its size', () => {
  for (const path of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'sub/Cargo.lock']) {
    scenario({ [path]: '{"version": 1}\n' }, { [path]: '{"version": 2}\n' }, [], (repo, head) => {
      assert.match(run(repo, 1, head).out, RAISE('light', 'standard', path), path);
    });
  }
});

test('a pure rename of a .mjs stays light; a rename with edits counts its lines', () => {
  scenario({ 'src/a.mjs': lines(40) }, {}, [['src/a.mjs', 'src/b.mjs']], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(40) }, { 'src/b.mjs': lines(40) + lines(25, 'new') }, [['src/a.mjs', 'src/b.mjs']], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/b.mjs'));
    assert.match(r.out, /25 code lines/); // the edits are counted, not the rename
  });
});

test('a rename into hooks/ raises to heavy; a rename out of hooks/ does too', () => {
  scenario({ 'src/a.mjs': lines(40) }, {}, [['src/a.mjs', 'plugins/x/hooks/a.mjs']], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'plugins/x/hooks/a.mjs'));
  });
  scenario({ 'plugins/x/hooks/a.mjs': lines(40) }, {}, [['plugins/x/hooks/a.mjs', 'src/a.mjs']], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'plugins/x/hooks/a.mjs'));
  });
});

test('more than 300 changed lines raises to heavy; exactly 300 does not', () => {
  scenario({ 'docs/a.md': '' }, { 'docs/a.md': lines(301) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'docs/a.md'));
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'docs/a.md'));
  });
  scenario({ 'docs/a.md': '' }, { 'docs/a.md': lines(300) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
    assert.equal(run(repo, 4, head).out, 'ok standard');
  });
  // added + removed: 160 removed + 141 added = 301
  scenario({ 'docs/a.md': lines(160, 'old') }, { 'docs/a.md': lines(141, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'docs/a.md'));
  });
});

test('the default sensitive paths raise to heavy', () => {
  for (const path of [
    'plugins/x/hooks/hooks.json', 'hooks/a.mjs', 'app/setup/init.mjs', 'setup/a.mjs', 'src/db/schema.ts', 'src/user-schema.sql',
    'db/migrations/001.sql', 'drizzle/0001.sql', '.github/workflows/ci.yml', 'plugins/workflow-gate/scripts/gate.mjs',
  ]) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: 'x\n' }, [], (repo, head) => {
      assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', path), path);
    });
  }
});

test('a near-miss of a sensitive path does not raise', () => {
  for (const path of ['src/hooksy/a.mjs', 'src/github/a.mjs', 'src/setups.mjs', 'plugins/workflow-gates/a.mjs']) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: 'x\n' }, [], (repo, head) => {
      assert.equal(run(repo, 4, head).out, 'ok standard', path);
    });
  }
});

test("a plan's **Sensitive paths:** raise to heavy", () => {
  for (const path of ['src/payments/charge.mjs', 'src/payments/deep/er/x.mjs', 'config/secrets.json']) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: 'x\n' }, [], (repo, head) => {
      assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', path), path);
    });
  }
  scenario({ 'keep.txt': 'k\n' }, { 'src/other/x.mjs': 'x\n' }, [], (repo, head) => {
    assert.equal(run(repo, 4, head).out, 'ok standard');
  });
});

test('--floor raises the starting tier: --floor heavy on a docs diff prints ok heavy', () => {
  scenario({ 'docs/a.md': lines(3) }, { 'docs/a.md': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head, '--floor', 'heavy').out, 'ok heavy');
    assert.equal(run(repo, 1, head, '--floor', 'standard').out, 'ok standard');
    assert.equal(run(repo, 1, head, '--floor', 'light').out, 'ok light');
  });
});

test('--floor standard is raised to heavy by a sensitive path and never lowered by light rules', () => {
  scenario({ 'keep.txt': 'k\n' }, { 'plugins/x/hooks/h.mjs': 'x\n' }, [], (repo, head) => {
    assert.match(run(repo, 1, head, '--floor', 'standard').out, RAISE('standard', 'heavy', 'plugins/x/hooks/h.mjs'));
  });
  scenario({ 'src/a.mjs': lines(3) }, { 'src/a.mjs': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head, '--floor', 'standard').out, 'ok standard');
  });
});

test('a tierless task floors at standard', () => {
  scenario({ 'docs/a.md': lines(3) }, { 'docs/a.md': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 3, head).out, 'ok standard');
  });
  scenario({ 'keep.txt': 'k\n' }, { '.github/ci.yml': 'x\n' }, [], (repo, head) => {
    assert.match(run(repo, 3, head).out, RAISE('standard', 'heavy', '.github/ci.yml'));
  });
});

test('output never names a tier below the declared tier or the floor', () => {
  scenario({ 'docs/a.md': lines(3) }, { 'docs/a.md': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 2, head).out, 'ok heavy');
    assert.equal(run(repo, 2, head, '--floor', 'light').out, 'ok heavy');
    assert.equal(run(repo, 4, head, '--floor', 'light').out, 'ok standard');
    assert.equal(run(repo, 3, head, '--floor', 'light').out, 'ok light'); // tierless: --floor is the floor
  });
});

test('a version-only JSON change is a light class; any other key makes it code', () => {
  const pkg = (version, extra = {}) => JSON.stringify({ name: 'x', version, dependencies: { a: '1' }, ...extra }, null, 2) + '\n';
  // 20 code lines already use the whole allowance; the version bump must not count against it.
  scenario({ 'package.json': pkg('1.0.0'), 'src/a.mjs': lines(30) }, { 'package.json': pkg('1.0.1'), 'src/a.mjs': lines(30) + lines(20, 'new') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'package.json': pkg('1.0.0') }, { 'package.json': pkg('1.0.1') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  // version plus another key changed: it is code, counted by lines (2 + 4 here), so with 20 more code lines it raises
  scenario({ 'package.json': pkg('1.0.0'), 'src/a.mjs': lines(30) }, { 'package.json': pkg('1.0.1', { dependencies: { a: '2', b: '3' } }), 'src/a.mjs': lines(30) + lines(20, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
});

test('a binary change raises to standard', () => {
  const bin = (b) => Buffer.from([0, 1, 2, b, 0, 0, 255]);
  scenario({ 'img/a.png': bin(1) }, { 'img/a.png': bin(9) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'img/a.png'));
  });
});

test('a deleted file counts its removed lines', () => {
  scenario({ 'src/a.mjs': lines(25) }, { 'src/a.mjs': null }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
  scenario({ 'src/a.mjs': lines(5) }, { 'src/a.mjs': null }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('paths with spaces and non-ASCII characters are handled', () => {
  scenario({ 'docs/my notes é.md': lines(2) }, { 'docs/my notes é.md': lines(3) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'keep.txt': 'k\n' }, { 'a b/hooks/x y.mjs': 'x\n' }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, /^raise light heavy: .+: a b\/hooks\/x y\.mjs$/);
  });
});

test('an empty diff keeps the floor', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    assert.equal(run(repo, 1, repo.baseSha).out, 'ok light');
  } finally {
    repo.cleanup();
  }
});

test('the task may be named 3 or T3', () => {
  scenario({ 'docs/a.md': lines(3) }, { 'docs/a.md': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 'T1', head).out, 'ok light');
  });
});

test('bad input exits 2: unknown task, bad range, bad floor, bad plan, usage', () => {
  scenario({ 'docs/a.md': lines(3) }, { 'docs/a.md': lines(4) }, [], (repo, head) => {
    assert.equal(run(repo, 9, head).status, 2);
    assert.equal(run(repo, 'x', head).status, 2);
    assert.equal(run(repo, 1, 'no-such-ref').status, 2);
    assert.equal(run(repo, 1, head, '--floor', 'urgent').status, 2);
    assert.equal(run(repo, 1, head, '--floor').status, 2);
    assert.equal(run(repo, 1, head, '--bogus').status, 2);
    // HEAD is not a descendant of BASE: the arguments swapped
    const swapped = spawnSync(process.execPath, [SCRIPT, repo.plan, '1', head, repo.baseSha], { cwd: repo.dir, encoding: 'utf8', env: GIT_ENV });
    assert.equal(swapped.status, 2);
    const noPlan = spawnSync(process.execPath, [SCRIPT, join(repo.dir, 'missing.md'), '1', repo.baseSha, head], { cwd: repo.dir, encoding: 'utf8', env: GIT_ENV });
    assert.equal(noPlan.status, 2);
    const usage = spawnSync(process.execPath, [SCRIPT, repo.plan], { cwd: repo.dir, encoding: 'utf8', env: GIT_ENV });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage/);
  });
});

// ---- fix round 1 ----

test('upper-case Markdown names do not escape the excluded classes', () => {
  for (const path of ['docs/CLAUDE.MD', 'AGENTS.MD', 'plugins/x/skills/y/SKILL.MD']) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: lines(3) }, [], (repo, head) => {
      assert.match(run(repo, 1, head).out, RAISE('light', 'standard', path), path);
    });
  }
});

test('a path with a newline still matches a sensitive glob', () => {
  const path = 'src/hooks/a\nb.mjs';
  scenario({ 'keep.txt': 'k\n' }, { [path]: 'x\n' }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, /^raise light heavy: sensitive path: /);
  });
});

test('a JSON key reorder is code, even with a version bump; a reformat without a version change is not version-only', () => {
  const exportsA = { '.': { import: './a.mjs', require: './a.cjs' } };
  const exportsB = { '.': { require: './a.cjs', import: './a.mjs' } };
  const pkg = (version, exports) => JSON.stringify({ name: 'x', version, exports }, null, 2) + '\n';
  // the reorder is 2 + 2 lines of code; with 20 more code lines it is over the allowance
  scenario({ 'package.json': pkg('1.0.0', exportsA), 'src/a.mjs': lines(30) }, { 'package.json': pkg('1.0.1', exportsB), 'src/a.mjs': lines(30) + lines(20, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
  // a whitespace-only reformat (no version change) over 20 lines is code, not a version bump
  const wide = { name: 'x', version: '1.0.0', list: Array.from({ length: 12 }, (_, i) => `v${i}`) };
  scenario({ 'package.json': JSON.stringify(wide, null, 2) + '\n' }, { 'package.json': JSON.stringify(wide, null, 4) + '\n' }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'package.json'));
  });
});

test('files git treats as binary through .git/info/attributes still count their lines toward heavy', () => {
  const repo = makeRepo({ 'src/a.mjs': lines(5) });
  try {
    writeFileSync(join(repo.dir, '.git', 'info', 'attributes'), '*.mjs -diff\n');
    const head = repo.change({ 'src/a.mjs': lines(301, 'new') });
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'src/a.mjs'));
  } finally {
    repo.cleanup();
  }
});

// ---- fix round 2 ----

// The only seam that breaks the line count and nothing else: the script counts a binary change in a temp dir, and
// TMPDIR points at a directory that does not exist, so the count cannot be obtained.
test('a binary change whose lines cannot be counted fails strict: raise to heavy, naming the path', () => {
  const missingTmp = join(tmpdir(), 'tier-check-no-such-dir', 'x');
  const bin = (b) => Buffer.from([0, 1, 2, b, 0, 0, 255]);
  const forced = makeRepo({ 'src/a.mjs': lines(5) });
  try {
    writeFileSync(join(forced.dir, '.git', 'info', 'attributes'), '*.mjs -diff\n');
    const head = forced.change({ 'src/a.mjs': lines(6, 'new') });
    assert.equal(run(forced, 4, head).out, 'ok standard'); // countable: small, stays below heavy
    const r = runWithEnv(forced, { TMPDIR: missingTmp }, 4, head);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^raise standard heavy: uncountable binary diff: src\/a\.mjs$/);
  } finally {
    forced.cleanup();
  }
  scenario({ 'img/a.png': bin(1) }, { 'img/a.png': bin(9) }, [], (repo, head) => {
    const r = runWithEnv(repo, { TMPDIR: missingTmp }, 1, head);
    assert.match(r.out, /^raise light heavy: uncountable binary diff: img\/a\.png$/);
  });
});

// ---- fix round 3 ----

test('a code file with a NUL byte counts its newlines toward heavy; known media types do not', () => {
  const withNul = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text)]);
  scenario({ 'src/a.mjs': withNul(lines(5)) }, { 'src/a.mjs': withNul(lines(301, 'new')) }, [], (repo, head) => {
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'src/a.mjs'));
  });
  // the over-count stays under the limit for a small NUL-bearing change: it only raises to standard
  scenario({ 'src/a.mjs': withNul(lines(5)) }, { 'src/a.mjs': withNul(lines(6, 'new')) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, /^raise light standard: binary change: src\/a\.mjs$/);
  });
  // a media file keeps 0 lines whatever its bytes, in any letter case
  for (const path of ['img/a.png', 'img/B.PNG', 'doc/c.Pdf', 'fonts/d.woff2', 'pack/e.zip']) {
    scenario({ [path]: withNul(lines(5)) }, { [path]: withNul(lines(400, 'new')) }, [], (repo, head) => {
      assert.match(run(repo, 1, head).out, new RegExp(`^raise light standard: binary change: ${path.replace('.', '\\.')}$`), path);
    });
  }
});

test('a created or deleted binary file is countable: the missing side is empty, not a failure', () => {
  const bin = Buffer.from([0, 1, 2, 3, 0, 0, 255]);
  scenario({ 'keep.txt': 'k\n' }, { 'img/a.png': bin }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, /^raise light standard: binary change: img\/a\.png$/);
  });
  scenario({ 'img/a.png': bin }, { 'img/a.png': null }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, /^raise light standard: binary change: img\/a\.png$/);
  });
});
