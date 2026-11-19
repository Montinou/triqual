---
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Follow the methodology:writing-plans skill. You are writing the Task blocks of an implementation plan; do not read any repository, the facts below are all you need. Write exactly two tasks in the plan's task format, and nothing else.

Task A: change the wording of the agent prompt `plugins/roles/agents/spec-reviewer.md` so that it also flags a test that cannot fail. The roles plugin already has the replay cases `spec-reviewer-missing-requirement` and `spec-reviewer-clean-diff` under `plugins/roles/evals/cases/`.

Task B: add the function `parseDuration(text)` to `src/duration.mjs`, tested by `test/duration.test.mjs`.
