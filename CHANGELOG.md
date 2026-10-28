# Changelog

What changed in each plugin, newest first. The plugin version in each entry is the one the release sets in its
`plugin.json`; the plugins table in the [README](README.md) shows what the marketplace carries now.

## methodology 1.5.0

- New skill `auditing-performance`: audits the cost, speed and review yield of the plugins and roles from the machine's own records, with a collector script, and feeds the gaps back into the skill.
- Light is the default tier. `tier-check` ignores test lines when it counts a task's changed lines, and the light allowance is 100 lines.
- `tier-check` reads an optional `**Test paths:**` line in the plan header, so a repository's own test locations count as tests.
- `executing-plans` moves its reference sections (setup, records, ledger vocabulary, parallel tasks, worktrees, final review, example) from `SKILL.md` to `references/*.md`, and gains controller guidance, "Running the session cheaply".
- Update the plugin and run `triqual sync --yes`, then reload plugins or start a new session.

## roles 0.4.2 / methodology 1.4.3

- Lower the final adversarial review to Opus at low effort, with Astra at low effort in Codex.
- Prefer Terra 6.1 for Codex implementation, review fixes, spec review, complex implementation and phase orchestration; preserve each role's existing effort level.
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session to load the new role defaults.

## progress-tracking 0.7.1

- The run board opens on a project board when two or more repos are registered: a summary bar with four count chips and four urgency lanes (Needs you, Running, Up next, Done & quiet), one row per project; click a row to open its plan.
- Update with `triqual sync --yes`, then `/reload-plugins`.

## methodology 1.4.2

### Changed

- **No pause between phases.** `executing-plans` no longer ends its turn after each phase's `submit` asking for
  `/clear` and "continue the plan": the next phase starts at once in the same session, and compaction (with the
  ledger and `stack.mjs status` as the resume point) handles context. The seven stops are framed as decisions only the
  human can make; anything a ruling can settle is not a stop, and the only other stop is one the human agreed to in
  advance.

## progress-tracking 0.7.0

- The run board now pushes live snapshots over SSE, defaults to port 47800, remembers its theme, and puts active repos and tasks first.
- Six asynchronous hooks record session and agent ids with safe tool labels in a separate private `sessions.db`; `TRIQUAL_SESSIONS=0` disables recording.
- The collapsible Agents panel shows parent-linked cards and newest-first feeds with optional read-only claude-mem notes; viewer selections survive pushes.
- Update with `triqual sync --yes`, check `triqual doctor`, then `/reload-plugins` to load recorder hooks. Synchronous harnesses such as Grok pay about 120 ms per event.

## progress-tracking 0.6.0

### Changed

- **`triqual ui` is the run board.** The dashboard shows one registered repo at a time, with a switcher, instead of
  every repo on one page. For the repo in view it has a tab per plan, a plan rail with a cell per task, the plan's tasks
  with filter chips (Open by default, All, and one per status), the latest progress entries, and the `status.md` text
  in a folded panel. An empty registry, a repo with no plan, a plan with nothing open, a blocked plan and a lost
  connection each have their own state, and a failed refresh keeps the last good data under a banner. The fonts (Geist,
  Geist Mono and Bricolage Grotesque) ship with the plugin, so the page loads nothing from outside. The guarantees are
  unchanged: it binds `127.0.0.1`, answers `GET` only for a fixed list of paths, checks the `Host` header, and sends
  `Content-Security-Policy: default-src 'self'` and `Cache-Control: no-store`.

## progress-tracking 0.5.4

### Fixed

- **An older database is never told to restore.** When a read-only open refuses a database of an older schema (the
  Stop hook, the session-start notice, the store `pre-commit`), the message no longer appends `recover with triqual
  tracking restore`: its own text already names the fix, any write such as `triqual tracking add`, and a restore would
  only throw entries away.

## methodology 1.4.1

### Fixed

- **A Codex revert acts only on a value still as `triqual sync` wrote it.** `triqual sync --harness codex` now records
  the value it wrote for each `config.toml` key it changed (`project_doc_fallback_filenames`, `[agents] max_depth`, and
  the `enabled` key of a superseded plugin). `triqual sync --remove-harness codex` puts a key back only while it still
  holds that value; one you changed since is left as you set it and named in the step's detail. A record made before
  this release has no recorded value, and the revert uses the one value sync always wrote for that key.
- **A missing `triqual` is an actionable Error.** `task-open`, `task-prep` and `task-close` need `triqual` whether or
  not the repo is opted in (`triqual tasks`, `triqual role-eval record`). With none on the `PATH` the first script exits
  1 with an `Error:` line that says so and how to install it, and `executing-plans` treats that as a stop instead of
  "not opted in".
