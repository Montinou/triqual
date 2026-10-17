// The Claude known-tool table. It is data, versioned with the adapter: for every tool its kind,
// the input fields that name paths (with access), and whether it sends data off the machine.
//
// entry = {
//   kind,                       one of types.mjs CALL_KINDS
//   command?: true,             the call is a shell call; `tool_input.command` is the command
//   paths?: [{field, access, shape?, required?, cwdDefault?, alsoWriteWhen?, base?, globPrefix?}]
//       shape          "string" (default) | "list" (array of strings) | "sources" (a `files` value:
//                      an array of strings or {path}, or a map whose values are strings or {from})
//       required       an absent field is an UNKNOWN path
//       cwdDefault     an absent field means the working directory
//       alsoWriteWhen  also a write when this other input field is a non-empty array
//       base           "root": relative values resolve against the resolved `tool_input.root`
//       globPrefix     a glob pattern: also reads its literal prefix directory, resolved against `path`
//   egress?: {domain} | {urlField} | {}
//       domain         every call is egress to this domain (the call carries https://<domain>/)
//       urlField       the call fetches the URL in this input field
//       (none)         data leaves the machine but no domain is known (WebSearch)
// }
//
// Tools with no path field and no egress are kind "other": they are undecided unless the
// unknown-tool rule below applies, and it does not apply to a table entry.

export const OPAQUE_INPUT_FIELDS = Object.freeze(['command', 'cmd', 'script', 'code', 'input', 'chars', 'stdin']);

const file = (field, access, more = {}) => ({ field, access, ...more });

const ARTIFACT = {
  kind: 'net',
  egress: { domain: 'claude.ai' },
  paths: [
    file('file_path', 'read', { alsoWriteWhen: 'edits' }),
    file('file_paths', 'read', { shape: 'list' }),
    file('files', 'read', { shape: 'sources', base: 'root' }),
    file('out_dir', 'write'),
  ],
};

export const KNOWN_TOOLS = Object.freeze({
  Bash: { kind: 'shell', command: true },
  Monitor: { kind: 'shell', command: true },
  Read: { kind: 'file', paths: [file('file_path', 'read', { required: true })] },
  Write: { kind: 'file', paths: [file('file_path', 'write', { required: true })] },
  Edit: { kind: 'file', paths: [file('file_path', 'read', { required: true }), file('file_path', 'write', { required: true })] },
  MultiEdit: { kind: 'file', paths: [file('file_path', 'read', { required: true }), file('file_path', 'write', { required: true })] },
  NotebookEdit: { kind: 'file', paths: [file('notebook_path', 'read', { required: true }), file('notebook_path', 'write', { required: true })] },
  Glob: { kind: 'file', paths: [file('path', 'read', { cwdDefault: true }), file('pattern', 'read', { globPrefix: true })] },
  Grep: { kind: 'file', paths: [file('path', 'read', { cwdDefault: true }), file('glob', 'read', { globPrefix: true })] },
  WebFetch: { kind: 'net', egress: { urlField: 'url' } },
  WebSearch: { kind: 'net', egress: {} },
  Agent: { kind: 'agent' },
  Task: { kind: 'agent' },
  Artifact: ARTIFACT,
  ArtifactData: ARTIFACT,
  ArtifactComments: ARTIFACT,
  // `scriptPath` is optional: an inline `script` or a named workflow reads no path.
  Workflow: { kind: 'file', paths: [file('scriptPath', 'read')] },
  // No path field and no egress: other, undecided.
  Skill: { kind: 'other' },
  ToolSearch: { kind: 'other' },
  SendMessage: { kind: 'other' },
  TaskStop: { kind: 'other' },
  AskUserQuestion: { kind: 'other' },
  EnterPlanMode: { kind: 'other' },
  ExitPlanMode: { kind: 'other' },
  TodoWrite: { kind: 'other' },
  CronCreate: { kind: 'other' },
  CronDelete: { kind: 'other' },
  CronList: { kind: 'other' },
  PushNotification: { kind: 'other' },
});

const MCP = Object.freeze({ kind: 'mcp' });

// The table entry for a tool name, or null for an unknown tool.
export function lookupTool(name) {
  if (typeof name !== 'string') return null;
  if (name.startsWith('mcp__')) return MCP;
  return Object.hasOwn(KNOWN_TOOLS, name) ? KNOWN_TOOLS[name] : null;
}
