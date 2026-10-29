// Contract pins for the orchestrator, `executing-plans` (design U3, U4, Decision 9): the tier matrix equals spec U4,
// the invariants (a tier is never lowered, the gate on every task with commits, the final review always runs, a
// behavior change starts with a failing test), the role-eval record examples validate, every template placeholder is
// defined, batched light dispatch, the tierless setup rubric, the dispatch-line pins restored from the retired
// fork.test, the retirement of the old execution skill and its per-task scripts, the harness references, and the
// behavior of the live scripts (review-package, task-brief, sdd-workspace) in a temp repo. They pin rules, not
// prose: each check names the sentence or table that carries a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePlan } from '../../progress-tracking/lib/ledger.mjs';
import { validateRecord } from '../cli/lib/role-eval.mjs';
import { readSkillText } from './skill-text.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(PLUGIN, 'skills');
const SCRIPTS = join(SKILLS, 'executing-plans', 'scripts');
const FENCES_PLAN = join(PLUGIN, 'test', 'fixtures', 'fences-plan.md');
const AGENTS = join(PLUGIN, '..', 'roles', 'agents');
const EP = 'executing-plans';
const TEMPLATES = [
  'implementer-prompt.md',
  'hunter-prompt.md',
  'safety-review-prompt.md',
  'task-reviewer-prompt.md',
  're-review-prompt.md',
  'final-review-prompt.md',
  'orchestrator-prompt.md',
];
// The implementer's `<task role>` placeholder is a valid dispatch type in its own template only.
const TASK_ROLE_TEMPLATES = new Set([`${EP}/implementer-prompt.md`]);

const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const skill = () => readSkillText(join(SKILLS, EP));
const ROLE_AGENTS = new Set(
  readdirSync(AGENTS).filter((n) => n.endsWith('.md')).map((n) => `roles:${n.slice(0, -3)}`),
);

test('skill() includes the references directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-text-'));
  try {
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n\nmain text\n');
    writeFileSync(join(dir, 'references', 'x.md'), '## Moved heading\n\nreference text\n');
    writeFileSync(join(dir, 'references', 'ignored.txt'), 'not markdown\n');
    const text = readSkillText(dir);
    assert.ok(text.startsWith('# Skill'), 'SKILL.md comes first');
    assert.ok(section(text, '## Moved heading').includes('reference text'), 'the reference heading is found');
    assert.ok(!text.includes('not markdown'), 'only *.md files are read');
    assert.ok(readSkillText(join(SKILLS, EP)).includes('## '), 'the real skill still reads');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The text of the section that starts at the heading line `heading` and runs to the next heading of the same or a
// higher level.
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `no heading ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const walk = (dir, rel = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), p) : [p];
  });

// Spec U4, verbatim: the review each effective tier gets.
const U4_HEADER = ['Effective tier', 'Round 1 (together)', 'Round 2', 'Fix-round re-review'];
const U4_ROWS = [
  [
    'heavy',
    'safety gate + `roles:spec-reviewer`, in parallel; no task hunters',
    'none: the spec review ran with the gate',
    'scoped re-review by the raising role(s), always',
  ],
  [
    'standard',
    'safety gate + `roles:spec-reviewer`, in parallel; no hunters',
    'none: the spec review ran with the gate',
    'scoped re-review, except a fix that applies an approved `Ruling:` verbatim and touches no security logic',
  ],
  [
    'light',
    'safety gate',
    'none, unless the gate reports a finding or `Cannot verify` (then `roles:spec-reviewer` runs on that item)',
    'the gate re-checks',
  ],
];

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

test('the tier matrix in the skill equals spec U4', () => {
  const lines = skill().split('\n');
  const at = lines.findIndex((l) => l.startsWith('|') && cells(l).join('|') === U4_HEADER.join('|'));
  assert.ok(at >= 0, 'no table with the U4 header');
  assert.match(lines[at + 1], /^\|(\s*-{3,}\s*\|){4}$/);
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
  assert.deepEqual(rows, U4_ROWS);
});

// ---- per-task review sizes (design: Review structure, "Per task") ----

test('per-task review has no hunters at any tier: heavy and standard run the gate and the spec review, light the gate', () => {
  const lines = skill().split('\n');
  const at = lines.findIndex((l) => l.startsWith('|') && cells(l).join('|') === U4_HEADER.join('|'));
  const rows = Object.fromEntries(lines.slice(at + 2, at + 5).map((l) => [cells(l)[0], cells(l)[1]]));
  assert.doesNotMatch(skill(), /2 hunters:/, 'a Tiers row still sends 2 hunters');
  assert.ok(rows.heavy.includes('safety gate + `roles:spec-reviewer`') && rows.heavy.includes('no task hunters'), 'the heavy row is not the gate + the spec review with no task hunters');
  assert.ok(rows.standard.includes('safety gate + `roles:spec-reviewer`') && rows.standard.includes('no hunters'), 'the standard row sends hunters');
  assert.doesNotMatch(rows.light, /hunter/, 'the light row names hunters');
  const tiers = flat(section(skill(), '## Tiers'));
  assert.ok(tiers.includes('**Hunters run at the phase review only:**'), 'Tiers does not say hunters run at the phase review only');
  assert.doesNotMatch(tiers, /Hunters belong to the heavy tier only|a heavy task sends exactly two/, 'Tiers still sends hunters with a heavy task');
  assert.ok(
    tiers.includes('`heavy` still picks the role (`roles:complex-implementer`) and is still recorded and raised by `tier-check`, but its per-task review is capped at `standard`'),
    'Tiers does not cap the heavy per-task review at standard',
  );
  const round1 = flat(section(skill(), '#### Round 1'));
  assert.doesNotMatch(round1, /Review Focus names for the task/, 'Round 1 still picks a standard hunter from the Review Focus');
  const heavy = round1.slice(round1.indexOf('**Heavy:**'), round1.indexOf('**Standard:**'));
  assert.ok(heavy.includes('no hunters') && heavy.includes('`roles:safety-reviewer`') && heavy.includes('`roles:spec-reviewer`'), 'the heavy Round 1 dispatch is not the gate and the spec review with no hunters');
  assert.doesNotMatch(heavy, /2 hunters/, 'the heavy Round 1 dispatch still sends 2 hunters');
});

test('standard dispatches the gate and the spec review in parallel', () => {
  const round1 = flat(section(skill(), '#### Round 1'));
  const standard = round1.slice(round1.indexOf('**Standard:**'), round1.indexOf('**Light:**'));
  assert.ok(standard.includes('**Standard:**') && standard.includes('`roles:safety-reviewer`') && standard.includes('`roles:spec-reviewer`'), 'Round 1 does not dispatch the gate and the spec reviewer for standard');
  assert.ok(standard.includes('together') && standard.includes('in one message'), 'the standard dispatch is not one message');
  assert.ok(standard.includes('no hunters'), 'the standard dispatch does not say there are no hunters');
  const round2 = flat(section(skill(), '#### Round 2'));
  const heavy2 = round2.slice(round2.indexOf('**Heavy:**'), round2.indexOf('**Standard:**'));
  assert.ok(heavy2.includes('already ran') && heavy2.includes('verdicts 0/0'), 'Round 2 does not treat heavy like standard, the spec review already ran');
  assert.ok(round2.includes('**Standard:**') && round2.includes('already ran'), 'Round 2 does not say the standard spec review already ran');
});

test('the phase review still sends 3 hunters while the task review sends none', () => {
  const round1 = flat(section(skill(), '### 8. Review the phase')).split('- **Round 1, the hunters.**')[1].split('- **Round 2')[0];
  assert.ok(round1.includes('3 hunters') && round1.includes('`correctness`, `security` and `spec-drift`'), 'the phase review does not name the 3 hunters');
});

test('the default Phase check is the union of the phase\'s Test: paths, run focused', () => {
  const check = flat(section(skill(), '### 7. End the phase')).split('- **Phase check.**')[1].split('- **A submitted phase')[0];
  assert.ok(check.includes('the union of the phase\'s `Test:` paths'), 'the Phase check default does not name the union of the phase\'s Test: paths');
  assert.ok(check.includes('Run the phase\'s `**Phase check:**` command at the tip of the phase branch'), 'the Phase check lost its explicit command');
  assert.doesNotMatch(check, /is one phase whose check is the repository's full test command/, 'the Phase check default is still the full test command');
});

test('the orchestrator prompt states the per-task review: light the gate, standard and heavy the gate and the spec review, no task hunters', () => {
  const text = flat(PROMPT());
  assert.ok(text.includes('light task gets the safety gate alone'), 'the orchestrator prompt does not give a light task the gate alone');
  assert.ok(text.includes('standard or heavy task gets the safety gate and `roles:spec-reviewer` in one round'), 'the orchestrator prompt does not give standard and heavy the gate and the spec review in one round');
  assert.ok(text.includes('no task hunters: hunters run at the phase review only'), 'the orchestrator prompt does not say hunters run at the phase review only');
});

test('a fix round that raises a task to heavy sends no task hunters', () => {
  const loop = flat(section(skill(), '### 5. The fix loop'));
  assert.doesNotMatch(loop, /hunters included/, 'the fix loop still sends hunters with a raised tier\'s full review');
  assert.doesNotMatch(loop, /on the `hunters:` line/, 'the fix loop still reads the hunters: line of task-prep');
  assert.ok(loop.includes('fix rounds and re-reviews never send task hunters'), 'the fix loop does not say a raised tier sends no task hunters');
});

test('the test-driven-development skill verifies focused, never the project\'s full suite', () => {
  const tdd = flat(readSkillText(join(SKILLS, 'test-driven-development')));
  assert.doesNotMatch(tdd, /run the project's test command \(bare `pytest`/, 'the skill still tells the implementer to run the full test command');
  assert.doesNotMatch(tdd, /"Other tests" means the project's suite/, 'the skill still defines other tests as the project\'s suite');
  assert.ok(tdd.includes('`Test:` paths') && tdd.includes('modules that import what changed') && tdd.includes('typecheck and lint scoped to the touched files'), 'the skill does not state the focused verification rule');
  assert.ok(tdd.includes('CI runs the full suite'), 'the skill does not say CI runs the full suite');
});

test('the hunter template is for the phase review only', () => {
  const text = flat(read(`${EP}/hunter-prompt.md`));
  assert.doesNotMatch(text, /round 1 of a heavy task's review|a heavy task's second hunter|a standard or light task sends none/, 'the hunter template still dispatches a task-mode hunter');
  assert.ok(text.includes('only in a phase review'), 'the hunter template does not say hunters run only in a phase review');
});

test('Minor findings are deferred to the phase review', () => {
  const loop = flat(section(skill(), '### 5. The fix loop'));
  assert.ok(loop.includes('`Task <N>: minor (deferred): <one-liner>`, and the phase review (see 8. Review the phase) rules on them'), 'the fix loop does not defer Minor findings to the phase review');
  assert.doesNotMatch(loop, /the final review triages them/, 'the fix loop still defers Minor findings to the final review');
});

test('the spec reviewer prompt has no candidates section without hunters', () => {
  const raw = read(`${EP}/task-reviewer-prompt.md`);
  const text = flat(raw);
  const at = raw.indexOf('## Candidates to Verify');
  assert.ok(at >= 0, 'no Candidates to Verify section');
  const marker = flat(raw.slice(raw.lastIndexOf('\n', raw.lastIndexOf('\n', at) - 1), at));
  assert.ok(/include this section only when hunters ran/.test(marker), 'the candidates section is not conditional on hunters');
  assert.ok(text.includes('Drop the Candidates to Verify section and the Candidate Verdicts section for a standard or light task'), 'the header does not say to drop the candidates sections');
  assert.ok(/\[CANDIDATE_VERDICTS[^\]]*only when hunters ran[^\]]*\]/.test(text), 'the Candidate Verdicts output section is not conditional on hunters');
  assert.ok(text.includes('only when hunters ran'), 'the CANDIDATES_FILES placeholder is not conditional');
  assert.doesNotMatch(text, /"None" when there are no candidates\./, 'the verdicts section still answers None without hunters');
});

test('the Finish hunter reference uses the new counts', () => {
  const finish = flat(section(skill(), '## Finish'));
  assert.ok(finish.includes('0 per task at every tier, plus 3 per phase, 0 for the seams review'), 'Finish does not state the per-task and phase counts');
  assert.doesNotMatch(finish, /2 per heavy task|4 per heavy task, 2 per standard/, 'Finish still states the old counts');
  assert.doesNotMatch(finish, /plus 4 per phase/, 'Finish still states 4 hunters per phase');
  assert.ok(finish.includes('reference 4 before 2026-10-29, 3 after'), 'Finish does not note that the phase reference changed on 2026-10-29');
});

test('the hunters rule no longer sends state in a phase review', () => {
  const raw = skill();
  const round1 = flat(section(raw, '### 8. Review the phase')).split('- **Round 1, the hunters.**')[1].split('- **Round 2')[0];
  assert.ok(round1.includes('3 hunters') && round1.includes('`correctness`, `security` and `spec-drift`'), 'the phase review does not send the three calibrated hunters');
  assert.doesNotMatch(round1, /`state`/, 'the phase review still sends a state hunter');
  assert.doesNotMatch(flat(raw), /\b(4|four) hunters/, 'SKILL.md still says a phase review sends four hunters');
  const prompt = flat(read(`${EP}/hunter-prompt.md`));
  assert.doesNotMatch(prompt, /\b(4|four) hunters/, 'hunter-prompt.md still says four hunters');
  assert.ok(prompt.includes('A phase review sends a `correctness` hunter, which covers correctness, state and spec drift together, and a `security` hunter only when the phase range touches a sensitive path'), 'hunter-prompt.md does not name the merged correctness hunter and the security condition');
  const finalPrompt = flat(read(`${EP}/final-review-prompt.md`));
  assert.doesNotMatch(finalPrompt, /four hunters|\(`correctness`, `security`, `spec-drift`, `state`\)/, 'final-review-prompt.md still names four hunters');
  assert.ok(finalPrompt.includes('three hunters (`correctness`, `security`, `spec-drift`)'), 'final-review-prompt.md does not name the three hunters');
  // The task level sends no hunter: the phase review is the only place hunters run.
  assert.doesNotMatch(flat(section(raw, '## Tiers')), /`state` when it names live state/, 'the task-level state hunter pick remains');
  const records = flat(read(`${EP}/references/records.md`));
  assert.ok(records.includes('(reference 4 before 2026-10-29, 3 after,'), 'records.md does not state the phase reference of 3');
  assert.doesNotMatch(records, /"category": "state"/, 'the phase hunters record example still has a state hunter');
  assert.ok(records.includes('"budget": { "reference": 3, "used": 3, "overrun": false }'), 'the phase hunters record example does not budget 3');
  assert.doesNotMatch(flat(read(`${EP}/references/example.md`)), /4 hunters/, 'example.md still shows 4 hunters');
});

test('the invariants are stated in the skill', () => {
  const text = flat(skill());
  for (const line of [
    'A tier is never lowered',
    'Never skip the task review (the one exception is a task with no commit range: see When the stage does not run)',
    'every task with commits gets at least the safety gate',
    'The final review always runs',
    'A behavior change starts with a failing test',
  ]) {
    assert.ok(text.includes(line), `the skill lacks: ${line}`);
  }
});

test('plans run only through role agents: no inline mode', () => {
  const text = flat(skill());
  assert.ok(text.includes('Every plan task is done by a role agent'), 'no subagents-only rule');
  assert.ok(text.includes('never run a plan inline'), 'no rule against inline execution');
  assert.doesNotMatch(read(`${EP}/SKILL.md`).split('\n').slice(0, 5).join('\n'), /inline execution|as the implementer yourself/);
});

test('TDD is required for every task, in the skill and the implementer template', () => {
  assert.ok(flat(skill()).includes('TDD is required on every task'), 'the skill does not require TDD on every task');
  const impl = flat(read(`${EP}/implementer-prompt.md`));
  assert.ok(impl.includes('Write the failing test first'), 'the implementer template does not put the test first');
  assert.doesNotMatch(impl, /following TDD if task says to/);
});

test('the role-eval record examples in the skill validate, and cover task-review, final-escapes and a post-merge escape (no final hunters)', () => {
  const blocks = [...skill().matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 3, 'fewer than three record examples');
  assert.ok(blocks.some((r) => r.task === 'P1'), 'no P1 phase record example');
  for (const record of blocks) assert.deepEqual(validateRecord(record), { ok: true }, JSON.stringify(record));
  const kinds = blocks.map((r) => `${r.kind}:${r.task === 'final' ? 'final' : 'task'}`);
  for (const k of ['task-review:task', 'final-escapes:final', 'escape:task']) assert.ok(kinds.includes(k), `no ${k} example`);
  assert.ok(!kinds.includes('hunters:final'), 'Records still carries a final hunters example');
  assert.ok(flat(skill()).includes('`triqual role-eval record --plan <plan file> <json-file>`'));
});

test('a task-review record example with an unknown key would be refused (the examples are checked for real)', () => {
  const [example] = [...skill().matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((m) => JSON.parse(m[1]))
    .filter((r) => r.kind === 'task-review');
  assert.ok(example, 'no task-review example');
  assert.deepEqual(validateRecord({ ...example, note: 'x' }), { ok: false, field: 'note' });
  assert.deepEqual(validateRecord({ ...example, tier: 'light', declaredTier: 'standard', raised: false }), { ok: false, field: 'tier' });
});

// The placeholders the controller fills in a template: every `[...]` before the Placeholders list, in any case, except a
// markdown link, an empty `[]` (JSON paths) and the Output Format sections the subagent itself fills. `[KEY — note]`
// is the placeholder `KEY`.
function placeholdersUsed(body) {
  const used = new Set();
  let output = false;
  for (const line of body.split('\n')) {
    if (/^\s*#{2,4} Output Format\s*$/.test(line)) output = true;
    if (/^```\s*$/.test(line)) output = false;
    if (output) continue;
    for (const m of line.matchAll(/\[([^[\]\n]+)\](?!\()/g)) used.add(m[1].split(' — ')[0].trim());
  }
  return used;
}

test('the placeholder check sees lowercase placeholders and skips links and output sections', () => {
  const used = placeholdersUsed(
    [
      'Do [task name] in [WORK_DIR], see [a link](x.md), paths plans[].tasks[].',
      '[TRACKING — a note]',
      '    ## Output Format',
      '    [What the reviewer fills]',
      '```',
      'After [AFTER].',
    ].join('\n'),
  );
  assert.deepEqual([...used].sort(), ['AFTER', 'TRACKING', 'WORK_DIR', 'task name']);
});

