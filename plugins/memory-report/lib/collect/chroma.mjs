// Chroma health collector (spec 6.4): missing and orphaned documents, sync watermark lag, Chroma lines in the worker
// logs, Python crash reports, and an OK/ATTENTION status. Chroma is read in one keyset-paged pass so no statement holds
// the store's shared lock for long (in journal_mode=delete a reader blocks the writer's commit).
import { join } from 'node:path';
import { readClaudeMemSetting } from '../sources.mjs';

const DAY_MS = 86400000;
const TOP = 10;
const MESSAGE_MAX = 80;
const MISSING_SHARE_MIN_OBSERVATIONS = 50;
const SQLITE_BUSY = 5;
const PAGE_SQL = `SELECT id, key, string_value, int_value FROM embedding_metadata
  WHERE (id, key) > (?, ?) AND key IN ('sqlite_id', 'doc_type', 'project') ORDER BY id, key LIMIT ?`;
const LOG_LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d{3}\] \[(ERROR|WARN)\s*\] \[([A-Z_]+)\s*\]\s?(.*)$/;
const CRASH_FILE = /^Python-.*\.ips$/;

// One fixed string per ATTENTION trigger; the report never carries anything variable here.
const REASON_ORPHANS = 'Chroma documents without an observation in claude-mem.db';
const REASON_MISSING = 'A project of at least 50 observations is missing more than 1% from Chroma';
const REASON_LOGS = 'Chroma lines in the worker logs';
const REASON_CRASHES = 'Python crash reports in the window';

export const isBusy = (err) => err?.errcode === SQLITE_BUSY;

// Runs one page, retrying once when SQLite reports busy; a second busy failure surfaces as "Chroma store busy".
function readPage(chromaDb, args) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return chromaDb.prepare(PAGE_SQL).all(...args);
    } catch (err) {
      if (!isBusy(err)) throw err;
      if (attempt === 1) throw new Error('Chroma store busy');
    }
  }
}

// The keyset pass: pages on the full primary key (id, key) from (0, ''), so a document whose rows straddle a page
// boundary is never cut. Returns Map<embedding id, { sqlite_id?, doc_type?, project? }>.
export function readChromaDocs(chromaDb, pageSize) {
  const docs = new Map();
  let lastId = 0;
  let lastKey = '';
  for (;;) {
    const rows = readPage(chromaDb, [lastId, lastKey, pageSize]);
    for (const row of rows) {
      let doc = docs.get(row.id);
      if (doc === undefined) {
        doc = {};
        docs.set(row.id, doc);
      }
      doc[row.key] = row.key === 'sqlite_id' ? row.int_value : row.string_value;
    }
    if (rows.length < pageSize) return docs;
    const last = rows[rows.length - 1];
    lastId = last.id;
    lastKey = last.key;
  }
}

// A worker-log line that starts with `[timestamp] [ERROR|WARN] [CATEGORY]`; anything else (continuation lines, INFO and
// DEBUG lines) is null. `time` is epoch milliseconds: the line's timestamp is local time without a zone.
export function parseLogLine(line) {
  const m = LOG_LINE.exec(line);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, level, category, message] = m;
  return { time: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), level, category, message: message.trim() };
}

const byProject = (a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0);

function collectCounts(ctx) {
  const observationIds = new Map();
  for (const row of ctx.db.prepare("SELECT COALESCE(project, '') AS project, id FROM observations").all()) {
    let ids = observationIds.get(row.project);
    if (ids === undefined) {
      ids = new Set();
      observationIds.set(row.project, ids);
    }
    ids.add(row.id);
  }
  const chromaIds = new Map();
  for (const doc of readChromaDocs(ctx.chromaDb, ctx.pageSize).values()) {
    if (doc.doc_type !== 'observation' || typeof doc.sqlite_id !== 'number') continue;
    const project = doc.project ?? '';
    let ids = chromaIds.get(project);
    if (ids === undefined) {
      ids = new Set();
      chromaIds.set(project, ids);
    }
    ids.add(doc.sqlite_id);
  }
  let missingTotal = 0;
  let orphansTotal = 0;
  let largeProjectGap = false;
  const missingByProject = [];
  for (const [project, ids] of observationIds) {
    const inChroma = chromaIds.get(project) ?? new Set();
    let missing = 0;
    for (const id of ids) if (!inChroma.has(id)) missing += 1;
    let orphans = 0;
    for (const id of inChroma) if (!ids.has(id)) orphans += 1;
    missingTotal += missing;
    orphansTotal += orphans;
    if (missing > 0) missingByProject.push({ project, missing, total: ids.size });
    if (ids.size >= MISSING_SHARE_MIN_OBSERVATIONS && missing * 100 > ids.size) largeProjectGap = true;
  }
  const topMissing = missingByProject.sort((a, b) => b.missing - a.missing || byProject(a, b)).slice(0, TOP);
  return { missingTotal, orphansTotal, topMissing, largeProjectGap };
}

