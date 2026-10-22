// The multi-harness manifest `~/.config/triqual/harnesses.json` (or under the legacy dir until migration;
// spec Addendum F.4): what `triqual sync` and the harness session refresh did in each harness, so `--remove-harness` can
// replay it in reverse. Every read-modify-write runs under the file's mkdir lock (lib/lock.mjs). Records are upserted,
// never appended twice, so a sync that changes nothing leaves the bytes as they were. node: built-ins only.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brandDir } from './brand.mjs';
import { writeAtomic } from './fsx.mjs';
import { withLock } from './lock.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const manifestPath = (home) => join(brandDir(join(home, '.config')), 'harnesses.json');

// The manifest, or `{ version: 1, harnesses: {} }` when the file is missing. Throws for a file that cannot be read,
// is not JSON or is not a version 1 manifest: nothing acts on a record it cannot trust.
export function readManifest(home) {
  const path = manifestPath(home);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, harnesses: {} };
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isObject(manifest) || manifest.version !== 1) throw new Error(`${path} is not a version 1 manifest`);
  if (!isObject(manifest.harnesses)) manifest.harnesses = {};
  return manifest;
}

export function writeManifest(home, manifest) {
  const path = manifestPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);

// One harness's records, every field present, in a fixed key order.
function entryOf(raw) {
  return {
    links: list(raw?.links),
    files: list(raw?.files),
    rolesSha: typeof raw?.rolesSha === 'string' ? raw.rolesSha : null,
    rules: isObject(raw?.rules) ? raw.rules : null,
    config: list(raw?.config),
    plugins: list(raw?.plugins),
  };
}

const isEmpty = (e) => !e.links.length && !e.files.length && e.rolesSha === null && e.rules === null
  && !e.config.length && !e.plugins.length;

// Runs fn(entry) on harness `id`'s records under the manifest lock and writes the manifest only when something
// changed, also when fn throws midway (so the records match what was done before the error, which is re-thrown).
// Resolves { locked: true, value } or, when the lock is not taken within waitMs, { locked: false } with fn never run.
// A harness with no records is not added.
export async function withManifest(home, id, fn, { waitMs } = {}) {
  const opts = waitMs === undefined ? {} : { waitMs };
  return withLock(manifestPath(home), async () => {
    const manifest = readManifest(home);
    const before = JSON.stringify(manifest);
    const had = Object.hasOwn(manifest.harnesses, id);
    const entry = entryOf(manifest.harnesses[id]);
    try {
      return await fn(entry);
    } finally {
      if (had || !isEmpty(entry)) manifest.harnesses[id] = entry;
      if (JSON.stringify(manifest) !== before) writeManifest(home, manifest);
    }
  }, opts);
}

// ---- record upserts: the first record of a thing keeps what was there before us ----

// A link record { path, target, replaced }: `target` is our link's target, or null while none of ours is there;
// `replaced` is the link text we replaced or removed, or null. An existing record keeps its `replaced`.
export function recordLink(entry, path, target, replaced = null) {
  const rec = entry.links.find((l) => l.path === path);
  if (rec) {
    rec.target = target;
    if (rec.replaced === null || rec.replaced === undefined) rec.replaced = replaced;
    return;
  }
  entry.links.push({ path, target, replaced });
}

// Our link at `path` is gone: a record that restores something is kept with target null, any other is dropped.
export function forgetLink(entry, path) {
  const i = entry.links.findIndex((l) => l.path === path);
  if (i === -1) return;
  if (entry.links[i].replaced) entry.links[i].target = null;
  else entry.links.splice(i, 1);
}

// A file record { path, sha256, backup }: `sha256` of what we wrote (null while none of ours is there), `backup` of
// the file we replaced first, or null. An existing record keeps its backup.
export function recordFile(entry, path, sha256, backup = null) {
  const rec = entry.files.find((f) => f.path === path);
  if (rec) {
    rec.sha256 = sha256;
    if (!rec.backup) rec.backup = backup;
    return;
  }
  entry.files.push({ path, sha256, backup });
}

export function forgetFile(entry, path) {
  const i = entry.files.findIndex((f) => f.path === path);
  if (i === -1) return;
  if (entry.files[i].backup) entry.files[i].sha256 = null;
  else entry.files.splice(i, 1);
}

// A config record { key, table, was, createdTable, wrote }: the first edit of a key keeps its prior value, and `wrote`
// the value text sync put there (the revert acts only while the key still holds it; an older record has none).
export function recordConfig(entry, { key, table, was, createdTable, wrote }) {
  if (entry.config.some((c) => c.key === key && c.table === table)) return;
  entry.config.push({ key, table, was, createdTable, wrote });
}

// A plugin record, keyed by `id` (Codex) or `name` (Grok) plus `action`; a newer one replaces it.
export function recordPlugin(entry, rec) {
  const key = rec.id ?? rec.name;
  const i = entry.plugins.findIndex((p) => (p.id ?? p.name) === key && p.action === rec.action);
  if (i === -1) entry.plugins.push(rec);
  else entry.plugins[i] = rec;
}
