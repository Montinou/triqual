// `triqual doctor [--repo]`: a read-only diagnosis of the methodology install on this machine, and of each harness
// config.json records as set up (spec Addendum F.5). Every check yields failure lines (each with its fix) or warnings;
// a missing or malformed file is a line, never a crash. Nothing is ever written; every CLI call goes through the
// injected `run`. Exit codes: 0 no failures (and for --help/-h), 1 failures, 2 an unknown argument.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGenerated, parseRole } from './lib/agents.mjs';
import { readManagedSection } from './lib/fsx.mjs';
import { codexAgentText, inSupersededCache, linkState, wantedLinks } from './lib/harness-links.mjs';
import { readManifest } from './lib/harness-manifest.mjs';
import {
  codexEnabledMap, codexPluginTable, grokHooksFile, grokStaleEntries, hooksOn, userInstalls,
} from './lib/harness-sync.mjs';
import {
  bridgeId, codexBridgeDir, codexCloneDir, codexTrustKeys, detect, expectedRules, harnessPaths, HARNESS_IDS,
} from './lib/harnesses.mjs';
import { activeMarketplace, BRAND, brandDir, pluginId } from './lib/brand.mjs';
import { legacyCliPresent } from './lib/cli-files.mjs';
import { isUnreadable, legacyScan } from './lib/legacy-scan.mjs';
import { realRun } from './lib/run.mjs';
import { configPath, readMethodologyConfig, supersededEnabled } from './lib/settings.mjs';
import { legacyHeadingsOutside } from './sync.mjs';

// A progress-tracking script: cli/ since the plugins stopped shipping a top-level bin/, bin/ in an older install.
const ptScript = (root, name) => (existsSync(join(root, 'cli', name)) || !existsSync(join(root, 'bin', name)) ? join(root, 'cli', name) : join(root, 'bin', name));

// The system plugins, methodology first (installing it brings in the other three). Bootstrap reuses this list.
export const PLUGINS = ['methodology', 'progress-tracking', 'workflow-gate', 'roles'];
const ROLES = ['brief-writer', 'tdd-implementer', 'complex-implementer', 'safety-reviewer', 'spec-reviewer',
  'review-fixer', 'final-adversarial-reviewer', 'hunter'];
const LEGACY_GATE = 'hooks/workflow-gate.mjs';
const HEADJACK_TIMEOUT_MS = 10000;
const GIT_TIMEOUT_MS = 10000;
const TASKS_TIMEOUT_MS = 10000;
// What progress-tracking's bin/tasks.mjs prints (exit 2) for a repo that is not opted in, verbatim. Since
// progress-tracking 0.2.2 `paths --json` reports it (and the hook lines below) itself; these copies serve older installs.
const NOT_OPTED_IN = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const OWNER_EXEC = 0o100;
// progress-tracking's local gate and the hook lines its init chains into <git-common-dir>/hooks, verbatim.
const LOCAL_GATE = 'pre-commit.mjs';
const LOCAL_GATE_REF = `"$(git rev-parse --path-format=absolute --git-common-dir)/methodology/${LOCAL_GATE}"`;
const LOCAL_HOOKS = {
  'pre-commit': `node ${LOCAL_GATE_REF} || exit 1`,
  'post-commit': `node ${LOCAL_GATE_REF} --post-commit`,
};
// progress-tracking's store hook scripts (scripts/init.mjs STORE_SCRIPTS) and the lines each holds (lib/store-hooks.mjs
// STORE_HOOK_LINES), verbatim: doctor never imports progress-tracking, and a test pins both copies equal.
export const STORE_SCRIPTS = {
  'pre-commit': 'progress-store-pre-commit.sh',
  'post-commit': 'progress-store-post-commit.sh',
};
const STORE_MARKER_LINE = `[ "$(git config --local --get ${BRAND.cli}.tracking)" = store ] || exit 0`;
const storeMissingCli = (hook, consequence, code) => `command -v ${BRAND.cli} >/dev/null 2>&1 || { echo "${hook} `
  + `(progress-tracking, store mode): ${BRAND.cli} is not on PATH, ${consequence}" >&2; exit ${code}; }`;
export const STORE_HOOKS = {
  'pre-commit': [
    STORE_MARKER_LINE,
    storeMissingCli('pre-commit', `so this commit cannot be checked for a pending progress entry: install ${BRAND.cli} or fix PATH`, 1),
    `exec ${BRAND.cli} tracking hook pre-commit`,
  ],
  'post-commit': [
    STORE_MARKER_LINE,
    storeMissingCli('post-commit', "so this commit's progress entries stay pending", 0),
    `exec ${BRAND.cli} tracking hook post-commit`,
  ],
};
// How each store script is chained into its hook (init: `sh <ref> || exit 1` for pre-commit, `|| true` for post-commit).
const STORE_CHAIN_TAIL = { 'pre-commit': '|| exit 1', 'post-commit': '|| true' };
const STORE_FIX = `run ${BRAND.cli} progress-init --store`;
const STORE_SNAPSHOT_MAX_DAYS = 3;
const STORE_SNAPSHOT = /^tracking-(\d{4}-\d{2}-\d{2})\.db$/;
// The oldest Node the CLI and its hooks run on (node:sqlite without a flag), compared on major and minor.
const NODE_FLOOR = [22, 13];
// The id of system plugin `name` as installed on this machine (lib/brand.mjs pluginId).
export const idOf = (home, name) => pluginId(home, name);
// The shim's command map (setup/triqual-shim.mjs COMMANDS, which a test keeps equal): command → [plugin, file it runs].
export const SHIM_COMMANDS = {
  tasks: ['progress-tracking', 'cli/tasks.mjs'],
  'progress-init': ['progress-tracking', 'cli/progress-init.mjs'],
  suggest: ['skill-suggest', 'cli/suggest.mjs'],
  doctor: ['methodology', 'cli/doctor.mjs'],
  sync: ['methodology', 'cli/sync.mjs'],
  'upstream-diff': ['methodology', 'cli/upstream-diff.mjs'],
  ui: ['progress-tracking', 'cli/ui.mjs'],
  tracking: ['progress-tracking', 'cli/tracking.mjs'],
  hook: ['methodology', 'cli/hook.mjs'],
  memory: ['memory-report', 'cli/memory.mjs'],
  'role-eval': ['methodology', 'cli/role-eval.mjs'],
  migrate: ['methodology', 'cli/migrate.mjs'],
};

