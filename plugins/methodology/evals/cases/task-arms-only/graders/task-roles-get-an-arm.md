---
type: llm
weight: 3
---

For (a), (b) and (c) the assistant runs `triqual eval arm --kind role --plan evals-demo.md --task T3 --role <role>` before the dispatch, with the roles `tdd-implementer`, `review-fixer` and `spec-reviewer` (no `roles:` prefix).
