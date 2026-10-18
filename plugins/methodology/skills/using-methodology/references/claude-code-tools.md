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

Coordination stays in this session. The controller of a
methodology:executing-plans run reads every result, makes the
rulings and moves the ledger; it is never handed to a nested orchestrator
subagent, since no role covers it and its "Rulings I made" list must reach
your human partner from the session that made them. Claude Code supports
nested subagents, but a role never dispatches another: each role template
forbids it.
