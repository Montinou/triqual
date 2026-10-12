import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, splitAgentsMd, syncHarness } from '../bin/lib/harness-sync.mjs';
import { legacyHeadingsOutside, syncCli } from '../bin/sync.mjs';
import { expectedRules } from '../bin/lib/harnesses.mjs';
import { backupDirFor, MARKERS, readManagedSection } from '../bin/lib/fsx.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(TEST_DIR, '..');
const FIXTURE = readFileSync(join(TEST_DIR, 'fixtures', 'codex-agents-layout.md'), 'utf8');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const LEGACY = readJson(join(PLUGIN_ROOT, 'rules', 'legacy-headings.json'));
const LEGACY_CHILDREN = readJson(join(PLUGIN_ROOT, 'rules', 'harness', 'codex-legacy-children.json'));
const LISTS = { legacy: LEGACY, legacyChildren: LEGACY_CHILDREN };
const NOW = new Date(2026, 8, 29, 10, 0, 0);
const SKIP_LINE = 'codex-rules-gate: skipped — the one-time split needs a human: run triqual sync --harness codex';
const PROMPT = 'Split ~/.codex/AGENTS.md as shown?';

// Placeholder numbers of the fixture's sections (s01..s30), by what the split does with them.
const DROPPED_SECTIONS = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 15, 23];
const KEPT_SECTIONS = [8, 14, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30];
const tag = (n) => `s${String(n).padStart(2, '0')}`;

const DROPPED_HEADINGS = [
  '## DISCOVERING PROJECT DOCUMENTATION',
  '### Step 1: Check Local Documentation Directories',
  '### Step 2: Check Project AGENTS.md',
  '### Priority Order',
  '## UNIVERSAL DEVELOPMENT RULES',
  '### Never Assume - Always Verify',
  '### No Hardcoded Values',
  '### Multi-Agent Coordination',
  '#### WRONG (Sequential Execution)',
  '#### CORRECT (Parallel Execution)',
  '#### Example: Parallel Agent Launch',
  '### Git Best Practices',
  '### Code Quality Rules',
  '## INSTRUCTION HIERARCHY',
];
const KEPT_HEADINGS = [
  '### Vercel CLI Multi-Account Routing',
  '### Verification Before Deployment',
  '## PROJECT-SPECIFIC INSTRUCTIONS',
  '### Example Project Web App',
  '### How to Find Project Instructions',
  '## QUICK REFERENCE',
  '### Common Commands',
  '### Multi-Agent Launch Pattern',
  '### Verification Checklist',
  '# Flue',
  '## Proactive subagent routing',
  '### Routing policy',
  '### Spark eligibility',
  '### Fallback policy',
  '### Parallelism',
  '### Context discipline',
];

// ---- splitAgentsMd on the layout fixture ----

test('drops the 8 legacy sections and their listed children, with no orphan body left', () => {
  const { text, dropped } = splitAgentsMd(FIXTURE, LISTS);
  assert.deepEqual(dropped, DROPPED_HEADINGS);
  assert.equal(DROPPED_HEADINGS.filter((h) => LEGACY.includes(h)).length, 8);
  const lines = text.split('\n');
  for (const n of DROPPED_SECTIONS) {
    assert.equal(lines.some((l) => l.includes(`${tag(n)}`)), false, `${tag(n)} body left behind`);
  }
  for (const h of DROPPED_HEADINGS) assert.equal(lines.includes(h), false, h);
  assert.deepEqual(legacyHeadingsOutside(text, LEGACY), []);
});

