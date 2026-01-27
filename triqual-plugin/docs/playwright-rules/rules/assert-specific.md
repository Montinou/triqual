# Rule: Use Specific Assertion Methods

> **Category**: Assertions
> **Severity**: WARNING
> **Auto-fixable**: YES

## Summary

Use the most specific assertion method available for each check instead of generic methods like `toHaveText()` or `toHaveAttribute()` when more specific alternatives exist.

## Rationale

Specific assertion methods provide:
- **Better error messages**: More precise failure descriptions help with debugging
- **Clearer intent**: Code communicates what you're testing more explicitly
- **Optimized checks**: Some methods perform more efficient validations
- **Better type safety**: Specific methods often have better TypeScript inference

Using the most specific assertion makes your test code self-documenting and reduces cognitive load when reading tests.

## Best Practice

Use the most specific assertion method for each scenario:

```typescript
// ✅ CORRECT: Specific visibility assertion
await expect(page.getByRole('button')).toBeVisible();

// ✅ CORRECT: Specific hidden check
await expect(page.getByRole('dialog')).toBeHidden();

// ✅ CORRECT: Specific enabled check
await expect(page.getByRole('button')).toBeEnabled();

// ✅ CORRECT: Specific disabled check
await expect(page.getByRole('textbox')).toBeDisabled();

// ✅ CORRECT: Specific checked state
await expect(page.getByRole('checkbox')).toBeChecked();

// ✅ CORRECT: Specific editable check
await expect(page.getByRole('textbox')).toBeEditable();

// ✅ CORRECT: Specific empty check
await expect(page.getByRole('textbox')).toBeEmpty();

// ✅ CORRECT: Specific focus check
await expect(page.getByRole('textbox')).toBeFocused();

// ✅ CORRECT: Specific count for multiple elements
await expect(page.getByRole('listitem')).toHaveCount(5);

// ✅ CORRECT: Specific value check for inputs
await expect(page.getByLabel('Email')).toHaveValue('user@example.com');

// ✅ CORRECT: Specific CSS class check
await expect(page.getByTestId('alert')).toHaveClass(/error/);
await expect(page.getByTestId('alert')).toHaveClass(['alert', 'alert-error']);

// ✅ CORRECT: Specific URL check
await expect(page).toHaveURL(/.*checkout/);
await expect(page).toHaveURL('https://example.com/checkout');

// ✅ CORRECT: Specific title check
await expect(page).toHaveTitle(/Dashboard/);
```

## Anti-Pattern

Avoid generic assertions when specific methods exist:

```typescript
// ❌ WRONG: Generic attribute check for visibility
await expect(page.getByRole('button')).toHaveAttribute('aria-hidden', 'false');
// Use: toBeVisible()

// ❌ WRONG: Generic attribute check for disabled state
await expect(page.getByRole('button')).toHaveAttribute('disabled', '');
// Use: toBeDisabled()

// ❌ WRONG: Generic attribute check for checked state
await expect(page.getByRole('checkbox')).toHaveAttribute('checked', '');
// Use: toBeChecked()

// ❌ WRONG: Generic attribute check for value
await expect(page.getByLabel('Email')).toHaveAttribute('value', 'user@example.com');
// Use: toHaveValue('user@example.com')

// ❌ WRONG: Generic text check for URL
await expect(page.locator('html')).toHaveAttribute('data-url', '/checkout');
// Use: expect(page).toHaveURL(/checkout/)

// ❌ WRONG: Generic text check for count
await expect(page.getByRole('listitem').first()).toBeVisible();
// Use: toHaveCount(n) when checking for specific number

// ❌ WRONG: Checking class as text
await expect(page.getByTestId('alert')).toHaveAttribute('class', 'alert alert-error');
// Use: toHaveClass() or toHaveClass(/error/)
```

## Exceptions

Generic methods are acceptable when:

1. **No specific method exists** for the assertion:
   ```typescript
   // OK: No specific method for custom data attributes
   await expect(page.getByTestId('item')).toHaveAttribute('data-product-id', '123');
   ```

2. **Testing custom attributes** not covered by specific methods:
   ```typescript
   // OK: Custom ARIA attributes
   await expect(page.getByRole('button')).toHaveAttribute('aria-label', 'Close');
   ```

3. **Partial text matching** with complex patterns:
   ```typescript
   // OK: Complex regex pattern
   await expect(page.getByText(/order #\d{6}/)).toBeVisible();
   ```

## Auto-fix

This rule is auto-fixable for common patterns. Transformations:

| Anti-Pattern | Auto-fix |
|-------------|----------|
| `.toHaveAttribute('aria-hidden', 'false')` | `.toBeVisible()` |
| `.toHaveAttribute('aria-hidden', 'true')` | `.toBeHidden()` |
| `.toHaveAttribute('disabled', ...)` | `.toBeDisabled()` |
| `.not.toHaveAttribute('disabled')` | `.toBeEnabled()` |
| `.toHaveAttribute('checked', ...)` | `.toBeChecked()` |
| `.toHaveAttribute('value', x)` | `.toHaveValue(x)` |
| `.toHaveAttribute('class', x)` | `.toHaveClass(x)` |

## Related Rules

- [assert-web-first.md](./assert-web-first.md) - Use web-first assertions
- [assert-timeout.md](./assert-timeout.md) - Configure assertion timeouts
- [assert-soft.md](./assert-soft.md) - Use soft assertions appropriately

## References

- [Playwright Assertions API](https://playwright.dev/docs/test-assertions)
- [PlaywrightAssertions Class](https://playwright.dev/docs/api/class-playwrightassertions)
- [Understanding Playwright Assertions (BrowserStack)](https://www.browserstack.com/guide/playwright-assertions)
- [Playwright Assertions Best Practices (Checkly)](https://www.checklyhq.com/docs/learn/playwright/assertions/)
