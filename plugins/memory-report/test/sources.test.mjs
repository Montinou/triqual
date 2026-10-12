// Read-only sources: the collector context, the real fs wrapper and claude-mem settings (spec 3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { closeSources, openSources, readClaudeMemSetting, realFs } from '../lib/sources.mjs';
import { createClaudeMemDb, memFs } from './fixtures/claude-mem-schema.mjs';

const skip = !(await canImportSqlite()) && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;

function setup(paths, opts = {}) {
  mkdirSync(dirname(paths.dbFile), { recursive: true });
  createClaudeMemDb(paths.dbFile, opts);
  return loadConfig(paths).config;
}

test('openSources builds the context with a half-open window of intervalDays ending now', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const config = setup(paths, { observations: [{ project: 'alpha', title: 't', created_at_epoch: NOW - DAY }] });
    const ctx = await openSources(paths, config, { now: () => NOW });
    try {
      assert.deepEqual(ctx.window, { startMs: NOW - 7 * DAY, endMs: NOW });
      assert.equal(ctx.now(), NOW);
      assert.equal(ctx.pageSize, 5000);
      assert.equal(ctx.platform, process.platform);
      assert.equal(ctx.fs, realFs);
      assert.equal(ctx.config, config);
      assert.equal(ctx.paths, paths);
      assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM observations').get().n, 1);
    } finally {
      closeSources(ctx);
    }
  });
});

test('openSources honors pageSize, platform and a changed intervalDays', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const config = { ...setup(paths), intervalDays: 3 };
    const ctx = await openSources(paths, config, { now: () => NOW, pageSize: 7, platform: 'linux' });
    try {
      assert.deepEqual(ctx.window, { startMs: NOW - 3 * DAY, endMs: NOW });
      assert.equal(ctx.pageSize, 7);
      assert.equal(ctx.platform, 'linux');
    } finally {
      closeSources(ctx);
    }
  });
});

test('a write through ctx.db throws: the handle is read-only', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const config = setup(paths);
    const ctx = await openSources(paths, config, { now: () => NOW });
    try {
      assert.throws(() => ctx.db.exec("INSERT INTO observations (project) VALUES ('x')"), /readonly/i);
      assert.throws(() => ctx.db.exec('CREATE TABLE t (a)'), /readonly/i);
    } finally {
      closeSources(ctx);
    }
  });
});

test('chromaDb is null without the Chroma file and a read-only handle with it', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const config = setup(paths);
    const without = await openSources(paths, config, { now: () => NOW });
    try {
      assert.equal(without.chromaDb, null);
    } finally {
      closeSources(without);
    }

    mkdirSync(dirname(paths.chromaFile), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const seed = new DatabaseSync(paths.chromaFile);
    seed.exec('CREATE TABLE embeddings (id INTEGER)');
    seed.close();
    const withChroma = await openSources(paths, config, { now: () => NOW, chromaTimeoutMs: 20 });
    try {
      assert.notEqual(withChroma.chromaDb, null);
      assert.equal(withChroma.chromaDb.prepare('SELECT count(*) AS n FROM embeddings').get().n, 0);
      assert.throws(() => withChroma.chromaDb.exec('INSERT INTO embeddings (id) VALUES (1)'), /readonly/i);
    } finally {
      closeSources(withChroma);
    }
  });
});

test('closeSources closes both handles and tolerates a null chromaDb', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    const config = setup(paths);
    const ctx = await openSources(paths, config, { now: () => NOW });
    closeSources(ctx);
    assert.throws(() => ctx.db.prepare('SELECT 1').get(), /not open/i);
    assert.doesNotThrow(() => closeSources({ db: null, chromaDb: null }));
  });
});

test('realFs returns null on ENOENT and describes files and directories', async () => {
  await withTempHome(async ({ home }) => {
    const file = `${home}/a.txt`;
    writeFileSync(file, 'héllo');
    mkdirSync(`${home}/d`);
    writeFileSync(`${home}/d/x`, '');
    assert.equal(realFs.readText(file), 'héllo');
    assert.equal(realFs.readText(`${home}/missing`), null);
    assert.deepEqual(realFs.listDir(`${home}/d`), ['x']);
    assert.equal(realFs.listDir(`${home}/missing`), null);
    const st = realFs.stat(file);
    assert.equal(st.size, Buffer.byteLength('héllo'));
    assert.equal(st.isDirectory, false);
    assert.equal(typeof st.mtimeMs, 'number');
    assert.equal(realFs.stat(`${home}/d`).isDirectory, true);
    assert.equal(realFs.stat(`${home}/missing`), null);
  });
});

test('readClaudeMemSetting reads a top-level key, else a key inside env', async () => {
  await withTempHome(async ({ paths }) => {
    const ctxFor = (text) => ({ paths, fs: memFs(text === null ? {} : { [paths.settingsFile]: text }) });
    const flat = ctxFor(JSON.stringify({ CLAUDE_MEM_DEDUP_ENABLED: 'true', OTHER: 'x' }));
    assert.equal(readClaudeMemSetting(flat, 'CLAUDE_MEM_DEDUP_ENABLED'), 'true');
    const wrapped = ctxFor(JSON.stringify({ env: { CLAUDE_MEM_DEDUP_ENABLED: 'false' } }));
    assert.equal(readClaudeMemSetting(wrapped, 'CLAUDE_MEM_DEDUP_ENABLED'), 'false');
    const both = ctxFor(JSON.stringify({ K: 'top', env: { K: 'inner' } }));
    assert.equal(readClaudeMemSetting(both, 'K'), 'top');
    assert.equal(readClaudeMemSetting(flat, 'MISSING'), undefined);
    assert.equal(readClaudeMemSetting(wrapped, 'MISSING'), undefined);
    assert.equal(readClaudeMemSetting(ctxFor(JSON.stringify({ env: { K: true, N: 5 } })), 'K'), 'true');
    assert.equal(readClaudeMemSetting(ctxFor(JSON.stringify({ env: { K: true, N: 5 } })), 'N'), '5');
  });
});

test('readClaudeMemSetting is undefined for a missing, unparsable or non-object settings file', async () => {
  await withTempHome(async ({ paths }) => {
    const ctxFor = (files) => ({ paths, fs: memFs(files) });
    assert.equal(readClaudeMemSetting(ctxFor({}), 'K'), undefined);
    assert.equal(readClaudeMemSetting(ctxFor({ [paths.settingsFile]: '{not json' }), 'K'), undefined);
    assert.equal(readClaudeMemSetting(ctxFor({ [paths.settingsFile]: '[1,2]' }), 'K'), undefined);
    assert.equal(readClaudeMemSetting(ctxFor({ [paths.settingsFile]: 'null' }), 'K'), undefined);
    assert.equal(readClaudeMemSetting(ctxFor({ [paths.settingsFile]: JSON.stringify({ env: 'x' }) }), 'K'), undefined);
  });
});
