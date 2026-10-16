import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, existsSync, chmodSync, copyFileSync, cpSync, realpathSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, installCli, makeAsk, runSteps, STEPS } from '../bin/bootstrap.mjs';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';
import { fakeMachine, legacyMachine } from '../plugins/methodology/test/fixtures/migrate-machine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = join(ROOT, 'plugins', 'methodology', 'setup', 'triqual-shim.mjs');
const ALIAS = join(ROOT, 'plugins', 'methodology', 'setup', 'cm-alias.mjs');
const FORWARDER = join(ROOT, 'plugins', 'methodology', 'setup', `${BRAND.legacy.launcher}-forwarder`);
const BOOTSTRAP = join(ROOT, 'bin', 'bootstrap.mjs');

// Bootstrap adds or updates BRAND.marketplace only (a legacy-only marketplace is left to migrate), so the fixtures
// below install from it.
const ADD = `claude plugin marketplace add ${BRAND.source} --scope user`;
const UPDATE = `claude plugin marketplace update ${BRAND.marketplace}`;
const INSTALL = `claude plugin install methodology@${BRAND.marketplace} --scope user`;

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-home-')));
}

const inBin = (name) => (home) => join(home, '.local', 'bin', name);
const triqualPath = inBin(BRAND.cli);
const triqualMjsPath = inBin(BRAND.cliFile);
const launcherPath = inBin(BRAND.launcher);
const cmPath = inBin(BRAND.legacy.cli);
const cmMjsPath = inBin(BRAND.legacy.cliFile);
const forwarderPath = inBin(BRAND.legacy.launcher);
const LAUNCHER = join(ROOT, 'plugins', 'methodology', 'setup', 'triqual-hook');
const doctorCall = (home) => `${process.execPath} ${triqualPath(home)} doctor`;

// A recorded fake run: every call is logged as "cmd arg1 arg2 ...", and the timeoutMs it received is kept by key. A
// response is looked up by that key; a function response may throw (a spawn error). Unlisted calls succeed with
// empty output.
function fakeRun(responses = {}) {
  const calls = [];
  const timeouts = {};
  const run = async (cmd, args, options) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    timeouts[key] = options?.timeoutMs;
    const r = responses[key];
    if (typeof r === 'function') return r();
    return { code: 0, stdout: '', stderr: '', ...r };
  };
  return { run, calls, timeouts };
}

function writePlugins(home, name, body) {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', name), JSON.stringify(body));
}

const knownMarketplace = (home) =>
  writePlugins(home, 'known_marketplaces.json', {
    [BRAND.marketplace]: { source: { source: 'github', repo: BRAND.source }, installLocation: '/x' },
  });

const SYSTEM = ['methodology', 'progress-tracking', 'workflow-gate', 'roles'];
const RELEASED = { methodology: '0.1.0', 'progress-tracking': '0.1.1', 'workflow-gate': '0.1.0', roles: '0.1.0' };
const installCall = (name) => `claude plugin install ${name}@${BRAND.marketplace} --scope user`;
const updateCall = (name) => `claude plugin update ${name}@${BRAND.marketplace} --scope user`;

// installed_plugins.json with the named plugins at the given versions (user scope unless `scope` says otherwise).
function installedPlugins(home, versions, scope = 'user') {
  const plugins = {};
  for (const [name, version] of Object.entries(versions)) {
    plugins[`${name}@${BRAND.marketplace}`] = [
      { scope, installPath: `/cache/${name}/${version}`, version, ...(scope === 'user' ? {} : { projectPath: '/p' }) },
    ];
  }
  writePlugins(home, 'installed_plugins.json', { version: 2, plugins });
}

const installedMethodology = (home, scope = 'user') => installedPlugins(home, { methodology: '0.1.0' }, scope);

// The installed marketplace copy: known_marketplaces.json points at a dir whose .claude-plugin/marketplace.json lists
// the plugins at the given versions.
function marketplaceCopy(home, versions = RELEASED) {
  const location = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace);
  mkdirSync(join(location, '.claude-plugin'), { recursive: true });
  writeFileSync(join(location, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: BRAND.marketplace,
    plugins: Object.entries(versions).map(([name, version]) => ({ name, source: `./plugins/${name}`, version })),
  }));
  writePlugins(home, 'known_marketplaces.json', {
    [BRAND.marketplace]: { source: { source: 'github', repo: BRAND.source }, installLocation: location },
  });
}

const never = async () => { throw new Error('confirm must not be called'); };

async function boot(home, run, extra = {}) {
  return bootstrap({ home, argv: [], run, isTTY: false, confirm: never, ...extra });
}

const byId = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s]));

const STEP_IDS = ['prereqs', 'migrate', 'marketplace', 'install', 'shim', 'rules-gate', 'rules', 'legacy-agents', 'legacy-gate', 'supersedes', 'harnesses', 'language', 'tracking-permission', 'doctor'];

