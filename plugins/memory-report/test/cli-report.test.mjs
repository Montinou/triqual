// `triqual memory status | report [--now]` and the internal `generate` (spec 4.3, 5, 8) through main(), with a fake runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main } from '../cli/memory.mjs';
import { readSeen, readState } from '../lib/state.mjs';
import { summaryLine } from '../lib/render.mjs';
import { canImportSqlite, openConfig, withTempHome } from './helpers.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;

const obs = (id) => ({
  id, project: 'proj', type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`, facts: '["fact"]',
  created_at_epoch: NOW - DAY - id * 1000,
});
const okRun = {
  code: 0,
  stdout: JSON.stringify({
    subtype: 'success',
    is_error: false,
    structured_output: {
      rules: [{ title: 'rule title', target: 'global', text: 'x', rationale: 'r', evidence: [1] }],
      skills: [],
      stale: [],
    },
  }),
  stderr: '',
  timedOut: false,
  spawnError: false,
  envKeys: [],
};
const makeDeps = (over = {}) => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return okRun;
  };
  return { deps: { runner, now: () => NOW, isAlive: () => false, ...over }, calls };
};

// Runs main with captured streams.
async function run(env, argv, deps) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, deps });
  return { code, out, err };
}

// A temp home with a claude-mem database and an allowlist covering the fixture project.
async function withDb(fn) {
  await withTempHome(async ({ env, paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, { observations: [obs(1), obs(2)] });
    mkdirSync(dirname(paths.configFile), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify(openConfig(['proj'])));
    await fn({ env, paths });
  });
}

// ---- report ----------------------------------------------------------------------------------------------------------

test('report without a report prints "no report yet", exit 0, and writes no seen.json', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['report']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'no report yet\n');
  assert.equal(r.err, '');
  assert.ok(!existsSync(paths.seenFile));
}));

test('report after a run prints the path and the summary line and writes seen.json', { skip }, () => withDb(async ({ env, paths }) => {
  const { deps } = makeDeps();
  assert.equal((await run(env, ['report', '--now'], deps)).code, 0);
  const state = readState(paths);
  assert.ok(!existsSync(paths.seenFile));

  const r = await run(env, ['report'], deps);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, `${state.lastReportPath}\n${summaryLine(state.lastSummary, state.lastReportPath)}\n`);
  assert.deepEqual(readSeen(paths), { seenReport: state.lastReportPath, seenSuccessAt: state.lastSuccessAt });
}));

test('report only reads the state: it never rewrites state.json', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(paths.stateDir, { recursive: true });
  const state = {
    lastSuccessAt: '2026-10-07T12:00:00.000Z',
    lastReportPath: join(paths.reportsDir, '2026-W41.md'),
    lastSummary: { week: '2026-W41', insights: 'unavailable', rules: 0, skills: 0, stale: 0, chroma: 'ATTENTION' },
  };
  writeFileSync(paths.stateFile, JSON.stringify(state));
  const before = readFileSync(paths.stateFile, 'utf8');
  const r = await run(env, ['report']);
  assert.equal(r.code, 0);
  assert.match(r.out, /insights unavailable · Chroma ATTENTION/);
  assert.equal(readFileSync(paths.stateFile, 'utf8'), before);
  assert.deepEqual(readSeen(paths), { seenReport: state.lastReportPath, seenSuccessAt: state.lastSuccessAt });
}));

test('report --now with no setup writes an off report: the runner is not called and the summary line says insights off', { skip }, () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.dbFile), { recursive: true });
  createClaudeMemDb(paths.dbFile, { observations: [obs(1), obs(2)] });
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ allowlist: ['proj'], clientTerms: ['acme'] })); // no setupAt
  const { deps, calls } = makeDeps();
  const r = await run(env, ['report', '--now'], deps);
  assert.equal(r.code, 0);
  assert.equal(calls.length, 0);
  assert.match(r.out, /insights off · Chroma OK/);
  assert.equal(readState(paths).lastSummary.insights, 'off');
  const again = await run(env, ['report'], deps);
  assert.match(again.out, /insights off · Chroma OK/);
}));

// ---- report --now ------------------------------------------------------------------------------------------------------

test('report --now runs in the foreground, exit 0, even when the run is not due', { skip }, () => withDb(async ({ env, paths }) => {
  const { deps, calls } = makeDeps();
  assert.equal((await run(env, ['report', '--now'], deps)).code, 0);
  assert.equal((await run(env, ['report', '--now'], deps)).code, 0); // second run: not due, still runs
  assert.equal(calls.length, 2);
  assert.ok(existsSync(readState(paths).lastReportPath));
}));

test('report --now announces on stderr that it can take a few minutes; stdout keeps only the path and summary', { skip }, () => withDb(async ({ env }) => {
  const r = await run(env, ['report', '--now'], makeDeps().deps);
  assert.equal(r.code, 0);
  assert.equal(r.err, 'memory-report: generating the report, this can take a few minutes…\n');
  assert.ok(!r.out.includes('generating'));
}));

test('report --now also announces itself when the run then fails', () => withTempHome(async ({ env }) => {
  const r = await run(env, ['report', '--now'], makeDeps().deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /^memory-report: generating the report, this can take a few minutes…\n/);
}));

test('report --now with a live lock holder exits 2 and runs nothing', { skip }, () => withDb(async ({ env, paths }) => {
  mkdirSync(paths.stateDir, { recursive: true });
  const lock = JSON.stringify({ pid: 4242, startedAt: new Date(NOW).toISOString() });
  writeFileSync(paths.lockFile, lock);
  const { deps, calls } = makeDeps({ isAlive: () => true });
  const r = await run(env, ['report', '--now'], deps);
  assert.equal(r.code, 2);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(paths.lockFile, 'utf8'), lock);
}));

test('report --now exits 1 when the run fails (no claude-mem.db)', () => withTempHome(async ({ env, paths }) => {
  const { deps } = makeDeps();
  const r = await run(env, ['report', '--now'], deps);
  assert.equal(r.code, 1);
  assert.equal(readState(paths).lastError, 'claude-mem.db not found');
}));

// ---- generate ----------------------------------------------------------------------------------------------------------

test('generate never prints the progress line', { skip }, () => withDb(async ({ env }) => {
  const r = await run(env, ['generate'], makeDeps().deps);
  assert.equal(r.err, '');
  assert.equal(r.out, '');
}));

test('generate prints nothing, runs when due and returns the run code', { skip }, () => withDb(async ({ env, paths }) => {
  const { deps, calls } = makeDeps();
  const r = await run(env, ['generate'], deps);
  assert.deepEqual(r, { code: 0, out: '', err: '' });
  assert.equal(calls.length, 1);
  assert.equal(readState(paths).lastSuccessAt, new Date(NOW).toISOString());

  const again = await run(env, ['generate'], deps); // no longer due
  assert.deepEqual(again, { code: 0, out: '', err: '' });
  assert.equal(calls.length, 1);
}));

test('generate prints nothing on failure and on a held lock either', () => withTempHome(async ({ env, paths }) => {
  const { deps } = makeDeps();
  assert.deepEqual(await run(env, ['generate'], deps), { code: 0, out: '', err: '' }); // no database: not due

  mkdirSync(dirname(paths.dbFile), { recursive: true });
  writeFileSync(paths.dbFile, 'present, never opened: the Node check fails first');
  const failed = await run(env, ['generate'], makeDeps({ nodeVersion: '20.19.0' }).deps);
  assert.equal(failed.code, 1);
  assert.equal(failed.out, '');
  assert.equal(failed.err, '');
  assert.equal(readState(paths).lastError, 'Node 22.16 or later required');

  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.lockFile, JSON.stringify({ pid: 4242, startedAt: new Date(NOW).toISOString() }));
  const locked = await run(env, ['generate'], makeDeps({ isAlive: () => true }).deps);
  assert.deepEqual(locked, { code: 2, out: '', err: '' });
}));

test('--help omits generate and still lists status and report', async () => {
  const r = await run({}, ['--help']);
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes('generate'));
  assert.match(r.out, /status/);
  assert.match(r.out, /report \[--now\]/);
  assert.match(r.out, /--now builds one in the foreground \(it can take a few minutes\)/);
});

// ---- status ------------------------------------------------------------------------------------------------------------

test('status on a fresh install says never / none and exits 0', () => withTempHome(async ({ env }) => {
  const r = await run(env, ['status']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, [
    'last success: never',
    'last attempt: never',
    'last error: none',
    'lock holder: none',
    'setup: not set up',
    'insights gate: off (Not set up: insights are off until you run the memory-report setup (ask Claude: "set up memory-report").)',
    'client terms: 0',
    'never-send: 0',
    'allowlisted projects: 0',
    'config warnings: none',
    '',
  ].join('\n'));
}));

test('status prints last success, attempt, error, lock holder and config warnings', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify({
    lastSuccessAt: '2026-09-30T08:00:00.000Z',
    lastAttemptAt: '2026-10-07T09:00:00.000Z',
    lastError: 'claude-mem.db not found',
    lastSummary: { week: '2026-W40', insights: 'ok', rules: 1, skills: 1, stale: 1, chroma: 'OK' },
  }));
  writeFileSync(paths.lockFile, JSON.stringify({ pid: 4242, startedAt: '2026-10-07T09:00:00.000Z' }));
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ intervalDays: 'often' }));

  const r = await run(env, ['status']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(r.out.split('\n'), [
    'last success: 2026-09-30T08:00:00.000Z',
    'last attempt: 2026-10-07T09:00:00.000Z',
    'last error: claude-mem.db not found',
    'lock holder: pid 4242 since 2026-10-07T09:00:00.000Z',
    'setup: not set up',
    'insights gate: off (Not set up: insights are off until you run the memory-report setup (ask Claude: "set up memory-report").)',
    'client terms: 0',
    'never-send: 0',
    'allowlisted projects: 0',
    'config warnings:',
    '  invalid config key: intervalDays; using default',
    '',
  ]);
}));

test('status reports an unreadable lock and keeps every value on one line', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify({ lastError: 'line one\nline two' }));
  writeFileSync(paths.lockFile, '');
  const r = await run(env, ['status']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^last error: line one line two$/m);
  assert.match(r.out, /^lock holder: unreadable$/m);
}));

// ---- usage -------------------------------------------------------------------------------------------------------------

test('extra arguments to status, report and generate are usage errors', async () => {
  for (const argv of [['status', 'x'], ['report', '--later'], ['report', '--now', 'x'], ['generate', 'x']]) {
    const r = await run({}, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.out, '');
    assert.match(r.err, /^Usage:/);
  }
});

// ---- final fix M4 (Ruling 10 N1): an invalid never-send keeps its valid entries, and status says so ----

test('final fix M4: status with an invalid never-send says it keeps its valid entries and counts them', () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ neverSend: ['client-x', 'github.com/client/*', 'github.com/mont*'] }));
  const r = await run(env, ['status']);
  assert.equal(r.code, 0);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('never-send: 2'), r.out);
  assert.deepEqual(lines.slice(lines.indexOf('config warnings:')), ['config warnings:', '  invalid config key: neverSend; keeping its valid entries', '']);
}));
