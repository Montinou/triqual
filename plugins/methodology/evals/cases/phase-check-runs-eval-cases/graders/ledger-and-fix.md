---
type: llm
weight: 2
---

For phase 2 it writes one ledger line per plugin of the form `Eval: P2 <plugin> <k>/<m> passed <usd>` (the figures may be placeholders) and says that a failing case is treated as a Phase-check failure: the fix goes to the task that names the case, either as a reopen and fix round or as a fix commit by `roles:review-fixer` on the phase branch, and the Phase check and the Phase eval run again afterwards.
