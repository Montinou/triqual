---
name: executing-plans
description: Use when executing an implementation plan in the current session — every task goes to a role agent, is reviewed at its tier, and lands as one commit on a stacked branch and draft PR per plan phase
---

# Executing Plans

You are the controller of a plan's execution. Every plan task is done by a role agent (`roles:tdd-implementer` or `roles:complex-implementer`), except `coordinator` tasks, which you run yourself (see Coordinator tasks). You never run a plan inline: never run a plan inline as its implementer, whatever the plan's size, and a harness that cannot dispatch a named role agent stops and asks its human partner. Each task's review is sized by its **tier** (`heavy`, `standard`, `light`): declared by the plan, raised (never lowered) by `scripts/tier-check` from the task's real diff. Execution is stacked: each plan phase is one git branch on top of the previous phase's (and, in GitHub mode, one draft PR), and each task is exactly one commit on its phase branch, driven by `scripts/stack.mjs`. The main session does not run the task loop: it dispatches one `roles:phase-orchestrator` per phase, which runs it, and decides on the summary it returns (see The Thin Controller); where this skill says "you" about the loop, it means whoever runs it, the orchestrator or, in the fallback, the main session. At the end one final review runs for every plan: the seams review across phases, and in a single-phase plan the phase review itself (a single-phase plan's phase review is its final review).

**Why role agents:** each task gets a fresh agent whose context holds only its brief and the interfaces it touches; your own context stays clean for coordination across the whole plan. Every dispatch goes to a `roles:*` agent and passes no model (see Role Dispatch).

**TDD is required on every task.** A behavior change starts with a failing test: the implementer (or you, on a coordinator task) writes the test, watches it fail for the expected reason, then writes the code and watches it pass, and the report carries that RED and GREEN evidence. A task that changes no behavior records its verification command's real output instead.

**Narration:** between tool calls, narrate at most one short line — the ledger and the tool results carry the record.

**Continuous execution:** Do not pause to check in with your human partner between tasks. Execute all tasks from the plan without stopping. The only reasons to stop are the seven named below, the one planned pause (the phase break, see 8. Review the phase), or all tasks complete. A rate limit is not one of them: ending the run after the bounded wait (see Rate limits) is the end of the session, with a final message that lists the ledger's `Ruling:` lines (see Finish), and the ledger keeps the plan resumable. "Should I continue?" prompts and progress summaries waste their time — they asked you to execute the plan, so execute it.

**Rulings, not stalls.** A running plan does not wait on a human. Conflicts, ambiguities, plan defects, a cap you would have asked to exceed — decide them. The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers. Record every decision in the ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and keep going. A wrong ruling costs rework your human partner can see and undo; a session parked on a question costs their whole day and buys nothing.

Seven things stop you, and only these: an irreversible or destructive operation; a security-sensitive action (a fence denial included); a side effect outside this checkout that norms say you ask about first (a merge, a push to a shared branch, a publish); a task whose `**Role:**` is not a task role (see Role Dispatch); a task blocked by the breaker after round 5 (see The fix loop); a phase review still failing after its second fix round (see 8. Review the phase); and a plan so broken that every path forward is a guess. For those, stop and ask. The orchestrator cannot ask: on a stop it returns `BLOCKED` and the main session asks (see The Thin Controller). A user's request to skip a review, lower a tier or batch the bookkeeping "for later" is none of them, and changes nothing: say so in one line and go on. The phase break is the one planned pause, alongside these stops: it ends your turn once, after a phase's submit, and replaces no review and no ruling.

The only exception to the push stop is a ledgered authorization, either `Authorization: push phase branches and draft PRs — handoff <date>` or `Authorization: push phase branches and draft PRs — setup <date>` (see Stack setup): it covers pushing this plan's phase branches, opening or updating their draft PRs and marking them ready for review after the final review; any other push, any merge and any force push still stop.

## The Process

