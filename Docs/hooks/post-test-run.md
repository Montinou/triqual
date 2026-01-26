---
name: post-test-run
description: After running Playwright tests, report results to Exolar
trigger: PostToolUse
tools: [Bash]
---

# Post Test Run Hook

**Triggers after:** Running Playwright tests via Bash

## Condition

This hook activates when the Bash command contains:
- `playwright test`
- `npx playwright`
- `yarn test:e2e`

## Actions

### 1. Parse Test Output

Extract from the command output:
- Total tests run
- Passed count
- Failed count
- Skipped count
- Duration
- Failed test names and error messages

### 2. Check for Dashboard Reporter

If `DASHBOARD_URL` environment variable is set, the `dashboard-reporter.ts` already handles reporting to Exolar automatically.

In this case, just summarize results for the user.

### 3. Manual Reporting (if no dashboard-reporter)

If results weren't auto-reported, offer to report manually:

```
The test run completed:
- Passed: 15
- Failed: 2
- Duration: 45s

Failed tests:
1. login.spec.ts > should redirect after login
2. proposal.spec.ts > should show error on invalid input

Would you like me to report these results to Exolar?
```

### 4. On Failures - Offer Healing

If any tests failed:

```
2 tests failed. Would you like me to:
A) Analyze failures using Exolar semantic search
B) Attempt auto-healing with test-healer agent
C) Show failure details only
```

If user chooses A or B, trigger the appropriate agent/skill.

### 5. Search for Similar Failures

```
query_exolar_data({
  dataset: "semantic_search",
  query: "{error_message}"
})
```

Show if similar failures have occurred before and how they were resolved.

## Skip Conditions

Skip reporting if:
- Tests were run with `--dry-run`
- Output indicates "no tests found"
- User is running quick-test (ad-hoc scripts)

## Example Flow

```
User runs: npx playwright test login.spec.ts

Output shows: 1 passed, 1 failed

Hook activates:
1. Parse: 1 passed, 1 failed
2. Check DASHBOARD_URL → set → reporter handled it
3. Summarize: "1/2 tests passed. 1 failure in login flow."
4. Offer: "Want me to analyze the failure?"

User: "yes"

→ Triggers analyze-failure skill or searches Exolar
```
