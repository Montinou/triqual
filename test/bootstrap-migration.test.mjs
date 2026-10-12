import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, runSteps, STEPS } from '../bin/bootstrap.mjs';
import { BRAND } from '../plugins/methodology/bin/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = join(ROOT, 'plugins', 'methodology', 'rules');
const NOW = new Date(2026, 8, 27, 10, 0, 0);
const BACKUP = (home) => join(home, '.claude', 'backups', `${BRAND.dir}-20260927-100000`);
const MIGRATION = ['rules-gate', 'rules', 'legacy-agents', 'legacy-gate', 'supersedes', 'language'];
const GATE_CMD = 'node /x/.claude/hooks/workflow-gate.mjs';
const LANGUAGE_PROMPT = 'Remove "language": "Spanish" from settings.json? It forces the reply language; it also '
  + 'sets voice dictation and session-title language. Replies will then mirror your message language.';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byId = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s]));
const never = async () => { throw new Error('confirm must not be called'); };
// Every call succeeds; `triqual doctor` prints its report line.
const okRun = async (cmd, args) => ({ code: 0, stdout: args.at(-1) === 'doctor' ? 'doctor: 0 failure(s), 0 warning(s)\n' : '', stderr: '' });

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-migration-')));
}

const claudePath = (home, ...parts) => join(home, '.claude', ...parts);

function write(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
}

// The installed methodology plugin: a copy of the repo's rules/ under the plugin cache, or custom rules files.
function installedMethodologyPath(home, { globalMd } = {}) {
  const installPath = claudePath(home, 'plugins', 'cache', BRAND.marketplace, 'methodology', '0.1.0');
  cpSync(RULES, join(installPath, 'rules'), { recursive: true });
  if (globalMd !== undefined) writeFileSync(join(installPath, 'rules', 'global.md'), globalMd);
  return installPath;
}

