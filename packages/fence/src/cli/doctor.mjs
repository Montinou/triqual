// `fence doctor [--json]` (spec, "CLI" and "Grok"): a read-only report on whether fence is installed,
// healthy and actually in the way of the hosts.
//
//   doctor({home, env?, cwd?, probes?, sudoers?, now?, json?, io?, fs?, adminDir?, uid?})
//     -> Promise<{ok, exitCode, report: {ok, checks: [{id, status, message}]}, text}>
//
// Nothing is written and nothing is spawned: everything outside the fence files derived from `home`
// comes in through a seam.
//   probes   host facts only the host CLIs know; each is a function returning its answer (sync or
//            async). A probe that is missing, throws, or answers null/undefined makes its check
//            "could not verify" (status unknown), never a failure:
//              claudeVersion()           -> string, e.g. "2.1.300 (Claude Code)"
//              claudePluginEnabled()     -> boolean
//              claudeMarketplaceSource() -> {kind: "github" | "git" | "directory" | ...} (the source the
//                                           fence plugin is served from)
//              codexBridgeInstalled()    -> boolean
//              codexHooksFeature()       -> boolean (the `hooks` feature is enabled)
//              codexHooksTrusted()       -> boolean (the fence hooks are trusted)
//   sudoers  {read(file), list(dir)}: the sudoers reader (the CLI wiring passes the real one; the
//            unprivileged reader can not read /etc/sudoers, which is "could not verify", not a finding)
//   fs, now (ms or a function), adminDir (default: the platform's), uid (the user's, for the owner
//   check), cwd (default process.cwd()), env (default process.env).
//
// Statuses: ok, info (nothing to act on), warn (worth a look, not a failure), unknown (could not
// verify), fail. The exit code is 1 when any check fails.
//
// What is read, each bounded: the fence files under `home`, the admin directory's hatch.json and
// integrity.json, the state directory's smoke.json, health.json, needs-repair and the decision log
// of the last UNKNOWN_TOOLS_DAYS days (at most LOG_MAX_FILES files, LOG_MAX_FILE_BYTES each), and the
// `.claude/settings*.json` of the repository `cwd` is in.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { lookupCodexTool, lookupTool } from '../hosts/tools.mjs';
import { parseLines } from '../log/log.mjs';
import { isUnknown } from '../norm/unknown.mjs';
import { loadPolicy } from '../policy/load.mjs';
import { readGitPin } from '../resolve/gitpin.mjs';
import { repoOf } from '../resolve/repo.mjs';
import { CODE_LOADING_VARS } from '../tables/envvars.mjs';
import { MIN_GIT } from './install.mjs';
import { fencePaths } from './paths.mjs';
import { SEMVER, isExactVersion } from './provenance.mjs';
import { realSudoersReader, sudoConfigWarnings } from './sudo.mjs';
import { compareVersions } from './upgrade.mjs';

export const MIN_CLAUDE = Object.freeze([2, 1, 295]);
export const UNKNOWN_TOOLS_DAYS = 7;
export const LOG_MAX_FILES = 8;
export const LOG_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SMALL_FILE = 1024 * 1024;
const MAX_LISTED = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const SETTINGS_FILE = /^settings.*\.json$/;
const LOCAL_MARKETPLACE_KINDS = new Set(['directory', 'file', 'local']);
const TRAMPOLINE = /^#!\/bin\/sh\nexec '([^']+)' '([^']+)' "\$@"\n$/;

// Host-configuration variables of the T17 list (envvars.mjs CODE_LOADING_VARS): a value moves the
// configuration a host or fence reads. The first group fails; the second only warns (an XDG_*
// variable is common on Linux, and FENCE_PROFILE is a legitimate profile selector).
const FAILING_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME'].filter((n) => CODE_LOADING_VARS.names.includes(n));
const WARNING_VARS = ['FENCE_PROFILE'].filter((n) => CODE_LOADING_VARS.names.includes(n));
// Only the three XDG directories that decide where a host or fence looks for configuration, data and
// state (XDG_RUNTIME_DIR, XDG_SESSION_TYPE and the like are everywhere and mean nothing here).
const XDG_NAMES = CODE_LOADING_VARS.prefixes.includes('XDG_') ? ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] : [];
// Variables that change how node (and so fence's watchdog, when it runs from this environment) loads code.
const NODE_VARS = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].filter((n) => CODE_LOADING_VARS.names.includes(n));
const NODE_PREFIXES = CODE_LOADING_VARS.prefixes.filter((p) => p === 'DYLD_');
const HOME_IN_LIST = CODE_LOADING_VARS.names.includes('HOME');

