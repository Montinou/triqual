// task-close Arm: ledger lines (T31): attempt-scoped `Arm: T<N> <role> <experiment>/<arm> <model> <effort>` lines become
// `arms: [{ role, experiment, arm, model, effort }]` in the `task-review` record; with none, the record has no `arms` key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../../progress-tracking/lib/store.mjs';
import { validateRecord } from '../cli/lib/role-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'skills', 'executing-plans', 'scripts');
const PT_CLI = join(HERE, '..', '..', 'progress-tracking', 'cli');
const ROLE_EVAL_CLI = join(HERE, '..', 'cli', 'role-eval.mjs');
const PLAN_NAME = 'demo-plan.md';
const PLAN = `# Demo plan

## Global Constraints

- Nothing.

### Task 1: Standard task

**Tier:** standard
**Role:** roles:tdd-implementer

- [ ] **Step 1:** one.

### Task 2: Security task

**Tier:** heavy
Security-relevant code: a permission check.
**Role:** roles:tdd-implementer

- [ ] **Step 1:** two.

### Task 3: State task

**Tier:** heavy
Live state: a store migration.
**Role:** roles:tdd-implementer

- [ ] **Step 1:** three.
`;

await loadSqlite();

// A clean environment: no GIT_* from a calling hook, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_TRACKING_DB', 'TRIQUAL_TRACKING_ROOT', 'TRIQUAL_NOW']) delete env[k];
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
};

// `triqual <command> ...` as the installed shim runs it, straight into this repo's progress-tracking and role-eval CLIs.
const WRAPPER = `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [command, ...rest] = process.argv.slice(2);
const cli = { tasks: ${JSON.stringify(PT_CLI)} + '/tasks.mjs', tracking: ${JSON.stringify(PT_CLI)} + '/tracking.mjs', 'role-eval': ${JSON.stringify(ROLE_EVAL_CLI)} }[command];
if (!cli) { process.stderr.write('triqual: unknown command ' + command + '\\n'); process.exit(1); }
appendFileSync(process.env.TRIQUAL_CALL_LOG, [command, ...rest].join(' ') + '\\n');
if (existsSync(process.env.TRIQUAL_CALL_LOG + '.fail-' + rest[0])) { process.stderr.write('triqual: forced failure of ' + rest[0] + '\\n'); process.exit(1); }
const res = spawnSync(process.execPath, [cli, ...rest], { stdio: 'inherit' });
process.exit(res.status ?? 1);
`;

