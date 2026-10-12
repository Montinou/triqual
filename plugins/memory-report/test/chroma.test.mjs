// Chroma health collector: keyset-paged read, missing/orphans, watermark lag, worker log lines, crash reports, status
// (spec 6.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { closeSources, openSources } from '../lib/sources.mjs';
import { collectChroma, isBusy, parseLogLine, readChromaDocs } from '../lib/collect/chroma.mjs';
import { createClaudeMemDb, memFs } from './fixtures/claude-mem-schema.mjs';
import { createChromaDb } from './fixtures/chroma-schema.mjs';

const skip = !(await canImportSqlite()) && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;
const BUSY = { code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'database is locked' };
const sqlite = () => createRequire(import.meta.url)('node:sqlite');

const pad = (n, w = 2) => String(n).padStart(w, '0');
// A worker-log timestamp in the machine's local time, the way the worker writes it.
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const logLine = (ms, level, category, text) => `[${stamp(ms)}] [${level.padEnd(5)}] [${category.padEnd(6)}] ${text}`;
const obs = (project, n, startId = 1) => Array.from({ length: n }, (_, i) => ({ id: startId + i, project, created_at_epoch: NOW - DAY }));
const docs = (project, ids, firstId = 1) => ids.map((sqlite_id, i) => ({ id: firstId + i, sqlite_id, doc_type: 'observation', project }));

// Builds claude-mem.db and (unless chroma === null) chroma.sqlite3 in a temp home, opens the sources with an in-memory
// fs holding `files`, and runs fn(ctx, paths).
async function withCtx({ observations = [], chroma = [], files = {}, intervalDays, platform = 'darwin', pageSize, fs } = {}, fn) {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, { observations });
    const memory = { ...files };
    if (chroma !== null) {
      mkdirSync(dirname(paths.chromaFile), { recursive: true });
      createChromaDb(paths.chromaFile, chroma);
      memory[paths.chromaFile] = '';
    }
    const base = loadConfig(paths).config;
    const config = intervalDays === undefined ? base : { ...base, intervalDays };
    const mem = memFs(memory);
    const ctx = await openSources(paths, config, { now: () => NOW, fs: fs ? fs(mem) : mem, platform, ...(pageSize ? { pageSize } : {}) });
    try {
      await fn(ctx, paths);
    } finally {
      closeSources(ctx);
    }
  });
}

// ---- isBusy ----

test('isBusy is true only for SQLite error code 5', () => {
  assert.equal(isBusy({ errcode: 5 }), true);
  assert.equal(isBusy(BUSY), true);
  assert.equal(isBusy({ errcode: 1 }), false);
  assert.equal(isBusy(new Error('x')), false);
  assert.equal(isBusy(null), false);
  assert.equal(isBusy(undefined), false);
});

// ---- readChromaDocs ----

function withChromaFile(docList, fn) {
  return withTempHome(async ({ home }) => {
    const path = join(home, 'chroma.sqlite3');
    createChromaDb(path, docList);
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return await fn(db, path);
    } finally {
      db.close();
    }
  });
}

const THREE_KEY_DOCS = [1, 2, 3, 4, 5].map((n) => ({ id: n, sqlite_id: 100 + n, doc_type: n % 2 ? 'observation' : 'summary', project: `p${n}` }));
const EXPECTED_DOCS = new Map(THREE_KEY_DOCS.map((d) => [d.id, { sqlite_id: d.sqlite_id, doc_type: d.doc_type, project: d.project }]));

for (const pageSize of [2, 4]) {
  test(`documents of three metadata rows straddle pages of ${pageSize} and come back complete`, { skip }, async () => {
    await withChromaFile(THREE_KEY_DOCS, (db) => {
      assert.deepEqual(readChromaDocs(db, pageSize), EXPECTED_DOCS);
    });
  });
}

test('a page boundary never cuts a document: a page size of 1 still assembles every key', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    assert.deepEqual(readChromaDocs(db, 1), EXPECTED_DOCS);
  });
});

