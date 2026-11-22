// The credential chain of the evals (<config>/eval-auth.json, owner-written) and the environment of every `claude`
// child the evals spawn for a model call. A secret is read when a child is spawned and never reaches an error's text.
// node: built-ins only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { brandDir } from './brand.mjs';

// Thrown for a chain file or a secret source that breaks the contract. The message names the entry and the field, never a value.
export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

// Thrown by a chain when every entry ended on a usage limit. `tried` is the entry names.
export class ChainExhausted extends Error {
  constructor(tried) {
    super(`every credential entry hit a limit: ${tried.join(', ')}`);
    this.name = 'ChainExhausted';
    this.tried = [...tried];
  }
}

export const LIMIT_NOTE = 'every credential entry hit a usage limit';
// A chain whose entries are all paid, run without --paid: nothing is tried, so it is not a usage limit.
export const PAID_NOTE = 'every credential entry is paid; pass --paid';

export const CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
// Everything a child must not inherit: the credentials, the provider selectors and the arm marker.
const STRIPPED = [...CREDENTIAL_VARS, 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'TRIQUAL_EVAL_ARM'];

const NAME = /^[a-z][a-z0-9-]{0,19}$/;
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOnly = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
// A key is echoed in an error only when it looks like a variable name, so a misplaced secret is never printed.
const shown = (k) => (VAR_NAME.test(k) || /^[a-z][A-Za-z0-9_]{0,30}$/.test(k) ? k : '<invalid>');

// TRIQUAL_EVAL_AUTH_FILE, else brandDir($XDG_CONFIG_HOME or home/.config)/eval-auth.json.
export function authPath(env, home) {
  if (env.TRIQUAL_EVAL_AUTH_FILE) return env.TRIQUAL_EVAL_AUTH_FILE;
  return join(brandDir(env.XDG_CONFIG_HOME || join(home, '.config')), 'eval-auth.json');
}

function validSource(v) {
  if (typeof v === 'string') return true;
  if (!isObject(v)) return false;
  if (typeof v.file === 'string') return v.file !== '' && hasOnly(v, ['file']);
  return typeof v.envFile === 'string' && v.envFile !== '' && typeof v.var === 'string' && VAR_NAME.test(v.var) && hasOnly(v, ['envFile', 'var']);
}

// Reads { chain: [{ name, env, paid? }] }. `paid` (default false) marks an entry that spends money: usableChain leaves it
// out unless the caller opted in. No file: the single entry `ambient`, which sets nothing. The values are not resolved here.
export function loadChain(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [{ name: 'ambient', env: {}, paid: false }];
    throw new AuthError('eval-auth file: unreadable');
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new AuthError('eval-auth file: not JSON'); }
  if (!isObject(doc)) throw new AuthError('eval-auth file: not an object');
  for (const k of Object.keys(doc)) if (k !== 'chain') throw new AuthError(`eval-auth file: unknown key ${shown(k)}`);
  if (!Array.isArray(doc.chain) || doc.chain.length === 0) throw new AuthError('eval-auth chain: must be a non-empty list');
  const seen = new Set();
  return doc.chain.map((e, i) => {
    if (!isObject(e)) throw new AuthError(`chain[${i}]: not an object`);
    if (typeof e.name !== 'string' || !NAME.test(e.name)) throw new AuthError(`chain[${i}].name: must match ${NAME}`);
    const at = `chain entry ${e.name}`;
    for (const k of Object.keys(e)) if (k !== 'name' && k !== 'env' && k !== 'paid') throw new AuthError(`${at}: unknown key ${shown(k)}`);
    if (seen.has(e.name)) throw new AuthError(`${at}: duplicate name`);
    seen.add(e.name);
    if (Object.hasOwn(e, 'paid') && typeof e.paid !== 'boolean') throw new AuthError(`${at}.paid: must be true or false`);
    const env = e.env ?? {};
    if (!isObject(env)) throw new AuthError(`${at}.env: must be an object`);
    for (const [k, v] of Object.entries(env)) {
      if (!CREDENTIAL_VARS.includes(k)) throw new AuthError(`${at}.env: unknown variable ${shown(k)}`);
      if (!validSource(v)) throw new AuthError(`${at}.env.${k}: must be a string, { file } or { envFile, var }`);
    }
    return { name: e.name, env: { ...env }, paid: e.paid === true };
  });
}

// The entries a command may use: every entry with `paid`, else the entries that are not paid, in order.
export function usableChain(chain, { paid = false } = {}) {
  return paid === true ? chain : chain.filter((e) => e.paid !== true);
}

const unquote = (s) => {
  const v = s.trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;
};
const expand = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

function resolveVar(entryName, name, spec, home) {
  const fail = (why) => new AuthError(`chain entry ${entryName}: ${name}: ${why}`);
  if (typeof spec === 'string') return spec;
  if (typeof spec.file === 'string') {
    let v;
    try { v = readFileSync(expand(spec.file, home), 'utf8').trim(); } catch { throw fail('secret file unreadable'); }
    if (v === '') throw fail('secret file is empty');
    return v;
  }
  let text;
  try { text = readFileSync(expand(spec.envFile, home), 'utf8'); } catch { throw fail('env file unreadable'); }
  const line = new RegExp(`^\\s*(?:export\\s+)?${spec.var}\\s*=(.*)$`);
  let value;
  for (const l of text.split('\n')) {
    const m = line.exec(l.replace(/\r$/, ''));
    if (m) value = unquote(m[1]);
  }
  if (value === undefined) throw fail('variable not found in the env file');
  return value;
}

// The environment of a `claude` child: baseEnv without the credentials, provider selectors and arm marker, plus the
// entry's variables resolved now. baseEnv is not modified.
export function childEnv(entry, baseEnv, { home = homedir() } = {}) {
  const out = { ...baseEnv };
  for (const k of STRIPPED) delete out[k];
  for (const [name, spec] of Object.entries(entry.env ?? {})) out[name] = resolveVar(entry.name, name, spec, home);
  return out;
}

export const limitText = (text) => typeof text === 'string'
  && (/^(API Error: )?You've hit your\b/i.test(text) || /\b(usage|spend) limit\b/i.test(text)
    || /credit balance is too low/i.test(text) || /shared budget/i.test(text));

// The final result object of `claude -p --output-format json` ended on a usage limit. A 429 alone is a transient rate
// limit (an error for that session, the chain stays on its entry); it counts only with usage_limit_reached or the limit text.
export const isLimit = (result) => result !== null && typeof result === 'object' && result.is_error === true
  && (result.api_error === 'usage_limit_reached' || limitText(result.result));

// Runs units through the chain: `attempt(unit, entry)` returns a result; on a limit (isLimit, or a `{ limit: true }`
// outcome of a caller that already classified it) the current entry moves to the next one for every later unit and
// the unit is attempted again; after the last entry run() throws ChainExhausted. Units may run concurrently: a limit moves
// the chain only when it is still on the entry that unit attempted, so two in-flight limits on one entry advance it once,
// and a run in flight on an old entry finishes there.
export function withChain(chain, attempt) {
  let at = 0;
  const counts = {};
  const tried = () => chain.map((e) => e.name);
  return {
    async run(unit) {
      for (;;) {
        const i = at;
        if (i >= chain.length) throw new ChainExhausted(tried());
        const entry = chain[i];
        const result = await attempt(unit, entry);
        if (isLimit(result) || result?.limit === true) { if (at === i) at = i + 1; continue; }
        counts[entry.name] = (counts[entry.name] ?? 0) + 1;
        return { result, entry };
      }
    },
    counts: () => ({ ...counts }),
  };
}
