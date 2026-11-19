# Changelog

What changed in each plugin, newest first. The plugin version in each entry is the one the release sets in its
`plugin.json`; the plugins table in the [README](README.md) shows what the marketplace carries now.

## methodology 1.16.0 / roles 0.12.0 / progress-tracking 0.12.0

- methodology: `triqual eval cases <pluginDir> [--case <name>]... [--runs <n>]` runs named replay cases once each (three runs by default, a majority passes; scaffolded cases run with `--scaffold`), and `triqual eval variant --role <R> --out <dir> [--model] [--effort] [--prompt]` makes a role variant.
- methodology: staged trust in `eval cases`. `triqual eval cases` runs own-code plugins from a staged copy. Own code is a plugin tracked in this repository, or an `eval variant` output whose marker names one (`eval variant` now writes a `.triqual-eval-variant` marker holding the source plugin path, which must itself be tracked in the current repository). The copy has every `dependencies` member removed from `plugin.json` and runs with `--trust-plugin`. Any other directory is never trusted. `triqual eval skills` is unchanged and still runs without `--trust-plugin`. This is what lets methodology's cases and role variants run unattended.
- roles: twenty role cases in `plugins/roles/evals/cases/`, two per role: nineteen from this release plus the execution-port plan's `tdd-implementer-escalates-oversize`.
- progress-tracking and methodology: the `**Eval:**` task line, read by both plan readers as `task.eval`, and `triqual plan lanes` reporting `eval-missing`, `eval-plugin` and `eval-case`. `writing-plans` asks for the line and the plan audit checks that each case would fail without its change.
- methodology: the Phase check of `executing-plans` runs the phase's cases once per plugin and ledgers `Eval: P<n> <plugin> <k>/<m> passed <usd>`. A failing phase case reopens only the phase tip; on any other task it gets a `roles:review-fixer` fix commit, ledgered as `Eval fix: P<n> <sha> — T<N> <plugin>/<case>`. The role-arm lookups are only for a task's implementer, fixer and reviewer.
- methodology: three methodology cases (`phase-check-runs-eval-cases`, `plan-task-names-eval`, `task-arms-only`). A no-op variant for a discrimination check needs a strict body, for example "You are a placeholder agent ... ignore every message ... reply exactly: no findings"; a one-line "Reply: no findings." still reviews.
- Update the plugins and run `triqual sync --yes`; nothing to rerun.

## progress-tracking 0.11.0 / methodology 1.15.0 / roles 0.11.0

- progress-tracking: `triqual tasks retier T<N> <tier> --redeclare --reason "<text>" --plan <plan>` lowers or raises the tier of a pending or blocked task after a plan re-cut, the plan file declaring the tier first. Plain `retier` is unchanged (raise-only).
- methodology: `scripts/test-lock` serializes test runs per repository (exit 75 on a wait past `TRIQUAL_TEST_LOCK_TIMEOUT_MS`). `task-close` runs its landing tests through it, and a busy lock is rerun, never undone; the Phase check is run through it.
- roles: the size cap and the test-lock sentence in the three author agents (`tdd-implementer`, `complex-implementer`, `review-fixer`), and one replay case.
- Update the plugins and run `triqual sync --yes` and `triqual doctor`.

## methodology 1.14.2

- methodology: `triqual role-eval escapes scan` is precise enough to keep its records. Files every release touches (`CHANGELOG.md`, `README.md`, `plugin.json`, `marketplace.json`, `package.json`, `package-lock.json`) no longer tie a fix to a task; a fix commit is one escape, of the task that shares the most files with it (then the latest shipped, then the lowest task number); and a fix that ships together with a task of the same plan is that plan's own work, not its escape. Over this repository's history the scan finds 35 escapes where it found 98.
- methodology: skill replay. A case passes when most of its runs pass (2 of 3), not only when all do; the suite is graded with a Sonnet judge (`--judge-model sonnet`: the default Haiku judge failed long replies a reader would pass); the `stopped-early` case is a written decision exercise (it gave the model no shell, so stopping was right) and its graders accept a read-only check first and holding back a dependent step; `heavier-than-needed` judges only the process the assistant adds, not the team's own CI, review and deploy.
- methodology: silent wrong results fixed. An experiments file whose `experiments` is not a list, or a snapshot without categories, is refused instead of read as empty (which read every session as healthy); `triqual eval launch` assigns no arm when you pass your own `--settings`, and says so, and says when an assignment fails; `start` and `stop` re-check the experiment inside the lock; an empty arm or model is refused; a failing snapshot check exits 1 with one line; the hook tests no longer reach the real home's evals directory.
- Update the plugin. A skill experiment started on 1.14.1 or earlier scored cases with the old rule: stop it and start a new one.

