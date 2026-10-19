// Pins for finishing-branch (plan methodology-orchestrator · T22). The skill is read as text at run time. These restore the
// pins that went away with the old executing.test.mjs, for what the rewritten skill still promises: the close of the
// plan's task ledger, the stack merge flow, MAIN_ROOT and the session move before a worktree is removed, the After
// Merge checklist, and store mode's `tracking add --no-commit` with no tracking file staged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'methodology', 'skills');
const FB = 'finishing-branch';
const STACK_SCRIPT = '../executing-plans/scripts/stack.mjs';
// The script is not executable (mode 100644): every call goes through node.
const STACK = `node ${STACK_SCRIPT}`;

const text = () => readFileSync(join(SKILLS, FB, 'SKILL.md'), 'utf8');
const lines = () => text().split('\n').map((line) => line.trim());
// The trimmed lines from one heading (included) to the next heading of the same or a higher level.
const section = (heading) => {
  const all = lines();
  const start = all.indexOf(heading);
  assert.ok(start >= 0, `${FB}/SKILL.md has no heading ${heading}`);
  const level = /^#+/.exec(heading)[0].length;
  const end = all.findIndex((line, i) => i > start && /^#+ /.test(line) && /^#+/.exec(line)[0].length <= level);
  return all.slice(start, end < 0 ? undefined : end);
};
// A block is a paragraph or one list item, so a rule wrapped over several lines is read whole.
const blocks = () => {
  const out = [];
  let current = [];
  for (const raw of text().split('\n')) {
    if (raw.trim() === '' || /^\s*(?:- |\d+\. )/.test(raw)) {
      if (current.length) out.push(current.join(' '));
      current = [];
    }
    if (raw.trim() !== '') current.push(raw.trim());
  }
  if (current.length) out.push(current.join(' '));
  return out;
};
const block = (phrase) => {
  const found = blocks().filter((b) => b.includes(phrase));
  assert.equal(found.length, 1, `${FB} has ${found.length} blocks holding ${phrase}`);
  return found[0];
};
const mustHave = (haystack, needles, what) => {
  for (const needle of needles) assert.ok(haystack.includes(needle), `${what} does not say ${needle}: ${haystack}`);
};

// ---- the close of the plan's task ledger -----------------------------------------------------------------------------

test('the close runs triqual tasks check, then close, then the closing entry and the roadmap; the options come after', () => {
  const close = section('## Step 2: Close the Plan');
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
  for (const needle of ['`"mode": "committed"`', '`progress.md`', '`status.md`', '`*.tasks.json`', '`--no-verify`']) {
    assert.ok(close[commit].includes(needle), `the closing commit does not name ${needle}`);
  }
  assert.ok(close.some((l) => l.includes('`"mode": "local"`') && l.includes('`.git/`')), 'no local-mode rule');
  const all = lines();
  assert.ok(all.indexOf('## Step 5: Present Options') > all.indexOf('## Step 2: Close the Plan'), 'the options do not follow the close');
});

test('the close has three tracking cases; a repo not opted in, or without triqual, gets the options only', () => {
  const close = section('## Step 2: Close the Plan');
  const notOpted = close.find((l) => l.startsWith('- **Not opted in**'));
  const missing = close.find((l) => l.startsWith('- **`triqual` missing**'));
  assert.ok(close.some((l) => l.startsWith('- **Opted in**')) && notOpted && missing, 'Close the Plan lacks one of the three tracking cases');
  for (const re of [/`"optedIn": false`/, /exit 2/, /no `triqual tasks` command/, /never create `progress\.md`/, /only the options/]) {
    assert.match(notOpted, re, `the not-opted-in case does not say ${re}`);
  }
  for (const re of [/exit 3/, /`PATH`/, /as not opted in/, /once/]) assert.match(missing, re, `the triqual-missing case does not say ${re}`);
  // Every other line that runs triqual tasks or names progress.md is for an opted-in repo.
  const bad = lines()
    .filter((l) => /triqual tasks (check|close)|progress\.md/.test(l))
    .filter((l) => !l.startsWith('- **Not opted in**'))
    .filter((l) => !/\bopted in\b/i.test(l.replace(/not opted in/gi, '')));
  assert.deepEqual(bad, [], 'a triqual tasks command or progress.md rule outside an opted-in instruction');
});

test('the closing entry states the review totals: hunters against the reference, and the tasks per effective tier with how many were raised', () => {
  const entry = block('write a new top entry in `progress`');
  mustHave(entry, ['hunters', 'reference', 'effective tier', 'raised', '`triqual tasks export --json`'], 'the closing entry');
  assert.match(entry, /rulings/i, 'the closing entry does not carry the rulings pointer');
});

// ---- store mode ------------------------------------------------------------------------------------------------------

test('store mode lands the closing entry with tracking add --no-commit and stages no tracking file', () => {
  const rule = block('`"mode": "store"`');
  mustHave(
    rule,
    [
      'no tracking file is staged or committed',
      'an added or modified `progress.md`, `status.md` or `*.tasks.json` is a defect',
      'step 5 has no closing commit to make',
      '`mktemp -d`',
      '`triqual tracking add <draft> --no-commit`',
      '`triqual tracking add <draft>` before it',
      '`triqual tracking status set --section <heading> <draft>`',
      'bare file name',
      'the check takes no plan option',
      '`store-mode.md` under `references` in skill `progress-tracking:progress-tracking`',
    ],
    'the store-mode rule',
  );
  assert.ok(!/--plan <plansDir>/.test(rule.replace(/never by the `plansDir` path/, '')), 'the store-mode rule names the plansDir path as the plan');
});

test('a stack makes no closing commit: its tracking is in the store or local', () => {
  const rule = block('**Stacked plan, no closing commit:**');
  mustHave(rule, ['state file exists', 'step 5', 'closing commit', 'store', 'local', 'never'], 'the no-closing-commit rule');
  assert.match(rule, /(skip|omit)[^.]*step 5/i, 'step 5 is not skipped');
  assert.match(rule, /committed[^.]*stops/i, 'a committed-mode plan with a stack is not stopped');
  assert.ok(section('## Step 2: Close the Plan').some((l) => l.startsWith('**Stacked plan, no closing commit:**')), 'the rule is not in Step 2');
});

test('local mode writes drafts under a private mktemp dir and lands them with tracking write', () => {
  const rule = block('`"mode": "local"`');
  mustHave(rule, ['never staged or committed', '`mktemp -d`', '`triqual tracking write entry <draft>`', '`triqual tracking write status <draft>`'], 'the local-mode rule');
});

// ---- the stack merge flow --------------------------------------------------------------------------------------------

test('every stack.mjs command runs through node, names PLAN_FILE and is one the plan gives', () => {
  const rows = text().split('\n').map((l, i) => [i + 1, l.trim()]).filter(([, l]) => l.includes(STACK_SCRIPT));
  assert.ok(rows.length >= 6, 'the skill runs stack.mjs in too few places');
  for (const [n, l] of rows) {
    const total = l.split(STACK_SCRIPT).length - 1;
    assert.equal(l.split(`node ${STACK_SCRIPT}`).length - 1, total, `line ${n} runs stack.mjs without node: ${l}`);
    assert.match(l, /\b(path|status|mode|submit)\b/, `line ${n} runs stack.mjs with a command the skill does not use: ${l}`);
    assert.match(l, /PLAN_FILE/, `line ${n} runs stack.mjs without PLAN_FILE: ${l}`);
  }
});

test('the script path is explained once: relative to the skill folder, run by its absolute path', () => {
  const rule = block('relative to this skill');
  mustHave(rule, ['absolute path', '`skills/executing-plans/scripts/`'], 'the script-path rule');
});

test('Step 1 runs the suite on the top branch of a stack, and keeps the current rule without a state file', () => {
  const step = section('## Step 1: Verify Tests');
  const rule = block('**Stacked plan:**');
  assert.ok(step.some((l) => l.startsWith('**Stacked plan:**')), 'the stack rule is not inside Step 1');
  mustHave(rule, [`\`${STACK} path PLAN_FILE\``, 'state file', 'the highest `n`', 'top branch', 'the suite'], 'the Step 1 stack rule');
  assert.match(rule, /no state file[^.]*(current|menu below)/i, 'a plan with no state file does not keep the current menu');
  assert.match(rule, /check(s|ing)? out the top branch[^.]*before[^.]*suite|top branch[^.]*then[^.]*suite|on a clean tree, then run the suite/i, 'the suite does not run on the top branch');
});

test('the GitHub stack menu has two options and merge-now never picks the PR or the method', () => {
  const menu = section('## Step 5: Present Options').join('\n');
  const gh = /\*\*Stacked plan, GitHub mode[^\n]*\n+```\n([^]*?)```/.exec(menu);
  assert.ok(gh, 'Step 5 has no GitHub-mode stack menu block');
  const options = gh[1].split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(options.length, 2, `the GitHub menu has ${options.length} options: ${options}`);
  assert.match(options[0], /^1\. Leave the stack open for review/i);
  assert.match(options[1], /^2\. Merge now/i);
  const exec = section('### Stacked plan: GitHub mode').join(' ');
  mustHave(exec, ['the method'], 'the GitHub-mode execution');
  assert.match(exec, /never pick it for them/i, 'nothing forbids choosing the method for the owner');
});

test('merge now runs gh stack merge with no argument on the plan\'s own stack, and never with a bare number', () => {
  const merge = block('**Option 2, merge now:**');
  mustHave(
    merge,
    [
      '`gh stack merge --yes --merge-method <m>`',
      'with no argument',
      'the stack of the current branch',
      'a bare number',
      'first as a stack number',
      'another stack',
      'Never pass a bare number',
      '`git switch <top branch>`',
      '`gh stack view --json`',
      'one of the `pr` values',
      'stop and ask',
    ],
    'the merge-now rule',
  );
  assert.ok(merge.indexOf('`gh stack view --json`') < merge.indexOf('`gh stack merge --yes --merge-method <m>`'), 'the stack is not checked before the merge');
  assert.ok(!/gh stack merge <[^>]*pr[^>]*>/i.test(text()), 'a gh stack merge with a PR placeholder is still in the skill');
  assert.match(merge, /only up to a lower PR[^.]*owner runs/i, 'a partial merge by number is not left to the owner');
});

test('a draft stack cannot be merged: gh stack merge refuses drafts, so merge now needs the owner\'s OK to mark them ready first', () => {
  const merge = block('**Option 2, merge now:**');
  mustHave(merge, ['refuses draft', '`submitted`', `\`${STACK} submit PLAN_FILE <top N> --open\``, 'before the merge'], 'the merge-now rule');
  assert.match(merge, /not (OK|approve)[^.]*stop|stop[^.]*not (OK|approve)/i, 'a refusal to mark ready does not stop the merge');
});

test('the local stack menu has three options: ff-only merge, push as stacked PRs, keep', () => {
  const menu = section('## Step 5: Present Options').join('\n');
  const local = /\*\*Stacked plan, local mode[^\n]*\n+```\n([^]*?)```/.exec(menu);
  assert.ok(local, 'Step 5 has no local-mode stack menu block');
  const options = local[1].split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(options.length, 3, `the local menu has ${options.length} options: ${options}`);
  assert.match(options[0], /^1\. Merge the stack into <trunk> locally/i);
  assert.match(options[1], /^2\. Push and open it as stacked PRs/i);
  assert.match(options[2], /^3\. Keep as is/i);
  mustHave(section('### Stacked plan: local mode').join(' '), ['`git -C <MAIN_ROOT> merge --ff-only <top branch>`', 'the suite'], 'the local merge');
  const push = block(`\`${STACK} mode PLAN_FILE github\``);
  mustHave(push, [`\`${STACK} submit PLAN_FILE <N>\``, 'each phase still `done`, in order', 'already `submitted`', '`--open`'], 'the push option');
  const at = (needle) => push.indexOf(needle);
  assert.ok(at(' mode PLAN_FILE github') < at(' submit PLAN_FILE <N>`') && at(' submit PLAN_FILE <N>`') < at('`--open`'), 'mode, submit per phase and --open are out of order');
});

test('the menu without a state file stays the 3-option one', () => {
  const menu = section('## Step 5: Present Options').join('\n');
  mustHave(menu, ['Merge back to <base-branch> locally', 'Push and create a Pull Request', 'Keep the branch as-is'], 'Step 5');
  assert.match(menu, /no state file[^]*current/i, 'Step 5 does not keep the current menu for a plan with no state file');
});

test('an unlinked stack is named before gh stack merge is offered', () => {
  const rule = block('**Stack link check (GitHub mode):**');
  mustHave(rule, ['; stack link missing', 'say so', 'before offering `gh stack merge`', 'cannot be merged atomically'], 'the stack link check');
  assert.ok(section('## Step 5: Present Options').join('\n').includes('**Stack link check (GitHub mode):**'), 'the stack link check is not in Step 5');
});

test('a stack still in draft is reported as draft: the ready decision is the owner\'s', () => {
  const rule = block('**Draft stack:**');
  mustHave(rule, [`\`${STACK} status PLAN_FILE\``, `\`${STACK} submit PLAN_FILE <top N> --open\``, '`submitted`', 'draft', 'never mark', 'refuses draft'], 'the draft-stack rule');
  // Two causes keep a phase `submitted`, and the rule names both.
  assert.match(rule, /residual Critical or Important findings/, 'the draft-stack rule does not name the findings that keep a stack draft');
  assert.match(rule, /`submit[^`]*--open` that failed[^.]*exit 5/, 'the draft-stack rule does not name a failed --open (exit 5) as the other cause');
  assert.match(rule, /say which/i, 'the draft-stack rule does not tell the owner which cause applies');
  assert.ok(section('## Step 5: Present Options').join('\n').includes('**Draft stack:**'), 'the draft-stack rule is not in Step 5');
});

test('a full merge runs the After Merge checklist and then prunes and deletes the state; a partial merge refreshes the state and runs nothing', () => {
  const after = section('### After a stack merge').join(' ');
  mustHave(after, ['status PLAN_FILE', 'the top phase', '`merged`', '`## After Merge`', '`gh stack sync --prune`', 'delete the merged phase branches', 'STACK_STATE', 'state file'], 'After a stack merge');
  const full = block('**Full merge**');
  mustHave(full, ['the top phase', '`merged`', 'After Merge', '`gh stack sync --prune`', 'delete', 'state file'], 'the full-merge rule');
  assert.ok(full.indexOf('After Merge') < full.indexOf('`gh stack sync --prune`') && full.indexOf('`gh stack sync --prune`') < full.lastIndexOf('state file'), 'the full-merge steps are out of order');
  const partial = block('**Partial merge**');
  mustHave(partial, ['status PLAN_FILE', 'refresh', 'runs nothing', 'the state file stays'], 'the partial-merge rule');
  assert.match(partial, /below the top phase|short of the top phase|not the top phase/i, 'the partial merge is not defined against the top phase');
});

test('a local fast-forward is a full merge: the state never records merged in local mode, so no rule may wait for it', () => {
  const partial = block('**Partial merge**');
  mustHave(partial, ['GitHub mode only', 'local fast-forward', 'never a partial merge', 'only in GitHub mode'], 'the partial-merge rule');
  const full = block('**Full merge**');
  mustHave(full, ['a local fast-forward merge is always full', 'only in GitHub mode'], 'the full-merge rule');
  const row = lines().find((l) => l.startsWith('| "The stack\'s PRs merged, so the After Merge checklist can run"'));
  assert.ok(row, 'the After Merge rationalization row is gone');
  mustHave(row, ['in GitHub mode', 'local fast-forward', 'always a full merge'], 'the After Merge rationalization row');
});

test('the draft rationalization row names both causes of a draft', () => {
  const row = lines().find((l) => l.startsWith('| "The stack\'s PRs are open'));
  assert.ok(row, 'the draft rationalization row is gone');
  mustHave(row, ['residual findings', 'failed `--open`'], 'the draft row');
});

test('a full merge brings the main checkout to the merged trunk before the After Merge checklist', () => {
  const full = block('**Full merge**');
  const order = [
    'git -C <MAIN_ROOT> status --porcelain --untracked-files=no',
    'git -C <MAIN_ROOT> fetch <remote>',
    'git -C <MAIN_ROOT> checkout <trunk>',
    'git -C <MAIN_ROOT> merge --ff-only <remote>/<trunk>',
    '`## After Merge`',
    '`gh stack sync --prune`',
  ];
  order.reduce((prev, needle) => {
    const i = full.indexOf(needle);
    assert.ok(i > prev, `${needle} is missing or out of order in the full-merge rule: ${full}`);
    return i;
  }, -1);
  assert.match(full, /require a clean tree/i, 'a clean tree is not required');
  assert.match(full, /refused, stop and report[^.]*nothing after it runs/i, 'a refused step does not stop the checklist');
});

test('the state file path is captured in Step 3 and deleted from that value, never resolved again', () => {
  const step3 = text().slice(text().indexOf('## Step 3: Detect Environment'), text().indexOf('## Step 4: Determine Base Branch'));
  assert.ok(step3.includes(`${STACK} path PLAN_FILE`), 'Step 3 does not run stack.mjs path');
  assert.ok(step3.indexOf('STACK_STATE') > step3.indexOf(`${STACK} path PLAN_FILE`), 'Step 3 does not name that output STACK_STATE');
  mustHave(block('may stop short of the top'), [`\`${STACK} status PLAN_FILE\``, 'never from `MAIN_ROOT`'], 'the status read');
  // The deletion uses the value captured in Step 3, as an absolute path, and says so: the worktree may be gone by then.
  const full = block('**Full merge**');
  mustHave(full, ['delete the state file at the path captured in Step 3', '`rm -f <STACK_STATE>`', 'an absolute path', 'never resolve it again'], 'the state deletion');
  assert.ok(full.indexOf('`rm -f <STACK_STATE>`') > full.indexOf('Then clean up the worktree (Step 7'), 'the state file is deleted before the cleanup it must survive');
  assert.ok(!/rm -f "\$/.test(text()), 'the state file is resolved from a shell variable');
});

// ---- the checklist, the ledger vocabulary ----------------------------------------------------------------------------

test('a stack always carries the After Merge checklist in the closing entry and status Next; a merge that runs it adds a second entry', () => {
  const rule = block('**Stacked plan, After Merge checklist:**');
  mustHave(rule, ['`## After Merge`', 'closing progress entry', 'status `Next`', 'each operation with its command', 'to run once merged', 'always', 'second progress entry'], 'the checklist rule');
  assert.match(rule, /opted in/, 'the checklist rule does not say what a repo not opted in does');
  assert.match(rule, /final message/, 'a repo not opted in has no place for the checklist');
  assert.ok(section('## Step 2: Close the Plan').some((l) => l.startsWith('**Stacked plan, After Merge checklist:**')), 'the rule is not in Step 2');
  mustHave(block('are not tasks'), ['After Merge', 'never reach the task ledger'], 'the After Merge rule');
  const full = block('**Full merge**');
  assert.ok(full.indexOf('`## After Merge`') < full.indexOf('second progress entry'), 'the second entry comes before the checklist ran');
});

test('a full merge refreshes the status section that named the checklist, so Next lists only what is still pending', () => {
  const full = block('**Full merge**');
  mustHave(full, ['refresh', 'status `Next`', '`triqual tracking status set --section <heading> <draft>`', '`triqual tracking write status <draft>`', 'store', 'local', 'still pending', 'final message'], 'the full-merge status refresh');
  assert.ok(full.indexOf('second progress entry') < full.indexOf('Last, refresh'), 'the status refresh comes before the second entry');
  assert.match(full, /failing operation[^;)]*(it and every operation after it|the failed operation and the rest)[^;)]*(stay|remain) pending/i, 'a failing operation does not leave the failed one and the rest pending');
  assert.match(full, /not opted in[^.]*final message/i, 'a repo not opted in does not get the status in the final message');
});

