// The milestone of plan C's first phase: the `startedAt` / `doneAt` times stack.mjs writes into the state (under TRIQUAL_NOW) are the
// ones timeline.mjs reads back as phase rows and the `phase windows:` line. Both scripts are the real ones, run in a temp git repo that is
// not opted in; the only stub is `triqual`, which prints what `plan lanes` would print.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans', 'scripts');
const STACK = join(SCRIPTS, 'stack.mjs');
const TIMELINE = join(SCRIPTS, 'timeline.mjs');
const WORKSPACE = join(SCRIPTS, 'sdd-workspace');
const PLAN_REL = 'docs/plans/demo.md';
const LANES = '{"parallelism": 1, "phaseRows": [{"n": 1, "parallelism": 1}, {"n": 2, "parallelism": 1}]}';

const task = (n) => `### Task ${n}: Task number ${n}\n\n**Role:** roles:tdd-implementer\n\n- [ ] **Step 1:** do ${n}.\n\n`;
const phase = (n, name, parent) =>
  `## Phase ${n}: ${name}\n\n**Slice:** S${n}\n**Branch:** demo/0${n}-${name.toLowerCase()}\n**PR title:** feat: ${name.toLowerCase()}\n**Parent:** ${parent}\n**Stands alone because:** ${name} only\n**Phase check:** \`true\` → exit 0\n\n`;
// A chain: P1 starts at the trunk, P2 at P1.
const PLAN = ['# Demo Plan\n\n**Branch prefix:** demo\n\n', phase(1, 'Core', 'trunk'), task(1), phase(2, 'Edge', 'P1'), task(2)].join('');

const AT = (hm) => `2026-11-16T${hm}:00Z`;

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'TRIQUAL_NOW'));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

function withRig(fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phase-times-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const bin = join(base, 'bin');
  for (const d of [home, dir, bin]) mkdirSync(d);
  writeFileSync(join(bin, 'triqual'), '#!/bin/sh\nprintf \'%s\' "$STUB_OUT"\n');
  chmodSync(join(bin, 'triqual'), 0o755);
  const env = { ...gitEnv(home), PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_OUT: LANES };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), PLAN);
  git('add', '.');
  git('commit', '-q', '-m', 'plan');
  const script = (file, args, extra = {}) => spawnSync(process.execPath, [file, ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...extra } });
  const stack = (args, at) => {
    const res = script(STACK, args, at ? { TRIQUAL_NOW: AT(at) } : {});
    assert.equal(res.status, 0, `stack.mjs ${args.join(' ')}: ${res.stderr}`);
  };
  try {
    return fn({ stack, timeline: () => script(TIMELINE, [PLAN_REL]), workspace: () => execFileSync(process.execPath, [WORKSPACE, PLAN_REL], { cwd: dir, env, encoding: 'utf8' }).trim() });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('stack.mjs phase and done times are read by timeline.mjs as phase rows', () => {
  withRig(({ stack, timeline, workspace }) => {
    stack(['init', PLAN_REL, '--mode', 'local']);
    stack(['phase', PLAN_REL, '1'], '10:00');
    stack(['done', PLAN_REL, '1'], '10:20');
    stack(['phase', PLAN_REL, '2'], '10:20');
    stack(['done', PLAN_REL, '2'], '10:50');
    writeFileSync(
      join(workspace(), 'sdd-ledger.md'),
      [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:15')}`, `Opened: T2 ${AT('10:25')}`, `Closed: T2 ${AT('10:45')}`, ''].join('\n'),
    );
    const res = timeline();
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.split('\n');
    assert.equal(lines[1], 'P1: wall-clock 15.0 min, task time 15.0 min, achieved 1.00, 1 at once, planned: 1.00');
    assert.equal(lines[3], 'phase windows: 1 phase at once');
  });
});
