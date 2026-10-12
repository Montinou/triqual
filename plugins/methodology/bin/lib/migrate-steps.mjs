// `triqual migrate` (spec 4): moves a machine from the legacy marketplace to BRAND.marketplace. MIGRATE_STEPS run in
// order (spec 4's steps, with the cli step moved before the marketplace step); each returns { status: 'done' |
// 'already' | 'skipped' | 'failed', detail } and is checked against the machine's files first, so a second run on a
// migrated home makes no `run` call and writes no file, and an interrupted run resumes at the first step with work
// left. The first failed step stops the run (the rest are skipped). Nothing is deleted before the backup step has
// copied it, and the backup runs only when a changing step has work: a leftover migrate cannot clear (verify names it
// with its own fix) never makes a new backup dir. Every claude/codex/grok call goes through the injected `run`;
// config.toml is never edited here (Codex through its CLI only, `[hooks.state]` never written), and the registered
// repos are only listed. node: built-ins only.
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync,
  symlinkSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { BRAND, brandDir, pluginId, readEnv } from './brand.mjs';
import { legacyCliPresent, ownsCliFile } from './cli-files.mjs';
import { backupDirFor, backupFile, locate } from './fsx.mjs';
import { manifestPath, readManifest, withManifest } from './harness-manifest.mjs';
import { syncHarness } from './harness-sync.mjs';
import { harnessPaths, HARNESS_IDS } from './harnesses.mjs';
import { isCompatLink, isUnreadable, legacyCodexTables, legacyScan, mergeByHand } from './legacy-scan.mjs';
import { editSettings, readMethodologyConfig } from './settings.mjs';
import { legacyHeadingsOutside, sync } from '../sync.mjs';

const L = BRAND.legacy;
const PLUGIN_TIMEOUT_MS = 300_000; // claude plugin install|uninstall and marketplace add|remove, as in bootstrap
const CODEX_TIMEOUT_MS = 60_000;
const BRIDGE_NAME = 'methodology-codex';
const TRACKING_LEGACY = `Bash(${L.cli} tracking write:*)`;
const TRACKING = `Bash(${BRAND.cli} tracking write:*)`;
const OWNER_STEP = "owner step: approve the methodology-codex hooks in Codex's trust prompt";
const RELOAD = 'run /reload-plugins in each open Claude Code session: its hooks run the old cache until then';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLegacyId = (id) => id.endsWith(`@${L.marketplace}`);
const nameOf = (id) => id.slice(0, id.lastIndexOf('@'));
const plugins = (home, file) => join(home, '.claude', 'plugins', file);
const settingsPath = (home) => join(home, '.claude', 'settings.json');
const claudeMdPath = (home) => join(home, '.claude', 'CLAUDE.md');
const binPath = (home, name) => join(home, '.local', 'bin', name);
const DIR_BASES = (home) => [join(home, '.config'), join(home, '.local', 'state'), join(home, '.local', 'share')];

class StepError extends Error {}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const known = (home) => {
  const value = readJson(plugins(home, 'known_marketplaces.json'));
  return isObject(value) ? value : {};
};

// installed_plugins.json's `plugins` map, {} when unreadable.
const installedMap = (home) => {
  const value = readJson(plugins(home, 'installed_plugins.json'));
  return isObject(value) && isObject(value.plugins) ? value.plugins : {};
};

const entriesOf = (map, id) => (Array.isArray(map[id]) ? map[id].filter(isObject) : []);
const scopeOf = (entry) => (typeof entry.scope === 'string' ? entry.scope : 'user');
// The cwd a scope's command runs in: the project of a project or local entry, else the home.
const cwdOf = (home, entry) => (scopeOf(entry) !== 'user' && typeof entry.projectPath === 'string' ? entry.projectPath : home);
const isStale = (entry) => scopeOf(entry) !== 'user' && typeof entry.projectPath === 'string'
  && !existsSync(entry.projectPath);
const sameInstall = (a, b) => scopeOf(a) === scopeOf(b) && (scopeOf(a) === 'user' || a.projectPath === b.projectPath);

