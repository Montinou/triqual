// legacyScan(home): the live leftovers of the legacy name on a machine (failures) and the ones kept on purpose
// (exempt), for doctor and for migrate's verify step (spec 4.5). It scans exactly the places listed below and nothing
// else: a file it does not name is never read, so a path keyed by the clone's old directory name (Codex's projects
// tables, repos.json, triqual.mjs) is never flagged. It only reads. A file that cannot be read or parsed is the exempt
// line `could not read <path>`, never a throw, and no line carries a file's contents beyond the key, id or table name
// it is about. `fixes` maps each failure line to its fix: `run triqual migrate` where migrate clears it, else the
// command or edit that does (migrate cannot clear a permission rule, an unsplit managed section, legacy Codex tables
// when it cannot run codex, an install whose marketplace is no longer known, an older CLI file outside bootstrap, or
// something else at a legacy dir path, a real legacy dir beside its new one), so no fix points back to a migrate that
// would leave the line as it is.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { BRAND } from './brand.mjs';
import { legacyCliPresent, ownsCliFile } from './cli-files.mjs';
import { manifestPath } from './harness-manifest.mjs';
import { harnessPaths } from './harnesses.mjs';
import { readMethodologyConfig } from './settings.mjs';
import { tableNames } from './toml-edit.mjs';

const L = BRAND.legacy;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const legacyId = (id) => typeof id === 'string' && (id === L.marketplace || id.endsWith(`@${L.marketplace}`));
const UNREADABLE = 'could not read ';
const GROK_LEFTOVER = ' is a legacy-named Grok file';
const MIGRATE = `run ${BRAND.cli} migrate`;
const BOOTSTRAP = 'run /methodology:setup (or node bin/bootstrap.mjs from a clone)';
const fail = (out, line, fix = MIGRATE) => {
  out.failures.push(line);
  out.fixes[line] = fix;
};
const unreadable = (path) => `${UNREADABLE}${path}`;
// Doctor reports an unreadable file as its own warning, not as a kept item, and gives a leftover Grok file its own fix.
export const isUnreadable = (line) => line.startsWith(UNREADABLE);
export const isGrokLeftover = (line) => line.endsWith(GROK_LEFTOVER);
// A permission rule names the legacy marketplace as a plugin id's suffix or as its plugin cache or marketplace dir; a
// path that only contains the name (the clone's own directory) does not.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEGACY_RULE = new RegExp(`(?:@|\\.claude/plugins/(?:cache|marketplaces)/)${escapeRe(L.marketplace)}(?![\\w.-])`);

// The file's text, or null when it does not exist; any other read error is reported and also gives null.
function readText(path, out) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') out.exempt.push(unreadable(path));
    return null;
  }
}

// The parsed object, or null when the file is missing, unreadable or unparsable (the last two reported). A file
// of another shape has nothing to scan.
function readObject(path, out) {
  const text = readText(path, out);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    out.exempt.push(unreadable(path));
    return null;
  }
}

const keysOf = (value) => (isObject(value) ? Object.keys(value) : []);

// The parsed object, or null, with nothing reported: for deciding a fix, never for a line of its own.
function quietObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

// The legacy tables of a Codex config.toml text: the `[plugins."<id>@<legacy>"]` ids and whether
// `[marketplaces.<legacy>]` is there. Migrate removes exactly these through `codex plugin`.
export function legacyCodexTables(text) {
  const out = { plugins: [], marketplace: false };
  for (const name of tableNames(text)) {
    const [head, second, ...rest] = keyParts(name);
    if (rest.length !== 0) continue;
    if (head === 'marketplaces' && second === L.marketplace) out.marketplace = true;
    else if (head === 'plugins' && second?.endsWith(`@${L.marketplace}`)) out.plugins.push(second);
  }
  return out;
}

function codexTablesLeft(home) {
  let text;
  try {
    text = readFileSync(harnessPaths(home, 'codex').config, 'utf8');
  } catch {
    return false;
  }
  const tables = legacyCodexTables(text);
  return tables.marketplace || tables.plugins.length > 0;
}

