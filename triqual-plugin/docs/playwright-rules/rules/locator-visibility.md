# Rule: locator-visibility

> **Category**: Locators
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Always verify element visibility before interactions instead of relying solely on auto-waiting, especially when testing dynamic UI states.

## Rationale

While Playwright actions include built-in auto-waiting for visibility, explicit visibility checks provide better test clarity and prevent flaky tests in scenarios where elements may be:
- Hidden by CSS (`visibility: hidden`, `display: none`)
- Positioned off-screen or behind overlays
- In the process of animating or transitioning
- Rendered but not yet visible to users

Playwright defines visibility as having a non-empty bounding box and no `visibility:hidden` computed style. Elements with `opacity:0` are considered visible, while zero-size elements are not.

According to Playwright's official documentation, auto-waiting ensures elements pass actionability checks before interactions, but explicit assertions make test intentions clearer and provide better error messages when visibility conditions fail.

## Best Practice

Use `toBeVisible()` assertions to explicitly verify visibility before critical interactions:

```typescript
// Good - explicit visibility check with clear intent
await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
await page.getByRole('button', { name: 'Submit' }).click();

// Good - wait for dynamic element to appear
const modal = page.getByRole('dialog');
await modal.waitFor({ state: 'visible' });
await expect(modal).toBeVisible();

// Good - test visibility transitions
await page.getByRole('button', { name: 'Show Details' }).click();
const detailsPanel = page.getByTestId('details-panel');
await expect(detailsPanel).toBeVisible();
await expect(detailsPanel).toContainText('Product Information');

// Good - verify multiple elements are visible
const navigationLinks = page.getByRole('navigation').getByRole('link');
await expect(navigationLinks.first()).toBeVisible();
await expect(navigationLinks).toHaveCount(5);
```

## Anti-Pattern

Relying entirely on auto-waiting without explicit visibility verification:

```typescript
// Bad - no visibility verification before critical action
await page.getByRole('button', { name: 'Submit' }).click();
// Test may pass even if button briefly appears and disappears

// Bad - assuming element is visible without checking
const errorMessage = page.getByText('Invalid credentials');
await errorMessage.click(); // May timeout without clear reason

// Bad - no verification after triggering show/hide
await page.getByRole('button', { name: 'Toggle Menu' }).click();
await page.getByRole('menuitem', { name: 'Settings' }).click();
// Menu might not be fully visible yet

// Bad - checking existence instead of visibility
const banner = page.locator('.promotional-banner');
expect(await banner.count()).toBeGreaterThan(0);
// Element might exist in DOM but be hidden

// Bad - redundant waitForSelector (deprecated pattern)
await page.waitForSelector('.modal', { state: 'visible' });
await page.locator('.modal').click();
// Use locator.waitFor() instead
```

## Exceptions

Explicit visibility checks may be skipped in these scenarios:

1. **Stateless components**: Elements that are always visible and never hidden by application logic
```typescript
// Acceptable - header is always visible
await page.getByRole('banner').getByRole('link', { name: 'Logo' }).click();
```

2. **Immediate subsequent assertions**: When the next line already includes a visibility-dependent assertion
```typescript
// Acceptable - toHaveText implies visibility
await expect(page.getByRole('heading')).toHaveText('Dashboard');
```

3. **Form interactions with guaranteed visibility**: Standard form fields that are never conditionally hidden
```typescript
// Acceptable - login form fields are always visible
await page.getByLabel('Email').fill('user@example.com');
await page.getByLabel('Password').fill('password123');
```

4. **Testing hidden states**: When specifically verifying elements are NOT visible
```typescript
// Acceptable - testing hidden state
await expect(page.getByTestId('loading-spinner')).toBeHidden();
```

## Auto-fix

This rule is not auto-fixable because visibility checks require context-specific decisions about when and where they're necessary. However, lint warnings can suggest adding visibility assertions.

```typescript
// Before
await page.getByRole('button', { name: 'Checkout' }).click();

// After (manual fix with explicit check)
const checkoutButton = page.getByRole('button', { name: 'Checkout' });
await expect(checkoutButton).toBeVisible();
await checkoutButton.click();

// Alternative pattern for dynamic elements
await page.getByRole('button', { name: 'Load More' }).click();
const additionalContent = page.getByTestId('lazy-loaded-items');
await additionalContent.waitFor({ state: 'visible', timeout: 5000 });
await expect(additionalContent).toBeVisible();
```

## Related Rules

- [locator-first.md](./locator-first.md) - Handle multiple matching elements
- [selector-role-based.md](./selector-role-based.md) - Use semantic locators
- [locator-chaining.md](./locator-chaining.md) - Narrow scope for precise targeting

## References

- [Playwright Docs: Auto-waiting](https://playwright.dev/docs/actionability)
- [Playwright Docs: LocatorAssertions - toBeVisible](https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-be-visible)
- [Playwright Docs: Locator.waitFor()](https://playwright.dev/docs/api/class-locator#locator-wait-for)
- [Checkly Guide: Dealing with waits and timeouts](https://www.checklyhq.com/docs/learn/playwright/waits-and-timeouts/)
- [Oxylabs: Wait for Element to Be Visible](https://oxylabs.io/resources/web-scraping-faq/playwright/wait-element-visible)
