# Agent Orchestration

> **Category:** Architecture | **Updated:** 2026-02-02

Complete guide to Triqual's 5 specialized agents and the MCP context loading tool that powers autonomous test generation.

---

## Overview

Triqual orchestrates 5 specialized agents plus a deterministic MCP tool to implement the documented learning loop:

| Agent | Color | Role | Stage |
|-------|-------|------|-------|
| **triqual_load_context** | - | Context Loading (MCP) | Pre-ANALYZE |
| **test-planner** | 🟣 Purple | Planning | ANALYZE/RESEARCH/PLAN |
| **test-generator** | 🟢 Green | Code Generation | WRITE |
| **test-healer** | 🔵 Blue | Autonomous Healing | RUN/FIX |
| **failure-classifier** | 🟠 Orange | Failure Analysis | (on failure) |
| **pattern-learner** | 🟣 Purple | Pattern Extraction | LEARN |

---

## The Agentic Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRIQUAL AGENT LOOP                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Request (ticket, description, feature name)               │
│        ↓                                                         │
│  ┌──────────────────┐                                            │
│  │LOAD CONTEXT (MCP)│ ← triqual_load_context({ feature })        │
│  │  (subprocess)    │   Writes .triqual/context/{feature}/       │
│  └──────┬───────────┘                                            │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │ TEST-PLANNER │ ← Reads context files, creates ANALYZE/PLAN    │
│  │   (purple)   │   Creates run log with test plan               │
│  └──────┬───────┘                                                │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │TEST-GENERATOR│ ← WRITE stage                                  │
│  │   (green)    │   Generates test code from plan                │
│  └──────┬───────┘                                                │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │   RUN TEST   │ ← RUN stage                                    │
│  │   (bash)     │   npx playwright test                          │
│  └──────┬───────┘                                                │
│         │                                                        │
│    ┌────┴────┐                                                   │
│   PASS      FAIL                                                 │
│    ↓         ↓                                                   │
│  LEARN   ┌──────────────────┐                                    │
│    ↓     │FAILURE-CLASSIFIER│ ← Categorizes the failure          │
│ pattern- │    (orange)      │                                    │
│ learner  └────────┬─────────┘                                    │
│                   ↓                                              │
│            ┌──────────────┐                                      │
│            │ TEST-HEALER  │ ← FIX stage (up to 3 attempts)       │
│            │    (blue)    │   Then back to RUN                   │
│            └──────┬───────┘                                      │
│                   ↓                                              │
│              RUN TEST (loop)                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## MCP Tool: triqual_load_context

### Purpose

Deterministic MCP tool that spawns a headless Claude subprocess (Sonnet) to build comprehensive context **BEFORE** test generation begins.

### Usage

```typescript
triqual_load_context({
  feature: "login",              // Required: feature name
  ticket?: "ENG-123",           // Optional: Linear ticket ID
  description?: "...",          // Optional: text description
  force?: false                 // Optional: force reload even if context exists
})
```

### What It Does

1. **Spawns headless subprocess** (Claude Sonnet)
2. **Searches Quoth** for patterns and anti-patterns
3. **Queries Exolar** for failure history
4. **Scans codebase** for relevant code (Page Objects, helpers, fixtures)
5. **Writes context files** to `.triqual/context/{feature}/`

### Context Files Created

| File | Content |
|------|---------|
| `patterns.md` | Quoth proven patterns |
| `anti-patterns.md` | Known failures to avoid |
| `codebase.md` | Relevant source files, selectors, routes |
| `existing-tests.md` | Reusable tests and Page Objects |
| `failures.md` | Exolar failure history |
| `requirements.md` | Ticket/description (if provided) |
| `summary.md` | Index of all context |

### Why Mandatory

**ENFORCED by hooks** — test writing BLOCKED until context files exist.

