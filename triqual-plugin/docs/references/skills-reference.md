# Skills Reference

> **Category:** Reference | **Updated:** 2026-02-02

Complete reference for all 5 Triqual skills (slash commands) with usage, arguments, and examples.

---

## Overview

Triqual provides 5 skills accessible via slash commands:

| Skill | Command | Purpose |
|-------|---------|---------|
| init | `/init` | Initialize project configuration |
| test | `/test` | Full autonomous test generation |
| check | `/check` | Lint tests for violations |
| rules | `/rules` | View best practices |
| help | `/help` | Get help and troubleshooting |

---

## /init - Initialize Project

### Purpose

Analyzes your project structure and generates Triqual configuration.

### Usage

```bash
/init
```

### What It Creates

| File/Directory | Purpose |
|----------------|---------|
| `.triqual/runs/` | Run logs (one per feature) |
| `.triqual/knowledge.md` | Project-specific patterns |
| `triqual.config.ts` | Main TypeScript configuration |
| `Docs/context/` (optional) | Additional context files |

### Configuration Generated

```typescript
// triqual.config.ts
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'your-project-id',
  testDir: './automation/playwright/tests',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  auth: {
    strategy: 'storageState',
    storageState: { path: '.auth/user.json' },
  },
});
```

### When to Use

- **First time** - Setting up Triqual in a new project
- **After cloning** - Regenerating config in a fresh clone
- **Config lost** - Recreating deleted config files

---

## /test - Autonomous Test Generation

### Purpose

Full autonomous test generation with documented learning loop (ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN).

### Usage Variants

#### 1. Feature Name (Standard)

```bash
/test login
```

Generates tests for the "login" feature with:
- Context loading from Quoth/Exolar
- Run log at `.triqual/runs/login.md`
- Test code at `.draft/tests/login.spec.ts`
- Autonomous healing up to 25 attempts

#### 2. Interactive Exploration

```bash
/test --explore dashboard
```

Opens visible browser for manual exploration:
- No test files created
- Interactive session
- Useful for app discovery

#### 3. From Linear Ticket

```bash
/test --ticket ENG-123
```

Generates tests from Linear ticket acceptance criteria:
- Fetches ticket details
- Extracts acceptance criteria
- Creates run log with requirements
- Generates comprehensive tests

#### 4. From Description

```bash
/test --describe "Verify user can reset password via email link"
```

Generates tests from text description:
- Documents description in run log
- Creates test strategy
- Generates implementation

### The Agentic Loop

```
/test login
    │
    ├─► triqual_load_context (MCP tool)
    │   └─► Writes .triqual/context/login/
    │
    ├─► test-planner
    │   └─► Creates .triqual/runs/login.md
    │
    ├─► test-generator
    │   └─► Writes .draft/tests/login.spec.ts
    │
    └─► test-healer (AUTONOMOUS LOOP)
        └─► Runs, fixes, loops until PASS or 25 attempts
```

### Promotion After Success

When tests pass, **promotion is BLOCKED**. User must explicitly approve:

```bash
# Review the test
cat .draft/tests/login.spec.ts

# Approve promotion
git mv .draft/tests/login.spec.ts tests/login.spec.ts
```

---

## /check - Lint Tests for Violations

### Purpose

Scans test files for Playwright best practice violations.

### Usage

```bash
# Check all tests
/check

# Check with minimum severity
/check --severity warning
/check --severity error
```

### Severity Levels

| Level | Description |
|-------|-------------|
| `info` | Minor suggestions |
| `warning` | Potential issues |
| `error` | Critical violations |

### What It Checks

31 rules across 8 categories:

**1. Locators & Selectors**
- Prefer `data-testid` over CSS selectors
- Avoid XPath locators
- Use role-based locators where possible

**2. Waits & Timing**
- No hardcoded `setTimeout`
- Use `waitFor` methods
- Avoid `waitForTimeout`

**3. Assertions**
- Use `expect().toBeVisible()` not `.toBeTruthy()`
- Prefer soft assertions in loops
- Chain assertions logically

**4. Page Objects**
- Encapsulate selectors in Page Objects
- Reuse locators
- Export Page Objects from `pages/`

**5. Test Organization**
- Use `describe` blocks
- Independent test cases
- Setup/teardown in `beforeEach`/`afterEach`

**6. Network Mocking**
- Mock external APIs
- Use `page.route()` for stable tests
- Avoid real API calls in tests

**7. Parallelization**
- Tests should not share state
- Use test isolation
- Avoid global variables

**8. Debugging**
- Use `page.screenshot()` on failure
- Add `test.info()` for context
- Enable trace on CI

### Example Output

```
✅ tests/login.spec.ts - 0 violations
❌ tests/dashboard.spec.ts - 3 violations
  ⚠️  Line 12: Avoid hardcoded setTimeout (use waitFor instead)
  ⚠️  Line 23: Prefer data-testid over CSS class selectors
  ❌ Line 45: Test shares state with previous test
```

---

## /rules - View Best Practices

### Purpose

Display comprehensive Playwright best practices (31 rules).

### Usage

```bash
# View all rules
/rules

# View specific category
/rules locators
/rules waits
/rules assertions
```

### Categories

| Category | Rules | Description |
|----------|-------|-------------|
| `locators` | 5 | Selector strategies |
| `waits` | 4 | Timing and synchronization |
| `assertions` | 4 | Verification patterns |
| `page-objects` | 3 | Page Object Model |
| `organization` | 5 | Test structure |
| `mocking` | 3 | Network mocking |
| `parallel` | 4 | Parallelization |
| `debug` | 3 | Debugging techniques |

### Example Output

```markdown
# Locators & Selectors

## Rule 1: Prefer data-testid attributes

**Why:** Resilient to UI changes, explicit test intent

**Good:**
```typescript
await page.getByTestId('login-button').click();
```

**Bad:**
```typescript
await page.locator('.btn.primary').click();
```

(... and so on for all 31 rules)
```

---

## /help - Get Help

### Purpose

Show available commands, troubleshooting tips, and guidance.

### Usage

```bash
# General help
/help

# Topic-specific help
/help installation
/help workflow
/help debugging
```

### Topics

| Topic | Content |
|-------|---------|
| `installation` | Setup and MCP authentication |
| `workflow` | Learning loop stages |
| `debugging` | Hook debugging, session state |
| `mcp` | Quoth/Exolar connection issues |
| `promotion` | Draft folder and promotion |

---

## Command Comparison

| Need | Use |
|------|-----|
| Setup project | `/init` |
| Generate tests autonomously | `/test login` |
| Explore app manually | `/test --explore dashboard` |
| From ticket | `/test --ticket ENG-123` |
| From description | `/test --describe "..."` |
| Check test quality | `/check` |
| View best practices | `/rules` |
| Get help | `/help` |

---

## Related Documentation

- [Installation](/docs/installation) - Setup Triqual
- [Learning Loop](/docs/learning-loop) - Workflow stages
- [Agents Guide](/docs/agents-guide) - Agent orchestration
- [Troubleshooting](/docs/troubleshooting) - Common issues

---

**Next Steps:** Run `/test login` to generate your first test, or `/check` to lint existing tests.
