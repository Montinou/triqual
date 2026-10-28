---
name: auditing-performance
description: Use when your human partner asks for a performance, cost or speed audit of the triqual plugins, the roles, or the execution workflow ("is the workflow optimized", "why is it slow or expensive", "audit the roles", "repeat the audit"), or after a roles, tier or review change, to check what it did. Collects cost, latency, review-yield and hook numbers from the machine's transcripts and role-eval store, writes the report, and feeds what the audit could not measure back into this skill and the plugins.
---

# Auditing Performance

## Overview

Measure how the plugins and the execution workflow perform, report what the numbers show, and close the gaps in the
measuring itself. Two things improve on every run: the plugins (through the recommendations) and this skill (through
the gaps it could not close). Evidence before opinion: every claim in the report names the dataset it came from or is
listed as unverified.

## The run

1. **Pin the scope with your human partner.** The window (default: the last 10 UTC days against the 10 before), the
   project text (default `triqual`), and the change under test, if any (a version, a tier rule, a model switch).
   Cost and role-eval are machine-wide: say so in the report.
2. **Collect.** Nothing else running (the hook timings need an idle machine). The script sits in this skill's `scripts/` directory;
   run it from the repository root:

   ```
   node <this skill's directory>/scripts/collect.mjs --out <scratchpad>/data --days 10 --hooks
   ```

   It writes `cost_by_role`, `controller_sessions`, `latency`, `tier_by_day`, `hunter_yield` and `hooks` as JSON.
   Cross-check once: its `cost_by_role` totals per period equal `triqual cost --since .. --until .. --project ..`.
   A mismatch is a bug in the script: fix it before reporting.
3. **Read the numbers, in this order**, and say for each what it does and does not show:
   - **Cost by role and period.** Which line is largest? Controller sessions: cache read, cache write and output share,
     average and peak context. Per-run cost of a role before and after a change, with the mix caveat.
   - **Latency.** Median and p90 per role, and the sum of review and fix agents against implementers. A p90 far above
     the median is a runaway, not a slow role.
   - **Tier mix and fix rounds by day.** The share of tasks that ended heavy against declared light. A change in how
     plans are written shows here first.
   - **Hunter yield by tier and category.** Important and critical findings per 100 runs, and precision. A category
     that yields almost nothing important is a candidate to drop; test it as an A/B, never by assumption.
   - **Hooks.** Blocking hooks against the node floor; anything async is CPU, not latency.
   - **Escapes**, from `triqual role-eval summary --by-tier`: what the phase and final reviews caught that the task
     reviews did not. This is the evidence for or against lighter task review.
4. **Check what you are told.** When your human partner states a practice ("I force every task light"), find it in the
   data (declared against effective tier by day) before building on it. When the data contradicts a belief, or a
   belief contradicts the data, say which and show the rows.
5. **Write the report** with the sections below, then publish it as a dashboard artifact (next section).
6. **Close the loop on the skill.** List every number you could not get. For each, either extend `collect.mjs` now
   (small) or add it to the plan as a task (larger). Update **Standing gaps** below: remove what is now measured, add
   what is new. Do not leave a gap only in the report.
7. **Record.** In a repository with strict tracking, add the progress entry for the run (`triqual tracking add`).

## Report sections

1. Executive summary: at most five findings, each with its number.
2. Plugin-by-plugin overhead: hooks, context weight (size of the skills and rules loaded per session).
3. Cost: where it goes, by role and period; the controller apart.
4. The change under test, claim against evidence, with a status of confirmed, plausible or unverified.
5. Recommendations, ordered by value, each tied to a dataset.
6. Gaps: what was not verified and why.

## Publishing

Publish the datasets and the page as a Dashboard artifact, never a hand-written page (see the Artifact tool's
quickstart for a recurring report). The first audit is at https://claude.ai/artifact/3binYqGoCgV2if4P4NdxdU. On a repeat run, read it, upload the new JSON
files as assets and update each `datasets/<id>` document's `source.url` and `updated`, rather than creating a
new one, so the link and the history stay. The numbers on the page come from the dataset files; prose carries no
figure that is not marked to a dataset. Say at the end that the report is private until your human partner shares it.

## Standing gaps (update on every run)

- Quality of the Sonnet roles against Opus: role-eval cannot separate model from tier mix. Needs a record field for
  the reviewer model, or a sampled re-review by Opus.
- Why a task was raised: the reasons live only in workspace ledgers that are deleted at finish. Needs the reason in
  the `task-review` record.
- Cost per task and per tier: cost is by role, review yield is by task, and nothing joins them.
- Phase-level hunter yield: `role-eval summary` reports the task-level records only.
- Prices: `cli/lib/prices.json` carries a "cached" date; re-check it against the list before quoting dollars.
- Wall-clock: latency is the sum of agent durations, and parallel agents overlap.

## What the audit has found so far

Keep this short and dated; it is the baseline the next run compares against.

- 2026-10-28 (windows 10-09..10-18 and 10-19..10-28): total estimated spend fell from $665 to $378; the controller
  is the largest line; review and fix agents took more agent-hours than implementation; spec-drift and state hunters
  yielded little at the task level; tasks declared light rose sharply from 10-27 with fix rounds per task falling.
  the generic-agent runs were deliberate one-off background jobs started from the main session, not part of the plan
  loop.

## Red flags

| You think | In fact |
|---|---|
| "The totals went down, so the change worked" | Work volume differs between windows. Compare per run and per task. |
| "A cheaper role is a better role" | Cost is measured here; quality is not, unless the escapes say so. |
| "I can call the hunter or tier cheap, drop it" | Show the yield rows, and propose an A/B. |
| "The report is the deliverable" | The gaps list and the collector are, too. |