test('metadata keys other than sqlite_id, doc_type and project are not returned, and absent keys stay absent', { skip }, async () => {
  await withChromaFile([{ id: 1, sqlite_id: 7, doc_type: 'observation' }], (db, path) => {
    const { DatabaseSync } = sqlite();
    const writer = new DatabaseSync(path);
    try {
      writer.prepare("INSERT INTO embedding_metadata (id, key, string_value) VALUES (1, 'chroma:document', 'secret text')").run();
    } finally {
      writer.close();
    }
    assert.deepEqual(readChromaDocs(db, 2), new Map([[1, { sqlite_id: 7, doc_type: 'observation' }]]));
  });
});

test('every statement the read prepares carries a LIMIT', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    const seen = [];
    const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); } };
    readChromaDocs(spy, 2);
    assert.ok(seen.length >= 2, 'several pages');
    for (const sql of seen) assert.match(sql, /\bLIMIT\b/);
  });
});

test('the pages resume after the last (id, key) returned, starting from (0, empty)', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    const args = [];
    const spy = {
      prepare: (sql) => {
        const st = db.prepare(sql);
        return { all: (...a) => { args.push(a); return st.all(...a); } };
      },
    };
    readChromaDocs(spy, 4);
    assert.deepEqual(args[0], [0, '', 4]);
    assert.deepEqual(args[1], [2, 'doc_type', 4]); // keys sort doc_type, project, sqlite_id: page 1 ends mid-document 2
  });
});

function busyWrapper(db, failures) {
  let calls = 0;
  return {
    get calls() { return calls; },
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        all: (...a) => {
          calls += 1;
          if (calls <= failures) throw Object.assign(new Error(BUSY.message), BUSY);
          return st.all(...a);
        },
      };
    },
  };
}

test('a page that fails busy once is retried and the read succeeds', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    const wrapper = busyWrapper(db, 1);
    assert.deepEqual(readChromaDocs(wrapper, 100), EXPECTED_DOCS);
    assert.equal(wrapper.calls, 2);
  });
});

test('a page that fails busy twice makes the read throw "Chroma store busy"', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    const wrapper = busyWrapper(db, 2);
    assert.throws(() => readChromaDocs(wrapper, 100), (err) => err instanceof Error && err.message === 'Chroma store busy');
    assert.equal(wrapper.calls, 2);
  });
});

test('the retry is per page: one busy failure on each of two pages still succeeds', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    let calls = 0;
    const wrapper = {
      prepare(sql) {
        const st = db.prepare(sql);
        return {
          all: (...a) => {
            calls += 1;
            if (calls === 1 || calls === 3) throw Object.assign(new Error(BUSY.message), BUSY);
            return st.all(...a);
          },
        };
      },
    };
    assert.deepEqual(readChromaDocs(wrapper, 4), EXPECTED_DOCS);
  });
});

test('an error that is not busy is rethrown unchanged and not retried', { skip }, async () => {
  await withChromaFile(THREE_KEY_DOCS, (db) => {
    const boom = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    let calls = 0;
    const wrapper = { prepare: () => ({ all: () => { calls += 1; throw boom; } }) };
    assert.throws(() => readChromaDocs(wrapper, 100), (err) => err === boom);
    assert.equal(calls, 1);
  });
});

test('a real exclusive lock held by a second handle makes a 20 ms reader fail with an error isBusy accepts', { skip }, async () => {
  await withTempHome(async ({ home }) => {
    const path = join(home, 'chroma.sqlite3');
    createChromaDb(path, THREE_KEY_DOCS);
    const { DatabaseSync } = sqlite();
    const writer = new DatabaseSync(path);
    const reader = new DatabaseSync(path, { readOnly: true, timeout: 20 });
    try {
      writer.exec('BEGIN EXCLUSIVE');
      let raised;
      try {
        reader.prepare('SELECT count(*) AS n FROM embedding_metadata').all();
      } catch (err) {
        raised = err;
      }
      assert.ok(raised, 'the read failed while the store was locked');
      assert.equal(isBusy(raised), true);
      assert.throws(() => readChromaDocs(reader, 2), (err) => err.message === 'Chroma store busy');
    } finally {
      try {
        writer.exec('ROLLBACK');
      } finally {
        writer.close();
        reader.close();
      }
    }
  });
});

