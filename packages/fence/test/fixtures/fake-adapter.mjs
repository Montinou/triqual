// A third, invented host adapter for the contract suite and the evaluator-independence test.
// Its payload shape is {event, tool, cwd, input, id, session}; it is not a real host.

import nodePath from 'node:path';

import { UNKNOWN } from '../../src/norm/unknown.mjs';
import { compact } from '../../src/hosts/types.mjs';

export const FAKE_EVENT = 'BeforeTool';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbsolute = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\u0000');
const str = (v) => (typeof v === 'string' ? v : undefined);

function parse(payload, ctx = {}) {
  const p = isObject(payload) ? payload : {};
  const input = isObject(p.input) ? p.input : {};
  const tool = str(p.tool) ?? '';
  const call = {
    host: 'fake',
    event: str(p.event) ?? 'unknown',
    tool,
    kind: 'other',
    cwd: isAbsolute(p.cwd) ? nodePath.posix.resolve(p.cwd) : '',
    session_id: str(p.session) ?? '',
    permission_mode: 'unknown',
    tool_use_id: str(p.id) ?? '',
    paths: [],
  };
  const opaque = (reason, extra = {}) => compact({ ...call, ...extra, opaque: { reason } });

  if (tool === '') return opaque('malformed-payload');
  if (call.cwd === '') return opaque('missing-cwd');

  if (tool === 'Teleport') {
    // The new tool kind: a write whose destination is `input.dest`.
    const dest = isAbsolute(input.dest) ? input.dest : typeof input.dest === 'string' && input.dest !== '' ? nodePath.posix.resolve(call.cwd, input.dest) : UNKNOWN;
    return compact({ ...call, kind: 'file', paths: [{ path: typeof dest === 'string' ? nodePath.posix.normalize(dest) : dest, access: 'write' }] });
  }
  if (tool === 'Beam') return compact({ ...call, kind: 'net', url: typeof input.url === 'string' ? input.url : UNKNOWN });
  if (tool === 'Run') {
    return typeof input.cmd === 'string' ? compact({ ...call, kind: 'shell', command: input.cmd }) : opaque('missing-command', { kind: 'shell' });
  }
  if (tool === 'Quiet') return compact(call);
  // Unknown tool: opaque when it carries code or a command, else undecided.
  return typeof input.command === 'string' || typeof input.script === 'string' ? opaque('unknown-tool-input') : compact(call);
}

const payload = (tool, input, more = {}) => ({ event: FAKE_EVENT, tool, cwd: '/work/repo', input, id: 'f-1', session: 's-1', ...more });

export const fake = Object.freeze({
  name: 'fake',
  events: Object.freeze([FAKE_EVENT]),
  parse,
  fixtures: Object.freeze({
    ctx: Object.freeze({ home: '/home/tester' }),
    payloads: Object.freeze([
      { name: 'teleport absolute', payload: payload('Teleport', { dest: '/work/repo/out/a.txt' }), expect: { kind: 'file', paths: [{ path: '/work/repo/out/a.txt', access: 'write' }] } },
      { name: 'teleport relative', payload: payload('Teleport', { dest: 'out/../b.txt' }), expect: { kind: 'file', paths: [{ path: '/work/repo/b.txt', access: 'write' }] } },
      { name: 'teleport without dest', payload: payload('Teleport', {}), expect: { kind: 'file', paths: [{ path: UNKNOWN, access: 'write' }] } },
      { name: 'beam', payload: payload('Beam', { url: 'https://example.com/x' }), expect: { kind: 'net', url: 'https://example.com/x' } },
      { name: 'run', payload: payload('Run', { cmd: 'ls' }), expect: { kind: 'shell', command: 'ls' } },
      { name: 'run without cmd', payload: payload('Run', {}), expect: { opaque: { reason: 'missing-command' } } },
      { name: 'quiet', payload: payload('Quiet', {}), expect: { kind: 'other', paths: [] } },
      { name: 'unknown with a script', payload: payload('Mystery', { script: 'x' }), expect: { opaque: { reason: 'unknown-tool-input' } } },
      { name: 'no cwd', payload: payload('Quiet', {}, { cwd: undefined }), expect: { opaque: { reason: 'missing-cwd' } } },
    ]),
  }),
});
