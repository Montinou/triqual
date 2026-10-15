import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRAND } from '../cli/lib/brand.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULES = join(REPO, 'plugins', 'methodology', 'rules');
// The private checkout carries the commit hook; the exported tree does not, so the local-terms part below skips there.
const isPrivateCheckout = existsSync(join(REPO, '.githooks', 'pre-commit'));
const read = (name) => readFileSync(join(RULES, name), 'utf8');

test('rules/global.md has the required sections and no machine config', () => {
  const text = read('global.md');
  const lines = text.split('\n');

  for (const heading of [
    '## Discovering Project Documentation',
    '### Never Assume - Always Verify',
    '### No Hardcoded Values',
    '### UI: shadcn/ui + shadcnblocks Pro',
    '### Language',
    '### Feature Flags in Vercel Apps',
    '### Multi-Agent Coordination',
    '### Multi-Agent Roles: Model and Effort',
    '### Workflow Fan-out Caps',
    '### Git Best Practices',
    '### Code Quality Rules',
    '## Instruction Hierarchy',
  ]) {
    assert.ok(lines.includes(heading), `missing heading line: ${heading}`);
  }

  for (const needle of [
    'roles:brief-writer',
    'roles:tdd-implementer',
    'roles:complex-implementer',
    'roles:safety-reviewer',
    'roles:spec-reviewer',
    'roles:review-fixer',
    'roles:final-adversarial-reviewer',
    'workflow-gate',
    'flags/next',
    'vercelAdapter',
  ]) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }

  for (const needle of [
    '~/.claude/hooks/workflow-gate.mjs',
    'Flue',
    BRAND.markers.start,
    BRAND.legacy.markers.start,
  ]) {
    assert.ok(!text.includes(needle), `must not contain: ${needle}`);
  }

  assert.ok(text.length < 9000, `global.md is ${text.length} characters, must be under 9,000`);
});

test('the Language rule names progress entries, not the tracking files', () => {
  const lines = read('global.md').split('\n');
  const start = lines.indexOf('### Language');
  assert.ok(start >= 0, 'missing ### Language');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### '));
  const language = lines.slice(start, end).join('\n');
  assert.ok(!language.includes('progress.md'), 'the Language rule still names progress.md');
  assert.ok(!language.includes('status.md'), 'the Language rule still names status.md');
  assert.match(language, /progress entries/, 'the Language rule no longer lists progress entries among the English artifacts');
});

test('rules/global.md has none of the local terms of this machine', { skip: !isPrivateCheckout }, async () => {
  const { loadLocalTerms } = await import(pathToFileURL(join(REPO, 'bin', 'lib', 'export.mjs')));
  const { terms } = loadLocalTerms({ env: process.env, home: homedir() });
  const text = read('global.md').toLowerCase();
  // Never print a term: the failure names its position in the list.
  terms.forEach((term, index) => assert.ok(!text.includes(term.toLowerCase()), `global.md contains local term #${index + 1}`));
});

test('legacy-headings.json lists the pre-migration headings exactly', () => {
  assert.deepEqual(JSON.parse(read('legacy-headings.json')), [
    '## DISCOVERING PROJECT DOCUMENTATION',
    '## UNIVERSAL DEVELOPMENT RULES',
    '### Never Assume - Always Verify',
    '### No Hardcoded Values',
    '### UI: shadcn/ui + shadcnblocks Pro',
    '### Multi-Agent Coordination',
    '### Multi-Agent Roles: Model and Effort',
    '### Workflow Fan-out Caps (enforced by hook)',
    '### Git Best Practices',
    '### Code Quality Rules',
    '## INSTRUCTION HIERARCHY',
  ]);
  assert.deepEqual(JSON.parse(read('manifest.json')), { version: 1, supersedes: ['superpowers@*'] });
});

// The role table rows: `| ... | \`roles:<name>\` | ... |`.
const roleRows = () => read('global.md').split('\n').filter((line) => /^\| [^|]+ \| `roles:[a-z-]+` \|/.test(line));

test('global.md marks brief-writer on demand', () => {
  const row = roleRows().find((line) => line.includes('`roles:brief-writer`'));
  assert.ok(row, 'no brief-writer row');
  assert.ok(row.includes('on demand (plan text lacks interfaces from current code)'), row);
});