test('the stack link and the draft state are read from the ledger vocabulary the orchestrator writes', () => {
  const rule = block('**Stack link check (GitHub mode):**');
  mustHave(rule, ['`Phase <N>: submitted`', '`ready`'], 'the stack link check');
});

// ---- MAIN_ROOT and the session move ----------------------------------------------------------------------------------

test('git reaches the main checkout with -C and no cd or shell variable stands for a captured value', () => {
  const all = text();
  assert.ok(!/\bcd\b/.test(all), 'a cd is in the skill');
  assert.ok(!all.includes('$WORKTREE_PATH') && !all.includes('$MAIN_ROOT') && !all.includes('$STACK_STATE'), 'a shell variable stands for a captured value');
  const full = block('**Full merge**');
  mustHave(full, ['git -C <MAIN_ROOT>', 'Step 7'], 'the full-merge rule');
  assert.ok(full.indexOf('git -C <MAIN_ROOT>') < full.indexOf('Step 7'), 'the main checkout is reached after the cleanup');
});

test('MAIN_ROOT is the parent of the shared git dir, noted once and used by every later command', () => {
  const option1 = text().slice(text().indexOf('### Option 1: Merge Locally'), text().indexOf('### Option 2: Push and Create PR'));
  mustHave(option1, ['git -C <GIT_COMMON>/.. rev-parse --show-toplevel', '`MAIN_ROOT`', 'git -C <MAIN_ROOT> checkout <base-branch>', 'git -C <MAIN_ROOT> merge <feature-branch>'], 'Option 1');
  mustHave(option1, ['npm test --prefix <MAIN_ROOT>', 'go test -C <MAIN_ROOT> ./...'], 'the merged-result test command');
  assert.match(option1, /never chained behind a directory change/, 'the test command may be chained behind a directory change');
});

