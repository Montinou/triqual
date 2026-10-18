// `fence allow-once <path>` (spec, CLI `allow-once`; human-only and weakening: the sudo gate always
// runs).
//
//   allowOnce({argv, home?, cwd?, platform?, now?, gate, adminWriter?, run?, adminDir?, fs?, io?})
//     -> Promise<{ok, reason?, path?, expires?, file?}>
//
// Writes, as root, one single-use grant into the admin directory's `grants/`: a file
// `grants/<time>-<random>.json` holding {path, expires, nonce}, `path` the REALPATH of the argument,
// `expires` an ISO time GRANT_LIFETIME_MS (10 minutes) ahead and `nonce` random (so two grants never
// have the same bytes, hence never the same used marker). The resolved path is shown to the human
// before the sudo gate runs; when grants/ already holds MAX_GRANTS files the result carries a
// `warning` (the engine reads the newest MAX_GRANTS; older grants are ignored). The engine (eval/grants.mjs) lifts the
// built-in self-protection deny for exactly that path once, records the use in the user state
// directory (keyed by the file's sha) and logs the allowed write with rule "grant". A grant never
// overrides a policy deny, an opaque verdict or any other path; nothing here widens that.
//
// In this order: parse the arguments and resolve the path (a bad argument is refused before the
// gate); require a way to write the admin directory; run the gate (`gate()` must answer true or
// {ok: true}; a missing gate refuses); write the grant through `adminWriter(relPath, data)`, whose
// default is adminWrite (admin.mjs: sudo tee into the root-owned admin directory, with `run` as the
// process runner, required then). The path is resolved with the same resolver the engine uses
// (resolve/paths.mjs), so the grant matches the way the engine resolves the write: symlinks are
// followed, a path that does not exist yet resolves through its nearest existing parent, a relative
// path resolves from `cwd` (default process.cwd()) and `~/` from `home`. The CLI wiring (T40) passes
// the gate (sudoGate with the real runner), realRun and requireHuman first. `now` is a clock
// function (default Date.now). No flag or environment variable reaches the clock, the gate, the
// writer, the working directory or the paths.

import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { adminWrite } from './admin.mjs';
import { fencePaths } from './paths.mjs';
import { GRANT_MAX_LIFETIME_MS, MAX_GRANTS } from '../eval/grants.mjs';
import { isUnknown } from '../norm/unknown.mjs';
import { resolvePath } from '../resolve/paths.mjs';

export const GRANT_LIFETIME_MS = GRANT_MAX_LIFETIME_MS;

const errText = (err) => (err instanceof Error ? err.message : String(err));
const USAGE = 'usage: fence allow-once <path>';