test('global.md role table points at the methodology skills, and forked skills pass no model', () => {
  const rows = roleRows();
  assert.equal(rows.length, 8, rows.join('\n'));
  const skills = join(RULES, '..', 'skills');
  for (const row of rows) {
    const named = [...row.matchAll(/`methodology:([a-z-]+)`/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `row names no methodology skill: ${row}`);
    for (const name of named) assert.ok(existsSync(join(skills, name, 'SKILL.md')), `methodology:${name} is not a skill`);
  }
  const text = read('global.md');
  assert.ok(text.split('\n').some((line) => /forked .*skills dispatch `roles:\*` and pass no model/.test(line)),
    'global.md lacks the line: forked skills dispatch `roles:*` and pass no model');
  assert.ok(!/superpowers/i.test(text), 'global.md names superpowers');
});

test('global.md credits brainstorming and writing-plans for the adversarial spec and plan audits', () => {
  const row = roleRows().find((line) => line.includes('`roles:final-adversarial-reviewer`'));
  assert.ok(row.includes('`methodology:brainstorming`'), row);
  assert.ok(row.includes('`methodology:writing-plans`'), row);
});

// The agent frontmatter `model` and `effort`, read from plugins/roles/agents/<name>.md.
const AGENTS = join(REPO, 'plugins', 'roles', 'agents');
const frontmatter = (name) => {
  const text = readFileSync(join(AGENTS, `${name}.md`), 'utf8');
  const block = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(block, `${name}.md has no frontmatter`);
  const field = (key) => block[1].match(new RegExp(`^${key}: *(.+?) *$`, 'm'))?.[1];
  return { model: field('model'), effort: field('effort') };
};
// The cells of a role-table row, trimmed.
const cells = (row) => row.split('|').slice(1, -1).map((cell) => cell.trim());

test('global.md role table matches the role agents', () => {
  const rows = roleRows();
  const names = rows.map((row) => cells(row)[1].match(/^`roles:([a-z-]+)`$/)?.[1]);
  assert.ok(names.every(Boolean), `a row has an Agent type cell that is not \`roles:<name>\`: ${rows.join('\n')}`);
  const files = readdirSync(AGENTS).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3));
  assert.deepEqual([...names].sort(), files.sort(), 'the roles:* rows are exactly the files in plugins/roles/agents');
  rows.forEach((row, index) => {
    const [, , model, effort] = cells(row);
    const agent = frontmatter(names[index]);
    assert.ok(agent.model && agent.effort, `${names[index]}: frontmatter lacks model or effort`);
    assert.equal(model, agent.model, `${names[index]}: Model cell`);
    assert.equal(effort, agent.effort, `${names[index]}: Effort cell`);
  });
  assert.ok(!rows.some((row) => row.includes('(session)')), 'the session row is not a roles:* row');
});

test('global.md keeps the session model for coordination only', () => {
  const caps = read('global.md').split('### Workflow Fan-out Caps')[1].replace(/\s+/g, ' ');
  assert.match(caps, /the session model is only for coordination\./);
  assert.ok(!/final adversarial review/i.test(caps), 'the caps section still reserves the session model for the final review');
});

test('global.md credits the execution skills for the hunter', () => {
  const row = roleRows().find((line) => line.includes('`roles:hunter`'));
  assert.ok(row, 'no hunter row');
  assert.ok(row.includes('`methodology:subagent-driven-development`'), row);
  assert.ok(row.includes('`methodology:executing-plans`'), row);
  assert.ok(row.includes('verified by an Opus reviewer'), row);
});

test('global.md drops the safety shadow and adds the complex implementer', () => {
  const text = read('global.md');
  assert.ok(!/shadow/i.test(text), 'global.md still names the safety shadow');
  assert.ok(!/Sonnet gate/i.test(text), 'global.md still says the Sonnet gate');
  const complex = roleRows().find((line) => line.includes('`roles:complex-implementer`'));
  assert.ok(complex, 'no complex-implementer row');
  const [, , model, effort, by, why] = cells(complex);
  assert.equal(model, 'opus');
  assert.equal(effort, 'medium');
  assert.ok(by.includes('`methodology:subagent-driven-development`') && by.includes('`roles:complex-implementer`'), by);
  assert.match(why, /multi-system/);
  assert.match(why, /live-state/);
  assert.match(why, /costly/);
  const safety = roleRows().find((line) => line.includes('`roles:safety-reviewer`'));
  assert.match(cells(safety)[5], /mechanical checklist/, safety);
});
