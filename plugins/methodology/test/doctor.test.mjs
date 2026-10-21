import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, statSync, symlinkSync, realpathSync, chmodSync,
  existsSync, utimesSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { doctor as runDoctor, git, nodeCheck, realRun, SHIM_COMMANDS, STORE_HOOKS, STORE_SCRIPTS } from '../cli/doctor.mjs';
import { STORE_HOOK_LINES } from '../../progress-tracking/lib/store-hooks.mjs';
import { COMMANDS } from '../setup/triqual-shim.mjs';
import { MARKERS } from '../cli/lib/fsx.mjs';
import { codexBridgeDir } from '../cli/lib/harnesses.mjs';
import { codexPluginTable, grokStaleEntries, syncHarness } from '../cli/lib/harness-sync.mjs';
import { manifestPath, readManifest } from '../cli/lib/harness-manifest.mjs';
import { BRAND } from '../cli/lib/brand.mjs';
import { detectFence } from '../cli/lib/fence.mjs';
import { installCli } from '../../../bin/bootstrap.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PLUGIN_ROOT));
const GATE_TEMPLATE = readFileSync(join(REPO_ROOT, 'plugins', 'progress-tracking', 'templates', 'progress-gate.sh'), 'utf8');
const GLOBAL = readFileSync(join(PLUGIN_ROOT, 'rules', 'global.md'), 'utf8');
const IDS = ['methodology', 'progress-tracking', 'workflow-gate', 'roles'].map((n) => `${n}@${BRAND.marketplace}`);
// The role names come from the agent files; test/roles-consistency.test.mjs checks doctor's own list against them.
const ROLES = readdirSync(join(REPO_ROOT, 'plugins', 'roles', 'agents')).filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3)).sort();
const SUPERSEDED = 'superpowers@superpowers-marketplace';
const HEADJACK_ARGS = ['headjack', ['search', 'ping', '-k', '1', '--json'], { timeoutMs: 10000 }];
// The shim as released on this branch: a clean machine's ~/.local/bin/triqual.mjs; the alias and the forwarder beside it.
const SHIM_TEXT = readFileSync(join(REPO_ROOT, 'plugins', 'methodology', 'setup', 'triqual-shim.mjs'), 'utf8');
const ALIAS_TEXT = readFileSync(join(REPO_ROOT, 'plugins', 'methodology', 'setup', `${BRAND.legacy.cli}-alias.mjs`), 'utf8');
const FORWARDER_TEXT = readFileSync(join(REPO_ROOT, 'plugins', 'methodology', 'setup', `${BRAND.legacy.launcher}-forwarder`), 'utf8');
// doctor looks for fence on PATH. Every call here sees a PATH with nothing on it unless a test passes its own `env`,
// so a fence installed on this machine never changes a result.
const NO_FENCE_ENV = { PATH: join(tmpdir(), 'cm-doctor-no-fence-path') };
const doctor = (args) => runDoctor({ env: NO_FENCE_ENV, ...args });
const section = (body = GLOBAL.trim()) => `# Machine\n\n${MARKERS.start}\n${body}\n${MARKERS.end}\n`;

// A run that records its calls and answers every command with `result` (or throws it when it is an Error).
function fakeRun(result = { code: 0, stdout: '[]', stderr: '' }) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

// A clean machine under a temp home: the four plugins installed at user scope (install dirs under the home) and
// enabled, the current managed section, the cm shim, a non-role agent and a non-legacy hook. `tweak` edits the
// parts before they are written.
function withHome(fn, tweak = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'cm-doctor-'));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    const cache = join(home, '.claude', 'plugins', 'cache', BRAND.marketplace);
    const installPath = (name) => join(cache, name, '0.1.0');
    const parts = {
      supersedes: [],
      installed: {
        version: 2,
        plugins: Object.fromEntries(IDS.map((id) => [id, [
          { scope: 'user', installPath: installPath(id.split('@')[0]), version: '0.1.0' },
        ]])),
      },
      settings: {
        enabledPlugins: Object.fromEntries(IDS.map((id) => [id, true])),
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/other.mjs' }] }],
        },
      },
      claudeMd: section(),
      shim: true,
      shimText: SHIM_TEXT, // the installed triqual.mjs
      aliasText: ALIAS_TEXT, // the installed alias, behind its link; null leaves both out
      forwarderText: FORWARDER_TEXT, // the installed forwarder; null leaves it out
      ships: {}, // plugin name → files under its install dir (e.g. { 'progress-tracking': ['cli/tracking.mjs'] })
      agents: { 'my-helper.md': '---\nname: my-helper\n---\n' },
      // The installed marketplace copy's plugin versions; null leaves known_marketplaces.json out.
      marketplace: Object.fromEntries(IDS.map((id) => [id.split('@')[0], '0.1.0'])),
      knownAs: BRAND.marketplace, // the key known_marketplaces.json lists that copy under
    };
    tweak(parts);
    const methodology = installPath('methodology');
    mkdirSync(join(methodology, 'rules'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'rules', 'global.md'), join(methodology, 'rules', 'global.md'));
    cpSync(join(PLUGIN_ROOT, 'rules', 'legacy-headings.json'), join(methodology, 'rules', 'legacy-headings.json'));
    writeFileSync(join(methodology, 'rules', 'manifest.json'),
      JSON.stringify({ version: 1, supersedes: parts.supersedes }) + '\n');
    const pt = installPath('progress-tracking');
    mkdirSync(join(pt, 'templates'), { recursive: true });
    writeFileSync(join(pt, 'templates', 'progress-gate.sh'), GATE_TEMPLATE);
    mkdirSync(installPath('workflow-gate'), { recursive: true });
    mkdirSync(join(installPath('roles'), 'agents'), { recursive: true });
    writeFileSync(join(installPath('roles'), 'agents', 'phase-orchestrator.md'), '---\nname: phase-orchestrator\n---\n');
    const write = (path, value) => {
      if (value === null) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    };
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), parts.installed);
    if (parts.marketplace !== null) {
      const location = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace);
      write(join(location, '.claude-plugin', 'marketplace.json'), {
        name: BRAND.marketplace,
        plugins: Object.entries(parts.marketplace).map(([name, version]) => ({ name, source: `./plugins/${name}`, version })),
      });
      write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), { [parts.knownAs]: { installLocation: location } });
    }
    write(join(home, '.claude', 'settings.json'), parts.settings);
    write(join(home, '.claude', 'CLAUDE.md'), parts.claudeMd);
    // The shim as bootstrap installs it: triqual.mjs behind a relative triqual symlink, or a broken variant; then the
    // alias behind its own link, and the forwarder.
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    if (parts.shim) {
      if (parts.shim !== 'dangling') writeFileSync(join(bin, BRAND.cliFile), parts.shimText);
      if (parts.shim === 'dir') mkdirSync(join(bin, BRAND.cli));
      else symlinkSync(BRAND.cliFile, join(bin, BRAND.cli));
    }
    if (parts.aliasText !== null) {
      writeFileSync(join(bin, BRAND.legacy.cliFile), parts.aliasText);
      symlinkSync(BRAND.legacy.cliFile, join(bin, BRAND.legacy.cli));
    }
    if (parts.forwarderText !== null) writeFileSync(join(bin, BRAND.legacy.launcher), parts.forwarderText, { mode: 0o755 });
    for (const [name, files] of Object.entries(parts.ships)) {
      for (const rel of files) write(join(installPath(name), rel), '// shipped\n');
    }
    for (const [name, text] of Object.entries(parts.agents)) write(join(home, '.claude', 'agents', name), text);
    const result = fn({ home, installPath });
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Every file under dir with its bytes and mode, for a read-only check.
function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, name);
    const st = statSync(p);
    out[name] = st.isDirectory() ? `dir ${st.mode}` : `${st.mode} ${readFileSync(p, 'base64')}`;
  }
  return out;
}

const matching = (list, re) => list.filter((line) => re.test(line));

// The fix doctor gives each legacy-scan failure, and the one warning line for the scan's exempt items. Every fixture
// here keeps the cm alias and the forwarder, so `diagnose` drops that line (there is at most one) for the tests of
// doctor's other checks; the legacy-scan tests below call doctor itself.
const LEGACY_FIX = `run ${BRAND.cli} migrate`;
const BOOTSTRAP_FIX = 'run /methodology:setup (or node bin/bootstrap.mjs from a clone)';
const RERUN_FIX = 'rerun /methodology:setup (or node bin/bootstrap.mjs from a clone)';
const kept = (n) => `${n} legacy items kept on purpose (cm alias, compatibility links, old caches, backups)`;
const KEPT = /^\d+ legacy items kept on purpose \(cm alias, compatibility links, old caches, backups\)$/;
async function diagnose(opts) {
  const r = await doctor(opts);
  assert.ok(matching(r.warnings, KEPT).length <= 1, r.warnings.join('\n'));
  return { failures: r.failures, warnings: r.warnings.filter((w) => !KEPT.test(w)) };
}

test('a clean fixture yields no failures', async () => {
  const { run, calls } = fakeRun();
  await withHome(async ({ home }) => {
    const before = snapshot(home);
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r, { failures: [], warnings: [kept(2)] }); // the cm alias and the forwarder
    assert.deepEqual(calls, [HEADJACK_ARGS]);
    assert.deepEqual(snapshot(home), before);
  });
});

test('doctor gives each legacy-scan failure with its fix, and the exempt items as one warning line', async () => {
  await withHome(async ({ home }) => {
    const known = join(home, '.claude', 'plugins', 'known_marketplaces.json');
    const current = JSON.parse(readFileSync(known, 'utf8'));
    writeFileSync(known, JSON.stringify({ ...current, [BRAND.legacy.marketplace]: { installLocation: '/old' } }));
    mkdirSync(join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace), { recursive: true });
    const before = snapshot(home);
    const r = await doctor({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r, {
      failures: [`${known} still knows the marketplace ${BRAND.legacy.marketplace}: ${LEGACY_FIX}`],
      warnings: [kept(3)],
    });
    assert.deepEqual(snapshot(home), before);
  });
});

test('each leftover migrate cannot clear gets a fix that does not point back to migrate', async () => {
  const L = BRAND.legacy;
  const legacyBridge = `methodology-codex@${L.marketplace}`;
  await withHome(async ({ home }) => {
    const settings = join(home, '.claude', 'settings.json');
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    const agentsMd = join(home, '.codex', 'AGENTS.md');
    const config = join(home, '.codex', 'config.toml');
    writeFileSync(claudeMd, `# Machine\n\n${L.markers.start}\n${GLOBAL.trim()}\n${L.markers.end}\n`);
    mkdirSync(dirname(agentsMd), { recursive: true });
    writeFileSync(agentsMd, `# Codex\n\n${L.markers.start}\nold\n${L.markers.end}\n`);
    // Codex is not set up in harnesses.json, so migrate leaves its legacy tables, and the records of a harness whose
    // legacy tables stay, alone.
    writeFileSync(config, `model = "gpt"\n\n[marketplaces.${L.marketplace}]\nsource = "/x"\n\n`
      + `[plugins."${legacyBridge}"]\nenabled = true\n`);
    const manifest = manifestPath(home);
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 1, harnesses: { codex: { plugins: [{ id: legacyBridge, action: 'added' }] } } }));
    writeFileSync(join(home, '.config', BRAND.dir, 'config.json'), JSON.stringify({ harnesses: { codex: { enabled: false } } }));
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, [
      `${settings} has a permission rule naming ${L.marketplace} (permissions.allow[1]): remove permissions.allow[1] from ${settings}`,
      `${claudeMd} holds the ${L.marketplace} managed markers: run ${BRAND.cli} sync`,
      `${agentsMd} holds the ${L.marketplace} managed markers: run ${BRAND.cli} sync --harness codex in a terminal`,
      `${config} has the table [marketplaces.${L.marketplace}]: run codex plugin marketplace remove ${L.marketplace}`,
      `${config} has the table [plugins."${legacyBridge}"]: run codex plugin remove ${legacyBridge}`,
      `${manifest} records the id ${legacyBridge}: once ${config} has no ${L.marketplace} table, ${LEGACY_FIX}`,
    ]);
  }, (p) => {
    p.settings.permissions = { allow: ['Bash(git status:*)', `Read(~/.claude/plugins/cache/${L.marketplace}/**)`] };
  });
});

test('a file the legacy scan cannot read is its own warning, not a kept legacy item', async () => {
  await withHome(async ({ home }) => {
    const settings = join(home, '.claude', 'settings.json');
    const manifest = manifestPath(home);
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, 'not json');
    writeFileSync(settings, '{ not json');
    const r = await doctor({ home, cwd: home, run: fakeRun().run });
    // The alias and the forwarder are the only kept items; each unreadable file is one line of its own.
    assert.deepEqual(matching(r.warnings, KEPT), [kept(2)]);
    assert.equal(matching(r.warnings, /^could not read /).length, 2, r.warnings.join('\n'));
    assert.ok(r.warnings.includes(`could not read ${settings}`), r.warnings.join('\n'));
    assert.ok(r.warnings.includes(`could not read ${manifest}`), r.warnings.join('\n'));
  });
});

for (const id of IDS) {
  test(`doctor reports ${id} missing at user scope`, async () => {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.match(r.failures[0], new RegExp(`${id} is not installed`));
      assert.ok(r.failures[0].includes(`claude plugin install ${id} --scope user`), r.failures[0]);
    }, (p) => { delete p.installed.plugins[id]; });
  });
}

test('doctor ignores a local-scope-only install when looking for the user install', async () => {
  const id = `roles@${BRAND.marketplace}`;
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].includes(`claude plugin install ${id} --scope user`), r.failures[0]);
  }, (p) => {
    p.installed.plugins[id] = [{ scope: 'local', projectPath: '/elsewhere', installPath: '/elsewhere/roles' }];
  });
});

test('a plugin installed only under the legacy id is found while triqual is known', async () => {
  // A half-finished migration: triqual is the known marketplace and holds every system plugin but roles, which is
  // still installed (and enabled) only under its legacy id. The plugin checks find it; the legacy scan names the two
  // leftover keys.
  const legacyRoles = `roles@${BRAND.legacy.marketplace}`;
  const rolesToLegacy = (byId) => Object.fromEntries(Object.entries(byId).map(([id, value]) => [
    id.startsWith('roles@') ? legacyRoles : id, value,
  ]));
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r, { failures: [
      `${join(home, '.claude', 'settings.json')} enables ${legacyRoles}: ${LEGACY_FIX}`,
      // The legacy marketplace is not known, so migrate cannot uninstall it: the fix is the command itself.
      `${join(home, '.claude', 'plugins', 'installed_plugins.json')} installs ${legacyRoles}: `
        + `run claude plugin uninstall ${legacyRoles} --scope user`,
    ], warnings: [] });
  }, (p) => {
    p.installed.plugins = rolesToLegacy(p.installed.plugins);
    p.settings.enabledPlugins = rolesToLegacy(p.settings.enabledPlugins);
  });
});

test('doctor reports every plugin missing when installed_plugins.json is absent or malformed', async () => {
  for (const installed of [null, '{ not json', '{"version":2,"plugins":[]}']) {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      for (const id of IDS) {
        assert.equal(matching(r.failures, new RegExp(`${id} is not installed`)).length, 1, r.failures.join('\n'));
      }
      assert.equal(matching(r.failures, /run triqual sync/).length, 0, 'rules are skipped without methodology');
    }, (p) => { p.installed = installed; });
  }
});

test('doctor reports an installed plugin whose version differs from the marketplace', async () => {
  const id = `progress-tracking@${BRAND.marketplace}`;
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, [
      `${id} is 0.1.0, marketplace has 0.1.1: run claude plugin update ${id} --scope user`,
    ]);
  }, (p) => { p.marketplace['progress-tracking'] = '0.1.1'; });
});

