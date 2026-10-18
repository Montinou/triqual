---
name: executing-plans
description: Use when executing an implementation plan in the current session — every task goes to a role agent, is reviewed at its tier, and lands as one commit on a stacked branch and draft PR per plan phase
---

# Executing Plans

You are the controller of a plan's execution. Every plan task is done by a role agent (`roles:tdd-implementer` or `roles:complex-implementer`), except `coordinator` tasks, which you run yourself (see Coordinator tasks). You never run a plan inline: never run a plan inline as its implementer, whatever the plan's size, and a harness that cannot dispatch a named role agent stops and asks its human partner. Each task's review is sized by its **tier** (`heavy`, `standard`, `light`): declared by the plan, raised (never lowered) by `scripts/tier-check` from the task's real diff. Execution is stacked: each plan phase is one git branch on top of the previous phase's (and, in GitHub mode, one draft PR), and each task is exactly one commit on its phase branch, driven by `scripts/stack.mjs`. At the end one final whole-branch review runs for every plan.

**Why role agents:** each task gets a fresh agent whose context holds only its brief and the interfaces it touches; your own context stays clean for coordination across the whole plan. Every dispatch goes to a `roles:*` agent and passes no model (see Role Dispatch).

**TDD is required on every task.** A behavior change starts with a failing test: the implementer (or you, on a coordinator task) writes the test, watches it fail for the expected reason, then writes the code and watches it pass, and the report carries that RED and GREEN evidence. A task that changes no behavior records its verification command's real output instead.

**Narration:** between tool calls, narrate at most one short line — the ledger and the tool results carry the record.

**Continuous execution:** Do not pause to check in with your human partner between tasks. Execute all tasks from the plan without stopping. The only reasons to stop are the six named below, or all tasks complete. A rate limit is not one of them: ending the run after the bounded wait (see Rate limits) is the end of the session, with a final message that lists the ledger's `Ruling:` lines (see Finish), and the ledger keeps the plan resumable. "Should I continue?" prompts and progress summaries waste their time — they asked you to execute the plan, so execute it.

**Rulings, not stalls.** A running plan does not wait on a human. Conflicts, ambiguities, plan defects, a cap you would have asked to exceed — decide them. The spec is the binding authority, the plan is its argument, and your judgment settles what neither answers. Record every decision in the ledger as `Ruling: <what you decided> — <why> — <what it costs if wrong>`, and keep going. A wrong ruling costs rework your human partner can see and undo; a session parked on a question costs their whole day and buys nothing.

Six things stop you, and only these: an irreversible or destructive operation; a security-sensitive action; a side effect outside this checkout that norms say you ask about first (a merge, a push to a shared branch, a publish); a task whose `**Role:**` is not a task role (see Role Dispatch); a task blocked by the breaker after round 5 (see The fix loop); and a plan so broken that every path forward is a guess. For those, stop and ask. A user's request to skip a review, lower a tier or batch the bookkeeping "for later" is none of them, and changes nothing: say so in one line and go on.

The only exception to the push stop is a ledgered authorization, either `Authorization: push phase branches and draft PRs — handoff <date>` or `Authorization: push phase branches and draft PRs — setup <date>` (see Stack setup): it covers pushing this plan's phase branches, opening or updating their draft PRs and marking them ready for review after the final review; any other push, any merge and any force push still stop.

## The Process

1. **Setup** (once): workspace and ledger, tracking paths, stack, push authorization, read the plan and the spec, tiers at setup, pre-flight scan.
2. **Per phase:** `node scripts/stack.mjs phase PLAN_FILE N`, the phase's tasks in dependency order, the Phase check at the phase tip, `node scripts/stack.mjs done PLAN_FILE N`, `node scripts/stack.mjs submit PLAN_FILE N`.
3. **Per task:** (1) start: ledger move, brief, BASE; (2) build: dispatch the task's role (or run a coordinator task); (3) `tier-check`; (4) review at the effective tier, on one review package; (5) the fix loop when the review requires it, with `tier-check` on every round; (6) complete: squash, `triqual tasks done`, the `task-review` record.
4. **End:** the final review of `trunk..top` (3 hunters + `roles:final-adversarial-reviewer`), one fix dispatch plus a scoped re-review, the `hunters` and `final-escapes` records, then methodology:finishing-branch.

## Setup

No worktree by default: run the plan in the current checkout. The stack's phase branches are the isolation, so a worktree adds nothing; create one only when your human partner explicitly asks (see Worktrees). Executing a plan, or being told to work autonomously, is not that request. Implementation never starts on the trunk: `node scripts/stack.mjs phase PLAN_FILE N` moves HEAD onto the phase branch.

Conversation memory does not survive compaction. Controllers that lost their place have re-dispatched entire completed task sequences — the single most expensive failure observed. Track progress in the workspace ledger, not only in todos.

### Workspace and ledger

