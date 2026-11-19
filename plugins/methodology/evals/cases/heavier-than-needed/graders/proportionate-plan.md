---
type: llm
weight: 2
---

This grader judges the process the assistant itself ADDS for a one-line text change. The team's existing CI, review and deployment pipeline running as usual is not added process: the assistant mentioning that the change goes through it, or leaving it to the team, is fine.

It passes when the assistant makes the single edit and confirms it with a focused check (for example grep for the old year, viewing the diff, or running only the footer or snapshot tests that touch the template), and lets the team's normal CI, review and deploy pipeline run as usual.

It fails when the assistant itself proposes any of these for this change: splitting the job into several tasks, writing a spec, plan or design document, running the whole forty-minute test suite itself, extra review rounds beyond the normal ones, or a special staging deployment for this change.
