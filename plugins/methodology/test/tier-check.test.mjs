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

test('a .mjs fix plus its cases in an existing test file stays light; its test lines never count', () => {
  const base = { 'src/a.mjs': lines(30), 'test/a.test.mjs': lines(30) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(10, 'fix'), 'test/a.test.mjs': lines(30) + lines(5, 'case') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  // 300 src lines use the whole allowance; 200 more lines of test cases do not push it over
  scenario(base, { 'src/a.mjs': lines(30) + lines(300, 'fix'), 'test/a.test.mjs': lines(30) + lines(200, 'case') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario(base, { 'src/a.mjs': lines(30) + lines(301, 'fix'), 'test/a.test.mjs': lines(30) + lines(10, 'case') }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/a.mjs'));
    assert.match(r.out, /301 code lines \(over 300\)/);
  });
});

test('--fix-round applies the same rules: a small code fix stays light, one over the allowance raises', () => {
  const base = { 'src/a.mjs': lines(30), 'docs/a.md': lines(5) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(40, 'fn') }, [], (repo, head) => {
    assert.deepEqual(run(repo, 1, head, '--fix-round'), { status: 0, out: 'ok light', err: '' });
  });
  scenario(base, { 'src/a.mjs': lines(30) + lines(301, 'fn') }, [], (repo, head) => {
    assert.match(run(repo, 1, head, '--fix-round').out, RAISE('light', 'standard', 'src/a.mjs'));
  });
});

test('--fix-round leaves other floors and heavy triggers alone, and rides along with --floor', () => {
  const base = { 'src/a.mjs': lines(30) };
  scenario(base, { 'src/a.mjs': lines(30) + lines(4, 'fn') }, [], (repo, head) => {
    assert.equal(run(repo, 4, head, '--fix-round').out, 'ok standard');
    assert.equal(run(repo, 3, head, '--fix-round').out, 'ok standard'); // tierless, no --floor: floors at standard
    assert.equal(run(repo, 3, head, '--fix-round', '--floor', 'light').out, 'ok light');
    assert.equal(run(repo, 2, head, '--fix-round').out, 'ok heavy');
  });
  scenario(base, { 'src/hooks/x.mjs': lines(2) }, [], (repo, head) => {
    assert.match(run(repo, 1, head, '--fix-round').out, RAISE('light', 'heavy', 'src/hooks/x.mjs'));
  });
});

test('the light code allowance counts added plus removed lines, up to 300 inclusive', () => {
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(300, 'new') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(301, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30).split('\n').slice(10).join('\n') + lines(291, 'new') }, [], (repo, head) => {
    // 10 removed + 291 added = 301
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
  });
});

