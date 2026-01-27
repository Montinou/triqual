# Rule: Test Grouping with test.describe

> **Category**: Test Organization
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Use test.describe() to group related tests logically, scope hooks to specific test groups, and improve test organization and readability.

## Rationale

Proper test grouping provides:

- **Logical organization**: Groups tests by feature, user journey, or component
- **Scoped hooks**: beforeEach/afterEach apply only to tests within the group
- **Better reporting**: Test results show hierarchical structure in reports
- **Selective execution**: Run or skip entire groups with .only() or .skip()
- **Parallel configuration**: Control execution mode per group
- **Team collaboration**: Clear structure helps teams understand test coverage

Playwright's documentation emphasizes: "You can group tests to give them a logical name or to scope before/after hooks to the group."

## Best Practice

Organize tests by feature or user journey with scoped hooks:

```typescript
import { test, expect } from '@playwright/test';

test.describe('User authentication', () => {
  // Hooks scoped to this group only
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.fill('[name="email"]', 'user@example.com');
    await page.fill('[name="password"]', 'Test123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');
  });

  test('should show error with invalid credentials', async ({ page }) => {
    await page.fill('[name="email"]', 'wrong@example.com');
    await page.fill('[name="password"]', 'wrong');
    await page.click('button[type="submit"]');
    await expect(page.locator('.error-message')).toBeVisible();
  });

  // Nested groups for sub-features
  test.describe('Password reset', () => {
    test('should send reset email', async ({ page }) => {
      await page.click('a:has-text("Forgot password?")');
      await page.fill('[name="email"]', 'user@example.com');
      await page.click('button:has-text("Send reset link")');
      await expect(page.locator('.success-message')).toBeVisible();
    });
  });
});

test.describe('Shopping cart', () => {
  test.beforeEach(async ({ page }) => {
    // Different setup for shopping cart tests
    await page.goto('/products');
  });

  test('should add item to cart', async ({ page }) => {
    await page.click('[data-testid="add-to-cart-1"]');
    await expect(page.locator('.cart-count')).toHaveText('1');
  });
});

// Parallel execution for independent tests
test.describe('Product search', () => {
  test.describe.configure({ mode: 'parallel' });

  test('search test 1', async ({ page }) => {
    // Runs in parallel with test 2
  });

  test('search test 2', async ({ page }) => {
    // Runs in parallel with test 1
  });
});
```

## Anti-Pattern

Flat test structure without logical grouping:

```typescript
// Bad - no organization, unclear relationships
import { test, expect } from '@playwright/test';

test('test 1 - login success', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'user@example.com');
  await page.click('button[type="submit"]');
});

test('test 2 - login failure', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'wrong@example.com');
  await page.click('button[type="submit"]');
});

test('test 3 - add to cart', async ({ page }) => {
  // Completely different feature mixed with login tests
  await page.goto('/products');
  await page.click('[data-testid="add-to-cart"]');
});

test('test 4 - password reset', async ({ page }) => {
  // Related to login but not grouped
  await page.goto('/login');
  await page.click('a:has-text("Forgot password?")');
});

// No hooks - duplicated setup in every test
// No clear feature boundaries
// Hard to run related tests together
```

## Exceptions

**Use anonymous describe for configuration**:
```typescript
// Anonymous group for applying configuration
test.describe(() => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('wide viewport test 1', async ({ page }) => {
    // Uses custom viewport
  });

  test('wide viewport test 2', async ({ page }) => {
    // Uses custom viewport
  });
});
```

**Use test.describe.serial for genuine user journeys**:
```typescript
// Acceptable for multi-step flows that cannot be split
test.describe.serial('E2E checkout flow', () => {
  test('step 1: add items', async ({ page }) => {
    // Complex setup
  });

  test('step 2: checkout', async ({ page }) => {
    // Depends on step 1
  });

  test('step 3: payment', async ({ page }) => {
    // Depends on step 2
  });
});
```

**Note**: Serial mode is discouraged. Prefer isolated tests when possible.

## Auto-fix

This rule is NOT auto-fixable. Refactoring guidance:

**Identify grouping patterns**:
1. Group by feature: "User authentication", "Shopping cart", "Search"
2. Group by component: "Navigation menu", "Product card", "Footer"
3. Group by user journey: "New user onboarding", "Purchase flow"

**Before - flat structure**:
```typescript
test('login with valid credentials', async ({ page }) => {});
test('login with invalid credentials', async ({ page }) => {});
test('password reset request', async ({ page }) => {});
test('add item to cart', async ({ page }) => {});
```

**After - organized groups**:
```typescript
test.describe('Authentication', () => {
  test('login with valid credentials', async ({ page }) => {});
  test('login with invalid credentials', async ({ page }) => {});

  test.describe('Password reset', () => {
    test('should send reset email', async ({ page }) => {});
  });
});

test.describe('Shopping cart', () => {
  test('should add item', async ({ page }) => {});
});
```

## Related Rules

- [test-isolation.md](./test-isolation.md) - Groups don't create dependencies
- [test-hooks.md](./test-hooks.md) - Scoping hooks to groups
- [test-naming.md](./test-naming.md) - Descriptive group and test names

## References

- [Playwright Docs: API - test.describe](https://playwright.dev/docs/api/class-test#test-describe)
- [Playwright Docs: Annotations](https://playwright.dev/docs/test-annotations)
- [Testomat.io: Grouping Playwright Tests for Improved Framework Efficiency](https://testomat.io/blog/grouping-playwright-tests-for-improved-framework-efficiency/)
- [BigBinary Academy: Test Organization and Conventions](https://courses.bigbinaryacademy.com/learn-qa-automation-using-playwright/test-organization-and-conventions/)
- [Medium: Playwright Test Annotations & Grouping with describe()](https://dev.to/wishinfinite/playwright-test-annotations-grouping-with-describe-full-tutorial-2gn3)