// The settings file holding a scope's enabledPlugins: ~/.claude/settings.json for user, the project's
// .claude/settings.json for project and .claude/settings.local.json for local.
function enabledMap(home, entry) {
  const scope = scopeOf(entry);
  const path = scope === 'user' ? settingsPath(home)
    : join(cwdOf(home, entry), '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
  const value = readJson(path)?.enabledPlugins;
  return isObject(value) ? value : {};
}

const lastLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
const why = (r) => lastLine(r.stderr) || lastLine(r.stdout) || `exit code ${r.code}`;
const command = (cmd, args) => `${cmd} ${args.join(' ')}`;

// One CLI call: { code, stdout, stderr }; a run that throws reads as code 127 (a missing command).
async function call(ctx, cmd, args, { cwd = ctx.home, timeoutMs = PLUGIN_TIMEOUT_MS } = {}) {
  try {
    return await ctx.run(cmd, args, { timeoutMs, cwd });
  } catch (err) {
    return { code: 127, stdout: '', stderr: err?.message ?? String(err) };
  }
}

async function mustCall(ctx, cmd, args, opts) {
  const r = await call(ctx, cmd, args, opts);
  if (r.code !== 0) throw new StepError(`${command(cmd, args)} failed: ${why(r)}`);
}

// ---- backup ----

// <home>/.claude/backups/triqual-migration-<YYYYMMDD-HHMMSS>, the stamp of backupDirFor.
export function migrationBackupDir(home, now) {
  const run = backupDirFor(home, now);
  const stamp = basename(run).split('-').slice(-2).join('-');
  return join(dirname(run), `${BRAND.dir}-migration-${stamp}`);
}

const trackingRulePending = (home) => {
  const allow = readJson(settingsPath(home))?.permissions?.allow;
  return Array.isArray(allow) && allow.includes(TRACKING_LEGACY) && !allow.includes(TRACKING);
};

// The legacy CLI files, by ownsCliFile: `old` is an older file of ours that installCli replaces (an older shim at the
// legacy CLI file or as its extensionless name, an older launcher at the legacy launcher name); `foreign` is anything
// else that is not the alias, its link or the forwarder, which installCli refuses on a machine that had callers of the
// legacy names; `present` whether that is this machine, that is, any of the three is ours. On any other, a file there
// is someone else's: it is neither foreign nor present, and nothing is done about it.
function cliState(home) {
  const old = [];
  const foreign = [];
  if (!legacyCliPresent(home)) return { old, foreign, present: false };
  const files = [[L.cliFile, BRAND.ownership.alias], [L.launcher, BRAND.ownership.forwarder], [L.cli, null]];
  for (const [name, ownership] of files) {
    const path = binPath(home, name);
    const owner = ownsCliFile(path);
    if (owner === 'absent') continue;
    if (owner === 'foreign') {
      foreign.push(path);
      continue;
    }
    const current = ownership === null ? lstatSync(path).isSymbolicLink() : readFileSync(path, 'utf8').split('\n')[1] === ownership;
    if (!current) old.push(path);
  }
  return { old, foreign, present: true };
}

const cliWork = ({ home, installCli }) => {
  const { old, foreign } = cliState(home);
  return typeof installCli === 'function' && foreign.length === 0 && old.length > 0;
};

const settingsWork = (home) => {
  const settings = readJson(settingsPath(home));
  if (!isObject(settings)) return false;
  return (isObject(settings.enabledPlugins) && Object.keys(settings.enabledPlugins).some(isLegacyId))
    || (isObject(settings.extraKnownMarketplaces) && Object.hasOwn(settings.extraKnownMarketplaces, L.marketplace))
    || trackingRulePending(home);
};

// Whether a changing step has work. Verify's leftovers that no step can clear do not count.
const pending = async (ctx) => Object.hasOwn(known(ctx.home), L.marketplace) || settingsWork(ctx.home)
  || rulesPlan(ctx.home)?.root !== undefined || directoriesPlan(ctx.home).work || cliWork(ctx)
  || await harnessesWork(ctx);

// Spec 4 step 1: the files and dirs a migration touches, where they exist.
function backupSources(home) {
  const codex = harnessPaths(home, 'codex');
  const grok = harnessPaths(home, 'grok');
  const legacyDirs = DIR_BASES(home).map((base) => join(base, L.dir));
  const manifest = manifestPath(home);
  return [
    settingsPath(home), claudeMdPath(home), plugins(home, 'installed_plugins.json'), plugins(home, 'known_marketplaces.json'),
    codex.config, codex.rules, codex.skills, join(grok.dir, 'hooks'), join(grok.dir, 'rules'),
    ...legacyDirs,
    ...(legacyDirs.some((dir) => manifest.startsWith(`${dir}/`)) ? [] : [manifest]),
    binPath(home, L.cli), binPath(home, L.cliFile), binPath(home, L.launcher),
  ].filter((path) => lstatOrNull(path) !== null);
}

// Directories 0700, files 0600; links are copied as they are (a link's text is kept, never followed).
function makePrivate(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makePrivate(join(path, name));
  } else {
    chmodSync(path, 0o600);
  }
}

