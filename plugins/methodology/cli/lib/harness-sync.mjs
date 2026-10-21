// `triqual sync` for Codex and Grok (spec Addendum F.4): the steps that materialize the methodology in each harness from
// the user-scope Claude installs, and the harness session refresh. Every step reports `<id>-<step>: <status> —
// <detail>` with status done, already, skipped or failed, and records what it did in the manifest
// (lib/harness-manifest.mjs); `removeHarness` replays that record in reverse. Every codex/grok call goes through the
// injected `run`; ~/.grok/config.toml is never read, no config.toml or auth.json is ever copied, `[hooks.state]` is
// never written and hook trust is never bypassed (spec F.6). node: built-ins only.
import {
  chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  backupDirFor, backupFile, locate, MARKERS, sha256, upsertManagedSection, writeAtomic,
} from './fsx.mjs';
import { BRAND, pluginId } from './brand.mjs';
import {
  bridgeId, codexCloneDir, detect, EVENTS, expectedRules, harnessPaths, HARNESS_IDS, HOOK_TIMEOUTS,
} from './harnesses.mjs';
import { enabledInClaude } from './resolve.mjs';
import { configPath, readMethodologyConfig, supersededEnabled } from './settings.mjs';
import {
  editTomlFile, foreignTableKey, hasTopLevelKey, insertTopLevel, removeTableIfEmpty, removeTableKey, removeTopLevelKey,
  setTableKey,
} from './toml-edit.mjs';
import { tomlString } from './agents.mjs';
import { applyAgents, applyLinks, linkState, placeLink } from './harness-links.mjs';
import {
  forgetFile, manifestPath, readManifest, recordConfig, recordFile, recordPlugin, withManifest, writeManifest,
} from './harness-manifest.mjs';
import { withLock } from './lock.mjs';
import { legacyHeadingsOutside } from '../sync.mjs';

export { readManifest, writeManifest };

// The bridge's ids under either marketplace, the ones --remove-harness replays.
const BRIDGE_IDS = [BRAND.marketplace, BRAND.legacy.marketplace].map((m) => `methodology-codex@${m}`);
const CODEX_MARKETPLACES = [BRAND.marketplace, BRAND.legacy.marketplace];
const FALLBACK_KEY = 'project_doc_fallback_filenames';
const FALLBACK_LINE = `${FALLBACK_KEY} = ["CLAUDE.md"]`;
const CLI_TIMEOUT_MS = 60000;
// Grok's own copies we uninstall (F.11 P6d/P6e); superpowers only without keepSuperseded. Doctor checks the same list.
export const GROK_STALE =['methodology', 'progress-tracking', 'workflow-gate', 'roles', 'superpowers'];
const USER_PLUGINS = ['methodology', 'progress-tracking', 'roles'];
const CONFIG_UNREADABLE = 'config.json unreadable — fix it or remove it';
const LOCKED = 'harnesses.json is locked by another triqual sync or harness session: run triqual sync again';
const NOT_RECORDED = 'the change was made but not recorded in harnesses.json (another triqual sync or harness session '
  + 'held it), so triqual sync --remove-harness will not undo it: undo it by hand, or record it in harnesses.json by hand';
// The second wait for the record of a change a CLI step already made: past lock.mjs's 10 s stale age, so a lock left
// by a dead process is taken over.
const RECORD_RETRY_WAIT_MS = 15000;
// The one CLI call made under the manifest lock (editTomlFile's validate) ends before the lock's stale age, so a live
// holder is never taken over as dead.
export const VALIDATE_TIMEOUT_MS = 8000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

// { methodology, 'progress-tracking', roles }: each { installPath, version, enabled } from the user-scope entry of
// installed_plugins.json and Claude's user-scope enabledPlugins, or null when there is no such entry.
export function userInstalls(home) {
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch { /* unreadable reads as nothing installed */ }
  const out = {};
  for (const name of USER_PLUGINS) {
    const id = pluginId(home, name);
    const entries = installed?.plugins?.[id];
    const entry = Array.isArray(entries)
      ? entries.find((e) => isObject(e) && e.scope === 'user' && typeof e.installPath === 'string' && e.installPath)
      : null;
    out[name] = entry
      ? { installPath: entry.installPath, version: str(entry.version), enabled: enabledInClaude(home, id) }
      : null;
  }
  return out;
}

function readSupersedes(pluginRoot) {
  if (!pluginRoot) return [];
  try {
    const { supersedes } = JSON.parse(readFileSync(join(pluginRoot, 'rules', 'manifest.json'), 'utf8'));
    return Array.isArray(supersedes) ? supersedes.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

// keepSuperseded as the steps apply it: an unreadable config.json might set it, so superseded things are kept.
const keepingSuperseded = (config) => config.error !== null || config.keepSuperseded;

const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';

// One CLI call through the injected run: { code, stdout, stderr }; a run that throws reads as code null.
async function cli(ctx, cmd, args, timeoutMs = CLI_TIMEOUT_MS) {
  let r;
  try {
    r = await ctx.run(cmd, args, { timeoutMs, cwd: ctx.home });
  } catch (err) {
    r = { code: null, stdout: '', stderr: err?.message };
  }
  return { code: r?.code ?? null, stdout: str(r?.stdout) ?? '', stderr: str(r?.stderr) ?? '' };
}

class StepError extends Error {}

const failure = (cmd, args, r) => {
  const why = firstLine(r.stderr);
  return new StepError(`${cmd} ${args.join(' ')} exited ${r.code}${why ? `: ${why}` : ''}`);
};

// Runs a CLI call that must exit 0 and returns its stdout.
async function mustRun(ctx, cmd, args) {
  const r = await cli(ctx, cmd, args);
  if (r.code !== 0) throw failure(cmd, args, r);
  return r.stdout;
}

async function jsonOf(ctx, cmd, args) {
  const stdout = await mustRun(ctx, cmd, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new StepError(`${cmd} ${args.join(' ')} gave no JSON`);
  }
}

// Records under the manifest lock; a lock not taken fails the step. The config.toml steps run their edit inside fn, so
// a lock not taken leaves the file as it was.
async function record(ctx, fn) {
  const { locked, value } = await withManifest(ctx.home, ctx.id, fn, { waitMs: ctx.lockWaitMs });
  if (!locked) throw new StepError(LOCKED);
  return value;
}

// Records a change a CLI step already made: one retry with a longer wait, then NOT_RECORDED (the next triqual sync sees the
// change done and has nothing to record), followed by `what` (names and actions only).
async function recordMade(ctx, fn, what) {
  let res = await withManifest(ctx.home, ctx.id, fn, { waitMs: ctx.lockWaitMs });
  if (!res.locked) res = await withManifest(ctx.home, ctx.id, fn, { waitMs: ctx.lockRetryWaitMs });
  if (!res.locked) throw new StepError(`${NOT_RECORDED} (${what})`);
  return res.value;
}

// Runs one step: its { status, detail }, a thrown error as failed. Never throws.
async function step(id, fn) {
  try {
    const { status, detail } = await fn();
    return { id, status, detail };
  } catch (err) {
    return { id, status: 'failed', detail: String(err?.message ?? err) };
  }
}

// Makes a backup copy private: directories 0700, files 0600 (spec F.6); symlinks are left as copied. A reinstall uses
// `grok plugin install <source>`, not the backup, so no exec bit is needed.
function makePrivate(dir) {
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) makePrivate(p);
    else if (e.isFile()) chmodSync(p, 0o600);
  }
}

