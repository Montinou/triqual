import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sync } from '../bin/sync.mjs';
import { MARKERS, readManagedSection, outsideManagedSection } from '../bin/lib/fsx.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GLOBAL = readFileSync(join(PLUGIN_ROOT, 'rules', 'global.md'), 'utf8');
const SUPERSEDED = 'superpowers@superpowers-marketplace';
const MACHINE = '# Global Instructions\n\n## Machine config\n\nVercel and gh routing live here.\n';

function withHome(fn, { claudeMd = MACHINE, settings = '{\n  "enabledPlugins": {}\n}\n' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cm-sync-'));
  try {
    mkdirSync(join(home, '.claude'));
    if (claudeMd !== null) writeFileSync(join(home, '.claude', 'CLAUDE.md'), claudeMd);
    if (settings !== null) writeFileSync(join(home, '.claude', 'settings.json'), settings);
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const step = (result, id) => result.steps.find((s) => s.id === id);
const readClaude = (home) => readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
const readSettings = (home) => readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

// A temp copy of the methodology plugin whose manifest supersedes the given ids.
function withPluginCopy(supersedes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-plugin-'));
  try {
    const root = join(dir, 'methodology');
    cpSync(PLUGIN_ROOT, root, { recursive: true });
    writeFileSync(join(root, 'rules', 'manifest.json'), JSON.stringify({ version: 1, supersedes }) + '\n');
    return fn(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sync refuses rules while legacy headings sit outside the managed section', () => {
  const legacy = `${MACHINE}\n### Never Assume - Always Verify\n\n- verify\n`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    const gate = step(r, 'rules-gate');
    assert.equal(gate.status, 'failed');
    assert.match(gate.detail, /### Never Assume - Always Verify/);
    assert.equal(step(r, 'rules').status, 'failed');
    assert.equal(readClaude(home), legacy);
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(home, '.claude', 'backups')), false);
  }, { claudeMd: legacy });
});

test('sync gate matches the legacy upper-case container heading exactly', () => {
  const legacy = `${MACHINE}\n## UNIVERSAL DEVELOPMENT RULES   \n`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules-gate').status, 'failed');
    assert.match(step(r, 'rules-gate').detail, /## UNIVERSAL DEVELOPMENT RULES/);
    assert.equal(readClaude(home), legacy);
    assert.equal(r.ok, false);
  }, { claudeMd: legacy });
});

test('sync gate ignores a legacy heading that is not a whole line', () => {
  const text = `${MACHINE}\nSee ### Never Assume - Always Verify in the rules.\n`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules-gate').status, 'done');
    assert.equal(step(r, 'rules').status, 'done');
    assert.equal(r.ok, true);
  }, { claudeMd: text });
});

test('sync writes the managed section and keeps the rest', () => {
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules-gate').status, 'done');
    assert.equal(step(r, 'rules').status, 'done');
    assert.equal(r.ok, true);
    const text = readClaude(home);
    assert.deepEqual(readManagedSection(text), { body: GLOBAL.trim(), error: null });
    assert.equal(outsideManagedSection(text).trimEnd(), MACHINE.trimEnd());
    assert.ok(text.startsWith(MACHINE));
  });
});

test('sync backs up CLAUDE.md before replacing it', () => {
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT, now: new Date(2026, 8, 27, 10, 11, 12) });
    assert.equal(step(r, 'rules').status, 'done');
    const backup = join(home, '.claude', 'backups', 'triqual-20260927-101112', 'CLAUDE.md');
    assert.equal(readFileSync(backup, 'utf8'), MACHINE);
  });
});

test('sync is idempotent', () => {
  withHome((home) => {
    const first = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(first.ok, true);
    const claudeAfter = readClaude(home);
    const settingsAfter = readSettings(home);
    const second = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(second, 'rules').status, 'already');
    assert.equal(second.ok, true);
    assert.equal(readClaude(home), claudeAfter);
    assert.equal(readSettings(home), settingsAfter);
  });
});

test('a synced file passes the legacy gate on a re-run despite the title-cased managed headings', () => {
  withHome((home) => {
    sync({ home, pluginRoot: PLUGIN_ROOT });
    const text = readClaude(home);
    assert.ok(text.split('\n').includes('## Universal Development Rules'));
    const again = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(again, 'rules-gate').status, 'done');
    assert.equal(step(again, 'rules').status, 'already');
    assert.equal(readClaude(home), text);
  });
});

