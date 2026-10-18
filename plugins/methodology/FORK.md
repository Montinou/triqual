# Fork registry: `methodology` ← superpowers

`skills/` is a fork of the superpowers skills (MIT, `LICENSE-superpowers`), imported verbatim from the release that
`upstream.json`'s `vendored` part names. This file registers every intentional deviation from upstream, each with its
reason, in the commit that makes it (spec Addendum E.2). `test/fork.test.mjs` fails when a renamed path, a removed
upstream file or a fork-only file is not registered here.

Entry format, so the test can read it (paths are relative to `skills/`):
- Renames: `` - `old` → `new` — reason ``. A directory entry (`old/` → `new/`) covers every file beneath it.
- Derived: `` - `fork-only path` ← `upstream source` — reason ``.
- Removed: `` - `upstream path` — reason ``.

Ported: the checks compare the fork with the last reviewed release, not the vendored one. `triqual upstream-diff <version>
--mark-reviewed "<summary>"` records that release's skills files in `upstream.json` (`reviewed.files`, path → sha256);
until a review has recorded them, the vendored files are the baseline. So a file ported from a reviewed release (a new
upstream file taken with `--patch`) needs no entry: land the port and the `--mark-reviewed` in the same commit. A file
that release added but the fork does not take is registered under Removed. A file that release deleted upstream is
deleted from the fork too, unless the fork keeps it as a Derived file built from a file the release still has.

## Renames

- `using-superpowers/` → `using-methodology/` — the entry-point skill introduces this system, which supersedes the
  upstream plugin; `methodology`'s SessionStart hook (`cli/drift.mjs`) injects it after the drift lines on startup,
  clear and compact, and leaves it out on resume (E.3).
- `diagnosing-superpowers/` → `diagnosing-methodology/` — it diagnoses sessions that ran this system and points at
  this system's files: the install root `~/.claude/plugins/cache/triqual/`, the SDD workspaces under
  `.methodology/sdd/`, and its own workspace `~/.config/triqual/diagnosing/` (§11).
- `finishing-a-development-branch/` → `finishing-branch/` — a shorter name for the skill that also closes the plan's
  task ledger (§11). Its frontmatter name and announcement follow the new name.

Every reference follows these renames: `superpowers:<skill>` becomes `methodology:<fork name>` (so
`superpowers:finishing-a-development-branch` becomes `methodology:finishing-branch`), relative paths follow the
directory renames (`../using-superpowers/references/` → `../using-methodology/references/`), and example paths
(`docs/superpowers/plans/…`) become `<plansDir>/…`, the plans directory from `triqual tasks paths --json` (E.5).

## Derived

Fork-only files built from an upstream file, with their source.

- `subagent-driven-development/safety-review-prompt.md` ← `subagent-driven-development/task-reviewer-prompt.md` — the
  task review splits into roles (E.4): `roles:spec-reviewer` keeps the upstream template, and this template carries
  the upstream frame (diff package, read-only, no subagents, untrusted report) around `roles:safety-reviewer`'s fixed
  checklist, with tracking files expected in every task diff (§11).
- `subagent-driven-development/hunter-prompt.md` ← `subagent-driven-development/task-reviewer-prompt.md` — the
  dispatch of `roles:hunter` for round 1 of the task review and the final review: the upstream template's diff-package
  inputs and brief path, cut down to the category, the package, the candidates path and the brief (a task) or the
  spec and the plan (the final review). The hunter's standing instructions live in its agent definition (role-tiers
  spec §4.1, §4.3).
- `subagent-driven-development/final-review-prompt.md` ← `requesting-code-review/code-reviewer.md` — upstream's final
  whole-branch review used `code-reviewer.md`; in the fork both final reviews (SDD and `executing-plans`) dispatch
  `roles:final-adversarial-reviewer` with this template (E.4). It keeps the vision-document, declined-to-judge,
  read-only and no-subagents sections, and adds the adversarial method, the plan's Review Focus verbatim, the
  triage of the workspace ledger's `Ruling:`, deferred-minor and parked lines, and the verifier contract for the
  final hunters' candidates (role-tiers spec §4.3, §4.4).
