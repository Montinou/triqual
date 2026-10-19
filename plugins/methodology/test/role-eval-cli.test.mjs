import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli/role-eval.mjs';
import { recordKey } from '../cli/lib/role-eval.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'role-eval.mjs');
const SENTINEL = 'zz-sentinel';
const mode = (path) => statSync(path).mode & 0o777;
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');

// A temp dir with a throwaway git repo (`repo`), a plan file name and a store file path; removed afterwards.
function withWorld(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-eval-cli-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const world = { root, repo, file: join(root, 'store', 'comparisons.jsonl'), plan: 'docs/plans/p.md' };
  return Promise.resolve().then(() => fn(world)).finally(() => rmSync(root, { recursive: true, force: true }));
}

// Calls main() with collecting streams; `env` is explicit and temp-only (no real home, no real store).
function run(argv, { env, cwd }) {
  let out = '';
  let err = '';
  const code = main(argv, {
    env, cwd, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const envFor = (world, extra = {}) => ({ PATH: process.env.PATH, HOME: world.root, ROLE_EVAL_FILE: world.file, ...extra });

const GATE = { model: 'sonnet', items: [true, true, true, true, true, true] };
const SHADOW = {
  model: 'claude-haiku-5-5', items: [true, true, true, true, true, true], failed: false,
  candidates: 0, confirmed: 0, refuted: 0, duplicateCandidate: 0, duplicateReview: 0,
};
const shadowRecord = (over = {}) => ({
  v: 1, at: '2026-09-01T10:00:00.000Z', provider: 'claude', task: 'T3', kind: 'safety-shadow',
  gate: GATE, shadow: SHADOW, ...over,
});
const huntersRecord = (over = {}) => ({
  v: 1, at: '2026-09-05T10:00:00Z', provider: 'codex', task: 'final', kind: 'hunters',
  hunters: [{
    category: 'correctness', model: 'claude-haiku-5-5', candidates: 3, confirmed: { critical: 1, important: 0, minor: 1 },
    refuted: 1, duplicateCandidate: 0, duplicateReview: 0, failed: false,
  }],
  ...over,
});

// The record a task review writes (since the safety shadow was retired, the only kind `record` accepts).
const taskRecord = (over = {}) => huntersRecord({ at: '2026-09-01T10:00:00.000Z', provider: 'claude', task: 'T3', ...over });

function writeInput(world, record, name = 'in.json') {
  const path = join(world.root, name);
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record));
  return path;
}

// ---- record -----------------------------------------------------------------------------------------------------

test('record writes the line with its key; a second identical call prints "already recorded" and exits 0', () => withWorld((w) => {
  const input = writeInput(w, taskRecord());
  const first = run(['record', '--plan', w.plan, input], { env: envFor(w), cwd: w.repo });
  assert.equal(first.code, 0, first.err);
  assert.equal(first.err, '');
  const [line] = lines(w.file);
  const stored = JSON.parse(line);
  const commonDir = realpathSync(execFileSync('git', ['-C', w.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  assert.equal(stored.key, recordKey({ commonDir, plan: 'p.md', task: 'T3', kind: 'hunters' }));
  assert.equal(stored.task, 'T3');
  assert.equal(mode(w.file), 0o600);

  const second = run(['record', '--plan', w.plan, input], { env: envFor(w), cwd: w.repo });
  assert.equal(second.code, 0);
  assert.match(second.out, /already recorded/);
  assert.equal(lines(w.file).length, 1);
}));

test('record: the key uses the plan basename, so another directory of the same plan name is the same record', () => withWorld((w) => {
  const input = writeInput(w, taskRecord());
  assert.equal(run(['record', '--plan', 'a/b/p.md', input], { env: envFor(w), cwd: w.repo }).code, 0);
  const again = run(['record', '--plan', 'c/p.md', input], { env: envFor(w), cwd: w.repo });
  assert.equal(again.code, 0);
  assert.match(again.out, /already recorded/);
  assert.equal(lines(w.file).length, 1);
}));

test('record outside a git repository exits 2 and writes nothing', () => withWorld((w) => {
  const outside = join(w.root, 'plain');
  mkdirSync(outside);
  const input = writeInput(w, taskRecord());
  // GIT_CEILING_DIRECTORIES keeps git from finding a repo above the temp dir.
  const env = envFor(w, { GIT_CEILING_DIRECTORIES: w.root });
  const r = run(['record', '--plan', w.plan, input], { env, cwd: outside });
  assert.equal(r.code, 2);
  assert.match(r.err, /git/);
  assert.equal(existsSync(w.file), false);
  assert.equal(existsSync(dirname(w.file)), false);
}));

test('record: a schema error exits 2, names the field and never echoes the value, and leaves no directory behind', () => withWorld((w) => {
  const input = writeInput(w, taskRecord({ task: SENTINEL }));
  const r = run(['record', '--plan', w.plan, input], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 2);
  assert.match(r.err, /\btask\b/);
  assert.equal((r.out + r.err).includes(SENTINEL), false);
  assert.equal(existsSync(dirname(w.file)), false, 'an invalid record must not create the store directory');
}));

test('record: counts that do not add up are a schema error (exit 2) naming the field', () => withWorld((w) => {
  const bad = huntersRecord();
  bad.hunters[0].candidates = 9;
  const r = run(['record', '--plan', w.plan, writeInput(w, bad)], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 2);
  assert.match(r.err, /hunters\.0\.candidates/);
}));

test('record: a safety-shadow record exits 2 naming the kind as retired, and writes nothing', () => withWorld((w) => {
  for (const record of [shadowRecord(), shadowRecord({ task: SENTINEL })]) {
    const r = run(['record', '--plan', w.plan, writeInput(w, record)], { env: envFor(w), cwd: w.repo });
    assert.equal(r.code, 2);
    assert.match(r.err, /safety-shadow/);
    assert.match(r.err, /retired/);
    assert.equal((r.out + r.err).includes(SENTINEL), false);
    assert.equal(existsSync(dirname(w.file)), false, 'a retired record must not create the store directory');
  }
}));

test('record: a bad JSON file exits 2 without echoing its content', () => withWorld((w) => {
  const r = run(['record', '--plan', w.plan, writeInput(w, `{"task": "${SENTINEL}" nope`)], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 2);
  assert.equal((r.out + r.err).includes(SENTINEL), false);
  assert.equal(existsSync(dirname(w.file)), false);
}));

test('record: a missing input file exits 2', () => withWorld((w) => {
  const r = run(['record', '--plan', w.plan, join(w.root, 'absent.json')], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 2);
}));

test('record: usage errors exit 2 (missing --plan, missing file, extra argument, unknown flag, unknown command)', () => withWorld((w) => {
  const input = writeInput(w, taskRecord());
  const opts = { env: envFor(w), cwd: w.repo };
  for (const argv of [
    ['record', input], ['record', '--plan', w.plan], ['record', '--plan'], ['record', '--plan', w.plan, input, 'extra'],
    ['record', '--bogus', '--plan', w.plan, input], ['nope'], [],
  ]) {
    const r = run(argv, opts);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /usage|unknown|missing|needs/i, JSON.stringify(argv));
  }
  assert.equal(existsSync(w.file), false);
}));

test('record: an unwritable store directory exits 1 with a short message', { skip: process.getuid?.() === 0 }, () => withWorld((w) => {
  mkdirSync(dirname(w.file), { mode: 0o700 });
  chmodSync(dirname(w.file), 0o500);
  try {
    const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env: envFor(w), cwd: w.repo });
    assert.equal(r.code, 1);
    assert.match(r.err, /role-eval/);
    assert.equal(r.err.split('\n').filter(Boolean).length, 1);
  } finally {
    chmodSync(dirname(w.file), 0o700);
  }
}));

test('record: a store directory that cannot be created (its parent is a file) exits 1', () => withWorld((w) => {
  writeFileSync(join(w.root, 'store'), 'a file where the directory should be');
  const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 1);
  assert.match(r.err, /role-eval/);
}));

