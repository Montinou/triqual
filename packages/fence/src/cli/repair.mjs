// `fence repair` (spec, "CLI" and "Watchdog" step 3; human-only; weakening after an integrity mismatch).
//
//   repair({home, run, env?, nodePath?, smoke?, confirm?, gate?, io?, now?, deadlineMs?, adminDir?,
//           probes?, sudoers?, cwd?, fs?, isRootOwned?, uid?}) -> Promise<result>
//
// result = {ok, reason?, version?, skipped, integrity: {pending, diffs, timedOut: false, cleared,
//           declined?, stamped?, removedManifest?}, registrations, warnings, paths}
//
// In this order:
//   1. Inspect the integrity denial, read-only. It is pending when <state>/needs-repair exists (the
//      sticky marker the watchdog writes after a mismatch or an overrun), or when
//      <admin>/integrity.json exists, its hatch has expired and no valid <state>/verified/<sha256 of
//      the manifest's RAW bytes> stamp (a regular file whose ctime is after the manifest's `expires`)
//      exists, or when that manifest can not be read, is not root-owned or does not parse (the
//      watchdog denies those without a marker). The manifest is then compared with the current files
//      by compareManifest with NO deadline (the module's own default; `deadlineMs` below never
//      reaches it, and no flag or environment variable does), and every difference is shown.
//   2. Pending with something to clear (a marker, a difference or an unusable manifest): the human is
//      asked (`confirm(summary)` must answer exactly true) and only then the sudo gate runs
//      (`gate()` must answer true or {ok: true}; a missing gate refuses). A "no" or a refusal changes
//      NOTHING: no reinstall, no stamp, the marker and integrity.json stay and the denial stays. This
//      is the only sudo gate of the command; it is not asked when nothing is pending, and an unstamped
//      manifest that compares equal is simply stamped (what the watchdog does on its next call).
//   3. Re-place the watchdog and the engine from the version `current` names, KEEPING `current`: when
//      that version's directory is intact (no file in it is among the comparison's differences) and it
//      passes its smoke test and installed launcher check, repair never switches `current` (a
//      deliberate `fence rollback` stays, and a version planted under versions/ is never activated)
//      and asks nothing for this step. Only when current is missing, invalid, changed or failing does
//      repair pick a fallback: the newest other version by its semver DIRECTORY NAME alone (it has an
//      engine file and is not among the differences). None of that version's code runs (no bundler,
//      no smoke test) until the human has confirmed it by name (`confirm({..., fallback: {version,
//      from, reason}})` must answer exactly true; the prompt says the version was not covered by the
//      integrity check) and the sudo gate has passed (once per repair, shared with step 2). Only then
//      is it built and smoke-tested and activated; if that fails, repair stops with nothing activated
//      and says so (the next version is never tried silently; the human runs repair again). A refusal
//      changes nothing and runs nothing.
//      The swap is install's (activateVersion): the bundle, the fence-hook trampoline, the CLI module
//      and the fence trampoline are replaced by write-temp-then-rename, the INSTALLED trampoline is run
//      end to end, and only then is `current` written; any failure restores the old files. The smoke
//      result is recorded in <state>/smoke.json. When no version passes, nothing is changed and the
//      reason names each version and why it was skipped.
//   4. Clear the denial: the verified stamp (when the manifest's hatch has expired) and removal of
//      <state>/needs-repair; an unusable integrity.json is removed with `sudo rm -f` (an absolute path
//      from the command table, through `run`). integrity.json is otherwise left as it is.
//   5. Re-check the registrations with doctor's checks (launcher, current, the host probes) and print
//      them. They are information: a failing one is reported, not repaired (fence never edits host
//      configuration).
//
// requireHuman runs before this (the CLI wiring). Everything is injected: `home` (absolute), `run`
// (spawnSync shape: the Node probe, the installed launcher and the sudo rm), `env`, `smoke` (default
// runSmoke), `now` (clock function, default Date.now), `adminDir` (default the platform's),
// `isRootOwned(stat)` (the root-ownership test of integrity.json, default uid 0 and not group/world
// writable), the doctor seams (`probes`, `sudoers`, `cwd`, `uid`). `deadlineMs` (module API only,
// never a flag or environment variable) is install's: baked into the bundle and given to the smoke
// test, so tests on loaded machines can give the launcher check more time.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { MAX_MANIFEST_BYTES, compareManifest, parseIso, parseManifest, sha256 } from '../watchdog/integrity.mjs';
import { doctor } from './doctor.mjs';
import { COMMANDS, SUDO } from './humanonly.mjs';
import { POLICY_CHOICES, activateVersion, bundleAndSmoke, errText, nodePathProblem, nodeVersionProblem, writeSmokeResult } from './install.mjs';
import { fencePaths } from './paths.mjs';
import { isExactVersion } from './provenance.mjs';
import { runSmoke } from './smoke.mjs';
import { compareVersions } from './upgrade.mjs';

