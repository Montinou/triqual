import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGrokLeftover, isUnreadable, legacyScan } from '../cli/lib/legacy-scan.mjs';
import { BRAND } from '../cli/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const LEGACY_FIXTURES = join(TEST_DIR, 'fixtures', 'legacy');
const L = BRAND.legacy;
const PLUGINS = ['methodology', 'progress-tracking', 'workflow-gate', 'roles'];
const BRIDGE = `methodology-codex@${BRAND.marketplace}`;
const LEGACY_BRIDGE = `methodology-codex@${L.marketplace}`;
// An invented clone path: the clone keeps its old directory name, and what is keyed by it is not scanned.
const CLONE = `/x/${L.dir}`;
const BACKUP_STAMPS = ['20260901-100000', '20260902-100000', '20260903-100000', '20260904-100000',
  '20260905-100000', '20260906-100000', '20260907-100000', '20260908-100000'];

const put = (path, text, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? undefined : { mode });
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const section = (markers) => `# Machine\n\n${markers.start}\nrules body\n${markers.end}\n`;

// A home laid out like this machine after the migration, with no real data: the plugins under triqual, the new
// markers, Codex and Grok under the new names, the compatibility links, the cm alias and forwarder, and the legacy
// items kept on purpose (old caches, plugin data, backups, the Codex trust tables, the clone's project table, the
// registry entry for the clone, and 8 backup paths recorded in harnesses.json). The installed triqual.mjs carries the
// legacy literal, which is not content-scanned.
function migratedHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-scan-')));
  const claude = join(home, '.claude');
  const ids = PLUGINS.map((n) => `${n}@${BRAND.marketplace}`);
  put(join(claude, 'settings.json'), json({
    enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])),
    extraKnownMarketplaces: { [BRAND.marketplace]: { source: { source: 'github', repo: BRAND.source } } },
    permissions: { allow: [`Bash(${L.cli} tracking write:*)`, `Bash(${BRAND.cli} tracking write:*)`] },
  }));
  put(join(claude, 'plugins', 'installed_plugins.json'), json({
    version: 2,
    plugins: Object.fromEntries(ids.map((id) => [id, [{ scope: 'user', installPath: '/p', version: '0.4.0' }]])),
  }));
  put(join(claude, 'plugins', 'known_marketplaces.json'), json({
    [BRAND.marketplace]: { installLocation: join(claude, 'plugins', 'marketplaces', BRAND.marketplace) },
  }));
  put(join(claude, 'CLAUDE.md'), section(BRAND.markers));
  put(join(home, '.codex', 'AGENTS.md'), section(BRAND.markers));
  put(join(home, '.codex', 'config.toml'), [
    'model = "gpt"',
    '',
    `[marketplaces.${BRAND.marketplace}]`,
    'source = "/x"',
    '',
    `[plugins."${BRIDGE}"]`,
    'enabled = true',
    '',
    `[hooks.state."${LEGACY_BRIDGE}:hooks/hooks.json:stop:0:0"]`,
    'trusted_hash = "sha256:0000"',
    '',
    `[projects."${CLONE}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  put(join(home, '.grok', 'hooks', `${BRAND.grokName}.json`), '{}\n');
  put(join(home, '.grok', 'rules', `${BRAND.grokName}.md`), '# rules\n');
  const backups = join(claude, 'backups');
  const config = join(home, '.config', BRAND.dir);
  put(join(config, 'harnesses.json'), json({
    version: 1,
    harnesses: {
      codex: {
        links: [], rolesSha: null, rules: null, config: [],
        files: BACKUP_STAMPS.slice(0, 4).map((s, i) => ({
          path: join(home, '.codex', 'agents', `r${i}.toml`), sha256: null, backup: join(backups, `${L.dir}-${s}`, 'codex', `r${i}.toml`),
        })),
        plugins: [{ id: BRAND.marketplace, action: 'marketplace-added' }, { id: BRIDGE, action: 'added' }],
      },
      grok: {
        links: [], rolesSha: null, rules: null, config: [], plugins: [],
        files: BACKUP_STAMPS.slice(4).map((s, i) => ({
          path: join(home, '.grok', 'agents', `r${i}.md`), sha256: null, backup: join(backups, `${L.dir}-${s}`, 'grok', `r${i}.md`),
        })),
      },
    },
  }));
  put(join(config, 'repos.json'), json({ repos: [CLONE] }));
  for (const base of [join(home, '.config'), join(home, '.local', 'state'), join(home, '.local', 'share')]) {
    mkdirSync(join(base, BRAND.dir), { recursive: true });
    symlinkSync(BRAND.dir, join(base, L.dir));
  }
  const bin = join(home, '.local', 'bin');
  put(join(bin, BRAND.cliFile), `#!/usr/bin/env node\n${BRAND.ownership.shim}\n// was ${L.marketplace}\n`);
  symlinkSync(BRAND.cliFile, join(bin, BRAND.cli));
  put(join(bin, BRAND.launcher), `#!/usr/bin/env bash\n${BRAND.ownership.launcher}\n`, 0o755);
  cpSync(join(REPO_ROOT, 'bin', `${L.cli}-alias.mjs`), join(bin, L.cliFile));
  symlinkSync(L.cliFile, join(bin, L.cli));
  cpSync(join(REPO_ROOT, 'bin', `${L.launcher}-forwarder`), join(bin, L.launcher));
  put(join(claude, 'plugins', 'cache', L.marketplace, 'methodology', '0.3.0', 'README.md'), 'old\n');
  put(join(claude, 'plugins', 'data', `memory-report-${L.marketplace}`, 'state.json'), '{}\n');
  put(join(home, '.codex', 'plugins', 'cache', L.marketplace, 'methodology-codex', '0.1.0', 'x.json'), '{}\n');
  for (const s of BACKUP_STAMPS.slice(0, 2)) put(join(backups, `${L.dir}-${s}`, 'settings.json'), '{}\n');
  return home;
}

function withMigrated(fn) {
  const home = migratedHome();
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const edit = (path, change) => writeFileSync(path, change(readFileSync(path, 'utf8')));
const editJson = (path, change) => edit(path, (text) => json(change(JSON.parse(text))));
const has = (lines, ...parts) => lines.some((line) => parts.every((p) => line.includes(p)));

// Every file under dir with its bytes, mode and mtime (links by target), to prove the scan only reads.
function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      out[name] = 'dangling';
      continue;
    }
    out[name] = st.isDirectory() ? `dir ${st.mode}` : `${st.mode} ${st.mtimeMs} ${readFileSync(p, 'base64')}`;
  }
  return out;
}

