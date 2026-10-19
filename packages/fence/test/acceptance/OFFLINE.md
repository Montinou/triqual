# Offline acceptance results

The spec's offline acceptance items 1–6, recorded as counts only. The detailed outputs (per-call decisions, the
replay's deny list and latency samples) stay local and are never committed or published.

Recorded 2026-10-19 on fence 0.0.0-test (Phase 10), macOS. Policy for items 1, 2 and 5: `strict.json`. Policy for
items 3 and 4: `example.json` (install's default), standing in for the owner's live policy, which does not exist
yet because fence is not installed.

## Summary

| # | Item | Target | Result | Met |
|---|---|---|---|---|
| 1 | jev 1.2.0, dangerous blocked (Claude) | 503/503 | 438/503 | no |
| 1 | jev 1.2.0, dangerous blocked (Codex) | 503/503 | 438/503 | no |
| 1 | jev 1.2.0, controls blocked by a rule (both) | 0/68 | 0/68 | yes |
| 2 | Differing decisions, Claude vs Codex | 0 | 0 of 571 | yes |
| 3 | Would-allow denies in the replay | under 1% | not labelled; 1,236 denies of 2,671 calls | no (see below) |
| 4 | Latency through the watchdog | p50 < 100 ms, p95 < 250 ms | p50 574 ms, p95 844 ms | no |
| 5 | Self-protection table | every route denies | 18/18 rows deny | yes |
| 6 | Compaction output contains the rule text | yes | yes (CI test) | yes |

## 1. jev, per family (Claude)

| category | blocked |
|---|---|
| destructive_file_ops | 53/97 |
| destructive_git_ops | 97/97 |
| guard_self_modification | 40/61 |
| network_exfiltration | 71/71 |
| privilege_changes | 72/72 |
| secret_reads | 105/105 |

0 hook errors. Each Claude run also had one watchdog deny (the engine passed its 3,000 ms deadline at a machine load
average of about 70 to 110), not a rule decision: in one run it fell on a dangerous payload, in the last run on a
control (`echo ok | echo "set the env var"`). The Codex runner's decisions are rule decisions only: 438/503 and 0/68.

The 65 misses are the same on both hosts, and none is a bypass of a rule. All are policy scope:

| miss | count | why it is allowed |
|---|---|---|
| recursive delete of a path inside the repository | 22 | `strict.json` denies deletes outside the repository only |
| truncate of a file inside the repository | 21 | same: overwrites inside the repository are allowed |
| shred of a file inside the repository | 1 | same |
| delete of the project's own `.claude/hooks` | 21 | not fence's hooks; fence protects only its own files |

## 3. False blocks (replay)

Sample: the 20 newest main-session transcripts (3,207 tool calls, 2,671 decided, 2,000 of them shell commands),
replayed against copies; the full local history (about 12,500 transcripts) would take days at the measured speed.

| decision | calls |
|---|---|
| deny | 1,236 |
| undecided (host's normal permission flow) | 1,434 |
| allow | 0 |
| failed (watchdog) | 1 |

About 550 of the denies come from sessions whose working folder no longer exists (a replay artifact). The rest fall
into these groups, before labelling:

| group | denies |
|---|---|
| inline interpreter code (`node -e`, heredoc to `python3 -`) | 160 |
| credentials rule on a path fence cannot resolve | 123 |
| self-protection: repository root not resolvable | 89 |
| write target unknown (assignment from a command substitution) | 52 |
| git hooks unknown (`git fetch` in a worktree) | 43 |
| agent-written script | 38 |
| script path | 31 |
| write then run | 31 |
| shell constructs (zsh syntax, process substitution, parameter expansion) | 57 |

The would-allow rate is far above 1% before any labelling. Not met; to be addressed before the 0.1.0 publish.

## 4. Latency

Measured over the replay's 2,671 calls at a machine load average of 30 to 230, so the figures overstate the cost.
The last jev run's 570 calls (load average 35 to 110) split the time: p50 729 ms and p95 1,412 ms in total, of which
the engine took p50 130 ms and p95 359 ms. Process start-up, not policy evaluation, dominates. Not met; to be
re-measured on a quiet machine before choosing the static-binary watchdog.
