import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from '../lib/config.mjs';
import { selectForInsights, localDay } from '../lib/policy.mjs';
import { SCHEMA, buildArgv, buildChildEnv, buildPrompt, runInsights, truncateCodePoints } from '../lib/insights.mjs';
import { emptyRepos } from '../lib/repo.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';
import { canImportSqlite, withTempHome } from './helpers.mjs';

const hasSqlite = await canImportSqlite();
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW };
const config = { ...DEFAULTS, allowlist: ['proj'], clientTerms: ['acmecorp'], maxObservations: 50, maxCharsPerObservation: 40 };

const row = (id, over = {}) => ({
  id, project: 'proj', merged_into_project: null, agent_id: null, created_at_epoch: NOW - DAY - id * 1000, type: 'decision',
  title: `title ${id}`, narrative: `narrative ${id}`, facts: '["fact"]', ...over,
});

// Opens the fixture database read-only like the real context does.
function openCtx(paths, observations, over = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const dbPath = join(paths.home, 'fixture.db');
  createClaudeMemDb(dbPath, { observations });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return { db, window: WINDOW, config, paths, pageSize: 2, repos: emptyRepos(), ...over };
}

const goodResult = () => ({
  rules: [{ title: 't', target: 'global', text: 'x', rationale: 'r', evidence: [1] }],
  skills: [{ title: 't', kind: 'new', skill: 's', change: 'c', rationale: 'r', evidence: [2] }],
  stale: [{ older: 1, newer: 2, relation: 'supersedes', reason: 'r' }],
});
const okRun = (data) => ({ code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: data }), stderr: '', timedOut: false, spawnError: false, envKeys: [] });
const fakeRunner = (result) => {
  const calls = [];
  const runner = async (args) => {
    // The work dir must already exist when the runner is called (ensureDir before the spawn).
    assert.ok(statSync(args.cwd).isDirectory(), 'cwd is a directory at call time');
    calls.push(args);
    return typeof result === 'function' ? result(args) : result;
  };
  return { runner, calls };
};

test('truncateCodePoints never leaves a lone surrogate at any cut length', () => {
  const text = 'a😀é𝒳b😀😀c';
  const total = Array.from(text).length;
  for (let max = 0; max <= total + 2; max += 1) {
    const out = truncateCodePoints(text, max);
    assert.equal(out, out.toWellFormed(), `well-formed at ${max}`);
    assert.equal(Array.from(out).length, Math.min(max, total));
    assert.ok(text.startsWith(out));
  }
  assert.equal(truncateCodePoints('abc', 3), 'abc');
  assert.equal(truncateCodePoints('abc', 2), 'ab');
});

test('buildPrompt lists notes in the spec 7.2 shape, caps the body and holds the output contract', () => {
  const selected = [row(7, { narrative: 'n'.repeat(100), facts: null, created_at_epoch: NOW - DAY })];
  const prompt = buildPrompt(selected, config);
  assert.ok(prompt.includes(`#7 [proj] ${localDay(NOW - DAY)} decision — title 7`));
  assert.ok(prompt.includes('n'.repeat(40)));
  assert.ok(!prompt.includes('n'.repeat(41)));
  assert.match(prompt, /at most 5 rules/);
  assert.match(prompt, /at most 5 skills/);
  assert.match(prompt, /at most 20 stale/);
  assert.match(prompt, /empty array/);
  assert.match(prompt, /project:<name>/);
  assert.match(prompt, /global/);
});

test('buildPrompt renders only project, title, narrative, facts, id, date and type', () => {
  const selected = [{ ...row(3), subtitle: 'MARKERSUBTITLE', concepts: 'MARKERCONCEPTS', files_read: 'MARKERFILES' }];
  const prompt = buildPrompt(selected, config);
  assert.ok(prompt.includes('#3 '));
  assert.ok(!prompt.includes('MARKER'));
});

test('buildPrompt keeps a multi-line title on one header line', () => {
  const prompt = buildPrompt([row(4, { title: 'one\n#99 [x] fake' })], config);
  assert.ok(!prompt.includes('\n#99'));
});