const c = (id, status, message) => ({ id, status, message });
const errCode = (err) => (err && typeof err === 'object' ? err.code : undefined);
const isMissing = (err) => errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR';
const errText = (err) => (err instanceof Error ? err.message : String(err));
// The first exact semver version in a probe's answer ("2.1.300 (Claude Code)", "2.39.5 (Apple Git-154)"),
// prerelease included, or null.
const VERSION_TOKEN = new RegExp(`(?<![\\d.])${SEMVER.source.replace(/^\^/, '').replace(/\$$/, '')}`);
const versionOf = (s) => {
  const m = VERSION_TOKEN.exec(String(s));
  return m && isExactVersion(m[0]) ? m[0] : null;
};
const olderThan = (version, floor) => compareVersions(version, floor.join('.')) < 0;
const parseIso = (s) => (typeof s === 'string' ? Date.parse(s) : Number.NaN);

// Reads a small JSON object: {value} | {missing: true} | {error}.
function readJson(file, fs) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SMALL_FILE) return { error: `${file} is not a regular file of a sane size` };
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: `${file} is not a JSON object` };
    return { value: v };
  } catch (err) {
    if (isMissing(err)) return { missing: true };
    return { error: errText(err) };
  }
}

async function probe(probes, name) {
  try {
    const fn = probes?.[name];
    if (typeof fn !== 'function') return null;
    const v = await fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

// ---- launcher ----

// -> a problem text, or null, for one sh trampoline and the module it execs.
function trampolineProblem(file, expectedModule, fs) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return isMissing(err) ? `${file} is missing` : `${file} can not be read (${errText(err)})`;
  }
  const m = TRAMPOLINE.exec(text);
  if (!m) return `${file} is not a fence trampoline`;
  const [, node, mod] = m;
  if (mod !== expectedModule) return `${file} runs ${mod}, not ${expectedModule}`;
  // A missing node is whatever the shell makes of it (127 or 126): look, do not guess an exit code.
  let nodeOk = false;
  try {
    const st = fs.statSync(node);
    nodeOk = st.isFile() && (st.mode & 0o111) !== 0; // the mode bits, so an fs without accessSync does not pass
  } catch {
    nodeOk = false;
  }
  if (!nodeOk) return `${file} execs the node binary ${node}, which does not exist or is not executable`;
  return null;
}

function fileProblem(file, fs) {
  try {
    return fs.statSync(file).isFile() ? null : `${file} is not a regular file`;
  } catch (err) {
    return isMissing(err) ? `${file} is missing` : `${file} can not be read (${errText(err)})`;
  }
}

function launcherProblems(paths, fs) {
  const watchdog = [fileProblem(paths.watchdogBundle, fs), trampolineProblem(paths.watchdog, paths.watchdogBundle, fs)].filter(Boolean);
  const cli = [fileProblem(paths.shimModule, fs), trampolineProblem(paths.shim, paths.shimModule, fs)].filter(Boolean);
  return { watchdog, cli };
}

// ---- individual checks ----

function checkLauncher(problems) {
  const all = [...problems.watchdog, ...problems.cli];
  if (all.length === 0) return c('launcher', 'ok', 'the watchdog bundle, the fence-hook and fence launchers and their node binary are in place');
  return c('launcher', 'fail', `${all.join('; ')}; run fence repair in your own terminal`);
}

