# Rule: selector-testid

> **Category**: Locators
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Prefer `getByTestId()` over CSS selectors for elements lacking clear semantic roles or text, establishing explicit testing contracts that survive UI refactoring.

## Rationale

Test IDs (`data-testid` attributes) provide stable, explicit testing contracts that remain unchanged when styling, DOM structure, or visual design evolves. Unlike CSS classes or element hierarchies, test IDs are intentionally added for testing purposes and signal to developers that removing or changing them may break tests.

According to Playwright's official guidance, test IDs should be used "when you'd like to define an explicit testing contract" and are particularly valuable when role or text-based locators are insufficient.

However, test IDs should not be the first choice—role-based and text-based locators better reflect the user experience and enforce accessibility standards. Reserve test IDs for:
- Custom components without semantic HTML
- Icon-only buttons or controls
- Complex widgets with no accessible names
- Dynamic content where text changes frequently

The key advantage: test IDs anchor selectors to **intentionally stable attributes**, preventing tests from breaking due to unrelated CSS, layout, or design system changes.

## Best Practice

Use `getByTestId()` strategically for elements that lack better semantic alternatives:

```typescript
// Good - icon-only button with no accessible name
await page.getByTestId('settings-icon-button').click();

// Good - custom component with complex internals
await page.getByTestId('date-range-picker').click();
await page.getByTestId('date-range-start').fill('2024-01-01');

// Good - dynamic content container
const dashboardWidget = page.getByTestId('revenue-widget');
await expect(dashboardWidget).toContainText('$');

// Good - combining test ID with semantic locators
const userProfileCard = page.getByTestId('user-profile-card');
await userProfileCard.getByRole('button', { name: 'Edit' }).click();

// Good - configurable test ID attribute
// playwright.config.ts: use: { testIdAttribute: 'data-qa' }
await page.getByTestId('submit-form').click();

// Good - test ID for container, semantic locators for children
const searchResults = page.getByTestId('search-results-container');
await expect(searchResults.getByRole('link')).toHaveCount(10);
await searchResults.getByRole('link', { name: 'Documentation' }).click();
```

## Anti-Pattern

Overusing test IDs when semantic locators would suffice, or using CSS selectors instead:

```typescript
// Bad - semantic role available
await page.getByTestId('submit-button').click();
// Should use: page.getByRole('button', { name: 'Submit' })

// Bad - text content is stable and unique
await page.getByTestId('page-title').textContent();
// Should use: page.getByRole('heading', { name: 'Dashboard' })

// Bad - CSS selector instead of test ID
await page.locator('[data-testid="user-menu"]').click();
// Should use: page.getByTestId('user-menu')

// Bad - CSS class selector (fragile)
await page.locator('.btn-primary.submit-action').click();
// Should use test ID or role-based locator

// Bad - overly specific CSS selector
await page.locator('#content > div.container > form > button.submit').click();
// Should use: page.getByRole('button', { name: 'Submit' })

// Bad - test ID for standard form controls
await page.getByTestId('email-input').fill('user@example.com');
// Should use: page.getByLabel('Email')

// Bad - test ID when getByText would work
await expect(page.getByTestId('error-message')).toBeVisible();
// Should use: page.getByText('Invalid credentials')

// Bad - XPath when test ID exists
await page.locator('//div[@data-testid="modal"]').click();
// Should use: page.getByTestId('modal')
```

## Exceptions

CSS selectors may be preferred over test IDs in these scenarios:

1. **Third-party Components**: When adding test IDs is not feasible
```typescript
// Acceptable - third-party library without customization
await page.locator('.react-datepicker__input').click();
```

2. **Rapid Prototyping**: Early development before test IDs are established
```typescript
// Acceptable temporarily during prototyping
await page.locator('.prototype-button').click();
// TODO: Add data-testid="action-button" to component
```

3. **Structural Elements**: When testing layout itself
```typescript
// Acceptable - verifying CSS grid structure
const gridItems = page.locator('.grid-container > .grid-item');
await expect(gridItems).toHaveCount(12);
```

4. **Pseudo-elements or CSS States**: Features not accessible via test IDs
```typescript
// Acceptable - testing hover states
await page.locator('.tooltip').hover();
await expect(page.locator('.tooltip:after')).toBeVisible();
```

## Auto-fix

Not auto-fixable—adding test IDs requires source code changes and strategic decisions about testing contracts.

```typescript
// Before - brittle CSS selector
await page.locator('.modal-container .action-button.primary').click();

// Step 1: Add test ID to component (requires code change)
// <button className="action-button primary" data-testid="confirm-action">

// Step 2: Update test to use test ID
await page.getByTestId('confirm-action').click();

// Before - overusing test IDs
await page.getByTestId('submit-button').click();

// After - use semantic locator instead
await page.getByRole('button', { name: 'Submit' }).click();

// Best - strategic combination
const checkoutForm = page.getByTestId('checkout-form');
await checkoutForm.getByLabel('Credit Card Number').fill('4111111111111111');
await checkoutForm.getByRole('button', { name: 'Complete Purchase' }).click();
```

## Related Rules

- [selector-role-based.md](./selector-role-based.md) - Prefer semantic locators when available
- [selector-no-xpath.md](./selector-no-xpath.md) - Avoid fragile XPath expressions
- [locator-chaining.md](./locator-chaining.md) - Combine test IDs with semantic children
- [locator-first.md](./locator-first.md) - Ensure test IDs uniquely identify elements

## References

- [Playwright Docs: Locators - getByTestId](https://playwright.dev/docs/locators#locate-by-test-id)
- [Playwright Docs: Test ID Best Practices](https://playwright.dev/docs/best-practices#use-locators)
- [Autify: Playwright Get By Test ID Guide](https://autify.com/blog/playwright-get-by-id)
- [BrowserStack: Playwright Selector Best Practices](https://www.browserstack.com/guide/playwright-selectors-best-practices)
- [Momentic: Playwright Locators Guide](https://momentic.ai/blog/playwright-locators-guide)