// Copies the directory `src` into backupDir (this run's, per harness; created 0700) as basename(src), made private,
// and returns the copy's path. An existing copy of the same name is kept: the first backup of a run wins, as in
// backupFile.
function backupTree(src, backupDir) {
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const dest = join(backupDir, basename(src));
  if (!existsSync(dest)) {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    makePrivate(dest);
  }
  return dest;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Writes a file that is ours whole (the Grok rules and hooks files). An existing file that is not what we last wrote
// is backed up first; the record keeps the first backup.
function writeOwnFile(ctx, entry, path, content) {
  const current = readText(path);
  const rec = entry.files.find((f) => f.path === path);
  if (current === content) {
    recordFile(entry, path, sha256(content));
    return 'already';
  }
  let backup = null;
  if (current !== null && sha256(current) !== rec?.sha256) backup = backupFile(path, ctx.backupDir);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, content);
  recordFile(entry, path, sha256(content), backup);
  return 'done';
}

// ---- Codex steps ----

const linkCtx = (ctx) => ({
  home: ctx.home, dir: ctx.paths.skills, installs: ctx.installs, supersedes: ctx.supersedes,
  keepSuperseded: keepingSuperseded(ctx.config),
});
const agentCtx = (ctx) => ({ dir: ctx.paths.agents, installs: ctx.installs, backupDir: ctx.backupDir });

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;

// The one-time split of an unmanaged AGENTS.md (spec F.4). A legacy-headed section runs to the next heading of the same
// or a higher level (headings inside fenced code do not count) and is dropped with its body, except that a non-legacy
// child heading keeps its whole subtree. A heading is legacy when `legacy` lists it or, with a dropped heading as its
// parent only, when `legacyChildren` does (exact lines, trailing whitespace ignored). Kept lines stay in order; the
// managed section is kept as it is and closes every open section. `dropped` and `kept` are the heading lines.
export function splitAgentsMd(text, { legacy, legacyChildren }) {
  const legacySet = new Set(legacy);
  const childSet = new Set(legacyChildren);
  const out = [];
  const dropped = [];
  const kept = [];
  let open = []; // the enclosing headings: { level, drop }
  let fence = null;
  let managed = false;
  const markers = locate(text).pair ?? MARKERS; // a legacy section counts as the managed one
  for (const line of text.split('\n')) {
    if (managed || line.includes(markers.start)) {
      managed = !line.includes(markers.end);
      open = [];
      out.push(line);
      continue;
    }
    const inSection = open.length > 0 && open[open.length - 1].drop;
    if (fence === null) {
      const heading = HEADING.exec(line);
      const opening = FENCE_OPEN.exec(line);
      if (heading) {
        const level = heading[1].length;
        while (open.length > 0 && open[open.length - 1].level >= level) open.pop();
        const parentDropped = open.length > 0 && open[open.length - 1].drop;
        const h = line.trimEnd();
        const drop = legacySet.has(h) || (parentDropped && childSet.has(h));
        open.push({ level, drop });
        (drop ? dropped : kept).push(h);
        if (!drop) out.push(line);
        continue;
      }
      if (opening) fence = opening[1];
    } else {
      const closing = FENCE_CLOSE.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
    }
    if (!inSection) out.push(line);
  }
  let next = out.join('\n');
  if (text.endsWith('\n') && !next.endsWith('\n')) next += '\n';
  return { text: next, dropped, kept };
}

const skillsStep = (ctx) => record(ctx, (entry) => applyLinks(linkCtx(ctx), entry));
const agentsStep = (ctx) => record(ctx, (entry) => applyAgents(agentCtx(ctx), entry));

const NEEDS_HUMAN = 'the one-time split needs a human: run triqual sync --harness codex';
const SPLIT_PROMPT = 'Split ~/.codex/AGENTS.md as shown?';

// Legacy headings outside the managed section offer the one-time split (spec F.4): the preview goes to `log`, then on
// a TTY without --yes the file is backed up, the user is asked, and the split is written and recorded
// (`rules.split`). Under --yes or on a non-TTY the gate is skipped: the split never auto-accepts.
async function rulesGate(ctx) {
  const path = ctx.paths.rules;
  const text = readText(path) ?? '';
  const readList = (...p) => JSON.parse(readFileSync(join(ctx.pluginRoot, 'rules', ...p), 'utf8'));
  const legacy = readList('legacy-headings.json');
  if (legacyHeadingsOutside(text, legacy).length === 0) {
    return { status: 'done', detail: 'no legacy headings outside the managed section' };
  }
  const split = splitAgentsMd(text, { legacy, legacyChildren: readList('harness', 'codex-legacy-children.json') });
  const left = legacyHeadingsOutside(split.text, legacy);
  if (left.length > 0) {
    throw new StepError(`the split leaves legacy headings outside the managed section: ${left.join(', ')}`);
  }
  ctx.log(`codex-rules-gate: the one-time split of ${path} drops:`);
  for (const h of split.dropped) ctx.log(`  - ${h}`);
  ctx.log('and keeps, outside the managed section:');
  for (const h of split.kept) ctx.log(`  + ${h}`);
  if (ctx.yes || !ctx.isTTY) return { status: 'skipped', detail: NEEDS_HUMAN };
  const backup = backupFile(path, ctx.backupDir);
  if (!(await ctx.confirm(SPLIT_PROMPT))) {
    return { status: 'skipped', detail: `split declined: ${path} left as it was` };
  }
  return record(ctx, (entry) => {
    if (readText(path) !== text) {
      throw new StepError(`${path} changed since the preview: run triqual sync --harness codex again`);
    }
    writeAtomic(path, split.text);
    entry.rules = { path, split: true, backup };
    return {
      status: 'done',
      detail: `split ${path}: dropped ${split.dropped.length} headings, kept ${split.kept.length} (backup ${backup})`,
    };
  });
}

const codexRulesStep = (ctx) => record(ctx, (entry) => {
  const path = ctx.paths.rules;
  const text = readText(path) ?? '';
  const { text: next, action } = upsertManagedSection(text, expectedRules(ctx.pluginRoot, 'codex'));
  if (action === 'unchanged') return { status: 'already', detail: 'managed section is current' };
  const backup = backupFile(path, ctx.backupDir);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, next);
  entry.rules = { path, split: entry.rules?.split ?? false, backup: entry.rules?.backup ?? backup };
  return { status: 'done', detail: `managed section ${action} in ${path}` };
});

