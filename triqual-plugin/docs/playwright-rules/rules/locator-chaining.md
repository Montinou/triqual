# Rule: locator-chaining

> **Category**: Locators
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Chain locators to narrow search scope progressively, starting broad and refining to specific elements within containers, improving test resilience and readability.

## Rationale

Locator chaining creates precise, maintainable selectors by composing multiple locator methods. According to Playwright's documentation, "You can chain methods that create a locator, like `page.getByText()` or `locator.getByRole()`, to narrow down the search to a particular part of the page."

Benefits of chaining:

1. **Scope Isolation**: Target elements within specific containers (cards, forms, modals) without relying on global uniqueness
2. **Semantic Clarity**: Code reads like natural language: "In the user profile card, click the edit button"
3. **Resilience**: Chains survive page restructuring better than long CSS selectors or XPath
4. **Reusability**: Store container locators as variables and reuse across multiple assertions/actions
5. **Shadow DOM Support**: Inner locators automatically pierce shadow roots within outer containers

Key principle: **Inner locators are relative to outer locators**, queried from the outer match (not document root). This enables progressive narrowing: container → section → specific element.

Playwright's filtering methods (`filter()`, `and()`, `or()`) complement chaining by adding conditions without breaking the chain, creating powerful compositional selectors.

## Best Practice

Chain locators from broad containers to specific elements using semantic methods:

```typescript
// Best - chain from container to button
const userCard = page.getByTestId('user-profile-card');
await userCard.getByRole('button', { name: 'Edit Profile' }).click();

// Best - chain with roles for navigation
await page.getByRole('navigation')
  .getByRole('link', { name: 'Documentation' })
  .click();

// Best - chain within dialog/modal
const confirmDialog = page.getByRole('dialog');
await expect(confirmDialog.getByRole('heading')).toHaveText('Confirm Action');
await confirmDialog.getByRole('button', { name: 'Confirm' }).click();

// Best - chain with filter for specific row
const targetRow = page.getByRole('row').filter({ hasText: 'john@example.com' });
await targetRow.getByRole('button', { name: 'Delete' }).click();
await expect(targetRow.getByRole('cell').first()).toContainText('john@example.com');

// Best - reusable container locator
const searchResults = page.getByRole('region', { name: 'Search Results' });
await expect(searchResults.getByRole('link')).toHaveCount(10);
await searchResults.getByRole('link').first().click();

// Best - chain multiple levels
await page.getByRole('main')
  .getByRole('article')
  .filter({ hasText: 'Featured' })
  .getByRole('link', { name: 'Read More' })
  .click();

// Best - form within section
const checkoutSection = page.getByRole('region', { name: 'Checkout' });
await checkoutSection.getByLabel('Card Number').fill('4111111111111111');
await checkoutSection.getByLabel('Expiry Date').fill('12/25');
await checkoutSection.getByRole('button', { name: 'Pay Now' }).click();

// Good - filter by child element
await page.getByRole('article')
  .filter({ has: page.getByText('Breaking News') })
  .getByRole('button', { name: 'Share' })
  .click();

// Good - combining AND conditions
const activeButton = page.getByRole('button')
  .and(page.locator('[aria-pressed="true"]'));
await expect(activeButton).toBeVisible();

// Good - OR for alternatives
const message = page.getByText('Success').or(page.getByText('Completed'));
await expect(message).toBeVisible();
```

## Anti-Pattern

Long CSS/XPath chains, excessive nesting, or missing container isolation:

```typescript
// Bad - long CSS selector chain
await page.locator('#content > div.container > div.card > div.actions > button.primary').click();

// Bad - XPath hierarchy traversal
await page.locator('//div[@id="user-card"]//div[@class="actions"]//button').click();

// Bad - no scope isolation (assumes global uniqueness)
await page.getByRole('button', { name: 'Delete' }).click();
// Which delete button? Better: target within specific container

// Bad - excessive chaining without semantic meaning
await page.locator('div').locator('div').locator('span').locator('button').click();

// Bad - chaining with .first() instead of specific filtering
await page.getByRole('article').first().getByRole('button').first().click();
// Too vague - which article and which button?

// Bad - mixing CSS with semantic locators unnecessarily
await page.locator('.user-card').getByRole('button', { name: 'Edit' }).click();
// Better: page.getByTestId('user-card').getByRole('button', { name: 'Edit' })

// Bad - not reusing container reference
await page.getByTestId('modal').getByRole('heading').click();
await page.getByTestId('modal').getByRole('button').click();
await page.getByTestId('modal').getByText('Description').click();
// Better: store const modal = page.getByTestId('modal') and reuse

// Bad - assuming inner locator is global
const card = page.getByTestId('product-card');
await page.getByRole('button', { name: 'Add to Cart' }).click();
// Should be: card.getByRole('button', { name: 'Add to Cart' })

// Bad - chaining after .first() (loses semantic context)
await page.getByRole('article').first().locator('.metadata .author').click();
// Better: identify article by content, then use semantic locator
```