test('migrated home: no failures, exempt items listed', () => {
  withMigrated((home) => {
    const before = snapshot(home);
    const { failures, exempt } = legacyScan(home);
    assert.deepEqual(failures, []);
    const bin = join(home, '.local', 'bin');
    const backups = join(home, '.claude', 'backups');
    const expected = [
      [join(bin, L.cliFile), 'alias'],
      [join(bin, L.launcher), 'forwarder'],
      [join(home, '.config', L.dir), 'compatibility link'],
      [join(home, '.local', 'state', L.dir), 'compatibility link'],
      [join(home, '.local', 'share', L.dir), 'compatibility link'],
      [join(home, '.claude', 'plugins', 'cache', L.marketplace), 'cache'],
      [join(home, '.codex', 'plugins', 'cache', L.marketplace), 'cache'],
      [join(home, '.claude', 'plugins', 'data', `memory-report-${L.marketplace}`), 'data'],
      [`hooks.state."${LEGACY_BRIDGE}:hooks/hooks.json:stop:0:0"`, 'Codex'],
      ...BACKUP_STAMPS.slice(0, 2).map((s) => [join(backups, `${L.dir}-${s}`), 'backup']),
      ...BACKUP_STAMPS.map((s) => [join(backups, `${L.dir}-${s}`) + '/', 'harnesses.json']),
    ];
    for (const [what, kind] of expected) assert.ok(has(exempt, what, kind), `${what} (${kind}) in\n${exempt.join('\n')}`);
    assert.equal(exempt.length, expected.length, exempt.join('\n'));
    // The clone's path is in config.toml's projects table, repos.json and triqual.mjs: none of them is scanned.
    assert.ok(!exempt.some((line) => line.includes(CLONE)), exempt.join('\n'));
    assert.ok(!exempt.some((line) => line.includes(BRAND.cliFile)), exempt.join('\n'));
    assert.deepEqual(snapshot(home), before);
  });
});

