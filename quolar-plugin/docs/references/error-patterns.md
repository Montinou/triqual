# Error Patterns - Common Failures and Fixes

This document catalogs common test failures and their solutions.

## Quick Reference

| Error | Quick Fix |
|-------|-----------|
| Timeout waiting for selector | Add wait, check element exists |
| Strict mode violation | Add `.first()` or filter |
| Element not visible | Add `:visible` filter, check z-index |
| Element is disabled | Wait for enabled state |
| Navigation timeout | Increase timeout, check URL |
| Authentication failed | Regenerate auth state |
| Test data not found | Check fixtures, create data |

---

## Locator Errors

### Error: Timeout waiting for selector

**Message:**
```
Error: Timeout 30000ms exceeded.
  waiting for locator('button.submit')
```

**Causes:**
1. Element doesn't exist on page
2. Element has different selector
3. Element appears later than expected
4. Element is in iframe

**Diagnosis:**
```
1. Take browser snapshot
2. Search for element in snapshot
3. If not found: element missing or different
4. If found: selector is wrong
```

**Fixes:**

```typescript
// Fix 1: Add explicit wait
await page.waitForSelector('.submit-button', { state: 'visible' });
await page.click('.submit-button');

// Fix 2: Update selector to match actual element
// Before: button.submit
// After: button[type="submit"]

// Fix 3: Increase timeout for slow-loading element
await page.click('.submit-button', { timeout: getTimeout('long') });

// Fix 4: Handle iframe
const frame = page.frameLocator('#my-iframe');
await frame.locator('.submit-button').click();
```

---

### Error: Strict mode violation

**Message:**
```
Error: locator('button') resolved to 3 elements
  strict mode violation
```

**Causes:**
1. Multiple elements match the selector
2. Selector is too generic
3. Page has duplicate elements

**Diagnosis:**
```
1. Take snapshot
2. Count matching elements
3. Identify correct element
4. Find unique identifier
```

**Fixes:**

```typescript
// Fix 1: Add .first() if first match is correct
await page.locator('button').first().click();

// Fix 2: Add visibility filter
await page.locator('button:visible').click();

// Fix 3: Filter by text
await page.locator('button').filter({ hasText: 'Submit' }).click();

// Fix 4: Scope to container
const modal = page.locator('.modal');
await modal.locator('button.submit').click();

// Fix 5: Use more specific selector
await page.getByRole('button', { name: 'Submit' }).click();

// Fix 6: Combine filters
await page.locator('button:visible')
  .filter({ hasText: 'Submit' })
  .first()
  .click();
```

**Best Practice:**
```typescript
// In Page Objects, always plan for specificity
readonly submitButton: Locator;

constructor(page: Page) {
  // Prefer role + name for uniqueness
  this.submitButton = page.getByRole('button', { name: 'Submit' });

  // Or scope to known container
  this.submitButton = page.locator('.form-actions button[type="submit"]');
}
```

---

### Error: Element is not visible

**Message:**
```
Error: element is not visible
  waiting for locator('button.submit') to be visible
```

**Causes:**
1. Element hidden by CSS (display: none, visibility: hidden)
2. Element covered by another element
3. Element outside viewport
4. Element hasn't rendered yet

**Diagnosis:**
```
1. Take snapshot and screenshot
2. Check if element in snapshot
3. Check visual screenshot for overlays
4. Scroll element into view
```

**Fixes:**

```typescript
// Fix 1: Wait for visibility
await page.locator('button.submit').waitFor({ state: 'visible' });

// Fix 2: Scroll into view first
await page.locator('button.submit').scrollIntoViewIfNeeded();
await page.locator('button.submit').click();

// Fix 3: Close modal/overlay blocking element
await page.locator('.overlay-close').click();
await page.locator('button.submit').click();

// Fix 4: Wait for animation to complete
await page.waitForTimeout(getTimeout('animation'));
await page.locator('button.submit').click();

// Fix 5: Force click (use cautiously)
await page.locator('button.submit').click({ force: true });
```

---

### Error: Element is disabled

**Message:**
```
Error: element is disabled
  waiting for locator('button.submit')
```

**Causes:**
1. Form validation not passed
2. Required fields empty
3. Loading/processing state
4. Permission issue

**Diagnosis:**
```
1. Take snapshot
2. Check element's disabled state
3. Check form validation
4. Check if action required first
```

**Fixes:**

```typescript
// Fix 1: Wait for enabled state
await expect(page.locator('button.submit')).toBeEnabled();
await page.locator('button.submit').click();

// Fix 2: Ensure prerequisites met
await page.fill('#name', 'Test Value');  // Fill required field
await page.locator('button.submit').click();

// Fix 3: Wait for loading to complete
await page.waitForSelector('.loading', { state: 'hidden' });
await page.locator('button.submit').click();
```

---

## Timing Errors

### Error: Timeout exceeded

**Message:**
```
Error: Test timeout of 30000ms exceeded
```

**Causes:**
1. Test takes too long
2. Waiting for wrong condition
3. Network slow
4. Application slow
5. Infinite loop

**Diagnosis:**
```
1. Run with --headed to observe
2. Note where test gets stuck
3. Check network tab for slow requests
4. Check for endless spinners
```

**Fixes:**

```typescript
// Fix 1: Increase test timeout
test('slow test', async ({ page }) => {
  test.setTimeout(60000);  // 60 seconds
  // ...
});

// Fix 2: Increase action timeout
await page.click('button', { timeout: getTimeout('long') });

// Fix 3: Wait for network idle
await page.waitForLoadState('networkidle');

// Fix 4: Wait for specific condition instead of fixed time
// Bad:
await page.waitForTimeout(5000);
// Good:
await page.waitForSelector('.loaded');
```

