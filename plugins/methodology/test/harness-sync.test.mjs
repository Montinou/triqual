import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  grokHooksFile, readManifest, refreshHarness, removeHarness, syncHarness, userInstalls, VALIDATE_TIMEOUT_MS,
  writeManifest,
} from '../cli/lib/harness-sync.mjs';
import { runCli, syncCli } from '../cli/sync.mjs';
import { expectedRules, harnessPaths, HOOK_TIMEOUTS } from '../cli/lib/harnesses.mjs';
import {
  codexAgentToml, CODEX_READONLY_REVIEWERS, CODEX_XHIGH, GENERATED_MARK, parseRole, rolesSha,
} from '../cli/lib/agents.mjs';
import { backupDirFor, readManagedSection, sha256 as sha } from '../cli/lib/fsx.mjs';
import { BRAND } from '../cli/lib/brand.mjs';
import { firstTableHeaderIndex, hasTopLevelKey } from '../cli/lib/toml-edit.mjs';
import { LOCK_STALE_MS, withLock } from '../cli/lib/lock.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const ROLES_AGENTS = join(PLUGIN_ROOT, '..', 'roles', 'agents');
const HOOK = join(PLUGIN_ROOT, 'cli', 'hook.mjs');
const CONFIG_FIXTURE = readFileSync(join(TEST_DIR, 'fixtures', 'legacy', 'codex-config.toml'), 'utf8');
const MARKET = BRAND.legacy.marketplace;
const pid = (name) => `${name}@${MARKET}`;
// The bridge of CONFIG_FIXTURE, whose config.toml holds the legacy bridge's table.
const BRIDGE = `methodology-codex@${MARKET}`;
const NEW_BRIDGE = `methodology-codex@${BRAND.marketplace}`;
const SUPERPOWERS_TABLE = 'plugins."superpowers@openai-curated-remote"';
const FALLBACK = 'project_doc_fallback_filenames = ["CLAUDE.md"]';
const NOW = new Date(2026, 8, 29, 10, 0, 0);
const LATER = new Date(2026, 8, 29, 11, 0, 0);

const METHODOLOGY_SKILLS = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
const OURS = [...METHODOLOGY_SKILLS, 'progress-tracking'];
// 13 of the 14 skills of the removed superpowers 6.0.3 cache (the 14th has no counterpart in ours since 1.0); the ones that
// share a name with ours clash, the rest do not, so NO_CLASH follows the skill set.
const SUPERPOWERS_SKILLS = [
  'brainstorming', 'dispatching-parallel-agents', 'executing-plans', 'finishing-a-development-branch',
  'receiving-code-review', 'requesting-code-review', 'systematic-debugging',
  'test-driven-development', 'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills',
];
const NO_CLASH = SUPERPOWERS_SKILLS.filter((name) => !OURS.includes(name));
const HAND_WRITTEN = '# hand-written role\nname = "tdd-implementer"\ndescription = "mine"\n';
const MACHINE_FILES = {
  'spark-explorer.toml': 'name = "spark-explorer"\ndescription = "Spark"\n',
  'spark-worker.toml': 'name = "spark-worker"\ndescription = "Spark"\n',
  'terra-planner.toml': 'name = "terra-planner"\ndescription = "Terra"\n',
};
const CODEX_AGENTS_MD = '# Codex machine config\n\n## Spark subagent routing\n\nRoute small edits to spark-worker.\n';
const GROK_STALE = [
  ['methodology', '0.1.2'], ['progress-tracking', '0.2.1'], ['workflow-gate', '0.1.0'], ['roles', '0.1.0'],
  ['superpowers', '6.3.0'],
];

const write = (path, text, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const cacheDir = (home, name, version) => join(home, '.claude', 'plugins', 'cache', MARKET, name, version);
const superpowersTarget = (home, name) => join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace',
  'superpowers', '6.0.3', 'skills', name);
const skillsDir = (home) => join(home, '.codex', 'skills');
const agentsDir = (home) => join(home, '.codex', 'agents');
const codexConfig = (home) => join(home, '.codex', 'config.toml');
const manifestFile = (home) => join(home, '.config', 'triqual', 'harnesses.json');
const backupsRoot = (home) => join(home, '.claude', 'backups');
const statusOf = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.status]));
const stepOf = (steps, id) => steps.find((s) => s.id === id);
const grokRules = (home) => join(home, '.grok', 'rules', `${BRAND.grokName}.md`);
const grokHooks = (home) => join(home, '.grok', 'hooks', `${BRAND.grokName}.json`);

// A methodology install: the repo's rules and a SKILL.md stub per skill.
function installMethodology(home, version) {
  const root = cacheDir(home, 'methodology', version);
  cpSync(join(PLUGIN_ROOT, 'rules'), join(root, 'rules'), { recursive: true });
  for (const name of METHODOLOGY_SKILLS) write(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  return root;
}

function installRoles(home, version) {
  const root = cacheDir(home, 'roles', version);
  cpSync(ROLES_AGENTS, join(root, 'agents'), { recursive: true });
  return root;
}

function writeInstalled(home, installs) {
  const plugins = {};
  for (const [name, { installPath, version }] of Object.entries(installs)) {
    plugins[pid(name)] = [{ scope: 'user', installPath, version }];
  }
  write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }, null, 2));
}

function setEnabled(home, overrides = {}) {
  write(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: {
      [pid('methodology')]: true, [pid('progress-tracking')]: true, [pid('roles')]: true, [pid('workflow-gate')]: true,
      ...Object.fromEntries(Object.entries(overrides).map(([name, on]) => [pid(name), on])),
    },
  }, null, 2));
}

const setConfig = (home, config) => write(join(home, '.config', 'triqual', 'config.json'), JSON.stringify(config));

function grokEntry(home, name, version, dir = join(home, '.grok', 'installed-plugins')) {
  const repoKey = `${name}-1a2b3c4d`;
  return {
    status: 'installed', name, repo_key: repoKey, version, path: join(dir, repoKey),
    source: join(home, '.grok', 'marketplace-cache', 'e5f6', 'plugins', name), marketplace: BRAND.legacy.marketplace,
  };
}

// A temp home laid out like the real one: user-scope installs, 13 dangling superpowers links, Spark/Terra agents and
// a hand-written tdd-implementer.toml, the synthetic config.toml and an AGENTS.md without legacy headings, and Grok's
// stale plugins under ~/.grok/installed-plugins.
function makeHome({ codex = true, grok = true, enabled = {}, config } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cm-hsync-'));
  const installs = {
    methodology: { installPath: installMethodology(home, '0.3.0'), version: '0.3.0' },
    'progress-tracking': { installPath: cacheDir(home, 'progress-tracking', '0.2.3'), version: '0.2.3' },
    roles: { installPath: installRoles(home, '0.1.0'), version: '0.1.0' },
  };
  write(join(installs['progress-tracking'].installPath, 'skills', 'progress-tracking', 'SKILL.md'), '---\nname: progress-tracking\n---\n');
  writeInstalled(home, installs);
  setEnabled(home, enabled);
  if (config) setConfig(home, config);
  mkdirSync(join(home, '.claude', 'plugins', 'marketplaces', MARKET), { recursive: true });
  // Claude Code knows the marketplace of that clone, so the plugin ids resolve under it (lib/brand.mjs).
  write(join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ [MARKET]: { installLocation: join(home, '.claude', 'plugins', 'marketplaces', MARKET) } }));
  const vercel = join(home, '.claude', 'plugins', 'marketplaces', 'vercel', 'skills', 'ai-sdk');
  write(join(vercel, 'SKILL.md'), 'vercel');
  if (codex) {
    mkdirSync(skillsDir(home), { recursive: true });
    for (const name of SUPERPOWERS_SKILLS) symlinkSync(superpowersTarget(home, name), join(skillsDir(home), name));
    symlinkSync(vercel, join(skillsDir(home), 'ai-sdk'));
    for (const [file, text] of Object.entries(MACHINE_FILES)) write(join(agentsDir(home), file), text);
    write(join(agentsDir(home), 'tdd-implementer.toml'), HAND_WRITTEN);
    write(codexConfig(home), CONFIG_FIXTURE, 0o600);
    write(join(home, '.codex', 'AGENTS.md'), CODEX_AGENTS_MD);
  }
  if (grok) {
    for (const [name, version] of GROK_STALE) {
      write(join(grokEntry(home, name, version).path, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
    }
    write(join(grokEntry(home, 'claude-mem', '13.0.0').path, 'plugin.json'), '{}');
  }
  return { home, installs };
}

async function withHome(opts, fn) {
  const made = makeHome(opts);
  try {
    return await fn(made.home, made);
  } finally {
    rmSync(made.home, { recursive: true, force: true });
  }
}

// A fake `run` for codex and grok that records each call and keeps the state the real CLIs would. `codex plugin list
// --json` reads the superpowers enabled state from config.toml, the way Codex does.
// extraSuperpowers: more superpowers@<marketplace> ids listed, enabled until config.toml disables them; remoteManaged:
// superpowers@openai-curated-remote is listed enabled whatever config.toml says; uninstallFail: names whose
// `grok plugin uninstall` exits 1.
function fakeRun(home, {
  hooks = true, grokList, uninstallIgnored = [], uninstallFail = [], versionCode = 0, extraSuperpowers = [],
  remoteManaged = false,
} = {}) {
  const calls = [];
  const state = {
    marketplaces: ['openai-curated', 'superpowers-marketplace'], bridge: false, hooks,
    grok: grokList ?? [...GROK_STALE.map(([n, v]) => grokEntry(home, n, v)), grokEntry(home, 'claude-mem', '13.0.0')],
  };
  const superpowersOn = (id = 'superpowers@openai-curated-remote') => {
    let text = '';
    try { text = readFileSync(codexConfig(home), 'utf8'); } catch { /* no config */ }
    return !text.split(/\r?\n/).some((l, i, all) => l === `[plugins."${id}"]` && all[i + 1] === 'enabled = false');
  };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const rest = args.join(' ');
    if (rest === '--version') return { code: versionCode, stdout: '', stderr: '' };
    if (cmd === 'codex') {
      if (rest === 'plugin list --json') {
        return ok(JSON.stringify({
          installed: [
            { pluginId: 'superpowers@superpowers-marketplace', name: 'superpowers', marketplaceName: 'superpowers-marketplace', version: '6.0.3', installed: true, enabled: false },
            { pluginId: 'superpowers@openai-curated-remote', name: 'superpowers', marketplaceName: 'openai-curated-remote', version: '6.4.2', installed: true, enabled: remoteManaged || superpowersOn() },
            ...extraSuperpowers.map((id) => ({ pluginId: id, name: 'superpowers', marketplaceName: id.split('@')[1], version: '6.4.2', installed: true, enabled: superpowersOn(id) })),
            ...(state.bridge ? [{ pluginId: state.bridge === true ? BRIDGE : state.bridge, name: 'methodology-codex', marketplaceName: MARKET, version: '0.2.0', installed: true, enabled: true }] : []),
          ],
          available: [],
        }));
      }
      if (rest === 'plugin marketplace list --json') {
        return ok(JSON.stringify({ marketplaces: state.marketplaces.map((name) => ({ name, root: `/roots/${name}` })) }));
      }
      if (rest.startsWith('plugin marketplace add ')) { state.marketplaces.push(basename(args[3])); return ok(); }
      if (rest === `plugin add ${BRIDGE}` || rest === `plugin add ${NEW_BRIDGE}`) { state.bridge = args[2]; return ok(); }
      if (rest === 'features list') return ok(`apps                                     stable             true\nhooks                                    stable             ${state.hooks}\n`);
      if (rest === 'features enable hooks') { state.hooks = true; return ok(); }
    }
    if (cmd === 'grok') {
      if (rest === 'plugin list --json') return ok(JSON.stringify(state.grok));
      if (args[0] === 'plugin' && args[1] === 'uninstall') {
        const name = args[2];
        if (uninstallFail.includes(name)) return { code: 1, stdout: '', stderr: `cannot uninstall ${name}` };
        if (!uninstallIgnored.includes(name)) {
          const entry = state.grok.find((p) => p.name === name);
          state.grok = state.grok.filter((p) => p.name !== name);
          if (entry) rmSync(entry.path, { recursive: true, force: true });
        }
        return ok(`Uninstalled 1 plugin(s): ${name}\n`);
      }
    }
    return { code: 1, stdout: '', stderr: `fake: unexpected ${line}` };
  };
  return { run, calls, state };
}

