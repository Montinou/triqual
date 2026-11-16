import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, TranscriptMissing, runCheck } from '../cli/lib/eval-checks.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';

const SRC = new URL('../cli/lib/eval-checks.mjs', import.meta.url);
const FIXTURES = fileURLToPath(new URL('./fixtures/eval-checks/', import.meta.url));
const JUDGES = fileURLToPath(new URL('../evals/judges/', import.meta.url));

test("runCheck returns the check's verdict", () => {
  const checks = {
    a: (signals) => (signals.n > 1 ? 'pass' : 'fail'),
    b: (_signals, transcriptPath) => (transcriptPath === '/t.jsonl' ? 'pass' : 'fail'),
  };
  assert.equal(runCheck('a', { n: 2 }, '/t.jsonl', checks), 'pass');
  assert.equal(runCheck('a', { n: 0 }, '/t.jsonl', checks), 'fail');
  assert.equal(runCheck('b', {}, '/t.jsonl', checks), 'pass');
});

test('an unknown id throws', () => {
  assert.throws(() => runCheck('nope', {}, '/t.jsonl', {}), /nope/);
  assert.throws(() => runCheck('toString', {}, '/t.jsonl', {}), /toString/);
  assert.deepEqual(Object.keys(CHECKS), ['owner-chased-progress']);
});

test('a missing transcript gives undecided', () => {
  const checks = { a: () => { throw new TranscriptMissing('/gone.jsonl'); } };
  assert.equal(runCheck('a', {}, '/gone.jsonl', checks), 'undecided');
});

test('other errors from a check propagate', () => {
  const checks = { a: () => { throw new Error('boom'); } };
  assert.throws(() => runCheck('a', {}, '/t.jsonl', checks), /boom/);
});

test('the module imports only node: built-ins', () => {
  const lines = readFileSync(SRC, 'utf8').split('\n')
    .filter((l) => /^\s*(import\b|export\b[^\n]*\bfrom\b)/.test(l) || /\brequire\(|\bimport\(/.test(l));
  for (const l of lines) assert.match(l, /from\s+['"]node:[a-z/_]+['"]/, `non-builtin import: ${l}`);
});

// ---- the checks of the owner's taxonomy (one per `code` category) ----

for (const id of Object.keys(CHECKS)) {
  test(`${id} fails its failing fixture`, () => {
    assert.equal(runCheck(id, {}, `${FIXTURES}${id}.fail.jsonl`), 'fail');
  });
  test(`${id} passes its passing fixture`, () => {
    assert.equal(runCheck(id, {}, `${FIXTURES}${id}.pass.jsonl`), 'pass');
  });
}

test('owner-chased-progress also fails a Spanish chase message', () => {
  assert.equal(runCheck('owner-chased-progress', {}, `${FIXTURES}owner-chased-progress.fail-es.jsonl`), 'fail');
});

// Each genuine chase, alone as the owner's only message, fails; invented phrasing, English and Spanish.
const CHASES = [
  'Is anything happening?', 'Is it still working?', 'Are you still running?', 'Is this stuck?', 'Any progress?',
  'Any update on the task?', 'How much longer?', 'How much longer will it take?', 'How much more time do you need?',
  'How long will it take?', 'Why is it so slow?', 'Why is this taking so long?', 'This is taking too long.',
  "What's going on?", "What's going on with it?", "What's taking so long?",
  'Pasa algo?', 'Sigues ahi?', 'Cuanto falta?', 'Por que tarda tanto?', 'Esto tarda mucho.', 'Esto esta tan lento.',
  'Que esta pasando?', 'Hay novedades?', 'Alguna novedad?',
];
test('owner-chased-progress fails each genuine chase on its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chase-'));
  try {
    for (const [i, text] of CHASES.entries()) {
      const file = join(dir, `${i}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      assert.equal(runCheck('owner-chased-progress', {}, file), 'fail', text);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner-chased-progress is undecided when the transcript is gone', () => {
  assert.equal(runCheck('owner-chased-progress', {}, `${FIXTURES}missing.jsonl`), 'undecided');
});

// ---- the judge prompts (one per `judge` category of the owner's taxonomy) ----

const JUDGE_IDS = ['broke-standing-instruction', 'unverified-claim', 'unchecked-premise', 'heavier-than-needed', 'stopped-early', 'harmful-side-effect'];

for (const id of JUDGE_IDS) {
  test(`the ${id} judge prompt loads, pins a full model and names one failure`, () => {
    const p = loadJudgePrompt(`${JUDGES}${id}.md`);
    assert.match(p.model, /^claude-/);
    assert.match(p.body, /PASS:/);
    assert.match(p.body, /FAIL:/);
    assert.match(p.body, /Critique:/);
    // invented examples only: no session id (a UUID) and no path of a real machine
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.body), 'names a session id');
    assert.ok(!/\/(?:Users|home)\/[a-z]/i.test(p.body.replace(/\/home\/x\//g, '')), 'names a real path');
  });
}