// { value } for a parsed JSON file, { missing: true } when it does not exist, { error } when it cannot be read or
// parsed.
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { error: `cannot read ${path}: ${err.message}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `${path} is not valid JSON` };
  }
}

// The user-scope entry of `id` when it has an install path, or null when installed_plugins.json lacks one.
function userEntry(installed, id) {
  const entries = installed?.plugins?.[id];
  if (!Array.isArray(entries)) return null;
  const entry = entries.find((e) => e?.scope === 'user');
  return typeof entry?.installPath === 'string' ? entry : null;
}

// The active marketplace's installed copy, from known_marketplaces.json: { location }, or { error }.
function marketplaceLocation(home) {
  const knownPath = join(home, '.claude', 'plugins', 'known_marketplaces.json');
  const known = readJson(knownPath);
  if (known.missing) return { error: `${knownPath} does not exist` };
  if (known.error) return { error: known.error };
  const marketplace = activeMarketplace(home);
  const location = known.value?.[marketplace]?.installLocation;
  if (typeof location !== 'string' || location === '') {
    return { error: `${knownPath} has no ${marketplace} installLocation` };
  }
  return { location };
}

// The plugin versions the INSTALLED copy of the active marketplace lists, by plugin name: { versions }, or
// { error } when known_marketplaces.json or that copy's .claude-plugin/marketplace.json cannot be read. Never throws.
export function marketplaceVersions(home) {
  const { location, error } = marketplaceLocation(home);
  if (error) return { error };
  const manifestPath = join(location, '.claude-plugin', 'marketplace.json');
  const manifest = readJson(manifestPath);
  if (manifest.missing) return { error: `${manifestPath} does not exist` };
  if (manifest.error) return { error: manifest.error };
  if (!Array.isArray(manifest.value?.plugins)) return { error: `${manifestPath} lists no plugins` };
  const versions = {};
  for (const plugin of manifest.value.plugins) {
    if (typeof plugin?.name === 'string' && typeof plugin.version === 'string') versions[plugin.name] = plugin.version;
  }
  return { versions };
}

// Every string `command` found anywhere under the settings' hooks.
function hookCommands(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) hookCommands(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'command' && typeof value === 'string') out.push(value);
      else hookCommands(value, out);
    }
  }
  return out;
}

// Each system plugin must be installed at user scope, at the version the installed marketplace copy lists. When that
// copy cannot be read the versions are not compared, with a warning.
function pluginChecks(home, failures, warnings) {
  const path = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const file = readJson(path);
  if (file.error) failures.push(`${file.error}: reinstall the plugins with claude plugin install <id> --scope user`);
  const market = marketplaceVersions(home);
  if (market.error) {
    const marketplace = activeMarketplace(home);
    warnings.push(`cannot compare plugin versions with the ${marketplace} marketplace: ${market.error}: `
      + `run claude plugin marketplace update ${marketplace}`);
  }
  const installs = {};
  for (const name of PLUGINS) {
    const id = idOf(home, name);
    const entry = userEntry(file.value, id);
    installs[name] = entry?.installPath ?? null;
    if (entry === null) {
      failures.push(`plugin ${id} is not installed at user scope: run claude plugin install ${id} --scope user`);
      continue;
    }
    const released = market.versions?.[name];
    if (released !== undefined && entry.version !== released) {
      failures.push(`${id} is ${entry.version}, marketplace has ${released}: run claude plugin update ${id} --scope user`);
    }
  }
  return installs;
}

function settingsChecks(home, failures) {
  const path = join(home, '.claude', 'settings.json');
  const file = readJson(path);
  if (file.error) {
    failures.push(`${file.error}: fix it by hand, then run triqual doctor again`);
    return null;
  }
  const settings = file.value ?? {};
  for (const name of PLUGINS) {
    const id = idOf(home, name);
    if (settings.enabledPlugins?.[id] !== true) {
      failures.push(`plugin ${id} is not enabled: run claude plugin enable ${id}`);
    }
  }
  if (hookCommands(settings.hooks).some((c) => c.includes(LEGACY_GATE))) {
    failures.push(`${path} still runs the legacy gate hook ${LEGACY_GATE}: remove that hook entry `
      + '(the workflow-gate plugin replaces it)');
  }
  return settings;
}

function rulesCheck(home, methodologyPath, failures) {
  const globalPath = join(methodologyPath, 'rules', 'global.md');
  let expected;
  try {
    expected = readFileSync(globalPath, 'utf8').trim();
  } catch (err) {
    failures.push(`cannot read ${globalPath}: ${err.message}: reinstall ${idOf(home, 'methodology')}`);
    return;
  }
  const claudeMd = join(home, '.claude', 'CLAUDE.md');
  let text;
  try {
    text = readFileSync(claudeMd, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      failures.push(`cannot read ${claudeMd}: ${err.message}: make it a readable file, then run triqual doctor again`);
      return;
    }
    failures.push(`${claudeMd} does not exist: run triqual sync`);
    return;
  }
  const { body, error } = readManagedSection(text);
  const legacy = error ? [] : unsplitHeadings(home, text, methodologyPath, failures);
  if (legacy === null) return; // the unreadable legacy-headings.json is reported: fail closed
  if (error) {
    failures.push(`the managed section of ${claudeMd} is ${error}: fix the triqual markers by hand, `
      + 'then run triqual sync');
  } else if (legacy.length > 0) {
    // triqual sync refuses such a file, so its fix is the one-time split (spec §9.1).
    failures.push(`${claudeMd} is not split, legacy headings sit outside the managed section (${legacy.join(', ')}): `
      + 'split, then rerun bootstrap');
  } else if (body === null) {
    failures.push(`${claudeMd} has no triqual managed section: run triqual sync`);
  } else if (body !== expected) {
    failures.push(`the managed section of ${claudeMd} differs from ${globalPath}: run triqual sync`);
  }
}

// The legacy headings the installed legacy-headings.json lists that sit outside the managed section, or null after
// reporting that file missing or unreadable (without it doctor cannot tell a split file from an unsplit one).
function unsplitHeadings(home, text, methodologyPath, failures) {
  const path = join(methodologyPath, 'rules', 'legacy-headings.json');
  const file = readJson(path);
  const headings = file.value;
  if (!Array.isArray(headings) || !headings.every((h) => typeof h === 'string')) {
    const why = file.missing ? `${path} does not exist` : file.error ?? `${path} is not a list of headings`;
    failures.push(`${why}: reinstall ${idOf(home, 'methodology')}`);
    return null;
  }
  return legacyHeadingsOutside(text, headings);
}

// The installed manifest's supersedes patterns, or null after reporting the manifest unreadable.
function supersedesPatterns(home, methodologyPath, failures) {
  const path = join(methodologyPath, 'rules', 'manifest.json');
  const file = readJson(path);
  if (file.missing || file.error) {
    failures.push(`${file.error ?? `${path} does not exist`}: reinstall ${idOf(home, 'methodology')}`);
    return null;
  }
  return Array.isArray(file.value?.supersedes) ? file.value.supersedes : [];
}

// A superseded plugin enabled at user scope fails, or under keepSuperseded warns (spec Addendum E.9). While
// config.json cannot be read triqual sync disables nothing, so the fix names that file first.
function supersededCheck(home, methodologyPath, settings, config, failures, warnings) {
  const patterns = supersedesPatterns(home, methodologyPath, failures);
  if (patterns === null) return;
  const fix = config.error ? `fix or remove ${configPath(home)}, then run triqual sync` : 'run triqual sync';
  for (const id of supersededEnabled(patterns, settings?.enabledPlugins)) {
    if (config.keepSuperseded) {
      warnings.push(`superseded plugin ${id} is enabled by keepSuperseded in ${configPath(home)}: `
        + `remove that setting and run triqual sync to use methodology alone`);
    } else {
      failures.push(`superseded plugin ${id} is still enabled: ${fix}`);
    }
  }
}

// The real path, or the path itself when it cannot be resolved.
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const PROJECT_SETTINGS = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json')];

// --repo: a superseded plugin enabled in the repo's project settings is a warning. Those files are never edited.
// Nothing is checked outside a git repo, nor in a repo whose .claude dir is the user's own (a home kept in git):
// those files are user settings, which the user-scope check covers.
function projectSupersededCheck(home, cwd, methodologyPath, warnings) {
  const patterns = supersedesPatterns(home, methodologyPath, []);
  if (!patterns || patterns.length === 0) return;
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (root === null) return;
  if (realOrSelf(join(root, '.claude')) === realOrSelf(join(home, '.claude'))) return;
  for (const rel of PROJECT_SETTINGS) {
    const path = join(root, rel);
    const file = readJson(path);
    if (file.missing) continue;
    if (file.error) {
      warnings.push(`cannot check ${path} for superseded plugins: ${file.error}`);
      continue;
    }
    for (const id of supersededEnabled(patterns, file.value?.enabledPlugins)) {
      warnings.push(`superseded plugin ${id} is enabled in ${path}: set it to false there by hand if this repo should `
        + 'use methodology (doctor never edits project settings)');
    }
  }
}

// The command names in a shim's `export const COMMANDS = { ... }` block, read as text (the shim is never run); an
// empty set when the block cannot be found or read.
function shimCommandNames(shim) {
  let text;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return new Set();
  }
  const block = /^export const COMMANDS = \{\n([\s\S]*?)^\};/m.exec(text);
  if (!block) return new Set();
  return new Set([...block[1].matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)]
    .map((m) => m[1] ?? m[2] ?? m[3]));
}

// Line 2 of the file at path (through a symlink), or null when it cannot be read.
function line2(path) {
  try {
    return readFileSync(path, 'utf8').split('\n')[1] ?? '';
  } catch {
    return null;
  }
}

// For the alias period, on a machine that has a legacy CLI file of ours (legacyCliPresent: bootstrap installs the alias
// and the forwarder only there, and a foreign file at those names is someone else's tool, which doctor leaves alone),
// the legacy CLI name and its .mjs must carry the alias's line 2 (an older full shim there would bypass triqual), and
// the legacy launcher name the forwarder's. An existing alias file or forwarder without it is the legacy scan's
// failure, so here only a missing one fails, and the cm link only when it does not resolve to the alias file.
function aliasCheck(home, bin, fix, failures) {
  const alias = join(bin, BRAND.legacy.cliFile);
  const forwarder = join(bin, BRAND.legacy.launcher);
  if (!legacyCliPresent(home)) return;
  for (const path of [join(bin, BRAND.legacy.cli), alias]) {
    const line = line2(path);
    const scanned = line !== null && realOrSelf(path) === realOrSelf(alias); // the alias file itself, or the cm link to it
    if (line !== BRAND.ownership.alias && !scanned) {
      failures.push(`${path} is missing or is not the ${BRAND.legacy.cli} alias of ${BRAND.cli}: ${fix}`);
    }
  }
  if (line2(forwarder) === null) {
    failures.push(`${forwarder} is missing or is not the ${BRAND.legacy.launcher} forwarder of ${BRAND.cli}: ${fix}`);
  }
}

// ~/.local/bin/triqual (a symlink to triqual.mjs since bootstrap installs it so) must resolve to an existing file, and
// it must know every command whose file an installed system plugin ships: bootstrap copies the shim once, so a plugin
// update that brings a new command (tracking in progress-tracking 0.2.2) leaves an older copy that refuses it. The
// legacy CLI names are aliasCheck's, checked first.
function shimCheck(home, installs, failures) {
  const bin = join(home, '.local', 'bin');
  const fix = 'run node bin/bootstrap.mjs';
  aliasCheck(home, bin, fix, failures);
  const shim = join(bin, BRAND.cli);
  let isFile = false;
  try {
    isFile = statSync(shim).isFile();
  } catch { /* missing, or a dangling symlink */ }
  if (!isFile) {
    failures.push(`the ${BRAND.cli} shim ${shim} is missing or broken: ${fix}`);
    return;
  }
  const known = shimCommandNames(shim);
  const lacking = new Map(); // plugin → commands it ships that the shim lacks
  for (const [cmd, [plugin, rel]] of Object.entries(SHIM_COMMANDS)) {
    const installPath = installs[plugin];
    if (known.has(cmd) || typeof installPath !== 'string' || !existsSync(join(installPath, rel))) continue;
    lacking.set(plugin, [...(lacking.get(plugin) ?? []), `${BRAND.cli} ${cmd}`]);
  }
  for (const [plugin, cmds] of lacking) {
    failures.push(`${BRAND.cli} shim is stale: ${shim} lacks ${cmds.join(', ')}, which the installed ${plugin} ships: `
      + 'rerun node bin/bootstrap.mjs');
  }
}

function agentChecks(home, failures) {
  for (const name of ROLES) {
    const file = join(home, '.claude', 'agents', `${name}.md`);
    if (existsSync(file)) {
      failures.push(`duplicate agent ${file} shadows the roles plugin's ${name}: remove the file`);
    }
  }
}

