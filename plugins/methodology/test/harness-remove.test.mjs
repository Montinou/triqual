import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, removeHarness, splitAgentsMd, syncHarness, writeManifest } from '../bin/lib/harness-sync.mjs';
import { syncCli } from '../bin/sync.mjs';
import { backupDirFor, MARKERS } from '../bin/lib/fsx.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const SYNC = join(PLUGIN_ROOT, 'bin', 'sync.mjs');
const ROLES_AGENTS = join(PLUGIN_ROOT, '..', 'roles', 'agents');
const CONFIG_FIXTURE = readFileSync(join(TEST_DIR, 'fixtures', 'legacy', 'codex-config.toml'), 'utf8');
const SPLIT_FIXTURE = readFileSync(join(TEST_DIR, 'fixtures', 'codex-agents-layout.md'), 'utf8');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const LISTS = {
  legacy: readJson(join(PLUGIN_ROOT, 'rules', 'legacy-headings.json')),
  legacyChildren: readJson(join(PLUGIN_ROOT, 'rules', 'harness', 'codex-legacy-children.json')),
};
const MARKET = BRAND.legacy.marketplace;
const pid = (name) => `${name}@${MARKET}`;
// The bridge of CONFIG_FIXTURE, whose config.toml holds the legacy bridge's table.
const BRIDGE = `methodology-codex@${MARKET}`;
const NEW_BRIDGE = `methodology-codex@${BRAND.marketplace}`;
const NOW = new Date(2026, 8, 29, 10, 0, 0);
const LATER = new Date(2026, 8, 29, 11, 0, 0);
const SPLIT_PROMPT = 'Split ~/.codex/AGENTS.md as shown?';

const METHODOLOGY_SKILLS = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
// The 14 skills of the removed superpowers 6.0.3 cache.
const SUPERPOWERS_SKILLS = [
  'brainstorming', 'dispatching-parallel-agents', 'executing-plans', 'finishing-a-development-branch',
  'receiving-code-review', 'requesting-code-review', 'subagent-driven-development', 'systematic-debugging',
  'test-driven-development', 'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills',
];
const HAND_WRITTEN = '# hand-written role\nname = "tdd-implementer"\ndescription = "mine"\n';
const MACHINE_FILES = {
  'spark-worker.toml': 'name = "spark-worker"\ndescription = "Spark"\n',
  'terra-planner.toml': 'name = "terra-planner"\ndescription = "Terra"\n',
};
const CODEX_AGENTS_MD = '# Codex machine config\n\n## Spark subagent routing\n\nRoute small edits to spark-worker.\n';
const GROK_STALE = [
  ['methodology', '0.1.2'], ['progress-tracking', '0.2.1'], ['workflow-gate', '0.1.0'], ['roles', '0.1.0'],
  ['superpowers', '6.3.0'],
];
const CODEX_REMOVE_STEPS = ['codex-skills', 'codex-agents', 'codex-rules', 'codex-config', 'codex-plugin', 'codex-manifest'];
const GROK_REMOVE_STEPS = ['grok-rules', 'grok-plugins', 'grok-hooks', 'grok-manifest'];

const write = (path, text, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const cacheDir = (home, name, version) => join(home, '.claude', 'plugins', 'cache', MARKET, name, version);
const superpowersTarget = (home, name) => join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace',
  'superpowers', '6.0.3', 'skills', name);
const skillsDir = (home) => join(home, '.codex', 'skills');
const codexConfig = (home) => join(home, '.codex', 'config.toml');
const agentsMdPath = (home) => join(home, '.codex', 'AGENTS.md');
const configJson = (home) => join(home, '.config', 'triqual', 'config.json');
const stepOf = (steps, id) => steps.find((s) => s.id === id);
const failedOf = (steps) => steps.filter((s) => s.status === 'failed');

function grokEntry(home, name, version) {
  const repoKey = `${name}-1a2b3c4d`;
  return {
    status: 'installed', name, repo_key: repoKey, version, path: join(home, '.grok', 'installed-plugins', repoKey),
    source: join(home, '.grok', 'marketplace-cache', 'e5f6', 'plugins', name), marketplace: MARKET,
  };
}

