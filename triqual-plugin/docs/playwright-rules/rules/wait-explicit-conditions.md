# Rule: Use Explicit Wait Conditions

> **Category**: Waits & Timing
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary
Use explicit wait conditions that describe what you're waiting for - avoid ambiguous waits that make tests harder to debug and more prone to race conditions.

## Rationale

### Why Explicit Conditions Matter

**Explicit wait conditions** make your tests:

1. **Self-documenting**: The code clearly states what condition must be met before proceeding
2. **Debuggable**: When a test fails, you know exactly which condition wasn't met
3. **Race-condition-free**: Proper synchronization eliminates timing-related flakiness
4. **Maintainable**: Future developers understand the intent of the wait

### The Problem with Implicit/Ambiguous Waits

Ambiguous waits create **debugging nightmares** and **hidden race conditions**:

```typescript
// ❌ What are we actually waiting for?
await page.waitForTimeout(2000); // Why 2000? What should happen?
await page.waitForLoadState(); // Which state? Why?
await page.locator('.content').waitFor(); // What state matters?
```

When these fail, you have no idea what went wrong.

## Best Practice

Use **web-first assertions** and **explicit conditions** that clearly state what you're waiting for:

### Pattern 1: Wait for Element Visibility

```typescript
// ✅ GOOD: Explicit condition - waiting for success message to appear
await expect(page.locator('[data-testid="success-message"]')).toBeVisible();

// ✅ GOOD: Explicit condition - waiting for loading spinner to disappear
await expect(page.locator('.loading-spinner')).toBeHidden();

// ✅ GOOD: Explicit condition - waiting for specific text
await expect(page.locator('[data-testid="status"]')).toHaveText('Complete');
```

### Pattern 2: Wait for Specific Network Responses

```typescript
// ✅ GOOD: Explicit condition - waiting for user API call
const responsePromise = page.waitForResponse(resp =>
  resp.url().includes('/api/user') && resp.status() === 200
);
await page.click('[data-testid="load-profile"]');
const response = await responsePromise;

// ✅ GOOD: Multiple explicit conditions with Promise.all
const [userResp, settingsResp] = await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/user')),
  page.waitForResponse(resp => resp.url().includes('/api/settings')),
  page.goto('/dashboard')
]);
```

### Pattern 3: Wait for Element State Changes

```typescript
// ✅ GOOD: Explicit condition - button becomes enabled
await expect(page.locator('[data-testid="submit"]')).toBeEnabled();

// ✅ GOOD: Explicit condition - element has expected attribute
await expect(page.locator('[data-testid="chart"]')).toHaveAttribute('data-loaded', 'true');

// ✅ GOOD: Explicit condition - count matches expectation
await expect(page.locator('.product-card')).toHaveCount(10);
```

### Pattern 4: Wait for JavaScript Conditions

```typescript
// ✅ GOOD: Explicit condition - custom JavaScript state
await page.waitForFunction(() => {
  return window.dataLoaded === true && window.apiReady === true;
});

// ✅ GOOD: Explicit condition - DOM state
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="chart"]');
  return el && el.dataset.loaded === 'true';
});
```

### Pattern 5: Complex Retry Logic

```typescript
// ✅ GOOD: Explicit retry condition with toPass()
await expect(async () => {
  const response = await page.request.get('/api/status');
  expect(response.status()).toBe(200);
  const data = await response.json();
  expect(data.processing).toBe(false);
}).toPass({
  timeout: 10000,
  intervals: [500, 1000, 1000]
});
```

### Pattern 6: Avoiding Race Conditions with Promise.all

```typescript
// ✅ GOOD: Set up response listener BEFORE triggering action
const [response] = await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/submit')),
  page.click('[data-testid="submit"]')
]);

// This prevents the race condition where the response might arrive
// before waitForResponse is called
```

## Anti-Pattern

**Ambiguous waits** that don't explain what condition is being satisfied:

```typescript
// ❌ BAD: What are we waiting for? Why this duration?
await page.waitForTimeout(2000);

// ❌ BAD: Which load state? Why does it matter?
await page.waitForLoadState();

// ❌ BAD: What state? Visible? Attached? Detached?
await page.locator('.content').waitFor();

// ❌ BAD: Waiting for wrong scope - might already be past
await page.waitForURL('/dashboard');
await page.click('[data-testid="button"]');
// ^ If already at /dashboard, click happens immediately without waiting

// ❌ BAD: Race condition - response might come before waitForResponse
await page.click('[data-testid="submit"]');
await page.waitForResponse(resp => resp.url().includes('/api/submit'));
// ^ If response is fast, this might miss it!
```

### Race Condition Example

```typescript
// ❌ BAD: Race condition - async operation not synchronized
test('update profile', async ({ page }) => {
  await page.click('[data-testid="submit"]');
  // Race: What if API responds before we call waitForResponse?
  await page.waitForResponse(resp => resp.url().includes('/api/profile'));
  await expect(page.locator('.success')).toBeVisible();
});

// ✅ GOOD: No race condition - listener set up before action
test('update profile', async ({ page }) => {
  const [response] = await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/api/profile')),
    page.click('[data-testid="submit"]')
  ]);
  await expect(page.locator('.success')).toBeVisible();
});
```

### Debugging Nightmare Example

