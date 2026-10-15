// executing-plans and finishing-branch (spec §11, Addendum E.4/E.5): inline execution with role reviews, the task
// ledger moves in task-start/task-done, tracking paths from `triqual tasks paths --json`, and the plan's close. Script tests
// run in a temp git repo with test/fixtures/fake-triqual first on PATH as `triqual`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(TEST, '..');
const SKILLS = join(PLUGIN, 'skills');
const EP = 'executing-plans';
const SDD = 'subagent-driven-development';
const FB = 'finishing-branch';
const SCRIPTS = join(SKILLS, EP, 'scripts');
const FAKE_TRIQUAL_FILE = join(TEST, 'fixtures', 'fake-triqual');

const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const lines = (path) => read(path).split('\n').map((line) => line.trim());
// The trimmed lines of a SKILL.md from one heading (included) to the next heading of the same or a higher level.
const section = (skill, heading) => {
  const all = lines(`${skill}/SKILL.md`);
  const start = all.indexOf(heading);
  assert.ok(start >= 0, `${skill}/SKILL.md has no heading ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  const end = all.findIndex((line, i) => i > start && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return all.slice(start, end < 0 ? undefined : end);
};
const skillFiles = (skill) => {
  const walk = (dir, rel) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${rel}/${e.name}`) : [`${rel}/${e.name}`],
    );
  return walk(join(SKILLS, skill), skill);
};
const numbered = (skill) =>
  skillFiles(skill).flatMap((path) =>
    read(path)
      .split('\n')
      .map((line, i) => [path, i + 1, line.trim()]),
  );

// ---- temp repo with fake-triqual ----------------------------------------------------------------------------------------

const PLAN = `# Demo plan

### Task 1: First

- [ ] **Step 1:** do one.

### Task 2: Second

**Depends on:** T1

- [ ] **Step 1:** do two.
`;

// PATH without any real `triqual` or `cm`; `node` stays reachable through a private link.
const cleanPath = (tools) => {
  const hasCli = (dir) =>
    ['triqual', 'cm'].some((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  return [tools, ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir && !hasCli(dir))].join(delimiter);
};

// `local`: the plan lives only in <git dir>/methodology/plans (the plansDir of local mode), not in docs/plans.
const repo = ({ local = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ep-home-'));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ep-repo-')));
  const tools = join(home, 'tools');
  const bin = join(home, 'bin');
  const cmBin = join(home, 'cm-bin');
  mkdirSync(tools);
  mkdirSync(bin);
  mkdirSync(cmBin);
  symlinkSync(process.execPath, join(tools, 'node'));
  symlinkSync(FAKE_TRIQUAL_FILE, join(bin, 'triqual'));
  symlinkSync(FAKE_TRIQUAL_FILE, join(cmBin, 'cm'));
  const log = join(home, 'triqual.log');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|FAKE_TRIQUAL_)/.test(key)));
  delete env.XDG_CONFIG_HOME;
  Object.assign(env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', FAKE_TRIQUAL_LOG: log });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const plansDir = local ? join(dir, '.git', 'methodology', 'plans') : join(dir, 'docs', 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, 'demo-plan.md'), PLAN);
  writeFileSync(join(dir, 'README'), 'demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const paths = (extra = {}) =>
    JSON.stringify({
      mode: local ? 'local' : 'committed',
      optedIn: true,
      root: local ? join(dir, '.git', 'methodology') : dir,
      progress: local ? join(dir, '.git', 'methodology', 'progress.md') : join(dir, 'progress.md'),
      status: local ? join(dir, '.git', 'methodology', 'status.md') : join(dir, 'status.md'),
      plansDir,
      specsDir: local ? join(dir, '.git', 'methodology', 'specs') : join(dir, 'docs', 'specs'),
      ...extra,
    });
  // triqual: 'fake' (fake-triqual as `triqual` first on PATH), 'cm' (only the old `cm` name on PATH), 'both' or 'absent'
  // (neither on PATH at all).
  const pathFor = { fake: [bin], cm: [cmBin], both: [bin, cmBin], absent: [] };
  const run = (script, args, { triqual = 'fake', vars = {} } = {}) =>
    spawnSync('bash', [join(SCRIPTS, script), ...args], {
      cwd: dir,
      env: { ...env, PATH: [...pathFor[triqual], cleanPath(tools)].join(delimiter), ...vars },
      encoding: 'utf8',
    });
  // The name each fake call was invoked under, in call order.
  const names = () => (existsSync(`${log}.argv0`) ? readFileSync(`${log}.argv0`, 'utf8').split('\n').filter(Boolean) : []);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  // Ledger moves only (reads such as `paths --json` and `status --json` left out).
  const moves = () => calls().filter((call) => /^tasks (start|review|rework|done|close) /.test(call));
  const commit = (file, text) => {
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', `add ${file}`);
    return git('rev-parse', 'HEAD').trim();
  };
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  const plan = local ? join(plansDir, 'demo-plan.md') : 'docs/plans/demo-plan.md';
  return { dir, git, run, calls, names, moves, commit, cleanup, paths, plansDir, plan, workspace: join(dir, '.methodology', 'sdd', 'demo-plan') };
};

// ---- temp store repo with the branch code as `triqual` -------------------------------------------------------------

const PROGRESS_BIN = join(PLUGIN, '..', 'progress-tracking', 'cli');
const STORE_PLAN_NAME = 'demo-plan.md';

// A temp repo opted in to the store (one `progress-init --store`), with a `triqual` first on PATH that runs this
// worktree's progress-tracking bins (tasks, tracking, progress-init), so the scripts and the store hook lines run the branch
// code. TRIQUAL_TRACKING_DB and TRIQUAL_REGISTRY_DIR are temp paths and HOME is a temp dir with a registry dir of its own:
// nothing is written to the real home or the OS temp root. The plan is landed with `triqual tracking write plan`.
const storeRepo = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ep-store-')));
  const dir = join(home, 'repo');
  const tools = join(home, 'tools');
  const bin = join(home, 'bin');
  const drafts = join(home, 'drafts');
  for (const d of [dir, tools, bin, drafts, join(home, 'registry'), join(home, '.config')]) mkdirSync(d);
  symlinkSync(process.execPath, join(tools, 'node'));
  const log = join(home, 'triqual.log');
  writeFileSync(
    join(bin, 'triqual'),
    `#!/bin/sh
cmd=$1
shift
printf '%s %s\\n' "$cmd" "$*" >> '${log}'
# STORE_TEST_EXPORT replaces the output of \`tasks export\` (a test of an export that cannot be parsed)
if [ "$cmd $1" = 'tasks export' ] && [ -n "\${STORE_TEST_EXPORT:-}" ]; then
  printf '%s\\n' "$STORE_TEST_EXPORT"
  exit 0
fi
case $cmd in
  tasks | tracking | progress-init) exec '${process.execPath}' '${PROGRESS_BIN}'"/$cmd.mjs" "$@" ;;
esac
echo "triqual wrapper: no $cmd command" >&2
exit 127
`,
    { mode: 0o755 },
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|FAKE_TRIQUAL_|XDG_|CLAUDE_PLUGIN_DATA|TRIQUAL_|CM_)/.test(key)),
  );
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    TRIQUAL_TRACKING_DB: join(home, 'data', 'tracking.db'),
    TRIQUAL_REGISTRY_DIR: join(home, 'registry'),
    PATH: [bin, cleanPath(tools)].join(delimiter),
  });
  const spawn = (cmd, args) => spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8' });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const triqual = (...args) => {
    const res = spawn('triqual', args);
    assert.equal(res.status, 0, `triqual ${args.join(' ')}\n${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README'), 'demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  triqual('progress-init', '--store');
  let n = 0;
  const draft = (name, text) => {
    const where = join(drafts, String(++n));
    mkdirSync(where);
    writeFileSync(join(where, name), text);
    return join(where, name);
  };
  triqual('tracking', 'write', 'plan', draft(STORE_PLAN_NAME, PLAN));
  // A commit in a store repository needs a pending entry first (the store pre-commit gate).
  const commit = (file, text) => {
    writeFileSync(join(dir, file), text);
    triqual(
      'tracking',
      'add',
      draft('entry.md', `## 2026-10-11 — add ${file}\n- **Stage/task:** off-plan\n- **Done:** added ${file}\n- **Files:** ${file}\n- **Verification:** none needed\n- **Next:** none\n`),
    );
    git('add', '--', file);
    git('commit', '-q', '-m', `add ${file}`);
    return git('rev-parse', 'HEAD').trim();
  };
  const run = (script, args, vars = {}) =>
    spawnSync('bash', [join(SCRIPTS, script), ...args], { cwd: dir, env: { ...env, ...vars }, encoding: 'utf8' });
  // The ledger state of the demo plan's tasks, read the way a user does.
  const statuses = () => {
    const snapshot = JSON.parse(triqual('tasks', 'export', '--json'));
    const found = snapshot.plans.find((p) => p.name === 'demo-plan');
    return found ? Object.fromEntries(found.tasks.map((t) => [t.id, t])) : {};
  };
  // Every `tasks start|review|rework|done|close` call the wrapper saw, in order.
  const moves = () =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []).filter((call) => /^tasks (start|review|rework|done|close) /.test(call));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  return { dir, env, git, run, commit, statuses, moves, triqual, cleanup, workspace: join(dir, '.methodology', 'sdd', 'demo-plan') };
};

// Every file under dir (the .git directory left out) whose name is a tracking file.
const trackingFilesUnder = (dir) => {
  const found = [];
  const walk = (current) => {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(join(current, e.name));
      else if (e.name === 'progress.md' || e.name === 'status.md' || e.name.endsWith('.tasks.json')) found.push(join(current, e.name));
    }
  };
  walk(dir);
  return found;
};

// ---- executing-plans: reviews and the final review (E.4) -----------------------------------------------------------