// A temp home laid out like the real one (as in harness-sync.test.mjs): user-scope installs, 14 dangling superpowers
// links and a link we never made, machine agents plus a hand-written tdd-implementer.toml, the synthetic config.toml,
// ~/.codex/AGENTS.md = agentsMd, and Grok's stale plugins, each also present at its marketplace-cache source.
function makeHome({ agentsMd = CODEX_AGENTS_MD } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cm-hremove-'));
  const methodology = cacheDir(home, 'methodology', '0.3.0');
  cpSync(join(PLUGIN_ROOT, 'rules'), join(methodology, 'rules'), { recursive: true });
  for (const name of METHODOLOGY_SKILLS) write(join(methodology, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  const pt = cacheDir(home, 'progress-tracking', '0.2.3');
  write(join(pt, 'skills', 'progress-tracking', 'SKILL.md'), '---\nname: progress-tracking\n---\n');
  const roles = cacheDir(home, 'roles', '0.1.0');
  cpSync(ROLES_AGENTS, join(roles, 'agents'), { recursive: true });
  const plugins = {
    [pid('methodology')]: [{ scope: 'user', installPath: methodology, version: '0.3.0' }],
    [pid('progress-tracking')]: [{ scope: 'user', installPath: pt, version: '0.2.3' }],
    [pid('roles')]: [{ scope: 'user', installPath: roles, version: '0.1.0' }],
  };
  write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  write(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { [pid('methodology')]: true, [pid('progress-tracking')]: true, [pid('roles')]: true },
  }));
  mkdirSync(join(home, '.claude', 'plugins', 'marketplaces', MARKET), { recursive: true });
  // Claude Code knows the marketplace of that clone, so the plugin ids resolve under it (lib/brand.mjs).
  write(join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ [MARKET]: { installLocation: join(home, '.claude', 'plugins', 'marketplaces', MARKET) } }));
  const vercel = join(home, '.claude', 'plugins', 'marketplaces', 'vercel', 'skills', 'ai-sdk');
  write(join(vercel, 'SKILL.md'), 'vercel');
  mkdirSync(skillsDir(home), { recursive: true });
  for (const name of SUPERPOWERS_SKILLS) symlinkSync(superpowersTarget(home, name), join(skillsDir(home), name));
  symlinkSync(vercel, join(skillsDir(home), 'ai-sdk'));
  for (const [file, text] of Object.entries(MACHINE_FILES)) write(join(home, '.codex', 'agents', file), text);
  write(join(home, '.codex', 'agents', 'tdd-implementer.toml'), HAND_WRITTEN);
  write(codexConfig(home), CONFIG_FIXTURE, 0o600);
  write(agentsMdPath(home), agentsMd);
  for (const [name, version] of GROK_STALE) {
    const e = grokEntry(home, name, version);
    for (const dir of [e.path, e.source]) {
      write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
      write(join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
    }
  }
  return home;
}

async function withHome(opts, fn) {
  const home = makeHome(opts);
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// A fake `run` for codex and grok that records each call and keeps the state the real CLIs would. `grok plugin install
// <source> --trust` copies the source back under ~/.grok/installed-plugins and lists it with marketplace null.
function fakeRun(home) {
  const calls = [];
  const state = {
    marketplaces: ['openai-curated'], bridge: false,
    grok: GROK_STALE.map(([n, v]) => grokEntry(home, n, v)),
  };
  const superpowersOn = () => {
    let text = '';
    try { text = readFileSync(codexConfig(home), 'utf8'); } catch { /* no config */ }
    return !/^\[plugins\."superpowers@openai-curated-remote"\]\nenabled = false$/m.test(text);
  };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const run = async (cmd, args) => {
    const rest = args.join(' ');
    calls.push(`${cmd} ${rest}`);
    if (rest === '--version') return { code: 1, stdout: '', stderr: '' };
    if (cmd === 'codex') {
      if (rest === 'plugin list --json') {
        return ok(JSON.stringify({
          installed: [
            { pluginId: 'superpowers@openai-curated-remote', name: 'superpowers', version: '6.4.2', installed: true, enabled: superpowersOn() },
            ...(state.bridge ? [{ pluginId: state.bridge, name: 'methodology-codex', version: '0.2.0', installed: true, enabled: true }] : []),
          ],
        }));
      }
      if (rest === 'plugin marketplace list --json') {
        return ok(JSON.stringify({ marketplaces: state.marketplaces.map((name) => ({ name })) }));
      }
      if (rest.startsWith('plugin marketplace add ')) { state.marketplaces.push(basename(args[3])); return ok(); }
      if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove' && args.length === 4) {
        state.marketplaces = state.marketplaces.filter((m) => m !== args[3]);
        return ok();
      }
      if (rest === `plugin add ${BRIDGE}` || rest === `plugin add ${NEW_BRIDGE}`) { state.bridge = args[2]; return ok(); }
      if (args[0] === 'plugin' && args[1] === 'remove' && args.length === 3) {
        if (state.bridge === args[2]) state.bridge = false;
        return ok();
      }
      if (rest === 'features list') return ok('hooks                                    stable             true\n');
    }
    if (cmd === 'grok') {
      if (rest === 'plugin list --json') return ok(JSON.stringify(state.grok));
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        const entry = state.grok.find((p) => p.name === args[2]);
        state.grok = state.grok.filter((p) => p.name !== args[2]);
        if (entry) rmSync(entry.path, { recursive: true, force: true });
        return ok(`Uninstalled 1 plugin(s): ${args[2]}\n`);
      }
      if (args[0] === 'plugin' && args[1] === 'install' && args[3] === '--trust' && args.length === 4) {
        const [name, version] = GROK_STALE.find(([n]) => grokEntry(home, n, '').source === args[2]) ?? [];
        if (!name) return { code: 1, stdout: '', stderr: `no plugin at ${args[2]}` };
        const entry = { ...grokEntry(home, name, version), marketplace: null };
        cpSync(args[2], entry.path, { recursive: true });
        state.grok.push(entry);
        return ok('Installed 1 plugin(s)\n');
      }
    }
    return { code: 1, stdout: '', stderr: `fake: unexpected ${cmd} ${rest}` };
  };
  return { run, calls, state };
}

