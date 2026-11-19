---
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Follow the methodology:executing-plans skill. This is a written exercise: there is no repository and no shell, so do not look for files or try to run anything. Answer in prose.

You are the phase orchestrator of phase 1 of the plan `evals-demo.md`, in the main checkout. Task T3 is open. You are about to make five dispatches: (a) the implementer of T3, (b) a `roles:review-fixer` for a finding on T3, (c) the spec reviewer of T3, (d) a `roles:brief-writer` for T3, whose plan text lacks interfaces, and (e) the phase review of P1 by `roles:final-adversarial-reviewer`, which the main session dispatches. For each of the five, say whether you run `triqual eval arm` first and, if so, the exact command.
