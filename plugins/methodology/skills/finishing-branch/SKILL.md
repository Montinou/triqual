---
name: finishing-branch
description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work
---

# Finishing a Development Branch

## Overview

**Core principle:** Verify tests → Close the plan → Detect environment → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the finishing-branch skill to complete this work."

## Step 1: Verify Tests

**Stacked plan:** first find out whether the plan ran as a stack. Run `node ../subagent-driven-development/scripts/stack.mjs path PLAN_FILE`, with PLAN_FILE the plan just executed: it prints the path of the stack's state file, `<repo root>/.methodology/stack/<plan file stem>.json`. When that file exists, the plan is a stack of phase branches: read the phases from `node ../subagent-driven-development/scripts/stack.mjs status PLAN_FILE`, take the phase with the highest `n` (the top phase), check out the top branch (that phase's `branch`) on a clean tree, then run the suite there; the top branch holds every phase's commits, so a suite run on a lower phase proves less than the whole. With no state file, the current menu below applies unchanged (a plan run before stacked execution) and the suite runs on the current branch.

Run the project's full test suite (`npm test` / `cargo test` / `pytest` / `go test ./...`).

**If tests fail**, report the failures and stop — the menu comes after a green suite:

```
Tests failing (<N> failures). Must fix before completing:

[Show failures]
```

**If tests pass:** continue to Step 2.

## Step 2: Close the Plan

The plan's task ledger closes before the branch is integrated, in one
closing commit. Run `triqual tasks paths --json` first:
- **Opted in** (`"optedIn": true`; an older `triqual` prints the same fields without `optedIn`): run the steps below, in order, with the `progress` and `status` paths and `plansDir` it prints.
- **Not opted in** (`"optedIn": false`, or exit 2 from an older progress-tracking): skip this step: run no `triqual tasks` command, never create `progress.md` (creating it opts the repo in and commits a personal log into a shared repo), and offer only the options (Step 5).
- **`triqual` missing** (exit 3, or `triqual` not on `PATH`): handle it as not opted in, and say so once.

1. **Check (opted in):** run `triqual tasks check`. Exit 1 means the task ledger drifted from the plan or from `status.md`: report the drift it prints and stop here, before the close; fix it (or rule on it with your human partner) and rerun.
2. **Close (opted in):** run `triqual tasks close` (with `--plan <plansDir>/<plan>.md` when more than one plan is active). It refuses while a task is unfinished: report the tasks it names and stop.
3. **Closing entry (opted in):** write a new top entry in `progress` (`progress.md`), in the entry format the repo's CLAUDE.md gives, with Stage/task `Plan <topic> · close`: what the plan delivered, its commits, the final verification and what comes next.
4. **Roadmap (opted in):** update the roadmap in `status` (`status.md`): mark the plan's roadmap row or line done (with the date) and name the next step, editing around the tasks markers, never inside them, and never rewriting the file.
5. **Closing commit (opted in, `"mode": "committed"`):** one commit that stages `progress.md`, `status.md` and the dirty task ledger (the plan's `*.tasks.json`, which carries the pending ledger bookkeeping from the last task's moves and the close); the repo's pre-commit rejects a commit without them. Never `--no-verify`.

When opted in with `"mode": "local"`, `progress.md`, `status.md` and the task ledger live under the git dir and are never staged or committed; never write or edit under `.git/` with the file tools. Make a private draft dir in the OS temp dir (`d=$(mktemp -d)`: other sessions share the temp dir), write the closing entry there as a draft (`$d/entry.md`) and land it with `triqual tracking write entry <draft>`; for the roadmap, copy `status` to a draft there (`$d/status.md`), edit the draft, and land it with `triqual tracking write status <draft>` (it keeps the tasks section).