test('doctor keeps only the not-installed failure for a missing plugin the marketplace lists', async () => {
  const id = `roles@${BRAND.marketplace}`;
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], new RegExp(`${id} is not installed`));
  }, (p) => { delete p.installed.plugins[id]; p.marketplace.roles = '0.2.0'; });
});

test('doctor warns, without crashing, when the marketplace copy is unreadable', async () => {
  // No known_marketplaces.json; then a marketplace.json that is not valid JSON.
  for (const corrupt of [false, true]) {
    await withHome(async ({ home }) => {
      if (corrupt) {
        writeFileSync(join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace, '.claude-plugin', 'marketplace.json'), '{ nope');
      }
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.deepEqual(r.failures, []);
      assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
      // Known or not (without known_marketplaces.json no marketplace is known), the fix names triqual.
      assert.match(r.warnings[0], new RegExp(`^cannot compare plugin versions with the ${BRAND.marketplace} marketplace: .+: `
        + `run claude plugin marketplace update ${BRAND.marketplace}$`));
    }, (p) => { if (!corrupt) p.marketplace = null; });
  }
});

test('doctor reports a disabled plugin', async () => {
  const id = `workflow-gate@${BRAND.marketplace}`;
  for (const value of [false, undefined]) {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.match(r.failures[0], new RegExp(`${id} is not enabled`));
      assert.ok(r.failures[0].includes(`claude plugin enable ${id}`), r.failures[0]);
    }, (p) => {
      if (value === undefined) delete p.settings.enabledPlugins[id];
      else p.settings.enabledPlugins[id] = value;
    });
  }
});

test('doctor reports a settings.json that is missing or malformed, without crashing', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, IDS.length, r.failures.join('\n'));
    for (const id of IDS) assert.equal(matching(r.failures, new RegExp(`${id} is not enabled`)).length, 1);
  }, (p) => { p.settings = null; });
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /settings\.json is not valid JSON/);
  }, (p) => { p.settings = '{ "enabledPlugins": '; });
});

test('doctor reports a missing managed section', async () => {
  for (const claudeMd of ['# Machine\n', null]) {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.match(r.failures[0], /run triqual sync/);
    }, (p) => { p.claudeMd = claudeMd; });
  }
});

test('doctor reports a managed section that differs from the installed global.md', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /run triqual sync/);
  }, (p) => { p.claudeMd = section('## Old rules'); });
});

test('doctor reports a malformed managed section', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /unterminated/);
  }, (p) => { p.claudeMd = `# Machine\n${MARKERS.start}\n${GLOBAL}`; });
});

test('doctor reports an unreadable CLAUDE.md with its fix', async () => {
  await withHome(async ({ home }) => {
    mkdirSync(join(home, '.claude', 'CLAUDE.md')); // a directory: EISDIR, not ENOENT
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /^cannot read .*CLAUDE\.md: .*: make it a readable file, then run triqual doctor again$/);
  }, (p) => { p.claudeMd = null; });
});

test('doctor compares against the installed methodology, not the repo copy', async () => {
  await withHome(async ({ home, installPath }) => {
    writeFileSync(join(installPath('methodology'), 'rules', 'global.md'), '## Installed rules\n');
    const stale = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(matching(stale.failures, /run triqual sync/).length, 1);
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), section('## Installed rules'));
    const current = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(current.failures, []);
  });
});

test('doctor skips rules and superseded checks when methodology is not installed', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], new RegExp(`methodology@${BRAND.marketplace} is not installed`));
  }, (p) => {
    delete p.installed.plugins[`methodology@${BRAND.marketplace}`];
    p.claudeMd = '# Machine\n';
    p.supersedes = [SUPERSEDED];
    p.settings.enabledPlugins[SUPERSEDED] = true;
  });
});

test('doctor reports a triqual shim that is missing, a dangling symlink or not a file', async () => {
  for (const shim of [false, 'dangling', 'dir']) {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.ok(r.failures[0].includes(join(home, '.local', 'bin', BRAND.cli)), r.failures[0]);
      assert.ok(r.failures[0].includes(BOOTSTRAP_FIX), r.failures[0]);
    }, (p) => { p.shim = shim; });
  }
});

test('doctor no longer reports a leftover safety-shadow agent, a role the roles plugin retired', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
  }, (p) => { p.agents['safety-shadow.md'] = '---\nname: safety-shadow\n---\n'; });
});

for (const name of ROLES) {
  test(`doctor reports a duplicate ${name} agent`, async () => {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.ok(r.failures[0].includes(join(home, '.claude', 'agents', `${name}.md`)), r.failures[0]);
    }, (p) => { p.agents[`${name}.md`] = `---\nname: ${name}\n---\n`; });
  });
}

// An older shim copy, from before `triqual tracking` shipped.
const TRACKING_LINE = "  tracking: ['progress-tracking', 'cli/tracking.mjs'],\n";
const OLD_SHIM_TEXT = SHIM_TEXT.replace(TRACKING_LINE, '');
const SHIPPED = Object.values(COMMANDS).reduce((acc, [plugin, rel]) => {
  (acc[plugin] ??= []).push(rel);
  return acc;
}, {});

test("doctor's command map is the shim's", () => {
  assert.notEqual(OLD_SHIM_TEXT, SHIM_TEXT, 'the tracking line was not found in setup/triqual-shim.mjs');
  assert.deepEqual(SHIM_COMMANDS, COMMANDS);
});

test('doctor reports a triqual shim that lacks a command the installed plugins ship', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].startsWith(`${BRAND.cli} shim is stale: `), r.failures[0]);
    assert.ok(r.failures[0].includes(join(home, '.local', 'bin', BRAND.cli)), r.failures[0]);
    assert.ok(r.failures[0].includes(`lacks ${BRAND.cli} tracking, which the installed progress-tracking ships`), r.failures[0]);
    assert.ok(r.failures[0].endsWith(`: ${RERUN_FIX}`), r.failures[0]);
    assert.deepEqual(r.warnings, []);
  }, (p) => { p.shimText = OLD_SHIM_TEXT; p.ships = SHIPPED; });
  // The current shim, or an old one while no installed plugin ships the missing command: nothing to report.
  await withHome(async ({ home }) => {
    assert.deepEqual(await diagnose({ home, cwd: home, run: fakeRun().run }), { failures: [], warnings: [] });
  }, (p) => { p.ships = SHIPPED; });
  await withHome(async ({ home }) => {
    assert.deepEqual(await diagnose({ home, cwd: home, run: fakeRun().run }), { failures: [], warnings: [] });
  }, (p) => {
    p.shimText = OLD_SHIM_TEXT;
    p.ships = { ...SHIPPED, 'progress-tracking': SHIPPED['progress-tracking'].filter((f) => f !== 'cli/tracking.mjs') };
  });
});

// `triqual suggest` runs from the methodology plugin itself (it used to belong to a skill-suggest plugin).
const SUGGEST_LINE = "  suggest: ['methodology', 'cli/suggest.mjs'],\n";
const SHIM_WITHOUT_SUGGEST = SHIM_TEXT.replace(SUGGEST_LINE, '');

test('doctor reports a triqual shim that lacks `suggest` once the installed methodology ships it', async () => {
  assert.notEqual(SHIM_WITHOUT_SUGGEST, SHIM_TEXT, 'the suggest line was not found in setup/triqual-shim.mjs');
  assert.deepEqual(SHIPPED.methodology.filter((f) => f === 'cli/suggest.mjs'), ['cli/suggest.mjs']);
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].includes(`lacks ${BRAND.cli} suggest, which the installed methodology ships`), r.failures[0]);
    assert.ok(r.failures[0].endsWith(`: ${RERUN_FIX}`), r.failures[0]);
  }, (p) => { p.shimText = SHIM_WITHOUT_SUGGEST; p.ships = { methodology: SHIPPED.methodology }; });
  // The current shim with the same install: nothing to report.
  await withHome(async ({ home }) => {
    assert.deepEqual(await diagnose({ home, cwd: home, run: fakeRun().run }), { failures: [], warnings: [] });
  }, (p) => { p.ships = { methodology: SHIPPED.methodology }; });
});

test('doctor names every command a shim without a command map lacks', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    const lacking = ['tasks', 'progress-init', 'ui', 'tracking'].map((c) => `${BRAND.cli} ${c}`).join(', ');
    assert.ok(r.failures[0].includes(`lacks ${lacking}, which the installed progress-tracking ships`), r.failures[0]);
  }, (p) => { p.shimText = '#!/usr/bin/env node\n'; p.ships = { 'progress-tracking': SHIPPED['progress-tracking'] }; });
});

// A machine that never had the legacy name (no legacy CLI file) gets neither the alias nor the forwarder from
// bootstrap, so doctor checks them only when one of the three is present.
test('a fresh machine without the cm alias, its link and the forwarder is clean', async () => {
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  }, (p) => { p.aliasText = null; p.forwarderText = null; });
});

// A missing cm alias, cm link or forwarder is the shim check's line; an older file in place of the alias or the
// forwarder (the full legacy shim in the alias file, the legacy launcher in the forwarder's place) is the legacy
// scan's. Each problem is one line: the cm link to an old alias file is not reported again, only a cm that is a file
// of its own.
test('doctor reports a cm alias or a forwarder that is missing or not ours by line 2, each once', async () => {
  const bin = (home, name) => join(home, '.local', 'bin', name);
  const legacyShim = SHIM_TEXT.split('\n').with(1, BRAND.legacy.ownership.shim).join('\n');
  const legacyLauncher = `#!/usr/bin/env bash\n${BRAND.legacy.ownership.launcher}\nexit 0\n`;
  const aliasFailure = (home, name) => `${bin(home, name)} is missing or is not the ${BRAND.legacy.cli} alias of `
    + `${BRAND.cli}: ${BOOTSTRAP_FIX}`;
  const forwarderFailure = (home) => `${bin(home, BRAND.legacy.launcher)} is missing or is not the `
    + `${BRAND.legacy.launcher} forwarder of ${BRAND.cli}: ${BOOTSTRAP_FIX}`;
  const run = fakeRun().run;
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.failures, [aliasFailure(home, BRAND.legacy.cli), aliasFailure(home, BRAND.legacy.cliFile)]);
    assert.deepEqual(r.warnings, [kept(1)]);
  }, (p) => { p.aliasText = null; });
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.failures, [`${bin(home, BRAND.legacy.cliFile)} is not the ${BRAND.legacy.cli} alias of `
      + `${BRAND.cli}: ${BOOTSTRAP_FIX}`]);
    assert.deepEqual(r.warnings, [kept(1)]);
  }, (p) => { p.aliasText = legacyShim; });
  await withHome(async ({ home }) => {
    rmSync(bin(home, BRAND.legacy.cli));
    writeFileSync(bin(home, BRAND.legacy.cli), legacyShim);
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.failures, [aliasFailure(home, BRAND.legacy.cli)]);
  });
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.failures, [forwarderFailure(home)]);
    assert.deepEqual(r.warnings, [kept(1)]);
  }, (p) => { p.forwarderText = null; });
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.failures, [`${bin(home, BRAND.legacy.launcher)} is not the ${BRAND.legacy.launcher} forwarder `
      + `of ${BRAND.cli}: ${BOOTSTRAP_FIX}`]);
  }, (p) => { p.forwarderText = legacyLauncher; });
  // Not ours at all: installCli refuses it, so it has to be moved aside first.
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    const path = bin(home, BRAND.legacy.cliFile);
    assert.deepEqual(r.failures, [`${path} is not the ${BRAND.legacy.cli} alias of ${BRAND.cli}: `
      + `move ${path} aside, then ${BOOTSTRAP_FIX}`]);
  }, (p) => { p.aliasText = '#!/bin/sh\n# some other tool\n'; });
  // Nothing legacy kept: no kept line.
  await withHome(async ({ home }) => {
    const r = await doctor({ home, cwd: home, run });
    assert.deepEqual(r.warnings, []);
  }, (p) => { p.aliasText = null; p.forwarderText = null; });
});

// A foreign file at a legacy CLI name on a machine without one of ours is someone else's tool: bootstrap never wrote
// an alias next to it, so doctor has nothing to say about it, here or in the legacy scan.
test(`a foreign ${BRAND.legacy.cli}, ${BRAND.legacy.cliFile} or ${BRAND.legacy.launcher} on a fresh machine gives no doctor line`, async () => {
  for (const name of [BRAND.legacy.cli, BRAND.legacy.cliFile, BRAND.legacy.launcher]) {
    await withHome(async ({ home }) => {
      const path = join(home, '.local', 'bin', name);
      writeFileSync(path, '#!/bin/sh\n# some other tool\nexec other "$@"\n', { mode: 0o755 });
      assert.deepEqual(await doctor({ home, cwd: home, run: fakeRun().run }), { failures: [], warnings: [] }, name);
    }, (p) => { p.aliasText = null; p.forwarderText = null; });
  }
});

test('doctor reports the legacy gate hook', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].includes('hooks/workflow-gate.mjs'), r.failures[0]);
  }, (p) => {
    p.settings.hooks.PreToolUse.push({
      matcher: 'Workflow', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/workflow-gate.mjs"' }],
    });
  });
});

test('doctor reports an enabled superseded plugin and ignores a disabled one', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].includes(SUPERSEDED), r.failures[0]);
    assert.match(r.failures[0], /run triqual sync/);
  }, (p) => {
    p.supersedes = [SUPERSEDED];
    p.settings.enabledPlugins[SUPERSEDED] = true;
  });
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
  }, (p) => {
    p.supersedes = [SUPERSEDED];
    p.settings.enabledPlugins[SUPERSEDED] = false;
  });
});

// keepSuperseded and supersedes patterns (spec Addendum E.9).
function writeConfig(home, text) {
  const dir = join(home, '.config', BRAND.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), typeof text === 'string' ? text : JSON.stringify(text));
}
const OTHER_MARKET = 'superpowers@claude-plugins-official';
const superseding = (p) => {
  p.supersedes = ['superpowers@*'];
  p.settings.enabledPlugins[SUPERSEDED] = true;
  p.settings.enabledPlugins[OTHER_MARKET] = true;
  p.settings.enabledPlugins['superpowers-lab@m'] = true;
};

test('doctor fails while superpowers@* is enabled, with fix "run triqual sync", and warns instead under keepSuperseded', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, [
      `superseded plugin ${SUPERSEDED} is still enabled: run triqual sync`,
      `superseded plugin ${OTHER_MARKET} is still enabled: run triqual sync`,
    ]);
    assert.deepEqual(r.warnings, []);
  }, superseding);
  await withHome(async ({ home }) => {
    writeConfig(home, { keepSuperseded: true });
    const before = snapshot(home);
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
    assert.equal(r.warnings.length, 2, r.warnings.join('\n'));
    for (const [i, id] of [SUPERSEDED, OTHER_MARKET].entries()) {
      assert.ok(r.warnings[i].startsWith(`superseded plugin ${id} is enabled by keepSuperseded`), r.warnings[i]);
      assert.ok(r.warnings[i].includes(join(home, '.config', BRAND.dir, 'config.json')), r.warnings[i]);
    }
    assert.deepEqual(snapshot(home), before);
  }, superseding);
});

test('doctor warns on an invalid config.json and reads it as no keepSuperseded', async () => {
  await withHome(async ({ home }) => {
    writeConfig(home, '{ "keepSuperseded": true,, }');
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    const config = join(home, '.config', BRAND.dir, 'config.json');
    // triqual sync refuses to act on an unreadable config.json, so the fix names that file first.
    assert.deepEqual(r.failures, [
      `superseded plugin ${SUPERSEDED} is still enabled: fix or remove ${config}, then run triqual sync`,
      `superseded plugin ${OTHER_MARKET} is still enabled: fix or remove ${config}, then run triqual sync`,
    ]);
    assert.deepEqual(r.warnings, [`${config} is not valid JSON: triqual sync disables nothing until it is fixed or removed`]);
  }, superseding);
});

