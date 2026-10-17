// The Claude adapter: a PreToolUse (or PostToolUse) payload -> a canonical call.
//
// Effective cwd: the payload `cwd`. The cwd probe (test/acceptance/cwd-probe/RESULT.md, "follows:
// yes") showed that the payload cwd of a Bash call is the directory the shell really runs that
// call in, so relative paths are resolved against it and are not UNKNOWN. Resolution is lexical
// (no file system access); symlinks are the evaluator's business.

import nodePath from 'node:path';

import { UNKNOWN } from '../norm/unknown.mjs';
import { OPAQUE_INPUT_FIELDS, lookupTool } from './tools.mjs';
import { compact } from './types.mjs';

const isAbsolute = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\u0000');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);

// A path value -> the entries it stands for: absolute and lexically normalised, UNKNOWN when it
// is not a usable string. `~` or `~/...` is expanded against ctx.home and also kept as the
// literal relative name, because the host may treat either reading as the real one.
function resolveValue(value, base, ctx) {
  if (typeof value !== 'string' || value === '' || value.includes('\u0000') || !isAbsolute(base)) return [UNKNOWN];
  const out = [];
  if (value === '~' || value.startsWith('~/')) {
    out.push(isAbsolute(ctx?.home) ? nodePath.posix.resolve(ctx.home, value.slice(2)) : UNKNOWN);
  }
  out.push(nodePath.posix.resolve(base, value));
  return out;
}

// The literal prefix directory of a glob pattern (absolute or relative), or null when the
// pattern has none (it starts with a wildcard: the search root covers it). `unsafe` is true
// when a `..` segment follows the first wildcard, which could leave the prefix.
function patternPrefix(pattern) {
  if (typeof pattern !== 'string') return { prefix: null, unsafe: true };
  const meta = pattern.search(/[*?[{]/);
  if (meta < 0) return { prefix: pattern === '' ? null : pattern, unsafe: false };
  const head = pattern.slice(0, meta);
  const unsafe = pattern.slice(meta).split('/').includes('..');
  if (head === '') return { prefix: null, unsafe };
  return { prefix: head.endsWith('/') ? head : nodePath.posix.dirname(head), unsafe };
}

// The local source paths named by an Artifact `files` value.
function sourceValues(files) {
  if (files === undefined || files === null) return [];
  if (Array.isArray(files)) {
    return files.flatMap((f) => (typeof f === 'string' ? [f] : isPlainObject(f) ? [f.path] : [UNKNOWN]));
  }
  if (isPlainObject(files)) {
    return Object.values(files).flatMap((v) => {
      if (v === null) return [];
      if (typeof v === 'string') return [v];
      if (isPlainObject(v)) return Object.hasOwn(v, 'from') ? [v.from] : []; // {artifact, path}: nothing local
      return [UNKNOWN];
    });
  }
  return [UNKNOWN];
}

function pathEntries(entry, input, cwd, ctx) {
  const out = [];
  const seen = new Set();
  const add = (p, access) => {
    const key = typeof p === 'string' ? `${access} ${p}` : null;
    if (key !== null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    out.push({ path: p, access });
  };
  const unset = (v) => v === undefined || v === null;
  // Every reading of a value that may hold a `~` (home-expanded, literal, UNKNOWN).
  const readings = (v, base) => (unset(v) ? [base] : resolveValue(v, base, ctx));
  const roots = readings(input.root, cwd);
  const searchBases = readings(input.path, cwd);
  for (const spec of entry.paths ?? []) {
    const raw = input[spec.field];
    if (unset(raw)) {
      if (spec.required) add(UNKNOWN, spec.access);
      else if (spec.cwdDefault) for (const b of searchBases) add(b, spec.access);
      continue;
    }
    if (spec.globPrefix) {
      // A glob pattern searches its literal prefix, resolved against the search path.
      const { prefix, unsafe } = patternPrefix(raw);
      if (unsafe) add(UNKNOWN, spec.access);
      if (prefix !== null) for (const b of searchBases) for (const p of resolveValue(prefix, b, ctx)) add(p, spec.access);
      continue;
    }
    const bases = spec.base === 'root' ? roots : [cwd];
    const values = spec.shape === 'list' ? (Array.isArray(raw) ? raw : [UNKNOWN]) : spec.shape === 'sources' ? sourceValues(raw) : [raw];
    const accesses = [spec.access];
    if (spec.alsoWriteWhen && Array.isArray(input[spec.alsoWriteWhen]) && input[spec.alsoWriteWhen].length > 0) accesses.push('write');
    for (const v of values) {
      const resolved = v === UNKNOWN ? [UNKNOWN] : bases.flatMap((b) => resolveValue(v, b, ctx));
      for (const access of accesses) for (const p of resolved) add(p, access);
    }
  }
  return out;
}

function parse(payload, ctx = {}) {
  const p = isPlainObject(payload) ? payload : {};
  const tool = str(p.tool_name) ?? '';
  const call = {
    host: 'claude',
    event: str(p.hook_event_name) ?? 'unknown',
    tool,
    kind: 'other',
    cwd: isAbsolute(p.cwd) ? nodePath.posix.resolve(p.cwd) : '',
    session_id: str(p.session_id) ?? '',
    agent_id: str(p.agent_id),
    agent_type: str(p.agent_type),
    permission_mode: str(p.permission_mode) ?? 'unknown',
    tool_use_id: str(p.tool_use_id) ?? '',
    paths: [],
  };
  const done = (extra) => compact({ ...call, ...extra });
  const opaque = (reason, extra = {}) => done({ ...extra, opaque: { reason } });

  if (tool === '') return opaque('malformed-payload');
  const entry = lookupTool(tool);
  if (entry !== null) call.kind = entry.kind;
  if (call.cwd === '') return opaque('missing-cwd');

  const rawInput = p.tool_input === undefined ? {} : p.tool_input;
  if (!isPlainObject(rawInput)) return opaque('malformed-input');
  const input = rawInput;

  if (entry === null) {
    // Unknown tool: opaque when its input carries something that looks like code or a command.
    const sus = OPAQUE_INPUT_FIELDS.some((f) => typeof input[f] === 'string');
    return sus ? opaque('unknown-tool-input') : done({});
  }
  if (entry.command) {
    return typeof input.command === 'string' ? done({ command: input.command }) : opaque('missing-command');
  }
  if (entry.kind === 'mcp') return done({ mcp: tool });

  const extra = {};
  if (entry.paths) extra.paths = pathEntries(entry, input, call.cwd, ctx);
  if (entry.egress) {
    if (entry.egress.domain) extra.url = `https://${entry.egress.domain}/`;
    else if (entry.egress.urlField) extra.url = typeof input[entry.egress.urlField] === 'string' ? input[entry.egress.urlField] : UNKNOWN;
  }
  return done(extra);
}

export const claude = Object.freeze({
  name: 'claude',
  events: Object.freeze(['PreToolUse', 'PostToolUse']),
  parse,
});