When opted in with `"mode": "store"` (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`), the tracking lives in the store, so no tracking file is staged or committed (an added or modified `progress.md`, `status.md` or `*.tasks.json` is a defect) and step 5 has no closing commit to make. Name the plan in the close by its bare file name (`--plan <plan file name>`), never by the `plansDir` path; the check takes no plan option. Make a private draft dir (`d=$(mktemp -d)`), write the closing entry there as a draft (`$d/entry.md`) and land it with `triqual tracking add <draft> --no-commit`; if you do make a closing commit, land the entry with `triqual tracking add <draft>` before it instead. For the roadmap, read `triqual tracking status`, write the section's body as a draft (`$d/status.md`) and land it with `triqual tracking status set --section <heading> <draft>`; the whole-file `status set` is only for a full rewrite.

**Stacked plan, no closing commit:** when the state file exists, skip step 5: a stack never runs in committed mode, which stack init stops, so its tracking is in the store or local, and neither has a file to stage or a closing commit to make. Never make one for a stack.

**Stacked plan, After Merge checklist:** when the state file exists, the closing progress entry (step 3, opted in) always carries the plan's `## After Merge` checklist, each operation with its command, marked "to run once merged", and the roadmap's status `Next` (step 4, opted in) names it, so the owner can run it once the stack merges; a repo that is not opted in has no entry, so put the checklist in your final message instead. When a full merge happens in this session and the checklist runs (Step 6, "After a stack merge"), a second progress entry records that it ran.

After Merge operations are not tasks: they never reach the task ledger, so the close is unaffected, and you add no task for them. A full merge in this session runs them (Step 6, "After a stack merge").

## Step 3: Detect Environment

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
# Capture now, while still inside the workspace — Step 6 changes directory
# before cleanup (Step 7) needs this value
WORKTREE_PATH=$(git rev-parse --show-toplevel)
# Stacked plan: the state file lives in this checkout (where stack init ran);
# capture its path now, before any directory change
STACK_STATE=$(node ../subagent-driven-development/scripts/stack.mjs path PLAN_FILE)
```

This determines which menu to show and how cleanup works:

| State | Menu | Cleanup |
|-------|------|---------|
| `GIT_DIR == GIT_COMMON` (normal repo) | Standard 3 options | No worktree to clean up |
| `GIT_DIR != GIT_COMMON`, named branch | Standard 3 options | Provenance-based (see Step 7) |
| `GIT_DIR != GIT_COMMON`, detached HEAD | Reduced 2 options (no merge) | Externally managed — leave in place |

A stack's state file (Step 1) replaces the standard 3 options with the stack menu for its mode (Step 5); the worktree rules in the Cleanup column apply unchanged.

## Step 4: Determine Base Branch

The base branch is whatever this work forked from — usually named in the
plan, the conversation, or the branch's upstream. If it is not already
known, ask: "This branch split from <your best guess> - is that correct?"
Confirm before merging: merging into the wrong base is expensive to undo.

## Step 5: Present Options

**Normal repo and named-branch worktree — present exactly these 3 options:**

```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)

Which option?
```

**Detached HEAD — present exactly these 2 options:**

```
Implementation complete. You're on a detached HEAD (externally managed workspace).