test('record, first use: a missing default store directory (under XDG_DATA_HOME) is created at 0700 and the record lands', () => withWorld((w) => {
  const xdg = join(w.root, 'xdg');
  const env = { PATH: process.env.PATH, HOME: w.root, XDG_DATA_HOME: xdg };
  const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  const dir = join(xdg, 'triqual', 'role-eval');
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, 'comparisons.jsonl')), 0o600);
  assert.equal(lines(join(dir, 'comparisons.jsonl')).length, 1);
}));

test('record, first use: with no XDG_DATA_HOME the default is under HOME/.local/share', () => withWorld((w) => {
  const env = { PATH: process.env.PATH, HOME: w.root };
  const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env, cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  const file = join(w.root, '.local', 'share', 'triqual', 'role-eval', 'comparisons.jsonl');
  assert.equal(lines(file).length, 1);
  assert.equal(mode(dirname(file)), 0o700);
}));

test('record, first use: a ROLE_EVAL_FILE in a missing directory creates it at 0700', () => withWorld((w) => {
  const file = join(w.root, 'a', 'b', 'c.jsonl');
  const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env: envFor(w, { ROLE_EVAL_FILE: file }), cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(mode(dirname(file)), 0o700);
  assert.equal(lines(file).length, 1);
}));

test('record: a ROLE_EVAL_FILE in an existing directory leaves that directory\'s mode alone', () => withWorld((w) => {
  const dir = join(w.root, 'existing');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const r = run(['record', '--plan', w.plan, writeInput(w, taskRecord())], { env: envFor(w, { ROLE_EVAL_FILE: join(dir, 's.jsonl') }), cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.equal(mode(dir), 0o755);
}));

// A task review (v 2) as the orchestrator records it, and the final review's escapes.
const taskReviewRecord = (over = {}) => ({
  v: 2, at: '2026-09-01T10:00:00Z', provider: 'claude', task: 'T3', kind: 'task-review', attempt: 1, tier: 'heavy',
  declaredTier: 'standard', raised: true,
  hunters: [{
    category: 'correctness', model: 'claude-haiku-5-5', candidates: 4, confirmed: { critical: 1, important: 1, minor: 0 },
    refuted: 2, duplicateCandidate: 0, duplicateReview: 0, failed: false,
  }],
  gate: { findings: 2 }, spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } },
  fixRounds: 2, blocked: false, coordinator: false, ...over,
});
const escapesRecord = (over = {}) => ({
  v: 2, at: '2026-09-06T10:00:00Z', provider: 'claude', task: 'final', kind: 'final-escapes',
  escapes: [{ tier: 'light', severity: 'important' }, { tier: 'light', severity: 'minor' }, { tier: 'heavy', severity: 'critical' }],
  ...over,
});

