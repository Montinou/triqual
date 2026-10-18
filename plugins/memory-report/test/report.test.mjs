// One generator run (spec 6.1, 6.5, 8): isoWeek, allowlist suggestions and runReport end to end on fixture databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canImportSqlite, openConfig, withTempHome } from './helpers.mjs';
import { readState } from '../lib/state.mjs';
import { isoWeek, runReport } from '../lib/report.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;
const now = () => NOW;
const alive = () => true;
const dead = () => false;

const obs = (id, project, over = {}) => ({
  id, project, type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`, facts: '["fact"]',
  created_at_epoch: NOW - DAY - id * 1000, ...over,
});

const goodResult = () => ({
  rules: [{ title: 'rule title', target: 'global', text: 'x', rationale: 'r', evidence: [1] }],
  skills: [{ title: 'skill title', kind: 'new', skill: 's', change: 'c', rationale: 'r', evidence: [2] }],
  stale: [{ older: 1, newer: 2, relation: 'supersedes', reason: 'r' }],
});
const okRun = (data) => ({
  code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: data }), stderr: '', timedOut: false, spawnError: false, envKeys: [],
});
const fakeRunner = (result) => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return typeof result === 'function' ? result(args) : result;
  };
  return { runner, calls };
};

// Writes the claude-mem database and optional config file under the temp home, then runs fn.
async function withFixture({ observations = [], sessions = [], config = null, writeDb = true, setup } = {}, fn) {
  await withTempHome(async (env) => {
    if (writeDb) {
      mkdirSync(dirname(env.paths.dbFile), { recursive: true });
      createClaudeMemDb(env.paths.dbFile, { observations, sessions: typeof sessions === 'function' ? sessions(env.home) : sessions });
    }
    if (config !== null) {
      mkdirSync(dirname(env.paths.configFile), { recursive: true });
      writeFileSync(env.paths.configFile, typeof config === 'string' ? config : JSON.stringify(config));
    }
    if (setup) setup(env);
    await fn(env);
  });
}

const run = (env, over = {}) => runReport({ paths: env.paths, env: env.env, mode: 'now', now, isAlive: dead, ...over });
const readLog = (paths) => (existsSync(paths.logFile) ? readFileSync(paths.logFile, 'utf8') : '');
const reportFiles = (paths) => (existsSync(paths.reportsDir) ? readdirSync(paths.reportsDir) : []);

// ---- isoWeek -------------------------------------------------------------------------------------------------------

test('isoWeek: ISO-8601 year and week of the local date', () => {
  assert.equal(isoWeek(new Date(2026, 9, 7)), '2026-W41');
  assert.equal(isoWeek(new Date(2026, 11, 31)), '2026-W53');
  assert.equal(isoWeek(new Date(2027, 0, 1)), '2026-W53');
  assert.equal(isoWeek(new Date(2027, 0, 3)), '2026-W53');
  assert.equal(isoWeek(new Date(2027, 0, 4)), '2027-W01');
  assert.equal(isoWeek(new Date(2024, 11, 30)), '2025-W01');
});

// ---- failures that need no database ---------------------------------------------------------------------------------

test('a Node older than 22.16 fails with a fixed lastError, after lastAttemptAt, and releases the lock', async () => {
  await withFixture({}, async (env) => {
    for (const nodeVersion of ['22.15.0', '20.19.0']) {
      assert.equal(await run(env, { nodeVersion }), 1);
      const state = readState(env.paths);
      assert.equal(state.lastError, 'Node 22.16 or later required');
      assert.equal(state.lastAttemptAt, new Date(NOW).toISOString());
      assert.equal(state.lastSuccessAt, undefined);
      assert.ok(!existsSync(env.paths.lockFile));
    }
    assert.deepEqual(reportFiles(env.paths), []);
  });
});

test('a missing claude-mem.db is exit 1 with lastError claude-mem.db not found and no report', async () => {
  await withFixture({ writeDb: false }, async (env) => {
    assert.equal(await run(env), 1);
    const state = readState(env.paths);
    assert.equal(state.lastError, 'claude-mem.db not found');
    assert.equal(state.lastAttemptAt, new Date(NOW).toISOString());
    assert.deepEqual(reportFiles(env.paths), []);
    assert.ok(!existsSync(env.paths.lockFile));
    assert.match(readLog(env.paths), /run-failed claude-mem\.db not found/);
  });
});

test('a run trims an oversized run.log to its last 64 KiB before it logs run-start', async () => {
  await withFixture({ writeDb: false }, async (env) => {
    mkdirSync(env.paths.stateDir, { recursive: true });
    const old = Array.from({ length: 6000 }, (_, i) => `2026-10-01T00:00:00.000Z old-${String(i).padStart(5, '0')} ${'y'.repeat(40)}`);
    writeFileSync(env.paths.logFile, `${old.join('\n')}\n`);
    assert.equal(await run(env), 1); // no database: the run still logs run-start, then fails
    const log = readLog(env.paths);
    assert.ok(Buffer.byteLength(log) < 65 * 1024, `run.log is ${Buffer.byteLength(log)} bytes`);
    assert.ok(log.includes(old.at(-1)), 'the newest earlier line is kept');
    assert.ok(!log.includes('old-00000'), 'the oldest lines are gone');
    assert.ok(old.includes(log.split('\n')[0]), 'the cut is at a line boundary');
    assert.match(log, /run-start now\n[^\n]*run-failed claude-mem\.db not found\n$/);
  });
});

test('a failed dynamic import is recorded as a fixed lastError, never the import error text', async () => {
  await withFixture({}, async (env) => {
    const importer = async () => { throw new Error('IMPORTBOOM secret detail'); };
    assert.equal(await run(env, { importer }), 1);
    const state = readState(env.paths);
    assert.equal(state.lastError, 'memory-report modules could not be loaded');
    assert.ok(!JSON.stringify(state).includes('IMPORTBOOM'));
    assert.ok(!readLog(env.paths).includes('IMPORTBOOM'));
    assert.ok(!existsSync(env.paths.lockFile));
  });
});

test('a lock held by a live pid is exit 2: nothing is written and the lock stays', async () => {
  await withFixture({}, async (env) => {
    mkdirSync(env.paths.stateDir, { recursive: true });
    const lock = JSON.stringify({ pid: 4242, startedAt: new Date(NOW).toISOString() });
    writeFileSync(env.paths.lockFile, lock);
    assert.equal(await run(env, { isAlive: alive }), 2);
    assert.equal(readFileSync(env.paths.lockFile, 'utf8'), lock);
    assert.deepEqual(readState(env.paths), {});
    assert.deepEqual(reportFiles(env.paths), []);
  });
});

test('generate exits 0 without running when the last success is recent', async () => {
  await withFixture({}, async (env) => {
    mkdirSync(env.paths.stateDir, { recursive: true });
    writeFileSync(env.paths.stateFile, JSON.stringify({ lastSuccessAt: new Date(NOW - DAY).toISOString() }));
    assert.equal(await run(env, { mode: 'generate' }), 0);
    assert.deepEqual(reportFiles(env.paths), []);
    assert.equal(readState(env.paths).lastAttemptAt, undefined);
    assert.ok(!existsSync(env.paths.lockFile));
  });
});

// ---- full runs -----------------------------------------------------------------------------------------------------

test('a due generate run writes the report and the state', { skip }, async () => {
  const observations = [obs(1, 'proj'), obs(2, 'proj')];
  await withFixture({ observations, config: openConfig(['proj']) }, async (env) => {
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { mode: 'generate', runner }), 0);
    assert.equal(calls.length, 1);
    const reportPath = join(env.paths.reportsDir, '2026-W41.md');
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    const text = readFileSync(reportPath, 'utf8');
    assert.match(text, /^# Memory report 2026-W41\n/);
    for (const heading of ['Summary', 'Hygiene', 'Storage', 'Chroma health', 'Insights', 'Allowlist suggestions']) {
      assert.ok(text.includes(`## ${heading}\n`), heading);
    }
    assert.ok(text.includes('rule title'));
    const state = readState(env.paths);
    assert.equal(state.lastSuccessAt, new Date(NOW).toISOString());
    assert.equal(state.lastAttemptAt, new Date(NOW).toISOString());
    assert.equal(state.lastReportPath, reportPath);
    assert.equal(state.lastError, undefined);
    assert.deepEqual(state.lastSummary, { week: '2026-W41', insights: 'ok', rules: 1, skills: 1, stale: 1, chroma: 'OK' });
    assert.ok(!existsSync(env.paths.lockFile));
  });
});