// Every path under ~/.codex and ~/.grok: a file as its sha256, a link as its target, a directory as 'dir'.
function snapshot(home) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out[p] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) { out[p] = 'dir'; walk(p); } else out[p] = sha256(readFileSync(p));
    }
  };
  for (const dir of [join(home, '.codex'), join(home, '.grok')]) if (existsSync(dir)) walk(dir);
  return out;
}

const yesConfirm = (asked = []) => async (q) => { asked.push(q); return true; };
const reinstallCommand = (home, name) => `grok plugin install ${grokEntry(home, name, '').source} --trust`;

// ---- removeHarness ----

test('sync then remove restores the tree', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    const before = snapshot(home);
    const config = readFileSync(codexConfig(home));
    assert.deepEqual(failedOf((await syncHarness({ home, id: 'codex', run: r.run, now: NOW })).steps), []);
    assert.deepEqual(failedOf((await syncHarness({ home, id: 'grok', run: r.run, now: NOW })).steps), []);
    assert.notDeepEqual(snapshot(home), before, 'sync changed the tree');

    const codex = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    assert.deepEqual(codex.steps.map((s) => s.id), CODEX_REMOVE_STEPS);
    assert.deepEqual(codex.steps.filter((s) => s.status !== 'done'), [], JSON.stringify(codex.steps, null, 1));
    const grok = await removeHarness({ home, id: 'grok', run: r.run, now: LATER, isTTY: true, confirm: yesConfirm() });
    assert.deepEqual(grok.steps.map((s) => s.id), GROK_REMOVE_STEPS);
    assert.deepEqual(grok.steps.filter((s) => s.status !== 'done'), [], JSON.stringify(grok.steps, null, 1));
    for (const s of [...codex.steps, ...grok.steps]) assert.ok(s.detail.length > 0, s.id);

    assert.deepEqual(snapshot(home), before);
    const after = readFileSync(codexConfig(home));
    assert.ok(after.equals(config), 'config.toml byte-equal');
    assert.doesNotMatch(after.toString('utf8'), /^\[plugins\."superpowers@/m, 'no empty header left');
    const i = r.calls.indexOf(`codex plugin remove ${BRIDGE}`);
    assert.ok(i !== -1 && i < r.calls.indexOf(`codex plugin marketplace remove ${MARKET}`), r.calls.join('\n'));
    assert.deepEqual(readManifest(home).harnesses, {}, 'both manifest entries deleted');
  });
  // A superseded plugin table the user already had (`enabled = true`): sync records was 'true' and removal sets it
  // back through setTableKey, byte-equal since the line already reads `key = value`.
  await withHome({}, async (home) => {
    write(codexConfig(home), `${CONFIG_FIXTURE}\n[plugins."superpowers@openai-curated-remote"]\nenabled = true\n`, 0o600);
    const r = fakeRun(home);
    const config = readFileSync(codexConfig(home));
    assert.deepEqual(failedOf((await syncHarness({ home, id: 'codex', run: r.run, now: NOW })).steps), []);
    const rec = readManifest(home).harnesses.codex.config
      .find((c) => c.table === 'plugins."superpowers@openai-curated-remote"');
    assert.deepEqual([rec.was, rec.createdTable], ['true', false], JSON.stringify(rec));
    const codex = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    assert.deepEqual(codex.steps.filter((s) => s.status !== 'done'), [], JSON.stringify(codex.steps, null, 1));
    assert.ok(readFileSync(codexConfig(home)).equals(config), 'config.toml byte-equal');
  });
  // A split AGENTS.md: the post-split text with the managed section removed, the rest of the tree as it was.
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = fakeRun(home);
    const before = snapshot(home);
    const { steps } = await syncHarness({ home, id: 'codex', run: r.run, now: NOW, isTTY: true, confirm: yesConfirm() });
    assert.equal(stepOf(steps, 'codex-rules-gate').status, 'done', JSON.stringify(steps));
    assert.ok(readFileSync(agentsMdPath(home), 'utf8').includes(MARKERS.start));
    const removed = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    assert.deepEqual(failedOf(removed.steps), []);
    assert.equal(readFileSync(agentsMdPath(home), 'utf8'), splitAgentsMd(SPLIT_FIXTURE, LISTS).text);
    const now = snapshot(home);
    delete before[agentsMdPath(home)];
    delete now[agentsMdPath(home)];
    assert.deepEqual(now, before);
  });
});