// Copies each source to the same path relative to the home under the run's backup dir.
async function backupStep(ctx) {
  const { home, backupDir } = ctx;
  if (!(await pending(ctx))) return { status: 'skipped', detail: 'nothing for migrate to change' };
  const sources = backupSources(home);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  for (const src of sources) {
    const dest = join(backupDir, relative(home, src));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    makePrivate(dest);
  }
  ctx.backedUp = true;
  return { status: 'done', detail: `copied ${sources.length} item(s) to ${backupDir}` };
}

// ---- marketplace ----

// The legacy plugin ids installed now, methodology first, each with its installed entries.
function legacyInstalls(home) {
  const map = installedMap(home);
  const ids = Object.keys(map).filter(isLegacyId).sort((a, b) => Number(nameOf(b) === 'methodology')
    - Number(nameOf(a) === 'methodology'));
  return ids.map((id) => ({ id, name: nameOf(id), entries: entriesOf(map, id) }));
}

// Spec 4 step 2, in the sequence T8 confirmed against Claude Code 2.1.296: add the triqual marketplace (stop unless it
// is then known), install each legacy-installed plugin under triqual at each of its scopes (methodology first, its
// dependencies come with it), disable what the legacy id did not have enabled, uninstall every legacy entry at its
// scope keeping its data, then remove the legacy marketplace once no legacy id is left.
async function marketplaceStep(ctx) {
  const { home } = ctx;
  if (!Object.hasOwn(known(home), L.marketplace)) {
    const orphans = legacyInstalls(home).filter((p) => p.entries.some((e) => !isStale(e))).map((p) => p.id);
    if (orphans.length) {
      return { status: 'skipped', detail: `${orphans.join(', ')} installed, but the ${L.marketplace} marketplace is not `
        + 'known, so migrate cannot move them: uninstall them with claude plugin uninstall (verify names each command)' };
    }
    return Object.hasOwn(known(home), BRAND.marketplace)
      ? { status: 'already', detail: `${L.marketplace} is not a known marketplace` }
      : { status: 'skipped', detail: `no ${L.marketplace} marketplace known` };
  }
  // A new dir beside a real legacy one stops the directories step later: stop here instead, before anything is
  // uninstalled, so the machine keeps working on the legacy ids until the dirs are merged.
  const dirs = directoriesPlan(home);
  if (dirs.problems.length) throw new StepError(`${dirs.problems.join('; ')}; nothing was uninstalled`);
  const did = [];
  if (!Object.hasOwn(known(home), BRAND.marketplace)) {
    const args = ['plugin', 'marketplace', 'add', BRAND.source, '--scope', 'user'];
    const r = await call(ctx, 'claude', args);
    if (!Object.hasOwn(known(home), BRAND.marketplace)) {
      const reason = r.code === 0 ? 'it exited 0' : why(r);
      throw new StepError(`claude ${args.join(' ')} did not add ${BRAND.marketplace} (${reason}): the remote manifest `
        + `must name ${BRAND.marketplace}; nothing was uninstalled`);
    }
    did.push(`added ${BRAND.marketplace} from ${BRAND.source}`);
  }
  // Read once, before any install: step 3 reads the legacy enabled state only of the ids still installed now, so a
  // resumed run never reads a key an earlier uninstall deleted as "disabled".
  const legacy = legacyInstalls(home);
  // An entry of a project that is gone cannot be moved (no command runs in a missing cwd): named, then left to the
  // marketplace removal, which drops what is still installed from it.
  const stale = legacy.flatMap(({ id, entries }) => entries.filter(isStale).map((e) => `${id} (${scopeOf(e)} in `
    + `${e.projectPath}, which no longer exists)`));
  if (stale.length) did.push(`not moved: ${stale.join(', ')}; the ${L.marketplace} marketplace removal drops it`);
  const installed = [];
  for (const { name, entries } of legacy) {
    const id = `${name}@${BRAND.marketplace}`;
    for (const entry of entries.filter((e) => !isStale(e))) {
      // Read again before each install: installing methodology installs its dependencies.
      if (entriesOf(installedMap(home), id).some((e) => sameInstall(e, entry))) continue;
      await mustCall(ctx, 'claude', ['plugin', 'install', id, '--scope', scopeOf(entry)], { cwd: cwdOf(home, entry) });
      installed.push(`${id} (${scopeOf(entry)})`);
    }
  }
  if (installed.length) did.push(`installed ${installed.join(', ')}`);
  const disabled = [];
  for (const { id: old, name, entries } of legacy) {
    const id = `${name}@${BRAND.marketplace}`;
    for (const entry of entries.filter((e) => !isStale(e))) {
      const enabled = enabledMap(home, entry);
      if (enabled[old] === true || enabled[id] === false) continue;
      await mustCall(ctx, 'claude', ['plugin', 'disable', id, '--scope', scopeOf(entry)], { cwd: cwdOf(home, entry) });
      disabled.push(`${id} (${scopeOf(entry)})`);
    }
  }
  if (disabled.length) did.push(`disabled ${disabled.join(', ')}, as the legacy ids were`);
  const uninstalled = [];
  const problems = [];
  for (const { id, entries } of legacyInstalls(home)) {
    for (const entry of entries.filter((e) => !isStale(e))) {
      const args = ['plugin', 'uninstall', id, '--scope', scopeOf(entry), '--keep-data'];
      const r = await call(ctx, 'claude', args, { cwd: cwdOf(home, entry) });
      if (r.code === 0) uninstalled.push(`${id} (${scopeOf(entry)})`);
      else problems.push(`claude ${args.join(' ')} failed: ${why(r)}`);
    }
  }
  if (uninstalled.length) did.push(`uninstalled ${uninstalled.join(', ')} (plugin data kept)`);
  const left = legacyInstalls(home).filter((p) => p.entries.some((e) => !isStale(e))).map((p) => p.id);
  if (left.length) {
    throw new StepError([...did, ...problems, `still installed: ${left.join(', ')}; the ${L.marketplace} marketplace `
      + 'is kept until they are uninstalled'].join('; '));
  }
  await mustCall(ctx, 'claude', ['plugin', 'marketplace', 'remove', L.marketplace]);
  did.push(`removed the ${L.marketplace} marketplace`, RELOAD);
  return { status: 'done', detail: did.join('; ') };
}

