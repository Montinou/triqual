# Rule: Avoid Shared Mutable State

> **Category**: Parallelization
> **Severity**: ERROR
> **Auto-fixable**: NO

## Summary
Tests must not share mutable state across workers. Each test should be self-contained, handling its own setup and teardown without depending on execution order.

## Rationale
Shared mutable state is the most common cause of flaky tests in parallel execution. When one test modifies state that another test depends on, the outcome becomes unpredictable and order-dependent. Playwright's parallel workers run in separate OS processes and cannot communicate—attempting to share state between them violates this architectural guarantee.

Tests that depend on state created by previous tests are antipatterns. A test must not depend on the state left behind by a previous test. Each test should be able to run on its own, in any order.

## Best Practice

### Self-Contained Tests with Independent Setup

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Each test creates its own isolated state
test.describe('Order Management', () => {
  test('can create new order', async ({ page }, testInfo) => {
    // Setup: Create unique test data for THIS test only
    const orderId = `order-${testInfo.workerIndex}-${Date.now()}`;
    const customer = `customer-${testInfo.workerIndex}@test.com`;

    await page.goto('/orders/new');
    await page.fill('[name="customer"]', customer);
    await page.fill('[name="orderId"]', orderId);
    await page.click('button:has-text("Create Order")');

    await expect(page.locator('.order-success')).toBeVisible();

    // Cleanup: Remove state created by THIS test
    await deleteOrder(orderId);
  });

  test('can cancel existing order', async ({ page }, testInfo) => {
    // Setup: Create its OWN order (doesn't depend on previous test)
    const orderId = `order-${testInfo.workerIndex}-${Date.now()}`;
    await createOrder({ orderId, status: 'pending' });

    await page.goto(`/orders/${orderId}`);
    await page.click('button:has-text("Cancel Order")');

    await expect(page.locator('.cancel-confirmation')).toBeVisible();

    // Cleanup
    await deleteOrder(orderId);
  });
});
```

### Use Fixtures for Isolated State Management

```typescript
import { test as base, expect } from '@playwright/test';

// ✅ CORRECT: Worker-scoped fixture provides isolated state
type TestFixtures = {
  authenticatedPage: Page;
  uniqueUser: { email: string; password: string };
};