// ---- parseLogLine ----

test('parseLogLine accepts a padded WARN line and an ERROR line', () => {
  const warn = parseLogLine('[2026-10-07 04:43:01.090] [WARN ] [CHROMA_MCP] chroma-mcp subprocess closed unexpectedly, applying reconnect backoff {count=1}');
  assert.deepEqual(warn, {
    time: new Date(2026, 9, 7, 4, 43, 1).getTime(),
    level: 'WARN',
    category: 'CHROMA_MCP',
    message: 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff {count=1}',
  });
  const error = parseLogLine('[2026-10-07 01:00:25.271] [ERROR] [SYSTEM] Worktree adoption Chroma patch failed (SQL already committed) {parentProject=x}');
  assert.equal(error.level, 'ERROR');
  assert.equal(error.category, 'SYSTEM');
  assert.equal(error.time, new Date(2026, 9, 7, 1, 0, 25).getTime());
  assert.match(error.message, /^Worktree adoption Chroma patch failed/);
});

test('parseLogLine returns null for continuation lines, INFO lines and blank input', () => {
  assert.equal(parseLogLine('    at Object.<anonymous> (chroma.js:12)'), null);
  assert.equal(parseLogLine('{"chroma": "error"}'), null);
  assert.equal(parseLogLine('[2026-10-07 01:04:13.944] [INFO ] [HOOK  ] → PostToolUse: Bash(grep chroma …)'), null);
  assert.equal(parseLogLine('[2026-10-07 01:04:13.944] [DEBUG] [CHROMA] chroma noise'), null);
  assert.equal(parseLogLine(''), null);
});

// ---- collectChroma: counts ----

test('missing and orphans are computed per project against the Chroma observation documents', { skip }, async () => {
  await withCtx({
    observations: [...obs('a', 4, 1), ...obs('b', 3, 10)],
    chroma: [
      ...docs('a', [1, 2, 3]), // a: 4 missing
      ...docs('a', [999], 20), // a: orphan
      ...docs('b', [10, 11, 12], 30), // b: complete
      ...[{ id: 40, sqlite_id: 4, doc_type: 'summary', project: 'a' }], // not an observation document
      ...[{ id: 41, sqlite_id: 10, doc_type: 'observation', project: 'other' }], // another project: not b's
    ],
  }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.enabled, true);
    assert.equal(result.storePresent, true);
    assert.equal(result.missingTotal, 1);
    assert.equal(result.orphansTotal, 1);
    assert.deepEqual(result.topMissing, [{ project: 'a', missing: 1, total: 4 }]);
  });
});

test('one observation with several Chroma documents counts once', { skip }, async () => {
  await withCtx({
    observations: obs('a', 2),
    chroma: [
      { id: 1, sqlite_id: 1, doc_type: 'observation', project: 'a' },
      { id: 2, sqlite_id: 1, doc_type: 'observation', project: 'a' },
      { id: 3, sqlite_id: 2, doc_type: 'observation', project: 'a' },
    ],
  }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.missingTotal, 0);
    assert.equal(result.orphansTotal, 0);
    assert.deepEqual(result.topMissing, []);
  });
});

test('topMissing lists the 10 projects with most missing, largest first', { skip }, async () => {
  const observations = [];
  for (let p = 1; p <= 12; p += 1) observations.push(...obs(`p${String(p).padStart(2, '0')}`, p, p * 100));
  await withCtx({ observations, chroma: [] }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.topMissing.length, 10);
    assert.deepEqual(result.topMissing[0], { project: 'p12', missing: 12, total: 12 });
    assert.deepEqual(result.topMissing[9], { project: 'p03', missing: 3, total: 3 });
    assert.equal(result.missingTotal, 78);
  });
});

