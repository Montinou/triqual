<!-- progress-tracking:start (managed by /progress-tracking:progress-init; do not edit by hand) -->
## Progress tracking (strict, mandatory)

Two files at the root, always up to date (skill `progress-tracking:progress-tracking`):

- **`progress.md`**: append-only log, one entry per task, newest **on top**. Add the entry when **each** task
  finishes, in the same commit that closes it.
- **`status.md`**: snapshot of the overall state, edited in place around the generated Active plan section; never
  rewrite the file whole. Updated in that same commit.

A "task" is a plan task, a review fix round, a rollout operation (migration, deploy, env var) or any requested
change. Subagents too: a task is not finished until its entry is in `progress.md`.

Entry format:

```markdown
## YYYY-MM-DD — <short title>
- **Stage/task:** <e.g. Plan x · T3, or "off-plan">
- **Done:** <what changed and why>
- **Files:** <main paths>
- **Verification:** <commands and real results>
- **Commit:** <short sha, or "this commit">
- **Next:** <next concrete step>
```

Task ledger: each plan in `docs/plans/` has a `<plan>.tasks.json` ledger, rendered into a section of `status.md`.
Move tasks only with `triqual tasks start|review|rework|done|block|drop|close` (get paths from `triqual tasks paths --json`);
never edit the ledger or that section by hand, and run `triqual tasks check` to find drift.

A committed entry is never edited: a correction is a new entry. Results are the real ones.
Enforced by a git `pre-commit` (rejects a commit with changes unless both files are staged; `--no-verify` is forbidden)
and the plugin hooks (Stop: a turn with changes does not end without `progress.md`; SessionStart: injects the state).
<!-- progress-tracking:end -->
