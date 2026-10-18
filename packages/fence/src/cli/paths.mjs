// Every path of the installed state (spec, "Layout / Installed state").
//
//   fencePaths(home, {platform?}) -> frozen object of absolute paths
//   versionDir(home, v)  -> ~/.local/share/fence/versions/<v>
//   enginePath(home, v)  -> ~/.local/share/fence/versions/<v>/src/engine.mjs
//
// `home` must be absolute (the CLI wiring passes os.homedir(); tests pass a temp directory). The
// admin directory depends on the platform (adminDir in admin.mjs); `lockedDir` is the root-owned
// copy `fence lock` makes (locked mode).

import nodePath from 'node:path';

import { adminDir } from './admin.mjs';

export const LOCKED_DIR = '/usr/local/libexec/fence';

function checkHome(home) {
  if (typeof home !== 'string' || !nodePath.isAbsolute(home) || home.includes('\0')) {
    throw new Error(`fence paths: the home directory must be an absolute path, got ${JSON.stringify(home)}`);
  }
  return nodePath.resolve(home);
}

export function fencePaths(home, { platform = process.platform } = {}) {
  const h = checkHome(home);
  const shareDir = nodePath.join(h, '.local', 'share', 'fence');
  const binDir = nodePath.join(h, '.local', 'bin');
  const configDir = nodePath.join(h, '.config', 'fence');
  const stateDir = nodePath.join(h, '.local', 'state', 'fence');
  let admin = null;
  try {
    admin = nodePath.resolve(adminDir(platform));
  } catch {
    admin = null; // a platform with no admin directory
  }
  return Object.freeze({
    home: h,
    shareDir,
    versionsDir: nodePath.join(shareDir, 'versions'),
    current: nodePath.join(shareDir, 'current'),
    gitPin: nodePath.join(shareDir, 'git.json'),
    // the bundled watchdog (ESM by its extension) and the two-line sh trampoline the hooks run
    watchdogBundle: nodePath.join(shareDir, 'fence-hook.mjs'),
    // the CLI shim module (follows `current`) and the trampoline on PATH
    shimModule: nodePath.join(shareDir, 'fence-cli.mjs'),
    binDir,
    watchdog: nodePath.join(binDir, 'fence-hook'),
    shim: nodePath.join(binDir, 'fence'),
    configDir,
    policy: nodePath.join(configDir, 'policy.json'),
    stateDir,
    logDir: nodePath.join(stateDir, 'log'),
    keepDir: nodePath.join(stateDir, 'keep'),
    writtenDir: nodePath.join(stateDir, 'written'),
    health: nodePath.join(stateDir, 'health.json'),
    verifiedDir: nodePath.join(stateDir, 'verified'),
    // the last successful install's smoke result, for doctor
    smokeResult: nodePath.join(stateDir, 'smoke.json'),
    adminDir: admin,
    hatch: admin && nodePath.join(admin, 'hatch.json'),
    integrity: admin && nodePath.join(admin, 'integrity.json'),
    grantsDir: admin && nodePath.join(admin, 'grants'),
    lockedDir: LOCKED_DIR,
  });
}

export function versionDir(home, version) {
  if (typeof version !== 'string' || version === '' || version.includes('/') || version.startsWith('.')) {
    throw new Error(`fence paths: invalid version ${JSON.stringify(version)}`);
  }
  return nodePath.join(fencePaths(home).versionsDir, version);
}

export function enginePath(home, version) {
  return nodePath.join(versionDir(home, version), 'src', 'engine.mjs');
}
