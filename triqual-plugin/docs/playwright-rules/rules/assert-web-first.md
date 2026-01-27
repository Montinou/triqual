# Rule: Use Web-First Assertions

> **Category**: Assertions
> **Severity**: ERROR
> **Auto-fixable**: YES

## Summary

Always use Playwright's web-first assertions (e.g., `await expect(locator).toHaveText()`) instead of manual assertions (e.g., `expect(await locator.textContent()).toBe()`) to leverage auto-retry behavior and eliminate race conditions.

## Rationale

Web-first assertions are specifically designed for the dynamic web and automatically wait and retry until the expected condition is met or a timeout is reached (default: 5 seconds). This eliminates race conditions and makes tests significantly more reliable and stable.

Manual assertions using `await locator.method()` inside `expect()` perform a single check at one point in time. If the element hasn't loaded or updated yet, the test fails immediately without retrying. This is the primary cause of flaky tests in Playwright.

**Key difference:**
- **Web-first**: Playwright continuously re-fetches the element and checks the condition until it passes or times out
- **Manual**: Single check at one moment - no retry, no waiting

## Best Practice

Use web-first assertions that auto-retry:

```typescript
// ✅ CORRECT: Auto-retrying web-first assertion
await expect(page.getByTestId('status')).toHaveText('Submitted');

// ✅ CORRECT: Visibility check with auto-retry
await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();

// ✅ CORRECT: Count with auto-retry
await expect(page.getByRole('listitem')).toHaveCount(3);

// ✅ CORRECT: Attribute check with auto-retry
await expect(page.getByTestId('status')).toHaveAttribute('aria-label', 'Success');

// ✅ CORRECT: CSS class with auto-retry
await expect(page.getByTestId('alert')).toHaveClass(/error/);

// ✅ CORRECT: Value check with auto-retry
await expect(page.getByLabel('Email')).toHaveValue('test@example.com');
```

## Anti-Pattern

Avoid manual assertions that don't auto-retry:

```typescript
// ❌ WRONG: Manual assertion - no auto-retry, prone to race conditions
expect(await page.getByTestId('status').textContent()).toBe('Submitted');

// ❌ WRONG: Boolean check - no auto-retry
expect(await page.getByRole('button').isVisible()).toBe(true);

// ❌ WRONG: Manual count - no auto-retry
expect(await page.getByRole('listitem').count()).toBe(3);

// ❌ WRONG: Manual attribute check - no auto-retry
const attr = await page.getByTestId('status').getAttribute('aria-label');
expect(attr).toBe('Success');

// ❌ WRONG: Manual text extraction - no auto-retry
const text = await page.getByTestId('message').innerText();
expect(text).toContain('Success');

// ❌ WRONG: Manual value extraction - no auto-retry
const value = await page.getByLabel('Email').inputValue();
expect(value).toBe('test@example.com');
```

## Exceptions

Non-web-first assertions are acceptable when:

1. **Testing static data** that doesn't change:
   ```typescript
   // OK: Testing a constant value
   expect(BASE_URL).toBe('https://example.com');
   ```

2. **Complex assertions** that require polling:
   ```typescript
   // OK: Use expect.poll for complex custom checks
   await expect.poll(async () => {
     const response = await fetch('/api/status');
     return response.status;
   }).toBe(200);
   ```

3. **Custom retry logic** with `expect.toPass()`:
   ```typescript
   // OK: Custom retry block
   await expect(async () => {
     const count = await page.getByRole('listitem').count();
     const isEven = count % 2 === 0;
     expect(isEven).toBe(true);
   }).toPass();
   ```

## Auto-fix

This rule is auto-fixable. Common transformations:

| Anti-Pattern | Auto-fix |
|-------------|----------|
| `expect(await locator.textContent()).toBe(text)` | `await expect(locator).toHaveText(text)` |
| `expect(await locator.isVisible()).toBe(true)` | `await expect(locator).toBeVisible()` |
| `expect(await locator.isHidden()).toBe(true)` | `await expect(locator).toBeHidden()` |
| `expect(await locator.count()).toBe(n)` | `await expect(locator).toHaveCount(n)` |
| `expect(await locator.getAttribute(name)).toBe(value)` | `await expect(locator).toHaveAttribute(name, value)` |
| `expect(await locator.inputValue()).toBe(value)` | `await expect(locator).toHaveValue(value)` |
| `expect(await locator.innerText()).toContain(text)` | `await expect(locator).toContainText(text)` |

## Related Rules

- [assert-specific.md](./assert-specific.md) - Use specific assertion methods
- [assert-timeout.md](./assert-timeout.md) - Configure assertion timeouts
- [assert-soft.md](./assert-soft.md) - Use soft assertions appropriately

## References

- [Playwright Assertions](https://playwright.dev/docs/test-assertions)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright: Avoid Race Conditions with Auto-Retry Assertions](https://dev.to/playwright/playwright-assertions-avoid-race-conditions-with-this-simple-fix-dm1)
- [Understanding Playwright Assertions (BrowserStack)](https://www.browserstack.com/guide/playwright-assertions)
- [Playwright Assertions - Types & Best Practices (Checkly)](https://www.checklyhq.com/docs/learn/playwright/assertions/)
