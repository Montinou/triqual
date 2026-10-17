import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claude } from '../src/hosts/claude.mjs';
import { codex } from '../src/hosts/codex.mjs';
import { parseApplyPatch } from '../src/hosts/patch.mjs';
import { KNOWN_TOOLS, OPAQUE_INPUT_FIELDS, lookupTool } from '../src/hosts/tools.mjs';
import { CALL_KINDS, assertCanonicalCall } from '../src/hosts/types.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { evaluate } from '../src/eval/evaluate.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';
import { fake, FAKE_EVENT } from './fixtures/fake-adapter.mjs';
import { runAdapterContract } from './adapter-contract.mjs';

const CWD = '/work/repo';
const CTX = { home: '/home/tester' };

// A captured-shape Claude PreToolUse payload.
function payload(tool_name, tool_input, more = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/work/transcript.jsonl',
    cwd: CWD,
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: 'toolu_01',
    ...more,
  };
}

function parse(tool_name, tool_input, more) {
  const call = claude.parse(payload(tool_name, tool_input, more), CTX);
  assertCanonicalCall(call);
  return call;
}

test('Bash maps to a shell call with the payload cwd', () => {
  const call = parse('Bash', { command: 'ls -la', description: 'list' });
  assert.equal(call.host, 'claude');
  assert.equal(call.event, 'PreToolUse');
  assert.equal(call.tool, 'Bash');
  assert.equal(call.kind, 'shell');
  assert.equal(call.command, 'ls -la');
  assert.equal(call.cwd, CWD);
  assert.equal(call.session_id, 'sess-1');
  assert.equal(call.tool_use_id, 'toolu_01');
  assert.deepEqual(call.paths, []);
  assert.equal(call.opaque, undefined);
  // Monitor with a command is read as a shell call.
  const mon = parse('Monitor', { command: 'tail -f ./log' });
  assert.equal(mon.kind, 'shell');
  assert.equal(mon.command, 'tail -f ./log');
  // A cd made in an earlier call is already in the payload cwd (cwd-probe RESULT.md: follows yes).
  assert.equal(claude.parse(payload('Bash', { command: 'ls' }, { cwd: '/work/repo/sub' }), CTX).cwd, '/work/repo/sub');
  // A Bash call with no command string is opaque, never silently empty.
  assert.deepEqual(parse('Bash', {}).opaque, { reason: 'missing-command' });
});

test('Write and Edit map to write paths', () => {
  const write = parse('Write', { file_path: '/work/repo/src/a.txt' });
  assert.equal(write.kind, 'file');
  assert.deepEqual(write.paths, [{ path: '/work/repo/src/a.txt', access: 'write' }]);
  // Edit, MultiEdit and NotebookEdit read the file as well as write it, so a rule on reads
  // (credentials, `access: "read"`) also sees them.
  for (const tool of ['Edit', 'MultiEdit']) {
    const call = parse(tool, { file_path: '/work/repo/.env' });
    assert.equal(call.kind, 'file');
    assert.deepEqual(call.paths, [
      { path: '/work/repo/.env', access: 'read' },
      { path: '/work/repo/.env', access: 'write' },
    ]);
  }
  assert.deepEqual(parse('NotebookEdit', { notebook_path: '/work/repo/n.ipynb' }).paths, [
    { path: '/work/repo/n.ipynb', access: 'read' },
    { path: '/work/repo/n.ipynb', access: 'write' },
  ]);
  assert.deepEqual(parse('Edit', {}).paths, [
    { path: UNKNOWN, access: 'read' },
    { path: UNKNOWN, access: 'write' },
  ]);
  // A relative path resolves against the payload cwd, lexically.
  assert.deepEqual(parse('Write', { file_path: 'src/../out/./b.txt' }).paths, [
    { path: '/work/repo/out/b.txt', access: 'write' },
  ]);
  // A missing path field is an unknown path, never no path.
  assert.deepEqual(parse('Write', {}).paths, [{ path: UNKNOWN, access: 'write' }]);
  // `~/` is home-expanded and also kept literally (the host may treat it as a relative name).
  const tilde = parse('Write', { file_path: '~/.aws/credentials' }).paths;
  assert.deepEqual(tilde, [
    { path: '/home/tester/.aws/credentials', access: 'write' },
    { path: '/work/repo/~/.aws/credentials', access: 'write' },
  ]);
});

test('Read maps to a read path', () => {
  const call = parse('Read', { file_path: '/work/repo/README.md', offset: 1 });
  assert.equal(call.kind, 'file');
  assert.deepEqual(call.paths, [{ path: '/work/repo/README.md', access: 'read' }]);
});

