# Locator Strategies - Finding Elements Reliably

This document describes strategies for finding and targeting elements in web applications.

## Overview

Locators are the foundation of test reliability. A good locator:

1. **Uniquely identifies** the target element
2. **Resists change** when UI is refactored
3. **Communicates intent** to readers
4. **Works consistently** across browsers

## Locator Priority

Use locators in this order of preference:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LOCATOR PRIORITY                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Priority 1: Role-Based (Most Reliable)                                    │
│   ────────────────────────────────────────                                  │
│   getByRole('button', { name: 'Submit' })                                   │
│   getByRole('textbox', { name: 'Email' })                                   │
│   getByRole('link', { name: 'Home' })                                       │
│                                                                              │
│   Priority 2: Label-Based (Forms)                                           │
│   ────────────────────────────────                                          │
│   getByLabel('Email address')                                               │
│   getByLabel('Password')                                                    │
│   getByPlaceholder('Search...')                                             │
│                                                                              │
│   Priority 3: Text-Based (Content)                                          │
│   ────────────────────────────────                                          │
│   getByText('Welcome back')                                                 │
│   getByText(/Order #\d+/)                                                   │
│                                                                              │
│   Priority 4: Test ID (Explicit)                                            │
│   ────────────────────────────────                                          │
│   getByTestId('submit-button')                                              │
│   getByTestId('user-menu')                                                  │
│                                                                              │
│   Priority 5: CSS/XPath (Last Resort)                                       │
│   ────────────────────────────────────                                      │
│   locator('.submit-btn')                                                    │
│   locator('#main-form input[type="email"]')                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Role-Based Locators

### Why Role-Based?

- Based on accessibility roles (ARIA)
- Resilient to class/id changes
- Self-documenting
- Encourages accessible HTML

### Common Roles

| Role | HTML Elements | Example |
|------|---------------|---------|
| button | `<button>`, `<input type="button">` | `getByRole('button', { name: 'Save' })` |
| textbox | `<input type="text">`, `<textarea>` | `getByRole('textbox', { name: 'Email' })` |
| checkbox | `<input type="checkbox">` | `getByRole('checkbox', { name: 'Remember me' })` |
| radio | `<input type="radio">` | `getByRole('radio', { name: 'Option A' })` |
| link | `<a>` | `getByRole('link', { name: 'Home' })` |
| heading | `<h1>` - `<h6>` | `getByRole('heading', { name: 'Welcome' })` |
| list | `<ul>`, `<ol>` | `getByRole('list')` |
| listitem | `<li>` | `getByRole('listitem')` |
| table | `<table>` | `getByRole('table')` |
| row | `<tr>` | `getByRole('row')` |
| cell | `<td>` | `getByRole('cell')` |
| dialog | `<dialog>`, `[role="dialog"]` | `getByRole('dialog')` |
| navigation | `<nav>` | `getByRole('navigation')` |
| combobox | `<select>`, autocomplete inputs | `getByRole('combobox')` |
| option | `<option>` | `getByRole('option', { name: 'USA' })` |

### Role Options

```typescript
// Exact name match
getByRole('button', { name: 'Submit' })

// Regex match
getByRole('button', { name: /submit/i })

// Include hidden elements
getByRole('button', { name: 'Submit', includeHidden: true })

// Match by pressed state
getByRole('button', { pressed: true })

// Match by selected state
getByRole('option', { selected: true })

// Match by expanded state
getByRole('button', { expanded: true })

// Match by heading level
getByRole('heading', { level: 1 })
```

### Role Detection from Snapshots

When taking a browser snapshot, role information is included:

```
[ref=1] button "Submit" (enabled)
[ref=2] textbox "Email" (value: "")
[ref=3] link "Home" (/home)
```

Map to locators:
- `ref=1` → `getByRole('button', { name: 'Submit' })`
- `ref=2` → `getByRole('textbox', { name: 'Email' })`
- `ref=3` → `getByRole('link', { name: 'Home' })`

---

## Label-Based Locators

### getByLabel

For form inputs with associated labels:

```html
<label for="email">Email address</label>
<input id="email" type="text">
```

```typescript
page.getByLabel('Email address')
```

### Label Patterns

```typescript
// Exact match
getByLabel('Email address')

// Regex match
getByLabel(/email/i)

// Partial match (not recommended)
getByLabel('Email', { exact: false })
```

### getByPlaceholder

When no label exists:

```html
<input placeholder="Search products...">
```

```typescript
page.getByPlaceholder('Search products...')
```

---

## Text-Based Locators

### getByText

For elements containing specific text:

```typescript
// Exact text
getByText('Welcome back')

// Regex for dynamic content
getByText(/Order #\d+/)

// Case insensitive
getByText(/welcome/i)

// Partial match
getByText('Welcome', { exact: false })
```

### Text Matching Strategies

| Scenario | Strategy |
|----------|----------|
| Static text | Exact match: `getByText('Submit')` |
| Dynamic numbers | Regex: `getByText(/\d+ items/)` |
| Variable names | Regex with capture: `getByText(/Welcome, \w+/)` |
| Multiple languages | Consider test ID or role |

### getByTitle

For elements with title attribute:

```html
<button title="Close dialog">×</button>
```

```typescript
page.getByTitle('Close dialog')
```

### getByAltText

For images:

```html
<img alt="Company logo" src="logo.png">
```

```typescript
page.getByAltText('Company logo')
```

---

## Test ID Locators

### When to Use Test IDs

- Element has no accessible role
- Text is dynamic or translated
- Multiple similar elements need differentiation
- CSS classes are unstable

### Implementation

```html
<div data-testid="user-avatar">
  <img src="avatar.jpg">
</div>
```

```typescript
page.getByTestId('user-avatar')
```

### Test ID Conventions

```typescript
// Component-based
data-testid="header-nav"
data-testid="footer-links"

// Action-based
data-testid="submit-button"
data-testid="cancel-link"

// Content-based
data-testid="user-profile"
data-testid="notification-badge"

// Combination
data-testid="modal-close-button"
data-testid="form-email-input"
```

### Configuring Test ID Attribute

In `playwright.config.ts`:

```typescript
export default defineConfig({
  use: {
    // Use custom attribute
    testIdAttribute: 'data-qa'
  }
});
```

---

## CSS Locators

### When CSS is Necessary

- Legacy codebase without test IDs
- Third-party components
- Complex DOM traversal
- Performance-critical locators

### CSS Selector Patterns

```typescript
// Class selector
page.locator('.submit-button')

// ID selector
page.locator('#main-form')

// Attribute selector
page.locator('[data-type="primary"]')

// Combination
page.locator('form#login .submit-btn')

// Child selector
page.locator('.form > button')

// Descendant selector
page.locator('.form button')

// Attribute contains
page.locator('[class*="submit"]')

// Nth child
page.locator('li:nth-child(2)')

// First/last
page.locator('li:first-child')
page.locator('li:last-child')
```

### CSS Anti-Patterns

```typescript
// ❌ Fragile: relies on structure
page.locator('div > div > div > button')

// ❌ Fragile: auto-generated classes
page.locator('.css-1a2b3c')

// ❌ Fragile: relies on index
page.locator('button:nth-child(3)')

// ✅ Better: semantic class
page.locator('.submit-action')

// ✅ Better: attribute
page.locator('[data-action="submit"]')
```

---

## Combining Locators

### Chaining

Scope locator to container:

```typescript
// Find button within specific form
const form = page.locator('#registration-form');
const submitButton = form.getByRole('button', { name: 'Register' });
```

### Filtering

Narrow down matches:

```typescript
// Filter by text
page.locator('button').filter({ hasText: 'Submit' })

// Filter by child element
page.locator('.card').filter({ has: page.getByText('Premium') })

// Filter by not having
page.locator('.card').filter({ hasNot: page.locator('.disabled') })

// Chain filters
page.locator('tr')
  .filter({ hasText: 'John' })
  .filter({ has: page.locator('.active') })
```

### First, Last, Nth

When multiple elements match:

```typescript
// First matching element
page.locator('button').first()

// Last matching element
page.locator('button').last()

// Specific index (0-based)
page.locator('button').nth(2)

// All elements
const buttons = page.locator('button');
const count = await buttons.count();
```

### And/Or Combinators

```typescript
// AND: both conditions
page.locator('button').and(page.getByText('Submit'))

// OR: either condition
page.locator('button').or(page.locator('input[type="submit"]'))
```

---

## Handling Common Patterns

### Multiple Matching Elements

**Problem:** `Strict mode violation: locator resolved to 3 elements`

**Solutions:**

```typescript
// 1. Add visibility filter
page.locator('button:visible').filter({ hasText: 'Delete' })

// 2. Use first() if order is stable
page.locator('.delete-btn').first()

// 3. Scope to container
page.locator('.active-row').getByRole('button', { name: 'Delete' })

// 4. Filter more specifically
page.locator('button')
  .filter({ hasText: 'Delete' })
  .filter({ has: page.locator('.icon-trash') })
```

### Dynamic Content

**Problem:** Text changes based on data

```typescript
// ❌ Fragile
page.getByText('John Smith')

// ✅ Use test ID for dynamic names
page.getByTestId('user-name')

// ✅ Use regex for patterns
page.getByText(/^User: .+$/)

// ✅ Scope to container
page.locator('.user-card').first().getByTestId('name')
```

### Loading States

**Problem:** Element exists but shows loading state

```typescript
// Wait for loading to finish
await page.locator('.loading').waitFor({ state: 'hidden' });

// Then interact
await page.getByRole('button', { name: 'Submit' }).click();

// Or wait for enabled state
await page.getByRole('button', { name: 'Submit' }).waitFor({ state: 'visible' });
await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
```

### Hidden Elements

**Problem:** Element exists but is not visible

```typescript
// Check if visible first
const button = page.getByRole('button', { name: 'Menu' });
if (await button.isVisible()) {
  await button.click();
}

// Or wait for visibility
await button.waitFor({ state: 'visible' });
await button.click();

// Force click (use sparingly)
await button.click({ force: true });
```

### Frames and Iframes

**Problem:** Element is inside iframe

```typescript
// Locate iframe
const frame = page.frameLocator('#payment-iframe');

// Interact within frame
await frame.getByLabel('Card number').fill('4242424242424242');

// Nested frames
const innerFrame = frame.frameLocator('.inner-frame');
```

### Shadow DOM

**Problem:** Element inside shadow root

```typescript
// Playwright pierces shadow DOM by default
page.locator('custom-component').getByRole('button')

// Or be explicit
page.locator('custom-component >> button')
```

---

## Snapshot to Locator Mapping

### Reading Snapshots

Browser snapshots show elements with refs:

```
[ref=1] navigation "Main Menu"
  [ref=2] link "Home" (/home)
  [ref=3] link "Products" (/products)
  [ref=4] link "Contact" (/contact)
[ref=5] main
  [ref=6] heading "Welcome" (level=1)
  [ref=7] form
    [ref=8] textbox "Email" (value: "")
    [ref=9] textbox "Password" (type=password, value: "")
    [ref=10] button "Sign In" (enabled)
```

### Mapping Strategy

| Snapshot | Locator Strategy |
|----------|------------------|
| `button "Sign In"` | `getByRole('button', { name: 'Sign In' })` |
| `textbox "Email"` | `getByRole('textbox', { name: 'Email' })` or `getByLabel('Email')` |
| `link "Home"` | `getByRole('link', { name: 'Home' })` |
| `heading "Welcome"` | `getByRole('heading', { name: 'Welcome' })` |
| `navigation "Main Menu"` | `getByRole('navigation')` (if unique) |

### When Role Isn't Enough

If snapshot shows generic element:

```
[ref=15] generic (class="card-container")
  [ref=16] text "Product Name"
  [ref=17] button "Add to Cart"
```

Options:
1. Use child: `page.locator('.card-container').getByRole('button', { name: 'Add to Cart' })`
2. Request test ID be added: `page.getByTestId('product-card')`
3. Filter by content: `page.locator('.card-container').filter({ hasText: 'Product Name' })`

---

## Locator Debugging

### Visual Debugging

```bash
# Run with debug mode
npx playwright test --debug

# Opens inspector showing element highlight
```

### Locator Highlighting

```typescript
// In test, highlight element
await page.locator('button').highlight();
```

### Console Testing

In browser console (when running headed):

```javascript
// Test selector
document.querySelector('[data-testid="submit"]')

// Test all matches
document.querySelectorAll('button')
```

### Playwright Inspector

```bash
# Open inspector
npx playwright codegen

# Record actions, see suggested locators
```

---

## Locator Best Practices

### DO

```typescript
// ✅ Use semantic locators
getByRole('button', { name: 'Submit' })
getByLabel('Email')

// ✅ Add test IDs for complex scenarios
getByTestId('user-menu-dropdown')

// ✅ Scope to containers
page.locator('.modal').getByRole('button', { name: 'Close' })

// ✅ Handle multiple matches explicitly
page.locator('.item').first()
page.locator('button:visible').filter({ hasText: 'Delete' })

// ✅ Use regex for dynamic text
getByText(/Order #\d+/)

// ✅ Wait for element state
await element.waitFor({ state: 'visible' })
```

### DON'T

```typescript
// ❌ Rely on structure
page.locator('div > div > span > button')

// ❌ Use auto-generated classes
page.locator('.MuiButton-root-xyz123')

// ❌ Use index without context
page.locator('button').nth(5)

// ❌ Mix locator strategies inconsistently
// (use one primary strategy per codebase)

// ❌ Hardcode dynamic values
page.getByText('Welcome, John Smith')

// ❌ Use force: true as first resort
await button.click({ force: true })
```

---

## Locator Strategy Checklist

When choosing a locator:

```
□ Can I use getByRole? (preferred)
□ Can I use getByLabel? (for form inputs)
□ Can I use getByText? (for static content)
□ Is there a test ID? (for complex elements)
□ Do I need to scope to a container? (for multiple matches)
□ Do I need to add :visible? (for hidden duplicates)
□ Do I need .first()? (for multiple visible matches)
□ Is the locator resilient to UI changes?
□ Is the locator self-documenting?
```