test('sync creates a missing CLAUDE.md holding only the managed section', () => {
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules').status, 'done');
    assert.match(step(r, 'rules').detail, /created/);
    assert.equal(readClaude(home), `${MARKERS.start}\n${GLOBAL.trim()}\n${MARKERS.end}\n`);
  }, { claudeMd: null });
});

// Review Focus 3: a CLAUDE.md synced before the rename holds global.md inside the legacy markers. Its headings must
// count as inside the managed section, and the section is rewritten in place under the new markers.
test('sync on a CLAUDE.md whose legacy section holds the real global.md passes the rules gate and leaves one new section', () => {
  const L = BRAND.legacy.markers;
  const before = `${MACHINE}\n`;
  const after = '\n## Local notes\n\nkeep me\n';
  const legacy = `${before}${L.start}\n${GLOBAL.trim()}\n${L.end}${after}`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules-gate').status, 'done', step(r, 'rules-gate').detail);
    assert.equal(step(r, 'rules').status, 'done', step(r, 'rules').detail);
    assert.match(step(r, 'rules').detail, /replaced/);
    assert.equal(r.ok, true);
    const text = readClaude(home);
    assert.equal(text.split(BRAND.markers.start).length - 1, 1);
    assert.equal(text.split(BRAND.markers.end).length - 1, 1);
    assert.ok(!text.includes(L.start) && !text.includes(L.end));
    assert.equal(text, `${before}${BRAND.markers.start}\n${GLOBAL.trim()}\n${BRAND.markers.end}${after}`);
    assert.equal(step(sync({ home, pluginRoot: PLUGIN_ROOT }), 'rules').status, 'already');
  }, { claudeMd: legacy });
});

test('sync disables superseded plugins', () => {
  const settings = JSON.stringify({ model: 'x', enabledPlugins: { [SUPERSEDED]: true, 'other@m': true } }, null, 2) + '\n';
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const r = sync({ home, pluginRoot });
      const s = step(r, 'supersedes');
      assert.equal(s.status, 'done');
      assert.match(s.detail, new RegExp(SUPERSEDED));
      const obj = JSON.parse(readSettings(home));
      assert.equal(obj.enabledPlugins[SUPERSEDED], false);
      assert.equal(obj.enabledPlugins['other@m'], true);
      assert.equal(obj.model, 'x');
      const after = readSettings(home);
      const again = sync({ home, pluginRoot });
      assert.equal(step(again, 'supersedes').status, 'already');
      assert.equal(readSettings(home), after);
    }, { settings });
  });
});

test('sync reports already for supersedes when the manifest lists nothing', () => {
  const settings = JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }, null, 2) + '\n';
  withPluginCopy([], (pluginRoot) => {
    withHome((home) => {
      const r = sync({ home, pluginRoot });
      assert.equal(step(r, 'supersedes').status, 'already');
      assert.equal(readSettings(home), settings);
    }, { settings });
  });
});

// <home>/.config/triqual/config.json with the given object.
function writeConfig(home, config) {
  const dir = join(home, '.config', 'triqual');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

const OTHER_MARKET = 'superpowers@claude-plugins-official';

test('sync disables every enabled superpowers@* at user scope and backs up settings.json', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(PLUGIN_ROOT, 'rules', 'manifest.json'), 'utf8')).supersedes, ['superpowers@*']);
  const settings = JSON.stringify({
    model: 'x',
    enabledPlugins: { [SUPERSEDED]: true, [OTHER_MARKET]: true, 'superpowers-lab@m': true, 'other@m': true },
  }, null, 2) + '\n';
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT, now: new Date(2026, 8, 28, 9, 8, 7) });
    const s = step(r, 'supersedes');
    assert.equal(s.status, 'done');
    assert.equal(s.detail, `disabled ${SUPERSEDED}, ${OTHER_MARKET}`);
    const obj = JSON.parse(readSettings(home));
    assert.equal(obj.enabledPlugins[SUPERSEDED], false);
    assert.equal(obj.enabledPlugins[OTHER_MARKET], false);
    assert.equal(obj.enabledPlugins['superpowers-lab@m'], true);
    assert.equal(obj.enabledPlugins['other@m'], true);
    assert.equal(obj.model, 'x');
    const backup = join(home, '.claude', 'backups', 'triqual-20260928-090807', 'settings.json');
    assert.equal(readFileSync(backup, 'utf8'), settings);
    const after = readSettings(home);
    const again = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(again, 'supersedes').status, 'already');
    assert.equal(readSettings(home), after);
  }, { settings });
});