test('Grep path is a read', () => {
  assert.deepEqual(parse('Grep', { pattern: 'x', path: '/work/repo/src' }).paths, [
    { path: '/work/repo/src', access: 'read' },
  ]);
  // No path: the search root is the cwd.
  assert.deepEqual(parse('Grep', { pattern: 'x' }).paths, [{ path: CWD, access: 'read' }]);
  assert.deepEqual(parse('Glob', { pattern: '**/*.mjs' }).paths, [{ path: CWD, access: 'read' }]);
  // An absolute Glob pattern searches its literal prefix too.
  assert.deepEqual(parse('Glob', { pattern: '/etc/ssh/*.conf', path: 'src' }).paths, [
    { path: '/work/repo/src', access: 'read' },
    { path: '/etc/ssh', access: 'read' },
  ]);
});

test('Glob and Grep prefixes resolve against the search path, including dotdot and tilde', () => {
  assert.deepEqual(parse('Glob', { pattern: '../../x/*' }).paths, [
    { path: CWD, access: 'read' },
    { path: '/x', access: 'read' },
  ]);
  assert.deepEqual(parse('Glob', { pattern: '../other/**/*.mjs', path: 'src' }).paths, [
    { path: '/work/repo/src', access: 'read' },
    { path: '/work/repo/other', access: 'read' },
  ]);
  assert.deepEqual(parse('Glob', { pattern: 'src/a.mjs' }).paths, [
    { path: CWD, access: 'read' },
    { path: '/work/repo/src/a.mjs', access: 'read' },
  ]);
  assert.deepEqual(parse('Grep', { pattern: 'x', glob: '../../etc/*.conf' }).paths, [
    { path: CWD, access: 'read' },
    { path: '/etc', access: 'read' },
  ]);
  assert.deepEqual(parse('Glob', { pattern: '~/.ssh/*' }).paths, [
    { path: CWD, access: 'read' },
    { path: '/home/tester/.ssh', access: 'read' },
    { path: '/work/repo/~/.ssh', access: 'read' },
  ]);
  // A dotdot after a wildcard could leave the prefix: unknown read.
  assert.ok(parse('Glob', { pattern: 'src/**/../../etc' }).paths.some((p) => p.path === UNKNOWN));
});

test('cwd is normalised lexically', () => {
  const call = claude.parse(payload('Grep', { pattern: 'x' }, { cwd: '/work/repo/./sub/../' }), CTX);
  assert.equal(call.cwd, '/work/repo');
  assert.deepEqual(call.paths, [{ path: '/work/repo', access: 'read' }]);
});

test('WebFetch yields a url', () => {
  const call = parse('WebFetch', { url: 'https://example.com/a?b=1', prompt: 'summarize' });
  assert.equal(call.kind, 'net');
  assert.equal(call.url, 'https://example.com/a?b=1');
  assert.deepEqual(call.paths, []);
  assert.equal(parse('WebFetch', {}).url, UNKNOWN);
  const search = parse('WebSearch', { query: 'node test runner' });
  assert.equal(search.kind, 'net');
  assert.equal(search.url, undefined);
});

test('mcp tool names are kept', () => {
  const call = parse('mcp__github__create_issue', { title: 't', command: 'echo ok' });
  assert.equal(call.kind, 'mcp');
  assert.equal(call.mcp, 'mcp__github__create_issue');
  assert.equal(call.tool, 'mcp__github__create_issue');
  assert.equal(call.opaque, undefined);
});

test('Artifact file_path is a read and egress', () => {
  const call = parse('Artifact', { file_path: '/work/repo/page.html', icon: 'chart' });
  assert.equal(call.kind, 'net');
  assert.equal(new URL(call.url).hostname, 'claude.ai');
  assert.deepEqual(call.paths, [{ path: '/work/repo/page.html', access: 'read' }]);

  const many = parse('Artifact', {
    file_paths: ['a.png', '/work/repo/b.png'],
    files: { 'css/site.css': 'styles/site.css', 'img.png': { from: 'img/x.png' }, gone: null, 'o.html': { artifact: 'u', path: 'p' } },
    root: 'site',
  });
  assert.deepEqual(
    many.paths.map((p) => p.path).sort(),
    ['/work/repo/a.png', '/work/repo/b.png', '/work/repo/site/img/x.png', '/work/repo/site/styles/site.css'],
  );
  assert.ok(many.paths.every((p) => p.access === 'read'));

  // `edits` rewrite file_path on disk; `out_dir` is written to.
  const edited = parse('Artifact', { action: 'read', file_path: 'p.html', edits: [{ old_str: 'a', new_str: 'b' }], out_dir: '/work/out' });
  assert.deepEqual(edited.paths, [
    { path: '/work/repo/p.html', access: 'read' },
    { path: '/work/repo/p.html', access: 'write' },
    { path: '/work/out', access: 'write' },
  ]);

  // A `~` root is read every way: home-expanded, literal, and UNKNOWN without a home.
  const tilde = parse('Artifact', { files: { 'a.css': 'a.css' }, root: '~/site' }).paths;
  assert.deepEqual(tilde, [
    { path: '/home/tester/site/a.css', access: 'read' },
    { path: '/work/repo/~/site/a.css', access: 'read' },
  ]);
  const noHome = claude.parse(payload('Artifact', { files: ['a.css'], root: '~/site' }), {}).paths;
  assert.deepEqual(noHome, [
    { path: UNKNOWN, access: 'read' },
    { path: '/work/repo/~/site/a.css', access: 'read' },
  ]);
  assert.deepEqual(parse('Artifact', { files: { x: 'a.css' }, root: 5 }).paths, [{ path: UNKNOWN, access: 'read' }]);

  // The sibling tools are egress too.
  assert.equal(new URL(parse('ArtifactComments', { url: 'u' }).url).hostname, 'claude.ai');
  assert.equal(new URL(parse('ArtifactData', { file_path: 'd.json' }).url).hostname, 'claude.ai');
});

