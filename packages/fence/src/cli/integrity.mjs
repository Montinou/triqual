// The post-hatch integrity manifest `fence hatch` writes (spec, CLI `hatch`; the watchdog compares
// it after the hatch, src/watchdog/integrity.mjs).
//
//   buildManifest(home, paths = fencePaths(home), {created, expires, repoRoots?, platform?,
//                 claudeManaged?, codexManaged?, fs?}) -> Manifest
//   manifestText(manifest) -> string   (the bytes written to integrity.json; one JSON line)
//   manifestSources(home, paths, {platform?, claudeManaged?, codexManaged?, fs?}) -> {files, hookKeys}
//
// A bounded manifest of what can switch fence off, every path RESOLVED to its real path (symlinks
// followed, also through a dangling link; the watchdog treats a symlinked listed path as
// unreadable, so a dotfile-managed ~/.claude/settings.json is recorded at its target):
//   files (sha256 of the bytes, or ABSENT for a listed file that does not exist yet):
//     the policy; the watchdog bundle (~/.local/share/fence/fence-hook.mjs) and its trampoline
//     (~/.local/bin/fence-hook); the CLI shim module (~/.local/share/fence/fence-cli.mjs) and its
//     trampoline (~/.local/bin/fence); `current`; every regular file of versions/<current>/ (a
//     precomputed list); ~/.codex/hooks.json, ~/.codex/requirements.toml and the Codex managed
//     requirements; the rc files; and, in the plugin, skill and mod directories (~/.claude/plugins,
//     ~/.codex/plugins, ~/.claude/skills, ~/.claude/dev-mods, ~/.agents), only the manifest and hook
//     files: plugin.json, hooks.json, SKILL.md, every file under a `hooks/` directory, and mod entry
//     files (MOD_ENTRY, within MOD_DEPTH levels of ~/.claude/dev-mods). Both plugins' hooks.json
//     are among these (the Claude plugin cache and the Codex plugin directory).
//   hookKeys: the hook-related keys (CLAUDE_HOOK_KEYS) of ~/.claude/settings.json,
//     ~/.claude/settings.local.json and the Claude managed settings; CODEX_HOOK_KEYS of
//     ~/.codex/config.toml (its [projects] trust records are not part of it).
// Excluded: fence's own state directory and ~/.claude/shell-snapshots (never walked, and a real
// path under either is dropped), and node_modules/.git directories inside the walked trees.
// A listed file that exists but cannot be hashed (not a regular file, over 16 MiB, unreadable) or a
// settings file that does not parse throws: a manifest that could never compare equal is not written.
//
// `claudeManaged` / `codexManaged` replace the platform's managed paths (tests pass []).

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { fencePaths } from './paths.mjs';
import { ABSENT, CLAUDE_HOOK_KEYS, CODEX_HOOK_KEYS, MANIFEST_VERSION, hookKeyHashes, parseIso, readBounded, sha256 } from '../watchdog/integrity.mjs';

export const CLAUDE_MANAGED = Object.freeze({
  darwin: Object.freeze(['/Library/Application Support/ClaudeCode/managed-settings.json']),
  linux: Object.freeze(['/etc/claude-code/managed-settings.json']),
});
export const CODEX_MANAGED = Object.freeze(['/etc/codex/requirements.toml']);
export const RC_FILES = Object.freeze(['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']);
const MANIFEST_NAMES = new Set(['plugin.json', 'hooks.json', 'SKILL.md']);
export const MOD_ENTRY = /^(?:mod\.json|manifest\.json|package\.json|(?:index|main)\.(?:m|c)?js|index\.ts)$/;
const MOD_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_WALK_ENTRIES = 200_000;
const MAX_ENGINE_FILES = 20_000;
const MAX_LINKS = 40;

const errText = (err) => (err instanceof Error ? err.message : String(err));
const under = (dir, p) => p === dir || p.startsWith(dir + nodePath.sep);

/** The real path of `p`: realpath when it resolves; else its dangling link's target, else its real parent + name. */
export function realPathOf(p, fsImpl = nodeFs, depth = 0) {
  try {
    return fsImpl.realpathSync.native(p);
  } catch {
    // missing (or a dangling link): resolved below
  }
  if (depth > MAX_LINKS) return p;
  try {
    if (fsImpl.lstatSync(p).isSymbolicLink()) {
      const target = fsImpl.readlinkSync(p);
      return realPathOf(nodePath.resolve(nodePath.dirname(p), target), fsImpl, depth + 1);
    }
  } catch {
    // nothing there
  }
  const parent = nodePath.dirname(p);
  if (parent === p) return p;
  return nodePath.join(realPathOf(parent, fsImpl, depth + 1), nodePath.basename(p));
}

// sha256 of a listed file, ABSENT when it does not exist; throws when it cannot be hashed.
function fileHash(real, fsImpl) {
  const read = readBounded(real, fsImpl, () => false);
  if (read.kind === 'missing') return ABSENT;
  if (read.kind) throw new Error(`${real} cannot be hashed (${read.kind}: not a regular file, over 16 MiB or not readable)`);
  return sha256(read.bytes);
}

function keyHashes(real, keys, fsImpl) {
  const read = readBounded(real, fsImpl, () => false);
  if (read.kind === 'missing') return Object.fromEntries(keys.map((k) => [k, ABSENT]));
  if (read.kind) throw new Error(`${real} cannot be read (${read.kind})`);
  const hashes = hookKeyHashes(real, read.bytes, keys);
  if (hashes === null) throw new Error(`${real} does not parse as a settings file`);
  return hashes;
}