const syncCodex = (home, r, extra = {}) => syncHarness({ home, id: 'codex', run: r.run, now: NOW, ...extra });
const syncGrok = (home, r, extra = {}) => syncHarness({ home, id: 'grok', run: r.run, now: NOW, ...extra });

// Every path under dir with its bytes (a link as its text), so a test sees any write.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) { out[rel] = 'dir'; walk(p); } else out[rel] = readFileSync(p).toString('base64');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const CODEX_STEPS = ['codex-skills', 'codex-rules-gate', 'codex-rules', 'codex-agents', 'codex-plugin', 'codex-config',
  'codex-supersedes'];
const ROLE_NAMES = readdirSync(ROLES_AGENTS).filter((f) => f.endsWith('.md'))
  .map((f) => parseRole(readFileSync(join(ROLES_AGENTS, f), 'utf8')).name).sort();
const expectedAgent = (agents, name, rolesVersion = '0.1.0') => codexAgentToml(
  parseRole(readFileSync(join(agents, `${name}.md`), 'utf8')), { rolesVersion, xhigh: CODEX_XHIGH, readOnly: CODEX_READONLY_REVIEWERS },
);

// ---- userInstalls, manifest ----

test('userInstalls reads the user-scope installs and the enabled state', () => withHome({ codex: false, grok: false, enabled: { roles: false } }, (home, { installs }) => {
  const u = userInstalls(home);
  assert.deepEqual(u, {
    methodology: { ...installs.methodology, enabled: true },
    'progress-tracking': { ...installs['progress-tracking'], enabled: true },
    roles: { ...installs.roles, enabled: false },
  });
  writeInstalled(home, { methodology: installs.methodology });
  assert.equal(userInstalls(home).roles, null);
  rmSync(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  assert.deepEqual(userInstalls(home), { methodology: null, 'progress-tracking': null, roles: null });
}));

test('readManifest and writeManifest round-trip harnesses.json', () => withHome({ codex: false, grok: false }, (home) => {
  assert.deepEqual(readManifest(home), { version: 1, harnesses: {} });
  const m = { version: 1, harnesses: { codex: { links: [{ path: '/x', target: '/y', replaced: null }] } } };
  writeManifest(home, m);
  assert.deepEqual(readManifest(home), m);
  assert.equal(readFileSync(manifestFile(home), 'utf8'), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(manifestFile(home), '{ nope');
  assert.throws(() => readManifest(home), /not valid JSON/);
}));

// ---- Codex ----

test('codex sync from scratch', () => withHome({}, async (home, { installs }) => {
  const r = fakeRun(home);
  const { steps } = await syncCodex(home, r);
  assert.deepEqual(steps.map((s) => s.id), CODEX_STEPS);
  assert.deepEqual(steps.filter((s) => s.status !== 'done'), [], JSON.stringify(steps, null, 1));
  for (const s of steps) assert.ok(typeof s.detail === 'string' && s.detail.length > 0, s.id);

  // 16 links into the user-scope installs; the dangling superpowers ones replaced, their old targets recorded.
  const m = readManifest(home).harnesses.codex;
  for (const name of OURS) {
    const root = name === 'progress-tracking' ? installs['progress-tracking'].installPath : installs.methodology.installPath;
    assert.equal(readlinkSync(join(skillsDir(home), name)), join(root, 'skills', name), name);
    const rec = m.links.find((l) => l.path === join(skillsDir(home), name));
    assert.ok(rec, `${name} recorded`);
    assert.equal(rec.target, join(root, 'skills', name));
    assert.equal(rec.replaced, SUPERPOWERS_SKILLS.includes(name) ? superpowersTarget(home, name) : null, name);
  }
  assert.equal(readlinkSync(join(skillsDir(home), 'ai-sdk')), join(home, '.claude', 'plugins', 'marketplaces', 'vercel', 'skills', 'ai-sdk'));

  // Spark/Terra untouched; the hand-written tdd-implementer.toml backed up and regenerated.
  for (const [file, text] of Object.entries(MACHINE_FILES)) assert.equal(readFileSync(join(agentsDir(home), file), 'utf8'), text, file);
  const backup = join(backupDirFor(home, NOW), 'codex', 'tdd-implementer.toml');
  assert.equal(readFileSync(backup, 'utf8'), HAND_WRITTEN);
  const agents = join(installs.roles.installPath, 'agents');
  for (const name of ROLE_NAMES) {
    const text = readFileSync(join(agentsDir(home), `${name}.toml`), 'utf8');
    assert.ok(text.startsWith(GENERATED_MARK), name);
    assert.equal(text, expectedAgent(agents, name), name);
  }
  assert.deepEqual(m.files.map((f) => f.path).sort(), ROLE_NAMES.map((n) => join(agentsDir(home), `${n}.toml`)).sort());
  assert.equal(m.files.find((f) => f.path.endsWith('tdd-implementer.toml')).backup, backup);
  assert.equal(m.files.find((f) => f.path.endsWith('brief-writer.toml')).backup, null);
  assert.equal(m.rolesSha, rolesSha(agents));

  // AGENTS.md: the machine config kept, the managed section equal to expectedRules.
  const agentsMd = readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.ok(agentsMd.startsWith(CODEX_AGENTS_MD));
  assert.equal(readManagedSection(agentsMd).body, expectedRules(installs.methodology.installPath, 'codex').trim());
  assert.equal(readFileSync(join(backupDirFor(home, NOW), 'codex', 'AGENTS.md'), 'utf8'), CODEX_AGENTS_MD);
  assert.deepEqual(m.rules, { path: join(home, '.codex', 'AGENTS.md'), split: false, backup: join(backupDirFor(home, NOW), 'codex', 'AGENTS.md') });

  // The bridge through the CLI; the hooks feature checked.
  assert.ok(r.calls.includes(`codex plugin marketplace add ${join(home, '.claude', 'plugins', 'marketplaces', MARKET)}`), r.calls.join('\n'));
  assert.ok(r.calls.includes(`codex plugin add ${BRIDGE}`));
  assert.ok(r.calls.includes('codex features list'));
  assert.equal(r.calls.includes('codex features enable hooks'), false, 'hooks is already on');

  // config.toml: the fallback key before the first header, a mode kept, no backup of it anywhere.
  const config = readFileSync(codexConfig(home), 'utf8');
  assert.ok(hasTopLevelKey(config, 'project_doc_fallback_filenames'));
  const lines = config.split('\n');
  assert.ok(lines.indexOf(FALLBACK) !== -1 && lines.indexOf(FALLBACK) < firstTableHeaderIndex(config), 'before the first header');
  assert.equal(statSync(codexConfig(home)).mode & 0o777, 0o600);
  assert.equal(Object.keys(snapshot(backupsRoot(home))).some((p) => p.endsWith('config.toml')), false);

  // The manifest lists everything.
  assert.equal(m.links.length, OURS.length + NO_CLASH.length);
  assert.deepEqual(m.config, [
    { key: 'project_doc_fallback_filenames', table: null, was: null, createdTable: false },
    { key: 'enabled', table: SUPERPOWERS_TABLE, was: null, createdTable: true },
  ]);
  assert.deepEqual(m.plugins, [
    { id: MARKET, action: 'marketplace-added' },
    { id: BRIDGE, action: 'added' },
  ]);
}));

test("syncHarness('codex') on an AGENTS.md whose legacy section holds global.md leaves one new section", () => withHome({}, async (home, { installs }) => {
  // What a pre-rename sync left: the machine config, the rules (global.md plus the Codex note) inside the legacy
  // markers, and the user's own text after them.
  const L = BRAND.legacy.markers;
  const rules = expectedRules(installs.methodology.installPath, 'codex').trim();
  const after = '\n## Mine after\n\nkept\n';
  write(join(home, '.codex', 'AGENTS.md'), `${CODEX_AGENTS_MD}\n${L.start}\n${rules}\n${L.end}${after}`);
  const { steps } = await syncCodex(home, fakeRun(home));
  assert.equal(stepOf(steps, 'codex-rules-gate').status, 'done', JSON.stringify(stepOf(steps, 'codex-rules-gate')));
  const s = stepOf(steps, 'codex-rules');
  assert.equal(s.status, 'done', s.detail);
  assert.match(s.detail, /replaced/);
  const text = readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal(text.split(BRAND.markers.start).length - 1, 1);
  assert.ok(!text.includes(L.start) && !text.includes(L.end));
  assert.equal(text, `${CODEX_AGENTS_MD}\n${BRAND.markers.start}\n${rules}\n${BRAND.markers.end}${after}`);
}));

test('the superpowers disable records createdTable', () => withHome({}, async (home) => {
  const { steps } = await syncCodex(home, fakeRun(home));
  assert.equal(stepOf(steps, 'codex-supersedes').status, 'done');
  assert.match(stepOf(steps, 'codex-supersedes').detail, /superpowers@openai-curated-remote/);
  const entry = readManifest(home).harnesses.codex.config.find((c) => c.table === SUPERPOWERS_TABLE);
  assert.deepEqual(entry, { key: 'enabled', table: SUPERPOWERS_TABLE, was: null, createdTable: true });
  const config = readFileSync(codexConfig(home), 'utf8');
  assert.match(config, /^\[plugins\."superpowers@openai-curated-remote"\]\nenabled = false$/m);
  assert.doesNotMatch(config, /\[hooks\.state\.[^\n]*superpowers/, 'no [hooks.state] written');
  assert.equal(config.split('\n').filter((l) => l.startsWith('[hooks.state.')).length, 1, 'the fixture trust header only');
}));

test('two enabled superpowers@* entries are both disabled', () => withHome({}, async (home) => {
  const other = 'superpowers@openai-curated';
  const { steps } = await syncCodex(home, fakeRun(home, { extraSuperpowers: [other] }));
  const s = stepOf(steps, 'codex-supersedes');
  assert.equal(s.status, 'done', s.detail);
  assert.equal(s.detail, `disabled superpowers@openai-curated-remote, ${other}`);
  const config = readFileSync(codexConfig(home), 'utf8');
  assert.match(config, /^\[plugins\."superpowers@openai-curated-remote"\]\nenabled = false$/m);
  assert.match(config, /^\[plugins\."superpowers@openai-curated"\]\nenabled = false$/m);
  assert.deepEqual(readManifest(home).harnesses.codex.config.filter((c) => c.key === 'enabled').map((c) => c.table),
    [SUPERPOWERS_TABLE, `plugins."${other}"`]);
}));

test('a superpowers entry config.toml already disables but Codex lists enabled is skipped, not failed', () => withHome({}, async (home) => {
  writeFileSync(codexConfig(home), `${CONFIG_FIXTURE}\n[${SUPERPOWERS_TABLE}]\nenabled = false\n`);
  const { steps } = await syncCodex(home, fakeRun(home, { remoteManaged: true }));
  assert.deepEqual(stepOf(steps, 'codex-supersedes'), {
    id: 'codex-supersedes', status: 'skipped',
    detail: 'disabled in config.toml, Codex still lists it enabled (remotely managed?): superpowers@openai-curated-remote',
  });
  const after = readFileSync(codexConfig(home), 'utf8');
  assert.ok(after.endsWith(`\n[${SUPERPOWERS_TABLE}]\nenabled = false\n`), 'the table is left as it was');
  assert.equal(after.split(`[${SUPERPOWERS_TABLE}]`).length, 2, 'once');
  assert.equal(readManifest(home).harnesses.codex.config.some((c) => c.table === SUPERPOWERS_TABLE), false);
}));

test('codex-config and codex-supersedes hold the manifest lock across the edit and its record', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  const validations = [];
  const run = async (cmd, args, opts) => {
    if (args.join(' ') === 'features list') {
      const text = readFileSync(codexConfig(home), 'utf8');
      validations.push({
        fallback: text.includes(FALLBACK), superpowers: text.includes(`[${SUPERPOWERS_TABLE}]\nenabled = false`),
        locked: existsSync(`${manifestFile(home)}.lock`),
      });
    }
    return r.run(cmd, args, opts);
  };
  const { steps } = await syncHarness({ home, id: 'codex', run, now: NOW });
  assert.equal(stepOf(steps, 'codex-config').status, 'done');
  assert.equal(stepOf(steps, 'codex-supersedes').status, 'done');
  assert.equal(validations.find((v) => v.fallback).locked, true, 'codex-config validates under the lock');
  assert.equal(validations.find((v) => v.superpowers).locked, true, 'codex-supersedes validates under the lock');
}));

test('second sync is a no-op', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  await syncCodex(home, r);
  const manifest = readFileSync(manifestFile(home));
  const codexTree = snapshot(join(home, '.codex'));
  const backups = readdirSync(backupsRoot(home));
  const { steps } = await syncCodex(home, r, { now: LATER });
  assert.deepEqual(statusOf(steps), Object.fromEntries(CODEX_STEPS.map((id) => [id, id === 'codex-rules-gate' ? 'done' : 'already'])),
    JSON.stringify(steps, null, 1));
  assert.deepEqual(readdirSync(backupsRoot(home)), backups, 'no new backup dir');
  assert.equal(existsSync(backupDirFor(home, LATER)), false);
  assert.ok(readFileSync(manifestFile(home)).equals(manifest), 'manifest bytes unchanged');
  assert.deepEqual(snapshot(join(home, '.codex')), codexTree);
}));

