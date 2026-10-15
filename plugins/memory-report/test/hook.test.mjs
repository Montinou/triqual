// The SessionStart hook (spec 5): lazy trigger, attended-session notice, child guard and failure containment.
// Everything runs against a temp HOME with a fake spawn, clock and env; the real generator and `claude` never start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionStart } from '../lib/hook.mjs';
import { failureLine, summaryLine } from '../lib/render.mjs';
import { withTempHome } from './helpers.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const TODAY = localDay(NOW);

const SUMMARY = { week: '2026-W41', insights: 'ok', rules: 2, skills: 1, stale: 3, chroma: 'OK' };

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const makeDb = (paths) => writeJson(paths.dbFile, 'not a real database; the hook only stats it');

// Runs the hook once with fakes; returns what it spawned and wrote.
function run(ctx, { entrypoint, extraEnv = {}, nowMs = NOW, isAlive = () => true, pluginRoot = '/plugin-root' } = {}) {
  const spawned = [];
  const out = [];
  const env = { ...ctx.env, ...extraEnv };
  if (entrypoint !== undefined) env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  const spawn = (cmd, args, opts) => {
    const child = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const result = sessionStart({ env, home: ctx.home, nowMs, spawn, isAlive, write: (s) => out.push(s), pluginRoot });
  return { result, spawned, out, output: out.join('') };
}

const log = (ctx) => (existsSync(ctx.paths.logFile) ? readFileSync(ctx.paths.logFile, 'utf8') : '');
const logLines = (ctx) => log(ctx).split('\n').filter(Boolean).map((l) => l.replace(/^\S+ /, ''));

// A report file on disk plus the matching state, the usual "unseen report" fixture.
function seedReport(ctx, { lastSuccessAt = iso(NOW - 2 * DAY), summary = SUMMARY, extra = {} } = {}) {
  const reportPath = join(ctx.paths.reportsDir, '2026-W41.md');
  writeJson(reportPath, '# report\n');
  writeJson(ctx.paths.stateFile, {
    lastSuccessAt, lastAttemptAt: lastSuccessAt, lastReportPath: reportPath, lastSummary: summary, ...extra,
  });
  return reportPath;
}

// ---- spawn trigger ---------------------------------------------------------------------------------------------------

test('due: spawns the generator once, detached with ignored stdio, and unrefs it', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    const { spawned, output } = run(ctx, { pluginRoot: '/some/plugin' });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, process.execPath);
    assert.deepEqual(spawned[0].args, [join('/some/plugin', 'cli', 'memory.mjs'), 'generate']);
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(spawned[0].opts.stdio, 'ignore');
    assert.equal(spawned[0].child.unrefCalls, 1);
    assert.equal(output, '');
  });
});

test('not due: a success inside intervalDays, or an attempt inside 24 h, spawns nothing', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeJson(ctx.paths.stateFile, { lastSuccessAt: iso(NOW - 2 * DAY), lastAttemptAt: iso(NOW - 2 * DAY) });
    assert.equal(run(ctx).spawned.length, 0);
    writeJson(ctx.paths.stateFile, { lastSuccessAt: iso(NOW - 30 * DAY), lastAttemptAt: iso(NOW - 3600 * 1000), lastError: 'x' });
    assert.equal(run(ctx).spawned.length, 0);
    writeJson(ctx.paths.stateFile, { lastSuccessAt: iso(NOW - 30 * DAY), lastAttemptAt: iso(NOW - 25 * 3600 * 1000) });
    assert.equal(run(ctx).spawned.length, 1);
  });
});

test('no claude-mem.db: nothing is spawned', async () => {
  await withTempHome((ctx) => {
    assert.equal(run(ctx).spawned.length, 0);
  });
});

test('lock held by a live recent process: nothing is spawned', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeJson(ctx.paths.lockFile, { pid: 4242, startedAt: iso(NOW - 60 * 1000) });
    assert.equal(run(ctx, { isAlive: () => true }).spawned.length, 0);
  });
});

test('stale locks do not block: dead pid, 3 h old start, a corrupt lock older than 60 s', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeJson(ctx.paths.lockFile, { pid: 4242, startedAt: iso(NOW - 60 * 1000) });
    assert.equal(run(ctx, { isAlive: () => false }).spawned.length, 1);
    writeJson(ctx.paths.lockFile, { pid: 4242, startedAt: iso(NOW - 3 * 3600 * 1000) });
    assert.equal(run(ctx, { isAlive: () => true }).spawned.length, 1);

    writeJson(ctx.paths.lockFile, '{"pid":');
    const old = new Date(NOW - 61 * 1000);
    utimesSync(ctx.paths.lockFile, old, old);
    assert.equal(run(ctx).spawned.length, 1);
  });
});

