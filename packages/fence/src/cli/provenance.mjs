// Provenance verification for install and upgrade (spec, "CLI").
//
//   verifyPackage("@triqual/fence@<exact>", {run, npmPath?, prefix?}) -> {ok, reason?, packageDir?}
//
// Installs the package into a temporary prefix (`npm install --prefix <p> --ignore-scripts ...`, no
// lifecycle script runs) and runs `npm audit signatures` there. The check passes only when npm exits
// 0 and reports a verified registry signature AND a verified provenance attestation for every
// audited package (fence has no runtime dependencies, so that is the one package), and the installed
// package.json carries exactly the requested name and version. A missing or invalid attestation, an
// npm failure or an unreadable answer is not ok.
//
// Both npm runs are isolated from the machine's npm configuration (withNpmIsolation): the public
// registry by flag, empty temp files as the user and global npmrc, --ignore-scripts, and an
// environment without npm_config_* / NPM_CONFIG_* (any case), NODE_OPTIONS or NODE_EXTRA_CA_CERTS.
// A configured mirror, a preloaded module or an extra CA can not stand in for the registry.
//
// `run` (required) is the process runner, spawnSync shape: run(cmd, args, {cwd, env, encoding}) ->
// {status, stdout, stderr, error}. `npmPath` defaults to the npm beside the running Node binary;
// `env` (default process.env) is the environment the cleaned one is made from. With `prefix`, the
// package is left there for the caller (packageDir); without it, verifyPackage makes its own temp
// prefix and removes it.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

export const PACKAGE_NAME = '@triqual/fence';
export const REGISTRY = 'https://registry.npmjs.org/';
// semver 2.0.0: numeric identifiers (the core and numeric prerelease ids) have no leading zero.
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
export const SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${PRE_ID}(?:\\.${PRE_ID})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
const NPM_TIMEOUT_MS = 300_000;
const DROPPED_ENV = new Set(['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']);

// The environment npm runs with: `env` without npm configuration or Node hook variables.
export function npmEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (/^npm_config_/i.test(k) || DROPPED_ENV.has(k.toUpperCase())) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// Calls fn(flags) with the isolation flags; the empty npmrc files live in their own temp directory,
// removed afterwards.
export function withNpmIsolation(fn) {
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-npmrc-')));
  try {
    const user = nodePath.join(dir, 'userconfig');
    const global = nodePath.join(dir, 'globalconfig');
    nodeFs.writeFileSync(user, '', { mode: 0o600 });
    nodeFs.writeFileSync(global, '', { mode: 0o600 });
    return fn([`--registry=${REGISTRY}`, `--userconfig=${user}`, `--globalconfig=${global}`, '--ignore-scripts']);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

export function isExactVersion(v) {
  return typeof v === 'string' && SEMVER.test(v);
}

// The npm installed beside a Node binary (official installers, Homebrew and nvm all put it there).
export function defaultNpmPath(node = process.execPath) {
  return nodePath.join(nodePath.dirname(node), 'npm');
}

// "@triqual/fence@<exact>" -> the version, or null.
function specVersion(spec) {
  if (typeof spec !== 'string' || !spec.startsWith(`${PACKAGE_NAME}@`)) return null;
  const v = spec.slice(PACKAGE_NAME.length + 1);
  return isExactVersion(v) ? v : null;
}

export function packageDirIn(prefix) {
  return nodePath.join(prefix, 'node_modules', ...PACKAGE_NAME.split('/'));
}

function failure(r) {
  if (!r) return 'no result';
  if (r.error) return r.error.message;
  if (r.status !== 0) return r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return null;
}

const tail = (s) => String(s ?? '').trim().split('\n').slice(-3).join(' / ').slice(0, 300);

// The `npm audit signatures` text -> {audited, signatures, attestations} counts (null when absent).
function readAudit(text) {
  const count = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    audited: count(/audited (\d+) packages?/),
    signatures: count(/(\d+) packages? ha(?:s|ve) (?:a )?verified registry signatures?/),
    attestations: count(/(\d+) packages? ha(?:s|ve) (?:a )?verified attestations?/),
  };
}

// Checks the installed package.json against the expected name and version -> reason or null.
export function checkInstalledPackage(packageDir, version) {
  let pkg;
  try {
    pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(packageDir, 'package.json'), 'utf8'));
  } catch (err) {
    return `the installed package has no readable package.json (${err instanceof Error ? err.message : String(err)})`;
  }
  if (pkg?.name !== PACKAGE_NAME) return `the installed package is ${JSON.stringify(pkg?.name)}, not ${PACKAGE_NAME}`;
  if (pkg?.version !== version) return `the installed package is version ${JSON.stringify(pkg?.version)}, not ${version}`;
  return null;
}

export function verifyPackage(spec, { run, npmPath, prefix, env = process.env } = {}) {
  if (typeof run !== 'function') throw new Error('verifyPackage: no process runner was given');
  const version = specVersion(spec);
  if (version === null) {
    return { ok: false, reason: `the package must be named as ${PACKAGE_NAME}@<exact version> (no range or tag), got ${JSON.stringify(spec)}` };
  }
  const npm = npmPath ?? defaultNpmPath();
  const own = prefix === undefined;
  const dir = own ? nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-verify-'))) : prefix;
  try {
    return withNpmIsolation((flags) => audited(spec, version, { run, npm, dir, flags, env: npmEnv(env), own }));
  } finally {
    if (own) nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

// The install and the audit, inside withNpmIsolation.
function audited(spec, version, { run, npm, dir, flags, env, own }) {
  const inst = run(npm, ['install', '--prefix', dir, ...flags, '--no-audit', '--no-fund', '--save-exact', spec], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
  });
  const instFailed = failure(inst);
  if (instFailed) return { ok: false, reason: `npm install of ${spec} failed (${instFailed}${inst?.stderr ? `: ${tail(inst.stderr)}` : ''})` };

  const packageDir = packageDirIn(dir);
  const mismatch = checkInstalledPackage(packageDir, version);
  if (mismatch) return { ok: false, reason: mismatch };

  const audit = run(npm, ['audit', 'signatures', ...flags], { cwd: dir, env, encoding: 'utf8', timeout: NPM_TIMEOUT_MS });
  const auditFailed = failure(audit);
  const text = `${audit?.stdout ?? ''}\n${audit?.stderr ?? ''}`;
  if (auditFailed) return { ok: false, reason: `npm audit signatures failed (${auditFailed}): ${tail(text)}` };
  const counts = readAudit(text);
  if (!counts.audited) return { ok: false, reason: `npm audit signatures audited no package: ${tail(text)}` };
  if (counts.signatures !== counts.audited) {
    return { ok: false, reason: `npm audit signatures verified the registry signature of ${counts.signatures ?? 0} of ${counts.audited} packages` };
  }
  if (counts.attestations !== counts.audited) {
    return { ok: false, reason: `the provenance attestation is missing or invalid: npm audit signatures verified ${counts.attestations ?? 0} of ${counts.audited} attestations` };
  }
  return own ? { ok: true } : { ok: true, packageDir };
}
