# Rule: network-mock-api

> **Category**: Network
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Mock external API calls instead of hitting real endpoints to improve test speed, reliability, and isolation.

## Rationale

Tests that rely on real API calls are:
- **Slow**: Network latency adds seconds to each test
- **Flaky**: Network issues, rate limits, and API downtime cause false failures
- **Dependent**: Changes in backend behavior break unrelated frontend tests
- **Expensive**: Tests consume API quotas and resources
- **Non-deterministic**: Real data changes unpredictably

By mocking API responses, tests become fast, deterministic, and focused on UI logic rather than backend stability. This aligns with best practices from [Playwright's Mock APIs documentation](https://playwright.dev/docs/mock) and [BrowserStack's guide on API mocking](https://www.browserstack.com/guide/how-to-mock-api-with-playwright).

## Best Practice

Use `page.route()` to intercept API requests and fulfill them with mock data.

```typescript
import { test, expect } from '@playwright/test';

test('displays user profile with mocked API', async ({ page }) => {
  // Mock REST API response
  await page.route('**/api/users/123', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 123,
        name: 'John Doe',
        email: 'john@example.com'
      })
    });
  });

  await page.goto('/profile/123');
  await expect(page.locator('[data-testid="user-name"]')).toHaveText('John Doe');
});

test('displays posts with mocked GraphQL', async ({ page }) => {
  // Mock GraphQL API response
  await page.route('**/graphql', async (route) => {
    const request = route.request();
    const postData = request.postDataJSON();

    if (postData.operationName === 'GetPosts') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            posts: [
              { id: '1', title: 'First Post', author: 'Alice' },
              { id: '2', title: 'Second Post', author: 'Bob' }
            ]
          }
        })
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/posts');
  await expect(page.locator('[data-testid="post"]')).toHaveCount(2);
});

test('handles API error states', async ({ page }) => {
  // Mock error response
  await page.route('**/api/users/404', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'User not found',
        code: 'NOT_FOUND'
      })
    });
  });

  await page.goto('/profile/404');
  await expect(page.locator('[data-testid="error-message"]')).toHaveText('User not found');
});
```

## Anti-Pattern

Making real API calls in tests creates dependencies and flakiness.

```typescript
// Bad - hits real API endpoint
test('displays user profile', async ({ page }) => {
  // No mocking - this makes a REAL network request
  await page.goto('/profile/123');

  // Test depends on:
  // - Network being available
  // - API server being up
  // - User 123 existing in the database
  // - API rate limits not being hit
  await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
});

// Bad - inconsistent test data
test('shows correct user count', async ({ page }) => {
  await page.goto('/users');

  // This number changes as real users are added/removed
  // Test will randomly fail when database state changes
  await expect(page.locator('[data-testid="user-count"]')).toHaveText('47 users');
});

// Bad - testing against production API
test('creates new user', async ({ page }) => {
  await page.goto('/signup');
  await page.fill('[name="email"]', 'test@example.com');
  await page.click('button[type="submit"]');

  // This creates REAL data in production database
  // Pollutes production with test data
  await expect(page.locator('.success')).toBeVisible();
});
```

## Exceptions

Some scenarios justify using real APIs:

1. **E2E Integration Tests**: Full system tests that validate backend-frontend integration
2. **Smoke Tests**: Production monitoring tests that verify services are operational
3. **Contract Tests**: Tests that validate API contract compliance
4. **Staging Environment Tests**: Tests against dedicated test environments (not production)

```typescript
// Exception: E2E integration test with real API
test('e2e: complete user registration flow', async ({ page }) => {
  // This test intentionally uses real API to validate full integration
  // Runs against dedicated staging environment, not production
  test.slow(); // Mark as slow test

  await page.goto(process.env.STAGING_URL + '/signup');
  await page.fill('[name="email"]', `test-${Date.now()}@example.com`);
  await page.click('button[type="submit"]');

  // Validates real backend, database, email service, etc.
  await expect(page.locator('.confirmation')).toBeVisible();
});
```

## Auto-fix

Not automatically fixable. Requires manual implementation of mock responses based on API contract.

**Migration approach:**

1. Identify API calls using network inspection: `await page.route('**/*', route => console.log(route.request().url()))`
2. Capture real responses for reference
3. Create mock fixtures based on API schema
4. Implement `page.route()` handlers with mock data
5. Verify UI behavior matches with mocked responses

## Related Rules

- [network-route-handlers.md](./network-route-handlers.md) - Effective route handler patterns
- [network-wait-response.md](./network-wait-response.md) - Waiting for API responses
- [network-abort-unnecessary.md](./network-abort-unnecessary.md) - Blocking unnecessary requests

## References

- [Playwright Docs: Mock APIs](https://playwright.dev/docs/mock)
- [Playwright Docs: Network](https://playwright.dev/docs/network)
- [BrowserStack: How to Mock APIs with Playwright](https://www.browserstack.com/guide/how-to-mock-api-with-playwright)
- [Stubbing GraphQL using Playwright](https://www.jayfreestone.com/writing/stubbing-graphql-playwright/)
- [How to intercept GraphQL requests with Playwright](https://medium.com/@iPiranhaa/how-to-intercept-graphql-requests-with-playwright-7ddaec3d9f9f)
- [BrowserStack: 15 Best Practices for Playwright testing in 2026](https://www.browserstack.com/guide/playwright-best-practices)
