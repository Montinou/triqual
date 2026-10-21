# Changelog

What changed in each plugin, newest first. The plugin version in each entry is the one the release sets in its
`plugin.json`; the plugins table in the [README](README.md) shows what the marketplace carries now.

## roles 0.4.0

### Added

- **`roles:phase-orchestrator`.** A ninth role agent, Sonnet at medium effort, that runs one phase of a plan by following
  `methodology:executing-plans` for that phase only. It dispatches the other roles, never edits product code, ends on
  any stop with `BLOCKED: <stop> — <details>` and returns a summary of at most 20 lines (phase status, task commits,
  rulings, open minors, errors and fallbacks). It disallows `Edit` and `NotebookEdit` but not `Agent`: it is the only
  role that may dispatch agents, and a test keeps every other role's `Agent` disallowed. It carries the denial rule.
  Codex routing is `gpt-6.1-sol` at medium effort, and the generated Codex agent does not forbid `spawn_agent`. The
  plugin cache is keyed by version, so machines on 0.3.4 do not have the role until they update.

## workflow-gate 0.3.2

### Changed

- `ROLE_MODELS` carries `phase-orchestrator` as Sonnet, so a Workflow `agent()` naming it and an `Agent` start with
  that `subagent_type` count against the Sonnet cap. The caps themselves are unchanged.

## methodology 1.2.0

### Changed

- **The task loop runs on three scripts.** `executing-plans` starts a task with `task-open` (the `start` move, the
  brief, BASE), prepares each review with `task-prep` (the `review` move, `tier-check` and its raise, the hunter pick,
  the review package; `--fix-round` for a fix round) and closes it with `task-close` (squash, `done`, the complete
  line, the `task-review` record, the review progress entry). Each script is idempotent, runs from the main checkout,
  prints `key: value` lines and, on a failure, appends an `Error:` line to the workspace ledger and exits non-zero:
  2 usage, 3 refused precondition, 1 other failure. Nothing fails quietly and no count is guessed.
- **Reviewer footers.** The safety gate, the spec reviewer and the re-reviewer end their final message with a v1
  footer (`<!-- triqual-review v1 -->`, `role:`, `findings:` counts and, for the spec reviewer, one `candidate:` verdict
  per candidate). The dispatcher saves each final message unchanged to `<workspace>/task-<N>-<role>-r<R>.md`, and
  `task-close` builds the `task-review` record from the saved files and the hunters' candidates files: a hunter with
  no usable candidates file is recorded `failed`, and a missing or malformed gate or spec footer is an `Error:` with no
  record.
- **Reopened tasks.** Each close leaves a marker file `task-<N>-closed-<attempt>`. After `triqual tasks reopen`, an
  attempt of 2 or more accepts only gate, spec and hunter outputs saved after the previous marker, so a reopen saves
  fresh gate and spec outputs; a reopen that runs only a re-review cannot be closed until they exist.
- **Ledger vocabulary.** New lines: `BASE: T<N> <sha>`, `Prep: T<N> r<R> <head sha>` and `Error: <step> T<N> — exit
  <code> — <first stderr line>`. Finish lists the ledger's `Error:` and fallback lines under "Errors and fallbacks",
  and the closing progress entry counts them.

## methodology 1.1.0

### Changed

- **A deep review per phase.** After a phase's Phase check and before `stack.mjs done` and `submit`, `executing-plans`
  runs 4 hunters (correctness, security, spec-drift, state) and one Opus `roles:final-adversarial-reviewer` over the
  phase diff, with at most two fix rounds, each a separate `fix(...)` commit with a scoped re-review. A phase review
  that is still blocked after the second round is a seventh stop.
- **Smaller per-task reviews.** A `heavy` task gets 2 hunters, correctness plus security or state, picked from its
  heavy reason line; a `standard` or `light` task gets none. On a `standard` task the safety gate and the spec review
  run in parallel. A heavy task's hunter candidates are verified by `roles:spec-reviewer` in round 2.
- **The final review is a seams review.** For a plan with several phases it is one `roles:final-adversarial-reviewer`
  and no hunters, and looks only at the interfaces one phase exposes and a later one consumes, cross-phase state and
  every open `Ruling:`, deferred-minor and parked line. In a single-phase plan the phase review is the final review and
  no second review runs; its `P1` records stand.
- **A `/clear` break per phase.** Every phase but the last ends with a break, so the next phase starts from a clean
  context.
- **Leaner controller reading.** The controller reads only the plan, the spec's Units and the current slice.
- **`triqual role-eval` takes phase ids.** A `hunters` or `final-escapes` record accepts `P<n>` as its task, beside
  `T<n>` and `final`.

## methodology 1.0.2

### Changed