test('record: a task-review is stored; the same attempt is a no-op, the next attempt of the same task is a second line', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const one = writeInput(w, taskReviewRecord(), 'a1.json');
  const two = writeInput(w, taskReviewRecord({ attempt: 2 }), 'a2.json');
  const first = run(['record', '--plan', w.plan, one], opts);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /recorded/);
  assert.match(run(['record', '--plan', w.plan, one], opts).out, /already recorded/);
  assert.equal(lines(w.file).length, 1);
  const second = run(['record', '--plan', w.plan, two], opts);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /^recorded/);
  const stored = lines(w.file).map((l) => JSON.parse(l));
  assert.deepEqual(stored.map((r) => r.attempt), [1, 2]);
  assert.notEqual(stored[0].key, stored[1].key);
  const commonDir = realpathSync(execFileSync('git', ['-C', w.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  assert.equal(stored[1].key, recordKey({ commonDir, plan: 'p.md', task: 'T3', kind: 'task-review', attempt: 2 }));
}));

test('record: a final-escapes record is stored once per plan', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const input = writeInput(w, escapesRecord());
  assert.equal(run(['record', '--plan', w.plan, input], opts).code, 0);
  assert.match(run(['record', '--plan', w.plan, input], opts).out, /already recorded/);
  assert.equal(lines(w.file).length, 1);
  assert.equal(JSON.parse(lines(w.file)[0]).kind, 'final-escapes');
}));

test('record: a task-review with an unknown key or a tier outside heavy, standard and light exits 2 naming the field', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const extra = run(['record', '--plan', w.plan, writeInput(w, taskReviewRecord({ extraKey: 1 }))], opts);
  assert.equal(extra.code, 2);
  assert.match(extra.err, /field extraKey/);
  const medium = run(['record', '--plan', w.plan, writeInput(w, taskReviewRecord({ tier: 'medium' }))], opts);
  assert.equal(medium.code, 2);
  assert.match(medium.err, /field tier/);
  assert.equal(medium.err.includes('medium'), false, 'the value is never echoed');
  assert.equal(existsSync(dirname(w.file)), false);
}));