// -> {target} (the argument as typed) or {error}.
export function parseAllowOnceArgs(argv = []) {
  const positional = [];
  let flagsDone = false;
  for (const a of argv) {
    if (typeof a !== 'string') return { error: `${USAGE} (an argument is not text)` };
    if (!flagsDone && a === '--') {
      flagsDone = true;
    } else if (!flagsDone && a.startsWith('-')) {
      return { error: `unknown argument ${JSON.stringify(a)} (${USAGE})` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return { error: positional.length === 0 ? `a path is required (${USAGE})` : `exactly one path is allowed (${USAGE})` };
  const [target] = positional;
  if (target === '') return { error: `the path is empty (${USAGE})` };
  if (/[\0\r\n]/.test(target)) return { error: 'the path contains NUL or a newline' };
  return { target };
}

async function passGate(gate, info) {
  if (typeof gate !== 'function') return 'fence allow-once needs fresh sudo authentication, but no sudo gate was given; nothing was written';
  let g;
  try {
    g = await gate(info);
  } catch (err) {
    g = { ok: false, reason: errText(err) };
  }
  if (g === true || g?.ok === true) return null;
  return `fence allow-once needs fresh sudo authentication: ${g?.reason ?? 'the sudo gate refused'}; nothing was written`;
}

export async function allowOnce({ argv = [], home, cwd, platform = process.platform, now = Date.now, gate, adminWriter, run, adminDir, fs: fsImpl = nodeFs, io } = {}) {
  const say = (s) => {
    if (typeof io?.out === 'function') io.out(s);
  };
  const fail = (reason) => ({ ok: false, reason });
  const args = parseAllowOnceArgs(argv);
  if (args.error) return fail(args.error);

  let paths;
  const homeDir = home ?? os.homedir();
  try {
    paths = fencePaths(homeDir, { platform });
  } catch (err) {
    return fail(errText(err));
  }
  const workDir = cwd ?? process.cwd();
  if (typeof workDir !== 'string' || !nodePath.isAbsolute(workDir) || workDir.includes('\0')) {
    return fail('the working directory is not an absolute path, so the path cannot be resolved; nothing was written');
  }
  const real = resolvePath(args.target, workDir, paths.home, fsImpl);
  if (isUnknown(real) || typeof real !== 'string' || !nodePath.isAbsolute(real)) {
    return fail(`the path ${JSON.stringify(args.target)} cannot be resolved to a real path; nothing was written`);
  }
  if (/[\0\r\n]/.test(real) || real.split('/').some((seg) => seg === '.' || seg === '..')) {
    return fail(`the path ${JSON.stringify(args.target)} does not resolve to a clean absolute path; nothing was written`);
  }

  const admin = adminDir ?? paths.adminDir;
  let write = adminWriter;
  if (typeof write !== 'function') {
    if (typeof run !== 'function') return fail('fence allow-once: no process runner was given to write the admin directory; nothing was written');
    if (typeof admin !== 'string') return fail('fence allow-once: this platform has no admin directory; nothing was written');
    write = (rel, data) => adminWrite(rel, data, { adminDir: admin, run });
  }

  // The human sees the real path (symlinks followed) before the sudo prompt, not only after the write.
  say(`fence allow-once: authenticating to allow one write to ${real} (the resolved real path).`);
  const refused = await passGate(gate, { path: real });
  if (refused) return fail(refused);

  let expires;
  let rel;
  let body;
  try {
    const t = typeof now === 'function' ? now() : Date.now();
    if (!Number.isFinite(t)) return fail('the clock gave no time; nothing was written');
    expires = new Date(t + GRANT_LIFETIME_MS).toISOString();
    // A unique name per grant, and the random nonce is in the content too: the used marker is keyed by
    // the sha of the file bytes, so two grants (even for one path in one millisecond) never share one.
    const nonce = randomBytes(8).toString('hex');
    rel = `grants/${t}-${nonce.slice(0, 12)}.json`;
    body = `${JSON.stringify({ path: real, expires, nonce })}\n`;
  } catch (err) {
    return fail(`the clock gave no usable time (${errText(err)}); nothing was written`);
  }

  // The engine reads at most MAX_GRANTS files, newest first; past that, old grants are ignored.
  let warning;
  if (typeof admin === 'string') {
    try {
      const held = fsImpl.readdirSync(nodePath.join(admin, 'grants')).filter((n) => n.endsWith('.json')).length;
      if (held >= MAX_GRANTS) {
        warning = `grants/ already holds ${held} grant files (the engine reads the newest ${MAX_GRANTS}); older grants are ignored and can be removed by root`;
      }
    } catch {
      // grants/ may not exist yet (the writer creates it) or cannot be listed by this user: no warning
    }
  }

  let written;
  try {
    written = write(rel, body);
  } catch (err) {
    return fail(`writing the grant failed: ${errText(err)}`);
  }
  const file = typeof written?.path === 'string' ? written.path : typeof admin === 'string' ? nodePath.join(admin, rel) : rel;
  say(`Granted one write to ${real} until ${expires}. It is used up by the first allowed write to that exact path and is logged when used.`);
  if (warning) say(`Warning: ${warning}.`);
  return warning ? { ok: true, path: real, expires, file, warning } : { ok: true, path: real, expires, file };
}