test('sync leaves superseded plugins enabled when keepSuperseded is true', () => {
  const settings = JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true, [OTHER_MARKET]: true } }, null, 2) + '\n';
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    const s = step(r, 'supersedes');
    assert.equal(s.status, 'already');
    assert.match(s.detail, /keepSuperseded/);
    assert.equal(r.ok, true);
    assert.equal(readSettings(home), settings);
    const backups = join(home, '.claude', 'backups');
    const saved = existsSync(backups) ? readdirSync(backups).flatMap((d) => readdirSync(join(backups, d))) : [];
    assert.equal(saved.includes('settings.json'), false, 'settings.json was backed up, so it was about to be edited');
    // keepSuperseded false (or absent) disables again.
    writeConfig(home, { keepSuperseded: false });
    assert.equal(step(sync({ home, pluginRoot: PLUGIN_ROOT }), 'supersedes').status, 'done');
  }, { settings });
});

test('sync does not create a missing settings.json to disable nothing', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const r = sync({ home, pluginRoot });
      assert.equal(step(r, 'supersedes').status, 'already');
      assert.equal(r.ok, true);
      assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
    }, { settings: null });
  });
});

test('sync reports invalid settings.json as a failed supersedes step without writing', () => {
  const bad = '{ "enabledPlugins": { ,, }\n';
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const r = sync({ home, pluginRoot });
      const s = step(r, 'supersedes');
      assert.equal(s.status, 'failed');
      assert.match(s.detail, /not valid JSON/);
      assert.equal(r.ok, false);
      assert.equal(readSettings(home), bad);
    }, { settings: bad });
  });
});

test('sync reports a corrupted managed section', () => {
  const corrupted = `${MACHINE}\n${MARKERS.start}\nold rules\n`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    const rules = step(r, 'rules');
    assert.equal(rules.status, 'failed');
    assert.match(rules.detail, /unterminated/);
    assert.equal(step(r, 'rules-gate').status, 'failed');
    assert.equal(r.ok, false);
    assert.equal(readClaude(home), corrupted);
  }, { claudeMd: corrupted });
});

test('sync leaves a CLAUDE.md holding both the legacy and the new marker pairs unwritten: duplicate', () => {
  const L = BRAND.legacy.markers;
  const both = `${MACHINE}\n${L.start}\n${GLOBAL.trim()}\n${L.end}\n\n${MARKERS.start}\n${GLOBAL.trim()}\n${MARKERS.end}\n`;
  withHome((home) => {
    const r = sync({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(step(r, 'rules').status, 'failed');
    assert.match(step(r, 'rules-gate').detail, /duplicate/);
    assert.match(step(r, 'rules').detail, /duplicate/);
    assert.equal(r.ok, false);
    assert.equal(readClaude(home), both);
  }, { claudeMd: both });
});

test('triqual sync prints one line per step and exits 0 when ok, 1 otherwise', () => {
  const cli = join(PLUGIN_ROOT, 'bin', 'sync.mjs');
  withHome((home) => {
    const ok = spawnSync(process.execPath, [cli], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const lines = ok.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.split(':')[0]), ['rules-gate', 'rules', 'supersedes']);
    assert.match(lines[1], /^rules: done — /);
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), `${MARKERS.start}\nx\n`);
    const bad = spawnSync(process.execPath, [cli], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^rules: failed — .*unterminated/m);
  });
});

// A temp HOME only, never XDG_CONFIG_HOME: the CLI must not reach the real config.
const syncCli = (home, args) => {
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  return spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'sync.mjs'), ...args], { env, encoding: 'utf8' });
};
// Every path under the dir with its bytes, so a test sees any write, backup or new file.
const tree = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).sort()
  .map((rel) => [rel, statSync(join(dir, rel)).isFile() ? readFileSync(join(dir, rel)) : null]));

