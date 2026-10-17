import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claude } from '../src/hosts/claude.mjs';
import { KNOWN_TOOLS, OPAQUE_INPUT_FIELDS, lookupTool } from '../src/hosts/tools.mjs';
import { CALL_KINDS, assertCanonicalCall } from '../src/hosts/types.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

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