- `subagent-driven-development/scripts/stack.mjs` ← `subagent-driven-development/scripts/sdd-workspace` — fork-only: a
  Node script that owns the git and `gh` operations of a stacked plan execution (one branch, and with `gh stack` one
  draft PR, per plan phase). It keeps its state beside the SDD workspace under `.methodology/`, which is the same
  self-ignoring directory `sdd-workspace` resolves, and finds plan fences by progress-tracking's `parsePlan` rule
  (stacked-execution spec U4, R1-R9).
- `subagent-driven-development/scripts/lib/plan.mjs` ← `subagent-driven-development/scripts/task-brief` — the shared plan reader, a byte-identical copy of progress-tracking's `lib/plan.mjs`
- `using-methodology/references/grok-tools.md` ← `using-superpowers/references/codex-tools.md` — fork-only: a harness
  reference in the form of upstream's Codex one, for Grok, which upstream does not cover. It states the F.11 P6d
  result: Grok's `spawn_subagent` cannot select a named agent, so role dispatch is unavailable there and SDD is
  unavailable in Grok (stop and ask the human partner); `methodology:<x>` is the skill `<x>` (spec Addendum F.7).

## Role dispatch

The forked templates dispatch `roles:*` agents (plugin `roles`) instead of generic agents (E.4). Role dispatches pass
no model: the role's definition pins it.

| Upstream dispatch | Forked dispatch | Template |
|---|---|---|
| `subagent-driven-development` implementer | the task's `**Role:**`: `roles:tdd-implementer` (the default), `roles:complex-implementer` or `roles:review-fixer`; a `coordinator` task is run by the controller itself | `implementer-prompt.md`, header `Subagent (<task role>):` |
| its task reviewer | two rounds: round 1 `roles:hunter` (one per category) and `roles:safety-reviewer` (the gate), together; round 2 `roles:spec-reviewer`, which verifies every candidate | `hunter-prompt.md`, `safety-review-prompt.md`, `task-reviewer-prompt.md` |
| its scoped re-review | the role or roles whose findings the fix addressed | `re-review-prompt.md` |
| its fix rounds | `roles:review-fixer` (rounds 1–3 resume the same fixer; rounds 4–5 a fresh one); a `roles:complex-implementer` task's go to `roles:complex-implementer`, the same way | in `SKILL.md` |
| its final whole-branch review | 3 `roles:hunter` together, then `roles:final-adversarial-reviewer`, which verifies their candidates | `hunter-prompt.md`, `final-review-prompt.md` |
| `executing-plans` per-task review (upstream has none) | the same two-round stage as SDD's task review | `hunter-prompt.md`, `safety-review-prompt.md`, `task-reviewer-prompt.md` |
| `executing-plans` final whole-branch review | 3 `roles:hunter` together, then `roles:final-adversarial-reviewer`, which verifies their candidates | `hunter-prompt.md`, `final-review-prompt.md` |
| `requesting-code-review` reviewer | `roles:spec-reviewer` | `code-reviewer.md` |
| `brainstorming` spec-document reviewer | `roles:final-adversarial-reviewer`, always | `spec-document-reviewer-prompt.md` |
| `dispatching-parallel-agents` | the matching `roles:*` agent; a generic agent, with an explicit model, only for work no role covers | in `SKILL.md` |

Reason: routing work to roles, with implementation and review kept in separate roles, is the point of the fork. The
change to `requesting-code-review` and `dispatching-parallel-agents` departs from §11's limit on technique skills
(E.4). Each row lands with the task that adapts its template; `requesting-code-review`,
`dispatching-parallel-agents`, `brainstorming`, `subagent-driven-development` and `executing-plans` are adapted. `writing-plans` dispatches the same audit, with
`brainstorming`'s template, on every plan.