test('Workflow scriptPath is a read and optional', () => {
  const call = parse('Workflow', { scriptPath: '/work/repo/flow.mjs' });
  assert.equal(call.kind, 'file');
  assert.deepEqual(call.paths, [{ path: '/work/repo/flow.mjs', access: 'read' }]);
  assert.equal(call.url, undefined);
  // An inline script or a named workflow reads no path.
  assert.deepEqual(parse('Workflow', { script: 'return 1' }).paths, []);
  assert.deepEqual(parse('Workflow', { name: 'release' }).paths, []);
  assert.equal(parse('Workflow', { name: 'release' }).opaque, undefined);
});

test('an unknown tool with a command field is opaque', () => {
  for (const field of OPAQUE_INPUT_FIELDS) {
    const call = parse('FutureShell', { [field]: 'echo ok' });
    assert.equal(call.kind, 'other', field);
    assert.equal(call.opaque.reason, 'unknown-tool-input', field);
  }
  assert.deepEqual([...OPAQUE_INPUT_FIELDS].sort(), ['chars', 'cmd', 'code', 'command', 'input', 'script', 'stdin']);
  // A non-string value is not a command.
  assert.equal(parse('FutureShell', { command: ['a'] }).opaque, undefined);
});

test('an unknown tool without one is other and undecided', () => {
  const call = parse('FutureTool', { title: 'x' });
  assert.equal(call.kind, 'other');
  assert.equal(call.opaque, undefined);
  assert.deepEqual(call.paths, []);
  assert.equal(call.url, undefined);
  assert.equal(call.mcp, undefined);
  // Known tools with no path field and no egress are other and undecided, even with a string
  // field the unknown-tool rule would treat as a command.
  for (const tool of ['Skill', 'ToolSearch', 'SendMessage', 'TaskStop', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'CronCreate', 'CronList', 'Agent', 'Task']) {
    const c = parse(tool, { input: 'x', prompt: 'p' });
    assert.equal(c.opaque, undefined, tool);
    assert.deepEqual(c.paths, [], tool);
    assert.equal(c.kind, tool === 'Agent' || tool === 'Task' ? 'agent' : 'other', tool);
  }
});

test('agent_id and permission_mode are carried', () => {
  const call = parse('Bash', { command: 'ls' }, { agent_id: 'agent-7', agent_type: 'Explore', permission_mode: 'acceptEdits' });
  assert.equal(call.agent_id, 'agent-7');
  assert.equal(call.agent_type, 'Explore');
  assert.equal(call.permission_mode, 'acceptEdits');
  assert.equal(call.turn_id, undefined);
  const main = parse('Bash', { command: 'ls' });
  assert.equal(main.agent_id, undefined);
  assert.equal(main.permission_mode, 'default');
  assert.equal(parse('Bash', { command: 'ls' }, { permission_mode: undefined }).permission_mode, 'unknown');
});

test('missing cwd yields an opaque call', () => {
  for (const cwd of [undefined, '', 'relative/dir', 42]) {
    const call = claude.parse(payload('Read', { file_path: '/work/repo/a' }, { cwd }), CTX);
    assertCanonicalCall(call);
    assert.deepEqual(call.opaque, { reason: 'missing-cwd' }, String(cwd));
  }
  // A payload that is not an object, or has no tool name, is opaque too.
  assert.equal(claude.parse(null, CTX).opaque.reason, 'malformed-payload');
  assert.equal(claude.parse({ cwd: CWD }, CTX).opaque.reason, 'malformed-payload');
  assert.equal(claude.parse(payload('Bash', 'ls'), CTX).opaque.reason, 'malformed-input');
});

