# jev runners (offline acceptance, items 1 and 2)

Two runners measure fence against the jev-harness guard 1.2.0 default corpus (571 payloads: 503
dangerous, 68 harmless controls) with `packages/fence/policies/strict.json`. Neither needs the
plugin, the fence CLI, an install or sudo. Each one stages its own HOME with `../stage-home.mjs`:
`versions/0.0.0-test/` (a copy of this package), `current`, the bundled watchdog, its `fence-hook`
trampoline, a `git.json` pin from the machine's `git` and a copy of the policy. The launcher then
runs with `HOME=<staged home>` and empty temp `--state-dir` and `--admin-dir`. Payloads are only
sent as stdin JSON; nothing in the corpus is executed.

Both need `uvx` (override it with `UVX=<path>`) and network access the first time uv fetches
`jev-harness-sdk[stats]==1.2.0`. Run them one at a time.

## Claude

```sh
bash <repo>/packages/fence/test/acceptance/jev/run-claude.sh [--policy <file>] [--out <report.json>]
```

The script makes an empty project in a temp root (`git init`, branch `acceptance`) and runs, from that
project:

```
uvx --from 'jev-harness-sdk[stats]==1.2.0' jev-harness guard run --no-user-settings --no-managed-settings \
  --guard "env HOME=<tmp>/stage/home <tmp>/stage/home/.local/bin/fence-hook pre --host claude \
           --policy <tmp>/stage/home/.config/fence/policy.json --state-dir <tmp>/state --admin-dir <tmp>/admin" \
  -f json -o <out>
```

Only the launcher gets the staged HOME. The script then prints the metrics from jev's JSON report
(`node compare.mjs --metrics <out>`) and exits with jev's exit status.

jev builds the hook payloads itself. It runs every hook, and sets every payload's `cwd`, in its own
workspace: a `tempfile.mkdtemp(prefix="jev-harness-")` directory, not the directory it was started
from. In the system temp directory that workspace is outside any repository. `${repo}` would then
not resolve, and strict.json would deny harmless controls such as `Edit src/main.py` as writes
outside the repository.

So the script runs uvx with `TMPDIR`, `TMP` and `TEMP` set to `<project>/.jev-tmp`. That puts jev's
workspace, and so the hook cwd, inside the repository, as in a real session. jev's command line is
unchanged. After the run, `node compare.mjs --check-cwd <state> <project>` reads the engine's log
lines. Each must show a cwd inside the project and the project as its repo root. If not, the script
fails with exit 3. A relative `--out` is resolved against the caller's directory.

## Codex

```sh
node <repo>/packages/fence/test/acceptance/jev/run-codex.mjs [--out <dir>] [--policy <file>]
```

jev can not drive Codex hooks, so this runner does the following:

1. Dumps jev's expanded corpus as JSON rows (`id, category, disguise, expected, tool, tool_input`)
   with `uvx … python`, expanded against a temp project that is `git init`-ed on branch
   `acceptance`.
2. Converts each row with `toCodexPayload`:
   - Bash keeps its command as a `shell` call.
   - Read becomes `cat <path>`.
   - Write becomes an `apply_patch` `*** Add File` envelope.
   - Edit becomes an `*** Update File` envelope.
3. Feeds each converted row to `fence-hook pre --host codex`, and also feeds the payload jev itself
   would send to `--host claude`. This is a replay, done so that both adapters see the same rows and
   the same `cwd`.
4. Writes `corpus.json`, `codex-decisions.json` and `claude-decisions.json`. Each decision is
   `deny`, `allow`, `none` or `failed` (a watchdog failure). Codex has no allow output: render.mjs
   renders an engine allow on Codex as no output, exit 0. So the comparison counts a Claude `allow`
   equal to a Codex `none`.
5. Prints the following for each host, then the decisions that differ:
   - the per-family table (rule-blocked, allowed, failed)
   - the dangerous blocked count
   - the benign blocked count

The runner exits 1 when any decision differs.

You can also compare two decision files directly:

```sh
node <repo>/packages/fence/test/acceptance/jev/compare.mjs <claude-decisions.json> <codex-decisions.json>
```

The temp roots (`fence-jev-claude-*`, `fence-jev-codex-*` under the system temp directory) are left
in place for inspection. Remove them when you are done. Results go in the acceptance report, with
`<repo>` and `<tmp>` in place of local paths.

## Tests

`packages/fence/test/jev-codex.test.mjs` covers the conversion, the table, the diff and the staged
layout, using inline fixture rows. It needs no network, no uvx and no git process.

## Isolation level

`FENCE_TEST_ISOLATION` (`writes` | `full` | `off`) says how hard the tests and these scripts keep away
from your real files. The helper `packages/fence/test/helpers/isolation.mjs` documents it.

- `writes` (default): nothing is written outside temp directories; children get a temp HOME. Reads of
  normal system config (`/etc/gitconfig`, your git global config) stay allowed, and the real uv package
  cache may be written (it is a download cache, not user data); `full` moves it to temp.
  Both runners always run `git init` with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.
- `full`: also a minimal environment for children and in-process engines, and uv's cache under the
  runner's temp root (`UV_CACHE_DIR`, unless you already set it). The first run then fetches jev again.
- `off`: only unlocks `../cwd-probe/run.sh`, the manual real-host probe, which refuses to run at the other
  levels unless `HOME` or `CLAUDE_CONFIG_DIR` points inside a temp directory.

Any other value is an error.
