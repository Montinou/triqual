import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, statSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editSettings, readMethodologyConfig, setHarnessEnabled, supersededEnabled } from '../cli/lib/settings.mjs';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-settings-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('editSettings leaves invalid JSON byte-identical and throws', () => {
  withTmp((dir) => {
    const p = join(dir, 'settings.json');
    const bad = '{ "a": 1,, }\n';
    writeFileSync(p, bad);
    const backupDir = join(dir, 'backups');
    assert.throws(
      () => editSettings(p, (o) => { o.b = 2; }, { backupDir }),
      { message: `settings.json is not valid JSON: ${p}` },
    );
    assert.equal(readFileSync(p, 'utf8'), bad);
    assert.equal(existsSync(backupDir), false);
    assert.deepEqual(readdirSync(dir), ['settings.json']);
  });
});

test('editSettings reports changed:false and writes nothing when mutate is a no-op', () => {
  withTmp((dir) => {
    const p = join(dir, 'settings.json');
    const original = '{"a":{"b":[1,2]}}';
    writeFileSync(p, original);
    const past = new Date(Date.now() - 60_000);
    utimesSync(p, past, past);
    const mtimeBefore = statSync(p).mtimeMs;
    const backupDir = join(dir, 'backups');
    const r = editSettings(p, (o) => { o.a.b = [1, 2]; }, { backupDir });
    assert.deepEqual(r, { changed: false });
    assert.equal(statSync(p).mtimeMs, mtimeBefore);
    assert.equal(readFileSync(p, 'utf8'), original);
    assert.equal(existsSync(backupDir), false);
  });
});

test('editSettings writes through a symlinked settings.json', () => {
  withTmp((dir) => {
    const real = join(dir, 'real-settings.json');
    const link = join(dir, 'settings.json');
    writeFileSync(real, '{"a":1}');
    symlinkSync('real-settings.json', link);
    const r = editSettings(link, (o) => { o.b = true; }, { backupDir: join(dir, 'backups') });
    assert.deepEqual(r, { changed: true });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(real, 'utf8'), JSON.stringify({ a: 1, b: true }, null, 2) + '\n');
  });
});

test('editSettings backs up before the first write', () => {
  withTmp((dir) => {
    const p = join(dir, 'settings.json');
    const original = '{"language":"spanish"}';
    writeFileSync(p, original);
    const backupDir = join(dir, 'backups');
    editSettings(p, (o) => { delete o.language; }, { backupDir });
    assert.equal(readFileSync(join(backupDir, 'settings.json'), 'utf8'), original);
    assert.equal(statSync(join(backupDir, 'settings.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(p, 'utf8'), '{}\n');
  });
});

test('editSettings backs up at most once per backupDir', () => {
  withTmp((dir) => {
    const p = join(dir, 'settings.json');
    const original = '{"a":1}';
    writeFileSync(p, original);
    const backupDir = join(dir, 'backups');
    editSettings(p, (o) => { o.a = 2; }, { backupDir });
    editSettings(p, (o) => { o.a = 3; }, { backupDir });
    assert.deepEqual(readdirSync(backupDir), ['settings.json']);
    assert.equal(readFileSync(join(backupDir, 'settings.json'), 'utf8'), original);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 3 });
  });
});

test('supersededEnabled matches <name>@* against any marketplace and any other pattern exactly', () => {
  const enabled = {
    'superpowers@superpowers-marketplace': true,
    'superpowers@claude-plugins-official': true,
    'superpowers@disabled-market': false,
    'superpowers-lab@superpowers-marketplace': true,
    'other@m': true,
    'exact@m': true,
  };
  assert.deepEqual(supersededEnabled(['superpowers@*'], enabled),
    ['superpowers@superpowers-marketplace', 'superpowers@claude-plugins-official']);
  assert.deepEqual(supersededEnabled(['exact@m', 'exact@other'], enabled), ['exact@m']);
  assert.deepEqual(supersededEnabled(['superpowers@*', 'other@m'], enabled),
    ['superpowers@superpowers-marketplace', 'superpowers@claude-plugins-official', 'other@m']);
  assert.deepEqual(supersededEnabled([], enabled), []);
  for (const none of [undefined, null, [], 'x']) assert.deepEqual(supersededEnabled(['superpowers@*'], none), []);
});

test('readMethodologyConfig reads keepSuperseded from <home>/.config/triqual/config.json', () => {
  withTmp((home) => {
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: false, harnesses: {}, error: null });
    const dir = join(home, '.config', 'triqual');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ keepSuperseded: true, skillSuggest: { enabled: true } }));
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: true, harnesses: {}, error: null });
    writeFileSync(path, JSON.stringify({ keepSuperseded: 'yes' }));
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: false, harnesses: {}, error: null });
    writeFileSync(path, JSON.stringify({ skillSuggest: {} }));
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: false, harnesses: {}, error: null });
    writeFileSync(path, '{ "keepSuperseded": true,, }');
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: false, harnesses: {}, error: `${path} is not valid JSON` });
    writeFileSync(path, '[true]');
    assert.deepEqual(readMethodologyConfig(home), { keepSuperseded: false, harnesses: {}, error: `${path} is not a JSON object` });
    rmSync(path);
    mkdirSync(path); // a directory: reading it fails with EISDIR, not ENOENT
    const r = readMethodologyConfig(home);
    assert.equal(r.keepSuperseded, false);
    assert.ok(r.error.startsWith(`cannot read ${path}: `), r.error);
    assert.deepEqual(r.harnesses, {});
  });
});

