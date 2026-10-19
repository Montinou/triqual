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
];
// The implementer's `<task role>` placeholder is a valid dispatch type in its own template only.
const TASK_ROLE_TEMPLATES = new Set([`${EP}/implementer-prompt.md`]);

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

test('the role-eval record examples in the skill validate, and cover task-review, final-escapes, the final hunters and a post-merge escape', () => {
  const blocks = [...skill().matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 3, 'fewer than three record examples');
  for (const record of blocks) assert.deepEqual(validateRecord(record), { ok: true }, JSON.stringify(record));
  const kinds = blocks.map((r) => `${r.kind}:${r.task === 'final' ? 'final' : 'task'}`);
  for (const k of ['task-review:task', 'final-escapes:final', 'hunters:final', 'escape:task']) assert.ok(kinds.includes(k), `no ${k} example`);
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
  'final-review-prompt.md',
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
  assert.equal(files.length, 8, files.join(', '));
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
  assert.deepEqual(readdirSync(SCRIPTS).sort(), ['lib', 'review-package', 'sdd-workspace', 'stack.mjs', 'task-brief', 'tier-check']);
});

// ---- the harness references -----------------------------------------------------------------------------------------------

test('the harness references name the one orchestrator and keep their routing statements', () => {
  const claude = flat(read('using-methodology/references/claude-code-tools.md'));
  assert.ok(claude.includes('The controller of a methodology:executing-plans run reads every result'), 'claude-code-tools.md does not name the controller of executing-plans');
  assert.doesNotMatch(claude, /mid-tier/i, 'claude-code-tools.md still advises an orchestrator on a mid-tier model');
  assert.match(claude, /`roles:<name>`/, 'claude-code-tools.md does not describe role dispatch');
  const codex = flat(read('using-methodology/references/codex-tools.md'));
  assert.ok(codex.includes('that `executing-plans` uses.'), 'codex-tools.md does not name executing-plans for multi-agent support');
  assert.doesNotMatch(codex, /dispatching-parallel-agents/, 'codex-tools.md still names the removed dispatching-parallel-agents');
  assert.doesNotMatch(codex, /Model Selection/, 'codex-tools.md still points at Model Selection');
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
  const squash = done.indexOf('1. **Squash:** run `node scripts/stack.mjs squash PLAN_FILE BASE`');
  const move = done.indexOf('`triqual tasks done T<N> --commit <sha> --plan <plan>`');
  const line = done.indexOf('`Task <N>: complete (commits <base7>..<head7>, review clean)`');
  assert.ok(squash >= 0 && move > squash && line > move, 'the order is not squash, then tasks done, then the complete line');
  for (const text of ['with `git commit-tree`', 'never a rebase and never a `git commit`', 'so no hook runs and no gate fires', 'with the sha the squash printed']) {
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
