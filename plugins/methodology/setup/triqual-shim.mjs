#!/usr/bin/env node
// The `triqual` shim.
// Bootstrap copies this file, alone and verbatim, to ~/.local/bin/triqual.mjs (with ~/.local/bin/triqual a relative
// symlink to it), so it imports only node: built-ins; ~/.local/bin/cm.mjs is the deprecated alias that runs it. It
// finds each plugin's installPath in ~/.claude/plugins/installed_plugins.json (never the newest cache directory: old
// versions linger there), picks the entry that applies to the cwd with Claude Code's scope precedence (local, then
// project, then user), and runs that plugin's cli/ script (bin/ in a plugin installed before the move).
// `triqual`, `triqual help`, `triqual --help` and `triqual -h` print every command's description with its installed
// `--help` beneath (0); `triqual help <command>`, `triqual --help <command>` and `triqual -h <command>` run
// `triqual <command> --help`. A command that does not resolve is marked, and `triqual <command>` explains, per command:
// not released yet (neither the install nor the installed marketplace copy has it), not installed, update <plugin> to
// get it (the marketplace copy has the file the install lacks), or not in the installed <plugin> <version> (the
// marketplace copy cannot be read).
// Exit codes: the child's code; 3 when the command does not resolve, or --help would go to an install not known to
// handle it (per command, HELP_SINCE); 1 for an unknown command.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The marketplace names, as literals: this file is copied alone and imports only node: built-ins, so it keeps its own
// copy of the plugin id rule in plugins/methodology/cli/lib/brand.mjs.
const MARKETPLACE = 'triqual';
const LEGACY_MARKETPLACE = 'claude-methodology';

export const COMMANDS = {
  tasks: ['progress-tracking', 'cli/tasks.mjs'],
  'progress-init': ['progress-tracking', 'cli/progress-init.mjs'],
  suggest: ['methodology', 'cli/suggest.mjs'],
  doctor: ['methodology', 'cli/doctor.mjs'],
  sync: ['methodology', 'cli/sync.mjs'],
  ui: ['progress-tracking', 'cli/ui.mjs'],
  tracking: ['progress-tracking', 'cli/tracking.mjs'],
  hook: ['methodology', 'cli/hook.mjs'],
  memory: ['memory-report', 'cli/memory.mjs'],
  'role-eval': ['methodology', 'cli/role-eval.mjs'],
  migrate: ['methodology', 'cli/migrate.mjs'],
  cost: ['methodology', 'cli/cost.mjs'],
};

// One line per command for the help; kept apart from COMMANDS, whose shape tests pin.
export const DESCRIPTIONS = {
  tasks: 'task ledger: move plan tasks, check drift, status, status-line segment',
  'progress-init': 'opt the current repo into strict progress tracking (--local for shared repos)',
  suggest: 'suggest vault skills for a request (through headjack)',
  doctor: "diagnose the install (--repo: this repo's tracking)",
  sync: "write the installed rules into ~/.claude/CLAUDE.md's managed section",
  ui: 'local read-only tracking dashboard',
  tracking: 'write a tracking file (entry, status, spec, plan) from a draft; the way to write them in local mode',
  hook: 'run a methodology hook for another harness (Codex, Grok)',
  memory: 'weekly local claude-mem memory report and its allowlist',
  'role-eval': 'record hunter results and summarize the store',
  migrate: 'move this machine from claude-methodology to triqual',
  cost: 'estimated token spend per model from the Claude Code transcripts, controller vs subagents',
};

