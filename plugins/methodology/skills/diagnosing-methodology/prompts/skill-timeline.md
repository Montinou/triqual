Read `prompts/analyst-common.md` first; it gives your role, inputs,
context-safety rules, and the return format. This file adds the dimension.

Dimension: Skill timeline

Build the per-human-turn record of skill and plugin use, then look for gaps.

1. List the human prompts with line numbers and timestamps.
2. Using the skill-invocation and attribution meanings established in the case
   file, list every explicit invocation, active-skill attribution, or read of a
   file named `SKILL.md`. Record the line, the skill name, and the human turn it
   happened in.
3. List every non-methodology plugin, skill, agent type, MCP server, or
   hook used. Use only the evidenced tool, attribution, agent-dispatch, MCP,
   and hook meanings recorded in the case file; identify values associated
   with something other than this system's plugins (`methodology`,
   `roles`, `progress-tracking`, `workflow-gate`).
4. For each human turn, compare the request text against the trigger
   descriptions of the methodology skills installed (read
   `<install root>/skills/*/SKILL.md` frontmatter `description` lines; the
   install root is in the case file). The ten skills of this system are
   `using-methodology`, `brainstorming`, `writing-plans`, `executing-plans`,
   `test-driven-development`, `verification-before-completion`,
   `systematic-debugging`, `finishing-branch`, `diagnosing-methodology` and
   `reviewing-code`. A skill name outside that list (a session on an older
   install) is reported as it appears. Report as findings:
   - a skill invoked, with the request that preceded it (one finding per
     invocation is fine when there are few; group by skill when many);
   - a turn whose request matches a skill's trigger description with no
     invocation in that turn (state which description matched and quote
     the request);
   - a skill invoked one or more turns after the matching request (late);
   - each non-methodology plugin/skill/tool used, with where.

5. When the session ran a plan, the plan's shared ledger `sdd-ledger.md`
   (or the transcript's tool calls that wrote it, once the main session has
   deleted the workspace) holds `Tier: T<N> <tier>` and
   `Tier raised: T<N> <from> → <to> — <reason>` lines. List them with their
   line numbers beside the skill events of the same turns: they show which
   task ran at which tier, and a `Tier raised:` line is the controller's
   record, not a skill firing. The same holds for the `Orchestrator:`,
   `Prep:`, `Landed:`, `Phase review:` and `Round 1: P<n>` lines: they record
   the run, not a skill firing.

Do not say whether a missed or late trigger was wrong. Report the match
and the absence; the reader decides.
