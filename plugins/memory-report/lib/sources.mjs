// Read-only sources for memory-report: opens claude-mem's databases and builds the collector context (spec 3.1).
// Collectors receive this context and never open a database or touch the filesystem themselves.
import { readdirSync, readFileSync, statSync } from 'node:fs';

const DAY_MS = 86400000;
const DB_TIMEOUT_MS = 5000;

const isMissing = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

// The real filesystem as the collectors see it: every lookup answers null for an absent path.
export const realFs = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  listDir(path) {
    try {
      return readdirSync(path);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  stat(path) {
    try {
      const st = statSync(path);
      return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
};

// Opens claude-mem.db (and the Chroma store when its file exists) read-only and returns the collector context. The
// window is the half-open interval [now - intervalDays, now). node:sqlite is imported here, not at load time, so a
// Node without it fails inside the caller's error boundary. claude-mem.db must exist: the caller checks first.
export async function openSources(paths, config, {
  now = Date.now, pageSize = 5000, fs = realFs, platform = process.platform, chromaTimeoutMs = 5000,
} = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(paths.dbFile, { readOnly: true, timeout: DB_TIMEOUT_MS });
  let chromaDb = null;
  try {
    if (fs.stat(paths.chromaFile) !== null) {
      chromaDb = new DatabaseSync(paths.chromaFile, { readOnly: true, timeout: chromaTimeoutMs });
    }
  } catch (err) {
    db.close();
    throw err;
  }
  const endMs = now();
  return {
    db,
    chromaDb,
    window: { startMs: endMs - config.intervalDays * DAY_MS, endMs },
    config,
    paths,
    fs,
    now,
    pageSize,
    platform,
  };
}

// Closes both handles; one failing to close does not leave the other open.
export function closeSources(ctx) {
  for (const handle of [ctx.db, ctx.chromaDb]) {
    try {
      handle?.close();
    } catch { /* already closed */ }
  }
}

const scalar = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

// A claude-mem setting from <claudeMemDir>/settings.json: the top-level key, else the same key inside an `env`
// object. undefined when the file is missing or unparsable, or the key is absent or not a string, number or boolean.
export function readClaudeMemSetting(ctx, key) {
  const text = ctx.fs.readText(ctx.paths.settingsFile);
  if (text === null) return undefined;
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const top = scalar(settings[key]);
  if (top !== undefined) return top;
  const env = settings.env;
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) return scalar(env[key]);
  return undefined;
}
