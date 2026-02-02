# Documented Learning Loop

> **Category:** Architecture | **Updated:** 2026-02-02

Triqual enforces a documented 6-stage learning loop that prevents erratic workflows and ensures context survives compaction.

---

## Overview

The learning loop is **ENFORCED by hooks** that BLOCK actions until documentation is complete:

```
ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
```

### Key Principles

1. **Hooks use exit codes to BLOCK actions** until documentation is complete
2. **Run logs** at `.triqual/runs/{feature}.md` track each stage
3. **Knowledge file** at `.triqual/knowledge.md` accumulates project patterns
4. **Context survives compaction** because it's in files, not memory

---

## The 6 Stages

### Stage 1: ANALYZE

**Purpose:** Review requirements and identify test cases

**Documented In:** Run log section `### Stage: ANALYZE`

**Content:**
- Acceptance criteria from requirements
- User flows to test
- Test cases identified
- Edge cases and error scenarios

**Example:**
```markdown
### Stage: ANALYZE

**Acceptance Criteria:**
1. User can login with valid credentials
2. Invalid credentials show error message
3. Password field is masked
4. Login redirects to dashboard

**Test Cases Identified:**
- Happy path: successful login
- Error: invalid username
- Error: invalid password
- UI: password masking
```

### Stage 2: RESEARCH

**Purpose:** Search for patterns and existing code to reuse

**Documented In:** Run log section `### Stage: RESEARCH`

**Content:**
- Quoth patterns found
- Exolar similar tests
- Available Page Objects, helpers, fixtures
- Test data available

**Example:**
```markdown
### Stage: RESEARCH

**Quoth Patterns:**
- Auth tests use `StorageState` pattern
- Login buttons use `data-testid="login-submit"`

**Exolar History:**
- 3 similar auth tests passed in last 30 days
- No known flakes in login flow

**Existing Code:**
- Page Object: `pages/LoginPage.ts` (reuse ✅)
- Helper: `helpers/auth.ts` (reuse ✅)
- Fixture: `fixtures/users.json` (reuse ✅)
```

### Stage 3: PLAN

**Purpose:** Document test strategy and tools

**Documented In:** Run log section `### Stage: PLAN`

**Content:**
- Test strategy and priorities
- Tools/resources to use (which Page Objects, helpers)
- New artifacts to create (if any)
- Rationale for approach

**Example:**
```markdown
### Stage: PLAN

**Test Strategy:**
1. Use existing `LoginPage` Page Object
2. Create new `DashboardPage` for post-login validation
3. Use `users.json` fixture for test data
4. 4 test cases (happy path + 3 error cases)

**Priorities:**
- P0: Happy path login → dashboard
- P1: Invalid credentials error
- P2: Password masking
- P3: Form validation

**New Artifacts:**
- `pages/DashboardPage.ts` (needed for post-login)
```

### Stage 4: WRITE

**Purpose:** Generate test code with hypothesis

**Documented In:** Run log section `### Stage: WRITE`

**Content:**
- Hypothesis: approach and rationale
- Files created
- Patterns applied

**Example:**
```markdown
### Stage: WRITE

**Hypothesis:** Using `StorageState` pattern from Quoth, we can reuse `LoginPage` and new `DashboardPage` to test login flow. Password masking verified via `input[type="password"]` attribute.

**Files Created:**
- `.draft/tests/login.spec.ts`
- `.draft/pages/DashboardPage.ts`

**Patterns Applied:**
- Quoth: StorageState auth pattern
- Existing: LoginPage reused
- Existing: users.json fixture
```

### Stage 5: RUN

**Purpose:** Execute tests and document results

**Documented In:** Run log section `### Stage: RUN (Attempt N)`

**Content:**
- Result: PASSED | FAILED
- Category (if failed): FLAKE | BUG | ENV | WAIT | TEST_ISSUE
- Analysis of failure (if applicable)
- Hypothesis for fix (if failed)

**Example:**
```markdown
### Stage: RUN (Attempt 1)

**Result:** FAILED
**Category:** WAIT
**Analysis:** Dashboard loads async, URL changes before content ready

**Hypothesis for Fix:** Add `networkidle` wait after login

---

### Stage: RUN (Attempt 2)

**Result:** PASSED
```

### Stage 6: LEARN

**Purpose:** Extract patterns for future tests

**Documented In:** Run log section `### Stage: LEARN`

**Content:**
- Pattern extracted
- Why it matters
- Proposed to Quoth (yes/no)

**Example:**
```markdown
### Stage: LEARN

**Pattern:** This project requires `networkidle` wait after auth redirects

**Why:** Dashboard loads async content, URL change isn't sufficient

**Proposed to Quoth:** Yes - captured as "auth-redirect-timing" pattern
```

---

## Gate-Based Enforcement

Hooks **BLOCK actions** until documentation requirements are met:

### Gate 1: Draft Folder

**Trigger:** Writing `.spec.ts` file