test('every template placeholder is defined in its Placeholders list', () => {
  for (const name of TEMPLATES) {
    const text = read(`${EP}/${name}`);
    const [body, defs] = text.split('**Placeholders:**');
    assert.ok(defs, `${name} has no Placeholders list`);
    const used = placeholdersUsed(body);
    const defined = new Set([...defs.matchAll(/^- `\[([^\]`]+)\]`/gm)].map((m) => m[1]));
    const missing = [...used].filter((p) => !defined.has(p));
    assert.deepEqual(missing, [], `${name}: placeholders used but not defined`);
    const unused = [...defined].filter((p) => !body.includes(`[${p}`));
    assert.deepEqual(unused, [], `${name}: placeholders defined but never used`);
  }
});

test('every template of executing-plans and the spec reviewer template start their dispatch with Subagent (<role>):', () => {
  const files = [...TEMPLATES.map((n) => `${EP}/${n}`), 'brainstorming/spec-document-reviewer-prompt.md'];
  for (const path of files) {
    const first = read(path).split('\n').find((l) => /Subagent\s*\(/.test(l));
    assert.ok(first, `${path} has no dispatch line`);
    const m = /^Subagent \(([^)]+)\):$/.exec(first.trim());
    assert.ok(m, `${path}: first dispatch line is not exactly Subagent (<role>): ${first}`);
    const ok = ROLE_AGENTS.has(m[1]) || (m[1] === '<task role>' && TASK_ROLE_TEMPLATES.has(path));
    assert.ok(ok, `${path}: ${m[1]} is not a role agent`);
  }
  const impl = read(`${EP}/implementer-prompt.md`).split('**Placeholders:**')[1];
  const roleLine = impl.split('\n').find((l) => l.startsWith('- `<task role>`'));
  assert.ok(roleLine, 'the implementer template does not define <task role>');
  for (const m of roleLine.matchAll(/roles:[a-z-]+/g)) assert.ok(ROLE_AGENTS.has(m[0]), `${m[0]} is not a role agent`);
});

test('every Subagent dispatch in any skill names a role agent', () => {
  const bad = [];
  for (const path of walk(SKILLS).filter((p) => p.endsWith('.md'))) {
    read(path).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:sub)?agent\s*\(([^)]*)\)\s*:/gi)) {
        const type = m[1].trim();
        const ok =
          ROLE_AGENTS.has(type) ||
          (type === '<task role>' && TASK_ROLE_TEMPLATES.has(path));
        if (!ok) bad.push(`${path}:${i + 1}: ${m[0]}`);
      }
      for (const m of line.matchAll(/\bSubagent\s*:/g)) bad.push(`${path}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('every triqual tasks move in the orchestrator carries --plan', () => {
  const move = /triqual tasks (?:start|review|rework|done|block|drop|reopen|restore|retitle|retier) T[^`;\]\n]*/g;
  const moves = [...skill().matchAll(move)].map((m) => m[0]);
  assert.ok(moves.length >= 8, 'the orchestrator names too few ledger moves');
  assert.deepEqual(moves.filter((m) => !/ --plan \S/.test(m)), [], 'ledger moves without --plan');
});

test('the workspace ledger is sdd-ledger.md, with the Tier lines in its vocabulary', () => {
  const text = skill();
  assert.ok(text.includes('`<workspace>/sdd-ledger.md`'), 'the skill does not name <workspace>/sdd-ledger.md');
  const vocab = flat(section(text, '## Ledger vocabulary'));
  for (const line of [
    '`Tier: T<N> <tier>`',
    '`Tier raised: T<N> <from> → <to> — <reason>`',
    '`Task <N>: complete (commits <base7>..<head7>, review clean)`',
    '`Task <N>: minor (deferred): <one-liner>`',
    '`Ruling: <what you decided> — <why> — <what it costs if wrong>`',
    '`Unrecorded: <record JSON>`',
    '`RateLimit: <role> <time>`',
  ]) {
    assert.ok(vocab.includes(line), `the vocabulary lacks ${line}`);
  }
});

test('batched light dispatch resumes one implementer one task at a time, BASE recorded before each resume', () => {
  const text = flat(section(skill(), '#### Batched light dispatch'));
  for (const line of [
    'consecutive light tasks of one phase whose role is `roles:tdd-implementer`',
    'resume that same implementer for each next task',
    'One task at a time',
    "only after the previous task's review and `task-close` finished",
    'its own BASE (recorded from `HEAD`, the squashed commit of the previous task)',
    '`task-prep`, the review and `task-close` stay per task',
    'A task that `tier-check` raises above light ends the batch',
    'gets a fresh dispatch',
  ]) {
    assert.ok(text.includes(line), `batched light dispatch lacks: ${line}`);
  }
});

test('setup tiers a tierless plan by the rubric with tasks retier, and a tierless complex-implementer task becomes heavy', () => {
  const text = flat(section(skill(), '### Tiers at setup'));
  for (const line of [
    'rubric',
    '`triqual tasks retier T<N> <tier> --plan <plan> --reason "<text>"`',
    'raising only',
    'a tierless `roles:complex-implementer` task becomes heavy',
    'reads as `standard`',
  ]) {
    assert.ok(text.includes(line), `the setup tiering lacks: ${line}`);
  }
});

test('tier-check runs before the review and again on every fix round, and a raise is recorded before the review', () => {
  const text = flat(skill());
  assert.ok(text.includes('`node scripts/tier-check PLAN_FILE N BASE HEAD --floor <tier>`'));
  assert.ok(text.includes('a raise is recorded with `triqual tasks retier` before the review'));
  assert.ok(text.includes("`tier-check` runs again on each round's `FIX_BASE..HEAD` and on the cumulative `BASE..HEAD`"));
});

test('a fix round passes --fix-round on its FIX_BASE..HEAD check, so code added by a fix raises a light task', () => {
  const text = flat(skill());
  assert.ok(text.includes("`node scripts/tier-check PLAN_FILE N FIX_BASE HEAD --floor <tier> --fix-round`"));
  assert.ok(text.includes('`--fix-round`: with a light floor, any change outside the light classes raises to standard'));
  assert.ok(text.includes('the cumulative `BASE..HEAD` check never carries it'));
  assert.ok(text.includes('the re-review follows the higher tier'));
});

// Each kept SDD behavior is pinned in the section that carries it, not in the summary at the top of the skill.
test('the kept SDD behaviors are in their own sections', () => {
  const text = skill();
  const pins = {
    '### 1. Start the task': ['the `BASE: T<N> <sha>` ledger line (the last one counts)', 'BASE is never `HEAD~1`'],
    '### 4. Review the task': ['on one review package'],
    '#### Round 2': ['**Heavy:** as Standard: the spec review already ran with the gate in round 1', '`Round 2: T<N> — light items <n>`'],
    '### 5. The fix loop': ['`Task <N>: minor (deferred): <one-liner>`', 'after round 5 the task is blocked'],
    '### 6. Complete the task': ['`git commit-tree`'],
    '### 7. End the phase': [
      "Run the phase's `**Phase check:**` command at the tip of the phase branch",
      'A failure that passes on one re-run is flaky',
      '`triqual tasks reopen T<N> "<reason>" --plan <plan>`',
    ],
    '### 8. Review the phase': [
      '`node scripts/stack.mjs done PLAN_FILE N`',
      '`node scripts/stack.mjs submit PLAN_FILE N`',
      'submit` exits 5',
    ],
    '## Finish': ['re-run `triqual role-eval record --plan <plan file> <json-file>` for every record that has an `Unrecorded:` line'],
  };
  for (const [heading, lines] of Object.entries(pins)) {
    const body = flat(section(text, heading));
    for (const line of lines) assert.ok(body.includes(line), `${heading} lacks: ${line}`);
  }
  const rate = flat(text.split('\n').find((l) => l.startsWith('**Rate limits.**')) ?? '');
  for (const line of ['wait in the bounded stretches above and retry the same dispatch', '`RateLimit: <role> <time>`', 'After about 6 stretches']) {
    assert.ok(rate.includes(line), `the rate-limit rule lacks: ${line}`);
  }
});

const breaker = () => flat(skill().split('\n').find((l) => l.startsWith('**The breaker.**')) ?? '');

test('after a block, the human decision restarts the task with tasks start before any done', () => {
  const text = breaker();
  assert.ok(text, 'no breaker paragraph');
  const block = text.indexOf('`triqual tasks block T<N>');
  const park = text.indexOf('**Park:**');
  const more = text.indexOf('**More rounds:**');
  assert.ok(block >= 0 && park > block && more > block, 'the breaker lacks the block move or one of the two decision paths');
  const parkText = text.slice(park, more > park ? more : undefined);
  const moreText = text.slice(more, park > more ? park : undefined);
  for (const [name, path] of [['park', parkText], ['more rounds', moreText]]) {
    const start = path.indexOf('`triqual tasks start T<N> --plan <plan>`');
    assert.ok(start >= 0, `${name}: no tasks start after the block`);
    const done = path.indexOf('done');
    if (done >= 0) assert.ok(start < done, `${name}: done before start`);
  }
  assert.ok(parkText.includes('step 6'), 'park does not go on to step 6');
  assert.ok(moreText.includes('`Ruling: human granted <K> rounds for T<N>'), 'more rounds has no ledgered grant');
  assert.ok(
    moreText.includes('`start` already moved the task to `in_progress` and `rework` only leaves `in_review`, so run `triqual tasks review T<N> --plan <plan>` before the first `task-prep PLAN_FILE N --fix-round`'),
    'more rounds does not move the task in_review before the first task-prep --fix-round (rework only leaves in_review)',
  );
  assert.doesNotMatch(text, /role-eval|`task-review` record/, 'the breaker writes a record (it is written once, at completion)');
});

test('a resumed session treats a blocked task as a stop, never a re-dispatch', () => {
  const ws = flat(section(skill(), '### Workspace and ledger'));
  assert.ok(ws.includes('A task whose last ledger line is its `Task <N>: blocked` line is the fifth stop again'), 'no blocked resume rule');
  assert.ok(ws.includes('never re-dispatched'));
  assert.ok(ws.includes('a task already `blocked`'), 'the resumed-state list lacks blocked');
});

test('every retier outside the examples is conditional on opting in', () => {
  const bad = [];
  let fence = false;
  for (const line of skill().split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (fence || !/retier/.test(line)) continue;
    for (const sentence of line.split(/(?<=[.;:])\s+(?=[A-Z*`(-])/)) {
      if (/retier/.test(sentence) && !/opted in|`retier` refuses/.test(sentence)) bad.push(sentence.slice(0, 120));
    }
  }
  assert.deepEqual(bad, []);
});

test('task-close does the done move, then the completion line, then the record, in that order; the record is written once', () => {
  const six = flat(section(skill(), '### 6. Complete the task'));
  const done = six.indexOf('`triqual tasks done T<N>');
  const complete = six.indexOf('`Task <N>: complete');
  const record = six.indexOf('the `task-review` record');
  assert.ok(done >= 0 && complete > done && record > complete, 'order is not done → complete line → record');
  const records = flat(section(skill(), '## Records'));
  assert.ok(records.includes('written once, by `task-close`, when the task completes'));
  assert.doesNotMatch(records, /and at the breaker/);
});

test('opted in, final-escapes and the totals read the effective tier from tasks export', () => {
  for (const heading of ['## Final Review', '## Finish']) {
    const body = flat(section(skill(), heading));
    assert.ok(body.includes('`effectiveTier` in `triqual tasks export --json` (opted in)'), `${heading} does not read the tier from triqual`);
  }
});

test('coordinator tasks: light, the controller as author, fixes go to roles:review-fixer', () => {
  const text = flat(section(skill(), '### Coordinator tasks'));
  for (const line of ['light', 'the light code allowance', 'with the controller as author', 'any fix round goes to `roles:review-fixer`, never to the controller']) {
    assert.ok(text.includes(line), `coordinator rules lack: ${line}`);
  }
});

test('the final review names the task of each traceable finding and records final-escapes', () => {
  const prompt = flat(read(`${EP}/final-review-prompt.md`));
  assert.ok(prompt.includes('the task it traces to'), 'the final review prompt does not ask for the task');
  const text = flat(section(skill(), '## Final Review'));
  assert.ok(text.includes('`final-escapes`'));
  assert.ok(text.includes('`roles:final-adversarial-reviewer`'));
});

// ---- the seams review (design: Review structure, "Seams review" and "Recording") ----

test('the final review is a seams review with no hunters', () => {
  const raw = skill();
  const final = flat(section(raw, '## Final Review'));
  // no final hunters: no hunter dispatch, no hunters record, no final candidates files
  assert.doesNotMatch(final, /3 hunters|the final hunters|final-candidates|`roles:hunter`/, 'the final review still dispatches hunters');
  assert.ok(final.includes('seams review') && final.includes('no hunters'), 'the final review does not say it is a seams review with no hunters');
  assert.doesNotMatch(flat(section(raw, '## Records')), /\*\*`hunters`\*\* with task `final`/, 'Records still has the final hunters example');
  // inputs: the spec, the plan, the full trunk..top package and the workspace ledger
  for (const line of ['the spec, the plan, the full `trunk..top` package and the workspace ledger (`sdd-ledger.md`)', 'node scripts/review-package PLAN_FILE MERGE_BASE HEAD']) {
    assert.ok(final.includes(line), `the seams review lacks the input: ${line}`);
  }
  // seams-only instruction
  for (const line of ['each phase already passed its own review', 'only at the interfaces one phase exposes and a later one consumes', 'cross-phase state', 'every `Ruling:`, deferred-minor and parked line still open']) {
    assert.ok(final.includes(line), `the seams-only instruction lacks: ${line}`);
  }
  // the same two-round fix rule as the phase review, then submit --open
  const fix = final.slice(final.indexOf('**Fix rounds.**'), final.indexOf('**Submit.**'));
  assert.ok(fix.length > 0, 'the seams review has no Fix rounds step before Submit');
  for (const line of ['at most two rounds of `roles:review-fixer`', 'a plain commit', '`fix: address final review findings`', 'never a `--fixup`', 'a scoped re-review', '[re-review-prompt.md](../re-review-prompt.md)', '`roles:spec-reviewer`', '`roles:final-adversarial-reviewer` when a finding was Critical']) {
    assert.ok(fix.includes(line), `the seams fix rule lacks: ${line}`);
  }
  assert.doesNotMatch(fix, /no second fix wave|exactly one scoped re-review/, 'the seams review kept the one-wave fix rule');
  const submit = final.slice(final.indexOf('**Submit.**'));
  assert.ok(submit.includes('`node scripts/stack.mjs submit PLAN_FILE <top N> --open`'), 'the seams review does not end with submit --open');
  assert.ok(final.indexOf('**Fix rounds.**') < final.indexOf('**Submit.**'), 'submit --open does not come after the fix rounds');
  // recording: only final-escapes with task final, never a hunters record
  const records = flat(section(raw, '## Records'));
  const rec = final.slice(final.indexOf('**Records:**'), final.indexOf('**Fix rounds.**'));
  assert.ok(rec.includes('`final-escapes`') && rec.includes('`task: "final"`'), 'the seams review does not record final-escapes with task final');
  assert.ok(rec.includes('never a `hunters` record'), 'the seams review does not forbid a hunters record');
  assert.ok(records.includes('`task: "P<n>"` (the seams review records only `final-escapes`, with `task: "final"`)'), 'Records does not say the seams review records only final-escapes');
  // the process, the ledger vocabulary and the worked example agree
  const process = flat(section(raw, '## The Process'));
  assert.ok(process.includes('the seams review of `trunk..top`'), 'The Process step 4 does not name the seams review');
  assert.doesNotMatch(process, /3 final hunters|seams review[^.;]*\b3 hunters/, 'The Process still sends 3 final hunters');
  assert.doesNotMatch(flat(section(raw, '## Ledger vocabulary')), /and the same with `final`/, 'the ledger vocabulary still has Round 1/2 lines for final');
  assert.doesNotMatch(flat(raw), /Final review: 3 hunters/, 'the worked example still has 3 final hunters');
});

test('the seams scope of the final review prompt reads only the cross-phase interfaces, state and open ledger lines', () => {
  const prompt = read(`${EP}/final-review-prompt.md`);
  const at = prompt.indexOf('## Seams Scope');
  assert.ok(at >= 0, 'the final review prompt has no seams scope');
  const phaseAt = prompt.indexOf('## Phase Scope');
  assert.ok(phaseAt >= 0 && phaseAt < at, 'the seams scope does not sit beside the phase scope, after it');
  const scope = flat(prompt.slice(at, prompt.indexOf('\n    ## ', at + 1)));
  for (const line of ['Seams review only', 'each phase already passed its own review', 'interfaces one phase exposes and a later one consumes', 'cross-phase state', '`Ruling:`', 'deferred', 'parked', 'no candidates', '[SDD_LEDGER_PATH]']) {
    assert.ok(scope.includes(line), `the seams scope lacks: ${line}`);
  }
  assert.match(scope, /Review nothing else/, 'the seams scope does not bar a re-review of the phases');
  // the two scopes are exclusive: each says which review deletes it
  assert.match(flat(prompt.slice(phaseAt, at)), /deletes this section from the seams review/, 'the phase scope is not deleted from the seams review');
  assert.match(scope, /deletes this section from a phase review/, 'the seams scope is not deleted from a phase review');
  // the shared body is range-neutral and hunter-neutral
  const body = flat(prompt.split('**Placeholders:**')[0]);
  assert.doesNotMatch(body, /entire branch|Three hunters|the final hunters|whole-branch/, 'the shared body still says entire branch / Three hunters / the final hunters');
  assert.doesNotMatch(flat(prompt), /final-candidates/, 'the prompt still names final candidates files');
});

test('the hunter template carries the evidence rule, the cap of 3 and the merged phase scope', () => {
  const text = flat(read(`${EP}/hunter-prompt.md`));
  assert.ok(text.includes('`file:line`') && text.includes('the concrete trigger input or state') && text.includes('the traced path to the wrong result') && text.includes('expected against actual'), 'the hunter template does not state the candidate evidence rule');
  assert.ok(text.includes('No suspicion, no "could"'), 'the hunter template does not rule out suspicion');
  assert.ok(text.includes('at most 3 candidates'), 'the hunter template does not cap candidates at 3');
  assert.doesNotMatch(text, /about 5/, 'the hunter template still asks for about 5 candidates');
  assert.doesNotMatch(text, /for each of its 3 hunters|sends three hunters, one per category/, 'the hunter template still sends three hunters');
  const mode = text.slice(text.indexOf('**Phase review:**'), text.indexOf('**Placeholders:**'));
  assert.ok(mode.includes('`correctness` hunter, which covers correctness, state and spec drift together'), 'the phase mode does not merge the correctness scope');
  assert.ok(mode.includes('`security` hunter only when the phase range touches a sensitive path'), 'the phase mode does not condition security on a sensitive path');
  assert.ok(mode.includes('same sensitive paths as `tier-check`'), 'the phase mode does not name the sensitive paths');
});

test('the dispatched phase-mode block tells the correctness hunter its merged scope', () => {
  const raw = read(`${EP}/hunter-prompt.md`);
  const afterPhase = raw.slice(raw.indexOf('**Phase review:**'));
  const block = afterPhase.slice(afterPhase.indexOf('```') + 3, afterPhase.indexOf('```', afterPhase.indexOf('```') + 3));
  assert.ok(/^\s*Spec: \[SPEC_PATH\]$/m.test(block), 'the phase-mode dispatch block lost its Spec line');
  assert.ok(block.includes('Scope: correctness, state and spec drift together (one candidates file;'), 'the dispatched phase-mode block does not carry the merged Scope line');
  assert.ok(flat(raw).includes('one category of defect, except the phase `correctness` hunter, which spans correctness, state and spec drift'), 'the template intro still says one category with no exception for the merged hunter');
  const scopeLine = block.split('\n').find((l) => l.trim().startsWith('Scope:'));
  assert.ok(/correctness hunter only/.test(scopeLine) && /security hunter/.test(scopeLine), 'the Scope line in the dispatched block does not limit itself to the correctness hunter (the security hunter must get none)');
  const agent = flat(readFileSync(join(PLUGIN, '..', 'roles', 'agents', 'hunter.md'), 'utf8'));
  assert.ok(agent.includes('a `Scope:` line') && agent.includes('covers everything it names'), 'the hunter role does not honor a Scope line');
  assert.ok(agent.includes('only with the `correctness` category') && agent.includes('any other category ignores it'), 'the hunter role lets a Scope line widen a non-correctness hunter');
  assert.ok(agent.includes('<path>: 3 candidates') && !agent.includes('<path>: 4 candidates'), 'the hunter example count exceeds the cap of 3');
});

test('the hunter template has no final mode', () => {
  const raw = read(`${EP}/hunter-prompt.md`);
  const text = flat(raw);
  assert.doesNotMatch(text, /\*\*Final review:\*\*/, 'the hunter template still has a final mode');
  assert.doesNotMatch(text, /final review's 3 hunters|final-candidates|in the final review|final review only|final or phase review/, 'the hunter template still mentions the final review');
  assert.ok(text.includes('**Phase review:**'), 'the hunter template lost its phase mode');
  assert.ok(text.includes('A phase review sends a `correctness` hunter'), 'the hunter template lost its phase hunter rule');
  // The role agent names the same candidates files as the template, and no final-review file.
  const agent = flat(readFileSync(join(PLUGIN, '..', 'roles', 'agents', 'hunter.md'), 'utf8'));
  assert.doesNotMatch(agent, /final-candidates|in the final review/, 'the hunter role still names a final-review candidates file');
  assert.ok(agent.includes('`<workspace>/phase-<N>-candidates-<category>.md` in a phase review'), 'the hunter role does not name the phase candidates file');
});

test('a single-phase plan: its phase review is the final review', () => {
  const raw = skill();
  const intro = flat(raw.split('\n').find((l) => l.startsWith('You are the controller of a plan')) ?? '');
  assert.ok(intro, 'no intro paragraph');
  assert.ok(intro.includes('a single-phase plan\'s phase review is its final review'), ':8 does not say a single-phase plan\'s phase review is its final review');
  assert.ok(intro.includes('the seams review'), ':8 does not name the seams review');
  assert.doesNotMatch(intro, /one final whole-branch review runs for every plan/, ':8 still says one final whole-branch review');
  const final = flat(section(raw, '## Final Review'));
  assert.ok(final.includes('The final review always runs: for every plan'), 'the final review no longer runs for every plan');
  assert.ok(final.includes('In a single-phase plan the phase review is the final review'), 'Final Review does not say the phase review is the final review of a single-phase plan');
  assert.ok(final.includes('no seams review runs'), 'Final Review does not say no second review runs');
  assert.ok(final.includes('its `P1` records stand'), 'Final Review does not say the single-phase records are the phase records');
  const process = flat(section(raw, '## The Process'));
  assert.ok(process.includes('in a single-phase plan the phase review is the final review'), 'The Process does not say it');
});

// ---- the phase review (design: Review structure) ----

const PHASE_HEADING = '### 8. Review the phase';
const phaseReview = () => flat(section(skill(), PHASE_HEADING));

test('the phase review runs between the Phase check and done/submit', () => {
  const raw = skill();
  const check = raw.indexOf('**Phase check.**');
  const heading = raw.indexOf(PHASE_HEADING);
  assert.ok(check >= 0 && heading > check, 'the phase review heading does not follow the Phase check');
  const body = phaseReview();
  const review = body.indexOf('phase review');
  const done = body.indexOf('`node scripts/stack.mjs done PLAN_FILE N`');
  const submit = body.indexOf('`node scripts/stack.mjs submit PLAN_FILE N`');
  assert.ok(review >= 0 && done > review && submit > done, 'the order is not phase review → done → submit');
  const seven = flat(section(raw, '### 7. End the phase'));
  assert.doesNotMatch(seven, /stack\.mjs (done|submit)/, 'done and submit stayed in step 7');
  for (const category of ['`correctness`', '`security`', '`spec-drift`']) assert.ok(body.includes(category), `no hunter category ${category}`);
  assert.ok(body.includes('`roles:final-adversarial-reviewer`'), 'the phase reviewer is not named');
  assert.ok(body.includes('Phase check'), 'the phase review does not name the Phase check');
  const process = flat(section(raw, '## The Process'));
  assert.ok(process.includes('the phase review'), 'The Process does not name the phase review');
  assert.ok(process.indexOf('the phase review') < process.indexOf('`node scripts/stack.mjs done PLAN_FILE N`'), 'The Process puts the phase review after done');
  assert.ok(flat(section(raw, '### 4. Review the task')).includes('once per phase'), 'step 4 still says the broad review happens once, at the final review');
});

test('phase fixes: two rounds, own commits, never reopen a task, then a sixth stop', () => {
  const body = phaseReview();
  for (const line of ['at most two', '`fix(', 'never folded into a task commit', 'never reopens a task', '`roles:review-fixer`', '`roles:spec-reviewer`']) {
    assert.ok(body.includes(line), `the phase review lacks: ${line}`);
  }
  const para = flat(skill().split('\n').find((l) => l.startsWith('Seven things stop you')) ?? '');
  assert.ok(para, 'the stops paragraph does not say Seven things stop you');
  const stops = para.split(': ')[1].split('. For those')[0].split(';').map((s) => s.trim());
  assert.equal(stops.length, 7, `${stops.length} stops: ${JSON.stringify(stops)}`);
  assert.ok(stops.some((s) => /phase review/.test(s) && /second fix round/.test(s)), 'no stop for a blocked phase review');
  // The ordinals the skill uses elsewhere (the blocked-task resume rule, step 8) count from this list.
  assert.match(stops[4], /breaker/, 'the fifth stop is no longer the breaker');
  assert.match(stops[5], /phase review/, 'the sixth stop is no longer the phase review');
  assert.ok(flat(skill()).includes('The only reasons to stop are the seven named below'), 'the continuous-execution paragraph still counts six');
  assert.ok(body.includes('sixth stop'), 'the phase review does not name the sixth stop');
});

// ---- no planned pause between phases, and lean reading (design: Controller context) ----

test('the continuous-execution rule has no planned pause: phases run back to back', () => {
  const lines = skill().split('\n');
  const continuous = flat(lines.find((l) => l.startsWith('**Continuous execution:**')) ?? '');
  assert.ok(continuous, 'no Continuous execution paragraph');
  assert.ok(continuous.includes('The only reasons to stop are the seven named below'), 'the stop count changed');
  assert.ok(continuous.includes('There is no planned pause between phases'), ':16 does not say there is no pause between phases');
  assert.doesNotMatch(continuous, /planned pause \(the phase break/, ':16 still names a phase break');
  const stops = flat(lines.find((l) => l.startsWith('Seven things stop you')) ?? '');
  assert.ok(stops, 'no stops paragraph');
  assert.ok(stops.includes('Each is a decision only your human partner can make'), 'the stops are not framed as human-only decisions');
  assert.ok(stops.includes('agreed in advance'), 'a stop agreed in advance is not honoured');
  assert.doesNotMatch(stops, /phase break|Eight things/, 'the stops paragraph still names a break');
});

test('after a phase is submitted the next phase starts at once, with no break line', () => {
  const text = skill();
  assert.doesNotMatch(text, /Run \/clear, then say "continue the plan"/, 'the break line is still in the skill');
  assert.doesNotMatch(text, /\*\*The break\.\*\*/, 'step 8 still has a The break bullet');
  assert.doesNotMatch(text, /the phase break/, 'the skill still names the phase break');
  const body = phaseReview();
  const at = body.indexOf('**No break.**');
  assert.ok(at >= 0, 'step 8 has no No break bullet');
  const submit = body.indexOf('`node scripts/stack.mjs submit PLAN_FILE N`');
  assert.ok(submit >= 0 && submit < at, 'the No break bullet does not come after stack.mjs submit');
  const rule = body.slice(at);
  assert.ok(rule.includes('the next phase starts at once'), 'the next phase does not start at once');
  assert.ok(rule.includes('as after a compaction'), 'the resume point after a compaction is not named');
});

test('the controller reads the plan, the spec Units and the current slice, and the spec sections a ruling depends on', () => {
  const raw = skill();
  const readPlan = flat(section(raw, '### Read the plan'));
  for (const line of ['the plan', 'the spec\'s `## Units`', 'current phase\'s `## Delivery Slices` entry', 'not the whole spec', 'Before writing a `Ruling:`', 'the spec sections the ruling depends on', 'the spec stays binding', 'The phase and seams reviewers get the whole spec']) {
    assert.ok(readPlan.includes(line), `Read the plan lacks: ${line}`);
  }
  assert.ok(readPlan.includes('At setup and at each resume'), 'the lean reading does not cover each resume');
  assert.doesNotMatch(readPlan, /If the plan names a Spec, read that too/, 'Read the plan still reads the whole spec');
});

test('the pre-flight scan lists only task pairs that share a file or interface', () => {
  const scan = flat(section(skill(), '### Pre-flight scan'));
  assert.ok(scan.includes('One row for every pair of tasks that share a file or an interface'), 'the pair rows are gone');
  assert.ok(scan.includes('only task pairs that share a file or an interface'), 'the scan does not say it lists only such pairs');
  assert.doesNotMatch(scan, /One row for every task:/, 'the scan still has one row per task');
  assert.ok(scan.includes('not one row per task'), 'the scan does not say it has no row per task');
});

// Leftovers of the final review's two-round fix rule (T6 review), in the files T7 touches.

test('the implementer template describes the final fix as up to two plain commits, not one wave', () => {
  const text = flat(read(`${EP}/implementer-prompt.md`));
  assert.doesNotMatch(text, /fix wave, a single plain commit/, 'the implementer template still says a single plain commit');
  assert.ok(text.includes('the final review\'s fix rounds, up to two, each one plain commit `fix: address final review findings` on the top phase'), 'the implementer template does not describe two plain final fix commits');
});

test('the re-review of a final fix goes to the spec reviewer, or to the final reviewer on a Critical finding', () => {
  const text = flat(read(`${EP}/re-review-prompt.md`));
  assert.doesNotMatch(text, /fix wave uses the same prompt, dispatched to `roles:final-adversarial-reviewer`/, 're-review-prompt still sends every final re-review to the final reviewer');
  assert.ok(text.includes('final review\'s fix rounds use the same prompt, dispatched to `roles:spec-reviewer`, or to `roles:final-adversarial-reviewer` when a finding was Critical'), 're-review-prompt does not align with SKILL.md');
});

test('the seams scope overrides the shared method on crossing task boundaries', () => {
  const prompt = read(`${EP}/final-review-prompt.md`);
  const method = flat(prompt.slice(prompt.indexOf('    ## Method'), prompt.indexOf('    ## The spec is a vision document')));
  assert.ok(method.includes('Cross task boundaries'), 'the shared Method lost its task-boundary line');
  assert.ok(method.includes('In the seams review, Seams Scope overrides this: cross only the phase boundaries it names'), 'the Method has no seams override');
});

test('the final review fix rounds name the seams exception to the phase review rule', () => {
  const final = flat(section(skill(), '## Final Review'));
  const fix = final.slice(final.indexOf('**Fix rounds.**'), final.indexOf('**Submit.**'));
  for (const line of [
    'The same rule as the phase review, with one exception',
    'after round 2 the seams review parks residual findings and hands off to methodology:finishing-branch, while the phase review blocks',
    'A failing Phase check after round 2 is treated like the residual case',
  ]) {
    assert.ok(fix.includes(line), `the final fix rounds lack: ${line}`);
  }
});

test('final-escapes is recorded once per multi-phase plan, after the seams review', () => {
  const records = flat(section(skill(), '## Records'));
  assert.ok(records.includes('once per multi-phase plan, after the seams review'), 'final-escapes is not once per multi-phase plan');
  assert.ok(records.includes('a single-phase plan\'s `P1` record stands'), 'Records does not say the single-phase P1 record stands');
  assert.doesNotMatch(records, /once per plan, after the seams review/, 'final-escapes is still once per plan');
});

test('the ledger records the phase review and resume re-runs a missing one', () => {
  const vocab = flat(section(skill(), '## Ledger vocabulary'));
  for (const line of [
    '`Round 1: P<n> — hunters <done>/<sent>`',
    '`Round 2: P<n> — verdicts <n>/<n>`',
    '`Phase review: P<n> clean | fixed | blocked`',
  ]) {
    assert.ok(vocab.includes(line), `the vocabulary lacks ${line}`);
  }
  const ws = flat(section(skill(), '### Workspace and ledger'));
  assert.ok(
    ws.includes('a phase whose tasks are all done and that has no `Phase review: P<n>` line gets its review run (again) before anything else'),
    'the resume rule does not re-run a missing phase review',
  );
  assert.ok(ws.includes('`blocked` resumes only on the human\'s word'), 'the resume rule lets a blocked phase review resume alone');
  assert.match(
    ws,
    /unless it already has a `Phase <N>: submitted` or `Phase <N>: complete` line/,
    'the resume rule re-reviews a phase that is already submitted or complete',
  );
  const body = phaseReview();
  for (const line of ['`Round 1: P<n>', '`Round 2: P<n>', '`Phase review: P<n> clean`', '`Phase review: P<n> fixed`', '`Phase review: P<n> blocked`']) {
    assert.ok(body.includes(line), `step 8 does not write ${line}`);
  }
});

test('the phase reviewer rules on the phase ledger lines', () => {
  const prompt = read(`${EP}/final-review-prompt.md`);
  const at = prompt.indexOf('## Phase Scope');
  assert.ok(at >= 0, 'the final review prompt has no phase scope');
  const next = prompt.indexOf('\n    ## ', at + 1);
  const scope = flat(prompt.slice(at, next));
  for (const line of ['one phase', '`Ruling:`', 'deferred', 'parked', '[PHASE_RANGE]', '[PHASE_TASKS]', '[PHASE_LEDGER_LINES]']) {
    assert.ok(scope.includes(line), `the phase scope lacks: ${line}`);
  }
  assert.match(scope, /range only/, 'the phase scope does not say the range only');
  const body = phaseReview();
  assert.ok(body.includes('`Ruling:`') && body.includes('Minor'), 'step 8 does not send Minor findings and Ruling: lines to the phase reviewer');
});

test('the controller writes the phase ledger file before the phase reviewer is dispatched', () => {
  const body = phaseReview();
  const round2 = body.slice(body.indexOf('**Round 2, the reviewer.**'), body.indexOf('**Findings.**'));
  const write = round2.indexOf('`<workspace>/phase-<N>-ledger.md`');
  assert.ok(write >= 0, 'step 8 never writes <workspace>/phase-<N>-ledger.md');
  assert.ok(write < round2.indexOf('dispatch `roles:final-adversarial-reviewer`'), 'the phase ledger file is written after the dispatch');
  const text = flat(round2);
  for (const form of ['`Ruling:`', 'minor (deferred)', 'parked']) assert.ok(text.includes(form), `the phase ledger file lacks ${form}`);
});

test('in a phase review the reviewer triages the phase ledger lines, not the workspace ledger', () => {
  const prompt = read(`${EP}/final-review-prompt.md`);
  const at = prompt.indexOf('## The Ledger');
  assert.ok(at >= 0, 'no ## The Ledger');
  const next = prompt.indexOf('\n    ## ', at + 1);
  const ledger = flat(prompt.slice(at, next));
  assert.match(ledger, /In a phase review[^.]*\[PHASE_LEDGER_LINES\][^.]*instead[^.]*triage/i, 'The Ledger does not send a phase review to [PHASE_LEDGER_LINES]');
});

test('phase records use P<n>', () => {
  const records = section(skill(), '## Records');
  const phase = [...records.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1])).filter((r) => r.task === 'P1');
  assert.deepEqual(phase.map((r) => r.kind).sort(), ['final-escapes', 'hunters'], 'Records lacks the P1 hunters and final-escapes examples');
  assert.ok(records.includes('"task": "P1"'));
  const text = flat(records);
  assert.ok(text.includes('Plan <name> · P<n> fix'), 'Records does not name the phase-fix progress entry');
  assert.ok(text.includes('`task: "P<n>"`'), 'Records does not say the phase review records with task P<n>');
});

test('an escape counts only a finding no earlier review recorded', () => {
  const text = flat(section(skill(), '## Records'));
  assert.ok(text.includes('only a finding no earlier review recorded'), 'Records does not limit what an escape counts');
  assert.ok(text.includes('a deferred Minor confirmed again is not an escape'), 'Records counts a re-confirmed deferred Minor');
});

test('phase hunters write phase-<N>-candidates-<category>.md', () => {
  const text = flat(read(`${EP}/hunter-prompt.md`));
  assert.ok(text.includes('**Phase review:**'), 'the hunter template has no phase mode');
  assert.ok(text.includes('`<workspace>/phase-<N>-candidates-<category>.md`'), 'the phase mode does not name the candidates file');
  const mode = text.slice(text.indexOf('**Phase review:**'), text.indexOf('**Placeholders:**'));
  assert.ok(mode.includes('Spec: [SPEC_PATH]') && mode.includes('Plan: [PLAN_PATH]'), 'the phase mode does not give the spec and the plan');
  assert.ok(mode.includes('the `Task brief` line'), 'the phase mode does not drop the brief');
  assert.doesNotMatch(mode, /heavy task's second hunter/, 'the phase mode still keeps a task-level state hunter');
});

test('worktrees only on request, as a section of the orchestrator', () => {
  const text = flat(section(skill(), '## Worktrees'));
  assert.ok(text.includes('only when your human partner explicitly asks'));
  assert.ok(text.includes('native'));
});

test('the skill carries no credit footer (NOTICE and the READMEs carry the credit)', () => {
  const text = skill();
  assert.doesNotMatch(text, /Jesse Vincent|LICENSE-superpowers|Started from superpowers/);
  assert.doesNotMatch(text, /Forked from/);
});

test('worktrees: detect isolation, native tool first, git fallback, baseline check and cleanup at finish', () => {
  const text = flat(section(skill(), '## Worktrees'));
  for (const phrase of ['git rev-parse --path-format=absolute --git-dir --git-common-dir', 'Native tool first', 'Git fallback', 'git check-ignore -q <location>', 'git worktree add', 'baseline', 'methodology:finishing-branch']) {
    assert.ok(text.includes(phrase), `the Worktrees section does not say ${phrase}`);
  }
});

// ---- fence cooperation (design U9) ----

// The denial rule, one sentence, the same everywhere: a refusal that names fence, a policy or a protected path, or that
// the agent cannot explain, is a denial and a stop-and-ask, with or without fence detected. `fence hatch` appears only
// here, in the clause that forbids suggesting it. test/skills-contract.test.mjs pins it in every carrier too.
const DENIAL_RULE = 'A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence\'s policy; when in doubt, stop.';

// Every template that dispatches a role carries the rule in its own Denied by Policy section, and so does every role's
// agent definition (a fix dispatch and a brief-writer dispatch have no template of their own).
const RULE_TEMPLATES = [
  'implementer-prompt.md', 're-review-prompt.md', 'task-reviewer-prompt.md', 'safety-review-prompt.md', 'hunter-prompt.md',
  'final-review-prompt.md', 'orchestrator-prompt.md',
];

test('the denial rule is in the orchestrator and in every dispatch template', () => {
  assert.ok(flat(read(`${EP}/SKILL.md`)).includes(DENIAL_RULE), 'SKILL.md lacks the denial rule');
  for (const file of RULE_TEMPLATES) {
    const text = read(`${EP}/${file}`);
    assert.ok(flat(text).includes(DENIAL_RULE), `${file} lacks the denial rule`);
    assert.ok(text.includes('## Denied by Policy'), `${file} has no Denied by Policy section`);
    assert.equal(text.split(DENIAL_RULE.slice(0, 40)).length, 2, `${file} carries the rule more than once`);
  }
});

test('every role agent definition carries the denial rule and says how it asks the human', () => {
  const files = readdirSync(AGENTS).filter((n) => n.endsWith('.md'));
  assert.equal(files.length, 9, files.join(', '));
  for (const file of files) {
    const agent = flat(readFileSync(join(AGENTS, file), 'utf8'));
    assert.ok(agent.includes(DENIAL_RULE), `${file} lacks the denial rule`);
    assert.ok(agent.includes('BLOCKED'), `${file} does not say how it asks the human`);
  }
});

test('every fix dispatch carries the implementer section, and the Build dispatch names it', () => {
  const loop = flat(section(skill(), '### 5. The fix loop'));
  assert.ok(loop.includes('template\'s Denied by Policy section'), 'the fix loop does not hand the fixer the Denied by Policy section');
  const build = flat(section(skill(), '### 2. Build'));
  assert.ok(build.includes('the template\'s Denied by Policy section'), 'the build dispatch does not name the Denied by Policy section');
});

test('the generic BLOCKED handler sends a denied call to Denied by Policy, with no re-dispatch and no ruling', () => {
  const line = flat(skill()).split(' - **').find((bullet) => bullet.startsWith('BLOCKED:'));
  assert.ok(line, 'no BLOCKED bullet');
  assert.ok(
    line.includes('A BLOCKED reply that reports a denied call goes to [Denied by Policy](#denied-by-policy), with no re-dispatch and no ruling'),
    'the BLOCKED bullet does not hand a denial to Denied by Policy',
  );
  assert.ok(line.indexOf('Denied by Policy') < line.indexOf('a context problem gets more context'), 'the denial clause must come first');
});

test('the stops list names a fence denial as the security-sensitive stop', () => {
  assert.ok(flat(skill()).includes('a security-sensitive action (a fence denial included)'));
});

test('a refusal that matches the rule is a denial even when the ledger says Fence: none; detection is rerun and the line updated', () => {
  const text = flat(section(skill(), '## Denied by Policy'));
  for (const phrase of [
    '**Detection can be stale.**',
    'whether or not the ledger\'s `Fence:` line says none',
    'run fence detection again (`command -v fence`, then `fence version`)',
    'append a new `Fence:` line with the result',
    'Only a failure you can explain without fence, a policy or a protected path',
    'its agent definition says so',
  ]) {
    assert.ok(text.includes(phrase), `the Denied by Policy section does not say ${phrase}`);
  }
  assert.doesNotMatch(text, /Without fence detected a refused call is an ordinary failure/);
  assert.doesNotMatch(text, /its template says so/);
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('the last `Fence:` line counts'));
});

test('the fallback printout maps the document mode to a HEADJACK_MODE value and a slug only when it matches the slug rule', () => {
  const text = flat(section(skill(), '### Fence'));
  for (const phrase of [
    "the `mode` of the `--json` document (it is on the document, never on a suggestion)",
    '`hosted` prints `HEADJACK_MODE=remote`',
    '`local` prints `HEADJACK_MODE=local`',
    'any other value prints no prefix',
    '`^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$`',
    'skip any other slug and say so',
  ]) {
    assert.ok(text.includes(phrase), `the Fence section does not say ${phrase}`);
  }
});

test('the orchestrator stops a task on a denial, ledgers it and asks, as the security-sensitive stop', () => {
  const text = flat(section(skill(), '## Denied by Policy'));
  for (const phrase of [
    DENIAL_RULE,
    '`Denied by policy: <call> — <path>`',
    'dispatch nothing else for that task',
    'no fix round',
    'ask your human partner',
    'security-sensitive stop',
    'BLOCKED',
  ]) {
    assert.ok(text.includes(phrase), `the Denied by Policy section does not say ${phrase}`);
  }
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`Denied by policy: <call> — <path>`'));
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`Fence: <version>`'));
});

test('the pinned headjack add printout runs only when fence is detected, and the implementer then installs nothing', () => {
  const text = flat(section(skill(), '### Fence'));
  for (const phrase of [
    '`command -v fence`',
    '`fence version`',
    'exits 0',
    '`Fence: <version>`',
    'only when fence is detected',
    '`triqual suggest',
    '`HEADJACK_MODE=<mode> headjack add <slug> --to claude --session --source plan`',
    '`HEADJACK_URL`',
    'ask the human to run them',
    'dispatch the task only after',
    'Without fence nothing here applies',
  ]) {
    assert.ok(text.includes(phrase), `the Fence section does not say ${phrase}`);
  }
  assert.ok(flat(section(skill(), '### 2. Build')).includes('Task Skills section in its fence form'));
  const template = flat(read(`${EP}/implementer-prompt.md`));
  assert.ok(template.includes('Install the rest with `headjack add <slug> --to claude --session --source plan`'), 'without fence the template still installs');
  assert.ok(template.includes('When the dispatch says fence is active'), 'the template has no fence form');
  assert.ok(template.includes('never run `headjack add` or `headjack remove`'));
});

test('the pressure scenarios S1, S3, S5 and S9 point at the orchestrator, and S3 and S9 set up store mode', () => {
  const spec = JSON.parse(readFileSync(join(PLUGIN, 'test', 'pressure', 'scenarios.json'), 'utf8'));
  const find = (id) => spec.scenarios.find((s) => s.id === id);
  assert.ok(find('S1').skills.includes(`${EP}/implementer-prompt.md`));
  assert.deepEqual(find('S3').skills, [`${EP}/SKILL.md`]);
  assert.deepEqual(find('S5').skills, [`${EP}/implementer-prompt.md`]);
  assert.deepEqual(find('S9').skills, [`${EP}/SKILL.md`]);
  // The orchestrator refuses committed tracking mode at `stack.mjs init`, so no setup may put the run there.
  for (const id of ['S3', 'S9']) {
    assert.match(find(id).setup, /\(store mode\)/, `${id}: the setup is not in store mode`);
    assert.doesNotMatch(find(id).setup, /committed mode/, `${id}: the setup is in committed mode`);
  }
  for (const s of spec.scenarios) for (const p of s.skills) assert.ok(existsSync(join(SKILLS, p)), `${s.id}: ${p}`);
});

// ---- the retired skill and scripts --------------------------------------------------------------------------------------
// The names are assembled here so that this file does not name what it checks for.
const RETIRED_SKILL = ['subagent', 'driven', 'development'].join('-');
const RETIRED_SCRIPTS = ['task', 'start'].join('-') + ' ' + ['task', 'done'].join('-');
const ROOT = join(PLUGIN, '..', '..');

// Every file under `dir` as an absolute path, node_modules and .git left out.
const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
// The files a text search covers: plugins/, test/ and the root README. CHANGELOG files keep their history lines.
const searched = () =>
  [...filesUnder(join(ROOT, 'plugins')), ...filesUnder(join(ROOT, 'test')), join(ROOT, 'README.md')].filter(
    (p) => !/CHANGELOG/i.test(p),
  );
const mentions = (needle) => searched().filter((p) => readFileSync(p, 'utf8').includes(needle)).map((p) => p.slice(ROOT.length + 1));

test('the retired skill is gone: no directory, and no live file names it', () => {
  assert.equal(existsSync(join(SKILLS, RETIRED_SKILL)), false, 'the retired skill directory is still there');
  assert.deepEqual(mentions(RETIRED_SKILL), []);
});

test('the per-task scripts are deleted, nothing live calls them, and the scripts left are the live ones', () => {
  for (const name of RETIRED_SCRIPTS.split(' ')) {
    assert.equal(existsSync(join(SCRIPTS, name)), false, `${name} is still there`);
    assert.deepEqual(mentions(name), [], `a live file names ${name}`);
  }
  assert.deepEqual(readdirSync(SCRIPTS).sort(), ['lib', 'review-package', 'sdd-workspace', 'stack.mjs', 'task-brief', 'task-close', 'task-open', 'task-prep', 'tier-check']);
});

// ---- the harness references -----------------------------------------------------------------------------------------------

test('the seams review ledgers the ready lines that submit --open prints', () => {
  const raw = skill();
  const vocab = flat(section(raw, '## Ledger vocabulary'));
  assert.ok(vocab.includes('`Phase <N>: ready (<branch>, PR #<n>)` (printed by `submit --open`'), 'the ledger vocabulary lacks the ready line');
  const submit = flat(section(raw, '## Final Review'));
  assert.ok(submit.includes('prints one `Phase <N>: ready (<branch>, PR #<n>)` line per phase') && submit.includes('ledger those lines'), 'the final review submit step does not ledger the ready lines');
});

test('the implementer prompt never stages tracking files and names the scripts that move the ledger', () => {
  const text = flat(read(`${EP}/implementer-prompt.md`));
  assert.doesNotMatch(text, /stage `progress\.md`|which the controller moves|the controller runs every/, 'the implementer prompt still stages tracking files or has the controller move the ledger');
  assert.ok(text.includes('a plan run never uses `"mode": "committed"` (`stack.mjs init` refuses it'), 'the implementer prompt does not say a plan run is never in committed mode');
  assert.ok(text.includes('so never stage a tracking file (`progress.md`, `status.md` or a task ledger, `*.tasks.json`) with your task commit'), 'the implementer prompt does not forbid staging the tracking files');
  assert.ok(text.includes('the `task-open`, `task-prep` and `task-close` scripts the orchestrator runs make every `triqual tasks` move'), 'the implementer prompt does not name the scripts that move the ledger');
});

test('the harness references name the one orchestrator and keep their routing statements', () => {
  const claude = flat(read('using-methodology/references/claude-code-tools.md'));
  assert.ok(claude.includes('In a methodology:executing-plans run it dispatches one `roles:phase-orchestrator` per phase'), 'claude-code-tools.md does not name the per-phase orchestrator of executing-plans');
  assert.ok(claude.includes('it is the only role that may dispatch'), 'claude-code-tools.md lost the orchestrator as the one dispatching role');
  assert.doesNotMatch(claude, /never handed to a nested orchestrator|no role covers it|a role never dispatches another/, 'claude-code-tools.md still says no orchestrator subagent exists');
  assert.ok(claude.includes('`BLOCKED: nested dispatch unavailable`'), 'claude-code-tools.md lost the nested-dispatch fallback');
  assert.doesNotMatch(claude, /mid-tier/i, 'claude-code-tools.md still advises an orchestrator on a mid-tier model');
  assert.match(claude, /`roles:<name>`/, 'claude-code-tools.md does not describe role dispatch');
  const codex = flat(read('using-methodology/references/codex-tools.md'));
  assert.ok(codex.includes('that `executing-plans` uses.'), 'codex-tools.md does not name executing-plans for multi-agent support');
  assert.doesNotMatch(codex, /dispatching-parallel-agents/, 'codex-tools.md still names the removed dispatching-parallel-agents');
  assert.doesNotMatch(codex, /Model Selection/, 'codex-tools.md still points at Model Selection');
  assert.ok(codex.includes('the phase orchestrator uses `gpt-6.1-terra` / `medium`'), 'codex-tools.md lost the phase orchestrator model group');
  assert.match(codex, /`\[agents\] max_depth` of 2 or more[^]*`triqual sync` raises it[^]*`triqual doctor` fails/, 'codex-tools.md lost the max_depth requirement');
  // Codex: a role dispatch is spawn_agent with agent_type, and a methodology skill name drops its prefix.
  assert.match(codex, /a role dispatch `roles:<name>` is `spawn_agent` with `agent_type: "<name>"`/);
  assert.match(codex, /`methodology:<x>` is the skill `<x>`/);
  // Grok cannot select a named agent: plan execution and every role dispatch stop and ask.
  const grok = flat(read('using-methodology/references/grok-tools.md'));
  assert.match(grok, /Grok cannot select a named agent/);
  assert.match(grok, /\*\*Plan execution is unavailable in Grok: stop and ask your human partner\.\*\* `executing-plans` dispatches only roles and never substitutes another agent/);
  assert.match(grok, /stop and ask your human partner before going on/);
  assert.match(grok, /Never spawn a general-purpose subagent in place of a role/);
  assert.match(grok, /`methodology:<x>` is the skill `<x>`/);
});

test('the Codex missing-role stop exempts hunter', () => {
  const codex = flat(read('using-methodology/references/codex-tools.md'));
  const exception = "except `hunter`, whose absence is the review stage's skip rule (one `Skipped:` ledger line, never a stop)";
  const missing = /\*\*Missing role:\*\* if `agent_type` does not resolve[^]*?(?= - \*\*Skills)/.exec(codex);
  assert.ok(missing, 'codex-tools.md lost its missing-role rule');
  assert.ok(missing[0].includes('stop and ask'), 'the Codex rule no longer stops and asks');
  assert.ok(missing[0].includes(exception), 'the Codex stop does not exempt hunter');
  // The skip rule the exception points at is in the orchestrator.
  assert.ok(skill().includes('`Skipped: hunters and safety gate — <cause>; safety checklist runs in the spec review`'), 'the skill lost the skip rule');
});

test('only the hunters skip on no quota: the Sonnet safety gate keeps running', () => {
  const text = skill();
  assert.ok(text.includes('A hunter with no Haiku quota is not this case'), 'the rate-limit rule still exempts the safety gate');
  assert.ok(text.includes('`Skipped: hunters — <cause>`'), 'the skill lost the hunters-only skip line');
  assert.match(text, /the safety gate keeps running/);
  assert.doesNotMatch(text, /hunter or the safety gate with no Haiku quota/);
  assert.ok(read('executing-plans/task-reviewer-prompt.md').includes('`Skipped: hunters and …`'), 'the reviewer prompt lost the gate-skip prefix');
});

test('no executing-plans file calls the safety gate a Haiku gate', () => {
  for (const name of ['SKILL.md', 'task-reviewer-prompt.md']) {
    assert.doesNotMatch(read(`executing-plans/${name}`), /Haiku gate/, `${name} still calls the safety gate a Haiku gate`);
  }
});

test('no harness reference offers inline work: a harness that cannot dispatch a role stops and asks', () => {
  for (const name of ['claude-code', 'codex', 'grok', 'hermes']) {
    const text = flat(read(`using-methodology/references/${name}-tools.md`));
    assert.doesNotMatch(text, /inline/i, `${name}-tools.md offers inline work`);
  }
  const hermes = flat(read('using-methodology/references/hermes-tools.md'));
  assert.ok(
    hermes.includes('If `delegate_task` is unavailable, stop and ask your human partner; never do the task yourself in place of a role agent, and never invent tool calls.'),
    'hermes-tools.md does not stop and ask when delegate_task is unavailable',
  );
});

// ---- the stack rules of the skill, each pinned in the section that carries it ------------------------------------------------

test('Stack setup guards a run that began before stacked execution, before init', () => {
  const setup = flat(section(skill(), '### Stack setup'));
  const guard = setup.indexOf('A run that began before stacked execution is not stacked.');
  assert.ok(guard >= 0, 'Stack setup lost the pre-stack guard');
  for (const line of [
    '`node scripts/stack.mjs path PLAN_FILE`',
    'does not exist',
    '`Task <N>: complete`',
    'Skip `init`, `phase`, `squash`, `done`, `submit` and `push` for the whole run',
    '`Ruling: run began before stacked execution — no stack`',
    "finish on the current branch",
    '`node scripts/stack.mjs phase PLAN_FILE 1` itself exits 3',
    "HEAD's branch",
  ]) {
    assert.ok(setup.includes(line), `the pre-stack guard lacks: ${line}`);
  }
  assert.ok(guard < setup.indexOf('run `node scripts/stack.mjs init PLAN_FILE` once, before Task 1') , 'the guard is not checked before init');
});

test('fix rounds commit with --fixup of the first commit, never an amend, a rebase or a reset', () => {
  const fix = flat(section(skill(), '### 5. The fix loop'));
  for (const line of [
    "`git commit --fixup=<the task's first commit>`",
    'never an amend, a rebase or a reset',
    '`git rev-list --reverse BASE..HEAD`',
  ]) {
    assert.ok(fix.includes(line), `the fix loop lacks: ${line}`);
  }
});

test('completing a task squashes before the ledger move, with commit-tree and no hook', () => {
  const done = flat(section(skill(), '### 6. Complete the task'));
  const squash = done.indexOf('the squash: `node scripts/stack.mjs squash PLAN_FILE BASE`');
  const move = done.indexOf('`triqual tasks done T<N> --commit <sha> --plan <plan>`');
  const line = done.indexOf('`Task <N>: complete (commits <base7>..<head7>, review clean)`');
  assert.ok(squash >= 0 && move > squash && line > move, 'the order is not squash, then tasks done, then the complete line');
  for (const text of ['with `git commit-tree`', 'never a rebase and never a `git commit`', 'so no hook runs and no gate fires', 'with that sha']) {
    assert.ok(done.includes(text), `step 6 lacks: ${text}`);
  }
});

test('the final review pushes without marking ready when residual findings remain; only submit --open marks ready', () => {
  const final = flat(section(skill(), '## Final Review'));
  const submit = final.indexOf('**Submit.**');
  assert.ok(submit >= 0, 'the final review lost its Submit step');
  const text = final.slice(submit);
  const push = text.indexOf('push the fix commit without marking anything ready');
  assert.ok(push >= 0, 'no push-without-ready rule');
  for (const line of [
    'When residual Critical or Important findings remain open after the re-review',
    '`node scripts/stack.mjs push PLAN_FILE <top N>`',
    'never changes the draft state',
    'leave the ready decision to your human partner',
  ]) {
    assert.ok(text.includes(line), `the Submit step lacks: ${line}`);
  }
  // `--open` is the submit option that marks ready: it comes with submit, before the push rule, never with push.
  assert.ok(text.indexOf('`node scripts/stack.mjs submit PLAN_FILE <top N> --open`') >= 0 && text.indexOf('--open') < push, 'submit --open is not the step before the push rule');
  assert.ok(!text.slice(push).includes('--open'), 'the push rule mentions --open');
  assert.doesNotMatch(skill(), /stack\.mjs push[^`]*--open/, 'a push is run with --open');
});

// ---- plan paths and store mode in the skill ---------------------------------------------------------------------------------

test('no store-mode clause of the orchestrator pairs the tasks check with --plan', () => {
  const paragraphs = skill().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  for (const line of paragraphs.filter((l) => l.includes('`"mode": "store"`') || /\bstore mode\b/i.test(l))) {
    for (const clause of line.split(/[.;:]\s/)) {
      assert.ok(!(/\bcheck\b/.test(clause) && clause.includes('--plan')), `a store-mode clause pairs the check with --plan: ${clause}`);
    }
  }
});

test('the orchestrator never tells the executor to pass a bare plan name to the scripts that need a file', () => {
  // sdd-workspace, task-brief and review-package exit 2 on a name that is not a file.
  assert.doesNotMatch(skill(), /PLAN_FILE`? (?:is|becomes|means) the bare/);
  assert.match(skill(), /sdd-workspace PLAN_FILE/);
  assert.match(skill(), /review-package PLAN_FILE BASE HEAD/);
});

// ---- the scripts, run in a temp git repo (moved from the retired skill's tests) -------------------------------------------

// Temp git repo: no GIT_* from a calling hook, no XDG_CONFIG_HOME, a temp HOME.
const gitEnv = (home) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
};
const PLAN = `# Demo plan

## Global Constraints

- Nothing.

### Task 1: First

**Role:** roles:tdd-implementer

- [ ] **Step 1:** do one.

### Task 2: Second

**Depends on:** T1
**Skills:** demo-skill
**Role:** roles:review-fixer

- [ ] **Step 1:** do two.

\`\`\`
### Task 9: inside a fence, not a heading
\`\`\`

### Task 3: Third

**Depends on:** T2
**Role:** coordinator

- [ ] **Step 1:** do three.
`;
// A script runs by its interpreter, as its shebang names it: node for a Node script, bash otherwise (as the skills
// invoke them, since some extractors drop the exec bits).
const interpreter = (path) => (/^#!.*\bnode\b/.test(readFileSync(path, 'utf8').split('\n', 1)[0]) ? process.execPath : 'bash');
const repo = () => {
  const home = mkdtempSync(join(tmpdir(), 'sdd-home-'));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-repo-')));
  const env = gitEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plans', 'demo-plan.md'), PLAN);
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  const run = (script, ...args) =>
    spawnSync(interpreter(join(SCRIPTS, script)), [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: 'utf8' });
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { dir, git, run, cleanup, plan: 'docs/plans/demo-plan.md' };
};
const commit = (r, file, text, message) => {
  writeFileSync(join(r.dir, file), text);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', message);
  return r.git('rev-parse', 'HEAD').trim();
};

// --- Characterization (upstream behavior kept) --------------------------------------------------------------------

test('review-package writes the commit list, stat and diff for BASE..HEAD', () => {
  const r = repo();
  try {
    const base = r.git('rev-parse', 'HEAD').trim();
    commit(r, 'a.txt', 'alpha\n', 'add alpha');
    const head = commit(r, 'b.txt', 'beta\n', 'add beta');
    const out = join(r.dir, 'package.diff');
    const res = r.run('review-package', r.plan, base, head, out);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^wrote .*package\.diff: 2 commit\(s\), \d+ bytes$/m);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.startsWith(`# Review package: ${base}..${head}\n`), text.slice(0, 200));
    const commits = text.slice(text.indexOf('## Commits'), text.indexOf('## Files changed'));
    assert.match(commits, /add alpha/);
    assert.match(commits, /add beta/);
    const stat = text.slice(text.indexOf('## Files changed'), text.indexOf('## Diff'));
    assert.match(stat, /a\.txt/);
    assert.match(stat, /2 files changed/);
    const diff = text.slice(text.indexOf('## Diff'));
    assert.match(diff, /^\+alpha$/m);
    assert.match(diff, /^\+beta$/m);
    const empty = r.run('review-package', r.plan, head, head, join(r.dir, 'empty.diff'));
    assert.equal(empty.status, 3, 'an empty range must exit 3');
  } finally {
    r.cleanup();
  }
});

test('task-brief extracts ### Task N with its Depends on, Role and Skills lines', () => {
  const r = repo();
  try {
    const out = join(r.dir, 'brief.md');
    const res = r.run('task-brief', r.plan, '2', out);
    assert.equal(res.status, 0, res.stderr);
    const brief = readFileSync(out, 'utf8');
    assert.equal(
      brief,
      [
        '### Task 2: Second',
        '',
        '**Depends on:** T1',
        '**Skills:** demo-skill',
        '**Role:** roles:review-fixer',
        '',
        '- [ ] **Step 1:** do two.',
        '',
        '```',
        '### Task 9: inside a fence, not a heading',
        '```',
        '',
        '',
      ].join('\n'),
    );
    assert.equal(r.run('task-brief', r.plan, '7', join(r.dir, 'none.md')).status, 3, 'a missing task must exit 3');
  } finally {
    r.cleanup();
  }
});

// --- Workspace ----------------------------------------------------------------------------------------------------

test('sdd-workspace creates .methodology/sdd/<plan>/ and the gitignore', () => {
  const r = repo();
  try {
    const res = r.run('sdd-workspace', r.plan);
    assert.equal(res.status, 0, res.stderr);
    const dir = join(r.dir, '.methodology', 'sdd', 'demo-plan');
    assert.equal(res.stdout.trim(), dir);
    assert.ok(existsSync(dir), 'the workspace directory was not created');
    assert.equal(readFileSync(join(r.dir, '.methodology', '.gitignore'), 'utf8'), '*\n');
    writeFileSync(join(dir, 'sdd-ledger.md'), `# SDD ledger — plan: ${r.plan}\n`);
    assert.equal(r.git('status', '--porcelain'), '', 'the workspace shows in git status');
    assert.equal(existsSync(join(r.dir, '.superpowers')), false, 'the old workspace root was created');
  } finally {
    r.cleanup();
  }
});

test('sdd-workspace adopts a legacy .superpowers/sdd/<plan>/progress.md once', () => {
  const r = repo();
  try {
    const legacy = join(r.dir, '.superpowers', 'sdd', 'demo-plan');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'plan-path'), `${r.plan}\n`);
    const old = `# SDD ledger — plan: ${r.plan}\nTask 1: complete (commits a..b, review clean)\n`;
    writeFileSync(join(legacy, 'progress.md'), old);
    const res = r.run('sdd-workspace', r.plan);
    assert.equal(res.status, 0, res.stderr);
    const ledger = join(res.stdout.trim(), 'sdd-ledger.md');
    assert.equal(readFileSync(ledger, 'utf8'), old, 'the legacy ledger was not copied');
    assert.equal(readFileSync(join(legacy, 'progress.md'), 'utf8'), old, 'the legacy ledger was changed');
    // Once: a later run never overwrites the adopted ledger.
    writeFileSync(ledger, `${old}Task 2: complete (commits b..c, review clean)\n`);
    writeFileSync(join(legacy, 'progress.md'), `${old}stale\n`);
    assert.equal(r.run('sdd-workspace', r.plan).status, 0);
    assert.match(readFileSync(ledger, 'utf8'), /Task 2: complete/);
    assert.doesNotMatch(readFileSync(ledger, 'utf8'), /stale/);
    // The adoption leaves an `adopted` marker in the legacy dir.
    assert.ok(existsSync(join(legacy, 'adopted')), 'no adopted marker in the legacy dir');
    // Finish deletes the new workspace; a rerun never adopts the legacy ledger again.
    rmSync(dirname(ledger), { recursive: true, force: true });
    const again = r.run('sdd-workspace', r.plan);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(existsSync(join(again.stdout.trim(), 'sdd-ledger.md')), false, 'the legacy ledger was adopted again after Finish');
  } finally {
    r.cleanup();
  }
  // Only a legacy workspace whose plan-path names this plan exactly is adopted: no marker, no adoption.
  const m = repo();
  try {
    const legacy = join(m.dir, '.superpowers', 'sdd', 'demo-plan');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'progress.md'), `# SDD ledger — plan: ${m.plan}\n`);
    const res = m.run('sdd-workspace', m.plan);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(res.stdout.trim(), 'sdd-ledger.md')), false, 'a marker-less legacy ledger was adopted');
  } finally {
    m.cleanup();
  }
  // An existing sdd-ledger.md is never overwritten, even on the first run that sees a legacy ledger.
  const s = repo();
  try {
    const dir = join(s.dir, '.methodology', 'sdd', 'demo-plan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sdd-ledger.md'), 'current\n');
    const legacy = join(s.dir, '.superpowers', 'sdd', 'demo-plan');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'progress.md'), 'legacy\n');
    assert.equal(s.run('sdd-workspace', s.plan).status, 0);
    assert.equal(readFileSync(join(dir, 'sdd-ledger.md'), 'utf8'), 'current\n');
  } finally {
    s.cleanup();
  }
  // A legacy workspace whose plan-path marker names another plan is that plan's: it is not adopted.
  const o = repo();
  try {
    const legacy = join(o.dir, '.superpowers', 'sdd', 'demo-plan');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'plan-path'), 'docs/other/demo-plan.md\n');
    writeFileSync(join(legacy, 'progress.md'), '# SDD ledger — plan: docs/other/demo-plan.md\n');
    const res = o.run('sdd-workspace', o.plan);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(res.stdout.trim(), 'sdd-ledger.md')), false, "another plan's ledger was adopted");
  } finally {
    o.cleanup();
  }
});