test('doctor\'s unsplit fix says "split, then rerun /methodology:setup"', async () => {
  const unsplit = '# Global Instructions\n\n## UNIVERSAL DEVELOPMENT RULES\n\n### Never Assume - Always Verify\n\n- verify\n';
  for (const claudeMd of [unsplit, `${unsplit}\n${section().replace('# Machine\n\n', '')}`]) {
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.match(r.failures[0], /## UNIVERSAL DEVELOPMENT RULES, ### Never Assume - Always Verify/);
      assert.ok(r.failures[0].endsWith(`: split, then ${RERUN_FIX}`), r.failures[0]);
      assert.doesNotMatch(r.failures[0], /run triqual sync/);
    }, (p) => { p.claudeMd = claudeMd; });
  }
});

const PROJECT_FIX = 'set it to false there by hand if this repo should use methodology (doctor never edits project settings)';

test('doctor --repo warns on a superpowers@* enable in .claude/settings.json or .claude/settings.local.json and never writes them', async () => {
  for (const file of ['settings.json', 'settings.local.json']) {
    await withHome(async ({ home }) => {
      const repo = makeRepo(home);
      const path = join(repo, '.claude', file);
      mkdirSync(dirname(path), { recursive: true });
      const text = JSON.stringify({ enabledPlugins: { [OTHER_MARKET]: true, [SUPERSEDED]: false, 'other@m': true } }, null, 2);
      writeFileSync(path, text);
      const before = snapshot(repo);
      const r = await diagnose({ home, cwd: join(repo, 'src'), repo: true, run: fakeRun().run });
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.warnings, [`superseded plugin ${OTHER_MARKET} is enabled in ${realpathSync(path)}: ${PROJECT_FIX}`]);
      assert.equal(readFileSync(path, 'utf8'), text);
      assert.deepEqual(snapshot(repo), before);
      // Without --repo the project settings are not read.
      assert.deepEqual((await diagnose({ home, cwd: repo, run: fakeRun().run })).warnings, []);
    }, (p) => { p.supersedes = ['superpowers@*']; });
  }
});

test('an unreachable headjack is a warning, never a failure', async () => {
  const cases = [
    [{ code: 1, stdout: '', stderr: 'boom' }, 'exited 1'],
    [{ code: 2, stdout: '', stderr: 'not logged in' }, 'exited 2'],
    [{ code: 127, stdout: '', stderr: '' }, 'exited 127'],
    [new Error('spawn'), 'failed: spawn'],
  ];
  for (const [result, detail] of cases) {
    const { run, calls } = fakeRun(result);
    await withHome(async ({ home }) => {
      const r = await diagnose({ home, cwd: home, run });
      assert.deepEqual(r.failures, []);
      assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
      assert.match(r.warnings[0], /headjack/);
      assert.ok(r.warnings[0].includes(`headjack is unreachable (headjack search ${detail})`), r.warnings[0]);
      assert.ok(r.warnings[0].includes('claude plugin install headjack@triqual'), r.warnings[0]);
      assert.ok(r.warnings[0].includes('headjack login'), r.warnings[0]);
      assert.ok(r.warnings[0].includes('~/.local/bin'), r.warnings[0]);
      assert.ok(r.warnings[0].includes('clone'), r.warnings[0]);
      assert.ok(r.warnings[0].includes('link cli/headjack'), r.warnings[0]);
      assert.doesNotMatch(r.warnings[0], /(^|[^/\w])bin\/headjack/, r.warnings[0]);
      assert.ok(r.warnings[0].includes('not from the installed plugin'), r.warnings[0]);
      assert.deepEqual(calls, [HEADJACK_ARGS]);
    });
  }
});

test('doctor warns, and does not fail, when headjack is absent', async () => {
  const { run } = fakeRun({ code: 127, stdout: '', stderr: '' }); // what lib/run.mjs returns for a missing command
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run });
    assert.deepEqual(r.failures, []);
    assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
    assert.ok(r.warnings[0].includes('headjack is unreachable (headjack search exited 127)'), r.warnings[0]);
  });
});

const COMMITTED_LINE = 'sh "$(git rev-parse --git-path hooks)/progress-gate.sh" || exit 1';
// A git repo under the home with progress.md at its root, the gate installed at `hooksDir` (relative to the repo)
// with `gate` as its text next to a pre-commit holding `preCommit` (none when null), and core.hooksPath set when
// `hooksPath` is given.
function makeRepo(home, {
  progress = true, hooksPath = null, hooksDir = '.git/hooks', gate = GATE_TEMPLATE, preCommit = `#!/bin/sh\n${COMMITTED_LINE}\n`,
} = {}) {
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (hooksPath) execFileSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: repo });
  if (progress) writeFileSync(join(repo, 'progress.md'), '# Progress\n');
  mkdirSync(join(repo, hooksDir), { recursive: true });
  if (gate !== null) writeFileSync(join(repo, hooksDir, 'progress-gate.sh'), gate);
  if (preCommit !== null) writeFileSync(join(repo, hooksDir, 'pre-commit'), preCommit, { mode: 0o755 });
  mkdirSync(join(repo, 'src'));
  return repo;
}

test('--repo accepts a gate equal to the installed template in .git/hooks', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home);
    const r = await diagnose({ home, cwd: join(repo, 'src'), repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
  });
});

test('--repo reports a gate that differs from the installed template', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { gate: `${GATE_TEMPLATE}# local edit\n` });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /run triqual progress-init/);
  });
});

test('--repo reports a missing gate', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { gate: null });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /run triqual progress-init/);
  });
});

test('--repo resolves the gate through core.hooksPath', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { hooksPath: '.githooks', hooksDir: '.githooks' });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
  });
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { hooksPath: '.githooks', hooksDir: '.git/hooks' });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    // Neither the gate nor a pre-commit chaining it is in .githooks.
    assert.equal(matching(r.failures, /run triqual progress-init$/).length, 2, r.failures.join('\n'));
  });
});

test('--repo skips a repo without progress.md', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { progress: false, gate: null });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('--repo skips triqual tasks silently while progress-tracking lacks bin/tasks.mjs', async () => {
  const { run, calls } = fakeRun();
  await withHome(async ({ home }) => {
    const repo = makeRepo(home);
    const r = await diagnose({ home, cwd: repo, repo: true, run });
    assert.deepEqual(r, { failures: [], warnings: [] });
    assert.deepEqual(calls, [HEADJACK_ARGS]);
  });
});

// ---- --repo through the installed progress-tracking's bin/tasks.mjs ----

const LOCAL_TEMPLATE = readFileSync(join(REPO_ROOT, 'plugins', 'progress-tracking', 'templates', 'pre-commit-local.mjs'), 'utf8');
const REAL_INIT = join(REPO_ROOT, 'plugins', 'progress-tracking', 'scripts', 'init.mjs');
// The hook lines progress-tracking's init.mjs chains in local mode, copied verbatim (a real-init test cross-checks).
const LOCAL_GATE_REF = '"$(git rev-parse --path-format=absolute --git-common-dir)/methodology/pre-commit.mjs"';
const LOCAL_PRE = `node ${LOCAL_GATE_REF} || exit 1`;
const LOCAL_POST = `node ${LOCAL_GATE_REF} --post-commit`;
const DRIFT_FIX = 'run triqual tasks render or fix the plan/ledger drift';
const HOOKSPATH_WARNING = 'local mode without git hooks (core.hooksPath is set): commits are not gated; the Stop hook '
  + 'checks for a progress.md entry newer than the last commit';
// A stand-in for the installed bin/tasks.mjs: answers each subcommand with the code and output in fake.json.
const FAKE_TASKS = `import { readFileSync } from 'node:fs';
const answers = JSON.parse(readFileSync(new URL('./fake.json', import.meta.url), 'utf8'));
const answer = answers[process.argv[2]] ?? { code: 2, stderr: 'unexpected subcommand' };
if (answer.stdout) process.stdout.write(answer.stdout);
if (answer.stderr) process.stderr.write(answer.stderr);
process.exitCode = answer.code;
`;
// tasks.mjs's own message for a repo that is not opted in, verbatim.
const NOT_OPTED_IN = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const pathsAnswer = (value) => ({ code: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });
// The two facts progress-tracking 0.2.2's `paths --json` adds in every case.
const PATHS_FACTS = { notOptedInMessage: NOT_OPTED_IN, localHookLines: { 'pre-commit': LOCAL_PRE, 'post-commit': LOCAL_POST } };

// Installs the fake bin/tasks.mjs (and the local template) into the fixture's installed progress-tracking.
function installTasks(installPath, { paths, check = { code: 0 } }) {
  const pt = installPath('progress-tracking');
  mkdirSync(join(pt, 'bin'), { recursive: true });
  writeFileSync(join(pt, 'bin', 'tasks.mjs'), FAKE_TASKS);
  writeFileSync(join(pt, 'bin', 'fake.json'), JSON.stringify({ paths, check }));
  writeFileSync(join(pt, 'templates', 'pre-commit-local.mjs'), LOCAL_TEMPLATE);
  return join(pt, 'bin', 'tasks.mjs');
}

// Answers headjack itself and really runs everything else (the fake tasks.mjs), recording each call.
function tasksRun() {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return cmd === 'headjack' ? { code: 0, stdout: '[]', stderr: '' } : realRun(cmd, args, opts);
  };
  return { run, calls };
}

// The calls without the mode listing's `tasks export --json --all`, which runs after the repository's own checks.
const notExport = (calls) => calls.filter(([, args]) => args[1] !== 'export');

const committedPaths = (repo, duplicate = false) => {
  const root = realpathSync(repo);
  return {
    mode: 'committed', root, progress: join(root, 'progress.md'), status: join(root, 'status.md'),
    plansDir: join(root, 'docs', 'plans'), specsDir: join(root, 'docs', 'specs'), duplicate,
  };
};
const localPaths = (root) => ({
  mode: 'local', root, progress: join(root, 'progress.md'), status: join(root, 'status.md'),
  plansDir: join(root, 'plans'), specsDir: join(root, 'specs'), duplicate: false,
});

// A git repo under the home in local mode: <git-dir>/methodology holding progress.md, `gate` as pre-commit.mjs and
// `state` as state.json, the two hook lines chained into executable .git/hooks unless left out, core.hooksPath when
// given.
function makeLocalRepo(home, { gate = LOCAL_TEMPLATE, pre = true, post = true, hooksPath = null, state = null } = {}) {
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (hooksPath) execFileSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: repo });
  const root = join(realpathSync(join(repo, '.git')), 'methodology');
  mkdirSync(root);
  writeFileSync(join(root, 'progress.md'), '# Progress\n');
  if (gate !== null) writeFileSync(join(root, 'pre-commit.mjs'), gate);
  if (state !== null) writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  if (pre) writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${LOCAL_PRE}\n`, { mode: 0o755 });
  if (post) writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\n${LOCAL_POST}\n`, { mode: 0o755 });
  return { repo, root, hooks };
}

test('--repo runs tasks.mjs paths --json then check, in the cwd, with a 10 s timeout', async () => {
  const { run, calls } = tasksRun();
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home);
    const tasks = installTasks(installPath, { paths: pathsAnswer(committedPaths(repo)) });
    const cwd = join(repo, 'src');
    const r = await diagnose({ home, cwd, repo: true, run });
    assert.deepEqual(r, { failures: [], warnings: [] });
    assert.deepEqual(calls, [
      HEADJACK_ARGS,
      [process.execPath, [tasks, 'paths', '--json'], { timeoutMs: 10000, cwd }],
      [process.execPath, [tasks, 'check'], { timeoutMs: 10000, cwd }],
      [process.execPath, [tasks, 'export', '--json', '--all'], { timeoutMs: 10000, cwd }], // the mode listing
    ]);
  });
});

test('--repo runs no repo check when paths exits 2 (not opted in)', async () => {
  const { run, calls } = tasksRun();
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home, { gate: null }); // the legacy logic would report the missing gate
    const tasks = installTasks(installPath, { paths: { code: 2, stderr: `${NOT_OPTED_IN}\n` } });
    const r = await diagnose({ home, cwd: repo, repo: true, run });
    assert.deepEqual(r, { failures: [], warnings: [] });
    assert.deepEqual(notExport(calls).map(([, args]) => args), [HEADJACK_ARGS[1], [tasks, 'paths', '--json']]);
  });
});

test('--repo in committed mode compares progress-gate.sh with the installed template', async () => {
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home, { gate: `${GATE_TEMPLATE}# local edit\n` });
    installTasks(installPath, { paths: pathsAnswer(committedPaths(repo)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /progress-gate\.sh is missing or differs .*: run triqual progress-init$/);
  });
});

test('--repo in local mode accepts the installed pre-commit.mjs and both hook lines', async () => {
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home);
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('--repo in local mode reports a pre-commit.mjs that is missing or differs from the template', async () => {
  for (const gate of [null, `${LOCAL_TEMPLATE}// local edit\n`]) {
    await withHome(async ({ home, installPath }) => {
      const { repo, root } = makeLocalRepo(home, { gate });
      installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
      const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
      assert.deepEqual(r.failures, [
        `${join(root, 'pre-commit.mjs')} is missing or differs from the installed progress-tracking template: `
          + 'run triqual progress-init --local',
      ]);
    });
  }
});

test('--repo in local mode reports a missing pre-commit hook line', async () => {
  await withHome(async ({ home, installPath }) => {
    const { repo, root, hooks } = makeLocalRepo(home, { pre: false });
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].startsWith(`${join(realpathSync(hooks), 'pre-commit')} `), r.failures[0]);
    assert.match(r.failures[0], /: run triqual progress-init --local$/);
  });
});

test('--repo in local mode reports a missing post-commit hook line', async () => {
  await withHome(async ({ home, installPath }) => {
    const { repo, root, hooks } = makeLocalRepo(home, { post: false });
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\necho other\n'); // a hook without the line
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.ok(r.failures[0].startsWith(`${join(realpathSync(hooks), 'post-commit')} `), r.failures[0]);
    assert.match(r.failures[0], /: run triqual progress-init --local$/);
  });
});

test('the real tasks.mjs prints optedIn false with the facts doctor keeps copies of, with exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-doctor-optin-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const tasks = join(REPO_ROOT, 'plugins', 'progress-tracking', 'cli', 'tasks.mjs');
    const env = { ...process.env, HOME: dir };
    delete env.XDG_CONFIG_HOME;
    const r = spawnSync(process.execPath, [tasks, 'paths', '--json'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { optedIn: false, ...PATHS_FACTS });
    // The message an older install prints on exit 2, which doctor matches with its own copy.
    const status = spawnSync(process.execPath, [tasks, 'status'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(status.status, 2);
    assert.ok(status.stderr.includes(NOT_OPTED_IN), status.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--repo reports any other paths exit 2 with its first stderr line', async () => {
  const { run, calls } = tasksRun();
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home);
    installTasks(installPath, { paths: { code: 2, stderr: 'paths: --json is required\nusage: triqual tasks ...\n' } });
    const r = await diagnose({ home, cwd: repo, repo: true, run });
    assert.deepEqual(r.failures, ['triqual tasks paths failed: paths: --json is required']);
    assert.equal(notExport(calls).length, 2, 'check does not run');
  });
});

for (const name of ['pre-commit', 'post-commit']) {
  test(`--repo in local mode reports a ${name} hook that carries the line but is not executable`, async () => {
    await withHome(async ({ home, installPath }) => {
      const { repo, root, hooks } = makeLocalRepo(home);
      chmodSync(join(hooks, name), 0o644);
      installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
      const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
      assert.deepEqual(r.failures, [`hook not executable: chmod +x ${join(realpathSync(hooks), name)}`]);
    });
  });
}

