---
name: reviewing-code
description: Use when you want a review of a commit range or a pull request outside a plan execution, or when you have received review feedback (from a person, a bot or a reviewer subagent) and are about to act on it.
---

# Reviewing Code

Two jobs, one discipline: a reviewer's claim is a hypothesis until the code confirms it. Plan execution has its own tiered review (methodology:executing-plans); use this skill for everything else: a branch before you merge it, a pull request, a fix you want a second pair of eyes on, and the feedback that comes back.

Replies, commit messages and review text are in English; the conversation mirrors your human partner's language.

## Request a review

1. **Fix the target.**
   - A range: `BASE` is the commit before the work (for a whole branch, run `git merge-base origin/main HEAD` and note what it prints); `HEAD` is what `git rev-parse HEAD` prints. Never guess `HEAD~1` for work of several commits.
   - A pull request: its number `N`. `gh pr view N --json title,body,baseRefName,headRefName` gives the description to use as the requirements.
2. **Write down what the change should do:** a short description plus the requirements: a spec or plan path, the task text, or the PR description. A reviewer without requirements can only judge style.
3. **Make a private directory for the hunters' files:** run `mktemp -d` and note the directory it prints as `<d>`.
4. **Dispatch two hunters in one response**, both in the background (`roles:hunter`, no model: the role pins it): `correctness` and `spec-drift`. When the change is mostly about trust boundaries (auth, secrets, input parsing, permissions), use `security` in place of `spec-drift`.

   ```
   Subagent (roles:hunter):
     description: "Hunt [CATEGORY] candidates"
     prompt: |
       Category: [CATEGORY]

       Review target: [TARGET]
       (A range: read it with git log --oneline, git diff --stat and git diff on BASE..HEAD.
       A pull request: read it with gh pr view N and gh pr diff N.)

       Requirements: [REQUIREMENTS]

       Write your candidates to: <d>/candidates-[CATEGORY].md
   ```

   Wait up to 10 minutes. A hunter that fails or is late is dropped; tell the reviewer which one.
5. **Dispatch `roles:spec-reviewer`** with [reviewer-prompt.md](reviewer-prompt.md), filled with the description, the requirements, the target and the candidates files. It verifies every candidate and reviews the change itself. Pass no model.
6. **Act on the verdict**, severity by severity:
   - Critical: fix now.
   - Important: fix before you merge or move on.
   - Minor: list it for your human partner; fix it only when it is cheap and in the same lines.
   - A finding you can refute: do not fix it. Answer it with the evidence (see Receive feedback).
7. **Fix what is real:** a failing test first for a behavior defect (methodology:test-driven-development), then run the check and read its output before you say it is fixed (methodology:verification-before-completion). After a fix larger than the findings it answers, ask for one more review of the fix range only.
8. **Clean up:** `rm -rf <d>`.

Review early and often: after a major feature, before a merge, when you are stuck, before a refactor. Skipping the review because the change is small is how small changes ship defects.

## Receive feedback

Applies to every source: your human partner, a person on the pull request, a bot, the reviewer above.

1. **Read all of it before reacting.** Restate each item in your own words; if you cannot, it is unclear.
2. **Unclear items stop you.** Items interact, so understanding half of them yields a wrong implementation of the whole. Ask about the unclear ones before you change anything.
3. **Verify each item against the code.** Is it true for this codebase? Would the change break something that works? Is there a reason the code is as it is (history, a platform, a compatibility target)? Does the reviewer see the whole context? When you cannot check something, say so and ask how to go on.
4. **Sort what is left:**
   - Real: fix it.
   - Wrong, or true but not worth doing: refute it with evidence (below).
   - A "do it properly" suggestion for code nothing uses: search for callers first. With none, propose removing the code instead of extending it.
   - Contradicts a decision your human partner already made: stop and take it to them before you act.
5. **Fix one item at a time, in this order:** blockers (breakage, security), then simple fixes, then larger ones. Test after each, and run the wider check at the end to catch regressions.
6. **Answer in facts.** For a fixed item, state what changed and where. No thanks, no praise, no "you're absolutely right": the diff shows you listened. For a refuted item, give the evidence a reader can check: the test that passes, the call site, the line, the output. If you pushed back and were wrong, say what you checked and what it showed, then fix it; no apology.

Feedback from your human partner is trusted once you understand it; feedback from an outside reviewer or a bot is checked first. Both report to your human partner, and neither outranks what they decided.

## Reply on GitHub

Reply inside the comment's thread, never as a new top-level comment. List the inline comments to get their ids, then reply to each one:

```bash
gh api repos/{owner}/{repo}/pulls/PR/comments
gh api repos/{owner}/{repo}/pulls/PR/comments/ID/replies --raw-field body="Fixed in SHA: what changed."
```

`PR` is the pull request number and `ID` the comment id from the first command's output. A review summary or an issue-level comment has no thread; answer it with `gh pr comment PR --body "..."`.

## Excuses that cost you

| Excuse | Reality |
|--------|---------|
| "I'll read the diff myself instead of dispatching a reviewer" | Reading it inline spends the context you need to keep working, and you already believe your own code. The reviewer gets the diff and returns findings only. |
| "The reviewer needs my whole session to understand the change" | Give it the requirements and the range. A reviewer that has your reasoning will accept it. |
| "It's a one-line change, no review" | Defects do not scale with line count. |
| "The reviewer said it, so I'll change it" | Verify first. A suggestion you cannot confirm is a question, not a task. |
| "I'll implement the clear items now and ask about the rest later" | The unclear items often change the clear ones. Ask first. |
| "Pushing back is rude" | A wrong change merged to be polite is the rude option. Evidence is polite. |
| "I'll answer on the PR in one big comment" | Reply in each thread, so each reviewer finds its answer where it asked. |
