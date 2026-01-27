# Rule: Test Isolation

> **Category**: Test Organization
> **Severity**: ERROR
> **Auto-fixable**: NO

## Summary

Each test must be completely isolated and run independently with its own local storage, session storage, data, and cookies.

## Rationale

Test isolation is critical for parallel execution and test reliability. When tests depend on each other, they:

- Fail unpredictably when run in different orders or parallel workers
- Create cascading failures where one broken test causes many others to fail
- Make debugging difficult as failures may be caused by distant tests
- Cannot leverage Playwright's parallel execution capabilities

Playwright executes parallel tests in separate worker processes that cannot share state. Workers are shut down after test failures to guarantee pristine environments. Tests that violate isolation will fail intermittently and waste engineering time.

## Best Practice

Use fixtures and hooks to establish independent test environments:

```typescript
// Good - each test is completely isolated
import { test, expect } from '@playwright/test';

test.describe('Shopping cart', () => {
  test.beforeEach(async ({ page }) => {
    // Each test starts with fresh authentication
    await page.goto('/login');
    await page.fill('[name="email"]', `user-${Date.now()}@test.com`);
    await page.fill('[name="password"]', 'Test123!');
    await page.click('button[type="submit"]');
  });

  test('should add item to cart', async ({ page }) => {
    await page.goto('/products');
    await page.click('button[data-testid="add-to-cart-1"]');
    await expect(page.locator('.cart-count')).toHaveText('1');
  });

  test('should remove item from cart', async ({ page }) => {
    // Does NOT depend on previous test - creates its own cart state
    await page.goto('/products');
    await page.click('button[data-testid="add-to-cart-1"]');
    await page.click('button[data-testid="remove-from-cart-1"]');
    await expect(page.locator('.cart-count')).toHaveText('0');
  });
});
```

## Anti-Pattern

Tests that depend on execution order or shared state:

```typescript
// Bad - tests depend on each other and shared state
import { test, expect } from '@playwright/test';

let cartItemCount = 0; // Shared global state - WRONG!

test.describe('Shopping cart', () => {
  test.beforeAll(async ({ page }) => {
    // Setup runs once - state leaks between tests
    await page.goto('/login');
    await page.fill('[name="email"]', 'shared-user@test.com');
    await page.click('button[type="submit"]');
  });

  test('test 1: add first item', async ({ page }) => {
    await page.goto('/products');
    await page.click('button[data-testid="add-to-cart-1"]');
    cartItemCount++;
    await expect(page.locator('.cart-count')).toHaveText('1');
  });

  test('test 2: add second item', async ({ page }) => {
    // FAILS if run in parallel or after test 3
    // Depends on test 1 having run first
    await page.click('button[data-testid="add-to-cart-2"]');
    cartItemCount++;
    await expect(page.locator('.cart-count')).toHaveText('2');
  });

  test('test 3: verify cart total', async ({ page }) => {
    // FAILS if test 1 or 2 haven't run
    // Relies on global variable and previous test state
    await expect(page.locator('.cart-count')).toHaveText(String(cartItemCount));
  });
});
```

## Exceptions

Use `test.describe.serial()` only when tests represent a genuine user journey that cannot be split:

```typescript
// Acceptable use of serial - complex multi-step flow
test.describe.serial('Complete checkout flow', () => {
  test('step 1: add items', async ({ page }) => {
    // Complex setup that cannot be reasonably extracted
  });

  test('step 2: enter shipping', async ({ page }) => {
    // Depends on step 1 state
  });

  test('step 3: complete payment', async ({ page }) => {
    // Depends on step 2 state
  });
});
```

**Warning**: Serial mode is discouraged by Playwright. If one test fails, all subsequent tests skip. The entire group retries together, wasting CI resources.

## Auto-fix

This rule is NOT auto-fixable. Violations require manual refactoring:

1. Extract shared setup to `beforeEach` hooks
2. Remove global variables and shared state
3. Use unique test data per test (e.g., `user-${testInfo.workerIndex}`)
4. Ensure each test can run independently in any order

## Related Rules

- [test-hooks.md](./test-hooks.md) - Proper use of beforeEach/afterEach for isolation
- [test-fixtures.md](./test-fixtures.md) - Using fixtures for reusable isolated setup
- [test-describe-grouping.md](./test-describe-grouping.md) - Organizing tests without creating dependencies

## References

- [Playwright Docs: Best Practices - Test Isolation](https://playwright.dev/docs/best-practices#test-isolation)
- [Playwright Docs: Parallelism](https://playwright.dev/docs/test-parallel)
- [BrowserStack: 15 Best Practices for Playwright Testing](https://www.browserstack.com/guide/playwright-best-practices)
- [Checkly: How to Run Playwright Tests in Parallel](https://www.checklyhq.com/docs/learn/playwright/testing-in-parallel/)
