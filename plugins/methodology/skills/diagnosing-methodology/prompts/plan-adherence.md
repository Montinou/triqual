Read `prompts/analyst-common.md` first; it gives your role, inputs,
context-safety rules, and the return format. This file adds the dimension.

Dimension: Plan adherence

Recover the plan the session agreed to, then map each plan step to what
happened. "Plan" here means any agreed course of action, not git commits.

1. Find the agreed plan: a design or plan agreed in chat (look for the
   assistant text preceding a human "yes/ok/go ahead"), a spec or plan file
   written during the session (tool calls that write under `docs/`,
   `plans/`, `specs/`, or any file the human named), a todo-list record whose
   meaning was established in the case file, or any numbered checklist in
   assistant text. Quote each plan step with its `path:line`.
2. Mark structural events between the plan and its execution: compaction
   events identified during discovery, resumes, aborted turns, and associated
   session dispatches. Note their line numbers; plan drift right after one of
   these is a distinct finding.
3. For each plan step, find the tool calls and assistant text that
   executed it, or establish that none did. Report:
   - steps skipped (no execution found; quote the plan step);
   - steps executed out of order (line numbers show the order);
   - steps silently changed (execution differs from the plan step in a
     way the assistant never announced; quote both);
   - steps invented (work done that no plan step covers);
   - drift immediately after a structural event (cite the event line and
     the first divergent action).
4. Read the plan's shared ledger, `sdd-ledger.md` in
   `.methodology/sdd/<plan>/`. The main session deletes the workspace when
   the plan finishes, so when the file is gone take the lines from the transcript's
   tool calls that wrote them. It holds one `Tier: T<N> <tier>` line per
   task, written at setup, and a `Tier raised: T<N> <from> → <to> — <reason>`
   line whenever a task's tier went up. A tier is never lowered. For each
   task report the `Tier:` line, every `Tier raised:` line with its reason
   quoted, and the review lines that follow (`Round 1:`, `Round 2:`,
   `Review:`), so the reader sees whether a raise came before the review of
   the new tier. Also report: a task with a `Tier raised:` line and no review
   line after it; a task with no `Tier:` line; any line that puts a task at
   a lower tier than an earlier line did. Do not say whether a raise was
   right or wrong; quote the lines. The same ledger also records, per phase,
   `Orchestrator: P<n> — <summary first line>` (the main session's note of
   what the phase's orchestrator subagent returned), `Prep: T<N> r<R> <sha>`
   (a review round prepared), `Landed: T<N> <sha>` (a task landed from its
   worktree), `Round 1: P<n> — hunters <done>/<sent>` and
   `Phase review: P<n> clean | fixed | blocked`: report them in order beside
   the plan's steps, and quote both where a plan step and these lines disagree.
5. If there is no recoverable plan, say so as the only finding, with
   the lines you checked.
