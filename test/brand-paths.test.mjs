// The config, state and share paths and the runtime env variables go through the brand fallbacks (brandDir, readEnv):
// a machine keeps reading the legacy dirs and CM_* variables until migration moves them, and a fresh machine starts
// under the triqual dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../plugins/methodology/bin/lib/brand.mjs';
import { configPath } from '../plugins/methodology/bin/lib/settings.mjs';
import { manifestPath } from '../plugins/methodology/bin/lib/harness-manifest.mjs';
import { registerRepo, registryPath } from '../plugins/progress-tracking/lib/registry.mjs';
import { withLock } from '../plugins/progress-tracking/lib/lock.mjs';
import { resolvePaths } from '../plugins/memory-report/lib/config.mjs';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ENV_KEYS = [
  'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_LOCK_TIMEOUT_MS', 'CM_LOCK_TIMEOUT_MS', 'TRIQUAL_LOCK_STALE_MS',
  'CM_LOCK_STALE_MS',
];
for (const k of ENV_KEYS) delete process.env[k]; // every test starts from the defaults

// Runs fn with the given variables set (deleted when undefined), then restores them.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  for (const [k, v] of Object.entries(vars)) put(k, v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) put(k, v);
  }
}

// A temp dir holding `home/` and a plain `root/` directory to register; removed afterwards.
function withHome(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brand-paths-')));
  const home = join(dir, 'home');
  const root = join(dir, 'root');
  mkdirSync(home);
  mkdirSync(root);
  try {
    return fn({ dir, home, root });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a home with only the legacy config dir keeps every config file under it', () => withHome(({ home }) => {
  const legacy = join(home, '.config', BRAND.legacy.dir);
  mkdirSync(legacy, { recursive: true });
  assert.equal(configPath(home), join(legacy, 'config.json'));
  assert.equal(manifestPath(home), join(legacy, 'harnesses.json'));
  assert.equal(registryPath(home), join(legacy, 'repos.json'));
  assert.equal(resolvePaths({}, home).configFile, join(legacy, 'memory-report.json'));
}));

test('a home with neither dir resolves under triqual, and registerRepo starts ~/.config/triqual/repos.json', () => withHome(({ home, root }) => {
  const current = join(home, '.config', BRAND.dir);
  assert.equal(configPath(home), join(current, 'config.json'));
  assert.equal(manifestPath(home), join(current, 'harnesses.json'));
  assert.equal(registryPath(home), join(current, 'repos.json'));
  assert.equal(resolvePaths({}, home).configFile, join(current, 'memory-report.json'));
  registerRepo(home, { root, mode: 'committed', now: NOW });
  const stored = JSON.parse(readFileSync(join(current, 'repos.json'), 'utf8'));
  assert.deepEqual(stored.repos.map((r) => r.root), [root]);
  assert.deepEqual(readdirSync(join(home, '.config')), [BRAND.dir]);
}));

test('CM_LOCK_TIMEOUT_MS still sets the lock timeout when no TRIQUAL_ variable is present', () => withHome(({ dir }) => {
  const lock = join(dir, 'held.lock');
  writeFileSync(lock, 'holder\n'); // a fresh lock someone else holds
  const started = Date.now();
  assert.throws(() => withEnv({ CM_LOCK_TIMEOUT_MS: '7' }, () => withLock(lock, () => {})), { message: `lock timeout: ${lock}` });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `gave up after ${elapsed} ms, not near 7 ms (the default is 5000)`);
}));

test('TRIQUAL_LOCK_TIMEOUT_MS sets the lock timeout and wins over CM_LOCK_TIMEOUT_MS', () => withHome(({ dir }) => {
  const lock = join(dir, 'held.lock');
  writeFileSync(lock, 'holder\n'); // a fresh lock someone else holds
  const started = Date.now();
  const vars = { TRIQUAL_LOCK_TIMEOUT_MS: '7', CM_LOCK_TIMEOUT_MS: '600000' };
  assert.throws(() => withEnv(vars, () => withLock(lock, () => {})), { message: `lock timeout: ${lock}` });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `gave up after ${elapsed} ms, not near 7 ms (CM_ says 600000, the default is 5000)`);
}));

test('TRIQUAL_LOCK_STALE_MS sets the stale age and wins over CM_LOCK_STALE_MS', () => withHome(({ dir }) => {
  const lock = join(dir, 'old.lock');
  writeFileSync(lock, 'holder\n');
  const past = new Date(Date.now() - 2000);
  utimesSync(lock, past, past); // a 2 s old lock: stale under 1000 ms, fresh under CM_'s 600000 and the 30000 default
  const vars = { TRIQUAL_LOCK_TIMEOUT_MS: '100', TRIQUAL_LOCK_STALE_MS: '1000', CM_LOCK_STALE_MS: '600000' };
  assert.equal(withEnv(vars, () => withLock(lock, () => 'taken over')), 'taken over');
  assert.equal(existsSync(lock), false);
}));

test("an empty TRIQUAL_REGISTRY_DIR keeps today's unusable handling: registerRepo writes nothing", () => withHome(({ dir, home, root }) => {
  const legacyOverride = join(dir, 'cm-registry');
  mkdirSync(legacyOverride);
  withEnv({ TRIQUAL_REGISTRY_DIR: '', CM_REGISTRY_DIR: legacyOverride }, () => {
    assert.throws(() => registryPath(home), /TRIQUAL_REGISTRY_DIR must be an absolute path/);
    registerRepo(home, { root, mode: 'committed', now: NOW });
  });
  assert.equal(existsSync(join(home, '.config')), false, 'the default registry was written');
  assert.deepEqual(readdirSync(legacyOverride), [], 'the CM_REGISTRY_DIR fallback was used although TRIQUAL_ is present');
}));
