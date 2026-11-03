// The plan reader reads every fixture plan as it did on main: later tasks add keys to the reader output, and this
// test ignores them, so a change to an existing key shows up here and nothing else does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTasks, readPhases } from '../lib/plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const PLUGINS = join(ROOT, 'plugins');
const RECORDED = JSON.parse(readFileSync(join(HERE, 'fixtures', 'plan-compat.json'), 'utf8'));
const NEW_KEYS = new Set(['forest', 'landingTest', 'parent', 'parentDeclared', 'validate', 'files']);

const walk = (dir) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const fixtures = readdirSync(PLUGINS).sort()
  .map((plugin) => join(PLUGINS, plugin, 'test', 'fixtures'))
  .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
  .flatMap(walk)
  .filter((path) => path.endsWith('.md'))
  .map((path) => relative(ROOT, path));

// A deep copy without the keys later tasks add; `undefined` values vanish as they do in the recorded JSON.
const withoutNewKeys = (value) => JSON.parse(JSON.stringify(value, (key, v) => (NEW_KEYS.has(key) ? undefined : v)));

test('plan-compat: every fixture plan reads as on main (new keys ignored)', async (t) => {
  assert.ok(fixtures.length > 0, 'no fixture plans found');
  for (const path of fixtures) {
    await t.test(path, () => {
      const text = readFileSync(join(ROOT, path), 'utf8');
      const recorded = RECORDED[path];
      if (!recorded) {
        // Not recorded means readTasks rejected it when the file was recorded: it must still reject it.
        assert.throws(() => readTasks(text), `${path} is not in plan-compat.json and the reader accepts it: record it`);
        return;
      }
      assert.deepEqual(withoutNewKeys(readTasks(text)), recorded.tasks);
      assert.deepEqual(withoutNewKeys(readPhases(text, basename(path, '.md'))), recorded.phases);
    });
  }
  for (const path of Object.keys(RECORDED)) {
    assert.ok(fixtures.includes(path), `plan-compat.json records ${path}, which is not a fixture plan`);
  }
});