async function headjackCheck(run, warnings) {
  let detail;
  try {
    const { code } = await run('headjack', ['search', 'ping', '-k', '1', '--json'],
      { timeoutMs: HEADJACK_TIMEOUT_MS });
    if (code === 0) return;
    detail = `exited ${code}`;
  } catch (err) {
    detail = `failed: ${err.message}`;
  }
  warnings.push(`headjack is unreachable (headjack search ${detail}): skill search will not work; `
    + 'Headjack is optional: install it with `claude plugin install headjack@triqual` or sign in with '
    + '`headjack login`, and to run it from a terminal link bin/headjack from a clone of '
    + 'https://github.com/Montinou/headjack into ~/.local/bin (not from the installed plugin\'s directory, '
    + 'which changes on every update; see its README)');
}

// A git call's trimmed stdout (possibly empty), or null on any error or a run past timeoutMs (git is then killed).
function gitOutput(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, killSignal: 'SIGKILL',
    }).trim();
  } catch {
    return null;
  }
}

// A git call's trimmed stdout, or null on any error, empty output or a run past timeoutMs.
export function git(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  return gitOutput(cwd, args, timeoutMs) || null;
}

// The dir holding the repo's progress-gate.sh, resolved like progress-tracking's init: core.hooksPath (husky's
// ".husky/_" wrappers source the hooks one level up), else the git hooks dir.
function hooksDir(root) {
  const hooksPath = git(root, ['config', 'core.hooksPath']);
  if (hooksPath) {
    const abs = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
    return /(^|\/)\.husky\/_\/?$/.test(hooksPath) ? dirname(abs) : abs;
  }
  const gitHooks = git(root, ['rev-parse', '--git-path', 'hooks']);
  if (gitHooks === null) return null;
  return isAbsolute(gitHooks) ? gitHooks : join(root, gitHooks);
}

// The installed progress-tracking template `name`, or null after reporting it unreadable.
function readTemplate(home, progressTrackingPath, name, failures) {
  const templatePath = join(progressTrackingPath, 'templates', name);
  try {
    return readFileSync(templatePath, 'utf8');
  } catch (err) {
    failures.push(`cannot read ${templatePath}: ${err.message}: reinstall ${idOf(home, 'progress-tracking')}`);
    return null;
  }
}

// The file's text, or null when it is missing or unreadable.
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

// The first line of a hook that is not a shell script, or null for a shell one: no shebang (git runs it with sh), or
// sh, bash, dash, zsh or ksh, directly or through `/usr/bin/env` — the rule progress-tracking's init chains by.
function nonShellShebang(text) {
  const first = text.split('\n')[0];
  if (!first.startsWith('#!')) return null;
  const words = first.slice(2).trim().split(/\s+/);
  const base = (w) => w?.split('/').pop();
  const program = base(words[0]) === 'env' ? base(words.slice(1).find((w) => !w.startsWith('-'))) : base(words[0]);
  return SHELLS.has(program) ? null : first.trim();
}

