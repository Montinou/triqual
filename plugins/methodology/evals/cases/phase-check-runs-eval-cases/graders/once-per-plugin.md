---
type: llm
weight: 3
---

For phase 2, after the Phase check command, the assistant runs `triqual eval cases` exactly once per plugin: one call for `plugins/roles` naming `planner-lanes-disjoint`, `spec-reviewer-clean-diff` and `spec-reviewer-missing-requirement` each with `--case`, and one call for `plugins/methodology` naming `plan-task-names-eval`. It does not run one call per case or per task.