test('executing-plans reviews every inline task through roles', () => {
  const review = section(EP, '### 4. Review the task');
  const text = review.join('\n');
  // Round 1 sends the hunters and the safety gate together; round 2 sends the spec reviewer every candidates file.
  const round1 = review.find(
    (l) =>
      l.includes('`roles:hunter`') &&
      l.includes('`roles:safety-reviewer`') &&
      /together/.test(l) &&
      /every task|each task|the task/.test(l),
  );
  assert.ok(round1, 'the review step does not send the hunters and the gate together in round 1');
  assert.doesNotMatch(read(`${EP}/SKILL.md`), /shadow/i, 'executing-plans still names the safety shadow');
  const round2 = review.find((l) => l.includes('`roles:spec-reviewer`') && /every candidates file/.test(l));
  assert.ok(round2, 'the review step does not send the spec reviewer every candidates file in round 2');
  assert.doesNotMatch(
    review.join('\n'),
    /two reviewers|in parallel on the same review package/,
    'the review step still pins the old two-reviewer shape',
  );
  for (const link of [
    '[hunter-prompt.md](../subagent-driven-development/hunter-prompt.md)',
    '[task-reviewer-prompt.md](../subagent-driven-development/task-reviewer-prompt.md)',
    '[safety-review-prompt.md](../subagent-driven-development/safety-review-prompt.md)',
    '[re-review-prompt.md](../subagent-driven-development/re-review-prompt.md)',
  ]) {
    assert.ok(text.includes(link), `the review step does not link ${link}`);
  }
  assert.ok(text.includes('../subagent-driven-development/scripts/review-package'), 'no review package for the task');
  // With a subagent tool the reviewers are always dispatched; only without one does the executor review itself.
  const withTool = review.find((l) => l.replace(/^- /, '').startsWith('**With a subagent tool:**'));
  assert.ok(withTool, 'no rule for a harness with a subagent tool');
  assert.match(withTool, /never review the task yourself/, 'the executor may still self-review with a subagent tool');
  // Paragraph by paragraph: one that lets the executor review its own work names the no-subagent-tool case.
  const paragraphs = read(`${EP}/SKILL.md`).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  const unguarded = paragraphs
    .filter((p) => /self-review|reviews? (it|the task|the branch)? ?yourself|perform that review yourself/i.test(p))
    .filter((p) => !/Without a subagent tool|no subagent tool|never review the task yourself/.test(p));
  assert.deepEqual(unguarded, [], 'a self-review outside the no-subagent-tool case');
  assert.doesNotMatch(read(`${EP}/SKILL.md`), /no reviewer per task/, 'the skill still says there is no reviewer per task');
  // The same ledger moves as subagent-driven-development: review on handoff, rework per fix round.
  const moves = [
    ['`triqual tasks review T<N> --plan <plan>`', /reviewers/],
    ['`triqual tasks rework T<N> --plan <plan>`', /each fix round/],
  ];
  for (const [command, when] of moves) {
    const line = review.find((l) => l.includes(command));
    assert.ok(line, `the review step does not run ${command}`);
    assert.match(line, when, `${command} is not tied to ${when}: ${line}`);
    assert.match(line, /when opted in/, `${command} is not tied to an opted-in repo`);
  }
  // Fix rounds: the executor fixes (inline), then a scoped re-review goes to the raising role or roles.
  assert.match(text, /the role or roles that raised/, 'the re-review does not go to the raising role or roles');
});

test("executing-plans' final review uses final-review-prompt.md and passes no model", () => {
  const final = section(EP, '## Final Review');
  const text = final.join('\n');
  assert.ok(
    text.includes('[final-review-prompt.md](../subagent-driven-development/final-review-prompt.md)'),
    'Final Review does not link final-review-prompt.md',
  );
  assert.ok(text.includes('`roles:final-adversarial-reviewer`'), 'Final Review does not name the role');
  assert.match(text, /no model/i, 'Final Review does not say the dispatch passes no model');
  const bad = numbered(EP)
    .filter(([, , l]) => /specify the model|most capable|mid-tier|^model:|code-reviewer\.md|requesting-code-review/i.test(l))
    .map(([p, n, l]) => `${p}:${n}: ${l}`);
  assert.deepEqual(bad, [], 'the skill still chooses a model or points at requesting-code-review');
});

// ---- executing-plans: the two-round review stage (plan role-tiers · T6) -----------------------------------------------
// The stage's text lives in subagent-driven-development; executing-plans links it and restates only what its controller,
// who is also the implementer, does differently.

const squash = (all) => all.join(' ').replace(/\s+/g, ' ');
const findLine = (all, predicate, what) => {
  const line = all.find(predicate);
  assert.ok(line, `missing: ${what}`);
  return line;
};
const mustSay = (text, needles, what) => {
  for (const needle of needles) {
    assert.ok(typeof needle === 'string' ? text.includes(needle) : needle.test(text), `${what} does not say ${needle}: ${text}`);
  }
};
const reviewStep = () => section(EP, '### 4. Review the task');

test('without a subagent tool, no hunters, with a ledger line', () => {
  const review = reviewStep();
  const line = findLine(review, (l) => l.startsWith('- **Without a subagent tool:**'), 'the no-subagent-tool rule');
  mustSay(line, ['no hunters', '`Skipped: hunters — no subagent tool`', 'ledger'], 'the no-subagent-tool rule');
  mustSay(line, ['`Task <N>: review: self-review (no subagent tool)`'], 'the self-review ledger line');
  // The Skipped: line keeps the SDD format, so the skip survives compaction and is looked for before every round 1.
  mustSay(squash(review), ['`Skipped:` line', 'before every round 1'], 'the skip check');
});

test('fix rounds send no hunters', () => {
  const line = findLine(reviewStep(), (l) => /send no hunters/.test(l), 'the no-hunters rule');
  mustSay(line, ['Fix rounds', 're-reviews'], 'the no-hunters rule');
  mustSay(squash(reviewStep()), ['`confirmed`', 'candidate', 'like any spec-review finding'], 'a confirmed candidate enters the fix round');
});

test('an unknown roles:hunter or an unresolved Haiku skips the stage with a ledger line', () => {
  const line = findLine(reviewStep(), (l) => /^- \*\*Unavailable hunters/.test(l), 'the skip rule');
  mustSay(line, ['`roles:hunter`', '0.2.0', 'Haiku', 'quota', 'before the agent runs'], 'the skip trigger');
  mustSay(line, ['rest of the plan', '`Skipped: hunters and Haiku gate — <cause>; safety checklist runs in the spec review`', 'ledger', '`triqual doctor`', 'never fails the task'], 'the skip ledger line');
  // Ruling (role tiers v2 · fix 1): the gate is never skipped; its checklist moves into the spec review.
  mustSay(line, ['The safety gate is never skipped', '`roles:spec-reviewer`', 'safety checklist', "the gate's inputs", 'Safety Checklist section of [task-reviewer-prompt.md](../subagent-driven-development/task-reviewer-prompt.md)', '`Safety:` verdict', 'no candidates', 'no records'], 'the skip fallback');
  assert.doesNotMatch(line, /run the stage as it ran before/, 'the skip rule still runs the Haiku gate');
  mustSay(line, ['fails, hangs or returns nothing usable', '`failed` for that task only', 'not a skip'], 'the failed-run distinction');
  mustSay(line, ['a gate that starts and then fails is re-dispatched; only hunters are recorded `failed`'], 'the gate re-dispatch');
});

test('the rate limit is a bounded wait, and the stop list keeps its count', () => {
  const all = lines(`${EP}/SKILL.md`);
  const rule = findLine(all, (l) => l.startsWith('**Rate limits.**'), 'the rate-limit rule');
  mustSay(rule, ['is not a stop', 'bounded stretches', '`RateLimit: <role> <time>`', '`HH:MM`', '6 stretches', "ledger's `Ruling:` lines", 'never swaps the model'], 'the rate-limit rule');
  mustSay(rule, ['A hunter or the safety gate with no Haiku quota is not this case', 'skip rule'], 'the hunter and gate exception');
  const start = all.findIndex((l) => l.startsWith('Four things stop you'));
  assert.ok(start >= 0, 'the Four things line is gone');
  assert.equal(
    squash(all.slice(start, start + 5)),
    'Four things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this worktree that norms say you ask about first (a merge, a push to a shared branch, a publish); and a plan so broken that every path forward is a guess. For those, stop and ask.',
  );
});

test('a failed record writes Unrecorded:', () => {
  const review = reviewStep();
  const run = findLine(review, (l) => l.includes('`triqual role-eval record --plan <plan file> <json-file>`'), 'the record command');
  mustSay(run, ['one `hunters` record'], 'the record command');
  const text = squash(review);
  mustSay(text, ['`Unrecorded: <record JSON>`', 'lacks `role-eval`', '`hunters: []`'], 'the record step');
  mustSay(text, ['`Round 1: T<N> — hunters <done>/<sent>, safety ok`', '`Round 2: T<N> — verdicts <n>/<n>`'], 'the round ledger lines');
});

test('no review package means no hunters', () => {
  const line = findLine(reviewStep(), (l) => l.startsWith('- **No commit range.**'), 'the no-package rule');
  mustSay(line, ['`review-package`', 'exits 3', 'empty commit range', 'no reviewer runs at all', 'no hunters', 'no gate', '`Review: T<N> — no commits, nothing to review`', 'nothing is recorded'], 'the no-package rule');
  mustSay(line, ['any other exit 3', 'an error to fix'], 'the exit 3 distinction');
});

test('the closing progress entry states budget totals when opted in', () => {
  const finish = section(EP, '## Finish');
  const line = findLine(finish, (l) => l.includes('`progress.md`'), 'the closing entry rule');
  mustSay(line, ['opted in', 'reference total', 'actual total'], 'the closing entry rule');
  const deletion = finish.findIndex((l) => l.includes('delete this'));
  assert.ok(finish.indexOf(line) < deletion, 'the totals are read after the workspace is deleted');
  const totals = squash(finish);
  // The totals are computed as SDD's Finish does, by link; only the no-subagent-tool difference is restated.
  mustSay(totals, ['[Finish](../subagent-driven-development/SKILL.md#finish)', 'from the ledger', 'no `Round 1:` line exists', 'no `hunters` record', 'both totals are 0'], 'the Finish totals');
  const sdd = squash(section(SDD, '## Finish'));
  mustSay(sdd, ['sum of `<sent>`', 'sum of `budget.reference`'], 'the SDD Finish the link points at');
});