function settingsScan(home, out) {
  const path = join(home, '.claude', 'settings.json');
  const settings = readObject(path, out);
  if (!settings) return;
  for (const id of keysOf(settings.enabledPlugins).filter((k) => k.endsWith(`@${L.marketplace}`))) {
    fail(out, `${path} enables ${id}`);
  }
  if (Object.hasOwn(isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {}, L.marketplace)) {
    fail(out, `${path} lists the marketplace ${L.marketplace} in extraKnownMarketplaces`);
  }
  // A rule's text may hold anything, so it is named by its place. The `Bash(cm …)` rules never name the marketplace,
  // and additionalDirectories holds directories, not rules.
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  for (const [list, rules] of Object.entries(permissions)) {
    if (!Array.isArray(rules) || list === 'additionalDirectories') continue;
    rules.forEach((rule, i) => {
      if (typeof rule === 'string' && LEGACY_RULE.test(rule)) {
        const place = `permissions.${list}[${i}]`;
        fail(out, `${path} has a permission rule naming ${L.marketplace} (${place})`, `remove ${place} from ${path}`);
      }
    });
  }
}

function pluginFilesScan(home, out) {
  const plugins = join(home, '.claude', 'plugins');
  const installedPath = join(plugins, 'installed_plugins.json');
  const installed = readObject(installedPath, out);
  const knownPath = join(plugins, 'known_marketplaces.json');
  // Migrate moves an install only through its marketplace: without it, the fix is the uninstall itself.
  const legacyKnown = Object.hasOwn(quietObject(knownPath) ?? {}, L.marketplace);
  // An entry of a project that no longer exists is inert (nothing loads it, no command can run in it): kept, not failed.
  const inert = (e) => e.scope && e.scope !== 'user' && typeof e.projectPath === 'string' && !existsSync(e.projectPath);
  for (const id of keysOf(installed?.plugins).filter((k) => k.endsWith(`@${L.marketplace}`))) {
    const entries = (Array.isArray(installed.plugins[id]) ? installed.plugins[id] : []).filter(isObject);
    for (const e of entries.filter(inert)) {
      out.exempt.push(`${installedPath} installs ${id} for ${e.projectPath}, which no longer exists`);
    }
    const live = entries.filter((e) => !inert(e));
    if (entries.length > 0 && live.length === 0) continue;
    const uninstall = live.map((e) => `run claude plugin uninstall ${id} --scope ${e.scope ?? 'user'}`
      + (e.scope && e.scope !== 'user' && typeof e.projectPath === 'string' ? ` in ${e.projectPath}` : ''));
    fail(out, `${installedPath} installs ${id}`, legacyKnown || uninstall.length === 0 ? MIGRATE : uninstall.join('; '));
  }
  const known = readObject(knownPath, out);
  if (known && Object.hasOwn(known, L.marketplace)) {
    fail(out, `${knownPath} still knows the marketplace ${L.marketplace}`);
  }
}

// A managed section under the legacy markers reads as current to drift, so the markers alone are the failure.
// Sync rewrites such a section in place (and says so when its gate refuses first); Codex's one-time AGENTS.md split asks
// on a terminal.
function markersScan(home, out) {
  const files = [
    [join(home, '.claude', 'CLAUDE.md'), `run ${BRAND.cli} sync`],
    [harnessPaths(home, 'codex').rules, `run ${BRAND.cli} sync --harness codex in a terminal`],
  ];
  for (const [path, fix] of files) {
    const text = readText(path, out);
    if (text !== null && (text.includes(L.markers.start) || text.includes(L.markers.end))) {
      fail(out, `${path} holds the ${L.marketplace} managed markers`, fix);
    }
  }
}

// The dotted parts of a normalized table name, quotes removed.
function keyParts(name) {
  const parts = [];
  let part = '';
  let quote = null;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && i + 1 < name.length) part += name[++i];
      else part += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '.') {
      parts.push(part);
      part = '';
    } else {
      part += c;
    }
  }
  parts.push(part);
  return parts;
}

