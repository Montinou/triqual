# Rule: Leverage Playwright's Auto-Waiting

> **Category**: Waits & Timing
> **Severity**: WARNING
> **Auto-fixable**: YES

## Summary
Trust Playwright's built-in auto-waiting for actionability checks - avoid redundant manual waits that slow down tests and add unnecessary complexity.

## Rationale

### The Auto-Waiting Advantage

Playwright is fundamentally different from older automation tools: **it doesn't just wait for elements to exist, it waits for them to be actionable.**

**Every Playwright action automatically waits for:**
1. ✅ Element is **attached** to the DOM
2. ✅ Element is **visible** (not `display: none` or `visibility: hidden`)
3. ✅ Element is **stable** (not animating)
4. ✅ Element **receives events** (not covered by other elements)
5. ✅ Element is **enabled** (not `disabled`)

This makes Playwright tests **more reliable and less flaky** compared to traditional testing frameworks that require manual synchronization.

### Why Manual Waits Are Redundant

Adding manual waits before Playwright actions is **redundant and counterproductive**:

- **Slower tests**: Manual waits add unnecessary delays even when the element is already ready
- **False sense of stability**: Manual waits don't actually check if elements are actionable
- **Maintenance burden**: More code to maintain without actual benefit
- **Misleading**: Suggests that Playwright doesn't have built-in waiting (it does!)

## Best Practice

**Trust the framework** - let Playwright's auto-waiting handle element readiness:

```typescript
// ✅ GOOD: Auto-waiting handles everything
await page.goto('/login');
await page.fill('#email', 'test@example.com'); // Waits for input to be actionable
await page.fill('#password', 'password123'); // Waits for input to be actionable
await page.click('[data-testid="submit"]'); // Waits for button to be clickable

// ✅ GOOD: Chaining actions - auto-waiting between each
await page.locator('[data-testid="dropdown"]').click();
await page.locator('[data-testid="option-3"]').click(); // Waits for option to be visible & clickable

// ✅ GOOD: Assertions have built-in retry (up to 5s by default)
await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
await expect(page.locator('.user-name')).toHaveText('John Doe');

// ✅ GOOD: Configure timeout when needed (default is usually fine)
await expect(page.locator('[data-testid="slow-chart"]')).toBeVisible({ timeout: 10000 });
```

### Pattern: Rely on Locators with Auto-Waiting

```typescript
// ✅ GOOD: Locators auto-wait for actionability
const submitButton = page.locator('[data-testid="submit"]');
await submitButton.click(); // Automatically waits for button to be enabled and visible

// ✅ GOOD: Chained locators with auto-waiting
await page
  .locator('[data-testid="product-card"]')
  .filter({ hasText: 'iPhone' })
  .locator('button:has-text("Add to Cart")')
  .click(); // Each step waits automatically
```

### Pattern: Auto-Waiting for Dynamic Content

```typescript
// ✅ GOOD: No manual wait needed for dynamically loaded content
await page.click('[data-testid="load-more"]');
// Playwright auto-waits for new items to appear
await expect(page.locator('.product-item')).toHaveCount(20);

// ✅ GOOD: Auto-waiting handles API response delays
await page.click('[data-testid="refresh"]');
await expect(page.locator('[data-testid="last-updated"]')).toContainText('seconds ago');
```

### Pattern: Handling Animations

```typescript
// ✅ GOOD: Auto-waiting waits for animations to complete
await page.click('[data-testid="dropdown-toggle"]');
// Playwright waits for dropdown animation to finish
await page.click('[data-testid="dropdown-item"]');

// ✅ GOOD: Stability check ensures element isn't moving
await page.locator('[data-testid="draggable"]').dragTo(page.locator('[data-testid="drop-zone"]'));
// Auto-waiting ensures element is stable before dragging
```

## Anti-Pattern

**Redundant manual waits** that duplicate Playwright's built-in behavior:

```typescript
// ❌ BAD: Redundant waitForSelector before action
await page.waitForSelector('[data-testid="submit"]');
await page.click('[data-testid="submit"]'); // click() already waits!

// ❌ BAD: Redundant visibility check before action
await expect(page.locator('#email')).toBeVisible();
await page.fill('#email', 'test@example.com'); // fill() already checks visibility!

// ❌ BAD: Checking enabled state before clicking
const button = page.locator('[data-testid="submit"]');
await expect(button).toBeEnabled();
await button.click(); // click() already waits for enabled state!

// ❌ BAD: Waiting for timeout before action
await page.waitForTimeout(500);
await page.click('[data-testid="button"]'); // Unnecessary delay!

// ❌ BAD: Multiple redundant checks
await page.waitForSelector('.modal');
await expect(page.locator('.modal')).toBeVisible();
await page.locator('.modal').waitFor({ state: 'visible' });
await page.click('.modal button'); // All previous waits are redundant!
```

