// The SessionStart hook (spec 5): starts the weekly run lazily and shows at most one notice line per local day.
// It opens no database; "claude-mem.db exists" is a stat. Every failure is logged and swallowed: the hook never
// blocks or breaks a session.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insightsGate, loadConfig, resolvePaths } from './config.mjs';
import { appendLog } from './files.mjs';
import { failureLine, summaryLine } from './render.mjs';
import {
  isDue, isLockStale, readLock, readNotice, readSeen, readState, writeNotice,
} from './state.mjs';

const DEFAULT_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ATTENDED_ENTRYPOINT = 'cli';
const NOTICE_NOT_SET_UP = 'memory-report is not set up \u2014 ask Claude to set it up (skill memory-report:setup)';
const NOTICE_INCOMPLETE = 'memory-report setup is incomplete \u2014 ask Claude to finish it (skill memory-report:setup)';

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const isAliveDefault = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // the process exists but belongs to someone else
  }
};

const toMs = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const nonEmpty = (v) => typeof v === 'string' && v !== '';
const errorText = (err) => (err instanceof Error ? err.message : String(err));

// The lock file's mtime, or undefined when it is gone.
function lockMtime(paths) {
  try {
    return statSync(paths.lockFile).mtimeMs;
  } catch {
    return undefined;
  }
}

// Absent or stale. A missing lock never reaches isLockStale (it does not accept null).
function lockIsFree(paths, { nowMs, isAlive }) {
  const lock = readLock(paths);
  if (lock === null) return true;
  return isLockStale(lock, { nowMs, isAlive, mtimeMs: lockMtime(paths) });
}

function startGenerator({ spawn, env, pluginRoot }) {
  const child = spawn(process.execPath, [join(pluginRoot, 'cli', 'memory.mjs'), 'generate'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  // A detached child that fails to start emits 'error' later; with no listener that would crash this process.
  if (typeof child.on === 'function') child.on('error', () => {});
  child.unref();
}

// Spec 5 step 4, case 1: lastError is set and the last attempt is later than the last success (or there is none).
function isFailure(state) {
  if (!nonEmpty(state.lastError)) return false;
  const attempt = toMs(state.lastAttemptAt);
  if (Number.isNaN(attempt)) return false; // no usable date to report
  const success = toMs(state.lastSuccessAt);
  return Number.isNaN(success) || attempt > success;
}

// Spec 5 step 4, case 2: a report on disk that seen.json does not match by (path, lastSuccessAt).
function isUnseenReport(state, seen) {
  if (!nonEmpty(state.lastReportPath) || !existsSync(state.lastReportPath)) return false;
  if (state.lastSummary === null || typeof state.lastSummary !== 'object') return false;
  return seen.seenReport !== state.lastReportPath || seen.seenSuccessAt !== state.lastSuccessAt;
}

// Local-setup spec 2.4, the lowest-priority case. `loaded` is loadConfig's result: `config` holds only valid setup dates.
// A decline later than the setup (or a decline with no setup) is the user's answer and silences both lines; an
// unparsable config is left alone, since setup would refuse to write over it.
function setupNotice(loaded) {
  if (loaded.unparsable) return null;
  const { config, invalidKeys } = loaded;
  const setupAt = toMs(config.setupAt);
  const declinedAt = toMs(config.setupDeclinedAt);
  if (!Number.isNaN(declinedAt) && (Number.isNaN(setupAt) || declinedAt > setupAt)) return null;
  if (Number.isNaN(setupAt)) return NOTICE_NOT_SET_UP;
  return insightsGate(config, invalidKeys).open ? null : NOTICE_INCOMPLETE;
}

function noticeLine(state, seen, paths, loaded) {
  if (isFailure(state)) return failureLine(state);
  if (isUnseenReport(state, seen)) return summaryLine(state.lastSummary, state.lastReportPath);
  return existsSync(paths.dbFile) ? setupNotice(loaded) : null;
}

function showNotice(paths, state, loaded, { env, nowMs, write }) {
  if (env.CLAUDE_CODE_ENTRYPOINT !== ATTENDED_ENTRYPOINT) return;
  const today = localDay(nowMs);
  if (readNotice(paths).lastNoticeDate === today) return;
  const line = noticeLine(state, readSeen(paths), paths, loaded);
  if (line === null) return;
  writeNotice(paths, { lastNoticeDate: today });
  write(`${JSON.stringify({
    systemMessage: line,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
  })}\n`);
}

// Runs the hook once. Never throws: anything that goes wrong is appended to run.log (when that is possible).
export function sessionStart({
  env = process.env,
  home = homedir(),
  nowMs = Date.now(),
  spawn = nodeSpawn,
  isAlive = isAliveDefault,
  write = (text) => process.stdout.write(text),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
} = {}) {
  let paths;
  try {
    paths = resolvePaths(env, home);
    if (env.MEMORY_REPORT_CHILD === '1' || env.CLAUDE_MEM_INTERNAL === '1') {
      appendLog(paths, 'hook', 'child-skip');
      return;
    }
    appendLog(paths, 'hook', `start entrypoint=${env.CLAUDE_CODE_ENTRYPOINT || 'none'}`);
    const state = readState(paths);
    const loaded = loadConfig(paths);
    const { config } = loaded;
    const due = isDue(state, config, {
      nowMs,
      dbExists: existsSync(paths.dbFile),
      lockFree: lockIsFree(paths, { nowMs, isAlive }),
    });
    if (due) startGenerator({ spawn, env, pluginRoot });
    showNotice(paths, state, loaded, { env, nowMs, write });
  } catch (err) {
    try {
      if (paths !== undefined) appendLog(paths, 'hook', `error ${errorText(err)}`);
    } catch { /* the log itself is unwritable: nothing left to do */ }
  }
}
