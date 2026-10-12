// File helpers for progress-tracking: atomic writes and hashing. Self-contained; imports nothing from other plugins.
import {
  existsSync, realpathSync, statSync, openSync, writeFileSync, fchmodSync, fsyncSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const NEW_FILE_MODE = 0o644;

// Writes `content` to `path` through a temp file in the same directory plus rename. An existing path is resolved
// through symlinks first, so the link survives and its target is replaced. Keeps an existing file's mode; new files
// get 0644. The temp file is removed when anything fails.
export function writeAtomic(path, content) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : NEW_FILE_MODE;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created or already gone */ }
    throw err;
  }
}

// Hex SHA-256 of a string (or Buffer).
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