test('readMethodologyConfig returns the recorded harnesses map', () => {
  withTmp((home) => {
    const dir = join(home, '.config', 'triqual');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ harnesses: { codex: { enabled: true } } }));
    assert.deepEqual(readMethodologyConfig(home),
      { keepSuperseded: false, harnesses: { codex: { enabled: true } }, error: null });
    for (const junk of [[], 'codex', null, 3]) {
      writeFileSync(path, JSON.stringify({ harnesses: junk }));
      assert.deepEqual(readMethodologyConfig(home).harnesses, {}, JSON.stringify(junk));
    }
  });
});

test('setHarnessEnabled records the flag and keeps the other config.json keys', () => {
  withTmp((home) => {
    const dir = join(home, '.config', 'triqual');
    const path = join(dir, 'config.json');
    // A missing file (and dir) is created.
    setHarnessEnabled(home, 'grok', true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { harnesses: { grok: { enabled: true } } });
    writeFileSync(path, JSON.stringify({
      keepSuperseded: true, skillSuggest: { enabled: true }, harnesses: { grok: { enabled: true, note: 'x' } },
    }));
    setHarnessEnabled(home, 'codex', true);
    setHarnessEnabled(home, 'grok', false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      keepSuperseded: true,
      skillSuggest: { enabled: true },
      harnesses: { grok: { enabled: false, note: 'x' }, codex: { enabled: true } },
    });
    assert.deepEqual(readdirSync(dir), ['config.json'], 'written atomically, no temp file left');
    // An unreadable config.json is never overwritten.
    writeFileSync(path, '{ "keepSuperseded": true,, }');
    assert.throws(() => setHarnessEnabled(home, 'codex', true), /not valid JSON/);
    assert.equal(readFileSync(path, 'utf8'), '{ "keepSuperseded": true,, }');
    assert.throws(() => setHarnessEnabled(home, 'bogus', true), /unknown harness/);
  });
});

test('supersededEnabled ignores non-string patterns and a non-array pattern list', () => {
  const enabled = { 'superpowers@superpowers-marketplace': true, 'other@m': true };
  assert.deepEqual(supersededEnabled([null, 3, {}, ['x'], 'superpowers@*'], enabled), ['superpowers@superpowers-marketplace']);
  for (const patterns of ['superpowers@*', null, undefined, {}]) assert.deepEqual(supersededEnabled(patterns, enabled), []);
});
