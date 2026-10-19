# Store mode in detail

`triqual progress-init --store` keeps the log, the status and the task ledgers in a local SQLite database, outside the
repository: no tracking file sits in the working tree, in `.git/` or in any commit, and a clone starts with none. For a
repository whose history must not carry tracking, and where local mode's `.git/methodology/` is too fragile to lose.

- **Marker:** `git config --local triqual.tracking` is `store` in a store repository. The hooks and the SessionStart
  context read it; a checkout without it (a clone of a public repository) is not tracked and nothing gates it.
- **Database:** `$XDG_DATA_HOME/triqual/tracking.db`, else `~/.local/share/triqual/tracking.db` (mode 0600, in a 0700
  directory). `TRIQUAL_TRACKING_DB` replaces the path when it is absolute; any other value, the empty string included,
  disables the store, and the gates then fail closed instead of touching a real file. Tests always set it.
- **Documents:** specs and plans are files, kept beside the database in `repos/<repo-key>/specs/` and `plans/`.
- **Node 22.13 or newer.** Committed and local repositories never load SQLite.
- `triqual tasks paths --json` in a store repository prints `"mode": "store"`, `store` (the database path),
  `plansDir`, `specsDir`, `root`, `notOptedInMessage` and `localHookLines`, and no `progress`, `status` or ledger path:
  there is no file to read. `store`, `plansDir` and `specsDir` are `null` when the store is disabled.

## Opting in

One `progress-init --store` switches a repository, whatever it was: a fresh repository (never opted in) takes one
`progress-init --store` and has nothing to import; a committed or local one is imported by the same command. Run it
from the repository root, read the JSON it prints, and:

```bash
triqual progress-init --store [--accept-unparsed]
```

What it does, in an order a re-run can always finish (a second run changes nothing):

1. imports `progress.md`, `status.md` and the ledgers into the database (a local repository's are read from
   `.git/methodology/`);
2. writes the store hooks as scripts of their own, `progress-store-pre-commit.sh` and `progress-store-post-commit.sh`,
   into the hooks directory (`core.hooksPath` when set, else `<git-common-dir>/hooks`), and chains them into
   `pre-commit` and `post-commit`;
3. records where it came from once, in `git config --local triqual.trackingFrom` (`committed`, `local` or `none`),
   then sets the marker and registers the repository;
4. removes the local-mode hook lines and the `progress-gate.sh` chain (the script is deleted unless another hook file
   names it);
