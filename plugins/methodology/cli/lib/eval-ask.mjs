// One model call with a JSON schema, the sample of sessions a reader goes through and the private append of the evals
// data. No transcript text is printed here. node: built-ins only.
import { appendFileSync, chmodSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLimit } from './eval-auth.mjs';
import { spawnCapture } from './eval-judge.mjs';
import { ensureDir } from './eval-paths.mjs';
import { readJsonl } from './eval-store.mjs';
import { judgeExcluded } from './eval-taxonomy.mjs';

const ERROR_CHARS = 200;

// The final result object of `claude -p --output-format json` stdout: an object, or the last result in an array.
function parseResult(stdout) {
  let v;
  try { v = JSON.parse(stdout.trim()); } catch { return null; }
  if (Array.isArray(v)) v = [...v].reverse().find((m) => m?.type === 'result');
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// One model call. { answer: object } | { limit: true } | { error: string }. `answer` is the structured output of the
// final result; without one the outcome is { error: 'no valid structured output' }. `spawn(bin, args, { input, env, cwd })` resolves
// { code, stdout, stderr }; stdout alone is parsed.
export async function askModel({ model, input, schema, spawn = spawnCapture, env, cwd, bin = 'claude' }) {
  const args = ['-p', '--no-session-persistence', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--setting-sources', 'project', '--strict-mcp-config', '--tools', ''];
  let out;
  try { out = await spawn(bin, args, { input, env, cwd }); } catch { return { error: 'the model could not be started' }; }
  const result = parseResult(String(out?.stdout ?? ''));
  if (result === null) return { error: out?.spawnError ? 'the model could not be started' : 'unparseable output' };
  if (isLimit(result)) return { limit: true };
  if (result.is_error === true) return { error: String(result.result ?? '').slice(0, ERROR_CHARS) };
  const so = result.structured_output;
  if (so !== null && typeof so === 'object' && !Array.isArray(so)) return { answer: so };
  return { error: 'no valid structured output' };
}

// The review sample (<evals>/review/sample.jsonl) in its order, each with its transcript file (from the sessions store
// <evals>/sessions.jsonl; null when the session is not stored) and whether its project is under the taxonomy's
// judgeExclude. The gate fails closed: a session is excluded when the store's project or the sample's project is.
export function sampleSessions({ evals, root, taxonomy, home, platform }) {
  const store = new Map(readJsonl(join(evals, 'sessions.jsonl')).rows.filter((r) => typeof r.sessionId === 'string').map((r) => [r.sessionId, r]));
  const patterns = taxonomy?.judgeExclude ?? [];
  const out = [];
  for (const row of readJsonl(join(evals, 'review', 'sample.jsonl')).rows) {
    if (typeof row.sessionId !== 'string') continue;
    const stored = store.get(row.sessionId);
    const file = typeof stored?.projectDir === 'string' ? join(root, stored.projectDir, `${row.sessionId}.jsonl`) : null;
    // The store's project when the session is stored (unknown counts as excluded), plus the sample's when it names one.
    const projects = stored === undefined ? [row.project ?? null] : [stored.project ?? null, ...(typeof row.project === 'string' ? [row.project] : [])];
    const excluded = projects.some((p) => judgeExcluded(p, patterns, { home, platform }));
    out.push({ sessionId: row.sessionId, stratum: row.stratum ?? null, file, excluded });
  }
  return out;
}

// Whether `file` ends in the middle of a line (a torn last write): the next row must start on a fresh one.
function endsMidLine(file) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return false; }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally { closeSync(fd); }
}

// Appends one JSON line to `file` (created with mode 0600, left at 0600).
export function appendPrivate(file, row) {
  ensureDir(dirname(file));
  const lead = endsMidLine(file) ? '\n' : '';
  appendFileSync(file, `${lead}${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
