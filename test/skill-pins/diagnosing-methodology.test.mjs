// Pins for diagnosing-methodology (plan methodology-orchestrator · T22). It must point at this system's files, read the
// ledger lines the orchestrator writes (`Tier:`, `Tier raised:`) and name the ten skills of 1.0, and in store mode it reads
// tracking through the CLI and stages or writes no tracking file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'methodology', 'skills');
const DM = 'diagnosing-methodology';
const read = (path) => readFileSync(join(SKILLS, DM, path), 'utf8');
const flat = (path) => read(path).replace(/\s*\n\s*/g, ' ');

// The ten skills of 1.0.
const TEN_SKILLS = [
  'using-methodology', 'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'verification-before-completion', 'systematic-debugging', 'finishing-branch', 'diagnosing-methodology', 'reviewing-code',
];
// Skills removed by 1.0: a diagnosing prompt that still names one sends the analyst looking for a skill that cannot fire.
const REMOVED_SKILLS = [
  ['subagent', 'driven', 'development'].join('-'), 'requesting-code-review', 'receiving-code-review', 'using-git-worktrees',
  'dispatching-parallel-agents', 'writing-skills',
];

test('step 2 points at this system\'s files: install root, SDD workspace and ledger, diagnosing workspace', () => {
  const skill = flat('SKILL.md');
  for (const needle of [
    '~/.config/triqual/diagnosing/<session-id>/',
    '~/.claude/plugins/cache/triqual/<plugin>/<version>/',
    '(`methodology`, `roles`, `progress-tracking`, `workflow-gate`)',
    '`.methodology/sdd/<plan>/`',
    '`sdd-ledger.md`',
    '`triqual tasks paths --json`',
  ]) {
    assert.ok(skill.includes(needle), `SKILL.md does not point at ${needle}`);
  }
});

test('in store mode there are no tracking files: tracking is read with the CLI and nothing is staged or written', () => {
  const skill = flat('SKILL.md');
  for (const needle of ['`"mode": "store"`', 'no tracking files to read', '`triqual tracking log --json`', '`triqual tasks export --json`']) {
    assert.ok(skill.includes(needle), `SKILL.md does not say ${needle}`);
  }
  assert.ok(!/tracking add/.test(skill), 'diagnosing writes a tracking entry');
  assert.match(skill, /\*\*Read-only\.\*\* Never modify, move, or delete a session file\./, 'the read-only rule is gone');
  assert.match(skill, /Never (stage|commit)[^.]*(tracking file|`progress\.md`)|no tracking file (is )?(written|staged)/i, 'diagnosing does not say it stages or writes no tracking file');
});

for (const prompt of ['prompts/plan-adherence.md', 'prompts/skill-timeline.md']) {
  test(`${prompt} reads the ledger's Tier: and Tier raised: lines`, () => {
    const text = flat(prompt);
    assert.ok(text.includes('`Tier: T<N> <tier>`'), `${prompt} does not name the Tier: line`);
    assert.ok(text.includes('`Tier raised: T<N> <from> → <to> — <reason>`'), `${prompt} does not name the Tier raised: line`);
    assert.ok(text.includes('`sdd-ledger.md`'), `${prompt} does not name the ledger file`);
  });
}

test('plan-adherence reports a raise without a verdict on it', () => {
  assert.match(flat('prompts/plan-adherence.md'), /Do not say whether a raise was right or wrong; quote the lines\./);
});

test('skill-timeline treats a Tier raised: line as the controller\'s record, not a skill firing', () => {
  assert.match(flat('prompts/skill-timeline.md'), /a `Tier raised:` line is the controller's record, not a skill firing/);
});

test('plan-adherence compares a task\'s declared tier with its raises and the review the ledger records', () => {
  const text = flat('prompts/plan-adherence.md');
  for (const needle of ['`Tier:`', '`Tier raised:`', 'tier', 'never lowered']) {
    assert.ok(text.includes(needle), `plan-adherence does not say ${needle}`);
  }
  assert.match(text, /raise[^.]*(before|after)[^.]*(review|dispatch)/i, 'plan-adherence does not order a raise against the review');
});

test('skill-timeline names the ten skills of 1.0 and no removed one', () => {
  const text = read('prompts/skill-timeline.md');
  for (const skill of TEN_SKILLS) assert.ok(text.includes(`\`${skill}\``), `skill-timeline does not name ${skill}`);
  for (const skill of REMOVED_SKILLS) assert.ok(!text.includes(skill), `skill-timeline names the removed skill ${skill}`);
});

test('no diagnosing file names a skill 1.0 removed', () => {
  const files = ['SKILL.md', ...['analyst-common', 'cost-and-time', 'plan-adherence', 'quality-evidence', 'repeated-work', 'request-conflicts', 'scrub-audit', 'scrub', 'similar-session', 'skill-timeline', 'stumbles'].map((p) => `prompts/${p}.md`)];
  for (const file of files) {
    assert.ok(existsSync(join(SKILLS, DM, file)), `${file} is missing`);
    for (const skill of REMOVED_SKILLS) assert.ok(!read(file).includes(skill), `${file} names the removed skill ${skill}`);
  }
});

test('the quick reference still routes a skill that never fired to skill-timeline', () => {
  assert.match(flat('SKILL.md'), /"Skill X never fired" \| skill-timeline/);
});
