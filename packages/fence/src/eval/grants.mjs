// Allow-once grants (spec, "Policy file" precedence 0 and CLI `allow-once`).
//
//   loadGrants(adminDir, stateDir, now, {isRootOwned = realRootCheck, fs} = {}) -> Grant[]
//   consume(grant) -> {ok: true} | {ok: false, reason}
//
// A grant is one file `<adminDir>/grants/<name>.json` holding {path, expires} (T39 writes it as
// root: `path` the realpath, `expires` an ISO time 10 minutes ahead). It is valid when:
// - the file is a regular file (lstat: a symlink is refused) that isRootOwned accepts; the real
//   check is owner uid 0 and not group- or world-writable;
// - it parses as a JSON object with an absolute `path` (no NUL, no `.`/`..` segment) and an ISO
//   `expires` that is after `now` and at most GRANT_MAX_LIFETIME_MS + CLOCK_SKEW_MS ahead of it;
// - at most MAX_GRANTS files are read, the newest names first (names sort by their leading time);
// - no used marker `<stateDir>/grants-used/<sha>` exists, `sha` being the sha256 of the file bytes.
// Grant = {path, expires, sha, file, stateDir}. consume(grant) writes the used marker (exclusive
// create, `wx`) and returns {ok: true} or {ok: false, reason}; it never swallows a failure, and the
// engine denies the call when the reservation fails. The `isRootOwned` seam is a module-API parameter for tests
// only; no flag or environment variable reaches it. Nothing here throws.
//
// Residual (stated in the spec): the used marker lives in the user's state directory, so code the
// human approved could delete it and reuse the grant within its lifetime.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

export const GRANT_MAX_LIFETIME_MS = 10 * 60 * 1000;
export const CLOCK_SKEW_MS = 60 * 1000;
export const MAX_GRANTS = 256;
const MAX_GRANT_BYTES = 64 * 1024;
const USED_DIR = 'grants-used';

const isAbs = (s) => typeof s === 'string' && s.startsWith('/') && !s.includes('\0');
const cleanPath = (p) => isAbs(p) && !p.split('/').some((seg) => seg === '.' || seg === '..');

/** The real ownership check: owned by root and not group- or world-writable. */
export function realRootCheck(file, stat) {
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

function usedMarker(stateDir, sha) {
  return nodePath.join(stateDir, USED_DIR, sha);
}

function readGrant(file, stateDir, now, isRootOwned, fsImpl) {
  const st = fsImpl.lstatSync(file);
  if (!st.isFile() || st.size > MAX_GRANT_BYTES) return null;
  if (isRootOwned(file, st) !== true) return null;
  const bytes = fsImpl.readFileSync(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const v = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!cleanPath(v.path) || typeof v.expires !== 'string') return null;
  const expires = Date.parse(v.expires);
  if (!Number.isFinite(expires) || expires <= now || expires - now > GRANT_MAX_LIFETIME_MS + CLOCK_SKEW_MS) return null;
  if (fsImpl.existsSync(usedMarker(stateDir, sha))) return null;
  return { path: v.path, expires: v.expires, sha, file, stateDir };
}

export function loadGrants(adminDir, stateDir, now, { isRootOwned = realRootCheck, fs: fsImpl = nodeFs } = {}) {
  try {
    if (!isAbs(adminDir) || !isAbs(stateDir) || !Number.isFinite(now) || typeof isRootOwned !== 'function') return [];
    const dir = nodePath.join(adminDir, 'grants');
    let names;
    try {
      names = fsImpl.readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    // Newest names first (T39 names a grant `<ms time>-<random>.json`): once grants/ holds more than
    // MAX_GRANTS files, the ones read are the newest, so a fresh allow-once always applies.
    for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse().slice(0, MAX_GRANTS)) {
      try {
        const g = readGrant(nodePath.join(dir, name), stateDir, now, isRootOwned, fsImpl);
        if (g) out.push(g);
      } catch {
        // an unreadable or malformed grant is no grant
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function consume(grant, fsImpl = nodeFs) {
  try {
    if (grant === null || typeof grant !== 'object' || !isAbs(grant.stateDir) || typeof grant.sha !== 'string' || !/^[0-9a-f]{64}$/.test(grant.sha)) {
      return { ok: false, reason: 'not a loaded grant' };
    }
    const marker = usedMarker(grant.stateDir, grant.sha);
    fsImpl.mkdirSync(nodePath.dirname(marker), { recursive: true, mode: 0o700 });
    // Exclusive create: a parallel hook that reserved the same grant first makes this fail (EEXIST).
    fsImpl.writeFileSync(marker, `${JSON.stringify({ path: grant.path, expires: grant.expires })}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : err instanceof Error ? err.message : String(err);
    return { ok: false, reason: code === 'EEXIST' ? 'the grant was already used (EEXIST)' : `its used marker could not be written (${code})` };
  }
}
