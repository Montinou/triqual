# Rule: Mark Serial Tests Explicitly (Use Sparingly)

> **Category**: Parallelization
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary
Use `test.describe.configure({ mode: 'serial' })` only when tests genuinely depend on each other. Serial mode should be rare—prefer test isolation whenever possible.

## Rationale
Playwright's official documentation strongly advises against serial mode: "Using serial is not recommended. It is usually better to make your tests isolated, so they can be run independently." Serial mode runs tests sequentially, and if one test fails, all subsequent tests in the group are skipped. This creates brittle test suites where one failure cascades into multiple skipped tests, making debugging harder and CI pipelines slower.

However, there are legitimate use cases for serial execution: multi-step wizards with heavy context reuse, stateful onboarding flows, or tests that walk through a complex process where context must be preserved between steps. Use serial mode sparingly and only when the cost of test independence (duplicated setup) exceeds the benefits.

## Best Practice

### Justified Serial Mode: Multi-Step Wizard Flow

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Serial mode justified for wizard with expensive setup
test.describe('Onboarding Wizard', () => {
  test.describe.configure({ mode: 'serial' });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Expensive setup: Create new account with verification
    context = await browser.newContext();
    page = await context.newPage();

    // This setup takes 30+ seconds (email verification, SMS, etc.)
    await createNewAccountWithVerification(page);
  });

  test('step 1: complete profile information', async () => {
    await page.goto('/onboarding/profile');
    await page.fill('[name="firstName"]', 'Test');
    await page.fill('[name="lastName"]', 'User');
    await page.click('button:has-text("Next")');

    await expect(page).toHaveURL('/onboarding/preferences');
  });

  test('step 2: set user preferences', async () => {
    // Depends on step 1 completing successfully
    await expect(page).toHaveURL('/onboarding/preferences');

    await page.check('[name="newsletter"]');
    await page.selectOption('[name="theme"]', 'dark');
    await page.click('button:has-text("Next")');

    await expect(page).toHaveURL('/onboarding/billing');
  });

  test('step 3: configure billing', async () => {
    // Depends on steps 1 and 2
    await expect(page).toHaveURL('/onboarding/billing');

    await page.fill('[name="cardNumber"]', '4242424242424242');
    await page.fill('[name="expiry"]', '12/25');
    await page.fill('[name="cvc"]', '123');
    await page.click('button:has-text("Complete")');

    await expect(page).toHaveURL('/dashboard');
  });

  test.afterAll(async () => {
    await context.close();
  });
});
```

### Prefer Independence: Refactor to Isolated Tests

```typescript
import { test, expect } from '@playwright/test';

// ✅ BETTER: Make tests independent when feasible
test.describe('User Profile', () => {
  // Each test is independent—can run in parallel

  test('can update profile information', async ({ page }) => {
    // Setup: Create user and navigate to final state
    const user = await createTestUser();
    await loginAs(page, user);
    await page.goto('/onboarding/profile');

    await page.fill('[name="firstName"]', 'Test');
    await page.fill('[name="lastName"]', 'User');
    await page.click('button:has-text("Save")');

    await expect(page.locator('.success-message')).toBeVisible();

    await deleteTestUser(user);
  });

  test('can set user preferences', async ({ page }) => {
    // Setup: Create user with completed profile
    const user = await createTestUserWithProfile();
    await loginAs(page, user);
    await page.goto('/preferences');

    await page.check('[name="newsletter"]');
    await page.selectOption('[name="theme"]', 'dark');
    await page.click('button:has-text("Save")');

    await expect(page.locator('.success-message')).toBeVisible();

    await deleteTestUser(user);
  });
});
```

### Use Fixtures Instead of Serial Mode

```typescript
import { test as base, expect } from '@playwright/test';

// ✅ BETTER: Worker fixture replaces serial mode
type WorkerFixtures = {
  onboardedUser: { email: string; sessionState: string };
};

const test = base.extend<{}, WorkerFixtures>({
  onboardedUser: [async ({ browser }, use, workerInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Expensive onboarding happens once per worker
    const email = `user-${workerInfo.workerIndex}@test.com`;
    await completeOnboardingFlow(page, email);

    const sessionPath = `session-worker-${workerInfo.workerIndex}.json`;
    await context.storageState({ path: sessionPath });
    await context.close();

    await use({ email, sessionState: sessionPath });

    // Cleanup after worker completes
    await deleteTestUser(email);
  }, { scope: 'worker' }]
});

// All tests run in parallel, reusing onboarded user
test('can access dashboard', async ({ browser, onboardedUser }) => {
  const context = await browser.newContext({
    storageState: onboardedUser.sessionState
  });
  const page = await context.newPage();

  await page.goto('/dashboard');
  await expect(page.locator('h1')).toHaveText('Dashboard');

  await context.close();
});

