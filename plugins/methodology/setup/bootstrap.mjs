#!/usr/bin/env node
// Bootstrap: the one command that installs the methodology on a machine. It checks the prerequisites, runs `triqual
// migrate` from this clone (a machine on the legacy marketplace moves to triqual first; a fresh one has nothing to
// migrate), adds or updates the triqual marketplace (one that still knows only the legacy one is left to the
// migration), installs the system plugins at user scope or updates them to the marketplace versions, installs the CLI
// in ~/.local/bin (the triqual shim behind a relative triqual symlink, the triqual-hook launcher, and for one release,
// on a machine that had a legacy CLI file, the deprecated cm alias behind its cm symlink and the forwarder from the old
// launcher name), migrates the older setup (rules sync behind its gate, legacy agents, the legacy workflow-gate hook,
// the superseded plugins that `sync` disables, the `language` key after confirmation), offers the `Bash(triqual
// tracking:*)` allow rule (after confirmation), then runs `triqual doctor` through that shim. It also offers to
// set up each detected harness (Codex, Grok) through `triqual sync --harness <id>`'s syncHarness.
// Usage: node bin/bootstrap.mjs [--yes] [--keep-language] [--no-harness] (bin/bootstrap.mjs re-exports this file,
// plugins/methodology/setup/bootstrap.mjs, which runs the same way). Exit 1 when any step failed, else 0.
// Every step returns { status: 'done' | 'already' | 'skipped' | 'failed', detail }. A step lists the steps it needs;
// when one of them failed or was skipped, the step is skipped without running (detail: its `blocked` text for that
// step, else "<step> failed|skipped"). Every file a run changes under
// ~/.claude is first backed up: the migrate step's files into its triqual-migration-<stamp> dir, the other steps' into
// one backupDirFor dir per run; a legacy file is deleted only when its sha256 matches setup/legacy.json.
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { idOf, marketplaceVersions, PLUGINS, realRun } from '../cli/doctor.mjs';
import { BRAND } from '../cli/lib/brand.mjs';
import { legacyCliPresent, ownsCliFile } from '../cli/lib/cli-files.mjs';
import { backupDirFor, backupFile, sha256, writeAtomic } from '../cli/lib/fsx.mjs';
import { syncHarness } from '../cli/lib/harness-sync.mjs';
import { detect } from '../cli/lib/harnesses.mjs';
import { migrate } from '../cli/lib/migrate-steps.mjs';
import { editSettings, readMethodologyConfig, setHarnessEnabled } from '../cli/lib/settings.mjs';
import { sync } from '../cli/sync.mjs';

// The floor for the CLI and hooks: node:sqlite (the tracking store) needs 22.13. Compared on major and minor.
const MIN_NODE = { major: 22, minor: 13 };
const CHECK_TIMEOUT_MS = 60_000; // --version checks and doctor
const PLUGIN_TIMEOUT_MS = 300_000; // claude plugin marketplace add|update and claude plugin install|update
const BIN = dirname(fileURLToPath(import.meta.url));
const SHIM_SOURCE = join(BIN, 'triqual-shim.mjs');
const LAUNCHER_SOURCE = join(BIN, 'triqual-hook');
const ALIAS_SOURCE = join(BIN, `${BRAND.legacy.cli}-alias.mjs`);
const FORWARDER_SOURCE = join(BIN, `${BRAND.legacy.launcher}-forwarder`);
const DOCTOR_REPORT = /^doctor: \d+ failure\(s\), \d+ warning\(s\)$/;
const LEGACY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'legacy.json');
const GATE_HOOK = 'hooks/workflow-gate.mjs';
const TRACKING_ALLOW = `Bash(${BRAND.cli} tracking:*)`; // the allow rule the tracking-permission step offers
// Rules that already allow it: the rule itself and the broader prefix of the same command. Claude Code matches a
// Bash prefix rule against the command text, so a rule for the cm alias never covers `triqual tracking add`, and the
// narrower `triqual tracking write` rule an earlier bootstrap added covers neither add, status nor log: it stays, and
// this one is offered beside it.
const TRACKING_COVERED_BY = [TRACKING_ALLOW, `Bash(${BRAND.cli}:*)`];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pluginsDir = (home) => join(home, '.claude', 'plugins');
const binFile = (home, name) => join(home, '.local', 'bin', name);
// The .mjs names keep the copies ESM under any package.json above them; the extensionless names are relative symlinks.
const shimFile = (home) => binFile(home, BRAND.cliFile);
const shimLink = (home) => binFile(home, BRAND.cli);
const launcherFile = (home) => binFile(home, BRAND.launcher);
const aliasFile = (home) => binFile(home, BRAND.legacy.cliFile);
const aliasLink = (home) => binFile(home, BRAND.legacy.cli);
const forwarderFile = (home) => binFile(home, BRAND.legacy.launcher);
const settingsPath = (home) => join(home, '.claude', 'settings.json');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const lastLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