test('review-package writes its default output under .methodology/sdd/<plan>/', () => {
  const r = repo();
  try {
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = commit(r, 'a.txt', 'alpha\n', 'add alpha');
    const res = r.run('review-package', r.plan, base, head);
    assert.equal(res.status, 0, res.stderr);
    const short = (sha) => r.git('rev-parse', '--short', sha).trim();
    const expected = join(r.dir, '.methodology', 'sdd', 'demo-plan', `review-${short(base)}..${short(head)}.diff`);
    assert.match(res.stdout, new RegExp(`^wrote ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    assert.ok(existsSync(expected), `no package at ${expected}`);
    assert.equal(r.git('status', '--porcelain'), '');
  } finally {
    r.cleanup();
  }
});

// --- Node scripts: same CLI, exit codes and messages as the bash versions they replaced -----------------------------

test('review-package and sdd-workspace are executable Node scripts', () => {
  for (const script of ['review-package', 'sdd-workspace']) {
    const path = join(SCRIPTS, script);
    assert.equal(readFileSync(path, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node', `${script} is not a Node script`);
    assert.equal(statSync(path).mode & 0o111, 0o111, `${script} lost its exec bits`);
  }
});

test('sdd-workspace and review-package keep their usage, argument and range exit codes', () => {
  const r = repo();
  try {
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = commit(r, 'a.txt', 'alpha\n', 'add alpha');
    const out = join(r.dir, 'x.diff');
    for (const [args, script] of [[[], 'sdd-workspace'], [[r.plan, 'extra'], 'sdd-workspace'], [[r.plan, base], 'review-package'], [[r.plan, base, head, out, 'x'], 'review-package']]) {
      const res = r.run(script, ...args);
      assert.equal(res.status, 2, `${script} ${args.join(' ')}`);
      assert.match(res.stderr, new RegExp(`^usage: ${script} PLAN_FILE`));
    }
    const noPlan = r.run('sdd-workspace', 'docs/plans/none.md');
    assert.equal(noPlan.status, 2);
    assert.equal(noPlan.stderr, 'no such plan file: docs/plans/none.md\n');
    const noPlanPackage = r.run('review-package', 'docs/plans/none.md', base, head, out);
    assert.equal(noPlanPackage.status, 2);
    assert.equal(noPlanPackage.stderr, 'no such plan file: docs/plans/none.md\n');
    const badBase = r.run('review-package', r.plan, 'nosuchref', head, out);
    assert.equal(badBase.status, 2);
    assert.equal(badBase.stderr, 'bad BASE: nosuchref\n');
    const badHead = r.run('review-package', r.plan, base, 'nosuchref', out);
    assert.equal(badHead.status, 2);
    assert.equal(badHead.stderr, 'bad HEAD: nosuchref\n');
    const reversed = r.run('review-package', r.plan, head, base, out);
    assert.equal(reversed.status, 3);
    assert.equal(reversed.stderr, `HEAD is not a descendant of BASE: ${head}..${base}\n`);
    const empty = r.run('review-package', r.plan, head, head, out);
    assert.equal(empty.status, 3);
    assert.equal(empty.stderr, `empty commit range: ${head}..${head}\n`);
    assert.equal(existsSync(out), false, 'a refused range wrote a package');
  } finally {
    r.cleanup();
  }
});

test('sdd-workspace gives two plans with one file name two workspaces, each recorded by its plan-path marker', () => {
  const r = repo();
  try {
    mkdirSync(join(r.dir, 'docs', 'other'), { recursive: true });
    writeFileSync(join(r.dir, 'docs', 'other', 'demo-plan.md'), PLAN);
    mkdirSync(join(r.dir, 'elsewhere', 'other'), { recursive: true });
    writeFileSync(join(r.dir, 'elsewhere', 'other', 'demo-plan.md'), PLAN);
    const sdd = join(r.dir, '.methodology', 'sdd');
    const first = r.run('sdd-workspace', r.plan);
    const second = r.run('sdd-workspace', 'docs/other/demo-plan.md');
    const third = r.run('sdd-workspace', 'elsewhere/other/demo-plan.md');
    assert.equal(first.stdout.trim(), join(sdd, 'demo-plan'));
    assert.equal(second.stdout.trim(), join(sdd, 'demo-plan-other'));
    assert.equal(third.stdout.trim(), join(sdd, 'demo-plan-other-2'));
    assert.equal(readFileSync(join(sdd, 'demo-plan', 'plan-path'), 'utf8'), `${r.plan}\n`);
    assert.equal(readFileSync(join(sdd, 'demo-plan-other-2', 'plan-path'), 'utf8'), 'elsewhere/other/demo-plan.md\n');
    // Another spelling of the same plan resolves to the same workspace.
    assert.equal(r.run('sdd-workspace', './docs/../docs/plans/demo-plan.md').stdout.trim(), join(sdd, 'demo-plan'));
    // A plan outside the repo is recorded by its absolute path.
    const outside = mkdtempSync(join(tmpdir(), 'sdd-outside-'));
    try {
      const plan = join(realpathSync(outside), 'demo-plan.md');
      writeFileSync(plan, PLAN);
      const res = r.run('sdd-workspace', plan);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(readFileSync(join(res.stdout.trim(), 'plan-path'), 'utf8'), `${plan}\n`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    r.cleanup();
  }
});

// --- The fence rule shared with progress-tracking's parsePlan (Plan sp3-orchestration · T11, spec Addendum E.8) ----

test('task-brief and parsePlan agree on the fence fixture', () => {
  const text = readFileSync(FENCES_PLAN, 'utf8');
  assert.ok(text.endsWith('\n'));
  const all = text.slice(0, -1).split('\n');
  // The fixture holds backtick and tilde fences, a longer closing run, four-space and tab-indented fence lines and
  // `### Task` lines inside fences.
  for (const re of [/^```/m, /^~~~/m, /^~~~~~$/m, /^ {4}```/m, /^\t```/m, /^### Task 9\d: /m]) {
    assert.match(text, re, `the fixture lost ${re}`);
  }
  const tasks = parsePlan(text);
  assert.deepEqual(tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
  const r = repo();
  try {
    const headings = tasks.map((t) => all.indexOf(`### Task ${t.id.slice(1)}: ${t.title}`));
    assert.ok(headings.every((i) => i >= 0), 'every parsed heading is a line of the fixture');
    tasks.forEach((t, k) => {
      const out = join(r.dir, `brief-${t.id}.md`);
      const res = r.run('task-brief', FENCES_PLAN, t.id.slice(1), out);
      assert.equal(res.status, 0, `${t.id}: ${res.stderr}`);
      // task-brief's extent of a task ends where parsePlan's next task starts.
      const end = k + 1 < headings.length ? headings[k + 1] : all.length;
      assert.equal(readFileSync(out, 'utf8'), `${all.slice(headings[k], end).join('\n')}\n`, t.id);
    });
    // A heading inside a fence is a task for neither.
    for (const n of ['90', '91', '92', '93', '94', '95']) {
      assert.equal(r.run('task-brief', FENCES_PLAN, n, join(r.dir, `none-${n}.md`)).status, 3, `Task ${n} is inside a fence`);
    }
  } finally {
    r.cleanup();
  }
});

const PHASED_PLAN = join(PLUGIN, 'test', 'fixtures', 'phased-plan.md');

test('parsePlan reads the tasks of a phased plan and ignores phase blocks', () => {
  assert.deepEqual(parsePlan(readFileSync(PHASED_PLAN, 'utf8')).map((t) => t.id), ['T1', 'T2', 'T3']);
});

test('task-brief ends a task at the next level 1-3 heading outside a fence', () => {
  const r = repo();
  try {
    const brief = (n) => {
      const out = join(r.dir, `phased-${n}.md`);
      const res = r.run('task-brief', PHASED_PLAN, n, out);
      assert.equal(res.status, 0, res.stderr);
      return readFileSync(out, 'utf8').split('\n');
    };
    const two = brief('2');
    assert.equal(two[0], '### Task 2: Two');
    assert.ok(!two.some((l) => l.startsWith('## Phase 2')), 'Task 2 runs into the next phase heading');
    assert.ok(two.includes('## Phase 9: inside a fence'), 'the fenced block is cut from Task 2');
    assert.ok(two.includes('### Task 9: fake'), 'the fenced block is cut from Task 2');
    const three = brief('3');
    assert.equal(three[0], '### Task 3: Three');
    assert.ok(three.includes('**Depends on:** T2'));
    assert.ok(!three.some((l) => l.startsWith('## After Merge')), 'Task 3 runs into the After Merge section');
    assert.equal(r.run('task-brief', PHASED_PLAN, '9', join(r.dir, 'none-9.md')).status, 3, 'Task 9 is inside a fence');
  } finally {
    r.cleanup();
  }
});

test('task-brief stops at ## After Merge', () => {
  const r = repo();
  try {
    const plan = join(r.dir, 'docs', 'plans', 'after-merge-plan.md');
    writeFileSync(plan, `${PLAN}\n## After Merge\n\n- [ ] Tag the release.\n`);
    const out = join(r.dir, 'last.md');
    const res = r.run('task-brief', plan, '3', out);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^wrote .*last\.md: 7 lines$/m);
    assert.equal(
      readFileSync(out, 'utf8'),
      ['### Task 3: Third', '', '**Depends on:** T2', '**Role:** coordinator', '', '- [ ] **Step 1:** do three.', '', ''].join('\n'),
    );
  } finally {
    r.cleanup();
  }
});

// A store-mode plan lives outside the working tree (in the store's plansDir): every script that takes PLAN_FILE accepts
// that path, and none accepts a bare plan name.
test('every script that takes PLAN_FILE accepts a plan path outside the repo, and refuses a bare name', () => {
  const r = repo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sdd-plans-')));
  try {
    const planPath = join(outside, 'demo-plan.md');
    writeFileSync(planPath, PLAN);
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = commit(r, 'one.txt', 'one\n', 'add one');
    const ws = r.run('sdd-workspace', planPath);
    assert.equal(ws.status, 0, ws.stdout + ws.stderr);
    const brief = r.run('task-brief', planPath, '1', join(r.dir, 'brief.md'));
    assert.equal(brief.status, 0, brief.stdout + brief.stderr);
    assert.match(readFileSync(join(r.dir, 'brief.md'), 'utf8'), /^### Task 1: First/);
    const pkg = r.run('review-package', planPath, base, head, join(r.dir, 'package.diff'));
    assert.equal(pkg.status, 0, pkg.stdout + pkg.stderr);
    for (const [script, args] of [['sdd-workspace', ['demo-plan.md']], ['task-brief', ['demo-plan.md', '1']], ['review-package', ['demo-plan.md', base, head]]]) {
      const res = r.run(script, ...args);
      assert.equal(res.status, 2, `${script} accepted a bare plan name: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /no such plan file/);
    }
  } finally {
    r.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

// Leaner execution, T8: three sentences that had drifted from the per-task and per-phase review sizes.
test('the safety-review prompt sends hunters only with a heavy task, and runs a standard task in parallel with the spec review', () => {
  const intro = flat(read(`${EP}/safety-review-prompt.md`).split('\n').slice(0, 14).join('\n'));
  assert.match(intro, /heavy task it runs together with the hunters/);
  assert.match(intro, /standard task it runs in parallel with the spec reviewer/);
  assert.doesNotMatch(intro, /heavy or standard task it runs together with the hunters/);
});

test('the final-escapes record is written for a multi-phase plan only, in Process step 4 and the Final Review Records bullet', () => {
  const text = skill();
  const end = flat(text.split('\n').find((l) => l.startsWith('4. **End:**')));
  assert.match(end, /the `final-escapes` record \(multi-phase plans only; a single-phase plan's `P1` record stands\)/);
  const records = flat(section(text, '## Final Review').split('\n').find((l) => l.startsWith('- **Records:**')));
  assert.match(records, /for a multi-phase plan only \(a single-phase plan's `P1` record stands\)/);
});

test('the implementer prompt names both the phase-review and final fix rounds as plain fix commits, the exceptions to --fixup', () => {
  const text = flat(read(`${EP}/implementer-prompt.md`));
  assert.match(text, /The exceptions are the phase review's fix rounds, each one plain commit `fix\(\.\.\.\)` on the phase branch, and the final review's fix rounds/);
  assert.match(text, /never folded into a task commit/);
});

// ---- final review fix wave ----

test('the worked example is a single-phase plan: a phase review, then no seams review', () => {
  const example = flat(section(skill(), '## Example'));
  assert.ok(example.includes('[Phase check passes; phase review: 3 hunters + roles:final-adversarial-reviewer → clean; Phase review: P1 clean; hunters and final-escapes records (P1); done; submit]'), 'the example skips the phase review');
  assert.ok(example.includes('[single-phase plan: the phase review was the final review; no seams review]'), 'the example does not say the phase review was the final review');
  assert.doesNotMatch(example, /Seams review:/, 'the single-phase example still runs a seams review');
  assert.ok(example.indexOf('Phase review: P1 clean') < example.indexOf('submit <plansDir>/billing.md 1 --open'), 'the example opens before the phase review');
});

test('a phase submitted before 1.1.0 gets its phase review before the seams review', () => {
  const final = flat(section(skill(), '## Final Review'));
  assert.ok(final.includes('A phase with no `Phase review: P<n>` line (submitted before 1.1.0) gets its phase review (8. Review the phase, on that phase\'s range) before the seams review; its fixes are commits on the top phase.'), 'Final Review does not review a legacy phase first');
  assert.ok(flat(read(`${EP}/final-review-prompt.md`)).includes('the controller ran the phase review of any phase submitted before 1.1.0 before this one'), 'the seams scope still says every phase passed its own review unconditionally');
});

test('Finish lists the open deferred Minors beside the rulings', () => {
  const finish = flat(section(skill(), '## Finish'));
  assert.ok(finish.includes('under "Minors still open", every `minor (deferred)` line the last review left open'), 'Finish does not list the open deferred Minors');
});

test('step 8: the phase ledger file, the fixer inputs and the phase re-review inputs', () => {
  const body = phaseReview();
  assert.ok(body.includes('for a single-phase plan also every ledger line that names no task: pre-flight, flaky Phase check and submit rulings'), 'the phase ledger file omits the task-less lines of a single-phase plan');
  for (const line of ['the phase\'s diff package (`node scripts/review-package PLAN_FILE PHASE_BASE HEAD`, in place of a brief)', 'the plan\'s tasks of this phase', '`<workspace>/phase-<N>-report.md`', 'its own plain `fix(...)` commit', 'with the findings, the phase report file and the plan\'s tasks of this phase in place of a brief']) {
    assert.ok(body.includes(line), `step 8 lacks: ${line}`);
  }
  assert.ok(flat(read(`${EP}/re-review-prompt.md`)).includes('phase review\'s fix rounds (8. Review the phase) and the final review\'s fix rounds use the same prompt'), 're-review-prompt does not cover phase-review fix rounds');
  assert.ok(flat(read(`${EP}/re-review-prompt.md`)).includes('<workspace>/phase-<N>-report.md'), 're-review-prompt does not name the phase report file');
});

test('no template or step still points at a whole-branch or final review after the tasks', () => {
  for (const f of ['task-reviewer-prompt.md', 're-review-prompt.md', 'safety-review-prompt.md']) {
    const text = flat(read(`${EP}/${f}`));
    assert.doesNotMatch(text, /whole-branch review|after all tasks are complete|for the final review/, `${f} still says whole-branch / after all tasks / the final review`);
    assert.ok(text.includes('phase review'), `${f} does not name the phase review`);
  }
  const prompt = flat(read(`${EP}/final-review-prompt.md`));
  assert.doesNotMatch(prompt, /in one commit on the top phase/, 'the final review prompt still says one commit');
  assert.ok(prompt.includes('in at most two rounds, each a commit on the top phase'), 'the final review prompt does not say two rounds');
  const raw = skill();
  assert.ok(flat(section(raw, '## Final Review')).includes('with the phase fix commits the only commits of the stack that are not tasks'), 'Final Review ignores the phase fix commits');
  const body = phaseReview();
  assert.doesNotMatch(body, /beside the six/, 'step 8 still counts six stops');
  assert.ok(body.includes('the sixth stop, listed at the top of this skill'), 'step 8 does not name the phase review as the sixth of the seven stops');
});

test('the changelog and the README describe the hunters and the seams review accurately', () => {
  const changelog = flat(readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8'));
  assert.ok(changelog.includes('A heavy task\'s hunter candidates are verified by `roles:spec-reviewer` in round 2.'), 'the changelog does not say who verifies the per-task hunters');
  assert.doesNotMatch(changelog, /hunters' findings are verified by the phase review/, 'the changelog still says the phase review verifies per-task hunters');
  const readme = flat(readFileSync(join(PLUGIN, 'README.md'), 'utf8'));
  assert.ok(readme.includes('A `hunters` record takes `P<n>` for a phase review (the seams review writes none)'), 'the README gives the seams review a hunters record');
});

// ---- thin controller, slice 1: the task loop runs on three scripts (spec U1, U2) ----------------------------------

test('the task loop runs task-open, task-prep and task-close', () => {
  const text = skill();
  const one = flat(section(text, '### 1. Start the task'));
  assert.ok(one.includes('`node scripts/task-open PLAN_FILE N`'), 'step 1 does not run task-open');
  for (const key of ['brief:', 'report:', 'base:']) assert.ok(one.includes(`\`${key}\``), `step 1 does not name the ${key} line`);
  assert.doesNotMatch(one, /triqual tasks start|git rev-parse HEAD/, 'step 1 still makes the start move or records BASE by hand');

  const three = flat(section(text, '### 3. Check the tier'));
  assert.ok(three.includes('`node scripts/task-prep PLAN_FILE N`'), 'step 3 does not run task-prep');
  for (const key of ['tier:', 'hunters:', 'package:', 'round:', 'full-review:']) assert.ok(three.includes(`\`${key}\``), `step 3 does not name the ${key} line`);
  const four = flat(section(text, '### 4. Review the task'));
  assert.ok(four.includes('`package:` line of `task-prep`'), 'step 4 does not take the package from task-prep');
  assert.doesNotMatch(four, /run `node scripts\/review-package PLAN_FILE BASE HEAD`/, 'step 4 still builds the package by hand');
  const fix = flat(section(text, '### 5. The fix loop'));
  assert.ok(fix.includes('`node scripts/task-prep PLAN_FILE N --fix-round`'), 'the fix loop does not run task-prep --fix-round');

  const six = flat(section(text, '### 6. Complete the task'));
  assert.ok(six.includes('`node scripts/task-close PLAN_FILE N`'), 'step 6 does not run task-close');
  for (const key of ['sha:', 'record:']) assert.ok(six.includes(`\`${key}\``), `step 6 does not name the ${key} line`);
  for (const gone of ['1. **Squash:**', '2. **Progress entry:**', '3. **Ledger move:**', '4. **Ledger, right away:**', '5. **Record:**']) {
    assert.ok(!six.includes(gone), `step 6 still lists a controller step: ${gone}`);
  }
  for (const folded of ['`node scripts/stack.mjs squash', '`git commit-tree`', '`Task <N>: complete (commits <base7>..<head7>, review clean)`', 'the `task-review` record', 'review progress entry']) {
    assert.ok(six.includes(folded), `step 6 does not say task-close does: ${folded}`);
  }
  const process = flat(section(text, '## The Process'));
  for (const script of ['task-open', 'task-prep', 'task-close']) assert.ok(process.includes(script), `The Process does not name ${script}`);
});

test('more rounds after the breaker move the task in_review first; a reopen runs its fix loop by hand because task-prep cannot serve a squashed task', () => {
  const breaker = flat(skill().split('\n').find((l) => l.startsWith('**The breaker.**')) ?? '');
  assert.ok(breaker.includes('run `triqual tasks review T<N> --plan <plan>` before the first `task-prep PLAN_FILE N --fix-round`'), 'more rounds does not move the task in_review first');
  assert.ok(breaker.includes('`rework` only leaves `in_review`'), 'more rounds does not say why');
  const seven = flat(section(skill(), '### 7. End the phase'));
  for (const line of [
    'the head of its last `Prep:` line is no ancestor of `HEAD`',
    'FIX_BASE is the task\'s squashed commit',
    'node scripts/tier-check PLAN_FILE N FIX_BASE HEAD --floor <tier> --fix-round',
    'node scripts/review-package PLAN_FILE FIX_BASE HEAD',
    'fresh gate and spec outputs',
    'its record carries the next `attempt`',
  ]) {
    assert.ok(seven.includes(line), `the reopen path lacks: ${line}`);
  }
});

test('reviewer prompts end with the v1 footer', () => {
  for (const [file, role] of [['safety-review-prompt.md', 'safety-reviewer'], ['task-reviewer-prompt.md', 'spec-reviewer'], ['re-review-prompt.md', 're-reviewer']]) {
    const text = read(`${EP}/${file}`);
    const format = flat(text.slice(text.indexOf('## Output Format')));
    assert.ok(format.includes('<!-- triqual-review v1 -->'), `${file} lacks the footer marker in its Output Format`);
    assert.ok(format.includes(`role: ${role}`), `${file} lacks role: ${role}`);
    assert.ok(format.includes('findings: critical=<n> important=<n> minor=<n>'), `${file} lacks the findings: line`);
    assert.ok(format.includes('last lines of your final message'), `${file} does not make the footer the last lines`);
  }
  const spec = flat(read(`${EP}/task-reviewer-prompt.md`));
  assert.ok(spec.includes('candidate: <candidate id> confirmed critical|confirmed important|confirmed minor|refuted|duplicate-candidate|duplicate-review'), 'the spec reviewer prompt lacks the candidate: line form');
  assert.ok(spec.includes('one `candidate:` line per candidate'), 'the spec reviewer prompt does not ask for one candidate: line each');
  const re = flat(read(`${EP}/re-review-prompt.md`));
  assert.ok(re.includes('`candidate:` lines: none'), 're-review prompt does not drop the candidate: lines');
  const gate = flat(read(`${EP}/safety-review-prompt.md`));
  assert.ok(gate.includes('`candidate:` lines: none'), 'the safety prompt does not drop the candidate: lines');
});

test('the dispatcher saves each reviewer\'s final message, and a reopen needs fresh outputs', () => {
  const text = flat(section(skill(), '### 4. Review the task'));
  assert.ok(text.includes('`<workspace>/task-<N>-<role>-r<R>.md`'), 'step 4 does not name the saved output path');
  for (const line of ['`safety-reviewer`, `spec-reviewer` or `re-reviewer`', '`round:` line of `task-prep`', 'unchanged', 'cannot write files', 'A final message without the footer is sent back']) {
    assert.ok(text.includes(line), `step 4 lacks: ${line}`);
  }
  const six = flat(section(skill(), '### 6. Complete the task'));
  for (const line of [
    '`<workspace>/task-<N>-closed-<attempt>`',
    'an attempt of 2 or more (after `triqual tasks reopen`) accepts only gate, spec and hunter outputs saved after the previous marker',
    'a reopen must save a fresh gate output and a fresh spec output',
    'a reopen that runs only a re-review cannot be closed until they exist',
  ]) {
    assert.ok(six.includes(line), `step 6 lacks: ${line}`);
  }
  const seven = flat(section(skill(), '### 7. End the phase'));
  assert.ok(seven.includes('fresh gate and spec outputs'), 'the reopen path does not ask for fresh gate and spec outputs');
});

test('the ledger vocabulary has BASE, Prep and Error lines, and Finish lists Errors and fallbacks', () => {
  const vocab = flat(section(skill(), '## Ledger vocabulary'));
  for (const line of [
    '`BASE: T<N> <sha>`',
    '`Prep: T<N> r<R> <head sha>`',
    '`Error: <step> T<N> — exit <code> — <first stderr line>`',
  ]) {
    assert.ok(vocab.includes(line), `the ledger vocabulary lacks: ${line}`);
  }
  const finish = flat(section(skill(), '## Finish'));
  assert.ok(finish.includes('under "Errors and fallbacks"'), 'Finish does not list Errors and fallbacks');
  assert.ok(finish.includes('every ledger line that starts with `Error:`'), 'Finish does not collect the Error: lines');
  assert.ok(finish.includes('the closing `progress.md` entry') && finish.includes('the count of `Error:` and fallback lines'), 'the closing progress entry does not count the Error: and fallback lines');
});

// ---- thin controller, slice 2: a per-phase orchestrator runs the task loop (spec U5) ------------------------------

const THIN = '## The Thin Controller';
const thin = () => flat(section(skill(), THIN));

test('the main session dispatches one orchestrator per phase and never reads code, diffs or reports', () => {
  const body = thin();
  for (const line of [
    'dispatches one `roles:phase-orchestrator` per phase',
    '[orchestrator-prompt.md](orchestrator-prompt.md)',
    'waits for it once',
    'never reads code, diffs or reports',
    'a Phase check failure\'s reopen and a phase-review fix go to an orchestrator or a fixer it dispatches',
    '`Orchestrator: P<n> — <summary first line>`',
  ]) assert.ok(body.includes(line), `The Thin Controller lacks: ${line}`);
  const process = flat(section(skill(), '## The Process'));
  const phase = process.indexOf('`node scripts/stack.mjs phase PLAN_FILE N`');
  const dispatch = process.indexOf('`roles:phase-orchestrator`');
  const check = process.indexOf('the Phase check');
  assert.ok(phase >= 0 && dispatch > phase && check > dispatch, 'The Process does not run stack.mjs phase, then the orchestrator, then the Phase check');
  assert.ok(flat(section(skill(), '## Role Dispatch')).includes('`roles:phase-orchestrator`'), 'Role Dispatch does not name the orchestrator');
  assert.ok(flat(section(skill(), '## Role Dispatch')).includes('never a task\'s role'), 'Role Dispatch lets a task name the orchestrator as its role');
});

const SUMMARY_CONTRACT = [
  'at most 20 lines',
  '`Phase: P<n> <done|blocked>`',
  '`Tasks: T<N> <sha>, ...`',
  '`BLOCKED: <stop> — <details>`',
  '`Rulings I made:`',
  '`Open minors:`',
  '`Errors and fallbacks:`',
  '`none`',
];

test('the orchestrator prompt carries the summary contract and the denial rule', () => {
  const raw = read(`${EP}/orchestrator-prompt.md`);
  const first = raw.split('\n').find((l) => /Subagent\s*\(/.test(l));
  assert.equal(first?.trim(), 'Subagent (roles:phase-orchestrator):');
  const [body, defs] = raw.split('**Placeholders:**');
  for (const name of ['PLAN_FILE', 'PHASE', 'LEDGER_PATH', 'GLOBAL_CONSTRAINTS', 'RESUME_NOTE']) {
    assert.ok(body.includes(`[${name}]`), `the prompt does not use [${name}]`);
    assert.ok(defs.includes(`- \`[${name}]\``), `[${name}] is not defined`);
  }
  const text = flat(body);
  for (const line of SUMMARY_CONTRACT) assert.ok(text.includes(line), `the prompt's summary contract lacks: ${line}`);
  const final = text.slice(text.indexOf('## Your Final Message'));
  const order = ['`Phase: P<n>', '`Tasks: T<N>', '`BLOCKED: <stop>', '`Rulings I made:`', '`Open minors:`', '`Errors and fallbacks:`'].map((k) => final.indexOf(k));
  assert.ok(order[0] >= 0 && order.every((at, i) => i === 0 || at > order[i - 1]), `the summary contract is out of order: ${order}`);
  assert.ok(flat(raw).includes(DENIAL_RULE), 'the prompt lacks the denial rule');
  for (const line of ['Follow `methodology:executing-plans` for this phase only', 'never edit product code', 'nothing new', '`Task <N>: awaiting landing`', 'wait the seconds the denial names and retry']) {
    assert.ok(text.includes(line), `the prompt lacks: ${line}`);
  }
});

test('on BLOCKED the main session asks, writes the decision and the move, then re-dispatches', () => {
  const body = thin();
  const at = body.indexOf('**On `BLOCKED`.**');
  assert.ok(at >= 0, 'no On BLOCKED bullet');
  const text = body.slice(at);
  const ask = text.indexOf('asks your human partner');
  const ruling = text.indexOf('`Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`');
  const start = text.indexOf('`triqual tasks start T<N> --plan <plan>`');
  const redispatch = text.indexOf('dispatches a new orchestrator for the same phase');
  assert.ok(ask >= 0 && ruling > ask && start > ruling && redispatch > start, 'the order is not ask, ledger the decision, make the move, re-dispatch');
  assert.ok(text.includes('resumes from the ledger'), 'the new orchestrator does not resume from the ledger');
  assert.ok(text.includes('begins with `BLOCKED` instead of `Phase:`') && text.includes('a denial'), 'a final message that begins with BLOCKED is not handled as a denial');
});

test('a stop drains running agents and writes awaiting landing', () => {
  const body = thin();
  const at = body.indexOf('**A stop.**');
  assert.ok(at >= 0, 'no A stop bullet');
  const text = body.slice(at);
  const order = ['starts nothing new', 'lets running agents finish their current step', '`Task <N>: awaiting landing`', 'returns `BLOCKED: <stop> — <details>`'].map((line) => {
    assert.ok(text.includes(line), `the stop bullet lacks: ${line}`);
    return text.indexOf(line);
  });
  assert.ok(order.every((n, i) => i === 0 || n > order[i - 1]), `the stop bullet is out of order (start nothing, drain, awaiting landing, return): ${order}`);
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`Task <N>: awaiting landing`'), 'the ledger vocabulary lacks awaiting landing');
});

test('nested dispatch unavailable is an announced fallback, and a failed orchestrator dispatch is detected by the main session itself', () => {
  const body = thin();
  const at = body.indexOf('**Fallback.**');
  assert.ok(at >= 0, 'no Fallback bullet');
  const text = body.slice(at);
  for (const line of [
    'the main session sees the failed dispatch itself',
    '`BLOCKED: nested dispatch unavailable`',
    '`Error: orchestrator P<n> — exit 1 — <first line of the error>`',
    'runs the phase loop itself with the same scripts',
    'Announced, never silent',
  ]) assert.ok(text.includes(line), `the fallback bullet lacks: ${line}`);
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`Orchestrator: P<n> — <summary first line>`'), 'the ledger vocabulary lacks the Orchestrator line');
});

test('a workflow-gate cap denial is retried after the named seconds, never a stop or a fallback', () => {
  const body = thin();
  const at = body.indexOf('**A cap denial.**');
  assert.ok(at >= 0, 'no A cap denial bullet');
  const text = body.slice(at);
  for (const line of ['workflow-gate', 'wait the seconds the denial names and retry', 'neither a stop nor a fallback', 'both levels']) {
    assert.ok(text.includes(line), `the cap denial bullet lacks: ${line}`);
  }
});

test('the 1.1.0 wait rule holds for both levels', () => {
  const loop = flat(section(skill(), '## The Task Loop'));
  const at = loop.indexOf('**Waiting on dispatched subagents:**');
  assert.ok(at >= 0, 'the wait rule is gone');
  const text = loop.slice(at, loop.indexOf('**Rate limits.**'));
  for (const line of ['never poll a wait interface with short timeouts', 'bounded stretches (five to ten minutes', 'reconcile your live children', 'Both levels follow it', '`wait_agent`']) {
    assert.ok(text.includes(line), `the wait rule lacks: ${line}`);
  }
  const rate = loop.slice(loop.indexOf('**Rate limits.**'), loop.indexOf('### Start the phase'));
  assert.ok(rate.includes('When the orchestrator meets it, it follows the same stretches') && rate.includes('returns `BLOCKED: rate limit — <role> T<N>`'), 'the rate-limit rule does not say what the orchestrator does');
});

test('a phase submitted before 1.1.0 gets rounds 1-2 and fix rounds of the phase review without done, submit or break, and the top phase\'s Phase check after each fix', () => {
  const final = flat(section(skill(), '## Final Review'));
  const at = final.indexOf('A phase with no `Phase review: P<n>` line');
  assert.ok(at >= 0, 'no legacy phase rule');
  const text = final.slice(at, final.indexOf('- **The package:**'));
  for (const line of ['rounds 1 and 2 and the fix rounds of 8. Review the phase', 'no `stack.mjs done`, no `submit` and no break', 'the top phase\'s Phase check after each fix round']) {
    assert.ok(text.includes(line), `the legacy phase rule lacks: ${line}`);
  }
});

test('Finish carries the Errors and fallbacks of both levels', () => {
  const finish = flat(section(skill(), '## Finish'));
  assert.ok(finish.includes('the orchestrators\' errors and fallbacks'), 'Finish does not take the orchestrators\' errors and fallbacks from the ledger');
  assert.ok(finish.includes('beside "Rulings I made"'), 'Errors and fallbacks does not sit beside Rulings I made');
});

// ---- thin controller, fix round 1 ------------------------------------------------------------------------------------

const ORCHESTRATOR_ROLE = () => flat(readFileSync(join(AGENTS, 'phase-orchestrator.md'), 'utf8'));
const PROMPT = () => flat(read(`${EP}/orchestrator-prompt.md`));

test('the role file, the dispatch prompt and the skill agree: the main session runs the Phase check and the phase review', () => {
  const role = ORCHESTRATOR_ROLE();
  assert.ok(!/its Phase check|its phase review/.test(role), 'the role file tells the orchestrator to follow its own Phase check or phase review');
  assert.ok(role.includes('the Phase check and the phase review stay with the main session'), 'the role file does not leave the Phase check and the phase review to the main session');
  assert.ok(PROMPT().includes('Do not run the Phase check, the phase review, `stack.mjs done` or `stack.mjs submit`'), 'the prompt does not keep the Phase check and the phase review from the orchestrator');
  const step4 = thin().slice(thin().indexOf('4. Read its summary'), thin().indexOf('**The summary.**'));
  assert.ok(step4.includes('goes on to the Phase check, the phase review'), 'the skill does not give the Phase check and the phase review to the main session');
  assert.ok(flat(section(skill(), '## The Process')).includes('then the Phase check at the phase tip, the phase review'), 'The Process does not run the Phase check and the phase review after the orchestrator');
});

test('only a stop goes to On BLOCKED: nested dispatch, rate limit and a coordinator handoff have their own route and no question to the owner', () => {
  const body = thin();
  const step4 = body.slice(body.indexOf('4. Read its summary'), body.indexOf('**The summary.**'));
  const route = {
    '`BLOCKED: nested dispatch unavailable`': 'Fallback',
    '`BLOCKED: rate limit — <role> T<N>`': 'Rate limits',
    '`BLOCKED: coordinator task T<N>': 'Coordinator tasks',
  };
  for (const [kind, target] of Object.entries(route)) {
    const at = step4.indexOf(kind);
    assert.ok(at >= 0, `step 4 does not name ${kind}`);
    assert.ok(step4.slice(at, at + 160).includes(target), `step 4 does not route ${kind} to ${target}`);
    assert.ok(at < step4.indexOf('goes to On `BLOCKED`'), `${kind} is not routed before On BLOCKED`);
  }
  assert.ok(step4.includes('never asks your human partner and writes no ruling'), 'step 4 lets the non-stop kinds ask the owner');
  assert.ok(step4.includes('Any other `BLOCKED:` line, a stop or a script error the steps cannot resolve, goes to On `BLOCKED`'), 'step 4 does not send a stop or a script error to On BLOCKED');
  // A stop and the three kinds are the BLOCKED line of a summary that begins with Phase:; only a final message that
  // begins with BLOCKED is a denial.
  for (const [name, text] of [['skill', body], ['prompt', PROMPT()], ['role', ORCHESTRATOR_ROLE()]]) {
    assert.ok(text.includes('BLOCKED line'), `the ${name} does not say a stop is the BLOCKED line of the summary`);
  }
  assert.ok(body.includes('`Phase: P<n> blocked` first'), 'the skill does not say a blocked summary begins with the Phase line');
  assert.ok(PROMPT().includes('`BLOCKED: nested dispatch unavailable — <error text>`'), 'the prompt does not return nested dispatch unavailable in the summary');
});

test('a Ruling written for a human decision carries the why and the cost if wrong, in every place it is written', () => {
  const form = '`Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`';
  for (const [where, text] of [
    ['On BLOCKED', thin()],
    ['the breaker', flat(section(skill(), '### 5. The fix loop'))],
    ['the ledger vocabulary', flat(section(skill(), '## Ledger vocabulary'))],
  ]) assert.ok(text.includes(form), `${where} does not write the human's ruling as ${form}`);
  assert.ok(!skill().includes('`Task <N>: Ruling: <finding> — <decision>`'), 'a two-part human ruling form is left in the skill');
});

test('a task with a complete line is never dispatched again unless the resume note reopens it', () => {
  const unless = 'unless the resume note reopens it';
  assert.ok(thin().includes(unless), 'On BLOCKED does not except a reopened task');
  assert.ok(PROMPT().includes(unless), 'the prompt does not except a reopened task');
  assert.ok(flat(section(skill(), '## Setup')).includes('unless a Phase check reopened it'), 'the resume rule of Setup does not except a reopened task');
  assert.ok(flat(section(skill(), '### 7. End the phase')).includes('the task\'s `Task <N>: complete` line stays'), 'the Phase check reopen does not say it leaves the complete line in place');
});

test('a Phase check failure and its reopen are ledgered, and the main session runs the reopen move', () => {
  const reopened = '`Task <N>: reopened — Phase check failed — <command>`';
  const seven = flat(section(skill(), '### 7. End the phase'));
  assert.ok(seven.includes(reopened), 'the Phase check does not write the reopen line');
  assert.ok(seven.includes('the main session runs the reopen'), 'the Phase check does not say who runs the reopen');
  assert.ok(seven.includes('the orchestrator runs the fix loop'), 'the Phase check does not say who runs the fix loop');
  assert.ok(!seven.includes('writes no ledger line'), 'the Phase check still says the reopen writes no ledger line');
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes(reopened), 'the ledger vocabulary lacks the reopen line');
  assert.ok(thin().includes(reopened), 'On BLOCKED does not name the reopen line');
  assert.ok(flat(section(skill(), '## Setup')).includes('`Task <N>: reopened —` line'), 'the resume rule of Setup does not read the reopen line');
  assert.ok(PROMPT().includes('`Task <N>: reopened —`'), 'the prompt does not read the reopen line');
  assert.ok(PROMPT().includes('the main session has already run'), 'the prompt does not say the main session ran the reopen');
});

test('a task-close rerun after a BLOCKED round trip is a resume, and the skill says which lines leave it one', () => {
  const six = flat(section(skill(), '### 6. Complete the task'));
  for (const line of [
    'A rerun is a resume while',
    '`Task <N>: Ruling:`',
    '`Task <N>: awaiting landing`',
    '`Orchestrator:`',
    '`Prep:`',
    '`Task <N>: reopened`',
  ]) assert.ok(six.includes(line), `step 6 does not say what a resume is: ${line}`);
  assert.ok(thin().includes('a rerun of `task-close` after them is a resume'), 'On BLOCKED does not say the ruling leaves a rerun a resume');
});

test('a harness that cannot dispatch a task role stops and asks, a missing orchestrator is the announced Fallback', () => {
  const head = flat(skill().split('\n').find((l) => l.startsWith('You are the controller')) ?? '');
  assert.ok(head.includes('a harness that cannot dispatch a named task role agent stops and asks'), 'the opening does not scope the stop to task roles');
  assert.ok(head.includes('a missing `roles:phase-orchestrator` is the Fallback'), 'the opening does not point the orchestrator at the Fallback');
});

test('a coordinator task runs in the main session, and the orchestrator hands over one that edits a file', () => {
  const coord = flat(section(skill(), '### Coordinator tasks'));
  assert.ok(!coord.includes('runs in this session, by you'), 'Coordinator tasks still says it runs in this session, by you');
  for (const line of ['run by the controller, never dispatched to a role', 'the main session runs one that edits a file', 'the phase orchestrator hands it over']) {
    assert.ok(coord.includes(line), `Coordinator tasks lacks: ${line}`);
  }
  const handoff = thin().slice(thin().indexOf('**Coordinator tasks.**'));
  assert.ok(!handoff.includes('has no edit tool'), 'the handoff still rests on a tool the role does not lack');
  for (const line of ['its role disallows `Edit` and `NotebookEdit`', 'never edits product code', '`BLOCKED: coordinator task T<N> — edits files, run it in the main session`', 'not one of the seven stops']) {
    assert.ok(handoff.includes(line), `the coordinator handoff lacks: ${line}`);
  }
  assert.ok(PROMPT().includes('`BLOCKED: coordinator task T<N> — edits files, run it in the main session`'), 'the prompt does not tell the orchestrator about the handoff');
  const log = readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8');
  const from = log.indexOf('\n## methodology 1.3.0');
  assert.ok(from >= 0, 'no methodology 1.3.0 CHANGELOG entry');
  const entry = flat(log.slice(from, log.indexOf('\n## ', from + 4)));
  assert.ok(entry.includes('coordinator task') && entry.includes('main session'), 'the 1.3.0 CHANGELOG entry does not mention the coordinator handoff');
});

test('the summary has an overflow rule and the main session reads nothing of the loop outside the fallback', () => {
  const overflow = '`+<k> more in the ledger`';
  for (const [name, text] of [['skill', thin()], ['prompt', PROMPT()], ['role', ORCHESTRATOR_ROLE()]]) {
    assert.ok(text.includes(overflow), `the ${name} has no summary overflow rule`);
  }
  const body = thin();
  assert.ok(body.includes('and in the phase review (step 8) only the reviewers\' verdicts'), 'the never-reads rule does not allow the phase review verdicts');
  assert.ok(body.includes('The fallback is the exception'), 'the never-reads rule has no fallback exception');
});

// ---- parallel tasks, slice 3: independent tasks of a phase run at the same time (spec U6) -------------------------

const PARALLEL = '### Parallel tasks';
const parallel = () => flat(section(skill(), PARALLEL));

test('independence is no shared Files path with a running task and every dependency complete', () => {
  const body = parallel();
  for (const line of [
    'A task is independent when every task it depends on is complete and its plan `**Files:**` paths share no path with any earlier task of the phase that is not yet closed',
    'a task is running from its `task-open` until its `task-close`',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(flat(PROMPT()).includes('`**Files:**` paths share no path with any earlier task of the phase that is not yet closed'), 'the orchestrator prompt does not carry the independence rule');
});

test('an earlier overlapping task always starts first: independence looks at every earlier task not yet closed, and the deadlock is the reason', () => {
  const body = parallel();
  for (const line of [
    'any earlier task of the phase that is not yet closed, running or not yet started',
    'an earlier task that overlaps it always starts first',
    'it starts once that earlier task is closed',
    // the reason: a later task running while an earlier overlapping one has not started deadlocks against the landing order
    'if a later task ran while an earlier task it overlaps had not started, the earlier would wait for the later to close, and the later `task-close` waits for the earlier to land: a deadlock',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.doesNotMatch(body, /share no path with any running task/, 'the rule still checks only running tasks');
  const prompt = flat(PROMPT());
  assert.ok(prompt.includes('so an earlier overlapping task always starts first'), 'the orchestrator prompt does not order the starts');
  assert.ok(prompt.includes('a deadlock against the landing order'), 'the orchestrator prompt does not give the deadlock reason');
  assert.doesNotMatch(prompt, /share no path with any running task/, 'the orchestrator prompt still checks only running tasks');
  const log = readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8');
  const entry = flat(log.slice(log.indexOf('\n## methodology 1.4.0'), log.indexOf('\n## methodology 1.3.0')));
  assert.ok(entry.includes('earlier task of the phase that is not yet closed'), 'the CHANGELOG still states the running-only rule');
});

test('a fix round due while all 3 slots are busy waits for the first implementer to report, ahead of any task that has not started', () => {
  const body = parallel();
  assert.ok(body.includes('A fix round that is due while all 3 slots are busy waits for the first implementer to report, ahead of any task that has not started'), 'Parallel tasks does not say what a due fix round does with no free slot');
  assert.ok(flat(PROMPT()).includes('a fix round due with all 3 slots busy waits for the first free slot, ahead of any task that has not started'), 'the orchestrator prompt does not say it');
});

test('the abandon recipe for a landing that never clears moves the branch, writes the undo pair and marker, removes the worktree and reworks', () => {
  const body = parallel();
  for (const line of [
    'moves the phase branch to that sha (`git reset --keep <sha>` from the main checkout; nothing to do when it is already there)',
    'writes `BASE: T<N> <sha>` and `Task <N>: landing conflict — re-run sequential` in one write',
    'creates the file `<workspace>/task-<N>-undone`',
    'removes the task\'s worktree and its branch (`git worktree remove --force`, `git branch -D wt/<plan stem>-t<N>`)',
    'runs `triqual tasks rework T<N> --plan <plan>` when opted in',
    // why: the record of the re-run must not count the undone attempt
    'without the line and the marker the re-run\'s record would count the undone attempt\'s fix rounds and its stale reviewer and hunter outputs',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks the abandon recipe: ${line}`);
  const order = ['moves the phase branch to that sha', 'writes `BASE: T<N> <sha>`', 'creates the file `<workspace>/task-<N>-undone`', 'runs `triqual tasks rework'].map((l) => body.indexOf(l));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the abandon steps are not in order');
});

test('at most 3 implementers at once', () => {
  assert.ok(parallel().includes('At most 3 implementers at once'), 'Parallel tasks has no limit');
  assert.ok(PROMPT().includes('at most 3 implementers at once'), 'the orchestrator prompt has no limit');
  assert.doesNotMatch(skill(), /Never dispatch two implementers in parallel/, 'the sequential-only sentence is still there');
  assert.ok(flat(section(skill(), '### 2. Build')).includes('Two implementers run at once only as Parallel tasks says'), 'step 2 does not point at Parallel tasks');
});

test('batched light tasks never run in parallel', () => {
  assert.ok(parallel().includes('Batched light tasks never run in parallel'), 'Parallel tasks does not exclude batched light tasks');
  assert.ok(PROMPT().includes('batched light tasks never run in parallel'), 'the orchestrator prompt does not exclude batched light tasks');
  assert.ok(flat(section(skill(), '#### Batched light dispatch')).includes('Batched light tasks never run in parallel'), 'Batched light dispatch does not say so');
});

test('a task uses the main checkout only when every earlier task of the phase is done or dropped; others use task-open --worktree', () => {
  const body = parallel();
  for (const line of [
    'A task uses the main checkout only when every earlier task of the phase is done or dropped',
    'every other task is opened with `node scripts/task-open PLAN_FILE N --worktree`',
    '`.claude/worktrees/<plan stem>-t<N>`',
    'on the branch `wt/<plan stem>-t<N>`',
    'started at its BASE',
    'adds `.claude/worktrees/` to `.git/info/exclude`',
    '`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`',
    'a failed install is exit 1 with an `Error:` line',
    'It prints `workdir:` after `base:`',
    'A rerun reuses the worktree',
    '`[WORK_DIR]`',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(PROMPT().includes('A task uses the main checkout only when every earlier task of the phase is done or dropped'), 'the orchestrator prompt does not say where a task runs');
  assert.ok(flat(section(skill(), '### 1. Start the task')).includes('`node scripts/task-open PLAN_FILE N --worktree`'), 'step 1 does not name --worktree');
});

test('task-close for a worktree task is called only after every earlier task has landed', () => {
  const body = parallel();
  for (const line of [
    '`task-close` for a worktree task is called only after every earlier task of the phase has landed',
    'lands in plan order',
    'refused (exit 3) with no `Error:` line',
    'a wait, not a failure',
    '`task-prep PLAN_FILE N --head <sha>`',
    '`git rev-parse wt/<plan stem>-t<N>`',
    '`--fix-round --head <sha>`',
    '`git merge-tree --write-tree`',
    '`git commit-tree`',
    '`git reset --keep`',
    'ONE commit on the phase tip',
    '`node --test`',
    'done --commit <landed sha>',
    '`git worktree list`',
    'worktree and its branch are removed',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(PROMPT().includes('closed with `task-close` only after every earlier task has landed'), 'the orchestrator prompt does not order the landings');
  assert.ok(PROMPT().includes('`task-prep --head <sha>`'), 'the orchestrator prompt does not review a worktree task with --head');
  assert.ok(flat(section(skill(), '### 6. Complete the task')).includes('a worktree task: see Parallel tasks'), 'step 6 does not point at Parallel tasks');
});

test('a task with no node Test path never runs in a worktree', () => {
  const body = parallel();
  for (const line of [
    'A task with no node `Test:` path never runs in a worktree',
    'a `Test:` path that is not a `.mjs`, `.js` or `.cjs` file, a glob, or a path outside the repository',
    '`task-open --worktree` refuses it (exit 3, with an `Error:` line, before anything is written)',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(PROMPT().includes('A task with no node `Test:` path never runs in a worktree'), 'the orchestrator prompt lacks the Test path rule');
});

test('phase close removes leftover <plan stem>-t* worktrees and logs each', () => {
  const seven = flat(section(skill(), '### 7. End the phase'));
  for (const line of [
    'Phase close removes every `<plan stem>-t*` worktree left behind',
    '`git worktree remove --force`',
    '`git branch -D wt/<plan stem>-t<N>`',
    '`Worktree removed: <path> — left behind at the close of P<n>`',
    'before the Phase check',
  ]) assert.ok(seven.includes(line), `step 7 lacks: ${line}`);
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`Worktree removed: <path> — left behind at the close of P<n>`'), 'the ledger vocabulary lacks the cleanup line');
});

test('the landing is undone, never patched: the undo pair, its marker and the sequential re-run', () => {
  const body = parallel();
  for (const line of [
    'A merge conflict or a failing `Test:` file at the landing is undone',
    '`git reset --keep` back to the previous tip',
    '`BASE: T<N> <previous tip>`',
    '`Task <N>: landing conflict — re-run sequential`',
    '`<workspace>/task-<N>-undone`',
    '`triqual tasks rework`',
    'exit 3 with an `Error:` line',
    '`task-open PLAN_FILE N` without `--worktree`',
    'starts again at round 1',
    'are never counted',
    'a rerun of `task-close` finishes the clean-up',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks the undo: ${line}`);
  assert.ok(PROMPT().includes('`Task <N>: landing conflict — re-run sequential`'), 'the orchestrator prompt does not name the undo line');
});

test('the landing writes Landed, Prep at the landed sha and Tested, and a rerun skips what stands', () => {
  const body = parallel();
  for (const line of [
    '`Landed: T<N> <sha>`',
    '`Prep: T<N> r<R> <landed sha>` when the attempt has a `Prep:` line',
    '`Tested: T<N> <sha>`',
    'a rerun without it runs them again',
    'neither tested nor the phase tip',
    'its sha must still be on the phase branch',
    'the closed commit is the landed sha, whatever `--head` says',
    '`BASE: T<N> <sha>`',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  const vocab = flat(section(skill(), '## Ledger vocabulary'));
  for (const line of [
    '`Landed: T<N> <sha>`',
    '`Tested: T<N> <sha>`',
    '`Prep: T<N> r<R> <landed sha>`',
    '`BASE: T<N> <previous tip>`',
    '`Task <N>: landing conflict — re-run sequential`',
    '`<workspace>/task-<N>-undone`',
  ]) assert.ok(vocab.includes(line), `the ledger vocabulary lacks: ${line}`);
});

test('the landing verifies with TRIQUAL_LANDING_TEST_TIMEOUT_MS, and a timeout is a failure', () => {
  const body = parallel();
  for (const line of [
    '`TRIQUAL_LANDING_TEST_TIMEOUT_MS`',
    'default 600000',
    'a timeout is a failure and takes the undo',
    '`<workspace>/task-<N>-landing-test.log`',
    'not a positive number of milliseconds is exit 2',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  const common = readFileSync(join(SCRIPTS, 'lib', 'task-common.mjs'), 'utf8');
  assert.match(common, /DEFAULT_LANDING_TEST_TIMEOUT_MS = 600000/, 'the script default is not the 600000 the skill states');
});

test('a task-close rerun resumes past Landed and Tested lines, and the exit-3 refusals say which write an Error line', () => {
  const six = flat(section(skill(), '### 6. Complete the task'));
  for (const line of [
    '`Landed: T<N> <sha>` and `Tested: T<N> <sha>` lines, and the `Prep:` line at the landed sha',
    'a `Prep:` at any other head is new work',
  ]) assert.ok(six.includes(line), `step 6 does not say what a landing resume is: ${line}`);
  const body = parallel();
  for (const line of [
    'Every exit-3 refusal of `task-close` writes its `Error: task-close T<N> — exit 3 — <cause>` line except the earlier-task wait and the linked-worktree refusal',
    'a linked worktree (`run from the main checkout`) is refused before the workspace is known',
    'the wait is the refusal whose message starts `T<N> waits for`',
    'the landed commit is not on the phase branch',
    'no longer the tip',
    'the owner decides',
    'not on the active phase branch',
    'the tree is not clean',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  const vocab = flat(section(skill(), '## Ledger vocabulary'));
  assert.ok(vocab.includes('except the earlier-task wait of `task-close` and a refusal from a linked worktree'), 'the Error line of the ledger vocabulary does not name what writes none');
  assert.ok(flat(PROMPT()).includes('a refusal whose message starts `T<N> waits for` is a wait'), 'the orchestrator prompt does not name the wait by its message');
  assert.doesNotMatch(flat(PROMPT()), /a refusal that writes no `Error:` line is a wait/, 'the prompt still takes a missing Error line for a wait');
});

test('the loop text no longer reads BASE..HEAD for a worktree task, and phase close names the path form and what a forced removal discards', () => {
  const one = flat(section(skill(), '### 1. Start the task'));
  assert.ok(one.includes('`tier-check` and the squash all read `BASE..HEAD`, where HEAD is the task\'s head (`--head <sha>` for a worktree task, which lands in place of the squash)'), 'step 1 still reads BASE..HEAD for every task');
  const seven = flat(section(skill(), '### 7. End the phase'));
  for (const line of [
    '`<path>` is the absolute worktree path',
    '`--force` and `branch -D` also discard the unlanded commits of a dropped task, and this line is the only trace of them',
  ]) assert.ok(seven.includes(line), `step 7 lacks: ${line}`);
  assert.ok(flat(section(skill(), '## Ledger vocabulary')).includes('`<path>` absolute'), 'the ledger vocabulary does not say the path form');
});

test('parallel runs need store or local tracking: committed mode is already refused at init', () => {
  const body = parallel();
  assert.ok(body.includes('Parallel runs need store or local tracking mode: in committed mode every worktree commit would append to `progress.md` and `status.md` and the landings would conflict, so `stack.mjs init` refuses committed mode before Task 1'), 'Parallel tasks does not state the tracking-mode requirement');
  const stack = readFileSync(join(SCRIPTS, 'stack.mjs'), 'utf8');
  assert.match(stack, /info\?\.optedIn && info\.mode === 'committed'\) fail\(EXIT_REFUSED/, 'stack.mjs no longer refuses committed mode');
});

test('a stop leaves a waiting worktree task awaiting landing, and a resumed phase reuses its worktrees', () => {
  const body = parallel();
  for (const line of [
    'On a stop, a task that is reviewed but waits to land gets `Task <N>: awaiting landing` and keeps its worktree',
    'A resumed phase reads the running tasks from the ledger',
    '`task-open PLAN_FILE N --worktree` again reuses',
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(flat(section(skill(), '## The Process')).includes('Parallel tasks'), 'The Process does not mention Parallel tasks');
});

test('the 1.4.0 CHANGELOG entry and the orchestrator prompt carry the parallel rule', () => {
  const log = readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8');
  const from = log.indexOf('\n## methodology 1.4.0');
  assert.ok(from >= 0, 'no methodology 1.4.0 CHANGELOG entry');
  assert.ok(from < log.indexOf('\n## methodology 1.3.0'), 'the 1.4.0 entry is not above the 1.3.0 entry');
  const entry = flat(log.slice(from, log.indexOf('\n## ', from + 4)));
  for (const line of ['Parallel tasks', 'At most 3 implementers', '`task-open --worktree`', 'plan order', 'landing conflict', 'TRIQUAL_LANDING_TEST_TIMEOUT_MS']) {
    assert.ok(entry.includes(line), `the 1.4.0 CHANGELOG entry lacks: ${line}`);
  }
  assert.equal(JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.6.0');
  assert.ok(PROMPT().includes('## Parallel Tasks'), 'the orchestrator prompt has no Parallel Tasks section');
});

test('an earlier unstarted task is never blocked by a later one: a batch starts only when every earlier task is closed', () => {
  const body = parallel();
  for (const line of [
    '**An earlier task is never blocked by a later one.**',
    'A later task never starts while an earlier task that has not started could be held back by it',
    'a batched light task holds back every other task, so a task of a batch starts only when every earlier task of the phase is closed (a batch therefore always runs in the main checkout)',
    'a parallel task holds an earlier one back only through a shared path (the independence rule above) or a slot (the slot rule above)',
    // the reason, as the deadlock the independence rule already names
    "would wait for the light task to close while the light task's `task-close` waits for it to land",
  ]) assert.ok(body.includes(line), `Parallel tasks lacks: ${line}`);
  assert.ok(flat(section(skill(), '#### Batched light dispatch')).includes('a task of a batch starts only when every earlier task of the phase is closed'), 'Batched light dispatch does not give the start rule');
  assert.ok(flat(PROMPT()).includes('a task of a batch starts only when every earlier task of the phase is closed (an earlier task is never blocked by a later one)'), 'the orchestrator prompt does not give the start rule');
  const log = readFileSync(join(PLUGIN, '..', '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(flat(log.slice(log.indexOf('\n## methodology 1.4.0'), log.indexOf('\n## methodology 1.3.0'))).includes('An earlier task is never blocked by a later one'), 'the CHANGELOG does not state the start rule');
});

test('the BASE of a worktree task is the last closed commit, and the scripts do it', () => {
  const body = parallel();
  assert.ok(body.includes('The BASE of a worktree task is the last closed commit of the phase branch: the phase tip, or, when a task built in the main checkout has commits that no `task-close` has squashed yet, that task\'s own BASE'), 'Parallel tasks does not say what a worktree task is based at');
  assert.doesNotMatch(body, /started at its BASE \(the phase tip\)/, 'the phase-tip claim is still there');
  assert.ok(flat(PROMPT()).includes('based by `task-open` at the last closed commit, never on a main-checkout task\'s unreviewed commits'), 'the orchestrator prompt does not say it');
  assert.match(readFileSync(join(SCRIPTS, 'task-open'), 'utf8'), /worktree \? common\.worktreeBase\(/, 'task-open no longer takes the BASE of a worktree task from worktreeBase');
});

test('the worktree of a task is the exception to "no worktree by default", in Setup and in Worktrees', () => {
  const text = flat(skill());
  assert.ok(text.includes('the one exception is the task worktrees of Parallel tasks, which the plan\'s own parallel rule creates under `.claude/worktrees/` without any request'), 'Setup does not reconcile with Parallel tasks');
  assert.ok(flat(section(skill(), '## Worktrees')).includes('the task worktrees of Parallel tasks are not that request and need none (`task-open --worktree` makes them)'), 'Worktrees does not reconcile with Parallel tasks');
});

test('task-open step: not every non-zero exit writes an Error line', () => {
  const one = flat(section(skill(), '### 1. Start the task'));
  assert.ok(one.includes('except a bad argument list and a refusal from a linked worktree (`run from the main checkout`), which come before the workspace is known and write none'), 'step 1 still says every non-zero exit appends an Error line');
  // the scripts: both refusals come before the workspace is set
  const open = readFileSync(join(SCRIPTS, 'task-open'), 'utf8');
  const at = (needle) => open.indexOf(needle);
  assert.ok(at("throw new ScriptError(EXIT_USAGE, USAGE)") < at('workspace = common.workspaceOf(plan)') && at('common.assertMainCheckout()') < at('workspace = common.workspaceOf(plan)'), 'task-open sets the workspace before its usage and linked-worktree refusals');
});

// ---- final fix round 1: coordinator hand-off bound by the parallel rule, stale step 6 and [WORK_DIR] text ----------

const COORD_START = 'only once every earlier task of the phase is done or dropped and nothing else runs there';

test('a coordinator task starts like a batch task: every earlier task done or dropped and nothing else in the main checkout, in the skill, the prompt and the role', () => {
  const coord = flat(section(skill(), '### Coordinator tasks'));
  assert.ok(coord.includes('works in the main checkout and starts like a batch task'), 'Coordinator tasks does not say where a coordinator task starts');
  assert.ok(coord.includes(COORD_START), 'Coordinator tasks lacks the start condition');
  assert.ok(coord.includes('`task-open` refuses it with exit 3 otherwise'), 'Coordinator tasks does not say the script refuses it');
  assert.ok(coord.includes("its BASE is `HEAD` and its close squashes `BASE..HEAD`, which would absorb an earlier task's unreviewed commits"), 'Coordinator tasks does not give the reason');
  const handoff = thin().slice(thin().indexOf('**Coordinator tasks.**'));
  for (const line of [COORD_START, 'until then it waits like any task that is not independent', 'lets running agents finish their current step first', 'Once it may start']) {
    assert.ok(handoff.includes(line), `the coordinator handoff lacks: ${line}`);
  }
  assert.ok(handoff.indexOf(COORD_START) < handoff.indexOf('`BLOCKED: coordinator task T<N>'), 'the start condition comes after the handoff line');
  assert.ok(flat(section(skill(), '### Parallel tasks')).includes('A coordinator task is always a main-checkout task: it starts only once every earlier task of the phase is done or dropped'), 'Parallel tasks does not put a coordinator task under the Where rule');
  const prompt = PROMPT();
  for (const line of [COORD_START, 'until then it waits like any task that is not independent', 'Once it may start']) assert.ok(prompt.includes(line), `the orchestrator prompt lacks: ${line}`);
  const role = ORCHESTRATOR_ROLE();
  for (const line of ['starts only once every earlier task of the phase is done or dropped and nothing else runs there', 'until then it waits', 'Once it may start']) assert.ok(role.includes(line), `the orchestrator role lacks: ${line}`);
});

test('task-open enforces the coordinator start rule through the shared earlier-task check', () => {
  const open = readFileSync(join(SCRIPTS, 'task-open'), 'utf8');
  assert.match(open, /!worktree && planTask\.task\.role === 'coordinator'/, 'task-open does not look at a coordinator task');
  assert.match(open, /common\.earlierUnfinished\(/, 'task-open does not use the earlier-task check');
  assert.match(readFileSync(join(SCRIPTS, 'task-close'), 'utf8'), /common\.earlierUnfinished\(/, 'task-close does not use the shared earlier-task check');
});

test('SKILL, prompt and role agree on who runs a coordinator task: the main session one that edits a file, the orchestrator one that edits none', () => {
  assert.doesNotMatch(skill(), /never by the phase orchestrator/, 'Coordinator tasks still says the orchestrator never runs one');
  assert.ok(flat(section(skill(), '### Coordinator tasks')).includes('the phase orchestrator runs one that edits no file itself'), 'Coordinator tasks does not say the orchestrator runs one that edits none');
  assert.ok(thin().includes('the orchestrator runs itself; one that edits a file it hands over'), 'The Thin Controller does not say it');
  assert.ok(PROMPT().includes('one that edits no file you run yourself'), 'the orchestrator prompt does not say it');
  assert.ok(ORCHESTRATOR_ROLE().includes('one that edits no file you run yourself'), 'the orchestrator role does not say it');
});

test('step 6 says which non-zero exits of task-close write no Error line, and lists the earlier-task wait and the undone landing as exit 3', () => {
  const six = flat(section(skill(), '### 6. Complete the task'));
  for (const line of [
    'a worktree task whose earlier tasks have not landed, an undone landing',
    'except the earlier-task wait of a worktree task (a wait, not a failure) and a refusal from a linked worktree (`run from the main checkout`), which write none',
  ]) assert.ok(six.includes(line), `step 6 lacks: ${line}`);
  assert.doesNotMatch(six, /before a non-zero exit it appends `Error: task-close T<N> — exit <code> — <first stderr line>` to the ledger\.(?! )/, 'step 6 still says every non-zero exit writes an Error line');
});

test('[WORK_DIR] is the task worktree of a task opened with --worktree, for the implementer and its fixer', () => {
  const line = flat(read(`${EP}/implementer-prompt.md`)).split('- `[WORK_DIR]`')[1].split('- `[TRACKING]`')[0];
  assert.ok(line.includes('for a task opened with `task-open --worktree`, the task worktree it printed as `workdir:`, for the implementer and for its fixer'), 'the [WORK_DIR] placeholder is still the plan checkout only');
});

test('a worktree task: task-prep takes the branch tip without --head, a no-commit task closes at the phase tip, and task-open does not restart a blocked task', () => {
  const body = flat(section(skill(), '### Parallel tasks'));
  assert.ok(body.includes('without `--head`, `task-prep` takes that tip itself when the branch exists, as `task-close` does, and never `HEAD` of the main checkout'), 'Parallel tasks does not give the task-prep default');
  assert.ok(body.includes('closes at the tip of the phase branch (its complete line reads `<tip>..<tip>`, so a Phase check reopen squashes from that tip and never folds in the tasks that closed after the task opened), never at its own BASE'), 'Parallel tasks does not give where a no-commit worktree task closes');
  const one = flat(section(skill(), '### 1. Start the task'));
  assert.ok(one.includes('when opted in and the task is `pending`, the `start` move'), 'step 1 still starts a blocked task');
  assert.ok(one.includes('a `blocked` task is refused with exit 3: only your human partner\'s decision restarts it, by the `start` move the main session makes'), 'step 1 does not say a blocked task is refused');
  assert.doesNotMatch(one, /`pending` or `blocked`/);
  assert.ok(one.includes('a blocked task, a coordinator task while an earlier task of its phase is not done or dropped'), 'step 1 does not list the new exit-3 refusals');
  assert.match(readFileSync(join(SCRIPTS, 'task-open'), 'utf8'), /const STARTABLE = \['pending'\];/, 'task-open still starts a blocked task');
  assert.match(readFileSync(join(SCRIPTS, 'task-prep'), 'utf8'), /refs\/heads\/\$\{common\.worktreeOf\(planName, n\)\.branch\}/, 'task-prep does not read the worktree branch');
});
