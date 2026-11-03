## Child repositories

A plan can be executed in a plain clone that is not opted in to progress tracking, with the plan, its ledger and the entries kept in a coordination root (a repository in store mode). The clone gets the commits; the root gets the record.

**The variable.** `TRIQUAL_TRACKING_ROOT=<path of the coordination root>` makes `triqual tasks …` and `triqual tracking …` resolve the tracking from that root while the working directory is the clone. `task-open`, `task-prep`, `task-close` and `stack.mjs` need no other change: they call `triqual` and it resolves the root. Export it in the shell that runs the plan, or put it in front of each call.

- The root must be a git repository in store mode. A root that is not a repository or not opted in is exit 2 naming the variable; nothing falls back to the clone.
- Only `triqual tasks …` and `triqual tracking …` read the variable. `triqual tracking hook …`, the git hooks and the plugin hooks never do, so a commit in the root behaves the same with the variable exported or not.
- Register the plan in the root (`triqual tracking write plan <draft>`, run in the root) and pass the plan's path in the root's documents directory (`triqual tasks paths --json`, `plansDir`) as PLAN_FILE.

**Clone setup.** The clone is an ordinary repository:

- A local git identity (`git config --local user.name`, `git config --local user.email`), because the clone has no global one the run can rely on.
- Never `progress-init` in the clone: no hooks, no `triqual.tracking` marker, no `progress.md`, no `status.md`, no ledger file. `git status` in the clone stays clean; the sdd workspace is `.methodology/`, which ignores itself.
- Run the scripts from the clone's main checkout, `stack.mjs init PLAN_FILE --mode local` then `stack.mjs phase PLAN_FILE <N>`, as in any plan. The phase branches and the one commit per task are the clone's.

**The `ext:` records.** A commit of the clone is not a commit of the root, so the root never stores its bare sha:

- `triqual tasks done T<N> --commit <rev>` run from the clone (task-close does) records `ext:<the clone's path relative to the root's main worktree>@<full sha>` (a clone beside the root is `ext:` followed by `..`, a slash, the clone's directory name, `@` and the sha). `--repo <path>` names another repository the same way and wins over the cwd.
- `triqual tracking add <draft> --commit <rev>` run from the clone stores the same string as the entry's commit. From the clone, `add` needs `--commit` or `--no-commit`; a bare `add` is exit 2, since a pending entry waits for a commit of the root.
- A revision that does not resolve in the clone is refused, with the root's own commits never consulted.
- No home-directory path enters a ledger or an entry: the path is relative to the root.

**Reading the result.** `triqual tasks status` and `triqual tracking log`, run in the root or in the clone with the variable, show the task `done` and the entry with its `ext:` commit. Tools that expect 40 hex characters in a commit field must treat an `ext:` value as a reference to another repository.