const codexPlugins = async (ctx) => {
  const listed = await jsonOf(ctx, 'codex', ['plugin', 'list', '--json']);
  return Array.isArray(listed?.installed) ? listed.installed.filter(isObject) : [];
};

// `hooks  stable  true` → true; a missing line reads as off. Doctor reads the feature with it too.
export const hooksOn =(stdout) => /^hooks\s+\S+\s+true\s*$/m.test(stdout);

// The bridge bridgeId names, from the Codex marketplace of the same name: the Claude clone of that marketplace, whose
// .agents/plugins/marketplace.json carries its name. A clone that is not there yet (sync before migration) fails the
// step with the migration as its fix, before any Codex call that would register a missing path.
async function codexPluginStep(ctx) {
  const did = [];
  const bridge = bridgeId(ctx.home);
  const marketplace = bridge.slice(bridge.indexOf('@') + 1);
  const bridgeOn = (await codexPlugins(ctx)).some((p) => p.pluginId === bridge && p.enabled === true);
  if (!bridgeOn) {
    const { marketplaces } = await jsonOf(ctx, 'codex', ['plugin', 'marketplace', 'list', '--json']);
    const known = Array.isArray(marketplaces) && marketplaces.some((m) => m?.name === marketplace);
    if (!known) {
      const clone = codexCloneDir(ctx.home);
      if (!existsSync(clone)) throw new StepError(`${clone} does not exist: run ${BRAND.cli} migrate`);
      await mustRun(ctx, 'codex', ['plugin', 'marketplace', 'add', clone]);
      did.push({ id: marketplace, action: 'marketplace-added' });
    }
    await mustRun(ctx, 'codex', ['plugin', 'add', bridge]);
    did.push({ id: bridge, action: 'added' });
  }
  if (!hooksOn(await mustRun(ctx, 'codex', ['features', 'list']))) {
    await mustRun(ctx, 'codex', ['features', 'enable', 'hooks']);
    did.push({ id: 'hooks', action: 'feature-enabled' });
  }
  if (did.length === 0) return { status: 'already', detail: `${bridge} enabled, hooks feature on` };
  const words = {
    'marketplace-added': `added marketplace ${marketplace}`,
    added: `added ${bridge}`,
    'feature-enabled': 'enabled the hooks feature',
  };
  const detail = did.map((d) => words[d.action]).join(', ');
  await recordMade(ctx, (entry) => { for (const rec of did) recordPlugin(entry, rec); }, detail);
  return { status: 'done', detail };
}

// editTomlFile's validate: a config that `codex features list` parses. Resolves the literal true only on exit 0. It
// runs under the manifest lock, so it is killed at VALIDATE_TIMEOUT_MS (a timeout reads as invalid and restores).
const validateConfig = (ctx) => async () => (
  await cli(ctx, 'codex', ['features', 'list'], VALIDATE_TIMEOUT_MS)).code === 0;

function configFile(ctx) {
  const path = ctx.paths.config;
  if (!existsSync(path)) {
    throw new StepError(`${path} does not exist: start Codex once, then run triqual sync --harness codex`);
  }
  return path;
}

// The edit and its record run under one manifest lock (the validate is the only CLI call inside), so an edit is never
// left unrecorded; a lock not taken leaves config.toml as it was.
const codexConfigStep = (ctx) => {
  const path = configFile(ctx);
  return record(ctx, async (entry) => {
    const res = await editTomlFile(path, (text) => (hasTopLevelKey(text, FALLBACK_KEY)
      ? { text, changes: [] }
      : { text: insertTopLevel(text, [FALLBACK_LINE]), changes: [FALLBACK_KEY] }), { validate: validateConfig(ctx) });
    if (res.error) throw new StepError(res.error);
    if (!res.changed) return { status: 'already', detail: `${FALLBACK_KEY} is set` };
    recordConfig(entry, { key: FALLBACK_KEY, table: null, was: null, createdTable: false });
    return { status: 'done', detail: `added ${FALLBACK_LINE} before the first table` };
  });
};

// The depth the methodology's phase orchestrator needs: an orchestrator at depth 1 spawns the task agents at depth 2.
const DEPTH_WANTED = 2;
const DEPTH_NOT_NUMBER = '[agents] max_depth is not a number: left alone, set it to 2 or more by hand';
const DEPTH_BY_HAND = '[agents] is set by a dotted or inline key that sync cannot edit: set max_depth to 2 or more by hand';

// A TOML integer literal (decimal, with `_` separators, or 0x/0o/0b) as a number; null for anything else.
function tomlInteger(text) {
  if (/^[+-]?\d+(?:_\d+)*$/.test(text)) return Number(text.replaceAll('_', ''));
  const radix = { x: 16, o: 8, b: 2 }[/^0([xob])/.exec(text)?.[1]];
  const digits = { 16: /^[0-9a-f]+(?:_[0-9a-f]+)*$/i, 8: /^[0-7]+(?:_[0-7]+)*$/, 2: /^[01]+(?:_[01]+)*$/ }[radix];
  return radix && digits.test(text.slice(2)) ? parseInt(text.slice(2).replaceAll('_', ''), radix) : null;
}

// config.toml's [agents] max_depth: { state: 'unset' }, { state: 'number', value } or { state: 'other' } for a value
// that is not a TOML integer. `foreign: true` when it is set by a top-level dotted or inline key (`agents.max_depth =
// 3`, `agents = { max_depth = 3 }`) that the edit helpers cannot change; a definition of [agents] with no max_depth in
// it is `unset` and foreign. A read only: setTableKey's result is dropped.
export function codexMaxDepth(text) {
  const { was } = setTableKey(text, 'agents', 'max_depth', String(DEPTH_WANTED));
  const foreign = was === null ? foreignTableKey(text, 'agents', 'max_depth') : null;
  const raw = foreign ? foreign.value : was;
  if (raw === null) return foreign ? { state: 'unset', foreign: true } : { state: 'unset' };
  const value = tomlInteger(raw);
  const seen = value === null ? { state: 'other' } : { state: 'number', value };
  return foreign ? { ...seen, foreign: true } : seen;
}

// [agents] max_depth raised to 2 when absent or a number below 2, never lowered or touched at 2 or more. Recorded for
// the revert like codexConfigStep, edit and record under one manifest lock.
const codexDepthStep = (ctx) => {
  const path = configFile(ctx);
  return record(ctx, async (entry) => {
    let seen;
    const res = await editTomlFile(path, (text) => {
      seen = codexMaxDepth(text);
      if (seen.state === 'number' && seen.value >= DEPTH_WANTED) return { text, changes: null };
      if (seen.foreign) throw new StepError(DEPTH_BY_HAND);
      if (seen.state === 'other') throw new StepError(DEPTH_NOT_NUMBER);
      const r = setTableKey(text, 'agents', 'max_depth', String(DEPTH_WANTED));
      return { text: r.text, changes: { was: r.was, createdTable: r.createdTable } };
    }, { validate: validateConfig(ctx) });
    if (res.error) throw new StepError(res.error);
    if (!res.changed) return { status: 'already', detail: `[agents] max_depth is ${seen.value}, ${DEPTH_WANTED} or more` };
    const { was, createdTable } = res.changes;
    recordConfig(entry, { key: 'max_depth', table: 'agents', was, createdTable });
    return { status: 'done', detail: `${was === null ? 'set' : `raised from ${was} to`} [agents] max_depth = ${DEPTH_WANTED}` };
  });
};

