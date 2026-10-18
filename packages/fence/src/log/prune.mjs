// Retention (spec: 30 days for logs and the written-files index, pruned automatically at session start;
// there is no agent-reachable prune command).
//
//   prune(stateDir, now, {days = 30, fs}) -> {removed: number}
//
// Removes <stateDir>/log/YYYY-MM-DD.jsonl files whose whole (UTC) day is older than the window,
// <stateDir>/written/<session>.txt files not modified within it, and the compaction keep-list snapshots
// <stateDir>/keep/<session>.md (and the temp files of a write that never finished) not modified within it.
// Only files with those exact name shapes are touched, only regular files (lstat; a symlink is left alone),
// and only inside real directories (a symlinked log/, written/ or keep/ is not entered). Never throws.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { KEEP_DIR, KEEP_NAME, KEEP_TMP } from '../hooks/keeplist.mjs';
import { DAY_MS, RETENTION_DAYS, WRITTEN_DIR, WRITTEN_NAME } from './written.mjs';

const LOG_NAME = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

function realDir(fsImpl, dir) {
  try {
    const st = fsImpl.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeIf(fsImpl, dir, test) {
  let removed = 0;
  if (!realDir(fsImpl, dir)) return 0;
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const file = nodePath.join(dir, name);
      const st = fsImpl.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || !test(name, st)) continue;
      fsImpl.unlinkSync(file);
      removed++;
    } catch {
      // best effort: the next session start tries again
    }
  }
  return removed;
}

export function prune(stateDir, now = Date.now(), { days = RETENTION_DAYS, fs: fsImpl = nodeFs } = {}) {
  try {
    if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) return { removed: 0 };
    const nowMs = typeof now === 'function' ? now() : now;
    const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - days * DAY_MS;
    let removed = removeIf(fsImpl, nodePath.join(stateDir, 'log'), (name) => {
      const m = LOG_NAME.exec(name);
      if (m === null) return false;
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isFinite(start) && start + DAY_MS <= cutoff;
    });
    removed += removeIf(fsImpl, nodePath.join(stateDir, WRITTEN_DIR), (name, st) => WRITTEN_NAME.test(name) && st.mtimeMs < cutoff);
    removed += removeIf(fsImpl, nodePath.join(stateDir, KEEP_DIR), (name, st) => (KEEP_NAME.test(name) || KEEP_TMP.test(name)) && st.mtimeMs < cutoff);
    return { removed };
  } catch {
    return { removed: 0 };
  }
}