test('remove takes out a managed section a pre-rename sync wrote under the legacy markers', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  assert.deepEqual(failedOf((await syncHarness({ home, id: 'codex', run: r.run, now: NOW })).steps), []);
  const synced = readFileSync(agentsMdPath(home), 'utf8');
  const L = BRAND.legacy.markers;
  const legacy = synced.replace(BRAND.markers.start, L.start).replace(BRAND.markers.end, L.end);
  assert.ok(legacy.includes(L.start) && legacy.includes(L.end));
  writeFileSync(agentsMdPath(home), legacy);
  const removed = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
  assert.equal(stepOf(removed.steps, 'codex-rules').status, 'done', JSON.stringify(removed.steps, null, 1));
  assert.equal(readFileSync(agentsMdPath(home), 'utf8'), CODEX_AGENTS_MD);
}));

test('--restore-agents-md restores the pre-split file', async () => {
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW, isTTY: true, confirm: yesConfirm() });
    const { steps } = await removeHarness({ home, id: 'codex', run: r.run, now: LATER, restoreAgentsMd: true });
    assert.equal(stepOf(steps, 'codex-rules').status, 'done', JSON.stringify(steps));
    assert.equal(readFileSync(agentsMdPath(home), 'utf8'), SPLIT_FIXTURE);
  });
  // The default names the backup and the flag in its detail.
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW, isTTY: true, confirm: yesConfirm() });
    const backup = readManifest(home).harnesses.codex.rules.backup;
    assert.equal(backup, join(backupDirFor(home, NOW), 'codex', 'AGENTS.md'));
    const { steps } = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    const rules = stepOf(steps, 'codex-rules');
    assert.equal(rules.status, 'done');
    assert.ok(rules.detail.includes(backup), rules.detail);
    assert.ok(rules.detail.includes('--restore-agents-md'), rules.detail);
    // It names no command that would then report nothing to do: this run drops the record (and the entry), so the
    // flag only works on the removal run itself, and the backup is copied back by hand.
    assert.ok(rules.detail.includes(`copy it to ${agentsMdPath(home)} by hand`), rules.detail);
    assert.ok(rules.detail.includes('--restore-agents-md only works on the removal run itself'), rules.detail);
    assert.doesNotMatch(rules.detail, /triqual sync/, rules.detail);
    assert.equal(readManifest(home).harnesses.codex, undefined, 'the entry is gone');
    const late = await syncCli(['--remove-harness', 'codex', '--restore-agents-md'], {
      home, pluginRoot: PLUGIN_ROOT, run: r.run, now: new Date(2026, 8, 29, 12, 0, 0),
    });
    assert.match(late.stdout, /^codex: already/, 'a later --restore-agents-md has nothing to act on');
    assert.equal(readFileSync(backup, 'utf8'), SPLIT_FIXTURE, 'the named backup is the pre-split file');
  });
  // Through the CLI flag.
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW, isTTY: true, confirm: yesConfirm() });
    const out = await syncCli(['--remove-harness', 'codex', '--restore-agents-md'], {
      home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER,
    });
    assert.equal(out.code, 0, out.stdout);
    assert.equal(readFileSync(agentsMdPath(home), 'utf8'), SPLIT_FIXTURE);
  });
});