## methodology 1.14.1

- methodology: `triqual eval experiments start` refuses an experiment that its records could never use: an `id` or an arm name outside lowercase letters, digits and `-`, and, for a role experiment, an arm whose `role` is not a bare role name (`planner`, not `roles:planner`) or that has no `model` or no `effort` (`low`, `medium`, `high`, `xhigh` or `max`). Before, such an experiment started and every record for it was refused, so it never got rows (or `triqual eval arm` printed `null null`). An experiments file that holds one is refused by every `triqual eval` command that reads it; fix the id, the arm names, the role, the model and the effort.
- methodology: `triqual eval report` gives a role experiment that was started and then paused its rows, as it does a session experiment; only one that was never started has none.
- methodology: the audit's `eval_sessions` dataset lists only the sessions of the `--project` (by project directory name), as the other datasets do, not every project on the machine; the collector's header no longer calls it read-only (it refreshes the sessions store).
- methodology: the phase review asks for a finding's task as `T<N>`, the form the `final-escapes` record takes; `finishing-branch` runs the `Test:` files of a stacked phase that has no `**Phase check:**` line; `writing-plans` says the planner dispatch's description is `planner <plan file name>` with its `.md`, which is how the planner's cost is found.
- Update the plugin; nothing to rerun.

## methodology 1.14.0 / roles 0.10.0 / workflow-gate 0.4.1

