// Spec and plan format (stacked execution): brainstorming writes Units and Delivery Slices, writing-plans writes
// phases of one-commit tasks. Texts of the skills are checked, not behavior; later tasks extend this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(TEST, '..', 'skills');

const read = (path) => readFileSync(join(SKILLS, path), 'utf8');

// The trimmed lines of a file from one heading (included) to the next heading of the same or a higher level.
// Fence-aware: a heading-looking line inside a code fence neither starts nor ends a section.
const section = (path, heading) => {
  const level = /^#+/.exec(heading)[0].length;
  let fence = null;
  let start = -1;
  const out = [];
  for (const raw of read(path).split('\n')) {
    const line = raw.trim();
    const run = /^(`{3,}|~{3,})/.exec(raw.replace(/^ {0,3}/, ''));
    if (fence) {
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && raw.replace(/^ {0,3}/, '').trim() === run[1]) fence = null;
    } else if (run) {
      fence = run[1];
    } else if (/^#+ /.test(line)) {
      if (start >= 0 && /^#+/.exec(line)[0].length <= level) break;
      if (start < 0 && line === heading) start = 0;
    }
    if (start >= 0) out.push(line);
  }
  assert.ok(start >= 0, `${path} has no heading ${heading}`);
  return out;
};
// The lines of a bold-labelled block: from the line starting with `label` to the next line starting with `**` or `#`.
const block = (lines, label) => {
  const start = lines.findIndex((line) => line.startsWith(label));
  assert.ok(start >= 0, `no line starts with ${label}`);
  const end = lines.findIndex((line, i) => i > start && /^(\*\*|#)/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
};
const BRAIN = 'brainstorming/SKILL.md';
const AUDIT = 'brainstorming/spec-document-reviewer-prompt.md';

test('brainstorming requires Units and Delivery Slices in every architectural spec', () => {
  const text = read(BRAIN);
  for (const needle of [
    '## Units',
    '## Delivery Slices',
    '**Purpose:**',
    '**Interface:**',
    '**Depends on:**',
    '**Acceptance:**',
    '**Delivers:**',
    '**Units:**',
    '**Stands alone because:**',
  ]) {
    assert.ok(text.includes(needle), `brainstorming/SKILL.md lacks ${needle}`);
  }
  const present = section(BRAIN, '## Checklist').find((line) => line.startsWith('5. **Present design**'));
  assert.ok(present, 'the Architectural checklist has no 5. **Present design** item');
  assert.match(present, /units/i);
  assert.match(present, /delivery slices/i);
  const presenting = block(section(BRAIN, '## The Process'), '**Presenting the design:**');
  assert.match(presenting, /units/i);
  assert.match(presenting, /delivery slices/i);
  const isolation = block(section(BRAIN, '## The Process'), '**Design for isolation and clarity:**');
  assert.match(isolation, /## Units/);
  assert.match(isolation, /## Delivery Slices/);
});

test('spec self-review has a Modularity check', () => {
  const review = block(section(BRAIN, '## After the Design (architectural path)'), '**Spec Self-Review:**');
  const item = review.split('\n').find((line) => line.startsWith('5. **Modularity:**'));
  assert.ok(item, 'the Spec Self-Review list has no 5. **Modularity:** item');
  for (const word of ['interface', 'depends', 'earlier slices', 'every unit', 'stands alone']) {
    assert.ok(item.includes(word), `the Modularity check does not name "${word}"`);
  }
});

test('the audit prompt flags modularity defects in specs', () => {
  const lines = read(AUDIT).split('\n');
  const raw = lines.find((line) => line.trim().startsWith('| Modularity |'));
  assert.ok(raw, 'the audit prompt has no | Modularity | row');
  const neighbour = lines.find((line) => line.trim().startsWith('| YAGNI |'));
  assert.ok(neighbour, 'the audit prompt has no | YAGNI | row to compare indentation with');
  const indent = (line) => line.match(/^ */)[0];
  assert.ok(indent(neighbour).length > 0, 'the spec-checks table is not indented inside the prompt block');
  assert.equal(indent(raw), indent(neighbour), 'the | Modularity | row is not indented like the other rows of the prompt block');
  const row = raw.trim();
  for (const phrase of ['missing interface or dependency line', 'forward slice dependency', 'uncovered unit', 'does not stand alone', 'oversized slice']) {
    assert.ok(row.includes(phrase), `the Modularity row does not name "${phrase}"`);
  }
});

const PLANS = 'writing-plans/SKILL.md';

test('the plan header names the branch prefix', () => {
  const header = section(PLANS, '## Plan Document Header').join('\n');
  const spec = header.indexOf('**Spec:**');
  const prefix = header.indexOf('**Branch prefix:**');
  assert.ok(spec >= 0, 'the plan header has no **Spec:** line');
  assert.ok(prefix > spec, 'the plan header has no **Branch prefix:** line after **Spec:**');
});

test('a plan is phases of one-commit tasks', () => {
  const text = section(PLANS, '## Phases').join('\n');
  let at = -1;
  for (const label of ['## Phase <N>:', '**Slice:**', '**Branch:**', '**PR title:**', '**Stands alone because:**', '**Phase check:**']) {
    const next = text.indexOf(label, at + 1);
    assert.ok(next > at, `## Phases lacks ${label} in order`);
    at = next;
  }
  for (const phrase of [
    'global',
    'exactly one commit',
    'about 6 tasks',
    'Depends on',
    'same or an earlier phase',
    'coordinator',
    'at least one task that commits',
    '## After Merge',
    'No `### Task` headings',
  ]) {
    assert.ok(text.includes(phrase), `## Phases does not state "${phrase}"`);
  }
});

test('Task Right-Sizing is one commit', () => {
  assert.ok(section(PLANS, '## Task Right-Sizing').join('\n').includes('one commit'));
});

test('plan self-review checks phases', () => {
  const item = section(PLANS, '## Self-Review').find((line) => line.startsWith('**6. Phases:**'));
  assert.ok(item, 'the plan Self-Review has no **6. Phases:** item');
});

test('the audit prompt flags phase defects in plans', () => {
  const lines = read(AUDIT).split('\n');
  const raw = lines.find((line) => line.trim().startsWith('| Phases |'));
  assert.ok(raw, 'the audit prompt has no | Phases | row');
  const neighbour = lines.find((line) => line.trim().startsWith('| Task format |'));
  assert.ok(neighbour, 'the audit prompt has no | Task format | row to compare indentation with');
  const indent = (line) => line.match(/^ */)[0];
  assert.ok(indent(neighbour).length > 0, 'the plan-checks table is not indented inside the prompt block');
  assert.equal(indent(raw), indent(neighbour), 'the | Phases | row is not indented like the other rows of the prompt block');
  const row = raw.trim();
  for (const phrase of [
    'phase with no slice',
    'task depending on a later phase',
    'phase without a branch',
    'PR title',
    'Phase check',
    'committing task',
    'merge-dependent operation written as a task',
  ]) {
    assert.ok(row.includes(phrase), `the Phases row does not name "${phrase}"`);
  }
});

// Execution Handoff (spec U2, R7): both branches say the stack, the push and who merges.
test('both handoff branches state the stack and the push authorization', () => {
  const text = section(PLANS, '## Execution Handoff').join(' ').replace(/\s+/g, ' ');
  const none = '**When no execution method has already been supplied:**';
  const supplied = '**When an execution method has already been supplied:**';
  const chosen = '**If Subagent-driven chosen:**';
  for (const marker of [none, supplied, chosen]) assert.ok(text.includes(marker), `the handoff lost "${marker}"`);
  const branches = {
    'no method supplied': text.slice(text.indexOf(none), text.indexOf(supplied)),
    'method supplied': text.slice(text.indexOf(supplied), text.indexOf(chosen)),
  };
  for (const [name, message] of Object.entries(branches)) {
    for (const phrase of ['stack', 'phase branches', 'draft PR', 'authorizes', 'ready for review after the final review', 'merging stays yours']) {
      assert.ok(message.includes(phrase), `the "${name}" handoff message does not say "${phrase}"`);
    }
  }
  assert.ok(branches['no method supplied'].includes('Choosing'), 'the first message does not say that choosing authorizes');
  assert.ok(branches['method supplied'].includes('Confirming'), 'the second message does not say that confirming authorizes');
  // The text above the branches names who records the authorization.
  const intro = text.slice(0, text.indexOf(none));
  for (const phrase of ['stack', 'authorizes', 'phase branches', 'draft PRs', 'ready for review after the final review', 'the execution skill records it', 'merging stays your human partner']) {
    assert.ok(intro.includes(phrase), `the handoff introduction does not say "${phrase}"`);
  }
});

// Task tiers (spec: orchestrator): every task carries a `**Tier:**`, all-or-none per plan, and the audit checks them.
test('the Task Structure template opens with the tier line', () => {
  const lines = section(PLANS, '## Task Structure');
  const heading = lines.indexOf('### Task N: [Component Name]');
  assert.ok(heading >= 0, 'the Task Structure template has no `### Task N:` heading');
  const first = lines.slice(heading + 1).find((line) => line !== '');
  assert.equal(first, '**Tier:** heavy', 'the first line under the task heading is not `**Tier:** heavy`');
  assert.ok(lines.indexOf('**Tier:** heavy') < lines.indexOf('**Depends on:** T1, T3'), '`**Tier:**` does not come before `**Depends on:**`');
});

test('## Task Tiers carries the three-tier rubric and its rules', () => {
  const lines = section(PLANS, '## Task Tiers');
  const text = lines.join('\n');
  const bullet = (tier) => lines.find((line) => line.startsWith(`- **${tier}** —`)) ?? '';
  for (const phrase of [
    'security-relevant code (auth, permissions, secrets, sandboxing, policy, parsing untrusted input)',
    'live state or migrations',
    'changes spanning more than one plugin or system',
    'a public interface others depend on (CLI flags and exit codes, file formats, hook contracts, the plan format)',
    '`roles:complex-implementer`',
  ]) {
    assert.ok(bullet('heavy').includes(phrase), `the heavy bullet lacks "${phrase}"`);
  }
  assert.match(bullet('heavy'), /any of:/);
  for (const phrase of [
    'only: docs, comments, config values, version bumps, renames with no behavior change',
    'within the light code allowance (at most 20 added+removed lines in total, test lines included, no new file, no prompt-like Markdown, no sensitive path)',
  ]) {
    assert.ok(bullet('light').includes(phrase), `the light bullet lacks "${phrase}"`);
  }
  assert.ok(bullet('standard').includes('everything else'), 'the standard bullet lacks "everything else"');
  for (const phrase of [
    'all-or-none per plan',
    '`coordinator` tasks must be `light`',
    '`roles:complex-implementer` tasks `heavy`',
    '**Sensitive paths:** <glob>, <glob>',
    'raise a tier at run time, never lower it',
  ]) {
    assert.ok(text.includes(phrase), `## Task Tiers does not state "${phrase}"`);
  }
});

test('the plan self-review and audit check tiers', () => {
  const item = section(PLANS, '## Self-Review').find((line) => line.startsWith('**7. Tiers:**'));
  assert.ok(item, 'the plan Self-Review has no **7. Tiers:** item');
  assert.match(section(PLANS, '## Plan Audit').join(' '), /tier/i, 'the Plan Audit does not mention tiers');
});

test('the audit prompt flags tier defects in plans', () => {
  const lines = read(AUDIT).split('\n');
  const raw = lines.find((line) => line.trim().startsWith('| Tiers |'));
  assert.ok(raw, 'the audit prompt has no | Tiers | row');
  const neighbour = lines.find((line) => line.trim().startsWith('| Task format |'));
  assert.ok(neighbour, 'the audit prompt has no | Task format | row to compare indentation with');
  const indent = (line) => line.match(/^ */)[0];
  assert.equal(indent(raw), indent(neighbour), 'the | Tiers | row is not indented like the other rows of the prompt block');
  assert.equal(
    raw.trim(),
    '| Tiers | A task tiered lower than its content justifies by the rubric; a plan with tiers on some tasks only; a coordinator task not light; a complex-implementer task not heavy |',
  );
});

// A sensitive path makes a task heavy (spec U4): the header field is the only place a plan author learns that.
test('sensitive paths make a task heavy, on top of the default set, and a big diff does too', () => {
  const defaults = ['**/hooks/**', '**/setup/**', '**/*schema*', '**/migrations/**', '**/drizzle/**', '.github/**', 'plugins/workflow-gate/**'];
  const header = block(section(PLANS, '## Plan Document Header'), '**Sensitive paths:**');
  assert.match(header, /makes a task `heavy`/, 'the header field does not say the paths make a task heavy');
  assert.match(header, /added to the default set/, 'the header field does not say the paths are added to the default set');
  assert.doesNotMatch(header, /no `light` task may touch/, 'the header field still gives the old light-exclusion meaning');
  const tiers = section(PLANS, '## Task Tiers');
  assert.doesNotMatch(tiers.join(' '), /the paths no light task may touch/, '## Task Tiers still gives the old light-exclusion meaning');
  const rule = tiers.find((line) => line.includes('touches a sensitive path'));
  assert.ok(rule, '## Task Tiers does not say that touching a sensitive path makes a task heavy');
  assert.match(rule, /heavy/);
  assert.match(rule, /300 changed lines/, 'the sensitive-path sentence does not state the 300 changed lines rule');
  for (const glob of defaults) assert.ok(rule.includes(`\`${glob}\``), `the sensitive-path sentence lacks the default glob ${glob}`);
  const item = section(PLANS, '## Self-Review').find((line) => line.startsWith('**7. Tiers:**'));
  assert.match(item, /touches a sensitive path/, 'Self-Review item 7 does not check a sensitive path for heavy');
  assert.doesNotMatch(item, /stay clear of the plan's/, 'Self-Review item 7 still checks light tasks against the old rule');
});