test('the adapter interface and the tool table are well formed', () => {
  assert.equal(claude.name, 'claude');
  assert.ok(claude.events.includes('PreToolUse'));
  assert.equal(typeof claude.parse, 'function');
  assert.deepEqual([...CALL_KINDS].sort(), ['agent', 'file', 'mcp', 'net', 'other', 'shell']);
  for (const [name, entry] of Object.entries(KNOWN_TOOLS)) {
    assert.ok(CALL_KINDS.includes(entry.kind), name);
    for (const f of entry.paths ?? []) assert.ok(['read', 'write'].includes(f.access), name);
  }
  assert.equal(lookupTool('mcp__a__b').kind, 'mcp');
  assert.equal(lookupTool('ArtifactData').egress.domain, 'claude.ai');
  assert.equal(lookupTool('Nope'), null);
  assert.throws(() => assertCanonicalCall({ kind: 'weird' }));
});

// ---- Codex ----

// A captured-shape Codex PreToolUse payload.
function codexPayload(tool_name, tool_input, more = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-2',
    turn_id: 'turn-3',
    transcript_path: '/work/codex.jsonl',
    cwd: CWD,
    model: 'test-model',
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: 'call_01',
    ...more,
  };
}

function cparse(tool_name, tool_input, more) {
  const call = codex.parse(codexPayload(tool_name, tool_input, more), CTX);
  assertCanonicalCall(call);
  return call;
}

const envelope = (...body) => ['*** Begin Patch', ...body, '*** End Patch', ''].join('\n');

const FOUR = envelope(
  '*** Add File: src/a.txt',
  '+hello',
  '*** Update File: src/b.txt',
  '@@ def f():',
  '-old',
  '+new',
  ' ctx',
  '*** Delete File: src/c.txt',
  '*** Update File: src/d.txt',
  '*** Move to: src/e.txt',
  '@@',
  '-x',
  '+y',
  '*** End of File',
);

test('apply_patch Add Update Delete Move sections', () => {
  assert.deepEqual(parseApplyPatch(FOUR), [
    { path: 'src/a.txt', op: 'add' },
    { path: 'src/b.txt', op: 'update' },
    { path: 'src/c.txt', op: 'delete' },
    { path: 'src/e.txt', op: 'move', from: 'src/d.txt' },
  ]);
  const call = cparse('apply_patch', { command: FOUR });
  assert.equal(call.host, 'codex');
  assert.equal(call.tool, 'apply_patch');
  assert.equal(call.kind, 'file');
  assert.equal(call.opaque, undefined);
  assert.deepEqual(call.paths, [
    { path: '/work/repo/src/a.txt', access: 'write' },
    { path: '/work/repo/src/b.txt', access: 'read' },
    { path: '/work/repo/src/b.txt', access: 'write' },
    { path: '/work/repo/src/c.txt', access: 'write' },
    { path: '/work/repo/src/d.txt', access: 'read' },
    { path: '/work/repo/src/d.txt', access: 'write' },
    { path: '/work/repo/src/e.txt', access: 'write' },
  ]);
  // Absolute and dotdot paths are normalised lexically; CRLF line ends and blank edges are accepted.
  assert.deepEqual(cparse('apply_patch', { command: '\r\n*** Begin Patch\r\n*** Add File: /tmp/x/../y.txt\r\n+z\r\n*** End Patch\r\n' }).paths, [
    { path: '/tmp/y.txt', access: 'write' },
  ]);
});

test('a Move writes the source and the destination', () => {
  const text = envelope('*** Update File: src/old.txt', '*** Move to: lib/new.txt');
  assert.deepEqual(parseApplyPatch(text), [{ path: 'lib/new.txt', op: 'move', from: 'src/old.txt' }]);
  const paths = cparse('apply_patch', { command: text }).paths;
  assert.ok(paths.some((p) => p.path === '/work/repo/src/old.txt' && p.access === 'write'));
  assert.ok(paths.some((p) => p.path === '/work/repo/lib/new.txt' && p.access === 'write'));
});

