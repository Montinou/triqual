# methodology-codex

The Codex bridge plugin. It gives Codex the triqual hooks, `SessionStart` and `Stop`, by running the
launcher `~/.local/bin/triqual-hook`. Everything else about the hooks lives behind the launcher, so updating the methodology
or progress-tracking plugins never touches this plugin.

It is listed only in the Codex marketplace, `.agents/plugins/marketplace.json`, never in the Claude one.

## `hooks/hooks.json` is frozen

Codex asks the user to trust each hook and records that trust under keys tied to this file
(`methodology-codex@triqual:hooks/hooks.json:session_start:0:0` and `…:stop:0:0`). Changing
`hooks/hooks.json` in any way is a **breaking release**: the user must re-approve the hooks in Codex, and the plugin's
version in `.codex-plugin/plugin.json` (and `BRIDGE_VERSION` in `plugins/methodology/cli/lib/harnesses.mjs`) moves
only then. `test/marketplace.test.mjs` pins the file's sha256 to catch an accidental edit.

## Why a separate plugin

Codex runs a hook only after the user trusts it, and it records the trust per handler by position. For
`~/.codex/hooks.json` the key holds that file's absolute path and the handler's position. When another tool (claude-mem
writes there) adds or reorders groups ahead of ours, the key shifts and the trust is dropped. A plugin's hooks are keyed
by `<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>`. That key stays the same across reinstalls and
neighbours (probe P5b in `docs/specs/2026-09-27-methodology-system-design.md`, section F.2). So the bridge holds only two
frozen hooks, and every behaviour sits behind the launcher. Renaming the plugin changes the trust keys, so a rename is a
breaking release.
