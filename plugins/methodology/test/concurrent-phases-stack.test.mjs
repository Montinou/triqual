// Two phases at once and their join, end to end: P1 and P2 are built side by side (P1 in the main checkout, P2 in its phase worktree), each
// with a task built in place and a task built in a task worktree, and P3 (`**Parent:** P1, P2`) starts at the commit that joins them.
// Every script is the real one, run from the main checkout, in a temp git repo (not opted in to tracking, local mode) with a temp HOME
// and a `triqual` wrapper on a private PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN = 'docs/plans/demo.md';

const phaseText = (n, name, parent, tasks) => `## Phase ${n}: ${name}

**Slice:** S${n}
**Parent:** ${parent}
**Branch:** demo/0${n}-${name.toLowerCase()}
**PR title:** feat: ${name.toLowerCase()}
**Stands alone because:** ${name.toLowerCase()} only
**Phase check:** \`true\` → exit 0

${tasks.map(([id, file]) => `### Task ${id}: Build ${file}

**Tier:** standard
**Role:** roles:tdd-implementer

**Files:**
- Create: \`src/${file}.js\`
- Test: \`test/${file}.test.mjs\`

- [ ] **Step 1:** build ${file}.
`).join('\n')}
`;

const PLAN_TEXT = `# Demo plan

**Branch prefix:** demo

${phaseText(1, 'One', 'trunk', [[1, 'a'], [2, 'b']])}${phaseText(2, 'Two', 'trunk', [[3, 'c'], [4, 'd']])}${phaseText(3, 'Three', 'P1, P2', [[5, 'e']])}`;

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role) => `The review, in prose.\n\n${FOOTER_MARKER}\nrole: ${role}\nfindings: critical=0 important=0 minor=0\n`;

// The throwaway `triqual` the scripts call: the first argument names the CLI file of this checkout.
const WRAPPER = `#!/bin/sh
cmd=$1; shift
case "$cmd" in
  role-eval) exec node ${JSON.stringify(ROLE_EVAL_CLI)} "$@" ;;
  *) exec node ${JSON.stringify(PT_CLI)}/"$cmd".mjs "$@" ;;
esac
`;

function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'concurrent-phases-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  for (const d of [home, dir, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT', 'TRIQUAL_NOW']) delete base[k];
  const env = {
    ...base, HOME: home, GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}${delimiter}${process.env.PATH}`,
    TRIQUAL_TRACKING_DB: join(root, 'data', 'tracking.db'), ROLE_EVAL_FILE: join(root, 'role-eval.jsonl'),
  };
  // task-close reads the hunter's model from the roles plugin as Claude Code records its install.
  const rolesDir = join(home, '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9');
  mkdirSync(join(rolesDir, 'agents'), { recursive: true });
  writeFileSync(join(rolesDir, 'agents', 'hunter.md'), '---\nname: hunter\ndescription: "Hunts."\nmodel: claude-haiku-4-9\neffort: medium\n---\n\nBody.\n');
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'roles@triqual': [{ scope: 'user', installPath: rolesDir, version: '9.9.9', lastUpdated: '2026-10-19T15:07:03.965Z' }] } }));
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const git = (...args) => gitIn(dir, ...args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, PLAN), PLAN_TEXT);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const workspace = join(dir, '.methodology', 'sdd', 'demo');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  return {
    root, dir, env, git, gitIn, workspace,
    // Every script runs from the main checkout.
    run: (script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: 'utf8' }),
    plan: (...args) => spawnSync(process.execPath, [join(PT_CLI, 'plan.mjs'), ...args], { cwd: dir, env, encoding: 'utf8' }),
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    appendLedger: (...lines) => appendFileSync(ledgerPath, lines.map((l) => `${l}\n`).join('')),
    state: () => JSON.parse(readFileSync(join(dir, '.methodology', 'stack', 'demo.json'), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const withRig = (fn) => {
  const r = rig();
  try {
    return fn(r);
  } finally {
    r.cleanup();
  }
};

const ok = (res) => {
  assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
};
const out = (res) => Object.fromEntries(res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  return [line.slice(0, at), line.slice(at + 2)];
}));
const refused = (res, pattern) => {
  assert.equal(res.status, 3, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, pattern);
};

