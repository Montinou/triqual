# progress-tracking

Strict progress tracking for a repo: one log entry per task, one status snapshot, and one task ledger per plan.
Hooks and a git `pre-commit` refuse work that is not recorded.

This is the reference for the plugin. The [root README](../../README.md) has the overview, the install steps and the
one-line command table. The agent-facing rules are in the
[`progress-tracking` skill](skills/progress-tracking/SKILL.md).

## What it ships

| Part | What it is |
|---|---|
| Skill `progress-tracking:progress-tracking` | The rules: what a task is, the entry format, when `status.md` changes, how the ledger moves. See [`SKILL.md`](skills/progress-tracking/SKILL.md), [`local-mode.md`](skills/progress-tracking/references/local-mode.md) and [`store-mode.md`](skills/progress-tracking/references/store-mode.md). |
| Command `/progress-tracking:progress-init` | Opts the current repo in. It runs the same script as `triqual progress-init`. |
| CLI `triqual progress-init` | The installer (`scripts/init.mjs`). |
| CLI `triqual tasks` | The task ledger (`cli/tasks.mjs`). |
| CLI `triqual tracking` | Writes and reads entries, status and documents; moves data in and out of the store; runs the store git hooks (`cli/tracking.mjs`). |
| CLI `triqual ui` | A local, read-only dashboard (`cli/ui.mjs`). |
| Claude Code hooks | `SessionStart` and `Stop` (`hooks/hooks.json`, `scripts/gate.mjs`). |
| Git hooks | Installed per repo by `progress-init`; one set for each mode. |

The `triqual` command is a shim that finds the installed plugin and runs the script. Without it on `PATH`, run the
script directly, for example `node "${CLAUDE_PLUGIN_ROOT}/cli/tasks.mjs" <subcommand>`. The shim exits 3 when the
plugin or the command is not installed.

Every command takes `--help` or `-h`: it prints the usage, exits 0 and does nothing else. The hooks and the commands
act only in an opted-in repo.

## Modes

