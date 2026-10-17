import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { foldCase, isCaseInsensitive, resolvePath } from '../src/resolve/paths.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// Every fixture lives under one temp dir; `REAL` is its realpath (on macOS /var is a link to
// /private/var, so the temp dir itself is reached through a symlink).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-resolve-'));
const REAL = fs.realpathSync.native(TMP);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function mk(rel) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const HOME = mk('home');
const REAL_HOME = path.join(REAL, 'home');

test('resolves a symlinked directory to its target', () => {
  mk('t1/target/sub');
  fs.symlinkSync(path.join(TMP, 't1/target'), path.join(TMP, 't1/link'));
  assert.equal(resolvePath(path.join(TMP, 't1/link'), '/', HOME), path.join(REAL, 't1/target'));
  assert.equal(resolvePath(path.join(TMP, 't1/link/sub'), '/', HOME), path.join(REAL, 't1/target/sub'));
  // the temp dir itself, named through whatever links lead to it
  assert.equal(resolvePath(TMP, '/', HOME), REAL);
});

test('a missing file resolves through its existing parent\'s realpath', () => {
  mk('t2/target');
  fs.symlinkSync(path.join(TMP, 't2/target'), path.join(TMP, 't2/link'));
  assert.equal(resolvePath(path.join(TMP, 't2/link/new.txt'), '/', HOME), path.join(REAL, 't2/target/new.txt'));
  assert.equal(
    resolvePath(path.join(TMP, 't2/link/a/b/c.json'), '/', HOME),
    path.join(REAL, 't2/target/a/b/c.json'),
  );
});

test('a dangling symlink resolves to where it points, never to the link itself', () => {
  mk('t2b/protected');
  // the link exists, its target does not: a write through it creates the target
  fs.symlinkSync(path.join(TMP, 't2b/protected/settings.json'), path.join(TMP, 't2b/dangling'));
  assert.equal(
    resolvePath(path.join(TMP, 't2b/dangling'), '/', HOME),
    path.join(REAL, 't2b/protected/settings.json'),
  );
  // relative link target, and a dangling link to a missing directory with a tail
  fs.symlinkSync('protected/newdir', path.join(TMP, 't2b/rel'));
  assert.equal(
    resolvePath(path.join(TMP, 't2b/rel/x.txt'), '/', HOME),
    path.join(REAL, 't2b/protected/newdir/x.txt'),
  );
});

test('dot-dot segments collapse after symlink resolution', () => {
  mk('t3/deep/inner');
  mk('t3/a');
  // a/link -> deep/inner, so a/link/.. is deep, not a. Paths are concatenated, not
  // path.join-ed: path.join would collapse `..` lexically before the resolver saw it.
  fs.symlinkSync(path.join(TMP, 't3/deep/inner'), path.join(TMP, 't3/a/link'));
  mk('t3/deep/b');
  assert.equal(resolvePath(`${TMP}/t3/a/link/../b`, '/', HOME), path.join(REAL, 't3/deep/b'));
  // the same with a missing final component
  assert.equal(
    resolvePath(`${TMP}/t3/a/link/../missing.txt`, '/', HOME),
    path.join(REAL, 't3/deep/missing.txt'),
  );
  // relative form through the cwd
  assert.equal(resolvePath('link/../b', path.join(TMP, 't3/a'), HOME), path.join(REAL, 't3/deep/b'));
  // `..` after a missing component is re-resolved, so a link reached that way is followed
  fs.symlinkSync(path.join(TMP, 't3/deep'), path.join(TMP, 't3/a/link2'));
  assert.equal(
    resolvePath(`${TMP}/t3/a/nope/../link2/b`, '/', HOME),
    path.join(REAL, 't3/deep/b'),
  );
});

test('relative paths resolve from the given cwd and never process.cwd()', () => {
  mk('t4/work/src');
  const cwd = path.join(TMP, 't4/work');
  assert.notEqual(process.cwd(), cwd);
  assert.equal(resolvePath('src', cwd, HOME), path.join(REAL, 't4/work/src'));
  assert.equal(resolvePath('./src/new.mjs', cwd, HOME), path.join(REAL, 't4/work/src/new.mjs'));
  assert.equal(resolvePath('..', cwd, HOME), path.join(REAL, 't4'));
  assert.equal(resolvePath('.', cwd, HOME), path.join(REAL, 't4/work'));
  // a relative cwd is not resolved against process.cwd()
  assert.equal(resolvePath('src', 't4/work', HOME), UNKNOWN);
});

test('tilde expands', () => {
  mk('home/.claude');
  assert.equal(resolvePath('~', '/', HOME), REAL_HOME);
  assert.equal(resolvePath('~/.claude', '/', HOME), path.join(REAL_HOME, '.claude'));
  assert.equal(resolvePath('~/.claude/settings.json', '/', HOME), path.join(REAL_HOME, '.claude/settings.json'));
  // only `~` and `~/`: other users' homes, and `~` in the middle, are not expanded
  assert.equal(resolvePath('~root/.ssh', '/', HOME), UNKNOWN);
  assert.equal(resolvePath('~+', '/', HOME), UNKNOWN);
  assert.equal(resolvePath('a/~/b', path.join(TMP, 't4'), HOME), path.join(REAL, 't4/a/~/b'));
  // no usable home
  assert.equal(resolvePath('~/x', '/', ''), UNKNOWN);
  assert.equal(resolvePath('~/x', '/', 'relative/home'), UNKNOWN);
});

