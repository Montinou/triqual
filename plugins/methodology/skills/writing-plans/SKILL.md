---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** Plans run in the current checkout on stacked phase branches. A worktree exists only when your human partner asked for one; never write a plan step that creates one.

**Save plans to:** `YYYY-MM-DD-<feature-name>.md` in the plans directory. Run `triqual tasks paths --json` once, before writing the plan:
- **Opted in** (`"optedIn": true`; an older `triqual` prints the same fields without `optedIn`): plans go to `plansDir`, and the plan is registered when done (see Register the Plan).
- **Not opted in** (`"optedIn": false`, or exit 2 from an older progress-tracking): plans go to `docs/plans/`, unless your human partner names another place. Run no `triqual tasks` command, and never create `progress.md`: creating it opts the repo in and commits a personal log into a shared repo.
- **`triqual` missing** (exit 3, or `triqual` not on `PATH`): handle it as not opted in, and say so once.

Opted in with `"mode": "local"`, `plansDir` lives under the git dir, which Claude Code protects from agent file writes: make a private draft dir in the OS temp dir (run `mktemp -d`; the directory it prints is `$d` below: other sessions share the temp dir), write the plan there under its final name, `$d/YYYY-MM-DD-<feature-name>.md` (it lands in `plansDir` under that name), and land it with `triqual tracking write plan <draft>`, the same as `triqual tasks init --adopt <draft>` (see Register the Plan); the `progress` entry and the `status` edit go the same way, as drafts in that `mktemp -d` dir (any name, such as `$d/entry.md` and `$d/status.md`) landed with `triqual tracking write entry <draft>` and `triqual tracking write status <draft>`. Never write or edit under `.git/` with the file tools.