- **`heavy` is narrow and carries a reason.** `writing-plans` and the `executing-plans` rubric make a task `heavy` only for
  security-relevant code, live state or migrations, a contract other code parses, or `roles:complex-implementer`; a
  change that only spans more than one plugin or only touches a public interface is not heavy by that alone. A `heavy`
  task puts a one-line reason as plain text under `**Tier:**`, and a `roles:complex-implementer` task (a live-state
  migration, or a change across systems that one brief cannot describe) puts its reason under `**Role:**`. The plan
  parser reads only the tier word and the role, so the reason line is not a new field.
- **The plan audit checks tiers both ways.** Besides a task tiered lower than its content justifies, it flags a task
  tiered higher than the rubric justifies and a `heavy` or `roles:complex-implementer` task whose reason line is missing
  or does not match the rubric. The controller writes both tier checks into its dispatch to the auditor; the shared
  audit prompt is unchanged.

## progress-tracking 0.5.2

### Fixed

- **A database written by a newer progress-tracking no longer blocks the Stop hook.** A long session still running the
  hooks of an older plugin version after a release migrated `tracking.db` to a newer schema used to block every turn
  with "schema version N, newer than the M this triqual knows" and advise `triqual tracking restore`, which would have
  discarded the newer entries. The open now fails with its own code, `schema-too-new`; the Stop hook warns once per
  change set and lets the turn end, and the advice is to update the plugin and run `/reload-plugins`. The `pre-commit`
  still refuses, and every other store failure still blocks. Only sessions running 0.5.2 or later benefit: a session on
  an older version keeps blocking until it reloads.

## methodology 1.0.1

### Changed

- **headjack is an instruction, not a hook.** `brainstorming` and `writing-plans` say "when headjack is installed, run
  `triqual suggest`", and `using-methodology` no longer says a suggestions block arrives in the prompt by itself.
  Headjack's prompt-time suggestion hook is off by default on the author's machine after an audit found none of its 18
  suggestions taken, 18% of runs timed out, and hosted prompts leaving the machine.
- The review ledger line for a skipped round reads `Skipped: hunters and safety gate — <cause>` (it said "Haiku gate");
  older ledgers still match its prefix.
- `triqual cost [--since] [--until] [--project] [--json]` sums token usage from the Claude Code transcripts on the
  machine, split between the controller session and its subagents, with an estimated price per model from
  `cli/lib/prices.json`.
- `triqual role-eval record` takes a new `escape` kind: a defect that reached trunk after merge (`post-merge-fix`,
  `red-ci` or `bug-report`), once per plan and ref. `triqual role-eval summary --by-tier` reports them per tier.
  `executing-plans` and `finishing-branch` tell the executor to record one whenever a `fix:` commit or a red trunk CI is
  traced to a merged plan.
- `triqual doctor` and the README name headjack's launcher as `cli/headjack`.

## progress-tracking 0.5.1

### Changed

- Registering a plan prints a warning when more than 80% of at least five tasks are `heavy`. The ledger and the exit
  code do not change. `writing-plans` self-review item 7 asks for the same check.

## workflow-gate 0.3.1

### Changed

- The gate counts `brief-writer`, `safety-reviewer` and `spec-reviewer` against the Sonnet cap (they moved from Haiku
  and Opus). The caps themselves are unchanged.

## roles 0.3.4

### Changed

- `brief-writer`, `safety-reviewer` and `spec-reviewer` run on Sonnet. Hunters stay on Haiku, `complex-implementer` and
  `final-adversarial-reviewer` stay on Opus, `tdd-implementer` and `review-fixer` stay on Sonnet. The plugin cache is
  keyed by version, so machines on 0.3.3 keep the old models until they update. The Codex routing table is separate and
  unchanged.

## roles 0.3.3

### Changed

- Every role agent carries the fence denial rule (a "Denied by Policy" section): a call fence refuses is reported, never
  retried another way. The plugin cache is keyed by version, so machines on 0.3.2 keep the agents without it until they
  update.
- The `tdd-implementer` description changed.

## methodology 1.0.0

methodology is now triqual's own orchestrator. It started as a fork of superpowers, and it no longer follows it.

### Changed

- **One orchestrator.** `executing-plans` dispatches a role agent for every plan task and runs only `coordinator`
  tasks itself. Plans run only through subagents; a harness that cannot dispatch a named agent stops and asks.
- **Tiered review.** Each task has a tier, `heavy`, `standard` or `light`, declared by `writing-plans` and raised,
  never lowered, by `tier-check` from the task's real diff. The tier sets the review: four hunters, two hunters or the
  safety gate alone, then the spec reviewer. The safety gate runs at every tier.
- **TDD on every task** that changes behavior, in any tier. A task that changes none records its verification
  command's real output.
- **Stacked branches by default**, one branch and one draft PR per plan phase and one commit per task. A worktree only
  when the human asks. `stack.mjs` gains `push`, which pushes a submitted phase and refreshes its PR body without
  marking it ready. The scripts (`stack.mjs`, `task-brief`, `tier-check`, `sdd-workspace`, `review-package`) now live
  under `skills/executing-plans/scripts/`.
