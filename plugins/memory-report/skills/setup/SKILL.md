---
name: setup
description: Use when the user asks to "set up memory-report", when a session notice says "memory-report is not set up" or "memory-report setup is incomplete", or when configuring the memory report: which projects may feed the insights, which are never sent, and which client or company terms keep a note out. Walks through the choices in chat and writes them only after one confirmation.
---

# Set up memory-report

The weekly report only sends notes to a model after a local setup: an allowlist of projects, a never-send list and
client terms. This skill collects those choices and writes them with `triqual memory`. Without `triqual` on PATH, run
`node "<plugin>/cli/memory.mjs" <command>` instead of `triqual memory <command>` (`<plugin>` is the memory-report plugin
directory, `${CLAUDE_PLUGIN_ROOT}` when set).

Every change goes through `triqual memory`. Never edit the config file by hand.

The allowlist and the never-send list each take three kinds of entry: a **name** (`acme`), a **repository**
(`github.com/acme/app`) and an **owner** (`github.com/acme/*`, every repository of that owner). A pasted URL is
normalized before it is stored: `https://github.com/Acme/App.git` is stored as `github.com/acme/app`.

## Steps

1. **Ask first.** Use `AskUserQuestion` (yes/no): set up memory-report now? On "no", run
   `triqual memory setup --decline` and stop.
2. **Projects and owners.** Run `triqual memory allow --list`, `triqual memory never --list` and `triqual memory block --list` and show
   the current values. Run `triqual memory setup --suggest --json` and read the JSON keys `owners`, `candidates`,
   `homeProject`, `merges` and `repos`. If stderr carries the note "repository identity unavailable", the lists are empty for
   this run because never-send has repository or owner entries: say so, and go on with the names the user types.

   - **2a. Owners first.** Show `owners` as a numbered list in chat, each with its `projects` and `notes` counts, never
     as question options. Ask in chat which owners to **allow** and which are **never sent** (numbers, owners, or
     "none"). Explain:
     - An owner entry covers that owner's future repositories too.
     - It only covers projects whose repository evidence is unambiguous. State the current count from the JSON:
       `repos.unambiguous` of the projects listed below have a repository that all their folders allow. `repos.complete` is false when
       some folders could not be inspected.
     - A project that was ever seen with a repository outside the allowlist (for example a client `upstream` remote) is
       not covered by an owner entry. It can still be allowed by name.

   - **2b. Projects.** Show the `candidates` as a numbered list in chat, never as question options, each with its
     `notes` count. `coveredNotes` says how many notes are already sent through a repository or owner entry, and `repo`
     is the repository the project could be allowed by. Leave out any candidate whose `owner` the user chose in 2a to
     allow or never send. Ask in chat:
     - which candidates to add (numbers, names, or "none" = add nothing);
     - whether any current project should be removed;
     - whether any project must never be sent (offer `homeProject` when it is not null).

     When `merges` is not empty, show them after the projects, as information only: each `repo` with its `into`,
     `from`, `worktrees` and `stranded` values, its `note` when there is one, and its `commands` (`backup`, then
     `dryRun`, then `run`) when `commands` is not null, or the names only when it is null. `triqual memory repos` prints the
     same list. The user may run these commands themselves, outside this setup. The setup never runs them.
     claude-mem's merge has no undo.

     Only if the resulting allowlist would be empty, run `triqual memory setup --decline` and stop.
3. **Terms.** Ask in chat for client or company terms to add or remove (comma separated). Explain that a note
   containing any of them is never sent. "none" is allowed.
4. **Confirm.** Show the full plan and ask with `AskUserQuestion` (yes/no) for confirmation. The plan has the allowlist
   and the never-send list, each split into names (`acme`), repositories (`github.com/acme/app`) and owners
   (`github.com/acme/*`), then the client terms. Nothing is written before this. On "no", stop without writing.
5. **Write.** On confirmation run, each value as its own quoted argument. Owner entries contain `*`, so keep the quotes:
   - `triqual memory allow …` / `triqual memory deny …`
   - `triqual memory never …` / `triqual memory unnever …`
   - `triqual memory block …` / `triqual memory unblock …`
   - then `triqual memory setup --done`, adding `--no-client-terms` only when the user answered "none" to terms and the
     resulting term list is empty
   - then `triqual memory status` and show it, and mention that `triqual memory report --now` produces a report with the new
     settings.

   After an upgrade from 0.2.0, the first report may run with insights off when never-send has repository or owner
   entries. Step 2's `setup --suggest` has already created the map, and it reads as rebuilt because its `rebuiltAt` is later
   than the last success, so the newly created map reads as rebuilt until a report succeeds. Tell the user this now.
   Until a report succeeds, the insights allow by name only, so a project allowed just by repository or owner is not
   sent in that report; with repository or owner never-send entries the insights are off. The next successful report
   sends normally. Running `triqual memory repos` or `setup --suggest` does not use this up.
6. **Failures.** If any command fails, report its message and stop without marking setup done.
7. **Never invent.** Never add or remove a project, term or flag the user did not state.
