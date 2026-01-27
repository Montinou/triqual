# Rule: Test Naming

> **Category**: Test Organization
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Use descriptive, behavior-focused test names that clearly communicate what is being tested and the expected outcome.

## Rationale

Descriptive test names provide critical benefits:

- **Self-documenting tests**: Names serve as living documentation of system behavior
- **Faster debugging**: Failed tests immediately indicate what broke without reading code
- **Better reports**: CI/CD reports with clear test names help teams identify issues quickly
- **Team communication**: Non-technical stakeholders understand test coverage
- **Maintenance**: Developers quickly locate relevant tests when modifying features
- **Test discovery**: Teams can find related tests using search

The Playwright community emphasizes: "Use descriptive test names and file names - checkout.spec.ts is clearer than test3.spec.ts."

## Best Practice

Write test names that describe behavior and expected outcomes:

```typescript
import { test, expect } from '@playwright/test';

// Good - describes user action and expected outcome
test('should display error message when login fails with invalid credentials', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'invalid@example.com');
  await page.fill('[name="password"]', 'wrongpassword');
  await page.click('button[type="submit"]');
  await expect(page.locator('.error-message')).toHaveText('Invalid credentials');
});

// Good - specific about what changes
test('should increment cart count when adding product', async ({ page }) => {
  await page.goto('/products');
  await page.click('[data-testid="add-to-cart-1"]');
  await expect(page.locator('.cart-count')).toHaveText('1');
});

// Good - describes edge case clearly
test('should show validation error when email field is empty on submit', async ({ page }) => {
  await page.goto('/login');
  await page.click('button[type="submit"]');
  await expect(page.locator('[name="email"]:invalid')).toBeVisible();
});

// Good - test.step for complex flows
test('should complete checkout process', async ({ page }) => {
  await test.step('Add item to cart', async () => {
    await page.goto('/products');
    await page.click('[data-testid="add-to-cart-1"]');
  });

  await test.step('Enter shipping information', async () => {
    await page.goto('/checkout');
    await page.fill('[name="address"]', '123 Main St');
  });

  await test.step('Complete payment', async () => {
    await page.fill('[name="cardNumber"]', '4242424242424242');
    await page.click('button:has-text("Place order")');
  });
});
```

## Anti-Pattern

Vague, technical, or numbered test names that don't describe behavior:

```typescript
// Bad - vague, doesn't describe what's being tested
test('test 1', async ({ page }) => {
  await page.goto('/login');
  await page.click('button');
});

// Bad - technical implementation details instead of behavior
test('should call POST /api/auth with credentials', async ({ page }) => {
  // Tests implementation, not user-facing behavior
});

// Bad - numbered tests with no context
test('login test 2', async ({ page }) => {
  // What makes this different from test 1?
});

// Bad - describes implementation, not behavior
test('should set localStorage token', async ({ page }) => {
  // Focus on user outcome, not implementation
});

// Bad - ambiguous "should work"
test('cart should work', async ({ page }) => {
  // Too vague - what aspect of cart is tested?
});

// Bad - not descriptive of what's tested
test('test edge case', async ({ page }) => {
  // Which edge case?
});
```

## Exceptions

**Short names acceptable for parameterized tests with clear context**:
```typescript
const browsers = ['chromium', 'firefox', 'webkit'];

for (const browser of browsers) {
  test(`${browser}: should render home page`, async ({ page }) => {
    // Browser name adds context
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();
  });
}
```

**Data-driven tests with test.describe for context**:
```typescript
test.describe('Product filtering', () => {
  const filters = [
    { category: 'electronics', expectedCount: 24 },
    { category: 'clothing', expectedCount: 156 },
    { category: 'books', expectedCount: 89 },
  ];

  for (const { category, expectedCount } of filters) {
    test(`should show ${expectedCount} items for ${category}`, async ({ page }) => {
      await page.goto(`/products?category=${category}`);
      await expect(page.locator('.product-card')).toHaveCount(expectedCount);
    });
  }
});
```

## Auto-fix

This rule is NOT auto-fixable. Naming guidelines:

**Pattern**: `should [expected behavior] when/after [action/condition]`

**Before - poor names**:
```typescript
test('test1', async ({ page }) => {});
test('login works', async ({ page }) => {});
test('error', async ({ page }) => {});
```

**After - descriptive names**:
```typescript
test('should redirect to dashboard when login succeeds with valid credentials', async ({ page }) => {});
test('should display error message when login fails with invalid password', async ({ page }) => {});
test('should show validation error when email field is empty', async ({ page }) => {});
```

**File naming conventions**:
```typescript
// Good - clear feature names
login.spec.ts
shopping-cart.spec.ts
user-profile-settings.spec.ts

// Bad - vague or technical
test1.spec.ts
api-test.spec.ts
stuff.spec.ts
```

**Function and method naming**:
```typescript
// Good - verb + context
async function clickLoginButton() {}
async function fillUserEmail(email: string) {}
async function waitForDashboardLoad() {}

// Bad - unclear actions
async function doLogin() {}
async function test1() {}
async function go() {}
```

## Related Rules

- [test-describe-grouping.md](./test-describe-grouping.md) - Naming test groups
- [test-isolation.md](./test-isolation.md) - Names should reflect independence
- [test-hooks.md](./test-hooks.md) - Descriptive setup and cleanup

## References

- [Playwright Docs: Writing Tests](https://playwright.dev/docs/writing-tests)
- [BigBinary Academy: Test Organization and Conventions](https://courses.bigbinaryacademy.com/learn-qa-automation-using-playwright/test-organization-and-conventions/)
- [Boyana.dev: Using Naming Conventions to Improve Playwright Testing Framework](https://www.boyana.dev/posts/playwright-naming-convenventions)
- [Medium: Naming Conventions Used in Playwright Automation](https://medium.com/@kundalikjadhav5545/naming-conventions-used-in-playwright-automation-8762bdb9b10b)
- [Houseful Blog: Our Playwright Testing Standards](https://www.houseful.blog/posts/2023/playwright-standards/)