test('success clears an earlier lastError and a stale lock is taken over', { skip }, async () => {
  await withFixture({ observations: [] }, async (env) => {
    mkdirSync(env.paths.stateDir, { recursive: true });
    writeFileSync(env.paths.stateFile, JSON.stringify({ lastError: 'earlier failure', lastAttemptAt: new Date(NOW - 3 * DAY).toISOString() }));
    writeFileSync(env.paths.lockFile, JSON.stringify({ pid: 4242, startedAt: new Date(NOW - 3600000).toISOString() }));
    assert.equal(await run(env, { isAlive: dead }), 0);
    const state = readState(env.paths);
    assert.equal(state.lastError, undefined);
    assert.ok(!existsSync(env.paths.lockFile));
  });
});

test('an empty database gives a complete report and never calls the model', { skip }, async () => {
  await withFixture({ observations: [], config: openConfig(['proj']) }, async (env) => {
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { runner }), 0);
    assert.equal(calls.length, 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    for (const heading of ['Summary', 'Hygiene', 'Storage', 'Chroma health', 'Insights', 'Allowlist suggestions']) {
      assert.ok(text.includes(`## ${heading}\n`), heading);
    }
    assert.ok(!text.includes('Unavailable:'));
    assert.deepEqual(readState(env.paths).lastSummary, { week: '2026-W41', insights: 'ok', rules: 0, skills: 0, stale: 0, chroma: 'OK' });
  });
});

