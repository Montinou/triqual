---
name: test-ticket
description: |
  Generate Playwright E2E tests from Linear tickets. Use when user says
  "test ticket ENG-123", "automate ENG-456", "create e2e tests from ticket",
  "generate playwright tests from ticket", "automate acceptance criteria",
  or mentions Linear ticket IDs like ENG-123, LIN-456, PROJ-789.
user-invocable: true
argument-hint: <ticket-id> [--dry-run] [--skip-pr]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Test Ticket Automation

Convert Linear tickets to self-healing Playwright E2E tests.

## Quick Start

```bash
/test-ticket ENG-123           # Full workflow
/test-ticket ENG-456 --dry-run # Generate without executing
/test-ticket ENG-789 --skip-pr # Execute but skip PR creation
```

## Command Options

| Flag | Effect |
|------|--------|
| `--dry-run` | Generate tests and plan only, skip execution |
| `--skip-pr` | Full workflow but stop before PR creation |
| `--verbose` | Show detailed progress including MCP responses |

## 7-Step Workflow

Execute these steps in order:

```
Step 1: Ticket Analysis     ─── Fetch and parse ticket
    │
Step 2: Pattern Search      ─── MANDATORY: Query Quoth
    │
Step 3: Test Planning       ─── Generate test scenarios
    │
Step 4: Test Generation     ─── Create .spec.ts files
    │
Step 5: Execution Loop      ─── Run with auto-healing (3 attempts)
    │
Step 6: CI Integration      ─── Update GitHub Actions (if needed)
    │
Step 7: Handoff             ─── Provide PR instructions to user
```

---

## Step 1: Ticket Analysis

### 1.1 Fetch Ticket from Linear

```
mcp__linear__get_issue({
  issueId: "{ticket-id}"
})
```

### 1.2 Extract Key Information

From the ticket, extract:
- **Title**: Brief description
- **Description**: Full details
- **Acceptance Criteria**: Test requirements (look for checkboxes)
- **Labels**: Feature area, priority
- **Linked PR**: If exists, check changed files

### 1.3 Parse Acceptance Criteria

Convert acceptance criteria to testable scenarios:

```markdown
## Acceptance Criteria (from ticket)
- [ ] User can log in with email/password
- [ ] Invalid credentials show error message
- [ ] Successful login redirects to dashboard

## Test Scenarios (derived)
1. test_login_with_valid_credentials
2. test_login_with_invalid_credentials_shows_error
3. test_login_redirects_to_dashboard
```

### 1.4 Identify Branch (if PR exists)

If ticket has linked PR:
```bash
git fetch origin
git checkout {branch-name}
```

---

## Step 2: Pattern Search (MANDATORY)

**Per project rules: Quoth MUST be consulted before generating test code.**

### 2.1 Search Quoth for Existing Patterns

```
mcp__quoth__quoth_search_index({
  query: "playwright test {feature} pattern"
})
```

Search for:
- Page Objects for the feature
- Similar test files
- Helper functions used
- Assertion patterns

### 2.2 Search Exolar for Similar Tests

```
mcp__exolar-qa__query_exolar_data({
  dataset: "test_search",
  filters: { feature: "{feature-keyword}" }
})
```

Check for:
- Existing tests covering similar functionality
- Known flaky patterns to avoid
- Successful test structures

### 2.3 Document Found Patterns

Record patterns to use:

```markdown
## Patterns Found

### Page Objects
- `LoginPage` from `/tests/pages/login.page.ts`
- `DashboardPage` from `/tests/pages/dashboard.page.ts`

### Helpers to Use
- `getTimeout()` for dynamic timeouts
- `safeClick()` for retry logic

### Anti-Patterns to Avoid
- Don't hardcode timeouts (use getTimeout())
- Don't use `nth(0)` without `:visible` filter
```

---

## Step 3: Test Planning

### 3.1 Generate Test Plan

For each acceptance criterion, create a test scenario:

```typescript
// Test Plan for ENG-123

/**
 * Feature: User Login
 * Ticket: ENG-123
 */

describe('Login Flow - ENG-123', () => {
  // Scenario 1: Valid credentials
  test('should login with valid email and password', async () => {
    // Given: User is on login page
    // When: User enters valid credentials and submits
    // Then: User is redirected to dashboard
  });

  // Scenario 2: Invalid credentials
  test('should show error for invalid credentials', async () => {
    // Given: User is on login page
    // When: User enters invalid credentials and submits
    // Then: Error message is displayed
  });
});
```

### 3.2 Identify Test Data Requirements

- Required fixtures
- Test users/credentials
- API mocks (if needed)

---

## Step 4: Test Generation

### 4.1 Determine File Location

Based on ticket labels:

| Labels | Location |
|--------|----------|
| `feature`, `ui` | `automation/playwright/tests/{feature}/` |
| `bug`, `ui` | `automation/playwright/tests/{feature}/` |
| `api`, `backend` | `automation/playwright/tests/{feature}-api/` |

