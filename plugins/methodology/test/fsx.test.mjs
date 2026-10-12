import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, statSync, chmodSync,
  existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  realTarget, writeAtomic, backupFile, backupDirFor, sha256, MARKERS,
  readManagedSection, upsertManagedSection, outsideManagedSection,
} from '../bin/lib/fsx.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const S = MARKERS.start;
const E = MARKERS.end;
const N = BRAND.markers;
const L = BRAND.legacy.markers;

function withTmp(fn) {
  // Canonical, so expected paths match what realTarget resolves (macOS tmpdir is itself behind a symlink).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-fsx-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mode = (p) => statSync(p).mode & 0o7777;

test('MARKERS are the exact managed-section markers', () => {
  assert.deepEqual(MARKERS, {
    start: '<!-- triqual:start -->',
    end: '<!-- triqual:end -->',
  });
});

test('realTarget follows a symlink chain and returns a missing path as is', () => {
  withTmp((dir) => {
    const real = join(dir, 'real.md');
    writeFileSync(real, 'x');
    symlinkSync('real.md', join(dir, 'a.md'));
    symlinkSync(join(dir, 'a.md'), join(dir, 'b.md'));
    assert.equal(realTarget(join(dir, 'b.md')), real);
    assert.equal(realTarget(real), real);
    assert.equal(realTarget(join(dir, 'missing.md')), join(dir, 'missing.md'));
  });
});

test('writeAtomic updates a symlinked file in place', () => {
  withTmp((dir) => {
    const real = join(dir, 'real.md');
    const link = join(dir, 'link.md');
    writeFileSync(real, 'old\n');
    symlinkSync('real.md', link);
    writeAtomic(link, 'new\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.deepEqual(readdirSync(dir).sort(), ['link.md', 'real.md']);
  });
});

// home/.claude -> dotfiles/claude, and a relative link in it: the kernel resolves `..` against the real directory
// (home/dotfiles), not lexically against home/.claude.
function dotfilesLayout(dir) {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'dotfiles', 'claude'), { recursive: true });
  mkdirSync(join(home, 'dotfiles', 'common'));
  symlinkSync(join('dotfiles', 'claude'), join(home, '.claude'));
  return home;
}

test('writeAtomic resolves a relative link against the real dir of a symlinked parent', () => {
  withTmp((dir) => {
    const home = dotfilesLayout(dir);
    const real = join(home, 'dotfiles', 'common', 'CLAUDE.md');
    writeFileSync(real, 'old\n');
    symlinkSync(join('..', 'common', 'CLAUDE.md'), join(home, 'dotfiles', 'claude', 'CLAUDE.md'));
    const link = join(home, '.claude', 'CLAUDE.md');
    assert.equal(realTarget(link), real);
    writeAtomic(link, 'new\n');
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(home, 'common')), false);
  });
});