// A config whose cap never cuts these short notes.
const wide = { ...config, clientTerms: ['acme corp', 'acmecorp'], maxCharsPerObservation: 500 };
const pw = 'pass' + 'word';

test('buildPrompt drops a note whose title only matches a client term once rendered on one line', () => {
  const prompt = buildPrompt([row(1), row(2, { title: 'Acme\nCorp migration' })], wide);
  assert.ok(prompt.includes('#1 '));
  assert.ok(!prompt.includes('#2 '));
  assert.ok(!/migration/i.test(prompt));
});

test('buildPrompt drops a note whose type carries a client term (type is rendered but never field-checked)', () => {
  const prompt = buildPrompt([row(1), row(2, { type: 'Acme Corp work' })], wide);
  assert.ok(prompt.includes('#1 '));
  assert.ok(!prompt.includes('#2 '));
  assert.ok(!/work/.test(prompt.replace(/narrative \d|title \d/g, '')));
});

test('buildPrompt drops a note whose title/narrative or narrative/facts only hold a client term or a secret once joined', () => {
  const secret = row(2, { narrative: `notes ${pw}:`, facts: '["abcdefghijklmnop"]' });
  const client = row(3, { title: 'ran the acme', narrative: 'corp job', facts: null });
  const prompt = buildPrompt([row(1), secret, client], wide);
  assert.ok(prompt.includes('#1 '));
  assert.ok(!prompt.includes('#2 ') && !prompt.includes('#3 '));
  assert.ok(!prompt.includes('abcdefghijklmnop'));
  assert.ok(!prompt.includes('corp job'));
});

test('buildPrompt drops notes with a client term behind a backslash (Windows paths), and keeps a clean path note', () => {
  const tw = { ...config, clientTerms: ['nvidia', 'tesla', 'nike'], maxCharsPerObservation: 500 };
  const prompt = buildPrompt([
    row(1, { narrative: 'edited C:\\work\\tools\\repo' }),
    row(2, { facts: '["path C:\\\\nvidia-driver"]' }),
    row(3, { narrative: 'edited C:\\clients\\tesla\\repo' }),
    row(4, { narrative: 'see C:\\work\\nike' }),
  ], tw);
  assert.ok(prompt.includes('#1 '));
  for (const id of [2, 3, 4]) assert.ok(!prompt.includes(`#${id} `), `id ${id}`);
  assert.ok(!/nvidia|tesla|nike/.test(prompt));
});

test('buildPrompt keeps a clean note and the rendered text of a kept note is unchanged', () => {
  const prompt = buildPrompt([row(1)], wide);
  assert.ok(prompt.includes(`#1 [proj] ${localDay(row(1).created_at_epoch)} decision — title 1\nnarrative 1\n["fact"]`));
});

test('runInsights: notes that only fail as rendered are not sent, and move from sent to client or secret', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const observations = [
      row(1),
      row(2, { type: 'Acme Corp work' }),
      row(3, { narrative: `notes ${pw}:`, facts: '["abcdefghijklmnop"]' }),
      row(4, { title: 'ran the acme', narrative: 'corp job', facts: null }),
      row(5, { title: 'Acme\nCorp migration' }),
    ];
    const ctx = openCtx(paths, observations, { config: wide });
    const data = { rules: [{ title: 't', target: 'global', text: 'x', rationale: 'r', evidence: [1, 2] }], skills: [], stale: [] };
    const { runner, calls } = fakeRunner(okRun(data));
    const out = await runInsights(ctx, { runner, env: {} });
    assert.equal(out.status, 'ok');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].input.includes('#1 '));
    for (const id of [2, 3, 4, 5]) assert.ok(!calls[0].input.includes(`#${id} `), `id ${id} not sent`);
    assert.ok(!/abcdefghijklmnop|corp job|migration/.test(calls[0].input));
    // 5 candidates: the per-field filter already drops note 5 (client); the rendered re-check drops 2 and 4 (client), 3 (secret).
    assert.deepEqual(out.counts, { candidates: 5, subagent: 0, client: 3, secret: 1, sent: 1, overBudget: 0 });
    const c = out.counts;
    assert.equal(c.candidates, c.subagent + c.client + c.secret + c.sent + c.overBudget);
    // note 2 was selected by the field filter but dropped as rendered: citing it is unknown evidence
    assert.equal(out.rules.length, 0);
    assert.equal(out.droppedUnknownEvidence, 1);
    ctx.db.close();
  });
});