test('a malformed envelope is opaque', () => {
  const bad = [
    '*** Add File: src/a.txt\n+x\n*** End Patch',
    '*** Begin Patch\n*** Add File: src/a.txt\n+x\n',
    envelope(),
    envelope('*** Add File: '),
    envelope('*** Add File: src/a.txt', 'no plus'),
    envelope('*** Delete File: src/a.txt', '+x'),
    envelope('*** Update File: src/a.txt'),
    envelope('*** Rename File: src/a.txt'),
    envelope('+orphan line'),
    envelope('*** Update File: src/a.txt', '@@', '+x', '*** Move to: src/b.txt'),
    envelope('*** Add File: src/a.txt', '+x', '*** End Patch', '*** Add File: src/b.txt', '+y'),
    'not a patch',
    '',
    42,
  ];
  for (const text of bad) {
    assert.equal(parseApplyPatch(text), null, JSON.stringify(text));
    const call = cparse('apply_patch', { command: text });
    assert.deepEqual(call.opaque, { reason: 'malformed-patch' }, JSON.stringify(text));
  }
  assert.deepEqual(cparse('apply_patch', {}).opaque, { reason: 'malformed-patch' });
});

test('shell command as an argv array', () => {
  const call = cparse('shell', { command: ['bash', '-lc', 'ls -la'] });
  assert.equal(call.kind, 'shell');
  assert.equal(call.command, "bash -lc 'ls -la'");
  assert.equal(call.cwd, CWD);
  assert.deepEqual(call.paths, []);
  assert.equal(call.opaque, undefined);
  assert.equal(cparse('shell', { command: ['git', 'status'] }).command, 'git status');
  assert.equal(cparse('shell', { command: ['echo', "it's ok", ''] }).command, "echo 'it'\\''s ok' ''");
  assert.equal(cparse('shell', { command: 'npm test' }).command, 'npm test');
  assert.equal(cparse('exec_command', { cmd: 'echo ok' }).command, 'echo ok');
  assert.equal(cparse('exec_command', { command: ['touch', './marker'] }).command, 'touch ./marker');
  for (const command of [[], [1], ['ls', null], undefined, 7]) {
    assert.equal(cparse('shell', { command }).opaque?.reason, 'malformed-command', JSON.stringify(command));
  }
});

test('workdir becomes the effective cwd', () => {
  assert.equal(cparse('shell', { command: 'ls', workdir: 'sub' }).cwd, '/work/repo/sub');
  assert.equal(cparse('shell', { command: 'ls', workdir: '/work/other/./x/..' }).cwd, '/work/other');
  assert.equal(cparse('exec_command', { cmd: 'ls', workdir: '../up' }).cwd, '/work/up');
  assert.equal(cparse('shell', { command: 'ls', workdir: null }).cwd, CWD);
  for (const workdir of [5, '', '~/x', 'a\u0000b']) {
    assert.equal(cparse('shell', { command: 'ls', workdir }).opaque?.reason, 'malformed-workdir', JSON.stringify(workdir));
  }
  // apply_patch has no workdir of its own: its paths resolve against the payload cwd.
  assert.deepEqual(cparse('apply_patch', { command: envelope('*** Delete File: a.txt'), workdir: 'sub' }).paths, [
    { path: '/work/repo/a.txt', access: 'write' },
  ]);
});

test('the apply_patch heredoc inside bash -lc yields patch writes', () => {
  const heredoc = `apply_patch <<'EOF'\n${envelope('*** Add File: src/a.txt', '+hi')}EOF\n`;
  const call = cparse('shell', { command: ['bash', '-lc', heredoc], workdir: 'pkg' });
  assert.equal(call.kind, 'shell');
  assert.equal(call.cwd, '/work/repo/pkg');
  assert.ok(call.command.startsWith('bash -lc '));
  assert.equal(call.opaque, undefined);
  assert.deepEqual(call.paths, [{ path: '/work/repo/pkg/src/a.txt', access: 'write' }]);
  // `cd <dir> &&` before the heredoc moves the patch base.
  const cd = `cd ./sub && apply_patch <<"PATCH"\n${envelope('*** Update File: b.txt', '@@', '-a', '+b')}PATCH`;
  assert.deepEqual(cparse('exec_command', { cmd: cd }).paths, [
    { path: '/work/repo/sub/b.txt', access: 'read' },
    { path: '/work/repo/sub/b.txt', access: 'write' },
  ]);
  // argv form apply_patch <envelope>.
  assert.deepEqual(cparse('shell', { command: ['apply_patch', envelope('*** Add File: c.txt', '+c')] }).paths, [
    { path: '/work/repo/c.txt', access: 'write' },
  ]);
  // A heredoc whose envelope does not parse, an unquoted delimiter with expansions, or an
  // apply_patch the adapter cannot read is opaque.
  const broken = `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: x\nbad\n*** End Patch\nEOF`;
  assert.equal(cparse('shell', { command: ['bash', '-lc', broken] }).opaque?.reason, 'malformed-patch');
  const expanding = `apply_patch <<EOF\n${envelope('*** Add File: $DIR/a.txt', '+x')}EOF`;
  assert.equal(cparse('shell', { command: expanding }).opaque?.reason, 'unparsed-apply-patch');
});