test('record: a task-review whose tier is below the declared one, or whose raised flag disagrees, exits 2 naming the field', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const lowered = run(['record', '--plan', w.plan, writeInput(w, taskReviewRecord({ tier: 'light', declaredTier: 'standard', raised: false }))], opts);
  assert.equal(lowered.code, 2);
  assert.match(lowered.err, /field tier/);
  const flag = run(['record', '--plan', w.plan, writeInput(w, taskReviewRecord({ tier: 'heavy', declaredTier: 'standard', raised: false }), 'b.json')], opts);
  assert.equal(flag.code, 2);
  assert.match(flag.err, /field raised/);
  assert.equal(existsSync(dirname(w.file)), false);
}));

// A defect that reached trunk after the plan merged (no provider; `record` adds the plan's base name).
const escapeRecord = (over = {}) => ({
  v: 2, at: '2026-09-10T10:00:00Z', kind: 'escape', source: 'post-merge-fix', ref: 'abc1234', ...over,
});

// A fake `triqual` first on PATH: `tasks export --json` prints `snapshot` (or exits 1 when it is null).
function fakeTriqual(w, snapshot) {
  const bin = join(w.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const body = snapshot === null ? 'process.exit(1);' : `process.stdout.write(${JSON.stringify(JSON.stringify(snapshot))});`;
  writeFileSync(join(bin, 'triqual'), `#!/usr/bin/env node\n${body}\n`);
  chmodSync(join(bin, 'triqual'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

test('record: an escape is stored once per (plan, ref) with the plan\'s base name; another ref is a second line', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const one = writeInput(w, escapeRecord({ tier: 'light', note: 'off-by-one in the parser' }), 'e1.json');
  const first = run(['record', '--plan', w.plan, one], opts);
  assert.equal(first.code, 0, first.err);
  assert.match(run(['record', '--plan', w.plan, one], opts).out, /already recorded/);
  const two = writeInput(w, escapeRecord({ source: 'red-ci', ref: '#42' }), 'e2.json');
  assert.equal(run(['record', '--plan', w.plan, two], opts).code, 0);
  const stored = lines(w.file).map((l) => JSON.parse(l));
  assert.equal(stored.length, 2);
  assert.equal(stored[0].plan, 'p.md');
  assert.equal(stored[0].tier, 'light');
  const commonDir = realpathSync(execFileSync('git', ['-C', w.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  assert.equal(stored[1].key, recordKey({ commonDir, plan: 'p.md', kind: 'escape', ref: '#42' }));
  // The same PR without its `#` is the same escape.
  const same = writeInput(w, escapeRecord({ source: 'red-ci', ref: '42' }), 'e3.json');
  assert.match(run(['record', '--plan', w.plan, same], opts).out, /already recorded/);
  assert.equal(lines(w.file).length, 2);
}));

test('record: an escape with a task and no tier takes the task\'s effective tier from the ledger', () => withWorld((w) => {
  const snapshot = { plans: [{ name: 'p', tasks: [{ id: 'T2', tier: 'standard', effectiveTier: 'heavy' }] }] };
  const opts = { env: envFor(w, { PATH: fakeTriqual(w, snapshot) }), cwd: w.repo };
  const r = run(['record', '--plan', w.plan, writeInput(w, escapeRecord({ task: 'T2' }))], opts);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(lines(w.file)[0]).tier, 'heavy');
}));

test('record: an escape whose task the ledger cannot resolve is stored without a tier', () => withWorld((w) => {
  const opts = { env: envFor(w, { PATH: fakeTriqual(w, null) }), cwd: w.repo };
  const r = run(['record', '--plan', w.plan, writeInput(w, escapeRecord({ task: 'T9' }))], opts);
  assert.equal(r.code, 0, r.err);
  const stored = JSON.parse(lines(w.file)[0]);
  assert.equal(stored.task, 'T9');
  assert.equal('tier' in stored, false);
}));

test('record: a bad escape exits 2 naming the field (source, ref, task, tier, note, provider key)', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const cases = [
    [{ source: 'gossip' }, 'source'], [{ ref: 'not a ref' }, 'ref'], [{ task: 'final' }, 'task'],
    [{ tier: 'medium' }, 'tier'], [{ note: 'x'.repeat(201) }, 'note'], [{ provider: 'claude' }, 'provider'],
  ];
  for (const [over, field] of cases) {
    const r = run(['record', '--plan', w.plan, writeInput(w, escapeRecord(over))], opts);
    assert.equal(r.code, 2, field);
    assert.match(r.err, new RegExp(`field ${field}\\b`));
  }
  assert.equal(existsSync(dirname(w.file)), false);
}));

// ---- summary ----------------------------------------------------------------------------------------------------

// A safety-shadow line stored before that kind was retired (record refuses new ones, so it is written directly), then
// a hunters record through the CLI.
function seed(w) {
  mkdirSync(dirname(w.file), { recursive: true });
  writeFileSync(w.file, `${JSON.stringify({ ...shadowRecord(), key: 'stored-before-retirement' })}\n`);
  const opts = { env: envFor(w), cwd: w.repo };
  assert.equal(run(['record', '--plan', w.plan, writeInput(w, huntersRecord(), 'b.json')], opts).code, 0);
}

test('summary prints the text report; --json round-trips the same numbers', () => withWorld((w) => {
  seed(w);
  const opts = { env: envFor(w), cwd: w.repo };
  const text = run(['summary'], opts);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /Provider: claude/);
  assert.match(text.out, /Safety shadow/, 'a stored safety-shadow record is no longer summarized');
  assert.match(text.out, /Provider: codex/);
  assert.match(text.out, /correctness: candidates 3, confirmed 1\/0\/1/);
  assert.match(text.out, /Skipped: malformed 0, other version 0, duplicate key 0/);

  const json = run(['summary', '--json'], opts);
  assert.equal(json.code, 0, json.err);
  const parsed = JSON.parse(json.out);
  assert.deepEqual(Object.keys(parsed.providers).sort(), ['claude', 'codex']);
  assert.equal(parsed.providers.codex.hunters.correctness.candidates, 3);
  assert.equal(parsed.providers.claude.shadow.tasksCompared, 1);
  assert.deepEqual(parsed.skipped, { malformed: [], otherVersion: 0, duplicateKey: 0 });
}));

test('summary on an empty store and on a missing file exits 0 with zeros', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  const missing = run(['summary'], opts);
  assert.equal(missing.code, 0);
  assert.match(missing.out, /0 records/);
  assert.equal(existsSync(w.file), false, 'summary never creates the store');
  assert.equal(existsSync(dirname(w.file)), false);

  mkdirSync(dirname(w.file));
  writeFileSync(w.file, '');
  const empty = run(['summary'], opts);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /0 records/);
  const json = run(['summary', '--json'], opts);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.out), { providers: {}, skipped: { malformed: [], otherVersion: 0, duplicateKey: 0 } });
}));

