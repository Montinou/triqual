// subagent-driven-development (spec §11, §6.4, Addendum E.4/E.5): role dispatch, the task ledger moves, tracking
// paths, the .methodology/sdd/ workspace and its scripts. Script tests run in a temp git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePlan } from '../../progress-tracking/lib/ledger.mjs';
import { validateRecord } from '../bin/lib/role-eval.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const FENCES_PLAN = join(PLUGIN, 'test', 'fixtures', 'fences-plan.md');
const SKILLS = join(PLUGIN, 'skills');
const SDD = 'subagent-driven-development';
const SCRIPTS = join(SKILLS, SDD, 'scripts');

const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const lines = (path) => read(path).split('\n').map((line) => line.trim());
const SDD_FILES = [
  'SKILL.md',
  'implementer-prompt.md',
  'task-reviewer-prompt.md',
  'safety-review-prompt.md',
  're-review-prompt.md',
  'final-review-prompt.md',
  'hunter-prompt.md',
  'scripts/sdd-workspace',
  'scripts/review-package',
  'scripts/task-brief',
].map((name) => `${SDD}/${name}`);
const sddLines = () =>
  SDD_FILES.filter((path) => existsSync(join(SKILLS, path))).flatMap((path) =>
    read(path)
      .split('\n')
      .map((line, i) => [path, i + 1, line.trim()]),
  );
// The trimmed lines of SKILL.md from one heading (included) to the next heading of the same or a higher level.
const section = (heading) => {
  const all = lines(`${SDD}/SKILL.md`);
  const start = all.indexOf(heading);
  assert.ok(start >= 0, `SKILL.md has no heading ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  const end = all.findIndex((line, i) => i > start && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return all.slice(start, end < 0 ? undefined : end);
};
const firstDispatch = (path) => lines(path).find((line) => /^Subagent \(/.test(line));

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
    spawnSync('bash', [join(SCRIPTS, script), ...args], { cwd: dir, env, encoding: 'utf8' });
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

// --- Role dispatch (E.4, E.5) -------------------------------------------------------------------------------------

test('SKILL.md dispatches each task to its **Role:**', () => {
  const roles = section('## Role Dispatch');
  const find = (predicate, what) => {
    const line = roles.find(predicate);
    assert.ok(line, `Role Dispatch lacks ${what}`);
    return line;
  };
  // The default.
  const byDefault = find((l) => l.includes('`roles:tdd-implementer`') && /default/i.test(l), 'the default role');
  assert.match(byDefault, /no `\*\*Role:\*\*` line/, 'the default does not apply to a task without a Role line');
  // A coordinator task: the controller runs it, with the same ledger moves and reviews.
  const coordinator = find((l) => l.startsWith('- **`coordinator`**'), 'the coordinator case');
  for (const re of [/controller runs the task itself/, /same ledger moves/, /same reviews/]) {
    assert.match(coordinator, re, `the coordinator case does not say ${re}`);
  }
  // The implementer template's header carries the task role, filled with one of the three implementing roles.
  assert.equal(firstDispatch(`${SDD}/implementer-prompt.md`), 'Subagent (<task role>):');
  const header = find((l) => l.includes('`<task role>`'), 'the header rule');
  for (const role of ['`roles:tdd-implementer`', '`roles:complex-implementer`', '`roles:review-fixer`']) {
    assert.ok(header.includes(role), `the header rule does not name ${role}: ${header}`);
  }
  const template = read(`${SDD}/implementer-prompt.md`);
  for (const role of ['`roles:tdd-implementer`', '`roles:complex-implementer`', '`roles:review-fixer`']) {
    assert.ok(template.includes(role), `implementer-prompt.md does not name ${role}`);
  }
  // Any other role stops and asks; a reviewer role is never a task role.
  const other = find((l) => l.startsWith('- **Any other role**'), 'the other-role case');
  for (const re of [/reviewer role/, /stop and ask/, /[Nn]ever dispatch it/]) {
    assert.match(other, re, `the other-role case does not say ${re}`);
  }
  assert.ok(other.includes('`roles:hunter`'), `the other-role case does not list roles:hunter: ${other}`);
  // Reviewers are fixed.
  const reviews = find((l) => l.startsWith('- **Reviews:**'), 'the reviewers');
  for (const needle of ['`roles:spec-reviewer`', '`roles:safety-reviewer`', 'together', "never the task's own role"]) {
    assert.ok(reviews.includes(needle), `the reviewers line does not say ${needle}: ${reviews}`);
  }
  // Stopping on an unknown role is one of the named stops.
  const stops = lines(`${SDD}/SKILL.md`).find((l) => /^Five things stop you/.test(l));
  assert.ok(stops, 'the stop list does not count the unknown-role stop');
  // The templates dispatch exactly their roles.
  assert.equal(firstDispatch(`${SDD}/task-reviewer-prompt.md`), 'Subagent (roles:spec-reviewer):');
  assert.equal(firstDispatch(`${SDD}/safety-review-prompt.md`), 'Subagent (roles:safety-reviewer):');
});

test('the final review dispatches final-review-prompt.md, not code-reviewer.md', () => {
  const final = section('## Final Review').join('\n');
  assert.ok(final.includes('[final-review-prompt.md](final-review-prompt.md)'), 'Final Review does not link the template');
  assert.ok(final.includes('`roles:final-adversarial-reviewer`'), 'Final Review does not name the role');
  assert.ok(final.includes('`roles:review-fixer`'), 'the final fix wave does not go to roles:review-fixer');
  const bad = sddLines()
    .filter(([, , line]) => /code-reviewer\.md|requesting-code-review/.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, [], 'the skill still points at requesting-code-review');
  const template = `${SDD}/final-review-prompt.md`;
  assert.equal(firstDispatch(template), 'Subagent (roles:final-adversarial-reviewer):');
  const text = read(template);
  for (const name of ['PACKAGE_PATH', 'PLAN_PATH', 'SPEC_PATH', 'REVIEW_FOCUS', 'SDD_LEDGER_PATH']) {
    assert.ok(text.includes(`[${name}]`), `final-review-prompt.md lacks the placeholder [${name}]`);
  }
  const placeholder = (name) => text.split('\n').find((l) => l.startsWith(`- \`[${name}]\``)) ?? '';
  assert.match(placeholder('REVIEW_FOCUS'), /verbatim/, 'REVIEW_FOCUS is not copied verbatim');
  assert.match(placeholder('SDD_LEDGER_PATH'), /`Ruling:`/, 'SDD_LEDGER_PATH does not name its Ruling: lines');
});

test('safety-review-prompt.md treats tracking files as expected in every task diff', () => {
  const template = `${SDD}/safety-review-prompt.md`;
  const line = lines(template).find((l) => l.includes('`progress.md`') && l.includes('`status.md`'));
  assert.ok(line, 'the safety review does not name the tracking files');
  for (const needle of ['`*.tasks.json`', 'expected in every task diff']) {
    assert.ok(line.includes(needle), `the tracking-files rule does not say ${needle}: ${line}`);
  }
  assert.match(line, /never flag them/i, 'the tracking files may still be flagged');
});