async function claudeChecks(probes, problems) {
  const out = [];
  const version = await probe(probes, 'claudeVersion');
  const floor = MIN_CLAUDE.join('.');
  const parsed = version === null ? null : versionOf(version);
  if (parsed === null) out.push(c('claude-version', 'unknown', `could not verify the Claude Code version (needs ${floor} or newer)`));
  else if (olderThan(parsed, MIN_CLAUDE)) out.push(c('claude-version', 'warn', `Claude Code ${parsed} is older than ${floor}; fence's hooks need ${floor} or newer`));
  else out.push(c('claude-version', 'ok', `Claude Code ${parsed} (needs ${floor} or newer)`));

  const enabled = await probe(probes, 'claudePluginEnabled');
  if (enabled === null) out.push(c('claude-plugin', 'unknown', 'could not verify that the fence plugin is enabled in Claude Code'));
  else if (enabled !== true) out.push(c('claude-plugin', 'fail', 'the fence plugin is not enabled in Claude Code: its calls are not checked (claude plugin install fence@triqual, then restart)'));
  else if (problems.watchdog.length > 0) out.push(c('claude-plugin', 'fail', 'the fence plugin is enabled but has no working launcher, so every call is denied'));
  else out.push(c('claude-plugin', 'ok', 'the fence plugin is enabled: Claude Code is enforced'));

  const source = await probe(probes, 'claudeMarketplaceSource');
  if (source === null || typeof source !== 'object') {
    out.push(c('claude-marketplace', 'unknown', 'could not verify where the fence plugin is served from'));
  } else if (LOCAL_MARKETPLACE_KINDS.has(String(source.kind))) {
    out.push(c('claude-marketplace', 'fail', `the fence plugin is served from a local-folder marketplace${typeof source.path === 'string' ? ` (${source.path})` : ''}: its hooks.json sits outside the protected paths and can be edited`));
  } else {
    out.push(c('claude-marketplace', 'ok', `the fence plugin is served from a ${String(source.kind)} marketplace`));
  }
  return out;
}

async function codexChecks(probes, problems) {
  const installed = await probe(probes, 'codexBridgeInstalled');
  if (installed === null) return [c('codex-bridge', 'unknown', 'could not verify that the fence-codex bridge is installed')];
  if (installed !== true) return [c('codex-bridge', 'info', 'the fence-codex bridge is not installed: Codex is not covered')];
  const out = [c('codex-bridge', 'ok', 'the fence-codex bridge is installed')];
  if (problems.watchdog.length > 0) {
    out.push(c('codex-launcher', 'fail', `the fence-codex bridge is installed but has no launcher (${problems.watchdog.join('; ')}): every Codex call is denied`));
  } else {
    out.push(c('codex-launcher', 'ok', 'the bridge launcher is in place'));
  }
  const feature = await probe(probes, 'codexHooksFeature');
  if (feature === null) out.push(c('codex-hooks-feature', 'unknown', 'could not verify that the Codex hooks feature is enabled'));
  else if (feature !== true) out.push(c('codex-hooks-feature', 'fail', 'the Codex hooks feature is disabled: Codex does not run the fence hooks (enable it in ~/.codex/config.toml)'));
  else out.push(c('codex-hooks-feature', 'ok', 'the Codex hooks feature is enabled'));
  const trusted = await probe(probes, 'codexHooksTrusted');
  if (trusted === null) out.push(c('codex-hooks-trusted', 'unknown', 'could not verify that Codex trusts the fence hooks'));
  else if (trusted !== true) out.push(c('codex-hooks-trusted', 'fail', 'Codex does not trust the fence hooks yet: it will not run them until you trust them'));
  else out.push(c('codex-hooks-trusted', 'ok', 'Codex trusts the fence hooks'));
  return out;
}

const grokCheck = () => c('grok', 'info', 'Grok is not enforced: fence has no Grok adapter');

function policyCheck(paths, { fs, home, uid }) {
  let st;
  try {
    st = fs.statSync(paths.policy);
  } catch (err) {
    return c('policy', 'fail', isMissing(err) ? `no policy at ${paths.policy}` : `the policy ${paths.policy} can not be read (${errText(err)})`);
  }
  let loaded;
  try {
    loaded = loadPolicy(paths.policy, { fs, home });
  } catch (err) {
    return c('policy', 'fail', `the policy ${paths.policy} is invalid: ${errText(err)}`);
  }
  const problems = [];
  if (typeof uid === 'number' && st.uid !== uid && st.uid !== 0) problems.push(`it is owned by uid ${st.uid}, neither you (${uid}) nor root`);
  if ((st.mode & 0o022) !== 0) problems.push('it is group- or world-writable');
  const base = `owner uid ${st.uid}, sha256 ${loaded.sha}`;
  if (problems.length > 0) return c('policy', 'fail', `the policy is valid (${base}) but ${problems.join(' and ')}`);
  return c('policy', 'ok', `the policy is valid (${base})`);
}