test('a corrupt lock changed within the last minute still holds the slot', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeJson(ctx.paths.lockFile, '');
    const recent = new Date(NOW - 10 * 1000);
    utimesSync(ctx.paths.lockFile, recent, recent);
    assert.equal(run(ctx).spawned.length, 0);
  });
});

test('a spawned child that reports an async error does not crash the hook', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    const handlers = [];
    const spawn = () => ({ unref() {}, on(event, fn) { handlers.push([event, fn]); } });
    sessionStart({ env: ctx.env, home: ctx.home, nowMs: NOW, spawn, isAlive: () => true, write: () => {}, pluginRoot: '/p' });
    const errorHandler = handlers.find(([event]) => event === 'error');
    assert.ok(errorHandler, 'an error listener is attached');
    assert.doesNotThrow(() => errorHandler[1](new Error('ENOENT')));
  });
});

// ---- child guard and the start log -----------------------------------------------------------------------------------

test('MEMORY_REPORT_CHILD=1 and CLAUDE_MEM_INTERNAL=1: child-skip logged, no output, no spawn, no notice', async () => {
  for (const flag of ['MEMORY_REPORT_CHILD', 'CLAUDE_MEM_INTERNAL']) {
    await withTempHome((ctx) => {
      makeDb(ctx.paths);
      seedReport(ctx);
      const { spawned, output } = run(ctx, { entrypoint: 'cli', extraEnv: { [flag]: '1' } });
      assert.equal(spawned.length, 0);
      assert.equal(output, '');
      assert.deepEqual(logLines(ctx), ['hook child-skip']);
      assert.equal(existsSync(ctx.paths.noticeFile), false);
    });
  }
});

test('hook start logs the entrypoint value, or none', async () => {
  await withTempHome((ctx) => {
    run(ctx, { entrypoint: 'sdk-ts' });
    run(ctx);
    run(ctx, { entrypoint: '' });
    assert.deepEqual(logLines(ctx), ['hook start entrypoint=sdk-ts', 'hook start entrypoint=none', 'hook start entrypoint=none']);
  });
});

// ---- notice ----------------------------------------------------------------------------------------------------------

test('unattended entrypoints (sdk-ts, absent, anything but cli) show nothing and leave notice.json untouched', async () => {
  await withTempHome((ctx) => {
    seedReport(ctx);
    for (const entrypoint of ['sdk-ts', undefined, 'CLI', 'cli-print']) {
      const { output } = run(ctx, { entrypoint });
      assert.equal(output, '');
    }
    assert.equal(existsSync(ctx.paths.noticeFile), false);
    writeJson(ctx.paths.noticeFile, { lastNoticeDate: '2020-01-01' });
    const before = readFileSync(ctx.paths.noticeFile, 'utf8');
    assert.equal(run(ctx, { entrypoint: 'sdk-ts' }).output, '');
    assert.equal(readFileSync(ctx.paths.noticeFile, 'utf8'), before);
  });
});

test('cli with an unseen report: one JSON object with the summary line, and notice.json gets today', async () => {
  await withTempHome((ctx) => {
    const reportPath = seedReport(ctx);
    const { output, out } = run(ctx, { entrypoint: 'cli' });
    const line = summaryLine(SUMMARY, reportPath);
    assert.equal(out.length, 1);
    assert.ok(output.endsWith('\n'));
    assert.deepEqual(JSON.parse(output), {
      systemMessage: line,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
    });
    assert.deepEqual(JSON.parse(readFileSync(ctx.paths.noticeFile, 'utf8')), { lastNoticeDate: TODAY });
  });
});

test('insights unavailable: the line says so instead of the three counts', async () => {
  await withTempHome((ctx) => {
    const summary = { ...SUMMARY, insights: 'unavailable', rules: 0, skills: 0, stale: 0 };
    const reportPath = seedReport(ctx, { summary });
    const parsed = JSON.parse(run(ctx, { entrypoint: 'cli' }).output);
    assert.equal(parsed.systemMessage, summaryLine(summary, reportPath));
    assert.match(parsed.systemMessage, /insights unavailable/);
  });
});