test('the keyset read runs with the context page size and no statement without LIMIT', { skip }, async () => {
  const seen = [];
  const original = [];
  await withCtx({
    observations: obs('a', 5),
    chroma: docs('a', [1, 2, 3, 4, 5]),
    pageSize: 2,
  }, (ctx) => {
    const real = ctx.chromaDb;
    original.push(real);
    const spy = { prepare: (sql) => { seen.push(sql); return real.prepare(sql); } };
    const result = collectChroma({ ...ctx, chromaDb: spy });
    assert.equal(result.missingTotal, 0);
    assert.ok(seen.length >= 4);
    for (const sql of seen) assert.match(sql, /\bLIMIT\b/);
  });
});

test('a busy store makes collectChroma throw "Chroma store busy"', { skip }, async () => {
  await withCtx({ observations: obs('a', 1), chroma: docs('a', [1]) }, (ctx) => {
    const wrapper = busyWrapper(ctx.chromaDb, 2);
    assert.throws(() => collectChroma({ ...ctx, chromaDb: wrapper }), (err) => err.message === 'Chroma store busy');
  });
});

// ---- watermark lag ----

test('watermark lag is the project max observation id minus its observations watermark, top 10, positive only', { skip }, async () => {
  const state = {
    a: { observations: 7, summaries: 1, prompts: 1 }, // max 10 -> lag 3
    b: { observations: 20, summaries: 0, prompts: 0 }, // max 20 -> lag 0
    c: { observations: 30, summaries: 0, prompts: 0 }, // max 25 -> watermark ahead
    gone: { observations: 1, summaries: 0, prompts: 0 }, // no observations
  };
  await withCtx({
    observations: [...obs('a', 1, 10), ...obs('b', 1, 20), ...obs('c', 1, 25), ...obs('d', 1, 50)],
    files: { '/placeholder': '' },
  }, async (ctx, paths) => {
    const fs = memFs({ [paths.syncStateFile]: JSON.stringify(state), [paths.chromaFile]: '' });
    const result = collectChroma({ ...ctx, fs });
    assert.deepEqual(result.watermarkLag, [{ project: 'a', lag: 3 }]);
  });
});

test('watermark lag is sorted by lag and capped at 10', { skip }, async () => {
  const observations = [];
  const state = {};
  for (let p = 1; p <= 12; p += 1) {
    observations.push(...obs(`p${p}`, 1, 1000 + p));
    state[`p${p}`] = { observations: 1000, summaries: 0, prompts: 0 };
  }
  await withCtx({ observations }, (ctx, paths) => {
    const fs = memFs({ [paths.syncStateFile]: JSON.stringify(state), [paths.chromaFile]: '' });
    const { watermarkLag } = collectChroma({ ...ctx, fs });
    assert.equal(watermarkLag.length, 10);
    assert.deepEqual(watermarkLag[0], { project: 'p12', lag: 12 });
    assert.deepEqual(watermarkLag[9], { project: 'p3', lag: 3 });
  });
});

test('a missing or unparsable sync state file gives no watermark lag', { skip }, async () => {
  await withCtx({ observations: obs('a', 1) }, (ctx, paths) => {
    assert.deepEqual(collectChroma(ctx).watermarkLag, []);
    const broken = memFs({ [paths.syncStateFile]: '{not json', [paths.chromaFile]: '' });
    assert.deepEqual(collectChroma({ ...ctx, fs: broken }).watermarkLag, []);
    const array = memFs({ [paths.syncStateFile]: '[]', [paths.chromaFile]: '' });
    assert.deepEqual(collectChroma({ ...ctx, fs: array }).watermarkLag, []);
  });
});

// ---- worker logs ----

const START = NOW - DAY; // intervalDays 1: the window is [START, NOW)
const LOG_DIR = (paths) => paths.logsDir;

