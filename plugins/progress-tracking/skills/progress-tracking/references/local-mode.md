# Local mode in detail

`triqual progress-init --local` opts a shared repo in without committing anything: the tracking files live in
`<git-common-dir>/methodology/` (usually `.git/methodology/`, shared by every worktree):

- `progress.md`, `status.md`, `plans/` (plans and their `*.tasks.json` ledgers), `specs/`, `state.json`
- nothing goes in the working tree or in git, and nothing survives a re-clone
- plans and specs go in that `plans/` and `specs/`, never `docs/`: take the dirs from `triqual tasks paths --json`

## Writing the files: `triqual tracking write`

Claude Code treats everything under `.git/` as a sensitive file: an agent's Edit or Write there is refused, and so
is a shell redirect into it, even in `acceptEdits`. A program that writes the file itself is allowed when its command
is. Reading there works. So never write or edit under `.git/` with the file tools; write a draft in the OS temp dir
under a unique name (run `mktemp` on its own; the path it prints is the draft), then land it:

| Command | What it does |
|---|---|
| `triqual tracking write entry <draft>` | The draft is one entry, starting `## <YYYY-MM-DD> — <title>` on its first line; a second dated heading is refused. It goes above the newest entry (the file's header block stays on top). |
| `triqual tracking write status <draft>` | The draft is the whole new `status.md`: copy the current file to the draft, edit it, land it. The managed tasks section is kept, re-rendered from the ledgers (the draft's own copy of it, if any, is replaced). |
| `triqual tracking write spec <draft>` | Copies the draft to `specs/` under its own name. An existing spec is refused; `--replace` overwrites it. |
| `triqual tracking write plan <draft>` | The same as `triqual tasks init --adopt <draft>`: copies the plan into `plans/` and creates its ledger. An existing plan is refused; `--replace` overwrites it and reconciles the ledger. |

- Every write is atomic and runs under the same lock as the `triqual tasks` moves (`tasks.lock` in that directory), so
  parallel sessions never lose an entry.
- It prints the path it wrote (for `plan`, then the `triqual tasks init` message) and exits 0; exit 2 means bad
  arguments, a draft it cannot read or refuses, a repo that is not opted in, or a lock it could not take.
- It works in committed mode too, but there the file tools are enough.
- Bootstrap offers the allow rule `Bash(triqual tracking:*)` for `~/.claude/settings.json`, so the command runs
  without a permission prompt; it asks first (or takes `--yes`) and backs the file up. An existing narrower
  `Bash(triqual tracking write:*)` rule is kept, and `Bash(triqual:*)` already there covers it.
- `status` renders the tasks section from every ledger: an unreadable ledger refuses the write, naming the file; fix it
  first.
- `triqual tasks` moves and `triqual tasks render` write the ledgers and the tasks section themselves: nothing to draft.

## Gates

- Gates compare against the **last gated commit**: `state.json` holds its `progress.md` hash.
- The local `pre-commit` refuses staged changes unless `progress.md` changed since then. The `post-commit` promotes
  the new hash once the commit lands, so an aborted commit consumes no entry. One new entry per commit; no gate checks
  `status.md`.
- Local mode commits neither file: write both before the commit that closes the task.
- The Stop hook blocks while anything is dirty and `progress.md` has not changed since the last gated commit. Its
  message names `triqual tracking write entry <draft>`. It blocks once per change set in a session.
- With `core.hooksPath` set (husky, say) no hook is installed and commits are not gated: Stop checks for an entry
  newer than the last commit instead.

## Removing it

`triqual progress-init --local --remove` permanently deletes that directory (log, plans and specs, which no commit holds)
and the chained hook lines: always confirm with the user first.

Store mode is the alternative for a repository whose history must not carry tracking: the entries, status and ledgers live in a local database instead of `.git/methodology/`, see [store-mode.md](store-mode.md).