## Workspace and ledger

- `brainstorming`'s visual companion keeps its sessions under `<project>/.methodology/brainstorm/` (upstream:
  `.superpowers/brainstorm/`), and `scripts/start-server.sh` writes `<project>/.methodology/.gitignore` (containing
  `*`) when it is missing. Reason: mockups would otherwise be dirty files the Stop hook blocks on (E.5).

- The SDD workspace is `<repo>/.methodology/sdd/<plan-basename>/` (upstream: `.superpowers/sdd/<plan-basename>/`), and
  its ledger is `sdd-ledger.md` (upstream: `progress.md`, a name that collides with the tracking file). The ledger's
  first line stays `# SDD ledger — plan: <plan path>`. `subagent-driven-development/scripts/sdd-workspace` writes
  `<repo>/.methodology/.gitignore` containing `*` (upstream wrote `.superpowers/sdd/.gitignore`), so the workspace
  never shows in `git status` or to the Stop hook. `task-brief` and `review-package` follow it (their comments name
  the new default). Reason: §6.4 and E.5.
- Legacy adoption: when `sdd-ledger.md` is missing and `<repo>/.superpowers/sdd/<plan-basename>/progress.md` exists,
  `sdd-workspace` copies it once to `sdd-ledger.md` and leaves the old directory in place, marked with an `adopted`
  file so a deleted finished workspace never brings it back. Only a legacy workspace whose `plan-path` marker names
  exactly this plan is adopted. The one script line naming the old path is allowlisted in
  `test/fork.test.mjs`. Reason: in-flight runs keep their ledger across the fork (E.5).
- `executing-plans/scripts/task-done` appends its completion line to the same `sdd-ledger.md` (upstream: the
  workspace's `progress.md`), so both executors share one ledger. Reason: E.5 (the only workspace ledger name).

## Text adaptations

Line-level changes to the technique skills, within §11's limit (paths, names, the language policy, references to
replaced skills):
- The language policy line (artifacts in English; conversation mirrors the language of the user's message) is added
  to the skills that write artifacts: `test-driven-development`, `systematic-debugging`, `receiving-code-review`,
  `writing-skills` and `diagnosing-methodology`. Reason: this system's language rule (§2).
- Every forked `SKILL.md` ends with the attribution line
  `Forked from superpowers 6.4.2 (skills/<upstream-name>), MIT © Jesse Vincent — see LICENSE-superpowers.` Reason:
  MIT attribution (E.2).
- `diagnosing-methodology` reports on this system instead of upstream: its workspace, install root and involvement
  section name `methodology`, and GitHub issues go to this system's repository (`<methodology-repo>`, read from the
  marketplace source). Upstream's issue labels and its `diagnosis_report.md` issue template exist only in upstream's
  repository, so `references/github-issues.md` files the issue without them. It searches and files with an
  authenticated `gh` only (`gh auth status` first); upstream's unauthenticated curl and prefilled-link fallbacks are
  dropped, since this system's repository may be private. Reason: §11.
