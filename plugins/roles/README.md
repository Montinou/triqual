# roles

Nine role agents for executing a plan. Each is a Claude Code subagent: one Markdown file in
`agents/` whose frontmatter pins the model, the reasoning effort and the tools the agent may not
use. Dispatch one by its agent type, `roles:<name>`. The dispatch passes no model, because the
agent's definition carries it.

The plugin has no commands, hooks or skills. The skills that dispatch the agents live in
[`methodology`](../methodology/README.md). `workflow-gate` reads the model of each role (see
[`../workflow-gate/README.md`](../workflow-gate/README.md)).

## The agents

Tools column: the `disallowedTools` line of the frontmatter. An agent can use every other tool.
Only `phase-orchestrator` can dispatch subagents; `Agent` is in every other role's list.

| Agent | Model | Effort | Cannot use | What it does |
|---|---|---|---|---|
| `roles:brief-writer` | `sonnet` | medium | Agent, Edit, NotebookEdit | Extracts a task brief from a plan and the current code: interfaces, file paths, constraints, exact values. Reads and summarizes; makes no design decisions. |
| `roles:tdd-implementer` | `sonnet` | high | Agent | Implements one plan task from a brief with strict TDD: failing test, run it, implement, run it green. Runs the project's typecheck, lint and tests, commits, self-reviews and writes a report. |
| `roles:complex-implementer` | `opus` | medium | Agent | Same method as `tdd-implementer`, for a task the plan marks `**Role:** roles:complex-implementer`: multi-system changes, migrations of live state, or work where a mistake is costly. |
| `roles:safety-reviewer` | `sonnet` | medium | Agent, Edit, Write, NotebookEdit | Mechanical checklist review of one task diff: commit subject and trailers, secrets in the diff, forbidden paths, file placement, lint and typecheck evidence, canary rules. No design judgment. |
| `roles:spec-reviewer` | `sonnet` | medium | Agent, Edit, Write, NotebookEdit | Judgment review of one task diff against its brief and spec: missing, extra or misunderstood requirements, and test honesty (real assertions, genuine RED/GREEN evidence, edge cases). Traces code paths and branches. |
| `roles:review-fixer` | `sonnet` | high | Agent | Resolves review findings on a task branch. Fixes what is real with the smallest change; refutes with evidence what is wrong instead of implementing it. Re-runs the covering tests, commits and appends a fix report. |
| `roles:final-adversarial-reviewer` | `opus` | high | Agent, Edit, Write, NotebookEdit | One adversarial review of a whole branch before merge. Hunts correctness and security defects across task boundaries, triages deferred and parked findings, and gives a merge verdict. |
| `roles:hunter` | `claude-haiku-5-5` | medium | Agent, Edit, NotebookEdit | Hunts for defects in one diff package for one category (correctness, security, spec-drift or state) and writes its candidates to a single file. Finds and reports; never fixes and never grades severity. |
| `roles:phase-orchestrator` | `sonnet` | medium | Edit, NotebookEdit | Runs one phase of a plan by following `methodology:executing-plans` for that phase only: dispatches the other roles, never edits product code, ends on any stop with `BLOCKED: <stop> — <details>` and returns a summary of at most 20 lines (phase status, task commits, rulings, open minors, errors and fallbacks). The only role that may dispatch agents. |

The reviewers `safety-reviewer`, `spec-reviewer` and `final-adversarial-reviewer` cannot edit or
write files. The `hunter` and `brief-writer` can write (each writes one output file) but cannot
edit.

## Which skills dispatch them

Found by searching `roles:<name>` in `plugins/methodology/skills`:

| Agent | Dispatched by |
|---|---|
| `brief-writer` | `executing-plans`, only when a task's plan text lacks interfaces that must come from the current code |
| `tdd-implementer` | `executing-plans`: the default task role |
| `complex-implementer` | `executing-plans`: a task whose `**Role:**` is `roles:complex-implementer`, and its fix rounds |
| `safety-reviewer` | `executing-plans` |
| `spec-reviewer` | `executing-plans`, `reviewing-code` |
| `review-fixer` | `executing-plans` (fix rounds) |
| `final-adversarial-reviewer` | `executing-plans`, `brainstorming` (spec audit), `writing-plans` (plan audit) |
| `hunter` | `executing-plans`, `reviewing-code` |
| `phase-orchestrator` | `executing-plans`: one per phase, from methodology 1.3.0 |

A plan's task `**Role:**` line is `roles:tdd-implementer` (the default when the line is
missing), `roles:complex-implementer` or `coordinator`. `roles:review-fixer` is still read in plans
written before 1.0, but no plan plans one now: `executing-plans` dispatches it for fix rounds.
`executing-plans` stops and asks if a task names any other role: the reviewers, the
hunter and the brief writer serve a task and are never its role.

In a plan with tiers a `roles:complex-implementer` task is `heavy` and a `coordinator` task is
`light`, and registration refuses any other pairing.

## Which tier gets which reviewers

`executing-plans` sizes a task's review by its tier. The safety gate runs at every tier.

| Tier | `hunter` | `safety-reviewer` | `spec-reviewer` |
|---|---|---|---|
| heavy | 2: correctness, and security or state, picked from the task's heavy reason line | yes | every candidate and the spec fit |
| standard | none | yes, in parallel with the spec reviewer | yes, in parallel with the gate |
| light | none | yes | only on a finding or `Cannot verify` from the gate |

Each phase of a plan also gets a deep review before it is submitted: 4 hunters (correctness, security, spec-drift,
state) and the `final-adversarial-reviewer` over the phase diff. The final review of a plan with several phases is a
seams review by the `final-adversarial-reviewer` alone, with no hunters; in a single-phase plan the phase review is the
final review.

## Codex and Grok

Codex does not read these files directly. `triqual sync` generates one agent file per role in
`~/.codex/agents/` from the installed plugin, and Codex pins its own model and effort per role.
The table is in [Codex and Grok](../../README.md#codex-and-grok) in the root README.

## Role evaluation

`triqual role-eval` is a `methodology` command, not part of this plugin. `record` appends a
hunter, task-review or final-escapes record to a local store, `summary` reports it per provider
and `summary --by-tier` per review tier. See the [`methodology` README](../methodology/README.md).

## Tests

`test/agents.test.mjs` checks the frontmatter of each agent against the table above.
`workflow-gate` has a test that keeps its role-to-model map in sync with these files.
