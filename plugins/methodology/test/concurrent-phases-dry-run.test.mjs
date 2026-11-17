// A dry run of the commands the concurrent-phases procedure tells the main session to type. The test carries its own literal copy of the
// command list (it never reads the procedure's reference file) and runs every line of it, in a temp git repo with a bare `origin` and a
// fake `gh` (the github rig of stack-forest.test.mjs): P1 and P2 start from the trunk and are active at the same time (P1 in the main
// checkout, P2 in its phase worktree), P3 (`**Parent:** P1, P2`) waits for both and starts at their join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(PLUGIN, 'skills', 'executing-plans', 'scripts');
const FAKE_GH = join(PLUGIN, 'test', 'fixtures', 'fake-gh');
const PLAN_REL = 'docs/plans/dry-run.md';

// The procedure's six commands, in order. `scripts/` is the executing-plans skill's scripts directory.
const COMMANDS = [
  'node scripts/stack.mjs init PLAN_FILE',
  'node scripts/stack.mjs status PLAN_FILE',
  'node scripts/stack.mjs phase PLAN_FILE N',
  'node scripts/stack.mjs done PLAN_FILE N',
  'node scripts/stack.mjs submit PLAN_FILE N',
  'node scripts/phase-resume PLAN_FILE N',
];

const phaseText = (n, name, parent) => `## Phase ${n}: ${name}

**Slice:** S${n}
**Parent:** ${parent}
**Branch:** demo/0${n}-${name.toLowerCase()}
**PR title:** feat: ${name.toLowerCase()}
**Stands alone because:** ${name.toLowerCase()} only
**Phase check:** \`true\` → exit 0

`;
const PLAN = `# Dry-run plan

**Branch prefix:** demo

${phaseText(1, 'Core', 'trunk')}${phaseText(2, 'Edge', 'trunk')}${phaseText(3, 'Extra', 'P1, P2')}`;

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function rig() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dry-run-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const origin = join(base, 'origin.git');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  for (const d of [home, dir, origin, bin, work]) mkdirSync(d);
  symlinkSync(realGit, join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec bash '${FAKE_GH}' "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(work, 'gh.log');
  const env = { ...gitEnv(home), PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_LOG: log, FAKE_GH_STACK: join(work, 'membership') };
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const git = (...args) => gitIn(dir, ...args);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, dirname(PLAN_REL)), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), PLAN);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  // GitHub mode against the bare repository: the remote's URL is a GitHub one, pushes go to the bare repository.
  git('remote', 'set-url', 'origin', 'https://github.com/acme/demo.git');
  git('config', 'remote.origin.pushurl', origin);

  // Every command of COMMANDS goes through here: PLAN_FILE and N filled in, run from the main checkout. The set of lines run is kept.
  const ran = new Set();
  const cmd = (line, n) => {
    assert.ok(COMMANDS.includes(line), `not a command of the procedure: ${line}`);
    ran.add(line);
    const [, script, ...args] = line.split(' ').map((w) => (w === 'PLAN_FILE' ? PLAN_REL : w === 'N' ? String(n) : w));
    assert.ok(script.startsWith('scripts/'), line);
    return spawnSync(process.execPath, [join(SCRIPTS, script.slice('scripts/'.length)), ...args], { cwd: dir, env, encoding: 'utf8' });
  };
  const ok = (res) => {
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    return res;
  };
  // The `n` of the phases `status` prints with `ready: true`.
  const ready = () => JSON.parse(ok(cmd(COMMANDS[1])).stdout).phases.filter((p) => p.ready).map((p) => p.n);
  const workspace = execFileSync(process.execPath, [join(SCRIPTS, 'sdd-workspace'), PLAN_REL], { cwd: dir, env, encoding: 'utf8' }).trim();
  return {
    dir, env, git, gitIn, ran, cmd, ok, ready,
    commit: (cwd, file, text, message) => {
      writeFileSync(join(cwd, file), text);
      gitIn(cwd, 'add', '-A');
      gitIn(cwd, 'commit', '-q', '-m', message);
    },
    // The lines the main session writes at a phase end, in the workspace's ledger.
    ledger: (...lines) => appendFileSync(join(workspace, 'sdd-ledger.md'), lines.map((l) => `${l}\n`).join('')),
    state: () => JSON.parse(readFileSync(join(dir, '.methodology', 'stack', 'dry-run.json'), 'utf8')),
    ghCreated: () =>
      (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((a) => a[0] === 'pr' && a[1] === 'create'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
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

const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("the procedure's commands reach three submitted phases with P1 and P2 active at once", () => withRig((r) => {
  // init, then P1 and P2 are both ready
  r.ok(r.cmd(COMMANDS[0]));
  assert.deepEqual(r.ready(), [1, 2]);

  // phase 1 in the main checkout, phase 2 in its own worktree, one after the other: both are active at the same time
  assert.equal(r.ok(r.cmd(COMMANDS[2], 1)).stdout.trim(), 'demo/01-core');
  const second = r.ok(r.cmd(COMMANDS[2], 2));
  const workdir = /^workdir: (.+)$/m.exec(second.stdout)?.[1];
  assert.ok(workdir && workdir !== r.dir && existsSync(workdir), second.stdout);
  assert.deepEqual(r.state().phases.map((p) => p.state), ['active', 'active', 'pending']);
  assert.equal(r.gitIn(workdir, 'symbolic-ref', '--short', 'HEAD').trim(), 'demo/02-edge');
  assert.equal(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'demo/01-core');

  // a commit on each: P1 in the main checkout, P2 in its worktree
  r.commit(r.dir, 'core.txt', 'core\n', 'feat: core');
  r.commit(workdir, 'edge.txt', 'edge\n', 'feat: edge');

  // P2 is finished and submitted first; P3 waits for P1, so no phase is ready
  r.ok(r.cmd(COMMANDS[3], 2));
  assert.equal(r.ok(r.cmd(COMMANDS[4], 2)).stdout.trim(), 'Phase 2: submitted (demo/02-edge, PR #7 draft, base main)');
  r.ledger('Phase review: P2 clean', 'Phase 2: submitted (demo/02-edge, #7)');
  assert.deepEqual(r.ready(), []);
  const afterTwo = r.ok(r.cmd(COMMANDS[5], 2));
  assert.match(afterTwo.stdout, /^P2 is submitted: no phase is ready yet; P3 waits for P1\.$/m);

  // P1 is finished and submitted: P3 is ready
  r.ok(r.cmd(COMMANDS[3], 1));
  assert.equal(r.ok(r.cmd(COMMANDS[4], 1)).stdout.trim(), 'Phase 1: submitted (demo/01-core, PR #8 draft, base main)');
  r.ledger('Phase review: P1 clean', 'Phase 1: submitted (demo/01-core, #8)');
  assert.deepEqual(r.ready(), [3]);
  const afterOne = r.ok(r.cmd(COMMANDS[5], 1));
  assert.match(afterOne.stdout, /^P1 is submitted: start the next phase with node scripts\/stack\.mjs phase docs\/plans\/dry-run\.md 3\.$/m);

  // P3 starts at the join of both tips, gets a commit, is done and submitted
  assert.equal(r.ok(r.cmd(COMMANDS[2], 3)).stdout.trim(), 'demo/03-extra');
  assert.equal(r.git('rev-list', '--parents', '-n1', 'demo/03-extra').trim().split(' ').length - 1, 2, 'P3 starts at a commit that merges two parents');
  r.commit(r.dir, 'extra.txt', 'extra\n', 'feat: extra');
  r.ok(r.cmd(COMMANDS[3], 3));
  assert.equal(r.ok(r.cmd(COMMANDS[4], 3)).stdout.trim(), 'Phase 3: submitted (demo/03-extra, PR #9 draft, base demo/01-core)');
  r.ledger('Phase review: P3 clean', 'Phase 3: submitted (demo/03-extra, #9)');

  assert.deepEqual(r.state().phases.map((p) => [p.state, p.pr]), [['submitted', 8], ['submitted', 7], ['submitted', 9]]);
  const calls = r.ghCreated();
  assert.deepEqual(calls.map((a) => [arg(a, '--head'), arg(a, '--base')]), [
    ['demo/02-edge', 'main'],
    ['demo/01-core', 'main'],
    ['demo/03-extra', 'demo/01-core'],
  ]);

  // every line of the procedure was run at least once
  assert.deepEqual([...r.ran].sort(), [...COMMANDS].sort());
}));
