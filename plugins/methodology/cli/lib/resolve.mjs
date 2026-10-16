// Where a triqual plugin is installed for a cwd, and whether Claude has it enabled (spec Addendum F.3).
// resolveInstallPath is a copy of setup/triqual-shim.mjs's export: the shim ships in the plugin's setup/ but runs as a
// copy in ~/.local/bin, outside cli/, so the hook does not import it. A parity test keeps the two equal. node: built-ins
// only.
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// True when cwd is projectPath or lies below it; "/a/bc" is not below "/a/b".
function within(cwd, projectPath) {
  const c = resolve(cwd);
  const p = resolve(projectPath);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

// The installPath of the entry that applies to the cwd, with Claude Code's scope precedence: local, then project (the
// deepest matching projectPath of each), then user. null when none applies or the input is malformed.
export function resolveInstallPath(installed, pluginId, cwd) {
  if (!isObject(installed) || !isObject(installed.plugins)) return null;
  const entries = installed.plugins[pluginId];
  if (!Array.isArray(entries)) return null;
  const usable = entries.filter((e) => isObject(e) && typeof e.installPath === 'string' && e.installPath !== '');
  for (const scope of ['local', 'project']) {
    // The deepest matching projectPath is the one that applies to the cwd.
    const match = usable
      .filter((e) => e.scope === scope && typeof e.projectPath === 'string' && within(cwd, e.projectPath))
      .sort((a, b) => resolve(b.projectPath).length - resolve(a.projectPath).length)[0];
    if (match) return match.installPath;
  }
  return usable.find((e) => e.scope === 'user')?.installPath ?? null;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The plugin's installPath for the cwd, from <home>/.claude/plugins/installed_plugins.json; null when that file
// cannot be read or nothing applies.
export function resolvePlugin(home, pluginId, cwd) {
  try {
    return resolveInstallPath(readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')), pluginId, cwd);
  } catch {
    return null;
  }
}

// True only when enabledPlugins[pluginId] is exactly true in <home>/.claude/settings.json (user scope). Any read or
// parse error reads as disabled.
export function enabledInClaude(home, pluginId) {
  try {
    const enabled = readJson(join(home, '.claude', 'settings.json'))?.enabledPlugins;
    return isObject(enabled) && enabled[pluginId] === true;
  } catch {
    return false;
  }
}