test('the hooks feature is enabled when features list shows it off', () => withHome({}, async (home) => {
  const r = fakeRun(home, { hooks: false });
  const { steps } = await syncCodex(home, r);
  assert.equal(stepOf(steps, 'codex-plugin').status, 'done');
  assert.ok(r.calls.includes('codex features enable hooks'));
  assert.deepEqual(readManifest(home).harnesses.codex.plugins.at(-1), { id: 'hooks', action: 'feature-enabled' });
}));

test('codex-plugin keeps the legacy bridge and Codex marketplace while config.toml holds the legacy bridge', () => withHome({}, async (home) => {
  // CONFIG_FIXTURE holds [plugins."methodology-codex@<legacy>"]: the installed bridge decides, not the known
  // Claude marketplaces.
  const plugins = join(home, '.claude', 'plugins');
  write(join(plugins, 'known_marketplaces.json'), JSON.stringify({
    [BRAND.marketplace]: { installLocation: join(plugins, 'marketplaces', BRAND.marketplace) },
    [MARKET]: { installLocation: join(plugins, 'marketplaces', MARKET) },
  }));
  const r = fakeRun(home);
  const { steps } = await syncCodex(home, r);
  assert.equal(stepOf(steps, 'codex-plugin').status, 'done', JSON.stringify(steps, null, 1));
  assert.ok(r.calls.includes(`codex plugin marketplace add ${join(plugins, 'marketplaces', MARKET)}`), r.calls.join('\n'));
  assert.deepEqual(readManifest(home).harnesses.codex.plugins.slice(0, 2), [
    { id: MARKET, action: 'marketplace-added' },
    { id: BRIDGE, action: 'added' },
  ]);
}));

test('codex-plugin adds the triqual bridge from the triqual clone when config.toml holds no legacy bridge', () => withHome({}, async (home) => {
  write(codexConfig(home), CONFIG_FIXTURE.replace(`[plugins."${BRIDGE}"]`, '[plugins."other@x"]'), 0o600);
  mkdirSync(join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace), { recursive: true });
  const r = fakeRun(home);
  const { steps } = await syncCodex(home, r);
  const s = stepOf(steps, 'codex-plugin');
  assert.equal(s.status, 'done', JSON.stringify(steps, null, 1));
  const clone = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace);
  assert.ok(r.calls.includes(`codex plugin marketplace add ${clone}`), r.calls.join('\n'));
  assert.ok(r.calls.includes(`codex plugin add ${NEW_BRIDGE}`), r.calls.join('\n'));
  assert.equal(r.calls.some((c) => c.includes(BRIDGE)), false, 'no legacy id in any call');
  assert.equal(s.detail, `added marketplace ${BRAND.marketplace}, added ${NEW_BRIDGE}`);
  assert.deepEqual(readManifest(home).harnesses.codex.plugins, [
    { id: BRAND.marketplace, action: 'marketplace-added' },
    { id: NEW_BRIDGE, action: 'added' },
  ]);
}));