const REMOTE = 'disabled in config.toml, Codex still lists it enabled (remotely managed?)';

// `codex plugin list --json` installed[] entries (objects) → { pluginId: enabled }, what supersededEnabled reads.
export const codexEnabledMap = (plugins) => Object.fromEntries(plugins.filter((p) => typeof p.pluginId === 'string')
  .map((p) => [p.pluginId, p.enabled]));

// The config.toml table whose `enabled` key disables a superseded Codex plugin (the manifest config[] record's table).
export const codexPluginTable = (pluginId) => `plugins.${tomlString(pluginId)}`;

async function codexSupersedesStep(ctx) {
  if (ctx.config.error) throw new StepError(CONFIG_UNREADABLE);
  if (ctx.config.keepSuperseded) {
    const detail = `keepSuperseded is set in ${configPath(ctx.home)}: superseded plugins left as they are`;
    return { status: 'already', detail };
  }
  const listed = await codexPlugins(ctx);
  const enabled = codexEnabledMap(listed);
  const ids = supersededEnabled(ctx.supersedes, enabled);
  if (ids.length === 0) return { status: 'already', detail: 'no superseded plugin enabled' };
  const path = configFile(ctx);
  const disabled = [];
  const remote = [];
  const problems = [];
  // Each edit is recorded as soon as it is made, under the same manifest lock; a lock not taken edits nothing.
  await record(ctx, async (entry) => {
    for (const pluginId of ids) {
      const table = codexPluginTable(pluginId);
      const res = await editTomlFile(path, (text) => {
        const r = setTableKey(text, table, 'enabled', 'false');
        return { text: r.text, changes: { was: r.was, createdTable: r.createdTable } };
      }, { validate: validateConfig(ctx) });
      if (res.error) {
        problems.push(`${pluginId}: ${res.error}`);
      } else if (res.changed) {
        recordConfig(entry, { key: 'enabled', table, was: res.changes.was, createdTable: res.changes.createdTable });
        disabled.push(pluginId);
      } else {
        remote.push(pluginId);
      }
    }
  });
  const parts = [];
  if (disabled.length) parts.push(`disabled ${disabled.join(', ')}`);
  if (remote.length) parts.push(`${REMOTE}: ${remote.join(', ')}`);
  if (problems.length) throw new StepError([...parts, ...problems].join('; '));
  return { status: disabled.length ? 'done' : 'skipped', detail: parts.join('; ') };
}

// ---- Grok steps ----

const grokStaleNames = (keep) => GROK_STALE.filter((n) => !(keep && n === 'superpowers'));
const grokNamed = (names) => (p) => isObject(p) && names.includes(p.name) && typeof p.path === 'string';

// The stale Grok plugins among `grok plugin list --json` entries `listed`: Grok-installed entries only, by real path.
// { stale: [{ ...entry, real }], leftAlone: [reason] }: an entry whose path resolves outside ~/.grok/installed-plugins/
// (a symlink out of it included), or does not resolve, is left alone and reported. triqual sync uninstalls `stale`; doctor
// fails on it.
export function grokStaleEntries(home, listed, keep) {
  const base = join(home, '.grok', 'installed-plugins');
  let root = null;
  try { root = realpathSync(base) + sep; } catch { /* no such dir: nothing is under it */ }
  const stale = [];
  const leftAlone = [];
  for (const p of (Array.isArray(listed) ? listed : []).filter(grokNamed(grokStaleNames(keep)))) {
    let real;
    try {
      real = realpathSync(p.path);
    } catch {
      leftAlone.push(`${p.name} (path cannot be resolved)`);
      continue;
    }
    if (root !== null && real.startsWith(root)) stale.push({ ...p, real });
    else if (resolve(p.path).startsWith(base + sep)) leftAlone.push(`${p.name} (resolves outside ${base})`);
  }
  return { stale, leftAlone };
}

const GROK_LIST = ['plugin', 'list', '--json'];
const GROK_OFF_PATH = 'grok is not on PATH (exit 127): its plugins are not listed, so a stale Grok plugin stays until '
  + `${BRAND.cli} sync --harness grok runs with grok on PATH`;

// Without grok on PATH (the list exits 127) no Grok plugin can be listed or uninstalled: the step is skipped, as
// migrate skips a Codex it cannot run (R2-c), and the rules and hooks steps still run.
async function grokPluginsStep(ctx) {
  if (ctx.config.error) throw new StepError(CONFIG_UNREADABLE);
  const keep = ctx.config.keepSuperseded;
  const kept = keep ? '; superpowers kept (keepSuperseded)' : '';
  const parsed = (r) => {
    if (r.code !== 0) throw failure('grok', GROK_LIST, r);
    let listed;
    try {
      listed = JSON.parse(r.stdout);
    } catch {
      throw new StepError(`grok ${GROK_LIST.join(' ')} gave no JSON`);
    }
    return Array.isArray(listed) ? listed : [];
  };
  const listGrok = async () => parsed(await cli(ctx, 'grok', GROK_LIST));
  const first = await cli(ctx, 'grok', GROK_LIST);
  if (first.code === 127) return { status: 'skipped', detail: GROK_OFF_PATH };
  const named = grokNamed(grokStaleNames(keep));
  const { stale, leftAlone } = grokStaleEntries(ctx.home, parsed(first), keep);
  const alone = leftAlone.length ? `; left alone: ${leftAlone.join(', ')}` : '';
  if (stale.length === 0) return { status: 'already', detail: `no stale Grok plugin installed${kept}${alone}` };
  const uninstalled = [];
  const problems = [];
  for (const p of stale) {
    const backup = backupTree(p.real, ctx.backupDir);
    const r = await cli(ctx, 'grok', ['plugin', 'uninstall', p.name]);
    if (r.code !== 0) problems.push(failure('grok', ['plugin', 'uninstall', p.name], r).message);
    else {
      uninstalled.push({
        rec: { name: p.name, source: str(p.source), version: str(p.version), backup, action: 'uninstalled' },
        path: p.path,
      });
    }
  }
  // Still installed: the same name listed at the same path after its uninstall.
  const after = (await listGrok()).filter(named);
  const still = (u) => after.some((p) => p.name === u.rec.name && p.path === u.path);
  const gone = uninstalled.filter((u) => !still(u)).map((u) => u.rec);
  for (const u of uninstalled) {
    if (still(u)) problems.push(`${u.rec.name} is still installed after grok plugin uninstall`);
  }
  const done = gone.length ? `uninstalled ${gone.map((u) => u.name).join(', ')} (backups in ${ctx.backupDir})` : '';
  if (gone.length) {
    try {
      await recordMade(ctx, (entry) => { for (const rec of gone) recordPlugin(entry, rec); }, done);
    } catch (err) {
      throw new StepError([err.message, ...problems].join('; '));
    }
  }
  if (problems.length) throw new StepError([done, ...problems].filter(Boolean).join('; '));
  return { status: 'done', detail: `${done}${kept}${alone}` };
}

