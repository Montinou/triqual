// Failure-acceptance helper (test-only): put a fake engine, or no launcher, into a staged fence home.
//
//   installFake(home, kind, {version = '0.0.0-fake'}) -> {version, engine}
//       kind is "selfkill" | "sleep" | "garbage": copies fake-engines/<kind>.mjs to
//       <home>/.local/share/fence/versions/<version>/src/engine.mjs (the version is a semver name,
//       which the watchdog requires) and points `current` at it. Nothing else is touched.
//   installFake(home, "remove-launcher") -> {removed}
//       deletes <home>/.local/bin/fence-hook, so the hook command meets a missing launcher.
//
// `home` is a temporary HOME, normally the one stageHome (../stage-home.mjs) returns; this module
// writes only under it.

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { fencePaths } from '../../../src/cli/paths.mjs';

export const FAKE_KINDS = Object.freeze(['selfkill', 'sleep', 'garbage']);
export const REMOVE_LAUNCHER = 'remove-launcher';
export const DEFAULT_FAKE_VERSION = '0.0.0-fake';

const ENGINES_DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fake-engines');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function installFake(home, kind, { version = DEFAULT_FAKE_VERSION } = {}) {
  const paths = fencePaths(home);
  if (kind === REMOVE_LAUNCHER) {
    nodeFs.rmSync(paths.watchdog, { force: true });
    return { removed: paths.watchdog };
  }
  if (!FAKE_KINDS.includes(kind)) {
    throw new Error(`installFake: unknown kind ${JSON.stringify(String(kind))}: expected one of ${[...FAKE_KINDS, REMOVE_LAUNCHER].join(', ')}`);
  }
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`installFake: the version directory must be a semver name, got ${JSON.stringify(version)}`);
  }
  const engine = nodePath.join(paths.versionsDir, version, 'src', 'engine.mjs');
  nodeFs.mkdirSync(nodePath.dirname(engine), { recursive: true });
  nodeFs.copyFileSync(nodePath.join(ENGINES_DIR, `${kind}.mjs`), engine);
  nodeFs.writeFileSync(paths.current, `${version}\n`, { mode: 0o644 });
  return { version, engine };
}