1. Push as new branch and create a Pull Request
2. Keep as-is (I'll handle it later)

Which option?
```

**Stack menus:** when the state file exists, present one of the two menus below, chosen by the `mode` in `node ../subagent-driven-development/scripts/stack.mjs status PLAN_FILE`, in place of the 3 or 2 options above; with no state file, the current menu above stays.

**Stack link check (GitHub mode):** when the workspace ledger's `Phase <N>: submitted` or `ready` lines, or the latest `submit` output, end `; stack link missing`, the PRs are not linked as a stack on GitHub: say so when you present the menu and before offering `gh stack merge`, because an unlinked stack cannot be merged atomically (the owner links it, or merges the PRs one at a time, bottom first).

**Stacked plan, GitHub mode — present exactly these 2 options:**

```
Implementation complete. The stack's PRs are ready for review. What would you like to do?

1. Leave the stack open for review (the PRs are ready)
2. Merge now (you name the top PR to merge up to, and the method)

Which option?
```

**Stacked plan, local mode — present exactly these 3 options:**

```
Implementation complete. The stack is local branches. What would you like to do?

1. Merge the stack into <trunk> locally
2. Push and open it as stacked PRs
3. Keep as is (I'll handle it later)

Which option?
```

Present the menu exactly as written — concise, with every option coming
from the list above. Discarding the work happens only in response to your
human partner explicitly asking for it (see "If your human partner asks to
discard the work" below). Wait for their answer; the integration decision
is theirs.

## Step 6: Execute Choice

### Option 1: Merge Locally

```bash
# Get main repo root for CWD safety
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"

# Merge first — verify success before removing anything
git checkout <base-branch>
git pull
git merge <feature-branch>

# Verify tests on merged result
<test command>
```

If tests fail on the merged result: stop, leave the worktree and branch in
place, and investigate — nothing has been pushed, so the merge is local
and recoverable.

Once the merged result is green: clean up the worktree (Step 7), then
delete the branch:

```bash
git branch -d <feature-branch>
```

### Option 2: Push and Create PR

```bash
git push -u origin <feature-branch>
# From a detached HEAD, name the new branch on the remote:
# git push origin HEAD:refs/heads/<new-branch>
```

Then create the pull/merge request against <base-branch> with the forge's
tooling — its CLI if one is available, or the creation URL most forges
print when you push — following the repo's PR template and conventions if
present, and report the URL to your human partner.

Keep the worktree — your human partner iterates on PR feedback there.

### Option 3: Keep As-Is

Report: "Keeping branch <name>. Worktree preserved at <path>."

### Stacked plan: GitHub mode

**Option 1, leave the stack open:** report "Leaving the stack open: its PRs are ready for review. Worktree preserved at <path>." The state file stays; the After Merge checklist stays in the closing entry and status `Next` (Step 2).

**Option 2, merge now:** ask the owner to name the top PR to merge up to and the method (the `<m>` below); never pick the PR or the method for them. Then run `gh stack merge <pr> --yes --merge-method <m>`, and go to "After a stack merge" below.

### Stacked plan: local mode

**Option 1, merge the stack locally:** from the main repo root (the `MAIN_ROOT` of Option 1 above), `git checkout <trunk>` (the `trunk` in the state, read from the stack's checkout before the directory change), then `git merge --ff-only <top branch>`, then run the suite on the merged result. If the fast-forward is refused (the trunk moved), stop: nothing is merged and nothing is pushed; report it. If the suite fails, stop and investigate with the worktree and branches in place. Once it is green, go to "After a stack merge" below.

**Option 2, push and open as stacked PRs:** run `node ../subagent-driven-development/scripts/stack.mjs mode PLAN_FILE github` (exit 3 names the check that failed: report it and stop, nothing is pushed), then `node ../subagent-driven-development/scripts/stack.mjs submit PLAN_FILE <N>` for each phase still `done`, in order, from the lowest `n` to the top one (after a mid-run fallback to local mode, the earlier phases are already `submitted` and `submit` refuses them, exit 3), then mark the PRs ready with `--open`: `node ../subagent-driven-development/scripts/stack.mjs submit PLAN_FILE <top N> --open`. Your human partner's choice authorizes the push of this plan's phase branches and the draft PRs. Keep the worktree, report the PR numbers it prints, and leave the state file; the After Merge checklist stays in the closing entry and status `Next` (Step 2).

**Option 3, keep as is:** report "Keeping the stack as local branches. Worktree preserved at <path>." The state file stays.

### After a stack merge

Read the status first, from the checkout where the stack lives, never from `MAIN_ROOT` (the state file is in the checkout where `stack.mjs init` ran, so `status` there is the only one that finds it): `(cd "$WORKTREE_PATH" && node ../subagent-driven-development/scripts/stack.mjs status PLAN_FILE)`. GitHub mode refreshes each phase's PR state from the forge, and a phase whose PR merged is `merged`. A merge with `gh stack merge <pr>` may stop short of the top, so what happens next depends on the top phase.

**Full merge** (the top phase is `merged`; a local fast-forward merge is always full): change to the main repo root first (`cd "$MAIN_ROOT"`, the `MAIN_ROOT` of Option 1 above; a local merge is already there, a GitHub merge is not). In GitHub mode that checkout holds whatever was left in it (a phase branch, an old trunk), so bring it to the merged trunk before anything runs: require a clean tree (`git status --porcelain --untracked-files=no` prints nothing), then `git fetch <remote>`, `git checkout <trunk>` and `git merge --ff-only <remote>/<trunk>`, with the `remote` and `trunk` of the status output above; if any of these is refused, stop and report it, and nothing after it runs (the checklist would run on stale code). Then run the plan's `## After Merge` checklist in order, each operation with its command, and report each result (a failing operation stops the list: it and every operation after it stay pending, and the status refresh below names only them; an operation that needs the trunk pushed waits for your human partner, pushing stays theirs). Then clean up the worktree (Step 7), then `gh stack sync --prune` (GitHub mode, from the main repo root) or delete the merged phase branches with `git branch -d <branch>` for every phase (local mode). The phases count as `merged`: `status` reports it in GitHub mode and the fast-forward made it so in local mode. Last, delete the state file at the path captured in Step 3: `rm -f "$STACK_STATE"` (never resolve it again from here: the directory changed, and the cleanup may have removed the worktree that held it). Then write a second progress entry (opted in; land it the way step 3 does for the repo's mode, with no commit after it) naming the merge and the checklist's results. Last, refresh the status section that named the checklist (status `Next`, step 4), so it no longer tells the owner or the next session to run what already ran: it names only the operations still pending (the failed one and the rest, when one failed) or says the checklist ran. In store mode read `triqual tracking status`, write the section's body as a draft and land it with `triqual tracking status set --section <heading> <draft>`; in local mode copy `status` to a draft in a private `mktemp -d` dir and land it with `triqual tracking write status <draft>` (a stack never runs in committed mode). Not opted in: say which operations are still pending, or that the checklist ran, in the final message.

**Partial merge** (the top phase is not `merged`: the merge stopped below the top phase): run `(cd "$WORKTREE_PATH" && node ../subagent-driven-development/scripts/stack.mjs status PLAN_FILE)` to refresh the state; this runs nothing else: no After Merge operation, no prune, no branch deleted, and the state file stays. The checklist stays in the closing entry and status `Next` (Step 2); name the remaining phases in your final message.

### If your human partner asks to discard the work

This path exists only as a response to an explicit request to throw the
work away. Confirm first:

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>

Type 'discard' to confirm.
```

Wait for that exact confirmation. When it arrives:

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
```

Then clean up the worktree (Step 7) and force-delete the branch:

```bash
git branch -D <feature-branch>
```

## Step 7: Cleanup Workspace

**Runs for Option 1, a full stack merge and confirmed discards.** Options 2 and 3
always preserve the worktree, and so do a stack's other options and a partial merge. Both callers have already changed directory to the
main repo root — worktree removal must run from outside the worktree —
and use the `GIT_DIR`/`GIT_COMMON`/`WORKTREE_PATH` values captured in
Step 3, from before that directory change.

**If `GIT_DIR == GIT_COMMON`:** Normal repo, no worktree to clean up. Done.

**If `WORKTREE_PATH` is under `.worktrees/` or `worktrees/`:**
methodology:using-git-worktrees created this worktree — we own cleanup:

```bash
git worktree remove "$WORKTREE_PATH"
git worktree prune  # Self-healing: clean up any stale registrations
```

**If removal is refused** (`contains modified or untracked files`): the
worktree holds files that exist nowhere else — uncommitted plans, notes,
or scratch work. Never `--force` on your own initiative. Show your human
partner what is at stake and ask:

```bash
git -C "$WORKTREE_PATH" status --porcelain -uall
```

```
Worktree removal refused — these files were never committed:

<file list>

1. Commit them to <branch> before cleanup
2. Move them into <main repo root>
3. Delete them (unrecoverable)

Which?
```

Carry out the choice, then remove the worktree.

**Otherwise:** The host environment owns this workspace — leave it in
place. If your platform provides a workspace-exit tool, use it.

## Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|--------|-------|------|---------------|----------------|
| 1. Merge locally | yes | - | - | yes |
| 2. Create PR | - | yes | yes | - |
| 3. Keep as-is | - | - | yes | - |
| Discard (explicit request only) | - | - | - | yes (force) |

| Stack option | Merge | Push | Keep Worktree | Cleanup |
|--------------|-------|------|---------------|---------|
| GitHub 1. Leave open | - | - | yes | - |
| GitHub 2. Merge now | `gh stack merge` | - | only if partial | full: `gh stack sync --prune`, state file |
| Local 1. Merge locally | `--ff-only` | - | no | phase branches, state file |
| Local 2. Open as PRs | - | yes | yes | - |
| Local 3. Keep as is | - | - | yes | - |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Tests passed earlier this session" | Run the suite on the tree you are about to integrate. A green run only proves the tree it ran on. |
| "They obviously want it merged" | Integration is your human partner's decision. Present the menu and wait. |
| "They seem done with this feature — I'll offer to discard it" | The menu is complete as written. Discard happens only when your human partner asks for it in so many words. |
| "'Yeah, get rid of it' counts as confirmation" | Only the typed word `discard` authorizes deletion. |
| "The PR is up, so the worktree is clutter now" | PR feedback gets fixed in that worktree. It stays until the work lands. |
| "This other worktree looks stale — I'll clean it too" | Clean up only worktrees under `.worktrees/` or `worktrees/`. Everything else belongs to the host. |
| "Removal refused — `--force` is just finishing the cleanup" | The refusal means files exist only in that worktree. `--force` destroys them permanently. Show your human partner and ask. |
| "The merged-result failure is probably flaky" | A failing merged result stops everything. Branch and worktree stay put while you investigate. |
| "The base branch is obviously main" | Confirm the fork point or ask. Merging into the wrong base is expensive to undo. |
| "The push was rejected — force-push will fix it" | A rejected push means the remote moved. Investigate; force-push only on your human partner's explicit request. |
| "`triqual tasks check` found drift (the repo is opted in), but the tests pass — close anyway" | Drift means the ledger, the plan and `status.md` disagree. Report it and fix it before the close; a closed ledger records the drift for good. |
| "The stack's PRs merged, so the After Merge checklist can run" | Only when the top phase is `merged`. A partial merge runs nothing: the owner merges the rest and runs the checklist from the entry and `Next`. |
| "A stack needs a closing commit like any plan" | Stacked execution is store or local mode: no tracking file exists to stage, so there is no closing commit. |
| "The ledger bookkeeping can ride on the merge" | The closing commit carries it, with the closing entry, before any option runs. The pre-commit rejects a commit without the tracking files. |

Forked from superpowers 6.4.2 (skills/finishing-a-development-branch), MIT © Jesse Vincent — see LICENSE-superpowers.