test('a second call the same local day shows nothing; the next day shows it again', async () => {
  await withTempHome((ctx) => {
    seedReport(ctx);
    assert.notEqual(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.notEqual(run(ctx, { entrypoint: 'cli', nowMs: NOW + 2 * DAY }).output, '');
  });
});

test('seen.json matching the report path and lastSuccessAt: nothing; a rerun with a new lastSuccessAt: shown again', async () => {
  await withTempHome((ctx) => {
    const lastSuccessAt = iso(NOW - 2 * DAY);
    const reportPath = seedReport(ctx, { lastSuccessAt });
    writeJson(ctx.paths.seenFile, { seenReport: reportPath, seenSuccessAt: lastSuccessAt });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false, 'nothing shown consumes nothing');

    seedReport(ctx, { lastSuccessAt: iso(NOW - 1 * DAY) });
    const { output } = run(ctx, { entrypoint: 'cli' });
    assert.equal(JSON.parse(output).systemMessage, summaryLine(SUMMARY, reportPath));
  });
});

test('a report path that no longer exists on disk shows nothing', async () => {
  await withTempHome((ctx) => {
    const reportPath = seedReport(ctx);
    rmSync(reportPath);
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
  });
});

test('failure line on a first run with no report', async () => {
  await withTempHome((ctx) => {
    const state = { lastAttemptAt: iso(NOW - 3600 * 1000), lastError: 'claude binary not found' };
    writeJson(ctx.paths.stateFile, state);
    const parsed = JSON.parse(run(ctx, { entrypoint: 'cli' }).output);
    assert.equal(parsed.systemMessage, failureLine(state));
    assert.equal(parsed.hookSpecificOutput.additionalContext, failureLine(state));
    assert.match(parsed.systemMessage, /^Memory report failed \d{4}-\d{2}-\d{2}: claude binary not found \(triqual memory status\)$/);
    assert.deepEqual(JSON.parse(readFileSync(ctx.paths.noticeFile, 'utf8')), { lastNoticeDate: TODAY });
  });
});

test('failure line wins over an unseen report when the attempt is later than the success', async () => {
  await withTempHome((ctx) => {
    const lastSuccessAt = iso(NOW - 10 * DAY);
    const reportPath = seedReport(ctx, { lastSuccessAt });
    writeJson(ctx.paths.seenFile, { seenReport: reportPath, seenSuccessAt: lastSuccessAt });
    const state = {
      lastSuccessAt, lastAttemptAt: iso(NOW - 3600 * 1000), lastError: 'boom', lastReportPath: reportPath, lastSummary: SUMMARY,
    };
    writeJson(ctx.paths.stateFile, state);
    assert.equal(JSON.parse(run(ctx, { entrypoint: 'cli' }).output).systemMessage, failureLine(state));
  });
});

test('lastError with the attempt not later than the success is not a failure', async () => {
  await withTempHome((ctx) => {
    const reportPath = seedReport(ctx, { extra: { lastError: 'old error' } });
    assert.equal(JSON.parse(run(ctx, { entrypoint: 'cli' }).output).systemMessage, summaryLine(SUMMARY, reportPath));
  });
});

test('corrupt state, notice, seen and lock files count as empty: the due run still starts and nothing crashes', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeJson(ctx.paths.configFile, { setupDeclinedAt: '2026-10-02T00:00:00.000Z' }); // declined: the setup invitation stays out of this test
    for (const file of [ctx.paths.stateFile, ctx.paths.noticeFile, ctx.paths.seenFile]) writeJson(file, '{{ not json');
    writeJson(ctx.paths.lockFile, '{ nope');
    const old = new Date(NOW - 5 * 60 * 1000);
    utimesSync(ctx.paths.lockFile, old, old);
    const { spawned, output } = run(ctx, { entrypoint: 'cli' });
    assert.equal(spawned.length, 1);
    assert.equal(output, '');
    assert.equal(logLines(ctx).some((l) => l.startsWith('hook error')), false);
  });
});

test('a state that is not an object, or lastSummary of the wrong type, shows nothing and does not throw', async () => {
  await withTempHome((ctx) => {
    writeJson(ctx.paths.stateFile, '[1,2]');
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    const reportPath = join(ctx.paths.reportsDir, 'r.md');
    writeJson(reportPath, '#');
    writeJson(ctx.paths.stateFile, { lastSuccessAt: iso(NOW), lastReportPath: reportPath, lastSummary: 'nope' });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(logLines(ctx).some((l) => l.startsWith('hook error')), false);
  });
});

