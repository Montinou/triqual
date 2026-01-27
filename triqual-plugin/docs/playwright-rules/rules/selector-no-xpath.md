# Rule: selector-no-xpath

> **Category**: Locators
> **Severity**: ERROR
> **Auto-fixable**: NO

## Summary

Avoid XPath selectors in favor of Playwright's built-in locator methods, as XPath creates brittle tests tied to DOM structure and has performance limitations.

## Rationale

XPath selectors are considered an anti-pattern in modern Playwright testing for multiple critical reasons:

1. **DOM Structure Coupling**: XPath expressions like `//*[@id="form"]/div[2]/div[1]/input` break immediately when developers restructure HTML, reorder elements, or refactor components.

2. **Poor Performance**: XPath queries are slower than native browser query methods and Playwright's optimized locator engine.

3. **Shadow DOM Limitations**: According to Playwright's official documentation, "XPath does not pierce shadow roots," preventing it from locating elements within Web Components or modern framework internals.

4. **Maintenance Burden**: XPath syntax is less readable than semantic locators, making tests harder to understand and maintain. Complex XPath expressions become cryptic quickly.

5. **No Accessibility Benefits**: Unlike role-based locators, XPath doesn't enforce or validate accessibility attributes, missing opportunities to improve application quality.

Playwright's built-in locator methods (getByRole, getByText, getByLabel, getByTestId) are specifically designed to be resilient, readable, and user-centric, making XPath obsolete in most scenarios.

## Best Practice

Replace XPath with semantic, user-facing locator strategies:

```typescript
// Best - role-based locator (accessibility-first)
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');

// Good - text-based locator for non-interactive elements
await expect(page.getByText('Welcome back!')).toBeVisible();

// Good - label-based locator for form controls
await page.getByLabel('Password').fill('secure123');

// Good - test ID for complex components
await page.getByTestId('user-profile-dropdown').click();

// Good - chaining to narrow scope
const searchResults = page.getByRole('region', { name: 'Search Results' });
await searchResults.getByRole('link').first().click();

// Good - filtering by text within container
await page.getByRole('article')
  .filter({ hasText: 'Breaking News' })
  .getByRole('button', { name: 'Read More' })
  .click();

// Good - CSS selector when semantic alternative unavailable
await page.locator('[data-analytics-id="hero-cta"]').click();

// Acceptable - CSS attribute selector for stable attributes
await page.locator('[aria-label="Close dialog"]').click();
```

## Anti-Pattern

Using XPath expressions that couple tests to DOM structure:

```typescript
// Bad - absolute XPath tied to DOM hierarchy
await page.locator('/html/body/div[1]/main/form/button').click();

// Bad - relative XPath with positional predicates
await page.locator('//div[@class="container"]/div[2]/span[1]').textContent();

// Bad - XPath axes traversal
await page.locator('//input[@type="email"]/following-sibling::span').click();

// Bad - complex XPath with multiple conditions
await page.locator('//button[contains(@class, "primary") and contains(text(), "Submit")]').click();

// Bad - XPath for text matching (getByText is cleaner)
await page.locator('//*[text()="Welcome"]').click();

// Bad - XPath with position() function
await page.locator('(//div[@class="item"])[3]').click();

// Bad - XPath attribute contains
await page.locator('//*[contains(@id, "user-")]').click();

// Bad - XPath for shadow DOM elements (won't work)
await page.locator('//custom-element//button').click();
// XPath doesn't pierce shadow roots!

// Bad - generated XPath from browser DevTools
await page.locator('//*[@id="root"]/div/div[2]/div/div/div[1]/div[2]/button[1]').click();
// Extremely fragile and unreadable
```

## Exceptions

XPath may rarely be justified in these edge cases:

1. **Legacy Systems**: Third-party applications without modern HTML semantics or test IDs
```typescript
// Acceptable - legacy app with no better alternative
// Document why XPath is necessary
await page.locator('//table[@id="legacy-grid"]//tr[5]/td[3]').textContent();
```

2. **XML/SVG Traversal**: Non-HTML content where CSS selectors are inadequate
```typescript
// Acceptable - SVG elements with specific attributes
await page.locator('//*[local-name()="svg"]//*[local-name()="path"]').click();
// Note: Playwright's locator() often works for SVG too
```

3. **Specific Text Nodes**: When text content is split across inline elements
```typescript
// Acceptable - but consider getByText with regex first
const textNode = page.locator('//div[text()="Exact text only"]');
// Prefer: page.getByText('Exact text only', { exact: true })
```

4. **Temporary Debugging**: Exploration during test development (must be refactored)
```typescript
// TEMPORARY - refactor before committing
// TODO: Replace with getByRole after identifying accessible name
await page.locator('//button[contains(@class, "unknown-component")]').click();
```

## Auto-fix

Not auto-fixable—XPath migration requires understanding semantic meaning and context.

```typescript
// Before - XPath expression
await page.locator('//button[@type="submit"]').click();

// After - role-based locator
await page.getByRole('button', { name: 'Submit' }).click();

// Before - XPath text matching
await expect(page.locator('//*[contains(text(), "Error")]')).toBeVisible();

// After - text-based locator with regex
await expect(page.getByText(/Error/i)).toBeVisible();

// Before - XPath hierarchy traversal
await page.locator('//form[@id="login"]//input[@name="username"]').fill('user');

// After - semantic chaining
const loginForm = page.getByRole('form', { name: 'Login' });
await loginForm.getByLabel('Username').fill('user');

// Before - XPath sibling axis
await page.locator('//label[text()="Email"]/following-sibling::input').fill('test@example.com');

// After - label-based locator (Playwright handles association automatically)
await page.getByLabel('Email').fill('test@example.com');

// Before - XPath with multiple predicates
await page.locator('//div[@class="card" and @data-status="active"]//button').click();

// After - CSS selector + chaining
await page.locator('.card[data-status="active"]').getByRole('button').click();
```

## Related Rules

- [selector-role-based.md](./selector-role-based.md) - Prefer semantic role locators
- [selector-testid.md](./selector-testid.md) - Use test IDs for non-semantic elements
- [locator-chaining.md](./locator-chaining.md) - Chain locators instead of hierarchy traversal
- [locator-first.md](./locator-first.md) - Handle multiple matches without positional XPath

## References

- [Playwright Docs: Locators](https://playwright.dev/docs/locators)
- [Playwright Docs: Other Locators (CSS/XPath)](https://playwright.dev/docs/other-locators)
- [BrowserStack: Playwright Selector Best Practices](https://www.browserstack.com/guide/playwright-selectors-best-practices)
- [Bondar Academy: Playwright Locators Best Practices](https://www.bondaracademy.com/blog/playwright-locators-best-practices)
- [Momentic: Playwright Locators Guide](https://momentic.ai/blog/playwright-locators-guide)
- [BrowserCat: Strengthen Selectors and Locators](https://www.browsercat.com/post/strengthen-selectors-and-locators-in-playwright)
