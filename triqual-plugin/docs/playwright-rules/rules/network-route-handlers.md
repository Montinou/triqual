# Rule: network-route-handlers

> **Category**: Network
> **Severity**: ERROR
> **Auto-fixable**: NO

## Summary

Use route handlers correctly by always calling `route.continue()`, `route.fulfill()`, or `route.abort()` to prevent hanging requests.

## Rationale

When you register a route handler with `page.route()`, Playwright intercepts matching requests and **pauses them**. You must explicitly tell Playwright what to do next:
- `route.continue()` - Let the request proceed normally
- `route.fulfill()` - Respond with mock data
- `route.abort()` - Block the request

Failing to call one of these methods causes the request to **hang indefinitely**, leading to test timeouts and failures. This is a critical requirement emphasized in [Playwright's Network documentation](https://playwright.dev/docs/network) and [route handler best practices](https://www.checklyhq.com/docs/learn/playwright/intercept-requests/).

## Best Practice

Always handle routes explicitly and use precise URL matching.

```typescript
import { test, expect } from '@playwright/test';

// Good - always calls route.continue()
test('logs all API requests', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    console.log('API Request:', route.request().url());
    await route.continue(); // ✓ Request proceeds
  });

  await page.goto('/dashboard');
});

// Good - fulfills with mock data
test('mocks user data', async ({ page }) => {
  await page.route('**/api/users/123', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 123, name: 'John' })
    });
    // ✓ Request completed with mock response
  });

  await page.goto('/profile/123');
});

// Good - conditional routing with all branches handled
test('selectively mocks requests', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();

    if (url.includes('/users')) {
      await route.fulfill({ json: { users: [] } });
    } else if (url.includes('/analytics')) {
      await route.abort('blockedbyclient'); // Block analytics
    } else {
      await route.continue(); // Allow other requests
    }
    // ✓ All branches handled
  });

  await page.goto('/dashboard');
});

// Good - use precise URL patterns
test('mocks specific GraphQL operation', async ({ page }) => {
  await page.route('**/graphql', async (route) => {
    const postData = route.request().postDataJSON();

    if (postData.operationName === 'GetUser') {
      await route.fulfill({
        json: {
          data: { user: { id: '1', name: 'Alice' } }
        }
      });
    } else {
      await route.continue(); // Other operations proceed
    }
  });

  await page.goto('/users/1');
});

// Good - register routes at context level for global mocking
test('context-level route for multiple pages', async ({ context, page }) => {
  // Applies to all pages in this context (including popups)
  await context.route('**/api/config', async (route) => {
    await route.fulfill({
      json: { featureFlags: { newUI: true } }
    });
  });

  await page.goto('/');
  const popup = await page.waitForEvent('popup');
  await popup.waitForLoadState();
  // Config is mocked in both pages
});

// Good - modify and continue
test('patches response', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const json = await response.json();

    // Modify response data
    json.featureFlags.debugMode = true;

    await route.fulfill({
      response,
      json
    });
  });

  await page.goto('/');
});
```

## Anti-Pattern

Missing `continue()`, `fulfill()`, or `abort()` causes hanging requests and test failures.

```typescript
// Bad - route handler does nothing, request hangs forever
test('broken route handler', async ({ page }) => {
  await page.route('**/api/users', async (route) => {
    console.log('Request intercepted');
    // ✗ Missing route.continue(), route.fulfill(), or route.abort()
    // Request hangs, test times out
  });

  await page.goto('/users'); // This will timeout
});

// Bad - conditional handling with missing else branch
test('incomplete conditional', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('/users')) {
      await route.fulfill({ json: { users: [] } });
    }
    // ✗ No else branch - requests to /api/posts will hang
  });

  await page.goto('/dashboard'); // Times out if it requests /api/posts
});

// Bad - overly broad pattern without fallback
test('catches too many requests', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('api')) {
      await route.fulfill({ json: {} });
    }
    // ✗ What about images, fonts, CSS, JS? All hang!
  });

  await page.goto('/'); // All non-API resources hang
});

// Bad - forgetting to await
test('not awaiting route methods', async ({ page }) => {
  await page.route('**/api/users', (route) => {
    route.continue(); // ✗ Missing await - race condition
  });

  await page.goto('/users');
});

// Bad - using sync function when you need async operations
test('sync handler when async needed', async ({ page }) => {
  await page.route('**/api/users', (route) => {
    // ✗ Can't use await in non-async function
    const data = fetchMockData(); // If this is async, it won't work
    route.fulfill({ json: data });
  });

  await page.goto('/users');
});
```

## Exceptions

There are no valid exceptions. Every route handler **must** call `continue()`, `fulfill()`, or `abort()`.

However, you can unregister routes when they're no longer needed:

```typescript
test('unregister route after use', async ({ page }) => {
  // Register route
  await page.route('**/api/init', async (route) => {
    await route.fulfill({ json: { initialized: true } });
  });

  await page.goto('/');

  // Unregister route - future requests go through normally
  await page.unroute('**/api/init');

  await page.goto('/dashboard'); // /api/init no longer mocked
});
```

## Auto-fix

Not automatically fixable. Requires human judgment to determine intended behavior:
- Should the request **continue** (pass through)?
- Should the request be **fulfilled** (mocked)?
- Should the request be **aborted** (blocked)?

**Detection approach:**

```typescript
// ESLint rule could detect missing route resolution
page.route('**/api/**', async (route) => {
  // Analyze code path: if no route.continue/fulfill/abort found, report error
  console.log('Intercepted');
}); // ← Error: Route handler must call route.continue(), route.fulfill(), or route.abort()
```

## Related Rules

- [network-mock-api.md](./network-mock-api.md) - When to mock vs. use real APIs
- [network-wait-response.md](./network-wait-response.md) - Waiting for responses
- [network-abort-unnecessary.md](./network-abort-unnecessary.md) - Blocking requests

## References

- [Playwright Docs: Network](https://playwright.dev/docs/network)
- [Playwright Docs: Route class](https://playwright.dev/docs/api/class-route)
- [Checkly: How to Intercept Requests in Playwright](https://www.checklyhq.com/docs/learn/playwright/intercept-requests/)
- [BrowserStack: Intercepting HTTP Requests with Playwright](https://www.browserstack.com/guide/playwright-intercept-request)
- [Tim Deschryver: Intercepting HTTP Requests with Playwright](https://timdeschryver.dev/blog/intercepting-http-requests-with-playwright)