const WT = (r, name) => join(r.dir, '.claude', 'worktrees', name);
const rev = (r, ref) => r.git('rev-parse', ref).trim();
const isAncestor = (r, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: r.dir, env: r.env }).status === 0;
const filesOf = (r, commit) => r.git('show', '--name-only', '--format=', commit).trim().split('\n').sort();

// One commit of `src/<x>.js` and one of its Test file, in the checkout `cwd`; returns the second one's sha.
const build = (r, cwd, x) => {
  const commit = (file, text, message) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
    r.gitIn(cwd, 'add', '-A');
    r.gitIn(cwd, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-q', '--author', 'Alice <alice@example.invalid>', '-m', message);
  };
  commit(`src/${x}.js`, `export const ${x} = 1;\n`, `feat: ${x}`);
  commit(`test/${x}.test.mjs`, "import { test } from 'node:test';\ntest('ok', () => {});\n", `test: ${x}`);
  return r.gitIn(cwd, 'rev-parse', 'HEAD').trim();
};
const outputs = (r, n) => {
  for (const role of ['safety-reviewer', 'spec-reviewer']) writeFileSync(join(r.workspace, `task-${n}-${role}-r1.md`), footerText(role));
};
const open = (r, n, ...flags) => out(ok(r.run('task-open', PLAN, String(n), ...flags)));
const prep = (r, n, ...flags) => out(ok(r.run('task-prep', PLAN, String(n), ...flags)));
const close = (r, n) => out(ok(r.run('task-close', PLAN, String(n))));
const reviewed = (r, n, ...flags) => {
  const p = prep(r, n, ...flags);
  outputs(r, n);
  return p;
};

