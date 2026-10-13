// Test fixtures for `triqual migrate` and bootstrap: a temp HOME laid out like a machine on the legacy marketplace,
// and a fake `run` that answers the claude, codex and grok calls against that HOME's files the way the real CLIs do.
// The claude answers follow the T8 probe of Claude Code 2.1.296 (progress.md, `Plan triqual-rename · T8`):
//   - `plugin marketplace add` names the entry from the remote manifest (`manifestName`), and exits 1 (`declared`)
//     with no change while that name is already known;
//   - installing methodology also installs its dependencies, recorded with `auto: true`;
//   - a fresh install is enabled; uninstall deletes the id's enabledPlugins key, and its data dir unless --keep-data;
//     an id not installed at that scope exits 1 (`not_installed`);
//   - `plugin marketplace remove` cascades (uninstalls what is left, data included), deletes the known entry, the
//     extraKnownMarketplaces key and the clone; a name not known exits 1 (`not_configured`).
// Codex keeps its state in config.toml (`[marketplaces.<name>]`, `[plugins."<id>"]`), Grok lists no plugin, and the
// `--version` of codex and grok exits 127, so a harness is present only through its dir.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../../bin/lib/brand.mjs';
import { expectedRules } from '../../bin/lib/harnesses.mjs';
import { removeTable } from '../../bin/lib/toml-edit.mjs';