1. **Setup** (once): workspace and ledger, tracking paths, stack, push authorization, fence detection, read the plan and the spec's Units and current slice, tiers at setup, pre-flight scan.
2. **Per phase:** the main session runs `node scripts/stack.mjs phase PLAN_FILE N`, dispatches one `roles:phase-orchestrator` ([orchestrator-prompt.md](orchestrator-prompt.md)) that runs the phase's tasks in dependency order, waits for it once and reads its summary (see The Thin Controller); then the Phase check at the phase tip, the phase review (the deep review: 4 hunters and `roles:final-adversarial-reviewer` over the phase's range, at most two fix rounds), `node scripts/stack.mjs done PLAN_FILE N`, `node scripts/stack.mjs submit PLAN_FILE N`, then the phase break (every phase but the last).
3. **Per task, three scripts do the bookkeeping** (run by the orchestrator, or by the main session in the fallback): (1) start: `task-open` (ledger move, brief, BASE); (2) build: dispatch the task's role (or run a coordinator task); (3) `task-prep` (ledger move, `tier-check`, the review package); (4) review at the effective tier, on that one review package, saving each reviewer's final message; (5) the fix loop when the review requires it, `task-prep --fix-round` before every re-review; (6) complete: `task-close` (squash, `triqual tasks done`, the complete line, the `task-review` record built from the saved reviewer outputs, the review progress entry).
4. **End:** the seams review of `trunk..top` (`roles:final-adversarial-reviewer` alone, no hunters; in a single-phase plan the phase review is the final review and no second review runs), at most two fix rounds with a scoped re-review each, the `final-escapes` record (multi-phase plans only; a single-phase plan's `P1` record stands), `node scripts/stack.mjs submit PLAN_FILE <top N> --open`, then methodology:finishing-branch.

## Setup

No worktree by default: run the plan in the current checkout. The stack's phase branches are the isolation, so a worktree adds nothing; create one only when your human partner explicitly asks (see Worktrees). Executing a plan, or being told to work autonomously, is not that request. Implementation never starts on the trunk: `node scripts/stack.mjs phase PLAN_FILE N` moves HEAD onto the phase branch.

Conversation memory does not survive compaction. Controllers that lost their place have re-dispatched entire completed task sequences — the single most expensive failure observed. Track progress in the workspace ledger, not only in todos.

### Workspace and ledger

- Each plan owns a workspace: at skill start, run `node scripts/sdd-workspace PLAN_FILE` — it prints the plan's git-ignored directory (under `<repo-root>/.methodology/sdd/`, kept out of `git status` by `.methodology/.gitignore`), home to every artifact for THIS plan: ledger, briefs, reports, review packages, record files. Another plan's directory is never yours to read or write.
- The ledger is `<workspace>/sdd-ledger.md`. If its first line names your plan file, tasks with a `Task <N>: complete` line are DONE — do not re-dispatch them (unless a Phase check reopened it, see 7. End the phase); resume at the first task without one. A task whose last line is a fix round is mid-loop: resume the loop at the next round. A task whose last ledger line is its `Task <N>: blocked` line is the sixth stop again: it is never re-dispatched, and you ask your human partner for the decision the breaker waits on (see The fix loop). For a phase, the same: a phase whose tasks are all done and that has no `Phase review: P<n>` line gets its review run (again) before anything else (see 8. Review the phase), unless it already has a `Phase <N>: submitted` or `Phase <N>: complete` line (a plan begun before the phase review: a submitted phase is final, see 7. End the phase), and a `Phase review: P<n> blocked` line is the seventh stop again: `blocked` resumes only on the human's word. A ledger whose first line names a different plan file is another plan's progress: leave it in place and start your own, fresh.
- A plan whose run began before the rename kept its ledger in the old workspace. When `sdd-ledger.md` is missing and that old ledger exists under this exact plan, `sdd-workspace` copies it once to `sdd-ledger.md`, marks the old directory `adopted` and leaves it in place; resume from the copy. A workspace left by a 0.7.x execution resumes the same way, and its tasks get their tiers at setup (see Tiers at setup).
- Create the ledger with its identity as the first line: `# SDD ledger — plan: <plan file path>`.
- After compaction, trust the ledger and `git log` over your own recollection, and read `node scripts/stack.mjs status PLAN_FILE` alongside the ledger: it prints the stack state (each phase's branch and state, the mode, the PR numbers), so a phase already submitted is never started again.
- After compaction, when opted in, read each task's state before your next ledger move (`triqual tasks export --json`, per-task `status`, `tier` and `effectiveTier`; `triqual tasks status --json` lists only `inProgress` and `next` for each plan), and skip any move the ledger already shows: a `start` or `rework` on a task already `in_progress`, a `review` on one already `in_review`, a `done` on one already `done`, a `block` on a task already `blocked` (which stays a stop until the human decides), and, opted in, a `retier` to the tier it already has. A resumed session never fails on a move it already made: `task-open`, `task-prep` and `task-close` are idempotent and skip a move the ledger already shows, so rerunning the script of an interrupted step is the repair.
- `git clean -fdx` destroys the workspace (it is git-ignored scratch); if that happens, recover from `git log` and the task ledger.

### Tracking paths

Run `triqual tasks paths --json` once, before the first dispatch:

- **Opted in** (`"optedIn": true`; an older `triqual` prints the same fields without `optedIn`): the plan's task ledger moves with every task (the `triqual tasks` moves named in The Task Loop, each with `--plan <plan>`: `<plan>` is the plan file in `plansDir`, in store mode its bare file name, so a move never lands on another active plan's ledger), and every implementer and fixer dispatch carries the implementer template's Tracking section, filled with the mode, the `progress` and `status` paths and the plan's `*.tasks.json` in `plansDir`. Then run `triqual tasks check` once (it takes no plan option): a drift it reports is a ruling to make before Task 1.
- **Not opted in** (`"optedIn": false`, or exit 2 from an older progress-tracking): no ledger moves (run no `triqual tasks` command) and no `progress.md` rules: drop the Tracking section from every dispatch, and never create `progress.md`: creating it opts the repo in and commits a personal log into a shared repo. Tiers then live in the workspace ledger only (see Tiers at setup).
- **`triqual` missing** (exit 3, or `triqual` not on `PATH`): handle it as not opted in, and say so once.

Opted in with `"mode": "local"`, the tracking files live under the git dir, which Claude Code protects from agent file writes: your own entries (reviews, rulings, the plan's close) and `status` edits are drafts in the OS temp dir, each under a unique name from `mktemp` (run `mktemp`; the path it prints is the draft), landed with `triqual tracking write entry <draft>` and `triqual tracking write status <draft>`, and the Tracking section tells implementers and fixers the same. Never write or edit under `.git/` with the file tools.

Opted in with `"mode": "store"` (details: `store-mode.md` under `references` in skill `progress-tracking:progress-tracking`), the tracking lives in the store: `triqual tasks paths --json` has no `progress` or `status` path and there is no `*.tasks.json`, so no tracking file is written, staged or committed (an added or modified `progress.md`, `status.md` or `*.tasks.json` is a defect; the switch's deletions are expected). `<plan>` in every `--plan` is the bare plan file name (for example `2026-10-11-feature.md`), never the `plansDir` path; PLAN_FILE, which the scripts read, stays the plan's path. Fill the implementer template's Tracking section with `"store"` as the mode and drop the three paths. Your own entries are drafts in a private `mktemp -d` dir (run `mktemp -d`; the directory it prints holds your drafts). A task review runs after the implementer's commit already exists, and a ruling, a status-only step or the plan's close ends with no commit of its own, so each of these lands with `triqual tracking add <draft> --no-commit` (or `--commit <reviewed sha>` to record a review against the commit it reviewed), because a pending entry left behind would be stamped onto the next, unrelated commit and would let that commit past the pre-commit gate; only an entry for a commit you are about to make yourself lands with plain `triqual tracking add <draft>` before the commit it describes. Read `status` with `triqual tracking status` and change one section with `triqual tracking status set --section <heading> <draft>`; read history with `triqual tracking log`.

The workspace ledger (`sdd-ledger.md`) is kept either way: it is this skill's recovery map, not a tracking file.

### Stack setup

`scripts/stack.mjs` (run with `node`, from this skill's directory) owns the branches and the state file: `init`, `mode`, `path`, `status`, `phase`, `squash`, `done`, `submit` and `push`, each taking PLAN_FILE. Its exit codes: 0 ok, 2 usage or malformed plan, 3 a refused precondition (the message names it), 5 `gh` failed.

- **A run that began before stacked execution is not stacked.** First run `node scripts/stack.mjs path PLAN_FILE`. When the file it prints does not exist and the workspace ledger already holds a `Task <N>: complete` line, the run began before stacked execution: its completed tasks sit on an old feature branch, and phase 1 would start from the trunk and strand them. Skip `init`, `phase`, `squash`, `done`, `submit` and `push` for the whole run, ledger `Ruling: run began before stacked execution — no stack`, and finish on the current branch: methodology:finishing-branch's menu with no state file applies. As a second guard, `node scripts/stack.mjs phase PLAN_FILE 1` itself exits 3, naming HEAD's branch, when HEAD is on a branch other than the trunk that holds commits the trunk lacks.
- After the workspace and the tracking paths, run `node scripts/stack.mjs init PLAN_FILE` once, before Task 1. It prints the stack state as JSON and writes it to `<repo root>/.methodology/stack/<plan file stem>.json`. It picks the mode: `github` (phase branches pushed, one draft PR each) when `gh`, `gh stack` and a GitHub remote are all available, else `local`. `init` is safe to re-run: when the state file exists it prints it and changes nothing, which is how a resumed run finds its stack.
- **Committed tracking mode stops the run.** `init` exits 3 with `committed tracking mode cannot hold one commit per task: switch with triqual progress-init --store (or --local)`. Stop before Task 1 and tell your human partner to switch with `triqual progress-init --store` (or `--local`). Any other exit 3, and exit 2, names its cause: rule on it, ledger the `Ruling:`, and fix it or stop if every path forward is a guess.
- **Push authorization.** Pushing this plan's phase branches, opening their draft PRs and marking them ready for review after the final review is allowed only with a ledger line `Authorization: push phase branches and draft PRs — handoff <date>`, which you write yourself at setup, before Task 1, when your human partner chose (or confirmed) the execution at the writing-plans handoff in this conversation, or `Authorization: push phase branches and draft PRs — setup <date>`, which you write on a yes below. When the ledger lacks any `Authorization:` line and this conversation holds no such choice (a new session on an existing plan), ask once, before Task 1. A yes: write the `setup <date>` line. A no: run `node scripts/stack.mjs mode PLAN_FILE local` and ledger `Authorization: declined — stack in local mode`; the run goes on with local branches only. Any `Authorization:` line, the declined one included, means the question was answered and is never asked again.

### Fence

Fence is a policy harness that denies calls under protected paths. It is optional: detect it once at setup. Fence is detected when `command -v fence` finds it and `fence version` exits 0 (two plain commands, one after the other). Write one ledger line, `Fence: <version>` (the first line `fence version` prints) or `Fence: none`; a resumed run reads the last such line instead of detecting again. Without fence nothing here applies and the Task Skills section is used as written. [Denied by Policy](#denied-by-policy) applies to every run, whatever that line says, because the line can be stale.

With fence detected, installing a skill is the human's step, never the implementer's: an install writes many files under fence-protected paths, outside this checkout. The pinned `headjack add` printout runs only when fence is detected, once per task whose brief has a `**Skills:**` line, before its first dispatch (a fix round does not print it again). A coordinator task follows it too.

1. Run `triqual suggest "<the task's title and goal>"` (text mode) and print the pinned install commands in its block for the slugs of the `**Skills:**` line. When it prints nothing or exits non-zero, print one command per slug yourself: `HEADJACK_MODE=<mode> headjack add <slug> --to claude --session --source plan`, with `<mode>` taken from the `mode` of the `--json` document (it is on the document, never on a suggestion) of `triqual suggest "<the task's title and goal>" --json`: `hosted` prints `HEADJACK_MODE=remote`, `local` prints `HEADJACK_MODE=local`, and any other value prints no prefix; and a slug only when it matches headjack's slug rule `^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$`: skip any other slug and say so.
2. When `HEADJACK_URL` is not set and the vault is hosted, tell your human partner to set it before running the commands.
3. Then ask the human to run them and to answer when they have, ledger `Skills: T<N> printed for the human — <slugs>`, and dispatch the task only after that answer. A human who declines gets the task dispatched anyway, with `Ruling: T<N> skills not installed — human declined — <what it costs if wrong>` in the ledger; the implementer then reports a missing skill instead of installing it.
4. Dispatch with the Task Skills section in its fence form (see [implementer-prompt.md](implementer-prompt.md)) and a line in the dispatch saying fence is active: the implementer neither adds nor removes a skill.

### Read the plan

Read the plan once, note its context, Global Constraints, Review Focus and `**Sensitive paths:**`, and create a todo per task. The scripts read it with `scripts/lib/plan.mjs`, the same reader as `triqual tasks`, so every reader agrees on task boundaries and fields. If the plan names a Spec, read less of it. At setup and at each resume, read the plan, the spec's `## Units` and the current phase's `## Delivery Slices` entry, not the whole spec (a spec without those headings is read whole). Before writing a `Ruling:`, read the spec sections the ruling depends on: the spec stays binding, and conflicts inside the plan resolve against it. The phase and seams reviewers get the whole spec. A plan with no reachable spec gets a ledger note saying so — rulings made without one are provisional.

Check the roles once: a task role the `roles` plugin does not define, or a reviewer role named as a task's role, is a stop (see Role Dispatch). Hunters, and a safety gate that cannot be dispatched at all, follow the skip rule at their first dispatch (see When the stage does not run).

### Tiers at setup

Every task has an effective tier before its first dispatch. Write one ledger line per task, `Tier: T<N> <tier>`, with its effective tier.

- **A tiered plan** (every task declares `**Tier:**`): the effective tier is the declared tier, or the higher `effectiveTier` that `triqual tasks export --json` already holds for a resumed run.
- **A tierless task** (a plan written before 1.0, or a resumed 0.7.x execution): a missing tier reads as `standard`. Give each pending tierless task its effective tier by the tier rubric, raising only: a task the rubric makes heavy is raised, when opted in, with `triqual tasks retier T<N> <tier> --plan <plan> --reason "<text>"` (reason `setup rubric: <criterion>`), and every other task stays standard; a tierless `roles:complex-implementer` task becomes heavy. Ledger each raise as `Tier raised: T<N> standard → heavy — setup rubric: <criterion>`.
- **The tier rubric** (the one writing-plans applies): **heavy** — any of: security-relevant code (auth, permissions, secrets, sandboxing, policy engines, parsing untrusted input, gate/enforcement hooks), live state or migrations (stores, schemas, installed setup), a contract other code parses (hook I/O, file formats, the plan format, machine-read CLI output), `roles:complex-implementer`; the task's reason is on the line under `**Tier:**`. **light** — only docs, comments, config values, version bumps, renames with no behavior change, and small code fixes within the light code allowance. **standard** — everything else. A tierless task never reads as light: the rubric only raises.
- **Not opted in:** there is no `retier`: the ledger's last `Tier:` or `Tier raised:` line for a task is its effective tier, and the floor you pass to `tier-check`.

A tier is never lowered: not by you, not by a reviewer, not on your human partner's word. `retier` refuses a lowering (exit 2), and a raise stays for the rest of the task, its fix rounds and any reopen.

### Pre-flight scan

Before dispatching Task 1, scan the plan once for conflicts, writing down what you checked as you check it:

- tasks that contradict each other or the plan's Global Constraints
- anything the plan explicitly mandates that the review rubric treats as a defect (a test that asserts nothing, verbatim duplication of a logic block)
- a declared tier the rubric contradicts (a light task that changes behavior beyond the light code allowance, a heavy trigger in a standard task): raise it now with a `Tier raised:` line (and `retier`, when opted in), never lower one

The scan's output is a table, not a verdict, and it lists only task pairs that share a file or an interface, not one row per task. One row for every pair of tasks that share a file or an interface: the two tasks, what one produces against what the other consumes, and what you found. A task whose own text contradicts itself (the tests it specifies against the code it specifies, the files it creates against the files it later touches) gets a row of its own, and only then. A plan with no such pair gets one ledger line saying so. "The scan is clean" without those rows or that line is not a scan you ran. Write the table to the ledger, rule on each conflict beside its row, and dispatch Task 1. The review loop remains the net for conflicts that only emerge from implementation.

## Role Dispatch

Every dispatch goes to a `roles:*` agent (plugin `roles`), and no dispatch passes a model: each role's definition pins its model and effort, and a model in the dispatch would override that pin. Choose the role; never choose a model.

- **Default:** `node scripts/task-brief PLAN_FILE N` copies the task's `**Role:**` line into its brief; a task with no `**Role:**` line is `roles:tdd-implementer`.
- **`roles:tdd-implementer`, `roles:complex-implementer` or `roles:review-fixer`** (the last only in plans written before 1.0): dispatch [implementer-prompt.md](implementer-prompt.md), with its header's `<task role>` filled with that role. A plan marks a task `roles:complex-implementer` (Opus) for multi-system changes, migrations of live state, or work where a mistake is costly; such a task is heavy.
- **`roles:phase-orchestrator`:** dispatched by the main session once per phase with [orchestrator-prompt.md](orchestrator-prompt.md) (see The Thin Controller), never a task's role: a task whose `**Role:**` names it is not a task role, and stops the run like any other (the fourth stop).
- **`coordinator`:** you run the task yourself (see Coordinator tasks).
- **Any other role**, a reviewer role included (`roles:spec-reviewer`, `roles:safety-reviewer`, `roles:hunter`, `roles:final-adversarial-reviewer`, `roles:brief-writer`) or a misspelled one: stop and ask your human partner. Never dispatch it, and never substitute another role for it.
- **Reviews:** by the task's effective tier (see Tiers), never the task's own role: `roles:hunter` ([hunter-prompt.md](hunter-prompt.md)), `roles:safety-reviewer` ([safety-review-prompt.md](safety-review-prompt.md)), `roles:spec-reviewer` ([task-reviewer-prompt.md](task-reviewer-prompt.md)).
- **Re-reviews:** the role or roles that raised the findings ([re-review-prompt.md](re-review-prompt.md)).
- **Fix rounds:** `roles:review-fixer`; a `roles:complex-implementer` task keeps its own role.
- **Seams review:** `roles:final-adversarial-reviewer`, once per multi-phase plan ([final-review-prompt.md](final-review-prompt.md), its Seams Scope).
- **Briefs:** `node scripts/task-brief PLAN_FILE N` extracts each brief mechanically, at no cost. Dispatch `roles:brief-writer` only when a task's plan text lacks interfaces that must come from the current code.

**Turn count beats token price.** Wall-clock and context cost scale with how many turns a subagent takes. The role pins the model; what you control is the dispatch: a brief that carries the exact values, the interfaces the task touches, and nothing else.

### Coordinator tasks

A `coordinator` task is run by the controller, the main session, never by the phase orchestrator (its role disallows `Edit` and `NotebookEdit`, and it never edits product code): the orchestrator hands over one that edits a file (see The Thin Controller). It is light: a no-code step (a rollout step, a status update) or a small, low-risk change or fix within the light code allowance (see Tiers). In a tiered plan registration already refused a coordinator task that is not light; in a tierless plan a coordinator task stays at its setup tier (standard at least), because no tier is lowered. It keeps the discipline of a dispatched task: the same ledger moves, TDD when it changes behavior, the implementer template's Tracking and Task Skills sections followed by you, the same report file the reviewers read, its own commit, `tier-check` and the review its tier calls for. When `tier-check` raises it, its review runs at the raised tier with the controller as author, and any fix round goes to `roles:review-fixer`, never to the controller. Its `task-review` record carries `"coordinator": true`.

## Tiers

The effective tier sets the review. Spec U4, verbatim:

| Effective tier | Round 1 (together) | Round 2 | Fix-round re-review |
|---|---|---|---|
| heavy | 2 hunters: `correctness` + `security` or `state`, picked from the task's heavy reason line + safety gate | `roles:spec-reviewer` on every candidate and spec fit | scoped re-review by the raising role(s), always |
| standard | safety gate + `roles:spec-reviewer`, in parallel; no hunters | none: the spec review ran with the gate | scoped re-review, except a fix that applies an approved `Ruling:` verbatim and touches no security logic |
| light | safety gate | none, unless the gate reports a finding or `Cannot verify` (then `roles:spec-reviewer` runs on that item) | the gate re-checks |

- **Hunters belong to the heavy tier only:** a heavy task sends exactly two, a standard or light task none. The second hunter is picked from the task's heavy reason line (the plain line under its `**Tier:**`, see the tier rubric): `security` when the reason line names security code, `state` when it names live state or a parsed contract. A task raised to heavy, or declared heavy with no reason line (a plan written before 1.0.2), has no reason line (and a `roles:complex-implementer` task keeps its reason under `**Role:**`): take the category from the raise reason or that line, `security` by default. Sending more than the tier's count needs one ledger line, `Budget: hunters <tier count> → <used> for T<N> — <reason tied to the diff>`; never send fewer than the tier's count. `task-close` reads the task's last `Budget:` line of the attempt: more hunters than the tier's count are recorded from the categories whose `task-<N>-candidates-<category>.md` files exist, and fewer (an owner's override, ledgered the same way) are recorded as sent, the others not as `failed`.
- **The safety gate runs at every tier.** Never skip the task review (the one exception is a task with no commit range: see When the stage does not run): every task with commits gets at least the safety gate, whatever its tier and whoever asks.
- **`tier-check`** (`node scripts/tier-check PLAN_FILE N BASE HEAD --floor <tier>`) prints `ok <tier>` or `raise <from> <to>: <reason>: <paths>` and exits 0; exit 2 is bad input (unknown task, bad range, bad floor), an error to fix, never a reason to skip the check. Its rules, applied in order and never lowering: **→ heavy** when the diff touches a sensitive path (default `**/hooks/**`, `**/setup/**`, `**/*schema*`, `**/migrations/**`, `**/drizzle/**`, `.github/**`, `plugins/workflow-gate/**`, plus the plan's `**Sensitive paths:**`) or changes more than 300 lines (added + removed); **light → standard** when the diff touches anything outside the light classes (Markdown outside `**/skills/**`, `**/agents/**`, `**/rules/**`, `**/commands/**`, `**/templates/**`, `**/*-prompt.md`, `**/CLAUDE*.md`, `**/AGENTS*.md`; JSON whose only changed key is `version`; lockfiles are never light), beyond the **light code allowance**: other files stay light while, together, they add or remove at most 20 lines (test lines count), create no file (a new test file is a raise; cases added to an existing test file are not), and touch no excluded Markdown class or sensitive path.
- **The floor** is the task's current effective tier: its `effectiveTier` in `triqual tasks export --json`, else its declared tier; not opted in, the ledger's last `Tier:` or `Tier raised:` line for it.
- A raise is recorded with `triqual tasks retier T<N> <to> --plan <plan> --reason "<reason from tier-check>"` (opted in) and the ledger line `Tier raised: T<N> <from> → <to> — <reason>`, before any reviewer of the new tier is dispatched.

## The Thin Controller

The main session dispatches one `roles:phase-orchestrator` per phase, waits for it once and only decides; the orchestrator runs the phase's task loop (The Task Loop, below) with the same three scripts, tiers and stops. There is one set of rules: the orchestrator follows this skill, and no second implementation of the loop exists. The orchestrator is never a task's role, and it is the only role that dispatches others.

**The main session, per phase:**

1. Run `node scripts/stack.mjs phase PLAN_FILE N`.
2. Dispatch one orchestrator with [orchestrator-prompt.md](orchestrator-prompt.md): the plan path, the phase number, the ledger path, the plan's Global Constraints and a resume note (a fresh phase says so). Pass no model.
3. Wait for it once, blocking, by the waiting rule of The Task Loop; the orchestrator's completion arrives as its final message.
4. Read its summary and act on it: write `Orchestrator: P<n> — <summary first line>` to the ledger, then route on it. `Phase: P<n> done` goes on to the Phase check, the phase review, `done`, `submit` and the break (steps 7 and 8). Three `BLOCKED:` kinds are not stops and each has its own route, which never asks your human partner and writes no ruling: `BLOCKED: nested dispatch unavailable` goes to Fallback, `BLOCKED: rate limit — <role> T<N>` goes to Rate limits (the run ends) and `BLOCKED: coordinator task T<N> — …` goes to Coordinator tasks. Any other `BLOCKED:` line, a stop or a script error the steps cannot resolve, goes to On `BLOCKED`.

The main session never reads code, diffs or reports: it reads the summary, the ledger and what a script prints, and in the phase review (step 8) only the reviewers' verdicts. The fallback is the exception: the main session then runs the loop itself and reads what the loop reads. Work that needs them goes to a role: a Phase check failure's reopen and a phase-review fix go to an orchestrator or a fixer it dispatches (the resume note names the failing command and its last lines, never a diff).

**The summary.** At most 20 lines, in this order: `Phase: P<n> <done|blocked>`, `Tasks: T<N> <sha>, ...`, `BLOCKED: <stop> — <details>` (only when blocked), then the lists `Rulings I made:`, `Open minors:` and `Errors and fallbacks:`, each with its lines under the heading and `none` when empty. A summary that would pass 20 lines keeps `Phase:`, `Tasks:` and `BLOCKED:` and shortens each list to its first lines plus `+<k> more in the ledger`. Rulings and errors are also in the ledger, so Finish collects them from there.

**A stop.** On any of the seven stops, and on any script error its steps cannot resolve, the orchestrator starts nothing new, lets running agents finish their current step, writes `Task <N>: awaiting landing` for any task that finished but is not landed, and returns `BLOCKED: <stop> — <details>` as the BLOCKED line of its summary (`Phase: P<n> blocked` first).

**On `BLOCKED`.** The main session asks your human partner for the decision the stop names, with the orchestrator's details beside it, and nothing else moves first. It then writes the decision to the ledger as `Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>` (for more rounds after the breaker, `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`), makes the ledger move the decision implies (`triqual tasks start T<N> --plan <plan>` for a blocked task, opted in), and only then dispatches a new orchestrator for the same phase, with a resume note that names the ruling. The new orchestrator resumes from the ledger: a task with a `Task <N>: complete` line is never dispatched again unless the resume note reopens it (a Phase check failure's `triqual tasks reopen`, which writes no ledger line), a `Task <N>: awaiting landing` task is closed first with `task-close`, and for a breaker stop it carries out the rest of The breaker's Park or More rounds path. A final message that begins with `BLOCKED` instead of `Phase:` is a denial (a stop and the three kinds above arrive as the BLOCKED line of a summary that begins with `Phase:`): [Denied by Policy](#denied-by-policy) applies, the main session relays the denied call, its path and the refusal text verbatim, and dispatches nothing until your human partner answers.

**Fallback.** If the orchestrator cannot be dispatched (the `roles` plugin is too old and the role is missing), the main session sees the failed dispatch itself; if the orchestrator cannot dispatch (Codex depth 1, a harness refusal) it returns a blocked summary whose BLOCKED line is `BLOCKED: nested dispatch unavailable` with the error. Either way the main session writes `Error: orchestrator P<n> — exit 1 — <first line of the error>` to the ledger, says in one line to your human partner that it runs the phase itself, and runs the phase loop itself with the same scripts, dispatching the task roles as The Task Loop says. Announced, never silent; it is no stop and needs no ruling, and the next phase dispatches an orchestrator again.

**A cap denial.** A workflow-gate cap denial of a dispatch names the seconds to wait: wait the seconds the denial names and retry the same dispatch. It is neither a stop nor a fallback, and it holds at both levels, for the main session's dispatch of an orchestrator and for the orchestrator's dispatches of its roles.

**Coordinator tasks.** The orchestrator never edits product code: its role disallows `Edit` and `NotebookEdit`, and every change to the repository is a role agent's commit. A coordinator task that needs no file edit (a rollout step, a status update) it runs itself; one that edits a file ends the phase with the BLOCKED line `BLOCKED: coordinator task T<N> — edits files, run it in the main session`, which is a handoff and not one of the seven stops: the main session asks no one and writes no ruling, runs the task itself (see Coordinator tasks), then dispatches a new orchestrator for the rest of the phase.

## The Task Loop

**Who runs this loop.** The phase orchestrator, one phase at a time; the main session only in the fallback (see The Thin Controller).

**One task, one dispatch, one commit.** Each task is its own dispatch (or its own resume, see Batched light dispatch) and its own commit; you never compose a batch brief or send several tasks to one subagent at once. The plan sizes the tasks, and the commit is the unit the review and the squash read.

Everything you paste into a dispatch prompt — and everything a subagent prints back — stays resident in your context for the rest of the session. Hand artifacts over as files.

**Waiting on dispatched subagents:** never poll a wait interface with short timeouts, and never sit in one silent, open-ended wait either. While you have local work — ledger updates, packaging the next review, reading reports — keep working; child results arrive on their own. When you are genuinely idle, wait in bounded stretches (five to ten minutes, where your platform allows), and between stretches post one line of status and reconcile your live children: list them, and chase any that finished without reporting. Both levels follow it, the main session waiting for its orchestrator and the orchestrator waiting for its roles. In Claude the main session simply receives the orchestrator's completion; in Codex it waits with `wait_agent` in bounded stretches, the longest timeout Codex allows.

**Rate limits.** A dispatch to any role (an implementer, a fixer or a reviewer, on any model) that is rate-limited mid-plan is not a stop: wait in the bounded stretches above and retry the same dispatch, writing one `RateLimit: <role> <time>` ledger line per stretch, with `<time>` the local time as `HH:MM`. After about 6 stretches without success, end the run with a final message naming the task and listing the ledger's `Ruling:` lines (see Finish); the ledger makes the plan resumable. When the orchestrator meets it, it follows the same stretches and, after about 6, returns `BLOCKED: rate limit — <role> T<N>`; the main session then ends the run as this rule says. It never swaps the model in a dispatch: the dispatch keeps the same role and passes no model. A hunter with no Haiku quota is not this case: it is the skip rule (see When the stage does not run). The safety gate runs on Sonnet and follows this rule.

### Start the phase

Before the first task of phase N, the main session runs `node scripts/stack.mjs phase PLAN_FILE N`. It prints the phase branch and leaves HEAD on it: it creates the branch on top of phase N−1's (the trunk's, for phase 1). It needs a clean tree and phase N−1 submitted (in local mode, done) and exits 3 otherwise. Every task of the phase then commits on that branch. A resumed run starts the phase the stack state (`status`) shows active or pending, never one already submitted.

### 1. Start the task

Run `node scripts/task-open PLAN_FILE N` from the main checkout. One call does the three things this step used to: when opted in and the task is `pending` or `blocked`, the `start` move (a task the ledger already shows started is not moved again); the brief, written like `node scripts/task-brief PLAN_FILE N` writes it (the task's full text, its `**Tier:**`, `**Role:**` and `**Skills:**` lines included, in a uniquely named file; never make a subagent read the whole plan file); and BASE, the `BASE: T<N> <sha>` ledger line (the last one counts), recorded from `HEAD` when the ledger has none. A task the tracking ledger already shows started (`in_progress`, `in_review` or `done`) with no `BASE:` line, such as a 1.1.0 ledger resumed mid-task, is refused with exit 3, because `HEAD` is no longer where the task began: append `BASE: T<N> <sha>` yourself, the sha being the commit before the task's first commit, and run it again. BASE is never `HEAD~1`, which silently drops all but the last commit of a multi-commit task. It prints, in this order:

- `brief:` the brief path, which goes into the dispatch;
- `report:` the implementer's report file, named after the brief (brief `…/task-N-brief.md` → report `…/task-N-report.md`); the file is not created;
- `base:` the task's BASE: the review package, `tier-check` and the squash all read `BASE..HEAD`.

It is idempotent, so a crash between the move and the dispatch is repaired by running it again. It exits 0 ok, 2 usage, 3 a refused precondition (a linked worktree, an unknown task, a move the ledger refuses) and 1 any other failure, and before a non-zero exit it appends `Error: task-open T<N> — exit <code> — <first stderr line>` to the ledger. An `Error:` is never worked around: read its cause and fix that.

### 2. Build

Dispatch the task's role with [implementer-prompt.md](implementer-prompt.md). Your dispatch contains: (1) one line on where this task fits; (2) the brief path, introduced as "read this first — it is your requirements, with the exact values to use verbatim"; (3) interfaces and decisions from earlier tasks that the brief cannot know; (4) your resolution of any ambiguity you noticed in the brief; (5) the report-file path and report contract; (6) the template's Denied by Policy section, when opted in the Tracking section, and when the brief has a `**Skills:**` line, the Task Skills section in its fence form when fence is detected (after the printout in Fence). Exact values appear only in the brief.

- A dispatch prompt describes one task, not the session's history. Never paste accumulated prior-task summaries into later dispatches: a fresh subagent needs its task, the interfaces it touches, and the global constraints.
- The dispatch carries the no-subagents contract (it is in the template): the implementer never dispatches subagents, and never a reviewer. Review arrives from you, after the report.
- If an earlier task parked a finding in the area this task touches, carry a pointer to that ledger entry.
- Record the implementer's agent identity from the dispatch result: fix rounds 1–3 of a `roles:complex-implementer` task resume it, and batched light dispatch resumes it.
- Never dispatch two implementers in parallel (conflicts).

#### Batched light dispatch

For consecutive light tasks of one phase whose role is `roles:tdd-implementer`, dispatch the implementer once, for the first of them, and then resume that same implementer for each next task instead of dispatching a fresh one: its context already holds the codebase, which is most of the cost of a small task.

- One task at a time. The next task is sent only after the previous task's review and `task-close` finished; never queue two briefs in one message.
- Run step 1 (`task-open`) for each task as usual: its own `start` move, its own brief, its own report file, its own BASE (recorded from `HEAD`, the squashed commit of the previous task). Resume with the "Next task" message of [implementer-prompt.md](implementer-prompt.md).
- `task-prep`, the review and `task-close` stay per task: each task gets its own `tier-check` on its own `BASE..HEAD`, its own review package and review, its own squash and `done`, its own `task-review` record.
- A task that `tier-check` raises above light ends the batch: its review runs at the raised tier as usual, and the next task gets a fresh dispatch. So does a task that is not light, a task of another role, a new phase, and a resume your harness cannot make.

#### Handle the report

Implementers report one of four statuses:

- **DONE:** go to step 3 (`task-prep` makes the `review` move when opted in).
- **DONE_WITH_CONCERNS:** read the concerns first. Correctness or scope concerns are addressed before review; observations are noted and the task goes to review (step 3 as for DONE).
- **NEEDS_CONTEXT:** provide the missing context and re-dispatch.
- **BLOCKED:** A BLOCKED reply that reports a denied call goes to [Denied by Policy](#denied-by-policy), with no re-dispatch and no ruling. Otherwise a context problem gets more context and a re-dispatch to the same role; a task that needs more reasoning than its role brings is broken into smaller pieces or re-dispatched with your ruling on the approach (never override the role's model); a plan defect gets a ruling, ledgered, carried in the re-dispatch. Never ignore an escalation or force the same dispatch to retry without changes.

If the implementer asks questions — before starting or mid-task — answer clearly and completely before it implements.

### 3. Check the tier

Run `node scripts/task-prep PLAN_FILE N` (from the main checkout, as every script of this loop; `--head <sha>` names the head of a task that is not on the main checkout's `HEAD`). One call does, in order: when opted in, the `review` move; `node scripts/tier-check PLAN_FILE N BASE HEAD --floor <tier>` on the task's whole range, with the floor of Tiers (the tracking ledger's effective tier, else the last `Tier:` or `Tier raised:` line); on `raise <from> <to>: …`, the raise: a raise is recorded with `triqual tasks retier` before the review (opted in) and always with the ledger line `Tier raised: T<N> <from> → <to> — <reason>`; the review package of `BASE..HEAD`; and the ledger line `Prep: T<N> r<R> <head sha>`. It prints, in this order:

- `tier:` the effective tier after the check: the review of step 4 runs at it, never at the declared one;
- `hunters:` `correctness` plus `security` or `state` (the second picked from the heavy reason line, see Tiers) for a heavy task's first review, else `none`;
- `package:` the review package path, or `none` for a range with no commit (it then wrote `Review: T<N> — no commits, nothing to review` itself: no reviewer runs, see When the stage does not run);
- `round:` the review round `<R>`: 1 for the first review, then one more for each fix round;
- `full-review:` `yes` only for a fix round that raised the tier (see 5. The fix loop), else `no`.

A second call at the same head is a rerun: it reuses the round, prints the same and appends no second `Prep:` line. Any other call once a `Prep:` line exists must be a fix round (`--fix-round`). It exits 0 ok, 2 usage, 3 a refused precondition and 1 any other failure, and before a non-zero exit it appends `Error: task-prep T<N> — exit <code> — <first stderr line>` to the ledger.

### 4. Review the task

Per-task reviews are task-scoped gates; the broad review happens once per phase, in the phase review (see 8. Review the phase), and the final review looks across phases. Every task with commits is reviewed on one review package, at its effective tier, by the Tiers matrix. Implementer self-review never replaces the task review.

- **The package:** the `package:` line of `task-prep` — pass every reviewer that path. The output never enters your own context, and the reviewer sees the commit list, stat summary and full diff with context in one Read call. It covers the BASE `task-open` recorded, never `HEAD~1`. Never dispatch a reviewer without a diff file; a hunter is no exception.
- **Reviewer inputs:** the gate and the spec reviewer each get the brief, the report file and the package, the effective tier, plus the global constraints that bind the task (copied verbatim from the plan's Global Constraints or the spec: exact values, formats and stated relationships). The gate also gets the task's canary rules and, when opted in, the tracking files it must expect in the diff (in store mode: none is expected, and an added or modified tracking file is a finding); the spec reviewer of a heavy task also gets every candidates file. A hunter gets the inputs of [hunter-prompt.md](hunter-prompt.md).
- **Footers and saved outputs.** The gate, the spec reviewer and the re-reviewer end their final message with the v1 footer their prompt defines (the marker `<!-- triqual-review v1 -->`, a `role:` line, a `findings:` line with the counts per severity and, for the spec reviewer, one `candidate:` verdict per candidate). These roles cannot write files, so you save each final message unchanged, before you act on it, to `<workspace>/task-<N>-<role>-r<R>.md`: `<role>` is `safety-reviewer`, `spec-reviewer` or `re-reviewer`, and `<R>` is the `round:` line of `task-prep`. A final message without the footer is sent back to its reviewer to be completed: `task-close` builds the `task-review` record from these files and never guesses a count. Hunters keep writing their `task-<N>-candidates-<category>.md` files. `task-close` reads the lowest round saved for the gate and for the spec reviewer; a re-reviewer's file is the audit trail of its round and is not read.
- Do not add open-ended directives ("check all uses") without a task-specific reason, and do not ask a reviewer to re-run tests the implementer already ran on the same code.
- **Never pre-judge.** Never instruct a reviewer to ignore or not flag a specific issue. If the prompt you are writing contains "do not flag," "don't treat X as a defect," "at most Minor," or "the plan chose" — stop: you are pre-judging. You never tell a verifier how to rule on a candidate, and you never drop a hunter's candidate before round 2.

#### Round 1

- **Heavy:** dispatch together, in the background, in one message: the 2 hunters (`roles:hunter`, the categories on the `hunters:` line of `task-prep`: `correctness` and the second category picked from the heavy reason line, see Tiers) and the gate (`roles:safety-reviewer`), each with the package path. Each hunter writes `<workspace>/task-<N>-candidates-<category>.md`, at most 5 candidates.
- **Standard:** no hunters. Dispatch together, in the background, in one message: the gate (`roles:safety-reviewer`) and `roles:spec-reviewer` ([task-reviewer-prompt.md](task-reviewer-prompt.md) without its candidates sections), each with the package path and its inputs.
- **Light:** dispatch the gate alone.
- Heavy: wait up to a soft limit of 10 minutes after the gate's report for every hunter still running. One still running then is recorded `failed` (timeout), and its output is ignored if it arrives later. A hunter that fails, hangs or returns nothing usable is recorded `failed` for its category, and round 2 goes on with the other candidates. No hunter ever blocks a task.
- Ledger: `Round 1: T<N> — hunters <done>/<sent>, safety ok` (`<done>` counts usable candidates files, a valid empty file included, and a standard or light task writes `hunters 0/0`; `safety ok` means the gate reported; its findings go to the fix loop after round 2).

#### Round 2

- **Heavy:** dispatch `roles:spec-reviewer` with [task-reviewer-prompt.md](task-reviewer-prompt.md): its inputs plus every candidates file of round 1. It returns spec compliance, task quality and one verdict per candidate. The verdicts are `confirmed` (with a severity), `refuted`, `duplicate-candidate` and `duplicate-review`, as the template defines them. A missing verdict (spec, quality or any candidate) makes the review incomplete: send it back. Ledger: `Round 2: T<N> — verdicts <n>/<n>`.
- **Standard:** the spec review already ran with the gate in round 1, with no candidates to verdict. A missing spec or quality verdict makes it incomplete: send it back. Ledger: `Round 2: T<N> — verdicts 0/0`, once both reports are in.
- **Light:** no round 2 when the gate is clean. When the gate reports a finding or a `Cannot verify` item, dispatch `roles:spec-reviewer` with the template's Light Items section holding exactly those items; it judges those items only. Ledger: `Round 2: T<N> — light items <n>`.
- A `confirmed` candidate enters the fix loop like any spec-review finding, at the severity the verifier gave it.
- The spec reviewer may report "⚠️ Cannot verify from diff" items. They do not block the rest of the review, but you resolve each one yourself before completing the task: you hold the plan and cross-task context the reviewer lacks. An item you confirm as a real gap enters the fix loop.

#### When the stage does not run

- **No commit range.** `review-package` exits 3 with the message `empty commit range` on an empty range (a coordinator task with no code diff): no reviewer runs at all and the `task-review` record carries no hunters, a gate with 0 findings and a spec that did not run. Write `Review: T<N> — no commits, nothing to review` to the ledger and complete the task. Only the `empty commit range` message means no commits: any other exit 3 (for example `HEAD is not a descendant of BASE`) is an error to fix, never a reason to skip the review.
- **Unavailable hunters.** When a hunter's error arrives before the agent runs (`roles:hunter` is an unknown agent type because the `roles` plugin is too old, the hunter's pinned Haiku id is an unresolved model, or there is no Haiku quota), skip the hunters for the rest of the plan with one ledger line, `Skipped: hunters — <cause>` (it changes nothing for a standard or light task, which sends none); the safety gate keeps running (a rate-limited gate follows the Rate limits rule, never this one).
- **Unavailable safety gate.** When the gate's error arrives before the agent runs (`roles:safety-reviewer` is an unknown agent type or its model is unresolved), skip the hunters and the safety gate for the rest of the plan with one ledger line, `Skipped: hunters and safety gate — <cause>; safety checklist runs in the spec review`. The safety checklist is never skipped: it moves into round 2, where `roles:spec-reviewer` runs it through the Safety Checklist section of [task-reviewer-prompt.md](task-reviewer-prompt.md), with the gate's inputs, at every tier (a light task then gets the spec reviewer with the Safety Checklist sections, and so does a standard task, whose spec reviewer dispatched in parallel with the gate is dispatched again with them). Its safety findings enter the fix loop like the rest. Look for a `Skipped:` line in the ledger before every round 1, so the skip survives compaction. A run that starts and then fails is not a skip: a gate that fails is re-dispatched; only hunters are recorded `failed`.

### 5. The fix loop

The loop triggers when the review reports spec ❌, any Critical or Important finding (the gate's included), a `confirmed` candidate at `critical` or `important`, or a ⚠️ item you confirmed as a real gap.

Before the loop starts, two routes leave it:

- Minor findings, `minor` confirmed candidates included, go to the ledger as you go (`Task <N>: minor (deferred): <one-liner>`, and the phase review (see 8. Review the phase) rules on them). Minor findings never enter the loop.
- A finding labeled plan-mandated — or any finding that conflicts with what the plan's text requires — is yours to rule on: weigh it against the plan text, decide with the spec as the binding authority, and ledger the ruling before you act on it.

Everything else enters the loop. A fix round is one fix dispatch, one `tier-check`, and the re-review the tier calls for. Five rounds maximum per task.

- **Ledger moves:** none by hand. When the fixer reports back, run `node scripts/task-prep PLAN_FILE N --fix-round`: it makes the `rework` and `review` moves (opted in), runs the round's check and the cumulative one (below), writes the round's package, appends `Prep: T<N> r<R> <head sha>` and prints the lines of step 3; `full-review:` and the package say what the round reviews. It exits 3 on a fix round with no new commit since the last `Prep:` head.
- **Who fixes:** rounds 1–3 resume the same `roles:review-fixer` (round 1 dispatches it with the open findings verbatim, the brief path and the report-file path; when the task's own role is `roles:review-fixer`, round 1 resumes the implementer); rounds 4–5 dispatch a fresh `roles:review-fixer` each round, with the brief path, the report-file path, the open findings, and this framing: "A prior fixer attempted this task [N] times; you own it now. Read the report file for what was tried." A `roles:complex-implementer` task keeps its role: rounds 1–3 resume its own implementer, rounds 4–5 a fresh `roles:complex-implementer`. A coordinator task's rounds go to `roles:review-fixer`, never to you. If your harness cannot message a live subagent, dispatch a fresh one with the same three inputs.
- Every fix dispatch carries the implementer template's Denied by Policy section (the fixer's agent definition carries the rule too, but a fix dispatch has no template of its own), its Tracking section when opted in, and its Task Skills section when the brief has a `**Skills:**` line (in its fence form when fence is detected).
- **Fix commits fold into the task's own commit.** A fix round commits with `git commit --fixup=<the task's first commit>`, never an amend, a rebase or a reset: name that commit (the first line of `git rev-list --reverse BASE..HEAD`) in the fix dispatch.
- **Evidence:** before the re-review, confirm the fix report names the covering tests, the command run and its output; a fix that changes behavior starts with a test that reproduces the finding.
- **Re-check the tier every round.** `task-prep --fix-round` does it, with FIX_BASE the head of the last `Prep:` line (the head the previous review saw): `tier-check` runs again on each round's `FIX_BASE..HEAD` and on the cumulative `BASE..HEAD`, each with the current floor, and the re-review follows the higher tier. The round's check is `node scripts/tier-check PLAN_FILE N FIX_BASE HEAD --floor <tier> --fix-round`; `--fix-round`: with a light floor, any change outside the light classes raises to standard, so code a fix adds to a light task is reviewed (the light code allowance covers a task's first build only); the cumulative `BASE..HEAD` check never carries it. A raise is recorded before the re-review, by `task-prep`: a `Tier raised:` line, and `retier` when opted in. When a round raises the task it prints `full-review: yes`, and the raised tier's full review (its round 1 and round 2, hunters included, on the `hunters:` line) runs on the cumulative package `BASE..HEAD` it wrote, because that tier's review never ran on this task; otherwise fix rounds and re-reviews send no hunters.
- **The re-review** (on the `package:` of `task-prep --fix-round`: the `FIX_BASE..HEAD` diff) follows the matrix's last column: heavy — [re-review-prompt.md](re-review-prompt.md) to each raising role, always; standard — the same, except a fix that applies an approved `Ruling:` verbatim and touches no security logic, which you check against the ruling yourself and ledger as `Re-review: T<N> round <R> — applies Ruling verbatim, no security logic`; light — the gate re-checks. The re-reviewer verdicts each finding ADDRESSED or NOT ADDRESSED and flags new breakage in the fix diff only; new Critical/Important breakage joins the open findings; out-of-scope observations go to the ledger as deferred minors.
- **After each round,** append `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`.

Never fix findings yourself in the controller session — your context stays clean for coordination, and controller fixes skip review.

**The breaker.** When round 5's re-review still leaves Critical or Important findings open, stop dispatching: after round 5 the task is blocked and the human decides. Run `triqual tasks block T<N> "<open findings, one line>" --plan <plan>` (opted in) and write `Task <N>: blocked at fix round 5/5 — <open findings>` to the ledger; nothing is recorded yet (the task's record is written once, when it completes, with `"blocked": true`). Then stop and ask your human partner, with your adjudication of each open finding beside it: the reviewer is wrong or the point is contestable (park it), real but nothing downstream builds on it (park it, deferred), or real and load-bearing (a later task builds on it, or it reveals a plan defect: the smallest change that unblocks the dependent work). Their decision is ledgered as `Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`, and a blocked task leaves `blocked` only through `start`, so every path begins with it. **Park:** run `triqual tasks start T<N> --plan <plan>` (opted in), write `Task <N>: parked — <finding> — Ruling: <why the code stands>` for each parked finding, then run `task-close` (step 6: it counts the task's `parked` lines into the completion line, `<K> parked`). **More rounds:** run `triqual tasks start T<N> --plan <plan>` (opted in), write `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`, and continue the fix loop with those K rounds as a fresh budget; `start` already moved the task to `in_progress` and `rework` only leaves `in_review`, so run `triqual tasks review T<N> --plan <plan>` before the first `task-prep PLAN_FILE N --fix-round`, whose `rework` then has an `in_review` task to leave (round numbering goes on, `fix round 6/<5+K>`; a fresh fixer each round, as for rounds 4–5); when they run out with findings open, the breaker trips again. Never adjudicate before the cap to end a loop: that is pre-judging with a different name.

### 6. Complete the task

When the review comes back clean — or every open finding is parked with a ruling — run `node scripts/task-close PLAN_FILE N` (`--provider codex` on Codex), before anything of the next task. It reads everything first (the ledger, the saved reviewer outputs of step 4, the hunters' candidates files) and writes nothing until the record is built and valid; then, in this order:

- the squash: `node scripts/stack.mjs squash PLAN_FILE BASE` folds every commit of `BASE..HEAD` (the implementer's and every fixup) into one, with `git commit-tree`: the tree of HEAD, the message and author of the range's first commit, never a rebase and never a `git commit`, so no hook runs and no gate fires. It takes the sha the squash printed (`git rev-parse HEAD` when it printed `no commits`, a coordinator task that made none);
- when opted in, the `done` move with that sha (`triqual tasks done T<N> --commit <sha> --plan <plan>`), not repeated when the ledger already shows the task done;
- the ledger line, right away, so a crash after this point never re-dispatches a finished task: `Task <N>: complete (commits <base7>..<head7>, review clean)` with `<head7>` the squashed sha, or `(commits <base7>..<head7>, <K> parked)` with the count of the task's `Task <N>: parked` lines;
- the `task-review` record (see Records), built from the saved outputs and written with `triqual role-eval record`; the gate's and the spec reviewer's `findings:` counts are the record's `gate.findings` and `spec.confirmed`, each hunter's counts come from its candidates file and the spec reviewer's `candidate:` verdicts, and a hunter with no usable candidates file is recorded `failed` with zero counts;
- the review progress entry carrying the final sha (store mode: `triqual tracking add --commit <sha>`; local mode: `tracking write entry`), Stage/task `Plan <name> · T<N> · review`. It lands once, even on a rerun.

It prints `sha:` (the squashed commit) and `record:` (`recorded` or `already recorded`). A missing or malformed gate or spec footer, a candidate id with no verdict or with no hunter file, or a missing input is an `Error:` and nothing is written: no count is ever guessed. Fix the cause (a missing output is a reviewer to dispatch or a footer to complete) and run `task-close` again; a run that failed after the complete line is a resume that skips the squash, the move and the line and makes the record and the entry that are missing. Whether the task has commits comes from git (`BASE..HEAD`), and a task with commits must be closed at the head of its last `Prep:` line: a commit made after the review package (the implementer finishing after a no-commit `task-prep`, a late fixup) is refused with exit 3, and `task-prep PLAN_FILE N --fix-round` then reviews it. It exits 0 ok, 2 usage, 3 a refused precondition (a linked worktree, an unknown task, no BASE, commits after the last `Prep:`, a move or the squash refused) and 1 any other failure, and before a non-zero exit it appends `Error: task-close T<N> — exit <code> — <first stderr line>` to the ledger.

**Reopened tasks.** Each close leaves a marker file, `<workspace>/task-<N>-closed-<attempt>`. The saved outputs carry the review round, not the attempt, so an attempt of 2 or more (after `triqual tasks reopen`) accepts only gate, spec and hunter outputs saved after the previous marker: a reopen must save a fresh gate output and a fresh spec output (and, for a heavy task, run its hunters again or remove their earlier candidates files, which `task-close` then records `failed`), and a reopen that runs only a re-review cannot be closed until they exist. Attempt 1's counts are never reused. A reopened task is reviewed by hand (see the Phase check in step 8) and writes no new `Prep:` line, so the head check above applies to it only when it ran `task-prep`.

Then mark the todo complete and move on. Never start the next task while the review has open Critical/Important issues that are neither fixed nor parked with a ruling, and never batch these moves "until the end": the ledger is what a resumed session reads.

### 7. End the phase

When the phase's last task is complete, close the phase before starting the next:

- **Phase check.** Run the phase's `**Phase check:**` command at the tip of the phase branch; a plan with no `## Phase` heading (or no `**Branch prefix:**` line) is one phase whose check is the repository's full test command. A failure that passes on one re-run is flaky: ledger `Ruling: <test> flaky — passed on re-run — <what it costs if wrong>` and go on. A real failure reopens the phase's last task: when opted in, run `triqual tasks reopen T<N> "<reason>" --plan <plan>`, then run the fix loop on it by hand (the reopen writes no ledger line: the task's `Task <N>: complete` line stays, and the resume note of the orchestrator that does the work names the reopen) where `task-prep --fix-round` cannot serve: the squash moved the task's commits out of history, so the head of its last `Prep:` line is no ancestor of `HEAD` and `tier-check` and `review-package` refuse that range. FIX_BASE is the task's squashed commit (the sha of its `Task <N>: complete` line); when the fixer reports back, run `triqual tasks review T<N> --plan <plan>` (`reopen` left the task `in_progress`), `node scripts/tier-check PLAN_FILE N FIX_BASE HEAD --floor <tier> --fix-round` and the cumulative `BASE..HEAD` check as in any round, and `node scripts/review-package PLAN_FILE FIX_BASE HEAD` for the re-review. Close it with fresh gate and spec outputs: dispatch the gate and `roles:spec-reviewer` on `node scripts/review-package PLAN_FILE BASE HEAD`, save their final messages as in step 4 (a heavy task runs its hunters again too), then run `task-close`: its BASE is still the task's `BASE:` line, the parent of its squashed commit, its `done` move runs again and its record carries the next `attempt` (see step 6, Reopened tasks); then run the Phase check again (in a thin run the orchestrator that did the reopen returns, and the main session runs it).
- **A submitted phase is final:** never amend it, never rebase it and never force push it. A defect found in the code of an earlier, submitted phase is fixed in the current task's commit; at the final review it is fixed in a final fix commit.

### 8. Review the phase

When the Phase check passes, the phase gets one deep review before it closes. The main session runs this step: it passes paths (the package, the candidates files, the phase report file) to the reviewers and the fixer and reads only their verdicts. Order, pinned: last task done, Phase check, phase review, fix (if any), Phase check, `stack.mjs done`, `stack.mjs submit`. The next phase never starts before its predecessor's phase review, and nothing is submitted before it.

- **The package:** `node scripts/review-package PLAN_FILE PHASE_BASE HEAD`. The phase range is phase base..phase top: PHASE_BASE is the previous phase's branch tip, or `git merge-base <trunk> HEAD` for phase 1.
- **Round 1, the hunters.** Dispatch together, in the background, 4 hunters (`roles:hunter`, the phase mode of [hunter-prompt.md](hunter-prompt.md)): `correctness`, `security`, `spec-drift` and `state`, each with the package, the spec and the plan in place of a brief, writing `phase-<N>-candidates-<category>.md` in the workspace. Wait up to a soft limit of 20 minutes from their dispatch; a late or failed hunter is recorded `failed`, and none blocks the phase. Ledger: `Round 1: P<n> — hunters <done>/<sent>`. After a `Skipped:` line, dispatch the reviewer with no candidates.
- **Round 2, the reviewer.** First write this phase's ledger lines (`Ruling:`, `minor (deferred)` and `parked`, for this phase's tasks; for a single-phase plan also every ledger line that names no task: pre-flight, flaky Phase check and submit rulings) to `<workspace>/phase-<N>-ledger.md`. Then dispatch `roles:final-adversarial-reviewer` with [final-review-prompt.md](final-review-prompt.md), its Phase Scope filled: the range, this phase's tasks and this phase's ledger lines, with the spec, the plan, the plan's Review Focus verbatim, the package and every candidates file. The phase's `Ruling:` lines, its deferred Minor findings and its parked findings go to the phase reviewer, which rules on each as the final reviewer does. A missing verdict sends the review back. Ledger: `Round 2: P<n> — verdicts <n>/<n>`.
- **Findings.** A confirmed Critical or Important finding, and any ledger line the reviewer says must be fixed, goes to the phase fix loop: at most two rounds of `roles:review-fixer` on the phase branch, each with the findings verbatim, the phase's diff package (`node scripts/review-package PLAN_FILE PHASE_BASE HEAD`, in place of a brief), the plan's tasks of this phase, the phase report file `<workspace>/phase-<N>-report.md` that the fixer appends its report to and, when opted in, the Tracking section. Each round is its own plain `fix(...)` commit on top of the phase branch (never `--fixup`, never folded into a task commit) with its own progress entry, Stage/task `Plan <name> · P<n> fix`. Each round is followed by a scoped re-review ([re-review-prompt.md](re-review-prompt.md) on `node scripts/review-package PLAN_FILE FIX_BASE HEAD`, with the findings, the phase report file and the plan's tasks of this phase in place of a brief) by `roles:spec-reviewer`, or by `roles:final-adversarial-reviewer` when a finding was Critical, and then the Phase check. Minor findings never enter the loop: ledger each as `Task <N>: minor (deferred): <one-liner>` for the task it traces to, and the seams review (or the final message) carries it on.
- **A Phase check that fails after a phase fix** is handled inside this loop, as a finding for the next round, and never reopens a task. A failing re-review or Phase check after the second round blocks the phase: write `Phase review: P<n> blocked`, then stop and ask your human partner (the seventh stop, listed at the top of this skill).
- **The ledger line.** `Phase review: P<n> clean` (no finding to fix), `Phase review: P<n> fixed` (findings fixed, re-review and Phase check clean) or `Phase review: P<n> blocked`. A phase whose line is missing is reviewed again on resume, unless it is already submitted or complete.
- **Records:** the phase's `hunters` and `final-escapes` records, with `task: "P<n>"` (see Records).
- **Done and submit.** With the ledger line `Phase review: P<n> clean` or `fixed` written, run `node scripts/stack.mjs done PLAN_FILE N`, then `node scripts/stack.mjs submit PLAN_FILE N`. In GitHub mode `submit` pushes this plan's phase branches only (the ledgered authorization covers it), opens or updates the draft PR and prints `Phase <N>: submitted (<branch>, PR #<n> draft)`; ledger that line. In local mode it prints `local mode: nothing to submit`; ledger `Phase <N>: complete (<branch>, local)`.
- **The break.** After `submit` of every phase except the last, the phase's ledger line from the step above is the resume point; end your turn with exactly one line, with N the phase number: `Phase N done. Run /clear, then say "continue the plan" (or say "continue" to keep this session).` A fresh session resumes from the ledger and the SessionStart context, as after a compaction. There is no break after the last phase (the seams review, `--open` and Finish follow) and none in a single-phase plan. No setting: your human partner's reply decides.
- **`submit` exits 5** when `gh` failed, and records nothing: ledger a `Ruling:` that names the `gh` message, retry once, and when it fails again run `node scripts/stack.mjs mode PLAN_FILE local`, ledger the `Ruling:`, and continue in local mode.

## Denied by Policy

Fence refuses a call, and the wording of its refusal is not something this skill can rely on. A refused call is not a puzzle to solve: a variant of the call, another path to the same effect and a workaround through another tool are all the retry this rule forbids. The rule below holds in every run, whatever the ledger's `Fence:` line says, and it is the same sentence in every template and every role's agent definition.

A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence's policy; when in doubt, stop.

- **A subagent's denial.** Any role you dispatch (implementer, fixer, reviewer, hunter, brief writer) that meets a denial stops and replies BLOCKED with the denied call and its path (its agent definition says so, and so does its template where it has one). Take that reply as the denial: do not resume the agent with a hint, do not re-dispatch the task, and do not dispatch another role to finish the work.
- **Your own denial** (a call you make, a `stack.mjs` or `triqual` command) is handled the same way.
- **The stop.** Write `Denied by policy: <call> — <path>` to the ledger, dispatch nothing else for that task (no fix round, no re-review, no later task that depends on it), and ask your human partner with the denied call, its path and the refusal text verbatim. This is the security-sensitive stop above: a fence denial is never ruled on, because a ruling would route around it.
- **The answer.** Only your human partner's answer reopens the task. When they say the way is open (they ran the step themselves, or changed the policy themselves), resume the task as it stood.
- **Detection can be stale.** A refusal that matches the rule is a denial whether or not the ledger's `Fence:` line says none, because fence may have been installed since setup: stop, run fence detection again (`command -v fence`, then `fence version`), and append a new `Fence:` line with the result. Only a failure you can explain without fence, a policy or a protected path (a typo, a missing file, a failing test) is ordinary and follows the normal flow.

## Records

`task-close` writes and records every `task-review` record itself (step 6); the phase and final records below are written by you. `triqual role-eval record --plan <plan file> <json-file>` validates a record (counts only: no repository, plan, path, diff or finding text), exits 2 and names the bad field (never its value), and derives the idempotency key itself, so a resumed controller re-runs it harmlessly (exit 0 on a write and on `already recorded`). Write each record's JSON to a file in the workspace first. If `record` fails (exit 2 for a usage or schema error or no git repository, exit 1 for a write or lock failure), or `triqual` lacks `role-eval`, write the record JSON into the ledger as one line, `Unrecorded: <record JSON>`, and continue; Finish retries it.

**`task-review`**, one per task and attempt, written once, by `task-close`, when the task completes (step 6), never at the breaker. `attempt` is 1, then +1 after each `triqual tasks reopen` of the task. `tier` is the effective tier the task completed at; `declaredTier` the plan's tier (`null` for a tierless task); `raised` is true exactly when `tier` is above `declaredTier` (a tierless task counts as standard). `hunters` holds one entry per hunter sent (none for standard or light): `model` is the `model:` line of the role's installed agent file (on Codex, the routing value), `failed` hunters carry all-zero counts, and each hunter's verdict counts sum to its `candidates`. `gate.findings` counts the gate's findings; `spec.ran` says whether `roles:spec-reviewer` ran, and `spec.confirmed` counts its own findings by severity (candidate verdicts live in `hunters`). `fixRounds` counts this attempt's fix rounds; `blocked` is true when the breaker tripped in this attempt (the human then parked or granted rounds); `coordinator` is true for a coordinator task. A heavy task with one fix round:

```json
{ "v": 2, "at": "2026-10-18T14:02:11Z", "provider": "claude", "task": "T3", "kind": "task-review", "attempt": 1,
  "tier": "heavy", "declaredTier": "heavy", "raised": false,
  "hunters": [
    { "category": "correctness", "model": "claude-haiku-5-5", "failed": false, "candidates": 2,
      "confirmed": { "critical": 0, "important": 1, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "security", "model": "claude-haiku-5-5", "failed": true, "candidates": 0,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 }
  ],
  "gate": { "findings": 0 },
  "spec": { "ran": true, "confirmed": { "critical": 0, "important": 1, "minor": 1 } },
  "fixRounds": 1, "blocked": false, "coordinator": false }
```

A light task with a clean gate:

```json
{ "v": 2, "at": "2026-10-18T15:40:02Z", "provider": "claude", "task": "T7", "kind": "task-review", "attempt": 1,
  "tier": "light", "declaredTier": "light", "raised": false, "hunters": [],
  "gate": { "findings": 0 },
  "spec": { "ran": false, "confirmed": { "critical": 0, "important": 0, "minor": 0 } },
  "fixRounds": 0, "blocked": false, "coordinator": false }
```

**`final-escapes`**, once per multi-phase plan, after the seams review (a single-phase plan's `P1` record stands): one entry per seams-review finding that the final reviewer traced to a task, with that task's effective tier and the finding's severity; `untraced` findings are not entries, and a final review with none writes `"escapes": []`:

```json
{ "v": 2, "at": "2026-10-18T18:30:05Z", "provider": "claude", "task": "final", "kind": "final-escapes",
  "escapes": [ { "tier": "light", "severity": "important" }, { "tier": "standard", "severity": "minor" } ] }
```

**The phase review** records `hunters` and `final-escapes` with `task: "P<n>"` (the seams review records only `final-escapes`, with `task: "final"`), with the phase review's budget (reference 4). The phase's fix commit lands with its own progress entry, Stage/task `Plan <name> · P<n> fix`. An escape counts only a finding no earlier review recorded: a deferred Minor confirmed again is not an escape. Phase-review escape counts will rise by design: they now hold what per-task hunters used to catch.

```json
{ "v": 1, "at": "2026-10-20T16:20:11Z", "provider": "claude", "task": "P1", "kind": "hunters",
  "hunters": [
    { "category": "correctness", "model": "claude-haiku-5-5", "failed": false, "candidates": 2,
      "confirmed": { "critical": 0, "important": 1, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "security", "model": "claude-haiku-5-5", "failed": false, "candidates": 0,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "spec-drift", "model": "claude-haiku-5-5", "failed": false, "candidates": 1,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "state", "model": "claude-haiku-5-5", "failed": true, "candidates": 0,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 }
  ],
  "budget": { "reference": 4, "used": 4, "overrun": false } }
```

```json
{ "v": 2, "at": "2026-10-20T16:41:30Z", "provider": "claude", "task": "P1", "kind": "final-escapes",
  "escapes": [ { "tier": "standard", "severity": "important" } ] }
```

**`escape`**, after the plan merges: whenever a `fix:` commit or a red CI on trunk is traced to the plan, record it with `triqual role-eval record --plan <plan file> <json-file>`. `source` is `post-merge-fix`, `red-ci` or `bug-report`; `ref` the fixing commit's sha or the PR number; `task` (optional) the task it traces to, whose effective tier the command fills in from the ledger when `tier` is left out; `note` (optional) at most 200 characters, no secrets. One record per plan and ref:

```json
{ "v": 2, "at": "2026-10-21T09:15:00Z", "kind": "escape", "source": "post-merge-fix", "ref": "3f9c2ab",
  "task": "T3", "note": "empty plan list crashed tasks status" }
```

## Final Review

The final review always runs: for every plan, whatever its tiers, after the last phase is submitted. In a plan with several phases it is the **seams review**, below: one `roles:final-adversarial-reviewer` and no hunters, because every phase already had its deep review. In a single-phase plan the phase review is the final review: its range is `trunk..top`, no seams review runs, its `P1` records stand, and the plan goes on to the Submit step below. A phase with no `Phase review: P<n>` line (submitted before 1.1.0) gets its phase review (8. Review the phase, on that phase's range) before the seams review; its fixes are commits on the top phase. That phase is already submitted, so it gets rounds 1 and 2 and the fix rounds of 8. Review the phase and nothing after them: no `stack.mjs done`, no `submit` and no break, and the top phase's Phase check after each fix round.

- **The package:** run `node scripts/review-package PLAN_FILE MERGE_BASE HEAD`, with MERGE_BASE the commit the stack started from (`git merge-base <trunk> HEAD`): the review covers `trunk..top`, every phase.
- **The reviewer.** Dispatch `roles:final-adversarial-reviewer` once, with no hunters and so no candidates, with [final-review-prompt.md](final-review-prompt.md), its Seams Scope filled (the controller deletes the Phase Scope): the spec, the plan, the full `trunk..top` package and the workspace ledger (`sdd-ledger.md`), and the plan's Review Focus verbatim. Tell it that each phase already passed its own review, and that it looks only at the interfaces one phase exposes and a later one consumes, at cross-phase state, and at every `Ruling:`, deferred-minor and parked line still open (ruling on each: must fix before merge, or accept with a reason). It names the task and the phase of each finding it can trace. A missing verdict sends the review back. Ledger: `Round 2: final — verdicts <n>/<n>`.
- **Records:** for a multi-phase plan only (a single-phase plan's `P1` record stands), the plan's `final-escapes` record with `task: "final"`, never a `hunters` record, counting each traced finding against its task's effective tier: its `effectiveTier` in `triqual tasks export --json` (opted in), else the ledger's last `Tier:` or `Tier raised:` line for that task. `Unrecorded:` on a failure.
- **Fix rounds.** The same rule as the phase review, with one exception (below): a confirmed Critical or Important finding, and any ledger line the reviewer says must be fixed, goes to at most two rounds of `roles:review-fixer` with the complete findings list, never one fixer per finding. It carries the Tracking section when opted in (Stage/task `Plan <topic> · final fix`). Each round is a plain commit on the top phase (`fix: address final review findings`), with the phase fix commits the only commits of the stack that are not tasks, never a `--fixup`. Each round is followed by a scoped re-review of the fix range ([re-review-prompt.md](re-review-prompt.md) on `node scripts/review-package PLAN_FILE FIX_BASE HEAD`) by `roles:spec-reviewer`, or by `roles:final-adversarial-reviewer` when a finding was Critical, and then the Phase check. Minor findings never enter the loop. A finding still open after the second round is parked with a ruling, or ruled on when load-bearing, and surfaces to your human partner through methodology:finishing-branch. That is the exception: after round 2 the seams review parks residual findings and hands off to methodology:finishing-branch, while the phase review blocks. A failing Phase check after round 2 is treated like the residual case: ledger it as parked and push without marking anything ready (see Submit).
- **Submit.** Run the top phase's Phase check again, then `node scripts/stack.mjs submit PLAN_FILE <top N> --open`, which pushes the fix commit and marks every phase's PR ready for review. A clean final review with no fix round goes straight to that `submit` with `--open`. When residual Critical or Important findings remain open after the re-review, push the fix commit without marking anything ready, with `node scripts/stack.mjs push PLAN_FILE <top N>` (it refreshes the PR body and never changes the draft state), and leave the ready decision to your human partner.

## Worktrees

A worktree is created only when your human partner explicitly asks for one, in this conversation or in their instruction files. Without that request you work in place and do not stop to ask; at most mention once that one is available.

1. **Detect existing isolation first:** `git rev-parse --path-format=absolute --git-dir --git-common-dir`. Two different paths (and `git rev-parse --show-superproject-working-tree` printing nothing, so it is not a submodule) mean you are already in a linked worktree: use it, and create no other.
2. **Native tool first:** if your harness has a native worktree tool (a tool such as `EnterWorktree`, a `/worktree` command, a `--worktree` flag), use it: it owns placement, branching and cleanup.
3. **Git fallback**, only without a native tool: use the directory your instructions name, else an existing `.worktrees/` (or `worktrees/`), else `.worktrees/` at the project root; verify the chosen location is ignored (`git check-ignore -q <location>`, exit 0) and add it to `.gitignore` with a commit when it is not; then run `git worktree add <location>/<branch-name> -b <branch-name>` and move the session into it with your harness's directory tool, as a step of its own. A sandbox denial means you work in place and say so.
4. **Branch name:** never exactly the plan's `**Branch prefix:**` (use `wt/<prefix>`, or a detached HEAD): `node scripts/stack.mjs init PLAN_FILE` exits 3 on a branch with the prefix's own name.
5. **Clean baseline:** in a fresh worktree, install dependencies the way the project does (its manifest or lockfile says how), each command plain and on its own, then run the project's check before Task 1. Failures are reported to your human partner, who decides whether to proceed; later failures are then ambiguous otherwise.
6. **Cleanup:** whoever creates a worktree removes it when the work lands or is dropped (methodology:finishing-branch, Step 7).

## Ledger vocabulary

The workspace ledger, `sdd-ledger.md`, is append-only, one line per event, in these forms:

- `# SDD ledger — plan: <plan file path>` (first line)
- `Authorization: push phase branches and draft PRs — handoff <date>` / `— setup <date>`, or `Authorization: declined — stack in local mode`
- `Fence: <version>` / `Fence: none` (appended again whenever detection is rerun; the last `Fence:` line counts)
- `Skills: T<N> printed for the human — <slugs>`
- `Denied by policy: <call> — <path>`
- `BASE: T<N> <sha>` (written by `task-open`; the last such line for a task is its BASE)
- `Prep: T<N> r<R> <head sha>` (written by `task-prep`: review round `<R>` of the task, prepared at that head)
- `Tier: T<N> <tier>`
- `Tier raised: T<N> <from> → <to> — <reason>`
- `Budget: hunters <matrix> → <used> for T<N> — <reason tied to the diff>`
- `Round 1: T<N> — hunters <done>/<sent>, safety ok`, `Round 2: T<N> — verdicts <n>/<n>` (light: `Round 2: T<N> — light items <n>`)
- `Round 1: P<n> — hunters <done>/<sent>`, `Round 2: P<n> — verdicts <n>/<n>` (the phase review)
- `Round 2: final — verdicts <n>/<n>` (the seams review: no hunters, so no `Round 1: final`)
- `Phase review: P<n> clean | fixed | blocked`
- `Review: T<N> — no commits, nothing to review`
- `Re-review: T<N> round <R> — applies Ruling verbatim, no security logic`
- `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`
- `Task <N>: minor (deferred): <one-liner>`
- `Task <N>: awaiting landing` (written by the orchestrator on a stop for a task that finished but is not landed)
- `Orchestrator: P<n> — <summary first line>` (written by the main session when an orchestrator returns)
- `Task <N>: blocked at fix round 5/5 — <open findings>`, then the human's decision: `Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`, and for more rounds `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`
- `Task <N>: parked — <finding> — Ruling: <why the code stands>`
- `Task <N>: complete (commits <base7>..<head7>, review clean)` / `(commits <base7>..<head7>, <K> parked)`
- `Phase <N>: submitted (<branch>, PR #<n> draft)` / `Phase <N>: complete (<branch>, local)`
- `Ruling: <what you decided> — <why> — <what it costs if wrong>`
- `Skipped: hunters — <cause>`
- `Skipped: hunters and safety gate — <cause>; safety checklist runs in the spec review`
- `RateLimit: <role> <time>`
- `Unrecorded: <record JSON>`
- `Error: <step> T<N> — exit <code> — <first stderr line>` (written by a script before it exits non-zero; `<step>` is `task-open`, `task-prep` or `task-close`); the main session writes `Error: orchestrator P<n> — exit 1 — <first line of the error>` itself when an orchestrator cannot be dispatched

## Finish

Before you delete anything, list under "Errors and fallbacks" every ledger line that starts with `Error:` (the script, the task, the exit code and the cause) and every fallback line (`Skipped:` and `Unrecorded:`), `none` when there is none, so a failure that a rerun repaired is still seen; the orchestrators' errors and fallbacks are in the same ledger, so the list holds both levels, and it sits beside "Rulings I made" in your final message. Then collect every ledger line containing `Ruling:` — preflight rulings, tier raises you ruled on, parked findings, breaker decisions, all of them — into your final message under "Rulings I made", in the order you made them, each with what it costs if wrong. The list is exhaustive: that list is the only place the decisions you took on your human partner's behalf reach them. Then list, under "Minors still open", every `minor (deferred)` line the last review left open (the phase review of a single-phase plan, else the seams review; the Minors it found are ledgered as `Task <N>: minor (deferred): <one-liner>`), one line each, so they reach your human partner too.

Before the totals, re-run `triqual role-eval record --plan <plan file> <json-file>` for every record that has an `Unrecorded:` line, writing its JSON to a file first; `already recorded` is fine. List every record that still fails in your final message under "Unrecorded records", each with its JSON: the workspace takes the line with it.

Total the review from the ledger before you delete the workspace: actual hunters, the sum of `<sent>` over every `Round 1:` line (the phases' included; the seams review sends none), against the matrix's reference (2 per heavy task, 0 per standard and light task, plus 4 per phase, 0 for the seams review; a task counts by its final effective tier, which is its `effectiveTier` in `triqual tasks export --json` (opted in), else the ledger's last `Tier:` or `Tier raised:` line), and the tasks per effective tier with how many were raised. When opted in, the closing `progress.md` entry (written under methodology:finishing-branch) states them and the count of `Error:` and fallback lines.

When the final review is clean and its fixes are pushed, delete this plan's workspace (`rm -rf <workspace>`) — the git history is the record now. Sibling directories belong to other plans; leave them alone.

The plan's `## After Merge` checklist is not run: those operations need the merged trunk and are not tasks. Copy each one, with its command, into the final message under "After Merge". Leave the stack state file, `.methodology/stack/<plan file stem>.json`, in place: methodology:finishing-branch deletes it once the stack is merged.

Use methodology:finishing-branch.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's light, it obviously needs no review" | Light shortens the review to the safety gate; it never removes it. Every task with commits gets at least the gate. |
| "The diff is bigger than the plan said, but the plan says light" | `tier-check` decides from the diff, and its raise stands. A tier is never lowered. |
| "This standard task feels risky: I'll add hunters" | Hunters belong to heavy tasks, picked from the reason line. A task that touches security code, live state or a parsed contract is heavy by the rubric, and a standard task's breadth comes in the phase review. More hunters than the tier's count need a `Budget:` line tied to the diff. |
| "The user asked to skip the gate / lower the tier" | Neither is a stop and neither is yours to grant. Say so in one line and run the review. |
| "Bookkeeping can wait until the end" | `task-close` (squash, `tasks done`, the record) closes each task before the next starts. The ledger is what survives compaction. |
| "I'll run this small plan inline, it's faster" | Plans run through role agents only. Light tasks get batched light dispatch, not a controller that implements. |
| "Close enough on spec compliance" | Reviewer found spec gaps = not done. Fix, or hit the cap and let the human decide. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. Resume the fixer. |
| "One more round will converge" | Past round 5 the failure is structural: the task is blocked and the human decides. |
| "The fix was small, skip the re-review" | The matrix names the only exception (a standard fix that applies an approved `Ruling:` verbatim, no security logic). Otherwise every round is re-reviewed, and re-checked by `tier-check`. |
| "This finding is obviously wrong, I'll drop it" | Silent discards are forbidden. Rule in the ledger; adjudicate only at the cap. |
| "The implementer spawned its own reviewer — free extra assurance" | It's a duplicate seat; the task review is the gate. A worker-spawned reviewer is a defect to flag. |
| "I'll name a model to be safe" | A model in the dispatch overrides the role's pinned model. Choose the role; pass no model. |
| "The plan says a reviewer role implements this task — close enough" | A reviewer role is never a task role. Stop and ask. |
| "The denied call has a harmless variant" | A variant is a retry. A fence denial stops the task and asks the human; it is never ruled on or routed around. |

## Example

```
[Setup: no worktree asked for; triqual tasks paths --json → opted in, "mode": "store"]
[node scripts/sdd-workspace <plansDir>/billing.md → fresh workspace; ledger created]
[node scripts/stack.mjs init <plansDir>/billing.md → github mode; method chosen at the handoff → Authorization: … — handoff 2026-10-18]
[Tiers at setup: T1 standard, T2 light, T3 light (all declared) → Tier: lines; pre-flight table written]

Phase 1 (node scripts/stack.mjs phase <plansDir>/billing.md 1)
[main session: dispatches one roles:phase-orchestrator with orchestrator-prompt.md, waits once; the orchestrator runs Tasks 1-3 below]

Task 1 (standard, roles:tdd-implementer)
[task-open → brief, report, base a1b2c3d; dispatch roles:tdd-implementer]
Implementer: DONE, 1 commit, RED → GREEN evidence in the report.
[task-prep → tier standard, hunters none, package, round 1]
[round 1: gate + roles:spec-reviewer in parallel, no hunters → clean; both final messages saved as round-1 outputs]
[task-close → sha d4e5f6a (squash, done, Task 1: complete, task-review record, review entry)]

Task 2 (light, roles:tdd-implementer) — first of a light batch
[task-open → base d4e5f6a; dispatch roles:tdd-implementer]
[DONE; task-prep → tier light; gate alone → clean, saved as its round-1 output]
[task-close → sha e0f1a2b]

Task 3 (light) — resumed, not re-dispatched
[task-open → base e0f1a2b; resume the same implementer with "Next task"]
[DONE; task-prep → raise light standard: code beyond the light allowance: src/pay.mjs; it wrote Tier raised: T3 light → standard — … and retiered the task; tier standard; the batch ends]
[standard review: gate + roles:spec-reviewer in parallel → clean, both saved; task-close]

[orchestrator summary: Phase: P1 done; Tasks: T1 d4e5f6a, T2 e0f1a2b, T3 f3a4b5c; no rulings, no open minors, Errors and fallbacks: none; main session writes Orchestrator: P1 — Phase: P1 done]

[Phase check passes; phase review: 4 hunters + roles:final-adversarial-reviewer → clean; Phase review: P1 clean; hunters and final-escapes records (P1); done; submit]
[single-phase plan: the phase review was the final review; no seams review]
[node scripts/stack.mjs submit <plansDir>/billing.md 1 --open; final message with Rulings and After Merge; methodology:finishing-branch]
```
