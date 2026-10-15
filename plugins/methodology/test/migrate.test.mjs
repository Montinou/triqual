import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATE_STEPS, migrate } from '../cli/lib/migrate-steps.mjs';
import { migrateCli } from '../cli/migrate.mjs';
import { BRAND } from '../cli/lib/brand.mjs';
import { readManifest } from '../cli/lib/harness-manifest.mjs';
import { legacyScan } from '../cli/lib/legacy-scan.mjs';
import { doctor } from '../cli/doctor.mjs';
import { bootstrap, installCli } from '../../../bin/bootstrap.mjs';
import {
  ALL_PLUGINS, BRIDGE_NAME, GLOBAL, cachePath, cloneDir, codexConfigFile, dataDir, fakeMachine, installedFile, knownFile,
  legacyGrokFiles, legacyMachine, put, readJson, scopeSettings, settingsFile,
} from './fixtures/migrate-machine.mjs';

const L = BRAND.legacy;
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'migrate.mjs');
const NOW = new Date(2026, 9, 10, 9, 0, 0);
const LATER = new Date(2026, 9, 10, 10, 0, 0);
const BACKUP = (home) => join(home, '.claude', 'backups', `${BRAND.dir}-migration-20261010-090000`);
// cli runs before marketplace: the new shim resolves either id per plugin, so a run that stops after it still leaves a
// working cm, triqual, statusline and harness hooks (the old shim would point at uninstalled legacy ids).
const STEP_IDS = ['backup', 'cli', 'marketplace', 'references', 'directories', 'harnesses', 'repos', 'verify'];
const OWNER_STEP = "owner step: approve the methodology-codex hooks in Codex's trust prompt";
const ADD = `claude plugin marketplace add ${BRAND.source} --scope user`;
const T = (name) => `${name}@${BRAND.marketplace}`;
const OLD = (name) => `${name}@${L.marketplace}`;
const TRACKING_OLD = `Bash(${L.cli} tracking write:*)`;
const TRACKING_NEW = `Bash(${BRAND.cli} tracking write:*)`;
const LEGACY_FIX = `run ${BRAND.cli} migrate`;
const DIR_BASES = (home) => [join(home, '.config'), join(home, '.local', 'state'), join(home, '.local', 'share')];

const tempHome = () => realpathSync(mkdtempSync(join(tmpdir(), 'migrate-')));

async function withHome(fn) {
  const home = tempHome();
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// `<id>: <status> — <detail>` lines by id.
function parse(lines) {
  return Object.fromEntries(lines.map((line) => {
    const m = /^([a-z]+): (done|already|skipped|failed) — ([\s\S]*)$/.exec(line);
    assert.ok(m, `malformed line: ${line}`);
    return [m[1], { status: m[2], detail: m[3] }];
  }));
}

const go = (home, fake, extra = {}) => migrate({ home, run: fake.run, now: NOW, installCli, ...extra });
const claudeCalls = (calls) => calls.filter((c) => c.startsWith('claude '));
const line2 = (path) => readFileSync(path, 'utf8').split('\n')[1];

// Every path under dir: a link as its text, a dir as 'dir', a file as its bytes and mode.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = `${statSync(p).mode} ${readFileSync(p, 'base64')}`;
    }
  };
  walk(dir);
  return out;
}

test('MIGRATE_STEPS are the eight steps in order', () => {
  assert.deepEqual(MIGRATE_STEPS.map((s) => s.id), STEP_IDS);
  for (const s of MIGRATE_STEPS) assert.equal(typeof s.run, 'function');
});

