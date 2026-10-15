// The one rule for "is this file in ~/.local/bin ours", shared by bootstrap's shim step, doctor, the migration and the
// legacy scan, so they cannot disagree on a foreign `cm`. Only node: built-ins and brand.mjs: a plugin installs on
// its own and never imports from bin/ or another plugin.
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.mjs';

// Line 2 of every CLI file we install, current and legacy.
const OWNERSHIP = [...Object.values(BRAND.ownership), ...Object.values(BRAND.legacy.ownership)];

// 'ours' for a regular file whose line 2 starts with one of the ownership lines (the legacy shim's line 2 goes on after
// its marker), or a symlink whose text is exactly the legacy CLI file, as bootstrap creates it; 'absent' when nothing
// is at `path` (a dangling link is not absent); else 'foreign', a path that exists but cannot be read included.
export function ownsCliFile(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'absent' : 'foreign';
  }
  try {
    if (info.isSymbolicLink()) return readlinkSync(path) === BRAND.legacy.cliFile ? 'ours' : 'foreign';
    if (!info.isFile()) return 'foreign';
    const line2 = readFileSync(path, 'utf8').split('\n')[1] ?? '';
    return OWNERSHIP.some((o) => line2.startsWith(o)) ? 'ours' : 'foreign';
  } catch {
    return 'foreign';
  }
}

// Whether any of the three legacy names in <home>/.local/bin (the CLI link, its file and the launcher) is ours: only such a machine had callers of the legacy names,
// so only there are the alias and the forwarder installed, checked and scanned. On any other, a file at those names
// belongs to someone else and is left alone.
export function legacyCliPresent(home) {
  const { cli, cliFile, launcher } = BRAND.legacy;
  return [cli, cliFile, launcher].some((name) => ownsCliFile(join(home, '.local', 'bin', name)) === 'ours');
}