// ---- references ----

// The user-scope methodology install's root, or null.
function methodologyRoot(home) {
  const entry = entriesOf(installedMap(home), pluginId(home, 'methodology')).find((e) => e.scope === 'user');
  return typeof entry?.installPath === 'string' && entry.installPath ? entry.installPath : null;
}

// How migrate can rewrite a CLAUDE.md under the legacy markers: { root } when sync can (the user-scope methodology's
// rules gate passes), { why } when it cannot, null when CLAUDE.md has no legacy section.
function rulesPlan(home) {
  let text;
  try {
    text = readText(claudeMdPath(home));
  } catch {
    return null; // unreadable: the legacy scan names it
  }
  const loc = text === null ? null : locate(text);
  if (loc?.pair !== L.markers) return null;
  if (loc.error) return { why: `its managed section is ${loc.error}` };
  const root = methodologyRoot(home);
  if (root === null) return { why: 'methodology is not installed at user scope' };
  try {
    const headings = JSON.parse(readFileSync(join(root, 'rules', 'legacy-headings.json'), 'utf8'));
    const outside = legacyHeadingsOutside(text, headings);
    if (outside.length) return { why: `legacy headings outside the managed section, split it first: ${outside.join(', ')}` };
  } catch (err) {
    return { why: err.message };
  }
  return { root };
}