Opted in with `"mode": "store"` (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`), `plansDir` is in the store's documents directory and the plan never goes into the working tree: make a private draft dir (run `mktemp -d`; the directory it prints is `$d` below), write the plan there under its final name, `$d/YYYY-MM-DD-<feature-name>.md`, and land it with `triqual tracking write plan <draft>` (see Register the Plan); the `progress` entry and the `status` edit go through the store too, with no commit step.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Phases

A plan is a sequence of phases. Each phase is one pull request, built from atomic tasks. Map each phase to a delivery slice of the spec (its `## Delivery Slices`): the slice's reason to stand alone, refined with the real files, becomes the phase's. A spec without slices is one phase. Write each phase as:

````markdown
## Phase <N>: <name>
**Slice:** S<n>
**Branch:** <prefix>/<NN>-<phase-slug>
**PR title:** <conventional title>
**Stands alone because:** <the slice's reason, refined with real files>
**Phase check:** `<command>` → <expected>

### Task <M>: ...
````

Its `### Task <M>: …` blocks follow, and no other `###` heading appears inside a phase.

- **Numbering and order:** task numbers are global across phases (T1…Tn). Each task belongs to exactly one phase, and its `**Depends on:**` names only tasks in the same or an earlier phase.
- **One commit per task:** a task's work is exactly one commit on the phase branch, and its single Commit step gives the conventional message.
- **Lanes:** plan every phase in parallel lanes first. A lane is a chain of tasks, named by a letter on each task's `**Lane:** <letter>` line, that one agent runs start to finish while the other lanes run beside it. The rule:
  - Lanes have disjoint `Files`: no path appears in two lanes.
  - There is no `Depends on` across lanes: a task depends only on tasks of its own lane or of an earlier phase, the closing task below being the one exception.
  - Tasks chain inside a lane: each later task of a lane depends on the one before it.
  - A task meant to run beside others in another lane has one exact node `Test:` file (see Task Structure), since only such a task runs in parallel.
  - The phase ends with a closing task that depends on every lane. It is the milestone: it runs the phase check once the lanes have landed.
- **Sequential because:** a phase planned without lanes writes `**Sequential because:** <reason>` under its Phase check, the reason being a fact about the work (one shared file, one task's output feeding every other). It is the only way to a sequential phase: a phase with neither lanes nor that line is a defect, and "simpler" or "safer" is not a reason.
- **Size:** about 6 tasks per phase. Going over means splitting the phase, and noting that the spec's slice should have been split.
- **Coordinator tasks:** a `coordinator` task that makes no commit (a probe, a checkpoint) lives in the phase whose PR it accompanies. Every phase has at least one task that commits.
- **`## After Merge`:** optional, after the last phase. A checklist of the operations that need the merged trunk (deploy, production migration, publish), each with its command and expected result. No `### Task` headings: these never reach the task ledger.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle, that a
reviewer could reject alone, and that fits one commit. When drawing task
boundaries: fold setup, configuration, scaffolding, and documentation
steps into the task whose deliverable needs them; split only where a
reviewer could meaningfully reject one task while approving its neighbor.
Same-shape small edits are one task, never a batch of tasks. Each task
ends with an independently testable deliverable and exactly one commit.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step (the task's single one)

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use methodology:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — the plan
argues from the spec, so the spec travels with it; executors read both]

**Branch prefix:** [<topic>: the prefix of every phase branch, `<topic>/<NN>-<phase-slug>`]

**Sensitive paths:** [optional: `<glob>, <glob>`, paths whose change makes a task `heavy`, added to the default set (see Task Tiers); omit the line when none]

**Test paths:** [optional: `<glob>, <glob>`, paths whose lines never count toward the 300-line heavy limit or the light allowance, added to the default test paths (see Task Tiers); omit the line when none]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Review Focus

[The five input classes or failure modes the spec implies but no task's
tests exercise that are most likely to bite a person using this software
— one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec is a vision
document: it says what the software must do, not everything it will
meet, and its silence on an input is not permission for that input to
break the program. Write the list here, once, with the spec in front of
you. Then, for each line, add the test that pins it to the task that
owns the code, in that task's own step style.]

---
```

## Task Roles

Every task gets a `**Role:**` line naming the role that does its work. Choosing the role:
- `roles:tdd-implementer` is the default: code and tests written test-first. Most tasks take it.
- `roles:complex-implementer` takes a task that is a live-state migration, or a change across systems that one brief cannot describe. Name which on the plain-text line under `**Role:**`, not starting with `**`. Same test-first discipline; everything else is `roles:tdd-implementer`; tier these tasks `heavy`.
- `coordinator` takes work the controller must do itself: probes, rollout steps (deploys, env vars, status updates), user checkpoints, and anything that needs your human partner in the loop. It may also take a small, low-risk fix, within the `light` code allowance; every `coordinator` task is `light`.

Live-state work and migrations are never coordinator work: they are `heavy`, and the role is chosen by the criteria above, and a production operation that needs the merged trunk is an `## After Merge` item. `roles:review-fixer` is never a task role: the orchestrator dispatches it for fix rounds, so a plan never plans one. Reviewer roles and the brief writer serve a task and are never its role either. A plan without the line reads as `roles:tdd-implementer`, but write it for every task anyway.

## Task Tiers

Every task gets a `**Tier:**` line, `heavy`, `standard` or `light`, set by what the task's work touches:
- **heavy** — any of: security-relevant code (auth, permissions, secrets, sandboxing, policy engines, parsing untrusted input, gate/enforcement hooks), live state or migrations (stores, schemas, installed setup), a contract other code parses (hook I/O, file formats, the plan format, machine-read CLI output), `roles:complex-implementer`. A change that only spans more than one plugin, or only touches a public interface, is not heavy by that alone. Every heavy task carries a one-line reason as plain text on the line under `**Tier:**`, naming which criterion applies; the plan parser reads only the tier word on the `**Tier:**` line, so the reason is not a new field.
- **light** — the default: light is the default for every task that no heavy criterion matches and that does not need the full review, namely docs, comments, config values, version bumps, renames with no behavior change, and small code fixes within the light code allowance (at most 100 non-test added+removed lines in total, no new non-test file, no prompt-like Markdown, no sensitive path). Test lines never count toward the allowance, and a new test file alone stays light.
- **standard** — only with a one-line reason as plain text on the line under `**Tier:**`, naming what needs the full review (a new non-test file, prompt-like Markdown, more than 100 non-test code lines, or another cost a bug there would carry).

A task that touches a sensitive path is `heavy`, as is a task whose diff will have more than 300 changed lines, test lines not counted. The default sensitive paths are `**/hooks/**`, `**/setup/**`, `**/*schema*`, `**/migrations/**`, `**/drizzle/**`, `.github/**` and `plugins/workflow-gate/**`; the plan header's `**Sensitive paths:** <glob>, <glob>` adds its globs to that set. Test lines are those of paths matching the default test paths `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*` and `**/*.spec.*`, plus the globs of the plan header's optional `**Test paths:**` line; a sensitive path always wins over a test path.

Review is light per task and heavy at the phase end: a task's tier sets the review that task gets while its lane runs, and the phase-end review covers the whole phase diff once the lanes have converged, so tier a task for what it needs on its own, not for what the phase as a whole carries.

Tiers are all-or-none per plan: every task carries one, or none does. `coordinator` tasks must be `light` and `roles:complex-implementer` tasks `heavy`. The orchestrator may raise a tier at run time, never lower it.

## Task Structure

````markdown
### Task N: [Component Name]

**Tier:** heavy
Security: parses untrusted hook input.
**Lane:** A
**Depends on:** T1, T3
**Skills:** slug-a, slug-b
**Role:** roles:tdd-implementer

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Implement `function(input: InputType) -> ResultType` in `exact/path/to/file.py`**

One line on the approach when the signature and the test leave a choice
(which library call, which data structure); a code block only for an
algorithm they do not determine.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

The lines under the heading follow the task ledger's plan format:
- `**Tier:**` names the task's tier (see Task Tiers); it is the first line. A `heavy` task puts its one-line reason on the plain-text line directly under it.
- `**Lane:**` names the task's lane as one letter (see Phases, Lanes). Tasks of one lane share the letter and chain through `**Depends on:**`; the closing task takes a lane of its own and depends on every lane. A phase with `**Sequential because:**` writes no `**Lane:**` lines. The plan parser ignores the line, so task ids and dependencies read as they do without it.
- `**Depends on:**` lists the tasks that must be done first, as `T1, T3`; omit the line when a task has none.
- `**Skills:**` lists the vault skills the task needs. When headjack is installed, run `triqual suggest "<the task's text>" --json` per task and keep the fitting `suggestions[].slug` values. On a non-zero exit from `triqual suggest` (exit 3: headjack is not installed), on empty output, or when `triqual` is not on `PATH` (`command -v triqual` fails, or exit 127), omit the line silently.
- `**Role:**` names the task's role (see Task Roles). A `roles:complex-implementer` task puts its reason, the live-state migration or the change across systems that one brief cannot describe, on the plain-text line directly under it. Reason lines never start with `**`.
- `**Files:**` also decides which tasks run side by side (see methodology:executing-plans, Parallel tasks): list every file the task creates, modifies or tests, because two tasks of a phase that share a path run one after the other, and a path left off is caught only at landing. A task runs in parallel only when it has a `Test:` path that is one exact file ending `.mjs`, `.js` or `.cjs` (no glob, inside the repository); with any other `Test:` path, or none, it runs sequentially.

Test-first applies to every task that changes behavior, at any tier. A task with no behavior change (docs, config values, a rollout step) replaces the test steps with a verification step: the command to run and the output that means it passed.

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: unambiguous, not complete. Each kind
of step carries what makes it unambiguous and nothing more:

- **A test step:** the test's name and its assertions, as code, with the
  spec's exact values in them.
- **A code step:** the exact signature (name, parameters, return type), the
  file it lives in, and the specific values the spec pins. The implementer
  writes the body. A body appears only for an algorithm the signature and
  tests do not determine, or for exact copy the spec fixes.
- **A verification step:** the command to run and the output that means it
  passed.
- **A reference to another task:** that task's Interfaces block says what
  to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead. Lines that
decide nothing ("TBD", "handle edge cases", "add appropriate validation",
"write tests for the above", a type or function no task defines) are the
opposite failure, and the self-review catches both.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Step scan:** Every step must let the implementer write exactly one reasonable thing, and no step may carry more than that: a line that decides nothing is a gap, a function body the signature and tests already determine is a transcript. Fix both.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

**5. Proportion:** Compare the plan's length to the spec's. A plan several times longer than the spec it implements is a transcript of the program, not a plan. If code blocks are most of the document, replace bodies with signatures, test names and assertions, and check that each step is still unambiguous.

**6. Phases:** Does each phase map to a slice of the spec? Does any task depend on a later phase? Does every phase have a branch, a PR title, a Phase check and a task that commits? Is anything that needs the merged trunk a task instead of an `## After Merge` item?

**7. Tiers:** Does every task carry a `**Tier:**` (all or none)? Is each tier the one the rubric gives for what the task touches, with no task tiered lower than its content justifies? Is every `coordinator` task `light` and every `roles:complex-implementer` task `heavy`? Does every `heavy` task have its reason line under `**Tier:**`, and every `roles:complex-implementer` task its reason line under `**Role:**`, each naming a criterion the rubric gives? Is every task that touches a sensitive path (the default set plus the header's `**Sensitive paths:**`) or whose diff will have more than 300 non-test changed lines `heavy`? Is any task left at the default light that matches a heavy trigger, and does every `standard` task have its one-line reason under `**Tier:**`? When more than 80% of the plan's tasks are `heavy` in a plan of at least 5 tasks, re-check each tier, since heavy review costs the most and registering the plan prints a warning.

**8. Lanes:** Does every phase either split into lanes or carry `**Sequential because:**` with a real reason? In a laned phase, are the lanes' `Files` disjoint, is there no `Depends on` across lanes, do the tasks of each lane chain, does every task meant to run beside others have one exact node `Test:` file, and does a closing task depend on every lane as the milestone? Is any phase marked sequential that two lanes could carry?

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Plan Audit

After the self-review, dispatch `roles:final-adversarial-reviewer` with `../brainstorming/spec-document-reviewer-prompt.md` on the plan and its spec: the adversarial audit runs on every plan, and no other reviewer takes its place. The audit checks the tiers both ways: a task tiered lower than its content justifies by the Task Tiers rubric is a finding, and so is a task tiered higher than the rubric justifies. A `heavy` task, or a `roles:complex-implementer` task, whose reason line is missing or does not match the rubric's criteria for it is a finding too. The shared audit prompt stays as it is, so write both tier checks into your dispatch message to the auditor.

Fix the findings in the plan. Name, in your message to your human partner, each finding you did not fix and why.

## Register the Plan

When opted in, the plan ends in the task ledger and the tracking files; when not opted in, skip this section.
1. When opted in, run `triqual tasks init <plan>` on the plan in `plansDir`. Opted in with `"mode": "local"`, run `triqual tracking write plan <draft>` on the draft under its final name in the `mktemp -d` dir instead (the same as `triqual tasks init --adopt <draft>`): it copies the draft into `plansDir` and creates the ledger. A draft edited after that lands again with `triqual tracking write plan <draft> --replace`, which reconciles the ledger. In store mode (`"mode": "store"`) the same `triqual tracking write plan <draft>` adopts the draft into the store and creates its ledger, and it lands again with `--replace` after the audit's fixes.
2. When opted in, register the plan in `progress` (`progress.md`): a new top entry naming the plan, its spec and its task count. Opted in with `"mode": "local"`, write the entry as a draft in that `mktemp -d` dir (`$d/entry.md`) and land it with `triqual tracking write entry <draft>`. In store mode, registering ends the task with no commit: write the entry as a draft in the `mktemp -d` dir and land it with `triqual tracking add <draft> --no-commit`, because a pending entry left behind would be stamped onto the next, unrelated commit.
3. When opted in, add the plan to `status` (`status.md`): edit around the tasks markers, never inside them, and never rewrite the file whole. Opted in with `"mode": "local"`, copy `status` to a draft in that `mktemp -d` dir (`$d/status.md`), edit the draft, and land it with `triqual tracking write status <draft>` (it keeps the tasks section). In store mode, read it with `triqual tracking status` and change one section with `triqual tracking status set --section <heading> <draft>`; the whole-file `status set` is only for a full rewrite.
4. In committed mode (`"mode": "committed"`), commit the plan, its ledger (`<plan>.tasks.json`), `progress` and `status` together. In store mode there is no commit step: nothing of the tracking is in the working tree and no tracking file is staged or committed (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`).

## Execution Handoff

After saving and self-reviewing the plan, link it for your human partner
to read. Ask them to review the plan and confirm it captures what they want;
wait for that review before implementation. Every plan runs through
`methodology:executing-plans`, which dispatches each task to a role agent, so
there is nothing else to pick.

Execution builds a stack: one branch and one draft PR per phase, one commit
per task. In GitHub mode (a GitHub remote and `gh stack`) it pushes this
plan's phase branches, opens and updates their draft PRs, and marks them
ready for review after the final review; otherwise the stack stays local. Your human partner's
confirmation of the plan authorizes
that push of this plan's phase branches and draft PRs, and marking them ready for review after the final review, and nothing else; the
execution skill records it in its ledger as `Authorization: push phase
branches and draft PRs — handoff <date>`, and merging stays your human partner's.

**"Plan complete and saved to `<plan path>`. Please review the plan. Execution builds a stack: one branch and one draft PR per phase. Confirming the plan authorizes the execution skill to push this plan's phase branches, to open and update their draft PRs, and to mark them ready for review after the final review (it records that in its ledger; without `gh stack` or a GitHub remote the stack stays local); merging stays yours. Does it capture what you want?"**

- **REQUIRED SUB-SKILL:** Use methodology:executing-plans
