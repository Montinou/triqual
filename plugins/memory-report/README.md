# memory-report

An optional plugin that writes a weekly, local report on the health of your claude-mem memory. The report covers hygiene, storage and Chroma. It can also add model-written insights (proposed rules, skill changes, stale notes), but only from the notes you allowlist and only after you finish a setup.

This file is the detail reference. The root `README.md` has the overview and the one-line table rows.

## What it ships

- A CLI, `triqual memory <command>` (file `cli/memory.mjs`). Without `triqual` on PATH, run `node "<plugin>/cli/memory.mjs" <command>`, where `<plugin>` is the plugin directory (`${CLAUDE_PLUGIN_ROOT}` when set).
- A `SessionStart` hook (`hooks/hooks.json`, script `scripts/session-start.mjs`) that starts the weekly run in the background and shows at most one notice line per day.
- One skill, `memory-report:setup` (`skills/setup/SKILL.md`), that walks you through the setup in chat.
- The generator (`lib/report.mjs`) and its collectors (`lib/collect/hygiene.mjs`, `storage.mjs`, `chroma.mjs`).

It reads claude-mem's database (`~/.claude-mem/claude-mem.db`) read-only. It does not depend on the `methodology` plugin.

## Install and setup

```
claude plugin install memory-report@triqual
```

claude-mem must already be installed. The hook does nothing until `~/.claude-mem/claude-mem.db` exists.

The insights stay off until you finish the setup. Ask Claude to "set up memory-report" to run the skill [`skills/setup/SKILL.md`](skills/setup/SKILL.md). The skill:

1. Asks whether to set up now. On "no" it runs `triqual memory setup --decline`.
2. Shows the current lists and runs `triqual memory setup --suggest --json` to list owners and candidate projects.
3. Collects the allowlist, the never-send list and the client terms in chat.
4. Asks for one confirmation, then writes everything with the commands below and ends with `triqual memory setup --done` (plus `--no-client-terms` only when you chose to have no terms).

The skill never edits the config file by hand. You can run the same commands yourself.

## Commands

All commands print errors to stderr as `memory-report: <message>`. Exit codes:

- `0`: success.
- `1`: bad usage, or a failed run. Bad usage prints the usage text to stderr.
- `2`: only when the run lock is held by another run.