// Copied from plugins/methodology/test/task-scripts.test.mjs (not exported, and that file is never run whole locally).
function rig({ store = true, local = false, planText = PLAN } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-close-arms-')));
  const home = join(root, 'home');
  const dir = join(root, 'repo');
  const bin = join(root, 'bin');
  const log = join(root, 'triqual.log');
  const dbEnv = { TRIQUAL_TRACKING_DB: join(root, 'data', 'tracking.db') };
  const evalFile = join(root, 'role-eval.jsonl');
  for (const d of [home, dir, bin]) mkdirSync(d);
  const rolesDir = join(home, '.claude', 'plugins', 'cache', 'triqual', 'roles', '9.9.9');
  mkdirSync(join(rolesDir, 'agents'), { recursive: true });
  writeFileSync(join(rolesDir, 'agents', 'hunter.md'), '---\nname: hunter\ndescription: "Hunts."\nmodel: claude-haiku-4-9\neffort: medium\n---\n\nBody.\n');
  const installed = join(home, '.claude', 'plugins', 'installed_plugins.json');
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'roles@triqual': [{ scope: 'user', installPath: rolesDir, version: '9.9.9', lastUpdated: '2026-10-19T15:07:03.965Z' }] } }));
  writeFileSync(join(bin, 'triqual'), WRAPPER, { mode: 0o755 });
  writeFileSync(log, '');
  const env = cleanEnv(home, { ...dbEnv, ROLE_EVAL_FILE: evalFile, PATH: `${bin}${delimiter}${process.env.PATH}`, TRIQUAL_CALL_LOG: log });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const triqual = (...args) => spawnSync(join(bin, 'triqual'), args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  let plan;
  if (local) {
    const methodology = join(dir, '.git', 'methodology');
    mkdirSync(join(methodology, 'plans'), { recursive: true });
    writeFileSync(join(methodology, 'progress.md'), '# Progress\n');
    writeFileSync(join(methodology, 'status.md'), '# Status\n');
    plan = join(methodology, 'plans', PLAN_NAME);
    writeFileSync(plan, planText);
    const init = triqual('tasks', 'init', plan);
    assert.equal(init.status, 0, init.stderr);
  } else if (store) {
    git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
    const plansDir = JSON.parse(triqual('tasks', 'paths', '--json').stdout).plansDir;
    mkdirSync(plansDir, { recursive: true });
    plan = join(plansDir, PLAN_NAME);
    writeFileSync(plan, planText);
    const init = triqual('tasks', 'init', plan);
    assert.equal(init.status, 0, init.stderr);
  } else {
    mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
    plan = join('docs', 'plans', PLAN_NAME);
    writeFileSync(join(dir, plan), planText);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  writeFileSync(log, '');
  const workspace = join(dir, '.methodology', 'sdd', 'demo-plan');
  const ledgerPath = join(workspace, 'sdd-ledger.md');
  const runIn = (cwd, script, ...args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, env, encoding: 'utf8' });
  return {
    root, dir, git, env, plan, workspace, triqual, installed, evalFile,
    run: (script, ...args) => runIn(dir, script, ...args),
    runIn,
    head: () => git('rev-parse', 'HEAD').trim(),
    commit(file, text, message = `edit ${file}`) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
      git('add', '-A', '--', '.', ':(exclude).methodology');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    appendLedger: (...lines) => appendFileSync(ledgerPath, lines.map((l) => `${l}\n`).join('')),
    seedLedger: (...lines) => {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(ledgerPath, `# SDD ledger — plan: ${plan}\n${lines.map((l) => `${l}\n`).join('')}`);
    },
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const withRig = (opts, fn) => {
  const [options, callback] = typeof opts === 'function' ? [{}, opts] : [opts, fn];
  const r = rig(options);
  try {
    return callback(r);
  } finally {
    r.cleanup();
  }
};

const ok = (res) => {
  assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
};
const pairs = (res) => res.stdout.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf(': ');
  assert.ok(at > 0, `not a key: value line: ${line}`);
  return [line.slice(0, at), line.slice(at + 2)];
});
const out = (res) => Object.fromEntries(pairs(res));
const open = (r, n) => out(ok(r.run('task-open', r.plan, String(n))));
const sha7 = (sha) => sha.slice(0, 7);

const FOOTER_MARKER = '<!-- triqual-review v1 -->';
const footerText = (role, [c, i, m] = [0, 0, 0]) => [
  'The review, in prose.', '', FOOTER_MARKER, `role: ${role}`, `findings: critical=${c} important=${i} minor=${m}`,
].join('\n') + '\n';

const startStack = (r) => {
  ok(r.run('stack.mjs', 'init', r.plan, '--mode', 'local'));
  ok(r.run('stack.mjs', 'phase', r.plan, '1'));
};
const save = (r, n, role, round, text) => writeFileSync(join(r.workspace, `task-${n}-${role}-r${round}.md`), text);
const prepared = (r, n, { commits = 2 } = {}) => {
  startStack(r);
  const o = open(r, n);
  for (let i = 0; i < commits; i++) r.commit(`src/t${n}-${i}.js`, `export const t${n}x${i} = ${i};\n`, i === 0 ? `feat: t${n}` : 'fixup! feat');
  const prep = out(ok(r.run('task-prep', r.plan, String(n))));
  return { base: o.base, prep };
};
const recordOf = (r, n) => JSON.parse(readFileSync(join(r.workspace, `task-${n}-record.json`), 'utf8'));
const storedRecords = (r) => (existsSync(r.evalFile) ? readFileSync(r.evalFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const HEAVY_OUTPUTS = (r, n = 2) => {
  save(r, n, 'safety-reviewer', 1, footerText('safety-reviewer', [0, 1, 1]));
  save(r, n, 'spec-reviewer', 1, footerText('spec-reviewer', [0, 1, 2]));
};
const ageFile = (file, secondsAgo) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, at, at);
};
const markClosed = (r, n, attempt, secondsAgo) => {
  const marker = join(r.workspace, `task-${n}-closed-${attempt}`);
  writeFileSync(marker, 'seeded\n');
  ageFile(marker, secondsAgo);
};

