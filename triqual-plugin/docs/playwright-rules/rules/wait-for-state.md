# Rule: Prefer waitFor Over networkidle

> **Category**: Waits & Timing
> **Severity**: WARNING
> **Auto-fixable**: YES

## Summary
Use specific wait conditions (`waitFor`, web assertions) instead of `waitForLoadState('networkidle')` - networkidle is slow, unreliable, and discouraged by Playwright.

## Rationale

### Why networkidle is Problematic

The official Playwright documentation explicitly marks `'networkidle'` as **"DISCOURAGED"** and states:

> "Don't use this method for testing, rely on web assertions to assess readiness instead."

**Key issues with networkidle:**

1. **Hangs on modern SPAs**: Single-page applications frequently make background API calls for analytics, polling, or live updates. Waiting for networkidle in such cases can cause tests to hang or timeout because the network never becomes fully idle.

2. **Arbitrary 500ms threshold**: `networkidle` waits until there are no network connections for at least 500ms - this is an arbitrary delay that doesn't correlate with actual page readiness.

3. **Unnecessary delays**: Most tests don't need to wait for ALL network activity to cease - they only care about specific elements or data being available.

4. **False sense of completeness**: Just because the network is idle doesn't mean the page is ready - JavaScript might still be processing data, animations might be running, or elements might not be actionable yet.

## Best Practice

Use **element-specific waits** and **web-first assertions** that target exactly what you need:

```typescript
// ✅ GOOD: Wait for specific elements to be ready
await expect(page.locator('[data-testid="user-profile"]')).toBeVisible();
await expect(page.locator('.loading-spinner')).toBeHidden();

// ✅ GOOD: Wait for specific API responses
await page.waitForResponse(resp =>
  resp.url().includes('/api/user') && resp.status() === 200
);

// ✅ GOOD: Wait for DOM content to load (faster than networkidle)
await page.waitForLoadState('domcontentloaded');

// ✅ GOOD: Wait for page load event (standard browser load)
await page.waitForLoadState('load');

// ✅ GOOD: Combine load state with element-level waits
await page.goto('/dashboard');
await page.waitForLoadState('domcontentloaded');
await expect(page.locator('[data-testid="dashboard-content"]')).toBeVisible();

// ✅ GOOD: Wait for specific condition using waitForFunction
await page.waitForFunction(() => {
  return document.querySelector('[data-testid="chart"]')?.dataset.loaded === 'true';
});
```

### Pattern: Wait for Critical Resources

Instead of waiting for ALL network activity, wait for the specific resources your test needs:

```typescript
// ✅ GOOD: Wait for critical API calls only
const [userResponse, settingsResponse] = await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/user')),
  page.waitForResponse(resp => resp.url().includes('/api/settings')),
  page.goto('/dashboard')
]);

// Then verify the UI reflects the data
await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
```

### Pattern: Dynamic Content Loading

```typescript
// ✅ GOOD: Wait for dynamic content markers
await page.goto('/products');
await expect(page.locator('[data-testid="product-list"]')).toHaveAttribute('data-loaded', 'true');
await expect(page.locator('.product-card')).toHaveCount(10);
```

## Anti-Pattern

Using `networkidle` creates **slow, unreliable tests**:

```typescript
// ❌ BAD: networkidle waits for ALL network activity (slow!)
await page.goto('/dashboard', { waitUntil: 'networkidle' });
// This might wait forever if there are background polling requests

// ❌ BAD: Unnecessary networkidle after navigation
await page.goto('/products');
await page.waitForLoadState('networkidle');
await page.click('[data-testid="first-product"]');

// ❌ BAD: Using networkidle for simple element visibility
await page.goto('/login');
await page.waitForLoadState('networkidle'); // Overkill!
await page.fill('#email', 'test@example.com');

// ❌ BAD: networkidle when you only care about one API call
await page.click('[data-testid="load-more"]');
await page.waitForLoadState('networkidle'); // Waits for everything!
// Better: await page.waitForResponse(resp => resp.url().includes('/api/products'))
```

### Real-World Failure Scenario

