// Spec and plan format (stacked execution): brainstorming writes Units and Delivery Slices, writing-plans writes
// phases of one-commit tasks. Texts of the skills are checked, not behavior; later tasks extend this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPhases, readTasks } from '../skills/executing-plans/scripts/lib/plan.mjs';

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

test('writing-plans tells the author what parallel tasks need: complete Files lists and a node Test path', () => {
  const text = readFileSync(join(SKILLS, PLANS), 'utf8').replace(/\s*\n\s*/g, ' ');
  assert.ok(text.includes('`**Files:**` also decides which tasks run side by side'), 'writing-plans does not say Files decides parallel runs');
  assert.ok(text.includes('list every file the task creates, modifies or tests'), 'writing-plans does not ask for complete Files lists');
  assert.ok(text.includes('`Test:` path that is one exact file ending `.mjs`, `.js` or `.cjs`'), 'writing-plans does not name the node Test path a parallel task needs');
  assert.ok(text.includes('it runs sequentially'), 'writing-plans does not say what a task without one does');
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

// Execution Handoff (spec U2, R7): one message says the stack, the push and who merges; there is no method to choose.
test('the handoff states the stack and the push authorization, and offers one execution skill', () => {
  const text = section(PLANS, '## Execution Handoff').join(' ').replace(/\s+/g, ' ');
  const message = '**"Plan complete and saved to `<plan path>`.';
  const required = '**REQUIRED SUB-SKILL:** Use methodology:executing-plans';
  for (const marker of [message, required]) assert.ok(text.includes(marker), `the handoff lost "${marker}"`);
  const body = text.slice(text.indexOf(message), text.indexOf(required));
  for (const phrase of ['stack', 'phase branches', 'draft PR', 'authorizes', 'ready for review after the final review', 'merging stays yours', 'Confirming']) {
    assert.ok(body.includes(phrase), `the handoff message does not say "${phrase}"`);
  }
  // Plans run through subagents only: no second method, no approach to choose, no Native or inline option.
  for (const gone of ['Subagent-driven', 'Native', 'execution method', 'execution approach', 'Choosing', 'inline', 'If Subagent', 'If Native']) {
    assert.ok(!text.includes(gone), `the handoff still offers a choice ("${gone}")`);
  }
  // The text above the message names who records the authorization.
  const intro = text.slice(0, text.indexOf(message));
  for (const phrase of ['stack', 'authorizes', 'phase branches', 'draft PRs', 'ready for review after the final review', 'the execution skill records it', 'merging stays your human partner']) {
    assert.ok(intro.includes(phrase), `the handoff introduction does not say "${phrase}"`);
  }
});

test('the plan header names only executing-plans', () => {
  const header = section(PLANS, '## Plan Document Header').join('\n');
  const line = header.split('\n').find((l) => l.startsWith('> **For agentic workers:**'));
  assert.ok(line, 'the header lost its agentic-workers line');
  assert.ok(line.includes('REQUIRED SUB-SKILL: Use methodology:executing-plans to implement this plan task-by-task.'), line);
  assert.doesNotMatch(line, /recommended|\bor methodology:/, 'the header still offers a second skill');
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
    'security-relevant code (auth, permissions, secrets, sandboxing, policy engines, parsing untrusted input, gate/enforcement hooks)',
    'live state or migrations (stores, schemas, installed setup)',
    'a contract other code parses (hook I/O, file formats, the plan format, machine-read CLI output)',
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
  assert.match(item, /more than 80% of (?:its|the plan's) tasks[^.]*`heavy`[^.]*at least 5 tasks/, 'item 7 does not re-check a mostly heavy plan');
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

// Task Roles (spec decisions 3-4): three roles; review-fixer is the orchestrator's, never a plan task's.
test('## Task Roles lists the three task roles and keeps review-fixer out', () => {
  const lines = section(PLANS, '## Task Roles');
  const bullets = lines.filter((line) => line.startsWith('- '));
  assert.equal(bullets.length, 3, `## Task Roles lists ${bullets.length} roles`);
  const [tdd, complex, coordinator] = bullets;
  assert.ok(tdd.startsWith('- `roles:tdd-implementer`') && tdd.includes('default'), tdd);
  assert.ok(complex.startsWith('- `roles:complex-implementer`') && complex.includes('heavy'), complex);
  assert.ok(coordinator.startsWith('- `coordinator`'), coordinator);
  for (const phrase of ['light', 'small', 'probes', 'rollout', 'user checkpoints']) {
    assert.ok(coordinator.includes(phrase), `the coordinator bullet does not say "${phrase}"`);
  }
  // A coordinator task is always light, and a migration is heavy: a migration is no coordinator work.
  assert.doesNotMatch(coordinator, /migrat/i, 'the coordinator bullet lists migrations, which are heavy, as light work');
  assert.ok(coordinator.includes('every `coordinator` task is `light`'), coordinator);
  const text = lines.join(' ');
  assert.ok(lines.some((line) => line.startsWith('Every task gets a `**Role:**` line naming the role that does its work.')), 'the section does not say every task gets a **Role:** line');
  assert.ok(text.includes('A plan without the line reads as `roles:tdd-implementer`, but write it for every task anyway.'), 'the section lost the default-role sentence');
  // Spec decision 5: live-state work and migrations are heavy and never coordinator work; the role follows the complex-implementer criteria, not a blanket rule.
  assert.match(text, /migrations? are never coordinator work: they are `heavy`, and the role is chosen by the criteria above/, 'the section does not say live-state work and migrations are heavy, with the role chosen by the criteria above');
  assert.doesNotMatch(text, /usual role/, 'the section still names complex-implementer as the usual role for live-state work');
  assert.doesNotMatch(text, /migrations?\b[^.]*\btake `roles:complex-implementer`/, 'the section makes complex-implementer mandatory for live-state work and migrations');
  assert.match(text, /`## After Merge`/, 'the section does not send merged-trunk operations to ## After Merge');
  assert.ok(!bullets.some((line) => line.includes('review-fixer')), '`roles:review-fixer` is still listed as a task role');
  assert.match(text, /`roles:review-fixer` is never a task role/, 'the section does not say review-fixer is never a task role');
  assert.match(text, /fix rounds/, 'the section does not say who takes the fix rounds');
});

test('the plan states test-first for behavior changes at any tier, and a verification step otherwise', () => {
  const para = section(PLANS, '## Task Structure').find((line) => line.startsWith('Test-first applies'));
  assert.ok(para, 'the Task Structure notes lost the test-first paragraph');
  // The whole first sentence, so a rewrite that exempts a tier ("except light") fails.
  assert.ok(para.startsWith('Test-first applies to every task that changes behavior, at any tier. '), `the test-first paragraph opens differently: ${para.slice(0, 90)}`);
  for (const phrase of ['at any tier', 'no behavior change', 'replaces the test steps with a verification step', 'the command to run and the output that means it passed']) {
    assert.ok(para.includes(phrase), `the test-first paragraph does not say "${phrase}"`);
  }
});

test('writing-plans carries no per-skill credit footer (the credit lives in NOTICE and the READMEs)', () => {
  assert.doesNotMatch(read(PLANS), /superpowers|LICENSE-superpowers/);
});

test('writing-plans names no retired skill and no second execution skill', () => {
  const text = read(PLANS);
  for (const gone of ['using-git-worktrees', ['subagent', 'driven', 'development'].join('-'), 'requesting-code-review', 'writing-skills', 'Native']) {
    assert.ok(!text.includes(gone), `writing-plans still mentions ${gone}`);
  }
  assert.match(section(PLANS, '## Plan Document Header').join('\n'), /^> \*\*For agentic workers:\*\* REQUIRED SUB-SKILL: Use methodology:executing-plans /m);
});

// Restored contract pins (they lived in the retired execution tests): each is a promise the skill still makes.
test('the task template carries one Role line and the Skills line is skipped silently', () => {
  const template = section(PLANS, '## Task Structure');
  assert.equal(template.filter((line) => line.startsWith('**Role:**')).length, 1, 'the task template has not exactly one **Role:** line');
  assert.equal(template.filter((line) => line.startsWith('**Tier:**')).length, 1);
  const skills = template.find((line) => line.startsWith('- `**Skills:**`'));
  assert.ok(skills, 'the Task Structure notes have no **Skills:** bullet');
  for (const phrase of ['When headjack is installed', 'triqual suggest "<the task\'s text>" --json', 'per task', 'suggestions[].slug', 'exit 3', 'headjack is not installed', 'empty output', 'exit 127', 'omit the line silently']) {
    assert.ok(skills.includes(phrase), `the Skills bullet does not say "${phrase}"`);
  }
});

test('the plan audit is always the adversarial reviewer', () => {
  const audit = section(PLANS, '## Plan Audit').join(' ');
  assert.ok(audit.includes('dispatch `roles:final-adversarial-reviewer` with `../brainstorming/spec-document-reviewer-prompt.md` on the plan and its spec'), audit);
  assert.ok(audit.includes('runs on every plan, and no other reviewer takes its place'), audit);
});

test('Register the Plan: ledger init, the local --adopt route, and the store entry without a commit', () => {
  const lines = section(PLANS, '## Register the Plan');
  const step = (n) => lines.find((line) => line.startsWith(`${n}. `)) ?? assert.fail(`## Register the Plan has no step ${n}`);
  const [one, two, three, four] = [1, 2, 3, 4].map(step);
  for (const phrase of ['triqual tasks init <plan>', '"mode": "local"', 'triqual tracking write plan <draft>', 'triqual tasks init --adopt <draft>', '--replace', '"mode": "store"']) {
    assert.ok(one.includes(phrase), `registration step 1 does not say "${phrase}"`);
  }
  for (const phrase of ['triqual tracking write entry <draft>', 'triqual tracking add <draft> --no-commit', 'no commit']) {
    assert.ok(two.includes(phrase), `registration step 2 does not say "${phrase}"`);
  }
  for (const phrase of ['triqual tracking write status <draft>', 'triqual tracking status set --section <heading> <draft>']) {
    assert.ok(three.includes(phrase), `registration step 3 does not say "${phrase}"`);
  }
  for (const phrase of ['"mode": "committed"', 'no tracking file is staged or committed']) {
    assert.ok(four.includes(phrase), `registration step 4 does not say "${phrase}"`);
  }
  assert.match(lines.join(' '), /when not opted in, skip this section/);
});

test('plans are saved by tracking mode: not opted in writes no tracking file', () => {
  const head = read(PLANS).split('\n## Scope Check')[0].replace(/\s+/g, ' ');
  for (const phrase of ['triqual tasks paths --json', '"optedIn": true', '`plansDir`', '`docs/plans/`', 'never create `progress.md`', 'exit 3', 'handle it as not opted in', '"mode": "local"', 'mktemp -d', 'triqual tracking write plan <draft>', '"mode": "store"', 'Never write or edit under `.git/`']) {
    assert.ok(head.includes(phrase), `the save-plans text does not say "${phrase}"`);
  }
});

// Leaner execution (spec: Planning): heavy is narrow and carries a one-line reason; complex-implementer needs a named reason.
const RUBRIC_PHRASES = ['a contract other code parses', 'the line under'];
test('## Task Tiers: heavy is security, live state, a parsed contract or complex-implementer, with a reason line', () => {
  const tiers = section(PLANS, '## Task Tiers').join('\n');
  for (const phrase of RUBRIC_PHRASES) assert.ok(tiers.includes(phrase), `## Task Tiers lacks "${phrase}"`);
  assert.ok(!tiers.includes('changes spanning more than one plugin or system'), '## Task Tiers still makes a multi-plugin change heavy');
  assert.ok(!tiers.includes('a public interface others depend on'), '## Task Tiers still makes any public interface heavy');
  const rubric = readFileSync(join(SKILLS, 'executing-plans/SKILL.md'), 'utf8').split('\n').find((line) => line.startsWith('- **The tier rubric**'));
  assert.ok(rubric, 'executing-plans has no tier rubric line');
  for (const phrase of [...RUBRIC_PHRASES, 'gate/enforcement hooks']) assert.ok(rubric.includes(phrase), `the executing-plans rubric lacks "${phrase}"`);
  assert.ok(!rubric.includes('changes spanning more than one plugin or system'), 'the executing-plans rubric still makes a multi-plugin change heavy');
});

test('complex-implementer needs a named reason', () => {
  const text = section(PLANS, '## Task Roles').join(' ');
  for (const phrase of ['a live-state migration', 'one brief cannot describe']) assert.ok(text.includes(phrase), `## Task Roles lacks "${phrase}"`);
});

test('the Task Structure template and Self-Review ask for the reason line', () => {
  const template = section(PLANS, '## Task Structure');
  const tier = template.indexOf('**Tier:** heavy');
  assert.ok(/^[^*\s]/.test(template[tier + 1]) && template[tier + 1] !== '', 'the template has no reason line directly under **Tier:** heavy');
  const item = section(PLANS, '## Self-Review').find((line) => line.startsWith('**7. Tiers:**'));
  assert.match(item, /reason line/, 'Self-Review item 7 does not ask for the reason line');
});

test('a reason line under Tier and Role is ignored by the plan parser', () => {
  const plan = (reasons) => [
    '# X Implementation Plan',
    '',
    '### Task 1: First',
    '',
    '**Tier:** heavy',
    ...(reasons ? ['Security: parses hook input.'] : []),
    '**Role:** roles:complex-implementer',
    ...(reasons ? ['Live-state migration of the store.'] : []),
    '',
    '### Task 2: Second',
    '',
    '**Tier:** light',
    '**Role:** coordinator',
    '',
  ].join('\n');
  const [t1] = readTasks(plan(true));
  assert.equal(t1.tier, 'heavy');
  assert.equal(t1.role, 'roles:complex-implementer');
  const strip = ({ start, end, ...rest }) => rest;
  assert.deepEqual(readTasks(plan(true)).map(strip), readTasks(plan(false)).map(strip));
});

test('the plan audit flags over-tiering and unjustified complex-implementer', () => {
  const audit = section(PLANS, '## Plan Audit').join(' ').replace(/\s+/g, ' ');
  assert.ok(audit.includes('tiered higher than'), 'the Plan Audit does not flag a task tiered higher than its content justifies');
  assert.match(audit, /complex-implementer[^.]*reason/, 'the Plan Audit does not flag a complex-implementer task without a matching reason');
  assert.match(audit, /both tier checks[^.]*dispatch[^.]*auditor/, 'the Plan Audit does not say the dispatch to the auditor states both tier checks');
});

test('reads the Test paths header line', () => {
  const plan = '# X Implementation Plan\n\n**Branch prefix:** x\n**Test paths:** spec/**, e2e/**\n\n## Phase 1: A\n\n**PR title:** t\n**Branch:** x/01-a\n\n### Task 1: A\n';
  assert.deepEqual(readPhases(plan, 'x').testPaths, ['spec/**', 'e2e/**']);
});

test('testPaths is empty without the line', () => {
  const plan = '# X Implementation Plan\n\n**Branch prefix:** x\n\n## Phase 1: A\n\n**PR title:** t\n**Branch:** x/01-a\n\n### Task 1: A\n';
  assert.deepEqual(readPhases(plan, 'x').testPaths, []);
});
