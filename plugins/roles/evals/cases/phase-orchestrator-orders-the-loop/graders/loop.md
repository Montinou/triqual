---
type: llm
weight: 2
---
For each task it states the sequence: `task-open`, dispatch the implementer, `task-prep`, the review at the task's tier (the safety gate alone for light, the safety gate and `roles:spec-reviewer` for standard), `task-close`.