const test = base.extend<TestFixtures>({
  uniqueUser: async ({}, use, testInfo) => {
    // Create unique user per test
    const user = {
      email: `user-${testInfo.workerIndex}-${testInfo.testId}@test.com`,
      password: 'secure-password-123'
    };

    await createTestUser(user);
    await use(user);
    await deleteTestUser(user.email);
  },

  authenticatedPage: async ({ browser, uniqueUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Login with unique user
    await page.goto('/login');
    await page.fill('[name="email"]', uniqueUser.email);
    await page.fill('[name="password"]', uniqueUser.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');

    await use(page);
    await context.close();
  }
});

test('user can view dashboard', async ({ authenticatedPage }) => {
  // No shared state—authenticatedPage is unique to this test
  await expect(authenticatedPage.locator('h1')).toHaveText('Dashboard');
});

test('user can update settings', async ({ authenticatedPage }) => {
  // Different test, different authenticatedPage, no interference
  await authenticatedPage.goto('/settings');
  await authenticatedPage.fill('[name="theme"]', 'dark');
  await authenticatedPage.click('button:has-text("Save")');

  await expect(authenticatedPage.locator('.success-toast')).toBeVisible();
});
```

### Isolate API State with Unique Identifiers

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: API calls use worker-unique resources
test('API: create and fetch resource', async ({ request }, testInfo) => {
  const resourceId = `resource-${testInfo.workerIndex}-${Date.now()}`;

  // Create resource
  const createResponse = await request.post('/api/resources', {
    data: { id: resourceId, name: 'Test Resource' }
  });
  expect(createResponse.ok()).toBe(true);

  // Fetch same resource
  const getResponse = await request.get(`/api/resources/${resourceId}`);
  expect(getResponse.ok()).toBe(true);

  const data = await getResponse.json();
  expect(data.id).toBe(resourceId);

  // Cleanup
  await request.delete(`/api/resources/${resourceId}`);
});
```

## Anti-Pattern

### Tests Depending on Previous Test State

```typescript
// ❌ WRONG: Tests depend on execution order
let sharedOrderId: string;

test('create order', async ({ page }) => {
  await page.goto('/orders/new');
  await page.fill('[name="customer"]', 'test@example.com');
  await page.click('button:has-text("Create")');

  // Storing state in variable shared across tests
  sharedOrderId = await page.locator('.order-id').textContent();
});

test('view order details', async ({ page }) => {
  // BROKEN: sharedOrderId is undefined if this test runs first
  // or in a different worker
  await page.goto(`/orders/${sharedOrderId}`);
  await expect(page.locator('h1')).toContainText(sharedOrderId);
});

test('cancel order', async ({ page }) => {
  // BROKEN: Depends on order created in first test
  await page.goto(`/orders/${sharedOrderId}`);
  await page.click('button:has-text("Cancel")');
  // This breaks the second test if it runs after!
});
```

### Shared Database Records Across Tests

```typescript
// ❌ WRONG: All tests modify the same database record
test.beforeAll(async () => {
  // Creates ONE record shared by all tests
  await db.insert('users', { id: 1, email: 'test@example.com', status: 'active' });
});

test('deactivate user', async ({ page }) => {
  await page.goto('/users/1');
  await page.click('button:has-text("Deactivate")');
  // Changes shared record!
});

test('verify user is active', async ({ page }) => {
  await page.goto('/users/1');
  const status = await page.locator('.user-status').textContent();
  // FLAKY: status might be 'inactive' if deactivate test ran first!
  expect(status).toBe('active');
});
```

### Global Configuration Modified by Tests

```typescript
// ❌ WRONG: Tests modify global configuration
test('enable feature flag', async ({ page }) => {
  await page.goto('/admin/features');
  await page.check('input[name="experimental-feature"]');
  await page.click('button:has-text("Save")');
  // This affects ALL subsequent tests!
});

test('test without experimental feature', async ({ page }) => {
  await page.goto('/dashboard');
  // BROKEN: Experimental feature might be enabled by previous test
  await expect(page.locator('.experimental-banner')).not.toBeVisible();
});
```

### Shared File System State

```typescript
// ❌ WRONG: Tests share and modify the same file
const CONFIG_FILE = './test-config.json';

test('update config', async ({ page }) => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ theme: 'dark' }));

  await page.goto('/settings');
  // RACE: Another worker might read/write this file simultaneously
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  expect(config.theme).toBe('dark');
});

test('read config', async ({ page }) => {
  // FLAKY: Config file might be modified by parallel test
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  await page.goto('/settings');
  // Unpredictable state!
});
```

## Exceptions

1. **Read-only shared resources** that are never modified during test execution (static fixtures, seed data)
2. **Worker-scoped fixtures** that provide isolated state per worker
3. **Intentionally serial tests** marked with `test.describe.configure({ mode: 'serial' })` (use sparingly)

## Auto-fix
**NOT auto-fixable**. Requires refactoring test architecture:
1. Identify all shared mutable state (variables, database records, files, API resources)
2. Convert to test-scoped or worker-scoped setup/teardown
3. Use `testInfo.workerIndex` and `testInfo.testId` for unique identifiers
4. Move shared state to fixtures with proper lifecycle management
5. Consider using `test.beforeEach` instead of `test.beforeAll` for isolation

## Related Rules
- `parallel-worker-isolation.md` - Ensure worker isolation
- `parallel-test-data.md` - Use unique test data per worker
- `parallel-serial-when-needed.md` - When serial execution is justified

## References
- [Playwright Parallelism Documentation](https://playwright.dev/docs/test-parallel)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [How to Avoid Flaky Tests](https://medium.com/@samuel.sperling/say-goodbye-to-flaky-tests-playwright-best-practices-every-test-automation-engineer-must-know-9dfeb9bb5017)
- [Parallel Testing: Avoid Collisions](https://medium.com/@juanpromanzio/parallel-testing-with-playwright-how-to-avoid-collisions-and-failures-dc89651fc92e)
- [Checkly: Testing in Parallel](https://www.checklyhq.com/docs/learn/playwright/testing-in-parallel/)