function currentChecks(paths, fs) {
  let version;
  try {
    version = fs.readFileSync(paths.current, 'utf8').trim();
  } catch (err) {
    return { current: c('current', 'fail', isMissing(err) ? `${paths.current} is missing: no version is installed` : `${paths.current} can not be read (${errText(err)})`), version: null };
  }
  if (!isExactVersion(version)) {
    return { current: c('current', 'fail', `${paths.current} does not name an exact semver version (the watchdog refuses it)`), version: null };
  }
  const engine = nodePath.join(paths.versionsDir, version, 'src', 'engine.mjs');
  const problem = fileProblem(engine, fs);
  if (problem) return { current: c('current', 'fail', `current is ${version} but ${problem}`), version };
  return { current: c('current', 'ok', `current is ${version}`), version };
}

function smokeCheck(paths, fs, version) {
  const r = readJson(paths.smokeResult, fs);
  if (r.missing) return c('smoke', 'fail', `no smoke result at ${paths.smokeResult}: no install or upgrade has recorded one`);
  if (r.error) return c('smoke', 'fail', `the smoke result can not be read (${r.error})`);
  const s = r.value;
  if (s.ok !== true) return c('smoke', 'fail', `the last smoke test (version ${String(s.version)}) did not pass`);
  if (version !== null && s.version !== version) return c('smoke', 'fail', `the last smoke test passed for ${String(s.version)}, not for current ${version}`);
  const times = Array.isArray(s.latencyMs) ? s.latencyMs.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
  const latency = times.length > 0 ? `, slowest sample ${Math.max(...times)} ms` : '';
  return c('smoke', 'ok', `the smoke test passed for ${String(s.version)}${typeof s.at === 'string' ? ` at ${s.at}` : ''}${latency}`);
}

