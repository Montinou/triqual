## Validating a phase against CI

A phase can name a CI workflow that must pass on its pushed head, and a command that judges the run. `node scripts/validate PLAN_FILE N` runs that check for phase N and records the verdict.

**The field.** A phase's `**Validate:**` line reads `<workflow> [compare=\`<command>\`]` or `none`. `<workflow>` is a workflow file name or name as `gh run list --workflow` takes it (`ci.yml`). `compare` is optional and sits in backticks. A phase with no line, or with `none`, declares no validation, and `validate` exits 3 for it. An unknown or repeated key, a `compare=` outside backticks and a missing workflow make the plan malformed (exit 2).

**What it does.** `validate` needs the stack in GitHub mode and phase N `submitted` or `ready` (else exit 3). It runs `git fetch <remote> <branch>`, reads the head from `git rev-parse <remote>/<branch>` (the head CI saw, not your local branch), and lists the runs with `gh run list --repo <owner>/<repo> --workflow <workflow> --commit <sha> --json databaseId,status,conclusion,url --limit 20`. The newest completed run is judged. When there is none, the script exits 3 with `no completed run of <workflow> for <sha> yet` and records nothing: wait for the run (`gh run watch`) and call `validate` again.

**The verdicts.**

- `clean`: with `compare`, the command exited 0; without it, the run's conclusion is `success`.
- `failed`: any other exit of `compare`, or any other conclusion.

`compare` runs with `sh -c` in the repository root, with `TRIQUAL_RUN_ID` (the run's `databaseId`) and `TRIQUAL_REPO_SLUG` (`<owner>/<repo>`) in its environment. Picking a reference run to compare against, if the project needs one, is the command's job.

**What it records.** The ledger gets `Validation: P<n> run <id> verdict <clean|failed> — <url>`. `<workspace>/phase-<n>-report.md` gets a `## Validation: run <id> verdict <verdict>` section holding the compare output, or `conclusion: <conclusion>` without a compare. `validate` prints the ledger line and `report: <path>`.

**Exit codes.** 0 `clean`; 6 `failed`; 3 refused (no validation declared, no stack state, local mode, phase not submitted or ready, no completed run yet); 2 usage, malformed plan or no such phase; 5 a gh command failed; 1 any other failure.

**The fix loop.** On `failed`, read the report, then fix on the phase's branch:

1. Check out the submitted phase branch.
2. Make a plain commit with the fix (never an amend, never a force push).
3. `node scripts/stack.mjs push PLAN_FILE N`, then write `Validation fix: P<n> <sha> — <finding>` to the ledger.
4. Wait for the new run and call `validate` again.

In the `stack` layout, `push` runs `gh stack submit --auto` over every member of the stack, so fix only the top phase of a `stack` stack. The `prs` layout pushes one branch, fast-forward only, so any phase can be fixed.
