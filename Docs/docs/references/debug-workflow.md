# Debug Workflow - Fixing Failing Tests

This document describes the workflow for debugging and fixing failing Playwright tests using interactive browser observation.

## Overview

The debug workflow enables fixing failing tests by:

1. **Reading** the test to understand expected behavior
2. **Observing** actual application behavior via browser
3. **Identifying** where expectation meets reality
4. **Fixing** the test code
5. **Verifying** the fix works

## When to Use

- Test is failing in CI or locally
- Locators no longer match elements
- Application behavior has changed
- Test assertions don't match actual state
- Flaky tests that sometimes pass/fail

---

## Debug Workflow Steps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DEBUG WORKFLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐      │
│   │  READ   │──▶│ OBSERVE │──▶│ COMPARE │──▶│  FIX    │──▶│ VERIFY  │      │
│   │  Test   │   │ Browser │   │ Expected│   │  Code   │   │  Works  │      │
│   │         │   │         │   │ vs Real │   │         │   │         │      │
│   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘      │
│       │             │             │             │             │              │
│       │             │             │             │             │              │
│   Read test     Navigate      Identify      Update test    Run test        │
│   file and      to page,      divergence    locators,      to verify       │
│   understand    follow        point         assertions,    fix works       │
│   steps         steps                       or flow                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Read the Test

### 1.1 Read the Failing Test File

```
Read the test file to understand:
- What feature is being tested
- What steps the test performs
- What assertions it makes
- What Page Objects it uses
```

### 1.2 Identify Key Information

Extract from the test:

| Information | Example |
|-------------|---------|
| Test name | "should redirect after login" |
| Starting URL | /login |
| Actions | fill email, fill password, click submit |
| Expected outcome | URL changes to /dashboard |
| Locators used | emailInput, passwordInput, submitButton |
| Page Objects | LoginPage, DashboardPage |

### 1.3 Read Related Page Objects

If test uses Page Objects, read them to understand:
- What locators are defined
- How they're implemented
- What helper methods exist

### 1.4 Read Error Message

Understand the failure:

| Error Type | Meaning |
|------------|---------|
| "Locator resolved to N elements" | Selector matches multiple elements |
| "Timeout waiting for selector" | Element doesn't exist or not visible |
| "Strict mode violation" | Multiple matches, need .first() |
| "expect.toBeVisible" failed | Element not visible when expected |
| "expect.toHaveURL" failed | URL didn't match expected pattern |
| "expect.toHaveText" failed | Text content didn't match |

---

## Step 2: Observe Browser

### 2.1 Set Up Browser

```
1. Get tab context
   mcp__playwright-test__tabs_context_mcp({ createIfEmpty: true })

2. Create new tab
   mcp__playwright-test__tabs_create_mcp()

3. Navigate to starting point
   mcp__playwright-test__browser_navigate({ url: "/login", tabId })
```

### 2.2 Authenticate If Needed

If the test requires authentication:

```
Option A: Manual login via MCP
- Navigate to login page
- Fill credentials using browser_type
- Click submit using browser_click
- Wait for redirect

Option B: Check auth state files
- Verify .auth/{role}.json exists
- If expired, need to regenerate
```

### 2.3 Take Initial Snapshot

```
mcp__playwright-test__browser_snapshot({ tabId })
```

Compare snapshot to what the test expects to see.

### 2.4 Follow Test Steps

Execute each step from the test manually:

```
For each test step:
  1. Take snapshot (see current state)
  2. Perform action (click, type, etc.)
  3. Take snapshot (see result)
  4. Note any differences from expected
```

---

## Step 3: Compare Expected vs Actual

### 3.1 Identify Divergence Point

Find where actual behavior differs from test expectation:

| Test Expects | Actual Behavior | Issue Type |
|--------------|-----------------|------------|
| Button with text "Submit" | Button says "Send" | Text changed |
| Input with name="email" | Input has data-testid only | Locator outdated |
| URL changes to /dashboard | URL goes to /home | Redirect changed |
| Success message visible | Error message shown | Bug or test data issue |
| Element exists | Element not in DOM | UI restructured |

### 3.2 Root Cause Analysis

Determine WHY the divergence exists:

| Root Cause | Evidence | Fix Location |
|------------|----------|--------------|
| UI text changed | Snapshot shows different text | Update locator |
| Element restructured | Snapshot shows different structure | Update locator |
| Feature behavior changed | Different flow observed | Update test flow |
| Test data invalid | Error messages about data | Update fixtures |
| Auth state expired | Login page shown unexpectedly | Regenerate auth |
| Timing issue | Works with slowMo | Add proper waits |

### 3.3 Verify with Multiple Runs

For flaky tests, observe multiple executions:
- Does it fail consistently at same point?
- Does it fail intermittently?
- Does timing affect it?

---

## Step 4: Fix the Code

### 4.1 Locator Fixes

