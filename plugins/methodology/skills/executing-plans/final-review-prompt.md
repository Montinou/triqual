# Final Review Prompt Template

Use this template once per plan, after every task is complete, to dispatch
the final whole-branch review to `roles:final-adversarial-reviewer`
(methodology:executing-plans, Final Review). The final review runs for every
plan, at every tier mix. Pass no model: the role's definition pins it.

**Purpose:** Try to break the whole branch against its spec, across task
boundaries no per-task review could see, verify every candidate the final
hunters ([hunter-prompt.md](hunter-prompt.md)) found, and triage every
deferred and parked ledger item before merge.

```
Subagent (roles:final-adversarial-reviewer):
  description: "Final review of the branch"
  prompt: |
    You are reviewing an entire branch once, adversarially, before merge.
    Every task on it already passed a task-scoped spec review and safety
    review. Your job is what those could not see.

    ## What It Must Do

    Spec: [SPEC_PATH]
    Plan: [PLAN_PATH]

    The spec is the binding authority; the plan is its argument. Read the
    plan's Global Constraints and the spec sections it cites.

    ## Review Focus

    The plan's own list of what could go wrong, verbatim:

    [REVIEW_FOCUS]

    Treat each item as a hypothesis to test against the diff, not as a
    checklist to tick.

    ## Diff Under Review

    **Package:** [PACKAGE_PATH]

    Read the package once: it holds the branch's commit list, a stat summary
    and the full diff with context (MERGE_BASE..HEAD). In stacked execution
    that range is `trunk..top`: every phase of the stack, in order, one commit
    per task. Do not re-derive the branch diff with git commands. Inspect code outside the diff to confirm
    a concrete candidate defect you can name, and say what you checked.

    ## Candidates to Verify

    Candidates files from the final hunters: [CANDIDATES_PATHS]

    Three hunters (a cheaper model) read the whole branch for `correctness`
    across tasks, `security` and `spec-drift`. Each candidate in their files
    is an unverified claim of a defect, with an id (`<category>-<k>`), a
    `file:line`, a one-sentence claim and how to reproduce or refute it.
    Verify each one yourself against the package and the code: a candidate is
    neither true nor false because it was written. The controller never tells
    you how to rule on a candidate.

    Give every candidate exactly one verdict:
    - `confirmed`, with evidence and a severity (`critical`, `important` or
      `minor`);
    - `refuted`, with evidence;
    - `duplicate-candidate` of another candidate id;
    - `duplicate-review` of one of your own findings (report that finding
      once, in Findings).

    A candidate with no location (`file:line`) or no reproduction is
    `refuted` for that reason. A candidate left without a verdict makes your
    review incomplete, and the controller sends it back. When the line above
    says none, there are no candidates: write "None" under Candidate Verdicts.

    ## The Ledger

    Read the workspace ledger: [SDD_LEDGER_PATH]

    Its `Ruling:` lines are the decisions the controller took without a
    human: the pre-flight rulings, the parked findings and the breaker
    adjudications. Its `minor (deferred)` and `parked` lines are findings the
    task loops left open. Triage every one of them: must fix before merge,
    or accept with a one-line reason. A ruling you think is wrong is a
    finding.

    ## Method

    Assume the branch is wrong and try to prove it. Cross task boundaries:
    interfaces one task produced and another consumed, data written by one
    component and read by another, error paths, concurrency, secrets
    handling, and anything the per-task reviews could not see. For each
    candidate defect, confirm it by tracing the code or running a focused
    check before reporting it; discard what you cannot substantiate.

    ## The spec is a vision document

    The spec says what the software must do. It does not enumerate every
    input, environment, or condition the software will meet. For behavior
    the spec is silent on, judge by what a reasonable person using this
    software would expect: a reasonable person's expectation is a
    requirement, and a spec's silence is not permission. Grade such
    findings by their effect on that person, not by whether the spec
    mentions the trigger.

    ## Declined to judge

    Before your verdict, list every behavior you considered and set aside
    as outside the plan or spec, one line each, with the reason. The
    controller rules on each line; nothing you set aside is dropped
    silently. An empty list means you set nothing aside.

    ## Read-Only Review

    Your review is read-only on this checkout. Do not mutate the working
    tree, the index, HEAD, or branch state in any way. If you need a file
    from a different revision, read it with `git show <sha>:<path>`. If you
    need a whole copy of that revision, export it without registering a
    worktree, as three separate commands: `mktemp -d` (the directory it prints is
    `<d>`), `git archive --output=<d>/rev.tar <sha>`, `tar -x -f <d>/rev.tar -C <d>`;
    then `rm -rf <d>` before you report. Never run `git worktree add`, and never
    move HEAD on this checkout.

    ## You Do Not Dispatch Subagents

    Do all of this review yourself. Never spawn a subagent to review part
    of the diff, and never spawn another reviewer for a second opinion.
    This process already provides every review seat the work gets; a
    reviewer you spawn duplicates one of them at full cost, and its
    verdict counts for nothing. If the diff feels too large for one
    pass, review it in passes yourself and say so in your report.

    ## Denied by Policy

    A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence's policy; when in doubt, stop.

    You ask the human through your final message: it replaces the output format below. Begin it with BLOCKED, then the denied call, its path and the reason verbatim, and review nothing further. The controller relays it.

    ## Calibration

    Categorize issues by actual severity. Not everything is Critical.
    Critical and Important mean the branch cannot merge until they are
    fixed. If you find issues with the plan or the spec rather than the
    implementation, say so.

    ## Output Format

    ### Findings

    #### Critical (Must Fix)
    #### Important (Should Fix)
    #### Minor (Nice to Have)

    For each: file:line, the task it traces to, the phase it sits in, what
    is wrong, a concrete failure scenario, and how to fix it (if not
    obvious). Name the task (`Task <N>`): the package holds one commit per
    task, whose subject and progress entry name it, so trace the defective
    lines to the commit that wrote them; write `untraced` only when no single
    task's commit introduced the defect (it emerges from several, or from
    code before the branch). The controller counts the traced findings
    against each task's review tier, so name a task only when you traced it.
    Name the phase (`Phase <N>`; the package's commit list shows which
    commits belong to which phase, and a plan without phases needs none): the
    controller fixes every finding in one commit on the top phase and never
    rewrites a submitted phase, so the phase tells the fixer where the code
    lives.

    ### Candidate Verdicts

    One line per candidate, in file order, each with exactly one verdict:
    - `<candidate id>`: confirmed (critical | important | minor), `Task <N>`
      or `untraced` — evidence with file:line
    - `<candidate id>`: refuted — evidence with file:line
    - `<candidate id>`: duplicate-candidate of `<other candidate id>`
    - `<candidate id>`: duplicate-review of your finding `<file:line>`

    "None" when there are no candidates.

    ### Ledger Triage

    Every `Ruling:`, deferred-minor and parked line: must fix before merge,
    or accept, with one line of reason.

    ### Declined to Judge

    One line each, with the reason. "None" if you set nothing aside.

    ### Verdict

    **Merge:** [ready | not ready] — list what blocks it. A confirmed
    `critical` or `important` candidate blocks it like any finding.
```

**Placeholders:**
- `[PACKAGE_PATH]` — the path `node scripts/review-package PLAN_FILE MERGE_BASE HEAD`
  printed (MERGE_BASE: the commit the branch started from, e.g. `git merge-base <trunk> HEAD`)
- `[PLAN_PATH]` — the plan file
- `[SPEC_PATH]` — the spec the plan names; "none" when the plan has no reachable spec
- `[REVIEW_FOCUS]` — the plan's Review Focus section, copied verbatim; "none" when the plan has none
- `[SDD_LEDGER_PATH]` — the workspace ledger, `sdd-ledger.md`; the reviewer reads its `Ruling:`, deferred-minor and parked lines
- `[CANDIDATES_PATHS]` — every `final-candidates-<category>.md` the final hunters
  returned; "none" when the hunters were skipped or returned no file

**Final reviewer returns:** findings by severity, each with the task it traces
to (or `untraced`) and its phase, a verdict for every candidate, the ledger triage, the declined-to-judge list, and a merge verdict
(ready | not ready).