test('full legacy machine migrates; second run makes no call and is all already/skipped', () => withHome(async (home) => {
  legacyMachine(home, { codex: true, grok: true });
  const originalSettings = readFileSync(settingsFile(home), 'utf8');
  const fake = fakeMachine(home);
  const logged = [];
  const first = await go(home, fake, { log: (l) => logged.push(l) });
  assert.equal(first.code, 0, first.lines.join('\n'));
  assert.deepEqual(logged, first.lines);
  const s = parse(first.lines);
  assert.deepEqual(Object.keys(s), STEP_IDS);
  for (const id of STEP_IDS.slice(0, -2)) assert.equal(s[id].status, 'done', `${id}: ${s[id].detail}`);
  assert.equal(s.verify.status, 'already', s.verify.detail);

  // marketplace: add, install methodology (its dependencies come with it) and memory-report, disable what the legacy
  // id had off, uninstall every legacy id keeping its data, then remove the legacy marketplace.
  assert.deepEqual(claudeCalls(fake.calls), [
    ADD,
    `claude plugin install ${T('methodology')} --scope user`,
    `claude plugin install ${T('memory-report')} --scope user`,
    `claude plugin disable ${T('memory-report')} --scope user`,
    ...ALL_PLUGINS.map((name) => `claude plugin uninstall ${OLD(name)} --scope user --keep-data`),
    `claude plugin marketplace remove ${L.marketplace}`,
  ]);
  assert.match(s.marketplace.detail, /\/reload-plugins/);
  const installed = readJson(installedFile(home)).plugins;
  assert.deepEqual(Object.keys(installed).sort(), ALL_PLUGINS.map(T).sort());
  assert.equal(installed[T('progress-tracking')][0].auto, true, 'installed as a dependency of methodology');
  assert.deepEqual(Object.keys(readJson(knownFile(home))), [BRAND.marketplace]);
  assert.ok(existsSync(dataDir(home, 'methodology', L.marketplace)), '--keep-data keeps the legacy plugin data');

  // references: no legacy key left, the triqual allow rule next to the cm one, the managed section under the new
  // markers (its body was current, so drift alone would never have rewritten it).
  const settings = readJson(settingsFile(home));
  assert.deepEqual(settings.enabledPlugins, {
    [T('methodology')]: true, [T('progress-tracking')]: true, [T('workflow-gate')]: true, [T('roles')]: true,
    [T('memory-report')]: false,
  });
  assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), [BRAND.marketplace]);
  assert.deepEqual(settings.permissions.allow, ['Bash(git status:*)', TRACKING_OLD, TRACKING_NEW]);
  assert.equal(settings.model, 'opus');
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
    `# Mine\n\n${BRAND.markers.start}\n${GLOBAL.trim()}\n${BRAND.markers.end}\n\n## Local\n`);

  // directories: moved, a relative link left at each legacy path.
  for (const base of DIR_BASES(home)) {
    assert.equal(readlinkSync(join(base, L.dir)), BRAND.dir);
    assert.ok(lstatSync(join(base, BRAND.dir)).isDirectory());
  }
  assert.ok(existsSync(join(home, '.local', 'share', BRAND.dir, 'role-eval', 'store.json')));

  // cli: the older shim and launcher became the alias and the forwarder; triqual is installed.
  const bin = join(home, '.local', 'bin');
  assert.equal(line2(join(bin, L.cliFile)), BRAND.ownership.alias);
  assert.equal(line2(join(bin, L.launcher)), BRAND.ownership.forwarder);
  assert.equal(readlinkSync(join(bin, BRAND.cli)), BRAND.cliFile);

  assert.ok(s.harnesses.detail.endsWith(OWNER_STEP), s.harnesses.detail);
  // repos only lists (it changes nothing), so it is skipped even while a repo is on the cm gate.
  assert.equal(s.repos.status, 'skipped');
  assert.ok(s.repos.detail.includes(join(home, 'work', 'app')), s.repos.detail);

  // backup: what the spec lists, mirrored under the run's dir, private.
  const backup = BACKUP(home);
  assert.equal(statSync(backup).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(backup, '.claude', 'settings.json'), 'utf8'), originalSettings);
  for (const rel of [
    ['.claude', 'CLAUDE.md'], ['.claude', 'plugins', 'installed_plugins.json'], ['.claude', 'plugins', 'known_marketplaces.json'],
    ['.codex', 'config.toml'], ['.codex', 'AGENTS.md'], ['.grok', 'hooks', `${L.grokName}.json`],
    ['.grok', 'rules', `${L.grokName}.md`], ['.config', L.dir, 'harnesses.json'], ['.config', L.dir, 'config.json'],
    ['.local', 'state', L.dir, 'last-run-codex'], ['.local', 'share', L.dir, 'role-eval', 'store.json'],
    ['.local', 'bin', L.cliFile], ['.local', 'bin', L.launcher],
  ]) {
    assert.ok(existsSync(join(backup, ...rel)), rel.join('/'));
  }
  assert.equal(readlinkSync(join(backup, '.local', 'bin', L.cli)), L.cliFile);
  assert.equal(statSync(join(backup, '.local', 'bin', L.cliFile)).mode & 0o777, 0o600);

  // verify: the scan is clean, legacy markers included.
  assert.deepEqual(legacyScan(home).failures, []);

  // The registered repo is still on the cm gate: the second run lists it again and changes nothing.
  const before = snapshot(home);
  const again = fakeMachine(home);
  const second = await migrate({ home, run: again.run, now: LATER, installCli });
  assert.equal(second.code, 0, second.lines.join('\n'));
  assert.deepEqual(again.calls, []);
  const s2 = parse(second.lines);
  for (const id of STEP_IDS) assert.ok(['already', 'skipped'].includes(s2[id].status), `${id}: ${s2[id].status} — ${s2[id].detail}`);
  assert.equal(s2.repos.detail, s.repos.detail);
  assert.equal(s2.verify.status, 'already');
  assert.deepEqual(snapshot(home), before);
}));

