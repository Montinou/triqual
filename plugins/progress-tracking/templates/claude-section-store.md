<!-- progress-tracking:start (managed by /progress-tracking:progress-init; do not edit by hand) -->
## Progress tracking (strict, mandatory, store mode)

Tracking lives in the local tracking store, never in the working tree (skill `progress-tracking:progress-tracking`):
no `progress.md`, `status.md` or task ledger file is committed, and specs and plans go to the store's documents
directory.

- **Entries**: one per task, added when **each** task finishes. A task that ends in a commit lands its entry
  *before* that commit with `triqual tracking add <draft>`; the entry stays pending for this worktree until the
  commit stamps it. A task that ends with no commit (a review, a ruling, a status-only step, a spec or plan
  registration, the plan's close, a production operation) lands it with `triqual tracking add <draft> --no-commit`:
  a pending entry left behind would be stamped onto the next, unrelated commit and let it past the gate.
  `--corrects <id>` adds a correction.
- **Status**: read with `triqual tracking status`, and change one section with
  `triqual tracking status set --section <heading> <draft>`. The whole-file `triqual tracking status set <draft>` is
  only for a full rewrite or a new section.
- **Views**: `triqual tracking status` and `triqual tracking log [--last N]`.

A "task" is a plan task, a review fix round, a rollout operation (migration, deploy, env var) or any requested
change. Subagents too: a task is not finished until its entry is in the store.

Entry draft (markdown, or JSON with the keys `title`, `stage_task`, `done`, `files`, `verification`, `next`):

```markdown
## YYYY-MM-DD — <short title>
- **Stage/task:** <e.g. Plan x · T3, or "off-plan">
- **Done:** <what changed and why>
- **Files:** <main paths>
- **Verification:** <commands and real results>
- **Next:** <next concrete step>
```

Specs and plans: draft them in a `mktemp -d` directory under their final name and land them with
`triqual tracking write spec|plan <draft>` (a plan's task ledger is initialised in the store); never put them in the
working tree. Move tasks only with `triqual tasks start|review|rework|done|block|drop|close --plan <plan file name>`
(the bare name, never the docs-dir path), and run `triqual tasks check` to find drift (it takes no `--plan`). No
tracking file is ever staged or committed. Details: `store-mode.md` under `references` in skill
`progress-tracking:progress-tracking`.

An entry is never edited: a correction is a new entry. Results are the real ones.
Enforced by the store's git `pre-commit` (rejects a commit with changes when this worktree has no pending entry;
`--no-verify` is forbidden), its `post-commit` (stamps the entries with the commit) and the plugin hooks (Stop: a turn
with changes does not end without a pending entry; SessionStart: injects the state).
<!-- progress-tracking:end -->
