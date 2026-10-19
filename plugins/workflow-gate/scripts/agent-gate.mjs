// The Agent half of workflow-gate: a sliding-window burst cap on same-model agent starts per session.
//
// The Workflow gate (gate.mjs) bounds the agents one script may launch. Agents started through the Agent tool, which is
// how every role agent is dispatched, were uncapped. This check runs on PreToolUse for Agent and Task: it resolves the
// model of the start, and denies it when the session already started `caps[model]` agents of that model within the
// last `windowS` seconds. Fable, Opus and Sonnet are capped; Haiku is not. Starts whose model cannot be resolved are
// counted in their own `unresolved` bucket, capped at the Opus cap.
//
// State: <stateDir>/<session_id>.json = { v: 1, starts: [{ model, at }] }, read and written under a lock
// (<file>.lock, from lock.mjs) so that agents started together lose no update. A denied start is not recorded.
// Every failure to read, lock or write allows: the gate must never block work because its own state is unusable.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withLock } from './lock.mjs';

export const DEFAULT_WINDOW_S = 120;
export const LOCK_WAIT_MS = 2000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// Bucket for starts whose model cannot be resolved (a built-in type such as general-purpose or Explore, an unknown
// roles:* type, or no subagent_type at all). They are counted apart from real Opus starts and capped at caps.opus.
export const UNRESOLVED = 'unresolved';

// Model family of the built-in (non roles:*) subagent types whose model is fixed. Empty: none has been verified, so
// such starts land in the unresolved bucket.
export const BUILTIN_MODELS = Object.freeze({});

const familyOf = (model) => {
  if (typeof model !== 'string') return null;
  const m = model.toLowerCase();
  return FAMILIES.find((f) => m.includes(f)) ?? null;
};

// The model bucket of an Agent start: the model input, else the role's model, else a built-in's, else UNRESOLVED.
function resolveModel(toolInput, roleModels) {
  const named = familyOf(toolInput.model);
  if (named) return named;
  const type = toolInput.subagent_type;
  if (typeof type !== 'string') return UNRESOLVED;
  const role = type.match(/^roles:([\w-]+)$/)?.[1];
  if (role && Object.hasOwn(roleModels, role)) return roleModels[role];
  if (Object.hasOwn(BUILTIN_MODELS, type)) return BUILTIN_MODELS[type];
  return UNRESOLVED;
}

// The recorded starts of a state file, or [] when it is missing, unreadable or not of this version.
function readStarts(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state?.v !== 1 || !Array.isArray(state.starts)) return [];
    return state.starts.filter((s) => s && typeof s.model === 'string' && Number.isFinite(s.at));
  } catch {
    return [];
  }
}

function writeStarts(file, starts) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, starts }));
  renameSync(tmp, file);
}

// Resolves to { decision: 'allow' | 'deny', reason? }. `reason` on a deny is the message for the model; on an allow it
// says why the gate let the start through unchecked. Options: now (ms), stateDir, caps ({ family: n }), windowS,
// roleModels ({ role: family }), lockWaitMs.
export async function decideAgent(input, { now = Date.now(), stateDir, caps, windowS = DEFAULT_WINDOW_S, roleModels = {}, lockWaitMs = LOCK_WAIT_MS } = {}) {
  const allow = (reason) => (reason ? { decision: 'allow', reason } : { decision: 'allow' });
  const toolInput = input?.tool_input;
  if ((input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') || toolInput === null || typeof toolInput !== 'object') return allow();
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return allow();

  const model = resolveModel(toolInput, roleModels);
  const cap = caps?.[model === UNRESOLVED ? 'opus' : model];
  if (cap === undefined || cap === Infinity) return allow();

  const file = join(stateDir, `${sessionId}.json`);
  const windowMs = windowS * 1000;
  try {
    mkdirSync(stateDir, { recursive: true });
    const locked = await withLock(file, () => {
      const live = readStarts(file).filter((s) => s.at > now - windowMs);
      const same = live.filter((s) => s.model === model);
      if (same.length >= cap) {
        const retry = Math.max(1, Math.ceil((Math.min(...same.map((s) => s.at)) + windowMs - now) / 1000));
        return {
          decision: 'deny',
          reason: `${model} Agent start ${same.length + 1} within ${windowS} s exceeds the cap of ${cap} per session ` +
            `(${same.length} already started). Start fewer ${model} agents at once, ${model === UNRESOLVED ? 'name a cheaper model for the rest' : 'use a cheaper model for the rest'}, or retry in about ${retry} s.`,
        };
      }
      writeStarts(file, [...live, { model, at: now }]);
      return { decision: 'allow' };
    }, { waitMs: lockWaitMs });
    return locked.locked ? locked.value : allow(`lock on ${file} timed out after ${lockWaitMs} ms: ${model} start not counted`);
  } catch (err) {
    return allow(`state unusable (${err.code ?? err.message}): ${model} start not counted`);
  }
}
