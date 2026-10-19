import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RETIRED_KINDS, appendRecord, formatSummary, formatTierSummary, recordKey, storePath, summarize, summarizeByTier,
  takeOverStale, validateRecord, withStoreLock,
} from '../cli/lib/role-eval.mjs';

const LIB_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lib', 'role-eval.mjs')).href;
const SENTINEL = 'zz-sentinel';

function withDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-eval-')));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Runs an ES module script in a child node process; resolves with { code, stdout, stderr }.
function runChild(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const mode = (path) => statSync(path).mode & 0o777;
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} is not about ${expected}`);

// ---- records ----------------------------------------------------------------------------------------------------

const GATE = (items = [true, true, true, true, true, true]) => ({ model: 'sonnet', items });
const SHADOW = (over = {}) => ({
  model: 'claude-haiku-5-5', items: [true, true, true, true, true, true], failed: false,
  candidates: 0, confirmed: 0, refuted: 0, duplicateCandidate: 0, duplicateReview: 0, ...over,
});
const HUNTER = (over = {}) => ({
  category: 'correctness', model: 'claude-haiku-5-5', candidates: 0, confirmed: { critical: 0, important: 0, minor: 0 },
  refuted: 0, duplicateCandidate: 0, duplicateReview: 0, failed: false, ...over,
});
const shadowRecord = (over = {}) => ({
  v: 1, at: '2026-09-01T10:00:00.000Z', provider: 'claude', task: 'T3', kind: 'safety-shadow',
  gate: GATE(), shadow: SHADOW(), ...over,
});
const huntersRecord = (over = {}) => ({
  v: 1, at: '2026-09-01T10:00:00Z', provider: 'codex', task: 'final', kind: 'hunters',
  hunters: [HUNTER({ candidates: 3, confirmed: { critical: 1, important: 0, minor: 1 }, refuted: 1 })],
  budget: { reference: 3, used: 3, overrun: false }, ...over,
});

// The v 2 kinds: a task review (one per task attempt) and the final review's escapes (one per plan).
const taskReviewRecord = (over = {}) => ({
  v: 2, at: '2026-09-01T10:00:00Z', provider: 'claude', task: 'T3', kind: 'task-review', attempt: 1, tier: 'heavy',
  declaredTier: 'standard', raised: true,
  hunters: [HUNTER({ candidates: 3, confirmed: { critical: 1, important: 0, minor: 1 }, refuted: 1 })],
  gate: { findings: 2 }, spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } },
  fixRounds: 2, blocked: false, coordinator: false, ...over,
});
const escapesRecord = (over = {}) => ({
  v: 2, at: '2026-09-06T10:00:00Z', provider: 'claude', task: 'final', kind: 'final-escapes',
  escapes: [{ tier: 'light', severity: 'important' }, { tier: 'standard', severity: 'minor' }], ...over,
});

test('safety-shadow is a retired kind: validateRecord still accepts it, so stored lines stay valid history', () => {
  assert.deepEqual([...RETIRED_KINDS], ['safety-shadow']);
  assert.ok(Object.isFrozen(RETIRED_KINDS));
  assert.deepEqual(validateRecord(shadowRecord()), { ok: true });
  const stored = `${JSON.stringify({ ...shadowRecord(), key: 'k1' })}\n`;
  const result = summarize(stored);
  assert.deepEqual(result.skipped.malformed, []);
  assert.equal(result.providers.claude.shadow.tasksCompared, 1);
});

test('validateRecord accepts the v 2 kinds, and the v 1 hunters and safety-shadow lines stay valid', () => {
  assert.deepEqual(validateRecord(huntersRecord()), { ok: true });
  assert.deepEqual(validateRecord(shadowRecord()), { ok: true });
  assert.deepEqual(validateRecord(taskReviewRecord()), { ok: true });
  // A tierless plan has no declared tier (it counts as standard); a light task has no hunters; a spec review that did not
  // run counts nothing.
  assert.deepEqual(validateRecord(taskReviewRecord({
    declaredTier: null, tier: 'standard', raised: false, hunters: [], gate: { findings: 0 },
    spec: { ran: false, confirmed: { critical: 0, important: 0, minor: 0 } }, coordinator: true,
  })), { ok: true });
  assert.deepEqual(validateRecord(taskReviewRecord({ declaredTier: null, tier: 'heavy', raised: true })), { ok: true });
  for (const tier of ['heavy', 'standard', 'light']) {
    assert.deepEqual(validateRecord(taskReviewRecord({ tier, declaredTier: tier, raised: false })), { ok: true }, tier);
  }
  // Raised above the declared tier, by one rank or two; `raised` agrees.
  assert.deepEqual(validateRecord(taskReviewRecord({ tier: 'standard', declaredTier: 'light', raised: true })), { ok: true });
  assert.deepEqual(validateRecord(taskReviewRecord({ tier: 'heavy', declaredTier: 'light', raised: true })), { ok: true });
  assert.deepEqual(validateRecord(escapesRecord()), { ok: true });
  assert.deepEqual(validateRecord(escapesRecord({ escapes: [] })), { ok: true });
});

test('validateRecord accepts one valid record of each kind', () => {
  assert.deepEqual(validateRecord(shadowRecord()), { ok: true });
  assert.deepEqual(validateRecord(huntersRecord()), { ok: true });
  // A shadow that failed carries no items and only zeros; the budget is optional on both kinds.
  assert.deepEqual(validateRecord(shadowRecord({ shadow: SHADOW({ failed: true, items: [] }) })), { ok: true });
  assert.deepEqual(validateRecord(shadowRecord({ budget: { reference: 0, used: 1, overrun: true } })), { ok: true });
  // A shadow with disagreements: the gate passed items 1 and 3 that the shadow failed -> candidates 2.
  assert.deepEqual(validateRecord(shadowRecord({
    shadow: SHADOW({ items: [false, true, false, true, true, true], candidates: 2, confirmed: 1, duplicateReview: 1 }),
  })), { ok: true });
  // A failed hunter, and every model pattern.
  assert.deepEqual(validateRecord(huntersRecord({ hunters: [HUNTER({ failed: true }), HUNTER({ category: 'state' })] })), { ok: true });
  for (const model of ['sonnet', 'opus', 'haiku', 'claude-haiku-5-5', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra']) {
    assert.deepEqual(validateRecord(shadowRecord({ gate: { ...GATE(), model } })), { ok: true }, model);
  }
});

const HUNTERS_BAD = (over) => huntersRecord({ hunters: [HUNTER(over)] });
const REJECTIONS = [
  // [name, record, expected field]
  ['null', null, '$'],
  ['array', [], '$'],
  ['string', 'text', '$'],
  ['unknown top-level field', { ...shadowRecord(), extra: 1 }, 'extra'],
  ['missing v', (() => { const r = shadowRecord(); delete r.v; return r; })(), 'v'],
  ['v other than 1', shadowRecord({ v: 2 }), 'v'],
  ['v as a string', shadowRecord({ v: '1' }), 'v'],
  ['missing at', (() => { const r = shadowRecord(); delete r.at; return r; })(), 'at'],
  ['at not ISO', shadowRecord({ at: 'yesterday' }), 'at'],
  ['at without the Z', shadowRecord({ at: '2026-09-01T10:00:00' }), 'at'],
  ['at that is not a date', shadowRecord({ at: '2026-13-45T10:00:00Z' }), 'at'],
  ['provider', shadowRecord({ provider: 'gemini' }), 'provider'],
  ['kind', shadowRecord({ kind: 'other' }), 'kind'],
  ['task lowercase', shadowRecord({ task: 't3' }), 'task'],
  ['task without a number', shadowRecord({ task: 'T' }), 'task'],
  ['task with trailing text', shadowRecord({ task: 'T3x' }), 'task'],
  ['task with a newline', shadowRecord({ task: 'T3\n' }), 'task'],
  ['shadow kind without gate', (() => { const r = shadowRecord(); delete r.gate; return r; })(), 'gate'],
  ['shadow kind without shadow', (() => { const r = shadowRecord(); delete r.shadow; return r; })(), 'shadow'],
  ['shadow kind with hunters', shadowRecord({ hunters: [HUNTER()] }), 'hunters'],
  ['hunters kind without hunters', (() => { const r = huntersRecord(); delete r.hunters; return r; })(), 'hunters'],
  ['hunters kind with gate', huntersRecord({ gate: GATE() }), 'gate'],
  ['hunters kind with shadow', huntersRecord({ shadow: SHADOW() }), 'shadow'],
  ['gate not an object', shadowRecord({ gate: [] }), 'gate'],
  ['gate model', shadowRecord({ gate: { ...GATE(), model: 'gpt4' } }), 'gate.model'],
  ['gate model with a prefix', shadowRecord({ gate: { ...GATE(), model: 'x-sonnet' } }), 'gate.model'],
  ['gate items too short', shadowRecord({ gate: GATE([true, true, true, true, true]) }), 'gate.items'],
  ['gate items empty', shadowRecord({ gate: GATE([]) }), 'gate.items'],
  ['gate item not a boolean', shadowRecord({ gate: GATE([true, true, 1, true, true, true]) }), 'gate.items.2'],
  ['gate unknown field', shadowRecord({ gate: { ...GATE(), extra: true } }), 'gate.extra'],
  ['shadow model', shadowRecord({ shadow: SHADOW({ model: 'haiku-5' }) }), 'shadow.model'],
  ['shadow items empty without failed', shadowRecord({ shadow: SHADOW({ items: [] }) }), 'shadow.items'],
  ['shadow items length 5', shadowRecord({ shadow: SHADOW({ items: [true, true, true, true, true] }) }), 'shadow.items'],
  ['shadow items length 7', shadowRecord({ shadow: SHADOW({ items: [true, true, true, true, true, true, true] }) }), 'shadow.items'],
  ['shadow item not a boolean', shadowRecord({ shadow: SHADOW({ items: [true, 'yes', true, true, true, true] }) }), 'shadow.items.1'],
  ['failed shadow with items', shadowRecord({ shadow: SHADOW({ failed: true }) }), 'shadow.items'],
  ['failed not a boolean', shadowRecord({ shadow: SHADOW({ failed: 'no' }) }), 'shadow.failed'],
  ['failed shadow with a count', shadowRecord({ shadow: SHADOW({ failed: true, items: [], refuted: 1, candidates: 1 }) }), 'shadow.refuted'],
  ['negative count', shadowRecord({ shadow: SHADOW({ refuted: -1 }) }), 'shadow.refuted'],
  ['fractional count', shadowRecord({ shadow: SHADOW({ confirmed: 1.5 }) }), 'shadow.confirmed'],
  ['count as a string', shadowRecord({ shadow: SHADOW({ duplicateReview: '1' }) }), 'shadow.duplicateReview'],
  ['missing count', shadowRecord({ shadow: (() => { const s = SHADOW(); delete s.duplicateCandidate; return s; })() }), 'shadow.duplicateCandidate'],
  ['shadow unknown field', shadowRecord({ shadow: { ...SHADOW(), extra: 0 } }), 'shadow.extra'],
  // The verdicts add up (2 = 1 + 1) but the items say 1 shadow-only failure.
  ['shadow candidates disagree with the items', shadowRecord({
    shadow: SHADOW({ items: [false, true, true, true, true, true], candidates: 2, confirmed: 1, refuted: 1 }),
  }), 'shadow.candidates'],
  // The item `i` the shadow failed but the gate also failed is not a shadow-only failure: 0 candidates.
  ['shadow candidates count a gate failure', shadowRecord({
    gate: GATE([false, true, true, true, true, true]),
    shadow: SHADOW({ items: [false, true, true, true, true, true], candidates: 1, refuted: 1 }),
  }), 'shadow.candidates'],
  // The items say 1 candidate, the verdicts add up to 2.
  ['shadow verdicts do not add up', shadowRecord({
    shadow: SHADOW({ items: [false, true, true, true, true, true], candidates: 1, confirmed: 1, refuted: 1 }),
  }), 'shadow.candidates'],
  ['hunters not an array', huntersRecord({ hunters: {} }), 'hunters'],
  ['hunter not an object', huntersRecord({ hunters: [null] }), 'hunters.0'],
  ['hunter category', HUNTERS_BAD({ category: 'style' }), 'hunters.0.category'],
  ['hunter model', HUNTERS_BAD({ model: 'luna' }), 'hunters.0.model'],
  ['hunter confirmed as a number', HUNTERS_BAD({ confirmed: 1, candidates: 1 }), 'hunters.0.confirmed'],
  ['hunter confirmed negative', HUNTERS_BAD({ confirmed: { critical: -1, important: 0, minor: 0 } }), 'hunters.0.confirmed.critical'],
  ['hunter confirmed unknown severity', HUNTERS_BAD({ confirmed: { critical: 0, important: 0, minor: 0, major: 0 } }), 'hunters.0.confirmed.major'],
  ['hunter confirmed missing severity', HUNTERS_BAD({ confirmed: { critical: 0, minor: 0 } }), 'hunters.0.confirmed.important'],
  ['hunter verdicts do not add up', HUNTERS_BAD({ candidates: 3, confirmed: { critical: 1, important: 1, minor: 0 }, refuted: 2 }), 'hunters.0.candidates'],
  ['hunter candidates too low', HUNTERS_BAD({ candidates: 1, refuted: 2 }), 'hunters.0.candidates'],
  ['hunter negative refuted', HUNTERS_BAD({ refuted: -2 }), 'hunters.0.refuted'],
  ['hunter failed with counts', huntersRecord({ hunters: [HUNTER(), HUNTER({ failed: true, refuted: 1, candidates: 1 })] }), 'hunters.1.refuted'],
  ['hunter unknown field', HUNTERS_BAD({ extra: 1 }), 'hunters.0.extra'],
  ['hunter failed not a boolean', HUNTERS_BAD({ failed: 0 }), 'hunters.0.failed'],
  ['budget not an object', shadowRecord({ budget: 3 }), 'budget'],
  ['budget missing reference', shadowRecord({ budget: { used: 1, overrun: false } }), 'budget.reference'],
  ['budget negative used', shadowRecord({ budget: { reference: 2, used: -1, overrun: false } }), 'budget.used'],
  ['budget overrun not a boolean', shadowRecord({ budget: { reference: 2, used: 2, overrun: 'no' } }), 'budget.overrun'],
  ['budget unknown field', shadowRecord({ budget: { reference: 2, used: 2, overrun: false, extra: 1 } }), 'budget.extra'],
  ['v 3', shadowRecord({ v: 3 }), 'v'],
  ['hunters kind with v 2', huntersRecord({ v: 2 }), 'v'],
  // task-review
  ['task-review with v 1', taskReviewRecord({ v: 1 }), 'v'],
  ['task-review with an extra key', taskReviewRecord({ extra: 1 }), 'extra'],
  ['task-review with a budget', taskReviewRecord({ budget: { reference: 1, used: 1, overrun: false } }), 'budget'],
  ['task-review with a shadow', taskReviewRecord({ shadow: SHADOW() }), 'shadow'],
  ['task-review with an escapes list', taskReviewRecord({ escapes: [] }), 'escapes'],
  ['task-review tier medium', taskReviewRecord({ tier: 'medium' }), 'tier'],
  ['task-review tier missing', (() => { const r = taskReviewRecord(); delete r.tier; return r; })(), 'tier'],
  ['task-review declaredTier medium', taskReviewRecord({ declaredTier: 'medium' }), 'declaredTier'],
  ['task-review declaredTier missing', (() => { const r = taskReviewRecord(); delete r.declaredTier; return r; })(), 'declaredTier'],
  ['task-review attempt 0', taskReviewRecord({ attempt: 0 }), 'attempt'],
  ['task-review attempt fractional', taskReviewRecord({ attempt: 1.5 }), 'attempt'],
  ['task-review attempt a string', taskReviewRecord({ attempt: '1' }), 'attempt'],
  ['task-review attempt missing', (() => { const r = taskReviewRecord(); delete r.attempt; return r; })(), 'attempt'],
  ['task-review task final', taskReviewRecord({ task: 'final' }), 'task'],
  ['task-review raised not a boolean', taskReviewRecord({ raised: 1 }), 'raised'],
  // The effective tier is never below the declared one (no tier is lowered); a null declared tier counts as standard.
  ['task-review tier below the declared tier', taskReviewRecord({ tier: 'light', declaredTier: 'standard', raised: false }), 'tier'],
  ['task-review tier standard below declared heavy', taskReviewRecord({ tier: 'standard', declaredTier: 'heavy', raised: true }), 'tier'],
  ['task-review light with a tierless plan', taskReviewRecord({ tier: 'light', declaredTier: null, raised: false }), 'tier'],
  // `raised` is exactly "the tier is above the declared one".
  ['task-review raised true with the declared tier', taskReviewRecord({ tier: 'standard', declaredTier: 'standard', raised: true }), 'raised'],
  ['task-review raised false above the declared tier', taskReviewRecord({ tier: 'heavy', declaredTier: 'standard', raised: false }), 'raised'],
  ['task-review raised true with a tierless plan at standard', taskReviewRecord({ tier: 'standard', declaredTier: null, raised: true }), 'raised'],
  ['task-review raised false above a tierless plan', taskReviewRecord({ tier: 'heavy', declaredTier: null, raised: false }), 'raised'],
  ['task-review hunters missing', (() => { const r = taskReviewRecord(); delete r.hunters; return r; })(), 'hunters'],
  ['task-review hunter counts do not add up', taskReviewRecord({ hunters: [HUNTER({ candidates: 5 })] }), 'hunters.0.candidates'],
  ['task-review gate missing', (() => { const r = taskReviewRecord(); delete r.gate; return r; })(), 'gate'],
  ['task-review gate extra key', taskReviewRecord({ gate: { findings: 1, model: 'sonnet' } }), 'gate.model'],
  ['task-review gate findings negative', taskReviewRecord({ gate: { findings: -1 } }), 'gate.findings'],
  ['task-review spec missing', (() => { const r = taskReviewRecord(); delete r.spec; return r; })(), 'spec'],
  ['task-review spec ran not a boolean', taskReviewRecord({ spec: { ran: 'yes', confirmed: { critical: 0, important: 0, minor: 0 } } }), 'spec.ran'],
  ['task-review spec extra key', taskReviewRecord({ spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0 }, extra: 1 } }), 'spec.extra'],
  ['task-review spec severity unknown', taskReviewRecord({ spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0, major: 1 } } }), 'spec.confirmed.major'],
  ['task-review spec severity missing', taskReviewRecord({ spec: { ran: true, confirmed: { critical: 0, minor: 0 } } }), 'spec.confirmed.important'],
  ['task-review spec severity negative', taskReviewRecord({ spec: { ran: true, confirmed: { critical: -1, important: 0, minor: 0 } } }), 'spec.confirmed.critical'],
  ['task-review spec that did not run with counts', taskReviewRecord({ spec: { ran: false, confirmed: { critical: 0, important: 1, minor: 0 } } }), 'spec.confirmed.important'],
  ['task-review fixRounds negative', taskReviewRecord({ fixRounds: -1 }), 'fixRounds'],
  ['task-review blocked not a boolean', taskReviewRecord({ blocked: 'no' }), 'blocked'],
  ['task-review coordinator missing', (() => { const r = taskReviewRecord(); delete r.coordinator; return r; })(), 'coordinator'],
  ['v 1 kinds cannot carry a tier', huntersRecord({ tier: 'light' }), 'tier'],
  ['v 1 kinds cannot carry an attempt', shadowRecord({ attempt: 1 }), 'attempt'],
  // final-escapes
  ['final-escapes with v 1', escapesRecord({ v: 1 }), 'v'],
  ['final-escapes with a task id', escapesRecord({ task: 'T3' }), 'task'],
  ['final-escapes with an extra key', escapesRecord({ extra: 1 }), 'extra'],
  ['final-escapes with hunters', escapesRecord({ hunters: [] }), 'hunters'],
  ['final-escapes without escapes', (() => { const r = escapesRecord(); delete r.escapes; return r; })(), 'escapes'],
  ['final-escapes escapes not an array', escapesRecord({ escapes: {} }), 'escapes'],
  ['final-escapes escape not an object', escapesRecord({ escapes: [null] }), 'escapes.0'],
  ['final-escapes escape tier', escapesRecord({ escapes: [{ tier: 'medium', severity: 'minor' }] }), 'escapes.0.tier'],
  ['final-escapes escape severity', escapesRecord({ escapes: [{ tier: 'light', severity: 'major' }] }), 'escapes.0.severity'],
  ['final-escapes escape extra key', escapesRecord({ escapes: [{ tier: 'light', severity: 'minor' }, { tier: 'light', severity: 'minor', task: 'T1' }] }), 'escapes.1.task'],
];

for (const [name, record, field] of REJECTIONS) {
  test(`validateRecord rejects: ${name}`, () => {
    assert.deepEqual(validateRecord(record), { ok: false, field });
  });
}

test('validateRecord never puts the rejected value (or an odd key name) into its answer', () => {
  const bad = [
    shadowRecord({ provider: SENTINEL }),
    shadowRecord({ at: SENTINEL }),
    shadowRecord({ task: SENTINEL }),
    shadowRecord({ kind: SENTINEL }),
    shadowRecord({ gate: { ...GATE(), model: SENTINEL } }),
    shadowRecord({ gate: GATE([true, SENTINEL, true, true, true, true]) }),
    shadowRecord({ shadow: SHADOW({ confirmed: SENTINEL }) }),
    shadowRecord({ shadow: SHADOW({ failed: SENTINEL }) }),
    shadowRecord({ shadow: SHADOW({ items: SENTINEL }) }),
    shadowRecord({ budget: { reference: SENTINEL, used: 1, overrun: false } }),
    huntersRecord({ hunters: [HUNTER({ category: SENTINEL })] }),
    huntersRecord({ hunters: [HUNTER({ confirmed: { critical: SENTINEL, important: 0, minor: 0 } })] }),
    huntersRecord({ hunters: SENTINEL }),
    taskReviewRecord({ tier: SENTINEL }),
    taskReviewRecord({ declaredTier: SENTINEL }),
    taskReviewRecord({ attempt: SENTINEL }),
    taskReviewRecord({ tier: 'light', declaredTier: 'heavy', raised: SENTINEL }),
    taskReviewRecord({ tier: 'heavy', declaredTier: 'standard', raised: SENTINEL }),
    taskReviewRecord({ spec: { ran: true, confirmed: { critical: SENTINEL, important: 0, minor: 0 } } }),
    taskReviewRecord({ [SENTINEL]: SENTINEL }),
    escapesRecord({ escapes: [{ tier: SENTINEL, severity: 'minor' }] }),
    escapesRecord({ escapes: [{ tier: 'light', severity: SENTINEL }] }),
    escapesRecord({ escapes: SENTINEL }),
    { ...shadowRecord(), [SENTINEL]: SENTINEL },
    { ...shadowRecord(), shadow: { ...SHADOW(), [SENTINEL]: SENTINEL } },
    SENTINEL,
  ];
  for (const record of bad) {
    const result = validateRecord(record);
    assert.equal(result.ok, false);
    assert.equal(typeof result.field, 'string');
    assert.equal(JSON.stringify(result).includes(SENTINEL), false, JSON.stringify(result));
  }
});

// ---- storePath --------------------------------------------------------------------------------------------------

test('storePath: ROLE_EVAL_FILE wins and is not the default directory', () => {
  assert.deepEqual(storePath({ ROLE_EVAL_FILE: '/x/y/z.jsonl', XDG_DATA_HOME: '/data' }, '/home/u'),
    { file: '/x/y/z.jsonl', dir: '/x/y', isDefault: false });
});

test('storePath: XDG_DATA_HOME, else home/.local/share', () => {
  assert.deepEqual(storePath({ XDG_DATA_HOME: '/data' }, '/home/u'), {
    file: '/data/triqual/role-eval/comparisons.jsonl', dir: '/data/triqual/role-eval', isDefault: true,
  });
  assert.deepEqual(storePath({}, '/home/u'), {
    file: '/home/u/.local/share/triqual/role-eval/comparisons.jsonl',
    dir: '/home/u/.local/share/triqual/role-eval', isDefault: true,
  });
  // Empty variables count as unset.
  assert.equal(storePath({ ROLE_EVAL_FILE: '', XDG_DATA_HOME: '' }, '/home/u').file,
    '/home/u/.local/share/triqual/role-eval/comparisons.jsonl');
});

// ---- recordKey --------------------------------------------------------------------------------------------------

test('recordKey is a stable hex sha256 that changes with each of the four inputs', () => {
  const base = { commonDir: '/r/.git', plan: '/r/docs/plans/p.md', task: 'T3', kind: 'hunters' };
  const key = recordKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(recordKey({ ...base }), key);
  // Only the plan's basename counts.
  assert.equal(recordKey({ ...base, plan: '/elsewhere/p.md' }), key);
  for (const [field, value] of [['commonDir', '/other/.git'], ['plan', '/r/docs/plans/q.md'], ['task', 'T4'], ['kind', 'safety-shadow']]) {
    assert.notEqual(recordKey({ ...base, [field]: value }), key, field);
  }
  // The NUL separators keep neighbouring fields apart.
  assert.notEqual(recordKey({ ...base, task: 'T', kind: '3hunters' }), key);
});

test('recordKey: a task-review key includes the attempt, any other kind ignores it (stored keys stay valid)', () => {
  const base = { commonDir: '/r/.git', plan: '/r/docs/plans/p.md', task: 'T3', kind: 'task-review' };
  const one = recordKey({ ...base, attempt: 1 });
  const two = recordKey({ ...base, attempt: 2 });
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.notEqual(one, two);
  assert.equal(recordKey({ ...base, attempt: 1 }), one);
  // The same attempt of another task or plan is another key.
  assert.notEqual(recordKey({ ...base, attempt: 1, task: 'T4' }), one);
  assert.notEqual(recordKey({ ...base, attempt: 1, plan: 'q.md' }), one);
  // hunters and final-escapes keys do not move with an attempt, and equal the pre-v2 four-field hash.
  for (const kind of ['hunters', 'safety-shadow', 'final-escapes']) {
    const fields = { commonDir: '/r/.git', plan: '/r/docs/plans/p.md', task: 'final', kind };
    assert.equal(recordKey({ ...fields, attempt: 2 }), recordKey(fields), kind);
    assert.equal(recordKey(fields), createHash('sha256').update(`/r/.git\0p.md\0final\0${kind}`).digest('hex'), kind);
  }
});

test('recordKey: an escape ref drops one leading # and surrounding spaces, so #128 and 128 are one escape', () => {
  const base = { commonDir: '/r/.git', plan: 'p.md', kind: 'escape' };
  const key = recordKey({ ...base, ref: '128' });
  assert.equal(recordKey({ ...base, ref: '#128' }), key);
  assert.equal(recordKey({ ...base, ref: ' #128 ' }), key);
  assert.notEqual(recordKey({ ...base, ref: '129' }), key);
});

// ---- the lock ---------------------------------------------------------------------------------------------------

test('withStoreLock returns fn\'s value and releases the lock when fn returns or throws', () => withDir((dir) => {
  const lock = join(dir, 'a.lock');
  assert.equal(withStoreLock(lock, () => {
    assert.equal(existsSync(lock), true);
    return 42;
  }), 42);
  assert.equal(existsSync(lock), false);
  assert.throws(() => withStoreLock(lock, () => { throw new Error('boom'); }), { message: 'boom' });
  assert.equal(existsSync(lock), false);
}));

test('a foreign fresh lock held past waitMs (2 s by default) throws', () => withDir((dir) => {
  const lock = join(dir, 'held.lock');
  writeFileSync(lock, 'holder\n');
  let called = false;
  const started = Date.now();
  assert.throws(() => withStoreLock(lock, () => { called = true; }), /lock timeout/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2000 && elapsed < 15000, `gave up after ${elapsed} ms`);
  assert.equal(called, false);
  assert.equal(readFileSync(lock, 'utf8'), 'holder\n', 'the holder\'s lock is left in place');
}));

test('a lock with an mtime older than 30 s is broken, and nothing is left behind', () => withDir((dir) => {
  const lock = join(dir, 'stale.lock');
  writeFileSync(lock, 'dead holder\n');
  const past = new Date(Date.now() - 60 * 1000);
  utimesSync(lock, past, past);
  assert.equal(withStoreLock(lock, () => 'ran'), 'ran');
  assert.deepEqual(readdirSync(dir), []);
  // The threshold is staleMs: a 5 s old lock is fresh by default and stale for staleMs 1000.
  writeFileSync(lock, 'holder\n');
  const recent = new Date(Date.now() - 5000);
  utimesSync(lock, recent, recent);
  assert.throws(() => withStoreLock(lock, () => {}, { waitMs: 100 }), /lock timeout/);
  assert.equal(withStoreLock(lock, () => 'ran', { waitMs: 100, staleMs: 1000 }), 'ran');
  assert.deepEqual(readdirSync(dir), []);
}));

test('takeOverStale returns false and restores a lock that is fresh at the re-stat, true when it removes a stale one', () => withDir((dir) => {
  // The race: the holder re-took the lock between the age check and the rename. takeOverStale is called straight on
  // a fresh lock to reach that branch.
  const lock = join(dir, 'race.lock');
  writeFileSync(lock, 'live holder\n');
  const ino = statSync(lock).ino;
  assert.equal(takeOverStale(lock, 30000), false);
  assert.equal(readFileSync(lock, 'utf8'), 'live holder\n');
  assert.equal(statSync(lock).ino, ino, 'the same file is back, not a copy');
  assert.deepEqual(readdirSync(dir), ['race.lock'], 'no renamed copy left behind');
  // Still stale after the rename: deleted.
  const past = new Date(Date.now() - 60000);
  utimesSync(lock, past, past);
  assert.equal(takeOverStale(lock, 30000), true);
  assert.deepEqual(readdirSync(dir), []);
  // A lock that is already gone: nothing removed.
  assert.equal(takeOverStale(lock, 30000), false);
}));

// ---- appendRecord -----------------------------------------------------------------------------------------------

const OPTS = { isDefault: false, created: false };

test('appendRecord writes one line carrying the key; the same key returns already and adds no line', () => withDir((dir) => {
  const file = join(dir, 'comparisons.jsonl');
  assert.equal(appendRecord(file, { v: 1, n: 1 }, { ...OPTS, key: 'key-a' }), 'written');
  assert.deepEqual(lines(file).map((l) => JSON.parse(l)), [{ v: 1, n: 1, key: 'key-a' }]);
  assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
  assert.equal(appendRecord(file, { v: 1, n: 2 }, { ...OPTS, key: 'key-a' }), 'already');
  assert.equal(lines(file).length, 1, 'the first write wins');
  assert.equal(appendRecord(file, { v: 1, n: 3 }, { ...OPTS, key: 'key-b' }), 'written');
  assert.deepEqual(lines(file).map((l) => JSON.parse(l).key), ['key-a', 'key-b']);
  assert.equal(existsSync(`${file}.lock`), false, 'the lock is released');
}));

test('appendRecord starts a new line when the file does not end with a newline', () => withDir((dir) => {
  const file = join(dir, 'comparisons.jsonl');
  writeFileSync(file, '{"torn":');
  assert.equal(appendRecord(file, { v: 1 }, { ...OPTS, key: 'key-a' }), 'written');
  const all = lines(file);
  assert.equal(all.length, 2);
  assert.deepEqual(JSON.parse(all[1]), { v: 1, key: 'key-a' });
}));

test('appendRecord ignores unparsable lines when it reads the existing keys', () => withDir((dir) => {
  const file = join(dir, 'comparisons.jsonl');
  writeFileSync(file, 'not json\n{"key":"key-a"}\n\n');
  assert.equal(appendRecord(file, { v: 1 }, { ...OPTS, key: 'key-a' }), 'already');
  assert.equal(appendRecord(file, { v: 1 }, { ...OPTS, key: 'key-b' }), 'written');
}));

test('hold-then-release: a record waits for a held lock and lands once the lock is removed', () => withDir(async (dir) => {
  const file = join(dir, 'comparisons.jsonl');
  const lock = `${file}.lock`;
  writeFileSync(lock, 'foreign holder\n');
  const child = runChild(`
    import { appendRecord } from ${JSON.stringify(LIB_URL)};
    console.log(appendRecord(${JSON.stringify(file)}, { v: 1, who: 'child' }, { key: 'key-a', isDefault: false, created: false }));`);
  await delay(300);
  assert.equal(existsSync(file), false, 'nothing is written while the lock is held');
  unlinkSync(lock);
  const r = await child;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'written');
  assert.deepEqual(lines(file).map((l) => JSON.parse(l)), [{ v: 1, who: 'child', key: 'key-a' }]);
  assert.equal(existsSync(lock), false);
}));

test('two concurrent processes recording the same key leave exactly one line (5 rounds)', () => withDir(async (dir) => {
  for (let round = 0; round < 5; round++) {
    const file = join(dir, `round-${round}.jsonl`);
    const go = join(dir, `go-${round}`);
    const script = `
      import { existsSync } from 'node:fs';
      import { appendRecord } from ${JSON.stringify(LIB_URL)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (!existsSync(${JSON.stringify(go)})) sleep(2);
      console.log(appendRecord(${JSON.stringify(file)}, { v: 1, pid: process.pid }, { key: 'same-key', isDefault: false, created: false }));`;
    const children = [runChild(script), runChild(script)];
    await delay(400);
    writeFileSync(go, '');
    const results = await Promise.all(children);
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), ['already', 'written'], `round ${round}`);
    assert.equal(lines(file).length, 1, `round ${round}: one line`);
    assert.equal(existsSync(`${file}.lock`), false);
  }
}));

// ---- modes ------------------------------------------------------------------------------------------------------

test('modes: the file becomes 0600 on a write, a looser pre-existing one included', () => withDir((dir) => {
  const fresh = join(dir, 'fresh.jsonl');
  appendRecord(fresh, { v: 1 }, { ...OPTS, key: 'key-a' });
  assert.equal(mode(fresh), 0o600);
  const loose = join(dir, 'loose.jsonl');
  writeFileSync(loose, '');
  chmodSync(loose, 0o644);
  appendRecord(loose, { v: 1 }, { ...OPTS, key: 'key-a' });
  assert.equal(mode(loose), 0o600);
  // The chmod also happens when the key is already there and nothing is written.
  chmodSync(loose, 0o644);
  assert.equal(appendRecord(loose, { v: 1 }, { ...OPTS, key: 'key-a' }), 'already');
  assert.equal(mode(loose), 0o600);
}));

test('modes: a default store directory becomes 0700, a pre-existing 0755 one included', () => withDir((dir) => {
  const store = join(dir, 'role-eval');
  mkdirSync(store);
  chmodSync(store, 0o755);
  appendRecord(join(store, 'comparisons.jsonl'), { v: 1 }, { key: 'key-a', isDefault: true, created: false });
  assert.equal(mode(store), 0o700);
}));

test('modes: a non-default parent stays as it is unless record created it', () => withDir((dir) => {
  const parent = join(dir, 'custom');
  mkdirSync(parent);
  chmodSync(parent, 0o755);
  appendRecord(join(parent, 'a.jsonl'), { v: 1 }, { key: 'key-a', isDefault: false, created: false });
  assert.equal(mode(parent), 0o755, 'an arbitrary parent is left alone');
  assert.equal(mode(join(parent, 'a.jsonl')), 0o600);
  appendRecord(join(parent, 'b.jsonl'), { v: 1 }, { key: 'key-a', isDefault: false, created: true });
  assert.equal(mode(parent), 0o700, 'a directory record created is tightened');
}));

// ---- summarize --------------------------------------------------------------------------------------------------

const rec = (obj) => JSON.stringify(obj);

// One store, written by hand. Line numbers are the physical lines (the 1-based position in the file).
//  1 s1  claude shadow, 2026-09-01   gate [t,t,f,t,t,t]  shadow [f,f,f,t,t,t]
//  2 s2  claude shadow, 2026-09-15   gate [t,t,t,t,f,t]  shadow [t,f,t,t,t,f]
//  3 s3  claude shadow, 2026-10-01   failed
//  4 h1  claude hunters, 2026-09-02
//  5 h2  claude hunters, 2026-10-02
//  6 c1  codex  shadow, 2026-09-20   all pass
//  7     malformed (not JSON)
//  8     v: 3
//  9     duplicate of line 1's key
const S1 = {
  v: 1, at: '2026-09-01T10:00:00.000Z', provider: 'claude', task: 'T1', kind: 'safety-shadow', key: 'key-s1',
  gate: GATE([true, true, false, true, true, true]),
  // shadow-only failures: items 0 and 1 (shadow failed, gate passed) -> candidates 2 = 1 confirmed + 1 duplicateReview.
  shadow: SHADOW({ items: [false, false, false, true, true, true], candidates: 2, confirmed: 1, duplicateReview: 1 }),
};
const S2 = {
  v: 1, at: '2026-09-15T10:00:00.000Z', provider: 'claude', task: 'T2', kind: 'safety-shadow', key: 'key-s2',
  gate: GATE([true, true, true, true, false, true]),
  // shadow-only failures: items 1 and 5 -> candidates 2 = 1 refuted + 1 duplicateCandidate. Gate-only: item 4.
  shadow: SHADOW({ items: [true, false, true, true, true, false], candidates: 2, refuted: 1, duplicateCandidate: 1 }),
};
const S3 = {
  v: 1, at: '2026-10-01T10:00:00.000Z', provider: 'claude', task: 'T3', kind: 'safety-shadow', key: 'key-s3',
  gate: GATE(), shadow: SHADOW({ failed: true, items: [] }),
};
const H1 = {
  v: 1, at: '2026-09-02T10:00:00.000Z', provider: 'claude', task: 'T1', kind: 'hunters', key: 'key-h1',
  hunters: [
    // 4 = (0 + 1 + 1) + 1 refuted + 0 duplicateCandidate + 1 duplicateReview
    HUNTER({ category: 'correctness', candidates: 4, confirmed: { critical: 0, important: 1, minor: 1 }, refuted: 1, duplicateReview: 1 }),
    // 2 = 0 + 2 refuted
    HUNTER({ category: 'security', candidates: 2, refuted: 2 }),
    HUNTER({ category: 'spec-drift', failed: true }),
  ],
  budget: { reference: 2, used: 2, overrun: false },
};
const H2 = {
  v: 1, at: '2026-10-02T10:00:00.000Z', provider: 'claude', task: 'T2', kind: 'hunters', key: 'key-h2',
  hunters: [
    // 4 = 1 confirmed + 1 refuted + 1 duplicateCandidate + 1 duplicateReview
    HUNTER({ category: 'correctness', candidates: 4, confirmed: { critical: 1, important: 0, minor: 0 }, refuted: 1, duplicateCandidate: 1, duplicateReview: 1 }),
    // 1 = 1 confirmed (minor)
    HUNTER({ category: 'state', candidates: 1, confirmed: { critical: 0, important: 0, minor: 1 } }),
  ],
  budget: { reference: 2, used: 3, overrun: true },
};
const C1 = {
  v: 1, at: '2026-09-20T10:00:00.000Z', provider: 'codex', task: 'T1', kind: 'safety-shadow', key: 'key-c1',
  gate: GATE(), shadow: SHADOW({ model: 'gpt-6-luna' }),
};
const FIXTURE = [
  rec(S1), rec(S2), rec(S3), rec(H1), rec(H2), rec(C1),
  '{this is not json',
  rec({ v: 3, key: 'key-v3', anything: 'goes' }),
  rec({ ...S1, task: 'T9' }), // same key as line 1
].join('\n') + '\n';

test('summarize: the claude safety shadow', () => {
  const s = summarize(FIXTURE, {}).providers.claude.shadow;
  // Compared: s1 and s2 (s3 failed) -> 2 tasks, 12 items. Agreeing items: s1 has 2 disagreements (items 0, 1) -> 4;
  // s2 has 3 (items 1, 4, 5) -> 3; 7 of 12 agree (0.5833).
  assert.equal(s.tasksCompared, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.itemsCompared, 12);
  assert.equal(s.itemsAgreed, 7);
  near(s.agreement, 0.5833);
  // Gate-only failures (gate false, shadow true): s2 item 4. s1's item 2 failed on both sides.
  assert.equal(s.gateOnlyFailures, 1);
  // Shadow-only failures: 4 = right (1 confirmed + 1 duplicateReview = 2) + 1 refuted + 1 duplicateCandidate.
  assert.equal(s.shadowOnly.candidates, 4);
  assert.equal(s.shadowOnly.right, 2);
  assert.equal(s.shadowOnly.refuted, 1);
  assert.equal(s.shadowOnly.duplicateCandidate, 1);
});

test('summarize: hunters per category, with null for an empty category', () => {
  const h = summarize(FIXTURE, {}).providers.claude.hunters;
  assert.deepEqual(Object.keys(h).sort(), ['correctness', 'security', 'spec-drift', 'state']);
  // correctness: candidates 4 + 4 = 8; confirmed 2 + 1 = 3 (critical 1, important 1, minor 1); refuted 1 + 1 = 2;
  // duplicateCandidate 0 + 1 = 1; duplicateReview 1 + 1 = 2. Right = (3 + 2) / 8 = 0.625; new = 3 / 8 = 0.375.
  assert.equal(h.correctness.candidates, 8);
  assert.deepEqual(h.correctness.confirmed, { critical: 1, important: 1, minor: 1 });
  assert.equal(h.correctness.refuted, 2);
  assert.equal(h.correctness.duplicateCandidate, 1);
  assert.equal(h.correctness.duplicateReview, 2);
  assert.equal(h.correctness.failed, 0);
  assert.equal(h.correctness.rightRate, 0.625);
  assert.equal(h.correctness.newRate, 0.375);
  // security: 2 candidates, both refuted: right = 0 / 2 = 0, new = 0 / 2 = 0 (a real zero, not n/a).
  assert.equal(h.security.candidates, 2);
  assert.equal(h.security.refuted, 2);
  assert.equal(h.security.rightRate, 0);
  assert.equal(h.security.newRate, 0);
  // spec-drift: one failed hunter, no candidates -> rates null.
  assert.equal(h['spec-drift'].candidates, 0);
  assert.equal(h['spec-drift'].failed, 1);
  assert.equal(h['spec-drift'].rightRate, null);
  assert.equal(h['spec-drift'].newRate, null);
  // state: 1 candidate, confirmed (minor): right = 1, new = 1.
  assert.equal(h.state.rightRate, 1);
  assert.equal(h.state.newRate, 1);
});

test('summarize: the budget, the skipped lines, and the codex record under its own provider', () => {
  const s = summarize(FIXTURE, {});
  // Budget: h1 and h2 -> reference 2 + 2 = 4, used 2 + 3 = 5, overruns 1.
  assert.deepEqual(s.providers.claude.budget, { records: 2, reference: 4, used: 5, overruns: 1 });
  // Skipped: line 7 is not JSON, line 8 has v 3, line 9 repeats line 1's key.
  assert.deepEqual(s.skipped, { malformed: [7], otherVersion: 1, duplicateKey: 1 });
  assert.deepEqual(Object.keys(s.providers).sort(), ['claude', 'codex']);
  // The codex shadow passed all 6 items on both sides: 6 / 6 = 1, nothing else.
  const c = s.providers.codex.shadow;
  assert.equal(c.tasksCompared, 1);
  assert.equal(c.failed, 0);
  assert.equal(c.itemsCompared, 6);
  assert.equal(c.itemsAgreed, 6);
  assert.equal(c.agreement, 1);
  assert.equal(c.gateOnlyFailures, 0);
  assert.equal(c.shadowOnly.candidates, 0);
  assert.deepEqual(s.providers.codex.budget, { records: 0, reference: 0, used: 0, overruns: 0 });
  // The codex provider's hunters are all empty: every rate is null.
  assert.equal(s.providers.codex.hunters.correctness.rightRate, null);
});

test('summarize: since keeps records at or after the date; the skipped counts do not move', () => {
  // Since 2026-09-10: s2 (09-15), s3 (10-01), h2 (10-02) and c1 (09-20) stay; s1 (09-01) and h1 (09-02) go.
  const s = summarize(FIXTURE, { since: '2026-09-10' });
  const sh = s.providers.claude.shadow;
  // s2 alone is compared: 6 items, 3 agree -> 0.5. s3 failed. Gate-only 1; shadow-only 2 = 0 right + 1 refuted + 1 dupCandidate.
  assert.equal(sh.tasksCompared, 1);
  assert.equal(sh.failed, 1);
  assert.equal(sh.itemsCompared, 6);
  assert.equal(sh.itemsAgreed, 3);
  assert.equal(sh.agreement, 0.5);
  assert.equal(sh.gateOnlyFailures, 1);
  assert.deepEqual([sh.shadowOnly.candidates, sh.shadowOnly.right, sh.shadowOnly.refuted, sh.shadowOnly.duplicateCandidate], [2, 0, 1, 1]);
  // h2 alone: correctness 4 candidates, right = (1 + 1) / 4 = 0.5, new = 1 / 4 = 0.25. security has no hunter left.
  const h = s.providers.claude.hunters;
  assert.equal(h.correctness.candidates, 4);
  assert.equal(h.correctness.rightRate, 0.5);
  assert.equal(h.correctness.newRate, 0.25);
  assert.equal(h.security.rightRate, null);
  assert.deepEqual(s.providers.claude.budget, { records: 1, reference: 2, used: 3, overruns: 1 });
  assert.equal(s.providers.codex.shadow.tasksCompared, 1);
  assert.deepEqual(s.skipped, { malformed: [7], otherVersion: 1, duplicateKey: 1 });
  // A window past every record leaves no provider at all.
  assert.deepEqual(summarize(FIXTURE, { since: '2027-01-01' }).providers, {});
});

test('summarize: a v 1 line that fails validation is malformed; blank lines are ignored but counted in line numbers', () => {
  const bad = { ...S1, key: 'key-bad', task: 'nope' };
  const noKey = { ...S2 };
  delete noKey.key;
  const text = `\n${rec(S1)}\n\n${rec(bad)}\n${rec(noKey)}\n[1,2]\n${rec(C1)}`;
  const s = summarize(text, {});
  assert.deepEqual(s.skipped, { malformed: [4, 5, 6], otherVersion: 0, duplicateKey: 0 });
  assert.equal(s.providers.claude.shadow.tasksCompared, 1);
  assert.equal(s.providers.codex.shadow.tasksCompared, 1);
});

test('summarize: an empty store gives no providers and zero skips', () => {
  assert.deepEqual(summarize('', {}), { providers: {}, skipped: { malformed: [], otherVersion: 0, duplicateKey: 0 } });
});

// ---- formatSummary ----------------------------------------------------------------------------------------------

test('formatSummary prints rates as percentages with one decimal and null as n/a', () => {
  const text = formatSummary(summarize(FIXTURE, {}));
  assert.match(text, /58\.3%/, 'item agreement 7/12');
  assert.match(text, /62\.5%/, 'right rate 5/8');
  assert.match(text, /37\.5%/, 'new rate 3/8');
  assert.match(text, /n\/a/);
  assert.equal(text.includes('null'), false);
  assert.equal(text.includes('NaN'), false);
  assert.match(text, /claude/);
  assert.match(text, /codex/);
  assert.match(text, /correctness/);
  assert.match(text, /malformed.*7/i);
  // n/a is printed exactly where a denominator was 0.
  const empty = formatSummary(summarize('', {}));
  assert.equal(empty.includes('null'), false);
  assert.match(empty, /0/);
});

// ---- the v 2 kinds in the summaries -----------------------------------------------------------------------------

// A store of five task reviews and one final-escapes record, written by hand (keys are made up; counts only).
//  a  claude  T1 attempt 1  heavy (declared standard, raised)  2026-09-01
//  b  claude  T1 attempt 2  heavy (declared standard, raised)  2026-09-03
//  c  claude  T2            standard (declared standard)       2026-09-02  blocked
//  d  claude  T3            light (declared light), coordinator 2026-09-04
//  e  codex   T4            light (declared light)             2026-09-05
//  f  claude  final-escapes 2026-09-06: light important, light minor, standard critical
const NO_SPEC = { ran: false, confirmed: { critical: 0, important: 0, minor: 0 } };
const TA = taskReviewRecord({
  at: '2026-09-01T10:00:00Z', task: 'T1', attempt: 1, tier: 'heavy', declaredTier: 'standard', raised: true,
  // 4 = 2 confirmed + 2 refuted
  hunters: [HUNTER({ category: 'correctness', candidates: 4, confirmed: { critical: 1, important: 1, minor: 0 }, refuted: 2 })],
  gate: { findings: 2 }, spec: { ran: true, confirmed: { critical: 1, important: 0, minor: 1 } },
  fixRounds: 2, blocked: false, coordinator: false,
});
const TB = taskReviewRecord({
  at: '2026-09-03T10:00:00Z', task: 'T1', attempt: 2, tier: 'heavy', declaredTier: 'standard', raised: true,
  // 2 = 1 confirmed + 1 refuted
  hunters: [HUNTER({ category: 'security', candidates: 2, confirmed: { critical: 0, important: 0, minor: 1 }, refuted: 1 })],
  gate: { findings: 0 }, spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } },
  fixRounds: 1, blocked: false, coordinator: false,
});
const TC = taskReviewRecord({
  at: '2026-09-02T10:00:00Z', task: 'T2', attempt: 1, tier: 'standard', declaredTier: 'standard', raised: false,
  // 4 = 2 confirmed + 1 refuted + 1 duplicateReview
  hunters: [HUNTER({ category: 'correctness', candidates: 4, confirmed: { critical: 0, important: 1, minor: 1 }, refuted: 1, duplicateReview: 1 })],
  gate: { findings: 1 }, spec: { ran: true, confirmed: { critical: 0, important: 1, minor: 0 } },
  fixRounds: 1, blocked: true, coordinator: false,
});
const TD = taskReviewRecord({
  at: '2026-09-04T10:00:00Z', task: 'T3', attempt: 1, tier: 'light', declaredTier: 'light', raised: false, hunters: [],
  gate: { findings: 0 }, spec: NO_SPEC, fixRounds: 0, blocked: false, coordinator: true,
});
const TE = taskReviewRecord({
  at: '2026-09-05T10:00:00Z', provider: 'codex', task: 'T4', attempt: 1, tier: 'light', declaredTier: 'light', raised: false,
  hunters: [HUNTER({ category: 'state', candidates: 1, confirmed: { critical: 0, important: 0, minor: 1 } })],
  gate: { findings: 1 }, spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0 } },
  fixRounds: 1, blocked: false, coordinator: false,
});
const FE = escapesRecord({
  at: '2026-09-06T10:00:00Z',
  escapes: [{ tier: 'light', severity: 'important' }, { tier: 'light', severity: 'minor' }, { tier: 'standard', severity: 'critical' }],
});
const TIER_STORE = [TA, TB, TC, TD, TE, FE].map((r, i) => rec({ ...r, key: `key-v2-${i}` })).join('\n') + '\n';

test('summarizeByTier: per tier, the hand-computed counts and rates of the six-line store', () => {
  const result = summarizeByTier(TIER_STORE, {});
  assert.deepEqual(Object.keys(result), ['heavy', 'standard', 'light', 'postMerge']);
  // heavy: a and b are two attempts of ONE task (T1), raised: `tasks` and `raised` count attempt 1 only -> 1 and 1. Every
  // other figure sums over both attempts. Hunters 6 candidates, 3 confirmed -> 0.5. Spec confirmed 2 + 1 = 3 over 1 task
  // -> 3. Fix rounds 2 + 1 = 3 over 1 task -> 3. No blocked task; no escape.
  assert.deepEqual(result.heavy, {
    tasks: 1, raised: 1, hunterConfirmedRate: 0.5, specConfirmedPerTask: 3, fixRoundsPerTask: 3, blocked: 0, escapesPerTask: 0,
  });
  // standard: c alone. 4 candidates, 2 confirmed (the duplicateReview is not a new finding) -> 0.5. Spec 1, fix rounds 1,
  // blocked 1, and the one standard escape -> 1 per task.
  assert.deepEqual(result.standard, {
    tasks: 1, raised: 0, hunterConfirmedRate: 0.5, specConfirmedPerTask: 1, fixRoundsPerTask: 1, blocked: 1, escapesPerTask: 1,
  });
  // light: d and e. 1 candidate, 1 confirmed -> 1. Spec 0 / 2 tasks. Fix rounds 1 / 2. Two light escapes / 2 tasks.
  assert.deepEqual(result.light, {
    tasks: 2, raised: 0, hunterConfirmedRate: 1, specConfirmedPerTask: 0, fixRoundsPerTask: 0.5, blocked: 0, escapesPerTask: 1,
  });
});

test('summarizeByTier: a later attempt adds its counts but is not another task or another raise', () => {
  const only = (r) => `${rec({ ...r, key: 'k' })}\n`;
  // Attempt 2 alone (attempt 1 outside the window or never recorded): no task to divide by, but the blocked count stays.
  const second = summarizeByTier(only({ ...TB, blocked: true }), {});
  assert.equal(second.heavy.tasks, 0);
  assert.equal(second.heavy.raised, 0);
  assert.equal(second.heavy.blocked, 1);
  assert.equal(second.heavy.specConfirmedPerTask, null);
  assert.equal(second.heavy.fixRoundsPerTask, null);
  // Attempt 1 alone counts the task and the raise.
  const first = summarizeByTier(only(TA), {});
  assert.equal(first.heavy.tasks, 1);
  assert.equal(first.heavy.raised, 1);
  assert.equal(first.heavy.specConfirmedPerTask, 2);
  assert.equal(first.heavy.fixRoundsPerTask, 2);
});

test('summarizeByTier: since keeps the records at or after the day; a tier with no task reports null rates', () => {
  // Since 2026-09-04: d, e and f stay.
  const result = summarizeByTier(TIER_STORE, { since: '2026-09-04' });
  assert.deepEqual(result.heavy, {
    tasks: 0, raised: 0, hunterConfirmedRate: null, specConfirmedPerTask: null, fixRoundsPerTask: null, blocked: 0, escapesPerTask: null,
  });
  // The standard escape has no standard task in the window to be divided by.
  assert.equal(result.standard.tasks, 0);
  assert.equal(result.standard.escapesPerTask, null);
  assert.equal(result.light.tasks, 2);
  assert.equal(result.light.escapesPerTask, 1);
  // An empty store: all three tiers, all empty.
  const empty = summarizeByTier('', {});
  assert.deepEqual(Object.keys(empty), ['heavy', 'standard', 'light', 'postMerge']);
  assert.equal(empty.light.tasks, 0);
  assert.equal(empty.light.hunterConfirmedRate, null);
});

test('summarizeByTier: v 1 lines, malformed lines, duplicate keys and other versions add nothing', () => {
  const text = [
    rec({ ...H1 }), rec({ ...S1 }), '{nope', rec({ v: 3, key: 'x' }),
    rec({ ...TA, key: 'dup' }), rec({ ...TB, key: 'dup' }), rec({ ...TC, key: 'ok', tier: 'medium' }),
  ].join('\n');
  const result = summarizeByTier(text, {});
  // Only TA counts: TB repeats its key, TC fails validation.
  assert.equal(result.heavy.tasks, 1);
  assert.equal(result.standard.tasks, 0);
  assert.equal(result.light.tasks, 0);
});

test('summarize: task-review hunters count with the hunters records; final-escapes adds no provider', () => {
  const s = summarize(TIER_STORE, {});
  assert.deepEqual(Object.keys(s.providers).sort(), ['claude', 'codex']);
  // claude correctness: a (4 candidates, confirmed 1/1/0, refuted 2) + c (4, confirmed 0/1/1, refuted 1, duplicateReview 1)
  // -> 8 candidates, confirmed 1/2/1, refuted 3, duplicateReview 1. Right = (4 + 1) / 8, new = 4 / 8.
  const c = s.providers.claude.hunters.correctness;
  assert.equal(c.candidates, 8);
  assert.deepEqual(c.confirmed, { critical: 1, important: 2, minor: 1 });
  assert.equal(c.refuted, 3);
  assert.equal(c.duplicateReview, 1);
  assert.equal(c.rightRate, 0.625);
  assert.equal(c.newRate, 0.5);
  // security from b; the codex hunter from e.
  assert.equal(s.providers.claude.hunters.security.candidates, 2);
  assert.equal(s.providers.codex.hunters.state.candidates, 1);
  assert.equal(s.providers.codex.hunters.state.newRate, 1);
  // A task review has no budget and no shadow.
  assert.deepEqual(s.providers.claude.budget, { records: 0, reference: 0, used: 0, overruns: 0 });
  assert.equal(s.providers.claude.shadow.tasksCompared, 0);
  assert.deepEqual(s.skipped, { malformed: [], otherVersion: 0, duplicateKey: 0 });
  // A store of final-escapes alone names no provider.
  assert.deepEqual(summarize(`${rec({ ...FE, key: 'k' })}\n`, {}).providers, {});
  // The v 1 summary is unchanged by the v 2 kinds: FIXTURE still reports what it did.
  assert.equal(summarize(FIXTURE, {}).providers.claude.hunters.correctness.candidates, 8);
});

test('formatTierSummary prints the tiers, rates as percentages and null as n/a', () => {
  const text = formatTierSummary(summarizeByTier(TIER_STORE, {}));
  for (const tier of ['heavy', 'standard', 'light']) assert.match(text, new RegExp(`^${tier}:`, 'm'));
  assert.match(text, /heavy: tasks 1, raised 1, hunter confirmed 50\.0%, spec confirmed\/task 3\.00, fix rounds\/task 3\.00, blocked 0, escapes\/task 0\.00/);
  assert.match(text, /light: tasks 2, raised 0, hunter confirmed 100\.0%, spec confirmed\/task 0\.00, fix rounds\/task 0\.50, blocked 0, escapes\/task 1\.00/);
  const empty = formatTierSummary(summarizeByTier('', {}));
  assert.match(empty, /heavy: tasks 0, raised 0, hunter confirmed n\/a, spec confirmed\/task n\/a, fix rounds\/task n\/a, blocked 0, escapes\/task n\/a/);
  assert.equal(empty.includes('null'), false);
  assert.equal(empty.includes('NaN'), false);
});
