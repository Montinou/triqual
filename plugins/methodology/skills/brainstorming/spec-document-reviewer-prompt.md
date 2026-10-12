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

    For a plan, also check:

    | Category | What to Look For |
    |----------|------------------|
    | Spec coverage | A spec requirement with no task, or a task the spec does not ask for |
    | Interfaces | Names, signatures and types that differ between the tasks that produce and consume them |
    | Task format | Each task has `### Task N:`, a `**Role:**` line with a task role, and `**Depends on:**` only when it has dependencies |
    | Tests | A task whose tests would pass without the behavior it promises |

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