## Exceptions

Avoid chaining when it adds unnecessary complexity:

1. **Globally Unique Elements**: When an element is guaranteed unique on the page
```typescript
// Acceptable - main navigation is globally unique
await page.getByRole('button', { name: 'Sign In' }).click();
```

2. **Top-level Landmarks**: Page-wide regions that don't need scoping
```typescript
// Acceptable - single main heading
await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
```

3. **Simple Forms**: When form fields have unique labels
```typescript
// Acceptable - login form with unique field labels
await page.getByLabel('Email').fill('user@example.com');
await page.getByLabel('Password').fill('password123');
```

4. **Single-item Containers**: When container has only one interactive element
```typescript
// Acceptable - alert with single action
await page.getByRole('alert').getByRole('button').click();
```

5. **Over-scoping**: Avoid chaining that makes tests too specific and brittle
```typescript
// Acceptable - element is sufficiently unique
await page.getByRole('link', { name: 'Privacy Policy' }).click();

// Over-scoped - unnecessary nesting
await page.getByRole('contentinfo')
  .getByRole('navigation')
  .getByRole('list')
  .getByRole('listitem')
  .getByRole('link', { name: 'Privacy Policy' })
  .click();
```

## Auto-fix

Not auto-fixable—effective chaining requires understanding page structure and semantic relationships.

```typescript
// Before - long CSS selector
await page.locator('#user-profile .actions .edit-btn').click();

// After - semantic chaining
const userProfile = page.getByTestId('user-profile');
await userProfile.getByRole('button', { name: 'Edit' }).click();

// Before - XPath traversal
await page.locator('//form[@id="checkout"]//input[@name="email"]').fill('test@example.com');

// After - semantic chaining
const checkoutForm = page.getByRole('form', { name: 'Checkout' });
await checkoutForm.getByLabel('Email').fill('test@example.com');

// Before - no scope isolation
await page.getByRole('button', { name: 'Delete' }).first().click();

// After - scoped to specific row
await page.getByRole('row')
  .filter({ hasText: 'john@example.com' })
  .getByRole('button', { name: 'Delete' })
  .click();

// Before - repetitive container queries
await page.getByTestId('modal').getByRole('heading').click();
await page.getByTestId('modal').getByRole('button').click();

// After - reusable container reference
const modal = page.getByTestId('modal');
await expect(modal.getByRole('heading')).toHaveText('Confirm');
await modal.getByRole('button', { name: 'OK' }).click();

// Before - global locator with .first()
await page.getByRole('article').first().getByText('Read More').click();

// After - filtered chain with specific targeting
await page.getByRole('article')
  .filter({ hasText: 'Featured Article' })
  .getByRole('link', { name: 'Read More' })
  .click();
```

## Related Rules

- [selector-role-based.md](./selector-role-based.md) - Use semantic locators in chains
- [locator-first.md](./locator-first.md) - Avoid .first() by improving chain specificity
- [selector-no-xpath.md](./selector-no-xpath.md) - Replace XPath traversal with chaining
- [selector-testid.md](./selector-testid.md) - Use test IDs for container identification
- [locator-visibility.md](./locator-visibility.md) - Verify chained locator visibility

## References

- [Playwright Docs: Locators - Chaining](https://playwright.dev/docs/locators#chaining-locators)
- [Playwright Docs: Locators - Filtering](https://playwright.dev/docs/locators#filtering-locators)
- [Playwright Docs: Locator.filter()](https://playwright.dev/docs/api/class-locator#locator-filter)
- [OpsMatters: How to Narrow and Chain Playwright Locators](https://opsmatters.com/videos/how-narrow-and-chain-your-playwright-locators)
- [Dev.to: Simplify and Stabilize Your Playwright Locators](https://dev.to/mikestopcontinues/simplify-and-stabilize-your-playwright-locators-1ag7)
- [Momentic: Playwright Locators Guide](https://momentic.ai/blog/playwright-locators-guide)