### Why These Are Problematic

```typescript
// ❌ This adds unnecessary 2+ seconds to test runtime:
await page.goto('/dashboard');
await page.waitForSelector('[data-testid="menu"]'); // +waiting time
await expect(page.locator('[data-testid="menu"]')).toBeVisible(); // +retry time
await page.click('[data-testid="menu"]'); // Already does all the checks above!

// ✅ This is equivalent and faster:
await page.goto('/dashboard');
await page.click('[data-testid="menu"]'); // One line, auto-waits correctly
```

## Exceptions

**When manual waits ARE appropriate** (these complement auto-waiting):

### 1. Waiting for Elements to Disappear

```typescript
// ✅ GOOD: Auto-waiting doesn't help here - element needs to be gone
await expect(page.locator('.loading-spinner')).toBeHidden();
```

### 2. Waiting for Multiple Elements

```typescript
// ✅ GOOD: Checking count requires explicit assertion
await expect(page.locator('.product-card')).toHaveCount(10);
```

### 3. Waiting for Text Content Changes

```typescript
// ✅ GOOD: Waiting for specific text to appear
await expect(page.locator('[data-testid="status"]')).toHaveText('Complete');
```

### 4. Waiting for Network Responses

```typescript
// ✅ GOOD: Auto-waiting doesn't cover network state
await page.waitForResponse(resp => resp.url().includes('/api/user'));
```

### 5. Complex Retry Logic

```typescript
// ✅ GOOD: Custom retry logic for complex conditions
await expect(async () => {
  const response = await page.request.get('/api/status');
  expect(response.status()).toBe(200);
  const data = await response.json();
  expect(data.ready).toBe(true);
}).toPass();
```

## Auto-fix

This rule can be auto-fixed by removing redundant waits:

### Transformation 1: Remove waitForSelector Before Actions
```typescript
// BEFORE (redundant)
await page.waitForSelector('[data-testid="button"]');
await page.click('[data-testid="button"]');

// AFTER (auto-fix)
await page.click('[data-testid="button"]');
```

### Transformation 2: Remove Visibility Checks Before Actions
```typescript
// BEFORE (redundant)
await expect(page.locator('#email')).toBeVisible();
await page.fill('#email', 'test@example.com');

// AFTER (auto-fix)
await page.fill('#email', 'test@example.com');
```

### Transformation 3: Remove Multiple Redundant Waits
```typescript
// BEFORE (redundant)
await page.waitForSelector('.modal');
await page.locator('.modal').waitFor({ state: 'visible' });
await expect(page.locator('.modal')).toBeVisible();
await page.click('.modal button');

// AFTER (auto-fix)
await page.click('.modal button');
```

### Transformation 4: Remove Enabled Checks Before Clicks
```typescript
// BEFORE (redundant)
const button = page.locator('[data-testid="submit"]');
await expect(button).toBeEnabled();
await button.click();

// AFTER (auto-fix)
await page.locator('[data-testid="submit"]').click();
```

## What Auto-Waiting Does NOT Cover

Be aware of scenarios where you DO need explicit waits:

| Scenario | Auto-Waiting? | Solution |
|----------|---------------|----------|
| Element appears | ✅ Yes | No manual wait needed |
| Element disappears | ❌ No | Use `toBeHidden()` or `toHaveCount(0)` |
| Text content changes | ❌ No | Use `toHaveText()` or `toContainText()` |
| Attribute changes | ❌ No | Use `toHaveAttribute()` |
| Network requests | ❌ No | Use `waitForResponse()` |
| Custom JS conditions | ❌ No | Use `waitForFunction()` |
| Multiple elements | ❌ No | Use `toHaveCount()` |

## Related Rules

- [wait-no-timeout.md](./wait-no-timeout.md) - Never use hardcoded timeouts
- [wait-explicit-conditions.md](./wait-explicit-conditions.md) - Use explicit wait conditions
- [wait-for-state.md](./wait-for-state.md) - Prefer specific states over networkidle

## References

- [Playwright Auto-waiting Documentation](https://playwright.dev/docs/actionability)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Understanding Playwright Wait Types (BrowserStack)](https://www.browserstack.com/guide/playwright-wait-types)
- [Troubleshooting Auto-Waiting (Checkly)](https://www.checklyhq.com/docs/guides/auto-waiting-methods/)
- [Why Playwright's Auto-Waits Are Awesome (Hicron)](https://hicronsoftware.com/blog/playwright-auto-waits/)
- [The Unsung Hero: Auto-Waiting Mechanism (Momentic)](https://momentic.ai/resources/the-unsung-hero-how-playwrights-auto-waiting-mechanism-eliminates-flaky-tests)

---

**Key Takeaway**: Playwright makes intelligent waiting the default, built-in behavior for all actions. Trust the framework's actionability checks instead of adding redundant manual waits that slow down tests without improving reliability.
