# Rule: Ensure Complete Worker Isolation

> **Category**: Parallelization
> **Severity**: ERROR
> **Auto-fixable**: NO

## Summary
Each Playwright worker must operate in complete isolation with its own browser context, storage state, and test data to prevent cross-test contamination and flaky failures.

## Rationale
Playwright uses separate OS processes for workers, ensuring tests cannot interfere with each other. However, developers can break this isolation by sharing external resources (databases, files, APIs) or assuming sequential execution order. When workers share mutable state, one test's side effects can cause another test to fail intermittently—the #1 cause of flaky parallel tests.

By design, workers don't communicate with each other. One test cannot access the cookies, local storage, or state of another test running in a different worker. This architectural guarantee only holds if tests avoid shared external resources.

## Best Practice

### Use Worker Index for Resource Isolation

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Each worker gets unique test data
test.describe('User Management', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // Use workerIndex to create unique test user
    const userName = `test-user-${testInfo.workerIndex}`;
    const userEmail = `user-${testInfo.workerIndex}@test.com`;

    // Initialize unique user in database
    await setupTestUser({ userName, userEmail });

    // Each worker has its own isolated data
    await page.goto('/login');
    await page.fill('[name="email"]', userEmail);
    await page.fill('[name="password"]', 'test-password');
    await page.click('button[type="submit"]');
  });

  test('can update profile', async ({ page }, testInfo) => {
    const userName = `test-user-${testInfo.workerIndex}`;
    await page.goto('/profile');
    await page.fill('[name="bio"]', `Bio for ${userName}`);
    await page.click('button:has-text("Save")');

    await expect(page.locator('.success-message')).toBeVisible();
  });

  test.afterEach(async ({}, testInfo) => {
    // Clean up worker-specific data
    const userName = `test-user-${testInfo.workerIndex}`;
    await cleanupTestUser(userName);
  });
});
```

### Isolate Browser Storage

```typescript
import { test, expect } from '@playwright/test';

// ✅ CORRECT: Fresh context per test
test('shopping cart isolation', async ({ browser }, testInfo) => {
  // Create isolated browser context
  const context = await browser.newContext({
    storageState: undefined, // No shared storage
  });

  const page = await context.newPage();

  await page.goto('/shop');
  await page.click('[data-testid="add-to-cart"]');

  const cartCount = await page.locator('[data-testid="cart-count"]').textContent();
  expect(cartCount).toBe('1');

  await context.close();
});
```

### Isolate File System Access

```typescript
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// ✅ CORRECT: Worker-specific temp directories
test('file upload', async ({ page }, testInfo) => {
  // Create worker-specific temp directory
  const tempDir = path.join(__dirname, `temp-worker-${testInfo.workerIndex}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const testFile = path.join(tempDir, 'upload.txt');
  fs.writeFileSync(testFile, 'test content');

  await page.goto('/upload');
  await page.setInputFiles('input[type="file"]', testFile);
  await page.click('button:has-text("Upload")');

  await expect(page.locator('.upload-success')).toBeVisible();

  // Cleanup worker-specific files
  fs.rmSync(tempDir, { recursive: true });
});
```

## Anti-Pattern

### Shared Database State Without Isolation

```typescript
// ❌ WRONG: All workers share same test user
test.beforeEach(async ({ page }) => {
  // This user is shared across ALL workers!
  await setupTestUser({ userName: 'test-user', email: 'test@example.com' });

  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'password');
  await page.click('button[type="submit"]');
});

test('update profile', async ({ page }) => {
  // Worker 1 might update profile while Worker 2 is reading it
  await page.goto('/profile');
  await page.fill('[name="bio"]', 'Updated bio');
  await page.click('button:has-text("Save")');
  // FLAKY: Worker 2's test might see this change!
});

test('check profile display', async ({ page }) => {
  await page.goto('/profile');
  const bio = await page.locator('[name="bio"]').inputValue();
  // FLAKY: Might see 'Updated bio' from Worker 1!
  expect(bio).toBe('');
});
```

### Global Variables Across Tests

```typescript
// ❌ WRONG: Shared mutable state
let sharedAuthToken: string;

test('login and store token', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'password');
  await page.click('button[type="submit"]');

  // This won't work—workers are separate processes!
  sharedAuthToken = await page.evaluate(() => localStorage.getItem('authToken'));
});

test('use stored token', async ({ page }) => {
  // BROKEN: sharedAuthToken is undefined in this worker
  await page.goto('/dashboard', {
    headers: { Authorization: `Bearer ${sharedAuthToken}` }
  });
});
```

### Shared File System Without Worker Isolation

```typescript
// ❌ WRONG: All workers write to same file
test('generate report', async ({ page }) => {
  await page.goto('/reports');
  const download = await page.waitForEvent('download');

  // RACE CONDITION: Multiple workers overwrite same file!
  await download.saveAs('./test-results/report.pdf');

  // Next test expects this file to exist unchanged
  expect(fs.existsSync('./test-results/report.pdf')).toBe(true);
});
```

## Exceptions

1. **Read-only shared resources** are safe (static config files, seed data that's never modified)
2. **Worker-scoped fixtures** that use `workerIndex` for isolation
3. **Truly stateless APIs** that don't persist data between calls

## Auto-fix
**NOT auto-fixable**. Requires architectural changes:
1. Identify shared resources (database records, files, API state)
2. Refactor to use `testInfo.workerIndex` for unique identifiers
3. Ensure cleanup happens in `afterEach`/`afterAll` with worker context
4. Consider using `test.describe.configure({ mode: 'parallel' })` explicitly to enforce parallelism

## Related Rules
- `parallel-shared-state.md` - Avoid shared mutable state
- `parallel-test-data.md` - Use unique test data per worker
- `parallel-serial-when-needed.md` - When to break isolation intentionally

## References
- [Playwright Parallelism Documentation](https://playwright.dev/docs/test-parallel)
- [How Workers Work in Playwright](https://medium.com/@abikeie09/how-workers-work-in-playwright-during-parallel-testing-overview-playwright-uses-a-worker-process-b03d441de38c)
- [Mastering Playwright Parallel Testing](https://momentic.ai/resources/mastering-playwright-parallel-testing-for-blazing-fast-ci-runs)
- [Parallel Testing: Avoid Collisions and Failures](https://medium.com/@juanpromanzio/parallel-testing-with-playwright-how-to-avoid-collisions-and-failures-dc89651fc92e)
