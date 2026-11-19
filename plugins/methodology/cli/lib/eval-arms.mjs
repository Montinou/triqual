// Which experiment arm a session belongs to. The SessionStart hook (cli/drift.mjs) records, per session start, the arm
// the launcher put in the process environment (TRIQUAL_EVAL_ARM, TRIQUAL_EVAL_LAUNCH); the sessions store attributes
// each session from those records. node: built-ins only.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, evalsDir } from './eval-paths.mjs';

// The file, inside the evals directory, the hook appends to: one JSON line { sessionId, source, arm, launchId, at }.
export const SESSION_ARMS_FILE = 'session-arms.jsonl';

// An empty variable is no arm and no launch: never recorded as an arm named "".
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

// Appends the SessionStart record of `input` ({ sessionId, source }, as drift.mjs reads them from the hook's stdin) to
// <evals>/session-arms.jsonl in one appendFileSync: arm and launchId are the environment's TRIQUAL_EVAL_ARM and
// TRIQUAL_EVAL_LAUNCH, or null when unset or empty. An input without a string session id writes nothing. Never throws, prints nothing: an
// error goes to onError when given.
export function recordSessionArm({ input, env, home, onError }) {
  try {
    const sessionId = input?.sessionId ?? input?.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const dir = evalsDir(env, home);
    ensureDir(dir);
    const record = {
      sessionId,
      source: typeof input.source === 'string' ? input.source : null,
      arm: nonEmpty(env.TRIQUAL_EVAL_ARM),
      launchId: nonEmpty(env.TRIQUAL_EVAL_LAUNCH),
      at: new Date().toISOString(),
    };
    appendFileSync(join(dir, SESSION_ARMS_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    try { onError?.(err); } catch { /* reporting never breaks the hook */ }
  }
}

// The arm of `sessionId` from the SessionStart records: no record of it, no arm and not contaminated; every record
// names the same arm, that arm; any disagreement (an arm against another, or against none) is contaminated, with no arm.
export function attributeArm(sessionId, records) {
  let arm;
  let seen = false;
  for (const r of records) {
    if (r?.sessionId !== sessionId) continue;
    const a = typeof r.arm === 'string' ? r.arm : null;
    if (!seen) { arm = a; seen = true; } else if (a !== arm) return { arm: null, contaminated: true };
  }
  return { arm: seen ? arm : null, contaminated: false };
}