// Fix round 1 rulings.
const plainShell = (call) => {
  assert.equal(call.kind, 'shell');
  assert.equal(call.opaque, undefined);
  assert.deepEqual(call.paths, []);
};

test('a shell call that only mentions apply_patch is a plain shell call', () => {
  for (const command of [
    ['git', 'commit', '-m', 'fix apply_patch parsing'],
    ['bash', '-lc', 'grep -rn apply_patch .'],
    'cat docs/apply_patch.md',
    ['bash', '-lc', 'echo apply_patch'],
    'apply_patch "$(cat p.diff)"',
    `echo ok; apply_patch <<'EOF'\n${envelope('*** Add File: a', '+x')}EOF`,
    `a\\pply_patch <<'EOF'\n${envelope('*** Add File: a', '+x')}EOF`,
    ['apply_patch', envelope('*** Add File: a', '+x'), 'extra'],
  ]) {
    const call = cparse('shell', { command });
    plainShell(call);
    assert.equal(typeof call.command, 'string');
  }
});

test('the cd operand before the heredoc must be a plain ./, ../ or / path', () => {
  const body = `apply_patch <<'EOF'\n${envelope('*** Add File: a.txt', '+x')}EOF`;
  assert.deepEqual(cparse('shell', { command: `cd /work/other && ${body}` }).paths, [{ path: '/work/other/a.txt', access: 'write' }]);
  assert.deepEqual(cparse('shell', { command: `cd ../up && ${body}` }).paths, [{ path: '/work/up/a.txt', access: 'write' }]);
  for (const cd of ['cd -', 'cd -P', 'cd ;cd', 'cd /e*c', 'cd /e?c', 'cd /e[t]c', 'cd {/etc,}', 'cd sub', "cd './sub'", 'cd ./$D', 'cd ./a`b`', 'cd ./a\\b', 'cd ~/x', 'cd x;cd /etc', 'cd', 'cd ./a b']) {
    assert.equal(cparse('shell', { command: `${cd} && ${body}` }).opaque?.reason, 'unparsed-apply-patch', cd);
  }
});

test('a heredoc terminator is at column 0, or after tabs only with <<-', () => {
  const env = envelope('*** Add File: a.txt', '+x');
  plainShell(cparse('shell', { command: `apply_patch <<'EOF'\n${env}  EOF` }));
  plainShell(cparse('shell', { command: `apply_patch <<'EOF'\n${env}\tEOF` }));
  plainShell(cparse('shell', { command: `apply_patch <<-'EOF'\n${env}  EOF` }));
  assert.deepEqual(cparse('shell', { command: `apply_patch <<-'EOF'\n${env}\t\tEOF` }).paths, [{ path: '/work/repo/a.txt', access: 'write' }]);
  // <<- strips leading tabs from the body lines too.
  const tabbed = `apply_patch <<-'EOF'\n${env.split('\n').map((l) => (l ? `\t${l}` : l)).join('\n')}\tEOF`;
  assert.deepEqual(cparse('shell', { command: tabbed }).paths, [{ path: '/work/repo/a.txt', access: 'write' }]);
});

test('a shell argv with options before -c is read', () => {
  const heredoc = `apply_patch <<'EOF'\n${envelope('*** Add File: a.txt', '+x')}EOF`;
  const want = [{ path: '/work/repo/a.txt', access: 'write' }];
  for (const pre of [['-o', 'pipefail'], ['+o', 'histexpand'], ['-e'], ['-u'], ['-x'], ['-l'], ['-e', '-o', 'pipefail', '-u']]) {
    assert.deepEqual(cparse('shell', { command: ['bash', ...pre, '-c', heredoc] }).paths, want, pre.join(' '));
    assert.deepEqual(cparse('shell', { command: ['/bin/sh', ...pre, '-lc', heredoc] }).paths, want, pre.join(' '));
  }
  // Another option, a missing -o name or trailing arguments: not this form, a plain shell call.
  plainShell(cparse('shell', { command: ['bash', '-i', '-c', heredoc] }));
  plainShell(cparse('shell', { command: ['bash', '-o', '-c', heredoc] }));
  plainShell(cparse('shell', { command: ['bash', '-c', heredoc, 'arg0'] }));
});

test('write_stdin is opaque', () => {
  const call = cparse('write_stdin', { session_id: 4, chars: 'y\n' });
  assert.deepEqual(call.opaque, { reason: 'write-stdin' });
  assert.equal(cparse('write_stdin', {}).opaque.reason, 'write-stdin');
});

