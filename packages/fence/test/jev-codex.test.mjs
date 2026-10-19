// The jev runners (test/acceptance/jev): the corpus-row -> Codex payload conversion, the per-family
// table, the decision diff between the two adapters, and the staged HOME the runners call.
//
// Hermetic: no network, no uvx and no jev. The corpus rows are small inline fixtures in the shape
// run-codex.mjs dumps from jev (id, category, disguise, expected, tool, tool_input). Every command
// string is analysed, never executed. The stageHome test writes a temp HOME, state and admin
// directory and a hand-made temp repository (no git process runs), and spawns only the staged
// trampoline, which execs process.execPath on the staged watchdog bundle with HOME=<temp>.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codex } from '../src/hosts/codex.mjs';
import { parseApplyPatch } from '../src/hosts/patch.mjs';
import { checkLogCwd, diffDecisions } from './acceptance/jev/compare.mjs';
import { classify, familyTable, formatTable, toCodexPayload } from './acceptance/jev/run-codex.mjs';
import { stageHome } from './acceptance/stage-home.mjs';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-jev-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const STRICT = fileURLToPath(new URL('../policies/strict.json', import.meta.url));
const CWD = path.join(TMP, 'project');
const SPAWN_TIMEOUT_MS = 60_000;

const row = (tool, tool_input, more = {}) => ({ id: `r-${tool}`, category: 'destructive_file_ops', disguise: 'base', expected: 'block', tool, tool_input, ...more });

test('toCodexPayload turns a Write row into an apply_patch Add File envelope', () => {
  const p = toCodexPayload(row('Write', { file_path: '.claude/settings.json', content: 'jev-harness canary content' }), { cwd: CWD });
  assert.equal(p.hook_event_name, 'PreToolUse');
  assert.equal(p.cwd, CWD);
  assert.equal(p.tool_name, 'apply_patch');
  assert.equal(p.tool_input.command, '*** Begin Patch\n*** Add File: .claude/settings.json\n+jev-harness canary content\n*** End Patch');
  assert.deepEqual(parseApplyPatch(p.tool_input.command), [{ path: '.claude/settings.json', op: 'add' }]);
  // multi-line content: one `+` line per content line
  const multi = toCodexPayload(row('Write', { file_path: 'a.txt', content: 'one\ntwo' }), { cwd: CWD });
  assert.equal(multi.tool_input.command, '*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch');
});

test('a Write row whose content ends in a newline gets no extra bare + line', () => {
  const p = toCodexPayload(row('Write', { file_path: 'a.txt', content: 'one\ntwo\n' }), { cwd: CWD });
  assert.equal(p.tool_input.command, '*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch');
  const single = toCodexPayload(row('Write', { file_path: 'a.txt', content: 'x\n' }), { cwd: CWD });
  assert.equal(single.tool_input.command, '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch');
  // an empty file is an Add File with no lines
  const empty = toCodexPayload(row('Write', { file_path: 'a.txt', content: '' }), { cwd: CWD });
  assert.equal(empty.tool_input.command, '*** Begin Patch\n*** Add File: a.txt\n*** End Patch');
  assert.deepEqual(parseApplyPatch(empty.tool_input.command), [{ path: 'a.txt', op: 'add' }]);
  // a blank line inside the content is kept as a bare + line
  const blank = toCodexPayload(row('Write', { file_path: 'a.txt', content: 'one\n\ntwo\n' }), { cwd: CWD });
  assert.equal(blank.tool_input.command, '*** Begin Patch\n*** Add File: a.txt\n+one\n+\n+two\n*** End Patch');
});