---

### Error: Navigation timeout

**Message:**
```
Error: Navigation timeout of 30000ms exceeded
```

**Causes:**
1. Page takes too long to load
2. URL is incorrect
3. Redirect loop
4. Server error
5. Network issue

**Diagnosis:**
```
1. Try URL manually in browser
2. Check network requests
3. Check for redirects
4. Check server logs
```

**Fixes:**

```typescript
// Fix 1: Increase navigation timeout
await page.goto('/slow-page', { timeout: 60000 });

// Fix 2: Wait for specific condition instead of full load
await page.goto('/page', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.main-content');

// Fix 3: Handle redirects
await page.goto('/page');
await page.waitForURL('**/expected-url');

// Fix 4: Check URL before navigating
const currentUrl = page.url();
if (!currentUrl.includes('/expected')) {
  await page.goto('/expected');
}
```

---

## Authentication Errors

### Error: Redirected to login

**Message:**
```
expect(page).toHaveURL('/dashboard')
Received: '/login'
```

**Causes:**
1. Auth state expired
2. Auth state file missing
3. Session invalidated
4. Wrong auth state used

**Diagnosis:**
```
1. Check .auth/ directory
2. Check if auth file exists and is recent
3. Try manual login
4. Check session expiry
```

**Fixes:**

```bash
# Fix 1: Regenerate auth state
rm -rf .auth/
npx playwright test --project=setup
```

```typescript
// Fix 2: Check auth before test
test.beforeEach(async ({ page }) => {
  const authFile = '.auth/user.json';
  if (!fs.existsSync(authFile)) {
    // Handle missing auth
  }
});

// Fix 3: Add auth check to test
test('authenticated test', async ({ page }) => {
  await page.goto('/dashboard');

  // If redirected to login, auth failed
  if (page.url().includes('/login')) {
    throw new Error('Auth state expired - regenerate');
  }
});

// Fix 4: Use correct storage state
test.use({ storageState: '.auth/correct-role.json' });
```

---

## Assertion Errors

### Error: expect.toHaveText failed

**Message:**
```
expect(locator).toHaveText('Expected text')
Expected: "Expected text"
Received: "Actual text"
```

**Causes:**
1. Text actually different
2. Extra whitespace
3. Dynamic content
4. Text in wrong element

**Fixes:**

```typescript
// Fix 1: Update expected text
await expect(locator).toHaveText('Actual text');

// Fix 2: Use regex for dynamic content
await expect(locator).toHaveText(/Welcome, \w+/);

// Fix 3: Use containText for partial match
await expect(locator).toContainText('Welcome');

// Fix 4: Trim whitespace
const text = await locator.textContent();
expect(text?.trim()).toBe('Expected');

// Fix 5: Check correct element
await expect(page.locator('.correct-element')).toHaveText('Expected');
```

---

### Error: expect.toBeVisible failed

**Message:**
```
expect(locator).toBeVisible()
Expected: visible
Received: hidden
```

**Causes:**
1. Element not rendered yet
2. Element hidden by CSS
3. Wrong element
4. Conditional rendering

**Fixes:**

```typescript
// Fix 1: Add wait before assertion
await page.waitForSelector('.element');
await expect(page.locator('.element')).toBeVisible();

// Fix 2: Wait for condition that triggers visibility
await page.click('.show-button');
await expect(page.locator('.element')).toBeVisible();

// Fix 3: Increase assertion timeout
await expect(page.locator('.element')).toBeVisible({ timeout: 10000 });

// Fix 4: Check if element should be visible
// Maybe the test expectation is wrong
```

---

## Data Errors

### Error: Test data not found

**Message:**
```
Error: No user found with email 'test@example.com'
```

**Causes:**
1. Test data not seeded
2. Data cleaned up by another test
3. Wrong environment
4. Data fixture outdated

**Fixes:**

```typescript
// Fix 1: Create data in beforeEach
test.beforeEach(async ({ request }) => {
  await request.post('/api/test-data', {
    data: { /* test data */ }
  });
});

// Fix 2: Use factories
import { UserFactory } from '../factories/user.factory';

test('test with user', async ({ page }) => {
  const user = await UserFactory.create();
  // Use user in test
});

// Fix 3: Check environment
const env = process.env.TEST_ENV || 'staging';
const fixtures = require(`../fixtures/${env}.json`);

// Fix 4: Ensure test isolation
test.afterEach(async ({ request }) => {
  await request.delete('/api/test-data/cleanup');
});
```

---

## Network Errors

### Error: net::ERR_CONNECTION_REFUSED

**Message:**
```
Error: net::ERR_CONNECTION_REFUSED at http://localhost:3000
```

**Causes:**
1. Dev server not running
2. Wrong port
3. Server crashed

**Fixes:**

```bash
# Fix 1: Start dev server
npm run dev

# Fix 2: Check correct port
# Update playwright.config.ts baseURL

# Fix 3: Use webServer config
# In playwright.config.ts:
webServer: {
  command: 'npm run start',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
}
```

---

## Error Pattern Checklist

When encountering an error:

```
□ Read the full error message
□ Identify error category (locator, timing, auth, data)
□ Take snapshot to see current state
□ Compare expected vs actual
□ Check this document for known fix
□ Apply fix
□ Verify fix works (Level 2 verification)
□ Document if new pattern discovered
```