test('--repo in local mode with core.hooksPath set warns instead of checking hook lines', async () => {
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home, { pre: false, post: false, hooksPath: '.husky/_' });
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, { failures: [], warnings: [HOOKSPATH_WARNING] });
  });
});

test('--repo accepts the local mode progress-init --local really installs', async () => {
  await withHome(async ({ home, installPath }) => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, HOME: home }; // init registers the repo under HOME
    delete env.XDG_CONFIG_HOME;
    execFileSync(process.execPath, [REAL_INIT, '--local'], { cwd: repo, env, stdio: 'ignore' });
    const root = join(realpathSync(join(repo, '.git')), 'methodology');
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('--repo asks for the pre-commit line by hand when init --local left a python3 hook untouched', async () => {
  await withHome(async ({ home, installPath }) => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/usr/bin/env python3\nprint("lint")\n', { mode: 0o755 });
    const env = { ...process.env, HOME: home };
    delete env.XDG_CONFIG_HOME;
    execFileSync(process.execPath, [REAL_INIT, '--local'], { cwd: repo, env, stdio: 'ignore' });
    const root = join(realpathSync(join(repo, '.git')), 'methodology');
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, {
      failures: [`${join(root, '..', 'hooks', 'pre-commit')} is not a shell script (#!/usr/bin/env python3): add this line to `
        + `it by hand: ${LOCAL_PRE}`],
      warnings: [],
    });
  });
});

test('--repo warns about a pending progress hash left while nothing is staged', async () => {
  const state = { version: 1, lastProgressSha256: 'a'.repeat(64), pendingProgressSha256: 'b'.repeat(64) };
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home, { state });
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r.failures, []);
    assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
    assert.match(r.warnings[0], /^pending progress hash left from an aborted commit/);
    // With something staged the pending hash belongs to the commit in progress.
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    const staged = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(staged, { failures: [], warnings: [] });
  });
});

test('--repo gives no pending-hash warning when git cannot read the index', async () => {
  const state = { version: 1, lastProgressSha256: 'a'.repeat(64), pendingProgressSha256: 'b'.repeat(64) };
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home, { state });
    writeFileSync(join(repo, '.git', 'index'), 'not an index'); // git diff --cached fails
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('--repo reports both tracking roots', async () => {
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home);
    installTasks(installPath, { paths: pathsAnswer(committedPaths(repo, true)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r.failures, ['both committed and local tracking exist: run triqual progress-init --local --remove']);
  });
});

test('--repo reports triqual tasks check drift with its output lines and the fix', async () => {
  const lines = ['plan-a: T2 is done but its commit abc1234 does not exist', 'status.md Active plan section is stale — run triqual tasks render'];
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home);
    installTasks(installPath, { paths: pathsAnswer(committedPaths(repo)), check: { code: 1, stdout: `${lines.join('\n')}\n` } });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    for (const line of lines) assert.ok(r.failures[0].includes(line), r.failures[0]);
    assert.ok(r.failures[0].endsWith(`: ${DRIFT_FIX}`), r.failures[0]);
    assert.ok(!r.failures[0].includes('\n'), 'one FAIL line');
  });
});

test('--repo reports a tasks.mjs that fails or prints something unexpected, without crashing', async () => {
  for (const answers of [
    { paths: { code: 0, stdout: '{ not json' } },
    { paths: { code: 3, stderr: 'boom\n' } },
    { paths: null, check: { code: 2, stderr: 'ambiguous ledger\n' } },
  ]) {
    await withHome(async ({ home, installPath }) => {
      const repo = makeRepo(home);
      installTasks(installPath, { ...answers, paths: answers.paths ?? pathsAnswer(committedPaths(repo)) });
      const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.match(r.failures[0], /^triqual tasks (paths|check) /);
    });
  }
});

test('without --repo no repo check runs', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { gate: null });
    const r = await diagnose({ home, cwd: repo, run: fakeRun().run });
    assert.deepEqual(r.failures, []);
  });
});

test('realRun resolves the exit code and output, and 127 on a spawn error', async () => {
  const ok = await realRun(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'], { timeoutMs: 10000 });
  assert.deepEqual(ok, { code: 3, stdout: 'hi', stderr: '' });
  const missing = await realRun('cm-doctor-no-such-command', [], { timeoutMs: 10000 });
  assert.equal(missing.code, 127);
});

test('realRun runs the command in the given cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-doctor-cwd-'));
  try {
    const r = await realRun(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 10000, cwd: dir });
    assert.deepEqual(r, { code: 0, stdout: realpathSync(dir), stderr: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('realRun gives up after timeoutMs with a non-zero code', async () => {
  const started = Date.now();
  const r = await realRun(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 10000);
});

test('realRun gives up after timeoutMs even when a grandchild holds the pipes', async () => {
  const started = Date.now();
  // `; true` keeps sh from exec-ing sleep, so sleep is a grandchild holding stdout and stderr.
  const r = await realRun('sh', ['-c', 'sleep 5; true'], { timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 124);
  assert.ok(elapsed < 1000, `resolved after ${elapsed} ms`);
});

test('git gives up after its timeout and returns null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-doctor-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // Git blocks opening an included FIFO that has no writer: a real hang, with no grandchild.
    execFileSync('mkfifo', [join(dir, '.git', 'hang.fifo')]);
    execFileSync('git', ['config', 'include.path', 'hang.fifo'], { cwd: dir });
    const started = Date.now();
    assert.equal(git(dir, ['config', 'core.hooksPath'], 300), null);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `returned after ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CLI = join(PLUGIN_ROOT, 'cli', 'doctor.mjs');
// PATH holds no headjack, so the CLI's real run warns instead of reaching the network.
const cli = (home, args = []) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: home, encoding: 'utf8', env: { HOME: home, PATH: join(home, 'empty-path') },
});

test('the CLI prints FAIL and WARN lines and the summary, and exits 1 on failures', () => {
  withHome(({ home }) => {
    const r = cli(home);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('FAIL ')).length, 1, r.stdout);
    assert.ok(r.stdout.split('\n').some((l) => l.startsWith('FAIL ') && l.endsWith(BOOTSTRAP_FIX)), r.stdout);
    assert.match(r.stdout, /^WARN .*headjack/m);
    assert.ok(lines.includes(`WARN ${kept(2)}`), r.stdout);
    assert.equal(lines.at(-1), 'doctor: 1 failure(s), 2 warning(s)');
  }, (p) => { p.shim = false; });
});

test('the CLI exits 0 with only warnings', () => {
  withHome(({ home }) => {
    const r = cli(home, ['--repo']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').at(-1), 'doctor: 0 failure(s), 2 warning(s)');
  });
});

// ---- final fix wave, residual ----

test('--repo in committed mode reports a pre-commit that does not chain progress-gate.sh', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { preCommit: '#!/bin/sh\necho lint\n' });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, [`${join(realpathSync(repo), '.git', 'hooks', 'pre-commit')} does not chain progress-gate.sh: run triqual progress-init`]);
  });
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { preCommit: null });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, [`${join(realpathSync(repo), '.git', 'hooks', 'pre-commit')} does not chain progress-gate.sh: run triqual progress-init`]);
  });
});

test('--repo in committed mode asks for the line by hand in a pre-commit that is not a shell script', async () => {
  await withHome(async ({ home }) => {
    const repo = makeRepo(home, { preCommit: '#!/usr/bin/env python3\nprint("lint")\n' });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, [`${join(realpathSync(repo), '.git', 'hooks', 'pre-commit')} is not a shell script (#!/usr/bin/env python3): `
      + `add this line to it by hand: ${COMMITTED_LINE}`]);
  });
});

test('--repo accepts the committed mode progress-init really installs', async () => {
  await withHome(async ({ home }) => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, HOME: home };
    delete env.XDG_CONFIG_HOME;
    execFileSync(process.execPath, [REAL_INIT], { cwd: repo, env, stdio: 'ignore' });
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('the CLI prints its usage on --help and -h, exits 0 and runs no check', () => {
  withHome(({ home }) => {
    for (const args of [['--help'], ['-h'], ['--repo', '--help']]) {
      const r = cli(home, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.equal(r.stdout.split('\n')[0], 'usage: triqual doctor [--repo]', args.join(' '));
      assert.doesNotMatch(r.stdout, /^(FAIL|WARN|doctor:) /m, args.join(' '));
    }
  }, (p) => { p.shim = false; });
});

test('the CLI rejects unknown arguments with the usage on stderr and exit 2', () => {
  withHome(({ home }) => {
    for (const args of [['--bogus'], ['repo'], ['--repo', 'extra']]) {
      const r = cli(home, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, new RegExp(`^triqual doctor: unknown argument ${args.at(-1)}\\n`), args.join(' '));
      assert.match(r.stderr, /^usage: triqual doctor \[--repo\]$/m, args.join(' '));
    }
  });
});

test('doctor reports an unreadable legacy-headings.json as a failure', async () => {
  for (const text of [null, '{ nope', '{"a":1}']) {
    await withHome(async ({ home, installPath }) => {
      const path = join(installPath('methodology'), 'rules', 'legacy-headings.json');
      rmSync(path);
      if (text !== null) writeFileSync(path, text);
      const r = await diagnose({ home, cwd: home, run: fakeRun().run });
      assert.equal(r.failures.length, 1, r.failures.join('\n'));
      assert.ok(r.failures[0].includes(path), r.failures[0]);
      assert.ok(r.failures[0].endsWith(`: reinstall methodology@${BRAND.marketplace}`), r.failures[0]);
    });
  }
});

test('doctor --repo stays quiet about project-scope enables under keepSuperseded', async () => {
  await withHome(async ({ home }) => {
    writeConfig(home, { keepSuperseded: true });
    const repo = makeRepo(home);
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }));
    const r = await diagnose({ home, cwd: repo, repo: true, run: fakeRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  }, (p) => { p.supersedes = ['superpowers@*']; });
});

test('doctor --repo skips the project check outside a git repo and on the user settings file', async () => {
  // Run from the home, which is not a git repo: only the user-scope failure, no contradictory project warning.
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, [`superseded plugin ${SUPERSEDED} is still enabled: run triqual sync`]);
    assert.deepEqual(r.warnings, []);
  }, (p) => { p.supersedes = ['superpowers@*']; p.settings.enabledPlugins[SUPERSEDED] = true; });
  // A home that is itself a git repo (dotfiles): its .claude/settings.json is the user settings file.
  await withHome(async ({ home }) => {
    execFileSync('git', ['init', '-q'], { cwd: home });
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }));
    const r = await diagnose({ home, cwd: home, repo: true, run: fakeRun().run });
    assert.deepEqual(r.failures, [`superseded plugin ${SUPERSEDED} is still enabled: run triqual sync`]);
    assert.deepEqual(r.warnings, []);
  }, (p) => { p.supersedes = ['superpowers@*']; p.settings.enabledPlugins[SUPERSEDED] = true; });
});

test('doctor tolerates non-string manifest entries', async () => {
  await withHome(async ({ home }) => {
    const r = await diagnose({ home, cwd: home, run: fakeRun().run });
    assert.deepEqual(r.failures, [`superseded plugin ${SUPERSEDED} is still enabled: run triqual sync`]);
  }, (p) => { p.supersedes = [null, 3, { a: 1 }, 'superpowers@*']; p.settings.enabledPlugins[SUPERSEDED] = true; });
});

// ---- progress-tracking 0.2.2's paths --json facts (Plan sp3-orchestration · T11, spec Addendum E.5, E.8) ----

test('doctor treats optedIn false as not opted in and runs no other repo check', async () => {
  const { run, calls } = tasksRun();
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home, { gate: null }); // the legacy logic would report the missing gate
    const tasks = installTasks(installPath, { paths: pathsAnswer({ optedIn: false, ...PATHS_FACTS }) });
    const r = await diagnose({ home, cwd: repo, repo: true, run });
    assert.deepEqual(r, { failures: [], warnings: [] });
    assert.deepEqual(notExport(calls).map(([, args]) => args), [HEADJACK_ARGS[1], [tasks, 'paths', '--json']]);
  });
});

test('doctor checks the hook lines paths --json gives, not its own copies', async () => {
  const other = { 'pre-commit': 'node "/elsewhere/gate.mjs" || exit 1', 'post-commit': 'node "/elsewhere/gate.mjs" --post-commit' };
  const facts = { ...PATHS_FACTS, localHookLines: other };
  // Hooks chaining the lines init chains today: the facts name other lines, so both hooks fail.
  await withHome(async ({ home, installPath }) => {
    const { repo, root, hooks } = makeLocalRepo(home);
    installTasks(installPath, { paths: pathsAnswer({ optedIn: true, ...localPaths(root), ...facts }) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r.failures, ['pre-commit', 'post-commit'].map((name) => `${join(realpathSync(hooks), name)} does not `
      + 'chain the local progress gate: run triqual progress-init --local'));
  });
  // Hooks chaining the lines the facts give: clean.
  await withHome(async ({ home, installPath }) => {
    const { repo, root, hooks } = makeLocalRepo(home);
    for (const [name, line] of Object.entries(other)) writeFileSync(join(hooks, name), `#!/bin/sh\n${line}\n`, { mode: 0o755 });
    installTasks(installPath, { paths: pathsAnswer({ optedIn: true, ...localPaths(root), ...facts }) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(r, { failures: [], warnings: [] });
  });
});

test('doctor reports paths --json facts that are missing or malformed', async () => {
  const noLines = { notOptedInMessage: NOT_OPTED_IN };
  const halfLines = { notOptedInMessage: NOT_OPTED_IN, localHookLines: { 'pre-commit': LOCAL_PRE } };
  const noMessage = { localHookLines: PATHS_FACTS.localHookLines };
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home);
    for (const value of [
      { optedIn: false, ...noLines }, { optedIn: false, ...noMessage }, { optedIn: true, ...committedPaths(repo), ...halfLines },
      { optedIn: 'yes', ...committedPaths(repo), ...PATHS_FACTS },
    ]) {
      installTasks(installPath, { paths: pathsAnswer(value) });
      const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
      assert.deepEqual(r.failures, [`triqual tasks paths --json printed an unexpected result: reinstall progress-tracking@${BRAND.marketplace}`],
        JSON.stringify(value));
    }
  });
});

test('an older exit-2 install falls back to its own copies', async () => {
  // Not opted in: exit 2 with the message doctor keeps a copy of.
  await withHome(async ({ home, installPath }) => {
    const repo = makeRepo(home, { gate: null });
    installTasks(installPath, { paths: { code: 2, stderr: `${NOT_OPTED_IN}\n` } });
    assert.deepEqual(await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run }), { failures: [], warnings: [] });
  });
  // Opted in: the paths without optedIn and facts; the hooks are checked against doctor's own lines.
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home, { post: false });
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /post-commit does not chain the local progress gate: run triqual progress-init --local$/);
  });
});

// ---- per set-up harness (spec Addendum F.5) ----

// A config.toml without the legacy bridge's table: the triqual bridge, and its trust keys (F.11 P5a).
const BRIDGE = `methodology-codex@${BRAND.marketplace}`;
const CODEX_TRUST_KEYS = ['session_start', 'stop'].map((event) => `${BRIDGE}:hooks/hooks.json:${event}:0:0`);
const LAUNCHER_TEXT = readFileSync(join(REPO_ROOT, 'plugins', 'methodology', 'setup', 'triqual-hook'));
const TRUST_FIX = 'start Codex and approve the triqual hooks in its trust prompt';
const STAMP_WARNING = 'no methodology hook has run since the bridge was installed or updated: '
  + 'start Codex and approve its hooks if prompted';
