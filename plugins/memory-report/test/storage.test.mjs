// Storage collector: file sizes, largest objects, rows and content bytes added in the window, projection (spec 6.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { closeSources, openSources } from '../lib/sources.mjs';
import { collectStorage } from '../lib/collect/storage.mjs';
import { createClaudeMemDb, memFs } from './fixtures/claude-mem-schema.mjs';

const skip = !(await canImportSqlite()) && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;
const START = NOW - 7 * DAY;
const END = NOW;

async function withCtx(opts, { files = {}, intervalDays, extra } = {}, fn) {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, opts);
    if (extra) {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const db = new DatabaseSync(paths.dbFile);
      extra(db);
      db.close();
    }
    const base = loadConfig(paths).config;
    const config = intervalDays === undefined ? base : { ...base, intervalDays };
    const ctx = await openSources(paths, config, { now: () => NOW, fs: memFs(files) });
    try {
      await fn(ctx, paths);
    } finally {
      closeSources(ctx);
    }
  });
}

const tableOf = (result, name) => result.tables.find((t) => t.name === name);

test('an empty database reports zero rows and bytes', { skip }, async () => {
  await withCtx({}, {}, (ctx) => {
    const result = collectStorage(ctx);
    assert.equal(result.dbBytes, 0);
    assert.equal(result.walBytes, 0);
    assert.equal(result.projection3mBytes, 0);
    assert.deepEqual(result.tables.map((t) => [t.name, t.rowsAdded, t.bytesAdded]), [
      ['tool_uses', 0, 0], ['user_prompts', 0, 0], ['observations', 0, 0], ['session_summaries', 0, 0],
    ]);
  });
});

test('content bytes are UTF-8 byte lengths ("éé" is 4) over the text columns of each table', { skip }, async () => {
  await withCtx({
    observations: [{ project: 'p', title: 'éé', subtitle: 'ab', narrative: 'n', facts: '[]', concepts: 'ignored-column', created_at_epoch: NOW - DAY }],
    toolUses: [{ project: 'p', tool_input: 'abc', tool_response: 'éé', tool_name: 'ignored-column', created_at_epoch: NOW - DAY }],
    prompts: [{ prompt_text: 'xyz', content_session_id: 'ignored-column', created_at_epoch: NOW - DAY }],
    summaries: [{
      project: 'p', request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: 'é',
      created_at_epoch: NOW - DAY,
    }],
  }, {}, (ctx) => {
    const result = collectStorage(ctx);
    assert.deepEqual(tableOf(result, 'observations'), { name: 'observations', rowsAdded: 1, bytesAdded: 4 + 2 + 1 + 2 });
    assert.deepEqual(tableOf(result, 'tool_uses'), { name: 'tool_uses', rowsAdded: 1, bytesAdded: 3 + 4 });
    assert.deepEqual(tableOf(result, 'user_prompts'), { name: 'user_prompts', rowsAdded: 1, bytesAdded: 3 });
    assert.deepEqual(tableOf(result, 'session_summaries'), { name: 'session_summaries', rowsAdded: 1, bytesAdded: 5 + 2 });
  });
});

test('rows outside the half-open window are excluded: startMs counts, endMs does not', { skip }, async () => {
  await withCtx({
    toolUses: [
      { tool_input: 'aa', created_at_epoch: START - 1 },
      { tool_input: 'bb', created_at_epoch: START },
      { tool_input: 'cc', created_at_epoch: END - 1 },
      { tool_input: 'dd', created_at_epoch: END },
    ],
  }, {}, (ctx) => {
    assert.deepEqual(tableOf(collectStorage(ctx), 'tool_uses'), { name: 'tool_uses', rowsAdded: 2, bytesAdded: 4 });
  });
});

test('NULL text columns count as zero bytes and do not null the sum', { skip }, async () => {
  await withCtx({
    toolUses: [{ tool_input: 'abcd', tool_response: null, created_at_epoch: NOW - DAY }, { tool_input: null, tool_response: null, created_at_epoch: NOW - DAY }],
  }, {}, (ctx) => {
    assert.deepEqual(tableOf(collectStorage(ctx), 'tool_uses'), { name: 'tool_uses', rowsAdded: 2, bytesAdded: 4 });
  });
});

test('projection3mBytes = round(sum(bytesAdded) * 91 / intervalDays)', { skip }, async () => {
  const opts = {
    toolUses: [{ tool_input: 'abcd', tool_response: 'ef', created_at_epoch: NOW - DAY }],
    prompts: [{ prompt_text: 'xyz', created_at_epoch: NOW - DAY }],
    observations: [{ project: 'p', title: 'éé', created_at_epoch: NOW - DAY }],
    summaries: [{ project: 'p', request: 'r', created_at_epoch: NOW - DAY }],
  };
  await withCtx(opts, {}, (ctx) => {
    assert.equal(collectStorage(ctx).projection3mBytes, Math.round((6 + 3 + 4 + 1) * 91 / 7));
  });
  await withCtx(opts, { intervalDays: 10 }, (ctx) => {
    assert.equal(collectStorage(ctx).projection3mBytes, Math.round(14 * 91 / 10));
  });
});

test('dbBytes and walBytes come from ctx.fs; no WAL file means 0', { skip }, async () => {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, {});
    const config = loadConfig(paths).config;
    for (const [files, db, wal] of [
      [{ [paths.dbFile]: 'x'.repeat(1000), [paths.walFile]: 'y'.repeat(250) }, 1000, 250],
      [{ [paths.dbFile]: 'x'.repeat(1000) }, 1000, 0],
    ]) {
      const ctx = await openSources(paths, config, { now: () => NOW, fs: memFs(files) });
      try {
        const result = collectStorage(ctx);
        assert.equal(result.dbBytes, db);
        assert.equal(result.walBytes, wal);
      } finally {
        closeSources(ctx);
      }
    }
  });
});

test('topObjects lists at most 8 objects from dbstat, largest first, with their sizes', { skip }, async () => {
  const extra = (db) => {
    for (let i = 0; i < 9; i += 1) db.exec(`CREATE TABLE extra_${i} (v TEXT)`);
    const insert = db.prepare('INSERT INTO extra_3 (v) VALUES (?)');
    for (let i = 0; i < 40; i += 1) insert.run('z'.repeat(3000));
    db.prepare('INSERT INTO extra_5 (v) VALUES (?)').run('q'.repeat(9000));
  };
  await withCtx({}, { extra }, (ctx) => {
    const { topObjects } = collectStorage(ctx);
    assert.equal(topObjects.length, 8);
    assert.equal(topObjects[0].name, 'extra_3');
    assert.equal(topObjects[1].name, 'extra_5');
    for (const o of topObjects) {
      assert.equal(typeof o.name, 'string');
      assert.ok(Number.isInteger(o.bytes) && o.bytes > 0, `${o.name} has a positive byte size`);
    }
    for (let i = 1; i < topObjects.length; i += 1) assert.ok(topObjects[i - 1].bytes >= topObjects[i].bytes);
    assert.ok(!topObjects.some((o) => o.name === 'sqlite_schema' || o.name === 'sqlite_master'));
  });
});
