import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REASONS, caseId, casesDir, harvest, knownEscape, resolveCheckout, roleVersion,
} from '../cli/lib/eval-replay-harvest.mjs';

const ROLE = 'tdd-implementer';
const SINCE = '2026-11-19T00:00:00Z';
const AT = '2026-11-20T10:00:00Z';
const GHOST = '0123456789abcdef0123456789abcdef01234567';
const BASE_SRC = '// Shared helpers. The test files import assert and test.\nexport function add(a, b) { return a + b; }\n';

// Invented repositories only. git runs with an args array and a timeout; the fixture commits sign nothing.
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const write = (cwd, path, body) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), body);
};

// Stages everything, commits quietly and returns the full sha.
function commit(cwd, subject) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

// Like commit, with both git dates fixed: the dispatch window is read from them.
function commitAt(cwd, subject, at) {
  git(cwd, 'add', '-A');
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

const fn = (name, value) => `export function ${name}() { return ${value}; }\n`;
// A test that imports one symbol from a source file and checks it is a function.
const bindingTest = (symbol, from) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${symbol} } from '${from}';\n\ntest('${symbol}', () => {\n  assert.equal(typeof ${symbol}, 'function');\n});\n`;
// The line a printing `git commit` shows: [branch short-sha] subject.
const printed = (branch, sha, subject) => `[${branch} ${sha.slice(0, 7)}] ${subject}`;
const agentIdOf = (toolUseId) => createHash('sha256').update(toolUseId).digest('hex').slice(0, 8);
const numbered = (text) => text.split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');

// The records of one subagent step: a whole Read, a failed Read, or a Bash command with its output.
function stepRecords(step, i, cwd) {
  const id = `s${i}`;
  const rec = (role, content) => ({ type: role, timestamp: AT, cwd, message: { role, content } });
  const use = (name, input) => rec('assistant', [{ type: 'tool_use', id, name, input }]);
  const result = (content, isError) => rec('user', [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
  if (step.read !== undefined) return [use('Read', { file_path: step.read }), result(numbered(step.text))];
  if (step.readError !== undefined) return [use('Read', { file_path: step.readError }), result('File does not exist.', true)];
  return [use('Bash', { command: step.bash }), result(step.out ?? '', step.err === true)];
}

// Main transcript of the dispatches (one project, one session) and one subagent transcript per dispatch that has steps.
function writeTranscripts(transcripts, dispatches) {
  const proj = join(transcripts, 'proj');
  const subagents = join(proj, 'sess', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const main = [];
  for (const d of dispatches) {
    // What the dispatching session did before the dispatch: Write or Edit tool calls (all successful).
    for (const [i, step] of (d.before ?? []).entries()) {
      const id = `${d.id}_before${i}`;
      main.push({ type: 'assistant', timestamp: AT, cwd: d.cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input: step.input }] } });
      main.push({ type: 'user', timestamp: AT, cwd: d.cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: {} });
    }
    main.push({ type: 'assistant', timestamp: AT, cwd: d.cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: d.id, name: 'Agent', input: { subagent_type: `roles:${ROLE}`, description: d.description, prompt: d.prompt } }] } });
    const agentId = d.steps ? agentIdOf(d.id) : undefined;
    main.push({ type: 'user', timestamp: AT, cwd: d.cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: d.id, content: 'done' }] }, toolUseResult: agentId ? { agentId } : {} });
    if (agentId) {
      const lines = d.steps.flatMap((step, i) => stepRecords(step, i, d.cwd));
      writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${lines.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
  }
  writeFileSync(join(proj, 'sess.jsonl'), `${main.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

// Every JSON file's text and every directory under dir, sorted, so two harvests can be compared.
function snapshotTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out.push([p, 'dir']); walk(p); } else out.push([p, readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

let fx;
const readCase = (toolUseId, evals = fx.evals) => JSON.parse(readFileSync(join(casesDir(evals), caseId(ROLE, toolUseId), 'case.json'), 'utf8'));

before(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'replay-harvest-')));
  const repo = join(root, 'work', 'fixture-repo');
  const other = join(root, 'work', 'other-fixture');
  const briefPath = join(root, 'briefs', 'T7.md');
  const workBrief = join(repo, '.methodology', 'sdd', 'p', 'task-g.md');
  const workLost = join(repo, '.methodology', 'sdd', 'p', 'task-missing.md');
  const lostPath = join(root, 'briefs', 'T16.md');
  const evals = join(root, 'evals');

  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', BASE_SRC);
  write(repo, 'docs/guide.md', '# Guide\n');
  const baseSha = commit(repo, 'feat: base');
  git(repo, 'checkout', '-q', '-b', 'side');
  write(repo, 'src/s.mjs', fn('side', '1'));
  write(repo, 'test/s.test.mjs', bindingTest('side', '../src/s.mjs'));
  const side = commit(repo, 'feat: side');
  git(repo, 'checkout', '-q', 'main');
  write(repo, 'src/b.mjs', fn('bee', "'b'"));
  write(repo, 'test/b.test.mjs', bindingTest('bee', '../src/b.mjs'));
  const bee = commit(repo, 'feat: bee');
  write(repo, 'src/q.mjs', fn('quiet', "'q'"));
  write(repo, 'test/q.test.mjs', bindingTest('quiet', '../src/q.mjs'));
  const quiet = commit(repo, 'feat: quiet change');
  write(repo, 'src/a.mjs', BASE_SRC.replace('Shared helpers.', 'Shared helpers, tidied.'));
  const notests = commit(repo, 'chore: tidy comment');
  write(repo, 'src/zed.mjs', fn('zed', '1'));
  write(repo, 'test/zed.test.mjs', bindingTest('zed', '../src/zed.mjs'));
  const zed = commit(repo, 'feat: zed helper');
  write(repo, 'src/e.mjs', fn('eee', '2'));
  write(repo, 'test/e.test.mjs', bindingTest('eee', '../src/e.mjs'));
  const esc = commit(repo, 'feat: escape');
  write(repo, 'test/p.test.mjs', "import { test } from 'node:test';\n\ntest('passes everywhere', () => {});\n");
  const passes = commit(repo, 'feat: trivial');
  // Its test takes about two seconds: it fails at base at once (src/w.mjs is missing) and passes at original after the wait.
  write(repo, 'src/w.mjs', fn('wait', "'w'"));
  write(repo, 'test/w.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { wait } from '../src/w.mjs';\n\ntest('wait', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 2000));\n  assert.equal(typeof wait, 'function');\n});\n");
  const slow = commit(repo, 'feat: slow wait');

  write(repo, 'src/g.mjs', fn('gamma', "'g'"));
  write(repo, 'test/g.test.mjs', bindingTest('gamma', '../src/g.mjs'));
  const gamma = commit(repo, 'feat: gamma');
  write(repo, 'src/d.mjs', fn('delta', "'d'"));
  write(repo, 'test/d.test.mjs', bindingTest('delta', '../src/d.mjs'));
  commit(repo, 'feat: delta');
  // Gitignored in real repositories: on disk, never tracked, so it never exists in a clone.
  write(repo, '.methodology/sdd/p/task-g.md', '# T21 brief\nAdd gamma() in the file at ' + join(repo, 'src', 'g.mjs') + '.\n');

  mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  write(other, 'src/base.mjs', '// The test files import assert and test.\n');
  commit(other, 'feat: other base');
  write(other, 'src/o.mjs', fn('oo', '3'));
  write(other, 'test/o.test.mjs', bindingTest('oo', '../src/o.mjs'));
  const otherSha = commit(other, 'feat: other');

  const dispatches = [
    {
      id: 'toolu_brief', cwd: repo, description: 'T7 tdd-implementer',
      prompt: `Implement T7 from the brief at ${briefPath}. Edit src/b.mjs. Run the test command.`,
      steps: [
        { read: briefPath, text: '# T7 brief\nAdd bee() in src/b.mjs. Run the test command.\n' },
        { bash: 'node --test test/b.test.mjs' },
        { bash: 'git commit -m "feat: bee"', out: printed('main', bee, 'feat: bee') },
      ],
    },
    {
      id: 'toolu_quiet', cwd: repo, description: 'T8 tdd-implementer',
      prompt: 'Implement T8: add quiet() in src/q.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/q.test.mjs' },
        { bash: 'git commit -q -m "feat: quiet change"', out: '' },
      ],
    },
    {
      id: 'toolu_notmerged', cwd: repo, description: 'T9 tdd-implementer',
      prompt: 'Implement T9 in src/s.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/s.test.mjs' },
        { bash: 'git commit -m "feat: side"', out: printed('side', side, 'feat: side') },
      ],
    },
    {
      id: 'toolu_notests', cwd: repo, description: 'T10 tdd-implementer',
      prompt: 'Implement T10 in src/a.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/b.test.mjs' },
        { bash: 'git commit -m "chore: tidy comment"', out: printed('main', notests, 'chore: tidy comment') },
      ],
    },
    {
      id: 'toolu_zed', cwd: repo, description: 'T11 tdd-implementer',
      prompt: 'Implement T11 in the new helper file. Run the test command.',
      steps: [
        { bash: 'node --test test/zed.test.mjs' },
        { bash: 'git commit -m "feat: zed helper"', out: printed('main', zed, 'feat: zed helper') },
      ],
    },
    {
      id: 'toolu_workbrief', cwd: repo, description: 'T21 tdd-implementer',
      prompt: `Implement T21: read ${workBrief} and ${join(repo, 'docs', 'guide.md')}, then add gamma(). Run the test command.`,
      steps: [
        { read: workBrief, text: `# T21 brief\nAdd gamma() in the file at ${join(repo, 'src', 'g.mjs')}.\n` },
        { bash: `cd ${repo} && GAMMA= timeout 600 node /x/scripts/test-lock -- node --test test/g.test.mjs` },
        { bash: 'git commit -m "feat: gamma"', out: printed('main', gamma, 'feat: gamma') },
      ],
    },
    {
      id: 'toolu_worklost', cwd: repo, description: 'T22 tdd-implementer',
      prompt: `Implement T22: read ${workLost} first. Run the test command.`,
      steps: [
        { bash: 'node --test test/b.test.mjs' },
        { bash: 'git commit -m "feat: bee"', out: printed('main', bee, 'feat: bee') },
      ],
    },
    {
      // The agent started in a directory that is no repository and worked in the repository through cd; its commit prints no sha, so it resolves by its subject.
      id: 'toolu_cdrepo', cwd: join(root, 'work'), description: 'T23 tdd-implementer',
      prompt: `Implement T23: add delta() in ${join(repo, 'src', 'd.mjs')}. Run the test command.`,
      steps: [
        { bash: `cd ${repo} && node --test test/d.test.mjs` },
        { bash: `cd ${repo} && git add -A && git commit -q -m "feat: delta"`, out: '' },
      ],
    },
    {
      // Its worktree is deleted; the repository holds the commit and the worktree path is below it.
      id: 'toolu_gonewt', cwd: join(repo, '.claude', 'worktrees', 'gone'), description: 'T24 tdd-implementer',
      prompt: `Implement T24: add delta() in ${join(repo, '.claude', 'worktrees', 'gone', 'src', 'd.mjs')}. Run the test command.`,
      steps: [
        { bash: 'node --test test/d.test.mjs' },
        { bash: 'git commit -q -m "feat: delta"', out: '' },
      ],
    },
    {
      id: 'toolu_nosub', cwd: repo, description: 'T12 tdd-implementer',
      prompt: 'Implement T12 in src/b.mjs. Run the test command.',
      steps: null,
    },
    {
      id: 'toolu_other', cwd: other, description: 'T15 tdd-implementer',
      prompt: 'Implement T15: add oo() in src/o.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/o.test.mjs' },
        { bash: 'git commit -m "feat: other"', out: printed('main', otherSha, 'feat: other') },
      ],
    },
    {
      id: 'toolu_escape', cwd: repo, description: 'T13 tdd-implementer',
      prompt: 'Implement T13 of plan 2026-11-20-role-replay in src/e.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/e.test.mjs' },
        { bash: 'git commit -m "feat: escape"', out: printed('main', esc, 'feat: escape') },
      ],
    },
    {
      id: 'toolu_passes_at_base', cwd: repo, description: 'T14 tdd-implementer',
      prompt: 'Implement T14 in src/p.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/p.test.mjs' },
        { bash: 'git commit -m "feat: trivial"', out: printed('main', passes, 'feat: trivial') },
      ],
    },
    {
      id: 'toolu_slow', cwd: repo, description: 'T20 tdd-implementer',
      prompt: 'Implement T20: add wait() in src/w.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/w.test.mjs' },
        { bash: 'git commit -m "feat: slow wait"', out: printed('main', slow, 'feat: slow wait') },
      ],
    },
    {
      id: 'toolu_nocommit', cwd: repo, description: 'T17 tdd-implementer',
      prompt: 'Implement T17 in src/b.mjs. Run the test command.',
      steps: [{ bash: 'node --test test/b.test.mjs' }],
    },
    {
      id: 'toolu_notestcmd', cwd: repo, description: 'T18 tdd-implementer',
      prompt: 'Implement T18 in src/q.mjs. Run the test command.',
      steps: [
        { bash: 'npm run lint' },
        { bash: 'git commit -m "feat: quiet change"', out: printed('main', quiet, 'feat: quiet change') },
      ],
    },
    {
      id: 'toolu_lost', cwd: repo, description: 'T16 tdd-implementer',
      prompt: `Implement T16 from the brief at ${lostPath}. Run the test command.`,
      steps: [
        { readError: lostPath },
        { bash: 'node --test test/b.test.mjs' },
        { bash: 'git commit -m "feat: bee"', out: printed('main', bee, 'feat: bee') },
      ],
    },
    {
      id: 'toolu_unreachable', cwd: repo, description: 'T19 tdd-implementer',
      prompt: 'Implement T19 in src/b.mjs. Run the test command.',
      steps: [
        { bash: 'node --test test/b.test.mjs' },
        { bash: 'git commit -m "feat: ghost"', out: `[main ${GHOST}] feat: ghost` },
      ],
    },
  ];
  const transcripts = join(root, 'transcripts');
  writeTranscripts(transcripts, dispatches);

  // NODE_TEST_CONTEXT is set by the test runner; a nested `node --test` under it skips its files and exits 0, so it is dropped.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  const opts = {
    role: ROLE,
    since: SINCE,
    root: transcripts,
    evals,
    version: { sha: 'f00dfeed' },
    records: [{ kind: 'final-escapes', plan: '2026-11-20-role-replay.md', task: 'final', escapes: [{ task: 'T13', severity: 'important' }] }],
    repos: { 'fixture-repo': { setup: 'true', timeoutSeconds: 30 } },
    env,
  };
  fx = { root, repo, evals, opts, first: harvest(opts) };
});