test('invalid input and unresolvable prefixes return UNKNOWN without throwing', () => {
  assert.equal(resolvePath('', '/', HOME), UNKNOWN);
  assert.equal(resolvePath(undefined, '/', HOME), UNKNOWN);
  assert.equal(resolvePath(UNKNOWN, '/', HOME), UNKNOWN);
  assert.equal(resolvePath('a\0b', REAL, HOME), UNKNOWN);
  assert.equal(resolvePath('x', 'a\0b', HOME), UNKNOWN);
  // a symlink loop
  mk('t5');
  fs.symlinkSync(path.join(TMP, 't5/l2'), path.join(TMP, 't5/l1'));
  fs.symlinkSync(path.join(TMP, 't5/l1'), path.join(TMP, 't5/l2'));
  assert.equal(resolvePath(path.join(TMP, 't5/l1/x'), '/', HOME), UNKNOWN);
  // an error other than "does not exist" on the existing prefix
  for (const code of ['EACCES', 'ENAMETOOLONG', 'ELOOP', 'EIO']) {
    const fake = {
      realpathSync: {
        native() {
          throw Object.assign(new Error(code), { code });
        },
      },
      lstatSync() {
        throw Object.assign(new Error(code), { code });
      },
      readlinkSync() {
        throw Object.assign(new Error(code), { code });
      },
    };
    assert.equal(resolvePath('/a/b', '/', HOME, fake), UNKNOWN, code);
  }
});

test('a link to a file resolves to the file; a path under it keeps the rest lexically', () => {
  mk('t7');
  fs.writeFileSync(path.join(TMP, 't7/file.txt'), 'x');
  fs.symlinkSync(path.join(TMP, 't7/file.txt'), path.join(TMP, 't7/flink'));
  assert.equal(resolvePath(path.join(TMP, 't7/flink'), '/', HOME), path.join(REAL, 't7/file.txt'));
  assert.equal(resolvePath(path.join(TMP, 't7/flink/child'), '/', HOME), path.join(REAL, 't7/file.txt/child'));
});

test('a chain of dangling links is followed to its end', () => {
  mk('t8/protected');
  // d1 -> d2 (relative) -> d3 (absolute) -> protected/new.json (missing)
  fs.symlinkSync(path.join(TMP, 't8/protected/new.json'), path.join(TMP, 't8/d3'));
  fs.symlinkSync(path.join(TMP, 't8/d3'), path.join(TMP, 't8/d2'));
  fs.symlinkSync('d2', path.join(TMP, 't8/d1'));
  assert.equal(resolvePath(path.join(TMP, 't8/d1'), '/', HOME), path.join(REAL, 't8/protected/new.json'));
});

test('a trailing slash is dropped', () => {
  mk('t9/dir');
  fs.symlinkSync(path.join(TMP, 't9/dir'), path.join(TMP, 't9/dlink'));
  assert.equal(resolvePath(`${TMP}/t9/dlink/`, '/', HOME), path.join(REAL, 't9/dir'));
  assert.equal(resolvePath('missing/', path.join(TMP, 't9'), HOME), path.join(REAL, 't9/missing'));
  assert.equal(resolvePath('/', '/', HOME), fs.realpathSync.native('/'));
});

test('a file used as a directory keeps the rest lexically', () => {
  mk('t6');
  fs.writeFileSync(path.join(TMP, 't6/file'), 'x');
  assert.equal(resolvePath(path.join(TMP, 't6/file/child'), '/', HOME), path.join(REAL, 't6/file/child'));
});

// A fake fs for the case probe: `entries` maps a path to {dev, ino}; anything else is ENOENT.
function probeFs(entries, overrides = {}) {
  const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const stat = (p) => {
    if (!(p in entries)) throw enoent(p);
    return { ...entries[p], isDirectory: () => true };
  };
  return {
    statSync: stat,
    lstatSync: stat,
    realpathSync: { native: (p) => (p in entries ? p : (() => { throw enoent(p); })()) },
    readdirSync: () => [],
    ...overrides,
  };
}