test('P1 and P2 run at once in two checkouts, and P3 starts at their join', () => withRig((r) => {
  const init = JSON.parse(ok(r.run('stack.mjs', 'init', PLAN, '--mode', 'local')).stdout);
  assert.equal(init.v, 2);
  assert.deepEqual(init.phases[2].parents, ['demo/01-one', 'demo/02-two']);
  const trunk = rev(r, 'main');
  assert.equal(ok(r.run('stack.mjs', 'phase', PLAN, '1')).stdout.trim(), 'demo/01-one');
  const second = ok(r.run('stack.mjs', 'phase', PLAN, '2'));
  assert.equal(second.stdout, `demo/02-two\nworkdir: ${WT(r, 'demo-p2')}\n`);
  assert.equal(r.state().phases[1].workdir, WT(r, 'demo-p2'));
  assert.equal(r.gitIn(WT(r, 'demo-p2'), 'symbolic-ref', '--short', 'HEAD').trim(), 'demo/02-two');
  const main = r.dir;
  const wt2 = WT(r, 'demo-p2');

  // T1 in place in the main checkout and T3 in place in P2's worktree, interleaved: each opens at its own checkout's HEAD.
  const o1 = open(r, 1);
  const o3 = open(r, 3);
  assert.equal(o1.base, trunk);
  assert.equal(o1.workdir, undefined, 'a task of the main checkout prints no workdir');
  assert.equal(o3.base, trunk);
  assert.equal(o3.workdir, wt2);
  build(r, main, 'a');
  build(r, wt2, 'c');
  const p3 = reviewed(r, 3);
  assert.match(p3.package, /review-/);
  const p1 = reviewed(r, 1);
  assert.match(readFileSync(p1.package, 'utf8'), /src\/a\.js/);
  assert.doesNotMatch(readFileSync(p1.package, 'utf8'), /src\/c\.js/, "T1's package holds nothing of P2");
  assert.doesNotMatch(readFileSync(p3.package, 'utf8'), /src\/a\.js/, "T3's package holds nothing of P1");
  const c3 = close(r, 3);
  const c1 = close(r, 1);
  assert.equal(rev(r, 'demo/02-two'), c3.sha);
  assert.equal(rev(r, 'demo/01-one'), c1.sha);
  assert.equal(r.git('rev-parse', `${c1.sha}^`).trim(), trunk);
  assert.equal(r.git('rev-parse', `${c3.sha}^`).trim(), trunk);
  assert.deepEqual(filesOf(r, c1.sha), ['src/a.js', 'test/a.test.mjs']);
  assert.deepEqual(filesOf(r, c3.sha), ['src/c.js', 'test/c.test.mjs']);

  // T2 and T4 in task worktrees, each landing on its own phase's branch.
  const o2 = open(r, 2, '--worktree');
  const o4 = open(r, 4, '--worktree');
  assert.equal(o2.base, c1.sha);
  assert.equal(o4.base, c3.sha);
  assert.equal(o4.workdir, WT(r, 'demo-t4'));
  build(r, o2.workdir, 'b');
  build(r, o4.workdir, 'd');
  reviewed(r, 4);
  reviewed(r, 2);
  const c4 = close(r, 4);
  const c2 = close(r, 2);
  assert.equal(rev(r, 'demo/02-two'), c4.sha);
  assert.equal(rev(r, 'demo/01-one'), c2.sha);
  assert.equal(r.git('rev-parse', `${c2.sha}^`).trim(), c1.sha);
  assert.equal(r.git('rev-parse', `${c4.sha}^`).trim(), c3.sha);
  assert.deepEqual(filesOf(r, c2.sha), ['src/b.js', 'test/b.test.mjs']);
  assert.deepEqual(filesOf(r, c4.sha), ['src/d.js', 'test/d.test.mjs']);
  assert.equal(existsSync(WT(r, 'demo-t2')) || existsSync(WT(r, 'demo-t4')), false, 'a task worktree is left behind');
  // The two phases never saw each other's commits.
  for (const [mine, theirs] of [[[c1.sha, c2.sha], 'demo/02-two'], [[c3.sha, c4.sha], 'demo/01-one']]) {
    for (const sha of mine) assert.equal(isAncestor(r, sha, theirs), false, `${sha} is in ${theirs}`);
  }
  assert.equal(r.git('rev-list', '--count', 'main..demo/01-one').trim(), '2');
  assert.equal(r.git('rev-list', '--count', 'main..demo/02-two').trim(), '2');
  assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'demo/01-one', 'the main checkout moved');
  assert.equal(rev(r, 'HEAD'), c2.sha);
  assert.equal(r.gitIn(wt2, 'rev-parse', 'HEAD').trim(), c4.sha);

  // P1 is done and reviewed while P2 is still running: the next step waits for P2.
  ok(r.run('stack.mjs', 'done', PLAN, '1'));
  r.appendLedger('Phase review: P1 clean', 'Phase 1: complete (demo/01-one, local)');
  const resume = ok(r.run('phase-resume', PLAN, '1')).stdout;
  assert.match(resume, /^# Resume P1 demo\/01-one \(done\)/);
  assert.match(resume, /^P1 is submitted: no phase is ready yet; P3 waits for P2\.$/m);

  // P3 is refused until P2 is done, then starts at one commit that merges both tips.
  refused(r.run('stack.mjs', 'phase', PLAN, '3'), /phase 2 is active: phase 3 needs it/);
  assert.equal(r.git('branch', '--list', 'demo/03-three').trim(), '');
  ok(r.run('stack.mjs', 'done', PLAN, '2'));
  assert.equal(existsSync(wt2), false, "P2's worktree is still there");
  assert.equal(r.state().phases[1].state, 'done');
  assert.equal(ok(r.run('stack.mjs', 'phase', PLAN, '3')).stdout.trim(), 'demo/03-three');
  const [join3, ...parents] = r.git('rev-list', '--parents', '-n1', 'demo/03-three').trim().split(' ');
  assert.deepEqual(parents, [c2.sha, c4.sha]);
  assert.equal(r.state().phases[2].base, join3);
  assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'demo/03-three');
  assert.deepEqual(r.git('ls-tree', '-r', '--name-only', join3).trim().split('\n').filter((f) => f.startsWith('src/')), ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);

  const o5 = open(r, 5);
  assert.equal(o5.base, join3, "T5's BASE is the join commit");
  refused(r.run('stack.mjs', 'squash', PLAN, c2.sha, '--phase', '3'), /below the start of phase 3/);
  build(r, main, 'e');
  reviewed(r, 5);
  const c5 = close(r, 5);
  assert.equal(r.git('rev-parse', `${c5.sha}^`).trim(), join3);
  assert.equal(rev(r, 'demo/03-three'), c5.sha);
  assert.deepEqual(filesOf(r, c5.sha), ['src/e.js', 'test/e.test.mjs']);

  const collisions = r.plan('check-collisions', PLAN, '--diff', 'demo#P3', c5.sha);
  assert.equal(collisions.status, 0, `${collisions.stdout}\n${collisions.stderr}`);
  assert.doesNotMatch(collisions.stdout, /OUTSIDE/);
  assert.match(collisions.stdout, /collisions=0/);
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Error:')), []);
}));

