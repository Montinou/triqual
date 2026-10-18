// `fence install --version <exact> [--from-tarball <file>]` (spec, "CLI" and "Layout / Installed state").
//
//   install({version, fromTarball?, home, run, env?, stdin?, nodePath?, npmPath?, gitPath?,
//            smoke?, policyChoice?, io?, now?}) -> Promise<{ok, reason?, ...}>
//
// The order is binding. A failure up to and including step 7 returns {ok: false, reason} and leaves
// the installed state as it was: nothing is written before the smoke test passes, and the files
// step 7 replaces are restored if the launcher check or the `current` switch fails. After `current`
// is switched (steps 8-10) a failure is a warning: the result stays ok:true with `repairNeeded`.
//   1. `version` must be an exact semver (a range like ^0.1.0 or a tag is refused); the Node path
//      must be absolute with no whitespace, quote, backslash or control character (it is written
//      into a sh trampoline and the bundle's #! line); the share path must hold no single quote.
//   2. --from-tarball only: requireHuman, then the sudo gate (sudoGate, run by install itself),
//      before anything else runs.
//   3. The chosen Node binary must be 22.13 or newer (`<node> --version`, through `run`).
//   4. The package goes into a temp prefix: from the registry through verifyPackage (npm install +
//      `npm audit signatures`: registry signature and provenance attestation), or from the tarball
//      (no provenance; the gate above stands in for it). Both npm runs are isolated from the npm
//      configuration (withNpmIsolation). Its package.json must carry the exact name and version.
//   5. Copy to versions/<v>/ (staged as versions/.staging-<v>-* and renamed into place only after
//      the smoke test, so a failure keeps whatever was there), bundle that copy's watchdog with the
//      Node path pinned on its first line, and run the smoke test (runSmoke) on the bundle and copy.
//   6. Place versions/<v> and replace, each by write-temp-then-rename, keeping the old file until
//      the end: the bundle at ~/.local/share/fence/fence-hook.mjs, the trampoline
//      ~/.local/bin/fence-hook (`#!/bin/sh` + `exec '<node>' '<bundle>' "$@"`), the CLI module
//      ~/.local/share/fence/fence-cli.mjs and its trampoline ~/.local/bin/fence. The bundle is
//      `.mjs`, so no package.json above it (a {"type":"commonjs"} one included) can change how
//      Node loads it.
//   7. Run the INSTALLED trampoline end to end (through `run`) against a fixed deny payload, with a
//      temp HOME whose `current` points at the placed versions/<v>; it must answer with the
//      engine's deny. Only then switch `current` by write-temp-then-rename.
//   8. When no policy exists: show the chosen shipped policy (returned as `policy.text`, and printed
//      through io.out when given) and write it; an existing policy is never overwritten. The choices
//      are policies/example.json (the default) and policies/strict.json when the package ships it.
//   9. Record the smoke result in <state>/smoke.json {version, ok, latencyMs, at} for doctor. Pin
//      git (the absolute path found on env.PATH, or `gitPath`, and its `--version`) into
//      ~/.local/share/fence/git.json; a git that can not be probed removes a stale git.json, and a
//      git older than 2.45.1 is pinned with a warning.
//  10. Return the per-host steps as strings.
//
// Everything is injected: `home` (absolute), `run` (spawnSync shape: run(cmd, args, {cwd, env,
// input, encoding, timeout}) -> {status, stdout, stderr, error}; it runs npm, git, sudo, the Node
// probe and the installed launcher), `env` (PATH for the git lookup, the agent-session check, the
// base of npm's cleaned environment), `stdin` (the TTY check), `smoke` (defaults to runSmoke),
// `now` (the smoke record's clock). The work directory lives under os.tmpdir() and is removed.