test('triqual sync --help and -h print the usage, exit 0 and write nothing', () => {
  withHome((home) => {
    const before = readFileSync(join(home, '.claude', 'CLAUDE.md'));
    const snapshot = tree(home);
    for (const args of [['--help'], ['-h']]) {
      const r = syncCli(home, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.equal(r.stdout.split('\n')[0], 'usage: triqual sync', args.join(' '));
      assert.doesNotMatch(r.stdout, /^rules(-gate)?: /m, args.join(' '));
      assert.ok(readFileSync(join(home, '.claude', 'CLAUDE.md')).equals(before), `${args.join(' ')}: CLAUDE.md bytes changed`);
      assert.deepEqual(tree(home), snapshot, args.join(' '));
    }
  });
});

test('triqual sync rejects any other argument with the usage on stderr, exit 2 and nothing written', () => {
  withHome((home) => {
    const snapshot = tree(home);
    for (const args of [['--bogus'], ['now'], ['--dry-run']]) {
      const r = syncCli(home, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, new RegExp(`^triqual sync: unknown argument ${args[0]}\\n`), args.join(' '));
      assert.match(r.stderr, /^usage: triqual sync$/m, args.join(' '));
      assert.deepEqual(tree(home), snapshot, args.join(' '));
    }
  });
});

test('sync fails the supersedes step and disables nothing while config.json exists but cannot be parsed', () => {
  const settings = JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }, null, 2) + '\n';
  for (const config of ['{ "keepSuperseded": true,, }', '[true]']) {
    withHome((home) => {
      writeConfig(home, {});
      writeFileSync(join(home, '.config', 'triqual', 'config.json'), config);
      const r = sync({ home, pluginRoot: PLUGIN_ROOT });
      assert.deepEqual(step(r, 'supersedes'),
        { id: 'supersedes', status: 'failed', detail: 'config.json unreadable — fix it or remove it' });
      assert.equal(r.ok, false);
      assert.equal(readSettings(home), settings);
    }, { settings });
  }
  withHome((home) => {
    mkdirSync(join(home, '.config', 'triqual', 'config.json'), { recursive: true }); // EISDIR
    assert.equal(step(sync({ home, pluginRoot: PLUGIN_ROOT }), 'supersedes').status, 'failed');
    assert.equal(readSettings(home), settings);
  }, { settings });
});

test('sync tolerates non-string manifest entries', () => {
  const settings = JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }, null, 2) + '\n';
  withPluginCopy([null, 3, 'superpowers@*'], (pluginRoot) => {
    withHome((home) => {
      const s = step(sync({ home, pluginRoot }), 'supersedes');
      assert.deepEqual(s, { id: 'supersedes', status: 'done', detail: `disabled ${SUPERSEDED}` });
    }, { settings });
  });
});

test('triqual sync --harness bogus exits 2 and writes nothing', () => {
  withHome((home) => {
    const snapshot = tree(home);
    for (const [args, message] of [
      [['--harness', 'bogus'], 'unknown harness bogus'],
      [['--harness'], '--harness needs a harness id'],
      [['--harness', '--yes'], '--harness needs a harness id'],
      [['--yes', '--harness', 'codex', '--bogus'], 'unknown argument --bogus'],
      [['--remove-harness', 'bogus'], 'unknown harness bogus'],
      [['--remove-harness'], '--remove-harness needs a harness id'],
      [['--restore-agents-md'], '--restore-agents-md is only valid with --remove-harness'],
      [['--harness', 'codex', '--restore-agents-md'], '--restore-agents-md is only valid with --remove-harness'],
      [['--remove-harness', 'grok', '--restore-agents-md'], '--restore-agents-md is only valid with --remove-harness codex'],
      [['--remove-harness', 'codex', '--harness', 'grok'], '--remove-harness cannot be combined with --harness'],
      [['--harness', 'codex', '--remove-harness', 'codex'], '--remove-harness cannot be combined with --harness'],
      [['--remove-harness', 'codex', '--remove-harness', 'grok'], '--remove-harness takes one harness'],
    ]) {
      const r = syncCli(home, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stdout, '', args.join(' '));
      assert.equal(r.stderr.split('\n')[0], `triqual sync: ${message}`, args.join(' '));
      assert.match(r.stderr, /^usage: triqual sync$/m, args.join(' '));
      assert.deepEqual(tree(home), snapshot, args.join(' '));
    }
  });
});
