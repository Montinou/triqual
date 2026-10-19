---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

Guessing at a fix is the slowest way to fix a bug. Find the cause first, then change code once.

**Language:** artifacts (tests, fixes, commit messages) are in English; conversation mirrors the language of your human partner's message.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Until Phase 1 is done you may not propose a fix, however small, and a plausible theory is not a root cause. Following the letter of this process is the point: a shortcut that skips a phase is the thing the law forbids.

## When to use it

Any technical problem: a failing test, a production bug, unexpected behavior, a build failure, an integration that does not line up, slow code.

Use it most when it is least tempting: under time pressure, when the fix looks obvious, after a fix already failed, and when you do not understand the problem. A simple bug has a root cause too, and finding it takes minutes.

Inside a plan task the same rule holds. A test that fails when you did not expect it is debugged here. If the root cause sits outside the files your brief gives you, report it to the controller with the evidence (status `BLOCKED` or `NEEDS_CONTEXT`) and do not widen the task to patch it in passing.

## The four phases

Finish each phase before the next.

### Phase 1: Root Cause Investigation

1. **Read the error whole.** Messages, warnings and stack traces often name the cause. Note the file, line and code.
2. **Reproduce it.** Know the exact steps and whether it happens every time. If you cannot make it happen on demand, collect more data; do not guess.
3. **Check what changed.** The diff, recent commits, new dependencies, config and environment.
4. **Instrument every boundary** when the system has several components (CI, build, signing; API, service, database). Before fixing anything, log what enters and what leaves each boundary and whether the environment and config reach it, and run once. The evidence shows which boundary breaks; investigate that one.
5. **Trace the bad value backward** when the error is deep in a call stack: where does it originate, who passed it, and so on up to the source. Fix at the source, not where it surfaces. The technique is in `root-cause-tracing.md`, and `find-polluter.sh` bisects the test that leaves unwanted state behind.

### Phase 2: Pattern Analysis

1. Find similar code in the same codebase that works.
2. If you are following a reference or pattern, read all of it, not a skim.
3. List every difference between the working case and the broken one, however small.
4. Name what the code depends on: other components, settings, environment, assumptions.

### Phase 3: Hypothesis and Testing

1. State one hypothesis in writing: "I think X is the cause because Y". Be specific.
2. Test it with the smallest change that could prove it wrong, one variable at a time.
3. Confirmed: go to Phase 4. Refuted: form a new hypothesis from what you learned. Do not stack another change on the first.
4. When you do not know something, say "I don't understand X" and research or ask. Pretending costs more.

### Phase 4: Implementation

1. **Write the failing test first**: the simplest reproduction of the bug, automated when a framework exists, a one-off script when it does not. Use `methodology:test-driven-development` and watch it fail for the right reason.
2. **Make one fix** for the root cause. No "while I'm here" cleanups, no bundled refactor.
3. **Verify it**: the new test passes, nothing else broke, and the original problem is gone. Use `methodology:verification-before-completion` before you say it is fixed.
4. **A fix that did not work** sends you back to Phase 1 with what you just learned, not to a variation of the same guess. Count your attempts.
5. **Three failed fixes mean the design is wrong.** When each fix exposes new coupling or shared state elsewhere, needs a large refactor, or creates symptoms in another place, stop. Question the pattern itself, and discuss it with your human partner before a fourth attempt. This is a wrong architecture, not a failed hypothesis.

After the fix, `defense-in-depth.md` shows how to make the same bug impossible at several layers, and `condition-based-waiting.md` (with `condition-based-waiting-example.ts`) replaces arbitrary sleeps with waiting for the condition.

## Red flags: stop and go back to Phase 1

- "Quick fix now, investigate later" or "just try changing X"
- Several changes at once, then a test run
- Skipping the test and checking by hand
- "It's probably X" without evidence, or "I don't fully understand but this might work"
- Proposing a fix before tracing the data flow
- "One more attempt", after two failures
- Each fix surfaces a new problem somewhere else

Your human partner's pushback is a signal too: "is that not happening?" means you assumed instead of checking; "stop guessing" means you proposed a fix without understanding; "we're stuck?" means the approach is not working. Return to Phase 1.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "It's simple, the process is overhead" | Simple bugs have root causes; the process is fast on them. |
| "Emergency, no time" | Guess-and-check takes longer than the process. |
| "Try this first, investigate after" | The first fix sets the pattern. Start right. |
| "I'll write the test once the fix works" | An untested fix does not stick, and the test is what proves it. |
| "Several fixes at once saves time" | You cannot tell which worked, and you add new bugs. |
| "I see the problem, let me fix it" | Seeing a symptom is not understanding the cause. |
| "One more try" after two failures | Three failures point at the design. Stop and question it. |

## When there is no root cause in your code

If a careful investigation shows the cause is environmental, timing-dependent or external, you have finished the process. Write down what you checked, handle the case (retry, timeout, a clear error), and add logging so the next occurrence can be investigated. Most "no root cause" verdicts are an investigation that stopped early, so check that yours did not.