5. rewrites the managed `CLAUDE.md` section (and an existing `AGENTS.md`'s) with the store text; a repository switched
   from local mode writes no `CLAUDE.md`, nothing in its tree;
6. deletes the ledgers, `status.md` and `progress.md` from the working tree, in that order.

It prints the commit and never makes it: the JSON has `commit: { paths, steps }`, where `steps` are
`triqual tracking add <draft>` (the entry the commit needs, because the store `pre-commit` refuses a commit without
one), then `git add -A -- <paths>`, then `git commit -m "chore(tracking): move progress tracking to the store"`. It
never stages or commits. A repository switched from local mode has nothing in its working tree, so it has no commit.

**Refusals** (exit 1, nothing changed): a local repository whose hooks directory is inside a working tree (a
versioned `core.hooksPath`), which stays in local mode; a `pre-commit` or `post-commit` that is not a shell script;
another branch or worktree holding entries or ledger moves the database does not (import it first with
`triqual tracking import --ref <branch>`); entries that cannot be parsed, unless you pass `--accept-unparsed`, which
imports them flagged with their original text. **Warnings** (the switch goes on): a branch whose only tracking change
is `status.md` sections, or ledger metadata (titles, roles, deps); re-apply those once the branch merges.

### The per-worktree switch

The marker is clone-wide, so a worktree that runs `progress-init --store` before it has the switch commit imports and
deletes *its own* tracking files and prints its own commit, which would collide with the first one. The recommended
path: merge `main` (with the switch commit) into the branch, and let the merge keep the tracking files deleted. Run
`progress-init --store` in a worktree only when it holds tracking changes of its own that no branch carries.

## The rules

Everything below is keyed on `"mode": "store"` from `triqual tasks paths --json`.

**R1, documents.** Specs and plans are drafted in a temporary directory under their final name and landed from there.
They never go into the working tree: land the draft with `triqual tracking write spec <draft>` or
`triqual tracking write plan <draft>`.

Run `mktemp -d` on its own; the directory it prints (`<dir>` below) holds the drafts. Then each command is plain:

```bash
mktemp -d                              # prints <dir>; draft <dir>/2026-10-11-topic.md there, then:
triqual tracking write spec <dir>/2026-10-11-topic-design.md
triqual tracking write plan <dir>/2026-10-11-topic.md       # adopts it and creates its ledger
```

An existing document is refused; `--replace` overwrites it (and, for a plan, reconciles its ledger).

**R2, an entry with a commit.** Write the entry as a draft (the same format as `progress.md`, five fields) and land it
*before* the commit it describes:

Run `mktemp` on its own; the path it prints (`<draft>` below) is the draft. Then each command is plain:

```bash
mktemp                                 # prints <draft>; fill it: ## <YYYY-MM-DD> — <title> and the five fields
triqual tracking add <draft>           # prints: entry <id>
git commit -m "feat: ..."
```

The pre-commit gate checks that this worktree has a pending entry (merges, replays and commits with nothing staged
pass); the post-commit hook stamps the pending entries with the new commit. `--commit <rev>` records an entry for a
commit that already exists. `--corrects <id>` makes the entry a correction of an earlier one: entries are append-only
and never edited.

**R3, an entry without a commit.** A task that ends with no commit (a spec, a plan registration, a status-only change,
a ruling, a production operation) lands its entry with `--no-commit`:

```bash
triqual tracking add "$draft" --no-commit
```

A pending entry left behind would be stamped onto the next, unrelated commit.

**R4, status.** Read it with `triqual tracking status`; change one section with
`triqual tracking status set --section <heading> <draft>` (the draft is the body, or the section with its
`## <heading>` line). An unknown heading exits 2 and lists the stored sections. The whole-file
`triqual tracking status set <draft>` is only for a full rewrite or a new section. The Active plan section is never
stored: it is rendered live from the ledgers.

**R5, nothing staged.** No tracking file is staged or committed. The tracking paths are the root `progress.md` and
`status.md`, and the `*.tasks.json` beside the plans. In a store-mode diff an *added or modified* tracking path is a
defect; deletions are expected (the switch commit removes them, and a merge keeps them deleted). Files of the same
name elsewhere (a template named `progress.md`, say) are not tracking paths.

**R6, reading history.** `triqual tracking log` for entries, and `triqual tasks status --json` /
`triqual tasks export --json` for ledger state. There is no ledger file to read: in store mode `ledgerPath` in
`tasks status --json` is the stored plan path, not a file.

**R7, ledger moves.** `triqual tasks` moves are unchanged (`start`, `review`, `rework`, `done --commit`, `block`,
`close`, ...), with `--plan <plan file name>`: the bare name, with or without `.md`, never the docs-dir path. There is
no `*.tasks.json` to name or stage.

## The views

- `triqual tracking status [--json]` prints the stored sections in order, then the Active plan section between its
  `<!-- tasks:start -->` and `<!-- tasks:end -->` markers, so a read followed by `status set` is a round trip. `--json`
  gives `{ sections, plans, text }`.
- `triqual tracking log [--last N] [--plan <name>] [--since <YYYY-MM-DD>] [--grep <text>] [--json]` lists the entries
  newest first, 10 by default. `--plan` is the plan an entry's Stage/task names. Only `--json` shows an entry's
  `state` (`pending`, `committed`, `no_commit` or `unresolved`) and `commit_sha`; the text form does not.
- Both are read-only. Outside store mode, `add`, `status` and `log` exit 2 with
  `not in store mode: run triqual progress-init --store`.

## Revising a plan imported from a legacy mode

`triqual tracking write plan <draft>` under the same file name as a stored plan is the same plan: the document lands in
the plans directory and the stored ledger is reconciled (same state, no second row). The first landing needs no
`--replace`; later ones do. From then on name the plan by its bare file name (`triqual tasks start T3 --plan x.md`, or
`--plan x`): a path such as `--plan docs/plans/x.md` would find the stale copy left in the working tree first.

## Moving a repository to a new checkout

`triqual tracking relocate <old-root>`, run in the new checkout, re-points the store row of `<old-root>` at it: the row
keeps its id, so every entry, plan, task and document follows (the documents directory is renamed to the new
repo key). Run it **before** `triqual progress-init --store` in the new checkout, which would otherwise create an
empty row for it that relocate refuses to replace.

- It moves the row, writes one off-plan entry naming both roots (recorded like `tracking add --no-commit`: never
  pending), moves the registry entry, then saves the database as `backups/tracking-relocate-<timestamp>.db` (after the
  move, so restoring it keeps the row under the new root) and unsets the store marker in `<old-root>` when that
  checkout is still there. Output: `relocated <old-root> -> <root>`,
  and `unset the store marker in <old-root>` when it unset it.
- Exit 3, nothing changed, with the reason: an entry of the repository is pending, a plan is not done, no row has the
  root `<old-root>`, or the new checkout already has a row. Exit 2: no argument, or not inside a git checkout.

## Recovery, export and the daily snapshot

- **Snapshots.** The first store write of each day saves `backups/tracking-YYYY-MM-DD.db` beside the database and keeps
  the 7 newest.
- **Restore.** `triqual tracking restore <snapshot> [--yes]` replaces every row of the database with the snapshot's,
  after saving the current database as `backups/pre-restore-<stamp>.db`. It asks first on a terminal and refuses
  without `--yes` anywhere else. A store gate that fails names this command:
  `the tracking store at <db> failed (<code>): <message>; recover with ...`.
- **Export.** `triqual tracking export [--out <file>]` writes the repository's rows as JSONL (stdout, or a 0600 file).
  It is the off-store copy: the database lives in one user directory and nothing in git holds it. Rebuild from it with
  `triqual tracking import --replace --from <file>`.
- **Import.** `triqual tracking import [--ref <branch>] [--accept-unparsed]` moves tracking files in, from the working
  tree or a branch. Every import merges ledgers per task by the latest history time and never overwrites a newer state.
