# Claude PreToolUse `cwd` probe

Question: does the `cwd` in the hook payload of a Claude Bash call follow a `cd` made in an earlier Bash call of the same session, inside and outside the project, and does it agree with the directory the shell really runs in?

Run: `bash packages/fence/test/acceptance/cwd-probe/run.sh` (Claude Code 2.1.302, `claude -p --max-turns 8 --allowedTools Bash`, four separate Bash calls: `cd sub`, `pwd`, `cd <outside dir>`, `pwd`). `--max-turns` is 8 so the model has room for four calls plus the reply. The probe uses a throwaway settings file (`--settings` is additive, so the user's normal hooks also load) and mktemp directories; `claude -p` writes its session transcript under the real `~/.claude/projects`, which this probe cannot avoid.

Observed (payload `cwd` of each call; `<t>` is the temp root; PostToolUse also logs the command's own `pwd` output):

| call | command | PreToolUse `cwd` | `pwd` output |
|---|---|---|---|
| 1 | `cd sub` | `<t>/project` | |
| 2 | `pwd` | `<t>/project/sub` | `<t>/project/sub` |
| 3 | `cd <t>/outside` | `<t>/project/sub` | |
| 4 | `pwd` (with `--add-dir <t>/outside`) | `<t>/outside` | `<t>/outside` |
| 4 | `pwd` (`ADD_OUTSIDE=0`, no `--add-dir`) | `<t>/project` (Claude reset the shell to the project) | `<t>/project` |

follows: yes

Findings for T19:

- The payload `cwd` of a Bash call always equals the directory the shell really runs that call in, including when Claude resets a `cd` outside the allowed directories back to the project. The Claude adapter uses the payload `cwd` as the effective working directory; relative paths are not `UNKNOWN` for that reason.
- The `cwd` shown in the payload is realpath-resolved (on macOS the temp root appears as `/private/var/...`).
- The `cd` that leaves the allowed directories is reset only after it runs, so the normalizer's own in-command `cd` tracking (T13) still matters inside one compound command (`cd /x && rm y`): the hook sees the whole command before any `cd` runs.
