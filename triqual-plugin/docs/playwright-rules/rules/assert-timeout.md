# Rule: Configure Assertion Timeouts Properly

> **Category**: Assertions
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Configure assertion timeouts appropriately using global config (`expect.timeout`), per-assertion options, or custom expect instances rather than relying solely on default 5-second timeouts or adding manual waits.

## Rationale

Assertion timeouts determine how long Playwright will retry an assertion before failing. Proper timeout configuration:
- **Prevents false failures**: Slow-loading content won't cause premature test failures
- **Improves test speed**: Shorter timeouts for fast operations reduce execution time
- **Eliminates manual waits**: Assertion auto-retry replaces `page.waitForTimeout()`
- **Provides clarity**: Explicit timeouts document expected behavior

The default 5-second timeout works for most cases, but different scenarios require different timeouts:
- **Fast operations**: Element visibility, enabled state (2-3s may suffice)
- **Network operations**: API calls, data loading (10-15s may be needed)
- **Heavy processing**: Report generation, file uploads (30s+ may be required)

Note: Assertion timeout is separate from and unrelated to test timeout (configured separately).

## Best Practice

Configure timeouts at the appropriate level for your needs:

```typescript
// ✅ CORRECT: Global configuration in playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: {
    timeout: 10_000, // 10 seconds for all assertions
  },
  // Note: This is separate from test timeout
  timeout: 30_000, // 30 seconds for entire test
});

// ✅ CORRECT: Per-assertion timeout for slow operations
test('file upload completes', async ({ page }) => {
  await page.goto('/upload');
  await page.getByLabel('File').setInputFiles('large-file.pdf');
  await page.getByRole('button', { name: 'Upload' }).click();

  // Longer timeout for file processing
  await expect(page.getByText('Upload complete')).toBeVisible({ timeout: 30_000 });
});

// ✅ CORRECT: Custom expect instance for specific timeout needs
test('dashboard with custom timeout', async ({ page }) => {
  const slowExpect = expect.configure({ timeout: 15_000 });

  await page.goto('/dashboard');

  // All these use 15s timeout
  await slowExpect(page.getByTestId('revenue-chart')).toBeVisible();
  await slowExpect(page.getByTestId('user-analytics')).toBeVisible();
  await slowExpect(page.getByTestId('recent-orders')).toBeVisible();
});

// ✅ CORRECT: Shorter timeout for fast checks
test('button state changes immediately', async ({ page }) => {
  await page.goto('/form');

  const checkbox = page.getByLabel('I agree to terms');
  const submitButton = page.getByRole('button', { name: 'Submit' });

  // Fast check - should be immediate
  await expect(submitButton).toBeDisabled({ timeout: 2_000 });

  await checkbox.check();

  // Fast check - should be immediate
  await expect(submitButton).toBeEnabled({ timeout: 2_000 });
});

// ✅ CORRECT: Different timeouts for different assertion types
test('order processing workflow', async ({ page }) => {
  await page.goto('/checkout');

  // Fast UI interaction - default 5s is fine
  await expect(page.getByRole('button', { name: 'Place Order' })).toBeVisible();

  await page.getByRole('button', { name: 'Place Order' }).click();

  // Processing indicator - medium timeout
  await expect(page.getByText('Processing...')).toBeVisible({ timeout: 10_000 });

  // Backend processing - longer timeout
  await expect(page.getByText('Order confirmed')).toBeVisible({ timeout: 30_000 });
});
```

## Anti-Pattern

Avoid these timeout anti-patterns:

```typescript
// ❌ WRONG: Using manual waits instead of assertion timeouts
test('wait for data loading', async ({ page }) => {
  await page.goto('/dashboard');

  // Don't use manual waits
  await page.waitForTimeout(5000);

  await expect(page.getByTestId('data-table')).toBeVisible();
  // Use: await expect(...).toBeVisible({ timeout: 10_000 })
});

// ❌ WRONG: Chaining manual wait with assertion
test('form submission', async ({ page }) => {
  await page.getByRole('button', { name: 'Submit' }).click();

  // Redundant - assertion already retries
  await page.waitForSelector('[data-testid="success"]');
  await expect(page.getByTestId('success')).toBeVisible();
  // Just use: await expect(...).toBeVisible({ timeout: N })
});

// ❌ WRONG: Setting unreasonably long timeout as default
export default defineConfig({
  expect: {
    timeout: 60_000, // 60 seconds - too long for most assertions
  },
});
// This will slow down ALL failing tests unnecessarily

// ❌ WRONG: Using same timeout for all operations
test('mixed operations', async ({ page }) => {
  const slowExpect = expect.configure({ timeout: 30_000 });

  // Fast check doesn't need 30s timeout
  await slowExpect(page.getByRole('button')).toBeVisible();

  // Only the slow operation needs it
  await slowExpect(page.getByText('Processing complete')).toBeVisible();
});

// ❌ WRONG: No timeout for operations that should be fast
test('immediate UI feedback', async ({ page }) => {
  await page.getByRole('button', { name: 'Click me' }).click();

  // Using default 5s for something that should be instant
  await expect(page.getByText('Clicked!')).toBeVisible();
  // Should use: { timeout: 1_000 } to catch slow rendering bugs
});

// ❌ WRONG: Assuming assertion timeout is the same as test timeout
test('long running test', async ({ page }) => {
  // Test timeout is 30s, but assertion timeout might be 5s
  await page.goto('/report');

  // This will fail after 5s (assertion timeout), not 30s (test timeout)
  await expect(page.getByText('Report generated')).toBeVisible();
});
```

## Exceptions

Use manual waits when:

1. **Waiting for animations to complete** (not recommended, but sometimes necessary):
   ```typescript
   // OK: Wait for CSS animation
   await page.getByRole('dialog').waitFor({ state: 'visible' });
   await page.waitForTimeout(300); // Animation duration
   ```

2. **Debugging** (never commit these):
   ```typescript
   // OK: Temporary debugging
   await page.pause();
   await page.waitForTimeout(5000); // To inspect state
   ```

3. **Third-party integrations** with unpredictable timing:
   ```typescript
   // OK: External payment provider iframe load time
   await page.getByRole('button', { name: 'Pay' }).click();
   await page.waitForTimeout(2000); // Allow iframe to initialize
   await expect(page.frameLocator('iframe').getByText('Amount')).toBeVisible();
   ```

## Auto-fix

This rule is NOT auto-fixable because:
- Appropriate timeout values depend on application behavior and performance
- Converting manual waits to assertion timeouts requires understanding the intent
- Timeout values should be based on actual performance metrics, not guessed

However, the following patterns can be suggested:

| Anti-Pattern | Suggested Fix |
|-------------|---------------|
| `page.waitForTimeout(N); expect(locator).toBeVisible()` | `expect(locator).toBeVisible({ timeout: N })` |
| `page.waitForSelector(selector); expect(locator)...` | `expect(locator)...{ timeout: N }` |
| No timeout on slow operation | Add `{ timeout: N }` based on observed behavior |

## Related Rules

- [assert-web-first.md](./assert-web-first.md) - Use web-first assertions
- [assert-specific.md](./assert-specific.md) - Use specific assertion methods
- [assert-soft.md](./assert-soft.md) - Use soft assertions appropriately

## References

- [Playwright Assertions](https://playwright.dev/docs/test-assertions)
- [Playwright Timeouts](https://playwright.dev/docs/test-timeouts)
- [How to Change Timeout Settings in Playwright](https://betterstack.com/community/questions/playwright-timeout/)
- [Understanding Playwright Timeout (BrowserStack)](https://www.browserstack.com/guide/playwright-timeout)
- [Playwright Timeout: How to Change and Fix](https://blog.apify.com/playwright-timeout/)
- [TestConfig API](https://playwright.dev/docs/api/class-testconfig)