### 4.2 Create Test File

**File name**: `{ticket-id}-{feature}.spec.ts`

```typescript
// automation/playwright/tests/auth/ENG-123-login.spec.ts

import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
import { DashboardPage } from '../pages/dashboard.page';
import { getTimeout } from '../helpers/timeout';

test.describe('Login Flow - ENG-123', () => {
  let loginPage: LoginPage;
  let dashboardPage: DashboardPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    dashboardPage = new DashboardPage(page);
    await loginPage.goto();
  });

  test('should login with valid email and password', async ({ page }) => {
    await loginPage.login('test@example.com', 'validPassword123');
    await expect(page).toHaveURL(/.*dashboard/, { timeout: getTimeout() });
    await expect(dashboardPage.welcomeMessage).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await loginPage.login('test@example.com', 'wrongPassword');
    await expect(loginPage.errorMessage).toBeVisible();
    await expect(loginPage.errorMessage).toContainText('Invalid credentials');
  });
});
```

### 4.3 Create Page Objects (if needed)

Only create new Page Objects if they don't exist (check Step 2 results).

---

## Step 5: Execution Loop

### 5.1 Run Tests

```bash
npx playwright test {test-file} --reporter=list
```

### 5.2 Auto-Healing (Up to 3 Attempts)

If tests fail, apply automatic fixes:

| Error | Fix |
|-------|-----|
| `locator resolved to N elements` | Add `:visible` or `.first()` |
| `Timeout exceeded` | Use `getTimeout()` helper |
| `strict mode violation` | Add `.first()` |
| `401 Unauthorized` | Clear `.auth/` directory |

### 5.3 Healing Process

```
Attempt 1: Run tests
    │
    ├── Pass? → Continue to Step 6
    │
    └── Fail? → Analyze error, apply fix
                    │
Attempt 2: Re-run tests
    │
    ├── Pass? → Continue to Step 6
    │
    └── Fail? → Analyze error, apply fix
                    │
Attempt 3: Final attempt
    │
    ├── Pass? → Continue to Step 6
    │
    └── Fail? → Mark test.fixme(), ask user
```

### 5.4 If Still Failing After 3 Attempts

```typescript
test.fixme('should login with valid credentials', async ({ page }) => {
  // TODO: Manual fix required - ENG-123
  // Error: {last-error-message}
});
```

Ask user how to proceed.

---

## Step 6: CI Integration

### 6.1 Check Existing CI Config

```bash
cat .github/workflows/playwright.yml
```

### 6.2 Ensure Test is Included

Verify the new test file is covered by the test glob pattern.

If using tag-based filtering, add appropriate tags:

```typescript
test('should login @smoke @auth', async ({ page }) => {
  // ...
});
```

---

## Step 7: Handoff to User

### 7.1 Provide PR Instructions

**Per user preference: User creates PR manually.**

Provide summary for the user:

```markdown
## Test Generation Complete

### Files Created
- `automation/playwright/tests/auth/ENG-123-login.spec.ts`

### Test Results
- 2/2 tests passing

### Next Steps (for you to do)
1. Review the generated tests
2. Commit changes:
   ```bash
   git add automation/playwright/tests/auth/
   git commit -m "test(ENG-123): add login flow e2e tests"
   ```
3. Create PR linking to ENG-123

### Notes
- Tests use existing `LoginPage` page object
- Added `getTimeout()` for dynamic timeout handling
```

---

## MCP Requirements

### Required

| Server | Purpose |
|--------|---------|
| `linear` | Fetch ticket details |
| `quoth` | Search for patterns (MANDATORY) |

### Optional

| Server | Purpose | Fallback |
|--------|---------|----------|
| `exolar` | Search similar tests | Skip |

---

## Error Handling

### Linear MCP Not Connected

```
Linear MCP is not connected. Cannot fetch ticket details.

Options:
1. Connect Linear MCP (recommended)
2. Provide ticket details manually
```

### Quoth MCP Not Connected

```
Quoth MCP is not connected.

WARNING: Pattern search will be skipped. Generated tests may not
follow documented conventions. Proceed with caution.
```

### Test Execution Fails Repeatedly

After 3 failed healing attempts:

```
Test is still failing after 3 auto-heal attempts.

Last error: {error-message}

Options:
1. Continue with test.fixme() marker
2. Investigate manually
3. Skip this test scenario
```

---

## Generated Artifacts

| Artifact | Location |
|----------|----------|
| Test files | `automation/playwright/tests/{feature}/` |
| Page objects (if new) | `automation/playwright/tests/pages/` |

---

## Best Practices

1. **Always check Quoth first** - Don't reinvent patterns
2. **Use existing Page Objects** - Don't duplicate
3. **Follow naming conventions** - `{ticket-id}-{feature}.spec.ts`
4. **Add descriptive test names** - Document what you're testing
5. **Use helpers** - `getTimeout()`, `safeClick()`, etc.
6. **Tag tests appropriately** - `@smoke`, `@regression`, etc.