test('case-insensitive detection true when the probe exists', () => {
  const fake = probeFs({ '/Vol': { dev: 7, ino: 2 }, '/Vol/Projects': { dev: 7, ino: 10 }, '/Vol/pROJECTS': { dev: 7, ino: 10 } });
  assert.equal(isCaseInsensitive('/Vol/Projects', fake), true);

  // the flipped name is missing: case-sensitive
  const sensitive = probeFs({ '/Data': { dev: 8, ino: 2 }, '/Data/Projects': { dev: 8, ino: 10 } });
  assert.equal(isCaseInsensitive('/Data/Projects', sensitive), false);

  // the flipped name is a different file: case-sensitive
  const distinct = probeFs({
    '/Disk': { dev: 9, ino: 2 },
    '/Disk/Projects': { dev: 9, ino: 10 },
    '/Disk/pROJECTS': { dev: 9, ino: 11 },
  });
  assert.equal(isCaseInsensitive('/Disk/Projects', distinct), false);

  // the result is cached per volume: a second directory on device 8 is not probed again
  const calls = [];
  const known = {
    '/': { dev: 1, ino: 1 },
    '/Data': { dev: 8, ino: 2 },
    '/Data/one': { dev: 8, ino: 12 },
    '/Data/two': { dev: 8, ino: 13 },
  };
  const counting = probeFs(known, {
    statSync(p) {
      calls.push(p);
      if (p in known) return { ...known[p], isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(isCaseInsensitive('/Data/one', counting), false);
  assert.deepEqual(calls, ['/Data/one', '/Data', '/Data/ONE']);
  calls.length = 0;
  assert.equal(isCaseInsensitive('/Data/two', counting), false);
  // only the stat that reads the device id: the flipped name /Data/TWO is never probed
  assert.deepEqual(calls, ['/Data/two']);
});

test('case probe never flips a name across a mount point or a symlink to another volume', () => {
  // /mnt is on device 1 (case-sensitive), /mnt/c is a case-insensitive volume (device 9) mounted
  // there: flipping `c` inside /mnt would test device 1 and must not decide device 9.
  const mounted = {
    '/': { dev: 1, ino: 1 },
    '/mnt': { dev: 1, ino: 2 },
    '/mnt/c': { dev: 9, ino: 5 },
    '/mnt/c/Proj': { dev: 9, ino: 6 },
    '/mnt/c/pROJ': { dev: 9, ino: 6 },
  };
  // no usable child: inconclusive, fail closed, nothing cached
  const empty = probeFs(mounted);
  assert.equal(isCaseInsensitive('/mnt/c', empty), true);
  assert.equal(isCaseInsensitive('/mnt/c/Proj', empty), true);
  // with a child entry the probe is made inside device 9 and is conclusive
  const withChild = probeFs(mounted, { readdirSync: (p) => (p === '/mnt/c' ? ['Proj'] : []) });
  assert.equal(isCaseInsensitive('/mnt/c', withChild), true);
  assert.equal(isCaseInsensitive('/mnt/c/Proj', withChild), true);

  // a symlinked directory: stat follows /home/link to device 9, its parent is on device 1
  const linked = probeFs({ '/': { dev: 1, ino: 1 }, '/home': { dev: 1, ino: 2 }, '/home/link': { dev: 9, ino: 5 } });
  assert.equal(isCaseInsensitive('/home/link', linked), true);
});

test('case-insensitive detection fails closed when the probe is inconclusive', () => {
  // the directory does not exist
  assert.equal(isCaseInsensitive('/nowhere', probeFs({})), true);
  // no cased letter anywhere on the path or among its children
  assert.equal(isCaseInsensitive('/123', probeFs({ '/123': { dev: 20, ino: 3 } })), true);
  // the probe fails with an error other than ENOENT
  const eacces = probeFs(
    { '/Acc': { dev: 21, ino: 3 } },
    {
      statSync(p) {
        if (p === '/Acc') return { dev: 21, ino: 3, isDirectory: () => true };
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
  );
  assert.equal(isCaseInsensitive('/Acc', eacces), true);
  assert.equal(isCaseInsensitive(UNKNOWN, probeFs({})), true);
  // a real temp dir gives a boolean without throwing
  assert.equal(typeof isCaseInsensitive(TMP), 'boolean');
});

test('foldCase lowercases only when insensitive', () => {
  assert.equal(foldCase('/Vol/Data/.Claude', true), '/vol/data/.claude');
  assert.equal(foldCase('/Vol/Data/.Claude', false), '/Vol/Data/.Claude');
  // NFD input folds to the NFC form on an insensitive volume
  const nfd = '/x/Café';
  assert.equal(foldCase(nfd, true), '/x/café');
  assert.equal(foldCase(nfd, false), nfd);
  assert.equal(foldCase(UNKNOWN, true), UNKNOWN);
});

test('foldCase applies full case folding as an insensitive volume does', () => {
  // U+017F LATIN SMALL LETTER LONG S opens `s`, U+FB00 LATIN SMALL LIGATURE FF opens `ff`,
  // U+212A KELVIN SIGN opens `k`
  assert.equal(foldCase('/\u017Fettings.local.json', true), foldCase('/settings.local.json', true));
  assert.equal(foldCase('/\uFB00x', true), foldCase('/ffx', true));
  assert.equal(foldCase('/\u212Ax', true), foldCase('/kx', true));
  assert.equal(foldCase('/\u017Fx', false), '/\u017Fx');
});