// null when the hook text holds `marker`, else the failure: init leaves a hook in another language untouched, so its
// fix is the line added by hand; any other hook is fixed by rerunning init (`fix`).
function chainFailure(hook, text, marker, line, fix) {
  if ((text ?? '').includes(marker)) return null;
  const shebang = text === null ? null : nonShellShebang(text);
  if (shebang !== null) return `${hook} is not a shell script (${shebang}): add this line to it by hand: ${line}`;
  return `${hook} does not chain ${fix.what}: ${fix.run}`;
}

// Committed mode: the repo's progress-gate.sh must equal the installed template, and the pre-commit next to it must
// chain it (the `progress-gate.sh` marker init tests). Hooks are not checked for the exec bit here: husky's sourced
// .husky/<hook> files need none.
function gateCheck(home, root, progressTrackingPath, failures) {
  const template = readTemplate(home, progressTrackingPath, 'progress-gate.sh', failures);
  if (template === null) return;
  const dir = hooksDir(root);
  const gate = dir === null ? null : join(dir, 'progress-gate.sh');
  if ((gate === null ? null : readText(gate)) !== template) {
    failures.push(`${gate ?? `the progress gate of ${root}`} is missing or differs from the installed `
      + `progress-tracking template: run triqual progress-init`);
  }
  if (dir === null) return;
  const hook = join(dir, 'pre-commit');
  const rel = relative(root, dir);
  const inGitDir = rel === '.git' || rel.startsWith('.git/');
  const line = `sh ${inGitDir ? '"$(git rev-parse --git-path hooks)/progress-gate.sh"'
    : `"$(git rev-parse --show-toplevel)/${rel}/progress-gate.sh"`} || exit 1`;
  const failure = chainFailure(hook, readText(hook), 'progress-gate.sh', line,
    { what: 'progress-gate.sh', run: 'run triqual progress-init' });
  if (failure) failures.push(failure);
}

// Local mode: <root>/pre-commit.mjs must equal the installed template and, without core.hooksPath, both hooks in
// <git-common-dir>/hooks must chain it (without the post-commit line the gate never records a pass). "Chained" is
// what init itself tests, so rerunning init always clears the failure. A pending hash while nothing is staged was
// left by an aborted commit.
function localChecks(home, cwd, root, progressTrackingPath, hookLines, failures, warnings) {
  const template = readTemplate(home, progressTrackingPath, 'pre-commit-local.mjs', failures);
  const gate = join(root, LOCAL_GATE);
  if (template !== null && readText(gate) !== template) {
    failures.push(`${gate} is missing or differs from the installed progress-tracking template: `
      + 'run triqual progress-init --local');
  }
  if (git(cwd, ['config', 'core.hooksPath'])) {
    warnings.push('local mode without git hooks (core.hooksPath is set): commits are not gated; the Stop hook '
      + 'checks for a progress.md entry newer than the last commit');
  } else {
    for (const [name, line] of Object.entries(hookLines)) {
      const hook = join(dirname(root), 'hooks', name);
      const failure = chainFailure(hook, readText(hook), line, line,
        { what: 'the local progress gate', run: 'run triqual progress-init --local' });
      if (failure) {
        failures.push(failure);
      } else if ((statSync(hook).mode & OWNER_EXEC) === 0) {
        failures.push(`hook not executable: chmod +x ${hook}`); // git skips a hook it cannot execute
      }
    }
  }
  const state = readJson(join(root, 'state.json'));
  // Only a successful, empty `git diff --cached` shows that nothing is staged; a git failure says nothing.
  if (typeof state.value?.pendingProgressSha256 === 'string' && gitOutput(cwd, ['diff', '--cached', '--name-only']) === '') {
    warnings.push(`pending progress hash left from an aborted commit in ${join(root, 'state.json')}: `
      + 'the next commit that passes the local gate replaces it');
  }
}

// One `node <tasks.mjs> <args>` run; a run that throws resolves like a spawn error.
async function runTasks(run, tasks, args, cwd) {
  try {
    return await run(process.execPath, [tasks, ...args], { timeoutMs: TASKS_TIMEOUT_MS, cwd });
  } catch (err) {
    return { code: 127, stdout: '', stderr: err.message };
  }
}

const firstLine = (text) => (text ?? '').trim().split('\n')[0];

const isText = (v) => typeof v === 'string' && v !== '';

// The facts progress-tracking 0.2.2's `paths --json` prints in every case (spec Addendum E.8): the local hook lines,
// or null when the answer lacks them or they are malformed.
function pathsFacts(t) {
  const lines = t.localHookLines;
  if (!isText(t.notOptedInMessage) || !lines || typeof lines !== 'object') return null;
  return Object.keys(LOCAL_HOOKS).every((name) => isText(lines[name]))
    ? Object.fromEntries(Object.keys(LOCAL_HOOKS).map((name) => [name, lines[name]]))
    : null;
}

// Fails when `version` ("22.12.0") is below the floor: the CLI and its hooks need node:sqlite, so an older Node breaks
// tracking in a store repository and everything that calls the store.
export function nodeCheck(version, failures) {
  const [major, minor] = String(version).split('.').map(Number);
  const [floorMajor, floorMinor] = NODE_FLOOR;
  if (major > floorMajor || (major === floorMajor && minor >= floorMinor)) return;
  failures.push(`node ${version} is older than ${NODE_FLOOR.join('.')}: install Node ${NODE_FLOOR.join('.')} or newer`);
}

// Store mode: each hook's script holds the store hook lines and is chained from the hook; the pre-commit no longer
// chains progress-gate.sh; `tracking status --json` reads the store (a missing, disabled or damaged store is one FAIL
// and nothing is created: the view is read-only); the newest snapshot beside the database is recent. Resolves false
// when the store is unavailable, so that `tasks check` is not run to repeat the same error.
async function storeChecks({ cwd, root, store, tracking, run }, failures, warnings) {
  const dir = hooksDir(root);
  const fix = `${STORE_FIX} (in a linked worktree of a switched clone: merge main instead)`;
  const rel = dir === null ? null : relative(root, dir);
  const inGitDir = rel !== null && (rel === '.git' || rel.startsWith('.git/'));
  for (const [name, scriptName] of Object.entries(STORE_SCRIPTS)) {
    const script = dir === null ? null : join(dir, scriptName);
    const text = script === null ? null : readText(script);
    const lines = new Set((text ?? '').split('\n'));
    if (text === null || !STORE_HOOKS[name].every((line) => lines.has(line))) {
      failures.push(`${script ?? `the ${name} store script of ${root}`} is missing or differs from the store hook lines: ${STORE_FIX}`);
    }
    if (dir === null) continue;
    const ref = inGitDir ? `"$(git rev-parse --git-path hooks)/${scriptName}"`
      : `"$(git rev-parse --show-toplevel)/${rel}/${scriptName}"`;
    const hook = join(dir, name);
    const failure = chainFailure(hook, readText(hook), scriptName, `sh ${ref} ${STORE_CHAIN_TAIL[name]}`,
      { what: scriptName, run: fix });
    if (failure) failures.push(failure);
    if (name === 'pre-commit' && (readText(hook) ?? '').includes('progress-gate.sh')) {
      failures.push(`${hook} still chains progress-gate.sh: ${STORE_FIX}`);
    }
  }
  const status = await runTasks(run, tracking, ['status', '--json'], cwd);
  const available = status.code === 0;
  if (!available) {
    failures.push(`tracking store unavailable: ${firstLine(status.stderr) || `triqual tracking status --json exited ${status.code}`}`);
  }
  if (store !== null) snapshotCheck(store, warnings);
  return available;
}