after(() => {
  if (fx) rmSync(fx.root, { recursive: true, force: true });
});

test('caseId is the first 16 hex of sha256 over role and tool use id, and casesDir is replay/cases', () => {
  const id = caseId(ROLE, 'toolu_brief');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, createHash('sha256').update(`${ROLE}\ntoolu_brief`).digest('hex').slice(0, 16));
  assert.equal(casesDir('/evals'), join('/evals', 'replay', 'cases'));
});

test('roleVersion reads the last commit of the role file and is null without one', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'replay-role-')));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, `plugins/roles/agents/${ROLE}.md`, '# role\n');
    const sha = commit(dir, 'feat: role');
    const v = roleVersion(ROLE, dir);
    assert.equal(v.sha, sha);
    assert.match(v.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(roleVersion('review-fixer', dir), null);
    assert.equal(roleVersion(ROLE, null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCheckout returns a checkout that holds the role files', () => {
  const top = resolveCheckout({ cwd: tmpdir() });
  assert.ok(top !== null && existsSync(join(top, 'plugins', 'roles', 'agents')));
});

test('knownEscape matches final-escapes entries and escape records by plan base name', () => {
  const records = [{ kind: 'final-escapes', plan: 'p-2026-11-20-x.md', task: 'final', escapes: [{ task: 'T7', severity: 'important' }] }];
  assert.equal(knownEscape({ plan: 'p-2026-11-20-x', task: 'T7' }, records), true);
  assert.equal(knownEscape({ plan: 'p-2026-11-20-x', task: 'T8' }, records), false);
  assert.equal(knownEscape({ plan: null, task: 'T7' }, records), false);
  const escapes = [{ kind: 'escape', plan: 'p-2026-11-20-x.md', task: 'T9' }];
  assert.equal(knownEscape({ plan: 'p-2026-11-20-x', task: 'T9' }, escapes), true);
});

test('a deleted brief read whole becomes a case with files/ and {{CASE}}', () => {
  const c = readCase('toolu_brief');
  assert.equal(c.v, 1);
  assert.equal(c.id, caseId(ROLE, 'toolu_brief'));
  assert.match(c.prompt, /\{\{CASE\}\}\/files\/T7\.md/);
  assert.match(readFileSync(join(casesDir(fx.evals), c.id, 'files', 'T7.md'), 'utf8'), /Add bee\(\)/);
  assert.equal(c.validated, true);
  assert.equal(c.validation, 'pass');
  assert.deepEqual(c.hiddenTests, ['test/b.test.mjs']);
  assert.equal(c.testCommand, 'node --test test/b.test.mjs');
});

test('a case directory and its files are private', () => {
  const dir = join(casesDir(fx.evals), caseId(ROLE, 'toolu_brief'));
  assert.equal(statSync(join(dir, 'case.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'files', 'T7.md')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a quiet commit is found by subject', () => {
  assert.ok(existsSync(join(casesDir(fx.evals), caseId(ROLE, 'toolu_quiet'), 'case.json')));
});

test('exclusions carry their reasons', () => {
  assert.equal(fx.first.found, 18);
  assert.equal(fx.first.kept, 6);
  // One dispatch per reason: the escape, the unnamed symbol and the other repo each stop at their own check; a brief under
  // the work dir that is neither tracked nor read is lost like one outside it.
  assert.deepEqual(fx.first.excluded, { ...Object.fromEntries(REASONS.map((reason) => [reason, 1])), 'brief-lost': 2 });
});

test('a brief under the work dir is recovered and the case.json carries no real checkout path in its prompt', () => {
  const c = readCase('toolu_workbrief');
  assert.equal(c.prompt, 'Implement T21: read {{CASE}}/files/task-g.md and {{WORK}}/docs/guide.md, then add gamma(). Run the test command.');
  assert.equal(readFileSync(join(casesDir(fx.evals), c.id, 'files', 'task-g.md'), 'utf8'), '# T21 brief\nAdd gamma() in the file at {{WORK}}/src/g.mjs.\n');
  assert.equal(c.validated, true);
  assert.equal(c.testCommand, 'GAMMA= node --test test/g.test.mjs');
});

test('a repository is found through cd and through a deleted worktree path', () => {
  for (const id of ['toolu_cdrepo', 'toolu_gonewt']) {
    const c = readCase(id);
    assert.equal(c.validated, true, id);
    assert.equal(c.repo, fx.repo, id);
    assert.equal(c.testCommand.replace(/^cd \{\{WORK\}\} && /, ''), 'node --test test/d.test.mjs', id);
  }
  assert.equal(readCase('toolu_cdrepo').prompt, 'Implement T23: add delta() in {{WORK}}/src/d.mjs. Run the test command.');
  assert.equal(readCase('toolu_gonewt').prompt, 'Implement T24: add delta() in {{WORK}}/src/d.mjs. Run the test command.');
});

test('a case whose tests pass at base is validation-failed and is not stored, so a later harvest retries it', () => {
  assert.equal(existsSync(join(casesDir(fx.evals), caseId(ROLE, 'toolu_passes_at_base'))), false);
  assert.equal(fx.first.excluded['validation-failed'], 1);
});

test('a second harvest writes nothing new', () => {
  const before = snapshotTree(casesDir(fx.evals));
  const s = harvest(fx.opts);
  assert.deepEqual(snapshotTree(casesDir(fx.evals)), before);
  assert.equal(s.kept, 6);
  assert.equal(s.excluded['validation-failed'], 1);
});

test('a stored case that did not validate is rebuilt by the next harvest; a validated one is never rewritten', () => {
  const evals = mkdtempSync(join(fx.root, 'evals-'));
  const dir = join(casesDir(evals), caseId(ROLE, 'toolu_brief'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ v: 1, validated: false, validation: 'passes-at-base' }));
  const s = harvest({ ...fx.opts, evals });
  assert.equal(readCase('toolu_brief', evals).validated, true);
  assert.equal(s.kept, 6);
  const before = snapshotTree(casesDir(evals));
  harvest({ ...fx.opts, evals });
  assert.deepEqual(snapshotTree(casesDir(evals)), before);
});

test('a slow test command is not cut short by the setup timeout', () => {
  const evals = mkdtempSync(join(fx.root, 'evals-'));
  harvest({ ...fx.opts, evals, repos: { 'fixture-repo': { setup: 'true', timeoutSeconds: 1 } } });
  const c = readCase('toolu_slow', evals);
  assert.equal(c.validated, true);
  assert.equal(c.validation, 'pass');
});

test('an interrupted write leaves no case a rerun would skip', () => {
  const evals = mkdtempSync(join(fx.root, 'evals-'));
  mkdirSync(join(casesDir(evals), `.tmp-${caseId(ROLE, 'toolu_brief')}-999`), { recursive: true });
  harvest({ ...fx.opts, evals });
  assert.equal(readCase('toolu_brief', evals).validated, true);
});

// A second fixture for brief recovery, the work directory of a deleted checkout and the repository a subject resolves in. Every
// commit is dated: the dispatches run at AT, so a commit dated OLD is outside their time window.
const OLD = '2026-11-01T10:00:00Z';
let ex;
const readExCase = (toolUseId) => JSON.parse(readFileSync(join(casesDir(ex.evals), caseId(ROLE, toolUseId), 'case.json'), 'utf8'));
const exCaseExists = (toolUseId) => existsSync(join(casesDir(ex.evals), caseId(ROLE, toolUseId), 'case.json'));

before(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'replay-harvest2-')));
  const repo = join(root, 'work', 'ex-repo');
  const other = join(root, 'work', 'ex-other');
  const evals = join(root, 'evals');
  const brief = (name) => join(root, 'briefs', name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', BASE_SRC);
  commitAt(repo, 'feat: base', AT);
  const add = (file, symbol, subject, at = AT, dir = 'src') => {
    const parent = dir === 'src' ? '' : `${dir.replace(/\/src$/, '')}/`;
    write(repo, `${dir}/${file}.mjs`, fn(symbol, "'x'"));
    write(repo, `${parent}test/${file}.test.mjs`, bindingTest(symbol, `../src/${file}.mjs`));
    return commitAt(repo, subject, at);
  };
  const shas = {
    cat: add('c1', 'cee', 'feat: brief by cat'),
    write: add('c2', 'dee', 'feat: brief by write'),
    kappa: add('k', 'kappa', 'feat: kappa', AT, 'pkg/src'),
    lambda: add('l', 'lambda', 'feat: lambda', AT, 'pkg2/src'),
    mu: add('m', 'mu', 'feat: mu', AT, 'pkg3/inner/src'),
    twinOld: add('t1', 'ta', 'fix: twin', OLD),
    twin: add('t2', 'tb', 'fix: twin'),
    dup1: add('t3', 'tc', 'fix: dup'),
    dup2: add('t4', 'td', 'fix: dup'),
    stale1: add('t5', 'te', 'fix: stale', OLD),
    stale2: add('t6', 'tf', 'fix: stale', OLD),
    shared: add('s1', 'sone', 'feat: shared'),
    shared2: add('s2', 'stwo', 'feat: shared2'),
  };
  mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  write(other, 'src/base.mjs', '// The test files import assert and test.\n');
  commitAt(other, 'feat: other base', AT);
  write(other, 'src/o1.mjs', fn('oone', '1'));
  write(other, 'test/o1.test.mjs', bindingTest('oone', '../src/o1.mjs'));
  commitAt(other, 'feat: shared', AT);
  write(other, 'src/o2.mjs', fn('otwo', '2'));
  write(other, 'test/o2.test.mjs', bindingTest('otwo', '../src/o2.mjs'));
  commitAt(other, 'feat: shared2', AT);

  const quiet = (subject) => ({ bash: `git commit -q -m "${subject}"`, out: '' });
  const catSteps = (name, test, sha, subject, command, out) => [{ bash: command ?? `cat ${brief(name)}`, out }, { bash: `node --test test/${test}.test.mjs` }, { bash: `git commit -m "${subject}"`, out: printed('main', sha, subject) }];
  const text = '# Brief\nAdd cee() in src/c1.mjs. Run the test command.\n';
  const dispatches = [
    { id: 'toolu_cat', cwd: repo, description: 'T1 tdd-implementer', prompt: `Implement T1 from ${brief('cat.md')}. Run the test command. Add cee().`, steps: catSteps('cat.md', 'c1', shas.cat, 'feat: brief by cat', undefined, text) },
    { id: 'toolu_catcd', cwd: repo, description: 'T1b tdd-implementer', prompt: `Implement T1 from ${brief('catcd.md')}. Add cee().`, steps: catSteps('catcd.md', 'c1', shas.cat, 'feat: brief by cat', `cd ${brief('')} && cat catcd.md`, text) },
    { id: 'toolu_cattrunc', cwd: repo, description: 'T2 tdd-implementer', prompt: `Implement T2 from ${brief('trunc.md')}. Add cee().`, steps: catSteps('trunc.md', 'c1', shas.cat, 'feat: brief by cat', undefined, '<persisted-output>\nOutput too large (53.8KB). Full output saved to: /tmp/x\n</persisted-output>') },
    { id: 'toolu_cathead', cwd: repo, description: 'T3 tdd-implementer', prompt: `Implement T3 from ${brief('head.md')}. Add cee().`, steps: catSteps('head.md', 'c1', shas.cat, 'feat: brief by cat', `head -50 ${brief('head.md')}`, text) },
    { id: 'toolu_catmulti', cwd: repo, description: 'T4 tdd-implementer', prompt: `Implement T4 from ${brief('multi.md')}. Add cee().`, steps: catSteps('multi.md', 'c1', shas.cat, 'feat: brief by cat', `cat ${brief('multi.md')} ${brief('other.md')}`, text) },
    {
      id: 'toolu_write', cwd: repo, description: 'T5 tdd-implementer', prompt: `Implement T5 from ${brief('written.md')}. Add dee().`,
      before: [{ tool: 'Write', input: { file_path: brief('written.md'), content: 'draft' } }, { tool: 'Write', input: { file_path: brief('written.md'), content: '# T5 brief\nAdd dee() in src/c2.mjs.\n' } }],
      steps: [{ bash: 'node --test test/c2.test.mjs' }, { bash: 'git commit -m "feat: brief by write"', out: printed('main', shas.write, 'feat: brief by write') }],
    },
    {
      id: 'toolu_writeedit', cwd: repo, description: 'T6 tdd-implementer', prompt: `Implement T6 from ${brief('edited.md')}. Add dee().`,
      before: [{ tool: 'Write', input: { file_path: brief('edited.md'), content: '# T6 brief\n' } }, { tool: 'Edit', input: { file_path: brief('edited.md'), old_string: 'T6', new_string: 'T6b' } }],
      steps: [{ bash: 'node --test test/c2.test.mjs' }, { bash: 'git commit -m "feat: brief by write"', out: printed('main', shas.write, 'feat: brief by write') }],
    },
    {
      // The checkout is deleted, and so is the package directory the command ran in; the checkout is a .worktrees/<name> path.
      id: 'toolu_kappa', cwd: repo, description: 'T7 tdd-implementer', prompt: `Implement T7: add kappa() in ${join(repo, '.worktrees', 'gone', 'pkg', 'src', 'k.mjs')}.`,
      steps: [{ bash: `cd ${join(repo, '.worktrees', 'gone', 'pkg')} && node --test test/k.test.mjs` }, { bash: 'git commit -m "feat: kappa"', out: printed('main', shas.kappa, 'feat: kappa') }],
    },
    {
      // The checkout path has no .worktrees segment; the cwd of the transcript names it.
      id: 'toolu_lambda', cwd: join(repo, 'wt-gone'), description: 'T8 tdd-implementer', prompt: `Implement T8: add lambda() in ${join(repo, 'wt-gone', 'pkg2', 'src', 'l.mjs')}.`,
      steps: [{ bash: `cd ${join(repo, 'wt-gone', 'pkg2')} && node --test test/l.test.mjs` }, { bash: 'git commit -m "feat: lambda"', out: printed('main', shas.lambda, 'feat: lambda') }],
    },
    {
      // Three nested deleted directories are known: the shallowest is the checkout top, not the nearest one above the package.
      id: 'toolu_mu', cwd: join(repo, 'wt-gone2'), description: 'T14 tdd-implementer', prompt: `Implement T14: add mu() in ${join(repo, 'wt-gone2', 'pkg3', 'inner', 'src', 'm.mjs')}.`,
      steps: [{ bash: `cd ${join(repo, 'wt-gone2', 'pkg3')} && ls` }, { bash: `cd ${join(repo, 'wt-gone2', 'pkg3', 'inner')} && node --test test/m.test.mjs` }, { bash: 'git commit -m "feat: mu"', out: printed('main', shas.mu, 'feat: mu') }],
    },
    { id: 'toolu_twin', cwd: repo, description: 'T9 tdd-implementer', prompt: 'Implement T9: add tb() in src/t2.mjs.', steps: [{ bash: 'node --test test/t2.test.mjs' }, quiet('fix: twin')] },
    { id: 'toolu_dup', cwd: repo, description: 'T10 tdd-implementer', prompt: 'Implement T10: add tc() in src/t3.mjs.', steps: [{ bash: 'node --test test/t3.test.mjs' }, quiet('fix: dup')] },
    { id: 'toolu_stale', cwd: repo, description: 'T11 tdd-implementer', prompt: 'Implement T11: add te() in src/t5.mjs.', steps: [{ bash: 'node --test test/t5.test.mjs' }, quiet('fix: stale')] },
    {
      // The commit ran in ex-other, so its repository is preferred although ex-repo holds a commit of the same subject.
      id: 'toolu_prefer', cwd: join(root, 'work'), description: 'T12 tdd-implementer', prompt: 'Implement T12: add oone() in src/o1.mjs.',
      steps: [{ bash: `cd ${repo} && ls` }, { bash: `cd ${other} && node --test test/o1.test.mjs` }, { bash: `cd ${other} && git commit -q -m "feat: shared"`, out: '' }],
    },
    {
      // No command ran a commit in either repository: the subject matches both, so the dispatch is ambiguous.
      id: 'toolu_both', cwd: join(root, 'work'), description: 'T13 tdd-implementer', prompt: 'Implement T13: add stwo() in src/s2.mjs.',
      steps: [{ bash: `cd ${repo} && node --test test/s2.test.mjs` }, { bash: `cd ${other} && ls` }, { bash: 'git commit -q -m "feat: shared2"', out: '' }],
    },
  ];
  const transcripts = join(root, 'transcripts');
  writeTranscripts(transcripts, dispatches);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  const opts = { role: ROLE, since: SINCE, root: transcripts, evals, version: { sha: 'f00dfeed' }, records: [], repos: { 'ex-repo': { setup: 'true', timeoutSeconds: 30 }, 'ex-other': { setup: 'true', timeoutSeconds: 30 } }, env };
  ex = { root, repo, other, evals, shas, first: harvest(opts) };
});

after(() => {
  if (ex) rmSync(ex.root, { recursive: true, force: true });
});

test('a brief the agent printed whole with cat, or the dispatcher wrote with Write, is recovered; partial and truncated ones stay lost', () => {
  const cat = readExCase('toolu_cat');
  assert.equal(cat.prompt, 'Implement T1 from {{CASE}}/files/cat.md. Run the test command. Add cee().');
  assert.equal(readFileSync(join(casesDir(ex.evals), cat.id, 'files', 'cat.md'), 'utf8'), '# Brief\nAdd cee() in src/c1.mjs. Run the test command.\n');
  assert.equal(readFileSync(join(casesDir(ex.evals), caseId(ROLE, 'toolu_catcd'), 'files', 'catcd.md'), 'utf8'), '# Brief\nAdd cee() in src/c1.mjs. Run the test command.\n');
  const written = readExCase('toolu_write');
  assert.equal(written.prompt, 'Implement T5 from {{CASE}}/files/written.md. Add dee().');
  assert.equal(readFileSync(join(casesDir(ex.evals), written.id, 'files', 'written.md'), 'utf8'), '# T5 brief\nAdd dee() in src/c2.mjs.\n');
  for (const id of ['toolu_cattrunc', 'toolu_cathead', 'toolu_catmulti', 'toolu_writeedit']) assert.equal(exCaseExists(id), false, id);
  assert.equal(ex.first.excluded['brief-lost'], 4);
});

test('a deleted subdirectory resolves to its checkout root, with or without a .worktrees segment', () => {
  const kappa = readExCase('toolu_kappa');
  assert.equal(kappa.prompt, 'Implement T7: add kappa() in {{WORK}}/pkg/src/k.mjs.');
  assert.equal(kappa.testCommand, 'cd {{WORK}}/pkg && node --test test/k.test.mjs');
  const lambda = readExCase('toolu_lambda');
  assert.equal(lambda.prompt, 'Implement T8: add lambda() in {{WORK}}/pkg2/src/l.mjs.');
  assert.equal(lambda.testCommand, 'cd {{WORK}}/pkg2 && node --test test/l.test.mjs');
  assert.equal(kappa.validated && lambda.validated, true);
});

test('of several nested deleted directories the shallowest known one is the checkout top', () => {
  const mu = readExCase('toolu_mu');
  assert.equal(mu.prompt, 'Implement T14: add mu() in {{WORK}}/pkg3/inner/src/m.mjs.');
  assert.equal(mu.testCommand, 'cd {{WORK}}/pkg3/inner && node --test test/m.test.mjs');
  assert.equal(mu.validated, true);
});

test('a subject shared by several commits is taken only when one is in the dispatch window or one repository ran the commit', () => {
  assert.equal(readExCase('toolu_twin').original, ex.shas.twin);
  assert.equal(readExCase('toolu_prefer').repo, ex.other);
  assert.equal(exCaseExists('toolu_dup'), false);
  assert.equal(exCaseExists('toolu_stale'), false);
  assert.equal(exCaseExists('toolu_both'), false);
  assert.equal(ex.first.excluded.unreachable, 3);
  assert.equal(ex.first.kept, 8);
});