- `using-methodology` adds a "This System" section: how to treat a `skill-suggest` suggestion (offer it, never
  install without the user's OK), the language rule, and the supersede rule "never use a `superpowers:*` skill when
  one is listed: `methodology` supersedes it" (E.3). Its skill-priority examples name `methodology:*` skills, its
  platform list keeps Claude Code, Codex and Hermes Agent (the four removed references below), and its references
  name `methodology` skills and the `finishing-branch` rename. Reason: §11 and E.3.
- `requesting-code-review` and `dispatching-parallel-agents` change their dispatch as the Role dispatch section says,
  and example plan paths (`docs/superpowers/plans/…`) become `<plansDir>/…`. Reason: E.4 and E.5.
- `brainstorming` and `writing-plans` take their tracking paths from `triqual tasks paths --json`, with three cases: opted
  in (`specsDir`, `plansDir`, `progress`, `status`), not opted in (`docs/specs/` and `docs/plans/`, no `triqual tasks`
  command, never creating `progress.md`) and `triqual` missing (as not opted in, said once). `brainstorming` runs
  `triqual suggest` at the start and skips it silently on exit 3. The spec audit (`brainstorming`) and the plan audit
  (`writing-plans`) always dispatch `roles:final-adversarial-reviewer` with `spec-document-reviewer-prompt.md`, which
  now covers plans too. Reason: §11, E.4 and E.5.
- `writing-plans` emits §6.2's task format with the `**Role:**` line (E.5) on every task and its rule for choosing
  among the task roles; fills `**Skills:**` from `triqual suggest` only when it exists; ends, when opted in, with
  `triqual tasks init <plan>` (in local mode a draft in the OS temp dir and `triqual tracking write plan <draft>`, the same as
  `triqual tasks init --adopt <draft>`, since Claude Code protects `.git/` from agent file writes) and the plan's registration in `progress.md` and `status.md`. Its plan
  header and handoff name `methodology:*` skills, and the Native option says each task still gets its reviews (E.4).
  Reason: §11, E.4 and E.5.

- `brainstorming` requires every architectural spec to carry `## Units` (per unit: Purpose, Interface, Depends on,
  Acceptance) and `## Delivery Slices` (per slice: Delivers, Units, Stands alone because, Acceptance), with the rules
  that a slice depends only on earlier slices, slices cover every unit, a slice over about 6 atomic tasks is split and
  operations that need the merge go under the rollout. The Architectural checklist, "Presenting the design" and "Design
  for isolation and clarity" name them, the Spec Self-Review gains a fifth check, Modularity, and
  `spec-document-reviewer-prompt.md` gains a Modularity row for specs. Reason: stacked execution (a plan maps slices to
  phases instead of re-designing).
- `writing-plans` writes plans as `## Phase` blocks (Slice, Branch, PR title, Stands alone because, Phase check; one PR
  each) of atomic one-commit `### Task` blocks with global numbering, about 6 tasks per phase and an optional
  `## After Merge` checklist; the header gains `**Branch prefix:**`, Task Right-Sizing is rewritten around one commit,
  the self-review gains a sixth check, Phases, and `spec-document-reviewer-prompt.md` gains a Phases row for plans.
  Reason: stacked execution (one branch and PR per phase).
- `writing-plans` Execution Handoff, both branches (and the paragraph above them), states that execution builds a stack
  and, in GitHub mode, pushes this plan's phase branches and opens and updates their draft PRs; choosing the method, or
  confirming the plan when the method was already supplied, authorizes that push, the execution skill records it in its
  ledger as `Authorization: push phase branches and draft PRs — handoff <date>`, and merging stays the partner's.
  Reason: stacked execution (explicit, ledgered push authorization). `subagent-driven-development` and
  `executing-plans` write that `handoff` line themselves at setup when the method was chosen at the handoff in the same
  conversation, and ask once only without such a choice.
- `subagent-driven-development` dispatches by role (Role dispatch above). Its "Model Selection" section, which told
  the controller to always specify a model, becomes "Role Dispatch": the task's `**Role:**` (default
  `roles:tdd-implementer`; `roles:complex-implementer` for a task the plan marks complex; `coordinator` run by the
  controller with the same ledger moves and reviews; any other role, a reviewer role included, `roles:hunter` among
  them, stops and asks), the two-round task review (round 1 hunters and gate together; round 2 the spec reviewer
  verifying every candidate; no hunters in fix rounds, re-reviews or a task without a review package; with Haiku
  unavailable the hunters are skipped and the spec reviewer runs the safety checklist, through
  `task-reviewer-prompt.md`'s optional Safety Checklist section; a soft budget with `Budget:` lines and
  `triqual role-eval record`), re-review by the raising role or roles,
  fix rounds to `roles:review-fixer` (rounds 1–3 the same fixer, 4–5 a fresh one each; a `roles:complex-implementer`
  task's to `roles:complex-implementer`, the same way) and `roles:brief-writer` only
  when a brief lacks interfaces from the code. No template carries a `model:` line. Model escalation is gone: a
  BLOCKED report needing more reasoning is split or ruled on, and the fifth stop reason is a task role outside the
  task roles. It reads tracking paths from `triqual tasks paths --json` with the three cases, moves the task ledger
  (`triqual tasks start` on dispatch, `review` on DONE, `rework` per fix round, `done --commit <sha>` on approval) when
  opted in, skipping after compaction any move `triqual tasks status --json` and the ledger already show, and the implementer template carries a Tracking section (the `progress.md` entry and staging rules, only
  when opted in) and a Task Skills section (§11's rule, whenever the brief has `**Skills:**`; its ledger check when
  opted in). The upstream process, circuit breaker, ledger discipline and pre-flight scan are unchanged. Reason: §11,
  E.4 and E.5.
  It also runs the plan as a stack (the stacked-execution spec, U5): Setup runs `scripts/stack.mjs init` (committed
  tracking mode stops the run) and reads or asks once for the ledgered push authorization; each phase starts with
  `scripts/stack.mjs phase`, each task is one dispatch and one commit (the batching paragraph is gone, fix rounds
  commit with `--fixup`, `scripts/stack.mjs squash` folds the task before its `done` move), and each phase ends with
  its Phase check, `done` and `submit`; a submitted phase is never rewritten, the final fix wave is one commit on the
  top phase, and the push stop gains one exception, the ledgered authorization. `implementer-prompt.md` asks for one
  commit and fix rounds as `--fixup`; `final-review-prompt.md` has the reviewer name each finding's phase. Reason:
  the stacked-execution spec (U5, R1, R2, R4, R7).
- `subagent-driven-development/scripts/task-brief` finds fences by progress-tracking's `parsePlan` rule instead of
  toggling on every line that starts with three backticks: a run of 3+ backticks or tildes indented under four
  columns (a tab counts as four) opens a fence, and only a run of the same character at least as long, with nothing
  after it, closes it. Reason: E.8 — both parsers must see the same tasks; `test/fixtures/fences-plan.md` pins them.
- `executing-plans` keeps upstream's inline process (one implementing context, the ledger, TDD per step, the
  completion contract, one final fix pass verified by TDD) and adds what the fork requires:
  - every task goes to SDD's two-round task review (round 1 `roles:hunter` and `roles:safety-reviewer` together;
    round 2 `roles:spec-reviewer`), with SDD's `hunter-prompt.md`,
    `safety-review-prompt.md` and `task-reviewer-prompt.md`; upstream had no per-task review. With a subagent tool the
    executor never reviews its own task; without one it performs both reviews itself and ledgers that. Findings go to
    fix rounds the executor runs itself by TDD (it is the implementer), each followed by a scoped re-review by the
    raising role or roles (`re-review-prompt.md`), five rounds at most, then SDD's breaker. The executor writes a
    task report for the reviewers. `scripts/task-done` now runs after the review, not before it.
  - the final review dispatches 3 `roles:hunter` together, then `roles:final-adversarial-reviewer`, which
    verifies their candidates, with SDD's `hunter-prompt.md` and `final-review-prompt.md` (upstream:
    `requesting-code-review/code-reviewer.md` on "the most capable available model"); no dispatch passes a model,
    and the advice to run inline on a mid-tier session model is dropped.
  - tracking paths from `triqual tasks paths --json` with the three cases (opted in, not opted in, `triqual` missing); when
    opted in, the same task-ledger moves as SDD (`start` in `scripts/task-start`, `review` and `rework` in the review
    step, `done --commit <HEAD>` in `scripts/task-done`), the `progress.md` entry and staging rules on every commit,
    and after compaction the reconcile with `triqual tasks status --json`. The two scripts keep their upstream signatures
    and read `triqual tasks paths --json` themselves: opted in, they move the ledger with `--plan <plansDir>/<plan>` and
    look up a plan named by file name only in `plansDir` (local mode keeps plans under the git dir); not opted in
    (`"optedIn": false` or exit 2) or `triqual` missing (exit 3, or not on `PATH`, said once) they skip the move. Neither
    ever creates `progress.md`. A failing ledger move fails the script, and `task-done` then records nothing. Before
    moving, each script reads the task's status from the plan's `*.tasks.json` that `triqual tasks status --json` locates
    and skips a move the ledger already shows (`task-start`: `in_progress`, `in_review` or `done`; `task-done`:
    `done`), so a resumed session never fails on a move it already made.
  - `task-done` fixes an upstream bug: a passing test command with no output made it exit 1 without a message
    (`grep` finding no line under `set -o pipefail`) and record nothing. The last output line is now computed with
    `|| true`, falls back to `(no output)`, and is computed before the ledger move, so no failure can leave a moved
    task without its `sdd-ledger.md` line.
  - references follow the renames (`methodology:*`, `../using-methodology/references/`, `<plansDir>/…` in the
    example).
  - it runs the same stack as `subagent-driven-development` with the controller as implementer (the stacked-execution
    spec, U5, R1, R2, R4, R7): Stack setup runs `../subagent-driven-development/scripts/stack.mjs init` (committed tracking
    mode stops the run) and reads or asks once for the ledgered push authorization; each phase starts with `stack.mjs
    phase` and ends with its Phase check, `done` and `submit`; fix rounds commit with `--fixup`; the final fix pass is one
    commit on the top phase, then the top Phase check and `submit --open`; and the push stop gains one exception, the
    ledgered authorization. `scripts/task-done` locates the state file with `stack.mjs path`, and when it exists runs
    `stack.mjs squash` after the test command passes and before the ledger move, so the move and the completion line
    record the squashed HEAD; a refused squash (exit 3) fails the script with nothing recorded.
  Reason: §11, E.4 and E.5; the stacked-execution spec.