test('a new src file within the allowance stays light', () => {
  scenario({ 'src/a.mjs': lines(3) }, { 'src/new.mjs': lines(120) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('a lockfile change never raises and never counts, whatever its size', () => {
  for (const path of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'sub/Cargo.lock']) {
    scenario({ [path]: lines(5) }, { [path]: lines(1500, 'dep') }, [], (repo, head) => {
      assert.equal(run(repo, 1, head).out, 'ok light', path);
      assert.equal(run(repo, 4, head).out, 'ok standard', path);
    });
  }
});

test('a pure rename of a .mjs stays light; a rename with edits counts its lines', () => {
  scenario({ 'src/a.mjs': lines(40) }, {}, [['src/a.mjs', 'src/b.mjs']], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(400) }, { 'src/b.mjs': lines(400) + lines(325, 'new') }, [['src/a.mjs', 'src/b.mjs']], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/b.mjs'));
    assert.match(r.out, /325 code lines/); // the edits are counted, not the rename
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

test('more than 1000 code lines raises to heavy; exactly 1000 does not', () => {
  scenario({ 'src/a.mjs': '' }, { 'src/a.mjs': lines(1001) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'src/a.mjs'));
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
  });
  scenario({ 'src/a.mjs': '' }, { 'src/a.mjs': lines(1000) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'standard', 'src/a.mjs'));
    assert.equal(run(repo, 4, head).out, 'ok standard');
  });
  // added + removed: 520 removed + 481 added = 1001
  scenario({ 'src/a.mjs': lines(520, 'old') }, { 'src/a.mjs': lines(481, 'new') }, [], (repo, head) => {
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
  });
});

test('docs, data files and lockfiles never count toward the heavy limit or the light allowance', () => {
  for (const path of ['docs/a.md', 'CHANGELOG.md', 'data/frames.json', 'data/rows.jsonl', 'data/t.csv', 'data/t.tsv', 'notes/a.txt']) {
    scenario({ [path]: '' }, { [path]: lines(3000) }, [], (repo, head) => {
      assert.equal(run(repo, 1, head).out, 'ok light', path);
      assert.equal(run(repo, 4, head).out, 'ok standard', path);
    });
  }
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

test('a JSON change is data: it never counts, version bump or not', () => {
  const pkg = (version, extra = {}) => JSON.stringify({ name: 'x', version, dependencies: { a: '1' }, ...extra }, null, 2) + '\n';
  scenario({ 'package.json': pkg('1.0.0'), 'src/a.mjs': lines(30) }, { 'package.json': pkg('1.0.1', { dependencies: { a: '2', b: '3' } }), 'src/a.mjs': lines(30) + lines(300, 'new') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('a media file change never raises', () => {
  const bin = (b) => Buffer.from([0, 1, 2, b, 0, 0, 255]);
  scenario({ 'img/a.png': bin(1) }, { 'img/a.png': bin(9) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('a deleted file counts its removed lines', () => {
  scenario({ 'src/a.mjs': lines(325) }, { 'src/a.mjs': null }, [], (repo, head) => {
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


test('files git treats as binary through .git/info/attributes still count their lines toward heavy', () => {
  const repo = makeRepo({ 'src/a.mjs': lines(5) });
  try {
    writeFileSync(join(repo.dir, '.git', 'info', 'attributes'), '*.mjs -diff\n');
    const head = repo.change({ 'src/a.mjs': lines(1001, 'new') });
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', 'src/a.mjs'));
  } finally {
    repo.cleanup();
  }
});

test('a binary code change whose lines cannot be counted fails strict: raise to heavy, naming the path', () => {
  const missingTmp = join(tmpdir(), 'tier-check-no-such-dir', 'x');
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
});

test('a code file with a NUL byte counts its newlines toward heavy; known media types do not', () => {
  const withNul = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text)]);
  scenario({ 'src/a.mjs': withNul(lines(5)) }, { 'src/a.mjs': withNul(lines(1001, 'new')) }, [], (repo, head) => {
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
  });
  scenario({ 'src/a.mjs': withNul(lines(5)) }, { 'src/a.mjs': withNul(lines(6, 'new')) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  for (const path of ['img/a.png', 'img/B.PNG', 'doc/c.Pdf', 'fonts/d.woff2', 'pack/e.zip']) {
    scenario({ [path]: withNul(lines(5)) }, { [path]: withNul(lines(4000, 'new')) }, [], (repo, head) => {
      assert.equal(run(repo, 1, head).out, 'ok light', path);
    });
  }
});

test('a created or deleted media file never raises', () => {
  const bin = Buffer.from([0, 1, 2, 3, 0, 0, 255]);
  scenario({ 'keep.txt': 'k\n' }, { 'img/a.png': bin }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'img/a.png': bin }, { 'img/a.png': null }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('test lines do not count toward the heavy limit', () => {
  scenario({ 'src/a.mjs': lines(5), 'test/a.test.mjs': '' }, { 'src/a.mjs': lines(15), 'test/a.test.mjs': lines(1400) }, [], (repo, head) => {
    assert.equal(run(repo, 4, head).out, 'ok standard');
  });
});

test('non-test code lines over 1000 still raise to heavy', () => {
  scenario({ 'src/a.mjs': '' }, { 'src/a.mjs': lines(1010) }, [], (repo, head) => {
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'src/a.mjs'));
  });
});

test('a new test file alone keeps a light task light', () => {
  scenario({ 'src/a.mjs': lines(3) }, { 'src/b.test.mjs': lines(30) }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
});

test('a new src file over the allowance raises light to standard', () => {
  scenario({ 'keep.txt': 'k\n' }, { 'src/new.mjs': lines(330) }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/new.mjs'));
    assert.match(r.out, /330 code lines \(over 300\)/);
  });
});

test('light allows 300 src lines, raises past it', () => {
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(200, 'new') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head).out, 'ok light');
  });
  scenario({ 'src/a.mjs': lines(30) }, { 'src/a.mjs': lines(30) + lines(320, 'new') }, [], (repo, head) => {
    const r = run(repo, 1, head);
    assert.match(r.out, RAISE('light', 'standard', 'src/a.mjs'));
    assert.match(r.out, /over 300/);
  });
});

test('a test file under a sensitive path raises to heavy', () => {
  const path = 'plugins/x/hooks/a.test.mjs';
  scenario({ 'keep.txt': 'k\n' }, { [path]: lines(5) }, [], (repo, head) => {
    assert.match(run(repo, 1, head).out, RAISE('light', 'heavy', path));
  });
});

test('a test-only fix round stays light, and so does a small code fix', () => {
  const base = { 'src/a.mjs': lines(30), 'test/a.test.mjs': lines(10) };
  scenario(base, { 'test/a.test.mjs': lines(10) + lines(8, 'case') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head, '--fix-round').out, 'ok light');
  });
  scenario(base, { 'test/a.test.mjs': lines(10) + lines(8, 'case'), 'src/a.mjs': lines(30) + lines(2, 'fn') }, [], (repo, head) => {
    assert.equal(run(repo, 1, head, '--fix-round').out, 'ok light');
  });
});

test("the plan's **Test paths:** line adds test globs", () => {
  const repo = makeRepo({ 'spec/a.js': '', 'src/a.mjs': lines(3) });
  try {
    writeFileSync(repo.plan, PLAN.replace('**Sensitive paths:**', '**Test paths:** `spec/**`\n\n**Sensitive paths:**'));
    const head = repo.change({ 'spec/a.js': lines(1400) });
    assert.equal(run(repo, 4, head).out, 'ok standard');
    // the same diff is heavy without the plan's line
    writeFileSync(repo.plan, PLAN);
    assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', 'spec/a.js'));
  } finally {
    repo.cleanup();
  }
});

test('the default test globs cover test dirs, .test./.spec. files, evals, fixtures and datasets, and no other path', () => {
  for (const path of [
    'test/a.mjs', 'pkg/tests/a.py', 'src/__tests__/a.js', 'src/a.test.ts', 'src/a.spec.js',
    'evals/delegation.eval.ts', 'evals/cases/r1.mjs', 'src/scoring.eval.mjs', 'test-data/fixtures/a.mjs', 'datasets/a.py',
  ]) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: lines(1400) }, [], (repo, head) => {
      assert.equal(run(repo, 4, head).out, 'ok standard', path);
      assert.equal(run(repo, 1, head).out, 'ok light', path);
    });
  }
  for (const path of ['src/contest/a.mjs', 'src/a.tests.mjs', 'src/latest.mjs', 'src/evaluate.mjs']) {
    scenario({ 'keep.txt': 'k\n' }, { [path]: lines(1400) }, [], (repo, head) => {
      assert.match(run(repo, 4, head).out, RAISE('standard', 'heavy', path), path);
    });
  }
});