test('summary --since keeps the records at or after that day', () => withWorld((w) => {
  seed(w); // claude on 2026-09-01, codex on 2026-09-05
  const opts = { env: envFor(w), cwd: w.repo };
  const all = JSON.parse(run(['summary', '--json', '--since', '2026-09-01'], opts).out);
  assert.deepEqual(Object.keys(all.providers).sort(), ['claude', 'codex']);
  const later = run(['summary', '--since', '2026-09-02', '--json'], opts);
  assert.equal(later.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(later.out).providers), ['codex']);
  const none = run(['summary', '--since=2026-10-01', '--json'], opts);
  assert.equal(none.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(none.out).providers), []);
}));

for (const bad of ['2026-9-1', 'garbage', '2026-02-30', '2026-13-01', '2026-09-01T00:00:00Z', '']) {
  test(`summary --since ${JSON.stringify(bad)} exits 2`, () => withWorld((w) => {
    seed(w);
    const r = run(['summary', '--since', bad], { env: envFor(w), cwd: w.repo });
    assert.equal(r.code, 2);
    assert.match(r.err, /--since/);
    assert.equal(r.out, '');
  }));
}

test('summary: --since without a value, an unknown flag and an extra argument exit 2', () => withWorld((w) => {
  const opts = { env: envFor(w), cwd: w.repo };
  for (const argv of [['summary', '--since'], ['summary', '--bogus'], ['summary', 'extra']]) {
    assert.equal(run(argv, opts).code, 2, JSON.stringify(argv));
  }
}));