// The last line of stderr, else of stdout, else the exit code: the reason a CLI call failed.
const failureDetail = (r) => lastLine(r.stderr) || lastLine(r.stdout) || `exit code ${r.code}`;

// A failed `claude <args>` call: why it failed, then the command to run by hand.
const byHand = (r, args) => `${failureDetail(r)} — run by hand: claude ${args.join(' ')}`;

// run() never throws for a missing command in the CLI (code 127), but an injected run may: treat both alike.
async function tryRun(run, cmd, args, timeoutMs) {
  try {
    return await run(cmd, args, { timeoutMs });
  } catch (err) {
    return { code: 127, stdout: '', stderr: err?.message ?? String(err) };
  }
}

const nodeTooOld = (version) => {
  const [major, minor] = String(version).split('.').map(Number);
  return major < MIN_NODE.major || (major === MIN_NODE.major && (minor ?? 0) < MIN_NODE.minor);
};

// ask(message): false without asking when stdin is not a terminal and --yes is absent; true without asking with
// --yes; otherwise the user's answer.
export function makeAsk({ argv = [], isTTY, confirm }) {
  return async (message) => {
    if (argv.includes('--yes')) return true;
    if (!isTTY) return false;
    return Boolean(await confirm(message));
  };
}

async function prereqs({ run, nodeVersion }) {
  const problems = [];
  const notes = [];
  if (nodeTooOld(nodeVersion)) {
    const floor = `${MIN_NODE.major}.${MIN_NODE.minor}`;
    problems.push(`node ${nodeVersion} is older than ${floor}; install Node ${floor} or newer`);
  } else {
    notes.push(`node ${nodeVersion}`);
  }
  const required = [
    ['claude', 'install Claude Code (npm install -g @anthropic-ai/claude-code), then run bootstrap again'],
    ['git', 'install git, then run bootstrap again'],
  ];
  for (const [cmd, hint] of required) {
    const r = await tryRun(run, cmd, ['--version'], CHECK_TIMEOUT_MS);
    if (r.code === 127) problems.push(`${cmd} not found; ${hint}`);
    else if (r.code !== 0) problems.push(`${cmd} --version failed (${failureDetail(r)}); ${hint}`);
    else notes.push(lastLine(r.stdout) || cmd);
  }
  // Only 127 (spawn ENOENT) means absent: the real headjack has no --version and exits 2 on it.
  const sv = await tryRun(run, 'headjack', ['--version'], CHECK_TIMEOUT_MS);
  if (sv.code === 127) notes.push('headjack not found (optional)');
  else notes.push((sv.code === 0 && lastLine(sv.stdout)) || 'headjack');
  if (problems.length > 0) return { status: 'failed', detail: problems.join('; ') };
  return { status: 'done', detail: notes.join(', ') };
}

// Adds or updates BRAND.marketplace only. A machine that knows only the legacy marketplace is left to the migration:
// updating that entry could pull the renamed release under the old name.
async function marketplace({ home, run }) {
  const known = readJson(join(pluginsDir(home), 'known_marketplaces.json'));
  const has = (name) => isObject(known) && Object.hasOwn(known, name);
  const isKnown = has(BRAND.marketplace);
  if (!isKnown && has(BRAND.legacy.marketplace)) {
    return { status: 'skipped', detail: `legacy ${BRAND.legacy.marketplace} marketplace: run the migration first` };
  }
  const args = isKnown
    ? ['plugin', 'marketplace', 'update', BRAND.marketplace]
    : ['plugin', 'marketplace', 'add', BRAND.source, '--scope', 'user'];
  const r = await tryRun(run, 'claude', args, PLUGIN_TIMEOUT_MS);
  if (r.code !== 0) return { status: 'failed', detail: byHand(r, args) };
  const detail = isKnown ? `${BRAND.marketplace} updated` : `${BRAND.marketplace} added from ${BRAND.source}`;
  return { status: 'done', detail };
}