test('codex-plugin names the migration when the clone of the bridge id\'s marketplace is missing', () => withHome({}, async (home) => {
  // A standalone `sync --harness codex` before migration: no legacy bridge in config.toml, so the bridge id is
  // triqual's, but Claude Code still knows only the legacy marketplace and has no triqual clone.
  write(codexConfig(home), CONFIG_FIXTURE.replace(`[plugins."${BRIDGE}"]`, '[plugins."other@x"]'), 0o600);
  const r = fakeRun(home);
  const { steps } = await syncCodex(home, r);
  const clone = join(home, '.claude', 'plugins', 'marketplaces', BRAND.marketplace);
  assert.deepEqual(stepOf(steps, 'codex-plugin'), {
    id: 'codex-plugin', status: 'failed', detail: `${clone} does not exist: run ${BRAND.cli} migrate`,
  });
  assert.equal(r.calls.some((c) => c.startsWith('codex plugin marketplace add') || c.startsWith('codex plugin add')), false);
}));

test('codex-plugin is already when the bridge is listed enabled', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  r.state.bridge = true;
  r.state.marketplaces.push(MARKET);
  const { steps } = await syncCodex(home, r);
  assert.equal(stepOf(steps, 'codex-plugin').status, 'already');
  assert.equal(r.calls.some((c) => c.startsWith('codex plugin add') || c.startsWith('codex plugin marketplace add')), false);
}));

test('a failing codex CLI fails its step and the rest still run', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  const run = async (cmd, args, opts) => (args[0] === 'plugin' && args[1] === 'add'
    ? { code: 3, stdout: '', stderr: 'boom\nmore' } : r.run(cmd, args, opts));
  const { steps } = await syncHarness({ home, id: 'codex', run, now: NOW });
  const plugin = stepOf(steps, 'codex-plugin');
  assert.equal(plugin.status, 'failed');
  assert.match(plugin.detail, new RegExp(`codex plugin add methodology-codex@${BRAND.legacy.marketplace} exited 3: boom$`));
  assert.equal(stepOf(steps, 'codex-config').status, 'done');
}));

test('a config.toml that codex rejects is restored and fails the step', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  const run = async (cmd, args, opts) => (args.join(' ') === 'features list' && existsSync(codexConfig(home))
    && readFileSync(codexConfig(home), 'utf8').includes(FALLBACK) ? { code: 1, stdout: '', stderr: '' } : r.run(cmd, args, opts));
  const { steps } = await syncHarness({ home, id: 'codex', run, now: NOW });
  assert.deepEqual(stepOf(steps, 'codex-config'), {
    id: 'codex-config', status: 'failed', detail: 'codex rejected the edited config; restored',
  });
  assert.equal(readFileSync(codexConfig(home), 'utf8').includes(FALLBACK), false);
  assert.equal((readManifest(home).harnesses.codex.config ?? []).some((c) => c.key === 'project_doc_fallback_filenames'), false);
}));

test('the Codex rules gate skips on legacy headings off a TTY: the split needs a human', () => withHome({}, async (home) => {
  const legacy = `${CODEX_AGENTS_MD}\n## UNIVERSAL DEVELOPMENT RULES\n\n### Never Assume - Always Verify\n`;
  writeFileSync(join(home, '.codex', 'AGENTS.md'), legacy);
  const { steps } = await syncCodex(home, fakeRun(home));
  assert.deepEqual(stepOf(steps, 'codex-rules-gate'), {
    id: 'codex-rules-gate', status: 'skipped', detail: 'the one-time split needs a human: run triqual sync --harness codex',
  });
  assert.equal(stepOf(steps, 'codex-rules').status, 'skipped');
  assert.equal(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), legacy);
  assert.equal(stepOf(steps, 'codex-agents').status, 'done', 'the other steps still run');
}));

test('superseded links without a name clash are removed', async () => {
  await withHome({}, async (home) => {
    await syncCodex(home, fakeRun(home));
    const links = readManifest(home).harnesses.codex.links;
    for (const name of NO_CLASH) {
      const path = join(skillsDir(home), name);
      assert.equal(existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })(), false, name);
      assert.deepEqual(links.find((l) => l.path === path), { path, target: null, replaced: superpowersTarget(home, name) });
    }
  });
  await withHome({ config: { keepSuperseded: true } }, async (home) => {
    const { steps } = await syncCodex(home, fakeRun(home));
    for (const name of NO_CLASH) assert.equal(readlinkSync(join(skillsDir(home), name)), superpowersTarget(home, name), name);
    // The clashing ones dangle, so they are replaced all the same.
    assert.equal(readlinkSync(join(skillsDir(home), 'brainstorming')).includes(join(MARKET, 'methodology')), true);
    assert.equal(stepOf(steps, 'codex-skills').status, 'done');
  });
});

test('a superseded link that still resolves is replaced unless keepSuperseded', async () => {
  const live = (home, name) => {
    const target = superpowersTarget(home, name);
    write(join(target, 'SKILL.md'), 'superpowers');
    return target;
  };
  await withHome({}, async (home) => {
    const target = live(home, 'writing-plans');
    await syncCodex(home, fakeRun(home));
    assert.equal(readlinkSync(join(skillsDir(home), 'writing-plans')), join(cacheDir(home, 'methodology', '0.3.0'), 'skills', 'writing-plans'));
    assert.equal(readManifest(home).harnesses.codex.links.find((l) => l.path.endsWith('/writing-plans')).replaced, target);
  });
  await withHome({ config: { keepSuperseded: true } }, async (home) => {
    const target = live(home, 'writing-plans');
    const { steps } = await syncCodex(home, fakeRun(home));
    assert.equal(readlinkSync(join(skillsDir(home), 'writing-plans')), target);
    assert.match(stepOf(steps, 'codex-skills').detail, /left alone[^\n]*writing-plans/);
  });
});

test('a link we did not make is left alone and reported', () => withHome({}, async (home) => {
  const mine = join(home, 'my-skills', 'verification-before-completion');
  write(join(mine, 'SKILL.md'), 'mine');
  rmSync(join(skillsDir(home), 'verification-before-completion'));
  symlinkSync(mine, join(skillsDir(home), 'verification-before-completion'));
  rmSync(join(skillsDir(home), 'systematic-debugging'));
  write(join(skillsDir(home), 'systematic-debugging', 'SKILL.md'), 'a real dir');
  const r = fakeRun(home);
  const { steps } = await syncCodex(home, r);
  assert.equal(readlinkSync(join(skillsDir(home), 'verification-before-completion')), mine);
  assert.equal(readFileSync(join(skillsDir(home), 'systematic-debugging', 'SKILL.md'), 'utf8'), 'a real dir');
  const skills = stepOf(steps, 'codex-skills');
  assert.equal(skills.status, 'done');
  assert.match(skills.detail, /left alone \(not ours\): systematic-debugging, verification-before-completion/);
  const links = readManifest(home).harnesses.codex.links;
  assert.equal(links.some((l) => l.path.endsWith('/verification-before-completion') || l.path.endsWith('/systematic-debugging')), false);
  // Still reported on the next sync, which is otherwise a no-op.
  const again = stepOf((await syncCodex(home, r, { now: LATER })).steps, 'codex-skills');
  assert.equal(again.status, 'already');
  assert.match(again.detail, /left alone \(not ours\): systematic-debugging, verification-before-completion/);
}));

test('methodology disabled in Claude removes our links and agents', () => withHome({}, async (home, { installs }) => {
  const r = fakeRun(home);
  await syncCodex(home, r);
  setEnabled(home, { methodology: false });
  const { steps } = await syncCodex(home, r, { now: LATER });
  assert.equal(stepOf(steps, 'codex-skills').status, 'done');
  assert.equal(stepOf(steps, 'codex-agents').status, 'done');
  for (const name of METHODOLOGY_SKILLS) {
    assert.throws(() => lstatSync(join(skillsDir(home), name)), { code: 'ENOENT' }, name);
  }
  // progress-tracking is still enabled: its link stays.
  assert.equal(readlinkSync(join(skillsDir(home), 'progress-tracking')), join(installs['progress-tracking'].installPath, 'skills', 'progress-tracking'));
  for (const name of ROLE_NAMES) assert.equal(existsSync(join(agentsDir(home), `${name}.toml`)), false, name);
  for (const [file, text] of Object.entries(MACHINE_FILES)) assert.equal(readFileSync(join(agentsDir(home), file), 'utf8'), text);
  // The records that restore what we replaced are kept; the rest are dropped.
  const m = readManifest(home).harnesses.codex;
  const brainstorming = m.links.find((l) => l.path.endsWith('/brainstorming'));
  assert.deepEqual(brainstorming, { path: join(skillsDir(home), 'brainstorming'), target: null, replaced: superpowersTarget(home, 'brainstorming') });
  assert.equal(m.links.some((l) => l.path.endsWith('/using-methodology')), false);
  assert.deepEqual(m.files, [{ path: join(agentsDir(home), 'tdd-implementer.toml'), sha256: null, backup: join(backupDirFor(home, NOW), 'codex', 'tdd-implementer.toml') }]);
  // A second disabled sync changes nothing; re-enabling restores them.
  assert.deepEqual(statusOf((await syncCodex(home, r, { now: LATER })).steps)['codex-skills'], 'already');
  setEnabled(home);
  await syncCodex(home, r, { now: LATER });
  for (const name of OURS) assert.ok(lstatSync(join(skillsDir(home), name)).isSymbolicLink(), name);
  for (const name of ROLE_NAMES) assert.ok(readFileSync(join(agentsDir(home), `${name}.toml`), 'utf8').startsWith(GENERATED_MARK));
  assert.equal(readManifest(home).harnesses.codex.files.find((f) => f.path.endsWith('tdd-implementer.toml')).backup,
    join(backupDirFor(home, NOW), 'codex', 'tdd-implementer.toml'), 'the first backup is the one kept');
}));