const GROK_COMPAT_WARNING = "Grok's Claude compatibility for hooks is off: the progress gate does not run in Grok";
const VERSION_FIX = 'update progress-tracking: an older one ignores the gate\'s --budget or flags roles:complex-implementer';
const HOOKS_ON = 'hooks  stable  true\n';
// The [agents] table triqual sync leaves; the trust tests that rewrite config.toml append it to stay about trust.
const DEPTH_OK = '\n[agents]\nmax_depth = 2\n';
const jsonAnswer = (value) => ({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
const trustToml = (keys = CODEX_TRUST_KEYS) => `model = "gpt"\n\n${keys
  .map((k) => `[hooks.state."${k}"]\ntrusted_hash = "sha256:0000"\n`).join('\n')}`;

// A Claude plugin's hooks file as Grok's Claude compatibility lists it in `grok inspect --json` hooks[] (F.11), in the
// real entry shape (key names checked against Grok 1.0.41): the hooks file is `target`, `source.path` the plugin dir.
const compatHooks = (home, name = 'progress-tracking') => {
  const dir = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace, 'plugins', name);
  return {
    event: 'SessionStart', hookType: 'command', matcher: null,
    source: { type: 'plugin', plugin_name: name, path: dir },
    target: join(dir, 'hooks', 'hooks.json'),
  };
};
const grokStillLoads = (name) => `plugin ${name}@${BRAND.marketplace} is disabled in Claude, but Grok's Claude `
  + 'compatibility still loads its hooks and skills (it ignores enabledPlugins): it still runs in Grok';

// The healthy answers of the harness CLIs, by `<cmd> <args>`.
const harnessAnswers = (home) => ({
  'headjack search ping -k 1 --json': { code: 0, stdout: '[]', stderr: '' },
  'codex plugin list --json': jsonAnswer({ installed: [{ pluginId: BRIDGE, enabled: true }] }),
  'codex features list': { code: 0, stdout: HOOKS_ON, stderr: '' },
  'grok plugin list --json': jsonAnswer([]),
  'grok inspect --json': jsonAnswer({ hooks: [compatHooks(home)], rules: [{ path: 'x' }] }),
});

// A run answering from `answers` (a value or a function of the call's opts), recording each call; anything else
// exits 127, as a missing binary does.
function answerRun(answers) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    const a = answers[`${cmd} ${args.join(' ')}`];
    if (a === undefined) return { code: 127, stdout: '', stderr: `${cmd}: not found` };
    return typeof a === 'function' ? a(opts) : a;
  };
  return { run, calls };
}

// A machine with `harnesses` set up by the real triqual sync: config.json records them enabled, ~/.codex and ~/.grok
// exist, the launcher is the marketplace copy's, the plugins ship what sync reads, Codex trusts both hooks, the
// bridge dir is older than the last-run stamp. `before(ctx)` runs before sync, `after(ctx)` after it; `tweak` edits
// withHome's parts.
function withHarnessHome(fn, { harnesses = ['codex', 'grok'], tweak = () => {}, before = () => {}, after = () => {} } = {}) {
  return withHome(async ({ home, installPath }) => {
    const put = (path, text, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, mode ? { mode } : undefined);
    };
    const methodology = installPath('methodology');
    cpSync(join(PLUGIN_ROOT, 'rules', 'harness'), join(methodology, 'rules', 'harness'), { recursive: true });
    for (const skill of ['brainstorming', 'writing-plans']) put(join(methodology, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    put(join(installPath('progress-tracking'), 'skills', 'progress-tracking', 'SKILL.md'), '# progress-tracking\n');
    cpSync(join(REPO_ROOT, 'plugins', 'roles', 'agents'), join(installPath('roles'), 'agents'), { recursive: true });
    const market = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace);
    put(join(market, 'plugins', 'methodology', 'setup', 'triqual-hook'), LAUNCHER_TEXT, 0o755);
    put(join(home, '.local', 'bin', 'triqual-hook'), LAUNCHER_TEXT, 0o755);
    put(join(home, '.config', BRAND.dir, 'config.json'),
      JSON.stringify({ harnesses: Object.fromEntries(harnesses.map((id) => [id, { enabled: true }])) }));
    if (harnesses.includes('codex')) {
      put(join(home, '.codex', 'config.toml'), trustToml());
      mkdirSync(codexBridgeDir(home), { recursive: true });
    }
    if (harnesses.includes('grok')) mkdirSync(join(home, '.grok'), { recursive: true });
    const answers = harnessAnswers(home);
    const ctx = { home, installPath, answers, market };
    await before(ctx);
    for (const id of harnesses) {
      const { steps } = await syncHarness({ home, id, run: answerRun(answers).run });
      assert.deepEqual(steps.filter((s) => s.status === 'failed'), [], `${id} sync`);
    }
    if (harnesses.includes('codex')) {
      const old = new Date(Date.now() - 3600 * 1000);
      utimesSync(codexBridgeDir(home), old, old);
      put(join(home, '.local', 'state', BRAND.dir, 'last-run-codex'), '2026-09-29T00:00:00Z session-start\n');
    }
    await after(ctx);
    return fn(ctx);
  }, (p) => {
    for (const id of IDS) {
      if (id.startsWith('progress-tracking@')) p.installed.plugins[id][0].version = '0.2.4';
    }
    p.marketplace['progress-tracking'] = '0.2.4';
    tweak(p);
  });
}

const harnessDoctor = async (ctx, opts = {}) => {
  const { run, calls } = answerRun(ctx.answers);
  const r = await diagnose({ home: ctx.home, cwd: ctx.home, run, ...opts });
  return { ...r, calls };
};

test('a machine set up for Codex and Grok by triqual sync yields no failures, read-only, every CLI call through run', async () => {
  await withHarnessHome(async (ctx) => {
    const before = snapshot(ctx.home);
    const { failures, warnings, calls } = await harnessDoctor(ctx);
    assert.deepEqual({ failures, warnings }, { failures: [], warnings: [] });
    assert.deepEqual(snapshot(ctx.home), before);
    assert.deepEqual(calls.map(([cmd, args]) => `${cmd} ${args.join(' ')}`).sort(), [
      'codex features list', 'codex plugin list --json', 'grok inspect --json', 'grok plugin list --json',
      'headjack search ping -k 1 --json',
    ]);
  });
});

test('a harness not enabled in config.json is not checked, and an enabled one not installed is skipped with no failure', async () => {
  // Recorded disabled, or not recorded at all: no harness call, no harness line.
  for (const harnesses of [{ codex: { enabled: false } }, {}]) {
    await withHome(async ({ home }) => {
      mkdirSync(join(home, '.codex'));
      writeConfig(home, JSON.stringify({ harnesses }));
      const { run, calls } = answerRun(harnessAnswers(home));
      assert.deepEqual(await diagnose({ home, cwd: home, run }), { failures: [], warnings: [] });
      assert.deepEqual(calls.map(([cmd]) => cmd), ['headjack']);
    });
  }
  // Enabled, but neither ~/.codex nor a codex binary: one line, no failure, no check.
  await withHome(async ({ home }) => {
    writeConfig(home, JSON.stringify({ harnesses: { codex: { enabled: true } } }));
    const { run, calls } = answerRun(harnessAnswers(home));
    const r = await diagnose({ home, cwd: home, run });
    assert.deepEqual(r, { failures: [], warnings: ['harness codex: not installed (skipped)'] });
    assert.ok(!calls.some(([cmd, args]) => cmd === 'codex' && args[0] !== '--version'), JSON.stringify(calls));
  });
});

test('launcher check: a missing triqual-hook or one that differs from the marketplace copy fails', async () => {
  await withHarnessHome(async (ctx) => {
    const launcher = join(ctx.home, '.local', 'bin', 'triqual-hook');
    rmSync(launcher);
    let r = await harnessDoctor(ctx);
    assert.deepEqual(r.failures, [`the hook launcher ${launcher} is missing: ${BOOTSTRAP_FIX}`]);
    writeFileSync(launcher, `${LAUNCHER_TEXT}# edited\n`);
    r = await harnessDoctor(ctx);
    assert.deepEqual(r.failures, [`the hook launcher ${launcher} differs from the marketplace copy `
      + `${join(ctx.market, 'plugins', 'methodology', 'setup', 'triqual-hook')}: ${RERUN_FIX}`]);
  }, { harnesses: ['grok'] });
});

test('launcher check uses the installed methodology setup/ copy, with no marketplace clone', async () => {
  await withHarnessHome(async (ctx) => {
    const launcher = join(ctx.home, '.local', 'bin', 'triqual-hook');
    const installed = join(ctx.installPath('methodology'), 'setup', 'triqual-hook');
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, LAUNCHER_TEXT, { mode: 0o755 });
    rmSync(ctx.market, { recursive: true, force: true });
    let r = await harnessDoctor(ctx);
    assert.deepEqual(r.failures.filter((f) => f.includes('launcher')), []);
    assert.deepEqual(r.warnings.filter((w) => w.includes('launcher')), []);
    writeFileSync(launcher, `${LAUNCHER_TEXT}# edited\n`);
    r = await harnessDoctor(ctx);
    assert.deepEqual(r.failures.filter((f) => f.includes('launcher')), [`the hook launcher ${launcher} differs from the `
      + `installed copy ${installed}: ${RERUN_FIX}`]);
  }, { harnesses: ['grok'] });
});

test('after the shim step installs the six files in a temp home, doctor reports no shim or launcher failure', async () => {
  await withHarnessHome(async (ctx) => {
    rmSync(join(ctx.home, '.local', 'bin'), { recursive: true, force: true });
    const installed = await installCli({ home: ctx.home });
    assert.equal(installed.status, 'done', installed.detail);
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual({ failures, warnings }, { failures: [], warnings: [] });
  }, { harnesses: ['grok'] });
});

test('version check: progress-tracking older than 0.2.4 fails once a harness is set up, and only then', async () => {
  // 0.2.3 is the last release without roles:complex-implementer among its task roles.
  const older = (p) => {
    p.installed.plugins[`progress-tracking@${BRAND.marketplace}`][0].version = '0.2.3';
    p.marketplace['progress-tracking'] = '0.2.3';
  };
  await withHarnessHome(async (ctx) => {
    const { failures } = await harnessDoctor(ctx);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], new RegExp(`^progress-tracking@${BRAND.marketplace} is 0\\.2\\.3, older than 0\\.2\\.4: `));
    assert.ok(failures[0].endsWith(VERSION_FIX), failures[0]);
  }, { harnesses: ['grok'], tweak: older });
  await withHome(async ({ home }) => {
    assert.deepEqual(await diagnose({ home, cwd: home, run: fakeRun().run }), { failures: [], warnings: [] });
  }, older);
});

test('Codex bridge check: not listed, or listed but disabled, fails with the sync fix', async () => {
  for (const installed of [[], [{ pluginId: BRIDGE, enabled: false }]]) {
    await withHarnessHome(async (ctx) => {
      ctx.answers['codex plugin list --json'] = jsonAnswer({ installed });
      const { failures } = await harnessDoctor(ctx);
      const word = installed.length ? 'not enabled' : 'not installed';
      assert.deepEqual(failures, [`the Codex bridge ${BRIDGE} is ${word}: run triqual sync --harness codex`]);
    }, { harnesses: ['codex'] });
  }
});

test('Codex trust check: a missing header or trusted_hash fails with the approval fix, one line per hook', async () => {
  await withHarnessHome(async (ctx) => {
    const config = join(ctx.home, '.codex', 'config.toml');
    // The stop key's header without a trusted_hash under it, and the session-start key missing.
    writeFileSync(config, `model = "gpt"\n\n[hooks.state."${CODEX_TRUST_KEYS[1]}"]\nenabled = true\n\n[other]\ntrusted_hash = "x"\n${DEPTH_OK}`);
    const { failures } = await harnessDoctor(ctx);
    assert.equal(failures.length, 2, failures.join('\n'));
    for (const [i, event] of [[0, 'session_start'], [1, 'stop']]) {
      assert.ok(failures[i].includes(`the ${event} hook`), failures[i]);
      assert.ok(failures[i].endsWith(`: ${TRUST_FIX}`), failures[i]);
    }
    rmSync(config);
    const r = await harnessDoctor(ctx);
    assert.deepEqual(r.failures, [`${config} does not exist: ${TRUST_FIX}`]);
  }, { harnesses: ['codex'] });
});

test('Codex trust check: an array continuation line inside our table does not hide a later trusted_hash', async () => {
  await withHarnessHome(async (ctx) => {
    const config = join(ctx.home, '.codex', 'config.toml');
    writeFileSync(config, [
      'model = "gpt"', '',
      `[hooks.state."${CODEX_TRUST_KEYS[0]}"]`, 'extra = [', '  [1, 2],', '  ["a", "b"],', ']',
      'trusted_hash = "sha256:0000"', '',
      `[hooks.state."${CODEX_TRUST_KEYS[1]}"]`, 'trusted_hash = "sha256:0000"', '',
    ].join('\n') + DEPTH_OK);
    assert.deepEqual((await harnessDoctor(ctx)).failures, []);
    // A real header still ends our table: an array-of-tables header before the hash leaves the key untrusted.
    writeFileSync(config, [
      `[hooks.state."${CODEX_TRUST_KEYS[0]}"]`, '[[profiles]]', 'trusted_hash = "sha256:0000"', '',
      `[hooks.state."${CODEX_TRUST_KEYS[1]}"]`, 'trusted_hash = "sha256:0000"', '',
    ].join('\n') + DEPTH_OK);
    const { failures } = await harnessDoctor(ctx);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(failures[0].includes('the session_start hook') && failures[0].endsWith(`: ${TRUST_FIX}`), failures[0]);
  }, { harnesses: ['codex'] });
});

test('doctor never prints a config.toml value', async () => {
  const SECRET_HASH = 'SECRET-SHAPED-9f8e7d6c5b4a';
  const SECRET_KEY = 'ghp_SecretLookingKey0123456789abcdef';
  const SECRET_VALUE = 'sk-live-SecretLookingValue42';
  await withHarnessHome(async (ctx) => {
    const config = join(ctx.home, '.codex', 'config.toml');
    // Our session-start key trusted with a secret-shaped hash, our stop key untrusted (so a failure is printed), and
    // a foreign secret-looking key with a value.
    writeFileSync(config, [
      `${SECRET_KEY} = "${SECRET_VALUE}"`, '',
      `[hooks.state."${CODEX_TRUST_KEYS[0]}"]`, `trusted_hash = "${SECRET_HASH}"`, '',
      `[hooks.state."${SECRET_KEY}"]`, `trusted_hash = "${SECRET_VALUE}"`, '',
    ].join('\n') + DEPTH_OK);
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.equal(failures.length, 1, failures.join('\n'));
    const out = JSON.stringify({ failures, warnings });
    for (const secret of [SECRET_HASH, SECRET_KEY, SECRET_VALUE]) assert.ok(!out.includes(secret), secret);
  }, { harnesses: ['codex'] });
});

test('last-run stamp check: missing, or older than the bridge dir, warns', async () => {
  await withHarnessHome(async (ctx) => {
    const stamp = join(ctx.home, '.local', 'state', BRAND.dir, 'last-run-codex');
    rmSync(stamp);
    let r = await harnessDoctor(ctx);
    assert.deepEqual({ failures: r.failures, warnings: r.warnings }, { failures: [], warnings: [STAMP_WARNING] });
    writeFileSync(stamp, 'old\n');
    const older = new Date(Date.now() - 7200 * 1000);
    utimesSync(stamp, older, older);
    r = await harnessDoctor(ctx);
    assert.deepEqual(r.warnings, [STAMP_WARNING]);
  }, { harnesses: ['codex'] });
});

test('Codex hooks feature check: off fails', async () => {
  await withHarnessHome(async (ctx) => {
    ctx.answers['codex features list'] = { code: 0, stdout: 'hooks  stable  false\n', stderr: '' };
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['the Codex hooks feature is off: run triqual sync --harness codex']);
  }, { harnesses: ['codex'] });
});