export const REGISTRATION_CHECKS = Object.freeze([
  'launcher',
  'current',
  'smoke',
  'claude-version',
  'claude-plugin',
  'claude-marketplace',
  'codex-bridge',
  'codex-launcher',
  'codex-hooks-feature',
  'codex-hooks-trusted',
]);
const MARKER = 'needs-repair';
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_SHOWN = 200;

// Text from a file name, a marker or an error is untrusted: control and format characters are dropped.
const clean = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
const describeDiff = (d) => `${d.kind} ${clean(d.path)}${d.key === undefined ? '' : ` [${clean(d.key)}]`}`;
const defaultRootOwned = (st) => st.uid === 0 && (st.mode & 0o022) === 0;

// -> {marker, manifest} describing the denial, read-only.
//   marker:   null | {lines}
//   manifest: {state: 'none'} | {state: 'unusable', why} | {state: 'ok', manifest, raw, sha, expires, expired, verified}
function inspect({ paths, admin, fs, t, isRootOwned }) {
  const markerPath = nodePath.join(paths.stateDir, MARKER);
  let marker = null;
  try {
    const st = fs.lstatSync(markerPath);
    let lines = [];
    if (st.isFile() && st.size <= MAX_MARKER_BYTES) lines = fs.readFileSync(markerPath, 'utf8').split('\n').filter((l) => l !== '');
    marker = { lines };
  } catch (err) {
    if (err?.code !== 'ENOENT') marker = { lines: [`${markerPath} could not be read (${err?.code ?? errText(err)})`] };
  }

  if (typeof admin !== 'string') return { marker, manifest: { state: 'none' } };
  const file = nodePath.join(admin, 'integrity.json');
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { marker, manifest: { state: 'none' } };
    return { marker, manifest: { state: 'unusable', why: `${file} could not be read (${err?.code ?? errText(err)})` } };
  }
  const unusable = (why) => ({ marker, manifest: { state: 'unusable', why } });
  if (!st.isFile() || !(st.size <= MAX_MANIFEST_BYTES)) return unusable(`${file} is not a regular file of a sane size`);
  let raw;
  try {
    raw = Buffer.from(fs.readFileSync(file));
  } catch (err) {
    return unusable(`${file} could not be read (${err?.code ?? errText(err)})`);
  }
  if (!isRootOwned(st)) return unusable(`${file} is not a root-owned, write-protected file`);
  const manifest = parseManifest(raw.toString('utf8'));
  if (manifest === null) return unusable(`${file} does not parse as an integrity manifest`);
  const digest = sha256(raw);
  const expires = parseIso(manifest.expires);
  let verified = false;
  try {
    const stamp = fs.lstatSync(nodePath.join(paths.verifiedDir, digest));
    verified = stamp.isFile() && stamp.ctimeMs > expires;
  } catch {
    // no stamp
  }
  return { marker, manifest: { state: 'ok', manifest, raw, sha: digest, expires, expired: !(t < expires), verified } };
}

function policyFor(fs, paths, dir) {
  if (fs.existsSync(paths.policy)) return paths.policy;
  const example = nodePath.join(dir, 'policies', `${POLICY_CHOICES[0]}.json`);
  return fs.existsSync(example) ? example : undefined;
}

const engineOf = (paths, version) => nodePath.join(paths.versionsDir, version, 'src', 'engine.mjs');

// The version `current` names when it is an installed one (an exact semver whose directory holds an
// engine), else null.
function currentOf(fs, paths) {
  try {
    const text = fs.readFileSync(paths.current, 'utf8').trim();
    return isExactVersion(text) && fs.existsSync(engineOf(paths, text)) ? text : null;
  } catch {
    return null;
  }
}