// installed_plugins.json with user-scope entries for the named plugins, under triqual: migrate runs first and leaves
// a machine without a legacy marketplace as it is (its own tests cover a legacy one).
function installPlugins(home, { methodology = null, progressTracking = false, roles = false, workflowGate = false } = {}) {
  const plugins = {};
  const id = (name) => `${name}@${BRAND.marketplace}`;
  if (methodology) plugins[id('methodology')] = [{ scope: 'user', installPath: methodology, version: '0.1.0' }];
  if (progressTracking) {
    plugins[id('progress-tracking')] = [{ scope: 'user', installPath: '/cache/progress-tracking/0.1.1', version: '0.1.1' }];
  }
  if (roles) plugins[id('roles')] = [{ scope: 'user', installPath: '/cache/roles/0.1.0', version: '0.1.0' }];
  if (workflowGate) {
    plugins[id('workflow-gate')] = [{ scope: 'user', installPath: '/cache/workflow-gate/0.1.0', version: '0.1.0' }];
  }
  write(claudePath(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

// A test-local legacy.json listing the sha256 of the given contents.
function writeLegacy(home, { agents = {}, workflowGate = 'gate v1\n' } = {}) {
  const path = join(home, 'legacy.json');
  const hashes = Object.fromEntries(Object.entries(agents).map(([name, body]) => [name, sha(body)]));
  write(path, JSON.stringify({ agents: hashes, workflowGate: sha(workflowGate) }));
  return path;
}

function boot(home, extra = {}) {
  return bootstrap({ home, argv: [], run: okRun, isTTY: false, confirm: never, now: NOW, ...extra });
}

const gateSettings = () => ({
  model: 'opus',
  hooks: {
    PreToolUse: [
      { matcher: 'Workflow', hooks: [{ type: 'command', command: GATE_CMD, timeout: 10 }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node /x/session-start.mjs' }] },
    ],
  },
});

// sha256 of every file under dir, by relative path.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

test('bin/legacy.json lists the known legacy agent and workflow-gate hashes', () => {
  const legacy = JSON.parse(readFileSync(join(ROOT, 'bin', 'legacy.json'), 'utf8'));
  assert.deepEqual(legacy, {
    agents: {
      'brief-writer.md': 'd2abb02392678786d66ce5c181323ef0f85add79f2292e01da1f7924f33d8d3c',
      'final-adversarial-reviewer.md': 'aae81d3496954621d063fb359fe92b5b6c4290f6ad55b38429a8c6b1b9c5a7ee',
      'review-fixer.md': 'ab8c4a277c78922a3f419e2cc642fa9e0ae7adb65a36ddac42bd10488d723b8a',
      'safety-reviewer.md': '7523972c41f7c5433360622b209b702fad330a2b1023ebc960989dc034d853ac',
      'spec-reviewer.md': '9ada9ed8223fef952f78481422533c7c2a507c40fd05aa7dd249e883f90d96bf',
      'tdd-implementer.md': '61e20eb62f00e7bd691d719bcfb4ee87ff6e901946af0fd4880358261216344f',
    },
    workflowGate: '16a9c842f82cf7d27a8c5b5ebf16d5a41f7b3e62d2aec8092729bce716a866de',
  });
});

test('the migration steps run between shim and doctor, and skip what is not installed', async () => {
  // (`migrate`, the triqual move, runs right after prereqs: plugins/methodology/test/migrate.test.mjs.)
  const home = tempHome();
  try {
    const result = await boot(home);
    // The harnesses step (Plan multi-harness T11) runs between supersedes and language.
    assert.deepEqual(result.steps.map((s) => s.id), [
      'prereqs', 'migrate', 'marketplace', 'install', 'shim', ...MIGRATION.filter((id) => id !== 'language'), 'harnesses', 'language',
      'tracking-permission', 'doctor',
    ]);
    const steps = byId(result);
    assert.deepEqual(steps['rules-gate'], { id: 'rules-gate', status: 'skipped', detail: 'methodology not installed' });
    assert.deepEqual(steps.rules, { id: 'rules', status: 'skipped', detail: 'methodology not installed' });
    assert.deepEqual(steps['legacy-agents'], { id: 'legacy-agents', status: 'skipped', detail: 'rules not synced' });
    assert.deepEqual(steps['legacy-gate'], { id: 'legacy-gate', status: 'skipped', detail: 'rules not synced' });
    assert.deepEqual(steps.supersedes, { id: 'supersedes', status: 'skipped', detail: 'methodology not installed' });
    assert.equal(steps.language.status, 'already');
    assert.equal(existsSync(claudePath(home, 'CLAUDE.md')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the migration steps are skipped when prereqs fail, and nothing is touched', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), roles: true, workflowGate: true });
    const agent = 'agent v1\n';
    const legacyPath = writeLegacy(home, { agents: { 'spec-reviewer.md': agent } });
    write(claudePath(home, 'agents', 'spec-reviewer.md'), agent);
    write(claudePath(home, 'settings.json'), JSON.stringify({ language: 'Spanish' }));
    const before = snapshot(home);
    const steps = byId(await boot(home, { legacyPath, argv: ['--yes'], nodeVersion: '18.20.4' }));
    for (const id of MIGRATION) assert.deepEqual(steps[id], { id, status: 'skipped', detail: 'prereqs failed' });
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rules come from the installed methodology plugin, backed up into the run backup dir', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home, { globalMd: 'Installed rules body\n' }) });
    write(claudePath(home, 'CLAUDE.md'), '# Mine\n');
    const steps = byId(await boot(home));
    assert.equal(steps['rules-gate'].status, 'done');
    assert.equal(steps.rules.status, 'done');
    assert.equal(
      readFileSync(claudePath(home, 'CLAUDE.md'), 'utf8'),
      `# Mine\n\n${BRAND.markers.start}\nInstalled rules body\n${BRAND.markers.end}\n`,
    );
    assert.equal(readFileSync(join(BACKUP(home), 'CLAUDE.md'), 'utf8'), '# Mine\n');

    const again = byId(await boot(home, { now: new Date(2026, 8, 27, 11, 0, 0) }));
    assert.equal(again.rules.status, 'already');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('migration stops at the rules gate on an unsplit CLAUDE.md: legacy agents and gate stay, language still runs', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), roles: true, workflowGate: true });
    const unsplit = '# Global\n\n## UNIVERSAL DEVELOPMENT RULES\n\nstuff\n';
    write(claudePath(home, 'CLAUDE.md'), unsplit);
    const agent = 'agent v1\n';
    const gate = '// legacy workflow gate\n';
    const legacyPath = writeLegacy(home, { agents: { 'tdd-implementer.md': agent }, workflowGate: gate });
    write(claudePath(home, 'agents', 'tdd-implementer.md'), agent);
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate);
    write(claudePath(home, 'settings.json'), JSON.stringify({ ...gateSettings(), language: 'Spanish' }));

    const steps = byId(await boot(home, { legacyPath, argv: ['--yes'] }));
    assert.equal(steps['rules-gate'].status, 'failed');
    assert.match(steps['rules-gate'].detail, /## UNIVERSAL DEVELOPMENT RULES/);
    assert.equal(steps.rules.status, 'failed');
    assert.equal(readFileSync(claudePath(home, 'CLAUDE.md'), 'utf8'), unsplit);
    assert.deepEqual(steps['legacy-agents'], { id: 'legacy-agents', status: 'skipped', detail: 'rules not synced' });
    assert.deepEqual(steps['legacy-gate'], { id: 'legacy-gate', status: 'skipped', detail: 'rules not synced' });
    assert.equal(readFileSync(claudePath(home, 'agents', 'tdd-implementer.md'), 'utf8'), agent);
    assert.equal(readFileSync(claudePath(home, 'hooks', 'workflow-gate.mjs'), 'utf8'), gate);
    const after = JSON.parse(readFileSync(claudePath(home, 'settings.json'), 'utf8'));
    // T16: --yes also adds the triqual tracking allow rule (its own step).
    assert.deepEqual(after, { ...gateSettings(), permissions: { allow: [`Bash(${BRAND.cli} tracking:*)`] } },
      'the gate hook entry stays; language goes');
    assert.equal(steps.language.status, 'done');
    assert.equal(steps.doctor.status, 'done');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy agents matching known hashes are backed up and removed', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), roles: true });
    const tdd = '---\nname: tdd-implementer\n---\nlegacy tdd\n';
    const spec = '---\nname: spec-reviewer\n---\nlegacy spec\n';
    const legacyPath = writeLegacy(home, {
      agents: { 'tdd-implementer.md': tdd, 'spec-reviewer.md': spec, 'brief-writer.md': 'legacy brief\n' },
    });
    write(claudePath(home, 'agents', 'tdd-implementer.md'), tdd);
    write(claudePath(home, 'agents', 'spec-reviewer.md'), spec);
    write(claudePath(home, 'agents', 'brief-writer.md'), 'my edited brief writer\n');
    write(claudePath(home, 'agents', 'my-agent.md'), 'unrelated\n');

    const steps = byId(await boot(home, { legacyPath }));
    assert.equal(steps['legacy-agents'].status, 'done');
    assert.match(steps['legacy-agents'].detail, /tdd-implementer\.md/);
    assert.match(steps['legacy-agents'].detail, /spec-reviewer\.md/);
    assert.match(steps['legacy-agents'].detail, /brief-writer\.md/);
    assert.deepEqual(readdirSync(claudePath(home, 'agents')).sort(), ['brief-writer.md', 'my-agent.md']);
    assert.equal(readFileSync(claudePath(home, 'agents', 'brief-writer.md'), 'utf8'), 'my edited brief writer\n');
    assert.equal(readFileSync(join(BACKUP(home), 'tdd-implementer.md'), 'utf8'), tdd);
    assert.equal(readFileSync(join(BACKUP(home), 'spec-reviewer.md'), 'utf8'), spec);
    assert.equal(statSync(join(BACKUP(home), 'tdd-implementer.md')).mode & 0o777, 0o600);
    assert.equal(statSync(BACKUP(home)).mode & 0o777, 0o700);
    assert.equal(existsSync(join(BACKUP(home), 'brief-writer.md')), false);

    const again = byId(await boot(home, { legacyPath }));
    assert.equal(again['legacy-agents'].status, 'already');
    assert.match(again['legacy-agents'].detail, /brief-writer\.md/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy agents stay when the roles plugin is not installed', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), workflowGate: true });
    const tdd = 'legacy tdd\n';
    const legacyPath = writeLegacy(home, { agents: { 'tdd-implementer.md': tdd } });
    write(claudePath(home, 'agents', 'tdd-implementer.md'), tdd);
    const steps = byId(await boot(home, { legacyPath }));
    assert.deepEqual(steps['legacy-agents'], {
      id: 'legacy-agents', status: 'skipped', detail: `roles@${BRAND.marketplace} is not installed`, // no marketplace is known
    });
    assert.equal(readFileSync(claudePath(home, 'agents', 'tdd-implementer.md'), 'utf8'), tdd);
    assert.equal(existsSync(BACKUP(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the legacy gate hook and its settings entry are removed', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), workflowGate: true });
    const gate = '// legacy workflow gate\n';
    const legacyPath = writeLegacy(home, { workflowGate: gate });
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate, 0o755);
    const settings = gateSettings();
    // Under another event too, next to a hook that must stay; and an unrelated group that was already empty.
    settings.hooks.PostToolUse = [
      { matcher: '*', hooks: [{ type: 'command', command: GATE_CMD }, { type: 'command', command: 'node /x/keep.mjs' }] },
      { matcher: 'Bash', hooks: [] },
    ];
    const original = JSON.stringify(settings, null, 2);
    write(claudePath(home, 'settings.json'), original);

    const steps = byId(await boot(home, { legacyPath }));
    assert.equal(steps['legacy-gate'].status, 'done');
    assert.equal(existsSync(claudePath(home, 'hooks', 'workflow-gate.mjs')), false);
    const after = JSON.parse(readFileSync(claudePath(home, 'settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(after.hooks, 'PreToolUse'), false);
    assert.deepEqual(after.hooks.SessionStart, gateSettings().hooks.SessionStart);
    assert.deepEqual(after.hooks.PostToolUse, [
      { matcher: '*', hooks: [{ type: 'command', command: 'node /x/keep.mjs' }] },
      { matcher: 'Bash', hooks: [] },
    ]);
    assert.equal(after.model, 'opus');
    assert.equal(readFileSync(join(BACKUP(home), 'settings.json'), 'utf8'), original);
    assert.equal(statSync(join(BACKUP(home), 'settings.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(BACKUP(home), 'workflow-gate.mjs'), 'utf8'), gate);

    const again = byId(await boot(home, { legacyPath }));
    assert.equal(again['legacy-gate'].status, 'already');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the legacy gate keeps a changed hook file and reports it; the settings entry still goes', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), workflowGate: true });
    const legacyPath = writeLegacy(home, { workflowGate: '// legacy workflow gate\n' });
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), '// my edited gate\n');
    write(claudePath(home, 'settings.json'), JSON.stringify(gateSettings()));
    const steps = byId(await boot(home, { legacyPath }));
    assert.equal(steps['legacy-gate'].status, 'done');
    assert.match(steps['legacy-gate'].detail, /workflow-gate\.mjs/);
    assert.equal(readFileSync(claudePath(home, 'hooks', 'workflow-gate.mjs'), 'utf8'), '// my edited gate\n');
    const after = JSON.parse(readFileSync(claudePath(home, 'settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(after.hooks, 'PreToolUse'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the legacy gate without settings.json removes the hook; invalid settings JSON fails and changes nothing', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), workflowGate: true });
    const gate = '// legacy workflow gate\n';
    const legacyPath = writeLegacy(home, { workflowGate: gate });
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate);
    const steps = byId(await boot(home, { legacyPath }));
    assert.equal(steps['legacy-gate'].status, 'done');
    assert.equal(existsSync(claudePath(home, 'hooks', 'workflow-gate.mjs')), false);
    assert.equal(existsSync(claudePath(home, 'settings.json')), false);

    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate);
    write(claudePath(home, 'settings.json'), '{ "hooks": ');
    // migrate cannot read settings.json either (its references step), so it fails first and the legacy steps wait.
    const later = new Date(2026, 8, 27, 11, 0, 0);
    const blocked = byId(await boot(home, { legacyPath, now: later }));
    assert.equal(blocked.migrate.status, 'failed');
    assert.match(blocked.migrate.detail, /^references: failed — settings\.json is not valid JSON/);
    assert.deepEqual(blocked['legacy-gate'], { id: 'legacy-gate', status: 'skipped', detail: 'migrate failed' });
    // The step itself, without migrate: fails on the invalid JSON.
    const withoutMigrate = STEPS.filter((s) => s.id !== 'migrate')
      .map((s) => ({ ...s, needs: s.needs?.filter((id) => id !== 'migrate') }));
    const bad = byId(await runSteps(withoutMigrate, { home, argv: [], run: okRun, isTTY: false, confirm: never, now: later, legacyPath }));
    assert.equal(bad['legacy-gate'].status, 'failed');
    assert.match(bad['legacy-gate'].detail, /not valid JSON/);
    assert.equal(readFileSync(claudePath(home, 'settings.json'), 'utf8'), '{ "hooks": ');
    assert.equal(readFileSync(claudePath(home, 'hooks', 'workflow-gate.mjs'), 'utf8'), gate);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the legacy gate is skipped when the workflow-gate plugin is not installed', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), roles: true });
    const gate = '// legacy workflow gate\n';
    const legacyPath = writeLegacy(home, { workflowGate: gate });
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate);
    const original = JSON.stringify(gateSettings());
    write(claudePath(home, 'settings.json'), original);
    const steps = byId(await boot(home, { legacyPath }));
    assert.deepEqual(steps['legacy-gate'], {
      id: 'legacy-gate', status: 'skipped', detail: `workflow-gate@${BRAND.marketplace} is not installed`, // no marketplace is known
    });
    assert.equal(readFileSync(claudePath(home, 'hooks', 'workflow-gate.mjs'), 'utf8'), gate);
    assert.equal(readFileSync(claudePath(home, 'settings.json'), 'utf8'), original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('language is removed only after confirmation', async () => {
  const home = tempHome();
  const settingsPath = claudePath(home, 'settings.json');
  // The triqual tracking allow rule is already there (T16), so the language prompt is the only one.
  const allowed = { permissions: { allow: [`Bash(${BRAND.cli} tracking:*)`] } };
  const withLanguage = JSON.stringify({ model: 'opus', language: 'Spanish', ...allowed }, null, 2);
  const reset = () => write(settingsPath, withLanguage);
  try {
    // No: the key stays.
    reset();
    const noAsked = [];
    const no = byId(await boot(home, { isTTY: true, confirm: async (m) => { noAsked.push(m); return false; } }));
    assert.deepEqual(noAsked, [LANGUAGE_PROMPT]);
    assert.equal(no.language.status, 'skipped');
    assert.equal(readFileSync(settingsPath, 'utf8'), withLanguage);

    // Non-TTY without --yes: skipped, confirm is not called.
    const quiet = byId(await boot(home));
    assert.equal(quiet.language.status, 'skipped');
    assert.equal(readFileSync(settingsPath, 'utf8'), withLanguage);

    // --keep-language: skipped, confirm is not called even on a TTY.
    const keep = byId(await boot(home, { isTTY: true, argv: ['--keep-language'] }));
    assert.equal(keep.language.status, 'skipped');
    assert.match(keep.language.detail, /--keep-language/);
    assert.equal(readFileSync(settingsPath, 'utf8'), withLanguage);

    // Yes: the key goes, the rest stays, the backup holds the original.
    const yesAsked = [];
    const yes = byId(await boot(home, { isTTY: true, confirm: async (m) => { yesAsked.push(m); return true; } }));
    assert.deepEqual(yesAsked, [LANGUAGE_PROMPT]);
    assert.equal(yes.language.status, 'done');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { model: 'opus', ...allowed });
    assert.equal(readFileSync(join(BACKUP(home), 'settings.json'), 'utf8'), withLanguage);

    // No key: already.
    const none = byId(await boot(home, { isTTY: true }));
    assert.equal(none.language.status, 'already');

    // --yes removes it without calling confirm.
    rmSync(BACKUP(home), { recursive: true, force: true });
    reset();
    const auto = byId(await boot(home, { argv: ['--yes'] }));
    assert.equal(auto.language.status, 'done');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { model: 'opus', ...allowed });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a full second run reports already/skipped everywhere and changes no file', async () => {
  const home = tempHome();
  try {
    installPlugins(home, { methodology: installedMethodologyPath(home), progressTracking: true, roles: true, workflowGate: true });
    const agents = { 'tdd-implementer.md': 'legacy tdd\n', 'review-fixer.md': 'legacy fixer\n' };
    const gate = '// legacy workflow gate\n';
    const legacyPath = writeLegacy(home, { agents, workflowGate: gate });
    for (const [name, body] of Object.entries(agents)) write(claudePath(home, 'agents', name), body);
    write(claudePath(home, 'hooks', 'workflow-gate.mjs'), gate);
    write(claudePath(home, 'CLAUDE.md'), '# Mine\n');
    const settings = { ...gateSettings(), language: 'Spanish', enabledPlugins: { 'superpowers@superpowers-marketplace': true } };
    const original = JSON.stringify(settings, null, 2);
    write(claudePath(home, 'settings.json'), original);

    const first = byId(await boot(home, { legacyPath, argv: ['--yes'] }));
    for (const id of MIGRATION) assert.equal(first[id].status, 'done', `${id}: ${first[id].detail}`);
    // One backup dir for the whole run; settings.json in it is the pre-run original although three steps edited it.
    assert.deepEqual(readdirSync(claudePath(home, 'backups')), [`${BRAND.dir}-20260927-100000`]);
    assert.deepEqual(readdirSync(BACKUP(home)).sort(), ['CLAUDE.md', 'review-fixer.md', 'settings.json', 'tdd-implementer.md', 'workflow-gate.mjs']);
    assert.equal(readFileSync(join(BACKUP(home), 'settings.json'), 'utf8'), original);

    const before = snapshot(home);
    const second = byId(await boot(home, { legacyPath, now: new Date(2026, 8, 27, 12, 0, 0) }));
    // rules-gate is a check that writes nothing: sync() reports a passed gate as done on every run.
    assert.equal(second['rules-gate'].status, 'done');
    for (const id of ['migrate', 'install', 'shim', 'rules', 'legacy-agents', 'legacy-gate', 'supersedes', 'language']) {
      assert.ok(['already', 'skipped'].includes(second[id].status), `${id}: ${second[id].status} — ${second[id].detail}`);
    }
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