test('only lines whose local timestamp is inside the half-open window count, across both daily files', { skip }, async () => {
  await withCtx({ observations: [], chroma: [], intervalDays: 1 }, (ctx, paths) => {
    const day6 = [
      logLine(START - 1000, 'WARN', 'CHROMA_MCP', 'chroma before the window {n=1}'),
      logLine(START, 'WARN', 'CHROMA_MCP', 'chroma at the window start {n=1}'),
    ].join('\n');
    const day7 = [
      logLine(NOW - 1000, 'ERROR', 'SYSTEM', 'chroma just before the end {n=1}'),
      logLine(NOW, 'ERROR', 'SYSTEM', 'chroma at the end {n=1}'),
    ].join('\n');
    const fs = memFs({
      [join(LOG_DIR(paths), 'claude-mem-2026-10-06.log')]: day6,
      [join(LOG_DIR(paths), 'claude-mem-2026-10-07.log')]: day7,
      [paths.chromaFile]: '',
    });
    const { logErrors } = collectChroma({ ...ctx, fs });
    assert.deepEqual(logErrors.map((e) => e.message).sort(), ['chroma at the window start', 'chroma just before the end']);
  });
});

test('the daily files read are every UTC date overlapping the window plus one day on each side', { skip }, async () => {
  const reads = [];
  await withCtx({ observations: [], chroma: [], intervalDays: 1 }, (ctx, paths) => {
    const base = memFs({ [paths.chromaFile]: '' });
    const fs = { ...base, readText: (p) => { reads.push(p); return base.readText(p); } };
    collectChroma({ ...ctx, fs });
    const logs = reads.filter((p) => p.startsWith(paths.logsDir)).map((p) => p.slice(paths.logsDir.length + 1)).sort();
    assert.deepEqual(logs, [
      'claude-mem-2026-10-05.log', 'claude-mem-2026-10-06.log', 'claude-mem-2026-10-07.log', 'claude-mem-2026-10-08.log',
    ]);
  });
});

test('lines group by category and the message text before the first brace, with counts', { skip }, async () => {
  await withCtx({ observations: [], chroma: [], intervalDays: 1 }, (ctx, paths) => {
    const t = NOW - 3600000;
    const long = `chroma ${'x'.repeat(100)}`;
    const text = [
      logLine(t, 'WARN', 'CHROMA_MCP', 'chroma-mcp subprocess closed {count=1}'),
      logLine(t + 1000, 'WARN', 'CHROMA_MCP', 'chroma-mcp subprocess closed {count=2}'),
      '    continuation chroma line without a prefix',
      logLine(t + 2000, 'ERROR', 'SYSTEM', 'Worktree adoption Chroma patch failed {parentProject=x}'),
      logLine(t + 3000, 'ERROR', 'CHROMA_MCP', 'chroma-mcp subprocess closed {count=3}'),
      logLine(t + 4000, 'INFO', 'HOOK', '→ PostToolUse: Bash(grep chroma …)'),
      logLine(t + 5000, 'WARN', 'SYSTEM', 'no mention of the store here'),
      logLine(t + 6000, 'WARN', 'SYSTEM', long),
    ].join('\n');
    const fs = memFs({ [join(paths.logsDir, 'claude-mem-2026-10-07.log')]: text, [paths.chromaFile]: '' });
    const { logErrors, status, reasons } = collectChroma({ ...ctx, fs });
    assert.deepEqual(logErrors, [
      { category: 'CHROMA_MCP', message: 'chroma-mcp subprocess closed', count: 3 },
      { category: 'SYSTEM', message: 'Worktree adoption Chroma patch failed', count: 1 },
      { category: 'SYSTEM', message: long.slice(0, 80), count: 1 },
    ]);
    assert.equal(status, 'ATTENTION');
    assert.ok(reasons.length >= 1);
  });
});

test('a missing logs directory gives no log errors', { skip }, async () => {
  await withCtx({}, (ctx) => {
    assert.deepEqual(collectChroma(ctx).logErrors, []);
  });
});

// ---- crash reports ----