test('Codex rules check: a managed section that is missing or differs fails', async () => {
  await withHarnessHome(async (ctx) => {
    const agents = join(ctx.home, '.codex', 'AGENTS.md');
    writeFileSync(agents, `# Mine\n\n${MARKERS.start}\nold rules\n${MARKERS.end}\n`);
    let { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`the managed section of ${agents} differs from what triqual sync writes: run triqual sync --harness codex`]);
    writeFileSync(agents, '# Mine\n');
    ({ failures } = await harnessDoctor(ctx));
    assert.deepEqual(failures, [`${agents} has no triqual managed section: run triqual sync --harness codex`]);
  }, { harnesses: ['codex'] });
});

test('Codex links check: a missing link fails; a collision is listed with its fix', async () => {
  await withHarnessHome(async (ctx) => {
    const skills = join(ctx.home, '.codex', 'skills');
    rmSync(join(skills, 'brainstorming'));
    let { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`Codex skill links in ${skills} are missing or out of date (brainstorming): run triqual sync --harness codex`]);
    mkdirSync(join(skills, 'brainstorming'));
    ({ failures } = await harnessDoctor(ctx));
    assert.deepEqual(failures, [`${join(skills, 'brainstorming')} is not a triqual link, so triqual sync leaves it `
      + 'alone and skill brainstorming is not linked in Codex: move or remove it, then run triqual sync --harness codex']);
  }, { harnesses: ['codex'] });
});

test('Codex links check: a leftover link to a removed methodology skill warns, a foreign or live link does not', async () => {
  await withHarnessHome(async (ctx) => {
    const skills = join(ctx.home, '.codex', 'skills');
    const stale = (name) => `stale Codex skill link: ${name}: methodology no longer ships skill ${name}: run triqual sync `
      + `--harness codex, or delete ${join(skills, name)} if the link stays`;
    // Into the current install (dangling) and into an older version's cache (also dangling): both name a removed skill.
    symlinkSync(join(ctx.installPath('methodology'), 'skills', 'requesting-code-review'), join(skills, 'requesting-code-review'));
    symlinkSync(join(dirname(ctx.installPath('methodology')), '0.7.0', 'skills', 'writing-skills'), join(skills, 'writing-skills'));
    // Not ours: a dangling link elsewhere, and a link into a directory that is not a plugin's skills folder.
    symlinkSync(join(ctx.home, 'elsewhere', 'mine'), join(skills, 'mine'));
    symlinkSync(join(ctx.home, 'notes', 'methodology', 'skills', 'old'), join(skills, 'old'));
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, [stale('requesting-code-review'), stale('writing-skills')]);
  }, { harnesses: ['codex'] });
});

test('Codex links check: a live link into the install, under a name the install does not use, does not warn', async () => {
  await withHarnessHome(async (ctx) => {
    const skills = join(ctx.home, '.codex', 'skills');
    // A skill the install still ships, linked under another name: its target SKILL.md exists, so nothing is stale.
    symlinkSync(join(ctx.installPath('methodology'), 'skills', 'writing-plans'), join(skills, 'plans-copy'));
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, []);
  }, { harnesses: ['codex'] });
});

test('Codex links check: with methodology disabled in Claude, links to skills the install still ships do not warn', async () => {
  await withHarnessHome(async (ctx) => {
    const skills = join(ctx.home, '.codex', 'skills');
    // Sync links nothing while methodology is disabled; a link left from before points at a live skill of the install.
    symlinkSync(join(ctx.installPath('methodology'), 'skills', 'brainstorming'), join(skills, 'brainstorming'));
    // A skill the install does not ship is not named either: disabled, there is no skill set to compare with.
    symlinkSync(join(ctx.installPath('methodology'), 'skills', 'writing-skills'), join(skills, 'writing-skills'));
    const { warnings } = await harnessDoctor(ctx);
    assert.deepEqual(warnings.filter((w) => w.startsWith('stale Codex skill link')), []);
  }, {
    harnesses: ['codex'],
    tweak: (p) => { p.settings.enabledPlugins[IDS[0]] = false; },
  });
});

test('Codex agents check: an edited agent fails; a hand-written one is listed with its fix', async () => {
  await withHarnessHome(async (ctx) => {
    const file = join(ctx.home, '.codex', 'agents', 'spec-reviewer.toml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}# edited\n`);
    let { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`Codex role agents in ${join(ctx.home, '.codex', 'agents')} are missing or out of date `
      + '(spec-reviewer): run triqual sync --harness codex']);
    writeFileSync(file, 'name = "mine"\n');
    ({ failures } = await harnessDoctor(ctx));
    assert.deepEqual(failures, [`${file} is not generated by triqual: run triqual sync --harness codex `
      + '(it backs the file up, then writes role spec-reviewer)']);
  }, { harnesses: ['codex'] });
});

test('Codex depth check: an [agents] max_depth below 2, or unset, fails with the sync fix; 2 or more passes', async () => {
  await withHarnessHome(async (ctx) => {
    const config = join(ctx.home, '.codex', 'config.toml');
    const synced = readFileSync(config, 'utf8');
    assert.match(synced, /^max_depth = 2$/m, 'sync raised it');
    const fix = 'run triqual sync --harness codex';
    for (const [text, shown] of [
      [synced.replace('max_depth = 2', 'max_depth = 1'), '1'],
      [synced.replace('max_depth = 2', 'max_depth = 0'), '0'],
      [synced.replace('max_depth = 2\n', ''), 'unset'],
    ]) {
      writeFileSync(config, text);
      assert.deepEqual((await harnessDoctor(ctx)).failures, [`Codex [agents] max_depth is ${shown}, below 2: ${fix}`], shown);
    }
    // Sync will not edit these, so the fix is by hand (it must not recommend a sync that fails).
    writeFileSync(config, synced.replace('max_depth = 2', 'max_depth = "deep"'));
    assert.deepEqual((await harnessDoctor(ctx)).failures, ['Codex [agents] max_depth is not a number: set it to 2 or more by hand']);
    const byHand = (shown) => [`Codex [agents] max_depth is ${shown}, in a dotted or inline key that sync cannot edit: set it to 2 or more by hand`];
    for (const [text, shown] of [
      [`agents.max_depth = 1\n${synced.replace('[agents]\nmax_depth = 2\n', '')}`, '1'],
      [`agents = { max_depth = 1 }\n${synced.replace('[agents]\nmax_depth = 2\n', '')}`, '1'],
      [`agents.max_threads = 4\n${synced.replace('[agents]\nmax_depth = 2\n', '')}`, 'not a readable number'],
    ]) {
      writeFileSync(config, text);
      assert.deepEqual((await harnessDoctor(ctx)).failures, byHand(shown), text.split('\n')[0]);
    }
    for (const ok of ['2', '3', '10', '0x3']) {
      writeFileSync(config, synced.replace('max_depth = 2', `max_depth = ${ok}`));
      assert.deepEqual((await harnessDoctor(ctx)).failures, [], ok);
    }
    for (const text of [
      `agents.max_depth = 3\n${synced.replace('[agents]\nmax_depth = 2\n', '')}`,
      `agents = { max_depth = 3 }\n${synced.replace('[agents]\nmax_depth = 2\n', '')}`,
      synced.replace('[agents]', '["agents"]'),
      synced.replace('max_depth', '"max_depth"'),
    ]) {
      writeFileSync(config, text);
      assert.deepEqual((await harnessDoctor(ctx)).failures, [], text.split('\n')[0]);
    }
  }, { harnesses: ['codex'] });
});

test('a missing phase-orchestrator Codex agent fails and names it', async () => {
  await withHarnessHome(async (ctx) => {
    const dir = join(ctx.home, '.codex', 'agents');
    rmSync(join(dir, 'phase-orchestrator.toml'));
    assert.deepEqual((await harnessDoctor(ctx)).failures,
      [`Codex role agents in ${dir} are missing or out of date (phase-orchestrator): run triqual sync --harness codex`]);
  }, { harnesses: ['codex'] });
});

test('an installed roles plugin without phase-orchestrator.md fails with the update command', async () => {
  const diagnoseHome = (home) => diagnose({ home, cwd: home, run: fakeRun().run });
  const fail = `the installed roles plugin has no phase-orchestrator agent: run claude plugin update roles@${BRAND.marketplace}`;
  await withHome(({ home, installPath }) => {
    rmSync(join(installPath('roles'), 'agents', 'phase-orchestrator.md'));
    return diagnoseHome(home).then((r) => assert.deepEqual(matching(r.failures, /phase-orchestrator/), [fail]));
  });
  await withHome(({ home }) => diagnoseHome(home).then((r) => assert.deepEqual(matching(r.failures, /phase-orchestrator/), [])));
  await withHarnessHome(async (ctx) => {
    rmSync(join(ctx.installPath('roles'), 'agents', 'phase-orchestrator.md'));
    assert.deepEqual((await harnessDoctor(ctx)).failures, [fail]);
  }, { harnesses: ['codex'] });
});

test('Codex agents check: an agent generated under the legacy mark reads as out of date, not as hand-written', async () => {
  await withHarnessHome(async (ctx) => {
    const file = join(ctx.home, '.codex', 'agents', 'spec-reviewer.toml');
    cpSync(join(PLUGIN_ROOT, 'test', 'fixtures', 'legacy', 'codex-agent.toml'), file);
    assert.ok(readFileSync(file, 'utf8').startsWith(BRAND.legacy.generatedMark));
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`Codex role agents in ${join(ctx.home, '.codex', 'agents')} are missing or out of date `
      + '(spec-reviewer): run triqual sync --harness codex']);
  }, { harnesses: ['codex'] });
});

test('Codex checks follow the legacy bridge while config.toml holds its table', async () => {
  const legacy = `methodology-codex@${BRAND.legacy.marketplace}`;
  const legacyKeys = ['session_start', 'stop'].map((event) => `${legacy}:hooks/hooks.json:${event}:0:0`);
  await withHarnessHome(async (ctx) => {
    // The legacy table is the legacy scan's failure; the Codex checks follow the bridge it names.
    // The fix is the codex command itself, which also works when migrate cannot run codex.
    const tableFailure = `${join(ctx.home, '.codex', 'config.toml')} has the table [plugins."${legacy}"]: `
      + `run codex plugin remove ${legacy}`;
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual({ failures, warnings }, { failures: [tableFailure], warnings: [] });
    // The triqual bridge listed instead: the legacy one is not installed.
    ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [{ pluginId: BRIDGE, enabled: true }] });
    assert.deepEqual((await harnessDoctor(ctx)).failures,
      [tableFailure, `the Codex bridge ${legacy} is not installed: ${LEGACY_FIX}`]); // no legacy clone: migrate
  }, {
    harnesses: ['codex'],
    before: (ctx) => {
      writeFileSync(join(ctx.home, '.codex', 'config.toml'),
        `${trustToml(legacyKeys)}\n[plugins."${legacy}"]\nenabled = true\n`);
      mkdirSync(codexBridgeDir(ctx.home), { recursive: true });
      ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [{ pluginId: legacy, enabled: true }] });
    },
    after: (ctx) => {
      assert.ok(codexBridgeDir(ctx.home).includes(join('cache', BRAND.legacy.marketplace, 'methodology-codex')));
      const old = new Date(Date.now() - 3600 * 1000);
      utimesSync(codexBridgeDir(ctx.home), old, old);
    },
  });
});

test('Codex bridge check: with no clone of the marketplace the bridge id names, the fix is the migration', async () => {
  await withHarnessHome(async (ctx) => {
    ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [] });
    rmSync(ctx.market, { recursive: true, force: true });
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(matching(failures, /Codex bridge/), [`the Codex bridge ${BRIDGE} is not installed: ${LEGACY_FIX}`]);
  }, { harnesses: ['codex'] });
});

test('a legacy Codex marketplace table is named once, by the legacy scan', async () => {
  await withHarnessHome(async (ctx) => {
    const config = join(ctx.home, '.codex', 'config.toml');
    writeFileSync(config, `${readFileSync(config, 'utf8')}\n[marketplaces.${BRAND.legacy.marketplace}]\nsource = "/x"\n`);
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(matching(failures, /\[marketplaces\./),
      [`${config} has the table [marketplaces.${BRAND.legacy.marketplace}]: run codex plugin marketplace remove `
        + `${BRAND.legacy.marketplace}`]);
  }, { harnesses: ['codex'] });
});

test('Codex superseded check: an enabled superseded plugin fails, and warns under keepSuperseded', async () => {
  const listed = jsonAnswer({ installed: [{ pluginId: BRIDGE, enabled: true }, { pluginId: 'superpowers@openai-curated', enabled: true },
    { pluginId: 'superpowers@other', enabled: false }] });
  await withHarnessHome(async (ctx) => {
    ctx.answers['codex plugin list --json'] = listed;
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['superseded plugin superpowers@openai-curated is still enabled in Codex: run triqual sync --harness codex']);
  }, { harnesses: ['codex'], tweak: (p) => { p.supersedes = ['superpowers@*']; } });
  await withHarnessHome(async (ctx) => {
    ctx.answers['codex plugin list --json'] = listed;
    writeConfig(ctx.home, JSON.stringify({ keepSuperseded: true, harnesses: { codex: { enabled: true } } }));
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(failures, []);
    assert.equal(matching(warnings, /superpowers@openai-curated is enabled in Codex by keepSuperseded/).length, 1, warnings.join('\n'));
  }, { harnesses: ['codex'], tweak: (p) => { p.supersedes = ['superpowers@*']; } });
});

test('Codex superseded check: a plugin triqual sync recorded disabling but Codex still lists enabled warns; an unrecorded one fails', async () => {
  const REMOTE = 'looks remotely managed: disable it in Codex itself; triqual sync cannot';
  const entry = (pluginId) => ({ pluginId, enabled: true });
  await withHarnessHome(async (ctx) => {
    // triqual sync disabled (and recorded) superpowers@openai-curated, yet Codex keeps listing it enabled; superpowers@late
    // appeared after that sync, so the manifest records nothing for it.
    const recorded = readManifest(ctx.home).harnesses.codex.config
      .filter((c) => c.key === 'enabled').map((c) => c.table);
    assert.deepEqual(recorded, ['plugins."superpowers@openai-curated"']);
    ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [entry(BRIDGE), entry('superpowers@openai-curated'),
      entry('superpowers@late')] });
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['superseded plugin superpowers@late is still enabled in Codex: run triqual sync --harness codex']);
    assert.deepEqual(warnings, [`superseded plugin superpowers@openai-curated is still enabled in Codex after triqual sync `
      + `disabled it: ${REMOTE}`]);
  }, {
    harnesses: ['codex'],
    tweak: (p) => { p.supersedes = ['superpowers@*']; },
    before: (ctx) => {
      ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [entry(BRIDGE), entry('superpowers@openai-curated')] });
    },
  });
});

