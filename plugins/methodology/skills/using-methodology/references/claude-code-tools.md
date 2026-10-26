# Claude Code Tool Notes

Claude Code is the reference harness: skills speak its vocabulary
(`Agent` for a subagent dispatch, todos, `Skill`). These notes cover how a
role dispatch maps onto its tools.

## Role dispatch

A dispatch line such as `Subagent (roles:spec-reviewer):` is an `Agent` call
whose `subagent_type` is that role, `roles:<name>` (an agent of plugin
`roles`). Pass no `model`: the role's definition pins its model and effort,
and a `model` in the call would override that pin. Only a generic agent, for
work no role covers, names a model.

Coordination stays in the main session. In a methodology:executing-plans run
it dispatches one `roles:phase-orchestrator` per phase; the orchestrator runs
the task loop and dispatches the other roles, and it is the only role that may
dispatch (every other role template forbids it). The orchestrator returns its
rulings and errors in its summary and in the ledger, and the main session
relays them to your human partner and asks on a `BLOCKED:` stop, since the
orchestrator cannot. Nested dispatch needs a harness that supports nested
subagents, which Claude Code does; where it is not available the orchestrator
returns `BLOCKED: nested dispatch unavailable` and the main session runs the
phase loop itself (the Fallback in The Thin Controller of executing-plans).
