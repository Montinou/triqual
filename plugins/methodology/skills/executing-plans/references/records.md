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

**The phase review** records `hunters` and `final-escapes` with `task: "P<n>"` (the seams review records only `final-escapes`, with `task: "final"`), with the phase review's budget (reference 4 before 2026-10-29, 3 after, when the phase review dropped its `state` hunter). The phase's fix commit lands with its own progress entry, Stage/task `Plan <name> · P<n> fix`. An escape counts only a finding no earlier review recorded: a deferred Minor confirmed again is not an escape. Phase-review escape counts will rise by design: they now hold what per-task hunters used to catch.

```json
{ "v": 1, "at": "2026-10-20T16:20:11Z", "provider": "claude", "task": "P1", "kind": "hunters",
  "hunters": [
    { "category": "correctness", "model": "claude-haiku-5-5", "failed": false, "candidates": 2,
      "confirmed": { "critical": 0, "important": 1, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "security", "model": "claude-haiku-5-5", "failed": false, "candidates": 0,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 0, "duplicateCandidate": 0, "duplicateReview": 0 },
    { "category": "spec-drift", "model": "claude-haiku-5-5", "failed": false, "candidates": 1,
      "confirmed": { "critical": 0, "important": 0, "minor": 0 }, "refuted": 1, "duplicateCandidate": 0, "duplicateReview": 0 }
  ],
  "budget": { "reference": 3, "used": 3, "overrun": false } }
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
