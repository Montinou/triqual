# @triqual/fence

fence is a policy engine for agent tool calls: a Claude Code or Codex hook hands it the call about to run, and it answers allow or deny according to a set of written policies. It is a guardrail that reads and judges commands and file paths; it does not sandbox code, isolate processes or restrict what a permitted command does once it runs.

## Status

The package is `0.1.0` in this repository. It is not published to npm under a real version: the registry holds only a deprecated `0.0.0` placeholder, and no workflow here publishes `@triqual/fence`. `fence install --version <exact>` takes the package from the registry and checks its signature and provenance, so until a release exists, install from a tarball with `--from-tarball <file>`.

## Policy

The policy is one JSON file, `~/.config/fence/policy.json`. Each rule has an `id`, a `decision`, a `match` and a `why`, and carries `examples` that `fence test` runs. A profile, chosen with the `FENCE_PROFILE` environment variable (default `default`), says what happens to a call no rule decides: `host` leaves it to the agent host's own permission flow, `deny` refuses it.

Two policies ship in `policies/`, and `fence install --policy example|strict` writes one when no policy exists yet (an existing policy is never overwritten):

- `example.json` (the default) denies reading or writing credential files (`.env`, `~/.aws`, `~/.ssh`) and privilege escalation.
- `strict.json` adds rules against deleting or overwriting files outside the repository, dumping the environment, changing permissions, writing to version control, fetching from the network and writing outside the repository, and protects the branches `main`, `master` and `develop`.

## Commands

Read-only commands, open to an agent:

- `fence check [--policy f]` validates the policy and warns about allow rules that could cover a command that runs repository code.
- `fence test [--policy f]` runs the policy examples and the built-in self-protection cases.
- `fence log [--session id] [--denies | --undecided | --unknown-tools | --agent id --reads | --latency] [--state-dir d]` prints views of the decision log.
- `fence doctor [--json]` reports on the install, the hosts, the policy, the escape hatch and sudo, and exits 1 on a failure.
- `fence replay --transcripts <dir> --policy <file> --out <dir> [--labels <file>]` decides every tool call of local Claude transcripts without running anything, and writes `denies.md`, `undecided.md`, `latency.json` and `summary.md`.
- `fence version` and `fence help`.

Human-only commands, which need an interactive terminal and are refused inside an agent session:

- `fence install --version <exact> [--from-tarball <file>] [--policy example|strict]`
- `fence upgrade --version <exact>` and `fence rollback`
- `fence edit` opens a copy of the policy in `$EDITOR`, and `fence apply <draft>` validates, diffs and tests a draft before applying it (with sudo when the change weakens the policy).
- `fence repair` reinstalls from the newest passing version and clears an integrity denial.
- `fence hatch [--for <duration>]` and `fence hatch --close` open and close the escape hatch.
- `fence allow-once <path>` grants one single-use write.
- `fence uninstall [--purge]`

`fence lock` is listed in the help as not yet implemented. Run `fence help` for the full text.

## With triqual

The methodology cooperates with fence when it is installed, and changes nothing when it is not. `triqual doctor` prints an `INFO fence <version>` line, and `executing-plans` detects fence once per run (`command -v fence`, then `fence version`). With fence present, installing a vault skill is left to the human, and a denial is a stop to report: the agent never retries a variant of the denied call, never suggests `fence hatch` and never edits the policy. See the Fence and Denied by Policy sections of [executing-plans](../../plugins/methodology/skills/executing-plans/SKILL.md).

## Development

`node --test packages/fence/test/*.test.mjs` runs the package tests. The package needs Node 22.13 or newer.
