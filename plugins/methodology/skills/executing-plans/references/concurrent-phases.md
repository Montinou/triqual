## Concurrent phases

Read this when more than one phase is ready, or a phase becomes ready while another is running. The Process, The Thin Controller and steps 7 and 8 stay the rules of each phase; this section says how several phases run at the same time.

**Ready.** A phase is ready when it is pending and every parent of it is submitted (in local mode, `done`). `node scripts/stack.mjs status PLAN_FILE` prints `"ready": true` for it, and `"base"` for a phase that has started (the commit its range begins at). A plan of one chain has one ready phase at a time, so it runs as before; phases that share a parent, or a phase and a branch of the forest, can be ready together.

**Start.** The main session runs `node scripts/stack.mjs phase PLAN_FILE N` once for each ready phase, one after another, each after the previous one has returned, never two at once: the calls move HEAD and the stack state of the main checkout, and the first phase started holds it. A phase started while another holds the main checkout prints `workdir:` and is built in its own phase worktree. The main session dispatches orchestrators only then: one `roles:phase-orchestrator` per phase, all in one message, in the background, each with its `[PHASE_WORKDIR]`: the `workdir:` line of its `phase` call, the main checkout when it printed none.

**Waiting.** Each orchestrator's completion arrives on its own as its final message. In Codex `wait_agent` wakes on any child, so the main session handles whichever phase returns first. The waiting rule of The Task Loop holds: block, never poll.

**A phase returns.** When one orchestrator returns `Phase: P<n> done`, the main session ends that phase as steps 7 and 8 say, without waiting for the other running phases: the Phase check in the phase's checkout (one Phase check at a time across phases; a second one waits for the first), the phase review, its fixer and its re-review, with PHASE_BASE the phase's `base` from `status` and PHASE_TIP its branch tip, and the fixer's `[WORK_DIR]` the phase's workdir; then `done`, which removes the phase worktree; then `submit`; then it starts what became ready, as Start says.

**HEAD.** In a phase built in a phase worktree, a `HEAD` written in a command of this skill, such as `tier-check PLAN_FILE N FIX_BASE HEAD` or `review-package PLAN_FILE FIX_BASE HEAD`, is that worktree's: pass the sha `git -C <workdir> rev-parse HEAD` prints, never the main checkout's `HEAD`.

**Serial.** A ready phase that is not started gets `Serial: P<n> — <reason>` in the ledger first, the reason a fact: a block, the Fallback, the end of the run. The main session never serializes phases for caution.

**A stop.** One orchestrator's `BLOCKED` stops that phase only: the running phases go on to their own end, and no new phase starts until the decision (see On `BLOCKED`). A rate limit ends the run for all, once the running orchestrators have returned.

**Resume.** `node scripts/stack.mjs status PLAN_FILE` is the resume point: an active phase gets an orchestrator with `node scripts/phase-resume PLAN_FILE N` as its resume note, a done phase its end (steps 7 and 8), a ready phase its start.

**Commands.** The commands of the procedure, in order:

```text
node scripts/stack.mjs init PLAN_FILE
node scripts/stack.mjs status PLAN_FILE
node scripts/stack.mjs phase PLAN_FILE N
node scripts/stack.mjs done PLAN_FILE N
node scripts/stack.mjs submit PLAN_FILE N
node scripts/phase-resume PLAN_FILE N
```