- Each plan owns a workspace: at skill start, run `node scripts/sdd-workspace PLAN_FILE` — it prints the plan's git-ignored directory (under `<repo-root>/.methodology/sdd/`, kept out of `git status` by `.methodology/.gitignore`), home to every artifact for THIS plan: ledger, briefs, reports, review packages, record files. Another plan's directory is never yours to read or write.
- The ledger is `<workspace>/sdd-ledger.md`. If its first line names your plan file, tasks with a `Task <N>: complete` line are DONE — do not re-dispatch them; resume at the first task without one. A task whose last line is a fix round is mid-loop: resume the loop at the next round. A task whose last ledger line is its `Task <N>: blocked` line is the sixth stop again: it is never re-dispatched, and you ask your human partner for the decision the breaker waits on (see The fix loop). A ledger whose first line names a different plan file is another plan's progress: leave it in place and start your own, fresh.
- A plan whose run began before the rename kept its ledger in the old workspace. When `sdd-ledger.md` is missing and that old ledger exists under this exact plan, `sdd-workspace` copies it once to `sdd-ledger.md`, marks the old directory `adopted` and leaves it in place; resume from the copy. A workspace left by a 0.7.x execution resumes the same way, and its tasks get their tiers at setup (see Tiers at setup).
- Create the ledger with its identity as the first line: `# SDD ledger — plan: <plan file path>`.
- After compaction, trust the ledger and `git log` over your own recollection, and read `node scripts/stack.mjs status PLAN_FILE` alongside the ledger: it prints the stack state (each phase's branch and state, the mode, the PR numbers), so a phase already submitted is never started again.
- After compaction, when opted in, read each task's state before your next ledger move (`triqual tasks export --json`, per-task `status`, `tier` and `effectiveTier`; `triqual tasks status --json` lists only `inProgress` and `next` for each plan), and skip any move the ledger already shows: a `start` or `rework` on a task already `in_progress`, a `review` on one already `in_review`, a `done` on one already `done`, a `block` on a task already `blocked` (which stays a stop until the human decides), and, opted in, a `retier` to the tier it already has. A resumed session never fails on a move it already made.
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

### Read the plan

Read the plan once, note its context, Global Constraints, Review Focus and `**Sensitive paths:**`, and create a todo per task. The scripts read it with `scripts/lib/plan.mjs`, the same reader as `triqual tasks`, so every reader agrees on task boundaries and fields. If the plan names a Spec, read that too: conflicts inside the plan resolve against it. A plan with no reachable spec gets a ledger note saying so — rulings made without one are provisional.

Check the roles once: a task role the `roles` plugin does not define, or a reviewer role named as a task's role, is a stop (see Role Dispatch). Hunters and the Haiku gate that turn out unavailable at their first dispatch follow the skip rule (see When the stage does not run).

### Tiers at setup

Every task has an effective tier before its first dispatch. Write one ledger line per task, `Tier: T<N> <tier>`, with its effective tier.

- **A tiered plan** (every task declares `**Tier:**`): the effective tier is the declared tier, or the higher `effectiveTier` that `triqual tasks export --json` already holds for a resumed run.
- **A tierless task** (a plan written before 1.0, or a resumed 0.7.x execution): a missing tier reads as `standard`. Give each pending tierless task its effective tier by the tier rubric, raising only: a task the rubric makes heavy is raised, when opted in, with `triqual tasks retier T<N> <tier> --plan <plan> --reason "<text>"` (reason `setup rubric: <criterion>`), and every other task stays standard; a tierless `roles:complex-implementer` task becomes heavy. Ledger each raise as `Tier raised: T<N> standard → heavy — setup rubric: <criterion>`.
- **The tier rubric** (the one writing-plans applies): **heavy** — any of: security-relevant code (auth, permissions, secrets, sandboxing, policy, parsing untrusted input), live state or migrations, changes spanning more than one plugin or system, a public interface others depend on (CLI flags and exit codes, file formats, hook contracts, the plan format), `roles:complex-implementer`. **light** — only docs, comments, config values, version bumps, renames with no behavior change, and small code fixes within the light code allowance. **standard** — everything else. A tierless task never reads as light: the rubric only raises.
- **Not opted in:** there is no `retier`: the ledger's last `Tier:` or `Tier raised:` line for a task is its effective tier, and the floor you pass to `tier-check`.

A tier is never lowered: not by you, not by a reviewer, not on your human partner's word. `retier` refuses a lowering (exit 2), and a raise stays for the rest of the task, its fix rounds and any reopen.

### Pre-flight scan

Before dispatching Task 1, scan the plan once for conflicts, writing down what you checked as you check it:

- tasks that contradict each other or the plan's Global Constraints
- anything the plan explicitly mandates that the review rubric treats as a defect (a test that asserts nothing, verbatim duplication of a logic block)
- a declared tier the rubric contradicts (a light task that changes behavior beyond the light code allowance, a heavy trigger in a standard task): raise it now with a `Tier raised:` line (and `retier`, when opted in), never lower one

The scan's output is a table, not a verdict. One row for every pair of tasks that share a file or an interface: the two tasks, what one produces against what the other consumes, and what you found. One row for every task: whether its own text agrees with itself — the tests it specifies against the code it specifies, the files it creates against the files it later touches. "The scan is clean" without those rows is not a scan you ran. Write the table to the ledger, rule on each conflict beside its row, and dispatch Task 1. The review loop remains the net for conflicts that only emerge from implementation.

## Role Dispatch

Every dispatch goes to a `roles:*` agent (plugin `roles`), and no dispatch passes a model: each role's definition pins its model and effort, and a model in the dispatch would override that pin. Choose the role; never choose a model.

- **Default:** `node scripts/task-brief PLAN_FILE N` copies the task's `**Role:**` line into its brief; a task with no `**Role:**` line is `roles:tdd-implementer`.
- **`roles:tdd-implementer`, `roles:complex-implementer` or `roles:review-fixer`** (the last only in plans written before 1.0): dispatch [implementer-prompt.md](implementer-prompt.md), with its header's `<task role>` filled with that role. A plan marks a task `roles:complex-implementer` (Opus) for multi-system changes, migrations of live state, or work where a mistake is costly; such a task is heavy.
- **`coordinator`:** you run the task yourself (see Coordinator tasks).
- **Any other role**, a reviewer role included (`roles:spec-reviewer`, `roles:safety-reviewer`, `roles:hunter`, `roles:final-adversarial-reviewer`, `roles:brief-writer`) or a misspelled one: stop and ask your human partner. Never dispatch it, and never substitute another role for it.
- **Reviews:** by the task's effective tier (see Tiers), never the task's own role: `roles:hunter` ([hunter-prompt.md](hunter-prompt.md)), `roles:safety-reviewer` ([safety-review-prompt.md](safety-review-prompt.md)), `roles:spec-reviewer` ([task-reviewer-prompt.md](task-reviewer-prompt.md)).
- **Re-reviews:** the role or roles that raised the findings ([re-review-prompt.md](re-review-prompt.md)).
- **Fix rounds:** `roles:review-fixer`; a `roles:complex-implementer` task keeps its own role.
- **Final review:** `roles:final-adversarial-reviewer`, once per plan ([final-review-prompt.md](final-review-prompt.md)).
- **Briefs:** `node scripts/task-brief PLAN_FILE N` extracts each brief mechanically, at no cost. Dispatch `roles:brief-writer` only when a task's plan text lacks interfaces that must come from the current code.

**Turn count beats token price.** Wall-clock and context cost scale with how many turns a subagent takes. The role pins the model; what you control is the dispatch: a brief that carries the exact values, the interfaces the task touches, and nothing else.

### Coordinator tasks

A `coordinator` task runs in this session, by you, and is light: a no-code step (a rollout step, a status update) or a small, low-risk change or fix within the light code allowance (see Tiers). In a tiered plan registration already refused a coordinator task that is not light; in a tierless plan a coordinator task stays at its setup tier (standard at least), because no tier is lowered. It keeps the discipline of a dispatched task: the same ledger moves, TDD when it changes behavior, the implementer template's Tracking and Task Skills sections followed by you, the same report file the reviewers read, its own commit, `tier-check` and the review its tier calls for. When `tier-check` raises it, its review runs at the raised tier with the controller as author, and any fix round goes to `roles:review-fixer`, never to the controller. Its `task-review` record carries `"coordinator": true`.

## Tiers

The effective tier sets the review. Spec U4, verbatim:

| Effective tier | Round 1 (together) | Round 2 | Fix-round re-review |
|---|---|---|---|
| heavy | 4 hunters: correctness, security, spec-drift, state + safety gate | `roles:spec-reviewer` on every candidate and spec fit | scoped re-review by the raising role(s), always |
| standard | 2 hunters: correctness + the category the plan's Review Focus names for the task, else the riskiest for the diff (security by default) + safety gate | `roles:spec-reviewer` | scoped re-review, except a fix that applies an approved `Ruling:` verbatim and touches no security logic |
| light | safety gate | none, unless the gate reports a finding or `Cannot verify` (then `roles:spec-reviewer` runs on that item) | the gate re-checks |

- **Hunters are part of the standard tier:** a standard task sends exactly two, heavy four, light none. Sending more than the matrix needs one ledger line, `Budget: hunters <matrix> → <used> for T<N> — <reason tied to the diff>`; never send fewer.
- **The safety gate runs at every tier.** Never skip the task review (the one exception is a task with no commit range: see When the stage does not run): every task with commits gets at least the safety gate, whatever its tier and whoever asks.
- **`tier-check`** (`node scripts/tier-check PLAN_FILE N BASE HEAD --floor <tier>`) prints `ok <tier>` or `raise <from> <to>: <reason>: <paths>` and exits 0; exit 2 is bad input (unknown task, bad range, bad floor), an error to fix, never a reason to skip the check. Its rules, applied in order and never lowering: **→ heavy** when the diff touches a sensitive path (default `**/hooks/**`, `**/setup/**`, `**/*schema*`, `**/migrations/**`, `**/drizzle/**`, `.github/**`, `plugins/workflow-gate/**`, plus the plan's `**Sensitive paths:**`) or changes more than 300 lines (added + removed); **light → standard** when the diff touches anything outside the light classes (Markdown outside `**/skills/**`, `**/agents/**`, `**/rules/**`, `**/commands/**`, `**/templates/**`, `**/*-prompt.md`, `**/CLAUDE*.md`, `**/AGENTS*.md`; JSON whose only changed key is `version`; lockfiles are never light), beyond the **light code allowance**: other files stay light while, together, they add or remove at most 20 lines (test lines count), create no file (a new test file is a raise; cases added to an existing test file are not), and touch no excluded Markdown class or sensitive path.
- **The floor** is the task's current effective tier: its `effectiveTier` in `triqual tasks export --json`, else its declared tier; not opted in, the ledger's last `Tier:` or `Tier raised:` line for it.
- A raise is recorded with `triqual tasks retier T<N> <to> --plan <plan> --reason "<reason from tier-check>"` (opted in) and the ledger line `Tier raised: T<N> <from> → <to> — <reason>`, before any reviewer of the new tier is dispatched.

## The Task Loop

**One task, one dispatch, one commit.** Each task is its own dispatch (or its own resume, see Batched light dispatch) and its own commit; you never compose a batch brief or send several tasks to one subagent at once. The plan sizes the tasks, and the commit is the unit the review and the squash read.

Everything you paste into a dispatch prompt — and everything a subagent prints back — stays resident in your context for the rest of the session. Hand artifacts over as files.

**Waiting on dispatched subagents:** never poll a wait interface with short timeouts, and never sit in one silent, open-ended wait either. While you have local work — ledger updates, packaging the next review, reading reports — keep working; child results arrive on their own. When you are genuinely idle, wait in bounded stretches (five to ten minutes, where your platform allows), and between stretches post one line of status and reconcile your live children: list them, and chase any that finished without reporting.

**Rate limits.** A dispatch to any role (an implementer, a fixer or a reviewer, on any model) that is rate-limited mid-plan is not a stop: wait in the bounded stretches above and retry the same dispatch, writing one `RateLimit: <role> <time>` ledger line per stretch, with `<time>` the local time as `HH:MM`. After about 6 stretches without success, end the run with a final message naming the task and listing the ledger's `Ruling:` lines (see Finish); the ledger makes the plan resumable. It never swaps the model in a dispatch: the dispatch keeps the same role and passes no model. A hunter or the safety gate with no Haiku quota is not this case: it is the skip rule (see When the stage does not run).

### Start the phase

Before the first task of phase N, run `node scripts/stack.mjs phase PLAN_FILE N`. It prints the phase branch and leaves HEAD on it: it creates the branch on top of phase N−1's (the trunk's, for phase 1). It needs a clean tree and phase N−1 submitted (in local mode, done) and exits 3 otherwise. Every task of the phase then commits on that branch. A resumed run starts the phase the stack state (`status`) shows active or pending, never one already submitted.

### 1. Start the task

- **Ledger move:** when opted in, run `triqual tasks start T<N> --plan <plan>` as you dispatch the implementer (or, for a coordinator task, as you start it yourself).
- **Brief:** run `node scripts/task-brief PLAN_FILE N` — it writes the task's full text (its `**Tier:**`, `**Role:**` and `**Skills:**` lines included) to a uniquely named file and prints the path. Never make a subagent read the whole plan file.
- **BASE:** Record BASE (`git rev-parse HEAD`) before every dispatch and before every resume — the review package, `tier-check` and the squash all read `BASE..HEAD`, and BASE is never `HEAD~1`, which silently drops all but the last commit of a multi-commit task.
- **Report file:** name it after the brief (brief `…/task-N-brief.md` → report `…/task-N-report.md`).

### 2. Build

Dispatch the task's role with [implementer-prompt.md](implementer-prompt.md). Your dispatch contains: (1) one line on where this task fits; (2) the brief path, introduced as "read this first — it is your requirements, with the exact values to use verbatim"; (3) interfaces and decisions from earlier tasks that the brief cannot know; (4) your resolution of any ambiguity you noticed in the brief; (5) the report-file path and report contract; (6) when opted in, the Tracking section, and when the brief has a `**Skills:**` line, the Task Skills section. Exact values appear only in the brief.

- A dispatch prompt describes one task, not the session's history. Never paste accumulated prior-task summaries into later dispatches: a fresh subagent needs its task, the interfaces it touches, and the global constraints.
- The dispatch carries the no-subagents contract (it is in the template): the implementer never dispatches subagents, and never a reviewer. Review arrives from you, after the report.
- If an earlier task parked a finding in the area this task touches, carry a pointer to that ledger entry.
- Record the implementer's agent identity from the dispatch result: fix rounds 1–3 of a `roles:complex-implementer` task resume it, and batched light dispatch resumes it.
- Never dispatch two implementers in parallel (conflicts).

#### Batched light dispatch

For consecutive light tasks of one phase whose role is `roles:tdd-implementer`, dispatch the implementer once, for the first of them, and then resume that same implementer for each next task instead of dispatching a fresh one: its context already holds the codebase, which is most of the cost of a small task.

- One task at a time. The next task is sent only after the previous task's review, squash and `triqual tasks done` finished; never queue two briefs in one message.
- Record BASE before each resume (`git rev-parse HEAD`, on the squashed commit of the previous task), and run step 1 for each task as usual: its own `start` move, its own brief, its own report file. Resume with the "Next task" message of [implementer-prompt.md](implementer-prompt.md).
- `tier-check`, the review and the ledger moves stay per task: each task gets its own `tier-check` on its own `BASE..HEAD`, its own review package and review, its own squash and `done`, its own `task-review` record.
- A task that `tier-check` raises above light ends the batch: its review runs at the raised tier as usual, and the next task gets a fresh dispatch. So does a task that is not light, a task of another role, a new phase, and a resume your harness cannot make.

#### Handle the report

Implementers report one of four statuses:

- **DONE:** when opted in, run `triqual tasks review T<N> --plan <plan>`, then go to step 3.
- **DONE_WITH_CONCERNS:** read the concerns first. Correctness or scope concerns are addressed before review; observations are noted and the task goes to review (with the same `review` move).
- **NEEDS_CONTEXT:** provide the missing context and re-dispatch.
- **BLOCKED:** a context problem gets more context and a re-dispatch to the same role; a task that needs more reasoning than its role brings is broken into smaller pieces or re-dispatched with your ruling on the approach (never override the role's model); a plan defect gets a ruling, ledgered, carried in the re-dispatch. Never ignore an escalation or force the same dispatch to retry without changes.

If the implementer asks questions — before starting or mid-task — answer clearly and completely before it implements.

### 3. Check the tier

Run `node scripts/tier-check PLAN_FILE N BASE HEAD --floor <tier>` on the task's whole range, with the floor of Tiers. On `ok <tier>` the effective tier stands. On `raise <from> <to>: …`, a raise is recorded with `triqual tasks retier` before the review, when opted in (`triqual tasks retier T<N> <to> --plan <plan> --reason "<reason>"`), and always with the ledger line `Tier raised: T<N> <from> → <to> — <reason>`. The review of step 4 runs at the effective tier after this step, never at the declared one.

### 4. Review the task

Per-task reviews are task-scoped gates; the broad review happens once, at the final review. Every task with commits is reviewed on one review package, at its effective tier, by the Tiers matrix. Implementer self-review never replaces the task review.

- **The package:** run `node scripts/review-package PLAN_FILE BASE HEAD` and pass every reviewer the path it prints. The output never enters your own context, and the reviewer sees the commit list, stat summary and full diff with context in one Read call. Use the BASE you recorded — never `HEAD~1`. Never dispatch a reviewer without a diff file; a hunter is no exception.
- **Reviewer inputs:** the gate and the spec reviewer each get the brief, the report file and the package, the effective tier, plus the global constraints that bind the task (copied verbatim from the plan's Global Constraints or the spec: exact values, formats and stated relationships). The gate also gets the task's canary rules and, when opted in, the tracking files it must expect in the diff (in store mode: none is expected, and an added or modified tracking file is a finding); the spec reviewer also gets every candidates file. A hunter gets the inputs of [hunter-prompt.md](hunter-prompt.md).
- Do not add open-ended directives ("check all uses") without a task-specific reason, and do not ask a reviewer to re-run tests the implementer already ran on the same code.
- **Never pre-judge.** Never instruct a reviewer to ignore or not flag a specific issue. If the prompt you are writing contains "do not flag," "don't treat X as a defect," "at most Minor," or "the plan chose" — stop: you are pre-judging. You never tell a verifier how to rule on a candidate, and you never drop a hunter's candidate before round 2.

#### Round 1

- **Heavy and standard:** dispatch together, in the background, in one message: the hunters the matrix names (`roles:hunter`, one per category; standard: `correctness` plus the category the plan's Review Focus names for the task, else the riskiest for the diff, `security` by default) and the gate (`roles:safety-reviewer`), each with the package path. Each hunter writes `<workspace>/task-<N>-candidates-<category>.md`, at most 5 candidates.
- **Light:** dispatch the gate alone.
- Wait up to a soft limit of 10 minutes after the gate's report for every hunter still running. One still running then is recorded `failed` (timeout), and its output is ignored if it arrives later. A hunter that fails, hangs or returns nothing usable is recorded `failed` for its category, and round 2 goes on with the other candidates. No hunter ever blocks a task.
- Ledger: `Round 1: T<N> — hunters <done>/<sent>, safety ok` (`<done>` counts usable candidates files, a valid empty file included; `safety ok` means the gate reported; its findings go to the fix loop after round 2).

#### Round 2

- **Heavy and standard:** dispatch `roles:spec-reviewer` with [task-reviewer-prompt.md](task-reviewer-prompt.md): its inputs plus every candidates file of round 1. It returns spec compliance, task quality and one verdict per candidate. The verdicts are `confirmed` (with a severity), `refuted`, `duplicate-candidate` and `duplicate-review`, as the template defines them. A missing verdict (spec, quality or any candidate) makes the review incomplete: send it back. Ledger: `Round 2: T<N> — verdicts <n>/<n>`.
- **Light:** no round 2 when the gate is clean. When the gate reports a finding or a `Cannot verify` item, dispatch `roles:spec-reviewer` with the template's Light Items section holding exactly those items; it judges those items only. Ledger: `Round 2: T<N> — light items <n>`.
- A `confirmed` candidate enters the fix loop like any spec-review finding, at the severity the verifier gave it.
- The spec reviewer may report "⚠️ Cannot verify from diff" items. They do not block the rest of the review, but you resolve each one yourself before completing the task: you hold the plan and cross-task context the reviewer lacks. An item you confirm as a real gap enters the fix loop.

#### When the stage does not run

- **No commit range.** `review-package` exits 3 with the message `empty commit range` on an empty range (a coordinator task with no code diff): no reviewer runs at all and the `task-review` record carries no hunters, a gate with 0 findings and a spec that did not run. Write `Review: T<N> — no commits, nothing to review` to the ledger and complete the task. Only the `empty commit range` message means no commits: any other exit 3 (for example `HEAD is not a descendant of BASE`) is an error to fix, never a reason to skip the review.
- **Unavailable hunters or Haiku.** When an error arrives before the agent runs (`roles:hunter` is an unknown agent type because the `roles` plugin is too old, the pinned Haiku id is an unresolved model, or there is no quota), skip the hunters and the Haiku gate for the rest of the plan with one ledger line, `Skipped: hunters and Haiku gate — <cause>; safety checklist runs in the spec review`. The safety gate is never skipped: its checklist moves into round 2, where `roles:spec-reviewer` runs it through the Safety Checklist section of [task-reviewer-prompt.md](task-reviewer-prompt.md), with the gate's inputs, at every tier (a light task then gets the spec reviewer with the Safety Checklist sections). Its safety findings enter the fix loop like the rest. Look for a `Skipped:` line in the ledger before every round 1, so the skip survives compaction. A run that starts and then fails is not a skip: a gate that fails is re-dispatched; only hunters are recorded `failed`.

### 5. The fix loop

The loop triggers when the review reports spec ❌, any Critical or Important finding (the gate's included), a `confirmed` candidate at `critical` or `important`, or a ⚠️ item you confirmed as a real gap.

Before the loop starts, two routes leave it:

- Minor findings, `minor` confirmed candidates included, go to the ledger as you go (`Task <N>: minor (deferred): <one-liner>`), and the final review triages them. Minor findings never enter the loop.
- A finding labeled plan-mandated — or any finding that conflicts with what the plan's text requires — is yours to rule on: weigh it against the plan text, decide with the spec as the binding authority, and ledger the ruling before you act on it.

Everything else enters the loop. A fix round is one fix dispatch, one `tier-check`, and the re-review the tier calls for. Five rounds maximum per task.

- **Ledger moves:** when opted in, run `triqual tasks rework T<N> --plan <plan>` at the start of each fix round, before the fix dispatch, and `triqual tasks review T<N> --plan <plan>` when the fixer reports back and the re-review starts.
- **Who fixes:** rounds 1–3 resume the same `roles:review-fixer` (round 1 dispatches it with the open findings verbatim, the brief path and the report-file path; when the task's own role is `roles:review-fixer`, round 1 resumes the implementer); rounds 4–5 dispatch a fresh `roles:review-fixer` each round, with the brief path, the report-file path, the open findings, and this framing: "A prior fixer attempted this task [N] times; you own it now. Read the report file for what was tried." A `roles:complex-implementer` task keeps its role: rounds 1–3 resume its own implementer, rounds 4–5 a fresh `roles:complex-implementer`. A coordinator task's rounds go to `roles:review-fixer`, never to you. If your harness cannot message a live subagent, dispatch a fresh one with the same three inputs.
- Every fix dispatch carries the implementer template's Tracking section when opted in, and its Task Skills section when the brief has a `**Skills:**` line.
- **Fix commits fold into the task's own commit.** A fix round commits with `git commit --fixup=<the task's first commit>`, never an amend, a rebase or a reset: name that commit (the first line of `git rev-list --reverse BASE..HEAD`) in the fix dispatch.
- **Evidence:** before the re-review, confirm the fix report names the covering tests, the command run and its output; a fix that changes behavior starts with a test that reproduces the finding.
- **Re-check the tier every round.** Record FIX_BASE (the head the previous review saw); `tier-check` runs again on each round's `FIX_BASE..HEAD` and on the cumulative `BASE..HEAD`, each with the current floor, and the re-review follows the higher tier. A raise is recorded before the re-review: a `Tier raised:` line, and `retier` when opted in. When a round raises the task, the raised tier's full review (its round 1 and round 2, hunters included) runs on the cumulative package `BASE..HEAD`, because that tier's review never ran on this task; otherwise fix rounds and re-reviews send no hunters.
- **The re-review** (run `node scripts/review-package PLAN_FILE FIX_BASE HEAD`) follows the matrix's last column: heavy — [re-review-prompt.md](re-review-prompt.md) to each raising role, always; standard — the same, except a fix that applies an approved `Ruling:` verbatim and touches no security logic, which you check against the ruling yourself and ledger as `Re-review: T<N> round <R> — applies Ruling verbatim, no security logic`; light — the gate re-checks. The re-reviewer verdicts each finding ADDRESSED or NOT ADDRESSED and flags new breakage in the fix diff only; new Critical/Important breakage joins the open findings; out-of-scope observations go to the ledger as deferred minors.
- **After each round,** append `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`.

Never fix findings yourself in the controller session — your context stays clean for coordination, and controller fixes skip review.

**The breaker.** When round 5's re-review still leaves Critical or Important findings open, stop dispatching: after round 5 the task is blocked and the human decides. Run `triqual tasks block T<N> "<open findings, one line>" --plan <plan>` (opted in) and write `Task <N>: blocked at fix round 5/5 — <open findings>` to the ledger; nothing is recorded yet (the task's record is written once, when it completes, with `"blocked": true`). Then stop and ask your human partner, with your adjudication of each open finding beside it: the reviewer is wrong or the point is contestable (park it), real but nothing downstream builds on it (park it, deferred), or real and load-bearing (a later task builds on it, or it reveals a plan defect: the smallest change that unblocks the dependent work). Their decision is ledgered as `Task <N>: Ruling: <finding> — <decision>`, and a blocked task leaves `blocked` only through `start`, so every path begins with it. **Park:** run `triqual tasks start T<N> --plan <plan>` (opted in), write `Task <N>: parked — <finding> — Ruling: <why the code stands>` for each parked finding, then squash and finish step 6 (its `done` move, the completion line with `<K> parked`, the record). **More rounds:** run `triqual tasks start T<N> --plan <plan>` (opted in), write `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`, and continue the fix loop with those K rounds as a fresh budget; skip the first granted round's `triqual tasks rework` move: `start` already moved the task to `in_progress`, and `rework` only leaves `in_review` (its re-review's `review` move runs as usual) (round numbering goes on, `fix round 6/<5+K>`; a fresh fixer each round, as for rounds 4–5); when they run out with findings open, the breaker trips again. Never adjudicate before the cap to end a loop: that is pre-judging with a different name.

### 6. Complete the task

When the review comes back clean — or every open finding is parked with a ruling — close the task in this order, before anything of the next task:

1. **Squash:** run `node scripts/stack.mjs squash PLAN_FILE BASE`. It folds every commit of `BASE..HEAD` (the implementer's and every fixup) into one, with `git commit-tree`: the tree of HEAD, the message and author of the range's first commit, never a rebase and never a `git commit`, so no hook runs and no gate fires. It prints the sha of that one commit, or `no commits` for a coordinator task that made none (then the sha is `git rev-parse HEAD`).
2. **Progress entry:** the implementer's entry rode on its commit (fix-round entries keep their pre-squash shas); your own review or ruling entries land per Tracking paths. Squash makes no `git commit`, so it needs no entry and stamps none.
3. **Ledger move:** when opted in, run `triqual tasks done T<N> --commit <sha> --plan <plan>` with the sha the squash printed. In committed or local mode the move leaves the task ledger and `status.md` dirty: the next task's commit stages them; in store mode it leaves no file dirty.
4. **Ledger, right away:** `Task <N>: complete (commits <base7>..<head7>, review clean)`, with `<head7>` the squashed sha, or `Task <N>: complete (commits <base7>..<head7>, <K> parked)`, so a crash after this point never re-dispatches a finished task.
5. **Record:** write the task's `task-review` record (see Records) and run `triqual role-eval record --plan <plan file> <json-file>`.

Then mark the todo complete and move on. Never start the next task while the review has open Critical/Important issues that are neither fixed nor parked with a ruling, and never batch these moves "until the end": the ledger is what a resumed session reads.

### 7. End the phase

When the phase's last task is complete, close the phase before starting the next:

- **Phase check.** Run the phase's `**Phase check:**` command at the tip of the phase branch; a plan with no `## Phase` heading (or no `**Branch prefix:**` line) is one phase whose check is the repository's full test command. A failure that passes on one re-run is flaky: ledger `Ruling: <test> flaky — passed on re-run — <what it costs if wrong>` and go on. A real failure reopens the phase's last task: when opted in, run `triqual tasks reopen T<N> "<reason>" --plan <plan>`, then run the fix loop on it, skipping the first round's `rework` move (`reopen` already moved the task to `in_progress`), with `tier-check` and the re-review as in any round, a squash with BASE the parent of the task's squashed commit, its `done` move again and a `task-review` record with the next `attempt`; then run the Phase check again.
- **Done and submit.** Run `node scripts/stack.mjs done PLAN_FILE N`, then `node scripts/stack.mjs submit PLAN_FILE N`. In GitHub mode `submit` pushes this plan's phase branches only (the ledgered authorization covers it), opens or updates the draft PR and prints `Phase <N>: submitted (<branch>, PR #<n> draft)`; ledger that line. In local mode it prints `local mode: nothing to submit`; ledger `Phase <N>: complete (<branch>, local)`.
- **`submit` exits 5** when `gh` failed, and records nothing: ledger a `Ruling:` that names the `gh` message, retry once, and when it fails again run `node scripts/stack.mjs mode PLAN_FILE local`, ledger the `Ruling:`, and continue in local mode.
- **A submitted phase is final:** never amend it, never rebase it and never force push it. A defect found in the code of an earlier, submitted phase is fixed in the current task's commit; at the final review it is fixed in the final fix commit.

## Records

`triqual role-eval record --plan <plan file> <json-file>` validates a record (counts only: no repository, plan, path, diff or finding text), exits 2 and names the bad field (never its value), and derives the idempotency key itself, so a resumed controller re-runs it harmlessly (exit 0 on a write and on `already recorded`). Write each record's JSON to a file in the workspace first. If `record` fails (exit 2 for a usage or schema error or no git repository, exit 1 for a write or lock failure), or `triqual` lacks `role-eval`, write the record JSON into the ledger as one line, `Unrecorded: <record JSON>`, and continue; Finish retries it.

**`task-review`**, one per task and attempt, written once, when the task completes (step 6), never at the breaker. `attempt` is 1, then +1 after each `triqual tasks reopen` of the task. `tier` is the effective tier the task completed at; `declaredTier` the plan's tier (`null` for a tierless task); `raised` is true exactly when `tier` is above `declaredTier` (a tierless task counts as standard). `hunters` holds one entry per hunter sent (none for light): `model` is the `model:` line of the role's installed agent file (on Codex, the routing value), `failed` hunters carry all-zero counts, and each hunter's verdict counts sum to its `candidates`. `gate.findings` counts the gate's findings; `spec.ran` says whether `roles:spec-reviewer` ran, and `spec.confirmed` counts its own findings by severity (candidate verdicts live in `hunters`). `fixRounds` counts this attempt's fix rounds; `blocked` is true when the breaker tripped in this attempt (the human then parked or granted rounds); `coordinator` is true for a coordinator task. A standard task with one fix round:

```json
{ "v": 2, "at": "2026-10-18T14:02:11Z", "provider": "claude", "task": "T3", "kind": "task-review", "attempt": 1,
  "tier": "standard", "declaredTier": "standard", "raised": false,
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

**`hunters`** with task `final`, for the final hunters (see Final Review), with the final review's budget (reference 3):

```json
{ "v": 1, "at": "2026-10-18T18:12:40Z", "provider": "claude", "task": "final", "kind": "hunters",
  "hunters": [
    { "category": "correctness", "model": "claude-haiku-5-5", "failed": false, "candidates": 1,
      "confirmed": { "critical": 0, "important": 1, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "security", "model": "claude-haiku-5-5", "failed": false, "candidates": 0,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "spec-drift", "model": "claude-haiku-5-5", "failed": false, "candidates": 1,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 }
  ],
  "budget": { "reference": 3, "used": 3, "overrun": false } }
```

**`final-escapes`**, once per plan, after the final review: one entry per final-review finding (a confirmed candidate included) that the final reviewer traced to a task, with that task's effective tier and the finding's severity; `untraced` findings are not entries, and a final review with none writes `"escapes": []`:

```json
{ "v": 2, "at": "2026-10-18T18:30:05Z", "provider": "claude", "task": "final", "kind": "final-escapes",
  "escapes": [ { "tier": "light", "severity": "important" }, { "tier": "standard", "severity": "minor" } ] }
```

## Final Review

The final review always runs: for every plan, whatever its tiers, after the last phase is submitted.

- **The package:** run `node scripts/review-package PLAN_FILE MERGE_BASE HEAD`, with MERGE_BASE the commit the stack started from (`git merge-base <trunk> HEAD`): the review covers `trunk..top`, every phase.
- **First, the final hunters.** Dispatch together, in the background, 3 hunters (`roles:hunter`, [hunter-prompt.md](hunter-prompt.md)): `correctness` across tasks, `security` and `spec-drift`, each with the package, the spec and the plan in place of a brief, writing `final-candidates-<category>.md` in the workspace; wait up to a soft limit of 20 minutes from their dispatch. A late or failed hunter is recorded `failed`. Ledger: `Round 1: final — hunters <done>/<sent>`. After a `Skipped:` line, dispatch the final reviewer with no candidates.
- **Then** dispatch `roles:final-adversarial-reviewer` with [final-review-prompt.md](final-review-prompt.md), filled with the package path, the plan, the spec, the plan's Review Focus verbatim, every final candidates file, and the workspace ledger (`sdd-ledger.md`). It verifies every candidate, names the task (not only the phase) of each finding it can trace, and triages every `Ruling:`, deferred-minor and parked line. A missing verdict sends the review back. Ledger: `Round 2: final — verdicts <n>/<n>`.
- **Records:** the final hunters' `hunters` record (task `final`) and the plan's `final-escapes` record, counting each traced finding against its task's effective tier: its `effectiveTier` in `triqual tasks export --json` (opted in), else the ledger's last `Tier:` or `Tier raised:` line for that task. `Unrecorded:` on a failure.
- **Fix wave.** If the final review returns findings, dispatch ONE `roles:review-fixer` with the complete findings list — not one fixer per finding. It carries the Tracking section when opted in (Stage/task `Plan <topic> · final fix`). The fix wave is one plain commit on the top phase (`fix: address final review findings`), the only commit of the stack that is not a task, never a `--fixup`. Then run exactly one scoped re-review of the fix range by `roles:final-adversarial-reviewer` with [re-review-prompt.md](re-review-prompt.md) (`node scripts/review-package PLAN_FILE FIX_BASE HEAD`). There is no second fix wave: residual findings are parked with rulings, or ruled on when load-bearing, and surface to your human partner through methodology:finishing-branch.
- **Submit.** Run the top phase's Phase check again, then `node scripts/stack.mjs submit PLAN_FILE <top N> --open`, which pushes the fix commit and marks every phase's PR ready for review. A clean final review with no fix wave goes straight to that `submit` with `--open`. When residual Critical or Important findings remain open after the re-review, push the fix commit without marking anything ready, with `node scripts/stack.mjs push PLAN_FILE <top N>` (it refreshes the PR body and never changes the draft state), and leave the ready decision to your human partner.

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
- `Tier: T<N> <tier>`
- `Tier raised: T<N> <from> → <to> — <reason>`
- `Budget: hunters <matrix> → <used> for T<N> — <reason tied to the diff>`
- `Round 1: T<N> — hunters <done>/<sent>, safety ok`, `Round 2: T<N> — verdicts <n>/<n>` (light: `Round 2: T<N> — light items <n>`), and the same with `final`
- `Review: T<N> — no commits, nothing to review`
- `Re-review: T<N> round <R> — applies Ruling verbatim, no security logic`
- `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`
- `Task <N>: minor (deferred): <one-liner>`
- `Task <N>: blocked at fix round 5/5 — <open findings>`, then the human's decision: `Task <N>: Ruling: <finding> — <decision>`, and for more rounds `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`
- `Task <N>: parked — <finding> — Ruling: <why the code stands>`
- `Task <N>: complete (commits <base7>..<head7>, review clean)` / `(commits <base7>..<head7>, <K> parked)`
- `Phase <N>: submitted (<branch>, PR #<n> draft)` / `Phase <N>: complete (<branch>, local)`
- `Ruling: <what you decided> — <why> — <what it costs if wrong>`
- `Skipped: hunters and Haiku gate — <cause>; safety checklist runs in the spec review`
- `RateLimit: <role> <time>`
- `Unrecorded: <record JSON>`

## Finish

Before you delete anything, collect every ledger line containing `Ruling:` — preflight rulings, tier raises you ruled on, parked findings, breaker decisions, all of them — into your final message under "Rulings I made", in the order you made them, each with what it costs if wrong. The list is exhaustive: that list is the only place the decisions you took on your human partner's behalf reach them.

Before the totals, re-run `triqual role-eval record --plan <plan file> <json-file>` for every record that has an `Unrecorded:` line, writing its JSON to a file first; `already recorded` is fine. List every record that still fails in your final message under "Unrecorded records", each with its JSON: the workspace takes the line with it.

Total the review from the ledger before you delete the workspace: actual hunters, the sum of `<sent>` over every `Round 1:` line (the final one included), against the matrix's reference (4 per heavy task, 2 per standard, 0 per light, by each task's final effective tier, plus 3 for the final review; the tier is its `effectiveTier` in `triqual tasks export --json` (opted in), else the ledger's last `Tier:` or `Tier raised:` line), and the tasks per effective tier with how many were raised. When opted in, the closing `progress.md` entry (written under methodology:finishing-branch) states them.

When the final review is clean and its fixes are pushed, delete this plan's workspace (`rm -rf <workspace>`) — the git history is the record now. Sibling directories belong to other plans; leave them alone.

The plan's `## After Merge` checklist is not run: those operations need the merged trunk and are not tasks. Copy each one, with its command, into the final message under "After Merge". Leave the stack state file, `.methodology/stack/<plan file stem>.json`, in place: methodology:finishing-branch deletes it once the stack is merged.

Use methodology:finishing-branch.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's light, it obviously needs no review" | Light shortens the review to the safety gate; it never removes it. Every task with commits gets at least the gate. |
| "The diff is bigger than the plan said, but the plan says light" | `tier-check` decides from the diff, and its raise stands. A tier is never lowered. |
| "The user asked to skip the gate / lower the tier" | Neither is a stop and neither is yours to grant. Say so in one line and run the review. |
| "Bookkeeping can wait until the end" | `squash`, `tasks done` and the record close each task before the next starts. The ledger is what survives compaction. |
| "I'll run this small plan inline, it's faster" | Plans run through role agents only. Light tasks get batched light dispatch, not a controller that implements. |
| "Close enough on spec compliance" | Reviewer found spec gaps = not done. Fix, or hit the cap and let the human decide. |
| "I'll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. Resume the fixer. |
| "One more round will converge" | Past round 5 the failure is structural: the task is blocked and the human decides. |
| "The fix was small, skip the re-review" | The matrix names the only exception (a standard fix that applies an approved `Ruling:` verbatim, no security logic). Otherwise every round is re-reviewed, and re-checked by `tier-check`. |
| "This finding is obviously wrong, I'll drop it" | Silent discards are forbidden. Rule in the ledger; adjudicate only at the cap. |
| "The implementer spawned its own reviewer — free extra assurance" | It's a duplicate seat; the task review is the gate. A worker-spawned reviewer is a defect to flag. |
| "I'll name a model to be safe" | A model in the dispatch overrides the role's pinned model. Choose the role; pass no model. |
| "The plan says a reviewer role implements this task — close enough" | A reviewer role is never a task role. Stop and ask. |

## Example

```
[Setup: no worktree asked for; triqual tasks paths --json → opted in, "mode": "store"]
[node scripts/sdd-workspace <plansDir>/billing.md → fresh workspace; ledger created]
[node scripts/stack.mjs init <plansDir>/billing.md → github mode; method chosen at the handoff → Authorization: … — handoff 2026-10-18]
[Tiers at setup: T1 standard, T2 light, T3 light (all declared) → Tier: lines; pre-flight table written]

Phase 1 (node scripts/stack.mjs phase <plansDir>/billing.md 1)

Task 1 (standard, roles:tdd-implementer)
[triqual tasks start T1 --plan billing.md; task-brief; BASE a1b2c3d; dispatch roles:tdd-implementer]
Implementer: DONE, 1 commit, RED → GREEN evidence in the report.
[triqual tasks review T1 --plan billing.md; tier-check … --floor standard → ok standard]
[review-package; round 1: 2 hunters (correctness, security) + gate; round 2: roles:spec-reviewer → clean]
[squash → d4e5f6a; triqual tasks done T1 --commit d4e5f6a --plan billing.md; task-review record; Task 1: complete]

Task 2 (light, roles:tdd-implementer) — first of a light batch
[triqual tasks start T2 --plan billing.md; task-brief; BASE d4e5f6a; dispatch roles:tdd-implementer]
[DONE; triqual tasks review T2 --plan billing.md; tier-check → ok light; gate alone → clean]
[squash → e0f1a2b; triqual tasks done T2 --commit e0f1a2b --plan billing.md; record; Task 2: complete]

Task 3 (light) — resumed, not re-dispatched
[triqual tasks start T3 --plan billing.md; task-brief; BASE e0f1a2b; resume the same implementer with "Next task"]
[DONE; triqual tasks review T3 --plan billing.md; tier-check → raise light standard: code beyond the light allowance: src/pay.mjs]
[triqual tasks retier T3 standard --plan billing.md --reason "…"; Tier raised: T3 light → standard — …; the batch ends]
[standard review: 2 hunters + gate, then roles:spec-reviewer → clean; squash; done; record]

[Phase check passes; node scripts/stack.mjs done <plansDir>/billing.md 1; node scripts/stack.mjs submit <plansDir>/billing.md 1]
[Final review: 3 hunters + roles:final-adversarial-reviewer → clean, no traced findings; hunters and final-escapes records]
[node scripts/stack.mjs submit <plansDir>/billing.md 1 --open; final message with Rulings and After Merge; methodology:finishing-branch]
```