test('legacy enabledPlugins key is a failure', () => {
  withMigrated((home) => {
    const settings = join(home, '.claude', 'settings.json');
    const id = `roles@${L.marketplace}`;
    editJson(settings, (s) => ({ ...s, enabledPlugins: { ...s.enabledPlugins, [id]: false } }));
    const { failures } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, settings, id), failures[0]);
  });
});

test('legacy marker in AGENTS.md is a failure', () => {
  withMigrated((home) => {
    const agents = join(home, '.codex', 'AGENTS.md');
    edit(agents, (text) => text.replace(BRAND.markers.end, L.markers.end));
    const { failures } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, agents, 'marker'), failures[0]);
    assert.ok(!failures[0].includes('rules body'), 'no file contents in the message');
  });
});

test('legacy markers in CLAUDE.md are a failure even when the body is current', () => {
  withMigrated((home) => {
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    cpSync(join(LEGACY_FIXTURES, 'claude-md.md'), claudeMd);
    const { failures } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, claudeMd, 'marker'), failures[0]);
    assert.ok(!failures[0].includes('Installed rules body'), 'no file contents in the message');
  });
});

test('legacy marketplace table in config.toml is a failure; hooks.state and projects tables are not', () => {
  withMigrated((home) => {
    const config = join(home, '.codex', 'config.toml');
    // A header-looking line inside a multi-line string is not a table.
    edit(config, (text) => `${text}\n[marketplaces.${L.marketplace}]\nsource = "/x"\n\n`
      + `[profiles.p]\nnote = """\n[marketplaces."${L.marketplace}"]\n"""\n`);
    const { failures, exempt } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, config, `[marketplaces.${L.marketplace}]`), failures[0]);
    assert.ok(has(exempt, config, 'hooks.state'), exempt.join('\n'));
    assert.ok(!exempt.some((line) => line.includes('projects')), exempt.join('\n'));
  });
});

test('a legacy Codex bridge table beside the triqual one is a failure naming the legacy table', () => {
  withMigrated((home) => {
    const config = join(home, '.codex', 'config.toml');
    edit(config, (text) => `${text}\n[plugins."${LEGACY_BRIDGE}"]\nenabled = true\n`);
    const { failures } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, config, `[plugins."${LEGACY_BRIDGE}"]`), failures[0]);
    assert.ok(!has(failures, `[plugins."${BRIDGE}"]`), failures[0]);
  });
});

test(`alias ${BRAND.legacy.cliFile} is exempt; an old ${BRAND.legacy.cli} shim is a failure`, () => {
  withMigrated((home) => {
    const bin = join(home, '.local', 'bin');
    const alias = join(bin, L.cliFile);
    const forwarder = join(bin, L.launcher);
    assert.ok(has(legacyScan(home).exempt, alias, 'alias'));
    writeFileSync(alias, `#!/usr/bin/env node\n${L.ownership.shim}\n`);
    writeFileSync(forwarder, `#!/usr/bin/env bash\n${L.ownership.launcher}\n`);
    const { failures, exempt } = legacyScan(home);
    assert.equal(failures.length, 2, failures.join('\n'));
    assert.ok(has(failures, alias, 'alias'), failures.join('\n'));
    assert.ok(has(failures, forwarder, 'forwarder'), failures.join('\n'));
    assert.ok(!has(exempt, alias) && !has(exempt, forwarder), exempt.join('\n'));
    // The cm link is not content-scanned: the failure names the alias file, not the link to it.
    assert.ok(!failures.some((line) => line.startsWith(`${join(bin, L.cli)} `)), failures.join('\n'));
  });
});