test('remove reinstalls what sync uninstalled, after confirmation', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'grok', run: r.run, now: NOW });
    const recorded = readManifest(home).harnesses.grok.plugins;
    assert.equal(recorded.length, GROK_STALE.length);
    const asked = [];
    const events = [];
    const { steps } = await removeHarness({
      home, id: 'grok', run: r.run, now: LATER, isTTY: true,
      confirm: async (q) => { asked.push(q); events.push('confirm'); return true; },
      log: () => events.push('log'),
    });
    const s = stepOf(steps, 'grok-plugins');
    assert.equal(s.status, 'done', s.detail);
    assert.match(s.detail, /marketplace: null/);
    const installs = r.calls.filter((c) => c.startsWith('grok plugin install'));
    assert.deepEqual(installs, recorded.map((p) => `grok plugin install ${p.source} --trust`));
    assert.equal(asked.length, recorded.length, 'one confirmation per plugin');
    for (const [k, p] of recorded.entries()) assert.ok(asked[k].includes(`grok plugin install ${p.source} --trust`), asked[k]);
    assert.equal(events[0], 'log', 'the commands are printed before the first question');
    assert.deepEqual(readManifest(home).harnesses, {});
  });
  for (const [name, opts, words] of [
    ['confirm no', { isTTY: true, answer: false }, /declined/],
    ['--yes', { isTTY: true, yes: true, answer: true }, /^reinstall needs a human/],
    ['non-TTY', { isTTY: false, answer: true }, /^reinstall needs a human/],
  ]) {
    await withHome({}, async (home) => {
      const r = fakeRun(home);
      await syncHarness({ home, id: 'grok', run: r.run, now: NOW });
      const recorded = readManifest(home).harnesses.grok.plugins;
      const asked = [];
      const { steps } = await removeHarness({
        home, id: 'grok', run: r.run, now: LATER, isTTY: opts.isTTY, yes: opts.yes ?? false,
        confirm: async (q) => { asked.push(q); return opts.answer; },
      });
      const s = stepOf(steps, 'grok-plugins');
      assert.equal(s.status, 'skipped', `${name}: ${s.detail}`);
      assert.match(s.detail, words, name);
      assert.equal(r.calls.some((c) => c.startsWith('grok plugin install')), false, name);
      if (name !== 'confirm no') assert.deepEqual(asked, [], `${name}: never asked`);
      for (const p of recorded) {
        assert.ok(s.detail.includes(reinstallCommand(home, p.name)), `${name}: ${p.name} command`);
        assert.ok(s.detail.includes(p.backup), `${name}: ${p.name} backup`);
      }
      assert.match(s.detail, /marketplace: null/, name);
      // The records stay, so a run on a terminal can still reinstall; the rest of the entry is gone.
      assert.deepEqual(readManifest(home).harnesses.grok.plugins, recorded, name);
      assert.equal(stepOf(steps, 'grok-manifest').status, 'skipped', name);
      assert.equal(existsSync(join(home, '.grok', 'hooks', `${BRAND.grokName}.json`)), false, name);
    });
  }
});

test('remove with no manifest entry → one step already', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    const before = snapshot(home);
    for (const id of ['codex', 'grok']) {
      const { steps } = await removeHarness({ home, id, run: r.run, now: LATER });
      assert.equal(steps.length, 1, id);
      assert.equal(steps[0].id, id);
      assert.equal(steps[0].status, 'already');
      assert.ok(steps[0].detail.length > 0);
    }
    assert.deepEqual(r.calls, []);
    assert.deepEqual(snapshot(home), before);
    // Another harness's entry is not this one's.
    writeManifest(home, { version: 1, harnesses: { grok: { links: [], files: [], rolesSha: null, rules: null, config: [], plugins: [] } } });
    assert.equal((await removeHarness({ home, id: 'codex', run: r.run, now: LATER })).steps[0].status, 'already');
    await assert.rejects(removeHarness({ home, id: 'bogus', run: r.run, now: LATER }), /unknown harness/);
  });
});

test('a link changed by the user after sync is left alone and reported', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW });
    const mine = join(home, 'my-skills', 'brainstorming');
    write(join(mine, 'SKILL.md'), 'mine');
    const link = join(skillsDir(home), 'brainstorming');
    rmSync(link);
    symlinkSync(mine, link);
    const { steps } = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    const s = stepOf(steps, 'codex-skills');
    assert.equal(s.status, 'done', s.detail);
    assert.match(s.detail, /left alone[^;]*brainstorming/);
    assert.equal(readlinkSync(link), mine);
    assert.equal(readlinkSync(join(skillsDir(home), 'writing-plans')), superpowersTarget(home, 'writing-plans'));
    assert.equal(existsSync(join(skillsDir(home), 'progress-tracking')), false);
  });
});

