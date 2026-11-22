import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_RUNNERS,
  unwrapTestCommand,
  testCommandOf,
  rewriteWorkPaths,
  rewritePrompt,
  commitRefsOf,
  dirsOf,
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
test('unwrapTestCommand unwraps sh -c and keeps a quote-balanced command (work dir below the cd)', () => {
  const cmd = "node /x/test-lock -- sh -c 'cd /wt/p4 && DATABASE_URL= node --test evals/a.test.ts'";
  assert.equal(unwrapTestCommand(cmd, ['/wt/p4']), 'DATABASE_URL= node --test evals/a.test.ts');
  assert.equal(unwrapTestCommand(cmd, ['/wt']), 'cd /wt/p4 && DATABASE_URL= node --test evals/a.test.ts');
  assert.equal(unwrapTestCommand('sh -c "npm test"'), 'npm test');
});
test('unwrapTestCommand accepts an empty env value before test-lock', () => {
  assert.equal(unwrapTestCommand('cd /wt && DATABASE_URL= node /x/test-lock -- node --test a.test.ts', ['/wt']), 'DATABASE_URL= node --test a.test.ts');
});
test('unwrapTestCommand sees through a timeout prefix', () => {
  assert.equal(unwrapTestCommand('cd /wt && DATABASE_URL= timeout 600 node /x/test-lock -- node --test a.test.ts', ['/wt']), 'DATABASE_URL= node --test a.test.ts');
  assert.equal(unwrapTestCommand('timeout 600 npm test'), 'npm test');
});
test('unwrapTestCommand keeps a cd below the work dir root and drops one at the root or outside it', () => {
  const run = 'node /x/test-lock -- node --test test/a.test.mjs';
  assert.equal(unwrapTestCommand(`cd /wt/plugins/methodology && ${run}`, ['/wt']), 'cd /wt/plugins/methodology && node --test test/a.test.mjs');
  assert.equal(unwrapTestCommand(`cd /wt && ${run}`, ['/wt']), 'node --test test/a.test.mjs');
  assert.equal(unwrapTestCommand(`cd /elsewhere/x && ${run}`, ['/wt']), 'node --test test/a.test.mjs');
  assert.equal(unwrapTestCommand(`cd "/wt/a b" && ${run}`, ['/wt']), null);
});
test('unwrapTestCommand splits only outside quotes', () => {
  assert.equal(unwrapTestCommand("node --test --test-name-pattern='a && b' a.test.mjs"), "node --test --test-name-pattern='a && b' a.test.mjs");
});
test('testCommandOf passes the work dirs on', () => {
  assert.equal(testCommandOf([{ command: 'cd /wt/sub && npm test', ok: true }], ['/wt']), 'cd /wt/sub && npm test');
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
test('a brief under a work dir that is not tracked is recovered from its read', () => {
  const brief = '/wt/.methodology/sdd/p/brief-T7.md';
  const r = rewritePrompt(`Read ${brief} first`, { workDirs: ['/wt'], reads: [{ path: brief, content: 'BRIEF in /wt/src/x.mjs' }], exists: () => false });
  assert.equal(r.prompt, 'Read {{CASE}}/files/brief-T7.md first');
  assert.deepEqual(r.files, [{ name: 'brief-T7.md', content: 'BRIEF in {{WORK}}/src/x.mjs' }]);
  assert.equal(r.lost, false);
});
test('a brief under a work dir that is not tracked and has no whole read is lost', () => {
  assert.equal(rewritePrompt('Read /wt/.methodology/sdd/p/brief-T7.md', { workDirs: ['/wt'], reads: [], exists: () => false }).lost, true);
});
test('a path under a work dir is judged by tracked(), not by the file system', () => {
  const brief = '/wt/.methodology/sdd/p/brief-T7.md';
  const opts = { workDirs: ['/wt'], reads: [{ path: brief, content: 'B' }], exists: () => true };
  assert.equal(rewritePrompt(`Read ${brief}`, { ...opts, tracked: () => false }).prompt, 'Read {{CASE}}/files/brief-T7.md');
  const kept = rewritePrompt('Read /wt/docs/guide.md', { ...opts, tracked: (p) => p === '/wt/docs/guide.md' });
  assert.deepEqual([kept.prompt, kept.lost, kept.files], ['Read {{WORK}}/docs/guide.md', false, []]);
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
test('commitRefsOf reads a message given by a heredoc substitution', () => {
  const command = "git add -A && git commit -m \"$(cat <<'EOF'\nfix(x): the subject\n\nBody with a \"quote\".\nEOF\n)\"";
  assert.deepEqual(commitRefsOf([{ command, ok: true, output: '' }]), [{ subject: 'fix(x): the subject' }]);
  assert.deepEqual(commitRefsOf([{ command: 'git commit -m $(cat <<EOF\nfix: bare\nEOF\n)', ok: true, output: '' }]), [{ subject: 'fix: bare' }]);
});
test('commitRefsOf reads git -C, global options and chains', () => {
  const run = (command) => commitRefsOf([{ command, ok: true, output: '' }]);
  assert.deepEqual(run('git -C /wt/p commit -q -m "fix: a"'), [{ subject: 'fix: a' }]);
  assert.deepEqual(run('git -c user.name=t --no-pager commit -m "fix: b"'), [{ subject: 'fix: b' }]);
  assert.deepEqual(run('cd /wt && git add -A && git commit -am "fix: c" && git log -1'), [{ subject: 'fix: c' }]);
  assert.deepEqual(run('git commit --message="fix: d"'), [{ subject: 'fix: d' }]);
  assert.deepEqual(run('git commit -m "fix: e\n\nbody line"'), [{ subject: 'fix: e' }]);
  assert.deepEqual(run('git commit -m \'fix: f "quoted"\''), [{ subject: 'fix: f "quoted"' }]);
});
test('commitRefsOf reads the message file a command wrote itself', () => {
  const command = "cat > /tmp/m.txt <<'EOF'\nfix(y): from file\n\nbody\nEOF\ngit commit -F /tmp/m.txt";
  assert.deepEqual(commitRefsOf([{ command, ok: true, output: '' }]), [{ subject: 'fix(y): from file' }]);
  assert.deepEqual(commitRefsOf([{ command: 'git commit -F /tmp/other.txt', ok: true, output: '' }]), []);
});
test('commitRefsOf takes every sha one command prints and ignores a command that merely mentions git commit', () => {
  const output = '[main aaa1111] one\n 1 file changed\n[main bbb2222] two\n';
  assert.deepEqual(commitRefsOf([{ command: 'git commit -m one && git commit -m two', ok: true, output }]), [{ sha: 'aaa1111' }, { sha: 'bbb2222' }]);
  assert.deepEqual(commitRefsOf([{ command: 'echo "run git commit later"', ok: true, output: '' }]), []);
});
test('commitRefsOf reads the sha a quiet commit has echoed, in the same command or the next one', () => {
  const sha = 'abc1234def5678abc1234def5678abc1234def56';
  const same = (command, output) => commitRefsOf([{ command, ok: true, output }]);
  assert.deepEqual(same('git commit -q -m "fix: x" && git rev-parse --short HEAD', 'abc1234\n'), [{ sha: 'abc1234' }]);
  assert.deepEqual(same('git commit -q -F $m && git log --oneline -1', 'abc1234 fix: x\n'), [{ sha: 'abc1234' }]);
  assert.deepEqual(same('git commit -q -F $m && git show --stat HEAD', `commit ${sha}\nAuthor: t\n`), [{ sha }]);
  assert.deepEqual(commitRefsOf([
    { command: 'git commit -q -F $m', ok: true, output: '' },
    { command: 'git status --short', ok: true, output: '' },
    { command: 'git -C /wt rev-parse HEAD', ok: true, output: `${sha}\n` },
  ]), [{ sha }]);
  assert.deepEqual(commitRefsOf([
    { command: 'git commit -q -F $m', ok: true, output: '' },
    { command: 'git commit -q -F $m', ok: true, output: '' },
    { command: 'git rev-parse HEAD', ok: true, output: `${sha}\n` },
  ]), [{ sha }]);
  assert.deepEqual(same('git commit -q -F $m && echo done', 'done\n'), []);
});
test('commitRefsOf finds the message file an earlier command wrote', () => {
  assert.deepEqual(commitRefsOf([
    { command: "m=$(mktemp -d)/msg && cat > $m <<'EOF'\nfix(z): earlier\nEOF", ok: true, output: '' },
    { command: 'git commit -q -F $m', ok: true, output: '' },
  ]), [{ subject: 'fix(z): earlier' }]);
});
test('dirsOf lists the absolute directories commands cd or git -C into', () => {
  assert.deepEqual(dirsOf([
    { command: 'cd /wt/a && git add -A && git commit -q -m x', ok: true },
    { command: 'git -C "/wt/b c" status', ok: true },
    { command: 'cd sub && cd $HOME && ls; cd /wt/a', ok: true },
    { command: "echo 'cd /not/this'", ok: true },
  ]), ['/wt/a', '/wt/b c']);
});
test('taskOf and planOf', () => {
  assert.equal(taskOf('T7 fix round 1 fixer'), 'T7');
  assert.equal(taskOf('P2 review-fixer'), null);
  assert.equal(planOf('Plan: /docs/2026-11-22-role-transcript-replay.md task T3'), '2026-11-22-role-transcript-replay');
});
