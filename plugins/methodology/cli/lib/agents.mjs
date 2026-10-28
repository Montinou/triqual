// Role-agent generator (spec Addendum F.7): Codex agent files (`~/.codex/agents/<name>.toml`) built from the roles
// plugin's `agents/*.md`, and the roles install's sha, which tells a sync when to regenerate them. Grok gets no agents:
// its model cannot select a named agent (F.11 P6d). Pure apart from `rolesSha` (reads the directory it is given).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.mjs';

// The first line of every file we generate; a file without it (or the legacy mark) is not ours.
export const GENERATED_MARK = BRAND.generatedMark;

// Whether `text` is a file we generated: it starts with the generated mark, the new one or the legacy one.
export const isGenerated = (text) => text.startsWith(GENERATED_MARK) || text.startsWith(BRAND.legacy.generatedMark);

// F.11 P5d: Codex accepts `model_reasoning_effort = "xhigh"`. `sandbox_mode = "read-only"` is not emitted: P5d ran it
// only under a bypassPermissions parent, where it restricted nothing, and under an enforcing Codex it could break the
// reviewers' checks (a worktree, a temp-HOME test run). The disallowed-tools sentence in every body is the restriction.
export const CODEX_XHIGH = true;
export const CODEX_READONLY_REVIEWERS = false;

// Codex installation policy, independent of Claude's `model` and `effort` frontmatter: Luna for the read-and-list
// roles (hunters, briefs, the safety gate); Terra 6.1 for every role that writes code or judges it, at low effort for the
// implementer and the fixer (who work from a brief) and high for the spec gate and the complex implementer; Astra, at low effort, is
// reserved for the single whole-branch adversarial review. The phase orchestrator, which dispatches the other roles and
// judges nothing itself, runs on Terra 6.1 at medium effort.
const CODEX_ROLE_ROUTING = Object.freeze({
  'brief-writer': { model: 'gpt-6-luna', effort: 'medium' },
  'safety-reviewer': { model: 'gpt-6-luna', effort: 'medium' },
  hunter: { model: 'gpt-6-luna', effort: 'medium' },
  'tdd-implementer': { model: 'gpt-6.1-terra', effort: 'low' },
  'review-fixer': { model: 'gpt-6.1-terra', effort: 'low' },
  'spec-reviewer': { model: 'gpt-6.1-terra', effort: 'high' },
  'complex-implementer': { model: 'gpt-6.1-terra', effort: 'high' },
  'final-adversarial-reviewer': { model: 'gpt-6-astra', effort: 'low' },
  'phase-orchestrator': { model: 'gpt-6.1-terra', effort: 'medium' },
});

// The Codex model of a shipped role (`hunter` -> `gpt-6-luna`), or null for a role with no routing entry.
export const codexRoleModel = (name) => (Object.hasOwn(CODEX_ROLE_ROUTING, name) ? CODEX_ROLE_ROUTING[name].model : null);

// Claude tool names → the Codex tools that do the same; `null` is a Claude-only tool with no Codex equivalent, left out
// of the Codex list. Any other name passes through unchanged. `apply_patch` both edits and creates files, so it is
// forbidden outright only when both Edit and Write are; one of them alone forbids that use of it (see codexTools).
export const CODEX_TOOL_NAMES = { Edit: 'apply_patch', Write: 'apply_patch', Agent: 'spawn_agent', NotebookEdit: null };

// One pair of matching quotes around a whole scalar. Grok's YAML loader skips an unquoted
// description that contains ": ", so the shipped roles quote that field. Codex must still
// receive the plain text.
function unwrapScalar(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

// A role file: `---` frontmatter of `key: value` lines, then the body.
export function parseRole(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (kv) fields[kv[1]] = unwrapScalar(kv[2]);
  }
  if (!fields.name) throw new Error('role file has no name in its frontmatter');
  if (!fields.description) throw new Error(`role ${fields.name} has no description in its frontmatter`);
  const disallowedTools = (fields.disallowedTools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  return {
    name: fields.name,
    description: fields.description,
    effort: fields.effort || undefined,
    disallowedTools,
    body: (m?.[2] ?? '').trim(),
  };
}

// A one-line TOML basic string. Only `\\ \" \n \t \uXXXX` are emitted: never `"""`, whose line-ending backslash
// would rewrite a body holding `\`.
export function tomlString(s) {
  let out = '"';
  for (const c of String(s)) {
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (/[\u0000-\u001f\u007f]/.test(c)) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return `${out}"`;
}

const codexTools = (tools) => {
  const edit = tools.includes('Edit');
  const write = tools.includes('Write');
  const patch = edit && write ? 'apply_patch' : edit ? 'apply_patch on existing files' : 'apply_patch to create files';
  const named = tools.map((tool) => {
    if (tool === 'Edit' || tool === 'Write') return patch;
    return Object.hasOwn(CODEX_TOOL_NAMES, tool) ? CODEX_TOOL_NAMES[tool] : tool;
  });
  return [...new Set(named.filter((tool) => tool !== null))];
};

// Shipped roles pin Codex's model and effort. Additional roles retain the existing
// behavior (session model and frontmatter effort).
export function codexAgentToml(role, { rolesVersion, xhigh, readOnly }) {
  if (typeof rolesVersion !== 'string' || !rolesVersion) throw new Error('codexAgentToml needs a non-empty rolesVersion');
  // Control characters are stripped so the version cannot end the `#` comment line and inject a key.
  const version = rolesVersion.replace(/[\u0000-\u001f\u007f]/g, '');
  const tools = codexTools(role.disallowedTools);
  const instructions = tools.length ? `${role.body}\n\nTools you must not use: ${tools.join(', ')}.` : role.body;
  const routing = Object.hasOwn(CODEX_ROLE_ROUTING, role.name) ? CODEX_ROLE_ROUTING[role.name] : undefined;
  const requestedEffort = routing?.effort ?? role.effort;
  const effort = requestedEffort === 'xhigh' && !xhigh ? 'high' : requestedEffort;
  const lines = [
    `${GENERATED_MARK}${version}`,
    `name = ${tomlString(role.name)}`,
    `description = ${tomlString(role.description)}`,
  ];
  if (routing) lines.push(`model = ${tomlString(routing.model)}`);
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  if (readOnly && role.disallowedTools.includes('Edit') && role.disallowedTools.includes('Write')) {
    lines.push(`sandbox_mode = ${tomlString('read-only')}`);
  }
  lines.push(`developer_instructions = ${tomlString(instructions)}`);
  return `${lines.join('\n')}\n`;
}

// sha256 over the sorted `name\0content\0` of the `*.md` files in `agentsDir` (names and contents only, so an mtime
// change does not move it).
export function rolesSha(agentsDir) {
  const hash = createHash('sha256');
  const names = readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(join(agentsDir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
