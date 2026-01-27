# Rule: No Hardcoded waitForTimeout

> **Category**: Waits & Timing
> **Severity**: ERROR
> **Auto-fixable**: YES

## Summary
Never use `page.waitForTimeout()` or `page.waitFor(ms)` with hardcoded delays in production tests - they cause flaky tests and unnecessary delays.

## Rationale

The Playwright documentation explicitly states: **"Never wait for timeout in production. Tests that wait for time are inherently flaky."**

### Why waitForTimeout Causes Flaky Tests

1. **Fixed delays don't adapt to actual app state**: Hard waits force tests to pause for a set period regardless of whether the condition has been met, causing unnecessary delays if the app is ready sooner, or failures if the app takes longer than expected.

2. **Environment variability**: Tests that wait for fixed time periods fail unpredictably when the app loads slower (under heavy load, slow CI environments) or faster (local development) than expected.

3. **Non-deterministic behavior**: Race conditions emerge because the timeout duration is arbitrary - it's based on a guess about how long something "usually" takes rather than the actual state of the application.

4. **Maintenance burden**: When apps become slower, you need to increase timeout values everywhere, making tests progressively slower.

## Best Practice

Use **web-first assertions** and **locator methods** that include built-in retry mechanisms:

```typescript
// ✅ GOOD: Auto-waiting with explicit conditions
await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
await expect(page.locator('.loading-spinner')).toBeHidden();
await expect(page.locator('#user-name')).toHaveText('John Doe');

// ✅ GOOD: Wait for specific network conditions
await page.waitForResponse(resp =>
  resp.url().includes('/api/user') && resp.status() === 200
);

// ✅ GOOD: Wait for element state
await page.locator('[data-testid="submit-button"]').waitFor({ state: 'visible' });

// ✅ GOOD: Wait for function to return truthy value
await page.waitForFunction(() => window.dataLoaded === true);

// ✅ GOOD: Wait for specific load state when needed
await page.waitForLoadState('domcontentloaded');
```

### Retry Pattern for Complex Conditions

```typescript
// ✅ GOOD: Use toPass() for complex conditions that need retries
await expect(async () => {
  const response = await page.request.get('/api/status');
  expect(response.status()).toBe(200);
}).toPass();
```

## Anti-Pattern

Hard waits create **slow, fragile tests** that fail unpredictably:

```typescript
// ❌ BAD: Hardcoded timeout - flaky and slow
await page.click('[data-testid="submit"]');
await page.waitForTimeout(3000); // Why 3000? Magic number!
await expect(page.locator('.success')).toBeVisible();

// ❌ BAD: Arbitrary delays between actions
await page.fill('#email', 'test@example.com');
await page.waitForTimeout(500); // Unnecessary delay
await page.fill('#password', 'password123');

// ❌ BAD: Waiting for animations to "probably" finish
await page.click('.dropdown-toggle');
await page.waitForTimeout(300); // Assumes animation takes 300ms
await page.click('.dropdown-item');

// ❌ BAD: Waiting for API calls to "hopefully" complete
await page.click('[data-testid="load-more"]');
await page.waitForTimeout(2000); // Network might be slower!
const items = await page.locator('.list-item').count();
```

### Why These Fail

```typescript
// This test is FLAKY:
await page.click('[data-testid="submit"]');
await page.waitForTimeout(1000); // Might take 1200ms under load!
await expect(page.locator('.success')).toBeVisible(); // FAILS

// This test is SLOW:
await page.click('[data-testid="submit"]');
await page.waitForTimeout(5000); // App ready after 200ms, but waits 5000ms!
await expect(page.locator('.success')).toBeVisible();
```

## Exceptions

**Rare cases where `waitForTimeout` is acceptable** (use sparingly and document why):

1. **Debugging only** (never commit):
```typescript
// ⚠️ DEBUGGING ONLY - DO NOT COMMIT
await page.waitForTimeout(5000); // Visual inspection during development
```

2. **External service delays outside your control** (must be documented):
```typescript
// ⚠️ EXCEPTION: Third-party webhook has documented 2s processing delay
// See: https://vendor-docs.example.com/webhooks#processing-time
// TODO: Replace with polling API endpoint when available
await page.waitForTimeout(2000);
await expect(page.locator('[data-testid="webhook-status"]')).toHaveText('processed');
```

