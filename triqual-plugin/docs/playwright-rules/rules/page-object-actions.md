# Rule: Encapsulate Actions in Page Object Methods

> **Category**: Page Objects
> **Severity**: INFO
> **Auto-fixable**: YES

## Summary

Encapsulate page interactions into semantic methods within Page Objects rather than exposing raw locators to tests.

## Rationale

Page Object methods should represent user intentions and business actions, not technical implementation details. By hiding the sequence of low-level operations (fill, click, select) behind meaningful method names, tests become self-documenting and express *what* the user is doing rather than *how* they're doing it.

This abstraction layer makes tests resilient to UI changes. If a login flow changes from username/password to OAuth, you only update the `login()` method implementation - all tests continue to work without modification. Tests focus on business logic while Page Objects handle the mechanics.

## Best Practice

Create methods that represent complete user actions, hiding implementation details:

```typescript
import { expect, type Locator, type Page } from '@playwright/test';

export class CheckoutPage {
  readonly page: Page;
  readonly shippingAddressInput: Locator;
  readonly shippingCityInput: Locator;
  readonly shippingZipInput: Locator;
  readonly paymentMethodSelect: Locator;
  readonly cardNumberInput: Locator;
  readonly placeOrderButton: Locator;
  readonly orderConfirmation: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shippingAddressInput = page.getByLabel('Street Address');
    this.shippingCityInput = page.getByLabel('City');
    this.shippingZipInput = page.getByLabel('ZIP Code');
    this.paymentMethodSelect = page.getByLabel('Payment Method');
    this.cardNumberInput = page.getByLabel('Card Number');
    this.placeOrderButton = page.getByRole('button', { name: 'Place Order' });
    this.orderConfirmation = page.getByRole('heading', { name: /order confirmed/i });
  }

  async goto() {
    await this.page.goto('/checkout');
  }

  async fillShippingAddress(address: string, city: string, zip: string) {
    await this.shippingAddressInput.fill(address);
    await this.shippingCityInput.fill(city);
    await this.shippingZipInput.fill(zip);
  }

  async selectPaymentMethod(method: 'credit-card' | 'paypal' | 'bank-transfer') {
    await this.paymentMethodSelect.selectOption(method);
  }

  async enterCreditCard(cardNumber: string) {
    await this.cardNumberInput.fill(cardNumber);
  }

  async completeCheckout() {
    await this.placeOrderButton.click();
    await expect(this.orderConfirmation).toBeVisible();
  }

  // High-level method combining multiple actions
  async checkoutWithCreditCard(
    address: string,
    city: string,
    zip: string,
    cardNumber: string
  ) {
    await this.fillShippingAddress(address, city, zip);
    await this.selectPaymentMethod('credit-card');
    await this.enterCreditCard(cardNumber);
    await this.completeCheckout();
  }
}
```

Usage in test focuses on intent, not mechanics:

```typescript
import { test, expect } from '@playwright/test';
import { CheckoutPage } from './pages/checkout-page';

test('user can complete checkout with credit card', async ({ page }) => {
  const checkoutPage = new CheckoutPage(page);
  await checkoutPage.goto();

  // High-level, business-focused test code
  await checkoutPage.checkoutWithCreditCard(
    '123 Main St',
    'San Francisco',
    '94102',
    '4111111111111111'
  );

  await expect(page).toHaveURL(/\/order-confirmation/);
});

test('user can split shipping and payment steps', async ({ page }) => {
  const checkoutPage = new CheckoutPage(page);
  await checkoutPage.goto();

  // Tests can also use granular methods
  await checkoutPage.fillShippingAddress('456 Oak Ave', 'Portland', '97201');
  await checkoutPage.selectPaymentMethod('paypal');
  await checkoutPage.completeCheckout();

  await expect(page).toHaveURL(/\/order-confirmation/);
});
```

## Anti-Pattern

Exposing raw locators and forcing tests to orchestrate low-level actions:

