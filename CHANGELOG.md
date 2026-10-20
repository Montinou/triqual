# Changelog

What changed in each plugin, newest first. The plugin version in each entry is the one the release sets in its
`plugin.json`; the plugins table in the [README](README.md) shows what the marketplace carries now.

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
