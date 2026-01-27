# Rule: network-wait-response

> **Category**: Network
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Wait for specific API responses before making assertions to prevent flaky tests caused by race conditions.

## Rationale

Modern web applications make asynchronous API calls that update the UI dynamically. Tests that don't wait for these responses often fail intermittently because:
- Assertions run before data loads
- UI elements don't exist yet or show stale data
- Network timing varies between test runs

Using `page.waitForResponse()` ensures tests wait for specific API calls to complete before asserting on the resulting UI state. This aligns with [Playwright's network waiting patterns](https://playwright.dev/docs/network) and eliminates a major source of test flakiness discussed in [best practices guides](https://www.browserstack.com/guide/playwright-best-practices).

## Best Practice

Use `page.waitForResponse()` to wait for specific API responses before assertions.

```typescript
import { test, expect } from '@playwright/test';

// Good - wait for specific API response
test('waits for user data to load', async ({ page }) => {
  await page.goto('/profile');

  // Wait for the API call that populates user data
  const response = await page.waitForResponse(
    (response) => response.url().includes('/api/users/123') && response.status() === 200
  );

  // Now safe to assert on data-dependent elements
  await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
});

// Good - wait for GraphQL operation
test('waits for GraphQL query', async ({ page }) => {
  await page.goto('/posts');

  // Wait for specific GraphQL operation
  const response = await page.waitForResponse(async (response) => {
    if (!response.url().includes('/graphql')) return false;

    const json = await response.json();
    return json.data?.posts !== undefined;
  });

  const posts = await response.json();
  expect(posts.data.posts).toHaveLength(3);
  await expect(page.locator('[data-testid="post"]')).toHaveCount(3);
});

// Good - wait alongside action that triggers request
test('waits for search results', async ({ page }) => {
  await page.goto('/search');

  // Trigger search and wait for response simultaneously
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/search')),
    page.fill('[data-testid="search-input"]', 'playwright'),
    page.press('[data-testid="search-input"]', 'Enter')
  ]);

  expect(response.status()).toBe(200);
  await expect(page.locator('[data-testid="result"]')).toHaveCount(5);
});

// Good - wait for multiple responses
test('waits for parallel API calls', async ({ page }) => {
  const [userResponse, postsResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/user')),
    page.waitForResponse((res) => res.url().includes('/api/posts')),
    page.goto('/dashboard')
  ]);

  expect(userResponse.status()).toBe(200);
  expect(postsResponse.status()).toBe(200);

  await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
  await expect(page.locator('[data-testid="post"]')).toHaveCount(3);
});

// Good - validate response data before UI assertions
test('validates API response content', async ({ page }) => {
  await page.goto('/checkout');

  const response = await page.waitForResponse(
    (res) => res.url().includes('/api/cart')
  );

  const cart = await response.json();
  expect(cart.items).toHaveLength(2);
  expect(cart.total).toBe(49.99);

  // Now assert on UI reflecting this data
  await expect(page.locator('[data-testid="cart-item"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="cart-total"]')).toHaveText('$49.99');
});

// Good - use timeout for slow APIs
test('waits with custom timeout', async ({ page }) => {
  await page.goto('/reports');

  // Some APIs are legitimately slow (e.g., report generation)
  const response = await page.waitForResponse(
    (res) => res.url().includes('/api/generate-report'),
    { timeout: 30000 } // 30 seconds instead of default
  );

  expect(response.status()).toBe(200);
  await expect(page.locator('[data-testid="report"]')).toBeVisible();
});

// Good - combine with request waiting for request/response pair
test('tracks request and response', async ({ page }) => {
  await page.goto('/profile');

  const [request, response] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/api/users/123')),
    page.waitForResponse((res) => res.url().includes('/api/users/123')),
    page.click('[data-testid="refresh-button"]')
  ]);

  // Validate request
  expect(request.method()).toBe('GET');
  expect(request.headers()['authorization']).toBeTruthy();

  // Validate response
  expect(response.status()).toBe(200);
  const data = await response.json();
  expect(data.id).toBe(123);
});
```

## Anti-Pattern

Making assertions without waiting for API responses causes flaky tests.

```typescript
// Bad - assertion runs before data loads
test('does not wait for API', async ({ page }) => {
  await page.goto('/profile');

  // ✗ User data hasn't loaded yet - race condition!
  await expect(page.locator('[data-testid="user-name"]')).toHaveText('John Doe');
  // This passes sometimes (when fast) and fails sometimes (when slow)
});

// Bad - arbitrary wait instead of waiting for response
test('uses arbitrary timeout', async ({ page }) => {
  await page.goto('/dashboard');

  // ✗ Sleep is brittle - what if API takes 3.5 seconds?
  await page.waitForTimeout(3000);

  await expect(page.locator('[data-testid="data"]')).toBeVisible();
  // If API is slow, this still fails. If fast, we waste 3 seconds.
});

// Bad - waiting for element without waiting for data
test('waits for wrong thing', async ({ page }) => {
  await page.goto('/search');
  await page.fill('[data-testid="search-input"]', 'playwright');
  await page.click('[data-testid="search-button"]');

  // ✗ Loading spinner disappears but data might not be rendered yet
  await page.waitForSelector('[data-testid="loading"]', { state: 'hidden' });

  await expect(page.locator('[data-testid="result"]')).toHaveCount(5);
  // Race condition: spinner hides, but results aren't in DOM yet
});

// Bad - not waiting when action triggers API call
test('clicks without waiting', async ({ page }) => {
  await page.goto('/posts');

  // ✗ Click triggers API call but we don't wait
  await page.click('[data-testid="load-more"]');

  // Assertion might run before new posts load
  await expect(page.locator('[data-testid="post"]')).toHaveCount(10);
});

// Bad - waiting for load state instead of specific API
test('waits for wrong load state', async ({ page }) => {
  await page.goto('/dashboard');

  // ✗ networkidle doesn't guarantee specific API calls completed
  await page.waitForLoadState('networkidle');

  // Dashboard might make lazy-loaded API calls after "idle"
  await expect(page.locator('[data-testid="stats"]')).toBeVisible();
});
```

## Exceptions

You don't need `waitForResponse()` when:

1. **Testing static content** that doesn't require API calls
2. **Using properly mocked APIs** with immediate `route.fulfill()` responses
3. **Playwright's auto-waiting is sufficient** (e.g., `waitForSelector` with visibility)

```typescript
// Exception: Static content, no API calls
test('static about page', async ({ page }) => {
  await page.goto('/about');
  // No API calls expected, safe to assert immediately
  await expect(page.locator('h1')).toHaveText('About Us');
});

// Exception: Mocked API with immediate response
test('with mocked API', async ({ page }) => {
  await page.route('**/api/users/123', async (route) => {
    await route.fulfill({
      json: { id: 123, name: 'John Doe' }
    });
  });

  await page.goto('/profile/123');
  // Mock responds instantly, no race condition
  await expect(page.locator('[data-testid="user-name"]')).toHaveText('John Doe');
});

// Exception: Element visibility implies data loaded
test('element visibility is sufficient', async ({ page }) => {
  await page.goto('/dashboard');

  // If this element appears, the data is guaranteed to be loaded
  // because the app only renders it after processing API response
  await expect(page.locator('[data-testid="data-loaded-indicator"]')).toBeVisible();
  await expect(page.locator('[data-testid="stats"]')).toBeVisible();
});
```

## Auto-fix

Not automatically fixable. Requires understanding of application behavior to identify which API calls correspond to which UI updates.

**Detection approach:**

```typescript
// Could detect patterns like:
// 1. Navigation followed immediately by assertion (likely needs wait)
// 2. Click action followed immediately by assertion (likely needs wait)
// 3. Usage of waitForTimeout (suggest replacing with waitForResponse)

// ESLint rule could suggest:
await page.goto('/dashboard');
await expect(page.locator('[data-testid="stats"]')).toBeVisible();
// ↓ Suggest adding waitForResponse
```

## Related Rules

- [network-mock-api.md](./network-mock-api.md) - Mocking APIs for predictable timing
- [network-route-handlers.md](./network-route-handlers.md) - Intercepting requests
- [network-abort-unnecessary.md](./network-abort-unnecessary.md) - Reducing requests to wait for

## References

- [Playwright Docs: Network](https://playwright.dev/docs/network)
- [Playwright API: page.waitForResponse()](https://playwright.dev/docs/api/class-page#page-wait-for-response)
- [Playwright API: page.waitForRequest()](https://playwright.dev/docs/api/class-page#page-wait-for-request)
- [BrowserStack: 15 Best Practices for Playwright testing in 2026](https://www.browserstack.com/guide/playwright-best-practices)
- [Checkly: How to Intercept Requests in Playwright](https://www.checklyhq.com/docs/learn/playwright/intercept-requests/)