```typescript
import { type Locator, type Page } from '@playwright/test';

export class CheckoutPage {
  readonly page: Page;
  readonly shippingAddressInput: Locator;
  readonly shippingCityInput: Locator;
  readonly shippingZipInput: Locator;
  readonly placeOrderButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shippingAddressInput = page.getByLabel('Street Address');
    this.shippingCityInput = page.getByLabel('City');
    this.shippingZipInput = page.getByLabel('ZIP Code');
    this.placeOrderButton = page.getByRole('button', { name: 'Place Order' });
  }

  async goto() {
    await this.page.goto('/checkout');
  }

  // No encapsulation - just exposing locators
}
```

Test becomes cluttered with implementation details:

```typescript
import { test, expect } from '@playwright/test';
import { CheckoutPage } from './pages/checkout-page';

test('user can complete checkout', async ({ page }) => {
  const checkoutPage = new CheckoutPage(page);
  await checkoutPage.goto();

  // Test is forced to know every field and interaction
  await checkoutPage.shippingAddressInput.fill('123 Main St');
  await checkoutPage.shippingCityInput.fill('San Francisco');
  await checkoutPage.shippingZipInput.fill('94102');

  // If checkout flow changes, ALL tests must be updated
  await page.getByLabel('Payment Method').selectOption('credit-card');
  await page.getByLabel('Card Number').fill('4111111111111111');
  await page.getByLabel('CVV').fill('123');
  await page.getByLabel('Expiration').fill('12/25');

  await checkoutPage.placeOrderButton.click();

  await expect(page).toHaveURL(/\/order-confirmation/);
});
```

**Problems with this approach:**
- Tests are tightly coupled to UI structure
- Every test must know the exact sequence of form fills
- Adding a required field forces updates across all test files
- Tests are verbose and obscure business intent
- No reusability of common workflows

## Exceptions

Simple navigation or verification where encapsulation adds no value:

```typescript
export class HeaderComponent {
  readonly page: Page;
  readonly logo: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByRole('img', { name: 'Company Logo' });
  }

  // Sometimes direct locator access is fine for simple checks
}

test('header displays logo', async ({ page }) => {
  const header = new HeaderComponent(page);
  await expect(header.logo).toBeVisible();
});
```

For single-property assertions, creating a method like `isLogoVisible()` may be overkill.

## Auto-fix

Transform direct locator usage into encapsulated methods:

**Before:**

```typescript
// pages/search-page.ts
export class SearchPage {
  readonly searchInput: Locator;
  readonly searchButton: Locator;

  constructor(page: Page) {
    this.searchInput = page.getByPlaceholder('Search...');
    this.searchButton = page.getByRole('button', { name: 'Search' });
  }
}

// test.spec.ts
const searchPage = new SearchPage(page);
await searchPage.searchInput.fill('playwright');
await searchPage.searchButton.click();
```

**After (auto-fixed):**

```typescript
// pages/search-page.ts
export class SearchPage {
  readonly searchInput: Locator;
  readonly searchButton: Locator;

  constructor(page: Page) {
    this.searchInput = page.getByPlaceholder('Search...');
    this.searchButton = page.getByRole('button', { name: 'Search' });
  }

  async search(query: string) {
    await this.searchInput.fill(query);
    await this.searchButton.click();
  }
}

// test.spec.ts
const searchPage = new SearchPage(page);
await searchPage.search('playwright');
```

## Related Rules

- [page-object-locators](./page-object-locators.md) - Store locators these methods use
- [page-object-composition](./page-object-composition.md) - Combine Page Objects in methods
- [page-object-no-assertions](./page-object-no-assertions.md) - Keep assertions in tests

## References

- [Playwright Docs: Page Object Models](https://playwright.dev/docs/pom)
- [Martin Fowler: Page Object](https://martinfowler.com/bliki/PageObject.html)
- [Selenium: Page Object Models](https://www.selenium.dev/documentation/test_practices/encouraged/page_object_models/)
- [Medium: Mastering Playwright with Page Object Model](https://medium.com/@lucgagan/mastering-playwright-best-practices-for-web-automation-with-the-page-object-model-3541412b03d1)
