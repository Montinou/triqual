# Rule: Use Soft Assertions Appropriately

> **Category**: Assertions
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Use soft assertions (`expect.soft()`) when you want to continue test execution after assertion failures to collect multiple errors, but avoid overusing them as they can mask critical failures and make test results harder to interpret.

## Rationale

Soft assertions provide a way to collect multiple assertion failures in a single test run instead of stopping at the first failure. This is valuable for:
- **Comprehensive validation**: Check multiple properties of a complex UI state
- **Debugging efficiency**: See all failures at once rather than fixing one at a time
- **Data validation**: Validate multiple fields in a form or API response
- **Visual regression**: Check multiple visual aspects before failing

However, overusing soft assertions can:
- **Hide critical failures**: Tests continue running even after fatal errors
- **Create confusion**: Unclear which failure is the root cause
- **Reduce signal**: Too many failures make it hard to identify the actual problem
- **Waste resources**: Tests continue executing expensive operations after they should stop

## Best Practice

Use soft assertions strategically for comprehensive validation:

```typescript
// ✅ CORRECT: Validate multiple form fields together
test('contact form validation', async ({ page }) => {
  await page.goto('/contact');
  await page.getByRole('button', { name: 'Submit' }).click();

  // Check all validation errors at once
  await expect.soft(page.getByText('Name is required')).toBeVisible();
  await expect.soft(page.getByText('Email is required')).toBeVisible();
  await expect.soft(page.getByText('Message is required')).toBeVisible();
  await expect.soft(page.getByText('Phone number is invalid')).toBeVisible();
});

// ✅ CORRECT: Validate complex UI state
test('dashboard displays correct data', async ({ page }) => {
  await page.goto('/dashboard');

  // Check all dashboard components
  await expect.soft(page.getByTestId('total-orders')).toHaveText('42');
  await expect.soft(page.getByTestId('revenue')).toHaveText('$12,345');
  await expect.soft(page.getByTestId('active-users')).toHaveText('156');
  await expect.soft(page.getByTestId('conversion-rate')).toHaveText('3.2%');

  // Hard assertion to ensure test failed if any soft assertions failed
  expect(test.info().errors).toHaveLength(0);
});

// ✅ CORRECT: Validate API response fields
test('user profile API returns complete data', async ({ request }) => {
  const response = await request.get('/api/user/profile');
  const data = await response.json();

  await expect.soft(response).toBeOK();
  expect.soft(data.id).toBeDefined();
  expect.soft(data.email).toMatch(/@/);
  expect.soft(data.name).toBeTruthy();
  expect.soft(data.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);

  expect(test.info().errors).toHaveLength(0);
});

// ✅ CORRECT: Configure soft assertions for entire expect instance
test('use preconfigured soft expect', async ({ page }) => {
  const softExpect = expect.configure({ soft: true });

  await page.goto('/products');
  await softExpect(page.getByRole('heading')).toHaveText('Products');
  await softExpect(page.getByRole('listitem')).toHaveCount(10);
  await softExpect(page.getByText('Load more')).toBeVisible();
});
```

## Anti-Pattern

Avoid overusing soft assertions or using them inappropriately:

```typescript
// ❌ WRONG: Soft assertion for critical precondition
test('checkout process', async ({ page }) => {
  await page.goto('/cart');

  // This should be a hard assertion - if login fails, nothing else matters
  await expect.soft(page.getByTestId('user-menu')).toBeVisible();

  // These will fail if user isn't logged in
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Credit Card').fill('4111111111111111');
});

// ❌ WRONG: All soft assertions without final check
test('form validation', async ({ page }) => {
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect.soft(page.getByText('Email required')).toBeVisible();
  await expect.soft(page.getByText('Password required')).toBeVisible();

  // Missing: expect(test.info().errors).toHaveLength(0);
  // Test will be marked as PASSED even if assertions failed!
});

// ❌ WRONG: Soft assertions for sequential dependent steps
test('multi-step workflow', async ({ page }) => {
  // Each step depends on the previous one succeeding
  await expect.soft(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect.soft(page.getByRole('heading')).toHaveText('Step 2');
  await page.getByLabel('Amount').fill('100');

  await expect.soft(page.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  // If step 2 heading wasn't there, the rest is meaningless
});

// ❌ WRONG: Soft assertions mixing critical and non-critical checks
test('payment processing', async ({ page }) => {
  await page.goto('/checkout');

  // Critical check - should fail hard
  await expect.soft(page.getByText('Payment Method')).toBeVisible();

  // Non-critical styling check
  await expect.soft(page.getByTestId('total')).toHaveCSS('font-weight', '700');

  await page.getByRole('button', { name: 'Pay Now' }).click();
  // If payment section wasn't visible, payment will fail
});
```

## Exceptions

Always use hard assertions (regular `expect()`) for:

1. **Critical preconditions** that must pass for the test to be meaningful:
   ```typescript
   // Hard assertion for authentication
   await expect(page.getByTestId('user-menu')).toBeVisible();
   ```

2. **Sequential dependencies** where later steps require earlier ones:
   ```typescript
   // Hard assertion before dependent action
   await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
   await page.getByRole('button', { name: 'Submit' }).click();
   ```

3. **Single assertion** tests:
   ```typescript
   // No need for soft assertions with only one check
   await expect(page.getByRole('heading')).toHaveText('Welcome');
   ```

## Auto-fix

This rule is NOT auto-fixable because the decision to use soft vs hard assertions requires understanding the test's intent and the criticality of each assertion.

## Related Rules

- [assert-web-first.md](./assert-web-first.md) - Use web-first assertions
- [assert-specific.md](./assert-specific.md) - Use specific assertion methods
- [assert-timeout.md](./assert-timeout.md) - Configure assertion timeouts

## References

- [Playwright Assertions - Soft Assertions](https://playwright.dev/docs/test-assertions#soft-assertions)
- [Improve Your Test Experience with Playwright Soft Assertions](https://timdeschryver.dev/blog/improve-your-test-experience-with-playwright-soft-assertions)
- [Understanding Playwright Assertions (BrowserStack)](https://www.browserstack.com/guide/playwright-assertions)
- [Playwright Assertions Best Practices (Checkly)](https://www.checklyhq.com/docs/learn/playwright/assertions/)
- [Different Assertion Types in Playwright](https://medium.com/@testerstalk/different-assertion-types-in-playwright-9784c2657253)