test('writeAtomic through a dangling link under a symlinked parent creates the kernel target', () => {
  withTmp((dir) => {
    const home = dotfilesLayout(dir);
    symlinkSync(join('..', 'common', 'settings.json'), join(home, 'dotfiles', 'claude', 'settings.json'));
    const link = join(home, '.claude', 'settings.json');
    const real = join(home, 'dotfiles', 'common', 'settings.json');
    assert.equal(realTarget(link), real);
    writeAtomic(link, '{}\n');
    assert.equal(readFileSync(real, 'utf8'), '{}\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(home, 'common')), false);
  });
});

test('writeAtomic keeps the file mode', () => {
  withTmp((dir) => {
    const p = join(dir, 'secret.json');
    writeFileSync(p, '{}');
    chmodSync(p, 0o600);
    writeAtomic(p, '{"a":1}');
    assert.equal(mode(p), 0o600);
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
  });
});

test('writeAtomic creates a new file with mode 0644', () => {
  withTmp((dir) => {
    const p = join(dir, 'new.md');
    writeAtomic(p, 'hello');
    assert.equal(readFileSync(p, 'utf8'), 'hello');
    assert.equal(mode(p), 0o644);
  });
});

test('writeAtomic removes its temp file when the rename fails', () => {
  withTmp((dir) => {
    const target = join(dir, 'occupied');
    mkdirSync(join(target, 'child'), { recursive: true });
    assert.throws(() => writeAtomic(target, 'x'));
    assert.deepEqual(readdirSync(dir), ['occupied']);
  });
});

test('backupFile writes 0600 into a 0700 dir', () => {
  withTmp((dir) => {
    const src = join(dir, 'CLAUDE.md');
    writeFileSync(src, 'original');
    chmodSync(src, 0o644);
    const backupDir = join(dir, '.claude', 'backups', 'triqual-20260927-101500');
    const dest = backupFile(src, backupDir);
    assert.equal(dest, join(backupDir, 'CLAUDE.md'));
    assert.equal(readFileSync(dest, 'utf8'), 'original');
    assert.equal(mode(dest), 0o600);
    assert.equal(mode(backupDir), 0o700);
  });
});

test('backupFile returns null for a missing source', () => {
  withTmp((dir) => {
    const backupDir = join(dir, 'b');
    assert.equal(backupFile(join(dir, 'nope.md'), backupDir), null);
  });
});

test('backupFile does not overwrite an existing backup of the same file', () => {
  withTmp((dir) => {
    const src = join(dir, 'settings.json');
    const backupDir = join(dir, 'b');
    writeFileSync(src, 'first');
    const first = backupFile(src, backupDir);
    writeFileSync(src, 'second');
    const again = backupFile(src, backupDir);
    assert.equal(again, first);
    assert.equal(readFileSync(first, 'utf8'), 'first');
  });
});

test('backupDirFor uses local time as YYYYMMDD-HHMMSS', () => {
  const now = new Date(2026, 8, 7, 4, 5, 6);
  assert.equal(
    backupDirFor('/h', now),
    join('/h', '.claude', 'backups', 'triqual-20260907-040506'),
  );
});

test('sha256 returns the hex digest', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('readManagedSection returns the trimmed body, null when absent, and errors', () => {
  assert.deepEqual(readManagedSection(`a\n${S}\n  body  \n${E}\nb`), { body: 'body', error: null });
  assert.deepEqual(readManagedSection('no markers here\n'), { body: null, error: null });
  assert.deepEqual(readManagedSection(`${S}\nx\n`), { body: null, error: 'unterminated' });
  assert.deepEqual(readManagedSection(`${S}\n${S}\n${E}\n`), { body: null, error: 'duplicate' });
  assert.deepEqual(readManagedSection(`${E}\nx\n${S}\n`), { body: null, error: 'misordered' });
});

test('upsertManagedSection on empty input gives created', () => {
  const r = upsertManagedSection('', '\nrules\n');
  assert.equal(r.action, 'created');
  assert.equal(r.text, `${S}\nrules\n${E}\n`);
});

test('upsertManagedSection on text without markers gives appended and keeps the original bytes', () => {
  const original = '# Mine\n\nkeep  this\ttext';
  const r = upsertManagedSection(original, 'rules');
  assert.equal(r.action, 'appended');
  assert.ok(r.text.startsWith(original));
  assert.equal(r.text, `${original}\n\n${S}\nrules\n${E}\n`);
  const withNewline = '# Mine\n';
  const r2 = upsertManagedSection(withNewline, 'rules');
  assert.equal(r2.text, `${withNewline}\n${S}\nrules\n${E}\n`);
  assert.equal(readManagedSection(r.text).body, 'rules');
});

test('upsertManagedSection with a different body gives updated and leaves outside text unchanged', () => {
  const before = '# Mine\nabove\n\n';
  const after = '\nbelow\n';
  const text = `${before}${S}\nold rules\n${E}${after}`;
  const r = upsertManagedSection(text, '  new rules \n');
  assert.equal(r.action, 'updated');
  assert.equal(r.text, `${before}${S}\nnew rules\n${E}${after}`);
});

test('upsertManagedSection with the same body gives unchanged', () => {
  const text = `x\n${S}\n\nrules\n\n${E}\ny`;
  const r = upsertManagedSection(text, 'rules\n');
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, text);
});

test('upsertManagedSection refuses a start marker without an end marker', () => {
  assert.throws(() => upsertManagedSection(`x\n${S}\nrules\n`, 'rules'), /unterminated/);
});

test('upsertManagedSection refuses two start markers', () => {
  assert.throws(() => upsertManagedSection(`${S}\na\n${S}\nb\n${E}\n`, 'rules'), /duplicate/);
});

test('upsertManagedSection refuses an end marker before the start marker', () => {
  assert.throws(() => upsertManagedSection(`${E}\na\n${S}\n`, 'rules'), /misordered/);
});

test('outsideManagedSection strips only the managed section', () => {
  const text = `# Mine\nabove\n\n${S}\n## Rules\nbody\n${E}\nbelow\n`;
  assert.equal(outsideManagedSection(text), '# Mine\nabove\n\n\nbelow\n');
  assert.equal(outsideManagedSection('plain\n'), 'plain\n');
});

test('legacy section is replaced in place', () => {
  const text = `A\n${L.start}\nold\n${L.end}\nB\n`;
  assert.deepEqual(readManagedSection(text), { body: 'old', error: null });
  for (const body of ['rules', 'old']) {
    const r = upsertManagedSection(text, body);
    assert.equal(r.action, 'replaced', body);
    assert.equal(r.text.split(N.start).length - 1, 1, body);
    assert.ok(!r.text.includes(L.start) && !r.text.includes(L.end), body);
    assert.equal(r.text, `A\n${N.start}\n${body}\n${N.end}\nB\n`, body);
  }
});

test('outsideManagedSection skips a legacy section', () => {
  const text = `# Mine\nabove\n\n${L.start}\n## Rules\nbody\n${L.end}\nbelow\n`;
  assert.equal(outsideManagedSection(text), '# Mine\nabove\n\n\nbelow\n');
});

test('legacy plus new section is duplicate', () => {
  const legacy = `${L.start}\nold\n${L.end}\n`;
  const current = `${N.start}\nnew\n${N.end}\n`;
  for (const text of [`${legacy}${current}`, `${current}x\n${legacy}`]) {
    assert.deepEqual(readManagedSection(text), { body: null, error: 'duplicate' });
    assert.throws(() => upsertManagedSection(text, 'rules'), /duplicate/);
    assert.throws(() => outsideManagedSection(text), /duplicate/);
  }
});

test('a malformed legacy section is refused like a new one', () => {
  assert.deepEqual(readManagedSection(`x\n${L.start}\nold\n`), { body: null, error: 'unterminated' });
  assert.throws(() => upsertManagedSection(`${L.end}\nold\n${L.start}\n`, 'rules'), /misordered/);
});