// [marketplaces.<legacy>] and [plugins."<x>@<legacy>"] are failures; [hooks.state.*] tables naming the legacy
// marketplace are Codex's own and exempt; [projects.*] and every other table are not scanned.
// The fix is the `codex plugin` command that removes the table: migrate runs it only for a Codex set up in
// harnesses.json and only when codex is on PATH, and the command works in every case.
function codexConfigScan(home, out) {
  const path = harnessPaths(home, 'codex').config;
  const text = readText(path, out);
  if (text === null) return;
  for (const name of tableNames(text)) {
    const [head, second, ...rest] = keyParts(name);
    if (rest.length === 0 && head === 'marketplaces' && second === L.marketplace) {
      fail(out, `${path} has the table [${name}]`, `run codex plugin marketplace remove ${second}`);
    } else if (rest.length === 0 && head === 'plugins' && second?.endsWith(`@${L.marketplace}`)) {
      fail(out, `${path} has the table [${name}]`, `run codex plugin remove ${second}`);
    } else if (head === 'hooks' && second === 'state' && name.includes(L.marketplace)) {
      out.exempt.push(`${path} has the Codex-owned table [${name}]`);
    }
  }
}

// The names in dir, or [] when it does not exist (any other error reported).
function entries(dir, out) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') out.exempt.push(unreadable(dir));
    return [];
  }
}

function grokScan(home, out) {
  const paths = harnessPaths(home, 'grok');
  for (const dir of [join(paths.dir, 'hooks'), join(paths.dir, 'rules')]) {
    for (const name of entries(dir, out)) {
      if (name === L.grokName || name.startsWith(`${L.grokName}.`)) {
        fail(out, `${join(dir, name)}${GROK_LEFTOVER}`); // migrate removes it, with Grok set up or not
      }
    }
  }
}

// Whether an executable `codex` sits in a PATH directory (migrate asks `codex features list` instead; it exits 127 when
// there is none, which is the same question): a regular file (a symlink to one counts) that this user may execute, so a
// directory or a plain file named codex is not on PATH.
const isExecutableFile = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const codexOnPath = (env) => (env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && isExecutableFile(join(dir, 'codex')));

// Recorded ids under the legacy marketplace are failures; backup paths under ~/.claude/backups/<legacy>-* are exempt.
// Migrate leaves the records of a set-up Codex alone while it cannot run codex, so with codex off PATH its fix names that.
function manifestScan(home, out, env) {
  const path = manifestPath(home);
  const manifest = readObject(path, out);
  if (!manifest || !isObject(manifest.harnesses)) return;
  const backups = join(home, '.claude', 'backups') + sep;
  // Migrate rewrites Codex's records only once its legacy tables are gone.
  const config = harnessPaths(home, 'codex').config;
  const waits = codexTablesLeft(home);
  const codexNeedsPath = !waits && readMethodologyConfig(home).harnesses.codex?.enabled !== false && !codexOnPath(env);
  for (const [harness, entry] of Object.entries(manifest.harnesses)) {
    if (!isObject(entry)) continue;
    for (const rec of Array.isArray(entry.plugins) ? entry.plugins : []) {
      const id = rec?.id ?? rec?.name;
      if (!legacyId(id)) continue;
      fail(out, `${path} records the id ${id}`,
        harness !== 'codex' ? MIGRATE
          : waits ? `once ${config} has no ${L.marketplace} table, ${MIGRATE}`
            : codexNeedsPath ? `put codex on PATH, then ${MIGRATE}` : MIGRATE);
    }
    for (const rec of Array.isArray(entry.files) ? entry.files : []) {
      const backup = rec?.backup;
      if (typeof backup === 'string' && backup.startsWith(backups)
        && backup.slice(backups.length).startsWith(`${L.dir}-`)) {
        out.exempt.push(`${path} records the backup ${backup}`);
      }
    }
  }
}

// Line 2 of the file, or null when it does not exist (any other read error reported).
function line2(path, out) {
  const text = readText(path, out);
  return text === null ? null : (text.split('\n')[1] ?? '');
}

