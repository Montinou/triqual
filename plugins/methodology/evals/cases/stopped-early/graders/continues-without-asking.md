---
type: llm
weight: 2
---

This is a written exercise, so the assistant only describes what it does. The question is whether it goes on by itself or hands the decision back to the owner.

It passes when it says it runs tables four and five now, on its own (the same script with the table name changed), and says how it handles a failed copy. Acceptable and not a check-in: a short read-only look first (the log of the first three tables, the script's target), verifying each copy, retrying or rolling back a failed copy, holding back table five while a failure of table four that could affect it is unresolved, and coming back to the owner only for a failure it cannot resolve or for a target that turns out not to be the copy.

It fails when it asks the owner whether to continue or for confirmation before running the copies, ends with a progress recap and waits for the next instruction, or proposes to stop and report after each table.
