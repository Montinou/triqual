## Role dispatch is unavailable

Grok cannot select a named agent. Its `spawn_subagent` tool takes no
agent type (its inputs are `prompt`, `description`, `background`,
`isolation`, `resume_from` and `cwd`), and every child runs as a
general-purpose agent. Neither an agent file under `~/.grok/agents/`
nor a `roles:<name>` role can be selected by name.

So a skill's role dispatch (`roles:<name>`) has no Grok form:

- **Plan execution is unavailable in Grok: stop and ask your human partner.**
  `executing-plans` dispatches only roles and never substitutes another
  agent.
- The same holds for every other role dispatch (the task reviews, the
  final review, the spec and plan audit, `reviewing-code`):
  stop and ask your human partner before going on.
- Never spawn a general-purpose subagent in place of a role.

## Skills

Grok loads the methodology skills through its Claude compatibility.
`methodology:<x>` is the skill `<x>` (for example,
`methodology:finishing-branch` is the skill `finishing-branch`).