test('links the user already put back are reported already restored', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW });
    const links = readManifest(home).harnesses.codex.links;
    assert.ok(links.some((l) => l.replaced), 'some recorded link replaced one of the user');
    for (const rec of links) {
      rmSync(rec.path, { force: true });
      if (rec.replaced) symlinkSync(rec.replaced, rec.path);
    }
    const s = stepOf((await removeHarness({ home, id: 'codex', run: r.run, now: LATER })).steps, 'codex-skills');
    assert.deepEqual([s.status, s.detail], ['already', 'already restored']);
  });
});

test('an agent file or a Grok file changed by the user after sync is left alone and reported', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW });
    await syncHarness({ home, id: 'grok', run: r.run, now: NOW });
    const agent = join(home, '.codex', 'agents', 'brief-writer.toml');
    const hooks = join(home, '.grok', 'hooks', `${BRAND.grokName}.json`);
    writeFileSync(agent, 'mine\n');
    writeFileSync(hooks, '{"mine":true}\n');
    const codex = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    assert.match(stepOf(codex.steps, 'codex-agents').detail, /left alone[^;]*brief-writer\.toml/);
    assert.equal(readFileSync(agent, 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(home, '.codex', 'agents', 'tdd-implementer.toml'), 'utf8'), HAND_WRITTEN);
    const grok = await removeHarness({ home, id: 'grok', run: r.run, now: LATER, isTTY: true, confirm: yesConfirm() });
    const s = stepOf(grok.steps, 'grok-hooks');
    assert.equal(s.status, 'skipped', s.detail);
    assert.match(s.detail, /left alone/);
    assert.equal(readFileSync(hooks, 'utf8'), '{"mine":true}\n');
    assert.equal(existsSync(join(home, '.grok', 'rules', `${BRAND.grokName}.md`)), false, 'the unchanged rules file is removed');
  });
});

const emptyEntry = (over) => ({ links: [], files: [], rolesSha: null, rules: null, config: [], plugins: [], ...over });

test('remove-harness matches ids recorded under the legacy marketplace', async () => {
  await withHome({}, async (home) => {
    // A migrated machine: config.toml now holds the triqual bridge, and the entry records both bridges and both
    // Codex marketplaces, the legacy ones from a sync before the rename.
    write(codexConfig(home), CONFIG_FIXTURE.replace(`[plugins."${BRIDGE}"]`, `[plugins."${NEW_BRIDGE}"]`), 0o600);
    const plugins = [
      { id: MARKET, action: 'marketplace-added' }, { id: BRIDGE, action: 'added' },
      { id: BRAND.marketplace, action: 'marketplace-added' }, { id: NEW_BRIDGE, action: 'added' },
      { id: 'hooks', action: 'feature-enabled' },
    ];
    writeManifest(home, { version: 1, harnesses: { codex: emptyEntry({ plugins }) } });
    const r = fakeRun(home);
    const { steps } = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    const s = stepOf(steps, 'codex-plugin');
    assert.equal(s.status, 'done', s.detail);
    assert.deepEqual(r.calls, [
      `codex plugin remove ${BRIDGE}`, `codex plugin remove ${NEW_BRIDGE}`,
      `codex plugin marketplace remove ${MARKET}`, `codex plugin marketplace remove ${BRAND.marketplace}`,
    ]);
    for (const word of [`removed ${BRIDGE}`, `removed ${NEW_BRIDGE}`, `removed marketplace ${MARKET}`,
      `removed marketplace ${BRAND.marketplace}`]) assert.ok(s.detail.includes(word), `${word}: ${s.detail}`);
    assert.equal(stepOf(steps, 'codex-manifest').status, 'done');
    assert.deepEqual(readManifest(home).harnesses, {});
  });
});

