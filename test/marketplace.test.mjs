import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, HOOK_TIMEOUTS } from '../plugins/methodology/cli/lib/harnesses.mjs';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

// The Codex bridge: listed only in the Codex marketplace, never in the Claude one (spec F.2).
const BRIDGE = 'methodology-codex';
const CODEX_MARKETPLACE = '.agents/plugins/marketplace.json';
const BRIDGE_HOOKS = `plugins/${BRIDGE}/hooks/hooks.json`;

// FROZEN: the sha256 of the bridge's hooks/hooks.json. Codex keys hook trust on this file, so any change to it is a
// breaking release the user must re-approve in Codex (spec F.2), and the bridge's version moves only then. Do not
// update this pin to make a test pass. Last moved by bridge 0.2.0, which runs ~/.local/bin/triqual-hook.
const BRIDGE_HOOKS_SHA256 = '30a8ddb402feb1a736e0478680513e5ef75fb9a71db98ba9df43379e1e470643';

// An external entry points at a git repository instead of a plugins/<name> dir. Headjack is the only one we list.
const EXTERNAL_NAME = 'headjack';
const isExternal = (entry) => typeof entry.source === 'object' && entry.source !== null;

// What is wrong with an external marketplace entry; an empty list means it is fine.
function externalProblems(entry) {
  const problems = [];
  if (!['url', 'git-subdir'].includes(entry.source?.source)) problems.push(`source.source is ${entry.source?.source}, not url or git-subdir`);
  if (!/^https:\/\//.test(entry.source?.url ?? '')) problems.push(`source.url ${entry.source?.url} is not an https URL`);
  if ('version' in entry) problems.push('an external entry carries no version: users see the version of its own plugin.json');
  if (entry.name !== EXTERNAL_NAME) problems.push(`name ${entry.name} is not ${EXTERNAL_NAME}`);
  return problems;
}

// The plugins/* dirs a marketplace under `root` fails to list: the bridge must be in the Codex marketplace, every
// other dir in the Claude one.
function unlistedPluginDirs(root) {
  const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
  const claude = read('.claude-plugin/marketplace.json').plugins.map((p) => p.name);
  const codex = read(CODEX_MARKETPLACE).plugins.map((p) => p.name);
  const dirs = readdirSync(join(root, 'plugins')).filter((d) => statSync(join(root, 'plugins', d)).isDirectory());
  return dirs.filter((dir) => !(dir === BRIDGE ? codex : claude).includes(dir));
}

// A temp root holding both marketplace files and an empty dir per plugins/* entry, plus `extraDirs`.
function withMarketplaceCopy(extraDirs, fn) {
  const root = mkdtempSync(join(tmpdir(), 'cm-marketplace-'));
  try {
    for (const rel of ['.claude-plugin/marketplace.json', CODEX_MARKETPLACE]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(ROOT, rel), join(root, rel));
    }
    const dirs = readdirSync(join(ROOT, 'plugins')).filter((d) => statSync(join(ROOT, 'plugins', d)).isDirectory());
    for (const dir of [...dirs, ...extraDirs]) mkdirSync(join(root, 'plugins', dir), { recursive: true });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('codex marketplace lists only the bridge', () => {
  const marketplace = readJson(CODEX_MARKETPLACE);
  assert.equal(marketplace.name, BRAND.marketplace);
  assert.deepEqual(marketplace.interface, { displayName: BRAND.marketplace });
  assert.deepEqual(marketplace.plugins, [{
    name: BRIDGE,
    source: { source: 'local', path: `./plugins/${BRIDGE}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }]);
});

test('the Claude marketplace does not list methodology-codex', () => {
  const listed = readJson('.claude-plugin/marketplace.json').plugins.map((p) => p.name);
  assert.ok(!listed.includes(BRIDGE), `${BRIDGE} is not in the Claude marketplace`);
});

test('every plugins/* dir is listed in a marketplace', () => {
  assert.ok(existsSync(join(ROOT, 'plugins', BRIDGE)), `plugins/${BRIDGE} exists`);
  assert.deepEqual(unlistedPluginDirs(ROOT), []);
  withMarketplaceCopy(['unlisted-extra'], (root) => {
    assert.deepEqual(unlistedPluginDirs(root), ['unlisted-extra'], 'an unlisted extra dir still fails');
  });
});

test('bridge hooks are frozen', () => {
  const sha = createHash('sha256').update(readFileSync(join(ROOT, BRIDGE_HOOKS))).digest('hex');
  assert.equal(sha, BRIDGE_HOOKS_SHA256, `${BRIDGE_HOOKS} changed: that is a breaking release (see the pin comment)`);
});

test('bridge has exactly two handlers with the F.2 commands', () => {
  const { hooks } = readJson(BRIDGE_HOOKS);
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'Stop']);
  assert.deepEqual(hooks.SessionStart, [{
    matcher: 'startup|resume|clear|compact',
    hooks: [{
      type: 'command',
      command: `"$HOME/.local/bin/${BRAND.launcher}" session-start --harness codex`,
      timeout: HOOK_TIMEOUTS.codex['session-start'],
    }],
  }]);
  assert.deepEqual(hooks.Stop, [{
    hooks: [{
      type: 'command',
      command: `"$HOME/.local/bin/${BRAND.launcher}" stop --harness codex`,
      timeout: HOOK_TIMEOUTS.codex.stop,
    }],
  }]);
  const manifest = readJson(`plugins/${BRIDGE}/.codex-plugin/plugin.json`);
  assert.deepEqual(manifest, {
    name: BRIDGE,
    version: '0.2.0',
    description: 'Runs the triqual hooks in Codex through ~/.local/bin/triqual-hook.',
    hooks: './hooks/hooks.json',
  });
  assert.equal(manifest.version, BRIDGE_VERSION);
});

test('marketplace versions match plugin manifests', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const listed = marketplace.plugins.map((p) => p.name);

  const externalNames = [];
  for (const entry of marketplace.plugins) {
    if (isExternal(entry)) {
      externalNames.push(entry.name);
      assert.deepEqual(externalProblems(entry), [], `${entry.name}: external entry`);
      continue;
    }
    assert.equal(entry.source, `./plugins/${entry.name}`, `${entry.name}: source`);
    const manifestRel = `plugins/${entry.name}/.claude-plugin/plugin.json`;
    assert.ok(existsSync(join(ROOT, manifestRel)), `${manifestRel} exists`);
    const manifest = readJson(manifestRel);
    assert.equal(manifest.name, entry.name, `${manifestRel}: name`);
    assert.equal(manifest.version, entry.version, `${entry.name}: marketplace version equals plugin.json version`);
  }

  assert.deepEqual(externalNames, ['headjack']);
  assert.ok(listed.includes('methodology'), 'methodology is listed in the marketplace');
  const methodology = readJson('plugins/methodology/.claude-plugin/plugin.json');
  assert.ok(Array.isArray(methodology.dependencies), 'methodology declares its dependencies');
  for (const dep of methodology.dependencies) {
    assert.ok(listed.includes(dep), `methodology dependency ${dep} is a listed plugin`);
  }
});

test('plugin versions are the ones this release ships', () => {
  const versions = Object.fromEntries(readJson('.claude-plugin/marketplace.json').plugins
    .filter((p) => !isExternal(p)).map((p) => [p.name, p.version]));
  assert.deepEqual(versions, {
    'progress-tracking': '0.6.0',
    'workflow-gate': '0.3.2',
    roles: '0.4.1',
    methodology: '1.4.1',
    'memory-report': '0.5.0',
  });
  assert.equal(readJson('plugins/methodology-codex/.codex-plugin/plugin.json').version, '0.2.0');
  assert.deepEqual(readJson('plugins/methodology/.claude-plugin/plugin.json').dependencies,
    ['progress-tracking', 'workflow-gate', 'roles']);
});

test('an external entry with an http URL, a version or another name is rejected', () => {
  const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p) => p.name === EXTERNAL_NAME);
  assert.ok(entry, 'headjack is listed');
  assert.deepEqual(externalProblems(entry), []);
  const httpUrl = { ...entry, source: { ...entry.source, url: entry.source.url.replace('https://', 'http://') } };
  const withVersion = { ...entry, version: '1.0.0' };
  const otherName = { ...entry, name: 'other' };
  for (const [label, mutated] of [['http URL', httpUrl], ['version', withVersion], ['other name', otherName]]) {
    assert.notDeepEqual(externalProblems(mutated), [], `${label} is rejected`);
  }
});

// Store-2 T6: the public export carries the plugins and their tests, never this repo's own tracking or its docs.
test('public-export.json includes neither docs/ nor the tracking files', () => {
  const { include } = readJson('public-export.json');
  assert.ok(Array.isArray(include) && include.length > 0, 'include list');
  const tracking = (entry) => /^(\.\/)?(docs(\/|$)|\.methodology(\/|$)|progress\.md$|status\.md$)/.test(entry) || entry.endsWith('.tasks.json');
  assert.deepEqual(include.filter(tracking), []);
});

test('the marketplace, the package and the plugin repositories carry the triqual names', () => {
  assert.equal(readJson('.claude-plugin/marketplace.json').name, 'triqual');
  assert.equal(readJson('.agents/plugins/marketplace.json').name, 'triqual');
  assert.equal(readJson('package.json').name, 'triqual');
  for (const name of ['progress-tracking', 'memory-report']) {
    assert.equal(readJson(`plugins/${name}/.claude-plugin/plugin.json`).repository, 'https://github.com/Montinou/triqual', name);
  }
});

test('npm test runs every plugin test, the root test dir and the per-skill pins', () => {
  assert.equal(readJson('package.json').scripts.test, 'node --test "plugins/*/test/*.test.mjs" "packages/*/test/*.test.mjs" "test/*.test.mjs" "test/skill-pins/*.test.mjs"');
});

test('workflow-gate\'s descriptions name the Workflow cap and the Agent and Task start cap', () => {
  const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'workflow-gate');
  const manifest = readJson('plugins/workflow-gate/.claude-plugin/plugin.json');
  for (const description of [entry.description, manifest.description]) {
    for (const word of [/Workflow script/, /fable 3, opus 8, sonnet 12, haiku unlimited/, /Agent/, /Task/, /120 s/]) {
      assert.match(description, word, description);
    }
  }
});

test('roles\' plugin.json description lists the nine shipped role agents', () => {
  assert.equal(readJson('plugins/roles/.claude-plugin/plugin.json').description,
    'Nine role agents for plan execution: brief-writer, tdd-implementer, complex-implementer, safety-reviewer, '
    + 'spec-reviewer, review-fixer, final-adversarial-reviewer, hunter, phase-orchestrator.');
});

test('methodology\'s description names its skills, roles dispatch and tracking, and no longer calls itself a fork', () => {
  const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'methodology');
  const manifest = readJson('plugins/methodology/.claude-plugin/plugin.json');
  for (const description of [entry.description, manifest.description]) {
    for (const word of [/skills/, /roles/, /tracking/]) assert.match(description, word, description);
    assert.doesNotMatch(description, /fork/i, description);
  }
});

test('the superpowers credit lives in NOTICE: it exists and names superpowers', () => {
  const notice = join(ROOT, 'plugins/methodology/NOTICE');
  assert.ok(existsSync(notice), 'plugins/methodology/NOTICE is missing');
  assert.match(readFileSync(notice, 'utf8'), /superpowers/i);
});

test('the marketplace and methodology descriptions say Triqual, not the personal methodology (spec 2, brand text)', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const manifest = readJson('plugins/methodology/.claude-plugin/plugin.json');
  for (const description of [marketplace.metadata.description, manifest.description]) {
    assert.match(description, /Triqual/, description);
    assert.doesNotMatch(description, /personal methodology/i, description);
  }
});

// claude.ai refuses a hosted plugin that ships a top-level bin/ (its executables would reach PATH unreviewed).
test('no plugin with a local source ships a top-level bin/ directory', () => {
  const { plugins } = readJson('.claude-plugin/marketplace.json');
  for (const { name, source } of plugins) {
    if (typeof source !== 'string') continue;
    assert.equal(existsSync(join(ROOT, source, 'bin')), false, `${name} ships ${source}/bin`);
  }
});