- **Batched light dispatch.** Consecutive light tasks of one phase resume the same implementer, one task at a time.
- **Fence cooperation.** When fence is installed the orchestrator detects it once, leaves skill installs to the
  human and treats a denial as a stop to report, never a call to retry another way.
- **Skills rewritten** in triqual's own words: `using-methodology`, `brainstorming`, `writing-plans` (a tier and a
  role for every task, a plan audit that checks them), `test-driven-development`, `systematic-debugging`,
  `verification-before-completion`, `finishing-branch` and `diagnosing-methodology`.
- **`reviewing-code`** is new: it takes the review of a commit range or a pull request outside a plan and the handling
  of review feedback.
- **`triqual suggest`** runs `headjack suggest`. It used to route to a plugin that does not exist and exit 3.
- **`triqual role-eval`** records `task-review` and `final-escapes` besides `hunters`, and `summary --by-tier` reports
  per review tier. Records hold counts only.
- **Tests** check what the skills must keep (frontmatter, references that resolve, the pinned safety lines) instead of
  pinning their sentences.

### Removed

- Six skills. `subagent-driven-development` became `executing-plans`, and the old inline `executing-plans` went with
  it. `requesting-code-review` and `receiving-code-review` were merged into `reviewing-code`. `using-git-worktrees` is
  a section of `executing-plans`, `dispatching-parallel-agents` is covered by the global rules, and `writing-skills`
  moved to Headjack, together with skill finding (`headjack:writing-skills`, `headjack:skill-finder`).
- The fork machinery: `FORK.md`, `upstream.json`, `triqual upstream-diff`, the fork tests and the footer at the end of
  every skill. Until `triqual sync` runs, an old `~/.local/bin` shim still lists `upstream-diff` and reports it as
  missing.
- Inline plan execution.

### Upgrading

- A plan with no tiers keeps working: a missing tier reads as `standard`, and a resumed execution gets its tiers by
  rubric at setup, raising only.
- `triqual doctor` warns on a Codex skill link that points at a removed skill; `triqual sync --harness codex` replaces
  it.
- To roll back, roll back methodology only. Do not downgrade progress-tracking below 0.5.0 once its store has migrated:
  an older version refuses the newer store.
- After updating the plugins, run one writing `triqual` command (for example `triqual tracking status set --section …`
  or any `tasks` move) before any read-only view. A read-only open refuses a version 1 store until a write migrates it.

### Credit

triqual's methodology began as a fork of [superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT).
Thanks to Jesse for the foundation. `LICENSE-superpowers` and `NOTICE` stay in the plugin.

## progress-tracking 0.5.0

### Changed

- **Tiers in the ledger.** A task keeps its declared tier (the plan's `**Tier:**` line) and an effective tier.
  `triqual tasks retier T<N> <tier> --reason "<text>"` raises the effective tier, does nothing for the same tier and
  exits 2 for a lower one. `status --json` adds a `tiers` map, `next --json` prints `{id, title, role, tier,
  effectiveTier}` or `null`, `export --json` carries both tiers, and `tasks line` and the status view show the
  effective tier.
- **Registration is all or none.** A new plan that declares `**Tier:**` on any task must declare it on every task, and
  `coordinator` must be `light` and `roles:complex-implementer` `heavy`. A plan with no tier registers as before, and
  reading a plan never fails on a missing tier.
- **One plan reader** (`lib/plan.mjs`), shared in a byte-identical copy by the orchestrator's scripts. A task ends at the
  next heading of level 1 to 3 outside a fence, so a field under `## After Merge` no longer attaches to the last task.
  There is no `tasks parse` subcommand.
- **Store schema V2** adds the two tier columns by an appended migration. An older version refuses the migrated store.
- `triqual tasks done T<N> --commit <sha> --repo <path>` records a commit of another repository.

## workflow-gate 0.3.0

### Added

- **A burst cap on the `Agent` tool.** A second `PreToolUse` hook, on `Agent` and `Task`, denies a start when the session
  already started that many agents of the same model in the last 120 seconds. The caps are the Workflow ones (Fable 3,
  Opus 8, Sonnet 12, with the same `WORKFLOW_MAX_*` overrides). Haiku is never denied, starts whose model cannot be
  resolved are counted apart, in their own bucket, capped at the Opus cap, and an explicit `model` wins over the role's. `WORKFLOW_GATE_AGENT_WINDOW_S`
  sets the window. The state is a file per session id under `$XDG_STATE_HOME/triqual/workflow-gate/`, and the hook
  allows whenever its state is unusable.

## memory-report 0.5.0

### Added

- **A "Review tiers" section** in the weekly report, after Chroma health, from `triqual role-eval summary --by-tier`.
  It is left out when the week has no reviewed task or the command fails.
