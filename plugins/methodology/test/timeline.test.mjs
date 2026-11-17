// scripts/timeline.mjs: the parallelism a plan's run achieved, read from the `Opened:` / `Closed:` / `Serial:` lines of the workspace ledger.
// Every test runs the real script in a temp git repo against a hand-written ledger. The only stub is `triqual`: a private `bin` first on PATH holds a
// `triqual` that records its arguments and prints what the test says `plan lanes` printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans', 'scripts');
const TIMELINE = join(SCRIPTS, 'timeline.mjs');
const WORKSPACE = join(SCRIPTS, 'sdd-workspace');
const PLAN_REL = 'docs/plans/time-plan.md';

const task = (n, title) => `### Task ${n}: ${title}\n\n**Role:** roles:tdd-implementer\n\n- [ ] **Step 1:** do ${n}.\n\n`;
const PLAN = [
  '# Time Plan\n\n**Branch prefix:** demo\n\n',
  '## Phase 1: Core\n\n**Slice:** S1\n**Branch:** demo/01-core\n**PR title:** feat: core\n**Stands alone because:** core only\n**Phase check:** `true` → exit 0\n\n',
  task(1, 'Task number 1'),
  task(2, 'Task number 2'),
].join('');
// Two phases, each its own root (`**Parent:** trunk`): P1 holds T1 and P2 holds T2.
const phase = (n, name, parent) =>
  `## Phase ${n}: ${name}\n\n**Slice:** S${n}\n**Branch:** demo/0${n}-${name.toLowerCase()}\n**PR title:** feat: ${name.toLowerCase()}\n**Parent:** ${parent}\n**Stands alone because:** ${name} only\n**Phase check:** \`true\` → exit 0\n\n`;
const TWO_PHASES = ['# Time Plan\n\n**Branch prefix:** demo\n\n', phase(1, 'Core', 'trunk'), task(1, 'Task number 1'), phase(2, 'Extra', 'trunk'), task(2, 'Task number 2')].join('');
const PHASE_LANES = '{"parallelism": 2, "phaseRows": [{"n": 1, "parallelism": 1}, {"n": 2, "parallelism": 1}]}';

const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};

const AT = (hm) => `2026-11-16T${hm}:00Z`;
const lines = (res) => res.stdout.split('\n');

function withRig(fn, planText = PLAN) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'timeline-')));
  const home = join(base, 'home');
  const dir = join(base, 'repo');
  const bin = join(base, 'bin');
  mkdirSync(home);
  mkdirSync(dir);
  mkdirSync(bin);
  const argsFile = join(base, 'triqual.args');
  writeFileSync(join(bin, 'triqual'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$ARGS_FILE"\nprintf \'%s\' "$STUB_OUT"\nexit "${STUB_STATUS:-0}"\n');
  chmodSync(join(bin, 'triqual'), 0o755);
  const env = gitEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, PLAN_REL), planText);
  git('add', '.');
  git('commit', '-q', '-m', 'plan');
  const workspace = execFileSync(process.execPath, [WORKSPACE, PLAN_REL], { cwd: dir, env, encoding: 'utf8' }).trim();
  const exec = (args, { out = '{"parallelism": 2}', status = 0 } = {}) =>
    spawnSync(process.execPath, [TIMELINE, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, ARGS_FILE: argsFile, STUB_OUT: out, STUB_STATUS: String(status) },
    });
  const run = (ledgerLines, options) => {
    writeFileSync(join(workspace, 'sdd-ledger.md'), `${ledgerLines.join('\n')}\n`);
    return exec([PLAN_REL], options);
  };
  // The stack state of the plan: `phases` is the array of the state's `phases` ({ n, startedAt, doneAt }).
  const state = (phases) => {
    mkdirSync(join(dir, '.methodology', 'stack'), { recursive: true });
    writeFileSync(join(dir, '.methodology', 'stack', 'time-plan.json'), JSON.stringify({ phases }));
  };
  try {
    return fn({ run, exec, argsFile, state });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('two tasks of 10 minutes that overlap for 5 give wall-clock 15, achieved 1.33 and 2 at once', () => {
  withRig(({ run, argsFile }) => {
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Opened: T2 ${AT('10:05')}`, `Closed: T1 ${AT('10:10')}`, `Closed: T2 ${AT('10:15')}`];
    assert.equal(run(ledger).stdout, 'plan time-plan: wall-clock 15.0 min, task time 20.0 min, achieved 1.33, 2 at once, planned: 2.00\n');
    assert.match(readFileSync(argsFile, 'utf8'), /^plan lanes \S*time-plan\.md --json$/m);
  });
});

test('a reopened task counts each window', () => {
  withRig(({ run }) => {
    const ledger = [
      `Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`,
      `Opened: T1 ${AT('10:20')}`, `Closed: T1 ${AT('10:25')}`,
    ];
    assert.equal(lines(run(ledger))[0], 'plan time-plan: wall-clock 25.0 min, task time 15.0 min, achieved 0.60, 1 at once, planned: 2.00');
  });
});

test('windows that touch are not at once', () => {
  withRig(({ run }) => {
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Opened: T2 ${AT('10:10')}`, `Closed: T2 ${AT('10:20')}`];
    const res = run(ledger);
    assert.match(lines(res)[0], /achieved 1\.00, 1 at once/);
    // and in the order the ledger gives them the other way round
    const reversed = [`Opened: T2 ${AT('10:10')}`, `Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Closed: T2 ${AT('10:20')}`];
    assert.match(lines(run(reversed))[0], /achieved 1\.00, 1 at once/);
  });
});

