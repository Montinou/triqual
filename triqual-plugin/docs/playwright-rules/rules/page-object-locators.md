# Rule: Move Inline Locators to Page Objects

> **Category**: Page Objects
> **Severity**: INFO
> **Auto-fixable**: YES

## Summary

Store element locators as readonly properties in Page Object classes instead of defining them inline in test files.

## Rationale

Centralizing locators in Page Objects provides a single source of truth for element selectors. When UI changes occur, you only need to update the locator in one place rather than across multiple test files. This dramatically reduces maintenance effort and prevents inconsistencies where some tests are updated but others are missed.

By declaring locators as class properties, you leverage Playwright's lazy evaluation - locators are defined once during construction but only resolved when actions are performed, ensuring they always find fresh elements on the page.

## Best Practice

Create a Page Object class with locators defined as readonly properties in the constructor:

```typescript
import { type Locator, type Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByLabel('Username');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
    this.errorMessage = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
```

Usage in test:

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login-page';

test('user can log in with valid credentials', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('testuser', 'password123');
  await expect(page).toHaveURL(/\/dashboard/);
});
```

## Anti-Pattern

Defining locators inline in test files, scattering selector logic across multiple locations:

```typescript
import { test, expect } from '@playwright/test';

test('user can log in with valid credentials', async ({ page }) => {
  await page.goto('/login');

  // Inline locators scattered throughout test
  await page.getByLabel('Username').fill('testuser');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard/);
});

test('user sees error with invalid credentials', async ({ page }) => {
  await page.goto('/login');

  // Same locators duplicated - maintenance nightmare
  await page.getByLabel('Username').fill('invalid');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // If this selector changes, you must update all tests
  await expect(page.getByRole('alert')).toBeVisible();
});
```

**Problems with this approach:**
- When "Username" label changes to "Email", you must find and update every test file
- Inconsistent selectors may emerge (some use `getByLabel`, others use `getByTestId`)
- Tests become cluttered with low-level selector details
- No type safety or autocomplete for locators

## Exceptions

For very simple, one-off tests or exploratory testing where you're validating a single interaction and won't reuse the locators:

```typescript
test('verify 404 page exists', async ({ page }) => {
  await page.goto('/nonexistent-page');
  await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
});
```

However, once you have 2-3 tests touching the same page, refactor to a Page Object.

## Auto-fix

The transformation extracts inline locators into a Page Object class:

**Before:**

```typescript
// tests/login.spec.ts
test('login test', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('user');
  await page.getByLabel('Password').fill('pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
});
```

**After (auto-fixed):**

```typescript
// pages/login-page.ts
import { type Locator, type Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByLabel('Username');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}

// tests/login.spec.ts
import { LoginPage } from '../pages/login-page';

test('login test', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('user', 'pass');
});
```

## Related Rules

- [page-object-actions](./page-object-actions.md) - Encapsulate actions using these locators
- [page-object-composition](./page-object-composition.md) - Compose Page Objects for complex pages
- [selector-role-based](./selector-role-based.md) - Use role-based locators in Page Objects

## References

- [Playwright Docs: Page Object Models](https://playwright.dev/docs/pom)
- [Playwright Docs: Locators](https://playwright.dev/docs/locators)
- [Martin Fowler: Page Object](https://martinfowler.com/bliki/PageObject.html)
- [BrowserStack: Page Object Model with Playwright](https://www.browserstack.com/guide/page-object-model-with-playwright)
