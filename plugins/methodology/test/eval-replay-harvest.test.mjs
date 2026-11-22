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
  const lostPath = join(root, 'briefs', 'T16.md');
  const evals = join(root, 'evals');

  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.mjs', BASE_SRC);
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
  assert.equal(fx.first.found, 14);
  assert.equal(fx.first.kept, 3);
  // One dispatch per reason: the escape, the unnamed symbol and the other repo each stop at their own check.
  assert.deepEqual(fx.first.excluded, Object.fromEntries(REASONS.map((reason) => [reason, 1])));
});

test('a case whose tests pass at base is validation-failed', () => {
  const c = readCase('toolu_passes_at_base');
  assert.equal(c.validated, false);
  assert.equal(c.validation, 'passes-at-base');
});

test('a second harvest writes nothing new', () => {
  const before = snapshotTree(casesDir(fx.evals));
  const s = harvest(fx.opts);
  assert.deepEqual(snapshotTree(casesDir(fx.evals)), before);
  assert.equal(s.kept, 3);
  assert.equal(s.excluded['validation-failed'], 1);
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
