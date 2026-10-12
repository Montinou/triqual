# methodology-codex

The Codex bridge plugin. It gives Codex the triqual hooks, `SessionStart` and `Stop`, by running the
launcher `~/.local/bin/triqual-hook`. Everything else about the hooks lives behind the launcher, so updating the methodology
or progress-tracking plugins never touches this plugin.

It is listed only in the Codex marketplace, `.agents/plugins/marketplace.json`, never in the Claude one.

## `hooks/hooks.json` is frozen

Codex asks the user to trust each hook and records that trust under keys tied to this file
(`methodology-codex@triqual:hooks/hooks.json:session_start:0:0` and `…:stop:0:0`). Changing
`hooks/hooks.json` in any way is a **breaking release**: the user must re-approve the hooks in Codex, and the plugin's
version in `.codex-plugin/plugin.json` (and `BRIDGE_VERSION` in `plugins/methodology/bin/lib/harnesses.mjs`) moves
only then. `test/marketplace.test.mjs` pins the file's sha256 to catch an accidental edit.
