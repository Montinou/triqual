# Roles calibration, 2026-10-29

Numbers only: this file holds no diff text, no content of the sampled commits and no names of the sampled projects. It is the baseline a repeat calibration compares against.

## Method

- Stored evidence: `triqual role-eval summary` over the records at or after 2026-10-20: 365 task reviews (heavy 229, standard 68, light 59), hunters 5,528 candidates (Claude, model claude-haiku-5-5; Codex hunters gpt-6-luna 232 runs).
- Replay (diff-only reviewers: commit message and diff, no plan, no repository): 8 sampled commits (4 dry run, 4 verification; one of the dry-run items is a phase diff), settings per commit, one Opus judge per commit over the pooled findings (ids prefixed by setting), recall against the pooled confirmed groups of that commit, precision = confirmed findings over findings.
- Effort comparison: `final-adversarial-reviewer` at effort low and medium on two phase diffs (plan phases 2 and 3 of 2026-10-28), judged the same way.
- Implementer spot runs: `tdd-implementer` at effort high and medium on two tasks (T8, T9 of the same plan) in scratch worktrees at the task's base commit, no commit, scored against the committed test files of the real task (which include review-fix-round tests the brief did not list).
- Spend of the replay: dry run about 9.8 USD (triqual cost delta over the window, includes controller overhead); verification runs not separately priced.
- Caps: 20 reviewer runs and 4 implementer runs requested by the owner for the verification; 16 + 4 reviewer runs and 4 implementer runs were run; one implementer run was blocked by a tool-permission denial.

## Table 1: reviewer and hunter settings, 8 commits

| setting | runs | findings | confirmed | precision | recall (all) | recall (medium+ severity) | unique confirmed groups per run |
|---|---|---|---|---|---|---|---|
| opus spec-reviewer | 8 | 31 | 20 | 0.65 | 0.67 | 0.69 | 0.88 |
| sonnet spec-reviewer | 8 | 11 | 7 | 0.64 | 0.26 | 0.38 | 0.13 |
| haiku hunter (A) | 8 | 34 | 12 | 0.35 | 0.41 | 0.50 | 0.50 |
| haiku hunter (B), dry run only | 4 | 16 | 12 | 0.75 | 0.47 | 0.64 | 0.50 |
| sonnet hunter, verification only | 4 | 10 | 4 | 0.40 | 0.50 | 0.20 | 0.25 |

List prices per million tokens (USD, input/output): opus-5-5 4/20, sonnet-5-5 2/10, haiku-5-5 0.1/0.5.

## Table 2: hunters in the store, claude-haiku-5-5

| category | runs | candidates | important+critical per candidate | confirmed per candidate | refuted per candidate | duplicate of another hunter |
|---|---|---|---|---|---|---|
| correctness | 600 | 1903 | 6.3% | 52.9% | 38.5% | 2.1% |
| security | 466 | 1523 | 3.6% | 23.7% | 58.2% | 12.9% |
| spec-drift | 327 | 1130 | 2.7% | 24.0% | 53.3% | 14.8% |
| state | 265 | 972 | 2.5% | 25.7% | 37.4% | 29.5% |

Codex gpt-6-luna (different plans and tasks, not comparable): 0.6 candidates per run, important+critical per candidate 52.5% correctness, 60% security.

## Table 3: review tiers (claude)

| tier | task reviews | fix rounds per task | spec findings per task | gate findings per task | raised |
|---|---|---|---|---|---|
| heavy | 198 | 0.46 | 3.94 | 2.53 | 61 |
| standard | 53 | 0.08 | 2.53 | 1.51 | 15 |
| light | 59 | 0.02 | 0.56 | 1.56 | 0 |

Blocked tasks (5-round breaker): 0 of 365. Safety shadow (retired): agreement with the gate 87%, 4 of 21 shadow-only candidates right.

## Table 4: final-adversarial-reviewer effort, two phase diffs, 10 distinct real defects

| effort | findings | confirmed | recall | precision | tokens per run |
|---|---|---|---|---|---|
| low | 9 | 7 | 0.70 | 0.78 | 107k and 82k |
| medium | 13 | 10 | 0.80 | 0.77 | 133k and 91k |

## Table 5: implementer effort, scored against the committed tests of the real task

| task | effort | tests passed |
|---|---|---|
| T8 sampler | high | 7 of 10 |
| T8 sampler | medium | 6 of 10 |
| T9 package builder | high | 6 of 8 |
| T9 package builder | medium | blocked (tool-permission denial, no work done) |

Both T8 runs missed the same three tests (a custom exclude never lifts the client exclusion; a case-sensitive or global RegExp cannot bypass the filter; the export flattening shape).

## Decisions (ledger rulings, 2026-10-29)

- spec-reviewer: sonnet -> opus (effort medium).
- hunter: haiku-5-5, effort medium, unchanged; the phase review sends 3 hunters (correctness, security, spec-drift); task-level hunters unchanged.
- final-adversarial-reviewer: effort low, unchanged.
- tdd-implementer: effort high, unchanged.
- review-fixer budget, safety-reviewer, complex-implementer: unchanged, no data.

## Standing gaps (what this calibration could not answer)

- Fixer: no replay; no per-run cost or turn data to size a budget.
- Safety gate model and effort: not replayed.
- Implementer effort: one run per cell, one cell blocked.
- Planted-defect recall (judge recall on seeded defects): not run; the seeder exists.
- Light-tier escape severity: 0.81 findings per task reach the phase review; their severity split is not in the store.
- The judge is Opus: it may favour Opus findings; no second judge model was used.
- Reviewers saw the diff only, not the plan or the code around it.
- Sample size: 8 commits from a few repositories; 2 phase diffs.

## Repeat

Run the replay again after the first two plans execute under these settings: `node scripts/replay.mjs sample` (from this skill's directory), `package`, give each setting's reviewer `replay-review-prompt.md` and one judge `replay-judge-prompt.md` (ids prefixed by setting), then `score`; compare the tier mix, fix rounds and escapes with the 2026-10-28 baseline.
