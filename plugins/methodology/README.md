# methodology

The core plugin of Triqual. It ships the workflow skills, the global rules that
`triqual sync` writes into `~/.claude/CLAUDE.md`, the `/methodology:setup` command, and the `triqual` commands `doctor`,
`sync`, `migrate`, `role-eval`, `suggest` and `hook`. A SessionStart hook loads the methodology into a Claude Code
session. `triqual hook` and `triqual sync --harness <id>` give the same methodology to Codex and Grok. The plugin
depends on `progress-tracking`, `workflow-gate` and `roles`, so installing it installs them.

triqual's methodology began as a fork of [superpowers](https://github.com/obra/superpowers) by Jesse Vincent (MIT). It has since been rewritten as triqual's own orchestrator; thanks to Jesse for the foundation. See [NOTICE](NOTICE) and [LICENSE-superpowers](LICENSE-superpowers).

This page is the reference for this plugin. For the install steps, the plugin table, the tracking modes and the long
Codex and Grok explanation, see the [root README](../../README.md). Commands that belong to other plugins (`tasks`,
`progress-init`, `ui`, `tracking`, `memory`) are in their own sections of the root README.

## Commands

`triqual` is a shim at `~/.local/bin/triqual`. It runs the command from the installed plugin that owns it. The shim
exits 1 for an unknown command (the command list goes to stderr) and when it cannot start the command. It exits 3 when
the plugin or the command is not installed. Otherwise it exits with the command's own status. `suggest` runs from this
plugin (from version 1.0.0) and calls the separately installed `headjack`.

`doctor`, `sync`, `migrate` and `role-eval` refuse an unknown argument with exit 2. Each of them takes
`-h` or `--help` and then writes nothing.

### `/methodology:setup`

Usage: `/methodology:setup` in Claude Code, then `/reload-plugins`.

