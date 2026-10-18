// Where the installed methodology plugin lives, read the way bootstrap and the shim read it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKETPLACE = 'triqual';
// The marketplace's previous name (plugins/methodology/cli/lib/brand.mjs, BRAND.legacy.marketplace).
export const LEGACY_MARKETPLACE = 'claude-methodology';

const PLUGIN_ID = `methodology@${MARKETPLACE}`;
const pluginsDir = (home) => join(home, '.claude', 'plugins');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The user-scope installPath of methodology@triqual in installed_plugins.json; null when the file is missing or
// malformed or holds no such entry.
export function installPathOf(home) {
  let installed;
  try {
    installed = JSON.parse(readFileSync(join(pluginsDir(home), 'installed_plugins.json'), 'utf8'));
  } catch {
    return null;
  }
  const entries = isObject(installed) && isObject(installed.plugins) ? installed.plugins[PLUGIN_ID] : null;
  if (!Array.isArray(entries)) return null;
  const user = entries.find((e) => isObject(e) && e.scope === 'user' && typeof e.installPath === 'string' && e.installPath !== '');
  return user ? user.installPath : null;
}

// The highest major.minor.patch directory of the methodology plugin cache, compared numerically; null when none.
export function newestCacheDir(home) {
  const dir = join(pluginsDir(home), 'cache', MARKETPLACE, 'methodology');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const versions = names.filter((n) => /^\d+\.\d+\.\d+$/.test(n)).map((n) => ({ n, parts: n.split('.').map(Number) }));
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return join(dir, versions[0].n);
}
