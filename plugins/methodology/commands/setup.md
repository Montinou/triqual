---
description: Finish triqual setup — installs the triqual CLI and hook launcher in ~/.local/bin, the global rules, the system plugins and the `Bash(triqual tracking:*)` allow rule
---

Finish the triqual setup on this machine.

1. **Run the installer** with the Bash tool and a timeout of 600000 ms (it installs plugins, which can take a while):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/setup/bootstrap.mjs" --yes --keep-language --no-harness
   ```

   If `${CLAUDE_PLUGIN_ROOT}` is not resolved, use the newest
   `~/.claude/plugins/cache/triqual/methodology/*/setup/bootstrap.mjs`. It is idempotent: a second run changes
   nothing that is already in place.

2. **Relay the result.** Show the user each step line it printed and the summary of the doctor check at the end. When
   a step failed, relay its hint verbatim and do not try to repair the step yourself: exit 1 means a step or a
   prerequisite (`claude`, `git`) failed, and the hint says what to run next.

3. **Tell the user to run `/reload-plugins`** so the plugins it installed or enabled load in this session.

## What it changes

- `triqual` and `triqual-hook` in `~/.local/bin` (and the `cm` alias on a legacy machine).
- The managed section of `~/.claude/CLAUDE.md`.
- `~/.claude/settings.json`: the system plugins installed, superseded plugins such as superpowers disabled, and the
  allow rule `Bash(triqual tracking:*)`, which also covers `triqual tracking restore --yes` and
  `import --replace`.
- Backups of each file it edits under `~/.claude/backups/triqual-<stamp>/`.

Codex, Grok and the `language` key need `node bin/bootstrap.mjs` from a clone of the repository.