const L = BRAND.legacy;
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
export const GLOBAL = readFileSync(join(PLUGIN_ROOT, 'rules', 'global.md'), 'utf8');
export const ALL_PLUGINS = ['methodology', 'progress-tracking', 'workflow-gate', 'roles', 'memory-report'];
const manifestOf = (name) => JSON.parse(readFileSync(join(REPO_ROOT, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8'));
export const VERSIONS = Object.fromEntries(ALL_PLUGINS.map((name) => [name, manifestOf(name).version]));
const DEPENDENCIES = manifestOf('methodology').dependencies;
export const BRIDGE_NAME = 'methodology-codex';
export const LEGACY_SOURCE = `Montinou/${L.dir}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sha = (text) => createHash('sha256').update(text).digest('hex');

export function put(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`,
    mode === undefined ? undefined : { mode });
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const pluginsDir = (home) => join(home, '.claude', 'plugins');
export const installedFile = (home) => join(pluginsDir(home), 'installed_plugins.json');
export const knownFile = (home) => join(pluginsDir(home), 'known_marketplaces.json');
export const settingsFile = (home) => join(home, '.claude', 'settings.json');
export const cloneDir = (home, market) => join(pluginsDir(home), 'marketplaces', market);
export const cachePath = (home, market, name) => join(pluginsDir(home), 'cache', market, name, VERSIONS[name]);
export const dataDir = (home, name, market) => join(pluginsDir(home), 'data', `${name}-${market}`);
export const codexConfigFile = (home) => join(home, '.codex', 'config.toml');
export const legacyGrokFiles = (home) => [
  join(home, '.grok', 'hooks', `${L.grokName}.json`), join(home, '.grok', 'rules', `${L.grokName}.md`),
];

// The settings file a scope's enabledPlugins live in.
export const scopeSettings = (home, scope, projectPath) => (scope === 'user' ? settingsFile(home)
  : join(projectPath, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json'));

function editJson(path, mutate) {
  const value = readJson(path) ?? {};
  mutate(value);
  put(path, value);
}

// An install dir holding what migrate, sync and doctor read: methodology's rules and one skill, roles' agents,
// progress-tracking's gate template and skill.
function materialize(dir, name) {
  mkdirSync(dir, { recursive: true });
  if (name === 'methodology') {
    cpSync(join(PLUGIN_ROOT, 'rules'), join(dir, 'rules'), { recursive: true });
    put(join(dir, 'skills', 'using-methodology', 'SKILL.md'), '---\nname: using-methodology\n---\n');
  }
  if (name === 'roles') cpSync(join(REPO_ROOT, 'plugins', 'roles', 'agents'), join(dir, 'agents'), { recursive: true });
  if (name === 'progress-tracking') {
    cpSync(join(REPO_ROOT, 'plugins', 'progress-tracking', 'templates'), join(dir, 'templates'), { recursive: true });
    put(join(dir, 'skills', 'progress-tracking', 'SKILL.md'), '---\nname: progress-tracking\n---\n');
  }
}

// The clone of marketplace `name` with its manifest listing every plugin at VERSIONS.
function writeClone(home, name) {
  put(join(cloneDir(home, name), '.claude-plugin', 'marketplace.json'), {
    name, plugins: ALL_PLUGINS.map((p) => ({ name: p, source: `./plugins/${p}`, version: VERSIONS[p] })),
  });
}

const knownEntry = (home, name, repo) => ({
  source: { source: 'github', repo }, installLocation: cloneDir(home, name), lastUpdated: '2026-10-01T00:00:00.000Z',
});

// A HOME on the legacy marketplace, built like this machine before migration:
// - `plugins` installed at user scope under the legacy marketplace (workflow-gate and roles as methodology's
//   dependencies), enabled except `disabled`; `extra` adds more entries ({ id, scope, projectPath });
// - the legacy marketplace known, with its clone, in known_marketplaces.json and extraKnownMarketplaces;
// - the `Bash(cm tracking write:*)` allow rule; ~/.claude/CLAUDE.md with the current rules under the legacy markers;
// - the legacy config, state and data dirs (config.json, repos.json with `repo` registered on the cm gate);
// - the older full shim at the legacy CLI file behind its link, and the older launcher; a legacy plugin data dir;
// - `codex`: ~/.codex with the legacy Codex marketplace and bridge tables, a legacy trust table, an AGENTS.md with the
//   codex rules under the legacy markers, and its harnesses.json records under the legacy ids;
// - `grok`: the legacy Grok files, recorded in harnesses.json when `grokRecorded` (one with a pre-sync backup).
export function legacyMachine(home, {
  plugins = ALL_PLUGINS, disabled = ['memory-report'], extra = [], codex = false, grok = false, grokRecorded = grok,
  repo = true,
} = {}) {
  const market = L.marketplace;
  const installed = {};
  const enabled = {};
  for (const name of plugins) {
    const id = `${name}@${market}`;
    const auto = ['workflow-gate', 'roles'].includes(name) ? { auto: true } : {};
    const installPath = cachePath(home, market, name);
    materialize(installPath, name);
    installed[id] = [{ scope: 'user', installPath, version: VERSIONS[name], ...auto }];
    enabled[id] = !disabled.includes(name);
  }
  for (const { id, scope, projectPath } of extra) {
    const name = id.split('@')[0];
    const installPath = cachePath(home, market, name);
    materialize(installPath, name);
    (installed[id] ??= []).push({ scope, installPath, version: VERSIONS[name], projectPath });
    editJson(scopeSettings(home, scope, projectPath), (s) => { s.enabledPlugins = { ...s.enabledPlugins, [id]: true }; });
  }
  put(installedFile(home), { version: 2, plugins: installed });
  put(knownFile(home), { [market]: knownEntry(home, market, LEGACY_SOURCE) });
  writeClone(home, market);
  put(settingsFile(home), {
    model: 'opus',
    enabledPlugins: enabled,
    extraKnownMarketplaces: { [market]: { source: { source: 'github', repo: LEGACY_SOURCE } } },
    permissions: { allow: ['Bash(git status:*)', `Bash(${L.cli} tracking write:*)`] },
  });
  put(join(home, '.claude', 'CLAUDE.md'), `# Mine\n\n${L.markers.start}\n${GLOBAL.trim()}\n${L.markers.end}\n\n## Local\n`);
  put(join(dataDir(home, 'methodology', market), 'drift.log'), 'per-session\n');
  const config = join(home, '.config', L.dir);
  const harnesses = {};
  if (codex) harnesses.codex = { enabled: true };
  if (grok && grokRecorded) harnesses.grok = { enabled: true };
  put(join(config, 'config.json'), { harnesses });
  if (repo) {
    const root = join(home, 'work', 'app');
    put(join(root, '.githooks', 'progress-gate.sh'),
      `#!/bin/sh\nif command -v ${L.cli} >/dev/null 2>&1; then ${L.cli} tasks check || exit 1; fi\n`);
    put(join(config, 'repos.json'), { version: 1, repos: [{ root, mode: 'committed', lastSeen: 'x', shareable: false }] });
  }
  put(join(home, '.local', 'state', L.dir, 'last-run-codex'), '2026-10-01T00:00:00Z session-start\n');
  put(join(home, '.local', 'share', L.dir, 'role-eval', 'store.json'), '{}\n');
  const bin = join(home, '.local', 'bin');
  put(join(bin, L.cliFile), `#!/usr/bin/env node\n${L.ownership.shim} Bootstrap copies this file.\n`, 0o755);
  symlinkSync(L.cliFile, join(bin, L.cli));
  put(join(bin, L.launcher), `#!/usr/bin/env bash\n${L.ownership.launcher}\nexit 0\n`, 0o755);
  const manifest = { version: 1, harnesses: {} };
  const legacyRoot = cachePath(home, market, 'methodology');
  if (codex) {
    const bridge = `${BRIDGE_NAME}@${market}`;
    put(codexConfigFile(home), [
      'model = "gpt"', '', `[marketplaces.${market}]`, `source = "${cloneDir(home, market)}"`, '',
      `[plugins."${bridge}"]`, 'enabled = true', '',
      `[hooks.state."${bridge}:hooks/hooks.json:stop:0:0"]`, 'trusted_hash = "sha256:0000"', '',
      '[features]', 'hooks = true', '',
    ].join('\n'), 0o600);
    const agentsMd = join(home, '.codex', 'AGENTS.md');
    put(agentsMd, `# Codex\n\n${L.markers.start}\n${expectedRules(legacyRoot, 'codex').trim()}\n${L.markers.end}\n`);
    manifest.harnesses.codex = {
      links: [], files: [], rolesSha: null, rules: { path: agentsMd, split: false, backup: null }, config: [],
      plugins: [{ id: market, action: 'marketplace-added' }, { id: bridge, action: 'added' },
        { id: 'hooks', action: 'feature-enabled' }],
    };
  }
  if (grok) {
    const [hooksFile, rulesFile] = legacyGrokFiles(home);
    const hooks = `${JSON.stringify({ hooks: {} })}\n`;
    const rules = expectedRules(legacyRoot, 'grok');
    put(hooksFile, hooks);
    put(rulesFile, rules);
    if (grokRecorded) {
      // The user's own rules file that the first legacy sync replaced, kept in that run's backup dir.
      const backup = join(home, '.claude', 'backups', `${L.dir}-20260901-100000`, 'grok', basename(rulesFile));
      put(backup, '# my own grok rules\n');
      manifest.harnesses.grok = {
        links: [], rolesSha: null, rules: null, config: [], plugins: [],
        files: [{ path: rulesFile, sha256: sha(rules), backup }, { path: hooksFile, sha256: sha(hooks), backup: null }],
      };
    }
  }
  if (codex || grok) put(join(config, 'harnesses.json'), manifest);
  return home;
}

// The fake `run`. `calls` holds each call as "cmd arg1 arg2 …", `cwds` the cwd it ran in by call index. A call whose
// cwd does not exist exits 127, as spawn's ENOENT does through realRun.
// manifestName: the name the remote manifest gives the marketplace `marketplace add` adds;
// failUninstall: ids whose uninstall exits 1 (and changes nothing); codexMissing and grokMissing: every codex (grok)
// call exits 127, as a binary not on PATH does.
export function fakeMachine(home, {
  manifestName = BRAND.marketplace, failUninstall = [], codexMissing = false, grokMissing = false,
} = {}) {
  const calls = [];
  const cwds = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const err = (stderr) => ({ code: 1, stdout: '', stderr: `${stderr}\n` });
  const readInstalled = () => readJson(installedFile(home)) ?? { version: 2, plugins: {} };
  const readKnown = () => readJson(knownFile(home)) ?? {};
  const scopeOf = (args) => args[args.indexOf('--scope') + 1] ?? 'user';
  const atScope = (scope, cwd) => (e) => isObject(e) && e.scope === scope && (scope === 'user' || e.projectPath === cwd);

  function install(id, scope, cwd, auto) {
    const [name, market] = id.split('@');
    const installPath = cachePath(home, market, name);
    materialize(installPath, name);
    const installed = readInstalled();
    const entry = { scope, installPath, version: VERSIONS[name], ...(auto ? { auto: true } : {}),
      ...(scope === 'user' ? {} : { projectPath: cwd }) };
    installed.plugins[id] = [...(installed.plugins[id] ?? []).filter((e) => !atScope(scope, cwd)(e)), entry];
    put(installedFile(home), installed);
    editJson(scopeSettings(home, scope, cwd), (s) => { s.enabledPlugins = { ...s.enabledPlugins, [id]: true }; });
  }

  function uninstall(id, scope, cwd, keepData) {
    const installed = readInstalled();
    const entries = installed.plugins[id] ?? [];
    if (!entries.some(atScope(scope, cwd))) return false;
    const left = entries.filter((e) => !atScope(scope, cwd)(e));
    if (left.length) installed.plugins[id] = left;
    else delete installed.plugins[id];
    put(installedFile(home), installed);
    const path = scopeSettings(home, scope, cwd);
    if (existsSync(path)) editJson(path, (s) => { if (isObject(s.enabledPlugins)) delete s.enabledPlugins[id]; });
    const [name, market] = id.split('@');
    if (!keepData) rmSync(dataDir(home, name, market), { recursive: true, force: true });
    return true;
  }

  function claude(args, cwd) {
    const rest = args.join(' ');
    if (rest === '--version') return ok('2.1.296 (Claude Code)\n');
    const [, verb, a, b] = args;
    if (verb === 'marketplace' && a === 'add') {
      const known = readKnown();
      if (Object.hasOwn(known, manifestName)) {
        return err(`Cannot add marketplace "${manifestName}": its source doesn't match its extraKnownMarketplaces entry (declared)`);
      }
      known[manifestName] = knownEntry(home, manifestName, b);
      put(knownFile(home), known);
      writeClone(home, manifestName);
      editJson(settingsFile(home), (s) => {
        s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, [manifestName]: { source: { source: 'github', repo: b } } };
      });
      return ok(`Successfully added marketplace: ${manifestName}\n`);
    }
    if (verb === 'marketplace' && a === 'update') return ok();
    if (verb === 'marketplace' && a === 'remove') {
      const known = readKnown();
      if (!Object.hasOwn(known, b)) return err(`Marketplace '${b}' not found (not_configured)`);
      for (const [id, entries] of Object.entries(readInstalled().plugins)) {
        if (!id.endsWith(`@${b}`)) continue;
        for (const e of entries) uninstall(id, e.scope, e.projectPath, false);
      }
      delete known[b];
      put(knownFile(home), known);
      if (existsSync(settingsFile(home))) {
        editJson(settingsFile(home), (s) => { if (isObject(s.extraKnownMarketplaces)) delete s.extraKnownMarketplaces[b]; });
      }
      rmSync(cloneDir(home, b), { recursive: true, force: true });
      return ok(`Successfully removed marketplace: ${b}\n`);
    }
    const scope = scopeOf(args);
    if (verb === 'install') {
      const market = a.split('@')[1];
      if (!Object.hasOwn(readKnown(), market)) return err(`Marketplace "${market}" not found`);
      install(a, scope, cwd, false);
      if (a.startsWith('methodology@')) {
        for (const dep of DEPENDENCIES) {
          const depId = `${dep}@${market}`;
          if (!(readInstalled().plugins[depId] ?? []).some(atScope(scope, cwd))) install(depId, scope, cwd, true);
        }
      }
      return ok(`Installed ${a}\n`);
    }
    if (verb === 'update') {
      const installed = readInstalled();
      for (const e of installed.plugins[a] ?? []) if (e.scope === scope) e.version = VERSIONS[a.split('@')[0]];
      put(installedFile(home), installed);
      return ok();
    }
    if (verb === 'disable') {
      editJson(scopeSettings(home, scope, cwd), (s) => { s.enabledPlugins = { ...s.enabledPlugins, [a]: false }; });
      return ok();
    }
    if (verb === 'uninstall') {
      if (failUninstall.includes(a)) return err(`Failed to uninstall ${a}: boom`);
      return uninstall(a, scope, cwd, args.includes('--keep-data')) ? ok() : err(`Plugin "${a}" is not installed (not_installed)`);
    }
    return err(`fake: unexpected claude ${rest}`);
  }

  const codexText = () => readText(codexConfigFile(home)) ?? '';
  const tables = (prefix) => [...codexText().matchAll(new RegExp(`^\\[${prefix}\\.("?)([^"\\]]+)\\1\\]$`, 'gm'))]
    .map((m) => m[2]);
  const appendCodex = (lines) => put(codexConfigFile(home), `${codexText().replace(/\n*$/, '\n')}\n${lines.join('\n')}\n`);

  function codex(args) {
    const rest = args.join(' ');
    if (codexMissing) return { code: 127, stdout: '', stderr: 'spawn codex ENOENT' };
    if (rest === '--version') return { code: 127, stdout: '', stderr: 'spawn codex ENOENT' };
    if (rest === 'plugin list --json') {
      return ok(JSON.stringify({ installed: tables('plugins').map((pluginId) => ({ pluginId, enabled: true })), available: [] }));
    }
    if (rest === 'plugin marketplace list --json') {
      return ok(JSON.stringify({ marketplaces: tables('marketplaces').map((name) => ({ name })) }));
    }
    if (rest.startsWith('plugin marketplace add ')) {
      appendCodex([`[marketplaces.${basename(args[3])}]`, `source = "${args[3]}"`]);
      return ok();
    }
    if (rest.startsWith('plugin marketplace remove ')) {
      if (!tables('marketplaces').includes(args[3])) return err(`marketplace ${args[3]} is not configured`);
      put(codexConfigFile(home), removeTable(codexText(), `marketplaces.${args[3]}`));
      return ok();
    }
    if (rest.startsWith('plugin add ')) {
      if (!tables('marketplaces').includes(args[2].split('@')[1])) return err(`unknown marketplace for ${args[2]}`);
      appendCodex([`[plugins."${args[2]}"]`, 'enabled = true']);
      return ok();
    }
    if (rest.startsWith('plugin remove ')) {
      if (!tables('plugins').includes(args[2])) return err(`${args[2]} is not installed`);
      put(codexConfigFile(home), removeTable(codexText(), `plugins."${args[2]}"`));
      return ok();
    }
    if (rest === 'features list') return ok('hooks                                    stable             true\n');
    return err(`fake: unexpected codex ${rest}`);
  }

  function grok(args) {
    const rest = args.join(' ');
    if (grokMissing) return { code: 127, stdout: '', stderr: 'spawn grok ENOENT' };
    if (rest === '--version') return { code: 127, stdout: '', stderr: 'spawn grok ENOENT' };
    if (rest === 'plugin list --json') return ok('[]');
    if (rest === 'inspect --json') return ok(JSON.stringify({ hooks: [] }));
    return err(`fake: unexpected grok ${rest}`);
  }

  const run = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(' '));
    cwds.push(opts.cwd);
    // spawn in a cwd that does not exist fails before the command runs: realRun resolves it as code 127.
    if (opts.cwd !== undefined && !existsSync(opts.cwd)) return { code: 127, stdout: '', stderr: `spawn ${cmd} ENOENT` };
    if (cmd === 'claude') return claude(args, opts.cwd);
    if (cmd === 'codex') return codex(args);
    if (cmd === 'grok') return grok(args);
    if (args.at(-1) === 'doctor') return ok('doctor: 0 failure(s), 0 warning(s)\n');
    if (args[0] === '--version') return cmd === 'headjack' ? { code: 127, stdout: '', stderr: 'ENOENT' } : ok(`${cmd} 1.0\n`);
    return { code: 127, stdout: '', stderr: `${cmd}: not found` };
  };
  return { run, calls, cwds };
}
