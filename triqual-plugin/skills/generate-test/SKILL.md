---
name: generate-test
description: Create permanent Playwright test files from exploration or description. Use when user says "create a test for this", "make this a permanent test", "generate a spec file".
argument-hint: [feature-name]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Generate Test - Create Production Test Files

Convert quick-test explorations or feature descriptions into proper, production-ready Playwright test files.

## When to Use

- After using `/quick-test` to explore a feature
- When you have a feature description to test
- When converting ad-hoc testing into permanent tests
- When creating regression tests for bugs

## Quick Start

```bash
/generate-test                    # Interactive - asks what to test
/generate-test login              # Generate tests for login feature
/generate-test checkout --from-quick-test  # Convert last quick-test
```

## Workflow

### Step 1: Gather Context

**Option A: From Quick-Test Exploration**

If recently ran `/quick-test`, extract:
- Target URL used
- Actions performed
- Assertions made
- Screenshots captured

**Option B: From Description**

Ask user for:
- Feature to test
- Expected behaviors
- Test data requirements

### Step 2: Search Quoth for Patterns

**MANDATORY per project rules.**

```
mcp__quoth__quoth_search_index({
  query: "playwright test {feature} pattern"
})
```

Discover:
- Existing Page Objects
- Helper functions
- Assertion patterns
- Naming conventions

### Step 3: Determine File Location

Find the correct test directory:

```bash
ls automation/playwright/tests/
```

Map feature to directory:

| Feature | Directory |
|---------|-----------|
| auth, login, signup | `auth/` |
| dashboard, home | `dashboard/` |
| settings, profile | `settings/` |
| checkout, payment | `checkout/` |
| api endpoints | `api/` |

If directory doesn't exist, create it.

### Step 4: Generate Test File

**Naming convention**: `{feature-name}.spec.ts`

**Template**:

```typescript
// automation/playwright/tests/{feature}/{feature-name}.spec.ts

import { test, expect } from '@playwright/test';
// Import existing Page Objects from Step 2
import { FeaturePage } from '../pages/{feature}.page';
import { getTimeout } from '../helpers/timeout';

test.describe('{Feature Name}', () => {
  let featurePage: FeaturePage;

  test.beforeEach(async ({ page }) => {
    featurePage = new FeaturePage(page);
    await featurePage.goto();
  });

  test('should {expected behavior}', async ({ page }) => {
    // Arrange
    // ...setup

    // Act
    // ...actions

    // Assert
    await expect(/* element */).toBeVisible();
  });

  test('should {another behavior}', async ({ page }) => {
    // ...
  });
});
```

### Step 5: Create Page Object (If Needed)

**Only create if one doesn't exist** (verify in Step 2).

**Template**:

```typescript
// automation/playwright/tests/pages/{feature}.page.ts

import { Page, Locator } from '@playwright/test';

export class FeaturePage {
  readonly page: Page;
  readonly someElement: Locator;
  readonly anotherElement: Locator;

  constructor(page: Page) {
    this.page = page;
    this.someElement = page.locator('[data-testid="some-element"]');
    this.anotherElement = page.locator('.another-element:visible');
  }

  async goto() {
    await this.page.goto('/feature-path');
  }

  async performAction() {
    await this.someElement.click();
  }
}
```

### Step 6: Run and Verify

```bash
npx playwright test {test-file} --reporter=list
```

If tests fail, apply quick fixes:

| Error | Fix |
|-------|-----|
| Locator not found | Add `:visible` or improve selector |
| Timeout | Use `getTimeout()` |
| Multiple elements | Add `.first()` or `:visible` |

### Step 7: Report Success

```markdown
## Test File Generated

**File**: `automation/playwright/tests/{feature}/{feature-name}.spec.ts`

**Tests Created**:
- should {test 1} - PASS
- should {test 2} - PASS

**Next Steps**:
1. Review generated tests
2. Add to version control
3. Ensure CI includes new tests
```

---

## Converting from Quick-Test

When user says "make this a permanent test" after quick-test:

### 1. Read Quick-Test Script

```bash
cat /tmp/playwright-quick-*.js | tail -1
```

### 2. Extract Test Logic

From the quick-test script, identify:
- `page.goto()` calls → URL paths
- `page.click()`, `page.fill()` → Actions
- Assertions or checks → Test expectations
- Screenshots → Visual checkpoints

### 3. Refactor into Proper Test

**Quick-test style (ad-hoc)**:
```javascript
await page.goto('http://localhost:3000/login');
await page.fill('#email', 'test@example.com');
await page.fill('#password', 'password123');
await page.click('button[type="submit"]');
console.log('Logged in!');
```

**Production test style**:
```typescript
test('should login successfully', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('test@example.com', 'password123');
  await expect(page).toHaveURL(/.*dashboard/);
});
```

---

## Locator Best Practices

Prefer these locator strategies (in order):

1. **data-testid** (most stable)
   ```typescript
   page.locator('[data-testid="submit-button"]')
   ```

2. **role + name** (accessible)
   ```typescript
   page.getByRole('button', { name: 'Submit' })
   ```

3. **text content** (readable)
   ```typescript
   page.getByText('Welcome back')
   ```

4. **CSS with :visible** (fallback)
   ```typescript
   page.locator('button.submit:visible')
   ```

**Avoid**:
- `nth(0)` without `:visible`
- Overly complex CSS selectors
- XPath (unless necessary)

---

## Helpers to Use

Import from `${CLAUDE_PLUGIN_ROOT}/lib/helpers.js`:

```typescript
import { getTimeout, safeClick, safeType } from '../helpers';

// Dynamic timeout
await expect(element).toBeVisible({ timeout: getTimeout() });

// Retry click
await safeClick(page, 'button.submit', { retries: 3 });

// Safe type with clear
await safeType(page, '#input', 'value');
```

---

## Common Patterns

### Form Submission Test

```typescript
test('should submit contact form', async ({ page }) => {
  const contactPage = new ContactPage(page);
  await contactPage.goto();

  await contactPage.fillForm({
    name: 'Test User',
    email: 'test@example.com',
    message: 'Test message'
  });

  await contactPage.submit();

  await expect(contactPage.successMessage).toBeVisible();
});
```

### Navigation Test

```typescript
test('should navigate to profile from dashboard', async ({ page }) => {
  const dashboardPage = new DashboardPage(page);
  await dashboardPage.goto();

  await dashboardPage.goToProfile();

  await expect(page).toHaveURL(/.*profile/);
});
```

### Data Display Test

```typescript
test('should display user list', async ({ page }) => {
  const usersPage = new UsersPage(page);
  await usersPage.goto();

  const users = await usersPage.getUserList();

  expect(users.length).toBeGreaterThan(0);
  await expect(usersPage.firstUserRow).toContainText('@');
});
```

---

## What This Skill Does NOT Do

- Fetch tickets from Linear (use `/test-ticket` for that)
- Auto-heal failing tests (that's the test-healer agent)
- Report to Exolar (that's automatic via hooks)

This skill is for **creating production test files** only.

---

## Troubleshooting

### "Page Object already exists"

Use the existing one instead of creating a duplicate.

### "Test directory doesn't exist"

Create it:
```bash
mkdir -p automation/playwright/tests/{feature}
```

### "Tests fail immediately"

Check:
1. Is dev server running?
2. Are selectors correct?
3. Is auth state valid?