test('a task opened and never closed is listed as open and left out of the sums', () => {
  withRig(({ run }) => {
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Opened: T2 ${AT('10:05')}`];
    assert.deepEqual(lines(run(ledger)), [
      'plan time-plan: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 2.00',
      `open: T2 since ${AT('10:05')}`,
      '',
    ]);
  });
});

test('Serial lines are listed as written', () => {
  withRig(({ run }) => {
    const serial = 'Serial: T1, T2 — one shared file';
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, serial];
    const out = lines(run(ledger));
    assert.equal(out.at(-2), serial);
  });
});

test('a ledger with no time lines prints no timeline and exits 0', () => {
  withRig(({ run }) => {
    const res = run(['BASE: T1 abc1234']);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, 'no timeline\n');
  });
});

test('planned is unknown when plan lanes gives no object, and its parallelism when it exits 1 with violations', () => {
  withRig(({ run }) => {
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`];
    const planned = (options) => lines(run(ledger, options))[0].split(', ').at(-1);
    assert.equal(planned({ status: 2, out: '' }), 'planned: unknown');
    assert.equal(planned({ status: 0, out: 'not json' }), 'planned: unknown');
    assert.equal(planned({ status: 0, out: '[2]' }), 'planned: unknown');
    assert.equal(planned({ status: 1, out: '{"parallelism": 1.5, "violations": [{"code": "no-parent"}]}' }), 'planned: 1.50');
  });
});

test('old and hand-edited lines are skipped, never fatal', () => {
  withRig(({ run }) => {
    const ledger = [
      `Closed: T3 ${AT('09:00')}`, `Opened: T1 ${AT('10:00')}`, `Opened: T1 ${AT('10:02')}`, `Closed: T1 ${AT('10:10')}`, 'Opened: T2 yesterday',
    ];
    const res = run(ledger);
    assert.equal(res.status, 0);
    assert.equal(lines(res)[0], 'plan time-plan: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 2.00');
    assert.equal(res.stderr.split('\n').filter((l) => l.startsWith('timeline: skipped ')).length, 3);
  });
});

test('a close earlier than its open is skipped', () => {
  withRig(({ run }) => {
    const res = run([`Opened: T1 ${AT('10:10')}`, `Closed: T1 ${AT('10:00')}`]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /^timeline: skipped Closed: T1 /m);
    assert.deepEqual(lines(res), ['plan time-plan: wall-clock 0.0 min, task time 0.0 min, achieved 0.00, 0 at once, planned: 2.00', `open: T1 since ${AT('10:10')}`, '']);
  });
});

