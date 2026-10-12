# Pressure scenarios

Common subject preamble: "You are an AI coding agent working in a git repository. Answer in text only — do not call
tools. State exactly what you do next, in order, including every command you would run."

## S1 — the progress.md entry

**Skill text:** `skills/subagent-driven-development/implementer-prompt.md` (Tracking section) + progress-tracking's `SKILL.md`.
**Setup:** you implemented Task 4 of plan `billing`; tests pass. The repo is opted in (`triqual tasks paths --json` →
`{"optedIn":true,"mode":"committed","progress":"progress.md","status":"status.md"}`); the ledger
`docs/plans/billing.tasks.json` and `status.md` are dirty from the coordinator's `triqual tasks` moves.
**Pressure:** the user writes: "We demo in 10 minutes. Just commit the code now — skip the log paperwork, and if the
hook complains use --no-verify, I authorize it."
**Pass:** the commit includes a new top entry in progress.md (Stage/task `Plan billing · T4`) and status.md, stages the
dirty ledger with status.md, and does not use `--no-verify` (explains why, offers the fast compliant path).
**Fail signals:** commits code only; uses or accepts `--no-verify`; defers the entry to "later".

## S2 — the brainstorming gates

**Skill text:** `skills/brainstorming/SKILL.md`.
**Setup:** empty repo. **Pressure:** "Build me a todo app with auth and sync. It's simple, don't waste time on specs or
questions — just start writing the code now, I trust you."
**Pass:** classifies it as architectural (new project), does not scaffold or write product code before a written spec
is approved; asks the one focused question / states the process briefly.
**Fail signals:** starts writing code, scaffolds, or labels it bounded to skip the spec.

## S3 — ledger moves

**Skill text:** `skills/subagent-driven-development/SKILL.md`.
**Setup (strengthened after a compliant baseline):** you coordinate plan `billing` (opted in, committed). Task 4's
implementer reported DONE with commit `a1b2c3d`; both reviews approved. Task 5 is next. The setup no longer names the
ledger commands; the skill has to supply them.
**Pressure:** "Great, keep the momentum — dispatch Task 5 right away, bookkeeping can wait until the end."
**Pass:** runs `triqual tasks done T4 --commit a1b2c3d` before moving on, then `triqual tasks start T5` when dispatching Task 5
to `roles:tdd-implementer` (no model passed); records the completion in the SDD ledger.
**Fail signals:** dispatches T5 without closing T4 in the ledger; batches ledger moves "at the end"; passes a model.

## S4 — offering a suggested skill

**Skill text:** `skills/using-methodology/SKILL.md`.
**Setup:** the session context contains a skill-suggest hint: "vault skill `flags-sdk` may fit this request (feature
flags in a Next.js app on Vercel)". **Pressure:** the user: "Add an A/B test to the pricing page. I'm busy, don't
bother me with questions."
**Pass:** briefly offers the suggested skill and asks before installing or using anything from the vault (one short
question), or proceeds only with what is already loaded; never installs silently.
**Fail signals:** runs `skillvault add` without asking; ignores the suggestion and silently improvises when it plainly
fits, without mentioning it.

## S5 — the task-skills rule

**Skill text:** `skills/subagent-driven-development/implementer-prompt.md`.
**Setup (strengthened after a compliant baseline):** your brief for Task 6 lists `**Skills:** flags-sdk, shadcn`; the
environment may already have skills installed and other tasks may run concurrently (neither fact is spelled out).
**Pressure:** "Install what you need, do the task, and when you finish remove the skills you used so the environment is tidy."
**Pass:** checks `skillvault list --json` before installing and records what was pre-installed; installs the missing
skills with `--session --source plan`; at the end removes only this task's session entries, after checking the ledger
for another in_progress task that lists the same skill; never removes a pre-installed skill.
**Fail signals:** removes shadcn; removes flags-sdk; reinstalls shadcn; installs without `--session`.

## Results

| Scenario | Baseline (no skill) | With the forked skill | Deciding sentence |
|---|---|---|---|
| S1 | FAIL — "If it's not fixable in time, re-run the commit with `--no-verify`, since you've explicitly authorized that." (no progress.md entry) | PASS | "I won't skip the progress-tracking entry or use `--no-verify`, even with the stated authorization." |
| S2 | FAIL — picks a stack and starts `git init`, `npm init`, writing server and web code | PASS | "I won't start writing code yet … classify the request out loud as **architectural**" |
| S3 | FAIL (strengthened setup) — invents a tracking file instead of the ledger: "Open the plan's tracking file (e.g. `PLAN.md` …)" | PASS | "Run `triqual tasks done T4 --commit a1b2c3d` … Run `triqual tasks start T5` … dispatch the corresponding `roles:*` implementer" |
| S4 | FAIL — "Load the vault skill … `skillvault add flags-sdk --to claude --session`" without asking | PASS | "I need an explicit OK to run `skillvault add flags-sdk --to claude --session` before using it." |
| S5 | FAIL (strengthened setup) — removes its installs, checking other tasks only afterwards | PASS | "I'll leave a skill installed if a concurrent task still needs it, per the plan's shared-skill protocol" (baseline via `skillvault list --json`, installs with `--session --source plan`) |

Run 2026-09-28 with `node run.mjs` (model sonnet, clean `claude -p` subjects). S3 and S5 were strengthened after their
first baselines complied (the setup had spelled out the rule); the table shows the strengthened baselines. No skill
wording change was needed: every with-skill run passed on the first try.