test('summary works outside a git repository (it only reads the store)', () => withWorld((w) => {
  seed(w);
  const outside = join(w.root, 'plain');
  mkdirSync(outside);
  const r = run(['summary'], { env: envFor(w, { GIT_CEILING_DIRECTORIES: w.root }), cwd: outside });
  assert.equal(r.code, 0, r.err);
}));

// ---- summary --by-tier ------------------------------------------------------------------------------------------

// Two heavy task reviews (attempts 1 and 2 of the one task T3, raised), one standard (blocked) and the final review's
// three escapes (two light, one heavy), written straight into the store with their keys.
function seedTiers(w) {
  const heavy = taskReviewRecord();
  const records = [
    // heavy: 4 candidates, 2 confirmed; spec 1; fix rounds 2
    heavy,
    // heavy, second attempt: no hunters; spec 1; fix rounds 1
    taskReviewRecord({ task: 'T3', attempt: 2, at: '2026-09-02T10:00:00Z', hunters: [], spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } }, fixRounds: 1 }),
    // standard: 2 candidates, 1 confirmed; spec 0; fix rounds 1; blocked
    taskReviewRecord({
      task: 'T4', at: '2026-09-03T10:00:00Z', tier: 'standard', declaredTier: 'standard', raised: false, blocked: true, fixRounds: 1,
      hunters: [{ ...heavy.hunters[0], candidates: 2, confirmed: { critical: 0, important: 0, minor: 1 }, refuted: 1 }],
      spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0 } },
    }),
    escapesRecord(),
  ];
  mkdirSync(dirname(w.file), { recursive: true });
  writeFileSync(w.file, `${records.map((r, i) => JSON.stringify({ ...r, key: `k${i}` })).join('\n')}\n`);
}

const EMPTY_TIER = {
  tasks: 0, raised: 0, hunterConfirmedRate: null, specConfirmedPerTask: null, fixRoundsPerTask: null, blocked: 0, escapesPerTask: null,
};
const EMPTY_POST_MERGE = { heavy: 0, standard: 0, light: 0, unattributed: 0, byPlan: {} };

test('summary --by-tier --json prints the per-tier object of the store', () => withWorld((w) => {
  seedTiers(w);
  const r = run(['summary', '--by-tier', '--json'], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  // heavy: the two attempts are 1 task, raised once (tasks and raised count attempt 1 only); 2 confirmed of 4 -> 0.5;
  // spec 1 + 1 = 2 over 1 task; fix rounds 2 + 1 = 3 over 1 task; one heavy escape over 1 task.
  // standard: 1 task, blocked; 1 of 2 -> 0.5; spec 0; fix rounds 1; no escape. light: no task, two escapes without a task.
  assert.deepEqual(JSON.parse(r.out), {
    heavy: { tasks: 1, raised: 1, hunterConfirmedRate: 0.5, specConfirmedPerTask: 2, fixRoundsPerTask: 3, blocked: 0, escapesPerTask: 1 },
    standard: { tasks: 1, raised: 0, hunterConfirmedRate: 0.5, specConfirmedPerTask: 0, fixRoundsPerTask: 1, blocked: 1, escapesPerTask: 0 },
    light: EMPTY_TIER,
    postMerge: EMPTY_POST_MERGE,
  });
}));

test('summary --by-tier counts post-merge escapes per tier and per plan, unattributed without a tier', () => withWorld((w) => {
  seedTiers(w);
  const escapes = [
    escapeRecord({ plan: 'a.md', tier: 'heavy' }), escapeRecord({ plan: 'a.md', ref: 'def5678' }),
    escapeRecord({ plan: 'b.md', ref: '#7', tier: 'heavy', at: '2026-08-01T00:00:00Z' }),
  ];
  writeFileSync(w.file, `${readFileSync(w.file, 'utf8')}${escapes.map((r, i) => JSON.stringify({ ...r, key: `e${i}` })).join('\n')}\n`);
  const opts = { env: envFor(w), cwd: w.repo };
  const parsed = JSON.parse(run(['summary', '--by-tier', '--json'], opts).out);
  assert.deepEqual(parsed.postMerge, {
    heavy: 2, standard: 0, light: 0, unattributed: 1,
    byPlan: { 'a.md': { heavy: 1, standard: 0, light: 0, unattributed: 1 }, 'b.md': { heavy: 1, standard: 0, light: 0, unattributed: 0 } },
  });
  const text = run(['summary', '--by-tier', '--since', '2026-09-01'], opts).out;
  assert.match(text, /^post-merge escapes: heavy 1, standard 0, light 0, unattributed 1$/m);
  assert.match(text, /^  a\.md: heavy 1, standard 0, light 0, unattributed 1$/m);
  assert.doesNotMatch(text, /b\.md/);
  // The plain summary is per provider: an escape adds none.
  const plain = JSON.parse(run(['summary', '--json'], opts).out);
  assert.deepEqual(Object.keys(plain.providers), ['claude']);
  assert.deepEqual(plain.skipped.malformed, []);
}));

test('summary --by-tier prints one line per tier; --since narrows the window; flags work in either order', () => withWorld((w) => {
  seedTiers(w);
  const opts = { env: envFor(w), cwd: w.repo };
  const text = run(['summary', '--by-tier'], opts);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^heavy: tasks 1, raised 1, hunter confirmed 50\.0%, spec confirmed\/task 2\.00, fix rounds\/task 3\.00, blocked 0, escapes\/task 1\.00$/m);
  assert.match(text.out, /^standard: tasks 1,/m);
  assert.match(text.out, /^light: tasks 0, raised 0, hunter confirmed n\/a/m);
  // Since 2026-09-03 only the standard review and the escapes stay.
  const later = run(['summary', '--json', '--since', '2026-09-03', '--by-tier'], opts);
  assert.equal(later.code, 0, later.err);
  const parsed = JSON.parse(later.out);
  assert.equal(parsed.heavy.tasks, 0);
  assert.equal(parsed.standard.tasks, 1);
  assert.deepEqual(parsed.light, EMPTY_TIER);
  assert.equal(run(['summary', '--by-tier', '--since', '2026-9-3'], opts).code, 2);
}));

