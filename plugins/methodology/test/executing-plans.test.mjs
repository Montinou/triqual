// Contract pins for the orchestrator, `executing-plans` (design U3, U4, Decision 9): the tier matrix equals spec U4,
// the invariants (a tier is never lowered, the gate on every task with commits, the final review always runs, a
// behavior change starts with a failing test), the role-eval record examples validate, every template placeholder is
// defined, batched light dispatch, the tierless setup rubric, and the dispatch-line pins restored from the retired
// fork.test. They pin rules, not prose: each check names the sentence or table that carries a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRecord } from '../cli/lib/role-eval.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(PLUGIN, 'skills');
const AGENTS = join(PLUGIN, '..', 'roles', 'agents');
const EP = 'executing-plans';
const TEMPLATES = [
  'implementer-prompt.md',
  'hunter-prompt.md',
  'safety-review-prompt.md',
  'task-reviewer-prompt.md',
  're-review-prompt.md',
  'final-review-prompt.md',
];
// The implementer's `<task role>` placeholder is a valid dispatch type in its own template only (the old skill's copy
// stays until it is removed).
const TASK_ROLE_TEMPLATES = new Set([`${EP}/implementer-prompt.md`, 'subagent-driven-development/implementer-prompt.md']);
// The one skill that may dispatch a generic agent, which must then name its model (removed by a later task).
const GENERIC_AGENT_SKILL = 'dispatching-parallel-agents';

const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const skill = () => read(`${EP}/SKILL.md`);
const ROLE_AGENTS = new Set(
  readdirSync(AGENTS).filter((n) => n.endsWith('.md')).map((n) => `roles:${n.slice(0, -3)}`),
);

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
    '4 hunters: correctness, security, spec-drift, state + safety gate',
    '`roles:spec-reviewer` on every candidate and spec fit',
    'scoped re-review by the raising role(s), always',
  ],
  [
    'standard',
    "2 hunters: correctness + the category the plan's Review Focus names for the task, else the riskiest for the diff (security by default) + safety gate",
    '`roles:spec-reviewer`',
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

test('the role-eval record examples in the skill validate, and cover task-review, final-escapes and the final hunters', () => {
  const blocks = [...skill().matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 3, 'fewer than three record examples');
  for (const record of blocks) assert.deepEqual(validateRecord(record), { ok: true }, JSON.stringify(record));
  const kinds = blocks.map((r) => `${r.kind}:${r.task === 'final' ? 'final' : 'task'}`);
  for (const k of ['task-review:task', 'final-escapes:final', 'hunters:final']) assert.ok(kinds.includes(k), `no ${k} example`);
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
  const generic = /^general-purpose,\s*model:\s*\S+$/;
  const bad = [];
  for (const path of walk(SKILLS).filter((p) => p.endsWith('.md'))) {
    read(path).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:sub)?agent\s*\(([^)]*)\)\s*:/gi)) {
        const type = m[1].trim();
        const ok =
          ROLE_AGENTS.has(type) ||
          (type === '<task role>' && TASK_ROLE_TEMPLATES.has(path)) ||
          (path.startsWith(`${GENERIC_AGENT_SKILL}/`) && generic.test(type));
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
    "only after the previous task's review, squash and `triqual tasks done` finished",
    'Record BASE before each resume',
    '`tier-check`, the review and the ledger moves stay per task',
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
  assert.ok(text.includes('the re-review follows the higher tier'));
});

// Each kept SDD behavior is pinned in the section that carries it, not in the summary at the top of the skill.
test('the kept SDD behaviors are in their own sections', () => {
  const text = skill();
  const pins = {
    '### 1. Start the task': ['Record BASE (`git rev-parse HEAD`) before', 'never `HEAD~1`'],
    '### 4. Review the task': ['on one review package'],
    '#### Round 2': ['`confirmed` (with a severity), `refuted`, `duplicate-candidate` and `duplicate-review`'],
    '### 5. The fix loop': ['`Task <N>: minor (deferred): <one-liner>`', 'after round 5 the task is blocked'],
    '### 6. Complete the task': ['`git commit-tree`'],
    '### 7. End the phase': [
      "Run the phase's `**Phase check:**` command at the tip of the phase branch",
      'A failure that passes on one re-run is flaky',
      '`triqual tasks reopen T<N> "<reason>" --plan <plan>`',
      '`node scripts/stack.mjs done PLAN_FILE N`',
      '`node scripts/stack.mjs submit PLAN_FILE N`',
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
    moreText.includes("skip the first granted round's `triqual tasks rework` move: `start` already moved the task to `in_progress`"),
    'more rounds does not skip the first rework (rework only leaves in_review)',
  );
  assert.doesNotMatch(text, /role-eval|`task-review` record/, 'the breaker writes a record (it is written once, at completion)');
});

test('a resumed session treats a blocked task as a stop, never a re-dispatch', () => {
  const ws = flat(section(skill(), '### Workspace and ledger'));
  assert.ok(ws.includes('A task whose last ledger line is its `Task <N>: blocked` line is the sixth stop again'), 'no blocked resume rule');
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

test('step 6 writes the completion line right after tasks done, before the record; the record is written once', () => {
  const six = flat(section(skill(), '### 6. Complete the task'));
  const done = six.indexOf('`triqual tasks done T<N>');
  const complete = six.indexOf('`Task <N>: complete');
  const record = six.indexOf('`triqual role-eval record');
  assert.ok(done >= 0 && complete > done && record > complete, 'order is not done → complete line → record');
  const records = flat(section(skill(), '## Records'));
  assert.ok(records.includes('written once, when the task completes'));
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
  assert.ok(text.includes('3 hunters'));
  assert.ok(text.includes('`roles:final-adversarial-reviewer`'));
});

test('worktrees only on request, as a section of the orchestrator', () => {
  const text = flat(section(skill(), '## Worktrees'));
  assert.ok(text.includes('only when your human partner explicitly asks'));
  assert.ok(text.includes('native'));
});

test('the skill credits superpowers without a fork footer', () => {
  const text = skill();
  assert.match(text, /superpowers[^\n]*Jesse Vincent[^\n]*LICENSE-superpowers/);
  assert.doesNotMatch(text, /Forked from/);
});

test('the pressure scenarios S1 and S3 point at the new files', () => {
  const spec = JSON.parse(readFileSync(join(PLUGIN, 'test', 'pressure', 'scenarios.json'), 'utf8'));
  const of = (id) => spec.scenarios.find((s) => s.id === id).skills;
  assert.ok(of('S1').includes(`${EP}/implementer-prompt.md`));
  assert.deepEqual(of('S3'), [`${EP}/SKILL.md`]);
  for (const s of spec.scenarios) for (const p of s.skills) assert.ok(existsSync(join(SKILLS, p)), `${s.id}: ${p}`);
});
