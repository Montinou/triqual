## Example

```
[Setup: no worktree asked for; triqual tasks paths --json → opted in, "mode": "store"]
[node scripts/sdd-workspace <plansDir>/billing.md → fresh workspace; ledger created]
[node scripts/stack.mjs init <plansDir>/billing.md → github mode; method chosen at the handoff → Authorization: … — handoff 2026-10-18]
[Tiers at setup: T1 standard, T2 light, T3 light (all declared) → Tier: lines; pre-flight table written]

Phase 1 (node scripts/stack.mjs phase <plansDir>/billing.md 1)
[main session: dispatches one roles:phase-orchestrator with orchestrator-prompt.md, waits once; the orchestrator runs Tasks 1-3 below]

Task 1 (standard, roles:tdd-implementer)
[task-open → brief, report, base a1b2c3d; dispatch roles:tdd-implementer]
Implementer: DONE, 1 commit, RED → GREEN evidence in the report.
[task-prep → tier standard, hunters none, package, round 1]
[round 1: gate + roles:spec-reviewer in parallel, no hunters → clean; both final messages saved as round-1 outputs]
[task-close → sha d4e5f6a (squash, done, Task 1: complete, task-review record, review entry)]

Task 2 (light, roles:tdd-implementer) — first of a light batch
[task-open → base d4e5f6a; dispatch roles:tdd-implementer]
[DONE; task-prep → tier light; gate alone → clean, saved as its round-1 output]
[task-close → sha e0f1a2b]

Task 3 (light) — resumed, not re-dispatched
[task-open → base e0f1a2b; resume the same implementer with "Next task"]
[DONE; task-prep → raise light standard: code beyond the light allowance: src/pay.mjs; it wrote Tier raised: T3 light → standard — … and retiered the task; tier standard; the batch ends]
[standard review: gate + roles:spec-reviewer in parallel → clean, both saved; task-close]

[orchestrator summary: Phase: P1 done; Tasks: T1 d4e5f6a, T2 e0f1a2b, T3 f3a4b5c; no rulings, no open minors, Errors and fallbacks: none; main session writes Orchestrator: P1 — Phase: P1 done]

[Phase check passes; phase review: 4 hunters + roles:final-adversarial-reviewer → clean; Phase review: P1 clean; hunters and final-escapes records (P1); done; submit]
[single-phase plan: the phase review was the final review; no seams review]
[node scripts/stack.mjs submit <plansDir>/billing.md 1 --open; final message with Rulings and After Merge; methodology:finishing-branch]
```