// The regular files of a tree (symlinked directories followed once by real path), filtered.
function walk(root, keep, excluded, fsImpl, budget) {
  const out = [];
  const seen = new Set();
  const visit = (dir, rel) => {
    let real;
    try {
      real = fsImpl.realpathSync.native(dir);
    } catch {
      return;
    }
    if (seen.has(real) || excluded(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = fsImpl.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++budget.n > MAX_WALK_ENTRIES) throw new Error(`more than ${MAX_WALK_ENTRIES} entries under the plugin, skill and mod directories`);
      const p = nodePath.join(real, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fsImpl.statSync(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          isDir = false;
          isFile = false;
        }
      }
      if (isDir) {
        if (!SKIP_DIRS.has(e.name)) visit(p, [...rel, e.name]);
      } else if (isFile && keep(e.name, rel)) {
        out.push(p);
      }
    }
  };
  visit(root, []);
  return out;
}

const managedFor = (table, platform) => (Array.isArray(table) ? table : (table[platform] ?? []));

/** The paths the manifest covers, resolved: {files: string[], hookKeys: {path: keys[]}}. */
export function manifestSources(home, paths = fencePaths(home), { platform = process.platform, claudeManaged, codexManaged, fs: fsImpl = nodeFs } = {}) {
  const h = paths.home ?? home;
  const real = (p) => realPathOf(p, fsImpl);
  const excludedDirs = [paths.stateDir, nodePath.join(h, '.claude', 'shell-snapshots')].flatMap((d) => [d, real(d)]);
  const excluded = (p) => excludedDirs.some((d) => under(d, p));

  const files = new Set();
  const add = (p) => {
    const r = real(p);
    if (!excluded(r)) files.add(r);
  };
  for (const p of [paths.policy, paths.watchdogBundle, paths.watchdog, paths.shimModule, paths.shim, paths.current]) add(p);

  // the engine directory of `current`
  let version = null;
  try {
    version = fsImpl.readFileSync(paths.current, 'utf8').replace(/\r?\n$/, '');
  } catch {
    version = null;
  }
  if (version !== null && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
    const engine = walk(nodePath.join(paths.versionsDir, version), () => true, excluded, fsImpl, { n: 0 });
    if (engine.length > MAX_ENGINE_FILES) throw new Error(`the engine directory of ${version} has more than ${MAX_ENGINE_FILES} files`);
    for (const f of engine) add(f);
  }

  for (const p of [nodePath.join(h, '.codex', 'hooks.json'), nodePath.join(h, '.codex', 'requirements.toml'), ...(codexManaged ?? managedFor(CODEX_MANAGED, platform))]) add(p);
  for (const rc of RC_FILES) add(nodePath.join(h, rc));

  // plugin, skill and mod directories: manifest and hook files only
  const budget = { n: 0 };
  const hookFile = (name, rel) => MANIFEST_NAMES.has(name) || rel.includes('hooks');
  const roots = [
    [nodePath.join(h, '.claude', 'plugins'), hookFile],
    [nodePath.join(h, '.codex', 'plugins'), hookFile],
    [nodePath.join(h, '.claude', 'skills'), hookFile],
    [nodePath.join(h, '.agents'), hookFile],
    [nodePath.join(h, '.claude', 'dev-mods'), (name, rel) => hookFile(name, rel) || (rel.length <= MOD_DEPTH && MOD_ENTRY.test(name))],
  ];
  for (const [root, keep] of roots) for (const f of walk(root, keep, excluded, fsImpl, budget)) add(f);

  const hookKeys = {};
  for (const p of [nodePath.join(h, '.claude', 'settings.json'), nodePath.join(h, '.claude', 'settings.local.json'), ...(claudeManaged ?? managedFor(CLAUDE_MANAGED, platform))]) {
    hookKeys[real(p)] = [...CLAUDE_HOOK_KEYS];
  }
  hookKeys[real(nodePath.join(h, '.codex', 'config.toml'))] = [...CODEX_HOOK_KEYS];
  return { files: [...files].sort(), hookKeys };
}

export function buildManifest(home, paths = fencePaths(home), { created, expires, repoRoots = [], ...opts } = {}) {
  if (!Number.isFinite(parseIso(created)) || !Number.isFinite(parseIso(expires))) {
    throw new Error('buildManifest: created and expires must be ISO timestamps');
  }
  const fsImpl = opts.fs ?? nodeFs;
  const src = manifestSources(home, paths, opts);
  const files = {};
  for (const f of src.files) {
    try {
      files[f] = fileHash(f, fsImpl);
    } catch (err) {
      throw new Error(`the integrity manifest cannot be built: ${errText(err)}`);
    }
  }
  const hookKeys = {};
  for (const [p, keys] of Object.entries(src.hookKeys).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      hookKeys[p] = keyHashes(p, keys, fsImpl);
    } catch (err) {
      throw new Error(`the integrity manifest cannot be built: ${errText(err)}`);
    }
  }
  const roots = [...new Set(repoRoots.filter((r) => typeof r === 'string' && nodePath.isAbsolute(r)).map((r) => realPathOf(r, fsImpl)))].sort();
  return { version: MANIFEST_VERSION, created, expires, files, hookKeys, repoRoots: roots };
}

export const manifestText = (manifest) => `${JSON.stringify(manifest)}\n`;
