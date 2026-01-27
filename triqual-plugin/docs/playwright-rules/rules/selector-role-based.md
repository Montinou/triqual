# Rule: selector-role-based

> **Category**: Locators
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Prefer `getByRole()` over other locator strategies as it reflects how users and assistive technology perceive the page, ensuring both test resilience and accessibility compliance.

## Rationale

Role-based locators are Playwright's **highest priority recommendation** because they:

1. **Mirror User Perception**: According to Playwright's documentation, `getByRole()` "reflects how users and assistive technology perceive the page, for example whether some element is a button or a checkbox." This makes tests more aligned with actual user behavior.

2. **Enforce Accessibility**: Using role-based selectors validates that your application properly implements ARIA roles and semantic HTML, improving accessibility by default. If `getByRole()` can't find an element, it signals an accessibility issue.

3. **Survive Refactoring**: Role-based locators rely on the accessibility tree rather than DOM structure, class names, or styling. Layout changes, CSS refactoring, and framework migrations don't break these selectors.

4. **Built-in Filtering**: `getByRole()` supports filtering by accessible name, making it easy to target specific instances of common roles like buttons or links.

5. **Shadow DOM Support**: Like all Playwright built-in locators, `getByRole()` automatically pierces shadow roots, unlike XPath or many CSS selectors.

Modern design systems typically include semantic roles by default, making role-based selectors practical for most UI components. This approach creates a virtuous cycle—tests that enforce good accessibility lead to better user experiences for everyone.

## Best Practice

Prioritize role-based locators with accessible names for interactive elements:

```typescript
// Best - button with accessible name
await page.getByRole('button', { name: 'Sign In' }).click();
await page.getByRole('button', { name: /submit/i }).click(); // regex matching

// Best - form controls with roles
await page.getByRole('textbox', { name: 'Email Address' }).fill('user@example.com');
await page.getByRole('checkbox', { name: 'Remember me' }).check();
await page.getByRole('combobox', { name: 'Country' }).selectOption('USA');

// Best - navigation elements
await page.getByRole('link', { name: 'Documentation' }).click();
await page.getByRole('navigation').getByRole('link', { name: 'Products' }).click();

// Best - headings and landmarks
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
await page.getByRole('main').getByRole('article').first().click();

// Best - dialog/modal interactions
const dialog = page.getByRole('dialog');
await expect(dialog).toBeVisible();
await dialog.getByRole('button', { name: 'Close' }).click();

// Best - combining with filtering
await page.getByRole('row')
  .filter({ hasText: 'john@example.com' })
  .getByRole('button', { name: 'Edit' })
  .click();

// Best - table navigation
await page.getByRole('table').getByRole('row').nth(2).getByRole('cell').first().click();

// Good - level option for headings
await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome');

// Good - expanded/pressed states
await page.getByRole('button', { name: 'Menu', expanded: false }).click();
await expect(page.getByRole('button', { name: 'Like', pressed: true })).toBeVisible();
```

## Anti-Pattern

Using CSS selectors, class names, or test IDs when role-based locators are available:

```typescript
// Bad - CSS class selector instead of role
await page.locator('.btn-primary').click();
// Should be: page.getByRole('button', { name: 'Submit' })

// Bad - test ID for standard button
await page.getByTestId('login-button').click();
// Should be: page.getByRole('button', { name: 'Log In' })

// Bad - element type selector
await page.locator('button').click();
// Should be: page.getByRole('button', { name: 'Action Name' })

// Bad - CSS selector for link
await page.locator('a[href="/docs"]').click();
// Should be: page.getByRole('link', { name: 'Documentation' })

// Bad - ID selector for form field
await page.locator('#email-input').fill('user@example.com');
// Should be: page.getByRole('textbox', { name: 'Email' })

// Bad - missing accessible name when needed
await page.getByRole('button').first().click();
// Should identify which button: page.getByRole('button', { name: 'Specific Action' })

// Bad - bypassing role for custom components
await page.locator('[data-component="custom-button"]').click();
// Ensure component has proper role, then use: page.getByRole('button', { name: '...' })

// Bad - generic text locator when role is available
await page.getByText('Submit').click();
// Should be: page.getByRole('button', { name: 'Submit' })
```