test('a Codex plugin record remove-harness cannot match is reported and kept', async () => {
  await withHome({}, async (home) => {
    const plugins = [{ id: 'methodology-codex@elsewhere', action: 'added' }, { id: BRIDGE, action: 'added' }];
    writeManifest(home, { version: 1, harnesses: { codex: emptyEntry({ plugins }) } });
    const r = fakeRun(home);
    const { steps } = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    const s = stepOf(steps, 'codex-plugin');
    assert.equal(s.status, 'done', s.detail);
    assert.deepEqual(r.calls, [`codex plugin remove ${BRIDGE}`]);
    assert.ok(s.detail.includes('not recognized, kept in harnesses.json: methodology-codex@elsewhere (added)'), s.detail);
    assert.equal(stepOf(steps, 'codex-manifest').status, 'skipped');
    assert.deepEqual(readManifest(home).harnesses.codex.plugins, [{ id: 'methodology-codex@elsewhere', action: 'added' }]);
    // Alone, it is reported as skipped: nothing was removed.
    const again = stepOf((await removeHarness({ home, id: 'codex', run: r.run, now: LATER })).steps, 'codex-plugin');
    assert.equal(again.status, 'skipped', again.detail);
    assert.ok(again.detail.includes('methodology-codex@elsewhere (added)'), again.detail);
  });
});

test('remove-harness grok removes the files an older sync recorded under the legacy names', async () => {
  await withHome({}, async (home) => {
    const legacyRules = join(home, '.grok', 'rules', `${BRAND.legacy.grokName}.md`);
    const legacyHooks = join(home, '.grok', 'hooks', `${BRAND.legacy.grokName}.json`);
    const hooks = join(home, '.grok', 'hooks', `${BRAND.grokName}.json`);
    write(legacyRules, 'old rules\n');
    write(legacyHooks, '{"hooks":{}}\n');
    write(hooks, '{"hooks":{"PostCompact":[]}}\n');
    const files = [legacyRules, legacyHooks, hooks].map((path) => ({ path, sha256: sha256(readFileSync(path)), backup: null }));
    writeManifest(home, { version: 1, harnesses: { grok: emptyEntry({ files }) } });
    const { steps } = await removeHarness({ home, id: 'grok', run: fakeRun(home).run, now: LATER });
    assert.deepEqual(failedOf(steps), [], JSON.stringify(steps, null, 1));
    assert.match(stepOf(steps, 'grok-rules').detail, new RegExp(`removed ${BRAND.legacy.grokName}\\.md`));
    assert.match(stepOf(steps, 'grok-hooks').detail, new RegExp(`removed ${BRAND.legacy.grokName}\\.json, ${BRAND.grokName}\\.json`));
    for (const path of [legacyRules, legacyHooks, hooks]) assert.equal(existsSync(path), false, path);
    assert.equal(stepOf(steps, 'grok-manifest').status, 'done');
    assert.deepEqual(readManifest(home).harnesses, {});
  });
});

test('a failed item does not stop the others, and its records are kept', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW });
    const run = async (cmd, args, opts) => (args.join(' ') === `plugin remove ${BRIDGE}`
      ? { code: 4, stdout: '', stderr: 'boom' } : r.run(cmd, args, opts));
    const { steps } = await removeHarness({ home, id: 'codex', run, now: LATER });
    const plugin = stepOf(steps, 'codex-plugin');
    assert.equal(plugin.status, 'failed');
    assert.ok(plugin.detail.includes(`codex plugin remove ${BRIDGE} exited 4: boom`), plugin.detail);
    assert.equal(r.calls.includes(`codex plugin marketplace remove ${MARKET}`), false, 'not run after the remove failed');
    for (const id of ['codex-skills', 'codex-agents', 'codex-rules', 'codex-config']) assert.equal(stepOf(steps, id).status, 'done', id);
    assert.equal(stepOf(steps, 'codex-manifest').status, 'skipped');
    const kept = readManifest(home).harnesses.codex;
    assert.deepEqual(kept.plugins.map((p) => p.action).sort(), ['added', 'marketplace-added']);
    assert.deepEqual([kept.links, kept.files, kept.config, kept.rules], [[], [], [], null]);
    // A second run retries only what is left.
    const again = await removeHarness({ home, id: 'codex', run: r.run, now: LATER });
    assert.equal(stepOf(again.steps, 'codex-plugin').status, 'done');
    assert.equal(stepOf(again.steps, 'codex-manifest').status, 'done');
    assert.deepEqual(readManifest(home).harnesses, {});
  });
});

// ---- the triqual sync CLI ----