test('classify reads each host output shape', () => {
  const claudeLine = (permissionDecision, permissionDecisionReason) =>
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(permissionDecisionReason ? { permissionDecisionReason } : {}) } })}\n`;
  const FAILURE = 'fence denied this call because it could not check it: its engine failed (exit 1). Run fence repair ...';
  const cases = [
    ['claude', { status: 0, stdout: claudeLine('deny', 'no (fence rule "credentials")'), stderr: '' }, 'deny'],
    ['claude', { status: 0, stdout: claudeLine('allow'), stderr: '' }, 'allow'],
    ['claude', { status: 0, stdout: '', stderr: '' }, 'none'],
    ['claude', { status: 0, stdout: claudeLine('deny', FAILURE), stderr: '' }, 'failed'],
    ['claude', { status: 0, stdout: 'not json\n', stderr: '' }, 'failed'],
    ['claude', { status: 127, stdout: '', stderr: 'not found' }, 'failed'],
    ['codex', { status: 2, stdout: '', stderr: 'no (fence rule "credentials")' }, 'deny'],
    ['codex', { status: 2, stdout: '', stderr: FAILURE }, 'failed'],
    ['codex', { status: 0, stdout: '', stderr: '' }, 'none'],
    ['codex', { status: 0, stdout: 'garbage', stderr: '' }, 'failed'],
    ['codex', { status: 1, stdout: '', stderr: 'crash' }, 'failed'],
    ['codex', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 'failed'],
  ];
  for (const [host, result, want] of cases) assert.equal(classify(host, result), want, `${host} ${JSON.stringify(result)}`);
});

test('an Edit row becomes an Update File envelope', () => {
  const p = toCodexPayload(row('Edit', { file_path: '~/.zshrc', old_string: 'jev-canary-old', new_string: 'jev-canary-new' }), { cwd: CWD });
  assert.equal(p.tool_name, 'apply_patch');
  assert.equal(p.tool_input.command, '*** Begin Patch\n*** Update File: ~/.zshrc\n@@\n-jev-canary-old\n+jev-canary-new\n*** End Patch');
  assert.deepEqual(parseApplyPatch(p.tool_input.command), [{ path: '~/.zshrc', op: 'update' }]);
});

test('a Read row becomes a cat shell call', () => {
  const p = toCodexPayload(row('Read', { file_path: '~/.ssh/id_rsa' }), { cwd: CWD });
  assert.equal(p.tool_name, 'shell');
  assert.deepEqual(p.tool_input, { command: 'cat ~/.ssh/id_rsa' });
  const call = codex.parse(p, { home: path.join(TMP, 'home') });
  assert.equal(call.kind, 'shell');
  assert.equal(call.command, 'cat ~/.ssh/id_rsa');
  // a path the shell would split is quoted; a leading ~/ stays outside the quotes so it still expands
  assert.equal(toCodexPayload(row('Read', { file_path: 'my notes.txt' }), { cwd: CWD }).tool_input.command, "cat 'my notes.txt'");
  assert.equal(toCodexPayload(row('Read', { file_path: '~/my notes.txt' }), { cwd: CWD }).tool_input.command, "cat ~/'my notes.txt'");
  assert.equal(toCodexPayload(row('Read', { file_path: ".env's" }), { cwd: CWD }).tool_input.command, "cat '.env'\\''s'");
});

test('a Bash row keeps its command as a shell tool call', () => {
  const command = 'echo ok; rm -rf ./build';
  const p = toCodexPayload(row('Bash', { command }), { cwd: CWD });
  assert.equal(p.tool_name, 'shell');
  assert.deepEqual(p.tool_input, { command });
  assert.equal(codex.parse(p, {}).command, command);
});

test('the table printer groups by disguise', () => {
  const d = (id, disguise, expected, decision) => ({ id, category: 'c', disguise, expected, decision });
  const rows = [
    d('a', 'base', 'block', 'deny'),
    d('b', 'base', 'block', 'none'),
    d('c', 'pipe', 'block', 'deny'),
    d('d', 'pipe', 'block', 'deny'),
    d('e', 'file_tool', 'block', 'failed'),
    d('f', 'base', 'allow', 'none'),
    d('g', 'compound', 'allow', 'deny'),
  ];
  const t = familyTable(rows);
  assert.deepEqual(t.families, [
    { family: 'base', ruleBlocked: 1, allowed: 1, failed: 0 },
    { family: 'pipe', ruleBlocked: 2, allowed: 0, failed: 0 },
    { family: 'file_tool', ruleBlocked: 0, allowed: 0, failed: 1 },
  ]);
  assert.deepEqual(t.total, { family: 'total', ruleBlocked: 3, allowed: 1, failed: 1 });
  assert.equal(t.dangerous, 5);
  assert.deepEqual({ blocked: t.benignBlocked, of: t.benign }, { blocked: 1, of: 2 });
  const text = formatTable(t);
  const lines = text.split('\n');
  assert.match(lines[0], /^\| family \| rule-blocked \| allowed \|/);
  assert.ok(lines.some((l) => /^\| base \| 1 \| 1 \|/.test(l)));
  assert.ok(lines.some((l) => /^\| pipe \| 2 \| 0 \|/.test(l)));
  assert.ok(lines.some((l) => /^\| total \| 3 \| 1 \|/.test(l)));
  assert.match(text, /benign blocked: 1\/2/);
  // families come in jev's order, not the rows' order
  assert.ok(lines.findIndex((l) => l.startsWith('| base ')) < lines.findIndex((l) => l.startsWith('| pipe ')));
});

test('diffDecisions reports exactly the rows whose decisions differ', () => {
  const claude = [
    { id: 'same-deny', decision: 'deny' },
    { id: 'same-none', decision: 'none' },
    { id: 'differs', decision: 'deny' },
    { id: 'only-claude', decision: 'deny' },
  ];
  const codexRows = [
    { id: 'same-none', decision: 'none' },
    { id: 'same-deny', decision: 'deny' },
    { id: 'differs', decision: 'none' },
    { id: 'only-codex', decision: 'none' },
  ];
  assert.deepEqual(diffDecisions(claude, codexRows), { differing: ['differs', 'only-claude', 'only-codex'] });
  assert.deepEqual(diffDecisions(claude, claude), { differing: [] });
});

test('diffDecisions treats a Claude allow and a silent Codex exit 0 as the same decision', () => {
  // render.mjs renders an engine allow on Codex as no output, exit 0: Codex can not tell allow from none
  const claude = [
    { id: 'allowed', decision: 'allow' },
    { id: 'silent', decision: 'none' },
    { id: 'deny-vs-allow', decision: 'allow' },
    { id: 'failed-vs-none', decision: 'failed' },
  ];
  const codexRows = [
    { id: 'allowed', decision: 'none' },
    { id: 'silent', decision: 'none' },
    { id: 'deny-vs-allow', decision: 'deny' },
    { id: 'failed-vs-none', decision: 'none' },
  ];
  assert.deepEqual(diffDecisions(claude, codexRows), { differing: ['deny-vs-allow', 'failed-vs-none'] });
});

test('checkLogCwd accepts only log lines whose cwd and repo root are inside the project', () => {
  const state = path.join(TMP, 'cwd-state');
  const logDir = path.join(state, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const project = path.join(TMP, 'cwd-project');
  const line = (cwd, root) => JSON.stringify({ host: 'claude', cwd, repo: root === null ? null : { root, branch: 'acceptance' } });
  const file = path.join(logDir, '2026-10-18.jsonl');
  assert.equal(checkLogCwd(state, project).ok, false, 'no log lines is a failure');
  fs.writeFileSync(file, `${line(path.join(project, '.jev-tmp', 'jev-harness-x', 'guard-bench'), project)}\n`);
  assert.deepEqual(checkLogCwd(state, project), { ok: true, lines: 1, watchdog: 0 });
  const wd = `${JSON.stringify({ host: 'claude', event: 'pre', decision: 'deny', rule: 'builtin:watchdog' })}\n`;
  fs.appendFileSync(file, wd);
  assert.deepEqual(checkLogCwd(state, project), { ok: true, lines: 2, watchdog: 1 }, 'a watchdog line has no cwd and is counted, not checked');
  fs.writeFileSync(file, wd);
  assert.equal(checkLogCwd(state, project).ok, false, 'watchdog lines alone are not evidence the guard ran in the project');
  fs.writeFileSync(file, `${line(path.join(project, '.jev-tmp', 'jev-harness-x', 'guard-bench'), project)}\n`);
  fs.appendFileSync(file, `${line(path.join(TMP, 'jev-harness-y', 'guard-bench'), null)}\n`);
  const bad = checkLogCwd(state, project);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /jev-harness-y/);
  fs.writeFileSync(file, `${line(path.join(project, 'sub'), path.join(TMP, 'other'))}\n`);
  assert.equal(checkLogCwd(state, project).ok, false, 'a repo root other than the project fails');
});

test('stageHome produces a layout the watchdog accepts: rm -rf denies and ls produces no output (so it is not denying everything)', () => {
  const { home, watchdog } = stageHome(path.join(TMP, 'stage'), { policyPath: STRICT });
  assert.equal(watchdog, path.join(home, '.local', 'bin', 'fence-hook'));
  const share = path.join(home, '.local', 'share', 'fence');
  assert.equal(fs.readFileSync(path.join(share, 'current'), 'utf8'), '0.0.0-test\n');
  assert.ok(fs.statSync(path.join(share, 'versions', '0.0.0-test', 'src', 'engine.mjs')).isFile());
  assert.ok(fs.statSync(path.join(share, 'fence-hook.mjs')).isFile());
  assert.equal(fs.readFileSync(path.join(home, '.config', 'fence', 'policy.json'), 'utf8'), fs.readFileSync(STRICT, 'utf8'));
  const gitPin = path.join(share, 'git.json');
  if (fs.existsSync(gitPin)) {
    const pin = JSON.parse(fs.readFileSync(gitPin, 'utf8'));
    assert.ok(path.isAbsolute(pin.path) && /^\d+\.\d+\.\d+$/.test(pin.version));
  }

  // a hand-made repository on an unprotected branch (no git process runs)
  const project = path.join(TMP, 'stage-project');
  const git = path.join(project, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/work\n');
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n');
  const state = path.join(TMP, 'stage-state');
  const admin = path.join(TMP, 'stage-admin');
  for (const d of [state, admin]) fs.mkdirSync(d, { recursive: true });

  const pre = (command) =>
    spawnSync(watchdog, ['pre', '--host', 'claude', '--policy', path.join(home, '.config', 'fence', 'policy.json'), '--state-dir', state, '--admin-dir', admin], {
      input: JSON.stringify({ session_id: 'jev-test', cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cwd: project,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });

  const denied = pre('rm -rf ../build');
  assert.equal(denied.status, 0, denied.stderr);
  const out = JSON.parse(denied.stdout.trim()).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.doesNotMatch(out.permissionDecisionReason, /could not check it/, 'the engine, not a watchdog failure, denied it');
  assert.match(out.permissionDecisionReason, /delete-outside-repo/);

  const listed = pre('ls');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, '');
});