test('a P2 task reopened in its worktree squashes only its own work while P1 holds commits in main', () => withRig((r) => {
  ok(r.run('stack.mjs', 'init', PLAN, '--mode', 'local'));
  const trunk = rev(r, 'main');
  ok(r.run('stack.mjs', 'phase', PLAN, '1'));
  ok(r.run('stack.mjs', 'phase', PLAN, '2'));
  const wt2 = WT(r, 'demo-p2');

  // P1 is active in main with a commit ahead.
  build(r, r.dir, 'a');
  assert.notEqual(rev(r, 'HEAD'), trunk);

  // T3 closes in P2's worktree.
  open(r, 3);
  build(r, wt2, 'c');
  reviewed(r, 3);
  const first = close(r, 3);
  assert.equal(r.git('rev-parse', `${first.sha}^`).trim(), trunk);

  // The Phase check failed: T3 is reopened, and a fix goes in the same worktree while P1 gains another commit in main.
  r.appendLedger('Task 3: reopened — Phase check failed — node --test');
  const reopened = open(r, 3);
  assert.equal(reopened.base, trunk, "a reopened T3's BASE is the commit before its own work, not P1's tip");
  assert.equal(reopened.workdir, wt2);
  mkdirSync(join(wt2, 'src'), { recursive: true });
  writeFileSync(join(wt2, 'src', 'c.js'), 'export const c = 2;\n');
  r.gitIn(wt2, 'add', '-A');
  r.gitIn(wt2, 'commit', '-q', '-m', 'fix: c');
  const fix = r.gitIn(wt2, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(r.dir, 'src', 'a.js'), 'export const a = 3;\n');
  r.git('commit', '-q', '-a', '-m', 'feat: a again');
  const p1Tip = rev(r, 'HEAD');

  // task-prep cannot review a reopened task that a close squashed (its last Prep head is no longer in the history, so tier-check refuses
  // the round): the package is made by hand, as the reviewer is, from the BASE task-open printed to the checkout's HEAD.
  const made = ok(r.run('review-package', PLAN, reopened.base, r.gitIn(wt2, 'rev-parse', 'HEAD').trim()));
  const pkg = readFileSync(/^wrote (.+): \d+ commit/.exec(made.stdout)[1], 'utf8');
  assert.match(pkg, /fix: c/);
  assert.doesNotMatch(pkg, /feat: a/, 'the review package holds a P1 commit');
  assert.doesNotMatch(pkg, /src\/a\.js/);
  assert.equal(pkg.match(/^## Commits\n((?:.*\n)*?)\n## Files changed/m)[1].trim().split('\n').length, 2, "the package lists a commit that is not T3's squashed commit or its fix");
  assert.match(pkg, /src\/c\.js/);
  outputs(r, 3);
  // The outputs of the reopened attempt are told apart from the first attempt's by the close marker's time.
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(r.workspace, 'task-3-closed-1'), old, old);
  const second = close(r, 3);
  assert.equal(r.git('rev-parse', `${second.sha}^`).trim(), trunk, 'the squash starts at the reopened task\'s own base');
  assert.equal(rev(r, 'demo/02-two'), second.sha);
  assert.equal(r.gitIn(wt2, 'rev-parse', 'HEAD').trim(), second.sha);
  assert.deepEqual(filesOf(r, second.sha), ['src/c.js', 'test/c.test.mjs']);
  assert.equal(r.git('show', `${second.sha}:src/c.js`).trim(), 'export const c = 2;');
  assert.notEqual(second.sha, fix);
  assert.equal(r.git('rev-list', '--count', `${trunk}..${second.sha}`).trim(), '1');
  // P1 stood where it was.
  assert.equal(rev(r, 'demo/01-one'), p1Tip);
  assert.equal(rev(r, 'HEAD'), p1Tip);
  assert.ok(r.ledger().some((l) => l === `Task 3: complete (commits ${trunk.slice(0, 7)}..${second.sha.slice(0, 7)}, review clean)`), r.ledger().join('\n'));
  assert.deepEqual(r.ledger().filter((l) => l.startsWith('Error:')), []);
}));