test('superseded links are left alone while methodology is disabled in Claude', async () => {
  for (const enabled of [{ methodology: false, 'progress-tracking': false }, { methodology: false }]) {
    await withHome({ enabled }, async (home) => {
      const { steps } = await syncCodex(home, fakeRun(home));
      for (const name of SUPERPOWERS_SKILLS) {
        assert.equal(readlinkSync(join(skillsDir(home), name)), superpowersTarget(home, name), `${JSON.stringify(enabled)} ${name}`);
      }
      assert.doesNotMatch(stepOf(steps, 'codex-skills').detail, /superseded/);
      assert.equal((readManifest(home).harnesses.codex?.links ?? []).some((l) => SUPERPOWERS_SKILLS.includes(basename(l.path))), false);
    });
  }
});

test('roles disabled in Claude removes the agents only', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  await syncCodex(home, r);
  setEnabled(home, { roles: false });
  const { steps } = await syncCodex(home, r, { now: LATER });
  assert.equal(stepOf(steps, 'codex-agents').status, 'done');
  assert.equal(stepOf(steps, 'codex-skills').status, 'already');
  for (const name of ROLE_NAMES) assert.equal(existsSync(join(agentsDir(home), `${name}.toml`)), false, name);
}));

test('refreshHarness re-points a link whose target moved to a new install version and regenerates agents on a changed rolesSha', () => withHome({}, async (home, { installs }) => {
  await syncCodex(home, fakeRun(home));
  const next = { ...installs, methodology: { installPath: installMethodology(home, '0.3.1'), version: '0.3.1' } };
  const roleFile = join(installs.roles.installPath, 'agents', 'tdd-implementer.md');
  writeFileSync(roleFile, `${readFileSync(roleFile, 'utf8')}\nOne more rule.\n`);
  writeInstalled(home, next);
  const before = readManifest(home).harnesses.codex;
  assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: true });
  for (const name of METHODOLOGY_SKILLS) {
    assert.equal(readlinkSync(join(skillsDir(home), name)), join(next.methodology.installPath, 'skills', name), name);
  }
  const after = readManifest(home).harnesses.codex;
  assert.equal(after.links.find((l) => l.path.endsWith('/brainstorming')).replaced, superpowersTarget(home, 'brainstorming'),
    'the original old target is kept');
  const agents = join(installs.roles.installPath, 'agents');
  assert.notEqual(after.rolesSha, before.rolesSha);
  assert.equal(after.rolesSha, rolesSha(agents));
  const tdd = readFileSync(join(agentsDir(home), 'tdd-implementer.toml'), 'utf8');
  assert.ok(tdd.includes('One more rule.'));
  assert.equal(tdd, expectedAgent(agents, 'tdd-implementer'));
  assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: false });
  assert.deepEqual(await refreshHarness({ home, id: 'grok' }), { changed: false }, 'a no-op for Grok');
}));

test('a generated agent whose role is no longer shipped is backed up and removed; files without our mark are kept', () => withHome({}, async (home) => {
  await syncCodex(home, fakeRun(home));
  // An agent file an older roles install generated (safety-shadow, retired in roles 0.3.0), recorded by that sync.
  const stale = join(agentsDir(home), 'safety-shadow.toml');
  const staleText = `${GENERATED_MARK}0.2.0\nname = "safety-shadow"\ndescription = "retired"\n`;
  writeFileSync(stale, staleText);
  const m = readManifest(home);
  m.harnesses.codex.files.push({ path: stale, sha256: 'recorded-by-an-older-sync', backup: null });
  writeManifest(home, m);
  // A file without our mark under a role-like name we do not ship: never touched.
  const theirs = join(agentsDir(home), 'old-role.toml');
  const theirsText = '# hand-written\nname = "old-role"\n';
  writeFileSync(theirs, theirsText);

  const { steps } = await syncCodex(home, fakeRun(home));
  const step = stepOf(steps, 'codex-agents');
  assert.equal(step.status, 'done', step.detail);
  assert.match(step.detail, /removed 1 agent no longer shipped/);
  assert.equal(existsSync(stale), false, 'the retired role\'s agent is still there');
  assert.equal(readFileSync(join(backupDirFor(home, NOW), 'codex', 'safety-shadow.toml'), 'utf8'), staleText);
  assert.equal(readFileSync(theirs, 'utf8'), theirsText);
  for (const [file, text] of Object.entries(MACHINE_FILES)) assert.equal(readFileSync(join(agentsDir(home), file), 'utf8'), text, file);
  assert.equal(readManifest(home).harnesses.codex.files.some((f) => f.path === stale), false, 'the manifest still lists it');
  for (const name of ROLE_NAMES) assert.ok(existsSync(join(agentsDir(home), `${name}.toml`)), name);
  // A third sync has nothing left to remove.
  const again = stepOf((await syncCodex(home, fakeRun(home))).steps, 'codex-agents');
  assert.equal(again.status, 'already', again.detail);
}));

test('refreshHarness upgrades inherited-model agents even when role sources are unchanged', () => withHome({}, async (home) => {
  await syncCodex(home, fakeRun(home));
  const beforeSha = readManifest(home).harnesses.codex.rolesSha;
  const file = join(agentsDir(home), 'brief-writer.toml');
  const legacy = readFileSync(file, 'utf8').replace(/^model = .*\n/m, '');
  writeFileSync(file, legacy);
  assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: true });
  assert.match(readFileSync(file, 'utf8'), /^model = "gpt-6-luna"$/m);
  assert.equal(readManifest(home).harnesses.codex.rolesSha, beforeSha);
  assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: false });
}));

test('parallel refreshHarness loses no manifest records', () => withHome({}, async (home, { installs }) => {
  await syncCodex(home, fakeRun(home));
  const next = { ...installs, methodology: { installPath: installMethodology(home, '0.3.1'), version: '0.3.1' } };
  writeInstalled(home, next);
  const results = await Promise.all([refreshHarness({ home, id: 'codex' }), refreshHarness({ home, id: 'codex' })]);
  assert.deepEqual(results.map((x) => x.changed).sort(), [false, true]);
  const links = readManifest(home).harnesses.codex.links;
  const paths = links.map((l) => l.path);
  assert.equal(new Set(paths).size, paths.length, 'each link recorded once');
  assert.equal(links.length, OURS.length + NO_CLASH.length);
  for (const name of METHODOLOGY_SKILLS) {
    assert.equal(links.find((l) => l.path === join(skillsDir(home), name)).target, join(next.methodology.installPath, 'skills', name));
  }
  // In-process calls serialize anyway (the work is synchronous), so two processes race for the lock too.
  const third = { ...next, methodology: { installPath: installMethodology(home, '0.3.2'), version: '0.3.2' } };
  writeInstalled(home, third);
  const { XDG_CONFIG_HOME: _, ...env } = process.env;
  const script = `import(${JSON.stringify(join(PLUGIN_ROOT, 'cli', 'lib', 'harness-sync.mjs'))})`
    + `.then((m) => m.refreshHarness({ home: process.env.HOME, id: 'codex' }))`
    + '.then((r) => process.stdout.write(JSON.stringify(r)))';
  const child = () => new Promise((resolveChild) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, HOME: home } });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    c.on('exit', (code) => resolveChild({ code, out }));
  });
  const outs = await Promise.all([child(), child()]);
  assert.deepEqual(outs.map((o) => o.code), [0, 0], JSON.stringify(outs));
  assert.deepEqual(outs.map((o) => JSON.parse(o.out).changed).sort(), [false, true], JSON.stringify(outs));
  const final = readManifest(home).harnesses.codex.links;
  assert.equal(new Set(final.map((l) => l.path)).size, final.length);
  assert.equal(final.length, OURS.length + NO_CLASH.length);
  for (const name of METHODOLOGY_SKILLS) {
    assert.equal(final.find((l) => l.path === join(skillsDir(home), name)).target, join(third.methodology.installPath, 'skills', name));
  }
}));

test('a held manifest lock: refreshHarness changes nothing and syncHarness fails the step', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const holder = withLock(manifestFile(home), () => held);
  try {
    assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: false });
    assert.equal(existsSync(join(skillsDir(home), 'using-methodology')), false);
    const { steps } = await syncCodex(home, r, { lockWaitMs: 50 });
    assert.equal(stepOf(steps, 'codex-skills').status, 'failed');
    assert.match(stepOf(steps, 'codex-skills').detail, /harnesses\.json is locked/);
  } finally {
    release();
    await holder;
  }
}));

const NOT_RECORDED = 'the change was made but not recorded in harnesses.json (another triqual sync or harness session held it), '
  + 'so triqual sync --remove-harness will not undo it: undo it by hand, or record it in harnesses.json by hand';

test('a held manifest lock: config.toml is not edited, and a CLI change is reported as not recorded', async () => {
  const holding = async (home, fn) => {
    let release;
    const holder = withLock(manifestFile(home), () => new Promise((resolve) => { release = resolve; }));
    try {
      await fn();
    } finally {
      release();
      await holder;
    }
  };
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    const config = readFileSync(codexConfig(home));
    await holding(home, async () => {
      const { steps } = await syncCodex(home, r, { lockWaitMs: 50, lockRetryWaitMs: 50 });
      for (const id of ['codex-config', 'codex-supersedes']) {
        assert.equal(stepOf(steps, id).status, 'failed', id);
        assert.match(stepOf(steps, id).detail, /harnesses\.json is locked/, id);
      }
      assert.ok(readFileSync(codexConfig(home)).equals(config), 'config.toml untouched');
      const plugin = stepOf(steps, 'codex-plugin');
      assert.equal(plugin.status, 'failed');
      assert.ok(plugin.detail.startsWith(NOT_RECORDED), plugin.detail);
      assert.ok(r.calls.includes(`codex plugin add ${BRIDGE}`), 'the change was made');
      assert.equal(existsSync(manifestFile(home)), false);
    });
  });
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    await holding(home, async () => {
      const plugins = stepOf((await syncGrok(home, r, { lockWaitMs: 50, lockRetryWaitMs: 50 })).steps, 'grok-plugins');
      assert.equal(plugins.status, 'failed');
      assert.ok(plugins.detail.startsWith(NOT_RECORDED), plugins.detail);
      assert.doesNotMatch(plugins.detail, /enabled =|\[plugins/, 'no config content');
      assert.equal(r.calls.filter((c) => c.startsWith('grok plugin uninstall')).length, GROK_STALE.length);
      assert.equal(existsSync(manifestFile(home)), false);
    });
  });
});