// ---- setup notices (local-setup spec 2.4) ----------------------------------------------------------------------------

const N1 = 'memory-report is not set up \u2014 ask Claude to set it up (skill memory-report:setup)';
const N2 = 'memory-report setup is incomplete \u2014 ask Claude to finish it (skill memory-report:setup)';
const SETUP_AT = '2026-10-01T00:00:00.000Z';
const DECLINED_AFTER = '2026-10-02T00:00:00.000Z';
const DECLINED_BEFORE = '2026-09-30T00:00:00.000Z';
const writeConfig = (ctx, config) => writeJson(ctx.paths.configFile, config);
const openSetup = { allowlist: ['acme/tools'], clientTerms: ['acme'], setupAt: SETUP_AT };
const messageOf = (output) => JSON.parse(output).systemMessage;

test('N1: db present, attended, no setup keys: the invitation once per local day, notice.json gets today', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    const { output, out } = run(ctx, { entrypoint: 'cli' });
    assert.equal(out.length, 1);
    assert.deepEqual(JSON.parse(output), {
      systemMessage: N1,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: N1 },
    });
    assert.deepEqual(JSON.parse(readFileSync(ctx.paths.noticeFile, 'utf8')), { lastNoticeDate: TODAY });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '', 'the same local day shows nothing more');
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli', nowMs: NOW + 2 * DAY }).output), N1);
  });
});

test('N1 for a 0.1.0-style config (allowlist and version only, no setup keys)', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { version: 1, allowlist: ['acme/tools'], intervalDays: 7 });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), N1);
  });
});

test('N2: setupAt present with an empty allowlist', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { allowlist: [], clientTerms: ['acme'], setupAt: SETUP_AT });
    const parsed = JSON.parse(run(ctx, { entrypoint: 'cli' }).output);
    assert.equal(parsed.systemMessage, N2);
    assert.equal(parsed.hookSpecificOutput.additionalContext, N2);
  });
});

test('N2: setupAt present, allowlist set, but no client term and no acknowledgement', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { allowlist: ['acme/tools'], clientTerms: [], setupAt: SETUP_AT });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), N2);
  });
});

test('an open gate (or an acknowledged empty term list) shows no setup notice', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, openSetup);
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    writeConfig(ctx, { allowlist: ['acme/tools'], clientTerms: [], setupAt: SETUP_AT, noClientTermsAck: true });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false, 'nothing shown consumes nothing');
  });
});

test('a setupDeclinedAt later than setupAt silences both N1 and N2 cases', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { allowlist: [], setupAt: SETUP_AT, setupDeclinedAt: DECLINED_AFTER });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    writeConfig(ctx, { ...openSetup, setupDeclinedAt: DECLINED_AFTER });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false);
  });
});

test('only setupDeclinedAt (no setupAt): silent', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { allowlist: ['acme/tools'], setupDeclinedAt: DECLINED_AFTER });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false);
  });
});

test('a setupDeclinedAt earlier than setupAt does not silence N2', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { allowlist: [], setupAt: SETUP_AT, setupDeclinedAt: DECLINED_BEFORE });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), N2);
  });
});

test('an invalid setupDeclinedAt is not a decline: N2 with a valid setupAt, N1 without one', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, { ...openSetup, setupDeclinedAt: 'yesterday-ish' });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), N2);
    writeConfig(ctx, { allowlist: ['acme/tools'], clientTerms: ['acme'], setupDeclinedAt: 'yesterday-ish' });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli', nowMs: NOW + 2 * DAY }).output), N1);
  });
});

test('no claude-mem.db: no setup notice', async () => {
  await withTempHome((ctx) => {
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    writeConfig(ctx, { allowlist: [], setupAt: SETUP_AT });
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false);
  });
});

test('setup notices need an attended session and leave notice.json untouched otherwise', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    for (const entrypoint of ['sdk-ts', undefined, 'CLI']) assert.equal(run(ctx, { entrypoint }).output, '');
    assert.equal(existsSync(ctx.paths.noticeFile), false);
  });
});

test('a failure notice wins over the setup notice', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    const state = { lastAttemptAt: iso(NOW - 3600 * 1000), lastError: 'boom' };
    writeJson(ctx.paths.stateFile, state);
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), failureLine(state));
  });
});

