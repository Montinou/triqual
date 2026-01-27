# Rule: Keep Assertions in Tests, Not Page Objects

> **Category**: Page Objects
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary

Page Objects should provide access to page state and perform actions, but test assertions should remain in test files where they express expected outcomes.

## Rationale

Martin Fowler's foundational principle for Page Objects states: "Page objects should not make assertions themselves. Their responsibility is to provide access to the state of the underlying page. It's up to test clients to carry out the assertion logic."

This separation maintains clear responsibilities:

- **Page Objects**: Represent the page structure and provide methods to interact with it
- **Tests**: Express expected behavior and verify outcomes with assertions

When Page Objects contain assertions, they become opinionated about what "correct" behavior is, limiting their reusability. A `login()` method that asserts successful navigation to the dashboard cannot be reused in a test validating error messages for invalid credentials.

Additionally, test failures become less clear. If an assertion fails inside a Page Object method, the stack trace points to the Page Object, not the test's specific expectation, making debugging harder.

However, **limited internal validation** for state transitions (e.g., confirming a modal opened before interacting with it) is acceptable when it prevents false positives from race conditions.

## Best Practice

Page Objects expose state and provide actions; tests perform assertions:

```typescript
import { expect, type Locator, type Page } from '@playwright/test';

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

  // Action method - no assertions about outcome
  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  // Accessor method - returns state, doesn't assert
  async getErrorMessage(): Promise<string> {
    return await this.errorMessage.textContent() ?? '';
  }

  // Accessor - exposes element for test assertions
  async isErrorVisible(): Promise<boolean> {
    return await this.errorMessage.isVisible();
  }
}

export class DashboardPage {
  readonly page: Page;
  readonly welcomeHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.welcomeHeading = page.getByRole('heading', { name: /welcome/i });
  }

  async goto() {
    await this.page.goto('/dashboard');
  }
}
```

Tests perform all assertions, expressing expected behavior:

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login-page';
import { DashboardPage } from './pages/dashboard-page';

test('user can login with valid credentials', async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboard = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.login('validuser', 'validpassword');

  // Test asserts the expected outcome
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(dashboard.welcomeHeading).toBeVisible();
});

test('user sees error message with invalid credentials', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('invaliduser', 'wrongpassword');

  // Test asserts the error condition - same login() method reused
  await expect(loginPage.errorMessage).toBeVisible();
  await expect(loginPage.errorMessage).toContainText('Invalid username or password');
  await expect(page).toHaveURL(/\/login/); // Still on login page
});

test('user cannot submit with empty password', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('testuser', '');

  // Different assertion expectations - login() method stays flexible
  await expect(loginPage.submitButton).toBeDisabled();
  await expect(page).toHaveURL(/\/login/);
});
```

**Limited internal validation for state transitions is acceptable:**

```typescript
export class ModalComponent {
  readonly page: Page;
  readonly dialog: Locator;
  readonly confirmButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole('dialog');
    this.confirmButton = this.dialog.getByRole('button', { name: 'Confirm' });
  }

  async confirm() {
    // Internal validation: ensures modal is ready before interaction
    // This prevents flaky tests from race conditions
    await expect(this.dialog).toBeVisible();
    await this.confirmButton.click();
  }

  // But don't assert that confirmation succeeded - let tests decide
}
```

## Anti-Pattern

Page Objects containing assertions that dictate expected outcomes:

```typescript
import { expect, type Locator, type Page } from '@playwright/test';

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

  // BAD: Method assumes successful login
  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();

    // Assertion inside Page Object - assumes success
    await expect(this.page).toHaveURL(/\/dashboard/);
    await expect(this.errorMessage).not.toBeVisible();
  }

  // BAD: Method assumes failed login
  async loginWithInvalidCredentials(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();

    // Hardcoded expectation of failure
    await expect(this.errorMessage).toBeVisible();
    await expect(this.page).toHaveURL(/\/login/);
  }
}
```

Tests become inflexible and unclear:

```typescript
import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login-page';

