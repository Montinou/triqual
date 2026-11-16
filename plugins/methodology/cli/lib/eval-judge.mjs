// The session judges of the evals: the judge prompt files (a pinned model), the redaction of what a judge may read,
// the transcript rendering and one judge call. No secret reaches a judge: the rendered text passes through
// redactSecrets before the cap. node: built-ins only.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isLimit } from './eval-auth.mjs';

// Thrown for a judge prompt file that breaks the contract. The message names the field, never a value.
export class JudgePromptError extends Error {
  constructor(message) { super(message); this.name = 'JudgePromptError'; }
}

export const RENDER_CAP = 150_000;
const KEEP = RENDER_CAP / 2;
const ERROR_CHARS = 200;
const JUDGE_TIMEOUT_MS = 600_000;

// A full model id has a version digit and a hyphen (claude-opus-5-5, claude-sonnet-4-5-20250929); the aliases (sonnet,
// opus, haiku, default, opus[1m]) have not. The model is pinned so a prompt's hash names the judge it was validated with.
const FULL_MODEL = /^(?=.*\d)(?=.*-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Reads <id>.md: front matter with `model: <full model id>`, then the prompt body. hash = SHA-256 of the file.
export function loadJudgePrompt(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new JudgePromptError('judge prompt: unreadable'); }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const model = fm && /^model:[ \t]*(\S+)[ \t]*$/m.exec(fm[1])?.[1];
  if (!model) throw new JudgePromptError('judge prompt: front matter needs model: <full model id>');
  if (!FULL_MODEL.test(model)) throw new JudgePromptError('judge prompt: model must be a full model id, not an alias');
  return { model, body: fm[2], hash: createHash('sha256').update(text).digest('hex') };
}

const REDACTED = '[redacted]';
// A PEM private key block through its END line (or the end of the text when the END line is missing: the gate fails closed).
// The patterns below are built from parts so this source holds no literal that the repository's content gate reads as a secret.
const DASHES = '-'.repeat(5);
const PRIVATE_KEY_BLOCK = new RegExp(`${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}[\\s\\S]*?(?:${DASHES}END [A-Z ]*PRIVATE KEY${DASHES}|$)`, 'g');
// Whole-match secrets, most specific first. A match is replaced by [redacted].
const WHOLE = [
  PRIVATE_KEY_BLOCK,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bvck_[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];
// The password of a URL that carries credentials (scheme, user, password, host): the password only.
const URL_PASSWORD = new RegExp(`(\\b[a-z][a-z0-9+.-]{0,30}:${'/'.repeat(2)}[^\\s:@/]{1,200}:)[^\\s@/]{1,2000}(@)`, 'gi');
// NAME=value / "NAME": "value" where the name contains a secret word and the value has 20+ characters: the value only.
// The pattern starts at the secret word (no unbounded name prefix, which would make a long run of name characters
// quadratic) and every run after it is bounded.
const ASSIGNMENT = /((?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)([^\s"'`,;]{20,})/gi;

export function redactSecrets(input) {
  let text = String(input);
  let count = 0;
  const sub = (re, repl) => { text = text.replace(re, (...m) => { count += 1; return repl(...m); }); };
  for (const re of WHOLE) sub(re, () => REDACTED);
  sub(URL_PASSWORD, (_m, head, at) => `${head}${REDACTED}${at}`);
  sub(ASSIGNMENT, (_m, head) => `${head}${REDACTED}`);
  return { text, count };
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

// The user and assistant text of a transcript, the names of the tools called and the error flag of tool results (never
// a tool's input or output), redacted, then capped at RENDER_CAP keeping the first and last half. An unreadable file renders
// empty; judgeSession treats an empty render as an error.
export function renderForJudge(file) {
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { /* an unreadable transcript renders empty */ }
  const parts = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec === null || typeof rec !== 'object' || rec.isMeta === true) continue;
    const content = rec.message?.content;
    if (rec.type === 'user') {
      const text = textOf(content);
      if (text !== '') parts.push(`USER: ${text}`);
      if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result' && b.is_error === true) parts.push('[tool result: error]');
    } else if (rec.type === 'assistant') {
      const text = textOf(content);
      if (text !== '') parts.push(`ASSISTANT: ${text}`);
      if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use' && typeof b.name === 'string') parts.push(`[tool: ${b.name}]`);
    }
  }
  const { text } = redactSecrets(parts.join('\n'));
  return text.length > RENDER_CAP ? text.slice(0, KEEP) + text.slice(-KEEP) : text;
}

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { critique: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail'] } },
  required: ['critique', 'result'],
});

// The default spawn: runs bin with args, `input` on stdin, resolves { code, stdout, stderr } (never rejects on a non-zero exit).
export function spawnCapture(bin, args, { input, env, cwd, timeoutMs = JUDGE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = nodeSpawn(bin, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: null, stdout, stderr, spawnError: err?.code ?? 'error' }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => { /* the child may exit before reading its stdin */ });
    child.stdin.end(input);
  });
}

// The final result object of `claude -p --output-format json` stdout: an object, or the last result in an array.
function parseResult(stdout) {
  let v;
  try { v = JSON.parse(stdout.trim()); } catch { return null; }
  if (Array.isArray(v)) v = [...v].reverse().find((m) => m?.type === 'result');
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// One judge call. { result: "pass"|"fail"|"undecided", reason? } | { limit: true } | { error: string }.
// `session` is the transcript file; `render`, when given, is the text to judge in its place (the caller's kept render).
// `spawn(bin, args, { input, env, cwd })` resolves { code, stdout, stderr }; stdout alone is parsed.
export async function judgeSession({ category, prompt, session, render, spawn = spawnCapture, env, cwd, bin = 'claude' }) {
  const transcript = render ?? renderForJudge(session);
  // An unreadable or empty transcript is not a session without a failure: judging it would record a verdict for good.
  if (transcript.trim() === '') return { error: 'the transcript is unreadable or empty' };
  const input = `${prompt.body.trimEnd()}\n\nFailure category: ${category}\n\n--- session transcript ---\n${transcript}\n`;
  const args = ['-p', '--no-session-persistence', '--model', prompt.model, '--output-format', 'json', '--json-schema', SCHEMA,
    '--setting-sources', 'project', '--strict-mcp-config', '--tools', ''];
  let out;
  try { out = await spawn(bin, args, { input, env, cwd }); } catch { return { error: 'the judge could not be started' }; }
  const result = parseResult(String(out?.stdout ?? ''));
  if (result === null) return { error: out?.spawnError ? 'the judge could not be started' : 'unparseable output' };
  if (isLimit(result)) return { limit: true };
  if (result.is_error === true) return { error: String(result.result ?? '').slice(0, ERROR_CHARS) };
  const so = result.structured_output;
  if (so !== null && typeof so === 'object' && (so.result === 'pass' || so.result === 'fail') && typeof so.critique === 'string') {
    return { result: so.result, reason: so.critique };
  }
  return { result: 'undecided', reason: 'no valid structured output' };
}