```typescript
// ❌ This test HANGS because of analytics polling
test('should display dashboard', async ({ page }) => {
  // App makes analytics requests every 10 seconds
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  // ^ Never reaches networkidle state - test times out!
});

// ✅ This test SUCCEEDS by waiting for what matters
test('should display dashboard', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('[data-testid="dashboard-title"]')).toBeVisible();
  await expect(page.locator('[data-testid="user-stats"]')).toBeVisible();
  // Analytics polling doesn't affect the test!
});
```

## Exceptions

**Rare cases where `networkidle` might be acceptable** (document why):

1. **Static content sites with no background requests**:
```typescript
// ⚠️ EXCEPTION: Static marketing page with no polling/analytics
// Still prefer element-specific waits when possible
await page.goto('/about', { waitUntil: 'networkidle' });
```

2. **Legacy systems without proper loading indicators**:
```typescript
// ⚠️ EXCEPTION: Legacy app without loading states or test IDs
// TODO: Add proper loading indicators and remove networkidle
await page.waitForLoadState('networkidle');
```

**Even in these cases, document the exception and plan to remove it:**

```typescript
// ⚠️ TEMPORARY: Using networkidle until loading indicators are added
// See ticket: ENG-1234 - Add data-testid loading states
// TODO: Replace with await expect(page.locator('[data-testid="content"]')).toBeVisible()
await page.waitForLoadState('networkidle');
```

## Auto-fix

This rule can be auto-fixed by replacing `networkidle` with specific conditions:

### Transformation 1: Page Navigation
```typescript
// BEFORE (slow and unreliable)
await page.goto('/dashboard', { waitUntil: 'networkidle' });

// AFTER (auto-fix: wait for DOM content + specific element)
await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
await expect(page.locator('[data-testid="main-content"]')).toBeVisible();
```

### Transformation 2: After waitForLoadState
```typescript
// BEFORE (slow)
await page.goto('/products');
await page.waitForLoadState('networkidle');
await page.click('[data-testid="filter"]');

// AFTER (auto-fix: wait for actionable element)
await page.goto('/products');
await expect(page.locator('[data-testid="filter"]')).toBeEnabled();
await page.click('[data-testid="filter"]');
```

### Transformation 3: After Actions
```typescript
// BEFORE (slow)
await page.click('[data-testid="load-more"]');
await page.waitForLoadState('networkidle');
const count = await page.locator('.item').count();

// AFTER (auto-fix: wait for specific response)
await page.click('[data-testid="load-more"]');
await page.waitForResponse(resp => resp.url().includes('/api/items'));
const count = await page.locator('.item').count();
```

## Choosing the Right Load State

| Load State | When to Use | Speed | Reliability |
|------------|-------------|-------|-------------|
| `domcontentloaded` | DOM is parsed, scripts loaded | Fast ⚡⚡⚡ | High ✅ |
| `load` | All resources loaded (images, stylesheets) | Medium ⚡⚡ | High ✅ |
| `networkidle` | No network activity for 500ms | Slow ⚡ | Low ⚠️ |

**Default recommendation**: Use `domcontentloaded` + element-specific waits.

## Related Rules

- [wait-no-timeout.md](./wait-no-timeout.md) - Never use hardcoded timeouts
- [wait-auto-waiting.md](./wait-auto-waiting.md) - Leverage Playwright's auto-waiting
- [wait-explicit-conditions.md](./wait-explicit-conditions.md) - Use explicit wait conditions

## References

- [Playwright page.waitForLoadState API](https://playwright.dev/docs/api/class-page#page-wait-for-load-state)
- [Understanding Playwright waitForLoadState (BrowserStack)](https://www.browserstack.com/guide/playwright-waitforloadstate)
- [What are recommended methods instead of networkidle?](https://ray.run/questions/what-are-some-recommended-methods-in-playwright-to-wait-for-page-readiness-instead-of-using-page-waitfor-networkidle)
- [Playwright Wait for Page to Load Guide (Autify)](https://autify.com/blog/playwright-wait-for-page-to-load)
- [GitHub Issue #22897: networkidle clarification](https://github.com/microsoft/playwright/issues/22897)
- [Dealing with waits and timeouts (Checkly)](https://www.checklyhq.com/docs/learn/playwright/waits-and-timeouts/)

---

**Key Takeaway**: Modern single-page applications rarely reach a true "networkidle" state due to analytics, polling, and background requests. Wait for what your test actually needs (specific elements or API responses) instead of waiting for ALL network activity to stop.