test('crash reports are Python-*.ips files modified inside the window; newest is an ISO time', { skip }, async () => {
  await withCtx({ intervalDays: 1 }, (ctx, paths) => {
    const fs = memFs({
      [paths.chromaFile]: '',
      [join(paths.crashDir, 'Python-2026-10-07-010101.ips')]: { text: '', mtimeMs: NOW - 5000 },
      [join(paths.crashDir, 'Python-2026-10-06-130000.ips')]: { text: '', mtimeMs: START },
      [join(paths.crashDir, 'Python-too-old.ips')]: { text: '', mtimeMs: START - 1 },
      [join(paths.crashDir, 'Python-at-end.ips')]: { text: '', mtimeMs: NOW },
      [join(paths.crashDir, 'Other-2026-10-07.ips')]: { text: '', mtimeMs: NOW - 1000 },
      [join(paths.crashDir, 'Python-note.txt')]: { text: '', mtimeMs: NOW - 1000 },
    });
    const { crashes, status, reasons } = collectChroma({ ...ctx, fs });
    assert.deepEqual(crashes, { count: 2, newest: new Date(NOW - 5000).toISOString() });
    assert.equal(status, 'ATTENTION');
    assert.deepEqual(reasons, ['Python crash reports in the window']);
  });
});

test('no crash directory or no matching files gives count 0 and a null newest', { skip }, async () => {
  await withCtx({}, (ctx) => {
    assert.deepEqual(collectChroma(ctx).crashes, { count: 0, newest: null });
  });
});

test('on a non-macOS platform crash reports are "not applicable" and never raise attention', { skip }, async () => {
  await withCtx({ platform: 'linux' }, (ctx, paths) => {
    const fs = memFs({ [paths.chromaFile]: '', [join(paths.crashDir, 'Python-x.ips')]: { text: '', mtimeMs: NOW - 1000 } });
    const result = collectChroma({ ...ctx, fs });
    assert.equal(result.crashes, 'not applicable');
    assert.equal(result.status, 'OK');
  });
});

// ---- disabled and absent ----

test('CLAUDE_MEM_CHROMA_ENABLED false pins the zero/empty shape and skips counts, lag and logs', { skip }, async () => {
  const lines = logLine(NOW - 1000, 'ERROR', 'CHROMA_MCP', 'chroma exploded {x=1}');
  await withCtx({ observations: obs('a', 3), chroma: docs('a', [999]) }, (ctx, paths) => {
    const fs = memFs({
      [paths.chromaFile]: '',
      [paths.settingsFile]: JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }),
      [paths.syncStateFile]: JSON.stringify({ a: { observations: 0 } }),
      [join(paths.logsDir, 'claude-mem-2026-10-07.log')]: lines,
    });
    assert.deepEqual(collectChroma({ ...ctx, fs }), {
      enabled: false,
      storePresent: true,
      missingTotal: 0,
      orphansTotal: 0,
      topMissing: [],
      watermarkLag: [],
      logErrors: [],
      crashes: { count: 0, newest: null },
      status: 'OK',
      reasons: [],
    });
  });
});

test('a disabled Chroma with one crash report is ATTENTION', { skip }, async () => {
  await withCtx({}, (ctx, paths) => {
    const fs = memFs({
      [paths.chromaFile]: '',
      [paths.settingsFile]: JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }),
      [join(paths.crashDir, 'Python-1.ips')]: { text: '', mtimeMs: NOW - 1000 },
    });
    const result = collectChroma({ ...ctx, fs });
    assert.equal(result.enabled, false);
    assert.equal(result.status, 'ATTENTION');
    assert.deepEqual(result.reasons, ['Python crash reports in the window']);
    assert.equal(result.crashes.count, 1);
  });
});

test('the flag is also read from a nested env object and tolerates case and spaces; other values keep Chroma enabled', { skip }, async () => {
  await withCtx({}, (ctx, paths) => {
    const read = (settings) => collectChroma({ ...ctx, fs: memFs({ [paths.chromaFile]: '', [paths.settingsFile]: JSON.stringify(settings) }) }).enabled;
    assert.equal(read({ env: { CLAUDE_MEM_CHROMA_ENABLED: ' False ' } }), false);
    assert.equal(read({ CLAUDE_MEM_CHROMA_ENABLED: 'true' }), true);
    assert.equal(read({ CLAUDE_MEM_CHROMA_ENABLED: 'maybe' }), true);
    assert.equal(read({}), true);
  });
});