test('triqual sync --remove-harness runs the removal and sets harnesses.<id>.enabled false in config.json', async () => {
  await withHome({}, async (home) => {
    write(configJson(home), JSON.stringify({ keepSuperseded: false, harnesses: { codex: { enabled: true }, grok: { enabled: true } } }));
    const r = fakeRun(home);
    await syncHarness({ home, id: 'codex', run: r.run, now: NOW });
    const out = await syncCli(['--remove-harness', 'codex'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
    assert.equal(out.code, 0, out.stdout);
    assert.deepEqual(out.stdout.trimEnd().split('\n').map((l) => l.split(':')[0]), [...CODEX_REMOVE_STEPS, 'codex-enabled']);
    assert.match(out.stdout, /^codex-enabled: done — /m);
    assert.deepEqual(readJson(configJson(home)), { keepSuperseded: false, harnesses: { codex: { enabled: false }, grok: { enabled: true } } });
    const again = await syncCli(['--remove-harness', 'codex'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
    assert.deepEqual(again.stdout.trimEnd().split('\n').map((l) => l.split(' — ')[0]), ['codex: already', 'codex-enabled: already']);
    // The way back: an explicit triqual sync --harness codex records it enabled again, then syncs it.
    const back = await syncCli(['--harness', 'codex', '--yes'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
    assert.equal(back.code, 0, back.stdout);
    assert.match(back.stdout, /^codex-enabled: done — set harnesses\.codex\.enabled = true in /m);
    assert.equal(back.stdout.split('\n')[0].split(':')[0], 'codex-enabled', 'recorded before the harness steps');
    assert.deepEqual(readJson(configJson(home)), { keepSuperseded: false, harnesses: { codex: { enabled: true }, grok: { enabled: true } } });
    assert.ok(existsSync(join(home, '.codex', 'skills', 'using-methodology')), 'synced again');
    const twice = await syncCli(['--harness', 'codex', '--yes'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
    assert.match(twice.stdout, /^codex-enabled: already — harnesses\.codex\.enabled is true in /m);
  });
});

test('the CLI streams the split preview through log before the prompt', async () => {
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = fakeRun(home);
    const events = [];
    const out = await syncCli(['--harness', 'codex'], {
      home, pluginRoot: PLUGIN_ROOT, run: r.run, now: NOW, isTTY: true,
      confirm: async (q) => { events.push(`confirm ${q}`); return true; },
      log: (line) => events.push(`log ${line}`),
    });
    assert.equal(out.code, 0, out.stdout);
    const ask = events.indexOf(`confirm ${SPLIT_PROMPT}`);
    assert.ok(ask > 0, events.join('\n'));
    assert.ok(events.slice(0, ask).some((e) => e.startsWith('log codex-rules-gate: the one-time split of')), events.join('\n'));
    assert.ok(events.slice(0, ask).every((e) => e.startsWith('log ')));
    assert.equal(out.stdout.includes('the one-time split of'), false, 'the preview is not in the collected output');
    assert.match(out.stdout, /^codex-rules-gate: done — split /m);
  });
});

// A PATH holding only node and fake codex/grok that log each call and exit 1, so the real CLI entry runs with no real
// harness CLI reachable.
function fakeBin(home) {
  const bin = join(home, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['codex', 'grok']) {
    write(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$FAKE_CALLS"\nexit 1\n`, 0o755);
  }
  return bin;
}

const runEntry = (home, args) => spawnSync(process.execPath, [SYNC, ...args], {
  cwd: home, encoding: 'utf8', input: '',
  env: { HOME: home, PATH: fakeBin(home), FAKE_CALLS: join(home, 'calls.log') },
});

test('the triqual sync entry off a TTY prints the split preview before the step lines and asks nothing', async () => {
  await withHome({ agentsMd: SPLIT_FIXTURE }, async (home) => {
    const r = runEntry(home, ['--harness', 'codex']);
    assert.equal(r.stderr, '');
    const lines = r.stdout.split('\n');
    const preview = lines.findIndex((l) => l.startsWith('codex-rules-gate: the one-time split of'));
    const skip = lines.indexOf('codex-rules-gate: skipped — the one-time split needs a human: run triqual sync --harness codex');
    assert.ok(preview !== -1 && skip > preview, r.stdout);
    assert.equal(r.stdout.includes('[y/N]'), false, 'no prompt off a TTY');
    assert.equal(readFileSync(agentsMdPath(home), 'utf8'), SPLIT_FIXTURE);
  });
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await syncHarness({ home, id: 'grok', run: r.run, now: NOW });
    const out = runEntry(home, ['--remove-harness', 'grok']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^grok-plugins: skipped — reinstall needs a human/m);
    for (const [name] of GROK_STALE) assert.ok(out.stdout.includes(reinstallCommand(home, name)), name);
    const calls = existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8') : '';
    assert.equal(calls.includes('plugin install'), false, calls);
    assert.equal(readJson(configJson(home)).harnesses.grok.enabled, false);
  });
});