test('keeps these subtrees, in order', () => {
  const { text, kept } = splitAgentsMd(FIXTURE, LISTS);
  assert.deepEqual(kept, KEPT_HEADINGS);
  const lines = text.split('\n');
  // Each kept heading, then its placeholder, in the fixture's order.
  const order = [];
  KEPT_HEADINGS.forEach((h, i) => {
    order.push(lines.indexOf(h), lines.indexOf(`Placeholder ${tag(KEPT_SECTIONS[i])}.`));
  });
  assert.ok(order.every((idx) => idx !== -1), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // The kept text is the fixture's own lines, in order: a subsequence of the original.
  const original = FIXTURE.split('\n');
  let at = 0;
  for (const l of lines) {
    while (at < original.length && original[at] !== l) at += 1;
    assert.ok(at < original.length, `line not from the fixture, or out of order: ${l}`);
    at += 1;
  }
  assert.ok(text.endsWith('\n'));
});

test('fenced # lines do not end a section', () => {
  const { text, dropped, kept } = splitAgentsMd(FIXTURE, LISTS);
  const lines = text.split('\n');
  // Under a dropped section: the fence and the body after it go with the section.
  assert.equal(lines.includes('Placeholder s04 after fence.'), false);
  assert.equal(lines.includes('Placeholder s12 after fence.'), false);
  assert.equal(text.includes('synthetic fenced line s04'), false);
  assert.equal(text.includes('synthetic fenced line s12'), false);
  // Under a kept section: the fence and the body after it stay.
  assert.ok(lines.includes('# synthetic fenced line s08'));
  assert.ok(lines.includes('### synthetic fenced line s08'));
  assert.ok(lines.includes('Placeholder s08 after fence.'));
  assert.ok(lines.indexOf('Placeholder s08 after fence.') < lines.indexOf('### Verification Before Deployment'));
  // Fenced lines are never headings.
  for (const h of [...dropped, ...kept]) assert.equal(h.includes('synthetic'), false, h);
});

test('a legacy-child heading is dropped only beneath a dropped heading', () => {
  const text = '## Mine\n\nmine\n\n### Priority Order\n\nstill mine\n\n## UNIVERSAL DEVELOPMENT RULES\n\n'
    + '### Priority Order\n\ngone\n';
  const out = splitAgentsMd(text, LISTS);
  assert.deepEqual(out.kept, ['## Mine', '### Priority Order']);
  assert.deepEqual(out.dropped, ['## UNIVERSAL DEVELOPMENT RULES', '### Priority Order']);
  assert.equal(out.text, '## Mine\n\nmine\n\n### Priority Order\n\nstill mine\n');
});

test('the managed section is kept as it is', () => {
  const managed = `${MARKERS.start}\n### Git Best Practices\n\nours\n${MARKERS.end}\n`;
  const text = `## UNIVERSAL DEVELOPMENT RULES\n\ngone\n\n${managed}`;
  const out = splitAgentsMd(text, LISTS);
  assert.ok(out.text.endsWith(managed), out.text);
  assert.equal(out.text.includes('gone'), false);
});

test('a legacy managed section is kept as it is', () => {
  const L = BRAND.legacy.markers;
  const managed = `${L.start}\n### Git Best Practices\n\nours\n${L.end}\n`;
  const text = `## UNIVERSAL DEVELOPMENT RULES\n\ngone\n\n${managed}`;
  const out = splitAgentsMd(text, LISTS);
  assert.ok(out.text.endsWith(managed), out.text);
  assert.equal(out.text.includes('gone'), false);
});

// ---- the codex-rules-gate step ----

// A temp home with ~/.codex/AGENTS.md = `agentsMd` and a user-scope methodology install holding the repo's rules.
function makeHome(agentsMd) {
  const home = mkdtempSync(join(tmpdir(), 'cm-split-'));
  const root = join(home, '.claude', 'plugins', 'cache', 'triqual', 'methodology', '0.3.0');
  cpSync(join(PLUGIN_ROOT, 'rules'), join(root, 'rules'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'methodology@triqual': [{ scope: 'user', installPath: root, version: '0.3.0' }] },
  }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'methodology@triqual': true },
  }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), agentsMd);
  return { home, root };
}

async function withHome(agentsMd, fn) {
  const made = makeHome(agentsMd);
  try {
    return await fn(made);
  } finally {
    rmSync(made.home, { recursive: true, force: true });
  }
}

// Every CLI call fails: only the rules steps matter here.
const run = async () => ({ code: 1, stdout: '', stderr: 'fake: no CLI here' });
const agentsPath = (home) => join(home, '.codex', 'AGENTS.md');
const stepOf = (steps, id) => steps.find((s) => s.id === id);

