# Checking a plan forest for file collisions

Use `triqual plan check-collisions` on a forest plan (phases whose `**Parent:**` differs from the previous phase, or plans linked by a branch parent) before registering it. Phases that are not ancestor and descendant are merged independently, so two of them that change the same file collide when they land.

```
triqual plan check-collisions <plan.md…> [--diff <node> <head>]
```

## What it compares

Each phase is a node `<plan file name without .md>#P<n>` holding the union of the `Create:`, `Modify:` and `Test:` paths of its tasks. A phase on the trunk has no parent, a `P<k>` parent is a node of the same plan, and a branch parent equal to the branch of a phase in another plan given on the command line is that phase. Ancestors and descendants are never compared, so a linear plan has no incomparable pairs. Give every plan of the forest in one call: two plans linked by a branch parent are comparable only when both are given.

Paths are compared literally. A path holding `*` or `{` stops the check with `globs are not supported in Files: <path>`; list the files one by one.

## Output and exit code

```
nodes=3 incomparable pairs=1 collisions=1
COLLISION forest#P2 forest#P3 src/shared.mjs
```

- `nodes=<n> incomparable pairs=<p> collisions=<c>`: always the first line.
- `COLLISION <a> <b> <paths>`: one per pair that shares paths. Move the shared file into an ancestor phase, give one phase the work, or make one phase the parent of the other.
- Exit 0 when clean, 1 on any collision, `OUTSIDE` line, glob or plan that does not read, 2 on bad arguments or an unreadable file.

## Checking finished work: --diff

`--diff <node> <head>` runs `git diff --name-only <base>...<head>` in the current repository, `<base>` being the node's parent branch (else `main`, then `master`), and prints `OUTSIDE <node> <path>` for each changed file the node does not list in its Files. Run it from the repository of the work, with `<head>` the branch or commit of the phase, to find a phase that touched files its plan never declared, which is how a collision that the plan did not predict shows up.

## When to run it

- After writing or generating a forest plan, before `triqual tracking write plan`.
- After editing the `Files:` of a task or the `**Parent:**` of a phase.
- With `--diff`, when a phase's work is done and before its PR is submitted.