import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { requireHuman } from './humanonly.mjs';
import { fencePaths } from './paths.mjs';
import {
  PACKAGE_NAME,
  SEMVER,
  checkInstalledPackage,
  defaultNpmPath,
  isExactVersion,
  npmEnv,
  packageDirIn,
  verifyPackage,
  withNpmIsolation,
} from './provenance.mjs';
import { runSmoke } from './smoke.mjs';
import { sudoGate } from './sudo.mjs';

export const MIN_NODE = Object.freeze([22, 13]);
export const MIN_GIT = Object.freeze([2, 45, 1]);
export const POLICY_CHOICES = Object.freeze(['example', 'strict']);
const NPM_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 20_000;
// The watchdog's own failure text (watchdog.mjs failureText): a deny made of it is not the engine's.
const WATCHDOG_FAILURE = /could not check it/;
const UNSAFE_NODE_PATH = /[\s'"`\\\x00-\x1f\x7f]/;
const UNSAFE_SHARE_PATH = /['\x00-\x1f\x7f]/;

const errText = (err) => (err instanceof Error ? err.message : String(err));

function failed(r) {
  if (!r) return 'no result';
  if (r.error) return r.error.message;
  if (r.status !== 0) return r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return null;
}

// -> a reason the Node path can not be written into the trampoline and the #! line, or null.
function nodePathProblem(node) {
  if (typeof node !== 'string' || !nodePath.isAbsolute(node)) return `the Node path must be absolute, got ${JSON.stringify(node)}`;
  if (UNSAFE_NODE_PATH.test(node)) {
    return `the Node path ${JSON.stringify(node)} contains whitespace, a quote or a control character; the launcher can not name it`;
  }
  return null;
}

// `<node> --version` through run -> a reason, or null when it is 22.13 or newer.
function nodeVersionProblem(node, run) {
  const r = run(node, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  const f = failed(r);
  if (f) return `${node} --version failed (${f})`;
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? '').trim());
  if (!m) return `${node} --version printed no version`;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return null;
  return `fence needs Node ${MIN_NODE.join('.')} or newer; ${node} is ${m[0]}`;
}

const rand = () => randomBytes(4).toString('hex');
const tmpName = (file) => `${file}.tmp-${process.pid}-${rand()}`;

// write-temp-then-rename, in the target's directory.
function writeAtomic(file, text, mode) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    nodeFs.writeFileSync(tmp, text, { mode, flag: 'wx' });
    nodeFs.chmodSync(tmp, mode);
    nodeFs.renameSync(tmp, file);
  } catch (err) {
    nodeFs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Replaces `file` by write-temp-then-rename, keeping the old one (a hard link to it) until
// commit; rollback puts it back, or removes the new file when there was none.
function replaceFile(file, text, mode) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  let backup = null;
  if (nodeFs.existsSync(file)) {
    backup = `${file}.bak-${process.pid}-${rand()}`;
    nodeFs.linkSync(file, backup);
  }
  try {
    writeAtomic(file, text, mode);
  } catch (err) {
    if (backup) nodeFs.rmSync(backup, { force: true });
    throw err;
  }
  return {
    rollback: () => (backup ? nodeFs.renameSync(backup, file) : nodeFs.rmSync(file, { force: true })),
    commit: () => backup && nodeFs.rmSync(backup, { force: true }),
  };
}

// Renames the staged copy to versions/<v>, moving an existing one aside until commit; rollback
// restores it (or removes the new copy when there was none).
function placeVersion(staging, target) {
  let aside = null;
  if (nodeFs.existsSync(target)) {
    aside = nodePath.join(nodePath.dirname(target), `.old-${nodePath.basename(target)}-${rand()}`);
    nodeFs.renameSync(target, aside);
  }
  try {
    nodeFs.renameSync(staging, target);
  } catch (err) {
    if (aside) nodeFs.renameSync(aside, target);
    throw err;
  }
  return {
    rollback: () => {
      nodeFs.rmSync(target, { recursive: true, force: true });
      if (aside) nodeFs.renameSync(aside, target);
    },
    commit: () => aside && nodeFs.rmSync(aside, { recursive: true, force: true }),
  };
}