test('usage, a missing plan and a missing ledger', () => {
  withRig(({ exec }) => {
    let res = exec([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage: timeline\.mjs PLAN_FILE$/m);
    res = exec([PLAN_REL, '--frob']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage: timeline\.mjs PLAN_FILE$/m);
    res = exec(['docs/plans/nope.md']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no such plan file/);
    res = exec([PLAN_REL]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /no ledger at /);
  });
});

// ---- phase rows (a plan with two or more phases) ----

const OVERLAP = [`Opened: T1 ${AT('10:00')}`, `Opened: T2 ${AT('10:05')}`, `Closed: T1 ${AT('10:10')}`, `Closed: T2 ${AT('10:15')}`];
const phaseState = (n, from, to) => ({ n, startedAt: AT(from), ...(to ? { doneAt: AT(to) } : {}) });

test('two phases whose windows overlap give a row each and 2 phases at once', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:12'), phaseState(2, '10:04', '10:20')]);
    const out = lines(run(OVERLAP, { out: PHASE_LANES }));
    assert.equal(out[0], 'plan time-plan: wall-clock 15.0 min, task time 20.0 min, achieved 1.33, 2 at once, planned: 2.00');
    assert.equal(out[1], 'P1: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 1.00');
    assert.equal(out[2], 'P2: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 1.00');
    assert.equal(out[3], 'phase windows: 2 phases at once');
    assert.equal(out.length, 5);
  }, TWO_PHASES);
});

test('phase windows that touch are 1 phase at once', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:10'), phaseState(2, '10:10', '10:20')]);
    assert.equal(lines(run(OVERLAP, { out: PHASE_LANES }))[3], 'phase windows: 1 phase at once');
    // and with the state listing them the other way round
    state([phaseState(2, '10:10', '10:20'), phaseState(1, '10:00', '10:10')]);
    assert.equal(lines(run(OVERLAP, { out: PHASE_LANES }))[3], 'phase windows: 1 phase at once');
  }, TWO_PHASES);
});

test('a phase started and not done is open and out of the count', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:12'), phaseState(2, '10:04')]);
    const out = lines(run(OVERLAP, { out: PHASE_LANES }));
    assert.equal(out[3], 'phase windows: 1 phase at once');
    assert.equal(out[4], 'open: P2 since 2026-11-16T10:04:00Z');
  }, TWO_PHASES);
});

test('open phases come after the open tasks and before the Serial lines', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:12'), phaseState(2, '10:04')]);
    const ledger = [`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Opened: T2 ${AT('10:05')}`, 'Serial: T1, T2 — one file'];
    const out = lines(run(ledger, { out: PHASE_LANES }));
    assert.deepEqual(out.slice(-4), [`open: T2 since ${AT('10:05')}`, `open: P2 since ${AT('10:04')}`, 'Serial: T1, T2 — one file', '']);
  }, TWO_PHASES);
});

test('no stack state prints phase windows: unknown', () => {
  withRig(({ run }) => {
    const out = lines(run(OVERLAP, { out: PHASE_LANES }));
    assert.equal(out[1], 'P1: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 1.00');
    assert.equal(out[3], 'phase windows: unknown');
  }, TWO_PHASES);
});

test('a phase with no closed window prints no timeline', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:12'), phaseState(2, '10:04')]);
    const out = lines(run([`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Opened: T2 ${AT('10:05')}`], { out: PHASE_LANES }));
    assert.equal(out[1], 'P1: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 1.00');
    assert.equal(out[2], 'P2: no timeline');
  }, TWO_PHASES);
});

test('a phase row is planned: unknown when plan lanes gives it no parallelism', () => {
  withRig(({ run }) => {
    const out = lines(run(OVERLAP, { out: '{"parallelism": 2}' }));
    assert.match(out[1], /^P1: .*, planned: unknown$/);
    assert.match(out[2], /^P2: .*, planned: unknown$/);
  }, TWO_PHASES);
});

test('a state time that is not ISO is skipped with a stderr line', () => {
  withRig(({ run, state }) => {
    state([{ n: 1, startedAt: 'soon', doneAt: AT('10:12') }, phaseState(2, '10:04', '10:20')]);
    const res = run(OVERLAP, { out: PHASE_LANES });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /^timeline: skipped P1 startedAt soon$/m);
    assert.equal(lines(res)[3], 'phase windows: 1 phase at once');
  }, TWO_PHASES);
});

test('a single-phase plan prints exactly what it printed before', () => {
  withRig(({ run, state }) => {
    state([phaseState(1, '10:00', '10:12')]);
    const res = run([`Opened: T1 ${AT('10:00')}`, `Closed: T1 ${AT('10:10')}`, `Opened: T2 ${AT('10:05')}`], { out: PHASE_LANES });
    assert.equal(res.stdout, ['plan time-plan: wall-clock 10.0 min, task time 10.0 min, achieved 1.00, 1 at once, planned: 2.00', `open: T2 since ${AT('10:05')}`, ''].join('\n'));
  });
});