test('a CLI step retries its record with a longer wait and records once the lock is free', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  let release;
  const holder = withLock(manifestFile(home), () => new Promise((resolve) => { release = resolve; }));
  const run = async (cmd, args, opts) => {
    const out = await r.run(cmd, args, opts);
    if (cmd === 'codex' && args.join(' ') === `plugin add ${BRIDGE}`) setTimeout(release, 150);
    return out;
  };
  try {
    const { steps } = await syncHarness({ home, id: 'codex', run, now: NOW, lockWaitMs: 50, lockRetryWaitMs: 5000 });
    assert.equal(stepOf(steps, 'codex-plugin').status, 'done', stepOf(steps, 'codex-plugin').detail);
    assert.deepEqual(readManifest(home).harnesses.codex.plugins, [
      { id: MARKET, action: 'marketplace-added' },
      { id: BRIDGE, action: 'added' },
    ]);
  } finally {
    release();
    await holder;
  }
}));

test('every CLI call made under the manifest lock is bounded below the lock stale age', () => withHome({}, async (home) => {
  assert.ok(VALIDATE_TIMEOUT_MS < LOCK_STALE_MS, `${VALIDATE_TIMEOUT_MS} < ${LOCK_STALE_MS}`);
  const r = fakeRun(home);
  const underLock = [];
  const run = async (cmd, args, opts) => {
    if (existsSync(`${manifestFile(home)}.lock`)) underLock.push({ call: `${cmd} ${args.join(' ')}`, timeoutMs: opts.timeoutMs });
    return r.run(cmd, args, opts);
  };
  const { steps } = await syncHarness({ home, id: 'codex', run, now: NOW });
  assert.equal(stepOf(steps, 'codex-config').status, 'done');
  assert.equal(stepOf(steps, 'codex-supersedes').status, 'done');
  assert.ok(underLock.length >= 2, JSON.stringify(underLock));
  for (const c of underLock) assert.deepEqual(c, { call: 'codex features list', timeoutMs: VALIDATE_TIMEOUT_MS });
  // The removal's config reverts validate under the lock too.
  underLock.length = 0;
  await removeHarness({ home, id: 'codex', run, now: LATER });
  assert.ok(underLock.length >= 1, JSON.stringify(underLock));
  for (const c of underLock) assert.deepEqual(c, { call: 'codex features list', timeoutMs: VALIDATE_TIMEOUT_MS });
}));

