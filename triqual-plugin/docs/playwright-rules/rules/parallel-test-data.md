# Rule: Use Unique Test Data Per Worker

> **Category**: Parallelization
> **Severity**: WARNING
> **Auto-fixable**: NO

## Summary
Each parallel worker must use unique test data (users, records, files) to avoid data collisions and ensure test independence.

## Rationale
When multiple workers run tests simultaneously against shared resources (databases, APIs, file systems), they can create race conditions and data conflicts. Two workers trying to use the same test user account may clash sessions. If tests write to the same database record, results become unpredictable.

Parallel tests often need unique data to avoid collisions like unique users, database rows, or environment variables. Using `testInfo.workerIndex` provides a reliable way to isolate resources per worker, preventing interference between parallel test executions.

## Best Practice

### Use Worker Index for Unique User Data

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Each worker gets its own test user
test.describe('User Authentication', () => {
  let testUser: { email: string; password: string };

  test.beforeEach(async ({}, testInfo) => {
    // Create unique user per worker
    testUser = {
      email: `user-worker-${testInfo.workerIndex}@test.com`,
      password: 'secure-pass-123'
    };

    // Initialize user in database
    await createTestUser(testUser);
  });

  test('login with valid credentials', async ({ page }, testInfo) => {
    await page.goto('/login');
    await page.fill('[name="email"]', testUser.email);
    await page.fill('[name="password"]', testUser.password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/dashboard');
  });

  test('logout successfully', async ({ page }, testInfo) => {
    // Each worker uses its own testUser, no conflicts
    await page.goto('/login');
    await page.fill('[name="email"]', testUser.email);
    await page.fill('[name="password"]', testUser.password);
    await page.click('button[type="submit"]');

    await page.click('[data-testid="logout-button"]');
    await expect(page).toHaveURL('/login');
  });

  test.afterEach(async ({}, testInfo) => {
    // Clean up worker-specific user
    await deleteTestUser(testUser.email);
  });
});
```

### Worker-Scoped Fixture for Test Data

```typescript
import { test as base, expect } from '@playwright/test';

// ✅ CORRECT: Worker fixture provides isolated test data
type WorkerFixtures = {
  workerStorageState: string;
  testAccount: { username: string; apiKey: string };
};

const test = base.extend<{}, WorkerFixtures>({
  // Worker-scoped fixture: created once per worker
  testAccount: [async ({}, use, workerInfo) => {
    const account = {
      username: `test-account-${workerInfo.workerIndex}`,
      apiKey: `api-key-${workerInfo.workerIndex}-${Date.now()}`
    };

    // Setup: Create account in test database
    await createTestAccount(account);

    await use(account);

    // Teardown: Clean up after all worker tests complete
    await deleteTestAccount(account.username);
  }, { scope: 'worker' }],

  workerStorageState: [async ({ browser, testAccount }, use, workerInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Login and save auth state
    await page.goto('/login');
    await page.fill('[name="username"]', testAccount.username);
    await page.fill('[name="apiKey"]', testAccount.apiKey);
    await page.click('button[type="submit"]');

    const storageStatePath = `storage-state-worker-${workerInfo.workerIndex}.json`;
    await context.storageState({ path: storageStatePath });
    await context.close();

    await use(storageStatePath);
  }, { scope: 'worker' }]
});

test.use({ storageState: ({ workerStorageState }) => workerStorageState });

test('access protected resource', async ({ page, testAccount }) => {
  // Each worker has its own authenticated session
  await page.goto('/api/resources');
  await expect(page.locator('h1')).toHaveText(`Welcome ${testAccount.username}`);
});
```

### Unique Test Data with Timestamps

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Combine workerIndex + timestamp for uniqueness
test('create order with unique data', async ({ page }, testInfo) => {
  const orderId = `order-${testInfo.workerIndex}-${Date.now()}`;
  const customerId = `customer-${testInfo.workerIndex}-${testInfo.testId}`;

  await page.goto('/orders/new');
  await page.fill('[name="orderId"]', orderId);
  await page.fill('[name="customerId"]', customerId);
  await page.fill('[name="amount"]', '100.00');
  await page.click('button:has-text("Create Order")');

  await expect(page.locator('.order-confirmation')).toContainText(orderId);

  // Cleanup: Remove order with unique ID
  await deleteOrder(orderId);
});
```

### API Testing with Unique Resources

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Each worker creates unique API resources
test.describe('API Resource Management', () => {
  test('CRUD operations on resource', async ({ request }, testInfo) => {
    const resourceId = `resource-w${testInfo.workerIndex}-${Date.now()}`;

    // CREATE
    const createResp = await request.post('/api/v1/resources', {
      data: {
        id: resourceId,
        name: `Test Resource ${testInfo.workerIndex}`,
        owner: `worker-${testInfo.workerIndex}`
      }
    });
    expect(createResp.ok()).toBe(true);

    // READ
    const getResp = await request.get(`/api/v1/resources/${resourceId}`);
    expect(getResp.ok()).toBe(true);
    const data = await getResp.json();
    expect(data.id).toBe(resourceId);

    // UPDATE
    const updateResp = await request.patch(`/api/v1/resources/${resourceId}`, {
      data: { name: 'Updated Resource' }
    });
    expect(updateResp.ok()).toBe(true);

    // DELETE
    const deleteResp = await request.delete(`/api/v1/resources/${resourceId}`);
    expect(deleteResp.ok()).toBe(true);
  });
});
```

### File System Isolation with Worker Directories

```typescript
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// ✅ CORRECT: Each worker uses its own directory
test('download and process file', async ({ page }, testInfo) => {
  const workerDir = path.join(__dirname, `downloads-worker-${testInfo.workerIndex}`);
  fs.mkdirSync(workerDir, { recursive: true });

  const context = await page.context();
  await context.setDownloadDirectory(workerDir);

  await page.goto('/reports');
  const downloadPromise = page.waitForEvent('download');
  await page.click('button:has-text("Download Report")');
  const download = await downloadPromise;

  const filePath = path.join(workerDir, `report-${Date.now()}.pdf`);
  await download.saveAs(filePath);

  expect(fs.existsSync(filePath)).toBe(true);

  // Cleanup worker directory
  fs.rmSync(workerDir, { recursive: true, force: true });
});
```

## Anti-Pattern

### Shared Test User Across All Workers

```typescript
// ❌ WRONG: All workers share the same test user
const TEST_USER = {
  email: 'test@example.com',
  password: 'password123'
};

test('login test', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', TEST_USER.email);
  await page.fill('[name="password"]', TEST_USER.password);
  await page.click('button[type="submit"]');

  // RACE: Multiple workers logging in simultaneously
  // can cause session conflicts, rate limiting, or flaky failures
  await expect(page).toHaveURL('/dashboard');
});
```

### Hardcoded Database Records

```typescript
// ❌ WRONG: All tests use the same database record
test('update user profile', async ({ page }) => {
  // User ID 1 is shared across all workers
  await page.goto('/users/1/profile');
  await page.fill('[name="bio"]', 'Updated bio');
  await page.click('button:has-text("Save")');

  // RACE: Worker 2 might be reading user 1's profile simultaneously
  await expect(page.locator('.success-message')).toBeVisible();
});