test('turn_id is carried', () => {
  const call = cparse('shell', { command: 'ls' }, { permission_mode: 'on-request' });
  assert.equal(call.turn_id, 'turn-3');
  assert.equal(call.session_id, 'sess-2');
  assert.equal(call.tool_use_id, 'call_01');
  assert.equal(call.permission_mode, 'on-request');
  assert.equal(call.event, 'PreToolUse');
  assert.equal(cparse('shell', { command: 'ls' }, { turn_id: undefined }).turn_id, undefined);
  assert.equal(cparse('shell', { command: 'ls' }, { permission_mode: undefined }).permission_mode, 'unknown');
});

test('the same file edit gives the same canonical paths on both hosts', () => {
  const update = cparse('apply_patch', { command: envelope('*** Update File: src/a.txt', '@@', '-a', '+b') }).paths;
  assert.deepEqual(update, parse('Edit', { file_path: '/work/repo/src/a.txt' }).paths);
  assert.deepEqual(update, parse('Edit', { file_path: 'src/a.txt' }).paths);
  const add = cparse('apply_patch', { command: envelope('*** Add File: src/a.txt', '+b') }).paths;
  assert.deepEqual(add, parse('Write', { file_path: '/work/repo/src/a.txt' }).paths);
  // `~/` reads the same way on both hosts.
  const tilde = cparse('apply_patch', { command: envelope('*** Add File: ~/.aws/credentials', '+b') }).paths;
  assert.deepEqual(tilde, parse('Write', { file_path: '~/.aws/credentials' }).paths);
});

test('codex view_image, mcp, web_search and unknown tools', () => {
  assert.deepEqual(cparse('view_image', { path: 'shot.png' }).paths, [{ path: '/work/repo/shot.png', access: 'read' }]);
  assert.deepEqual(cparse('view_image', {}).paths, [{ path: UNKNOWN, access: 'read' }]);
  const mcp = cparse('mcp__github__create_issue', { title: 't' });
  assert.equal(mcp.kind, 'mcp');
  assert.equal(mcp.mcp, 'mcp__github__create_issue');
  assert.equal(cparse('web_search', { query: 'q' }).kind, 'net');
  assert.equal(cparse('update_plan', { plan: [] }).kind, 'other');
  assert.equal(cparse('update_plan', { input: 'x' }).opaque, undefined);
  assert.equal(cparse('future_tool', { cmd: 'echo ok' }).opaque.reason, 'unknown-tool-input');
  assert.equal(cparse('future_tool', { title: 'x' }).opaque, undefined);
  assert.equal(codex.parse(codexPayload('shell', { command: 'ls' }, { cwd: 'rel' }), CTX).opaque.reason, 'missing-cwd');
  assert.equal(codex.parse(null, CTX).opaque.reason, 'malformed-payload');
  assert.equal(codex.name, 'codex');
  assert.ok(codex.events.includes('PreToolUse'));
});

// ---- the adapter contract suite ----

const claudeFixtures = {
  ctx: CTX,
  payloads: [
    { name: 'bash', payload: payload('Bash', { command: 'ls' }), expect: { kind: 'shell', command: 'ls', cwd: CWD } },
    { name: 'write', payload: payload('Write', { file_path: '/work/repo/a.txt' }), expect: { kind: 'file', paths: [{ path: '/work/repo/a.txt', access: 'write' }] } },
    { name: 'webfetch', payload: payload('WebFetch', { url: 'https://example.com/' }), expect: { kind: 'net', url: 'https://example.com/' } },
    { name: 'mcp', payload: payload('mcp__github__create_issue', { title: 't' }), expect: { kind: 'mcp', mcp: 'mcp__github__create_issue' } },
    { name: 'unknown tool with a command', payload: payload('FutureShell', { command: 'echo ok' }), expect: { kind: 'other', opaque: { reason: 'unknown-tool-input' } } },
    { name: 'unknown tool without one', payload: payload('FutureTool', { title: 'x' }), expect: { kind: 'other', paths: [] } },
    { name: 'no cwd', payload: payload('Read', { file_path: '/work/repo/a' }, { cwd: undefined }), expect: { opaque: { reason: 'missing-cwd' } } },
  ],
};

const codexFixtures = {
  ctx: CTX,
  payloads: [
    { name: 'shell argv', payload: codexPayload('shell', { command: ['bash', '-lc', 'ls -la'] }), expect: { kind: 'shell', command: "bash -lc 'ls -la'" } },
    { name: 'exec_command', payload: codexPayload('exec_command', { cmd: 'echo ok' }), expect: { kind: 'shell', command: 'echo ok' } },
    { name: 'apply_patch', payload: codexPayload('apply_patch', { command: envelope('*** Add File: src/a.txt', '+hello') }), expect: { kind: 'file', paths: [{ path: '/work/repo/src/a.txt', access: 'write' }] } },
    { name: 'broken patch', payload: codexPayload('apply_patch', { command: 'nope' }), expect: { opaque: { reason: 'malformed-patch' } } },
    { name: 'mcp', payload: codexPayload('mcp__github__create_issue', { title: 't' }), expect: { kind: 'mcp' } },
    { name: 'write_stdin is opaque', payload: codexPayload('write_stdin', { chars: 'ls\n' }), expect: { opaque: { reason: 'write-stdin' } } },
  ],
};