- `finishing-branch` adds Step 2, Close the Plan, between the test run and the environment check (later steps are
  renumbered): when opted in it runs `triqual tasks check` (drift stops the close), `triqual tasks close`, writes the closing
  `progress.md` entry (Stage/task `Plan <topic> · close`), updates the roadmap in `status.md`, and makes the closing
  commit carrying those files and the dirty task ledger; not opted in or with `triqual` missing it skips to the options.
  The options are upstream's (merge, PR, keep, and discard only on an explicit request with the typed confirmation).
  The worktree-provenance note names `methodology:using-git-worktrees` instead of upstream's product name. Reason:
  §11 and E.5.
  It also integrates a stack (the stacked-execution spec, U6, R5, R6): Step 1 runs the suite on the top phase's branch
  when `subagent-driven-development/scripts/stack.mjs path` names an existing state file; with one, Step 5 replaces the
  options with a GitHub menu (leave the stack open, or merge now with `gh stack merge <pr> --yes --merge-method <m>`,
  the owner naming the PR and the method) or a local one (`git merge --ff-only` on the trunk, push and open as stacked
  PRs through `stack.mjs mode … github` and `submit`, or keep). The closing commit is skipped, and the closing entry
  and status `Next` always carry the plan's `## After Merge` checklist, marked to run once merged; it runs only when
  the top phase's PR merged in the session (then `gh stack sync --prune` or deleting the phase branches, the state
  file's deletion, and a second progress entry recording the run). With no state file the current menu stays. Reason: the
  stacked-execution spec (U6, R5, R6).