test('an absent store is noted, skips the counts and the lag, still reads logs, and is OK on its own', { skip }, async () => {
  await withCtx({ observations: obs('a', 3), chroma: null }, (ctx, paths) => {
    assert.equal(ctx.chromaDb, null);
    const quiet = collectChroma(ctx);
    assert.deepEqual(quiet, {
      enabled: true,
      storePresent: false,
      missingTotal: 0,
      orphansTotal: 0,
      topMissing: [],
      watermarkLag: [],
      logErrors: [],
      crashes: { count: 0, newest: null },
      status: 'OK',
      reasons: [],
    });
    const fs = memFs({
      [join(paths.logsDir, 'claude-mem-2026-10-07.log')]: logLine(NOW - 1000, 'WARN', 'CHROMA_MCP', 'chroma down {a=1}'),
      [paths.syncStateFile]: JSON.stringify({ a: { observations: 0 } }),
    });
    const loud = collectChroma({ ...ctx, fs });
    assert.equal(loud.storePresent, false);
    assert.deepEqual(loud.watermarkLag, []);
    assert.equal(loud.logErrors.length, 1);
    assert.equal(loud.status, 'ATTENTION');
  });
});

// ---- status ----

test('an orphan alone makes the status ATTENTION', { skip }, async () => {
  await withCtx({ observations: obs('a', 1), chroma: docs('a', [1, 77]) }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.orphansTotal, 1);
    assert.equal(result.status, 'ATTENTION');
    assert.deepEqual(result.reasons, ['Chroma documents without an observation in claude-mem.db']);
  });
});

test('1 missing of 60 observations (above 1%) in a project with at least 50 observations is ATTENTION', { skip }, async () => {
  await withCtx({ observations: obs('big', 60), chroma: docs('big', Array.from({ length: 59 }, (_, i) => i + 1)) }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.missingTotal, 1);
    assert.equal(result.status, 'ATTENTION');
    assert.deepEqual(result.reasons, ['A project of at least 50 observations is missing more than 1% from Chroma']);
  });
});

test('exactly 1% missing (1 of 100) is not above the threshold', { skip }, async () => {
  await withCtx({ observations: obs('big', 100), chroma: docs('big', Array.from({ length: 99 }, (_, i) => i + 1)) }, (ctx) => {
    assert.equal(collectChroma(ctx).status, 'OK');
  });
});

test('the same share missing in a 40-observation project alone is OK', { skip }, async () => {
  await withCtx({ observations: obs('small', 40), chroma: docs('small', Array.from({ length: 39 }, (_, i) => i + 1)) }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.missingTotal, 1);
    assert.equal(result.status, 'OK');
    assert.deepEqual(result.reasons, []);
  });
});

test('a fully synced store with no logs and no crashes is OK with no reasons', { skip }, async () => {
  await withCtx({ observations: obs('a', 3), chroma: docs('a', [1, 2, 3]) }, (ctx) => {
    const result = collectChroma(ctx);
    assert.equal(result.status, 'OK');
    assert.deepEqual(result.reasons, []);
  });
});

test('every trigger adds its fixed reason', { skip }, async () => {
  await withCtx({ observations: obs('big', 60), chroma: docs('big', [1, 2, 77]) }, (ctx, paths) => {
    const fs = memFs({
      [paths.chromaFile]: '',
      [join(paths.logsDir, 'claude-mem-2026-10-07.log')]: logLine(NOW - 1000, 'ERROR', 'CHROMA_MCP', 'chroma gone {a=1}'),
      [join(paths.crashDir, 'Python-1.ips')]: { text: '', mtimeMs: NOW - 1000 },
    });
    const result = collectChroma({ ...ctx, fs });
    assert.deepEqual(result.reasons, [
      'Chroma documents without an observation in claude-mem.db',
      'A project of at least 50 observations is missing more than 1% from Chroma',
      'Chroma lines in the worker logs',
      'Python crash reports in the window',
    ]);
  });
});