// A Grok file under its pre-rename name, once ours is written at `current`: backed up, removed and its record dropped,
// so Grok never loads it beside ours. The backup that record kept of the user's own file (from before the first sync)
// moves to the record of `current`, so --remove-harness still restores it. `result` is the step's own outcome: a
// removal makes an `already` one `done`.
function dropLegacyFile(ctx, entry, path, current, result) {
  const kept = entry.files.find((f) => f.path === path && f.backup)?.backup ?? null;
  if (kept) {
    const rec = entry.files.find((f) => f.path === current);
    if (!rec) entry.files.push({ path: current, sha256: null, backup: kept });
    else if (!rec.backup) rec.backup = kept;
  }
  let i;
  while ((i = entry.files.findIndex((f) => f.path === path)) !== -1) entry.files.splice(i, 1);
  if (!existsSync(path)) return result;
  const backup = backupFile(path, ctx.backupDir);
  unlinkSync(path);
  const status = result.status === 'already' ? 'done' : result.status;
  return { status, detail: `${result.detail}; removed ${path} (backup ${backup})` };
}

// The Grok rules file follows methodology's enabled state in Claude: while disabled, the file we wrote (recorded, and
// unchanged since) is removed, and it is written again on re-enable. The hooks file stays (triqual hook is inert then).
function grokRules(ctx, entry) {
  const path = ctx.paths.rules;
  if (!enabledInClaude(ctx.home, pluginId(ctx.home, 'methodology'))) {
    const why = 'methodology is disabled in Claude';
    const rec = entry.files.find((f) => f.path === path && f.sha256 !== null);
    const current = rec ? readText(path) : null;
    if (!rec || current === null) {
      if (rec) forgetFile(entry, path);
      return { status: 'already', detail: `${why}: no rules file of ours` };
    }
    if (sha256(current) !== rec.sha256) {
      return { status: 'skipped', detail: `${why}: ${path} changed since triqual sync wrote it, left alone` };
    }
    unlinkSync(path);
    forgetFile(entry, path);
    return { status: 'done', detail: `${why}: removed ${path}` };
  }
  const status = writeOwnFile(ctx, entry, path, expectedRules(ctx.pluginRoot, 'grok'));
  return { status, detail: status === 'done' ? `wrote ${path}` : `${path} is current` };
}

const grokRulesStep = (ctx) => record(ctx, (entry) => dropLegacyFile(ctx, entry, ctx.paths.legacyRules, ctx.paths.rules,
  grokRules(ctx, entry)));