```typescript
// ❌ BAD: When this fails, you have no idea why
test('complex flow', async ({ page }) => {
  await page.click('[data-testid="button1"]');
  await page.waitForTimeout(1000); // What happens here?
  await page.click('[data-testid="button2"]');
  await page.waitForTimeout(500); // And here?
  await page.click('[data-testid="button3"]');
  // Test fails - but which wait was insufficient?
});

// ✅ GOOD: When this fails, you know exactly which condition wasn't met
test('complex flow', async ({ page }) => {
  await page.click('[data-testid="button1"]');
  await expect(page.locator('[data-testid="modal"]')).toBeVisible();

  await page.click('[data-testid="button2"]');
  await expect(page.locator('[data-testid="form"]')).toBeEnabled();

  await page.click('[data-testid="button3"]');
  await expect(page.locator('[data-testid="success"]')).toContainText('Saved');
  // Test fails - error message clearly shows which assertion failed
});
```

## Exceptions

Some scenarios legitimately require less explicit waits, but **document why**:

### 1. Generic Page Load (Still Add Comments)

```typescript
// ⚠️ ACCEPTABLE: Wait for standard page load event
// Most page resources should be loaded by this point
await page.goto('/dashboard', { waitUntil: 'load' });
await expect(page.locator('[data-testid="main-content"]')).toBeVisible();
```

### 2. Legacy System Without Indicators

```typescript
// ⚠️ TEMPORARY: Legacy system lacks proper loading states
// TODO: Add data-testid="loading" indicator - see ENG-1234
await page.waitForLoadState('domcontentloaded');
```

### 3. Generic Stability Wait (Rare)

```typescript
// ⚠️ EXCEPTION: Complex animation system without stable markers
// TODO: Add data-animated="false" attribute when animation completes
await page.locator('[data-testid="carousel"]').waitFor({ state: 'visible' });
```

**Always include a comment explaining WHY the wait is necessary.**

## Common Race Conditions to Avoid

### Race Condition 1: Network Listener After Action

```typescript
// ❌ RACE CONDITION: Response might arrive before listener is set up
async function submitForm(page) {
  await page.click('[data-testid="submit"]'); // Triggers request
  await page.waitForResponse(r => r.url().includes('/api/submit')); // Might miss it!
}

// ✅ FIXED: Set up listener before action
async function submitForm(page) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/submit')),
    page.click('[data-testid="submit"]')
  ]);
  return response;
}
```

### Race Condition 2: JavaScript-Triggered Navigation

```typescript
// ❌ RACE CONDITION: JavaScript redirect might happen too fast
await page.click('[data-testid="logout"]'); // Triggers JS redirect
await page.waitForURL('/login'); // Might miss the navigation!

// ✅ FIXED: Set up navigation listener first
await Promise.all([
  page.waitForURL('/login'),
  page.click('[data-testid="logout"]')
]);
```

### Race Condition 3: locator.all() Without Waiting

```typescript
// ❌ RACE CONDITION: locator.all() doesn't wait - snapshots immediately
await page.click('[data-testid="load-more"]');
const items = await page.locator('.item').all(); // Might get old list!

// ✅ FIXED: Wait for expected count first
await page.click('[data-testid="load-more"]');
await expect(page.locator('.item')).toHaveCount(20);
const items = await page.locator('.item').all();
```

## Explicit Condition Checklist

When writing waits, ask yourself:

- ✅ **Can I describe the condition in plain English?**
  - Good: "Wait for the success message to be visible"
  - Bad: "Wait 2 seconds"

- ✅ **Will the error message be clear when this fails?**
  - Good: `Expected element to be visible` (with locator details)
  - Bad: `Timeout of 2000ms exceeded`

- ✅ **Am I waiting for what the test actually needs?**
  - Good: Wait for submit button to be enabled
  - Bad: Wait for page load (when you only need one element)

- ✅ **Could this cause a race condition?**
  - Good: Set up listeners before triggering actions
  - Bad: Click first, then wait for response

## Related Rules

- [wait-no-timeout.md](./wait-no-timeout.md) - Never use hardcoded timeouts
- [wait-auto-waiting.md](./wait-auto-waiting.md) - Leverage Playwright's auto-waiting
- [wait-for-state.md](./wait-for-state.md) - Prefer specific states over networkidle

## References

- [Playwright Auto-waiting Documentation](https://playwright.dev/docs/actionability)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright Assertions: Avoid Race Conditions (DEV)](https://dev.to/playwright/playwright-assertions-avoid-race-conditions-with-this-simple-fix-dm1)
- [Avoiding Flaky Tests (Better Stack)](https://betterstack.com/community/guides/testing/avoid-flaky-playwright-tests/)
- [Prevent Race Conditions (HTMX Discussion)](https://github.com/bigskysoftware/htmx/discussions/2360)
- [Problematic Playwright Pitfalls (Momentic)](https://momentic.ai/blog/playwright-pitfalls)
- [Playwright Tips (Summerbud)](https://www.summerbud.org/dev-notes/playwright-tips-that-will-make-your-life-easier)
- [How to Avoid Flaky Tests (Semaphore)](https://semaphore.io/blog/flaky-tests-playwright)

---

**Key Takeaway**: Explicit wait conditions make tests self-documenting and debuggable. When a test fails, you should immediately know which condition wasn't met. Avoid ambiguous waits that leave you guessing what went wrong and create opportunities for race conditions.
