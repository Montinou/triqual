// `fence hatch [--for <duration>]` and `fence hatch --close` (spec, CLI `hatch`; human-only and
// weakening: the sudo gate always runs).
//
//   hatch({argv, home?, platform?, now?, gate, adminWriter?, run?, adminDir?, repoRoots?,
//          claudeManaged?, codexManaged?, fs?, io?}) -> Promise<{ok, reason?, created?, expires?, closed?}>
//   parseDuration(text) -> ms | NaN          ("1h", "30m", "2h30m")
//   parseHatchArgs(argv) -> {forMs, close} | {error}
//
// Open (the default): `--for` defaults to 1 h (DEFAULT_HATCH_MS) and is at most 8 h (MAX_HATCH_MS),
// the watchdog's own bound. In this order: parse the arguments (a bad or too long duration is
// refused before anything else); require a way to write the admin directory; run the gate (`gate()`
// must answer true or {ok: true}; a missing gate refuses); take the integrity manifest: the
// existing baseline when it was never verified (still open, or expired with no valid stamp; see
// carriedBaseline), with only `expires` moved to now + duration, else a fresh one (buildManifest,
// cli/integrity.mjs) for created = now, expires = now + duration; write
// integrity.json, THEN hatch.json ({created, expires}), so a hatch never exists without its
// manifest.
//
// Close (`--close`): ends the open hatch now. The watchdog skips the integrity check while the
// manifest's `expires` is in the future, so closing rewrites integrity.json's `expires` to now
// first (everything else kept as it was), then hatch.json's (which makes it no hatch). With no open
// hatch, nothing is written.
//
// Both files go through `adminWriter(relPath, data)`; the default is adminWrite (admin.mjs: sudo tee
// into the root-owned admin directory, with `run` as the process runner, required then). The CLI
// wiring (T40) passes the gate (sudoGate with the real runner), realRun and requireHuman first.
// `now` is a clock function (default Date.now). No flag or environment variable reaches the clock,
// the gate, the writer or the paths.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { adminWrite } from './admin.mjs';
import { buildManifest, manifestText } from './integrity.mjs';
import { fencePaths } from './paths.mjs';
import { MAX_MANIFEST_BYTES, parseIso, parseManifest, sha256 } from '../watchdog/integrity.mjs';

export const DEFAULT_HATCH_MS = 60 * 60 * 1000;
export const MAX_HATCH_MS = 8 * 60 * 60 * 1000;

const errText = (err) => (err instanceof Error ? err.message : String(err));

export function parseDuration(text) {
  if (typeof text !== 'string') return Number.NaN;
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?$/.exec(text.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return Number.NaN;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000;
}

export function parseHatchArgs(argv = []) {
  let forMs = DEFAULT_HATCH_MS;
  let close = false;
  let given = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let value = null;
    if (a === '--close') {
      close = true;
      continue;
    }
    if (a === '--for') {
      value = argv[++i];
      if (typeof value !== 'string') return { error: '--for needs a duration such as 1h or 30m' };
    } else if (typeof a === 'string' && a.startsWith('--for=')) {
      value = a.slice('--for='.length);
    } else {
      return { error: `unknown argument ${JSON.stringify(String(a))} (usage: fence hatch [--for <duration>] | fence hatch --close)` };
    }
    const ms = parseDuration(value);
    if (!Number.isFinite(ms)) return { error: `--for ${JSON.stringify(value)} is not a duration such as 1h, 30m or 2h30m` };
    if (ms <= 0) return { error: '--for must be longer than zero' };
    if (ms > MAX_HATCH_MS) return { error: `--for ${value} is too long: a hatch lasts at most 8 h` };
    forMs = ms;
    given = true;
  }
  if (close && given) return { error: '--close takes no --for' };
  return { forMs, close };
}

async function passGate(gate) {
  if (typeof gate !== 'function') return 'fence hatch needs fresh sudo authentication, but no sudo gate was given; nothing was written';
  let g;
  try {
    g = await gate();
  } catch (err) {
    g = { ok: false, reason: errText(err) };
  }
  if (g === true || g?.ok === true) return null;
  return `fence hatch needs fresh sudo authentication: ${g?.reason ?? 'the sudo gate refused'}; nothing was written`;
}