test('both marketplaces known is a failure naming the legacy entry', () => {
  withMigrated((home) => {
    const known = join(home, '.claude', 'plugins', 'known_marketplaces.json');
    editJson(known, (k) => ({ ...k, [L.marketplace]: { installLocation: '/old' } }));
    const { failures } = legacyScan(home);
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.ok(has(failures, known, L.marketplace), failures[0]);
    assert.ok(!failures[0].includes('/old'), 'no file contents in the message');
  });
});

test('every other listed leftover is a failure, each named once', () => {
  withMigrated((home) => {
    const claude = join(home, '.claude');
    const settings = join(claude, 'settings.json');
    editJson(settings, (s) => ({
      ...s,
      extraKnownMarketplaces: { ...s.extraKnownMarketplaces, [L.marketplace]: { source: {} } },
      permissions: { allow: [...s.permissions.allow, `Read(~/.claude/plugins/cache/${L.marketplace}/**)`] },
    }));
    const installed = join(claude, 'plugins', 'installed_plugins.json');
    editJson(installed, (i) => ({ ...i, plugins: { ...i.plugins, [`methodology@${L.marketplace}`]: [] } }));
    const grokRules = join(home, '.grok', 'rules', `${L.grokName}.md`);
    const grokHooks = join(home, '.grok', 'hooks', `${L.grokName}.json`);
    put(grokRules, '# old\n');
    put(grokHooks, '{}\n');
    const manifest = join(home, '.config', BRAND.dir, 'harnesses.json');
    editJson(manifest, (m) => {
      m.harnesses.codex.plugins.push({ id: L.marketplace, action: 'marketplace-added' }, { id: LEGACY_BRIDGE, action: 'added' });
      return m;
    });
    const state = join(home, '.local', 'state', L.dir);
    rmSync(state);
    mkdirSync(state);
    const share = join(home, '.local', 'share', L.dir);
    rmSync(share);
    mkdirSync(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), share);
    const { failures } = legacyScan(home);
    const expected = [
      [settings, `extraKnownMarketplaces`, L.marketplace],
      [settings, 'permission rule', 'permissions.allow[2]'],
      [installed, `methodology@${L.marketplace}`],
      [grokRules],
      [grokHooks],
      [manifest, ` ${L.marketplace}`],
      [manifest, LEGACY_BRIDGE],
      [state, 'real directory'],
      [share, 'not a link to'],
    ];
    for (const parts of expected) assert.ok(has(failures, ...parts), `${parts.join(' ')} in\n${failures.join('\n')}`);
    assert.equal(failures.length, expected.length, failures.join('\n'));
    assert.ok(!failures.some((line) => line.includes('Read(')), 'the rule text is not printed');
  });
});

test('an unreadable or unparsable file is an exempt "could not read" line, never a crash', () => {
  withMigrated((home) => {
    const settings = join(home, '.claude', 'settings.json');
    const known = join(home, '.claude', 'plugins', 'known_marketplaces.json');
    const manifest = join(home, '.config', BRAND.dir, 'harnesses.json');
    const agents = join(home, '.codex', 'AGENTS.md');
    const config = join(home, '.codex', 'config.toml');
    writeFileSync(settings, `{ "hidden": "${L.marketplace}"`);
    writeFileSync(known, '[1, 2]');
    writeFileSync(manifest, 'not json');
    chmodSync(agents, 0o000);
    rmSync(config);
    mkdirSync(config); // a directory where the file belongs: reading it fails with EISDIR
    try {
      const { failures, exempt } = legacyScan(home);
      assert.deepEqual(failures, []);
      for (const path of [settings, manifest, config]) {
        assert.ok(exempt.includes(`could not read ${path}`), `${path} in\n${exempt.join('\n')}`);
      }
      // A JSON file of the wrong shape has nothing to scan; root may read a 0o000 file, so AGENTS.md is either way.
      assert.ok(!exempt.some((line) => line.includes(known)), exempt.join('\n'));
      assert.ok(!exempt.some((line) => line.includes('hidden')), 'no file contents in the message');
    } finally {
      chmodSync(agents, 0o644);
    }
  });
});

