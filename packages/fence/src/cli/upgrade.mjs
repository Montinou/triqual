// `fence upgrade --version <exact>` and `fence rollback` (spec, "CLI").
//
//   upgrade({version, home, run, env?, nodePath?, npmPath?, smoke?, io?, now?, deadlineMs?}) -> Promise<result>
//   rollback({home, run, env?, nodePath?, smoke?, io?, now?, deadlineMs?})                    -> Promise<result>
//   deadlineMs: as for install (module API only; omitted in production, the watchdog keeps 3000 ms).
//
// Both reuse install's staged swap (activateVersion in install.mjs): the new files replace the old
// ones by write-temp-then-rename, the INSTALLED launcher is run end to end against the target
// version, and only then is `current` switched by rename. Any failure before that restores the old
// files and leaves `current` and the recorded smoke result alone. Both record the smoke result in
// <state>/smoke.json for doctor.
//
// upgrade: the same verification as install (exact version, npm install into a temp prefix and
// `npm audit signatures`: registry signature and provenance attestation), a copy staged beside
// versions/, the smoke test on the new bundle and copy. A failed smoke test says so and names the
// version that stays current. After the switch exactly one previous version is kept (the one that
// was current); every other version directory is pruned (pruneVersions, shared with install).
// Directories that are not semver names are never touched. Upgrade only moves forward by semver
// precedence: the same version is "nothing to upgrade to", an older one is refused and points to
// the gated `fence rollback`.
//
// rollback: repoints `current` to the previous version, which is the one other version directory
// there is (none, or more than one, is refused: nothing is guessed). The target version's own
// package copy supplies the bundle and the trampolines (they are rebuilt from versions/<prev> and
// swapped in like an install), after a smoke test of that version. Rollback is a weakening
// command: the command table (humanonly.mjs) runs requireHuman and the sudo gate before this
// implementation, so it does not repeat them. The same holds for upgrade's requireHuman.
//
// Everything is injected: `home`, `run` (spawnSync shape; npm, git, the Node probe and the installed
// launcher), `env` (PATH and the base of npm's cleaned environment), `smoke` (default runSmoke),
// `now`. The work directory lives under os.tmpdir() and is removed.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import {
  POLICY_CHOICES,
  activateVersion,
  bundleAndSmoke,
  errText,
  installedVersions,
  nodePathProblem,
  pruneVersions,
  nodeVersionProblem,
  writeSmokeResult,
} from './install.mjs';
import { fencePaths } from './paths.mjs';
import { PACKAGE_NAME, defaultNpmPath, isExactVersion, verifyPackage } from './provenance.mjs';
import { runSmoke } from './smoke.mjs';

export { installedVersions };

