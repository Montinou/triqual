# Locator Strategies

Best practices for finding elements reliably in Playwright tests.

## Priority Order

1. **Accessibility roles** - Most resilient to UI changes
2. **Test IDs** - Explicit testing hooks
3. **Labels** - Form-associated elements
4. **Text content** - User-visible text
5. **CSS selectors** - Last resort

## Role-Based Locators

```typescript
// Buttons
page.getByRole('button', { name: 'Submit' })
page.getByRole('button', { name: /submit/i })

// Links
page.getByRole('link', { name: 'Home' })

// Form elements
page.getByRole('textbox', { name: 'Email' })
page.getByRole('checkbox', { name: 'Remember me' })

// Navigation
page.getByRole('navigation')
page.getByRole('main')
```

## Test IDs

Add `data-testid` attributes for elements without accessible names:

```html
<div data-testid="user-avatar">...</div>
```

```typescript
page.getByTestId('user-avatar')
```

## Anti-Patterns

Avoid these fragile selectors:

```typescript
// Avoid - index-based
page.locator('.item').nth(0)

// Avoid - deep nesting
page.locator('.container > div > span > button')

// Avoid - auto-generated IDs
page.locator('#btn-12345')

// Avoid - style-based
page.locator('[style*="display: block"]')
```

## Chaining Locators

Filter large result sets:

```typescript
// Find button within specific section
page.getByRole('region', { name: 'Sidebar' })
  .getByRole('button', { name: 'Settings' })
```