test('re-review goes to the role or roles that raised the findings', () => {
  const template = `${SDD}/re-review-prompt.md`;
  const dispatches = lines(template).filter((l) => /^Subagent \(/.test(l));
  assert.deepEqual(dispatches, ['Subagent (roles:spec-reviewer):', 'Subagent (roles:safety-reviewer):']);
  const rule = (path) => lines(path).find((l) => /the role or roles that raised/.test(l));
  assert.ok(rule(template), 're-review-prompt.md does not route by the raising role');
  const skill = rule(`${SDD}/SKILL.md`);
  assert.ok(skill, 'SKILL.md does not route the re-review by the raising role');
  assert.match(section('## Final Review').join('\n'), /re-review[^\n]*`roles:final-adversarial-reviewer`/);
});

test('SKILL.md names triqual tasks start, review, rework and done --commit at dispatch, handoff, each fix round and approval', () => {
  const moves = [
    ['### 1. Dispatch the implementer', '`triqual tasks start T<N> --plan <plan>`', /dispatch/],
    ['### 2. Handle the report', '`triqual tasks review T<N> --plan <plan>`', /\bDONE\b/],
    ['### 4. The fix loop', '`triqual tasks rework T<N> --plan <plan>`', /each fix round/],
    ['### 5. Complete the task', '`triqual tasks done T<N> --commit <sha> --plan <plan>`', /approv/],
  ];
  for (const [heading, command, when] of moves) {
    const line = section(heading).find((l) => l.includes(command));
    assert.ok(line, `${heading} does not run ${command}`);
    assert.match(line, when, `${command} is not tied to ${when}: ${line}`);
  }
});

test('SKILL.md reads tracking paths from triqual tasks paths --json and skips ledger moves and progress rules when not opted in', () => {
  const all = lines(`${SDD}/SKILL.md`);
  assert.ok(all.some((l) => l.includes('`triqual tasks paths --json`')), 'SKILL.md does not run triqual tasks paths --json');
  const opted = all.find((l) => l.startsWith('- **Opted in**'));
  const notOpted = all.find((l) => l.startsWith('- **Not opted in**'));
  const missing = all.find((l) => l.startsWith('- **`triqual` missing**'));
  assert.ok(opted && notOpted && missing, 'SKILL.md lacks one of the three tracking cases');
  assert.match(opted, /`"optedIn": true`/);
  for (const re of [/`"optedIn": false`/, /exit 2/, /no ledger moves/, /no `triqual tasks` command/, /no `progress\.md` rules/, /never create `progress\.md`/]) {
    assert.match(notOpted, re, `the not-opted-in case does not say ${re}`);
  }
  for (const re of [/exit 3/, /`PATH`/, /as not opted in/, /once/]) {
    assert.match(missing, re, `the triqual-missing case does not say ${re}`);
  }
  // Every other instruction line that moves the ledger or names progress.md is for an opted-in repo. (Scripts are not
  // instructions: sdd-workspace names the pre-fork workspace ledger, `…/progress.md`, to adopt it.)
  const bad = sddLines()
    .filter(([path]) => path.endsWith('.md'))
    .filter(([, , line]) => /triqual tasks (start|review|rework|done)|progress\.md/.test(line))
    .filter(([, , line]) => !line.startsWith('- **Not opted in**'))
    .filter(([, , line]) => !/\bopted in\b/i.test(line.replace(/not opted in/gi, '')))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, [], 'a ledger move or progress.md rule outside an opted-in instruction');
});

