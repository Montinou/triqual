// The repo registry (spec Addendum D.2): `<home>/.config/triqual/repos.json` (or under the legacy dir until
// migration), machine config that is never in a repo. `{ "version": 1, "repos": [{ "root", "mode", "lastSeen",
// "shareable" }] }`, roots as absolute realpaths; `mode` is committed, local or store (a store repository is found again
// by its `git config --local triqual.tracking store` marker, which resolveTracking reads). progress-init and the SessionStart hook upsert into it;
// `triqual tasks export --all` reads it.
// TRIQUAL_REGISTRY_DIR (else the legacy CM_REGISTRY_DIR), when set, is the directory that holds repos.json (and its
// lock) instead: the e2e probe points it at a temp dir so its throwaway repos never reach the real registry. It must be
// an absolute path; any other value, the empty string included, disables the registry (reads find no entries, writes do
// nothing), so a broken override never falls back to the real file.
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { brandDir, readEnv } from './brand.mjs';
import { writeAtomic } from './fsx.mjs';
import { withLock } from './lock.mjs';
import { resolveTracking } from './tracking.mjs';

export const REGISTRY_VERSION = 1;

export const REGISTRY_DIR_ENV = 'TRIQUAL_REGISTRY_DIR';

// The registry file: <TRIQUAL_REGISTRY_DIR, else CM_REGISTRY_DIR>/repos.json, else
// <brandDir(<home>/.config)>/repos.json. Throws on an unusable override; every caller in this module catches it
// (registerRepo writes nothing, a read sees no file).
export function registryPath(home) {
  const override = readEnv(process.env, 'REGISTRY_DIR');
  if (override === undefined) return join(brandDir(join(home, '.config')), 'repos.json');
  if (!isAbsolute(override)) throw new Error(`${REGISTRY_DIR_ENV} must be an absolute path: ${JSON.stringify(override)}`);
  return join(override, 'repos.json');
}

// Beside repos.json, outside every working tree: concurrent sessions upsert one at a time.
export const registryLockPath = (home) => `${registryPath(home)}.lock`;

const isEntry = (r) => r && typeof r === 'object' && typeof r.root === 'string' && r.root !== '';

// The stored `repos` array, raw: [] when the file does not exist; null when it cannot be read, is not JSON, or is not
// an object holding a `repos` array (such a file is never overwritten), or when the registry override is unusable.
function readRaw(home) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryPath(home), 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }
  const ok = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.repos);
  return ok ? parsed.repos : null;
}

// Every well-formed entry, as stored (roots not re-resolved), shareable normalized to a boolean. A missing,
// unreadable or corrupt file reads as no entries.
export function readRegistry(home) {
  return (readRaw(home) ?? [])
    .filter(isEntry)
    .map((r) => ({ root: r.root, mode: r.mode, lastSeen: r.lastSeen, shareable: r.shareable === true }));
}

// Upserts `root` (stored as its realpath): mode and lastSeen are refreshed, an existing shareable is kept, a new
// entry gets false; other entries are kept as stored. A registry file that exists but cannot be read or parsed, or
// has another shape, is left untouched (no write). The read and the write run under the registry lock, so two
// sessions registering at once keep both entries. Synchronous and small, it never throws and never prints (a lock
// timeout and an unusable registry override included): a registry that cannot be written must never break the caller
// (a SessionStart hook, progress-init). Under the override, `home` is not used.
export function registerRepo(home, { root, mode, now }) {
  try {
    const abs = realpathSync(root);
    const file = registryPath(home);
    mkdirSync(dirname(file), { recursive: true });
    withLock(registryLockPath(home), () => {
      const repos = readRaw(home);
      if (repos === null) return;
      const at = repos.findIndex((r) => isEntry(r) && r.root === abs);
      const entry = { root: abs, mode, lastSeen: now.toISOString(), shareable: at !== -1 && repos[at].shareable === true };
      if (at === -1) repos.push(entry);
      else repos[at] = entry;
      writeAtomic(file, `${JSON.stringify({ version: REGISTRY_VERSION, repos }, null, 2)}\n`);
    });
  } catch {
    // swallowed: the registry is a convenience, never a gate
  }
}

// A checkout moved: drops the entry whose root is `from` (its realpath when it exists, else `from` as given) and upserts
// `to` (stored as its realpath) with mode and lastSeen refreshed and the old entry's shareable (else the existing `to`
// entry's, else false). Same lock, same untouched unreadable file, and like registerRepo it never throws or prints.
export function moveRepo(home, { from, to, mode, now }) {
  try {
    const abs = realpathSync(to);
    let old = from;
    try { old = realpathSync(from); } catch { /* gone: matched as given */ }
    const file = registryPath(home);
    mkdirSync(dirname(file), { recursive: true });
    withLock(registryLockPath(home), () => {
      const repos = readRaw(home);
      if (repos === null) return;
      const prev = repos.find((r) => isEntry(r) && r.root === old) ?? repos.find((r) => isEntry(r) && r.root === abs);
      const kept = repos.filter((r) => !(isEntry(r) && (r.root === old || r.root === abs)));
      kept.push({ root: abs, mode, lastSeen: now.toISOString(), shareable: prev !== undefined && prev.shareable === true });
      writeAtomic(file, `${JSON.stringify({ version: REGISTRY_VERSION, repos: kept }, null, 2)}\n`);
    });
  } catch {
    // swallowed: the registry is a convenience, never a gate
  }
}

// The registered repos that still resolve to an opted-in repo, each with its `tracking` (resolveTracking, run once per
// repo). Read-only: a dropped root stays in the file and is only filtered out here.
export function listResolved(home) {
  const out = [];
  for (const r of readRegistry(home)) {
    let tracking = null;
    try {
      tracking = resolveTracking(r.root);
    } catch { /* dropped like a root that no longer resolves */ }
    if (tracking) out.push({ ...r, tracking });
  }
  return out;
}

// listResolved without the trackings.
export const listRepos = (home) => listResolved(home).map(({ tracking, ...r }) => r);