- **The landing close names up to 200 dropped untracked files.** When `task-close` removes a worktree it drops its
  untracked files (an install's output, say) and names them on stderr; it named 5 and now names up to 200, then
  `, and N more`.
- **The permanent exit-3 landing refusals point to the abandon recipe.** The two refusals that no rerun clears (the
  landed commit is not on the phase branch, and a landing that is neither tested nor the phase tip) now end with the
  steps to abandon the landing, from the Refusals section of `executing-plans`.
- **Review fixes to parallel tasks.** An undone landing stays undone: `task-close` refuses the task (exit 3) until the
  sequential re-run has a `Prep:` line, and a rerun finishes an undo that died between its reset and its ledger lines. A
  `--head` that is behind the tip of the task's branch is refused, since the close removes the branch. A reopened task
  squashes from the parent of the commit its previous close made, so it no longer folds in the tasks that closed since
  it opened. A worktree task that made no commit closes at the tip of the phase branch. `task-prep` takes the tip of
  the task's worktree branch as its head when there is one, never `HEAD` of the main checkout. `task-open` refuses a
  `blocked` task (only the owner's `triqual tasks start` restarts it), and a coordinator task while an earlier task of
  its phase is not done or dropped.

### Docs

- The skills references follow the phase orchestrator: `claude-code-tools.md`, `codex-tools.md` and
  `diagnosing-methodology`. The stop ordinals in `executing-plans` are fixed. `writing-plans` gains guidance for
  writing tasks that can run in parallel. The implementer prompt no longer mentions
  staging in committed tracking mode, which `executing-plans` refuses.
- The READMEs of methodology, roles, workflow-gate and memory-report are brought in line with the code: the task scripts
  and `triqual cost`, the `doctor` checks and the Codex depth step of `sync`, and the files and variables of parallel
  tasks.

## roles 0.4.1

### Fixed

- `hunter` names the per-task and per-phase candidates files (`task-<N>-candidates-<category>.md`,
  `phase-<N>-candidates-<category>.md`) in place of the retired final-candidates file.

## progress-tracking 0.5.3

### Fixed

- The skill and its store-mode reference now say that a store left by a newer plugin version warns and asks for a plugin
  update, not a restore from a backup.
- Every refusal of `tracking relocate` is listed in full.
- `tasks init` in store mode needs `tracking write plan` first, which creates the ledger; the reference says so.
- The wording of `tasks check` matches what it compares.

## methodology 1.4.0

### Added

- **Parallel tasks.** `executing-plans` gains a Parallel tasks section, and the orchestrator prompt a Parallel Tasks
  section, so independent tasks of one phase are built at the same time. A task is independent when every task it
  depends on is complete and its plan `**Files:**` paths share no path with any earlier task of the phase that is not
  yet closed (running or not yet started), so an earlier overlapping task always starts first and a task that fails the
  check runs sequentially; a later task running while an earlier overlapping one had not started would deadlock against
  the landing order. At most 3 implementers at once, and batched light tasks never run in
  parallel. An earlier task is never blocked by a later one: a task of a batch starts only when every earlier task of the
  phase is closed, so a light task cannot start first and wait to land while the earlier task cannot start. The "Never
  dispatch two implementers in parallel" rule is gone.
- **Where a task runs.** A task uses the main checkout only when every earlier task of the phase is done or dropped;
  every other task is opened with `task-open --worktree`, built in `.claude/worktrees/<plan stem>-t<N>` (branch
  `wt/<plan stem>-t<N>`), and reviewed with `task-prep --head <sha>`. A task with no node `Test:` path never runs in a
  worktree: `task-open --worktree` refuses a missing, non-`.mjs`/`.js`/`.cjs`, glob or out-of-repo `Test:` path.
  The BASE of a worktree task is the last closed commit of the phase branch: when a task built in the main checkout has
  commits no close has squashed yet, the worktree task is based at that task's BASE, not on those unreviewed commits.
- **Landing comes first, in plan order.** `task-close` for a worktree task is called only after every earlier task has
  landed (called early it exits 3 with no `Error:` line: a wait). It folds the task onto the phase tip as one commit,
  runs the plan's `Test:` files with `node --test` (cut off after `TRIQUAL_LANDING_TEST_TIMEOUT_MS`, default 600000
  milliseconds), then moves the task to `done` with the landed sha and removes the worktree.
- **A landing conflict is undone, not patched.** A merge conflict or a failing `Test:` file resets the phase branch to
  the previous tip, writes `BASE: T<N> <previous tip>` and `Task <N>: landing conflict — re-run sequential`, moves the
  task back with `rework`, and the task runs again sequentially in the main checkout; the undone attempt's reviewer
  outputs are never counted.
- **Phase close removes leftover `<plan stem>-t*` worktrees**, each removal logged as `Worktree removed: <path> —
  left behind at the close of P<n>`.
- The ledger vocabulary gains `Landed: T<N> <sha>`, `Tested: T<N> <sha>`, `Prep: T<N> r<R> <landed sha>`, the undo pair
  and the `Worktree removed:` line; a rerun of `task-close` is a resume past `Landed:` and `Tested:` lines and the
  landing's `Prep:` line. Every exit-3 refusal of `task-close` writes an `Error:` line except the earlier-task wait and a refusal from a linked worktree.
  The scripts behind this (`task-open --worktree`, the landing and its undo in `task-close`, and `task-prep` counting
  only the `Prep:` lines after a task's last `BASE:` line) ship in this release.

## methodology 1.3.0

### Changed

- **A per-phase orchestrator runs the task loop.** `executing-plans` now dispatches one `roles:phase-orchestrator` per
  phase ([orchestrator-prompt.md](plugins/methodology/skills/executing-plans/orchestrator-prompt.md)) and the main
  session only decides: it runs `stack.mjs phase`, waits for the orchestrator once, reads its summary (at most 20
  lines: `Phase:`, `Tasks:`, `BLOCKED:`, `Rulings I made:`, `Open minors:`, `Errors and fallbacks:`), writes
  `Orchestrator: P<n> — <summary first line>` to the ledger, and runs the Phase check, the phase review, `done`,
  `submit` and the break as before. It never reads code, diffs or reports; a Phase check failure's reopen and a
  phase-review fix go to an orchestrator or a fixer. There is one set of rules: the orchestrator follows the skill.
- **Stops are decided by the main session.** On any of the seven stops the orchestrator starts nothing new, lets
  running agents finish their current step, writes `Task <N>: awaiting landing` for a finished but unlanded task and
  returns `BLOCKED: <stop> — <details>`. The main session asks, writes `Task <N>: Ruling: …` and the ledger move the
  decision implies (`triqual tasks start T<N> --plan <plan>` for a blocked task), then dispatches a new orchestrator for
  the same phase, which resumes from the ledger. A final message that begins with `BLOCKED` instead of `Phase:` is a
  denial and is relayed verbatim.
- **Announced fallback.** When the orchestrator cannot be dispatched (role missing) or cannot dispatch (`BLOCKED:
  nested dispatch unavailable`), the main session writes `Error: orchestrator P<n> — exit 1 — <first line of the
  error>`, says so, and runs the phase loop itself with the same scripts. A workflow-gate cap denial is neither a stop
  nor a fallback: wait the seconds it names and retry.
- **The wait rule holds at both levels** (bounded stretches, never short polling, reconcile live children; `wait_agent`
  in Codex), and a rate-limited orchestrator returns `BLOCKED: rate limit` after about 6 stretches.
- **Routing of a blocked summary.** A stop (or a script error the steps cannot resolve) goes to the owner; the three
  `BLOCKED:` kinds that are not stops (`nested dispatch unavailable`, `rate limit`, `coordinator task`) go to the
  fallback, the end of the run and the coordinator handoff, with no question and no ruling. A human decision is ledgered
  as `Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`, and a task with a `complete` line is
  not dispatched again unless the resume note reopens it (a Phase check failure's reopen).
- **A rerun of `task-close` after a BLOCKED round trip resumes.** The `Orchestrator:` line, the task's `Task <N>:
  Ruling:`, `awaiting landing` and `minor (deferred)` lines and every line that names no `T<N>` no longer make it a
  reopen; `Prep:`, `BASE:`, `Task <N>: fix round` and the new `Task <N>: reopened — Phase check failed — <command>`
  still do. The main session runs a Phase check failure's reopen and writes that line; the orchestrator runs the fix
  loop. `triqual doctor` says `unset` for an `[agents]` table defined by a dotted or inline key without `max_depth`.
- **Coordinator tasks stay with the main session.** The orchestrator never edits product code (its role disallows
  `Edit` and `NotebookEdit`), so it runs a coordinator task only when the task edits no file; one that does is handed
  over with `BLOCKED: coordinator task T<N> — edits files, run it in the main session`, and the main session runs it
  and dispatches a new orchestrator for the rest of the phase. The `phase-orchestrator` role file now agrees with the
  skill: the Phase check and the phase review stay with the main session. A summary over 20 lines keeps its first
  lines and `+<k> more in the ledger`.
- **A phase submitted before 1.1.0** gets rounds 1 and 2 and the fix rounds of the phase review, without `done`,
  `submit` or the break, and the top phase's Phase check after each fix round.
- The ledger vocabulary gains `Task <N>: awaiting landing` and `Orchestrator: P<n> — <summary first line>`, and Finish
  lists the orchestrators' errors and fallbacks beside "Rulings I made". The role `roles:phase-orchestrator` needs
  roles 0.4.0.
- **`triqual sync` raises Codex `[agents] max_depth` to 2.** An orchestrator at depth 1 spawns its task agents at depth
  2, so `sync --harness codex` sets `[agents] max_depth = 2` when it is unset or a number below 2, and never lowers or
  touches a value of 2 or more. The change is recorded so `--remove-harness codex` can undo it. A value sync cannot
  edit (a dotted or inline key, or one that is not a number) fails the step with a message to set it by hand.
  `triqual doctor` fails on a Codex `max_depth` below 2.
- **`triqual cost` reports orchestrator spend on its own line.** The report has three groups, the main sessions
  (`controller`), the phase orchestrators (`orchestrators`, read from the subagent transcripts' `agentType`) and the
  other subagents. `--json` gains an `orchestrators` object beside `controller` and `subagents`.

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
