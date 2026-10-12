# Pressure scenarios (spec §13, plan T12)

Run by the coordinator, not by `npm test`. Each scenario in `scenarios.md` is given to a **generic** subagent with an
explicit model (so the result measures the skill text, not a role's own prompt), twice:

1. **Baseline:** the scenario alone. A compliant baseline means the scenario lacks pressure — strengthen and rerun.
2. **With the skill:** the scenario plus the listed forked skill file(s), pasted verbatim.

The subject answers in text only (no tools): the exact actions and commands it takes next, in order. The coordinator
grades against the pass criteria and records PASS/FAIL with the deciding sentence in the results table. On a FAIL with
the skill, tighten the skill (writing-skills: RED → rewrite → GREEN) and rerun that scenario.

Runner: `node run.mjs [--model sonnet] [--only S1,S3] [--variant baseline|skill]` runs each scenario with headless
`claude -p` in a fresh temp directory with `--setting-sources project,local`, so no CLAUDE.md, plugin, skill or hook
leaks in (subagents inherit the coordinator's session context and are not clean subjects). Outputs land in
`$TMPDIR/pressure-<random>/<id>-<variant>.md`: the exit code, the answer, and anything `claude -p` wrote to stderr.