// The time (ms) of the newest write in the decision log: the latest entry timestamp of the newest day
// file, else that file's mtime; null when there is none (or it is over the size bound).
function newestLogWrite(paths, fs) {
  try {
    const names = fs.readdirSync(paths.logDir).filter((n) => DAY_FILE.test(n)).sort();
    if (names.length === 0) return null;
    const file = nodePath.join(paths.logDir, names[names.length - 1]);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > LOG_MAX_FILE_BYTES) return null;
    let newest = Number.NaN;
    for (const e of parseLines(fs.readFileSync(file, 'utf8')).entries) {
      const ts = parseIso(e.ts);
      if (Number.isFinite(ts) && !(ts <= newest)) newest = ts;
    }
    if (Number.isFinite(newest)) return newest;
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function logHealthCheck(paths, fs) {
  const r = readJson(paths.health, fs);
  if (r.missing) return c('log-health', 'ok', 'no log failure is recorded');
  if (r.error) return c('log-health', 'warn', `health.json can not be read (${r.error})`);
  const h = r.value;
  const warns = [];
  if (h.logFailure !== undefined || h.logFailed === true) {
    const failedAt = h.logFailure && typeof h.logFailure === 'object' && typeof h.logFailure.at === 'string' ? h.logFailure.at : null;
    const failedMs = parseIso(failedAt);
    const latest = Number.isFinite(failedMs) ? newestLogWrite(paths, fs) : null;
    // health.json never clears itself: a later successful write in the log means the failure is past
    if (latest !== null && latest > failedMs) warns.push(`a log write failed on ${failedAt}; later writes succeeded`);
    else return c('log-health', 'fail', `the last log write failed${failedAt === null ? '' : ` at ${failedAt}`}; the log may be missing decisions`);
  }
  const at = (v) => (v && typeof v === 'object' && typeof v.at === 'string' ? ` (last at ${v.at})` : '');
  if (h.writtenFailure !== undefined) warns.push(`the written-files index could not be updated${at(h.writtenFailure)}`);
  if (h.writtenReadFailure !== undefined) warns.push(`the written-files index could not be read${at(h.writtenReadFailure)}`);
  if (warns.length > 0) return c('log-health', 'warn', warns.join('; '));
  return c('log-health', 'ok', 'no log failure is recorded');
}

function hatchCheck(file, fs, nowMs) {
  if (file === null) return c('hatch', 'unknown', 'could not verify the hatch: this platform has no admin directory');
  const r = readJson(file, fs);
  if (r.missing) return c('hatch', 'ok', 'no hatch is open');
  if (r.error) return c('hatch', 'unknown', `could not verify the hatch (${r.error})`);
  const expires = parseIso(r.value.expires);
  if (!Number.isFinite(expires)) return c('hatch', 'warn', 'hatch.json has no valid expiry; the watchdog ignores it');
  if (expires > nowMs) return c('hatch', 'fail', `a hatch is open until ${String(r.value.expires)}: fence is not enforcing`);
  return c('hatch', 'info', `the last hatch expired at ${String(r.value.expires)}`);
}

function integrityCheck(paths, adminFile, fs, nowMs) {
  const marker = nodePath.join(paths.stateDir, 'needs-repair');
  let marked = false;
  try {
    fs.lstatSync(marker);
    marked = true;
  } catch (err) {
    marked = !isMissing(err); // an lstat error other than "does not exist" counts, as in the watchdog
  }
  if (marked) {
    return c('integrity', 'fail', `${marker} (needs-repair) is set after an integrity mismatch or an unfinished comparison: every call is denied until you run fence repair in your own terminal`);
  }
  if (adminFile === null) return c('integrity', 'unknown', 'could not verify the integrity manifest: this platform has no admin directory');
  const r = readJson(adminFile, fs);
  if (r.missing) return c('integrity', 'ok', 'no integrity manifest is pending and needs-repair is not set');
  if (r.error) return c('integrity', 'unknown', `could not verify the integrity manifest (${r.error})`);
  const expires = parseIso(r.value.expires);
  if (!Number.isFinite(expires)) return c('integrity', 'warn', 'integrity.json has no valid expiry');
  if (expires > nowMs) return c('integrity', 'info', `the integrity comparison is due after the hatch expires at ${String(r.value.expires)}`);
  return c('integrity', 'info', `an integrity manifest from the hatch that expired at ${String(r.value.expires)} is pending; the next call compares it`);
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function unknownToolsCheck(paths, fs, nowMs) {
  const cutoff = nowMs - UNKNOWN_TOOLS_DAYS * DAY_MS;
  let names;
  try {
    names = fs.readdirSync(paths.logDir).filter((n) => DAY_FILE.test(n) && n.slice(0, 10) >= isoDay(cutoff)).sort();
  } catch (err) {
    if (isMissing(err)) return c('unknown-tools', 'ok', 'no decision log yet');
    return c('unknown-tools', 'unknown', `could not read the decision log (${errText(err)})`);
  }
  names = names.slice(-LOG_MAX_FILES);
  const seen = new Map();
  let skipped = 0;
  for (const name of names) {
    const file = nodePath.join(paths.logDir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > LOG_MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      for (const e of parseLines(fs.readFileSync(file, 'utf8')).entries) {
        if (typeof e.decision !== 'string' || typeof e.tool !== 'string' || e.tool === '') continue;
        const ts = parseIso(e.ts);
        if (Number.isFinite(ts) && ts < cutoff) continue;
        const known = e.host === 'codex' ? lookupCodexTool(e.tool) !== null : e.host === 'claude' ? lookupTool(e.tool) !== null : lookupTool(e.tool) !== null || lookupCodexTool(e.tool) !== null;
        if (known) continue;
        const key = `${typeof e.host === 'string' ? e.host : 'unknown'} ${e.tool}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    } catch {
      skipped++;
    }
  }
  const clean = (s) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');
  const extra = skipped > 0 ? `; ${skipped} log file${skipped === 1 ? '' : 's'} skipped (unreadable or over ${LOG_MAX_FILE_BYTES} bytes)` : '';
  if (seen.size === 0) return c('unknown-tools', skipped > 0 ? 'unknown' : 'ok', `no unknown tools in the last ${UNKNOWN_TOOLS_DAYS} days${extra}`);
  const rows = [...seen].sort((a, b) => b[1] - a[1]).slice(0, MAX_LISTED).map(([k, n]) => `${clean(k)} x${n}`);
  const more = seen.size > MAX_LISTED ? `, and ${seen.size - MAX_LISTED} more` : '';
  return c('unknown-tools', 'warn', `${seen.size} unknown tool${seen.size === 1 ? '' : 's'} in the last ${UNKNOWN_TOOLS_DAYS} days (no rule can name them): ${rows.join(', ')}${more}${extra}`);
}

function projectSettingsCheck(cwd, fs) {
  const repo = repoOf(cwd, { fs });
  if (repo === null) return c('project-settings', 'info', 'not inside a repository: no project settings to check');
  if (isUnknown(repo) || isUnknown(repo.root)) return c('project-settings', 'unknown', 'could not verify the project settings: the repository root could not be determined');
  const dir = nodePath.join(repo.root, '.claude');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => SETTINGS_FILE.test(n)).sort();
  } catch (err) {
    if (isMissing(err)) return c('project-settings', 'ok', 'the repository has no project settings');
    return c('project-settings', 'unknown', `could not read ${dir} (${errText(err)})`);
  }
  const hits = [];
  const unreadable = [];
  for (const name of names) {
    const r = readJson(nodePath.join(dir, name), fs);
    if (r.value && r.value.disableAllHooks === true) hits.push(name);
    else if (r.error) unreadable.push(name);
  }
  if (hits.length > 0) {
    return c('project-settings', 'fail', `disableAllHooks is true in ${hits.map((n) => nodePath.join(dir, n)).join(', ')}: Claude Code runs no hooks in this repository`);
  }
  if (unreadable.length > 0) return c('project-settings', 'unknown', `could not verify ${unreadable.join(', ')} in ${dir} (unreadable or not a JSON object)`);
  return c('project-settings', 'ok', 'no project settings disable hooks');
}

function envCheck(env, home) {
  const failing = [];
  const warning = [];
  const set = (name) => typeof env[name] === 'string' && env[name] !== '';
  if (HOME_IN_LIST && set('HOME') && nodePath.resolve(env.HOME) !== nodePath.resolve(home)) {
    failing.push(`HOME is ${env.HOME}, not ${home} (the home fence checks)`);
  }
  for (const name of FAILING_VARS) if (set(name)) failing.push(`${name} is set`);
  for (const name of WARNING_VARS) if (set(name)) warning.push(`${name} is set`);
  for (const name of XDG_NAMES) if (set(name)) warning.push(`${name} is set`);
  const nodeAffecting = [...NODE_VARS.filter(set), ...Object.keys(env).sort().filter((n) => NODE_PREFIXES.some((p) => n.startsWith(p)) && set(n))];
  for (const name of nodeAffecting) warning.push(`${name} is set (affects fence's own node)`);
  if (failing.length > 0) {
    return c('env-override', 'fail', `the environment moves the configuration the hosts or fence read: ${[...failing, ...warning].join('; ')}`);
  }
  if (warning.length > 0) return c('env-override', 'warn', `the environment may change what fence or the hosts read: ${warning.join('; ')}`);
  return c('env-override', 'ok', 'no configuration override in the environment');
}

// Problems sudoConfigWarnings reports for a file it could not read or follow all end this way.
const NOT_CHECKED = /it was not checked$/;

function sudoCheck(reader) {
  if (!reader || typeof reader.read !== 'function') return c('sudo', 'unknown', 'could not verify the sudo configuration: no sudoers reader');
  let warnings;
  try {
    warnings = sudoConfigWarnings({ read: reader.read, list: reader.list });
  } catch (err) {
    return c('sudo', 'unknown', `could not verify the sudo configuration (${errText(err)})`);
  }
  const unread = warnings.filter((w) => NOT_CHECKED.test(w));
  const real = warnings.filter((w) => !NOT_CHECKED.test(w));
  if (real.length > 0) {
    return c('sudo', 'warn', `${real.join('; ')}${unread.length > 0 ? `; also could not verify: ${unread.join('; ')}` : ''}`);
  }
  if (unread.length > 0) {
    return c('sudo', 'unknown', `could not verify the sudo configuration: ${unread.join('; ')} (an unprivileged reader can not read /etc/sudoers, so nothing is known about the sudo gate either way)`);
  }
  return c('sudo', 'ok', 'the sudo configuration asks for authentication');
}

function gitCheck(paths, fs) {
  const pin = readGitPin(paths.shareDir, fs);
  if (pin === null) return c('git', 'warn', `no pinned git (${paths.gitPin}): git tree checks in repositories that track .claude/ or .codex/ are opaque`);
  const parsed = versionOf(pin.version);
  const floor = MIN_GIT.join('.');
  if (parsed === null) return c('git', 'unknown', `could not read the pinned git version ${JSON.stringify(pin.version)}`);
  if (olderThan(parsed, MIN_GIT)) return c('git', 'fail', `the pinned git ${parsed} is older than ${floor}: git tree checks are opaque (install a newer git and run fence repair)`);
  const problem = fileProblem(pin.path, fs);
  if (problem) return c('git', 'warn', `the pinned git ${parsed} is recorded but ${problem}`);
  return c('git', 'ok', `the pinned git is ${parsed} at ${pin.path}`);
}

// ---- the report ----

// Text from a probe, a file name or an error is untrusted: control characters (C0, C1, ESC), bidi marks
// and the other format characters are dropped before anything is printed (text and JSON alike).
const clean = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

function render(report) {
  const width = Math.max(...report.checks.map((x) => x.id.length));
  const lines = ['fence doctor'];
  for (const x of report.checks) lines.push(`  ${x.status.padEnd(7)} ${x.id.padEnd(width)}  ${x.message}`);
  const fails = report.checks.filter((x) => x.status === 'fail').length;
  lines.push('', fails === 0 ? 'fence doctor: no failures' : `fence doctor: ${fails} failure${fails === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export async function doctor({
  home,
  env = process.env,
  cwd = process.cwd(),
  probes = {},
  sudoers = realSudoersReader,
  now = Date.now,
  json = false,
  io,
  fs = nodeFs,
  adminDir,
  uid = process.getuid?.(),
} = {}) {
  const paths = fencePaths(home);
  const nowMs = typeof now === 'function' ? now() : now;
  const admin = adminDir ?? paths.adminDir;
  const hatchFile = admin ? nodePath.join(admin, 'hatch.json') : null;
  const integrityFile = admin ? nodePath.join(admin, 'integrity.json') : null;
  const checks = [];
  const safe = async (id, fn) => {
    try {
      const r = await fn();
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      checks.push(c(id, 'unknown', `the check could not run (${errText(err)})`));
    }
  };

  const problems = launcherProblems(paths, fs);
  let version = null;
  await safe('claude-version', () => claudeChecks(probes, problems));
  await safe('codex-bridge', () => codexChecks(probes, problems));
  checks.push(grokCheck());
  await safe('launcher', () => checkLauncher(problems));
  await safe('policy', () => policyCheck(paths, { fs, home: paths.home, uid }));
  await safe('current', () => {
    const r = currentChecks(paths, fs);
    version = r.version;
    return r.current;
  });
  await safe('smoke', () => smokeCheck(paths, fs, version));
  await safe('log-health', () => logHealthCheck(paths, fs));
  await safe('hatch', () => hatchCheck(hatchFile, fs, nowMs));
  await safe('integrity', () => integrityCheck(paths, integrityFile, fs, nowMs));
  await safe('unknown-tools', () => unknownToolsCheck(paths, fs, nowMs));
  await safe('project-settings', () => projectSettingsCheck(cwd, fs));
  await safe('env-override', () => envCheck(env ?? {}, paths.home));
  await safe('sudo', () => sudoCheck(sudoers));
  await safe('git', () => gitCheck(paths, fs));

  const ok = !checks.some((x) => x.status === 'fail');
  const report = { ok, checks: checks.map((x) => ({ id: clean(x.id), status: x.status, message: clean(x.message) })) };
  const text = json ? JSON.stringify(report, null, 2) : render(report);
  if (io && typeof io.out === 'function') io.out(text);
  return { ok, exitCode: ok ? 0 : 1, report, text };
}