test('user can login', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();

  // Calls method that ALREADY asserts success
  await loginPage.login('validuser', 'validpassword');

  // What is the test actually verifying? The assertion is hidden.
  // If this fails, the error points to LoginPage, not the test.
});

test('user sees error with invalid credentials', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();

  // Cannot reuse login() - must use different method
  await loginPage.loginWithInvalidCredentials('invalid', 'wrong');

  // Test has no clear assertion - verification is hidden in Page Object
  // Cannot verify specific error message or customize expectations
});

test('user cannot login with empty password', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();

  // Need ANOTHER method for this scenario?
  // Page Object becomes a dumping ground for every variation
  await loginPage.loginWithEmptyPassword('testuser');
});
```

**Problems with this approach:**
- `login()` method cannot be reused for negative test cases
- Test intent is obscured - assertions are hidden inside Page Objects
- Debugging is harder - failures point to Page Object, not test expectation
- Requires creating multiple methods for each outcome (`loginSuccess`, `loginFailure`, etc.)
- Violates Single Responsibility Principle - Page Objects dictate test expectations

## Exceptions

**Internal validation for state transitions is acceptable:**

```typescript
export class MultiStepFormPage {
  readonly page: Page;
  readonly step1: Locator;
  readonly step2: Locator;
  readonly nextButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.step1 = page.locator('#step-1');
    this.step2 = page.locator('#step-2');
    this.nextButton = page.getByRole('button', { name: 'Next' });
  }

  async goToStep2() {
    await this.nextButton.click();

    // Internal validation: ensures step transition completed
    // Prevents false positives from race conditions
    await expect(this.step2).toBeVisible();
  }

  // Tests still assert business expectations separately
}
```

This is acceptable because:
- It validates an internal state transition necessary for subsequent actions
- It prevents flaky tests from clicking before the page is ready
- Tests still assert business logic and final outcomes

**Defensive validation in complex workflows:**

```typescript
export class CheckoutPage {
  async completePayment() {
    await this.paymentButton.click();

    // Wait for payment processing to complete
    await expect(this.loadingSpinner).not.toBeVisible({ timeout: 30000 });

    // Ensures page is ready for next step, but doesn't assert success
  }
}

test('payment processing works', async ({ page }) => {
  const checkout = new CheckoutPage(page);
  await checkout.completePayment();

  // Test asserts the business outcome
  await expect(page).toHaveURL(/\/confirmation/);
  await expect(page.getByText('Payment successful')).toBeVisible();
});
```

## Auto-fix

Not auto-fixable - requires design decisions about which assertions belong in tests vs. internal validation.

**Manual refactoring steps:**

1. Identify assertions in Page Object methods
2. Determine if assertion is internal validation (state transition) or business expectation
3. Move business expectations to test files
4. Keep only defensive state validation in Page Objects
5. Return values or expose locators for test assertions

**Before:**

```typescript
async login(user: string, pass: string) {
  await this.usernameInput.fill(user);
  await this.passwordInput.fill(pass);
  await this.submitButton.click();
  await expect(this.page).toHaveURL(/\/dashboard/); // Remove this
}
```

**After:**

```typescript
async login(user: string, pass: string) {
  await this.usernameInput.fill(user);
  await this.passwordInput.fill(pass);
  await this.submitButton.click();
  // Let tests assert the outcome
}
```

## Related Rules

- [page-object-locators](./page-object-locators.md) - Expose locators for test assertions
- [page-object-actions](./page-object-actions.md) - Actions don't dictate outcomes
- [assert-web-first](./assert-web-first.md) - Use web-first assertions in tests

## References

- [Martin Fowler: Page Object](https://martinfowler.com/bliki/PageObject.html) - "Page objects should not make assertions themselves"
- [Playwright Docs: Page Object Models](https://playwright.dev/docs/pom)
- [Selenium: Page Object Models](https://www.selenium.dev/documentation/test_practices/encouraged/page_object_models/)
- [Medium: Page Object Model Best Practices](https://medium.com/@anandpak108/page-object-model-in-playwright-with-typescript-best-practices-133fb349c462)