// The semver-named directories under versions/, newest first.
function versionsOf(fs, paths) {
  let names = [];
  try {
    names = fs.readdirSync(paths.versionsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => isExactVersion(n))
    .filter((n) => {
      try {
        return fs.statSync(nodePath.join(paths.versionsDir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => compareVersions(b, a));
}

// Re-places the watchdog and the CLI from the version `current` names when that version is intact (not
// in `changed`) and passes its smoke test and launcher check: `current` is never switched. Only when
// it is missing, invalid, changed or failing does it look for a fallback, the newest other version
// that passes, and `approve({version, from, reason})` must answer null (confirmed and gated) before
// that fallback is activated; a refusal changes nothing.
// -> {ok, version, fallback, skipped, warnings} | {ok: false, reason, skipped, declined?}
async function reinstall({ fs, paths, node, run, env, smoke, now, deadlineMs, changed, approve }) {
  const skipped = [];
  const nodeProblem = nodePathProblem(node) ?? nodeVersionProblem(node, run);
  if (nodeProblem) return { ok: false, reason: nodeProblem, skipped };
  const versions = versionsOf(fs, paths);
  if (versions.length === 0) return { ok: false, reason: `no installed version under ${paths.versionsDir}; run fence install --version <exact> again`, skipped };
  const cur = currentOf(fs, paths);
  const noCurrent = cur === null ? `${paths.current} is missing or does not name an installed version` : null;

  // -> null (this version is not usable; recorded in `skipped`) | the final result.
  // The current version is trusted to run (the integrity manifest covers its directory, and the
  // comparison above found it unchanged). A FALLBACK is chosen by its directory name alone: nothing
  // of it is imported or run (no bundler, no smoke test) until `approve` has answered null, i.e. the
  // human confirmed it by name and the sudo gate passed. Its build, smoke test or activation failing
  // after that stops the repair with nothing activated: the next version is never tried silently.
  const attempt = async (version, fallback) => {
    const target = nodePath.join(paths.versionsDir, version);
    const skip = (reason) => skipped.push({ version, reason });
    if (!fs.existsSync(engineOf(paths, version))) {
      skip('it has no src/engine.mjs');
      return null;
    }
    const hit = changed.find((p) => p === target || p.startsWith(target + nodePath.sep));
    if (hit !== undefined) {
      skip(`${clean(hit)} changed since the hatch baseline, so this copy is not trusted`);
      return null;
    }
    if (fallback) {
      const reason = noCurrent ?? skipped.find((s) => s.version === cur)?.reason ?? 'it is not usable';
      const refusal = await approve({ version, from: cur, reason: clean(reason) });
      if (refusal !== null) return { ok: false, reason: refusal, skipped, declined: true };
    }
    const stop = (reason) => {
      skip(reason);
      const why = [noCurrent, ...skipped.map((s) => `${s.version}: ${clean(s.reason)}`)].filter((s) => s !== null).join('; ');
      return { ok: false, reason: `${version} was confirmed, but ${clean(reason)}; nothing was activated (${why}). Run fence repair again to choose again, or install a good version with fence install --version <exact>`, skipped };
    };
    let work = null;
    try {
      work = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-repair-')));
      const policy = policyFor(fs, paths, target);
      const built = await bundleAndSmoke({ pkgDir: target, node, work, smoke, policy, deadlineMs });
      if (!built.ok) {
        if (fallback) return stop(built.reason);
        skip(built.reason);
        return null;
      }
      const act = activateVersion({ paths, version, target, watchdogText: built.watchdogText, node, work, run, env, policyFile: policy, deadlineMs });
      if (!act.ok) {
        if (fallback) return stop(`it could not be activated: ${act.reason}`);
        skip(`it could not be activated: ${act.reason}`);
        return null;
      }
      const warnings = [];
      try {
        writeSmokeResult(paths, { version, sm: built.sm, now });
      } catch (err) {
        warnings.push(`writing the smoke result ${paths.smokeResult} failed: ${errText(err)}`);
      }
      return { ok: true, version, fallback, skipped, warnings };
    } catch (err) {
      if (fallback) return stop(errText(err));
      skip(errText(err));
      return null;
    } finally {
      if (work !== null) fs.rmSync(work, { recursive: true, force: true });
    }
  };

  if (cur !== null) {
    const kept = await attempt(cur, false);
    if (kept !== null) return kept;
  }
  for (const version of versions) {
    if (version === cur) continue;
    const r = await attempt(version, true);
    if (r !== null) return r;
  }
  const why = [noCurrent, ...skipped.map((s) => `${s.version}: ${s.reason}`)].filter((s) => s !== null).join('; ');
  return { ok: false, reason: `no installed version passes its smoke test and launcher check (${why}); nothing was changed. Install a good version again with fence install --version <exact>`, skipped };
}

function writeStamp(fs, paths, digest, t) {
  fs.mkdirSync(paths.verifiedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(nodePath.join(paths.verifiedDir, digest), `${new Date(t).toISOString()}\n`, { mode: 0o600 });
}

export async function repair({
  home,
  run,
  env = process.env,
  nodePath: node = process.execPath,
  smoke = runSmoke,
  confirm,
  gate,
  io,
  now = Date.now,
  deadlineMs,
  adminDir,
  probes = {},
  sudoers,
  cwd,
  fs = nodeFs,
  isRootOwned = defaultRootOwned,
  uid,
} = {}) {
  if (typeof run !== 'function') throw new Error('repair: no process runner was given');
  const say = (s) => {
    if (typeof io?.out === 'function') io.out(s);
  };
  const clock = typeof now === 'function' ? now : () => Date.now();
  const integrity = { pending: false, diffs: [], timedOut: false, cleared: false };
  const result = (over) => ({ ok: false, skipped: [], integrity, registrations: [], warnings: [], ...over });
  const fail = (reason, over = {}) => result({ reason, ...over });

  let paths;
  try {
    paths = fencePaths(home);
  } catch (err) {
    return fail(errText(err));
  }
  const admin = adminDir ?? paths.adminDir;

  // 1. inspect and compare (no deadline)
  const seen = inspect({ paths, admin, fs, t: clock(), isRootOwned });
  const m = seen.manifest;
  const manifestPending = m.state === 'ok' && m.expired && !m.verified;
  const compare = m.state === 'ok' && (seen.marker !== null || manifestPending);
  let changed = [];
  if (compare) {
    const cmp = compareManifest(m.manifest, { now: clock, fs, logDir: paths.logDir });
    integrity.diffs = cmp.diffs;
    integrity.timedOut = cmp.timedOut === true;
    changed = cmp.diffs.map((d) => d.path);
  }
  const unusable = m.state === 'unusable';
  const toClear = seen.marker !== null || unusable || integrity.diffs.length > 0 || integrity.timedOut;
  integrity.pending = toClear;

  if (seen.marker !== null) {
    say(`fence repair: ${nodePath.join(paths.stateDir, MARKER)} is set; every call is denied until it is cleared.`);
    for (const line of seen.marker.lines.slice(0, 10)) say(`  marker: ${clean(line)}`);
  }
  if (unusable) say(`fence repair: ${clean(m.why)}; the watchdog denies every call while it is in place.`);
  if (compare) {
    if (integrity.diffs.length === 0) {
      say('fence repair: the full integrity comparison found no difference with the manifest.');
    } else {
      say(`fence repair: the full integrity comparison (no deadline) found ${integrity.diffs.length} difference${integrity.diffs.length === 1 ? '' : 's'} since the hatch:`);
      for (const d of integrity.diffs.slice(0, MAX_SHOWN)) say(`  ${describeDiff(d)}`);
      if (integrity.diffs.length > MAX_SHOWN) say(`  ... and ${integrity.diffs.length - MAX_SHOWN} more`);
    }
  }

  // 2. confirmation, then the sudo gate: before anything is changed. The gate runs at most once per
  // repair: the integrity step and a fallback switch (step 3) share it.
  const base = { currentUsable: currentOf(fs, paths) !== null, diffs: [...integrity.diffs], marker: seen.marker?.lines ?? null, unusable: unusable ? m.why : null, expired: m.state === 'ok' ? m.expired : null };
  let gated = false;
  const gateOnce = async (what) => {
    if (gated) return null;
    if (typeof gate !== 'function') return `${what} needs fresh sudo authentication, but no gate was given; nothing was changed`;
    let g;
    try {
      g = await gate();
    } catch (err) {
      g = { ok: false, reason: errText(err) };
    }
    if (!(g === true || g?.ok === true)) return `${what} needs fresh sudo authentication: ${g?.reason ?? 'the sudo gate refused'}; nothing was changed`;
    gated = true;
    return null;
  };
  if (toClear) {
    let yes = false;
    if (typeof confirm === 'function') {
      try {
        yes = (await confirm({ ...base, fallback: null })) === true;
      } catch (err) {
        return fail(`the confirmation failed: ${errText(err)}; nothing was changed`);
      }
    }
    if (!yes) {
      integrity.declined = true;
      return fail(
        typeof confirm === 'function'
          ? 'the repair was not confirmed; nothing was changed and the integrity denial stays in place'
          : 'repair needs a confirmation step; nothing was changed and the integrity denial stays in place',
      );
    }
    const refusal = await gateOnce('clearing the integrity denial');
    if (refusal !== null) return fail(`${refusal} and the denial stays in place`);
  }

  // 3. re-place the watchdog and the CLI from `current` when it is intact; only a missing, invalid,
  // changed or failing current is replaced, by a fallback the human confirms by name and the gate allows
  const approve = async ({ version, from, reason }) => {
    const what = `switching to ${version}`;
    if (typeof confirm !== 'function') return `${what} needs a confirmation step; nothing was changed`;
    let yes = false;
    try {
      yes = (await confirm({ ...base, fallback: { version, from, reason } })) === true;
    } catch (err) {
      return `the confirmation failed: ${errText(err)}; nothing was changed`;
    }
    if (!yes) return `${what} was not confirmed; nothing was changed${toClear ? ' and the integrity denial stays in place' : ''}`;
    return gateOnce(what);
  };
  const re = await reinstall({ fs, paths, node, run, env, smoke, now: clock, deadlineMs, changed, approve });
  if (!re.ok) return fail(re.reason, { skipped: re.skipped, ...(re.declined ? { declined: true } : {}) });
  const warnings = [...(re.warnings ?? [])];
  const skippedText = re.skipped.length ? ` (skipped ${re.skipped.map((s) => `${s.version}: ${clean(s.reason)}`).join('; ')})` : '';
  say(
    re.fallback
      ? `fence repair: current was not usable; switched to ${re.version} and reinstalled the watchdog and the engine from it${skippedText}.`
      : `fence repair: reinstalled the watchdog and the engine from the current version ${re.version}${skippedText}.`,
  );

  // 4. clear
  const done = () => result({ ok: true, version: re.version, skipped: re.skipped, warnings });
  const failClear = (reason) => fail(reason, { version: re.version, skipped: re.skipped, warnings });
  if (m.state === 'ok' && (toClear || manifestPending)) {
    if (m.expired) {
      try {
        writeStamp(fs, paths, m.sha, clock());
        integrity.stamped = true;
      } catch (err) {
        return failClear(`reinstalled from ${re.version}, but writing the verified stamp failed: ${errText(err)}; the integrity denial stays in place`);
      }
    } else {
      warnings.push(`the manifest's hatch has not expired yet (${m.manifest.expires}); the comparison runs again after it`);
    }
  }
  if (unusable) {
    const file = nodePath.join(admin, 'integrity.json');
    let r;
    try {
      r = run(SUDO, [COMMANDS.rm, '-f', file]);
    } catch (err) {
      r = { error: err instanceof Error ? err : new Error(String(err)) };
    }
    if (!r || r.error || r.status !== 0) {
      return failClear(`reinstalled from ${re.version}, but removing ${file} failed (${r?.error ? r.error.message : `exit ${r?.status}`}); the integrity denial stays in place`);
    }
    integrity.removedManifest = true;
  }
  if (seen.marker !== null) {
    try {
      fs.rmSync(nodePath.join(paths.stateDir, MARKER), { recursive: true, force: true });
    } catch (err) {
      return failClear(`reinstalled from ${re.version}, but removing ${nodePath.join(paths.stateDir, MARKER)} failed: ${errText(err)}; the integrity denial stays in place`);
    }
  }
  integrity.cleared = toClear;
  if (toClear) say('fence repair: the integrity denial is cleared.');

  // 5. the registrations, with doctor's checks
  let registrations = [];
  try {
    const d = await doctor({ home, env, cwd, probes, sudoers, now: clock, fs, adminDir: admin, uid });
    registrations = d.report.checks.filter((c) => REGISTRATION_CHECKS.includes(c.id));
  } catch (err) {
    warnings.push(`re-checking the registrations failed: ${errText(err)}`);
  }
  if (registrations.length > 0) {
    say('Registrations:');
    for (const c of registrations) say(`  ${c.status.padEnd(7)} ${c.id}  ${c.message}`);
  }
  for (const w of warnings) say(`warning: ${w}`);
  return { ...done(), registrations };
}