Entry kinds are described in [Entries and normalization](#entries-and-normalization).

### `allow <entry>...`, `allow --list`

Adds entries to the allowlist and prints the resulting allowlist, one entry per line. An element that fails validation is printed with ` (invalid)` after it. Entries already present are not added twice.

- `--list` prints the stored allowlist without changing it. It is the only flag.
- Any other argument starting with `--`, or no entries, is a usage error (exit 1).
- It refuses (exit 1, nothing written) while the `allowlist` key in the config is invalid, or when an argument cannot be stored as an entry that could match.
- An entry of kind repository or owner that matches no repository seen so far is still added. A warning goes to stderr, exit stays 0: `memory-report: no known repository matches <entry>; check it`. Names are never warned about.

### `deny <entry>...`

Removes entries from the allowlist and prints the resulting list. No flags: any `--` argument is a usage error. An entry that is not in the list is reported on stdout after the list, exit 0:

```
missing (not in the allowlist): acme, github.com/acme/other
```

An entry equal to the argument as stored is removed first. Only when none matches, the argument is normalized and every stored entry of that form is removed.

### `block <term>...`, `block --list`, `unblock <term>...`

`block` adds client terms: a note that contains one is never sent. Terms are trimmed, de-duplicated and compared case-insensitively. The command prints the resulting list. `block --list` prints the stored terms. Adding a new term also removes the `noClientTermsAck` mark, because that choice no longer holds. `block` refuses while `clientTerms` is invalid.

`unblock` removes terms (case-insensitive), takes no flags, and prints `missing (not in the client terms): …` for absent ones.

### `never <entry>...`, `never --list`, `unnever <entry>...`

The never-send list. `never` and `unnever` work like `allow` and `deny`, with the same three entry kinds and the same output. `never --list` prints the stored entries. `unnever` takes no flags and prints `missing (not in the never-send list): …` for absent entries.

One difference on `never`: for an entry on a host that goes through `ssh -G`, it also keeps the typed form when it differs from the resolved one. That can only block more.

### `setup`

Takes exactly one of three modes. Any other combination is a usage error.

- `setup --suggest [--json]`: lists candidate projects.
  - It looks at the last 30 days of notes (subagent notes are not counted), lists up to 40 candidates, and honors the `suggestRoots` config key.
  - A candidate is a project that is not blocked and has at least one note in the window that would not be sent.
  - It resolves repositories first (this runs `stat`, `git` and `ssh -G` on the folders claude-mem recorded) and writes `repo-map.json`.
  - Text output: `1. <project> — <n> notes — <folder>` per candidate, most notes first.
  - JSON output has the keys `candidates`, `homeProject`, `owners`, `merges` and `repos`. A candidate has `project`, `notes`, `coveredNotes`, `cwd`, `repo` and `owner`. `repos` has `resolved`, `withCwd`, `unambiguous` and `complete`.
  - When repository resolution cannot be trusted and never-send has repository or owner entries, it lists nothing. Text mode prints the line `Repository identity unavailable: no candidates are listed this run because never-send has repository or owner entries.` on stdout. JSON mode prints empty lists and the same note on stderr.
  - Exit 1 with `claude-mem.db not found` when the database is missing.
- `setup --done [--no-client-terms]`: records the setup as done. It sets `setupAt`, removes `setupDeclinedAt`, and sets `noClientTermsAck` to true with `--no-client-terms` (otherwise removes it). It prints nothing.
- `setup --decline`: sets `setupDeclinedAt` and keeps everything else. It prints nothing.

`--done` and `--decline` refuse (exit 1) when the config file is not valid JSON.

### `status`

Prints these lines and exits 0:

```
last success: <ISO time | never>
last attempt: <ISO time | never>
last error: <text | none>
lock holder: <none | unreadable | pid N since <ISO time>>
setup: <done YYYY-MM-DD | declined YYYY-MM-DD | not set up>
insights gate: <open | off (reason)>
client terms: <n>
never-send: <n>
allowlisted projects: <n>
config warnings: <none | list, one per line>
```

`setup: declined` shows when the decline is later than the setup, or there is a decline and no setup. Config warnings name keys, never values.

### `repos [--json]`

Shows what the plugin knows about each project's repositories. It resolves repositories (writing `repo-map.json`) and prints:

- `resolved: <n> of <m> keys (complete|partial)`.
- Each base project with a recorded folder: `<project> — <status>`, where status is `never sent`, `allowed by name`, `allowed by repository` (with the matching entry when there is exactly one) or `not allowed`. For `not allowed` it may add `; not by repository: <reasons>`, such as `nested in another repository`, `no origin`, or `<repo> is not in the allowlist`.
- Under each project, its folders with a folder status (`root`, `nested`, `nogit`, `missing` or `unknown`) and the repositories seen there, with `seen <time>`.
- `owners:` with each owner's project count and the number of notes from the last 30 days (owners already on the allowlist or never-send list are left out), or `owners: none`.
- `merges:` suggestions for project names that resolve to the same repository, or `merges: none`. Each has the target name (`into`), the `from` names and `worktrees`, and a `stranded` count when rows already point at another name. When the claude-mem install and `bun` are found, it also prints a backup command, then `--dry-run` commands, then the merge commands. These are printed only. The plugin never runs them, and claude-mem's merge has no undo. When they are not found, only the names are printed, with a note.

`--json` prints one JSON object with the keys `resolved`, `withCwd`, `complete`, `keys`, `owners` and `merges`. Each key has `project`, `repo`, `reasons`, `folders`, `status` and `unlisted`. Each merge has `repo`, `into`, `from`, `worktrees`, `stranded`, `commands` and `note`.

When repository identity is unavailable (same condition as for `setup --suggest`), merge commands are left out (`commands` is null) and the note is printed to stderr in JSON mode.

Names, folders and repositories are printed with control and invisible characters escaped, so nothing can reorder or hide terminal output. Exit 1 when the database is missing or the repositories could not be resolved.

### `report [--now]`

- `report` prints the path of the latest report and its summary line, and marks the report as read, which silences the hook's unread-report notice. With no report yet it prints `no report yet`. It does not touch the database.
- `report --now` generates a report in the foreground. It skips the due check but still takes the run lock. It prints `memory-report: generating the report, this can take a few minutes…` on stderr, then on success prints the path and summary line without marking the report as read. On failure it prints `memory-report: run failed (triqual memory status)` (exit 1), or `memory-report: another run holds the lock` (exit 2).

The summary line looks like `Memory report 2026-W42: 3 rules · 1 skills · 0 stale · Chroma OK → triqual memory report (<path>)`. With insights off or unavailable, the middle part reads `insights off` or `insights unavailable`.

`report --now` can take minutes. The model call alone may run up to `llmTimeoutMs` (10 minutes by default). If a tool calls it, give that tool a timeout above 10 minutes.

### `generate` (hidden)

Not listed in `--help`. It is what the hook spawns. It exits 0 silently when no run is due, and prints nothing otherwise. It takes no arguments.

### `--help`, `-h`

Prints the usage text and exits 0.

## Entries and normalization

The allowlist and the never-send list each take three kinds of entry:

| Kind | Form | Example |
|---|---|---|
| name | a project name | `acme` |
| repository | `host/owner/name` | `github.com/acme/app` |
| owner | `host/owner/*` | `github.com/acme/*` |

An owner entry covers every repository under that path, at any depth, including repositories added later.

Normalization, applied when you add an entry (the stored form is lower-case):

- A trailing `/` and a trailing `.git` are dropped. `www.` is dropped from `github.com`, `gitlab.com` and `bitbucket.org`. `ssh.github.com` becomes `github.com`.
- Azure DevOps: `acme.visualstudio.com/*` is stored as `dev.azure.com/acme/*`. `<org>.visualstudio.com/[DefaultCollection/]proj/_git/repo` is stored as `dev.azure.com/<org>/proj/repo`. The `_git` segment is dropped on `dev.azure.com` too. The org must be a single label.
- A pasted URL (anything with `://`, or the scp form `[user@]host:path`) is normalized as a git remote. `https://github.com/Acme/App.git` is stored as `github.com/acme/app`.
- Hosts other than `github.com`, `gitlab.com`, `bitbucket.org` and `dev.azure.com` are resolved with `ssh -G` (local ssh config only, no network) on `allow` and `never`. If that fails, the command refuses and writes nothing. This is how an SSH alias host maps to the real host.
- Browser paths `/tree/…` and `/blob/…` (and `/-/tree/…`, `/-/blob/…` on other hosts) are stripped, but only on `allow` and `never`, and only for URL-shaped arguments (`://` or the scp form). `deny` and `unnever` do not strip them, so to remove such an entry, give the stored repository form. A schemeless `github.com/acme/app/tree/main` is not URL-shaped and is stored as is.
- Stored entries are never URLs. An entry that the adding rules would refuse makes its whole config key invalid.

Matching:

- Allowlist names match the exact project key, or a worktree key under it (`name/…`). They are case-sensitive.
- Never-send names are not case-sensitive.
- Client terms are case-insensitive.
- A project is covered by a repository or owner entry only when its recorded folders give unambiguous evidence: every folder is the root of a git repository with an origin and no unresolved remote (or a missing folder with a stored repository and no warning flags), and every repository seen there matches an allowlist entry. Blocking is stricter: one matching never-send repository, or an unreadable folder when never-send has repository or owner entries, blocks the project.

## What is sent to the model (insights call)

The insights run only when the gate is open (`insightsGate` in `lib/config.mjs`):

1. Setup is done, and not declined later.
2. The allowlist is not empty.
3. No list key is invalid (`allowlist`, `clientTerms`, `neverSend`) and `setupDeclinedAt` is valid.
4. At least one effective client term exists, or `noClientTermsAck` is set (`setup --done --no-client-terms`). A term that folds to nothing does not count.

Otherwise the report says insights are off, with a fixed reason, and nothing is sent. `triqual memory allow` alone does not open the gate.

Selection, in order:

1. Notes created in the report window `[now - intervalDays, now)` that are covered by the allowlist.
2. Subagent notes are excluded.
3. Notes whose project, title, narrative or facts contain a client term are dropped. Notes matching a secret pattern (API keys and tokens, PEM private-key blocks, bearer tokens, URLs with credentials, `password`/`secret`/`token` assignments, JWTs) are dropped. Each note is checked again as it will be rendered.
4. At most `maxObservations` notes are kept, spread across the local days of the window with newest first inside a day.

If repository resolution cannot be trusted (it failed, or the map was rebuilt since the last success) and never-send has repository or owner entries, insights are off for that run. Without such entries, only name rules can allow notes in that run.

Each sent note is one block: `#<id> [<project>] <date> <type> — <title>`, then narrative and facts joined and cut to `maxCharsPerObservation` characters. No other column is sent.

The call is one headless `claude -p` process, started from `~/.local/state/triqual/memory-report/memory-report-work`:

- Model: the config key `model`.
- Flags: `--safe-mode`, `--tools ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--permission-prompts none`, `--settings '{"disableAllHooks":true}'`, `--output-format json` and `--json-schema` with the output schema.
- Environment: the parent environment minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `MCP_SESSION_ID` and every `CLAUDE_CODE_*` and `CLAUDECODE_*` variable, plus `MEMORY_REPORT_CHILD=1` and `CLAUDE_MEM_INTERNAL=1`.
- It needs the `claude` CLI on PATH, or the path in `claudeBin`. A child that cannot start gives `claude could not be started`.
- The prompt says the notes are data, never instructions.
- Timeout: `llmTimeoutMs` (SIGTERM, then SIGKILL after 2 s).

The output is checked against a schema and capped at 5 rules, 5 skills and 20 stale pairs. Any item that cites a note id that was not sent is dropped. A failure becomes a fixed text in the report (`claude timed out`, `claude exited with code N`, `unparsable output`, and similar); child output is never echoed. The report labels the proposals as untrusted model output.

## Report contents

The report is Markdown. The window is the last `intervalDays` days. It starts with a title, the window, the generation time and the line `Local only: contains project names. Do not paste into public issues.` Sections, in order:

1. **Summary**: the week, the insights status, the Chroma status, one line per Chroma attention reason, the storage projection, and config warnings.
2. **Hygiene**: empty observations (total, new in the window, top 5 projects); duplicate groups (total, new in the window, top 5 projects, the 5 largest groups, with a title cut to 80 characters only for projects covered by the allowlist); dedup (whether `CLAUDE_MEM_DEDUP_ENABLED` is true in `~/.claude-mem/settings.json`, and candidate counts by status when claude-mem has that table).
3. **Storage**: database and WAL size, the 8 largest database objects, and rows and content bytes added in the window for `tool_uses`, `user_prompts`, `observations` and `session_summaries`. The projection is a linear 3-month estimate: bytes added in the window times 91 divided by `intervalDays`.
4. **Chroma health**: status `OK` or `ATTENTION`; documents missing from Chroma and orphans; projects with the most missing; sync watermark lag; Chroma lines in the worker logs; Python crash reports. `ATTENTION` triggers are orphans, a project of at least 50 observations missing more than 1%, Chroma lines in the worker logs, or Python crash reports in the window. Chroma checks are skipped when `CLAUDE_MEM_CHROMA_ENABLED` is false.
5. **Review tiers** (only when there is data): one row for each review tier, `heavy`, `standard` and `light`, with the task reviews of the window, how many were raised above the declared tier, the hunter confirmed rate, spec confirmed findings per task, fix rounds per task, blocked tasks and final-review escapes per task. The numbers come from `triqual role-eval summary --by-tier --since <first day of the window> --json`, run as a child process (`triqual` from `PATH`) with a 5 second timeout; a figure with no denominator reads `n/a`. The section is left out when the command is missing, fails or times out, prints anything but the expected per-tier counts and rates, or the window holds no reviewed task. Nothing is raised for it, and no other section depends on it.
6. **Insights**: rules, skills, and stale or contradicting note pairs, with a selection block (candidates, subagent rows excluded, dropped by client terms, dropped by secret patterns, sent, left out by the budget, dropped for unknown evidence). When off, only the reason is shown.
7. **Allowlist suggestions**: up to 10 projects with notes in the last `intervalDays` days that are not sent yet, each with a ready `triqual memory allow '<name>'` command. Projects whose name holds a client term are left out. A count line appears when several names resolve to the same repository (see `triqual memory repos`).

A section that fails is replaced by `Unavailable: …` and the rest of the report is still written. The file is `reports/<YYYY-Www>.md` (ISO week), so a second run in the same week overwrites it.

## SessionStart hook

The hook runs on `startup|resume` with a 10 s timeout. It opens no database. It never blocks or fails a session: errors go to `run.log` and it exits 0.

Generation:

- It starts `generate` as a detached background process when a run is due. A run is due only when `claude-mem.db` exists, the last success is older than `intervalDays` (default 7), the last attempt is older than 24 hours, and the run lock is free (absent or stale).
- This happens from any entrypoint, except inside the insights child (`MEMORY_REPORT_CHILD=1` or `CLAUDE_MEM_INTERNAL=1`), where the hook does nothing.
- A lock is stale when its process is gone or it is older than 2 hours. An unreadable lock is stale after 60 seconds without change.
- A failed attempt is not retried for 24 hours.

Notice:

- Shown only when `CLAUDE_CODE_ENTRYPOINT` is `cli`, and at most once per local day (`notice.json`).
- One line, chosen in this order:
  1. A failure: `Memory report failed <date>: <error> (triqual memory status)`, when the last error is newer than the last success.
  2. An unread report: the summary line, until you run `triqual memory report`.
  3. `memory-report is not set up — ask Claude to set it up (skill memory-report:setup)`, or `memory-report setup is incomplete — …` when setup is done but the gate is closed. These two need `claude-mem.db`. They are silent after a decline, and when the config is not valid JSON.
- The line is returned as `systemMessage` and as `additionalContext`.

## Files, config keys and environment variables

Files (private: directories `0700`, files `0600`):

| Path | Content |
|---|---|
| `~/.config/triqual/memory-report.json` | Config. If only the directory under the previous name exists, that one is used instead. |
| `~/.local/state/triqual/memory-report/state.json` | Last success, last attempt, last error, last report path and summary. |
| `…/memory-report/run.log` | One line per event, fixed strings and counts only. It is trimmed at the start of a run when it is over 256 KiB. |
| `…/memory-report/run.lock` | The run lock (`run.lock.takeover` while a stale lock is replaced). |
| `…/memory-report/repo-map.json` | Folder-to-repository map. Local only: it holds folder paths. |
| `…/memory-report/reports/<YYYY-Www>.md` | The reports. |
| `…/memory-report/notice.json`, `seen.json` | Last notice day, and the last report you read. |
| `…/memory-report/memory-report-work/` | Working directory of the insights child. |

The state directory also falls back to the directory under the previous name when only that exists. The plugin reads from `~/.claude-mem/`: `claude-mem.db`, `chroma/chroma.sqlite3`, `settings.json`, `chroma-sync-state.json` and `logs/`.

Config keys (an invalid key falls back to its default with a warning that names the key, never the value; unknown keys are kept on save):

| Key | Default | Meaning |
|---|---|---|
| `allowlist` | `[]` | Entries whose notes may be sent. |
| `clientTerms` | `[]` | Terms that keep a note out. |
| `neverSend` | `[]` | Entries never sent. An invalid array keeps its valid entries, so it can only block more. |
| `suggestRoots` | `[]` | Folders (`~/…` allowed). When set, `setup --suggest` lists only projects whose recorded folder is under one of them. |
| `model` | `claude-haiku-5-5` | Model for the insights call. |
| `claudeBin` | `claude` | The `claude` executable. |
| `maxObservations` | `600` | Notes sent per run. |
| `maxCharsPerObservation` | `600` | Characters of narrative and facts per note. |
| `intervalDays` | `7` | Schedule interval and report window. |
| `llmTimeoutMs` | `600000` | Timeout of the insights call. |
| `setupAt`, `setupDeclinedAt` | unset | Written by `setup --done` and `setup --decline`. |
| `noClientTermsAck` | unset | Written by `setup --done --no-client-terms`. |

Edit the lists with the commands above, not by hand. `allow`, `never` and `block` refuse to write over an invalid list key; every command refuses to write when the file is not valid JSON.

Environment variables:

| Variable | Effect |
|---|---|
| `MEMORY_REPORT_CONFIG` | Path of the config file. |
| `MEMORY_REPORT_STATE_DIR` | The state directory. |
| `MEMORY_REPORT_CLAUDE_MEM_DIR` | claude-mem's directory (default `~/.claude-mem`). |
| `MEMORY_REPORT_CRASH_DIR` | Where Python crash reports are looked for (default `~/Library/Logs/DiagnosticReports`). |
| `MEMORY_REPORT_REPO_BUDGET_MS` | Time budget for resolving repositories (default `10000`; clamped to 1 to 2147483647 ms; a non-numeric value gives the default). Folders not resolved in time count as `unknown`. |
| `MEMORY_REPORT_CHILD`, `CLAUDE_MEM_INTERNAL` | Set to `1` in the insights child; the hook does nothing when either is `1`. |
| `CLAUDE_CODE_ENTRYPOINT` | Read by the hook; the notice shows only for `cli`. |

An empty value counts as unset.

## Requirements and limits

- claude-mem installed. The generator fails with `claude-mem.db not found` otherwise.
- Node 22.16 or later for the generator (`lib/report.mjs`). Below that, a run records `Node 22.16 or later required`. `setup --suggest` and `repos` also open the database with `node:sqlite` options that need 22.16 (`lib/sources.mjs`), but have no explicit version check. The hook, the list-editing commands (`allow`, `deny`, `block`, `unblock`, `never`, `unnever`), `setup --done`, `setup --decline`, `status` and `report` without `--now` need no sqlite.
- The `claude` CLI on PATH for the insights call. Without it, the report is still written and the insights show `claude could not be started`.
- `git` and `ssh` for repository resolution. Each child process has a 3 s limit, and `ssh -G` reads only local config.
- A failed run stores one of a few fixed texts as `last error` (`Node 22.16 or later required`, `claude-mem.db not found`, `memory-report modules could not be loaded`, `configuration could not be read`, `report could not be written`, `report generation failed`).
- Only one run at a time: a second `report --now` exits 2 while the lock is held.
- A foreground `report --now` can take minutes on a large database (see above).
- Everything stays on your machine except the filtered notes sent in the insights call.
