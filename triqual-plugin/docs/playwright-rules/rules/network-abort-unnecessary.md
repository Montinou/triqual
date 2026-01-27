# Rule: network-abort-unnecessary

> **Category**: Network
> **Severity**: INFO
> **Auto-fixable**: YES

## Summary

Abort unnecessary network requests (images, fonts, analytics, ads) to speed up tests and reduce bandwidth consumption.

## Rationale

Tests often don't need all resources that a real browser would load. Blocking unnecessary requests provides:
- **Faster tests**: Less time waiting for resources to download
- **Lower bandwidth**: Reduced data transfer, important for CI/CD environments
- **More stability**: Fewer external dependencies that can fail
- **Better focus**: Tests concentrate on application logic, not third-party resources

Common candidates for blocking: analytics scripts, advertising networks, social media widgets, non-critical fonts/images, and tracking pixels. This optimization is recommended in [Playwright best practices](https://www.browserstack.com/guide/playwright-best-practices) and [network interception guides](https://www.checklyhq.com/docs/learn/playwright/intercept-requests/).

## Best Practice

Use `route.abort()` to block requests that don't affect test outcomes.

```typescript
import { test, expect } from '@playwright/test';

// Good - block images for faster tests
test('blocks unnecessary images', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'image') {
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });

  await page.goto('/gallery');
  // Page loads faster, tests still validate layout
  await expect(page.locator('[data-testid="gallery-item"]')).toHaveCount(12);
});

// Good - block analytics and tracking
test('blocks third-party analytics', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = route.request().url();

    const blockedDomains = [
      'google-analytics.com',
      'googletagmanager.com',
      'facebook.net',
      'hotjar.com',
      'doubleclick.net'
    ];

    if (blockedDomains.some(domain => url.includes(domain))) {
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  // Faster load, no analytics calls interfering with test
});

// Good - block fonts for non-visual tests
test('blocks fonts when testing logic', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (resourceType === 'font') {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  await page.goto('/dashboard');
  // Test logic still works with fallback fonts
  await expect(page.locator('[data-testid="submit"]')).toBeEnabled();
});

// Good - block media for non-media tests
test('blocks media files', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    const mediaTypes = ['image', 'media', 'font'];

    if (mediaTypes.includes(resourceType)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  await page.goto('/articles');
  await expect(page.locator('article')).toHaveCount(10);
});

// Good - context-level blocking for all pages
test('blocks resources globally', async ({ context, page }) => {
  // Apply to all pages and popups in this test
  await context.route('**/*', async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();

    if (['image', 'font', 'media'].includes(resourceType)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  const popup = await page.waitForEvent('popup');
  // Both pages have resources blocked
});

// Good - selective blocking with whitelist
test('blocks images except critical ones', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (request.resourceType() === 'image') {
      // Allow logo and product images
      if (url.includes('/logo.') || url.includes('/products/')) {
        await route.continue();
      } else {
        await route.abort(); // Block decorative images
      }
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  await expect(page.locator('[data-testid="logo"]')).toBeVisible();
});

// Good - abort with specific error codes
test('aborts with appropriate reason', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();

    if (resourceType === 'image') {
      await route.abort('blockedbyclient'); // Appropriate error
    } else if (route.request().url().includes('ads.')) {
      await route.abort('accessdenied'); // Simulate ad blocker
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
});
```

## Anti-Pattern

Not blocking unnecessary resources wastes time and creates external dependencies.

```typescript
// Bad - loads all resources unnecessarily
test('loads everything', async ({ page }) => {
  // ✗ No resource blocking - test loads:
  // - Dozens of images
  // - Multiple fonts
  // - Analytics scripts
  // - Social media widgets
  // - Ad networks
  // All slow down the test without adding value

  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  // Test takes 5 seconds when it could take 1 second
});

// Bad - waiting for unnecessary resources
test('waits for images to load', async ({ page }) => {
  await page.goto('/gallery');

  // ✗ Waiting for images that don't affect test outcome
  await page.waitForLoadState('networkidle');

  await expect(page.locator('[data-testid="count"]')).toHaveText('24 items');
  // The count doesn't depend on images loading!
});

// Bad - testing with production analytics
test('allows analytics tracking', async ({ page }) => {
  // ✗ Google Analytics fires during test
  await page.goto('/');

  // Creates noise in analytics data
  // Test user behavior pollutes production metrics
  await page.click('[data-testid="button"]');
});

// Bad - blocking critical resources
test('blocks too aggressively', async ({ page }) => {
  await page.route('**/*', async (route) => {
    // ✗ Blocks ALL requests including API calls!
    await route.abort();
  });

  await page.goto('/dashboard');
  // Nothing works because we blocked everything including JS, CSS, API
});

// Bad - blocking inconsistently
test('inconsistent blocking', async ({ page }) => {
  await page.route('**/*.png', async (route) => {
    await route.abort();
  });
  // ✗ Only blocks PNG images, not JPG, WebP, SVG, etc.
  // Inconsistent behavior between test runs

  await page.goto('/gallery');
});
```

## Exceptions

Don't block resources when:

1. **Testing visual appearance** - Visual regression tests need fonts/images
2. **Testing resource loading** - Performance tests measuring load times
3. **Testing media functionality** - Video players, image galleries, etc.
4. **Testing error handling** - Intentionally testing missing resource scenarios

```typescript
// Exception: Visual regression test needs all resources
test('visual snapshot needs resources', async ({ page }) => {
  // Don't block anything - visual accuracy matters
  await page.goto('/homepage');

  await expect(page).toHaveScreenshot('homepage.png');
  // Fonts, images, icons all affect visual appearance
});

// Exception: Testing image upload functionality
test('image upload requires images', async ({ page }) => {
  // Don't block images - we're testing image functionality
  await page.goto('/upload');

  await page.setInputFiles('input[type="file"]', './test-image.jpg');
  await expect(page.locator('[data-testid="preview"]')).toBeVisible();
});

// Exception: Testing error handling for missing resources
test('handles missing image gracefully', async ({ page }) => {
  await page.route('**/missing-image.jpg', async (route) => {
    // Intentionally abort to test error handling
    await route.abort('failed');
  });

  await page.goto('/profile');
  await expect(page.locator('[data-testid="avatar-fallback"]')).toBeVisible();
});
```

## Auto-fix

Automatically fixable by adding standard resource blocking patterns.

```typescript
// Before (no blocking)
test('my test', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('h1')).toBeVisible();
});

// After (auto-fixed with standard blocking)
test('my test', async ({ page }) => {
  // Auto-added resource blocking
  await page.route('**/*', async (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'media'].includes(resourceType)) {
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });

  await page.goto('/dashboard');
  await expect(page.locator('h1')).toBeVisible();
});
```

**Recommended auto-fix configuration:**

```typescript
// Add to playwright.config.ts for global resource blocking
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    // Block common unnecessary resources globally
    extraHTTPHeaders: {
      'Accept': 'text/html,application/json,application/xml'
    }
  }
});

// Or create a fixture for reusable blocking
import { test as base } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Apply blocking before each test
    await page.route('**/*', async (route) => {
      const resourceType = route.request().resourceType();
      const blockedTypes = ['image', 'font', 'media'];
      const blockedDomains = [
        'google-analytics.com',
        'googletagmanager.com',
        'facebook.net'
      ];

      if (
        blockedTypes.includes(resourceType) ||
        blockedDomains.some(d => route.request().url().includes(d))
      ) {
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });

    await use(page);
  }
});
```

## Related Rules

- [network-mock-api.md](./network-mock-api.md) - Mock APIs instead of blocking
- [network-route-handlers.md](./network-route-handlers.md) - Proper route handler usage
- [network-wait-response.md](./network-wait-response.md) - Wait for critical responses

## References

- [Playwright Docs: Network](https://playwright.dev/docs/network)
- [Playwright API: route.abort()](https://playwright.dev/docs/api/class-route#route-abort)
- [BrowserStack: 15 Best Practices for Playwright testing in 2026](https://www.browserstack.com/guide/playwright-best-practices)
- [Checkly: How to Intercept Requests in Playwright](https://www.checklyhq.com/docs/learn/playwright/intercept-requests/)
- [Medium: Network Interception and Mocking in Playwright](https://medium.com/the-testing-hub/network-interception-and-mocking-in-playwright-3f490e91a2cb)
