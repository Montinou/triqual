// Safe edits of a settings.json: parse, mutate a deep clone, and write atomically only when something changed,
// after a backup (at most one per backupDir, so the backup always holds the pre-run original). Also the supersedes
// matching and the machine config that sync, drift and doctor share.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { brandDir } from './brand.mjs';
import { backupFile, writeAtomic } from './fsx.mjs';
import { HARNESS_IDS } from './harnesses.mjs';

export function editSettings(path, mutate, { backupDir }) {
  const raw = readFileSync(path, 'utf8');
  let original;
  try {
    original = JSON.parse(raw);
  } catch {
    throw new Error(`settings.json is not valid JSON: ${path}`);
  }
  const obj = structuredClone(original);
  mutate(obj);
  if (isDeepStrictEqual(obj, original)) return { changed: false };
  backupFile(path, backupDir);
  writeAtomic(path, JSON.stringify(obj, null, 2) + '\n');
  return { changed: true };
}

// Every id enabled (true) in enabledPlugins that matches a pattern, in enabledPlugins' order. `<name>@*` matches
// `<name>@<any marketplace>`; any other pattern matches exactly. Non-string patterns, or a non-array list, match
// nothing.
export function supersededEnabled(patterns, enabledPlugins) {
  if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) return [];
  const valid = Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string') : [];
  const matches = (id) => valid.some((p) => (p.endsWith('@*') ? id.startsWith(p.slice(0, -1)) : id === p));
  return Object.entries(enabledPlugins).filter(([id, on]) => on === true && matches(id)).map(([id]) => id);
}

// <home>/.config/triqual/config.json, or under the legacy dir until migration.
export const configPath = (home) => join(brandDir(join(home, '.config')), 'config.json');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The machine config's methodology settings: keepSuperseded, and `harnesses` (the recorded `{ <id>: { enabled } }`
// map, `{}` when absent or not an object). A missing file gives the defaults; an unreadable, invalid or non-object
// file gives the defaults plus `error`. Never throws.
export function readMethodologyConfig(home) {
  const path = configPath(home);
  const defaults = { keepSuperseded: false, harnesses: {} };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...defaults, error: null };
    return { ...defaults, error: `cannot read ${path}: ${err.message}` };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { ...defaults, error: `${path} is not valid JSON` };
  }
  if (!isObject(config)) return { ...defaults, error: `${path} is not a JSON object` };
  return {
    keepSuperseded: config.keepSuperseded === true,
    harnesses: isObject(config.harnesses) ? config.harnesses : {},
    error: null,
  };
}

// Sets harnesses.<id>.enabled in config.json, keeping every other key, and writes it atomically (the file and its
// dir are created when missing). Throws, writing nothing, for an unknown id or a config.json that cannot be read.
export function setHarnessEnabled(home, id, enabled) {
  if (!HARNESS_IDS.includes(id)) throw new Error(`unknown harness: ${id}`);
  const path = configPath(home);
  let config = {};
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${path}: ${err.message}`);
  }
  if (text !== null) {
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    if (!isObject(config)) throw new Error(`${path} is not a JSON object`);
  }
  const harnesses = isObject(config.harnesses) ? config.harnesses : {};
  const entry = { ...(isObject(harnesses[id]) ? harnesses[id] : {}), enabled: enabled === true };
  const next = { ...config, harnesses: { ...harnesses, [id]: entry } };
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}
