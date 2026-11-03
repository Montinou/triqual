## Landing test

A plan lands its worktree tasks with `node --test` by default: the `Test:` files of the task are run at the phase tip once its commits are folded onto it, and `task-open --worktree` refuses a task whose `Test:` path is not a `.mjs`, `.js` or `.cjs` file. A project whose tests are not node test files (TypeScript, Python, a shell script, a project test runner) states its own landing command in the plan header instead.

**The line.** In the plan header (above the first `## ` or `### Task` heading), one line:

```
**Landing test:** `<command with {files} once>`
```

The command is in backticks and holds `{files}` exactly once; a plan whose `**Landing test:**` has none, or two, is a malformed plan (exit 2 from the task scripts). A `**Landing test:**` line below the header is not read. Example: `**Landing test:** \`npx vitest run {files}\``.

**task-open --worktree.** With the line, a worktree task is refused (exit 3, `Error:` line, before anything is written) only when the plan gives it no `Test:` path, a `Test:` path that is a glob (`*`, `?`, `[`, `]`, `{`, `}`), or a path outside the repository. The `.mjs`/`.js`/`.cjs` rule does not apply: a `.ts` or `.py` file opens a worktree. Without the line, the refusals and their messages are the ones of Parallel tasks, unchanged.

**task-close landing.** With the line, after the task's commits are folded onto the phase tip, `task-close` runs

```
sh -c '<command with {files} replaced by the task's Test paths>'
```

at the landed tip, with the repository root as the working directory. Each `Test:` path is one shell word: it is wrapped in single quotes, and a single quote inside it is written `'\''`, so a path with a space or a quote stays one argument and nothing in it is read by the shell. The paths are joined with a space, in plan order, and are relative to the repository root (the working directory), as the plan wrote them. A `Test:` file that is not in the landed tree still fails the landing before the command runs.

Everything else is as for `node --test`: the run is cut off after `TRIQUAL_LANDING_TEST_TIMEOUT_MS` (default 600000) and a timeout is a failure, the output (stdout, then stderr) is `<workspace>/task-<N>-landing-test.log`, a zero exit appends `Tested: T<N> <sha>` and a non-zero exit, or a timeout, is undone as any failing landing (`git reset --keep` to the previous tip, `BASE:` and `Task <N>: landing conflict — re-run sequential` lines, the `task-<N>-undone` marker, the worktree and its branch removed, exit 3). The refusal names the Landing test (`landing failed: the Landing test exited <code> at the landed tip`), where without the line it names `node --test`.

**Write the command so that it fails.** The landing trusts the exit code: a command that exits 0 without running a test lands the task. Prefer a runner that fails on no matching test, and a command that runs only the given files (`{files}`), never the project's whole suite: CI runs that.