test('the final review fills [CANDIDATES_PATHS] from its final hunters, or with none', () => {
  const final = section(EP, '## Final Review');
  const text = squash(final);
  mustSay(text, ['3 hunters', '`roles:hunter`', '`final-candidates-<category>.md`', '`Round 1: final', '`Round 2: final'], 'the final review');
  mustSay(text, ['task `final`', '`Unrecorded:`', '`Skipped:` line'], 'the final review record and skip');
  // Each fill clause sits in its own paragraph: the with-subagent one in the dispatch paragraph, "none" in the other.
  const paragraphs = final.join('\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  const dispatch = findLine(paragraphs, (p) => p.startsWith('Then dispatch `roles:final-adversarial-reviewer`'), 'the final review dispatch paragraph');
  mustSay(dispatch, ['every candidates file of the final hunters in `[CANDIDATES_PATHS]`', 'or "none" when the hunters were skipped or returned no file'], 'the dispatch paragraph');
  const without = findLine(paragraphs, (p) => p.startsWith('**Without a subagent tool:**'), 'the no-subagent-tool final review paragraph');
  mustSay(without, ['no final hunters run', '`[CANDIDATES_PATHS]` is "none"'], 'the no-subagent-tool paragraph');
  assert.ok(read(`${SDD}/final-review-prompt.md`).includes('[CANDIDATES_PATHS]'), 'final-review-prompt.md lacks [CANDIDATES_PATHS]');
});

test('round 1 and round 2 keep the SDD gate, soft limit, budget and verdict rules', () => {
  const review = reviewStep();
  const round1 = findLine(review, (l) => l.startsWith('- Round 1 follows the SDD step to the letter'), 'the round 1 rule');
  mustSay(round1, ['the soft limit is 10 minutes after the gate\'s report', 'a late or failed hunter is `failed` and never blocks the task'], 'the soft limit');
  mustSay(round1, ['a departure from a budget reference writes its `Budget:` line'], 'the budget rule');
  const round2 = findLine(review, (l) => l.startsWith('- **Round 2:**'), 'the round 2 rule');
  mustSay(round2, ['A missing verdict sends the review back'], 'round 2');
});

// The Process digraph: nodes and edges by their quoted labels.
const digraph = () => {
  const dot = /```dot\n([\s\S]*?)```/.exec(read(`${EP}/SKILL.md`));
  assert.ok(dot, 'executing-plans has no dot digraph');
  const edges = [...dot[1].matchAll(/^\s*"([^"]+)"\s*->\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]);
  return { edges, nodes: [...new Set(edges.flat())] };
};

test('the fix loop in the digraph never returns to the hunters', () => {
  const { edges, nodes } = digraph();
  const findings = nodes.filter((n) => n.startsWith('Findings?'));
  assert.equal(findings.length, 1, 'expected exactly one Findings node');
  const out = edges.filter(([from]) => from === findings[0]);
  assert.ok(out.length >= 1, 'the Findings node has no outgoing edges');
  // A target may say it sends no hunters; it may not send them.
  for (const [, to] of out) {
    assert.doesNotMatch(to.replace(/no hunters/g, ''), /hunters/, `an edge out of the Findings node targets a node that sends hunters: ${to}`);
  }
  // The still-open edge goes to a scoped re-review by the raising role, which sends no hunters.
  const rereview = nodes.filter((n) => /scoped re-review by the raising role/i.test(n) && n !== findings[0]);
  assert.equal(rereview.length, 1, 'no separate scoped re-review node');
  mustSay(rereview[0], ['no hunters'], 'the scoped re-review node');
  assert.ok(out.some(([, to]) => to === rereview[0]), 'the Findings node does not lead to the scoped re-review node');
  assert.ok(edges.some(([from, to]) => from === rereview[0] && to === findings[0]), 'the re-review does not lead back to the Findings node');
});

test('every subagent-driven-development anchor executing-plans links is a heading of that file', () => {
  const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  const slugs = new Set(
    read(`${SDD}/SKILL.md`)
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#+ /, '').trim())),
  );
  const anchors = [...read(`${EP}/SKILL.md`).matchAll(/subagent-driven-development\/SKILL\.md#([^)\s]+)/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 4, 'executing-plans links fewer SDD anchors than expected');
  const dead = anchors.filter((a) => !slugs.has(a));
  assert.deepEqual(dead, [], 'a subagent-driven-development anchor resolves to no heading');
});

test('the links to the four templates resolve', () => {
  const text = read(`${EP}/SKILL.md`);
  const want = ['hunter-prompt.md', 'task-reviewer-prompt.md', 'safety-review-prompt.md', 'final-review-prompt.md'];
  for (const file of want) {
    const link = `[${file}](../subagent-driven-development/${file})`;
    assert.ok(text.includes(link), `executing-plans does not link ${link}`);
  }
  // Every relative link in the skill points at a file that exists.
  const dead = [...text.matchAll(/\]\((\.\.?\/[^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((target) => !existsSync(join(SKILLS, EP, target)));
  assert.deepEqual(dead, [], 'a relative link in executing-plans resolves to no file');
  // The stage is linked, never copied: the template texts do not appear in the skill.
  assert.doesNotMatch(text, /Subagent \(roles:hunter\):|### Candidate Verdicts/, 'a template is copied into executing-plans');
});

test('executing-plans reads tracking paths from triqual tasks paths --json with the three cases', () => {
  const all = lines(`${EP}/SKILL.md`);
  assert.ok(all.some((l) => l.includes('`triqual tasks paths --json`')), 'executing-plans does not run triqual tasks paths --json');
  const opted = all.find((l) => l.startsWith('- **Opted in**'));
  const notOpted = all.find((l) => l.startsWith('- **Not opted in**'));
  const missing = all.find((l) => l.startsWith('- **`triqual` missing**'));
  assert.ok(opted && notOpted && missing, 'executing-plans lacks one of the three tracking cases');
  assert.match(opted, /`"optedIn": true`/);
  for (const needle of ['`progress`', '`status`', '`Plan <topic> · T<N>`', '`*.tasks.json`', '`--no-verify`']) {
    assert.ok(opted.includes(needle), `the opted-in case does not name ${needle}`);
  }
  for (const re of [/`"optedIn": false`/, /exit 2/, /no ledger moves/, /no `triqual tasks` command/, /never create `progress\.md`/]) {
    assert.match(notOpted, re, `the not-opted-in case does not say ${re}`);
  }
  for (const re of [/exit 3/, /`PATH`/, /as not opted in/, /once/]) assert.match(missing, re, `the triqual-missing case does not say ${re}`);
  assert.ok(all.some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')), 'no local-mode rule');
  // Every other instruction line that moves the ledger or names progress.md is for an opted-in repo.
  const bad = numbered(EP)
    .filter(([p]) => p.endsWith('.md'))
    .filter(([, , l]) => /triqual tasks (start|review|rework|done)|progress\.md/.test(l))
    .filter(([, , l]) => !l.startsWith('- **Not opted in**'))
    .filter(([, , l]) => !/\bopted in\b/i.test(l.replace(/not opted in/gi, '')))
    .map(([p, n, l]) => `${p}:${n}: ${l}`);
  assert.deepEqual(bad, [], 'a ledger move or progress.md rule outside an opted-in instruction');
});

// ---- task-start / task-done (scripts) ------------------------------------------------------------------------------

test('task-start runs triqual tasks start Tn in a committed repo', () => {
  const r = repo();
  try {
    const res = r.run('task-start', [r.plan, '2'], { vars: { FAKE_TRIQUAL_PATHS: r.paths() } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`^brief: ${r.workspace}/task-2-brief\\.md$`, 'm'));
    assert.match(res.stdout, new RegExp(`^base: ${r.git('rev-parse', 'HEAD').trim()}$`, 'm'));
    assert.deepEqual(r.calls(), [
      'tasks paths --json',
      'tasks status --json',
      `tasks start T2 --plan ${join(r.plansDir, 'demo-plan.md')}`,
    ]);
    assert.match(readFileSync(join(r.workspace, 'task-2-brief.md'), 'utf8'), /^### Task 2: Second/);
  } finally {
    r.cleanup();
  }
});

test('task-start in a local-mode repo uses the plansDir from paths --json', () => {
  const r = repo({ local: true });
  try {
    // The plan named by its file name only: it exists only in the plansDir under the git dir.
    const res = r.run('task-start', ['demo-plan.md', '1'], { vars: { FAKE_TRIQUAL_PATHS: r.paths() } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(r.moves(), [`tasks start T1 --plan ${join(r.plansDir, 'demo-plan.md')}`]);
    assert.match(readFileSync(join(r.workspace, 'task-1-brief.md'), 'utf8'), /^### Task 1: First/);
    assert.equal(r.git('status', '--porcelain'), '', 'task-start left a file in git status');
  } finally {
    r.cleanup();
  }
});

// Runs task-start and task-done for Task 1 and returns both results.
const startAndDone = (r, opts) => {
  const start = r.run('task-start', [r.plan, '1'], opts);
  const base = r.git('rev-parse', 'HEAD').trim();
  r.commit('one.txt', 'one\n');
  const done = r.run('task-done', [r.plan, '1', base, '--', 'echo', 'ok'], opts);
  return { start, done };
};

test('task-start and task-done skip ledger moves and create no progress.md when not opted in', () => {
  const cases = [
    ['optedIn false', (r) => ({ vars: { FAKE_TRIQUAL_PATHS: r.paths({ optedIn: false }) } })],
    ['an older progress-tracking exits 2', () => ({ vars: { FAKE_TRIQUAL_EXIT: '2' } })],
  ];
  for (const [name, opts] of cases) {
    const r = repo();
    try {
      const { start, done } = startAndDone(r, opts(r));
      assert.equal(start.status, 0, `${name}: ${start.stdout}${start.stderr}`);
      assert.equal(done.status, 0, `${name}: ${done.stdout}${done.stderr}`);
      const reads = r.calls().filter((call) => call === 'tasks paths --json');
      assert.equal(reads.length, 2, `${name}: task-start and task-done did not both read triqual tasks paths --json`);
      assert.deepEqual(r.moves(), [], `${name}: a ledger move ran`);
      assert.deepEqual(r.calls(), reads, `${name}: triqual was called for more than tasks paths --json`);
      assert.equal(existsSync(join(r.dir, 'progress.md')), false, `${name}: progress.md was created`);
      assert.equal(existsSync(join(r.workspace, 'progress.md')), false, `${name}: the workspace ledger is progress.md`);
      assert.match(readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8'), /^Task 1: complete /m, name);
    } finally {
      r.cleanup();
    }
  }
});

test('task-start and task-done skip ledger moves, say so once and exit 0 when triqual is missing', () => {
  const cases = [
    ['triqual exits 3', { vars: { FAKE_TRIQUAL_EXIT: '3' } }],
    ['triqual is not on PATH', { triqual: 'absent' }],
  ];
  for (const [name, opts] of cases) {
    const r = repo();
    try {
      const { start, done } = startAndDone(r, opts);
      for (const [script, res] of [['task-start', start], ['task-done', done]]) {
        assert.equal(res.status, 0, `${name}, ${script}: ${res.stdout}${res.stderr}`);
        const said = `${res.stdout}${res.stderr}`.match(/triqual missing/g) ?? [];
        assert.equal(said.length, 1, `${name}, ${script} does not say "triqual missing" exactly once: ${res.stdout}${res.stderr}`);
      }
      assert.deepEqual(r.moves(), [], `${name}: a ledger move ran`);
      assert.equal(existsSync(join(r.dir, 'progress.md')), false, `${name}: progress.md was created`);
      assert.match(readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8'), /^Task 1: complete /m, name);
    } finally {
      r.cleanup();
    }
  }
});

// An opted-in repo on a machine whose plugin was updated before bootstrap has only the old `cm` on PATH: the scripts use
// the CLI that is there (triqual first, as the progress gate does) instead of dropping the ledger move.
test('task-start and task-done use triqual when it is on PATH, else cm, else say triqual is missing', () => {
  const cases = [
    ['only triqual', 'fake', ['triqual']],
    ['only cm', 'cm', ['cm']],
    ['both', 'both', ['triqual']],
  ];
  for (const [name, triqual, used] of cases) {
    const r = repo();
    try {
      const opts = { triqual, vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
      const { start, done } = startAndDone(r, opts);
      for (const [script, res] of [['task-start', start], ['task-done', done]]) assert.equal(res.status, 0, `${name}, ${script}: ${res.stdout}${res.stderr}`);
      assert.equal(r.moves().length, 2, `${name}: task-start and task-done did not both move the ledger: ${r.moves()}`);
      assert.deepEqual([...new Set(r.names())], used, `${name}: the wrong CLI ran`);
      assert.doesNotMatch(`${start.stdout}${done.stdout}`, /triqual missing/, `${name}: said the CLI is missing`);
    } finally {
      r.cleanup();
    }
  }
  const r = repo();
  try {
    const { start, done } = startAndDone(r, { triqual: 'absent', vars: { FAKE_TRIQUAL_PATHS: r.paths() } });
    assert.match(start.stdout, /triqual missing/);
    assert.match(done.stdout, /triqual missing/);
    assert.deepEqual(r.calls(), [], 'neither CLI is on PATH, yet something was called');
  } finally {
    r.cleanup();
  }
});

test('task-done runs triqual tasks done Tn --commit <sha> and writes the workspace ledger to sdd-ledger.md', () => {
  const r = repo();
  try {
    const opts = { vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = r.commit('one.txt', 'one\n');
    // A failing test command records nothing and moves nothing.
    const failed = r.run('task-done', [r.plan, '1', base, '--', 'false'], opts);
    assert.notEqual(failed.status, 0);
    assert.deepEqual(r.moves(), [], 'a failing run moved the ledger');
    assert.equal(existsSync(join(r.workspace, 'sdd-ledger.md')), false, 'a failing run wrote the ledger');
    const res = r.run('task-done', [r.plan, '1', base, '--', 'echo', '3/3 pass'], opts);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(r.moves(), [`tasks done T1 --commit ${head} --plan ${join(r.plansDir, 'demo-plan.md')}`]);
    const ledger = readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8').split('\n');
    assert.equal(ledger[0], `# SDD ledger — plan: ${r.plan}`);
    const short = (sha) => r.git('rev-parse', '--short=7', sha).trim();
    assert.equal(ledger[1], `Task 1: complete (commits ${short(base)}..${short(head)}, tests: echo '3/3 pass' → 3/3 pass)`);
    assert.equal(existsSync(join(r.workspace, 'progress.md')), false, 'the workspace ledger is still progress.md');
    assert.equal(existsSync(join(r.dir, 'progress.md')), false, 'task-done created progress.md');
  } finally {
    r.cleanup();
  }
});

// Fix round 1: a resumed session never fails on a move the task ledger already shows (SKILL.md, Setup).
// Writes the plan's task ledger with T1 at `status` and returns the `triqual tasks status --json` listing that names it.
const ledgerAt = (r, status) => {
  const ledgerPath = join(r.plansDir, 'demo-plan.tasks.json');
  const task = (id, s) => ({ id, title: id, status: s, deps: [], commits: [], history: [] });
  writeFileSync(ledgerPath, `${JSON.stringify({ state: 'active', tasks: [task('T1', status), task('T2', 'pending')] })}\n`);
  return JSON.stringify([{ name: 'demo-plan', ledgerPath, done: 0, total: 2, inProgress: [], next: 'T1' }]);
};

test('task-start and task-done skip a move the task ledger already shows, after start and after done', () => {
  const r = repo();
  try {
    const plan = join(r.plansDir, 'demo-plan.md');
    const opts = (status) => ({ vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: ledgerAt(r, status) } });
    // Control: a pending task is started.
    const fresh = r.run('task-start', [r.plan, '1'], opts('pending'));
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.deepEqual(r.moves(), [`tasks start T1 --plan ${plan}`], 'a pending task was not started');
    // Resume after start: in_progress, in_review or done → no second start, exit 0.
    for (const status of ['in_progress', 'in_review', 'done']) {
      const res = r.run('task-start', [r.plan, '1'], opts(status));
      assert.equal(res.status, 0, `${status}: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, new RegExp(`T1 already ${status}; start skipped`), status);
    }
    assert.equal(r.moves().length, 1, 'task-start moved a task the ledger already shows started');
    // Resume after done: no second done, and the completion line is still written.
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    const res = r.run('task-done', [r.plan, '1', base, '--', 'echo', 'ok'], opts('done'));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /T1 already done; done skipped/);
    assert.equal(r.moves().length, 1, 'task-done moved a task the ledger already shows done');
    assert.match(readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8'), /^Task 1: complete /m);
    // Control: a task in review is moved to done.
    const again = r.run('task-done', [r.plan, '2', base, '--', 'echo', 'ok'], {
      vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: ledgerAt(r, 'in_review') },
    });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(r.moves().at(-1), `tasks done T2 --commit ${r.git('rev-parse', 'HEAD').trim()} --plan ${plan}`);
  } finally {
    r.cleanup();
  }
});

test('task-done records a passing test command that prints nothing', () => {
  const r = repo();
  try {
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    const res = r.run('task-done', [r.plan, '1', base, '--', 'true'], { vars: { FAKE_TRIQUAL_PATHS: r.paths() } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(r.moves().length, 1, 'the passing run did not move the ledger');
    assert.match(readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8'), /^Task 1: complete \(.*, tests: true → \(no output\)\)$/m);
  } finally {
    r.cleanup();
  }
});

// T16 (carried from T7): an unreadable status listing or ledger never stops a move, and a re-run adds no second line.
test('task_status falls back to making the move when triqual tasks status --json or the ledger cannot be parsed', () => {
  const r = repo();
  try {
    const plan = join(r.plansDir, 'demo-plan.md');
    const ledgerPath = join(r.plansDir, 'demo-plan.tasks.json');
    const listing = JSON.stringify([{ name: 'demo-plan', ledgerPath }]);
    writeFileSync(ledgerPath, '{ not json');
    for (const [name, status] of [['listing', 'not json at all'], ['ledger', listing]]) {
      const res = r.run('task-start', [r.plan, '1'], { vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: status } });
      assert.equal(res.status, 0, `${name}: ${res.stdout}${res.stderr}`);
      assert.equal(r.moves().at(-1), `tasks start T1 --plan ${plan}`, `${name}: the start move was not made`);
    }
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = r.commit('one.txt', 'one\n');
    const res = r.run('task-done', [r.plan, '1', base, '--', 'echo', 'ok'], { vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: '[' } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(r.moves().at(-1), `tasks done T1 --commit ${head} --plan ${plan}`);
  } finally {
    r.cleanup();
  }
});

test('task-done does not append a duplicate completion line on a re-run', () => {
  const r = repo();
  try {
    const opts = { vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    for (const out of ['first run', 'second run, other output']) {
      const res = r.run('task-done', [r.plan, '1', base, '--', 'echo', out], opts);
      assert.equal(res.status, 0, res.stdout + res.stderr);
    }
    const complete = (text) => text.split('\n').filter((line) => line.startsWith('Task 1: complete '));
    const ledger = join(r.workspace, 'sdd-ledger.md');
    assert.equal(complete(readFileSync(ledger, 'utf8')).length, 1, readFileSync(ledger, 'utf8'));
    // A later fix commit is new work: its completion line is recorded.
    r.commit('two.txt', 'two\n');
    const again = r.run('task-done', [r.plan, '1', base, '--', 'echo', 'fixed'], opts);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(complete(readFileSync(ledger, 'utf8')).length, 2, readFileSync(ledger, 'utf8'));
  } finally {
    r.cleanup();
  }
});

// ---- task-start / task-done in a store repository (plan tracking-store-2 T4) ---------------------------------------

test('task-start in a store repo reads the ledger from triqual tasks export and moves T1 by the bare plan file name', () => {
  const r = storeRepo();
  try {
    const res = r.run('task-start', [STORE_PLAN_NAME, '1']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^ledger: /m);
    assert.doesNotMatch(res.stdout, /^tracking:/m);
    assert.equal(r.statuses().T1.status, 'in_progress');
    assert.deepEqual(r.moves(), [`tasks start T1 --plan ${STORE_PLAN_NAME}`]);
    assert.match(readFileSync(join(r.workspace, 'task-1-brief.md'), 'utf8'), /^### Task 1: First/);
    // A resumed run skips the move it already made.
    const again = r.run('task-start', [STORE_PLAN_NAME, '1']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /^ledger: T1 already in_progress; start skipped$/m);
    assert.equal(r.moves().length, 1, 'the resumed task-start moved the task a second time');
    assert.equal(r.statuses().T1.status, 'in_progress');
    assert.equal(r.statuses().T2.status, 'pending', 'task-start moved another task');
  } finally {
    r.cleanup();
  }
});

test('task-done in a store repo moves T1 to done with the commit, and a resumed run skips the move', () => {
  const r = storeRepo();
  try {
    const start = r.run('task-start', [STORE_PLAN_NAME, '1']);
    assert.equal(start.status, 0, start.stdout + start.stderr);
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = r.commit('one.txt', 'one\n');
    const done = r.run('task-done', [STORE_PLAN_NAME, '1', base, '--', 'echo', 'ok']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /^ledger move: /m);
    const t1 = r.statuses().T1;
    assert.equal(t1.status, 'done');
    assert.deepEqual(t1.commits.map((c) => head.startsWith(c) || c.startsWith(head)), [true], `T1 commits ${t1.commits} do not name ${head}`);
    assert.equal(r.moves().at(-1), `tasks done T1 --commit ${head} --plan ${STORE_PLAN_NAME}`);
    assert.match(readFileSync(join(r.workspace, 'sdd-ledger.md'), 'utf8'), /^Task 1: complete /m);
    // A resumed run: the ledger shows done, so no second move.
    const movesBefore = r.moves().length;
    const again = r.run('task-done', [STORE_PLAN_NAME, '1', base, '--', 'echo', 'ok']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /^ledger: T1 already done; done skipped$/m);
    assert.equal(r.moves().length, movesBefore, 'the resumed task-done moved the task a second time');
    assert.equal(r.statuses().T1.status, 'done');
  } finally {
    r.cleanup();
  }
});

test('a store repo has no tasks.json, progress.md or status.md anywhere after task-start and task-done', () => {
  const r = storeRepo();
  try {
    assert.equal(r.run('task-start', [STORE_PLAN_NAME, '1']).status, 0);
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    assert.equal(r.run('task-done', [STORE_PLAN_NAME, '1', base, '--', 'true']).status, 0);
    assert.deepEqual(trackingFilesUnder(r.dir), []);
    assert.doesNotMatch(r.git('ls-files'), /progress\.md|status\.md|tasks\.json/);
  } finally {
    r.cleanup();
  }
});

test('task-start in a store repo makes the move when triqual tasks export cannot be parsed, and a plan the export lacks', () => {
  const r = storeRepo();
  try {
    for (const [name, exported] of [['unparseable', 'not json at all'], ['a plan the export lacks', '{"plans":[]}']]) {
      const res = r.run('task-start', [STORE_PLAN_NAME, '1'], { STORE_TEST_EXPORT: exported });
      assert.equal(res.status, 0, `${name}: ${res.stdout}${res.stderr}`);
      assert.doesNotMatch(res.stdout, /start skipped/, name);
    }
    // The first run really moved T1 in the store, so the second move is the tasks CLI's own report, not a skip.
    assert.equal(r.moves().length, 2, 'task-start did not make the move in both cases');
    assert.equal(r.statuses().T1.status, 'in_progress');
  } finally {
    r.cleanup();
  }
});

test('the tracking block and task_status are the same in task-start and task-done, and the moves use plan_arg', () => {
  const block = (script) => {
    const text = readFileSync(join(SCRIPTS, script), 'utf8').replaceAll('task-start', 'SCRIPT').replaceAll('task-done', 'SCRIPT');
    const from = text.indexOf('# Tracking paths: the same block');
    const to = text.indexOf('\nout=', from) >= 0 ? text.indexOf('\nout=', from) : text.indexOf('\ndir=', from);
    assert.ok(from >= 0 && to > from, `${script}: no tracking block`);
    return text.slice(from, to);
  };
  assert.equal(block('task-start'), block('task-done'));
  assert.match(block('task-start'), /committed\|local\|store \(opted in\)/);
  for (const script of ['task-start', 'task-done']) {
    assert.doesNotMatch(readFileSync(join(SCRIPTS, script), 'utf8'), /--plan "\$plans_dir/, `${script} still builds --plan from plans_dir in a move`);
  }
});

test('executing-plans Take the task step keeps PLAN_FILE the plan\'s path in plansDir in store mode and says task-start passes the bare name as <plan>', () => {
  const step = section(EP, '### 1. Take the task').join(' ');
  assert.match(step, /store mode/);
  assert.match(step, /`PLAN_FILE` stays the plan's path in `plansDir`/);
  assert.match(step, /for an imported plan not yet landed again, its path in the\s+working tree/);
  assert.match(step, /bare plan\s+file name/);
  assert.match(step, /triqual tasks export --json/);
  assert.match(step, /details: `store-mode\.md` under `references` in skill `progress-tracking:progress-tracking`/);
  assert.doesNotMatch(step, /`PLAN_FILE` is the bare/, 'the store sentence still turns PLAN_FILE into the bare file name');
});

test('executing-plans never tells the executor to pass a bare plan name to the scripts that need a file', () => {
  // sdd-workspace, task-brief and review-package exit 2 on a name that is not a file, so no PLAN_FILE placeholder
  // of this skill may be defined as a bare name; only task-start and task-done resolve one through plansDir.
  const text = readFileSync(join(SKILLS, EP, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /PLAN_FILE`? (?:is|becomes|means) the bare/);
  assert.match(text, /sdd-workspace PLAN_FILE/);
  assert.match(text, /review-package PLAN_FILE BASE HEAD/);
});

test('in a store repo every script that takes PLAN_FILE accepts the plan path in plansDir, and a bare name only works for task-start and task-done', () => {
  const r = storeRepo();
  try {
    const plansDir = JSON.parse(r.triqual('tasks', 'paths', '--json')).plansDir;
    const planPath = join(plansDir, STORE_PLAN_NAME);
    assert.ok(existsSync(planPath), `no stored plan at ${planPath}`);
    const sdd = (script, args) => spawnSync('bash', [join(SKILLS, SDD, 'scripts', script), ...args], { cwd: r.dir, env: r.env, encoding: 'utf8' });
    // The plan's path in plansDir: sdd-workspace, task-brief, task-start, review-package and task-done all take it.
    const ws = sdd('sdd-workspace', [planPath]);
    assert.equal(ws.status, 0, ws.stdout + ws.stderr);
    const brief = sdd('task-brief', [planPath, '1']);
    assert.equal(brief.status, 0, brief.stdout + brief.stderr);
    const start = r.run('task-start', [planPath, '1']);
    assert.equal(start.status, 0, start.stdout + start.stderr);
    const base = r.git('rev-parse', 'HEAD').trim();
    const head = r.commit('one.txt', 'one\n');
    const pkg = sdd('review-package', [planPath, base, head]);
    assert.equal(pkg.status, 0, pkg.stdout + pkg.stderr);
    const done = r.run('task-done', [planPath, '1', base, '--', 'true']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(r.statuses().T1.status, 'done');
    // The scripts pass the bare name as <plan> whichever spelling they were given.
    assert.deepEqual(r.moves(), [`tasks start T1 --plan ${STORE_PLAN_NAME}`, `tasks done T1 --commit ${head} --plan ${STORE_PLAN_NAME}`]);
    // A bare name is a file only to task-start and task-done.
    for (const [script, args] of [['sdd-workspace', [STORE_PLAN_NAME]], ['task-brief', [STORE_PLAN_NAME, '1']], ['review-package', [STORE_PLAN_NAME, base, head]]]) {
      const res = sdd(script, args);
      assert.equal(res.status, 2, `${script} accepted a bare plan name: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /no such plan file/);
    }
  } finally {
    r.cleanup();
  }
});

test("executing-plans' completion contract keeps the final test run", () => {
  const contract = section(EP, '### 3. The completion contract');
  const item = contract.find((l) => /^- The final test run for the task passed/.test(l));
  assert.ok(item, 'the completion contract lost the final test run item');
  assert.match(item, /`task-done`/, 'the final test run is not task-done');
});

// ---- finishing-branch (§11, E.5) ------------------------------------------------------------------------------------

test('finishing-branch runs triqual tasks check then close, writes the closing entry, updates the roadmap, then offers merge / PR / keep / discard; when not opted in it offers the four options only', () => {
  const all = lines(`${FB}/SKILL.md`);
  const close = section(FB, '## Step 2: Close the Plan');
  const at = (predicate, what) => {
    const i = close.findIndex(predicate);
    assert.ok(i >= 0, `Close the Plan lacks ${what}`);
    return i;
  };
  const paths = at((l) => l.includes('`triqual tasks paths --json`'), 'triqual tasks paths --json');
  const check = at((l) => l.includes('`triqual tasks check`'), 'triqual tasks check');
  const closeCmd = at((l) => l.includes('`triqual tasks close'), 'triqual tasks close');
  const entry = at((l) => /closing entry/i.test(l) && l.includes('`progress`'), 'the closing entry in progress');
  const roadmap = at((l) => /roadmap/i.test(l) && l.includes('`status`'), 'the roadmap update in status');
  const commit = at((l) => /closing commit/i.test(l) && l.includes('`*.tasks.json`'), 'the closing commit');
  assert.ok(paths < check && check < closeCmd && closeCmd < entry && entry < roadmap && roadmap <= commit, 'the steps are out of order');
  assert.match(close[check], /\bexit 1\b[^]*\bstop\b/i, 'a drifted check does not stop the close');
  assert.match(close[entry], /`Plan <topic> · close`/, 'the closing entry has no Stage/task');
  const staging = close[commit];
  for (const needle of ['`"mode": "committed"`', '`progress.md`', '`status.md`', '`*.tasks.json`', '`--no-verify`']) {
    assert.ok(staging.includes(needle), `the closing commit does not name ${needle}`);
  }
  assert.ok(close.some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')), 'no local-mode rule');
  // The three tracking cases; not opted in (and triqual missing) go straight to the options.
  const opted = close.find((l) => l.startsWith('- **Opted in**'));
  const notOpted = close.find((l) => l.startsWith('- **Not opted in**'));
  const missing = close.find((l) => l.startsWith('- **`triqual` missing**'));
  assert.ok(opted && notOpted && missing, 'Close the Plan lacks one of the three tracking cases');
  for (const re of [/`"optedIn": false`/, /exit 2/, /no `triqual tasks` command/, /never create `progress\.md`/, /only the options/]) {
    assert.match(notOpted, re, `the not-opted-in case does not say ${re}`);
  }
  for (const re of [/exit 3/, /`PATH`/, /as not opted in/, /once/]) assert.match(missing, re, `the triqual-missing case does not say ${re}`);
  // The options come after the close: merge, PR, keep, and discard.
  const options = all.indexOf('## Step 5: Present Options');
  assert.ok(options > all.indexOf('## Step 2: Close the Plan'), 'the options do not follow the close');
  const menu = section(FB, '## Step 5: Present Options').join('\n');
  for (const re of [/Merge back to <base-branch> locally/, /Push and create a Pull Request/, /Keep the branch as-is/, /discard/i]) {
    assert.match(menu, re, `the options do not offer ${re}`);
  }
  // Every other line that runs triqual tasks or names progress.md is for an opted-in repo.
  const bad = numbered(FB)
    .filter(([, , l]) => /triqual tasks (check|close)|progress\.md/.test(l))
    .filter(([, , l]) => !l.startsWith('- **Not opted in**'))
    .filter(([, , l]) => !/\bopted in\b/i.test(l.replace(/not opted in/gi, '')))
    .map(([p, n, l]) => `${p}:${n}: ${l}`);
  assert.deepEqual(bad, [], 'a triqual tasks command or progress.md rule outside an opted-in instruction');
});

// ---- fork.test.mjs -------------------------------------------------------------------------------------------------

test('fork.test.mjs has no todo cases left', () => {
  const source = readFileSync(join(TEST, 'fork.test.mjs'), 'utf8');
  const pending = /const PENDING = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  assert.ok(pending, 'fork.test.mjs has no PENDING set');
  assert.equal(pending[1].replace(/\/\/.*$/gm, '').trim(), '', `PENDING still lists: ${pending[1].trim()}`);
  // No todo marker: the only code lines naming `todo` are caseFor's two, which yield a todo case for a PENDING skill
  // only (and PENDING is empty).
  const GATE = [
    'if (!PENDING.has(skill)) return [{ todo: false }, check];',
    '{ todo: `${skill} is adapted in a later task` },',
  ];
  const markers = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && /\btodo\b/.test(line));
  assert.deepEqual(markers, GATE, 'fork.test.mjs has a todo marker outside the PENDING gate');
});

// ---- final fix wave (plan role-tiers · final fix) --------------------------------------------------------------------

test('Finish re-records every Unrecorded: record before the totals and the deletion, and lists the ones that still fail', () => {
  const finish = section(EP, '## Finish');
  const line = findLine(finish, (l) => l.includes('`triqual role-eval record --plan <plan file> <json-file>`'), 'the Finish re-record rule');
  mustSay(line, ['every record that has an `Unrecorded:` line', 'already recorded', '"Unrecorded records"', 'its JSON', 'record them later'], 'the Finish re-record rule');
  const totals = finish.findIndex((l) => l.includes('total the review from the ledger'));
  const deletion = finish.findIndex((l) => l.includes('delete this'));
  assert.ok(totals >= 0 && deletion >= 0, 'Finish lost its totals or its deletion');
  assert.ok(finish.indexOf(line) < totals && totals < deletion, 'the re-record is not before the totals and the deletion');
});

test('round 1 says the gate\'s findings go to the fix loop after round 2, and the final review row names the hunters', () => {
  assert.ok(squash(reviewStep()).includes('go to the fix loop after round 2'), 'round 1 does not say the gate\'s findings wait for round 2');
  assert.ok(!squash(reviewStep()).includes('as they come'), 'the old "as they come" wording is left');
  const { nodes } = digraph();
  const finals = [...nodes].filter((n) => n.includes('roles:final-adversarial-reviewer'));
  assert.ok(finals.length >= 1 && finals.every((n) => n.includes('3 hunters')), 'the digraph final review node omits the hunters');
});

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

// Plan Store-2 T3 fix 1: an entry with no commit of its own, a review included, never takes the plain add.
test('executing-plans Tracking lands the review, ruling, status-only and close entries with --no-commit; plain add only before its own commit (R3)', () => {
  const rule = blocks(`${EP}/SKILL.md`).find((l) => l.includes('`"mode": "store"`') && l.includes('`triqual tracking add'));
  assert.ok(rule, 'no store-mode rule names triqual tracking add');
  for (const needle of [
    'a review of a commit already made',
    'the plan\'s close',
    'with no commit of its own',
    'lands with `triqual tracking add <draft> --no-commit`',
    '`--commit <reviewed sha>`',
    'would let that commit past the pre-commit gate',
    'only an entry for a commit you are about to make yourself lands with plain `triqual tracking add <draft>` before the commit it describes',
  ]) {
    assert.ok(rule.includes(needle), `the store-mode rule does not say ${needle}: ${rule}`);
  }
});

// Plan Store-2 T3: the Tracking section of executing-plans carries the store-mode rules beside the committed and local ones.
test('executing-plans Tracking has a store-mode rule: entry before the commit, --no-commit when none, history from the log', () => {
  const all = blocks(`${EP}/SKILL.md`);
  const rule = all.find((l) => l.includes('`"mode": "store"`') && l.includes('`triqual tracking add'));
  assert.ok(rule, 'no store-mode rule names triqual tracking add');
  for (const needle of [
    '`triqual tracking add <draft>`',
    'before the commit',
    '`triqual tracking add <draft> --no-commit`',
    'ruling',
    'status-only',
    'stamped onto the next, unrelated commit',
    'mktemp -d',
    'an added or modified',
    '`progress.md`',
    '`status.md`',
    '`*.tasks.json`',
    '`triqual tracking log`',
    '`triqual tasks status --json`',
    '`triqual tasks export --json`',
    '`triqual tracking status set --section',
    'bare plan file name',
    'the check takes no plan option',
    '`store-mode.md` under `references` in skill `progress-tracking:progress-tracking`',
  ]) {
    assert.ok(rule.includes(needle), `the store-mode rule does not say ${needle}: ${rule}`);
  }
  assert.match(rule, /opted in/i, 'a line naming progress.md must be tied to an opted-in repo');
  // The committed and local rules stay as they are.
  const opted = all.find((l) => l.startsWith('- **Opted in**'));
  assert.ok(opted.includes('`<plan>`') === false || opted.includes('the plan file in `plansDir`'), 'the committed meaning of --plan changed');
  assert.ok(opted.includes('In `"mode": "committed"`, stage `progress.md`, `status.md`'), 'the committed staging rule changed');
  assert.ok(all.some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')), 'no local-mode rule');
});

test('executing-plans after compaction reads store-mode ledger state from triqual tasks status --json', () => {
  const line = blocks(`${EP}/SKILL.md`).find((l) => l.startsWith('- After compaction, when opted in'));
  assert.ok(line.includes("the task's `status` in the plan's `*.tasks.json`"), 'the committed-mode read was altered');
  assert.match(line, /In store mode[^.]*no `\*\.tasks\.json`[^.]*`triqual tasks status --json`/, line);
  // Only the export carries a per-task status; the status listing has the in-progress ids and the next task.
  assert.match(line, /take each task's state from `triqual tasks export --json`/, line);
  assert.match(line, /`triqual tasks status --json` lists only `inProgress` and `next`/, line);
});

test('executing-plans tells the gate that no tracking file is expected in a store-mode diff, as SDD does', () => {
  const line = blocks(`${EP}/SKILL.md`).find((l) => l.startsWith('- Run `../subagent-driven-development/scripts/review-package PLAN_FILE BASE HEAD`'));
  assert.ok(line.includes('the tracking files it must expect in the diff'), 'the committed-mode sentence changed');
  assert.match(line, /In store mode[^.]*no tracking file is expected[^.]*finding/, line);
});

test('executing-plans keeps the dirty-ledger sentence for committed mode and adds the store clause beside it', () => {
  const text = read(`${EP}/SKILL.md`).replace(/\s+/g, ' ');
  assert.ok(text.includes("the `review` and `done` moves leave the task ledger and `status.md` dirty: the next task's commit stages them"), 'the committed sentence changed');
  assert.match(text, /In store mode the moves leave no file dirty, so there is nothing for the next commit to stage/);
});

test('no store-mode clause of executing-plans pairs the tasks check with --plan', () => {
  for (const line of blocks(`${EP}/SKILL.md`).filter((l) => l.includes('`"mode": "store"`') || /\bstore mode\b/i.test(l))) {
    for (const clause of line.split(/[.;:]\s/)) {
      assert.ok(!(/\bcheck\b/.test(clause) && clause.includes('--plan')), `a store-mode clause pairs the check with --plan: ${clause}`);
    }
  }
});

// ---- finishing-branch integrates a stack (plan stacked-execution · T11; spec U6, R5, R6) -----------------------------

const STACK_SCRIPT = '../subagent-driven-development/scripts/stack.mjs';
// The script is not executable (mode 100644): every call goes through node.
const STACK = `node ${STACK_SCRIPT}`;
// One block of finishing-branch's text (a paragraph or one list item), joined on one line, found by a phrase it holds.
const fbBlock = (phrase) => {
  const found = blocks(`${FB}/SKILL.md`).filter((b) => b.includes(phrase));
  assert.equal(found.length, 1, `finishing-branch has ${found.length} blocks holding ${phrase}`);
  return found[0];
};
const mustHave = (text, needles, what) => {
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${what} does not say ${needle}: ${text}`);
  }
};

test('finishing-branch runs the suite at the top of the stack', () => {
  const step = section(FB, '## Step 1: Verify Tests');
  const rule = fbBlock('**Stacked plan:**');
  assert.ok(step.some((l) => l.startsWith('**Stacked plan:**')), 'the stack rule is not inside Step 1');
  mustHave(rule, [`\`${STACK} path PLAN_FILE\``, 'state file', 'the highest `n`', 'top branch', 'the suite'], 'the Step 1 stack rule');
  assert.match(rule, /exists[^.]*stack/i, 'the stack rule is not keyed on the state file existing');
  assert.match(rule, /no state file[^.]*(current|menu below)/i, 'a plan with no state file does not keep the current menu');
  assert.match(rule, /check(s|ing)? out the top branch[^.]*before[^.]*suite|top branch[^.]*then[^.]*suite/i, 'the suite does not run on the top branch');
});

test('finishing-branch offers the GitHub stack menu', () => {
  const menu = section(FB, '## Step 5: Present Options').join('\n');
  const gh = /\*\*Stacked plan, GitHub mode[^\n]*\n+```\n([^]*?)```/.exec(menu);
  assert.ok(gh, 'Step 5 has no GitHub-mode stack menu block');
  const options = gh[1].split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(options.length, 2, `the GitHub menu has ${options.length} options: ${options}`);
  assert.match(options[0], /^1\. Leave the stack open for review/i);
  assert.match(options[1], /^2\. Merge now/i);
  const exec = section(FB, '### Stacked plan: GitHub mode').join(' ');
  mustHave(exec, ['`gh stack merge <pr> --yes --merge-method <m>`', 'the top PR to merge up to', 'the method'], 'the GitHub-mode execution');
  assert.match(exec, /owner[^.]*(names|name)[^.]*PR[^.]*method|owner[^.]*PR[^.]*and the method/i, 'the owner does not name the PR and the method');
  assert.match(exec, /never (pick|choose|guess)[^.]*(PR|method)/i, 'nothing forbids choosing the PR or the method for the owner');
});

test('finishing-branch offers the local stack menu', () => {
  const menu = section(FB, '## Step 5: Present Options').join('\n');
  const local = /\*\*Stacked plan, local mode[^\n]*\n+```\n([^]*?)```/.exec(menu);
  assert.ok(local, 'Step 5 has no local-mode stack menu block');
  const options = local[1].split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(options.length, 3, `the local menu has ${options.length} options: ${options}`);
  assert.match(options[0], /^1\. Merge the stack into <trunk> locally/i);
  assert.match(options[1], /^2\. Push and open it as stacked PRs/i);
  assert.match(options[2], /^3\. Keep as is/i);
  const exec = section(FB, '### Stacked plan: local mode').join(' ');
  mustHave(exec, ['`git merge --ff-only <top branch>`', 'the suite'], 'the local merge');
  const push = fbBlock(`\`${STACK} mode PLAN_FILE github\``);
  mustHave(push, [`\`${STACK} submit PLAN_FILE <N>\``, 'each phase still `done`, in order', 'already `submitted`', '`--open`'], 'the push option');
  assert.ok(!push.includes('each phase in order'), 'the push option still submits every phase, whatever its state');
  const at = (needle) => push.indexOf(needle);
  assert.ok(at(' mode PLAN_FILE github') < at(' submit PLAN_FILE <N>`') && at(' submit PLAN_FILE <N>`') < at('`--open`'), 'mode, submit per phase and --open are out of order');
});

test('a full merge runs the After Merge checklist, prunes and deletes the state; a partial merge refreshes the state with stack.mjs status and runs nothing', () => {
  const after = section(FB, '### After a stack merge').join(' ');
  mustHave(
    after,
    ['status PLAN_FILE', 'the top phase', '`merged`', '`## After Merge`', '`gh stack sync --prune`', 'delete the merged phase branches', 'STACK_STATE', 'state file'],
    'After a stack merge',
  );
  const full = fbBlock('**Full merge**');
  mustHave(full, ['the top phase', '`merged`', 'After Merge', '`gh stack sync --prune`', 'delete', 'state file'], 'the full-merge rule');
  assert.ok(full.indexOf('After Merge') < full.indexOf('`gh stack sync --prune`') && full.indexOf('`gh stack sync --prune`') < full.lastIndexOf('state file'), 'the full-merge steps are out of order');
  const partial = fbBlock('**Partial merge**');
  mustHave(partial, ['status PLAN_FILE', 'refresh', 'runs nothing', 'the state file stays'], 'the partial-merge rule');
  assert.match(partial, /no After Merge[^.]*(run|item)|does not run[^.]*After Merge|runs nothing/i, 'the partial merge may run something');
  assert.match(partial, /not the top phase|below the top phase|short of the top phase/i, 'the partial merge is not defined against the top phase');
});

test('a stack always writes the After Merge checklist, marked to run once merged, into the closing entry and status Next; a merge that runs it adds a second entry', () => {
  const rule = fbBlock('**Stacked plan, After Merge checklist:**');
  mustHave(rule, ['`## After Merge`', 'closing progress entry', 'status `Next`', 'each operation with its command', 'to run once merged', 'always', 'second progress entry'], 'the checklist rule');
  assert.match(rule, /opted in/, 'the checklist rule does not say what a repo not opted in does');
  assert.match(rule, /final message/, 'a repo not opted in has no place for the checklist');
  // Step 2 stays as U6 says: the entry and the roadmap are written there, before any option runs.
  const step2 = section(FB, '## Step 2: Close the Plan');
  assert.ok(step2.some((l) => l.startsWith('**Stacked plan, After Merge checklist:**')), 'the rule is not in Step 2');
  assert.ok(!step2.join(' ').match(/steps? 3 and 4[^.]*wait|wait until Step 6|deferred closing/i), 'Step 2 still defers the closing entry and roadmap');
  assert.ok(!/deferred closing entry/i.test(read(`${FB}/SKILL.md`)), 'the skill still writes a deferred closing entry');
  const noOps = fbBlock('are not tasks');
  mustHave(noOps, ['After Merge', 'never reach the task ledger'], 'the After Merge rule');
  // The merge that runs the checklist records it in a second entry, after the checklist ran.
  const full = fbBlock('**Full merge**');
  mustHave(full, ['second progress entry'], 'the full-merge rule');
  assert.ok(full.indexOf('`## After Merge`') < full.indexOf('second progress entry'), 'the second entry comes before the checklist ran');
});

test('a full merge refreshes the status section that named the checklist, so Next lists only what is still pending', () => {
  const full = fbBlock('**Full merge**');
  mustHave(
    full,
    ['refresh', 'status `Next`', '`triqual tracking status set --section <heading> <draft>`', '`triqual tracking write status <draft>`', 'store', 'local', 'still pending', 'final message'],
    'the full-merge status refresh',
  );
  assert.ok(full.indexOf('second progress entry') < full.indexOf('Last, refresh'), 'the status refresh comes before the second entry');
  assert.ok(full.indexOf('`## After Merge`') < full.indexOf('Last, refresh'), 'the status refresh comes before the checklist ran');
  assert.match(full, /failing operation[^;)]*(it and every operation after it|the failed operation and the rest)[^;)]*(stay|remain) pending/i, 'a failing operation does not leave the failed one and the rest pending');
  assert.match(full, /only (the operations still pending|what is still pending)|ran\b[^.]*checklist|checklist ran/i, 'the refreshed Next does not name only the pending operations or say the checklist ran');
  assert.match(full, /not opted in[^.]*final message/i, 'a repo not opted in does not get the status in the final message');
});

test('every stack move runs through node, the script is not executable', () => {
  for (const [, n, l] of numbered(FB).filter(([, , l]) => l.includes(STACK_SCRIPT))) {
    const total = l.split(STACK_SCRIPT).length - 1;
    const viaNode = l.split(`node ${STACK_SCRIPT}`).length - 1;
    assert.equal(viaNode, total, `line ${n} runs stack.mjs without node (${viaNode} of ${total}): ${l}`);
  }
});

test('the state file path is captured in Step 3 and read and deleted from there, never from the main repo root', () => {
  // Not section(): the bash comments inside the block start with "# " and would end it.
  const text = read(`${FB}/SKILL.md`);
  const step3 = text.slice(text.indexOf('## Step 3: Detect Environment'), text.indexOf('## Step 4: Determine Base Branch'));
  assert.ok(step3.includes(`STACK_STATE=$(${STACK} path PLAN_FILE)`), 'Step 3 does not capture the state path in STACK_STATE');
  assert.ok(step3.indexOf('STACK_STATE') < step3.indexOf('```', step3.indexOf('```') + 3), 'STACK_STATE is not captured inside the Step 3 block');
  const after = fbBlock('A merge with `gh stack merge <pr>` may stop short');
  mustHave(after, ['cd "$WORKTREE_PATH"', 'status PLAN_FILE', 'never from `MAIN_ROOT`'], 'the status read');
  const full = fbBlock('**Full merge**');
  mustHave(full, ['rm -f "$STACK_STATE"'], 'the state deletion');
  assert.ok(!/rm -f "\$\(/.test(read(`${FB}/SKILL.md`)), 'the state file is still resolved again after the directory change');
  const partial = fbBlock('**Partial merge**');
  mustHave(partial, ['cd "$WORKTREE_PATH"'], 'the partial-merge refresh');
});

test('a GitHub merge changes to the main repo root before cleanup, like the local merge', () => {
  const full = fbBlock('**Full merge**');
  mustHave(full, ['cd "$MAIN_ROOT"', 'Step 7'], 'the full-merge rule');
  assert.ok(full.indexOf('cd "$MAIN_ROOT"') < full.indexOf('Step 7'), 'the directory change comes after the cleanup');
  assert.ok(full.indexOf('cd "$MAIN_ROOT"') < full.indexOf('`gh stack sync --prune`'), 'the directory change comes after the prune');
});

test('a GitHub full merge brings the main checkout to the merged trunk before the After Merge checklist', () => {
  const full = fbBlock('**Full merge**');
  const at = (needle) => {
    const i = full.indexOf(needle);
    assert.ok(i >= 0, `the full-merge rule does not say ${needle}: ${full}`);
    return i;
  };
  const order = ['cd "$MAIN_ROOT"', '--untracked-files=no', 'git fetch <remote>', 'git checkout <trunk>', 'git merge --ff-only <remote>/<trunk>', '`## After Merge`', '`gh stack sync --prune`'];
  order.reduce((prev, needle) => {
    assert.ok(at(needle) > prev, `${needle} is out of order in the full-merge rule: ${full}`);
    return at(needle);
  }, -1);
  assert.match(full, /require a clean tree/i, 'a clean tree is not required');
  assert.match(full, /refused, stop and report[^.]*nothing after it runs/i, 'a refused step does not stop the checklist');
});

test('finishing-branch names an unlinked stack before offering gh stack merge', () => {
  const rule = fbBlock('**Stack link check (GitHub mode):**');
  mustHave(rule, ['; stack link missing', 'ledger', 'say so', 'before offering `gh stack merge`', 'cannot be merged atomically'], 'the stack link check');
  const menus = section(FB, '## Step 5: Present Options').join('\n');
  assert.ok(menus.includes('**Stack link check (GitHub mode):**'), 'the stack link check is not in Step 5, where the menu is presented');
});

test('stacked execution makes no closing commit', () => {
  const rule = fbBlock('**Stacked plan, no closing commit:**');
  mustHave(rule, ['state file exists', 'step 5', 'closing commit', 'store', 'local', 'never'], 'the no-closing-commit rule');
  assert.match(rule, /(skip|omit)[^.]*step 5/i, 'step 5 is not skipped');
  assert.match(rule, /committed[^.]*stops/i, 'a committed-mode plan with a stack is not stopped');
  assert.ok(section(FB, '## Step 2: Close the Plan').some((l) => l.startsWith('**Stacked plan, no closing commit:**')), 'the rule is not in Step 2');
});

test('finishing-branch keeps the current menu without a state file and every stack move carries PLAN_FILE', () => {
  const menu = section(FB, '## Step 5: Present Options').join('\n');
  mustHave(menu, ['Merge back to <base-branch> locally', 'Push and create a Pull Request', 'Keep the branch as-is'], 'Step 5');
  assert.match(menu, /no state file[^]*current/i, 'Step 5 does not keep the current menu for a plan with no state file');
  for (const [, n, l] of numbered(FB).filter(([, , l]) => l.includes(STACK_SCRIPT))) {
    assert.match(l, /\b(path|status|mode|submit)\b/, `line ${n} runs stack.mjs with a command the plan does not give: ${l}`);
    assert.match(l, /PLAN_FILE/, `line ${n} runs stack.mjs without PLAN_FILE: ${l}`);
  }
});

// ---- stacked execution (spec U5, R1, R2, R4, R7): the same lifecycle as subagent-driven-development ----------------------

const STACK_REAL = join(SKILLS, SDD, 'scripts', 'stack.mjs');
const PHASED_PLAN = join(TEST, 'fixtures', 'phased-plan.md');
const AUTH = 'Authorization: push phase branches and draft PRs —';

// A repo whose stack was set up by the real stack.mjs (init in local mode, then phase 1) on phased-plan.md: no
// hand-written state file. stack.mjs runs with a PATH that has no `triqual`, so init has no tracking mode to refuse.
const stackedRepo = () => {
  const r = repo();
  const planFile = join(r.plansDir, 'phased-plan.md');
  writeFileSync(planFile, readFileSync(PHASED_PLAN, 'utf8'));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'add the phased plan');
  const stack = (...args) => {
    const res = spawnSync(process.execPath, [STACK_REAL, ...args, ...(args[0] === 'init' ? ['--mode', 'local'] : [])], {
      cwd: r.dir,
      env: { ...process.env, HOME: join(r.dir, '.no-home'), PATH: cleanPath(join(r.dir, '.no-tools')) },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `stack.mjs ${args.join(' ')}: ${res.stdout}${res.stderr}`);
    return res.stdout.trim();
  };
  const plan = 'docs/plans/phased-plan.md';
  stack('init', plan);
  stack('phase', plan, '1');
  return { r, plan, planFile, stack, workspace: join(r.dir, '.methodology', 'sdd', 'phased-plan') };
};

test('task-done squashes the task before its ledger move when the stack is active', () => {
  const { r, plan, workspace } = stackedRepo();
  try {
    assert.equal(r.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'demo/01-core', 'phase 1 did not leave HEAD on its branch');
    const opts = { vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    const preSquash = r.commit('two.txt', 'two\n');
    assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '2');
    const res = r.run('task-done', [plan, '1', base, '--', 'echo', '2/2 pass'], opts);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '1', 'BASE..HEAD is not one commit');
    const head = r.git('rev-parse', 'HEAD').trim();
    assert.notEqual(head, preSquash, 'HEAD is still the pre-squash commit');
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), base, 'the squashed commit does not sit on BASE');
    assert.equal(r.git('show', '--format=', '--name-only', 'HEAD').trim().split('\n').sort().join(','), 'one.txt,two.txt');
    assert.deepEqual(r.moves(), [`tasks done T1 --commit ${head} --plan ${join(r.plansDir, 'phased-plan.md')}`]);
    const short = (sha) => r.git('rev-parse', '--short=7', sha).trim();
    const ledger = readFileSync(join(workspace, 'sdd-ledger.md'), 'utf8').split('\n');
    assert.equal(ledger[1], `Task 1: complete (commits ${short(base)}..${short(head)}, tests: echo '2/2 pass' → 2/2 pass)`);
  } finally {
    r.cleanup();
  }
});

test('task-done squashes only after the test command passes, and a squash refusal records nothing', () => {
  const { r, plan, workspace } = stackedRepo();
  try {
    const opts = { vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    const preSquash = r.commit('two.txt', 'two\n');
    // A failing test command leaves the two commits alone.
    const failed = r.run('task-done', [plan, '1', base, '--', 'false'], opts);
    assert.notEqual(failed.status, 0);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), preSquash, 'a failing run squashed the task');
    // HEAD off the active phase's branch: stack.mjs squash exits 3, which fails task-done with nothing recorded.
    r.git('switch', '-q', '-c', 'elsewhere');
    const refused = r.run('task-done', [plan, '1', base, '--', 'echo', 'ok'], opts);
    assert.equal(refused.status, 3, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /NOT recorded/);
    assert.deepEqual(r.moves(), [], 'a refused squash moved the ledger');
    assert.equal(existsSync(join(workspace, 'sdd-ledger.md')), false, 'a refused squash wrote the completion line');
    assert.equal(r.git('rev-parse', 'HEAD').trim(), preSquash);
  } finally {
    r.cleanup();
  }
});

// The task ledger of phased-plan.md with T1 at `status`, and the `triqual tasks status --json` listing that names it.
const phasedLedgerAt = (r, status) => {
  const ledgerPath = join(r.plansDir, 'phased-plan.tasks.json');
  // Never staged by `git add -A`, so rewriting it never dirties the tree stack.mjs squash checks.
  appendFileSync(join(r.dir, '.git', 'info', 'exclude'), 'phased-plan.tasks.json\n');
  const task = (id, st) => ({ id, title: id, status: st, deps: [], commits: [], history: [] });
  writeFileSync(ledgerPath, `${JSON.stringify({ state: 'active', tasks: [task('T1', status), task('T2', 'pending')] })}\n`);
  return JSON.stringify([{ name: 'phased-plan', ledgerPath, done: 0, total: 2, inProgress: [], next: 'T1' }]);
};

test('a task-done re-run of a recorded task never squashes again: after stack done, and after the next task committed', () => {
  const { r, plan, stack, workspace } = stackedRepo();
  try {
    const done = (status, ...args) =>
      r.run('task-done', [plan, ...args, '--', 'echo', 'ok'], {
        vars: { FAKE_TRIQUAL_PATHS: r.paths(), ...(status ? { FAKE_TRIQUAL_STATUS: phasedLedgerAt(r, status) } : {}) },
      });
    const lines = () => readFileSync(join(workspace, 'sdd-ledger.md'), 'utf8').split('\n').filter((l) => l.startsWith('Task '));
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    r.commit('two.txt', 'two\n');
    const first = done(null, '1', base);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const squashed = r.git('rev-parse', 'HEAD').trim();
    const movesAfterFirst = r.moves().length;
    assert.equal(lines().length, 1);

    // Re-run after `stack done 1`: stack.mjs squash would exit 3 (no phase is active), which used to fail a recorded task.
    stack('done', plan, '1');
    for (const status of [null, 'done']) {
      const again = done(status, '1', base);
      assert.equal(again.status, 0, `${status}: ${again.stdout}${again.stderr}`);
      assert.doesNotMatch(again.stderr, /NOT recorded/, String(status));
      assert.equal(r.git('rev-parse', 'HEAD').trim(), squashed, `${status}: the re-run moved HEAD`);
      assert.equal(lines().length, 1, `${status}: the re-run wrote a second completion line`);
    }
    assert.equal(r.moves().length, movesAfterFirst + 1, 'only the first re-run (unknown ledger status) may move done again: not the one that shows it done');
  } finally {
    r.cleanup();
  }
});

test('a task-done re-run with an earlier task BASE after the next task committed does not fold the next task in', () => {
  const { r, plan, workspace } = stackedRepo();
  try {
    const opts = (status) => ({ vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: phasedLedgerAt(r, status) } });
    const base1 = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    r.commit('one-more.txt', 'one more\n');
    const first = r.run('task-done', [plan, '1', base1, '--', 'echo', 'ok'], opts('in_review'));
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const squashed1 = r.git('rev-parse', 'HEAD').trim();
    r.commit('two.txt', 'two\n');
    r.commit('two-more.txt', 'two more\n');
    const tip = r.git('rev-parse', 'HEAD').trim();
    const again = r.run('task-done', [plan, '1', base1, '--', 'echo', 'ok'], opts('done'));
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(r.git('rev-parse', 'HEAD').trim(), tip, 'the re-run folded task 2 into task 1');
    assert.equal(r.git('rev-list', '--count', `${squashed1}..HEAD`).trim(), '2', "task 2's commits were rewritten");
    const ledger = readFileSync(join(workspace, 'sdd-ledger.md'), 'utf8');
    assert.equal(ledger.split('\n').filter((l) => l.startsWith('Task 1: complete')).length, 1, 'a bogus second line names task 2 as task 1');
  } finally {
    r.cleanup();
  }
});

test('a reopened task is still squashed by task-done: its range has new commits and its status is in_progress', () => {
  const { r, plan } = stackedRepo();
  try {
    const opts = (status) => ({ vars: { FAKE_TRIQUAL_PATHS: r.paths(), FAKE_TRIQUAL_STATUS: phasedLedgerAt(r, status) } });
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    assert.equal(r.run('task-done', [plan, '1', base, '--', 'echo', 'ok'], opts('in_review')).status, 0);
    const squashed = r.git('rev-parse', 'HEAD').trim();
    r.commit('fix.txt', 'fix\n');
    r.commit('fix2.txt', 'fix 2\n');
    const res = r.run('task-done', [plan, '1', base, '--', 'echo', 'ok'], opts('in_progress'));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.notEqual(r.git('rev-parse', 'HEAD').trim(), squashed);
    assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '1', 'the reopened task was not folded into one commit');
  } finally {
    r.cleanup();
  }
});

test('task-done without a stack state file does not squash', () => {
  const r = repo();
  try {
    const opts = { vars: { FAKE_TRIQUAL_PATHS: r.paths() } };
    const base = r.git('rev-parse', 'HEAD').trim();
    r.commit('one.txt', 'one\n');
    const head = r.commit('two.txt', 'two\n');
    const res = r.run('task-done', [r.plan, '1', base, '--', 'echo', 'ok'], opts);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(r.git('rev-list', '--count', `${base}..HEAD`).trim(), '2', 'the two commits were folded without a stack');
    assert.equal(r.git('rev-parse', 'HEAD').trim(), head);
    assert.deepEqual(r.moves(), [`tasks done T1 --commit ${head} --plan ${join(r.plansDir, 'demo-plan.md')}`]);
  } finally {
    r.cleanup();
  }
});

test('task-done locates the state file with stack.mjs path and squashes before the ledger move', () => {
  const script = readFileSync(join(SCRIPTS, 'task-done'), 'utf8');
  mustSay(script, ['node "$sdd/stack.mjs" path "$plan"', 'node "$sdd/stack.mjs" squash "$plan" "$base"'], 'task-done');
  assert.ok(!/\.methodology\/stack/.test(script.replace(/^#.*$/gm, '')), 'task-done builds the state path itself');
  const at = (needle) => script.indexOf(needle);
  assert.ok(at('"$@" > "$log"') < at('stack.mjs" squash'), 'the squash runs before the test command');
  assert.ok(at('stack.mjs" squash') < at('"$cli" tasks done'), 'the squash runs after the ledger move');
});

const EP_SETUP = () => squash(section(EP, '## Setup'));
const epBlocks = () => blocks(`${EP}/SKILL.md`);

test('executing-plans follows the SDD stack lifecycle', () => {
  const text = read(`${EP}/SKILL.md`);
  const prose = text.slice(text.indexOf('## Setup'), text.indexOf('## Common Rationalizations'));
  const needles = [
    `node ${STACK_SCRIPT} init`,
    `node ${STACK_SCRIPT} phase`,
    '--fixup=',
    '`scripts/task-done`',
    'Phase check',
    'Ruling: <test> flaky — passed on re-run',
    'triqual tasks reopen T<N>',
    `node ${STACK_SCRIPT} done`,
    `node ${STACK_SCRIPT} submit`,
    'Phase <N>: submitted (<branch>, PR #<n> draft)',
    'Phase <N>: complete (<branch>, local)',
    'one commit on the top phase',
    '`fix: address final review findings`',
    'top Phase check',
    '--open',
  ];
  let at = -1;
  for (const needle of needles) {
    const found = prose.indexOf(needle, at + 1);
    assert.ok(found > at, `"${needle}" is missing or out of order (searched after offset ${at})`);
    at = found;
  }
  // Committed tracking mode stops the run before Task 1 (R4).
  const stop = epBlocks().find((l) => l.includes('committed') && l.includes('triqual progress-init --store'));
  assert.ok(stop, 'Setup does not stop on committed mode with the progress-init --store switch');
  mustSay(stop, ['exits 3', 'before Task 1', '(or `--local`)'], 'the committed-mode stop');
  // The push authorization is ledgered and asked once (R7).
  const auth = epBlocks().find((l) => l.includes(`${AUTH} handoff`) && l.includes('ask once'));
  assert.ok(auth, 'the text does not name the ledgered authorization and ask once without it');
  mustSay(auth, [`${AUTH} setup <date>`, '`handoff <date>`', '`setup <date>`', 'before Task 1', 'never asks again', `node ${STACK_SCRIPT} mode PLAN_FILE local`], 'the authorization rule');
  assert.match(auth, /A yes: write `Authorization: push phase branches and draft PRs — setup <date>`/);
  mustSay(auth, ['`Authorization: declined — stack in local mode`', 'any `Authorization:` line', 'declined one included'], 'the declined rule');
  assert.ok(EP_SETUP().includes(`node ${STACK_SCRIPT} init`), 'stack init is not in Setup');
  // A real Phase check failure reopens the phase's last task with --plan; submit exit 5 is ruled, retried once, then local.
  const reopen = epBlocks().find((l) => l.includes('triqual tasks reopen T<N>'));
  assert.match(reopen, /triqual tasks reopen T<N> "<reason>" --plan <plan>/, reopen);
  mustSay(reopen, ['real failure'], 'the reopen rule');
  const exit5 = epBlocks().find((l) => l.includes('exits 5'));
  assert.ok(exit5, 'the text does not handle submit exit 5');
  mustSay(exit5, ['`Ruling:`', 'retry once', `node ${STACK_SCRIPT} mode PLAN_FILE local`], 'the submit exit 5 rule');
  // R1: a submitted phase is final; the defect is fixed in the current task's commit.
  const final = epBlocks().find((l) => l.includes('submitted phase') && l.includes("current task's commit"));
  assert.ok(final, 'the no-rewrite rule is missing');
  mustSay(final, ['never', 'force push'], 'the no-rewrite rule');
  // Recovery reads the stack state; the After Merge checklist is listed, not run.
  const recovery = epBlocks().find((l) => l.includes(`${STACK_SCRIPT} status`));
  assert.ok(recovery, 'recovery after compaction does not read stack status');
  mustSay(recovery, ['compaction', 'ledger'], 'the recovery rule');
  mustSay(squash(section(EP, '## Finish')), ['`## After Merge`', 'is not run', 'final message'], 'the After Merge rule');
});

test('executing-plans commits one commit per task, fix rounds as --fixup, and task-done squashes', () => {
  const step2 = squash(section(EP, '### 2. Work the steps'));
  mustSay(step2, ['one commit', 'never `HEAD~1`'], 'step 2');
  const review = squash(reviewStep());
  mustSay(review, ['`git commit --fixup=', 'first commit'], 'the fix round commit');
  const done = squash(section(EP, '### 5. Complete the task'));
  mustSay(done, [`${STACK_SCRIPT} path`, `${STACK_SCRIPT} squash`, 'before its ledger move', 'squashed', 'pre-squash', 'exits 3'], 'step 5');
  assert.ok(!done.includes('(the head the approving review saw)'), 'step 5 still names the pre-squash head for the move');
});

test('the executing-plans push stop is narrowed', () => {
  const all = lines(`${EP}/SKILL.md`);
  const start = all.findIndex((l) => l.startsWith('Four things stop you'));
  assert.ok(start >= 0, 'the Four things paragraph is gone');
  assert.equal(
    squash(all.slice(start, start + 5)),
    'Four things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this worktree that norms say you ask about first (a merge, a push to a shared branch, a publish); and a plan so broken that every path forward is a guess. For those, stop and ask.',
  );
  const last = all[start + 5];
  assert.ok(last, 'there is no line after the pinned five');
  mustSay(last, [AUTH + ' handoff <date>', '`Authorization: push phase branches and draft PRs — setup <date>`', 'only exception', 'draft PRs', 'ready for review after the final review', 'any merge', 'force push', 'still stop'], 'the push exception');
  assert.equal(all[start + 6], '', 'the push exception is not the last line of the paragraph');
});

test('executing-plans writes the handoff authorization line itself when the method was chosen at the plan handoff', () => {
  const block = epBlocks().find((l) => l.includes(`${AUTH} handoff`) && l.includes('ask once'));
  assert.ok(block, 'the authorization rule is gone');
  mustSay(block, [
    `${AUTH} handoff <date>\`, which you write yourself at setup, before Task 1, when your human partner chose the execution method (or confirmed it) at the writing-plans handoff in this conversation`,
    'and this conversation holds no such choice (a new session on an existing plan), ask once',
  ], 'the handoff authorization');
  assert.ok(!block.includes('the plan handoff writes'), 'the text still says the plan handoff writes the line');
});

// Final review fixes (plan stacked-execution): the same rules as subagent-driven-development, in the inline skill.
test('executing-plans does not stack a run that began before stacked execution', () => {
  const rule = epBlocks().find((l) => l.startsWith('- **A run that began before stacked execution is not stacked.**'));
  assert.ok(rule, 'Stack setup has no rule for a run that began before stacked execution');
  mustSay(rule, [
    `\`node ${STACK_SCRIPT} path PLAN_FILE\``, 'does not exist', '`Task <N>: complete`', 'Skip `init`, `phase`, `squash`, `done` and `submit`',
    '`Ruling: run began before stacked execution — no stack`', 'finish on the current branch', 'no state file',
    '`stack.mjs phase 1` itself exits 3', "HEAD's branch",
  ], 'the pre-stack rule');
  const setup = EP_SETUP();
  assert.ok(setup.indexOf('A run that began before stacked execution is not stacked.') < setup.indexOf(`node ${STACK_SCRIPT} init PLAN_FILE`), 'the pre-stack check runs after init');
});

test('executing-plans Phase check names the full test command of an unphased plan and the reopened task skips its first rework', () => {
  const check = epBlocks().find((l) => l.startsWith('- **Phase check.**'));
  assert.ok(check, 'the Phase check bullet is gone');
  mustSay(check, ['no `## Phase` heading', 'no `**Branch prefix:**` line', "the repository's full test command"], 'the unphased Phase check');
  mustSay(check, ["skipping the first round's `triqual tasks rework` move", '`reopen` already moved the task to `in_progress`', '`rework` only leaves `in_review`'], 'the reopened first fix round');
});

test('executing-plans consent text says the PRs are marked ready for review after the final review', () => {
  const auth = epBlocks().find((l) => l.includes(`${AUTH} handoff`) && l.includes('ask once'));
  mustSay(auth, ['marking them ready for review after the final review', 'mark them ready for review after the final review'], 'the push authorization');
});