test('the step ids run in order: prereqs, migrate, marketplace, install, shim, the migration steps, doctor', async () => {
  const home = tempHome();
  try {
    const { run } = fakeRun();
    const result = await boot(home, run);
    assert.deepEqual(result.steps.map((s) => s.id), STEP_IDS);
    for (const s of result.steps) {
      assert.ok(['done', 'already', 'skipped', 'failed'].includes(s.status), `${s.id}: ${s.status}`);
      assert.equal(typeof s.detail, 'string');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('each call gets its timeout: 300 s for plugin calls, 60 s for --version checks and doctor', async () => {
  const home = tempHome();
  try {
    const first = fakeRun();
    await boot(home, first.run);
    assert.deepEqual(first.timeouts, {
      'claude --version': 60000,
      'git --version': 60000,
      'headjack --version': 60000,
      [ADD]: 300000,
      ...Object.fromEntries(SYSTEM.map((name) => [installCall(name), 300000])),
      [doctorCall(home)]: 60000,
    });

    marketplaceCopy(home);
    installedPlugins(home, { ...RELEASED, 'progress-tracking': '0.1.0' });
    const second = fakeRun();
    await boot(home, second.run);
    assert.equal(second.timeouts[UPDATE], 300000);
    assert.equal(second.timeouts[updateCall('progress-tracking')], 300000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap uses the realRun of plugins/methodology/cli/doctor.mjs', async () => {
  const bootstrapModule = await import('../bin/bootstrap.mjs');
  const doctorModule = await import('../plugins/methodology/cli/doctor.mjs');
  assert.equal(bootstrapModule.realRun, doctorModule.realRun);
});

test('prereqs fails without claude: install hint, and every later step is skipped', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun({ 'claude --version': { code: 127, stderr: 'spawn claude ENOENT' } });
    const steps = byId(await boot(home, run));
    assert.equal(steps.prereqs.status, 'failed');
    assert.match(steps.prereqs.detail, /claude/);
    assert.match(steps.prereqs.detail, /install/i);
    for (const id of ['marketplace', 'install', 'shim', 'doctor']) {
      assert.deepEqual(steps[id], { id, status: 'skipped', detail: 'prereqs failed' });
    }
    assert.ok(!calls.some((c) => c.startsWith('claude plugin')), calls.join('\n'));
    assert.ok(!calls.some((c) => c.endsWith(' doctor')), calls.join('\n'));
    assert.equal(existsSync(cmPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prereqs fails when spawning claude throws', async () => {
  const home = tempHome();
  try {
    const { run } = fakeRun({ 'claude --version': () => { throw new Error('spawn claude ENOENT'); } });
    const steps = byId(await boot(home, run));
    assert.equal(steps.prereqs.status, 'failed');
    assert.match(steps.prereqs.detail, /claude/);
    assert.match(steps.prereqs.detail, /install/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Review Focus 4: the floor is 22.13 and is compared on major and minor, so a machine that ran on Node 20+ is refused.
test('prereqs fails when node is older than 22.13, comparing major and minor', async () => {
  const home = tempHome();
  try {
    for (const nodeVersion of ['18.20.4', '20.18.1', '22.1.0', '22.12.0', '22.12.9']) {
      const { run } = fakeRun();
      const steps = byId(await boot(home, run, { nodeVersion }));
      assert.equal(steps.prereqs.status, 'failed', nodeVersion);
      assert.match(steps.prereqs.detail, new RegExp(`node ${nodeVersion.replace(/\./g, '\\.')} is older than 22\\.13; install Node 22\\.13 or newer`));
      assert.equal(steps.marketplace.status, 'skipped');
    }
    for (const nodeVersion of ['22.13.0', '22.13.1', '22.16.0', '23.0.0', '24.0.0', '24.18.0']) {
      const { run } = fakeRun();
      const steps = byId(await boot(home, run, { nodeVersion }));
      assert.equal(steps.prereqs.status, 'done', nodeVersion);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prereqs fails without git', async () => {
  const home = tempHome();
  try {
    const { run } = fakeRun({ 'git --version': { code: 127 } });
    const steps = byId(await boot(home, run));
    assert.equal(steps.prereqs.status, 'failed');
    assert.match(steps.prereqs.detail, /git/);
    assert.match(steps.prereqs.detail, /install/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a missing headjack is noted but does not fail prereqs', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun({ 'headjack --version': { code: 127 } });
    const steps = byId(await boot(home, run));
    assert.ok(calls.includes('headjack --version'), calls.join('\n'));
    assert.equal(steps.prereqs.status, 'done');
    assert.match(steps.prereqs.detail, /headjack/);
    assert.equal(steps.marketplace.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The real headjack CLI has no --version: it prints "Unknown option '--version'" and exits 2. Only 127 (spawn
// ENOENT) means it is absent.
test('a headjack whose --version exits non-zero (not 127) is present, not "not found"', async () => {
  const home = tempHome();
  try {
    const { run } = fakeRun({
      'headjack --version': { code: 2, stderr: "headjack: Unknown option '--version'." },
    });
    const steps = byId(await boot(home, run));
    assert.equal(steps.prereqs.status, 'done');
    assert.match(steps.prereqs.detail, /headjack/);
    assert.doesNotMatch(steps.prereqs.detail, /not found/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('marketplace step adds BRAND.source under BRAND.marketplace when neither is known', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    const args = ['plugin', 'marketplace', 'add', 'Montinou/triqual', '--scope', 'user'];
    assert.deepEqual(args.slice(3, 4), [BRAND.source]);
    assert.ok(calls.includes(['claude', ...args].join(' ')), calls.join('\n'));
    assert.ok(!calls.some((c) => c.startsWith('claude plugin marketplace update')), calls.join('\n'));
    assert.deepEqual(steps.marketplace, {
      id: 'marketplace', status: 'done', detail: `${BRAND.marketplace} added from ${BRAND.source}`,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('marketplace step updates BRAND.marketplace when it is known, legacy entry or not', async () => {
  for (const legacyToo of [false, true]) {
    const home = tempHome();
    try {
      writePlugins(home, 'known_marketplaces.json', {
        [BRAND.marketplace]: { installLocation: '/x' },
        ...(legacyToo ? { [BRAND.legacy.marketplace]: { installLocation: '/y' } } : {}),
      });
      // The legacy entry is migrate's: removed (no legacy plugin is installed) before triqual is updated.
      const { run, calls } = fakeMachine(home);
      const steps = byId(await boot(home, run));
      assert.deepEqual(calls.filter((c) => c.startsWith('claude plugin marketplace ')), [
        ...(legacyToo ? [`claude plugin marketplace remove ${BRAND.legacy.marketplace}`] : []),
        `claude plugin marketplace update ${BRAND.marketplace}`,
      ]);
      assert.deepEqual(steps.marketplace, { id: 'marketplace', status: 'done', detail: `${BRAND.marketplace} updated` });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('marketplace step leaves a legacy-only marketplace to migrate: no update of the legacy entry, install skipped', async () => {
  // Only reachable without the migrate step (which moves the machine first): the step's own guard.
  const home = tempHome();
  try {
    writePlugins(home, 'known_marketplaces.json', { [BRAND.legacy.marketplace]: { installLocation: '/x' } });
    const { run, calls } = fakeRun();
    const withoutMigrate = STEPS.filter((s) => s.id !== 'migrate')
      .map((s) => ({ ...s, needs: s.needs?.filter((id) => id !== 'migrate') }));
    const steps = byId(await runSteps(withoutMigrate, { home, argv: [], run, isTTY: false, confirm: never }));
    assert.ok(!calls.some((c) => c.startsWith('claude plugin marketplace ')), calls.join('\n'));
    assert.ok(!calls.some((c) => /^claude plugin (install|update) /.test(c)), calls.join('\n'));
    assert.deepEqual(steps.marketplace, {
      id: 'marketplace', status: 'skipped',
      detail: `legacy ${BRAND.legacy.marketplace} marketplace: run the migration first`,
    });
    assert.deepEqual(steps.install, { id: 'install', status: 'skipped', detail: 'marketplace skipped' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy-only machine: migrate then install updates nothing under the legacy id', async () => {
  const home = tempHome();
  try {
    legacyMachine(home);
    const { run, calls } = fakeMachine(home);
    const steps = byId(await boot(home, run));
    assert.equal(steps.migrate.status, 'done', steps.migrate.detail);
    assert.deepEqual(steps.marketplace, { id: 'marketplace', status: 'done', detail: `${BRAND.marketplace} updated` });
    assert.equal(steps.install.status, 'already', steps.install.detail);
    const legacyCalls = calls.filter((c) => c.includes(`@${BRAND.legacy.marketplace}`) || c.endsWith(` ${BRAND.legacy.marketplace}`));
    // Only migrate's own uninstalls and the marketplace removal name the legacy marketplace.
    assert.ok(legacyCalls.every((c) => / plugin uninstall .* --keep-data$/.test(c) || c.includes('marketplace remove')),
      legacyCalls.join('\n'));
    assert.ok(!calls.some((c) => /^claude plugin (install|update) \S+@/.test(c) && c.includes(`@${BRAND.legacy.marketplace}`)),
      calls.join('\n'));
    const installed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
    assert.ok(Object.keys(installed).every((id) => id.endsWith(`@${BRAND.marketplace}`)), Object.keys(installed).join(', '));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('marketplace is added when unknown', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    assert.ok(calls.includes(ADD), calls.join('\n'));
    assert.ok(!calls.includes(UPDATE));
    assert.equal(steps.marketplace.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('marketplace is added when known_marketplaces.json lists only other marketplaces', async () => {
  const home = tempHome();
  try {
    writePlugins(home, 'known_marketplaces.json', { 'claude-plugins-official': { installLocation: '/y' } });
    const { run, calls } = fakeRun();
    await boot(home, run);
    assert.ok(calls.includes(ADD), calls.join('\n'));
    assert.ok(!calls.includes(UPDATE));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('marketplace is updated when known', async () => {
  const home = tempHome();
  try {
    knownMarketplace(home);
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    assert.ok(calls.includes(UPDATE), calls.join('\n'));
    assert.ok(!calls.includes(ADD));
    assert.equal(steps.marketplace.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed marketplace call fails the step, skips install, and still runs shim and doctor', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun({ [ADD]: { code: 1, stderr: 'Cloning...\nError: repository not found\n' } });
    const steps = byId(await boot(home, run));
    assert.deepEqual(steps.marketplace, {
      id: 'marketplace', status: 'failed', detail: `Error: repository not found — run by hand: ${ADD}`,
    });
    assert.deepEqual(steps.install, { id: 'install', status: 'skipped', detail: 'marketplace failed' });
    assert.ok(!calls.includes(INSTALL));
    assert.equal(steps.shim.status, 'done');
    assert.ok(calls.includes(doctorCall(home)), calls.join('\n'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install runs once and is already on the second run', async () => {
  const home = tempHome();
  try {
    const first = fakeRun();
    const steps1 = byId(await boot(home, first.run));
    assert.equal(first.calls.filter((c) => c === INSTALL).length, 1, first.calls.join('\n'));
    assert.equal(steps1.install.status, 'done');

    marketplaceCopy(home);
    installedPlugins(home, RELEASED);
    const second = fakeRun();
    const steps2 = byId(await boot(home, second.run));
    assert.deepEqual(steps2.install, {
      id: 'install', status: 'already', detail: 'every system plugin is installed at the marketplace version',
    });
    assert.ok(!second.calls.some((c) => /^claude plugin (install|update) /.test(c)), second.calls.join('\n'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install updates an installed plugin whose version differs from the marketplace', async () => {
  const home = tempHome();
  try {
    marketplaceCopy(home);
    installedPlugins(home, { ...RELEASED, 'progress-tracking': '0.1.0' });
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    assert.deepEqual(calls.filter((c) => /^claude plugin (install|update) /.test(c)), [updateCall('progress-tracking')]);
    assert.deepEqual(steps.install, {
      id: 'install', status: 'done', detail: `updated progress-tracking@${BRAND.marketplace} 0.1.0 -> 0.1.1`,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install installs a system plugin missing at user scope, after methodology', async () => {
  const home = tempHome();
  try {
    marketplaceCopy(home);
    const { roles, ...rest } = RELEASED;
    installedPlugins(home, rest);
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    assert.deepEqual(calls.filter((c) => /^claude plugin (install|update) /.test(c)), [installCall('roles')]);
    assert.deepEqual(steps.install, { id: 'install', status: 'done', detail: `installed roles@${BRAND.marketplace}` });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install skips the version comparison when the marketplace manifest is unreadable', async () => {
  for (const breakIt of [
    (home) => writePlugins(home, 'known_marketplaces.json', { [BRAND.marketplace]: { installLocation: join(home, 'gone') } }),
    (home) => writeFileSync(join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace, '.claude-plugin', 'marketplace.json'), '{ nope'),
    (home) => writePlugins(home, 'known_marketplaces.json', { [BRAND.marketplace]: { installLocation: 7 } }),
  ]) {
    const home = tempHome();
    try {
      marketplaceCopy(home);
      breakIt(home);
      installedPlugins(home, { ...RELEASED, 'progress-tracking': '0.1.0' });
      const { run, calls } = fakeRun();
      const steps = byId(await boot(home, run));
      assert.ok(!calls.some((c) => /^claude plugin (install|update) /.test(c)), calls.join('\n'));
      assert.equal(steps.install.status, 'already');
      assert.match(steps.install.detail, /^every system plugin is installed; versions not compared: /);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a failed update call fails the install step with its last stderr line and the manual command', async () => {
  const home = tempHome();
  try {
    marketplaceCopy(home);
    installedPlugins(home, { ...RELEASED, 'progress-tracking': '0.1.0', roles: '0.0.9' });
    const { run, calls } = fakeRun({ [updateCall('progress-tracking')]: { code: 1, stderr: 'Updating...\nnetwork down\n' } });
    const steps = byId(await boot(home, run));
    assert.deepEqual(steps.install, {
      id: 'install',
      status: 'failed',
      detail: `network down — run by hand: ${updateCall('progress-tracking')}`,
    });
    assert.ok(!calls.includes(updateCall('roles')), calls.join('\n'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install ignores a methodology entry at a scope other than user', async () => {
  const home = tempHome();
  try {
    installedMethodology(home, 'local');
    const { run, calls } = fakeRun();
    const steps = byId(await boot(home, run));
    assert.ok(calls.includes(INSTALL), calls.join('\n'));
    assert.equal(steps.install.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed install call fails the step with the last stderr line', async () => {
  const home = tempHome();
  try {
    const { run } = fakeRun({ [INSTALL]: { code: 1, stderr: 'Installing...\nPlugin "methodology" not found\n\n' } });
    const steps = byId(await boot(home, run));
    assert.deepEqual(steps.install, {
      id: 'install', status: 'failed', detail: `Plugin "methodology" not found — run by hand: ${INSTALL}`,
    });
    assert.equal(steps.shim.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The six files the shim step installs: [path, the source it copies, or the target of a relative symlink]. The last
// three (the cm alias, its link and the forwarder) only on a machine that had a legacy CLI file when the run began.
const SIX = (home) => [
  [triqualMjsPath(home), SHIM], [triqualPath(home), BRAND.cliFile], [launcherPath(home), LAUNCHER],
  [cmMjsPath(home), ALIAS], [cmPath(home), BRAND.legacy.cliFile], [forwarderPath(home), FORWARDER],
];
const THREE = (home) => SIX(home).slice(0, 3);
const LEGACY_THREE = (home) => SIX(home).slice(3);

function assertInstalled(detail, files) {
  for (const [path, source] of files) {
    if (source.includes('/')) {
      assert.ok(lstatSync(path).isFile(), path);
      assert.equal(readFileSync(path, 'utf8'), readFileSync(source, 'utf8'), path);
      assert.equal(statSync(path).mode & 0o777, 0o755, path);
      assert.ok(detail.includes(`${path} installed`), detail);
    } else {
      assert.ok(lstatSync(path).isSymbolicLink(), path);
      assert.equal(readlinkSync(path), source, path);
      assert.ok(detail.includes(`${path} -> ${source} created`), detail);
    }
  }
}

test('on a fresh machine the shim step installs triqual and triqual-hook only; a second run is already', async () => {
  const home = tempHome();
  try {
    const steps1 = byId(await boot(home, fakeRun().run));
    assert.equal(steps1.shim.status, 'done', steps1.shim.detail);
    assertInstalled(steps1.shim.detail, THREE(home));
    for (const [path] of LEGACY_THREE(home)) assert.equal(existsSync(path), false, path);
    // Line 2 of every installed file is its ownership line.
    const line2 = (path) => readFileSync(path, 'utf8').split('\n')[1];
    assert.equal(line2(triqualMjsPath(home)), BRAND.ownership.shim);
    assert.equal(line2(launcherPath(home)), BRAND.ownership.launcher);

    const steps2 = byId(await boot(home, fakeRun().run));
    assert.equal(steps2.shim.status, 'already', steps2.shim.detail);
    for (const [path] of THREE(home)) assert.ok(steps2.shim.detail.includes(path), steps2.shim.detail);
    for (const [path] of LEGACY_THREE(home)) assert.equal(existsSync(path), false, path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('on a machine with a legacy CLI file the shim step installs the six; a second run is already', async () => {
  const home = tempHome();
  try {
    // Only the forwarder, current: migrate's cli step has nothing to replace, so the shim step installs the rest.
    mkdirSync(dirname(forwarderPath(home)), { recursive: true });
    copyFileSync(FORWARDER, forwarderPath(home));
    chmodSync(forwarderPath(home), 0o755);
    const steps1 = byId(await boot(home, fakeRun().run));
    assert.equal(steps1.shim.status, 'done', steps1.shim.detail);
    assertInstalled(steps1.shim.detail, SIX(home).filter(([path]) => path !== forwarderPath(home)));
    const line2 = (path) => readFileSync(path, 'utf8').split('\n')[1];
    assert.equal(line2(cmMjsPath(home)), BRAND.ownership.alias);
    assert.equal(line2(forwarderPath(home)), BRAND.ownership.forwarder);

    const steps2 = byId(await boot(home, fakeRun().run));
    assert.equal(steps2.shim.status, 'already', steps2.shim.detail);
    for (const [path] of SIX(home)) assert.ok(steps2.shim.detail.includes(path), steps2.shim.detail);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installCli is the shim step, exported for the migration', async () => {
  assert.equal(STEPS.find((s) => s.id === 'shim').run, installCli);
  const home = tempHome();
  try {
    const r = await installCli({ home });
    assert.equal(r.status, 'done', r.detail);
    for (const [path] of THREE(home)) assert.ok(lstatSync(path), path);
    for (const [path] of LEGACY_THREE(home)) assert.equal(existsSync(path), false, path);
    assert.equal((await installCli({ home })).status, 'already');
    // With a legacy CLI file present the alias, its link and the forwarder come too.
    writeFileSync(forwarderPath(home), `#!/usr/bin/env bash\n${BRAND.legacy.ownership.launcher}\nexit 0\n`, { mode: 0o755 });
    assert.equal((await installCli({ home })).status, 'done');
    for (const [path] of SIX(home)) assert.ok(lstatSync(path), path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const OLDER = `#!/usr/bin/env node\n${BRAND.ownership.shim} An older version.\n`;
const OLDER_LEGACY = `#!/usr/bin/env node\n${BRAND.legacy.ownership.shim} Bootstrap copies this file, alone and verbatim.\n`;

test('shim installs setup/triqual-hook verbatim (0755), replaces an older or legacy one, and is already after', async () => {
  const home = tempHome();
  try {
    const steps1 = byId(await boot(home, fakeRun().run));
    assert.equal(steps1.shim.status, 'done');
    assert.equal(readFileSync(launcherPath(home), 'utf8'), readFileSync(LAUNCHER, 'utf8'));

    for (const marker of [BRAND.ownership.launcher, BRAND.legacy.ownership.launcher]) {
      writeFileSync(launcherPath(home), `#!/usr/bin/env bash\n${marker}\nexit 0\n`, { mode: 0o755 });
      const steps2 = byId(await boot(home, fakeRun().run));
      assert.equal(steps2.shim.status, 'done');
      assert.ok(steps2.shim.detail.includes(`${launcherPath(home)} updated`), steps2.shim.detail);
      assert.equal(readFileSync(launcherPath(home), 'utf8'), readFileSync(LAUNCHER, 'utf8'));
    }

    chmodSync(launcherPath(home), 0o644);
    const steps3 = byId(await boot(home, fakeRun().run));
    assert.equal(steps3.shim.status, 'done');
    assert.ok(steps3.shim.detail.includes(`${launcherPath(home)} made executable`), steps3.shim.detail);
    assert.equal(statSync(launcherPath(home)).mode & 0o777, 0o755);

    const steps4 = byId(await boot(home, fakeRun().run));
    assert.equal(steps4.shim.status, 'already');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(`a legacy-marker ${BRAND.legacy.cliFile} shim is replaced by the alias`, async () => {
  // The layout an older bootstrap left: the full legacy shim at BRAND.legacy.cliFile behind its cm link, and the legacy
  // launcher at BRAND.legacy.launcher. All three become the alias, its link and the forwarder.
  const home = tempHome();
  try {
    mkdirSync(dirname(cmPath(home)), { recursive: true });
    writeFileSync(cmMjsPath(home), OLDER_LEGACY, { mode: 0o755 });
    symlinkSync(BRAND.legacy.cliFile, cmPath(home));
    writeFileSync(forwarderPath(home), `#!/usr/bin/env bash\n${BRAND.legacy.ownership.launcher}\nexit 0\n`, { mode: 0o755 });
    // migrate's cli step replaces them (through installCli), so the shim step finds the six files current.
    const steps = byId(await boot(home, fakeRun().run));
    assert.equal(steps.migrate.status, 'done', steps.migrate.detail);
    assert.equal(steps.shim.status, 'already', steps.shim.detail);
    assert.equal(readFileSync(cmMjsPath(home), 'utf8'), readFileSync(ALIAS, 'utf8'));
    assert.equal(readlinkSync(cmPath(home)), BRAND.legacy.cliFile);
    assert.equal(readFileSync(forwarderPath(home), 'utf8'), readFileSync(FORWARDER, 'utf8'));
    assert.equal(readFileSync(triqualMjsPath(home), 'utf8'), readFileSync(SHIM, 'utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('shim replaces an older triqual.mjs (ours by line 2) and restores the mode of an identical one', async () => {
  const home = tempHome();
  try {
    mkdirSync(dirname(triqualMjsPath(home)), { recursive: true });
    writeFileSync(triqualMjsPath(home), OLDER, { mode: 0o755 });
    const steps1 = byId(await boot(home, fakeRun().run));
    assert.equal(steps1.shim.status, 'done');
    assert.equal(readFileSync(triqualMjsPath(home), 'utf8'), readFileSync(SHIM, 'utf8'));
    assert.equal(statSync(triqualMjsPath(home)).mode & 0o777, 0o755);

    chmodSync(triqualMjsPath(home), 0o644);
    const steps2 = byId(await boot(home, fakeRun().run));
    assert.equal(steps2.shim.status, 'done');
    assert.equal(statSync(triqualMjsPath(home)).mode & 0o777, 0o755);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(`shim replaces an older extensionless cm that carries the marker with the cm -> ${BRAND.legacy.cliFile} symlink`, async () => {
  const home = tempHome();
  try {
    mkdirSync(dirname(cmPath(home)), { recursive: true });
    writeFileSync(cmPath(home), OLDER_LEGACY, { mode: 0o755 });
    const steps = byId(await boot(home, fakeRun().run));
    assert.equal(steps.migrate.status, 'done', steps.migrate.detail); // migrate's cli step, through installCli
    assert.equal(steps.shim.status, 'already');
    assert.ok(lstatSync(cmPath(home)).isSymbolicLink());
    assert.equal(readlinkSync(cmPath(home)), BRAND.legacy.cliFile);
    assert.equal(readFileSync(cmMjsPath(home), 'utf8'), readFileSync(ALIAS, 'utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const NOT_OURS = (path) => `${path} is not a file ${BRAND.marketplace} installed; move it aside, then rerun bootstrap`;
// A foreign file at a legacy CLI path of a legacy machine is left to the shim step: migrate's cli step skips it
// (installCli would refuse it), so the shim step reports it as it did before migrate.
function assertRefused(steps, home, pick) {
  assert.deepEqual(steps.shim, { id: 'shim', status: 'failed', detail: NOT_OURS(pick(home)) });
  assert.notEqual(steps.migrate.status, 'failed', steps.migrate.detail);
}

const FOREIGN = '#!/bin/sh\n# some other tool\nexec other "$@"\n';
const LEGACY_PATHS = [cmMjsPath, cmPath, forwarderPath];
const FORWARDER_OURS = `#!/usr/bin/env bash\n${BRAND.ownership.forwarder}\nexit 0\n`;

// Each foreign triqual file fails the step with nothing written: the other five stay absent.
test('shim leaves a foreign file at any of the three triqual paths untouched, writes none of the six, and fails', async () => {
  for (const pick of [triqualMjsPath, triqualPath, launcherPath]) {
    const home = tempHome();
    try {
      const path = pick(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, FOREIGN, { mode: 0o700 });
      const steps = byId(await boot(home, fakeRun().run));
      assertRefused(steps, home, pick);
      assert.equal(readFileSync(path, 'utf8'), FOREIGN);
      assert.equal(statSync(path).mode & 0o777, 0o700);
      for (const [other] of SIX(home)) if (other !== path) assert.equal(existsSync(other), false, other);
      assert.equal(steps.doctor.status, 'skipped');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// A fresh machine had no callers of the legacy names: a file there belongs to someone else, so nothing is written
// next to it (no alias that would shadow it) and the step is not blocked.
test(`on a fresh machine a foreign ${BRAND.legacy.cli}, ${BRAND.legacy.cliFile} or ${BRAND.legacy.launcher} stays byte-identical, no alias is installed, and the step is done`, async () => {
  for (const pick of LEGACY_PATHS) {
    const home = tempHome();
    try {
      const path = pick(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, FOREIGN, { mode: 0o700 });
      const steps = byId(await boot(home, fakeRun().run));
      assert.equal(steps.shim.status, 'done', steps.shim.detail);
      assert.notEqual(steps.migrate.status, 'failed', steps.migrate.detail);
      assert.equal(readFileSync(path, 'utf8'), FOREIGN);
      assert.equal(statSync(path).mode & 0o777, 0o700);
      assert.equal(lstatSync(path).isSymbolicLink(), false);
      for (const [file] of THREE(home)) assert.ok(lstatSync(file), file);
      for (const other of LEGACY_PATHS) if (other !== pick) assert.equal(existsSync(other(home)), false, other(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// One of our legacy files says the machine had callers of the old names, so the alias is installed and a foreign file
// in its place is refused: the old command would not run what its caller expects.
test(`on a legacy machine a foreign ${BRAND.legacy.cli}, ${BRAND.legacy.cliFile} or ${BRAND.legacy.launcher} still fails the shim step with NOT_OURS, nothing written`, async () => {
  for (const [pick, partner] of [[cmPath, forwarderPath], [cmMjsPath, forwarderPath], [forwarderPath, cmMjsPath]]) {
    const home = tempHome();
    try {
      mkdirSync(dirname(cmPath(home)), { recursive: true });
      writeFileSync(partner(home), partner === forwarderPath ? FORWARDER_OURS : OLDER_LEGACY, { mode: 0o755 });
      writeFileSync(pick(home), FOREIGN, { mode: 0o700 });
      const steps = byId(await boot(home, fakeRun().run));
      assertRefused(steps, home, pick);
      assert.equal(readFileSync(pick(home), 'utf8'), FOREIGN);
      assert.equal(statSync(pick(home)).mode & 0o777, 0o700);
      for (const file of [triqualMjsPath, triqualPath, launcherPath]) assert.equal(existsSync(file(home)), false, file(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('ownership is line 2: a marker on another line does not make a file ours', async () => {
  const home = tempHome();
  try {
    mkdirSync(dirname(triqualMjsPath(home)), { recursive: true });
    const text = `#!/usr/bin/env node\n// mine\n${BRAND.ownership.shim}\n`;
    writeFileSync(triqualMjsPath(home), text);
    const steps = byId(await boot(home, fakeRun().run));
    assert.deepEqual(steps.shim, { id: 'shim', status: 'failed', detail: NOT_OURS(triqualMjsPath(home)) });
    assert.equal(readFileSync(triqualMjsPath(home), 'utf8'), text);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The link points at a temp copy of the shim, so a wrong chmod through the link never touches the repo file.
function linkToShimCopy(home, path) {
  const copy = join(home, 'shim-copy.mjs');
  copyFileSync(SHIM, copy);
  chmodSync(copy, 0o644);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(copy, path);
  return copy;
}

test('shim leaves a triqual symlink to anything but its .mjs untouched (even one to a copy of the shim) and fails', async () => {
  const home = tempHome();
  try {
    const copy = linkToShimCopy(home, triqualPath(home));
    const steps = byId(await boot(home, fakeRun().run));
    assertRefused(steps, home, triqualPath);
    assert.equal(readlinkSync(triqualPath(home)), copy);
    assert.equal(statSync(copy).mode & 0o777, 0o644);
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(SHIM, 'utf8'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(`a ${BRAND.legacy.cli} symlink to anything but ${BRAND.legacy.cliFile} is foreign: left alone on a fresh machine, refused on a legacy one`, async () => {
  for (const legacy of [false, true]) {
    const home = tempHome();
    try {
      const copy = linkToShimCopy(home, cmPath(home));
      if (legacy) writeFileSync(forwarderPath(home), FORWARDER_OURS, { mode: 0o755 });
      const steps = byId(await boot(home, fakeRun().run));
      if (legacy) assertRefused(steps, home, cmPath);
      else assert.equal(steps.shim.status, 'done', steps.shim.detail);
      assert.equal(readlinkSync(cmPath(home)), copy);
      assert.equal(statSync(copy).mode & 0o777, 0o644);
      assert.equal(readFileSync(copy, 'utf8'), readFileSync(SHIM, 'utf8'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test(`shim leaves a symlink at ${BRAND.cliFile} untouched and fails; one at ${BRAND.legacy.cliFile} is foreign by the same rule`, async () => {
  for (const pick of [triqualMjsPath, cmMjsPath]) {
    for (const legacy of pick === cmMjsPath ? [false, true] : [false]) {
      const home = tempHome();
      try {
        mkdirSync(dirname(pick(home)), { recursive: true });
        copyFileSync(SHIM, join(home, 'shim-copy.mjs'));
        symlinkSync(join(home, 'shim-copy.mjs'), pick(home));
        if (legacy) writeFileSync(forwarderPath(home), FORWARDER_OURS, { mode: 0o755 });
        const steps = byId(await boot(home, fakeRun().run));
        if (pick === triqualMjsPath || legacy) assertRefused(steps, home, pick);
        else assert.equal(steps.shim.status, 'done', steps.shim.detail);
        assert.equal(readlinkSync(pick(home)), join(home, 'shim-copy.mjs'));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('doctor runs the installed shim: exit 0 is done', async () => {
  const home = tempHome();
  try {
    const { run, calls } = fakeRun({
      [doctorCall(home)]: { code: 0, stdout: 'WARN headjack unreachable\ndoctor: 0 failure(s), 1 warning(s)\n' },
    });
    const steps = byId(await boot(home, run));
    assert.equal(calls.at(-1), doctorCall(home));
    assert.equal(steps.doctor.status, 'done');
    assert.match(steps.doctor.detail, /0 failure\(s\), 1 warning\(s\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor exiting 0 without its report line fails: the shim ran no doctor', async () => {
  const home = tempHome();
  try {
    for (const stdout of ['', 'something else\n', 'doctor: 0 failure(s), 0 warning(s) and more\n']) {
      const { run } = fakeRun({ [doctorCall(home)]: { code: 0, stdout } });
      const steps = byId(await boot(home, run));
      assert.deepEqual(steps.doctor, { id: 'doctor', status: 'failed', detail: `${BRAND.cli} doctor produced no report` }, JSON.stringify(stdout));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor with a non-zero exit fails, with its FAIL lines and summary as the detail', async () => {
  const home = tempHome();
  try {
    const stdout = `FAIL roles@${BRAND.legacy.marketplace} is not installed\nWARN a\nWARN b\nWARN c\nWARN d\ndoctor: 1 failure(s), 4 warning(s)\n`;
    const { run } = fakeRun({ [doctorCall(home)]: { code: 1, stdout } });
    const steps = byId(await boot(home, run));
    assert.equal(steps.doctor.status, 'failed');
    assert.ok(steps.doctor.detail.includes(`roles@${BRAND.legacy.marketplace} is not installed`), steps.doctor.detail);
    assert.match(steps.doctor.detail, /1 failure\(s\), 4 warning\(s\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-TTY confirmations are refused unless --yes', async () => {
  let asked = 0;
  const confirm = async () => { asked += 1; return true; };

  assert.equal(await makeAsk({ argv: [], isTTY: false, confirm })('Proceed?'), false);
  assert.equal(asked, 0);
  assert.equal(await makeAsk({ argv: ['--yes'], isTTY: false, confirm })('Proceed?'), true);
  assert.equal(await makeAsk({ argv: ['--yes'], isTTY: true, confirm })('Proceed?'), true);
  assert.equal(asked, 0);

  assert.equal(await makeAsk({ argv: [], isTTY: true, confirm: async () => false })('Proceed?'), false);
  assert.equal(await makeAsk({ argv: [], isTTY: true, confirm })('Proceed?'), true);
  assert.equal(asked, 1);

  // A step that needs a confirmation is skipped when the answer is refused, and confirm is never called.
  const needsConfirm = {
    id: 'needs-confirm',
    run: async ({ ask }) => ((await ask('Change it?')) ? { status: 'done', detail: 'changed' } : { status: 'skipped', detail: 'not confirmed' }),
  };
  const { steps } = await runSteps([needsConfirm], { home: '/nonexistent', argv: [], run: async () => ({ code: 0, stdout: '', stderr: '' }), isTTY: false, confirm: never });
  assert.deepEqual(steps, [{ id: 'needs-confirm', status: 'skipped', detail: 'not confirmed' }]);
  const yes = await runSteps([needsConfirm], { home: '/nonexistent', argv: ['--yes'], run: async () => ({ code: 0, stdout: '', stderr: '' }), isTTY: false, confirm: never });
  assert.deepEqual(yes.steps, [{ id: 'needs-confirm', status: 'done', detail: 'changed' }]);
});

test('bootstrap logs one line per step', async () => {
  const home = tempHome();
  try {
    const lines = [];
    const result = await boot(home, fakeRun().run, { log: (l) => lines.push(l) });
    // migrate's own lines come under migrate/, before the step's line.
    const migrate = lines.filter((l) => l.startsWith('migrate/'));
    assert.deepEqual(migrate.map((l) => l.slice('migrate/'.length).split(':')[0]),
      ['backup', 'cli', 'marketplace', 'references', 'directories', 'harnesses', 'repos', 'verify']);
    assert.deepEqual(lines.slice(1, 1 + migrate.length), migrate);
    assert.deepEqual(lines.filter((l) => !l.startsWith('migrate/')), result.steps.map((s) => `${s.id}: ${s.status} — ${s.detail}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bootstrap prints a supersedes line (done/already)', async () => {
  const home = tempHome();
  try {
    // The installed methodology carries this repo's rules/, whose manifest supersedes superpowers@*.
    const installPath = join(home, '.claude', 'plugins', 'cache', BRAND.marketplace, 'methodology', '0.2.0');
    cpSync(join(ROOT, 'plugins', 'methodology', 'rules'), join(installPath, 'rules'), { recursive: true });
    writePlugins(home, 'installed_plugins.json', {
      version: 2, plugins: { [`methodology@${BRAND.marketplace}`]: [{ scope: 'user', installPath, version: '0.2.0' }] },
    });
    const ids = ['superpowers@superpowers-marketplace', 'superpowers@claude-plugins-official'];
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])) }));
    const first = [];
    await boot(home, fakeRun().run, { log: (l) => first.push(l), now: new Date(2026, 8, 28, 10, 0, 0) });
    assert.ok(first.includes(`supersedes: done — disabled ${ids.join(', ')}`), first.join('\n'));
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    for (const id of ids) assert.equal(settings.enabledPlugins[id], false, id);
    assert.ok(existsSync(join(home, '.claude', 'backups', `${BRAND.dir}-20260928-100000`, 'settings.json')));
    const second = [];
    await boot(home, fakeRun().run, { log: (l) => second.push(l) });
    assert.ok(second.includes('supersedes: already — no superseded plugin enabled'), second.join('\n'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- T16: the tracking allow rule (Store-2 T6: `triqual tracking:*`, which also covers add, status and log) ----

const ALLOW = `Bash(${BRAND.cli} tracking:*)`;
const OLD_ALLOW = `Bash(${BRAND.cli} tracking write:*)`;
const settingsFile = (home) => join(home, '.claude', 'settings.json');

test('bootstrap adds the allow rule once, with a backup', async () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const original = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git status:*)'], deny: ['Read(.env)'] } }, null, 2);
    writeFileSync(settingsFile(home), original);
    // Not confirmed (no terminal, no --yes): skipped, nothing written.
    const quiet = byId(await boot(home, fakeRun().run));
    assert.equal(quiet['tracking-permission'].status, 'skipped');
    assert.match(quiet['tracking-permission'].detail, /not confirmed[\s\S]*--yes/);
    assert.equal(readFileSync(settingsFile(home), 'utf8'), original);
    // Asked on a terminal: the question names the rule; a no skips it.
    const asked = [];
    const no = byId(await boot(home, fakeRun().run, { isTTY: true, confirm: async (m) => { asked.push(m); return false; } }));
    assert.equal(no['tracking-permission'].status, 'skipped');
    assert.ok(asked.some((m) => m.includes(ALLOW)), asked.join('\n'));
    assert.equal(readFileSync(settingsFile(home), 'utf8'), original);
    // --yes: added, after the other keys are kept and settings.json is backed up.
    const now = new Date(2026, 8, 28, 11, 0, 0);
    const yes = byId(await boot(home, fakeRun().run, { argv: ['--yes'], now }));
    assert.equal(yes['tracking-permission'].status, 'done', yes['tracking-permission'].detail);
    assert.ok(yes['tracking-permission'].detail.includes(ALLOW));
    const after = JSON.parse(readFileSync(settingsFile(home), 'utf8'));
    assert.deepEqual(after, { model: 'opus', permissions: { allow: ['Bash(git status:*)', ALLOW], deny: ['Read(.env)'] } });
    const backup = join(home, '.claude', 'backups', `${BRAND.dir}-20260928-110000`, 'settings.json');
    assert.equal(readFileSync(backup, 'utf8'), original);
    // Once: a second run reports already and writes nothing, even with --yes.
    const edited = readFileSync(settingsFile(home), 'utf8');
    const again = byId(await boot(home, fakeRun().run, { argv: ['--yes'], now: new Date(2026, 8, 28, 12, 0, 0) }));
    assert.equal(again['tracking-permission'].status, 'already');
    assert.equal(readFileSync(settingsFile(home), 'utf8'), edited);
    assert.equal(existsSync(join(home, '.claude', 'backups', `${BRAND.dir}-20260928-120000`, 'settings.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tracking permission offers the triqual rule; a cm rule does not cover it and is kept', async () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    // The rule itself and the broader prefix of the triqual command cover it.
    const { cli } = BRAND;
    const legacy = BRAND.legacy.cli;
    for (const rule of [`Bash(${cli}:*)`, `Bash(${cli} tracking:*)`]) {
      const original = JSON.stringify({ permissions: { allow: [rule] } }, null, 2);
      writeFileSync(settingsFile(home), original);
      const r = byId(await boot(home, fakeRun().run, { argv: ['--yes'] }));
      assert.equal(r['tracking-permission'].status, 'already', rule);
      assert.ok(r['tracking-permission'].detail.includes(rule), r['tracking-permission'].detail);
      assert.equal(readFileSync(settingsFile(home), 'utf8'), original, `${rule}: settings.json was changed`);
    }
    // The cm rule an older bootstrap added gets the triqual `tracking write` rule beside it from migrate's references
    // step, unasked. That narrow rule does not cover add, status or log: the step offers the broader rule and, once
    // confirmed, adds it beside the other two.
    writeFileSync(settingsFile(home), JSON.stringify({ permissions: { allow: [`Bash(${legacy} tracking write:*)`] } }));
    const questions = [];
    const migrated = byId(await boot(home, fakeRun().run, { isTTY: true, confirm: async (m) => { questions.push(m); return false; } }));
    assert.equal(migrated.migrate.status, 'done', migrated.migrate.detail);
    assert.equal(migrated['tracking-permission'].status, 'skipped');
    assert.ok(questions.some((m) => m.startsWith(`Add "${ALLOW}" to permissions.allow`)), questions.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(home), 'utf8')).permissions.allow,
      [`Bash(${legacy} tracking write:*)`, OLD_ALLOW]);
    // Claude Code matches a prefix rule against the command text, so no broader cm rule covers `triqual tracking add`,
    // and neither does a narrower or unrelated rule: the triqual rule is offered and added beside it, and the
    // existing rule stays.
    for (const rule of [`Bash(${legacy} tracking:*)`, `Bash(${legacy}:*)`, `Bash(${legacy} tasks:*)`]) {
      writeFileSync(settingsFile(home), JSON.stringify({ permissions: { allow: [rule] } }));
      const asked = [];
      const r = byId(await boot(home, fakeRun().run, { isTTY: true, confirm: async (m) => { asked.push(m); return true; } }));
      assert.equal(r['tracking-permission'].status, 'done', rule);
      assert.ok(asked.some((m) => m.startsWith(`Add "${ALLOW}" to permissions.allow`)), asked.join('\n'));
      assert.deepEqual(JSON.parse(readFileSync(settingsFile(home), 'utf8')).permissions.allow, [rule, ALLOW], rule);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Review Focus 4: an existing narrow rule is kept, never rewritten, and the broader rule is offered beside it.
test('an existing tracking write rule is kept and the broader tracking rule is offered', async () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const original = JSON.stringify({ permissions: { allow: ['Bash(git status:*)', OLD_ALLOW] } }, null, 2);
    writeFileSync(settingsFile(home), original);
    // Not confirmed: skipped, and the offer names the broader rule.
    const quiet = byId(await boot(home, fakeRun().run));
    assert.equal(quiet['tracking-permission'].status, 'skipped');
    assert.ok(quiet['tracking-permission'].detail.includes(ALLOW), quiet['tracking-permission'].detail);
    assert.equal(readFileSync(settingsFile(home), 'utf8'), original);
    // Confirmed: the broader rule is added after the old one, which stays.
    const asked = [];
    const yes = byId(await boot(home, fakeRun().run, { isTTY: true, confirm: async (m) => { asked.push(m); return true; } }));
    assert.equal(yes['tracking-permission'].status, 'done', yes['tracking-permission'].detail);
    assert.ok(asked.some((m) => m.startsWith(`Add "${ALLOW}" to permissions.allow`)), asked.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(home), 'utf8')).permissions.allow,
      ['Bash(git status:*)', OLD_ALLOW, ALLOW]);
    // With the broader rule there, the step is already, and the old rule is still kept.
    const again = byId(await boot(home, fakeRun().run, { argv: ['--yes'] }));
    assert.equal(again['tracking-permission'].status, 'already');
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(home), 'utf8')).permissions.allow,
      ['Bash(git status:*)', OLD_ALLOW, ALLOW]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the confirmation names store mode and local mode', async () => {
  const home = tempHome();
  try {
    const asked = [];
    await boot(home, fakeRun().run, { isTTY: true, confirm: async (m) => { asked.push(m); return false; } });
    const question = asked.find((m) => m.startsWith('Add "'));
    assert.ok(question, asked.join('\n'));
    assert.match(question, /store mode/);
    assert.match(question, /local mode/);
    // The rule also lets the commands that replace the database or write a file run without a prompt: the consent names them.
    for (const command of ['tracking restore <snapshot> --yes', 'tracking import --replace --from <file>', 'tracking export --out <path>']) {
      assert.ok(question.includes(`${BRAND.cli} ${command}`), `${command}: ${question}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the allow rule step creates settings.json when missing, and fails on an unusable permissions.allow', async () => {
  const home = tempHome();
  try {
    const created = byId(await boot(home, fakeRun().run, { argv: ['--yes'] }));
    assert.equal(created['tracking-permission'].status, 'done', created['tracking-permission'].detail);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile(home), 'utf8')), { permissions: { allow: [ALLOW] } });
    for (const bad of ['{ nope', JSON.stringify({ permissions: { allow: 'Bash(*)' } }), JSON.stringify({ permissions: [] })]) {
      writeFileSync(settingsFile(home), bad);
      const r = byId(await boot(home, fakeRun().run, { argv: ['--yes'] }));
      assert.equal(r['tracking-permission'].status, 'failed', bad);
      assert.equal(readFileSync(settingsFile(home), 'utf8'), bad, `${bad}: settings.json was changed`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- Plan multi-harness T11: the harnesses step ----

// harnessHome's config.toml holds no legacy bridge table, so sync adds the triqual bridge (harnesses.mjs bridgeId).
const BRIDGE = `methodology-codex@${BRAND.marketplace}`;
const HARNESS_QUESTION = (id) => `Set up the methodology for ${id}? (hooks, rules, skills, role agents)`;
const SPLIT_QUESTION = 'Split ~/.codex/AGENTS.md as shown?';
const SPLIT_SKIP_LINE = 'codex-rules-gate: skipped — the one-time split needs a human: run triqual sync --harness codex';
// Synthetic: a legacy heading (rules/legacy-headings.json) and a Codex-only section the split keeps.
const LEGACY_AGENTS_MD = '# Machine config\n\n## UNIVERSAL DEVELOPMENT RULES\n\nOld rules.\n\n## Spark subagent routing\n\nKeep this.\n';
const codexAgentsMd = (home) => join(home, '.codex', 'AGENTS.md');
const grokHooksFile = (home) => join(home, '.grok', 'hooks', `${BRAND.grokName}.json`);
const methodologyConfig = (home) => join(home, '.config', 'triqual', 'config.json');
const readConfig = (home) => JSON.parse(readFileSync(methodologyConfig(home), 'utf8'));
const harnessCalls = (calls) => calls.filter((c) => c.startsWith('codex ') || c.startsWith('grok '));

// A temp home with methodology (a copy of this repo's rules/ and one skill stub) and roles (this repo's agents)
// installed and enabled at user scope, and a dir per present harness: ~/.codex with a synthetic config.toml (and
// `agentsMd` as its AGENTS.md), ~/.grok.
function harnessHome({ codex = true, grok = true, agentsMd } = {}) {
  const home = tempHome();
  const cache = join(home, '.claude', 'plugins', 'cache', BRAND.marketplace);
  const installPath = join(cache, 'methodology', '0.3.0');
  const rolesPath = join(cache, 'roles', '0.1.0');
  cpSync(join(ROOT, 'plugins', 'methodology', 'rules'), join(installPath, 'rules'), { recursive: true });
  mkdirSync(join(installPath, 'skills', 'using-methodology'), { recursive: true });
  writeFileSync(join(installPath, 'skills', 'using-methodology', 'SKILL.md'), '---\nname: using-methodology\n---\n');
  cpSync(join(ROOT, 'plugins', 'roles', 'agents'), join(rolesPath, 'agents'), { recursive: true });
  writePlugins(home, 'installed_plugins.json', {
    version: 2,
    plugins: {
      [`methodology@${BRAND.marketplace}`]: [{ scope: 'user', installPath, version: '0.3.0' }],
      [`roles@${BRAND.marketplace}`]: [{ scope: 'user', installPath: rolesPath, version: '0.1.0' }],
    },
  });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { [`methodology@${BRAND.marketplace}`]: true, [`roles@${BRAND.marketplace}`]: true },
  }));
  // The Claude clone of the triqual marketplace, which the Codex marketplace sync adds points at.
  mkdirSync(join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace), { recursive: true });
  if (codex) {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "test"\n\n[features]\nhooks = true\n', { mode: 0o600 });
    if (agentsMd !== undefined) writeFileSync(codexAgentsMd(home), agentsMd);
  }
  if (grok) mkdirSync(join(home, '.grok'), { recursive: true });
  return { home, installPath };
}

function writeConfig(home, config) {
  mkdirSync(dirname(methodologyConfig(home)), { recursive: true });
  writeFileSync(methodologyConfig(home), JSON.stringify(config));
}

// A fake run for a whole bootstrap: claude, git and doctor succeed; codex and grok answer like the real CLIs for the
// calls triqual sync makes, and `codex|grok --version` exits 127 (not on PATH), so only a harness dir makes it present.
function harnessRun() {
  const calls = [];
  let bridge = false;
  const marketplaces = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const unexpected = (line) => ({ code: 1, stdout: '', stderr: `fake: unexpected ${line}` });
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    const rest = args.join(' ');
    calls.push(line);
    if (cmd === 'codex' || cmd === 'grok') {
      if (rest === '--version') return { code: 127, stdout: '', stderr: `spawn ${cmd} ENOENT` };
    }
    if (cmd === 'codex') {
      if (rest === 'plugin list --json') {
        return ok(JSON.stringify({ installed: bridge ? [{ pluginId: BRIDGE, enabled: true }] : [], available: [] }));
      }
      if (rest === 'plugin marketplace list --json') return ok(JSON.stringify({ marketplaces: marketplaces.map((name) => ({ name })) }));
      if (rest.startsWith('plugin marketplace add ')) { marketplaces.push(basename(args[3])); return ok(); }
      if (rest === `plugin add ${BRIDGE}`) { bridge = true; return ok(); }
      if (rest === 'features list') return ok('hooks                                    stable             true\n');
      return unexpected(line);
    }
    if (cmd === 'grok') return rest === 'plugin list --json' ? ok('[]') : unexpected(line);
    if (args.at(-1) === 'doctor') return ok('doctor: 0 failure(s), 0 warning(s)\n');
    return ok();
  };
  return { run, calls };
}

// A TTY confirm that records each question and answers with answer(question).
function recordingConfirm(answer = () => false) {
  const asked = [];
  const confirm = async (q) => { asked.push(q); return answer(q); };
  return { asked, confirm };
}

const harnessStepLines = (lines) => lines.filter((l) => /^(codex|grok)-[a-z-]+: /.test(l));

test('--yes sets up both detected harnesses and records them', async () => {
  const { home } = harnessHome();
  try {
    const { run, calls } = harnessRun();
    const lines = [];
    const steps = byId(await boot(home, run, { argv: ['--yes'], log: (l) => lines.push(l) }));
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.equal(steps.harnesses.detail, 'set up codex, grok');
    assert.deepEqual(readConfig(home), { harnesses: { codex: { enabled: true }, grok: { enabled: true } } });
    // Each harness step line is logged, before the step's own line; none failed.
    const stepLines = harnessStepLines(lines);
    assert.ok(stepLines.some((l) => l.startsWith('codex-rules: done — ')), lines.join('\n'));
    assert.ok(stepLines.some((l) => l.startsWith('grok-hooks: done — ')), lines.join('\n'));
    assert.ok(!stepLines.some((l) => / failed — /.test(l)), stepLines.join('\n'));
    const own = lines.indexOf('harnesses: done — set up codex, grok');
    assert.ok(own > lines.indexOf(stepLines.at(-1)), lines.join('\n'));
    // What the syncs did: the managed section in AGENTS.md, the bridge added, the Grok hooks file through the launcher.
    assert.ok(readFileSync(codexAgentsMd(home), 'utf8').includes(BRAND.markers.start));
    assert.ok(calls.includes(`codex plugin add ${BRIDGE}`), calls.join('\n'));
    assert.ok(readFileSync(grokHooksFile(home), 'utf8').includes(`${launcherPath(home)} pre-tool-use --harness grok`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-TTY without --yes skips and records nothing', async () => {
  const { home } = harnessHome();
  try {
    const { run, calls } = harnessRun();
    const steps = byId(await boot(home, run));
    assert.equal(steps.harnesses.status, 'skipped');
    assert.match(steps.harnesses.detail, /--yes/);
    assert.equal(existsSync(methodologyConfig(home)), false);
    assert.deepEqual(harnessCalls(calls), []);
    assert.equal(existsSync(codexAgentsMd(home)), false);
    assert.equal(existsSync(grokHooksFile(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--no-harness skips', async () => {
  for (const extra of [
    { argv: ['--yes', '--no-harness'] },
    { argv: ['--no-harness'], isTTY: true, confirm: async () => false },
    { argv: ['--no-harness'] },
  ]) {
    const { home } = harnessHome();
    try {
      // grok is recorded enabled: --no-harness skips it too (no re-sync).
      writeConfig(home, { harnesses: { grok: { enabled: true } } });
      const { run, calls } = harnessRun();
      const steps = byId(await boot(home, run, extra));
      assert.equal(steps.harnesses.status, 'skipped', JSON.stringify(extra));
      assert.match(steps.harnesses.detail, /--no-harness/);
      assert.deepEqual(readConfig(home), { harnesses: { grok: { enabled: true } } });
      assert.deepEqual(harnessCalls(calls), []);
      assert.equal(existsSync(grokHooksFile(home)), false);
      assert.equal(existsSync(codexAgentsMd(home)), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('non-TTY without --yes re-syncs a recorded harness without asking and skips an unrecorded one', async () => {
  const { home } = harnessHome();
  try {
    writeConfig(home, { harnesses: { grok: { enabled: true } } });
    const { run, calls } = harnessRun();
    const lines = [];
    // confirm is `never` (boot's default): any question throws.
    const steps = byId(await boot(home, run, { log: (l) => lines.push(l) }));
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.equal(steps.harnesses.detail, 'set up grok; skipped codex: not confirmed (confirm on a terminal, or pass --yes)');
    assert.ok(lines.some((l) => l.startsWith('grok-hooks: done — ')), lines.join('\n'));
    assert.ok(readFileSync(grokHooksFile(home), 'utf8').includes(`${launcherPath(home)} pre-tool-use --harness grok`));
    // codex: not synced, not recorded.
    assert.ok(!calls.some((c) => c.startsWith('codex ')), calls.join('\n'));
    assert.equal(existsSync(codexAgentsMd(home)), false);
    assert.deepEqual(readConfig(home), { harnesses: { grok: { enabled: true } } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('methodology not installed: the harnesses step reports the skip off a TTY', async () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const { run, calls } = harnessRun();
    const harnessStep = STEPS.filter((s) => s.id === 'harnesses');
    for (const argv of [[], ['--yes'], ['--no-harness']]) {
      const { steps } = await runSteps(harnessStep, { home, argv, run, isTTY: false, confirm: never });
      assert.deepEqual(steps, [{ id: 'harnesses', status: 'skipped', detail: 'methodology not installed' }], JSON.stringify(argv));
    }
    assert.deepEqual(calls, []);
    assert.equal(existsSync(methodologyConfig(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a harness with a failed step is listed as failed with its step ids, not as set up', async () => {
  const { home } = harnessHome();
  try {
    const { run: base } = harnessRun();
    const run = async (cmd, args, opts) => (cmd === 'grok' && args.join(' ') === 'plugin list --json'
      ? { code: 1, stdout: '', stderr: 'fake: grok plugin list failed' }
      : base(cmd, args, opts));
    const lines = [];
    const steps = byId(await boot(home, run, { argv: ['--yes'], log: (l) => lines.push(l) }));
    const failedGrok = harnessStepLines(lines).filter((l) => l.startsWith('grok-') && / failed — /.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));
    assert.ok(failedGrok.length > 0, lines.join('\n'));
    assert.equal(steps.harnesses.status, 'failed');
    assert.equal(steps.harnesses.detail, `set up codex; failed grok (${failedGrok.join(', ')})`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable config.json fails the harnesses step, nothing offered or synced', async () => {
  for (const bad of ['invalid', 'dir']) {
    const { home } = harnessHome();
    try {
      if (bad === 'dir') {
        mkdirSync(methodologyConfig(home), { recursive: true }); // read fails with EISDIR
      } else {
        mkdirSync(dirname(methodologyConfig(home)), { recursive: true });
        writeFileSync(methodologyConfig(home), '{ not json');
      }
      const { run, calls } = harnessRun();
      const { asked, confirm } = recordingConfirm(() => true);
      const steps = byId(await boot(home, run, { isTTY: true, confirm }));
      assert.equal(steps.harnesses.status, 'failed', bad);
      assert.match(steps.harnesses.detail, /config\.json.*: fix it or remove it, then rerun bootstrap$/, bad);
      assert.deepEqual(asked.filter((q) => q.startsWith('Set up the methodology for ')), [], bad);
      assert.deepEqual(harnessCalls(calls), [], bad);
      assert.equal(existsSync(grokHooksFile(home)), false, bad);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('no harness detected: the step is skipped and nothing is asked', async () => {
  const { home } = harnessHome({ codex: false, grok: false });
  try {
    const { run, calls } = harnessRun();
    const { asked, confirm } = recordingConfirm(() => true);
    const steps = byId(await boot(home, run, { isTTY: true, confirm }));
    assert.equal(steps.harnesses.status, 'skipped');
    assert.equal(steps.harnesses.detail, 'no harness detected');
    assert.deepEqual(asked.filter((q) => q.startsWith('Set up the methodology for ')), []);
    assert.deepEqual(harnessCalls(calls), ['codex --version', 'grok --version']);
    assert.equal(existsSync(methodologyConfig(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('absent harness not offered', async () => {
  const { home } = harnessHome({ grok: false });
  try {
    const { run, calls } = harnessRun();
    const { asked, confirm } = recordingConfirm((q) => q === HARNESS_QUESTION('codex'));
    const steps = byId(await boot(home, run, { isTTY: true, confirm }));
    assert.deepEqual(asked.filter((q) => q.startsWith('Set up the methodology for ')), [HARNESS_QUESTION('codex')]);
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.equal(steps.harnesses.detail, 'set up codex');
    assert.deepEqual(readConfig(home), { harnesses: { codex: { enabled: true } } });
    assert.ok(calls.includes('grok --version'), calls.join('\n')); // detected absent: no dir, not on PATH
    assert.ok(!calls.some((c) => c.startsWith('grok plugin')), calls.join('\n'));
    assert.equal(existsSync(join(home, '.grok')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recorded harness re-synced without a question', async () => {
  const { home } = harnessHome();
  try {
    // grok recorded enabled: re-synced. codex recorded disabled (triqual sync --remove-harness): neither offered nor synced.
    writeConfig(home, { harnesses: { grok: { enabled: true }, codex: { enabled: false } } });
    const { run, calls } = harnessRun();
    const { asked, confirm } = recordingConfirm();
    const lines = [];
    const steps = byId(await boot(home, run, { isTTY: true, confirm, log: (l) => lines.push(l) }));
    assert.deepEqual(asked.filter((q) => q.startsWith('Set up the methodology for ')), []);
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.equal(steps.harnesses.detail, 'set up grok; skipped codex');
    assert.ok(lines.some((l) => l.startsWith('grok-hooks: done — ')), lines.join('\n'));
    assert.ok(existsSync(grokHooksFile(home)));
    assert.ok(!calls.some((c) => c.startsWith('codex ')), calls.join('\n'));
    assert.deepEqual(readConfig(home), { harnesses: { grok: { enabled: true }, codex: { enabled: false } } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--yes with a legacy AGENTS.md reports the split skip and repeats the command in the summary', async () => {
  const { home } = harnessHome({ grok: false, agentsMd: LEGACY_AGENTS_MD });
  try {
    const { run } = harnessRun();
    const lines = [];
    const steps = byId(await boot(home, run, { argv: ['--yes'], log: (l) => lines.push(l) }));
    assert.ok(lines.includes(SPLIT_SKIP_LINE), lines.join('\n'));
    // A skipped gate is not a failure; the summary line names the command to run.
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.match(steps.harnesses.detail, /^set up codex; .*run triqual sync --harness codex/);
    assert.ok(lines.includes(`harnesses: done — ${steps.harnesses.detail}`), lines.join('\n'));
    assert.equal(readFileSync(codexAgentsMd(home), 'utf8'), LEGACY_AGENTS_MD);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("syncHarness receives the installed pluginRoot and ctx's isTTY and confirm", async () => {
  const { home, installPath } = harnessHome({ grok: false, agentsMd: LEGACY_AGENTS_MD });
  try {
    // Only the installed copy carries this line: it reaches AGENTS.md only when pluginRoot is the installPath.
    const marker = 'Installed-copy marker line for the bootstrap harnesses test.';
    const globalMd = join(installPath, 'rules', 'global.md');
    writeFileSync(globalMd, `${readFileSync(globalMd, 'utf8').replace(/\n+$/, '')}\n\n${marker}\n`);
    const { run } = harnessRun();
    const { asked, confirm } = recordingConfirm((q) => q === HARNESS_QUESTION('codex') || q === SPLIT_QUESTION);
    const lines = [];
    const steps = byId(await boot(home, run, { isTTY: true, confirm, log: (l) => lines.push(l) }));
    // The TTY run reached the split prompt through ctx.confirm, after the setup question; the preview was logged.
    assert.ok(asked.indexOf(SPLIT_QUESTION) > asked.indexOf(HARNESS_QUESTION('codex')), asked.join('\n'));
    assert.ok(asked.indexOf(HARNESS_QUESTION('codex')) >= 0, asked.join('\n'));
    assert.ok(lines.includes('  - ## UNIVERSAL DEVELOPMENT RULES'), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith('codex-rules-gate: done — split ')), lines.join('\n'));
    assert.equal(steps.harnesses.status, 'done', steps.harnesses.detail);
    assert.equal(steps.harnesses.detail, 'set up codex');
    const agentsMd = readFileSync(codexAgentsMd(home), 'utf8');
    assert.ok(agentsMd.includes(marker), agentsMd);
    assert.ok(agentsMd.includes('## Spark subagent routing'));
    assert.ok(!agentsMd.includes('Old rules.'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The CLI with a fake claude and git on PATH (headjack absent) and a temp HOME. The installed methodology plugin's
// bin/doctor.mjs is a stub whose exit code the test chooses, so the real installed shim runs it; its rules/ is a copy
// of the repo's, so the rules steps sync into the temp HOME. `commonjs` puts {"type":"commonjs"} in HOME's
// package.json, which governs any extensionless file below HOME.
function cliFixture(doctorExit, { commonjs = false, legacyCli = false } = {}) {
  const home = tempHome();
  if (commonjs) writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}\n');
  if (legacyCli) {
    // An older bootstrap's launcher under the legacy name: the run installs the cm alias and the forwarder.
    mkdirSync(dirname(forwarderPath(home)), { recursive: true });
    writeFileSync(forwarderPath(home), `#!/usr/bin/env bash\n${BRAND.legacy.ownership.launcher}\nexit 0\n`, { mode: 0o755 });
  }
  const bin = join(home, 'fakebin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'git']) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho "$0 $*" >> "$HOME/calls.log"\nexit 0\n', { mode: 0o755 });
  }
  const installPath = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0');
  mkdirSync(join(installPath, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'plugins', 'methodology', 'rules'), join(installPath, 'rules'), { recursive: true });
  writeFileSync(
    join(installPath, 'bin', 'doctor.mjs'),
    `process.stdout.write('doctor: ${doctorExit ? 1 : 0} failure(s), 0 warning(s)\\n'); process.exit(${doctorExit});\n`,
  );
  marketplaceCopy(home);
  writePlugins(home, 'installed_plugins.json', {
    version: 2,
    plugins: Object.fromEntries(SYSTEM.map((name) => [`${name}@${BRAND.marketplace}`, [{
      scope: 'user', installPath: name === 'methodology' ? installPath : `/cache/${name}`, version: RELEASED[name],
    }]])),
  });
  const r = spawnSync(process.execPath, [BOOTSTRAP], {
    env: { HOME: home, PATH: bin },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { home, r };
}

test('the CLI prints one line per step and exits 0 when nothing failed', () => {
  const { home, r } = cliFixture(0);
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split('\n').filter((l) => !l.startsWith('migrate/'));
    assert.deepEqual(lines.map((l) => l.split(':')[0]), STEP_IDS);
    assert.match(lines[0], /^prereqs: done — .*headjack/);
    assert.equal(lines[1], 'migrate: already — nothing to migrate');
    assert.equal(lines[3], 'install: already — every system plugin is installed at the marketplace version');
    assert.match(lines[6], /^rules: done — managed section created in /);
    assert.match(lines.at(-1), /^doctor: done — doctor: 0 failure\(s\), 0 warning\(s\)$/);
    assert.equal(readFileSync(triqualMjsPath(home), 'utf8'), readFileSync(SHIM, 'utf8'));
    assert.equal(readlinkSync(triqualPath(home)), BRAND.cliFile);
    for (const path of [cmMjsPath(home), cmPath(home), forwarderPath(home)]) assert.equal(existsSync(path), false, path);
    assert.ok(readFileSync(join(home, 'calls.log'), 'utf8').includes(`claude plugin marketplace update ${BRAND.marketplace}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('under a {"type":"commonjs"} package.json in HOME the installed triqual, and the cm alias, still run doctor', () => {
  const { home, r } = cliFixture(0, { commonjs: true, legacyCli: true });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^doctor: done — doctor: 0 failure\(s\), 0 warning\(s\)$/m);
    // What a user on PATH runs: the triqual symlink itself, executed directly; then the cm alias the same way.
    const env = { HOME: home, PATH: dirname(process.execPath) };
    const direct = spawnSync(triqualPath(home), ['doctor'], { cwd: home, env, encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, 'doctor: 0 failure(s), 0 warning(s)\n');
    const alias = spawnSync(cmPath(home), ['doctor'], { cwd: home, env, encoding: 'utf8' });
    assert.equal(alias.status, 0, alias.stderr);
    assert.equal(alias.stdout, direct.stdout);
    assert.match(alias.stderr, new RegExp(`^${BRAND.legacy.cli} is deprecated: use ${BRAND.cli} `));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the CLI exits 1 when a step failed', () => {
  const { home, r } = cliFixture(1);
  try {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^doctor: failed — doctor: 1 failure\(s\), 0 warning\(s\)$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('importing bin/bootstrap.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(BOOTSTRAP)});`], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

const SETUP = join(ROOT, 'plugins', 'methodology', 'setup');
const MOVED = ['bootstrap.mjs', 'triqual-shim.mjs', 'triqual-hook', 'cm-alias.mjs', 'cm-hook-forwarder', 'legacy.json'];

test('the installer ships in plugins/methodology/setup/', () => {
  for (const name of MOVED) assert.ok(existsSync(join(SETUP, name)), `${name} is missing from plugins/methodology/setup/`);
  for (const name of MOVED.filter((n) => n !== 'bootstrap.mjs')) {
    assert.ok(!existsSync(join(ROOT, 'bin', name)), `bin/${name} is still there`);
  }
});

test('bin/bootstrap.mjs re-exports the setup module', async () => {
  const w = await import('../bin/bootstrap.mjs');
  const s = await import('../plugins/methodology/setup/bootstrap.mjs');
  assert.deepEqual(Object.keys(w).sort(), Object.keys(s).sort());
  assert.equal(typeof s.main, 'function');
  assert.equal(w.main, s.main);
});

test('running bin/bootstrap.mjs through a symlink runs main', () => {
  const tmp = tempHome();
  try {
    const link = join(tmp, 'bs.mjs');
    symlinkSync(BOOTSTRAP, link);
    const tmpHome = join(tmp, 'home');
    const emptyDir = join(tmp, 'empty');
    mkdirSync(tmpHome);
    mkdirSync(emptyDir);
    const r = spawnSync(process.execPath, [link, '--yes'], {
      env: { HOME: tmpHome, PATH: emptyDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /prereqs: failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