// The two-line POSIX sh trampoline: exec the pinned Node on an .mjs module, passing the arguments.
export function trampolineText(nodeBin, modulePath) {
  if (nodePathProblem(nodeBin)) throw new Error(nodePathProblem(nodeBin));
  if (typeof modulePath !== 'string' || !nodePath.isAbsolute(modulePath) || UNSAFE_SHARE_PATH.test(modulePath)) {
    throw new Error(`the module path ${JSON.stringify(modulePath)} can not be named in the launcher`);
  }
  return `#!/bin/sh\nexec '${nodeBin}' '${modulePath}' "$@"\n`;
}

// The CLI shim module: follows `current` and runs that version's CLI.
export function shimText(shareDir) {
  return [
    '// fence: the CLI shim module written by `fence install` (run by ~/.local/bin/fence). It follows',
    '// ~/.local/share/fence/current. Do not edit.',
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `const SHARE = ${JSON.stringify(shareDir)};`,
    `const SEMVER = new RegExp(${JSON.stringify(SEMVER.source)});`,
    "let version = '';",
    'try {',
    "  version = readFileSync(join(SHARE, 'current'), 'utf8').trim();",
    '} catch {',
    '  // reported below',
    '}',
    'if (!SEMVER.test(version)) {',
    "  process.stderr.write(`fence: ${join(SHARE, 'current')} does not name an installed version; run fence repair in your own terminal\\n`);",
    '  process.exit(1);',
    '}',
    "const cli = await import(pathToFileURL(join(SHARE, 'versions', version, 'src', 'cli', 'index.mjs')).href);",
    'process.exitCode = await cli.main(process.argv.slice(2));',
    '',
  ].join('\n');
}

// Runs the installed trampoline end to end: a temp HOME whose `current` points at the placed
// version, a Write to a built-in protected path under it. The engine must deny it (Claude shape:
// exit 0, one JSON line). -> a reason, or null.
function installedLauncherProblem(paths, { target, version, policyFile, workDir, run, env }) {
  const root = nodePath.join(workDir, 'launcher-check');
  const home = nodePath.join(root, 'home');
  const share = nodePath.join(home, '.local', 'share', 'fence');
  const state = nodePath.join(root, 'state');
  const admin = nodePath.join(root, 'admin');
  for (const d of [nodePath.join(share, 'versions'), state, admin]) nodeFs.mkdirSync(d, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(share, 'current'), `${version}\n`);
  nodeFs.symlinkSync(target, nodePath.join(share, 'versions', version), 'dir');
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'fence-install-check',
    cwd: root,
    permission_mode: 'default',
    tool_name: 'Write',
    tool_input: { file_path: nodePath.join(home, '.claude', 'settings.json'), content: 'x' },
  };
  const args = ['pre', '--host', 'claude', ...(policyFile ? ['--policy', policyFile] : []), '--state-dir', state, '--admin-dir', admin];
  const r = run(paths.watchdog, args, {
    input: JSON.stringify(payload),
    env: { HOME: home, PATH: typeof env?.PATH === 'string' ? env.PATH : '/usr/bin:/bin' },
    cwd: root,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  const f = failed(r);
  if (f) return `the installed launcher ${paths.watchdog} failed (${f}${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''})`;
  let out = null;
  try {
    out = JSON.parse(String(r.stdout).trim()).hookSpecificOutput;
  } catch {
    // reported below
  }
  if (out?.permissionDecision !== 'deny') {
    return `the installed launcher ${paths.watchdog} did not deny the check payload (stdout ${JSON.stringify(String(r.stdout ?? '').slice(0, 200))})`;
  }
  if (WATCHDOG_FAILURE.test(String(out.permissionDecisionReason))) {
    return `the installed launcher ${paths.watchdog} could not run its engine: ${out.permissionDecisionReason}`;
  }
  return null;
}

// The first executable `name` on PATH, symlinks resolved -> absolute path or null.
function findOnPath(name, pathVar) {
  if (typeof pathVar !== 'string') return null;
  for (const dir of pathVar.split(nodePath.delimiter)) {
    if (!nodePath.isAbsolute(dir)) continue;
    const candidate = nodePath.join(dir, name);
    try {
      if (!nodeFs.statSync(candidate).isFile()) continue;
      nodeFs.accessSync(candidate, nodeFs.constants.X_OK);
      return nodeFs.realpathSync(candidate);
    } catch {
      // not here
    }
  }
  return null;
}

const older = (v, min) => {
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] < min[i];
  return false;
};

