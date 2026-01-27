# Rule: Test Hooks

> **Category**: Test Organization
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Use beforeEach/afterEach for test-level setup and cleanup, beforeAll/afterAll for worker-level setup, ensuring proper scoping and resource cleanup.

## Rationale

Proper hook usage ensures:

- **Test isolation**: Each test starts with clean state via beforeEach
- **Resource management**: afterEach cleans up resources that could affect other tests
- **Performance**: beforeAll/afterAll reduce redundant setup for shared resources
- **Maintainability**: Centralized setup logic is easier to modify than scattered initialization

Incorrect hook usage leads to state leakage between tests, resource exhaustion, and flaky test behavior in parallel execution.

## Best Practice

Use hooks at the appropriate level with proper cleanup:

```typescript
import { test, expect } from '@playwright/test';

test.describe('User dashboard', () => {
  // Worker-level setup - runs once per worker process
  test.beforeAll(async ({ browser }) => {
    // Expensive operations like starting a mock server
    console.log('Starting mock API server');
  });

  // Test-level setup - runs before EACH test
  test.beforeEach(async ({ page }) => {
    // Lightweight operations for test isolation
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'Test123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');
  });

  // Test-level cleanup - runs after EACH test
  test.afterEach(async ({ page }, testInfo) => {
    // Clean up resources to prevent state leakage
    if (testInfo.status !== 'passed') {
      await page.screenshot({ path: `failure-${testInfo.title}.png` });
    }
    // Clear storage to ensure isolation
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
  });

  test('should display user profile', async ({ page }) => {
    await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
  });

  test('should show recent activity', async ({ page }) => {
    await expect(page.locator('[data-testid="activity-feed"]')).toBeVisible();
  });

  // Worker-level cleanup - runs once after all tests
  test.afterAll(async () => {
    console.log('Shutting down mock API server');
  });
});
```

## Anti-Pattern

Misusing hooks leads to state leakage and maintenance issues:

```typescript
// Bad - multiple anti-patterns
import { test, expect } from '@playwright/test';

test.describe('User dashboard', () => {
  // WRONG: beforeAll for test-specific setup creates state leakage
  test.beforeAll(async ({ page }) => {
    // This page instance persists across tests!
    await page.goto('/login');
    await page.fill('[name="email"]', 'shared@example.com');
    await page.click('button[type="submit"]');
  });

  // WRONG: Heavy operations in beforeEach
  test.beforeEach(async ({ page }) => {
    // Starting a server on EVERY test is wasteful
    await startMockServer();
    await seedDatabase();
  });

  test('test 1', async ({ page }) => {
    // Uses the logged-in state from beforeAll
    await page.click('[data-testid="profile-button"]');
  });

  test('test 2', async ({ page }) => {
    // FAILS if test 1 modified the shared state
    // e.g., if test 1 changed user settings
    await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
  });

  // WRONG: No afterEach cleanup - state leaks to next test
  // WRONG: No afterAll cleanup - resources not released
});
```

## Exceptions

**Skip cleanup when not needed**:
```typescript
test.afterEach(async ({ page }, testInfo) => {
  // Skip cleanup if test passed and no shared resources used
  if (testInfo.status === 'passed') {
    return; // Playwright cleans up page/context automatically
  }

  // Only clean up on failure for debugging
  await page.screenshot({ path: 'failure.png' });
});
```

**Use fixtures instead of hooks for complex setup**:
```typescript
// Better approach - use fixtures for reusable setup
const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.click('button[type="submit"]');
    await use(page);
    // Automatic cleanup after test
  },
});
```

## Auto-fix

This rule is NOT auto-fixable. Common refactoring patterns:

**Pattern 1: Move beforeAll test setup to beforeEach**
```typescript
// Before - state leakage
test.beforeAll(async ({ page }) => {
  await page.goto('/app');
});

// After - proper isolation
test.beforeEach(async ({ page }) => {
  await page.goto('/app');
});
```

**Pattern 2: Add missing afterEach cleanup**
```typescript
// Before - no cleanup
test.beforeEach(async ({ page }) => {
  await page.goto('/app');
});

// After - with cleanup
test.beforeEach(async ({ page }) => {
  await page.goto('/app');
});

test.afterEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
});
```

## Related Rules

- [test-isolation.md](./test-isolation.md) - Core isolation requirements
- [test-fixtures.md](./test-fixtures.md) - Fixtures as alternative to hooks
- [test-describe-grouping.md](./test-describe-grouping.md) - Hook scope within groups

## References

- [Playwright Docs: API - test.beforeEach](https://playwright.dev/docs/api/class-test#test-before-each)
- [Playwright Docs: API - test.afterEach](https://playwright.dev/docs/api/class-test#test-after-each)
- [BrowserStack: Understanding Playwright BeforeAll, BeforeEach, AfterEach, and AfterAll](https://www.browserstack.com/guide/playwright-before-all)
- [Qable: Master Playwright Test Hooks](https://www.qable.io/blog/exploring-playwright-test-hooks)