// The user-scope entry of plugin `id` in installed_plugins.json, or null.
function userInstall(home, id) {
  const installed = readJson(join(pluginsDir(home), 'installed_plugins.json'));
  const entries = isObject(installed) && isObject(installed.plugins) ? installed.plugins[id] : null;
  return (Array.isArray(entries) && entries.find((e) => isObject(e) && e.scope === 'user')) || null;
}

// Brings every system plugin to the version the installed marketplace copy lists, methodology first (installing it
// installs the other three; `claude plugin update methodology` does not update them). A plugin missing at user scope
// is installed; an installed one at another version is updated. When the marketplace copy cannot be read, versions
// are not compared. The first failing call fails the step.
async function install({ home, run }) {
  const market = marketplaceVersions(home);
  const changes = [];
  for (const name of PLUGINS) {
    const id = idOf(home, name);
    const entry = userInstall(home, id); // read again: installing methodology installs its dependencies
    const released = market.versions?.[name];
    let args = null;
    let change = null;
    if (!entry) {
      args = ['plugin', 'install', id, '--scope', 'user'];
      change = `installed ${id}`;
    } else if (released !== undefined && entry.version !== released) {
      args = ['plugin', 'update', id, '--scope', 'user'];
      change = `updated ${id} ${entry.version} -> ${released}`;
    }
    if (args === null) continue;
    const r = await tryRun(run, 'claude', args, PLUGIN_TIMEOUT_MS);
    if (r.code !== 0) return { status: 'failed', detail: byHand(r, args) };
    changes.push(change);
  }
  if (changes.length > 0) return { status: 'done', detail: changes.join('; ') };
  if (market.error) return { status: 'already', detail: `every system plugin is installed; versions not compared: ${market.error}` };
  return { status: 'already', detail: 'every system plugin is installed at the marketplace version' };
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const notOurs = (path) => ({
  status: 'failed', detail: `${path} is not a file ${BRAND.marketplace} installed; move it aside, then rerun bootstrap`,
});

// Builds `target` under a temp name in its dir with make(tmp), then renames it over `target`.
function replaceAtomically(target, make) {
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    make(tmp);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Writes `body` to `file`, mode 0755, unless it already holds it (then only restores the mode), and notes what it did.
function installCopy(file, info, body, notes) {
  if (info && readFileSync(file).equals(body)) {
    if ((info.mode & 0o777) !== 0o755) {
      chmodSync(file, 0o755);
      notes.push(`${file} made executable`);
    }
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  replaceAtomically(file, (tmp) => {
    writeFileSync(tmp, body, { mode: 0o755 });
    chmodSync(tmp, 0o755);
  });
  notes.push(`${file} ${info ? 'updated' : 'installed'}`);
}

// The shim step: installs the CLI in <home>/.local/bin, each copy verbatim with mode 0755 and each link relative:
// shimFile (SHIM_SOURCE) behind shimLink, launcherFile (LAUNCHER_SOURCE), and for one release, only when `legacyCli` (a
// legacy CLI file was present when the run began; by default, when one is present now), the deprecated alias aliasFile
// (ALIAS_SOURCE) behind aliasLink and the old launcher name forwarderFile (FORWARDER_SOURCE), which forwards to
// launcherFile. A fresh machine never gets a cm that could shadow another tool, and a foreign file at a legacy name
// there is left alone (legacyCliPresent is true only when one of those files is ours). An extensionless copy would run
// as CommonJS, and do nothing, under a {"type":"commonjs"} package.json in ~ or above. An existing copy or link is
// replaced only when it is ours by ownsCliFile (a regular file with an ownership line 2, so an older full shim at
// aliasFile becomes the alias) or is that symlink already. Anything else fails the step before any file is written.
// Exported for the migration.
export async function installCli({ home, legacyCli = legacyCliPresent(home) }) {
  const copies = [
    [shimFile(home), SHIM_SOURCE], [launcherFile(home), LAUNCHER_SOURCE],
    ...(legacyCli ? [[aliasFile(home), ALIAS_SOURCE], [forwarderFile(home), FORWARDER_SOURCE]] : []),
  ].map(([file, source]) => ({ file, body: readFileSync(source), info: lstatOrNull(file) }));
  const linkPairs = [[shimLink(home), BRAND.cliFile], ...(legacyCli ? [[aliasLink(home), BRAND.legacy.cliFile]] : [])];
  const links = linkPairs.map(([link, target]) => {
    const info = lstatOrNull(link);
    return { link, target, info, current: Boolean(info?.isSymbolicLink()) && readlinkSync(link) === target };
  });
  for (const { file, info } of copies) if (info && ownsCliFile(file) !== 'ours') return notOurs(file);
  for (const { link, info, current } of links) if (info && !current && ownsCliFile(link) !== 'ours') return notOurs(link);
  const notes = [];
  for (const { file, info, body } of copies) installCopy(file, info, body, notes);
  for (const { link, target, info, current } of links) {
    if (current) continue;
    replaceAtomically(link, (tmp) => symlinkSync(target, tmp));
    notes.push(`${link} -> ${target} ${info ? 'replaces the older file' : 'created'}`);
  }
  if (notes.length > 0) return { status: 'done', detail: notes.join('; ') };
  const all = [...copies.map((c) => c.file), ...links.map((l) => l.link)];
  return { status: 'already', detail: `${all.join(', ')} are current` };
}

// sync() runs at most once per bootstrap run, against the INSTALLED methodology (never this clone's rules), with the
// run's `now` so its backups land in the run's backup dir. `rules-gate`, `rules` and `supersedes` each report their own
// step of it.
function syncStep(id) {
  return async (ctx) => {
    const entry = userInstall(ctx.home, idOf(ctx.home, 'methodology'));
    if (!entry || typeof entry.installPath !== 'string') return { status: 'skipped', detail: 'methodology not installed' };
    ctx.syncResult ??= sync({ home: ctx.home, pluginRoot: entry.installPath, now: ctx.now });
    const { status, detail } = ctx.syncResult.steps.find((s) => s.id === id);
    return { status, detail };
  };
}

const harnessQuestion = (id) => `Set up the methodology for ${id}? (hooks, rules, skills, role agents)`;
const SPLIT_COMMAND = 'run triqual sync --harness codex';

// Sets up the methodology in each harness `detect` finds (spec F.5), against the INSTALLED methodology, as `triqual sync
// --harness <id>` does. With no installed methodology the step is skipped before anything else. `--no-harness` then
// skips everything, recorded harnesses included. A harness config.json records as enabled is re-synced without asking,
// on a non-TTY too (syncHarness degrades safely there: the split gate skips); one it records as disabled (triqual sync
// --remove-harness) is neither offered nor synced; any other present harness is offered once, and a yes records
// harnesses.<id>.enabled before its sync. A non-TTY run without --yes offers nothing: those harnesses are skipped,
// unrecorded, with a hint to confirm on a terminal or pass --yes. An absent harness is not offered. Each harness step
// line goes to `log`; a harness with a failed step is listed as `failed <id> (<step ids>)`, not as set up, and fails
// the step. The Codex AGENTS.md split is never accepted by --yes: its `codex-rules-gate` skip makes the step's own
// line repeat the command to run.
async function harnesses({ home, argv, run, now, isTTY, confirm, log, ask }) {
  const entry = userInstall(home, idOf(home, 'methodology'));
  if (!entry || typeof entry.installPath !== 'string') return { status: 'skipped', detail: 'methodology not installed' };
  if (argv.includes('--no-harness')) return { status: 'skipped', detail: 'no harness set up (--no-harness)' };
  const yes = argv.includes('--yes');
  const canAsk = yes || isTTY;
  const config = readMethodologyConfig(home);
  if (config.error) return { status: 'failed', detail: `${config.error}: fix it or remove it, then rerun bootstrap` };
  const setUp = [];
  const skipped = [];
  const unconfirmed = [];
  const failed = [];
  let splitLeft = false;
  for (const { id, present } of await detect({ home, run })) {
    if (!present) continue;
    const recorded = config.harnesses[id];
    if (isObject(recorded) && recorded.enabled === false) {
      skipped.push(id);
      continue;
    }
    if (!(isObject(recorded) && recorded.enabled === true)) {
      if (!canAsk) {
        unconfirmed.push(id);
        continue;
      }
      if (!(await ask(harnessQuestion(id)))) {
        skipped.push(id);
        continue;
      }
      setHarnessEnabled(home, id, true);
    }
    const { steps } = await syncHarness({
      home, id, pluginRoot: entry.installPath, run, now, yes, isTTY, confirm, log, launcherPath: launcherFile(home),
    });
    const failedSteps = [];
    for (const s of steps) {
      log(`${s.id}: ${s.status} — ${s.detail}`);
      if (s.status === 'failed') failedSteps.push(s.id);
      if (s.id === 'codex-rules-gate' && s.status === 'skipped') splitLeft = true;
    }
    if (failedSteps.length > 0) failed.push(`${id} (${failedSteps.join(', ')})`);
    else setUp.push(id);
  }
  const parts = [];
  if (setUp.length > 0) parts.push(`set up ${setUp.join(', ')}`);
  if (skipped.length > 0) parts.push(`skipped ${skipped.join(', ')}`);
  if (unconfirmed.length > 0) {
    parts.push(`skipped ${unconfirmed.join(', ')}: not confirmed (confirm on a terminal, or pass --yes)`);
  }
  if (failed.length > 0) parts.push(`failed ${failed.join(', ')}`);
  if (splitLeft) parts.push(`the one-time ~/.codex/AGENTS.md split is not done: ${SPLIT_COMMAND}`);
  if (parts.length === 0) return { status: 'skipped', detail: 'no harness detected' };
  const status = failed.length > 0 ? 'failed' : (setUp.length > 0 ? 'done' : 'skipped');
  return { status, detail: parts.join('; ') };
}

function readLegacy(path) {
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  const hashes = isObject(legacy) && isObject(legacy.agents) ? Object.values(legacy.agents) : null;
  if (!hashes || !hashes.every((h) => typeof h === 'string') || typeof legacy.workflowGate !== 'string') {
    throw new Error(`${path} is malformed: expected { agents: { name: sha256 }, workflowGate: sha256 }`);
  }
  return legacy;
}

function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Backs `path` up into `backupDir`, checks that the backup holds the bytes hashing to `hash` (backupFile keeps an
// existing backup of the same name), then deletes `path`. Any failure throws before the delete.
function removeWithBackup(path, backupDir, hash) {
  const dest = backupFile(path, backupDir);
  if (!dest || sha256(readFileSync(dest)) !== hash) throw new Error(`backup of ${path} failed; it was not removed`);
  unlinkSync(path);
}

const differs = (names) => `kept ${names.join(', ')}: content differs from the legacy version`;

// Deletes each agent named in legacy.json whose bytes hash to the listed sha256, once the roles plugin ships them.
async function legacyAgents({ home, backupDir, legacyPath }) {
  const rolesId = idOf(home, 'roles');
  if (!userInstall(home, rolesId)) return { status: 'skipped', detail: `${rolesId} is not installed` };
  const { agents } = readLegacy(legacyPath);
  const removed = [];
  const kept = [];
  for (const [name, hash] of Object.entries(agents)) {
    const path = join(home, '.claude', 'agents', name);
    const bytes = readIfPresent(path);
    if (bytes === null) continue;
    if (sha256(bytes) !== hash) {
      kept.push(name);
      continue;
    }
    removeWithBackup(path, backupDir, hash);
    removed.push(name);
  }
  const notes = [];
  if (removed.length > 0) notes.push(`removed ${removed.join(', ')} (backup in ${backupDir})`);
  if (kept.length > 0) notes.push(differs(kept));
  if (removed.length === 0) return { status: 'already', detail: notes.join('; ') || 'no legacy agents found' };
  return { status: 'done', detail: notes.join('; ') };
}

const isGateHook = (hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.includes(GATE_HOOK);

// Removes every hook whose command runs hooks/workflow-gate.mjs, under any event. A matcher group or an event array
// is dropped only when this removal emptied it. Returns how many hooks were removed.
function removeGateHooks(settings) {
  if (!isObject(settings) || !isObject(settings.hooks)) return 0;
  let total = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    let removedHere = 0;
    const kept = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isGateHook(h));
      const n = group.hooks.length - hooks.length;
      removedHere += n;
      if (n === 0) kept.push(group);
      else if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (removedHere === 0) continue;
    total += removedHere;
    if (kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }
  return total;
}

// Retires the hand-installed workflow gate once the workflow-gate plugin ships it. settings.json goes first, so a
// failure there (invalid JSON) leaves the hook file in place too and no hook entry points at a deleted file.
async function legacyGate({ home, backupDir, legacyPath }) {
  const gateId = idOf(home, 'workflow-gate');
  if (!userInstall(home, gateId)) return { status: 'skipped', detail: `${gateId} is not installed` };
  const { workflowGate } = readLegacy(legacyPath);
  const notes = [];
  let changed = false;
  let count = 0;
  try {
    const { changed: edited } = editSettings(settingsPath(home), (obj) => { count = removeGateHooks(obj); }, { backupDir });
    if (edited) {
      changed = true;
      notes.push(`removed ${count} ${GATE_HOOK} hook(s) from settings.json`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // no settings.json: no entry to remove
  }
  const hook = join(home, '.claude', 'hooks', 'workflow-gate.mjs');
  const bytes = readIfPresent(hook);
  if (bytes !== null) {
    if (sha256(bytes) === workflowGate) {
      removeWithBackup(hook, backupDir, workflowGate);
      changed = true;
      notes.push(`removed ${hook} (backup in ${backupDir})`);
    } else {
      notes.push(differs([hook]));
    }
  }
  if (!changed) return { status: 'already', detail: notes.join('; ') || 'no legacy workflow gate found' };
  return { status: 'done', detail: notes.join('; ') };
}

// Removes settings.json's `language` key, only after the user confirms (never with --keep-language).
async function language({ home, argv, ask, backupDir }) {
  const path = settingsPath(home);
  const raw = readIfPresent(path);
  let settings = null;
  if (raw !== null) {
    try {
      settings = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error(`settings.json is not valid JSON: ${path}`);
    }
  }
  if (!isObject(settings) || !Object.hasOwn(settings, 'language')) {
    return { status: 'already', detail: 'settings.json has no "language" key' };
  }
  const value = settings.language;
  if (argv.includes('--keep-language')) return { status: 'skipped', detail: `"language": "${value}" kept (--keep-language)` };
  const message = `Remove "language": "${value}" from settings.json? It forces the reply language; it also sets voice `
    + 'dictation and session-title language. Replies will then mirror your message language.';
  if (!(await ask(message))) {
    return { status: 'skipped', detail: `"language": "${value}" kept: not confirmed (confirm on a terminal, or pass --yes)` };
  }
  editSettings(path, (obj) => { delete obj.language; }, { backupDir });
  return { status: 'done', detail: `removed "language" from ${path}` };
}

// Adds the allow rule for `triqual tracking` to permissions.allow in settings.json, only after the user confirms (or
// --yes). In local mode the tracking files live under the git dir, and in store mode in a database outside the repo;
// Claude Code refuses an agent's file writes in both, and `triqual tracking write|add|status` writes them itself, so the
// rule lets it run without a prompt. The rule itself or the broader `Bash(triqual:*)` covers it; a cm rule and the
// narrower `Bash(triqual tracking write:*)` an earlier bootstrap added do not, and stay beside it. A missing
// settings.json is created; an existing one is backed up first. An unusable settings.json or permissions.allow fails
// the step untouched.
async function trackingPermission({ home, ask, backupDir }) {
  const path = settingsPath(home);
  const raw = readIfPresent(path);
  let settings = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error(`settings.json is not valid JSON: ${path}`);
    }
    if (!isObject(settings)) throw new Error(`settings.json is not a JSON object: ${path}`);
  }
  if (settings.permissions !== undefined && !isObject(settings.permissions)) {
    throw new Error(`"permissions" in ${path} is not an object`);
  }
  const allow = settings.permissions?.allow;
  if (allow !== undefined && !Array.isArray(allow)) throw new Error(`"permissions.allow" in ${path} is not an array`);
  const covering = TRACKING_COVERED_BY.find((rule) => allow?.includes(rule));
  if (covering === TRACKING_ALLOW) return { status: 'already', detail: `permissions.allow has "${TRACKING_ALLOW}"` };
  if (covering) {
    return { status: 'already', detail: `permissions.allow has "${covering}", which covers "${TRACKING_ALLOW}"` };
  }
  const message = `Add "${TRACKING_ALLOW}" to permissions.allow in ${path}? In store mode the tracking entries live in a `
    + 'database and in local mode the tracking files live under the git dir, where Claude Code refuses agent file '
    + `writes; ${BRAND.cli} tracking writes them, and this rule lets it run without a prompt. That covers every `
    + `${BRAND.cli} tracking command, among them \`${BRAND.cli} tracking restore <snapshot> --yes\` and \`${BRAND.cli} `
    + `tracking import --replace --from <file>\` (both replace the database's rows) and \`${BRAND.cli} tracking export `
    + '--out <path>` (writes a file).';
  if (!(await ask(message))) {
    return { status: 'skipped', detail: `"${TRACKING_ALLOW}" not added: not confirmed (confirm on a terminal, or pass --yes)` };
  }
  const add = (obj) => {
    obj.permissions = isObject(obj.permissions) ? obj.permissions : {};
    obj.permissions.allow = [...(obj.permissions.allow ?? []), TRACKING_ALLOW];
  };
  if (raw === null) {
    mkdirSync(dirname(path), { recursive: true });
    const created = {};
    add(created);
    writeAtomic(path, `${JSON.stringify(created, null, 2)}\n`);
  } else {
    editSettings(path, add, { backupDir });
  }
  return { status: 'done', detail: `added "${TRACKING_ALLOW}" to permissions.allow in ${path}` };
}

// Runs the installed shim through its triqual link, so doctor checks what a user's `triqual doctor` would run. Warnings
// do not fail bootstrap. Exit 0 counts only with doctor's report line: a shim that ran nothing also exits 0.
async function doctor({ home, run }) {
  const r = await tryRun(run, process.execPath, [shimLink(home), 'doctor'], CHECK_TIMEOUT_MS);
  const lines = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.code === 0) {
    const report = String(r.stdout ?? '').split('\n').find((l) => DOCTOR_REPORT.test(l));
    if (report) return { status: 'done', detail: report };
    return { status: 'failed', detail: `${BRAND.cli} doctor produced no report` };
  }
  const fails = lines.filter((l) => l.startsWith('FAIL '));
  const summary = lines.at(-1);
  const shown = [...fails, ...(summary && !fails.includes(summary) ? [summary] : [])];
  return { status: 'failed', detail: shown.join('; ') || failureDetail(r) };
}

// `triqual migrate` from this clone, with this run's `now`, the CLI installer, and the terminal (for Codex's AGENTS.md
// split) (R1: before the marketplace step, and every rules and legacy step needs it). Its lines go to `log` under
// `migrate/`; the step is `done` when a migrate step was, `already` when none was, and `failed` with the first failed
// line. A failure of verify alone does not gate: those leftovers are what migrate cannot clear, each named by doctor
// (the last step, so bootstrap still exits 1) with its own fix.
async function migrateStep({ home, run, now, log, argv, isTTY, confirm, legacyCli }) {
  const { code, lines, leftovers } = await migrate({
    home, run, now, log: (line) => log(`migrate/${line}`), installCli: (opts) => installCli({ ...opts, legacyCli }),
    isTTY, yes: argv.includes('--yes'), confirm,
  });
  const failed = lines.filter((l) => /^[a-z]+: failed — /.test(l));
  if (code !== 0 && failed.length === 1 && failed[0].startsWith('verify: ')) {
    return { status: 'done', detail: `${leftovers} leftover${leftovers === 1 ? '' : 's'}: run ${BRAND.cli} doctor` };
  }
  if (code !== 0) return { status: 'failed', detail: failed[0] };
  const done = lines.filter((l) => /^[a-z]+: done — /.test(l)).map((l) => l.slice(0, l.indexOf(':')));
  return done.length ? { status: 'done', detail: `migrated: ${done.join(', ')}` } : { status: 'already', detail: 'nothing to migrate' };
}

// The legacy cleanup needs the rules synced: on a CLAUDE.md the rules gate refuses, the legacy agents and gate hook
// stay until the rules move into the managed section. The language step is independent.
const RULES_NOT_SYNCED = { rules: 'rules not synced' };

export const STEPS = [
  { id: 'prereqs', run: prereqs },
  { id: 'migrate', needs: ['prereqs'], run: migrateStep },
  { id: 'marketplace', needs: ['prereqs', 'migrate'], run: marketplace },
  { id: 'install', needs: ['prereqs', 'migrate', 'marketplace'], run: install },
  { id: 'shim', needs: ['prereqs', 'migrate'], run: installCli },
  { id: 'rules-gate', needs: ['prereqs', 'migrate'], run: syncStep('rules-gate') },
  { id: 'rules', needs: ['prereqs', 'migrate'], run: syncStep('rules') },
  { id: 'legacy-agents', needs: ['prereqs', 'migrate', 'rules'], blocked: RULES_NOT_SYNCED, run: legacyAgents },
  { id: 'legacy-gate', needs: ['prereqs', 'migrate', 'rules'], blocked: RULES_NOT_SYNCED, run: legacyGate },
  { id: 'supersedes', needs: ['prereqs', 'migrate'], run: syncStep('supersedes') },
  { id: 'harnesses', needs: ['prereqs', 'migrate', 'install', 'shim'], run: harnesses },
  { id: 'language', needs: ['prereqs'], run: language },
  { id: 'tracking-permission', needs: ['prereqs'], run: trackingPermission },
  { id: 'doctor', needs: ['prereqs', 'shim'], run: doctor },
];

// `now` names the run's single backup dir; `legacyPath` is setup/legacy.json unless a test injects another.
export async function runSteps(steps, {
  home, argv = [], run, isTTY, confirm, log = () => {}, nodeVersion = process.versions.node, now = new Date(),
  legacyPath = LEGACY_PATH,
}) {
  const ctx = {
    home, argv, run, nodeVersion, now, legacyPath, backupDir: backupDirFor(home, now), ask: makeAsk({ argv, isTTY, confirm }),
    isTTY, confirm, log, // for syncHarness: the Codex AGENTS.md split prompt and the harness step lines
    legacyCli: legacyCliPresent(home), // read before any step: whether the shim step installs the cm alias
  };
  const results = [];
  const statusOf = new Map();
  for (const step of steps) {
    const blocker = (step.needs ?? []).find((id) => ['failed', 'skipped'].includes(statusOf.get(id)));
    let outcome;
    if (blocker) {
      outcome = { status: 'skipped', detail: step.blocked?.[blocker] ?? `${blocker} ${statusOf.get(blocker)}` };
    } else {
      try {
        outcome = await step.run(ctx);
      } catch (err) {
        outcome = { status: 'failed', detail: err?.message ?? String(err) };
      }
    }
    const result = { id: step.id, status: outcome.status, detail: outcome.detail };
    statusOf.set(step.id, result.status);
    results.push(result);
    log(`${result.id}: ${result.status} — ${result.detail}`);
  }
  return { steps: results };
}

export function bootstrap(options) {
  return runSteps(STEPS, options);
}

// realRun (from doctor.mjs) spawns without a shell: a missing command resolves code 127, a timeout code 124.
export { realRun };

async function ttyConfirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Runs bootstrap on this machine with the terminal for confirmation and stdout for the step lines. Returns the exit
// code: 1 when a step failed, else 0.
export async function main(argv) {
  const { steps } = await bootstrap({
    home: homedir(),
    argv,
    run: realRun,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: ttyConfirm,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  return steps.some((s) => s.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