// Spec 4 step 3: the leftover legacy keys in settings.json go, the triqual allow rule goes next to the cm one, and a
// managed section under the legacy markers is rewritten by sync (in place, under the new markers). A section sync
// cannot rewrite yet (its rules gate refuses) is left as it is and named: bootstrap's own rules steps report it, and
// verify gives it sync as the fix.
async function referencesStep(ctx) {
  const { home, now } = ctx;
  const notes = [];
  const path = settingsPath(home);
  if (existsSync(path)) {
    const removed = [];
    let added = false;
    editSettings(path, (obj) => {
      if (isObject(obj.enabledPlugins)) {
        for (const id of Object.keys(obj.enabledPlugins).filter(isLegacyId)) {
          delete obj.enabledPlugins[id];
          removed.push(id);
        }
      }
      if (isObject(obj.extraKnownMarketplaces) && Object.hasOwn(obj.extraKnownMarketplaces, L.marketplace)) {
        delete obj.extraKnownMarketplaces[L.marketplace];
        removed.push(`extraKnownMarketplaces.${L.marketplace}`);
      }
      const allow = obj.permissions?.allow;
      if (Array.isArray(allow) && allow.includes(TRACKING_LEGACY) && !allow.includes(TRACKING)) {
        allow.splice(allow.indexOf(TRACKING_LEGACY) + 1, 0, TRACKING);
        added = true;
      }
    }, { backupDir: join(ctx.backupDir, '.claude') });
    if (removed.length) notes.push(`removed ${removed.join(', ')} from ${path}`);
    if (added) notes.push(`added "${TRACKING}" next to "${TRACKING_LEGACY}"`);
  }
  const plan = rulesPlan(home);
  let left = null;
  if (plan?.root) {
    const { steps } = sync({ home, pluginRoot: plan.root, now });
    const failed = steps.filter((s) => s.id !== 'supersedes' && s.status === 'failed');
    if (failed.length) throw new StepError([...notes, ...failed.map((s) => `${s.id}: ${s.detail}`)].join('; '));
    for (const s of steps) if (s.status === 'done' && s.id !== 'rules-gate') notes.push(`${s.id}: ${s.detail}`);
  } else if (plan) {
    left = `${claudeMdPath(home)} left under the ${L.marketplace} markers (${plan.why}): run ${BRAND.cli} sync once it `
      + 'passes the rules gate';
  }
  if (notes.length) return { status: 'done', detail: [...notes, ...(left ? [left] : [])].join('; ') };
  if (left) return { status: 'skipped', detail: left };
  return { status: 'already', detail: 'no legacy reference in settings.json or CLAUDE.md' };
}

// ---- directories ----

// The migration backup dirs under ~/.claude/backups, oldest first.
function migrationBackups(home) {
  const root = join(home, '.claude', 'backups');
  try {
    return readdirSync(root).filter((n) => n.startsWith(`${BRAND.dir}-migration-`)).sort().map((n) => join(root, n));
  } catch {
    return [];
  }
}

// What the directories step would do: `moves` (a real legacy dir, no new one), `relinks` (a move a run made but whose
// link it did not leave: the legacy path missing, the new dir there, and a migration backup holding the legacy dir, so
// it was legacy; a triqual-first dir never gets a link), `problems` (both dirs real: never merged), `left` (a link
// elsewhere or something that is not a dir: the user's to move aside, migrate leaves it), `links` (compatibility links
// in place, dangling ones included: brandDir writes the new dir again on its next write). `work` when there is a move
// or a relink.
function directoriesPlan(home) {
  const plan = { moves: [], relinks: [], problems: [], left: [], links: 0 };
  const backups = migrationBackups(home);
  for (const base of DIR_BASES(home)) {
    const legacy = join(base, L.dir);
    const current = join(base, BRAND.dir);
    const info = lstatOrNull(legacy);
    const currentInfo = lstatOrNull(current);
    if (info === null) {
      const wasLegacy = backups.some((dir) => lstatOrNull(join(dir, relative(home, legacy))) !== null);
      if (wasLegacy && currentInfo?.isDirectory()) plan.relinks.push(legacy);
    } else if (info.isSymbolicLink()) {
      if (isCompatLink(legacy, current)) plan.links += 1;
      else plan.left.push(`${legacy} is a link, but not to ${current}`);
    } else if (!info.isDirectory()) {
      plan.left.push(`${legacy} is not a directory`);
    } else if (currentInfo !== null) {
      plan.problems.push(`${legacy} and ${current} both exist: ${mergeByHand(legacy, current)}`);
    } else {
      plan.moves.push([legacy, current]);
    }
  }
  plan.work = plan.moves.length + plan.relinks.length > 0;
  return plan;
}

// Spec 4 step 4: each legacy config, state and data dir moves to the new name and leaves a relative link behind. A
// new dir that already exists beside a real legacy one stops the step before anything moves: never merged.
async function directoriesStep({ home }) {
  const { moves, relinks, problems, left, links } = directoriesPlan(home);
  if (problems.length) throw new StepError(`${problems.join('; ')}; nothing moved`);
  for (const [legacy, current] of moves) {
    renameSync(legacy, current);
    symlinkSync(BRAND.dir, legacy);
  }
  for (const legacy of relinks) symlinkSync(BRAND.dir, legacy);
  const did = [
    ...moves.map(([l, c]) => `moved ${l} to ${c}, link left`),
    ...relinks.map((l) => `left the link ${l} -> ${BRAND.dir} that an interrupted run did not`),
  ];
  const leftNote = left.length ? [`left as they are (move each aside): ${left.join('; ')}`] : [];
  if (did.length) return { status: 'done', detail: [...did, ...leftNote].join('; ') };
  if (left.length) return { status: 'skipped', detail: leftNote[0] };
  return { status: 'already', detail: links ? `${links} compatibility link(s) in place` : 'no legacy directory' };
}