test('doctor and triqual sync agree: the Codex plugins doctor flags are the ones sync disables, the stale Grok plugins are the ones it uninstalls', async () => {
  // Codex: doctor's failing ids are exactly the tables triqual sync then records disabling.
  await withHarnessHome(async (ctx) => {
    ctx.answers['codex plugin list --json'] = jsonAnswer({ installed: [{ pluginId: BRIDGE, enabled: true },
      { pluginId: 'superpowers@a', enabled: true }, { pluginId: 'superpowers@b', enabled: false },
      { pluginId: 'other@c', enabled: true }, { pluginId: 'superpowers@d', enabled: true }] });
    const flagged = (await harnessDoctor(ctx)).failures.map((f) => /^superseded plugin (\S+) is still enabled/.exec(f)?.[1]);
    assert.deepEqual(flagged, ['superpowers@a', 'superpowers@d']);
    await syncHarness({ home: ctx.home, id: 'codex', run: answerRun(ctx.answers).run });
    const tables = readManifest(ctx.home).harnesses.codex.config.filter((c) => c.key === 'enabled').map((c) => c.table);
    assert.deepEqual(tables, flagged.map(codexPluginTable));
  }, { harnesses: ['codex'], tweak: (p) => { p.supersedes = ['superpowers@*']; } });
  // Grok: doctor's stale names are exactly the ones triqual sync uninstalls, over entries inside, outside (a symlink out and
  // a Claude-compat path) and unresolvable.
  await withHarnessHome(async (ctx) => {
    const base = join(ctx.home, '.grok', 'installed-plugins');
    const entries = [
      { name: 'methodology', path: join(base, 'methodology-1') },
      { name: 'roles', path: join(base, 'roles-out') },
      { name: 'workflow-gate', path: join(base, 'workflow-gate-gone') },
      { name: 'progress-tracking', path: join(ctx.home, '.claude', 'plugins', 'progress-tracking') },
      { name: 'superpowers', path: join(base, 'superpowers-2') },
      { name: 'other', path: join(base, 'other-3') },
    ];
    for (const e of entries) if (!/-(out|gone)$/.test(e.path)) mkdirSync(e.path, { recursive: true });
    mkdirSync(join(ctx.home, 'outside'));
    symlinkSync(join(ctx.home, 'outside'), join(base, 'roles-out'));
    ctx.answers['grok plugin list --json'] = jsonAnswer(entries);
    const flagged = (await harnessDoctor(ctx)).failures.map((f) => /^stale Grok plugin (\S+) is installed/.exec(f)?.[1]);
    assert.deepEqual(flagged, ['methodology', 'superpowers']);
    const answers = { ...ctx.answers };
    for (const e of entries) answers[`grok plugin uninstall ${e.name}`] = { code: 0, stdout: '', stderr: '' };
    const { run, calls } = answerRun(answers);
    await syncHarness({ home: ctx.home, id: 'grok', run });
    const uninstalled = calls.filter(([cmd, args]) => cmd === 'grok' && args[1] === 'uninstall').map(([, args]) => args[2]);
    assert.deepEqual(uninstalled, flagged);
    assert.deepEqual(grokStaleEntries(ctx.home, entries, false).stale.map((p) => p.name), flagged);
  }, { harnesses: ['grok'] });
});

test('Grok hooks file check: missing or different fails', async () => {
  await withHarnessHome(async (ctx) => {
    const hooks = join(ctx.home, '.grok', 'hooks', `${BRAND.grokName}.json`);
    writeFileSync(hooks, '{}\n');
    let { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`${hooks} is missing or differs from what triqual sync writes: run triqual sync --harness grok`]);
    rmSync(hooks);
    ({ failures } = await harnessDoctor(ctx));
    assert.deepEqual(failures, [`${hooks} is missing or differs from what triqual sync writes: run triqual sync --harness grok`]);
  }, { harnesses: ['grok'] });
});

test('a leftover legacy grok file is one failure with its fix, the legacy scan\'s', async () => {
  await withHarnessHome(async (ctx) => {
    const rules = join(ctx.home, '.grok', 'rules', `${BRAND.legacy.grokName}.md`);
    const hooks = join(ctx.home, '.grok', 'hooks', `${BRAND.legacy.grokName}.json`);
    writeFileSync(rules, 'old rules\n');
    writeFileSync(hooks, '{"hooks":{}}\n');
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [hooks, rules].map((path) => `${path} is a legacy-named Grok file: ${LEGACY_FIX}`));
  }, { harnesses: ['grok'] });
});

test('Grok rules file check: different fails while methodology is enabled in Claude; none is expected while disabled', async () => {
  await withHarnessHome(async (ctx) => {
    const rules = join(ctx.home, '.grok', 'rules', `${BRAND.grokName}.md`);
    writeFileSync(rules, 'old\n');
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`${rules} is missing or differs from what triqual sync writes: run triqual sync --harness grok`]);
  }, { harnesses: ['grok'] });
  // Methodology disabled in Claude before sync: sync writes no rules file, and doctor asks for none.
  await withHarnessHome(async (ctx) => {
    assert.equal(existsSync(join(ctx.home, '.grok', 'rules', `${BRAND.grokName}.md`)), false);
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, [`plugin methodology@${BRAND.marketplace} is not enabled: run claude plugin enable methodology@${BRAND.marketplace}`]);
  }, { harnesses: ['grok'], tweak: (p) => { p.settings.enabledPlugins[`methodology@${BRAND.marketplace}`] = false; } });
});

test('grok gate check', async () => {
  // Listed: ok, run in a fresh scratch dir outside the home that is removed afterwards.
  await withHarnessHome(async (ctx) => {
    const seen = [];
    const listed = ctx.answers['grok inspect --json'];
    ctx.answers['grok inspect --json'] = (opts) => {
      seen.push({ cwd: opts.cwd, existed: existsSync(opts.cwd), entries: readdirSync(opts.cwd) });
      return listed;
    };
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual({ failures, warnings }, { failures: [], warnings: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].existed, true);
    assert.deepEqual(seen[0].entries, []);
    assert.ok(!seen[0].cwd.startsWith(ctx.home), seen[0].cwd);
    assert.ok(basename(seen[0].cwd).startsWith(`${BRAND.cli}-doctor-grok-`), seen[0].cwd);
    assert.equal(existsSync(seen[0].cwd), false, 'scratch dir removed');
  }, { harnesses: ['grok'] });
  // Not listed: no hooks[], another plugin's hooks, a progress-tracking hooks file outside ~/.claude/plugins/, a
  // relative target, or an entry in the invented shape (the hooks file in `path`, no `target`).
  for (const hooks of [undefined, [{ ...compatHooks('/x'), source: { type: 'plugin', plugin_name: 'workflow-gate' } }],
    [{ ...compatHooks('/elsewhere') }], ['relative'], ['path-only']]) {
    await withHarnessHome(async (ctx) => {
      if (hooks === undefined) ctx.answers['grok inspect --json'] = jsonAnswer({ rules: [] });
      else {
        const h = hooks.map((e) => {
          if (e === 'relative') return { ...compatHooks(ctx.home), target: join('plugins', 'progress-tracking', 'hooks', 'hooks.json') };
          if (e === 'path-only') {
            const { target, ...rest } = compatHooks(ctx.home);
            return { ...rest, path: target };
          }
          return e.source.plugin_name === 'workflow-gate' ? { ...compatHooks(ctx.home), source: e.source } : e;
        });
        ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: h });
      }
      const { failures, warnings } = await harnessDoctor(ctx);
      assert.deepEqual({ failures, warnings }, { failures: [], warnings: [GROK_COMPAT_WARNING] });
    }, { harnesses: ['grok'] });
  }
});

test('grok gate check: a plugin disabled in Claude whose hooks file Grok still lists warns (compat ignores enabledPlugins)', async () => {
  const notEnabled = (name) => `plugin ${name}@${BRAND.marketplace} is not enabled: run claude plugin enable ${name}@${BRAND.marketplace}`;
  // Disabled in Claude and still listed by Grok: the fixed warning, for each plugin.
  for (const name of ['progress-tracking', 'methodology']) {
    await withHarnessHome(async (ctx) => {
      ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: [compatHooks(ctx.home), compatHooks(ctx.home, 'methodology')] });
      const { failures, warnings } = await harnessDoctor(ctx);
      assert.ok(failures.includes(notEnabled(name)), failures.join('\n'));
      assert.deepEqual(warnings, [grokStillLoads(name)]);
    }, { harnesses: ['grok'], tweak: (p) => { p.settings.enabledPlugins[`${name}@${BRAND.marketplace}`] = false; } });
  }
  // Disabled in Claude and not listed (progress-tracking: the gate warning only; methodology: nothing).
  await withHarnessHome(async (ctx) => {
    ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: [compatHooks(ctx.home)] });
    const { warnings } = await harnessDoctor(ctx);
    assert.deepEqual(warnings, []);
  }, { harnesses: ['grok'], tweak: (p) => { p.settings.enabledPlugins[`methodology@${BRAND.marketplace}`] = false; } });
  await withHarnessHome(async (ctx) => {
    ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: [compatHooks(ctx.home, 'methodology')] });
    const { warnings } = await harnessDoctor(ctx);
    assert.deepEqual(warnings, [GROK_COMPAT_WARNING]);
  }, { harnesses: ['grok'], tweak: (p) => { p.settings.enabledPlugins[`progress-tracking@${BRAND.marketplace}`] = false; } });
  // Enabled in Claude and listed: no warning.
  await withHarnessHome(async (ctx) => {
    ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: [compatHooks(ctx.home), compatHooks(ctx.home, 'methodology')] });
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual({ failures, warnings }, { failures: [], warnings: [] });
  }, { harnesses: ['grok'] });
});

test('the grok gate check never prints grok inspect output', async () => {
  const SECRET = 'xai-SECRET-TOKEN-inspect-5c4b3a';
  for (const answer of [
    jsonAnswer({ hooks: [], env: { XAI_API_KEY: SECRET }, rules: [{ path: SECRET }] }),
    { code: 0, stdout: `not json ${SECRET}`, stderr: SECRET },
    { code: 3, stdout: SECRET, stderr: `error: ${SECRET}` },
  ]) {
    await withHarnessHome(async (ctx) => {
      ctx.answers['grok inspect --json'] = answer;
      const { failures, warnings } = await harnessDoctor(ctx);
      assert.deepEqual(failures, []);
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.ok(!JSON.stringify(warnings).includes(SECRET), warnings[0]);
      assert.ok(!JSON.stringify(warnings).includes('xai-'), warnings[0]);
    }, { harnesses: ['grok'] });
  }
  // The disabled-in-Claude warning is fixed text too: secret-shaped values in the listed entries never reach it.
  await withHarnessHome(async (ctx) => {
    const entry = { ...compatHooks(ctx.home), event: SECRET, matcher: SECRET, source: { ...compatHooks(ctx.home).source, type: SECRET } };
    ctx.answers['grok inspect --json'] = jsonAnswer({ hooks: [entry], env: { XAI_API_KEY: SECRET } });
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(warnings, [grokStillLoads('progress-tracking')]);
    assert.ok(!JSON.stringify({ failures, warnings }).includes(SECRET));
    assert.ok(!JSON.stringify({ failures, warnings }).includes('xai-'));
  }, { harnesses: ['grok'], tweak: (p) => { p.settings.enabledPlugins[`progress-tracking@${BRAND.marketplace}`] = false; } });
});

test('Grok stale plugins check: counts only entries under ~/.grok/installed-plugins/, superpowers kept by keepSuperseded', async () => {
  const entries = (home) => [
    { status: 'installed', name: 'methodology', path: join(home, '.grok', 'installed-plugins', 'methodology-1a2b') },
    { status: 'installed', name: 'superpowers', path: join(home, '.grok', 'installed-plugins', 'superpowers-3c4d') },
    // A Claude-compat path, and a symlink out of installed-plugins: never counted.
    { status: 'installed', name: 'roles', path: join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace, 'plugins', 'roles') },
    { status: 'installed', name: 'workflow-gate', path: join(home, '.grok', 'installed-plugins', 'workflow-gate-out') },
    { status: 'installed', name: 'other', path: join(home, '.grok', 'installed-plugins', 'other-5e6f') },
  ];
  const lay = (ctx) => {
    for (const e of entries(ctx.home)) if (e.name !== 'workflow-gate') mkdirSync(e.path, { recursive: true });
    mkdirSync(join(ctx.home, 'outside'), { recursive: true });
    symlinkSync(join(ctx.home, 'outside'), join(ctx.home, '.grok', 'installed-plugins', 'workflow-gate-out'));
    ctx.answers['grok plugin list --json'] = jsonAnswer(entries(ctx.home));
  };
  await withHarnessHome(async (ctx) => {
    lay(ctx);
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['stale Grok plugin methodology is installed: run triqual sync --harness grok',
      'stale Grok plugin superpowers is installed: run triqual sync --harness grok']);
  }, { harnesses: ['grok'] });
  await withHarnessHome(async (ctx) => {
    lay(ctx);
    writeConfig(ctx.home, JSON.stringify({ keepSuperseded: true, harnesses: { grok: { enabled: true } } }));
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['stale Grok plugin methodology is installed: run triqual sync --harness grok']);
  }, { harnesses: ['grok'] });
});

// grok is not on PATH while Grok is set up (a Grok dir in the home, the harness enabled in config.json): every call
// exits 127. That is no broken install, so doctor warns, once from each Grok check, and fails nothing.
test('grok not on PATH: every grok call exiting 127 is two warnings and no failure', async () => {
  await withHarnessHome(async (ctx) => {
    delete ctx.answers['grok plugin list --json'];
    delete ctx.answers['grok inspect --json'];
    const { failures, warnings } = await harnessDoctor(ctx);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, [
      'grok plugin list --json failed (exit 127): cannot tell whether stale Grok plugins are installed',
      'grok inspect --json failed (exit 127): cannot tell whether Grok runs the progress gate',
    ]);
  }, { harnesses: ['grok'] });
  // Any other failing exit stays a failure: grok runs and answers wrongly.
  await withHarnessHome(async (ctx) => {
    ctx.answers['grok plugin list --json'] = { code: 1, stdout: '', stderr: 'boom' };
    const { failures } = await harnessDoctor(ctx);
    assert.deepEqual(failures, ['grok plugin list --json failed (exit 1): check that grok runs, then run triqual doctor again']);
  }, { harnesses: ['grok'] });
});

test('--repo warns about an AGENTS.md without the tracking section in committed mode only', async () => {
  const WARNING = 'run triqual progress-init to add the tracking section to AGENTS.md';
  const SECTION = '<!-- progress-tracking:start (managed) -->\n## Progress tracking\n<!-- progress-tracking:end -->\n';
  for (const [agents, expected] of [[null, []], ['# Agents\n', [WARNING]], [`# Agents\n\n${SECTION}`, []]]) {
    await withHome(async ({ home, installPath }) => {
      const repo = makeRepo(home);
      if (agents !== null) writeFileSync(join(repo, 'AGENTS.md'), agents);
      installTasks(installPath, { paths: pathsAnswer(committedPaths(repo)) });
      const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.warnings.map((w) => (w.endsWith(WARNING) ? WARNING : w)), expected);
      if (expected.length) assert.ok(r.warnings[0].includes(join(realpathSync(repo), 'AGENTS.md')), r.warnings[0]);
    });
  }
  // Local mode writes nothing to the working tree: an AGENTS.md there is not checked.
  await withHome(async ({ home, installPath }) => {
    const { repo, root } = makeLocalRepo(home);
    writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n');
    installTasks(installPath, { paths: pathsAnswer(localPaths(root)) });
    assert.deepEqual(await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run }), { failures: [], warnings: [] });
  });
});

test('--repo accepts the AGENTS.md section progress-init really writes', async () => {
  await withHome(async ({ home, installPath }) => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n');
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig') };
    delete env.XDG_CONFIG_HOME;
    writeFileSync(join(home, 'gitconfig'), '');
    execFileSync(process.execPath, [REAL_INIT], { cwd: repo, env, stdio: 'ignore' });
    installTasks(installPath, { paths: pathsAnswer(committedPaths(repo)) });
    const r = await diagnose({ home, cwd: repo, repo: true, run: tasksRun().run });
    assert.deepEqual(matching(r.warnings, /AGENTS\.md/), []);
  });
});

// ---- store mode (Plan Store-2 T5) ----

test('doctor keeps its copy of the store hook lines and script names equal to progress-tracking\'s', () => {
  assert.deepEqual(STORE_HOOKS, STORE_HOOK_LINES);
  const init = readFileSync(join(REPO_ROOT, 'plugins', 'progress-tracking', 'scripts', 'init.mjs'), 'utf8');
  const [, pre, post] = /const STORE_SCRIPTS = Object\.freeze\(\{ 'pre-commit': '([^']+)', 'post-commit': '([^']+)' \}\)/.exec(init);
  assert.deepEqual(STORE_SCRIPTS, { 'pre-commit': pre, 'post-commit': post });
});