- `using-git-worktrees` makes a worktree opt-in: its description triggers only on an explicit request (upstream: also
  "before executing implementation plans"), Step 0 works in place without a blocking consent question when nothing
  was asked, and the rationalization table adds the plan-execution, autonomy and cleanup excuses. `subagent-driven-development`
  and `executing-plans` Setup run the plan in the current checkout (the stacked phase branches are the isolation) and
  create a worktree only on that request; `writing-plans`' context line says the same. The reviewer prompts
  (`requesting-code-review/code-reviewer.md`, `subagent-driven-development/final-review-prompt.md`) read other
  revisions with `git show` or a `git archive` export they delete, never `git worktree add` (upstream left
  `/tmp/review-<sha>` worktrees registered). Reason: stacked execution makes a worktree redundant, and unrequested
  worktrees were piling up on the owner's machine. `finishing-branch` Step 7 also removes a worktree this session
  created with a native tool (`ExitWorktree` with `action: "remove"`; upstream left every non-`.worktrees/` worktree
  to the host). Same reason.
- `using-methodology/references/claude-code-tools.md` drops the advice to hand a whole plan to one orchestrator
  subagent on a mid-tier model and describes role dispatch instead (coordination stays in the session);
  `codex-tools.md`'s "Model routing on spawns" points at role files instead of the removed "Model Selection". Reason:
  E.4 (role dispatches pass no model).