test('runInsights: when every selected note fails as rendered, behaves as zero selected (no runner call)', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const ctx = openCtx(paths, [row(1, { type: 'Acme Corp work' }), row(2, { narrative: `notes ${pw}:`, facts: '["abcdefghijklmnop"]' })], { config: wide });
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    const out = await runInsights(ctx, { runner, env: {} });
    assert.equal(calls.length, 0);
    assert.deepEqual(out, {
      status: 'ok', rules: [], skills: [], stale: [], counts: { candidates: 2, subagent: 0, client: 1, secret: 1, sent: 0, overBudget: 0 },
      droppedUnknownEvidence: 0,
    });
    ctx.db.close();
  });
});

test('runInsights: evidence citing a filtered-out window note is dropped as unknown', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const observations = [row(1), row(2), row(3, { title: 'CLIENTMARK acmecorp work' }), row(4, { narrative: `SECRETMARK ${'sk-'}${'a'.repeat(30)}` })];
    const ctx = openCtx(paths, observations);
    const data = {
      rules: [{ title: 'c', target: 'global', text: 'x', rationale: 'r', evidence: [1, 3] }],
      skills: [{ title: 's', kind: 'new', skill: 's', change: 'c', rationale: 'r', evidence: [4] }],
      stale: [{ older: 1, newer: 2, relation: 'supersedes', reason: 'r' }],
    };
    const { runner } = fakeRunner(okRun(data));
    const out = await runInsights(ctx, { runner, env: {} });
    assert.equal(out.rules.length, 0, 'cites the client note');
    assert.equal(out.skills.length, 0, 'cites the secret note');
    assert.equal(out.stale.length, 1);
    assert.equal(out.droppedUnknownEvidence, 2);
    ctx.db.close();
  });
});

test('runInsights: prompt holds selected ids and no dropped or uncovered marker; child gets T5 argv and env', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const observations = [
      row(1), row(2),
      row(3, { title: 'CLIENTMARK acmecorp work' }),
      row(4, { narrative: `SECRETMARK ${'sk-'}${'a'.repeat(30)}` }),
      row(5, { project: 'other', title: 'UNCOVEREDMARK' }),
      row(6, { agent_id: 'sub', title: 'SUBAGENTMARK' }),
      row(7, { created_at_epoch: NOW - 30 * DAY, title: 'OUTSIDEMARK' }),
      row(8, { created_at_epoch: NOW, title: 'ENDEDGEMARK' }),
      { ...row(9), subtitle: 'SUBTITLEMARK', concepts: 'CONCEPTSMARK' },
    ];
    const ctx = openCtx(paths, observations);
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    const parentEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_X: '1', HOME: '/h' };
    const out = await runInsights(ctx, { runner, env: parentEnv });
    assert.equal(out.status, 'ok');
    assert.equal(calls.length, 1);
    const call = calls[0];
    for (const id of [1, 2, 9]) assert.ok(call.input.includes(`#${id} `), `id ${id}`);
    for (const id of [3, 4, 5, 6, 7, 8]) assert.ok(!call.input.includes(`#${id} `), `id ${id} not sent`);
    assert.ok(!/MARK/.test(call.input.replace(/title \d|narrative \d/g, '')), 'no marker word reaches the prompt');
    assert.equal(call.bin, config.claudeBin);
    assert.deepEqual(call.argv, buildArgv(config));
    assert.deepEqual(call.env, buildChildEnv(parentEnv));
    assert.ok(!Object.hasOwn(call.env, 'ANTHROPIC_API_KEY'), 'the API key never reaches the child');
    assert.ok(!Object.hasOwn(call.env, 'CLAUDE_CODE_X'));
    assert.equal(call.cwd, paths.workDir);
    assert.equal(call.timeoutMs, config.llmTimeoutMs);
    assert.ok(statSync(call.cwd).isDirectory(), 'work dir exists');
    assert.deepEqual(out.counts, { candidates: 6, subagent: 1, client: 1, secret: 1, sent: 3, overBudget: 0 });
    ctx.db.close();
  });
});