test('a permission rule naming the legacy plugin id or plugin dir is a failure; the clone path and additionalDirectories are not', () => {
  withMigrated((home) => {
    const settings = join(home, '.claude', 'settings.json');
    editJson(settings, (s) => ({
      ...s,
      permissions: {
        allow: [...s.permissions.allow, `Read(${CLONE}/**)`, `Skill(methodology:brainstorming@${L.marketplace})`,
          `Read(~/.claude/plugins/marketplaces/${L.marketplace}/**)`, `Read(~/.claude/plugins/cache/${L.marketplace}-x/**)`],
        additionalDirectories: [CLONE, `~/.claude/plugins/cache/${L.marketplace}`],
      },
    }));
    const { failures } = legacyScan(home);
    assert.deepEqual(failures, [3, 4].map((i) => `${settings} has a permission rule naming ${L.marketplace} (permissions.allow[${i}])`));
  });
});

// A set-up Codex whose records still name the legacy bridge while no legacy table is left: migrate rewrites the records
// only where it can run codex, so with codex off PATH `run triqual migrate` would leave the line as it is.
test('legacy Codex records with no legacy table: the fix asks for codex on PATH only while it is off PATH', () => {
  withMigrated((home) => {
    const manifest = join(home, '.config', BRAND.dir, 'harnesses.json');
    editJson(manifest, (m) => {
      m.harnesses.codex.plugins.push({ id: LEGACY_BRIDGE, action: 'added' });
      return m;
    });
    const line = `${manifest} records the id ${LEGACY_BRIDGE}`;
    const bin = join(home, 'codex-bin');
    put(join(bin, 'codex'), '#!/bin/sh\n', 0o755);
    const off = legacyScan(home, { env: { PATH: join(home, 'empty') } });
    assert.equal(off.fixes[line], `put codex on PATH, then run ${BRAND.cli} migrate`);
    const on = legacyScan(home, { env: { PATH: bin } });
    assert.equal(on.fixes[line], `run ${BRAND.cli} migrate`);
    // Not set up (config.json records it removed): migrate rewrites the records without codex, so no PATH hint.
    put(join(home, '.config', BRAND.dir, 'config.json'), json({ harnesses: { codex: { enabled: false } } }));
    assert.equal(legacyScan(home, { env: { PATH: join(home, 'empty') } }).fixes[line], `run ${BRAND.cli} migrate`);
  });
});

// Only an executable regular file named codex counts as codex on PATH: a directory and a file without the execute bit do not.
test('codex on PATH counts only an executable regular file', () => {
  withMigrated((home) => {
    const manifest = join(home, '.config', BRAND.dir, 'harnesses.json');
    editJson(manifest, (m) => {
      m.harnesses.codex.plugins.push({ id: LEGACY_BRIDGE, action: 'added' });
      return m;
    });
    const line = `${manifest} records the id ${LEGACY_BRIDGE}`;
    const dirNamedCodex = join(home, 'dir-bin');
    mkdirSync(join(dirNamedCodex, 'codex'), { recursive: true });
    const plain = join(home, 'plain-bin');
    put(join(plain, 'codex'), '#!/bin/sh\n', 0o644);
    const real = join(home, 'real-bin');
    put(join(real, 'codex'), '#!/bin/sh\n', 0o755);
    const fix = (...dirs) => legacyScan(home, { env: { PATH: dirs.join(delimiter) } }).fixes[line];
    assert.equal(fix(dirNamedCodex), `put codex on PATH, then run ${BRAND.cli} migrate`, 'a directory named codex');
    assert.equal(fix(plain), `put codex on PATH, then run ${BRAND.cli} migrate`, 'a file without the execute bit');
    assert.equal(fix(dirNamedCodex, plain, real), `run ${BRAND.cli} migrate`, 'an executable file later on PATH');
  });
});