Finishes the machine-level setup after a marketplace install. It runs the installer from the plugin
(`setup/bootstrap.mjs`) with `--yes --keep-language --no-harness`: the `triqual` command and the hook launcher in
`~/.local/bin`, the global rules, the system plugins and the `Bash(triqual tracking:*)` allow rule. It does not set up
Codex or Grok and does not touch the `language` key; both need a terminal: `npx triqual setup`, or
`node bin/bootstrap.mjs` from a clone (see [Install](../../README.md#install)).

On a machine that still has the previous marketplace name, it also runs `migrate`. It also removes the legacy copies of
the role agents in `~/.claude/agents` and the legacy Workflow gate hook. That removal is skipped while the rules step
fails. The command is for the user to type or agree to. The agent does not run it on its own.

The installer is safe to rerun. It exits 1 when a step or a prerequisite (`claude`, `git`) failed, and prints a hint for
the step. It ignores flags it does not know.

### `triqual doctor`

Usage: `triqual doctor [--repo]`

Reads the install and changes nothing. It prints `FAIL`, `WARN` and `INFO` lines, then
`doctor: N failure(s), M warning(s)`.

- `--repo` also checks the tracking of the current repo and lists the tracking mode of every registered repo as `INFO`
  lines. The checks are in the `triqual doctor` row of the [root README](../../README.md#triqual-commands). It also
  warns when a repo in committed mode has an `AGENTS.md` without the tracking section.
- `-h`, `--help` print the usage and exit 0.

Exit codes: 0 no failure (warnings do not count), 1 at least one failure, 2 an unknown argument.

What it checks:

- Node 22.13 or newer (major and minor are compared).
- The installed version of each system plugin against the copy in the marketplace.
- That the system plugins are enabled.
- Superseded plugins (`superpowers@*`) still enabled. A failure, or a warning under `keepSuperseded`.
- Duplicate role agents in `~/.claude/agents`.
- The managed rules section of `~/.claude/CLAUDE.md`: drift from the installed rules, and rules of the old layout
  outside the section.
- A stale shim: one that lacks a command an installed plugin ships.
- The launcher `~/.local/bin/triqual-hook`, compared byte for byte with the plugin's copy.
- A scan for leftovers of the previous name.
- That `headjack` is reachable. A warning only.
- `progress-tracking` 0.2.4 or newer, when a harness is set up.
- Codex hook trust. A bridge hook that Codex has not trusted is a failure. A bridge that has not run since it was
  installed is a warning.

Right after a fresh Codex setup the bridge hooks are not trusted yet, so `doctor` fails, and so does the last step of
bootstrap. Approve the two hooks in the next Codex session and run `triqual doctor` again.

### `triqual sync`

Usage:

```text
triqual sync
triqual sync [--yes] [--harness <id>]...
triqual sync [--yes] --remove-harness <id> [--restore-agents-md]
```

Plain `triqual sync` writes the installed rules into the managed section of `~/.claude/CLAUDE.md` and disables the
superseded plugins at user scope. Both steps back up `settings.json` and `CLAUDE.md` first. Then it syncs every harness
recorded as `enabled: true` in `~/.config/triqual/config.json`.

| Flag | Meaning |
|---|---|
| `--harness <id>` | Sync only this harness (`codex` or `grok`), with no Claude steps, and record it as enabled. Repeatable. For a removed harness it records it on again. An absent harness is reported as skipped and is not recorded. |
| `--remove-harness <id>` | Undo what sync did in that harness, from `~/.config/triqual/harnesses.json`, and record it as off. Takes one harness. Cannot be combined with `--harness`. |
| `--restore-agents-md` | With `--remove-harness codex` only: put back the `~/.codex/AGENTS.md` from before the split. |
| `--yes` | Answer yes where a step would ask. It never accepts the one-time split of `~/.codex/AGENTS.md` and never reinstalls the Grok plugins that sync uninstalled. |
| `-h`, `--help` | Print the usage. |

It prints one line per step, `<step>: <status> — <detail>`, where the status is `done`, `already`, `skipped` or
`failed`. Exit codes: 0 no step failed, 1 a step failed, 2 a bad argument.

Notes on the Codex steps:

- `sync --harness codex` fails when `~/.codex/config.toml` does not exist yet. Start Codex once first.
- The bridge is installed with `codex plugin marketplace add ~/.claude/plugins/marketplaces/triqual`, then
  `codex plugin add methodology-codex@triqual`. When the Claude marketplace clone is missing, the step fails and points
  at `triqual migrate`.
- Grok's old copy of superpowers is uninstalled only without `keepSuperseded`.

The harness model is in [Codex and Grok](../../README.md#codex-and-grok) in the root README. The bridge plugin is
described in [`../methodology-codex/README.md`](../methodology-codex/README.md).

### `triqual migrate`

Usage: `triqual migrate [-h|--help]`

Moves a machine from the previous marketplace name to `triqual`. It has no flags. It runs these steps in order and
prints one line for each: `backup`, `cli`, `marketplace`, `references`, `directories`, `harnesses`, `repos`, `verify`.
A second run changes nothing. Run on its own, it skips the step that installs the CLI. Run bootstrap from a clone for
that. When the old and the new config, state or data directory both exist, it stops before it uninstalls anything and
asks you to merge them by hand.

The full description is in [Moving from the previous name](../../README.md#moving-from-the-previous-name).

Exit codes: 0 done, 1 a step failed to verify, 2 an unknown argument (nothing ran).

### `triqual role-eval`

Usage:

```text
triqual role-eval record --plan <plan file> <json-file>
triqual role-eval summary [--since YYYY-MM-DD] [--json]
```

The comparison store behind the review hunters.

`record` validates one `hunters` record and appends it once. The record has these rules:

- The JSON file has no `key` field. Any `key` field is rejected, because the command derives the key.
- `task` is `T<n>` or `final`. `provider` is `claude` or `codex`.
- Each hunter has a `category`: `correctness`, `security`, `spec-drift` or `state`.
- `candidates` must equal `confirmed + refuted + duplicateCandidate + duplicateReview`.
- An optional `budget` holds `reference`, `used` and `overrun`.
- The kind `safety-shadow` is retired and refused.

The idempotency key is the sha256 of the git common directory, the plan file's base name, the task and the kind. Because
linked worktrees share the common directory, they share keys. A second `record` with the same key prints
`already recorded` and changes nothing. The command must run inside a git repository. The appends are serialized by
`comparisons.jsonl.lock`: it waits 2 seconds and treats a lock older than 30 seconds as stale. The file is always mode
`0600`. The directory is set to `0700` only when it is the default directory or when `record` created it.

`summary` prints, per provider, each hunter category's right and new rates, a Budget section, and a `Skipped:` line.
It also covers the `safety-shadow` records stored before that kind was retired. `--since` takes a valid calendar date,
and 2026-02-30 is refused. `--json` prints the same numbers as JSON. An empty or missing store prints
`No records in the window (0 records).` (with `--json`, `{"providers":{},"skipped":{...}}`).

Exit codes: 0 written, already recorded, or a summary (a missing file included), 1 a write or lock failure or a store
that exists but cannot be read, 2 a usage error, a bad or retired record, a bad JSON file or no git repository. The
message names the field, never the value.

### `triqual suggest`

Usage: `triqual suggest "<text>" [--json]`

Vault skills that fit `<text>`. [Headjack](https://github.com/Montinou/headjack) owns skill finding and is installed
separately; this command only calls it.

- It finds `~/.local/bin/headjack`, then the first `headjack` on `PATH`, and runs `headjack suggest "<text>"`. It never
  passes `--session-id`: the session dedupe would hide a skill from every task after the first.
- Text mode prints Headjack's own `<headjack-suggestions>` block unchanged. Headjack already cleans the descriptions,
  filters the slugs, adds the "not instructions" note and pins `HEADJACK_MODE` and `HEADJACK_URL` in its install
  command. The single `no suggestions (<outcome>)` line Headjack prints when there is none is dropped, so no
  suggestion is empty output.
- `--json` runs `headjack suggest "<text>" --json` and passes the document through after dropping every suggestion
  whose slug does not match `^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$`.
- Empty output with exit 0 (Headjack's `skipped:no-vault`) is no suggestion in both modes.
- A text that starts with a dash is passed after `--`. A Headjack that does not answer within 20 seconds is killed.

Exit codes: 0 Headjack ran (the output may be empty), 3 Headjack is not installed, 1 Headjack exited non-zero or did not
answer in time, or `--json` printed output that is not valid JSON, 2 a usage error. The `brainstorming`, `writing-plans`
and `using-methodology` skills treat any non-zero exit or empty output as no suggestion and say nothing.

### `triqual hook`

Usage: `triqual hook <event> --harness <id>`

The hook entry for other harnesses. The harness calls the launcher `~/.local/bin/triqual-hook`, which runs this command
with the hook payload on stdin. You rarely run it by hand.

| Harness | Events |
|---|---|
| `codex` | `session-start`, `stop` |
| `grok` | `pre-tool-use`, `post-tool-use`, `post-compact` |

It always exits 0, and a failure prints nothing. An unknown input prints one line on stderr, never the payload.

- Codex `session-start`, and Grok's first tool call of a session, return one context: the methodology part (drift lines
  plus `using-methodology`) and the progress-tracking part. The merged context is capped at 9,500 characters, because
  Grok clips at 10,000. Each part runs only while its plugin is enabled in Claude.
- Codex `stop` runs the progress gate and forwards a block as `{"decision":"block","reason":...}`.
- Grok keeps delivery state per session, so the context goes out once.
- A Codex session start also starts a detached background run. It refreshes the skill links and the agent files, and
  runs `headjack cleanup --older-than 48h` when `~/.local/bin/headjack` exists.

### `stack.mjs`

Usage: `node skills/executing-plans/scripts/stack.mjs <command> PLAN_FILE ...`

Not a `triqual` command. A script of the `executing-plans` skill that owns every git and gh operation of a
stacked plan execution: one branch for each plan phase, and in GitHub mode one draft PR. It needs only Node, git and gh.
Every gh call is non-interactive.

```text
init PLAN_FILE [--trunk <b>] [--mode github|local] [--remote <r>]   print the state (JSON), writing it the first time
mode PLAN_FILE github|local                                         switch the mode (github re-runs the checks)
path PLAN_FILE                                                      print the state file's path
status PLAN_FILE                                                    print the state (JSON), PR states refreshed
phase PLAN_FILE N                                                   check out phase N's branch, mark it active
squash PLAN_FILE BASE                                               fold BASE..HEAD into one commit, print its sha
done PLAN_FILE N                                                    mark phase N done
submit PLAN_FILE N [--open]                                         reconcile gh stack, submit, fill phase N's PR
```

Exit codes: 0 ok, 2 usage or a malformed plan, 3 a refused precondition (committed tracking mode is one), 5 a gh
command failed.

## Hooks

Claude Code gets one hook, `SessionStart`, for the matcher `startup|resume|clear|compact` (timeout 10 s). It runs
`cli/drift.mjs`.

- On `startup`, `clear` and `compact` it injects the drift lines, then the `using-methodology` skill. Drift lines say
  that the managed rules section differs from the installed rules, or that a superseded plugin is still enabled. Under
  `keepSuperseded` it injects a short note in place of the skill.
- On `resume` it injects only the drift lines and a one-line note, not the skill.
- When `~/.local/bin/triqual.mjs` is missing, it injects a setup notice that offers `/methodology:setup`, and it drops
  the lines that name `triqual sync`, a command that is not installed yet.
- It never throws and always exits 0. An unexpected error is logged to `${CLAUDE_PLUGIN_DATA}/log` when that variable
  is set.

Codex and Grok hooks are not declared in this plugin. They call the launcher `~/.local/bin/triqual-hook`, which runs
`triqual hook` (see above). The Codex entry is the bridge plugin `methodology-codex`. The launcher always exits 0. It
writes a stamp `last-run-<harness>` before it runs Node, and it sends the command's stderr to `hook.log`. It moves
`hook.log` to `hook.log.1` when the log is larger than 1 MiB, and keeps one old generation. `triqual doctor` reads the
stamps.

## Skills

The 10 skills in `skills/`. Claude Code names them `methodology:<name>`.

| Skill | Purpose |
|---|---|
| `using-methodology` | Start of every conversation: how to find and use skills, and to invoke one before any response. |
| `brainstorming` | Before any creative work: explore intent, requirements and design before implementation. |
| `writing-plans` | Turn a spec or requirements for a multi-step task into a plan, before touching code. |
| `executing-plans` | Execute a plan: every task is done by a role agent, reviewed by its tier, one stacked branch and draft PR per plan phase. |
| `test-driven-development` | Write the failing test first, for any feature or bugfix. |
| `systematic-debugging` | Find the cause of any bug, test failure or unexpected behavior before proposing a fix. |
| `reviewing-code` | Review a commit range or a pull request outside a plan (two hunters and a spec reviewer), and act on review feedback: verify it, fix what is real, refute the rest with evidence. |
| `verification-before-completion` | Run the verification commands and read the output before claiming work is done, fixed or passing. |
| `finishing-branch` | When implementation is complete and tests pass: close the plan and decide how to integrate the work. |
| `diagnosing-methodology` | Find why a session that ran these skills went wrong, or build a bug report for this system's repository, on any harness. |

## Files and environment variables

Files this plugin reads or writes. `~` is the home directory.

| Path | What |
|---|---|
| `~/.local/bin/triqual`, `~/.local/bin/triqual.mjs` | The shim. The first is a relative link to the second. |
| `~/.local/bin/triqual-hook` | The hook launcher for Codex and Grok. |
| `~/.claude/CLAUDE.md` | The managed rules section, between `<!-- triqual:start -->` and `<!-- triqual:end -->`. |
| `~/.claude/settings.json` | Superseded plugins disabled, and the allow rule `Bash(triqual tracking:*)`. |
| `~/.claude/backups/triqual-<YYYYMMDD-HHMMSS>/` | Backup of each file `sync` or the installer edits or removes. |
| `~/.config/triqual/config.json` | `keepSuperseded`, and `harnesses.<id>.enabled`. |
| `~/.config/triqual/harnesses.json` | What `sync` changed in each harness, so `--remove-harness` can undo it. |
| `~/.codex/AGENTS.md`, `~/.grok/rules/triqual.md` | The rules for Codex (a managed section) and Grok (a whole file). |
| `~/.local/state/triqual/hook.log`, `hook.log.1`, `last-run-<harness>` | The launcher's log and stamps. |
| `${XDG_DATA_HOME:-~/.local/share}/triqual/role-eval/comparisons.jsonl` | The role-eval store (and its `.lock`). |
| `<repo root>/.methodology/stack/<plan file stem>.json` | The state file of `stack.mjs`. `.methodology/` holds a `.gitignore` with `*`. |

A machine that still has the previous name reads the directories under that name until `migrate` moves them.

Environment variables:

| Variable | Used by | Effect |
|---|---|---|
| `ROLE_EVAL_FILE` | `role-eval` | Names the store file. Its directory is not treated as the default directory. |
| `XDG_DATA_HOME` | `role-eval` | Replaces `~/.local/share` as the base of the store. |
| `TRIQUAL_REGISTRY_DIR` | `migrate` | An absolute path where the repo registry `repos.json` is read from. The old `CM_REGISTRY_DIR` still works for now. |
| `CLAUDE_PLUGIN_ROOT` | `/methodology:setup`, hooks | The plugin's directory, set by Claude Code. |
| `CLAUDE_PLUGIN_DATA` | the SessionStart hook | Where the hook writes its error log. |

## Limits

- Node 22.13 or newer. `doctor` checks it. The git 2.31 floor in the root README is not checked by any code. It is
  needed by `git rev-parse --path-format=absolute`, which progress tracking uses.
- The installer ignores flags it does not know. A mistyped `--no-harnes` is not an error.
- A new Codex setup is incomplete until the user approves the two bridge hooks in Codex. Until then `doctor` fails.
  Triqual never writes Codex trust entries.
- `sync --yes` never accepts the one-time split of `~/.codex/AGENTS.md` or a reinstall of Grok plugins. Run
  `triqual sync --harness codex` in a terminal for the split.
- Grok cannot select a named agent, so the role agents and `executing-plans` do not run there.
- The context that `triqual hook` returns is capped at 9,500 characters.
- `stack.mjs` refuses a repo in committed tracking mode (exit 3). Switch with `triqual progress-init --store` or
  `--local`.
- `role-eval record` must run inside a git repository, and linked worktrees of one repository share record keys.
- The Codex model and reasoning effort for each role are set in `cli/lib/agents.mjs`. The table is in
  [Codex and Grok](../../README.md#codex-and-grok) in the root README.