const hookEventName = (event) => event.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
// A path as one shell word: as is when it holds only safe characters, else single-quoted.
const shellWord = (s) => (/^[A-Za-z0-9_\/.+@%:=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ~/.grok/hooks/triqual.json: the three EVENTS.grok events (no Stop, F.2), through the launcher.
export function grokHooksFile(launcherPath) {
  const hooks = {};
  for (const event of EVENTS.grok) {
    hooks[hookEventName(event)] = [{
      hooks: [{
        type: 'command',
        command: `${shellWord(launcherPath)} ${event} --harness grok`,
        timeout: HOOK_TIMEOUTS.grok[event],
      }],
    }];
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

const grokHooksStep = (ctx) => record(ctx, (entry) => {
  const path = ctx.paths.hooksFile;
  const status = writeOwnFile(ctx, entry, path, grokHooksFile(ctx.launcherPath));
  const result = { status, detail: status === 'done' ? `wrote ${path}` : `${path} is current` };
  return dropLegacyFile(ctx, entry, ctx.paths.legacyHooksFile, path, result);
});

// ---- entry points ----

// The steps of one harness, in F.4 order. A harness `detect` reports absent gives one `<id>: skipped — not
// installed`. `pluginRoot` defaults to the user-scope methodology install. `yes`, `isTTY` and `confirm` are for the
// one-time AGENTS.md split (codex-rules-gate) and `log` for its preview.
export async function syncHarness({
  home, id, pluginRoot, run, now = new Date(), yes = false, isTTY = false, confirm, log = () => {}, launcherPath,
  lockWaitMs, lockRetryWaitMs = RECORD_RETRY_WAIT_MS,
}) {
  if (!HARNESS_IDS.includes(id)) throw new Error(`unknown harness: ${id}`);
  const found = (await detect({ home, run })).find((h) => h.id === id);
  if (!found?.present) return { steps: [{ id, status: 'skipped', detail: 'not installed' }] };
  const installs = userInstalls(home);
  const root = pluginRoot ?? installs.methodology?.installPath;
  if (!root) {
    const detail = 'methodology is not installed at user scope: '
      + `run claude plugin install methodology@${BRAND.marketplace} --scope user`;
    return { steps: [{ id, status: 'failed', detail }] };
  }
  const ctx = {
    home, id, run, installs, pluginRoot: root, yes, isTTY, confirm, log, lockWaitMs, lockRetryWaitMs,
    paths: harnessPaths(home, id),
    config: readMethodologyConfig(home),
    supersedes: readSupersedes(root),
    backupDir: join(backupDirFor(home, now), id),
    launcherPath: launcherPath ?? join(home, '.local', 'bin', BRAND.launcher),
  };
  const steps = [];
  if (id === 'codex') {
    steps.push(await step('codex-skills', () => skillsStep(ctx)));
    const gate = await step('codex-rules-gate', () => rulesGate(ctx));
    steps.push(gate);
    steps.push(gate.status === 'done'
      ? await step('codex-rules', () => codexRulesStep(ctx))
      : { id: 'codex-rules', status: gate.status, detail: `not written: ${gate.detail}` });
    steps.push(await step('codex-agents', () => agentsStep(ctx)));
    steps.push(await step('codex-plugin', () => codexPluginStep(ctx)));
    steps.push(await step('codex-config', () => codexConfigStep(ctx)));
    steps.push(await step('codex-depth', () => codexDepthStep(ctx)));
    steps.push(await step('codex-supersedes', () => codexSupersedesStep(ctx)));
  } else {
    steps.push(await step('grok-plugins', () => grokPluginsStep(ctx)));
    steps.push(await step('grok-rules', () => grokRulesStep(ctx)));
    steps.push(await step('grok-hooks', () => grokHooksStep(ctx)));
  }
  return { steps };
}

// ---- removal (`triqual sync --remove-harness <id>`) ----

const REINSTALL_NOTE = 'a reinstalled plugin comes back with marketplace: null';
const CHANGED = 'left alone (changed since triqual sync)';

const rmdirIfEmpty = (dir) => { try { rmdirSync(dir); } catch { /* not empty, or gone */ } };

// A removal step's outcome: `parts` done, `leftAlone` names reported, `problems` failing the step (the records of what
// failed stay in the manifest for another run).
function outcome({ parts, changed, leftAlone = [], problems = [], nothing }) {
  const all = [...parts];
  if (leftAlone.length) all.push(`${CHANGED}: ${leftAlone.join(', ')}`);
  if (problems.length) throw new StepError([...all, ...problems].join('; '));
  if (changed) return { status: 'done', detail: all.join('; ') };
  if (leftAlone.length) return { status: 'skipped', detail: all.join('; ') };
  return { status: 'already', detail: nothing };
}

const dropFrom = (list, rec) => list.splice(list.indexOf(rec), 1);

// The recorded links, newest first: our link (or a free path) gets back what it replaced, or is removed; a link the
// user changed since is left alone. Handled records are dropped.
const removeLinksStep = (ctx) => record(ctx, (entry) => {
  let restored = 0;
  let removed = 0;
  const leftAlone = [];
  const problems = [];
  const recorded = entry.links.length;
  for (const rec of [...entry.links].reverse()) {
    try {
      const cur = linkState(rec.path);
      const ours = rec.target !== null && cur.kind === 'link' && cur.text === rec.target;
      if (ours || cur.kind === 'missing') {
        if (rec.replaced) {
          placeLink(rec.replaced, rec.path);
          restored += 1;
        } else if (ours) {
          unlinkSync(rec.path);
          removed += 1;
        }
      } else if (!(cur.kind === 'link' && cur.text === rec.replaced)) {
        leftAlone.push(basename(rec.path));
      }
      dropFrom(entry.links, rec);
    } catch (err) {
      problems.push(`${basename(rec.path)}: ${err.message}`);
    }
  }
  const parts = [];
  if (restored) parts.push(`restored ${restored} replaced link${restored === 1 ? '' : 's'}`);
  if (removed) parts.push(`removed ${removed} link${removed === 1 ? '' : 's'} of ours`);
  const nothing = recorded ? 'already restored' : 'no link recorded';
  return outcome({ parts, changed: restored + removed > 0, leftAlone, problems, nothing });
});

// File records: ours, unchanged since sync (sha256 as recorded), or a missing file, gets its backup back, or ours is
// removed; a file changed since is left alone. Handled records are dropped. `rmdir`: also remove the file's dir once
// empty (the Grok rules and hooks dirs sync created).
function revertFiles(entry, recs, { rmdir = false } = {}) {
  const out = { restored: [], removed: [], leftAlone: [], problems: [] };
  for (const rec of recs) {
    const name = basename(rec.path);
    try {
      const current = readText(rec.path);
      const ours = current !== null && rec.sha256 !== null && sha256(current) === rec.sha256;
      if (ours || current === null) {
        if (rec.backup) {
          if (!existsSync(rec.backup)) throw new StepError(`its backup ${rec.backup} is missing: left as it is`);
          mkdirSync(dirname(rec.path), { recursive: true });
          writeAtomic(rec.path, readFileSync(rec.backup));
          out.restored.push(name);
        } else if (ours) {
          unlinkSync(rec.path);
          if (rmdir) rmdirIfEmpty(dirname(rec.path));
          out.removed.push(name);
        }
      } else {
        out.leftAlone.push(name);
      }
      dropFrom(entry.files, rec);
    } catch (err) {
      out.problems.push(`${name}: ${err.message}`);
    }
  }
  return out;
}

const filesOutcome = (r, nothing) => {
  const parts = [];
  if (r.removed.length) parts.push(`removed ${r.removed.join(', ')}`);
  if (r.restored.length) parts.push(`restored ${r.restored.join(', ')} from backup`);
  return outcome({
    parts, changed: r.removed.length + r.restored.length > 0, leftAlone: r.leftAlone, problems: r.problems, nothing,
  });
};

const removeAgentsStep = (ctx) => record(ctx, (entry) => {
  const recs = entry.files.filter((f) => dirname(f.path) === ctx.paths.agents).reverse();
  entry.rolesSha = null;
  return filesOutcome(revertFiles(entry, recs), 'no agent file recorded');
});

// Our own whole file (the Grok rules or hooks file), under any of `paths`: its name and the legacy one an older sync
// recorded.
const removeOwnFileStep = (ctx, paths, what) => record(ctx, (entry) => {
  const recs = entry.files.filter((f) => paths.includes(f.path));
  return filesOutcome(revertFiles(entry, recs, { rmdir: true }), `no ${what} recorded`);
});

// The text without the managed section: the markers, what lies between them and the newline after the end marker,
// plus the blank line sync put before an appended section. A malformed section throws: its extent is unknown.
function withoutManagedSection(text) {
  const { start, end, pair, error } = locate(text);
  if (error) throw new StepError(`managed section is ${error}: left as it is`);
  if (start === null) return text;
  let before = text.slice(0, start);
  let after = text.slice(end + pair.end.length);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n') && (after === '' || after.startsWith('\n'))) before = before.slice(0, -1);
  return before + after;
}

// ~/.codex/AGENTS.md: the managed section removed, the file backed up first. After the one-time split the post-split
// text stays by default (the detail names the pre-split backup, to copy back by hand: this run drops the record, so a
// later --restore-agents-md has nothing to act on); with restoreAgentsMd the pre-split file comes back from
// `rules.backup`. A file sync created is removed once nothing else is left in it.
const removeCodexRulesStep = (ctx) => record(ctx, (entry) => {
  const rules = entry.rules;
  if (!rules) return { status: 'already', detail: 'no managed section recorded' };
  const { path, split, backup } = rules;
  const text = readText(path);
  if (ctx.restoreAgentsMd && split) {
    if (!backup || !existsSync(backup)) {
      throw new StepError(`the pre-split backup ${backup} is missing: ${path} left as it is`);
    }
    const saved = text === null ? null : backupFile(path, ctx.backupDir);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, readFileSync(backup));
    entry.rules = null;
    const was = saved ? ` (the post-split file backed up to ${saved})` : '';
    return { status: 'done', detail: `restored the pre-split ${path} from ${backup}${was}` };
  }
  const note = split
    ? `; the pre-split file is at ${backup}: to put it back, copy it to ${path} by hand`
      + ' (--restore-agents-md only works on the removal run itself)'
    : (ctx.restoreAgentsMd ? '; --restore-agents-md: nothing to restore, AGENTS.md was never split' : '');
  if (text === null) {
    entry.rules = null;
    return { status: 'already', detail: `${path} is gone${note}` };
  }
  const next = withoutManagedSection(text);
  if (next === text) {
    entry.rules = null;
    return { status: 'already', detail: `no managed section in ${path}${note}` };
  }
  const saved = backupFile(path, ctx.backupDir);
  if (next === '' && !split && backup === null) unlinkSync(path);
  else writeAtomic(path, next);
  entry.rules = null;
  return { status: 'done', detail: `removed the managed section from ${path} (backup ${saved})${note}` };
});

// One recorded config.toml change undone: a key it added is removed (and the table it created with it, unless the user
// has put anything else in it since), a key it changed gets its prior value back.
function revertConfig(text, rec) {
  if (rec.createdTable) return removeTableIfEmpty(removeTableKey(text, rec.table, rec.key), rec.table);
  if (rec.was === null) {
    return rec.table === null ? removeTopLevelKey(text, rec.key) : removeTableKey(text, rec.table, rec.key);
  }
  if (rec.table === null) throw new StepError('a changed top-level key has no revert');
  // T7's setTableKey writes the line as `key = value`, so the file comes back byte-equal to the pre-sync one only
  // when the user's line had that spacing.
  return setTableKey(text, rec.table, rec.key, rec.was).text;
}

// The config[] records, newest first, each through editTomlFile (validated by `codex features list`) and dropped from
// the manifest under the same lock. Details name keys and tables only, never a value.
const removeConfigStep = (ctx) => record(ctx, async (entry) => {
  if (entry.config.length === 0) return { status: 'already', detail: 'no config.toml change recorded' };
  const path = ctx.paths.config;
  if (!existsSync(path)) throw new StepError(`${path} does not exist: its recorded changes are not reverted`);
  const reverted = [];
  const gone = [];
  const problems = [];
  for (const rec of [...entry.config].reverse()) {
    const name = rec.table === null ? rec.key : `${rec.table}.${rec.key}`;
    let res;
    try {
      res = await editTomlFile(path, (text) => ({ text: revertConfig(text, rec), changes: null }), {
        validate: validateConfig(ctx),
      });
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
      continue;
    }
    if (res.error) {
      problems.push(`${name}: ${res.error}`);
      continue;
    }
    (res.changed ? reverted : gone).push(name);
    dropFrom(entry.config, rec);
  }
  const parts = [];
  if (reverted.length) parts.push(`reverted ${reverted.join(', ')}`);
  if (gone.length) parts.push(`already as before triqual sync: ${gone.join(', ')}`);
  if (problems.length) throw new StepError([...parts, ...problems].join('; '));
  return { status: reverted.length ? 'done' : 'already', detail: parts.join('; ') };
});

const entryCopy = (ctx) => record(ctx, (entry) => structuredClone(entry));

// `codex plugin remove` for each bridge sync added, then `codex plugin marketplace remove` for each marketplace it added,
// in record order (the rest not run once one fails), matching ids recorded under either marketplace name. The hooks feature sync
// enabled stays on: other plugins may use it. A record matching none of these is reported and kept.
async function removeCodexPluginStep(ctx) {
  const entry = await entryCopy(ctx);
  const recs = entry.plugins.filter(isObject);
  const has = (id, action) => recs.some((p) => p.id === id && p.action === action);
  const of = (action, ids) => recs.filter((p) => p.action === action && ids.includes(p.id));
  const todo = [
    ...of('added', BRIDGE_IDS).map(({ id }) => ({
      id, action: 'added', args: ['plugin', 'remove', id], word: `removed ${id}`,
    })),
    ...of('marketplace-added', CODEX_MARKETPLACES).map(({ id }) => ({
      id, action: 'marketplace-added', args: ['plugin', 'marketplace', 'remove', id], word: `removed marketplace ${id}`,
    })),
  ];
  const matched = (p) => todo.some((t) => p.id === t.id && p.action === t.action)
    || (p.id === 'hooks' && p.action === 'feature-enabled');
  const unknown = recs.filter((p) => !matched(p)).map((p) => `${p.id ?? p.name} (${p.action})`);
  const unknownNote = unknown.length ? [`not recognized, kept in harnesses.json: ${unknown.join(', ')}`] : [];
  const hooks = has('hooks', 'feature-enabled');
  const hooksNote = 'the hooks feature triqual sync enabled stays on (other plugins may use it)';
  if (todo.length === 0 && !hooks) {
    return unknown.length ? { status: 'skipped', detail: unknownNote[0] }
      : { status: 'already', detail: 'no Codex plugin recorded' };
  }
  const done = [];
  let problem = null;
  for (const t of todo) {
    const r = await cli(ctx, 'codex', t.args);
    if (r.code !== 0) {
      problem = failure('codex', t.args, r).message;
      const rest = todo.slice(todo.indexOf(t) + 1).map((n) => `codex ${n.args.join(' ')}`);
      if (rest.length) problem += `; not run: ${rest.join(', ')}`;
      break;
    }
    done.push(t);
  }
  const handled = [...done, ...(hooks ? [{ id: 'hooks', action: 'feature-enabled' }] : [])];
  const parts = [...done.map((t) => t.word), ...(hooks ? [hooksNote] : [])];
  if (handled.length) {
    await recordMade(ctx, (e) => {
      e.plugins = e.plugins.filter((p) => !handled.some((h) => p.id === h.id && p.action === h.action));
    }, parts.join(', '));
  }
  if (problem) throw new StepError([...parts, ...unknownNote, problem].join('; '));
  const status = done.length ? 'done' : (unknown.length ? 'skipped' : 'already');
  return { status, detail: [...parts, ...unknownNote].join('; ') };
}

// The Grok plugins sync uninstalled: `grok plugin install <source> --trust` pre-approves the plugin's hooks, a hook
// trust control (Information Security Policy), so it runs only after the user confirms each one on a TTY. Under --yes
// or off a TTY nothing runs: the detail holds each command and backup for the user. Records of plugins not reinstalled
// stay in the manifest, so a later run on a terminal can still reinstall them.
async function removeGrokPluginsStep(ctx) {
  const recs = (await entryCopy(ctx)).plugins.filter((p) => p.action === 'uninstalled');
  if (recs.length === 0) return { status: 'already', detail: 'no Grok plugin recorded as uninstalled' };
  const command = (p) => `grok plugin install ${shellWord(p.source)} --trust`;
  const describe = (p) => (p.source ? `${command(p)} (backup ${p.backup})`
    : `${p.name}: no source recorded (backup ${p.backup})`);
  if (ctx.yes || !ctx.isTTY || typeof ctx.confirm !== 'function') {
    const detail = `reinstall needs a human: ${recs.map(describe).join('; ')}; ${REINSTALL_NOTE}`;
    return { status: 'skipped', detail };
  }
  ctx.log(`grok-plugins: triqual sync uninstalled these; --trust pre-approves each plugin's hooks (${REINSTALL_NOTE}):`);
  for (const p of recs) ctx.log(`  ${describe(p)}`);
  const installed = [];
  const declined = [];
  const problems = [];
  for (const p of recs) {
    if (!p.source) {
      problems.push(describe(p));
      continue;
    }
    if (!(await ctx.confirm(`Reinstall ${p.name} with ${command(p)}?`))) {
      declined.push(p);
      continue;
    }
    const args = ['plugin', 'install', p.source, '--trust'];
    const r = await cli(ctx, 'grok', args);
    if (r.code !== 0) problems.push(`${failure('grok', args, r).message} (backup ${p.backup})`);
    else installed.push(p);
  }
  let back = installed;
  if (installed.length) {
    try {
      const listed = await jsonOf(ctx, 'grok', ['plugin', 'list', '--json']);
      const names = new Set((Array.isArray(listed) ? listed : []).filter(isObject).map((l) => l.name));
      back = installed.filter((p) => names.has(p.name));
      for (const p of installed) {
        if (!names.has(p.name)) problems.push(`${p.name} is not listed after grok plugin install`);
      }
    } catch (err) {
      back = [];
      problems.push(err.message);
    }
  }
  const parts = [];
  if (back.length) parts.push(`reinstalled ${back.map((p) => p.name).join(', ')}`);
  if (declined.length) parts.push(`declined: ${declined.map(describe).join('; ')}`);
  parts.push(REINSTALL_NOTE);
  if (back.length) {
    await recordMade(ctx, (e) => {
      e.plugins = e.plugins.filter((p) => !(p.action === 'uninstalled' && back.some((b) => b.name === p.name)));
    }, `reinstalled ${back.map((p) => p.name).join(', ')}`);
  }
  if (problems.length) throw new StepError([...parts, ...problems].join('; '));
  return { status: back.length ? 'done' : 'skipped', detail: parts.join('; ') };
}

// What an entry still records, as `<n> <kind>` words.
function leftovers(raw) {
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const out = [];
  const counts = [
    ['links', count(raw?.links)], ['files', count(raw?.files)], ['config changes', count(raw?.config)],
    ['plugins', count(raw?.plugins)], ['rules', raw?.rules ? 1 : 0],
  ];
  for (const [kind, n] of counts) {
    if (n) out.push(`${n} ${kind}`);
  }
  return out;
}

// Deletes the harness's manifest entry once every record is handled; otherwise keeps it for another run.
async function removeManifestStep(ctx) {
  const path = manifestPath(ctx.home);
  const opts = ctx.lockWaitMs === undefined ? {} : { waitMs: ctx.lockWaitMs };
  const { locked, value } = await withLock(path, () => {
    const manifest = readManifest(ctx.home);
    if (!Object.hasOwn(manifest.harnesses, ctx.id)) {
      return { status: 'already', detail: `no ${ctx.id} entry in ${path}` };
    }
    const left = leftovers(manifest.harnesses[ctx.id]);
    if (left.length) {
      const detail = `kept the ${ctx.id} entry of ${path}, still recording ${left.join(', ')}: `
        + `run triqual sync --remove-harness ${ctx.id} again (on a terminal to reinstall)`;
      return { status: 'skipped', detail };
    }
    delete manifest.harnesses[ctx.id];
    writeManifest(ctx.home, manifest);
    return { status: 'done', detail: `removed the ${ctx.id} entry from ${path}` };
  }, opts);
  if (!locked) throw new StepError(LOCKED);
  return value;
}

// Replays harness `id`'s manifest entry in reverse (spec F.4), each item its own step, a failed item never stopping
// the others: links, agent files, the rules (Codex managed section / Grok rules file), config.toml changes, the Grok
// plugin reinstall (confirmed per plugin on a TTY), the Codex bridge and marketplace, the Grok hooks file, then the
// manifest entry. No entry gives one `<id>: already` step. Every CLI call goes through `run`; `log` carries the
// reinstall commands before the questions.
export async function removeHarness({
  home, id, run, now = new Date(), restoreAgentsMd = false, yes = false, isTTY = false, confirm, log = () => {},
  lockWaitMs, lockRetryWaitMs = RECORD_RETRY_WAIT_MS,
}) {
  if (!HARNESS_IDS.includes(id)) throw new Error(`unknown harness: ${id}`);
  let manifest;
  try {
    manifest = readManifest(home);
  } catch (err) {
    return { steps: [{ id, status: 'failed', detail: err.message }] };
  }
  if (!Object.hasOwn(manifest.harnesses, id)) {
    const detail = `nothing recorded in ${manifestPath(home)}: nothing to remove`;
    return { steps: [{ id, status: 'already', detail }] };
  }
  const ctx = {
    home, id, run, restoreAgentsMd, yes, isTTY, confirm, log, lockWaitMs, lockRetryWaitMs,
    paths: harnessPaths(home, id),
    backupDir: join(backupDirFor(home, now), id),
  };
  const steps = [];
  if (id === 'codex') {
    steps.push(await step('codex-skills', () => removeLinksStep(ctx)));
    steps.push(await step('codex-agents', () => removeAgentsStep(ctx)));
    steps.push(await step('codex-rules', () => removeCodexRulesStep(ctx)));
    steps.push(await step('codex-config', () => removeConfigStep(ctx)));
    steps.push(await step('codex-plugin', () => removeCodexPluginStep(ctx)));
  } else {
    const { rules, legacyRules, hooksFile, legacyHooksFile } = ctx.paths;
    steps.push(await step('grok-rules', () => removeOwnFileStep(ctx, [rules, legacyRules], 'rules file')));
    steps.push(await step('grok-plugins', () => removeGrokPluginsStep(ctx)));
    steps.push(await step('grok-hooks', () => removeOwnFileStep(ctx, [hooksFile, legacyHooksFile], 'hooks file')));
  }
  steps.push(await step(`${id}-manifest`, () => removeManifestStep(ctx)));
  return { steps };
}

// The harness session refresh (F.3), from hook.mjs's detached background run: the Codex skill links and role agents
// only (a no-op for Grok), no CLI call, no TTY, one manifest lock. { changed: false } when the lock is not taken, and
// when config.json records the harness as removed (`harnesses.<id>.enabled === false`): nothing is re-created.
export async function refreshHarness({ home, id }) {
  if (id !== 'codex') return { changed: false };
  const config = readMethodologyConfig(home);
  if (config.harnesses[id]?.enabled === false) return { changed: false };
  const installs = userInstalls(home);
  const paths = harnessPaths(home, id);
  const ctx = {
    home, installs, config, paths,
    supersedes: readSupersedes(installs.methodology?.installPath),
    backupDir: join(backupDirFor(home, new Date()), id),
  };
  const { locked, value } = await withManifest(home, id, (entry) => {
    const links = applyLinks(linkCtx(ctx), entry);
    const agents = applyAgents(agentCtx(ctx), entry);
    return links.status === 'done' || agents.status === 'done';
  });
  return { changed: locked && value === true };
}
