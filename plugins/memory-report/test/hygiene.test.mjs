// Hygiene collector: empty observations, duplicate groups and the dedup setting (spec 6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { closeSources, openSources } from '../lib/sources.mjs';
import { collectHygiene } from '../lib/collect/hygiene.mjs';
import { emptyRepos } from '../lib/repo.mjs';
import { createClaudeMemDb, memFs } from './fixtures/claude-mem-schema.mjs';

const skip = !(await canImportSqlite()) && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 86400000;
const START = NOW - 7 * DAY;
const END = NOW;

// Builds a database from `opts`, opens the sources with the given settings text and allowlist, runs fn(ctx).
async function withCtx(opts, { settings = null, allowlist = [] } = {}, fn) {
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, opts);
    const config = { ...loadConfig(paths).config, allowlist };
    const fs = memFs(settings === null ? {} : { [paths.settingsFile]: settings });
    const ctx = await openSources(paths, config, { now: () => NOW, fs });
    ctx.repos = emptyRepos();
    try {
      await fn(ctx);
    } finally {
      closeSources(ctx);
    }
  });
}

const obs = (project, title, epoch, extra = {}) => ({ project, title, created_at_epoch: epoch, ...extra });

test('an empty database yields zeros, empty arrays and a disabled dedup', { skip }, async () => {
  await withCtx({}, {}, (ctx) => {
    assert.deepEqual(collectHygiene(ctx), {
      empty: { total: 0, inWindow: 0, topProjects: [] },
      duplicates: { totalGroups: 0, newGroups: 0, topProjects: [], largest: [] },
      dedup: { enabled: false, byStatus: null },
    });
  });
});

test('empty observation: narrative blank and facts NULL, blank or []', { skip }, async () => {
  const observations = [
    obs('alpha', 'a', NOW - DAY, { narrative: null, facts: null }),
    obs('alpha', 'b', NOW - DAY, { narrative: '  ', facts: '[]' }),
    obs('alpha', 'c', NOW - DAY, { narrative: 'text', facts: '[]' }),
    obs('alpha', 'd', NOW - DAY, { narrative: null, facts: '["a fact"]' }),
    obs('beta', 'e', START - DAY, { narrative: '', facts: '' }),
    obs('beta', 'f', NOW - DAY, { narrative: '\n\t ', facts: ' [] ' }),
    obs('gamma', 'g', END, { narrative: null, facts: null }),
  ];
  await withCtx({ observations }, {}, (ctx) => {
    assert.deepEqual(collectHygiene(ctx).empty, {
      total: 5,
      inWindow: 3,
      topProjects: [{ project: 'alpha', count: 2 }, { project: 'beta', count: 1 }],
    });
  });
});

test('empty observation window is half-open: startMs counts, endMs does not', { skip }, async () => {
  const observations = [
    obs('alpha', 'a', START, { facts: null }),
    obs('alpha', 'b', START - 1, { facts: null }),
    obs('alpha', 'c', END - 1, { facts: null }),
    obs('alpha', 'd', END, { facts: null }),
  ];
  await withCtx({ observations }, {}, (ctx) => {
    const { empty } = collectHygiene(ctx);
    assert.equal(empty.total, 4);
    assert.equal(empty.inWindow, 2);
  });
});

test('empty topProjects is capped at 5 and ordered by count then name', { skip }, async () => {
  const observations = [];
  for (let i = 0; i < 7; i += 1) {
    for (let n = 0; n <= i; n += 1) observations.push(obs(`p${i}`, `t${n}`, NOW - DAY, { facts: null }));
  }
  await withCtx({ observations }, {}, (ctx) => {
    assert.deepEqual(collectHygiene(ctx).empty.topProjects.map((p) => [p.project, p.count]), [
      ['p6', 7], ['p5', 6], ['p4', 5], ['p3', 4], ['p2', 3],
    ]);
  });
});

test('duplicate groups: project + lower(trim(title)), blank titles ignored, new by newest row', { skip }, async () => {
  const observations = [
    obs('alpha', 'Fix Bug', NOW - 5 * DAY),
    obs('alpha', ' fix bug ', NOW - 3 * DAY),
    obs('alpha', 'FIX BUG', NOW - DAY),
    obs('beta', 'Same', START - DAY),
    obs('beta', 'same', START),
    obs('beta', 'Old', START - 3 * DAY),
    obs('beta', 'old', START - 2 * DAY),
    obs('delta', 'End', NOW - 2 * DAY),
    obs('delta', 'end', END),
    obs('gamma', '', NOW - DAY),
    obs('gamma', '', NOW - DAY),
    obs('gamma', '  \n ', NOW - DAY),
    obs('gamma', '  \n ', NOW - DAY),
    obs('gamma', null, NOW - DAY),
    obs('gamma', null, NOW - DAY),
    obs('alpha', 'Solo', NOW - DAY),
    obs('beta', 'Solo', NOW - DAY),
  ];
  await withCtx({ observations }, { allowlist: ['alpha'] }, (ctx) => {
    assert.deepEqual(collectHygiene(ctx).duplicates, {
      totalGroups: 4,
      newGroups: 2,
      topProjects: [{ project: 'alpha', count: 1 }, { project: 'beta', count: 1 }],
      largest: [
        { project: 'alpha', rows: 3, title: 'FIX BUG' },
        { project: 'delta', rows: 2, title: null },
        { project: 'beta', rows: 2, title: null },
        { project: 'beta', rows: 2, title: null },
      ],
    });
  });
});