// ---- the insights gate (local-setup spec 2.2, 2.3) -----------------------------------------------------------------

const R1 = 'Not set up: insights are off until you run the memory-report setup (ask Claude: "set up memory-report").';
const R2 = 'Setup incomplete: insights are off until you finish the memory-report setup (ask Claude: "set up memory-report").';

// The Insights section body of a written report.
const insightsOf = (text) => text.split('## Insights\n\n')[1].split('\n\n## Allowlist suggestions')[0];

// A closed gate: the runner is never called, no work directory exists, the Insights section is the reason alone.
async function assertOff(config, reason) {
  await withFixture({ observations: [obs(1, 'proj'), obs(2, 'proj')], config }, async (env) => {
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { runner }), 0);
    assert.equal(calls.length, 0, 'the model runner is never called while the gate is closed');
    assert.ok(!existsSync(env.paths.workDir), 'no work directory is created');
    const state = readState(env.paths);
    assert.deepEqual(state.lastSummary, { week: '2026-W41', insights: 'off', rules: 0, skills: 0, stale: 0, chroma: 'OK' });
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.equal(insightsOf(text), reason);
    assert.ok(text.includes(`- Insights: off (${reason})\n`));
    assert.ok(!text.includes('untrusted model output'));
    assert.ok(!text.includes('### Selection'));
    for (const heading of ['Hygiene', 'Storage', 'Chroma health']) assert.ok(text.includes(`## ${heading}\n`), heading);
    assert.ok(text.includes('### Empty observations'), 'hygiene still runs');
  });
}

test('no setupAt: insights are off with R1 and the runner is never called', { skip }, () => assertOff({ allowlist: ['proj'], clientTerms: ['acme'] }, R1));

test('no config file at all: insights are off with R1 (the defaults fail closed)', { skip }, () => assertOff(null, R1));

test('an unparsable config file: insights are off with R1', { skip }, () => assertOff('{ not json', R1));

test('a setupDeclinedAt later than setupAt: insights are off with R1', { skip }, () => assertOff(
  openConfig(['proj'], { setupDeclinedAt: '2026-10-02T00:00:00.000Z' }),
  R1,
));

test('setupAt with an empty allowlist: insights are off with R2', { skip }, () => assertOff(openConfig([]), R2));

test('setupAt, allowlist and an invalid clientTerms string: insights are off with R2', { skip }, () => assertOff(openConfig(['proj'], { clientTerms: 'acme' }), R2));