test('fresh machine: no claude call, all already or skipped', () => withHome(async (home) => {
  put(settingsFile(home), { model: 'opus' });
  put(join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
  put(join(home, '.config', BRAND.dir, 'config.json'), '{}\n'); // a triqual-first install: never legacy, never linked
  const before = snapshot(home);
  for (const cli of [installCli, undefined]) {
    const fake = fakeMachine(home);
    const r = await go(home, fake, { installCli: cli });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const s = parse(r.lines);
    assert.deepEqual(Object.keys(s), STEP_IDS);
    for (const id of STEP_IDS) assert.ok(['already', 'skipped'].includes(s[id].status), `${id}: ${s[id].status} — ${s[id].detail}`);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(snapshot(home), before);
  }
}));

const FOREIGN_CLI = '#!/bin/sh\n# some other tool\nexec other "$@"\n';
const LEFT_TO_SHIM = 'left to the shim step';

test(`a foreign ${L.cli}, ${L.cliFile} or ${L.launcher} on a fresh machine: cli step already/skipped with no "left to the shim step" text`, async () => {
  for (const name of [L.cli, L.cliFile, L.launcher]) {
    await withHome(async (home) => {
      put(settingsFile(home), { model: 'opus' });
      put(join(home, '.config', BRAND.dir, 'config.json'), '{}\n');
      const path = join(home, '.local', 'bin', name);
      put(path, FOREIGN_CLI);
      const before = snapshot(home);
      for (const cli of [installCli, undefined]) {
        const fake = fakeMachine(home);
        const r = await go(home, fake, { installCli: cli });
        assert.equal(r.code, 0, `${name}: ${r.lines.join('\n')}`);
        const s = parse(r.lines);
        assert.ok(['already', 'skipped'].includes(s.cli.status), `${name}: ${s.cli.status} — ${s.cli.detail}`);
        assert.ok(!s.cli.detail.includes(LEFT_TO_SHIM), `${name}: ${s.cli.detail}`);
        assert.deepEqual(fake.calls, []);
        assert.deepEqual(snapshot(home), before);
      }
    });
  }
});

test(`on a legacy machine a foreign ${L.cli} beside our ${L.launcher} is still left to the shim step`, () => withHome(async (home) => {
  put(settingsFile(home), { model: 'opus' });
  const bin = join(home, '.local', 'bin');
  put(join(bin, L.launcher), `#!/usr/bin/env bash\n${BRAND.ownership.forwarder}\nexit 0\n`);
  put(join(bin, L.cli), FOREIGN_CLI);
  const before = snapshot(home);
  const r = await go(home, fakeMachine(home));
  const s = parse(r.lines);
  assert.equal(s.cli.status, 'skipped', s.cli.detail);
  assert.ok(s.cli.detail.includes(join(bin, L.cli)), s.cli.detail);
  assert.ok(s.cli.detail.includes(LEFT_TO_SHIM), s.cli.detail);
  assert.deepEqual(snapshot(home), before);
}));

test('disabled legacy plugin stays disabled', () => withHome(async (home) => {
  // roles comes back with methodology (a fresh install is enabled), memory-report on its own: both are disabled again.
  legacyMachine(home, { disabled: ['memory-report', 'roles'] });
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const calls = claudeCalls(fake.calls);
  assert.ok(calls.includes(`claude plugin disable ${T('roles')} --scope user`), calls.join('\n'));
  assert.ok(calls.includes(`claude plugin disable ${T('memory-report')} --scope user`), calls.join('\n'));
  assert.equal(calls.filter((c) => c.includes(' disable ')).length, 2);
  const enabled = readJson(settingsFile(home)).enabledPlugins;
  assert.equal(enabled[T('roles')], false);
  assert.equal(enabled[T('memory-report')], false);
  assert.equal(enabled[T('methodology')], true);
}));

test('interrupted after step 4 uninstalled methodology@<legacy>: a rerun does not disable methodology@triqual', () => withHome(async (home) => {
  legacyMachine(home);
  // One uninstall fails: the others still run, the legacy marketplace stays, and the step fails naming what is left.
  const first = fakeMachine(home, { failUninstall: [OLD('progress-tracking')] });
  const r1 = await go(home, first);
  assert.equal(r1.code, 1);
  const s1 = parse(r1.lines);
  assert.equal(s1.marketplace.status, 'failed');
  assert.match(s1.marketplace.detail, new RegExp(`still installed: ${OLD('progress-tracking')}`));
  assert.equal(first.calls.some((c) => c.includes('marketplace remove')), false);
  for (const id of STEP_IDS.slice(STEP_IDS.indexOf('marketplace') + 1)) {
    assert.deepEqual(s1[id], { status: 'skipped', detail: 'marketplace failed' });
  }
  assert.ok(Object.hasOwn(readJson(knownFile(home)), L.marketplace));
  const settings = readJson(settingsFile(home));
  assert.equal(Object.hasOwn(settings.enabledPlugins, OLD('methodology')), false, 'uninstall deleted its key');
  assert.equal(settings.enabledPlugins[T('methodology')], true);

  const second = fakeMachine(home);
  const r2 = await go(home, second, { now: LATER });
  assert.equal(r2.code, 0, r2.lines.join('\n'));
  assert.deepEqual(claudeCalls(second.calls), [
    `claude plugin uninstall ${OLD('progress-tracking')} --scope user --keep-data`,
    `claude plugin marketplace remove ${L.marketplace}`,
  ]);
  assert.equal(readJson(settingsFile(home)).enabledPlugins[T('methodology')], true);
  assert.equal(readJson(settingsFile(home)).enabledPlugins[T('memory-report')], false);
}));

test('a legacy entry at project scope is installed and uninstalled at that scope, in its project', () => withHome(async (home) => {
  const project = join(home, 'work', 'app');
  legacyMachine(home, { extra: [{ id: OLD('roles'), scope: 'project', projectPath: project }] });
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const at = (line) => fake.cwds[fake.calls.indexOf(line)];
  const install = `claude plugin install ${T('roles')} --scope project`;
  const uninstall = `claude plugin uninstall ${OLD('roles')} --scope project --keep-data`;
  assert.equal(at(install), project);
  assert.equal(at(uninstall), project);
  assert.equal(at(`claude plugin uninstall ${OLD('roles')} --scope user --keep-data`), home);
  const entries = readJson(installedFile(home)).plugins[T('roles')];
  assert.deepEqual(entries.map((e) => e.scope).sort(), ['project', 'user']);
  assert.deepEqual(readJson(scopeSettings(home, 'project', project)).enabledPlugins, { [T('roles')]: true });
}));

test('both config dirs present: marketplace fails naming both before any claude call; cm and triqual still resolve', () => withHome(async (home) => {
  legacyMachine(home);
  const current = join(home, '.config', BRAND.dir);
  put(join(current, 'config.json'), '{"mine":true}\n');
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 1);
  const s = parse(r.lines);
  assert.equal(s.cli.status, 'done', s.cli.detail);
  assert.equal(s.marketplace.status, 'failed');
  assert.ok(s.marketplace.detail.includes(join(home, '.config', L.dir)), s.marketplace.detail);
  assert.ok(s.marketplace.detail.includes(current), s.marketplace.detail);
  assert.match(s.marketplace.detail, /nothing was uninstalled/);
  assert.deepEqual(claudeCalls(fake.calls), []);
  assert.ok(Object.hasOwn(readJson(installedFile(home)).plugins, OLD('methodology')), 'the legacy installs stay');
  for (const base of DIR_BASES(home)) {
    assert.ok(lstatSync(join(base, L.dir)).isDirectory() && !lstatSync(join(base, L.dir)).isSymbolicLink(), base);
  }
  assert.equal(existsSync(join(home, '.local', 'state', BRAND.dir)), false);
  assert.equal(readFileSync(join(current, 'config.json'), 'utf8'), '{"mine":true}\n');
  for (const id of ['references', 'directories', 'harnesses', 'repos', 'verify']) {
    assert.deepEqual(s[id], { status: 'skipped', detail: 'marketplace failed' });
  }
  // The cm alias and the triqual shim both run a command from the legacy methodology install, still the only one.
  const doctorFile = join(cachePath(home, L.marketplace, 'methodology'), 'bin', 'doctor.mjs');
  put(doctorFile, 'process.exit(6);\n');
  const bin = join(home, '.local', 'bin');
  for (const name of [L.cli, BRAND.cli]) {
    const ran = spawnSync(process.execPath, [join(bin, name), 'doctor'], {
      cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(ran.status, 6, `${name}: ${ran.stderr}`);
  }
}));

test('a failure names this run\'s backup dir, and the first run\'s dir as the pre-migration copies', () => withHome(async (home) => {
  legacyMachine(home);
  put(join(home, '.config', BRAND.dir, 'config.json'), '{"mine":true}\n');
  const first = parse((await go(home, fakeMachine(home))).lines);
  assert.ok(first.marketplace.detail.endsWith(`; the pre-migration copies are in ${BACKUP(home)}`), first.marketplace.detail);
  const second = parse((await go(home, fakeMachine(home), { now: LATER })).lines);
  const later = join(home, '.claude', 'backups', `${BRAND.dir}-migration-20261010-100000`);
  assert.ok(second.marketplace.detail.endsWith(`; this run's copies are in ${later}; the pre-migration copies are in `
    + `${BACKUP(home)}`), second.marketplace.detail);
}));

test('a legacy entry at local scope is installed and uninstalled at that scope, in its project', () => withHome(async (home) => {
  const project = join(home, 'work', 'app');
  legacyMachine(home, { extra: [{ id: OLD('roles'), scope: 'local', projectPath: project }] });
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const at = (line) => fake.cwds[fake.calls.indexOf(line)];
  assert.equal(at(`claude plugin install ${T('roles')} --scope local`), project);
  assert.equal(at(`claude plugin uninstall ${OLD('roles')} --scope local --keep-data`), project);
  assert.deepEqual(readJson(scopeSettings(home, 'local', project)).enabledPlugins, { [T('roles')]: true });
}));

test('a legacy entry whose project is gone is reported and does not block the marketplace step', () => withHome(async (home) => {
  legacyMachine(home);
  const gone = join(home, 'work', 'deleted');
  const installed = readJson(installedFile(home));
  installed.plugins[OLD('roles')].push({ scope: 'project', installPath: '/x', version: '0.1.0', projectPath: gone });
  put(installedFile(home), installed);
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  const s = parse(r.lines);
  assert.equal(s.marketplace.status, 'done', s.marketplace.detail);
  assert.ok(s.marketplace.detail.includes(`${OLD('roles')} (project in ${gone}, which no longer exists)`), s.marketplace.detail);
  assert.equal(fake.calls.some((c) => c.includes('--scope project')), false, fake.calls.join('\n'));
  assert.ok(fake.calls.includes(`claude plugin marketplace remove ${L.marketplace}`));
  assert.equal(r.code, 0, r.lines.join('\n'));
}));

test('Codex recorded but disabled: its legacy tables and records stay, and verify names the codex commands', () => withHome(async (home) => {
  legacyMachine(home, { codex: true });
  put(join(home, '.config', L.dir, 'config.json'), { harnesses: { codex: { enabled: false } } });
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(fake.calls.some((c) => c.startsWith('codex ')), false, fake.calls.join('\n'));
  const records = readManifest(home).harnesses.codex.plugins.map((p) => p.id);
  assert.deepEqual(records, [L.marketplace, `${BRIDGE_NAME}@${L.marketplace}`, 'hooks']);
  const s = parse(r.lines);
  assert.equal(s.verify.status, 'failed');
  assert.ok(s.verify.detail.includes(`run codex plugin remove ${BRIDGE_NAME}@${L.marketplace}`), s.verify.detail);
  assert.ok(s.verify.detail.includes(`run codex plugin marketplace remove ${L.marketplace}`), s.verify.detail);
}));

test('legacy installs without the legacy marketplace: marketplace says so, verify names the uninstall', () => withHome(async (home) => {
  legacyMachine(home, { plugins: ['roles'], repo: false });
  put(knownFile(home), {});
  const r = await go(home, fakeMachine(home));
  const s = parse(r.lines);
  assert.equal(s.marketplace.status, 'skipped');
  assert.ok(s.marketplace.detail.includes(OLD('roles')), s.marketplace.detail);
  assert.ok(s.verify.detail.includes(`installs ${OLD('roles')}: run claude plugin uninstall ${OLD('roles')} --scope user`),
    s.verify.detail);
}));

test('leftovers migrate cannot clear take no backup: a second run writes no file', () => withHome(async (home) => {
  put(settingsFile(home), { permissions: { allow: [`Read(~/.claude/plugins/cache/${L.marketplace}/**)`] } });
  const before = snapshot(home);
  for (const now of [NOW, LATER]) {
    const fake = fakeMachine(home);
    const r = await go(home, fake, { now });
    const s = parse(r.lines);
    assert.equal(s.backup.status, 'skipped', s.backup.detail);
    assert.equal(s.verify.status, 'failed');
    assert.ok(s.verify.detail.endsWith(`remove permissions.allow[0] from ${settingsFile(home)}`), s.verify.detail);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(snapshot(home), before);
  }
}));

test('a move interrupted before its link: the rerun leaves the compatibility link', () => withHome(async (home) => {
  legacyMachine(home);
  assert.equal((await go(home, fakeMachine(home))).code, 0);
  const legacy = join(home, '.config', L.dir);
  rmSync(legacy); // as if the run died between the rename and the link
  const r = await go(home, fakeMachine(home), { now: LATER });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const s = parse(r.lines);
  assert.equal(s.directories.status, 'done', s.directories.detail);
  assert.equal(readlinkSync(legacy), BRAND.dir);
}));

test('a compatibility link whose new dir is gone is fine: a rerun fails nothing and verify is clean', () => withHome(async (home) => {
  legacyMachine(home);
  assert.equal((await go(home, fakeMachine(home))).code, 0);
  rmSync(join(home, '.local', 'state', BRAND.dir), { recursive: true, force: true }); // brandDir recreates it on a write
  const r = await go(home, fakeMachine(home), { now: LATER });
  const s = parse(r.lines);
  for (const id of STEP_IDS) assert.notEqual(s[id].status, 'failed', `${id}: ${s[id].detail}`);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(legacyScan(home).failures, []);
  const steps = (await bootstrap({ home, argv: [], run: fakeMachine(home).run, isTTY: false, confirm: async () => false,
    now: LATER })).steps;
  assert.notEqual(steps.find((x) => x.id === 'migrate').status, 'failed');
  const { failures } = await doctor({ home, cwd: home, run: fakeMachine(home).run });
  assert.equal(failures.filter((f) => f.endsWith(LEGACY_FIX)).length, 0, failures.join('\n'));
}));

test('a link elsewhere or a plain file at a legacy dir path is skipped and named, with "move it aside" as the fix', () => withHome(async (home) => {
  legacyMachine(home);
  assert.equal((await go(home, fakeMachine(home))).code, 0);
  const state = join(home, '.local', 'state', L.dir);
  const share = join(home, '.local', 'share', L.dir);
  rmSync(state);
  symlinkSync(join(home, 'elsewhere'), state);
  rmSync(share);
  writeFileSync(share, 'a plain file\n');
  const r = await go(home, fakeMachine(home), { now: LATER });
  const s = parse(r.lines);
  assert.equal(s.directories.status, 'skipped', s.directories.detail);
  assert.ok(s.directories.detail.includes(state) && s.directories.detail.includes(share), s.directories.detail);
  assert.equal(s.verify.status, 'failed');
  for (const path of [state, share]) assert.ok(s.verify.detail.includes(`: move ${path} aside`), s.verify.detail);
  assert.equal(s.verify.detail.includes(LEGACY_FIX), false, s.verify.detail);
  const by = Object.fromEntries((await bootstrap({ home, argv: [], run: fakeMachine(home).run, isTTY: false,
    confirm: async () => false, now: LATER })).steps.map((x) => [x.id, x]));
  assert.match(by.migrate.detail, /^2 leftovers: run /);
  assert.notEqual(by.install.status, 'skipped');
}));

test('every legacy Codex plugin table is removed through codex plugin remove, not only the bridge', () => withHome(async (home) => {
  legacyMachine(home, { codex: true });
  const other = `other-plugin@${L.marketplace}`;
  writeFileSync(codexConfigFile(home), `${readFileSync(codexConfigFile(home), 'utf8')}\n[plugins."${other}"]\nenabled = true\n`);
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(fake.calls.includes(`codex plugin remove ${other}`), fake.calls.join('\n'));
  assert.equal(readFileSync(codexConfigFile(home), 'utf8').includes(other), false);
}));

test('codex not on PATH: the harnesses step is skipped, verify names the codex commands, a rerun writes no file', () => withHome(async (home) => {
  legacyMachine(home, { codex: true });
  const r = await go(home, fakeMachine(home, { codexMissing: true }));
  const s = parse(r.lines);
  assert.equal(s.harnesses.status, 'skipped', s.harnesses.detail);
  assert.match(s.harnesses.detail, /codex/);
  assert.equal(s.verify.status, 'failed');
  assert.ok(s.verify.detail.includes(`run codex plugin remove ${BRIDGE_NAME}@${L.marketplace}`), s.verify.detail);
  assert.ok(s.verify.detail.includes(`run codex plugin marketplace remove ${L.marketplace}`), s.verify.detail);
  assert.equal(s.verify.detail.includes(`: ${LEGACY_FIX}`), false, s.verify.detail);
  const before = snapshot(home);
  const again = await go(home, fakeMachine(home, { codexMissing: true }), { now: LATER });
  assert.equal(parse(again.lines).backup.status, 'skipped');
  assert.deepEqual(snapshot(home), before);
}));

test('a legacy install whose project is gone is inert: the scan exempts it, verify prints no fix for it', () => withHome(async (home) => {
  legacyMachine(home, { plugins: ['roles'], repo: false });
  put(knownFile(home), {});
  const gone = join(home, 'work', 'deleted');
  put(installedFile(home), { version: 2, plugins: { [OLD('roles')]: [{ scope: 'project', installPath: '/x', projectPath: gone }] } });
  const { failures, exempt } = legacyScan(home);
  assert.equal(failures.some((f) => f.includes(`installs ${OLD('roles')}`)), false, failures.join('\n'));
  assert.ok(exempt.some((e) => e.includes(OLD('roles')) && e.includes(gone)), exempt.join('\n'));
  const s = parse((await go(home, fakeMachine(home))).lines);
  assert.equal(s.verify.status === 'failed' && s.verify.detail.includes(OLD('roles')), false, s.verify.detail);
}));

test('backup failure stops before any change', () => withHome(async (home) => {
  legacyMachine(home);
  put(join(home, '.claude', 'backups'), 'not a directory\n');
  const before = snapshot(home);
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 1);
  const s = parse(r.lines);
  assert.equal(s.backup.status, 'failed');
  for (const id of STEP_IDS.slice(1)) assert.deepEqual(s[id], { status: 'skipped', detail: 'backup failed' });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(snapshot(home), before);
}));

test('interrupted after marketplace resumes at references', () => withHome(async (home) => {
  legacyMachine(home);
  // The process dies right after the marketplace step (its line is the last thing it does).
  const first = fakeMachine(home);
  const interrupt = (line) => { if (line.startsWith('marketplace:')) throw new Error('killed'); };
  await assert.rejects(go(home, first, { log: interrupt }), /killed/);
  assert.deepEqual(Object.keys(readJson(knownFile(home))), [BRAND.marketplace]);
  assert.ok(lstatSync(join(home, '.config', L.dir)).isDirectory(), 'directories did not run');

  const second = fakeMachine(home);
  const r2 = await go(home, second, { now: LATER });
  assert.equal(r2.code, 0, r2.lines.join('\n'));
  const s2 = parse(r2.lines);
  assert.equal(s2.marketplace.status, 'already');
  assert.deepEqual(claudeCalls(second.calls), []);
  assert.equal(s2.references.status, 'done');
  assert.equal(s2.directories.status, 'done');
  assert.ok(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').includes(BRAND.markers.start));
}));

test('a CLAUDE.md the rules gate refuses is left to sync: references does not fail, verify names it', () => withHome(async (home) => {
  legacyMachine(home);
  const claudeMd = join(home, '.claude', 'CLAUDE.md');
  const unsplit = `${readFileSync(claudeMd, 'utf8')}\n## UNIVERSAL DEVELOPMENT RULES\n\nold\n`;
  writeFileSync(claudeMd, unsplit);
  const r = await go(home, fakeMachine(home));
  const s = parse(r.lines);
  assert.equal(s.references.status, 'done', s.references.detail); // the settings.json keys still went
  assert.match(s.references.detail, /UNIVERSAL DEVELOPMENT RULES/);
  for (const id of ['directories', 'cli']) assert.equal(s[id].status, 'done', `${id}: ${s[id].detail}`);
  assert.equal(readFileSync(claudeMd, 'utf8'), unsplit);
  assert.equal(s.verify.status, 'failed');
  assert.ok(s.verify.detail.includes(`${claudeMd} holds the ${L.marketplace} managed markers: run ${BRAND.cli} sync`),
    s.verify.detail);
  assert.equal(r.code, 1);
}));

test('memory-report not installed is not installed', () => withHome(async (home) => {
  legacyMachine(home, { plugins: ALL_PLUGINS.filter((n) => n !== 'memory-report') });
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(fake.calls.some((c) => c.includes('memory-report')), false, fake.calls.join('\n'));
  assert.equal(Object.hasOwn(readJson(installedFile(home)).plugins, T('memory-report')), false);
}));

test('Codex and Grok fixtures: one bridge, one grok hooks file, harnesses.json ids rewritten', () => withHome(async (home) => {
  legacyMachine(home, { codex: true, grok: true });
  const legacyRecord = readJson(join(home, '.config', L.dir, 'harnesses.json')).harnesses.grok.files[0];
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const codex = fake.calls.filter((c) => c.startsWith('codex plugin ') && !c.includes(' list '));
  assert.deepEqual(codex, [
    `codex plugin remove ${BRIDGE_NAME}@${L.marketplace}`,
    `codex plugin marketplace remove ${L.marketplace}`,
    `codex plugin marketplace add ${cloneDir(home, BRAND.marketplace)}`,
    `codex plugin add ${BRIDGE_NAME}@${BRAND.marketplace}`,
  ]);
  const toml = readFileSync(codexConfigFile(home), 'utf8');
  assert.deepEqual([...toml.matchAll(/^\[plugins\."([^"]+)"\]$/gm)].map((m) => m[1]), [`${BRIDGE_NAME}@${BRAND.marketplace}`]);
  assert.deepEqual([...toml.matchAll(/^\[marketplaces\.([^\]]+)\]$/gm)].map((m) => m[1]), [BRAND.marketplace]);
  assert.ok(toml.includes(`[hooks.state."${BRIDGE_NAME}@${L.marketplace}:hooks/hooks.json:stop:0:0"]`), 'trust tables are Codex-owned');
  assert.equal(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8').includes(L.markers.start), false);
  assert.deepEqual(readdirSync(join(home, '.grok', 'hooks')), [`${BRAND.grokName}.json`]);
  assert.deepEqual(readdirSync(join(home, '.grok', 'rules')), [`${BRAND.grokName}.md`]);

  const manifest = readManifest(home);
  const keys = manifest.harnesses.codex.plugins.map((p) => `${p.id} ${p.action}`);
  assert.deepEqual(keys, [
    `${BRAND.marketplace} marketplace-added`, `${BRIDGE_NAME}@${BRAND.marketplace} added`, 'hooks feature-enabled',
  ]);
  const files = manifest.harnesses.grok.files;
  assert.equal(files.some((f) => f.path.includes(L.grokName)), false);
  // The pre-sync backup of the legacy rules file now restores the new one on --remove-harness.
  const rules = files.find((f) => f.path === join(home, '.grok', 'rules', `${BRAND.grokName}.md`));
  assert.equal(rules.backup, legacyRecord.backup);
  assert.ok(parse(r.lines).harnesses.detail.endsWith(OWNER_STEP));
}));

test('legacy Grok files are removed, backed up first, when Grok is not set up', () => withHome(async (home) => {
  legacyMachine(home, { grok: true, grokRecorded: false });
  const contents = legacyGrokFiles(home).map((p) => readFileSync(p, 'utf8'));
  const fake = fakeMachine(home);
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(parse(r.lines).harnesses.status, 'done');
  for (const path of legacyGrokFiles(home)) assert.equal(existsSync(path), false, path);
  assert.deepEqual(readdirSync(join(home, '.grok', 'hooks')), []);
  assert.deepEqual(readdirSync(join(home, '.grok', 'rules')), []);
  legacyGrokFiles(home).forEach((path, i) => {
    assert.equal(readFileSync(join(BACKUP(home), relative(home, path)), 'utf8'), contents[i]);
  });
  assert.equal(fake.calls.some((c) => c.startsWith('grok ')), false);
}));

test('grok not on PATH: a set-up Grok still gets its files renamed, its plugin step is skipped, migrate does not fail', () => withHome(async (home) => {
  legacyMachine(home, { grok: true });
  const fake = fakeMachine(home, { grokMissing: true });
  const r = await go(home, fake);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const s = parse(r.lines);
  assert.equal(s.harnesses.status, 'done', s.harnesses.detail);
  assert.match(s.harnesses.detail, /grok is not on PATH/);
  for (const path of legacyGrokFiles(home)) assert.equal(existsSync(path), false, path);
  assert.deepEqual(readdirSync(join(home, '.grok', 'hooks')), [`${BRAND.grokName}.json`]);
  assert.deepEqual(readdirSync(join(home, '.grok', 'rules')), [`${BRAND.grokName}.md`]);
  assert.deepEqual(legacyScan(home).failures, []);
}));

test('verify fails on a file the scan could not read', () => withHome(async (home) => {
  mkdirSync(join(home, '.codex', 'AGENTS.md'), { recursive: true }); // a dir where a file is read: EISDIR
  const r = await go(home, fakeMachine(home));
  assert.equal(r.code, 1);
  const s = parse(r.lines);
  assert.equal(s.verify.status, 'failed');
  assert.match(s.verify.detail, new RegExp(`could not read ${join(home, '.codex', 'AGENTS.md')}`));
}));

test('doctor on the migrated temp HOME has no legacy failure', () => withHome(async (home) => {
  legacyMachine(home, { codex: true, grok: true });
  const fake = fakeMachine(home);
  assert.equal((await go(home, fake)).code, 0);
  const { failures } = await doctor({ home, cwd: home, run: fake.run });
  const legacy = failures.filter((f) => f.endsWith(LEGACY_FIX));
  assert.deepEqual(legacy, []);
}));

test('bootstrap: migrate runs before marketplace; a failed migrate blocks marketplace and the rules steps', () => withHome(async (home) => {
  legacyMachine(home);
  const fake = fakeMachine(home);
  const logged = [];
  const ok = await bootstrap({ home, argv: [], run: fake.run, isTTY: false, confirm: async () => false, now: NOW,
    log: (l) => logged.push(l) });
  const ids = ok.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 3), ['prereqs', 'migrate', 'marketplace']);
  const steps = Object.fromEntries(ok.steps.map((s) => [s.id, s]));
  assert.equal(steps.migrate.status, 'done', steps.migrate.detail);
  // migrate's own lines are logged before bootstrap's line for the step.
  const sub = logged.filter((l) => l.startsWith('migrate/')).map((l) => l.slice('migrate/'.length));
  assert.deepEqual(Object.keys(parse(sub)), STEP_IDS);
  const own = logged.indexOf(`migrate: ${steps.migrate.status} — ${steps.migrate.detail}`);
  assert.ok(own > logged.findLastIndex((l) => l.startsWith('migrate/')), logged.join('\n'));
  const claude = claudeCalls(fake.calls);
  assert.ok(claude.indexOf(`claude plugin marketplace remove ${L.marketplace}`)
    < claude.indexOf(`claude plugin marketplace update ${BRAND.marketplace}`), claude.join('\n'));

  const failing = tempHome();
  try {
    legacyMachine(failing);
    // The remote manifest still says the legacy name: the add changes nothing, and migrate stops before any uninstall.
    const stuck = fakeMachine(failing, { manifestName: L.marketplace });
    const r = await bootstrap({ home: failing, argv: [], run: stuck.run, isTTY: false, confirm: async () => false, now: NOW });
    const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    assert.equal(by.migrate.status, 'failed');
    assert.match(by.migrate.detail, /^marketplace: failed — /);
    for (const id of ['marketplace', 'install', 'shim', 'rules-gate', 'rules', 'legacy-agents', 'legacy-gate', 'supersedes', 'harnesses']) {
      assert.deepEqual(by[id], { id, status: 'skipped', detail: 'migrate failed' });
    }
    assert.deepEqual(claudeCalls(stuck.calls), ['claude --version', ADD]);
    assert.ok(Object.hasOwn(readJson(installedFile(failing)).plugins, OLD('methodology')));
  } finally {
    rmSync(failing, { recursive: true, force: true });
  }
}));

const unsplitCodex = (home) => {
  const agentsMd = join(home, '.codex', 'AGENTS.md');
  writeFileSync(agentsMd, `${readFileSync(agentsMd, 'utf8')}\n## UNIVERSAL DEVELOPMENT RULES\n\nOld rules.\n`);
  return agentsMd;
};

test('bootstrap: leftovers migrate cannot clear do not block install, shim and doctor; doctor names their fixes', () => withHome(async (home) => {
  legacyMachine(home, { codex: true });
  const agentsMd = unsplitCodex(home);
  const settings = readJson(settingsFile(home));
  const rule = `Read(~/.claude/plugins/cache/${L.marketplace}/**)`;
  settings.permissions.allow.push(rule);
  put(settingsFile(home), settings);
  const fake = fakeMachine(home);
  const r = await bootstrap({ home, argv: [], run: fake.run, isTTY: false, confirm: async () => false, now: NOW });
  const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.deepEqual(by.migrate, { id: 'migrate', status: 'done', detail: `2 leftovers: run ${BRAND.cli} doctor` });
  for (const id of ['marketplace', 'install', 'shim', 'rules', 'harnesses', 'doctor']) {
    assert.notEqual(by[id].status, 'skipped', `${id}: ${by[id].detail}`);
  }
  const { failures } = await doctor({ home, cwd: home, run: fake.run });
  const allow = readJson(settingsFile(home)).permissions.allow;
  const at = allow.indexOf(rule);
  assert.ok(failures.includes(`${agentsMd} holds the ${L.marketplace} managed markers: run ${BRAND.cli} sync --harness `
    + 'codex in a terminal'), failures.join('\n'));
  assert.ok(failures.includes(`${settingsFile(home)} has a permission rule naming ${L.marketplace} (permissions.allow[${at}]): `
    + `remove permissions.allow[${at}] from ${settingsFile(home)}`), failures.join('\n'));
  assert.equal(failures.filter((f) => f.endsWith(LEGACY_FIX)).length, 0, failures.join('\n'));

  const before = snapshot(home);
  const again = fakeMachine(home);
  const second = await migrate({ home, run: again.run, now: LATER, installCli });
  assert.equal(second.code, 1);
  assert.deepEqual(again.calls, []);
  assert.deepEqual(snapshot(home), before);
}));

test('bootstrap on a terminal: the one-time AGENTS.md split can happen during migrate', () => withHome(async (home) => {
  legacyMachine(home, { codex: true });
  const agentsMd = unsplitCodex(home);
  const asked = [];
  const confirm = async (q) => { asked.push(q); return q === 'Split ~/.codex/AGENTS.md as shown?'; };
  const r = await bootstrap({ home, argv: [], run: fakeMachine(home).run, isTTY: true, confirm, now: NOW });
  const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.ok(asked.includes('Split ~/.codex/AGENTS.md as shown?'), asked.join('\n'));
  assert.match(by.migrate.detail, /^migrated: /);
  const text = readFileSync(agentsMd, 'utf8');
  assert.equal(text.includes(L.markers.start), false);
  assert.equal(text.includes('Old rules.'), false);
}));

test('triqual migrate --help prints the usage; an unknown argument exits 2; run alone the cli step is skipped', () => withHome(async (home) => {
  for (const flag of ['--help', '-h']) {
    const r = await migrateCli([flag], { home, run: fakeMachine(home).run });
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`^usage: ${BRAND.cli} migrate\\n`));
  }
  const bad = await migrateCli(['--bogus'], { home, run: fakeMachine(home).run });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown argument --bogus/);
  assert.equal(existsSync(join(home, '.claude')), false, 'nothing written for bad args');

  legacyMachine(home);
  const lines = [];
  const r = await migrateCli([], { home, run: fakeMachine(home).run, now: NOW, log: (l) => lines.push(l) });
  const s = parse(lines);
  assert.deepEqual(s.cli, { status: 'skipped', detail: 'run node bin/bootstrap.mjs from the clone' });
  // The older shim is still at the legacy CLI file, so the scan names it and the run exits 1.
  assert.equal(s.verify.status, 'failed');
  assert.equal(r.code, 1);

  const spawned = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.match(spawned.stdout, new RegExp(`^usage: ${BRAND.cli} migrate\\n`));
}));