test('can update settings', async ({ browser, onboardedUser }) => {
  const context = await browser.newContext({
    storageState: onboardedUser.sessionState
  });
  const page = await context.newPage();

  await page.goto('/settings');
  await page.fill('[name="displayName"]', 'New Name');
  await page.click('button:has-text("Save")');

  await expect(page.locator('.success-toast')).toBeVisible();

  await context.close();
});
```

### Explicit Serial Annotation for Documentation

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Clearly document WHY serial mode is needed
test.describe('Payment Processing Flow', () => {
  test.describe.configure({ mode: 'serial' });

  // JUSTIFICATION: Payment gateway sandbox has rate limits
  // and requires sequential transaction IDs. Each test must
  // complete before the next begins to avoid conflicts.

  test('initialize payment', async ({ page }) => {
    // Test implementation
  });

  test('process payment', async ({ page }) => {
    // Test implementation
  });

  test('confirm payment receipt', async ({ page }) => {
    // Test implementation
  });
});
```

## Anti-Pattern

### Unnecessary Serial Mode

```typescript
// ❌ WRONG: Serial mode used when tests are actually independent
test.describe('User Dashboard', () => {
  test.describe.configure({ mode: 'serial' });

  // These tests don't depend on each other!
  test('displays user name', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.user-name')).toBeVisible();
  });

  test('shows notification count', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.notification-badge')).toHaveText('3');
  });

  test('renders sidebar menu', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});

// ✅ BETTER: Remove serial mode, let tests run in parallel
test.describe('User Dashboard', () => {
  test('displays user name', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.user-name')).toBeVisible();
  });

  test('shows notification count', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.notification-badge')).toHaveText('3');
  });

  test('renders sidebar menu', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});
```

### Serial Mode Hiding Test Fragility

```typescript
// ❌ WRONG: Serial mode masks poorly designed tests
test.describe('E-commerce Checkout', () => {
  test.describe.configure({ mode: 'serial' });

  test('add item to cart', async ({ page }) => {
    await page.goto('/products/123');
    await page.click('button:has-text("Add to Cart")');
  });

  test('proceed to checkout', async ({ page }) => {
    // FRAGILE: Assumes cart state from previous test
    await page.goto('/cart');
    await page.click('button:has-text("Checkout")');
  });

  test('complete payment', async ({ page }) => {
    // FRAGILE: Assumes checkout state from previous tests
    await page.fill('[name="cardNumber"]', '4242424242424242');
    await page.click('button:has-text("Pay")');
  });
});

// ✅ BETTER: Make each test independent with proper setup
test.describe('E-commerce Checkout', () => {
  test('can complete full checkout flow', async ({ page }) => {
    // One test that handles the entire flow
    await page.goto('/products/123');
    await page.click('button:has-text("Add to Cart")');
    await page.goto('/cart');
    await page.click('button:has-text("Checkout")');
    await page.fill('[name="cardNumber"]', '4242424242424242');
    await page.click('button:has-text("Pay")');

    await expect(page.locator('.order-confirmation')).toBeVisible();
  });

  test('can checkout with saved payment method', async ({ page }) => {
    // Independent test with its own setup
    await createCartWithItems(page);
    await page.goto('/checkout');
    await page.click('[data-testid="saved-card-123"]');
    await page.click('button:has-text("Pay")');

    await expect(page.locator('.order-confirmation')).toBeVisible();
  });
});
```

### Serial Mode with Insufficient Cleanup

```typescript
// ❌ WRONG: Serial tests without proper cleanup
test.describe('Admin Panel', () => {
  test.describe.configure({ mode: 'serial' });

  test('create new user', async ({ page }) => {
    await page.goto('/admin/users/new');
    await page.fill('[name="email"]', 'new-user@test.com');
    await page.click('button:has-text("Create")');
    // No cleanup—leaves user in database!
  });

  test('edit user permissions', async ({ page }) => {
    await page.goto('/admin/users');
    await page.click('text=new-user@test.com');
    await page.check('[name="admin"]');
    await page.click('button:has-text("Save")');
    // Modifies user without cleanup!
  });

  test('delete user', async ({ page }) => {
    await page.goto('/admin/users');
    await page.click('text=new-user@test.com');
    await page.click('button:has-text("Delete")');
    // Finally cleanup, but fragile if this test fails!
  });
});
```

## Exceptions

Serial mode is justified when:

1. **Multi-step wizards** with expensive setup (email verification, payment processing)
2. **Stateful onboarding flows** where each step validates the previous step's side effects
3. **Integration tests** against rate-limited third-party APIs requiring sequential execution
4. **Database migration tests** that must run in specific order

## Auto-fix
**NOT auto-fixable**. Requires architectural decisions:
1. Evaluate if tests truly need to run sequentially
2. Consider refactoring to use worker-scoped fixtures instead
3. If serial mode is necessary, add comments explaining why
4. Ensure proper cleanup in `afterAll` hook
5. Monitor test execution time—serial tests slow down CI significantly

## Related Rules
- `parallel-worker-isolation.md` - How to maintain isolation
- `parallel-shared-state.md` - Why shared state is problematic
- `parallel-test-data.md` - Unique data per worker

## References
- [Playwright Parallelism Documentation](https://playwright.dev/docs/test-parallel)
- [How Workers Work in Playwright](https://medium.com/@thananjayan1988/how-playwright-runs-workers-and-test-fixtures-parallel-vs-serial-vs-default-68374a09edd9)
- [Playwright Test API: test.describe.serial](https://playwright.dev/docs/api/class-test)
- [Mastering Parallelism in Playwright](https://www.qable.io/blog/mastering-parallelism-playwright-test-configuration-examples)
