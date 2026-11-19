---
type: llm
weight: 2
---

The assistant states one command line for the Phase check. It passes when that command runs the Phase check's argv through the skill's lock runner: `node <path>/test-lock -- node --test test/a.test.mjs`, where `<path>` may be any path to the `test-lock` script (absolute, or the skill's `scripts` directory as the skill names it). It fails when the command is the bare `node --test test/a.test.mjs`, when it wraps the argv in `sh -c` or another shell string, or when it names no lock runner.