// semver 2.0.0 precedence of two exact versions: negative, 0 or positive. Build metadata is
// ignored; a prerelease is lower than its release; prerelease identifiers compare numerically when
// both are numbers, numbers are lower than words, words compare in ASCII order.
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...rest] = v.split('+')[0].split('-');
    return { nums: core.split('.').map(Number), pre: rest.length ? rest.join('-').split('.') : null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

// -> {version} | {reason}: the version `current` names, which must be installed.
function currentVersion(paths) {
  let text;
  try {
    text = nodeFs.readFileSync(paths.current, 'utf8').trim();
  } catch {
    return { reason: `fence is not installed (${paths.current} was not found); run fence install first` };
  }
  if (!isExactVersion(text)) return { reason: `${paths.current} does not name a version; run fence repair in your own terminal` };
  if (!nodeFs.existsSync(nodePath.join(paths.versionsDir, text, 'src', 'engine.mjs'))) {
    return { reason: `the current version ${text} is not installed under ${paths.versionsDir}; run fence repair in your own terminal` };
  }
  return { version: text };
}

// The policy the smoke test and the launcher check run with: the installed one, else a shipped
// example of the package copy at `dir` (named under `finalDir` when the copy is about to move).
function policyFor(paths, dir, finalDir = dir) {
  if (nodeFs.existsSync(paths.policy)) return paths.policy;
  const name = nodePath.join('policies', `${POLICY_CHOICES[0]}.json`);
  return nodeFs.existsSync(nodePath.join(dir, name)) ? nodePath.join(finalDir, name) : undefined;
}

function checkInputs({ home, run, node }) {
  if (typeof run !== 'function') throw new Error('no process runner was given');
  const paths = fencePaths(home);
  const problem = nodePathProblem(node);
  if (problem) return { reason: problem };
  if (/'/.test(paths.shareDir)) return { reason: `the home directory ${JSON.stringify(paths.home)} contains a single quote; the launcher can not name it` };
  return { paths };
}

function say(io, line) {
  if (typeof io?.out === 'function') io.out(line);
}

export async function upgrade({
  version,
  home,
  run,
  env = process.env,
  nodePath: node = process.execPath,
  npmPath,
  smoke = runSmoke,
  io,
  now = Date.now,
  deadlineMs,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let work = null;
  let staging = null;
  try {
    const inputs = checkInputs({ home, run, node });
    if (inputs.reason) return fail(inputs.reason);
    const { paths } = inputs;
    if (!isExactVersion(version)) return fail(`upgrade needs an exact version such as 0.2.0 (no range or tag), got ${JSON.stringify(version)}`);
    const cur = currentVersion(paths);
    if (cur.reason) return fail(cur.reason);
    const order = compareVersions(version, cur.version);
    if (order === 0) return fail(`fence ${cur.version} is already current; there is nothing to upgrade to`);
    if (order < 0) {
      return fail(`${version} is older than the current ${cur.version}; upgrade only moves forward. To go back to the previous version use fence rollback (it needs sudo authentication)`);
    }
    const nodeProblem = nodeVersionProblem(node, run);
    if (nodeProblem) return fail(nodeProblem);

    work = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-upgrade-')));
    const prefix = nodePath.join(work, 'prefix');
    nodeFs.mkdirSync(prefix);
    const v = verifyPackage(`${PACKAGE_NAME}@${version}`, { run, npmPath: npmPath ?? defaultNpmPath(node), prefix, env });
    if (!v.ok) return fail(`provenance check failed: ${v.reason}`);

    nodeFs.mkdirSync(paths.versionsDir, { recursive: true });
    staging = nodeFs.mkdtempSync(nodePath.join(paths.versionsDir, `.staging-${version}-`));
    nodeFs.cpSync(v.packageDir, staging, { recursive: true, verbatimSymlinks: true });
    if (!nodeFs.existsSync(nodePath.join(staging, 'src', 'engine.mjs'))) return fail('the package has no src/engine.mjs');

    const target = nodePath.join(paths.versionsDir, version);
    const built = await bundleAndSmoke({ pkgDir: staging, node, work, smoke, policy: policyFor(paths, staging), deadlineMs });
    if (!built.ok) return fail(`fence ${cur.version} stays current; ${version} was not installed: ${built.reason}`);
    // the installed launcher check names the policy by its final location
    const policyFile = policyFor(paths, staging, target);
    const act = activateVersion({
      paths,
      version,
      target,
      staging,
      watchdogText: built.watchdogText,
      node,
      work,
      run,
      env,
      policyFile,
      deadlineMs,
    });
    if (!act.ok) return fail(`fence ${cur.version} stays current; ${version} was not installed: ${act.reason}`);

    // after the switch, failures are warnings
    const warnings = [];
    try {
      writeSmokeResult(paths, { version, sm: built.sm, now });
    } catch (err) {
      warnings.push(`writing the smoke result ${paths.smokeResult} failed: ${errText(err)}`);
    }
    const { pruned, warnings: pruneWarnings } = pruneVersions(paths, { version, previous: cur.version });
    warnings.push(...pruneWarnings);
    say(io, `fence ${version} is current; ${cur.version} is kept for fence rollback${pruned.length ? `; pruned ${pruned.join(', ')}` : ''}.`);
    for (const w of warnings) say(io, `warning: ${w}`);
    const result = { ok: true, version, previous: cur.version, pruned, warnings, paths, smoke: { latencyMs: built.sm.latencyMs ?? [] } };
    if (warnings.some((w) => / failed: /.test(w))) {
      result.repairNeeded = `fence ${version} is installed and active, but a later step failed; run fence repair (or fence doctor) in your own terminal`;
    }
    return result;
  } catch (err) {
    return fail(`upgrade failed: ${errText(err)}`);
  } finally {
    // renamed away (or rolled back) by activateVersion once placed: removing the name is then a no-op
    if (staging !== null) nodeFs.rmSync(staging, { recursive: true, force: true });
    if (work !== null) nodeFs.rmSync(work, { recursive: true, force: true });
  }
}

export async function rollback({
  home,
  run,
  env = process.env,
  nodePath: node = process.execPath,
  smoke = runSmoke,
  io,
  now = Date.now,
  deadlineMs,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let work = null;
  try {
    const inputs = checkInputs({ home, run, node });
    if (inputs.reason) return fail(inputs.reason);
    const { paths } = inputs;
    const cur = currentVersion(paths);
    if (cur.reason) return fail(cur.reason);
    const others = installedVersions(paths).filter((n) => n !== cur.version);
    if (others.length === 0) return fail(`there is no previous version to roll back to (only ${cur.version} is installed)`);
    if (others.length > 1) {
      return fail(`there is more than one other version installed (${others.join(', ')}); fence upgrade prunes to one previous version, remove the extra ones by hand to choose`);
    }
    const to = others[0];
    const target = nodePath.join(paths.versionsDir, to);
    if (!nodeFs.existsSync(nodePath.join(target, 'src', 'engine.mjs'))) return fail(`the previous version ${to} has no src/engine.mjs; it can not be rolled back to`);
    const nodeProblem = nodeVersionProblem(node, run);
    if (nodeProblem) return fail(nodeProblem);

    work = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-rollback-')));
    const policy = policyFor(paths, target);
    // the bundle and the trampolines belong to the target version: built from its own package copy
    const built = await bundleAndSmoke({ pkgDir: target, node, work, smoke, policy, deadlineMs });
    if (!built.ok) return fail(`fence ${cur.version} stays current; ${to} was not rolled back to: ${built.reason}`);
    const act = activateVersion({ paths, version: to, target, watchdogText: built.watchdogText, node, work, run, env, policyFile: policy, deadlineMs });
    if (!act.ok) return fail(`fence ${cur.version} stays current; ${to} was not rolled back to: ${act.reason}`);

    const warnings = [];
    try {
      writeSmokeResult(paths, { version: to, sm: built.sm, now });
    } catch (err) {
      warnings.push(`writing the smoke result ${paths.smokeResult} failed: ${errText(err)}`);
    }
    say(io, `fence ${to} is current again; ${cur.version} is kept, so fence rollback goes forward again.`);
    for (const w of warnings) say(io, `warning: ${w}`);
    const result = { ok: true, from: cur.version, to, warnings, paths, smoke: { latencyMs: built.sm.latencyMs ?? [] } };
    if (warnings.length > 0) result.repairNeeded = `fence ${to} is active, but a later step failed; run fence repair (or fence doctor) in your own terminal`;
    return result;
  } catch (err) {
    return fail(`rollback failed: ${errText(err)}`);
  } finally {
    if (work !== null) nodeFs.rmSync(work, { recursive: true, force: true });
  }
}