test('an unseen report wins over the setup notice, and the setup notice does not follow on the same day', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    const reportPath = seedReport(ctx);
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli' }).output), summaryLine(SUMMARY, reportPath));
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    writeJson(ctx.paths.seenFile, { seenReport: reportPath, seenSuccessAt: JSON.parse(readFileSync(ctx.paths.stateFile, 'utf8')).lastSuccessAt });
    assert.equal(messageOf(run(ctx, { entrypoint: 'cli', nowMs: NOW + 2 * DAY }).output), N1);
  });
});

test('an unparsable config shows no setup notice (setup would refuse to write it) and does not throw', async () => {
  await withTempHome((ctx) => {
    makeDb(ctx.paths);
    writeConfig(ctx, '{ not json');
    assert.equal(run(ctx, { entrypoint: 'cli' }).output, '');
    assert.equal(logLines(ctx).some((l) => l.startsWith('hook error')), false);
  });
});

// ---- containment -----------------------------------------------------------------------------------------------------

test('a throwing injected dependency is logged, prints nothing and returns normally', async () => {
  const throwers = {
    spawn: { spawn: () => { throw new Error('spawn exploded'); } },
    isAlive: { isAlive: () => { throw new Error('isAlive exploded'); } },
    write: { write: () => { throw new Error('write exploded'); } },
  };
  for (const [name, override] of Object.entries(throwers)) {
    await withTempHome((ctx) => {
      makeDb(ctx.paths);
      if (name === 'isAlive') writeJson(ctx.paths.lockFile, { pid: 1, startedAt: iso(NOW) });
      if (name === 'write') seedReport(ctx);
      const out = [];
      const deps = {
        env: { ...ctx.env, CLAUDE_CODE_ENTRYPOINT: 'cli' }, home: ctx.home, nowMs: NOW, pluginRoot: '/p',
        spawn: () => ({ unref() {} }), isAlive: () => true, write: (s) => out.push(s), ...override,
      };
      assert.equal(sessionStart(deps), undefined);
      if (name !== 'write') assert.deepEqual(out, []);
      assert.ok(logLines(ctx).some((l) => l.startsWith('hook error') && l.includes(`${name} exploded`)), log(ctx));
    });
  }
});

test('a hook that cannot even write its log still returns normally', async () => {
  await withTempHome((ctx) => {
    writeJson(ctx.paths.stateDir, 'a file where the state directory should be');
    assert.doesNotThrow(() => run(ctx, { entrypoint: 'cli' }));
  });
});

// ---- the script ------------------------------------------------------------------------------------------------------

const runScript = (scriptDir, ctx) => {
  const env = { ...process.env, ...ctx.env, HOME: ctx.home };
  for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'MEMORY_REPORT_CHILD', 'CLAUDE_MEM_INTERNAL']) delete env[name];
  return spawnSync(process.execPath, [join(scriptDir, 'scripts', 'session-start.mjs')], { env, encoding: 'utf8', timeout: 20000 });
};

test('scripts/session-start.mjs against empty temp dirs: exit 0, empty stdout', async () => {
  await withTempHome((ctx) => {
    const res = runScript(PLUGIN, ctx);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
    assert.match(log(ctx), /hook start entrypoint=none/);
  });
});

test('scripts/session-start.mjs with lib/hook.mjs unimportable: exit 0, empty stdout, error logged', async () => {
  await withTempHome((ctx) => {
    const copy = join(ctx.home, 'plugin-copy');
    cpSync(PLUGIN, copy, { recursive: true, filter: (src) => !src.includes(`${join(PLUGIN, 'test')}`) });
    rmSync(join(copy, 'lib', 'hook.mjs'));
    const res = runScript(copy, ctx);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
    assert.match(log(ctx), /hook error/);
  });
});

test('scripts/session-start.mjs still exits 0 silently when lib/ is gone entirely', async () => {
  await withTempHome((ctx) => {
    const copy = join(ctx.home, 'plugin-copy');
    cpSync(join(PLUGIN, 'scripts'), join(copy, 'scripts'), { recursive: true });
    const res = runScript(copy, ctx);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  });
});

// ---- hooks.json ------------------------------------------------------------------------------------------------------

test('hooks.json registers SessionStart for startup|resume with the 10 s timeout', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, {
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"', timeout: 10 }],
      }],
    },
  });
});