**Element text changed:**
```typescript
// Before
this.submitButton = page.getByRole('button', { name: 'Submit' });

// After (from snapshot observation)
this.submitButton = page.getByRole('button', { name: 'Send' });
```

**Element structure changed:**
```typescript
// Before
this.emailInput = page.locator('input[name="email"]');

// After (from snapshot - element now has testid)
this.emailInput = page.getByTestId('email-input');
```

**Multiple elements match:**
```typescript
// Before - fails with strict mode
this.deleteButton = page.getByRole('button', { name: 'Delete' });

// After - add visibility filter or first()
this.deleteButton = page.getByRole('button', { name: 'Delete' }).first();
// OR
this.deleteButton = page.locator('button:visible').filter({ hasText: 'Delete' }).first();
```

### 4.2 Assertion Fixes

**URL changed:**
```typescript
// Before
await expect(page).toHaveURL('/dashboard');

// After (from observation)
await expect(page).toHaveURL('/home');
```

**Text changed:**
```typescript
// Before
await expect(this.message).toHaveText('Success!');

// After (from snapshot)
await expect(this.message).toHaveText('Operation completed');
```

### 4.3 Flow Fixes

**Additional step required:**
```typescript
// Before
await this.submitButton.click();
await expect(page).toHaveURL('/dashboard');

// After (new confirmation dialog observed)
await this.submitButton.click();
await this.confirmDialog.getByRole('button', { name: 'Confirm' }).click();
await expect(page).toHaveURL('/dashboard');
```

### 4.4 Timing Fixes

**Element needs wait:**
```typescript
// Before - element not ready
await this.resultList.click();

// After - wait for element
await this.resultList.waitFor({ state: 'visible' });
await this.resultList.click();
```

**Use proper timeout:**
```typescript
// Before - hardcoded
await page.waitForTimeout(5000);

// After - use timeout manager
await page.waitForSelector('.results', { timeout: getTimeout('medium') });
```

---

## Step 5: Verify the Fix

### 5.1 Run Single Test

```bash
npx playwright test path/to/test.spec.ts --headed
```

### 5.2 Observe Execution

Watch the test run to verify:
- All steps complete successfully
- Assertions pass
- No new errors introduced

### 5.3 Run Multiple Times

For previously flaky tests:
```bash
npx playwright test path/to/test.spec.ts --repeat-each=5
```

### 5.4 Run Full Suite

Ensure fix doesn't break other tests:
```bash
npx playwright test
```

---

## Common Debug Scenarios

### Scenario 1: Locator Not Found

**Symptoms:** "Timeout waiting for selector"

**Debug steps:**
1. Navigate to page
2. Take snapshot
3. Search snapshot for element
4. If not found: element removed or renamed
5. If found: locator selector is wrong

**Common fixes:**
- Update selector to match current element
- Add wait for element to appear
- Check if element is in iframe

### Scenario 2: Strict Mode Violation

**Symptoms:** "Locator resolved to N elements"

**Debug steps:**
1. Take snapshot
2. Count matching elements
3. Identify which one is correct

**Common fixes:**
```typescript
// Add .first()
locator.first()

// Add visibility filter
locator.filter({ hasText: 'specific text' })

// Scope to container
container.locator(selector)
```

### Scenario 3: Timing/Flakiness

**Symptoms:** Test passes sometimes, fails other times

**Debug steps:**
1. Run with slowMo: 1000
2. If passes with slowMo: timing issue
3. Identify which action needs waiting

**Common fixes:**
```typescript
// Wait for specific condition
await page.waitForSelector('.loaded');

// Wait for network
await page.waitForLoadState('domcontentloaded');

// Wait for element state
await element.waitFor({ state: 'visible' });
```

### Scenario 4: Authentication Failed

**Symptoms:** Test redirects to login unexpectedly

**Debug steps:**
1. Check if .auth/{role}.json exists
2. Check if auth state is expired
3. Navigate to authenticated page manually
4. Observe if session is valid

**Common fixes:**
```bash
# Regenerate auth state
rm -rf .auth/
npx playwright test --project=setup
```

### Scenario 5: Data Issue

**Symptoms:** Test fails with "not found" or validation errors

**Debug steps:**
1. Check test data/fixtures
2. Verify data exists in test environment
3. Check if data was cleaned up by other test

**Common fixes:**
- Use factory to create fresh data
- Add data setup in beforeEach
- Ensure tests don't share mutable data

---

## Debug Checklist

```
□ Read and understand the failing test
□ Identify the error message/failure type
□ Set up browser for observation
□ Authenticate if needed
□ Navigate to starting point
□ Take initial snapshot
□ Follow each test step manually
□ Identify where behavior diverges
□ Determine root cause
□ Apply appropriate fix
□ Run test to verify fix
□ Run multiple times if previously flaky
□ Run full suite to check for regressions
□ Document any new patterns discovered
```
