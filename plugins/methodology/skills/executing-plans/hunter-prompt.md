# Hunter Prompt Template

Use this template to dispatch a hunter, `roles:hunter`, only in a phase review,
for each hunter it sends (a task's review sends none at any tier, and the seams
review at the end of a plan sends none). One hunter looks at one category of defect, except the phase
`correctness` hunter, which spans correctness, state and spec drift, in one review package and
writes its candidates to one file; `roles:final-adversarial-reviewer` verifies
them in round 2 of the phase review. The
hunter's agent definition carries its standing instructions: this template is
only the dispatch. Pass no model: the role's definition pins it.

**Purpose:** A cheap, wide first pass over the diff. The hunter reports
candidates; it never fixes and never grades severity.

**Candidate rule** (the agent definition carries it; every dispatch gets it):
each candidate gives a `file:line`, the concrete trigger input or state, the
traced path to the wrong result, and expected against actual. No suspicion, no
"could": a candidate without a trigger the hunter can name is not reported. A
hunter reports at most 3 candidates.

```
Subagent (roles:hunter):
  description: "Hunt [CATEGORY] candidates in Task N"
  prompt: |
    Category: [CATEGORY]

    Diff package (read it once; it holds the commit list, a stat summary and
    the full diff with context): [PACKAGE_PATH]

    Task brief (what was requested): [BRIEF_FILE]

    Write your candidates to: [CANDIDATES_PATH]

    ## Denied by Policy

    A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence's policy; when in doubt, stop.

    You ask the human through your reply: begin it with BLOCKED, then the denied call, its path and the reason verbatim, and hunt no further. The controller relays it.
```

**Phase review:** drop the `Task brief` line and give
the hunter the spec and the plan instead, with the package of the phase's range
(phase base..phase top) and the candidates file `<workspace>/phase-<N>-candidates-<category>.md`:

```
    Spec: [SPEC_PATH]
    Plan: [PLAN_PATH]
    Scope: correctness, state and spec drift together (one candidates file; correctness hunter only, the security hunter's dispatch has no Scope line)
```

A phase review sends a `correctness` hunter, which covers correctness, state and
spec drift together, and a `security` hunter only when the phase range touches a
sensitive path (the same sensitive paths as `tier-check`: its defaults plus the plan's
`**Sensitive paths:**`). A task's review never sends a hunter: this template is
dispatched only in a phase review.

**Placeholders:**
- `[CATEGORY]` — one of `correctness`, `security`, `spec-drift`, `state`
- `[PACKAGE_PATH]` — the path `node scripts/review-package PLAN_FILE BASE HEAD`
  printed (the same package the gate and the spec reviewer read); in a phase
  review, the package of the phase's range
- `[CANDIDATES_PATH]` — the file the hunter writes:
  `<workspace>/task-<N>-candidates-<category>.md`, or
  `<workspace>/phase-<N>-candidates-<category>.md` in a phase review
- `[BRIEF_FILE]` — a task's brief file (`node scripts/task-brief PLAN_FILE N`
  prints the path; the same file the implementer worked from)
- `[SPEC_PATH]` — phase review only, in place of the brief: the spec the plan
  names
- `[PLAN_PATH]` — phase review only, in place of the brief: the plan file

**Hunter returns:** the candidates file path and a one-line count. A valid
empty file (a single line saying there is no candidate) counts as done, with 0
candidates.
