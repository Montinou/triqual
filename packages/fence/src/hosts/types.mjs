// Shared shapes of the host adapters (engine side; may import other fence modules).
//
// Adapter       {name, events: string[], parse(payload, ctx): CanonicalCall}
//   name        the host name, "claude" or "codex"
//   events      the hook events whose payloads `parse` reads
//   ctx         {home?: string}; `home` expands a leading `~/` in a path field
//
// CanonicalCall {host, event, tool, kind, cwd, session_id, turn_id?, agent_id?, agent_type?,
//                permission_mode, tool_use_id, command?, paths, mcp?, url?, opaque?}
//   kind        "shell" | "file" | "net" | "mcp" | "agent" | "other"
//   cwd         the effective working directory: absolute, or "" when the payload had none
//   paths       [{path, access: "read" | "write"}]; `path` is absolute and lexically normalised,
//               or UNKNOWN when the payload value could not be turned into one
//   mcp         the full MCP tool name
//   url         a fetched or egress URL (UNKNOWN when the payload value is not a string)
//   opaque      {reason}: the call cannot be judged and must be denied by the evaluator
//
// A call the adapter cannot read is `opaque` or carries an UNKNOWN path, so the evaluator fails
// closed on it. A call can still be empty by design: an unknown tool without a command-like
// field (kind "other", no paths) is undecided, and the profile decides it.

import { isUnknown } from '../norm/unknown.mjs';

export const CALL_KINDS = Object.freeze(['shell', 'file', 'net', 'mcp', 'agent', 'other']);
export const ACCESSES = Object.freeze(['read', 'write']);

const REQUIRED_STRINGS = ['host', 'event', 'tool', 'cwd', 'session_id', 'permission_mode', 'tool_use_id'];
const OPTIONAL_STRINGS = ['turn_id', 'agent_id', 'agent_type', 'command', 'mcp'];

// Throws a TypeError naming the first way `call` is not a canonical call. Used by the shared
// adapter contract suite, not on the hot path.
export function assertCanonicalCall(call) {
  const fail = (why) => {
    throw new TypeError(`not a canonical call: ${why}`);
  };
  if (call === null || typeof call !== 'object') fail('not an object');
  if (!CALL_KINDS.includes(call.kind)) fail(`kind ${JSON.stringify(call.kind)}`);
  for (const k of REQUIRED_STRINGS) if (typeof call[k] !== 'string') fail(`${k} is not a string`);
  for (const k of OPTIONAL_STRINGS) if (call[k] !== undefined && typeof call[k] !== 'string') fail(`${k} is not a string`);
  if (call.url !== undefined && typeof call.url !== 'string' && !isUnknown(call.url)) fail('url');
  if (!Array.isArray(call.paths)) fail('paths is not an array');
  for (const p of call.paths) {
    if (p === null || typeof p !== 'object') fail('a path entry is not an object');
    if (typeof p.path !== 'string' && !isUnknown(p.path)) fail('a path is neither a string nor UNKNOWN');
    if (!ACCESSES.includes(p.access)) fail(`access ${JSON.stringify(p.access)}`);
  }
  if (call.opaque !== undefined && (call.opaque === null || typeof call.opaque.reason !== 'string')) fail('opaque.reason');
  return call;
}

// Drops keys whose value is undefined, so a call carries only what the payload gave.
export function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