**Block Condition:** File path NOT in `.draft/` (and file doesn't already exist)

**Unblock Action:** Write to `.draft/tests/` instead

**Enforcement:** `pre-spec-write.sh` hook with exit code 2

### Gate 2: Pre-Write Documentation

**Trigger:** Writing `.spec.ts` file

**Block Condition:** No run log OR missing ANALYZE/RESEARCH/PLAN stages

**Unblock Action:** Create run log with all required stages

**Enforcement:** `pre-spec-write.sh` hook with exit code 2

**Example Block Message:**
```
🚫 BLOCKED: No run log found for "login"

Before writing test code, you MUST create a run log at:
.triqual/runs/login.md

Required stages:
1. ANALYZE - Review requirements, identify test cases
2. RESEARCH - Search Quoth for patterns, check Exolar
3. PLAN - Document test strategy, tools to use
4. WRITE - Document hypothesis

Then retry this write operation.
```

### Gate 3: Context Files

**Trigger:** Writing `.spec.ts` file

**Block Condition:** No context files at `.triqual/context/{feature}/`

**Unblock Action:** Call `triqual_load_context({ feature })` MCP tool

**Enforcement:** `pre-spec-write.sh` hook with exit code 2

**Why:** Context files contain proven patterns from Quoth, failure history from Exolar, and codebase analysis

### Gate 4: Post-Run Log Update

**Trigger:** After `playwright test` command

**Block Condition:** Run log not updated with results

**Unblock Action:** Add RUN stage with result, category, analysis

**Enforcement:** `post-test-run.sh` sets `awaiting_log_update` flag

### Gate 5: Retry Limit

**Trigger:** 2+ failures in same category

**Block Condition:** No external research (Quoth/Exolar) documented

**Unblock Action:** Search Quoth patterns, query Exolar history, document findings

**Enforcement:** `pre-retry-gate.sh` hook with exit code 2

### Gate 6: Deep Analysis

**Trigger:** 12+ attempts

**Block Condition:** No deep analysis documented

**Unblock Action:** Perform expanded research (more Quoth queries, broader Exolar search)

**Enforcement:** `pre-retry-gate.sh` hook with exit code 2

### Gate 7: Max Attempts

**Trigger:** 25+ total attempts

**Block Condition:** No `.fixme()` mark or justification

**Unblock Action:** Mark test with `.fixme()` or justify why continued attempts warranted

**Enforcement:** `pre-retry-gate.sh` hook with exit code 2

### Gate 8: Promotion

**Trigger:** test-healer SUCCESS

**Block Condition:** Auto-promotion always blocked

**Unblock Action:** User must explicitly approve promotion

**Enforcement:** test-healer agent STOPS on success (does NOT auto-promote)

### Gate 9: Session End

**Trigger:** Stop hook (session ends)

**Block Condition:** No accumulated learnings section

**Unblock Action:** Add `## Accumulated Learnings` to run log

**Enforcement:** `stop.sh` hook reminder

---

## Run Log Structure

Each feature gets a comprehensive run log:

```markdown
# Test Run Log: {feature}

## Session: {ISO timestamp}

### Stage: ANALYZE
[Acceptance criteria, test cases identified]

### Stage: RESEARCH
[Quoth patterns, Exolar history, existing code]

### Stage: PLAN
[Test strategy, tools to use, new artifacts]

### Stage: WRITE
**Hypothesis:** [Approach and rationale]

### Stage: RUN (Attempt 1)
**Result:** FAILED
**Category:** WAIT
**Analysis:** [Detailed failure analysis]

### Stage: FIX (Attempt 1)
**Hypothesis:** [Fix approach]

### Stage: RUN (Attempt 2)
**Result:** PASSED

### Stage: LEARN
**Pattern:** [Pattern extracted]

## Accumulated Learnings
1. [Learning 1]
2. [Learning 2]
```

---

## Workflow with Documentation

The complete workflow enforced by hooks:

1. **SessionStart** → Initialize session, detect active run logs, show guidance
2. **ANALYZE** → Review requirements, document test cases in run log
3. **RESEARCH** → Search Quoth/Exolar, document findings in run log
4. **PLAN** → Document test strategy, tools to use, artifacts to create
5. **Writing tests** → Hook checks run log has all stages, blocks if missing
6. **Running tests** → Hook sets flag requiring log update
7. **Failures** → Document in run log, classify, fix with hypothesis
8. **2+ same failures** → Hook requires external research (Quoth/Exolar)
9. **12+ attempts** → Hook requires deep analysis phase
10. **25+ attempts** → Hook requires `.fixme()` or justification
11. **Success** → Document learnings, update knowledge.md
12. **SessionStop** → Check for missing accumulated learnings

---

## Mandatory Context Loading

**BEFORE writing ANY test code**, call the `triqual_load_context` MCP tool:

```
triqual_load_context({ feature: "{feature}" })
```

This spawns a headless Claude subprocess (Sonnet) that:
- Searches Quoth for patterns/anti-patterns
- Queries Exolar for failure history
- Scans codebase for relevant code
- Writes structured context files to `.triqual/context/{feature}/`

**Context files created:**
- `patterns.md` — Quoth proven patterns
- `anti-patterns.md` — Known failures to avoid
- `codebase.md` — Relevant source files, selectors, routes
- `existing-tests.md` — Reusable tests and page objects
- `failures.md` — Exolar failure history
- `requirements.md` — Ticket/description (if provided)
- `summary.md` — Index of all context

**Why mandatory:**
- Patterns learned from past failures help you succeed faster
- Subprocess runs in isolation (doesn't consume main context tokens)
- Hooks ENFORCE this — test writing BLOCKED until context files exist

---

## Related Documentation

- [Hooks System](/docs/hooks-system) - Hook architecture and exit codes
- [Agents Guide](/docs/agents-guide) - Agent orchestration
- [Session State](/docs/session-state) - What persists
- [Draft Folder](/docs/draft-folder) - Staging pattern

---

**Next Steps:** Read [Hooks System](/docs/hooks-system) to understand enforcement mechanism, or [Agents Guide](/docs/agents-guide) to see how agents implement the loop.