3. **Intentional delay for rate limiting** (prefer retry mechanisms):
```typescript
// ⚠️ EXCEPTION: API rate limit requires 1s between requests
// Consider using waitForResponse or retry logic instead
await page.waitForTimeout(1000);
```

**Even in these cases, prefer alternatives:**
- For debugging: Use `page.pause()` or headed mode
- For external delays: Poll API endpoints instead of waiting blindly
- For rate limits: Implement exponential backoff with retries

## Auto-fix

This rule can be auto-fixed by transforming hardcoded timeouts into explicit wait conditions:

### Transformation 1: Waiting for Element Visibility
```typescript
// BEFORE (flaky)
await page.click('[data-testid="button"]');
await page.waitForTimeout(2000);
await expect(page.locator('.result')).toBeVisible();

// AFTER (auto-fix)
await page.click('[data-testid="button"]');
await expect(page.locator('.result')).toBeVisible({ timeout: 10000 });
```

### Transformation 2: Waiting for Network Requests
```typescript
// BEFORE (flaky)
await page.click('[data-testid="load-data"]');
await page.waitForTimeout(3000);
const text = await page.locator('.data').textContent();

// AFTER (auto-fix)
await page.click('[data-testid="load-data"]');
await page.waitForResponse(resp => resp.url().includes('/api/data'));
const text = await page.locator('.data').textContent();
```

### Transformation 3: Waiting for Loading States
```typescript
// BEFORE (flaky)
await page.goto('/dashboard');
await page.waitForTimeout(1000);
await page.click('[data-testid="menu"]');

// AFTER (auto-fix)
await page.goto('/dashboard');
await expect(page.locator('[data-testid="menu"]')).toBeEnabled();
await page.click('[data-testid="menu"]');
```

### Transformation 4: Sequential Actions with Delays
```typescript
// BEFORE (slow)
await page.fill('#field1', 'value1');
await page.waitForTimeout(500);
await page.fill('#field2', 'value2');

// AFTER (auto-fix)
await page.fill('#field1', 'value1');
await page.fill('#field2', 'value2'); // Auto-waiting handles any delays
```

## Detection Patterns

Auto-fix can detect these patterns:
- `page.waitForTimeout(number)`
- `page.waitFor(number)` (deprecated)
- `await new Promise(resolve => setTimeout(resolve, ms))`
- Delays between actions without explicit conditions

## Related Rules

- [wait-explicit-conditions.md](./wait-explicit-conditions.md) - Use explicit wait conditions
- [wait-auto-waiting.md](./wait-auto-waiting.md) - Leverage Playwright's auto-waiting
- [wait-for-state.md](./wait-for-state.md) - Prefer specific states over networkidle

## References

- [Playwright Auto-waiting Documentation](https://playwright.dev/docs/actionability)
- [Playwright page.waitForTimeout API](https://playwright.dev/docs/api/class-page#page-wait-for-timeout)
- [Timeouts Against Flaky Tests (Medium)](https://adequatica.medium.com/timeouts-against-flaky-tests-true-cases-with-playwright-9f4f28d2c391)
- [Avoiding Flaky Tests in Playwright (Better Stack)](https://betterstack.com/community/guides/testing/avoid-flaky-playwright-tests/)
- [Say Goodbye to Flaky Tests (Medium)](https://medium.com/@samuel.sperling/say-goodbye-to-flaky-tests-playwright-best-practices-every-test-automation-engineer-must-know-9dfeb9bb5017)
- [Understanding Playwright Timeout (BrowserStack)](https://www.browserstack.com/guide/playwright-timeout)
- [Smart Waits in Playwright (Medium)](https://medium.com/@divyakandpal93/smart-waits-in-playwright-avoid-flaky-tests-like-a-pro-779be48e8b0b)

---

**Key Takeaway**: Playwright's auto-waiting mechanism is intelligent - it continuously checks conditions and moves forward as soon as they're met, unlike older tools where timeouts act as hard sleeps. Trust the framework's built-in mechanisms instead of adding arbitrary delays.