test('implementer and fixer briefs carry the progress.md entry rule, the staging rule and the task-skills rule (§11) only when opted in', () => {
  const template = lines(`${SDD}/implementer-prompt.md`);
  const at = (heading) => {
    const start = template.indexOf(heading);
    assert.ok(start >= 0, `implementer-prompt.md has no ${heading}`);
    const end = template.findIndex((l, i) => i > start && /^## /.test(l));
    return template.slice(start, end);
  };
  const tracking = at('## Tracking');
  assert.match(tracking[2], /^\[TRACKING — include this section only when the repo is opted in/, 'Tracking is not conditional');
  assert.match(tracking[2], /drop it when/, 'Tracking is not dropped when not opted in');
  assert.match(tracking[2], /or `triqual` is missing\]/, 'Tracking does not name the missing CLI as triqual');
  const entry = tracking.find((l) => l.startsWith('- **progress.md entry (opted in):**'));
  assert.ok(entry, 'no progress.md entry rule');
  for (const needle of ['`progress`', '`Plan <topic> · T<N>`', '· fix <k>', '`status`']) {
    assert.ok(entry.includes(needle), `the entry rule does not name ${needle}`);
  }
  const staging = tracking.find((l) => l.startsWith('- **Staging (opted in):**'));
  assert.ok(staging, 'no staging rule');
  for (const needle of ['`"mode": "committed"`', '`progress.md`', '`status.md`', '`*.tasks.json`', '`--no-verify`']) {
    assert.ok(staging.includes(needle), `the staging rule does not name ${needle}`);
  }
  assert.ok(tracking.some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')), 'no local-mode rule');
  // §11's task-skills rule, verbatim commands; the ledger check applies when opted in.
  const skills = at('## Task Skills').join('\n');
  for (const needle of [
    '`skillvault list --json`',
    '`skillvault add <slug> --to claude --session --source plan`',
    'only the skills you added in this task',
    'still session entries',
    'Never run `remove` on a skill that was installed before the task',
    '`in_progress`',
    'the last task that uses it removes it',
  ]) {
    assert.ok(skills.includes(needle), `the task-skills rule does not say ${needle}`);
  }
  assert.match(skills, /When opted in, skip the removal/, 'the ledger check is not tied to an opted-in repo');
  // The fixer's message carries the same sections, under the same conditions.
  const fix = section('### 4. The fix loop');
  const carries = fix.find((l) => l.includes('Tracking') && l.includes('Task Skills'));
  assert.ok(carries, "the fix loop does not carry the implementer template's Tracking and Task Skills sections");
  assert.match(carries, /when opted in/, 'the fixer carries Tracking unconditionally');
  assert.ok(carries.includes('`roles:review-fixer`'), carries);
});

test('fix rounds go to roles:review-fixer: rounds 1–3 resume the same fixer, rounds 4–5 a fresh one', () => {
  const fix = section('### 4. The fix loop').join('\n');
  assert.match(fix, /\*\*Rounds 1-3 — resume the same `roles:review-fixer`\.\*\*/);
  assert.match(fix, /\*\*Rounds 4-5 — dispatch a fresh `roles:review-fixer`\*\*/);
});

test('no dispatch passes a model', () => {
  const bad = sddLines()
    .filter(([, , line]) => /specify the model|^model:|Model Selection|more capable model|most capable/i.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, [], 'a dispatch still chooses a model');
  const all = lines(`${SDD}/SKILL.md`);
  assert.ok(!all.includes('## Model Selection'), 'the Model Selection section is still there');
  const roles = section('## Role Dispatch').join('\n');
  assert.match(roles, /no dispatch passes a model/i, 'the roles section does not forbid a model');
});

test('the harness references route dispatch through roles, not Model Selection', () => {
  const claude = read('using-methodology/references/claude-code-tools.md');
  assert.doesNotMatch(claude, /mid-tier/i, 'claude-code-tools.md still advises an orchestrator on a mid-tier model');
  assert.match(claude, /`roles:<name>`/, 'claude-code-tools.md does not describe role dispatch');
  const codex = read('using-methodology/references/codex-tools.md');
  assert.doesNotMatch(codex, /Model Selection/, 'codex-tools.md still points at Model Selection');
  assert.match(codex, /role/i, 'codex-tools.md does not route spawns by role');
});

// --- Fix round 1 --------------------------------------------------------------------------------------------------

test('the workspace ledger is named sdd-ledger.md, never "progress ledger"', () => {
  const bad = sddLines()
    .filter(([, , line]) => /progress ledger/i.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, []);
  assert.ok(
    section('### 4. The fix loop').some((l) => l.includes('`sdd-ledger.md`') && /minor \(deferred\)|Minor findings/.test(l)),
    'the deferred-minor rule does not name sdd-ledger.md',
  );
});

test("the final fix wave's fixer carries the Tracking section when opted in", () => {
  const line = section('## Final Review').find((l) => l.includes('Tracking section'));
  assert.ok(line, 'the final fix wave does not carry the Tracking section');
  for (const needle of ['when opted in', '`progress.md` entry', 'staging rule', '`Plan <topic> · final fix`']) {
    assert.ok(line.includes(needle), `the final fix wave's Tracking rule does not say ${needle}: ${line}`);
  }
});

test('compaction recovery reconciles with triqual tasks status --json before a ledger move', () => {
  const line = lines(`${SDD}/SKILL.md`).find((l) => l.includes('`triqual tasks status --json`'));
  assert.ok(line, 'SKILL.md does not read triqual tasks status --json');
  for (const re of [/compaction/, /when opted in/, /skip any move the ledger already shows/, /`rework`/, /`in_progress`/, /`\*\.tasks\.json`/]) {
    assert.match(line, re, `the recovery rule does not say ${re}`);
  }
});

test('the implementer is not told it will be resumed with findings; fixes go to roles:review-fixer', () => {
  const template = lines(`${SDD}/implementer-prompt.md`);
  assert.ok(!template.some((l) => /resumed with the findings/.test(l)), 'the implementer is still told it will be resumed');
  const start = template.indexOf('## After Review Findings');
  const end = template.findIndex((l, i) => i > start && /^## /.test(l));
  assert.ok(start >= 0, 'no After Review Findings section');
  assert.match(template.slice(start, end).join(' '), /`roles:review-fixer`/, 'fixes are not sent to roles:review-fixer');
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

// --- The two-round task review (plan role-tiers · T5, spec 4.1-4.6) -------------------------------------------------

const SKILL = `${SDD}/SKILL.md`;
const squash = (all) => all.join(' ').replace(/\s+/g, ' ');
const findLine = (all, predicate, what) => {
  const line = all.find(predicate);
  assert.ok(line, `missing: ${what}`);
  return line;
};
const reviewSection = () => section('### 3. Review the task');
const mustSay = (line, needles, what) => {
  for (const needle of needles) {
    assert.ok(typeof needle === 'string' ? line.includes(needle) : needle.test(line), `${what} does not say ${needle}: ${line}`);
  }
};

test('round 1 dispatches the hunters and the safety gate together', () => {
  const line = findLine(
    reviewSection(),
    (l) => l.includes('`roles:hunter`') && l.includes('`roles:safety-reviewer`') && l.includes('together'),
    'the round 1 dispatch line',
  );
  mustSay(line, ['together', 'background', '[hunter-prompt.md](hunter-prompt.md)', '[safety-review-prompt.md](safety-review-prompt.md)'], 'the round 1 line');
  const reviews = findLine(section('## Role Dispatch'), (l) => l.startsWith('- **Reviews:**'), 'the Reviews line');
  mustSay(reviews, ['`roles:hunter`', '`roles:safety-reviewer`', 'together', '`roles:spec-reviewer`'], 'the Reviews line');
  assert.doesNotMatch(reviews, /two reviewers|in parallel/, 'the Reviews line still pins the old two-reviewer shape');
});

test('the safety shadow is retired: no SDD file names it, and its templates are gone', () => {
  // The one mention left is the Record rule that says no safety-shadow record is written any more.
  for (const [path, n, line] of sddLines()) {
    if (path === SKILL && line.includes('No `safety-shadow` record is written any more')) continue;
    assert.doesNotMatch(line, /shadow/i, `${path}:${n} still names the shadow`);
  }
  const headers = lines(`${SDD}/safety-review-prompt.md`).filter((l) => /^Subagent \(/.test(l));
  assert.deepEqual(headers, ['Subagent (roles:safety-reviewer):']);
  assert.ok(!existsSync(join(SKILLS, SDD, 'shadow-candidates.md')), 'shadow-candidates.md is still shipped');
  assert.ok(!existsSync(join(SKILLS, SDD, 'safety-shadow-prompt.md')), 'a shadow template is shipped');
});

test('the soft wait is 10 minutes after the gate\'s report, 20 in the final review, and a late hunter is failed', () => {
  const line = findLine(reviewSection(), (l) => l.includes('soft limit') && l.includes('10 minutes'), 'the soft wait rule');
  mustSay(line, ["gate's report", '20 minutes', 'failed', 'ignored', 'hunter'], 'the soft wait rule');
  const final = findLine(section('## Final Review'), (l) => l.includes('20 minutes'), 'the final review wait');
  mustSay(final, ['20 minutes from their dispatch', 'no gate report'], 'the final review wait');
});

test('a hunter whose candidates file is valid and empty counts as done with 0 candidates', () => {
  const line = findLine(reviewSection(), (l) => l.startsWith('- Ledger: `Round 1:'), 'the Round 1 ledger bullet');
  mustSay(line, ['valid', 'empty', 'counts as done', '0 candidates'], 'the Round 1 ledger bullet');
});

test('round 2 gives the spec reviewer every candidates file', () => {
  const line = findLine(reviewSection(), (l) => l.includes('`roles:spec-reviewer`') && l.includes('every candidates file'), 'the round 2 dispatch line');
  mustSay(line, ["every candidates file of round 1 (the hunters')", 'one verdict per candidate', '[task-reviewer-prompt.md](task-reviewer-prompt.md)'], 'the round 2 line');
  assert.ok(read(`${SDD}/task-reviewer-prompt.md`).includes('[CANDIDATES_FILES]'), 'task-reviewer-prompt.md lacks [CANDIDATES_FILES]');
});

test('the verifier uses the four verdicts and a missing verdict sends the review back', () => {
  for (const path of [`${SDD}/task-reviewer-prompt.md`, `${SDD}/final-review-prompt.md`]) {
    const text = squash(lines(path));
    mustSay(text, ['`confirmed`', '`refuted`', '`duplicate-candidate`', '`duplicate-review`', '`critical`', '`important`', '`minor`'], path);
    mustSay(text, ['exactly one verdict', 'no location', 'no reproduction', 'incomplete', 'sends it back', 'never tells you how to rule'], path);
    assert.ok(text.includes('### Candidate Verdicts'), `${path} has no Candidate Verdicts output section`);
  }
  const rule = findLine(reviewSection(), (l) => /missing verdict/.test(l) && /candidate/.test(l), 'the controller rule for a missing verdict');
  mustSay(rule, ['send', 'back'], 'the missing verdict rule');
});

test('the verifier template ends its purpose sentence with a period', () => {
  const purpose = squash(lines(`${SDD}/task-reviewer-prompt.md`)).match(/\*\*Purpose:\*\*.*?round 1 found\S*/)?.[0];
  assert.ok(purpose, 'task-reviewer-prompt.md has no Purpose sentence about round 1');
  assert.ok(purpose.endsWith('.'), `the Purpose sentence has no final period: ${purpose}`);
});

test('the Round 1 and Round 2 ledger lines', () => {
  const text = reviewSection();
  findLine(text, (l) => l.includes('`Round 1: T<N> — hunters <done>/<sent>, safety ok`'), 'the Round 1 ledger line');
  findLine(text, (l) => l.includes('`Round 2: T<N> — verdicts <n>/<n>`'), 'the Round 2 ledger line');
});

test('the soft budget table holds the references', () => {
  const all = reviewSection();
  const row = (needle) => findLine(all, (l) => l.startsWith('|') && l.includes(needle), `a budget row for ${needle}`);
  assert.match(row('only docs or tracking paths'), /\| 0 hunters/);
  mustSay(row('only docs or tracking paths'), ['`docs/`', '`progress.md`', '`status.md`', '`README*`', '`*.tasks.json`', 'the gate still runs'], 'the docs row');
  assert.match(row('Normal task'), /\| 2 hunters.*`correctness`.*`security`/);
  assert.ok(row('Normal task').includes('skill markdown'), 'skill markdown is not normal');
  mustSay(row('Large'), ['300 changed lines', 'sensitive', 'up to 4 hunters'], 'the large row');
  assert.match(row('Final review'), /\| 3 hunters/);
  assert.match(row('Candidates per hunter'), /\| 5 \|/);
  assert.match(row('Wait'), /10 minutes.*20/);
  const rules = squash(all);
  mustSay(rules, ['"Sensitive" wins over "normal"', 'only when no other path changed', 'twice the reference', 'names something in the diff'], 'the budget rules');
  const budget = findLine(all, (l) => l.includes('`Budget: <what> <reference> → <used> for <T<N>|final> — <reason tied to the diff>`'), 'the Budget ledger line');
  // The example is a real departure: a normal task (reference 2) that sent 3 hunters, with a reason tied to the diff.
  const example = /`Budget: hunters (\d+) → (\d+) for T(\d+) — ([^`]+)`/.exec(budget.split('for example')[1] ?? '');
  assert.ok(example, `the Budget example is missing: ${budget}`);
  assert.ok(Number(example[2]) > Number(example[1]), `the Budget example is not a departure: ${example[0]}`);
  assert.equal(example[1], '2', 'the example departs from the normal reference');
  assert.match(example[4], /the diff/, 'the example reason is not tied to the diff');
  mustSay(rules, ['"up to 4"', '`budget.reference` 4', 'no departure', '`overrun`', 'exceeds the reference'], 'the up-to-4 rule');
  mustSay(rules, ['only in the ledger', 'never in the store'], 'the reasons rule');
});

test('record runs triqual role-eval record --plan, a 0-hunter task records an empty hunters list, and a failed record writes Unrecorded:', () => {
  const all = reviewSection();
  const run = findLine(all, (l) => l.includes('`triqual role-eval record --plan <plan file> <json-file>`'), 'the record command');
  mustSay(run, ['one `hunters` record', 'validates', 'exits 2', 'names the bad field'], 'the record command line');
  const retired = findLine(all, (l) => l.includes('`safety-shadow`'), 'the retired-kind rule');
  mustSay(retired, ['No `safety-shadow` record is written any more', 'retired'], 'the retired-kind rule');
  const text = squash(all);
  mustSay(text, ['idempotency key', 'already recorded', '`hunters: []`', '`Unrecorded: <record JSON>`', 'exit 2', 'exit 1', 'manual `triqual role-eval record`'], 'the record step');
  assert.match(text, /lacks `role-eval`/, 'the record step ignores an old triqual');
  // Self-contained: an installed copy of the skill cannot read this repository's spec.
  assert.doesNotMatch(text, /spec §5|docs\/specs|methodology repository|role-tiers design/, 'the record step points outside the skill');
});

// The record section inlines the two shapes, so a controller outside this repository can write a valid record.
const recordExamples = () => {
  const text = reviewSection().join('\n');
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
};

test('the Record section inlines the hunters record shape, and it passes the validator', () => {
  const examples = recordExamples();
  assert.deepEqual(examples.map((e) => e.kind), ['hunters'], 'the skill must inline exactly one hunters example');
  for (const example of examples) {
    assert.deepEqual(validateRecord(example), { ok: true }, `the ${example.kind} example fails the validator`);
  }
  const hunters = examples.find((e) => e.kind === 'hunters');
  assert.ok(hunters.hunters.some((h) => h.failed), 'the hunters example shows no failed hunter');
  assert.ok(hunters.budget.overrun, 'the hunters example shows no budget overrun');
});

test('the Record section states the field rules a controller needs', () => {
  const text = squash(reviewSection());
  const rules = findLine(
    reviewSection(),
    (l) => l.includes('`provider`') && l.includes('`task`') && l.includes('`model`'),
    'the record field rules',
  );
  mustSay(rules, ['`claude`', '`codex`', '`T<N>`', '`final`', "role's frontmatter", 'Codex routing value', 'never a guess'], 'the field rules');
  mustSay(text, ['`budget` is required in every `hunters` record you write', 'the validator does not require it'], 'the budget rule');
  mustSay(text, [
    'all-zero counts',
    'sum to `candidates`',
    'unknown fields are rejected',
  ], 'the record rules');
});

test('the closing progress entry states budget totals when opted in', () => {
  const finish = section('## Finish');
  const line = findLine(finish, (l) => l.includes('`progress.md`'), 'the closing entry rule');
  mustSay(line, ['opted in', 'reference total', 'actual total'], 'the closing entry rule');
  const at = finish.indexOf(line);
  const deletion = finish.findIndex((l) => l.startsWith('delete this plan') || l.includes('rm -rf'));
  assert.ok(at < deletion, 'the totals are read after the workspace is deleted');
});

test('the Finish totals derive from the ledger: sent over the Round 1 lines, table references', () => {
  const finish = squash(section('## Finish'));
  assert.doesNotMatch(finish, /shadow/i, 'the Finish totals still count shadows');
  mustSay(finish, [
    'sum of `<sent>`',
    '`Round 1:` line',
    'final one included',
    'sum of `budget.reference`',
    '`hunters` record JSON files',
    'in the workspace',
    '`Unrecorded:` line',
  ], 'the Finish totals');
  // Ruling 6: the reference never comes from the review packages, which would put diffs into the controller's context.
  assert.doesNotMatch(finish, /read from its review package|review package in the workspace/, 'the reference hunters are read from review packages');
  const before = finish.indexOf('sum of `<sent>`');
  assert.ok(before >= 0 && before < finish.indexOf('rm -rf'), 'the totals are not computed before the workspace is deleted');
});

test('fix rounds and re-reviews send no hunters', () => {
  const line = findLine(section('### 4. The fix loop'), (l) => /send no hunters/.test(l), 'the no-hunters rule');
  mustSay(line, ['Fix rounds', 're-reviews'], 'the no-hunters rule');
  const text = squash(section('### 4. The fix loop'));
  mustSay(text, ['confirmed', 'candidate', 'like any spec-review finding'], 'the fix loop');
});

test('no commit range means no review package and no reviewers at all, with a Review: ledger line', () => {
  const line = findLine(reviewSection(), (l) => l.startsWith('- **No commit range.**'), 'the no-package rule');
  mustSay(line, ['`review-package`', 'exits 3', 'no reviewer runs at all', 'no hunters', 'no gate', 'no spec reviewer', '`Review: T<N> — no commits, nothing to review`', 'nothing is recorded'], 'the no-package rule');
  mustSay(line, ['only the `empty commit range` message', 'any other exit 3', 'HEAD is not a descendant', 'an error to fix', 'never a reason to skip'], 'the exit 3 distinction');
  mustSay(squash(reviewSection()), ['Never skip the task review (the one exception is a task with no commit range'], 'the never-skip rule and its one exception');
});

test('an unknown roles:hunter or an unresolved Haiku skips the hunters with a ledger line, never the safety checklist', () => {
  const line = findLine(reviewSection(), (l) => /^- \*\*Unavailable hunters/.test(l), 'the skip rule');
  mustSay(line, ['`roles:hunter`', '0.2.0', 'Haiku', 'quota', 'rest of the plan', 'one ledger line', '`triqual doctor`', 'never fails the task'], 'the skip rule');
  const text = squash(reviewSection());
  mustSay(text, ['`Skipped: hunters and Haiku gate — <cause>; safety checklist runs in the spec review`'], 'the skip ledger line');
  // Ruling 5: an error before the agent runs is a skip; a run that fails is a failure of that task only.
  mustSay(line, ['before the agent runs', 'unknown agent type', 'unresolved model', 'no quota'], 'the skip trigger');
  mustSay(line, ['before every round 1', 'ledger', '`Skipped:` line', 'survives compaction'], 'the skip check');
  mustSay(line, ['fails, hangs or returns nothing usable', '`failed` for that task only', 'not a skip'], 'the failed-run distinction');
  mustSay(line, ['a gate that starts and then fails is re-dispatched; only hunters are recorded `failed`'], 'the gate re-dispatch');
  // After a skip no Round 1 line is written; the spec review is ledgered as before.
  mustSay(line, ['no `Round 1:` line', 'the spec review is ledgered as before'], 'the skip ledger effect');
  // Ruling (role tiers v2 · fix 1): the gate is never skipped; its checklist moves into the spec review in round 2.
  mustSay(line, [
    'The safety gate is never skipped',
    '`roles:spec-reviewer`',
    'safety checklist',
    "the gate's inputs",
    'Safety Checklist section of [task-reviewer-prompt.md](task-reviewer-prompt.md)',
    'checklist verdicts',
    '`Safety:` verdict',
    "the spec reviewer's findings",
    'no candidates',
    'no records',
  ], 'the skip fallback');
  assert.doesNotMatch(line, /run the stage as it ran before/, 'the skip rule still runs the Haiku gate');
  const final = findLine(section('## Final Review'), (l) => l.includes('`Skipped:` line'), 'the final review skip check');
  mustSay(final, ['before'], 'the final review skip check');
});

test('the rate limit is a bounded wait of about 6 stretches with RateLimit: lines, and the Five things line is unchanged', () => {
  const all = lines(SKILL);
  const stop = findLine(all, (l) => l.includes('The only reasons to stop are the five named below'), 'the stop clause');
  mustSay(stop, [/rate limit/i, 'bounded wait', 'final message', 'resumable', 'not a stop to ask'], 'the stop clause');
  const rule = findLine(all, (l) => l.includes('`RateLimit: <role> <time>`'), 'the RateLimit line');
  mustSay(rule, ['rate-limited', 'bounded stretches', '6 stretches', 'final message', 'never swaps the model'], 'the rate-limit rule');
  // Any role, not only the Opus ones; the same dispatch is retried; <time> is local HH:MM; the final message lists the Ruling: lines.
  assert.ok(!/An Opus role|A role that is rate-limited mid-plan, any role/.test(rule), 'the rate-limit rule keeps the old wording');
  mustSay(rule, ['A hunter or the safety gate with no Haiku quota is not this case', 'skip rule'], 'the hunter and gate exception');
  mustSay(rule, ['any role', 'retry the same dispatch', 'local time', '`HH:MM`', "ledger's `Ruling:` lines"], 'the rate-limit rule');
  mustSay(stop, ["ledger's `Ruling:` lines"], 'the stop clause');
  // The five stop reasons are the same words as before.
  const start = all.findIndex((l) => l.startsWith('Five things stop you'));
  assert.ok(start >= 0, 'the Five things line is gone');
  assert.equal(
    squash(all.slice(start, start + 6)),
    'Five things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this worktree that norms say you ask about first (a merge, a push to a shared branch, a publish); a task whose `**Role:**` is not a task role (see Role Dispatch); and a plan so broken that every path forward is a guess. For those, stop and ask.',
  );
});

test('the final review sends 3 hunters verified by the final reviewer', () => {
  const final = section('## Final Review');
  const line = findLine(final, (l) => l.includes('`roles:hunter`') && l.includes('3 hunters'), 'the final hunters rule');
  mustSay(line, ['`correctness`', '`security`', '`spec-drift`', '`final-candidates-<category>.md`', '20 minutes', 'together'], 'the final hunters rule');
  const text = squash(final);
  mustSay(text, ['`roles:final-adversarial-reviewer`', 'every candidates file', '`Round 1: final'], 'the final review');
  mustSay(text, ['task `final`', '`hunters` record', '`Unrecorded:`'], 'the final hunters record');
  const placeholders = read(`${SDD}/final-review-prompt.md`);
  assert.ok(placeholders.includes('[CANDIDATES_PATHS]'), 'final-review-prompt.md lacks [CANDIDATES_PATHS]');
});

test('hunter-prompt.md dispatches roles:hunter with the category, package and candidates path, plus the brief for a task or the spec and plan for the final review', () => {
  const template = `${SDD}/hunter-prompt.md`;
  assert.equal(firstDispatch(template), 'Subagent (roles:hunter):');
  assert.deepEqual(lines(template).filter((l) => /^Subagent \(/.test(l)), ['Subagent (roles:hunter):']);
  const text = read(template);
  for (const name of ['CATEGORY', 'PACKAGE_PATH', 'CANDIDATES_PATH', 'BRIEF_FILE', 'SPEC_PATH', 'PLAN_PATH']) {
    assert.ok(text.includes(`[${name}]`), `hunter-prompt.md lacks the placeholder [${name}]`);
  }
  const placeholder = (name) => lines(template).find((l) => l.startsWith(`- \`[${name}]\``)) ?? '';
  assert.match(placeholder('BRIEF_FILE'), /task/i);
  assert.match(placeholder('SPEC_PATH') + placeholder('PLAN_PATH'), /final review/i);
  for (const category of ['`correctness`', '`security`', '`spec-drift`', '`state`']) {
    assert.ok(text.includes(category), `hunter-prompt.md does not list the category ${category}`);
  }
  // The agent's own body carries the standing instructions; the dispatch does not repeat them.
  assert.doesNotMatch(text, /never edit the repository|never grade severity|read-only Bash/i, 'the template repeats the agent body');
});

test('the new roles are never task roles', () => {
  const roles = section('## Role Dispatch');
  const other = findLine(roles, (l) => l.startsWith('- **Any other role**'), 'the other-role case');
  mustSay(other, ['`roles:hunter`', 'Never dispatch it'], 'the other-role case');
  const header = findLine(roles, (l) => l.includes('`<task role>`'), 'the task-role header rule');
  assert.ok(!header.includes('roles:hunter'), header);
});

test('the no-pre-judging rule, a diff file for every reviewer and the cannot-verify rule survive', () => {
  const text = squash(reviewSection());
  mustSay(text, ['Do not pre-judge findings for the reviewer', 'never instruct a reviewer to ignore or not flag a specific issue', 'Never dispatch a task reviewer without a diff file', 'Cannot verify from diff', 'you must resolve each one yourself'], 'the review section');
  mustSay(text, ['never tell the verifier how to rule on a candidate', "never drop a hunter's candidate before round 2"], 'the review section');
});

// --- Final fix wave (plan role-tiers · final fix) ---------------------------------------------------------------------

test('Finish re-records every Unrecorded: record before the totals and the deletion, and lists the ones that still fail', () => {
  const finish = section('## Finish');
  const line = findLine(finish, (l) => l.includes('`triqual role-eval record --plan <plan file> <json-file>`'), 'the Finish re-record rule');
  mustSay(line, ['every record that has an `Unrecorded:` line', 'already recorded', '"Unrecorded records"', 'its JSON', 'record them later'], 'the Finish re-record rule');
  const totals = finish.findIndex((l) => l.includes('total the review from the ledger'));
  const deletion = finish.findIndex((l) => l.startsWith('delete this plan') || l.includes('rm -rf'));
  assert.ok(totals >= 0 && deletion >= 0, 'Finish lost its totals or its deletion');
  assert.ok(finish.indexOf(line) < totals && totals < deletion, 'the re-record is not before the totals and the deletion');
});

test('the Finish totals count each record once', () => {
  const finish = squash(section('## Finish'));
  mustSay(finish, [
    'each record once',
    'an `Unrecorded:` line repeats',
  ], 'the Finish totals');
});

test('the gate\'s findings go to the fix loop after round 2, in the same words as executing-plans', () => {
  const words = 'go to the fix loop after round 2';
  assert.ok(squash(section('### 3. Review the task')).includes(words), 'SDD round 1 does not say the gate\'s findings wait for round 2');
  assert.ok(read('executing-plans/SKILL.md').includes(words), 'executing-plans round 1 does not say it');
  assert.ok(!/go to the fix loop as (they come|today)/.test(squash(section('### 3. Review the task'))), 'an old "as they come" wording is left');
});

test('the digraph nodes and the example workflow show the final-review hunters', () => {
  const text = read(SKILL);
  const dot = /```dot\n(digraph process[\s\S]*?)```/.exec(text);
  assert.ok(dot, 'SKILL.md has no process digraph');
  const block = dot[1];
  const labels = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((l) => l.includes('roles:final-adversarial-reviewer'));
  assert.ok(labels.length >= 3, 'the digraph lost its final review node and edges');
  for (const label of labels) assert.ok(label.includes('3 hunters'), `a digraph label omits the final hunters: ${label}`);
  const example = text.slice(text.indexOf('## Example Workflow'));
  const step = findLine(example.split('\n'), (l) => l.includes('dispatch roles:final-adversarial-reviewer'), 'the example final review step');
  mustSay(step, ['dispatch 3 roles:hunter', 'Round 1: final — hunters 3/3', 'Round 2: final — verdicts'], 'the example final review step');
});

test('the Record section says at is UTC with a trailing Z, and where to read model', () => {
  const rules = findLine(
    reviewSection(),
    (l) => l.includes('`provider`') && l.includes('`task`') && l.includes('`model`'),
    'the record field rules',
  );
  mustSay(rules, ['`at` is the UTC time', 'trailing `Z`', 'installed `roles`', '`model:`', '`model` key of `~/.codex/agents/<role>.toml`'], 'the field rules');
  for (const example of recordExamples()) assert.match(example.at, /Z$/, `the ${example.kind} example's at has no trailing Z`);
});

test('the inlined record examples carry the models of the roles frontmatter', () => {
  const frontmatterModel = (role) => {
    const file = readFileSync(join(PLUGIN, '..', 'roles', 'agents', `${role}.md`), 'utf8');
    const match = /^model: (\S+)$/m.exec(file);
    assert.ok(match, `${role}.md has no model: line`);
    return match[1];
  };
  const examples = recordExamples();
  const hunters = examples.find((e) => e.kind === 'hunters');
  for (const h of hunters.hunters) assert.equal(h.model, frontmatterModel('hunter'), `a ${h.category} hunter model is not hunter's`);
});

test('the Codex missing-role stop exempts hunter, in codex-tools.md and FORK.md alike', () => {
  const codex = read('using-methodology/references/codex-tools.md').replace(/\s+/g, ' ');
  const fork = readFileSync(join(PLUGIN, 'FORK.md'), 'utf8').replace(/\s+/g, ' ');
  const exception = 'except `hunter`, whose absence is the review stage\'s skip rule (one `Skipped:` ledger line, never a stop)';
  assert.doesNotMatch(codex, /shadow/i, 'codex-tools.md still names the shadow');
  const missing = /\*\*Missing role:\*\* if `agent_type` does not resolve[^]*?(?= - \*\*Skills)/.exec(codex);
  assert.ok(missing, 'codex-tools.md lost its missing-role rule');
  assert.ok(missing[0].includes('stop and ask'), 'the Codex rule no longer stops and asks');
  assert.ok(missing[0].includes(exception), 'the Codex stop does not exempt hunter');
  assert.ok(fork.includes(`a missing role stops and asks instead of spawning a generic agent (${exception})`), 'FORK.md does not carry the same exception');
  // The skip rule the exception points at exists in both review skills.
  for (const path of [SKILL, 'executing-plans/SKILL.md']) {
    assert.ok(read(path).includes('`Skipped: hunters and Haiku gate — <cause>; safety checklist runs in the spec review`'), `${path} lost the skip rule`);
  }
});

test('FORK.md names the final-review hunters for executing-plans in its dispatch row and its adaptation bullet', () => {
  const fork = readFileSync(join(PLUGIN, 'FORK.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(fork, /\| `executing-plans` final whole-branch review \| 3 `roles:hunter` together, then `roles:final-adversarial-reviewer`/, 'the dispatch row omits the hunters');
  assert.ok(fork.includes('the final review dispatches 3 `roles:hunter` together, then `roles:final-adversarial-reviewer`'), 'the adaptation bullet omits the hunters');
  assert.doesNotMatch(fork, /shadow/i, 'FORK.md still names the shadow');
});

// ---- role tiers v2 · fix 1: the safety checklist moves into the spec review when the Haiku gate is skipped ----------

test('task-reviewer-prompt.md has an optional Safety Checklist section that points at the gate\'s checklist', () => {
  const template = `${SDD}/task-reviewer-prompt.md`;
  const all = lines(template);
  assert.deepEqual(all.filter((l) => /^Subagent \(/.test(l)), ['Subagent (roles:spec-reviewer):'], 'a second dispatch header');
  const start = all.indexOf('## Safety Checklist');
  assert.ok(start >= 0, 'no Safety Checklist section in the prompt');
  const end = all.findIndex((l, i) => i > start && /^## /.test(l));
  const block = squash(all.slice(start, end));
  mustSay(block, ['is in your prompt only because the Haiku gate did not run', '[SAFETY_TEMPLATE]', '`## Checklist`', '`## Calibration`', 'items 1–7', '[TRACKING_FILES]', 'pass or fail', 'file:line'], 'the Safety Checklist section');
  // The items live in safety-review-prompt.md only: no duplicate here.
  for (const item of ['**Commits:**', '**Secrets:**', '**Paths:**', '**Placement:**', '**Canaries:**']) {
    assert.ok(!read(template).includes(item), `task-reviewer-prompt.md duplicates the checklist item ${item}`);
  }
  // The output section and the Safety verdict, kept only in that case.
  const out = all.indexOf('### Safety Checklist');
  assert.ok(out > start, 'no Safety Checklist output section');
  const outBlock = squash(all.slice(out, out + 8));
  mustSay(outBlock, ['1–7', '**Safety:** [clean | findings]'], 'the Safety Checklist output section');
  // The controller keeps the section only on the skip, and the placeholders say where its values come from.
  const text = squash(all);
  mustSay(text, ['Keep the Safety Checklist sections only when', '`Skipped: hunters and Haiku gate', 'drop both otherwise'], 'the keep-or-drop rule');
  // A placeholder entry with its wrapped lines, up to the next entry or a blank line.
  const placeholder = (name) => {
    const at = all.findIndex((l) => l.startsWith(`- \`[${name}]\``));
    if (at < 0) return '';
    const next = all.findIndex((l, i) => i > at && (l.startsWith('- `[') || l === ''));
    return squash(all.slice(at, next < 0 ? undefined : next));
  };
  assert.match(placeholder('SAFETY_TEMPLATE'), /safety-review-prompt\.md/);
  assert.match(placeholder('TRACKING_FILES'), /triqual tasks paths --json/);
});

// ---- role tiers v2 · fix 2: a complex task keeps its role in the fix loop -------------------------------------------

test('fix rounds of a roles:complex-implementer task go to roles:complex-implementer, never roles:review-fixer', () => {
  const fix = squash(section('### 4. The fix loop'));
  mustSay(fix, [
    '**A `roles:complex-implementer` task keeps its role in the fix loop.**',
    'never to `roles:review-fixer`',
    'Rounds 1-3 resume the implementer itself',
    'rounds 4-5 dispatch a fresh `roles:complex-implementer` each round',
    '"A prior fixer attempted this task [N] times; you own it now. Read the report file for what was tried."',
  ], 'the complex-task fix rule');
  const roles = findLine(section('## Role Dispatch'), (l) => l.startsWith('- **Fix rounds:**'), 'the Fix rounds line');
  mustSay(roles, ['`roles:review-fixer`', 'a task whose role is `roles:complex-implementer`', 'to `roles:complex-implementer`'], 'the Fix rounds line');
  mustSay(squash(lines(SKILL)), ["when the task's role is `roles:review-fixer` or `roles:complex-implementer`, fix-loop rounds 1-3 resume this agent"], 'the agent identity rule');
  const template = lines(`${SDD}/implementer-prompt.md`);
  const start = template.indexOf('## After Review Findings');
  const end = template.findIndex((l, i) => i > start && /^## /.test(l));
  mustSay(squash(template.slice(start, end)), ['When your own role is `roles:review-fixer` or `roles:complex-implementer`, the fix rounds come back to you'], 'the implementer template');
});

// ---- Plan Store-2 T3: store mode in the execution skills and the review templates ---------------------------------
// R2 (entry before the commit), R3 (entry without a commit), R4 (status), R5 (nothing staged), R6 (history), R7 (--plan
// takes the bare plan file name). Every store rule sits beside the committed- and local-mode text, keyed on
// `"mode": "store"`, and cites the reference the way the planning skills do.
const STORE_MODE = '`"mode": "store"`';
const REFERENCE = '`store-mode.md` under `references` in skill `progress-tracking:progress-tracking`';
// A block is a paragraph or one list item, so a rule wrapped over several lines is read whole.
const blocks = (path) => {
  const out = [];
  let current = [];
  for (const raw of read(path).split('\n')) {
    if (raw.trim() === '' || /^\s*(?:- |\d+\. )/.test(raw)) {
      if (current.length) out.push(current.join(' '));
      current = [];
    }
    if (raw.trim() !== '') current.push(raw.trim());
  }
  if (current.length) out.push(current.join(' '));
  return out;
};

test('the implementer Tracking section has a store-mode rule: entry before the commit, no commit means --no-commit, nothing staged', () => {
  const template = lines(`${SDD}/implementer-prompt.md`);
  const start = template.indexOf('## Tracking');
  const end = template.findIndex((l, i) => i > start && /^## /.test(l));
  const rule = template.slice(start, end).find((l) => l.includes(STORE_MODE));
  assert.ok(rule, 'the Tracking section has no "mode": "store" rule');
  for (const needle of [
    '`triqual tracking add <draft>`',
    'before',
    '`triqual tracking add <draft> --no-commit`',
    'never staged',
    '`progress.md`',
    '`status.md`',
    '`*.tasks.json`',
    'mktemp -d',
    '`triqual tracking status set --section',
    '`triqual tracking log`',
    REFERENCE,
  ]) {
    assert.ok(rule.includes(needle), `the implementer's store-mode rule does not say ${needle}: ${rule}`);
  }
  assert.match(rule, /opted in/i, 'a line naming progress.md must be tied to an opted-in repo');
  // The committed and local rules stay as they are.
  assert.ok(template.slice(start, end).some((l) => l.startsWith('- **Staging (opted in):** in `"mode": "committed"`')));
  assert.ok(template.slice(start, end).some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')));
});

test('the implementer template accepts "store" for [MODE] and drops the three paths in store mode', () => {
  const note = lines(`${SDD}/implementer-prompt.md`).find((l) => l.startsWith('- `[TRACKING]`'));
  assert.ok(note, 'no [TRACKING] placeholder note');
  for (const needle of ['`"store"`', '`[PROGRESS_PATH]`', '`[STATUS_PATH]`', '`[TASKS_LEDGER_PATH]`', 'dropped in store mode']) {
    assert.ok(note.includes(needle), `the [TRACKING] note does not say ${needle}: ${note}`);
  }
});

test('Task Skills step 4 reads the other in-progress tasks from triqual tasks export --json in store mode', () => {
  const step = blocks(`${SDD}/implementer-prompt.md`).find((l) => l.startsWith('4. When opted in, skip the removal'));
  assert.ok(step, 'Task Skills has no step 4');
  assert.match(step, /When opted in, skip the removal while another task in the plan's task ledger is `in_progress`/, 'the ledger check changed');
  for (const needle of [STORE_MODE, '`triqual tasks export --json`', '`plans[].tasks[].skills`', 'no ledger file']) {
    assert.ok(step.includes(needle), `step 4 does not say ${needle}: ${step}`);
  }
});

test('SDD SKILL.md names --plan as the plan file name in store mode and keeps the committed meaning', () => {
  const all = blocks(`${SDD}/SKILL.md`);
  const rule = all.find((l) => l.includes(STORE_MODE) && l.includes('--plan'));
  assert.ok(rule, 'no store-mode rule names --plan');
  for (const needle of ['bare plan file name', '`plansDir`', 'the check takes no plan option', REFERENCE]) {
    assert.ok(rule.includes(needle), `the --plan rule does not say ${needle}: ${rule}`);
  }
  const opted = all.find((l) => l.startsWith('- **Opted in**'));
  assert.ok(opted.includes('`<plan>` is the plan file in `plansDir`'), 'the committed-mode meaning of <plan> was altered');
});

test('SDD SKILL.md lands the controller rulings and status-only steps with --no-commit in store mode (R2, R3, R4)', () => {
  const rule = blocks(`${SDD}/SKILL.md`).find((l) => l.includes(STORE_MODE) && l.includes('--no-commit'));
  assert.ok(rule, 'no store-mode rule names --no-commit');
  for (const needle of [
    '`triqual tracking add <draft>`',
    'before the commit',
    'ruling',
    'status-only',
    'stamped onto the next, unrelated commit',
    'mktemp -d',
    '`triqual tracking status set --section',
    'whole-file',
    '`triqual tracking log`',
    '`triqual tasks status --json`',
    '`triqual tasks export --json`',
    'an added or modified',
  ]) {
    assert.ok(rule.includes(needle), `the controller's store-mode rule does not say ${needle}: ${rule}`);
  }
  assert.match(rule, /opted in/i, 'a line naming progress.md must be tied to an opted-in repo');
});

test('SDD SKILL.md lands the controller review, ruling, status-only and close entries with --no-commit; plain add only for its own commit (R3)', () => {
  const rule = blocks(`${SDD}/SKILL.md`).find((l) => l.includes(STORE_MODE) && l.includes('--no-commit'));
  assert.ok(rule, 'no store-mode rule names --no-commit');
  for (const needle of [
    'A task review runs after the implementer\'s commit',
    'the plan\'s close',
    'with no commit of its own',
    'lands with `triqual tracking add <draft> --no-commit`',
    '`--commit <reviewed sha>`',
    'would let that commit past the pre-commit gate',
    'only an entry for a commit you are about to make yourself lands with plain `triqual tracking add <draft>` before the commit it describes',
  ]) {
    assert.ok(rule.includes(needle), `the controller's store-mode rule does not say ${needle}: ${rule}`);
  }
  // The old wording sent every controller entry, the review and the close included, to a plain add before a commit.
  assert.ok(
    !rule.includes('are drafts in a private `mktemp -d` dir (`d=$(mktemp -d)`), landed with `triqual tracking add <draft>` before the commit they describe'),
    'the controller reviews and the close are still sent to a plain add',
  );
});

test('SDD SKILL.md keeps the dirty-ledger sentence for committed mode and adds the store clause beside it', () => {
  const all = blocks(`${SDD}/SKILL.md`);
  assert.ok(all.some((l) => l === '- The move leaves the task ledger and `status.md` dirty: the next task\'s commit stages them, and after the last task the closing commit of methodology:finishing-branch carries them.'));
  const clause = all.find((l) => l.includes('store mode') && l.includes('leaves no file dirty'));
  assert.ok(clause, 'no store-mode clause beside the dirty-ledger sentence');
  assert.ok(clause.includes('nothing to stage'), clause);
});

test('after compaction, store mode reads the ledger state from triqual tasks status --json, not a ledger file', () => {
  const line = blocks(`${SDD}/SKILL.md`).find((l) => l.startsWith('- After compaction, when opted in'));
  assert.ok(line.includes('the task\'s `status` in the plan\'s `*.tasks.json`'), 'the committed-mode read was altered');
  assert.match(line, /In store mode[^.]*no `\*\.tasks\.json`[^.]*`triqual tasks status --json`/, line);
  assert.match(line, /take each task's state from `triqual tasks export --json`/, line);
  assert.match(line, /`triqual tasks status --json` lists only `inProgress` and `next`/, line);
});

test('the safety review item 7 and the task reviewer flag an added or modified tracking path in store mode, not a deletion', () => {
  const item = lines(`${SDD}/safety-review-prompt.md`).find((l) => l.startsWith('7. **Tracking files:**'));
  assert.ok(item, 'no item 7');
  assert.ok(item.includes('expected in every task diff') && /never flag them/i.test(item), 'the committed meaning of item 7 changed');
  const reviewer = blocks(`${SDD}/task-reviewer-prompt.md`).find((l) => l.includes('In store mode') && l.includes('item 7'));
  assert.ok(reviewer, 'task-reviewer-prompt.md has no store-mode item 7 rule');
  for (const [name, text] of [['safety-review-prompt.md item 7', item], ['task-reviewer-prompt.md', reviewer]]) {
    for (const needle of ['store mode', 'an added or modified', 'root `progress.md`', '`status.md`', '`*.tasks.json`', 'is a finding', 'deletion']) {
      assert.ok(text.includes(needle), `${name} does not say ${needle}: ${text}`);
    }
    assert.match(text, /deletions? (?:of them |of one )?(?:is|are) (?:expected|not)/, `${name}: deletions are not exempt`);
  }
  assert.ok(item.includes('`templates/progress.md`') || item.includes('`plugins/progress-tracking/templates/progress.md`'), 'item 7 does not exempt a same-named file elsewhere');
  for (const path of [`${SDD}/safety-review-prompt.md`, `${SDD}/task-reviewer-prompt.md`]) {
    const placeholder = blocks(path).find((l) => l.startsWith('- `[TRACKING_FILES]`'));
    assert.match(placeholder, /store mode/, `${path}: [TRACKING_FILES] does not say what to pass in store mode`);
    assert.match(placeholder, /triqual tasks paths --json/, `${path}: [TRACKING_FILES] lost the committed source`);
  }
});

test('the SDD reviewer inputs say the gate expects no tracking file in store mode', () => {
  const bullet = blocks(`${SDD}/SKILL.md`).find((l) => l.startsWith('- **Reviewer inputs:**'));
  assert.match(bullet, /In store mode[^.]*no tracking file is expected[^.]*finding/, bullet);
});

test('no store-mode clause of the SDD files pairs the tasks check with --plan, and every one stays tied to an opted-in repo', () => {
  for (const path of [`${SDD}/SKILL.md`, `${SDD}/implementer-prompt.md`, `${SDD}/safety-review-prompt.md`, `${SDD}/task-reviewer-prompt.md`]) {
    for (const line of blocks(path).filter((l) => l.includes(STORE_MODE) || /\bstore mode\b/i.test(l))) {
      for (const clause of line.split(/[.;:]\s/)) {
        assert.ok(!(/\bcheck\b/.test(clause) && clause.includes('--plan')), `${path}: a store-mode clause pairs the check with --plan: ${clause}`);
      }
    }
  }
});