test('nodeCheck fails below Node 22.13, comparing major and minor', () => {
  const run = (version) => {
    const failures = [];
    nodeCheck(version, failures);
    return failures;
  };
  assert.deepEqual(run('22.12.0'), ['node 22.12.0 is older than 22.13: install Node 22.13 or newer']);
  assert.deepEqual(run('20.19.0'), ['node 20.19.0 is older than 22.13: install Node 22.13 or newer']);
  for (const ok of ['22.13.0', '22.23.1', '23.0.0', '24.1.0']) assert.deepEqual(run(ok), [], ok);
});

test('doctor reports the Node floor on every call, with and without --repo', async () => {
  // The suite runs on Node 22.13 or newer, so the floor itself is quiet here.
  await withHome(async ({ home }) => {
    assert.deepEqual((await doctor({ home, cwd: home, run: fakeRun().run })).failures, []);
  });
});

const dayName = (daysAgo) => `tracking-${new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)}.db`;

// Runs fn with the store's environment set on this process: doctor runs `triqual tasks` and `triqual tracking` through
// realRun, which inherits it. TRIQUAL_TRACKING_DB may be changed per call (`db`).
async function inStoreEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A store repository made by a real `progress-init --store` under the fixture home, with the real progress-tracking
// scripts as the installed plugin. `snapshotDaysAgo` writes the newest backup (none when null).
function makeStoreRepo(home, installPath, { snapshotDaysAgo = 0 } = {}) {
  const pt = installPath('progress-tracking');
  for (const dir of ['cli', 'lib', 'scripts', 'templates']) {
    cpSync(join(REPO_ROOT, 'plugins', 'progress-tracking', dir), join(pt, dir), { recursive: true });
  }
  const data = join(home, 'data');
  const registry = join(home, 'registry');
  mkdirSync(registry);
  const env = {
    HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    TRIQUAL_TRACKING_DB: join(data, 'tracking.db'), TRIQUAL_REGISTRY_DIR: registry,
  };
  writeFileSync(join(home, 'gitconfig'), '');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|XDG_|TRIQUAL_)/.test(k)));
  const spawnEnv = { ...clean, ...env };
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: spawnEnv, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README'), 'demo\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  execFileSync(process.execPath, [join(REPO_ROOT, 'plugins', 'progress-tracking', 'cli', 'progress-init.mjs'), '--store'],
    { cwd: repo, env: spawnEnv, stdio: 'ignore' });
  if (snapshotDaysAgo !== null) {
    mkdirSync(join(data, 'backups'), { recursive: true });
    writeFileSync(join(data, 'backups', dayName(snapshotDaysAgo)), 'snapshot');
  }
  return { repo, root: realpathSync(repo), env, hooks: join(realpathSync(repo), '.git', 'hooks'), data };
}

const fullDiagnosis = async (home, repo, extra = {}) => {
  const r = await doctor({ home, cwd: repo, repo: true, run: tasksRun().run, ...extra });
  assert.ok(matching(r.warnings, KEPT).length <= 1, r.warnings.join('\n'));
  return { ...r, warnings: r.warnings.filter((w) => !KEPT.test(w)) };
};

test('--repo accepts the store mode progress-init --store really installs, and lists its mode', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const r = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.notes, [`tracking: ${s.root} store`]);
  });
});

test('doctor returns notes only with --repo', async () => {
  await withHome(async ({ home }) => {
    assert.deepEqual(Object.keys(await doctor({ home, cwd: home, run: fakeRun().run })), ['failures', 'warnings']);
    assert.deepEqual(Object.keys(await doctor({ home, cwd: home, repo: true, run: fakeRun().run })), ['failures', 'warnings', 'notes']);
  });
});

test('--repo in store mode reports a pre-commit that does not chain the store script', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    writeFileSync(join(s.hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(r.failures, [`${join(s.hooks, 'pre-commit')} does not chain progress-store-pre-commit.sh: `
      + 'run triqual progress-init --store (in a linked worktree of a switched clone: merge main instead)']);
  });
});

test('--repo in store mode reports a post-commit script missing its exec line, and a missing script', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const script = join(s.hooks, 'progress-store-post-commit.sh');
    const text = readFileSync(script, 'utf8');
    assert.ok(text.includes('exec triqual tracking hook post-commit'), text);
    writeFileSync(script, text.replace('exec triqual tracking hook post-commit', ''));
    const missingLine = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(missingLine.failures, [`${script} is missing or differs from the store hook lines: run triqual progress-init --store`]);
    rmSync(script);
    const missing = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(missing.failures, missingLine.failures);
  });
});

test('--repo in store mode reports a pre-commit that still chains progress-gate.sh', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const hook = join(s.hooks, 'pre-commit');
    writeFileSync(hook, `${readFileSync(hook, 'utf8')}${COMMITTED_LINE}\n`, { mode: 0o755 });
    const r = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(r.failures, [`${hook} still chains progress-gate.sh: run triqual progress-init --store`]);
  });
});

test('--repo in store mode asks for the chain line by hand in a hook that is not a shell script', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    writeFileSync(join(s.hooks, 'post-commit'), '#!/usr/bin/env python3\nprint(1)\n', { mode: 0o755 });
    const r = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /post-commit is not a shell script \(#!\/usr\/bin\/env python3\): add this line to it by hand: sh .*progress-store-post-commit\.sh.* \|\| true$/);
  });
});

test('--repo with the store missing gives one FAIL naming the restore, creates no database and leaves a committed repo clean', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const missing = join(home, 'elsewhere', 'tracking.db');
    const env = { ...s.env, TRIQUAL_TRACKING_DB: missing };
    // A committed repository checked in the same environment.
    const committed = join(home, 'committed');
    mkdirSync(committed);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|XDG_|TRIQUAL_)/.test(k)));
    execFileSync('git', ['init', '-q'], { cwd: committed, env: { ...clean, ...env } });
    execFileSync(process.execPath, [REAL_INIT], { cwd: committed, env: { ...clean, ...env }, stdio: 'ignore' });
    const { run, calls } = tasksRun();
    const store = await inStoreEnv(env, () => fullDiagnosis(home, s.repo, { run }));
    assert.equal(store.failures.length, 1, store.failures.join('\n'));
    assert.match(store.failures[0], /^tracking store unavailable: no tracking database at .*elsewhere.*triqual tracking restore/);
    assert.equal(existsSync(missing), false, 'doctor created the database');
    assert.equal(existsSync(dirname(missing)), false, 'doctor created the database directory');
    // The repository's tasks check is skipped after that FAIL: it would repeat the same error.
    assert.deepEqual(calls.filter(([, args]) => args[1] === 'check'), []);
    const other = await inStoreEnv(env, () => fullDiagnosis(home, committed));
    assert.deepEqual(other.failures, []);
    assert.equal(existsSync(missing), false);
  });
});

test('--repo with the store disabled gives one FAIL and checks no snapshot', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const r = await inStoreEnv({ ...s.env, TRIQUAL_TRACKING_DB: 'relative.db' }, () => fullDiagnosis(home, s.repo));
    assert.equal(r.failures.length, 1, r.failures.join('\n'));
    assert.match(r.failures[0], /^tracking store unavailable: the tracking store is disabled/);
    assert.deepEqual(r.warnings, []);
  });
});

test('--repo warns about a store snapshot older than 3 days, and about none', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath, { snapshotDaysAgo: 4 });
    const newest = join(s.data, 'backups', dayName(4));
    // A newer snapshot than the one named is not in the way: the newest one counts.
    writeFileSync(join(s.data, 'backups', dayName(6)), 'older');
    const old = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.deepEqual(old.failures, []);
    assert.deepEqual(old.warnings, [`newest tracking snapshot is 4 days old (${newest}): the next triqual tracking add takes one`]);
    rmSync(join(s.data, 'backups'), { recursive: true });
    const none = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo));
    assert.equal(none.warnings.length, 1, none.warnings.join('\n'));
    assert.match(none.warnings[0], /^newest tracking snapshot is none \(.*\): the next triqual tracking add takes one$/);
    // The boundary: 3 days old is still fresh.
    mkdirSync(join(s.data, 'backups'));
    writeFileSync(join(s.data, 'backups', dayName(3)), 'snapshot');
    assert.deepEqual((await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo))).warnings, []);
  });
});

test('the CLI prints the INFO tracking lines before the summary', async () => {
  await withHome(async ({ home, installPath }) => {
    const s = makeStoreRepo(home, installPath);
    const tools = join(home, 'tools'); // git only: no headjack, so the CLI's real run warns instead of reaching the network
    mkdirSync(tools);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(tools, 'git'));
    const r = spawnSync(process.execPath, [CLI, '--repo'], { cwd: s.repo, encoding: 'utf8', env: { ...s.env, PATH: tools } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'doctor: 0 failure(s), 2 warning(s)'); // headjack, and the legacy items kept
    assert.equal(lines.at(-2), `INFO tracking: ${s.root} store`, r.stdout);
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL ')), []);
  });
});

// setup/bootstrap.mjs documents its own usage in its header; every other CLI and setup file that names the clone's
// installer must also name the command a plugin install runs, since bin/ exists only in a clone.
test('no bootstrap hint without /methodology:setup', () => {
  const files = [
    ...readdirSync(join(PLUGIN_ROOT, 'cli'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => join('cli', f)),
    ...readdirSync(join(PLUGIN_ROOT, 'setup')).filter((f) => f.endsWith('.mjs') && f !== 'bootstrap.mjs').map((f) => join('setup', f)),
  ];
  assert.ok(files.length > 10, files.join(', '));
  const bare = [];
  for (const file of files) {
    readFileSync(join(PLUGIN_ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('bin/bootstrap.mjs') && !line.includes('/methodology:setup')) bare.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bare, []);
});

// ---- fence (spec U9): detection, and doctor's information line ----

const FAKE_FENCE = join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-fence');
// Runs fn with the directory of a PATH that holds the fake fence under the name `fence`.
function withFenceDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-fence-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  copyFileSync(FAKE_FENCE, join(dir, 'fence'));
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

test('detectFence reads the version and FENCE_PROFILE from a fence on PATH', () => {
  withFenceDir((dir) => {
    assert.deepEqual(detectFence({ PATH: dir }), { version: '0.0.0-test', profile: null });
    assert.deepEqual(detectFence({ PATH: dir, FENCE_PROFILE: 'unattended' }), { version: '0.0.0-test', profile: 'unattended' });
    assert.deepEqual(detectFence({ PATH: dir, FENCE_PROFILE: '' }), { version: '0.0.0-test', profile: null });
    // A version printed without the program name is taken as is.
    assert.equal(detectFence({ PATH: dir, FAKE_FENCE_OUT: '1.2.3\n' }).version, '1.2.3');
  });
});

test('detectFence runs `fence version` as an argument array and nothing else', () => {
  withFenceDir((dir) => {
    const log = join(dir, 'calls.log');
    detectFence({ PATH: dir, FAKE_FENCE_LOG: log });
    assert.equal(readFileSync(log, 'utf8'), 'version\n---\n');
  });
});

test('detectFence gives null for no fence, a failing fence and a hung fence, and never throws', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cm-nofence-'));
  try {
    assert.equal(detectFence({ PATH: empty }), null);
    assert.doesNotThrow(() => detectFence(undefined));
    assert.doesNotThrow(() => detectFence({ PATH: 5 }));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  withFenceDir((dir) => {
    assert.equal(detectFence({ PATH: dir, FAKE_FENCE_EXIT: '3' }), null);
    const start = Date.now();
    // The fake `exec`s `sleep`, so the PATH also holds the system tools; the fake still comes first.
    assert.equal(detectFence({ PATH: `${dir}:${process.env.PATH}`, FAKE_FENCE_SLEEP: '30' }), null);
    const took = Date.now() - start;
    assert.ok(took >= 1500 && took < 6000, `the 2 s timeout ended the run after ${took} ms`);
  });
});

test('detectFence strips control characters and caps the length of the version and the profile', () => {
  withFenceDir((dir) => {
    const dirty = detectFence({ PATH: dir, FAKE_FENCE_OUT: 'fence 1.0\u001b[31m-x\u0007\n', FENCE_PROFILE: 'un\nat\u001btended' });
    assert.deepEqual(dirty, { version: '1.0[31m-x', profile: 'unattended' });
    const long = detectFence({ PATH: dir, FAKE_FENCE_OUT: `fence ${'9'.repeat(500)}`, FENCE_PROFILE: 'p'.repeat(500) });
    assert.equal(long.version, '9'.repeat(64));
    assert.equal(long.profile, 'p'.repeat(64));
    // A profile of control characters only is no profile.
    assert.equal(detectFence({ PATH: dir, FENCE_PROFILE: '\u0001\u0002' }).profile, null);
  });
});

test('detectFence takes a shorter timeout when its caller has little time left', () => {
  withFenceDir((dir) => {
    const start = Date.now();
    assert.equal(detectFence({ PATH: `${dir}:${process.env.PATH}`, FAKE_FENCE_SLEEP: '30' }, 300), null);
    const took = Date.now() - start;
    assert.ok(took < 1500, `the 300 ms timeout ended the run after ${took} ms`);
  });
});

test('doctor reports fence as information, with the profile when FENCE_PROFILE is set', async () => {
  await withHome(async ({ home }) => {
    await withFenceDir(async (dir) => {
      const plain = await doctor({ home, cwd: home, run: fakeRun().run, env: { PATH: dir } });
      assert.deepEqual(plain.notes, ['fence 0.0.0-test']);
      assert.deepEqual(plain.failures.filter((f) => /fence/i.test(f)), []);
      assert.deepEqual(plain.warnings.filter((w) => /fence/i.test(w)), []);
      const profiled = await doctor({ home, cwd: home, run: fakeRun().run, env: { PATH: dir, FENCE_PROFILE: 'unattended' } });
      assert.deepEqual(profiled.notes, ['fence 0.0.0-test, profile unattended']);
    });
  });
});

test('doctor --repo lists the fence line before the tracking lines', async () => {
  await withHome(async ({ home, installPath }) => {
    await withFenceDir(async (dir) => {
      const s = makeStoreRepo(home, installPath);
      const r = await inStoreEnv(s.env, () => fullDiagnosis(home, s.repo, { env: { PATH: dir } }));
      assert.deepEqual(r.notes, ['fence 0.0.0-test', `tracking: ${s.root} store`]);
    });
  });
});

test('without fence doctor reports nothing about it and returns the same keys', async () => {
  await withHome(async ({ home }) => {
    const env = { PATH: join(home, 'empty-path') };
    const plain = await doctor({ home, cwd: home, run: fakeRun().run, env });
    assert.deepEqual(Object.keys(plain), ['failures', 'warnings']);
    const repo = await doctor({ home, cwd: home, repo: true, run: fakeRun().run, env });
    assert.deepEqual(Object.keys(repo), ['failures', 'warnings', 'notes']);
    for (const line of [...plain.failures, ...plain.warnings, ...repo.notes]) assert.doesNotMatch(line, /fence/i);
  });
});

test('the CLI prints the INFO fence line before the summary', () => {
  withHome(({ home }) => {
    withFenceDir((dir) => {
      const r = spawnSync(process.execPath, [CLI], {
        cwd: home, encoding: 'utf8', env: { HOME: home, PATH: dir, FENCE_PROFILE: 'unattended' },
      });
      const lines = r.stdout.trimEnd().split('\n');
      assert.match(lines.at(-1), /^doctor: \d+ failure\(s\), \d+ warning\(s\)$/);
      assert.equal(lines.at(-2), 'INFO fence 0.0.0-test, profile unattended', r.stdout);
    });
  });
});
