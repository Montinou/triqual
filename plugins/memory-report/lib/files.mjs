// File helpers for memory-report: private directories, atomic 0600 writes, tolerant JSON reads and the run log.
import {
  appendFileSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// mkdir -p; directories this call creates get mode 0700.
export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

// Writes `text` to `<path>.<pid>.<random>.tmp` (mode 0600) and renames it over `path`. The parent directory must exist.
// The temp file is removed when anything fails.
export function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', FILE_MODE);
    writeFileSync(fd, text);
    fchmodSync(fd, FILE_MODE);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created or already gone */ }
    throw err;
  }
}

// Parsed JSON, or null when the file does not exist or does not parse. Other read errors propagate.
export function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Appends `<ISO time> <event> <detail>` to run.log, creating the state dir. Callers pass fixed strings and counts only,
// never note text; line breaks in `detail` are flattened so one event stays one line.
export function appendLog(paths, event, detail) {
  ensureDir(paths.stateDir);
  const tail = detail === undefined || detail === '' ? '' : ` ${String(detail).replace(/[\r\n]+/g, ' ')}`;
  appendFileSync(paths.logFile, `${new Date().toISOString()} ${event}${tail}\n`, { mode: FILE_MODE });
}

// Bounds run.log: a log over `maxBytes` is cut to its last `keepBytes`, starting at a line boundary, and rewritten
// atomically. A missing log is left alone. Returns true when it rewrote the file.
export function rotateLog(paths, { maxBytes = 256 * 1024, keepBytes = 64 * 1024 } = {}) {
  let size;
  try {
    size = statSync(paths.logFile).size;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (size <= maxBytes) return false;
  const tail = Buffer.alloc(keepBytes + 1);
  const fd = openSync(paths.logFile, 'r');
  let got;
  try {
    // One byte before the kept tail tells whether the cut already falls on a line boundary.
    got = readSync(fd, tail, 0, tail.length, size - tail.length);
  } finally {
    closeSync(fd);
  }
  let start = 1;
  if (tail[0] !== 0x0a) {
    const nl = tail.indexOf(0x0a, 1);
    start = nl === -1 ? got : nl + 1;
  }
  writeAtomic(paths.logFile, tail.subarray(start, got).toString('utf8'));
  return true;
}
