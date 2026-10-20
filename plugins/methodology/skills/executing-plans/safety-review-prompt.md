# Safety Review Prompt Template

Use this template to dispatch the task's safety reviewer, the gate
(`roles:safety-reviewer`), in round 1 of every task's review, at every tier.
For a heavy task it runs together with the hunters
([hunter-prompt.md](hunter-prompt.md)) on the same review package, and the
spec reviewer ([task-reviewer-prompt.md](task-reviewer-prompt.md),
`roles:spec-reviewer`) runs in round 2. For a standard task it runs in parallel
with the spec reviewer, with no hunters. For a light task the gate is the whole
review, unless it reports a finding or a `Cannot verify` item: then the spec
reviewer runs on that item. The safety reviewer runs a fixed checklist on the
diff and judges no design. Pass no model: the role's definition pins it.

**Purpose:** Catch the rule-based defects of one task's diff (commit format,
secrets, forbidden paths, file placement, missing verification evidence,
canary rules) cheaply, so the spec review can spend its attention on judgment.

```
Subagent (roles:safety-reviewer):
  description: "Safety review Task N"
  prompt: |
    You are running the safety checklist on one task's implementation. This
    is a task-scoped gate: a spec reviewer may judge requirements and design
    in the next round, and a whole-branch review happens after all tasks are
    complete.

    Task tier: [TIER]

    ## What Was Requested

    Read the task brief: [BRIEF_FILE]

    Global constraints and canary rules that bind this task:
    [GLOBAL_CONSTRAINTS]

    ## What the Implementer Claims

    Read the implementer's report: [REPORT_FILE]

    ## Diff Under Review

    **Base:** [BASE_SHA]
    **Head:** [HEAD_SHA]
    **Diff file:** [DIFF_FILE]

    Read the diff file once: it holds the commit list, a stat summary and
    the full diff with context. Do not re-run git commands. If the diff file
    is missing, fetch the diff yourself:
    `git log --format='%H%n%B' [BASE_SHA]..[HEAD_SHA]` and
    `git diff [BASE_SHA]..[HEAD_SHA]`.

    Your review is read-only on this checkout. Do not mutate the working
    tree, the index, HEAD, or branch state in any way.

    ## You Do Not Dispatch Subagents

    Do all of this review yourself. Never spawn a subagent to review part
    of the diff, and never spawn another reviewer for a second opinion.
    This process already provides every review seat the work gets; a
    reviewer you spawn duplicates one of them at full cost, and its
    verdict counts for nothing.

    ## Denied by Policy

    A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence's policy; when in doubt, stop.

    You ask the human through your final message: it replaces the output format below. Begin it with BLOCKED, then the denied call, its path and the reason verbatim, and review nothing further. The controller relays it.

    ## Do Not Trust the Report

    Treat the implementer's report as unverified claims. Check its
    verification evidence against what it says was run; a rationale in the
    report never turns a failed check into a pass.

    ## Checklist

    Answer each item pass or fail, with file:line evidence:

    1. **Commits:** subjects and trailers match the required format exactly.
    2. **Secrets:** no secret values, tokens, connection strings or private
       keys in the diff or in the report.
    3. **Paths:** no file outside the allowed directories was touched; no
       forbidden path from the global constraints appears.
    4. **Placement:** every created file sits where the brief's file list
       says; no unexpected files.
    5. **Evidence:** the report carries the verification commands and their
       output (typecheck, lint, tests), and, for a behavior change, the RED
       and GREEN test evidence; warnings in that output are findings.
    6. **Canaries:** each canary rule in the global constraints above.
    7. **Tracking files:** when the repo is opted in, `progress.md`, `status.md` and the plan's task ledger (`*.tasks.json`) are expected in every task diff: never flag them as unexpected files. In store mode (`"mode": "store"`) it is the other way round, because no tracking file is ever staged or committed: an added or modified root `progress.md` or `status.md`, or a plan-side `*.tasks.json`, is a finding; a deletion of one is not (the switch commit removes them, and a merge keeps them deleted), and neither is a file of the same name elsewhere, such as `plugins/progress-tracking/templates/progress.md`. [TRACKING_FILES]

    An item you cannot judge from the diff and the report (it depends on code
    the diff does not show, or on a fact you cannot check) is neither a pass
    nor a fail: list it under Cannot Verify, with what would settle it.

    ## Calibration

    A failed item is a finding. Important means the task cannot be trusted
    until it is fixed: a secret in the diff, a forbidden path, a commit the
    repo's hooks would reject, missing verification evidence. A formatting
    slip with no effect is Minor.

    ## Output Format

    Your final message is the report itself: begin directly with the first
    checklist verdict. No preamble, no process narration.

    ### Checklist

    1–7: pass | fail | cannot verify, with file:line evidence for each.

    ### Findings

    #### Critical (Must Fix)
    #### Important (Should Fix)
    #### Minor (Nice to Have)

    For each: file:line, the failed item, and what would make it pass.

    ### Cannot Verify

    One line per item: what you could not check, and what would settle it.
    "None" if none.

    ### Verdict

    **Safety:** [clean | findings | cannot verify]
```

**Placeholders:**
- `[TIER]` — the task's effective tier (`heavy`, `standard` or `light`), after `tier-check`
- `[BRIEF_FILE]` — the task brief file (same file the implementer worked from)
- `[GLOBAL_CONSTRAINTS]` — the binding constraints copied verbatim from the
  plan's Global Constraints section or the spec, plus any canary rule for
  this task
- `[REPORT_FILE]` — the implementer's report file
- `[BASE_SHA]` — the BASE recorded before the task's dispatch
- `[HEAD_SHA]` — current commit
- `[DIFF_FILE]` — the path `node scripts/review-package PLAN_FILE BASE HEAD`
  printed (the same package the hunters and the spec reviewer read)
- `[TRACKING_FILES]` — when opted in, the `progress` and `status` paths from
  `triqual tasks paths --json` and the plan's `*.tasks.json`; in store mode
  (`"mode": "store"`, which has no such paths), the line `store mode: no tracking
  file is expected`; when not opted in, drop checklist item 7

**Safety reviewer returns:** the checklist verdicts, findings by severity,
the Cannot Verify items, and a one-line verdict (clean | findings | cannot
verify).