// -> {pin: {path, version}, warning?} | {warning}
function probeGit(gitPath, env, run) {
  const git = gitPath ?? findOnPath('git', env?.PATH);
  if (typeof git !== 'string' || !nodePath.isAbsolute(git)) return { warning: 'git was not found on PATH; no git is pinned (git tree updates in repositories that track .claude/ or .codex/ will be opaque)' };
  const r = run(git, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  const f = failed(r);
  const m = f ? null : /git version (\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? ''));
  if (!m) return { warning: `${git} --version ${f ? `failed (${f})` : 'printed no version'}; no git is pinned` };
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  const pin = { path: git, version };
  if (older([Number(m[1]), Number(m[2]), Number(m[3])], MIN_GIT)) {
    return { pin, warning: `git ${version} (${git}) is older than ${MIN_GIT.join('.')}: git tree updates in repositories that track .claude/ or .codex/ will be opaque until git is upgraded and fence is reinstalled` };
  }
  return { pin };
}

export function hostSteps(paths) {
  return [
    'Claude Code: run `claude plugin marketplace add Montinou/triqual`, then `claude plugin install fence@triqual`, and restart Claude Code; `fence doctor` checks that the plugin is enabled.',
    `Codex: install the fence-codex bridge plugin from the triqual marketplace, enable the hooks feature in ~/.codex/config.toml and trust the fence hooks when Codex asks; the bridge runs ${paths.watchdog}. \`fence doctor\` checks each step.`,
    'Grok: not enforced.',
  ];
}