- methodology: experiments. An experiments file (`~/.config/triqual/experiments.json`, or `TRIQUAL_EXPERIMENTS_FILE`) names the arms of a session, role or skill experiment; `triqual eval experiments [start <id> | stop <id>]` lists and starts them, `triqual eval launch` starts `claude` and assigns a new interactive session its arm (install the `claude` alias with `triqual eval launch --install`), and `triqual eval report [--experiment <id>] [--json]` prints a row per arm: units counted, healthy rate with its Wilson interval, cost median, the difference with the control and the non-inferiority verdict.
- methodology: the audit dashboard gains the datasets `eval_report` (the report's rows), `eval_sessions` and `cost_per_task` (the USD of the subagents of each task).
- methodology and roles: the new `roles:planner` agent (roles lists ten) writes the plan draft, and `writing-plans` dispatches it; `triqual eval arm --kind role --role <R>` says which arm of a role experiment a unit of work belongs to, and `triqual eval plan-review` records one planner outcome per plan (the plan's parallelism, the plan review's finding counts, the planner's cost). The role-eval store gains the `plan-review` kind, optional `arms` on a `task-review` and optional `category` and `summary` on a `final-escapes` entry. workflow-gate's role map gains `planner` (Opus), so an Agent start of `roles:planner` counts against the Opus cap.
- methodology: escapes are found, not only reported: `triqual role-eval escapes scan [--since YYYY-MM-DD]` reads git (a `fix` commit within 14 days of a closed task that touches its files, a revert) and CI (a failing default-branch run, through `gh`) and appends each post-merge escape once. Run it once after updating. `executing-plans` records escape categories, stamps each record with its plan and records the role arm a task ran under.
- methodology: skill replay. `triqual eval skills --experiment <id> [--paid]` runs the skill suite (`claude plugin eval`) of each arm of a skill experiment through the credential chain and writes `skill-runs/<id>/<arm>.json`; the first cases are in `evals/cases/`. `triqual eval report` turns the two suite runs of a skill experiment into one row per arm (a case is a unit: passed is healthy, its cost is the USD of its runs), with the same verdicts as a session experiment.
- methodology: local verification runs the tests of the change, never the whole suite: the Phase checks run the `Test:` files of a phase's tasks, the branch finish runs the tests of the change (the changed test files and the tests of the changed modules), and the whole suite is CI's, on push.
- Update the plugins and run `triqual sync --yes` and `triqual doctor`; the experiments need an experiments file to do anything, and a run in progress finishes on the version it started with.

## progress-tracking 0.10.0 / methodology 1.13.0 / roles 0.9.0

- progress-tracking: new `triqual plan lanes <plan.md> [--json]` checks a plan's layout: for each phase its `**Parent:**`, its `**Lane:**` lines and its dependencies are compared with what the phase needs, and it prints each phase's critical path and parallelism, then the plan's, then one line per violation with its fix (`no-parent`, `false-parent`, `missing-parent`, `no-lanes`, `lane-files`, `lane-depends`, `several-tops`). Exit 0 clean, 1 any violation, 2 a bad argument or a file that is not a plan. The plan parser reads `parents` (a join has several), `lane` and `sequentialBecause` (the `**Sequential because:**` line), and `triqual plan check-collisions` treats a join as a descendant of each parent; its `--diff` reads a join from the join commit. Update the plugin; nothing to rerun.
- methodology: plans are laid out to run in parallel. `writing-plans` gains a Parallel layout section (lanes, frontier parents, joins, a closing task) and `brainstorming` slices carry `**Depends on:**`. A worktree task of `executing-plans` lands on the phase branch as soon as its review is clean, with no wait for an earlier task; a task built in the main checkout runs alone; the orchestrator runs a batch per lane; the ledger records `Serial: <reason>` for a task or phase that did not run beside another. `task-open` and `task-close` write `Opened:` and `Closed:` time lines (`TRIQUAL_NOW` sets the time, for tests), and the new `scripts/timeline.mjs PLAN_FILE` prints a run's wall-clock, task time, achieved parallelism and planned parallelism, with a row for each phase and the phases at once. Phases whose parents are submitted run at the same time: `stack.mjs` keeps `startedAt` and `doneAt`, `base`, `workdir` and `parents` for each phase under a state lock, `squash --phase N` folds one phase, a phase started while another holds the main checkout gets its own phase worktree (`workdir:`), a join starts at one commit that merges every parent, `status` prints `ready` and `base`, `phase-resume` names the ready phases, and the task scripts read and land in their own phase's checkout, an undone landing that has not restarted no longer blocks the main checkout, `task-open` writes `Rerun: T<N>` when the sequential re-run starts and refuses `T<n> cannot open in a worktree while T<m> is undone and waits for its sequential re-run`. The main session starts every ready phase at once and dispatches one orchestrator for each; the procedure is in `references/concurrent-phases.md`. Update the plugin and run `triqual sync --yes` and `triqual doctor`; a run in progress finishes on the version it started with.
- roles: the `phase-orchestrator` runs beside other orchestrators, one for each running phase, in its phase's checkout. Update the plugin and run `triqual sync --yes` so `~/.claude/CLAUDE.md` carries the changed rules; a run in progress finishes on the version it started with.

## methodology 1.12.2

- methodology: the SessionStart `evals:` lines (judges below the bar, failed steps) are now given only to a session whose working directory is inside a checkout of this repository (a directory holding `plugins/methodology/evals/judges`, not under `~/.claude/plugins` or `~/.codex`). Before, every session on the machine got them, in every project and harness, and sessions elsewhere ran the improving-evals round in the plugin marketplace clone and collided with the session that had the round. The hook reads the session's `cwd` from its stdin payload (the Codex and Grok bridge passes it through). The `methodology:improving-evals` skill now says to run only in a checkout of this repository and to stop when another session already has the round (its `evals/<report name>` branch exists or an `eval.mjs judge` process for the round is running). Update the plugin; nothing to rerun.

## methodology 1.12.1

- methodology: a session with nothing to judge no longer fails the round. A sample session whose transcript holds no user or assistant text is skipped by `triqual eval review propose`, `triqual eval judge` and `triqual eval referee`: no model call, not an error, not left. The last line of each gains `; empty <k>`, the round's report gains `empty`, and a round whose only problem is such sessions exits 0. `triqual eval review sample --more` no longer draws them.
- methodology: the redacted render of each review-sample session is kept in `review/renders/<sessionId>.txt` in the evals directory (mode 0600), by a new `keep renders` step of `triqual eval improve` (report key `kept`), so a labeled session can still be judged after the host deletes its transcript. Sessions of `judgeExclude` projects are never kept (a kept render of a session that became excluded is deleted), and a session whose transcript changed within the last hour is neither drawn nor kept until a later round, so a running session is not frozen at a partial text. The draw's window is by last activity: `review sample --more --since` compares a session's last activity, each added row records the draw's time as `at`, and a round draws sessions active after the previous draw's time minus one hour, so a session that was still running waits one round and is not lost. Update the plugin; nothing to rerun.

## methodology 1.12.0

- methodology: new `triqual eval improve [--more <k>] [--paid]` runs one unattended round over the review sample: it refreshes the sessions store, draws `k` (default 30) newer random sessions, proposes labels, runs the code checks and the judges, settles disagreements with a referee, scores and validates every evaluator, computes the failure rates, and writes the round's report to `rounds/<YYYY-MM-DDTHHMMSSZ>.json` in the evals directory. It exits 3 when a step after the first failed; the report names each failed step in `failed`.
- methodology: the steps are commands of their own. `triqual eval review propose [--accept] [--paid]` has a model propose each sampled session's label and failure categories (`review/reference.jsonl`); `triqual eval referee [--category <id>] [--paid]` rules on each case where a judge contradicts a label (`rulings.jsonl`) and applies the rulings to `label-categories.jsonl`; `triqual eval check [--category <id>]` records a verdict for each code check; `triqual eval score [--category <id> [--against <version>]]` prints each evaluator's confusion counts per split and compares its dev score with the version it replaced, or with exactly the version `--against` names (`scores.jsonl`); `triqual eval rates` prints each failure's rate by month and by methodology version. `triqual eval review sample --more <k> [--since <date>]` adds sessions to an existing sample, and sessions record the methodology version.
- methodology: a credential entry of `eval-auth.json` marked `"paid": true` is used only with `--paid`; a chain made only of such entries says so and calls no model.
- methodology: new skill `methodology:improving-evals` (twelve skills now). It runs one round, rewrites each judge prompt the round flags from the train split's notes, keeps a rewrite only when the dev score is strictly better, records each attempt in `revisions.jsonl`, and ships what it kept. The SessionStart hook adds a line when the newest round has a judge below the bar that no attempt names, and one when it had failed steps.
- Update the plugin; nothing to rerun. The weekly schedule is optional: see "Evals improve loop" in the plugin README.

## methodology 1.11.0

- methodology: new `triqual eval judge --category <id> --sessions <file>` runs one session judge over the listed sessions. The judge prompts are `evals/judges/<id>.md` (front matter `model: <full model id>`, one failure each); the model call goes through `claude -p` with the credential chain of the owner's `eval-auth.json`, the transcript rendered for the judge passes through `redactSecrets`, and a usage limit writes no verdict.
- methodology: new `triqual eval validate --category <id> [--split dev|test]` measures a judge against the owner's labels (TPR and TNR with Wilson 90% intervals) and writes `validation.json`; a judge is usable with at least 15 positives and 15 negatives and both lower bounds at 0.7 or more. A prompt that names a dev or test session is refused.
- methodology: the failure taxonomy is the owner's file `taxonomy.json` in the evals data directory (`~/.local/share/triqual/evals/`, or `TRIQUAL_EVALS_DIR`), no longer a file of the repository. The repository ships a judge prompt for each of its `judge` categories (`broke-standing-instruction`, `unverified-claim`, `unchecked-premise`, `heavier-than-needed`, `stopped-early`, `harmful-side-effect`) with invented examples, and the code check `owner-chased-progress` (`cli/lib/eval-checks.mjs`).
- Update the plugin; nothing to rerun. A judge is trusted only after `triqual eval validate` reports it usable.

## methodology 1.10.0

- methodology: new `triqual eval` command, the start of the evals and A/B work. `triqual eval` dispatches to `cli/eval-<name>.mjs` and lists each with its summary, so a later subcommand needs no edit to the dispatcher. The shim lists `eval` (its `--help` is forwarded from methodology 1.10.0).
- methodology: `triqual eval sessions [--since] [--until] [--project] [--json]` reads the main Claude Code transcripts, keeps one line of signals per session (cost, context size, compactions, idle cache rewrites, stop-hook blocks, tool errors, user messages) in `sessions.jsonl`, and lists them. It never prints message content.
- methodology: `triqual eval review sample [--n 100] [--seed <int>] [--force]` draws a stratified sample of interactive sessions (half random, a quarter by cost, the rest outliers) and `triqual eval review serve [--port <n>]` serves it on a loopback-only page (`127.0.0.1`) where each session is labeled good or bad. The page is reachable only from this machine: the server binds to `127.0.0.1`, checks the `Host` and `Origin` headers, and requires a per-run token, embedded in the page it serves, on every label POST; the printed URL is plain.
- The data lives under `~/.local/share/triqual/evals/` (or `TRIQUAL_EVALS_DIR`): directories 0700, files 0600. Update the plugin and rerun `/methodology:setup` (or `node bin/bootstrap.mjs` from a clone) so the shim lists `eval`.

## methodology 1.9.3 / roles 0.8.1

- methodology: hunters are no longer dispatched. The phase review of `executing-plans` (step 8) sends none: `roles:final-adversarial-reviewer` runs with no candidates (`[CANDIDATES_PATHS]` is always "none"), the ledger line stays `Round 1: P<n> — hunters 0/0`, and a phase writes only its `final-escapes` record. `reviewing-code` drops its two hunters, so a review is one `roles:spec-reviewer`. The 2026-11-12 performance audit showed the hunters yield too little for their cost.
- methodology: the global rules mark `roles:hunter` as dispatched by none since 2026-11-12. `hunter-prompt.md`, the `roles:hunter` agent and the `hunters` record kind stay for A/B tests; the role-eval store and its readers are unchanged.
- roles: the README says the hunter is no longer dispatched.
- Update the plugins and run `triqual sync --yes` so `~/.claude/CLAUDE.md` carries the changed roles table.

## methodology 1.9.2

- methodology: `cli/lib/prices.json` adds Claude Fable 5.2 ($8 / $40 per MTok, cache read $0.20) and corrects the Claude Sonnet 5.5 cache read to $0.10 (was $0.20), at the list of 2026-11-03. `triqual cost` had dropped every Fable 5.2 message from its totals and counted Sonnet 5.5 cache reads at twice their price.
- methodology: the `auditing-performance` collector keeps roles under $0.50 as one `other` row per window, so its totals equal `triqual cost`, and writes an `escapes` dataset (final-review escapes per task, by window, tier and severity). The skill checks the price table against the transcripts' models and describes the machine-wide run (`--project -`).

## workflow-gate 0.4.0 / methodology 1.9.1

- workflow-gate: higher caps per model, for Workflow scripts and for Agent/Task starts in the 120 s window: Fable 4 (was 3), Opus 10 (was 8), Sonnet 15 (was 12); Haiku stays unlimited. The `WORKFLOW_MAX_*` overrides are unchanged.
- methodology: the global rules state the new caps.
- Update the plugins and run `triqual sync --yes` so `~/.claude/CLAUDE.md` carries the new caps.

## progress-tracking 0.9.1 / methodology 1.9.0

- methodology: looser review tiers. `tier-check` raises to heavy only for a sensitive path or more than 1000 code lines (was 300 changed lines), and from light to standard only for prompt-like Markdown or more than 300 code lines (was 100). Code lines leave out tests, Markdown, lockfiles, data files (`.json`, `.jsonl`, `.ndjson`, `.csv`, `.tsv`, `.txt`) and media. A new file, a lockfile or a binary change no longer raises by itself, and a fix round follows the same rules as a first build. Evals, fixtures and datasets (`**/evals/**`, `**/*.eval.*`, `**/fixtures/**`, `**/datasets/**`) are default test paths, so an eval task stays light. `writing-plans` tiers by what a task touches, not its size.
- progress-tracking: the heavy-tier warning at plan registration fires above 50% heavy (was 80%).
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session.

## progress-tracking 0.9.0 / methodology 1.8.0 / roles 0.8.0

- progress-tracking: `triqual plan generate` and `triqual plan check-collisions` (with `--diff`, which lists the old path of a renamed file); `write plan --all` registers every plan of a directory in one call and refuses an already registered plan up front; the plan reader reads each task's `Create`, `Modify` and `Test` files, the `Parent` and `Validate` phase fields, the `Landing test` header and `Depends on: none`; `tracking add` records external commits; tracking resolves from `TRIQUAL_TRACKING_ROOT`.
- methodology: `executing-plans` supports initiatives (forest plans). Phases start and squash from their parent, `submit` opens forest phases as plain draft PRs (also on `github.com-*` SSH aliases), `stack status` prints the tree, a `validate` script records CI verdicts per phase, `phase-resume` writes a resume brief, and a plan's `Landing test` command lands parallel tasks. `writing-plans` documents the `Parent`, `Validate` and `Landing test` fields and a simplicity check.
- roles: the auditors and brainstorming look for the simplest design.
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session. Codex reads the same skills through its `~/.codex/skills` links, so it follows the update.

## progress-tracking 0.8.0 / methodology 1.7.0 / roles 0.7.0

- progress-tracking: `triqual tasks reconcile [--plan <plan.md|ledger>] [--apply] [--json]` proposes the state of every non-done task from git evidence (the commits that touch a task's `Create:`, `Modify:` and `Test:` files and match its planned commit line) and, in store mode, from the task's progress entries. It is for a ledger that is out of step with its commits, such as after a migration. Without `--apply` it opens the store read-only, takes no lock and writes nothing; with `--apply` it writes only the high-confidence proposals, through the ordinary `start` and `done` transitions. The classifier is `lib/reconcile-evidence.mjs`; the docs say how to reconcile after a migration.
- roles: the `hunter` is evidence-bound. A candidate carries the concrete trigger input or state, the traced path to the wrong result and the expected result against the actual one; a candidate whose trigger cannot be named is not reported, and a hunter reports at most 3 candidates, the strongest first (it aimed for about 5 before). A `correctness` hunter given a `Scope:` line covers everything the line names (correctness, state and spec drift) in its one candidates file.
- methodology: the phase review sends one or two hunters instead of 3. A `correctness` hunter always, which absorbs spec-drift and state, and a `security` hunter only when the phase range touches a sensitive path (`tier-check`'s default sensitive paths plus the plan's `**Sensitive paths:**`). The reference is 2 per phase (3 before this release, 4 before 2026-10-29), 1 sent when the phase touches no sensitive path; the closing hunter total in `executing-plans` follows. The phase reviewer checks every candidate by running or tracing its trigger. Task-level reviews still send no hunters.
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session.

## roles 0.6.0 / methodology 1.6.0

- roles: verification is focused. `tdd-implementer`, `complex-implementer` and `review-fixer` run the task's `Test:` paths plus the tests of the modules that import what changed, with typecheck and lint scoped to the touched files, and never the full suite (CI runs it). `safety-reviewer` accepts that focused evidence and never flags a missing full-suite run.
- methodology: a task's review is light, and the heavy review happens at the phase end. A light task gets the safety gate alone, a standard or heavy task gets the gate and `roles:spec-reviewer` in one round (`heavy` still picks the role and is still raised by `tier-check`, but its per-task review is capped at standard), and no task sends hunters: the 3 hunters run only at the phase review. The default phase check, when a phase declares none, is the union of its tasks' `Test:` paths run focused.
- methodology: `writing-plans` plans every phase in parallel lanes first. A task carries a `**Lane:**` letter, lanes have disjoint `Files` and no `Depends on` across lanes, and a closing task depends on every lane and runs the phase check. A phase that is not laned writes `**Sequential because:**` with a real reason; the plan review checks both.
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session.

## progress-tracking 0.7.2

- The plan reader reads the optional `**Test paths:**` header line; lines in those paths never count toward the 300-line heavy limit or the light allowance. This is the same change as methodology 1.5.0's copy of the reader, and the copies test pins the two byte-identical. No other behavior changes.
- Update with `triqual sync --yes`, then `/reload-plugins`.

## roles 0.5.0 / methodology 1.5.1 / workflow-gate 0.3.3

- roles: `spec-reviewer` now runs on Opus (it was Sonnet), effort medium unchanged. Evidence: a replay of 8 tasks gave Opus recall 0.67 and precision 0.65 against Sonnet recall 0.26 and precision 0.64, at about twice the spec-review spend per task at list prices. The Codex routing for `spec-reviewer` is unchanged (already Terra at high effort).
- methodology: a phase review sends 3 hunters (correctness, security, spec-drift) and drops `state` from phase reviews; the task-level hunters are unchanged. The phase reference budget is 3 (it was 4 before 2026-10-29). The global rules' role table follows the new `spec-reviewer` model.
- workflow-gate: `ROLE_MODELS` counts `roles:spec-reviewer` as an Opus agent against the per-model caps.
- Not changed, because the calibration found no data or no gain: `hunter` (Haiku, medium), the `final-adversarial-reviewer` effort (low), the `tdd-implementer` effort (high), `review-fixer` (no turn or time budget, no `BLOCKED: budget`), `safety-reviewer` and `complex-implementer`, and the reviewer model per tier otherwise. The role-eval code and records are untouched.
- Update the plugins and run `triqual sync --yes`, then reload plugins or start a new session.

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
