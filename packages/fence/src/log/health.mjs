// Health record (spec, "Decision log": a failed log write is recorded in health.json, best effort).
//
//   recordHealth(stateDir, patch, {fs}) -> boolean   (never throws)
//
// Shallow-merges `patch` into <stateDir>/health.json (a missing, unreadable or non-object file counts
// as empty) and replaces the file atomically (temp file in the same directory, then rename), mode 0600.
// Self-contained: imports only node: modules.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

export const HEALTH_FILE = 'health.json';

export function recordHealth(stateDir, patch, { fs: fsImpl = nodeFs } = {}) {
  let tmp = null;
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return false;
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const file = nodePath.join(stateDir, HEALTH_FILE);
    let current = {};
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    } catch {
      current = {};
    }
    fsImpl.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fsImpl.writeFileSync(tmp, `${JSON.stringify({ ...current, ...patch })}\n`, { mode: 0o600, flag: 'wx' });
    fsImpl.renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (tmp !== null) fsImpl.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    return false;
  }
}
