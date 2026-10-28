## Ledger vocabulary

The workspace ledger, `sdd-ledger.md`, is append-only, one line per event, in these forms:

- `# SDD ledger — plan: <plan file path>` (first line)
- `Authorization: push phase branches and draft PRs — handoff <date>` / `— setup <date>`, or `Authorization: declined — stack in local mode`
- `Fence: <version>` / `Fence: none` (appended again whenever detection is rerun; the last `Fence:` line counts)
- `Skills: T<N> printed for the human — <slugs>`
- `Denied by policy: <call> — <path>`
- `BASE: T<N> <sha>` (written by `task-open`; the last such line for a task is its BASE)
- `Prep: T<N> r<R> <head sha>` (written by `task-prep`: review round `<R>` of the task, prepared at that head)
- `Landed: T<N> <sha>` (written by `task-close` for a worktree task: the phase branch now holds the task's one landed commit; it stands until a later `BASE: T<N>` line undoes it)
- `Prep: T<N> r<R> <landed sha>` (written by `task-close` right after `Landed:` and only when the attempt has a `Prep:` line, `<R>` the round of the attempt's last `Prep:` line; the head check of a rerun, not a review and not a reopen)
- `Tested: T<N> <sha>` (written by `task-close` once the plan's `Test:` files passed at the landed sha; a rerun without it runs them again)
- `BASE: T<N> <previous tip>` followed by `Task <N>: landing conflict — re-run sequential` (written together, in one write, by the undo of a landing in `task-close`; the file `<workspace>/task-<N>-undone` beside them dates the undone attempt, and the sequential re-run's ledger starts after the undo line)
- `Worktree removed: <path> — left behind at the close of P<n>` (written by the main session at phase close, one per leftover worktree removed; `<path>` absolute)
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
- `Task <N>: reopened — Phase check failed — <command>` (written by the main session when it reopens the phase's last task after a real Phase check failure)
- `Task <N>: awaiting landing` (written by the orchestrator on a stop for a task that finished but is not landed)
- `Orchestrator: P<n> — <summary first line>` (written by the main session when an orchestrator returns)
- `Task <N>: blocked at fix round 5/5 — <open findings>`, then the human's decision: `Task <N>: Ruling: <finding> — <decision> — <why> — <what it costs if wrong>`, and for more rounds `Ruling: human granted <K> rounds for T<N> — <why> — <what it costs if wrong>`
- `Task <N>: parked — <finding> — Ruling: <why the code stands>`
- `Task <N>: complete (commits <base7>..<head7>, review clean)` / `(commits <base7>..<head7>, <K> parked)`
- `Phase <N>: submitted (<branch>, PR #<n> draft)` / `Phase <N>: complete (<branch>, local)` / `Phase <N>: ready (<branch>, PR #<n>)` (printed by `submit --open`, one line per phase; finishing-branch reads it)
- `Ruling: <what you decided> — <why> — <what it costs if wrong>`
- `Skipped: hunters — <cause>`
- `Skipped: hunters and safety gate — <cause>; safety checklist runs in the spec review`
- `RateLimit: <role> <time>`
- `Unrecorded: <record JSON>`
- `Error: <step> T<N> — exit <code> — <first stderr line>` (written by a script before it exits non-zero, except the earlier-task wait of `task-close` and a refusal from a linked worktree, both exit 3, which write none; `<step>` is `task-open`, `task-prep` or `task-close`); the main session writes `Error: orchestrator P<n> — exit 1 — <first line of the error>` itself when an orchestrator cannot be dispatched