// ---- cli ----

// Spec 4 step 5, through bootstrap's installCli: the triqual shim and launcher, and the cm alias and forwarder in place
// of an older cm shim or launcher. Only while a legacy CLI file of ours is not yet migrated: a fresh install, and every
// later update of the files, is bootstrap's shim step. On a machine with a legacy CLI file of ours, a file that is not
// ours is left to that step, which reports it; on one without, a file at those names is someone else's and not this
// step's business.
async function cliStep({ home, installCli }) {
  if (typeof installCli !== 'function') return { status: 'skipped', detail: 'run node bin/bootstrap.mjs from the clone' };
  const { old, foreign, present } = cliState(home);
  if (foreign.length) {
    return { status: 'skipped', detail: `${foreign.join(', ')}: not a file ${BRAND.marketplace} installed, left to the `
      + 'shim step' };
  }
  if (old.length) return installCli({ home });
  return present
    ? { status: 'already', detail: `the ${L.cli} alias and the ${L.launcher} forwarder are in place` }
    : { status: 'skipped', detail: `no legacy CLI in ${dirname(binPath(home, L.cli))}` };
}

// ---- harnesses ----

const renameId = (id) => {
  if (id === L.marketplace) return BRAND.marketplace;
  return typeof id === 'string' && isLegacyId(id) ? `${nameOf(id)}@${BRAND.marketplace}` : id;
};
const hasLegacyRecord = (entry) => (Array.isArray(entry?.plugins) ? entry.plugins : [])
  .some((p) => typeof p?.id === 'string' && renameId(p.id) !== p.id);