test('the contract suite passes for claude, codex and the fake adapter', () => {
  assert.ok(runAdapterContract(claude, claudeFixtures) > 20);
  assert.ok(runAdapterContract(codex, codexFixtures) > 20);
  assert.ok(runAdapterContract(fake, fake.fixtures) > 10);
});

test('the contract suite rejects adapters that break it', () => {
  const bad = (patch, why, fixtures = fake.fixtures) => assert.throws(() => runAdapterContract({ ...fake, ...patch }, fixtures), why);
  bad({ name: '' }, /: name:/);
  bad({ events: [] }, /: events:/);
  bad({ parse: 'not a function' }, /: parse:/);
  // Throws on hostile input.
  bad({ parse: (p, c) => (p === null ? (() => { throw new Error('boom'); })() : fake.parse(p, c)) }, /must not throw.*boom/);
  // Wrong host name on the call.
  bad({ parse: (p, c) => ({ ...fake.parse(p, c), host: 'other' }) }, /host is the adapter name/);
  // Not canonical: a bad kind.
  bad({ parse: (p, c) => ({ ...fake.parse(p, c), kind: 'weird' }) }, /not a canonical call: kind "weird"/);
  // Mutates its input (the contract hands it a frozen copy).
  bad({ parse: (p, c) => { if (p !== null && typeof p === 'object') p.touched = true; return fake.parse(p, c); } }, /must not throw, and must not write to its payload.*(read only|not extensible)/);
  // Not deterministic.
  let n = 0;
  bad({ parse: (p, c) => ({ ...fake.parse(p, c), tool_use_id: `id-${n++}` }) }, /parses the same way twice/);
  // Hostile input must be opaque, not an empty call.
  bad({ parse: (p, c) => (p === null ? fake.parse({ tool: 'x', cwd: '/w' }, c) : fake.parse(p, c)) }, /is opaque/);
  // An expectation the adapter does not meet.
  bad({}, /expects kind/, { ...fake.fixtures, payloads: [{ ...fake.fixtures.payloads[0], expect: { kind: 'net' } }] });
  // A contract with no fixtures checks nothing and says so.
  assert.throws(() => runAdapterContract(fake, { payloads: [] }), /needs fixture payloads/);
});

test('a fake adapter with a new tool kind needs no change in evaluate', () => {
  // Teleport is a tool no real adapter knows. The fake adapter turns it into the same canonical
  // call every adapter produces, and evaluate judges it by path with the rules as they are.
  const pol = validatePolicy({
    version: 1,
    profiles: { default: { undecided: 'host' }, unattended: { undecided: 'deny' } },
    rules: [{ id: 'no-secret-dest', decision: 'deny', match: { paths: ['/work/repo/secret/**'], access: 'write' }, why: 'secret is off limits' }],
  });
  const opts = { profile: 'default', grants: [], ctx: { home: '/home/tester', platform: 'linux', caseInsensitive: false, realpath: () => { throw new Error('ENOENT'); } } };
  const call = (dest) => fake.parse({ event: FAKE_EVENT, tool: 'Teleport', cwd: CWD, input: { dest }, id: 't1', session: 's1' }, CTX);

  const blocked = call('/work/repo/secret/key.txt');
  assertCanonicalCall(blocked);
  assert.equal(blocked.host, 'fake');
  assert.equal(blocked.kind, 'file');
  const verdict = evaluate(pol, blocked, null, opts);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.rule, 'no-secret-dest');

  const fine = evaluate(pol, call('/work/repo/ok.txt'), null, opts);
  assert.equal(fine.decision, 'undecided');
  assert.equal(evaluate(pol, call('/work/repo/ok.txt'), null, { ...opts, profile: 'unattended' }).decision, 'deny');

  // A fake tool of another kind (a fetch) is judged on its url by the same evaluator.
  const net = fake.parse({ event: FAKE_EVENT, tool: 'Beam', cwd: CWD, input: { url: 'https://example.com/x' }, id: 't2', session: 's1' }, CTX);
  assert.equal(net.kind, 'net');
  assert.equal(typeof evaluate(pol, net, null, opts).decision, 'string');
});