test('Arm lines become the arms field', () => withRig({}, (r) => {
  prepared(r, 2);
  r.appendLedger(
    'Arm: T2 tdd-implementer impl-effort/arm-a sonnet high',
    'Arm: T3 spec-reviewer review-model/arm-b sonnet low',
    'Arm: T2 spec-reviewer review-model/control opus medium',
  );
  HEAVY_OUTPUTS(r, 2);

  const res = ok(r.run('task-close', r.plan, '2'));
  assert.equal(out(res).record, 'recorded');

  const expected = [
    { role: 'tdd-implementer', experiment: 'impl-effort', arm: 'arm-a', model: 'sonnet', effort: 'high' },
    { role: 'spec-reviewer', experiment: 'review-model', arm: 'control', model: 'opus', effort: 'medium' },
  ];
  const record = recordOf(r, 2);
  assert.deepEqual(validateRecord(record), { ok: true });
  assert.deepEqual(record.arms, expected);

  const stored = storedRecords(r);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].arms, expected);
}));

test('an Arm line of an earlier attempt is not copied', () => {
  withRig({}, (r) => {
    startStack(r);
    const seeded = sha7(r.head());
    r.seedLedger(
      'Arm: T2 tdd-implementer impl-effort/control opus high',
      'Arm: T2 spec-reviewer review-model/control opus medium',
      `Task 2: complete (commits ${seeded}..${seeded}, review clean)`,
    );
    markClosed(r, 2, 1, 7200);
    prepared(r, 2);
    r.appendLedger('Arm: T2 spec-reviewer review-model/arm-b sonnet low');
    HEAVY_OUTPUTS(r, 2);

    const res = ok(r.run('task-close', r.plan, '2'));
    assert.equal(out(res).record, 'recorded');
    const record = recordOf(r, 2);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.equal(record.attempt, 2);
    assert.deepEqual(record.arms, [
      { role: 'spec-reviewer', experiment: 'review-model', arm: 'arm-b', model: 'sonnet', effort: 'low' },
    ]);
  });

  withRig({}, (r) => {
    startStack(r);
    const seeded = sha7(r.head());
    r.seedLedger(
      'Arm: T2 spec-reviewer review-model/control opus medium',
      `Task 2: complete (commits ${seeded}..${seeded}, review clean)`,
    );
    markClosed(r, 2, 1, 7200);
    prepared(r, 2);
    HEAVY_OUTPUTS(r, 2);

    ok(r.run('task-close', r.plan, '2'));
    const record = recordOf(r, 2);
    assert.deepEqual(validateRecord(record), { ok: true });
    assert.equal(record.attempt, 2);
    assert.equal(Object.hasOwn(record, 'arms'), false);
  });
});

test('no Arm line: no arms key', () => withRig({}, (r) => {
  prepared(r, 1);
  save(r, 1, 'safety-reviewer', 1, footerText('safety-reviewer'));
  save(r, 1, 'spec-reviewer', 1, footerText('spec-reviewer'));
  ok(r.run('task-close', r.plan, '1'));

  const first = recordOf(r, 1);
  assert.deepEqual(validateRecord(first), { ok: true });
  assert.equal(Object.hasOwn(first, 'arms'), false);
  assert.equal(Object.hasOwn(storedRecords(r)[0], 'arms'), false);

  open(r, 2);
  r.commit('src/t2.js', 'export const t2 = 2;\n', 'feat: t2');
  ok(r.run('task-prep', r.plan, '2'));
  r.appendLedger('Arm: T2 spec-reviewer review-model/control opus medium');
  HEAVY_OUTPUTS(r, 2);
  ok(r.run('task-close', r.plan, '2'));

  const second = recordOf(r, 2);
  assert.deepEqual(validateRecord(second), { ok: true });
  assert.deepEqual(second.arms, [
    { role: 'spec-reviewer', experiment: 'review-model', arm: 'control', model: 'opus', effort: 'medium' },
  ]);
}));
