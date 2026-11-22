import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_RUNNERS,
  unwrapTestCommand,
  testCommandOf,
  rewriteWorkPaths,
  rewritePrompt,
  commitRefsOf,
  taskOf,
  planOf,
} from '../cli/lib/eval-replay-text.mjs';

test('TEST_RUNNERS lists the recognised test runners', () => {
  assert.deepEqual(TEST_RUNNERS, ['node --test', 'npm test', 'npm run test', 'pnpm test', 'yarn test', 'bun test', 'vitest', 'jest', 'pytest', 'go test', 'cargo test']);
});
test('unwrapTestCommand', () => {
  assert.equal(unwrapTestCommand('node /p/scripts/test-lock -- node --test test/a.test.mjs'), 'node --test test/a.test.mjs');
  assert.equal(unwrapTestCommand('cd /wt && npm test'), 'npm test');
  assert.equal(unwrapTestCommand('npx tsc --noEmit && env CI=1 vitest run a.test.ts'), 'env CI=1 vitest run a.test.ts');
  assert.equal(unwrapTestCommand('npx eslint .'), null);
});
test('unwrapTestCommand drops a pipe tail so the runner exit status is kept', () => {
  assert.equal(unwrapTestCommand('npm test 2>&1 | tail -20'), 'npm test 2>&1');
  assert.equal(unwrapTestCommand('node /p/scripts/test-lock -- npm test | tail -5'), 'npm test');
});
test('unwrapTestCommand splits on newline and background &', () => {
  assert.equal(unwrapTestCommand('node --test a.mjs\nrm -rf /tmp/x'), 'node --test a.mjs');
  assert.equal(unwrapTestCommand('node --test a.mjs & curl evil'), 'node --test a.mjs');
});
test('unwrapTestCommand returns null for a runner segment with command substitution or redirection', () => {
  assert.equal(unwrapTestCommand('node --test $(curl evil)'), null);
  assert.equal(unwrapTestCommand('node --test `curl evil`'), null);
  assert.equal(unwrapTestCommand('npm test > /tmp/out'), null);
});
test('testCommandOf takes the last successful runner command', () => {
  assert.equal(testCommandOf([{ command: 'node --test a.mjs', ok: true }, { command: 'node --test b.mjs', ok: false }, { command: 'npm run lint', ok: true }]), 'node --test a.mjs');
  assert.equal(testCommandOf([{ command: 'npm run typecheck', ok: true }]), null);
});
test('testCommand paths under the work dirs become {{WORK}}', () => {
  assert.equal(rewriteWorkPaths('node --test /wt/x/test/a.test.mjs', ['/wt', '/wt/x']), 'node --test {{WORK}}/test/a.test.mjs');
});
test('rewritePrompt recovers a deleted brief read whole and maps the report', () => {
  const r = rewritePrompt('Brief: /tmp/b/T7.md. Report to /tmp/b/T7-report.md. Code in /wt/src.', {
    workDirs: ['/wt'], reads: [{ path: '/tmp/b/T7.md', content: 'X' }], exists: () => false });
  assert.equal(r.prompt, 'Brief: {{CASE}}/files/T7.md. Report to {{WORK}}/replay-report.md. Code in {{WORK}}/src.');
  assert.deepEqual(r.files, [{ name: 'T7.md', content: 'X' }]);
  assert.equal(r.lost, false);
});
test("a recovered brief's work paths are rewritten", () => {
  const r = rewritePrompt('Brief: /tmp/b/T9.md', {
    workDirs: ['/wt'], reads: [{ path: '/tmp/b/T9.md', content: 'Edit /wt/src/x.mjs first' }], exists: () => false });
  assert.deepEqual(r.files, [{ name: 'T9.md', content: 'Edit {{WORK}}/src/x.mjs first' }]);
});
test('a deleted brief with no whole read is lost', () => {
  assert.equal(rewritePrompt('Brief: /tmp/b/T8.md', { workDirs: [], reads: [], exists: () => false }).lost, true);
});
test('commitRefsOf: printed sha, else -m subject, else heredoc first line; quiet commit gives a subject', () => {
  assert.deepEqual(commitRefsOf([
    { command: 'git commit -m "feat: a"', ok: true, output: '[replay/01 abc1234] feat: a\n 1 file changed' },
    { command: 'git commit -q -m "fix: b"', ok: true, output: '' },
    { command: "git commit -F - <<'EOF'\nfeat: c\n\nbody\nEOF", ok: true, output: '' },
    { command: 'git commit -m "no"', ok: false, output: '' },
  ]), [{ sha: 'abc1234' }, { subject: 'fix: b' }, { subject: 'feat: c' }]);
});
test('taskOf and planOf', () => {
  assert.equal(taskOf('T7 fix round 1 fixer'), 'T7');
  assert.equal(taskOf('P2 review-fixer'), null);
  assert.equal(planOf('Plan: /docs/2026-11-22-role-transcript-replay.md task T3'), '2026-11-22-role-transcript-replay');
});