test('summary --by-tier on a missing store exits 0 with the three empty tiers and never creates the store', () => withWorld((w) => {
  const r = run(['summary', '--by-tier', '--json'], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { heavy: EMPTY_TIER, standard: EMPTY_TIER, light: EMPTY_TIER, postMerge: EMPTY_POST_MERGE });
  assert.equal(existsSync(dirname(w.file)), false);
}));

test('plain summary counts the hunters of task-review records', () => withWorld((w) => {
  seedTiers(w);
  const r = run(['summary', '--json'], { env: envFor(w), cwd: w.repo });
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  // correctness: the heavy review (4 candidates) and the standard one (2) -> 6 candidates, 3 confirmed.
  assert.equal(parsed.providers.claude.hunters.correctness.candidates, 6);
  assert.deepEqual(parsed.providers.claude.hunters.correctness.confirmed, { critical: 1, important: 1, minor: 1 });
  assert.deepEqual(parsed.skipped, { malformed: [], otherVersion: 0, duplicateKey: 0 });
}));

// ---- help -------------------------------------------------------------------------------------------------------

test('--help (and -h) lists both subcommands and exits 0', () => withWorld((w) => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag], { env: envFor(w), cwd: w.repo });
    assert.equal(r.code, 0);
    assert.match(r.out, /triqual role-eval record --plan <plan file> <json-file>/);
    assert.match(r.out, /triqual role-eval summary \[--since YYYY-MM-DD\] \[--json\]/);
    assert.match(r.out, /triqual role-eval summary --by-tier \[--since YYYY-MM-DD\] \[--json\]/);
    assert.match(r.out, /task-review/);
    assert.match(r.out, /final-escapes/);
    assert.match(r.out, /escape \(/);
    assert.match(r.out, /post-merge-fix/);
    assert.match(r.out, /safety-shadow kind is retired/);
    assert.match(r.out, /stored before/);
  }
}));

test('importing the module runs nothing; run as a script it exits with main()\'s code', () => withWorld((w) => {
  const env = envFor(w);
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: w.repo, env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /summary/);
  const bad = spawnSync(process.execPath, [SCRIPT, 'nope'], { cwd: w.repo, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command/);
  const input = writeInput(w, taskRecord());
  const rec = spawnSync(process.execPath, [SCRIPT, 'record', '--plan', w.plan, input], { cwd: w.repo, env, encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(lines(w.file).length, 1);
}));