const HELP_FLAGS = new Set(['help', '--help', '-h']);
// Per command: the first version of its plugin whose command accepts --help. Older installs ignore it (sync 0.1.1 ran
// and wrote ~/.claude/CLAUDE.md), so the shim passes --help only to a command listed here whose plugin is at that
// version or later: an unlisted command or an unreadable version gets none. `tracking` shipped in progress-tracking
// 0.2.2; `hook` in methodology 0.3.0; `migrate` in methodology 0.4.0; `suggest` in methodology 1.0.0; `cost` in methodology 1.0.1.
const HELP_SINCE = {
  tasks: '0.2.1',
  'progress-init': '0.2.1',
  ui: '0.2.1',
  tracking: '0.2.2',
  doctor: '0.1.2',
  sync: '0.1.2',
  hook: '0.3.0',
  memory: '0.1.0',
  'role-eval': '0.3.3',
  migrate: '0.4.0',
  suggest: '1.0.0',
  cost: '1.0.1',
};
const HELP_TIMEOUT_MS = 5000;
export const HELP_BUDGET_MS = 8000; // the whole aggregated help; commands left after it show their description only
const FOOTER = 'Run "triqual help <command>" (or "triqual <command> --help") for one command.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// True when cwd is projectPath or lies below it; "/a/bc" is not below "/a/b".
function within(cwd, projectPath) {
  const c = resolve(cwd);
  const p = resolve(projectPath);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

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

function readPluginsJson(home, file) {
  try {
    return JSON.parse(readFileSync(join(home, '.claude', 'plugins', file), 'utf8'));
  } catch {
    return null;
  }
}

const loadInstalled = (home) => readPluginsJson(home, 'installed_plugins.json');

// The marketplace known to Claude Code: triqual, then the legacy one, then triqual when neither is known.
function activeMarketplace(home) {
  const known = readPluginsJson(home, 'known_marketplaces.json');
  if (isObject(known) && Object.hasOwn(known, MARKETPLACE)) return MARKETPLACE;
  if (isObject(known) && Object.hasOwn(known, LEGACY_MARKETPLACE)) return LEGACY_MARKETPLACE;
  return MARKETPLACE;
}

// The id of plugin `name` as installed: the new id at user scope, the legacy id at user scope, then either one at any
// scope (new first), else under the known marketplace. A local- or project-scope install never hides a user one.
function pluginId(home, name) {
  const installed = loadInstalled(home);
  const ids = isObject(installed) && isObject(installed.plugins) ? installed.plugins : {};
  const candidates = [MARKETPLACE, LEGACY_MARKETPLACE].map((marketplace) => `${name}@${marketplace}`);
  const atUser = (id) => Array.isArray(ids[id]) && ids[id].some((e) => isObject(e) && e.scope === 'user');
  return candidates.find((id) => Object.hasOwn(ids, id) && atUser(id))
    ?? candidates.find((id) => Object.hasOwn(ids, id))
    ?? `${name}@${activeMarketplace(home)}`;
}

// The installed copy of the active marketplace (known_marketplaces.json installLocation, then its
// .claude-plugin/marketplace.json): its location and each listed plugin's source (null when not a local path), or
// null when either file cannot be read.
function marketplaceCopy(home) {
  try {
    const known = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    const location = known?.[activeMarketplace(home)]?.installLocation;
    if (typeof location !== 'string' || location === '') return null;
    const manifest = JSON.parse(readFileSync(join(location, '.claude-plugin', 'marketplace.json'), 'utf8'));
    if (!Array.isArray(manifest?.plugins)) return null;
    const sources = new Map(manifest.plugins.filter(isObject).map((p) => [p.name, typeof p.source === 'string' ? p.source : null]));
    return { location, sources };
  } catch {
    return null;
  }
}

// The command file, or why it does not resolve: `status` (unreleased | not-installed | update | unknown), its help
// `marker` and the `error` that `triqual <command>` prints. Installing or updating is suggested only when it can help.
export function resolveCommand({ home, cwd, cmd }) {
  if (!Object.hasOwn(COMMANDS, cmd)) return { error: `triqual: unknown command "${cmd}"` };
  const [plugin, rel] = COMMANDS[cmd];
  const id = pluginId(home, plugin);
  const copy = marketplaceCopy(home);
  const listed = copy ? copy.sources.has(plugin) : null; // null: the copy cannot be read
  const unreleased = (error) => ({ error, status: 'unreleased', marker: '(not released yet)' });
  const installPath = resolveInstallPath(loadInstalled(home), id, cwd);
  if (installPath === null) {
    if (listed === false) return unreleased(`triqual ${cmd}: requires ${id}, which is not released yet`);
    return {
      error: `triqual ${cmd} requires ${id}, which is not installed. Install it with: claude plugin install ${id} --scope user`,
      status: 'not-installed',
      marker: '(not installed)',
    };
  }
  // A plugin installed before its scripts moved from bin/ to cli/ still has them under bin/.
  const legacy = join(installPath, rel.replace(/^cli\//, 'bin/'));
  const file = existsSync(join(installPath, rel)) || !existsSync(legacy) ? join(installPath, rel) : legacy;
  if (!existsSync(file)) {
    if (listed === false) return unreleased(`triqual ${cmd}: requires ${id}, which is not released yet`);
    if (listed === null) {
      const version = installedVersion(installPath);
      const named = version ? `${plugin} ${version}` : plugin;
      return {
        error: `triqual ${cmd}: the installed version of ${plugin}${version ? ` (${version})` : ''} lacks ${rel} (${installPath}), and `
          + 'the marketplace copy cannot be read to tell whether a newer version has it',
        status: 'unknown',
        marker: `(not in the installed ${named})`,
      };
    }
    const source = copy.sources.get(plugin);
    if (source === null || (!existsSync(join(copy.location, source, rel)) && !existsSync(join(copy.location, source, rel.replace(/^cli\//, 'bin/'))))) {
      return unreleased(`triqual ${cmd}: not released yet: the ${plugin} release lacks ${rel}`);
    }
    return {
      error: `triqual ${cmd}: the installed version of ${plugin} lacks ${rel} (${installPath}). Update it with: claude plugin update ${id}`,
      status: 'update',
      marker: `(update ${plugin} to get it)`,
    };
  }
  return { file, installPath };
}

const semver = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v) ? v.split(/[-+]/)[0].split('.').map(Number) : null);

function installedVersion(installPath) {
  try {
    return JSON.parse(readFileSync(join(installPath, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// True when `cmd`, from the plugin installed at installPath, is known to handle --help: listed in HELP_SINCE, with a
// readable plugin version at least that one. Fails closed.
export function acceptsHelp(cmd, installPath) {
  if (!Object.hasOwn(HELP_SINCE, cmd)) return false;
  const have = semver(installedVersion(installPath));
  const need = semver(HELP_SINCE[cmd]);
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

// A resolved command's own `--help` output, or null when it fails, prints nothing or outlives timeoutMs.
function installedUsage(file, cwd, timeoutMs) {
  const r = spawnSync(process.execPath, [file, '--help'], {
    cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') return null;
  return r.stdout;
}

// The full help: each command's description, then its installed `--help` indented beneath; a command that does not
// resolve gets its marker instead, and one whose `--help` is not forwarded, fails, times out or comes after the
// budget is spent gets its description only. usage: false spawns nothing (descriptions and markers only).
export function helpText({ home, cwd, timeoutMs = HELP_TIMEOUT_MS, budgetMs = HELP_BUDGET_MS, usage: withUsage = true }) {
  const deadline = Date.now() + budgetMs;
  const rows = Object.keys(COMMANDS).map((cmd) => {
    const r = resolveCommand({ home, cwd, cmd });
    const row = `  ${cmd.padEnd(14)} ${DESCRIPTIONS[cmd]}${r.marker ? ` ${r.marker}` : ''}`;
    const left = Math.min(timeoutMs, deadline - Date.now());
    const forward = withUsage && r.file && left > 0 && acceptsHelp(cmd, r.installPath);
    const usage = forward ? installedUsage(r.file, cwd, left) : null;
    if (usage === null) return row;
    return [row, ...usage.trimEnd().split('\n').map((l) => (l ? `      ${l}` : ''))].join('\n');
  });
  return `usage: triqual <command> [args...]\n       triqual help <command>\n\ncommands:\n${rows.join('\n')}\n\n${FOOTER}\n`;
}

function main(argv) {
  const home = homedir();
  const cwd = process.cwd();
  let [cmd, ...args] = argv;
  if (cmd === undefined || HELP_FLAGS.has(cmd)) {
    if (args.length === 0 || HELP_FLAGS.has(args[0])) { // `triqual help help`, `triqual --help --help`: the general help
      process.stdout.write(helpText({ home, cwd }));
      process.exit(0);
    }
    [cmd, args] = [args[0], ['--help']]; // `triqual help <command>` is `triqual <command> --help`
  }
  if (!Object.hasOwn(COMMANDS, cmd)) {
    process.stderr.write(`triqual: unknown command "${cmd}"\n${helpText({ home, cwd, usage: false })}`);
    process.exit(1);
  }
  const r = resolveCommand({ home, cwd, cmd });
  if (r.error) {
    process.stderr.write(`${r.error}\n`);
    process.exit(3);
  }
  const plugin = COMMANDS[cmd][0];
  if ((args.includes('--help') || args.includes('-h')) && !acceptsHelp(cmd, r.installPath)) {
    const version = installedVersion(r.installPath);
    let why;
    if (!Object.hasOwn(HELP_SINCE, cmd)) why = `${plugin} is not known to handle --help, so it is not passed on`;
    else if (!semver(version)) why = `the installed ${plugin}'s version cannot be read, so --help is not passed on`;
    else {
      why = `--help is passed on only to ${plugin} ${HELP_SINCE[cmd]} or later (installed: ${version}): `
        + `update it with: claude plugin update ${pluginId(home, plugin)}`;
    }
    process.stderr.write(`triqual ${cmd}: ${why}\n`);
    process.exit(3);
  }
  const child = spawnSync(process.execPath, [r.file, ...args], { stdio: 'inherit' });
  if (child.error) {
    process.stderr.write(`triqual ${cmd}: ${child.error.message}\n`);
    process.exit(1);
  }
  if (child.signal) process.kill(process.pid, child.signal);
  process.exit(child.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}
