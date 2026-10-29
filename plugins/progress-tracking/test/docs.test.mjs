import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(PLUGIN, 'skills', 'progress-tracking', 'SKILL.md');
const COMMAND = join(PLUGIN, 'commands', 'progress-init.md');
const SPANISH = /[áéíóúñ¿¡]/;

test('skill and command are English and mention the ledger and local mode', () => {
  const skill = readFileSync(SKILL, 'utf8');
  const command = readFileSync(COMMAND, 'utf8');
  for (const [name, text] of [['SKILL.md', skill], ['progress-init.md', command]]) {
    assert.ok(text.includes('triqual tasks'), `${name} mentions triqual tasks`);
    assert.ok(text.includes('--local'), `${name} mentions --local`);
    assert.doesNotMatch(text, SPANISH, `${name} has no Spanish characters`);
  }
  assert.ok(skill.includes('triqual tasks paths --json'), 'SKILL.md mentions triqual tasks paths --json');
  assert.ok(skill.includes('.git/methodology'), 'SKILL.md mentions .git/methodology');
});

test('skill tells the committer to stage dirty ledgers with status.md and to confirm before --local --remove', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /stages? every dirty[\s\S]{0,80}\.tasks\.json[\s\S]{0,80}status\.md/,
    'SKILL.md: the next commit stages every dirty ledger together with status.md');
  assert.match(skill, /--local --remove[\s\S]{0,200}permanently[\s\S]{0,200}confirm with the user/,
    'SKILL.md: --local --remove deletes permanently, so confirm with the user first');
});

test('skill documents paths --json outside tracking, role reconciliation, and stays under 10,000 characters', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /`"optedIn": false`/, 'SKILL.md: paths --json outside an opted-in repo');
  assert.match(skill, /`notOptedInMessage`[\s\S]{0,40}`localHookLines`/, 'SKILL.md: the two facts');
  assert.match(skill, /`"optedIn": false`[\s\S]{0,200}exit(s)? 0/, 'SKILL.md: paths --json exits 0 when not opted in');
  assert.match(skill, /`check` never compares a role or the dependencies with the plan: only `(triqual tasks )?init` copies them/,
    'SKILL.md: check compares no role or dependencies with the plan, init copies them');
  assert.match(skill, /`schema-too-new`[\s\S]{0,120}Never restore a snapshot/,
    'SKILL.md: a schema-too-new store is never restored');
  assert.ok(skill.length <= 10000, `SKILL.md is ${skill.length} characters, must be at most 10,000`);
});

test('local-mode writes go through triqual tracking write, detailed in references/local-mode.md', () => {
  const skill = readFileSync(SKILL, 'utf8');
  const ref = join(PLUGIN, 'skills', 'progress-tracking', 'references', 'local-mode.md');
  assert.match(skill, /\]\(references\/local-mode\.md\)/, 'SKILL.md links references/local-mode.md');
  assert.match(skill, /`triqual tracking write entry <draft>`/, 'SKILL.md names triqual tracking write entry');
  assert.match(skill, /once per change set/, 'SKILL.md: the Stop hook blocks once per change set');
  const text = readFileSync(ref, 'utf8');
  assert.doesNotMatch(text, SPANISH);
  for (const kind of ['entry', 'status', 'spec', 'plan']) {
    assert.match(text, new RegExp(`\`triqual tracking write ${kind} <draft>`), `local-mode.md names triqual tracking write ${kind}`);
  }
  for (const needle of ['--replace', 'Bash(triqual tracking:*)', 'OS temp dir', 'lock', 'exit 2']) {
    assert.ok(text.includes(needle), `local-mode.md mentions ${needle}`);
  }
  assert.ok(text.includes('Bootstrap offers the allow rule `Bash(triqual tracking:*)`'), 'local-mode.md: the rule bootstrap offers');
  assert.match(text, /never[^.]*\.git\/[^.]*file tools|file tools[^.]*never[^.]*\.git\//i, 'no file-tool writes under .git/');
  assert.ok(skill.length <= 10000, `SKILL.md is ${skill.length} characters, must be at most 10,000`);
});

// ---- store mode ----

const SKILL_DIR = join(PLUGIN, 'skills', 'progress-tracking');
const STORE_REF = join(SKILL_DIR, 'references', 'store-mode.md');
const LOCAL_REF = join(SKILL_DIR, 'references', 'local-mode.md');
// The text of the `## <heading>` section, up to the next `## ` heading (or the end of the file).
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
};

