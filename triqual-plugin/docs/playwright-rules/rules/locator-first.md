# Rule: locator-first

> **Category**: Locators
> **Severity**: ERROR
> **Auto-fixable**: PARTIAL

## Summary

Use `.first()`, `.last()`, or `.nth()` explicitly when multiple elements match a locator, or refine the locator to target a single element uniquely.

## Rationale

Playwright enforces strictness mode by default—actions like `click()`, `fill()`, and `check()` throw errors when a locator matches multiple elements. This prevents ambiguous interactions where the test intent is unclear.

According to Playwright's official documentation, "Locators are strict. This means that all operations on locators that imply some target DOM element will throw an exception if more than one element matches."

Using `.first()` is generally discouraged for dynamic content because it creates fragile tests that depend on element order. Instead, refine the locator to uniquely identify the intended element using filters, text matching, or role attributes.

However, `.first()`, `.last()`, and `.nth()` are acceptable when:
- Working with inherently ordered lists (e.g., pagination, chronological data)
- The DOM order is guaranteed by design
- Combined with filtering to narrow scope first

## Best Practice

Refine locators to target unique elements instead of using positional selectors:

```typescript
// Best - unique locator using role and name
await page.getByRole('button', { name: 'Delete Account' }).click();

// Good - filter by text within container
const productCard = page.getByRole('article').filter({ hasText: 'iPhone 15' });
await productCard.getByRole('button', { name: 'Add to Cart' }).click();

// Good - chain locators to narrow scope
await page.getByTestId('user-profile')
  .getByRole('button', { name: 'Edit' })
  .click();

// Good - filter by child element
await page.getByRole('row')
  .filter({ has: page.getByText('john@example.com') })
  .getByRole('button', { name: 'Delete' })
  .click();

// Acceptable - .first() for inherently ordered lists
const firstPageButton = page.getByRole('button', { name: 'Page' }).first();
await firstPageButton.click();

// Acceptable - .nth() for specific position in guaranteed order
const thirdCarouselSlide = page.getByTestId('carousel-slide').nth(2);
await expect(thirdCarouselSlide).toBeVisible();

// Acceptable - .last() for chronologically ordered data
const latestNotification = page.getByRole('listitem').last();
await expect(latestNotification).toContainText('New message');
```

## Anti-Pattern

Using positional selectors without refinement or on dynamic content:

```typescript
// Bad - .first() on ambiguous elements
await page.getByRole('button').first().click();
// Which button? What's the intent?

// Bad - assuming DOM order for unordered elements
await page.locator('.product-card').first().click();
// Product order may change based on filters, API responses

// Bad - .nth() hardcoded to arbitrary position
await page.getByRole('link').nth(3).click();
// Why the 4th link? What if new links are added?

// Bad - no error handling for strictness violation
try {
  await page.getByText('Submit').click();
} catch (error) {
  // Swallowing strictness errors hides test design issues
}

// Bad - using .first() when unique identifier exists
await page.locator('[data-testid]').first().click();
// Should use specific test ID instead

// Bad - positional selector after vague filter
await page.locator('div').filter({ hasText: 'User' }).first().click();
// Too vague - what kind of element? What's the semantic meaning?
```

## Exceptions

Positional selectors are acceptable in these specific scenarios:

1. **Inherently Ordered Lists**: Pagination, chronological feeds, ranked results
```typescript
// Acceptable - pagination is inherently ordered
await page.getByRole('button', { name: /page/i }).first().click();
```

2. **Guaranteed DOM Order**: Elements with explicit order guarantees
```typescript
// Acceptable - carousel slides have fixed order
await page.getByTestId('carousel-slide').nth(2).click();
```

3. **Count Assertions**: When verifying multiple matches exist
```typescript
// Acceptable - count() works on multiple elements
await expect(page.getByRole('row')).toHaveCount(10);
```

4. **Iteration Patterns**: When processing all matching elements
```typescript
// Acceptable - iterating over collection
const items = page.getByRole('listitem');
const count = await items.count();
for (let i = 0; i < count; i++) {
  await expect(items.nth(i)).toBeVisible();
}
```

5. **Testing Table Rows/Cells**: Structured data with meaningful positions
```typescript
// Acceptable - first row in result table
const firstResultRow = page.getByRole('table').getByRole('row').first();
await expect(firstResultRow).toContainText('Expected Data');
```

## Auto-fix

Partial auto-fix available: Linters can detect strictness violations and suggest refinements, but cannot automatically determine the correct unique locator.

```typescript
// Before - will throw strictness error
await page.getByRole('button').click();

// Auto-fix suggestion 1: Use .first() (not recommended)
await page.getByRole('button').first().click();

// Auto-fix suggestion 2: Refine with name (recommended)
await page.getByRole('button', { name: 'Submit' }).click();

// Auto-fix suggestion 3: Add filter (context-dependent)
await page.getByRole('button')
  .filter({ hasText: 'Confirm' })
  .click();

// Before - positional selector on dynamic content
await page.locator('.card').first().click();

// After - refined to unique identifier
await page.getByRole('article')
  .filter({ has: page.getByText('Featured Product') })
  .getByRole('button', { name: 'View Details' })
  .click();
```

## Related Rules

- [selector-role-based.md](./selector-role-based.md) - Use semantic locators for uniqueness
- [locator-chaining.md](./locator-chaining.md) - Chain to narrow scope instead of positional selectors
- [selector-testid.md](./selector-testid.md) - Use test IDs for unique identification
- [locator-visibility.md](./locator-visibility.md) - Verify visibility alongside uniqueness

## References

- [Playwright Docs: Locators - Strictness](https://playwright.dev/docs/locators#strictness)
- [Playwright Docs: Locator.first()](https://playwright.dev/docs/api/class-locator#locator-first)
- [Playwright Docs: Locator.nth()](https://playwright.dev/docs/api/class-locator#locator-nth)
- [Playwright Docs: Filtering Locators](https://playwright.dev/docs/locators#filtering-locators)
- [BrowserStack: Playwright Locators Guide](https://www.browserstack.com/guide/playwright-locator)
