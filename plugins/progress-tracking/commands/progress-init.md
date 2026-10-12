---
description: Turn on strict progress tracking in the current repo (progress.md, status.md, task ledgers and the gates), committed, local or store mode
---

Turn on strict progress tracking in this repo.

1. **Pick the mode.** Ask the user whether this repo is shared with a team or a client. If it is, use local mode
   (`--local`): the files live in `<git-common-dir>/methodology/` (usually `.git/methodology/`) and nothing is
   written in the working tree or committed. If it is the user's own repo, use committed mode (no flag):
   `progress.md` and `status.md` at the root, a managed `CLAUDE.md` section and a versioned `pre-commit`. If the
   repository's history must carry no tracking at all, use store mode (`--store`): the log, status and ledgers live in
   a local database, and nothing tracking-related is committed.

2. **Run the installer** from the repo root:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs"           # committed mode
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --local   # local mode
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --store   # store mode, from a fresh, committed or local repository
   ```

   `triqual progress-init [--local | --store]` runs the same script. If `${CLAUDE_PLUGIN_ROOT}` is not resolved, use
   the newest `~/.claude/plugins/cache/triqual/progress-tracking/*/scripts/init.mjs`. It is idempotent: it never
   overwrites an existing `progress.md` or `status.md`. Committed mode replaces only the managed `CLAUDE.md` section
   and chains the gate into the `pre-commit` once, without breaking husky or existing hooks. Local mode chains a
   `pre-commit` and a `post-commit` into `<git-common-dir>/hooks/`, unless `core.hooksPath` is set: then commits are
   not gated, and the Stop hook checks for a `progress.md` entry newer than the last commit. Exit 1 means "not inside
   a git repository". Exit 2 means bad arguments, that the repo already uses the other mode, or a
   `PROGRESS.md`/`STATUS.md` that differs only in case (ask the user to rename it): report it, do not switch modes on
   your own. `--local --remove` undoes local mode (and is refused in store mode). Run without `--store` (plain or
   `--local`) in a repository in store mode, the installer exits 2 and writes nothing: run
   `triqual progress-init --store` to finish or repair a switch.

   **Store mode** (`--store [--accept-unparsed]`) imports the existing tracking files into the database, installs the
   store `pre-commit` and `post-commit` as scripts of their own chained into the hooks, sets
   `git config --local triqual.tracking store`, records the mode it came from once in
   `git config --local triqual.trackingFrom` (`committed`, `local` or `none`), rewrites the `CLAUDE.md` section, and
   deletes a committed repo's `progress.md`, `status.md` and ledgers from the working tree. A repository switched from
   local mode writes no `CLAUDE.md` (nothing in its tree), so it has no switch commit. A repository that was never
   opted in takes the same one command and has nothing to import. It prints the switch commit (`commit.steps`) and
   never stages or commits. It refuses (exit 1, nothing changed) in these cases:
   - another branch or worktree holds entries or ledger moves that are not in the store yet: import each with
     `triqual tracking import --ref <branch>` first (an unimported live branch);
   - a local-mode repository whose hooks directory is versioned (`core.hooksPath` inside the working tree): it stays
     in local mode;
   - a `pre-commit` or `post-commit` hook that is not a shell script, so the store hooks cannot be chained into it;
   - entries that cannot be parsed, unless `--accept-unparsed` imports them flagged with their original text.

   It only warns for a branch whose sole tracking change is ledger metadata (titles, roles, deps) or `status.md`
   sections: the switch does not carry those, so re-apply them after the branch merges. A second run changes nothing.
   The full rules, the order of the switch and the per-worktree case: skill `progress-tracking:progress-tracking`,
   `references/store-mode.md`.

3. **Read the JSON it prints.** In store mode there is no `status.md` or `progress.md` to create: the first status
   goes in with `triqual tracking status set <draft>` and the first entry with `triqual tracking add <draft>`, and the
   rest of this step applies to the stored status. If `status.md` is in `created`, **survey the real state** before writing it: git
   (branch, sync with the remote, unmerged branches, worktrees), specs and plans (their dirs come from
   `triqual tasks paths --json`), deploys and tests (run them). Fill `status.md` with verified data, no placeholders.
   Edit its sections in place and leave any `<!-- tasks:start -->` / `<!-- tasks:end -->` section to `triqual tasks`. If
   it already existed, leave it alone unless it is clearly stale, and ask first in that case.

4. If `progress.md` is in `created`, add the first entry (format in the skill `progress-tracking:progress-tracking`):
   turning tracking on, with the real verification from step 3.

5. Apply or report the `notes` from the JSON (for example the `prepare` script in `package.json`, or that local mode
   has no `pre-commit` because `core.hooksPath` is set).

6. Tell the user what was created, what already existed, the mode, where the hooks went and whether they are
   versioned. **Do not commit**: the user asks for the commit, and in committed mode it must include `progress.md`
   and `status.md`. In store mode relay `commit.steps` as they are: the entry first, then the `git add` of its paths
   and the `git commit`.
