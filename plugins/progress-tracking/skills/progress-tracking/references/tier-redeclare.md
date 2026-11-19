# Tier redeclare

Plain `triqual tasks retier T<N> <tier> --reason "<text>"` and `tier-check` only raise a task's effective tier. After an
owner-approved plan re-cut that changes a task's tier (the plan file already declares the new one), the task would
keep its old, higher effective tier. `--redeclare` resets it:

```
triqual tasks retier T<N> <tier> --redeclare --reason "<text>" --plan <plan.md|ledger>
```

## When

- Only after an owner-approved re-cut. Edit the plan's `**Tier:**` line first; the command checks the selected plan
  against `<tier>`.
- Only for pending or blocked tasks. An active, review, done or dropped task cannot be re-declared (exit 2:
  `T<N> is <status>; cannot redeclare`).
- `--plan` is required (`redeclare requires --plan`), and the selected plan's declaration must match `<tier>`
  (`T<N>: selected plan declaration must match tier <tier>`). The check runs inside the same locked update that writes
  the ledger, so a plan edited meanwhile cannot slip through.

## What it does

- Sets the task's declared tier and its effective tier to `<tier>`, and prints `T<N>: <old> -> <tier>`. A task already
  at `<tier>` on both prints `T<N>: already <tier>` and writes nothing.
- Appends a history entry with the status unchanged and the note
  `redeclare: declared <old|undeclared> -> <tier>; effective <old|standard> -> <tier>; <reason>`. Attempts and
  evaluations stay as they were.
- Every refusal (unknown task or tier, empty reason, a missing `--plan`, a status that is not pending or blocked, a
  plan that does not match) exits 2 and writes nothing.

## What stays the same

- A reconcile (`triqual tasks init` after a plan edit) keeps the redeclared tier: declared and effective now agree.
- Plain `retier` and `tier-check` stay raise-only: real diff evidence can raise the effective tier again after a
  redeclare, and `retier <lower>` still exits 2.
