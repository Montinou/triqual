---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the `methodology:using-git-worktrees` skill at execution time.

**Save plans to:** `YYYY-MM-DD-<feature-name>.md` in the plans directory. Run `triqual tasks paths --json` once, before writing the plan:
- **Opted in** (`"optedIn": true`; an older `triqual` prints the same fields without `optedIn`): plans go to `plansDir`, and the plan is registered when done (see Register the Plan).
- **Not opted in** (`"optedIn": false`, or exit 2 from an older progress-tracking): plans go to `docs/plans/`, unless your human partner names another place. Run no `triqual tasks` command, and never create `progress.md`: creating it opts the repo in and commits a personal log into a shared repo.
- **`triqual` missing** (exit 3, or `triqual` not on `PATH`): handle it as not opted in, and say so once.

Opted in with `"mode": "local"`, `plansDir` lives under the git dir, which Claude Code protects from agent file writes: make a private draft dir in the OS temp dir (`d=$(mktemp -d)`: other sessions share the temp dir), write the plan there under its final name, `$d/YYYY-MM-DD-<feature-name>.md` (it lands in `plansDir` under that name), and land it with `triqual tracking write plan <draft>`, the same as `triqual tasks init --adopt <draft>` (see Register the Plan); the `progress` entry and the `status` edit go the same way, as drafts in that `mktemp -d` dir (any name, such as `$d/entry.md` and `$d/status.md`) landed with `triqual tracking write entry <draft>` and `triqual tracking write status <draft>`. Never write or edit under `.git/` with the file tools.

Opted in with `"mode": "store"` (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`), `plansDir` is in the store's documents directory and the plan never goes into the working tree: make a private draft dir (`d=$(mktemp -d)`), write the plan there under its final name, `$d/YYYY-MM-DD-<feature-name>.md`, and land it with `triqual tracking write plan <draft>` (see Register the Plan); the `progress` entry and the `status` edit go through the store too, with no commit step.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use methodology:subagent-driven-development (recommended) or methodology:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — the plan
argues from the spec, so the spec travels with it; executors read both]

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
- `roles:complex-implementer` takes a task where a mistake is costly: multi-system changes, migrations of live state, or other work that needs the stronger model. Same test-first discipline; mark only the tasks that need it.
- `roles:review-fixer` takes a task whose work is fixing review findings: a planned fix round, or answering review feedback on existing code.
- `coordinator` takes work the controller must do itself: probes, rollout steps (migrations, deploys, env vars), user checkpoints, and anything that needs your human partner in the loop.

Reviewer roles and the brief writer serve a task and are never its role; the execution skills dispatch them. A plan without the line reads as `roles:tdd-implementer`, but write it for every task anyway.

## Task Structure

````markdown
### Task N: [Component Name]

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
- `**Depends on:**` lists the tasks that must be done first, as `T1, T3`; omit the line when a task has none.
- `**Skills:**` lists the vault skills the task needs: run `triqual suggest` on the task's text and keep the fitting slugs. On exit 3 from `triqual suggest` (skill-suggest is not installed yet), or when `triqual` is not on `PATH` (`command -v triqual` fails, or exit 127), omit the line silently.
- `**Role:**` names the task's role (see Task Roles).

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

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Plan Audit

After the self-review, dispatch `roles:final-adversarial-reviewer` with `../brainstorming/spec-document-reviewer-prompt.md` on the plan and its spec: the adversarial audit runs on every plan, and no other reviewer takes its place.

Fix the findings in the plan. Name, in your message to your human partner, each finding you did not fix and why.

## Register the Plan

When opted in, the plan ends in the task ledger and the tracking files; when not opted in, skip this section.
1. When opted in, run `triqual tasks init <plan>` on the plan in `plansDir`. Opted in with `"mode": "local"`, run `triqual tracking write plan <draft>` on the draft under its final name in the `mktemp -d` dir instead (the same as `triqual tasks init --adopt <draft>`): it copies the draft into `plansDir` and creates the ledger. A draft edited after that lands again with `triqual tracking write plan <draft> --replace`, which reconciles the ledger. In store mode (`"mode": "store"`) the same `triqual tracking write plan <draft>` adopts the draft into the store and creates its ledger, and it lands again with `--replace` after the audit's fixes.
2. When opted in, register the plan in `progress` (`progress.md`): a new top entry naming the plan, its spec and its task count. Opted in with `"mode": "local"`, write the entry as a draft in that `mktemp -d` dir (`$d/entry.md`) and land it with `triqual tracking write entry <draft>`. In store mode, registering ends the task with no commit: write the entry as a draft in the `mktemp -d` dir and land it with `triqual tracking add <draft> --no-commit`, because a pending entry left behind would be stamped onto the next, unrelated commit.
3. When opted in, add the plan to `status` (`status.md`): edit around the tasks markers, never inside them, and never rewrite the file whole. Opted in with `"mode": "local"`, copy `status` to a draft in that `mktemp -d` dir (`$d/status.md`), edit the draft, and land it with `triqual tracking write status <draft>` (it keeps the tasks section). In store mode, read it with `triqual tracking status` and change one section with `triqual tracking status set --section <heading> <draft>`; the whole-file `status set` is only for a full rewrite.
4. In committed mode (`"mode": "committed"`), commit the plan, its ledger (`<plan>.tasks.json`), `progress` and `status` together. In store mode there is no commit step: nothing of the tracking is in the working tree and no tracking file is staged or committed (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`).

## Execution Handoff

After saving and self-reviewing the plan, link it for your human partner
to read. If they have already explicitly supplied an execution method, ask
them to review the plan and confirm it captures what they want; wait for that
review before implementation, then use the preserved method. Otherwise, ask
them to review the plan and choose an execution method before implementation.

**When no execution method has already been supplied:**

**"Plan complete and saved to `<plan path>`. Please review the plan. Which execution approach would you prefer?**

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work; each task still gets its reviews, and the whole branch a final review. Cheapest and fastest; no fresh implementer context per task. Runs well with a mid-tier session model, since the plan carries the design.

**For this plan I recommend <one of the two>, because <one sentence from the plan: how much the tasks depend on each other's interfaces, how many there are, what a shipped mistake would cost>. Does the plan capture what you want, and which approach should we use?"**

**When an execution method has already been supplied:**

**"Plan complete and saved to `<plan path>`. Please review the plan. Does it capture what you want?"**

**If Subagent-driven chosen:**
- **REQUIRED SUB-SKILL:** Use methodology:subagent-driven-development

**If Native chosen:**
- **REQUIRED SUB-SKILL:** Use methodology:executing-plans

Forked from superpowers 6.4.2 (skills/writing-plans), MIT © Jesse Vincent — see LICENSE-superpowers.
