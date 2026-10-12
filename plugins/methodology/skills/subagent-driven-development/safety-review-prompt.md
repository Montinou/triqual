# Safety Review Prompt Template

Use this template when dispatching the task's safety reviewer, the gate
(`roles:safety-reviewer`), in round 1 of the task review, together with the
hunters ([hunter-prompt.md](hunter-prompt.md)), on the same review package.
The spec reviewer ([task-reviewer-prompt.md](task-reviewer-prompt.md),
`roles:spec-reviewer`) runs in round 2. The safety reviewer runs a fixed checklist on the diff and
judges no design. Pass no model: the role's definition pins it.

**Purpose:** Catch the rule-based defects of one task's diff (commit format,
secrets, forbidden paths, file placement, missing verification evidence,
canary rules) cheaply, so the spec review can spend its attention on judgment.

```
Subagent (roles:safety-reviewer):
  description: "Safety review Task N"
  prompt: |
    You are running the safety checklist on one task's implementation. This
    is a task-scoped gate: a spec reviewer judges requirements and design in
    the next round, and a whole-branch review happens after all tasks are
    complete.

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
       output (typecheck, lint, tests); warnings in that output are findings.
    6. **Canaries:** each canary rule in the global constraints above.
    7. **Tracking files:** when the repo is opted in, `progress.md`, `status.md` and the plan's task ledger (`*.tasks.json`) are expected in every task diff: never flag them as unexpected files. In store mode (`"mode": "store"`) it is the other way round, because no tracking file is ever staged or committed: an added or modified root `progress.md` or `status.md`, or a plan-side `*.tasks.json`, is a finding; a deletion of one is not (the switch commit removes them, and a merge keeps them deleted), and neither is a file of the same name elsewhere, such as `plugins/progress-tracking/templates/progress.md`. [TRACKING_FILES]

    ## Calibration

    A failed item is a finding. Important means the task cannot be trusted
    until it is fixed: a secret in the diff, a forbidden path, a commit the
    repo's hooks would reject, missing verification evidence. A formatting
    slip with no effect is Minor.

    ## Output Format

    Your final message is the report itself: begin directly with the first
    checklist verdict. No preamble, no process narration.

    ### Checklist

    1–7: pass | fail, with file:line evidence for each.

    ### Findings

    #### Critical (Must Fix)
    #### Important (Should Fix)
    #### Minor (Nice to Have)

    For each: file:line, the failed item, and what would make it pass.

    ### Verdict

    **Safety:** [clean | findings]
```

**Placeholders:**
- `[BRIEF_FILE]` — the task brief file (same file the implementer worked from)
- `[GLOBAL_CONSTRAINTS]` — the binding constraints copied verbatim from the
  plan's Global Constraints section or the spec, plus any canary rule for
  this task
- `[REPORT_FILE]` — the implementer's report file
- `[BASE_SHA]` — commit before this task
- `[HEAD_SHA]` — current commit
- `[DIFF_FILE]` — the path `bash scripts/review-package PLAN_FILE BASE HEAD`
  printed (the same package the hunters and the spec reviewer read)
- `[TRACKING_FILES]` — when opted in, the `progress` and `status` paths from
  `triqual tasks paths --json` and the plan's `*.tasks.json`; in store mode
  (`"mode": "store"`, which has no such paths), the line `store mode: no tracking
  file is expected`; when not opted in, drop checklist item 7

**Safety reviewer returns:** the checklist verdicts, findings by severity,
and a one-line verdict (clean | findings).