test('delete user', async ({ page }) => {
  // BROKEN: Another worker might have already deleted user 1
  await page.goto('/users/1');
  await page.click('button:has-text("Delete User")');
  // Intermittent 404 errors!
});
```

### Shared API Tokens Without Rotation

```typescript
// ❌ WRONG: All workers use same API token
const API_TOKEN = 'test-token-12345';

test('API call with authentication', async ({ request }) => {
  const response = await request.get('/api/user/profile', {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });

  // FLAKY: Rate limiting or concurrent request limits
  // can cause random failures when all workers use same token
  expect(response.ok()).toBe(true);
});
```

### Shared File Names Without Worker Isolation

```typescript
// ❌ WRONG: All workers write to the same file
test('export data', async ({ page }) => {
  await page.goto('/export');
  const downloadPromise = page.waitForEvent('download');
  await page.click('button:has-text("Export")');
  const download = await downloadPromise;

  // RACE: Multiple workers overwrite each other's downloads!
  await download.saveAs('./test-results/export.csv');

  const fileContent = fs.readFileSync('./test-results/export.csv', 'utf-8');
  // UNPREDICTABLE: Content might be from a different worker's test
  expect(fileContent).toContain('expected-data');
});
```

## Exceptions

1. **Read-only seed data** that's loaded once and never modified during tests
2. **Isolated test environments** where each worker connects to a separate database instance
3. **Mock servers** that handle concurrent requests with isolated state per request

## Auto-fix
**NOT auto-fixable**. Requires manual refactoring:
1. Identify all hardcoded test data (emails, IDs, usernames, file paths)
2. Replace with dynamic generation using `testInfo.workerIndex`
3. Add proper cleanup in `afterEach`/`afterAll` hooks
4. Consider worker-scoped fixtures for reusable test data
5. Use timestamps or UUIDs for additional uniqueness when needed

## Related Rules
- `parallel-worker-isolation.md` - Ensure complete worker isolation
- `parallel-shared-state.md` - Avoid shared mutable state
- `parallel-serial-when-needed.md` - When to disable parallelization

## References
- [Playwright Parallelism Documentation](https://playwright.dev/docs/test-parallel)
- [Mastering Parallelism in Playwright](https://www.qable.io/blog/mastering-parallelism-playwright-test-configuration-examples)
- [How Workers Work in Playwright](https://medium.com/@abikeie09/how-workers-work-in-playwright-during-parallel-testing-overview-playwright-uses-a-worker-process-b03d441de38c)
- [BrowserStack: Parallel Test Guide](https://www.browserstack.com/guide/playwright-parallel-test)