// The legacy ids recorded in harnesses.json renamed, a record that then repeats an earlier one dropped.
async function rewriteRecords(home, id) {
  const { locked } = await withManifest(home, id, (entry) => {
    const seen = new Set();
    entry.plugins = entry.plugins.map((p) => (typeof p.id === 'string' ? { ...p, id: renameId(p.id) } : p))
      .filter((p) => {
        const key = `${p.id ?? p.name} ${p.action}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });
  if (!locked) throw new StepError(`${manifestPath(home)} is locked by a sync or harness session: run ${BRAND.cli} migrate again`);
}

// Through to syncHarness: on a terminal, Codex's one-time AGENTS.md split can be accepted during migrate. Resolves the
// sync's steps.
async function syncOne(ctx, id) {
  const { steps } = await syncHarness({
    home: ctx.home, id, run: ctx.run, now: ctx.now, log: ctx.log, isTTY: ctx.isTTY, yes: ctx.yes, confirm: ctx.confirm,
  });
  const failed = steps.filter((s) => s.status === 'failed');
  if (failed.length) throw new StepError(`${id}: ${failed.map((s) => `${s.id}: ${s.detail}`).join('; ')}`);
  return steps;
}

// What the harnesses step reads: the manifest, which harnesses are set up, the legacy Codex tables, whether a set-up
// Codex has legacy state, the legacy Grok files, and the harnesses whose legacy records it would rewrite (never Codex's
// while legacy tables are in its config.toml).
function harnessesPlan(home) {
  const manifest = readManifest(home);
  const config = readMethodologyConfig(home);
  const setUp = (id) => Object.hasOwn(manifest.harnesses, id) && config.harnesses[id]?.enabled !== false;
  const tables = legacyCodexTables(readText(harnessPaths(home, 'codex').config) ?? '');
  const tablesLeft = tables.marketplace || tables.plugins.length > 0;
  const codex = setUp('codex') && (tablesLeft || hasLegacyRecord(manifest.harnesses.codex));
  const grok = harnessPaths(home, 'grok');
  const grokFiles = [grok.legacyRules, grok.legacyHooksFile].filter((path) => lstatOrNull(path) !== null);
  const records = HARNESS_IDS.filter((id) => hasLegacyRecord(manifest.harnesses[id]) && !(id === 'codex' && tablesLeft));
  return { setUp, tables, codex, grokFiles, records };
}

// Whether codex is on PATH: `codex features list` (read-only) does not exit 127. Asked once per run, and only when a
// set-up Codex has legacy state.
async function codexOnPath(ctx) {
  ctx.codexOnPath ??= (await call(ctx, 'codex', ['features', 'list'], { timeoutMs: CODEX_TIMEOUT_MS })).code !== 127;
  return ctx.codexOnPath;
}

const harnessesWork = async (ctx) => {
  let plan;
  try {
    plan = harnessesPlan(ctx.home);
  } catch {
    return false; // an unreadable harnesses.json fails the step itself
  }
  const codex = plan.codex && await codexOnPath(ctx);
  const records = plan.records.filter((id) => id !== 'codex' || !plan.codex || codex);
  return codex || plan.grokFiles.length > 0 || records.length > 0;
};

// Spec 4 step 6, for each harness harnesses.json records as set up (and config.json does not record as removed):
// Codex drops every legacy plugin table and the legacy marketplace through `codex plugin`, then sync adds the triqual
// ones and relinks skills; Grok's sync writes the new files and drops the old. Without codex on PATH, Codex is left as
// it is (verify names the codex commands). Legacy Grok files are removed (backed up first) even where Grok is not set
// up, since Grok would load them. Then the legacy ids recorded in harnesses.json are rewritten.
async function harnessesStep(ctx) {
  const { home } = ctx;
  const { setUp, tables, codex, grokFiles } = harnessesPlan(home);
  const notes = [];
  let codexMigrated = false;
  let codexLeft = null;
  if (codex && !(await codexOnPath(ctx))) {
    codexLeft = 'codex is not on PATH (exit 127): its legacy config stays as it is, and verify names the codex '
      + 'commands that remove it';
  } else if (codex) {
    const opts = { timeoutMs: CODEX_TIMEOUT_MS };
    for (const id of tables.plugins) await mustCall(ctx, 'codex', ['plugin', 'remove', id], opts);
    if (tables.marketplace) await mustCall(ctx, 'codex', ['plugin', 'marketplace', 'remove', L.marketplace], opts);
    await syncOne(ctx, 'codex');
    codexMigrated = true;
    const removed = [...tables.plugins.map((id) => `removed ${id}`),
      ...(tables.marketplace ? [`removed marketplace ${L.marketplace}`] : [])];
    notes.push(`codex: ${[...removed, `synced under ${BRAND.marketplace}`].join(', ')}`);
  }
  if (grokFiles.length) {
    if (setUp('grok')) {
      // Without grok on PATH the sync skips only its plugin step (named here); its files are still renamed.
      const plugins = (await syncOne(ctx, 'grok')).find((s) => s.id === 'grok-plugins' && s.status === 'skipped');
      notes.push(`grok: synced, removed ${grokFiles.join(', ')}${plugins ? `; ${plugins.detail}` : ''}`);
    } else {
      for (const path of grokFiles) {
        backupFile(path, join(ctx.backupDir, relative(home, dirname(path))));
        unlinkSync(path);
      }
      notes.push(`grok: removed ${grokFiles.join(', ')} (Grok is not set up; copies in ${ctx.backupDir})`);
    }
  }
  // Codex's records wait for its migration: renamed now, they would name a triqual bridge that is not installed.
  const records = harnessesPlan(home).records.filter((id) => id !== 'codex' || codexLeft === null);
  for (const id of records) await rewriteRecords(home, id);
  if (records.length) notes.push(`rewrote the ${L.marketplace} ids recorded in ${manifestPath(home)}`);
  if (notes.length === 0) {
    return codexLeft ? { status: 'skipped', detail: codexLeft }
      : { status: 'already', detail: 'no harness set up under the legacy names' };
  }
  if (codexLeft) notes.push(codexLeft);
  if (codexMigrated) notes.push(OWNER_STEP);
  return { status: 'done', detail: notes.join('; ') };
}

// ---- repos ----

// repos.json as progress-tracking's registry finds it: under TRIQUAL_REGISTRY_DIR (else CM_REGISTRY_DIR) when that is
// an absolute path, else in the config dir.
function registryFile(home) {
  const override = readEnv(process.env, 'REGISTRY_DIR');
  if (override === undefined) return join(brandDir(join(home, '.config')), 'repos.json');
  return isAbsolute(override) ? join(override, 'repos.json') : null;
}

// Spec 4 step 7: the registered repos whose committed gate predates the triqual CLI. Listed only, never changed.
async function reposStep({ home }) {
  const file = registryFile(home);
  const repos = file === null ? null : readJson(file)?.repos;
  const roots = (Array.isArray(repos) ? repos : []).map((r) => r?.root).filter((root) => typeof root === 'string');
  const gateOf = (root) => {
    try {
      return readFileSync(join(root, '.githooks', 'progress-gate.sh'), 'utf8');
    } catch {
      return null; // no committed gate (local mode, or the repo is gone)
    }
  };
  const old = roots.filter((root) => {
    const gate = gateOf(root);
    return gate !== null && !gate.includes(`command -v ${BRAND.cli}`);
  });
  if (old.length === 0) return { status: 'skipped', detail: `no registered repo is left on the ${L.cli} gate` };
  // Listed only: nothing changed, so skipped (the idempotence contract), with the list as the detail.
  return {
    status: 'skipped',
    detail: `${old.length} registered repo(s) still on the ${L.cli} gate, which needs the ${L.cli} alias until `
      + `${BRAND.cli} progress-init is re-run there: ${old.join(', ')}`,
  };
}

// ---- verify ----

// Spec 4 step 8 through the legacy scan: a leftover, or a file it could not read (so it proves nothing), fails.
// Each line carries the scan's fix for it, which never points back to migrate for what migrate leaves.
async function verifyStep(ctx) {
  const { failures, exempt, fixes } = legacyScan(ctx.home);
  const unread = exempt.filter(isUnreadable);
  ctx.leftovers = failures.length + unread.length;
  if (ctx.leftovers) {
    throw new StepError([...failures.map((line) => `${line}: ${fixes[line]}`),
      ...unread.map((line) => `${line}: make it readable or fix its content`)].join('; '));
  }
  return { status: 'already', detail: `no legacy leftover (${exempt.length} item(s) kept on purpose)` };
}

// cli runs before marketplace: the triqual shim it installs resolves either id per plugin, so a run that stops after
// it (or after marketplace) leaves cm, triqual, the statusline and the harness hooks working; the older cm shim it
// replaces only knows the legacy ids that marketplace uninstalls.
export const MIGRATE_STEPS = [
  { id: 'backup', run: backupStep },
  { id: 'cli', run: cliStep },
  { id: 'marketplace', run: marketplaceStep },
  { id: 'references', run: referencesStep },
  { id: 'directories', run: directoriesStep },
  { id: 'harnesses', run: harnessesStep },
  { id: 'repos', run: reposStep },
  { id: 'verify', run: verifyStep },
];

// Where the copies are, for a failed step's detail: this run's dir, and the first run's as the pre-migration copies
// (an earlier run's dir holds the state before anything moved; this one may hold a half-migrated one).
function copiesNote(ctx) {
  const first = migrationBackups(ctx.home)[0];
  if (ctx.backedUp && (first === undefined || first === ctx.backupDir)) return `the pre-migration copies are in ${ctx.backupDir}`;
  const parts = ctx.backedUp ? [`this run's copies are in ${ctx.backupDir}`] : [];
  if (first !== undefined) parts.push(`the pre-migration copies are in ${first}`);
  return parts.join('; ');
}

// Runs MIGRATE_STEPS; each line `<id>: <status> — <detail>` goes to `log` as it is made. `installCli` is bootstrap's
// (absent from the standalone CLI); `isTTY`, `yes` and `confirm` reach the harness syncs (Codex's AGENTS.md split).
// Resolves { code: 0 | 1, lines, leftovers }: `leftovers` is the number of lines verify named (0 when it did not run).
export async function migrate({
  home, run, now = new Date(), log = () => {}, installCli, isTTY = false, yes = false, confirm,
}) {
  const ctx = {
    home, run, now, log, installCli, isTTY, yes, confirm, backupDir: migrationBackupDir(home, now), backedUp: false,
    leftovers: 0,
  };
  const lines = [];
  let failedAt = null;
  for (const step of MIGRATE_STEPS) {
    let outcome;
    if (failedAt !== null) {
      outcome = { status: 'skipped', detail: `${failedAt} failed` };
    } else {
      try {
        outcome = await step.run(ctx);
      } catch (err) {
        outcome = { status: 'failed', detail: err?.message ?? String(err) };
      }
      if (outcome.status === 'failed') {
        failedAt = step.id;
        const note = copiesNote(ctx);
        if (note) outcome = { ...outcome, detail: `${outcome.detail}; ${note}` };
      }
    }
    const line = `${step.id}: ${outcome.status} — ${outcome.detail}`;
    lines.push(line);
    log(line);
  }
  return { code: failedAt === null ? 0 : 1, lines, leftovers: ctx.leftovers };
}