// The newest backups/tracking-YYYY-MM-DD.db beside the database (the day is its UTC date) must be at most
// STORE_SNAPSHOT_MAX_DAYS days old; the first store write of a day takes one.
function snapshotCheck(store, warnings) {
  const backups = join(dirname(store), 'backups');
  let names = [];
  try {
    names = readdirSync(backups).filter((n) => STORE_SNAPSHOT.test(n)).sort();
  } catch { /* none */ }
  const take = 'the next triqual tracking add takes one';
  if (names.length === 0) {
    warnings.push(`newest tracking snapshot is none (no tracking-YYYY-MM-DD.db in ${backups}): ${take}`);
    return;
  }
  const newest = names[names.length - 1];
  const days = Math.floor((Date.now() - Date.parse(`${STORE_SNAPSHOT.exec(newest)[1]}T00:00:00Z`)) / 86_400_000);
  if (days > STORE_SNAPSHOT_MAX_DAYS) {
    warnings.push(`newest tracking snapshot is ${days} days old (${join(backups, newest)}): ${take}`);
  }
}

// `tasks export --json --all`: one note per registered repository that still resolves, `tracking: <root> <mode>`. An
// export that fails or prints something else gives no notes: the listing is information, not a check.
async function trackingModes(progressTrackingPath, run, cwd) {
  if (progressTrackingPath === null) return [];
  const tasks = ptScript(progressTrackingPath, 'tasks.mjs');
  if (!existsSync(tasks)) return [];
  const exported = await runTasks(run, tasks, ['export', '--json', '--all'], cwd);
  if (exported.code !== 0) return [];
  try {
    const snapshots = JSON.parse(exported.stdout);
    return (Array.isArray(snapshots) ? snapshots : [])
      .filter((x) => isText(x?.repo?.root) && isText(x.repo.mode))
      .map((x) => `tracking: ${x.repo.root} ${x.repo.mode}`);
  } catch {
    return [];
  }
}

// With bin/tasks.mjs installed the tracking comes from `triqual tasks paths --json`, then `triqual tasks check` reports drift
// (exit 1). Since progress-tracking 0.2.2 paths answers `optedIn` (false: not opted in) with the local hook lines to
// check; an older install exits 2 with tasks.mjs's own message when not opted in and prints no facts when opted in, so
// doctor's own copies stand in. An older progress-tracking without bin/tasks.mjs gets the progress-gate.sh check alone,
// for a repo with progress.md at its root.
async function repoChecks(home, cwd, progressTrackingPath, run, failures, warnings) {
  if (progressTrackingPath === null) return; // the missing plugin is already reported
  const tasks = ptScript(progressTrackingPath, 'tasks.mjs');
  if (!existsSync(tasks)) {
    const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
    if (existsSync(join(root, 'progress.md'))) gateCheck(home, root, progressTrackingPath, failures);
    return;
  }
  const paths = await runTasks(run, tasks, ['paths', '--json'], cwd);
  if (paths.code === 2) {
    if (paths.stderr.includes(NOT_OPTED_IN)) return;
    failures.push(`triqual tasks paths failed: ${firstLine(paths.stderr)}`); // a usage error, say: not "not opted in"
    return;
  }
  let t = null;
  try {
    t = paths.code === 0 ? JSON.parse(paths.stdout) : null;
  } catch { /* reported below */ }
  const unexpected = () => {
    const detail = paths.code === 0 ? 'printed an unexpected result' : `failed (exit ${paths.code}): ${firstLine(paths.stderr)}`;
    failures.push(`triqual tasks paths --json ${detail}: reinstall ${idOf(home, 'progress-tracking')}`);
  };
  const reportsOptIn = t !== null && typeof t === 'object' && Object.hasOwn(t, 'optedIn');
  const hookLines = reportsOptIn ? pathsFacts(t) : LOCAL_HOOKS;
  if (reportsOptIn && (hookLines === null || typeof t.optedIn !== 'boolean')) {
    unexpected();
    return;
  }
  if (t?.optedIn === false) return;
  if (!['committed', 'local', 'store'].includes(t?.mode) || typeof t.root !== 'string') {
    unexpected();
    return;
  }
  let storeAvailable = true;
  if (t.mode === 'committed') {
    gateCheck(home, t.root, progressTrackingPath, failures);
    agentsMdCheck(t.root, warnings);
  } else if (t.mode === 'store') {
    storeAvailable = await storeChecks({
      cwd, root: t.root, store: typeof t.store === 'string' ? t.store : null,
      tracking: ptScript(progressTrackingPath, 'tracking.mjs'), run,
    }, failures, warnings);
  } else {
    localChecks(home, cwd, t.root, progressTrackingPath, hookLines, failures, warnings);
  }
  if (t.duplicate === true) {
    failures.push('both committed and local tracking exist: run triqual progress-init --local --remove');
  }
  if (!storeAvailable) return; // the store FAIL above says it; `tasks check` would repeat it
  const check = await runTasks(run, tasks, ['check'], cwd);
  if (check.code === 1) {
    const lines = check.stdout.split('\n').filter((line) => line.trim() !== '');
    failures.push(`triqual tasks check found drift: ${lines.join('; ')}: run triqual tasks render or fix the plan/ledger drift`);
  } else if (check.code !== 0) {
    failures.push(`triqual tasks check failed (exit ${check.code}): ${firstLine(check.stderr)}: run triqual tasks check for details`);
  }
}

// progress-tracking's init writes its managed section between these markers (scripts/init.mjs START and END).
const TRACKING_START = '<!-- progress-tracking:start';
const TRACKING_END = '<!-- progress-tracking:end -->';

// Committed mode: a repo's own AGENTS.md (exact name) should carry the tracking section too, for Codex (F.5).
function agentsMdCheck(root, warnings) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  if (!names.includes('AGENTS.md')) return;
  const path = join(root, 'AGENTS.md');
  const text = readText(path);
  if (text === null) return;
  const start = text.indexOf(TRACKING_START);
  if (start !== -1 && text.indexOf(TRACKING_END) > start) return;
  warnings.push(`${path} has no progress-tracking section: `
    + 'run triqual progress-init to add the tracking section to AGENTS.md');
}

// ---- per set-up harness (spec Addendum F.5) ----

const HARNESS_TIMEOUT_MS = 10000;
// progress-tracking before 0.2.3 ignores the gate's --budget (F.3), which triqual hook passes; before 0.2.4 its task roles
// lack roles:complex-implementer, so `triqual tasks check` flags the tasks methodology 0.3.4 dispatches to it.
const MIN_TRACKING_VERSION = '0.2.4';
const TRUST_FIX = 'start Codex and approve the triqual hooks in its trust prompt';
const STAMP_WARNING = 'no methodology hook has run since the bridge was installed or updated: '
  + 'start Codex and approve its hooks if prompted';
const GROK_COMPAT_WARNING = "Grok's Claude compatibility for hooks is off: the progress gate does not run in Grok";
const GROK_UNKNOWN = 'cannot tell whether Grok runs the progress gate';
// Grok's Claude compatibility ignores enabledPlugins (F.3, F.11): a plugin disabled in Claude still loads there.
const grokStillLoads = (id) => `plugin ${id} is disabled in Claude, but Grok's Claude compatibility still loads its `
  + 'hooks and skills (it ignores enabledPlugins): it still runs in Grok';
