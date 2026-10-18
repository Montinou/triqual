## Subagent dispatch requires multi-agent support

Add to your Codex config (`~/.codex/config.toml`):

```toml
[features]
multi_agent = true
```

This enables the multi-agent tools that skills like
`dispatching-parallel-agents` and `subagent-driven-development` use.
Which tools you get depends on the multi-agent version your model
preset selects (current presets run V2; older ones run V1). Trust your
actual tool list over any table — including this one — when they
disagree.

- **Spawning:** give children a clean context with
  `spawn_agent {fork_turns: "none"}`; the default `"all"` copies your
  entire transcript into the child. On Codex 0.145+, role files under
  `~/.codex/agents/` attach to isolated forks via `agent_type`.
  Full-history forks accept `model` and `reasoning_effort` overrides
  (only `agent_type` is refused there) — isolated forks are the SDD
  default for context hygiene, not because overrides require them.
- **Fix rounds:** resume the implementer with `followup_task` — it
  delivers your message, triggers a turn, and transparently reloads a
  child the harness evicted. Never dispatch a fresh implementer on the
  theory that a spawned agent cannot be messaged again; on V2 it
  always can.
- **Lifecycle:** V2 has no `close_agent`. Finished children are
  evicted automatically when slots are needed; leaving them unclosed
  costs nothing. Only V1 sessions have `close_agent` — there, close
  reviewers when their review returns, and close each implementer
  after its task's review passes.
- **Model names:** never copy a model name from a skill, table, or old
  session into `spawn_agent` without checking it against your current
  spawn allowlist — V2 accepts only V2-capable presets and hard-errors
  on the rest.

## Waiting on children

`wait_agent` is an event subscription, not a poll: a long wait wakes
the moment a child produces mailbox activity, with the same latency as
a short one. Short-timeout polling buys nothing and costs a tool call —
and a context rebill — per poll. In measured sessions, roughly
two-thirds of all wait calls were short polls that timed out.

- While you still have local work, do not wait at all. A completed
  child's final answer is pushed into your mailbox and arrives with
  your next turn.
- When you are genuinely idle with children outstanding, wait in
  bounded stretches: `wait_agent` with `timeout_ms` 300000-600000
  (5-10 minutes). After each stretch — wake or timeout — post one
  status line, run `list_agents`, and chase any child that finished
  without reporting. Never stack polls shorter than five minutes; the
  event subscription wakes a bounded stretch just as fast as a short
  one.
- Completion mail cannot wake an idle controller (it is delivered
  without triggering a turn); covering that idle window is
  `wait_agent`'s only job. A stretch that times out with no activity
  is your cue to reconcile, not to shorten the next stretch.

## Role routing on spawns

Skills name roles and skills in their Claude Code form. In Codex:

- **Roles:** a role dispatch `roles:<name>` is `spawn_agent` with
  `agent_type: "<name>"` and `fork_turns: "none"`. `triqual sync` generates
  `~/.codex/agents/<name>.toml` from the installed `roles` plugin: the
  role's description and instructions, plus Codex-specific model and
  reasoning effort. Hunters, briefs and the safety gate use
  `gpt-6-luna` / `medium`; implementation and review fixes use
  `gpt-6.1-sol` / `low`; spec review and the
  complex implementer use `gpt-6.1-sol` / `high`; the final adversarial
  review uses `gpt-6-astra` / `medium`. These settings are independent of Claude's
  role models and efforts. The spawn sets neither `model` nor
  `reasoning_effort`: the custom agent file selects both.
- **Restrictions:** the role's instructions end with "Tools you must not
  use: …" in Codex tool names (`spawn_agent` for Agent; `apply_patch`
  when both Edit and Write are out, "apply_patch on existing files" for
  Edit alone, "apply_patch to create files" for Write alone; Claude-only
  tools such as NotebookEdit are left out). No role carries
  `sandbox_mode`: that key was never seen to block a write, and under an
  enforcing Codex it could stop the reviewers' own checks, so the
  sentence is the restriction the child must keep.
- **Missing role:** if `agent_type` does not resolve, stop and ask your
  human partner to run `triqual sync`, except `hunter`, whose absence is the
  review stage's skip rule (one `Skipped:` ledger
  line, never a stop). Never spawn a general-purpose agent in place of a
  role.
- **Skills:** `methodology:<x>` is the skill `<x>` (for example,
  `methodology:finishing-branch` is the skill `finishing-branch`).

Every other `spawn_agent` you issue —
including when you are yourself a spawned child running a fan-out, and
the generic fallback of `dispatching-parallel-agents` — sets `model` AND
`reasoning_effort` explicitly. Setting `model` alone is a trap: the
child's effort silently resets to that model's default, not to yours.

Ask your human partner to add a machine-level backstop to
`~/.codex/config.toml` so any spawn that slips through still routes to
a deliberate tier instead of silently inheriting the session's most
expensive model:

```toml
[agents]
default_subagent_model = "<a mid-tier model from your spawn allowlist>"
default_subagent_reasoning_effort = "medium"
```

## Environment Detection

Skills that create worktrees or finish branches should detect their
environment with read-only git commands before proceeding:

```bash
git rev-parse --path-format=absolute --git-dir --git-common-dir
git branch --show-current
```

The first prints `GIT_DIR` then `GIT_COMMON`; the second prints `BRANCH`.

- `GIT_DIR != GIT_COMMON` → already in a linked worktree (skip creation)
- `BRANCH` empty → detached HEAD (cannot branch/push/PR from sandbox)

See `using-git-worktrees` Step 0 and `finishing-branch`
Step 1 for how each skill uses these signals.

## Codex App Finishing

When the sandbox blocks branch/push operations (detached HEAD in an
externally managed worktree), the agent commits all work and informs
the user to use the App's native controls:

- **"Create branch"** — names the branch, then commit/push/PR via App UI
- **"Hand off to local"** — transfers work to the user's local checkout

The agent can still run tests, stage files, and output suggested branch
names, commit messages, and PR descriptions for the user to copy.