test('a group whose newest row is exactly startMs is new; one at endMs is not', { skip }, async () => {
  const observations = [
    obs('a', 'x', START - DAY), obs('a', 'x', START),
    obs('b', 'y', START - DAY), obs('b', 'y', START - 1),
    obs('c', 'z', NOW - DAY), obs('c', 'z', END),
  ];
  await withCtx({ observations }, {}, (ctx) => {
    const { duplicates } = collectHygiene(ctx);
    assert.equal(duplicates.totalGroups, 3);
    assert.equal(duplicates.newGroups, 1);
    assert.deepEqual(duplicates.topProjects, [{ project: 'a', count: 1 }]);
  });
});

test('largest shows the title only for an allowlisted project, truncated to 80 characters', { skip }, async () => {
  const long = `${'x'.repeat(100)}`;
  const observations = [
    obs('alpha', long, NOW - DAY), obs('alpha', long, NOW - 2 * DAY),
    obs('alpha/alpha-wt', 'Worktree title', NOW - DAY), obs('alpha/alpha-wt', 'worktree title', NOW - DAY),
    obs('beta', 'Secret client title', NOW - DAY), obs('beta', 'secret client title', NOW - DAY),
  ];
  await withCtx({ observations }, { allowlist: ['alpha'] }, (ctx) => {
    const { largest } = collectHygiene(ctx).duplicates;
    const byProject = Object.fromEntries(largest.map((g) => [g.project, g.title]));
    assert.equal(byProject.alpha, 'x'.repeat(80));
    assert.equal(byProject['alpha/alpha-wt'], 'Worktree title');
    assert.equal(byProject.beta, null);
  });
});

test('a neverSend project shows no title even when its parent is allowlisted', { skip }, async () => {
  const observations = [obs('alpha', 'Dup', NOW - DAY), obs('alpha', 'dup', NOW - DAY)];
  await withTempHome(async ({ paths }) => {
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, { observations });
    const config = { ...loadConfig(paths).config, allowlist: ['alpha'], neverSend: ['alpha'] };
    const ctx = await openSources(paths, config, { now: () => NOW, fs: memFs() });
    ctx.repos = emptyRepos();
    try {
      assert.equal(collectHygiene(ctx).duplicates.largest[0].title, null);
    } finally {
      closeSources(ctx);
    }
  });
});

test('duplicate topProjects and largest are capped at 5', { skip }, async () => {
  const observations = [];
  for (let i = 0; i < 7; i += 1) {
    for (let n = 0; n < i + 2; n += 1) observations.push(obs(`p${i}`, 'dup', NOW - DAY));
  }
  await withCtx({ observations }, {}, (ctx) => {
    const { duplicates } = collectHygiene(ctx);
    assert.equal(duplicates.totalGroups, 7);
    assert.equal(duplicates.newGroups, 7);
    assert.equal(duplicates.topProjects.length, 5);
    assert.deepEqual(duplicates.largest.map((g) => [g.project, g.rows]), [
      ['p6', 8], ['p5', 7], ['p4', 6], ['p3', 5], ['p2', 4],
    ]);
  });
});

test('dedup.enabled comes from the settings, top level or env, defaulting to false', { skip }, async () => {
  const check = async (settings, expected) => withCtx({}, { settings }, (ctx) => {
    assert.equal(collectHygiene(ctx).dedup.enabled, expected);
  });
  await check(JSON.stringify({ CLAUDE_MEM_DEDUP_ENABLED: 'true' }), true);
  await check(JSON.stringify({ env: { CLAUDE_MEM_DEDUP_ENABLED: 'true' } }), true);
  await check(JSON.stringify({ CLAUDE_MEM_DEDUP_ENABLED: 'false' }), false);
  await check(JSON.stringify({ OTHER: 'true' }), false);
  await check('{broken', false);
  await check(null, false);
});

test('dedup.byStatus counts candidates by status, and is null without the table', { skip }, async () => {
  const dedup = [{ status: 'pending' }, { status: 'pending' }, { status: 'merged' }, { status: null }];
  await withCtx({ dedup }, {}, (ctx) => {
    assert.deepEqual(collectHygiene(ctx).dedup.byStatus, { pending: 2, merged: 1, unknown: 1 });
  });
  await withCtx({ dedup: [] }, {}, (ctx) => {
    assert.deepEqual(collectHygiene(ctx).dedup.byStatus, {});
  });
  await withCtx({}, {}, (ctx) => {
    assert.equal(collectHygiene(ctx).dedup.byStatus, null);
  });
});
