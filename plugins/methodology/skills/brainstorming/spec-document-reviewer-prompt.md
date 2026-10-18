# Spec and Plan Audit Prompt Template

Use this template for the adversarial audit of a spec (brainstorming) and of its implementation plan (writing-plans).
The audit always goes to `roles:final-adversarial-reviewer`.

**Purpose:** Find what would make the spec, or the plan built from it, lead to the wrong software: gaps,
contradictions, ambiguity, scope, and spec requirements the plan leaves out.

**Dispatch after:** the spec's self-review (brainstorming), and the plan's self-review (writing-plans).

```
Subagent (roles:final-adversarial-reviewer):
  description: "Audit spec document" (or "Audit plan document")
  prompt: |
    You are auditing a [spec | implementation plan] adversarially. Assume it has defects and find the
    ones that would cause real problems during planning or implementation.

    **Document to audit:** [DOCUMENT_PATH]
    **Spec it implements (plan audits):** [SPEC_FILE_PATH]

    ## What to Check

    | Category | What to Look For |
    |----------|------------------|
    | Completeness | TODOs, placeholders, "TBD", incomplete sections |
    | Consistency | Internal contradictions, conflicting requirements |
    | Clarity | Requirements ambiguous enough to cause someone to build the wrong thing |
    | Scope | Focused enough for a single plan — not covering multiple independent subsystems |
    | YAGNI | Unrequested features, over-engineering |
    | Modularity | A unit with a missing interface or dependency line; a forward slice dependency (a slice that depends on a later slice); an uncovered unit (no slice delivers it); a slice that does not stand alone (trunk would break or carry half-built reachable code if it merged alone, in order); an oversized slice (more than about 6 atomic tasks); an operation that needs the merge listed as a slice instead of under the rollout |

    For a plan, also check:

    | Category | What to Look For |
    |----------|------------------|
    | Spec coverage | A spec requirement with no task, or a task the spec does not ask for |
    | Interfaces | Names, signatures and types that differ between the tasks that produce and consume them |
    | Task format | Each task has `### Task N:`, a `**Role:**` line with a task role, and `**Depends on:**` only when it has dependencies |
    | Tests | A task whose tests would pass without the behavior it promises |
    | Phases | A phase with no slice; a task depending on a later phase; a phase without a branch, PR title, Phase check or committing task; a merge-dependent operation written as a task instead of under `## After Merge` |
    | Tiers | A task tiered lower than its content justifies by the rubric; a plan with tiers on some tasks only; a coordinator task not light; a complex-implementer task not heavy |

    ## Denied by Policy

    A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence's policy; when in doubt, stop.

    You ask the human through your final message: it replaces the output format below. Begin it with BLOCKED, then the denied call, its path and the refusal text verbatim, and audit nothing further. The controller relays it.

    ## Calibration

    **Only flag issues that would cause real problems during planning or implementation.**
    A missing section, a contradiction, a requirement so ambiguous it could be interpreted
    two different ways, a spec requirement the plan drops — those are issues. Minor wording
    improvements, stylistic preferences, and "sections less detailed than others" are not.

    Approve unless there are serious gaps that would lead to a flawed plan or flawed software.

    ## Output Format

    ## Audit

    **Status:** Approved | Issues Found

    **Issues (if any):**
    - [Section or Task X]: [specific issue] - [why it matters]

    **Recommendations (advisory, do not block approval):**
    - [suggestions for improvement]
```

**Auditor returns:** Status, Issues (if any), Recommendations
