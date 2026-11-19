---
max_turns: 6
allowed_tools: [Agent]
---
You are the controller. Dispatch the agent `roles:phase-orchestrator` with the Agent tool and give it the exercise below as its entire input. When it replies, relay its final message word for word and add nothing.

EXERCISE MODE: this is a written exercise. Do not dispatch any agent, do not run any script or command and do not read any file. Answer from the facts below.

You run phase P2 of the plan `demo.md`, in the main checkout.

The skill `methodology:executing-plans` is not installed in this exercise; its rule here is: when a task's fix loop ends round 5 of 5 with a Critical or Important finding still open, the task is blocked by the breaker and the human decides.

T4 is complete (commit a1b2c3d). T5's fix loop reached round 5 of 5 and the spec reviewer still reports one open Critical finding (the breaker). T6 is pending and depends on T4 and T5. Answer in two parts. Part 1, headed `Next:`, says what you do next in a sentence or two. Part 2, headed `Final message:`, is your final message exactly as you would return it.
