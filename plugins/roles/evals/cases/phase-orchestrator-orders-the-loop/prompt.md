---
max_turns: 6
allowed_tools: [Agent]
---
You are the controller. Dispatch the agent `roles:phase-orchestrator` with the Agent tool and give it the exercise below as its entire input. When it replies, relay its final message word for word and add nothing.

EXERCISE MODE: this is a written exercise. Do not dispatch any agent, do not run any script or command and do not read any file. Answer from the facts below.

You run phase P2 of the plan `demo.md`, in the main checkout.

Its tasks, all pending: T4 (tier light, role roles:tdd-implementer, Files `src/a.mjs`, Test `test/a.test.mjs`), T5 (tier standard, roles:tdd-implementer, Files `src/b.mjs`, Test `test/b.test.mjs`), T6 (tier light, depends on T4 and T5, Files `README.md`). T4 and T5 share no path. Say, in order, what you dispatch and run for the phase, and what your final message is.