test('isUnreadable and isGrokLeftover tell the scan\'s lines apart', () => {
  withMigrated((home) => {
    const manifest = join(home, '.config', BRAND.dir, 'harnesses.json');
    writeFileSync(manifest, 'not json');
    const grokRules = join(home, '.grok', 'rules', `${L.grokName}.md`);
    put(grokRules, '# old\n');
    const { failures, exempt } = legacyScan(home);
    assert.deepEqual(exempt.filter(isUnreadable), [`could not read ${manifest}`]);
    assert.deepEqual(failures.filter(isGrokLeftover), [`${grokRules} is a legacy-named Grok file`]);
  });
});

test('a real legacy dir: migrate moves it, unless the new dir is there too, where the fix is the merge by hand', () => {
  withMigrated((home) => {
    const state = join(home, '.local', 'state', L.dir);
    const stateNew = join(home, '.local', 'state', BRAND.dir);
    rmSync(state);
    mkdirSync(state);
    mkdirSync(stateNew, { recursive: true });
    const share = join(home, '.local', 'share', L.dir);
    const shareNew = join(home, '.local', 'share', BRAND.dir);
    rmSync(share);
    rmSync(shareNew, { recursive: true, force: true });
    mkdirSync(share);
    const { fixes } = legacyScan(home);
    assert.equal(fixes[`${state} is a real directory, not a link to ${stateNew}`],
      `merge ${state} by hand into ${stateNew}, remove ${state}, then run ${BRAND.cli} migrate again`);
    assert.equal(fixes[`${share} is a real directory, not a link to ${shareNew}`], `run ${BRAND.cli} migrate`);
  });
});

test('a legacy Grok file\'s fix is migrate, which removes it whether or not Grok is set up', () => {
  withMigrated((home) => {
    const grokHooks = join(home, '.grok', 'hooks', `${L.grokName}.json`);
    put(grokHooks, '{}\n');
    assert.equal(legacyScan(home).fixes[`${grokHooks} is a legacy-named Grok file`], `run ${BRAND.cli} migrate`);
  });
});

test('a fresh home with none of the files scans clean', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-scan-')));
  try {
    assert.deepEqual(legacyScan(home), { failures: [], exempt: [], fixes: {} });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(`a foreign ${L.cliFile} or ${L.launcher} on a fresh machine is not a failure`, () => {
  for (const name of [L.cliFile, L.launcher, L.cli]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-scan-')));
    try {
      put(join(home, '.local', 'bin', name), '#!/bin/sh\n# some other tool\nexec other "$@"\n', 0o755);
      assert.deepEqual(legacyScan(home), { failures: [], exempt: [], fixes: {} }, name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test(`on a legacy machine a foreign ${L.cliFile} or ${L.launcher} beside one of ours is still a failure, moved aside first`, () => {
  for (const [foreign, ours, ownsLine] of [[L.cliFile, L.launcher, `#!/bin/sh\n${BRAND.ownership.forwarder}\n`],
    [L.launcher, L.cliFile, `#!/usr/bin/env node\n${BRAND.ownership.alias}\n`]]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-scan-')));
    try {
      const bin = join(home, '.local', 'bin');
      put(join(bin, ours), ownsLine, 0o755);
      put(join(bin, foreign), '#!/bin/sh\n# some other tool\nexec other "$@"\n', 0o755);
      const { failures, fixes } = legacyScan(home);
      assert.equal(failures.length, 1, failures.join('\n'));
      assert.ok(has(failures, join(bin, foreign)), failures[0]);
      assert.ok(fixes[failures[0]].startsWith(`move ${join(bin, foreign)} aside`), fixes[failures[0]]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