- `using-methodology/references/codex-tools.md`'s "Role routing on spawns" is rewritten: `roles:<name>` is
  `spawn_agent` with `agent_type: "<name>"` (the agent file `triqual sync` generates from the `roles` plugin, which sets no
  model), its "Tools you must not use" sentence is the effective restriction, a missing role stops and asks instead of
  spawning a generic agent (except `hunter`, whose absence is the review stage's skip rule (one
  `Skipped:` ledger line, never a stop)), and `methodology:<x>` is the skill `<x>`. `using-methodology/SKILL.md`'s platform list adds
  Grok (`references/grok-tools.md`, under Derived). The E.7 check that only `dispatching-parallel-agents` names a
  generic agent exempts exactly these two references, which name one to rule it out. Reason: spec Addendum F.7, F.10.
- Local-mode tracking writes go through `triqual tracking write` in `brainstorming`, `writing-plans`,
  `subagent-driven-development` (its SKILL.md and the implementer template's Tracking section), `executing-plans` and
  `finishing-branch`: the spec, plan, `progress.md` entry or whole `status.md` is drafted in the OS temp dir and landed
  with `triqual tracking write spec|plan|entry|status <draft>` (`--replace` for an edited spec or plan; `plan` is
  `triqual tasks init --adopt`). Committed mode is unchanged. Reason: Claude Code refuses an agent's Edit/Write and shell
  redirects under `.git/` ("sensitive file"), but lets an allowed program write there (plan sp3-orchestration T16).
- `executing-plans/scripts/task-start` and `task-done`: a `triqual tasks status --json` listing or ledger that cannot be
  parsed gives no status, so the move is made instead of the script failing; `task-done` appends its `sdd-ledger.md`
  completion line once per BASE..HEAD range, so a re-run adds no duplicate. Reason: resumed sessions (T7 review).

## Removed

- The visual companion's remote branding and telemetry switch, in `brainstorming/scripts/server.cjs` (the file stays):
  the logo image loaded from the upstream author's host, the link to the upstream repository, the upstream version
  label, and the telemetry opt-out variables whose only effect was to switch that logo off; `frame-template.html`
  loses the logo styles. The header shows a plain local label. Reason: skill scripts reach no host outside loopback
  (E.7), and the fork is not upstream's product.
- `using-superpowers/references/antigravity-tools.md` — a harness this system does not run, and it dispatches
  generic agents (E.2). The multi-harness sub-project (E.10) restores what it needs.
- `using-superpowers/references/gemini-tools.md` — same reason; `writing-skills` also loses its link to it.
- `using-superpowers/references/muse-tools.md` — same reason.
- `using-superpowers/references/pi-tools.md` — same reason.

## Review log

2026-09-28 6.4.2 vendored
