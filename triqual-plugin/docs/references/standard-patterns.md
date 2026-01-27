# Standard Patterns

Core patterns for writing reliable Playwright tests with Triqual.

## Test Structure

Follow the **Arrange-Act-Assert** pattern:

```typescript
test('user can login', async ({ page }) => {
  // Arrange - Set up the test data and navigate
  await page.goto('/login');

  // Act - Perform the action
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Assert - Verify the outcome
  await expect(page.getByText('Welcome back')).toBeVisible();
});
```

## Locator Priority

Use locators in this order of preference:

1. **Role-based**: `getByRole('button', { name: 'Submit' })`
2. **Test ID**: `getByTestId('submit-button')`
3. **Label**: `getByLabel('Email')`
4. **Text**: `getByText('Submit')`
5. **CSS** (last resort): `locator('.submit-btn')`

## Wait Strategies

Always prefer Playwright's auto-waiting over manual waits:

```typescript
// Good - auto-waits for element
await page.getByRole('button').click();

// Avoid - manual wait
await page.waitForTimeout(1000);
await page.click('.button');
```

## Page Objects

Encapsulate page interactions in Page Object classes:

```typescript
class LoginPage {
  constructor(private page: Page) {}

  async login(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}
```