export async function install({
  version,
  fromTarball,
  home,
  run,
  env = process.env,
  stdin,
  nodePath: node = process.execPath,
  npmPath,
  gitPath,
  smoke = runSmoke,
  policyChoice = 'example',
  io,
  now = Date.now,
} = {}) {
  if (typeof run !== 'function') throw new Error('install: no process runner was given');
  const fail = (reason) => ({ ok: false, reason });

  let paths;
  try {
    paths = fencePaths(home);
  } catch (err) {
    return fail(errText(err));
  }
  if (!isExactVersion(version)) {
    return fail(`install needs an exact version such as 0.1.0 (no range or tag), got ${JSON.stringify(version)}`);
  }
  if (!POLICY_CHOICES.includes(policyChoice)) return fail(`the policy choice must be one of ${POLICY_CHOICES.join(', ')}, got ${JSON.stringify(policyChoice)}`);
  const nodeProblem = nodePathProblem(node);
  if (nodeProblem) return fail(nodeProblem);
  if (UNSAFE_SHARE_PATH.test(paths.shareDir)) return fail(`the home directory ${JSON.stringify(paths.home)} contains a single quote or a control character; the launcher can not name it`);

  let tarball = null;
  if (fromTarball !== undefined && fromTarball !== null) {
    if (typeof fromTarball !== 'string' || fromTarball === '') return fail('--from-tarball needs a file');
    tarball = nodePath.resolve(fromTarball);
    try {
      if (!nodeFs.statSync(tarball).isFile()) return fail(`--from-tarball: ${tarball} is not a file`);
    } catch {
      return fail(`--from-tarball: ${tarball} was not found`);
    }
    try {
      requireHuman({ stdin, env });
    } catch (err) {
      return fail(errText(err));
    }
    const gate = sudoGate({ run });
    if (!gate.ok) return fail(`install --from-tarball skips the provenance check and needs fresh sudo authentication: ${gate.reason}`);
  }

  const versionProblem = nodeVersionProblem(node, run);
  if (versionProblem) return fail(versionProblem);

  const npm = npmPath ?? defaultNpmPath(node);
  let work = null;
  let staging = null;
  try {
    work = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-install-')));
    const prefix = nodePath.join(work, 'prefix');
    nodeFs.mkdirSync(prefix);

    // 4. the package, verified
    let packageDir;
    if (tarball) {
      const r = withNpmIsolation((flags) =>
        run(npm, ['install', '--prefix', prefix, ...flags, '--no-audit', '--no-fund', tarball], { cwd: prefix, env: npmEnv(env), encoding: 'utf8', timeout: NPM_TIMEOUT_MS }),
      );
      const f = failed(r);
      if (f) return fail(`npm install of ${tarball} failed (${f})`);
      packageDir = packageDirIn(prefix);
      const mismatch = checkInstalledPackage(packageDir, version);
      if (mismatch) return fail(mismatch);
    } else {
      const v = verifyPackage(`${PACKAGE_NAME}@${version}`, { run, npmPath: npm, prefix, env });
      if (!v.ok) return fail(`provenance check failed: ${v.reason}`);
      packageDir = v.packageDir;
    }

    // 5. copy (staged), bundle, smoke
    nodeFs.mkdirSync(paths.versionsDir, { recursive: true });
    staging = nodeFs.mkdtempSync(nodePath.join(paths.versionsDir, `.staging-${version}-`));
    nodeFs.cpSync(packageDir, staging, { recursive: true, verbatimSymlinks: true });
    if (!nodeFs.existsSync(nodePath.join(staging, 'src', 'engine.mjs'))) return fail('the package has no src/engine.mjs');

    const target = nodePath.join(paths.versionsDir, version);
    const choices = [];
    for (const name of POLICY_CHOICES) {
      if (nodeFs.existsSync(nodePath.join(staging, 'policies', `${name}.json`))) {
        choices.push({ name, path: nodePath.join(target, 'policies', `${name}.json`), default: name === 'example' });
      }
    }
    if (policyChoice !== 'example' && !choices.some((c) => c.name === policyChoice)) {
      return fail(`the package does not ship policies/${policyChoice}.json`);
    }
    const chosenName = nodePath.join('policies', `${policyChoice}.json`);
    const policyExists = nodeFs.existsSync(paths.policy);
    const chosenText = nodeFs.existsSync(nodePath.join(staging, chosenName)) ? nodeFs.readFileSync(nodePath.join(staging, chosenName), 'utf8') : null;

    const bundler = await import(pathToFileURL(nodePath.join(staging, 'src', 'build', 'bundle-watchdog.mjs')).href);
    const watchdogText = bundler.buildWatchdog({ nodePath: node });
    const bundle = nodePath.join(work, 'bundle', 'fence-hook.mjs');
    nodeFs.mkdirSync(nodePath.dirname(bundle));
    nodeFs.writeFileSync(bundle, watchdogText, { mode: 0o644 });

    const smokePolicy = policyExists ? paths.policy : chosenText !== null ? nodePath.join(staging, chosenName) : undefined;
    const sm = smoke({ watchdogPath: bundle, engineDir: staging, policy: smokePolicy });
    if (!sm || sm.ok !== true) return fail(`the smoke test failed: ${(sm?.failures ?? ['no result']).join('; ')}`);

    // 6 and 7: place and replace (undoable), check the installed launcher, switch `current`
    const steps = [];
    try {
      steps.push(placeVersion(staging, target));
      staging = null;
      steps.push(replaceFile(paths.watchdogBundle, watchdogText, 0o644));
      steps.push(replaceFile(paths.watchdog, trampolineText(node, paths.watchdogBundle), 0o755));
      steps.push(replaceFile(paths.shimModule, shimText(paths.shareDir), 0o644));
      steps.push(replaceFile(paths.shim, trampolineText(node, paths.shimModule), 0o755));
      const policyFile = policyExists ? paths.policy : chosenText !== null ? nodePath.join(target, chosenName) : undefined;
      const problem = installedLauncherProblem(paths, { target, version, policyFile, workDir: work, run, env });
      if (problem) throw new Error(problem);
      writeAtomic(paths.current, `${version}\n`, 0o644);
    } catch (err) {
      for (const s of steps.reverse()) {
        try {
          s.rollback();
        } catch {
          // best effort: the original failure is the one reported
        }
      }
      return fail(errText(err));
    }
    for (const s of steps) {
      try {
        s.commit();
      } catch {
        // a leftover backup is harmless
      }
    }

    // 8-10: after the switch, failures are warnings
    const warnings = [];
    const later = (what, fn) => {
      try {
        fn();
      } catch (err) {
        warnings.push(`${what} failed: ${errText(err)}`);
      }
    };

    const policy = { path: paths.policy, choice: policyChoice, written: false };
    if (!policyExists && chosenText !== null) {
      policy.text = chosenText;
      if (typeof io?.out === 'function') io.out(`The ${policyChoice} policy fence installs as ${paths.policy}:\n${chosenText}`);
      later(`writing the policy ${paths.policy}`, () => {
        policy.written = writeNew(paths.policy, chosenText, 0o644);
        if (!policy.written) warnings.push(`${paths.policy} appeared during the install; it was left as it is`);
      });
    } else if (!policyExists) {
      warnings.push(`the package ships no policies/${policyChoice}.json; no policy was written`);
    }

    later(`writing the smoke result ${paths.smokeResult}`, () =>
      writeAtomic(paths.smokeResult, `${JSON.stringify({ version, ok: true, latencyMs: sm.latencyMs ?? [], at: new Date(now()).toISOString() })}\n`, 0o644),
    );

    const git = probeGit(gitPath, env, run);
    if (git.warning) warnings.push(git.warning);
    if (git.pin) later(`writing ${paths.gitPin}`, () => writeAtomic(paths.gitPin, `${JSON.stringify(git.pin)}\n`, 0o644));
    else later(`removing the stale ${paths.gitPin}`, () => nodeFs.rmSync(paths.gitPin, { force: true }));

    const hostLines = hostSteps(paths);
    if (typeof io?.out === 'function') {
      if (git.pin) io.out(`git ${git.pin.version} (${git.pin.path}) is pinned.`);
      for (const w of warnings) io.out(`warning: ${w}`);
      for (const s of hostLines) io.out(s);
    }

    const result = {
      ok: true,
      version,
      enginePath: nodePath.join(target, 'src', 'engine.mjs'),
      paths,
      policy,
      choices,
      steps: hostLines,
      warnings,
      gitPin: git.pin ?? null,
      smoke: { latencyMs: sm.latencyMs ?? [] },
    };
    const failedLater = warnings.filter((w) => / failed: /.test(w));
    if (failedLater.length > 0) {
      result.repairNeeded = `fence ${version} is installed and active, but ${failedLater.length} later step(s) failed; run fence repair (or fence doctor) in your own terminal`;
    }
    return result;
  } catch (err) {
    return fail(`install failed: ${errText(err)}`);
  } finally {
    if (staging !== null) nodeFs.rmSync(staging, { recursive: true, force: true });
    if (work !== null) nodeFs.rmSync(work, { recursive: true, force: true });
  }
}

// Writes `file` only if it does not exist, never replacing one (a hard link fails on an existing
// name, where a rename would overwrite it). -> true when written.
function writeNew(file, text, mode) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    nodeFs.writeFileSync(tmp, text, { mode, flag: 'wx' });
    nodeFs.chmodSync(tmp, mode);
    try {
      nodeFs.linkSync(tmp, file);
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      throw err;
    }
    return true;
  } finally {
    nodeFs.rmSync(tmp, { force: true });
  }
}