## Exceptions

Alternative locators are acceptable when role-based selection is impractical:

1. **Non-interactive Content**: Static text, images, or decorative elements without semantic roles
```typescript
// Acceptable - static text content
await expect(page.getByText('Welcome back, user!')).toBeVisible();

// Acceptable - images without interactive role
await expect(page.getByAltText('Company Logo')).toBeVisible();
```

2. **Custom Components Without Roles**: Temporarily, while working with developers to add proper ARIA roles
```typescript
// Acceptable temporarily - document the accessibility issue
// TODO: Add role="button" to CustomToggle component
await page.getByTestId('custom-toggle').click();
```

3. **Icon-only Buttons**: When accessible name is missing (fix the accessibility issue first)
```typescript
// Acceptable - but indicates accessibility problem
// BETTER: Ensure button has aria-label, then use getByRole
await page.getByTestId('icon-button-settings').click();
```

4. **Complex Widgets**: Multi-part components where individual parts lack distinct roles
```typescript
// Acceptable - date picker with complex internals
await page.getByTestId('date-picker').click();
await page.getByRole('button', { name: 'Next Month' }).click();
```

5. **Third-party Components**: Libraries that don't implement proper ARIA roles
```typescript
// Acceptable - external library without semantic HTML
await page.locator('.react-select__control').click();
await page.locator('.react-select__option').first().click();
```

## Auto-fix

Not auto-fixable—converting to role-based locators requires understanding element semantics and accessible names.

```typescript
// Before - CSS class selector
await page.locator('.submit-button').click();

// After - role-based with accessible name
await page.getByRole('button', { name: 'Submit' }).click();

// Before - test ID for standard control
await page.getByTestId('search-input').fill('Playwright');

// After - role-based with label
await page.getByRole('searchbox', { name: 'Search' }).fill('Playwright');
// Or: await page.getByLabel('Search').fill('Playwright');

// Before - element selector
await page.locator('input[type="checkbox"]').check();

// After - role-based
await page.getByRole('checkbox', { name: 'I agree to terms' }).check();

// Before - XPath expression
await page.locator('//button[contains(text(), "Delete")]').click();

// After - role-based with text matching
await page.getByRole('button', { name: /delete/i }).click();

// Before - nested CSS selectors
await page.locator('nav .menu-item a').first().click();

// After - role-based chaining
await page.getByRole('navigation')
  .getByRole('link', { name: 'Home' })
  .click();
```

## Related Rules

- [selector-testid.md](./selector-testid.md) - Use test IDs when roles unavailable
- [selector-no-xpath.md](./selector-no-xpath.md) - Avoid XPath in favor of semantic locators
- [locator-chaining.md](./locator-chaining.md) - Chain role-based locators for precision
- [locator-first.md](./locator-first.md) - Add accessible names to avoid .first()

## References

- [Playwright Docs: Locators - getByRole](https://playwright.dev/docs/locators#locate-by-role)
- [Playwright Docs: Best Practices - Use Locators](https://playwright.dev/docs/best-practices#use-locators)
- [BrowserStack: Playwright GetByRole Guide](https://www.browserstack.com/guide/playwright-getbyrole)
- [QA Expertise: In-Depth Understanding of getByRole](https://qaexpertise.com/playwright/an-in-depth-understanding-of-getbyrole-in-playwright/)
- [Momentic: Playwright Locators Guide](https://momentic.ai/blog/playwright-locators-guide)
- [W3C: ARIA Roles Reference](https://www.w3.org/TR/wai-aria-1.2/#role_definitions)
