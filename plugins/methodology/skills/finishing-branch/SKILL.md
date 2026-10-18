---
name: finishing-branch
description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work
---

# Finishing a Development Branch

## Overview

**Core principle:** Verify tests → Close the plan → Detect environment → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the finishing-branch skill to complete this work."

## Step 1: Verify Tests

**Scripts:** every stack command in this skill is `node ../executing-plans/scripts/stack.mjs <command> PLAN_FILE` (the commands are `path`, `status`, `mode` and `submit`), with PLAN_FILE the path of the plan just executed. The path is relative to this skill's folder: run it by its absolute path under the plugin's `skills/executing-plans/scripts/`. The script is not executable, so every call goes through `node`.

**Stacked plan:** first find out whether the plan ran as a stack. Run `node ../executing-plans/scripts/stack.mjs path PLAN_FILE`, with PLAN_FILE the plan just executed: it prints the path of the stack's state file, `<repo root>/.methodology/stack/<plan file stem>.json`. When that file exists, the plan is a stack of phase branches: read the phases from `node ../executing-plans/scripts/stack.mjs status PLAN_FILE`, take the phase with the highest `n` (the top phase), check out the top branch (that phase's `branch`) on a clean tree, then run the suite there; the top branch holds every phase's commits, so a suite run on a lower phase proves less than the whole. With no state file, the current menu below applies unchanged (a plan run before stacked execution) and the suite runs on the current branch.

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
3. **Closing entry (opted in):** write a new top entry in `progress` (`progress.md`), in the entry format the repo's CLAUDE.md gives, with Stage/task `Plan <topic> · close`: what the plan delivered, its commits, the final verification and what comes next, plus the review totals executing-plans computed in its Finish before it deleted the workspace (hunters sent against the matrix's reference; tasks per effective tier and how many were raised) and a pointer to the "Rulings I made" it listed. A session that no longer has the totals reads each task's `tier` against its `effectiveTier` in `triqual tasks export --json` and leaves the hunter count out rather than guess.
4. **Roadmap (opted in):** update the roadmap in `status` (`status.md`): mark the plan's roadmap row or line done (with the date) and name the next step, editing around the tasks markers, never inside them, and never rewriting the file.
5. **Closing commit (opted in, `"mode": "committed"`):** one commit that stages `progress.md`, `status.md` and the dirty task ledger (the plan's `*.tasks.json`, which carries the pending ledger bookkeeping from the last task's moves and the close); the repo's pre-commit rejects a commit without them. Never `--no-verify`.

When opted in with `"mode": "local"`, `progress.md`, `status.md` and the task ledger live under the git dir and are never staged or committed; never write or edit under `.git/` with the file tools. Make a private draft dir in the OS temp dir (run `mktemp -d`; the directory it prints is `$d` below: other sessions share the temp dir), write the closing entry there as a draft (`$d/entry.md`) and land it with `triqual tracking write entry <draft>`; for the roadmap, copy `status` to a draft there (`$d/status.md`), edit the draft, and land it with `triqual tracking write status <draft>` (it keeps the tasks section).

