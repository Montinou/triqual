// The admin directory writer (spec, "Layout / Installed state"): root-owned, mode 0755 directories
// and 0644 files holding hatch.json, integrity.json and grants/. Only the sudo-gated CLI writes it.
//
// adminWrite never stages the data anywhere the user can write. Every step runs as root, inside the
// root-owned admin directory, with each program named by its absolute path from COMMANDS
// (humanonly.mjs):
//   sudo install -d -m 0755 -o root -g 0 <dir>      for each directory down to the target's parent
//   sudo tee <target>.tmp                            the data arrives on sudo's stdin (`input`)
//   sudo chmod 0644 <target>.tmp
//   sudo chown root:0 <target>.tmp
//   sudo mv -f <target>.tmp <target>                 a rename inside the same directory
// A failure after the temp file may exist removes it (sudo rm -f) and throws. A target that is a
// directory or a symlink is refused before any sudo call (mv would move the file into it).
//
// `relPath` must stay inside the admin directory: no absolute path, no `..`, `.` or empty segment, no
// segment starting with `-`, no NUL, newline or backslash. `adminDir` and `run` are required: the
// CLI wiring passes adminDir(process.platform) and realRun (sudo.mjs); tests pass a temp directory and
// a fake runner. `sudoPath` is for unit tests only (the CLI never passes it, so SUDO is used).

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { COMMANDS, SUDO } from './humanonly.mjs';

const ADMIN_DIRS = Object.freeze({
  darwin: '/Library/Application Support/fence/',
  linux: '/var/lib/fence/',
});

export function adminDir(platform) {
  const dir = ADMIN_DIRS[platform];
  if (!dir) throw new Error(`no admin directory for platform ${JSON.stringify(platform)}`);
  return dir;
}

const BAD_CHARS = /[\0\r\n\\]/;

// -> the segments of a safe relative path, or throws.
function segments(relPath) {
  if (typeof relPath !== 'string' || relPath === '') throw new Error('invalid admin path: empty');
  if (BAD_CHARS.test(relPath)) throw new Error('invalid admin path: contains NUL, a newline or a backslash');
  if (nodePath.isAbsolute(relPath)) throw new Error(`invalid admin path: ${JSON.stringify(relPath)} is absolute`);
  const segs = relPath.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || s.startsWith('-')) {
      throw new Error(`invalid admin path: ${JSON.stringify(relPath)}`);
    }
  }
  return segs;
}

// Is the target a directory, or a symlink (to anything: a dangling one may become a directory)?
// The admin directory is world-readable, so lstat works without sudo; a missing target is fine.
function isDirectoryTarget(target) {
  let st;
  try {
    st = nodeFs.lstatSync(target);
  } catch {
    return false;
  }
  return st.isDirectory() || st.isSymbolicLink();
}

function check(r, what) {
  if (r && !r.error && r.status === 0) return;
  const detail = r?.error ? r.error.message : `exit ${r?.status}${r?.stderr ? `: ${String(r.stderr).trim()}` : ''}`;
  throw new Error(`sudo ${what} failed (${detail})`);
}

export function adminWrite(relPath, data, { adminDir: base, run, sudoPath = SUDO } = {}) {
  if (typeof run !== 'function') throw new Error('adminWrite: no process runner was given');
  const segs = segments(relPath);
  if (typeof base !== 'string' || !nodePath.isAbsolute(base) || BAD_CHARS.test(base)) {
    throw new Error('invalid admin path: the admin directory must be an absolute path');
  }
  const root = nodePath.resolve(base);
  const target = nodePath.join(root, ...segs);
  if (!target.startsWith(root + nodePath.sep)) throw new Error(`invalid admin path: ${JSON.stringify(relPath)} leaves the admin directory`);
  const tmp = `${target}.tmp`;
  // `mv -f tmp target` would move the file INTO a directory (or a link to one) at the target
  if (isDirectoryTarget(target)) throw new Error(`invalid admin path: ${JSON.stringify(relPath)} is a directory or a symlink; nothing was written`);

  const dirs = [root];
  for (const s of segs.slice(0, -1)) dirs.push(nodePath.join(dirs.at(-1), s));
  for (const d of dirs) check(run(sudoPath, [COMMANDS.install, '-d', '-m', '0755', '-o', 'root', '-g', '0', d]), `install -d ${d}`);

  try {
    check(run(sudoPath, [COMMANDS.tee, tmp], { input: data }), `tee ${tmp}`);
    check(run(sudoPath, [COMMANDS.chmod, '0644', tmp]), `chmod ${tmp}`);
    check(run(sudoPath, [COMMANDS.chown, 'root:0', tmp]), `chown ${tmp}`);
    check(run(sudoPath, [COMMANDS.mv, '-f', tmp, target]), `mv ${target}`);
  } catch (err) {
    try {
      run(sudoPath, [COMMANDS.rm, '-f', tmp]);
    } catch {
      // best effort: the original failure is the one reported
    }
    throw err;
  }
  return { path: target };
}