test('the detached background entry of hook.mjs refreshes the Codex links',() => withHome({}, async (home, { installs }) => {
  await syncCodex(home, fakeRun(home));
  const next = { ...installs, methodology: { installPath: installMethodology(home, '0.3.1'), version: '0.3.1' } };
  writeInstalled(home, next);
  const { XDG_CONFIG_HOME: _, ...env } = process.env;
  const child = spawnSync(process.execPath, [HOOK, 'background', '--harness', 'codex'], { env: { ...env, HOME: home }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(readlinkSync(join(skillsDir(home), 'brainstorming')), join(next.methodology.installPath, 'skills', 'brainstorming'));
}));

test('a Codex session with harnesses.codex.enabled false recreates nothing', () => withHome({}, async (home) => {
  await syncCodex(home, fakeRun(home));
  // What --remove-harness leaves when the bridge outlives it: no links, no agents, no manifest, enabled false.
  rmSync(skillsDir(home), { recursive: true, force: true });
  for (const f of readdirSync(agentsDir(home))) {
    if (readFileSync(join(agentsDir(home), f), 'utf8').startsWith(GENERATED_MARK)) rmSync(join(agentsDir(home), f));
  }
  rmSync(manifestFile(home));
  setConfig(home, { harnesses: { codex: { enabled: false } } });
  const agentsBefore = readdirSync(agentsDir(home)).sort();
  assert.deepEqual(await refreshHarness({ home, id: 'codex' }), { changed: false });
  const { XDG_CONFIG_HOME: _, ...env } = process.env;
  const child = spawnSync(process.execPath, [HOOK, 'background', '--harness', 'codex'], { env: { ...env, HOME: home }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(skillsDir(home)), false, 'no link re-created');
  assert.deepEqual(readdirSync(agentsDir(home)).sort(), agentsBefore, 'no agent re-created');
  assert.equal(existsSync(manifestFile(home)), false, 'no manifest entry re-added');
}));

// ---- Grok ----

test('grok step ids', () => withHome({}, async (home) => {
  const { steps } = await syncGrok(home, fakeRun(home));
  assert.deepEqual(steps.map((s) => s.id), ['grok-plugins', 'grok-rules', 'grok-hooks']);
  assert.deepEqual(steps.filter((s) => s.status !== 'done'), [], JSON.stringify(steps, null, 1));
  assert.equal(existsSync(join(home, '.grok', 'skills')), false);
  assert.equal(existsSync(join(home, '.grok', 'agents')), false);
}));

test('grok hooks file has exactly three events', () => withHome({}, async (home) => {
  const launcherPath = join(home, '.local', 'bin', BRAND.launcher);
  await syncGrok(home, fakeRun(home), { launcherPath });
  const file = readJson(grokHooks(home));
  assert.deepEqual(Object.keys(file), ['hooks']);
  assert.deepEqual(Object.keys(file.hooks), ['PreToolUse', 'PostToolUse', 'PostCompact']);
  const events = { PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', PostCompact: 'post-compact' };
  for (const [name, event] of Object.entries(events)) {
    assert.deepEqual(file.hooks[name], [{
      hooks: [{ type: 'command', command: `${launcherPath} ${event} --harness grok`, timeout: HOOK_TIMEOUTS.grok[event] }],
    }], name);
  }
}));

test('grok-plugins uninstalls and records', async () => {
  await withHome({}, async (home) => {
    const r = fakeRun(home);
    const listed = r.state.grok.slice();
    const { steps } = await syncGrok(home, r);
    const step = stepOf(steps, 'grok-plugins');
    assert.equal(step.status, 'done');
    const uninstalls = r.calls.filter((c) => c.startsWith('grok plugin uninstall'));
    assert.deepEqual(uninstalls, GROK_STALE.map(([n]) => `grok plugin uninstall ${n}`));
    assert.equal(r.calls.filter((c) => c === 'grok plugin list --json').length, 2, 'listed, then absence checked');
    const plugins = readManifest(home).harnesses.grok.plugins;
    const backupRoot = join(backupDirFor(home, NOW), 'grok');
    assert.deepEqual(plugins, GROK_STALE.map(([name]) => {
      const entry = listed.find((p) => p.name === name);
      return { name, source: entry.source, version: entry.version, backup: join(backupRoot, entry.repo_key), action: 'uninstalled' };
    }));
    for (const { backup, name } of plugins) {
      assert.deepEqual(readJson(join(backup, '.claude-plugin', 'plugin.json')), { name, version: GROK_STALE.find(([n]) => n === name)[1] });
      assert.equal(statSync(dirname(backup)).mode & 0o777, 0o700);
    }
    assert.ok(existsSync(grokEntry(home, 'claude-mem', '13.0.0').path), 'other plugins are left alone');
  });
  // A plugin still listed after its uninstall fails the step and is not recorded.
  await withHome({}, async (home) => {
    const r = fakeRun(home, { uninstallIgnored: ['workflow-gate'] });
    const { steps } = await syncGrok(home, r);
    const step = stepOf(steps, 'grok-plugins');
    assert.equal(step.status, 'failed');
    assert.match(step.detail, /workflow-gate is still installed/);
    assert.deepEqual(readManifest(home).harnesses.grok.plugins.map((p) => p.name), ['methodology', 'progress-tracking', 'roles', 'superpowers']);
  });
  // A methodology entry outside ~/.grok/installed-plugins/ is not uninstalled.
  await withHome({}, async (home) => {
    const outside = grokEntry(home, 'methodology', '0.1.2', join(home, 'elsewhere'));
    write(join(outside.path, 'plugin.json'), '{}');
    const r = fakeRun(home, { grokList: [outside] });
    const { steps } = await syncGrok(home, r);
    assert.equal(stepOf(steps, 'grok-plugins').status, 'already');
    assert.equal(r.calls.some((c) => c.startsWith('grok plugin uninstall')), false);
    assert.ok(existsSync(outside.path));
  });
});

test('grok sync writes the hooks file with the launcher path and the rules file, creates no link under ~/.grok/skills, uninstalls the stale plugins, and never opens ~/.grok/config.toml', () => withHome({}, async (home, { installs }) => {
  mkdirSync(join(home, '.grok', 'config.toml'));
  const r = fakeRun(home);
  const { steps } = await syncHarness({ home, id: 'grok', run: r.run, now: NOW });
  assert.deepEqual(statusOf(steps), { 'grok-plugins': 'done', 'grok-rules': 'done', 'grok-hooks': 'done' });
  const launcher = join(home, '.local', 'bin', BRAND.launcher);
  const hooks = readJson(grokHooks(home));
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, `${launcher} pre-tool-use --harness grok`, 'the default launcher path');
  const rulesPath = grokRules(home);
  assert.equal(readFileSync(rulesPath, 'utf8'), expectedRules(installs.methodology.installPath, 'grok'));
  assert.equal(existsSync(join(home, '.grok', 'skills')), false);
  assert.equal(r.calls.filter((c) => c.startsWith('grok plugin uninstall')).length, GROK_STALE.length);
  assert.ok(statSync(join(home, '.grok', 'config.toml')).isDirectory());
  assert.deepEqual(readdirSync(join(home, '.grok', 'config.toml')), []);
  const m = readManifest(home).harnesses.grok;
  assert.deepEqual(m.files.map((f) => f.path), [rulesPath, grokHooks(home)]);
  assert.equal(m.files.every((f) => f.backup === null), true);
  // A second sync: every step already, manifest bytes unchanged.
  const bytes = readFileSync(manifestFile(home));
  assert.deepEqual(statusOf((await syncGrok(home, r, { now: LATER })).steps), { 'grok-plugins': 'already', 'grok-rules': 'already', 'grok-hooks': 'already' });
  assert.ok(readFileSync(manifestFile(home)).equals(bytes));
}));

test('grok sync writes triqual.json, removes the legacy file with a backup, and forgets its record', () => withHome({}, async (home, { installs }) => {
  // What a pre-rename sync left: both files under the legacy name, recorded as ours.
  const { legacyRules, legacyHooksFile } = harnessPaths(home, 'grok');
  const oldRules = expectedRules(installs.methodology.installPath, 'grok');
  const oldHooks = grokHooksFile(join(home, '.local', 'bin', BRAND.legacy.launcher));
  write(legacyRules, oldRules);
  write(legacyHooksFile, oldHooks);
  const files = [legacyRules, legacyHooksFile].map((path) => ({ path, sha256: sha(readFileSync(path)), backup: null }));
  writeManifest(home, { version: 1, harnesses: { grok: { links: [], files, rolesSha: null, rules: null, config: [], plugins: [] } } });
  const { steps } = await syncGrok(home, fakeRun(home));
  const dir = join(backupDirFor(home, NOW), 'grok');
  for (const [id, legacy, current] of [['grok-rules', legacyRules, grokRules(home)], ['grok-hooks', legacyHooksFile, grokHooks(home)]]) {
    const s = stepOf(steps, id);
    assert.equal(s.status, 'done', s.detail);
    assert.ok(s.detail.includes(`wrote ${current}`), s.detail);
    assert.ok(s.detail.includes(`removed ${legacy} (backup ${join(dir, basename(legacy))})`), s.detail);
    assert.equal(existsSync(legacy), false, legacy);
  }
  assert.equal(readFileSync(join(dir, basename(legacyRules)), 'utf8'), oldRules);
  assert.equal(readFileSync(join(dir, basename(legacyHooksFile)), 'utf8'), oldHooks);
  assert.equal(readFileSync(grokRules(home), 'utf8'), oldRules);
  assert.equal(readFileSync(grokHooks(home), 'utf8'), grokHooksFile(join(home, '.local', 'bin', BRAND.launcher)));
  assert.deepEqual(readManifest(home).harnesses.grok.files, [
    { path: grokRules(home), sha256: sha(oldRules), backup: null },
    { path: grokHooks(home), sha256: sha(readFileSync(grokHooks(home))), backup: null },
  ]);
  // A second sync: nothing left to remove, every file step already.
  const again = await syncGrok(home, fakeRun(home), { now: LATER });
  assert.deepEqual([stepOf(again.steps, 'grok-rules').status, stepOf(again.steps, 'grok-hooks').status], ['already', 'already']);
}));

test('a dropped legacy Grok record hands its pre-sync backup to the new file, so --remove-harness restores the original', () => withHome({}, async (home, { installs }) => {
  // The first pre-rename sync replaced the user's own rules file: its record keeps that backup.
  const { legacyRules } = harnessPaths(home, 'grok');
  const oldRules = expectedRules(installs.methodology.installPath, 'grok');
  write(legacyRules, oldRules);
  const original = join(backupsRoot(home), `${BRAND.legacy.dir}-20260901-100000`, 'grok', basename(legacyRules));
  write(original, '# my own grok rules\n');
  const files = [{ path: legacyRules, sha256: sha(oldRules), backup: original }];
  writeManifest(home, { version: 1, harnesses: { grok: { links: [], files, rolesSha: null, rules: null, config: [], plugins: [] } } });
  await syncGrok(home, fakeRun(home));
  assert.equal(existsSync(legacyRules), false);
  const rec = readManifest(home).harnesses.grok.files.find((f) => f.path === grokRules(home));
  assert.deepEqual(rec, { path: grokRules(home), sha256: sha(oldRules), backup: original });
  const { steps } = await removeHarness({ home, id: 'grok', run: fakeRun(home).run, now: LATER });
  assert.equal(stepOf(steps, 'grok-rules').status, 'done', stepOf(steps, 'grok-rules').detail);
  assert.equal(readFileSync(grokRules(home), 'utf8'), '# my own grok rules\n');
}));

test('a legacy Grok file sync did not record is backed up and removed too, and so is one while methodology is disabled', () => withHome({}, async (home) => {
  const { legacyRules, legacyHooksFile } = harnessPaths(home, 'grok');
  write(legacyRules, 'hand-made\n');
  write(legacyHooksFile, '{"hooks":{}}\n');
  setEnabled(home, { methodology: false });
  const { steps } = await syncGrok(home, fakeRun(home));
  const dir = join(backupDirFor(home, NOW), 'grok');
  const rules = stepOf(steps, 'grok-rules');
  assert.equal(rules.status, 'done', rules.detail);
  assert.match(rules.detail, /methodology is disabled in Claude: no rules file of ours/);
  assert.ok(rules.detail.includes(`removed ${legacyRules}`), rules.detail);
  assert.equal(existsSync(legacyRules), false);
  assert.equal(existsSync(legacyHooksFile), false);
  assert.equal(readFileSync(join(dir, basename(legacyRules)), 'utf8'), 'hand-made\n');
  assert.equal(readFileSync(join(dir, basename(legacyHooksFile)), 'utf8'), '{"hooks":{}}\n');
  assert.deepEqual(readManifest(home).harnesses.grok.files.map((f) => f.path), [grokHooks(home)]);
}));

test('an existing Grok rules or hooks file we did not write is backed up first', () => withHome({}, async (home) => {
  const rulesPath = grokRules(home);
  const hooksPath = grokHooks(home);
  write(rulesPath, 'old rules\n');
  write(hooksPath, '{"hooks":{}}\n');
  await syncGrok(home, fakeRun(home));
  const dir = join(backupDirFor(home, NOW), 'grok');
  assert.equal(readFileSync(join(dir, `${BRAND.grokName}.md`), 'utf8'), 'old rules\n');
  assert.equal(readFileSync(join(dir, `${BRAND.grokName}.json`), 'utf8'), '{"hooks":{}}\n');
  assert.deepEqual(readManifest(home).harnesses.grok.files.map((f) => f.backup), [join(dir, `${BRAND.grokName}.md`), join(dir, `${BRAND.grokName}.json`)]);
}));

test('Grok plugin backups are private: files 0600, directories 0700', () => withHome({}, async (home) => {
  const src = grokEntry(home, 'methodology', '0.1.2').path;
  write(join(src, 'bin', 'run.sh'), '#!/bin/sh\n', 0o755);
  chmodSync(join(src, 'bin'), 0o755);
  chmodSync(join(src, '.claude-plugin', 'plugin.json'), 0o644);
  const { steps } = await syncGrok(home, fakeRun(home));
  assert.equal(stepOf(steps, 'grok-plugins').status, 'done');
  const backup = join(backupDirFor(home, NOW), 'grok', 'methodology-1a2b3c4d');
  assert.equal(readFileSync(join(backup, 'bin', 'run.sh'), 'utf8'), '#!/bin/sh\n');
  const modes = {};
  const walk = (d) => {
    modes[relative(backup, d) || '.'] = statSync(d).mode & 0o777;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else modes[relative(backup, join(d, e.name))] = statSync(join(d, e.name)).mode & 0o777;
    }
  };
  walk(backup);
  assert.deepEqual(modes, {
    '.': 0o700, '.claude-plugin': 0o700, '.claude-plugin/plugin.json': 0o600, bin: 0o700, 'bin/run.sh': 0o600,
  });
}));

test('a Grok plugin path that resolves outside ~/.grok/installed-plugins, or not at all, is left alone and reported', () => withHome({}, async (home) => {
  const outside = join(home, 'elsewhere', 'roles-real');
  write(join(outside, 'plugin.json'), '{}');
  const base = join(home, '.grok', 'installed-plugins');
  const link = join(base, 'roles-link');
  symlinkSync(outside, link);
  const listed = [
    { ...grokEntry(home, 'roles', '0.1.0'), path: link },
    { ...grokEntry(home, 'workflow-gate', '0.1.0'), path: join(base, 'missing') },
  ];
  const r = fakeRun(home, { grokList: listed });
  const s = stepOf((await syncGrok(home, r)).steps, 'grok-plugins');
  assert.equal(s.status, 'already', s.detail);
  assert.match(s.detail, /left alone: roles \(resolves outside [^)]*installed-plugins\), workflow-gate \(path cannot be resolved\)/);
  assert.equal(r.calls.some((c) => c.startsWith('grok plugin uninstall')), false);
  assert.ok(existsSync(join(outside, 'plugin.json')));
  assert.equal(existsSync(join(backupDirFor(home, NOW), 'grok')), false, 'nothing backed up');
}));

test('a grok plugin uninstall that exits non-zero fails the step and is not recorded', () => withHome({}, async (home) => {
  const r = fakeRun(home, { uninstallFail: ['roles'] });
  const s = stepOf((await syncGrok(home, r)).steps, 'grok-plugins');
  assert.equal(s.status, 'failed');
  assert.match(s.detail, /grok plugin uninstall roles exited 1: cannot uninstall roles/);
  assert.deepEqual(readManifest(home).harnesses.grok.plugins.map((p) => p.name),
    ['methodology', 'progress-tracking', 'workflow-gate', 'superpowers']);
}));

test('a launcher path with spaces is one quoted shell word in the Grok hooks file', () => withHome({}, async (home) => {
  const launcherPath = join(home, 'My Tools', 'triqual-hook');
  await syncGrok(home, fakeRun(home), { launcherPath });
  const file = readJson(grokHooks(home));
  assert.equal(file.hooks.PreToolUse[0].hooks[0].command, `'${launcherPath}' pre-tool-use --harness grok`);
  assert.equal(file.hooks.PostCompact[0].hooks[0].command, `'${launcherPath}' post-compact --harness grok`);
}));

test('the Grok rules file follows methodology enabled in Claude; the hooks file stays', () => withHome({}, async (home, { installs }) => {
  const r = fakeRun(home);
  await syncGrok(home, r);
  const rulesPath = grokRules(home);
  const hooksPath = grokHooks(home);
  const hooks = readFileSync(hooksPath);
  setEnabled(home, { methodology: false });
  let steps = (await syncGrok(home, r, { now: LATER })).steps;
  assert.equal(stepOf(steps, 'grok-rules').status, 'done');
  assert.match(stepOf(steps, 'grok-rules').detail, /methodology is disabled in Claude: removed /);
  assert.equal(existsSync(rulesPath), false);
  assert.ok(readFileSync(hooksPath).equals(hooks), 'the hooks file stays');
  assert.deepEqual(readManifest(home).harnesses.grok.files.map((f) => f.path), [hooksPath]);
  assert.equal(stepOf((await syncGrok(home, r, { now: LATER })).steps, 'grok-rules').status, 'already');
  // Re-enabled: written again.
  setEnabled(home);
  steps = (await syncGrok(home, r, { now: LATER })).steps;
  assert.equal(stepOf(steps, 'grok-rules').status, 'done');
  assert.equal(readFileSync(rulesPath, 'utf8'), expectedRules(installs.methodology.installPath, 'grok'));
  assert.ok(readManifest(home).harnesses.grok.files.some((f) => f.path === rulesPath));
  // A rules file changed since we wrote it is left alone while disabled.
  writeFileSync(rulesPath, 'my rules\n');
  setEnabled(home, { methodology: false });
  steps = (await syncGrok(home, r, { now: LATER })).steps;
  assert.equal(stepOf(steps, 'grok-rules').status, 'skipped');
  assert.match(stepOf(steps, 'grok-rules').detail, /changed since triqual sync wrote it, left alone/);
  assert.equal(readFileSync(rulesPath, 'utf8'), 'my rules\n');
}));

// ---- both ----

test('absent harness → one skipped step', async () => {
  await withHome({ codex: false, grok: false }, async (home) => {
    for (const id of ['codex', 'grok']) {
      const r = fakeRun(home, { versionCode: 127 });
      const before = snapshot(home);
      assert.deepEqual(await syncHarness({ home, id, run: r.run, now: NOW }), { steps: [{ id, status: 'skipped', detail: 'not installed' }] });
      assert.deepEqual(snapshot(home), before, `${id}: nothing written`);
      assert.equal(r.calls.some((c) => !c.endsWith('--version')), false, r.calls.join('\n'));
    }
  });
});

test('triqual sync --harness <absent id> prints only the skipped line and records nothing in config.json', async () => {
  // No config.json at all, then one that records something else: both stay as they were (absent, byte-identical).
  for (const config of [undefined, { keepSuperseded: false, harnesses: { grok: { enabled: false } } }]) {
    await withHome({ codex: false, grok: false, config }, async (home) => {
      const path = join(home, '.config', 'triqual', 'config.json');
      const before = existsSync(path) ? readFileSync(path) : null;
      for (const id of ['codex', 'grok']) {
        const out = await syncCli(['--harness', id], { home, pluginRoot: PLUGIN_ROOT, run: fakeRun(home, { versionCode: 127 }).run, now: NOW });
        assert.equal(out.code, 0, out.stdout);
        assert.equal(out.stdout, `${id}: skipped — not installed\n`);
        if (before === null) assert.equal(existsSync(path), false, `${id}: no config.json written`);
        else assert.ok(readFileSync(path).equals(before), `${id}: config.json byte-identical`);
      }
    });
  }
});

test('keepSuperseded leaves superpowers alone in both harnesses', () => withHome({ config: { keepSuperseded: true } }, async (home) => {
  const r = fakeRun(home);
  const codex = await syncCodex(home, r);
  assert.equal(stepOf(codex.steps, 'codex-supersedes').status, 'already');
  assert.match(stepOf(codex.steps, 'codex-supersedes').detail, /keepSuperseded/);
  assert.doesNotMatch(readFileSync(codexConfig(home), 'utf8'), /superpowers@openai-curated-remote/);
  assert.equal(readManifest(home).harnesses.codex.config.some((c) => c.table === SUPERPOWERS_TABLE), false);
  const grok = await syncGrok(home, r);
  assert.equal(stepOf(grok.steps, 'grok-plugins').status, 'done');
  assert.match(stepOf(grok.steps, 'grok-plugins').detail, /superpowers kept \(keepSuperseded\)/);
  assert.equal(r.calls.includes('grok plugin uninstall superpowers'), false);
  assert.equal(r.calls.filter((c) => c.startsWith('grok plugin uninstall')).length, 4);
  assert.ok(existsSync(grokEntry(home, 'superpowers', '6.3.0').path));
}));

test('an unreadable config.json fails the supersedes steps and keeps superseded links', () => withHome({}, async (home) => {
  write(join(home, '.config', 'triqual', 'config.json'), '{ nope');
  const r = fakeRun(home);
  const codex = await syncCodex(home, r);
  assert.deepEqual(stepOf(codex.steps, 'codex-supersedes'),
    { id: 'codex-supersedes', status: 'failed', detail: 'config.json unreadable — fix it or remove it' });
  for (const name of NO_CLASH) assert.equal(readlinkSync(join(skillsDir(home), name)), superpowersTarget(home, name));
  const grok = await syncGrok(home, r);
  assert.equal(stepOf(grok.steps, 'grok-plugins').status, 'failed');
  assert.equal(r.calls.some((c) => c.startsWith('grok plugin uninstall')), false);
}));

// ---- triqual sync ----

test('triqual sync --harness runs only the named harnesses, with no Claude steps', () => withHome({}, async (home) => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const r = fakeRun(home);
  const out = await syncCli(['--harness', 'grok'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: NOW });
  assert.equal(out.code, 0, out.stdout);
  assert.deepEqual(out.stdout.trimEnd().split('\n').map((l) => l.split(':')[0]),
    ['grok-enabled', 'grok-plugins', 'grok-rules', 'grok-hooks']);
  assert.match(out.stdout, /^grok-hooks: done — /m);
  assert.equal(existsSync(join(home, '.claude', 'CLAUDE.md')), false, 'no Claude rules step');
  const both = await syncCli(['--harness', 'codex', '--harness', 'grok', '--yes'], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
  const ids = both.stdout.trimEnd().split('\n').map((l) => l.split(':')[0]);
  assert.deepEqual(ids, ['codex-enabled', ...CODEX_STEPS, 'grok-enabled', 'grok-plugins', 'grok-rules', 'grok-hooks']);
  assert.match(both.stdout, /^grok-enabled: already — /m);
  assert.deepEqual(readJson(join(home, '.config', 'triqual', 'config.json')).harnesses,
    { grok: { enabled: true }, codex: { enabled: true } });
}));

test('triqual sync with no arguments runs the Claude steps, then every enabled harness', () => withHome({}, async (home) => {
  const r = fakeRun(home);
  let out = await syncCli([], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: NOW });
  assert.deepEqual(out.stdout.trimEnd().split('\n').map((l) => l.split(':')[0]), ['rules-gate', 'rules', 'supersedes']);
  assert.deepEqual(r.calls, [], 'no harness enabled: no CLI call');
  setConfig(home, { harnesses: { grok: { enabled: true }, codex: { enabled: false } } });
  out = await syncCli([], { home, pluginRoot: PLUGIN_ROOT, run: r.run, now: LATER });
  assert.deepEqual(out.stdout.trimEnd().split('\n').map((l) => l.split(':')[0]),
    ['rules-gate', 'rules', 'supersedes', 'grok-plugins', 'grok-rules', 'grok-hooks']);
  assert.equal(out.code, 0, out.stdout);
  // A failed harness step exits 1.
  const failing = await syncCli(['--harness', 'grok'], { home, pluginRoot: PLUGIN_ROOT, run: async () => ({ code: 1, stdout: '', stderr: '' }), now: LATER });
  assert.equal(failing.code, 1);
}));

test('the triqual sync CLI entry prints a triqual sync: line and exits 1 when a dependency throws', async () => {
  const out = { stdout: '', stderr: '', code: null };
  const io = {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    exit: (code) => { out.code = code; },
  };
  await runCli([], {}, { ...io, cli: async () => { throw new Error('boom'); } });
  assert.deepEqual(out, { stdout: '', stderr: 'triqual sync: boom\n', code: 1 });
  const ok = { stdout: '', stderr: '', code: null };
  await runCli(['--help'], { home: '/nonexistent' }, {
    stdout: { write: (s) => { ok.stdout += s; } }, stderr: { write: (s) => { ok.stderr += s; } }, exit: (c) => { ok.code = c; },
  });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^usage: triqual sync/);
});