**Benefits:**
- Context files contain proven patterns from Quoth
- Failure history from Exolar prevents repeating mistakes
- Codebase analysis ensures code reuse
- Subprocess runs in isolation (doesn't consume main context tokens)

### Example

```bash
/test login
    │
    └─► Calls triqual_load_context({ feature: "login" })
        │
        ├─► Subprocess searches Quoth
        ├─► Subprocess queries Exolar
        ├─► Subprocess scans codebase
        └─► Writes 7 files to .triqual/context/login/
```

---

## Agent 1: test-planner (Purple)

### Purpose

Creates comprehensive test plan with ANALYZE/RESEARCH/PLAN stages.

### Trigger Conditions

- User command: `/test login`
- User request: "plan tests for X"
- Linear ticket provided: `/test --ticket ENG-123`
- Description provided: `/test --describe "..."`

### Tools Available

- **Read** - Read context files
- **Grep** - Search codebase
- **Glob** - Find files
- **Playwright MCP** - Explore app
- **Linear MCP** - Fetch ticket details (if available)
- **Write** - Create run log

### What It Creates

**File:** `.triqual/runs/{feature}.md`

**Sections:**
- `### Stage: ANALYZE` - Test cases identified from requirements
- `### Stage: RESEARCH` - Quoth patterns, Exolar history, existing code
- `### Stage: PLAN` - Test strategy, tools to use, new artifacts

### Decision Points

1. **What to test?** - Extracted from ticket/description/feature name
2. **What patterns apply?** - From context files (Quoth)
3. **What code to reuse?** - From context files (existing tests)
4. **What to create new?** - Only if no existing code covers the need

### Example Output

```markdown
# Test Run Log: login

## Session: 2026-02-02T10:30:00Z

### Stage: ANALYZE

**Acceptance Criteria:**
1. User can login with valid credentials
2. Invalid credentials show error

**Test Cases:**
- Happy path: successful login → dashboard
- Error case: invalid credentials → error message

### Stage: RESEARCH

**Context Files Read:**
- .triqual/context/login/patterns.md (5 patterns found)
- .triqual/context/login/existing-tests.md (LoginPage exists)

**Quoth Patterns:**
- Auth tests use `StorageState` pattern
- Login selectors use `data-testid` convention

**Existing Code to Reuse:**
- `pages/LoginPage.ts` ✅
- `helpers/auth.ts` ✅

### Stage: PLAN

**Test Strategy:**
1. Reuse existing LoginPage
2. Create new DashboardPage
3. 2 test cases (happy path + error)

**New Artifacts:**
- `.draft/pages/DashboardPage.ts` (needed)
```

---

## Agent 2: test-generator (Green)

### Purpose

Generates Playwright test code from plan.

### Trigger Conditions

- After test-planner completes
- User request: "generate tests from plan"
- Run log has PLAN stage

### Tools Available

- **Read** - Read run log PLAN stage, knowledge.md, context files
- **Write** - Create test files in `.draft/`
- **Edit** - Modify existing files

### What It Creates

**Files:** `.draft/tests/{feature}.spec.ts`, possibly Page Objects

**Pattern:**
- Reads PLAN stage carefully
- Applies patterns from knowledge.md
- Reuses existing code (Page Objects, helpers)
- Creates new Page Objects ONLY if needed
- Documents WRITE stage with hypothesis

### Decision Points

1. **Reuse or create?** - Always prefer reuse from context/existing-tests.md
2. **Which patterns?** - Apply patterns from knowledge.md and Quoth
3. **Where to write?** - Always `.draft/` folder (hook enforces this)

### Example Output

**File Created:** `.draft/tests/login.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';

test.describe('Login Flow', () => {
  test('successful login redirects to dashboard', async ({ page }) => {
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.login('user@example.com', 'password');

    await expect(page).toHaveURL('/dashboard');
    await expect(dashboard.welcomeMessage).toBeVisible();
  });
});
```

**Run Log Updated:**

```markdown
### Stage: WRITE

**Hypothesis:** Using StorageState pattern from Quoth, reuse existing LoginPage and new DashboardPage to test login flow.

**Files Created:**
- `.draft/tests/login.spec.ts`
- `.draft/pages/DashboardPage.ts`

**Patterns Applied:**
- Quoth: StorageState auth pattern
- Existing: LoginPage reused ✅
```

---

## Agent 3: test-healer (Blue) - AUTONOMOUS LOOP

### Purpose

Runs tests, analyzes failures, applies fixes autonomously. Loops until PASS or 25 attempts.

### Trigger Conditions

- After test-generator completes
- User request: "fix failing tests"
- Test failure detected

### Tools Available

- **Read** - Read test files, run log, error output
- **Edit** - Fix test code
- **Bash** - Run `npx playwright test`
- **Grep** - Search for similar patterns
- **Quoth MCP** - Search patterns on 2+ same failures
- **Exolar MCP** - Query failure history on 2+ same failures

### Autonomous Loop Logic

```
1. Run test (npx playwright test)
2. Test result?
   ├─ PASS → STOP (await user approval to promote)
   │         └─ Dispatch pattern-learner
   │
   └─ FAIL → Classify failure (via failure-classifier)
             ├─ Attempt < 3? → Quick fix
             ├─ Attempt 3-11? → Research patterns (Quoth/Exolar)
             ├─ Attempt 12? → Deep analysis phase
             ├─ Attempt 13-24? → Continue fixing
             └─ Attempt 25? → Mark .fixme() or justify

3. Apply fix, document FIX stage, loop back to step 1
```

### Escalation Phases

| Phase | Attempts | Action |
|-------|----------|--------|
| **Quick Fixes** | 1-2 | Direct fixes based on error |
| **Research** | 3-11 | Search Quoth patterns, query Exolar |
| **Deep Analysis** | 12 | Expanded research, broader scope |
| **Final Attempts** | 13-24 | Apply advanced fixes |
| **Justification** | 25+ | Mark `.fixme()` or justify continued attempts |

### Work Location

**Always works in `.draft/` folder**

- Reads: `.draft/tests/{feature}.spec.ts`
- Edits: `.draft/tests/{feature}.spec.ts`
- On SUCCESS: **STOPS** (does NOT auto-promote)

### Promotion

**BLOCKED by design** - user must explicitly approve:

```bash
# Review test
cat .draft/tests/login.spec.ts

# Approve promotion
git mv .draft/tests/login.spec.ts tests/login.spec.ts
```

### Example Run Log Updates

```markdown
### Stage: RUN (Attempt 1)
**Result:** FAILED
**Category:** WAIT
**Analysis:** Dashboard loads async, URL changes before content ready

### Stage: FIX (Attempt 1)
**Hypothesis:** Add networkidle wait after login

### Stage: RUN (Attempt 2)
**Result:** PASSED

### Stage: LEARN
**Pattern:** This project requires networkidle wait after auth redirects
```

---

## Agent 4: failure-classifier (Orange)

### Purpose

Classifies test failures into categories for targeted fixes.

### Trigger Conditions

- Test failure unclear
- User request: "classify this failure"
- test-healer needs categorization

### Tools Available

- **Read** - Read error output, test file
- **Grep** - Search for similar patterns
- **Exolar MCP** - Query historical failures

### Failure Categories

| Category | Description | Typical Fix |
|----------|-------------|-------------|
| **FLAKE** | Intermittent, timing-related | Add waits, stabilize selectors |
| **BUG** | Application bug, not test issue | Report to dev team |
| **ENV** | Environment-specific (CI/local) | Adjust config, dependencies |
| **WAIT** | Async loading, race condition | Add explicit waits |
| **TEST_ISSUE** | Test code bug | Fix test logic |

### Decision Points

1. **Error message analysis** - What does stack trace indicate?
2. **Historical data** - Has this failed before? (Exolar)
3. **Reproducibility** - Consistent or intermittent?

### Example Output

```markdown
**Classification:** WAIT

**Reasoning:**
- Error: "Element not found"
- Occurs after URL change (redirect)
- Dashboard content loads async

**Recommended Fix:**
- Add `page.waitForLoadState('networkidle')` after login
- Verify dashboard element visible before interaction
```

---

## Agent 5: pattern-learner (Purple)

### Purpose

Extracts patterns from successful fixes and updates knowledge.md.

### Trigger Conditions

- Test healed successfully
- Session ending
- User request: "extract patterns from this session"
- Multiple fixes applied

### Tools Available

- **Read** - Read all run logs, test files
- **Edit** - Update knowledge.md
- **Quoth MCP** - Propose patterns for capture

### What It Extracts

1. **Recurring patterns** - Fixes applied multiple times
2. **Project-specific learnings** - Unique to this codebase
3. **Anti-patterns** - What NOT to do (from failures)

### Knowledge File Updates

**File:** `.triqual/knowledge.md`

```markdown
# Project Knowledge: {project}

## Patterns

### Auth Redirects Require networkidle Wait

**Context:** Dashboard loads async content after login redirect

**Pattern:**
```typescript
await loginPage.login(email, password);
await page.waitForLoadState('networkidle'); // Critical!
await expect(page).toHaveURL('/dashboard');
```

**Why:** URL change happens before content loads

---

### Quoth Proposal

Pattern-learner can propose patterns to Quoth for project-wide capture:

```typescript
quoth_create_pattern({
  title: "Auth Redirect Timing",
  category: "authentication",
  pattern: "...",
  project: "your-project"
})
```

---

## Agent Coordination

### Context Injection (SubagentStart Hook)

Before agent runs, hook tells it what to read:

```
🔵 test-healer starting

CRITICAL CONTEXT - Read these files FIRST:
1. .triqual/runs/login.md (run log - current state)
2. .triqual/knowledge.md (project patterns)
3. .triqual/context/login/patterns.md (Quoth patterns)

DO NOT proceed without reading these files.
```

### Next Step Guidance (SubagentStop Hook)

After agent completes, hook suggests next step:

```
✅ test-planner completed

NEXT STEPS:
1. Update run log with PLAN stage findings
2. Dispatch test-generator to write code
3. Read plan carefully before generating
```

---

## Agent Models

All agents run on **Opus 4.5** for maximum reasoning capability:

```yaml
# agents/test-planner.md frontmatter
model: opus
color: purple
tools:
  - Read
  - Write
  - Grep
  - Glob
  - browser_navigate
  - browser_snapshot
```

---

## Related Documentation

- [Learning Loop](/docs/learning-loop) - Stages agents implement
- [Hooks System](/docs/hooks-system) - Context injection mechanism
- [Draft Folder](/docs/draft-folder) - Where agents work
- [API Reference](/docs/api-reference) - MCP tool signatures

---

**Next Steps:** Read [Learning Loop](/docs/learning-loop) to understand workflow, or [Hooks System](/docs/hooks-system) to see context injection.
