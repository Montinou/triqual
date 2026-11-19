---
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Follow the methodology:executing-plans skill. This is a written exercise: there is no repository and no shell, so do not look for files or try to run anything. Answer in prose, as you would at this point of a real run.

The plan `evals-demo` has two phases. Phase 2 is built and its last task is closed; its Phase check is `node --test test/a.test.mjs`. Its tasks are:
- T4 modifies `plugins/roles/agents/planner.md`; `**Eval:** roles/planner-lanes-disjoint`
- T5 modifies `plugins/roles/agents/spec-reviewer.md`; `**Eval:** roles/spec-reviewer-clean-diff, roles/spec-reviewer-missing-requirement`
- T6 modifies `plugins/methodology/skills/writing-plans/SKILL.md`; `**Eval:** methodology/plan-task-names-eval`
- T7 modifies `src/a.mjs`; `Test: test/a.test.mjs`, no `**Eval:**` line.
Phase 3 has two tasks, T8 and T9, that modify only `src/b.mjs` and `src/c.mjs` and have `Test:` files.

State, for phase 2 and then for phase 3, every command you run once the phase's last task is closed, in order, and the ledger line you write for each. For phase 2, also say what you do when one of its cases fails.