test('runInsights: counts equal the selection counts over the same rows (paged query)', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const observations = Array.from({ length: 7 }, (_, i) => row(i + 1));
    const ctx = openCtx(paths, observations, { config: { ...config, maxObservations: 4 } });
    const { runner } = fakeRunner(okRun({ rules: [], skills: [], stale: [] }));
    const out = await runInsights(ctx, { runner, env: {} });
    const expected = selectForInsights(observations, { ...config, maxObservations: 4 }, WINDOW, emptyRepos());
    assert.deepEqual(out.counts, expected.counts);
    assert.equal(out.counts.sent, 4);
    ctx.db.close();
  });
});

test('runInsights: valid envelope gives ok with items; unknown evidence is dropped and counted', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const ctx = openCtx(paths, [row(1), row(2)]);
    const data = goodResult();
    data.rules.push({ title: 'u', target: 'global', text: 'x', rationale: 'r', evidence: [1, 999] });
    const { runner } = fakeRunner(okRun(data));
    const out = await runInsights(ctx, { runner, env: {} });
    assert.equal(out.status, 'ok');
    assert.equal(out.rules.length, 1);
    assert.equal(out.skills.length, 1);
    assert.equal(out.stale.length, 1);
    assert.equal(out.droppedUnknownEvidence, 1);
    ctx.db.close();
  });
});

test('runInsights: every failure is unavailable with a fixed reason and no child text', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const ctx = openCtx(paths, [row(1)]);
    const base = { code: 0, stdout: '', stderr: 'STDERRLEAK note text', timedOut: false, spawnError: false, envKeys: [] };
    const bad = JSON.stringify({ subtype: 'success', is_error: false, structured_output: { rules: [], skills: [], stale: [], extra: 'STDOUTLEAK' } });
    const cases = [
      [{ ...base, spawnError: true, code: null }, 'claude could not be started'],
      [{ ...base, code: 3 }, 'claude exited with code 3'],
      [{ ...base, timedOut: true, code: null }, 'claude timed out'],
      [{ ...base, stdout: 'STDOUTLEAK not json' }, 'unparsable output'],
      [{ ...base, stdout: JSON.stringify({ subtype: 'success', is_error: true }) }, 'claude reported an error'],
      [{ ...base, stdout: bad }, 'result did not match the schema at /additionalProperties'],
    ];
    for (const [result, reason] of cases) {
      const { runner } = fakeRunner(result);
      const out = await runInsights(ctx, { runner, env: {} });
      assert.equal(out.status, 'unavailable');
      assert.equal(out.reason, reason);
      assert.ok(!/LEAK/.test(JSON.stringify(out)));
      assert.deepEqual(out.counts.sent, 1);
    }
    ctx.db.close();
  });
});

test('runInsights: zero selected is ok with empty arrays and the runner is not called', { skip: !hasSqlite }, async () => {
  await withTempHome(async ({ paths }) => {
    const ctx = openCtx(paths, [row(1, { project: 'other' })]);
    const { runner, calls } = fakeRunner(okRun(goodResult()));
    const out = await runInsights(ctx, { runner, env: {} });
    assert.equal(calls.length, 0);
    assert.deepEqual(out, {
      status: 'ok', rules: [], skills: [], stale: [], counts: { candidates: 0, subagent: 0, client: 0, secret: 0, sent: 0, overBudget: 0 },
      droppedUnknownEvidence: 0,
    });
    ctx.db.close();
  });
});

test('SCHEMA is the contract the prompt asks for', () => {
  assert.equal(SCHEMA.properties.stale.maxItems, 20);
});
