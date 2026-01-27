# Rule: Test Fixtures

> **Category**: Test Organization
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Leverage Playwright fixtures to encapsulate reusable setup and teardown logic, ensuring test isolation and reducing code duplication.

## Rationale

Fixtures provide significant advantages over traditional beforeEach/afterEach hooks:

- **Encapsulation**: Setup and teardown logic resides in one location
- **Reusability**: Define once, use across multiple test files
- **On-demand execution**: Only required fixtures run; unused ones don't consume resources
- **Composability**: Fixtures can depend on other fixtures for complex behaviors
- **Lazy initialization**: Fixtures execute only when tests actually use them
- **Type safety**: TypeScript provides autocomplete and type checking for custom fixtures

Playwright's official documentation states: "Fixtures have a number of advantages over before/after hooks. If you have an after hook that tears down what was created in a before hook, consider turning them into a fixture."

## Best Practice

Create custom fixtures for reusable test components:

```typescript
import { test as base, expect } from '@playwright/test';

// Define fixture types
type MyFixtures = {
  authenticatedPage: Page;
  todoPage: TodoPage;
};

// Extend base test with custom fixtures
export const test = base.extend<MyFixtures>({
  // Test-scoped fixture - runs for each test
  authenticatedPage: async ({ page }, use) => {
    // Setup: authenticate user
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'Test123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');

    // Provide fixture to test
    await use(page);

    // Teardown: cleanup happens automatically
    await page.context().clearCookies();
  },

  // Fixture that depends on another fixture
  todoPage: async ({ authenticatedPage }, use) => {
    const todoPage = new TodoPage(authenticatedPage);
    await todoPage.goto();
    await todoPage.addTodo('Sample task');

    // Provide fixture to test
    await use(todoPage);

    // Teardown: clean up todos
    await todoPage.removeAll();
  },
});

// Use fixtures in tests
test('should complete todo', async ({ todoPage }) => {
  await todoPage.check('Sample task');
  await expect(todoPage.getCompletedCount()).toBe(1);
});

test('should delete todo', async ({ todoPage }) => {
  // Each test gets fresh todoPage with one todo
  await todoPage.remove('Sample task');
  await expect(todoPage.getTodoCount()).toBe(0);
});
```

## Anti-Pattern

Duplicating setup logic across tests instead of using fixtures:

```typescript
// Bad - repeated setup code in every test
import { test, expect } from '@playwright/test';

test('test 1', async ({ page }) => {
  // Duplicated authentication code
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'Test123!');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/dashboard');

  // Actual test logic
  await page.click('[data-testid="profile"]');
});

test('test 2', async ({ page }) => {
  // DUPLICATED authentication code - maintenance nightmare
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'Test123!');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/dashboard');

  // Actual test logic
  await page.click('[data-testid="settings"]');
});

// No cleanup - state may leak between tests
```

## Exceptions

**Use hooks for simple, file-specific setup**:
```typescript
// Acceptable - simple setup that's only used in this file
test.beforeEach(async ({ page }) => {
  await page.goto('/about');
});

test('should display company info', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('About Us');
});
```

**Use worker-scoped fixtures for expensive operations**:
```typescript
// Worker-scoped fixture - runs once per worker process
type WorkerFixtures = {
  mockServer: MockServer;
};

export const test = base.extend<{}, WorkerFixtures>({
  mockServer: [async ({}, use) => {
    const server = await startMockServer();
    await use(server);
    await server.stop();
  }, { scope: 'worker' }],
});
```

**Use automatic fixtures for global behavior**:
```typescript
// Automatic fixture - runs for every test automatically
export const test = base.extend({
  autoScreenshot: [async ({ page }, use, testInfo) => {
    await use();
    if (testInfo.status !== 'passed') {
      await page.screenshot({ path: `failure-${testInfo.title}.png` });
    }
  }, { auto: true }],
});
```

## Auto-fix

This rule is NOT auto-fixable. Refactoring patterns:

**Before - using hooks**:
```typescript
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.click('button[type="submit"]');
});

test.afterEach(async ({ page }) => {
  await page.context().clearCookies();
});

test('my test', async ({ page }) => {
  // test logic
});
```

**After - using fixtures**:
```typescript
const test = base.extend({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.click('button[type="submit"]');

    await use(page);

    await page.context().clearCookies();
  },
});

test('my test', async ({ authenticatedPage }) => {
  // test logic - cleanup happens automatically
});
```

## Related Rules

- [test-isolation.md](./test-isolation.md) - Fixtures ensure proper isolation
- [test-hooks.md](./test-hooks.md) - When to use hooks vs fixtures
- [test-describe-grouping.md](./test-describe-grouping.md) - Organizing tests using fixtures

## References

- [Playwright Docs: Test Fixtures](https://playwright.dev/docs/test-fixtures)
- [Checkly: Reuse Code with Custom Test Fixtures](https://www.checklyhq.com/docs/learn/playwright/test-fixtures/)
- [Medium: Playwright Test Fixtures Explained](https://medium.com/@testrig/playwright-test-fixtures-explained-customizing-test-lifecycle-34dd9a6278b3)
- [SKPTRICKS: Add Global Hooks Using Automatic Fixtures](https://www.skptricks.com/2025/05/add-global-beforeeach-aftereach-hooks-using-playwright-auto-fixtures.html)