// An admin file's text, or null.
function readText(file, fsImpl) {
  try {
    return fsImpl.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The baseline a new hatch must keep, or null for a fresh one. An existing integrity.json that is
// still open, or expired without a valid <state>/verified/<sha256 of its raw bytes> stamp (a regular
// file whose ctime is after its expires: the watchdog compared it clean), was never verified, so its
// `files`, `hookKeys`, `repoRoots` and `created` carry over and only `expires` moves. A missing or
// unparseable manifest, or a verified one, gives a fresh baseline taken now.
function carriedBaseline(admin, stateDir, t, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(nodePath.join(admin, 'integrity.json'));
  } catch {
    return null;
  }
  const manifest = parseManifest(Buffer.from(raw).toString('utf8'));
  if (manifest === null) return null;
  const expires = parseIso(manifest.expires);
  if (expires > t) return manifest;
  try {
    const st = fsImpl.lstatSync(nodePath.join(stateDir, 'verified', sha256(raw)));
    if (st.isFile() && st.ctimeMs > expires) return null;
  } catch {
    // no stamp: never verified
  }
  return manifest;
}

export async function hatch({ argv = [], home, platform = process.platform, now = Date.now, gate, adminWriter, run, adminDir, repoRoots = [], claudeManaged, codexManaged, fs: fsImpl = nodeFs, io } = {}) {
  const say = (s) => {
    if (typeof io?.out === 'function') io.out(s);
  };
  const fail = (reason) => ({ ok: false, reason });
  const args = parseHatchArgs(argv);
  if (args.error) return fail(args.error);

  let paths;
  try {
    paths = fencePaths(home ?? os.homedir(), { platform });
  } catch (err) {
    return fail(errText(err));
  }
  const admin = adminDir ?? paths.adminDir;
  let write = adminWriter;
  if (typeof write !== 'function') {
    if (typeof run !== 'function') return fail('fence hatch: no process runner was given to write the admin directory; nothing was written');
    if (typeof admin !== 'string') return fail('fence hatch: this platform has no admin directory; nothing was written');
    write = (rel, data) => adminWrite(rel, data, { adminDir: admin, run });
  }

  const refused = await passGate(gate);
  if (refused) return fail(refused);
  const t = typeof now === 'function' ? now() : Date.now();
  const at = new Date(t).toISOString();

  if (args.close) {
    if (typeof admin !== 'string') return fail('fence hatch --close: no admin directory to read');
    const hatchText = readText(nodePath.join(admin, 'hatch.json'), fsImpl);
    const manifestRaw = readText(nodePath.join(admin, 'integrity.json'), fsImpl);
    let open = null;
    try {
      open = hatchText === null ? null : JSON.parse(hatchText);
    } catch {
      open = null;
    }
    const manifest = manifestRaw === null ? null : parseManifest(manifestRaw);
    const hatchOpen = open !== null && typeof open === 'object' && parseIso(open.expires) > t;
    const manifestOpen = manifest !== null && parseIso(manifest.expires) > t;
    if (!hatchOpen && !manifestOpen) return fail('no hatch is open; nothing was written');
    let integrityWritten = false;
    try {
      // integrity.json first: its `expires` keys the watchdog's integrity skip
      if (manifestOpen) {
        write('integrity.json', manifestText({ ...manifest, expires: at }));
        integrityWritten = true;
      }
      const created = typeof open?.created === 'string' ? open.created : manifest?.created ?? at;
      write('hatch.json', `${JSON.stringify({ created, expires: at })}\n`);
    } catch (err) {
      if (integrityWritten) {
        return fail(`closing the hatch failed after integrity.json was updated but before hatch.json was: ${errText(err)}; the hatch is still open, run fence hatch --close again`);
      }
      return fail(`closing the hatch failed: ${errText(err)}`);
    }
    say(`The hatch is closed (${at}); fence enforces again. The next call compares the integrity manifest.`);
    return { ok: true, closed: true, expires: at };
  }

  const expires = new Date(t + args.forMs).toISOString();
  let text;
  const carried = typeof admin === 'string' ? carriedBaseline(admin, paths.stateDir, t, fsImpl) : null;
  try {
    const manifest = carried
      ? { ...carried, expires }
      : buildManifest(paths.home, paths, { created: at, expires, repoRoots, platform, claudeManaged, codexManaged, fs: fsImpl });
    text = manifestText(manifest);
  } catch (err) {
    return fail(`${errText(err)}; nothing was written`);
  }
  if (carried) say(`The integrity baseline taken at ${carried.created} is kept: it has not been compared since that hatch.`);
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) return fail(`the integrity manifest is larger than ${MAX_MANIFEST_BYTES} bytes, which the watchdog would refuse; nothing was written`);
  try {
    write('integrity.json', text);
    write('hatch.json', `${JSON.stringify({ created: at, expires })}\n`);
  } catch (err) {
    return fail(`opening the hatch failed: ${errText(err)}`);
  }
  say(`A hatch is open until ${expires}: fence enforces nothing, self-protection included. Close it early with fence hatch --close.`);
  return { ok: true, created: at, expires };
}