const TRUST_HEADER = /^\[\s*hooks\.state\."([^"]*)"\s*\]\s*(?:#.*)?$/;
// Any table or array-of-tables header line: dotted bare/quoted keys in one or two brackets. An array continuation
// line inside a table (`[1, 2],`, `["a", "b"]`) is not one, so it never ends the current table.
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TABLE_HEADER = new RegExp(String.raw`^\[\[?\s*${KEY_PART}(?:\s*\.\s*${KEY_PART})*\s*\]\]?\s*(?:#.*)?$`);
const REMOTE_WARNING = 'looks remotely managed: disable it in Codex itself; triqual sync cannot';
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const syncFix = (id) => `run triqual sync --harness ${id}`;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// One harness CLI call: { code, stdout }; a run that throws reads as 127. stderr is never kept, so no harness output
// reaches a doctor line.
async function harnessCli(run, cmd, args, cwd) {
  try {
    const r = await run(cmd, args, { timeoutMs: HARNESS_TIMEOUT_MS, cwd });
    return { code: r?.code ?? 1, stdout: typeof r?.stdout === 'string' ? r.stdout : '' };
  } catch {
    return { code: 127, stdout: '' };
  }
}

// A harness CLI call's parsed JSON, or null after reporting the call failed or printed no JSON. With `notFound` ({
// warnings, unknown }), an exit 127 (the CLI is not on PATH) is the warning `<what> failed (exit 127): <unknown>` in
// its warnings instead of a failure: the harness is set up but its CLI cannot be asked.
async function harnessJson(run, cmd, args, cwd, failures, notFound = null) {
  const r = await harnessCli(run, cmd, args, cwd);
  const what = `${cmd} ${args.join(' ')}`;
  const fix = `check that ${cmd} runs, then run triqual doctor again`;
  if (r.code === 127 && notFound !== null) {
    notFound.warnings.push(`${what} failed (exit 127): ${notFound.unknown}`);
    return null;
  }
  if (r.code !== 0) {
    failures.push(`${what} failed (exit ${r.code}): ${fix}`);
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    failures.push(`${what} printed no JSON: ${fix}`);
    return null;
  }
}

// True when the `x.y.z` version is older than `min`. A missing or unparseable version is not compared (it passes):
// pluginChecks already reports a broken install. Only the leading x.y.z counts, so `0.2.3-rc` compares as 0.2.3.
function olderThan(version, min) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : '')?.slice(1).map(Number) ?? null;
  const a = parse(version);
  const b = parse(min);
  if (a === null) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function readBytes(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// ~/.local/bin/triqual-hook must be there and equal (sha256) to the launcher the installed methodology ships in its
// setup/ (what the shim step copies); an install that predates setup/ is compared with the marketplace clone's
// plugins/methodology/setup/triqual-hook instead. `installs` is userInstalls(home).
function launcherCheck(home, installs, failures, warnings) {
  const launcher = join(home, '.local', 'bin', BRAND.launcher);
  const mine = readBytes(launcher);
  if (mine === null) {
    failures.push(`the hook launcher ${launcher} is missing: run node bin/bootstrap.mjs`);
    return;
  }
  const installedPath = installs.methodology?.installPath;
  let source = typeof installedPath === 'string' ? join(installedPath, 'setup', BRAND.launcher) : null;
  let theirs = source === null ? null : readBytes(source);
  let error;
  if (theirs === null) {
    const located = marketplaceLocation(home);
    error = located.error;
    source = located.location ? join(located.location, 'plugins', 'methodology', 'setup', BRAND.launcher) : null;
    theirs = source === null ? null : readBytes(source);
  }
  if (theirs === null) {
    const marketplace = activeMarketplace(home);
    warnings.push(`cannot compare the hook launcher ${launcher} with the ${marketplace} marketplace copy: `
      + `${error ?? `cannot read ${source}`}: run claude plugin marketplace update ${marketplace}`);
  } else if (sha256(mine) !== sha256(theirs)) {
    failures.push(`the hook launcher ${launcher} differs from the marketplace copy ${source}: `
      + 'rerun node bin/bootstrap.mjs');
  }
}

function versionCheck(home, installs, failures) {
  const version = installs['progress-tracking']?.version;
  if (olderThan(version, MIN_TRACKING_VERSION)) {
    failures.push(`${idOf(home, 'progress-tracking')} is ${version}, older than ${MIN_TRACKING_VERSION}: `
      + "update progress-tracking: an older one ignores the gate's --budget or flags roles:complex-implementer");
  }
}

// Trust (F.11 P5f: `codex doctor --json` does not report it): for each of our two keys, a `[hooks.state."<key>"]`
// header followed, within its table, by a `trusted_hash` key. Only those lines are looked at; no value is kept or
// printed, and no hash is computed.
function codexTrustCheck(home, path, failures) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    failures.push(`${err.code === 'ENOENT' ? `${path} does not exist` : `cannot read ${path}`}: ${TRUST_FIX}`);
    return;
  }
  const keys = codexTrustKeys(home);
  const bridge = bridgeId(home);
  const trusted = new Set();
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (TABLE_HEADER.test(line)) {
      const m = TRUST_HEADER.exec(line);
      current = m !== null && keys.includes(m[1]) ? m[1] : null;
    } else if (current !== null && /^trusted_hash\s*=/.test(line)) {
      trusted.add(current);
    }
  }
  for (const key of keys) {
    if (trusted.has(key)) continue;
    failures.push(`Codex has not trusted the ${key.split(':')[2]} hook of ${bridge} `
      + `(no trusted_hash under its [hooks.state] table in ${path}): ${TRUST_FIX}`);
  }
}

