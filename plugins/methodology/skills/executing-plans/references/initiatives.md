## Initiatives: several plans, the loop after submit, and resuming

An initiative is a set of plans run side by side or one after another, each with its own phases. The pieces here are how the plans share a repository, what happens to a phase after `submit`, how a stopped phase is picked up again, and the ledger lines that bookkeeping adds.

### Several plans

- **One clone per running plan.** Each running plan works in its own clone of the work repository: its own checkout, its own `.methodology/` workspace and stack state, its own phase branches. Two plans never share a checkout, because a script reads `HEAD`, the tree and the workspace of the checkout it runs in.
- **One tracking root.** The clones are not opted in to tracking. Export `TRIQUAL_TRACKING_ROOT=<path of the coordination repository>` in the shell that runs a plan's scripts: `triqual tasks …` and `triqual tracking …` then resolve tracking from that repository, and the commits made in the clone are recorded as external commits. The variable is only for the scripts: the git hooks and the plugin hooks never read it, so keep it out of a shell where you commit in the coordination repository itself.
- **Cross-plan parents.** A phase's `**Parent:**` may name a branch of another plan (a phase branch of that plan, pushed to the remote). The phase starts at that branch, and `submit` needs it on the remote. It is merged after its parent, as in a forest (`forest.md`).

### The loop after submit

A submitted phase is final: never amend it, never rebase it, never force push it. When the phase declares `**Validate:**`:

1. `node scripts/stack.mjs submit PLAN_FILE N` publishes the phase.
2. `node scripts/validate PLAN_FILE N` records the CI verdict of the pushed head (`Validation: P<n> run <id> verdict <clean|failed> — <url>`, and a section in `<workspace>/phase-<n>-report.md`). Exit 3 with `no completed run … yet` means wait and run it again.
3. On `failed`, read the report and fix on the phase's branch with a plain commit (never `--fixup`, never an amend).
4. `node scripts/stack.mjs push PLAN_FILE N` pushes it and refreshes the PR; ledger `Validation fix: P<n> <sha> — <finding>`.
5. `node scripts/validate PLAN_FILE N` again, once the new run has completed. The loop ends on `clean`.

`validation.md` has the field, the verdicts and the exit codes.

### Resuming a phase

`node scripts/phase-resume PLAN_FILE N` rebuilds where phase N stopped, from the workspace ledger and the stack state, and writes nothing. It prints:

- `# Resume P<n> <branch> (<state>)`, the state being the phase's state in the stack state (`no stack state` without one);
- a table `Task | State | Evidence`, one row per task of the phase. A task is `complete`, `running (BASE <sha7>)` (its last `Prep:` and fix round are the evidence), `blocked` (the breaker's `Task <N>: blocked at fix round` line is the last word: no `Task <N>: Ruling:` or `Ruling: human granted … for T<N>` line follows it, and the Next line asks your human partner for the decision instead of continuing the task), `awaiting landing`, `landed, not closed`, `undone — re-run sequential` or `not started`;
- `## Validations`: the phase's `Validation:` and `Validation fix:` ledger lines, copied as they are;
- `## Next`: the first applicable action, by the first task that is not complete (open it, continue it, ask for the decision on a blocked one, land it, close it, re-run it sequentially) and, with every task complete, by the phase review (a phase done in the stack state with no `Phase review: P<n>` line still gets it), the stack state and the validations. The seams review is named only in a plan with several phases.

It exits 3 when the plan has no ledger. Its output is the resume note of a fresh orchestrator: pass it as it is, with the plan path and the phase number.

### Ledger vocabulary

- `Validation: P<n> run <id> verdict <clean|failed> — <url>` (written by `validate`)
- `Validation fix: P<n> <sha> — <finding>` (written by the controller after the plain fix commit is pushed)
- `Phase fix: P<n> round <k> <sha> — <findings>` (one per round of the phase fix loop, `<sha>` the round's commit)
- `Ruling: candidate <id> confirmed without a reviewer round — <why>` (a hunter candidate the controller confirms itself, with the reason a reviewer round is not needed)
- `<workspace>/phase-<n>-report.md` is the one report file of phase `<n>`: every fix round of the phase and every `validate` run appends a section to it.
