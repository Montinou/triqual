# triqual

Set up [Triqual](https://github.com/Montinou/triqual) from a terminal, then run its commands.

```bash
npx triqual setup
```

Triqual is a Claude Code plugin marketplace that gives an AI coding agent a working method: a plan before the code, a
review for every task, a progress log it cannot skip. This package installs it and forwards to it; the plugins hold
the code.

## Requirements

Node 22.13 or newer, git, and the `claude` CLI (Claude Code) on `PATH`.

## `triqual setup [--yes] [--keep-language] [--no-harness]`

1. Checks the arguments (`setup --help` prints the usage; any other argument stops it with exit 2) and the
   prerequisites (each missing one is named; exit 1, nothing changed).
2. Stops with exit 1, changing nothing, on a machine still on the marketplace's previous name: run
   `node bin/bootstrap.mjs` from a clone of the repository, which migrates it.
3. Adds the `triqual` marketplace to Claude Code (`claude plugin marketplace add Montinou/triqual --scope user`), or
   updates it when it is already there.
4. Installs `methodology@triqual` at user scope when it is not installed yet.
5. Runs the installer that the installed methodology plugin ships, with your flags, and exits with its status.

The installer is the same one as the full setup from a clone: what it changes is listed under
[What `bootstrap` changes on your machine](https://github.com/Montinou/triqual/blob/main/README.md#what-bootstrap-changes-on-your-machine).
Run from a terminal, it also sets up Codex and Grok when it finds them, and asks about the `language` key in
`~/.claude/settings.json`.

- `--yes` answers yes to every confirmation.
- `--keep-language` keeps the `language` key.
- `--no-harness` skips the Codex and Grok setup.

It is safe to rerun: `npx triqual setup` again updates what is out of date and leaves the rest.

## Other commands

`triqual --version` (or `-v`) prints this package's version. Every other command runs in the `triqual` that setup
installs in `~/.local/bin`, with its arguments and exit code: `triqual doctor`, `triqual tasks …`, `triqual help`. After
a forwarded help, a last line reminds you that `npx triqual setup` reruns the setup.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | a prerequisite is missing, the machine needs the migration, or a command could not run |
| 2 | `setup` got an argument it does not know |
| 3 | not set up yet: run `npx triqual setup` |
| other | the exit code of the failing `claude` command, of the installer, or of the forwarded command |

## License

MIT