// Header and hash presence cannot show a hash gone stale after a bridge release: no last-run-codex stamp, or one
// older than the installed bridge dir, warns.
function codexStampCheck(home, warnings) {
  const mtime = (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  const stamp = mtime(join(brandDir(join(home, '.local', 'state')), 'last-run-codex'));
  const bridge = mtime(codexBridgeDir(home));
  if (stamp === null || (bridge !== null && stamp < bridge)) warnings.push(STAMP_WARNING);
}

// ~/.codex/AGENTS.md: the managed section must hold what triqual sync writes (global.md plus the Codex note).
function codexRulesCheck(home, path, methodologyPath, failures) {
  const fix = syncFix('codex');
  let expected;
  try {
    expected = expectedRules(methodologyPath, 'codex').trim();
  } catch (err) {
    failures.push(`cannot read the Codex rules of ${methodologyPath}: ${err.message}: `
      + `reinstall ${idOf(home, 'methodology')}`);
    return;
  }
  const text = readText(path);
  if (text === null) {
    failures.push(`${path} is missing or unreadable: ${fix}`);
    return;
  }
  const { body, error } = readManagedSection(text);
  if (error) {
    failures.push(`the managed section of ${path} is ${error}: fix the triqual markers by hand, then ${fix}`);
    return;
  }
  const legacy = unsplitHeadings(home, text, methodologyPath, []); // an unreadable list is reported by the Claude check
  if (legacy === null) return;
  if (legacy.length > 0) {
    failures.push(`${path} is not split, legacy headings sit outside the managed section (${legacy.join(', ')}): `
      + `${fix} on a terminal to split it`);
  } else if (body === null) {
    failures.push(`${path} has no triqual managed section: ${fix}`);
  } else if (body !== expected) {
    failures.push(`the managed section of ${path} differs from what triqual sync writes: ${fix}`);
  }
}

// The Codex skill links triqual sync wants (lib/harness-links.mjs wantedLinks). One triqual sync fixes a missing link, one of
// ours pointing elsewhere, a dangling one or one into a superseded cache; anything else is a collision sync leaves
// alone, listed with its fix.
function codexLinksCheck({ home, dir, installs, patterns, keepSuperseded }, failures) {
  const fix = syncFix('codex');
  let want;
  try {
    want = wantedLinks(installs);
  } catch (err) {
    failures.push(`cannot list the skills to link: ${err.message}: reinstall ${idOf(home, 'methodology')}`);
    return;
  }
  let records = [];
  try {
    records = readManifest(home).harnesses.codex?.links ?? [];
  } catch { /* an unreadable manifest records nothing doctor can trust */ }
  const stale = [];
  for (const [name, target] of want) {
    const path = join(dir, name);
    let cur;
    try {
      cur = linkState(path);
    } catch {
      cur = { kind: 'other' };
    }
    if (cur.kind === 'link' && cur.text === target) continue;
    const replaceable = cur.kind === 'link' && (cur.dangling
      || (Array.isArray(records) && records.some((l) => l?.path === path && l.target === cur.text))
      || (!keepSuperseded && inSupersededCache(home, cur.abs, patterns)));
    if (cur.kind === 'missing' || replaceable) {
      stale.push(name);
    } else {
      failures.push(`${path} is not a triqual link, so triqual sync leaves it alone and skill ${name} is not `
        + `linked in Codex: move or remove it, then ${fix}`);
    }
  }
  if (stale.length) failures.push(`Codex skill links in ${dir} are missing or out of date (${stale.join(', ')}): ${fix}`);
}

// The Codex role agents, while methodology and roles are enabled in Claude: each must equal what triqual sync generates.
// A hand-written file of the same name is backed up and replaced by sync, which the fix says.
function codexAgentsCheck(home, dir, installs, failures) {
  const roles = installs.roles;
  if (!installs.methodology?.enabled || !roles?.enabled) return;
  const fix = syncFix('codex');
  const source = join(roles.installPath, 'agents');
  if (typeof roles.version !== 'string' || roles.version === '') {
    failures.push(`the roles install has no version in installed_plugins.json: reinstall ${idOf(home, 'roles')}`);
    return;
  }
  let files;
  try {
    files = readdirSync(source).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    failures.push(`cannot read the role agents in ${source}: ${err.message}: reinstall ${idOf(home, 'roles')}`);
    return;
  }
  const stale = [];
  for (const file of files) {
    let role;
    let expected;
    try {
      role = parseRole(readFileSync(join(source, file), 'utf8'));
      expected = codexAgentText(role, roles);
    } catch (err) {
      failures.push(`cannot read the role ${join(source, file)}: ${err.message}: reinstall ${idOf(home, 'roles')}`);
      continue;
    }
    if (!SAFE_NAME.test(role.name)) continue; // triqual sync refuses it and says so
    const path = join(dir, `${role.name}.toml`);
    const current = readText(path);
    if (current === expected) continue;
    if (current !== null && !isGenerated(current)) {
      failures.push(`${path} is not generated by triqual: ${fix} `
        + `(it backs the file up, then writes role ${role.name})`);
    } else {
      stale.push(role.name);
    }
  }
  if (stale.length) failures.push(`Codex role agents in ${dir} are missing or out of date (${stale.join(', ')}): ${fix}`);
}

// The config.toml tables whose `enabled = false` triqual sync recorded in the manifest (never config.toml itself).
function codexDisabledBySync(home) {
  let records = [];
  try {
    records = readManifest(home).harnesses.codex?.config ?? [];
  } catch { /* an unreadable manifest records nothing doctor can trust */ }
  return new Set((Array.isArray(records) ? records : [])
    .filter((c) => isObject(c) && c.key === 'enabled' && typeof c.table === 'string').map((c) => c.table));
}

async function codexChecks(ctx, failures, warnings) {
  const { home, run, installs, config, patterns } = ctx;
  const paths = harnessPaths(home, 'codex');
  const fix = syncFix('codex');
  const listed = await harnessJson(run, 'codex', ['plugin', 'list', '--json'], home, failures);
  if (listed !== null) {
    const plugins = Array.isArray(listed?.installed) ? listed.installed.filter(isObject) : [];
    const bridgePluginId = bridgeId(home);
    const bridge = plugins.find((p) => p.pluginId === bridgePluginId);
    // Without the clone of its marketplace, sync cannot add the bridge: that is the migration's to do.
    if (!bridge) failures.push(`the Codex bridge ${bridgePluginId} is not installed: ${existsSync(codexCloneDir(home)) ? fix : LEGACY_FIX}`);
    else if (bridge.enabled !== true) failures.push(`the Codex bridge ${bridgePluginId} is not enabled: ${fix}`);
    const disabled = codexDisabledBySync(home);
    for (const id of supersededEnabled(patterns, codexEnabledMap(plugins))) {
      if (config.keepSuperseded) {
        warnings.push(`superseded plugin ${id} is enabled in Codex by keepSuperseded in ${configPath(home)}: `
          + `remove that setting and ${fix} to use methodology alone`);
      } else if (disabled.has(codexPluginTable(id))) {
        // triqual sync recorded its `enabled = false` in config.toml, yet Codex lists the plugin enabled: sync cannot help.
        warnings.push(`superseded plugin ${id} is still enabled in Codex after triqual sync disabled it: ${REMOTE_WARNING}`);
      } else {
        failures.push(`superseded plugin ${id} is still enabled in Codex: ${fix}`);
      }
    }
  }
  const features = await harnessCli(run, 'codex', ['features', 'list'], home);
  if (features.code !== 0) {
    failures.push(`codex features list failed (exit ${features.code}): check that codex runs, then run triqual doctor again`);
  } else if (!hooksOn(features.stdout)) {
    failures.push(`the Codex hooks feature is off: ${fix}`);
  }
  codexTrustCheck(home, paths.config, failures);
  codexStampCheck(home, warnings);
  const methodologyPath = installs.methodology?.installPath ?? null;
  if (methodologyPath === null) return; // the missing plugin is already reported
  codexRulesCheck(home, paths.rules, methodologyPath, failures);
  codexLinksCheck({ home, dir: paths.skills, installs, patterns, keepSuperseded: config.keepSuperseded }, failures);
  codexAgentsCheck(home, paths.agents, installs, failures);
}

// Grok's own copies triqual sync uninstalls: only `grok plugin list --json` entries whose real path lies under
// ~/.grok/installed-plugins/ count (never the Claude-compat plugins, never config.toml), as in triqual sync. With grok
// off PATH (exit 127) the check cannot run: one warning, like the gate check's, never a failure.
async function grokStaleCheck({ home, run, config }, failures, warnings) {
  const unknown = 'cannot tell whether stale Grok plugins are installed';
  const listed = await harnessJson(run, 'grok', ['plugin', 'list', '--json'], home, failures, { warnings, unknown });
  if (listed === null) return;
  for (const p of grokStaleEntries(home, listed, config.keepSuperseded).stale) {
    failures.push(`stale Grok plugin ${p.name} is installed: ${syncFix('grok')}`);
  }
}

// Grok runs the progress gate through Claude compatibility (F.11): `grok inspect --json`, run in a fresh scratch dir
// (removed afterwards), must list in hooks[] Claude's progress-tracking hooks file: an entry whose source.plugin_name
// is progress-tracking and whose `target` (the hooks file; the real entries are {event, hookType, matcher, source:
// {type, plugin_name, path}, target}) is absolute under ~/.claude/plugins/. The same listing of methodology's or
// progress-tracking's hooks file while that plugin is disabled in Claude warns too: that loader ignores enabledPlugins.
// The output can hold config and environment details: it is only parsed here, never printed or logged; every outcome
// is a fixed line.
async function grokGateCheck({ home, run, installs }, warnings) {
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), `${BRAND.cli}-doctor-grok-`));
  } catch {
    warnings.push(`cannot create a scratch dir for grok inspect: ${GROK_UNKNOWN}`);
    return;
  }
  let r;
  try {
    r = await harnessCli(run, 'grok', ['inspect', '--json'], scratch);
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch { /* a scratch dir left in the temp dir never fails doctor */ }
  }
  if (r.code !== 0) {
    warnings.push(`grok inspect --json failed (exit ${r.code}): ${GROK_UNKNOWN}`);
    return;
  }
  let hooks;
  try {
    hooks = JSON.parse(r.stdout)?.hooks;
  } catch {
    warnings.push(`grok inspect --json printed no JSON: ${GROK_UNKNOWN}`);
    return;
  }
  const base = join(home, '.claude', 'plugins');
  const bases = [base + sep, realOrSelf(base) + sep];
  const listed = (name) => Array.isArray(hooks) && hooks.some((h) => isObject(h) && isObject(h.source)
    && h.source.plugin_name === name && typeof h.target === 'string' && isAbsolute(h.target)
    && bases.some((b) => resolve(h.target).startsWith(b)));
  if (!listed('progress-tracking')) warnings.push(GROK_COMPAT_WARNING);
  for (const name of ['methodology', 'progress-tracking']) {
    if (installs[name]?.enabled === false && listed(name)) warnings.push(grokStillLoads(idOf(home, name)));
  }
}