for (const [name, argv, isTTY] of [
  ['--yes', ['--harness', 'codex', '--yes'], true],
  ['isTTY: false', ['--harness', 'codex'], false],
]) {
  test(`${name} leaves the file byte-identical and reports the exact skip line`, () => withHome(FIXTURE, async ({ home }) => {
    const asked = [];
    const confirm = async (q) => { asked.push(q); return true; };
    const out = await syncCli(argv, { home, pluginRoot: PLUGIN_ROOT, run, now: NOW, isTTY, confirm });
    const lines = out.stdout.split('\n');
    assert.ok(lines.includes(SKIP_LINE), out.stdout);
    assert.ok(lines.some((l) => l.startsWith('codex-rules: skipped — ')), out.stdout);
    assert.deepEqual(asked, []);
    assert.equal(readFileSync(agentsPath(home), 'utf8'), FIXTURE);
    assert.equal(existsSync(join(backupDirFor(home, NOW), 'codex', 'AGENTS.md')), false);
  }));
}

test('TTY + confirm true writes the split, backs up, then the managed section follows', () => withHome(FIXTURE, async ({ home, root }) => {
  const asked = [];
  const logged = [];
  const confirm = async (q) => {
    asked.push(q);
    // The backup is made before the question.
    assert.equal(readFileSync(join(backupDirFor(home, NOW), 'codex', 'AGENTS.md'), 'utf8'), FIXTURE);
    return true;
  };
  const { steps } = await syncHarness({
    home, id: 'codex', run, now: NOW, isTTY: true, confirm, log: (l) => logged.push(l),
  });
  assert.deepEqual(asked, [PROMPT]);
  assert.equal(stepOf(steps, 'codex-rules-gate').status, 'done', JSON.stringify(steps));
  assert.equal(stepOf(steps, 'codex-rules').status, 'done', JSON.stringify(steps));

  // The preview names every dropped and kept heading.
  const preview = logged.join('\n');
  for (const h of [...DROPPED_HEADINGS, ...KEPT_HEADINGS]) assert.ok(preview.includes(h), h);

  // The split text, then the managed section after it.
  const written = readFileSync(agentsPath(home), 'utf8');
  const split = splitAgentsMd(FIXTURE, LISTS).text;
  assert.ok(written.startsWith(split));
  assert.ok(written.indexOf(MARKERS.start) > written.indexOf('Placeholder s30.'));
  assert.equal(readManagedSection(written).body, expectedRules(root, 'codex').trim());
  assert.deepEqual(legacyHeadingsOutside(written, LEGACY), []);

  // The backup holds the original bytes, private; the manifest records the split.
  const backup = join(backupDirFor(home, NOW), 'codex', 'AGENTS.md');
  assert.equal(readFileSync(backup, 'utf8'), FIXTURE);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(readManifest(home).harnesses.codex.rules, { path: agentsPath(home), split: true, backup });

  // A second run finds nothing to split.
  const again = await syncHarness({ home, id: 'codex', run, now: NOW, isTTY: true, confirm });
  assert.equal(stepOf(again.steps, 'codex-rules-gate').status, 'done');
  assert.equal(stepOf(again.steps, 'codex-rules').status, 'already');
  assert.deepEqual(asked, [PROMPT]);
}));

test('confirm false leaves the file byte-identical', () => withHome(FIXTURE, async ({ home }) => {
  const asked = [];
  const { steps } = await syncHarness({
    home, id: 'codex', run, now: NOW, isTTY: true, confirm: async (q) => { asked.push(q); return false; },
  });
  assert.deepEqual(asked, [PROMPT]);
  assert.equal(stepOf(steps, 'codex-rules-gate').status, 'skipped');
  assert.equal(stepOf(steps, 'codex-rules').status, 'skipped');
  assert.equal(readFileSync(agentsPath(home), 'utf8'), FIXTURE);
  assert.equal(readManifest(home).harnesses.codex?.rules, undefined);
}));