test('setupAt, allowlist and neither a term nor the acknowledgment: insights are off with R2', { skip }, () => assertOff(openConfig(['proj'], { clientTerms: [] }), R2));

test('a term that folds to nothing does not open the gate: off with R2', { skip }, () => assertOff(openConfig(['proj'], { clientTerms: ['\u0301', '\\u200b'] }), R2));

test('noClientTermsAck opens the gate and the runner is called as before', { skip }, async () => {
  await withFixture({ observations: [obs(1, 'proj')], config: openConfig(['proj'], { clientTerms: [], noClientTermsAck: true }) }, async (env) => {
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { runner }), 0);
    assert.equal(calls.length, 1);
    assert.equal(readState(env.paths).lastSummary.insights, 'ok');
  });
});

test('an open gate calls the runner once and renders the insights as before', { skip }, async () => {
  await withFixture({ observations: [obs(1, 'proj'), obs(2, 'proj')], config: openConfig(['proj']) }, async (env) => {
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { runner }), 0);
    assert.equal(calls.length, 1);
    const state = readState(env.paths);
    assert.equal(state.lastSummary.insights, 'ok');
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.ok(insightsOf(text).includes('untrusted model output'));
    assert.ok(text.includes('rule title'));
  });
});

test('a collector that throws makes only its section unavailable', { skip }, async () => {
  await withFixture({ observations: [obs(1, 'proj')], config: openConfig(['proj']) }, async (env) => {
    const { realFs } = await import('../lib/sources.mjs');
    // Storage reads the WAL size through fs.stat; the other collectors never stat that path.
    const fs = { ...realFs, stat(path) { if (path === env.paths.walFile) throw new Error('STATBOOM'); return realFs.stat(path); } };
    const { runner } = fakeRunner(okRun({ rules: [], skills: [], stale: [] }));
    assert.equal(await run(env, { runner, sourcesOptions: { fs } }), 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    assert.equal((text.match(/Unavailable:/g) ?? []).length, 1);
    assert.match(text, /## Storage\n\nUnavailable: `STATBOOM`/);
    assert.match(text, /### Empty observations/);
    assert.match(text, /Status: OK/);
    assert.ok(!readLog(env.paths).includes('STATBOOM'));
  });
});

test('an unavailable Chroma section makes lastSummary.chroma ATTENTION', { skip }, async () => {
  await withFixture({ observations: [] }, async (env) => {
    const { realFs } = await import('../lib/sources.mjs');
    // The crash directory listing is the Chroma collector's only directory read (on darwin).
    const fs = { ...realFs, listDir(path) { if (path === env.paths.crashDir) throw new Error('CRASHBOOM'); return realFs.listDir(path); } };
    assert.equal(await run(env, { sourcesOptions: { fs, platform: 'darwin' } }), 0);
    const state = readState(env.paths);
    assert.equal(state.lastSummary.chroma, 'ATTENTION');
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.match(text, /## Chroma health\n\nUnavailable: `CRASHBOOM`/);
    assert.match(text, /- Attention: Chroma section unavailable/);
  });
});

test('a collector error message is cut to 120 characters on one line', { skip }, async () => {
  await withFixture({ observations: [] }, async (env) => {
    const { realFs } = await import('../lib/sources.mjs');
    const fs = { ...realFs, stat(path) { if (path === env.paths.walFile) throw new Error(`A\nB${'x'.repeat(300)}`); return realFs.stat(path); } };
    assert.equal(await run(env, { sourcesOptions: { fs } }), 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('Unavailable:'));
    assert.ok(line.includes('A B'));
    assert.ok(!line.includes('x'.repeat(120)), 'the message is cut');
    assert.ok(line.includes('x'.repeat(100)));
  });
});

test('a thrown insights call renders as the fixed string insights failed', { skip }, async () => {
  await withFixture({ observations: [obs(1, 'proj')], config: openConfig(['proj']) }, async (env) => {
    const { runner } = fakeRunner(() => { throw new Error('RUNNERBOOM'); });
    assert.equal(await run(env, { runner }), 0);
    const state = readState(env.paths);
    assert.equal(state.lastSummary.insights, 'unavailable');
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.match(text, /## Insights[\s\S]*Unavailable: `insights failed`/);
    assert.ok(!text.includes('RUNNERBOOM'));
    assert.ok(!readLog(env.paths).includes('RUNNERBOOM'));
  });
});

test('a failing runner: neither the report nor run.log carries its stdout or stderr', { skip }, async () => {
  await withFixture({ observations: [obs(1, 'proj')], config: openConfig(['proj']) }, async (env) => {
    const { runner } = fakeRunner({ code: 1, stdout: 'LEAKMARKER out', stderr: 'LEAKMARKER err', timedOut: false, spawnError: false, envKeys: [] });
    assert.equal(await run(env, { runner }), 0);
    const state = readState(env.paths);
    assert.equal(state.lastSummary.insights, 'unavailable');
    const text = readFileSync(state.lastReportPath, 'utf8');
    assert.ok(text.includes('claude exited with code 1'));
    assert.ok(!text.includes('LEAKMARKER'));
    assert.ok(!readLog(env.paths).includes('LEAKMARKER'));
    assert.ok(!JSON.stringify(state).includes('LEAKMARKER'));
  });
});

test('run.log never carries fixture titles or narratives', { skip }, async () => {
  const observations = [
    obs(1, 'proj', { title: 'TITLEMARK one', narrative: 'NARRMARK one' }),
    obs(2, 'proj', { title: 'TITLEMARK one', narrative: 'NARRMARK two' }),
  ];
  await withFixture({ observations, config: openConfig(['proj']) }, async (env) => {
    const { runner } = fakeRunner(okRun(goodResult()));
    assert.equal(await run(env, { runner }), 0);
    const log = readLog(env.paths);
    assert.ok(log.length > 0);
    assert.ok(!log.includes('TITLEMARK'));
    assert.ok(!log.includes('NARRMARK'));
    assert.match(log, /run-start/);
    assert.match(log, /run-ok 2026-W41/);
  });
});

test('an invalid maxObservations is logged as config-warning and listed in the Summary', { skip }, async () => {
  await withFixture({ observations: [], config: { maxObservations: -5 } }, async (env) => {
    assert.equal(await run(env), 0);
    assert.match(readLog(env.paths), /config-warning maxObservations\n/);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    const summary = text.split('## Hygiene')[0];
    assert.ok(summary.includes('invalid config key: maxObservations; using default'));
  });
});

test('an unparsable config file is logged and warned, and the run uses the defaults', { skip }, async () => {
  await withFixture({ observations: [], config: '{ not json' }, async (env) => {
    assert.equal(await run(env), 0);
    assert.match(readLog(env.paths), /config-warning unparsable\n/);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    assert.ok(text.split('## Hygiene')[0].includes('config file is not valid JSON'));
  });
});

test('hygiene duplicate titles are shown only when they pass the content filter', { skip }, async () => {
  const observations = [
    obs(1, 'proj', { title: 'Globex sync notes' }),
    obs(2, 'proj', { title: 'Globex sync notes' }),
    obs(3, 'proj', { title: 'Repeated setup note' }),
    obs(4, 'proj', { title: 'Repeated setup note' }),
    obs(5, 'proj', { title: 'Repeated setup note' }),
  ];
  await withFixture({ observations, config: openConfig(['proj'], { clientTerms: ['globex'] }) }, async (env) => {
    const { runner } = fakeRunner(okRun({ rules: [], skills: [], stale: [] }));
    assert.equal(await run(env, { runner }), 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    assert.ok(text.includes('Repeated setup note'));
    assert.ok(!text.includes('Globex sync notes'));
  });
});

test('the report lists suggestions for uncovered projects under a root, with their note counts', { skip }, async () => {
  const observations = [obs(1, 'newproj'), obs(2, 'newproj'), obs(3, 'elsewhere')];
  const sessions = (home) => [
    { project: 'newproj', cwd: join(home, 'Code', 'newproj'), started_at_epoch: NOW - DAY },
    { project: 'elsewhere', cwd: join(home, 'Other', 'elsewhere'), started_at_epoch: NOW - DAY },
  ];
  await withFixture({
    observations,
    sessions,
    config: { suggestRoots: ['~/Code'] },
  }, async (env) => {
    assert.equal(await run(env), 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    const section = text.split('## Allowlist suggestions')[1];
    assert.ok(section.includes('`newproj` \u2014 2 notes'));
    assert.ok(section.includes("triqual memory allow 'newproj'"));
    assert.ok(!section.includes('elsewhere'));
  });
});

test('the report suggestions count worktree keys under their base and use the 7-day window', { skip }, async () => {
  const observations = [
    obs(1, 'wtproj'), obs(2, 'wtproj/branch'), obs(3, 'wtproj', { created_at_epoch: NOW - 30 * DAY }),
  ];
  await withFixture({ observations }, async (env) => {
    assert.equal(await run(env), 0);
    const section = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8').split('## Allowlist suggestions')[1];
    assert.ok(section.includes('`wtproj` \u2014 2 notes'));
  });
});

test('the report suggestions drop a name with a client term, even one hidden by a zero-width character, and keep 10', { skip }, async () => {
  const names = ['globex-app', `glo${String.fromCharCode(0x200b)}bex-tools`, 'initech'];
  const observations = [
    ...names.map((name, i) => obs(900 + i, name)),
    ...Array.from({ length: 12 }, (_, i) => obs(100 + i, `many${String(i).padStart(2, '0')}`)),
  ];
  await withFixture({ observations, config: { clientTerms: ['globex'] } }, async (env) => {
    assert.equal(await run(env), 0);
    const section = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8').split('## Allowlist suggestions')[1];
    assert.ok(!section.includes('globex'));
    assert.ok(!section.includes('bex-tools'));
    assert.equal(section.split('triqual memory allow').length - 1, 10);
    assert.ok(section.includes('initech'));
  });
});

test('the report counts names of one repository as a number only (see triqual memory repos)', { skip }, async () => {
  const sessions = (home) => ['twina', 'twinb'].map((name) => {
    const cwd = join(home, 'code', name);
    mkdirSync(cwd, { recursive: true });
    return { memory_session_id: `s-${name}`, project: name, cwd, started_at_epoch: NOW - DAY };
  });
  const observations = [obs(1, 'twina', { memory_session_id: 's-twina' }), obs(2, 'twinb', { memory_session_id: 's-twinb' })];
  await withFixture({ observations, sessions }, async (env) => {
    const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false });
    const run = async (cmd, args) => {
      if (cmd === 'stat') return ok('stat output');
      const rest = args.slice(2).join(' ');
      if (rest === 'rev-parse --show-toplevel') return ok(`${realpathSync(args[1])}\n`);
      if (rest === 'remote get-url origin') return ok('https://github.com/acme/twin.git\n');
      return ok('origin\thttps://github.com/acme/twin.git (fetch)\norigin\thttps://github.com/acme/twin.git (push)\n');
    };
    assert.equal(await runReport({ paths: env.paths, env: env.env, mode: 'now', now, isAlive: dead, deps: { run, sshHost: async (h) => h } }), 0);
    const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
    const section = text.split('## Allowlist suggestions')[1];
    assert.ok(section.includes('\nSame repository, several names: 1 (see triqual memory repos)\n'), section);
    for (const leak of ['github.com', 'acme/twin', join('code', 'twina'), 'project merge', '.backup']) assert.ok(!text.includes(leak), leak);
    assert.ok(!readLog(env.paths).includes('acme'));
  });
});

test('a report that cannot be written fails with report could not be written', { skip }, async () => {
  await withFixture({ observations: [] }, async (env) => {
    mkdirSync(env.paths.stateDir, { recursive: true });
    writeFileSync(env.paths.reportsDir, 'a file where the reports directory should be');
    assert.equal(await run(env), 1);
    assert.equal(readState(env.paths).lastError, 'report could not be written');
    assert.ok(!existsSync(env.paths.lockFile));
  });
});

// ---- the Review tiers section ---------------------------------------------------------------------------------------

// The per-tier object `triqual role-eval summary --by-tier --json` prints (the role-eval-cli fixture of the methodology plugin).
const TIERS_FIXTURE = {
  heavy: { tasks: 1, raised: 1, hunterConfirmedRate: 0.5, specConfirmedPerTask: 2, fixRoundsPerTask: 3, blocked: 0, escapesPerTask: 1 },
  standard: { tasks: 1, raised: 0, hunterConfirmedRate: 0.5, specConfirmedPerTask: 0, fixRoundsPerTask: 1, blocked: 1, escapesPerTask: 0 },
  light: { tasks: 0, raised: 0, hunterConfirmedRate: null, specConfirmedPerTask: null, fixRoundsPerTask: null, blocked: 0, escapesPerTask: null },
};

// A fake `triqual` executable in a directory put first on PATH: it records its arguments, then runs `body` (shell).
// Returns the env for the run and the file the arguments land in.
function fakeTriqual(home, body) {
  const bin = join(home, 'fake-bin');
  const argsFile = join(home, 'triqual-args.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'triqual'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n${body}\n`);
  chmodSync(join(bin, 'triqual'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, argsFile };
}

// Runs a report with the fake triqual and returns { code, text, state }.
async function reportWithTriqual(env, body, deps) {
  const fake = fakeTriqual(env.home, body);
  const code = await run(env, { env: { ...env.env, PATH: fake.PATH }, deps });
  const text = readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8');
  return { code, text, state: readState(env.paths), argsFile: fake.argsFile };
}

const shQuote = (json) => `printf '%s' '${JSON.stringify(json)}'`;

test('a triqual summary renders the Review tiers section, one row per tier, asked for the week window', { skip }, async () => {
  await withFixture({}, async (env) => {
    const { code, text, argsFile } = await reportWithTriqual(env, shQuote(TIERS_FIXTURE));
    assert.equal(code, 0);
    // The window starts 7 days before NOW (2026-10-07 12:00 UTC).
    assert.deepEqual(readFileSync(argsFile, 'utf8').trimEnd().split('\n'), ['role-eval', 'summary', '--by-tier', '--since', '2026-09-30', '--json']);
    const section = text.split('## Review tiers\n\n')[1].split('\n\n## ')[0];
    const rows = section.split('\n').slice(2);
    assert.deepEqual(rows, [
      '| heavy | 1 | 1 | 50.0% | 2.00 | 3.00 | 0 | 1.00 |',
      '| standard | 1 | 0 | 50.0% | 0.00 | 1.00 | 1 | 0.00 |',
      '| light | 0 | 0 | n/a | n/a | n/a | 0 | n/a |',
    ]);
  });
});

test('no Review tiers section when triqual prints nothing, prints a failure, hangs, is missing or prints no data', { skip }, async () => {
  const noData = Object.fromEntries(Object.keys(TIERS_FIXTURE).map((tier) => [tier, { ...TIERS_FIXTURE.light }]));
  const cases = [
    ['empty output', ':', undefined],
    ['unparseable output', "printf 'not json'", undefined],
    ['a JSON value that is not the tier object', "printf '[1,2]'", undefined],
    ['a tier object without a tier', `printf '%s' '${JSON.stringify({ heavy: TIERS_FIXTURE.heavy })}'`, undefined],
    ['a non-zero exit with a valid object on stdout', `${shQuote(TIERS_FIXTURE)}; exit 1`, undefined],
    ['a hang past the timeout', 'sleep 5', { reviewTiersTimeoutMs: 200 }],
    ['all three tiers empty', shQuote(noData), undefined],
  ];
  for (const [label, body, deps] of cases) {
    await withFixture({}, async (env) => {
      const { code, text, state } = await reportWithTriqual(env, body, deps);
      assert.equal(code, 0, label);
      assert.ok(!text.includes('Review tiers'), label);
      assert.equal(state.lastError, undefined, label);
      assert.ok(!readLog(env.paths).includes('run-failed'), label);
    });
  }
});

test('no Review tiers section and no error when triqual is not on PATH', { skip }, async () => {
  await withFixture({}, async (env) => {
    assert.equal(await run(env, { env: { ...env.env, PATH: join(env.home, 'empty-bin') } }), 0);
    assert.ok(!readFileSync(join(env.paths.reportsDir, '2026-W41.md'), 'utf8').includes('Review tiers'));
    assert.equal(readState(env.paths).lastError, undefined);
  });
});