async function grokChecks(ctx, failures, warnings) {
  const { home, installs } = ctx;
  const paths = harnessPaths(home, 'grok');
  const fix = syncFix('grok');
  // A file under the pre-rename name, which loads in Grok beside ours, is the legacy scan's failure.
  if (readText(paths.hooksFile) !== grokHooksFile(join(home, '.local', 'bin', BRAND.launcher))) {
    failures.push(`${paths.hooksFile} is missing or differs from what triqual sync writes: ${fix}`);
  }
  // triqual sync removes the rules file while methodology is disabled in Claude, so it is expected only while enabled.
  const methodology = installs.methodology;
  if (methodology?.enabled) {
    let expected = null;
    try {
      expected = expectedRules(methodology.installPath, 'grok');
    } catch (err) {
      failures.push(`cannot read the Grok rules of ${methodology.installPath}: ${err.message}: `
        + `reinstall ${idOf(home, 'methodology')}`);
    }
    if (expected !== null && readText(paths.rules) !== expected) {
      failures.push(`${paths.rules} is missing or differs from what triqual sync writes: ${fix}`);
    }
  }
  await grokStaleCheck(ctx, failures, warnings);
  await grokGateCheck(ctx, warnings);
}

// Each harness with harnesses.<id>.enabled in config.json: one that `detect` finds absent gives a single line and no
// check; for the others, the launcher and the progress-tracking version once, then the harness's own checks.
async function harnessChecks({ home, run, config }, failures, warnings) {
  const ids = HARNESS_IDS.filter((id) => config.harnesses[id]?.enabled === true);
  if (ids.length === 0) return;
  const found = await detect({ home, run });
  const present = ids.filter((id) => {
    const here = found.find((h) => h.id === id)?.present === true;
    if (!here) warnings.push(`harness ${id}: not installed (skipped)`);
    return here;
  });
  if (present.length === 0) return;
  const installs = userInstalls(home);
  const methodologyPath = installs.methodology?.installPath ?? null;
  const patterns = (methodologyPath === null ? null : supersedesPatterns(home, methodologyPath, [])) ?? [];
  const ctx = { home, run, config, installs, patterns };
  launcherCheck(home, installs, failures, warnings);
  versionCheck(home, installs, failures);
  if (present.includes('codex')) await codexChecks(ctx, failures, warnings);
  if (present.includes('grok')) await grokChecks(ctx, failures, warnings);
}

// The live leftovers of the legacy name (lib/legacy-scan.mjs), each with the fix the scan gives it (`triqual migrate`
// where migrate clears it, else the command or edit that does); the ones kept on purpose as one warning line with their
// count, and a file the scan could not read as its own warning, since it is not a kept item. The scan owns the leftover
// Grok files and an older file in place of the alias or the forwarder, which no other check reports.
const LEGACY_FIX = `run ${BRAND.cli} migrate`;
function legacyChecks(home, failures, warnings) {
  const { failures: found, exempt, fixes } = legacyScan(home);
  for (const line of found) failures.push(`${line}: ${fixes[line]}`);
  const kept = exempt.filter((line) => !isUnreadable(line));
  warnings.push(...exempt.filter(isUnreadable));
  if (kept.length > 0) {
    warnings.push(`${kept.length} legacy items kept on purpose (cm alias, compatibility links, old caches, backups)`);
  }
}

export async function doctor({ home, cwd, repo = false, run }) {
  const failures = [];
  const warnings = [];
  nodeCheck(process.versions.node, failures);
  const installs = pluginChecks(home, failures, warnings);
  const settings = settingsChecks(home, failures);
  const config = readMethodologyConfig(home);
  if (config.error) warnings.push(`${config.error}: triqual sync disables nothing until it is fixed or removed`);
  if (installs.methodology !== null) {
    rulesCheck(home, installs.methodology, failures);
    supersededCheck(home, installs.methodology, settings, config, failures, warnings);
  }
  shimCheck(home, installs, failures);
  agentChecks(home, failures);
  legacyChecks(home, failures, warnings);
  await headjackCheck(run, warnings);
  if (!config.error) await harnessChecks({ home, run, config }, failures, warnings);
  if (repo && installs.methodology !== null && !config.keepSuperseded) {
    projectSupersededCheck(home, cwd, installs.methodology, warnings);
  }
  if (!repo) return { failures, warnings };
  await repoChecks(home, cwd, installs['progress-tracking'], run, failures, warnings);
  return { failures, warnings, notes: await trackingModes(installs['progress-tracking'], run, cwd) };
}

// The CLI's run lives in lib/run.mjs (triqual sync uses it too); doctor keeps exporting it for bootstrap.
export { realRun };

const USAGE = `usage: triqual doctor [--repo]
  --repo      also check the current repo's tracking: its git gate (store mode: the store hook scripts and their chain,
              the store's health and its newest snapshot), a duplicate tracking root, triqual tasks check drift, the
              AGENTS.md tracking section; and list the tracking mode of every registered repo (INFO lines)
  -h, --help  print this help`;

// --help/-h wins; --repo is the only other argument accepted.
function parseCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const unknown = argv.find((a) => a !== '--repo');
  if (unknown !== undefined) return { error: `triqual doctor: unknown argument ${unknown}` };
  return { repo: argv.includes('--repo') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = parseCli(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
  } else if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    const { failures, warnings, notes = [] } = await doctor({
      home: homedir(), cwd: process.cwd(), repo: args.repo, run: realRun,
    });
    for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
    for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
    for (const n of notes) process.stdout.write(`INFO ${n}\n`);
    process.stdout.write(`doctor: ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  }
}