When opted in with `"mode": "store"` (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`), the tracking lives in the store, so no tracking file is staged or committed (an added or modified `progress.md`, `status.md` or `*.tasks.json` is a defect) and step 5 has no closing commit to make. Name the plan in the close by its bare file name (`--plan <plan file name>`), never by the `plansDir` path; the check takes no plan option. Make a private draft dir (run `mktemp -d`; the directory it prints is `$d` below), write the closing entry there as a draft (`$d/entry.md`) and land it with `triqual tracking add <draft> --no-commit`; if you do make a closing commit, land the entry with `triqual tracking add <draft>` before it instead. For the roadmap, read `triqual tracking status`, write the section's body as a draft (`$d/status.md`) and land it with `triqual tracking status set --section <heading> <draft>`; the whole-file `status set` is only for a full rewrite.

**Stacked plan, no closing commit:** when the state file exists, skip step 5: a stack never runs in committed mode, which stack init stops, so its tracking is in the store or local, and neither has a file to stage or a closing commit to make. Never make one for a stack.

**Stacked plan, After Merge checklist:** when the state file exists, the closing progress entry (step 3, opted in) always carries the plan's `## After Merge` checklist, each operation with its command, marked "to run once merged", and the roadmap's status `Next` (step 4, opted in) names it, so the owner can run it once the stack merges; a repo that is not opted in has no entry, so put the checklist in your final message instead. When a full merge happens in this session and the checklist runs (Step 6, "After a stack merge"), a second progress entry records that it ran.

After Merge operations are not tasks: they never reach the task ledger, so the close is unaffected, and you add no task for them. A full merge in this session runs them (Step 6, "After a stack merge").

## Step 3: Detect Environment

```bash
git rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel
node ../executing-plans/scripts/stack.mjs path PLAN_FILE
```

Each is a plain command on its own: run it, then note what it prints. The first prints three lines, in order: `GIT_DIR`, `GIT_COMMON` and `WORKTREE_PATH`. The second (a stacked plan: the state file lives in this checkout, where `stack.mjs init` ran) prints `STACK_STATE`, the state file's path. Note all four now, while you are inside the workspace: Step 6 and Step 7 use them as plain values. The session stays in this checkout until Step 7 moves it to `<MAIN_ROOT>`, just before a worktree is removed, so `stack.mjs` keeps finding the state file; until then git reaches the main checkout with `git -C <MAIN_ROOT>`.

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

**Stack menus:** when the state file exists, present one of the two menus below, chosen by the `mode` in `node ../executing-plans/scripts/stack.mjs status PLAN_FILE`, in place of the 3 or 2 options above; with no state file, the current menu above stays.

**Stack link check (GitHub mode):** when the workspace ledger's `Phase <N>: submitted` or `ready` lines (the workspace is deleted at executing-plans' Finish, so then the final message's copy of them), or the latest `submit` output, end `; stack link missing`, the PRs are not linked as a stack on GitHub: say so when you present the menu and before offering `gh stack merge`, because an unlinked stack cannot be merged atomically (the owner links it, or merges the PRs one at a time, bottom first).

**Draft stack:** when `node ../executing-plans/scripts/stack.mjs status PLAN_FILE` shows a GitHub-mode phase still `submitted`, its PR is a draft, and `gh stack merge` refuses draft PRs. Two things leave a phase `submitted`: the final review left residual Critical or Important findings (executing-plans then pushed the fix commit without marking anything ready), or a `submit … --open` that failed (exit 5) after a clean review. Say which when you present the menu: list the findings from the closing entry or the final message, or name the failed `--open`. You never mark the PRs ready or merge on your own: marking them ready is `node ../executing-plans/scripts/stack.mjs submit PLAN_FILE <top N> --open`, and only your human partner's answer authorizes it; "Merge now" needs that answer first.

**Stacked plan, GitHub mode — present exactly these 2 options:**

```
Implementation complete. The stack's PRs are up for review. What would you like to do?

1. Leave the stack open for review (the PRs stay as they are)
2. Merge now (the whole stack; you name the method)

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

First get the main repo root: `GIT_COMMON` (Step 3) is the git dir shared by every worktree, so its parent is the main checkout.

```bash
git -C <GIT_COMMON>/.. rev-parse --show-toplevel
```

Note what it prints as `MAIN_ROOT`. Every later command reaches the main checkout with `git -C <MAIN_ROOT>`. The session stays where it is until Step 7, which moves it only when a worktree is removed, so `stack.mjs` still finds the state file while you work.

```bash
# Merge first — verify success before removing anything
git -C <MAIN_ROOT> checkout <base-branch>
git -C <MAIN_ROOT> pull
git -C <MAIN_ROOT> merge <feature-branch>
```

Verify the merged result with the project's test command run in `<MAIN_ROOT>`: give the command that path in its own option or argument (`npm test --prefix <MAIN_ROOT>`, `cargo test --manifest-path <MAIN_ROOT>/Cargo.toml`, `pytest <MAIN_ROOT>`, `go test -C <MAIN_ROOT> ./...`), never chained behind a directory change.

If tests fail on the merged result: stop, leave the worktree and branch in
place, and investigate — nothing has been pushed, so the merge is local
and recoverable.

Once the merged result is green: clean up the worktree (Step 7), then
delete the branch:

```bash
git -C <MAIN_ROOT> branch -d <feature-branch>
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

**Option 1, leave the stack open:** report "Leaving the stack open: its PRs stay as they are. Worktree preserved at <path>." The state file stays; the After Merge checklist stays in the closing entry and status `Next` (Step 2).

**Option 2, merge now:** this merges the whole stack. Ask the owner for the method (the `<m>` below) and never pick it for them. Read `node ../executing-plans/scripts/stack.mjs status PLAN_FILE` first. A phase still `submitted` is a draft and `gh stack merge` refuses draft PRs: with the owner's OK run `node ../executing-plans/scripts/stack.mjs submit PLAN_FILE <top N> --open` before the merge, and when they do not OK it, stop. Then check out the top branch with `git switch <top branch>` and run `gh stack view --json`: the list must include the top phase's `pr`, and every PR in it must be one of the `pr` values `status` printed for this plan's phases; when the list is empty, lacks the top phase's PR, or holds any other PR, stop and ask. Then run `gh stack merge --yes --merge-method <m>` with no argument, which merges the stack of the current branch. `gh stack merge --help` takes no argument, a stack number or a PR number, and reads a bare number first as a stack number, so with `--yes` a bare PR number can merge another stack without a prompt. Never pass a bare number. To merge only up to a lower PR, the owner runs `gh stack merge` themselves (its wizard asks how far); you do not. Then go to "After a stack merge" below.

### Stacked plan: local mode

**Option 1, merge the stack locally:** on the main repo root (the `MAIN_ROOT` of Option 1 above), run `git -C <MAIN_ROOT> checkout <trunk>` (the `trunk` in the state, which `status` below prints), then `git -C <MAIN_ROOT> merge --ff-only <top branch>`, then run the suite on the merged result in `<MAIN_ROOT>`, as Option 1 does. If the fast-forward is refused (the trunk moved), stop: nothing is merged and nothing is pushed; report it. If the suite fails, stop and investigate with the worktree and branches in place. Once it is green, go to "After a stack merge" below.

**Option 2, push and open as stacked PRs:** run `node ../executing-plans/scripts/stack.mjs mode PLAN_FILE github` (exit 3 names the check that failed: report it and stop, nothing is pushed), then `node ../executing-plans/scripts/stack.mjs submit PLAN_FILE <N>` for each phase still `done`, in order, from the lowest `n` to the top one (after a mid-run fallback to local mode, the earlier phases are already `submitted` and `submit` refuses them, exit 3), then mark the PRs ready with `--open`: `node ../executing-plans/scripts/stack.mjs submit PLAN_FILE <top N> --open`. Your human partner's choice authorizes the push of this plan's phase branches and the draft PRs. Keep the worktree, report the PR numbers it prints, and leave the state file; the After Merge checklist stays in the closing entry and status `Next` (Step 2).

**Option 3, keep as is:** report "Keeping the stack as local branches. Worktree preserved at <path>." The state file stays.

### After a stack merge

Read the status first, from the checkout where the stack lives, never from `MAIN_ROOT` (the state file is in the checkout where `stack.mjs init` ran, so `status` there is the only one that finds it): run `node ../executing-plans/scripts/stack.mjs status PLAN_FILE` in the session's own directory (Step 7 has not moved it yet). GitHub mode refreshes each phase's PR state from the forge, and a phase whose PR merged is `merged`. A merge with `gh stack merge` (or one the owner ran by number) may stop short of the top, so what happens next depends on the top phase.

**Full merge** (GitHub mode: the top phase is `merged`; a local fast-forward merge is always full, and the state file records `merged` only in GitHub mode): work on the main repo root with `git -C <MAIN_ROOT>` (the `MAIN_ROOT` of Option 1 above; a local merge already merged there, a GitHub merge did not). In GitHub mode that checkout holds whatever was left in it (a phase branch, an old trunk), so bring it to the merged trunk before anything runs: require a clean tree (`git -C <MAIN_ROOT> status --porcelain --untracked-files=no` prints nothing), then `git -C <MAIN_ROOT> fetch <remote>`, `git -C <MAIN_ROOT> checkout <trunk>` and `git -C <MAIN_ROOT> merge --ff-only <remote>/<trunk>`, with the `remote` and `trunk` of the status output above; if any of these is refused, stop and report it, and nothing after it runs (the checklist would run on stale code). Then run the plan's `## After Merge` checklist in order, each operation with its command (run in `<MAIN_ROOT>` the way Option 1 runs the test command), and report each result (a failing operation stops the list: it and every operation after it stay pending, and the status refresh below names only them; an operation that needs the trunk pushed waits for your human partner, pushing stays theirs). Then clean up the worktree (Step 7: it moves the session to `<MAIN_ROOT>` before removing the worktree, and every command from here on runs from `<MAIN_ROOT>`), then `gh stack sync --prune` (GitHub mode; `gh` acts on the repository of the session's directory) or delete the merged phase branches with `git -C <MAIN_ROOT> branch -d <branch>` for every phase (local mode). The phases count as `merged`: `status` reports it in GitHub mode, and in local mode the fast-forward made it so without the state file saying so. Last, delete the state file at the path captured in Step 3: `rm -f <STACK_STATE>` (an absolute path; never resolve it again from here: the cleanup may have removed the worktree that held it). Then write a second progress entry (opted in; land it the way step 3 does for the repo's mode, with no commit after it) naming the merge and the checklist's results. Last, refresh the status section that named the checklist (status `Next`, step 4), so it no longer tells the owner or the next session to run what already ran: it names only the operations still pending (the failed one and the rest, when one failed) or says the checklist ran. In store mode read `triqual tracking status`, write the section's body as a draft and land it with `triqual tracking status set --section <heading> <draft>`; in local mode copy `status` to a draft in a private `mktemp -d` dir and land it with `triqual tracking write status <draft>` (a stack never runs in committed mode). Not opted in: say which operations are still pending, or that the checklist ran, in the final message.

**Partial merge** (GitHub mode only: the top phase is not `merged`, the merge stopped below the top phase; the state file records `merged` only in GitHub mode, so a local fast-forward is never a partial merge, whatever `status` shows): run `node ../executing-plans/scripts/stack.mjs status PLAN_FILE` to refresh the state; this runs nothing else: no After Merge operation, no prune, no branch deleted, and the state file stays. The checklist stays in the closing entry and status `Next` (Step 2); name the remaining phases in your final message.

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

Wait for that exact confirmation. When it arrives, get `MAIN_ROOT` as Option 1 does:

```bash
git -C <GIT_COMMON>/.. rev-parse --show-toplevel
```

Then clean up the worktree (Step 7) and force-delete the branch:

```bash
git -C <MAIN_ROOT> branch -D <feature-branch>
```

## Step 7: Cleanup Workspace

**Runs for Option 1, a full stack merge and confirmed discards.** Options 2 and 3
always preserve the worktree, and so do a stack's other options and a partial merge. Both callers
have already noted `MAIN_ROOT`, and they use the `GIT_DIR`/`GIT_COMMON`/`WORKTREE_PATH` values
noted in Step 3.

**Before any removal, move the session to `<MAIN_ROOT>`**, with your harness's workspace-exit or
directory tool, as a step of its own and never chained to a command: a session left in a
directory that is then removed fails every command after it. Remove the worktree with
`git -C <MAIN_ROOT>`, and run every command after the removal from `<MAIN_ROOT>`: the callers'
later steps (the branch delete, `gh stack sync --prune`, the state file removal, the tracking
entries) never rely on the removed directory. When nothing is removed (a normal repo, or a
workspace the host owns), the session stays where it is.

**If `GIT_DIR == GIT_COMMON`:** Normal repo, no worktree to clean up. Done.

**If `WORKTREE_PATH` is under `.worktrees/` or `worktrees/`:**
the Worktrees section of methodology:executing-plans created this worktree — we own cleanup:

```bash
git -C <MAIN_ROOT> worktree remove <WORKTREE_PATH>
git -C <MAIN_ROOT> worktree prune  # Self-healing: clean up any stale registrations
```

**If removal is refused** (`contains modified or untracked files`): the
worktree holds files that exist nowhere else — uncommitted plans, notes,
or scratch work. Never `--force` on your own initiative. Show your human
partner what is at stake and ask:

```bash
git -C <WORKTREE_PATH> status --porcelain -uall
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

**If this session created the worktree with a native tool** (for example
`EnterWorktree`, which places it under `.claude/worktrees/`): we own cleanup.
Leave it with the platform's exit tool and choose removal (`ExitWorktree`
with `action: "remove"`); that exit is the move out of the worktree. If the tool refuses because of uncommitted files
or unmerged commits, never pass `discard_changes` on your own initiative:
show your human partner the list and ask, as above.

**Otherwise:** The host environment owns this workspace — leave it in
place. If your platform provides a workspace-exit tool, use it and keep
the worktree.

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
| GitHub 2. Merge now | `gh stack merge` (whole stack) | - | no | `gh stack sync --prune`, state file |
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
| "This other worktree looks stale — I'll clean it too" | Clean up only worktrees under `.worktrees/` or `worktrees/`, and one this session created with a native tool. Everything else belongs to the host. |
| "Removal refused — `--force` is just finishing the cleanup" | The refusal means files exist only in that worktree. `--force` destroys them permanently. Show your human partner and ask. |
| "The merged-result failure is probably flaky" | A failing merged result stops everything. Branch and worktree stay put while you investigate. |
| "The base branch is obviously main" | Confirm the fork point or ask. Merging into the wrong base is expensive to undo. |
| "The push was rejected — force-push will fix it" | A rejected push means the remote moved. Investigate; force-push only on your human partner's explicit request. |
| "`triqual tasks check` found drift (the repo is opted in), but the tests pass — close anyway" | Drift means the ledger, the plan and `status.md` disagree. Report it and fix it before the close; a closed ledger records the drift for good. |
| "The stack's PRs merged, so the After Merge checklist can run" | Only when the top phase is `merged` in GitHub mode; a partial merge runs nothing: the owner merges the rest and runs the checklist from the entry and `Next`. A local fast-forward is always a full merge, though the state file never says `merged` in local mode. |
| "The stack's PRs are open, so they are ready for review" | A phase still `submitted` is a draft, and `gh stack merge` refuses drafts. Either the final review left residual findings or a failed `--open` (exit 5): name which, and let your human partner decide before anything is marked ready or merged. |
| "A stack needs a closing commit like any plan" | Stacked execution is store or local mode: no tracking file exists to stage, so there is no closing commit. |
| "The ledger bookkeeping can ride on the merge" | The closing commit carries it, with the closing entry, before any option runs. The pre-commit rejects a commit without the tracking files. |