test('the session moves to MAIN_ROOT before a worktree is removed, and nothing after relies on the removed directory', () => {
  const all = text();
  const step7 = all.slice(all.indexOf('## Step 7: Cleanup Workspace'), all.indexOf('## Quick Reference'));
  const move = step7.indexOf('move the session to `<MAIN_ROOT>`');
  const remove = step7.indexOf('git -C <MAIN_ROOT> worktree remove <WORKTREE_PATH>');
  assert.ok(move >= 0, 'Step 7 does not move the session to MAIN_ROOT');
  assert.ok(remove > move, 'the worktree is removed before the session moves to MAIN_ROOT');
  mustHave(block('**Before any removal, move the session to `<MAIN_ROOT>`**'), ['directory tool', 'as a step of its own', 'never chained to a command', 'run every command after the removal from `<MAIN_ROOT>`'], 'the move step');
  const full = block('**Full merge**');
  const afterClean = full.slice(full.indexOf('Then clean up the worktree (Step 7'));
  mustHave(afterClean, ['every command from here on runs from `<MAIN_ROOT>`', '`rm -f <STACK_STATE>`'], 'the full-merge cleanup tail');
  assert.ok(!/node \.\.\/|<WORKTREE_PATH>/.test(afterClean), 'a command after the cleanup uses the removed worktree or a path relative to it');
  assert.ok(!/`git (?!-C <MAIN_ROOT>)[a-z]/.test(afterClean), 'a git command after the cleanup runs without -C <MAIN_ROOT>');
  const option1 = all.slice(all.indexOf('### Option 1: Merge Locally'), all.indexOf('### Option 2: Push and Create PR'));
  const afterOption1 = option1.slice(option1.indexOf('clean up the worktree (Step 7)'));
  mustHave(afterOption1, ['git -C <MAIN_ROOT> branch -d <feature-branch>'], 'the Option 1 branch delete');
});

test('no step says the session\'s directory never changes: Step 7 moves it', () => {
  const all = text();
  assert.ok(!/session'?s directory never changes/i.test(all), 'a step still says the session directory never changes');
  assert.ok(!/nothing here changes the session'?s directory/i.test(all), 'Step 3 still says nothing changes the session directory');
  const step3 = all.slice(all.indexOf('## Step 3: Detect Environment'), all.indexOf('## Step 4: Determine Base Branch'));
  mustHave(step3, ['Step 7'], 'Step 3');
  assert.match(step3, /session[^.]*(stays|remains)[^.]*until Step 7/i, 'Step 3 does not say where the session stays until Step 7');
});

test('removal of a worktree is limited to the ones this session owns, and --force is never used on own initiative', () => {
  const step7 = section('## Step 7: Cleanup Workspace').join(' ');
  mustHave(step7, ['`.worktrees/`', '`worktrees/`', 'Never `--force` on your own initiative', '`ExitWorktree`'], 'Step 7');
  mustHave(text(), ['Type \'discard\' to confirm.'], 'the discard confirmation');
});