// The legacy CLI file and launcher must be the alias and the forwarder; an older shim or launcher left there is a
// failure. A missing one is doctor's shim check, and the cm link, triqual.mjs and triqual-hook are not content-scanned.
// Only on a machine with a legacy CLI file of ours (legacyCliPresent): on any other, a file at those names is someone
// else's, and the alias was never installed next to it.
function binScan(home, out) {
  if (!legacyCliPresent(home)) return;
  const bin = join(home, '.local', 'bin');
  const files = [
    [L.cliFile, BRAND.ownership.alias, `the ${L.cli} alias of ${BRAND.cli}`],
    [L.launcher, BRAND.ownership.forwarder, `the ${L.launcher} forwarder of ${BRAND.cli}`],
  ];
  for (const [name, ownership, what] of files) {
    const path = join(bin, name);
    const line = line2(path, out);
    if (line === null) continue;
    if (line === ownership) out.exempt.push(`${path} is ${what}`);
    // Bootstrap's install replaces an older file of ours (migrate run alone does not); anything else is moved first.
    else if (ownsCliFile(path) === 'ours') fail(out, `${path} is not ${what}`, BOOTSTRAP);
    else fail(out, `${path} is not ${what}`, `move ${path} aside, then ${BOOTSTRAP}`);
  }
}

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// The fix for a real legacy dir beside its new one, which migrate refuses to merge (its directories plan prints it
// too).
export const mergeByHand = (legacy, current) => `merge ${legacy} by hand into ${current}, remove ${legacy}, then run `
  + `${BRAND.cli} migrate again`;

// The legacy config, state and data entries. A link whose text points at the new dir is the compatibility link, also
// while the new dir is missing (brandDir writes it again on its next write); a real dir is migrate's to move; a link
// elsewhere or anything else is the user's to move aside, since migrate leaves it.
function dirsScan(home, out) {
  for (const base of [join(home, '.config'), join(home, '.local', 'state'), join(home, '.local', 'share')]) {
    const legacy = join(base, L.dir);
    const current = join(base, BRAND.dir);
    let info;
    try {
      info = lstatSync(legacy);
    } catch (err) {
      if (err.code !== 'ENOENT') out.exempt.push(unreadable(legacy));
      continue;
    }
    if (info.isSymbolicLink()) {
      if (isCompatLink(legacy, current)) out.exempt.push(`${legacy} is a compatibility link to ${current}`);
      else fail(out, `${legacy} is not a link to ${current}`, `move ${legacy} aside`);
    } else if (info.isDirectory()) {
      // Migrate never merges: beside an existing new dir, it refuses with this same instruction.
      const fix = exists(current) ? mergeByHand(legacy, current) : MIGRATE;
      fail(out, `${legacy} is a real directory, not a link to ${current}`, fix);
    } else {
      fail(out, `${legacy} is not a link to ${current}`, `move ${legacy} aside`);
    }
  }
}

// Whether the link at `legacy` points at `current`: by its text (resolved from the link's dir), dangling or not, or by
// both resolving to the same real dir.
export function isCompatLink(legacy, current) {
  let text;
  try {
    text = readlinkSync(legacy);
  } catch {
    return false;
  }
  if (resolve(join(legacy, '..'), text) === current) return true;
  const target = realOrNull(legacy);
  return target !== null && target === realOrNull(current);
}

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Kept by location: the old plugin caches, plugin data dirs and backups.
function keptScan(home, out) {
  for (const cache of [join(home, '.claude', 'plugins', 'cache', L.marketplace),
    join(home, '.codex', 'plugins', 'cache', L.marketplace)]) {
    if (exists(cache)) out.exempt.push(`${cache} is an old plugin cache`);
  }
  const data = join(home, '.claude', 'plugins', 'data');
  for (const name of entries(data, out).filter((n) => n.endsWith(`-${L.marketplace}`)).sort()) {
    out.exempt.push(`${join(data, name)} is left-over plugin data`);
  }
  const backups = join(home, '.claude', 'backups');
  for (const name of entries(backups, out).filter((n) => n.startsWith(`${L.dir}-`)).sort()) {
    out.exempt.push(`${join(backups, name)} is an old backup`);
  }
}

export function legacyScan(home, { env = process.env } = {}) {
  const out = { failures: [], exempt: [], fixes: {} };
  settingsScan(home, out);
  pluginFilesScan(home, out);
  markersScan(home, out);
  codexConfigScan(home, out);
  grokScan(home, out);
  manifestScan(home, out, env);
  binScan(home, out);
  dirsScan(home, out);
  keptScan(home, out);
  return out;
}
