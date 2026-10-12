import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyCliPresent, ownsCliFile } from '../bin/lib/cli-files.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const L = BRAND.legacy;

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cli-files-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const bin = (home, name) => join(home, '.local', 'bin', name);
function put(path, text, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}
const withLine2 = (line) => `#!/usr/bin/env node\n${line}\nbody\n`;

test('a regular file whose line 2 starts with any ownership line, current or legacy, is ours', () => withHome((home) => {
  const lines = [...Object.values(BRAND.ownership), ...Object.values(L.ownership)];
  for (const [i, line] of lines.entries()) {
    const path = bin(home, `file-${i}`);
    put(path, withLine2(line));
    assert.equal(ownsCliFile(path), 'ours', line);
  }
}));

test('the legacy shim carries its marker at the start of a longer line 2: ours', () => withHome((home) => {
  const path = bin(home, L.cliFile);
  put(path, withLine2(`${L.ownership.shim} Run it as ${L.cli} <command>; it forwards to the plugin.`));
  assert.equal(ownsCliFile(path), 'ours');
}));

test('ownership is line 2: a marker on another line, or inside line 2, does not count', () => withHome((home) => {
  const first = bin(home, 'first');
  put(first, `${BRAND.ownership.shim}\n// mine\n`);
  const third = bin(home, 'third');
  put(third, `#!/usr/bin/env node\n// mine\n${BRAND.ownership.shim}\n`);
  const inside = bin(home, 'inside');
  put(inside, withLine2(`// see also ${BRAND.ownership.shim}`));
  for (const path of [first, third, inside]) assert.equal(ownsCliFile(path), 'foreign', path);
}));

test(`a symlink whose text is exactly ${L.cliFile} is ours, as installCli creates it`, () => withHome((home) => {
  const link = bin(home, L.cli);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(L.cliFile, link);
  // The target is missing here: the link's text decides, never its target.
  assert.equal(ownsCliFile(link), 'ours');
}));

test(`a symlink to ${BRAND.cliFile}, to an absolute path or elsewhere is foreign`, () => withHome((home) => {
  put(bin(home, L.cliFile), withLine2(BRAND.ownership.alias));
  const cases = { toTriqual: BRAND.cliFile, absolute: bin(home, L.cliFile), elsewhere: '/usr/bin/true', dotted: `./${L.cliFile}` };
  for (const [name, target] of Object.entries(cases)) {
    const link = bin(home, name);
    symlinkSync(target, link);
    assert.equal(ownsCliFile(link), 'foreign', `${name} -> ${target}`);
  }
}));

test('a foreign file is foreign', () => withHome((home) => {
  const path = bin(home, L.cli);
  put(path, '#!/bin/sh\n# some other tool\nexec other "$@"\n');
  assert.equal(ownsCliFile(path), 'foreign');
}));

test('a file with no line 2, and an empty file, are foreign', () => withHome((home) => {
  const one = bin(home, 'one');
  put(one, '#!/bin/sh');
  const none = bin(home, 'none');
  put(none, '');
  assert.equal(ownsCliFile(one), 'foreign');
  assert.equal(ownsCliFile(none), 'foreign');
}));

test('a directory is foreign', () => withHome((home) => {
  const path = bin(home, L.cli);
  mkdirSync(path, { recursive: true });
  assert.equal(ownsCliFile(path), 'foreign');
}));

test('a file that exists but cannot be read is foreign', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => withHome((home) => {
  const path = bin(home, L.cliFile);
  put(path, withLine2(BRAND.ownership.alias));
  chmodSync(path, 0o000);
  try {
    assert.equal(ownsCliFile(path), 'foreign');
  } finally {
    chmodSync(path, 0o644);
  }
}));

test('a missing path is absent, also under a missing parent', () => withHome((home) => {
  assert.equal(ownsCliFile(bin(home, L.cli)), 'absent');
  assert.equal(ownsCliFile(join(home, 'no', 'such', 'dir', 'file')), 'absent');
}));

test('legacyCliPresent: true when any of the three legacy names is ours', () => withHome((home) => {
  assert.equal(legacyCliPresent(home), false, 'no bin dir');
  const files = {
    [L.cliFile]: withLine2(BRAND.ownership.alias),
    [L.launcher]: `#!/bin/sh\n${BRAND.ownership.forwarder}\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    put(bin(home, name), text);
    assert.equal(legacyCliPresent(home), true, name);
    rmSync(bin(home, name));
    assert.equal(legacyCliPresent(home), false, `${name} removed`);
  }
  symlinkSync(L.cliFile, bin(home, L.cli));
  assert.equal(legacyCliPresent(home), true, `the ${L.cli} link`);
}));

test('legacyCliPresent: foreign files at the three names, and the triqual files, do not make a legacy machine', () => withHome((home) => {
  for (const name of [L.cli, L.cliFile, L.launcher]) put(bin(home, name), '#!/bin/sh\nexec other "$@"\n');
  put(bin(home, BRAND.cliFile), withLine2(BRAND.ownership.shim));
  put(bin(home, BRAND.launcher), `#!/bin/sh\n${BRAND.ownership.launcher}\n`);
  assert.equal(legacyCliPresent(home), false);
  // One of ours next to them is enough.
  put(bin(home, L.launcher), `#!/bin/sh\n${BRAND.ownership.forwarder}\n`);
  assert.equal(legacyCliPresent(home), true);
}));

// Plugins install on their own (spec F.1): nothing the doctor reaches may live outside plugins/methodology/.
test('plugin self-containment: the static import graph of doctor.mjs stays under plugins/methodology/', () => {
  const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  const seen = new Set();
  const queue = [join(PLUGIN_ROOT, 'bin', 'doctor.mjs')];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.')) continue; // node: built-ins and packages
      queue.push(resolve(dirname(file), spec));
    }
  }
  assert.ok(seen.size > 5, 'the walk found the graph');
  assert.ok(seen.has(join(PLUGIN_ROOT, 'bin', 'lib', 'cli-files.mjs')), 'doctor reaches the predicate');
  for (const file of seen) assert.ok(file.startsWith(`${PLUGIN_ROOT}/`), `${file} is outside ${PLUGIN_ROOT}`);
});