test('SKILL.md has a Store mode section with the write and read commands and links store-mode.md', () => {
  const skill = readFileSync(SKILL, 'utf8');
  const store = section(skill, 'Store mode');
  assert.notEqual(store, '', 'SKILL.md has a `## Store mode` section');
  for (const needle of [
    '`triqual tracking add <draft>`', '--no-commit', '`triqual tracking status set --section',
    '`triqual tracking status`', '`triqual tracking log`', 'progress-init --store',
  ]) {
    assert.ok(store.includes(needle), `the Store mode section names ${needle}`);
  }
  assert.match(store, /\]\(references\/store-mode\.md\)/, 'the Store mode section links references/store-mode.md');
  assert.match(store, /(never|no)[^.]*(staged|committed)/i, 'the section says no tracking file is staged or committed');
  assert.ok(section(skill, 'What enforces it').includes('store'), 'What enforces it names the store gates');
  assert.ok(skill.length <= 10000, `SKILL.md is ${skill.length} characters, must be at most 10,000`);
});

test('references/store-mode.md documents the store rules, the switch and the recovery commands', () => {
  const text = readFileSync(STORE_REF, 'utf8');
  assert.doesNotMatch(text, SPANISH);
  for (const needle of [
    '`triqual tracking add <draft>`', '--no-commit', '--corrects', 'status set --section', '`triqual tracking log`',
    '`triqual tracking restore', '`triqual tracking export', 'TRIQUAL_TRACKING_DB', 'git config --local triqual.tracking',
    '`triqual tracking status', 'triqual tracking write spec <draft>', 'triqual tracking write plan <draft>',
    '--accept-unparsed', 'triqual.trackingFrom', 'mktemp -d', 'backups/', '`state`',
  ]) {
    assert.ok(text.includes(needle), `store-mode.md names ${needle}`);
  }
  for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
    assert.match(text, new RegExp(`\\*\\*${rule}\\b`), `store-mode.md states ${rule}`);
  }
  assert.match(text, /fresh repository[^.]*one\s+`progress-init --store`/, 'opting a fresh repository in takes one progress-init --store');
  assert.match(text, /per-worktree switch[^.]*\./i, 'store-mode.md has a sentence on the per-worktree switch');
  assert.match(text, /clone-wide[^.]*worktree[^.]*(imports|deletes)[^.]*own/i, 'the marker is clone-wide: a worktree switches its own files');
  assert.match(text, /merge `main`/, 'the recommended path is to merge main');
  assert.match(text, /tracking write plan <draft>`[^.]*same file name/, 'a legacy plan is revised with tracking write plan under the same file name');
  assert.match(text, /bare file name/, 'a revised plan is named by its bare file name');
  assert.match(text, /prints the commit[^.]*never (makes|stages)/i, 'the switch prints the commit and never makes it');
});

test('commands/progress-init.md covers --store, --accept-unparsed, the refusals and the warnings', () => {
  const command = readFileSync(COMMAND, 'utf8');
  assert.doesNotMatch(command, SPANISH);
  for (const needle of ['--store', '--accept-unparsed', 'triqual.trackingFrom', 'core.hooksPath', 'shell script']) {
    assert.ok(command.includes(needle), `progress-init.md names ${needle}`);
  }
  assert.match(command, /refus[^.]*(branch|worktree)[^.]*not (yet )?(imported|in the store)/i, 'refuses an unimported live branch or worktree');
  assert.match(command, /refus[^.]*local[^.]*versioned[^.]*core\.hooksPath|local[^.]*versioned[^.]*core\.hooksPath[^.]*refus/i,
    'refuses a local repository whose hooks dir is versioned');
  assert.match(command, /not a shell script/, 'refuses a hook that is not a shell script');
  assert.match(command, /status\.md[^.]*(only|sections)[^.]*warn|warn[^.]*status\.md/i, 'warns about a status-only branch');
  assert.match(command, /metadata[^.]*warn|warn[^.]*(titles|metadata)/i, 'warns about a metadata-only branch');
  assert.ok(command.includes('references/store-mode.md') || command.includes('store-mode.md'), 'points at store-mode.md');
});

test('commands/progress-init.md: plain and --local init refuse in store mode; the usage names --store; a local-origin switch writes no CLAUDE.md', () => {
  const command = readFileSync(COMMAND, 'utf8');
  assert.match(command, /without `--store`[^.]*store mode[^.]*exit(s)? 2|store mode[^.]*without `--store`[^.]*exit(s)? 2/,
    'plain progress-init and --local exit 2 in a store-mode repository');
  assert.ok(command.includes('`triqual progress-init --store`'), 'the refusal names progress-init --store');
  assert.ok(command.includes('`triqual progress-init [--local | --store]`'), 'the usage line names --store');
  assert.match(command, /switched\s+from\s+local mode[^.]*no\s+`CLAUDE\.md`/, 'a local-origin switch writes no CLAUDE.md');
  assert.match(readFileSync(STORE_REF, 'utf8'), /switched\s+from\s+local mode[^.]*no\s+`CLAUDE\.md`/,
    'store-mode.md: a local-origin switch writes no CLAUDE.md');
});

test('hooks.json: the Stop hook status message names progress tracking, not a file', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.Stop[0].hooks[0].statusMessage, 'Checking progress tracking');
});

test('local-mode.md points at store-mode.md as the alternative', () => {
  assert.match(readFileSync(LOCAL_REF, 'utf8'), /\]\(store-mode\.md\)/);
});

test('plugin.json and marketplace.json describe the store mode', () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = market.plugins.find((p) => p.name === 'progress-tracking');
  for (const [name, description] of [['plugin.json', plugin.description], ['marketplace.json', entry.description]]) {
    assert.match(description, /store/i, `${name} names the store mode`);
    assert.match(description, /committed/i, `${name} still names committed mode`);
  }
  assert.equal(plugin.description, entry.description, 'both descriptions are the same text');
});

test('README Tiers section documents the heavy-tier warning at registration', () => {
  const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');
  const tiers = readme.slice(readme.indexOf('#### Tiers'));
  assert.match(tiers.slice(0, 3000).replace(/\s+/g, ' '),
    /more than 80% of the tasks of a plan of at least 5 are `heavy`[^.]*warning[^.]*stderr[^.]*exit code and the ledger/,
    'README #### Tiers: the warning, its threshold, stderr, and that nothing else changes');
});

test('plugin.json, marketplace.json and the README table agree on 0.7.2', () => {
  const root = join(PLUGIN, '..', '..');
  const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.version, '0.7.2');
  assert.equal(market.plugins.find(p => p.name === 'progress-tracking').version, '0.7.2');
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /\| `progress-tracking` \| 0\.7\.2 \|/);
});

test('the CHANGELOG has a 0.7.2 section', () => {
  assert.match(readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8'), /^## progress-tracking 0\.7\.2$/m);
});

test('both READMEs document recording, compatibility cost and rollout', () => {
  const root = readFileSync(join(PLUGIN, '..', '..', 'README.md'), 'utf8');
  const row = root.split('\n').find(line => line.startsWith('| `progress-tracking` |'));
  for (const text of [row, readFileSync(join(PLUGIN, 'README.md'), 'utf8')]) {
    for (const value of ['SessionStart', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd', 'sessions.db', 'TRIQUAL_SESSIONS=0', '47800', '120 ms', 'Grok', 'triqual sync --yes', 'triqual doctor', '/reload-plugins']) assert.ok(text.includes(value), value);
  }
});

test('references/store-mode.md documents reconcile after a migration', () => {
  const text = readFileSync(STORE_REF, 'utf8');
  const reconcile = section(text, 'Reconcile after a migration');
  assert.notEqual(reconcile, '', 'store-mode.md has a `## Reconcile after a migration` section');
  assert.doesNotMatch(reconcile, SPANISH);
  assert.ok(reconcile.includes('triqual tasks reconcile'), 'names triqual tasks reconcile');
  assert.ok(reconcile.includes('--apply'), 'names --apply');
  assert.match(reconcile, /after a migration[\s\S]{0,300}without (a )?ledger move/i, 'when to run it: after a migration or tasks done without ledger moves');
  assert.match(reconcile, /report[^.]*before[^.]*`--apply`/i, 'run the report before --apply');
  assert.match(reconcile, /only[^.]*`high`[^.]*(applied|confidence)|`high`[^.]*only[^.]*appl/i, 'only high confidence is applied');
});