A repo is in one mode: committed, local or store. Store mode needs Node 22.13 or newer. The other two never load
SQLite. The root README has the [table of modes](../../README.md#tracking-modes), the
[store mode](../../README.md#store-mode) overview and
[local mode and the git directory](../../README.md#local-mode-and-the-git-directory).

| Mode | Opt in with | Where the tracking lives |
|---|---|---|
| committed | `triqual progress-init` | `progress.md`, `status.md` and `docs/plans/*.tasks.json` in the working tree |
| local | `triqual progress-init --local` | the same files under `<git-common-dir>/methodology/` |
| store | `triqual progress-init --store` | a SQLite database under `~/.local/share/triqual/` |

How the mode is decided, in order:

1. If `git config --local triqual.tracking` is `store`, the repo is in store mode. The marker wins over both file
   roots and is read without opening the database.
2. Else, if `progress.md` exists at the repo root, it is committed mode.
3. Else, if `progress.md` exists under `<git-common-dir>/methodology/`, it is local mode.
4. Else the repo is not opted in.

The match on `progress.md` is by exact name. `PROGRESS.md` does not count.

## Commands

Exit codes for each command are listed with it. A bad flag or a wrong argument prints the usage and exits 2.

### `triqual progress-init`

```text
triqual progress-init [--local [--remove]]
triqual progress-init --store [--accept-unparsed]
```

Run it from inside the repo. It prints a JSON report for the caller to relay. It is idempotent: a second run changes
nothing.

| Flag | Meaning |
|---|---|
| none | Committed mode. |
| `--local` | Local mode. Nothing is written in the working tree. |
| `--remove` | Only with `--local`. Deletes `<git-common-dir>/methodology/` for good and unchains the local hook lines. Refused in a store repo. |
| `--store` | Switch to store mode. Works for a fresh repo and for a committed or local one. |
| `--accept-unparsed` | Only with `--store`. Imports entries that cannot be parsed, flagged with their original text. |
| `--help`, `-h` | Print the usage. |

`--store` cannot be combined with `--local` or `--remove`.

What each form does:

- **Committed.** Creates `progress.md` and `status.md` when missing and never overwrites them. Writes the managed
  section (`<!-- progress-tracking:start` ... `<!-- progress-tracking:end -->`) into `CLAUDE.md`, and into an
  existing `AGENTS.md`. It never creates `AGENTS.md`. Writes `progress-gate.sh` and chains it into `pre-commit`
  once. The hook goes in an existing `core.hooksPath`, else in an existing unversioned `.git/hooks/pre-commit`, else
  in a new `.githooks/`, and in that last case it sets `core.hooksPath`.
- **Local.** Creates `progress.md`, `status.md`, `plans/` and `specs/` under `<git-common-dir>/methodology/`, writes
  the gate `pre-commit.mjs` there, and chains a `pre-commit` and a `post-commit` line into
  `<git-common-dir>/hooks/`. When `core.hooksPath` is set it installs no hook and says so in `notes`.
- **Store.** In this order, so a rerun can always finish:
  1. imports the tracking files into the database;
  2. writes `progress-store-pre-commit.sh` and `progress-store-post-commit.sh` into the hooks directory and chains
     them into `pre-commit` and `post-commit`;
  3. records the mode it came from once in `git config --local triqual.trackingFrom` (`committed`, `local` or
     `none`), sets the marker `triqual.tracking`, and registers the repo;
  4. removes the local-mode hook lines and the `progress-gate.sh` chain;
  5. rewrites the managed `CLAUDE.md` section with the store text (and an existing `AGENTS.md`'s). A repo switched
     from local mode writes no `CLAUDE.md`;
  6. deletes the ledgers, `status.md` and `progress.md` from the working tree.

  It prints the commit that records the switch (`commit.paths` and `commit.steps`) and never stages or commits. The
  first step is `triqual tracking add <draft>`, because the store `pre-commit` refuses a commit without a pending
  entry. A repo switched from local mode has nothing in its tree, so it has no switch commit.

Store refusals (exit 1, nothing changed):

- a local-mode repo whose hooks directory is inside a working tree (a versioned `core.hooksPath`); it stays local;
- a `pre-commit` or `post-commit` that is not a shell script;
- another branch or worktree holds entries or ledger moves the database does not; import them first with
  `triqual tracking import --ref <branch>`;
- entries that cannot be parsed, unless `--accept-unparsed`.

It only warns when a branch's sole tracking change is `status.md` sections or ledger metadata (titles, roles, deps).
The order of the switch and the per-worktree case are in
[`store-mode.md`](skills/progress-tracking/references/store-mode.md).

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Done, or `--help`. |
| 1 | Not inside a git repo; a store refusal; `--local --remove` in a store repo. |
| 2 | Bad arguments; the repo already uses the other mode; plain or `--local` init in a store repo; `PROGRESS.md` or `STATUS.md` that differs from the exact name only in case. |

### `triqual tasks`

```text
triqual tasks <subcommand> [args]
  init <plan.md> [--adopt] [--spec <path>] [--branch <b>]
  start|review|rework|restore T<N> [--plan <plan.md|ledger>]
  done T<N> --commit <sha> [--repo <path>] [--plan <plan.md|ledger>]
  block|drop|reopen T<N> "<reason>" [--plan <plan.md|ledger>]
  retitle T<N> "<title>" [--plan <plan.md|ledger>]
  retier T<N> <tier> --reason "<text>" [--plan <plan.md|ledger>]
  close [--plan <plan.md|ledger>]
  status [--json]
  next [--plan <plan.md|ledger>] [--json]
  check [--staged]
  render
  paths --json
  export --json [--all]
  line
```

A plan is a Markdown file. Each task starts at a `### Task <N>: <title>` heading and is named `T<N>`. Below the
heading, these lines are read at column 0: `**Tier:**`, `**Depends on:**` (comma-separated task ids), `**Skills:**` and
`**Role:**`. Headings inside fenced code blocks are ignored. A task ends at the next heading of level 1 to 3 outside a
fence, so a field under `## After Merge` does not belong to the last task. A duplicate task number or an unclosed
fence is an error. The reader is a library (`lib/plan.mjs`) shared with the orchestrator's scripts; there is no
subcommand that prints the parsed tasks.

A task's role is its `**Role:**` line, one of `coordinator`, `roles:tdd-implementer` (the default),
`roles:complex-implementer` or `roles:review-fixer`. `check` flags any other. Plans written for 1.0 never name
`roles:review-fixer`: the orchestrator dispatches it for fix rounds.

#### Tiers

A task's review tier is its `**Tier:**` line, one of `heavy`, `standard` or `light`. An unknown value is an error.

- **Reading never fails on a missing tier.** A task with no `**Tier:**` has `tier: null` and is treated as `standard`,
  so plans and ledgers written before tiers keep working.
- **Registering a new plan is all or none.** When the plan declares a tier on any task it must declare one on every
  task: `init` (and `tracking write plan` and `--adopt`) exit 2 naming the tasks without one. In a tiered plan a
  `coordinator` task must be `light` and a `roles:complex-implementer` task `heavy`. A plan with no tier registers as it
  always did. Reconciling an existing ledger applies none of these rules.
- **Declared and effective.** The ledger keeps each task's declared `tier` and its `effectiveTier`, the tier it runs at.
  Reconciling copies a changed tier into pending tasks, and their effective tier becomes the higher of the old one and
  the new one.
- **`retier T<N> <tier> --reason "<text>"`** raises the effective tier and logs the reason in the task's history. The
  same tier prints `T<N>: already <tier>` and exits 0. A lower tier exits 2: no command lowers a tier. The reason is
  required.
- **Where tiers show.** `status` and `tasks line` show the effective tier, `status --json` and `next --json` carry both
  tiers, and `export --json` carries them for every task.

Task statuses are `pending`, `in_progress`, `in_review`, `done`, `blocked` and `dropped`. Each move starts from fixed
statuses:

| Subcommand | From | To |
|---|---|---|
| `start` | pending, blocked | in_progress |
| `review` | in_progress | in_review |
| `rework` | in_review | in_progress |
| `done` | in_progress, in_review | done |
| `block` | pending, in_progress, in_review | blocked |
| `drop` | pending, blocked | dropped |
| `restore` | dropped | pending |
| `reopen` | done | in_progress |

`start` also needs every dependency done or dropped.

With more than one active ledger, `--plan` picks one. In committed and local mode it takes the plan `.md`, the
`.tasks.json` ledger, or a path to either; the ledger must sit directly in the plans directory. In store mode it takes
the plan's bare file name with or without `.md`, a path to it, or its stored path.

#### `init`

`triqual tasks init <plan.md>` creates the ledger for a plan, or reconciles it when one exists.

- Creating records the plan path, the spec (`--spec <path>`, else none), the branch (`--branch <b>`, else the current
  branch) and every task as `pending`.
- Reconciling appends tasks that are new in the plan, reports tasks no longer in the plan (kept) and tasks whose
  title changed (left alone), and gives pending tasks the plan's dependencies, skills and role. Adding a task
  reactivates a closed plan. Run it again after editing a plan.
- `init` refuses a dependency on a task that neither the plan nor the existing ledger has.
- `--adopt` first copies a plan drafted anywhere into the plans directory under its own name. It refuses a plan of
  that name that already exists, and removes its copy if a later step fails. Without `--adopt` the plan must already
  sit in the plans directory.

It prints `created <ledger>` or `reconciled <ledger>: added ...; missing ...; retitled ...`.

#### Transitions

- `start`, `review`, `rework` and `restore` take a task id.
- `done T<N> --commit <rev>` records the commit. `<rev>` is any revision (`HEAD` works). It is resolved to a full sha;
  one that does not name a commit is an error. `--repo <path>` records a commit of another repository, stored as
  `ext:<path relative to the main worktree root>@<sha>`, so no home directory enters a ledger; it needs `--commit`,
  and a path that is this repository counts as a local commit. Repeating `done` with the same commit is a no-op. `done` on a done
  task with a different sha exits 2: `reopen` it, then `done` again to replace the sha.
- `block`, `drop` and `reopen` take a non-empty reason. `start` resumes a blocked task and `restore` brings a dropped
  one back as pending.
- `retitle T<N> "<title>"` changes a task's title and logs it in the task history.
- `retier T<N> <tier> --reason "<text>"` raises a task's effective tier. See [Tiers](#tiers). It prints
  `T<N>: <from> -> <to>` and does not move the task's status.
- `close` ends the plan. It exits 2 while any task is not done or dropped. When every ledger is already done it
  prints `plan: already done` and exits 0.

Repeating any other transition prints `T<N>: already <status>`, changes nothing and exits 0.

Each move prints one line, `T<N>: <from> -> <to>`.

#### Views

| Subcommand | What it does |
|---|---|
| `status [--json]` | One line per active plan, newest name first: `<name>: <done>/<total> done · in progress: <ids> · next: <id>`, each id followed by its effective tier in brackets when it has one. `--json` gives `name`, `ledgerPath`, `done`, `total`, `inProgress`, `next` and `tiers`, a map keyed by task id with the `tier` and `effectiveTier` of the in-progress tasks and the next one. Dropped tasks are not counted in `total`. |
| `next [--plan ...] [--json]` | The first pending task whose dependencies are all done or dropped, as `T<N> <title> [<role>]`, or `none`. `--json` prints `{ id, title, role, tier, effectiveTier }`, or `null` when there is none. |
| `check [--staged]` | Compares each ledger with its plan and the `status.md` Active plan section (task titles, roles, dependencies, commits that still resolve, the rendered section, the ledger schema). Prints one line per drift. `--staged` reads the index instead of the working tree in committed mode, and is accepted and ignored in the other modes. It takes no `--plan`. In store mode it compares each plan whose document exists, and there is no section to drift. |
| `render` | Rewrites the Active plan section of `status.md`, between `<!-- tasks:start -->` and `<!-- tasks:end -->`. In store mode there is no `status.md`: it prints the section instead. |
| `paths --json` | The tracking paths. Works outside an opted-in repo: `"optedIn": false`, exit 0. |
| `export --json [--all]` | The tracking snapshot of this repo (schema `tracking-snapshot@1`, under the previous name), with `tier` and `effectiveTier` for every task. `--all` prints an array with the snapshot of every registered repo that still resolves, from any directory, and skips a failing repo with a warning. |
| `line` | One status-line segment. See below. |

`paths --json` always carries `notOptedInMessage` and `localHookLines`. In committed and local mode it also has
`mode`, `root`, `progress`, `status`, `plansDir`, `specsDir` and `duplicate`. In store mode it has `"mode": "store"`,
`root`, `store` (the database path), `plansDir` and `specsDir`, and no `progress` or `status` key. `store`, `plansDir`
and `specsDir` are `null` when the store is disabled.

#### `line`

```text
▸ <name> <done>/<total> · <current>
```

For the newest active plan, with ` (+<n-1>)` appended when more than one plan is active. `<current>` is, in order:

1. the first in-progress task, as `T<N> [<tier>] (<role>)`, with `roles:` removed from the role and the effective tier
   in brackets (left out when the task has none);
2. else the first in-review task, as `T<N> [<tier>] (<role>) review`;
3. else the next pending task, as `T<N> [<tier>] (<role>)`;
4. else the first blocked task, as `T<N> [<tier>] (<role>) blocked`;
5. else `done` when every counted task is done, otherwise `stalled`.

`line` is read-only and silent, so a status line can call it on every refresh. It prints nothing and exits 0 outside
an opted-in repo, with no active plan, with extra arguments, or on any error. Nothing reaches stderr. A usage snippet
is in the root README under [Status line](../../README.md#status-line).

#### Locking and exit codes

Every subcommand that writes runs under a lock on the tracking root. See [Files and environment
variables](#files-and-environment-variables). A lock timeout exits 2.

| Code | Meaning |
|---|---|
| 0 | Success, `--help`, any `line`. |
| 1 | Only `check`, when it finds drift. |
| 2 | An invalid transition, bad arguments, an ambiguous ledger (several active, no `--plan`), a repo that is not opted in (except `paths --json`, and `export --json --all`), or a lock timeout. |
| 3 | From the `triqual` shim only: the plugin is not installed. |

### `triqual tracking`

```text
triqual tracking write <entry|status|spec|plan> <draft> [--replace]
triqual tracking add <draft> [--no-commit | --commit <rev>] [--corrects <id>]
triqual tracking status [--json]
triqual tracking status set [--section <heading>] <draft>
triqual tracking log [--last N] [--plan <name>] [--since <YYYY-MM-DD>] [--grep <text>] [--json]
triqual tracking import [--ref <branch>] [--accept-unparsed] [--replace [--from <jsonl>]]
triqual tracking export [--out <file>]
triqual tracking restore <snapshot> [--yes]
triqual tracking relocate <old-root>
triqual tracking hook pre-commit|post-commit
```

A draft is a file written anywhere. In local mode it lives in the OS temp directory, because Claude Code refuses an
agent's file writes under `.git/`. A flag given to a subcommand that does not take it is a usage error (exit 2).

Exit codes for the whole command:

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | `import` stopped on an unparsable entry; `restore` was cancelled at the prompt; the store `pre-commit` hook refused a commit. |
| 2 | Usage error; a refused draft; a repo that is not opted in; not in store mode for `add`, `status` and `log`; a store or lock failure; any other failure. |
| 3 | `relocate` refused. |

`restore`, `relocate` and `hook` run before the repo is resolved, so `restore` works outside any repo.

#### `write`

```text
triqual tracking write <entry|status|spec|plan> <draft> [--replace]
```

Lands a tracking file drafted anywhere. Works in every mode. It prints the written path (for `plan`, then the
`triqual tasks init` message).

| Kind | Committed and local | Store |
|---|---|---|
| `entry` | The draft is one entry and goes above the newest in `progress.md`. A draft that does not start with `## <YYYY-MM-DD> — `, or that has a second dated heading, is refused. | Same as `add`. |
| `status` | The draft is the whole `status.md`. The tasks section is re-rendered from the ledgers in place of the draft's own, or appended when the draft has none. An unreadable ledger refuses the write, naming the file. | Same as `status set`. |
| `spec` | Copies the draft into the specs directory under its own file name. | Same, into the repo's documents directory. |
| `plan` | The same as `triqual tasks init --adopt <draft>`. | The same, with the ledger in the database. |

`--replace` is only for `spec` and `plan`. It overwrites an existing document, and for a plan it reconciles the
ledger. Without it an existing document is refused.

In committed and local mode every write is atomic and runs under the tracking root's lock. In store mode entries and
status are written in database transactions. Only `plan` also takes the lock in the documents directory.

#### `add`

```text
triqual tracking add <draft> [--no-commit | --commit <rev>] [--corrects <id>]
```

Store mode only. Adds one entry and prints `entry <id>`.

| Flag | Meaning |
|---|---|
| none | The entry is `pending` for this worktree. The store `pre-commit` needs one, and the `post-commit` hook stamps it with the commit. Land it before the commit it describes. |
| `--no-commit` | For a task that ends without a commit. The entry is recorded as `no_commit`, never pending. A pending entry left behind would be stamped onto the next, unrelated commit. |
| `--commit <rev>` | Records an entry for a commit that already exists. `<rev>` must name a commit of this repo. |
| `--corrects <id>` | Marks the entry as a correction of entry `<id>`, a positive integer id of an entry in this repo. |

`--no-commit` and `--commit` exclude each other. The draft is parsed strictly. See [Entry draft
format](#entry-draft-format). Entries are never edited: a correction is a new entry.

Exits 2 outside store mode, with `not in store mode: run triqual progress-init --store`.

#### `status`

```text
triqual tracking status [--json]
triqual tracking status set [--section <heading>] <draft>
```

Store mode only.

- `status` prints the stored sections in order, then the Active plan section between its
  `<!-- tasks:start -->` and `<!-- tasks:end -->` markers, so a read, edited and set back is a round trip. The Active
  plan section is rendered live from the ledgers. `--json` gives `{ sections, plans, text }`. It is read-only.
- `status set <draft>` replaces the whole stored status. Use it for a full rewrite or a new section. An `Active plan`
  section in the draft is dropped, with a note on stderr.
- `status set --section <heading> <draft>` replaces one section. A leading `## ` on the heading is stripped. The
  draft may be the body alone or the section with its `## <heading>` line. A heading that is not stored exits 2 and
  lists the stored sections.

It prints `status <n> sections` or `status section <heading>`.

#### `log`

```text
triqual tracking log [--last N] [--plan <name>] [--since <YYYY-MM-DD>] [--grep <text>] [--json]
```

Store mode only, read-only. Lists entries newest first, as `progress.md` blocks.

| Flag | Meaning |
|---|---|
| `--last N` | How many entries. A positive integer. Default 10. |
| `--plan <name>` | Entries whose Stage/task names that plan (`Plan <name> · T<N>`). |
| `--since <date>` | Entries from that date on. A real calendar date as `YYYY-MM-DD`. |
| `--grep <text>` | Entries that contain the text. |
| `--json` | An array of rows. Only the JSON shows an entry's `state` (`pending`, `committed`, `no_commit` or `unresolved`) and `commit_sha`. |

A bad `--last` or `--since` exits 2. A repo the database has no row for reads as empty.

#### `import`

```text
triqual tracking import [--ref <branch>] [--accept-unparsed] [--replace [--from <jsonl>]]
```

Moves tracking files into the database. It needs an opted-in repo, in any mode. Without `--ref` it reads the working
tree, or the local-mode files. With `--ref` it reads a branch's entries and ledgers, and only reports its status
differences. Imports are idempotent: an entry already present (same text) is not added twice, and ledgers merge per
task by the latest history time, so a newer state is never overwritten. In committed mode an entry's commit is the
first commit that added its heading.

| Flag | Meaning |
|---|---|
| `--ref <branch>` | Read a branch instead of the working tree. |
| `--accept-unparsed` | Import entries that cannot be parsed, flagged with their original text. Without it, one such entry stops the import: exit 1 and nothing is written. |
| `--replace` | Wipe the repo's rows first and rebuild them. |
| `--from <jsonl>` | Rebuild from an export file. Needs `--replace`. |

`--ref` and `--replace` exclude each other. In store mode `--replace` needs `--from`, because a store repo has no
tracking files to rebuild from: without it the command exits 2.

It prints a summary of what was added, promoted and left unparsed, then the plan and task counts.

#### `export`

```text
triqual tracking export [--out <file>]
```

Writes the repo's rows as JSONL, one `{"table", "row"}` object per line. To stdout, or to a file with mode 0600 whose
path it prints. It is the off-store copy: the database lives in one user directory and nothing in git holds it.
Rebuild from it with `triqual tracking import --replace --from <file>`. It needs an opted-in repo that the store has a
row for.

#### `restore`

```text
triqual tracking restore <snapshot> [--yes]
```

Replaces every row of the database with the snapshot's. This covers every repo in the database, not just the current
one. A snapshot is a `backups/tracking-<date>.db` file or any SQLite copy of the database. The snapshot must have the
current schema version and pass an integrity check, or the command exits 2 and keeps the database.

- On a terminal it asks first and wants `yes`. Without a terminal it needs `--yes`: it exits 2 without either, and
  exits 1 if the prompt is answered no.
- Before it replaces anything it saves the current database as `backups/pre-restore-<UTC stamp>.db`.
- When the database file is missing, it copies the snapshot into place with mode 0600. A write-ahead log left beside
  the missing database is first moved to `backups/orphan-wal-<stamp>.db-wal` and `.db-shm`.
- When the database file exists but does not open (unreadable, not SQLite), it checks the snapshot, moves the file and
  any `-wal` / `-shm` beside it to `backups/broken-<UTC stamp>.db`, prints that path, and restores as for a missing
  database. A bad snapshot is refused first, and the file stays where it was.
- The store gates name this command when the database fails.

#### `relocate`

```text
triqual tracking relocate <old-root>
```

Run it in the new checkout of a repo that moved (a new clone or a new remote), before `triqual progress-init --store`
there. It re-points the store row of `<old-root>` at this checkout. The row keeps its id, so every entry, plan, task
and document follows, and the documents directory `repos/<repo-key>/` is renamed to the new key.

Then it writes one off-plan entry that names both roots, recorded like `add --no-commit`; moves the registry entry;
saves a snapshot `backups/tracking-relocate-<timestamp>.db` after the move; and unsets the store marker in
`<old-root>` when that checkout is still there. It prints `relocated <old-root> -> <root>`, and
`unset the store marker in <old-root>` when it unset it.

It exits 3, with the reason and nothing changed, when:

- an entry of the repo is pending;
- a plan is not done;
- no store row has the root `<old-root>`;
- this checkout already has a row;
- several rows share the old root;
- the documents directory `repos/<new-key>` already exists.

It exits 2 on a usage error or outside a git checkout.

#### `hook`

```text
triqual tracking hook pre-commit
triqual tracking hook post-commit
```

Internal. The installed store git hooks call it. See [Hooks](#hooks). Outside store mode, `pre-commit` exits 2 and
`post-commit` exits 0.

### `triqual ui`

```text
triqual ui [--port N] [--open]
```

A local, read-only dashboard of every registered repo: plans with progress and tasks by status (blocked and dropped
reasons included), the `status.md` text, and the latest progress entries. It prints `triqual ui: <url>` and runs
until Ctrl-C.

| Flag | Meaning |
|---|---|
| `--port N` | Listen on port N, 0 to 65535. Default 0, a random free port. |
| `--open` | Also open the URL in the default browser. |

- It binds `127.0.0.1` only.
- It answers `GET /`, `GET /app.js` and `GET /api/snapshots`. A request with another method gets 405 and any other
  path gets 404.
- A `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`, a missing one included, gets 403. That guards
  against DNS rebinding.
- Every response carries `Content-Security-Policy: default-src 'self'` and `Cache-Control: no-store`.
- The page refreshes every 5 seconds while the tab is visible. Each refresh runs git in every registered repo, so a
  hidden tab stops polling.
- The snapshot of each repo carries up to 20 entries. The page shows the latest 5 per repo.
- A repo that no longer resolves, or whose snapshot fails (a store that cannot be read, say), is skipped.

Exit codes: 0 for `--help`, 2 for a bad argument, 1 if it cannot listen. Otherwise it runs until stopped.

## Hooks

### Claude Code hooks

Defined in `hooks/hooks.json`. Both run `scripts/gate.mjs` with a 15 second timeout. They are silent outside an
opted-in repo. A hook never breaks a session: any error ends it with exit 0 and no output. The exception is a gate
that fails closed on purpose (see below).

**SessionStart**, matcher `startup|resume|clear|compact`. Runs `gate.mjs session-start`.

- Registers the repo in `~/.config/triqual/repos.json`, silently.
- Injects `status.md`, the latest `progress.md` entry and one line per active plan. In store mode the same context
  comes from the database, read-only, and the latest entry is the newest one that is committed or written in this
  worktree. When the store cannot be read it injects a single notice line instead.
- The output stays under 9,500 characters. `--budget <n>` lowers that cap. `n` is an integer from 1000 to 9500, and
  any other value is ignored. `status.md` is truncated first, then the whole context. Codex and Grok use the budget
  to share one context with the methodology.

**Stop**. Runs `gate.mjs stop`. A turn with uncommitted work does not end unless the work is recorded. A block is a
JSON `{ "decision": "block", "reason": ... }` on stdout.

- Committed mode: blocks when a path that is not a tracking file is dirty and `progress.md` is not among the dirty
  paths. A turn with only tracking files dirty passes.
- Local mode: blocks when anything is dirty and `progress.md` has not changed since the last gated commit. With
  `core.hooksPath` set there is no git hook to record that commit, so `progress.md` must also be newer than the last
  commit. An unreadable `progress.md` or `state.json` blocks.
- Store mode: blocks when the worktree is dirty and has no pending entry. A store that cannot be read blocks too,
  naming the database, the error code and `triqual tracking restore`.
- A block fires once per change set per session. The same unrecorded changes pass the session's next stop and a new
  change blocks again. This needs a usable `session_id`. The state is a file in `$CLAUDE_PLUGIN_DATA`, else a
  `triqual/` folder in the OS temp directory, pruned after 7 days. A state directory inside the working tree is not used.
- A stop that continues a block (`stop_hook_active`) and a clean tree both pass.

### Git hooks

`progress-init` installs these in the repo. Never commit with `--no-verify`.

| Mode | Hook | Rule |
|---|---|---|
| committed | `pre-commit` runs `progress-gate.sh` | A commit with changes other than `progress.md`, `status.md` and `docs/plans/*.tasks.json` is rejected when either `progress.md` or `status.md` is not staged. The message names the missing one. A staged ledger must also pass `triqual tasks check --staged`; the check is skipped with a note when neither `triqual` nor `cm` is on `PATH`. |
| local | `pre-commit` and `post-commit` run `pre-commit.mjs` | A commit with staged changes needs `progress.md` to have changed since the last gated commit (`state.json` holds the hash). The `post-commit` promotes the new hash once the commit lands, so an aborted commit consumes no entry. No gate checks `status.md`. |
| store | `progress-store-pre-commit.sh` and `progress-store-post-commit.sh` | See below. |

Merges, cherry-picks, reverts and rebases pass every gate (the markers `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, `rebase-merge` and `rebase-apply`).

Store hooks:

- Each does nothing when `git config --local triqual.tracking` is not `store`, as in a clone of a public repo.
- Both call `triqual tracking hook <name>`. If `triqual` is not on `PATH`, the `pre-commit` refuses the commit
  (exit 1) and the `post-commit` skips quietly, leaving the entries pending.
- `pre-commit` passes a commit with nothing staged, or a merge or replay, and clears any stale handshake. A commit
  with staged changes passes only when this worktree has a pending entry. It records the tree being committed and the
  pending ids in `<git-dir>/triqual/commit-handshake.json`. A store failure refuses the commit.
- `post-commit` stamps those entries with `HEAD`, only when `git commit` made `HEAD` and its tree is the recorded
  one. Replays and merges never stamp. It always exits 0 and reports problems on stderr.

## Files and environment variables

### Files

| Path | What |
|---|---|
| `progress.md`, `status.md` | Committed mode, at the repo root. |
| `docs/plans/<plan>.md`, `docs/plans/<plan>.tasks.json`, `docs/specs/` | Committed mode plans, ledgers and specs. |
| `<git-common-dir>/methodology/` | Local mode: `progress.md`, `status.md`, `plans/`, `specs/`, `state.json`, `pre-commit.mjs`. |
| `<git-common-dir>/methodology/tasks.lock` | The tracking root lock, in committed and local mode. |
| `~/.local/share/triqual/tracking.db` | The store database, mode 0600, in a 0700 directory. |
| `~/.local/share/triqual/repos/<repo-key>/` | A repo's `specs/` and `plans/` documents and its `tasks.lock`, in store mode. The key is the first 16 hex characters of the sha256 of the real path of the git common dir. |
| `~/.local/share/triqual/backups/` | Store snapshots, mode 0700. |
| `~/.config/triqual/repos.json` | The registry of repos that `triqual ui` and `tasks export --json --all` read. Written by `progress-init` and the SessionStart hook. |
| `<git-dir>/triqual/commit-handshake.json` | The store `pre-commit` to `post-commit` handshake of one worktree. |
| `CLAUDE.md`, `AGENTS.md` | The managed section between `<!-- progress-tracking:start` and `<!-- progress-tracking:end -->`. `AGENTS.md` is updated only when it exists. |

Git config keys, `--local`: `triqual.tracking` (`store` marks a store repo) and `triqual.trackingFrom` (the mode a
store repo came from).

The store's data directory is `$XDG_DATA_HOME/triqual/` when `XDG_DATA_HOME` is set, else `~/.local/share/triqual/`.
If `triqual/` does not exist and the one under the previous name does, that one is used. The registry directory
follows the same rule under `~/.config`.

#### Store backups

- `backups/tracking-<YYYY-MM-DD>.db` is written at the first store write of each UTC day. The 7 newest are kept.
- `backups/tracking-relocate-<timestamp>.db`, `backups/pre-restore-<stamp>.db`, `backups/broken-<stamp>.db` and
  `backups/orphan-wal-<stamp>.db-wal` (and `.db-shm`) are never pruned.
- A failure to take the daily snapshot is reported as a warning and never fails the write.

### Environment variables

| Variable | Meaning |
|---|---|
| `TRIQUAL_TRACKING_DB` | An absolute path replaces the database path, and its directory becomes the data directory. Any other value, the empty string included, disables the store, and the gates fail closed instead of touching a real file. Tests always set it. |
| `XDG_DATA_HOME` | Moves the data directory. |
| `TRIQUAL_LOCK_TIMEOUT_MS` | How long a write waits for the lock. A positive integer. Default 5000. |
| `TRIQUAL_LOCK_STALE_MS` | Age after which a lock is taken over. A positive integer. Default 30000. |
| `TRIQUAL_REGISTRY_DIR` | An absolute directory that holds `repos.json` instead of `~/.config/triqual/`. Any other value disables the registry. |
| `CLAUDE_PLUGIN_DATA` | Where the Stop hook keeps its once-per-change-set state. Set by Claude Code. |

The legacy `CM_` names (`CM_LOCK_TIMEOUT_MS`, `CM_LOCK_STALE_MS`, `CM_REGISTRY_DIR`) still work, and the `TRIQUAL_`
name wins when both are set. `TRIQUAL_TRACKING_DB` has no legacy name.

## Entry draft format

The draft for `tracking add` and `tracking write entry`. Markdown, or JSON.

```markdown
## 2026-10-18 — Short task title
- **Stage/task:** Plan example · T3 (or "off-plan")
- **Done:** What changed and why.
- **Files:** Main paths.
- **Verification:** The commands run and the real result.
- **Next:** The next concrete step.
```

In committed and local mode `progress.md` also carries a `- **Commit:** <short sha, or "this commit">` line. See the
[skill](skills/progress-tracking/SKILL.md#entry-format).

The strict parser behind `tracking add` (`lib/entry-draft.mjs`):

- The first non-blank line is `## YYYY-MM-DD — <title>`, with a real calendar date. A second dated heading is an
  error.
- Fields are top-level bullets `- **<Name>:** text`. A bullet runs until the next top-level `- **` bullet, so
  sub-bullets, indented lines and blank lines belong to it. Names match case-insensitively.
- The title and the five fields `Stage/task`, `Done`, `Files`, `Verification` and `Next` are all required and must be
  non-empty.
- A `Commit` bullet is accepted and ignored: the store records the commit itself.
- Any other field name, a field that appears twice, or text outside a bullet is an error.
- A JSON draft is an object with the string keys `title`, `stage_task`, `done`, `files`, `verification` and `next`
  (`commit` is ignored). A draft is read as JSON when it starts with `{`. It has no date, so the entry shows the local
  date of the write.

The date an entry shows is the draft's heading date. The entry is ordered by the time it was written.

## Limits

- **Entries are append-only.** No command edits or deletes an entry. A correction is a new entry (`--corrects <id>` in
  store mode).
- **Store mode needs Node 22.13 or newer** for `node:sqlite`. Committed and local repos never load it.
- **The store schema is V2 since 0.5.0.** The two tier columns are added by an appended migration the first time a
  0.5.0 command opens the store; existing tasks read as untiered. An older progress-tracking refuses the migrated store
  and its `pre-commit` gate would block commits in store-mode repos, so do not downgrade below 0.5.0.
- **No tier is ever lowered.** `retier` refuses it, reconciling keeps the higher tier, and importing a snapshot keeps
  the higher effective tier.
- **Store mode fails closed.** A database that cannot be read blocks the Stop hook and the `pre-commit`, and both name
  `triqual tracking restore`. A disabled store (`TRIQUAL_TRACKING_DB` not absolute) blocks the same way.
- **The store is one file per user.** Nothing in git holds it. Use `tracking export` for an off-store copy, and the
  daily snapshots for the last 7 days.
- **`restore` is not per repo.** It replaces the rows of every repo in the database. It cannot recover a database file
  that is not SQLite until that file is moved away.
- **Local mode is not shared.** The files sit under `<git-common-dir>/methodology/`, shared by the worktrees of one
  clone, never committed, and gone after a re-clone. `progress-init --local --remove` deletes them for good.
- **Local mode without git hooks.** With `core.hooksPath` set, commits are not gated and the Stop hook relies on
  `progress.md` being newer than the last commit. A committer time in the future makes that check block until the
  clock catches up.
- **A plan must sit directly in the plans directory** for its ledger to be found. Task ids come from
  `### Task <N>:` headings only.
- **The ledger is only moved by `triqual tasks`.** Do not edit a `*.tasks.json` or the generated section by hand.
- **In store mode no tracking file is staged or committed.** A tracking path that is added or modified in a store-mode
  diff is a defect. Deletions are expected.
- **The Stop hook blocks once per change set.** A second stop with the same unrecorded changes passes. The
  `pre-commit` still demands the entry.
- **The dashboard is local.** It listens on loopback, serves GET only, and shows only repos in the registry.
