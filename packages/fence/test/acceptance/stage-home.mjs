// A staged fence install in a temp HOME, for the acceptance runners and their tests (test-only).
//
//   stageHome(dir, {policyPath}) -> {home, watchdog}
//   node stage-home.mjs <dir> --policy <file>      prints {"home": ..., "watchdog": ...} as one JSON line
//
// It reproduces the layout `fence install` leaves (src/cli/install.mjs, src/cli/paths.mjs) without
// the CLI, npm, provenance or the sudo gate, under <dir>/home:
//   ~/.local/share/fence/versions/0.0.0-test/   a copy of this package (package.json and its `files`)
//   ~/.local/share/fence/current                 "0.0.0-test" (a semver name, which the watchdog requires)
//   ~/.local/share/fence/fence-hook.mjs          the watchdog (buildWatchdog), process.execPath pinned
//   ~/.local/bin/fence-hook                      the sh trampoline (trampolineText) that execs it
//   ~/.local/share/fence/git.json                {path, version} of the machine's `git` (as install pins
//                                                it), left out when no git is found or it can not be probed
//   ~/.config/fence/policy.json                  a copy of `policyPath`
// The runners then call `<home>/.local/bin/fence-hook` with HOME=<home>. Nothing outside `dir` is
// written; `dir` must not exist yet or be empty.

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildWatchdog } from '../../src/build/bundle-watchdog.mjs';
import { findOnPath, trampolineText } from '../../src/cli/install.mjs';
import { fencePaths } from '../../src/cli/paths.mjs';

export const TEST_VERSION = '0.0.0-test';
const PKG_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_TIMEOUT_MS = 20_000;

// package.json plus the entries of its `files` list that exist, copied as npm would pack them.
function copyPackage(target) {
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(PKG_DIR, 'package.json'), 'utf8'));
  nodeFs.mkdirSync(target, { recursive: true });
  nodeFs.copyFileSync(nodePath.join(PKG_DIR, 'package.json'), nodePath.join(target, 'package.json'));
  for (const entry of pkg.files ?? []) {
    const from = nodePath.join(PKG_DIR, entry);
    if (nodeFs.existsSync(from)) nodeFs.cpSync(from, nodePath.join(target, entry), { recursive: true });
  }
}

// The git pin install writes (probeGit in install.mjs): the first git on PATH and its version.
function gitPin(pathVar) {
  const git = findOnPath('git', pathVar);
  if (git === null) return null;
  const r = spawnSync(git, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  const m = r.status === 0 ? /git version (\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout ?? '')) : null;
  return m ? { path: git, version: `${m[1]}.${m[2]}.${m[3]}` } : null;
}

export function stageHome(dir, { policyPath } = {}) {
  if (typeof dir !== 'string' || !nodePath.isAbsolute(dir)) throw new Error(`stageHome: the directory must be absolute, got ${JSON.stringify(dir)}`);
  if (typeof policyPath !== 'string' || !nodeFs.statSync(policyPath).isFile()) throw new Error(`stageHome: no policy file ${JSON.stringify(policyPath)}`);
  nodeFs.mkdirSync(dir, { recursive: true });
  if (nodeFs.readdirSync(dir).length > 0) throw new Error(`stageHome: ${dir} is not empty`);
  const home = nodePath.join(nodeFs.realpathSync(dir), 'home');
  const paths = fencePaths(home);

  const versionDir = nodePath.join(paths.versionsDir, TEST_VERSION);
  copyPackage(versionDir);
  nodeFs.writeFileSync(paths.current, `${TEST_VERSION}\n`, { mode: 0o644 });

  // the package's own bundler (the copy holds the same sources, so the bundle is the same text)
  nodeFs.writeFileSync(paths.watchdogBundle, buildWatchdog({ nodePath: process.execPath }), { mode: 0o644 });
  nodeFs.mkdirSync(paths.binDir, { recursive: true });
  nodeFs.writeFileSync(paths.watchdog, trampolineText(process.execPath, paths.watchdogBundle), { mode: 0o755 });
  nodeFs.chmodSync(paths.watchdog, 0o755);

  const pin = gitPin(process.env.PATH);
  if (pin !== null) nodeFs.writeFileSync(paths.gitPin, `${JSON.stringify(pin)}\n`, { mode: 0o644 });

  nodeFs.mkdirSync(paths.configDir, { recursive: true });
  nodeFs.copyFileSync(policyPath, paths.policy);
  return { home, watchdog: paths.watchdog };
}

// Script use (run-claude.sh): node stage-home.mjs <dir> --policy <file>
if (process.argv[1] && import.meta.url === pathToFileURL(nodePath.resolve(process.argv[1])).href) {
  const [dir, flag, policy] = process.argv.slice(2);
  if (dir === undefined || flag !== '--policy' || policy === undefined) {
    process.stderr.write('usage: node stage-home.mjs <dir> --policy <file>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(stageHome(nodePath.resolve(dir), { policyPath: nodePath.resolve(policy) }))}\n`);
}