function collectWatermarkLag(ctx) {
  const text = ctx.fs.readText(ctx.paths.syncStateFile);
  if (text === null) return [];
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return [];
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return [];
  const maxIds = new Map();
  for (const row of ctx.db.prepare("SELECT COALESCE(project, '') AS project, max(id) AS maxId FROM observations GROUP BY COALESCE(project, '')").all()) {
    maxIds.set(row.project, row.maxId);
  }
  const lags = [];
  for (const [project, entry] of Object.entries(state)) {
    const watermark = entry?.observations;
    const maxId = maxIds.get(project);
    if (typeof watermark !== 'number' || maxId === undefined) continue;
    if (maxId - watermark > 0) lags.push({ project, lag: maxId - watermark });
  }
  return lags.sort((a, b) => b.lag - a.lag || byProject(a, b)).slice(0, TOP);
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Chroma ERROR and WARN lines of the worker logs inside the window, grouped by category and the message text before
// the first brace. Files are named by UTC date; line timestamps are local, so one extra day is read on each side.
function collectLogErrors(ctx) {
  const { startMs, endMs } = ctx.window;
  const groups = new Map();
  for (let day = Math.floor(startMs / DAY_MS) - 1; day <= Math.floor((endMs - 1) / DAY_MS) + 1; day += 1) {
    const text = ctx.fs.readText(join(ctx.paths.logsDir, `claude-mem-${utcDate(day * DAY_MS)}.log`));
    if (text === null) continue;
    for (const line of text.split('\n')) {
      const parsed = parseLogLine(line);
      if (parsed === null || parsed.time < startMs || parsed.time >= endMs || !/chroma/i.test(line)) continue;
      const message = parsed.message.split('{')[0].trim().slice(0, MESSAGE_MAX);
      const key = `${parsed.category}\u0000${message}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { category: parsed.category, message, count: 1 });
      else group.count += 1;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
    || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}

function collectCrashes(ctx) {
  if (ctx.platform !== 'darwin') return 'not applicable';
  const { startMs, endMs } = ctx.window;
  let count = 0;
  let newest = null;
  for (const name of ctx.fs.listDir(ctx.paths.crashDir) ?? []) {
    if (!CRASH_FILE.test(name)) continue;
    const stat = ctx.fs.stat(join(ctx.paths.crashDir, name));
    if (stat === null || stat.isDirectory || stat.mtimeMs < startMs || stat.mtimeMs >= endMs) continue;
    count += 1;
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return { count, newest: newest === null ? null : new Date(newest).toISOString() };
}

// Throws Error('Chroma store busy') when the store stays locked; the caller's section boundary turns that into an
// "unavailable" note.
export function collectChroma(ctx) {
  const enabled = String(readClaudeMemSetting(ctx, 'CLAUDE_MEM_CHROMA_ENABLED') ?? '').trim().toLowerCase() !== 'false';
  const storePresent = ctx.chromaDb !== null;
  const crashes = collectCrashes(ctx);
  const crashCount = crashes === 'not applicable' ? 0 : crashes.count;
  const reasons = [];
  let counts = { missingTotal: 0, orphansTotal: 0, topMissing: [], largeProjectGap: false };
  let watermarkLag = [];
  let logErrors = [];
  if (enabled) {
    if (storePresent) {
      counts = collectCounts(ctx);
      watermarkLag = collectWatermarkLag(ctx);
    }
    logErrors = collectLogErrors(ctx);
  }
  if (counts.orphansTotal > 0) reasons.push(REASON_ORPHANS);
  if (counts.largeProjectGap) reasons.push(REASON_MISSING);
  if (logErrors.length > 0) reasons.push(REASON_LOGS);
  if (crashCount > 0) reasons.push(REASON_CRASHES);
  return {
    enabled,
    storePresent,
    missingTotal: counts.missingTotal,
    orphansTotal: counts.orphansTotal,
    topMissing: counts.topMissing,
    watermarkLag,
    logErrors,
    crashes,
    status: reasons.length > 0 ? 'ATTENTION' : 'OK',
    reasons,
  };
}
